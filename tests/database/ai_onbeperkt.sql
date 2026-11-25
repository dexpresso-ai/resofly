-- ============================================================
-- Databasetest: onbeperkt AI-tegoed per organisatie (20261125120000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: het AI-tegoed had alleen plafonds voor iedereen. Nu kan één
-- organisatie onbeperkt zijn. Deze test:
--
--   1. een nieuwe organisatie is niet onbeperkt;
--   2. een gebruiker kan de vlag niet zelf zetten: niet via de functie, niet
--      via de tabel, en hij kan het verbruik van anderen niet opvragen;
--   3. de service-role zet de vlag, en dat komt in het logboek;
--   4. ai_usage_month_totals geeft de vlag mee, en het verbruik in een
--      onbeperkte organisatie telt niet mee voor het eigen tegoed elders.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@onbeperkt.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Onbeperkt BV')).id as onbeperkt \gset
select (public.create_organization('Gewoon BV')).id as gewoon \gset
reset role;
select pg_temp.beheer();

-- ── 1. Standaard niet onbeperkt ─────────────────────────────────────────────

select public.ensure_organization_billing_profile(:'onbeperkt');
select pg_temp.gelijk((select ai_unlimited from public.organization_billing_profiles where organization_id = :'onbeperkt'), false,
  'een nieuwe organisatie is niet onbeperkt');

-- ── 2. Niet zelf te zetten ──────────────────────────────────────────────────

select pg_temp.gelijk(has_function_privilege('authenticated', 'public.set_organization_ai_unlimited(uuid, boolean)', 'execute'), false,
  'authenticated mag de vlag niet zetten');
select pg_temp.gelijk(has_function_privilege('anon', 'public.set_organization_ai_unlimited(uuid, boolean)', 'execute'), false,
  'anon mag de vlag niet zetten');
select pg_temp.gelijk(has_function_privilege('service_role', 'public.set_organization_ai_unlimited(uuid, boolean)', 'execute'), true,
  'de service-role wel');
select pg_temp.gelijk(has_function_privilege('authenticated', 'public.ai_usage_month_totals(uuid, uuid)', 'execute'), false,
  'authenticated leest het maandverbruik niet');
select pg_temp.gelijk(has_function_privilege('service_role', 'public.ai_usage_month_totals(uuid, uuid)', 'execute'), true,
  'de service-role wel');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('select public.set_organization_ai_unlimited(%L, true)', :'onbeperkt'),
  'permission denied', 'de owner roept de functie aan: geweigerd');
update public.organization_billing_profiles set ai_unlimited = true where organization_id = :'onbeperkt';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select ai_unlimited from public.organization_billing_profiles where organization_id = :'onbeperkt'), false,
  'de owner schrijft de tabel: er verandert niets');

-- ── 4a. Verbruik vóór de vlag ───────────────────────────────────────────────

insert into public.ai_usage (organization_id, user_id, model, cost_usd) values
  (:'onbeperkt', :'eigenaar', 'test', 10),
  (:'gewoon', :'eigenaar', 'test', 2);

select pg_temp.gelijk((select user_usd || ' | ' || org_usd || ' | ' || org_unlimited from public.ai_usage_month_totals(:'eigenaar', :'gewoon')),
  '12.0000 | 2.0000 | false', 'zonder vlag: het eigen tegoed telt beide organisaties');

-- ── 3. De service-role zet de vlag ──────────────────────────────────────────

select public.set_organization_ai_unlimited(:'onbeperkt', true);
select pg_temp.gelijk((select ai_unlimited from public.organization_billing_profiles where organization_id = :'onbeperkt'), true,
  'de vlag staat aan');
select pg_temp.gelijk((select count(*) from public.audit_logs
                        where organization_id = :'onbeperkt' and action = 'billing_synced'
                          and metadata ->> 'source' = 'set_organization_ai_unlimited'
                          and metadata ->> 'ai_unlimited' = 'true'), 1::bigint,
  'het zetten staat in het logboek');

-- ── 4b. Verbruik met de vlag ────────────────────────────────────────────────

select pg_temp.gelijk((select org_unlimited from public.ai_usage_month_totals(:'eigenaar', :'onbeperkt')), true,
  'in de onbeperkte organisatie: de vlag komt mee');
select pg_temp.gelijk((select user_usd || ' | ' || org_usd || ' | ' || org_unlimited from public.ai_usage_month_totals(:'eigenaar', :'gewoon')),
  '2.0000 | 2.0000 | false', 'elders: het verbruik in de onbeperkte organisatie telt niet mee');
select pg_temp.gelijk((select org_unlimited from public.ai_usage_month_totals(:'eigenaar', null)), false,
  'zonder organisatie: niet onbeperkt');

select public.set_organization_ai_unlimited(:'onbeperkt', false);
select pg_temp.gelijk((select user_usd::text from public.ai_usage_month_totals(:'eigenaar', :'gewoon')), '12.0000',
  'vlag weer uit: alles telt weer mee');

\o
\echo Alle controles van ai_onbeperkt.sql geslaagd.
rollback;
