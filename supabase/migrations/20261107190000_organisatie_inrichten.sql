-- ============================================================
-- ResoFly — Organisatie inrichten: eerst de stappen, dan de werkruimte
-- Date: 2026-11-07
--
-- Vraag: "Wanneer er een nieuwe gebruiker aangemaakt wordt, dien je eerst een
-- stappenplan te doorlopen om je organisatie in te stellen alvorens je door
-- kunt." Met de rechtsvorm voorop, de overige keuzes erbij, en hoe je Mollie
-- koppelt.
--
-- Tot nu toe kwam een nieuwe gebruiker meteen in een lege werkruimte, met een
-- organisatie die naar het begin van zijn e-mailadres heette ("Info" voor
-- info@…) en rechtsvorm eenmanszaak. Bedrijfsgegevens, btw en betalen moest
-- hij zelf in Instellingen vinden. Wie een BV had, zag pas bij de boekhouding
-- dat de administratie als eenmanszaak liep.
--
-- Nu:
--   - organizations.onboarding_completed_at: wanneer de stappen zijn afgerond.
--     Leeg = de app toont eerst de stappen (src/features/OrganizationSetup.tsx)
--     aan de eigenaar of een beheerder; een ander teamlid ziet dat de
--     organisatie nog wordt ingericht. Bestaande organisaties staan op
--     afgerond: die werken al.
--   - complete_organization_onboarding(): rondt af. Alleen een actieve owner
--     of admin van die organisatie, en alleen als er een bedrijfsnaam is. De
--     naam in ResoFly wordt die van het bedrijf. Rechtstreeks bijwerken kan
--     niet: op organizations mag een gebruiker alleen de naam wijzigen
--     (20260926000000), dus ook een nieuwe kolom niet.
--   - ensure_user_default_organization() maakt geen eigen organisatie meer
--     voor wie een openstaande uitnodiging heeft. Die persoon hoort bij het
--     team dat hem uitnodigde. Eerder kreeg een uitgenodigd teamlid er bij de
--     eerste login ongevraagd een lege organisatie bij, en zou hij nu dus de
--     inrichtingsstappen krijgen voor een bedrijf dat hij niet heeft. Hij ziet
--     nu meteen zijn uitnodiging, met de knop om toch een eigen organisatie te
--     maken. Voor de boekhouder gold dit al (20261011000000).
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Wanneer de organisatie is ingericht, en door wie
-- ------------------------------------------------------------
-- Bestaande organisaties zijn al ingericht. De standaardwaarde vult ze bij het
-- toevoegen van de kolom, zonder triggers: dus geen regel "gewijzigd" in het
-- auditlog van elke organisatie en geen nieuwe updated_at. Daarna gaat de
-- standaard eraf, zodat een nieuwe organisatie leeg begint. Draait dit nog
-- eens, dan bestaat de kolom al en gebeurt er niets: een organisatie die na de
-- uitrol is aangemaakt, slaat de stappen dan niet alsnog over.
alter table public.organizations
  add column if not exists onboarding_completed_at timestamptz default now();
alter table public.organizations
  alter column onboarding_completed_at drop default;

alter table public.organizations
  add column if not exists onboarding_completed_by uuid references auth.users(id) on delete set null;

comment on column public.organizations.onboarding_completed_at is
  'Wanneer de inrichtingsstappen zijn afgerond (complete_organization_onboarding). Leeg = de app toont eerst de stappen. Organisaties van vóór 2026-11-07 staan op afgerond.';
comment on column public.organizations.onboarding_completed_by is
  'Wie de inrichtingsstappen afrondde.';

-- ------------------------------------------------------------
-- 2. Afronden
-- ------------------------------------------------------------
create or replace function public.complete_organization_onboarding(
  p_organization_id uuid,
  p_display_name text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org public.organizations;
  v_company_name text;
  v_trade_name text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt' using errcode = '22023';
  end if;
  -- De organisatie komt uit de aanroep, de rol uit de sessie (auth.uid()).
  -- Wie geen lid is, krijgt dezelfde melding als wie de verkeerde rol heeft:
  -- zo is dit geen manier om na te gaan welke organisaties er bestaan.
  if not public.user_has_org_role(p_organization_id, array['owner', 'admin']) then
    raise exception 'Alleen de eigenaar of een beheerder kan de organisatie inrichten.'
      using errcode = '42501';
  end if;

  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found then
    raise exception 'Organisatie niet gevonden' using errcode = 'P0002';
  end if;
  -- Al afgerond, in een ander tabblad of met een dubbele klik: niets te doen.
  if v_org.onboarding_completed_at is not null then
    return v_org;
  end if;

  select nullif(btrim(cs.company_name), ''), nullif(btrim(cs.trade_name), '')
    into v_company_name, v_trade_name
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
  if v_company_name is null then
    raise exception 'Vul eerst de naam van je bedrijf in.' using errcode = '23514';
  end if;

  -- De naam in ResoFly: wat de app meegeeft (de handelsnaam of de
  -- bedrijfsnaam), anders die uit de bedrijfsgegevens. Op één regel en
  -- hooguit 120 tekens, net als in de organisatiekiezer.
  v_name := left(btrim(regexp_replace(
    coalesce(nullif(btrim(p_display_name), ''), v_trade_name, v_company_name),
    '[[:cntrl:]]+', ' ', 'g')), 120);

  update public.organizations
     set onboarding_completed_at = now(),
         onboarding_completed_by = v_user_id,
         name = coalesce(nullif(v_name, ''), name)
   where id = p_organization_id
  returning * into v_org;

  return v_org;
end;
$$;

revoke all on function public.complete_organization_onboarding(uuid, text) from public, anon;
grant execute on function public.complete_organization_onboarding(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Geen eigen organisatie voor wie is uitgenodigd
--    (zelfde functie als in 20261101010000, met de uitnodiging van elk soort
--    in plaats van alleen die van de boekhouder)
-- ------------------------------------------------------------
create or replace function public.ensure_user_default_organization()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;

  update public.organization_members
  set email = coalesce(email, v_email), updated_at = now()
  where user_id = v_user_id and email is null;

  if exists (select 1 from public.organization_members where user_id = v_user_id and status = 'active') then
    return;
  end if;

  -- Een openstaande uitnodiging, als teamlid of als boekhouder: eerst daarover
  -- beslissen. De app toont de uitnodiging, met de knop "Of maak een eigen
  -- organisatie". Tot 7 november 2026 gold dit alleen voor de boekhouder.
  if v_email is not null and exists (
    select 1 from public.organization_invitations oi
    where oi.email = v_email
      and oi.status = 'pending'
      and (oi.expires_at is null or oi.expires_at > now())
  ) then
    return;
  end if;

  -- Een klant uit het portaal is klant van een organisatie, niet van ResoFly:
  -- geen eigen werkruimte. De app toont dan de weg naar het klantportaal.
  if public.is_portal_only_account(v_user_id) then
    return;
  end if;

  v_name := coalesce(nullif(split_part(v_email::text, '@', 1), ''), 'Mijn organisatie');
  perform public.create_organization(initcap(v_name));
end;
$$;

revoke all on function public.ensure_user_default_organization() from public, anon;
grant execute on function public.ensure_user_default_organization() to authenticated, service_role;

commit;
