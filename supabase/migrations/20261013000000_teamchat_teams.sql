-- ============================================================
-- ResoFly — Teamchat in de stijl van Microsoft Teams
-- Date: 2026-10-13
--
-- De teamchat krijgt de functies die je van Teams kent. Wat daarvoor in de
-- database nodig is:
--
--   1. Groepschats (kind 'group'): een chat met meerdere collega's, met of
--      zonder naam, naast de 1-op-1-chat ('dm') en het kanaal ('channel').
--      Een kanaal is openbaar (iedereen in de organisatie kan het vinden en
--      erbij gaan) of privé (alleen wie is toegevoegd). Bestaande kanalen
--      blijven privé: wie er nu niet in zit, ziet ze straks ook niet.
--   2. Eigen voorkeuren per gesprek: vastmaken, dempen, verbergen en
--      "markeren als ongelezen" (chat_conversation_prefs, alleen voor jezelf
--      zichtbaar; schrijven via chat_set_preferences). Dempen en Niet storen
--      tellen mee voor de pushmeldingen.
--   3. Berichten: antwoorden met citaat (reply_to_id), draadjes in kanalen
--      (parent_id: een post met de antwoorden eronder), een onderwerp op een
--      post, belang (belangrijk/dringend), vastgemaakte berichten,
--      vergaderingen (kind 'meeting' met een https-link) en systeemregels
--      ("Ann heeft Bob toegevoegd") die alleen de database zelf schrijft.
--   4. Opgeslagen berichten (chat_saved_messages) en een status per lid
--      (chat_member_status: Beschikbaar, Bezet, Niet storen, ... plus een
--      statusbericht).
--   5. Activiteit (chat_activity): vermeldingen, antwoorden en reacties op
--      jouw berichten — de bel van Teams.
--
-- Alles blijft binnen de bestaande regels: lezen kan alleen wie in het gesprek
-- zit (chat_is_participant), de nieuwe tabellen hangen onder de module gate van
-- 'chat' (en dus ook achter het boekhouder-hek), en elke security-definer-
-- functie is dicht voor anon. Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Gesprekken: groepschats en vindbare kanalen ───────────────────────────

-- De oude CHECK op kind (en de vorm-CHECK die erop leunt) dragen een naam die
-- Postgres zelf koos. Zoek ze op in plaats van een naam te raden.
do $$
declare r record;
begin
  for r in
    select conname
      from pg_constraint
     where conrelid = 'public.chat_conversations'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~* '\mkind\M'
  loop
    execute format('alter table public.chat_conversations drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.chat_conversations
  add column if not exists visibility text not null default 'private';

alter table public.chat_conversations
  add constraint chat_conversations_kind_check
    check (kind in ('dm', 'group', 'channel'));
alter table public.chat_conversations
  add constraint chat_conversations_dm_shape
    check ((kind = 'dm') = (dm_key is not null));
alter table public.chat_conversations
  add constraint chat_conversations_visibility_check
    check (visibility in ('public', 'private') and (visibility = 'private' or kind = 'channel'));

alter table public.chat_conversations drop constraint if exists chat_conversations_title_len;
alter table public.chat_conversations
  add constraint chat_conversations_title_len
    check (title is null or char_length(title) <= 120) not valid;
alter table public.chat_conversations drop constraint if exists chat_conversations_description_len;
alter table public.chat_conversations
  add constraint chat_conversations_description_len
    check (description is null or char_length(description) <= 500) not valid;

-- Wie een kanaal kan vinden, is een keuze van wie het maakt; daarna ligt het
-- vast, net als het soort gesprek en wie het begon.
create or replace function public.guard_chat_conversation_client_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.kind is distinct from old.kind
          or new.dm_key is distinct from old.dm_key
          or new.created_by is distinct from old.created_by
          or new.organization_id is distinct from old.organization_id
          or new.visibility is distinct from old.visibility) then
    raise exception 'Het soort gesprek, wie het begon en wie het kan vinden, liggen vast.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ── 2. Eigen voorkeuren per gesprek ──────────────────────────────────────────
-- Een eigen tabel en niet een paar kolommen op chat_participants: die rijen
-- leest elke deelnemer van het gesprek (voor namen en leesbevestigingen), en dat
-- jij een chat gedempt of verborgen hebt, gaat de anderen niets aan. Hier ziet
-- iedereen alleen zijn eigen rij; schrijven loopt via chat_set_preferences.

create table if not exists public.chat_conversation_prefs (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  is_pinned boolean not null default false,
  is_muted boolean not null default false,
  hidden_at timestamptz,
  marked_unread boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists idx_chat_conversation_prefs_user
  on public.chat_conversation_prefs (user_id, organization_id);

drop trigger if exists chat_conversation_prefs_prevent_org_change on public.chat_conversation_prefs;
create trigger chat_conversation_prefs_prevent_org_change
  before update of organization_id on public.chat_conversation_prefs
  for each row execute function public.prevent_organization_id_change();

alter table public.chat_conversation_prefs enable row level security;

drop policy if exists "chat prefs select own" on public.chat_conversation_prefs;
create policy "chat prefs select own" on public.chat_conversation_prefs
  for select using (user_id = auth.uid());

-- ── 3. Berichten ─────────────────────────────────────────────────────────────

alter table public.chat_messages
  add column if not exists kind text not null default 'text',
  add column if not exists reply_to_id uuid references public.chat_messages(id) on delete set null,
  add column if not exists parent_id uuid references public.chat_messages(id) on delete cascade,
  add column if not exists subject text,
  add column if not exists importance text not null default 'normal',
  add column if not exists meta jsonb not null default '{}'::jsonb,
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references auth.users(id) on delete set null;

alter table public.chat_messages drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages
  add constraint chat_messages_kind_check check (kind in ('text', 'system', 'meeting'));
alter table public.chat_messages drop constraint if exists chat_messages_importance_check;
alter table public.chat_messages
  add constraint chat_messages_importance_check check (importance in ('normal', 'important', 'urgent'));
alter table public.chat_messages drop constraint if exists chat_messages_meta_object;
alter table public.chat_messages
  add constraint chat_messages_meta_object check (jsonb_typeof(meta) = 'object');
alter table public.chat_messages drop constraint if exists chat_messages_subject_len;
alter table public.chat_messages
  add constraint chat_messages_subject_len check (subject is null or char_length(subject) <= 200);
alter table public.chat_messages drop constraint if exists chat_messages_body_len;
alter table public.chat_messages
  add constraint chat_messages_body_len check (char_length(body) <= 20000) not valid;

create index if not exists idx_chat_messages_thread
  on public.chat_messages (parent_id, created_at) where parent_id is not null;
create index if not exists idx_chat_messages_pinned
  on public.chat_messages (conversation_id, pinned_at desc) where pinned_at is not null;
create index if not exists idx_chat_messages_reply_to
  on public.chat_messages (reply_to_id) where reply_to_id is not null;
create index if not exists idx_chat_messages_mentions
  on public.chat_messages using gin (mentions);
create index if not exists idx_chat_messages_sender
  on public.chat_messages (sender_id, created_at desc);

-- Wat een bericht is, ligt bij het versturen vast. Een client mag daarna alleen
-- de tekst bewerken of het bericht intrekken (en dat weer ongedaan maken);
-- vastmaken loopt via chat_pin_message, systeemregels schrijft alleen de
-- database. Draait als invoker: de opzoekingen hieronder vallen dus onder RLS,
-- en dat is precies goed — wie een bericht niet kan zien, kan er ook niet op
-- antwoorden.
create or replace function public.chat_messages_validate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
  v_conv_kind text;
  v_parent_conv uuid;
  v_parent_parent uuid;
  v_url text;
begin
  if tg_op = 'UPDATE' then
    if v_client then
      if old.kind = 'system' then
        raise exception 'chat: een systeemregel pas je niet aan' using errcode = '42501';
      end if;
      if new.kind is distinct from old.kind
         or new.parent_id is distinct from old.parent_id
         or new.reply_to_id is distinct from old.reply_to_id
         or new.importance is distinct from old.importance
         or new.meta is distinct from old.meta
         or new.pinned_at is distinct from old.pinned_at
         or new.pinned_by is distinct from old.pinned_by
         or new.sender_id is distinct from old.sender_id
         or new.created_at is distinct from old.created_at then
        raise exception 'chat: dit deel van een bericht ligt vast' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- INSERT
  if v_client then
    if new.kind = 'system' then
      raise exception 'chat: systeemregels schrijft de app zelf' using errcode = '42501';
    end if;
    new.pinned_at := null;
    new.pinned_by := null;
    -- De volgorde in een gesprek en de ongelezen-teller rekenen op de tijd van
    -- de server, niet op een klok die een client zelf meestuurt.
    new.created_at := now();
  end if;

  select c.kind into v_conv_kind
    from public.chat_conversations c
   where c.id = new.conversation_id;

  if new.parent_id is not null then
    select m.conversation_id, m.parent_id into v_parent_conv, v_parent_parent
      from public.chat_messages m
     where m.id = new.parent_id;
    if v_parent_conv is null or v_parent_conv <> new.conversation_id then
      raise exception 'chat: een antwoord hoort bij een post in hetzelfde kanaal' using errcode = '22023';
    end if;
    if v_conv_kind is distinct from 'channel' then
      raise exception 'chat: draadjes bestaan alleen in kanalen' using errcode = '22023';
    end if;
    -- Eén niveau diep, zoals in Teams: een antwoord op een antwoord hangt onder de post.
    if v_parent_parent is not null then
      new.parent_id := v_parent_parent;
    end if;
  end if;

  if new.reply_to_id is not null and not exists (
    select 1 from public.chat_messages r
     where r.id = new.reply_to_id
       and r.conversation_id = new.conversation_id
  ) then
    raise exception 'chat: je kunt alleen een bericht uit hetzelfde gesprek citeren' using errcode = '22023';
  end if;

  -- Een onderwerp hoort alleen boven een nieuwe post in een kanaal.
  new.subject := nullif(btrim(coalesce(new.subject, '')), '');
  if v_conv_kind is distinct from 'channel' or new.parent_id is not null then
    new.subject := null;
  end if;

  if new.kind = 'meeting' then
    v_url := new.meta ->> 'url';
    if v_url is null or char_length(v_url) > 2000 or v_url !~ '^https://[^[:space:]<>"]+$' then
      raise exception 'chat: een vergadering heeft een geldige https-link nodig' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists chat_messages_validate on public.chat_messages;
create trigger chat_messages_validate
  before insert or update on public.chat_messages
  for each row execute function public.chat_messages_validate();

-- ── 4. Opgeslagen berichten ──────────────────────────────────────────────────

create table if not exists public.chat_saved_messages (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists idx_chat_saved_user
  on public.chat_saved_messages (user_id, organization_id, created_at desc);

-- Gesprek en organisatie komen uit het bericht zelf, de gebruiker uit de sessie.
create or replace function public.chat_saved_stamp()
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
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists chat_saved_stamp on public.chat_saved_messages;
create trigger chat_saved_stamp before insert on public.chat_saved_messages
  for each row execute function public.chat_saved_stamp();

alter table public.chat_saved_messages enable row level security;

drop policy if exists "chat saved select own" on public.chat_saved_messages;
create policy "chat saved select own" on public.chat_saved_messages
  for select using (user_id = auth.uid());
drop policy if exists "chat saved insert own" on public.chat_saved_messages;
create policy "chat saved insert own" on public.chat_saved_messages
  for insert with check (user_id = auth.uid() and public.chat_is_participant(conversation_id));
drop policy if exists "chat saved delete own" on public.chat_saved_messages;
create policy "chat saved delete own" on public.chat_saved_messages
  for delete using (user_id = auth.uid());

-- ── 5. Status per lid ────────────────────────────────────────────────────────
-- 'auto' = de app bepaalt het (online → Beschikbaar, even weg → Afwezig,
-- niet verbonden → Offline). De rest kiest het lid zelf, zoals in Teams.

create table if not exists public.chat_member_status (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  availability text not null default 'auto'
    check (availability in ('auto', 'available', 'busy', 'dnd', 'brb', 'away', 'offline')),
  status_message text check (status_message is null or char_length(status_message) <= 280),
  message_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

drop trigger if exists chat_member_status_updated on public.chat_member_status;
create trigger chat_member_status_updated before update on public.chat_member_status
  for each row execute function public.set_updated_at();

drop trigger if exists chat_member_status_prevent_org_change on public.chat_member_status;
create trigger chat_member_status_prevent_org_change
  before update of organization_id on public.chat_member_status
  for each row execute function public.prevent_organization_id_change();

alter table public.chat_member_status enable row level security;

drop policy if exists "chat status select org" on public.chat_member_status;
create policy "chat status select org" on public.chat_member_status
  for select using (public.can_read_org(organization_id));
drop policy if exists "chat status insert own" on public.chat_member_status;
create policy "chat status insert own" on public.chat_member_status
  for insert with check (user_id = auth.uid() and public.can_read_org(organization_id));
drop policy if exists "chat status update own" on public.chat_member_status;
create policy "chat status update own" on public.chat_member_status
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- De drie nieuwe tabellen vallen onder de module Teamchat. Lezers mogen er ook
-- in schrijven: een eigen voorkeur, status of bladwijzer zegt niets over de module.
do $$
begin
  perform public.apply_module_gate('chat_conversation_prefs', 'chat', 'read');
  perform public.apply_module_gate('chat_saved_messages', 'chat', 'read');
  perform public.apply_module_gate('chat_member_status', 'chat', 'read');
end $$;

-- ── 6. Hulpfunctie: een systeemregel in een gesprek ──────────────────────────
-- Alleen voor de RPC's hieronder. Afzender en organisatie zet de stamp-trigger;
-- wie de module alleen mag lezen, laat geen regel achter (de schrijf-gate zou
-- anders de hele handeling laten mislukken).

create or replace function public.chat_system_message(p_conversation_id uuid, p_event text, p_meta jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select c.organization_id into v_org from public.chat_conversations c where c.id = p_conversation_id;
  if v_org is null or not public.can_write_module(v_org, 'chat') then
    return;
  end if;
  insert into public.chat_messages (conversation_id, body, kind, meta)
  values (p_conversation_id, '', 'system', coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('event', p_event));
end;
$$;

revoke all on function public.chat_system_message(uuid, text, jsonb) from public, anon, authenticated;

-- ── 7. RPC's ─────────────────────────────────────────────────────────────────

-- Eigen voorkeuren voor één gesprek. Wat null blijft, verandert niet.
create or replace function public.chat_set_preferences(
  p_conversation_id uuid,
  p_pinned boolean default null,
  p_muted boolean default null,
  p_hidden boolean default null,
  p_unread boolean default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then raise exception 'chat: niet ingelogd'; end if;
  select p.organization_id into v_org
    from public.chat_participants p
   where p.conversation_id = p_conversation_id
     and p.user_id = auth.uid();
  if v_org is null then raise exception 'chat: je zit niet in dit gesprek'; end if;

  insert into public.chat_conversation_prefs as pr
    (conversation_id, user_id, organization_id, is_pinned, is_muted, hidden_at, marked_unread)
  values (
    p_conversation_id, auth.uid(), v_org,
    coalesce(p_pinned, false),
    coalesce(p_muted, false),
    case when p_hidden then now() else null end,
    coalesce(p_unread, false)
  )
  on conflict (conversation_id, user_id) do update
     set is_pinned = coalesce(p_pinned, pr.is_pinned),
         is_muted = coalesce(p_muted, pr.is_muted),
         hidden_at = case when p_hidden is null then pr.hidden_at when p_hidden then now() else null end,
         marked_unread = coalesce(p_unread, pr.marked_unread),
         updated_at = now();
end;
$$;

revoke all on function public.chat_set_preferences(uuid, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.chat_set_preferences(uuid, boolean, boolean, boolean, boolean) to authenticated;

-- Gelezen: ook "markeren als ongelezen" vervalt dan.
create or replace function public.chat_mark_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_participants
     set last_read_at = now()
   where conversation_id = p_conversation_id
     and user_id = auth.uid();
  update public.chat_conversation_prefs
     set marked_unread = false,
         updated_at = now()
   where conversation_id = p_conversation_id
     and user_id = auth.uid()
     and marked_unread;
end;
$$;

revoke all on function public.chat_mark_read(uuid) from public, anon;
grant execute on function public.chat_mark_read(uuid) to authenticated;

-- Ongelezen per gesprek: berichten na de eigen leesmarker, niet van jezelf, niet
-- ingetrokken en geen systeemregel. Met "markeren als ongelezen" telt een
-- gesprek zonder nieuwe berichten als één.
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
   group by p.conversation_id, pr.marked_unread
  having count(m.id) > 0 or coalesce(pr.marked_unread, false);
$$;

revoke all on function public.chat_unread_counts() from public, anon;
grant execute on function public.chat_unread_counts() to authenticated;

-- Een bericht vastmaken of losmaken: elke deelnemer met schrijfrechten mag dat,
-- ook bij een bericht van een ander (zoals in Teams).
create or replace function public.chat_pin_message(p_message_id uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv uuid;
  v_org uuid;
  v_kind text;
begin
  if auth.uid() is null then raise exception 'chat: niet ingelogd'; end if;
  select m.conversation_id, m.organization_id, m.kind into v_conv, v_org, v_kind
    from public.chat_messages m
   where m.id = p_message_id and m.deleted_at is null;
  if v_conv is null or not public.chat_is_participant(v_conv) then
    raise exception 'chat: bericht niet gevonden';
  end if;
  if v_kind = 'system' then raise exception 'chat: een systeemregel maak je niet vast'; end if;
  if not public.can_write_module(v_org, 'chat') then
    raise exception 'Geen toegang tot de module chat in deze organisatie.' using errcode = '42501';
  end if;
  update public.chat_messages
     set pinned_at = case when p_pinned then now() else null end,
         pinned_by = case when p_pinned then auth.uid() else null end
   where id = p_message_id;
end;
$$;

revoke all on function public.chat_pin_message(uuid, boolean) from public, anon;
grant execute on function public.chat_pin_message(uuid, boolean) to authenticated;

-- Een groepschat met meerdere collega's. Alleen actieve leden die de teamchat
-- mogen gebruiken, doen mee; de maker is beheerder.
create or replace function public.chat_create_group(p_organization_id uuid, p_member_ids uuid[], p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_conv uuid;
  v_others int;
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if not public.can_write_module(p_organization_id, 'chat') then
    raise exception 'chat: geen toegang tot de teamchat van deze organisatie' using errcode = '42501';
  end if;

  select count(*) into v_others
    from public.organization_members m
   where m.organization_id = p_organization_id
     and m.status = 'active'
     and m.user_id = any(coalesce(p_member_ids, '{}'::uuid[]))
     and m.user_id <> v_me
     and public.member_module_level(m.role, m.module_access, 'chat') <> 'none';
  if v_others < 1 then raise exception 'chat: kies minstens één collega'; end if;

  insert into public.chat_conversations (organization_id, kind, title, created_by)
  values (p_organization_id, 'group', nullif(btrim(coalesce(p_title, '')), ''), v_me)
  returning id into v_conv;

  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
  values (v_conv, p_organization_id, v_me, 'admin');

  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
  select v_conv, p_organization_id, m.user_id, 'member'
    from public.organization_members m
   where m.organization_id = p_organization_id
     and m.status = 'active'
     and m.user_id = any(p_member_ids)
     and m.user_id <> v_me
     and public.member_module_level(m.role, m.module_access, 'chat') <> 'none'
  on conflict do nothing;

  return v_conv;
end;
$$;

revoke all on function public.chat_create_group(uuid, uuid[], text) from public, anon;
grant execute on function public.chat_create_group(uuid, uuid[], text) to authenticated;

-- Een kanaal, nu met omschrijving en zichtbaarheid. De oude vorm (drie
-- argumenten) gaat weg: met de standaardwaarden hieronder blijft een aanroep
-- in die vorm gewoon werken, en twee varianten naast elkaar zouden PostgREST
-- laten twijfelen welke hij moet nemen.
drop function if exists public.chat_create_channel(uuid, text, uuid[]);

create or replace function public.chat_create_channel(
  p_organization_id uuid,
  p_title text,
  p_member_ids uuid[],
  p_description text default null,
  p_visibility text default 'private'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_conv uuid;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_visibility text := coalesce(nullif(btrim(p_visibility), ''), 'private');
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if v_title is null then raise exception 'chat: kanaalnaam is verplicht'; end if;
  if char_length(v_title) > 120 then raise exception 'chat: de kanaalnaam is te lang (maximaal 120 tekens)'; end if;
  if v_visibility not in ('public', 'private') then raise exception 'chat: onbekende zichtbaarheid'; end if;
  if not public.can_write_module(p_organization_id, 'chat') then
    raise exception 'chat: geen toegang tot de teamchat van deze organisatie' using errcode = '42501';
  end if;

  insert into public.chat_conversations (organization_id, kind, title, description, visibility, created_by)
  values (p_organization_id, 'channel', v_title, left(nullif(btrim(coalesce(p_description, '')), ''), 500), v_visibility, v_me)
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
       and public.member_module_level(m.role, m.module_access, 'chat') <> 'none'
    on conflict do nothing;
  end if;

  return v_conv;
end;
$$;

revoke all on function public.chat_create_channel(uuid, text, uuid[], text, text) from public, anon;
grant execute on function public.chat_create_channel(uuid, text, uuid[], text, text) to authenticated;

-- Leden toevoegen aan een groepschat of kanaal, met een systeemregel voor wie
-- er echt bij kwam.
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
  v_added uuid[];
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if not public.chat_is_participant(p_conversation_id) then
    raise exception 'chat: geen deelnemer';
  end if;
  select organization_id, kind into v_org, v_kind
    from public.chat_conversations where id = p_conversation_id;
  if v_kind not in ('group', 'channel') then
    raise exception 'chat: leden toevoegen kan alleen bij een groepschat of kanaal';
  end if;

  with added as (
    insert into public.chat_participants (conversation_id, organization_id, user_id, role)
    select p_conversation_id, v_org, m.user_id, 'member'
      from public.organization_members m
     where m.organization_id = v_org
       and m.status = 'active'
       and m.user_id = any(coalesce(p_user_ids, '{}'::uuid[]))
       and public.member_module_level(m.role, m.module_access, 'chat') <> 'none'
    on conflict do nothing
    returning user_id
  )
  select array_agg(user_id) into v_added from added;

  if v_added is not null and array_length(v_added, 1) > 0 then
    perform public.chat_system_message(p_conversation_id, 'members_added', jsonb_build_object('user_ids', to_jsonb(v_added)));
  end if;
end;
$$;

revoke all on function public.chat_add_participants(uuid, uuid[]) from public, anon;
grant execute on function public.chat_add_participants(uuid, uuid[]) to authenticated;

-- Iemand uit een groepschat of kanaal halen. In een groepschat mag elk lid dat
-- (zoals in Teams); in een kanaal alleen een beheerder van het kanaal of een
-- owner/admin van de organisatie.
create or replace function public.chat_remove_participant(p_conversation_id uuid, p_user_id uuid)
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
  if p_user_id is null or p_user_id = v_me then raise exception 'chat: gebruik "verlaten" om zelf weg te gaan'; end if;
  if not public.chat_is_participant(p_conversation_id) then raise exception 'chat: geen deelnemer'; end if;
  select organization_id, kind into v_org, v_kind from public.chat_conversations where id = p_conversation_id;
  if v_kind not in ('group', 'channel') then
    raise exception 'chat: iemand verwijderen kan alleen uit een groepschat of kanaal';
  end if;
  if not public.can_write_module(v_org, 'chat') then
    raise exception 'Geen toegang tot de module chat in deze organisatie.' using errcode = '42501';
  end if;
  if v_kind = 'channel'
     and not exists (select 1 from public.chat_participants p
                      where p.conversation_id = p_conversation_id and p.user_id = v_me and p.role = 'admin')
     and not public.user_has_org_role(v_org, array['owner', 'admin']) then
    raise exception 'chat: alleen een beheerder van het kanaal kan leden verwijderen' using errcode = '42501';
  end if;

  delete from public.chat_participants
   where conversation_id = p_conversation_id and user_id = p_user_id;
  if found then
    delete from public.chat_conversation_prefs
     where conversation_id = p_conversation_id and user_id = p_user_id;
    perform public.chat_system_message(p_conversation_id, 'member_removed', jsonb_build_object('user_ids', jsonb_build_array(p_user_id)));
  end if;
end;
$$;

revoke all on function public.chat_remove_participant(uuid, uuid) from public, anon;
grant execute on function public.chat_remove_participant(uuid, uuid) to authenticated;

-- Verlaten (een 1-op-1-chat kun je niet verlaten; die verberg je). Eerst de
-- systeemregel, dan pas weg: daarna ben je geen deelnemer meer.
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
  if not public.chat_is_participant(p_conversation_id) then return; end if;
  perform public.chat_system_message(p_conversation_id, 'member_left', '{}'::jsonb);
  delete from public.chat_participants
   where conversation_id = p_conversation_id and user_id = auth.uid();
  delete from public.chat_conversation_prefs
   where conversation_id = p_conversation_id and user_id = auth.uid();
end;
$$;

revoke all on function public.chat_leave(uuid) from public, anon;
grant execute on function public.chat_leave(uuid) to authenticated;

-- Openbare kanalen van de organisatie waar je (nog) niet in zit.
create or replace function public.chat_public_channels(p_organization_id uuid)
returns table (
  id uuid,
  title text,
  description text,
  member_count integer,
  last_message_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.title, c.description,
         (select count(*)::int from public.chat_participants p where p.conversation_id = c.id) as member_count,
         c.last_message_at, c.created_at
    from public.chat_conversations c
   where c.organization_id = p_organization_id
     and c.kind = 'channel'
     and c.visibility = 'public'
     and not c.is_archived
     and public.can_read_module(p_organization_id, 'chat')
     and not exists (
       select 1 from public.chat_participants p
        where p.conversation_id = c.id and p.user_id = auth.uid()
     )
   order by c.last_message_at desc nulls last, c.created_at desc;
$$;

revoke all on function public.chat_public_channels(uuid) from public, anon;
grant execute on function public.chat_public_channels(uuid) to authenticated;

-- Deelnemen aan een openbaar kanaal.
create or replace function public.chat_join_channel(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_org uuid;
  v_kind text;
  v_visibility text;
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  select organization_id, kind, visibility into v_org, v_kind, v_visibility
    from public.chat_conversations where id = p_conversation_id and not is_archived;
  if v_org is null or v_kind <> 'channel' or v_visibility <> 'public' then
    raise exception 'chat: dit kanaal is niet openbaar';
  end if;
  if not public.can_read_module(v_org, 'chat') then
    raise exception 'chat: geen toegang tot de teamchat van deze organisatie' using errcode = '42501';
  end if;
  if public.chat_is_participant(p_conversation_id) then return; end if;

  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
  values (p_conversation_id, v_org, v_me, 'member')
  on conflict do nothing;
  perform public.chat_system_message(p_conversation_id, 'member_joined', '{}'::jsonb);
end;
$$;

revoke all on function public.chat_join_channel(uuid) from public, anon;
grant execute on function public.chat_join_channel(uuid) to authenticated;

-- Naam en omschrijving van een groepschat of kanaal. Een groepschat mag elk lid
-- hernoemen; een kanaal alleen een beheerder ervan of een owner/admin.
create or replace function public.chat_update_conversation(p_conversation_id uuid, p_title text, p_description text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_org uuid;
  v_kind text;
  v_old_title text;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if not public.chat_is_participant(p_conversation_id) then raise exception 'chat: geen deelnemer'; end if;
  select organization_id, kind, title into v_org, v_kind, v_old_title
    from public.chat_conversations where id = p_conversation_id;
  if v_kind not in ('group', 'channel') then
    raise exception 'chat: alleen een groepschat of kanaal heeft een naam';
  end if;
  if v_kind = 'channel' and v_title is null then raise exception 'chat: kanaalnaam is verplicht'; end if;
  if char_length(coalesce(v_title, '')) > 120 then raise exception 'chat: de naam is te lang (maximaal 120 tekens)'; end if;
  if not public.can_write_module(v_org, 'chat') then
    raise exception 'Geen toegang tot de module chat in deze organisatie.' using errcode = '42501';
  end if;
  if v_kind = 'channel'
     and not exists (select 1 from public.chat_participants p
                      where p.conversation_id = p_conversation_id and p.user_id = v_me and p.role = 'admin')
     and not public.user_has_org_role(v_org, array['owner', 'admin']) then
    raise exception 'chat: alleen een beheerder van het kanaal kan het hernoemen' using errcode = '42501';
  end if;

  update public.chat_conversations
     set title = v_title,
         description = case when v_kind = 'channel' then left(nullif(btrim(coalesce(p_description, '')), ''), 500) else description end
   where id = p_conversation_id;

  if v_title is distinct from v_old_title then
    perform public.chat_system_message(p_conversation_id, 'renamed', jsonb_build_object('title', v_title));
  end if;
end;
$$;

revoke all on function public.chat_update_conversation(uuid, text, text) from public, anon;
grant execute on function public.chat_update_conversation(uuid, text, text) to authenticated;

-- Het laatste bericht per gesprek, voor de voorbeeldregel in de gesprekslijst.
-- Per gesprek één greep in de index (conversation_id, created_at).
create or replace function public.chat_last_messages(p_organization_id uuid)
returns table (
  conversation_id uuid,
  message_id uuid,
  sender_id uuid,
  body text,
  kind text,
  meta jsonb,
  attachment_count integer,
  deleted_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.conversation_id, l.id, l.sender_id, l.body, l.kind, l.meta, l.attachment_count, l.deleted_at, l.created_at
    from public.chat_participants p
    cross join lateral (
      select m.id, m.sender_id, left(m.body, 280) as body, m.kind, m.meta, m.attachment_count, m.deleted_at, m.created_at
        from public.chat_messages m
       where m.conversation_id = p.conversation_id
       order by m.created_at desc
       limit 1
    ) l
   where p.user_id = auth.uid()
     and p.organization_id = p_organization_id
     and public.can_read_module(p_organization_id, 'chat');
$$;

revoke all on function public.chat_last_messages(uuid) from public, anon;
grant execute on function public.chat_last_messages(uuid) to authenticated;

-- Activiteit: wie je noemde, wie op je antwoordde en wie op je reageerde, in
-- de gesprekken waar je in zit. Nieuwste eerst.
create or replace function public.chat_activity(p_organization_id uuid, p_limit integer default 60)
returns table (
  activity_type text,
  message_id uuid,
  conversation_id uuid,
  actor_id uuid,
  emoji text,
  body text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with conv as (
    select p.conversation_id as id
      from public.chat_participants p
     where p.user_id = auth.uid()
       and p.organization_id = p_organization_id
       and public.can_read_module(p_organization_id, 'chat')
  ),
  feed as (
    select 'mention'::text as a_type, m.id as a_message, m.conversation_id as a_conv,
           m.sender_id as a_actor, null::text as a_emoji, left(m.body, 300) as a_body, m.created_at as a_at
      from public.chat_messages m
     where m.conversation_id in (select id from conv)
       and m.mentions @> array[auth.uid()]
       and m.sender_id is distinct from auth.uid()
       and m.deleted_at is null
       and m.kind <> 'system'
    union all
    select 'reply', m.id, m.conversation_id, m.sender_id, null, left(m.body, 300), m.created_at
      from public.chat_messages m
      join public.chat_messages o on o.id = coalesce(m.reply_to_id, m.parent_id)
     where m.conversation_id in (select id from conv)
       and o.sender_id = auth.uid()
       and m.sender_id is distinct from auth.uid()
       and m.deleted_at is null
       and m.kind <> 'system'
       and not (m.mentions @> array[auth.uid()])
    union all
    select 'reaction', r.message_id, r.conversation_id, r.user_id, r.emoji, left(o.body, 300), r.created_at
      from public.chat_message_reactions r
      join public.chat_messages o on o.id = r.message_id
     where r.conversation_id in (select id from conv)
       and o.sender_id = auth.uid()
       and r.user_id <> auth.uid()
       and o.deleted_at is null
  )
  select f.a_type, f.a_message, f.a_conv, f.a_actor, f.a_emoji, f.a_body, f.a_at
    from feed f
   order by f.a_at desc
   limit least(greatest(coalesce(p_limit, 60), 1), 200);
$$;

revoke all on function public.chat_activity(uuid, integer) from public, anon;
grant execute on function public.chat_activity(uuid, integer) to authenticated;

-- ── 8. Pushmeldingen ─────────────────────────────────────────────────────────
-- Zoals in Teams: een gedempt gesprek meldt alleen nog een vermelding of iets
-- dringends, Niet storen laat alleen dringend door, en een antwoord in een
-- kanaaldraadje gaat naar wie in dat draadje zit (of genoemd wordt) in plaats
-- van naar het hele kanaal. De melding opent het gesprek zelf (/?chat=<id>).

create or replace function public.push_on_chat_message_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients uuid[];
  v_kind text;
  v_conv_title text;
  v_sender_email text;
  v_sender_label text;
  v_title text;
  v_snippet text;
  v_prefix text;
begin
  begin
    if new.deleted_at is not null or new.kind = 'system' then return null; end if;
    if new.kind = 'text' and coalesce(btrim(new.body), '') = '' and coalesce(new.attachment_count, 0) = 0 then
      return null;
    end if;

    select c.kind, c.title into v_kind, v_conv_title
      from public.chat_conversations c where c.id = new.conversation_id;

    select array_agg(p.user_id) into v_recipients
      from public.chat_participants p
      left join public.chat_conversation_prefs pr
        on pr.conversation_id = p.conversation_id and pr.user_id = p.user_id
      left join public.chat_member_status s
        on s.organization_id = new.organization_id and s.user_id = p.user_id
     where p.conversation_id = new.conversation_id
       and p.user_id is distinct from new.sender_id
       and (new.parent_id is null
            or p.user_id = any(new.mentions)
            or exists (
              select 1 from public.chat_messages t
               where (t.id = new.parent_id or t.parent_id = new.parent_id)
                 and t.sender_id = p.user_id
            ))
       and (not coalesce(pr.is_muted, false) or p.user_id = any(new.mentions) or new.importance = 'urgent')
       and (coalesce(s.availability, 'auto') <> 'dnd' or new.importance = 'urgent');

    if v_recipients is null or array_length(v_recipients, 1) is null then return null; end if;

    select m.email into v_sender_email
      from public.organization_members m
     where m.organization_id = new.organization_id and m.user_id = new.sender_id
     limit 1;
    v_sender_label := coalesce(nullif(split_part(coalesce(v_sender_email, ''), '@', 1), ''), 'Teamlid');

    v_title := case
      when v_kind = 'channel' then coalesce(nullif(btrim(v_conv_title), ''), 'Kanaal')
      when v_kind = 'group' then coalesce(nullif(btrim(v_conv_title), ''), 'Groepschat')
      else v_sender_label
    end;

    v_prefix := case new.importance when 'urgent' then 'DRINGEND: ' when 'important' then 'BELANGRIJK: ' else '' end;

    if new.kind = 'meeting' then
      v_snippet := v_sender_label || ' is een vergadering gestart';
    elsif coalesce(btrim(new.body), '') = '' then
      v_snippet := v_sender_label || ' stuurde een bijlage';
    elsif v_kind in ('channel', 'group') then
      v_snippet := v_sender_label || ': ' || left(btrim(new.body), 140);
    else
      v_snippet := left(btrim(new.body), 140);
    end if;

    perform public.push_enqueue(
      new.organization_id, 'chat_message', v_recipients,
      jsonb_build_object(
        'title', v_title,
        'body', v_prefix || v_snippet,
        'url', '/?chat=' || new.conversation_id::text,
        'tag', 'chat:' || new.conversation_id::text
      )
    );
  exception when others then
    raise warning 'push_on_chat_message_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

-- ── 9. Realtime ──────────────────────────────────────────────────────────────
-- Statuswijzigingen live bij de collega's, en je eigen voorkeuren live op je
-- andere apparaten. RLS blijft per abonnee gelden: van de voorkeuren krijgt
-- iedereen alleen zijn eigen rijen door.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_member_status') then
      alter publication supabase_realtime add table public.chat_member_status;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_conversation_prefs') then
      alter publication supabase_realtime add table public.chat_conversation_prefs;
    end if;
  end if;
end $$;

commit;
