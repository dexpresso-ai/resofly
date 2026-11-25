-- ============================================================
-- ResoFly — Onbeperkt AI-tegoed voor een organisatie
-- Date: 2026-11-25
--
-- Het AI-tegoed kende alleen twee plafonds voor iedereen: per gebruiker en per
-- organisatie (GERRIE_MONTHLY_USER_COST_EUR, GERRIE_MONTHLY_ORG_COST_EUR, zie
-- _shared/aiBudget.ts). De melding "vraag een beheerder om meer ruimte" kon
-- nergens op slaan: er was geen manier om één organisatie meer te geven.
--
-- Nu:
--   - organization_billing_profiles.ai_unlimited: voor zo'n organisatie geldt
--     geen enkel AI-plafond, ook niet dat per gebruiker. Anders houdt het
--     eigen tegoed van €25 een teamlid alsnog tegen, en betekent "onbeperkt"
--     niets.
--   - Wat iemand in zo'n organisatie verbruikt, telt niet mee voor zijn eigen
--     tegoed in andere organisaties. Anders raakt wie in de onbeperkte
--     organisatie werkt, elders zijn tegoed kwijt.
--   - Alleen de service-role zet de vlag (set_organization_ai_unlimited), net
--     als billing_exempt (20260626000000). Op het billingprofiel bestaat
--     geen schrijfpolicy, dus een organisatie kan zichzelf niet vrijstellen.
--   - De organisatie "Brand New Gerrie" krijgt de vlag. Op een verse database
--     bestaat die niet, en gebeurt er niets.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- 1) De vlag.
alter table public.organization_billing_profiles
  add column if not exists ai_unlimited boolean not null default false;

comment on column public.organization_billing_profiles.ai_unlimited is
  'Geen AI-plafond voor deze organisatie, ook niet per gebruiker. Alleen de service-role zet dit (set_organization_ai_unlimited).';

-- 2) Het maandverbruik, nu met de vlag erbij. Andere kolommen, dus drop en
--    create. De edge functions lezen user_usd en org_usd; die blijven, zodat
--    de oude code werkt tot de nieuwe is uitgerold.
drop function if exists public.ai_usage_month_totals(uuid, uuid);

create function public.ai_usage_month_totals(p_user_id uuid, p_organization_id uuid)
returns table (user_usd numeric, org_usd numeric, org_unlimited boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select sum(u.cost_usd) from public.ai_usage u
               where p_user_id is not null and u.user_id = p_user_id
                 and u.created_at >= date_trunc('month', now())
                 and not exists (select 1 from public.organization_billing_profiles bp
                                  where bp.organization_id = u.organization_id and bp.ai_unlimited)), 0)::numeric,
    coalesce((select sum(u.cost_usd) from public.ai_usage u
               where p_organization_id is not null and u.organization_id = p_organization_id
                 and u.created_at >= date_trunc('month', now())), 0)::numeric,
    coalesce((select bp.ai_unlimited from public.organization_billing_profiles bp
               where p_organization_id is not null and bp.organization_id = p_organization_id), false);
$$;

revoke all on function public.ai_usage_month_totals(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ai_usage_month_totals(uuid, uuid) to service_role;

-- 3) De vlag zetten. Alleen de service-role: een revoke van public alleen
--    laat de standaardrechten van Supabase voor anon en authenticated staan.
create or replace function public.set_organization_ai_unlimited(p_organization_id uuid, p_unlimited boolean)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
begin
  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  update public.organization_billing_profiles
  set ai_unlimited = coalesce(p_unlimited, false),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  perform public.log_billing_audit(
    p_organization_id,
    'billing_synced',
    'billing_profile',
    v_profile.id,
    v_profile.plan_key,
    jsonb_build_object('ai_unlimited', coalesce(p_unlimited, false), 'source', 'set_organization_ai_unlimited'),
    null
  );

  return v_profile;
end;
$$;

revoke all on function public.set_organization_ai_unlimited(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_organization_ai_unlimited(uuid, boolean) to service_role;

-- 4) Brand New Gerrie: onbeperkt. Op naam, omdat het id per database
--    verschilt. Alleen wie de vlag nog niet heeft, zodat een tweede run geen
--    extra regel in het logboek zet.
do $$
declare
  v_org uuid;
  v_count integer := 0;
begin
  for v_org in
    select o.id
    from public.organizations o
    left join public.organization_billing_profiles bp on bp.organization_id = o.id
    where lower(btrim(o.name)) = 'brand new gerrie'
      and not coalesce(bp.ai_unlimited, false)
  loop
    perform public.set_organization_ai_unlimited(v_org, true);
    v_count := v_count + 1;
  end loop;
  raise notice 'Onbeperkt AI-tegoed gezet voor % organisatie(s) met de naam Brand New Gerrie.', v_count;
end $$;

commit;
