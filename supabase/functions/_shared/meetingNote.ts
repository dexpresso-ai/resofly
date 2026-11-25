/**
 * Een meeting uit de agenda in Inhoud (sinds 24 november): de map, de titel
 * en de tekst van de notitie, en wanneer dat vanzelf mag.
 *
 * Zodra het transcript van een meeting binnen is, zet de server hem in Inhoud
 * (meetingInhoud.ts): bij de klant een map Meetings met daarin een notitie
 * "<titel> — <datum>". De notitie bevat de notulen; het volledige transcript
 * blijft op de opname staan en de notitie toont het via de wissel
 * Notulen/Transcript (src/components/MeetingNoteViews.tsx).
 *
 * Puur, zonder Deno-imports, zodat `npm test` er rechtstreeks overheen draait
 * (meetingNote.test.ts).
 */

import { isWriterRole, memberModuleLevel } from './roles.ts';

/** De map bij de klant (of onder Geen klant) waarin de meetings komen. */
export const MEETINGS_FOLDER_NAME = 'Meetings';

/**
 * De tekst van de notitie zolang er nog geen notulen zijn (AI-tegoed op, of de
 * notulen worden nog gemaakt). De pijplijn vervangt hem zodra de notulen er
 * zijn, maar alleen als de notitie nog precies dit bevat: wat iemand er zelf
 * in schreef, overschrijven we niet.
 */
export const NOTULEN_VOLGEN = '<p>De notulen zijn nog niet gemaakt. Het volledige transcript staat onder Transcript.</p>';

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

const TITLE_MAX = 200;

export interface MeetingSummaryLike {
  samenvatting?: string | null;
  besproken?: string[] | null;
  besluiten?: string[] | null;
  actiepunten?: string[] | null;
  vervolgafspraken?: string[] | null;
}

/** "2026-11-24" → "24 november 2026". Zonder Intl, zodat de edge runtime geen Nederlandse locale nodig heeft. */
export function dutchDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return `${date} ${MAANDEN[month - 1]} ${year}`;
}

/**
 * De dag van de meeting als JJJJ-MM-DD. De app stuurt de dag van de afspraak
 * mee; die gaat voor, want een meeting die je 's avonds pas laat uitschrijven,
 * hoort bij de dag van de afspraak. Klopt die niet, dan de dag waarop de
 * opname begon, op Nederlandse tijd: om half één 's nachts UTC is het in
 * Nederland al de volgende dag.
 */
export function meetingDay(requested: unknown, recordedAt: string): string {
  return validDay(requested) ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(recordedAt));
}

/** "2026-11-24" als dat een echte dag is, anders null (ook "2026-02-30"). */
export function validDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? value : null;
}

/** Een tijdstip uit de aanvraag als ISO-tekst, of null als het er geen is. */
export function validTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * "Kennismaking Bakkerij Jansen — 24 november 2026". De titel van de afspraak
 * eerst, zodat je de meeting in de map op naam vindt. Is de titel te lang,
 * dan kort de titel in en blijft de datum staan.
 */
export function meetingNoteTitle(eventTitle: string | null | undefined, day: string): string {
  const title = (eventTitle ?? '').replace(/\s+/g, ' ').trim() || 'Meeting';
  const suffix = ` — ${dutchDate(day)}`;
  const room = TITLE_MAX - suffix.length;
  return (title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title) + suffix;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * De notulen als tekst voor de notitie: de samenvatting en per onderdeel een
 * lijst. Geen kopje met de titel, die staat al boven de notitie. Alleen tags
 * die de editor kent (p, h4, ul, li, br); alles uit de opname gaat door esc(),
 * want het is gegevens, geen opmaak. Zonder notulen: NOTULEN_VOLGEN.
 */
export function meetingNoteContent(summary: MeetingSummaryLike | null | undefined, fallbackText?: string | null): string {
  if (!summary) {
    const plain = (fallbackText ?? '').trim();
    if (!plain) return NOTULEN_VOLGEN;
    return plain.split(/\n{2,}/).map(par => `<p>${par.split('\n').map(esc).join('<br>')}</p>`).join('');
  }
  const parts: string[] = [];
  if (summary.samenvatting?.trim()) parts.push(`<p>${esc(summary.samenvatting.trim())}</p>`);
  const block = (title: string, items: string[] | null | undefined) => {
    const clean = (items ?? []).map(item => String(item ?? '').trim()).filter(Boolean);
    if (clean.length) parts.push(`<h4>${title}</h4><ul>${clean.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`);
  };
  block('Besproken', summary.besproken);
  block('Besluiten', summary.besluiten);
  block('Actiepunten', summary.actiepunten);
  block('Vervolgafspraken', summary.vervolgafspraken);
  return parts.length ? parts.join('') : NOTULEN_VOLGEN;
}

/** Waarom een meeting níet vanzelf in Inhoud komt. */
export type AutoSaveRefusal = 'not_requested' | 'no_creator' | 'no_rights' | 'private_calendar';

/**
 * Mag de server deze meeting vanzelf in Inhoud zetten? null = ja.
 *
 * De server doet het op naam van wie de opname maakte, met de service-role:
 * die slaat RLS en de modulepoort over (CLAUDE.md, harde regels 1 en 3). Dus
 * hier dezelfde poort als bij de knop: die persoon is nog actief lid, mag
 * schrijven, en mag Agenda én Inhoud wijzigen. Op het moment van uitschrijven,
 * niet bij het opnemen: wie intussen zijn recht op Inhoud kwijt is, zet er
 * ook niets meer in.
 *
 * En alleen uit een gedeelde agenda. De app vraagt het alleen aan bij een
 * gedeelde afspraak (save_to_content), maar de server kijkt zelf ook naar de
 * agenda: de notulen van een privé-afspraak horen niet ongemerkt in de
 * gedeelde Inhoud.
 */
export function autoSaveRefusal(input: {
  saveToContent: boolean;
  callId: string | null;
  noteId: string | null;
  createdBy: string | null;
  /** Het lidmaatschap van de maker (actief), of null als hij geen lid meer is. */
  member: { role?: string | null; module_access?: Record<string, unknown> | null } | null;
  /** De zichtbaarheid van de agenda van de afspraak, of null als die onbekend is. */
  sourceVisibility: string | null;
}): AutoSaveRefusal | null {
  if (!input.saveToContent || input.callId || input.noteId) return 'not_requested';
  const role = input.member?.role ?? null;
  if (!input.createdBy || !role) return 'no_creator';
  if (!isWriterRole(role)) return 'no_rights';
  if (memberModuleLevel(role, input.member?.module_access, 'calendar') !== 'write') return 'no_rights';
  if (memberModuleLevel(role, input.member?.module_access, 'content') !== 'write') return 'no_rights';
  if (input.sourceVisibility !== 'organization') return 'private_calendar';
  return null;
}
