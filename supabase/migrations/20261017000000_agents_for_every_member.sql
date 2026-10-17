-- ============================================================
-- ResoFly — Agents voor ieder teamlid, met precies zijn eigen rechten
-- Date: 2026-10-17
--
-- Geplande agents (ai_agents) waren een owner/admin-feature: alleen zij konden
-- ze maken, zien en hun voorstellen goedkeuren. Een member die Gerrie in de chat
-- vroeg "doe dit elke maandag", kreeg een agentkaart die bij het aanmaken vastliep
-- op "Alleen owners en admins kunnen Routines beheren".
--
-- Vanaf nu kan iedereen die Gerrie mag gebruiken eigen agents hebben. De regel
-- waar alles om draait: een agent kan nooit meer dan degene namens wie hij
-- draait (run_as_user_id).
--   - Wat hij mag lezen en klaarzetten volgt de modulerechten van die persoon;
--     de runner controleert dat bij het opslaan én bij elke run opnieuw
--     (_shared/agentAccess.ts, gerrieCore).
--   - Wie zelf alleen mag lezen (viewer, of Gerrie op "lezen"), krijgt een agent
--     die alleen meekijkt.
--   - Wat een agent klaarzet, voert de eigenaar daarna uit in de app, onder zijn
--     eigen sessie, met RLS en modulepoorten. Er komt geen pad bij waarlangs iets
--     zonder menselijke klik gebeurt.
--
-- Deze migratie:
--   1. Nieuwe kolommen: minuut en eind-uur (ritmes "elke werkdag" en "elk uur"),
--      een plafond op voorstellen per run, delen met het team, en waar een
--      gekopieerde agent vandaan kwam.
--   2. LEZEN: een teamlid ziet zijn eigen agents, runs, logboek en voorstellen;
--      owners/admins blijven alles zien (toezicht). Een gedeelde agent
--      (visibility = 'team') is voor het team zichtbaar als startpunt — zijn runs
--      en logboek blijven van de eigenaar.
--   3. BESLISSEN: ai_action_decide laat een teamlid beslissen over de voorstellen
--      van zijn EIGEN agent. Gekoppelde AI, API-sleutels en signalen blijven bij
--      owners/admins.
--   4. CLAIMEN: tot tien agents per minuut-tik — meer mensen, meer agents.
--   5. PUSH: 'agent_run' — de eigenaar hoort het als zijn agent iets klaarzette of
--      een overzicht klaar heeft. Op vijf plekken tegelijk: beide CHECKs hier,
--      PushEventType + PUSH_EVENTS in src/lib/push-api.ts, en NOTIFICATION_EVENTS
--      in _shared/actions/admin.ts (agentAccess.test.ts bewaakt dat).
--
-- Schrijven blijft uitsluitend via de service-role in gerrie-agent-runner; er
-- komen bewust geen client-write-policies bij.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Kolommen ─────────────────────────────────────────────────────────────

alter table public.ai_agents
  add column if not exists minute smallint not null default 0
    check (minute between 0 and 59);

-- Alleen bij 'hourly': het laatste uur van het venster (de runner houdt het ≥ hour).
alter table public.ai_agents
  add column if not exists end_hour smallint
    check (end_hour is null or end_hour between 0 and 23);

alter table public.ai_agents
  add column if not exists max_proposals_per_run int not null default 3
    check (max_proposals_per_run between 1 and 10);

alter table public.ai_agents
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'team'));

alter table public.ai_agents
  add column if not exists copied_from uuid references public.ai_agents(id) on delete set null;

comment on column public.ai_agents.minute is
  'Minuut binnen het uur waarop de agent draait (0-59), in de wandklok van timezone.';
comment on column public.ai_agents.end_hour is
  'Alleen bij schedule_kind = hourly: het laatste uur van het venster (elk uur van hour t/m end_hour, op werkdagen).';
comment on column public.ai_agents.max_proposals_per_run is
  'Hoeveel dingen één run hoogstens mag klaarzetten (propose). Elk voorstel wacht op het akkoord van de eigenaar.';
comment on column public.ai_agents.visibility is
  'private = alleen de eigenaar (en owners/admins); team = zichtbaar voor het team als startpunt voor een eigen kopie. Runs en logboek blijven van de eigenaar.';
comment on column public.ai_agents.copied_from is
  'De agent waar deze een kopie van is (een gedeeld startpunt). Een kopie draait met de rechten van wie hem maakte.';

-- Twee ritmes erbij: elke werkdag, en elk uur op werkdagen. De bestaande
-- constraint opzoeken op inhoud (de naam is niet gegarandeerd) en vervangen.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.ai_agents'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%schedule_kind%'
  loop
    execute format('alter table public.ai_agents drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.ai_agents
  add constraint ai_agents_schedule_kind_check
  check (schedule_kind in ('daily', 'weekdays', 'weekly', 'monthly', 'hourly'));

comment on column public.ai_agents.model_kind is
  'strong = Claude Sonnet 5.5 dat grondig nadenkt (effort medium); cheap = hetzelfde model dat kort nadenkt (effort low). Het model zelf staat in de secrets GERRIE_MODEL / GERRIE_CHEAP_MODEL.';

-- Een kopie verwijst alleen naar een agent uit dezelfde organisatie.
create or replace function public.enforce_ai_agent_copy_org_integrity()
returns trigger
language plpgsql
as $$
begin
  if new.copied_from is not null then
    perform public.assert_same_org_reference('public.ai_agents', new.copied_from, new.organization_id, 'ai_agents.copied_from');
  end if;
  return new;
end;
$$;

drop trigger if exists ai_agents_copy_org_integrity on public.ai_agents;
create trigger ai_agents_copy_org_integrity
  before insert or update of organization_id, copied_from on public.ai_agents
  for each row execute function public.enforce_ai_agent_copy_org_integrity();

-- "Mijn agents" en "gedeeld door het team" zijn de twee vragen die de app stelt.
create index if not exists idx_ai_agents_owner
  on public.ai_agents(organization_id, run_as_user_id)
  where archived_at is null;
create index if not exists idx_ai_agents_team
  on public.ai_agents(organization_id)
  where visibility = 'team' and archived_at is null;

-- ── 2. Lezen ────────────────────────────────────────────────────────────────
--
-- De restrictive modulepoort op ai_agents, ai_agent_runs en ai_action_audit
-- (module Gerrie, 20260730100000) blijft gewoon gelden: wie Gerrie dicht heeft
-- staan, ziet hier niets, ook niet van zichzelf. Het logboek kwam later en heeft
-- die poort niet; daar staat hij daarom in de policy zelf.

drop policy if exists "ai_agents read" on public.ai_agents;
create policy "ai_agents read" on public.ai_agents for select using (
  exists (
    select 1 from public.organization_members m
     where m.organization_id = ai_agents.organization_id
       and m.user_id = auth.uid() and m.status = 'active'
       and (
         m.role in ('owner', 'admin')
         or ai_agents.run_as_user_id = auth.uid()
         or ai_agents.created_by = auth.uid()
         -- Gedeeld als startpunt: het hele team (niet de boekhouder-gast).
         or (ai_agents.visibility = 'team' and ai_agents.archived_at is null
             and m.role in ('member', 'viewer'))
       )
  )
);

drop policy if exists "ai_agent_runs read" on public.ai_agent_runs;
create policy "ai_agent_runs read" on public.ai_agent_runs for select using (
  exists (
    select 1 from public.organization_members m
     where m.organization_id = ai_agent_runs.organization_id
       and m.user_id = auth.uid() and m.status = 'active'
       and (
         m.role in ('owner', 'admin')
         or exists (
           select 1 from public.ai_agents a
            where a.id = ai_agent_runs.agent_id and a.run_as_user_id = auth.uid()
         )
       )
  )
);

drop policy if exists "ai_agent_run_events read" on public.ai_agent_run_events;
create policy "ai_agent_run_events read" on public.ai_agent_run_events for select using (
  public.can_read_module(ai_agent_run_events.organization_id, 'gerrie')
  and exists (
    select 1 from public.organization_members m
     where m.organization_id = ai_agent_run_events.organization_id
       and m.user_id = auth.uid() and m.status = 'active'
       and (
         m.role in ('owner', 'admin')
         or exists (
           select 1 from public.ai_agents a
            where a.id = ai_agent_run_events.agent_id and a.run_as_user_id = auth.uid()
         )
       )
  )
);

-- Het auditspoor: owners/admins alles, een teamlid zijn eigen regels — wat er op
-- zijn naam is voorgesteld, door zijn chat of door zijn eigen agents.
drop policy if exists "ai_action_audit read" on public.ai_action_audit;
create policy "ai_action_audit read" on public.ai_action_audit for select using (
  exists (
    select 1 from public.organization_members m
     where m.organization_id = ai_action_audit.organization_id
       and m.user_id = auth.uid() and m.status = 'active'
       and (m.role in ('owner', 'admin') or ai_action_audit.user_id = auth.uid())
  )
);

-- ── 3. Beslissen ────────────────────────────────────────────────────────────
--
-- Zoals in 20261003050000, met één tak erbij: een voorstel van een geplande
-- agent. Daarover beslist de eigenaar van die agent (naast owners/admins): de
-- agent draaide met zijn rechten, het voorstel staat op zijn naam (user_id), en
-- uitvoeren gebeurt straks onder zijn eigen sessie. Hij moet daarvoor Gerrie op
-- "volledig" hebben — dezelfde eis als voor een agent die iets mag klaarzetten.
-- Een voorstel van een gekoppelde AI, een API-sleutel of een signaal blijft bij
-- owners en admins.
create or replace function public.ai_action_decide(
  p_audit_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_outcome text,
  p_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row      public.ai_action_audit%rowtype;
  v_role     text;
  v_access   jsonb;
  v_module   text;
  v_outcome  text := p_outcome;
  v_claimer  uuid;
  v_until    timestamptz;
  v_detail   text;
  v_status   text;
  v_revoked  timestamptz;
  v_rejected constant text := 'Afgewezen door gebruiker.';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server legt een beslissing vast.' using errcode = '42501';
  end if;
  if v_outcome is null or v_outcome not in ('claim', 'executed', 'failed', 'rejected') then
    raise exception 'Onbekende uitkomst: %.', coalesce(v_outcome, 'leeg') using errcode = '22023';
  end if;

  v_detail := nullif(btrim(left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 500)), '');
  -- Een oudere app meldt een afwijzing als "mislukt" met deze zin.
  if v_outcome = 'failed' and v_detail = v_rejected then v_outcome := 'rejected'; end if;

  select m.role, coalesce(m.module_access, '{}'::jsonb) into v_role, v_access
    from public.organization_members m
   where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    raise exception 'Je hebt geen schrijfrechten in deze organisatie.' using errcode = '42501';
  end if;

  select * into v_row
    from public.ai_action_audit
   where id = p_audit_id and organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Dit voorstel bestaat niet in deze organisatie.' using errcode = 'P0002';
  end if;

  if v_role not in ('owner', 'admin') then
    if v_row.signal_id is not null and v_row.agent_id is null and v_row.agent_run_id is null
       and v_row.mcp_grant_id is null and v_row.api_key_id is null then
      -- Een kaart uit de Beslissingen-feed: dezelfde regel als de feed zelf.
      select d.module into v_module
        from public.ai_decisions d
       where d.audit_id = v_row.id and d.organization_id = p_organization_id
       order by d.created_at desc
       limit 1;
      if v_module is null
         or coalesce(nullif(v_access ->> 'gerrie', ''), 'write') = 'none'
         or coalesce(nullif(v_access ->> v_module, ''), 'write') <> 'write' then
        raise exception 'Over dit voorstel beslist wie de module van de kaart mag wijzigen, of een owner of admin.'
          using errcode = '42501';
      end if;
    elsif (v_row.agent_id is not null or v_row.agent_run_id is not null)
          and v_row.mcp_grant_id is null and v_row.api_key_id is null and v_row.signal_id is null then
      -- Een voorstel van een geplande agent: de eigenaar van die agent beslist.
      if v_row.user_id is distinct from p_user_id
         or coalesce(nullif(v_access ->> 'gerrie', ''), 'write') <> 'write'
         or not exists (
           select 1 from public.ai_agents a
            where a.id = v_row.agent_id and a.organization_id = p_organization_id and a.run_as_user_id = p_user_id
         ) then
        raise exception 'Over dit voorstel beslist de eigenaar van de agent, of een owner of admin.'
          using errcode = '42501';
      end if;
    elsif v_row.agent_id is not null or v_row.agent_run_id is not null or v_row.mcp_grant_id is not null
          or v_row.api_key_id is not null or v_row.signal_id is not null
          or v_row.user_id is distinct from p_user_id then
      raise exception 'Over dit voorstel beslist een owner of admin.' using errcode = '42501';
    end if;
  end if;

  if not (v_row.status = 'proposed'
          or (v_row.status = 'failed' and coalesce(v_row.result ->> 'decision', '') = 'failed')) then
    raise exception 'Dit voorstel is al afgehandeld.' using errcode = 'RS409';
  end if;

  v_claimer := nullif(v_row.result ->> 'claimed_by', '')::uuid;
  v_until := nullif(v_row.result ->> 'claimed_until', '')::timestamptz;
  if v_claimer is not null and v_claimer <> p_user_id and v_until > now() then
    raise exception 'Iemand anders voert dit voorstel op dit moment uit. Probeer het over een paar minuten opnieuw.'
      using errcode = 'RS409';
  end if;

  if v_outcome = 'claim' then
    -- Een voorstel van een ingetrokken sleutel voert niemand meer uit. Afwijzen
    -- mag wel, en wie het al uitvoerde, meldt zijn uitkomst gewoon.
    if v_row.api_key_id is not null then
      select k.revoked_at into v_revoked from public.api_keys k where k.id = v_row.api_key_id;
      if v_revoked is not null then
        raise exception 'De API-sleutel achter dit voorstel is ingetrokken; het wordt niet meer uitgevoerd.'
          using errcode = 'RS409';
      end if;
    end if;
    update public.ai_action_audit
       set result = coalesce(result, '{}'::jsonb)
                 || jsonb_build_object('claimed_by', p_user_id, 'claimed_until', now() + interval '10 minutes')
     where id = v_row.id;
    return jsonb_build_object('status', v_row.status, 'claimed_until', now() + interval '10 minutes')
      || case when v_claimer is not null and v_until <= now()
              then jsonb_build_object('stale_claim', jsonb_build_object('by', v_claimer, 'until', v_until))
              else '{}'::jsonb end;
  end if;

  v_status := case when v_outcome = 'executed' then 'executed' else 'failed' end;
  update public.ai_action_audit
     set status = v_status,
         result = (coalesce(result, '{}'::jsonb) - 'claimed_by' - 'claimed_until' - 'detail' - 'ok')
               || jsonb_build_object('ok', v_outcome = 'executed', 'decision', v_outcome,
                                     'decided_by', p_user_id, 'decided_at', now())
               || case
                    when v_outcome = 'rejected' then jsonb_build_object('detail', v_rejected)
                    when v_detail is not null then jsonb_build_object('detail', v_detail)
                    else '{}'::jsonb
                  end
   where id = v_row.id;
  return jsonb_build_object('status', v_status, 'decision', v_outcome);
end;
$$;

revoke all on function public.ai_action_decide(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ai_action_decide(uuid, uuid, uuid, text, text) to service_role;

-- ── 4. Claimen ──────────────────────────────────────────────────────────────
--
-- Zoals in 20260715000000, met een plafond van tien in plaats van vijf. De
-- runner draait de geclaimde agents nu naast elkaar in plaats van na elkaar, dus
-- een tik duurt zo lang als de langzaamste agent en niet als alle samen.
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
      limit greatest(1, least(p_limit, 10))
      for update skip locked
   )
   returning a.*;
end;
$$;

revoke execute on function public.claim_due_agents(integer) from public, anon, authenticated;
grant execute on function public.claim_due_agents(integer) to service_role;

-- ── 5. Push: 'agent_run' ────────────────────────────────────────────────────
--
-- De volledige lijst uit 20261013100000, plus 'agent_run'.
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
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox','file_transfer_downloaded','agent_run'));
alter table public.notification_preferences add constraint notification_preferences_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox','file_transfer_downloaded','agent_run'));

-- Na een run met iets te melden: één melding aan de EIGENAAR van de agent — niet
-- aan het team. Wie de melding krijgt, komt uit de database (run → agent →
-- run_as_user_id), niet van de aanroeper. Eén tag per agent: drie runs achter
-- elkaar worden één melding die zichzelf bijwerkt.
create or replace function public.ai_agent_run_push(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run   public.ai_agent_runs%rowtype;
  v_agent public.ai_agents%rowtype;
  v_body  text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server meldt een agent-run.' using errcode = '42501';
  end if;

  select * into v_run from public.ai_agent_runs where id = p_run_id;
  if not found then return; end if;
  select * into v_agent from public.ai_agents
   where id = v_run.agent_id and organization_id = v_run.organization_id;
  if not found or v_agent.run_as_user_id is null then return; end if;

  v_body := case
    when v_run.proposals_created > 0 then
      v_run.proposals_created::text
        || case when v_run.proposals_created = 1 then ' voorstel wacht' else ' voorstellen wachten' end
        || ' op je akkoord'
    else coalesce(nullif(btrim(left(regexp_replace(coalesce(v_run.summary, ''), '\s+', ' ', 'g'), 160)), ''), 'Je agent is klaar.')
  end;

  perform public.push_enqueue(
    v_run.organization_id, 'agent_run', array[v_agent.run_as_user_id],
    jsonb_build_object(
      'title', coalesce(nullif(btrim(v_agent.name), ''), 'Je agent'),
      'body',  v_body,
      'url',   '/?agent=' || v_agent.id::text,
      'tag',   'agent:' || v_agent.id::text));
end;
$$;

revoke execute on function public.ai_agent_run_push(uuid) from public, anon, authenticated;
grant execute on function public.ai_agent_run_push(uuid) to service_role;

commit;
