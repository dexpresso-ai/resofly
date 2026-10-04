// ============================================================
// Klantportaal — welke mailberichten ziet een klant in "Berichten"?
//
// Pure regels (zonder database, zonder Deno-API's) zodat `npm test` ze
// controleert. client-portal haalt de berichten van één klant op via
// portal_client_message_overview (die al grof filtert) en laat ze hier door
// de zeef gaan, voor één persoon.
//
// Een klantdossier bevat meer dan het gesprek tussen leverancier en klant:
// nieuwsbrieven en automatische stromen (marketing), post die het team uit de
// opvangbak aan het dossier koppelde (soms van een derde), en mail die een
// teamlid naar het doorstuuradres doorstuurde — met een eigen notitie erboven.
// En op één portaal kunnen meer mensen van de klant inloggen (het hoofdadres
// en contactpersonen), die elkaars mail niet horen te lezen.
//
// Eén portaalgebruiker ziet daarom alleen het eigen gesprek:
//  - wat die persoon zelf stuurde (inkomend, van het eigen adres);
//  - wat het team die persoon stuurde (uitgaand, echt verzonden);
//  - en wat het team daarna antwoordde in een gesprek waar die persoon aan
//    meedeed (vanaf het eerste eigen bericht). Het team mailt altijd naar het
//    hoofdadres van de klant; zo ziet een contactpersoon die iets vroeg toch
//    het antwoord.
// Nooit: post van een collega of een derde, doorgestuurde mail, mail die niet
// verstuurd is, en geen gesprek waar een campagne of stroom in zit.
// ============================================================

export interface PortalMessageRow {
  id: string;
  thread_id: string;
  /** Het onderwerp van dít bericht (niet dat van het gesprek). */
  subject: string | null;
  direction: string;
  status: string | null;
  from_email: string | null;
  from_name: string | null;
  to_email: string | null;
  /** metadata.source: 'campaign' en 'flow' zijn marketing. */
  source: string | null;
  /**
   * metadata.sender_source van een inkomend bericht: hoe de afzender gevonden
   * is. 'header_from' (of niets: portaal, oudere mail) is de afzender zelf;
   * de rest betekent doorgestuurd.
   */
  sender_source?: string | null;
  preview: string | null;
  occurred_at: string;
  created_at: string;
}

export interface PortalThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
  lastMessageAt: string;
  /** Laatste bericht: van het team of van deze persoon. */
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
/**
 * Inkomend en écht van de afzender. Bij 'rfc822_attachment' en
 * 'forward_block' stuurde een teamlid de mail door: de tekst is dan (ook) de
 * eigen notitie van dat teamlid. 'reply_to' en 'envelope' zijn gokken.
 */
const OWN_SENDER_SOURCES = new Set(['', 'header_from']);

export function normalizeAddress(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

/**
 * Kan dit bericht in een portaal staan, los van wie er kijkt? `people` =
 * genormaliseerde adressen van de portaalgebruikers van de klant.
 */
export function isPortalEligibleMessage(row: PortalMessageRow, people: ReadonlySet<string>): boolean {
  if (MARKETING_SOURCES.has(String(row.source ?? ''))) return false;
  if (row.direction === 'outbound') {
    if (UNSENT_STATUSES.has(String(row.status ?? ''))) return false;
    const to = normalizeAddress(row.to_email);
    return Boolean(to && people.has(to));
  }
  if (row.direction === 'inbound') {
    if (!OWN_SENDER_SOURCES.has(String(row.sender_source ?? ''))) return false;
    const from = normalizeAddress(row.from_email);
    return Boolean(from && people.has(from));
  }
  return false;
}

/**
 * De gesprekken die één portaalgebruiker (`me`) ziet, nieuwste activiteit
 * bovenaan. Het onderwerp komt van het eerste zichtbare bericht: het
 * gesprek zelf kan begonnen zijn met post die de klant niet ziet.
 */
export function portalThreadsFor(
  rows: ReadonlyArray<PortalMessageRow>,
  me: string,
  people: ReadonlySet<string>,
): PortalThreadSummary[] {
  const self = normalizeAddress(me);
  if (!self || !people.has(self)) return [];

  const marketingThreads = new Set(
    rows.filter((row) => MARKETING_SOURCES.has(String(row.source ?? ''))).map((row) => row.thread_id),
  );
  const eligible = rows
    .filter((row) => !marketingThreads.has(row.thread_id) && isPortalEligibleMessage(row, people))
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id));

  const fromMe = (row: PortalMessageRow) => row.direction === 'inbound' && normalizeAddress(row.from_email) === self;
  const toMe = (row: PortalMessageRow) => row.direction === 'outbound' && normalizeAddress(row.to_email) === self;

  // Vanaf wanneer deed deze persoon mee aan een gesprek?
  const joinedAt = new Map<string, number>();
  for (const row of eligible) {
    if ((fromMe(row) || toMe(row)) && !joinedAt.has(row.thread_id)) {
      joinedAt.set(row.thread_id, Date.parse(row.occurred_at));
    }
  }
  const visible = eligible.filter((row) => {
    if (row.direction === 'inbound') return fromMe(row);
    if (toMe(row)) return true;
    const joined = joinedAt.get(row.thread_id);
    return joined !== undefined && Date.parse(row.occurred_at) >= joined;
  });

  const byThread = new Map<string, PortalThreadSummary>();
  for (const row of visible) {
    const summary = byThread.get(row.thread_id) ?? {
      id: row.thread_id,
      subject: String(row.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(geen onderwerp)',
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
