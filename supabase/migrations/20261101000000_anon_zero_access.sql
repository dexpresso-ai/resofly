-- ============================================================
-- ResoFly — De publieke sleutel (anon) kan niets meer in de database
-- Date: 2026-11-01
--
-- Aanleiding: de beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md).
--
-- Supabase geeft elke nieuwe tabel, reeks en functie in schema public alle
-- rechten aan `anon`: de rol van iedereen die alleen de publieke sleutel heeft
-- (die staat in elke browser). Wat anon dan nog ziet, hangt alleen van de
-- RLS-policies af. Staging telde op 1 november 969 policies, waarvan de meeste
-- voor rol `public` gelden, dus ook voor anon. Eén vergissing in één policy is
-- dan meteen leesbaar of schrijfbaar voor het hele internet.
--
-- De app heeft anon nergens nodig:
--   - inloggen loopt via Supabase Auth, niet via tabellen;
--   - de pagina's achter een deellink (offerte, factuur, contract, galerij,
--     boeking, zending, afmelden) en de portal-login lopen via edge functions
--     op de service-role;
--   - de workers gebruiken het JWT van de gebruiker (rol authenticated).
-- Alleen de openbare prijsplannen (billing_plans, policy "billing plans
-- readable") blijven leesbaar.
--
-- Na deze migratie:
--   - anon heeft op geen enkele tabel of reeks in public nog rechten, behalve
--     SELECT op billing_plans;
--   - anon kan geen enkele functie in public meer aanroepen. Wie die eerder via
--     PUBLIC had (authenticated, service_role), houdt hem: die krijgen een
--     expliciete grant vóór de PUBLIC-grant verdwijnt;
--   - nieuwe tabellen, reeksen en functies krijgen anon niet meer vanzelf (de
--     per-schema default van Supabase wordt teruggedraaid).
--
-- Een triggerfunctie wordt bij het afgaan niet op EXECUTE gecontroleerd, dus
-- die blijven gewoon werken. Een functie die bij een extensie hoort, blijft
-- buiten beschouwing.
--
-- Controle (moet 0 geven):
--   select count(*) from information_schema.role_table_grants
--    where grantee = 'anon' and table_schema = 'public' and table_name <> 'billing_plans';
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
--      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
--                      and d.objid = p.oid and d.deptype = 'e');
-- (De functies van de extensies pg_trgm en citext, zoals similarity() en de
-- citext-vergelijkingen, blijven aanroepbaar. Ze lezen geen gegevens.)
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Tabellen en reeksen ─────────────────────────────────────────────────

revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;

grant select on public.billing_plans to anon;

-- ── 2. Functies ────────────────────────────────────────────────────────────
--
-- Postgres geeft elke functie EXECUTE voor PUBLIC, en anon is lid van PUBLIC.
-- Alleen anon intrekken is dus niet genoeg. Eerst krijgen authenticated en
-- service_role een expliciete grant als ze de functie nu kunnen aanroepen,
-- daarna verdwijnt EXECUTE voor PUBLIC en anon.

do $$
declare
  r record;
  v_auth boolean;
  v_service boolean;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    v_auth := has_function_privilege('authenticated', r.oid, 'EXECUTE');
    v_service := has_function_privilege('service_role', r.oid, 'EXECUTE');
    if v_auth then execute format('grant execute on routine %s to authenticated', r.sig); end if;
    if v_service then execute format('grant execute on routine %s to service_role', r.sig); end if;
    execute format('revoke execute on routine %s from public, anon', r.sig);
  end loop;
end $$;

-- ── 3. Nieuwe objecten ─────────────────────────────────────────────────────
--
-- Supabase zet per schema een default-grant aan anon voor alles wat postgres
-- aanmaakt. Die wordt hier per schema teruggedraaid. De globale default van
-- Postgres (EXECUTE voor PUBLIC op nieuwe functies) is per schema niet in te
-- trekken. Daarom bewaakt migrationGrants.test.ts dat elke security-definer-
-- functie in een nieuwe migratie expliciet "revoke ... from public, anon"
-- krijgt. Een gewone (invoker) functie draait met de rechten van anon, en die
-- heeft na stap 1 op geen enkele tabel nog rechten.

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

commit;
