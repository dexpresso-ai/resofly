// Boekingslinks in de app: woorden, tijden en weken voor het beheer
// (MeetingBookingManager), de klantpagina in het CRM (ClientBookingLinks) en
// de publieke boekingspagina die de klant zelf ziet (PublicBookingPage).
//
// Waarom een eigen bestand: de drie schermen zeiden elk iets anders. Het beheer
// toonde de status van een boeking in het Engels ("confirmed"), de publieke
// pagina rekende de week uit in de tijdzone van de browser (een klant in
// Londen zag zondagavond 23.30 uur in de verkeerde week, terwijl de database
// de weeklimiet in Nederlandse tijd telt), en "verlopen" betekende in het
// scherm iets anders dan op de server. Puur, zonder React:
// bookingLinks.test.ts legt het vast.

import type { MeetingBookingLinkState, MeetingBookingSlotStatus, MeetingBookingStatus } from '../types';

export const BOOKING_TIME_ZONE = 'Europe/Amsterdam';

export type BookingTone = 'success' | 'info' | 'muted' | 'warning' | 'danger';

/** De stand van een link in één woord, met een kleur. */
export const LINK_STATE_LABELS: Record<MeetingBookingLinkState, { label: string; tone: BookingTone }> = {
  open: { label: 'Open', tone: 'success' },
  full: { label: 'Volgeboekt', tone: 'info' },
  closed: { label: 'Gesloten', tone: 'muted' },
  expired: { label: 'Verlopen', tone: 'warning' },
  unavailable: { label: 'Niet beschikbaar', tone: 'danger' },
};

export const BOOKING_STATUS_LABELS: Record<MeetingBookingStatus, string> = {
  pending: 'Wordt verwerkt',
  confirmed: 'Bevestigd',
  cancelled: 'Geannuleerd',
  failed: 'Mislukt',
};

export const SLOT_STATUS_LABELS: Record<MeetingBookingSlotStatus, { label: string; tone: BookingTone }> = {
  open: { label: 'Vrij', tone: 'success' },
  pending: { label: 'Wordt geboekt', tone: 'warning' },
  booked: { label: 'Geboekt', tone: 'info' },
  cancelled: { label: 'Vervallen', tone: 'muted' },
};

/**
 * Wat de stand betekent voor wie de link beheert, in één zin, met wat hij
 * eraan kan doen.
 */
export function linkStateExplanation(state: MeetingBookingLinkState, openSlots: number): string {
  switch (state) {
    case 'open':
      return openSlots === 0
        ? 'De link werkt, maar er staan geen vrije momenten op: de klant ziet een lege pagina. Voeg momenten toe.'
        : `De klant kan kiezen uit ${openSlots} ${openSlots === 1 ? 'vrij moment' : 'vrije momenten'}.`;
    case 'full': return 'Alle afspraken die via deze link kunnen, zijn gemaakt. Verhoog het maximum als de klant nog een moment mag kiezen.';
    case 'closed': return 'Gesloten: de klant kan niets meer boeken. Gemaakte afspraken blijven staan.';
    case 'expired': return 'Verlopen: de link in de mail van de klant werkt niet meer. Verleng hem, dan werkt dezelfde link weer.';
    case 'unavailable': return 'Wie deze link maakte, mag niet meer in de Agenda schrijven of is geen teamlid meer. Daarom boekt de link niets. Maak een nieuwe link.';
  }
}

/** De datum in Nederlandse tijd als JJJJ-MM-DD. */
export function amsterdamDateKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BOOKING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * De maandag van de week waarin `iso` valt, in Nederlandse tijd (JJJJ-MM-DD).
 * Dezelfde week als de weeklimiet in de database:
 * date_trunc('week', starts_at at time zone 'Europe/Amsterdam').
 */
export function amsterdamWeekKey(iso: string): string {
  const day = new Date(`${amsterdamDateKey(iso)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Momenten per dag (Nederlandse tijd), op volgorde. */
export function groupByDay<T extends { starts_at: string }>(slots: T[]): Array<{ day: string; slots: T[] }> {
  const groups = new Map<string, T[]>();
  for (const slot of [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const key = amsterdamDateKey(slot.starts_at);
    const list = groups.get(key);
    if (list) list.push(slot); else groups.set(key, [slot]);
  }
  return [...groups.entries()].map(([day, list]) => ({ day, slots: list }));
}

/** "30 min", "1 uur", "1 u 30 min". */
export function durationLabel(startsAt: string, endsAt: string): string {
  const minutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} u ${rest} min` : `${hours} uur`;
}

/** Eén duur als alle momenten even lang zijn, anders null. */
export function commonDuration(slots: Array<{ starts_at: string; ends_at: string }>): string | null {
  const labels = new Set(slots.map(s => durationLabel(s.starts_at, s.ends_at)).filter(Boolean));
  return labels.size === 1 ? [...labels][0] : null;
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('nl-NL', { timeZone: BOOKING_TIME_ZONE, ...options });

/** "maandag 16 november". */
export function fmtDayLong(iso: string): string { return fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)); }
/** "ma 16 nov". */
export function fmtDayShort(iso: string): string { return fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)); }
/** "10:00". */
export function fmtTime(iso: string): string { return fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
/** "16 nov 2026". */
export function fmtDate(iso: string): string { return fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
/** "ma 16 nov · 10:00–10:30". */
export function fmtMoment(startsAt: string, endsAt: string): string { return `${fmtDayShort(startsAt)} · ${fmtTime(startsAt)}–${fmtTime(endsAt)}`; }
/** Een dag-sleutel (JJJJ-MM-DD) als "maandag 16 november". */
export function fmtDayKey(day: string): string { return fmtDayLong(`${day}T12:00:00Z`); }

/** "Week van 16 – 22 nov" voor een maandag-sleutel. */
export function fmtWeekLabel(mondayKey: string): string {
  const start = new Date(`${mondayKey}T12:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const f = fmt({ day: 'numeric', month: 'short' });
  return `Week van ${f.format(start)} – ${f.format(end)}`;
}

/**
 * Hoe lang de link nog werkt. "Binnenkort" is binnen veertien dagen: dan is er
 * nog tijd om hem te verlengen voordat de klant tegen een dichte deur loopt.
 */
export function expiryLabel(expiresAt: string | null | undefined, now: number = Date.now()): { text: string; tone: 'ok' | 'soon' | 'expired' | 'none' } {
  if (!expiresAt) return { text: 'Nog geen link', tone: 'none' };
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return { text: 'Nog geen link', tone: 'none' };
  if (at <= now) return { text: `Verlopen op ${fmtDate(expiresAt)}`, tone: 'expired' };
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 14) return { text: days <= 1 ? `Verloopt binnen een dag (${fmtDate(expiresAt)})` : `Verloopt over ${days} dagen (${fmtDate(expiresAt)})`, tone: 'soon' };
  return { text: `Geldig tot ${fmtDate(expiresAt)}`, tone: 'ok' };
}

/** "Je kiest één moment" / "Je kiest maximaal 3 momenten, hooguit 1 per week". */
export function choiceRule(maxTotal: number, maxPerWeek: number, alreadyBooked = 0): string {
  const left = Math.max(0, maxTotal - alreadyBooked);
  const base = left <= 1 ? 'Je kiest één moment' : `Je kiest maximaal ${left} momenten`;
  return left > 1 && maxPerWeek < left ? `${base}, hooguit ${maxPerWeek} per week` : base;
}
