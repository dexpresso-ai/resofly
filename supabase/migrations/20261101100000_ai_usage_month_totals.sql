-- ============================================================
-- ResoFly — AI-verbruik van deze maand, opgeteld in de database
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt M).
--
-- Het AI-budget telde alleen per gebruiker, en haalde daarvoor elke regel van
-- de maand op. Er komt nu ook een plafond per organisatie bij (meer teamleden
-- of geautomatiseerde agents maken anders samen onbeperkt kosten), en dan is
-- optellen in de database nodig: een drukke organisatie heeft duizenden regels
-- per maand. Alleen de service-role (de edge functions) roept dit aan.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.ai_usage_month_totals(p_user_id uuid, p_organization_id uuid)
returns table (user_usd numeric, org_usd numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select sum(u.cost_usd) from public.ai_usage u
               where p_user_id is not null and u.user_id = p_user_id
                 and u.created_at >= date_trunc('month', now())), 0)::numeric,
    coalesce((select sum(u.cost_usd) from public.ai_usage u
               where p_organization_id is not null and u.organization_id = p_organization_id
                 and u.created_at >= date_trunc('month', now())), 0)::numeric;
$$;

revoke all on function public.ai_usage_month_totals(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ai_usage_month_totals(uuid, uuid) to service_role;

commit;
