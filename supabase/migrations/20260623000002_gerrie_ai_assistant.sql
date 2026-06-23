-- ============================================================
-- ResoFly — Gerrie AI-assistent (Claude-koppeling, fase 0-2)
-- Date: 2026-06-23
--
-- Scope:
-- - Gerrie is de drijvende chatassistent (rechtsonder in de app). Hij praat met
--   Claude via de `gerrie-agent` Edge Function. De ANTHROPIC_API_KEY staat als
--   Edge-Function-secret en komt nooit in de browser.
-- - Deze migratie legt alleen de persistentie + audit vast:
--     * ai_conversations  — één lopend gesprek per gebruiker/organisatie
--     * ai_messages       — de berichten (user/assistant), met tool-metadata
--     * ai_action_audit   — uitgevoerde acties (klaar voor fase 3: schrijf-acties
--                            die de gebruiker éérst bevestigt)
--     * ai_usage          — tokenverbruik + geschatte kosten per beurt (kostenplafond)
--
-- Beveiliging:
-- - Alle tabellen zijn org-scoped met RLS. LEZEN mag elk actief organisatielid
--   (can_read_org), zodat een gebruiker zijn eigen geschiedenis terug kan zien.
-- - SCHRIJVEN gebeurt uitsluitend door de Edge Function via de service-role (die
--   RLS overslaat). Er zijn bewust GEEN insert/update/delete-policies voor de
--   client: de browser mag deze tabellen niet rechtstreeks muteren — alleen Gerrie.
-- ============================================================

begin;

-- ── Gesprekken ──────────────────────────────────────────────────────────────
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ai_conversations_org
  on public.ai_conversations(organization_id, updated_at desc);
create index if not exists idx_ai_conversations_user
  on public.ai_conversations(organization_id, created_by, updated_at desc);

-- ── Berichten ───────────────────────────────────────────────────────────────
create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- Welke tools Gerrie bij dit antwoord raadpleegde (transparantie + debug).
  tool_calls jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_messages_conversation
  on public.ai_messages(conversation_id, created_at asc);
create index if not exists idx_ai_messages_org
  on public.ai_messages(organization_id, created_at desc);

-- ── Actie-audit (klaar voor fase 3: schrijf-acties met bevestiging) ──────────
create table if not exists public.ai_action_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  message_id uuid references public.ai_messages(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  action text not null,
  params jsonb not null default '{}'::jsonb,
  -- 'proposed' (voorgesteld), 'confirmed', 'executed', 'failed', 'cancelled'.
  status text not null default 'proposed',
  result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_action_audit_org
  on public.ai_action_audit(organization_id, created_at desc);

-- ── Tokenverbruik + kosten (kostenplafond + later een dashboard) ─────────────
create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  message_id uuid references public.ai_messages(id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_usage_org
  on public.ai_usage(organization_id, created_at desc);

-- ── Houd updated_at op het gesprek bij ───────────────────────────────────────
create or replace function public.touch_ai_conversation_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists ai_conversations_touch_updated_at on public.ai_conversations;
create trigger ai_conversations_touch_updated_at
  before update on public.ai_conversations
  for each row execute function public.touch_ai_conversation_updated_at();

-- Blokkeer verplaatsen naar een andere organisatie na aanmaken (codebase-conventie).
drop trigger if exists ai_conversations_prevent_org_change on public.ai_conversations;
create trigger ai_conversations_prevent_org_change
  before update of organization_id on public.ai_conversations
  for each row execute function public.prevent_organization_id_change();

-- ── RLS — alleen LEZEN voor actieve leden; schrijven loopt via de service-role ─
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_action_audit enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists "ai_conversations read" on public.ai_conversations;
create policy "ai_conversations read" on public.ai_conversations for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "ai_messages read" on public.ai_messages;
create policy "ai_messages read" on public.ai_messages for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "ai_action_audit read" on public.ai_action_audit;
create policy "ai_action_audit read" on public.ai_action_audit for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "ai_usage read" on public.ai_usage;
create policy "ai_usage read" on public.ai_usage for select using (
  public.can_read_org(organization_id)
);

commit;
