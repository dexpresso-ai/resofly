-- ============================================================
-- ResoFly — Onbeperkt AI-tegoed voor de organisatie Gerjanvanlopik
-- Date: 2026-11-25
--
-- Zelfde vlag als bij Brand New Gerrie (20261125120000): geen AI-plafond,
-- ook niet per gebruiker. Op naam, omdat het id per database verschilt; op
-- een verse database bestaat deze organisatie niet en gebeurt er niets.
-- Alleen wie de vlag nog niet heeft, zodat een tweede run geen extra regel
-- in het logboek zet.
--
-- Veilig om meermaals te draaien.
-- ============================================================

do $$
declare
  v_org uuid;
  v_count integer := 0;
begin
  for v_org in
    select o.id
    from public.organizations o
    left join public.organization_billing_profiles bp on bp.organization_id = o.id
    where lower(btrim(o.name)) = 'gerjanvanlopik'
      and not coalesce(bp.ai_unlimited, false)
  loop
    perform public.set_organization_ai_unlimited(v_org, true);
    v_count := v_count + 1;
  end loop;
  raise notice 'Onbeperkt AI-tegoed gezet voor % organisatie(s) met de naam Gerjanvanlopik.', v_count;
end $$;
