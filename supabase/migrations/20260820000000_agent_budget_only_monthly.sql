-- ============================================================
-- ResoFly — één budget: het maandtegoed van het account
-- Date: 2026-08-20
--
-- `ai_agents` droeg vier grenzen die NOOIT zijn afgedwongen:
--   max_cost_eur_per_run   — nergens gelezen
--   max_runs_per_day       — nergens gelezen
--   max_iterations         — nergens gelezen (de loop gebruikt een vaste MAX_TOOL_ITERATIONS)
--   monthly_budget_eur     — wél gelezen, maar een tweede budget naast het accountbudget
--
-- Het agent-detailpaneel toonde de eerste twee wél ("Max. € 0,25 per run · hoogstens
-- 4× per dag"). Een scherm dat een grens belooft die de code niet kent is erger dan
-- geen grens tonen: je rekent erop.
--
-- PO-besluit: er is nog maar ÉÉN budget — het maandtegoed per account
-- (`checkUserBudget`, secret GERRIE_MONTHLY_USER_COST_EUR). Alles wat een agent
-- verbruikt telt daar gewoon in mee, want `ai_usage`-rijen dragen al de user_id van
-- degene namens wie de agent draait. Deze kolommen gaan er dus uit in plaats van dat
-- ze alsnog worden ingebouwd.
--
-- Wat blijft: `max_emails_per_run`. Dat is géén budget maar een blast-radius-grens op
-- echte post naar echte klanten, en die wordt wél afgedwongen (_shared/gerrieCore.ts,
-- buildClientEmailProposal).
--
-- Data-verlies is bewust en beperkt: geen van deze vier waarden stuurde ooit gedrag,
-- op monthly_budget_eur na — en dat is precies de grens die per besluit verdwijnt.
-- ============================================================

begin;

alter table public.ai_agents drop column if exists max_cost_eur_per_run;
alter table public.ai_agents drop column if exists max_runs_per_day;
alter table public.ai_agents drop column if exists max_iterations;
alter table public.ai_agents drop column if exists monthly_budget_eur;

comment on table public.ai_agents is
  'Geplande agents (Gerrie Routines). Kosten worden begrensd door het maandtegoed van het account (GERRIE_MONTHLY_USER_COST_EUR via checkUserBudget); er is bewust geen tweede budget per agent of per run.';

commit;
