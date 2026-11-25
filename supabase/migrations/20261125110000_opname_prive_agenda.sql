-- ============================================================
-- ResoFly — Afspraakopnames uit een privé-agenda alleen voor wie die agenda heeft
-- Date: 2026-11-25
--
-- Waarom: wie Agenda kon lezen, kon ook elke afspraakopname van de organisatie
-- lezen: titel, transcript en notulen. Ook die uit de privé-agenda van een
-- collega. In de app zag je die nooit (een opname opent bij een afspraak die je
-- kunt zien, en Inhoud → Meetings filtert sinds vanochtend zelf), maar
-- PostgREST, de API, MCP, Gerrie en de agents gaven ze wel. En de notulen van
-- zo'n meeting kwamen als kaart op de gedeelde beslislijst van Gerrie, en als
-- gebeurtenis bij elke agent van het team.
--
-- De regel (dezelfde als visibleInOverview in de app en recordingVisibleTo in
-- supabase/functions/_shared/recordingPrivacy.ts): een afspraakopname zie je
-- als hij komt uit een agenda die je kunt lezen (je eigen, of een met het team
-- gedeelde: de regel van calendar_sources), als je hem zelf maakte, of als hij
-- al in de gedeelde Inhoud staat (content_note_id). Een telefoongesprek en een
-- notitie-opname horen niet bij een agenda; daar verandert niets. Zonder agenda
-- (de agenda is verwijderd) ziet alleen de maker hem.
--
-- Wat er verandert:
-- 1. my_readable_calendar_source_ids(): de agenda's die de ingelogde gebruiker
--    kan lezen, als lijst. Eén keer per query (een InitPlan), zoals
--    my_organization_ids (20261122200000).
-- 2. Een restrictive leespolicy op meeting_recordings met die regel. De module
--    gate (Agenda, of Inhoud) blijft gewoon gelden.
-- 3. meeting_recording_visible_to(opname, gebruiker): dezelfde regel per rij,
--    voor de triggers hieronder. Zonder gebruiker: is hij met het team gedeeld?
-- 4. Gerrie's beslislijst is van het hele team. Notulen van een meeting uit een
--    privé-agenda worden daarom geen signaal meer (de trigger bij "klaar" en de
--    veegronde voor "nog niet gemaild"). De beslislijst zei anders aan iedereen
--    wat er besproken was en welke actiepunten eruit kwamen.
-- 5. De gebeurtenis "notulen klaar" gaat alleen naar agents van iemand die de
--    opname mag zien (de eigenaar van de agent: run_as_user_id, anders de maker).
-- 6. Wat er op staging al stond: signalen, open kaarten en wachtende
--    gebeurtenissen over meetings uit een privé-agenda gaan dicht, en hun titel,
--    notulen en actiepunten gaan eruit (close_private_meeting_signals).
--
-- Schrijven op meeting_recordings blijft alleen via de service-role.
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ── 1. De agenda's die je kunt lezen ───────────────────────────────────────
-- Dezelfde regel als de policy "calendar sources read own or shared".

create or replace function public.my_readable_calendar_source_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(s.id), '{}'::uuid[])
  from public.calendar_sources s
  where s.user_id = auth.uid()
     or (s.visibility = 'organization'
         and s.organization_id = any (public.my_organization_ids()));
$$;

comment on function public.my_readable_calendar_source_ids() is
  'De agenda''s die de ingelogde gebruiker kan lezen: de eigen en de met het team gedeelde. Voor RLS, als InitPlan.';

revoke all on function public.my_readable_calendar_source_ids() from public, anon;
grant execute on function public.my_readable_calendar_source_ids() to authenticated, service_role;

-- ── 2. Lezen ───────────────────────────────────────────────────────────────

drop policy if exists "prive agenda select" on public.meeting_recordings;
create policy "prive agenda select" on public.meeting_recordings
  as restrictive for select to authenticated
  using (
    note_id is not null
    or call_id is not null
    or content_note_id is not null
    or created_by = (select auth.uid())
    or source_id = any ((select public.my_readable_calendar_source_ids())::uuid[])
  );

-- ── 3. Dezelfde regel per rij, voor de triggers ────────────────────────────

create or replace function public.meeting_recording_visible_to(p_rec public.meeting_recordings, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_rec.note_id is not null
      or p_rec.call_id is not null
      or p_rec.content_note_id is not null
      or (p_user is not null and p_rec.created_by = p_user)
      or exists (
        select 1 from public.calendar_sources s
         where s.id = p_rec.source_id
           and s.organization_id = p_rec.organization_id
           and (s.visibility = 'organization' or (p_user is not null and s.user_id = p_user)));
$$;

comment on function public.meeting_recording_visible_to(public.meeting_recordings, uuid) is
  'Mag deze gebruiker de opname zien? Zonder gebruiker: is hij met het team gedeeld. Zelfde regel als de policy "prive agenda select".';

revoke all on function public.meeting_recording_visible_to(public.meeting_recordings, uuid) from public, anon, authenticated;
grant execute on function public.meeting_recording_visible_to(public.meeting_recordings, uuid) to service_role;

-- ── 4a. Notulen klaar: geen signaal voor een meeting uit een privé-agenda ───
-- Gelijk aan 20260914000000 (8f), met de controle erbij.

create or replace function public.ai_signal_on_meeting_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_items jsonb;
begin
  begin
    if new.status <> 'done' or old.status is not distinct from 'done' then return null; end if;
    -- De beslislijst is van het hele team.
    if not public.meeting_recording_visible_to(new, null) then return null; end if;
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

revoke all on function public.ai_signal_on_meeting_done() from public, anon, authenticated;

-- ── 4b. De veegronde: "nog niet gemaild" ook niet ──────────────────────────
-- Gelijk aan de versie op staging, met de controle in de lus van de notulen.

create or replace function public.collect_time_signals(p_org uuid)
returns integer
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

  -- Notulen klaar maar na een etmaal nog niet gemaild. Niet uit een
  -- privé-agenda: de beslislijst is van het hele team (20261125110000).
  for r in
    select m.id, m.event_title_snapshot, m.client_id, m.project_id, m.updated_at
      from public.meeting_recordings m
     where m.organization_id = p_org and m.status = 'done'
       and m.summary_text is not null and m.summary_sent_at is null
       and m.updated_at < now() - interval '24 hours'
       and m.created_at > now() - interval '30 days'
       and public.meeting_recording_visible_to(m, null)
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

-- Alleen de veegronde zelf (service-role), zoals in 20260914000000.
revoke all on function public.collect_time_signals(uuid) from public, anon, authenticated;
grant execute on function public.collect_time_signals(uuid) to service_role;

-- ── 5. "Notulen klaar" alleen naar agents die de opname mogen zien ─────────
-- Zelfde opbouw als enqueue_agent_event (20261110090000), met per agent de
-- vraag of zijn eigenaar de opname mag zien. Voor een opname uit een gedeelde
-- agenda is dat iedereen, en verandert er niets.

create or replace function public.agent_event_recording_ready()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.note_id is not null or new.status <> 'done' or old.status is not distinct from 'done' then
    return new;
  end if;
  -- Eerst kijken of iemand luistert, buiten het blok met de foutafhandeling
  -- (dat opent een subtransactie).
  if not exists (
    select 1 from public.ai_agents a
     where a.organization_id = new.organization_id
       and a.status = 'active'
       and a.schedule_kind = 'event'
       and 'meeting_recording.ready' = any(a.trigger_events)
  ) then
    return new;
  end if;
  begin
    insert into public.ai_agent_events (organization_id, agent_id, event_type, entity_type, entity_id, summary)
    select a.organization_id, a.id, 'meeting_recording.ready', 'meeting_recording', new.id,
           jsonb_build_object('title', left(coalesce(new.event_title_snapshot, ''), 200),
                              'client_id', new.client_id, 'project_id', new.project_id)
      from public.ai_agents a
     where a.organization_id = new.organization_id
       and a.status = 'active'
       and a.schedule_kind = 'event'
       and 'meeting_recording.ready' = any(a.trigger_events)
       and public.meeting_recording_visible_to(new, coalesce(a.run_as_user_id, a.created_by))
       and (select count(*) from public.ai_agent_events e
             where e.agent_id = a.id and e.status = 'pending') < 200;
  exception when others then
    -- Een agent mag NOOIT het opslaan van een opname laten mislukken.
    raise warning 'agent_event_recording_ready: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.agent_event_recording_ready() from public, anon, authenticated;

-- ── 6. Wat er al stond ─────────────────────────────────────────────────────
-- Als functie, zodat de databasetest hem ook kan draaien
-- (tests/database/opname_prive_agenda.sql). Veilig om opnieuw te draaien.

create or replace function public.close_private_meeting_signals()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Signalen: niet meer verwerken, en titel, notulen en actiepunten eruit.
  update public.ai_signals s
     set status = case when s.status in ('queued', 'claimed') then 'skipped' else s.status end,
         reason = case when s.status in ('queued', 'claimed') then 'Opname uit een privé-agenda.' else s.reason end,
         payload = jsonb_build_object('recording_id', s.entity_id)
    from public.meeting_recordings m
   where s.entity_type = 'meeting_recording'
     and s.entity_id = m.id
     and s.organization_id = m.organization_id
     and s.kind in ('meeting_notes_ready', 'meeting_notes_unsent')
     and not public.meeting_recording_visible_to(m, null)
     and (s.payload <> jsonb_build_object('recording_id', s.entity_id) or s.status in ('queued', 'claimed'));

  -- Kaarten op de beslislijst: open kaarten gaan dicht, en geen enkele kaart
  -- noemt nog wat er besproken is.
  update public.ai_decisions d
     set status = case when d.status in ('open', 'snoozed') then 'expired' else d.status end,
         resolution = case when d.status in ('open', 'snoozed') then 'Opname uit een privé-agenda.' else d.resolution end,
         resolved_at = case when d.status in ('open', 'snoozed') then now() else d.resolved_at end,
         title = 'Notulen van een privé-afspraak',
         summary = '',
         evidence = '[]'::jsonb,
         proposal = null
    from public.meeting_recordings m
   where d.entity_type = 'meeting_recording'
     and d.entity_id = m.id
     and d.organization_id = m.organization_id
     and d.kind in ('meeting_notes_ready', 'meeting_notes_unsent')
     and not public.meeting_recording_visible_to(m, null)
     and (d.title <> 'Notulen van een privé-afspraak' or d.status in ('open', 'snoozed'));

  -- Wachtende gebeurtenissen bij een agent van iemand die de opname niet mag zien.
  update public.ai_agent_events e
     set status = 'skipped',
         summary = '{}'::jsonb,
         processed_at = now()
    from public.meeting_recordings m, public.ai_agents a
   where e.entity_type = 'meeting_recording'
     and e.entity_id = m.id
     and e.organization_id = m.organization_id
     and a.id = e.agent_id
     and e.status in ('pending', 'claimed')
     and not public.meeting_recording_visible_to(m, coalesce(a.run_as_user_id, a.created_by));
end;
$$;

revoke all on function public.close_private_meeting_signals() from public, anon, authenticated;

select public.close_private_meeting_signals();

commit;
