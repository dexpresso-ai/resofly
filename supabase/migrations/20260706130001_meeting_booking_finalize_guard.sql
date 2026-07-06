-- ============================================================
-- ResoFly — Meeting Booking Tool: statusbewaking bij finaliseren
-- Date: 2026-07-06
--
-- finalize_meeting_booking() zette het slot altijd naar 'booked' zonder de
-- huidige status te controleren (in tegenstelling tot release_meeting_booking(),
-- die wél `and status = 'pending'` bewaakt). Door de nieuwe automatische
-- conflict-annulering (cancelConflictingBookingSlots) kan een slot dat lang
-- 'pending' staat (bv. door een trage Google/Microsoft-aanroep) intussen door de
-- 2-minuten-zelfherstel-sweep zijn vrijgegeven én daarna alweer geannuleerd zijn
-- vanwege een andere, inmiddels botsende afspraak. Zonder deze bewaking zou
-- finalize dat 'cancelled'-blok stilzwijgend terugzetten naar 'booked'.
--
-- Met deze bewaking: als het slot bij het finaliseren niet meer 'pending' is,
-- slaat de slot-update over (de boeking zelf wordt nog altijd bevestigd — het
-- agenda-item/de uitnodiging bestaat al — maar het blok wordt niet meer blind
-- overschreven).
-- ============================================================

begin;

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
  update public.meeting_booking_slots set status = 'booked', pending_at = null
    where id = v_slot and status = 'pending';
end;
$$;

commit;
