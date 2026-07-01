// Herkent het type videovergadering aan de hand van de link, zodat de UI het
// juiste label (en straks icoon) kan tonen. Puur cosmetisch — de link zelf is
// leidend; we bewaren geen aparte "provider"-kolom.

export type MeetingKind = 'google_meet' | 'teams' | 'zoom' | 'other';

const HOSTS: { kind: MeetingKind; label: string; match: RegExp }[] = [
  { kind: 'google_meet', label: 'Google Meet', match: /(^|\.)meet\.google\.com$/i },
  { kind: 'teams', label: 'Microsoft Teams', match: /(^|\.)teams\.(microsoft|live)\.com$/i },
  { kind: 'zoom', label: 'Zoom', match: /(^|\.)(zoom\.us|zoom\.com|.*\.zoom\.us)$/i },
];

export function detectMeetingKind(url: string | null | undefined): { kind: MeetingKind; label: string } {
  if (!url) return { kind: 'other', label: 'Videocall' };
  let host = '';
  try { host = new URL(url).hostname; } catch { return { kind: 'other', label: 'Videocall' }; }
  for (const h of HOSTS) if (h.match.test(host)) return { kind: h.kind, label: h.label };
  return { kind: 'other', label: 'Videocall' };
}

/** Basisvalidatie voor een geplakte link: alleen http(s) toestaan. */
export function isValidMeetingUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try { const u = new URL(trimmed); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}
