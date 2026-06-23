-- ============================================================
-- ResoFly — Gerrie AI: maandelijkse kostenlimiet per gebruiker
-- Date: 2026-06-23
--
-- Scope:
-- - Voegt `user_id` toe aan `ai_usage` zodat het verbruik per gebruiker (over al
--   zijn organisaties heen) per maand opgeteld kan worden.
-- - De handhaving zelf zit in de `gerrie-agent` Edge Function: vóór elke
--   Claude-call wordt het maandverbruik van de gebruiker vergeleken met één vaste
--   limiet (secret GERRIE_MONTHLY_USER_COST_EUR, in euro's). Boven de limiet
--   blokkeert Gerrie netjes i.p.v. een call te doen.
-- ============================================================

begin;

alter table public.ai_usage
  add column if not exists user_id uuid references auth.users(id) on delete set null;

-- Snelle som van het maandverbruik per gebruiker.
create index if not exists idx_ai_usage_user_month
  on public.ai_usage(user_id, created_at desc);

commit;
