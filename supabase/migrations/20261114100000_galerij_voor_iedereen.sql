-- ============================================================
-- ResoFly — De galerij is er voor iedereen
-- Date: 2026-11-14
--
-- Aanleiding: een klant maakte een project aan en vond nergens een galerij.
-- De galerij hoorde bij de creatieve module, een betaalde optie (€9 per maand)
-- die je alleen op een lopend abonnement kon aanzetten. Zonder die module
-- verdween het tabblad Galerij helemaal, zonder uitleg. Besluit: de galerij
-- staat voortaan open bij ieder abonnement, ook als er nog niet betaald is.
--
-- Wat er verandert:
-- 1. Elk plan krijgt limits.creative_included = true, zoals custom al had.
--    Daarmee rekent de billing-functie de module nergens meer
--    (planIncludesCreative), en tonen Instellingen → Abonnement en de
--    inrichting "Inbegrepen" in plaats van een prijs met een knop.
-- 2. org_has_creative is true voor ieder lid, los van het billingprofiel. Een
--    organisatie zonder profiel (net aangemaakt, of een dochter-administratie)
--    viel eerst terug op "niet gekocht".
-- 3. organization_creative_status leest het profiel van de moeder
--    (billing_root_organization). Hij zocht het profiel van de organisatie
--    zelf; een dochter heeft er geen (20260807000000, punt 7), dus daar was het
--    tabblad weg, terwijl de schrijf-gate het aanmaken wel toeliet.
--
-- Wat blijft: de schrijf-gate en de bevries-logica op de galerijtabellen
-- (20260806000000). Die vragen org_has_creative en laten nu alles door. Gaat de
-- galerij ooit weer achter een betaalmuur, dan is dat één functie.
--
-- Niet hier: wie de module al betaalde, houdt dat bedrag op zijn
-- Mollie-abonnement tot de volgende herberekening (andere plan, seats,
-- opslagbundel). Dat ligt bij Mollie, niet in de database.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ── 1. Elk plan: de module is inbegrepen ────────────────────────────────────

-- "is distinct from": ontbreekt de sleutel, dan geeft = NULL en sloeg
-- "not (… = …)" juist de plannen over die het nodig hadden.
update public.billing_plans
  set limits = coalesce(limits, '{}'::jsonb) || jsonb_build_object('creative_included', true)
  where (limits -> 'creative_included') is distinct from 'true'::jsonb;

-- ── 2. Toegang: ieder lid, ongeacht abonnement ──────────────────────────────

create or replace function public.org_has_creative(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- GEWIJZIGD (20261114100000): niet meer afhankelijk van het abonnement.
  -- De ledencontrole uit 20261110140000 blijft: een ingelogde gebruiker die
  -- niet bij deze organisatie of haar familie hoort, krijgt false. De server
  -- (geen auth.uid()) en de policies en triggers (altijd een lid) krijgen true.
  select not (
    auth.uid() is not null and not exists (
      select 1 from public.organization_members m
       where m.user_id = auth.uid() and m.status = 'active'
         and public.billing_root_organization(m.organization_id) = public.billing_root_organization(p_organization_id)
    )
  );
$$;

-- Blijft voor authenticated: de policies en triggers op de galerijen roepen
-- hem aan met de rechten van de gebruiker.
revoke all on function public.org_has_creative(uuid) from public, anon;
grant execute on function public.org_has_creative(uuid) to authenticated, service_role;

-- ── 3. De status voor de app, de portalen en de media-worker ────────────────

create or replace function public.organization_creative_status(p_organization_id uuid)
returns table (
  active boolean,
  enabled boolean,
  included_in_plan boolean,
  in_grace boolean,
  grace_until timestamptz,
  addon_price_cents integer,
  addon_yearly_price_cents integer,
  billing_interval text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  -- GEWIJZIGD (20261114100000): het abonnement hangt aan de moeder.
  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = public.billing_root_organization(p_organization_id);

  if found then
    select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;
  end if;

  -- Inbegrepen bij elk abonnement; ook zonder profiel staat de galerij open.
  return query select
    public.org_has_creative(p_organization_id),
    coalesce(v_profile.creative_enabled, false),
    true,
    public.org_creative_in_grace(p_organization_id),
    v_profile.creative_grace_until,
    coalesce(v_plan.creative_addon_price_cents, 0),
    coalesce(v_plan.creative_addon_yearly_price_cents, 0),
    coalesce(v_profile.billing_interval, 'month');
end;
$$;

-- Elk lid mag het weten (het tabblad Galerij hangt ervan af), de server ook.
revoke all on function public.organization_creative_status(uuid) from public, anon;
grant execute on function public.organization_creative_status(uuid) to authenticated, service_role;

commit;
