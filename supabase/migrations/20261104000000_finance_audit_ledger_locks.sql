-- ============================================================
-- ResoFly — Controle financiën en BV (4 november 2026), deel 1:
-- grootboek, periodesloten, btw-afsluiting en tegenboekingen
--
-- Uit de controle van 4 november (CHANGELOG_FINANCIEN_BV_CONTROLE_2026-11-04.md).
-- Elke bevinding is eerst op staging nagespeeld in een teruggedraaide transactie.
--
--   1. Het jaarslot viel weg als een boekjaar precies samenviel met een
--      btw-periode (eerste boekjaar 1-10 t/m 31-12 = Q4). De unieke sleutel van
--      closed_periods kende het soort slot niet, dus de jaarafsluiting botste op
--      het btw-slot en sloeg het jaarslot stil over. Gevolg: het resultaat telde
--      dubbel op de balans en het volgende boekjaar was nooit meer af te sluiten.
--      Nu: sleutel inclusief period_type, en ontbrekende jaarsloten aangevuld.
--   2. Een btw-slot hield élke boeking tegen, ook afschrijvingen, lonen en
--      overlopende posten die geen rubriek raken. Wie Q4 indiende vóór de
--      jaarafsluiting (de aangifte moet eind januari binnen zijn), kon de
--      afschrijving van december alleen nog op 1 januari boeken: in het verkeerde
--      boekjaar. Nu houdt een btw-slot alleen boekingen tegen die de aangifte
--      raken (omzet, btw-rekeningen, verlegde/EU/invoer-codes); het boekjaarslot
--      houdt alles tegen.
--   3. Alles tot en met het einde van het laatst afgesloten boekjaar ligt vast,
--      ook datums vóór het eerste boekjaar. Een teruggedateerde boeking veranderde
--      anders de balans van een afgesloten (en misschien gedeponeerd) jaar.
--   4. finalize_vat_return nam van/tot van de aanroeper aan en overschreef een
--      al ingediende of betaalde aangifte (status, rubrieken, boekstuk). Met een
--      ruim bereik vergrendelde één aanroep de hele administratie, voorgoed. Nu:
--      de periode volgt uit soort/jaar/nummer, een afgesloten aangifte blijft
--      staan (correctie = suppletie) en overlap met een ander btw-slot kan niet.
--   5. Een boeking kon tussen het optellen en het vergrendelen in een jaar of
--      btw-periode glippen. Nu één grendel per organisatie: boekingen gedeeld,
--      afsluiten exclusief.
--   6. Een boekjaar afsluiten dat nog loopt, kan niet meer.
--   7. Tegenboeken: de doorboeking van een btw-aangifte (dubbele aangifte in
--      een open periode), een tegenboeking zelf (keten) en boekingen van activa
--      zonder het activaregister mee te nemen. Activa-boekingen tegenboeken zet
--      het register nu mee terug; de rest wordt geweigerd met uitleg.
--   8. Een beginbalans was na tegenboeken nooit meer te vervangen: de
--      tegenboeking zelf telde als beginbalans.
--   9. Activa: geen afschrijving meer op een afgestoten activum.
--  10. Boekstuknummers: vanaf 100.000 per jaar werd het nummer afgekapt.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Periodesloten: sleutel inclusief soort ────────────────────────────────

alter table public.closed_periods drop constraint if exists closed_periods_range_unique;
drop index if exists public.closed_periods_range_unique;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.closed_periods'::regclass and conname = 'closed_periods_type_range_unique'
  ) then
    alter table public.closed_periods
      add constraint closed_periods_type_range_unique unique (organization_id, period_type, period_start, period_end);
  end if;
end $$;

-- Ontbrekende jaarsloten van afgesloten boekjaren aanvullen (bevinding 1).
insert into public.closed_periods (organization_id, period_type, year, quarter, month, period_start, period_end, closed_by, closed_at)
select fy.organization_id, 'year', extract(year from fy.period_start)::int, null, null,
       fy.period_start, fy.period_end, fy.closed_by, coalesce(fy.closed_at, now())
from public.fiscal_years fy
where fy.status = 'closed'
  and not exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = fy.organization_id
      and cp.period_type = 'year'
      and cp.period_start = fy.period_start
      and cp.period_end = fy.period_end
  )
on conflict (organization_id, period_type, period_start, period_end) do nothing;

-- ── 2. Raakt een boeking de btw-aangifte? ────────────────────────────────────
-- Dezelfde indeling als compute_vat_boxes: omzetregels (behalve financiële baten
-- en lasten zonder btw-code), de btw-rekeningen zelf, en kosten/activa met een
-- verlegde, EU- of invoercode (2a/4a/4b). Al het andere komt in geen rubriek.

create or replace function public.journal_lines_touch_vat(p_organization_id uuid, p_lines jsonb)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l
    cross join lateral (
      select
        case when nullif(l->>'account_id', '') is not null then (l->>'account_id')::uuid end as acc_id,
        case when nullif(l->>'account_id', '') is null then l->>'account_code' end as acc_code
    ) k
    join public.ledger_accounts la
      on la.organization_id = p_organization_id
     and (la.id = k.acc_id or la.code = k.acc_code)
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id and vc.code = nullif(l->>'vat_code', '')
    where la.subtype in ('vat_output', 'vat_input', 'vat_reverse')
       or (la.type = 'revenue'
           and not (vc.id is null and la.report_group in ('financiele_baten', 'financiele_lasten', 'resultaat_deelnemingen')))
       or (la.type in ('expense', 'asset') and vc.id is not null and vc.sales_box in ('2a', '4a', '4b'))
  );
$$;

revoke all on function public.journal_lines_touch_vat(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.journal_lines_touch_vat(uuid, jsonb) to service_role;

-- ── 3. Eerstvolgende open boekdatum ──────────────────────────────────────────

create or replace function public.first_open_booking_date_for(p_organization_id uuid, p_date date, p_touches_vat boolean)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_date date := p_date;
  v_locked_through date;
  v_end date;
  v_guard integer := 0;
begin
  -- Alles tot en met het einde van het laatst afgesloten boekjaar ligt vast.
  select max(cp.period_end) into v_locked_through
  from public.closed_periods cp
  where cp.organization_id = p_organization_id and cp.period_type = 'year';
  if v_locked_through is not null and v_date <= v_locked_through then
    v_date := v_locked_through + 1;
  end if;

  -- Een boeking die geen btw-rubriek raakt, mag in een afgesloten btw-periode.
  if not coalesce(p_touches_vat, true) then
    return v_date;
  end if;

  loop
    select max(cp.period_end) into v_end
    from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_start is not null and cp.period_end is not null
      and v_date between cp.period_start and cp.period_end;
    exit when v_end is null;
    v_date := v_end + 1;
    v_guard := v_guard + 1;
    if v_guard > 400 then
      raise exception 'Geen open boekperiode gevonden na %.', p_date using errcode = '23514';
    end if;
  end loop;
  return v_date;
end;
$$;

revoke all on function public.first_open_booking_date_for(uuid, date, boolean) from public, anon, authenticated;
grant execute on function public.first_open_booking_date_for(uuid, date, boolean) to service_role;

-- De bestaande variant gaat uit van een boeking die de btw raakt (ongewijzigd
-- gedrag voor verkoop, inkoop, betalingen en suppleties).
create or replace function public.first_open_booking_date(p_organization_id uuid, p_date date)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select public.first_open_booking_date_for(p_organization_id, p_date, true);
$$;

revoke all on function public.first_open_booking_date(uuid, date) from public, anon, authenticated;
grant execute on function public.first_open_booking_date(uuid, date) to service_role;

-- ── 4. post_journal_entry: boekjaarslot, btw-slot alleen voor btw, grendel ──
CREATE OR REPLACE FUNCTION public.post_journal_entry(p_organization_id uuid, p_date date, p_description text, p_source_type text, p_source_id uuid, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_locked_through date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- De vrijgestelde soorten (jaarafsluiting, Vpb, dga-rente) mogen in een
  -- afgesloten periode boeken. Alleen de functies die ze maken, zetten de vlag
  -- resofly.trusted_journal_source (voor de rest van de transactie); een
  -- rechtstreekse aanroep met p_source_type => 'dga_interest' boekte anders
  -- in elke gesloten btw-periode of elk afgesloten boekjaar.
  if coalesce(p_source_type, 'manual') in ('year_close', 'corporate_tax', 'dga_interest')
     and auth.role() <> 'service_role'
     and coalesce(current_setting('resofly.trusted_journal_source', true), '') <> p_source_type then
    raise exception 'Dit soort boeking maakt alleen de jaarafsluiting, de Vpb-aangifte of de dga-renteboeking zelf.'
      using errcode = '42501';
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
  -- GEWIJZIGD (20261104000000): één grendel per organisatie. Boekingen nemen
  -- hem gedeeld, de jaarafsluiting en het afsluiten van een btw-periode
  -- exclusief: zo glipt er geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock_shared(hashtext(p_organization_id::text || ':periodegrendel'));

  if coalesce(p_source_type, 'manual') not in ('year_close', 'corporate_tax', 'dga_interest') then
    -- GEWIJZIGD (20261104000000): het boekjaarslot geldt voor alles tot en met
    -- het einde van het laatst afgesloten boekjaar, ook voor datums vóór het
    -- eerste boekjaar. Afsluiten gaat op volgorde, dus de jaarsloten vormen één
    -- aaneengesloten blok.
    select max(cp.period_end) into v_locked_through
    from public.closed_periods cp
    where cp.organization_id = p_organization_id and cp.period_type = 'year';
    if v_locked_through is not null and p_date <= v_locked_through then
      raise exception 'Het boekjaar tot en met % is afgesloten; kies een boekdatum daarna.', to_char(v_locked_through, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;

    -- GEWIJZIGD (20261104000000): een btw-slot houdt alleen boekingen tegen die
    -- de aangifte raken. Afschrijvingen, lonen, overlopende posten, de winst-
    -- bestemming en dividend komen in geen rubriek en horen op hun eigen datum.
    if exists (
      select 1 from public.closed_periods cp
      where cp.organization_id = p_organization_id
        and cp.period_type in ('month', 'quarter')
        and cp.period_start is not null and cp.period_end is not null
        and p_date between cp.period_start and cp.period_end
    ) and public.journal_lines_touch_vat(p_organization_id, p_lines) then
      raise exception 'De btw-aangifteperiode rond % is afgesloten; kies een boekdatum in de eerstvolgende open periode.', p_date
        using errcode = '23514';
    end if;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_year::text));
  select count(*) + 1 into v_seq from public.journal_entries
  where organization_id = p_organization_id and year = v_year;
  v_number := 'JP-' || v_year || '-' || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0');

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
$function$;
revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) from public, anon;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) to authenticated, service_role;

-- ── 5. finalize_vat_return: periode afgeleid, niets overschrijven ────────────
CREATE OR REPLACE FUNCTION public.finalize_vat_return(p_organization_id uuid, p_period_type text, p_year integer, p_period_index integer, p_from date, p_to date, p_created_by uuid DEFAULT auth.uid())
 RETURNS vat_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ret public.vat_returns;
  v_rubrieken jsonb;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_expected_from date;
  v_expected_to date;
  v_existing_status text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  -- GEWIJZIGD (20261104000000): de periode volgt uit soort, jaar en nummer.
  -- Andere datums gaven een tweede, willekeurig slot (tot en met de hele
  -- administratie) en overschreven de aangifte van die periode.
  if p_year is null or p_year < 2000 or p_year > 2100
     or p_period_index is null or p_period_index < 1
     or p_period_index > (case when p_period_type = 'month' then 12 else 4 end) then
    raise exception 'Ongeldige aangifteperiode.' using errcode = '23514';
  end if;
  v_expected_from := make_date(p_year, case when p_period_type = 'month' then p_period_index else (p_period_index - 1) * 3 + 1 end, 1);
  v_expected_to := (v_expected_from
    + case when p_period_type = 'month' then interval '1 month' else interval '3 months' end
    - interval '1 day')::date;
  if p_from is distinct from v_expected_from or p_to is distinct from v_expected_to then
    raise exception 'Deze aangifteperiode loopt van % t/m %; andere datums kunnen niet.',
      to_char(v_expected_from, 'DD-MM-YYYY'), to_char(v_expected_to, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- Exclusief: geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  -- Een afgesloten aangifte blijft staan; een correctie loopt via een suppletie.
  select status into v_existing_status
  from public.vat_returns
  where organization_id = p_organization_id
    and period_type = p_period_type and year = p_year and period_index = p_period_index
    and supplements_return_id is null;
  if v_existing_status is not null and v_existing_status <> 'draft' then
    raise exception 'De aangifte over deze periode is al afgesloten (%). Een correctie loopt via een suppletie.',
      case v_existing_status when 'finalized' then 'doorgeboekt' when 'filed' then 'ingediend' when 'paid' then 'betaald' else v_existing_status end
      using errcode = '23514';
  end if;

  -- Geen overlap met een ander btw-slot (bv. januari terwijl Q1 al dicht is,
  -- of na een wissel van kwartaal- naar maandaangifte).
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_start <= p_to and cp.period_end >= p_from
  ) then
    raise exception 'Deze periode valt (deels) in een al afgesloten btw-periode.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Eén aanroep = één statement = één consistente MVCC-momentopname: wat wordt
  -- doorgeboekt is exact wat in de bevroren rubrieken-snapshot komt.
  v_rubrieken := public.compute_vat_boxes(p_organization_id, p_from, p_to, null);
  v_clear_output := (v_rubrieken->>'clear_output')::bigint;
  v_clear_reverse := (v_rubrieken->>'clear_reverse')::bigint;
  v_clear_input := (v_rubrieken->>'clear_input')::bigint;
  v_saldo_afgerond := (v_rubrieken->>'saldo_afgerond')::bigint;
  v_afronding := (v_rubrieken->>'afronding_cents')::bigint;

  -- Doorboeking: BTW-rekeningen exact afsluiten naar 1530 (tekenvast — een
  -- negatief periodesaldo op een rekening wordt aan de andere kant geboekt).
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Afsluiten af te dragen BTW',
      'debit_cents', case when v_clear_output > 0 then v_clear_output else 0 end,
      'credit_cents', case when v_clear_output < 0 then -v_clear_output else 0 end));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Afsluiten verlegde/ICP BTW',
      'debit_cents', case when v_clear_reverse > 0 then v_clear_reverse else 0 end,
      'credit_cents', case when v_clear_reverse < 0 then -v_clear_reverse else 0 end));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Afsluiten voorbelasting',
      'debit_cents', case when v_clear_input < 0 then -v_clear_input else 0 end,
      'credit_cents', case when v_clear_input > 0 then v_clear_input else 0 end));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting (hele euro''s per rubriek)',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end
    ));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Afrondingsverschil BTW-aangifte (cent → hele euro''s)',
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
  on conflict (organization_id, period_type, year, period_index) where supplements_return_id is null do update
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
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  return v_ret;
end;
$function$;
revoke all on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) from public, anon;
grant execute on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) to authenticated, service_role;

-- ── 6. close_fiscal_year: jaarslot altijd, geen lopend jaar, grendel ────────
CREATE OR REPLACE FUNCTION public.close_fiscal_year(p_organization_id uuid, p_fiscal_year_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_kor boolean;
  v_vat_period text;
  v_result_code text;
  v_lines jsonb := '[]'::jsonb;
  v_debit_total bigint := 0;   -- som van de debiteringen tegen omzetrekeningen
  v_credit_total bigint := 0;  -- som van de crediteringen tegen kostenrekeningen
  v_result_cents bigint := 0;  -- nettoresultaat (winst > 0, verlies < 0)
  v_entry public.journal_entries;
  v_result_account uuid;
  r record;
  v_cursor date;
  v_p_start date;
  v_p_end date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer close/reopen per organisatie (voorkomt dubbele resultaatbestemming).
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));
  -- TOEGEVOEGD (20261104000000): exclusief op de boekingsgrendel, zodat er
  -- geen boeking meer in dit jaar valt tussen het optellen en het slot.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Dit boekjaar is al afgesloten.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een lopend boekjaar sluit je niet af; latere
  -- boekingen zouden anders naar het volgende jaar schuiven.
  if v_fy.period_end >= current_date then
    raise exception 'Dit boekjaar loopt nog tot en met %; afsluiten kan vanaf de dag daarna.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Sequentiële volgorde: geen geboekte transacties vóór dit boekjaar die niet in
  -- een afgesloten jaar-slot vallen (dus het voorgaande boekjaar moet dicht zijn).
  if exists (
    select 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date < v_fy.period_start
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
      )
  ) then
    raise exception 'Sluit eerst het voorgaande boekjaar af voordat je dit boekjaar afsluit.' using errcode = '23514';
  end if;

  -- BTW hard block (tenzij KOR): elke kalender-aangifteperiode die binnen het
  -- boekjaar begint, moet gefinaliseerd (afgesloten) zijn.
  select coalesce(kor_enabled, false), coalesce(vat_return_period, 'quarterly'),
         coalesce(year_result_account_code, '0510')
    into v_kor, v_vat_period, v_result_code
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  v_vat_period := coalesce(v_vat_period, 'quarterly');
  v_result_code := coalesce(v_result_code, '0510');

  if not v_kor then
    v_cursor := date_trunc(case when v_vat_period = 'monthly' then 'month' else 'quarter' end, v_fy.period_start)::date;
    while v_cursor <= v_fy.period_end loop
      if v_vat_period = 'monthly' then
        v_p_start := v_cursor;
        v_p_end := (v_cursor + interval '1 month' - interval '1 day')::date;
      else
        v_p_start := v_cursor;
        v_p_end := (v_cursor + interval '3 months' - interval '1 day')::date;
      end if;
      -- Elke kalender-aangifteperiode die het boekjaar OVERLAPT moet gefinaliseerd
      -- zijn (ook een leidende/afsluitende deelperiode bij een gebroken boekjaar dat
      -- niet op een kwartaal-/maandgrens begint). Match strikt op de ingestelde
      -- frequentie én het volledige bereik dat finalize_vat_return vastlegt, zodat een
      -- maand-finalisatie niet ten onrechte als kwartaal-finalisatie telt.
      if v_p_end >= v_fy.period_start and v_p_start <= v_fy.period_end then
        if not exists (
          select 1 from public.closed_periods cp
          where cp.organization_id = p_organization_id
            and cp.period_type = case when v_vat_period = 'monthly' then 'month' else 'quarter' end
            and cp.period_start = v_p_start
            and cp.period_end = v_p_end
        ) then
          raise exception 'Finaliseer eerst alle BTW-aangiften van dit boekjaar (ontbreekt de periode % t/m %).',
            to_char(v_p_start, 'DD-MM-YYYY'), to_char(v_p_end, 'DD-MM-YYYY')
            using errcode = '23514';
        end if;
      end if;
      v_cursor := (v_p_end + interval '1 day')::date;
    end loop;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluitregels per W&V-rekening (exclusief eerdere/teruggedraaide year_close).
  for r in
    select jl.account_id, la.type as account_type,
           sum(jl.debit_cents) as d, sum(jl.credit_cents) as c
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type in ('revenue', 'expense')
    group by jl.account_id, la.type
    having sum(jl.credit_cents - jl.debit_cents) <> 0
  loop
    if (r.c - r.d) > 0 then
      -- creditsaldo (typisch omzet): debiteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', (r.c - r.d), 'credit_cents', 0));
      v_debit_total := v_debit_total + (r.c - r.d);
    else
      -- debetsaldo (typisch kosten): crediteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', 0, 'credit_cents', (r.d - r.c)));
      v_credit_total := v_credit_total + (r.d - r.c);
    end if;
  end loop;

  -- Nettoresultaat volgt als restpost → boekstuk sluit exact (geen 4900-vangnet).
  v_result_cents := v_debit_total - v_credit_total;
  if v_result_cents <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, v_result_code);
    if v_result_cents > 0 then
      -- winst → crediteer de resultaatrekening (eigen vermogen stijgt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_result_cents));
    else
      -- verlies → debiteer de resultaatrekening (eigen vermogen daalt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', -v_result_cents, 'credit_cents', 0));
    end if;
  end if;

  -- Post het afsluitboekstuk (leeg boekjaar → geen boekstuk).
  if jsonb_array_length(v_lines) > 0 then
    perform set_config('resofly.trusted_journal_source', 'year_close', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_fy.period_end,
      'Jaarafsluiting ' || v_fy.label,
      'year_close', p_fiscal_year_id, v_lines, p_created_by
    );
  end if;

  -- Vergrendel het volledige boekjaarbereik.
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, 'year', extract(year from v_fy.period_start)::int, null, null,
    v_fy.period_start, v_fy.period_end, p_created_by
  )
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  update public.fiscal_years
  set status = 'closed', close_journal_entry_id = v_entry.id,
      result_account_code = v_result_code, result_cents = v_result_cents,
      closed_at = now(), closed_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$function$;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;

-- ── 7. reverse_journal_entry: btw-doorboeking, ketens en activaregister ─────
CREATE OR REPLACE FUNCTION public.reverse_journal_entry(p_entry_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
  v_asset public.fixed_assets;
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
  -- TOEGEVOEGD (20260807030000): een resultaatbestemming is net zo'n
  -- systeemboekstuk. Wie hem hier tegenboekt, laat de rij in
  -- result_appropriations op 'posted' staan; het boekjaar blijft dan
  -- geblokkeerd voor heropenen én de nette weg ("Bestemming terugdraaien")
  -- weigert daarna met "al tegengeboekt". Dus meteen hier afvangen.
  if v_src.source_type = 'result_appropriation' then
    raise exception 'Een resultaatbestemming boek je niet los tegen; gebruik "Bestemming terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807050000): idem voor de Vpb-reservering. Los tegenboeken
  -- laat corporate_tax_returns op 'final' staan en de verliesadministratie
  -- ongemoeid; daarna weigert "Berekening terugdraaien" met "al tegengeboekt".
  if v_src.source_type = 'corporate_tax' then
    raise exception 'Een Vpb-reservering boek je niet los tegen; gebruik "Berekening terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807070000): idem voor de renteboeking op de
  -- rekening-courant DGA. Los tegenboeken laat dga_interest_postings op
  -- 'posted' staan, waardoor de rente over dat jaar nooit opnieuw geboekt kan
  -- worden en "Rente terugdraaien" daarna weigert.
  if v_src.source_type = 'dga_interest' then
    raise exception 'Een renteboeking op de rekening-courant boek je niet los tegen; gebruik "Rente terugdraaien".'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807100000): idem voor een dividenduitkering. Die bestaat
  -- bovendien uit twee boekstukken; er één van tegenboeken laat een halve
  -- inhouding achter en zet dividend_distributions op slot.
  if v_src.source_type = 'dividend' then
    raise exception 'Een dividendboeking boek je niet los tegen; gebruik "Uitkering terugdraaien" bij het dividend.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): de doorboeking van een btw-aangifte of
  -- suppletie hoort bij een afgesloten aangifte. De spiegelpost viel in een
  -- open periode en telde daar de hele aangifte nog eens mee.
  if v_src.source_type = 'vat_return' then
    raise exception 'De doorboeking van een btw-aangifte boek je niet tegen. Een fout in een afgesloten aangifte corrigeer je met een suppletie.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een tegenboeking tegenboeken maakt een keten
  -- die de rapporten en de beginbalanscontrole niet meer kunnen volgen.
  if v_src.reverses_entry_id is not null then
    raise exception 'Dit boekstuk is zelf een tegenboeking. Boek het oorspronkelijke boekstuk opnieuw in plaats van de tegenboeking tegen te boeken.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): boekingen van activa houden het activaregister
  -- bij. Tegenboeken mag, maar dan gaat het register mee terug (zie onderaan);
  -- eerst wel in de juiste volgorde: desinvestering, afschrijvingen, aanschaf.
  if v_src.source_type = 'asset_acquisition' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.acquisition_journal_entry_id = v_src.id then
      if v_asset.status = 'disposed'
         or exists (select 1 from public.asset_depreciations ad where ad.asset_id = v_asset.id and ad.status = 'posted') then
        raise exception 'Draai eerst de desinvestering en de geboekte afschrijvingen van "%" terug; daarna de aanschaf.', v_asset.name
          using errcode = '23514';
      end if;
    end if;
  elsif v_src.source_type = 'asset_depreciation' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.status = 'disposed' then
      raise exception 'Draai eerst de desinvestering van "%" terug; daarna de afschrijving.', v_asset.name
        using errcode = '23514';
    end if;
  elsif v_src.source_type = 'asset_disposal' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
  end if;

  -- Suppletie-integriteit: het origineel is uitgesloten van de reguliere
  -- aangifte, maar de spiegelpost zou er WEL in tellen → scheefstand. Correctie
  -- op een suppletie = nieuwe correctieboeking + desgewenst nieuwe suppletie.
  if exists (select 1 from public.vat_supplement_entries vse where vse.entry_id = v_src.id) then
    raise exception 'Boekstuk % is verrekend in een btw-suppletie en kan niet worden tegengeboekt. Maak een nieuwe correctieboeking (memoriaal) en verreken die in een nieuwe suppletie.',
      coalesce(v_src.entry_number, v_src.id::text) using errcode = '23514';
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

  -- TOEGEVOEGD (20261104000000): het activaregister gaat mee terug, zodat
  -- grootboek en register gelijk blijven (anders boekte de desinvestering de
  -- verkeerde cumulatieve afschrijving af, en bleef een tegengeboekte termijn
  -- voorgoed als geboekt staan).
  if v_src.source_type = 'asset_acquisition' then
    update public.fixed_assets
    set acquisition_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and acquisition_journal_entry_id = v_src.id;
  elsif v_src.source_type = 'asset_depreciation' then
    update public.asset_depreciations
    set status = 'scheduled', journal_entry_id = null, posted_at = null
    where journal_entry_id = v_src.id and organization_id = v_src.organization_id;
    update public.fixed_assets
    set status = 'active'
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'fully_depreciated';
  elsif v_src.source_type = 'asset_disposal' then
    update public.fixed_assets
    set status = 'active', disposal_date = null, disposal_proceeds_cents = null
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'disposed';
    if found then
      perform public.generate_depreciation_schedule(v_src.organization_id, v_src.source_id);
      if not exists (
        select 1 from public.asset_depreciations ad
        where ad.asset_id = v_src.source_id and ad.status = 'scheduled'
      ) then
        update public.fixed_assets set status = 'fully_depreciated'
        where id = v_src.source_id and organization_id = v_src.organization_id and status = 'active';
      end if;
    end if;
  end if;

  return v_reversal;
end;
$function$;
revoke all on function public.reverse_journal_entry(uuid, date, uuid) from public, anon;
grant execute on function public.reverse_journal_entry(uuid, date, uuid) to authenticated, service_role;

-- ── 8. create_opening_balance: tegenboeking telt niet als beginbalans ────────
CREATE OR REPLACE FUNCTION public.create_opening_balance(p_organization_id uuid, p_as_of_date date, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lines jsonb;
  v_debit bigint;
  v_credit bigint;
  v_equity bigint;
  v_existing text;
  v_plug_code text;
  v_plug_label text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Beginbalans heeft minimaal één regel nodig.' using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_existing
  from public.journal_entries je
  where je.organization_id = p_organization_id
    and je.source_type = 'opening_balance'
    and je.status = 'posted'
    and je.reversed_by_entry_id is null
    -- GEWIJZIGD (20261104000000): de tegenboeking van een beginbalans is zelf
    -- geen beginbalans; anders kon er nooit een nieuwe komen.
    and je.reverses_entry_id is null
  limit 1;
  if v_existing is not null then
    raise exception 'Er is al een beginbalans geboekt (boekstuk %). Boek die eerst tegen voordat je een nieuwe vastlegt.', v_existing
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluit het verschil op eigen vermogen zodat de openingsbalans in balans is.
  select coalesce(sum(coalesce((l->>'debit_cents')::bigint,0)),0),
         coalesce(sum(coalesce((l->>'credit_cents')::bigint,0)),0)
    into v_debit, v_credit
  from jsonb_array_elements(p_lines) l;

  v_lines := p_lines;
  v_equity := v_debit - v_credit;
  if v_equity <> 0 then
    -- Welke rekening de sluitpost draagt, hangt aan de rechtsvorm. Bij een
    -- kapitaalvennootschap is het meegebrachte vermogen géén gestort kapitaal —
    -- dat is precies het bedrag dat de aandeelhouder ooit heeft volgestort en
    -- dat legt de gebruiker zelf op 0500. Alles wat de onderneming daarna heeft
    -- opgebouwd hoort bij de reserves.
    -- Een ketting en geen vaste keuze: 0520 bestaat alleen ná het BV-schema, en
    -- bookkeeping_account_id werpt een fout in plaats van terug te vallen.
    if public.org_fiscal_regime(p_organization_id) = 'vpb' then
      select code into v_plug_code
      from public.ledger_accounts
      where organization_id = p_organization_id and code in ('0520', '0510', '0500')
      order by array_position(array['0520','0510','0500'], code)
      limit 1;
      v_plug_label := 'Meegebracht eigen vermogen (sluitpost beginbalans)';
    else
      v_plug_code := '0500';
      v_plug_label := 'Eigen vermogen (sluitpost beginbalans)';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, coalesce(v_plug_code, '0500')),
      'description', v_plug_label,
      'debit_cents', case when v_equity < 0 then -v_equity else 0 end,
      'credit_cents', case when v_equity > 0 then v_equity else 0 end
    ));
  end if;

  return public.post_journal_entry(
    p_organization_id, p_as_of_date, 'Beginbalans per ' || p_as_of_date,
    'opening_balance', null, v_lines, p_created_by
  );
end;
$function$;
revoke all on function public.create_opening_balance(uuid, date, jsonb, uuid) from public, anon;
grant execute on function public.create_opening_balance(uuid, date, jsonb, uuid) to authenticated, service_role;

-- ── 10. Activa: niet afschrijven na afstoten, btw-slot alleen bij btw ───────
CREATE OR REPLACE FUNCTION public.post_asset_depreciation(p_organization_id uuid, p_asset_id uuid, p_through_date date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_remaining integer;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  -- De aanschaf moet op de balans staan (debet 0100) voordat er wordt afgeschreven,
  -- anders zou 0150 gecrediteerd worden zonder tegenpost → negatieve netto-activa.
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'Boek eerst de aanschaf van dit activum naar het grootboek voordat je afschrijft.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een afgestoten activum staat niet meer op de
  -- balans; afschrijven zou 0150 crediteren zonder activum erachter.
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten; er valt niets meer op af te schrijven.' using errcode = '23514';
  end if;

  for r in
    select * from public.asset_depreciations
    where asset_id = p_asset_id and status = 'scheduled' and date <= p_through_date
    order by period_index
  loop
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_asset.depreciation_account_id,
        'description', 'Afschrijving ' || v_asset.name,
        'debit_cents', r.amount_cents, 'credit_cents', 0
      ),
      jsonb_build_object(
        'account_id', v_asset.accumulated_depreciation_account_id,
        'description', 'Cumulatieve afschrijving ' || v_asset.name,
        'debit_cents', 0, 'credit_cents', r.amount_cents
      )
    );
    -- Nagekomen afschrijving in een al afgesloten periode → eerstvolgende open datum.
    -- GEWIJZIGD (20261104000000): een afschrijving raakt geen btw-rubriek en
    -- schuift dus alleen over een afgesloten boekjaar heen, niet over een btw-slot.
    v_book_date := public.first_open_booking_date_for(p_organization_id, r.date, public.journal_lines_touch_vat(p_organization_id, v_lines));
    v_entry := public.post_journal_entry(
      p_organization_id, v_book_date,
      'Afschrijving ' || coalesce(v_asset.asset_number, v_asset.name),
      'asset_depreciation', p_asset_id, v_lines, p_created_by
    );
    update public.asset_depreciations
    set status = 'posted', journal_entry_id = v_entry.id, posted_at = now()
    where id = r.id;
  end loop;

  select count(*) into v_remaining from public.asset_depreciations
  where asset_id = p_asset_id and status = 'scheduled';
  if v_remaining = 0 then
    update public.fixed_assets set status = 'fully_depreciated' where id = p_asset_id and status = 'active';
  end if;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;
revoke all on function public.post_asset_depreciation(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.post_asset_depreciation(uuid, uuid, date, uuid) to authenticated, service_role;
CREATE OR REPLACE FUNCTION public.generate_depreciation_schedule(p_organization_id uuid, p_asset_id uuid)
 RETURNS SETOF asset_depreciations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_base bigint;
  v_n integer;
  v_monthly bigint;
  v_remainder bigint;
  v_i integer;
  v_amount bigint;
  v_accum bigint := 0;
  v_period_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  -- TOEGEVOEGD (20261104000000): geen nieuw schema voor een afgestoten activum.
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten; een nieuw afschrijvingsschema kan niet meer.' using errcode = '23514';
  end if;

  v_n := v_asset.useful_life_months;
  if v_n <= 0 then
    raise exception 'Ongeldige gebruiksduur.' using errcode = '23514';
  end if;
  v_base := greatest(v_asset.acquisition_cost_cents - v_asset.residual_value_cents, 0);
  v_monthly := v_base / v_n;                 -- gehele centen (afkap)
  v_remainder := v_base - v_monthly * v_n;   -- 0 .. v_n-1 cent restant

  -- Verwijder alleen de nog niet geboekte regels; geboekte regels zijn onveranderbaar.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';

  for v_i in 1..v_n loop
    -- Restant over de eerste periodes verdelen (elk +1 cent) → som exact v_base.
    v_amount := v_monthly + case when v_i <= v_remainder then 1 else 0 end;
    if v_amount <= 0 then
      continue;                              -- geen nul-regels (bv. nul-basis)
    end if;
    v_accum := v_accum + v_amount;
    v_period_date := (v_asset.start_date + ((v_i - 1) || ' months')::interval)::date;

    -- Bestaat er al een geboekte regel voor deze periode, laat die staan.
    if exists (select 1 from public.asset_depreciations where asset_id = p_asset_id and period_index = v_i and status = 'posted') then
      continue;
    end if;

    insert into public.asset_depreciations(
      organization_id, asset_id, period_index, year, month, date,
      amount_cents, accumulated_after_cents, book_value_after_cents, status
    ) values (
      p_organization_id, p_asset_id, v_i,
      extract(year from v_period_date)::int, extract(month from v_period_date)::smallint, v_period_date,
      v_amount, v_accum, v_asset.acquisition_cost_cents - v_accum, 'scheduled'
    );
  end loop;

  return query select * from public.asset_depreciations where asset_id = p_asset_id order by period_index;
end;
$function$;
revoke all on function public.generate_depreciation_schedule(uuid, uuid) from public, anon;
grant execute on function public.generate_depreciation_schedule(uuid, uuid) to authenticated, service_role;
CREATE OR REPLACE FUNCTION public.book_asset_disposal(p_organization_id uuid, p_asset_id uuid, p_counter_account_id uuid, p_proceeds_cents bigint DEFAULT 0, p_disposal_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_accumulated bigint;
  v_book_value bigint;
  v_proceeds bigint := greatest(coalesce(p_proceeds_cents, 0), 0);
  v_result bigint;                 -- opbrengst − boekwaarde (winst > 0, verlies < 0)
  v_result_account uuid;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_disposal_date date;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is al afgestoten.' using errcode = '23514';
  end if;
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'De aanschaf van dit activum staat nog niet in het grootboek; boek die eerst.' using errcode = '23514';
  end if;
  if p_counter_account_id is null then
    raise exception 'Kies een tegenrekening voor de opbrengst (bank/debiteuren, of dezelfde als geen opbrengst).' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  -- Zelfvoorzienend: zorg dat het boekresultaat-rekeningnummer bestaat.
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
  values (p_organization_id, '4950', 'Boekresultaat vaste activa', 'expense', 'asset_disposal_result', true)
  on conflict (organization_id, code) do nothing;

  v_disposal_date := coalesce(p_disposal_date, current_date);

  -- Opgebouwde afschrijving = som van de GEBOEKTE afschrijvingen van dit activum.
  select coalesce(sum(amount_cents), 0) into v_accumulated
  from public.asset_depreciations
  where asset_id = p_asset_id and status = 'posted';

  v_book_value := v_asset.acquisition_cost_cents - v_accumulated;
  v_result := v_proceeds - v_book_value;

  -- a) Aanschafwaarde van de balans halen (credit activarekening).
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_asset.asset_account_id, 'description', 'Afboeken aanschaf ' || v_asset.name,
    'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents));

  -- b) Opgebouwde afschrijving terugnemen (debet cumulatieve-afschrijvingrekening).
  if v_accumulated <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_asset.accumulated_depreciation_account_id, 'description', 'Afboeken cum. afschrijving ' || v_asset.name,
      'debit_cents', v_accumulated, 'credit_cents', 0));
  end if;

  -- c) Opbrengst (debet tegenrekening: bank/debiteuren).
  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', p_counter_account_id, 'description', 'Opbrengst verkoop ' || v_asset.name,
      'debit_cents', v_proceeds, 'credit_cents', 0));
  end if;

  -- d) Boekwinst (credit) of boekverlies (debet) als sluitpost op 4950.
  if v_result <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, '4950');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', case when v_result > 0 then 'Boekwinst' else 'Boekverlies' end || ' verkoop ' || v_asset.name,
      'debit_cents', case when v_result < 0 then -v_result else 0 end,
      'credit_cents', case when v_result > 0 then v_result else 0 end));
  end if;

  v_book_date := public.first_open_booking_date_for(p_organization_id, v_disposal_date, public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Desinvestering ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_disposal', p_asset_id, v_lines, p_created_by);

  -- Resterende geplande afschrijvingen vervallen; activum op 'disposed'.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';
  update public.fixed_assets
  set status = 'disposed', disposal_date = v_disposal_date, disposal_proceeds_cents = v_proceeds
  where id = p_asset_id;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;
revoke all on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid) from public, anon;
grant execute on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid) to authenticated, service_role;
CREATE OR REPLACE FUNCTION public.book_asset_acquisition(p_organization_id uuid, p_asset_id uuid, p_credit_account_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_entry public.journal_entries;
  v_lines jsonb;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.acquisition_journal_entry_id is not null then
    raise exception 'De aanschaf van dit activum is al geboekt.' using errcode = '23514';
  end if;
  if v_asset.acquisition_cost_cents <= 0 then
    raise exception 'De aanschafwaarde moet groter zijn dan nul.' using errcode = '23514';
  end if;
  if p_credit_account_id = v_asset.asset_account_id then
    raise exception 'De tegenrekening mag niet gelijk zijn aan de activarekening.' using errcode = '23514';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_asset.asset_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', v_asset.acquisition_cost_cents, 'credit_cents', 0
    ),
    jsonb_build_object(
      'account_id', p_credit_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents
    )
  );

  v_book_date := public.first_open_booking_date_for(p_organization_id, coalesce(p_date, v_asset.acquisition_date), public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Aanschaf ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_acquisition', p_asset_id, v_lines, p_created_by
  );

  update public.fixed_assets set acquisition_journal_entry_id = v_entry.id where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;
revoke all on function public.book_asset_acquisition(uuid, uuid, uuid, date, uuid) from public, anon;
grant execute on function public.book_asset_acquisition(uuid, uuid, uuid, date, uuid) to authenticated, service_role;

commit;
