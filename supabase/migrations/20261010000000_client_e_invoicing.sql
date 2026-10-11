-- ============================================================
-- ResoFly — E-facturatie per klant
-- Date: 2026-10-10
--
-- Per klant kies je of facturen als e-factuur de deur uit gaan.
--
--   Aan  → bij het versturen is de UBL-e-factuur (Peppol BIS 3.0) VERPLICHT,
--          mét de factuur-PDF erin (AdditionalDocumentReference), zodat de
--          ontvanger hem in zijn boekhoudpakket ook als PDF ziet. Ontbreken er
--          gegevens (adres, KVK, land …), dan gaat er niets weg en zegt de app
--          wat er mist. Twee wegen (clients.e_invoice_channel):
--            email  — de UBL met de PDF erin per mail naar het e-factuuradres
--                     (of, als dat leeg is, naar het gewone e-mailadres);
--            mollie — via Mollie (Sales Invoices API) over het Peppol-netwerk.
--                     Mollie geeft de factuur uit, mailt een PDF-kopie en int
--                     de betaling; ResoFly volgt de Peppol- en betaalstatus.
--   Uit  → de klant krijgt alleen de PDF; er gaat geen XML-bijlage meer mee.
--          (Tot nu toe ging de UBL "als het kon" bij iedere klant mee.)
--
--  1. clients.e_invoicing_enabled  de schakelaar, standaard uit.
--  2. clients.e_invoice_email      optioneel e-factuuradres, bijvoorbeeld het
--                                  inkoopfacturenadres van het boekhoudpakket
--                                  van de klant.
--     clients.e_invoice_channel    'email' (standaard) of 'mollie'.
--  3. invoice_email_deliveries     delivery_channel ('email' | 'e_invoice_email'
--                                  | 'e_invoice_mollie'), welk UBL-bestand er
--                                  meeging, en bij Mollie het Mollie-nummer, de
--                                  Peppol-status en de links — voor het
--                                  factuuroverzicht en de verzendhistorie.
--  4. invoice_workflow_events      nieuw event 'e_invoice_sent'.
--  5. create_client_with_next_code opnieuw, mét de nieuwe klantvelden. Die RPC
--                                  noemt zijn kolommen expliciet; zonder
--                                  herdefinitie zou de keuze bij het AANMAKEN
--                                  van een klant stil verloren gaan.
--  6. webhook_payload_columns      de nieuwe klantvelden ook in webhookberichten,
--                                  gelijk aan de openbare API.
-- Idempotent.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1 + 2. De klantinstelling.
-- ------------------------------------------------------------
alter table public.clients
  add column if not exists e_invoicing_enabled boolean not null default false,
  add column if not exists e_invoice_email text,
  add column if not exists e_invoice_channel text not null default 'email';

alter table public.clients drop constraint if exists clients_e_invoice_channel_check;
alter table public.clients
  add constraint clients_e_invoice_channel_check
  check (e_invoice_channel in ('email', 'mollie'));

alter table public.clients drop constraint if exists clients_e_invoice_email_format;
alter table public.clients
  add constraint clients_e_invoice_email_format
  check (e_invoice_email is null or e_invoice_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

comment on column public.clients.e_invoicing_enabled is 'Facturen aan deze klant gaan als e-factuur (UBL 2.1 / Peppol BIS 3.0 met de PDF erin). Aan = de e-factuur is verplicht bij het versturen; uit = alleen de PDF.';
comment on column public.clients.e_invoice_email is 'Optioneel e-factuuradres (bv. het inkoopfacturenadres van het boekhoudpakket van de klant). Leeg = het gewone e-mailadres.';
comment on column public.clients.e_invoice_channel is 'Hoe de e-factuur gaat: email = UBL met PDF per mail; mollie = via Mollie over Peppol (Mollie geeft uit en int).';

-- ------------------------------------------------------------
-- 3. Welk kanaal nam een verzending, en welke e-factuur ging mee.
-- ------------------------------------------------------------
alter table public.invoice_email_deliveries
  add column if not exists delivery_channel text not null default 'email',
  add column if not exists e_invoice_file_name text,
  add column if not exists e_invoice_size_bytes integer,
  add column if not exists e_invoice_sha256 text,
  -- Alleen bij Mollie: wat Mollie over zijn factuur zegt.
  add column if not exists e_invoice_status text,
  add column if not exists external_invoice_number text,
  add column if not exists external_status text,
  add column if not exists external_pdf_url text,
  add column if not exists external_payment_url text,
  add column if not exists external_synced_at timestamptz;

alter table public.invoice_email_deliveries
  drop constraint if exists invoice_email_deliveries_delivery_channel_check;
alter table public.invoice_email_deliveries
  add constraint invoice_email_deliveries_delivery_channel_check
  check (delivery_channel in ('email', 'e_invoice_email', 'e_invoice_mollie'));

alter table public.invoice_email_deliveries
  drop constraint if exists invoice_email_deliveries_e_invoice_status_check;
alter table public.invoice_email_deliveries
  add constraint invoice_email_deliveries_e_invoice_status_check
  check (e_invoice_status is null or e_invoice_status in ('issuing', 'issued', 'failed'));

comment on column public.invoice_email_deliveries.delivery_channel is 'email = factuur-PDF per mail; e_invoice_email = e-factuur (UBL met ingesloten PDF) per mail naar het e-factuuradres; e_invoice_mollie = e-factuur via Mollie over Peppol (provider_email_id = het id van de Mollie-factuur).';
comment on column public.invoice_email_deliveries.e_invoice_status is 'Peppol-aflevering volgens Mollie: issuing (bezig), issued (afgeleverd) of failed (mislukt; Mollie probeert opnieuw).';
comment on column public.invoice_email_deliveries.external_invoice_number is 'Het factuurnummer dat Mollie bij het uitgeven toekende (INV-…). Het ResoFly-nummer staat in de memo van de Mollie-factuur.';

-- De statusronde zoekt de Mollie-verzendingen per factuur op.
create index if not exists idx_invoice_email_deliveries_mollie
  on public.invoice_email_deliveries(organization_id, invoice_id, created_at desc)
  where delivery_channel = 'e_invoice_mollie';

-- ------------------------------------------------------------
-- 4. Event-types voor de tijdlijn. Volledige lijst overgenomen uit
--    20260722000000 (debiteurenautomaat) + 'e_invoice_sent' en, voor de
--    Peppol-aflevering via Mollie, 'e_invoice_delivered' en 'e_invoice_failed'.
-- ------------------------------------------------------------
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events
  add constraint invoice_workflow_events_event_type_check
  check (event_type in (
    'created_from_quote','public_token_created','public_link_created','sent_to_client',
    'email_sent','email_delivered','email_opened','email_clicked','email_bounced','email_failed','email_complained',
    'client_viewed','payment_link_created','payment_open','payment_paid','payment_failed','payment_expired',
    'invoice_version_created','invoice_pdf_attached','locked','expired','cancelled','void','written_off',
    'payment_refunded','credit_note_issued',
    'payment_charged_back','chargeback_reversed','credit_note_emailed',
    'marked_overdue','reminder_sent','reminder_failed',
    'dunning_proposed','dunning_sent','dunning_failed','dunning_cancelled',
    'e_invoice_sent','e_invoice_delivered','e_invoice_failed'
  ));

-- ------------------------------------------------------------
-- 5. create_client_with_next_code opnieuw, mét de e-factuurvelden.
--    Basis = 20260814000000 (nieuwste versie, incl. custom_fields);
--    toegevoegd: e_invoicing_enabled, e_invoice_email en e_invoice_channel.
-- ------------------------------------------------------------
create or replace function public.create_client_with_next_code(p_organization_id uuid, p_payload jsonb default '{}'::jsonb)
returns public.clients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_user_id uuid := auth.uid();
  v_status text := coalesce(nullif(btrim(p_payload ->> 'status'), ''), 'active');
  v_color text := coalesce(nullif(btrim(p_payload ->> 'color'), ''), '#FFD966');
  v_client_kind text := coalesce(nullif(btrim(p_payload ->> 'client_kind'), ''), 'business');
  v_value_eur numeric(12,2) := 0;
  v_tags text[] := '{}';
  v_custom_fields jsonb := '{}'::jsonb;
  v_e_invoicing boolean := coalesce(nullif(btrim(p_payload ->> 'e_invoicing_enabled'), '')::boolean, false);
  v_e_invoice_channel text := coalesce(nullif(btrim(p_payload ->> 'e_invoice_channel'), ''), 'email');
  v_client_code text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if v_status not in ('active','prospect','inactive') then
    raise exception 'Ongeldige klantstatus.' using errcode = '23514';
  end if;

  if v_client_kind not in ('business','consumer') then
    raise exception 'Ongeldig klanttype.' using errcode = '23514';
  end if;

  if v_e_invoice_channel not in ('email','mollie') then
    raise exception 'Ongeldige manier van e-factureren (email of mollie).' using errcode = '23514';
  end if;

  if jsonb_typeof(p_payload -> 'tags') = 'array' then
    select coalesce(array_agg(nullif(btrim(value), '')) filter (where nullif(btrim(value), '') is not null), '{}')
      into v_tags
    from jsonb_array_elements_text(p_payload -> 'tags') as tags(value);
  end if;

  if nullif(p_payload ->> 'value_eur', '') is not null then
    v_value_eur := (p_payload ->> 'value_eur')::numeric(12,2);
  end if;

  -- Vrije velden. De validatietrigger op clients normaliseert en keurt af;
  -- hier alleen doorgeven zodat ze niet stilzwijgend verdwijnen bij aanmaken.
  if jsonb_typeof(p_payload -> 'custom_fields') = 'object' then
    v_custom_fields := p_payload -> 'custom_fields';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('clients_duplicate_guard'));
  v_client_code := public.allocate_next_client_code(p_organization_id);

  perform set_config('resofly.client_code_generated', 'true', true);

  insert into public.clients(
    organization_id,
    created_by,
    name,
    client_code,
    contact_name,
    email,
    phone,
    notes,
    color,
    status,
    client_kind,
    tags,
    value_eur,
    follow_up,
    vat_number,
    kvk_number,
    address_line1,
    address_line2,
    postal_code,
    city,
    country,
    custom_fields,
    e_invoicing_enabled,
    e_invoice_email,
    e_invoice_channel
  ) values (
    p_organization_id,
    v_user_id,
    btrim(coalesce(p_payload ->> 'name', '')),
    v_client_code,
    nullif(btrim(p_payload ->> 'contact_name'), ''),
    nullif(lower(btrim(p_payload ->> 'email')), ''),
    nullif(btrim(p_payload ->> 'phone'), ''),
    nullif(btrim(p_payload ->> 'notes'), ''),
    v_color,
    v_status,
    v_client_kind,
    v_tags,
    v_value_eur,
    nullif(p_payload ->> 'follow_up', '')::date,
    nullif(btrim(p_payload ->> 'vat_number'), ''),
    nullif(btrim(p_payload ->> 'kvk_number'), ''),
    nullif(btrim(p_payload ->> 'address_line1'), ''),
    nullif(btrim(p_payload ->> 'address_line2'), ''),
    nullif(btrim(p_payload ->> 'postal_code'), ''),
    nullif(btrim(p_payload ->> 'city'), ''),
    nullif(btrim(p_payload ->> 'country'), ''),
    v_custom_fields,
    v_e_invoicing,
    nullif(lower(btrim(p_payload ->> 'e_invoice_email')), ''),
    v_e_invoice_channel
  )
  returning * into v_client;

  return v_client;
end;
$$;

-- Zelfde rechten als sinds 20260520000000: alleen ingelogde gebruikers (de
-- functie controleert zelf can_write_org), nooit de publieke anon-sleutel.
revoke all on function public.create_client_with_next_code(uuid, jsonb) from public, anon;
grant execute on function public.create_client_with_next_code(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6. Webhookberichten over klanten: precies de velden van de API.
--    De openbare API kent de nieuwe velden nu ook (apiResourceSpecs.ts);
--    webhooksServer.test.ts legt die lijst naast deze. Volledig
--    overgenomen uit 20261003030000 (api_hardening, sectie 11), alleen de
--    klantlijst is langer.
-- ------------------------------------------------------------
create or replace function public.webhook_payload_columns(p_entity text)
returns text[]
language sql
immutable
as $$
  select case p_entity
    when 'client' then array[
      'id', 'name', 'client_code', 'client_kind', 'status', 'contact_name', 'email', 'phone', 'vat_number',
      'kvk_number', 'address_line1', 'address_line2', 'postal_code', 'city', 'country',
      'e_invoicing_enabled', 'e_invoice_email', 'e_invoice_channel', 'notes', 'tags', 'color',
      'value_eur', 'follow_up', 'custom_fields', 'created_by', 'created_at', 'updated_at']
    when 'contact' then array[
      'id', 'client_id', 'name', 'email', 'phone', 'role', 'is_active', 'gives_portal_access', 'origin',
      'created_by', 'created_at', 'updated_at']
    when 'project' then array[
      'id', 'name', 'client_id', 'description', 'archived', 'start_date', 'end_date', 'billing_type',
      'hourly_rate_cents', 'budgeted_minutes', 'color', 'contract_id', 'created_by', 'created_at', 'updated_at']
    when 'task' then array[
      'id', 'title', 'description', 'status', 'priority', 'project_id', 'client_id', 'ticket_id', 'tags',
      'start_date', 'end_date', 'planned_date', 'planned_end_date', 'planned_start_minute', 'estimated_minutes',
      'created_by', 'created_at', 'updated_at']
    when 'ticket' then array[
      'id', 'title', 'description', 'status', 'priority', 'client_id', 'notes', 'converted_to_project_id',
      'created_by_name', 'created_by_email', 'created_by', 'created_at', 'updated_at']
    when 'ticket_note' then array[
      'id', 'ticket_id', 'body', 'is_internal', 'author_type', 'author_user_id', 'author_name',
      'created_at', 'updated_at']
    when 'time_entry' then array[
      'id', 'user_id', 'entry_date', 'minutes', 'started_at', 'ended_at', 'description', 'project_id',
      'client_id', 'task_id', 'billable', 'hourly_rate_cents', 'entry_type', 'indirect_category', 'source',
      'created_by', 'created_at', 'updated_at']
    when 'quote' then array[
      'id', 'number', 'client_id', 'project_id', 'date', 'valid_until', 'status', 'lines', 'notes', 'sent_at',
      'accepted_at', 'internal_approval_status', 'client_decision_at', 'client_decision_by_name',
      'created_by', 'created_at', 'updated_at']
    when 'invoice' then array[
      'id', 'number', 'client_id', 'project_id', 'quote_id', 'contract_id', 'date', 'due_date', 'status',
      'currency', 'subtotal_amount', 'vat_amount', 'total_amount', 'lines', 'notes', 'sent_at', 'paid_at',
      'refunded_amount', 'refunded_at', 'charged_back_amount', 'charged_back_at', 'reminder_level',
      'last_reminder_at', 'created_by', 'created_at', 'updated_at']
    when 'contract' then array[
      'id', 'number', 'title', 'client_id', 'quote_id', 'date', 'valid_until', 'status', 'amount_cents',
      'currency', 'sent_at', 'signed_at', 'voided_at', 'supersedes_contract_id', 'created_by', 'created_at',
      'updated_at']
    when 'booking' then array[
      'id', 'booking_link_id', 'client_id', 'status', 'booked_name', 'booked_email', 'created_at',
      'confirmed_at', 'cancelled_at']
    else array['id']
  end;
$$;

commit;
