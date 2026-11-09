-- ============================================================
-- ResoFly — Google Meet en Teams vanuit ResoFly
-- Date: 2026-11-08
--
-- Zie docs/changelog/CHANGELOG_GOOGLE_MEET_TEAMS_2026-11-08.md.
--
-- 1. calendar_sources.conference_types — welke videovergadering de agenda
--    zelf maakt, zoals Google of Microsoft het opgeeft bij "Agenda's ophalen":
--    Google conferenceProperties.allowedConferenceSolutionTypes (bv.
--    {hangoutsMeet}), Microsoft allowedOnlineMeetingProviders (bv.
--    {teamsForBusiness}). Leeg (null) = nog niet opgehaald; dan probeert
--    ResoFly het zoals altijd. Waarom: een privé-Microsoftaccount maakt geen
--    Teams-vergadering, en een Workspace-beheerder kan Meet uitzetten.
--    Microsoft maakte de afspraak dan zónder Teams, en niemand zag het tot de
--    klant geen link had. Nu toont de app die keuze daar niet, en zegt de
--    server waarom. Geen geheim: leesbaar zoals de andere kolommen.
--
-- 2. meeting_booking_links.conference_provider krijgt 'google_meet' en
--    'teams': per boeking een Meet- of Teams-vergadering, ook op een agenda
--    die die zelf niet maakt (de ResoFly-agenda). De vergadering komt van de
--    koppeling van de eigenaar van de link, met het recht dat die apart
--    aanzette. 'calendar' (Meet/Teams van de agenda) en 'jitsi' blijven.
--
-- 3. Het logboek: conference_types is een synchronisatiedetail en telt niet
--    als wijziging (zoals feed_etag). Anders gaf de eerste keer "Agenda's
--    ophalen" na deze migratie een logregel per agenda.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Wat een agenda zelf kan ─────────────────────────────────────────────
alter table public.calendar_sources
  add column if not exists conference_types text[];

comment on column public.calendar_sources.conference_types is
  'Welke videovergadering de agenda zelf maakt, zoals de provider het opgeeft (Google: hangoutsMeet, Microsoft: teamsForBusiness). Null = nog niet opgehaald.';

-- De app leest calendar_sources per kolom (20261101110000_calendar_privacy).
grant select (conference_types) on public.calendar_sources to authenticated;

-- ── 2. Boekingslinks: Google Meet of Teams per boeking ─────────────────────
alter table public.meeting_booking_links
  drop constraint if exists meeting_booking_links_conference_provider_check;
alter table public.meeting_booking_links
  add constraint meeting_booking_links_conference_provider_check
  check (conference_provider in ('calendar', 'jitsi', 'google_meet', 'teams'));

comment on column public.meeting_booking_links.conference_provider is
  'Bij auto_conference: calendar = Google Meet/Teams van de agenda, jitsi = eigen Jitsi-kamer per boeking, google_meet/teams = per boeking een Meet- of Teams-vergadering via de koppeling van de eigenaar.';

-- ── 3. Logboek: conference_types telt niet als wijziging ───────────────────
-- Gelijk aan 20261108100000_logboek, met alleen "conference_types":"i" erbij
-- bij calendar_sources.
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
    when 'calendar_sources' then '{"change_seq":"i","feed_etag":"i","feed_content_hash":"i","feed_last_synced_at":"i","feed_last_error":"i","feed_url":"i","conference_types":"i"}'
    when 'calendar_connections' then '{"status":"v","last_error":"i"}'
    when 'email_campaigns' then '{"name":"v","subject":"v","status":"v","scheduled_at":"v","started_at":"v","sent_at":"v","accent_color":"i"}'
    when 'email_flows' then '{"name":"v","status":"v","stop_condition":"v"}'
    when 'email_templates' then '{"template_key":"v","enabled":"v"}'
    when 'client_field_definitions' then '{"label":"v","field_key":"v","field_type":"v","is_archived":"v","show_in_list":"v","position":"i"}'
    else '{}'
  end)::jsonb;
$$;

-- Zoals in 20261108100000_logboek: een intern hulpje, niet aan te roepen via de API.
revoke all on function public.audit_field_spec(text) from public, anon, authenticated;
grant execute on function public.audit_field_spec(text) to service_role;

commit;
