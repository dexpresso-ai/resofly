-- ============================================================
-- ResoFly — Genodigden bij agenda-items + uitnodigingen (fase 5)
-- Date: 2026-06-25
--
-- Scope:
-- - Genodigden bij een native agenda-item, met RSVP-status. Uitnodigingen gaan
--   via iMIP (e-mail met .ics-bijlage). Antwoorden (accepteren/afwijzen) komen
--   terug op een ORGANIZER-adres met een token per event:
--   organizer+<organizer_token>@<inbound-domein>.
-- - `calendar_events.organizer_token`: onraadbaar token per event, gezet zodra de
--   eerste uitnodiging verstuurd wordt. De REPLY-mail bevat het e-mailadres van de
--   genodigde, waarmee we de juiste rij bijwerken.
--
-- Beveiliging:
-- - RLS: lezen/schrijven door organisatieleden die het bijbehorende event mogen
--   zien (eigen agenda of org-gedeeld). De Worker/edge-functies gebruiken de
--   service-role en omzeilen RLS; RLS is hier het vangnet.
-- ============================================================

begin;

alter table public.calendar_events add column if not exists organizer_token text;
create unique index if not exists idx_calendar_events_organizer_token
  on public.calendar_events(organizer_token) where organizer_token is not null;

create table if not exists public.calendar_event_attendees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.calendar_events(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'req' check (role in ('req','opt')),
  is_organizer boolean not null default false,
  status text not null default 'needs-action' check (status in ('needs-action','accepted','declined','tentative')),
  invited_at timestamptz,
  responded_at timestamptz,
  last_sequence_sent integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, email)
);

create index if not exists idx_calendar_event_attendees_event on public.calendar_event_attendees(event_id);
create index if not exists idx_calendar_event_attendees_email on public.calendar_event_attendees(organization_id, lower(email));

drop trigger if exists calendar_event_attendees_updated on public.calendar_event_attendees;
create trigger calendar_event_attendees_updated before update on public.calendar_event_attendees
  for each row execute function public.set_updated_at();

alter table public.calendar_event_attendees enable row level security;

drop policy if exists "calendar_event_attendees read" on public.calendar_event_attendees;
create policy "calendar_event_attendees read" on public.calendar_event_attendees for select using (
  public.can_read_org(organization_id)
  and exists (
    select 1 from public.calendar_events e
    join public.calendar_sources s on s.id = e.source_id
    where e.id = calendar_event_attendees.event_id
      and e.organization_id = calendar_event_attendees.organization_id
      and (s.user_id = auth.uid() or s.visibility = 'organization')
  )
);

drop policy if exists "calendar_event_attendees write" on public.calendar_event_attendees;
create policy "calendar_event_attendees write" on public.calendar_event_attendees for all using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

commit;
