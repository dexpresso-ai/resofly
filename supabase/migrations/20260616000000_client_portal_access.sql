-- ============================================================
-- ResoFly — Klantportaal toegang (client portal)
-- Date: 2026-06-16
--
-- Scope:
-- - Klanten loggen in op /portal via een magische e-maillink (Supabase Auth).
-- - Toegang is automatisch: een ingelogde klant ziet de klantdossiers waarvan
--   clients.email overeenkomt met zijn geverifieerde e-mailadres.
-- - Lezen én tickets aanmaken loopt via de edge function `client-portal` met de
--   service-role key; RLS hoeft daarom NIET versoepeld te worden voor klanten.
--   Een klant is geen organisatie-lid en krijgt via de gewone app (RLS op
--   user_is_org_member(auth.uid())) automatisch nul toegang.
--
-- Deze migratie voegt enkel het ondersteunende, org-overstijgende e-mail-zoekpad
-- toe: een functionele index + een service-role-only RPC die de toegestane
-- klantdossiers voor een geverifieerd e-mailadres teruggeeft.
-- ============================================================

begin;

-- Org-overstijgende functionele index zodat het portaal snel alle klantdossiers
-- vindt die bij één geverifieerd e-mailadres horen. De bestaande index
-- idx_clients_org_email_lookup is met organization_id geprefixt en helpt niet
-- voor een org-overstijgende zoekopdracht op alleen het e-mailadres.
create index if not exists idx_clients_email_portal_lookup
  on public.clients (public.normalize_client_lookup_value(email))
  where email is not null;

-- Geeft de klantdossiers terug die horen bij een geverifieerd portaal-e-mailadres.
-- Normaliseert beide kanten met dezelfde regel als de duplicate-guard (lower +
-- trim + witruimte samenvouwen), zodat de match betrouwbaar is en de index hierboven
-- benut wordt.
--
-- SECURITY DEFINER met vaste search_path. Bewust ALLEEN uitvoerbaar door
-- service_role (de `client-portal` edge function), nooit door anon/authenticated
-- browsers — anders zou elke ingelogde gebruiker klanten kunnen enumereren op
-- e-mailadres. Een leeg/whitespace e-mailadres normaliseert naar NULL en levert
-- dus geen rijen op.
create or replace function public.portal_clients_for_email(p_email text)
returns setof public.clients
language sql
stable
security definer
set search_path = public
as $$
  select c.*
  from public.clients c
  where c.email is not null
    and public.normalize_client_lookup_value(p_email) is not null
    and public.normalize_client_lookup_value(c.email)
        = public.normalize_client_lookup_value(p_email);
$$;

revoke all on function public.portal_clients_for_email(text) from public;
revoke all on function public.portal_clients_for_email(text) from anon;
revoke all on function public.portal_clients_for_email(text) from authenticated;
grant execute on function public.portal_clients_for_email(text) to service_role;

commit;
