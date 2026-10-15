// ============================================================
// Videocall-links op agenda-items (Google Meet / Teams / Zoom / Jitsi / overig)
//
// Externe agenda's (Google/Microsoft) hebben geen eigen veld voor een geplakte
// (bv. Zoom- of Jitsi-)link. Die zetten we als herkenbare regel in de
// omschrijving, zodat hij ook in Google Calendar / Outlook zichtbaar blijft, en
// lezen hem er bij het ophalen weer uit. Automatisch gegenereerde Meet/Teams-
// links komen uit het native conferentie-veld van de provider en gaan hier langs.
//
// Waar de regel staat:
//   Google    — onderaan. Google geeft bij het ophalen de hele omschrijving.
//   Microsoft — bovenaan. Graph geeft in de lijst alleen `bodyPreview`, de eerste
//               255 tekens; onderaan viel de link bij een langere omschrijving
//               weg (of half: een afgekapte link). Oudere items met de regel
//               onderaan worden nog steeds gelezen.
//
// Pure functies (geen Deno, geen database): calendarCore.ts exporteert ze door,
// meetingLinks.test.ts legt ze vast.
// ============================================================

/** Alleen http(s)-links toestaan; onzin of te lange waarden vervallen naar null. */
export function sanitizeMeetingUrl(value: unknown): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? raw : null;
  } catch { return null; }
}

const MEETING_LINE_END_RE = /\n*[ \t]*(?:🎥[ \t]*)?Videocall:[ \t]*(https?:\/\/\S+)[ \t]*$/i;
const MEETING_LINE_START_RE = /^[ \t]*(?:🎥[ \t]*)?Videocall:[ \t]*(https?:\/\/\S+)[ \t]*(?:\r?\n[ \t]*)*/i;
const MEETING_HOST_RE = /https?:\/\/[^\s]*(?:meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|zoom\.com|meet\.jit\.si|8x8\.vc)[^\s]*/i;

export type MeetingLinePosition = 'start' | 'end';

/** Zet de link als aparte regel in de omschrijving (onderaan, of bovenaan voor Microsoft). */
export function withMeetingLine(description: string | null, url: string | null, position: MeetingLinePosition = 'end'): string | null {
  const base = stripMeetingLine(description);
  if (!url) return base;
  const line = `🎥 Videocall: ${url}`;
  if (position === 'start') return base ? `${line}\n\n${base}` : line;
  return base ? `${base}\n\n${line}` : line;
}

/** Verwijdert een eerder toegevoegde "Videocall:"-regel, onderaan of bovenaan. */
export function stripMeetingLine(description: string | null): string | null {
  if (!description) return null;
  const cleaned = description.replace(MEETING_LINE_END_RE, '').replace(MEETING_LINE_START_RE, '').replace(/\s+$/, '');
  return cleaned || null;
}

/** De link uit de "Videocall:"-regel die ResoFly zelf schreef, als die er staat. */
function markedMeetingUrl(description: string | null): string | null {
  if (!description) return null;
  return description.match(MEETING_LINE_END_RE)?.[1] ?? description.match(MEETING_LINE_START_RE)?.[1] ?? null;
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Leidt de videocall-link af.
 *
 * Staat er een eigen regel én een native conferentie (Meet/Teams), dan wint de
 * regel als hij naar een ándere dienst wijst: wie een afspraak met Google Meet
 * of Teams in ResoFly omzet naar Jitsi, wil de Jitsi-knop zien, en Meet/Teams is
 * via de API niet altijd van een afspraak af te halen (Teams nooit). Wijst de
 * regel naar dezelfde dienst, dan is het de conferentie zelf (meegeschreven bij
 * het bewerken in ResoFly, bij Teams soms afgekapt in de preview) en geldt de
 * conferentie. Daarna een losse bekende link in omschrijving of locatie.
 */
export function readMeetingUrl(nativeConference: string | null, description: string | null, location: string | null): string | null {
  const marked = markedMeetingUrl(description);
  if (marked && (!nativeConference || hostOf(marked) !== hostOf(nativeConference))) return marked;
  if (nativeConference) return nativeConference;
  return (description ?? '').match(MEETING_HOST_RE)?.[0] ?? (location ?? '').match(MEETING_HOST_RE)?.[0] ?? null;
}

/** Videocall-link uit de eerste video-entrypoint van Google conferenceData. */
export function googleConferenceUrl(item: Record<string, unknown>): string | null {
  if (item.hangoutLink) return String(item.hangoutLink);
  const conf = (item.conferenceData ?? {}) as Record<string, unknown>;
  const entries = (conf.entryPoints ?? []) as Record<string, string>[];
  const video = entries.find(e => e.entryPointType === 'video') ?? entries[0];
  return video?.uri ? String(video.uri) : null;
}
