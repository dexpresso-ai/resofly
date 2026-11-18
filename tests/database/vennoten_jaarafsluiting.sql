-- ============================================================
-- Databasetest: de jaarafsluiting van een vof met vennoten
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- In CI: de job migrations in .github/workflows/frontend-checks.yml.
--
-- Waarom deze test er is: close_fiscal_year wordt bij elke wijziging helemaal
-- opnieuw geschreven (20261104000000, 20261104070000, 20261105000000,
-- 20261118130000). De verdeling over de vennoten was alleen droog op staging
-- nagespeeld. Viel het vennotendeel bij een herschrijving weg, dan merkte geen
-- test dat.
--
-- Wat hij nagaat:
--   1. de beginbalans met kapitaal per vennoot, en de sluitpost op 0500;
--   2. de kapitaalvergelijking van een open en een afgesloten jaar;
--   3. winst 60/40 tot op de cent (€ 1.000,01 → € 600,01 en € 400,00), het
--      privé van elke vennoot naar zijn eigen kapitaal, algemeen privé naar
--      0500, en geen afrondingsregel op 4900;
--   4. de weigering als de verdeling niet op 100% uitkomt;
--   5. heropenen en opnieuw afsluiten geeft dezelfde standen;
--   6. verlies (€ 300,01 → € 180,01 en € 120,00);
--   7. geen actieve vennoot, of de overstap naar een eenmanszaak: het resultaat
--      gaat naar 0510, het privé van de vennoot nog steeds naar zijn kapitaal,
--      en in de kapitaalvergelijking telt het als opname (20261118130000);
--   8. een vennoot aan een teamlid koppelen, en de uren per vennoot in een
--      kalenderjaar, alleen van déze organisatie;
--   9. wie wat mag: lezer, lid zonder Uren, boekhouder en een buitenstaander.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
-- Alleen de meldingen (ok: … of MISLUKT: …), niet de lege uitkomsten.
\o /dev/null
set client_min_messages = notice;

begin;

-- De hulpjes: als, beheer, gelijk, weigert, saldo en eigenaar.
\ir hulpjes.psql

-- ── De wereld: een vof met vier teamleden, een boekhouder en een vreemde ───

select gen_random_uuid() as eigenaar, gen_random_uuid() as anna_lid, gen_random_uuid() as bram_lid,
       gen_random_uuid() as lezer, gen_random_uuid() as zonder_uren, gen_random_uuid() as boekhouder,
       gen_random_uuid() as vreemde
\gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',    'eigenaar@vennoten.test',    'authenticated', 'authenticated'),
  (:'anna_lid',    'anna@vennoten.test',        'authenticated', 'authenticated'),
  (:'bram_lid',    'bram@vennoten.test',        'authenticated', 'authenticated'),
  (:'lezer',       'lezer@vennoten.test',       'authenticated', 'authenticated'),
  (:'zonder_uren', 'zonder-uren@vennoten.test', 'authenticated', 'authenticated'),
  (:'boekhouder',  'boekhouder@vennoten.test',  'authenticated', 'authenticated'),
  (:'vreemde',     'vreemde@elders.test',       'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Jansen & De Vries')).id as org \gset
reset role;
select pg_temp.als(:'vreemde');
set local role authenticated;
select (public.create_organization('Elders')).id as vreemde_org \gset
reset role;
select pg_temp.beheer();

-- Genoeg licenties, zoals de billing-koppeling ze zet (tests/stromen/wereld.mjs).
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 50 where id = :'org';

insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'anna_lid',    'anna@vennoten.test',        'member',     'active', null),
  (:'org', :'bram_lid',    'bram@vennoten.test',        'member',     'active', null),
  (:'org', :'lezer',       'lezer@vennoten.test',       'member',     'active', '{"finance":"read","time":"read"}'::jsonb),
  (:'org', :'zonder_uren', 'zonder-uren@vennoten.test', 'member',     'active', '{"time":"none"}'::jsonb),
  (:'org', :'boekhouder',  'boekhouder@vennoten.test',  'accountant', 'active', null);

-- KOR: dan hoeven de btw-aangiften niet eerst te zijn afgesloten.
insert into public.company_settings (organization_id, created_by, company_name, legal_form, kor_enabled,
                                     bookkeeping_start_date, fiscal_year_start_month, year_result_account_code)
values (:'org', :'eigenaar', 'Jansen & De Vries V.O.F.', 'vof', true, '2024-01-01', 1, '0510');

-- ── 1. Vennoten, boekjaren en de beginbalans ───────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.save_partnership_partner(:'org', null, 'Anna', 6000)).id as anna \gset
select (public.save_partnership_partner(:'org', null, 'Bram', 4000)).id as bram \gset
select (public.open_fiscal_year(:'org', '2024-01-01', '2024-12-31')).id as fy2024 \gset
select (public.open_fiscal_year(:'org', '2025-01-01', '2025-12-31')).id as fy2025 \gset

-- De tip uit het scherm: het kapitaal per vennoot meteen in de beginbalans.
-- € 10.000 op de bank, € 6.000 van Anna, € 3.000 van Bram; de € 1.000 die
-- overblijft is de sluitpost op 0500.
select public.create_opening_balance(:'org', '2024-01-01', '[
  {"account_code": "1100", "debit_cents": 1000000},
  {"account_code": "0501", "credit_cents": 600000},
  {"account_code": "0502", "credit_cents": 300000}
]'::jsonb) is not null as beginbalans \gset

-- 2024: € 1.000,01 omzet, Anna neemt € 200 op, Bram stort € 50 in, en € 10
-- staat op de algemene privérekening (op geen enkele vennoot).
select public.post_journal_entry(:'org', '2024-03-01', 'Omzet', 'manual', null,
  '[{"account_code": "1100", "debit_cents": 100001}, {"account_code": "8000", "credit_cents": 100001}]'::jsonb) is not null as ok \gset
select public.post_journal_entry(:'org', '2024-04-01', 'Opname Anna', 'manual', null,
  '[{"account_code": "0551", "debit_cents": 20000}, {"account_code": "1100", "credit_cents": 20000}]'::jsonb) is not null as ok \gset
select public.post_journal_entry(:'org', '2024-05-01', 'Storting Bram', 'manual', null,
  '[{"account_code": "1100", "debit_cents": 5000}, {"account_code": "0562", "credit_cents": 5000}]'::jsonb) is not null as ok \gset
select public.post_journal_entry(:'org', '2024-06-01', 'Opname zonder vennoot', 'manual', null,
  '[{"account_code": "0550", "debit_cents": 1000}, {"account_code": "1100", "credit_cents": 1000}]'::jsonb) is not null as ok \gset

select public.owners_equity_overview(:'org', :'fy2024') as ov2024_open \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(pg_temp.saldo(:'org', '0500'), -100000::bigint, 'beginbalans: de sluitpost van € 1.000 staat op 0500');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -600000::bigint, 'beginbalans: het kapitaal van Anna op 0501');

-- ── 2. De kapitaalvergelijking van het open jaar ───────────────────────────

select pg_temp.gelijk((:'ov2024_open'::jsonb ->> 'isPartnership')::boolean, true, 'overzicht 2024: een vof met vennoten');
select pg_temp.gelijk((:'ov2024_open'::jsonb ->> 'resultCents')::bigint, 100001::bigint, 'overzicht 2024: winst € 1.000,01');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_open'::jsonb, 1) ->> 'beginCents')::bigint, 600000::bigint, 'overzicht 2024: Anna begint met € 6.000');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_open'::jsonb, 1) ->> 'resultShareCents')::bigint, 60001::bigint, 'overzicht 2024: Anna krijgt € 600,01');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_open'::jsonb, 2) ->> 'resultShareCents')::bigint, 40000::bigint, 'overzicht 2024: Bram krijgt € 400,00');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_open'::jsonb, 1) ->> 'withdrawalsCents')::bigint, 20000::bigint, 'overzicht 2024: Anna nam € 200 op');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_open'::jsonb, 1) ->> 'endCents')::bigint, 640001::bigint, 'overzicht 2024: Anna eindigt op € 6.400,01');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_open'::jsonb, 2) ->> 'endCents')::bigint, 345000::bigint, 'overzicht 2024: Bram eindigt op € 3.450');
select pg_temp.gelijk((:'ov2024_open'::jsonb -> 'unassigned' ->> 'endCents')::bigint, 99000::bigint, 'overzicht 2024: € 990 staat op geen enkele vennoot');

-- ── 3. Wie wat mag ─────────────────────────────────────────────────────────

select pg_temp.als(:'lezer');
set local role authenticated;
select pg_temp.weigert(format('select public.close_fiscal_year(%L, %L)', :'org', :'fy2024'), '42501', 'een lezer sluit geen boekjaar af');
select pg_temp.weigert(format('select public.save_partnership_partner(%L, %L, %L, 5000)', :'org', :'bram', 'Bram'), '42501', 'een lezer wijzigt geen vennoot');
select pg_temp.weigert(format('select public.set_partnership_partner_member(%L, %L, %L)', :'org', :'anna', :'anna_lid'), '42501', 'een lezer koppelt geen teamlid');
select (public.owners_equity_overview(:'org', :'fy2024') ->> 'resultCents')::bigint as lezer_ziet \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'lezer_ziet'::bigint, 100001::bigint, 'een lezer ziet de kapitaalvergelijking');

select pg_temp.als(:'vreemde');
set local role authenticated;
select pg_temp.weigert(format('select public.owners_equity_overview(%L, %L)', :'org', :'fy2024'), '42501', 'een buitenstaander ziet de kapitaalvergelijking niet');
select pg_temp.weigert(format('select public.set_partnership_partner_member(%L, %L, %L)', :'org', :'anna', :'vreemde'), '42501', 'een buitenstaander koppelt geen teamlid');
select pg_temp.weigert(format('select * from public.partnership_partner_hours(%L, 2024)', :'org'), '42501', 'een buitenstaander ziet de uren niet');
reset role;
select pg_temp.beheer();

-- ── 4. Een vennoot aan zijn teamlid koppelen, en de uren per vennoot ───────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.set_partnership_partner_member(:'org', :'anna', :'anna_lid')).user_id as anna_gekoppeld \gset
select pg_temp.weigert(format('select public.set_partnership_partner_member(%L, %L, %L)', :'org', :'bram', :'anna_lid'), 'al gekoppeld aan vennoot Anna', 'een teamlid hoort bij één vennoot');
select pg_temp.weigert(format('select public.set_partnership_partner_member(%L, %L, %L)', :'org', :'bram', :'vreemde'), 'hoort niet (meer) bij deze organisatie', 'iemand van buiten koppel je niet');
select pg_temp.weigert(format('select public.set_partnership_partner_member(%L, %L, %L)', :'org', :'bram', :'boekhouder'), 'boekhouder', 'de boekhouder koppel je niet');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'anna_gekoppeld'::uuid, :'anna_lid'::uuid, 'Anna hangt aan haar teamlid');

-- Uren van Anna: in 2024 tellen 120 minuten indirect en 600 direct. Niet mee:
-- 2023, 2025, en uren in een andere organisatie. Bram heeft geen teamlid: zijn
-- uren tellen niet.
insert into public.time_entries (organization_id, created_by, user_id, entry_date, minutes, entry_type, description) values
  (:'org',         :'anna_lid', :'anna_lid', '2024-02-01', 120, 'indirect', 'Administratie'),
  (:'org',         :'anna_lid', :'anna_lid', '2024-03-01', 600, 'direct',   'Ontwerp'),
  (:'org',         :'anna_lid', :'anna_lid', '2023-12-31', 999, 'direct',   'Vorig jaar'),
  (:'org',         :'anna_lid', :'anna_lid', '2025-01-02',  50, 'direct',   'Volgend jaar'),
  (:'org',         :'bram_lid', :'bram_lid', '2024-03-01', 300, 'direct',   'Bram, niet gekoppeld'),
  (:'vreemde_org', :'vreemde',  :'anna_lid', '2024-03-02', 777, 'direct',   'Andere organisatie');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select direct_minutes as anna_direct, indirect_minutes as anna_indirect, first_entry_date as anna_eerste
from public.partnership_partner_hours(:'org', 2024) where partner_id = :'anna' \gset
select coalesce(direct_minutes + indirect_minutes, -1) as bram_uren, user_id is null as bram_los
from public.partnership_partner_hours(:'org', 2024) where partner_id = :'bram' \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'anna_direct'::bigint, 600::bigint, 'uren 2024: Anna 600 minuten direct');
select pg_temp.gelijk(:'anna_indirect'::bigint, 120::bigint, 'uren 2024: Anna 120 minuten indirect');
select pg_temp.gelijk(:'anna_eerste'::date, '2024-02-01'::date, 'uren 2024: Anna begon op 1 februari');
select pg_temp.gelijk(:'bram_uren'::bigint, 0::bigint, 'uren 2024: Bram zonder teamlid telt niets');
select pg_temp.gelijk(:'bram_los'::boolean, true, 'uren 2024: Bram heeft geen teamlid');

select pg_temp.als(:'lezer');
set local role authenticated;
select count(*) as lezer_rijen from public.partnership_partner_hours(:'org', 2024) \gset
reset role;
select pg_temp.als(:'zonder_uren');
set local role authenticated;
select pg_temp.weigert(format('select * from public.partnership_partner_hours(%L, 2024)', :'org'), '42501', 'wie Uren niet mag lezen, ziet geen uren per vennoot');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'lezer_rijen'::bigint, 2::bigint, 'een lezer van Financiën en Uren ziet de uren per vennoot');

-- ── 5. De verdeling moet op 100% uitkomen ──────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.save_partnership_partner(:'org', :'bram', 'Bram', 3000)).id is not null as ok \gset
select pg_temp.weigert(format('select public.close_fiscal_year(%L, %L)', :'org', :'fy2024'), 'telt op tot 90 procent', 'afsluiten met 60/30 wordt geweigerd');
select (public.save_partnership_partner(:'org', :'bram', 'Bram', 4000)).id is not null as ok \gset

-- ── 6. Afsluiten met winst ─────────────────────────────────────────────────

select (public.close_fiscal_year(:'org', :'fy2024')).status as fy2024_status \gset
select public.owners_equity_overview(:'org', :'fy2024') as ov2024_dicht \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(:'fy2024_status', 'closed', 'afsluiten 2024 gelukt');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -640001::bigint, 'na afsluiten: kapitaal Anna € 6.400,01 (begin, € 600,01 winst, € 200 opname)');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0502'), -345000::bigint, 'na afsluiten: kapitaal Bram € 3.450 (begin, € 400 winst, € 50 storting)');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0551'), 0::bigint, 'na afsluiten: privé-opnamen Anna op nul');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0562'), 0::bigint, 'na afsluiten: privé-stortingen Bram op nul');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0550'), 0::bigint, 'na afsluiten: algemene privé-opnamen op nul');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0500'), -99000::bigint, 'na afsluiten: 0500 houdt de sluitpost min de algemene opname');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0510'), 0::bigint, 'na afsluiten: niets op 0510 bij een vof met vennoten');
select pg_temp.gelijk(pg_temp.saldo(:'org', '8000'), 0::bigint, 'na afsluiten: de omzet is afgesloten');
select pg_temp.gelijk(pg_temp.saldo(:'org', '4900'), 0::bigint, 'na afsluiten: geen afrondingsregel');
select pg_temp.gelijk((select result_account_code from public.fiscal_years where id = :'fy2024'), 'vennoten', 'boekjaar 2024: resultaat naar de vennoten');
select pg_temp.gelijk((select result_cents from public.fiscal_years where id = :'fy2024'), 100001::bigint, 'boekjaar 2024: resultaat € 1.000,01');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_dicht'::jsonb, 1) ->> 'endCents')::bigint, 640001::bigint, 'overzicht 2024 afgesloten: Anna gelijk aan het open jaar');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2024_dicht'::jsonb, 2) ->> 'endCents')::bigint, 345000::bigint, 'overzicht 2024 afgesloten: Bram gelijk aan het open jaar');

-- ── 7. Heropenen en opnieuw afsluiten ──────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.reopen_fiscal_year(:'org', :'fy2024')).status as heropend \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'heropend', 'open', 'heropenen 2024 gelukt');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0551'), 20000::bigint, 'na heropenen: de opname van Anna staat weer op 0551');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -600000::bigint, 'na heropenen: kapitaal Anna terug op de beginbalans');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.close_fiscal_year(:'org', :'fy2024')).status as opnieuw \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -640001::bigint, 'opnieuw afgesloten: kapitaal Anna weer € 6.400,01');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0502'), -345000::bigint, 'opnieuw afgesloten: kapitaal Bram weer € 3.450');

-- ── 8. Afsluiten met verlies ───────────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.post_journal_entry(:'org', '2025-02-01', 'Kosten', 'manual', null,
  '[{"account_code": "4500", "debit_cents": 30001}, {"account_code": "1100", "credit_cents": 30001}]'::jsonb) is not null as ok \gset
select public.post_journal_entry(:'org', '2025-03-01', 'Opname Anna', 'manual', null,
  '[{"account_code": "0551", "debit_cents": 7000}, {"account_code": "1100", "credit_cents": 7000}]'::jsonb) is not null as ok \gset
select (public.close_fiscal_year(:'org', :'fy2025')).status as fy2025_status \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -615000::bigint, 'verlies 2025: Anna draagt € 180,01 en haar opname van € 70');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0502'), -333000::bigint, 'verlies 2025: Bram draagt € 120,00');
select pg_temp.gelijk(pg_temp.saldo(:'org', '4500'), 0::bigint, 'verlies 2025: de kosten zijn afgesloten');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0551'), 0::bigint, 'verlies 2025: privé-opnamen Anna op nul');

-- ── 9. Geen actieve vennoot meer ───────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.reopen_fiscal_year(:'org', :'fy2025')).status as heropend \gset
select (public.save_partnership_partner(:'org', :'anna', 'Anna', 6000, 'beherend', false)).id is not null as ok \gset
select (public.save_partnership_partner(:'org', :'bram', 'Bram', 4000, 'beherend', false)).id is not null as ok \gset
select (public.close_fiscal_year(:'org', :'fy2025')).status as fy2025_status \gset
select public.owners_equity_overview(:'org', :'fy2025') as ov2025_zonder \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.saldo(:'org', '0510'), 30001::bigint, 'zonder actieve vennoot: het verlies gaat naar 0510');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0551'), 0::bigint, 'zonder actieve vennoot: het privé van Anna staat niet meer open');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -633001::bigint, 'zonder actieve vennoot: de opname van € 70 gaat naar het kapitaal van Anna');
select pg_temp.gelijk((select result_account_code from public.fiscal_years where id = :'fy2025'), '0510', 'boekjaar 2025: resultaat naar 0510');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025_zonder'::jsonb, null) ->> 'withdrawalsCents')::bigint, 7000::bigint, 'zonder actieve vennoot: de opname telt in de kapitaalvergelijking als opname');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025_zonder'::jsonb, null) ->> 'otherMovementsCents')::bigint, 0::bigint, 'zonder actieve vennoot: en niet als overig');

-- ── 10. De overstap naar een eenmanszaak ───────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.reopen_fiscal_year(:'org', :'fy2025')).status as heropend \gset
select (public.save_partnership_partner(:'org', :'anna', 'Anna', 6000, 'beherend', true)).id is not null as ok \gset
select (public.save_partnership_partner(:'org', :'bram', 'Bram', 4000, 'beherend', true)).id is not null as ok \gset
reset role;
select pg_temp.beheer();
update public.company_settings set legal_form = 'eenmanszaak' where organization_id = :'org';
-- De resultaatrekening volgt de rechtsvorm als hij nog op de standaard stond
-- (20261118090000): bij een eenmanszaak 0500.
select pg_temp.gelijk((select year_result_account_code from public.company_settings where organization_id = :'org'), '0500',
  'eenmanszaak: de resultaatrekening wordt 0500');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('select public.save_partnership_partner(%L, null, %L, 5000)', :'org', 'Cor'), 'Vennoten horen bij een vof', 'een eenmanszaak krijgt geen vennoten');
select pg_temp.weigert(format('select public.set_partnership_partner_member(%L, %L, null)', :'org', :'anna'), 'Vennoten horen bij een vof', 'en koppelt geen teamlid aan een vennoot');
select (public.close_fiscal_year(:'org', :'fy2025')).status as fy2025_status \gset
select public.owners_equity_overview(:'org', :'fy2025') as ov2025_eenmanszaak \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.saldo(:'org', '0500'), (-99000 + 30001)::bigint, 'eenmanszaak: het verlies van € 300,01 gaat naar 0500 (daar stond € 990)');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0510'), 0::bigint, 'eenmanszaak: niets meer op 0510');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0551'), 0::bigint, 'eenmanszaak: het privé van de vroegere vennoot staat niet meer open');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -633001::bigint, 'eenmanszaak: de opname gaat naar het kapitaal van Anna');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025_eenmanszaak'::jsonb, null) ->> 'withdrawalsCents')::bigint, 7000::bigint, 'eenmanszaak: de opname telt als opname');
select pg_temp.gelijk(pg_temp.saldo(:'org', '4900'), 0::bigint, 'nergens een afrondingsregel');

-- Andere organisaties merken niets.
select pg_temp.gelijk((select count(*) from public.journal_entries where organization_id = :'vreemde_org'), 0::bigint, 'de andere organisatie heeft geen boekingen');

\echo 'Alle controles van vennoten_jaarafsluiting.sql geslaagd.'
rollback;
