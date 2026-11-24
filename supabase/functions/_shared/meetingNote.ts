/**
 * Een meeting uit de agenda in Inhoud (sinds 24 november): de map, de titel
 * en de tekst van de notitie.
 *
 * Na het transcriberen vraagt de opnamekaart of de meeting ook in Inhoud
 * moet. Zo ja, dan maakt meeting-transcribe (actie saveToContent) bij de klant
 * een map Meetings met daarin een notitie "<titel> — <datum>". De notitie
 * bevat de notulen; het volledige transcript blijft op de opname staan en de
 * notitie toont het via de wissel Notulen/Transcript
 * (src/components/MeetingNoteViews.tsx).
 *
 * Los van meeting-transcribe/index.ts zodat de test hem kan laden: index.ts
 * start bij het laden een server en een Supabase-client.
 */

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
  if (typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    const [year, month, day] = requested.split('-').map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) return requested;
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(recordedAt));
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
