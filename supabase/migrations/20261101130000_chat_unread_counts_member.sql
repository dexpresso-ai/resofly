-- ============================================================
-- ResoFly — Ongelezen chatberichten alleen voor actieve teamleden
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt T).
--
-- chat_unread_counts() telde de ongelezen berichten in elk gesprek waarvan je
-- deelnemer was, ook als je inmiddels uit de organisatie was gezet of Teamchat
-- niet meer mocht zien. Lezen was al dicht (de module-gate vraagt een actief
-- lidmaatschap); nu ook de tellingen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.chat_unread_counts()
returns table (conversation_id uuid, unread_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select p.conversation_id,
         greatest(count(m.id)::int, case when coalesce(pr.marked_unread, false) then 1 else 0 end) as unread_count
    from public.chat_participants p
    left join public.chat_conversation_prefs pr
      on pr.conversation_id = p.conversation_id
     and pr.user_id = p.user_id
    left join public.chat_messages m
      on m.conversation_id = p.conversation_id
     and m.created_at > p.last_read_at
     and m.deleted_at is null
     and m.kind <> 'system'
     and m.sender_id is distinct from p.user_id
   where p.user_id = auth.uid()
     and public.can_read_module(p.organization_id, 'chat')
   group by p.conversation_id, pr.marked_unread
  having count(m.id) > 0 or coalesce(pr.marked_unread, false);
$$;

revoke all on function public.chat_unread_counts() from public, anon;
grant execute on function public.chat_unread_counts() to authenticated, service_role;

commit;
