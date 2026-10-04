// ============================================================
// Klantportaal — welke mailberichten ziet een klant in "Berichten"?
//
// Pure regels (zonder database, zonder Deno-API's) zodat `npm test` ze
// controleert. client-portal haalt de berichten van één klant op via
// portal_client_message_overview en laat ze hier door de zeef gaan.
//
// Een klantdossier bevat meer dan het gesprek tussen leverancier en klant:
// nieuwsbrieven en automatische stromen (marketing), en post die het team uit
// de opvangbak aan het dossier koppelde — soms van een derde over deze klant.
// De klant ziet daarom alleen:
//  - wat het team aan één van de portaalgebruikers van de klant stuurde (uitgaand, echt
//    verzonden), en
//  - wat één van die portaalgebruikers zelf stuurde (inkomend);
// en nooit een gesprek waar een campagne of stroom in zit.
// ============================================================

export interface PortalMessageRow {
  id: string;
  thread_id: string;
  thread_subject: string | null;
  direction: string;
  status: string | null;
  from_email: string | null;
  from_name: string | null;
  to_email: string | null;
  /** metadata.source: 'campaign' en 'flow' zijn marketing. */
  source: string | null;
  preview: string | null;
  occurred_at: string;
  created_at: string;
}

export interface PortalThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
  lastMessageAt: string;
  /** Laatste bericht: van het team of van de klantkant. */
  lastDirection: 'outbound' | 'inbound';
  lastFromEmail: string | null;
  lastFromName: string | null;
  lastPreview: string;
  /** Laatste bericht van het team (voor de stip "nieuw"). */
  lastTeamMessageAt: string | null;
  /** De zichtbare berichten, oudste eerst. */
  messageIds: string[];
}

const MARKETING_SOURCES = new Set(['campaign', 'flow']);
/** Een uitgaande mail die (nog) niet verstuurd is, heeft de klant nooit gezien. */
const UNSENT_STATUSES = new Set(['queued', 'failed']);

export function normalizeAddress(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

/** Ziet de klant dit bericht? `people` = genormaliseerde adressen van de portaalgebruikers van de klant. */
export function isPortalVisibleMessage(row: PortalMessageRow, people: ReadonlySet<string>): boolean {
  if (MARKETING_SOURCES.has(String(row.source ?? ''))) return false;
  if (row.direction === 'outbound') {
    if (UNSENT_STATUSES.has(String(row.status ?? ''))) return false;
    const to = normalizeAddress(row.to_email);
    return Boolean(to && people.has(to));
  }
  if (row.direction === 'inbound') {
    const from = normalizeAddress(row.from_email);
    return Boolean(from && people.has(from));
  }
  return false;
}

/** De gesprekken die de klant ziet, nieuwste activiteit bovenaan. */
export function portalThreads(rows: ReadonlyArray<PortalMessageRow>, people: ReadonlySet<string>): PortalThreadSummary[] {
  const marketingThreads = new Set(
    rows.filter((row) => MARKETING_SOURCES.has(String(row.source ?? ''))).map((row) => row.thread_id),
  );
  const visible = rows
    .filter((row) => !marketingThreads.has(row.thread_id) && isPortalVisibleMessage(row, people))
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

  const byThread = new Map<string, PortalThreadSummary>();
  for (const row of visible) {
    const summary = byThread.get(row.thread_id) ?? {
      id: row.thread_id,
      subject: String(row.thread_subject ?? '').trim() || '(geen onderwerp)',
      messageCount: 0,
      lastMessageAt: row.occurred_at,
      lastDirection: 'outbound' as const,
      lastFromEmail: null,
      lastFromName: null,
      lastPreview: '',
      lastTeamMessageAt: null,
      messageIds: [],
    };
    summary.messageCount += 1;
    summary.messageIds.push(row.id);
    summary.lastMessageAt = row.occurred_at;
    summary.lastDirection = row.direction === 'inbound' ? 'inbound' : 'outbound';
    summary.lastFromEmail = normalizeAddress(row.from_email);
    summary.lastFromName = String(row.from_name ?? '').trim().slice(0, 80) || null;
    summary.lastPreview = previewText(row.preview);
    if (row.direction === 'outbound') summary.lastTeamMessageAt = row.occurred_at;
    byThread.set(row.thread_id, summary);
  }
  return [...byThread.values()].sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

/** Eén regel, hooguit `max` tekens, zonder dubbele witruimte. */
export function previewText(value: unknown, max = 160): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "Re: " voor het onderwerp, één keer — geen "Re: Re: Re:". */
export function replySubject(subject: unknown): string {
  const base = String(subject ?? '').trim().replace(/^(?:(?:re|antw|aw|fw|fwd)\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re: (geen onderwerp)';
}

/**
 * Is er iets nieuws sinds deze persoon het voor het laatst opende? Zonder
 * leesmoment telt alleen wat er na `since` gebeurde: van vóór de invoering
 * van deze stip weten we niet of iemand het al gezien heeft.
 */
export function isUnreadSince(lastActivityAt: string | null | undefined, readAt: string | null | undefined, since: string): boolean {
  if (!lastActivityAt) return false;
  const activity = Date.parse(lastActivityAt);
  if (!Number.isFinite(activity)) return false;
  const seen = readAt ? Date.parse(readAt) : Number.NaN;
  const threshold = Number.isFinite(seen) ? seen : Date.parse(since);
  return activity > threshold;
}

/** HTML van een mail terug naar leesbare tekst (voor klantberichten zonder tekstversie). */
export function htmlToPlainText(html: unknown): string {
  return String(html ?? '')
    .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
