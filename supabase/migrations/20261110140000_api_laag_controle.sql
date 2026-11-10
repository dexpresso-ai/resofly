-- ============================================================
-- ResoFly — Controle van de API-laag
-- Date: 2026-11-10
--
-- Zie docs/rapporten/CONTROLE_API_LAAG_2026-11-10.md en
-- docs/changelog/CHANGELOG_API_LAAG_2026-11-10.md.
--
-- 1. Een rem op het registreren van AI-clients (mcp-oauth /register).
--    Registreren kan zonder login; zo werkt het koppelen van Claude en
--    ChatGPT. De grootte van één registratie was al begrensd, en registraties
--    zonder koppeling gaan na twee dagen weg (20261101070000). Het AANTAL was
--    niet begrensd: een lus over /register zette in die twee dagen zoveel rijen
--    van een paar kB neer als de functie aankon, in de database die alle
--    organisaties delen. Nu: per afzender en voor iedereen samen een plafond per
--    uur. Daarboven volgt een pauze (429).
--
--    edge_note_attempt is algemeen: een emmer (p_bucket) per soort verzoek,
--    met dezelfde tabel en dezelfde opruiming (api_purge_expired) als de
--    teller van mislukte API-sleutels. De sleutels krijgen de naam van de emmer
--    ervoor, zodat ze nooit samenvallen met die teller ('*' en de hashes van
--    de API).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.edge_note_attempt(
  p_bucket text,
  p_client text,
  p_window_seconds integer,
  p_max integer,
  p_block_seconds integer,
  p_global_max integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.api_auth_failures%rowtype;
  v_all public.api_auth_failures%rowtype;
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 3600), 1));
  v_block interval := make_interval(secs => greatest(coalesce(p_block_seconds, 900), 1));
  v_key text;
  v_global text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server telt verzoeken.' using errcode = '42501';
  end if;
  -- Een emmer is een vaste naam uit de code, geen invoer van een bezoeker.
  if p_bucket is null or p_bucket !~ '^[a-z][a-z0-9-]{1,40}$' then
    raise exception 'Ongeldige emmer.' using errcode = '22023';
  end if;
  v_key := p_bucket || ':' || left(coalesce(p_client, 'onbekend'), 128);
  v_global := p_bucket || ':*';

  -- Per afzender.
  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values (v_key, now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_row;
  if v_row.failures > greatest(coalesce(p_max, 1), 1)
     and (v_row.blocked_until is null or v_row.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + v_block, failures = 0, window_start = now()
     where client_hash = v_key
    returning * into v_row;
  end if;

  -- Alle afzenders samen: de telling per afzender leunt op een header die
  -- buiten Cloudflare te vervalsen is; deze niet.
  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values (v_global, now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_all;
  if v_all.failures > greatest(coalesce(p_global_max, 1), 1)
     and (v_all.blocked_until is null or v_all.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + v_block, failures = 0, window_start = now()
     where client_hash = v_global
    returning * into v_all;
  end if;

  return greatest(
    case when v_row.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_row.blocked_until - now()))))::integer else 0 end,
    case when v_all.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_all.blocked_until - now()))))::integer else 0 end
  );
end;
$$;

revoke all on function public.edge_note_attempt(text, text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.edge_note_attempt(text, text, integer, integer, integer, integer) to service_role;

commit;
