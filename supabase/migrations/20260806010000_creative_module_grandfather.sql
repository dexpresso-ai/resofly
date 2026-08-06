-- ============================================================
-- ResoFly — Bestaande klanten houden de creatieve module
-- Date: 2026-08-06
--
-- 20260806000000 maakte de galerij een betaalde optie. Wie vandaag al klant is,
-- verliest daarmee zonder waarschuwing een functie die hij gebruikt (of straks
-- wil gebruiken). Dat is geen paywall, dat is een supportvraag. Dus: iedere
-- organisatie die op dit moment bestaat houdt de module. Nieuwe organisaties
-- die zich hierna aanmelden beginnen zonder, en vinken hem aan bij de aanschaf.
--
-- Wil je een specifieke organisatie er alsnog buiten hebben, dan is dat één
-- aanroep waard:
--   select public.apply_organization_creative_change('<org-uuid>', false);
--
-- Bewust via apply_organization_creative_change en niet via een kale UPDATE:
-- zo krijgt elke organisatie dezelfde papieren trail (license_change + audit)
-- als bij een gewone aan-zetten, en wordt de functie meteen echt uitgevoerd.
--
-- Overgeslagen: organisaties waar de module al aan staat, vrijgestelde (interne)
-- organisaties en plannen die hem al bevatten — die hebben hem sowieso.
-- ============================================================

begin;

do $$
declare
  v_org uuid;
  v_count integer := 0;
begin
  for v_org in
    select p.organization_id
    from public.organization_billing_profiles p
    left join public.billing_plans bp on bp.plan_key = p.plan_key
    where p.creative_enabled = false
      and p.billing_exempt = false
      and coalesce(bp.limits -> 'creative_included' <> 'true'::jsonb, true)
    order by p.organization_id
  loop
    perform public.apply_organization_creative_change(
      v_org,
      true,
      30,
      jsonb_build_object(
        'source', 'grandfather_2026_08_06',
        'reason', 'Bestaande klant houdt de galerij bij de invoering van de creatieve module.'
      )
    );
    v_count := v_count + 1;
  end loop;

  raise notice 'Creatieve module toegekend aan % bestaande organisatie(s).', v_count;
end $$;

commit;
