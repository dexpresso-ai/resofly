// ============================================================
// Gedeelde reconciliatie: boekingsopties annuleren bij een botsende afspraak
//
// Zodra er ergens op een agenda-bron een afspraak wordt aangemaakt of verplaatst
// (handmatig door de gebruiker, door Gerrie, of doordat een klant zelf een blok
// boekt), kunnen nog-openstaande boekingsopties (meeting_booking_slots met
// status 'open') op diezelfde bron ineens niet meer kloppen. Deze functie
// annuleert die opties meteen, zodat de klant op de publieke boekingspagina en
// de gebruiker in de agenda-laag alleen nog momenten ziet die daadwerkelijk vrij
// zijn. Hergebruikt door calendarEventWrite.ts (createEvent/createNativeEvent)
// en calendar-integrations/index.ts (updateEvent/updateNativeEvent).
//
// Bewust alleen status 'open' → 'cancelled': een 'pending' slot zit al midden in
// een boekingspoging (twee-fasen-commit) en lost zichzelf op binnen ~2 minuten;
// die niet aanraken voorkomt gedoe met de reserve/finalize/release-RPC's. De
// UPDATE zelf her-checkt status='open' (niet alleen de voorafgaande SELECT), zodat
// een slot dat tussen het lezen en schrijven door een gelijktijdige boeking naar
// 'pending'/'booked' is overgegaan, niet alsnog wordt overschreven.
// ============================================================

import { type CalendarSourceRow, type NativeEventRow, supabaseAdmin } from './calendarCore.ts';
import { expandRecurringNativeRow } from './calendarAvailability.ts';

async function activeLinkIdsForSource(organizationId: string, sourceId: string): Promise<string[]> {
  const { data: links, error } = await supabaseAdmin.from('meeting_booking_links')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('source_id', sourceId)
    .eq('status', 'active');
  if (error) throw error;
  return ((links ?? []) as Array<{ id: string }>).map(l => l.id);
}

/** Annuleert 'open' opties op de gegeven links die overlappen met [startsAt, endsAt). */
async function cancelOverlapping(linkIds: string[], startsAt: string, endsAt: string): Promise<void> {
  const { data: slots, error: slotsError } = await supabaseAdmin.from('meeting_booking_slots')
    .select('id')
    .in('booking_link_id', linkIds)
    .eq('status', 'open')
    .lt('starts_at', endsAt)
    .gt('ends_at', startsAt);
  if (slotsError) throw slotsError;
  const slotIds = ((slots ?? []) as Array<{ id: string }>).map(s => s.id);
  if (!slotIds.length) return;
  const { error: updateError } = await supabaseAdmin.from('meeting_booking_slots')
    .update({ status: 'cancelled' })
    // Her-check status='open' op het moment van schrijven: sluit het gat tussen
    // de SELECT hierboven en deze UPDATE, zodat een slot dat er intussen door een
    // gelijktijdige boeking 'pending' of 'booked' bij staat niet wordt geraakt.
    .in('id', slotIds)
    .eq('status', 'open');
  if (updateError) throw updateError;
}

/** Enkele (niet-herhalende) afspraak: annuleert overlappende opties voor [startsAt, endsAt). */
export async function cancelConflictingBookingSlots(
  organizationId: string,
  sourceId: string | null | undefined,
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
): Promise<void> {
  if (!sourceId || !startsAt || !endsAt) return;
  try {
    const linkIds = await activeLinkIdsForSource(organizationId, sourceId);
    if (!linkIds.length) return;
    await cancelOverlapping(linkIds, startsAt, endsAt);
  } catch (err) {
    // Best-effort: dit mag de agenda-actie zelf nooit laten falen.
    console.error('cancelConflictingBookingSlots failed', err);
  }
}

/**
 * Zelfde, maar voor een (mogelijk) herhalende native afspraak: elke afzonderlijke
 * voorkomst binnen het venster waarin er nog open opties liggen wordt gecheckt —
 * niet alleen de eerste (basis)voorkomst. Begrensd tot de omvang van de
 * daadwerkelijk nog openstaande opties (geen open opties → geen extra kosten);
 * bij een zeer oude herhalende reeks kan de onderliggende expansie (max. 800
 * stappen, zelfde grens als elders in de agenda) een ver-in-de-toekomst-liggend
 * venster in zeldzame gevallen niet volledig bereiken.
 */
export async function cancelConflictingBookingSlotsForNativeEvent(
  organizationId: string,
  source: CalendarSourceRow,
  row: NativeEventRow,
): Promise<void> {
  if (!row.recurs || !row.rrule) {
    await cancelConflictingBookingSlots(organizationId, source.id, row.starts_at, row.ends_at);
    return;
  }
  try {
    const linkIds = await activeLinkIdsForSource(organizationId, source.id);
    if (!linkIds.length) return;
    const { data: openSlots, error } = await supabaseAdmin.from('meeting_booking_slots')
      .select('starts_at,ends_at')
      .in('booking_link_id', linkIds)
      .eq('status', 'open')
      .order('starts_at', { ascending: true });
    if (error) throw error;
    const rows = (openSlots ?? []) as Array<{ starts_at: string; ends_at: string }>;
    if (!rows.length) return;
    // Alleen het venster expanderen waarin daadwerkelijk nog open opties liggen —
    // een voorkomst buiten dat venster kan sowieso geen enkele open optie raken.
    const windowStart = rows[0].starts_at;
    const windowEnd = rows.reduce((max, r) => (r.ends_at > max ? r.ends_at : max), rows[0].ends_at);
    const occurrences = expandRecurringNativeRow(row, source, windowStart, windowEnd);
    for (const occ of occurrences) {
      await cancelOverlapping(linkIds, String(occ.starts_at), String(occ.ends_at));
    }
  } catch (err) {
    console.error('cancelConflictingBookingSlotsForNativeEvent failed', err);
  }
}
