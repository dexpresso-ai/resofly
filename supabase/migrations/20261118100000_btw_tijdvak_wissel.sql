-- Btw: wisselen van aangiftetijdvak (kwartaal ↔ maand) zonder heen en weer.
--
-- Aanleiding: 20261118090000 liet finalize_vat_return alleen nog tijdvakken
-- afsluiten in de frequentie van Instellingen, en de jaarafsluiting eiste al
-- alleen die frequentie. Zet de Belastingdienst je per 1 januari op
-- maandaangifte (of jij vraagt dat aan, bijvoorbeeld om btw sneller terug te
-- krijgen), dan zet je dat bij Instellingen om. Daarna:
--   - kon je de aangifte over Q4 van het jaar ervoor niet meer afsluiten;
--   - kwam dat jaar niet meer dicht: de jaarafsluiting vroeg twaalf maanden;
--   - toonde het dashboard alle kwartalen van dat jaar als niet aangegeven.
-- Je moest de instelling dus heen en weer zetten.
--
-- Wat hier verandert:
--   1. finalize_vat_return: de frequentie van Instellingen, of de soort waarin
--      dat jaar al aangifte is gedaan. Een losse maand in een kwartaaljaar
--      blijft geweigerd.
--   2. close_fiscal_year: elke maand van het boekjaar moet in een afgesloten
--      maand of kwartaal vallen, wat de frequentie nu ook is.
--   3. list_filed_vat_periods: een concept telt niet als aangifte.
-- Het dashboard (src/lib/vatPeriods.ts) en de pagina Omzetbelasting volgen
-- dezelfde regel. Zie docs/changelog/CHANGELOG_EENMANSZAAK_CONTROLE_2026-11-18.md.
--
-- Veilig om opnieuw te draaien: alleen create or replace en rechten.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Btw-aangifte afsluiten: ook in de soort van dat jaar
-- ═══════════════════════════════════════════════════════════════════════════
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
  v_frequency text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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

  -- TOEGEVOEGD (20261118090000): een tijdvak dat nog loopt, sluit je niet af.
  -- De pagina opent op het lopende kwartaal en de knop stond aan: wie op
  -- 17 november Q4 afsloot, zag een factuur van 15 december op 1 januari
  -- geboekt worden. Die omzet viel zo in het verkeerde jaar (de winst voor de
  -- inkomstenbelasting) en de btw een kwartaal te laat in de aangifte. De
  -- Belastingdienst neemt de aangifte ook pas na afloop van het tijdvak aan.
  if v_expected_to >= current_date then
    raise exception 'Dit tijdvak loopt nog tot en met %. Afsluiten kan vanaf %, net als de aangifte bij de Belastingdienst.',
      to_char(v_expected_to, 'DD-MM-YYYY'), to_char(v_expected_to + 1, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261118090000): alleen in de frequentie die bij Instellingen
  -- staat. Wie per kwartaal aangifte doet en toch januari afsloot, kon Q1 daarna
  -- niet meer afsluiten (overlap).
  -- GEWIJZIGD (20261118100000): of in de soort waarin dat jaar al aangifte is
  -- gedaan. Zet de Belastingdienst je per 1 januari op maandaangifte, dan zet
  -- je dat bij Instellingen om en doe je in januari nog de aangifte over Q4.
  -- Die weigerde 20261118090000: je moest de instelling heen en weer zetten.
  -- Een losse maand in een jaar dat per kwartaal gaat, blijft geweigerd.
  select coalesce(cs.vat_return_period, 'quarterly') into v_frequency
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_frequency := coalesce(v_frequency, 'quarterly');
  if (v_frequency = 'monthly') <> (p_period_type = 'month')
     and not exists (
       select 1 from public.vat_returns vr
       where vr.organization_id = p_organization_id
         and vr.supplements_return_id is null
         and vr.status <> 'draft'
         and vr.year = p_year
         and vr.period_type = p_period_type
     ) then
    raise exception 'Je doet btw-aangifte per % (Instellingen → Bedrijf), en in % deed je nog geen aangifte per %. Moet dit tijdvak toch per % (bijvoorbeeld het laatste tijdvak vóór een wissel), zet de instelling dan eerst om.',
      case when v_frequency = 'monthly' then 'maand' else 'kwartaal' end,
      p_year,
      case when p_period_type = 'month' then 'maand' else 'kwartaal' end,
      case when p_period_type = 'month' then 'maand' else 'kwartaal' end
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Jaarafsluiting: elke maand in een afgesloten maand of kwartaal
-- ═══════════════════════════════════════════════════════════════════════════
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
  v_regime text;
  v_year_period text;
  v_partnership boolean := false;
  v_share_total integer := 0;
  v_capital uuid;
  s record;
  v_open_dep integer := 0;
  v_open_dep_names text;
  v_open_prepaid integer := 0;
  v_open_prepaid_names text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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
      -- GEWIJZIGD (20261118090000): een beginbalans van vóór het eerste
      -- boekjaar (per 31-12) is geen boekjaar dat nog dicht moet. Die liet het
      -- eerste jaar nooit afsluiten: "sluit eerst het voorgaande boekjaar af",
      -- terwijl er geen voorgaand boekjaar bestond.
      and je.source_type not in ('year_close', 'opening_balance')
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
    -- GEWIJZIGD (20261118100000): elke maand die het boekjaar overlapt, valt in
    -- een afgesloten aangifte: die van de maand zelf, of die van het hele
    -- kwartaal eromheen. Hier telde alleen de frequentie van nu. Wie per
    -- 1 januari per maand aangifte ging doen en dat bij Instellingen omzette,
    -- kreeg het jaar ervoor (per kwartaal aangegeven) zo nooit meer dicht.
    -- Alleen precies een kalendermaand of -kwartaal telt, zoals
    -- finalize_vat_return ze vastlegt; een maand telt niet voor zijn kwartaal.
    --
    -- De melding noemt het ontbrekende tijdvak zoals dat jaar aangegeven werd:
    -- alleen kwartalen of alleen maanden, en anders de frequentie van nu.
    select case
             when bool_or(cp.period_type = 'quarter') and not bool_or(cp.period_type = 'month') then 'quarterly'
             when bool_or(cp.period_type = 'month') and not bool_or(cp.period_type = 'quarter') then 'monthly'
           end
      into v_year_period
    from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_end >= v_fy.period_start and cp.period_start <= v_fy.period_end;
    v_year_period := coalesce(v_year_period, v_vat_period);

    v_cursor := date_trunc('month', v_fy.period_start)::date;
    while v_cursor <= v_fy.period_end loop
      if not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and (
            (cp.period_type = 'month'
              and cp.period_start = v_cursor
              and cp.period_end = (v_cursor + interval '1 month' - interval '1 day')::date)
            or (cp.period_type = 'quarter'
              and cp.period_start = date_trunc('quarter', v_cursor)::date
              and cp.period_end = (date_trunc('quarter', v_cursor) + interval '3 months' - interval '1 day')::date)
          )
      ) then
        v_p_start := date_trunc(case when v_year_period = 'monthly' then 'month' else 'quarter' end, v_cursor)::date;
        v_p_end := (v_p_start + case when v_year_period = 'monthly' then interval '1 month' else interval '3 months' end - interval '1 day')::date;
        raise exception 'Finaliseer eerst alle BTW-aangiften van dit boekjaar (ontbreekt de periode % t/m %).',
          to_char(v_p_start, 'DD-MM-YYYY'), to_char(v_p_end, 'DD-MM-YYYY')
          using errcode = '23514';
      end if;
      v_cursor := (v_cursor + interval '1 month')::date;
    end loop;
  end if;

  -- TOEGEVOEGD (20261118090000): afschrijvingen en termijnen van
  -- vooruitbetaalde kosten die in dit jaar vallen, horen erin vóór het slot.
  -- Daarna boekten ze stil op de eerste open dag van het volgende jaar: een
  -- laptop die t/m september was afgeschreven, kreeg oktober t/m december in
  -- het nieuwe jaar. De winst van beide jaren klopte dan niet.
  select count(*), string_agg(distinct fa.name, ', ')
    into v_open_dep, v_open_dep_names
  from public.asset_depreciations ad
  join public.fixed_assets fa on fa.id = ad.asset_id
  where ad.organization_id = p_organization_id
    and ad.status = 'scheduled'
    and ad.date <= v_fy.period_end
    and fa.acquisition_journal_entry_id is not null
    and fa.status <> 'disposed';
  if coalesce(v_open_dep, 0) > 0 then
    raise exception 'Er staan nog % afschrijvingstermijn(en) tot en met % klaar die niet geboekt zijn (%). Boek ze eerst bij Activa; anders komen ze in het volgende jaar en klopt de winst van beide jaren niet.',
      v_open_dep, to_char(v_fy.period_end, 'DD-MM-YYYY'), v_open_dep_names
      using errcode = '23514';
  end if;
  select count(*), string_agg(distinct pe.description, ', ')
    into v_open_prepaid, v_open_prepaid_names
  from public.prepaid_expense_releases pr
  join public.prepaid_expenses pe on pe.id = pr.prepaid_expense_id
  where pr.organization_id = p_organization_id
    and pr.status = 'scheduled'
    and pr.date <= v_fy.period_end
    and pe.start_journal_entry_id is not null;
  if coalesce(v_open_prepaid, 0) > 0 then
    raise exception 'Er staan nog % termijn(en) van vooruitbetaalde kosten tot en met % klaar die niet geboekt zijn (%). Boek ze eerst bij Vooruitbetaald; anders komen ze in het volgende jaar.',
      v_open_prepaid, to_char(v_fy.period_end, 'DD-MM-YYYY'), v_open_prepaid_names
      using errcode = '23514';
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

  -- TOEGEVOEGD (20261104070000): bij een vof, maatschap of cv met vastgelegde
  -- vennoten is de winst van de vennoten. Het resultaat gaat dan naar hun
  -- kapitaalrekeningen, volgens de winstverdeling, tot op de cent sluitend.
  v_regime := public.org_fiscal_regime(p_organization_id);
  v_partnership := v_regime = 'ib'
    and public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
    and exists (
      select 1 from public.partnership_partners pp
      where pp.organization_id = p_organization_id and pp.is_active
    );

  if v_partnership then
    select coalesce(sum(pp.profit_share_basis_points), 0)::int into v_share_total
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active;
    if v_share_total <> 10000 then
      raise exception 'De winstverdeling van de vennoten telt op tot % procent; dat moet precies 100 procent zijn. Pas de verdeling aan bij Financiën → Vennoten.',
        replace(rtrim(to_char(v_share_total / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
    end if;

    if v_result_cents <> 0 then
      for s in select * from public.partnership_result_shares(p_organization_id, v_result_cents) loop
        if s.share_cents > 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', s.capital_account_id,
            'description', 'Winstaandeel ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', 0, 'credit_cents', s.share_cents));
        elsif s.share_cents < 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', s.capital_account_id,
            'description', 'Verliesaandeel ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', -s.share_cents, 'credit_cents', 0));
        end if;
      end loop;
    end if;

    -- Het privé van elke vennoot (ook een vertrokken vennoot) gaat naar zijn
    -- eigen kapitaal.
    for s in
      select pp.name, pp.capital_account_id, acc.account_id, acc.label,
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from public.journal_lines jl
              join public.journal_entries je on je.id = jl.entry_id
              where jl.organization_id = p_organization_id
                and je.status = 'posted'
                and je.date <= v_fy.period_end
                and jl.account_id = acc.account_id)::bigint as bal
      from public.partnership_partners pp
      cross join lateral (values
        (pp.withdrawals_account_id, 'Privé-opnamen'),
        (pp.contributions_account_id, 'Privé-stortingen')
      ) as acc(account_id, label)
      where pp.organization_id = p_organization_id
      order by pp.partner_number, acc.label
    loop
      if s.bal <> 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', s.account_id,
            'description', s.label || ' ' || s.name || ' naar kapitaal',
            'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
          jsonb_build_object('account_id', s.capital_account_id,
            'description', s.label || ' ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
      end if;
    end loop;
  elsif v_result_cents <> 0 then
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

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen van een
  -- IB-onderneming (0550/0560, herkend aan het subtype) gaan naar het eigen
  -- vermogen. Bij een vof met vennoten staat hier alleen wat niet op de
  -- privérekening van een vennoot is geboekt; dat komt op 0500 en blijft in
  -- het overzicht als "nog niet aan een vennoot toegewezen" zichtbaar.
  if v_regime = 'ib' then
    v_capital := public.bookkeeping_account_id(p_organization_id, '0500');
    for s in
      select la.id as account_id, la.name,
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from public.journal_lines jl
              join public.journal_entries je on je.id = jl.entry_id
              where jl.organization_id = p_organization_id
                and je.status = 'posted'
                and je.date <= v_fy.period_end
                and jl.account_id = la.id)::bigint as bal
      from public.ledger_accounts la
      where la.organization_id = p_organization_id
        and la.subtype in ('private_withdrawals', 'private_contributions')
      order by la.code
    loop
      if s.bal <> 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', s.account_id,
            'description', s.name || ' naar eigen vermogen',
            'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
          jsonb_build_object('account_id', v_capital,
            'description', s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
      end if;
    end loop;
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
      result_account_code = case when v_partnership then 'vennoten' else v_result_code end,
      result_cents = v_result_cents,
      closed_at = now(), closed_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Aangegeven tijdvakken (dashboard): geen concepten
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.list_filed_vat_periods(p_organization_id uuid)
returns table(period_type text, year integer, period_index integer)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  return query
    select vr.period_type::text, vr.year::integer, vr.period_index::integer
    from public.vat_returns vr
    where vr.organization_id = p_organization_id
      and vr.supplements_return_id is null
      -- TOEGEVOEGD (20261118100000): een concept is geen aangifte, net als in
      -- finalize_vat_return.
      and vr.status <> 'draft'
      and vr.year >= extract(year from current_date)::integer - 2;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rechten
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Gelijk aan 20261118090000: de RPC's voor ingelogde gebruikers (die
-- controleren zelf de rechten op organisatie en module), niet voor anon.
revoke all on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) from public, anon;
grant execute on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) to authenticated, service_role;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.list_filed_vat_periods(uuid) from public, anon;
grant execute on function public.list_filed_vat_periods(uuid) to authenticated, service_role;
