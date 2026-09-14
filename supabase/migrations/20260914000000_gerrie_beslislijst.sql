-- ============================================================
-- Gerrie signaleert — de beslislijst (Fase 1)
--
-- Aanleiding: de app slaat alle signalen op die een goede collega zou opmerken
-- (offerte geopend maar onbeantwoord, actiepunten uit notulen, klant mailt terug,
-- favorieten gekozen, contract niet getekend), maar niets leidt tot een actie.
-- Het dashboardblok "Vereist je aandacht" telt en stuurt je naar een lijst.
--
-- Ontwerp (zie GERRIE_BESLISLIJST_PLAN.md):
--   trap 1 — SIGNALEN: triggers (direct) en een dagelijkse veegronde (tijdgebonden +
--            backfill) schrijven feiten in ai_signals, met een rijpingsmoment (due_at)
--            en dedupe op signal_key. ai_signal_enqueue() is de enige ingang.
--   trap 2 — BESLISSINGEN: de edge function gerrie-signals maakt per signaal één
--            kaart in ai_decisions (regelkaart zonder model, of Gerrie-kaart op het
--            goedkope model), met een voorstel in ai_action_audit ('proposed').
--   jij    — Akkoord voert het voorstel uit in de browser met je eigen sessie; de
--            RPC ai_decision_resolve zet kaart én auditrij dicht.
--
-- Beveiliging:
--   - Feature staat standaard UIT (ai_signal_settings.enabled = false), aanzetten
--     door owner/admin. De actor (wiens budget + rechten) moet owner/admin zijn.
--   - Triggers zijn SECURITY DEFINER en volledig exception-wrapped: melden mag
--     NOOIT de bron-insert breken (patroon van web_push).
--   - Schrijven in ai_signals/ai_decisions doet alleen de service-role; de browser
--     heeft één schrijfweg: ai_decision_resolve / ai_decision_mute (rechten getoetst).
--   - Kaarten zijn zichtbaar bij leesrecht op de organisatie, op de module van het
--     voorstel én op Gerrie; uitvoeren vraagt schrijfrecht op de module.
--   - organization_id komt uitsluitend uit de signaalrij; nooit uit het model.
-- ============================================================

begin;

-- ── 0. De acht kaartsoorten (één bron; CHECKs verwijzen hiernaar) ─────────────
create or replace function public.ai_signal_kinds()
returns text[]
language sql
immutable
as $$
  select array[
    'quote_opened_unanswered',
    'quote_expiring',
    'contract_unsigned',
    'inbound_mail',
    'mail_unmatched',
    'meeting_notes_ready',
    'meeting_notes_unsent',
    'gallery_favorites_chosen'
  ]::text[];
$$;

-- ── 1. Instellingen (één rij per organisatie; standaard uit) ──────────────────
create table if not exists public.ai_signal_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  -- De "handen" van de headless run: budget én modulerechten komen hiervan.
  actor_user_id uuid references auth.users(id) on delete set null,
  -- soort -> true/false; ontbrekend = aan.
  kinds jsonb not null default '{}'::jsonb,
  digest_hour smallint not null default 7 check (digest_hour between 0 and 23),
  timezone text not null default 'Europe/Amsterdam',
  quote_follow_up_days smallint not null default 3 check (quote_follow_up_days between 1 and 14),
  contract_follow_up_days smallint not null default 7 check (contract_follow_up_days between 1 and 30),
  -- Geen budget maar een rem op ruis en verbruik (zoals max_emails_per_run).
  max_gerrie_cards_per_day smallint not null default 10 check (max_gerrie_cards_per_day between 1 and 50),
  next_sweep_at timestamptz,
  sweep_lease_until timestamptz,
  last_sweep_at timestamptz,
  budget_blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.ai_signal_settings is 'Beslislijst (Gerrie signaleert): aan/uit, actor, soorten, veegronde. Standaard uit.';
comment on column public.ai_signal_settings.max_gerrie_cards_per_day is 'Ruisrem op Gerrie-kaarten per dag; geen budget. Het enige budget is het maandtegoed van de actor.';

create or replace function public.validate_ai_signal_settings()
returns trigger
language plpgsql
as $$
declare
  k text;
  v jsonb;
begin
  if new.actor_user_id is not null and not exists (
    select 1 from public.organization_members m
     where m.organization_id = new.organization_id and m.user_id = new.actor_user_id
       and m.status = 'active' and m.role in ('owner','admin')
  ) then
    raise exception 'De actor van de beslislijst moet een actieve owner of admin van deze organisatie zijn.' using errcode = '23514';
  end if;
  if jsonb_typeof(new.kinds) <> 'object' then
    raise exception 'kinds moet een object zijn (soort -> true/false).' using errcode = '23514';
  end if;
  for k, v in select * from jsonb_each(new.kinds) loop
    if not (k = any (public.ai_signal_kinds())) then
      raise exception 'Onbekende kaartsoort: %', k using errcode = '23514';
    end if;
    if jsonb_typeof(v) <> 'boolean' then
      raise exception 'kinds.% moet true of false zijn.', k using errcode = '23514';
    end if;
  end loop;
  if new.timezone is null or new.timezone = '' then new.timezone := 'Europe/Amsterdam'; end if;
  -- Aanzetten = meteen een eerste veegronde (backfill), zodat de lijst direct iets toont.
  if new.enabled and (case when tg_op = 'INSERT' then true else coalesce(old.enabled, false) = false end) then
    new.next_sweep_at := now();
    new.sweep_lease_until := null;
  end if;
  if not new.enabled then
    new.next_sweep_at := null;
    new.sweep_lease_until := null;
  end if;
  return new;
end;
$$;

drop trigger if exists ai_signal_settings_validate on public.ai_signal_settings;
create trigger ai_signal_settings_validate
  before insert or update on public.ai_signal_settings
  for each row execute function public.validate_ai_signal_settings();

drop trigger if exists ai_signal_settings_updated on public.ai_signal_settings;
create trigger ai_signal_settings_updated
  before update on public.ai_signal_settings
  for each row execute function public.set_updated_at();

alter table public.ai_signal_settings enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_signal_settings' and policyname = 'ai_signal_settings read') then
    create policy "ai_signal_settings read" on public.ai_signal_settings
      for select to authenticated using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_signal_settings' and policyname = 'ai_signal_settings insert') then
    create policy "ai_signal_settings insert" on public.ai_signal_settings
      for insert to authenticated with check (public.can_admin_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_signal_settings' and policyname = 'ai_signal_settings update') then
    create policy "ai_signal_settings update" on public.ai_signal_settings
      for update to authenticated using (public.can_admin_org(organization_id)) with check (public.can_admin_org(organization_id));
  end if;
end $$;

-- ── 2. Signalen (trap 1) ──────────────────────────────────────────────────────
create table if not exists public.ai_signals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind = any (public.ai_signal_kinds())),
  signal_key text not null check (char_length(signal_key) <= 200),
  entity_type text not null default '' check (char_length(entity_type) <= 40),
  entity_id uuid,
  client_id uuid references public.clients(id) on delete set null,
  -- Feiten uit trap 1: id's, bedragen, tijdstippen, eerste 3.000 tekens mailtekst.
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  -- Rijpingsmoment: de tik pakt alleen due_at <= now().
  due_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued','claimed','decided','skipped','failed')),
  reason text check (char_length(reason) <= 400),
  attempts int not null default 0,
  lease_until timestamptz,
  decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.ai_signals is 'Trap 1 van de beslislijst: feiten die rijpen tot een kaart. Alleen via ai_signal_enqueue().';

create unique index if not exists idx_ai_signals_active_key
  on public.ai_signals(organization_id, signal_key) where status in ('queued','claimed');
create index if not exists idx_ai_signals_due
  on public.ai_signals(due_at) where status = 'queued';
create index if not exists idx_ai_signals_org_created
  on public.ai_signals(organization_id, created_at desc);

drop trigger if exists ai_signals_updated on public.ai_signals;
create trigger ai_signals_updated before update on public.ai_signals
  for each row execute function public.set_updated_at();
drop trigger if exists ai_signals_prevent_org_change on public.ai_signals;
create trigger ai_signals_prevent_org_change before update of organization_id on public.ai_signals
  for each row execute function public.prevent_organization_id_change();

create or replace function public.enforce_ai_signals_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'ai_signals.client_id');
  return new;
end;
$$;
drop trigger if exists ai_signals_org_integrity on public.ai_signals;
create trigger ai_signals_org_integrity
  before insert or update of organization_id, client_id on public.ai_signals
  for each row execute function public.enforce_ai_signals_org_integrity();

alter table public.ai_signals enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_signals' and policyname = 'ai_signals read') then
    create policy "ai_signals read" on public.ai_signals
      for select to authenticated using (public.can_admin_org(organization_id));
  end if;
end $$;
-- Bewust geen client-write-policies: schrijven doen triggers en de service-role.

-- ── 3. Kaarten (trap 2) ───────────────────────────────────────────────────────
create table if not exists public.ai_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  signal_id uuid references public.ai_signals(id) on delete set null,
  signal_key text not null default '' check (char_length(signal_key) <= 200),
  kind text not null check (kind = any (public.ai_signal_kinds())),
  -- De module van het SCHRIJF-voorstel, zodat kijk- en akkoordrechten samenvallen.
  module text not null check (module in ('clients','projects','time','calendar','tickets','content','stats','marketing','finance','chat','gerrie')),
  origin text not null check (origin in ('rule','gerrie')),
  -- high = geld of naar buiten (mail); zelfde betekenis als risk op registry-kaarten.
  severity text not null default 'normal' check (severity in ('info','normal','high')),
  entity_type text not null default '' check (char_length(entity_type) <= 40),
  entity_id uuid,
  client_id uuid references public.clients(id) on delete set null,
  -- Gereserveerd voor persoonlijke kaarten (Fase 2); v1 altijd null = hele team.
  assignee_user_id uuid references auth.users(id) on delete set null,
  title text not null check (char_length(title) <= 200),
  summary text not null default '' check (char_length(summary) <= 600),
  -- De "waarom"-regels: uit trap 1, nooit uit het model.
  evidence jsonb not null default '[]'::jsonb,
  -- Kopie van het voorstel (zelfde vorm als ai_action_audit.params): de auditrij is
  -- owner/admin-only, maar een teamlid met module-rechten mag de kaart uitvoeren.
  proposal jsonb,
  audit_id uuid references public.ai_action_audit(id) on delete set null,
  -- {kind, id} voor "Openen".
  target jsonb,
  status text not null default 'open' check (status in ('open','snoozed','done','dismissed','expired')),
  snoozed_until timestamptz,
  expires_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution text check (char_length(resolution) <= 200),
  model_kind text check (model_kind in ('cheap','strong')),
  cost_usd numeric(10,4),
  trace jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.ai_decisions is 'Trap 2 van de beslislijst: één kaart per signaal, met voorstel, feiten en de knoppen Akkoord/Openen/Later/Niet meer.';

create index if not exists idx_ai_decisions_org_status
  on public.ai_decisions(organization_id, status, created_at desc);
create index if not exists idx_ai_decisions_open_entity
  on public.ai_decisions(organization_id, kind, entity_id) where status in ('open','snoozed');
create index if not exists idx_ai_decisions_signal
  on public.ai_decisions(organization_id, signal_id);

drop trigger if exists ai_decisions_updated on public.ai_decisions;
create trigger ai_decisions_updated before update on public.ai_decisions
  for each row execute function public.set_updated_at();
drop trigger if exists ai_decisions_prevent_org_change on public.ai_decisions;
create trigger ai_decisions_prevent_org_change before update of organization_id on public.ai_decisions
  for each row execute function public.prevent_organization_id_change();

create or replace function public.enforce_ai_decisions_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.ai_signals', new.signal_id, new.organization_id, 'ai_decisions.signal_id');
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'ai_decisions.client_id');
  perform public.assert_same_org_reference('public.ai_action_audit', new.audit_id, new.organization_id, 'ai_decisions.audit_id');
  return new;
end;
$$;
drop trigger if exists ai_decisions_org_integrity on public.ai_decisions;
create trigger ai_decisions_org_integrity
  before insert or update of organization_id, signal_id, client_id, audit_id on public.ai_decisions
  for each row execute function public.enforce_ai_decisions_org_integrity();

alter table public.ai_decisions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_decisions' and policyname = 'ai_decisions read') then
    create policy "ai_decisions read" on public.ai_decisions
      for select to authenticated using (
        public.can_read_org(organization_id)
        and public.can_read_module(organization_id, module)
        and public.can_read_module(organization_id, 'gerrie')
      );
  end if;
end $$;
-- Geen insert/update/delete-policies: schrijven doet de service-role, afhandelen de RPC's.

-- Live bijwerken van de lijst (patroon client_emails, 20260701000001).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ai_decisions'
  ) then
    alter publication supabase_realtime add table public.ai_decisions;
  end if;
end $$;

-- Terugverwijzing signaal -> kaart (pas mogelijk nu beide tabellen bestaan).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_signals_decision_id_fkey') then
    alter table public.ai_signals
      add constraint ai_signals_decision_id_fkey
      foreign key (decision_id) references public.ai_decisions(id) on delete set null;
  end if;
end $$;

-- ── 4. Gedempt ("Niet meer": deze kaart / deze klant / dit soort) ─────────────
create table if not exists public.ai_decision_mutes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null check (scope in ('kind','entity','client')),
  kind text check (kind is null or kind = any (public.ai_signal_kinds())),
  entity_type text check (char_length(entity_type) <= 40),
  entity_id uuid,
  client_id uuid references public.clients(id) on delete cascade,
  until timestamptz,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (
    (scope = 'kind' and kind is not null and entity_id is null and client_id is null)
    or (scope = 'entity' and entity_id is not null)
    or (scope = 'client' and client_id is not null)
  )
);
create unique index if not exists idx_ai_decision_mutes_unique
  on public.ai_decision_mutes(
    organization_id, scope,
    coalesce(kind, ''),
    coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create or replace function public.enforce_ai_decision_mutes_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'ai_decision_mutes.client_id');
  return new;
end;
$$;
drop trigger if exists ai_decision_mutes_org_integrity on public.ai_decision_mutes;
create trigger ai_decision_mutes_org_integrity
  before insert or update of organization_id, client_id on public.ai_decision_mutes
  for each row execute function public.enforce_ai_decision_mutes_org_integrity();

alter table public.ai_decision_mutes enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_decision_mutes' and policyname = 'ai_decision_mutes read') then
    create policy "ai_decision_mutes read" on public.ai_decision_mutes
      for select to authenticated using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_decision_mutes' and policyname = 'ai_decision_mutes insert') then
    create policy "ai_decision_mutes insert" on public.ai_decision_mutes
      for insert to authenticated with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_decision_mutes' and policyname = 'ai_decision_mutes delete') then
    create policy "ai_decision_mutes delete" on public.ai_decision_mutes
      for delete to authenticated using (public.can_write_org(organization_id));
  end if;
end $$;

-- ── 5. Koppelingen op bestaande tabellen ──────────────────────────────────────
alter table public.ai_action_audit add column if not exists signal_id uuid references public.ai_signals(id) on delete set null;
create index if not exists idx_ai_action_audit_signal on public.ai_action_audit(signal_id) where signal_id is not null;
-- Verbruik blijft user_id (de actor) dragen: het bestaande maandbudget dekt dit automatisch.
alter table public.ai_usage add column if not exists signal_id uuid references public.ai_signals(id) on delete set null;

-- ── 6. Push-gebeurtenis 'decision_digest' (één per org per dag) ───────────────
-- Vier plekken in één wijziging: beide CHECKs hier, PushEventType + PUSH_EVENTS in
-- src/lib/push-api.ts (zie geheugen attachments-entity-type-drift).
do $$
declare c record;
begin
  for c in
    select conname, conrelid::regclass as tbl
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.notification_outbox'::regclass, 'public.notification_preferences'::regclass)
       and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;
alter table public.notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest'));
alter table public.notification_preferences add constraint notification_preferences_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest'));

-- ── 7. De enige ingang voor een signaal ───────────────────────────────────────
create or replace function public.ai_signal_enqueue(
  p_org uuid, p_kind text, p_key text, p_entity_type text, p_entity_id uuid,
  p_client_id uuid, p_payload jsonb, p_due_at timestamptz default now()
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.ai_signal_settings%rowtype;
  v_id uuid;
begin
  if p_org is null or p_kind is null or p_key is null then return null; end if;
  select * into v_settings from public.ai_signal_settings where organization_id = p_org;
  if not found or not v_settings.enabled then return null; end if;
  if coalesce((v_settings.kinds ->> p_kind)::boolean, true) = false then return null; end if;
  -- Gedempt: deze kaartsoort, dit item, of alles van deze klant.
  if exists (
    select 1 from public.ai_decision_mutes m
     where m.organization_id = p_org and (m.until is null or m.until > now())
       and (
         (m.scope = 'kind' and m.kind = p_kind)
         or (m.scope = 'entity' and p_entity_id is not null and m.entity_id = p_entity_id)
         or (m.scope = 'client' and p_client_id is not null and m.client_id = p_client_id)
       )
  ) then return null; end if;
  -- Dubbel: een actief signaal, een open kaart, of een kaart die de laatste twee weken
  -- al is afgehandeld (anders komt "Niet nu" morgen gewoon weer terug).
  if exists (select 1 from public.ai_signals s where s.organization_id = p_org and s.signal_key = p_key and s.status in ('queued','claimed')) then return null; end if;
  if exists (
    select 1 from public.ai_decisions d
     where d.organization_id = p_org and d.signal_key = p_key
       and (d.status in ('open','snoozed') or (d.status in ('done','dismissed') and d.resolved_at > now() - interval '14 days'))
  ) then return null; end if;
  insert into public.ai_signals (organization_id, kind, signal_key, entity_type, entity_id, client_id, payload, due_at)
  values (p_org, p_kind, p_key, coalesce(p_entity_type, ''), p_entity_id, p_client_id, coalesce(p_payload, '{}'::jsonb), coalesce(p_due_at, now()))
  on conflict (organization_id, signal_key) where status in ('queued','claimed') do nothing
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.ai_signal_enqueue(uuid, text, text, text, uuid, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_signal_enqueue(uuid, text, text, text, uuid, uuid, jsonb, timestamptz) to service_role;

-- ── 8. Triggers: de gebeurtenissen die de app al vastlegt ─────────────────────
-- Alle triggers: SECURITY DEFINER, body in een exception-blok, return null.
-- Een fout in het signaleren mag nooit de bron-insert/-update blokkeren.

-- 8a. Offerte-mail voor het eerst geopend.
create or replace function public.ai_signal_on_quote_delivery_opened()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_q record; v_days int;
begin
  begin
    if old.opened_at is not null or new.opened_at is null then return null; end if;
    select q.id, q.organization_id, q.client_id, q.number, q.status, q.valid_until into v_q
      from public.quotes q where q.id = new.quote_id;
    if not found or v_q.status <> 'sent' then return null; end if;
    select s.quote_follow_up_days into v_days from public.ai_signal_settings s where s.organization_id = v_q.organization_id;
    perform public.ai_signal_enqueue(
      v_q.organization_id, 'quote_opened_unanswered', 'quote:' || v_q.id::text || ':followup',
      'quote', v_q.id, v_q.client_id,
      jsonb_build_object('quote_id', v_q.id, 'quote_number', v_q.number, 'recipient_email', new.recipient_email,
                         'opened_at', new.opened_at, 'valid_until', v_q.valid_until),
      new.opened_at + make_interval(days => coalesce(v_days, 3)));
  exception when others then
    raise warning 'ai_signal_on_quote_delivery_opened: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_quote_delivery_opened on public.quote_email_deliveries;
create trigger ai_signal_quote_delivery_opened after update of opened_at on public.quote_email_deliveries
  for each row execute function public.ai_signal_on_quote_delivery_opened();

-- 8b. Klant opende de offertepagina (publieke link).
create or replace function public.ai_signal_on_quote_client_viewed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_q record; v_days int;
begin
  begin
    if new.event_type <> 'client_viewed' then return null; end if;
    select q.id, q.organization_id, q.client_id, q.number, q.status, q.valid_until into v_q
      from public.quotes q where q.id = new.quote_id;
    if not found or v_q.status <> 'sent' then return null; end if;
    select s.quote_follow_up_days into v_days from public.ai_signal_settings s where s.organization_id = v_q.organization_id;
    perform public.ai_signal_enqueue(
      v_q.organization_id, 'quote_opened_unanswered', 'quote:' || v_q.id::text || ':followup',
      'quote', v_q.id, v_q.client_id,
      jsonb_build_object('quote_id', v_q.id, 'quote_number', v_q.number, 'viewed_at', new.created_at, 'valid_until', v_q.valid_until),
      now() + make_interval(days => coalesce(v_days, 3)));
  exception when others then
    raise warning 'ai_signal_on_quote_client_viewed: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_quote_client_viewed on public.quote_approval_events;
create trigger ai_signal_quote_client_viewed after insert on public.quote_approval_events
  for each row execute function public.ai_signal_on_quote_client_viewed();

-- 8c. Contract verstuurd ter ondertekening.
create or replace function public.ai_signal_on_contract_sent()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_days int;
begin
  begin
    if new.status <> 'sent' or old.status is not distinct from 'sent' then return null; end if;
    select s.contract_follow_up_days into v_days from public.ai_signal_settings s where s.organization_id = new.organization_id;
    perform public.ai_signal_enqueue(
      new.organization_id, 'contract_unsigned', 'contract:' || new.id::text || ':unsigned',
      'contract', new.id, new.client_id,
      jsonb_build_object('contract_id', new.id, 'number', new.number, 'title', new.title, 'sent_at', coalesce(new.sent_at, now())),
      coalesce(new.sent_at, now()) + make_interval(days => coalesce(v_days, 7)));
  exception when others then
    raise warning 'ai_signal_on_contract_sent: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_contract_sent on public.contracts;
create trigger ai_signal_contract_sent after update of status on public.contracts
  for each row execute function public.ai_signal_on_contract_sent();

-- 8d. Inkomende klantmail (alleen echte post van mensen; rijpt na vier uur).
create or replace function public.ai_signal_on_client_email_inbound()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_category text;
begin
  begin
    if new.direction is distinct from 'inbound' then return null; end if;
    if new.inbound_message_id is not null then
      select m.category into v_category from public.inbound_messages m where m.id = new.inbound_message_id;
      if v_category = 'automated' then return null; end if;
    end if;
    perform public.ai_signal_enqueue(
      new.organization_id, 'inbound_mail', 'mail:' || new.id::text,
      'client_email', new.id, new.client_id,
      jsonb_build_object('client_email_id', new.id, 'thread_id', new.thread_id, 'subject', new.subject,
                         'from_email', new.from_email, 'from_name', new.from_name,
                         'received_at', coalesce(new.received_at, now()), 'body_text', left(coalesce(new.body_text, ''), 3000)),
      coalesce(new.received_at, now()) + interval '4 hours');
  exception when others then
    raise warning 'ai_signal_on_client_email_inbound: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_client_email_inbound on public.client_emails;
create trigger ai_signal_client_email_inbound after insert on public.client_emails
  for each row execute function public.ai_signal_on_client_email_inbound();

-- 8e. Mail in de opvangbak mét een voorgestelde klant.
create or replace function public.ai_signal_on_inbound_unmatched()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.status <> 'unmatched' or new.suggested_client_id is null or new.category <> 'human' then return null; end if;
    perform public.ai_signal_enqueue(
      new.organization_id, 'mail_unmatched', 'inbox:' || new.id::text,
      'inbound_message', new.id, new.suggested_client_id,
      jsonb_build_object('inbound_message_id', new.id, 'sender_email', new.sender_email, 'sender_name', new.sender_name,
                         'subject', new.subject, 'received_at', new.received_at, 'suggested_client_id', new.suggested_client_id),
      now());
  exception when others then
    raise warning 'ai_signal_on_inbound_unmatched: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_inbound_unmatched on public.inbound_messages;
create trigger ai_signal_inbound_unmatched after insert or update of status, suggested_client_id on public.inbound_messages
  for each row execute function public.ai_signal_on_inbound_unmatched();

-- 8f. Notulen klaar mét actiepunten.
create or replace function public.ai_signal_on_meeting_done()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_items jsonb;
begin
  begin
    if new.status <> 'done' or old.status is not distinct from 'done' then return null; end if;
    v_items := coalesce(new.summary_json -> 'actiepunten', '[]'::jsonb);
    if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then return null; end if;
    perform public.ai_signal_enqueue(
      new.organization_id, 'meeting_notes_ready', 'meeting:' || new.id::text || ':tasks',
      'meeting_recording', new.id, new.client_id,
      jsonb_build_object('recording_id', new.id, 'title', new.event_title_snapshot, 'project_id', new.project_id,
                         'client_id', new.client_id, 'recorded_at', new.created_at,
                         'actiepunten', v_items, 'besluiten', coalesce(new.summary_json -> 'besluiten', '[]'::jsonb)),
      now());
  exception when others then
    raise warning 'ai_signal_on_meeting_done: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_meeting_done on public.meeting_recordings;
create trigger ai_signal_meeting_done after update of status on public.meeting_recordings
  for each row execute function public.ai_signal_on_meeting_done();

-- 8g. Favoriet gekozen in een galerij (bundelt de sessie: rijpt na zes uur, sleutel per dag).
create or replace function public.ai_signal_on_gallery_favorite()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_g record; v_tz text; v_client uuid;
begin
  begin
    if new.reaction is distinct from 'favorite' then return null; end if;
    select g.id, g.organization_id, g.title, g.project_id into v_g from public.galleries g where g.id = new.gallery_id;
    if not found then return null; end if;
    select s.timezone into v_tz from public.ai_signal_settings s where s.organization_id = v_g.organization_id;
    select p.client_id into v_client from public.projects p where p.id = v_g.project_id;
    perform public.ai_signal_enqueue(
      v_g.organization_id, 'gallery_favorites_chosen',
      'gallery:' || v_g.id::text || ':favorites:' || to_char(now() at time zone coalesce(v_tz, 'Europe/Amsterdam'), 'YYYY-MM-DD'),
      'gallery', v_g.id, v_client,
      jsonb_build_object('gallery_id', v_g.id, 'gallery_title', v_g.title, 'project_id', v_g.project_id),
      now() + interval '6 hours');
  exception when others then
    raise warning 'ai_signal_on_gallery_favorite: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists ai_signal_gallery_favorite on public.gallery_favorites;
create trigger ai_signal_gallery_favorite after insert on public.gallery_favorites
  for each row execute function public.ai_signal_on_gallery_favorite();

-- ── 9. De veegronde: tijdgebonden signalen + backfill ─────────────────────────
create or replace function public.collect_time_signals(p_org uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.ai_signal_settings%rowtype;
  r record;
  n int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag de veegronde draaien.' using errcode = '42501';
  end if;
  select * into v_settings from public.ai_signal_settings where organization_id = p_org;
  if not found or not v_settings.enabled then return 0; end if;

  -- Offerte verloopt binnen drie dagen en de klant heeft nog niet gereageerd.
  for r in
    select q.id, q.number, q.client_id, q.valid_until
      from public.quotes q
     where q.organization_id = p_org and q.status = 'sent'
       and q.valid_until is not null
       and q.valid_until between current_date and current_date + 3
  loop
    if public.ai_signal_enqueue(p_org, 'quote_expiring', 'quote:' || r.id::text || ':expiring', 'quote', r.id, r.client_id,
         jsonb_build_object('quote_id', r.id, 'quote_number', r.number, 'valid_until', r.valid_until), now()) is not null then n := n + 1; end if;
  end loop;

  -- Notulen klaar maar na een etmaal nog niet gemaild.
  for r in
    select m.id, m.event_title_snapshot, m.client_id, m.project_id, m.updated_at
      from public.meeting_recordings m
     where m.organization_id = p_org and m.status = 'done'
       and m.summary_text is not null and m.summary_sent_at is null
       and m.updated_at < now() - interval '24 hours'
       and m.created_at > now() - interval '30 days'
  loop
    if public.ai_signal_enqueue(p_org, 'meeting_notes_unsent', 'meeting:' || r.id::text || ':unsent', 'meeting_recording', r.id, r.client_id,
         jsonb_build_object('recording_id', r.id, 'title', r.event_title_snapshot, 'project_id', r.project_id, 'done_at', r.updated_at), now()) is not null then n := n + 1; end if;
  end loop;

  -- Backfill: offertes die vóór het aanzetten al geopend waren.
  for r in
    select q.id, q.number, q.client_id, q.valid_until, q.last_email_opened_at
      from public.quotes q
     where q.organization_id = p_org and q.status = 'sent' and q.last_email_opened_at is not null
       and q.last_email_opened_at > now() - interval '60 days'
  loop
    if public.ai_signal_enqueue(p_org, 'quote_opened_unanswered', 'quote:' || r.id::text || ':followup', 'quote', r.id, r.client_id,
         jsonb_build_object('quote_id', r.id, 'quote_number', r.number, 'opened_at', r.last_email_opened_at, 'valid_until', r.valid_until, 'backfill', true),
         greatest(now(), r.last_email_opened_at + make_interval(days => v_settings.quote_follow_up_days))) is not null then n := n + 1; end if;
  end loop;

  -- Backfill: contracten die vóór het aanzetten al verstuurd waren.
  for r in
    select c.id, c.number, c.title, c.client_id, c.sent_at
      from public.contracts c
     where c.organization_id = p_org and c.status = 'sent' and c.sent_at is not null
       and c.sent_at > now() - interval '90 days'
  loop
    if public.ai_signal_enqueue(p_org, 'contract_unsigned', 'contract:' || r.id::text || ':unsigned', 'contract', r.id, r.client_id,
         jsonb_build_object('contract_id', r.id, 'number', r.number, 'title', r.title, 'sent_at', r.sent_at, 'backfill', true),
         greatest(now(), r.sent_at + make_interval(days => v_settings.contract_follow_up_days))) is not null then n := n + 1; end if;
  end loop;

  return n;
end;
$$;
revoke execute on function public.collect_time_signals(uuid) from public, anon, authenticated;
grant execute on function public.collect_time_signals(uuid) to service_role;

-- ── 10. Kaarten die de wereld heeft ingehaald ─────────────────────────────────
create or replace function public.ai_decisions_expire(p_org uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
  v_gone boolean;
  v_reason text;
  n int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag kaarten laten verlopen.' using errcode = '42501';
  end if;
  for d in
    select id, kind, entity_id, audit_id, expires_at
      from public.ai_decisions
     where organization_id = p_org and status in ('open','snoozed')
  loop
    v_gone := false; v_reason := null;
    if d.expires_at is not null and d.expires_at < now() then
      v_gone := true; v_reason := 'verlopen';
    elsif d.kind in ('quote_opened_unanswered','quote_expiring') then
      if not exists (select 1 from public.quotes q where q.id = d.entity_id and q.status = 'sent') then v_gone := true; v_reason := 'offerte niet meer open'; end if;
    elsif d.kind = 'contract_unsigned' then
      if not exists (select 1 from public.contracts c where c.id = d.entity_id and c.status = 'sent') then v_gone := true; v_reason := 'contract niet meer open'; end if;
    elsif d.kind = 'inbound_mail' then
      if not exists (select 1 from public.client_emails e where e.id = d.entity_id and e.deleted_at is null) then
        v_gone := true; v_reason := 'mail verwijderd';
      elsif exists (
        select 1 from public.client_emails i
          join public.client_emails o on o.thread_id = i.thread_id and o.direction = 'outbound' and o.created_at > coalesce(i.received_at, i.created_at)
         where i.id = d.entity_id
      ) then v_gone := true; v_reason := 'al beantwoord'; end if;
    elsif d.kind = 'mail_unmatched' then
      if not exists (select 1 from public.inbound_messages m where m.id = d.entity_id and m.status = 'unmatched') then v_gone := true; v_reason := 'al afgehandeld'; end if;
    elsif d.kind in ('meeting_notes_ready','meeting_notes_unsent') then
      if not exists (select 1 from public.meeting_recordings m where m.id = d.entity_id) then
        v_gone := true; v_reason := 'opname verwijderd';
      elsif d.kind = 'meeting_notes_unsent' and exists (select 1 from public.meeting_recordings m where m.id = d.entity_id and m.summary_sent_at is not null) then
        v_gone := true; v_reason := 'notulen al gemaild';
      end if;
    elsif d.kind = 'gallery_favorites_chosen' then
      if not exists (select 1 from public.galleries g where g.id = d.entity_id) then v_gone := true; v_reason := 'galerij verwijderd'; end if;
    end if;
    if v_gone then
      update public.ai_decisions set status = 'expired', resolution = left('expired: ' || v_reason, 200), resolved_at = now() where id = d.id;
      if d.audit_id is not null then
        update public.ai_action_audit set status = 'cancelled' where id = d.audit_id and status = 'proposed';
      end if;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.ai_decisions_expire(uuid) from public, anon, authenticated;
grant execute on function public.ai_decisions_expire(uuid) to service_role;

-- ── 11. Claimen (kopie van claim_due_agents: lease los van het schema) ────────
create or replace function public.claim_due_signals(p_limit int default 3)
returns setof public.ai_signals
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag signalen claimen.' using errcode = '42501';
  end if;
  return query
  update public.ai_signals s
     set status = 'claimed', lease_until = now() + interval '10 minutes', attempts = s.attempts + 1, updated_at = now()
   where s.id in (
     select x.id from public.ai_signals x
       join public.ai_signal_settings st on st.organization_id = x.organization_id and st.enabled
      where x.due_at <= now()
        and (
          x.status = 'queued'
          or (x.status = 'claimed' and x.lease_until < now() and x.attempts < 3)
        )
      order by x.due_at
      limit greatest(1, least(p_limit, 5))
      for update of x skip locked
   )
   returning s.*;
end;
$$;
revoke execute on function public.claim_due_signals(int) from public, anon, authenticated;
grant execute on function public.claim_due_signals(int) to service_role;

create or replace function public.claim_due_sweeps(p_limit int default 2)
returns setof public.ai_signal_settings
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag veegrondes claimen.' using errcode = '42501';
  end if;
  return query
  update public.ai_signal_settings s
     set sweep_lease_until = now() + interval '10 minutes', updated_at = now()
   where s.organization_id in (
     select x.organization_id from public.ai_signal_settings x
      where x.enabled and x.next_sweep_at is not null and x.next_sweep_at <= now()
        and (x.sweep_lease_until is null or x.sweep_lease_until < now())
      order by x.next_sweep_at
      limit greatest(1, least(p_limit, 5))
      for update skip locked
   )
   returning s.*;
end;
$$;
revoke execute on function public.claim_due_sweeps(int) from public, anon, authenticated;
grant execute on function public.claim_due_sweeps(int) to service_role;

-- ── 12. De enige schrijfweg vanuit de browser ─────────────────────────────────
create or replace function public.ai_decision_resolve(
  p_id uuid, p_status text, p_snoozed_until timestamptz default null, p_resolution text default null
) returns public.ai_decisions
language plpgsql
security definer
set search_path = public
as $$
declare d public.ai_decisions%rowtype;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd.' using errcode = '42501'; end if;
  select * into d from public.ai_decisions where id = p_id for update;
  if not found then raise exception 'Kaart niet gevonden.' using errcode = 'P0002'; end if;
  if not (public.can_read_org(d.organization_id) and public.can_read_module(d.organization_id, 'gerrie')
          and public.can_write_module(d.organization_id, d.module)) then
    raise exception 'Je hebt geen schrijfrechten voor deze kaart.' using errcode = '42501';
  end if;
  if p_status not in ('open','snoozed','done','dismissed') then
    raise exception 'Onbekende status: %', p_status using errcode = '22023';
  end if;
  if p_status = 'snoozed' and p_snoozed_until is null then
    raise exception 'Geef een moment waarop de kaart terugkomt.' using errcode = '22023';
  end if;
  update public.ai_decisions
     set status = p_status,
         snoozed_until = case when p_status = 'snoozed' then p_snoozed_until else null end,
         resolved_by = case when p_status in ('done','dismissed') then auth.uid() else null end,
         resolved_at = case when p_status in ('done','dismissed') then now() else null end,
         resolution = left(p_resolution, 200)
   where id = p_id
   returning * into d;
  if d.audit_id is not null then
    update public.ai_action_audit
       set status = case when p_status = 'done' then 'executed' when p_status = 'dismissed' then 'cancelled' else status end
     where id = d.audit_id and status = 'proposed';
  end if;
  return d;
end;
$$;
revoke execute on function public.ai_decision_resolve(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.ai_decision_resolve(uuid, text, timestamptz, text) to authenticated, service_role;

-- "Niet meer": dempen én de kaart (plus alles wat er al open staat en eronder valt) sluiten.
create or replace function public.ai_decision_mute(p_decision_id uuid, p_scope text, p_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d public.ai_decisions%rowtype;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd.' using errcode = '42501'; end if;
  select * into d from public.ai_decisions where id = p_decision_id;
  if not found then raise exception 'Kaart niet gevonden.' using errcode = 'P0002'; end if;
  if not (public.can_read_org(d.organization_id) and public.can_read_module(d.organization_id, 'gerrie')
          and public.can_write_module(d.organization_id, d.module)) then
    raise exception 'Je hebt geen schrijfrechten voor deze kaart.' using errcode = '42501';
  end if;
  if p_scope = 'kind' then
    insert into public.ai_decision_mutes (organization_id, scope, kind, until, created_by)
    values (d.organization_id, 'kind', d.kind, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:kind'
     where organization_id = d.organization_id and kind = d.kind and status in ('open','snoozed');
  elsif p_scope = 'client' then
    if d.client_id is null then raise exception 'Deze kaart hoort niet bij een klant.' using errcode = '22023'; end if;
    insert into public.ai_decision_mutes (organization_id, scope, client_id, until, created_by)
    values (d.organization_id, 'client', d.client_id, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:client'
     where organization_id = d.organization_id and client_id = d.client_id and status in ('open','snoozed');
  elsif p_scope = 'entity' then
    if d.entity_id is null then raise exception 'Deze kaart hoort niet bij een item.' using errcode = '22023'; end if;
    insert into public.ai_decision_mutes (organization_id, scope, entity_type, entity_id, until, created_by)
    values (d.organization_id, 'entity', d.entity_type, d.entity_id, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:entity'
     where organization_id = d.organization_id and entity_id = d.entity_id and status in ('open','snoozed');
  else
    raise exception 'Onbekend bereik: %', p_scope using errcode = '22023';
  end if;
  update public.ai_action_audit a set status = 'cancelled'
   where a.status = 'proposed' and a.id in (
     select x.audit_id from public.ai_decisions x where x.organization_id = d.organization_id and x.status = 'dismissed' and x.resolution like 'muted:%' and x.audit_id is not null
   );
end;
$$;
revoke execute on function public.ai_decision_mute(uuid, text, timestamptz) from public, anon;
grant execute on function public.ai_decision_mute(uuid, text, timestamptz) to authenticated, service_role;

-- ── 13. Digest-push (de veegronde meldt hoeveel er wacht) ─────────────────────
create or replace function public.ai_decision_digest_push(p_org uuid, p_count int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag de digest sturen.' using errcode = '42501';
  end if;
  if p_count is null or p_count <= 0 then return; end if;
  perform public.push_enqueue(
    p_org, 'decision_digest', public.push_org_member_ids(p_org),
    jsonb_build_object(
      'title', 'Gerrie',
      'body', case when p_count = 1 then '1 beslissing wacht op je' else p_count::text || ' beslissingen wachten op je' end,
      'url', '/', 'tag', 'decisions:' || p_org::text));
end;
$$;
revoke execute on function public.ai_decision_digest_push(uuid, int) from public, anon, authenticated;
grant execute on function public.ai_decision_digest_push(uuid, int) to service_role;

-- ── 14. Opruimen ──────────────────────────────────────────────────────────────
create or replace function public.purge_ai_signals()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag opruimen.' using errcode = '42501';
  end if;
  delete from public.ai_signals where status in ('decided','skipped','failed') and updated_at < now() - interval '30 days';
  delete from public.ai_decisions where status in ('done','dismissed','expired') and updated_at < now() - interval '90 days';
end;
$$;
revoke execute on function public.purge_ai_signals() from public, anon, authenticated;
grant execute on function public.purge_ai_signals() to service_role;

commit;
