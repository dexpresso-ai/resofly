-- ============================================================
-- Databasetest: een heel boekjaar van een vof, zoals de app het boekt
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: elke functie van de boekhouding is los getest, maar een vof gebruikt
-- ze samen, met vennoten, privé per vennoot en btw per kwartaal. Deze test
-- loopt het jaar van een vof door met dezelfde databasefuncties als het scherm
-- en controleert elk bedrag:
--
--   1. inrichten: rekeningschema van een IB-onderneming, zonder BV-rekeningen;
--   2. vennoten (60/40) met hun teamlid, boekjaren, bankrekening en de
--      beginbalans met kapitaal per vennoot;
--   3. verkoop: twee facturen naar het grootboek, betaald via de bank;
--   4. inkoop: een factuur betaald via de bank, en een die een vennoot privé
--      betaalde;
--   5. privé via de bank: een opname van Anna, een storting van Bram;
--   6. een activum met afschrijving (20% per jaar);
--   7. de btw-aangifte van vier kwartalen, en de betaling ervan;
--   8. saldibalans, winst-en-verliesrekening en balans vóór het afsluiten;
--   9. de jaarafsluiting: winst 60/40, privé naar het kapitaal van elke
--      vennoot, en de balans erna;
--  10. de kapitaalvergelijking per vennoot, en het beginvermogen van het
--      volgende jaar.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

-- De hulpjes: als, beheer, gelijk, weigert, saldo en eigenaar.
\ir hulpjes.psql

-- ── 1. Inrichten ───────────────────────────────────────────────────────────

select gen_random_uuid() as anna_lid, gen_random_uuid() as bram_lid \gset

insert into auth.users (id, email, aud, role) values
  (:'anna_lid', 'anna@jansen-devries.test', 'authenticated', 'authenticated'),
  (:'bram_lid', 'bram@jansen-devries.test', 'authenticated', 'authenticated');

select pg_temp.als(:'anna_lid');
set local role authenticated;
select (public.create_organization('Jansen & De Vries')).id as org \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 5 where id = :'org';
insert into public.organization_members (organization_id, user_id, email, role, status)
values (:'org', :'bram_lid', 'bram@jansen-devries.test', 'member', 'active');

-- Btw per kwartaal, zonder KOR: dan moet elke aangifte dicht zijn voordat het
-- jaar kan sluiten.
insert into public.company_settings (organization_id, created_by, company_name, legal_form, kor_enabled, vat_return_period,
                                     bookkeeping_start_date, fiscal_year_start_month, year_result_account_code,
                                     kvk_number, vat_number)
values (:'org', :'anna_lid', 'Jansen & De Vries V.O.F.', 'vof', false, 'quarterly',
        '2025-01-01', 1, '0510', '12345678', 'NL123456789B01');

select pg_temp.als(:'anna_lid');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'org') is null as ok \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk((select name || ' / ' || subtype from public.ledger_accounts where organization_id = :'org' and code = '0500'),
  'Eigen vermogen / equity', 'rekeningschema: 0500 is Eigen vermogen, geen aandelenkapitaal');
select pg_temp.gelijk((select count(*) from public.ledger_accounts where organization_id = :'org' and code in ('0550', '0560')),
  2::bigint, 'rekeningschema: 0550 Privé-opnamen en 0560 Privé-stortingen');
select pg_temp.gelijk((select count(*) from public.ledger_accounts where organization_id = :'org' and code in ('0505', '0520', '1540', '9900')),
  0::bigint, 'rekeningschema: geen rekeningen van een BV (reserves, Vpb)');

-- ── 2. Vennoten, boekjaren, bank en beginbalans ────────────────────────────

select pg_temp.als(:'anna_lid');
set local role authenticated;
select (public.save_partnership_partner(:'org', null, 'Anna Jansen', 6000)).id as anna \gset
select (public.save_partnership_partner(:'org', null, 'Bram de Vries', 4000)).id as bram \gset
select (public.set_partnership_partner_member(:'org', :'anna', :'anna_lid')).id is not null as ok \gset
select (public.set_partnership_partner_member(:'org', :'bram', :'bram_lid')).id is not null as ok \gset
select (public.open_fiscal_year(:'org', '2025-01-01', '2025-12-31')).id as fy2025 \gset
select (public.open_fiscal_year(:'org', '2026-01-01', '2026-12-31')).id as fy2026 \gset
-- Een vof heeft geen gebroken boekjaar: dat past niet op de aangifte van de
-- vennoten. Een eerste boekjaar vanaf juli kan wel (in één kalenderjaar).
select pg_temp.weigert(format('select public.open_fiscal_year(%L, %L, %L)', :'org', '2027-07-01', '2028-06-30'),
  'het boekjaar het kalenderjaar', 'boekjaar: een gebroken boekjaar wordt geweigerd');

select id as rek_bank from public.ledger_accounts where organization_id = :'org' and code = '1100' \gset
select id as rek_omzet from public.ledger_accounts where organization_id = :'org' and code = '8000' \gset
select id as rek_kosten from public.ledger_accounts where organization_id = :'org' and code = '4500' \gset
select id as rek_btw_schuld from public.ledger_accounts where organization_id = :'org' and code = '1530' \gset
select id as rek_crediteuren from public.ledger_accounts where organization_id = :'org' and code = '1600' \gset
select id as rek_opname_anna from public.ledger_accounts where organization_id = :'org' and code = '0551' \gset
select id as rek_storting_bram from public.ledger_accounts where organization_id = :'org' and code = '0562' \gset

insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
values (:'org', :'anna_lid', 'Zakelijke rekening', 'NL91ABNA0417164300', 'EUR', :'rek_bank', true, 'import')
returning id as bankrekening \gset

-- € 10.000 op de bank: € 6.000 van Anna en € 4.000 van Bram, elk op zijn
-- eigen kapitaalrekening. Geen sluitpost.
select public.create_opening_balance(:'org', '2025-01-01', '[
  {"account_code": "1100", "debit_cents": 1000000},
  {"account_code": "0501", "credit_cents": 600000},
  {"account_code": "0502", "credit_cents": 400000}
]'::jsonb) is not null as ok \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk((select string_agg(name, ' / ' order by code) from public.ledger_accounts where organization_id = :'org' and code in ('0550', '0560')),
  'Privé-opnamen (geen vennoot) / Privé-stortingen (geen vennoot)', 'rekeningschema: 0550 en 0560 zeggen dat ze op geen vennoot staan');
update public.company_settings set fiscal_year_start_month = 7 where organization_id = :'org';
select pg_temp.gelijk((select fiscal_year_start_month from public.company_settings where organization_id = :'org'), 1,
  'boekjaar: de startmaand blijft januari');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0500'), 0::bigint, 'beginbalans: geen sluitpost op 0500');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501') + pg_temp.saldo(:'org', '0502'), -1000000::bigint, 'beginbalans: € 10.000 kapitaal, verdeeld over de vennoten');

-- ── 3. Verkoop: twee facturen, betaald via de bank ─────────────────────────

select pg_temp.als(:'anna_lid');
set local role authenticated;
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'anna_lid', 'Bakkerij De Korenaar', 'info@korenaar.test', 'business')
returning id as klant \gset

-- Februari: 10 uur à € 100 (21%) = € 1.210. November: € 5.000 (21%) = € 6.050.
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'anna_lid', :'klant', 'F2025-001', '2025-02-10', '2025-02-24', 'draft',
        '[{"id": "a1", "description": "Ontwerp", "quantity": 10, "unit_price": 100, "vat": 21}]'::jsonb)
returning id as factuur1 \gset
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'anna_lid', :'klant', 'F2025-002', '2025-11-14', '2025-11-28', 'draft',
        '[{"id": "b1", "description": "Huisstijl", "quantity": 1, "unit_price": 5000, "vat": 21}]'::jsonb)
returning id as factuur2 \gset
reset role;
select pg_temp.beheer();

-- Versturen doet invoice-workflow (als service-role): status en tijdstip. Een
-- verstuurde factuur gaat dan vanzelf naar het grootboek.
update public.invoices set status = 'sent', sent_at = date::timestamptz + interval '9 hours'
where id in (:'factuur1', :'factuur2');
select pg_temp.gelijk((select count(*) from public.invoices where id in (:'factuur1', :'factuur2') and journal_entry_id is not null),
  2::bigint, 'verkoop: verstuurde facturen staan in het grootboek');

select pg_temp.als(:'anna_lid');
set local role authenticated;

-- De klant betaalt allebei via de bank.
select (public.create_manual_bank_transaction(:'org', :'bankrekening', '2025-02-20', 121000, 'Bakkerij De Korenaar', null, 'F2025-001')).id as ontvangst1 \gset
select (public.create_manual_bank_transaction(:'org', :'bankrekening', '2025-12-01', 605000, 'Bakkerij De Korenaar', null, 'F2025-002')).id as ontvangst2 \gset
select (public.book_bank_transaction(:'org', :'ontvangst1', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'sales_invoice', 'invoice_id', :'factuur1', 'amount_cents', 121000)))).id is not null as ok \gset
select (public.book_bank_transaction(:'org', :'ontvangst2', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'sales_invoice', 'invoice_id', :'factuur2', 'amount_cents', 605000)))).id is not null as ok \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(pg_temp.saldo(:'org', '8000'), -600000::bigint, 'verkoop: € 6.000 omzet');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1510'), -126000::bigint, 'verkoop: € 1.260 btw');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1300'), 0::bigint, 'verkoop: debiteuren betaald');
select pg_temp.gelijk((select string_agg(status, ',' order by number) from public.invoices where id in (:'factuur1', :'factuur2')),
  'paid,paid', 'verkoop: beide facturen staan op betaald');

-- ── 4. Inkoop: via de bank, en een factuur die Bram privé betaalde ─────────

select pg_temp.als(:'anna_lid');
set local role authenticated;
insert into public.suppliers (organization_id, created_by, name, iban)
values (:'org', :'anna_lid', 'Drukkerij Van Dam', 'NL44RABO0123456788')
returning id as leverancier \gset

-- Maart: € 200 + € 42 btw, betaald via de bank.
insert into public.purchase_invoices (organization_id, created_by, supplier_id, supplier_invoice_number, date, due_date,
                                      subtotal_cents, vat_cents, total_cents, currency, status, lines)
values (:'org', :'anna_lid', :'leverancier', 'VD-1001', '2025-03-05', '2025-03-19', 20000, 4200, 24200, 'EUR', 'draft',
        jsonb_build_array(jsonb_build_object('id', 'p1', 'description', 'Drukwerk', 'amount_cents', 20000,
                                             'vat_code', 'HOOG', 'vat_rate', 21, 'account_id', :'rek_kosten')))
returning id as inkoop1 \gset
select (public.book_purchase_invoice(:'org', :'inkoop1')).id is not null as ok \gset
select (public.create_manual_bank_transaction(:'org', :'bankrekening', '2025-03-15', -24200, 'Drukkerij Van Dam', 'NL44RABO0123456788', 'VD-1001')).id as betaling1 \gset
select (public.book_bank_transaction(:'org', :'betaling1', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', :'inkoop1', 'amount_cents', 24200)))).id is not null as ok \gset

-- Oktober: € 100 + € 21 btw. Bram betaalde met zijn eigen pas.
insert into public.purchase_invoices (organization_id, created_by, supplier_id, supplier_invoice_number, date, due_date,
                                      subtotal_cents, vat_cents, total_cents, currency, status, lines)
values (:'org', :'anna_lid', :'leverancier', 'VD-1077', '2025-10-10', '2025-10-24', 10000, 2100, 12100, 'EUR', 'draft',
        jsonb_build_array(jsonb_build_object('id', 'p2', 'description', 'Visitekaartjes', 'amount_cents', 10000,
                                             'vat_code', 'HOOG', 'vat_rate', 21, 'account_id', :'rek_kosten')))
returning id as inkoop2 \gset
select (public.book_purchase_invoice(:'org', :'inkoop2')).id as inkoop2_boeking \gset

-- Privé betaald: bij een vof hoort dat bij één vennoot, in het verleden, en
-- niet vóór de start van de boekhouding.
select pg_temp.weigert(format('select public.pay_purchase_invoice_privately(%L, %L)', :'org', :'inkoop2'),
  'Kies de vennoot', 'privé betaald: bij een vof moet je de vennoot kiezen');
select pg_temp.weigert(format('select public.pay_purchase_invoice_privately(%L, %L, %L, %L)', :'org', :'inkoop2', :'bram', (current_date + 10)::text),
  'niet in de toekomst', 'privé betaald: geen datum in de toekomst');
select pg_temp.weigert(format('select public.pay_purchase_invoice_privately(%L, %L, %L, %L)', :'org', :'inkoop2', :'bram', '2024-12-31'),
  'begint op 01-01-2025', 'privé betaald: niet vóór de start van de boekhouding');
select (public.pay_purchase_invoice_privately(:'org', :'inkoop2', :'bram', '2025-10-10')).id as privebetaling \gset
select pg_temp.weigert(format('select public.pay_purchase_invoice_privately(%L, %L, %L)', :'org', :'inkoop2', :'bram'),
  'niets meer open', 'privé betaald: een betaalde factuur betaal je niet nog eens');

-- Een factuur met een privébetaling erop boek je niet tegen; de privébetaling
-- tegenboeken zet hem weer open, en daarna kan het opnieuw.
select pg_temp.weigert(format('select public.reverse_journal_entry(%L, %L)', :'inkoop2_boeking', '2025-10-31'),
  'privé betaald', 'tegenboeken: eerst de privébetaling');
select (public.reverse_journal_entry(:'privebetaling', '2025-10-31')).id is not null as ok \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'inkoop2'), 'unpaid', 'privé betaald: tegengeboekt staat de factuur weer open');

select pg_temp.als(:'anna_lid');
set local role authenticated;
select (public.pay_purchase_invoice_privately(:'org', :'inkoop2', :'bram', '2025-10-10')).id is not null as ok \gset
reset role;
select pg_temp.beheer();

select pg_temp.als(:'anna_lid');
set local role authenticated;
select public.report_open_items(:'org', '2025-12-31') as openstaand \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(jsonb_array_length(:'openstaand'::jsonb -> 'payables' -> 'rows'), 0, 'openstaande posten: geen inkoopfactuur meer open');
select pg_temp.gelijk((:'openstaand'::jsonb -> 'payables' ->> 'unmatched_cents')::bigint, 0::bigint, 'openstaande posten: niets op 1600 zonder factuur');

select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'inkoop1'), 'paid', 'inkoop: via de bank betaald');
select pg_temp.gelijk((select payment_status || ' ' || paid_at::date from public.purchase_invoices where id = :'inkoop2'), 'paid 2025-10-10', 'inkoop: privé betaald door Bram, op 10 oktober');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1600'), 0::bigint, 'inkoop: niets meer open bij de crediteuren');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0562'), -12100::bigint, 'inkoop: € 121 op de privé-stortingen van Bram');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1500'), 6300::bigint, 'inkoop: € 63 voorbelasting');

-- ── 5. Privé via de bank, en een inbreng ────────────────────────────────────

select pg_temp.als(:'anna_lid');
set local role authenticated;
select (public.create_manual_bank_transaction(:'org', :'bankrekening', '2025-06-30', -150000, 'A. Jansen', 'NL20INGB0001234567', 'Opname')).id as opname \gset
select pg_temp.weigert(format('select public.book_bank_transaction(%L, %L, p_allocations => %L::jsonb)', :'org', :'opname',
  jsonb_build_array(jsonb_build_object('kind', 'ledger', 'account_id', :'rek_opname_anna', 'vat_code', 'HOOG', 'amount_cents', 150000))),
  'geen btw', 'privé: een opname met een btw-code wordt geweigerd (geen voorbelasting op privé)');
select pg_temp.weigert(format('insert into public.bank_rules (organization_id, name, match_direction, match_counterparty_iban, target_account_id, target_vat_code, auto_book, is_active) values (%L, %L, %L, %L, %L, %L, true, true)',
  :'org', 'Opnamen Anna', 'out', 'NL20INGB0001234567', :'rek_opname_anna', 'HOOG'),
  'geen btw', 'privé: een bankregel met btw op een privérekening wordt geweigerd');
select (public.book_bank_transaction(:'org', :'opname', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'ledger', 'account_id', :'rek_opname_anna', 'amount_cents', 150000)))).id is not null as ok \gset
select (public.create_manual_bank_transaction(:'org', :'bankrekening', '2025-07-15', 50000, 'B. de Vries', 'NL69INGB0123456789', 'Storting')).id as storting \gset
select (public.book_bank_transaction(:'org', :'storting', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'ledger', 'account_id', :'rek_storting_bram', 'amount_cents', 50000)))).id is not null as ok \gset

-- Bram brengt op 1 mei zijn laptop in (€ 1.500), af te schrijven in 60 maanden.
insert into public.fixed_assets (organization_id, created_by, name, category, acquisition_date, acquisition_cost_cents,
                                 residual_value_cents, useful_life_months, start_date,
                                 asset_account_id, depreciation_account_id, accumulated_depreciation_account_id)
select :'org', :'anna_lid', 'Laptop (inbreng Bram)', 'inventaris', '2025-05-01', 150000, 0, 60, '2025-05-01',
       (select id from public.ledger_accounts where organization_id = :'org' and code = '0100'),
       (select id from public.ledger_accounts where organization_id = :'org' and code = '4000'),
       (select id from public.ledger_accounts where organization_id = :'org' and code = '0150')
returning id as laptop \gset
select (public.book_asset_acquisition(:'org', :'laptop', :'rek_storting_bram', '2025-05-01')).id is not null as ok \gset
select count(*) as termijnen from public.generate_depreciation_schedule(:'org', :'laptop') \gset
select (public.post_asset_depreciation(:'org', :'laptop', '2025-12-31')).id is not null as ok \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(pg_temp.saldo(:'org', '0551'), 150000::bigint, 'privé: Anna nam € 1.500 op');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0562'), -212100::bigint, 'privé: Bram betaalde € 121, stortte € 500 en bracht een laptop van € 1.500 in');
select pg_temp.gelijk(pg_temp.saldo(:'org', '4000'), 20000::bigint, 'activa: 8 maanden afschrijving à € 25');

-- ── 6. Btw: vier kwartalen ──────────────────────────────────────────────────

select pg_temp.als(:'anna_lid');
set local role authenticated;
select public.compute_vat_return(:'org', '2025-01-01', '2025-03-31') as btw_q1 \gset
select (public.finalize_vat_return(:'org', 'quarter', 2025, 1, '2025-01-01', '2025-03-31')).id is not null as ok \gset
select (public.finalize_vat_return(:'org', 'quarter', 2025, 2, '2025-04-01', '2025-06-30')).id is not null as ok \gset
select (public.finalize_vat_return(:'org', 'quarter', 2025, 3, '2025-07-01', '2025-09-30')).id is not null as ok \gset
select public.compute_vat_return(:'org', '2025-10-01', '2025-12-31') as btw_q4 \gset
select (public.finalize_vat_return(:'org', 'quarter', 2025, 4, '2025-10-01', '2025-12-31')).id is not null as ok \gset
-- De aangifte over het eerste kwartaal wordt in april betaald.
select (public.create_manual_bank_transaction(:'org', :'bankrekening', '2025-04-25', -16800, 'Belastingdienst', 'NL86INGB0002445588', 'Omzetbelasting Q1')).id as btw_betaling \gset
select (public.book_bank_transaction(:'org', :'btw_betaling', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'ledger', 'account_id', :'rek_btw_schuld', 'amount_cents', 16800)))).id is not null as ok \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk((:'btw_q1'::jsonb -> 'boxes' -> '1a' ->> 'base')::bigint, 100000::bigint, 'btw Q1: rubriek 1a € 1.000 omzet');
select pg_temp.gelijk((:'btw_q1'::jsonb ->> 'saldo')::bigint, 16800::bigint, 'btw Q1: € 210 min € 42 voorbelasting = € 168');
select pg_temp.gelijk((:'btw_q4'::jsonb ->> 'saldo')::bigint, 102900::bigint, 'btw Q4: € 1.050 min € 21 voorbelasting (de privé betaalde factuur telt mee)');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1500'), 0::bigint, 'btw: voorbelasting na de aangiften op nul');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1510'), 0::bigint, 'btw: af te dragen btw na de aangiften op nul');
select pg_temp.gelijk(pg_temp.saldo(:'org', '1530'), -102900::bigint, 'btw: Q4 staat nog open als schuld');

-- ── 7. Rapportages vóór het afsluiten ───────────────────────────────────────

-- Omzet € 6.000, kosten € 300 (€ 200 drukwerk en € 100 visitekaartjes) en
-- € 200 afschrijving: € 5.500 winst.
select pg_temp.als(:'anna_lid');
set local role authenticated;
select coalesce(sum(debit_cents), 0) as sb_debet, coalesce(sum(credit_cents), 0) as sb_credit
from public.report_trial_balance(:'org', '2025-12-31') \gset
select coalesce(sum(case when account_type = 'revenue' then amount_cents else -amount_cents end), 0) as wv_resultaat
from public.report_profit_and_loss(:'org', '2025-01-01', '2025-12-31') \gset
select coalesce(sum(amount_cents) filter (where section = 'asset'), 0) as balans_activa,
       coalesce(sum(amount_cents) filter (where section = 'liability'), 0) as balans_schulden,
       coalesce(sum(amount_cents) filter (where section in ('equity', 'result')), 0) as balans_vermogen,
       coalesce(sum(amount_cents) filter (where section = 'result'), 0) as balans_resultaat
from public.report_balance_sheet(:'org', '2025-12-31') \gset
-- Het jaar ervoor staat nog open: het beginvermogen van 2026 mist de winst.
select public.owners_equity_overview(:'org', :'fy2026') as ov2026_voor \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(:'sb_debet'::bigint, :'sb_credit'::bigint, 'saldibalans: debet en credit gelijk');
select pg_temp.gelijk(:'wv_resultaat'::bigint, 550000::bigint, 'W&V 2025: € 5.500 winst');
select pg_temp.gelijk(:'balans_activa'::bigint, 1715000::bigint, 'balans: € 15.850 bank en € 1.300 laptop');
select pg_temp.gelijk(:'balans_activa'::bigint, :'balans_schulden'::bigint + :'balans_vermogen'::bigint, 'balans: activa = schulden + eigen vermogen');
select pg_temp.gelijk(:'balans_resultaat'::bigint, 550000::bigint, 'balans: het lopende resultaat staat bij het eigen vermogen');
select pg_temp.gelijk((:'ov2026_voor'::jsonb ->> 'openPriorResultCents')::bigint, 550000::bigint,
  'kapitaalvergelijking 2026: zegt dat de winst van 2025 nog niet in het beginvermogen zit');

-- ── 8. Jaarafsluiting ──────────────────────────────────────────────────────

select pg_temp.als(:'anna_lid');
set local role authenticated;
select (public.close_fiscal_year(:'org', :'fy2025')).status as fy2025_status \gset
select coalesce(sum(amount_cents) filter (where section = 'asset'), 0) as na_activa,
       coalesce(sum(amount_cents) filter (where section = 'liability'), 0) as na_schulden,
       coalesce(sum(amount_cents) filter (where section in ('equity', 'result')), 0) as na_vermogen,
       coalesce(sum(amount_cents) filter (where section = 'result'), 0) as na_resultaat
from public.report_balance_sheet(:'org', '2025-12-31') \gset
select public.owners_equity_overview(:'org', :'fy2025') as ov2025 \gset
select public.owners_equity_overview(:'org', :'fy2026') as ov2026 \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(:'fy2025_status', 'closed'::text, 'jaarafsluiting 2025 gelukt');
-- Anna: € 6.000 + € 3.300 winst − € 1.500 opname. Bram: € 4.000 + € 2.200
-- winst + € 2.121 privé (factuur, storting, laptop).
select pg_temp.gelijk(pg_temp.saldo(:'org', '0501'), -780000::bigint, 'jaarafsluiting: kapitaal Anna € 7.800');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0502'), -832100::bigint, 'jaarafsluiting: kapitaal Bram € 8.321');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0551') + pg_temp.saldo(:'org', '0562'), 0::bigint, 'jaarafsluiting: privérekeningen op nul');
select pg_temp.gelijk(pg_temp.saldo(:'org', '0500') + pg_temp.saldo(:'org', '0510'), 0::bigint, 'jaarafsluiting: niets op 0500 of 0510');
select pg_temp.gelijk(pg_temp.saldo(:'org', '4900'), 0::bigint, 'jaarafsluiting: geen afrondingsregel');
select pg_temp.gelijk(:'na_resultaat'::bigint, 0::bigint, 'balans na afsluiten: geen lopend resultaat meer');
select pg_temp.gelijk(:'na_activa'::bigint, :'na_schulden'::bigint + :'na_vermogen'::bigint, 'balans na afsluiten: sluit nog steeds');
select pg_temp.gelijk(:'na_vermogen'::bigint, 1612100::bigint, 'balans na afsluiten: eigen vermogen € 16.121, het kapitaal van de vennoten');

-- ── 9. De kapitaalvergelijking per vennoot ─────────────────────────────────

select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025'::jsonb, 1) ->> 'resultShareCents')::bigint, 330000::bigint, 'kapitaalvergelijking: Anna € 3.300 winst');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025'::jsonb, 1) ->> 'withdrawalsCents')::bigint, 150000::bigint, 'kapitaalvergelijking: Anna € 1.500 opgenomen');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025'::jsonb, 1) ->> 'endCents')::bigint, 780000::bigint, 'kapitaalvergelijking: Anna eindigt op € 7.800');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025'::jsonb, 2) ->> 'contributionsCents')::bigint, 212100::bigint, 'kapitaalvergelijking: Bram € 2.121 ingebracht');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2025'::jsonb, 2) ->> 'endCents')::bigint, 832100::bigint, 'kapitaalvergelijking: Bram eindigt op € 8.321');
select pg_temp.gelijk(:'ov2025'::jsonb -> 'unassigned', 'null'::jsonb, 'kapitaalvergelijking: niets op geen enkele vennoot');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2026'::jsonb, 1) ->> 'beginCents')::bigint, 780000::bigint, 'volgend jaar: Anna begint 2026 met € 7.800');
select pg_temp.gelijk((pg_temp.eigenaar(:'ov2026'::jsonb, 2) ->> 'beginCents')::bigint, 832100::bigint, 'volgend jaar: Bram begint 2026 met € 8.321');
select pg_temp.gelijk((:'ov2026'::jsonb ->> 'openPriorResultCents')::bigint, 0::bigint, 'volgend jaar: geen open resultaat meer van eerdere jaren');

\echo 'Alle controles van vof_administratie.sql geslaagd.'
rollback;
