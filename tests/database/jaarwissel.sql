-- ============================================================
-- Databasetest: de jaarwissel
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: de controle van 22 november 2026 speelde na wat er op 1 januari
-- gebeurt. Twee dingen zaten in de database:
--
--   1. Het boekjaar van het nieuwe jaar ontstond niet. Alles boekte door, maar
--      Eigen vermogen kende het jaar niet. Sinds 20261122141000 opent het
--      vanzelf bij de eerste boeking, alleen bij een eenmanszaak, vof,
--      maatschap of cv, en alleen als het jaar ervóór een boekjaar heeft.
--   2. De database telde in UTC: een betaling van 00:30 Nederlandse tijd viel
--      op de dag ervoor, en afsluiten werd in het eerste uur van 1 januari
--      geweigerd (20261122140000).
--
-- De klok van de database kan niet vooruit. De datums staan daarom ten
-- opzichte van vandaag: "vorig jaar" speelt het oude jaar, "dit jaar" het
-- nieuwe. Zo werkt de test elke dag, ook op 1 januari.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select (now() at time zone 'Europe/Amsterdam')::date as vandaag \gset
select extract(year from :'vandaag'::date)::int as jaar \gset

-- ── De wereld: een eenmanszaak, een stichting en een eenmanszaak zonder boekjaren ──

select gen_random_uuid() as zzp, gen_random_uuid() as bv, gen_random_uuid() as leeg \gset

insert into auth.users (id, email, aud, role) values
  (:'zzp',  'zzp@jaarwissel.test',  'authenticated', 'authenticated'),
  (:'bv',   'bv@jaarwissel.test',   'authenticated', 'authenticated'),
  (:'leeg', 'leeg@jaarwissel.test', 'authenticated', 'authenticated');

select pg_temp.als(:'zzp');
set local role authenticated;
select (public.create_organization('Fotografie Jaarwissel')).id as org \gset
reset role;
select pg_temp.als(:'bv');
set local role authenticated;
select (public.create_organization('Stichting Jaarwissel')).id as bv_org \gset
reset role;
select pg_temp.als(:'leeg');
set local role authenticated;
select (public.create_organization('Zonder Boekjaren')).id as leeg_org \gset
reset role;
select pg_temp.beheer();

insert into public.company_settings (organization_id, created_by, company_name, legal_form, kor_enabled, vat_return_period,
                                     bookkeeping_start_date, fiscal_year_start_month, year_result_account_code)
values (:'org',      :'zzp',  'Fotografie Jaarwissel', 'eenmanszaak', false, 'quarterly', make_date(:jaar - 2, 1, 1), 1, '0500'),
       (:'bv_org',   :'bv',   'Stichting Jaarwissel',  'stichting',   false, 'quarterly', make_date(:jaar - 1, 1, 1), 1, '0510'),
       (:'leeg_org', :'leeg', 'Zonder Boekjaren',      'eenmanszaak', false, 'quarterly', make_date(:jaar - 1, 1, 1), 1, '0500');

-- Zoals een zzp'er er op 1 januari voor staat: alleen het boekjaar van vorig
-- jaar. De stichting ook; de derde heeft er geen.
select pg_temp.als(:'zzp');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'org') is null as ok \gset
select (public.open_fiscal_year(:'org', make_date(:jaar - 1, 1, 1), make_date(:jaar - 1, 12, 31))).id is not null as ok \gset
reset role;
select pg_temp.als(:'bv');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'bv_org') is null as ok \gset
select (public.open_fiscal_year(:'bv_org', make_date(:jaar - 1, 1, 1), make_date(:jaar - 1, 12, 31))).id is not null as ok \gset
reset role;
select pg_temp.als(:'leeg');
set local role authenticated;
select public.ensure_default_ledger_accounts(:'leeg_org') is null as ok \gset
reset role;
select pg_temp.beheer();

create function pg_temp.boekjaren(p_org uuid) returns text language sql as $$
  select coalesce(string_agg(label || ':' || period_start || ':' || period_end || ':' || status, ' ' order by period_start), '')
  from public.fiscal_years where organization_id = p_org
$$;

-- Een memoriaalpost als de eigenaar, zoals het scherm hem boekt.
create function pg_temp.boek(p_org uuid, p_user uuid, p_datum date, p_tekst text) returns void language plpgsql as $$
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  perform public.post_journal_entry(p_org, p_datum, p_tekst, 'manual', null,
    '[{"account_code": "1100", "debit_cents": 10000}, {"account_code": "8000", "credit_cents": 10000}]'::jsonb);
  reset role;
  perform pg_temp.beheer();
end $$;

-- ── 1. Het boekjaar van het nieuwe jaar opent bij de eerste boeking ─────────

select pg_temp.boek(:'org', :'zzp', make_date(:jaar - 1, 6, 1), 'Omzet vorig jaar');
select pg_temp.gelijk(pg_temp.boekjaren(:'org'), format('%s:%s-01-01:%s-12-31:open', :jaar - 1, :jaar - 1, :jaar - 1),
  'boekjaar: een boeking in een jaar mét boekjaar verandert niets');

-- Vóór het eerste boekjaar: dat jaar deed je elders.
select pg_temp.boek(:'org', :'zzp', make_date(:jaar - 2, 12, 31), 'Van voor de start');
select pg_temp.gelijk((select count(*) from public.fiscal_years where organization_id = :'org'), 1::bigint,
  'boekjaar: een boeking van vóór het eerste boekjaar opent niets');

-- Volgend jaar (een tikfout, of een factuur die al klaarstaat): nog niet.
select pg_temp.boek(:'org', :'zzp', make_date(:jaar + 1, 1, 2), 'Vast voor volgend jaar');
select pg_temp.gelijk((select count(*) from public.fiscal_years where organization_id = :'org'), 1::bigint,
  'boekjaar: een boeking in een jaar dat nog niet begonnen is opent niets');

-- De eerste boeking van dit jaar.
select pg_temp.boek(:'org', :'zzp', make_date(:jaar, 1, 1), 'Eerste omzet van het jaar');
select pg_temp.gelijk(pg_temp.boekjaren(:'org'),
  format('%s:%s-01-01:%s-12-31:open %s:%s-01-01:%s-12-31:open', :jaar - 1, :jaar - 1, :jaar - 1, :jaar, :jaar, :jaar),
  'boekjaar: de eerste boeking van het nieuwe jaar opent het boekjaar, 1 januari t/m 31 december');
select pg_temp.gelijk((select created_by from public.fiscal_years where organization_id = :'org' and label = :jaar::text), :'zzp'::uuid,
  'boekjaar: op naam van wie boekte');

select pg_temp.boek(:'org', :'zzp', :'vandaag', 'Tweede omzet van het jaar');
select pg_temp.gelijk((select count(*) from public.fiscal_years where organization_id = :'org'), 2::bigint,
  'boekjaar: de tweede boeking opent niets meer');

-- Het vanzelf geopende boekjaar is een gewoon boekjaar: het overlapt.
select pg_temp.als(:'zzp');
set local role authenticated;
select pg_temp.weigert(format('select public.open_fiscal_year(%L, %L, %L)', :'org', make_date(:jaar, 1, 1), make_date(:jaar, 12, 31)),
  'overlapt met een bestaand boekjaar', 'boekjaar: nog eens met de hand openen wordt geweigerd');
reset role;
select pg_temp.beheer();

-- Een stichting of BV kan een gebroken boekjaar hebben: daar kiest een mens.
-- (Een BV vraagt de zakelijke module; de stichting toetst dezelfde regel.)
select pg_temp.boek(:'bv_org', :'bv', :'vandaag', 'Baten stichting');
select pg_temp.gelijk((select count(*) from public.fiscal_years where organization_id = :'bv_org'), 1::bigint,
  'boekjaar: bij een stichting (of BV) opent er niets vanzelf');

-- Zonder boekjaren komt er ook geen: dat doet de inrichting.
select pg_temp.boek(:'leeg_org', :'leeg', :'vandaag', 'Omzet zonder boekjaar');
select pg_temp.gelijk((select count(*) from public.fiscal_years where organization_id = :'leeg_org'), 0::bigint,
  'boekjaar: een administratie zonder boekjaren krijgt er geen');

-- ── 2. Een betaling van 00:30 valt op de Nederlandse dag ───────────────────

select pg_temp.als(:'zzp');
set local role authenticated;
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'zzp', 'Bureau Noord BV', 'info@noord.test', 'business')
returning id as klant \gset
insert into public.invoices (organization_id, created_by, client_id, number, date, due_date, status, lines)
values (:'org', :'zzp', :'klant', 'JW-001', :'vandaag'::date - 20, :'vandaag'::date - 6, 'draft',
        '[{"id": "a1", "description": "Portretten", "quantity": 1, "unit_price": 100, "vat": 21}]'::jsonb)
returning id as factuur \gset
reset role;
select pg_temp.beheer();

update public.invoices set status = 'sent', sent_at = date::timestamptz + interval '9 hours' where id = :'factuur';
select pg_temp.gelijk((select journal_entry_id is not null from public.invoices where id = :'factuur'), true,
  'betaling: de verstuurde factuur staat in het grootboek');

-- Tien dagen geleden om 00:30 Nederlandse tijd. In UTC is dat de avond ervoor.
select ((:'vandaag'::date - 10)::timestamp + interval '30 minutes') at time zone 'Europe/Amsterdam' as betaald_op \gset
select pg_temp.gelijk(((:'betaald_op'::timestamptz at time zone 'UTC')::date), :'vandaag'::date - 11,
  'betaling: in UTC valt 00:30 op de dag ervoor (anders toetst dit niets)');

-- Mollie meldt de betaling via de webhook (service-role).
insert into public.invoice_payment_records (organization_id, invoice_id, provider, provider_payment_id, status, amount_cents, paid_at)
values (:'org', :'factuur', 'mollie', 'tr_jaarwissel', 'paid', 12100, :'betaald_op')
returning id as betaling \gset
select public.book_invoice_payment(:'org', :'betaling', null) is null as al_geboekt \gset

select pg_temp.gelijk((select je.date from public.invoice_payment_records r join public.journal_entries je on je.id = r.journal_entry_id where r.id = :'betaling'),
  :'vandaag'::date - 10, 'betaling: geboekt op de Nederlandse dag van de betaling');

-- ── 3. Nergens meer de dag in UTC ──────────────────────────────────────────
-- Het eerste uur van 1 januari is hier niet na te spelen. Wat wel kan: geen
-- van de vijf functies rekent nog met current_date of met een kaal ::date op
-- het tijdstip van de betaling.

select pg_temp.gelijk((
  select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('book_invoice_payment', 'recompute_invoice_refund_state', 'finalize_vat_return', 'close_fiscal_year', 'post_asset_depreciation')
    and (p.prosrc ~* '\mcurrent_date\M' or p.prosrc ~* '(paid_at|refunded_at)::date')
), '', 'datum: de vijf functies rekenen met de Nederlandse dag');

-- Het lopende boekjaar en het lopende tijdvak gaan niet dicht (dezelfde regel,
-- nu met de Nederlandse dag).
select pg_temp.als(:'zzp');
set local role authenticated;
select pg_temp.weigert(format('select public.close_fiscal_year(%L, %L)', :'org',
    (select id from public.fiscal_years where organization_id = :'org' and label = :jaar::text)),
  'loopt nog', 'datum: het lopende boekjaar sluit je niet af');
reset role;
select pg_temp.beheer();

-- De andere organisaties merken niets.
select pg_temp.gelijk((select count(*) from public.journal_entries where organization_id = :'bv_org'), 1::bigint, 'de stichting heeft alleen haar eigen boeking');

\echo 'Alle controles van jaarwissel.sql geslaagd.'
rollback;
