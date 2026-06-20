-- ============================================================
-- ResoFly — Contracten met digitale ondertekening (fase 1)
-- Date: 2026-06-22
--
-- Context:
-- Nieuwe CRM-module. Een medewerker stelt een contract op, verstuurt het ter
-- ondertekening naar de klant, de klant tekent op een publieke pagina
-- (/contract/:token) en ontvangt een bevestiging met het getekende PDF; het
-- contract is daarna zichtbaar in het klantdossier en het portaal.
--
-- Dit datamodel spiegelt bewust de offerte-goedkeuringsflow
-- (quote_approval_resend_flow): sha256-token + TTL, workflow-events als tijdlijn,
-- Resend-deliveries/-events voor de mail-lifecycle, en een onveranderlijk
-- getekend PDF (R2 of base64-fallback). Alle muterende stappen lopen via
-- security-definer RPC's; de browser leest (RLS: can_read_org) en mag enkel
-- concepten beheren.
--
-- Bewuste fase-1 afbakening:
--  - Eén ondertekenaar (de klant). contract_signers is wel meervoud-klaar.
--  - Interne goedkeuring is optioneel (de status mag draft -> sent direct).
--  - Koppelvelden projects.contract_id / invoices.contract_id worden nu gelegd
--    (nullable, on delete set null) maar pas in fase 2 actief gebruikt om
--    projecten/facturen te genereren. De grootboekboeking blijft ongewijzigd.
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- ------------------------------------------------------------
-- 1. Atomaire contractnummer-reeks per organisatie (CON-2026-0001)
-- ------------------------------------------------------------
create table if not exists public.organization_contract_number_sequences (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  prefix text not null default 'CON',
  padding integer not null default 4 check (padding between 1 and 12),
  next_number integer not null default 1 check (next_number > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organization_contract_number_sequences enable row level security;

drop policy if exists "contract number sequences read by org admins" on public.organization_contract_number_sequences;
create policy "contract number sequences read by org admins"
  on public.organization_contract_number_sequences
  for select using (public.can_admin_org(organization_id));

-- ------------------------------------------------------------
-- 2. Contracten (spiegelt quotes)
-- ------------------------------------------------------------
create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  client_id uuid references public.clients(id) on delete set null,
  quote_id uuid references public.quotes(id) on delete set null,
  number text not null,
  title text not null default '',
  body text not null default '',
  date date not null default current_date,
  valid_until date,
  status text not null default 'draft' check (status in (
    'draft',
    'pending_internal_approval',
    'internally_approved',
    'sent',
    'signed',
    'declined',
    'expired',
    'voided'
  )),
  -- Optionele interne goedkeuring (spiegelt quotes).
  internal_approval_status text not null default 'draft'
    check (internal_approval_status in ('draft','pending','approved','rejected')),
  internal_approval_requested_at timestamptz,
  internal_approval_requested_by uuid references auth.users(id) on delete set null,
  internal_approved_at timestamptz,
  internal_approved_by uuid references auth.users(id) on delete set null,
  internal_rejected_at timestamptz,
  internal_rejected_by uuid references auth.users(id) on delete set null,
  internal_rejection_note text,
  -- Publieke ondertekenlink.
  public_token_hash text,
  public_token_created_at timestamptz,
  public_token_expires_at timestamptz,
  sent_at timestamptz,
  signed_at timestamptz,
  -- Onveranderlijk getekend exemplaar (incl. ondertekenbewijs-pagina).
  signed_document_sha256 text,
  signed_storage_provider text check (signed_storage_provider in ('r2','database')),
  signed_storage_key text,
  signed_pdf_file_name text,
  signed_pdf_size_bytes bigint,
  signed_pdf_data_base64 text,
  -- Mail-lifecycle (subset van quotes).
  resend_last_email_id text,
  last_email_delivery_status text,
  last_email_delivery_at timestamptz,
  last_email_failed_at timestamptz,
  -- Intrekken / corrigeren.
  voided_at timestamptz,
  voided_by uuid references auth.users(id) on delete set null,
  void_reason text,
  supersedes_contract_id uuid references public.contracts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contracts_number_unique unique (organization_id, number),
  constraint contracts_public_token_hash_unique unique (public_token_hash)
);

-- ------------------------------------------------------------
-- 3. Ondertekenaars (meervoud-klaar; fase 1 = 1 klant-rij)
-- ------------------------------------------------------------
create table if not exists public.contract_signers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  name text not null default '',
  email text not null,
  role text not null default 'client' check (role in ('client','internal_countersignature')),
  signing_order integer not null default 1,
  status text not null default 'pending' check (status in ('pending','signed','declined')),
  signed_at timestamptz,
  decline_reason text,
  -- Ondertekenbewijs (eIDAS eenvoudige handtekening + audit trail).
  signature_method text check (signature_method in ('typed','drawn')),
  signature_image text,
  signed_ip text,
  signed_user_agent text,
  consent_text text,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 4. Workflow-tijdlijn (spiegelt quote_approval_events)
-- ------------------------------------------------------------
create table if not exists public.contract_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'created',
    'updated',
    'submitted_for_internal_approval',
    'internal_approval_granted',
    'internal_approval_rejected',
    'public_token_created',
    'sent_to_client',
    'email_sent',
    'email_delivered',
    'email_opened',
    'email_failed',
    'client_viewed',
    'client_signed',
    'client_declined',
    'question_asked',
    'reminded',
    'voided',
    'expired'
  )),
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 5. Resend-deliveries en -events (spiegelt quote_email_*)
-- ------------------------------------------------------------
create table if not exists public.contract_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  provider text not null default 'resend',
  provider_email_id text,
  template_key text not null default 'contract.sent',
  recipient_email text not null,
  recipient_name text,
  subject text not null,
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','complained')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  complained_at timestamptz,
  last_event_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contract_email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete set null,
  delivery_id uuid references public.contract_email_deliveries(id) on delete set null,
  provider text not null default 'resend',
  provider_event_id text not null,
  provider_email_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

-- ------------------------------------------------------------
-- 6. Optionele koppelvelden (nullable, fase 1 legt ze; fase 2 gebruikt ze)
-- ------------------------------------------------------------
alter table public.projects
  add column if not exists contract_id uuid references public.contracts(id) on delete set null;
alter table public.invoices
  add column if not exists contract_id uuid references public.contracts(id) on delete set null;

-- ------------------------------------------------------------
-- 7. Indexen
-- ------------------------------------------------------------
create index if not exists idx_contracts_org_status on public.contracts(organization_id, status, created_at desc);
create index if not exists idx_contracts_client on public.contracts(organization_id, client_id, created_at desc);
create index if not exists idx_contracts_quote on public.contracts(organization_id, quote_id) where quote_id is not null;
create index if not exists idx_contracts_public_token_hash on public.contracts(public_token_hash) where public_token_hash is not null;
create index if not exists idx_contract_signers_contract on public.contract_signers(organization_id, contract_id, signing_order);
create index if not exists idx_contract_events_contract on public.contract_events(organization_id, contract_id, created_at desc);
create index if not exists idx_contract_email_deliveries_contract on public.contract_email_deliveries(organization_id, contract_id, created_at desc);
create index if not exists idx_contract_email_deliveries_provider_email on public.contract_email_deliveries(provider, provider_email_id) where provider_email_id is not null;
create index if not exists idx_contract_email_events_provider_email on public.contract_email_events(provider, provider_email_id, occurred_at desc);
create index if not exists idx_projects_contract on public.projects(contract_id) where contract_id is not null;
create index if not exists idx_invoices_contract on public.invoices(contract_id) where contract_id is not null;

-- ------------------------------------------------------------
-- 8. updated_at + audit + org-borging triggers
-- ------------------------------------------------------------
drop trigger if exists contracts_updated on public.contracts;
create trigger contracts_updated before update on public.contracts
  for each row execute function public.set_updated_at();

drop trigger if exists contract_signers_updated on public.contract_signers;
create trigger contract_signers_updated before update on public.contract_signers
  for each row execute function public.set_updated_at();

drop trigger if exists contract_email_deliveries_updated on public.contract_email_deliveries;
create trigger contract_email_deliveries_updated before update on public.contract_email_deliveries
  for each row execute function public.set_updated_at();

drop trigger if exists contracts_prevent_org_change on public.contracts;
create trigger contracts_prevent_org_change before update of organization_id on public.contracts
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists contracts_audit on public.contracts;
create trigger contracts_audit after insert or update or delete on public.contracts
  for each row execute function public.audit_row_change('contract','title');

-- Org-integriteit op het contract zelf: client/quote in dezelfde organisatie.
create or replace function public.enforce_contracts_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'contracts.client_id');
  perform public.assert_same_org_reference('public.quotes', new.quote_id, new.organization_id, 'contracts.quote_id');
  perform public.assert_same_org_reference('public.contracts', new.supersedes_contract_id, new.organization_id, 'contracts.supersedes_contract_id');
  return new;
end; $$;

drop trigger if exists contracts_org_integrity on public.contracts;
create trigger contracts_org_integrity
  before insert or update of organization_id, client_id, quote_id, supersedes_contract_id on public.contracts
  for each row execute function public.enforce_contracts_org_integrity();

-- Org-integriteit + klant-match op de projectkoppeling. Een project mag alleen
-- aan een contract van dezelfde organisatie én dezelfde klant hangen.
create or replace function public.enforce_projects_contract_integrity()
returns trigger language plpgsql as $$
declare
  v_contract_client uuid;
begin
  if new.contract_id is null then return new; end if;
  perform public.assert_same_org_reference('public.contracts', new.contract_id, new.organization_id, 'projects.contract_id');

  select client_id into v_contract_client from public.contracts where id = new.contract_id;
  if v_contract_client is not null and new.client_id is not null and v_contract_client <> new.client_id then
    raise exception 'Een project kan alleen aan een contract van dezelfde klant worden gekoppeld.' using errcode = '23514';
  end if;
  return new;
end; $$;

drop trigger if exists projects_contract_integrity on public.projects;
create trigger projects_contract_integrity
  before insert or update of contract_id, client_id on public.projects
  for each row execute function public.enforce_projects_contract_integrity();

-- Org-integriteit op de factuurkoppeling.
create or replace function public.enforce_invoices_contract_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.contracts', new.contract_id, new.organization_id, 'invoices.contract_id');
  return new;
end; $$;

drop trigger if exists invoices_contract_integrity on public.invoices;
create trigger invoices_contract_integrity
  before insert or update of contract_id on public.invoices
  for each row execute function public.enforce_invoices_contract_integrity();

-- ------------------------------------------------------------
-- 9. Statusovergang-bewaking (spiegelt enforce_quote_status_transition)
-- ------------------------------------------------------------
create or replace function public.enforce_contract_status_transition()
returns trigger language plpgsql as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  if old.status = 'draft' and new.status in ('pending_internal_approval','internally_approved','sent','voided') then return new; end if;
  if old.status = 'pending_internal_approval' and new.status in ('internally_approved','draft','voided') then return new; end if;
  if old.status = 'internally_approved' and new.status in ('sent','draft','voided') then return new; end if;
  if old.status = 'sent' and new.status in ('signed','declined','expired','voided') then return new; end if;
  if old.status in ('declined','expired') and new.status in ('draft','voided') then return new; end if;

  raise exception 'Ongeldige contract-statusovergang van % naar %. Gebruik de contract-workflow acties.', old.status, new.status using errcode = '23514';
end; $$;

drop trigger if exists contracts_status_transition_guard on public.contracts;
create trigger contracts_status_transition_guard
  before update of status on public.contracts
  for each row execute function public.enforce_contract_status_transition();

-- ------------------------------------------------------------
-- 10. Automatische contractnummer-toekenning bij insert
-- ------------------------------------------------------------
create or replace function public.allocate_next_contract_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq public.organization_contract_number_sequences;
  v_number integer;
  v_code text;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor contractnummerreeks.' using errcode = '23514';
  end if;

  insert into public.organization_contract_number_sequences(organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select * into v_seq
  from public.organization_contract_number_sequences
  where organization_id = p_organization_id
  for update;

  v_number := greatest(v_seq.next_number, 1);
  v_code := v_seq.prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(v_number::text, v_seq.padding, '0');

  while exists (
    select 1 from public.contracts c
    where c.organization_id = p_organization_id and c.number = v_code
  ) loop
    v_number := v_number + 1;
    v_code := v_seq.prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(v_number::text, v_seq.padding, '0');
  end loop;

  update public.organization_contract_number_sequences
    set next_number = v_number + 1, updated_at = now()
  where organization_id = p_organization_id;

  return v_code;
end;
$$;

create or replace function public.contracts_set_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.number, '')), '') is null then
    new.number := public.allocate_next_contract_number(new.organization_id);
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_set_number_trigger on public.contracts;
create trigger contracts_set_number_trigger
  before insert on public.contracts
  for each row execute function public.contracts_set_number();

-- ------------------------------------------------------------
-- 11. RLS
-- ------------------------------------------------------------
alter table public.contracts enable row level security;
alter table public.contract_signers enable row level security;
alter table public.contract_events enable row level security;
alter table public.contract_email_deliveries enable row level security;
alter table public.contract_email_events enable row level security;

do $$
begin
  -- contracts: lezen iedereen in de org; concepten beheren = schrijfrol.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contracts' and policyname='contracts read') then
    create policy "contracts read" on public.contracts for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contracts' and policyname='contracts insert') then
    create policy "contracts insert" on public.contracts for insert with check (public.can_write_org(organization_id) and created_by = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contracts' and policyname='contracts update') then
    create policy "contracts update" on public.contracts for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contracts' and policyname='contracts delete') then
    create policy "contracts delete" on public.contracts for delete using (public.can_write_org(organization_id) and status = 'draft');
  end if;

  -- signers: lezen org; concept-beheer schrijfrol (ondertekening loopt via service role).
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_signers' and policyname='contract signers read') then
    create policy "contract signers read" on public.contract_signers for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_signers' and policyname='contract signers write') then
    create policy "contract signers write" on public.contract_signers for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;

  -- events + deliveries + email events: alleen-lezen voor leden; schrijven via RPC/service role.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_events' and policyname='contract events read') then
    create policy "contract events read" on public.contract_events for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_email_deliveries' and policyname='contract email deliveries read') then
    create policy "contract email deliveries read" on public.contract_email_deliveries for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_email_events' and policyname='contract email events read') then
    create policy "contract email events read" on public.contract_email_events for select using (public.can_read_org(organization_id));
  end if;
end $$;

-- ------------------------------------------------------------
-- 12. Workflow-RPC's
-- ------------------------------------------------------------

-- Tijdlijn-event toevoegen.
create or replace function public.insert_contract_event(
  p_organization_id uuid,
  p_contract_id uuid,
  p_event_type text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns public.contract_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.contract_events;
begin
  insert into public.contract_events(
    organization_id, contract_id, actor_user_id, event_type, title, description, metadata
  ) values (
    p_organization_id, p_contract_id, p_actor_user_id, p_event_type,
    coalesce(nullif(btrim(p_title), ''), p_event_type),
    nullif(btrim(coalesce(p_description, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_event;
  return v_event;
end;
$$;

-- Versturen voorbereiden: token + signer + delivery, zonder status te flippen.
create or replace function public.begin_contract_signature_send(
  p_contract_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_recipient_email text,
  p_recipient_name text,
  p_subject text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts;
  v_delivery_id uuid;
begin
  select * into v_contract from public.contracts
  where id = p_contract_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Contract niet gevonden.' using errcode = '02000'; end if;
  if v_contract.status not in ('draft','pending_internal_approval','internally_approved','sent','expired') then
    raise exception 'Dit contract kan niet (opnieuw) ter ondertekening worden verstuurd vanuit status %.', v_contract.status using errcode = '23514';
  end if;

  update public.contracts
  set public_token_hash = p_token_hash,
      public_token_created_at = now(),
      public_token_expires_at = p_token_expires_at,
      updated_at = now()
  where id = p_contract_id;

  -- Zorg dat er een klant-ondertekenaar bestaat voor deze ontvanger.
  if not exists (
    select 1 from public.contract_signers
    where contract_id = p_contract_id and role = 'client'
  ) then
    insert into public.contract_signers(organization_id, contract_id, name, email, role, signing_order)
    values (p_organization_id, p_contract_id, coalesce(p_recipient_name, ''), lower(btrim(p_recipient_email)), 'client', 1);
  else
    update public.contract_signers
    set name = coalesce(nullif(btrim(p_recipient_name), ''), name),
        email = lower(btrim(p_recipient_email)),
        status = 'pending',
        signed_at = null,
        updated_at = now()
    where contract_id = p_contract_id and role = 'client';
  end if;

  insert into public.contract_email_deliveries(
    organization_id, contract_id, template_key, recipient_email, recipient_name, subject, status
  ) values (
    p_organization_id, p_contract_id, 'contract.sent', lower(btrim(p_recipient_email)), p_recipient_name, p_subject, 'queued'
  ) returning id into v_delivery_id;

  perform public.insert_contract_event(p_organization_id, p_contract_id, 'public_token_created', 'Ondertekenlink aangemaakt', null, '{}'::jsonb, p_actor_user_id);
  return v_delivery_id;
end;
$$;

-- Versturen afronden: delivery -> sent, contract -> sent.
create or replace function public.complete_contract_signature_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_email_id text
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id uuid;
  v_contract public.contracts;
begin
  update public.contract_email_deliveries
  set provider_email_id = p_provider_email_id,
      status = 'sent',
      sent_at = now(),
      last_event_at = now()
  where id = p_delivery_id and organization_id = p_organization_id
  returning contract_id into v_contract_id;
  if v_contract_id is null then raise exception 'Verzendregel niet gevonden.' using errcode = '02000'; end if;

  update public.contracts
  set status = 'sent',
      sent_at = coalesce(sent_at, now()),
      resend_last_email_id = p_provider_email_id,
      last_email_delivery_status = 'sent',
      last_email_delivery_at = now(),
      updated_at = now()
  where id = v_contract_id
  returning * into v_contract;

  perform public.insert_contract_event(p_organization_id, v_contract_id, 'sent_to_client', 'Naar klant verstuurd ter ondertekening', null, '{}'::jsonb, p_actor_user_id);
  return v_contract;
end;
$$;

-- Versturen mislukt: delivery -> failed, contract blijft staan voor herkansing.
create or replace function public.fail_contract_signature_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id uuid;
begin
  update public.contract_email_deliveries
  set status = 'failed', failed_at = now(), last_event_at = now(), error_message = p_error_message
  where id = p_delivery_id and organization_id = p_organization_id
  returning contract_id into v_contract_id;

  if v_contract_id is not null then
    update public.contracts set last_email_failed_at = now(), updated_at = now() where id = v_contract_id;
    perform public.insert_contract_event(p_organization_id, v_contract_id, 'email_failed', 'Versturen mislukt', p_error_message, '{}'::jsonb, p_actor_user_id);
  end if;
end;
$$;

-- Klant tekent (publiek). Legt het ondertekenbewijs vast.
create or replace function public.sign_contract_public(
  p_token_hash text,
  p_signer_name text,
  p_signer_email text,
  p_signature_method text,
  p_signature_image text,
  p_consent_text text,
  p_ip text default null,
  p_user_agent text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts;
begin
  select * into v_contract from public.contracts
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;
  if not found then raise exception 'Ondertekenlink is ongeldig of verlopen.' using errcode = '28000'; end if;
  if v_contract.status <> 'sent' then raise exception 'Dit contract kan niet meer worden ondertekend.' using errcode = '23514'; end if;
  if p_signature_method not in ('typed','drawn') then raise exception 'Ongeldige ondertekenmethode.' using errcode = '23514'; end if;

  update public.contract_signers
  set status = 'signed',
      name = coalesce(nullif(btrim(p_signer_name), ''), name),
      email = coalesce(nullif(lower(btrim(p_signer_email)), ''), email),
      signed_at = now(),
      signature_method = p_signature_method,
      signature_image = nullif(p_signature_image, ''),
      signed_ip = nullif(btrim(coalesce(p_ip, '')), ''),
      signed_user_agent = nullif(btrim(coalesce(p_user_agent, '')), ''),
      consent_text = nullif(btrim(coalesce(p_consent_text, '')), ''),
      email_verified_at = coalesce(email_verified_at, now()),
      updated_at = now()
  where contract_id = v_contract.id and role = 'client';

  update public.contracts
  set status = 'signed', signed_at = now(), updated_at = now()
  where id = v_contract.id
  returning * into v_contract;

  perform public.insert_contract_event(
    v_contract.organization_id, v_contract.id, 'client_signed',
    'Klant heeft het contract ondertekend', null,
    jsonb_build_object('name', p_signer_name, 'email', p_signer_email, 'method', p_signature_method, 'ip', p_ip),
    null
  );
  return v_contract;
end;
$$;

-- Getekend PDF (R2 of base64-fallback) koppelen aan het contract.
create or replace function public.attach_signed_contract_pdf(
  p_contract_id uuid,
  p_organization_id uuid,
  p_storage_provider text,
  p_storage_key text,
  p_sha256 text,
  p_file_name text,
  p_size_bytes bigint,
  p_data_base64 text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.contracts
  set signed_storage_provider = p_storage_provider,
      signed_storage_key = p_storage_key,
      signed_document_sha256 = p_sha256,
      signed_pdf_file_name = p_file_name,
      signed_pdf_size_bytes = p_size_bytes,
      signed_pdf_data_base64 = p_data_base64,
      updated_at = now()
  where id = p_contract_id and organization_id = p_organization_id;
end;
$$;

-- Klant weigert (publiek).
create or replace function public.decline_contract_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_reason text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts;
begin
  select * into v_contract from public.contracts
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;
  if not found then raise exception 'Ondertekenlink is ongeldig of verlopen.' using errcode = '28000'; end if;
  if v_contract.status <> 'sent' then raise exception 'Dit contract kan niet meer worden geweigerd.' using errcode = '23514'; end if;

  update public.contract_signers
  set status = 'declined', decline_reason = nullif(btrim(coalesce(p_reason, '')), ''), updated_at = now()
  where contract_id = v_contract.id and role = 'client';

  update public.contracts set status = 'declined', updated_at = now()
  where id = v_contract.id returning * into v_contract;

  perform public.insert_contract_event(
    v_contract.organization_id, v_contract.id, 'client_declined',
    'Klant heeft het contract geweigerd', nullif(btrim(coalesce(p_reason, '')), ''),
    jsonb_build_object('name', p_name, 'email', p_email), null
  );
  return v_contract;
end;
$$;

-- "Stel een vraag" vanaf de ondertekenpagina -> inbound bericht in de
-- communicatie-log van de klant (client_email_threads / client_emails).
create or replace function public.ask_contract_question_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts;
  v_thread_id uuid;
  v_to_email text;
begin
  select * into v_contract from public.contracts
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;
  if not found then raise exception 'Ondertekenlink is ongeldig of verlopen.' using errcode = '28000'; end if;
  if nullif(btrim(coalesce(p_message, '')), '') is null then
    raise exception 'Bericht is leeg.' using errcode = '23514';
  end if;

  if v_contract.client_id is not null then
    select coalesce(email, '') into v_to_email from public.company_settings where organization_id = v_contract.organization_id;

    insert into public.client_email_threads(organization_id, client_id, subject, last_message_at, last_direction)
    values (v_contract.organization_id, v_contract.client_id, 'Vraag over contract ' || v_contract.number, now(), 'inbound')
    returning id into v_thread_id;

    insert into public.client_emails(
      organization_id, thread_id, client_id, direction, from_email, from_name, to_email,
      subject, body_text, status, received_at
    ) values (
      v_contract.organization_id, v_thread_id, v_contract.client_id, 'inbound',
      lower(btrim(coalesce(p_email, ''))), nullif(btrim(coalesce(p_name, '')), ''), coalesce(v_to_email, ''),
      'Vraag over contract ' || v_contract.number, btrim(p_message), 'received', now()
    );
  end if;

  perform public.insert_contract_event(
    v_contract.organization_id, v_contract.id, 'question_asked',
    'Klant heeft een vraag gesteld', btrim(p_message),
    jsonb_build_object('name', p_name, 'email', p_email), null
  );
end;
$$;

-- Intrekken / corrigeren (alleen vóór ondertekening).
create or replace function public.void_contract(
  p_contract_id uuid,
  p_organization_id uuid,
  p_reason text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd.' using errcode = '28000'; end if;
  if not public.can_write_org(p_organization_id) then raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501'; end if;

  select * into v_contract from public.contracts
  where id = p_contract_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Contract niet gevonden.' using errcode = '02000'; end if;
  if v_contract.status in ('signed','voided') then
    raise exception 'Een getekend of reeds ingetrokken contract kan niet worden ingetrokken.' using errcode = '23514';
  end if;

  update public.contracts
  set status = 'voided', voided_at = now(), voided_by = v_user_id,
      void_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      public_token_hash = null, public_token_expires_at = null,
      updated_at = now()
  where id = p_contract_id
  returning * into v_contract;

  perform public.insert_contract_event(p_organization_id, p_contract_id, 'voided', 'Contract ingetrokken', nullif(btrim(coalesce(p_reason, '')), ''), '{}'::jsonb, v_user_id);
  return v_contract;
end;
$$;

-- ------------------------------------------------------------
-- 13. Rechten
-- ------------------------------------------------------------
revoke all on function public.allocate_next_contract_number(uuid) from public, anon;
grant execute on function public.allocate_next_contract_number(uuid) to authenticated, service_role;
grant execute on function public.insert_contract_event(uuid, uuid, text, text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.begin_contract_signature_send(uuid, uuid, uuid, text, timestamptz, text, text, text) to service_role;
grant execute on function public.complete_contract_signature_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_contract_signature_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.attach_signed_contract_pdf(uuid, uuid, text, text, text, text, bigint, text) to service_role;
grant execute on function public.sign_contract_public(text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.decline_contract_public(text, text, text, text) to service_role;
grant execute on function public.ask_contract_question_public(text, text, text, text) to service_role;
grant execute on function public.void_contract(uuid, uuid, text) to authenticated;

commit;
