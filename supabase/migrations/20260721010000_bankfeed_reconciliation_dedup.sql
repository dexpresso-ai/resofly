-- ============================================================
-- ResoFly — Bankfeed Blok B: saldo-aansluiting + één dedup-sleutel
-- Date: 2026-07-21
-- Bron: REVIEW_FINANCIELE_MODULE_2026-07-21.md (§6, Blok B — punten 7/8/9)
--
--  B1  SALDO-AANSLUITING. begin-/eindsaldo werden uit CAMT/MT940 gelezen,
--      opgeslagen in bank_statements en NOOIT teruggelezen. Daardoor bleef
--      elke ontbrekende of dubbele transactie onzichtbaar tot de jaarrekening.
--      Nieuw: report_bank_reconciliation() zet per bankrekening het
--      afschriftsaldo naast de grootboekstand (+ nog te boeken transacties)
--      en meldt het verschil, plus afschriften die intern niet kloppen en
--      vermoedelijke dubbelen.
--
--  B2  ÉÉN DEDUP-SLEUTEL. De afschrift-import maakte sleutels `tx:`/`h:`,
--      de Enable-Banking-sync `eb:` — dezelfde transactie via beide wegen gaf
--      dus twee rijen (en met de default-koppeling op 1100 een dubbel
--      banksaldo). Nieuw: de sleutel wordt UITSLUITEND server-side afgeleid
--      uit de inhoud (datum|bedrag|tegenrekening|omschrijving) met een
--      volgnummer binnen de aangeleverde batch. Client-sleutels worden
--      genegeerd. Bestaande rijen worden omgenummerd naar hetzelfde schema,
--      zodat een her-import van oude afschriften niets dubbel toevoegt.
--
--      EERLIJKE BEPERKING: het recept is nu geünificeerd, de INVOER niet.
--      De omschrijving die CAMT, MT940, CSV en de PSD2-sync aanleveren voor
--      dezelfde transactie kan verschillen (MT940 levert vaak geen tegen-IBAN,
--      CSV plakt kolommen aan elkaar). Binnen één kanaal is de ontdubbeling
--      sluitend; tussen kanalen onderling niet gegarandeerd. Dáárvoor is B1 het
--      vangnet: als er dan tóch iets dubbel binnenkomt, loopt het banksaldo
--      zichtbaar uit de pas in plaats van stilletjes.
--
--      Ook: hetzelfde bestand twee keer inlezen maakte elke keer een nieuwe
--      bank_statements-rij (file_hash werd opgeslagen maar nooit gebruikt).
--      Nu wordt de bestaande afschriftrij hergebruikt op (rekening, file_hash).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Canonieke sleutel: de inhoud van de transactie, bron-onafhankelijk.
--    Bewust NIET de bankreferentie: die verschilt per aanleverkanaal
--    (CAMT AcctSvcrRef vs. Enable Banking entry_reference) en is juist de
--    oorzaak van de dubbelingen die deze migratie oplost.
-- ------------------------------------------------------------
-- De datum gaat als DAGNUMMER de hash in, niet als tekst: `date::text` volgt de
-- DateStyle van de sessie (ISO vs. German), en die functie is daarmee niet echt
-- immutable. Liep de DateStyle van de migratiesessie uiteen met die van de
-- PostgREST-rol, dan zou een her-import van oude afschriften compleet nieuwe
-- sleutels krijgen — precies de dubbelingen die dit moet voorkomen.
create or replace function public.bank_canonical_key(
  p_booking_date date,
  p_amount_cents bigint,
  p_iban text,
  p_description text
)
returns text
language sql
immutable
set search_path = public
as $$
  select md5(
    coalesce((p_booking_date - date '2000-01-01')::text, '') || '|' ||
    coalesce(p_amount_cents::text, '0') || '|' ||
    upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')) || '|' ||
    lower(btrim(regexp_replace(coalesce(p_description, ''), '\s+', ' ', 'g')))
  );
$$;

-- ------------------------------------------------------------
-- 2. Bestaande rijen omnummeren naar het nieuwe schema.
--    Oude sleutels beginnen met tx:/h:/eb:, nieuwe met c: — ze kunnen elkaar
--    dus tijdens de update niet in de weg zitten (unique(bank_account_id,
--    dedup_key)). Binnen een rekening is (canoniek, volgnummer) uniek.
--    Deterministische volgorde (created_at, id) zodat de nummering stabiel is.
-- ------------------------------------------------------------
with ranked as (
  select
    id,
    public.bank_canonical_key(booking_date, amount_cents, counterparty_iban, description) as canon,
    row_number() over (
      partition by bank_account_id,
        public.bank_canonical_key(booking_date, amount_cents, counterparty_iban, description)
      order by created_at, id
    ) as occ
  from public.bank_transactions
)
update public.bank_transactions bt
set dedup_key = 'c:' || r.canon || ':' || r.occ
from ranked r
where r.id = bt.id
  and bt.dedup_key is distinct from ('c:' || r.canon || ':' || r.occ);

-- ------------------------------------------------------------
-- 3. import_bank_transactions: sleutel server-side, afschrift hergebruiken
--    op file_hash, en de afschrift-balanscontrole meegeven in het resultaat.
-- ------------------------------------------------------------
create or replace function public.import_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_statement jsonb,
  p_transactions jsonb,
  p_created_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
  if v_stmt_id is not null and v_opening is not null and v_closing is not null
     and v_period_start is not null and v_period_end is not null then
    select coalesce(sum(amount_cents), 0) into v_sum
    from public.bank_transactions
    where bank_account_id = p_bank_account_id
      and booking_date between v_period_start and v_period_end;
    v_balance_diff := v_closing - (v_opening + v_sum);
    v_balance_ok := v_balance_diff = 0;
  end if;

  -- Alleen matchen als er echt iets bij is gekomen: match_bank_transactions loopt
  -- rij voor rij door álle openstaande transacties van de organisatie, en dat is
  -- zonde bij een her-import die niets toevoegt. De knop "Opnieuw matchen" blijft
  -- beschikbaar om het alsnog af te dwingen.
  if v_inserted > 0 then
    perform public.match_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
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
    'balance_difference_cents', v_balance_diff
  );
end;
$$;

-- ------------------------------------------------------------
-- 4. report_bank_reconciliation: sluit de bank aan op het grootboek.
--
-- De controle: eindsaldo van het laatste afschrift moet gelijk zijn aan de
-- grootboekstand van de gekoppelde rekening PLUS alles wat wel binnen is maar
-- nog niet geboekt (open voorstellen én genegeerde regels — die staan immers
-- wél op het afschrift). Beide zijden worden op dezelfde peildatum
-- (het einde van dat afschrift) gemeten, anders vergelijk je appels met peren.
-- ------------------------------------------------------------
create or replace function public.report_bank_reconciliation(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(s.row_json order by s.acc_name), '[]'::jsonb) into v_out
  from (
    select
      ba.name as acc_name,
      jsonb_build_object(
        'bank_account_id', ba.id,
        'name', ba.name,
        'iban', ba.iban,
        'source', ba.source,
        'ledger_code', la.code,
        'ledger_name', la.name,
        -- Meerdere bankrekeningen op dezelfde grootboekrekening (standaard boekt
        -- alles op 1100): dan is de stand van die rekening de SOM van beide en
        -- kun je niet per rekening aansluiten. De UI waarschuwt daarvoor.
        'shares_ledger_account', shr.shared,
        'as_of', st.period_end,
        'statement_id', st.id,
        'statement_closing_cents', st.closing_balance_cents,
        'ledger_balance_cents', led.balance_cents,
        'has_opening_balance', coalesce(led.has_opening, false),
        'unbooked_count', tx.unbooked_count,
        'unbooked_sum_cents', tx.unbooked_sum,
        'ignored_count', tx.ignored_count,
        'ignored_sum_cents', tx.ignored_sum,
        'booked_count', tx.booked_count,
        'expected_cents', led.balance_cents + tx.unbooked_sum + tx.ignored_sum,
        -- Delen meerdere bankrekeningen dezelfde grootboekrekening, dan is die stand
        -- de SOM van al die rekeningen en is een verschil per rekening betekenisloos.
        -- Liever geen getal dan een fout getal: null, en de UI legt uit waarom.
        'difference_cents', case
          when st.closing_balance_cents is null or shr.shared then null
          else st.closing_balance_cents - (led.balance_cents + tx.unbooked_sum + tx.ignored_sum)
        end,
        'duplicate_suspects', dup.n,
        'statement_issues', iss.items
      ) as row_json
    from public.bank_accounts ba
    join public.ledger_accounts la on la.id = ba.ledger_account_id
    cross join lateral (
      select count(*) > 1 as shared
      from public.bank_accounts b2
      where b2.organization_id = p_organization_id
        and b2.ledger_account_id = ba.ledger_account_id
    ) shr
    -- Laatste afschrift mét eindsaldo; dat is de peildatum van de aansluiting.
    left join lateral (
      select s2.id, s2.period_end, s2.closing_balance_cents
      from public.bank_statements s2
      where s2.bank_account_id = ba.id and s2.closing_balance_cents is not null
      order by s2.period_end desc nulls last, s2.imported_at desc
      limit 1
    ) st on true
    cross join lateral (
      select
        coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as balance_cents,
        bool_or(je.source_type = 'opening_balance') as has_opening
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      where jl.organization_id = p_organization_id
        and jl.account_id = ba.ledger_account_id
        -- Tegenboekingsparen tellen niet mee. Sinds Blok A blijft het origineel
        -- 'posted' en krijgt de spiegelpost de datum van vandáág — die valt dus
        -- buiten de peildatum terwijl het origineel erbinnen valt. Zonder deze
        -- uitsluiting telt elke teruggedraaide bankboeking dubbel: één keer in het
        -- grootboek en nog eens in "nog te boeken". Een paar is netto nul, dus
        -- beide zijden weglaten is datumonafhankelijk correct.
        and je.reversed_by_entry_id is null
        and je.reverses_entry_id is null
        and (st.period_end is null or je.date <= st.period_end)
    ) led
    cross join lateral (
      select
        count(*) filter (where t.status = 'booked') as booked_count,
        count(*) filter (where t.status in ('unmatched','suggested')) as unbooked_count,
        coalesce(sum(t.amount_cents) filter (where t.status in ('unmatched','suggested')), 0) as unbooked_sum,
        count(*) filter (where t.status = 'ignored') as ignored_count,
        coalesce(sum(t.amount_cents) filter (where t.status = 'ignored'), 0) as ignored_sum
      from public.bank_transactions t
      where t.bank_account_id = ba.id
        and (st.period_end is null or t.booking_date <= st.period_end)
    ) tx
    -- Transacties die op inhoud identiek zijn (datum, bedrag, tegenrekening,
    -- omschrijving). Meestal een dubbele import; soms echt twee gelijke
    -- betalingen. Daarom melden, niet automatisch opruimen.
    cross join lateral (
      select coalesce(sum(d.c - 1), 0)::int as n
      from (
        select count(*) as c
        from public.bank_transactions t2
        where t2.bank_account_id = ba.id
        group by public.bank_canonical_key(t2.booking_date, t2.amount_cents, t2.counterparty_iban, t2.description)
        having count(*) > 1
      ) d
    ) dup
    -- Afschriften die intern niet kloppen: beginsaldo + alle mutaties in de
    -- afschriftperiode ≠ eindsaldo. Op datumbereik (niet op statement_id), zodat
    -- overlappende imports geen vals alarm geven — zie de toelichting bij de
    -- afschriftcontrole in import_bank_transactions.
    cross join lateral (
      select coalesce(jsonb_agg(q.item order by q.period_start desc nulls last), '[]'::jsonb) as items
      from (
        select s3.period_start, jsonb_build_object(
          'statement_id', s3.id,
          'file_name', s3.file_name,
          'period_start', s3.period_start,
          'period_end', s3.period_end,
          'opening_balance_cents', s3.opening_balance_cents,
          'closing_balance_cents', s3.closing_balance_cents,
          'transactions_sum_cents', sums.sum_cents,
          'difference_cents', s3.closing_balance_cents - (s3.opening_balance_cents + sums.sum_cents)
        ) as item
        from public.bank_statements s3
        cross join lateral (
          select coalesce(sum(t3.amount_cents), 0) as sum_cents
          from public.bank_transactions t3
          where t3.bank_account_id = ba.id
            and t3.booking_date between s3.period_start and s3.period_end
        ) sums
        where s3.bank_account_id = ba.id
          and s3.opening_balance_cents is not null
          and s3.closing_balance_cents is not null
          and s3.period_start is not null
          and s3.period_end is not null
          and s3.closing_balance_cents <> s3.opening_balance_cents + sums.sum_cents
        order by s3.period_start desc nulls last
        limit 5
      ) q
    ) iss
    where ba.organization_id = p_organization_id
  ) s;

  return v_out;
end;
$$;

revoke execute on function public.report_bank_reconciliation(uuid) from public, anon;
grant execute on function public.report_bank_reconciliation(uuid) to authenticated, service_role;
revoke execute on function public.bank_canonical_key(date, bigint, text, text) from public, anon;
grant execute on function public.bank_canonical_key(date, bigint, text, text) to authenticated, service_role;

-- De saldocontrole telt per bankrekening over een datumbereik; dat loopt via de
-- bestaande idx_bank_transactions_account(bank_account_id, booking_date desc).
-- statement_id had nog geen index terwijl de FK (on delete set null) en het
-- afschrift-overzicht erop filteren.
create index if not exists idx_bank_transactions_statement
  on public.bank_transactions(statement_id);

commit;
