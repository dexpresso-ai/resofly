-- ============================================================
-- ResoFly — Boekingen: de videolink bij de afspraak zelf, voor het
-- klantportaal
-- Date: 2026-11-11
--
-- Een klant die via een boekingslink een afspraak maakte, zag die afspraak
-- daarna nergens terug behalve in zijn mail en zijn eigen agenda. Het
-- klantportaal toont hem nu (client-portal: afspraken), met de link naar het
-- videogesprek. Die link stond alleen bij het agenda-item (bij Google en
-- Microsoft niet eens bij ons) en in de bevestigingsmail; wie de mail kwijt
-- was, had geen link. Daarom bewaart meeting-booking-public hem nu bij de
-- boeking, met de dienst erbij (Jitsi, Google Meet, Teams, Zoom of een
-- andere link).
--
--   1. Twee kolommen op meeting_bookings: meeting_url en video_service, met
--      een controle: alleen een http(s)-link zonder stuurtekens, hooguit 2048
--      tekens, en alleen bekende diensten.
--   2. Een index voor het portaal: de afspraken van één klant.
--   3. Eenmalig: bestaande boekingen krijgen de link die er al was (de
--      afspraak in de eigen ResoFly-agenda, of de vaste link van de
--      boekingslink), met de dienst erbij.
--
-- Alleen de service-role schrijft hier (de policies zijn ongewijzigd). Veilig
-- om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Kolommen ─────────────────────────────────────────────────────────────

alter table public.meeting_bookings
  add column if not exists meeting_url text,
  add column if not exists video_service text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'meeting_bookings_video_service_check'
       and conrelid = 'public.meeting_bookings'::regclass
  ) then
    alter table public.meeting_bookings
      add constraint meeting_bookings_video_service_check
      check (video_service is null or video_service in ('jitsi', 'google_meet', 'teams', 'zoom', 'link'));
  end if;

  -- Een videolink belandt in het portaal van de klant en in een knop
  -- "Deelnemen": nooit een javascript:-link, nooit een regeleinde.
  if not exists (
    select 1 from pg_constraint
     where conname = 'meeting_bookings_meeting_url_check'
       and conrelid = 'public.meeting_bookings'::regclass
  ) then
    alter table public.meeting_bookings
      add constraint meeting_bookings_meeting_url_check
      check (meeting_url is null or (
        length(meeting_url) <= 2048
        and meeting_url ~* '^https?://[^[:space:]/]+'
        and meeting_url !~ '[[:cntrl:]]'
      ));
  end if;
end $$;

comment on column public.meeting_bookings.meeting_url is
  'De link naar het videogesprek van deze afspraak (Jitsi, Meet, Teams of een vaste link). Het klantportaal toont hem.';
comment on column public.meeting_bookings.video_service is
  'Welke dienst achter meeting_url zit: jitsi, google_meet, teams, zoom of link.';

-- ── 2. Index voor het portaal ───────────────────────────────────────────────

create index if not exists idx_meeting_bookings_client
  on public.meeting_bookings(organization_id, client_id)
  where client_id is not null;

-- ── 3. Eenmalig: de link die er al was ──────────────────────────────────────

-- De afspraak in de eigen ResoFly-agenda (Jitsi per boeking, of een vaste link).
update public.meeting_bookings b
   set meeting_url = e.meeting_url
  from public.calendar_events e
 where b.meeting_url is null
   and b.native_event_id = e.id
   and e.organization_id = b.organization_id
   and length(e.meeting_url) <= 2048
   and e.meeting_url ~* '^https?://[^[:space:]/]+'
   and e.meeting_url !~ '[[:cntrl:]]';

-- Anders de vaste link van de boekingslink.
update public.meeting_bookings b
   set meeting_url = l.meeting_url
  from public.meeting_booking_links l
 where b.meeting_url is null
   and b.booking_link_id = l.id
   and l.organization_id = b.organization_id
   and length(l.meeting_url) <= 2048
   and l.meeting_url ~* '^https?://[^[:space:]/]+'
   and l.meeting_url !~ '[[:cntrl:]]';

-- De dienst, aan de link herkend (dezelfde regels als videoKindOfUrl in
-- supabase/functions/_shared/meetingBookingRules.ts).
update public.meeting_bookings
   set video_service = case
     when meeting_url ~* '^https?://meet\.google\.com(/|$)' then 'google_meet'
     when meeting_url ~* '^https?://([a-z0-9-]+\.)*teams\.microsoft\.com(/|$)'
       or meeting_url ~* '^https?://teams\.live\.com(/|$)' then 'teams'
     when meeting_url ~* '^https?://([a-z0-9-]+\.)*zoom\.(us|com)(/|$)' then 'zoom'
     when meeting_url ~* '^https?://(meet\.jit\.si|8x8\.vc)(/|$)'
       or meeting_url ~ '/ResoFly-[A-Za-z0-9]{14}/?$' then 'jitsi'
     else 'link'
   end
 where meeting_url is not null
   and video_service is null;

commit;
