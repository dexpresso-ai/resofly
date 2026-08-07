-- ============================================================
-- ResoFly — Zakelijke module: correcties op fase 3 na review
-- Date: 2026-08-07
--
-- De drie fase-3-migraties waren al toegepast toen de tegensprekende review erop
-- draaide. Vandaar een vervolgmigratie in plaats van een aanpassing ter plekke.
-- Vier bevindingen, waarvan één blokkerend.
--
-- 1. BLOKKEREND — de rente kon nooit geboekt worden.
--    book_dga_interest boekt per definitie op 31 december, en die dag ligt altijd
--    in de laatste btw-periode van het jaar. Zodra die aangifte is gefinaliseerd
--    zit daar een slot op dat nooit meer opengaat (alleen 'year'-rijen worden
--    ergens verwijderd). 'dga_interest' stond niet in de vrijstellingslijst van
--    post_journal_entry, dus de boeking stuitte voorgoed. Exact dezelfde fout als
--    eerder bij de Vpb-reservering — dit is de derde keer dat dit patroon
--    opduikt, dus staat het nu ook in het projectgeheugen.
--    'payroll' krijgt die vrijstelling BEWUST NIET: een loonjournaalpost raakt
--    wél btw-rubrieken en hoort in een afgesloten maand te stuiten.
--
-- 2. HOOG — "er is nog geen brutoloon geboekt" verscheen bij elk afgesloten jaar.
--    De loonvraag miste het filter op 'year_close'. De jaarafsluiting nulstelt
--    alle W&V-rekeningen, dus de creditering van 4100 hief de loonboekingen van
--    het jaar precies op: nul. Een BV die keurig DGA-loon had betaald kreeg
--    daardoor een rode waarschuwing dat er niets was geboekt.
--
-- 3. HOOG — "hoogste stand dit jaar" was de hoogste stand OOIT.
--    De piek werd gemeten over de hele historie tot 31 december, niet over het
--    jaar. Eén keer boven de € 17.500 uitkomen betekende dat de waarschuwing
--    daarna elk jaar bleef staan, ook als de rekening-courant al jaren leeg was.
--    De beginstand van het jaar moet wél meetellen — die is zelf een stand die
--    het hele jaar geldt — dus de piek is het maximum van de beginstand en elke
--    stand ín het jaar.
--
-- 4. MIDDEL — de rente werd altijd over het kalenderjaar gerekend.
--    Bij een gebroken boekjaar valt de renteboeking dan in het verkeerde
--    boekjaar, en werkt dat door in de Vpb-grondslag. Tijdsevenredig verdelen is
--    hier niet het antwoord: rente over een rekening-courant hoort in het
--    boekjaar waarin hij is aangegroeid. Zolang we dat niet netjes per boekjaar
--    berekenen, weigeren we het liever met een duidelijke reden.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1 + 3 + 2. dga_signals opnieuw: jaarpiek en loon zonder jaarafsluiting
-- ------------------------------------------------------------
create or replace function public.dga_signals(p_organization_id uuid, p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm public.dga_norms;
  v_limit bigint;
  v_year_start date := make_date(p_year, 1, 1);
  v_year_end date := make_date(p_year, 12, 31);
  v_rc_year_end bigint := 0;
  v_rc_opening bigint := 0;
  v_rc_peak bigint := 0;
  v_wages bigint := 0;
  v_has_rc boolean;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_norm from public.dga_norms where year = p_year;

  select l.interest_free_limit_cents into v_limit
  from public.dga_current_account_limits l
  where l.valid_from <= v_year_end
  order by l.valid_from desc
  limit 1;

  select exists (
    select 1 from public.ledger_accounts la
    where la.organization_id = p_organization_id and la.subtype = 'dga_current_account'
  ) into v_has_rc;

  if v_has_rc then
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
    into v_rc_year_end
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_year_end
      and la.subtype = 'dga_current_account';

    -- Beginstand van het jaar: alles vóór 1 januari.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
    into v_rc_opening
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date < v_year_start
      and la.subtype = 'dga_current_account';

    -- De piek is het maximum van de beginstand en elke stand ín het jaar. De
    -- beginstand telt mee omdat die op 1 januari daadwerkelijk op de rekening
    -- staat; alleen naar de mutaties kijken zou een rekening die het hele jaar
    -- onaangeroerd hoog stond als "nooit boven de grens" tellen.
    select greatest(
      v_rc_opening,
      coalesce(max(v_rc_opening + running), v_rc_opening)
    )::bigint
    into v_rc_peak
    from (
      select sum(sum(jl.debit_cents - jl.credit_cents)) over (order by je.date) as running
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.date between v_year_start and v_year_end
        and la.subtype = 'dga_current_account'
      group by je.date
    ) s;
  end if;

  -- Het filter op 'year_close' is wat hier eerder ontbrak: de jaarafsluiting
  -- nulstelt alle W&V-rekeningen, dus zonder dit filter heft zij de loonboekingen
  -- van een afgesloten jaar precies op.
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
  into v_wages
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and extract(year from je.date)::int = p_year
    and la.subtype = 'wages';

  return jsonb_build_object(
    'year', p_year,
    'normsKnown', v_norm.year is not null,
    'usualSalaryNormCents', v_norm.usual_salary_norm_cents,
    'deMinimisCents', v_norm.de_minimis_cents,
    'comparableSalaryBasisPoints', v_norm.comparable_salary_basis_points,
    'excessiveLoanThresholdCents', v_norm.excessive_loan_threshold_cents,
    'interestFreeLimitCents', v_limit,
    'hasCurrentAccount', v_has_rc,
    'currentAccountYearEndCents', v_rc_year_end,
    'currentAccountPeakCents', v_rc_peak,
    'wagesBookedCents', v_wages,
    'noWagesBooked', v_wages = 0,
    'aboveInterestFreeLimit', v_limit is not null and v_rc_peak > v_limit,
    'aboveExcessiveLoanThreshold',
      v_norm.excessive_loan_threshold_cents is not null
      and v_rc_year_end > v_norm.excessive_loan_threshold_cents
  );
end;
$$;

revoke all on function public.dga_signals(uuid, integer) from public, anon, authenticated;
grant execute on function public.dga_signals(uuid, integer) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Gebroken boekjaar: weigeren in plaats van fout toewijzen
-- ------------------------------------------------------------
create or replace function public.book_dga_interest(
  p_organization_id uuid,
  p_year integer,
  p_created_by uuid default auth.uid()
)
returns public.dga_interest_postings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_calc jsonb;
  v_interest bigint;
  v_date date := make_date(p_year, 12, 31);
  v_rc uuid;
  v_income uuid;
  v_expense uuid;
  v_entry public.journal_entries;
  v_row public.dga_interest_postings;
  v_closed record;
  v_fy_start smallint;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':dga'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'De rekening-courant DGA hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  -- De berekening loopt over het kalenderjaar. Bij een gebroken boekjaar zou de
  -- last daardoor in het verkeerde boekjaar vallen en doorwerken in de
  -- Vpb-grondslag. Liever weigeren met een reden dan stilzwijgend verkeerd
  -- toerekenen.
  select coalesce(cs.fiscal_year_start_month, 1) into v_fy_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if coalesce(v_fy_start, 1) <> 1 then
    raise exception 'Deze administratie heeft een gebroken boekjaar (start in maand %). De renteberekening loopt over het kalenderjaar en zou de last in het verkeerde boekjaar zetten; boek de rente voorlopig handmatig.', v_fy_start
      using errcode = '0A000';
  end if;

  if exists (
    select 1 from public.dga_interest_postings p
    where p.organization_id = p_organization_id and p.year = p_year and p.status = 'posted'
  ) then
    raise exception 'De rente over % is al geboekt.', p_year using errcode = '23505';
  end if;

  v_calc := public.compute_dga_interest(p_organization_id, p_year);
  v_interest := coalesce((v_calc->>'interestCents')::bigint, 0);

  if (v_calc->>'hasDaysWithoutRate')::boolean then
    raise exception 'Voor een deel van % is nog geen rentepercentage vastgelegd. Leg eerst vast wat je met je adviseur hebt afgesproken.', p_year
      using errcode = '23514';
  end if;
  if v_interest = 0 then
    raise exception 'Over % valt geen rente te boeken: het saldo van de rekening-courant was nul.', p_year
      using errcode = '23514';
  end if;

  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het boekjaar rond % is afgesloten. Heropen het om de rente alsnog te boeken.',
      to_char(v_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_rc := public.bookkeeping_account_id(p_organization_id, '1400');

  if v_interest > 0 then
    v_income := public.bookkeeping_account_id(p_organization_id, '9000');
    v_entry := public.post_journal_entry(
      p_organization_id, v_date, 'Rente rekening-courant DGA ' || p_year,
      'dga_interest', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_rc, 'description', 'Rente bijgeschreven ' || p_year,
          'debit_cents', v_interest, 'credit_cents', 0),
        jsonb_build_object('account_id', v_income, 'description', 'Rente rekening-courant DGA ' || p_year,
          'debit_cents', 0, 'credit_cents', v_interest)
      ), p_created_by);
  else
    v_expense := public.bookkeeping_account_id(p_organization_id, '9100');
    v_entry := public.post_journal_entry(
      p_organization_id, v_date, 'Rente rekening-courant DGA ' || p_year,
      'dga_interest', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_expense, 'description', 'Rente rekening-courant DGA ' || p_year,
          'debit_cents', -v_interest, 'credit_cents', 0),
        jsonb_build_object('account_id', v_rc, 'description', 'Rente bijgeschreven ' || p_year,
          'debit_cents', 0, 'credit_cents', -v_interest)
      ), p_created_by);
  end if;

  insert into public.dga_interest_postings(
    organization_id, created_by, year, interest_cents, computation, journal_entry_id, status)
  values (p_organization_id, p_created_by, p_year, v_interest, v_calc, v_entry.id, 'posted')
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.book_dga_interest(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.book_dga_interest(uuid, integer, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 1. post_journal_entry: 'dga_interest' vrijstellen van het periodeslot
--    LETTERLIJK overgenomen uit 20260807050000; alleen de vrijstellingslijst is
--    uitgebreid. De post raakt 1400 en 9000/9100 — geen enkele btw-rubriek.
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
  -- GEWIJZIGD (20260807050000): 'corporate_tax' krijgt dezelfde vrijstelling.
  -- De Vpb-reservering valt per definitie op de balansdatum, en die ligt altijd
  -- in de laatste btw-periode van het boekjaar. Zonder deze uitzondering zou de
  -- reservering nooit geboekt kunnen worden zodra die aangifte is gefinaliseerd —
  -- een slot dat nooit meer opengaat. De post raakt alleen 9900 en 1540 en komt
  -- in geen enkele btw-rubriek voor, dus er valt niets te beschermen.
  -- GEWIJZIGD (20260807090000): 'dga_interest' erbij. De renteboeking valt per
  -- definitie op 31 december, en die dag ligt altijd in de laatste btw-periode
  -- van het jaar — een slot dat nooit meer opengaat. Zonder deze uitzondering
  -- kon de rente nooit geboekt worden zodra die aangifte definitief was.
  -- 'payroll' juist NIET: een loonjournaalpost in een afgesloten maand hoort
  -- wél te stuiten, want die raakt de btw-aangifte wel degelijk.
  if coalesce(p_source_type, 'manual') not in ('year_close', 'corporate_tax', 'dga_interest') and exists (
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

commit;
