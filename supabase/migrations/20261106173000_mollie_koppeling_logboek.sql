-- ============================================================
-- ResoFly — De Mollie-koppeling staat in het auditlog, en alleen owners en admins zien die regels
-- Date: 2026-11-06
--
-- Gevonden in de controle van de Mollie-koppeling (6 november 2026):
-- koppelen, een key vervangen en ontkoppelen kwamen nergens in het auditlog.
-- Toch bepaalt die koppeling waar het geld van klanten terechtkomt: een
-- beheerder kon een key van een ander Mollie-account plakken zonder dat iemand
-- dat later terug kon zien. invoice-workflow schrijft nu bij elk van die drie
-- een regel met entity_type 'mollie_connection' (welke modus, de laatste vier
-- tekens van de key en het Mollie-profiel; nooit de key zelf).
--
-- Deze migratie deelt die soort bewust in bij 'admin': alleen owners en admins
-- lezen hem. Dat was het al (wat niet in de lijst staat, valt onder 'admin'),
-- maar de lijst hoort elke soort te noemen (auditVisibility.test.ts), en
-- AUDIT_ENTITY_MODULE in _shared/actions/admin.ts zegt hetzelfde.
--
-- Verder gelijk aan de versie uit 20261104070000_ib_prive_vennoten.sql.
-- Veilig om opnieuw te draaien (create or replace).
-- ============================================================

begin;

create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'mollie_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'partnership_partner', 'purchase_invoice', 'quote',
                           'result_appropriation', 'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    else 'admin'
  end;
$$;

-- Zoals op staging (6 november 2026): de leesregel van audit_logs roept deze
-- functie aan als de ingelogde gebruiker; anon heeft er niets mee te maken.
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

commit;
