-- ============================================================
-- Pagina's delen: de vrijgegeven versie (stap 1C-2,
-- docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §7).
--
-- Delen is vrijgeven: de klant ziet van een pagina de versie die gedeeld is,
-- niet wat er nu staat. Wijzig je de pagina daarna, dan ziet de klant dat pas
-- na "Bijwerken bij klant" (stap 1C-3), en dat komt in het logboek.
--
--   1. drive_shares.document_version_id: de versie die de klant ziet.
--   2. drive_shares_page_version() vervangt drive_shares_no_pages_yet()
--      (20261127130000). Een deling van een pagina draagt een vrijgegeven
--      versie (reden 'vrijgave') van precies die pagina en organisatie. Iets
--      anders dan een pagina draagt geen versie, en een pagina in de
--      prullenbak deel je niet.
--   3. drive_share_items() geeft bij een pagina de titel en de datum van die
--      versie, nooit van de pagina zoals ze nu is. Ligt de pagina in de
--      prullenbak, of ontbreekt de versie, dan niets.
--   4. Het logboek: een andere versie bij een deling is een regel, met de
--      oude en de nieuwe versie.
--
-- In dezelfde stap lezen het portaal (client-portal) en de geheime link
-- (file-share-public) bij een pagina die versie, via _shared/sharedPage.ts.
-- Daarom kan delen pas nu: die twee toonden bij een document zonder bestand
-- de levende tekst (content). Was de database eerder opengegaan, dan had de
-- klant de pagina gezien zoals ze op dat moment was.
--
-- Mag opnieuw draaien.
-- ============================================================

-- ── 1. De versie bij een deling ─────────────────────────────────────────────
-- Gaat de versie weg (alleen als de pagina definitief verwijderd wordt), dan
-- gaat de deling mee: er is niets meer om te tonen. Met "set null" zou de
-- controle hieronder die verwijdering weigeren, en bleef de prullenbak hangen.
alter table public.drive_shares
  add column if not exists document_version_id uuid
  references public.document_versions(id) on delete cascade;

-- Voor de cascade hierboven: anders zoekt elke verwijderde versie de hele tabel door.
create index if not exists idx_drive_shares_document_version
  on public.drive_shares (document_version_id)
  where document_version_id is not null;

-- ── 2. Een pagina alleen met een vrijgegeven versie ─────────────────────────

drop trigger if exists drive_shares_no_pages_yet on public.drive_shares;
drop function if exists public.drive_shares_no_pages_yet();

create or replace function public.drive_shares_page_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_version public.document_versions;
begin
  if new.item_type = 'document' then
    select * into v_doc from public.documents d where d.id = new.item_id;
  end if;

  if v_doc.id is not null and v_doc.format = 'page' then
    if new.document_version_id is null then
      raise exception 'Een pagina deel je met een vrijgegeven versie.' using errcode = '22023';
    end if;
    select * into v_version from public.document_versions v where v.id = new.document_version_id;
    if v_version.id is null
       or v_version.document_id <> v_doc.id
       or v_version.organization_id <> v_doc.organization_id
       or v_doc.organization_id <> new.organization_id then
      raise exception 'Deze versie hoort niet bij deze pagina.' using errcode = '22023';
    end if;
    -- Een tussenversie (een bewerksessie, iets voor Gerrie) is nooit bedoeld
    -- om te laten zien: alleen wat iemand bewust vrijgaf.
    if v_version.reason <> 'vrijgave' then
      raise exception 'Alleen een vrijgegeven versie kun je delen.' using errcode = '22023';
    end if;
    if v_doc.archived_at is not null then
      raise exception 'Een pagina in de prullenbak kun je niet delen.' using errcode = '22023';
    end if;
  elsif new.document_version_id is not null then
    raise exception 'Alleen een pagina deel je met een versie.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.drive_shares_page_version() from public, anon, authenticated;

drop trigger if exists drive_shares_page_version on public.drive_shares;
create trigger drive_shares_page_version
  before insert or update of organization_id, item_type, item_id, document_version_id on public.drive_shares
  for each row execute function public.drive_shares_page_version();

-- ── 3. Wat de klant in een deling ziet ──────────────────────────────────────
-- Zelfde naam, argumenten en uitvoer als in 20261127120000, zodat het portaal
-- en de deellink geen nieuwe aanroep nodig hebben. Alleen de tak voor een
-- document is anders.

create or replace function public.drive_share_items(p_share_id uuid)
returns table (
  item_type text,
  item_id uuid,
  name text,
  mime_type text,
  size_bytes bigint,
  storage_key text,
  modified timestamptz,
  path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_share public.drive_shares;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found then
    return;
  end if;

  if v_share.item_type = 'folder' then
    return query
    select t.item_type, t.item_id, t.name, t.mime_type, t.size_bytes, t.storage_key, t.modified, t.path
    from public.drive_folder_tree_items(v_share.organization_id, v_share.item_id) t
    where exists (
      select 1 from public.drive_share_entries e
      where e.share_id = v_share.id and e.item_type = t.item_type and e.item_id = t.item_id
    );

  elsif v_share.item_type = 'attachment' then
    return query
    select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes::bigint, a.storage_key, a.created_at, ''::text
    from public.attachments a
    where a.id = v_share.item_id and a.organization_id = v_share.organization_id;

  elsif v_share.item_type = 'note' then
    return query
    select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
           coalesce(n.updated_at, n.created_at), ''::text
    from public.notes n
    where n.id = v_share.item_id and n.organization_id = v_share.organization_id;

  else
    -- Een pagina: de titel en de datum van de gedeelde versie. De titel van nu
    -- kan een werktitel zijn die de klant nog niet hoort te zien.
    return query
    select 'document'::text, d.id,
           case when d.format = 'page' then v.title else d.title end,
           case when d.format = 'page' then 'text/html' else coalesce(d.mime_type, 'text/html') end,
           case when d.format = 'page' then 0::bigint else coalesce(d.size_bytes, 0)::bigint end,
           case when d.format = 'page' then null::text else d.storage_key end,
           case when d.format = 'page' then v.created_at else coalesce(d.updated_at, d.created_at) end,
           ''::text
    from public.documents d
    left join public.document_versions v
      on v.id = v_share.document_version_id
     and v.document_id = d.id
     and v.organization_id = d.organization_id
    where d.id = v_share.item_id and d.organization_id = v_share.organization_id
      and (d.format <> 'page' or (v.id is not null and d.archived_at is null));
  end if;
end;
$$;

revoke all on function public.drive_share_items(uuid) from public, anon, authenticated;
grant execute on function public.drive_share_items(uuid) to service_role;

-- ── 4. Het logboek ──────────────────────────────────────────────────────────
-- "Bijwerken bij klant" verandert alleen de versie. De trigger uit
-- 20260823000000 kende die kolom niet, en schreef dan geen regel; nu wel, met
-- de oude en de nieuwe versie (audit_field_spec: "r"). Zo is na te gaan welke
-- versie de klant vanaf welke dag zag.

drop trigger if exists drive_shares_audit on public.drive_shares;
create trigger drive_shares_audit
  after insert or delete or update of item_type, item_id, item_name, client_id, project_id,
    recipient_kind, client_contact_id, member_user_id, recipient_email, recipient_name,
    can_download, message, expires_at, revoked_at, token_hash, document_version_id
  on public.drive_shares
  for each row execute function public.audit_row_change('drive_share', 'item_name');

-- De definitie uit 20261127130000, met bij drive_shares document_version_id erbij.
create or replace function public.audit_field_spec(p_table text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select (case p_table
    when 'tasks' then '{"title":"v","status":"v","priority":"v","tags":"v","start_date":"v","end_date":"v","planned_date":"v","planned_end_date":"v","planned_start_minute":"v","estimated_minutes":"v","project_id":"r","client_id":"r","ticket_id":"r","subtasks":"s","comments":"n","planned_order":"i"}'
    when 'projects' then '{"name":"v","client_id":"r","archived":"v","start_date":"v","end_date":"v","contract_id":"r","hourly_rate_cents":"v","billing_type":"v","budgeted_minutes":"v","color":"i"}'
    when 'clients' then '{"name":"v","client_code":"v","status":"v","client_kind":"v","follow_up":"v","value_eur":"v","tags":"v","country":"v","e_invoicing_enabled":"v","e_invoice_channel":"v","color":"i"}'
    when 'client_contacts' then '{"name":"v","role":"v","is_active":"v","gives_portal_access":"v","origin":"v","client_id":"r"}'
    when 'client_calls' then '{"subject":"v","direction":"v","outcome":"v","started_at":"v","duration_seconds":"v","client_id":"r","contact_id":"r","project_id":"r","ticket_id":"r","dedup_key":"i","provider_call_id":"i","metadata":"i"}'
    when 'tickets' then '{"title":"v","status":"v","priority":"v","client_id":"r","converted_to_project_id":"r","resolved_at":"v"}'
    when 'ticket_notes' then '{"is_internal":"v","author_type":"v","ticket_id":"r"}'
    when 'notes' then '{"title":"v","note_type":"v","tags":"v","client_id":"r","project_id":"r","folder_id":"r"}'
    when 'documents' then '{"title":"v","document_type":"v","client_id":"r","project_id":"r","folder_id":"r","mime_type":"v","size_bytes":"v","storage_key":"i","edit_version":"i","last_edited_by":"i","format":"v","body":"c","parent_id":"r","archived_at":"v","archived_by":"i","position":"i","icon":"i","cover":"i","full_width":"i","excerpt":"i"}'
    when 'attachments' then '{"name":"v","mime_type":"v","size_bytes":"v","parent_task_id":"r","storage_key":"i","public_url":"i","edit_version":"i","last_edited_by":"i","locked_by":"i","locked_at":"i"}'
    when 'content_folders' then '{"name":"v","parent_id":"r","client_id":"r","project_id":"r","position":"i"}'
    when 'note_handwriting' then '{"page_count":"v","stroke_count":"i","pages":"i"}'
    when 'drive_shares' then '{"item_type":"v","item_name":"v","recipient_kind":"v","can_download":"v","expires_at":"v","revoked_at":"v","notified_at":"v","client_id":"r","project_id":"r","member_user_id":"r","client_contact_id":"r","document_version_id":"r","token_hash":"i","view_count":"i","last_viewed_at":"i"}'
    when 'file_transfers' then '{"subject":"v","status":"v","can_download":"v","expires_at":"v","sent_at":"v","revoked_at":"v","purged_at":"v","item_count":"v","total_bytes":"v","client_id":"r","project_id":"r","ticket_id":"r"}'
    when 'galleries' then '{"title":"v","status":"v","published_at":"v","allow_downloads":"v","download_quality":"v","share_enabled":"v","expires_at":"v","format":"v","hero_template":"v","project_id":"r","share_token":"i","share_pin_failed_count":"i","share_pin_locked_until":"i","cover_item_id":"i","cover_preview_key":"i","cover_thumb_key":"i","cover_bytes":"i","cover_focus_x":"i","cover_focus_y":"i"}'
    when 'time_entries' then '{"entry_date":"v","minutes":"v","billable":"v","entry_type":"v","indirect_category":"v","source":"v","started_at":"v","ended_at":"v","hourly_rate_cents":"v","user_id":"r","project_id":"r","client_id":"r","task_id":"r","calendar_event_link_id":"i"}'
    when 'project_members' then '{"user_id":"r","project_id":"r"}'
    when 'task_assignees' then '{"user_id":"r","task_id":"r"}'
    when 'project_templates' then '{"name":"v"}'
    when 'project_template_tasks' then '{"title":"v","status":"v","priority":"v","position":"i"}'
    when 'saved_reports' then '{"name":"v","is_pinned":"v","position":"i"}'
    when 'invoices' then '{"number":"v","status":"v","date":"v","due_date":"v","currency":"v","subtotal_amount":"v","vat_amount":"v","total_amount":"v","lines":"n","sent_at":"v","paid_at":"v","refunded_amount":"v","charged_back_amount":"v","reminder_level":"v","reminders_paused":"v","locked_at":"v","client_id":"r","project_id":"r","quote_id":"r","contract_id":"r","journal_entry_id":"r","last_email_delivery_status":"v","last_email_opened_at":"v","last_email_clicked_at":"v","last_email_failed_at":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","latest_version_id":"i","sent_version_id":"i","paid_version_id":"i","source_quote_version_id":"i","last_pdf_file_name":"i","last_pdf_mime_type":"i","last_pdf_size_bytes":"i","last_pdf_sha256":"i"}'
    when 'quotes' then '{"number":"v","status":"v","date":"v","valid_until":"v","lines":"n","sent_at":"v","accepted_at":"v","internal_approval_status":"v","internal_approved_at":"v","internal_rejected_at":"v","client_decision_at":"v","client_id":"r","project_id":"r","internal_approval_requested_by":"r","internal_approved_by":"r","internal_rejected_by":"r","last_email_delivery_status":"v","last_email_opened_at":"v","last_email_clicked_at":"v","last_email_failed_at":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","latest_version_id":"i","internal_approved_version_id":"i","sent_version_id":"i","accepted_version_id":"i","accepted_sent_version_id":"i","last_pdf_file_name":"i","last_pdf_mime_type":"i","last_pdf_size_bytes":"i","last_pdf_sha256":"i"}'
    when 'contracts' then '{"number":"v","title":"v","status":"v","date":"v","valid_until":"v","amount_cents":"v","currency":"v","sent_at":"v","signed_at":"v","voided_at":"v","internal_approval_status":"v","editor_mode":"v","client_id":"r","quote_id":"r","template_id":"r","supersedes_contract_id":"r","voided_by":"r","last_email_delivery_status":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","signed_document_sha256":"i","signed_storage_provider":"i","signed_storage_key":"i","signed_pdf_file_name":"i","signed_pdf_size_bytes":"i","signed_pdf_data_base64":"i","body_storage_key":"i","body_mime_type":"i","body_size_bytes":"i","edit_version":"i","last_edited_by":"i"}'
    when 'contract_templates' then '{"name":"v","is_active":"v"}'
    when 'contract_projects' then '{"contract_id":"r","project_id":"r"}'
    when 'purchase_invoices' then '{"internal_number":"v","supplier_invoice_number":"v","date":"v","due_date":"v","subtotal_cents":"v","vat_cents":"v","total_cents":"v","currency":"v","status":"v","payment_status":"v","paid_at":"v","source":"v","lines":"n","supplier_id":"r","project_id":"r","journal_entry_id":"r","extraction_meta":"i"}'
    when 'suppliers' then '{"name":"v","supplier_code":"v","status":"v","default_vat_code":"v","inbox_unverified":"v","default_expense_account_id":"r"}'
    when 'journal_entries' then '{"entry_number":"v","date":"v","status":"v","source_type":"v","posted_at":"v","reverses_entry_id":"r","reversed_by_entry_id":"r"}'
    when 'ledger_accounts' then '{"code":"v","name":"v","type":"v","subtype":"v","default_vat_code":"v","is_active":"v","report_group":"v","is_restricted_reserve":"v"}'
    when 'bank_accounts' then '{"name":"v","currency":"v","is_active":"v","source":"v","provider":"v","ledger_account_id":"r","last_synced_at":"i","last_imported_at":"i","last_sync_attempt_at":"i","last_sync_error":"i","external_account_id":"i"}'
    when 'bank_rules' then '{"name":"v","priority":"v","is_active":"v","auto_book":"v","match_direction":"v","target_vat_code":"v","target_account_id":"r"}'
    when 'vat_returns' then '{"status":"v","period_type":"v","year":"v","period_index":"v","period_start":"v","period_end":"v","finalized_at":"v","filed_at":"v","journal_entry_id":"r","paid_bank_transaction_id":"r","supplements_return_id":"r"}'
    when 'fixed_assets' then '{"name":"v","asset_number":"v","category":"v","acquisition_date":"v","acquisition_cost_cents":"v","residual_value_cents":"v","useful_life_months":"v","method":"v","start_date":"v","status":"v","disposal_date":"v","disposal_proceeds_cents":"v"}'
    when 'prepaid_expenses' then '{"description":"c","amount_cents":"v","payment_date":"v","start_date":"v","months":"v","start_mode":"v","status":"v","end_date":"v","end_amount_cents":"v","end_refund_cents":"v","notes":"c","prepaid_account_id":"c","expense_account_id":"c","counter_account_id":"c","end_refund_account_id":"c","source_purchase_invoice_id":"c","start_journal_entry_id":"i","end_journal_entry_id":"i"}'
    when 'fiscal_years' then '{"label":"v","period_start":"v","period_end":"v","status":"v","result_cents":"v","closed_at":"v","reopened_at":"v"}'
    when 'corporate_tax_returns' then '{"year":"v","status":"v","taxable_amount_cents":"v","tax_cents":"v","balance_due_cents":"v","finalized_at":"v","computation":"i"}'
    when 'annual_accounts' then '{"status":"v","prepared_on":"v","prepare_deadline":"v","adoption_date":"v","adoption_method":"v","filing_date":"v","size_class":"v","size_class_override":"v","reversed_at":"v","snapshot":"i","snapshot_hash":"i","snapshot_version":"i","size_basis":"i"}'
    when 'organization_members' then '{"role":"v","status":"v","module_access":"v","joined_at":"v","user_id":"r","invited_by":"r"}'
    when 'organization_invitations' then '{"role":"v","status":"v","expires_at":"v","module_access":"v","consumes_license":"v","accepted_by":"r","accepted_at":"v","invited_by":"r"}'
    when 'organizations' then '{"name":"v","licensed_seats":"v","license_status":"v","onboarding_completed_at":"v","parent_organization_id":"r"}'
    when 'company_settings' then '{"legal_form":"v","kor_enabled":"v","vat_return_period":"v","bookkeeping_start_date":"v","fiscal_year_start_month":"v","invoice_send_method":"v","default_hourly_rate_cents":"v","invoice_template_kind":"v","brand_client_theme":"v","brand_hide_powered_by":"v"}'
    when 'calendar_events' then '{"etag":"i","sync_rev":"i","sequence":"i","icalendar_raw":"i","organizer_token":"i"}'
    when 'calendar_sources' then '{"change_seq":"i","feed_etag":"i","feed_content_hash":"i","feed_last_synced_at":"i","feed_last_error":"i","feed_url":"i","conference_types":"i"}'
    when 'calendar_connections' then '{"status":"v","last_error":"i"}'
    when 'email_campaigns' then '{"name":"v","subject":"v","status":"v","scheduled_at":"v","started_at":"v","sent_at":"v","accent_color":"i"}'
    when 'email_flows' then '{"name":"v","status":"v","stop_condition":"v"}'
    when 'email_templates' then '{"template_key":"v","enabled":"v"}'
    when 'client_field_definitions' then '{"label":"v","field_key":"v","field_type":"v","is_archived":"v","show_in_list":"v","position":"i"}'
    else '{}'
  end)::jsonb;
$$;

revoke all on function public.audit_field_spec(text) from public, anon, authenticated;
grant execute on function public.audit_field_spec(text) to service_role;
