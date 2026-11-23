-- ════════════════════════════════════════════════════════════════════════════
-- ResoFly — Bank: een verkeerd ingelezen regel of afschrift herstellen
-- ════════════════════════════════════════════════════════════════════════════
--
-- Controle bank van 22 november 2026, bevinding 2. Een afschrift met twee
-- rekeningen erin (betaal- en spaarrekening) kwam in zijn geheel op de
-- zakelijke rekening. De spaarregel van € 5.000 kreeg je er niet meer af:
-- negeren telt mee in de aansluiting, "Dubbele verwijderen" weigert (er is geen
-- tweeling) en wissen via REST kan niet. Het verschil bleef voorgoed staan, en
-- de hint in het scherm wees naar een knop die niet werkte.
--
-- Wat mag weg, en wat niet (bewaarplicht):
--
--   * Een boekstuk en zijn tegenboeking blijven altijd staan. Een mutatie die
--     ooit geboekt is, blijft daarom ook staan: de boekstukken verwijzen ernaar.
--   * Een bankmutatie zelf is een afschrift van het bestand van de bank. Hoort
--     hij niet bij deze rekening, dan zet je hem op "niet van deze rekening":
--     hij blijft zichtbaar (bij Genegeerd), telt niet meer mee in de aansluiting
--     en je kunt het terugzetten. Er verdwijnt dus niets, ook niet als hij al
--     eens geboekt en teruggedraaid is.
--   * Een heel afschrift dat op de verkeerde rekening is ingelezen, draai je
--     terug. De regels die nooit geboekt zijn gaan weg (het bestand van de bank
--     is de bron; opnieuw inlezen zet ze terug), regels die ooit geboekt waren
--     blijven staan als "niet van deze rekening". Staat er nog een boeking op,
--     dan weigert de database: eerst terugdraaien. Het logboek legt vast wie
--     welk afschrift terugdraaide.
--   * Wat via de bankkoppeling binnenkomt, is per definitie van deze rekening.
--     Daar kan dit niet: zo'n mutatie boek of negeer je.
--
-- Bestaande gegevens: er komen drie lege kolommen bij op bank_transactions.
-- Geen enkele bestaande rij verandert, en de aansluiting geeft voor bestaande
-- rekeningen hetzelfde getal als voorheen (er is nog niets uitgesloten).
--
-- Veilig om opnieuw te draaien.

-- ── 1. Kolommen ─────────────────────────────────────────────────────────────

alter table public.bank_transactions
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by uuid references auth.users(id) on delete set null,
  add column if not exists excluded_reason text;

comment on column public.bank_transactions.excluded_at is
  'Gezet als de mutatie niet bij deze bankrekening hoort (verkeerd bestand, een regel van een andere rekening). De rij blijft staan met status ignored, maar telt niet mee in de aansluiting (20261123130000).';

-- "Niet van deze rekening" bestaat alleen bij een genegeerde bankregel. Een
-- handmatige mutatie verwijder je, en een open of geboekte mutatie telt mee.
alter table public.bank_transactions drop constraint if exists bank_transactions_excluded_consistent;
alter table public.bank_transactions add constraint bank_transactions_excluded_consistent
  check (excluded_at is null or (status = 'ignored' and not is_manual));

-- "Weer openen" (set_bank_transaction_status) en elke andere weg uit Genegeerd
-- haalt de uitsluiting eraf. Hier, en niet in die functies: elke weg telt, en
-- een open mutatie die stil niet meetelt zou de aansluiting juist scheef maken.
create or replace function public.bank_transactions_clear_excluded()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.status <> 'ignored' and new.excluded_at is not null then
    new.excluded_at := null;
    new.excluded_by := null;
    new.excluded_reason := null;
  end if;
  return new;
end;
$function$;

revoke all on function public.bank_transactions_clear_excluded() from public, anon, authenticated;

drop trigger if exists bank_transactions_clear_excluded on public.bank_transactions;
create trigger bank_transactions_clear_excluded
  before update of status on public.bank_transactions
  for each row execute function public.bank_transactions_clear_excluded();

-- ── 2. Eén regel: niet van deze rekening (en terug) ─────────────────────────

create or replace function public.set_bank_transaction_excluded(
  p_organization_id uuid, p_transaction_id uuid, p_excluded boolean, p_reason text default null)
returns public.bank_transactions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_txn public.bank_transactions;
  v_format text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;

  if not coalesce(p_excluded, false) then
    -- Terugzetten: hij telt weer mee, als genegeerde mutatie. Boeken kan na
    -- "Weer openen".
    update public.bank_transactions
    set excluded_at = null, excluded_by = null, excluded_reason = null, updated_at = now()
    where id = v_txn.id
    returning * into v_txn;
    return v_txn;
  end if;

  if v_txn.is_manual then
    raise exception 'Een handmatige mutatie heb je zelf ingevoerd. Hoort hij hier niet, verwijder hem dan met "Verwijderen".' using errcode = '23514';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze mutatie is geboekt. Draai de boeking eerst terug; daarna kun je aangeven dat hij niet bij deze rekening hoort.' using errcode = '23514';
  end if;
  if v_txn.status = 'merged' or exists (select 1 from public.bank_transactions r where r.merged_into_id = v_txn.id) then
    raise exception 'Deze mutatie is samengevoegd met een handmatige mutatie. Maak dat eerst los.' using errcode = '23514';
  end if;
  select s.format into v_format from public.bank_statements s where s.id = v_txn.statement_id;
  if v_format in ('enablebanking', 'gocardless') then
    raise exception 'Deze mutatie komt van de bankkoppeling en staat dus echt op deze rekening. Boek of negeer hem. Staat hij er twee keer, kies dan "Dubbele verwijderen".' using errcode = '23514';
  end if;

  update public.bank_transactions set
    status = 'ignored',
    excluded_at = now(),
    excluded_by = auth.uid(),
    excluded_reason = coalesce(nullif(btrim(p_reason), ''), 'Hoort niet bij deze rekening'),
    updated_at = now()
  where id = v_txn.id
  returning * into v_txn;
  return v_txn;
end;
$function$;

revoke all on function public.set_bank_transaction_excluded(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.set_bank_transaction_excluded(uuid, uuid, boolean, text) to authenticated, service_role;

-- ── 3. Een heel afschrift terugdraaien ──────────────────────────────────────

create or replace function public.undo_bank_statement(p_organization_id uuid, p_statement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_stmt public.bank_statements;
  v_booked integer;
  v_merged integer;
  v_removed integer;
  v_kept integer;
  v_label text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_stmt from public.bank_statements
  where id = p_statement_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Afschrift niet gevonden.' using errcode = '02000';
  end if;
  if v_stmt.format in ('enablebanking', 'gocardless') then
    raise exception 'Dit zijn mutaties van de bankkoppeling; die staan echt op deze rekening en draai je niet terug.' using errcode = '23514';
  end if;

  perform 1 from public.bank_transactions t
  where t.statement_id = v_stmt.id and t.organization_id = p_organization_id for update;

  select count(*) filter (where t.status = 'booked' or t.journal_entry_id is not null),
         count(*) filter (where t.status = 'merged'
                             or exists (select 1 from public.bank_transactions r where r.merged_into_id = t.id))
    into v_booked, v_merged
  from public.bank_transactions t
  where t.statement_id = v_stmt.id and t.organization_id = p_organization_id;
  -- Alles of niets. Half terugdraaien zou het afschrift (met zijn eindsaldo)
  -- laten staan met een deel van de regels: de aansluiting klopt dan nog steeds
  -- niet, en je weet niet meer waarom.
  if v_booked > 0 or v_merged > 0 then
    raise exception '%', concat_ws(' ',
      'Dit afschrift kun je nog niet terugdraaien.',
      case when v_booked > 0 then format('%s mutatie(s) eruit zijn geboekt: draai die boekingen eerst terug (bij Geboekt, "Terugdraaien").', v_booked) end,
      case when v_merged > 0 then format('%s mutatie(s) zijn samengevoegd met een handmatige mutatie: maak die eerst los.', v_merged) end)
      using errcode = '23514';
  end if;

  v_label := coalesce(v_stmt.file_name, 'afschrift') || coalesce(' (' || to_char(v_stmt.period_start, 'DD-MM-YYYY') || ' t/m ' || to_char(v_stmt.period_end, 'DD-MM-YYYY') || ')', '');

  -- Ooit geboekt en teruggedraaid: het boekstuk en de tegenboeking verwijzen
  -- naar de mutatie. Die blijft dus staan, maar telt niet meer mee.
  update public.bank_transactions t set
    status = 'ignored',
    excluded_at = now(),
    excluded_by = auth.uid(),
    excluded_reason = 'Afschrift teruggedraaid: ' || v_label,
    updated_at = now()
  where t.statement_id = v_stmt.id and t.organization_id = p_organization_id
    and exists (select 1 from public.journal_entries je
                where je.organization_id = p_organization_id and je.source_type = 'payment' and je.source_id = t.id);
  get diagnostics v_kept = row_count;

  delete from public.bank_transactions t
  where t.statement_id = v_stmt.id and t.organization_id = p_organization_id
    and not exists (select 1 from public.journal_entries je
                    where je.organization_id = p_organization_id and je.source_type = 'payment' and je.source_id = t.id);
  get diagnostics v_removed = row_count;

  delete from public.bank_statements where id = v_stmt.id;

  -- bank_statements en bank_transactions hebben geen logboektrigger (dat zou bij
  -- elke import honderden regels geven). Dit ene moment leggen we wel vast: het
  -- is het enige waarop mutaties van de bank verdwijnen.
  insert into public.audit_logs (organization_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, 'deleted', 'bank_statement', v_stmt.id, v_label,
    jsonb_build_object(
      'bank_account_id', v_stmt.bank_account_id,
      'file_name', v_stmt.file_name,
      'file_hash', v_stmt.file_hash,
      'format', v_stmt.format,
      'period_start', v_stmt.period_start,
      'period_end', v_stmt.period_end,
      'opening_balance_cents', v_stmt.opening_balance_cents,
      'closing_balance_cents', v_stmt.closing_balance_cents,
      'removed_transactions', v_removed,
      'kept_excluded_transactions', v_kept));

  return jsonb_build_object('removed', v_removed, 'kept_excluded', v_kept, 'file_name', v_stmt.file_name);
end;
$function$;

revoke all on function public.undo_bank_statement(uuid, uuid) from public, anon;
grant execute on function public.undo_bank_statement(uuid, uuid) to authenticated, service_role;

-- ── 4. Dubbele verwijderen: de melding wijst nu de goede weg ────────────────
-- Ongewijzigd uit 20261119180000 op de laatste melding na. Die zei "verwijderen
-- kan niet", en voor een regel van een andere rekening was er toen ook geen weg.

create or replace function public.delete_duplicate_bank_transaction(p_organization_id uuid, p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_txn public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.is_manual then
    raise exception 'Een handmatige mutatie verwijder je met "Verwijderen".' using errcode = '23514';
  end if;
  if v_txn.status in ('booked', 'merged') or v_txn.journal_entry_id is not null
     or exists (select 1 from public.journal_entries je where je.source_type = 'payment' and je.source_id = v_txn.id)
     or exists (select 1 from public.bank_transactions r where r.merged_into_id = v_txn.id) then
    raise exception 'Deze mutatie is (ooit) geboekt of samengevoegd en hoort bij je grootboek. Draai de boeking terug; een geboekte mutatie verwijder je niet.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.bank_transactions d
    where d.bank_account_id = v_txn.bank_account_id
      and d.id <> v_txn.id
      and not d.is_manual
      and d.booking_date = v_txn.booking_date
      and d.amount_cents = v_txn.amount_cents
      and (public.bank_norm_iban(d.counterparty_iban) is not distinct from public.bank_norm_iban(v_txn.counterparty_iban)
           or public.bank_norm_iban(d.counterparty_iban) is null
           or public.bank_norm_iban(v_txn.counterparty_iban) is null)
  ) then
    raise exception 'Er staat geen tweede bankmutatie met dezelfde datum, hetzelfde bedrag en dezelfde tegenrekening: dit is geen dubbele. Een mutatie die echt op je afschrift staat, negeer je. Hoort hij niet bij deze rekening, kies dan "Niet van deze rekening".'
      using errcode = '23514';
  end if;
  delete from public.bank_transactions where id = v_txn.id;
end;
$function$;

revoke all on function public.delete_duplicate_bank_transaction(uuid, uuid) from public, anon;
grant execute on function public.delete_duplicate_bank_transaction(uuid, uuid) to authenticated, service_role;

-- ── 5. De aansluiting: zonder wat niet van deze rekening is ─────────────────
-- Basis: 20261119180000. GEWIJZIGD: een mutatie met excluded_at telt niet mee
-- als "genegeerd", niet bij de dubbelen en niet in de controle van een afschrift
-- met zichzelf. Hij komt apart terug (excluded_count, excluded_sum_cents), zodat
-- het scherm en de boekhouder zien wat er buiten de aansluiting is gehouden.

CREATE OR REPLACE FUNCTION public.report_bank_reconciliation(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_out jsonb;
  v_start date;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- TOEGEVOEGD (20261119180000): mutaties van vóór de start van de boekhouding zitten al
  -- in het banksaldo van de beginbalans. Ze telden hier als "nog te boeken" of
  -- "genegeerd" mee: wie zo'n mutatie (terecht) negeerde, hield een blijvend
  -- verschil terwijl het grootboek klopte. Het verschil verdween alleen door
  -- de mutatie fout te boeken.
  select cs.bookkeeping_start_date into v_start
  from public.company_settings cs where cs.organization_id = p_organization_id;

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
        'excluded_count', tx.excluded_count,
        'excluded_sum_cents', tx.excluded_sum,
        'booked_count', tx.booked_count,
        'manual_count', tx.manual_count,
        'timing_count', tim.n + shf.n,
        'timing_sum_cents', tim.sum_cents + shf.sum_cents,
        'manual_unconfirmed_count', man.n,
        'manual_unconfirmed_sum_cents', man.sum_cents,
        'expected_cents', led.balance_cents + tx.unbooked_sum + tx.ignored_sum + tim.sum_cents + shf.sum_cents,
        -- Delen meerdere bankrekeningen dezelfde grootboekrekening, dan is die stand
        -- de SOM van al die rekeningen en is een verschil per rekening betekenisloos.
        -- Liever geen getal dan een fout getal: null, en de UI legt uit waarom.
        'difference_cents', case
          when st.closing_balance_cents is null or shr.shared then null
          else st.closing_balance_cents - (led.balance_cents + tx.unbooked_sum + tx.ignored_sum + tim.sum_cents + shf.sum_cents)
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
        count(*) filter (where t.is_manual) as manual_count,
        count(*) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start)
                           and (t.status in ('unmatched','suggested')
                           or (t.status = 'merged' and m.status in ('unmatched','suggested')))) as unbooked_count,
        coalesce(sum(t.amount_cents) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start)
                           and (t.status in ('unmatched','suggested')
                           or (t.status = 'merged' and m.status in ('unmatched','suggested')))), 0) as unbooked_sum,
        count(*) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start) and t.status = 'ignored' and t.excluded_at is null) as ignored_count,
        coalesce(sum(t.amount_cents) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start) and t.status = 'ignored' and t.excluded_at is null), 0) as ignored_sum,
        -- TOEGEVOEGD (20261123130000): niet van deze rekening. Staat niet op het
        -- afschrift van deze rekening en telt dus nergens in mee.
        count(*) filter (where t.excluded_at is not null) as excluded_count,
        coalesce(sum(t.amount_cents) filter (where t.excluded_at is not null), 0) as excluded_sum
      from public.bank_transactions t
      left join public.bank_transactions m on m.id = t.merged_into_id
      where t.bank_account_id = ba.id
        and (st.period_end is null or t.booking_date <= st.period_end)
    ) tx
    -- Samengevoegde paren waarvan de handmatige boeking aan de andere kant van
    -- de peildatum valt dan de bankregel: op het afschrift maar nog niet in het
    -- grootboek (+), of andersom (−).
    cross join lateral (
      select
        count(*) as n,
        coalesce(sum(case when r.booking_date <= st.period_end then r.amount_cents else -r.amount_cents end), 0) as sum_cents
      from public.bank_transactions r
      join public.bank_transactions m on m.id = r.merged_into_id and m.status = 'booked'
      join public.journal_entries mje on mje.id = m.journal_entry_id
      where r.bank_account_id = ba.id
        and r.status = 'merged'
        and st.period_end is not null
        and (r.booking_date <= st.period_end) <> (mje.date <= st.period_end)
    ) tim
    -- TOEGEVOEGD (20261119180000): een mutatie die in een dicht tijdvak of boekjaar viel,
    -- is geboekt op de eerste open dag daarna (book_bank_transaction). Ligt de
    -- peildatum van het afschrift tussen die twee datums, dan staat de mutatie
    -- wel op het afschrift en nog niet in het grootboek (of andersom): een
    -- tijdsverschil, geen fout. Samengevoegde paren telt `tim` al.
    cross join lateral (
      select
        count(*) as n,
        coalesce(sum(case when t.booking_date <= st.period_end then t.amount_cents else -t.amount_cents end), 0) as sum_cents
      from public.bank_transactions t
      join public.journal_entries tje on tje.id = t.journal_entry_id
      where t.bank_account_id = ba.id
        and t.status = 'booked'
        and not t.is_manual
        and st.period_end is not null
        and (t.booking_date <= st.period_end) <> (tje.date <= st.period_end)
    ) shf
    -- Geboekte handmatige mutaties die de bank (nog) niet bevestigde en vóór de
    -- peildatum vallen: die staan in het grootboek en niet op het afschrift.
    cross join lateral (
      select count(*) as n, coalesce(sum(m.amount_cents), 0) as sum_cents
      from public.bank_transactions m
      join public.journal_entries mje on mje.id = m.journal_entry_id
      where m.bank_account_id = ba.id
        and m.is_manual
        and m.status = 'booked'
        and st.period_end is not null
        and mje.date <= st.period_end
        and not exists (select 1 from public.bank_transactions r where r.merged_into_id = m.id)
    ) man
    -- Transacties die op inhoud identiek zijn (datum, bedrag, tegenrekening,
    -- omschrijving). Meestal een dubbele import; soms echt twee gelijke
    -- betalingen. Daarom melden, niet automatisch opruimen.
    cross join lateral (
      select coalesce(sum(d.c - 1), 0)::int as n
      from (
        select count(*) as c
        from public.bank_transactions t2
        where t2.bank_account_id = ba.id
          and not t2.is_manual
          and t2.excluded_at is null
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
            and not t3.is_manual
            and t3.excluded_at is null
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
$function$;

revoke all on function public.report_bank_reconciliation(uuid) from public, anon;
grant execute on function public.report_bank_reconciliation(uuid) to authenticated, service_role;
