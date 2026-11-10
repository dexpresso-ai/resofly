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
//  - en een antwoord van het team aan het hoofdadres van de klant als dat op
//    déze persoon antwoordt: het laatste inkomende bericht ervóór in het
//    gesprek is van hem. Antwoorden gaan standaard naar het hoofdadres; zo
//    ziet een contactpersoon die iets vroeg toch het antwoord.
// Nooit: post van een collega of een derde, doorgestuurde mail, mail die niet
// verstuurd is, en geen gesprek waar een campagne of stroom in zit.
//
// Tot 10 november zag een contactpersoon élke mail van het team in een gesprek
// waar hij ooit aan meedeed. Maar inkomende mail komt vaak in het laatst
// actieve gesprek van de klant terecht, en het team mailt sinds oktober ook
// contactpersonen rechtstreeks. Zo las een collega het antwoord van het team op
// een vertrouwelijke mail van het hoofdadres mee, met het citaat eronder.
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
 * bovenaan. `primary` is het hoofdadres van de klant (clients.email). Het
 * onderwerp komt van het eerste zichtbare bericht: het gesprek zelf kan
 * begonnen zijn met post die de klant niet ziet.
 */
export function portalThreadsFor(
  rows: ReadonlyArray<PortalMessageRow>,
  me: string,
  people: ReadonlySet<string>,
  primary: string | null,
): PortalThreadSummary[] {
  const self = normalizeAddress(me);
  if (!self || !people.has(self)) return [];
  const primaryAddress = normalizeAddress(primary);

  const marketingThreads = new Set(
    rows.filter((row) => MARKETING_SOURCES.has(String(row.source ?? ''))).map((row) => row.thread_id),
  );
  const eligible = rows
    .filter((row) => !marketingThreads.has(row.thread_id) && isPortalEligibleMessage(row, people))
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id));

  const fromMe = (row: PortalMessageRow) => row.direction === 'inbound' && normalizeAddress(row.from_email) === self;
  const toMe = (row: PortalMessageRow) => row.direction === 'outbound' && normalizeAddress(row.to_email) === self;

  // Per gesprek de inkomende berichten op volgorde: álle, ook wat zelf niet in
  // het portaal komt (doorgestuurd, van een collega). Zo telt "het laatste
  // bericht vóór dit antwoord" ook als het niet van deze persoon was.
  const inboundByThread = new Map<string, Array<{ at: number; from: string | null }>>();
  for (const row of rows) {
    if (row.direction !== 'inbound') continue;
    const list = inboundByThread.get(row.thread_id) ?? [];
    list.push({ at: Date.parse(row.occurred_at), from: normalizeAddress(row.from_email) });
    inboundByThread.set(row.thread_id, list);
  }
  for (const list of inboundByThread.values()) list.sort((a, b) => a.at - b.at);

  /** Antwoordt deze mail van het team op mij: was het laatste inkomende bericht ervóór van mij? */
  const answersMe = (row: PortalMessageRow) => {
    const at = Date.parse(row.occurred_at);
    let last: { at: number; from: string | null } | null = null;
    for (const item of inboundByThread.get(row.thread_id) ?? []) {
      if (item.at > at) break;
      last = item;
    }
    return last !== null && last.from === self;
  };

  const visible = eligible.filter((row) => {
    if (row.direction === 'inbound') return fromMe(row);
    if (toMe(row)) return true;
    // Aan een ander: alleen een antwoord aan het hoofdadres op mijn eigen
    // bericht. Mail van het team aan een collega zie je nooit.
    return primaryAddress !== null && normalizeAddress(row.to_email) === primaryAddress && answersMe(row);
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
