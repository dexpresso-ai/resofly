import {
  createIcsSubscription,
  createNativeCalendar,
  invalidateCalendarEventsCache,
  refreshCalendarSources,
  refreshIcsSubscription,
  updateCalendarEvent,
  updateCalendarSource,
  updateNativeCalendar,
  type CalendarEventInput,
  type NativeCalendarInput,
} from '../calendar-api';
import {
  addBookingSlots,
  cancelBooking,
  createBookingLink,
  regenerateBookingToken,
  removeBookingSlot,
  sendBookingLinkMail,
  updateBookingLink,
  type BookingLinkPatch,
  type CreateBookingLinkInput,
} from '../meetingBookingApi';
import {
  getRecording,
  sendSummaryToAttendees,
  summarizeRecording,
  updateRecordingText,
} from '../meeting-api';
import {
  createNoteCalendarLink,
  deleteNoteCalendarLink,
  updateTimeEntry,
  upsertCalendarEventLink,
} from '../repository';
import { flag, list, optText, patchOf, text, type ActionExecutor } from './types';
import type {
  CalendarEventLinkInput, CalendarNoteLinkInput, CalendarSource, CalendarVisibility, UUID,
} from '../../types';

/**
 * Uitvoerders voor de agenda-, boekings- en vergaderhandelingen. Elke functie doet
 * precies wat de knop in het agendascherm doet — zie
 * `supabase/functions/_shared/actions/calendar.ts` voor wat er op de goedkeurkaart
 * aan de gebruiker beloofd is.
 *
 * Agenda-items komen niet uit de geladen werkruimte maar live bij de edge function
 * vandaan, met een korte cache ertussen. Na elke mutatie die een afspraak raakt
 * gooien we die cache weg — precies zoals het agendascherm dat doet — anders staat
 * het rooster nog een halve minuut op de oude waarheid.
 */

/** Het object dat de server voor een afspraakbewerking heeft klaargezet. */
function eventInput(payload: Record<string, unknown>): CalendarEventInput {
  const raw = payload.event;
  if (!raw || typeof raw !== 'object') throw new Error('Deze actie mist de gegevens van de afspraak.');
  return raw as unknown as CalendarEventInput;
}

export const CALENDAR_EXECUTORS: Record<string, ActionExecutor> = {
  // ── Agendabronnen ─────────────────────────────────────────────────────────
  'calendar_source.create_native': async (payload, ctx) => {
    const created = await createNativeCalendar(ctx.organizationId, {
      name: text(payload, 'name'),
      color: optText(payload, 'color'),
      visibility: (optText(payload, 'visibility') as CalendarVisibility | null) ?? 'private',
    });
    return `ResoFly-agenda "${created.name}" aangemaakt`;
  },

  'calendar_source.update_native': async (payload, ctx) => {
    const sourceId = text(payload, 'source_id') as UUID;
    const patch = patchOf(payload) as Partial<NativeCalendarInput> & { sync_enabled?: boolean };
    const updated = await updateNativeCalendar(ctx.organizationId, sourceId, patch);
    return `Agenda "${updated.name}" bijgewerkt`;
  },

  'calendar_source.set_sharing': async (payload, ctx) => {
    const sourceId = text(payload, 'source_id') as UUID;
    const patch = patchOf(payload) as Pick<Partial<CalendarSource>, 'sync_enabled' | 'write_enabled' | 'visibility'>;
    const updated = await updateCalendarSource(ctx.organizationId, sourceId, patch);
    const parts: string[] = [];
    if (patch.sync_enabled !== undefined) parts.push(patch.sync_enabled ? 'wordt getoond' : 'is verborgen');
    if (patch.visibility !== undefined) parts.push(patch.visibility === 'organization' ? 'is gedeeld met het team' : 'is weer privé');
    if (patch.write_enabled !== undefined) parts.push(patch.write_enabled ? 'is schrijfbaar' : 'is alleen-lezen');
    return `Agenda "${updated.name}" ${parts.join(', ') || 'bijgewerkt'}`;
  },

  'calendar_source.refresh_provider': async (payload, ctx) => {
    const connectionId = text(payload, 'connection_id') as UUID;
    const result = await refreshCalendarSources(ctx.organizationId, connectionId);
    const mine = result.sources.filter((s) => s.connection_id === connectionId);
    const account = optText(payload, 'account');
    return `Agenda's opnieuw opgehaald${account ? ` bij ${account}` : ''} — ${mine.length} agenda${mine.length === 1 ? '' : "'s"} gevonden`;
  },

  'calendar_source.subscribe_ics': async (payload, ctx) => {
    const result = await createIcsSubscription(ctx.organizationId, {
      url: text(payload, 'url'),
      name: text(payload, 'name'),
      color: optText(payload, 'color'),
      visibility: (optText(payload, 'visibility') as CalendarVisibility | null) ?? 'private',
    });
    invalidateCalendarEventsCache(ctx.organizationId);
    // De feed wordt meteen opgehaald; lukt dat niet, dan blijft de agenda staan mét
    // foutmelding. Dat eerlijk melden is beter dan een lege agenda zonder uitleg.
    if (result.warning) return `Agenda "${result.source.name}" toegevoegd, maar de feed kon nog niet worden opgehaald: ${result.warning}`;
    return `Agenda "${result.source.name}" toegevoegd via de link — ${result.count} afspra${result.count === 1 ? 'ak' : 'ken'} opgehaald`;
  },

  'calendar_source.refresh_ics': async (payload, ctx) => {
    const sourceId = text(payload, 'source_id') as UUID;
    const result = await refreshIcsSubscription(ctx.organizationId, sourceId);
    invalidateCalendarEventsCache(ctx.organizationId);
    return `Agenda "${result.source.name}" opnieuw opgehaald — ${result.count} afspra${result.count === 1 ? 'ak' : 'ken'}`;
  },

  // ── Afspraak: koppeling, videocall en genodigden ──────────────────────────
  'calendar_event.set_link': async (payload, ctx) => {
    const link = payload.link;
    if (!link || typeof link !== 'object') throw new Error('Deze actie mist de gegevens van de koppeling.');
    const saved = await upsertCalendarEventLink(ctx.organizationId, link as unknown as CalendarEventLinkInput);
    const title = optText(payload, 'event_title') ?? 'De afspraak';
    const client = optText(payload, 'client_name');
    const where = client ? ` aan ${client}` : '';
    return saved.track_time
      ? `"${title}" gekoppeld${where} — de tijd telt mee voor de urenregistratie`
      : `"${title}" gekoppeld${where} — telt niet mee voor de urenregistratie`;
  },

  'calendar_event.set_meeting_url': async (payload, ctx) => {
    const eventId = text(payload, 'native_event_id') as UUID;
    const input = eventInput(payload);
    await updateCalendarEvent(ctx.organizationId, { eventId }, input);
    invalidateCalendarEventsCache(ctx.organizationId);
    const title = optText(payload, 'event_title') ?? 'de afspraak';
    return input.meetingUrl
      ? `Videocall-link op "${title}" gezet`
      : `Videocall-link van "${title}" weggehaald`;
  },

  'calendar_event.set_attendees': async (payload, ctx) => {
    const eventId = text(payload, 'native_event_id') as UUID;
    const input = eventInput(payload);
    await updateCalendarEvent(ctx.organizationId, { eventId }, input);
    invalidateCalendarEventsCache(ctx.organizationId);
    const title = optText(payload, 'event_title') ?? 'de afspraak';
    const added = Array.isArray(payload.added) ? (payload.added as unknown[]).length : 0;
    const removed = Array.isArray(payload.removed) ? (payload.removed as unknown[]).length : 0;
    const parts: string[] = [];
    if (added) parts.push(`${added} uitgenodigd`);
    if (removed) parts.push(`${removed} afgezegd`);
    return `Genodigden van "${title}" bijgewerkt${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  },

  // ── Notities bij een afspraak ─────────────────────────────────────────────
  'note.link_to_event': async (payload, ctx) => {
    const noteId = text(payload, 'note_id') as UUID;
    const link = payload.link;
    if (!link || typeof link !== 'object') throw new Error('Deze actie mist de gegevens van het agenda-item.');
    await createNoteCalendarLink(ctx.organizationId, noteId, link as unknown as CalendarNoteLinkInput);
    const note = optText(payload, 'note_title');
    return `${note ? `Notitie "${note}"` : 'De notitie'} hangt nu aan "${optText(payload, 'event_title') ?? 'de afspraak'}"`;
  },

  'note.unlink_from_event': async (payload, ctx) => {
    const linkId = text(payload, 'link_id') as UUID;
    await deleteNoteCalendarLink(linkId, ctx.organizationId);
    const note = optText(payload, 'note_title');
    return `${note ? `Notitie "${note}"` : 'De notitie'} losgekoppeld van de afspraak — de notitie zelf staat er nog`;
  },

  // ── Boekingslinks ─────────────────────────────────────────────────────────
  'booking_link.create': async (payload, ctx) => {
    const input: CreateBookingLinkInput = {
      sourceId: text(payload, 'sourceId') as UUID,
      clientId: (optText(payload, 'clientId') as UUID | null),
      title: text(payload, 'title'),
      introText: optText(payload, 'introText'),
      inviteMessage: optText(payload, 'inviteMessage'),
      meetingUrl: optText(payload, 'meetingUrl'),
      maxTotalBookings: Number(payload.maxTotalBookings) || 1,
      maxPerWeek: Number(payload.maxPerWeek) || 1,
      autoConference: flag(payload, 'autoConference'),
    };
    const result = await createBookingLink(ctx.organizationId, input);
    // De URL staat maar één keer in beeld: hij is alleen als hash opgeslagen.
    return `Boekingslink "${result.link.title}" aangemaakt — deel deze URL: ${result.booking_url}`;
  },

  'booking_link.update': async (payload, ctx) => {
    const linkId = text(payload, 'link_id') as UUID;
    const patch = patchOf(payload) as BookingLinkPatch;
    const updated = await updateBookingLink(ctx.organizationId, linkId, patch);
    if (patch.status === 'closed') return `Boekingslink "${updated.title}" gesloten — er kan niet meer geboekt worden`;
    if (patch.status === 'active') return `Boekingslink "${updated.title}" weer opengesteld`;
    return `Boekingslink "${updated.title}" bijgewerkt`;
  },

  'booking_link.regenerate_token': async (payload, ctx) => {
    const linkId = text(payload, 'link_id') as UUID;
    const result = await regenerateBookingToken(ctx.organizationId, linkId);
    return `Nieuwe boekings-URL voor "${result.link.title}": ${result.booking_url} — de oude link werkt niet meer`;
  },

  'booking_link.send_mail': async (payload, ctx) => {
    const linkId = text(payload, 'link_id') as UUID;
    const email = text(payload, 'email');
    const name = optText(payload, 'name') ?? undefined;
    // De publieke URL is nergens leesbaar bewaard (alleen een hash), dus we maken er
    // eerst een verse — precies zoals het scherm doet als het token kwijt is. Dat
    // staat ook zo op de goedkeurkaart.
    const fresh = await regenerateBookingToken(ctx.organizationId, linkId);
    await sendBookingLinkMail(ctx.organizationId, linkId, fresh.token, { email, name });
    return `Boekingslink "${fresh.link.title}" verstuurd naar ${email} — een eerder gedeelde link werkt niet meer`;
  },

  'booking_slot.add': async (payload, ctx) => {
    const linkId = text(payload, 'link_id') as UUID;
    const raw = Array.isArray(payload.slots) ? payload.slots as unknown[] : [];
    if (raw.length === 0) throw new Error('Deze actie mist de tijdblokken.');
    const slots = raw.map((s) => {
      const record = s as Record<string, unknown>;
      return { startsAt: String(record.startsAt), endsAt: String(record.endsAt) };
    });
    const result = await addBookingSlots(ctx.organizationId, linkId, slots);
    const title = optText(payload, 'link_title') ?? 'de boekingslink';
    const count = result.slots.length;
    if (result.warnings.length) {
      return `${count} tijdblok${count === 1 ? '' : 'ken'} toegevoegd aan "${title}" — let op: ${result.warnings.length} overlapt met een bestaande afspraak`;
    }
    return `${count} tijdblok${count === 1 ? '' : 'ken'} toegevoegd aan "${title}"`;
  },

  'booking_slot.remove': async (payload, ctx) => {
    const linkId = text(payload, 'link_id') as UUID;
    const slotId = text(payload, 'slot_id') as UUID;
    await removeBookingSlot(ctx.organizationId, linkId, slotId);
    return `Tijdblok weggehaald bij "${optText(payload, 'link_title') ?? 'de boekingslink'}"`;
  },

  'booking.cancel': async (payload, ctx) => {
    const bookingId = text(payload, 'booking_id') as UUID;
    await cancelBooking(ctx.organizationId, bookingId);
    invalidateCalendarEventsCache(ctx.organizationId);
    return `Boeking van ${optText(payload, 'who') ?? 'de klant'} geannuleerd — het tijdblok staat weer open`;
  },

  // ── Opnames en notulen ────────────────────────────────────────────────────
  'meeting_recording.regenerate_summary': async (payload, ctx) => {
    const recordingId = text(payload, 'recording_id') as UUID;
    await summarizeRecording(ctx.organizationId, recordingId);
    return `Notulen van "${optText(payload, 'title') ?? 'de opname'}" opnieuw geschreven`;
  },

  'meeting_recording.update_transcript': async (payload, ctx) => {
    const recordingId = text(payload, 'recording_id') as UUID;
    await updateRecordingText(ctx.organizationId, recordingId, { transcriptText: text(payload, 'transcript_text') });
    return `Transcript van "${optText(payload, 'title') ?? 'de opname'}" bijgewerkt`;
  },

  'meeting_recording.send_summary': async (payload, ctx) => {
    const recordingId = text(payload, 'recording_id') as UUID;
    const recipients = list(payload, 'recipients').map((email) => ({ email, name: null }));
    // De notulentekst halen we hier op in plaats van hem door het voorstel te slepen:
    // die kan duizenden tekens lang zijn en staat al in de database.
    const recording = await getRecording(recordingId);
    if (!recording || recording.organization_id !== ctx.organizationId) {
      throw new Error('Deze opname bestaat niet (meer) in deze organisatie.');
    }
    const bodyText = optText(payload, 'body_text') ?? recording.summary_text;
    if (!bodyText) throw new Error('Deze opname heeft geen notulen om te versturen.');
    const result = await sendSummaryToAttendees(ctx.organizationId, {
      recordingId,
      recipients,
      subject: text(payload, 'subject'),
      bodyText,
      includeTranscript: flag(payload, 'include_transcript'),
    });
    if (result.failed?.length) {
      throw new Error(`${result.sent} verstuurd, ${result.failed.length} mislukt (${result.failed.map((f) => f.email).join(', ')}).`);
    }
    return `Notulen van "${optText(payload, 'title') ?? 'de opname'}" verstuurd naar ${recipients.length} ontvanger${recipients.length === 1 ? '' : 's'}`;
  },

  // ── Urenregistratie ───────────────────────────────────────────────────────
  'time_entry.update_details': async (payload, ctx) => {
    const entryId = text(payload, 'time_entry_id') as UUID;
    await updateTimeEntry(ctx.organizationId, entryId, patchOf(payload));
    const label = optText(payload, 'description') ?? `de urenpost van ${optText(payload, 'entry_date') ?? 'die dag'}`;
    return `Urenpost "${label}" bijgewerkt`;
  },
};
