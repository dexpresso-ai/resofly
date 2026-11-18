-- ============================================================
-- Databasetest: waar de cashflow van de prognose begint
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: forecast_cash_position (20261118171500) haalt het saldo, de
-- openstaande posten, de btw-aangiftes en het betaalgedrag uit een stuk of tien
-- tabellen, als security definer: RLS geldt daar niet, dus elke tabel moet zelf
-- op de organisatie filteren. En een saldo dat net niet klopt, ziet niemand:
-- de cashflow rekent er gewoon mee verder. Deze test zet een administratie op
-- met de functies van het scherm en controleert elk bedrag:
--
--   1. inrichten: bedrijfsgegevens (30 dagen, btw per kwartaal), boekjaren en
--      een beginbalans met bank, spaarrekening en kas;
--   2. drie bankrekeningen: een met een afschrift en mutaties daarna, een
--      zonder afschrift maar met beginbalans en ongeboekte regels, en een die
--      zijn grootboekrekening deelt (onbekend);
--   3. verkoop: een factuur die openstaat, een die half betaald en te laat is,
--      een betaalde (het betaalgedrag) en een concept;
--   4. inkoop: een openstaande, een betaalde en een concept;
--   5. de btw-aangifte van het vorige kwartaal en een betaling aan de
--      Belastingdienst;
--   6. forecast_history: de btw en de afschrijving per maand, ook na de
--      aangifte;
--   7. wie het mag zien: een lezer wel; zonder Financiën, een andere
--      organisatie en anon niet.
-- Alle datums staan ten opzichte van vandaag, zodat de test elke dag werkt.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

-- De hulpjes: als, beheer, gelijk, weigert, saldo en eigenaar.
\ir hulpjes.psql

-- Vandaag zoals de functie het ziet (Europe/Amsterdam), en het vorige kwartaal.
select (now() at time zone 'Europe/Amsterdam')::date as vandaag \gset
select (date_trunc('quarter', :'vandaag'::date) - interval '3 months')::date as vk_begin,
       (date_trunc('quarter', :'vandaag'::date) - interval '1 day')::date as vk_eind \gset
select extract(year from :'vk_begin'::date)::int as vk_jaar,
       extract(quarter from :'vk_begin'::date)::int as vk_nr,
       extract(year from :'vandaag'::date)::int as jaar \gset

-- ── 1. Inrichten ───────────────────────────────────────────────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as lezer, gen_random_uuid() as zonder_financien,
       gen_random_uuid() as ander \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',         'eigenaar@vooruit.test',         'authenticated', 'authenticated'),
  (:'lezer',            'lezer@vooruit.test',            'authenticated', 'authenticated'),
  (:'zonder_financien', 'zonder-financien@vooruit.test', 'authenticated', 'authenticated'),
  (:'ander',            'ander@elders.test',             'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Vooruit')).id as org \gset
reset role;
select pg_temp.als(:'ander');
set local role authenticated;
select (public.create_organization('Elders BV')).id as ander_org \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org', :'ander_org');
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'lezer',            'lezer@vooruit.test',            'member', 'active', '{"finance":"read"}'::jsonb),
  (:'org', :'zonder_financien', 'zonder-financien@vooruit.test', 'member', 'active', '{"finance":"none"}'::jsonb);

insert into public.company_settings (organization_id, created_by, company_name, legal_form, kor_enabled, vat_return_period,
                                     bookkeeping_start_date, fiscal_year_start_month, year_result_account_code,
                                     invoice_payment_terms)
values (:'org', :'eigenaar', 'Bureau Vooruit', 'eenmanszaak', false, 'quarterly', :'vk_begin', 1, '0500',
        'Betalen binnen 30 dagen na factuurdatum');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'org') is null as ok \gset
select (public.open_fiscal_year(:'org', make_date(:vk_jaar, 1, 1), make_date(:vk_jaar, 12, 31))).id is not null as ok \gset
reset role;
select pg_temp.beheer();
-- Ligt het vorige kwartaal in vorig jaar (vandaag is januari t/m maart), dan
-- ook het boekjaar van nu.
select pg_temp.als(:'eigenaar');
set local role authenticated;
select count(*) as extra_jaar from (
  select public.open_fiscal_year(:'org', make_date(:jaar, 1, 1), make_date(:jaar, 12, 31))
   where :jaar <> :vk_jaar
) x \gset
reset role;
select pg_temp.beheer();

-- Een spaarrekening met een eigen grootboekrekening, en de kas.
insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
values (:'org', '1110', 'Spaarrekening', 'asset', 'bank', false)
on conflict (organization_id, code) do nothing;
insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
values (:'org', '1000', 'Kas', 'asset', 'cash', false)
on conflict (organization_id, code) do nothing;
update public.ledger_accounts set subtype = 'cash' where organization_id = :'org' and code = '1000';

select id as rek_bank from public.ledger_accounts where organization_id = :'org' and code = '1100' \gset
select id as rek_spaar from public.ledger_accounts where organization_id = :'org' and code = '1110' \gset
select id as rek_kosten from public.ledger_accounts where organization_id = :'org' and code = '4500' \gset

select pg_temp.als(:'eigenaar');
set local role authenticated;
-- € 10.000 op de bank, € 5.000 op de spaarrekening, € 250 in de kas.
select public.create_opening_balance(:'org', :'vk_begin', '[
  {"account_code": "1100", "debit_cents": 1000000},
  {"account_code": "1110", "debit_cents": 500000},
  {"account_code": "1000", "debit_cents": 25000},
  {"account_code": "0500", "credit_cents": 1525000}
]'::jsonb) is not null as ok \gset
reset role;
select pg_temp.beheer();

-- ── 2. Drie bankrekeningen ─────────────────────────────────────────────────

insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
values (:'org', :'eigenaar', 'Zakelijke rekening', 'NL91ABNA0417164300', 'EUR', :'rek_bank', true, 'import')
returning id as bank_a \gset
insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
values (:'org', :'eigenaar', 'Spaarrekening', 'NL02ABNA0123456789', 'EUR', :'rek_spaar', true, 'import')
returning id as bank_b \gset
-- Deelt 1100 met de zakelijke rekening: de stand van 1100 is de som van
-- allebei, dus voor deze rekening alleen is er geen saldo te geven.
insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
values (:'org', :'eigenaar', 'Oude rekening', 'NL13ABNA0987654321', 'EUR', :'rek_bank', true, 'import')
returning id as bank_c \gset

-- Rekening A: het afschrift zegt € 8.000 op 20 dagen geleden. Daarna: € 500
-- erbij, € 200 eraf, en € 456 naar de Belastingdienst. Een handmatige mutatie
-- is geen bankregel en telt niet.
insert into public.bank_statements (organization_id, created_by, bank_account_id, format, file_name, period_start, period_end,
                                    opening_balance_cents, closing_balance_cents, transaction_count)
values (:'org', :'eigenaar', :'bank_a', 'camt053', 'afschrift.xml', :'vk_begin', :'vandaag'::date - 20, 1000000, 800000, 0);
insert into public.bank_transactions (organization_id, bank_account_id, dedup_key, booking_date, amount_cents,
                                      counterparty_name, counterparty_iban, description, status) values
  (:'org', :'bank_a', 'a-1', :'vandaag'::date - 10, 50000, 'Klant', null, 'Betaling', 'unmatched'),
  (:'org', :'bank_a', 'a-2', :'vandaag'::date - 5, -20000, 'Leverancier', null, 'Inkoop', 'unmatched'),
  (:'org', :'bank_a', 'a-3', :'vandaag'::date - 7, -45600, 'Belastingdienst', 'NL86 INGB 0002 4455 88', 'Omzetbelasting', 'unmatched'),
  -- Vóór het afschrift: zit al in het eindsaldo.
  (:'org', :'bank_a', 'a-0', :'vandaag'::date - 25, 77700, 'Klant', null, 'Eerder', 'unmatched');
insert into public.bank_transactions (organization_id, bank_account_id, dedup_key, booking_date, amount_cents,
                                      counterparty_name, description, status, is_manual) values
  (:'org', :'bank_a', 'a-handmatig', :'vandaag'::date - 3, 99900, 'Contant', 'Handmatig', 'unmatched', true);

-- Rekening B: geen afschrift, wel een beginbalans van € 5.000 op 1110 en twee
-- bankregels die nog niet geboekt zijn (een genegeerde telt ook: die staat
-- wel op de bank).
insert into public.bank_transactions (organization_id, bank_account_id, dedup_key, booking_date, amount_cents,
                                      counterparty_name, description, status) values
  (:'org', :'bank_b', 'b-1', :'vandaag'::date - 2, 10000, 'Rente', 'Rente', 'unmatched'),
  (:'org', :'bank_b', 'b-2', :'vandaag'::date - 4, -3000, 'Eigen rekening', 'Overboeking', 'ignored');

-- ── 3. Verkoop ─────────────────────────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Noord', 'noord@klant.test', 'business')
returning id as klant \gset

-- R1: vandaag, € 1.000 + 21%, vervalt over 25 dagen: staat helemaal open.
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'eigenaar', :'klant', 'F-001', :'vandaag', :'vandaag'::date + 25, 'draft',
        '[{"id": "r1", "description": "Advies", "quantity": 1, "unit_price": 1000, "vat": 21}]'::jsonb)
returning id as r1 \gset
-- R2: vorig kwartaal, € 500 + 21% = € 605, te laat en voor € 105 betaald.
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'eigenaar', :'klant', 'F-002', :'vk_begin'::date + 3, :'vk_begin'::date + 17, 'draft',
        '[{"id": "r2", "description": "Ontwerp", "quantity": 1, "unit_price": 500, "vat": 21}]'::jsonb)
returning id as r2 \gset
-- R3: vorig kwartaal, € 2.000 + 21% = € 2.420, na 15 dagen betaald.
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'eigenaar', :'klant', 'F-003', :'vk_begin'::date + 5, :'vk_begin'::date + 35, 'draft',
        '[{"id": "r3", "description": "Website", "quantity": 1, "unit_price": 2000, "vat": 21}]'::jsonb)
returning id as r3 \gset
-- Een concept: telt nergens.
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'eigenaar', :'klant', 'F-004', :'vandaag', :'vandaag'::date + 30, 'draft',
        '[{"id": "r4", "description": "Nog niet verstuurd", "quantity": 1, "unit_price": 9999, "vat": 21}]'::jsonb);
reset role;
select pg_temp.beheer();

-- Versturen doet invoice-workflow (als service-role); dan gaan ze naar het grootboek.
update public.invoices set status = 'sent', sent_at = date::timestamptz + interval '9 hours'
 where id in (:'r1', :'r2', :'r3');
select pg_temp.gelijk((select count(*) from public.invoices where id in (:'r1', :'r2', :'r3') and journal_entry_id is not null),
  3::bigint, 'verkoop: verstuurde facturen staan in het grootboek');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_manual_bank_transaction(:'org', :'bank_a', :'vk_begin'::date + 20, 242000, 'Klant Noord', null, 'F-003')).id as betaling_r3 \gset
select (public.book_bank_transaction(:'org', :'betaling_r3', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'sales_invoice', 'invoice_id', :'r3', 'amount_cents', 242000)))).id is not null as ok \gset
select (public.create_manual_bank_transaction(:'org', :'bank_a', :'vk_begin'::date + 30, 10500, 'Klant Noord', null, 'F-002 deel')).id as betaling_r2 \gset
select (public.book_bank_transaction(:'org', :'betaling_r2', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'sales_invoice', 'invoice_id', :'r2', 'amount_cents', 10500)))).id is not null as ok \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select status from public.invoices where id = :'r3'), 'paid', 'verkoop: R3 is betaald');
select pg_temp.gelijk((select status from public.invoices where id = :'r2'), 'sent', 'verkoop: R2 staat nog open');

-- ── 4. Inkoop ──────────────────────────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
insert into public.suppliers (organization_id, created_by, name, iban)
values (:'org', :'eigenaar', 'Drukkerij Zuid', 'NL44RABO0123456788')
returning id as leverancier \gset
-- P1: vandaag, € 500 + € 105, vervalt over 15 dagen.
insert into public.purchase_invoices (organization_id, created_by, supplier_id, supplier_invoice_number, date, due_date,
                                      subtotal_cents, vat_cents, total_cents, currency, status, lines)
values (:'org', :'eigenaar', :'leverancier', 'DZ-1', :'vandaag', :'vandaag'::date + 15, 50000, 10500, 60500, 'EUR', 'draft',
        jsonb_build_array(jsonb_build_object('id', 'p1', 'description', 'Drukwerk', 'amount_cents', 50000,
                                             'vat_code', 'HOOG', 'vat_rate', 21, 'account_id', :'rek_kosten')))
returning id as p1 \gset
select (public.book_purchase_invoice(:'org', :'p1')).id is not null as ok \gset
-- P3: vorig kwartaal, € 200 + € 42, betaald.
insert into public.purchase_invoices (organization_id, created_by, supplier_id, supplier_invoice_number, date, due_date,
                                      subtotal_cents, vat_cents, total_cents, currency, status, lines)
values (:'org', :'eigenaar', :'leverancier', 'DZ-3', :'vk_begin'::date + 8, :'vk_begin'::date + 22, 20000, 4200, 24200, 'EUR', 'draft',
        jsonb_build_array(jsonb_build_object('id', 'p3', 'description', 'Papier', 'amount_cents', 20000,
                                             'vat_code', 'HOOG', 'vat_rate', 21, 'account_id', :'rek_kosten')))
returning id as p3 \gset
select (public.book_purchase_invoice(:'org', :'p3')).id is not null as ok \gset
select (public.create_manual_bank_transaction(:'org', :'bank_a', :'vk_begin'::date + 22, -24200, 'Drukkerij Zuid', 'NL44RABO0123456788', 'DZ-3')).id as betaling_p3 \gset
select (public.book_bank_transaction(:'org', :'betaling_p3', p_allocations => jsonb_build_array(
  jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', :'p3', 'amount_cents', 24200)))).id is not null as ok \gset
-- Een concept: nog geen schuld.
insert into public.purchase_invoices (organization_id, created_by, supplier_id, supplier_invoice_number, date, due_date,
                                      subtotal_cents, vat_cents, total_cents, currency, status, lines)
values (:'org', :'eigenaar', :'leverancier', 'DZ-concept', :'vandaag', :'vandaag'::date + 10, 88800, 0, 88800, 'EUR', 'draft', '[]'::jsonb);

-- Afschrijving in de eerste maand van het vorige kwartaal: € 25.
select public.post_journal_entry(:'org', :'vk_begin'::date + 25, 'Afschrijving laptop', 'manual', null,
  '[{"account_code": "4000", "debit_cents": 2500}, {"account_code": "0150", "credit_cents": 2500}]'::jsonb) is not null as ok \gset

-- ── 5. De btw-aangifte van het vorige kwartaal ─────────────────────────────

select (public.finalize_vat_return(:'org', 'quarter', :vk_jaar, :vk_nr, :'vk_begin', :'vk_eind')).id as aangifte \gset
reset role;
select pg_temp.beheer();

-- € 105 + € 420 btw op R2 en R3, min € 42 voorbelasting op P3.
select pg_temp.gelijk((select (rubrieken ->> 'saldo_afgerond')::bigint from public.vat_returns where id = :'aangifte'),
  48300::bigint, 'btw: de aangifte van het vorige kwartaal is € 483');

-- ── De cashpositie ─────────────────────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.forecast_cash_position(:'org') as pos \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(:'pos'::jsonb ->> 'today', to_char(:'vandaag'::date, 'YYYY-MM-DD'), 'positie: vandaag in Amsterdam');
select pg_temp.gelijk(jsonb_array_length(:'pos'::jsonb -> 'bank'), 3, 'bank: drie actieve rekeningen');
select pg_temp.gelijk((select b from jsonb_array_elements(:'pos'::jsonb -> 'bank') b where b ->> 'name' = 'Zakelijke rekening'),
  jsonb_build_object('name', 'Zakelijke rekening', 'balance_cents', 784400, 'method', 'statement',
                     'as_of', to_char(:'vandaag'::date - 5, 'YYYY-MM-DD')),
  'bank A: € 8.000 volgens het afschrift, + € 500 − € 200 − € 456 daarna (de handmatige mutatie niet)');
select pg_temp.gelijk((select b from jsonb_array_elements(:'pos'::jsonb -> 'bank') b where b ->> 'name' = 'Spaarrekening'),
  jsonb_build_object('name', 'Spaarrekening', 'balance_cents', 507000, 'method', 'ledger',
                     'as_of', to_char(:'vandaag'::date, 'YYYY-MM-DD')),
  'bank B: € 5.000 beginbalans + € 100 rente − € 30 genegeerd, nog niet geboekt');
select pg_temp.gelijk((select b from jsonb_array_elements(:'pos'::jsonb -> 'bank') b where b ->> 'name' = 'Oude rekening'),
  jsonb_build_object('name', 'Oude rekening', 'balance_cents', null, 'method', null, 'as_of', null),
  'bank C: deelt 1100 en heeft geen afschrift: onbekend');
select pg_temp.gelijk((:'pos'::jsonb ->> 'cash_accounts_cents')::bigint, 25000::bigint, 'kas: € 250');

select pg_temp.gelijk(:'pos'::jsonb -> 'receivables',
  jsonb_build_array(
    jsonb_build_object('month', to_char(:'vk_begin'::date + 17, 'YYYY-MM'), 'cents', 50000, 'count', 1),
    jsonb_build_object('month', to_char(:'vandaag'::date + 25, 'YYYY-MM'), 'cents', 121000, 'count', 1)),
  'debiteuren: R2 (€ 605 − € 105, te laat) en R1 (€ 1.210); R3 betaald en het concept tellen niet');
select pg_temp.gelijk(:'pos'::jsonb -> 'payables',
  jsonb_build_array(jsonb_build_object('month', to_char(:'vandaag'::date + 15, 'YYYY-MM'), 'cents', 60500, 'count', 1)),
  'crediteuren: P1 (€ 605); P3 betaald en het concept tellen niet');

select pg_temp.gelijk((select r - 'period_end' from jsonb_array_elements(:'pos'::jsonb -> 'vat_returns') r),
  jsonb_build_object('period_type', 'quarter', 'year', :vk_jaar, 'index', :vk_nr, 'status',
                     (select status from public.vat_returns where id = :'aangifte'), 'saldo_cents', 48300),
  'btw: de aangifte van het vorige kwartaal, met status en saldo');
select pg_temp.gelijk(:'pos'::jsonb -> 'tax_payments',
  jsonb_build_array(jsonb_build_object('date', to_char(:'vandaag'::date - 7, 'YYYY-MM-DD'), 'cents', 45600)),
  'btw: de betaling aan de Belastingdienst (herkend aan de inningsrekening)');
select pg_temp.gelijk(:'pos'::jsonb ->> 'vat_frequency', 'quarterly', 'btw: per kwartaal');
select pg_temp.gelijk((:'pos'::jsonb ->> 'kor')::boolean, false, 'btw: geen KOR');
select pg_temp.gelijk((:'pos'::jsonb ->> 'payment_terms_days')::int, 30, 'betaaltermijn: "binnen 30 dagen" is 30');
select pg_temp.gelijk(:'pos'::jsonb -> 'collection', '{"paid_count": 1, "days": 15.0}'::jsonb,
  'betaalgedrag: R3 betaald na 15 dagen (de bankdatum, niet het moment van afletteren)');

-- ── 6. forecast_history: btw en afschrijving per maand ─────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.forecast_history(:'org', :'vk_begin', :'vandaag') as hist \gset
reset role;
select pg_temp.beheer();

select m as maand_vk from jsonb_array_elements(:'hist'::jsonb -> 'months') m
 where m ->> 'month' = to_char(:'vk_begin'::date, 'YYYY-MM') \gset
select m as maand_nu from jsonb_array_elements(:'hist'::jsonb -> 'months') m
 where m ->> 'month' = to_char(:'vandaag'::date, 'YYYY-MM') \gset

select pg_temp.gelijk((:'maand_vk'::jsonb ->> 'vat_out_cents')::bigint, 52500::bigint, 'historie: btw op de facturen van het vorige kwartaal');
select pg_temp.gelijk((:'maand_vk'::jsonb ->> 'vat_in_cents')::bigint, 4200::bigint, 'historie: btw op de inkoop van het vorige kwartaal');
select pg_temp.gelijk((:'maand_vk'::jsonb ->> 'ledger_vat_out_cents')::bigint, 52500::bigint,
  'historie: de btw in de boekhouding, ook nu de aangifte hem naar 1530 zette');
select pg_temp.gelijk((:'maand_vk'::jsonb ->> 'ledger_vat_in_cents')::bigint, 4200::bigint, 'historie: de voorbelasting in de boekhouding');
select pg_temp.gelijk((:'maand_vk'::jsonb ->> 'ledger_depreciation_cents')::bigint, 2500::bigint, 'historie: € 25 afschrijving');
select pg_temp.gelijk((:'maand_nu'::jsonb ->> 'vat_out_cents')::bigint, 21000::bigint, 'historie: btw op R1 deze maand');
select pg_temp.gelijk((:'maand_nu'::jsonb ->> 'vat_in_cents')::bigint, 10500::bigint, 'historie: btw op P1 deze maand');
select pg_temp.gelijk((:'maand_nu'::jsonb ->> 'ledger_vat_out_cents')::bigint, 21000::bigint, 'historie: btw op R1 in de boekhouding');
select pg_temp.gelijk((:'maand_nu'::jsonb ->> 'ledger_depreciation_cents')::bigint, 0::bigint, 'historie: geen afschrijving deze maand');

-- ── 7. Wie het mag zien ────────────────────────────────────────────────────

select pg_temp.als(:'lezer');
set local role authenticated;
select (public.forecast_cash_position(:'org') ->> 'payment_terms_days')::int as lezer_ziet \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:lezer_ziet, 30, 'rechten: een lezer van Financiën ziet de cashpositie');

select pg_temp.als(:'zonder_financien');
set local role authenticated;
select pg_temp.weigert(format('select public.forecast_cash_position(%L)', :'org'), 'Geen leesrechten', 'rechten: zonder Financiën geweigerd');
reset role;
select pg_temp.als(:'ander');
set local role authenticated;
select pg_temp.weigert(format('select public.forecast_cash_position(%L)', :'org'), 'Geen leesrechten', 'rechten: een andere organisatie geweigerd');
-- Haar eigen organisatie: niets van Bureau Vooruit.
select public.forecast_cash_position(:'ander_org') as elders \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'elders'::jsonb -> 'bank', '[]'::jsonb, 'rechten: de andere organisatie ziet geen rekeningen van een ander');
select pg_temp.gelijk(:'elders'::jsonb -> 'receivables', '[]'::jsonb, 'rechten: en geen facturen van een ander');

select pg_temp.gelijk(has_function_privilege('anon', 'public.forecast_cash_position(uuid)', 'execute'), false,
  'rechten: anon mag de functie niet aanroepen');
select pg_temp.gelijk(has_function_privilege('authenticated', 'public.forecast_cash_position(uuid)', 'execute'), true,
  'rechten: een ingelogde gebruiker wel (de functie controleert zelf de organisatie)');

\echo 'Alle controles van prognose_cashflow.sql geslaagd.'
rollback;
