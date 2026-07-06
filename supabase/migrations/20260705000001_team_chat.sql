-- ============================================================
-- ResoFly — Teamchat (interne chat tussen organisatieleden)
-- Date: 2026-07-05
--
-- Scope:
-- Een interne chat tussen de gebruikers van dezelfde organisatie. Twee soorten
-- gesprekken:
--   - 'dm'      : 1-op-1 tussen twee leden (uniek per paar per organisatie via
--                 dm_key = de twee user-id's gesorteerd, "a:b").
--   - 'channel' : een benoemd groepskanaal met meerdere leden.
--
-- Kernontwerp:
-- - chat_conversations   : het gesprek (dm of channel) + last_message_at voor de
--                          sortering van de gesprekslijst.
-- - chat_participants     : wie er in een gesprek zit + last_read_at per lid. Dit
--                          ene veld drijft ZOWEL de ongelezen-teller ALS de
--                          leesbevestigingen ("gelezen door …").
-- - chat_messages         : de berichten. mentions[] voor @-vermeldingen,
--                          attachment_count voor bijlagen (via de bestaande
--                          attachments-tabel, entity_type='chat_message'),
--                          edited_at + deleted_at voor bewerken/intrekken.
-- - chat_message_reactions: emoji-reacties (uniek per bericht+gebruiker+emoji).
--
-- RLS zonder recursie:
-- Alle leesrechten hangen aan het lidmaatschap van een gesprek. Omdat de policy op
-- chat_participants naar chat_participants zou verwijzen (oneindige recursie), loopt
-- de check via public.chat_is_participant() — een SECURITY DEFINER functie die de
-- RLS omzeilt (zelfde truc als user_is_org_member). Structurele mutaties (gesprek
-- starten, leden toevoegen, gelezen markeren, verlaten) lopen via SECURITY DEFINER
-- RPC's; berichten/reacties gaan rechtstreeks met RLS zodat realtime blijft werken.
-- ============================================================

begin;

-- ── 1. Tabellen ──────────────────────────────────────────────────────────────

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('dm','channel')),
  title text,
  description text,
  -- Voor DM's: de twee user-id's gesorteerd ("a:b") zodat er per paar precies één
  -- gesprek bestaat (partiële unieke index hieronder). Null voor kanalen.
  dm_key text,
  is_archived boolean not null default false,
  last_message_at timestamptz,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_conversations_dm_shape check (
    (kind = 'dm' and dm_key is not null) or (kind = 'channel' and dm_key is null)
  )
);

create index if not exists idx_chat_conversations_org
  on public.chat_conversations(organization_id, last_message_at desc);
create unique index if not exists chat_conversations_dm_unique
  on public.chat_conversations(organization_id, dm_key) where dm_key is not null;

create table if not exists public.chat_participants (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('member','admin')),
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists idx_chat_participants_user
  on public.chat_participants(user_id, organization_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  body text not null default '',
  mentions uuid[] not null default '{}',
  attachment_count integer not null default 0 check (attachment_count >= 0),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_conversation
  on public.chat_messages(conversation_id, created_at);

create table if not exists public.chat_message_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists idx_chat_reactions_message
  on public.chat_message_reactions(message_id);

-- ── 2. Lidmaatschap-helper (SECURITY DEFINER → geen RLS-recursie) ────────────

create or replace function public.chat_is_participant(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_participants p
    where p.conversation_id = p_conversation_id
      and p.user_id = auth.uid()
  );
$$;

grant execute on function public.chat_is_participant(uuid) to authenticated;

-- ── 3. Triggers ──────────────────────────────────────────────────────────────

drop trigger if exists chat_conversations_updated on public.chat_conversations;
create trigger chat_conversations_updated before update on public.chat_conversations
  for each row execute function public.set_updated_at();

drop trigger if exists chat_conversations_prevent_org_change on public.chat_conversations;
create trigger chat_conversations_prevent_org_change
  before update of organization_id on public.chat_conversations
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists chat_messages_updated on public.chat_messages;
create trigger chat_messages_updated before update on public.chat_messages
  for each row execute function public.set_updated_at();

drop trigger if exists chat_messages_prevent_org_change on public.chat_messages;
create trigger chat_messages_prevent_org_change
  before update of organization_id on public.chat_messages
  for each row execute function public.prevent_organization_id_change();

-- Het gesprek van een bericht ligt vast na aanmaken: verhinder dat een bewerking
-- conversation_id verzet (extra verdediging naast de WITH CHECK-policy).
create or replace function public.chat_prevent_conversation_change()
returns trigger
language plpgsql
as $$
begin
  if new.conversation_id is distinct from old.conversation_id then
    raise exception 'chat: conversation_id is onveranderlijk';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_prevent_conv_change on public.chat_messages;
create trigger chat_messages_prevent_conv_change
  before update of conversation_id on public.chat_messages
  for each row execute function public.chat_prevent_conversation_change();

drop trigger if exists chat_participants_prevent_org_change on public.chat_participants;
create trigger chat_participants_prevent_org_change
  before update of organization_id on public.chat_participants
  for each row execute function public.prevent_organization_id_change();

-- Zet bij insert de afzender + organisatie server-side af (autoritair), zodat een
-- client die niet kan spoofen. De organisatie komt altijd uit het gesprek zelf.
create or replace function public.chat_messages_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.sender_id := auth.uid();
  select c.organization_id into new.organization_id
    from public.chat_conversations c
    where c.id = new.conversation_id;
  if new.organization_id is null then
    raise exception 'chat: onbekend gesprek';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_stamp on public.chat_messages;
create trigger chat_messages_stamp before insert on public.chat_messages
  for each row execute function public.chat_messages_stamp();

-- Houd last_message_at op het gesprek bij (drijft de sortering van de lijst).
-- Alleen echte (niet direct verwijderde) berichten tellen.
create or replace function public.chat_bump_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is null then
    update public.chat_conversations
      set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at),
          updated_at = now()
      where id = new.conversation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_bump on public.chat_messages;
create trigger chat_messages_bump after insert on public.chat_messages
  for each row execute function public.chat_bump_conversation();

-- Reacties: leid gesprek + organisatie autoritair af uit het bericht (voorkomt dat
-- een client een reactie aan het verkeerde gesprek koppelt om RLS te omzeilen).
create or replace function public.chat_reactions_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select m.conversation_id, m.organization_id
    into new.conversation_id, new.organization_id
    from public.chat_messages m
    where m.id = new.message_id;
  if new.conversation_id is null then
    raise exception 'chat: onbekend bericht';
  end if;
  new.user_id := auth.uid();
  return new;
end;
$$;

drop trigger if exists chat_reactions_stamp on public.chat_message_reactions;
create trigger chat_reactions_stamp before insert on public.chat_message_reactions
  for each row execute function public.chat_reactions_stamp();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────

alter table public.chat_conversations enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_message_reactions enable row level security;

do $$
begin
  -- chat_conversations: je ziet de gesprekken waar je in zit. Aanmaken mag elk
  -- organisatielid (ook alleen-lezen leden), created_by moet jezelf zijn.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_conversations' and policyname='chat conv select') then
    create policy "chat conv select" on public.chat_conversations
      for select using (public.chat_is_participant(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_conversations' and policyname='chat conv insert') then
    create policy "chat conv insert" on public.chat_conversations
      for insert with check (public.can_read_org(organization_id) and created_by = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_conversations' and policyname='chat conv update') then
    create policy "chat conv update" on public.chat_conversations
      for update using (public.chat_is_participant(id)) with check (public.chat_is_participant(id));
  end if;

  -- chat_participants: je ziet de deelnemerslijst van gesprekken waar je zelf in
  -- zit (nodig voor namen, leesbevestiging en online-status). Je eigen rij mag je
  -- bijwerken (last_read_at) en verwijderen (verlaten). Toevoegen loopt via RPC.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_participants' and policyname='chat part select') then
    create policy "chat part select" on public.chat_participants
      for select using (public.chat_is_participant(conversation_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_participants' and policyname='chat part update own') then
    create policy "chat part update own" on public.chat_participants
      for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_participants' and policyname='chat part delete own') then
    create policy "chat part delete own" on public.chat_participants
      for delete using (user_id = auth.uid());
  end if;

  -- chat_messages: lezen mag elke deelnemer; sturen mag elke deelnemer (afzender
  -- wordt door de trigger op auth.uid() gezet); bewerken/intrekken alleen eigen
  -- berichten.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_messages' and policyname='chat msg select') then
    create policy "chat msg select" on public.chat_messages
      for select using (public.chat_is_participant(conversation_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_messages' and policyname='chat msg insert') then
    create policy "chat msg insert" on public.chat_messages
      for insert with check (public.chat_is_participant(conversation_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_messages' and policyname='chat msg update own') then
    -- WITH CHECK moet OOK het doelgesprek valideren: anders kan een afzender z'n
    -- eigen bericht via een rauwe UPDATE naar een gesprek verplaatsen waar hij geen
    -- lid van is (USING toetst het oude gesprek, WITH CHECK het nieuwe).
    create policy "chat msg update own" on public.chat_messages
      for update using (sender_id = auth.uid() and public.chat_is_participant(conversation_id))
      with check (sender_id = auth.uid() and public.chat_is_participant(conversation_id));
  end if;

  -- chat_message_reactions: zien mag elke deelnemer; eigen reacties toevoegen/
  -- verwijderen.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_message_reactions' and policyname='chat react select') then
    create policy "chat react select" on public.chat_message_reactions
      for select using (public.chat_is_participant(conversation_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_message_reactions' and policyname='chat react insert own') then
    create policy "chat react insert own" on public.chat_message_reactions
      for insert with check (user_id = auth.uid() and public.chat_is_participant(conversation_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='chat_message_reactions' and policyname='chat react delete own') then
    create policy "chat react delete own" on public.chat_message_reactions
      for delete using (user_id = auth.uid());
  end if;
end $$;

-- ── 5. RPC's (SECURITY DEFINER) ──────────────────────────────────────────────

-- Start (of vind) een 1-op-1 gesprek met een ander lid van dezelfde organisatie.
-- Idempotent: bestaat het al, dan komt datzelfde gesprek terug (advisory lock +
-- partiële unieke index tegen races).
create or replace function public.chat_start_dm(p_organization_id uuid, p_other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_key text;
  v_conv uuid;
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if p_other_user is null or p_other_user = v_me then raise exception 'chat: ongeldige gebruiker'; end if;

  -- Beide moeten actief lid zijn van dezelfde organisatie.
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = v_me and m.status = 'active'
  ) then raise exception 'chat: geen toegang tot organisatie'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_other_user and m.status = 'active'
  ) then raise exception 'chat: ander lid niet gevonden in organisatie'; end if;

  v_key := case when v_me < p_other_user
                then v_me::text || ':' || p_other_user::text
                else p_other_user::text || ':' || v_me::text end;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext(v_key));

  select id into v_conv from public.chat_conversations
    where organization_id = p_organization_id and dm_key = v_key limit 1;
  if v_conv is not null then return v_conv; end if;

  insert into public.chat_conversations (organization_id, kind, dm_key, created_by)
    values (p_organization_id, 'dm', v_key, v_me)
    returning id into v_conv;
  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
    values (v_conv, p_organization_id, v_me, 'member'),
           (v_conv, p_organization_id, p_other_user, 'member')
    on conflict do nothing;
  return v_conv;
end;
$$;

-- Maak een groepskanaal. De maker wordt 'admin'; opgegeven leden worden toegevoegd
-- als ze actief lid van de organisatie zijn.
create or replace function public.chat_create_channel(p_organization_id uuid, p_title text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_conv uuid;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if v_title is null then raise exception 'chat: kanaalnaam is verplicht'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = v_me and m.status = 'active'
  ) then raise exception 'chat: geen toegang tot organisatie'; end if;

  insert into public.chat_conversations (organization_id, kind, title, created_by)
    values (p_organization_id, 'channel', v_title, v_me)
    returning id into v_conv;

  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
    values (v_conv, p_organization_id, v_me, 'admin');

  if p_member_ids is not null then
    insert into public.chat_participants (conversation_id, organization_id, user_id, role)
    select v_conv, p_organization_id, m.user_id, 'member'
      from public.organization_members m
      where m.organization_id = p_organization_id
        and m.status = 'active'
        and m.user_id = any(p_member_ids)
        and m.user_id <> v_me
    on conflict do nothing;
  end if;

  return v_conv;
end;
$$;

-- Voeg leden toe aan een kanaal. Alleen een bestaande deelnemer mag dit; alleen
-- kanalen (geen DM's).
create or replace function public.chat_add_participants(p_conversation_id uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_org uuid;
  v_kind text;
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if not public.chat_is_participant(p_conversation_id) then
    raise exception 'chat: geen deelnemer';
  end if;
  select organization_id, kind into v_org, v_kind
    from public.chat_conversations where id = p_conversation_id;
  if v_kind <> 'channel' then raise exception 'chat: leden toevoegen kan alleen bij kanalen'; end if;

  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
  select p_conversation_id, v_org, m.user_id, 'member'
    from public.organization_members m
    where m.organization_id = v_org
      and m.status = 'active'
      and m.user_id = any(coalesce(p_user_ids, '{}'::uuid[]))
  on conflict do nothing;
end;
$$;

-- Markeer een gesprek als (nu) gelezen voor de huidige gebruiker. Server-side now()
-- (geen clock-skew). Een realtime UPDATE op chat_participants laat de leesbevestiging
-- bij de anderen bijwerken.
create or replace function public.chat_mark_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_participants
    set last_read_at = now()
    where conversation_id = p_conversation_id and user_id = auth.uid();
end;
$$;

-- Verlaat een kanaal (DM's kun je niet verlaten; die verberg je client-side).
create or replace function public.chat_leave(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_kind text;
begin
  select kind into v_kind from public.chat_conversations where id = p_conversation_id;
  if v_kind = 'dm' then raise exception 'chat: een 1-op-1 gesprek kun je niet verlaten'; end if;
  delete from public.chat_participants
    where conversation_id = p_conversation_id and user_id = auth.uid();
end;
$$;

-- Ongelezen berichten per gesprek voor de HUIDIGE gebruiker: berichten nieuwer dan
-- de eigen leesmarker, niet van jezelf en niet verwijderd. De app telt op tot de
-- sidebar-badge.
create or replace function public.chat_unread_counts()
returns table (conversation_id uuid, unread_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select p.conversation_id, count(m.id)::int as unread_count
    from public.chat_participants p
    join public.chat_messages m
      on m.conversation_id = p.conversation_id
     and m.created_at > p.last_read_at
     and m.deleted_at is null
     and m.sender_id is distinct from p.user_id
    where p.user_id = auth.uid()
    group by p.conversation_id;
$$;

grant execute on function public.chat_start_dm(uuid, uuid) to authenticated;
grant execute on function public.chat_create_channel(uuid, text, uuid[]) to authenticated;
grant execute on function public.chat_add_participants(uuid, uuid[]) to authenticated;
grant execute on function public.chat_mark_read(uuid) to authenticated;
grant execute on function public.chat_leave(uuid) to authenticated;
grant execute on function public.chat_unread_counts() to authenticated;

-- ── 6. Bijlagen: sta entity_type='chat_message' toe ──────────────────────────
-- De attachments.entity_type-CHECK predateert de migratiehistorie: drop wat er is
-- en herbouw met de volledige, actuele set incl. 'chat_message'.
alter table public.attachments drop constraint if exists attachments_entity_type_check;
alter table public.attachments
  add constraint attachments_entity_type_check
  check (entity_type in ('client','project','task','subtask','ticket','note','document','quote','invoice','folder','supplier','purchase_invoice','fixed_asset','chat_message'));

-- ── 7. Realtime ──────────────────────────────────────────────────────────────
-- Live berichten, bewerken/reacties en leesbevestigingen. RLS blijft per abonnee
-- gelden (alleen gesprekken waar je zelf in zit).
--
-- REPLICA IDENTITY FULL op de tabellen die HARD verwijderd worden (reactie
-- weghalen, kanaal verlaten): anders bevat een DELETE-event alleen de primary key,
-- waardoor zowel de organization_id-filter als de RLS-check (die conversation_id
-- nodig heeft) niet kan slagen en het event stilletjes wegvalt. Berichten gebruiken
-- soft-delete (UPDATE) en hebben dit niet nodig.
alter table public.chat_message_reactions replica identity full;
alter table public.chat_participants replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then
      alter publication supabase_realtime add table public.chat_messages;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_message_reactions') then
      alter publication supabase_realtime add table public.chat_message_reactions;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_participants') then
      alter publication supabase_realtime add table public.chat_participants;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_conversations') then
      alter publication supabase_realtime add table public.chat_conversations;
    end if;
  end if;
end $$;

commit;
