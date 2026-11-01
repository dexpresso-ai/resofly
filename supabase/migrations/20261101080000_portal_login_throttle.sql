-- ============================================================
-- ResoFly — Een rem op de portal-login
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt H).
--
-- portal-login draait vóór het inloggen (zonder JWT) en maakt een auth-account
-- aan voor elk adres dat bij een klant hoort. Er was geen grens: een script
-- kon onbeperkt adressen proberen (en via de reactietijd raden welke bij een
-- klant horen), en voor elk bekend adres een account en daarna een inlogmail
-- laten maken. Nu telt portal-login per afzender (gehasht IP) en per
-- e-mailadres (gehasht); boven de grens geeft hij hetzelfde antwoord, maar
-- doet hij niets.
--
-- Een eigen tabel, los van api_auth_failures: die houdt ook de globale teller
-- van de openbare API bij, en de portal-login hoort die niet op te drijven.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create table if not exists public.portal_login_attempts (
  key_hash text primary key,
  window_start timestamptz not null default now(),
  attempts integer not null default 0,
  blocked_until timestamptz
);

alter table public.portal_login_attempts enable row level security;
revoke all on public.portal_login_attempts from public, anon, authenticated;
grant all on public.portal_login_attempts to service_role;

-- Telt één poging voor deze sleutel. Geeft het aantal seconden terug dat de
-- sleutel nog geblokkeerd is (0 = deze poging mag).
create or replace function public.portal_login_hit(
  p_key text,
  p_window_seconds integer,
  p_max_attempts integer,
  p_block_seconds integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.portal_login_attempts%rowtype;
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 600), 1));
begin
  select * into v_row from public.portal_login_attempts where key_hash = p_key for update;
  if found and v_row.blocked_until is not null and v_row.blocked_until > now() then
    return greatest(1, ceil(extract(epoch from (v_row.blocked_until - now()))))::integer;
  end if;

  insert into public.portal_login_attempts as a (key_hash, window_start, attempts)
  values (p_key, now(), 1)
  on conflict (key_hash) do update
     set window_start = case when a.window_start < now() - v_window then now() else a.window_start end,
         attempts = case when a.window_start < now() - v_window then 1 else a.attempts + 1 end,
         blocked_until = null
  returning * into v_row;

  if v_row.attempts > greatest(coalesce(p_max_attempts, 10), 1) then
    update public.portal_login_attempts
       set blocked_until = now() + make_interval(secs => greatest(coalesce(p_block_seconds, 900), 1))
     where key_hash = p_key;
    return greatest(coalesce(p_block_seconds, 900), 1);
  end if;

  -- Af en toe opruimen: wat al een dag stil is, telt nergens meer voor.
  if random() < 0.01 then
    delete from public.portal_login_attempts
     where window_start < now() - interval '1 day'
       and (blocked_until is null or blocked_until < now());
  end if;
  return 0;
end;
$$;

revoke all on function public.portal_login_hit(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.portal_login_hit(text, integer, integer, integer) to service_role;

commit;
