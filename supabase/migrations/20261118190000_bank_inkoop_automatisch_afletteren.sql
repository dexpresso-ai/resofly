-- ============================================================
-- ResoFly — Bank: betalingen vanzelf koppelen aan inkoopfacturen
-- Date: 2026-11-18
--
-- Vraag: "Maak een goed werkende functionaliteit waarbij bankboekingen die
-- worden ingelezen, ook daadwerkelijk worden gekoppeld aan inkoopfacturen,
-- zodat boeken en matchen automatisch gaan."
--
-- Wat er misging:
--
--   1. De matcher koppelde een betaling alleen aan een inkoopfactuur als het
--      factuurnummer letterlijk in de omschrijving stond. Een incasso van KPN,
--      een pinbetaling bij de bouwmarkt of een overboeking met "zie factuur"
--      noemt dat nummer bijna nooit. Die bleven dus allemaal liggen, ook als
--      de leverancier aan zijn IBAN te herkennen was en het bedrag tot op de
--      cent klopte.
--   2. Een gevonden inkoopfactuur werd alleen voorgesteld, nooit geboekt. Wie
--      honderd betalingen inlas, klikte honderd keer op Boeken.
--   3. De matcher keek alleen naar transacties met status 'unmatched'. Kwam de
--      inkoopfactuur ná de betaling binnen (heel gewoon bij een incasso of een
--      bon), dan bleef de betaling staan op het oude voorstel: "leverancier
--      herkend, boek op 4500". Wie dat volgde, boekte de kosten twee keer: één
--      keer met de inkoopfactuur en één keer met de bank.
--   4. Een bankregel met "automatisch boeken" boekte een betaling die je net
--      had teruggedraaid bij de volgende import meteen weer.
--
-- Wat er nu gebeurt (bank_match_run, achter match_bank_transactions):
--
--   * Een betaling wordt gekoppeld aan een geboekte, openstaande inkoopfactuur
--     op (in deze volgorde):
--       - het factuurnummer, het interne nummer of het betalingskenmerk uit de
--         e-factuur in de omschrijving (ook meerdere facturen, en een factuur
--         min een creditnota van de leverancier);
--       - de leverancier: zijn IBAN (uit de stamgegevens, van zijn facturen,
--         en van betalingen die je eerder aan hem afletterde), anders zijn naam
--         als tegenpartij, anders zijn naam in de omschrijving; met het bedrag
--         van één openstaande factuur, of precies de oudste openstaande facturen
--         samen (een verzamelbetaling);
--       - alleen het bedrag: als precies één openstaande factuur dat bedrag
--         heeft en de datum past. Dat blijft altijd een voorstel.
--   * Is het zeker (het bedrag klopt precies én het factuurnummer of de
--     leverancier op IBAN of naam staat vast, en er is maar één kandidaat),
--     dan boekt de database de betaling meteen tegen de inkoopfactuur, langs
--     book_bank_transaction, net als de knop. Per bankrekening uit te zetten
--     (bank_accounts.auto_book_purchase_invoices). Lukt boeken niet
--     (afgesloten periode), dan blijft het een voorstel met de reden erbij.
--   * Twijfel blijft een voorstel. In match_reason staat in gewone woorden
--     waaróp het herkend is; bij meerdere facturen staat de verdeling in
--     suggested_allocations.
--   * Elke ronde bepaalt ook bestaande voorstellen opnieuw ('suggested').
--   * Wordt een inkoopfactuur geboekt, dan zoekt de database meteen de
--     openstaande betalingen die erbij kunnen horen (trigger op
--     purchase_invoices). Wordt hij tegengeboekt, dan krijgen voorstellen die
--     ernaar wezen een nieuw voorstel.
--   * Draai je een automatische boeking terug, dan boekt de matcher die
--     transactie nooit meer vanzelf (auto_book_blocked); voorstellen blijven.
--     Dat geldt ook voor bankregels met "automatisch boeken".
--
-- Rule 1 (CLAUDE.md): alles hieronder is security definer en filtert zelf op
-- organization_id; de openstaande facturen, de leveranciers en hun IBAN's komen
-- uitsluitend uit de organisatie van de transactie. Rule 2: dit is geen AI maar
-- een vaste rekenregel in de database, zoals de bestaande bankregels met
-- "automatisch boeken". Hij boekt langs dezelfde functie als de knop, met de
-- rechten van wie inleest, synchroniseert of de inkoopfactuur boekt.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Kolommen ─────────────────────────────────────────────────────────────

-- Waarom de matcher dit voorstelt of boekte, in gewone woorden ("IBAN van KPN
-- en het bedrag van inkoopfactuur INK-2026-0042"). Zonder uitleg vertrouwt
-- niemand een automatische boeking.
alter table public.bank_transactions add column if not exists match_reason text;
-- Een voorstel over meer dan één stuk (verzamelbetaling, deelbetaling met een
-- rest), in de vorm die book_bank_transaction als p_allocations aanneemt. Een
-- regel {"kind":"ledger"} zonder rekening is "de rest, kies zelf een rekening".
alter table public.bank_transactions add column if not exists suggested_allocations jsonb;
-- Door de matcher geboekt (inkoopfactuur of bankregel), niet door een mens.
alter table public.bank_transactions add column if not exists auto_booked boolean not null default false;
-- Een automatische boeking is teruggedraaid: niet meer vanzelf boeken.
alter table public.bank_transactions add column if not exists auto_book_blocked boolean not null default false;

-- Per rekening: zekere betalingen van inkoopfacturen meteen boeken. Standaard
-- aan; daar is om gevraagd. Uit = alleen voorstellen.
alter table public.bank_accounts add column if not exists auto_book_purchase_invoices boolean not null default true;

-- ── 2. Hulpjes: IBAN en naam ────────────────────────────────────────────────

-- IBAN zonder spaties en leestekens, in hoofdletters; leeg wordt null.
create or replace function public.bank_norm_iban(p_iban text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(upper(regexp_replace(coalesce(p_iban, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

-- Een naam als losse woorden: kleine letters, zonder accenten en leestekens,
-- zonder rechtsvorm en vulwoorden. "KPN B.V." en "kpn bv" worden allebei
-- "kpn", "Stichting Mollie Payments" blijft "stichting mollie payments".
create or replace function public.bank_name_norm(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(btrim(regexp_replace(regexp_replace(
    ' ' || regexp_replace(
      translate(lower(coalesce(p_name, '')), 'áàâäãåéèêëíìîïóòôöõúùûüçñýÿ', 'aaaaaaeeeeiiiiooooouuuucnyy'),
      '[^a-z0-9]+', ' ', 'g') || ' ',
    ' (b v|n v|v o f|c v|bv|nv|vof|cv|gmbh|ltd|limited|inc|llc|sarl|sas|sa|ag|bvba|srl|plc|holding|the|de|het|en|and|europe|nederland|netherlands|nl|eu|international)(?= )',
    ' ', 'g'), ' +', ' ', 'g')), '')
$$;

-- Hoort deze tekst bij deze leverancier? Beide al door bank_name_norm. Gelijk,
-- of de naam als hele woorden in de tekst ("kpn" in "kpn mobile", niet "ns" in
-- "nsinternational"). Bij een omschrijving (p_in_text) alleen namen vanaf vier
-- tekens: een omschrijving bevat veel woorden. Andersom (de tekst in de naam)
-- alleen bij een tegenpartij en vanaf vier tekens: "ah" is niet "ah to go".
create or replace function public.bank_name_matches(p_text text, p_name text, p_in_text boolean)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_text is not null and p_name is not null
    and length(p_name) >= case when p_in_text then 4 else 2 end
    and (
      (not p_in_text and p_text = p_name)
      or (length(p_name) >= case when p_in_text then 4 else 3 end
          and strpos(' ' || p_text || ' ', ' ' || p_name || ' ') > 0)
      or (not p_in_text and length(p_text) >= 4
          and strpos(' ' || p_name || ' ', ' ' || p_text || ' ') > 0)
    )
$$;

-- ── 3. Wat staat er open, en welk IBAN hoort bij wie ────────────────────────

-- Eén openstaande inkoopfactuur zoals de matcher hem nodig heeft. Een vast
-- rijtype in een array, geen jsonb: de matcher loopt per bankregel een paar
-- keer door deze lijst. Met jsonb (elke keer opnieuw uitpakken) duurde een
-- ronde met 4.000 bankregels en 300 openstaande facturen 26 seconden;
-- PostgREST breekt een aanroep na 8 seconden af.
--   ref1..3      — intern nummer, factuurnummer van de leverancier en het
--                  betalingskenmerk uit een e-factuur (los, niet als array:
--                  een array per factuur uitpakken kostte per bankregel het
--                  meeste tijd);
--   ref1..3_norm — dezelfde, klein en zonder spaties (zoals de banktekst);
--   open_cents   — zoals purchase_invoice_open_payable_cents: positief = nog
--                  te betalen, negatief = een creditnota van de leverancier.
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'bank_open_purchase_invoice'
  ) then
    create type public.bank_open_purchase_invoice as (
      id uuid,
      supplier_id uuid,
      supplier_name text,
      name_norm text,
      label text,
      ref1 text,
      ref2 text,
      ref3 text,
      ref1_norm text,
      ref2_norm text,
      ref3_norm text,
      open_cents bigint,
      date date,
      due date
    );
  end if;
end $$;

-- De openstaande inkoopfacturen van een organisatie, één keer per matchronde.
-- Eerst de geboekte facturen (materialized), dan pas per factuur één keer
-- uitrekenen wat er openstaat. Zonder die volgorde zette de planner de
-- berekening in de koppeling met journal_entries en rekende hij hem uit voor
-- elke combinatie van factuur en journaalpost: 7,9 seconden voor 300 facturen
-- in plaats van een paar milliseconden.
create or replace function public.bank_open_purchase_invoices(p_organization_id uuid)
returns public.bank_open_purchase_invoice[]
language sql
stable
security definer
set search_path = public
as $$
  with geboekt as materialized (
    select pi.id, pi.supplier_id, s.name as supplier_name,
           coalesce(nullif(btrim(pi.internal_number), ''), nullif(btrim(pi.supplier_invoice_number), ''), 'zonder nummer') as label,
           nullif(btrim(pi.internal_number), '') as ref1,
           nullif(btrim(pi.supplier_invoice_number), '') as ref2,
           -- Het betalingskenmerk uit een e-factuur (UBL PaymentID).
           nullif(btrim(coalesce(pi.extraction_meta ->> 'payment_reference', '')), '') as ref3,
           pi.date, coalesce(pi.due_date, pi.date) as due
    from public.purchase_invoices pi
    join public.journal_entries je
      on je.id = pi.journal_entry_id and je.organization_id = p_organization_id
     and je.reversed_by_entry_id is null
    left join public.suppliers s on s.id = pi.supplier_id and s.organization_id = p_organization_id
    where pi.organization_id = p_organization_id
      and pi.status <> 'cancelled'
      and pi.payment_status <> 'paid'
  ),
  open as materialized (
    select g.*, public.purchase_invoice_open_payable_cents(p_organization_id, g.id) as open_cents
    from geboekt g
  )
  select coalesce(array_agg(row(
           x.id, x.supplier_id, x.supplier_name, public.bank_name_norm(x.supplier_name), x.label,
           x.ref1, x.ref2, x.ref3,
           nullif(lower(regexp_replace(coalesce(x.ref1, ''), '\s', '', 'g')), ''),
           nullif(lower(regexp_replace(coalesce(x.ref2, ''), '\s', '', 'g')), ''),
           nullif(lower(regexp_replace(coalesce(x.ref3, ''), '\s', '', 'g')), ''),
           x.open_cents, x.date, x.due
         )::public.bank_open_purchase_invoice order by x.due, x.date, x.id), '{}')
  from open x
  where x.open_cents <> 0
$$;

-- IBAN → leverancier, als jsonb-object. Bronnen: het IBAN in de stamgegevens,
-- het IBAN op zijn facturen (uitgelezen) en de tegenrekening van betalingen
-- die je eerder op hem afletterde of boekte. Hoort een IBAN bij meer dan één
-- leverancier (een betaalprovider), dan is de waarde '' en telt het niet. De
-- eigen rekeningen van de organisatie tellen nooit: een verkeerd uitgelezen
-- factuur maakte anders van een overboeking naar je spaarrekening een betaling
-- aan een leverancier.
create or replace function public.bank_supplier_ibans(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bron as (
    select s.id as supplier_id, public.bank_norm_iban(s.iban) as iban
    from public.suppliers s
    where s.organization_id = p_organization_id
    union
    select pi.supplier_id, public.bank_norm_iban(pi.extraction_meta -> 'supplier_raw' ->> 'iban')
    from public.purchase_invoices pi
    where pi.organization_id = p_organization_id
      and pi.supplier_id is not null
      and pi.status <> 'cancelled'
    union
    select a.supplier_id, public.bank_norm_iban(bt.counterparty_iban)
    from public.bank_transaction_allocations a
    join public.bank_transactions bt on bt.id = a.bank_transaction_id and bt.organization_id = p_organization_id
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    join public.suppliers s on s.id = a.supplier_id and s.organization_id = p_organization_id
    where a.organization_id = p_organization_id
      and a.supplier_id is not null
  ),
  eigen as (
    select public.bank_norm_iban(ba.iban) as iban
    from public.bank_accounts ba
    where ba.organization_id = p_organization_id and ba.iban is not null
  )
  select coalesce(jsonb_object_agg(x.iban, case when x.n = 1 then x.supplier_id else '' end), '{}'::jsonb)
  from (
    select b.iban, count(distinct b.supplier_id) as n, min(b.supplier_id::text) as supplier_id
    from bron b
    where b.iban is not null and length(b.iban) >= 10
      and b.iban not in (select e.iban from eigen e where e.iban is not null)
    group by b.iban
  ) x
$$;

-- ── 4. Eén transactie tegen de openstaande inkoopfacturen ───────────────────
--
-- Puur rekenwerk op wat bank_match_run al ophaalde: geen tabellen, dus ook
-- geen organisatiegrens om te bewaken (de lijsten zijn al van één organisatie).
--
-- p_mode:
--   'strong' — factuurnummer of leverancier. Kan zeker zijn.
--   'amount' — alleen het bedrag. Nooit zeker.
--
-- Uitkomst (of null):
--   allocations  — zoals book_bank_transaction ze aanneemt, bedragen in de
--                  richting van de transactie (positief = mee met het geld);
--                  een regel {"kind":"ledger"} zonder rekening is "de rest";
--   certain      — mag zonder mens geboekt worden;
--   confidence   — purchase_invoice (nummer), purchase_supplier, purchase_amount;
--   reason       — in gewone woorden;
--   supplier_id  — de herkende leverancier.
--
-- De naamvergelijking staat hier uitgeschreven in plaats van via
-- bank_name_matches: een functieaanroep per factuur per bankregel telde op.
-- De regels zijn dezelfde.
create or replace function public.bank_purchase_match(
  p_txn public.bank_transactions,
  p_haystack text,
  p_open public.bank_open_purchase_invoice[],
  p_ibans jsonb,
  p_claimed uuid[],
  p_mode text
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_need bigint := abs(p_txn.amount_cents);
  -- Wat een stuk "van nature" krijgt in de richting van de transactie: bij een
  -- betaling het openstaande bedrag (een creditnota is dan negatief), bij een
  -- ontvangst het omgekeerde.
  v_flip integer := case when p_txn.amount_cents < 0 then 1 else -1 end;
  v_iban text := public.bank_norm_iban(p_txn.counterparty_iban);
  v_cp text := public.bank_name_norm(p_txn.counterparty_name);
  v_desc text := public.bank_name_norm(coalesce(p_txn.description, '') || ' ' || coalesce(p_txn.structured_reference, ''));
  v_cp_pad text;
  v_desc_pad text;
  v_rows jsonb;
  v_n integer;
  v_sum bigint;
  v_left bigint;
  v_take bigint;
  v_allocs jsonb;
  v_labels text;
  r record;
  v_sup_iban uuid;
  v_sup_name uuid;
  v_sup_desc uuid;
  v_ref_sup uuid;
  v_ref_ok boolean;
  v_try record;
  v_cands jsonb;
  v_exact integer;
  v_pick record;
  v_running bigint;
  v_k integer;
begin
  if v_need = 0 or p_open is null or cardinality(p_open) = 0 then
    return null;
  end if;

  -- ── Alleen het bedrag ─────────────────────────────────────────────────────
  if p_mode = 'amount' then
    select count(*) into v_n
    from unnest(p_open) c
    where c.open_cents * v_flip = v_need
      and p_txn.booking_date between c.date - 30 and c.date + 365;
    if v_n <> 1 then
      return null;
    end if;
    select c.id, c.supplier_id, c.supplier_name, c.label into r
    from unnest(p_open) c
    where c.open_cents * v_flip = v_need
      and p_txn.booking_date between c.date - 30 and c.date + 365;
    -- Hing die ene factuur in deze ronde al aan een andere betaling, dan niet
    -- nog eens: twee betalingen van € 50 en één factuur van € 50 is twijfel.
    if r.id = any(coalesce(p_claimed, '{}'::uuid[])) then
      return null;
    end if;
    return jsonb_build_object(
      'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', v_need)),
      'certain', false,
      'confidence', 'purchase_amount',
      'supplier_id', r.supplier_id,
      'reason', format('Alleen het bedrag past: inkoopfactuur %s%s staat precies zo open. Controleer het voordat je boekt.',
                       r.label, coalesce(' van ' || r.supplier_name, ''))
    );
  end if;

  -- Wie is de tegenpartij? Op IBAN (alleen als dat IBAN bij precies één
  -- leverancier hoort), op de naam van de tegenpartij, en op de naam in de
  -- omschrijving. Voor de naam tellen alleen leveranciers met iets openstaand
  -- in deze richting. Een naam telt als hele woorden: "kpn" in "kpn mobile",
  -- niet "ns" in "nsinternational"; in een omschrijving pas vanaf vier tekens.
  if v_iban is not null and coalesce(p_ibans ->> v_iban, '') <> '' then
    v_sup_iban := (p_ibans ->> v_iban)::uuid;
  end if;
  if v_cp is not null then
    v_cp_pad := ' ' || v_cp || ' ';
    select (array_agg(distinct c.supplier_id))[1] into v_sup_name
    from unnest(p_open) c
    where c.supplier_id is not null and c.open_cents * v_flip > 0 and c.name_norm is not null
      and ((length(c.name_norm) >= 2 and c.name_norm = v_cp)
           or (length(c.name_norm) >= 3 and strpos(v_cp_pad, ' ' || c.name_norm || ' ') > 0)
           or (length(v_cp) >= 4 and strpos(' ' || c.name_norm || ' ', v_cp_pad) > 0))
    having count(distinct c.supplier_id) = 1;
  end if;
  if v_desc is not null then
    v_desc_pad := ' ' || v_desc || ' ';
    select (array_agg(distinct c.supplier_id))[1] into v_sup_desc
    from unnest(p_open) c
    where c.supplier_id is not null and c.open_cents * v_flip > 0 and c.name_norm is not null
      and length(c.name_norm) >= 4 and strpos(v_desc_pad, ' ' || c.name_norm || ' ') > 0
    having count(distinct c.supplier_id) = 1;
  end if;
  v_ref_sup := coalesce(v_sup_iban, v_sup_name);

  -- ── Het nummer in de omschrijving ────────────────────────────────────────
  -- Op volgorde van noemen. Een factuur en een creditnota van de leverancier
  -- in één betaling mogen samen: dan is de creditnota negatief. Twee
  -- leveranciers kunnen hetzelfde factuurnummer gebruiken: is de tegenpartij
  -- bekend en noemt de omschrijving een factuur van hem, dan alleen die van hem.
  if length(coalesce(p_haystack, '')) >= 3 then
    with genoemd as (
      select x.id, x.label, x.supplier_id, x.natural, x.pos
      from (
        -- Eerst goedkoop: staat de tekst er letterlijk in? Pas dan de
        -- strengere controle (los kenmerk, niet "42" in "4211").
        select c.id, c.label, c.supplier_id, c.open_cents * v_flip as natural,
               least(
                 case when strpos(p_haystack, c.ref1_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref1) then strpos(p_haystack, c.ref1_norm) end,
                 case when strpos(p_haystack, c.ref2_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref2) then strpos(p_haystack, c.ref2_norm) end,
                 case when strpos(p_haystack, c.ref3_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref3) then strpos(p_haystack, c.ref3_norm) end
               ) as pos
        from unnest(p_open) c
        where strpos(p_haystack, c.ref1_norm) > 0
           or strpos(p_haystack, c.ref2_norm) > 0
           or strpos(p_haystack, c.ref3_norm) > 0
      ) x
      where x.pos is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'label', m.label, 'natural', m.natural, 'supplier_id', m.supplier_id) order by m.pos), '[]'::jsonb),
           count(*), coalesce(sum(m.natural), 0),
           -- Zeker alleen als het geld naar het IBAN van die leverancier ging,
           -- of als het IBAN niemand van ons zegt.
           v_sup_iban is null or bool_and(m.supplier_id is not distinct from v_sup_iban)
    into v_rows, v_n, v_sum, v_ref_ok
    from genoemd m
    where v_ref_sup is null
       or m.supplier_id = v_ref_sup
       or not exists (select 1 from genoemd g where g.supplier_id = v_ref_sup);
  else
    v_n := 0;
  end if;

  if v_n = 1 and (v_rows -> 0 ->> 'natural')::bigint > 0 then
    v_take := (v_rows -> 0 ->> 'natural')::bigint;
    if v_take = v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', coalesce(v_ref_ok, false), 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving en het bedrag klopt.', v_rows -> 0 ->> 'label')
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    elsif v_take > v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving. Er staat %s open, dus dit lijkt een deelbetaling.',
                         v_rows -> 0 ->> 'label', public.bank_eur(v_take)));
    else
      return jsonb_build_object(
        'allocations', jsonb_build_array(
          jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_take),
          jsonb_build_object('kind', 'ledger', 'amount_cents', v_need - v_take)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving, maar de betaling is %s hoger dan wat er openstaat (%s). Kies een rekening voor de rest.',
                         v_rows -> 0 ->> 'label', public.bank_eur(v_need - v_take), public.bank_eur(v_take)));
    end if;
  elsif v_n >= 2 then
    select string_agg(e ->> 'label', ', ') into v_labels from jsonb_array_elements(v_rows) e;
    if v_sum = v_need and exists (select 1 from jsonb_array_elements(v_rows) e where (e ->> 'natural')::bigint > 0) then
      select jsonb_agg(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', e ->> 'id', 'amount_cents', (e ->> 'natural')::bigint))
      into v_allocs from jsonb_array_elements(v_rows) e;
      return jsonb_build_object(
        'allocations', v_allocs, 'certain', coalesce(v_ref_ok, false), 'confidence', 'purchase_invoice',
        'supplier_id', case when (select count(distinct e ->> 'supplier_id') from jsonb_array_elements(v_rows) e) = 1 then v_rows -> 0 -> 'supplier_id' end,
        'reason', format('De omschrijving noemt %s, en samen klopt het bedrag precies.', v_labels)
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    end if;
    -- Klopt het niet precies: op volgorde van noemen tot het bedrag op is, de
    -- rest op een eigen regel. Hetzelfde als het verdeelscherm voorstelt.
    v_allocs := '[]'::jsonb;
    v_left := v_need;
    for r in select e ->> 'id' as id, (e ->> 'natural')::bigint as natural from jsonb_array_elements(v_rows) e loop
      if r.natural > 0 then
        v_take := least(r.natural, v_left);
        continue when v_take <= 0;
      else
        v_take := r.natural;
      end if;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', v_take));
      v_left := v_left - v_take;
    end loop;
    if jsonb_array_length(v_allocs) > 0 then
      if v_left > 0 then
        v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'ledger', 'amount_cents', v_left));
      end if;
      return jsonb_build_object(
        'allocations', v_allocs, 'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', null,
        'reason', format('De omschrijving noemt %s, maar samen komt dat niet precies op het bedrag. Controleer de verdeling.', v_labels));
    end if;
  end if;

  -- ── De leverancier ───────────────────────────────────────────────────────
  -- Hoort het IBAN bij een andere leverancier dan de naam, dan is de naam
  -- hooguit een voorstel: het geld ging naar dat IBAN.
  for v_try in
    select * from (values
      (1, v_sup_iban, 'iban', true),
      (2, v_sup_name, 'name', v_sup_iban is null),
      (3, v_sup_desc, 'description', false)
    ) as t(ord, supplier_id, how, may_be_certain)
    where t.supplier_id is not null
    order by t.ord
  loop
    -- De openstaande facturen van deze leverancier, oudste eerst. Een
    -- betaling ruim vóór de factuurdatum hoort er niet bij.
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'name', c.supplier_name,
                                                 'natural', c.open_cents * v_flip) order by c.due, c.date, c.id), '[]'::jsonb)
    into v_cands
    from unnest(p_open) c
    where c.supplier_id = v_try.supplier_id
      and c.open_cents * v_flip > 0
      and p_txn.booking_date >= c.date - 60;
    continue when jsonb_array_length(v_cands) = 0;

    select count(*) into v_exact from jsonb_array_elements(v_cands) e where (e ->> 'natural')::bigint = v_need;

    if v_exact = 1 then
      select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name into v_pick
      from jsonb_array_elements(v_cands) e where (e ->> 'natural')::bigint = v_need;
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_pick.id, 'amount_cents', v_need)),
        'certain', v_try.may_be_certain and v_try.how in ('iban', 'name'), 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', case v_try.how
          when 'iban' then format('Rekeningnummer van %s en het bedrag van inkoopfactuur %s.', v_pick.name, v_pick.label)
          when 'name' then format('Naam %s en het bedrag van inkoopfactuur %s.', v_pick.name, v_pick.label)
            || case when v_try.may_be_certain then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end
          else format('%s staat in de omschrijving en het bedrag past op inkoopfactuur %s. Controleer het voordat je boekt.', v_pick.name, v_pick.label)
        end);
    elsif v_exact > 1 then
      -- Meer facturen van deze leverancier met dit bedrag (een abonnement):
      -- de oudste die in deze ronde nog niet aan een andere betaling hing.
      select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name into v_pick
      from jsonb_array_elements(v_cands) with ordinality as t(e, ord)
      where (e ->> 'natural')::bigint = v_need
      order by ((e ->> 'id')::uuid = any(coalesce(p_claimed, '{}'::uuid[]))), ord
      limit 1;
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_pick.id, 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', format('%s openstaande facturen van %s hebben dit bedrag; de oudste (%s) is voorgesteld. Kies een andere als dat niet klopt.',
                         v_exact, v_pick.name, v_pick.label));
    end if;

    -- Een verzamelbetaling: precies de oudste k facturen samen (k ≥ 2).
    v_running := 0; v_k := 0; v_allocs := '[]'::jsonb; v_labels := null;
    for r in select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name, (e ->> 'natural')::bigint as natural
             from jsonb_array_elements(v_cands) with ordinality as t(e, ord) order by ord
    loop
      v_running := v_running + r.natural;
      v_k := v_k + 1;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', r.natural));
      v_labels := coalesce(v_labels || ', ', '') || r.label;
      exit when v_running >= v_need;
    end loop;
    if v_k >= 2 and v_running = v_need then
      return jsonb_build_object(
        'allocations', v_allocs,
        'certain', v_try.may_be_certain and v_try.how in ('iban', 'name'), 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', format('Verzamelbetaling aan %s: samen precies de %s oudste openstaande facturen (%s).', r.name, v_k, v_labels)
          || case when v_try.may_be_certain and v_try.how in ('iban', 'name') then '' else ' Controleer het voordat je boekt.' end);
    end if;
  end loop;

  return null;
end;
$$;

-- ── 5. De matchronde ────────────────────────────────────────────────────────
--
-- Voor intern gebruik: match_bank_transactions (de app, Gerrie, de API, het
-- inlezen en de bankkoppeling) controleert de rechten en roept dit aan, net als
-- de trigger op purchase_invoices. p_transaction_ids null = alles van de
-- organisatie (of de rekening), en dan eerst samenvoegen.
create or replace function public.bank_match_run(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_created_by uuid,
  p_transaction_ids uuid[],
  p_auto_book boolean,
  p_depth integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_inv record;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_auto_purchase integer := 0;
  v_merged integer := 0;
  v_haystack text;
  v_iban text;
  v_open public.bank_open_purchase_invoice[];
  v_ibans jsonb;
  v_auto_accounts jsonb;
  v_claimed uuid[] := '{}';
  v_match jsonb;
  v_ids uuid[];
  v_booked boolean;
  v_done boolean;
  v_sup_open integer;
  v_pending integer := 0;
  v_paid uuid[] := '{}';        -- in deze ronde vanzelf betaald
  v_sugg_txns uuid[] := '{}';   -- in deze ronde een voorstel met een inkoopfactuur
  v_redo uuid[];
  v_inner jsonb;
  -- Automatisch boeken kost per boeking zo'n 10 ms. Een eerste import met een
  -- jaar aan betalingen kan honderden zekere koppelingen geven; PostgREST
  -- breekt een aanroep na 8 seconden af en dan was de hele import weg. Na dit
  -- budget boekt de ronde niets meer vanzelf: wat zeker is, wordt een voorstel
  -- en de volgende ronde ("Opnieuw matchen", de volgende sync) boekt verder.
  -- De bankkoppeling (service-role, de dagelijkse sync) heeft die grens van
  -- 8 seconden niet en krijgt meer tijd.
  v_started timestamptz := clock_timestamp();
  v_budget interval := case when auth.role() = 'service_role' then interval '10 seconds' else interval '3 seconds' end;
  -- Het voorstel voor deze transactie; aan het eind één update.
  o_status text;
  o_account uuid;
  o_vat text;
  o_rule uuid;
  o_conf text;
  o_inv uuid;
  o_pi uuid;
  o_reason text;
  o_allocs jsonb;
begin
  if p_transaction_ids is null then
    v_merged := public.merge_manual_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
  end if;

  v_open := public.bank_open_purchase_invoices(p_organization_id);
  v_ibans := public.bank_supplier_ibans(p_organization_id);
  select coalesce(jsonb_object_agg(ba.id::text, ba.auto_book_purchase_invoices), '{}'::jsonb)
  into v_auto_accounts
  from public.bank_accounts ba where ba.organization_id = p_organization_id;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      -- GEWIJZIGD (20261118190000): ook bestaande voorstellen opnieuw. Kwam de
      -- inkoopfactuur na de betaling, dan bleef "boek op 4500" staan.
      and status in ('unmatched', 'suggested')
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
      and (p_transaction_ids is null or id = any(p_transaction_ids))
    order by booking_date, created_at, id
  loop
    o_status := 'unmatched'; o_account := null; o_vat := null; o_rule := null; o_conf := null;
    o_inv := null; o_pi := null; o_reason := null; o_allocs := null;
    v_done := false; v_booked := false; v_match := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    -- 1. Ontvangst: verkoopfactuur op factuurnummer (zoals voorheen). Eerst
    --    goedkoop zoeken of het nummer er überhaupt in staat.
    if v_txn.amount_cents > 0 then
      select i.id, i.number into v_inv
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and strpos(v_haystack, lower(regexp_replace(i.number, '\s', '', 'g'))) > 0
        and public.bank_text_mentions_reference(v_haystack, i.number)
        and public.invoice_open_receivable_cents(p_organization_id, i.id) > 0
      order by (case when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 0 else 1 end), i.date desc
      limit 1;
      if v_inv.id is not null then
        o_status := 'suggested'; o_inv := v_inv.id; o_conf := 'invoice';
        o_reason := format('Factuurnummer %s staat in de omschrijving.', v_inv.number);
        v_done := true;
      end if;
    end if;

    -- 2. Inkoopfactuur op nummer of leverancier. Vóór de bankregels: een
    --    regel "KPN → 4500" boekte anders de betaling van een geboekte
    --    KPN-factuur nog eens als kosten.
    if not v_done then
      v_match := public.bank_purchase_match(v_txn, v_haystack, v_open, v_ibans, v_claimed, 'strong');
    end if;

    if not v_done and v_match is not null then
      select array_agg((a ->> 'purchase_invoice_id')::uuid) into v_ids
      from jsonb_array_elements(v_match -> 'allocations') a
      where a ->> 'kind' = 'purchase_invoice';
      o_reason := v_match ->> 'reason';

      if (v_match ->> 'certain')::boolean then
        if v_txn.auto_book_blocked then
          o_reason := o_reason || ' Je draaide een automatische boeking hiervan terug; ResoFly boekt hem niet meer vanzelf.';
        elsif not coalesce((v_auto_accounts ->> v_txn.bank_account_id::text)::boolean, true) then
          o_reason := o_reason || ' Automatisch boeken staat uit voor deze rekening.';
        elsif p_auto_book and clock_timestamp() - v_started > v_budget then
          o_reason := o_reason || ' Nog niet geboekt: er kwam veel tegelijk binnen. "Opnieuw matchen" boekt de rest.';
          v_pending := v_pending + 1;
        elsif p_auto_book then
          begin
            perform public.book_bank_transaction(
              p_organization_id, v_txn.id, null, null, null, p_created_by, v_match -> 'allocations', null);
            update public.bank_transactions set
              auto_booked = true,
              match_confidence = v_match ->> 'confidence',
              match_reason = v_match ->> 'reason',
              suggested_allocations = null,
              suggested_account_id = null,
              suggested_vat_code = null,
              matched_rule_id = null,
              updated_at = now()
            where id = v_txn.id;
            v_booked := true;
          exception when others then
            -- Afgesloten periode, een andere valuta, net door iemand anders
            -- geboekt: dan blijft het een voorstel, met de reden erbij.
            o_reason := o_reason || ' Automatisch boeken lukte niet: ' || sqlerrm;
          end;
        end if;
      end if;

      if v_booked then
        v_auto := v_auto + 1;
        v_auto_purchase := v_auto_purchase + 1;
        v_paid := v_paid || coalesce(v_ids, '{}'::uuid[]);
        -- Wat er nu nog openstaat; zo krijgt een tweede betaling van hetzelfde
        -- bedrag deze factuur niet ook.
        select coalesce(array_agg(x.c order by (x.c).due, (x.c).date, (x.c).id), '{}') into v_open
        from (
          select case when c.id = any(v_ids)
                      then row(c.id, c.supplier_id, c.supplier_name, c.name_norm, c.label,
                               c.ref1, c.ref2, c.ref3, c.ref1_norm, c.ref2_norm, c.ref3_norm,
                               public.purchase_invoice_open_payable_cents(p_organization_id, c.id), c.date, c.due)::public.bank_open_purchase_invoice
                      else row(c.*)::public.bank_open_purchase_invoice end as c
          from unnest(v_open) c
        ) x
        where (x.c).open_cents <> 0;
        continue;
      end if;

      o_status := 'suggested';
      o_conf := v_match ->> 'confidence';
      if jsonb_array_length(v_match -> 'allocations') = 1 then
        o_pi := v_ids[1];
      else
        o_allocs := v_match -> 'allocations';
      end if;
      v_claimed := v_claimed || coalesce(v_ids, '{}'::uuid[]);
      v_done := true;
    end if;

    -- 3. Bankregels op prioriteit; eerste match wint.
    if not v_done then
      select * into v_rule
      from public.bank_rules r
      where r.organization_id = p_organization_id
        and r.is_active
        and (r.match_direction = 'both'
             or (r.match_direction = 'in' and v_txn.amount_cents > 0)
             or (r.match_direction = 'out' and v_txn.amount_cents < 0))
        and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = v_iban)
        and (r.match_counterparty_name_contains is null or coalesce(v_txn.counterparty_name,'') ilike public.like_contains_pattern(r.match_counterparty_name_contains))
        and (r.match_description_contains is null or coalesce(v_txn.description,'') ilike public.like_contains_pattern(r.match_description_contains))
        and (r.match_amount_cents is null or r.match_amount_cents = abs(v_txn.amount_cents))
      order by r.priority, r.created_at
      limit 1;

      if v_rule.id is not null then
        o_reason := format('Bankregel "%s".', v_rule.name);
        if p_auto_book and v_rule.auto_book and v_rule.target_account_id is not null then
          if v_txn.auto_book_blocked then
            -- GEWIJZIGD (20261118190000): na terugdraaien niet opnieuw vanzelf.
            o_reason := o_reason || ' Je draaide een automatische boeking hiervan terug; ResoFly boekt hem niet meer vanzelf.';
          elsif clock_timestamp() - v_started > v_budget then
            o_reason := o_reason || ' Nog niet geboekt: er kwam veel tegelijk binnen. "Opnieuw matchen" boekt de rest.';
            v_pending := v_pending + 1;
          else
            begin
              perform public.book_bank_transaction(
                p_organization_id, v_txn.id,
                jsonb_build_array(jsonb_build_object(
                  'account_id', v_rule.target_account_id,
                  'amount_cents', abs(v_txn.amount_cents),
                  'vat_code', v_rule.target_vat_code,
                  'description', v_rule.name
                )),
                null, null, p_created_by
              );
              update public.bank_transactions set
                auto_booked = true,
                matched_rule_id = v_rule.id,
                match_confidence = 'rule',
                match_reason = format('Bankregel "%s".', v_rule.name),
                suggested_allocations = null,
                updated_at = now()
              where id = v_txn.id;
              v_booked := true;
            exception when others then
              -- Automatisch boeken mislukt (bv. afgesloten periode): zet als
              -- voorstel klaar i.p.v. de hele import/match terug te draaien.
              o_reason := o_reason || ' Automatisch boeken lukte niet: ' || sqlerrm;
            end;
          end if;
        end if;
        if v_booked then
          v_auto := v_auto + 1;
          continue;
        end if;
        o_status := 'suggested';
        o_account := v_rule.target_account_id;
        o_vat := v_rule.target_vat_code;
        o_rule := v_rule.id;
        o_conf := 'rule';
        v_done := true;
      end if;
    end if;

    -- 4. Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    --    omzetbelasting voor, alleen als het bedrag past op een ingediende, nog
    --    niet betaalde aangifte of de omschrijving over btw gaat (zoals voorheen).
    if not v_done
       and (v_iban = 'NL86INGB0002445588'
            or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%')
       and (
         exists (
           select 1 from public.vat_returns vr
           where vr.organization_id = p_organization_id
             and vr.status = 'filed'
             and vr.paid_bank_transaction_id is null
             and coalesce((vr.rubrieken->>'saldo_afgerond')::bigint, 0) = -v_txn.amount_cents
         )
         or lower(coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.structured_reference, '')) ~ '(omzetbelasting|\mbtw\M|\mob\M)'
       ) then
      o_status := 'suggested';
      o_account := public.bookkeeping_account_id(p_organization_id, '1530');
      o_conf := 'tax_authority';
      o_reason := 'Herkend als Belastingdienst: omzetbelasting (1530).';
      v_done := true;
    end if;

    -- 5. Alleen het bedrag van één openstaande inkoopfactuur. Na de regels en
    --    de Belastingdienst: dit is het zwakste signaal.
    if not v_done then
      v_match := public.bank_purchase_match(v_txn, v_haystack, v_open, v_ibans, v_claimed, 'amount');
      if v_match is not null then
        o_status := 'suggested';
        o_conf := 'purchase_amount';
        o_pi := (v_match -> 'allocations' -> 0 ->> 'purchase_invoice_id')::uuid;
        o_reason := v_match ->> 'reason';
        v_claimed := v_claimed || o_pi;
        v_done := true;
      end if;
    end if;

    -- 6. Geen regel: bij een betaling de leverancier op IBAN, met zijn
    --    standaard kostenrekening (zoals voorheen).
    if not v_done and v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        o_status := 'suggested';
        o_account := v_sup.default_expense_account_id;
        o_vat := v_sup.default_vat_code;
        o_conf := 'supplier_iban';
        o_reason := format('Rekeningnummer van %s; de standaard kostenrekening van die leverancier.', v_sup.name);
        -- TOEGEVOEGD (20261118190000): staat er bij deze leverancier nog iets
        -- open, dan telt deze betaling op een kostenrekening de kosten dubbel.
        select count(*) into v_sup_open
        from unnest(v_open) c
        where c.supplier_id = v_sup.id and c.open_cents > 0;
        if v_sup_open > 0 then
          o_reason := o_reason || format(' Let op: %s heeft nog %s openstaande inkoopfactu%s, maar geen met dit bedrag. Hoort de betaling bij een factuur, kies die dan; op een kostenrekening tellen de kosten anders dubbel.',
                                         v_sup.name, v_sup_open, case when v_sup_open = 1 then 'ur' else 'ren' end);
        end if;
        v_done := true;
      end if;
    end if;

    update public.bank_transactions set
      status = o_status,
      suggested_account_id = o_account,
      suggested_vat_code = o_vat,
      matched_rule_id = o_rule,
      match_confidence = o_conf,
      matched_invoice_id = o_inv,
      matched_purchase_invoice_id = o_pi,
      match_reason = o_reason,
      suggested_allocations = o_allocs,
      updated_at = now()
    where id = v_txn.id
      and (status, suggested_account_id, suggested_vat_code, matched_rule_id, match_confidence,
           matched_invoice_id, matched_purchase_invoice_id, match_reason, suggested_allocations)
          is distinct from
          (o_status, o_account, o_vat, o_rule, o_conf, o_inv, o_pi, o_reason, o_allocs);
    if o_status = 'suggested' then
      v_suggested := v_suggested + 1;
    end if;
    if o_pi is not null or o_allocs is not null then
      v_sugg_txns := v_sugg_txns || v_txn.id;
    end if;
  end loop;

  -- Een voorstel kan in dezelfde ronde zijn ingehaald: een later gedateerde
  -- betaling bleek zeker bij die factuur te horen en is geboekt. Dan wees het
  -- voorstel naar een betaalde factuur. Die transacties nog één keer, nu
  -- tegen wat er werkelijk nog openstaat.
  if p_depth < 2 and cardinality(v_paid) > 0 and cardinality(v_sugg_txns) > 0 then
    select array_agg(t.id) into v_redo
    from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.id = any(v_sugg_txns)
      and t.status = 'suggested'
      and (t.matched_purchase_invoice_id = any(v_paid)
           or exists (select 1 from jsonb_array_elements(coalesce(t.suggested_allocations, '[]'::jsonb)) a
                      where a ->> 'purchase_invoice_id' is not null
                        and (a ->> 'purchase_invoice_id')::uuid = any(v_paid)));
    if v_redo is not null then
      v_inner := public.bank_match_run(p_organization_id, null, p_created_by, v_redo, p_auto_book, p_depth + 1);
      v_suggested := v_suggested - cardinality(v_redo) + coalesce((v_inner ->> 'suggested')::integer, 0);
      v_auto := v_auto + coalesce((v_inner ->> 'auto_booked')::integer, 0);
      v_auto_purchase := v_auto_purchase + coalesce((v_inner ->> 'auto_booked_purchase')::integer, 0);
      v_pending := v_pending + coalesce((v_inner ->> 'auto_book_pending')::integer, 0);
    end if;
  end if;

  return jsonb_build_object(
    'suggested', v_suggested,
    'auto_booked', v_auto,
    'auto_booked_purchase', v_auto_purchase,
    -- Zeker, maar door het tijdsbudget nog niet geboekt.
    'auto_book_pending', v_pending,
    'merged', v_merged
  );
end;
$$;

-- De openbare ingang, met dezelfde handtekening als sinds 20261107110000: de
-- app, Gerrie, de API, het inlezen (import_bank_transactions) en de
-- handmatige mutaties roepen hem al zo aan.
create or replace function public.match_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid(),
  p_transaction_id uuid default null,
  p_auto_book boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- Een rekening van een andere organisatie levert niets op (bank_match_run
  -- filtert op de organisatie), maar zeg het liever hardop.
  if p_bank_account_id is not null and not exists (
    select 1 from public.bank_accounts ba where ba.id = p_bank_account_id and ba.organization_id = p_organization_id
  ) then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;
  return public.bank_match_run(
    p_organization_id, p_bank_account_id, p_created_by,
    case when p_transaction_id is null then null else array[p_transaction_id] end,
    p_auto_book);
end;
$$;

-- ── 6. Een inkoopfactuur geboekt (of tegengeboekt) ──────────────────────────
--
-- Komt de factuur ná de betaling (een incasso, een bon), dan zoekt de database
-- bij het boeken meteen de openstaande betalingen die erbij kunnen horen: op
-- bedrag, IBAN, naam of nummer. Die gaan door de gewone matchronde, dus met
-- dezelfde regels voor zeker en twijfel. Het boeken van de factuur zelf mag
-- hier nooit op stuklopen.
create or replace function public.bank_match_for_purchase_invoice(
  p_organization_id uuid,
  p_purchase_invoice_id uuid,
  p_created_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_open bigint;
  v_name text;
  v_ibans text[];
  v_refs text[];
  v_ids uuid[];
begin
  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id;
  if not found or v_pi.journal_entry_id is null then
    return null;
  end if;
  v_open := public.purchase_invoice_open_payable_cents(p_organization_id, v_pi.id);
  if v_open = 0 then
    return null;
  end if;

  select public.bank_name_norm(s.name) into v_name
  from public.suppliers s where s.id = v_pi.supplier_id and s.organization_id = p_organization_id;
  select coalesce(array_agg(k), '{}') into v_ibans
  from jsonb_each_text(public.bank_supplier_ibans(p_organization_id)) as m(k, v)
  where v_pi.supplier_id is not null and m.v = v_pi.supplier_id::text;
  v_refs := array_remove(array[
    nullif(btrim(v_pi.internal_number), ''),
    nullif(btrim(v_pi.supplier_invoice_number), ''),
    nullif(btrim(coalesce(v_pi.extraction_meta ->> 'payment_reference', '')), '')
  ], null);

  select array_agg(x.id) into v_ids
  from (
    select t.id
    from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.status in ('unmatched', 'suggested')
      and case when v_open > 0 then t.amount_cents < 0 else t.amount_cents > 0 end
      and (
        abs(t.amount_cents) = abs(v_open)
        or public.bank_norm_iban(t.counterparty_iban) = any(v_ibans)
        or public.bank_name_matches(public.bank_name_norm(t.counterparty_name), v_name, false)
        or public.bank_name_matches(public.bank_name_norm(coalesce(t.description, '') || ' ' || coalesce(t.structured_reference, '')), v_name, true)
        or exists (
          select 1 from unnest(v_refs) as ref
          where public.bank_text_mentions_reference(
            lower(replace(coalesce(t.description, '') || ' ' || coalesce(t.structured_reference, ''), ' ', '')), ref)
        )
      )
    order by t.booking_date desc
    limit 200
  ) x;

  if v_ids is null then
    return jsonb_build_object('suggested', 0, 'auto_booked', 0, 'auto_booked_purchase', 0, 'auto_book_pending', 0, 'merged', 0);
  end if;
  return public.bank_match_run(p_organization_id, null, p_created_by, v_ids, true);
end;
$$;

create or replace function public.purchase_invoices_bank_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  begin
    if new.journal_entry_id is not null then
      perform public.bank_match_for_purchase_invoice(new.organization_id, new.id, auth.uid());
    else
      -- Tegengeboekt: voorstellen die naar deze factuur wezen, opnieuw.
      select array_agg(t.id) into v_ids
      from public.bank_transactions t
      where t.organization_id = new.organization_id
        and t.status = 'suggested'
        and (t.matched_purchase_invoice_id = new.id
             or coalesce(t.suggested_allocations, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('purchase_invoice_id', new.id)));
      if v_ids is not null then
        perform public.bank_match_run(new.organization_id, null, auth.uid(), v_ids, false);
      end if;
    end if;
  exception when others then
    raise warning 'Betalingen koppelen aan inkoopfactuur % mislukt: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists purchase_invoices_bank_match on public.purchase_invoices;
create trigger purchase_invoices_bank_match
  after update of journal_entry_id on public.purchase_invoices
  for each row
  when (old.journal_entry_id is distinct from new.journal_entry_id)
  execute function public.purchase_invoices_bank_match();

-- ── 7. Terugdraaien: niet opnieuw vanzelf boeken ────────────────────────────
--
-- unbook_bank_transaction zet de transactie terug op 'unmatched'. Was hij door
-- de matcher geboekt, dan boekte de volgende import of "Opnieuw matchen" hem
-- meteen weer (bij een bankregel met "automatisch boeken" gebeurde dat al).
-- Hier, en niet in unbook_bank_transaction: elke weg terug telt.
create or replace function public.bank_transactions_auto_book_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'booked' and new.status <> 'booked' then
    if old.auto_booked then
      new.auto_book_blocked := true;
    end if;
    new.auto_booked := false;
  end if;
  return new;
end;
$$;

drop trigger if exists bank_transactions_auto_book_guard on public.bank_transactions;
create trigger bank_transactions_auto_book_guard
  before update of status on public.bank_transactions
  for each row execute function public.bank_transactions_auto_book_guard();

-- ── 8. Inlezen: zeggen wat de matcher deed ──────────────────────────────────
-- Gelijk aan 20261107110000, met het resultaat van de matcher in de uitkomst
-- (TOEGEVOEGD).
CREATE OR REPLACE FUNCTION public.import_bank_transactions(p_organization_id uuid, p_bank_account_id uuid, p_statement jsonb, p_transactions jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ba public.bank_accounts;
  v_stmt_id uuid;
  v_inserted integer := 0;
  v_total integer := 0;
  v_hash text;
  v_opening bigint;
  v_closing bigint;
  v_period_start date;
  v_period_end date;
  v_sum bigint;
  v_balance_ok boolean := null;
  v_balance_diff bigint := null;
  v_no_date integer := 0;
  v_zero integer := 0;
  -- TOEGEVOEGD (20261118190000): wat de matcher deed.
  v_match jsonb := null;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_transactions is null or jsonb_typeof(p_transactions) <> 'array' or jsonb_array_length(p_transactions) = 0 then
    raise exception 'Geen transacties om te importeren.' using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts
  where id = p_bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_total := jsonb_array_length(p_transactions);

  -- Uitgesplitst tellen wat er niet ingaat. Voorheen was er één 'skipped'-getal
  -- dat "al bekend" betekende; nu vallen er ook regels af op een ontbrekende
  -- datum of een bedrag van € 0,00 en dan wil je weten wélke van de drie het is.
  select
    count(*) filter (where nullif(l->>'booking_date','')::date is null),
    count(*) filter (where nullif(l->>'booking_date','')::date is not null
                       and coalesce((l->>'amount_cents')::bigint, 0) = 0)
  into v_no_date, v_zero
  from jsonb_array_elements(p_transactions) l;

  if p_statement is not null and jsonb_typeof(p_statement) = 'object' then
    v_hash := nullif(p_statement->>'file_hash', '');
    v_opening := nullif(p_statement->>'opening_balance_cents', '')::bigint;
    v_closing := nullif(p_statement->>'closing_balance_cents', '')::bigint;
    v_period_start := nullif(p_statement->>'period_start', '')::date;
    v_period_end := nullif(p_statement->>'period_end', '')::date;

    -- Hetzelfde bestand nogmaals inlezen hoort geen tweede afschriftrij te maken:
    -- dat vertroebelt de saldocontrole (een her-import zou als "afschrift zonder
    -- transacties" verschijnen omdat alle regels op de dedup afketsen).
    if v_hash is not null then
      select id into v_stmt_id from public.bank_statements
      where bank_account_id = p_bank_account_id and file_hash = v_hash
      order by imported_at limit 1;
    end if;

    if v_stmt_id is not null then
      update public.bank_statements set
        period_start = coalesce(v_period_start, period_start),
        period_end = coalesce(v_period_end, period_end),
        opening_balance_cents = coalesce(v_opening, opening_balance_cents),
        closing_balance_cents = coalesce(v_closing, closing_balance_cents),
        transaction_count = greatest(transaction_count, v_total)
      where id = v_stmt_id;
    else
      insert into public.bank_statements(
        organization_id, created_by, bank_account_id, format, file_name, file_hash,
        period_start, period_end, opening_balance_cents, closing_balance_cents, transaction_count
      ) values (
        p_organization_id, p_created_by, p_bank_account_id,
        coalesce(nullif(p_statement->>'format',''), 'csv'),
        nullif(p_statement->>'file_name',''),
        v_hash,
        v_period_start, v_period_end,
        v_opening, v_closing, v_total
      ) returning id into v_stmt_id;
    end if;
  end if;

  -- De dedup-sleutel wordt hier afgeleid; een door de client meegestuurde
  -- dedup_key wordt bewust genegeerd (zie kop van deze migratie).
  with src as (
    select
      nullif(l->>'booking_date','')::date as booking_date,
      nullif(l->>'value_date','')::date as value_date,
      coalesce((l->>'amount_cents')::bigint, 0) as amount_cents,
      coalesce(nullif(l->>'currency',''), v_ba.currency) as currency,
      nullif(l->>'counterparty_name','') as counterparty_name,
      nullif(l->>'counterparty_iban','') as counterparty_iban,
      nullif(l->>'description','') as description,
      nullif(l->>'structured_reference','') as structured_reference,
      nullif(l->>'end_to_end_id','') as end_to_end_id,
      nullif(l->>'bank_tx_id','') as bank_tx_id,
      ord
    from jsonb_array_elements(p_transactions) with ordinality as t(l, ord)
  ),
  keyed as (
    select
      src.*,
      'c:' || public.bank_canonical_key(booking_date, amount_cents, counterparty_iban, description)
          || ':' ||
          row_number() over (
            partition by public.bank_canonical_key(booking_date, amount_cents, counterparty_iban, description)
            order by ord
          ) as dedup_key
    from src
    where src.booking_date is not null and src.amount_cents <> 0
  ),
  ins as (
    insert into public.bank_transactions(
      organization_id, bank_account_id, statement_id, dedup_key, booking_date, value_date,
      amount_cents, currency, counterparty_name, counterparty_iban, description,
      structured_reference, end_to_end_id, bank_tx_id, status
    )
    select
      p_organization_id, p_bank_account_id, v_stmt_id, keyed.dedup_key, keyed.booking_date, keyed.value_date,
      keyed.amount_cents, keyed.currency, keyed.counterparty_name, keyed.counterparty_iban, keyed.description,
      keyed.structured_reference, keyed.end_to_end_id, keyed.bank_tx_id, 'unmatched'
    from keyed
    on conflict (bank_account_id, dedup_key) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  update public.bank_accounts set last_imported_at = now() where id = p_bank_account_id;

  -- Afschriftcontrole: beginsaldo + alle mutaties in de afschriftperiode moet het
  -- eindsaldo opleveren. Klopt dat niet, dan mist het bestand regels — dat wil je
  -- direct weten, niet pas bij de jaarrekening.
  --
  -- Bewust op DATUMBEREIK en niet op statement_id: bij overlappende afschriften
  -- (eerst jan.csv, dan jan-feb.csv) ketsen de januari-regels af op de dedup en
  -- houden ze het statement_id van de eerste import. Tellen op statement_id zou
  -- dan alleen februari zien tegen een begin-/eindsaldo over jan+feb — structureel
  -- vals alarm, precies de ruis die deze controle onbruikbaar zou maken.
  -- GEWIJZIGD (20261107110000): handmatige mutaties staan op geen enkel
  -- afschrift; die tellen hier niet mee (anders klopte geen afschrift meer).
  if v_stmt_id is not null and v_opening is not null and v_closing is not null
     and v_period_start is not null and v_period_end is not null then
    select coalesce(sum(amount_cents), 0) into v_sum
    from public.bank_transactions
    where bank_account_id = p_bank_account_id
      and not is_manual
      and booking_date between v_period_start and v_period_end;
    v_balance_diff := v_closing - (v_opening + v_sum);
    v_balance_ok := v_balance_diff = 0;
  end if;

  -- Alleen matchen als er echt iets bij is gekomen: match_bank_transactions loopt
  -- rij voor rij door álle openstaande transacties van de organisatie, en dat is
  -- zonde bij een her-import die niets toevoegt. De knop "Opnieuw matchen" blijft
  -- beschikbaar om het alsnog af te dwingen.
  if v_inserted > 0 then
    v_match := public.match_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    -- 'skipped' blijft het totaal-overgeslagen voor bestaande aanroepers; de
    -- uitsplitsing zegt waaróm, zodat de UI niet hoeft te gissen.
    'skipped', v_total - v_inserted,
    'duplicates', greatest(v_total - v_inserted - v_no_date - v_zero, 0),
    'skipped_no_date', v_no_date,
    'skipped_zero_amount', v_zero,
    'statement_id', v_stmt_id,
    'balance_ok', v_balance_ok,
    'balance_difference_cents', v_balance_diff,
    -- TOEGEVOEGD (20261118190000): zodat het scherm kan zeggen "5 meteen
    -- geboekt, 3 voorstellen" in plaats van alleen "8 nieuw".
    'auto_booked', coalesce((v_match ->> 'auto_booked')::integer, 0),
    'auto_booked_purchase', coalesce((v_match ->> 'auto_booked_purchase')::integer, 0),
    'suggested', coalesce((v_match ->> 'suggested')::integer, 0),
    'auto_book_pending', coalesce((v_match ->> 'auto_book_pending')::integer, 0),
    'merged', coalesce((v_match ->> 'merged')::integer, 0)
  );
end;
$function$;

-- ── 9. Rechten ──────────────────────────────────────────────────────────────

revoke all on function public.bank_norm_iban(text) from public, anon, authenticated;
revoke all on function public.bank_name_norm(text) from public, anon, authenticated;
revoke all on function public.bank_name_matches(text, text, boolean) from public, anon, authenticated;
revoke all on function public.bank_open_purchase_invoices(uuid) from public, anon, authenticated;
revoke all on function public.bank_supplier_ibans(uuid) from public, anon, authenticated;
revoke all on function public.bank_purchase_match(public.bank_transactions, text, public.bank_open_purchase_invoice[], jsonb, uuid[], text) from public, anon, authenticated;
revoke all on function public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer) from public, anon, authenticated;
revoke all on function public.bank_match_for_purchase_invoice(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.purchase_invoices_bank_match() from public, anon, authenticated;
revoke all on function public.bank_transactions_auto_book_guard() from public, anon, authenticated;
grant execute on function public.bank_norm_iban(text) to service_role;
grant execute on function public.bank_name_norm(text) to service_role;
grant execute on function public.bank_name_matches(text, text, boolean) to service_role;
grant execute on function public.bank_open_purchase_invoices(uuid) to service_role;
grant execute on function public.bank_supplier_ibans(uuid) to service_role;
grant execute on function public.bank_purchase_match(public.bank_transactions, text, public.bank_open_purchase_invoice[], jsonb, uuid[], text) to service_role;
grant execute on function public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer) to service_role;
grant execute on function public.bank_match_for_purchase_invoice(uuid, uuid, uuid) to service_role;

revoke all on function public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean) to authenticated, service_role;
revoke all on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
