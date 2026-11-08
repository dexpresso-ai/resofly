-- ============================================================
-- ResoFly — Logboek: wie wat wanneer en waar heeft aangepast
-- Date: 2026-11-08
--
-- Het auditlog (audit_logs) bestond al: triggers op ruim zestig tabellen en
-- losse regels voor wat er met facturen, offertes en betalingen gebeurt. Wat
-- erin stond, was te mager voor een logboek dat iemand kan lezen:
--
--   - alleen WELKE kolommen veranderden ("status, due_date"), niet van wat
--     naar wat. "Bijgewerkt · Factuur 2026-014" zei dus niet dat hij van
--     concept naar verstuurd ging;
--   - geen naam bij wie het deed: een teamlid dat vertrok, werd een leeg vak
--     (actor_user_id gaat op leeg als het account verdwijnt);
--   - niet bij welke klant of welk project iets hoorde, dus niet te filteren
--     op "alles rond klant X";
--   - geen verschil tussen een teamlid in de app, Gerrie of de API namens dat
--     teamlid, en de server zelf (webhooks, synchronisatie);
--   - online bewerken in Office (de server schrijft namens de gebruiker)
--     stond er als "systeem" in, één regel per automatische opslag; elke
--     toetsaanslag in een notitie gaf een eigen regel;
--   - een bestand in de teamchat stond er met zijn naam in, voor iedereen met
--     Inhoud — ook uit een privégesprek.
--
-- Nu (Instellingen → Logboek en het blok op het dashboard lezen dit):
--
--   1. Nieuwe kolommen: actor_label (het e-mailadres op dat moment), via
--      ('app', 'koppeling' = Gerrie, een agent, MCP of de API namens een
--      teamlid, 'systeem' = zonder gebruiker), client_id en project_id (waar),
--      event_count en last_at (een samengevoegde reeks).
--   2. audit_row_change schrijft per veld oud → nieuw in metadata.changes —
--      maar alleen voor velden op een vaste lijst per tabel (status, datums,
--      bedragen, verwijzingen). Van al het andere (teksten, notities,
--      e-mailadressen, telefoonnummers, adressen, IBAN) alleen DAT het
--      veranderde. Tokens, hashes, opslagsleutels en PDF-inhoud komen er nooit
--      in, ook niet als "gewijzigd": die tellen niet als wijziging.
--   3. Dezelfde persoon die binnen 10 minuten hetzelfde ding weer wijzigt
--      (typen, automatisch opslaan, slepen) geeft één regel met een teller en
--      het verschil van begin tot eind, hooguit een uur per regel. NIET bij
--      Financiën, de agenda, het team en het beheer: daar telt elke stap.
--   4. Een trigger vóór het wegschrijven vult in wat een functie of edge
--      function niet meegaf: de naam, via en de klant/het project (opgezocht
--      bij het ding zelf). Zo hebben ook "factuur verstuurd", "betaald" en
--      "offerte geaccepteerd" hun klant.
--   5. Ruis eruit: synchronisatie (agenda, bank), sloten op bestanden, het
--      aantal keer bekeken. Een wijziging aan alléén zulke velden geeft geen
--      regel meer. Op staging (8 november) was bijna de helft van alle regels
--      "systeem wijzigde agendakoppeling": de foutmelding van de synchronisatie
--      die steeds wisselde. Een andere status telt nog wel.
--   6. Ook gelogd: galerijen, e-mailcampagnes en -stromen, de teksten van de
--      klantmails en de eigen klantvelden.
--   7. Wat er al stond, krijgt waar dat kan alsnog een naam, een via en een
--      klant/project. Bijlagen in de teamchat krijgen een neutrale naam.
--
-- Ongewijzigd: wie welke regel leest (de RLS uit 20261003060000, per module),
-- dat niemand een regel kan aanpassen of wissen, en dat een fout in het
-- logboek nooit de wijziging zelf tegenhoudt.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Kolommen ─────────────────────────────────────────────────────────────
alter table public.audit_logs
  add column if not exists actor_label text,
  add column if not exists via text not null default 'app',
  add column if not exists client_id uuid,
  add column if not exists project_id uuid,
  add column if not exists event_count integer not null default 1,
  add column if not exists last_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_via_check') then
    alter table public.audit_logs add constraint audit_logs_via_check check (via in ('app', 'koppeling', 'systeem'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_event_count_check') then
    alter table public.audit_logs add constraint audit_logs_event_count_check check (event_count >= 1);
  end if;
end $$;

comment on column public.audit_logs.actor_label is 'Het e-mailadres van wie het deed, op dat moment (blijft leesbaar als het account verdwijnt).';
comment on column public.audit_logs.via is 'app = een teamlid; koppeling = Gerrie, een agent, MCP of de API namens een teamlid; systeem = zonder gebruiker.';
comment on column public.audit_logs.client_id is 'De klant waar de regel bij hoort (geen foreign key: de regel blijft als de klant verdwijnt).';
comment on column public.audit_logs.project_id is 'Het project waar de regel bij hoort (geen foreign key).';
comment on column public.audit_logs.event_count is 'Aantal wijzigingen in deze regel: reeksen van dezelfde persoon binnen 10 minuten zijn samengevoegd.';
comment on column public.audit_logs.last_at is 'De laatste wijziging van een samengevoegde reeks (created_at is de eerste).';

-- De filters van het logboek: per persoon, per klant, per project, per soort.
create index if not exists idx_audit_logs_org_actor on public.audit_logs (organization_id, actor_user_id, created_at desc);
create index if not exists idx_audit_logs_org_client on public.audit_logs (organization_id, client_id, created_at desc) where client_id is not null;
create index if not exists idx_audit_logs_org_project on public.audit_logs (organization_id, project_id, created_at desc) where project_id is not null;
create index if not exists idx_audit_logs_org_type_created on public.audit_logs (organization_id, entity_type, created_at desc);

-- ── 2. Welke velden met hun waarde in het logboek mogen ────────────────────
--
-- Per tabel, per kolom:
--   'v'  de waarde (tekst ingekort tot 200 tekens)
--   'r'  een verwijzing (het id; de app zoekt de naam erbij, met de rechten
--        van wie kijkt — zo komt er geen klantnaam in een regel over een taak)
--   'n'  het aantal (een lijst: factuurregels, subtaken)
--   's'  afgevinkt/totaal (subtaken)
--   'i'  telt niet als wijziging (tokens, opslagsleutels, synchronisatie)
-- Een kolom die er niet staat: alleen DAT hij veranderde ('c'). updated_at
-- telt nergens. Een nieuwe kolom staat dus standaard dicht.
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
    when 'documents' then '{"title":"v","document_type":"v","client_id":"r","project_id":"r","folder_id":"r","mime_type":"v","size_bytes":"v","storage_key":"i","edit_version":"i","last_edited_by":"i"}'
    when 'attachments' then '{"name":"v","mime_type":"v","size_bytes":"v","parent_task_id":"r","storage_key":"i","public_url":"i","edit_version":"i","last_edited_by":"i","locked_by":"i","locked_at":"i"}'
    when 'content_folders' then '{"name":"v","parent_id":"r","client_id":"r","project_id":"r","position":"i"}'
    when 'note_handwriting' then '{"page_count":"v","stroke_count":"i","pages":"i"}'
    when 'drive_shares' then '{"item_type":"v","item_name":"v","recipient_kind":"v","can_download":"v","expires_at":"v","revoked_at":"v","notified_at":"v","client_id":"r","project_id":"r","member_user_id":"r","client_contact_id":"r","token_hash":"i","view_count":"i","last_viewed_at":"i"}'
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
    when 'fiscal_years' then '{"label":"v","period_start":"v","period_end":"v","status":"v","result_cents":"v","closed_at":"v","reopened_at":"v"}'
    when 'corporate_tax_returns' then '{"year":"v","status":"v","taxable_amount_cents":"v","tax_cents":"v","balance_due_cents":"v","finalized_at":"v","computation":"i"}'
    when 'annual_accounts' then '{"status":"v","prepared_on":"v","prepare_deadline":"v","adoption_date":"v","adoption_method":"v","filing_date":"v","size_class":"v","size_class_override":"v","reversed_at":"v","snapshot":"i","snapshot_hash":"i","snapshot_version":"i","size_basis":"i"}'
    when 'organization_members' then '{"role":"v","status":"v","module_access":"v","joined_at":"v","user_id":"r","invited_by":"r"}'
    when 'organization_invitations' then '{"role":"v","status":"v","expires_at":"v","module_access":"v","consumes_license":"v","accepted_by":"r","accepted_at":"v","invited_by":"r"}'
    when 'organizations' then '{"name":"v","licensed_seats":"v","license_status":"v","onboarding_completed_at":"v","parent_organization_id":"r"}'
    when 'company_settings' then '{"legal_form":"v","kor_enabled":"v","vat_return_period":"v","bookkeeping_start_date":"v","fiscal_year_start_month":"v","invoice_send_method":"v","default_hourly_rate_cents":"v","invoice_template_kind":"v","brand_client_theme":"v","brand_hide_powered_by":"v"}'
    when 'calendar_events' then '{"etag":"i","sync_rev":"i","sequence":"i","icalendar_raw":"i","organizer_token":"i"}'
    when 'calendar_sources' then '{"change_seq":"i","feed_etag":"i","feed_content_hash":"i","feed_last_synced_at":"i","feed_last_error":"i","feed_url":"i"}'
    when 'calendar_connections' then '{"status":"v","last_error":"i"}'
    when 'email_campaigns' then '{"name":"v","subject":"v","status":"v","scheduled_at":"v","started_at":"v","sent_at":"v","accent_color":"i"}'
    when 'email_flows' then '{"name":"v","status":"v","stop_condition":"v"}'
    when 'email_templates' then '{"template_key":"v","enabled":"v"}'
    when 'client_field_definitions' then '{"label":"v","field_key":"v","field_type":"v","is_archived":"v","show_in_list":"v","position":"i"}'
    else '{}'
  end)::jsonb;
$$;

-- Lange tekst inkorten; lege tekst telt als leeg.
create or replace function public.audit_clip(p jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p is null or p = 'null'::jsonb then null
    when jsonb_typeof(p) = 'string' and btrim(p #>> '{}') = '' then null
    when jsonb_typeof(p) = 'string' and length(p #>> '{}') > 200 then to_jsonb(left(p #>> '{}', 199) || '…')
    else p
  end;
$$;

-- Hoeveel elementen een lijst heeft; bij 's' afgevinkt/totaal ("2/5").
create or replace function public.audit_count(p jsonb, p_done boolean default false)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'array' then to_jsonb(0)
    when p_done then to_jsonb(
      (select count(*) from jsonb_array_elements(p) e where jsonb_typeof(e) = 'object' and (e ->> 'done') = 'true')::text
      || '/' || jsonb_array_length(p)::text)
    else to_jsonb(jsonb_array_length(p))
  end;
$$;

-- Het verschil tussen twee versies van een rij, volgens audit_field_spec.
-- Bij een nieuwe of verwijderde rij (een van beide leeg): een momentopname
-- van de waarden en verwijzingen die er zijn. `changed` = de kolommen die
-- meetellen (zonder de 'i'-kolommen en updated_at).
create or replace function public.audit_row_diff(p_table text, p_old jsonb, p_new jsonb, out changes jsonb, out changed text[])
language plpgsql
stable
set search_path = public
as $$
declare
  v_spec jsonb := public.audit_field_spec(p_table);
  v_snap boolean := p_old is null or p_new is null;
  v_key text;
  v_mode text;
  o jsonb;
  n jsonb;
begin
  changes := '{}'::jsonb;
  changed := array[]::text[];
  for v_key in
    select k from jsonb_object_keys(coalesce(p_new, '{}'::jsonb) || coalesce(p_old, '{}'::jsonb)) as k order by k
  loop
    continue when v_key in ('updated_at', 'id', 'organization_id', 'created_at', 'created_by');
    v_mode := coalesce(v_spec ->> v_key, 'c');
    continue when v_mode = 'i';
    o := case when p_old is null then null else p_old -> v_key end;
    n := case when p_new is null then null else p_new -> v_key end;
    if v_snap then
      -- Momentopname: alleen wat een waarde of verwijzing heeft.
      continue when v_mode not in ('v', 'r', 'n', 's');
      continue when public.audit_clip(coalesce(n, o)) is null;
      -- Standaardwaarden (nee, 0, een lege lijst) zeggen niets over wat er gemaakt is.
      continue when coalesce(n, o) in ('[]'::jsonb, '{}'::jsonb, 'false'::jsonb, '0'::jsonb, '"0/0"'::jsonb);
      continue when v_mode in ('n', 's') and public.audit_count(coalesce(n, o), v_mode = 's') in ('0'::jsonb, '"0/0"'::jsonb);
    else
      continue when o is not distinct from n;
      changed := changed || v_key;
    end if;
    if v_mode = 'v' or v_mode = 'r' then
      changes := changes || jsonb_build_object(v_key, jsonb_build_object('old', public.audit_clip(o), 'new', public.audit_clip(n)));
    elsif v_mode = 'n' then
      changes := changes || jsonb_build_object(v_key, jsonb_build_object('old', case when p_old is null then null else public.audit_count(o) end,
                                                                          'new', case when p_new is null then null else public.audit_count(n) end, 'count', true));
    elsif v_mode = 's' then
      changes := changes || jsonb_build_object(v_key, jsonb_build_object('old', case when p_old is null then null else public.audit_count(o, true) end,
                                                                          'new', case when p_new is null then null else public.audit_count(n, true) end, 'count', true));
    else
      changes := changes || jsonb_build_object(v_key, jsonb_build_object('changed', true));
    end if;
  end loop;
end;
$$;

-- Twee reeksen wijzigingen samenvoegen: per veld het oude van de eerste en
-- het nieuwe van de laatste. Een veld dat weer terug is op de oude waarde
-- valt eruit; "alleen gewijzigd" blijft "gewijzigd".
create or replace function public.audit_merge_changes(p_a jsonb, p_b jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_key text;
  v_val jsonb;
  v_cur jsonb;
  v_out jsonb := coalesce(p_a, '{}'::jsonb);
begin
  for v_key, v_val in select key, value from jsonb_each(coalesce(p_b, '{}'::jsonb)) loop
    v_cur := v_out -> v_key;
    if v_cur is null or jsonb_typeof(v_cur) <> 'object' or jsonb_typeof(v_val) <> 'object' then
      v_out := v_out || jsonb_build_object(v_key, v_val);
    elsif (v_cur ? 'changed' and not v_cur ? 'old') or (v_val ? 'changed' and not v_val ? 'old') then
      v_out := v_out || jsonb_build_object(v_key, jsonb_build_object('changed', true));
    else
      v_cur := jsonb_set(v_cur, '{new}', coalesce(v_val -> 'new', 'null'::jsonb));
      if (v_cur -> 'old') is not distinct from (v_cur -> 'new') then
        v_out := v_out - v_key;
      else
        v_out := v_out || jsonb_build_object(v_key, v_cur);
      end if;
    end if;
  end loop;
  return v_out;
end;
$$;

-- Hoe kwam de wijziging binnen?
--   systeem    zonder gebruiker (webhook, synchronisatie, een taak op de server)
--   koppeling  als teamlid, maar via de server: Gerrie, een agent, MCP of de
--              API. action_member_write, action_member_call en api_rest_write
--              wisselen binnen de transactie naar het teamlid met zelfgemaakte
--              claims (sub, role, aud); een echte sessie heeft altijd een
--              vervaltijd (exp).
--   app        een teamlid in de app, of de server namens hem
create or replace function public.audit_via(p_actor uuid)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_claims jsonb;
begin
  if p_actor is null then return 'systeem'; end if;
  if auth.uid() is null then return 'app'; end if;
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if v_claims is not null and v_claims ? 'sub' and not v_claims ? 'exp' then return 'koppeling'; end if;
  return 'app';
end;
$$;

-- De klant en het project van een ding in het logboek, opgezocht bij het ding
-- zelf (zolang het er is). Voor regels die een functie of edge function
-- wegschrijft zonder die context: factuur verstuurd, betaald, geaccepteerd.
create or replace function public.audit_context(p_entity_type text, p_entity_id uuid, out client_id uuid, out project_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_type text;
  v_id uuid;
begin
  if p_entity_id is null then return; end if;
  case p_entity_type
    when 'client' then client_id := p_entity_id;
    when 'project' then project_id := p_entity_id;
    when 'task' then select t.client_id, t.project_id into client_id, project_id from public.tasks t where t.id = p_entity_id;
    when 'ticket' then select t.client_id into client_id from public.tickets t where t.id = p_entity_id;
    when 'ticket_note' then
      select t.client_id into client_id from public.ticket_notes n join public.tickets t on t.id = n.ticket_id where n.id = p_entity_id;
    when 'invoice' then select i.client_id, i.project_id into client_id, project_id from public.invoices i where i.id = p_entity_id;
    when 'quote' then select q.client_id, q.project_id into client_id, project_id from public.quotes q where q.id = p_entity_id;
    when 'contract' then select c.client_id into client_id from public.contracts c where c.id = p_entity_id;
    when 'contract_note' then
      select c.client_id into client_id from public.contract_internal_notes n join public.contracts c on c.id = n.contract_id where n.id = p_entity_id;
    when 'contract_project' then
      select cp.project_id, c.client_id into project_id, client_id
        from public.contract_projects cp join public.contracts c on c.id = cp.contract_id where cp.id = p_entity_id;
    when 'credit_note' then
      select i.client_id, i.project_id into client_id, project_id
        from public.credit_notes cn join public.invoices i on i.id = cn.invoice_id where cn.id = p_entity_id;
    when 'note' then select n.client_id, n.project_id into client_id, project_id from public.notes n where n.id = p_entity_id;
    when 'document' then select d.client_id, d.project_id into client_id, project_id from public.documents d where d.id = p_entity_id;
    when 'content_folder' then select f.client_id, f.project_id into client_id, project_id from public.content_folders f where f.id = p_entity_id;
    when 'note_handwriting' then
      select n.client_id, n.project_id into client_id, project_id from public.note_handwriting h join public.notes n on n.id = h.note_id where h.id = p_entity_id;
    when 'time_entry' then select t.client_id, t.project_id into client_id, project_id from public.time_entries t where t.id = p_entity_id;
    when 'client_contact' then select c.client_id into client_id from public.client_contacts c where c.id = p_entity_id;
    when 'client_call' then select c.client_id, c.project_id into client_id, project_id from public.client_calls c where c.id = p_entity_id;
    when 'file_transfer' then select f.client_id, f.project_id into client_id, project_id from public.file_transfers f where f.id = p_entity_id;
    when 'drive_share' then select s.client_id, s.project_id into client_id, project_id from public.drive_shares s where s.id = p_entity_id;
    when 'project_member' then select m.project_id into project_id from public.project_members m where m.id = p_entity_id;
    when 'task_assignee' then
      select t.client_id, t.project_id into client_id, project_id from public.task_assignees a join public.tasks t on t.id = a.task_id where a.id = p_entity_id;
    when 'purchase_invoice' then select p.project_id into project_id from public.purchase_invoices p where p.id = p_entity_id;
    when 'gallery' then select g.project_id into project_id from public.galleries g where g.id = p_entity_id;
    when 'calendar_event_link' then select l.client_id, l.project_id into client_id, project_id from public.calendar_event_links l where l.id = p_entity_id;
    when 'attachment' then
      -- Een bijlage hangt aan iets anders; de context is die van dat ding.
      select a.entity_type, a.entity_id into v_type, v_id from public.attachments a where a.id = p_entity_id;
      if v_type is not null and v_type not in ('attachment', 'chat_message') then
        select c.client_id, c.project_id into client_id, project_id
          from public.audit_context(case v_type when 'folder' then 'content_folder' when 'subtask' then 'task' else v_type end, v_id) c;
      end if;
    else
      null;
  end case;
  if project_id is not null and client_id is null then
    select p.client_id into client_id from public.projects p where p.id = project_id;
  end if;
exception when others then
  client_id := null;
  project_id := null;
end;
$$;

-- ── 3. De trigger op de tabellen ────────────────────────────────────────────
--
-- Dezelfde regels als in 20260427000000 (welke actie, welk label, alleen een
-- echte wijziging), met daarbij de velden, de context, de samenvoeging en een
-- leesbaar label waar het oude label een id of een status was.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_type text := coalesce(nullif(TG_ARGV[0], ''), TG_TABLE_NAME);
  v_label_column text := coalesce(nullif(TG_ARGV[1], ''), 'name');
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  v_row jsonb;
  v_org uuid;
  v_entity_id uuid;
  v_label text;
  v_action text;
  v_diff record;
  v_changes jsonb;
  v_changed text[];
  v_actor uuid := auth.uid();
  v_via text;
  v_client uuid;
  v_project uuid;
  v_extra jsonb := '{}'::jsonb;
  v_prev_id uuid;
  v_prev_meta jsonb;
begin
  v_row := coalesce(v_new, v_old);
  if TG_TABLE_NAME = 'organizations' then
    v_org := nullif(v_row ->> 'id', '')::uuid;
  else
    v_org := coalesce(nullif(v_new ->> 'organization_id', '')::uuid, nullif(v_old ->> 'organization_id', '')::uuid);
  end if;
  if v_org is null then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  v_entity_id := nullif(v_row ->> 'id', '')::uuid;
  v_label := coalesce(
    nullif(v_new ->> v_label_column, ''), nullif(v_old ->> v_label_column, ''),
    nullif(v_new ->> 'title', ''), nullif(v_old ->> 'title', ''),
    nullif(v_new ->> 'number', ''), nullif(v_old ->> 'number', ''),
    nullif(v_new ->> 'email', ''), nullif(v_old ->> 'email', ''),
    v_entity_id::text
  );

  select d.changes, d.changed into v_diff from public.audit_row_diff(TG_TABLE_NAME, v_old, v_new) d;
  v_changes := v_diff.changes;
  v_changed := v_diff.changed;

  if TG_OP = 'INSERT' then
    v_action := 'created';
  elsif TG_OP = 'DELETE' then
    v_action := 'deleted';
  else
    -- Alleen updated_at of alleen ruis (synchronisatie, sloten, tokens): geen regel.
    if coalesce(array_length(v_changed, 1), 0) = 0 then
      return new;
    end if;
    v_action := 'updated';
  end if;

  if TG_TABLE_NAME = 'organization_invitations' then
    v_entity_type := 'invitation';
    if TG_OP = 'INSERT' then
      v_action := 'invited';
    elsif TG_OP = 'UPDATE' and v_old ->> 'status' is distinct from v_new ->> 'status' then
      if v_new ->> 'status' in ('accepted','revoked') then
        v_action := v_new ->> 'status';
      end if;
    end if;
  elsif TG_TABLE_NAME = 'organization_members' then
    v_entity_type := 'member';
    if TG_OP = 'UPDATE' and v_old ->> 'role' is distinct from v_new ->> 'role' then
      v_action := 'role_changed';
    elsif TG_OP = 'UPDATE' and v_new ->> 'status' = 'disabled' and v_old ->> 'status' is distinct from v_new ->> 'status' then
      v_action := 'disabled';
    elsif TG_OP = 'INSERT' and v_new ->> 'role' <> 'owner' then
      v_action := 'accepted';
    end if;
  end if;

  -- Een leesbaar label waar het oude een id, datum of status was.
  begin
    if TG_TABLE_NAME = 'project_members' then
      v_label := coalesce((select p.name from public.projects p where p.id = (v_row ->> 'project_id')::uuid), v_label);
    elsif TG_TABLE_NAME = 'task_assignees' then
      v_label := coalesce((select t.title from public.tasks t where t.id = (v_row ->> 'task_id')::uuid), v_label);
    elsif TG_TABLE_NAME = 'note_handwriting' then
      v_label := coalesce((select nullif(n.title, '') from public.notes n where n.id = (v_row ->> 'note_id')::uuid), 'Handgeschreven notitie');
    elsif TG_TABLE_NAME = 'contract_projects' then
      v_label := coalesce((select nullif(c.title, '') from public.contracts c where c.id = (v_row ->> 'contract_id')::uuid), v_label);
    elsif TG_TABLE_NAME = 'vat_returns' then
      v_label := case v_row ->> 'period_type'
        when 'quarter' then 'K' || (v_row ->> 'period_index') || ' ' || (v_row ->> 'year')
        when 'month' then to_char(make_date((v_row ->> 'year')::int, greatest(1, least(12, (v_row ->> 'period_index')::int)), 1), 'MM-YYYY')
        else coalesce(v_row ->> 'year', v_label)
      end;
    elsif TG_TABLE_NAME = 'fiscal_years' then
      v_label := coalesce(nullif(v_row ->> 'label', ''), v_label);
    elsif TG_TABLE_NAME = 'corporate_tax_returns' then
      v_label := coalesce('Vpb ' || (v_row ->> 'year'), v_label);
    elsif TG_TABLE_NAME = 'annual_accounts' then
      v_label := coalesce('Jaarrekening ' || (select f.label from public.fiscal_years f where f.id = (v_row ->> 'fiscal_year_id')::uuid), v_label);
    end if;
  exception when others then
    null;
  end;

  -- Waar: de klant en het project uit de rij zelf.
  begin
    if TG_TABLE_NAME = 'clients' then
      v_client := v_entity_id;
    elsif TG_TABLE_NAME = 'projects' then
      v_project := v_entity_id;
      v_client := nullif(v_row ->> 'client_id', '')::uuid;
    elsif TG_TABLE_NAME = 'attachments' then
      if v_row ->> 'entity_type' = 'client' then v_client := (v_row ->> 'entity_id')::uuid;
      elsif v_row ->> 'entity_type' = 'project' then v_project := (v_row ->> 'entity_id')::uuid;
      elsif v_row ->> 'entity_type' not in ('chat_message') then
        select c.client_id, c.project_id into v_client, v_project
          from public.audit_context(case v_row ->> 'entity_type' when 'folder' then 'content_folder' when 'subtask' then 'task' else v_row ->> 'entity_type' end,
                                    (v_row ->> 'entity_id')::uuid) c;
      end if;
    else
      if v_row ? 'client_id' then v_client := nullif(v_row ->> 'client_id', '')::uuid; end if;
      if v_row ? 'project_id' then v_project := nullif(v_row ->> 'project_id', '')::uuid; end if;
    end if;
  exception when others then
    null;
  end;

  -- Een bestand in de teamchat: geen naam en geen velden. De chat (ook een
  -- privégesprek) hoort niet in het logboek; dat er een bijlage bij kwam, mag.
  if TG_TABLE_NAME = 'attachments' and v_row ->> 'entity_type' = 'chat_message' then
    v_label := 'Bijlage in de teamchat';
    v_changes := '{}'::jsonb;
    v_client := null;
    v_project := null;
  end if;

  -- Online bewerken in Office: de server (media-api) schrijft namens wie er
  -- bewerkt, en zet last_edited_by. Dan staat die persoon erin, niet "systeem".
  if v_actor is null and TG_TABLE_NAME in ('documents', 'attachments', 'contracts')
     and v_new ? 'last_edited_at' and (v_new ->> 'last_edited_at') is distinct from (v_old ->> 'last_edited_at')
     and nullif(v_new ->> 'last_edited_by', '') is not null then
    v_actor := (v_new ->> 'last_edited_by')::uuid;
    v_extra := jsonb_build_object('online', true);
  end if;
  v_via := public.audit_via(v_actor);

  -- Reeksen samenvoegen: dezelfde persoon, hetzelfde ding, binnen 10 minuten
  -- na de vorige wijziging (en hooguit een uur na de eerste). Niet bij
  -- Financiën, de agenda, het team en het beheer: daar telt elke stap.
  if v_action = 'updated' and v_actor is not null and v_entity_id is not null
     and v_entity_type in ('task', 'project', 'client', 'client_contact', 'client_call', 'ticket', 'note', 'document',
                           'attachment', 'content_folder', 'note_handwriting', 'time_entry', 'saved_report',
                           'project_template', 'project_template_task', 'gallery', 'email_campaign', 'email_flow',
                           'client_field') then
    select a.id, a.metadata into v_prev_id, v_prev_meta
      from public.audit_logs a
     where a.organization_id = v_org and a.entity_type = v_entity_type and a.entity_id = v_entity_id
       and a.action = 'updated' and a.actor_user_id = v_actor and a.via = v_via
       and coalesce(a.last_at, a.created_at) > now() - interval '10 minutes'
       and a.created_at > now() - interval '60 minutes'
     order by a.created_at desc
     limit 1
     for update;
    if v_prev_id is not null then
      update public.audit_logs a
         set event_count = a.event_count + 1,
             last_at = now(),
             entity_label = v_label,
             metadata = a.metadata
               || jsonb_build_object(
                    'changed_columns', to_jsonb(array(
                      select distinct c from (
                        select jsonb_array_elements_text(coalesce(v_prev_meta -> 'changed_columns', '[]'::jsonb)) as c
                        union all select unnest(v_changed)
                      ) x order by c)),
                    'changes', public.audit_merge_changes(v_prev_meta -> 'changes', v_changes))
               || v_extra
       where a.id = v_prev_id;
      if TG_OP = 'DELETE' then return old; end if;
      return new;
    end if;
  end if;

  insert into public.audit_logs(organization_id, actor_user_id, via, action, entity_type, entity_id, entity_label, client_id, project_id, metadata)
  values (
    v_org,
    v_actor,
    v_via,
    v_action,
    v_entity_type,
    v_entity_id,
    left(v_label, 300),
    v_client,
    v_project,
    jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'changed_columns', to_jsonb(v_changed), 'changes', v_changes) || v_extra
  );

  if TG_OP = 'DELETE' then return old; end if;
  return new;
exception when others then
  raise warning 'audit logging failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ── 4. Vóór het wegschrijven: aanvullen wat er niet bij stond ───────────────
--
-- Voor elke regel, ook die van functies en edge functions (factuur verstuurd,
-- betaald, Mollie gekoppeld): de naam van wie het deed, hoe het binnenkwam en
-- bij welke klant/welk project het hoort. Een fout hier houdt de regel niet
-- tegen (en dus de wijziging niet).
create or replace function public.audit_logs_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_project uuid;
begin
  if new.via is null or new.via = 'app' then
    new.via := public.audit_via(new.actor_user_id);
  end if;
  new.last_at := coalesce(new.last_at, new.created_at, now());

  if new.actor_label is null and new.actor_user_id is not null then
    select m.email::text into new.actor_label
      from public.organization_members m
     where m.organization_id = new.organization_id and m.user_id = new.actor_user_id
     order by (m.status = 'active') desc
     limit 1;
    if new.actor_label is null then
      select u.email::text into new.actor_label from auth.users u where u.id = new.actor_user_id;
    end if;
  end if;

  if new.client_id is null and new.project_id is null and new.entity_id is not null then
    select c.client_id, c.project_id into v_client, v_project from public.audit_context(new.entity_type, new.entity_id) c;
    new.client_id := v_client;
    new.project_id := v_project;
  elsif new.client_id is null and new.project_id is not null then
    select p.client_id into new.client_id from public.projects p where p.id = new.project_id;
  end if;
  return new;
exception when others then
  raise warning 'audit_logs_fill: %', SQLERRM;
  return new;
end;
$$;

drop trigger if exists audit_logs_fill on public.audit_logs;
create trigger audit_logs_fill
  before insert on public.audit_logs
  for each row execute function public.audit_logs_fill();

-- ── 5. Ook in het logboek ──────────────────────────────────────────────────
drop trigger if exists galleries_audit on public.galleries;
create trigger galleries_audit after insert or update or delete on public.galleries
  for each row execute function public.audit_row_change('gallery', 'title');

drop trigger if exists email_campaigns_audit on public.email_campaigns;
create trigger email_campaigns_audit after insert or update or delete on public.email_campaigns
  for each row execute function public.audit_row_change('email_campaign', 'name');

drop trigger if exists email_flows_audit on public.email_flows;
create trigger email_flows_audit after insert or update or delete on public.email_flows
  for each row execute function public.audit_row_change('email_flow', 'name');

drop trigger if exists email_templates_audit on public.email_templates;
create trigger email_templates_audit after insert or update or delete on public.email_templates
  for each row execute function public.audit_row_change('email_template', 'template_key');

drop trigger if exists client_field_definitions_audit on public.client_field_definitions;
create trigger client_field_definitions_audit after insert or update or delete on public.client_field_definitions
  for each row execute function public.audit_row_change('client_field', 'label');

-- ── 6. Bij welke module hoort een regel ─────────────────────────────────────
-- Gelijk aan 20261107110000, plus de soorten uit stap 5. Dezelfde lijst staat
-- als AUDIT_ENTITY_MODULE in _shared/actions/admin.ts (auditVisibility.test.ts).
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'mollie_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event', 'email_template') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'partnership_partner', 'purchase_invoice', 'quote',
                           'result_appropriation', 'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact', 'client_field') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee', 'gallery') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    when p_entity_type in ('email_campaign', 'email_flow') then 'marketing'
    else 'admin'
  end;
$$;

-- ── 7. Wat er al stond ──────────────────────────────────────────────────────
-- Zonder gebruiker = systeem.
update public.audit_logs set via = 'systeem' where actor_user_id is null and via = 'app';
update public.audit_logs set last_at = created_at where last_at is null;

-- De naam van wie het deed, zoals die nu bekend is.
update public.audit_logs a
   set actor_label = coalesce(
         (select m.email::text from public.organization_members m
           where m.organization_id = a.organization_id and m.user_id = a.actor_user_id
           order by (m.status = 'active') desc limit 1),
         (select u.email::text from auth.users u where u.id = a.actor_user_id))
 where a.actor_label is null and a.actor_user_id is not null;

-- Een bijlage in de teamchat: geen bestandsnaam.
update public.audit_logs a
   set entity_label = 'Bijlage in de teamchat'
 where a.entity_type = 'attachment' and a.entity_label is distinct from 'Bijlage in de teamchat'
   and exists (select 1 from public.attachments x where x.id = a.entity_id and x.entity_type = 'chat_message');

-- De klant en het project, zolang het ding er nog is.
update public.audit_logs a
   set client_id = c.client_id, project_id = c.project_id
  from (
    select l.id, ctx.client_id, ctx.project_id
      from public.audit_logs l
      cross join lateral public.audit_context(l.entity_type, l.entity_id) ctx
     where l.client_id is null and l.project_id is null and l.entity_id is not null
       and l.entity_type in ('client', 'project', 'task', 'ticket', 'ticket_note', 'invoice', 'quote', 'contract', 'contract_note',
                             'contract_project', 'credit_note', 'note', 'document', 'content_folder', 'note_handwriting', 'time_entry',
                             'client_contact', 'client_call', 'file_transfer', 'drive_share', 'project_member', 'task_assignee',
                             'purchase_invoice', 'gallery', 'calendar_event_link', 'attachment')
  ) c
 where a.id = c.id and (c.client_id is not null or c.project_id is not null);

-- ── 8. Rechten ──────────────────────────────────────────────────────────────
-- Triggerfuncties en interne hulpjes: niet aan te roepen via de API.
revoke all on function public.audit_row_change() from public, anon, authenticated;
revoke all on function public.audit_logs_fill() from public, anon, authenticated;
revoke all on function public.audit_context(text, uuid) from public, anon, authenticated;
revoke all on function public.audit_row_diff(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.audit_merge_changes(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.audit_field_spec(text) from public, anon, authenticated;
revoke all on function public.audit_clip(jsonb) from public, anon, authenticated;
revoke all on function public.audit_count(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.audit_via(uuid) from public, anon, authenticated;
grant execute on function public.audit_context(text, uuid) to service_role;
grant execute on function public.audit_row_diff(text, jsonb, jsonb) to service_role;
grant execute on function public.audit_merge_changes(jsonb, jsonb) to service_role;
grant execute on function public.audit_field_spec(text) to service_role;
grant execute on function public.audit_clip(jsonb) to service_role;
grant execute on function public.audit_count(jsonb, boolean) to service_role;
grant execute on function public.audit_via(uuid) to service_role;
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

commit;
