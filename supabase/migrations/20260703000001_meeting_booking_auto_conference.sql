-- ============================================================
-- ResoFly — Meeting Booking Tool: automatische videovergadering
-- Date: 2026-07-03
--
-- Per boekingslink een voorkeur of er bij het boeken automatisch een
-- videovergadering bij de provider wordt aangemaakt: Google Meet op een Google-
-- agenda, Teams op een Microsoft-agenda. Standaard aan. Een zelf ingevulde vaste
-- meeting_url heeft voorrang (dan wordt géén nieuwe vergadering gegenereerd), en
-- native ResoFly-agenda's hebben geen provider om er een te maken.
-- ============================================================

begin;

alter table public.meeting_booking_links
  add column if not exists auto_conference boolean not null default true;

commit;
