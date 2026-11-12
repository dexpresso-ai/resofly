/**
 * Gerrie → Gesprekken: wat de lijst en het teruglezen nodig hebben, zonder
 * database. De aanroepen staan in gerrieConversations-api.ts; hier staat wat
 * er met de rijen gebeurt. Zo is het te testen zonder Supabase
 * (gerrieConversations.test.ts).
 */
import type { UUID } from '../types';

/** Eén gesprek in de lijst. */
export interface ConversationSummary {
  id: UUID;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Alleen bij zoeken: het stukje bericht waarin je zoekwoord staat. */
  snippet?: string | null;
}

/**
 * Wat er met een voorstel uit het gesprek is gebeurd. 'open' is nooit beslist.
 * 'approved' is goedgekeurd zonder dat de uitkomst ooit terugkwam (tabblad
 * dicht tijdens het uitvoeren).
 */
export type PastProposalStatus = 'open' | 'approved' | 'done' | 'rejected' | 'failed';

/** Een voorstel van Gerrie, zoals het nu in het gesprek terug te lezen is. */
export interface PastProposal {
  auditId: string;
  title: string;
  sub: string;
  status: PastProposalStatus;
}

/** Eén bericht om terug te lezen. */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  proposals: PastProposal[];
}

/** Rij uit ai_messages zoals de app hem leest. */
export interface MessageRow { id: string; role: string; content: string | null; created_at: string }
/** Rij uit ai_action_audit zoals de app hem leest. */
export interface AuditRow { id: string; message_id: string | null; status: string | null; title: string; sub: string; created_at: string }

/**
 * De titel is het begin van de eerste vraag, afgekapt op 60 tekens
 * (createConversation in gerrieCore). Precies 60 tekens betekent dus bijna
 * altijd: er liep nog meer achteraan.
 */
export const TITLE_LIMIT = 60;
export function conversationTitle(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Gesprek zonder titel';
  return (raw ?? '').length >= TITLE_LIMIT ? `${text.replace(/[\s.,;:!?…-]+$/, '')}…` : text;
}

/** Voorstelstatus uit ai_action_audit naar wat de gebruiker leest. */
export function pastProposalStatus(status: string | null | undefined): PastProposalStatus {
  switch (status) {
    case 'executed':
    case 'auto_executed':
      return 'done';
    case 'confirmed':
      return 'approved';
    case 'cancelled':
      return 'rejected';
    case 'failed':
      return 'failed';
    default:
      return 'open';
  }
}

export const PROPOSAL_STATUS_LABEL: Record<PastProposalStatus, string> = {
  open: 'Niet beslist',
  approved: 'Goedgekeurd',
  done: 'Uitgevoerd',
  rejected: 'Afgewezen',
  failed: 'Mislukt',
};

/**
 * De berichten met hun voorstellen erbij. Een assistentbericht zonder tekst
 * maar met een voorstel blijft staan; een bericht zonder beide valt weg (een
 * lege beurt is niets om terug te lezen).
 */
export function buildThread(messages: MessageRow[], audits: AuditRow[]): ConversationMessage[] {
  const byMessage = new Map<string, PastProposal[]>();
  for (const a of [...audits].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    if (!a.message_id) continue;
    const list = byMessage.get(a.message_id) ?? [];
    list.push({ auditId: a.id, title: a.title, sub: a.sub, status: pastProposalStatus(a.status) });
    byMessage.set(a.message_id, list);
  }
  return messages
    .map((m) => ({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
      text: String(m.content ?? '').trim(),
      createdAt: m.created_at,
      proposals: byMessage.get(m.id) ?? [],
    }))
    .filter((m) => m.text.length > 0 || m.proposals.length > 0);
}

// ── Datums ──────────────────────────────────────────────────────────────────

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const WEEKDAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

function startOfDay(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
/** Hele kalenderdagen tussen twee momenten, in de tijdzone van de browser. */
function daysBetween(earlier: Date, later: Date): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86_400_000);
}
function hhmm(d: Date): string { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/** Kort tijdstip naast een gesprek in de lijst: "14:05", "gisteren", "ma", "3 nov", "3 nov 2025". */
export function listTimeLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysBetween(d, now);
  if (days <= 0) return hhmm(d);
  if (days === 1) return 'gisteren';
  if (days < 7) return WEEKDAYS[d.getDay()].slice(0, 2);
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** Scheidingsregel tussen dagen in een gesprek: "Vandaag", "Gisteren", "Maandag 9 november". */
export function dayHeading(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysBetween(d, now);
  if (days <= 0) return 'Vandaag';
  if (days === 1) return 'Gisteren';
  const weekday = WEEKDAYS[d.getDay()];
  const label = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/** Tijdstip onder een bericht. */
export function messageTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : hhmm(d);
}

/** "Gestart op 12 november om 10:31" boven een geopend gesprek. */
export function startedLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysBetween(d, now);
  if (days <= 0) return `Gestart vandaag om ${hhmm(d)}`;
  if (days === 1) return `Gestart gisteren om ${hhmm(d)}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `Gestart op ${d.getDate()} ${MONTHS[d.getMonth()]}${year} om ${hhmm(d)}`;
}

export interface ConversationGroup { key: string; label: string; items: ConversationSummary[] }

/**
 * De lijst in blokken op laatste activiteit: Vandaag, Gisteren, Deze week,
 * Deze maand, daarna per maand ("oktober", "december 2025"). Zo vind je
 * "dat gesprek van vorige week" zonder te zoeken.
 */
export function groupConversations(items: ConversationSummary[], now: Date = new Date()): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  const at = new Map<string, ConversationGroup>();
  for (const item of items) {
    const d = new Date(item.updatedAt);
    let key: string;
    let label: string;
    const days = Number.isNaN(d.getTime()) ? Infinity : daysBetween(d, now);
    if (days <= 0) { key = 'today'; label = 'Vandaag'; }
    else if (days === 1) { key = 'yesterday'; label = 'Gisteren'; }
    else if (days < 7) { key = 'week'; label = 'Afgelopen 7 dagen'; }
    else if (days < 30) { key = 'month'; label = 'Afgelopen 30 dagen'; }
    else if (Number.isFinite(days)) {
      key = `${d.getFullYear()}-${d.getMonth()}`;
      const month = MONTHS[d.getMonth()];
      label = d.getFullYear() === now.getFullYear()
        ? `${month.charAt(0).toUpperCase()}${month.slice(1)}`
        : `${month.charAt(0).toUpperCase()}${month.slice(1)} ${d.getFullYear()}`;
    } else { key = 'unknown'; label = 'Eerder'; }
    let group = at.get(key);
    if (!group) { group = { key, label, items: [] }; at.set(key, group); groups.push(group); }
    group.items.push(item);
  }
  return groups;
}

// ── Zoeken ──────────────────────────────────────────────────────────────────

/** Zoeken begint pas vanaf twee tekens: op één letter is elk gesprek een treffer. */
export const MIN_QUERY = 2;

export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Het zoekwoord als ILIKE-patroon. % en _ zijn in LIKE jokers en \ is het
 * escape-teken; die worden letterlijk. PostgREST leest bovendien * als %;
 * dat kan niet letterlijk, dus dat wordt een spatie. Zonder dit vond
 * "50%" ook "500 euro", en vond "_" alles.
 */
export function ilikePattern(query: string): string {
  const escaped = normalizeQuery(query).replace(/\*/g, ' ').replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/**
 * Het stuk tekst rond de eerste treffer, voor onder een zoekresultaat. Begint
 * en eindigt op een woordgrens als dat kan, met … waar er iets is weggelaten.
 */
export function snippetAround(text: string, query: string, radius = 70): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const q = normalizeQuery(query).toLowerCase();
  if (!q) return null;
  const at = flat.toLowerCase().indexOf(q);
  if (at < 0) return null;
  let start = Math.max(0, at - radius);
  let end = Math.min(flat.length, at + q.length + radius);
  if (start > 0) { const space = flat.indexOf(' ', start); if (space >= 0 && space < at) start = space + 1; }
  if (end < flat.length) { const space = flat.lastIndexOf(' ', end); if (space > at + q.length) end = space; }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Tekst in stukken, met `hit` waar het zoekwoord staat (hoofdletterongevoelig). */
export function splitOnQuery(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = normalizeQuery(query);
  if (q.length < MIN_QUERY) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

/**
 * Treffers in titels en in berichten samen, nieuwste gesprek eerst. Een
 * gesprek dat in beide zit, staat er één keer in, met het stukje uit het
 * bericht (dat zegt meer dan de titel die je al ziet).
 */
export function mergeSearchHits(
  byTitle: ConversationSummary[],
  byMessage: ConversationSummary[],
): ConversationSummary[] {
  const merged = new Map<string, ConversationSummary>();
  for (const c of byTitle) merged.set(c.id, c);
  for (const c of byMessage) {
    const known = merged.get(c.id);
    merged.set(c.id, known ? { ...known, snippet: c.snippet ?? known.snippet ?? null } : c);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Tussen de chat en de pagina ─────────────────────────────────────────────

/**
 * De chat (rechtsonder) en de pagina Gesprekken praten via één gebeurtenis:
 * - `open`: zet dit gesprek in de chat en praat verder;
 * - `new`: begin in de chat een nieuw gesprek;
 * - `updated`: de chat kreeg net een antwoord in dit gesprek (de lijst ververst);
 * - `deleted`: dit gesprek is weg (staat het in de chat, dan begint die opnieuw).
 */
export const GERRIE_CONVERSATION_EVENT = 'resofly:gerrie-conversation';
export type GerrieConversationSignal =
  | { type: 'open'; id: UUID }
  | { type: 'new' }
  | { type: 'updated'; id: UUID }
  | { type: 'deleted'; id: UUID };

export function signalGerrieConversation(signal: GerrieConversationSignal): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<GerrieConversationSignal>(GERRIE_CONVERSATION_EVENT, { detail: signal }));
}

export function onGerrieConversation(handler: (signal: GerrieConversationSignal) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<GerrieConversationSignal>).detail;
    if (detail && typeof detail === 'object' && 'type' in detail) handler(detail);
  };
  window.addEventListener(GERRIE_CONVERSATION_EVENT, listener);
  return () => window.removeEventListener(GERRIE_CONVERSATION_EVENT, listener);
}
