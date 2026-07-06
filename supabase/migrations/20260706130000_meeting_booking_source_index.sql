-- ============================================================
-- ResoFly — Meeting Booking Tool: index voor conflict-reconciliatie
-- Date: 2026-07-06
--
-- Ondersteunt de nieuwe lookup in cancelConflictingBookingSlots(): bij elke
-- agenda-schrijfactie (aanmaken/bewerken/verplaatsen, ongeacht native/Google/
-- Microsoft) zoeken we de actieve boekingslinks op dezelfde agenda-bron op om
-- overlappende, nog openstaande boekingsopties te annuleren. Dit pad draait nu
-- op elke agenda-mutatie in de hele app, dus een gerichte partial index i.p.v.
-- op de bestaande organization_id-index leunen.
-- ============================================================

begin;

create index if not exists idx_meeting_booking_links_source_active
  on public.meeting_booking_links(organization_id, source_id)
  where status = 'active';

commit;
