-- ============================================================
-- ResoFly — Goedkeuren op de server, een limiet per adres, en opruimen
-- Date: 2026-10-03
--
-- Aanleiding: de restpunten uit de veiligheidstest van de openbare API.
--
--   1. GOEDKEUREN. De browser voert een voorstel uit (onder de sessie van het
--      teamlid, met RLS) en meldde daarna via `gerrie-agent` "uitgevoerd" of
--      "mislukt". Die melding zette met de service-role ELKE auditregel van de
--      organisatie op elke status: ook een rechtstreekse uitvoering van een
--      API-sleutel achteraf op "mislukt", een ingetrokken voorstel op
--      "uitgevoerd", en een teamlid kon over voorstellen beslissen die alleen
--      owners/admins te zien krijgen. Wie besliste, werd niet bewaard. Nu:
--        - ai_action_decide(): één plek die beslist, met de regels erin — alleen
--          wat nog open staat, alleen wie erover gaat, met naam en tijd;
--        - eerst VASTZETTEN (claim), dan uitvoeren, dan de uitkomst: twee
--          beheerders die tegelijk op Akkoord klikken, voeren hetzelfde voorstel
--          niet allebei uit;
--        - een trigger die een afgehandelde auditregel niet meer laat
--          herschrijven, langs welke weg dan ook (ook de service-role).
--   2. LIMIET PER ADRES. Een sleutel die niet bestaat of niet klopt, kostte
--      onbeperkt opzoekingen. Mislukte pogingen tellen nu per afzender (gehasht);
--      boven de grens volgt 429 — maar een GELDIGE sleutel werkt altijd door,
--      zodat een koppeling op een gedeeld adres (Zapier, Make) niet geraakt wordt
--      door een buurman met een verkeerde sleutel.
--   3. OPRUIMEN. Een dagelijkse pg_cron-taak voor api_purge_expired() en
--      webhook_purge_expired(), als pg_cron aan staat.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1a. Een afgehandelde auditregel ligt vast ───────────────────────────────
--
-- Wat er voorgesteld werd (params), door wie en via welke weg, verandert nooit;
-- een verwijzing mag alleen leeg worden (on delete set null van een agent,
-- sleutel of gesprek). De uitkomst wordt één keer gezet: daarna niet meer.
-- Open zijn alleen 'proposed' en een uitvoering die via ai_action_decide
-- mislukte (die mag opnieuw, of alsnog worden afgewezen).
create or replace function public.ai_action_audit_guard_update()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.action is distinct from old.action
     or new.params is distinct from old.params
     or new.created_at is distinct from old.created_at
     or (new.user_id is distinct from old.user_id and new.user_id is not null)
     or (new.conversation_id is distinct from old.conversation_id and new.conversation_id is not null)
     or (new.message_id is distinct from old.message_id and new.message_id is not null)
     or (new.agent_id is distinct from old.agent_id and new.agent_id is not null)
     or (new.agent_run_id is distinct from old.agent_run_id and new.agent_run_id is not null)
     or (new.signal_id is distinct from old.signal_id and new.signal_id is not null)
     or (new.mcp_grant_id is distinct from old.mcp_grant_id and new.mcp_grant_id is not null)
     or (new.api_key_id is distinct from old.api_key_id and new.api_key_id is not null) then
    raise exception 'Een voorstel in het auditlog verandert niet; alleen de uitkomst wordt erbij gezet.'
      using errcode = '42501';
  end if;

  if (old.status in ('executed', 'auto_executed', 'cancelled', 'confirmed')
      or (old.status = 'failed' and coalesce(old.result ->> 'decision', '') <> 'failed'))
     and (new.status is distinct from old.status or new.result is distinct from old.result) then
    raise exception 'Dit voorstel is al afgehandeld (%); die uitkomst ligt vast.', old.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_action_audit_guard_update on public.ai_action_audit;
create trigger ai_action_audit_guard_update
  before update on public.ai_action_audit
  for each row execute function public.ai_action_audit_guard_update();

-- ── 1b. Beslissen over een voorstel ─────────────────────────────────────────
--
-- p_outcome:
--   'claim'    — vastzetten vóór het uitvoeren (10 minuten; dezelfde persoon
--                mag verlengen). Een ander kan dan niet beslissen.
--   'executed' — de browser voerde het uit.
--   'failed'   — het uitvoeren mislukte; het voorstel blijft open voor een
--                nieuwe poging of afwijzen.
--   'rejected' — afgewezen; dat is definitief.
--
-- Wie: een owner of admin over alles in de organisatie (zij zien de
-- goedkeurwachtrij); een teamlid alleen over zijn eigen chatvoorstel. Wat een
-- agent, gekoppelde AI, API-sleutel of signaal klaarzette, wacht op een owner of
-- admin — precies wie het in de app te zien krijgt (RLS op ai_action_audit).
--
-- Alleen voor de service-role (gerrie-agent, na de sessiecontrole); de rol komt
-- hier opnieuw uit organization_members, niet van de aanroeper.
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
  v_outcome  text := p_outcome;
  v_claimer  uuid;
  v_until    timestamptz;
  v_detail   text;
  v_status   text;
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

  select m.role into v_role
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

  if v_role not in ('owner', 'admin')
     and (v_row.agent_id is not null or v_row.agent_run_id is not null or v_row.mcp_grant_id is not null
          or v_row.api_key_id is not null or v_row.signal_id is not null
          or v_row.user_id is distinct from p_user_id) then
    raise exception 'Over dit voorstel beslist een owner of admin.' using errcode = '42501';
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
    update public.ai_action_audit
       set result = coalesce(result, '{}'::jsonb)
                 || jsonb_build_object('claimed_by', p_user_id, 'claimed_until', now() + interval '10 minutes')
     where id = v_row.id;
    return jsonb_build_object('status', v_row.status, 'claimed_until', now() + interval '10 minutes');
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

-- ── 2. Mislukte sleutels per afzender ───────────────────────────────────────
--
-- client_hash: SHA-256 van het adres dat de functie `api` ziet (nooit het
-- adres zelf). Geen policies: alleen de service-role komt erbij.
create table if not exists public.api_auth_failures (
  client_hash text primary key,
  window_start timestamptz not null default now(),
  failures integer not null default 0,
  blocked_until timestamptz
);

alter table public.api_auth_failures enable row level security;
revoke all on public.api_auth_failures from anon, authenticated;

-- De sleutel opzoeken, en meteen zeggen of deze afzender geblokkeerd is
-- (seconden tot het weer mag; 0 = niet). Eén ronde naar de database, net als
-- het opzoeken van de selector hiervoor. Geeft altijd precies één rij.
create or replace function public.api_key_lookup(p_selector text, p_client text)
returns table (api_key_id uuid, verifier_hash text, salt text, retry_after integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API zoekt sleutels op.' using errcode = '42501';
  end if;
  return query
    select s.api_key_id, s.verifier_hash, s.salt,
           coalesce((
             select greatest(1, ceil(extract(epoch from (f.blocked_until - now()))))::integer
               from public.api_auth_failures f
              where f.client_hash = p_client and f.blocked_until > now()
           ), 0)
      from (select 1) as one
      left join public.api_key_secrets s on s.selector = p_selector;
end;
$$;

revoke all on function public.api_key_lookup(text, text) from public, anon, authenticated;
grant execute on function public.api_key_lookup(text, text) to service_role;

-- Een mislukte poging tellen. Boven p_max_failures binnen p_window_seconds is
-- de afzender p_block_seconds geblokkeerd; daarna begint hij met een schone lei.
-- Geeft de seconden tot het weer mag (0 = niet geblokkeerd).
create or replace function public.api_note_auth_failure(
  p_client text,
  p_window_seconds integer default 600,
  p_max_failures integer default 60,
  p_block_seconds integer default 900
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.api_auth_failures%rowtype;
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 600), 1));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API telt mislukte pogingen.' using errcode = '42501';
  end if;

  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values (p_client, now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_row;

  if v_row.failures >= greatest(coalesce(p_max_failures, 60), 1)
     and (v_row.blocked_until is null or v_row.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + make_interval(secs => greatest(coalesce(p_block_seconds, 900), 1)),
           failures = 0,
           window_start = now()
     where client_hash = p_client
    returning * into v_row;
  end if;

  return case
    when v_row.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_row.blocked_until - now()))))::integer
    else 0
  end;
end;
$$;

revoke all on function public.api_note_auth_failure(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.api_note_auth_failure(text, integer, integer, integer) to service_role;

-- ── 3. Opruimen ─────────────────────────────────────────────────────────────
create or replace function public.api_purge_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.api_request_log where created_at < now() - interval '30 days';
  delete from public.api_idempotency_keys where created_at < now() - interval '24 hours';
  delete from public.api_auth_failures
   where coalesce(blocked_until, window_start) < now() - interval '1 day';
end;
$$;

revoke all on function public.api_purge_expired() from public, anon, authenticated;
grant execute on function public.api_purge_expired() to service_role;

-- Dagelijks om 03:17 UTC, als pg_cron er is. Zonder pg_cron gebeurt het
-- opruimen af en toe vanuit de functie `api` zelf (zie PUBLIC_API_SETUP.md).
-- Opnieuw draaien vervangt de taak in plaats van een tweede aan te maken.
do $$
begin
  if to_regclass('cron.job') is not null
     and to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regprocedure('cron.unschedule(bigint)') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'resofly-api-purge';
    perform cron.schedule(
      'resofly-api-purge',
      '17 3 * * *',
      'select public.api_purge_expired(); select public.webhook_purge_expired();'
    );
  else
    raise notice 'pg_cron staat niet aan: plan api_purge_expired() zelf in (zie PUBLIC_API_SETUP.md).';
  end if;
end $$;

commit;
