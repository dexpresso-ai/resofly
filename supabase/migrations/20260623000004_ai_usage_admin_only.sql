-- ============================================================
-- ResoFly — Gerrie AI: verbruiksdata alleen voor admins (fase 4 dashboard)
-- Date: 2026-06-23
--
-- Scope:
-- - `ai_usage` bevat de kosten per gebruiker. Voor het AI-gebruik-dashboard
--   (Instellingen → AI-gebruik) lezen we dit client-side. Kostendata is gevoelig,
--   dus we beperken de SELECT-policy tot actieve owners/admins.
-- - De tegoed-balk en de limiethandhaving lopen via de Edge Function met de
--   service-role (die RLS overslaat), dus die blijven gewoon werken.
-- ============================================================

begin;

drop policy if exists "ai_usage read" on public.ai_usage;
create policy "ai_usage read" on public.ai_usage for select using (
  exists (
    select 1 from public.organization_members m
    where m.organization_id = ai_usage.organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  )
);

commit;
