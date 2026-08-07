-- ============================================================
-- ResoFly — Zakelijke module fase 0: rechtsvorm + administratie-boom
-- Date: 2026-08-07
--
-- Aanleiding:
-- De boekhouding is impliciet gebouwd voor de IB-ondernemer: één rekening
-- "0500 Eigen vermogen", resultaat rechtstreeks naar 0510, en een
-- urencriterium-monitor die alleen voor de inkomstenbelasting bestaat. Klanten
-- met een BV hebben een ander eigen vermogen, vennootschapsbelasting, en vaak
-- twee administraties (holding + werk-BV). Deze migratie legt daarvoor het
-- fundament. Roadmap: BV_VPB_MODULE_ROADMAP_2026-08-06.md.
--
-- Kernbeslissing — meerdere entiteiten via een administratie-boom:
-- NIET een entity_id op alle ~50 org-gescopete tabellen (dat raakt elke RPC,
-- elke unique constraint en elk rapport; één vergeten entity_id in een WHERE
-- zet holdingcijfers in de jaarrekening van de werk-BV). Wél:
-- organizations.parent_organization_id, maximaal één niveau diep. De hele
-- codebase gaat er al van uit dat één organisatie één administratie is, en dat
-- klopt ook fiscaal: holding en werk-BV zijn losse administraties met een eigen
-- KvK-nummer, boekjaar en rekeningschema.
--
-- Gevolg: het beveiligingsmodel blijft ONGEMOEID. Alle RLS loopt via
-- can_read_org/can_write_org → user_is_org_member, en die functies veranderen
-- hier niet. Toegang tot een dochter-administratie is een ECHTE membership-rij,
-- geen impliciete erving — anders ziet ieder teamlid van de holding meteen de
-- volledige administratie van de werk-BV. Rechten per entiteit lopen via het
-- bestaande organization_members.module_access (migratie 20260730100000).
--
-- Wat wél moet meebewegen: het abonnement hoort bij de MOEDER, niet per
-- dochter. Daarom billing_root_organization() + org_family() en daarop:
--   * entitlements (creatieve module, opslag, zakelijke module) van de moeder;
--   * opslagverbruik opgeteld over de hele boom tegen de limiet van de moeder;
--   * seats UNIEK geteld op user_id over de boom — iemand die in de holding én
--     de werk-BV zit is één licentie, anders betaalt de klant dubbel voor
--     dezelfde persoon.
--
-- Prijzen: de zakelijke module en de prijs per extra administratie staan hier
-- met een startwaarde in de plancatalogus. Ze staan in de DATABASE, dus de PO
-- past ze aan met een UPDATE — daar is geen migratie voor nodig.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Rechtsvorm per administratie
-- ------------------------------------------------------------
alter table public.company_settings
  add column if not exists legal_form text not null default 'eenmanszaak';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_settings'::regclass
      and conname = 'company_settings_legal_form_check'
  ) then
    alter table public.company_settings drop constraint company_settings_legal_form_check;
  end if;
  alter table public.company_settings
    add constraint company_settings_legal_form_check
    check (legal_form in (
      'eenmanszaak','vof','maatschap','cv',
      'bv','nv','cooperatie',
      'stichting','vereniging'
    ));
end $$;

comment on column public.company_settings.legal_form is
  'Rechtsvorm van deze administratie. Stuurt het rekeningschema, de resultaatbestemming en welke fiscale schermen zichtbaar zijn.';

-- Rechtsvorm van een organisatie. company_settings kan ontbreken (een verse
-- organisatie krijgt pas een rij zodra iemand de instellingen opent), dus
-- altijd terugvallen op de veiligste aanname: eenmanszaak.
create or replace function public.org_legal_form(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select cs.legal_form from public.company_settings cs where cs.organization_id = p_organization_id),
    'eenmanszaak'
  );
$$;

-- Fiscaal regime. Bewust drie waarden:
--   'ib'    — de winst landt bij een natuurlijk persoon in de inkomstenbelasting
--             (eenmanszaak, vof, maatschap, cv). Urencriterium en
--             ondernemersaftrek horen hier.
--   'vpb'   — zelfstandig belastingplichtig voor de vennootschapsbelasting.
--   'other' — stichting en vereniging: alleen Vpb-plichtig vóór zover ze een
--             onderneming drijven. Dat kunnen wij niet bepalen, dus we doen er
--             geen uitspraak over en zetten de fiscale schermen niet
--             automatisch aan.
create or replace function public.org_fiscal_regime(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case public.org_legal_form(p_organization_id)
    when 'bv' then 'vpb'
    when 'nv' then 'vpb'
    when 'cooperatie' then 'vpb'
    when 'stichting' then 'other'
    when 'vereniging' then 'other'
    else 'ib'
  end;
$$;

-- Kapitaalvennootschap: heeft aandelen, dus aandeelhoudersregister, dividend,
-- uitkeringstoets en een DGA. Een coöperatie is wél Vpb-plichtig maar heeft
-- leden in plaats van aandeelhouders — vandaar een aparte functie.
create or replace function public.org_is_corporate(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.org_legal_form(p_organization_id) in ('bv','nv');
$$;

revoke all on function public.org_legal_form(uuid) from public;
grant execute on function public.org_legal_form(uuid) to authenticated, service_role;
revoke all on function public.org_fiscal_regime(uuid) from public;
grant execute on function public.org_fiscal_regime(uuid) to authenticated, service_role;
revoke all on function public.org_is_corporate(uuid) from public;
grant execute on function public.org_is_corporate(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. De administratie-boom
-- ------------------------------------------------------------
alter table public.organizations
  add column if not exists parent_organization_id uuid references public.organizations(id) on delete restrict;

comment on column public.organizations.parent_organization_id is
  'Moederorganisatie in de administratie-boom (holding). Null = zelfstandige organisatie. Maximaal één niveau diep; het abonnement hoort altijd bij de moeder.';

create index if not exists idx_organizations_parent on public.organizations(parent_organization_id)
  where parent_organization_id is not null;

-- on delete restrict hierboven is bewust: een moeder met administraties eronder
-- mag niet zomaar verdwijnen en de boekhouding van de dochters meenemen.

create or replace function public.enforce_organization_entity_tree()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_organization_id is null then
    -- Een administratie mag niet stilzwijgend uit de boom vallen: dan zou ze
    -- ineens zonder abonnement zitten terwijl de boekhouding gewoon doorloopt.
    if tg_op = 'UPDATE' and old.parent_organization_id is not null then
      raise exception 'Een administratie kan niet uit de organisatiestructuur worden gehaald.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.parent_organization_id = new.id then
    raise exception 'Een organisatie kan geen administratie van zichzelf zijn.'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.parent_organization_id is not null
     and old.parent_organization_id is distinct from new.parent_organization_id then
    raise exception 'De moederorganisatie van een administratie ligt vast.'
      using errcode = '23514';
  end if;

  -- Maximaal één niveau: de moeder mag zelf geen moeder boven zich hebben.
  if not exists (
    select 1 from public.organizations o
    where o.id = new.parent_organization_id
      and o.parent_organization_id is null
  ) then
    raise exception 'De moederorganisatie bestaat niet of hangt zelf al onder een andere organisatie (maximaal één niveau).'
      using errcode = '23514';
  end if;

  if exists (select 1 from public.organizations o where o.parent_organization_id = new.id) then
    raise exception 'Deze organisatie heeft zelf administraties en kan er geen onderdeel van worden.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists organizations_entity_tree_guard on public.organizations;
create trigger organizations_entity_tree_guard
  before insert or update of parent_organization_id on public.organizations
  for each row execute function public.enforce_organization_entity_tree();

-- ------------------------------------------------------------
-- 3. Boom-helpers: waar hoort het abonnement, en wie hoort erbij
-- ------------------------------------------------------------
create or replace function public.billing_root_organization(p_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(o.parent_organization_id, o.id) from public.organizations o where o.id = p_organization_id),
    p_organization_id
  );
$$;

comment on function public.billing_root_organization(uuid) is
  'De organisatie waar het abonnement, de seats, de opslagbundel en de modules bij horen: de moeder, of de organisatie zelf als die zelfstandig is.';

-- De hele boom waar deze organisatie bij hoort: de moeder plus al haar
-- administraties. Voor seats, opslag en straks consolidatie.
create or replace function public.org_family(p_organization_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with root as (select public.billing_root_organization(p_organization_id) as id)
  select r.id from root r
  union
  select o.id from public.organizations o join root r on o.parent_organization_id = r.id;
$$;

revoke all on function public.billing_root_organization(uuid) from public;
grant execute on function public.billing_root_organization(uuid) to authenticated, service_role;
revoke all on function public.org_family(uuid) from public;
grant execute on function public.org_family(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Plancatalogus: zakelijke module + extra administraties
-- ------------------------------------------------------------
alter table public.billing_plans
  add column if not exists business_addon_price_cents integer not null default 0 check (business_addon_price_cents >= 0),
  add column if not exists business_addon_yearly_price_cents integer not null default 0 check (business_addon_yearly_price_cents >= 0),
  add column if not exists entity_addon_price_cents integer not null default 0 check (entity_addon_price_cents >= 0),
  add column if not exists entity_addon_yearly_price_cents integer not null default 0 check (entity_addon_yearly_price_cents >= 0);

-- STARTPRIJZEN — door de PO te bevestigen. Alleen invullen waar nog 0 staat,
-- zodat een prijswijziging in de database een re-run overleeft.
-- Zakelijke module €19,00 p/m — €190,00 p/j (twee maanden gratis bij
-- jaarbetaling, gelijk aan de rest van de catalogus).
update public.billing_plans
  set business_addon_price_cents = 1900
  where plan_key in ('starter','team','pro') and business_addon_price_cents = 0;
update public.billing_plans
  set business_addon_yearly_price_cents = 19000
  where plan_key in ('starter','team','pro') and business_addon_yearly_price_cents = 0;
-- Extra administratie boven het inbegrepen aantal: €9,00 p/m — €90,00 p/j.
update public.billing_plans
  set entity_addon_price_cents = 900
  where plan_key in ('starter','team','pro') and entity_addon_price_cents = 0;
update public.billing_plans
  set entity_addon_yearly_price_cents = 9000
  where plan_key in ('starter','team','pro') and entity_addon_yearly_price_cents = 0;

-- Twee administraties inbegrepen bij de module: precies een holding met één
-- werk-BV, de veruit meest voorkomende structuur.
update public.billing_plans
  set limits = limits || jsonb_build_object('included_entities', 2)
  where plan_key in ('starter','team','pro') and not (limits ? 'included_entities');

-- Custom-contracten worden handmatig afgestemd: module inbegrepen, geen limiet.
update public.billing_plans
  set limits = limits || jsonb_build_object('business_included', true)
  where plan_key = 'custom' and not (limits ? 'business_included');

-- ------------------------------------------------------------
-- 5. Het billingprofiel: module aan/uit + gekochte extra administraties
-- ------------------------------------------------------------
alter table public.organization_billing_profiles
  add column if not exists business_enabled boolean not null default false,
  add column if not exists business_grace_until timestamptz,
  add column if not exists entity_addons integer not null default 0 check (entity_addons >= 0);

comment on column public.organization_billing_profiles.business_enabled is
  'Zakelijke module (BV-boekhouding, vennootschapsbelasting, jaarrekening) als betaalde optie op het abonnement.';
comment on column public.organization_billing_profiles.business_grace_until is
  'Tot wanneer bestaande administraties na het uitzetten leesbaar blijven.';
comment on column public.organization_billing_profiles.entity_addons is
  'Aantal administraties dat bovenop het inbegrepen aantal is bijgekocht.';

do $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations where parent_organization_id is null loop
    perform public.ensure_organization_billing_profile(v_org);
  end loop;
end $$;

-- Grandfathering is hier niet aan de orde: er bestaat vandaag geen enkele
-- BV-administratie, dus iedereen start met de module uit en rechtsvorm
-- 'eenmanszaak'. Dat is ook de veilige kant: er verandert niets voor bestaande
-- klanten.

-- ------------------------------------------------------------
-- 6. Entitlement-functies voor de zakelijke module
--    (zelfde vorm als org_has_creative, maar altijd via de moeder)
-- ------------------------------------------------------------
create or replace function public.org_has_business(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.billing_exempt
        or bp.limits -> 'business_included' = 'true'::jsonb
        or p.business_enabled
    from public.organization_billing_profiles p
    join public.billing_plans bp on bp.plan_key = p.plan_key
    where p.organization_id = public.billing_root_organization(p_organization_id)
  ), false);
$$;

create or replace function public.org_business_in_grace(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select not public.org_has_business(p_organization_id)
       and p.business_grace_until is not null
       and p.business_grace_until > now()
    from public.organization_billing_profiles p
    where p.organization_id = public.billing_root_organization(p_organization_id)
  ), false);
$$;

-- Hoeveel administraties mag deze klant hebben? null = onbeperkt (custom /
-- vrijgesteld). Zonder de module telt alleen de organisatie zelf.
create or replace function public.org_entity_allowance(p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.org_has_business(p_organization_id) then 1
    else (
      select case
        when p.billing_exempt then null
        when nullif(bp.limits->>'included_entities', '') is null then null
        else (bp.limits->>'included_entities')::integer + coalesce(p.entity_addons, 0)
      end
      from public.organization_billing_profiles p
      join public.billing_plans bp on bp.plan_key = p.plan_key
      where p.organization_id = public.billing_root_organization(p_organization_id)
    )
  end;
$$;

create or replace function public.org_entity_count(p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.org_family(p_organization_id);
$$;

revoke all on function public.org_has_business(uuid) from public;
grant execute on function public.org_has_business(uuid) to authenticated, service_role;
revoke all on function public.org_business_in_grace(uuid) from public;
grant execute on function public.org_business_in_grace(uuid) to authenticated, service_role;
revoke all on function public.org_entity_allowance(uuid) from public;
grant execute on function public.org_entity_allowance(uuid) to authenticated, service_role;
revoke all on function public.org_entity_count(uuid) from public;
grant execute on function public.org_entity_count(uuid) to authenticated, service_role;

-- Statusfunctie voor de app: leesbaar voor elk org-lid, want ieder teamlid moet
-- weten of de fiscale schermen er horen te zijn.
create or replace function public.organization_business_status(p_organization_id uuid)
returns table (
  active boolean,
  enabled boolean,
  included_in_plan boolean,
  in_grace boolean,
  grace_until timestamptz,
  legal_form text,
  fiscal_regime text,
  is_corporate boolean,
  is_child boolean,
  root_organization_id uuid,
  entity_count integer,
  entity_allowance integer,
  addon_price_cents integer,
  addon_yearly_price_cents integer,
  entity_addon_price_cents integer,
  entity_addon_yearly_price_cents integer,
  billing_interval text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_root uuid;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  v_root := public.billing_root_organization(p_organization_id);

  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = v_root;

  if not found then
    return query select
      false, false, false, false, null::timestamptz,
      public.org_legal_form(p_organization_id),
      public.org_fiscal_regime(p_organization_id),
      public.org_is_corporate(p_organization_id),
      (v_root <> p_organization_id),
      v_root,
      public.org_entity_count(p_organization_id),
      1,
      0, 0, 0, 0,
      'month'::text;
    return;
  end if;

  select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;

  return query select
    public.org_has_business(p_organization_id),
    v_profile.business_enabled,
    coalesce(v_plan.limits -> 'business_included' = 'true'::jsonb, false) or v_profile.billing_exempt,
    public.org_business_in_grace(p_organization_id),
    v_profile.business_grace_until,
    public.org_legal_form(p_organization_id),
    public.org_fiscal_regime(p_organization_id),
    public.org_is_corporate(p_organization_id),
    (v_root <> p_organization_id),
    v_root,
    public.org_entity_count(p_organization_id),
    public.org_entity_allowance(p_organization_id),
    coalesce(v_plan.business_addon_price_cents, 0),
    coalesce(v_plan.business_addon_yearly_price_cents, 0),
    coalesce(v_plan.entity_addon_price_cents, 0),
    coalesce(v_plan.entity_addon_yearly_price_cents, 0),
    coalesce(v_profile.billing_interval, 'month');
end;
$$;

revoke all on function public.organization_business_status(uuid) from public;
grant execute on function public.organization_business_status(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Bestaande entitlements via de moeder laten lopen
--    Een dochter-administratie heeft géén eigen billingprofiel; zonder deze
--    herschrijving zou de creatieve module daar "niet gekocht" zijn en zou de
--    opslaglimiet op nul uitkomen.
-- ------------------------------------------------------------
create or replace function public.org_has_creative(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.billing_exempt
        or bp.limits -> 'creative_included' = 'true'::jsonb
        or p.creative_enabled
    from public.organization_billing_profiles p
    join public.billing_plans bp on bp.plan_key = p.plan_key
    where p.organization_id = public.billing_root_organization(p_organization_id)
  ), false);
$$;

create or replace function public.org_creative_in_grace(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select not public.org_has_creative(p_organization_id)
       and p.creative_grace_until is not null
       and p.creative_grace_until > now()
    from public.organization_billing_profiles p
    where p.organization_id = public.billing_root_organization(p_organization_id)
  ), false);
$$;

-- ------------------------------------------------------------
-- 8. Opslag: verbruik over de hele boom tegen de limiet van de moeder
--    (identiek aan 20260803010000, alleen de scope en het profiel wijzigen)
-- ------------------------------------------------------------
-- drop + create in plaats van create or replace: de live functie kan een
-- afwijkende OUT-rij hebben (Postgres weigert dan een replace). De grants staan
-- direct na de definitie, dus er ontstaat geen gat in de rechten.
drop function if exists public.organization_storage_status(uuid);
create function public.organization_storage_status(p_organization_id uuid)
returns table (
  used_bytes bigint,
  attachments_bytes bigint,
  documents_bytes bigint,
  recordings_bytes bigint,
  gallery_bytes bigint,
  contracts_bytes bigint,
  limit_bytes bigint,
  plan_storage_gb integer,
  storage_addons integer,
  storage_addon_gb integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_attachments bigint := 0;
  v_documents bigint := 0;
  v_recordings bigint := 0;
  v_gallery bigint := 0;
  v_contracts bigint := 0;
  v_contract_expr text;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_plan_gb integer;
  v_addon_gb integer;
  v_addons integer := 0;
  v_limit bigint;
  v_family uuid[];
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot het opslagverbruik van deze organisatie.' using errcode = '42501';
  end if;

  -- Eén opslagbundel per abonnement: alle administraties van de klant tellen
  -- samen tegen de limiet van de moeder.
  select array(select public.org_family(p_organization_id)) into v_family;

  select coalesce(sum(a.size_bytes), 0) into v_attachments
  from public.attachments a where a.organization_id = any(v_family);

  select coalesce(sum(coalesce(d.size_bytes, 0)), 0) into v_documents
  from public.documents d where d.organization_id = any(v_family);

  select coalesce(sum(coalesce(mr.size_bytes, 0)), 0) into v_recordings
  from public.meeting_recordings mr where mr.organization_id = any(v_family);

  select coalesce(sum(gi.size_bytes + gi.derived_bytes), 0) into v_gallery
  from public.gallery_items gi where gi.organization_id = any(v_family);

  -- Contracten staan óók in R2 (office-.docx + getekende PDF) maar hebben geen
  -- attachments-rij. De kolommen komen uit andere migraties en kunnen per
  -- omgeving nog ontbreken, dus dynamisch samenstellen i.p.v. hard verwijzen.
  select nullif(concat_ws(' + ',
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'body_size_bytes')
      then 'coalesce(c.body_size_bytes, 0)' end,
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'signed_pdf_size_bytes')
      then 'coalesce(c.signed_pdf_size_bytes, 0)' end
  ), '') into v_contract_expr;

  if v_contract_expr is not null then
    execute format('select coalesce(sum(%s), 0)::bigint from public.contracts c where c.organization_id = any($1)', v_contract_expr)
      into v_contracts using v_family;
  end if;

  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = public.billing_root_organization(p_organization_id);

  if found and not v_profile.billing_exempt then
    select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;
    if found and (v_plan.limits ? 'storage_gb') then
      v_plan_gb := nullif(v_plan.limits->>'storage_gb', '')::integer;
      v_addon_gb := coalesce(nullif(v_plan.limits->>'storage_addon_gb', '')::integer, 100);
      v_addons := coalesce(v_profile.storage_addons, 0);
      if v_plan_gb is not null then
        v_limit := (v_plan_gb::bigint + v_addons::bigint * v_addon_gb::bigint) * 1073741824;
      end if;
    end if;
  end if;

  return query select
    (v_attachments + v_documents + v_recordings + v_gallery + v_contracts),
    v_attachments,
    v_documents,
    v_recordings,
    v_gallery,
    v_contracts,
    v_limit,
    v_plan_gb,
    v_addons,
    v_addon_gb;
end;
$$;

revoke all on function public.organization_storage_status(uuid) from public;
grant execute on function public.organization_storage_status(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 9. Seats: uniek per persoon over de hele boom
--    Iemand die in de holding én in de werk-BV zit is één licentie.
-- ------------------------------------------------------------
drop function if exists public.organization_license_usage(uuid);
create function public.organization_license_usage(p_organization_id uuid)
returns table (
  organization_id uuid,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  license_status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_root uuid;
  v_family uuid[];
begin
  if not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  v_root := public.billing_root_organization(p_organization_id);
  select array(select public.org_family(p_organization_id)) into v_family;

  return query
  select
    o.id,
    o.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(o.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    o.license_status
  from public.organizations o
  left join lateral (
    -- distinct: dezelfde persoon in twee administraties is één seat
    select count(distinct om.user_id)::integer as active_members
    from public.organization_members om
    where om.organization_id = any(v_family) and om.status = 'active'
  ) active_counts on true
  left join lateral (
    -- idem voor openstaande uitnodigingen, op e-mailadres
    select count(distinct oi.email)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = any(v_family)
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and not exists (
        -- al lid ergens in de boom? dan verbruikt de uitnodiging geen extra seat
        select 1 from public.organization_members om2
        where om2.organization_id = any(v_family)
          and om2.status = 'active'
          and om2.email = oi.email
      )
  ) pending_counts on true
  where o.id = v_root;
end;
$$;

revoke all on function public.organization_license_usage(uuid) from public;
grant execute on function public.organization_license_usage(uuid) to authenticated;

-- ------------------------------------------------------------
-- 9b. Billingoverzicht: altijd dat van de moeder
--     Zonder dit zou ensure_organization_billing_profile een LEEG profiel voor
--     de dochter aanmaken en zou de klant daar een tweede abonnement zien.
--     De kolommen blijven identiek (create or replace), alleen de scope wijzigt:
--     het profiel komt van de moeder en de seats worden over de boom geteld.
-- ------------------------------------------------------------
drop function if exists public.organization_billing_overview(uuid);
create function public.organization_billing_overview(p_organization_id uuid)
returns table (
  organization_id uuid,
  plan_key text,
  plan_name text,
  included_seats integer,
  purchased_seats integer,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  subscription_status text,
  payment_status text,
  mollie_connect_status text,
  mollie_customer_id text,
  mollie_mandate_id text,
  mollie_subscription_id text,
  last_payment_status text,
  next_invoice_date date,
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  monthly_price_cents integer,
  extra_seat_price_cents integer,
  currency text,
  billing_exempt boolean,
  billing_interval text,
  yearly_price_cents integer,
  extra_seat_yearly_price_cents integer,
  storage_addons integer,
  plan_storage_gb integer,
  storage_addon_gb integer,
  storage_addon_price_cents integer,
  storage_addon_yearly_price_cents integer,
  storage_limit_gb integer,
  storage_used_bytes bigint,
  creative_enabled boolean,
  creative_included_in_plan boolean,
  creative_active boolean,
  creative_grace_until timestamptz,
  creative_addon_price_cents integer,
  creative_addon_yearly_price_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_root uuid;
  v_family uuid[];
  v_org uuid;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen billing bekijken.' using errcode = '42501';
  end if;

  v_root := public.billing_root_organization(p_organization_id);
  select array(select public.org_family(p_organization_id)) into v_family;

  foreach v_org in array v_family loop
    perform public.expire_stale_organization_invitations(v_org);
  end loop;

  v_profile := public.ensure_organization_billing_profile(v_root);

  return query
  select
    p.organization_id,
    p.plan_key,
    bp.name,
    p.included_seats,
    p.purchased_seats,
    p.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(p.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    p.subscription_status,
    p.payment_status,
    p.mollie_connect_status,
    p.mollie_customer_id,
    p.mollie_mandate_id,
    p.mollie_subscription_id,
    p.last_payment_status,
    p.next_invoice_date,
    p.trial_ends_at,
    p.current_period_ends_at,
    bp.monthly_price_cents,
    bp.extra_seat_price_cents,
    bp.currency,
    p.billing_exempt,
    p.billing_interval,
    bp.yearly_price_cents,
    bp.extra_seat_yearly_price_cents,
    coalesce(p.storage_addons, 0),
    nullif(bp.limits->>'storage_gb', '')::integer,
    coalesce(nullif(bp.limits->>'storage_addon_gb', '')::integer, 100),
    bp.storage_addon_price_cents,
    bp.storage_addon_yearly_price_cents,
    case
      when p.billing_exempt then null
      when nullif(bp.limits->>'storage_gb', '') is null then null
      else (nullif(bp.limits->>'storage_gb', '')::integer
            + coalesce(p.storage_addons, 0) * coalesce(nullif(bp.limits->>'storage_addon_gb', '')::integer, 100))
    end,
    coalesce(storage_counts.used_bytes, 0)::bigint,
    p.creative_enabled,
    (coalesce(bp.limits -> 'creative_included' = 'true'::jsonb, false) or p.billing_exempt),
    public.org_has_creative(p.organization_id),
    p.creative_grace_until,
    coalesce(bp.creative_addon_price_cents, 0),
    coalesce(bp.creative_addon_yearly_price_cents, 0)
  from public.organization_billing_profiles p
  join public.billing_plans bp on bp.plan_key = p.plan_key
  left join lateral (
    select count(distinct om.user_id)::integer as active_members
    from public.organization_members om
    where om.organization_id = any(v_family) and om.status = 'active'
  ) active_counts on true
  left join lateral (
    select count(distinct oi.email)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = any(v_family)
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and not exists (
        select 1 from public.organization_members om2
        where om2.organization_id = any(v_family)
          and om2.status = 'active'
          and om2.email = oi.email
      )
  ) pending_counts on true
  left join lateral (
    select s.used_bytes from public.organization_storage_status(p.organization_id) s
  ) storage_counts on true
  where p.organization_id = v_root;
end;
$$;

revoke all on function public.organization_billing_overview(uuid) from public;
grant execute on function public.organization_billing_overview(uuid) to authenticated;

-- ------------------------------------------------------------
-- 10. Mutatietypes voor de administratie
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.organization_license_changes'::regclass
      and conname = 'organization_license_changes_change_type_check'
  ) then
    alter table public.organization_license_changes drop constraint organization_license_changes_change_type_check;
  end if;
  alter table public.organization_license_changes
    add constraint organization_license_changes_change_type_check
    check (change_type in ('initial','plan_change','seat_purchase','seat_downgrade_request','manual_correction','billing_sync','subscription_cancelled','storage_purchase','creative_change','business_change','entity_change'));
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check'
  ) then
    alter table public.audit_logs drop constraint audit_logs_action_check;
  end if;
  alter table public.audit_logs
    add constraint audit_logs_action_check
    check (action in (
      'created','updated','deleted','invited','accepted','revoked','role_changed','disabled','expired',
      'mollie_connected','plan_changed','seat_purchased','seat_downgrade_requested',
      'payment_succeeded','payment_failed','payment_expired','subscription_cancelled',
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced',
      'quote_submitted_for_approval','quote_internal_approved','quote_internal_rejected',
      'quote_sent_to_client','quote_client_accepted','quote_client_rejected',
      'quote_email_delivered','quote_email_failed','quote_version_created','quote_pdf_attached',
      'invoice_created_from_quote','invoice_sent_to_client','invoice_payment_link_created','invoice_paid',
      'invoice_refunded','credit_note_issued',
      'invoice_charged_back','chargeback_reversed','credit_note_emailed',
      'invoice_reminder_sent',
      'dunning_notice_sent',
      'storage_purchased',
      'creative_module_enabled','creative_module_disabled',
      'business_module_enabled','business_module_disabled','entity_created'
    ));
end $$;

-- ------------------------------------------------------------
-- 11. RPC: de zakelijke module aan- of uitzetten
--     (kloon van apply_organization_creative_change; de edge function PATcht
--     het Mollie-bedrag en legt de mutatie hier vast.)
--     UITZETTEN = BEVRIEZEN MET RESPIJT, niet weggooien: een administratie met
--     grootboek mag nooit onbereikbaar worden door een betaalprobleem.
-- ------------------------------------------------------------
create or replace function public.apply_organization_business_change(
  p_organization_id uuid,
  p_enabled boolean,
  p_grace_days integer default 30,
  p_metadata jsonb default '{}'::jsonb
)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_root uuid := public.billing_root_organization(p_organization_id);
  v_enabled boolean := coalesce(p_enabled, false);
  v_grace_days integer := greatest(coalesce(p_grace_days, 30), 0);
begin
  v_profile := public.ensure_organization_billing_profile(v_root);

  update public.organization_billing_profiles
  set business_enabled = v_enabled,
      -- Aanzetten wist de respijt; uitzetten start hem. Een tweede keer
      -- uitzetten verlengt de respijt bewust NIET.
      business_grace_until = case
        when v_enabled then null
        when business_grace_until is not null and business_grace_until > now() then business_grace_until
        else now() + make_interval(days => v_grace_days)
      end,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where organization_id = v_root
  returning * into v_profile;

  insert into public.organization_license_changes(
    organization_id, billing_profile_id, change_type, status,
    old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
    reason, applied_at, metadata
  ) values (
    v_root, v_profile.id, 'business_change', 'applied',
    v_profile.plan_key, v_profile.plan_key, v_profile.licensed_seats, v_profile.licensed_seats, 0,
    case when v_enabled then 'Zakelijke module aangezet.' else 'Zakelijke module uitgezet.' end,
    now(), coalesce(p_metadata, '{}'::jsonb)
  );

  perform public.log_billing_audit(
    v_root,
    case when v_enabled then 'business_module_enabled' else 'business_module_disabled' end,
    'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object(
      'source', 'apply_organization_business_change',
      'business_enabled', v_enabled,
      'grace_until', v_profile.business_grace_until
    ) || coalesce(p_metadata, '{}'::jsonb),
    null
  );

  return v_profile;
end;
$$;

revoke all on function public.apply_organization_business_change(uuid, boolean, integer, jsonb) from public;
grant execute on function public.apply_organization_business_change(uuid, boolean, integer, jsonb) to service_role;

-- ------------------------------------------------------------
-- 12. RPC: een administratie toevoegen onder de huidige organisatie
-- ------------------------------------------------------------
create or replace function public.create_child_organization(
  p_parent_organization_id uuid,
  p_name text,
  p_legal_form text default 'bv'
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_parent uuid;
  v_base_slug text;
  v_slug text;
  v_counter int := 1;
  v_org public.organizations;
  v_allowance integer;
  v_legal_form text := coalesce(nullif(trim(p_legal_form), ''), 'bv');
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if p_parent_organization_id is null then
    raise exception 'Organisatie ontbreekt' using errcode = '23514';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Naam van de administratie ontbreekt' using errcode = '23514';
  end if;
  if v_legal_form not in ('eenmanszaak','vof','maatschap','cv','bv','nv','cooperatie','stichting','vereniging') then
    raise exception 'Onbekende rechtsvorm: %', v_legal_form using errcode = '22023';
  end if;

  -- De moeder wordt EXPLICIET meegegeven (de app stuurt de actieve organisatie
  -- mee). Zelf de moeder opzoeken zou misgaan bij iemand die owner is van twee
  -- losse bedrijven: dan belandt de administratie onder de verkeerde.
  -- Wie vanuit een dochter aanmaakt, hangt hem onder dezelfde moeder — nooit
  -- onder de dochter, want de boom is maximaal één niveau diep.
  v_parent := public.billing_root_organization(p_parent_organization_id);

  if not public.user_has_org_role(v_parent, array['owner']) then
    raise exception 'Alleen een owner van de hoofdorganisatie kan een administratie toevoegen.' using errcode = '42501';
  end if;

  if not public.org_has_business(v_parent) then
    raise exception 'Meerdere administraties horen bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  v_allowance := public.org_entity_allowance(v_parent);
  if v_allowance is not null and public.org_entity_count(v_parent) >= v_allowance then
    -- Bijkopen gaat (nog) niet self-service: entity_addons wordt handmatig
    -- gezet. Verwijs dus niet naar een knop die er niet is.
    raise exception 'Je abonnement bevat % administraties. Neem contact op om er een bij te kopen.', v_allowance
      using errcode = '42501';
  end if;

  v_base_slug := public.slugify(p_name);
  v_slug := v_base_slug;
  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_counter := v_counter + 1;
    v_slug := left(v_base_slug, 52) || '-' || v_counter::text;
  end loop;

  insert into public.organizations(name, slug, created_by, parent_organization_id)
  values (trim(p_name), v_slug, v_user_id, v_parent)
  returning * into v_org;

  -- Toegang is expliciet, niet geërfd. Alle owners van de moeder krijgen een
  -- echte membership-rij (zij zijn de rekeninghouders en owners zijn peers —
  -- zie de owner-peer-bescherming in 20260802000000). Gewone teamleden krijgen
  -- niets: die worden per administratie uitgenodigd, met eigen modulerechten.
  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by)
  select v_org.id, om.user_id, om.email, 'owner', 'active', v_user_id
  from public.organization_members om
  where om.organization_id = v_parent
    and om.status = 'active'
    and om.role = 'owner'
  on conflict (organization_id, user_id) do nothing;

  -- De aanmaker hoort er hoe dan ook bij, ook als hij (nog) geen owner-rij op
  -- de moeder had staan maar wel via een andere weg owner is.
  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by)
  values (v_org.id, v_user_id, v_email, 'owner', 'active', v_user_id)
  on conflict (organization_id, user_id) do nothing;

  -- Rechtsvorm meteen vastleggen; adres/KvK/btw blijven leeg want die
  -- verschillen per entiteit. Alleen de huisstijl nemen we over zodat
  -- documenten uit de nieuwe administratie er meteen goed uitzien.
  insert into public.company_settings(organization_id, company_name, legal_form)
  values (v_org.id, trim(p_name), v_legal_form)
  on conflict (organization_id) do update set legal_form = excluded.legal_form;

  update public.company_settings cs
  set brand_accent_color = parent.brand_accent_color,
      brand_logo_data_url = parent.brand_logo_data_url,
      brand_heading_font  = parent.brand_heading_font,
      brand_body_font     = parent.brand_body_font
  from public.company_settings parent
  where cs.organization_id = v_org.id
    and parent.organization_id = v_parent;

  perform public.log_billing_audit(
    v_parent, 'entity_created', 'organization', v_org.id, null,
    jsonb_build_object(
      'source', 'create_child_organization',
      'child_organization_id', v_org.id,
      'name', trim(p_name),
      'legal_form', v_legal_form
    ),
    null
  );

  return v_org;
end;
$$;

revoke all on function public.create_child_organization(uuid, text, text) from public;
grant execute on function public.create_child_organization(uuid, text, text) to authenticated;

commit;
