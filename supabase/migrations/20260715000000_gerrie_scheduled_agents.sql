-- ============================================================
-- ResoFly — Gerrie Routines (gebruikers bouwen eigen geplande agents) — fase 1
-- Date: 2026-07-15
--
-- Een "Routine" is een opgeslagen, terugkerende Gerrie-run. Een gebruiker geeft in
-- gewone taal een opdracht ("elke maandag: overzicht openstaande facturen"), een
-- schema (dagelijks/wekelijks/maandelijks) en een modus. De headless Edge Function
-- `gerrie-agent-runner` draait de agent op de geplande tijd via HETZELFDE brein als
-- de chat (../functions/_shared/gerrieCore.ts).
--
-- Veiligheidsinvariant (v1): een geplande agent voert NOOIT onbewaakt schrijf-acties
-- uit. Twee modi:
--   * report  — alleen lees-tools, volledig autonoom, levert een samenvatting.
--   * propose — mag daarnaast één actie VOORSTELLEN; die landt (net als in de chat)
--               in ai_action_audit met status 'proposed' en wordt pas uitgevoerd als
--               een mens hem in de app goedkeurt (confirmGerrieAction, eigen sessie).
-- De kolom tool_autonomy is er wél alvast (tool -> 'propose'|'auto') zodat latere,
-- streng-begrensde auto-uitvoering GEEN migratie kost; de runner dwingt in v1
-- 'propose' af.
--
-- Scheduling: pg_cron → gerrie-agent-runner?cron=tick (operator-stap, secret buiten
-- de migratie — zie GERRIE_ROUTINES_SETUP.md). Zelfde lease-/claim-patroon als de
-- e-mailstromen (claim_due_flow_enrollments) en de web-push-drain.
--
-- Beveiliging:
-- - Alles org-scoped met RLS. LEZEN mag alleen owner/admin (v1 is een owner/admin-
--   feature, net als het AI-actie-audit). SCHRIJVEN gebeurt uitsluitend via de
--   service-role in de Edge Function; er zijn bewust GEEN client-write-policies.
-- - De runner draait als service-role (RLS uit): organization_id komt ALTIJD uit
--   ai_agents.organization_id, nooit uit het model. De claim-RPC is service-role-only.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Agent-definities
-- ------------------------------------------------------------
create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- De ACTOR: rol + maandbudget worden tijdens een (onbewaakte) run van deze
  -- identiteit afgeleid, want er is geen live sessie. Verliest deze gebruiker zijn
  -- lidmaatschap, dan pauzeert de runner de agent i.p.v. onattribueerbaar te draaien.
  -- Wordt de auth-gebruiker zelf verwijderd, dan vervalt de agent (kan zonder actor
  -- toch niet draaien) — cascade voorkomt zowel dangling agents als een geblokkeerde
  -- gebruikersverwijdering.
  run_as_user_id uuid not null references auth.users(id) on delete cascade,

  name text not null default '',
  description text,
  -- Opdracht in gewone taal (zoals een chatbericht aan Gerrie).
  instruction text not null default '' check (char_length(instruction) <= 4000),

  -- 'cheap' (Haiku) is standaard voor geplande overzichten; 'strong' (Sonnet) kan.
  model_kind text not null default 'cheap' check (model_kind in ('cheap','strong')),
  -- v1-autonomie: report = alleen lezen; propose = mag voorstellen (goedkeurwachtrij).
  mode text not null default 'report' check (mode in ('report','propose')),

  -- Allowlist van échte TOOL_DEFINITIONS-namen. Leeg = de standaard lees-set die de
  -- runner hanteert (search_clients/list_invoices/list_due_reminders/…).
  enabled_tools text[] not null default '{}',
  -- tool -> 'propose'|'auto'. v1: de runner dwingt 'propose' af, ongeacht deze waarde.
  -- Bestaat nu al zodat latere auto-uitvoering geen schema-wijziging nodig heeft.
  tool_autonomy jsonb not null default '{}'::jsonb,

  -- Schema (v1: presets). schedule_cron is GERESERVEERD voor latere RRULE/cron.
  schedule_kind text not null default 'weekly' check (schedule_kind in ('daily','weekly','monthly')),
  hour int not null default 8 check (hour between 0 and 23),
  day_of_week int check (day_of_week between 1 and 7),      -- ISO: 1=ma..7=zo (weekly)
  day_of_month int check (day_of_month between 1 and 31),   -- (monthly)
  schedule_cron text,
  timezone text not null default 'Europe/Amsterdam',

  status text not null default 'draft' check (status in ('draft','active','paused','archived')),

  -- Planning-runtime. lease_until staat LOS van next_run_at zodat het claimen (lease)
  -- het echte schema nooit verschuift.
  next_run_at timestamptz,
  lease_until timestamptz,
  last_run_at timestamptz,

  -- Onbewaakt-veiligheid (verplichte plafonds).
  max_iterations int not null default 8 check (max_iterations between 1 and 12),
  max_cost_eur_per_run numeric(10,2) not null default 0.25 check (max_cost_eur_per_run >= 0),
  monthly_budget_eur numeric(10,2) check (monthly_budget_eur is null or monthly_budget_eur >= 0),
  max_runs_per_day int not null default 4 check (max_runs_per_day between 1 and 48),
  consecutive_failures int not null default 0,  -- circuit breaker

  -- Bezorging: {channels:['inapp','email'], recipient_user_ids:[…]}.
  delivery jsonb not null default '{"channels":["inapp"],"recipient_user_ids":[]}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. Run-historie (+ idempotente slot-sleutel)
-- ------------------------------------------------------------
create table if not exists public.ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  triggered_by text not null default 'schedule' check (triggered_by in ('schedule','manual','retry')),
  status text not null default 'claimed'
    check (status in ('claimed','running','succeeded','failed','partial','skipped_budget','cancelled')),
  -- Idempotentie: het geplande tijdslot (ISO). UNIQUE(agent_id, occurrence_key) zorgt
  -- dat een dubbele cron-tik hetzelfde slot niet dubbel draait.
  occurrence_key text not null,
  -- Eén los gesprek per run (transcript), titel 'Agent: <naam> — <datum>'.
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  attempts int not null default 0,
  summary text,                 -- de bezorgde digest
  result jsonb,                 -- tool-acties + voorstel-id's
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10,4) not null default 0,
  proposals_created int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, occurrence_key)
);

-- ------------------------------------------------------------
-- 3. Indexen
-- ------------------------------------------------------------
create index if not exists idx_ai_agents_org_status
  on public.ai_agents(organization_id, status, created_at desc);
-- Goedkope scan voor de agents-cron: actieve agents die nu aan de beurt zijn.
create index if not exists idx_ai_agents_due
  on public.ai_agents(next_run_at)
  where status = 'active' and next_run_at is not null;
create index if not exists idx_ai_agent_runs_agent
  on public.ai_agent_runs(agent_id, created_at desc);
create index if not exists idx_ai_agent_runs_org
  on public.ai_agent_runs(organization_id, created_at desc);

-- ------------------------------------------------------------
-- 4. updated_at + org-lock + org-integriteit
-- ------------------------------------------------------------
drop trigger if exists ai_agents_updated on public.ai_agents;
create trigger ai_agents_updated before update on public.ai_agents
  for each row execute function public.set_updated_at();
drop trigger if exists ai_agents_prevent_org_change on public.ai_agents;
create trigger ai_agents_prevent_org_change before update of organization_id on public.ai_agents
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists ai_agent_runs_updated on public.ai_agent_runs;
create trigger ai_agent_runs_updated before update on public.ai_agent_runs
  for each row execute function public.set_updated_at();

-- Kruis-org-integriteit: een run verwijst alleen naar een agent (+ optioneel gesprek)
-- uit dezelfde organisatie. Voorkomt dat een verkeerd id een run in een andere tenant zet.
create or replace function public.enforce_ai_agent_run_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.ai_agents', new.agent_id, new.organization_id, 'ai_agent_runs.agent_id');
  if new.conversation_id is not null then
    perform public.assert_same_org_reference('public.ai_conversations', new.conversation_id, new.organization_id, 'ai_agent_runs.conversation_id');
  end if;
  return new;
end;
$$;

drop trigger if exists ai_agent_runs_org_integrity on public.ai_agent_runs;
create trigger ai_agent_runs_org_integrity
  before insert or update of organization_id, agent_id, conversation_id on public.ai_agent_runs
  for each row execute function public.enforce_ai_agent_run_org_integrity();

-- ------------------------------------------------------------
-- 5. RLS — lezen alleen owner/admin; schrijven uitsluitend via de service-role
-- ------------------------------------------------------------
alter table public.ai_agents enable row level security;
alter table public.ai_agent_runs enable row level security;

do $$
begin
  -- Owner/admin-only lezen (v1 is een owner/admin-feature; net als ai_action_audit).
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_agents' and policyname='ai_agents read') then
    create policy "ai_agents read" on public.ai_agents for select using (
      exists (
        select 1 from public.organization_members m
        where m.organization_id = ai_agents.organization_id
          and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner','admin')
      )
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_agent_runs' and policyname='ai_agent_runs read') then
    create policy "ai_agent_runs read" on public.ai_agent_runs for select using (
      exists (
        select 1 from public.organization_members m
        where m.organization_id = ai_agent_runs.organization_id
          and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner','admin')
      )
    );
  end if;
  -- Bewust GEEN insert/update/delete-policies: alle mutatie loopt via
  -- gerrie-agent-runner (service-role), zoals ai_conversations/ai_messages.
end $$;

-- ------------------------------------------------------------
-- 6. Koppel agent-verbruik + audit + gesprekken aan een run
-- ------------------------------------------------------------
-- Verbruik: rijen dragen nog steeds user_id (= run_as_user_id), dus het bestaande
-- per-gebruiker maandbudget (checkUserBudget) dekt agent-uitgaven automatisch.
alter table public.ai_usage        add column if not exists agent_id uuid references public.ai_agents(id) on delete set null;
alter table public.ai_usage        add column if not exists agent_run_id uuid references public.ai_agent_runs(id) on delete set null;

-- Voorstellen van een agent belanden in dezelfde goedkeurwachtrij als chat-voorstellen.
alter table public.ai_action_audit add column if not exists agent_id uuid references public.ai_agents(id) on delete set null;
alter table public.ai_action_audit add column if not exists agent_run_id uuid references public.ai_agent_runs(id) on delete set null;
-- Sluit de status-drift (was vrije tekst). NOT VALID: dwingt af op NIEUWE rijen zonder
-- bestaande rijen te herkeuren (veilig op een live tabel).
alter table public.ai_action_audit drop constraint if exists ai_action_audit_status_check;
alter table public.ai_action_audit add constraint ai_action_audit_status_check
  check (status in ('proposed','confirmed','executed','failed','cancelled','auto_executed')) not valid;

-- Per-run transcript hangt aan een los gesprek (ai_messages ongewijzigd).
alter table public.ai_conversations add column if not exists agent_id uuid references public.ai_agents(id) on delete set null;
alter table public.ai_conversations add column if not exists agent_run_id uuid references public.ai_agent_runs(id) on delete set null;

create index if not exists idx_ai_usage_agent on public.ai_usage(agent_id) where agent_id is not null;
create index if not exists idx_ai_action_audit_agent_run on public.ai_action_audit(agent_run_id) where agent_run_id is not null;

-- ------------------------------------------------------------
-- 7. RPC: due agents claimen (agents-cron)
-- ------------------------------------------------------------
-- Lease-patroon (kopie van claim_due_flow_enrollments): schuif lease_until 10 min
-- vooruit onder for-update-skip-locked, zodat overlappende cron-ticks dezelfde agent
-- niet dubbel draaien en een gecrashte run na 10 min vanzelf opnieuw wordt opgepakt.
-- lease_until staat LOS van next_run_at, dus het echte schema blijft intact tot de
-- runner na afloop de nieuwe next_run_at berekent. Klein plafond: elke rij draait een
-- LLM-tool-loop binnen de edge-wallclock; de volgende minuut-tik pakt de rest op.
create or replace function public.claim_due_agents(p_limit integer default 5)
returns setof public.ai_agents
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag agents claimen.' using errcode = '42501';
  end if;

  return query
  update public.ai_agents a
     set lease_until = now() + interval '10 minutes',
         updated_at = now()
   where a.id in (
     select x.id
       from public.ai_agents x
      where x.status = 'active'
        and x.next_run_at is not null
        and x.next_run_at <= now()
        and (x.lease_until is null or x.lease_until < now())
      order by x.next_run_at
      limit greatest(1, least(p_limit, 5))
      for update skip locked
   )
   returning a.*;
end;
$$;

revoke execute on function public.claim_due_agents(integer) from public, anon, authenticated;
grant execute on function public.claim_due_agents(integer) to service_role;

commit;
