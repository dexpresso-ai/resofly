-- ============================================================
-- Databasetest: bankbetalingen vanzelf koppelen aan inkoopfacturen
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: de matcher (bank_match_run, 20261118190000) boekt zonder mens zodra
-- hij zeker is. Een te gretige matcher boekt dus stil de verkeerde factuur af,
-- en een matcher die over de organisatiegrens kijkt, nog erger. Deze test zet
-- een administratie op met de functies van het scherm en loopt elke weg na:
--
--   1. incasso op IBAN met een bankregel ernaast (de factuur wint);
--   2. pinbetaling op de naam van de tegenpartij;
--   3. verzamelbetaling: de twee oudste facturen van één leverancier;
--   4. abonnement: twee facturen met hetzelfde bedrag (voorstel, de oudste);
--   5. nummer in de omschrijving: precies (geboekt) en een deelbetaling;
--   6. alleen het bedrag (voorstel), en de tweede betaling van hetzelfde bedrag;
--   7. factuur min creditnota van de leverancier in één betaling;
--   8. eerst de betaling, dan de factuur (de trigger bij het boeken);
--   9. terugdraaien: daarna nooit meer vanzelf, ook niet bij een bankregel;
--  10. een rekening met automatisch boeken uit;
--  11. een IBAN geleerd van een eerdere betaling, via het inlezen;
--  12. een tegengeboekte factuur verdwijnt uit het voorstel;
--  13. een andere organisatie en wie het mag.
-- Alle datums staan ten opzichte van vandaag, zodat de test elke dag werkt.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select (now() at time zone 'Europe/Amsterdam')::date as vandaag \gset
select extract(year from :'vandaag'::date)::int as jaar \gset

-- ── Inrichten ──────────────────────────────────────────────────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as lezer, gen_random_uuid() as zonder_financien,
       gen_random_uuid() as ander \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',         'eigenaar@inkoop.test',         'authenticated', 'authenticated'),
  (:'lezer',            'lezer@inkoop.test',            'authenticated', 'authenticated'),
  (:'zonder_financien', 'zonder-financien@inkoop.test', 'authenticated', 'authenticated'),
  (:'ander',            'ander@elders.test',            'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Inkoop')).id as org \gset
reset role;
select pg_temp.als(:'ander');
set local role authenticated;
select (public.create_organization('Elders BV')).id as ander_org \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org', :'ander_org');
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'lezer',            'lezer@inkoop.test',            'member', 'active', '{"finance":"read"}'::jsonb),
  (:'org', :'zonder_financien', 'zonder-financien@inkoop.test', 'member', 'active', '{"finance":"none"}'::jsonb);

insert into public.company_settings (organization_id, created_by, company_name, legal_form, kor_enabled, vat_return_period,
                                     bookkeeping_start_date, fiscal_year_start_month, year_result_account_code)
values (:'org', :'eigenaar', 'Bureau Inkoop', 'eenmanszaak', false, 'quarterly', make_date(:jaar - 1, 1, 1), 1, '0500'),
       (:'ander_org', :'ander', 'Elders BV', 'eenmanszaak', false, 'quarterly', make_date(:jaar - 1, 1, 1), 1, '0500');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'org') is null as ok \gset
select (public.open_fiscal_year(:'org', make_date(:jaar - 1, 1, 1), make_date(:jaar - 1, 12, 31))).id is not null as ok \gset
select (public.open_fiscal_year(:'org', make_date(:jaar, 1, 1), make_date(:jaar, 12, 31))).id is not null as ok \gset
reset role;
select pg_temp.als(:'ander');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'ander_org') is null as ok \gset
select (public.open_fiscal_year(:'ander_org', make_date(:jaar - 1, 1, 1), make_date(:jaar - 1, 12, 31))).id is not null as ok \gset
select (public.open_fiscal_year(:'ander_org', make_date(:jaar, 1, 1), make_date(:jaar, 12, 31))).id is not null as ok \gset
reset role;
select pg_temp.beheer();

select id as rek_bank from public.ledger_accounts where organization_id = :'org' and code = '1100' \gset
select id as rek_kosten from public.ledger_accounts where organization_id = :'org' and code = '4500' \gset
select id as ander_rek_bank from public.ledger_accounts where organization_id = :'ander_org' and code = '1100' \gset
select id as ander_rek_kosten from public.ledger_accounts where organization_id = :'ander_org' and code = '4500' \gset

-- Een spaarrekening met een eigen grootboekrekening: daar staat automatisch
-- boeken uit.
insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
values (:'org', '1110', 'Spaarrekening', 'asset', 'bank', false)
on conflict (organization_id, code) do nothing;
select id as rek_spaar from public.ledger_accounts where organization_id = :'org' and code = '1110' \gset

insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
values (:'org', :'eigenaar', 'Zakelijke rekening', 'NL91ABNA0417164300', 'EUR', :'rek_bank', true, 'import')
returning id as bank \gset
insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source, auto_book_purchase_invoices)
values (:'org', :'eigenaar', 'Spaarrekening', 'NL02ABNA0123456789', 'EUR', :'rek_spaar', true, 'import', false)
returning id as spaar \gset
insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
values (:'ander_org', :'ander', 'Rekening elders', 'NL13ABNA0987654321', 'EUR', :'ander_rek_bank', true, 'import')
returning id as ander_bank \gset

select pg_temp.gelijk((select auto_book_purchase_invoices from public.bank_accounts where id = :'bank'), true,
  'instelling: automatisch boeken staat standaard aan');

-- Een inkoopfactuur van € <basis> + 21% maken en boeken, als de eigenaar.
create function pg_temp.inkoop(p_org uuid, p_user uuid, p_supplier uuid, p_nummer text, p_datum date, p_basis bigint, p_rekening uuid)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  insert into public.purchase_invoices (organization_id, created_by, supplier_id, supplier_invoice_number, date, due_date,
                                        subtotal_cents, vat_cents, total_cents, currency, status, lines)
  values (p_org, p_user, p_supplier, p_nummer, p_datum, p_datum + 14,
          p_basis, round(p_basis * 0.21), p_basis + round(p_basis * 0.21), 'EUR', 'draft',
          jsonb_build_array(jsonb_build_object('id', 'r1', 'description', 'Inkoop', 'amount_cents', p_basis,
                                               'vat_code', 'HOOG', 'vat_rate', 21, 'account_id', p_rekening)))
  returning id into v_id;
  perform public.book_purchase_invoice(p_org, v_id);
  reset role;
  perform pg_temp.beheer();
  return v_id;
end $$;

-- Een bankregel zoals het afschrift hem levert (nog niet gematcht).
create function pg_temp.bankregel(p_org uuid, p_bank uuid, p_sleutel text, p_datum date, p_bedrag bigint,
                                  p_naam text, p_iban text, p_omschrijving text)
returns uuid language sql as $$
  insert into public.bank_transactions (organization_id, bank_account_id, dedup_key, booking_date, amount_cents,
                                        counterparty_name, counterparty_iban, description, status)
  values (p_org, p_bank, p_sleutel, p_datum, p_bedrag, p_naam, p_iban, p_omschrijving, 'unmatched')
  returning id
$$;

-- Matchen als de eigenaar, zoals de knop "Opnieuw matchen".
create function pg_temp.matchen(p_org uuid, p_user uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  v := public.match_bank_transactions(p_org);
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

create function pg_temp.tx(p_id uuid) returns public.bank_transactions language sql as $$
  select * from public.bank_transactions where id = p_id
$$;

-- Op welke inkoopfacturen deze transactie geboekt is, met bedrag (bankrichting).
create function pg_temp.verdeling(p_id uuid) returns text language sql as $$
  select coalesce(string_agg(coalesce(pi.supplier_invoice_number, a.kind) || '=' || a.amount_cents, ', ' order by a.position), '')
  from public.bank_transactions t
  join public.bank_transaction_allocations a on a.bank_transaction_id = t.id and a.journal_entry_id = t.journal_entry_id
  left join public.purchase_invoices pi on pi.id = a.purchase_invoice_id
  where t.id = p_id
$$;

-- ── Leveranciers en hun facturen ───────────────────────────────────────────

insert into public.suppliers (organization_id, created_by, name, iban, default_expense_account_id, default_vat_code) values
  (:'org', :'eigenaar', 'KPN B.V.',                  'NL02 KPNB 0123 4567 89', :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Drukkerij Zuid',            null,                     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Hornbach Bouwmarkt B.V.',   null,                     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Cloudly',                   'NL55CLOU0000000055',     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Zeta Trading',              null,                     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Onbekend Leverancier',      null,                     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Adviesbureau Noord',        null,                     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Later BV',                  'NL66LATE0000000066',     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Schoonmaak Snel',           'NL88SCHO0000000088',     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Glazenwasser Jan',          null,                     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Netto BV',                  'NL99NETT0000000099',     :'rek_kosten', 'HOOG'),
  (:'org', :'eigenaar', 'Fietskoerier Snel',         null,                     :'rek_kosten', 'HOOG');
select id as kpn from public.suppliers where organization_id = :'org' and name = 'KPN B.V.' \gset
select id as druk from public.suppliers where organization_id = :'org' and name = 'Drukkerij Zuid' \gset
select id as horn from public.suppliers where organization_id = :'org' and name = 'Hornbach Bouwmarkt B.V.' \gset
select id as cloud from public.suppliers where organization_id = :'org' and name = 'Cloudly' \gset
select id as zeta from public.suppliers where organization_id = :'org' and name = 'Zeta Trading' \gset
select id as onbekend from public.suppliers where organization_id = :'org' and name = 'Onbekend Leverancier' \gset
select id as advies from public.suppliers where organization_id = :'org' and name = 'Adviesbureau Noord' \gset
select id as later from public.suppliers where organization_id = :'org' and name = 'Later BV' \gset
select id as schoon from public.suppliers where organization_id = :'org' and name = 'Schoonmaak Snel' \gset
select id as glas from public.suppliers where organization_id = :'org' and name = 'Glazenwasser Jan' \gset
select id as netto from public.suppliers where organization_id = :'org' and name = 'Netto BV' \gset
select id as fiets from public.suppliers where organization_id = :'org' and name = 'Fietskoerier Snel' \gset

-- De andere organisatie: dezelfde KPN, hetzelfde IBAN en een factuur van
-- precies hetzelfde bedrag. Mag nergens meedoen.
insert into public.suppliers (organization_id, created_by, name, iban, default_expense_account_id)
values (:'ander_org', :'ander', 'KPN B.V.', 'NL02KPNB0123456789', :'ander_rek_kosten')
returning id as ander_kpn \gset

select pg_temp.inkoop(:'org', :'eigenaar', :'kpn',      'KPN-778899',  :'vandaag'::date - 20, 3000,  :'rek_kosten') as k1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'druk',     'DZ-1',        :'vandaag'::date - 40, 10000, :'rek_kosten') as d1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'druk',     'DZ-2',        :'vandaag'::date - 30, 20000, :'rek_kosten') as d2 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'druk',     'DZ-3',        :'vandaag'::date - 20, 5000,  :'rek_kosten') as d3 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'horn',     'BON-4411',    :'vandaag'::date - 3,  4000,  :'rek_kosten') as h1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'cloud',    'CL-2026-09',  :'vandaag'::date - 60, 1000,  :'rek_kosten') as c1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'cloud',    'CL-2026-10',  :'vandaag'::date - 30, 1000,  :'rek_kosten') as c2 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'zeta',     'ZT-98765',    :'vandaag'::date - 15, 50000, :'rek_kosten') as z1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'onbekend', 'OL-55',       :'vandaag'::date - 10, 6427,  :'rek_kosten') as a1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'advies',   '2026-0815',   :'vandaag'::date - 12, 80000, :'rek_kosten') as r1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'schoon',   'SS-12',       :'vandaag'::date - 9,  7000,  :'rek_kosten') as s1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'glas',     'GJ-1',        :'vandaag'::date - 50, 3100,  :'rek_kosten') as g1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'netto',    'NB-1001',     :'vandaag'::date - 8,  10000, :'rek_kosten') as n1 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'netto',    'NB-CN-7',     :'vandaag'::date - 7,  -2000, :'rek_kosten') as n2 \gset
select pg_temp.inkoop(:'org', :'eigenaar', :'fiets',    'FK-1',        :'vandaag'::date - 10, 3500,  :'rek_kosten') as f1 \gset
select pg_temp.inkoop(:'ander_org', :'ander', :'ander_kpn', 'KPN-ANDER', :'vandaag'::date - 20, 3000, :'ander_rek_kosten') as ander_k1 \gset

select pg_temp.gelijk((select public.purchase_invoice_open_payable_cents(:'org', :'k1')), 3630::bigint, 'inkoop: KPN staat open voor € 36,30');
select pg_temp.gelijk((select public.purchase_invoice_open_payable_cents(:'org', :'n2')), -2420::bigint, 'inkoop: de creditnota van Netto staat op − € 24,20');

-- Een bankregel voor KPN met "automatisch boeken" op 4500. Die mag de
-- betaling van een geboekte KPN-factuur niet als kosten boeken.
insert into public.bank_rules (organization_id, created_by, name, priority, match_direction, match_counterparty_name_contains,
                               target_account_id, target_vat_code, auto_book, is_active)
values (:'org', :'eigenaar', 'KPN', 10, 'out', 'KPN', :'rek_kosten', 'HOOG', true, true);

-- ── De bankregels ──────────────────────────────────────────────────────────

select pg_temp.bankregel(:'org', :'bank', 't-kpn',    :'vandaag'::date - 5, -3630,  'KPN B.V.', 'NL02KPNB0123456789', 'Incasso 4410023 klantnr 99') as t_kpn \gset
select pg_temp.bankregel(:'org', :'bank', 't-kpn2',   :'vandaag'::date - 4, -1500,  'KPN B.V.', 'NL02KPNB0123456789', 'Incasso extra bundel') as t_kpn2 \gset
select pg_temp.bankregel(:'org', :'bank', 't-druk',   :'vandaag'::date - 5, -36300, 'DRUKKERIJ ZUID', null, 'Facturen') as t_druk \gset
select pg_temp.bankregel(:'org', :'bank', 't-horn',   :'vandaag'::date - 2, -4840,  'HORNBACH BOUWMARKT 123 DEN HAAG', null, 'BEA, Google Pay') as t_horn \gset
select pg_temp.bankregel(:'org', :'bank', 't-cloud1', :'vandaag'::date - 6, -1210,  'Cloudly', 'NL55CLOU0000000055', 'Abonnement') as t_cloud1 \gset
select pg_temp.bankregel(:'org', :'bank', 't-cloud2', :'vandaag'::date - 5, -1210,  'Cloudly', 'NL55CLOU0000000055', 'Abonnement') as t_cloud2 \gset
select pg_temp.bankregel(:'org', :'bank', 't-zeta',   :'vandaag'::date - 4, -20000, 'Z. Trading Ltd', null, 'Betaling ZT-98765 eerste deel') as t_zeta \gset
select pg_temp.bankregel(:'org', :'bank', 't-paypal', :'vandaag'::date - 3, -7777,  'PAYPAL EUROPE', 'LU89751000135104200E', 'Bestelling 5566') as t_paypal \gset
select pg_temp.bankregel(:'org', :'bank', 't-advies', :'vandaag'::date - 3, -96800, 'A. Noord', 'NL12INGB0001234567', 'Factuur 2026-0815') as t_advies \gset
select pg_temp.bankregel(:'org', :'bank', 't-later',  :'vandaag'::date - 2, -2420,  'Later BV', 'NL66LATE0000000066', 'Vooruitbetaling') as t_later \gset
select pg_temp.bankregel(:'org', :'spaar','t-schoon', :'vandaag'::date - 2, -8470,  'Schoonmaak Snel', 'NL88SCHO0000000088', 'Schoonmaak') as t_schoon \gset
select pg_temp.bankregel(:'org', :'bank', 't-glas',   :'vandaag'::date - 30, -3751, 'J. Jansen', 'NL77GLAS0000000001', 'Ramen') as t_glas \gset
select pg_temp.bankregel(:'org', :'bank', 't-netto',  :'vandaag'::date - 1, -9680,  'Netto', null, 'NB-1001 min creditnota NB-CN-7') as t_netto \gset
-- Een vroege betaling van € 42,35 zonder herkenbare tegenpartij (alleen het
-- bedrag past op FK-1), en een latere van de fietskoerier zelf: die is zeker.
select pg_temp.bankregel(:'org', :'bank', 't-vroeg',  :'vandaag'::date - 9, -4235,  'Onbekend', null, 'Rit') as t_vroeg \gset
select pg_temp.bankregel(:'org', :'bank', 't-fiets',  :'vandaag'::date - 1, -4235,  'Fietskoerier Snel', null, 'Ritten oktober') as t_fiets \gset
-- De andere organisatie: een betaling aan haar KPN, net als bij ons.
select pg_temp.bankregel(:'ander_org', :'ander_bank', 'a-kpn', :'vandaag'::date - 5, -3630, 'KPN B.V.', 'NL02KPNB0123456789', 'Incasso') as ander_t \gset

-- ── Matchen ────────────────────────────────────────────────────────────────

select pg_temp.matchen(:'org', :'eigenaar') as uitslag \gset
\o
\echo uitslag eerste ronde: :uitslag
\o /dev/null

-- 1. Incasso op IBAN, ondanks de bankregel.
select pg_temp.gelijk((pg_temp.tx(:'t_kpn')).status, 'booked', 'incasso KPN: geboekt');
select pg_temp.gelijk((pg_temp.tx(:'t_kpn')).auto_booked, true, 'incasso KPN: automatisch');
select pg_temp.gelijk(pg_temp.verdeling(:'t_kpn'), 'KPN-778899=-3630', 'incasso KPN: op de factuur, niet via de bankregel op 4500');
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'k1'), 'paid', 'incasso KPN: factuur betaald');
select pg_temp.gelijk(position('Rekeningnummer van KPN B.V.' in (pg_temp.tx(:'t_kpn')).match_reason) > 0, true, 'incasso KPN: de reden noemt het rekeningnummer');
-- De bankregel doet wat hij deed bij een betaling zonder factuur.
select pg_temp.gelijk((pg_temp.tx(:'t_kpn2')).status, 'booked', 'KPN zonder factuur: geboekt door de bankregel');
select pg_temp.gelijk((pg_temp.tx(:'t_kpn2')).match_confidence, 'rule', 'KPN zonder factuur: via de regel');
select pg_temp.gelijk((pg_temp.tx(:'t_kpn2')).auto_booked, true, 'KPN zonder factuur: automatisch');
-- Het journaal: 1600 debet met de leverancier, 1100 credit.
select pg_temp.gelijk((
  select sum(jl.debit_cents) from public.journal_lines jl join public.ledger_accounts la on la.id = jl.account_id
  where jl.entry_id = (pg_temp.tx(:'t_kpn')).journal_entry_id and la.code = '1600' and jl.supplier_id = :'kpn'),
  3630::bigint, 'incasso KPN: crediteuren debet € 36,30 bij KPN');
select pg_temp.gelijk((
  select sum(jl.credit_cents) from public.journal_lines jl
  where jl.entry_id = (pg_temp.tx(:'t_kpn')).journal_entry_id and jl.account_id = :'rek_bank'),
  3630::bigint, 'incasso KPN: bank credit € 36,30');

-- 2. Pinbetaling op naam.
select pg_temp.gelijk((pg_temp.tx(:'t_horn')).status, 'booked', 'pin Hornbach: geboekt op de naam');
select pg_temp.gelijk(pg_temp.verdeling(:'t_horn'), 'BON-4411=-4840', 'pin Hornbach: op de bon');

-- 3. Verzamelbetaling: de twee oudste van Drukkerij Zuid, de derde blijft open.
select pg_temp.gelijk((pg_temp.tx(:'t_druk')).status, 'booked', 'verzamelbetaling Drukkerij Zuid: geboekt');
select pg_temp.gelijk(pg_temp.verdeling(:'t_druk'), 'DZ-1=-12100, DZ-2=-24200', 'verzamelbetaling: DZ-1 en DZ-2');
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'d3'), 'unpaid', 'verzamelbetaling: DZ-3 staat nog open');

-- 4. Abonnement: twee facturen met hetzelfde bedrag. Twijfel: voorstellen,
--    elke betaling een andere, de oudste eerst.
select pg_temp.gelijk((pg_temp.tx(:'t_cloud1')).status, 'suggested', 'abonnement: eerste betaling is een voorstel');
select pg_temp.gelijk((pg_temp.tx(:'t_cloud1')).matched_purchase_invoice_id, :'c1'::uuid, 'abonnement: eerste betaling → de oudste factuur');
select pg_temp.gelijk((pg_temp.tx(:'t_cloud2')).matched_purchase_invoice_id, :'c2'::uuid, 'abonnement: tweede betaling → de volgende factuur');
select pg_temp.gelijk(position('2 openstaande facturen van Cloudly' in (pg_temp.tx(:'t_cloud1')).match_reason) > 0, true, 'abonnement: de reden zegt waarom het een voorstel is');

-- 5. Nummer in de omschrijving.
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).status, 'booked', 'nummer en bedrag: geboekt');
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).match_confidence, 'purchase_invoice', 'nummer en bedrag: op het nummer');
select pg_temp.gelijk((pg_temp.tx(:'t_zeta')).status, 'suggested', 'deelbetaling: een voorstel');
select pg_temp.gelijk((pg_temp.tx(:'t_zeta')).matched_purchase_invoice_id, :'z1'::uuid, 'deelbetaling: de genoemde factuur');
select pg_temp.gelijk(position('deelbetaling' in (pg_temp.tx(:'t_zeta')).match_reason) > 0, true, 'deelbetaling: de reden zegt het');

-- 6. Alleen het bedrag: een voorstel, nooit vanzelf.
select pg_temp.gelijk((pg_temp.tx(:'t_paypal')).status, 'suggested', 'alleen bedrag: een voorstel');
select pg_temp.gelijk((pg_temp.tx(:'t_paypal')).match_confidence, 'purchase_amount', 'alleen bedrag: zo gemarkeerd');
select pg_temp.gelijk((pg_temp.tx(:'t_paypal')).matched_purchase_invoice_id, :'a1'::uuid, 'alleen bedrag: de enige factuur van € 77,77');
select pg_temp.gelijk((pg_temp.tx(:'t_glas')).match_confidence, 'purchase_amount', 'glazenwasser: alleen het bedrag, dus een voorstel');

-- 7. Factuur min creditnota.
select pg_temp.gelijk((pg_temp.tx(:'t_netto')).status, 'booked', 'factuur min creditnota: geboekt');
select pg_temp.gelijk(pg_temp.verdeling(:'t_netto'), 'NB-1001=-12100, NB-CN-7=2420', 'factuur min creditnota: allebei');
select pg_temp.gelijk((select string_agg(payment_status, ',' order by supplier_invoice_number) from public.purchase_invoices where id in (:'n1', :'n2')),
  'paid,paid', 'factuur min creditnota: allebei betaald');

-- 6b. Een voorstel op het bedrag dat in dezelfde ronde is ingehaald: de
--     latere betaling van de fietskoerier zelf is zeker en geboekt; het vroege
--     voorstel wijst niet naar een betaalde factuur.
select pg_temp.gelijk((pg_temp.tx(:'t_fiets')).status, 'booked', 'ingehaald: de betaling van de fietskoerier is geboekt');
select pg_temp.gelijk((pg_temp.tx(:'t_vroeg')).matched_purchase_invoice_id, null::uuid, 'ingehaald: het vroege voorstel wijst niet naar de betaalde factuur');
select pg_temp.gelijk((pg_temp.tx(:'t_vroeg')).status, 'unmatched', 'ingehaald: de vroege betaling staat weer open');

-- 8a. Eerst de betaling: nog geen factuur, dus de kostenrekening van de
--     leverancier (zoals voorheen).
select pg_temp.gelijk((pg_temp.tx(:'t_later')).status, 'suggested', 'eerst de betaling: een voorstel');
select pg_temp.gelijk((pg_temp.tx(:'t_later')).match_confidence, 'supplier_iban', 'eerst de betaling: leverancier op IBAN');

-- 10. Automatisch boeken uit op de spaarrekening: zeker, maar een voorstel.
select pg_temp.gelijk((pg_temp.tx(:'t_schoon')).status, 'suggested', 'automatisch boeken uit: een voorstel');
select pg_temp.gelijk((pg_temp.tx(:'t_schoon')).matched_purchase_invoice_id, :'s1'::uuid, 'automatisch boeken uit: wel de goede factuur');
select pg_temp.gelijk(position('Automatisch boeken staat uit' in (pg_temp.tx(:'t_schoon')).match_reason) > 0, true, 'automatisch boeken uit: de reden zegt het');

-- 13a. De andere organisatie: haar betaling en haar factuur onaangeroerd.
select pg_temp.gelijk((pg_temp.tx(:'ander_t')).status, 'unmatched', 'organisatiegrens: de betaling elders is niet aangeraakt');
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'ander_k1'), 'unpaid', 'organisatiegrens: de factuur elders staat nog open');
select pg_temp.gelijk((select count(*) from public.bank_transaction_allocations a where a.purchase_invoice_id = :'ander_k1'), 0::bigint,
  'organisatiegrens: niets op de factuur elders afgeletterd');

-- Nog eens matchen verandert niets aan wat geboekt is, en geeft dezelfde voorstellen.
select pg_temp.matchen(:'org', :'eigenaar') as tweede \gset
select pg_temp.gelijk((select count(*) from public.bank_transactions where organization_id = :'org' and status = 'booked'), 7::bigint,
  'nog eens matchen: zeven geboekt, niets dubbel');
select pg_temp.gelijk((pg_temp.tx(:'t_cloud2')).matched_purchase_invoice_id, :'c2'::uuid, 'nog eens matchen: zelfde voorstel');

-- ── 8b. Dan komt de factuur van Later BV: bij het boeken gekoppeld ─────────

select pg_temp.inkoop(:'org', :'eigenaar', :'later', 'LB-1', :'vandaag'::date - 1, 2000, :'rek_kosten') as l1 \gset
select pg_temp.gelijk((pg_temp.tx(:'t_later')).status, 'booked', 'eerst de betaling: geboekt zodra de factuur geboekt werd');
select pg_temp.gelijk(pg_temp.verdeling(:'t_later'), 'LB-1=-2420', 'eerst de betaling: op de factuur, niet op 4500');
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'l1'), 'paid', 'eerst de betaling: factuur betaald');

-- ── 9. Terugdraaien ────────────────────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.unbook_bank_transaction(:'org', :'t_advies')).status as s \gset
select (public.unbook_bank_transaction(:'org', :'t_kpn2')).status as s \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).auto_book_blocked, true, 'terugdraaien: niet meer vanzelf');
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).auto_booked, false, 'terugdraaien: niet meer "automatisch geboekt"');
select pg_temp.matchen(:'org', :'eigenaar') as derde \gset
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).status, 'suggested', 'terugdraaien: daarna alleen een voorstel');
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).matched_purchase_invoice_id, :'r1'::uuid, 'terugdraaien: voorstel blijft de factuur');
select pg_temp.gelijk(position('draaide een automatische boeking' in (pg_temp.tx(:'t_advies')).match_reason) > 0, true, 'terugdraaien: de reden zegt het');
select pg_temp.gelijk((pg_temp.tx(:'t_kpn2')).status, 'suggested', 'terugdraaien bankregel: daarna ook alleen een voorstel');
-- Met de hand boeken kan gewoon.
select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.book_bank_transaction(:'org', :'t_advies', p_matched_purchase_invoice_id => :'r1')).id is not null as ok \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).status, 'booked', 'terugdraaien: met de hand opnieuw geboekt');
select pg_temp.gelijk((pg_temp.tx(:'t_advies')).auto_booked, false, 'terugdraaien: met de hand is niet automatisch');

-- ── 11. Een IBAN geleerd van een eerdere betaling, via het inlezen ─────────

-- De glazenwasser heeft geen IBAN in de stamgegevens. De eerste betaling
-- boek je met de hand op zijn factuur; daarna kent ResoFly zijn IBAN.
select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.book_bank_transaction(:'org', :'t_glas', p_matched_purchase_invoice_id => :'g1')).id is not null as ok \gset
reset role;
select pg_temp.beheer();
select pg_temp.inkoop(:'org', :'eigenaar', :'glas', 'GJ-2', :'vandaag'::date - 2, 3100, :'rek_kosten') as g2 \gset
select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.import_bank_transactions(:'org', :'bank',
  jsonb_build_object('format', 'csv', 'file_name', 'november.csv'),
  jsonb_build_array(
    jsonb_build_object('booking_date', :'vandaag', 'amount_cents', -3751, 'counterparty_name', 'J. Jansen',
                       'counterparty_iban', 'NL77 GLAS 0000 0000 01', 'description', 'Ramen november'),
    jsonb_build_object('booking_date', :'vandaag', 'amount_cents', -6050, 'counterparty_name', 'Drukkerij Zuid',
                       'description', 'DZ-3')
  )) as inlezen \gset
reset role;
select pg_temp.beheer();
\o
\echo inlezen: :inlezen
\o /dev/null
select pg_temp.gelijk((:'inlezen'::jsonb ->> 'inserted')::int, 2, 'inlezen: twee nieuw');
select pg_temp.gelijk((:'inlezen'::jsonb ->> 'auto_booked_purchase')::int, 2, 'inlezen: allebei meteen geboekt');
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'g2'), 'paid', 'geleerd IBAN: GJ-2 betaald');
select pg_temp.gelijk((select payment_status from public.purchase_invoices where id = :'d3'), 'paid', 'inlezen: DZ-3 betaald op nummer en bedrag');
select pg_temp.gelijk((
  select t.match_reason from public.bank_transactions t
  where t.organization_id = :'org' and t.description = 'Ramen november'),
  'Rekeningnummer van Glazenwasser Jan en het bedrag van inkoopfactuur GJ-2.', 'geleerd IBAN: de reden');

-- ── 12. Een tegengeboekte factuur verdwijnt uit het voorstel ───────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.reverse_journal_entry((select journal_entry_id from public.purchase_invoices where id = :'z1'), null, :'eigenaar')).id is not null as ok \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select status from public.purchase_invoices where id = :'z1'), 'draft', 'tegenboeken: Zeta is weer concept');
select pg_temp.gelijk((pg_temp.tx(:'t_zeta')).matched_purchase_invoice_id, null::uuid, 'tegenboeken: het voorstel wijst er niet meer naar');

-- ── 13b. Wie mag matchen ───────────────────────────────────────────────────

select pg_temp.als(:'lezer');
set local role authenticated;
select pg_temp.weigert(format('select public.match_bank_transactions(%L)', :'org'), 'Geen schrijfrechten', 'rechten: een lezer matcht niet');
reset role;
select pg_temp.als(:'zonder_financien');
set local role authenticated;
select pg_temp.weigert(format('select public.match_bank_transactions(%L)', :'org'), 'Geen schrijfrechten', 'rechten: zonder Financiën matcht niet');
reset role;
select pg_temp.als(:'ander');
set local role authenticated;
select pg_temp.weigert(format('select public.match_bank_transactions(%L)', :'org'), 'Geen schrijfrechten', 'rechten: een andere organisatie matcht hier niet');
select pg_temp.weigert(format('select public.match_bank_transactions(%L, %L)', :'ander_org', :'bank'), 'Bankrekening niet gevonden', 'rechten: niet met een rekening van een ander');
select pg_temp.weigert(format('select public.bank_match_run(%L, null, null, null, true)', :'org'), 'permission denied', 'rechten: de matchronde zelf is niet aan te roepen');
select pg_temp.weigert(format('select public.bank_open_purchase_invoices(%L)', :'org'), 'permission denied', 'rechten: de openstaande facturen niet rechtstreeks');
select pg_temp.weigert(format('select public.bank_supplier_ibans(%L)', :'org'), 'permission denied', 'rechten: de IBAN-lijst niet rechtstreeks');
-- Haar eigen matcher raakt alleen haar eigen boeken: daar is het zeker
-- (IBAN en bedrag van haar eigen KPN-factuur).
select public.match_bank_transactions(:'ander_org') is not null as ok \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.verdeling(:'ander_t'), 'KPN-ANDER=-3630', 'organisatiegrens: elders op de eigen factuur');
select pg_temp.gelijk((select count(*) from public.bank_transaction_allocations a
                       join public.bank_transactions t on t.id = a.bank_transaction_id
                       where t.organization_id = :'ander_org' and a.organization_id <> :'ander_org'), 0::bigint,
  'organisatiegrens: geen verdeling over de grens');
select pg_temp.gelijk(has_function_privilege('anon', 'public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean)', 'execute'), false,
  'rechten: anon matcht niet');

-- Geboekt is geboekt: de banksaldi van de organisatie kloppen met de som van
-- wat er geboekt is.
select pg_temp.gelijk(pg_temp.saldo(:'org', '1100'),
  (select coalesce(sum(amount_cents), 0) from public.bank_transactions where organization_id = :'org' and bank_account_id = :'bank' and status = 'booked'),
  'grootboek: 1100 is precies wat er geboekt is');

\o
\echo 'Alle controles van bank_inkoop_afletteren.sql geslaagd.'
rollback;
