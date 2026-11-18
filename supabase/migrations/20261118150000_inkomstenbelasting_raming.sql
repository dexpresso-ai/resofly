-- ============================================================
-- ResoFly — Inkomstenbelasting: een raming per ondernemer en per vennoot
-- Date: 2026-11-18
--
-- Bij een eenmanszaak, vof, maatschap of cv is de winst van de ondernemer of
-- de vennoten zelf: zij betalen er inkomstenbelasting en de Zvw-bijdrage over.
-- Tot nu toe hield ResoFly op bij de bouwstenen (winst, urencriterium,
-- kapitaalvergelijking per vennoot); wat iemand ongeveer moet betalen, moest hij
-- zelf uitrekenen. Nu rekent de app het uit (src/lib/inkomstenbelasting.ts,
-- met dezelfde code voor Gerrie in _shared/inkomstenbelasting.ts).
--
-- Wat de raming nodig heeft en NIET in de boekhouding staat, hoort bij de
-- persoon en het KALENDERJAAR (de inkomstenbelasting rekent per kalenderjaar,
-- art. 3.66 Wet IB, ook als een boekjaar anders loopt):
--   1. income_tax_profiles — per ondernemer of vennoot per jaar: urencriterium,
--      starter, AOW-leeftijd, een verlies uit eerdere jaren, overige
--      ondernemersaftrek en de betaalde voorlopige aanslagen.
--   2. income_tax_corrections — fiscale correcties op de winst (bijtelling auto,
--      gemengde kosten, EIA/MIA, …), voor de hele onderneming (bij een vof naar
--      winstaandeel verdeeld) of voor één vennoot.
--   3. income_tax_kia_exclusions — activa die niet meetellen voor de KIA (een
--      personenauto, grond, een woning). Standaard telt elk activum van minstens
--      € 450 dat in het jaar is aangeschaft.
--
-- get_income_tax_inputs geeft in één aanroep alles wat het rekenhart nodig
-- heeft. Schrijven kan alleen via de functies hieronder: die controleren de
-- rechten, de rechtsvorm en dat een vennoot of activum bij dezelfde organisatie
-- hoort. Dat laatste staat ook als samengestelde sleutel in de tabel zelf, zodat
-- het nooit van één controle afhangt.
--
-- Bewust geen boeking: de inkomstenbelasting is een privéschuld van de
-- ondernemer, geen kosten van de onderneming. Betaalt hij hem van de zakelijke
-- rekening, dan is dat een privé-opname.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 0. Samengestelde sleutels: een vennoot of activum van dezelfde organisatie ──
-- Een gewone verwijzing naar partnership_partners(id) controleert alleen dát de
-- vennoot bestaat, niet van wie hij is. Met (organization_id, id) kan een rij
-- nooit naar een vennoot of activum van een andere organisatie wijzen.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'partnership_partners_org_id_key') then
    alter table public.partnership_partners
      add constraint partnership_partners_org_id_key unique (organization_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixed_assets_org_id_key') then
    alter table public.fixed_assets
      add constraint fixed_assets_org_id_key unique (organization_id, id);
  end if;
end;
$$;

-- ── 1. Per persoon per kalenderjaar ─────────────────────────────────────────
create table if not exists public.income_tax_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  year integer not null,
  -- null: de ondernemer van een eenmanszaak, of een vof waarvan de vennoten
  -- nog niet zijn vastgelegd.
  partner_id uuid,
  -- null: nog niet ingevuld. De raming rekent dan zonder zelfstandigenaftrek
  -- en zegt dat erbij.
  meets_hours_criterion boolean,
  starter boolean not null default false,
  aow_status text not null default 'nee',
  aow_month smallint,
  loss_carry_forward_cents bigint not null default 0,
  other_entrepreneur_deduction_cents bigint not null default 0,
  provisional_income_tax_cents bigint not null default 0,
  provisional_zvw_cents bigint not null default 0,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint income_tax_profiles_partner_fkey foreign key (organization_id, partner_id)
    references public.partnership_partners(organization_id, id) on delete cascade,
  constraint income_tax_profiles_year_check check (year between 2000 and 2100),
  constraint income_tax_profiles_aow_status_check check (aow_status in ('nee', 'heel_jaar', 'in_jaar')),
  -- In de loop van het jaar: dan moet de maand erbij (1–12), anders niet.
  constraint income_tax_profiles_aow_month_check check (
    (aow_status = 'in_jaar' and aow_month between 1 and 12) or (aow_status <> 'in_jaar' and aow_month is null)),
  constraint income_tax_profiles_amounts_check check (
    loss_carry_forward_cents between 0 and 100000000000
    and other_entrepreneur_deduction_cents between 0 and 100000000000
    and provisional_income_tax_cents between 0 and 100000000000
    and provisional_zvw_cents between 0 and 100000000000),
  constraint income_tax_profiles_unique unique nulls not distinct (organization_id, year, partner_id)
);

comment on table public.income_tax_profiles is
  'Per ondernemer of vennoot per kalenderjaar wat de raming van de inkomstenbelasting nodig heeft en niet in de boekhouding staat. Schrijven alleen via save_income_tax_profile.';

create index if not exists idx_income_tax_profiles_partner on public.income_tax_profiles(organization_id, partner_id);

-- ── 2. Fiscale correcties op de winst ───────────────────────────────────────
create table if not exists public.income_tax_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  year integer not null,
  -- null: de hele onderneming (bij een vof naar winstaandeel verdeeld).
  partner_id uuid,
  code text not null,
  label text not null,
  -- Positief verhoogt de winst (bijtelling, niet-aftrekbaar), negatief verlaagt
  -- hem (EIA/MIA).
  amount_cents bigint not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint income_tax_corrections_partner_fkey foreign key (organization_id, partner_id)
    references public.partnership_partners(organization_id, id) on delete cascade,
  constraint income_tax_corrections_year_check check (year between 2000 and 2100),
  constraint income_tax_corrections_code_check check (code in (
    'gemengde_kosten',            -- het niet-aftrekbare deel van eten, drinken en representatie (art. 3.15)
    'privegebruik_auto',          -- bijtelling privégebruik auto van de zaak (art. 3.20)
    'niet_aftrekbaar',            -- boetes en andere niet-aftrekbare kosten (art. 3.14)
    'desinvesteringsbijtelling',  -- verkoop binnen 5 jaar na een investeringsaftrek (art. 3.47)
    'investeringsaftrek',         -- EIA/MIA: verlaagt de winst
    'overig'
  )),
  constraint income_tax_corrections_label_check check (length(btrim(label)) between 1 and 200),
  constraint income_tax_corrections_amount_check check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  -- De richting hoort bij de soort: een bijtelling verhoogt, een aftrek verlaagt.
  constraint income_tax_corrections_sign_check check (
    (code = 'investeringsaftrek' and amount_cents < 0)
    or (code in ('gemengde_kosten', 'privegebruik_auto', 'niet_aftrekbaar', 'desinvesteringsbijtelling') and amount_cents > 0)
    or code = 'overig')
);

comment on table public.income_tax_corrections is
  'Fiscale correcties op de winst voor de raming van de inkomstenbelasting, per kalenderjaar. Schrijven alleen via add_income_tax_correction en delete_income_tax_correction.';

create index if not exists idx_income_tax_corrections_year on public.income_tax_corrections(organization_id, year);
create index if not exists idx_income_tax_corrections_partner on public.income_tax_corrections(organization_id, partner_id);

-- ── 3. Activa die niet meetellen voor de KIA ────────────────────────────────
create table if not exists public.income_tax_kia_exclusions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  asset_id uuid not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint income_tax_kia_exclusions_asset_fkey foreign key (organization_id, asset_id)
    references public.fixed_assets(organization_id, id) on delete cascade,
  constraint income_tax_kia_exclusions_unique unique (organization_id, asset_id)
);

comment on table public.income_tax_kia_exclusions is
  'Activa die niet meetellen voor de kleinschaligheidsinvesteringsaftrek in de raming van de inkomstenbelasting. Schrijven alleen via set_income_tax_kia_exclusion.';

-- ── 4. Rechten en sporen ────────────────────────────────────────────────────
alter table public.income_tax_profiles enable row level security;
alter table public.income_tax_corrections enable row level security;
alter table public.income_tax_kia_exclusions enable row level security;

drop policy if exists "income tax profiles read" on public.income_tax_profiles;
create policy "income tax profiles read" on public.income_tax_profiles
  for select using (public.can_read_org(organization_id));
drop policy if exists "income tax corrections read" on public.income_tax_corrections;
create policy "income tax corrections read" on public.income_tax_corrections
  for select using (public.can_read_org(organization_id));
drop policy if exists "income tax kia exclusions read" on public.income_tax_kia_exclusions;
create policy "income tax kia exclusions read" on public.income_tax_kia_exclusions
  for select using (public.can_read_org(organization_id));

-- Geen schrijfpolicy: alles gaat via de functies hieronder.
revoke insert, update, delete, truncate on public.income_tax_profiles from anon, authenticated;
revoke insert, update, delete, truncate on public.income_tax_corrections from anon, authenticated;
revoke insert, update, delete, truncate on public.income_tax_kia_exclusions from anon, authenticated;
revoke all on public.income_tax_profiles from anon;
revoke all on public.income_tax_corrections from anon;
revoke all on public.income_tax_kia_exclusions from anon;

select public.apply_module_gate('income_tax_profiles', 'finance');
select public.apply_module_gate('income_tax_corrections', 'finance');
select public.apply_module_gate('income_tax_kia_exclusions', 'finance');

drop trigger if exists income_tax_profiles_touch_updated_at on public.income_tax_profiles;
create trigger income_tax_profiles_touch_updated_at before update on public.income_tax_profiles
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists income_tax_corrections_touch_updated_at on public.income_tax_corrections;
create trigger income_tax_corrections_touch_updated_at before update on public.income_tax_corrections
  for each row execute function public.bookkeeping_touch_updated_at();

drop trigger if exists income_tax_profiles_prevent_org_change on public.income_tax_profiles;
create trigger income_tax_profiles_prevent_org_change before update of organization_id on public.income_tax_profiles
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists income_tax_corrections_prevent_org_change on public.income_tax_corrections;
create trigger income_tax_corrections_prevent_org_change before update of organization_id on public.income_tax_corrections
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists income_tax_kia_exclusions_prevent_org_change on public.income_tax_kia_exclusions;
create trigger income_tax_kia_exclusions_prevent_org_change before update of organization_id on public.income_tax_kia_exclusions
  for each row execute function public.prevent_organization_id_change();

-- In het logboek: wie het urencriterium aanzette of een correctie opgaf. De
-- bedragen gaan er niet met hun waarde in (audit_field_spec kent deze tabellen
-- niet, dus alleen "gewijzigd").
drop trigger if exists income_tax_profiles_audit on public.income_tax_profiles;
create trigger income_tax_profiles_audit after insert or update or delete on public.income_tax_profiles
  for each row execute function public.audit_row_change('income_tax_profile', 'year');
drop trigger if exists income_tax_corrections_audit on public.income_tax_corrections;
create trigger income_tax_corrections_audit after insert or update or delete on public.income_tax_corrections
  for each row execute function public.audit_row_change('income_tax_correction', 'label');

-- ── 5. Alles wat het rekenhart nodig heeft, in één aanroep ──────────────────
-- De winst komt uit dezelfde bron als het overzicht Eigen vermogen: de W&V
-- zonder de jaarafsluiting, maar dan over het KALENDERJAAR.
--
-- Twee dingen sluiten aan op het overzicht voor de aangifte op Eigen vermogen
-- (20261118090000, src/lib/incomeTax.ts), zodat beide schermen bij een
-- eenmanszaak dezelfde belastbare winst tonen:
--   - de kosten op rekeningen met subtype mixed_costs (4600 Eten, drinken en
--     representatie): het rekenhart telt het niet-aftrekbare deel erbij;
--   - de geregistreerde uren van de eigenaar: daarmee vult de raming het
--     urencriterium in zolang er niets is opgeslagen.
-- En bij een vof, maatschap of cv de uren per vennoot die aan een teamlid hangt
-- (20261118130000, partnership_partners.user_id): het urencriterium geldt per
-- vennoot, en dezelfde telling staat bij Vennoten.
-- De uren alleen met leesrecht op Uren. Gerrie draait als service-role en geeft
-- met p_hours mee of de aanroeper Uren mag lezen.
create or replace function public.get_income_tax_inputs(p_organization_id uuid, p_year integer, p_hours boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_legal text;
  v_partnership_form boolean;
  v_start date;
  v_end date;
  v_result bigint := 0;
  v_mixed bigint := 0;
  v_minutes bigint := null;
  v_owner uuid;
  v_owner_minutes bigint := null;
  v_partner_minutes jsonb := null;
  v_may_read_hours boolean;
  v_company text;
  v_bookkeeping_start date;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'ib' then
    raise exception 'De raming van de inkomstenbelasting hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.'
      using errcode = '23514';
  end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then
    raise exception 'Kies een kalenderjaar tussen 2000 en 2100.' using errcode = '22023';
  end if;

  v_legal := public.org_legal_form(p_organization_id);
  v_partnership_form := v_legal in ('vof', 'maatschap', 'cv');
  v_start := make_date(p_year, 1, 1);
  v_end := make_date(p_year, 12, 31);

  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_result
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_start and v_end
    and la.type in ('revenue', 'expense');

  -- Eten, drinken en representatie: beperkt aftrekbaar (art. 3.15 Wet IB).
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
  into v_mixed
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_start and v_end
    and la.type = 'expense'
    and la.subtype = 'mixed_costs';

  select nullif(btrim(cs.company_name), ''), cs.bookkeeping_start_date
  into v_company, v_bookkeeping_start
  from public.company_settings cs
  where cs.organization_id = p_organization_id;

  -- Je eigen geregistreerde uren, als hint bij het urencriterium. Alleen met
  -- leesrecht op Uren: wie die module niet mag zien, krijgt ook dit getal niet.
  if auth.uid() is not null and public.can_read_module(p_organization_id, 'time') then
    select coalesce(sum(te.minutes), 0)::bigint
    into v_minutes
    from public.time_entries te
    where te.organization_id = p_organization_id
      and te.user_id = auth.uid()
      and te.entry_date between v_start and v_end;
  end if;

  v_may_read_hours := coalesce(p_hours, false)
    and (auth.role() = 'service_role' or (auth.uid() is not null and public.can_read_module(p_organization_id, 'time')));

  -- De uren van de eigenaar: bij een eenmanszaak is hij de ondernemer (zoals
  -- op Eigen vermogen).
  if v_may_read_hours and not v_partnership_form then
    select om.user_id into v_owner
    from public.organization_members om
    where om.organization_id = p_organization_id and om.role = 'owner' and om.status = 'active'
    order by om.created_at, om.user_id
    limit 1;
    if v_owner is not null then
      select coalesce(sum(te.minutes), 0)::bigint
      into v_owner_minutes
      from public.time_entries te
      where te.organization_id = p_organization_id
        and te.user_id = v_owner
        and te.entry_date between v_start and v_end;
    end if;
  end if;

  -- De uren per vennoot, voor wie aan een teamlid hangt; direct en indirect,
  -- declarabel of niet, net als partnership_partner_hours.
  if v_may_read_hours and v_partnership_form then
    select coalesce(jsonb_object_agg(x.partner_id, x.minutes), '{}'::jsonb)
    into v_partner_minutes
    from (
      select pp.id as partner_id, coalesce(sum(te.minutes), 0)::bigint as minutes
      from public.partnership_partners pp
      left join public.time_entries te
        on te.organization_id = p_organization_id
       and te.user_id = pp.user_id
       and te.entry_date between v_start and v_end
      where pp.organization_id = p_organization_id
        and pp.user_id is not null
      group by pp.id
    ) x;
  end if;

  return jsonb_build_object(
    'year', p_year,
    'legalForm', v_legal,
    'isPartnershipForm', v_partnership_form,
    'companyName', v_company,
    'bookkeepingStartDate', v_bookkeeping_start,
    'resultCents', v_result,
    'mixedCostsCents', v_mixed,
    'overlappingFiscalYears', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', fy.id, 'label', fy.label, 'periodStart', fy.period_start,
               'periodEnd', fy.period_end, 'status', fy.status
             ) order by fy.period_start)
      from public.fiscal_years fy
      where fy.organization_id = p_organization_id
        and fy.period_start <= v_end
        and fy.period_end >= v_start
    ), '[]'::jsonb),
    'partners', case when v_partnership_form then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pp.id, 'name', pp.name, 'partnerNumber', pp.partner_number, 'kind', pp.kind,
               'isActive', pp.is_active, 'shareBasisPoints', pp.profit_share_basis_points
             ) order by pp.partner_number)
      from public.partnership_partners pp
      where pp.organization_id = p_organization_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'profiles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'partnerId', p.partner_id,
               'meetsHoursCriterion', p.meets_hours_criterion,
               'starter', p.starter,
               'aowStatus', p.aow_status,
               'aowMonth', p.aow_month,
               'lossCarryForwardCents', p.loss_carry_forward_cents,
               'otherEntrepreneurDeductionCents', p.other_entrepreneur_deduction_cents,
               'provisionalIncomeTaxCents', p.provisional_income_tax_cents,
               'provisionalZvwCents', p.provisional_zvw_cents,
               'updatedAt', p.updated_at
             ) order by p.created_at)
      from public.income_tax_profiles p
      where p.organization_id = p_organization_id and p.year = p_year
    ), '[]'::jsonb),
    'corrections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'partnerId', c.partner_id, 'code', c.code,
               'label', c.label, 'amountCents', c.amount_cents
             ) order by c.created_at, c.id)
      from public.income_tax_corrections c
      where c.organization_id = p_organization_id and c.year = p_year
    ), '[]'::jsonb),
    'investments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'assetId', fa.id, 'name', fa.name, 'assetNumber', fa.asset_number,
               'acquisitionDate', fa.acquisition_date, 'costCents', fa.acquisition_cost_cents,
               'excluded', exists (
                 select 1 from public.income_tax_kia_exclusions x
                 where x.organization_id = p_organization_id and x.asset_id = fa.id)
             ) order by fa.acquisition_date, fa.asset_number, fa.id)
      from public.fixed_assets fa
      where fa.organization_id = p_organization_id
        and fa.acquisition_date between v_start and v_end
    ), '[]'::jsonb),
    'myMinutes', v_minutes,
    'ownerMinutes', v_owner_minutes,
    'partnerMinutes', v_partner_minutes
  );
end;
$$;

-- ── 6. Schrijven ────────────────────────────────────────────────────────────

-- Gemeenschappelijke toets voor de schrijffuncties: rechten op Financiën, een
-- IB-rechtsvorm en een geldig jaar.
create or replace function public.income_tax_assert_writable(p_organization_id uuid, p_year integer)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'ib' then
    raise exception 'De raming van de inkomstenbelasting hoort bij een eenmanszaak, vof, maatschap of cv.' using errcode = '23514';
  end if;
  if p_year is not null and (p_year < 2000 or p_year > 2100) then
    raise exception 'Kies een kalenderjaar tussen 2000 en 2100.' using errcode = '22023';
  end if;
end;
$$;

-- Een vennoot hoort bij deze organisatie en bij een vof, maatschap of cv.
-- Geeft de soort terug (beherend of commanditair).
create or replace function public.income_tax_partner_kind(p_organization_id uuid, p_partner_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  if p_partner_id is null then
    return null;
  end if;
  if public.org_legal_form(p_organization_id) not in ('vof', 'maatschap', 'cv') then
    raise exception 'Vennoten horen bij een vof, maatschap of cv.' using errcode = '23514';
  end if;
  select pp.kind into v_kind
  from public.partnership_partners pp
  where pp.id = p_partner_id and pp.organization_id = p_organization_id;
  if not found then
    raise exception 'Vennoot niet gevonden.' using errcode = '02000';
  end if;
  return v_kind;
end;
$$;

create or replace function public.save_income_tax_profile(
  p_organization_id uuid,
  p_year integer,
  p_partner_id uuid,
  p_meets_hours_criterion boolean,
  p_starter boolean,
  p_aow_status text,
  p_aow_month integer,
  p_loss_carry_forward_cents bigint,
  p_other_entrepreneur_deduction_cents bigint,
  p_provisional_income_tax_cents bigint,
  p_provisional_zvw_cents bigint
)
returns public.income_tax_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.income_tax_profiles;
  v_kind text;
  v_aow text := coalesce(nullif(btrim(coalesce(p_aow_status, '')), ''), 'nee');
  v_month smallint;
  v_hours boolean := p_meets_hours_criterion;
  v_starter boolean := coalesce(p_starter, false);
  v_other bigint := coalesce(p_other_entrepreneur_deduction_cents, 0);
begin
  if p_year is null then
    raise exception 'Kies een kalenderjaar.' using errcode = '22023';
  end if;
  perform public.income_tax_assert_writable(p_organization_id, p_year);
  v_kind := public.income_tax_partner_kind(p_organization_id, p_partner_id);

  if v_aow not in ('nee', 'heel_jaar', 'in_jaar') then
    raise exception 'AOW-leeftijd: kies nee, het hele jaar of in de loop van het jaar.' using errcode = '23514';
  end if;
  if v_aow = 'in_jaar' then
    if p_aow_month is null or p_aow_month < 1 or p_aow_month > 12 then
      raise exception 'Kies de maand waarin de AOW-leeftijd wordt bereikt.' using errcode = '23514';
    end if;
    v_month := p_aow_month;
  end if;

  if coalesce(p_loss_carry_forward_cents, 0) < 0 or coalesce(p_other_entrepreneur_deduction_cents, 0) < 0
     or coalesce(p_provisional_income_tax_cents, 0) < 0 or coalesce(p_provisional_zvw_cents, 0) < 0 then
    raise exception 'Bedragen zijn nul of positief.' using errcode = '23514';
  end if;
  if greatest(coalesce(p_loss_carry_forward_cents, 0), coalesce(p_other_entrepreneur_deduction_cents, 0),
              coalesce(p_provisional_income_tax_cents, 0), coalesce(p_provisional_zvw_cents, 0)) > 100000000000 then
    raise exception 'Een bedrag is hooguit één miljard euro.' using errcode = '23514';
  end if;

  -- Een commanditaire vennoot is geen ondernemer voor de inkomstenbelasting:
  -- urencriterium, startersaftrek en ondernemersaftrek bestaan voor hem niet.
  if v_kind = 'commanditair' then
    v_hours := null;
    v_starter := false;
    v_other := 0;
  end if;

  insert into public.income_tax_profiles as t (
    organization_id, year, partner_id, meets_hours_criterion, starter, aow_status, aow_month,
    loss_carry_forward_cents, other_entrepreneur_deduction_cents, provisional_income_tax_cents, provisional_zvw_cents,
    created_by)
  values (
    p_organization_id, p_year, p_partner_id, v_hours, v_starter, v_aow, v_month,
    coalesce(p_loss_carry_forward_cents, 0), v_other, coalesce(p_provisional_income_tax_cents, 0),
    coalesce(p_provisional_zvw_cents, 0), auth.uid())
  on conflict on constraint income_tax_profiles_unique do update
  set meets_hours_criterion = excluded.meets_hours_criterion,
      starter = excluded.starter,
      aow_status = excluded.aow_status,
      aow_month = excluded.aow_month,
      loss_carry_forward_cents = excluded.loss_carry_forward_cents,
      other_entrepreneur_deduction_cents = excluded.other_entrepreneur_deduction_cents,
      provisional_income_tax_cents = excluded.provisional_income_tax_cents,
      provisional_zvw_cents = excluded.provisional_zvw_cents
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.add_income_tax_correction(
  p_organization_id uuid,
  p_year integer,
  p_partner_id uuid,
  p_code text,
  p_label text,
  p_amount_cents bigint
)
returns public.income_tax_corrections
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.income_tax_corrections;
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
begin
  if p_year is null then
    raise exception 'Kies een kalenderjaar.' using errcode = '22023';
  end if;
  perform public.income_tax_assert_writable(p_organization_id, p_year);
  perform public.income_tax_partner_kind(p_organization_id, p_partner_id);

  if v_code is null or v_code not in ('gemengde_kosten', 'privegebruik_auto', 'niet_aftrekbaar', 'desinvesteringsbijtelling', 'investeringsaftrek', 'overig') then
    raise exception 'Onbekende soort correctie.' using errcode = '23514';
  end if;
  if v_label is null then
    raise exception 'Geef de correctie een omschrijving.' using errcode = '23514';
  end if;
  if length(v_label) > 200 then
    raise exception 'De omschrijving is hooguit 200 tekens.' using errcode = '23514';
  end if;
  if p_amount_cents is null or p_amount_cents = 0 then
    raise exception 'Een correctie van nul heeft geen effect.' using errcode = '23514';
  end if;
  if abs(p_amount_cents) > 100000000000 then
    raise exception 'Een correctie is hooguit één miljard euro.' using errcode = '23514';
  end if;
  if v_code = 'investeringsaftrek' and p_amount_cents > 0 then
    raise exception 'Een investeringsaftrek verlaagt de winst: vul het bedrag negatief in.' using errcode = '23514';
  end if;
  if v_code in ('gemengde_kosten', 'privegebruik_auto', 'niet_aftrekbaar', 'desinvesteringsbijtelling') and p_amount_cents < 0 then
    raise exception 'Deze correctie verhoogt de winst: vul het bedrag positief in.' using errcode = '23514';
  end if;

  insert into public.income_tax_corrections (organization_id, year, partner_id, code, label, amount_cents, created_by)
  values (p_organization_id, p_year, p_partner_id, v_code, v_label, p_amount_cents, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.delete_income_tax_correction(p_organization_id uuid, p_correction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.income_tax_assert_writable(p_organization_id, null);
  delete from public.income_tax_corrections
  where id = p_correction_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Correctie niet gevonden.' using errcode = '02000';
  end if;
end;
$$;

create or replace function public.set_income_tax_kia_exclusion(p_organization_id uuid, p_asset_id uuid, p_excluded boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.income_tax_assert_writable(p_organization_id, null);
  if not exists (
    select 1 from public.fixed_assets fa
    where fa.id = p_asset_id and fa.organization_id = p_organization_id
  ) then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;

  if coalesce(p_excluded, false) then
    insert into public.income_tax_kia_exclusions (organization_id, asset_id, created_by)
    values (p_organization_id, p_asset_id, auth.uid())
    on conflict (organization_id, asset_id) do nothing;
  else
    delete from public.income_tax_kia_exclusions
    where organization_id = p_organization_id and asset_id = p_asset_id;
  end if;
end;
$$;

-- ── 7. Logboek: de nieuwe soorten horen bij Financiën ───────────────────────
-- Gelijk aan 20261111220000 (de laatste definitie; 20261118090000 t/m
-- 20261118120000 lieten hem staan), met 'income_tax_profile' en
-- 'income_tax_correction' bij Financiën.
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'mollie_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event', 'email_template',
                           'client_subdomain', 'client_domain') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'income_tax_correction', 'income_tax_profile', 'invoice', 'journal_entry', 'ledger_account',
                           'partnership_partner', 'prepaid_expense', 'purchase_invoice', 'quote', 'result_appropriation',
                           'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact', 'client_field') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee', 'gallery') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    when p_entity_type in ('email_campaign', 'email_flow') then 'marketing'
    else 'admin'
  end;
$$;

-- ── 8. Rechten op de functies ───────────────────────────────────────────────
-- Wat de app aanroept: ingelogde gebruikers (de functies controleren zelf de
-- organisatie en de modulerechten). De hulpjes: alleen de server.
revoke all on function public.get_income_tax_inputs(uuid, integer, boolean) from public, anon;
grant execute on function public.get_income_tax_inputs(uuid, integer, boolean) to authenticated, service_role;
revoke all on function public.save_income_tax_profile(uuid, integer, uuid, boolean, boolean, text, integer, bigint, bigint, bigint, bigint) from public, anon;
grant execute on function public.save_income_tax_profile(uuid, integer, uuid, boolean, boolean, text, integer, bigint, bigint, bigint, bigint) to authenticated, service_role;
revoke all on function public.add_income_tax_correction(uuid, integer, uuid, text, text, bigint) from public, anon;
grant execute on function public.add_income_tax_correction(uuid, integer, uuid, text, text, bigint) to authenticated, service_role;
revoke all on function public.delete_income_tax_correction(uuid, uuid) from public, anon;
grant execute on function public.delete_income_tax_correction(uuid, uuid) to authenticated, service_role;
revoke all on function public.set_income_tax_kia_exclusion(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_income_tax_kia_exclusion(uuid, uuid, boolean) to authenticated, service_role;

revoke all on function public.income_tax_assert_writable(uuid, integer) from public, anon, authenticated;
grant execute on function public.income_tax_assert_writable(uuid, integer) to service_role;
revoke all on function public.income_tax_partner_kind(uuid, uuid) from public, anon, authenticated;
grant execute on function public.income_tax_partner_kind(uuid, uuid) to service_role;

-- Zoals in 20261108230000: de leesregel op audit_logs roept hem aan namens de
-- ingelogde gebruiker.
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

commit;
