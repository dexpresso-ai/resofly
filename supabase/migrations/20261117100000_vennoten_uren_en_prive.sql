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
-- De verdeling zelf verandert niet. Die wordt sinds deze migratie bewaakt door
-- tests/database/vennoten_jaarafsluiting.sql, die in CI op een lege database
-- draait (job migrations in frontend-checks.yml).
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
-- Gelijk aan 20261105000000, op één plek na: zie GEWIJZIGD (20261117100000).
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
  v_partnership boolean := false;
  v_share_total integer := 0;
  v_capital uuid;
  s record;
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
  -- GEWIJZIGD (20261117100000): altijd, niet alleen bij een vof, maatschap of
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
-- Gelijk aan 20261104070000, op één plek na: zie GEWIJZIGD (20261117100000).
create or replace function public.owners_equity_overview(p_organization_id uuid, p_fiscal_year_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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

    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and la.type = 'equity'
      and (je.date < v_fy.period_start
           or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end));

    -- GEWIJZIGD (20261117100000): ook het privé van (vroegere) vennoten telt als
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
    'owners', v_owners,
    'unassigned', v_unassigned
  );
end;
$$;

-- ── 5. Rechten ──────────────────────────────────────────────────────────────
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

commit;
