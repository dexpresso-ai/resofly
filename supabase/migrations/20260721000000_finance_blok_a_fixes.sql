-- ============================================================
-- ResoFly — Financiële module, Blok A: zes gerichte fixes
-- Date: 2026-07-21
-- Bron: REVIEW_FINANCIELE_MODULE_2026-07-21.md (§6, Blok A)
--
--  FIX 1  reverse_journal_entry maakte het saldo NEGATIEF i.p.v. nul: de
--         spiegelpost werd geboekt (posted) én het origineel op 'reversed'
--         gezet, terwijl alle rapporten/aangiften alleen status='posted'
--         tellen. Het origineel viel dus weg én de spiegel telde mee.
--         Nu blijft het origineel 'posted' (het is echt gebeurd) en
--         neutraliseert de spiegelpost het saldo; reversed_by_entry_id
--         markeert het paar. status='reversed' blijft gereserveerd voor
--         reopen_fiscal_year (dat een boekstuk bewust volledig uit de
--         rapporten haalt, zónder spiegelpost). Incl. datarepair.
--
--  FIX 2  book_bank_transaction lette af tegen élke factuur — ook concepten
--         die nooit in het grootboek stonden (→ negatieve debiteuren) en
--         zonder grens (→ dubbel afletteren mogelijk). Nu: alleen documenten
--         mét (niet-tegengeboekte) grootboekboeking, en de creditering is
--         begrensd op het nog openstaande saldo. match_bank_transactions
--         stelt alleen nog geboekte documenten voor.
--
--  FIX 3  De BTW van een vrije bankboeking volgde het TEKEN van de
--         transactie (ontvangst → altijd 1510, betaling → altijd 1500) en
--         negeerde vat_codes.kind (VERL_INK met rate 21 werd als inclusieve
--         BTW gesplitst, zonder 1520-tegenboeking). Nu: richting volgt de
--         aard van de rekening (omzet → 1510, kosten/activa → 1500) en
--         verlegd/EU-verwerving boekt 1500 + 1520 over de volle grondslag,
--         zoals book_purchase_invoice dat al deed.
--
--  FIX 4  Migratie 20260710010000 herschreef compute_vat_return en
--         finalize_vat_return zónder het year_close-filter dat
--         20260706120000 vier dagen eerder bewust had toegevoegd
--         (afsluitboekstuk lekte als negatieve omzet in rubriek 1e).
--         Het filter staat terug.
--
--  FIX 5  Factuurnummers hadden geen unique constraint (art. 35a Wet OB:
--         doorlopend en uniek) en een geboekte/verstuurde factuur was
--         gewoon verwijderbaar (journaalpost bleef achter zonder bron,
--         nummer werd hergebruikt). Nu: unique(organization_id, number)
--         + delete-blokkade zodra de factuur in het grootboek staat of
--         voorbij 'draft' is.
--
--  FIX 6  p_lines[].account_id werd nergens tegen de organisatie
--         gevalideerd (open follow-up task_7c598094). Nu centraal in
--         post_journal_entry, zodat élke boekingsweg (bankfeed, inkoop,
--         beginbalans, memoriaal) de check erft.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- FIX 1a. reverse_journal_entry: origineel blijft 'posted'
-- ------------------------------------------------------------
create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not public.can_write_org(v_src.organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if v_src.status <> 'posted' then
    raise exception 'Alleen een geboekt (posted) boekstuk kan worden tegengeboekt.' using errcode = '23514';
  end if;
  if v_src.reversed_by_entry_id is not null then
    raise exception 'Boekstuk % is al tegengeboekt.', coalesce(v_src.entry_number, v_src.id::text)
      using errcode = '23514';
  end if;
  if v_src.source_type = 'year_close' then
    raise exception 'Een jaarafsluitboekstuk boek je niet tegen; gebruik "Boekjaar heropenen".'
      using errcode = '23514';
  end if;

  -- Wissel debet/credit per regel om.
  select jsonb_agg(jsonb_build_object(
    'account_id', jl.account_id,
    'description', coalesce(jl.description, '') || ' (tegenboeking)',
    'debit_cents', jl.credit_cents,
    'credit_cents', jl.debit_cents,
    'vat_code', jl.vat_code,
    'vat_rate', jl.vat_rate,
    'vat_base_cents', case when jl.vat_base_cents is null then null else -jl.vat_base_cents end,
    'vat_amount_cents', case when jl.vat_amount_cents is null then null else -jl.vat_amount_cents end,
    'client_id', jl.client_id,
    'supplier_id', jl.supplier_id,
    'project_id', jl.project_id
  ) order by jl.line_index)
  into v_lines
  from public.journal_lines jl
  where jl.entry_id = p_entry_id;

  v_reversal := public.post_journal_entry(
    v_src.organization_id,
    coalesce(p_date, current_date),
    'Tegenboeking van ' || coalesce(v_src.entry_number, v_src.id::text),
    v_src.source_type,
    v_src.source_id,
    v_lines,
    p_created_by
  );

  update public.journal_entries set reverses_entry_id = v_src.id where id = v_reversal.id;

  -- Het origineel blijft 'posted': het is echt gebeurd en blijft meetellen;
  -- de spiegelpost neutraliseert het saldo (netto 0 i.p.v. −1×). Alleen
  -- reversed_by_entry_id markeert het paar. NB: status='reversed' betekent
  -- "volledig uit de rapporten" en is gereserveerd voor reopen_fiscal_year.
  update public.journal_entries
  set reversed_by_entry_id = v_reversal.id, updated_at = now()
  where id = v_src.id;

  return v_reversal;
end;
$$;

-- ------------------------------------------------------------
-- FIX 1b. Datarepair: door de oude bug staan bestaande tegenboekingsparen
-- netto op −1×. Zet de originelen (reversed mét spiegelpost) terug op
-- 'posted', dan telt het paar weer op tot nul. Boekstukken die
-- reopen_fiscal_year op 'reversed' zette hebben GEEN reversed_by_entry_id
-- en blijven onaangeroerd.
-- ------------------------------------------------------------
update public.journal_entries
set status = 'posted', updated_at = now()
where status = 'reversed' and reversed_by_entry_id is not null;

-- ------------------------------------------------------------
-- FIX 6. post_journal_entry: elk account_id in p_lines moet bij de
-- organisatie horen. Centrale plek → alle boekingswegen erven de check.
-- (Basis: definitie uit 20260706120000; alleen de org-check is nieuw.)
-- ------------------------------------------------------------
create or replace function public.post_journal_entry(
  p_organization_id uuid,
  p_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.journal_entries;
  v_year integer := extract(year from p_date)::int;
  v_quarter smallint := extract(quarter from p_date)::smallint;
  v_month smallint := extract(month from p_date)::smallint;
  v_seq bigint;
  v_number text;
  v_line jsonb;
  v_idx integer := 0;
  v_account uuid;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_diff bigint;
  v_count integer;
  v_tolerance bigint;
  v_alien_code text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand/kwartaal/jaar).
  -- Uitzondering: het jaarafsluit-boekstuk ('year_close') zelf, dat op de laatste dag
  -- van het boekjaar valt en dus vaak binnen een reeds gesloten Q4/december-slot.
  if coalesce(p_source_type, 'manual') <> 'year_close' and exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_start is not null and cp.period_end is not null
      and p_date between cp.period_start and cp.period_end
  ) then
    raise exception 'De aangifteperiode rond % is afgesloten; kies een boekdatum in de eerstvolgende open periode.', p_date
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_year::text));
  select count(*) + 1 into v_seq from public.journal_entries
  where organization_id = p_organization_id and year = v_year;
  v_number := 'JP-' || v_year || '-' || lpad(v_seq::text, 5, '0');

  insert into public.journal_entries(
    organization_id, created_by, entry_number, date, year, quarter, month,
    description, source_type, source_id, status
  ) values (
    p_organization_id, p_created_by, v_number, p_date, v_year, v_quarter, v_month,
    p_description, coalesce(p_source_type, 'manual'), p_source_id, 'draft'
  ) returning * into v_entry;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if (v_line ? 'account_id') and nullif(v_line->>'account_id','') is not null then
      v_account := (v_line->>'account_id')::uuid;
    else
      v_account := public.bookkeeping_account_id(p_organization_id, v_line->>'account_code');
    end if;

    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;

    insert into public.journal_lines(
      organization_id, entry_id, account_id, line_index, description,
      debit_cents, credit_cents, vat_code, vat_rate, vat_base_cents, vat_amount_cents,
      client_id, supplier_id, project_id
    ) values (
      p_organization_id, v_entry.id, v_account, v_idx, nullif(v_line->>'description',''),
      v_debit, v_credit,
      nullif(v_line->>'vat_code',''),
      nullif(v_line->>'vat_rate','')::numeric,
      nullif(v_line->>'vat_base_cents','')::bigint,
      nullif(v_line->>'vat_amount_cents','')::bigint,
      nullif(v_line->>'client_id','')::uuid,
      nullif(v_line->>'supplier_id','')::uuid,
      nullif(v_line->>'project_id','')::uuid
    );
    v_idx := v_idx + 1;
  end loop;

  -- Org-integriteit (FIX 6): elke regel moet op een grootboekrekening van
  -- déze organisatie boeken. Een account_id van een andere org zou de balans
  -- vervuilen met andermans rekening (cross-tenant lek in de rapportages).
  select la.code into v_alien_code
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.entry_id = v_entry.id
    and la.organization_id <> p_organization_id
  limit 1;
  if v_alien_code is not null then
    raise exception 'Grootboekrekening % hoort niet bij deze organisatie.', v_alien_code
      using errcode = '42501';
  end if;

  v_diff := v_total_debit - v_total_credit;
  v_count := v_idx;
  v_tolerance := greatest(2 * v_count, 2);

  if v_diff <> 0 then
    if abs(v_diff) <= v_tolerance then
      v_account := public.bookkeeping_account_id(p_organization_id, '4900');
      insert into public.journal_lines(
        organization_id, entry_id, account_id, line_index, description, debit_cents, credit_cents
      ) values (
        p_organization_id, v_entry.id, v_account, v_idx, 'Afrondingsverschil',
        case when v_diff < 0 then -v_diff else 0 end,
        case when v_diff > 0 then v_diff else 0 end
      );
    else
      raise exception 'Journaalpost niet in balans: debet % ≠ credit % (verschil % cent).',
        v_total_debit, v_total_credit, v_diff using errcode = '23514';
    end if;
  end if;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = p_created_by
  where id = v_entry.id
  returning * into v_entry;

  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- FIX 4a. compute_vat_return: year_close-filter terug
-- (Basis: 20260710010000; alleen het filter is nieuw.)
-- ------------------------------------------------------------
create or replace function public.compute_vat_return(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_omzet_hoog_base bigint; v_omzet_hoog_btw bigint;
  v_omzet_laag_base bigint; v_omzet_laag_btw bigint;
  v_omzet_nul_base bigint;
  v_verlegd_btw bigint;
  v_verschuldigd bigint;
  v_voorbelasting bigint;
  v_saldo bigint;
  v_saldo_afgerond bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) = 0 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_reverse' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype in ('vat_output', 'vat_reverse') then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_input' then jl.debit_cents - jl.credit_cents else 0 end), 0)
  into v_omzet_hoog_base, v_omzet_hoog_btw, v_omzet_laag_base, v_omzet_laag_btw, v_omzet_nul_base,
       v_verlegd_btw, v_verschuldigd, v_voorbelasting
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    -- FIX 4: het jaarafsluitboekstuk debiteert omzetrekeningen zonder
    -- vat_rate; zonder dit filter lekt dat als negatieve omzet in rubriek 1e.
    and je.source_type <> 'year_close'
    and je.date between p_from and p_to;

  v_saldo := v_verschuldigd - v_voorbelasting;
  -- Aangifte/afdracht gaat in hele euro's; rekenkundig afronden (weg van nul bij .50).
  v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;

  return jsonb_build_object(
    'omzet_hoog_base', v_omzet_hoog_base, 'omzet_hoog_btw', v_omzet_hoog_btw,
    'omzet_laag_base', v_omzet_laag_base, 'omzet_laag_btw', v_omzet_laag_btw,
    'omzet_nul_base', v_omzet_nul_base,
    'verlegd_btw', v_verlegd_btw,
    'verschuldigd_total', v_verschuldigd,
    'voorbelasting', v_voorbelasting,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_saldo - v_saldo_afgerond
  );
end;
$$;

-- ------------------------------------------------------------
-- FIX 4b. finalize_vat_return: year_close-filter terug
-- (Basis: 20260710010000; alleen het filter is nieuw.)
-- ------------------------------------------------------------
create or replace function public.finalize_vat_return(
  p_organization_id uuid,
  p_period_type text,
  p_year integer,
  p_period_index integer,
  p_from date,
  p_to date,
  p_created_by uuid default auth.uid()
)
returns public.vat_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.vat_returns;
  v_omzet_hoog_base bigint; v_omzet_hoog_btw bigint;
  v_omzet_laag_base bigint; v_omzet_laag_btw bigint;
  v_omzet_nul_base bigint;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_rubrieken jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.closed_periods
    where organization_id = p_organization_id and period_start = p_from and period_end = p_to
  ) then
    raise exception 'Deze aangifteperiode is al afgesloten.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Beweging op de BTW-rekeningen in de periode (vóór de doorboeking), in dezelfde
  -- query als de rubrieken-uitsplitsing (1a/1b/1e/2a) berekend: één druk op de
  -- database, één consistente snapshot.
  select
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) = 0 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_output' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_reverse' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_input' then jl.debit_cents - jl.credit_cents else 0 end), 0)
  into v_omzet_hoog_base, v_omzet_hoog_btw, v_omzet_laag_base, v_omzet_laag_btw, v_omzet_nul_base,
       v_clear_output, v_clear_reverse, v_clear_input
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id and je.status = 'posted'
    -- FIX 4: zie compute_vat_return — year_close mag de rubrieken niet raken.
    and je.source_type <> 'year_close'
    and je.date between p_from and p_to;

  v_saldo := (v_clear_output + v_clear_reverse) - v_clear_input;
  -- Aangifte/afdracht gaat in hele euro's; rekenkundig afronden (weg van nul bij .50).
  v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;
  v_afronding := v_saldo - v_saldo_afgerond;
  v_rubrieken := jsonb_build_object(
    'omzet_hoog_base', v_omzet_hoog_base, 'omzet_hoog_btw', v_omzet_hoog_btw,
    'omzet_laag_base', v_omzet_laag_base, 'omzet_laag_btw', v_omzet_laag_btw,
    'omzet_nul_base', v_omzet_nul_base,
    'verlegd_btw', v_clear_reverse,
    'verschuldigd_total', v_clear_output + v_clear_reverse,
    'voorbelasting', v_clear_input,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_afronding
  );

  -- Doorboeking: BTW-rekeningen afsluiten naar 1530 Te betalen omzetbelasting.
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1510'), 'description', 'Afsluiten af te dragen BTW', 'debit_cents', v_clear_output, 'credit_cents', 0));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1520'), 'description', 'Afsluiten verlegde/ICP BTW', 'debit_cents', v_clear_reverse, 'credit_cents', 0));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1500'), 'description', 'Afsluiten voorbelasting', 'debit_cents', 0, 'credit_cents', v_clear_input));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting (afgerond op hele euro''s)',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end
    ));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Afrondingsverschil BTW-aangifte (cent → hele euro)',
      'debit_cents', case when v_afronding < 0 then -v_afronding else 0 end,
      'credit_cents', case when v_afronding > 0 then v_afronding else 0 end
    ));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, p_to,
      'BTW-aangifte doorboeken ' || p_period_type || ' ' || p_period_index || '-' || p_year,
      'vat_return', null, v_lines, p_created_by
    );
  end if;

  insert into public.vat_returns(
    organization_id, created_by, period_type, year, period_index, period_start, period_end,
    status, rubrieken, journal_entry_id, finalized_at
  ) values (
    p_organization_id, p_created_by, p_period_type, p_year, p_period_index, p_from, p_to,
    'finalized', v_rubrieken, v_entry.id, now()
  )
  on conflict (organization_id, period_type, year, period_index) do update
    set status = 'finalized', rubrieken = excluded.rubrieken, journal_entry_id = excluded.journal_entry_id,
        period_start = excluded.period_start, period_end = excluded.period_end, finalized_at = now(), updated_at = now()
  returning * into v_ret;

  -- Periode vergrendelen (datumbereik).
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, p_period_type, p_year,
    case when p_period_type = 'quarter' then p_period_index::smallint else null end,
    case when p_period_type = 'month' then p_period_index::smallint else null end,
    p_from, p_to, p_created_by
  )
  on conflict (organization_id, period_start, period_end) do nothing;

  return v_ret;
end;
$$;

-- ------------------------------------------------------------
-- FIX 2 + 3. book_bank_transaction
-- (Basis: 20260710010000. Nieuw: aflettergrenzen + kind-bewuste BTW.)
-- ------------------------------------------------------------
create or replace function public.book_bank_transaction(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_lines jsonb default null,
  p_matched_invoice_id uuid default null,
  p_matched_purchase_invoice_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_abs bigint;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_pi public.purchase_invoices;
  v_desc text;
  r record;
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
  -- FIX 2: openstaand-saldo-bewaking
  v_entry_reversed boolean;
  v_doc_total bigint;
  v_already bigint;
  v_open bigint;
  -- FIX 3: BTW-accumulatoren met richting (positief = natuurlijke kant)
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze transactie is al geboekt.' using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_abs := abs(v_txn.amount_cents);
  if v_abs = 0 then
    raise exception 'Een transactie van € 0,00 kan niet worden geboekt.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_vat_payable_id := public.bookkeeping_account_id(p_organization_id, '1530');

  v_desc := 'Bank ' || coalesce(v_ba.name, '') || ': ' ||
            coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'transactie');

  -- Bankregel (debet bij ontvangst, credit bij betaling).
  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ba.ledger_account_id,
    'description', v_desc,
    'debit_cents', case when v_txn.amount_cents > 0 then v_abs else 0 end,
    'credit_cents', case when v_txn.amount_cents < 0 then v_abs else 0 end
  ));

  if p_matched_invoice_id is not null then
    if v_txn.amount_cents <= 0 then
      raise exception 'Een verkoopfactuur afletteren kan alleen bij een ontvangst.' using errcode = '23514';
    end if;
    -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
    -- anders allebei de openstaand-check passeren.
    select * into v_inv from public.invoices
    where id = p_matched_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Verkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- FIX 2: afletteren kan alleen tegen een factuur die in het grootboek staat.
    -- Zonder debitering van 1300 zou de creditering hier Debiteuren negatief maken.
    if v_inv.journal_entry_id is null then
      raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en letter daarna af.', coalesce(v_inv.number, '')
        using errcode = '23514';
    end if;
    select je.reversed_by_entry_id is not null into v_entry_reversed
    from public.journal_entries je where je.id = v_inv.journal_entry_id;
    if coalesce(v_entry_reversed, false) then
      raise exception 'De grootboekboeking van factuur % is tegengeboekt; er valt niets meer af te letteren.', coalesce(v_inv.number, '')
        using errcode = '23514';
    end if;

    -- FIX 2: begrens op het openstaande saldo (geboekte vordering − eerdere
    -- bankboekingen op deze factuur). Deelbetalingen blijven mogelijk.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_doc_total
    from public.journal_lines jl
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = v_inv.journal_entry_id and la.subtype = 'accounts_receivable';

    -- Eerdere betalingen tellen we uit de JOURNAALREGELS (credit op 1300 van de
    -- gekoppelde boekingen), niet uit het matchveld: een vrij geboekte transactie
    -- met een achtergebleven factuur-suggestie heeft géén debiteurenregel en telt
    -- dus terecht niet mee. Direct tegengeboekte betaal-boekingen (reversed_by)
    -- tellen evenmin.
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_already
    from public.bank_transactions bt
    join public.journal_entries je2 on je2.id = bt.journal_entry_id and je2.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je2.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    where bt.organization_id = p_organization_id
      and bt.matched_invoice_id = v_inv.id
      and bt.status = 'booked'
      and bt.id <> v_txn.id;

    v_open := v_doc_total - v_already;
    if v_open <= 0 then
      raise exception 'Factuur % is al volledig afgeletterd.', coalesce(v_inv.number, '') using errcode = '23514';
    end if;
    if v_abs > v_open then
      raise exception 'Ontvangst (€ %) is hoger dan het openstaande saldo van factuur % (€ %). Koppelen aan deze factuur kan dan niet; boek de transactie via een grootboekrekening (vrije boeking).',
        to_char(v_abs / 100.0, 'FM999999990.00'), coalesce(v_inv.number, ''), to_char(v_open / 100.0, 'FM999999990.00')
        using errcode = '23514';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren — factuur ' || coalesce(v_inv.number, ''),
      'debit_cents', 0, 'credit_cents', v_abs,
      'client_id', v_inv.client_id
    ));

  elsif p_matched_purchase_invoice_id is not null then
    if v_txn.amount_cents >= 0 then
      raise exception 'Een inkoopfactuur afletteren kan alleen bij een betaling.' using errcode = '23514';
    end if;
    select * into v_pi from public.purchase_invoices
    where id = p_matched_purchase_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- FIX 2: zelfde bewaking als bij verkoopfacturen, spiegelbeeldig op 1600.
    if v_pi.journal_entry_id is null then
      raise exception 'Inkoopfactuur % staat nog niet in het grootboek. Boek de inkoopfactuur eerst en letter daarna af.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;
    select je.reversed_by_entry_id is not null into v_entry_reversed
    from public.journal_entries je where je.id = v_pi.journal_entry_id;
    if coalesce(v_entry_reversed, false) then
      raise exception 'De grootboekboeking van inkoopfactuur % is tegengeboekt; er valt niets meer af te letteren.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;

    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_doc_total
    from public.journal_lines jl
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = v_pi.journal_entry_id and la.subtype = 'accounts_payable';

    -- Spiegelbeeldig aan de verkoopkant: eerdere betalingen uit de journaalregels
    -- (debet op 1600), niet uit het matchveld.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_already
    from public.bank_transactions bt
    join public.journal_entries je2 on je2.id = bt.journal_entry_id and je2.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je2.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = v_pi.id
      and bt.status = 'booked'
      and bt.id <> v_txn.id;

    v_open := v_doc_total - v_already;
    if v_open <= 0 then
      raise exception 'Inkoopfactuur % is al volledig afgeletterd.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;
    if v_abs > v_open then
      raise exception 'Betaling (€ %) is hoger dan het openstaande saldo van inkoopfactuur % (€ %). Koppelen aan deze inkoopfactuur kan dan niet; boek de transactie via een grootboekrekening (vrije boeking).',
        to_char(v_abs / 100.0, 'FM999999990.00'),
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
        to_char(v_open / 100.0, 'FM999999990.00')
        using errcode = '23514';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
      'description', 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
      'debit_cents', v_abs, 'credit_cents', 0,
      'supplier_id', v_pi.supplier_id
    ));

  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    -- Vrije boeking: per regel bruto bedrag + BTW-code; net/BTW worden gesplitst.
    -- FIX 3: de BTW-verwerking kijkt nu naar vat_codes.kind én naar de AARD van
    -- de tegenrekening, niet naar het teken van de banktransactie:
    --   · omzetrekening       → 1510 Af te dragen BTW (kant volgt de regel)
    --   · kosten/activa       → 1500 Voorbelasting   (kant volgt de regel)
    --   · verlegd/EU-verwerving (kind) → grondslag = volle bankbedrag,
    --     BTW als 1500 + 1520 tegen elkaar in, zoals book_purchase_invoice.
    for r in
      select
        acc.account_id,
        la.type as account_type,
        coalesce((l->>'amount_cents')::bigint, 0) as gross_cents,
        nullif(l->>'vat_code','') as vat_code,
        nullif(l->>'description','') as description,
        coalesce(vc.rate, nullif(l->>'vat_rate','')::numeric, 0) as rate,
        coalesce(vc.kind, 'standard') as kind
      from jsonb_array_elements(p_lines) l
      cross join lateral (
        select coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, l->>'account_code')) as account_id
      ) acc
      left join public.ledger_accounts la
        on la.id = acc.account_id and la.organization_id = p_organization_id
      left join public.vat_codes vc
        on vc.organization_id = p_organization_id and vc.code = (l->>'vat_code')
    loop
      if r.gross_cents = 0 then continue; end if;
      -- Onthoud hoeveel er op 1530 Te betalen omzetbelasting wordt geboekt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if r.account_id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + r.gross_cents;
      end if;
      declare
        v_is_credit boolean := v_txn.amount_cents > 0; -- regelkant volgt de bank
        v_net bigint;
        v_vat bigint;
      begin
        if r.kind in ('reverse_charge_purchase', 'eu_acquisition') then
          -- Verlegd/EU-verwerving: de betaling is exclusief BTW — het volle
          -- bankbedrag is de grondslag. BTW zelf aangeven én aftrekken.
          v_net := r.gross_cents;
          v_vat := round(r.gross_cents * r.rate / 100.0);
          if v_is_credit then
            -- Terugontvangst van een verlegde leverancier: beide kanten terugdraaien.
            v_vat_1500 := v_vat_1500 - v_vat;
            v_vat_1520 := v_vat_1520 - v_vat;
          else
            v_vat_1500 := v_vat_1500 + v_vat;
            v_vat_1520 := v_vat_1520 + v_vat;
          end if;
        else
          -- Inclusief-BTW-splitsing (bruto → net + BTW), centneutraal.
          v_net := round(r.gross_cents / (1 + r.rate / 100.0));
          v_vat := r.gross_cents - v_net;
          if r.account_type = 'revenue' then
            -- Omzet: BTW hoort op 1510 — ook bij een terugbetaling aan een
            -- klant (dan als debet, zodat de af te dragen BTW dáált i.p.v.
            -- dat er voorbelasting bij wordt verzonnen).
            v_vat_1510 := v_vat_1510 + case when v_is_credit then v_vat else -v_vat end;
          elsif r.account_type in ('expense', 'asset') then
            -- Kosten/activa: BTW hoort op 1500 — ook bij een terugstorting
            -- van een leverancier (dan als credit: voorbelasting terugnemen).
            v_vat_1500 := v_vat_1500 + case when v_is_credit then -v_vat else v_vat end;
          else
            -- Balansrekening/onbekend: gedrag van vóór deze fix (geldrichting).
            if v_is_credit then
              v_vat_1510 := v_vat_1510 + v_vat;
            else
              v_vat_1500 := v_vat_1500 + v_vat;
            end if;
          end if;
        end if;

        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', r.account_id,
          'description', coalesce(r.description, case when v_is_credit then 'Ontvangst' else 'Betaling' end),
          'debit_cents', case when v_is_credit then 0 else v_net end,
          'credit_cents', case when v_is_credit then v_net else 0 end,
          'vat_code', r.vat_code, 'vat_rate', r.rate,
          -- Rubriekconsistentie: op omzetregels telt compute_vat_return
          -- vat_amount_cents op naast credit−debit; een debet-omzetregel
          -- (terugbetaling) moet dus een negatieve grondslag/BTW dragen.
          'vat_base_cents', case when r.account_type = 'revenue' and not v_is_credit then -v_net else v_net end,
          'vat_amount_cents', case when r.account_type = 'revenue' and not v_is_credit then -v_vat else v_vat end));
      end;
    end loop;

    if v_vat_1510 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
        'description', 'Af te dragen BTW',
        'debit_cents', case when v_vat_1510 < 0 then -v_vat_1510 else 0 end,
        'credit_cents', case when v_vat_1510 > 0 then v_vat_1510 else 0 end));
    end if;
    if v_vat_1500 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
        'description', 'Voorbelasting',
        'debit_cents', case when v_vat_1500 > 0 then v_vat_1500 else 0 end,
        'credit_cents', case when v_vat_1500 < 0 then -v_vat_1500 else 0 end));
    end if;
    if v_vat_1520 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
        'description', 'Verschuldigde BTW verlegd/ICP',
        'debit_cents', case when v_vat_1520 < 0 then -v_vat_1520 else 0 end,
        'credit_cents', case when v_vat_1520 > 0 then v_vat_1520 else 0 end));
    end if;

  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_txn.booking_date, v_desc, 'payment', v_txn.id, v_lines, p_created_by
  );

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed. Voorheen
  -- (coalesce) bleef een achtergebleven matcher-suggestie staan wanneer er via
  -- vrije regels werd geboekt — waardoor die rij ten onrechte als aflettering op
  -- die factuur telde. Nu: vrije boeking → beide matchvelden leeg.
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = p_matched_invoice_id,
    matched_purchase_invoice_id = p_matched_purchase_invoice_id,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- We matchen ALTIJD op het AFGERONDE saldo (hele euro's); voor aangiftes van vóór
  -- 20260710010000 (zonder saldo_afgerond in de snapshot) ronden we hun exacte saldo
  -- hier op dezelfde manier af. Alleen bij een ondubbelzinnige match markeren.
  if v_vat_payable_booked > 0 then
    v_target_saldo := case when v_txn.amount_cents < 0 then v_vat_payable_booked else -v_vat_payable_booked end;
    select count(*) into v_match_count
    from public.vat_returns
    where organization_id = p_organization_id
      and status in ('finalized', 'filed')
      and coalesce(
        (rubrieken->>'saldo_afgerond')::bigint,
        round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
      ) = v_target_saldo;
    if v_match_count = 1 then
      select id into v_match_id
      from public.vat_returns
      where organization_id = p_organization_id
        and status in ('finalized', 'filed')
        and coalesce(
          (rubrieken->>'saldo_afgerond')::bigint,
          round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
        ) = v_target_saldo
      limit 1;
      update public.vat_returns
      set status = 'paid', paid_bank_transaction_id = v_txn.id, updated_at = now()
      where id = v_match_id;
    end if;
  end if;

  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- FIX 2 (vervolg). match_bank_transactions: alleen documenten voorstellen
-- die daadwerkelijk in het grootboek staan — een voorstel dat bij boeken
-- gegarandeerd faalt, is geen voorstel.
-- (Basis: 20260623000001; nieuw zijn de twee journal_entry_id-filters.)
-- ------------------------------------------------------------
create or replace function public.match_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_inv_id uuid;
  v_pi_id uuid;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_haystack text;
  v_iban text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      and status = 'unmatched'
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
    order by booking_date
  loop
    v_inv_id := null; v_pi_id := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    if v_txn.amount_cents > 0 then
      -- Ontvangst: zoek verkoopfactuur op factuurnummer in omschrijving/kenmerk.
      -- FIX 2: alleen facturen die in het grootboek staan (afletterbaar).
      select i.id into v_inv_id
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
      order by (case when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 0 else 1 end), i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: zoek inkoopfactuur op intern/leveranciers-nummer.
      -- FIX 2: alleen geboekte inkoopfacturen (afletterbaar).
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        and (
          (pi.internal_number is not null and position(lower(replace(pi.internal_number,' ','')) in v_haystack) > 0)
          or (pi.supplier_invoice_number is not null and position(lower(replace(pi.supplier_invoice_number,' ','')) in v_haystack) > 0)
        )
      order by (case when pi.total_cents = abs(v_txn.amount_cents) then 0 else 1 end), pi.date desc
      limit 1;
    end if;

    if v_inv_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_invoice_id = v_inv_id, match_confidence = 'invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;
    if v_pi_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_purchase_invoice_id = v_pi_id, match_confidence = 'purchase_invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Regels op prioriteit; eerste match wint.
    select * into v_rule
    from public.bank_rules r
    where r.organization_id = p_organization_id
      and r.is_active
      and (r.match_direction = 'both'
           or (r.match_direction = 'in' and v_txn.amount_cents > 0)
           or (r.match_direction = 'out' and v_txn.amount_cents < 0))
      and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = v_iban)
      and (r.match_counterparty_name_contains is null or coalesce(v_txn.counterparty_name,'') ilike '%' || r.match_counterparty_name_contains || '%')
      and (r.match_description_contains is null or coalesce(v_txn.description,'') ilike '%' || r.match_description_contains || '%')
      and (r.match_amount_cents is null or r.match_amount_cents = abs(v_txn.amount_cents))
    order by r.priority, r.created_at
    limit 1;

    if v_rule.id is not null then
      if v_rule.auto_book and v_rule.target_account_id is not null then
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
          v_auto := v_auto + 1;
        exception when others then
          -- Automatisch boeken mislukt (bv. afgesloten periode): zet als voorstel klaar
          -- i.p.v. de hele import/match terug te draaien.
          update public.bank_transactions
          set status = 'suggested',
              suggested_account_id = v_rule.target_account_id,
              suggested_vat_code = v_rule.target_vat_code,
              matched_rule_id = v_rule.id,
              match_confidence = 'rule',
              updated_at = now()
          where id = v_txn.id;
          v_suggested := v_suggested + 1;
        end;
      else
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_rule.target_account_id,
            suggested_vat_code = v_rule.target_vat_code,
            matched_rule_id = v_rule.id,
            match_confidence = 'rule',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
      continue;
    end if;

    -- Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    -- omzetbelasting voor. NL86INGB0002445588 is de inningsrekening; teruggaven komen
    -- binnen onder tegenpartijnaam "Belastingdienst".
    if v_iban = 'NL86INGB0002445588'
       or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%' then
      update public.bank_transactions
      set status = 'suggested',
          suggested_account_id = public.bookkeeping_account_id(p_organization_id, '1530'),
          suggested_vat_code = null,
          match_confidence = 'tax_authority',
          updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Geen regel: bij een betaling de leverancier op IBAN voorstellen.
    if v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_sup.default_expense_account_id,
            suggested_vat_code = v_sup.default_vat_code,
            match_confidence = 'supplier_iban',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('suggested', v_suggested, 'auto_booked', v_auto);
end;
$$;

-- ------------------------------------------------------------
-- FIX 5a. Factuurnummers uniek per organisatie (art. 35a Wet OB).
-- Eerst bestaande duplicaten hernoemen (oudste exemplaar behoudt het
-- nummer; latere krijgen een -DUP-suffix zodat de index kan bestaan) —
-- daarna de unieke index.
-- ------------------------------------------------------------
with dups as (
  select id,
         row_number() over (partition by organization_id, number order by created_at, id) as rn
  from public.invoices
  where number is not null
)
update public.invoices i
set number = i.number || '-DUP-' || left(i.id::text, 8),
    updated_at = now()
from dups d
where d.id = i.id and d.rn > 1;

create unique index if not exists invoices_org_number_key
  on public.invoices(organization_id, number);

-- ------------------------------------------------------------
-- FIX 5b. Verwijderen blokkeren zodra de factuur in het grootboek staat of
-- voorbij 'draft' is. Een verstuurde factuur is een wettelijk document
-- (bewaarplicht); een geboekte factuur laat anders een journaalpost zonder
-- brondocument achter, en het nummer zou opnieuw worden uitgegeven.
-- (Zelfde patroon als bank_account_block_delete_with_bookings.)
-- ------------------------------------------------------------
create or replace function public.invoice_block_delete_when_committed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.journal_entry_id is not null then
    raise exception 'Factuur % staat in het grootboek en kan niet worden verwijderd. Boek de journaalpost tegen of maak een creditnota.',
      coalesce(old.number, old.id::text) using errcode = '23514';
  end if;
  if coalesce(old.status, 'draft') <> 'draft' then
    if old.status in ('cancelled', 'void') then
      raise exception 'Factuur % is geannuleerd maar valt onder de bewaarplicht en kan niet worden verwijderd.',
        coalesce(old.number, old.id::text) using errcode = '23514';
    end if;
    raise exception 'Factuur % is al verstuurd (status: %) en valt onder de bewaarplicht; annuleer of crediteer deze in plaats van verwijderen.',
      coalesce(old.number, old.id::text), old.status using errcode = '23514';
  end if;
  return old;
end;
$$;

drop trigger if exists invoices_block_delete on public.invoices;
create trigger invoices_block_delete
  before delete on public.invoices
  for each row execute function public.invoice_block_delete_when_committed();

commit;
