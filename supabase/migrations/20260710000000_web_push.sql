-- ============================================================
-- ResoFly — Web Push (OS-/device-meldingen, ook als de app dicht is)
-- Date: 2026-07-10
--
-- Context:
-- De bestaande meldingen (tickets, teamchat, klant-mail) lopen via Supabase
-- Realtime: die bereiken alléén een browser-tab die OP DAT MOMENT open is. Zodra
-- de app geminimaliseerd/gesloten is, komt er niets binnen. Web Push vult dat gat:
-- een service worker ontvangt een versleutelde push van de push-dienst (via de
-- edge function `web-push`) en toont een echte OS-melding (Windows/macOS/Android),
-- ook als de browser op de achtergrond draait.
--
-- Onderdelen:
--  1. push_subscriptions      : per gebruiker per apparaat/browser een abonnement
--                               (endpoint + sleutels). Idempotent op endpoint.
--  2. notification_preferences: per gebruiker × organisatie × gebeurtenis aan/uit.
--                               Ontbrekende rij = AAN (standaard).
--  3. notification_outbox     : durable wachtrij. DB-triggers op de zes bron-tabellen
--                               schrijven één rij per ontvanger; de edge function
--                               `web-push?cron=drain` (pg_cron, per minuut) verstuurt
--                               ze en ruimt dode abonnementen op. Zelfde outbox-/
--                               cron-patroon als de e-mailcampagnes.
--
-- Beveiliging:
-- - push_subscriptions / notification_preferences: per-gebruiker RLS (zoals
--   ticket_reads): je beheert uitsluitend je eigen rijen, binnen een org die je
--   mag lezen.
-- - notification_outbox: RLS aan, GEEN policies → onbereikbaar voor gewone
--   gebruikers (kan payloads van anderen bevatten). De triggers (SECURITY DEFINER)
--   en de dispatcher (service-role) omzeilen RLS.
-- - De enqueue-triggers draaien in een eigen exception-block: een fout in het
--   melden mag NOOIT het aanmaken van het ticket/bericht/etc. blokkeren.
-- ============================================================

begin;

-- Toegestane gebeurtenistypes — gedeeld door prefs én outbox zodat een typo hard
-- opvalt in plaats van stil een melding te verliezen.
--   ticket_new           : klant maakt een ticket aan via het portaal
--   ticket_note_client   : klant reageert op een ticket (author_type='client')
--   chat_message         : nieuw teamchat-bericht (niet van jezelf)
--   client_email_inbound : inkomende klant-e-mail (reply)
--   booking_new          : nieuwe/bevestigde agenda-boeking
--   invoice_paid         : factuur op 'paid' gezet

-- ── 1. push_subscriptions ────────────────────────────────────────────────────

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- De push-dienst-URL is de unieke sleutel van een abonnement (per browser/apparaat).
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_unique unique (endpoint)
);

create index if not exists idx_push_subscriptions_user
  on public.push_subscriptions(user_id);
create index if not exists idx_push_subscriptions_org_user
  on public.push_subscriptions(organization_id, user_id);

drop trigger if exists push_subscriptions_updated on public.push_subscriptions;
create trigger push_subscriptions_updated before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

-- BEWUST GEEN prevent_organization_id_change: een abonnement hoort bij een apparaat,
-- niet bij een tenant — de bezorging matcht op user_id (niet op organization_id). Een
-- gebruiker die tussen z'n eigen organisaties wisselt, herschrijft bij het opnieuw
-- syncen simpelweg de organization_id (RLS staat alleen een org toe die hij mag lezen).

alter table public.push_subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push subs select own') then
    create policy "push subs select own" on public.push_subscriptions
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push subs insert own') then
    create policy "push subs insert own" on public.push_subscriptions
      for insert with check (user_id = auth.uid() and public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push subs update own') then
    create policy "push subs update own" on public.push_subscriptions
      for update using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push subs delete own') then
    create policy "push subs delete own" on public.push_subscriptions
      for delete using (user_id = auth.uid());
  end if;
end $$;

-- ── 2. notification_preferences ──────────────────────────────────────────────

create table if not exists public.notification_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_type text not null check (event_type in
    ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, event_type)
);

alter table public.notification_preferences enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notification_preferences' and policyname='notif prefs select own') then
    create policy "notif prefs select own" on public.notification_preferences
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notification_preferences' and policyname='notif prefs insert own') then
    create policy "notif prefs insert own" on public.notification_preferences
      for insert with check (user_id = auth.uid() and public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notification_preferences' and policyname='notif prefs update own') then
    create policy "notif prefs update own" on public.notification_preferences
      for update using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notification_preferences' and policyname='notif prefs delete own') then
    create policy "notif prefs delete own" on public.notification_preferences
      for delete using (user_id = auth.uid());
  end if;
end $$;

drop trigger if exists notification_preferences_updated on public.notification_preferences;
create trigger notification_preferences_updated before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- ── 3. notification_outbox ───────────────────────────────────────────────────

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in
    ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','dead')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Draaiende index voor de dispatcher: alleen nog-te-doen werk.
create index if not exists idx_notification_outbox_pending
  on public.notification_outbox(created_at)
  where status in ('queued','sending');

-- RLS aan, GEEN policies: gewone gebruikers kunnen de outbox niet lezen/schrijven.
-- De service-role dispatcher en de SECURITY DEFINER triggers omzeilen RLS.
alter table public.notification_outbox enable row level security;

-- ── 4. Enqueue-helper (SECURITY DEFINER → leest subs/prefs van álle ontvangers) ──
-- Schrijft één outbox-rij per ontvanger die (a) minstens één push-abonnement heeft
-- en (b) deze gebeurtenis niet heeft uitgezet. Ontbrekende pref-rij = AAN.
create or replace function public.push_enqueue(
  p_org uuid,
  p_event_type text,
  p_recipients uuid[],
  p_payload jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_org is null or p_event_type is null or p_recipients is null then return; end if;
  insert into public.notification_outbox (organization_id, recipient_user_id, event_type, payload)
  select p_org, r.user_id, p_event_type, coalesce(p_payload, '{}'::jsonb)
  from (select distinct u as user_id from unnest(p_recipients) as u where u is not null) r
  where exists (select 1 from public.push_subscriptions s where s.user_id = r.user_id)
    and coalesce(
      (select np.enabled from public.notification_preferences np
        where np.organization_id = p_org and np.user_id = r.user_id and np.event_type = p_event_type),
      true) = true;
end;
$$;

-- Alleen aan te roepen vanuit de SECURITY DEFINER triggers (draaien als owner); nooit
-- via de API. In Supabase krijgen anon/authenticated EXECUTE via expliciete grants,
-- dus revoke van álle API-rollen (niet enkel PUBLIC), anders is dit met de anon-key
-- aanroepbaar en omzeilt het RLS.
revoke execute on function public.push_enqueue(uuid, text, uuid[], jsonb) from public, anon, authenticated;

-- Alle actieve leden van een organisatie (ontvangers voor org-brede gebeurtenissen).
create or replace function public.push_org_member_ids(p_org uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.user_id), '{}'::uuid[])
  from public.organization_members m
  where m.organization_id = p_org and m.status = 'active';
$$;

revoke execute on function public.push_org_member_ids(uuid) from public, anon, authenticated;

-- ── 5. Trigger-functies per gebeurtenis ──────────────────────────────────────
-- Elke functie is SECURITY DEFINER (leest andermans subs/prefs) en swallowt fouten
-- in een genest block: het melden mag de bron-insert nooit laten klappen.

-- Nieuw ticket dat de KLANT aanmaakte (created_by is geen actief org-lid). Zelfde
-- criterium als de ticket_unread view.
create or replace function public.push_on_ticket_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_name text;
  v_body text;
begin
  begin
    if new.created_by is not null and exists (
      select 1 from public.organization_members m
      where m.organization_id = new.organization_id and m.user_id = new.created_by
    ) then
      return null; -- intern ticket → geen push
    end if;

    select c.name into v_client_name from public.clients c where c.id = new.client_id;
    v_body := coalesce(nullif(btrim(v_client_name), ''), 'Onbekende klant')
              || ': ' || coalesce(nullif(btrim(new.title), ''), '(geen titel)');

    perform public.push_enqueue(
      new.organization_id, 'ticket_new',
      public.push_org_member_ids(new.organization_id),
      jsonb_build_object('title', 'Nieuw ticket', 'body', v_body, 'url', '/', 'tag', 'ticket:' || new.id::text)
    );
  exception when others then
    raise warning 'push_on_ticket_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_tickets_insert on public.tickets;
create trigger push_tickets_insert after insert on public.tickets
  for each row execute function public.push_on_ticket_insert();

-- Nieuwe klantreactie op een ticket (author_type='client').
create or replace function public.push_on_ticket_note_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_client_name text;
  v_body text;
begin
  begin
    if new.author_type is distinct from 'client' then return null; end if;

    select t.title, c.name into v_title, v_client_name
    from public.tickets t
    left join public.clients c on c.id = t.client_id
    where t.id = new.ticket_id;

    v_body := coalesce(nullif(btrim(v_client_name), ''), 'Onbekende klant')
              || ': ' || coalesce(nullif(btrim(v_title), ''), '(ticket)');

    perform public.push_enqueue(
      new.organization_id, 'ticket_note_client',
      public.push_org_member_ids(new.organization_id),
      jsonb_build_object('title', 'Nieuwe reactie', 'body', v_body, 'url', '/', 'tag', 'ticket:' || new.ticket_id::text)
    );
  exception when others then
    raise warning 'push_on_ticket_note_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_ticket_notes_insert on public.ticket_notes;
create trigger push_ticket_notes_insert after insert on public.ticket_notes
  for each row execute function public.push_on_ticket_note_insert();

-- Nieuw teamchat-bericht → alle deelnemers behalve de afzender.
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
  v_body text;
begin
  begin
    -- Leeg bericht zonder bijlage (bv. tussentijdse insert): niets te melden.
    if new.deleted_at is not null then return null; end if;
    if coalesce(btrim(new.body), '') = '' and coalesce(new.attachment_count, 0) = 0 then return null; end if;

    select array_agg(p.user_id) into v_recipients
    from public.chat_participants p
    where p.conversation_id = new.conversation_id
      and p.user_id is distinct from new.sender_id;

    if v_recipients is null or array_length(v_recipients, 1) is null then return null; end if;

    select c.kind, c.title into v_kind, v_conv_title
    from public.chat_conversations c where c.id = new.conversation_id;

    select m.email into v_sender_email
    from public.organization_members m
    where m.organization_id = new.organization_id and m.user_id = new.sender_id
    limit 1;
    v_sender_label := coalesce(nullif(split_part(coalesce(v_sender_email, ''), '@', 1), ''), 'Teamlid');

    -- Titel: kanaalnaam bij een kanaal, anders de afzender.
    v_title := case when v_kind = 'channel' then coalesce(nullif(btrim(v_conv_title), ''), 'Kanaal')
                    else v_sender_label end;

    if coalesce(btrim(new.body), '') = '' then
      v_snippet := v_sender_label || ' stuurde een bijlage';
    elsif v_kind = 'channel' then
      v_snippet := v_sender_label || ': ' || left(btrim(new.body), 140);
    else
      v_snippet := left(btrim(new.body), 140);
    end if;

    perform public.push_enqueue(
      new.organization_id, 'chat_message', v_recipients,
      jsonb_build_object('title', v_title, 'body', v_snippet, 'url', '/', 'tag', 'chat:' || new.conversation_id::text)
    );
  exception when others then
    raise warning 'push_on_chat_message_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_chat_messages_insert on public.chat_messages;
create trigger push_chat_messages_insert after insert on public.chat_messages
  for each row execute function public.push_on_chat_message_insert();

-- Inkomende klant-e-mail (reply) → alle actieve leden.
create or replace function public.push_on_client_email_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text;
begin
  begin
    if new.direction is distinct from 'inbound' then return null; end if;

    v_body := coalesce(nullif(btrim(new.from_name), ''), nullif(btrim(new.from_email), ''), 'Onbekende afzender')
              || ': ' || coalesce(nullif(btrim(new.subject), ''), '(geen onderwerp)');

    perform public.push_enqueue(
      new.organization_id, 'client_email_inbound',
      public.push_org_member_ids(new.organization_id),
      jsonb_build_object('title', 'Nieuwe e-mail', 'body', v_body, 'url', '/', 'tag', 'email:' || new.thread_id::text)
    );
  exception when others then
    raise warning 'push_on_client_email_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_client_emails_insert on public.client_emails;
create trigger push_client_emails_insert after insert on public.client_emails
  for each row execute function public.push_on_client_email_insert();

-- Nieuwe/bevestigde boeking → de eigenaar van de boekingslink.
create or replace function public.push_on_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_link_title text;
  v_body text;
begin
  begin
    -- Alleen melden bij een bevestigde boeking, precies één keer (bij de overgang
    -- naar 'confirmed', of meteen als hij bevestigd binnenkomt).
    if new.status is distinct from 'confirmed' then return null; end if;
    if tg_op = 'UPDATE' and old.status is not distinct from 'confirmed' then return null; end if;

    select l.user_id, l.title into v_owner, v_link_title
    from public.meeting_booking_links l where l.id = new.booking_link_id;
    if v_owner is null then return null; end if;

    v_body := coalesce(nullif(btrim(new.booked_name), ''), nullif(btrim(new.booked_email), ''), 'Onbekend')
              || coalesce(' — ' || nullif(btrim(v_link_title), ''), '');

    perform public.push_enqueue(
      new.organization_id, 'booking_new', array[v_owner],
      jsonb_build_object('title', 'Nieuwe boeking', 'body', v_body, 'url', '/', 'tag', 'booking:' || new.id::text)
    );
  exception when others then
    raise warning 'push_on_booking: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_meeting_bookings_insert on public.meeting_bookings;
create trigger push_meeting_bookings_insert after insert on public.meeting_bookings
  for each row execute function public.push_on_booking();

drop trigger if exists push_meeting_bookings_confirm on public.meeting_bookings;
create trigger push_meeting_bookings_confirm after update of status on public.meeting_bookings
  for each row execute function public.push_on_booking();

-- Factuur op 'paid' gezet → alle actieve leden.
create or replace function public.push_on_invoice_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_name text;
  v_body text;
begin
  begin
    if new.status is distinct from 'paid' then return null; end if;
    if old.status is not distinct from 'paid' then return null; end if;

    select c.name into v_client_name from public.clients c where c.id = new.client_id;
    v_body := 'Factuur ' || coalesce(nullif(btrim(new.number), ''), '')
              || coalesce(' — ' || nullif(btrim(v_client_name), ''), '');

    perform public.push_enqueue(
      new.organization_id, 'invoice_paid',
      public.push_org_member_ids(new.organization_id),
      jsonb_build_object('title', 'Factuur betaald', 'body', btrim(v_body), 'url', '/', 'tag', 'invoice:' || new.id::text)
    );
  exception when others then
    raise warning 'push_on_invoice_paid: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_invoices_paid on public.invoices;
create trigger push_invoices_paid after update of status on public.invoices
  for each row execute function public.push_on_invoice_paid();

-- ── 6. Dispatcher-RPC's (service-role) ───────────────────────────────────────
-- Claim atomisch een batch te-versturen meldingen. Pakt 'queued' rijen én rijen
-- die langer dan 5 min in 'sending' hangen (crash-herstel). Zet attempts op en
-- markeert doodgelopen rijen (>=5 pogingen) als 'dead' zodat ze niet blijven ronddraaien.
create or replace function public.claim_push_outbox(p_limit integer default 50)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Doodverklaar rijen die te vaak hebben gefaald (voordat we claimen).
  update public.notification_outbox
    set status = 'dead', updated_at = now()
    where status in ('queued','sending') and attempts >= 5;

  return query
  update public.notification_outbox o
    set status = 'sending', attempts = o.attempts + 1, updated_at = now()
  where o.id in (
    select c.id from public.notification_outbox c
    where c.status = 'queued'
       or (c.status = 'sending' and c.updated_at < now() - interval '5 minutes')
    order by c.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  )
  returning o.*;
end;
$$;

-- Alleen de dispatcher (service-role) mag claimen; niet bereikbaar voor app-gebruikers.
revoke execute on function public.claim_push_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_push_outbox(integer) to service_role;

-- Markeer een outbox-rij als verstuurd of (opnieuw) te proberen.
create or replace function public.mark_push_outbox(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('queued','sent','failed','dead') then
    raise exception 'mark_push_outbox: ongeldige status %', p_status;
  end if;
  update public.notification_outbox
    set status = p_status,
        last_error = p_error,
        sent_at = case when p_status = 'sent' then now() else sent_at end,
        updated_at = now()
    where id = p_id;
end;
$$;

revoke execute on function public.mark_push_outbox(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_push_outbox(uuid, text, text) to service_role;

commit;
