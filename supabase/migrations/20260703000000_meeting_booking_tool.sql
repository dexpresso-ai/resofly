-- ============================================================
-- ResoFly — Meeting Booking Tool (Calendly-achtig)
-- Date: 2026-07-03
--
-- Scope (fase 1):
-- - meeting_booking_links: één boekingslink per klant, gekoppeld aan één agenda
--   (calendar_sources: native/Google/Microsoft). Bevat de begeleidende teksten,
--   een vaste videocall-link, de limieten (totaal + per week) en een publiek
--   token (alleen de sha256-hash bewaard, spiegelt contracts.public_token_hash).
-- - meeting_booking_slots: de door de gebruiker gereserveerde beschikbare
--   tijdblokken. Status open → pending (tijdens boeken) → booked, of cancelled.
-- - meeting_bookings: bevestigde/lopende boekingen door de klant, met verwijzing
--   naar het aangemaakte agenda-item (native of extern).
--
-- Race-condities: het boeken loopt in twee fasen. Fase A (reserve_*) claimt het
-- blok atomisch als 'pending' onder een per-link advisory lock en bewaakt de
-- limieten; fase B (edge function) maakt het agenda-item aan en roept finalize_*
-- (→ 'confirmed'/'booked') of release_* (→ 'failed'/'open') aan. Een pending-slot
-- ouder dan 2 minuten wordt als vervallen behandeld (zelfherstellend, geen cron).
--
-- Weekgrens: ISO-week (maandag–zondag) in Europe/Amsterdam, DST-veilig via
-- date_trunc('week', starts_at at time zone 'Europe/Amsterdam').
-- ============================================================

begin;

-- ── 1. Tabellen ──────────────────────────────────────────────────────────────

create table if not exists public.meeting_booking_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  client_id uuid references public.clients(id) on delete set null,
  -- Agenda waarop beschikbare blokken en boekingen landen. SET NULL i.p.v.
  -- cascade zodat boekingshistorie bewaard blijft als de agenda verwijderd wordt.
  source_id uuid references public.calendar_sources(id) on delete set null,
  title text not null default 'Afspraak inplannen',
  intro_text text,
  invite_message text,
  meeting_url text,
  max_total_bookings integer not null default 1 check (max_total_bookings > 0),
  max_per_week integer not null default 1 check (max_per_week > 0),
  status text not null default 'active' check (status in ('active','closed')),
  public_token_hash text,
  public_token_created_at timestamptz,
  public_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_booking_links_public_token_hash_unique unique (public_token_hash)
);

create index if not exists idx_meeting_booking_links_org on public.meeting_booking_links(organization_id);
create index if not exists idx_meeting_booking_links_client on public.meeting_booking_links(client_id);
create index if not exists idx_meeting_booking_links_token on public.meeting_booking_links(public_token_hash) where public_token_hash is not null;

create table if not exists public.meeting_booking_slots (
  id uuid primary key default gen_random_uuid(),
  booking_link_id uuid not null references public.meeting_booking_links(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'open' check (status in ('open','pending','booked','cancelled')),
  pending_at timestamptz,
  created_at timestamptz not null default now(),
  constraint meeting_booking_slots_time_order check (ends_at > starts_at)
);

create index if not exists idx_meeting_booking_slots_link_time
  on public.meeting_booking_slots(booking_link_id, starts_at) where status in ('open','pending');
create index if not exists idx_meeting_booking_slots_link
  on public.meeting_booking_slots(booking_link_id);

create table if not exists public.meeting_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_link_id uuid not null references public.meeting_booking_links(id) on delete cascade,
  slot_id uuid not null references public.meeting_booking_slots(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  booked_name text,
  booked_email text not null,
  native_event_id uuid references public.calendar_events(id) on delete set null,
  external_event_id text,
  external_provider text check (external_provider in ('google','microsoft')),
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','failed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists idx_meeting_bookings_link_status on public.meeting_bookings(booking_link_id, status);
create index if not exists idx_meeting_bookings_slot on public.meeting_bookings(slot_id);
-- Eén actieve claim per slot, ook als de advisory lock ooit gemist zou worden.
create unique index if not exists idx_meeting_bookings_slot_active
  on public.meeting_bookings(slot_id) where status in ('pending','confirmed');

-- ── 2. Triggers (updated_at + org-immutabiliteit) ────────────────────────────

drop trigger if exists meeting_booking_links_updated on public.meeting_booking_links;
create trigger meeting_booking_links_updated before update on public.meeting_booking_links
  for each row execute function public.set_updated_at();

drop trigger if exists meeting_booking_links_prevent_org_change on public.meeting_booking_links;
create trigger meeting_booking_links_prevent_org_change
  before update of organization_id on public.meeting_booking_links
  for each row execute function public.prevent_organization_id_change();

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
-- Alle echte toegang loopt via de service-role edge functions; deze policies zijn
-- het org-vangnet voor directe toegang met een gebruikerstoken.

alter table public.meeting_booking_links enable row level security;
alter table public.meeting_booking_slots enable row level security;
alter table public.meeting_bookings enable row level security;

drop policy if exists "meeting_booking_links read" on public.meeting_booking_links;
create policy "meeting_booking_links read" on public.meeting_booking_links for select using (public.can_read_org(organization_id));
drop policy if exists "meeting_booking_links write" on public.meeting_booking_links;
create policy "meeting_booking_links write" on public.meeting_booking_links for all
  using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));

drop policy if exists "meeting_booking_slots read" on public.meeting_booking_slots;
create policy "meeting_booking_slots read" on public.meeting_booking_slots for select using (public.can_read_org(organization_id));
drop policy if exists "meeting_booking_slots write" on public.meeting_booking_slots;
create policy "meeting_booking_slots write" on public.meeting_booking_slots for all
  using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));

drop policy if exists "meeting_bookings read" on public.meeting_bookings;
create policy "meeting_bookings read" on public.meeting_bookings for select using (public.can_read_org(organization_id));
drop policy if exists "meeting_bookings write" on public.meeting_bookings;
create policy "meeting_bookings write" on public.meeting_bookings for all
  using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));

-- ── 4. RPC: blok reserveren via publiek token (fase A) ───────────────────────

create or replace function public.reserve_meeting_slot_by_token(
  p_token_hash text,
  p_slot_id uuid,
  p_name text,
  p_email text
)
returns table(booking_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.meeting_booking_links;
  v_slot public.meeting_booking_slots;
  v_total integer;
  v_week integer;
  v_booking_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Ongeldig e-mailadres.' using errcode = '23514';
  end if;

  select * into v_link from public.meeting_booking_links where public_token_hash = p_token_hash;
  if not found then raise exception 'Boekingslink niet gevonden.' using errcode = '02000'; end if;
  if v_link.status <> 'active' then raise exception 'Deze boekingslink is gesloten.' using errcode = '23514'; end if;
  if v_link.public_token_expires_at is null or v_link.public_token_expires_at < now() then
    raise exception 'Deze boekingslink is verlopen.' using errcode = '23514';
  end if;

  -- Serialiseer gelijktijdige boekingen per link.
  perform pg_advisory_xact_lock(hashtext(v_link.id::text), hashtext('meeting_booking_slot'));

  -- Vervallen pending-slots (edge function gecrasht tussen fase A en B) weer vrijgeven.
  update public.meeting_booking_slots
    set status = 'open', pending_at = null
    where booking_link_id = v_link.id and status = 'pending' and pending_at < now() - interval '2 minutes';

  select * into v_slot from public.meeting_booking_slots
    where id = p_slot_id and booking_link_id = v_link.id for update;
  if not found then raise exception 'Tijdblok niet gevonden.' using errcode = '02000'; end if;
  if v_slot.status <> 'open' then raise exception 'Dit tijdblok is niet meer beschikbaar.' using errcode = '23514'; end if;

  select count(*) into v_total from public.meeting_bookings
    where booking_link_id = v_link.id and status in ('pending','confirmed');
  if v_total >= v_link.max_total_bookings then
    raise exception 'Het maximum aantal boekingen voor deze link is bereikt.' using errcode = '23514';
  end if;

  select count(*) into v_week
    from public.meeting_bookings b
    join public.meeting_booking_slots s on s.id = b.slot_id
    where b.booking_link_id = v_link.id
      and b.status in ('pending','confirmed')
      and date_trunc('week', (s.starts_at at time zone 'Europe/Amsterdam'))
        = date_trunc('week', (v_slot.starts_at at time zone 'Europe/Amsterdam'));
  if v_week >= v_link.max_per_week then
    raise exception 'Het maximum aantal boekingen in die week is bereikt.' using errcode = '23514';
  end if;

  update public.meeting_booking_slots set status = 'pending', pending_at = now() where id = v_slot.id;

  insert into public.meeting_bookings(booking_link_id, slot_id, organization_id, client_id, booked_name, booked_email, status)
    values (v_link.id, v_slot.id, v_link.organization_id, v_link.client_id, v_name, v_email, 'pending')
    returning id into v_booking_id;

  return query select v_booking_id, v_slot.starts_at, v_slot.ends_at;
end;
$$;

-- ── 5. RPC: boeking afronden (fase B, succes) ────────────────────────────────

create or replace function public.finalize_meeting_booking(
  p_booking_id uuid,
  p_native_event_id uuid,
  p_external_event_id text,
  p_external_provider text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_slot uuid;
begin
  update public.meeting_bookings
    set status = 'confirmed',
        confirmed_at = now(),
        native_event_id = p_native_event_id,
        external_event_id = p_external_event_id,
        external_provider = p_external_provider
    where id = p_booking_id and status = 'pending'
    returning slot_id into v_slot;
  if v_slot is null then return; end if; -- idempotent
  update public.meeting_booking_slots set status = 'booked', pending_at = null where id = v_slot;
end;
$$;

-- ── 6. RPC: boeking vrijgeven (fase B, mislukt) ──────────────────────────────

create or replace function public.release_meeting_booking(
  p_booking_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_slot uuid;
begin
  update public.meeting_bookings set status = 'failed', cancelled_at = now()
    where id = p_booking_id and status = 'pending'
    returning slot_id into v_slot;
  if v_slot is null then return; end if;
  update public.meeting_booking_slots set status = 'open', pending_at = null
    where id = v_slot and status = 'pending';
end;
$$;

-- ── 7. RPC: bevestigde boeking annuleren (interne gebruiker) ─────────────────
-- Geeft de agenda-item-verwijzingen terug zodat de edge function het bijbehorende
-- agenda-item kan verwijderen; zet de boeking op cancelled en het blok terug op open.

create or replace function public.cancel_meeting_booking(
  p_organization_id uuid,
  p_booking_id uuid
)
returns table(native_event_id uuid, external_event_id text, external_provider text, source_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.meeting_bookings;
  v_source uuid;
begin
  select * into v_booking from public.meeting_bookings
    where id = p_booking_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Boeking niet gevonden.' using errcode = '02000'; end if;

  select mbl.source_id into v_source from public.meeting_booking_links mbl where mbl.id = v_booking.booking_link_id;

  if v_booking.status <> 'cancelled' then
    update public.meeting_bookings set status = 'cancelled', cancelled_at = now() where id = p_booking_id;
    update public.meeting_booking_slots set status = 'open', pending_at = null where id = v_booking.slot_id;
  end if;

  return query select v_booking.native_event_id, v_booking.external_event_id, v_booking.external_provider, v_source;
end;
$$;

-- ── 8. Grants ────────────────────────────────────────────────────────────────
-- Alleen de service-role edge functions roepen deze RPC's aan.

revoke all on function public.reserve_meeting_slot_by_token(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_meeting_slot_by_token(text, uuid, text, text) to service_role;
revoke all on function public.finalize_meeting_booking(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_meeting_booking(uuid, uuid, text, text) to service_role;
revoke all on function public.release_meeting_booking(uuid, text) from public, anon, authenticated;
grant execute on function public.release_meeting_booking(uuid, text) to service_role;
revoke all on function public.cancel_meeting_booking(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_meeting_booking(uuid, uuid) to service_role;

commit;
