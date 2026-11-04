-- ============================================================
-- ResoFly — Eenmanszaak, vof, maatschap en cv: privé en vennoten
-- Date: 2026-11-04
--
-- Bij een IB-onderneming (eenmanszaak, vof, maatschap, cv) is de winst van de
-- ondernemer of de vennoten zelf; er is geen rechtspersoon die de winst houdt
-- tot een aandeelhoudersvergadering erover beslist. De boekhouding kende tot nu
-- toe alleen "0500 Eigen vermogen" en "0510 Onverdeeld resultaat":
--
--   1. GEEN PRIVÉ. Geld dat de ondernemer opneemt of inbrengt (privé-opnamen
--      en -stortingen) had geen eigen rekening. Die bedragen zijn wél nodig:
--      de winst volgt fiscaal uit de vermogensvergelijking (eindvermogen min
--      beginvermogen, plus onttrekkingen, min stortingen) en de aangifte
--      inkomstenbelasting vraagt het ondernemingsvermogen aan het begin en het
--      eind van het jaar. Nu: 0550 Privé-opnamen en 0560 Privé-stortingen, die
--      bij de jaarafsluiting naar het eigen vermogen gaan.
--   2. GEEN VENNOTEN. Een vof, maatschap of cv heeft per vennoot een eigen
--      kapitaal, en de winst wordt verdeeld volgens het vennootschapscontract.
--      Elke vennoot geeft zijn eigen winstaandeel aan in zijn aangifte
--      inkomstenbelasting (en haalt zelf het urencriterium). Tot nu toe ging
--      de hele winst naar één rekening, zonder verdeling. Nu: vennoten met een
--      winstaandeel, per vennoot een kapitaalrekening (0501–0509) en
--      privérekeningen (0551–0559 opnamen, 0561–0569 stortingen), en bij de
--      jaarafsluiting wordt het resultaat verdeeld — tot op de cent sluitend
--      (grootste rest) — en gaat het privé van elke vennoot naar zijn kapitaal.
--   3. GEEN OVERZICHT. owners_equity_overview geeft per boekjaar de
--      kapitaalvergelijking: beginvermogen, resultaat(aandeel), stortingen,
--      opnamen en eindvermogen, voor de ondernemer of per vennoot.
--
-- Wat er bewust NIET in zit: een voorafgaande arbeidsvergoeding of rente over
-- het kapitaal vóór de verdeling. Wie dat in het contract heeft staan, boekt
-- het als memoriaal tussen de kapitaalrekeningen; de verdeling hier is naar
-- rato van het winstaandeel. En wisselingen van vennoten midden in het jaar:
-- de verdeling volgt de stand bij de jaarafsluiting.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Rekeningschema IB: privé-opnamen en -stortingen ─────────────────────
CREATE OR REPLACE FUNCTION public.ensure_default_ledger_accounts(p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_regime text;
  v_equity_name text;
  v_equity_subtype text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  v_regime := public.org_fiscal_regime(p_organization_id);

  if v_regime = 'vpb' then
    v_equity_name := 'Geplaatst en gestort aandelenkapitaal';
    v_equity_subtype := 'share_capital';
  else
    v_equity_name := 'Eigen vermogen';
    v_equity_subtype := 'equity';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values
    (p_organization_id, '0100', 'Vaste activa', 'asset', 'fixed_asset', null, true, 'materiele_vaste_activa'),
    (p_organization_id, '0150', 'Cumulatieve afschrijving', 'asset', 'accumulated_depreciation', null, true, 'materiele_vaste_activa'),
    (p_organization_id, '0500', v_equity_name, 'equity', v_equity_subtype, null, true, 'eigen_vermogen'),
    (p_organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', null, true, 'eigen_vermogen'),
    (p_organization_id, '1100', 'Bank', 'asset', 'bank', null, true, 'liquide_middelen'),
    (p_organization_id, '1102', 'Kruisposten Mollie/PSP', 'asset', 'psp_clearing', null, true, 'vorderingen'),
    (p_organization_id, '1300', 'Debiteuren', 'asset', 'accounts_receivable', null, true, 'vorderingen'),
    (p_organization_id, '1500', 'Te vorderen BTW (voorbelasting)', 'asset', 'vat_input', null, true, 'vorderingen'),
    (p_organization_id, '1510', 'Af te dragen BTW (verkoop)', 'liability', 'vat_output', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1520', 'Af te dragen BTW verlegd/ICP', 'liability', 'vat_reverse', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1530', 'Te betalen omzetbelasting', 'liability', 'vat_payable', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1600', 'Crediteuren', 'liability', 'accounts_payable', null, true, 'kortlopende_schulden'),
    (p_organization_id, '4000', 'Afschrijvingskosten', 'expense', 'depreciation', null, true, 'afschrijvingen'),
    (p_organization_id, '4130', 'Betaalproviderkosten', 'expense', 'payment_fees', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4500', 'Algemene kosten', 'expense', 'general_cost', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4900', 'Afrondingsverschillen', 'expense', 'rounding', null, true, 'overige_bedrijfskosten'),
    (p_organization_id, '8000', 'Omzet hoog (21%)', 'revenue', 'sales', 'HOOG', false, 'netto_omzet'),
    (p_organization_id, '8010', 'Omzet laag (9%)', 'revenue', 'sales', 'LAAG', false, 'netto_omzet'),
    (p_organization_id, '8020', 'Omzet 0% / vrijgesteld', 'revenue', 'sales', 'NUL', false, 'netto_omzet'),
    (p_organization_id, '8030', 'Omzet buitenland (ICP/verlegd)', 'revenue', 'sales', 'ICP_DIENST', false, 'netto_omzet')
  on conflict (organization_id, code) do nothing;

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen bij een
  -- IB-onderneming. Herkenning gaat op het subtype, niet op de code: heeft een
  -- administratie 0550 of 0560 al voor iets anders in gebruik, dan blijft die
  -- rekening ongemoeid en telt hij niet als privé.
  if v_regime = 'ib' then
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values
      (p_organization_id, '0550', 'Privé-opnamen', 'equity', 'private_withdrawals', null, true, 'eigen_vermogen'),
      (p_organization_id, '0560', 'Privé-stortingen', 'equity', 'private_contributions', null, true, 'eigen_vermogen')
    on conflict (organization_id, code) do nothing;
  end if;

  insert into public.vat_codes (organization_id, code, label, rate, kind, sales_box, vat_box, is_system)
  values
    (p_organization_id, 'HOOG', 'BTW 21%', 21, 'standard', '1a', '1a', true),
    (p_organization_id, 'LAAG', 'BTW 9%', 9, 'reduced', '1b', '1b', true),
    (p_organization_id, 'NUL', 'BTW 0%', 0, 'zero', '1e', null, true),
    (p_organization_id, 'VRIJ', 'Vrijgesteld', 0, 'exempt', null, null, true),
    (p_organization_id, 'VERL_VERK', 'BTW verlegd (verkoop)', 0, 'reverse_charge_sales', '1e', null, true),
    (p_organization_id, 'VERL_INK', 'BTW verlegd (inkoop)', 21, 'reverse_charge_purchase', '2a', '5b', true),
    (p_organization_id, 'ICP_GOED', 'ICP goederen', 0, 'icp_goods', '3b', null, true),
    (p_organization_id, 'ICP_DIENST', 'ICP diensten', 0, 'icp_services', '3b', null, true),
    (p_organization_id, 'EU_VERW', 'Verwerving EU (verlegd)', 21, 'eu_acquisition', '4b', '5b', true),
    (p_organization_id, 'EXPORT', 'Export buiten EU (0%)', 0, 'zero', '3a', null, true),
    (p_organization_id, 'IMPORT', 'Invoer buiten EU (verlegd, art. 23)', 21, 'import_non_eu', '4a', '5b', true),
    (p_organization_id, 'KOR', 'KOR (vrijgesteld, geen aftrek)', 0, 'kor', null, null, true)
  on conflict (organization_id, code) do nothing;

  -- Goedkope bestaanscheck eerst (unieke index op organization_id, code), en
  -- daarna pas de module-vraag: in de normale situatie kost dit één indexprobe.
  if v_regime = 'vpb'
     and not exists (
       select 1 from public.ledger_accounts
       where organization_id = p_organization_id and code = '0505'
     )
     and public.org_has_business(p_organization_id) then
    perform public.ensure_business_ledger_accounts(p_organization_id);
  end if;
end;
$function$;
revoke all on function public.ensure_default_ledger_accounts(uuid) from public, anon;
grant execute on function public.ensure_default_ledger_accounts(uuid) to authenticated, service_role;

-- Bestaande IB-administraties met een rekeningschema krijgen de rekeningen
-- meteen, niet pas bij hun volgende boeking.
insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
select la.organization_id, v.code, v.name, 'equity', v.subtype, null, true, 'eigen_vermogen'
from public.ledger_accounts la
cross join (values
  ('0550', 'Privé-opnamen', 'private_withdrawals'),
  ('0560', 'Privé-stortingen', 'private_contributions')
) as v(code, name, subtype)
where la.code = '0500'
  and public.org_fiscal_regime(la.organization_id) = 'ib'
on conflict (organization_id, code) do nothing;

-- ── 2. Vennoten van een vof, maatschap of cv ────────────────────────────────
create table if not exists public.partnership_partners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- 1 t/m 9: bepaalt de rekeningcodes 050n, 055n en 056n.
  partner_number smallint not null check (partner_number between 1 and 9),
  name text not null check (length(btrim(name)) > 0 and length(name) <= 120),
  -- Winstaandeel in basispunten (5000 = 50%). De verdeling moet bij de
  -- jaarafsluiting voor de actieve vennoten optellen tot 10000.
  profit_share_basis_points integer not null check (profit_share_basis_points between 0 and 10000),
  -- Bij een cv: beherend of commanditair (stil). Een commanditaire vennoot
  -- deelt in de winst maar is voor de inkomstenbelasting geen ondernemer.
  kind text not null default 'beherend' check (kind in ('beherend', 'commanditair')),
  is_active boolean not null default true,
  capital_account_id uuid not null references public.ledger_accounts(id),
  withdrawals_account_id uuid not null references public.ledger_accounts(id),
  contributions_account_id uuid not null references public.ledger_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, partner_number)
);

comment on table public.partnership_partners is
  'Vennoten van een vof, maatschap of cv, met hun winstaandeel en eigen kapitaal- en privérekeningen. Schrijven alleen via save_partnership_partner.';

create index if not exists idx_partnership_partners_org on public.partnership_partners(organization_id);

alter table public.partnership_partners enable row level security;
drop policy if exists "partnership partners read" on public.partnership_partners;
create policy "partnership partners read" on public.partnership_partners
  for select using (public.can_read_org(organization_id));
-- Geen schrijfpolicy: de rekeningen horen bij de vennoot en worden door de
-- server aangemaakt (save_partnership_partner).
select public.apply_module_gate('partnership_partners', 'finance');

drop trigger if exists partnership_partners_touch_updated_at on public.partnership_partners;
create trigger partnership_partners_touch_updated_at before update on public.partnership_partners
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists partnership_partners_prevent_org_change on public.partnership_partners;
create trigger partnership_partners_prevent_org_change before update of organization_id on public.partnership_partners
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists partnership_partners_audit on public.partnership_partners;
create trigger partnership_partners_audit after insert or update or delete on public.partnership_partners
  for each row execute function public.audit_row_change('partnership_partner', 'name');

create or replace function public.save_partnership_partner(
  p_organization_id uuid,
  p_partner_id uuid,
  p_name text,
  p_profit_share_basis_points integer,
  p_kind text default 'beherend',
  p_is_active boolean default true
)
returns public.partnership_partners
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.partnership_partners;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_kind text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'beherend');
  v_legal text;
  v_n integer;
  v_cap uuid;
  v_wd uuid;
  v_ct uuid;
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
  if v_name is null then
    raise exception 'Geef de vennoot een naam.' using errcode = '23514';
  end if;
  if length(v_name) > 120 then
    raise exception 'De naam van een vennoot is hooguit 120 tekens.' using errcode = '23514';
  end if;
  if p_profit_share_basis_points is null or p_profit_share_basis_points < 0 or p_profit_share_basis_points > 10000 then
    raise exception 'Het winstaandeel ligt tussen 0 en 100 procent.' using errcode = '23514';
  end if;
  if v_kind not in ('beherend', 'commanditair') then
    raise exception 'Een vennoot is beherend of commanditair.' using errcode = '23514';
  end if;
  if v_kind = 'commanditair' and v_legal <> 'cv' then
    raise exception 'Een commanditaire (stille) vennoot bestaat alleen bij een cv.' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vennoten'));
  perform public.ensure_default_ledger_accounts(p_organization_id);

  if p_partner_id is null then
    select g.n into v_n
    from generate_series(1, 9) as g(n)
    where not exists (
        select 1 from public.partnership_partners pp
        where pp.organization_id = p_organization_id and pp.partner_number = g.n)
      and not exists (
        select 1 from public.ledger_accounts la
        where la.organization_id = p_organization_id
          and la.code in ('050' || g.n, '055' || g.n, '056' || g.n))
    order by g.n
    limit 1;
    if v_n is null then
      raise exception 'Er kunnen hooguit negen vennoten worden vastgelegd (rekeningen 0501 t/m 0509), of de rekeningcodes zijn al voor iets anders in gebruik.'
        using errcode = '23514';
    end if;

    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values (p_organization_id, '050' || v_n, 'Kapitaal ' || v_name, 'equity', 'partner_capital', null, true, 'eigen_vermogen')
    returning id into v_cap;
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values (p_organization_id, '055' || v_n, 'Privé-opnamen ' || v_name, 'equity', 'partner_withdrawals', null, true, 'eigen_vermogen')
    returning id into v_wd;
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values (p_organization_id, '056' || v_n, 'Privé-stortingen ' || v_name, 'equity', 'partner_contributions', null, true, 'eigen_vermogen')
    returning id into v_ct;

    insert into public.partnership_partners (
      organization_id, created_by, partner_number, name, profit_share_basis_points, kind, is_active,
      capital_account_id, withdrawals_account_id, contributions_account_id)
    values (
      p_organization_id, auth.uid(), v_n, v_name, p_profit_share_basis_points, v_kind, coalesce(p_is_active, true),
      v_cap, v_wd, v_ct)
    returning * into v_row;
    return v_row;
  end if;

  select * into v_row
  from public.partnership_partners pp
  where pp.id = p_partner_id and pp.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vennoot niet gevonden.' using errcode = '02000';
  end if;

  update public.partnership_partners
  set name = v_name,
      profit_share_basis_points = p_profit_share_basis_points,
      kind = v_kind,
      is_active = coalesce(p_is_active, true)
  where id = v_row.id
  returning * into v_row;

  -- De rekeningen dragen de naam van de vennoot mee.
  update public.ledger_accounts set name = 'Kapitaal ' || v_name
  where id = v_row.capital_account_id and organization_id = p_organization_id;
  update public.ledger_accounts set name = 'Privé-opnamen ' || v_name
  where id = v_row.withdrawals_account_id and organization_id = p_organization_id;
  update public.ledger_accounts set name = 'Privé-stortingen ' || v_name
  where id = v_row.contributions_account_id and organization_id = p_organization_id;

  return v_row;
end;
$$;
revoke all on function public.save_partnership_partner(uuid, uuid, text, integer, text, boolean) from public, anon;
grant execute on function public.save_partnership_partner(uuid, uuid, text, integer, text, boolean) to authenticated, service_role;

-- De verdeling van een resultaat over de actieve vennoten, tot op de cent
-- sluitend: eerst ieder het naar beneden afgeronde deel, dan de resterende
-- centen aan de grootste resten (bij gelijke rest: de laagste vennootnummer).
-- Telt de verdeling niet op tot 100%, dan alleen de afgeronde delen; de
-- jaarafsluiting weigert dan, en het overzicht meldt het.
create or replace function public.partnership_result_shares(p_organization_id uuid, p_result_cents bigint)
returns table(partner_id uuid, capital_account_id uuid, name text, partner_number smallint, share_basis_points integer, share_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select pp.id, pp.capital_account_id, pp.name, pp.partner_number, pp.profit_share_basis_points as bp,
           (abs(p_result_cents) * pp.profit_share_basis_points) / 10000 as base,
           (abs(p_result_cents) * pp.profit_share_basis_points) % 10000 as rem
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active
  ), r as (
    select s.*,
           row_number() over (order by s.rem desc, s.partner_number) as rn,
           abs(p_result_cents) - sum(s.base) over () as leftover,
           sum(s.bp) over () as total_bp
    from s
  )
  select r.id, r.capital_account_id, r.name, r.partner_number, r.bp,
         (case when p_result_cents < 0 then -1 else 1 end)::bigint
           * (r.base + case when r.total_bp = 10000 and r.rn <= r.leftover then 1 else 0 end)
  from r
  order by r.partner_number;
$$;
revoke all on function public.partnership_result_shares(uuid, bigint) from public, anon, authenticated;
grant execute on function public.partnership_result_shares(uuid, bigint) to service_role;

-- ── 3. Jaarafsluiting: verdeling over de vennoten, privé naar het vermogen ───
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
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;

-- ── 4. De kapitaalvergelijking per boekjaar ─────────────────────────────────
-- Begin = vermogen vóór het boekjaar plus een beginbalans die in het boekjaar
-- is geboekt. Mutaties in het jaar tellen zonder de jaarafsluiting zelf, zodat
-- een open en een afgesloten jaar hetzelfde laten zien.
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

    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where la.subtype = 'private_contributions'), 0)::bigint,
      coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where la.subtype = 'private_withdrawals'), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where coalesce(la.subtype, '') not in ('private_contributions', 'private_withdrawals')), 0)::bigint
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
revoke all on function public.owners_equity_overview(uuid, uuid) from public, anon;
grant execute on function public.owners_equity_overview(uuid, uuid) to authenticated, service_role;

-- ── 5. Auditlog: wijzigingen aan vennoten horen bij Financiën ───────────────
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'partnership_partner', 'purchase_invoice', 'quote',
                           'result_appropriation', 'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    else 'admin'
  end;
$$;

commit;
