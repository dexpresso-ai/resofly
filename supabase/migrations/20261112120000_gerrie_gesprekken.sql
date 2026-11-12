-- ============================================================
-- ResoFly — Gerrie: je gesprekken terugvinden
-- Date: 2026-11-12
--
-- WAAROM
-- Elk gesprek met Gerrie stond al in ai_conversations en ai_messages, maar de
-- app liet ze nergens zien. Wie de chat sloot of van organisatie wisselde, was
-- het gesprek kwijt. Onder Gerrie → Gesprekken lees je ze nu terug, zoek je
-- erin en praat je verder waar je gebleven was.
--
-- WAT
-- 1. ai_conversations.kind: wat voor gesprek het is. Dezelfde tabel bewaart
--    ook het verslag van een agent-run, een proefrun, de agent-bouwer en een
--    missieplan. Zonder dit veld stonden die tussen je chats, of moest de app
--    ze raden aan de titel ("Agent: …", "Proefrun: …").
--    Bestaande rijen krijgen hun soort uit de koppeling met een agent en de
--    vaste titels die de edge functions altijd gaven.
-- 2. Een trigger zet een gesprek dat aan een agent of run hangt altijd op
--    'agent_run'. De runner maakt eerst het gesprek en koppelt het daarna;
--    zonder trigger bleef zo'n verslag tijdens de uitrol als 'chat' staan.
-- 3. Lezen: een chat met Gerrie is van jou alleen. Tot nu toe konden owners
--    en admins via de database ook de chats van collega's lezen
--    (20260623000005). Nu de gesprekken in de app terug te vinden zijn, zou
--    dat een stille meelezer zijn op wat iemand aan zijn assistent vraagt.
--    Het toezicht op agents blijft: de verslagen van agent-runs, proefruns en
--    de bouwer zijn voor owners en admins leesbaar zoals voorheen.
--    Het auditspoor (ai_action_audit) verandert niet: wat Gerrie voorstelde
--    en wat ermee gebeurde, blijft voor owners en admins zichtbaar.
-- 4. Een index om je eigen berichten snel te doorzoeken.
--
-- SCHRIJVEN
-- Verandert niet: de app schrijft niet in deze tabellen. Verwijderen loopt
-- via de edge function gerrie-agent (action 'delete_conversation'), die zelf
-- nagaat dat het gesprek een chat is, van jou, in deze organisatie.
--
-- VALKUIL
-- De backfill raakt elke rij. De trigger ai_conversations_touch_updated_at
-- zette dan updated_at van ieder gesprek op het moment van de migratie, en de
-- lijst begon met honderden gesprekken van "vandaag". Hij staat daarom even
-- uit tijdens de backfill.
-- ============================================================

begin;

-- ── 1. De soort van een gesprek ─────────────────────────────────────────────
alter table public.ai_conversations add column if not exists kind text;

alter table public.ai_conversations disable trigger ai_conversations_touch_updated_at;

update public.ai_conversations
   set kind = case
     when agent_run_id is not null or agent_id is not null then 'agent_run'
     when title ~ '^Agent: .* — [0-9]{4}-[0-9]{2}-[0-9]{2}$' then 'agent_run'
     when title like 'Proefrun: %' then 'agent_preview'
     when title like 'Agent bouwen: %' or title like 'Agent aanpassen: %' then 'agent_builder'
     when title like 'Missie: %' then 'mission'
     else 'chat'
   end
 where kind is null;

alter table public.ai_conversations enable trigger ai_conversations_touch_updated_at;

alter table public.ai_conversations alter column kind set default 'chat';
alter table public.ai_conversations alter column kind set not null;

alter table public.ai_conversations drop constraint if exists ai_conversations_kind_check;
alter table public.ai_conversations add constraint ai_conversations_kind_check
  check (kind in ('chat', 'agent_run', 'agent_preview', 'agent_builder', 'mission'));

create index if not exists idx_ai_conversations_user_kind
  on public.ai_conversations(organization_id, created_by, kind, updated_at desc);

-- ── 2. Een gesprek aan een agent is nooit een chat ──────────────────────────
create or replace function public.ai_conversations_kind_from_agent()
returns trigger
language plpgsql
as $$
begin
  if new.agent_run_id is not null or new.agent_id is not null then
    new.kind := 'agent_run';
  end if;
  return new;
end;
$$;

-- Zoals elke nieuwe functie: niet aanroepbaar voor anon (migrationGrants.test.ts).
-- De trigger vuurt toch, ook zonder EXECUTE voor de schrijver.
revoke all on function public.ai_conversations_kind_from_agent() from public, anon, authenticated;

drop trigger if exists ai_conversations_kind_from_agent on public.ai_conversations;
create trigger ai_conversations_kind_from_agent
  before insert or update of agent_id, agent_run_id, kind on public.ai_conversations
  for each row execute function public.ai_conversations_kind_from_agent();

-- ── 3. Lezen: je chats zijn van jou ─────────────────────────────────────────
drop policy if exists "ai_conversations read" on public.ai_conversations;
create policy "ai_conversations read" on public.ai_conversations for select using (
  created_by = auth.uid()
  or (
    kind <> 'chat'
    and exists (
      select 1 from public.organization_members m
       where m.organization_id = ai_conversations.organization_id
         and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner', 'admin')
    )
  )
);

drop policy if exists "ai_messages read" on public.ai_messages;
create policy "ai_messages read" on public.ai_messages for select using (
  created_by = auth.uid()
  or exists (
    select 1
      from public.ai_conversations c
      join public.organization_members m on m.organization_id = c.organization_id
     where c.id = ai_messages.conversation_id
       and c.organization_id = ai_messages.organization_id
       and c.kind <> 'chat'
       and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner', 'admin')
  )
);

-- ── 4. Zoeken in je eigen berichten ─────────────────────────────────────────
create index if not exists idx_ai_messages_org_user
  on public.ai_messages(organization_id, created_by, created_at desc);

commit;
