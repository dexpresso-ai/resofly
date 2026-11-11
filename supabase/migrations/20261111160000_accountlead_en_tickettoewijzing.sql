-- ============================================================
-- ResoFly — Accountlead per klant en tickets toewijzen aan een teamlid
-- Date: 2026-11-11
--
-- Zie CHANGELOG_ACCOUNTLEAD_TICKETTOEWIJZING_2026-11-11.md.
--
-- 1. clients.account_lead_user_id: het teamlid dat de klant "heeft". Eén
--    persoon per klant, of niemand. Hiermee kun je filteren ("mijn klanten")
--    en rapporteren (omzet, klanten en tickets per accountlead).
--
-- 2. tickets.assignee_user_id: het teamlid dat het ticket oppakt. Eén persoon,
--    of niemand ("niet toegewezen"). Eén en niet meerdere, anders dan bij taken:
--    bij een ticket wil je weten wie het antwoord geeft, en "met z'n drieën"
--    betekent in de praktijk dat niemand het doet.
--
-- 3. Alleen een actief teamlid van dezelfde organisatie, dat de module ook mag
--    lezen. Een accountlead die Klanten niet ziet, of een ticket bij iemand die
--    Tickets niet ziet, is werk dat nergens op een lijst verschijnt. De
--    boekhouder (rol accountant) is geen teamlid en kan dus niets krijgen. Zo
--    kan ook een id van een gebruiker uit een andere organisatie er niet in.
--
-- 4. Verliest iemand die toegang (uitgeschakeld, verwijderd, boekhouder
--    geworden of de module dicht), dan vervalt zijn accountleadschap en zijn
--    tickettoewijzing in die organisatie. Liet je die staan, dan stonden
--    klanten en tickets op naam van iemand die ze niet meer ziet, en viel dat
--    in geen enkel filter op. Nu staan ze op "geen accountlead" en "niet
--    toegewezen", en ziet het team dat ze een nieuwe eigenaar nodig hebben.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1 en 2. De kolommen ────────────────────────────────────────────────────

alter table public.clients
  add column if not exists account_lead_user_id uuid references auth.users(id) on delete set null;

alter table public.tickets
  add column if not exists assignee_user_id uuid references auth.users(id) on delete set null;

comment on column public.clients.account_lead_user_id is
  'Het teamlid dat de klant beheert (accountlead). Leeg = nog niemand.';
comment on column public.tickets.assignee_user_id is
  'Het teamlid dat het ticket oppakt. Leeg = niet toegewezen.';

create index if not exists idx_clients_account_lead
  on public.clients (organization_id, account_lead_user_id)
  where account_lead_user_id is not null;

create index if not exists idx_tickets_assignee
  on public.tickets (organization_id, assignee_user_id)
  where assignee_user_id is not null;

-- ── 2b. Een nieuwe klant krijgt zijn accountlead meteen mee ────────────────
--
-- Het klantformulier maakt een klant aan via create_client_with_next_code, en
-- die noemt zijn kolommen één voor één. Zonder deze regel verdween een
-- accountlead die je bij het aanmaken koos stil: de klant stond daarna op
-- "geen accountlead". Verder gelijk aan de versie van 20261101140000.

create or replace function public.create_client_with_next_code(p_organization_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  -- TOEGEVOEGD (20261111160000). De trigger clients_account_lead controleert
  -- dat het een teamlid is dat Klanten mag zien.
  v_account_lead uuid := nullif(btrim(coalesce(p_payload ->> 'account_lead_user_id', '')), '')::uuid;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'clients')) then
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
    e_invoice_channel,
    account_lead_user_id
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
    v_e_invoice_channel,
    v_account_lead
  )
  returning * into v_client;

  return v_client;
end;
$$;
revoke all on function public.create_client_with_next_code(uuid, jsonb) from public, anon;
grant execute on function public.create_client_with_next_code(uuid, jsonb) to authenticated, service_role;

-- ── 3. Alleen een teamlid dat de module mag lezen ──────────────────────────
--
-- SECURITY DEFINER: de controle leest organization_members, ook als de
-- schrijver (de app, de API, een handeling als teamlid) die rij zelf niet zou
-- mogen zien. Hij controleert alleen bij een nieuwe of andere waarde: wie een
-- klant opslaat zonder de accountlead te wijzigen, loopt niet vast op iets wat
-- intussen veranderde.

create or replace function public.member_can_hold(p_organization_id uuid, p_user_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id
       and m.user_id = p_user_id
       and m.status = 'active'
       and m.role <> 'accountant'
       and public.member_module_level(m.role, m.module_access, p_module) <> 'none'
  );
$$;

revoke all on function public.member_can_hold(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.member_can_hold(uuid, uuid, text) to service_role;

create or replace function public.enforce_client_account_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.account_lead_user_id is null then return new; end if;
  if tg_op = 'UPDATE'
     and new.account_lead_user_id is not distinct from old.account_lead_user_id
     and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;
  if not public.member_can_hold(new.organization_id, new.account_lead_user_id, 'clients') then
    raise exception 'Een accountlead is een actief teamlid van deze organisatie dat Klanten mag zien.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_client_account_lead() from public, anon, authenticated;

drop trigger if exists clients_account_lead on public.clients;
create trigger clients_account_lead
  before insert or update of account_lead_user_id, organization_id on public.clients
  for each row execute function public.enforce_client_account_lead();

create or replace function public.enforce_ticket_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assignee_user_id is null then return new; end if;
  if tg_op = 'UPDATE'
     and new.assignee_user_id is not distinct from old.assignee_user_id
     and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;
  if not public.member_can_hold(new.organization_id, new.assignee_user_id, 'tickets') then
    raise exception 'Een ticket wijs je toe aan een actief teamlid van deze organisatie dat Tickets mag zien.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_ticket_assignee() from public, anon, authenticated;

drop trigger if exists tickets_assignee on public.tickets;
create trigger tickets_assignee
  before insert or update of assignee_user_id, organization_id on public.tickets
  for each row execute function public.enforce_ticket_assignee();

-- ── 4. Wie de toegang verliest, laat zijn klanten en tickets los ───────────

create or replace function public.release_member_holdings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_user := old.user_id;
  else
    v_org := new.organization_id;
    v_user := new.user_id;
  end if;

  -- member_can_hold leest de rij zoals hij nu is: na een DELETE is hij weg,
  -- na een UPDATE staat de nieuwe status, rol of module_access er al.
  if not public.member_can_hold(v_org, v_user, 'clients') then
    update public.clients
       set account_lead_user_id = null
     where organization_id = v_org
       and account_lead_user_id = v_user;
  end if;

  if not public.member_can_hold(v_org, v_user, 'tickets') then
    update public.tickets
       set assignee_user_id = null
     where organization_id = v_org
       and assignee_user_id = v_user;
  end if;

  return null;
end;
$$;

revoke all on function public.release_member_holdings() from public, anon, authenticated;

drop trigger if exists organization_members_release_holdings on public.organization_members;
create trigger organization_members_release_holdings
  after update of status, role, module_access or delete on public.organization_members
  for each row execute function public.release_member_holdings();

-- ── 5. Webhooks: een nieuwe accountlead of toewijzing is een wijziging ──────
--
-- Een webhookbericht bevat per onderwerp precies de velden van de API
-- (webhooksServer.test.ts). Zonder deze kolommen in de lijst was een
-- toewijzing geen gebeurtenis: een koppeling die tickets naar een
-- planningstool doorzet, hoorde niet dat het ticket bij iemand anders lag.
-- Verder gelijk aan de versie van 20261010000000.

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
      'value_eur', 'follow_up', 'custom_fields', 'account_lead_user_id', 'created_by', 'created_at', 'updated_at']
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
      'assignee_user_id', 'created_by_name', 'created_by_email', 'created_by', 'created_at', 'updated_at']
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

-- De trigger webhook_capture leest de lijst ook als een teamlid een klant of
-- ticket wijzigt; anon heeft er niets mee te doen.
revoke all on function public.webhook_payload_columns(text) from public, anon;
grant execute on function public.webhook_payload_columns(text) to authenticated, service_role;

commit;
