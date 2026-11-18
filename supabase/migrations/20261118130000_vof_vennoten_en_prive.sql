-- ============================================================
-- ResoFly — Vennoten: het urencriterium per vennoot, en privé dat altijd sluit
-- Date: 2026-11-17
--
-- Vervolg op 20261104070000 (privé en vennoten). Twee dingen klopten nog niet:
--
--   1. HET URENCRITERIUM TELDE PER GEBRUIKER, NIET PER VENNOOT. Het
--      urencriterium (1225 uur per kalenderjaar) geldt per vennoot. ResoFly
--      telde alleen de uren van wie was ingelogd: een vennoot hing niet aan een
--      teamlid, en nergens stonden de uren van de vennoten bij elkaar. Wie de
--      administratie bijhield, kon dus niet zien of een vennoot de ondernemers-
--      aftrek haalt. Nu kan een vennoot aan een teamlid hangen
--      (partnership_partners.user_id, via set_partnership_partner_member), en
--      geeft partnership_partner_hours per vennoot zijn uren van een
--      kalenderjaar: direct, indirect en de eerste geregistreerde dag.
--   2. HET PRIVÉ VAN EEN VENNOOT BLEEF OPEN STAAN. De jaarafsluiting zette het
--      privé van een vennoot (055n, 056n) alleen naar zijn kapitaal zolang de
--      administratie een vof, maatschap of cv met actieve vennoten was. Werd de
--      rechtsvorm eenmanszaak, of stond elke vennoot op uitgetreden, dan bleven
--      die rekeningen staan en schoven ze ongemerkt mee naar het volgende jaar.
--      In de kapitaalvergelijking telden ze dan als "overig" in plaats van als
--      opname of storting. Nu gaat het privé van elke vennoot bij elke
--      jaarafsluiting naar zijn eigen kapitaal, en telt de kapitaalvergelijking
--      het als opname of storting.
--
--   3. EEN INKOOPFACTUUR DIE PRIVÉ IS BETAALD. Bij een vof betaalt een vennoot
--      een zakelijke factuur nogal eens met zijn eigen pas. Een inkoopfactuur
--      gold alleen als betaald via een bankboeking: de factuur bleef voorgoed
--      open staan (en kwam terug als kandidaat bij elke bankbetaling), 1600
--      Crediteuren ook, en de uitgave stond niet op het privé van de vennoot.
--      Nu boekt pay_purchase_invoice_privately 1600 tegen de privé-stortingen
--      van die vennoot (056n), of 0560 bij een eenmanszaak, en staat de factuur
--      op betaald. Tegenboeken van die betaling zet hem weer open.
--   4. OPENSTAANDE POSTEN. report_open_items telt een privébetaling als
--      betaald (anders stond de factuur bij Openstaand → Crediteuren).
--   5. GEEN GEBROKEN BOEKJAAR BIJ EEN IB-ONDERNEMING. Voor de
--      inkomstenbelasting is het boekjaar het kalenderjaar. open_fiscal_year
--      weigert een boekjaar over twee kalenderjaren, en de startmaand blijft
--      januari.
--   6. GEEN BTW OP PRIVÉ OF KAPITAAL. Bij de bank bleef de btw-code staan als
--      je naar een privérekening wisselde: een privé-opname gaf zo
--      voorbelasting. Een bankverdeling en een bankregel op een
--      eigen-vermogensrekening krijgen geen btw-code meer.
--   7. 0550 EN 0560 NAAST DE VENNOTEN. Bij een vof met vennoten heten ze nu
--      "(geen vennoot)": wie daar boekt, boekt op niemand.
--
-- De verdeling zelf verandert niet. Die wordt sinds deze migratie bewaakt door
-- tests/database/vennoten_jaarafsluiting.sql en tests/database/vof_administratie.sql,
-- die in CI op een lege database draaien (job migrations in frontend-checks.yml).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Een vennoot aan een teamlid koppelen ────────────────────────────────
alter table public.partnership_partners
  add column if not exists user_id uuid references auth.users(id) on delete set null;

comment on column public.partnership_partners.user_id is
  'Het teamlid dat deze vennoot is. Zijn uren tellen voor het urencriterium van de vennoot. Leeg: niet gekoppeld. Schrijven alleen via set_partnership_partner_member.';

-- Eén teamlid is hooguit één vennoot: anders telden dezelfde uren voor twee.
create unique index if not exists partnership_partners_org_user_key
  on public.partnership_partners(organization_id, user_id)
  where user_id is not null;

create or replace function public.set_partnership_partner_member(
  p_organization_id uuid,
  p_partner_id uuid,
  p_user_id uuid
)
returns public.partnership_partners
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.partnership_partners;
  v_legal text;
  v_role text;
  v_other text;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;

  v_legal := public.org_legal_form(p_organization_id);
  if v_legal not in ('vof', 'maatschap', 'cv') then
    raise exception 'Vennoten horen bij een vof, maatschap of cv; deze administratie staat als % ingesteld.', v_legal
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vennoten'));

  select * into v_row
  from public.partnership_partners pp
  where pp.id = p_partner_id and pp.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vennoot niet gevonden.' using errcode = '02000';
  end if;

  if p_user_id is not null then
    -- Alleen een actief teamlid van déze organisatie: een id van buiten zou
    -- de uren van een vreemde bij een vennoot optellen.
    select m.role into v_role
    from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active';
    if v_role is null then
      raise exception 'Dit teamlid hoort niet (meer) bij deze organisatie.' using errcode = '23514';
    end if;
    -- De boekhouder van buiten registreert geen eigen uren voor de onderneming.
    if v_role = 'accountant' then
      raise exception 'De boekhouder kun je niet aan een vennoot koppelen. Kies het teamlid dat de vennoot zelf is.'
        using errcode = '23514';
    end if;
    select pp.name into v_other
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.user_id = p_user_id and pp.id <> v_row.id;
    if v_other is not null then
      raise exception 'Dit teamlid is al gekoppeld aan vennoot %. Een teamlid hoort bij één vennoot.', v_other
        using errcode = '23514';
    end if;
  end if;

  update public.partnership_partners
  set user_id = p_user_id
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- ── 2. De uren per vennoot in een kalenderjaar ─────────────────────────────
-- Het urencriterium loopt over het kalenderjaar, niet over het boekjaar, en telt
-- directe en indirecte uren (administratie, acquisitie, reistijd, scholing),
-- declarabel of niet. Zoals de teller bij Uren, maar dan per vennoot.
-- Vraagt leesrecht op Financiën (de vennoten) én op Uren (de uren): wie Uren
-- niet mag lezen, krijgt hier ook geen uren van anderen.
create or replace function public.partnership_partner_hours(p_organization_id uuid, p_year integer)
returns table(partner_id uuid, user_id uuid, direct_minutes bigint, indirect_minutes bigint, first_entry_date date)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id)
              and public.can_read_module(p_organization_id, 'finance')
              and public.can_read_module(p_organization_id, 'time')) then
    raise exception 'Geen leesrechten voor de vennoten en de uren van deze organisatie.' using errcode = '42501';
  end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then
    raise exception 'Kies een kalenderjaar.' using errcode = '22023';
  end if;

  return query
  select pp.id, pp.user_id,
         coalesce(sum(te.minutes) filter (where te.entry_type is distinct from 'indirect'), 0)::bigint,
         coalesce(sum(te.minutes) filter (where te.entry_type = 'indirect'), 0)::bigint,
         min(te.entry_date)
  from public.partnership_partners pp
  left join public.time_entries te
    on te.organization_id = p_organization_id
   and te.user_id = pp.user_id
   and te.entry_date between make_date(p_year, 1, 1) and make_date(p_year, 12, 31)
  where pp.organization_id = p_organization_id
  group by pp.id, pp.user_id, pp.partner_number
  order by pp.partner_number;
end;
$$;

-- ── 3. Jaarafsluiting: het privé van elke vennoot naar zijn eigen kapitaal ──
-- Gelijk aan 20261118100000 (de versie op staging), op één plek na: zie
-- GEWIJZIGD (20261118130000).
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

  -- Het privé van elke vennoot (ook een vertrokken vennoot) gaat naar zijn
  -- eigen kapitaal.
  -- GEWIJZIGD (20261118130000): altijd, niet alleen bij een vof, maatschap of
  -- cv met actieve vennoten. Werd de rechtsvorm eenmanszaak, of stond elke
  -- vennoot op uitgetreden, dan bleven 055n en 056n open staan en schoven ze
  -- mee naar het volgende jaar. Het privé hoort bij de vennoot, welke
  -- rechtsvorm de administratie nu ook heeft; het resultaat volgt die wel.
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

-- ── 4. De kapitaalvergelijking: privé van vennoten telt als privé ──────────
-- Gelijk aan 20261118090000 (de versie op staging), op één plek na: zie
-- GEWIJZIGD (20261118130000).
create or replace function public.owners_equity_overview(p_organization_id uuid, p_fiscal_year_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_fy public.fiscal_years;
  v_legal text;
  v_partnership boolean;
  v_partners_defined boolean;
  v_result bigint := 0;
  v_share_total integer := 0;
  v_owners jsonb := '[]'::jsonb;
  v_unassigned jsonb := null;
  v_partner_accounts uuid[] := '{}';
  v_begin bigint;
  v_contrib bigint;
  v_withdraw bigint;
  v_other bigint;
  v_name text;
  v_open_prior bigint := 0;
  v_open_years jsonb := '[]'::jsonb;
  r record;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'ib' then
    raise exception 'Dit overzicht hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.'
      using errcode = '23514';
  end if;

  v_legal := public.org_legal_form(p_organization_id);
  v_partners_defined := exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id);
  v_partnership := v_legal in ('vof', 'maatschap', 'cv')
    and exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id and pp.is_active);

  -- Resultaat van het boekjaar: de W&V zonder de jaarafsluiting.
  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_result
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_fy.period_start and v_fy.period_end
    and la.type in ('revenue', 'expense');

  -- TOEGEVOEGD (20261118090000): de winst van eerdere jaren die nog niet naar
  -- het eigen vermogen is gegaan (het jaar is niet afgesloten). Mét de
  -- jaarafsluitingen: daarin vallen omzet en kosten van een dicht jaar weg.
  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_open_prior
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date < v_fy.period_start
    and la.type in ('revenue', 'expense');

  select coalesce(jsonb_agg(f.label order by f.period_start), '[]'::jsonb)
  into v_open_years
  from public.fiscal_years f
  where f.organization_id = p_organization_id
    and f.status <> 'closed'
    and f.period_end < v_fy.period_start;

  if v_partnership then
    select coalesce(sum(pp.profit_share_basis_points), 0)::int into v_share_total
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active;

    for r in
      select pp.id, pp.name, pp.partner_number, pp.profit_share_basis_points, pp.kind, pp.is_active,
             pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id,
             coalesce(sh.share_cents, 0)::bigint as share_cents
      from public.partnership_partners pp
      left join public.partnership_result_shares(p_organization_id, v_result) sh on sh.partner_id = pp.id
      where pp.organization_id = p_organization_id
      order by pp.partner_number
    loop
      v_partner_accounts := v_partner_accounts || array[r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id];

      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and jl.account_id in (r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id)
        and (je.date < v_fy.period_start
             or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end));

      select
        coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where jl.account_id = r.contributions_account_id), 0)::bigint,
        coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where jl.account_id = r.withdrawals_account_id), 0)::bigint,
        coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where jl.account_id = r.capital_account_id), 0)::bigint
      into v_contrib, v_withdraw, v_other
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.source_type not in ('year_close', 'opening_balance')
        and je.date between v_fy.period_start and v_fy.period_end
        and jl.account_id in (r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id);

      v_owners := v_owners || jsonb_build_array(jsonb_build_object(
        'partnerId', r.id,
        'name', r.name,
        'partnerNumber', r.partner_number,
        'kind', r.kind,
        'isActive', r.is_active,
        'shareBasisPoints', r.profit_share_basis_points,
        'beginCents', v_begin,
        'resultShareCents', r.share_cents,
        'contributionsCents', v_contrib,
        'withdrawalsCents', v_withdraw,
        'otherMovementsCents', v_other,
        'endCents', v_begin + r.share_cents + v_contrib - v_withdraw + v_other
      ));
    end loop;

    -- Wat op geen enkele vennoot staat (0500, 0510, 0550/0560, ...).
    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where je.date < v_fy.period_start
           or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end)), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where je.source_type not in ('year_close', 'opening_balance')
          and je.date between v_fy.period_start and v_fy.period_end), 0)::bigint
    into v_begin, v_other
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and la.type = 'equity'
      and not (jl.account_id = any (v_partner_accounts));

    -- TOEGEVOEGD (20261118090000): de winst van een vorig jaar dat nog open
    -- is, is nog niet over de vennoten verdeeld; die staat hier tot dat jaar
    -- dicht is.
    v_begin := v_begin + v_open_prior;

    if v_begin <> 0 or v_other <> 0 then
      v_unassigned := jsonb_build_object(
        'beginCents', v_begin,
        'movementsCents', v_other,
        'endCents', v_begin + v_other
      );
    end if;
  else
    select coalesce(nullif(btrim(cs.company_name), ''), 'Ondernemer') into v_name
    from public.company_settings cs where cs.organization_id = p_organization_id;

    -- GEWIJZIGD (20261118090000): ook omzet en kosten van vóór de begindatum
    -- (zie de toelichting boven deze functie).
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        (je.date < v_fy.period_start and la.type in ('equity', 'revenue', 'expense'))
        or (la.type = 'equity' and je.source_type = 'opening_balance'
            and je.date between v_fy.period_start and v_fy.period_end)
      );

    -- GEWIJZIGD (20261118130000): ook het privé van (vroegere) vennoten telt als
    -- storting of opname. Zonder actieve vennoot, of na de overstap van een vof
    -- naar een eenmanszaak, stond een opname op 0551 hier als "overig".
    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where la.subtype in ('private_contributions', 'partner_contributions')), 0)::bigint,
      coalesce(sum(jl.debit_cents - jl.credit_cents) filter (
        where la.subtype in ('private_withdrawals', 'partner_withdrawals')), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where coalesce(la.subtype, '') not in ('private_contributions', 'private_withdrawals',
                                               'partner_contributions', 'partner_withdrawals')), 0)::bigint
    into v_contrib, v_withdraw, v_other
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type not in ('year_close', 'opening_balance')
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type = 'equity';

    v_owners := jsonb_build_array(jsonb_build_object(
      'partnerId', null,
      'name', coalesce(v_name, 'Ondernemer'),
      'partnerNumber', null,
      'kind', null,
      'isActive', true,
      'shareBasisPoints', 10000,
      'beginCents', v_begin,
      'resultShareCents', v_result,
      'contributionsCents', v_contrib,
      'withdrawalsCents', v_withdraw,
      'otherMovementsCents', v_other,
      'endCents', v_begin + v_result + v_contrib - v_withdraw + v_other
    ));
  end if;

  return jsonb_build_object(
    'fiscalYear', jsonb_build_object(
      'id', v_fy.id, 'label', v_fy.label, 'periodStart', v_fy.period_start,
      'periodEnd', v_fy.period_end, 'status', v_fy.status),
    'legalForm', v_legal,
    'isPartnershipForm', v_legal in ('vof', 'maatschap', 'cv'),
    'isPartnership', v_partnership,
    'partnersDefined', v_partners_defined,
    'shareTotalBasisPoints', case when v_partnership then v_share_total else null end,
    'resultCents', v_result,
    -- TOEGEVOEGD (20261118090000): voor de melding "2025 is nog niet afgesloten".
    'openPriorResultCents', v_open_prior,
    'openPriorYears', v_open_years,
    'owners', v_owners,
    'unassigned', v_unassigned
  );
end;
$function$;

-- ── 5. Een inkoopfactuur die privé is betaald ──────────────────────────────

-- Een eigen boekingssoort, zodat de betaling bij de factuur hoort: de lijst uit
-- 20261111220000, met purchase_private_payment erbij.
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation','corporate_tax','dga_interest','payroll','dividend',
    'prepaid_start','prepaid_release','prepaid_end',
    'purchase_private_payment'
  ));

-- Gelijk aan 20261107110000, met de privébetalingen erbij (TOEGEVOEGD).
create or replace function public.purchase_invoice_open_payable_cents(p_organization_id uuid, p_purchase_invoice_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce((
    select sum(jl.credit_cents - jl.debit_cents)
    from public.purchase_invoices pi
    join public.journal_entries je on je.id = pi.journal_entry_id and je.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where pi.id = p_purchase_invoice_id and pi.organization_id = p_organization_id
  ), 0)::bigint - coalesce((
    select sum(-a.amount_cents)
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    where a.organization_id = p_organization_id
      and a.purchase_invoice_id = p_purchase_invoice_id
      and a.kind = 'purchase_invoice'
  ), 0)::bigint - coalesce((
    -- TOEGEVOEGD (20261118130000): wat de ondernemer of een vennoot privé
    -- betaalde (pay_purchase_invoice_privately). Tegengeboekt telt niet.
    select sum(jl.debit_cents - jl.credit_cents)
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where je.organization_id = p_organization_id
      and je.source_type = 'purchase_private_payment'
      and je.source_id = p_purchase_invoice_id
      and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
  ), 0)::bigint;
$$;

-- Gelijk aan 20261107110000; de betaaldatum komt nu ook uit een privébetaling.
create or replace function public.refresh_purchase_invoice_payment_status(p_organization_id uuid, p_purchase_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_total bigint;
  v_open bigint;
  v_status text;
  v_paid_at timestamptz;
begin
  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id;
  if not found or v_pi.journal_entry_id is null then
    return;
  end if;

  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_total
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
  where jl.entry_id = v_pi.journal_entry_id;

  v_open := public.purchase_invoice_open_payable_cents(p_organization_id, p_purchase_invoice_id);
  v_status := case
    when v_total > 0 and v_open <= 0 then 'paid'
    when v_total < 0 and v_open >= 0 then 'paid'
    when v_total <> 0 and abs(v_open) < abs(v_total) then 'partially_paid'
    else 'unpaid'
  end;
  if v_status = 'paid' then
    select max(betaald)::timestamptz into v_paid_at
    from (
      select bt.booking_date as betaald
      from public.bank_transaction_allocations a
      join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
      join public.bank_transactions bt on bt.id = a.bank_transaction_id
      where a.organization_id = p_organization_id
        and a.purchase_invoice_id = p_purchase_invoice_id
      union all
      -- TOEGEVOEGD (20261118130000): de datum van een privébetaling.
      select je.date
      from public.journal_entries je
      where je.organization_id = p_organization_id
        and je.source_type = 'purchase_private_payment'
        and je.source_id = p_purchase_invoice_id
        and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    ) betalingen;
    v_paid_at := coalesce(v_paid_at, now());
  end if;

  update public.purchase_invoices
  set payment_status = v_status, paid_at = v_paid_at
  where id = p_purchase_invoice_id
    and (payment_status is distinct from v_status or paid_at is distinct from v_paid_at);
end;
$$;

create or replace function public.pay_purchase_invoice_privately(
  p_organization_id uuid,
  p_purchase_invoice_id uuid,
  p_partner_id uuid default null,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_partner public.partnership_partners;
  v_open bigint;
  v_private uuid;
  v_payable uuid;
  v_who text;
  v_ref text;
  v_date date;
  v_start date;
  v_entry public.journal_entries;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;
  -- Privé bestaat alleen bij een IB-onderneming. Betaalt bij een BV de dga een
  -- factuur, dan loopt dat via zijn rekening-courant.
  if public.org_fiscal_regime(p_organization_id) <> 'ib' then
    raise exception 'Privé betalen kan bij een eenmanszaak, vof, maatschap of cv. Bij een BV boek je een betaling door de dga op zijn rekening-courant.'
      using errcode = '23514';
  end if;

  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000';
  end if;
  if v_pi.journal_entry_id is null or v_pi.status = 'cancelled' then
    raise exception 'Boek de inkoopfactuur eerst; daarna kun je hem als privé betaald vastleggen.' using errcode = '23514';
  end if;
  v_open := public.purchase_invoice_open_payable_cents(p_organization_id, p_purchase_invoice_id);
  if v_open <= 0 then
    raise exception 'Op deze inkoopfactuur staat niets meer open.' using errcode = '23514';
  end if;

  if p_partner_id is not null then
    select * into v_partner from public.partnership_partners pp
    where pp.id = p_partner_id and pp.organization_id = p_organization_id;
    if not found then
      raise exception 'Vennoot niet gevonden.' using errcode = '02000';
    end if;
    v_private := v_partner.contributions_account_id;
    v_who := v_partner.name;
  else
    -- Bij een vof met vennoten hoort de betaling bij één vennoot: op 0560
    -- stond hij op niemand.
    if public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
       and exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id and pp.is_active) then
      raise exception 'Kies de vennoot die de factuur betaalde: het bedrag komt op zijn privé-stortingen.' using errcode = '23514';
    end if;
    perform public.ensure_default_ledger_accounts(p_organization_id);
    select la.id into v_private from public.ledger_accounts la
    where la.organization_id = p_organization_id and la.subtype = 'private_contributions'
    order by la.code limit 1;
    if v_private is null then
      raise exception 'Er is geen rekening voor privé-stortingen (0560).' using errcode = '23514';
    end if;
    v_who := 'de ondernemer';
  end if;

  v_date := coalesce(p_date, v_pi.date);
  select cs.bookkeeping_start_date into v_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start is not null and v_date < v_start then
    raise exception 'Je boekhouding in ResoFly begint op %. Kies een betaaldatum vanaf die dag.', to_char(v_start, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  if v_date > (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Een betaling ligt niet in de toekomst. Kies de dag waarop er betaald is.' using errcode = '23514';
  end if;

  select jl.account_id into v_payable
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
  where jl.entry_id = v_pi.journal_entry_id
  limit 1;
  v_payable := coalesce(v_payable, public.bookkeeping_account_id(p_organization_id, '1600'));

  v_ref := coalesce(nullif(btrim(v_pi.internal_number), ''), nullif(btrim(v_pi.supplier_invoice_number), ''), 'inkoopfactuur');
  v_entry := public.post_journal_entry(
    p_organization_id, v_date,
    'Privé betaald door ' || v_who || ': ' || v_ref,
    'purchase_private_payment', p_purchase_invoice_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_payable, 'description', 'Privé betaald: ' || v_ref,
        'debit_cents', v_open, 'credit_cents', 0, 'supplier_id', v_pi.supplier_id),
      jsonb_build_object('account_id', v_private, 'description', 'Privé betaald: ' || v_ref,
        'debit_cents', 0, 'credit_cents', v_open)
    ),
    p_created_by
  );

  perform public.refresh_purchase_invoice_payment_status(p_organization_id, p_purchase_invoice_id);
  return v_entry;
end;
$$;

-- Tegenboeken: een privébetaling terugdraaien zet de factuur weer open, en een
-- inkoopfactuur met een privébetaling erop boek je niet tegen (dan bleef die
-- betaling op 1600 staan zonder factuur ertegenover), net als bij een
-- bankbetaling (reverse_journal_entry, 20261107110000). Als trigger, zodat het
-- geldt welke weg het tegenboeken ook neemt.
create or replace function public.purchase_private_payment_on_reverse()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reversed_by_entry_id is null or old.reversed_by_entry_id is not null then
    return new;
  end if;
  if new.source_type = 'purchase_invoice' and new.source_id is not null and exists (
    select 1 from public.journal_entries p
    where p.organization_id = new.organization_id
      and p.source_type = 'purchase_private_payment'
      and p.source_id = new.source_id
      and p.status = 'posted'
      and p.reversed_by_entry_id is null and p.reverses_entry_id is null
  ) then
    raise exception 'Deze inkoopfactuur is privé betaald. Boek eerst die privébetaling tegen (Grootboek → Journaal); daarna de inkoopfactuur.'
      using errcode = '23514';
  end if;
  if new.source_type = 'purchase_private_payment' and new.source_id is not null then
    perform public.refresh_purchase_invoice_payment_status(new.organization_id, new.source_id);
  end if;
  return new;
end;
$$;

drop trigger if exists journal_entries_private_payment_reverse on public.journal_entries;
create trigger journal_entries_private_payment_reverse
  after update of reversed_by_entry_id on public.journal_entries
  for each row execute function public.purchase_private_payment_on_reverse();

-- ── 6. Openstaande posten: een privébetaling telt als betaald ──────────────
-- Gelijk aan 20261107110000, met de privébetalingen erbij (TOEGEVOEGD). Zonder
-- die tak stond een privé betaalde factuur bij Openstaand → Crediteuren, en
-- het bedrag op 1600 als "niet aan een factuur gekoppeld".
CREATE OR REPLACE FUNCTION public.report_open_items(p_organization_id uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_recv_rows jsonb;
  v_recv_open bigint;
  v_recv_matched bigint;
  v_recv_gl bigint;
  v_pay_rows jsonb;
  v_pay_open bigint;
  v_pay_matched bigint;
  v_pay_gl bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- ---------------- Debiteuren (1300) ----------------
  with ar_lines as (
    select je.source_type, je.source_id, jl.debit_cents, jl.credit_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.subtype = 'accounts_receivable'
  ),
  inv_booked as (
    select source_id as invoice_id, sum(debit_cents - credit_cents)::bigint as amt
    from ar_lines where source_type = 'sales_invoice' group by 1
  ),
  inv_credited as (
    select cn.invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.credit_notes cn on cn.organization_id = p_organization_id and cn.id = al.source_id
    where al.source_type = 'credit_note'
    group by 1
  ),
  inv_paid as (
    select a.invoice_id,
           sum(case when je.date <= p_as_of then a.amount_cents else 0 end
             - case when rev.status = 'posted' and rev.date <= p_as_of then a.amount_cents else 0 end)::bigint as amt
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
    left join public.journal_entries rev on rev.id = je.reversed_by_entry_id
    where a.organization_id = p_organization_id
      and a.kind in ('sales_invoice', 'sales_credit_note')
      and a.invoice_id is not null
    group by 1
  ),
  -- TOEGEVOEGD (20261104020000): Mollie-betalingen, -terugbetalingen en
  -- -chargebacks boeken met de factuur zelf als bron. Zonder deze tak stond
  -- elke via Mollie betaalde factuur voorgoed als openstaand in de lijst.
  inv_psp as (
    select i.id as invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.invoices i on i.organization_id = p_organization_id and i.id = al.source_id
    where al.source_type = 'payment'
    group by 1
  ),
  inv_rows as (
    select
      i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) + coalesce(pp.amt, 0) as paid_cents,
      coalesce(cr.amt, 0) as credited_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) - coalesce(pp.amt, 0) - coalesce(cr.amt, 0) as open_cents
    from public.invoices i
    left join inv_booked b on b.invoice_id = i.id
    left join inv_paid p on p.invoice_id = i.id
    left join inv_psp pp on pp.invoice_id = i.id
    left join inv_credited cr on cr.invoice_id = i.id
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0 or coalesce(pp.amt, 0) <> 0 or coalesce(cr.amt, 0) <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'client_id', r.client_id, 'client_name', r.client_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents,
      'credited_cents', r.credited_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0),
    coalesce(sum(r.booked_cents - r.paid_cents - r.credited_cents), 0),
    (select coalesce(sum(debit_cents - credit_cents), 0) from ar_lines)
  into v_recv_rows, v_recv_open, v_recv_matched, v_recv_gl
  from inv_rows r;

  -- ---------------- Crediteuren (1600) ----------------
  with ap_lines as (
    select je.source_type, je.source_id, jl.debit_cents, jl.credit_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.subtype = 'accounts_payable'
  ),
  pi_booked as (
    select source_id as pi_id, sum(credit_cents - debit_cents)::bigint as amt
    from ap_lines where source_type = 'purchase_invoice' group by 1
  ),
  pi_paid as (
    select a.purchase_invoice_id as pi_id,
           sum(case when je.date <= p_as_of then -a.amount_cents else 0 end
             - case when rev.status = 'posted' and rev.date <= p_as_of then -a.amount_cents else 0 end)::bigint as amt
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
    left join public.journal_entries rev on rev.id = je.reversed_by_entry_id
    where a.organization_id = p_organization_id
      and a.kind = 'purchase_invoice'
    group by 1
  ),
  -- TOEGEVOEGD (20261118130000): wat de ondernemer of een vennoot privé
  -- betaalde. Een tegenboeking heeft dezelfde bron en valt ertegen weg.
  pi_private as (
    select source_id as pi_id, sum(debit_cents - credit_cents)::bigint as amt
    from ap_lines where source_type = 'purchase_private_payment' group by 1
  ),
  pi_rows as (
    select
      pi.id, coalesce(pi.supplier_invoice_number, pi.internal_number) as number,
      pi.date, pi.due_date, pi.supplier_id, s.name as supplier_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) + coalesce(pv.amt, 0) as paid_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) - coalesce(pv.amt, 0) as open_cents
    from public.purchase_invoices pi
    left join pi_booked b on b.pi_id = pi.id
    left join pi_paid p on p.pi_id = pi.id
    left join pi_private pv on pv.pi_id = pi.id
    left join public.suppliers s on s.id = pi.supplier_id
    where pi.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0 or coalesce(pv.amt, 0) <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'purchase_invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'supplier_id', r.supplier_id, 'supplier_name', r.supplier_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0),
    coalesce(sum(r.booked_cents - r.paid_cents), 0),
    (select coalesce(sum(credit_cents - debit_cents), 0) from ap_lines)
  into v_pay_rows, v_pay_open, v_pay_matched, v_pay_gl
  from pi_rows r;

  return jsonb_build_object(
    'as_of', p_as_of,
    'receivables', jsonb_build_object(
      'rows', v_recv_rows,
      'open_total_cents', v_recv_open,
      'gl_balance_cents', v_recv_gl,
      -- Beweging op 1300 die niet aan een factuur toe te rekenen is
      -- (beginbalans, vrije boekingen): het gat tussen lijst en grootboek.
      'unmatched_cents', v_recv_gl - v_recv_matched
    ),
    'payables', jsonb_build_object(
      'rows', v_pay_rows,
      'open_total_cents', v_pay_open,
      'gl_balance_cents', v_pay_gl,
      'unmatched_cents', v_pay_gl - v_pay_matched
    )
  );
end;
$function$;

-- ── 7. Het boekjaar van een IB-onderneming is het kalenderjaar ─────────────
-- Voor de inkomstenbelasting is het boekjaar het kalenderjaar; alleen een
-- rechtspersoon kan een gebroken boekjaar hebben. De inrichting zette de
-- startmaand al op januari, maar daarna kon het overal anders: bij
-- Instellingen → Boekhouding, bij een nieuw boekjaar en via Gerrie en de API.
-- Een vof kreeg zo een boekjaar "2026/2027", dat niet past op de aangifte van
-- de vennoten. Een eerste of laatste boekjaar dat niet op 1 januari begint of
-- op 31 december eindigt, blijft kunnen (starten of stoppen in de loop van
-- het jaar), zolang het in één kalenderjaar valt.
-- Gelijk aan 20261106110000, met de controle erbij (TOEGEVOEGD).
CREATE OR REPLACE FUNCTION public.open_fiscal_year(p_organization_id uuid, p_period_start date, p_period_end date, p_label text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_label text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'De einddatum van het boekjaar moet na de begindatum liggen.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106110000): een boekjaar van vijf jaar (een tikfout in
  -- het jaartal) kon gewoon. De auditfile-export (XAF) van ResoFly verwerkt
  -- hooguit 36 maanden; een langer boekjaar is vrijwel zeker een vergissing.
  if p_period_end >= (p_period_start + interval '36 months')::date then
    raise exception 'Een boekjaar duurt in ResoFly hooguit 36 maanden. Kijk de begin- en einddatum na.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261118130000): bij een eenmanszaak, vof, maatschap of cv
  -- valt een boekjaar in één kalenderjaar.
  if public.org_fiscal_regime(p_organization_id) = 'ib'
     and extract(year from p_period_start) <> extract(year from p_period_end) then
    raise exception 'Bij een eenmanszaak, vof, maatschap of cv is het boekjaar het kalenderjaar: het begint en eindigt in hetzelfde jaar, meestal 1 januari t/m 31 december. Een gebroken boekjaar kan alleen bij een BV, NV of coöperatie.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106110000): eerst de grendel, dan de overlapcontrole.
  -- Twee verzoeken tegelijk (twee tabbladen) zagen elkaars boekjaar nog niet
  -- en konden zo twee overlappende boekjaren maken.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':boekjaren'));
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and daterange(f.period_start, f.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'Dit boekjaar overlapt met een bestaand boekjaar.' using errcode = '23514';
  end if;

  v_label := coalesce(nullif(btrim(p_label), ''),
    case when extract(year from p_period_start) = extract(year from p_period_end)
         then extract(year from p_period_start)::text
         else extract(year from p_period_start)::text || '/' || extract(year from p_period_end)::text end);

  insert into public.fiscal_years(organization_id, created_by, label, period_start, period_end, status)
  values (p_organization_id, p_created_by, v_label, p_period_start, p_period_end, 'open')
  returning * into v_fy;

  return v_fy;
end;
$function$;

-- De startmaand van het boekjaar staat bij een IB-onderneming op januari, ook
-- als iets anders hem probeert te veranderen: het scherm toont de keuze dan
-- niet, en Gerrie en de API weigeren vooraf. Dit is het vangnet.
create or replace function public.company_settings_ib_calendar_year()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.legal_form, 'eenmanszaak') in ('eenmanszaak', 'vof', 'maatschap', 'cv')
     and new.fiscal_year_start_month is not null and new.fiscal_year_start_month <> 1 then
    new.fiscal_year_start_month := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists company_settings_ib_calendar_year on public.company_settings;
create trigger company_settings_ib_calendar_year
  before insert or update of legal_form, fiscal_year_start_month on public.company_settings
  for each row execute function public.company_settings_ib_calendar_year();

update public.company_settings
set fiscal_year_start_month = 1
where coalesce(legal_form, 'eenmanszaak') in ('eenmanszaak', 'vof', 'maatschap', 'cv')
  and fiscal_year_start_month is not null and fiscal_year_start_month <> 1;

-- ── 8. Geen btw op privé of kapitaal ───────────────────────────────────────
-- Bij de bank hield een regel zijn btw-code als je van een kostenrekening naar
-- een privérekening wisselde. Een privé-opname van € 1.500 werd zo € 1.239,67
-- opname en € 260,33 voorbelasting: btw terugvragen over geld dat je voor
-- jezelf opnam. Hetzelfde kon met een bankregel die automatisch boekt, en via
-- Gerrie. Een eigen-vermogensrekening (privé, kapitaal) krijgt nu nooit een
-- btw-code, in een bankverdeling en in een bankregel.
create or replace function public.refuse_vat_on_equity_allocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if nullif(btrim(coalesce(new.vat_code, '')), '') is null or new.account_id is null then
    return new;
  end if;
  select la.code into v_code from public.ledger_accounts la
  where la.id = new.account_id and la.type = 'equity';
  if v_code is not null then
    raise exception 'Op privé of kapitaal (rekening %) zit geen btw. Kies bij deze regel geen btw-code.', v_code
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists bank_transaction_allocations_no_vat_on_equity on public.bank_transaction_allocations;
create trigger bank_transaction_allocations_no_vat_on_equity
  before insert or update of account_id, vat_code on public.bank_transaction_allocations
  for each row execute function public.refuse_vat_on_equity_allocation();

create or replace function public.refuse_vat_on_equity_bank_rule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if nullif(btrim(coalesce(new.target_vat_code, '')), '') is null or new.target_account_id is null then
    return new;
  end if;
  select la.code into v_code from public.ledger_accounts la
  where la.id = new.target_account_id and la.type = 'equity';
  if v_code is not null then
    raise exception 'Op privé of kapitaal (rekening %) zit geen btw. Kies bij deze bankregel geen btw-code.', v_code
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists bank_rules_no_vat_on_equity on public.bank_rules;
create trigger bank_rules_no_vat_on_equity
  before insert or update of target_account_id, target_vat_code on public.bank_rules
  for each row execute function public.refuse_vat_on_equity_bank_rule();

-- Bestaande bankregels met een btw-code op privé of kapitaal: de btw-code eraf,
-- anders boekte elke volgende automatische boeking weer voorbelasting op een
-- privé-opname. Wat al geboekt is, blijft staan (dat corrigeer je met een
-- memoriaal of een suppletie).
update public.bank_rules r
set target_vat_code = null
where nullif(btrim(coalesce(r.target_vat_code, '')), '') is not null
  and exists (select 1 from public.ledger_accounts la where la.id = r.target_account_id and la.type = 'equity');

-- ── 9. Algemeen privé naast de vennoten ────────────────────────────────────
-- Bij een vof met vennoten stonden 0550 en 0560 in elke keuzelijst naast de
-- privérekeningen van de vennoten, met dezelfde naam. Wie daar boekte, boekte
-- op geen enkele vennoot: bij de jaarafsluiting ging het naar 0500. Zodra er
-- een vennoot is, zegt de naam het.
create or replace function public.mark_general_private_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ledger_accounts
  set name = case subtype when 'private_withdrawals' then 'Privé-opnamen (geen vennoot)' else 'Privé-stortingen (geen vennoot)' end
  where organization_id = new.organization_id
    and subtype in ('private_withdrawals', 'private_contributions')
    and name in ('Privé-opnamen', 'Privé-stortingen');
  return new;
end;
$$;

drop trigger if exists partnership_partners_mark_general_private on public.partnership_partners;
create trigger partnership_partners_mark_general_private
  after insert on public.partnership_partners
  for each row execute function public.mark_general_private_accounts();

update public.ledger_accounts la
set name = case la.subtype when 'private_withdrawals' then 'Privé-opnamen (geen vennoot)' else 'Privé-stortingen (geen vennoot)' end
where la.subtype in ('private_withdrawals', 'private_contributions')
  and la.name in ('Privé-opnamen', 'Privé-stortingen')
  and exists (select 1 from public.partnership_partners pp where pp.organization_id = la.organization_id);

-- ── 10. Rechten ─────────────────────────────────────────────────────────────
-- Wat de app aanroept: ingelogde gebruikers (de functies controleren zelf de
-- organisatie en de modulerechten), en de server.
revoke all on function public.set_partnership_partner_member(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_partnership_partner_member(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.partnership_partner_hours(uuid, integer) from public, anon;
grant execute on function public.partnership_partner_hours(uuid, integer) to authenticated, service_role;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.owners_equity_overview(uuid, uuid) from public, anon;
grant execute on function public.owners_equity_overview(uuid, uuid) to authenticated, service_role;
revoke all on function public.pay_purchase_invoice_privately(uuid, uuid, uuid, date, uuid) from public, anon;
grant execute on function public.pay_purchase_invoice_privately(uuid, uuid, uuid, date, uuid) to authenticated, service_role;
-- Zoals in 20261107110000: interne hulpjes, alleen voor de server.
revoke all on function public.purchase_invoice_open_payable_cents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purchase_invoice_open_payable_cents(uuid, uuid) to service_role;
revoke all on function public.refresh_purchase_invoice_payment_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.refresh_purchase_invoice_payment_status(uuid, uuid) to service_role;
-- Zoals in 20261107110000 en 20261106110000.
revoke all on function public.report_open_items(uuid, date) from public, anon;
grant execute on function public.report_open_items(uuid, date) to authenticated, service_role;
revoke all on function public.open_fiscal_year(uuid, date, date, text, uuid) from public, anon;
grant execute on function public.open_fiscal_year(uuid, date, date, text, uuid) to authenticated, service_role;
-- Triggerfuncties vuren ook zonder EXECUTE.
revoke all on function public.purchase_private_payment_on_reverse() from public, anon, authenticated;
revoke all on function public.company_settings_ib_calendar_year() from public, anon, authenticated;
revoke all on function public.refuse_vat_on_equity_allocation() from public, anon, authenticated;
revoke all on function public.refuse_vat_on_equity_bank_rule() from public, anon, authenticated;
revoke all on function public.mark_general_private_accounts() from public, anon, authenticated;

commit;
