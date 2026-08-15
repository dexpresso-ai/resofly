-- ============================================================
-- ResoFly — het logboek van een agent, en verwijderen = archiveren
-- Date: 2026-08-19
--
-- Tot nu toe hield een agent-run alleen de EINDTEKST bij (`ai_agent_runs.summary`)
-- plus een gesprek met dezelfde tekst erin. Wát de agent onderweg deed — welke
-- gegevens hij ophaalde, met welk filter, hoeveel hij vond, wat hij klaarzette en
-- wat daar uiteindelijk mee gebeurde — verdween. Daarmee kon je achteraf niet
-- verantwoorden wat er namens jou is gebeurd.
--
-- Deze migratie legt dat vast:
--   1. `ai_agent_run_events` — een append-only logboek per run: één rij per stap
--      (start, tool, voorstel, antwoord, bezorging, fout, afronding), met een
--      oplopende `seq` zodat de volgorde vaststaat, ook als twee stappen binnen
--      dezelfde milliseconde landen.
--   2. Verwijderen wordt ARCHIVEREN. `ai_agents.status` kende 'archived' al; wat
--      ontbrak was (a) het moment waarop het gebeurde en (b) een beheerpad dat
--      niet DELETE doet. De runner archiveert voortaan; de historie blijft dus
--      raadpleegbaar. Er is bewust GEEN hard-delete-pad meer.
--   3. Een gearchiveerde agent moet ook een verwijderde MEDEWERKER overleven.
--      `run_as_user_id` was `not null ... on delete cascade`: verdween de auth-
--      gebruiker, dan verdween de agent inclusief zijn hele logboek. Dat wordt
--      nullable + `on delete set null`; de runner pauzeert een agent zonder actor
--      (hij kan zonder identiteit toch niet draaien) maar het logboek blijft.
--
-- Beveiliging: zelfde grens als de rest van de Routines. Lezen mag alleen een
-- actieve owner/admin van dezelfde organisatie; schrijven gebeurt uitsluitend via
-- de service-role in `gerrie-agent-runner` (bewust geen client-write-policies).
-- Kruis-org-integriteit wordt met een trigger afgedwongen, net als bij
-- ai_agent_runs, zodat een verkeerd id nooit een logregel in een andere tenant zet.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Het logboek
-- ------------------------------------------------------------
create table if not exists public.ai_agent_run_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  run_id uuid not null references public.ai_agent_runs(id) on delete cascade,

  -- Oplopend binnen één run: de leesvolgorde staat vast, los van de klok.
  seq int not null check (seq >= 0),

  -- start     — de run begint (opdracht, modus, toegestane tools)
  -- tool       — de agent haalde gegevens op (naam + filter + hoeveel gevonden)
  -- proposal   — de agent zette iets klaar dat op akkoord wacht
  -- answer     — de VOLLEDIGE eindtekst (summary is een afgekapte digest)
  -- delivery   — bezorging (in-app / e-mail)
  -- reply      — iemand antwoordde de agent en hij draaide nog een beurt
  -- error      — er ging iets mis
  -- finish     — afronding met status, tokens en kosten
  kind text not null check (kind in ('start','tool','proposal','answer','delivery','reply','error','finish')),

  -- Eén regel gewone taal; dit is wat de gebruiker in het logboek leest.
  label text not null default '' check (char_length(label) <= 400),
  -- De machineleesbare details (tool-invoer, aantallen, voorstel-id, kosten…).
  detail jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create index if not exists idx_ai_agent_run_events_run
  on public.ai_agent_run_events(run_id, seq);
-- "Wat heeft deze agent ooit gedaan?" — de agentpagina leest per agent, niet per run.
create index if not exists idx_ai_agent_run_events_agent
  on public.ai_agent_run_events(agent_id, created_at desc);

comment on table public.ai_agent_run_events is
  'Append-only logboek per agent-run: elke stap die de agent zette. Blijft bestaan als de agent gearchiveerd wordt.';

-- ------------------------------------------------------------
-- 2. Kruis-org-integriteit (zelfde patroon als ai_agent_runs)
-- ------------------------------------------------------------
create or replace function public.enforce_ai_agent_run_event_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.ai_agents', new.agent_id, new.organization_id, 'ai_agent_run_events.agent_id');
  perform public.assert_same_org_reference('public.ai_agent_runs', new.run_id, new.organization_id, 'ai_agent_run_events.run_id');
  return new;
end;
$$;

drop trigger if exists ai_agent_run_events_org_integrity on public.ai_agent_run_events;
create trigger ai_agent_run_events_org_integrity
  before insert or update of organization_id, agent_id, run_id on public.ai_agent_run_events
  for each row execute function public.enforce_ai_agent_run_event_org_integrity();

-- ------------------------------------------------------------
-- 3. RLS — lezen owner/admin; schrijven alleen service-role
-- ------------------------------------------------------------
alter table public.ai_agent_run_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_agent_run_events' and policyname='ai_agent_run_events read') then
    create policy "ai_agent_run_events read" on public.ai_agent_run_events for select using (
      exists (
        select 1 from public.organization_members m
        where m.organization_id = ai_agent_run_events.organization_id
          and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner','admin')
      )
    );
  end if;
  -- Bewust GEEN insert/update/delete-policies: het logboek is append-only en wordt
  -- uitsluitend door `gerrie-agent-runner` (service-role) geschreven. Een logboek
  -- dat de client kan bijwerken is geen logboek.
end $$;

-- ------------------------------------------------------------
-- 4. Verwijderen = archiveren
-- ------------------------------------------------------------
alter table public.ai_agents
  add column if not exists archived_at timestamptz;

comment on column public.ai_agents.archived_at is
  'Wanneer de agent is gearchiveerd (het "verwijderen" van een agent). Null = niet gearchiveerd. De runs en het logboek blijven bestaan.';

-- Bestaande agents die al op 'archived' staan krijgen alsnog een moment, zodat de
-- app niet hoeft te raden of het archief leeg is of alleen ongedateerd.
update public.ai_agents set archived_at = coalesce(archived_at, updated_at, now())
 where status = 'archived' and archived_at is null;

-- De galerij toont het archief apart; deze index houdt die splitsing goedkoop.
create index if not exists idx_ai_agents_org_archived
  on public.ai_agents(organization_id, archived_at desc)
  where archived_at is not null;

-- ------------------------------------------------------------
-- 5. Het archief overleeft een verwijderde medewerker
-- ------------------------------------------------------------
-- Was: not null + on delete cascade — met de auth-gebruiker verdween de hele agent
-- inclusief runs en logboek. Nu: nullable + on delete set null. De runner weigert
-- te draaien zonder actor (en pauzeert de agent), dus dit verzwakt de identiteits-
-- eis niet; het voorkomt alleen dat de verantwoording verdwijnt.
alter table public.ai_agents alter column run_as_user_id drop not null;

-- De oude sleutel op naam droppen zou stilzwijgend mislukken als hij anders heet;
-- dan bleef de CASCADE naast de nieuwe regel staan en won de CASCADE alsnog.
-- Daarom elke foreign key op deze kolom opzoeken en weghalen.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum = any (c.conkey)
     where c.conrelid = 'public.ai_agents'::regclass
       and c.contype = 'f'
       and a.attname = 'run_as_user_id'
  loop
    execute format('alter table public.ai_agents drop constraint %I', v_name);
  end loop;
end $$;

alter table public.ai_agents
  add constraint ai_agents_run_as_user_id_fkey
  foreign key (run_as_user_id) references auth.users(id) on delete set null;

comment on column public.ai_agents.run_as_user_id is
  'De identiteit waaronder de agent draait. Null = de medewerker bestaat niet meer; de runner draait dan niet en pauzeert de agent, maar het logboek blijft raadpleegbaar.';

commit;
