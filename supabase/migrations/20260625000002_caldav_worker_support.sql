-- ============================================================
-- ResoFly — CalDAV-Worker ondersteuning (fase 2)
-- Date: 2026-06-25
--
-- De CalDAV-Worker (Cloudflare) authenticeert telefoons met HTTP Basic:
-- gebruikersnaam = inlog-e-mail, wachtwoord = app-wachtwoord. De Worker draait
-- met de service-role key en moet uit een e-mail de bijbehorende actieve
-- app-wachtwoord-rijen kunnen ophalen (incl. salt + hash) om het token te
-- verifiëren. auth.users is niet via PostgREST benaderbaar, daarom deze
-- SECURITY DEFINER-functie die de join e-mail → user_id afhandelt.
--
-- Beveiliging:
-- - Uitsluitend uitvoerbaar door service_role (niet anon/authenticated): de
--   functie geeft hashes terug en mag dus nooit vanuit de client benaderbaar zijn.
-- ============================================================

begin;

create or replace function public.caldav_lookup_app_passwords(p_email text)
returns table (id uuid, user_id uuid, organization_id uuid, salt text, password_hash text)
language sql
security definer
set search_path = public, auth
as $$
  select ap.id, ap.user_id, ap.organization_id, ap.salt, ap.password_hash
  from public.calendar_app_passwords ap
  join auth.users u on u.id = ap.user_id
  where ap.revoked_at is null
    and lower(u.email) = lower(trim(coalesce(p_email, '')))
    and coalesce(trim(p_email), '') <> '';
$$;

revoke all on function public.caldav_lookup_app_passwords(text) from public, anon, authenticated;
grant execute on function public.caldav_lookup_app_passwords(text) to service_role;

commit;
