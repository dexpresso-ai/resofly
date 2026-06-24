-- ============================================================
-- ResoFly — Gerrie AI: privacy van gespreksgeschiedenis (fase 4)
-- Date: 2026-06-23
--
-- Scope:
-- - ai_conversations / ai_messages waren leesbaar voor elk organisatielid. Een
--   gesprek met Gerrie is persoonlijk; we beperken het lezen tot de EIGENAAR van
--   het gesprek, plus owners/admins (oversight).
-- - ai_action_audit (uitgevoerde/voorgestelde acties) wordt admin-only, net als
--   ai_usage — dit is een controle-/auditspoor.
-- - Schrijven loopt sowieso via de service-role (Edge Function), die RLS overslaat,
--   dus de werking van Gerrie verandert niet.
-- ============================================================

begin;

drop policy if exists "ai_conversations read" on public.ai_conversations;
create policy "ai_conversations read" on public.ai_conversations for select using (
  created_by = auth.uid()
  or exists (
    select 1 from public.organization_members m
    where m.organization_id = ai_conversations.organization_id
      and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner', 'admin')
  )
);

drop policy if exists "ai_messages read" on public.ai_messages;
create policy "ai_messages read" on public.ai_messages for select using (
  created_by = auth.uid()
  or exists (
    select 1 from public.organization_members m
    where m.organization_id = ai_messages.organization_id
      and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner', 'admin')
  )
);

drop policy if exists "ai_action_audit read" on public.ai_action_audit;
create policy "ai_action_audit read" on public.ai_action_audit for select using (
  exists (
    select 1 from public.organization_members m
    where m.organization_id = ai_action_audit.organization_id
      and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner', 'admin')
  )
);

commit;
