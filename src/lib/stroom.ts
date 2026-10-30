import type { Client, FinanceLine, Invoice, Project, Quote } from '../types';

/**
 * De rekenkern van Stroom (designvoorstel 2026-10-30): de stroom op Vandaag,
 * de stroomlijn van een klant en het ontleden van een opdracht in het eiland.
 *
 * Alles hier is puur: geen React, geen opslag, geen netwerk. Daardoor is het
 * te testen (stroom.test.ts) — en dat moet, want de stroom toont bedragen. Een
 * bedrag in de stroom is precies het bedrag dat Vandaag en Geld ook tonen:
 * dezelfde statussen, en het totaal komt uit dezelfde geldmodule (de aanroeper
 * geeft `amount` mee, in de app `total(lines).total` uit format.ts).
 */

// ── De vijf haltes ─────────────────────────────────────────────────────────
export type StationId = 'gesprek' | 'offerte' | 'werk' | 'factuur' | 'betaald';

export interface StationDef {
  id: StationId;
  label: string;
}

export const STATIONS: readonly StationDef[] = [
  { id: 'gesprek', label: 'Gesprek' },
  { id: 'offerte', label: 'Offerte' },
  { id: 'werk', label: 'Werk' },
  { id: 'factuur', label: 'Factuur' },
  { id: 'betaald', label: 'Betaald' },
];

/**
 * Een knoop: iets in de stroom dat aandacht vraagt.
 *   wait — een offerte ligt al een week bij de klant;
 *   late — een factuur is over de vervaldatum, een offerte verlopen;
 *   sent — er ging net een herinnering uit: opgevolgd, de knoop is los.
 */
export type Knot = 'wait' | 'late' | 'sent';

export interface StreamItem {
  /** Uniek in de stroom: 'quote:<id>' of 'invoice:<id>'. */
  id: string;
  kind: 'quote' | 'invoice';
  refId: string;
  station: StationId;
  clientId: string | null;
  clientName: string;
  /** De kleur van de klant; de kraal draagt hem. */
  color: string;
  /** "Offerte 2026-020" */
  title: string;
  /** "9 dagen bij de klant" */
  detail: string;
  /** Bruto, zoals Vandaag en Geld het tonen. */
  amount: number;
  knot: Knot | null;
  /** Datum waarop het hier binnenkwam; sorteert de kralen binnen een halte. */
  at: string;
}

export interface StreamStation extends StationDef {
  amount: number;
  items: StreamItem[];
  late: number;
  wait: number;
  sent: number;
}

export interface Stream {
  stations: StreamStation[];
  items: StreamItem[];
}

export interface StreamInput {
  quotes: readonly Quote[];
  invoices: readonly Invoice[];
  clients: readonly Pick<Client, 'id' | 'name' | 'color'>[];
  /** Het bruto totaal van een stuk. In de app: `lines => total(lines).total`. */
  amount: (lines: FinanceLine[]) => number;
  now?: Date;
}

const DAY = 86_400_000;
/** Zo lang mag een verstuurde offerte stil bij de klant liggen voor het een knoop is. */
export const QUOTE_WAIT_DAYS = 7;
/** Zo lang telt een verstuurde herinnering als "opgevolgd". */
export const REMINDER_CALM_DAYS = 7;

const QUOTE_IN_PROGRESS = new Set(['draft', 'pending_internal_approval', 'internally_approved']);
const QUOTE_AT_CLIENT = new Set(['sent', 'expired']);
const INVOICE_CLOSED = new Set(['paid', 'cancelled', 'void', 'written_off', 'refunded']);
/** Een factuur die bij de offerte hoort, telt niet als "nog te factureren". */
const INVOICE_GONE = new Set(['cancelled', 'void']);

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((now.getTime() - time) / DAY);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Spiegelt de cron- en Financiën-logica (Dashboard.tsx, invoiceOverdue). */
export function invoiceIsOverdue(invoice: Pick<Invoice, 'status' | 'due_date'>, now: Date = new Date()): boolean {
  if (INVOICE_CLOSED.has(invoice.status)) return false;
  if (invoice.status === 'overdue') return true;
  if (!invoice.due_date) return false;
  const due = new Date(invoice.due_date).getTime();
  return !Number.isNaN(due) && due < now.getTime();
}

/** De datum waarop een factuur als betaald telt: de betaaldatum, anders de factuurdatum (zoals Vandaag). */
function paidDate(invoice: Pick<Invoice, 'paid_at' | 'date'>): Date | null {
  const value = invoice.paid_at ?? invoice.date;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function computeStream({ quotes, invoices, clients, amount, now = new Date() }: StreamInput): Stream {
  const clientById = new Map(clients.map(client => [client.id, client]));
  const today = isoDay(now);
  const items: StreamItem[] = [];
  const base = (clientId: string | null) => {
    const client = clientId ? clientById.get(clientId) : undefined;
    return { clientId, clientName: client?.name ?? 'Geen klant', color: client?.color || '#9A988F' };
  };

  // Een offerte die al (deels) gefactureerd is, staat niet meer bij Werk.
  const invoicedQuotes = new Set(invoices.filter(invoice => invoice.quote_id && !INVOICE_GONE.has(invoice.status)).map(invoice => invoice.quote_id as string));

  for (const quote of quotes) {
    const value = amount(quote.lines);
    if (QUOTE_IN_PROGRESS.has(quote.status)) {
      items.push({
        id: `quote:${quote.id}`, kind: 'quote', refId: quote.id, station: 'gesprek', ...base(quote.client_id),
        title: `Offerte ${quote.number}`,
        detail: quote.status === 'draft' ? 'in de maak' : quote.status === 'internally_approved' ? 'intern goedgekeurd, klaar om te versturen' : 'wacht op interne goedkeuring',
        amount: value, knot: null, at: quote.date,
      });
    } else if (QUOTE_AT_CLIENT.has(quote.status)) {
      const days = daysSince(quote.sent_at ?? quote.date, now);
      const expired = quote.status === 'expired' || Boolean(quote.valid_until && quote.valid_until < today);
      const opened = Boolean(quote.last_email_opened_at);
      const knot: Knot | null = expired ? 'late' : days != null && days >= QUOTE_WAIT_DAYS ? 'wait' : null;
      const detail = expired
        ? 'verlopen, nog geen antwoord'
        : [days != null && days > 0 ? `${plural(days, 'dag', 'dagen')} bij de klant` : 'vandaag verstuurd', opened ? 'geopend' : ''].filter(Boolean).join(' · ');
      items.push({
        id: `quote:${quote.id}`, kind: 'quote', refId: quote.id, station: 'offerte', ...base(quote.client_id),
        title: `Offerte ${quote.number}`, detail, amount: value, knot, at: quote.sent_at ?? quote.date,
      });
    } else if (quote.status === 'accepted' && !invoicedQuotes.has(quote.id)) {
      items.push({
        id: `quote:${quote.id}`, kind: 'quote', refId: quote.id, station: 'werk', ...base(quote.client_id),
        title: `Offerte ${quote.number}`, detail: 'akkoord, nog te factureren',
        amount: value, knot: null, at: quote.accepted_at ?? quote.client_decision_at ?? quote.date,
      });
    }
  }

  for (const invoice of invoices) {
    const value = amount(invoice.lines);
    if (invoice.status === 'draft') {
      items.push({
        id: `invoice:${invoice.id}`, kind: 'invoice', refId: invoice.id, station: 'werk', ...base(invoice.client_id),
        title: `Factuur ${invoice.number}`, detail: 'concept, nog niet verstuurd',
        amount: value, knot: null, at: invoice.date,
      });
    } else if (invoice.status === 'sent' || invoice.status === 'overdue') {
      // Precies "Openstaand" op Vandaag: verstuurd of te laat.
      const overdue = invoiceIsOverdue(invoice, now);
      const reminded = daysSince(invoice.last_reminder_at ?? null, now);
      const calm = reminded != null && reminded < REMINDER_CALM_DAYS;
      const dueIn = invoice.due_date ? Math.ceil((new Date(invoice.due_date).getTime() - now.getTime()) / DAY) : null;
      const detail = calm
        ? `herinnering ${reminded === 0 ? 'vandaag' : `${plural(reminded, 'dag', 'dagen')} geleden`} verstuurd`
        : overdue
          ? (dueIn != null && dueIn < 0 ? `${plural(-dueIn, 'dag', 'dagen')} te laat` : 'te laat')
          : dueIn != null ? (dueIn === 0 ? 'vervalt vandaag' : `vervalt over ${plural(dueIn, 'dag', 'dagen')}`) : 'openstaand';
      items.push({
        id: `invoice:${invoice.id}`, kind: 'invoice', refId: invoice.id, station: 'factuur', ...base(invoice.client_id),
        title: `Factuur ${invoice.number}`, detail,
        amount: value, knot: calm ? 'sent' : overdue ? 'late' : null, at: invoice.sent_at ?? invoice.date,
      });
    } else if (invoice.status === 'paid') {
      // Precies "Omzet deze maand" op Vandaag.
      const paid = paidDate(invoice);
      if (paid && paid.getFullYear() === now.getFullYear() && paid.getMonth() === now.getMonth()) {
        items.push({
          id: `invoice:${invoice.id}`, kind: 'invoice', refId: invoice.id, station: 'betaald', ...base(invoice.client_id),
          title: `Factuur ${invoice.number}`,
          detail: `betaald ${paid.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}`,
          amount: value, knot: null, at: invoice.paid_at ?? invoice.date,
        });
      }
    }
  }

  const stations = STATIONS.map(def => {
    const list = items.filter(item => item.station === def.id).sort((a, b) => a.at.localeCompare(b.at));
    return {
      ...def,
      items: list,
      amount: list.reduce((sum, item) => sum + item.amount, 0),
      late: list.filter(item => item.knot === 'late').length,
      wait: list.filter(item => item.knot === 'wait').length,
      sent: list.filter(item => item.knot === 'sent').length,
    };
  });
  return { stations, items };
}

/** Waar staat één klant in de stroom? De verste halte waar nog iets open is;
 *  alleen betaald deze maand = Betaald; niets = buiten de stroom. De knoop is
 *  de zwaarste van zijn stukken. */
export function clientPosition(stream: Stream, clientId: string): { station: StationId | null; index: number; knot: Knot | null; items: StreamItem[] } {
  const items = stream.items.filter(item => item.clientId === clientId);
  if (items.length === 0) return { station: null, index: -1, knot: null, items };
  const open = items.filter(item => item.station !== 'betaald');
  const pool = open.length > 0 ? open : items;
  const index = Math.max(...pool.map(item => STATIONS.findIndex(def => def.id === item.station)));
  const knot = items.some(item => item.knot === 'late') ? 'late' : items.some(item => item.knot === 'wait') ? 'wait' : items.some(item => item.knot === 'sent') ? 'sent' : null;
  return { station: STATIONS[index].id, index, knot, items };
}

// ── Het eiland: een opdracht ontleden ─────────────────────────────────────
export type IntentKind = 'factuur' | 'offerte' | 'taak' | 'afspraak' | 'uren';

export interface Intent {
  kind: IntentKind;
  raw: string;
  clientId?: string;
  clientName?: string;
  projectId?: string;
  projectName?: string;
  /** 'YYYY-MM-DD' */
  date?: string;
  /** "morgen", "vrijdag" — zoals je het typte */
  dayWord?: string;
  /** Minuten na middernacht. */
  minute?: number;
  /** Uren: hoeveel minuten. */
  minutes?: number;
  /** Bedrag zoals getypt: excl. btw, zoals een regel op een factuur. */
  amount?: number;
  description?: string;
}

export interface IntentContext {
  clients: readonly Pick<Client, 'id' | 'name'>[];
  projects: readonly Pick<Project, 'id' | 'name' | 'client_id' | 'archived'>[];
}

/** Woorden die geen naam dragen: lidwoorden, voorzetsels en rechtsvormen. */
const NAME_NOISE = new Set(['de', 'het', 'een', 'van', 'der', 'den', 'en', 'voor', 'aan', 'met', 'bv', 'nv', 'vof', 'the', 'and', 'of', 'b.v.', 'v.o.f.']);
const FILLER = /\b(voor|van|aan|de|het|een|met|om|op|euro|eur|excl|incl|exclusief|inclusief|btw|maken|maak|nieuwe|nieuw|graag)\b/gi;
const WEEKDAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
}

/** Het item dat het best past. Een heel woord van de naam wint van een begin
 *  ("bloem" past op "Restaurant Bloem", "koren" op "De Korenaar"), en bij
 *  gelijke stand wint het woord dat eerst staat: "factuur bloem content" is
 *  voor Bloem, ook als er een klant "Content Factory" bestaat. */
function bestMatch<T extends { id: string; name: string }>(words: string[], list: readonly T[]): { item: T; word: string } | null {
  let best: { item: T; word: string; score: number } | null = null;
  for (const item of list) {
    const nameWords = tokens(item.name).filter(word => word.length >= 3 && !NAME_NOISE.has(word));
    for (const [index, word] of words.entries()) {
      if (word.length < 3 || NAME_NOISE.has(word)) continue;
      const exact = nameWords.includes(word);
      const prefix = !exact && word.length >= 4 && nameWords.some(name => name.startsWith(word));
      if (!exact && !prefix) continue;
      const score = (exact ? 2000 : 1000) - index * 10 + Math.min(word.length, 9);
      if (!best || score > best.score) best = { item, word, score };
    }
  }
  return best ? { item: best.item, word: best.word } : null;
}

function removeWord(text: string, word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu'), '$1 ');
}

function dayFor(word: string, now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (word === 'vandaag') return start;
  if (word === 'morgen') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  if (word === 'overmorgen') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 2);
  // Een weekdag: de eerstvolgende, vandaag meegerekend.
  const target = WEEKDAYS.indexOf(word);
  const ahead = (target - start.getDay() + 7) % 7;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + ahead);
}

/**
 * "factuur bloem content oktober 650" → een factuur voor Restaurant Bloem met
 * één regel "Content oktober" van € 650 excl. btw. Begint de tekst niet met
 * factuur, offerte, taak, afspraak of uren, dan is het geen opdracht (null):
 * dan zoekt het eiland, of vraagt het Gerrie.
 */
export function parseIntent(text: string, context: IntentContext, now: Date = new Date()): Intent | null {
  const trimmed = text.trim();
  const head = /^(factuur|offerte|taak|afspraak|uren)\b\s*(.*)$/i.exec(trimmed);
  if (!head) return null;
  const kind = head[1].toLowerCase() as IntentKind;
  const intent: Intent = { kind, raw: trimmed };
  let rest = ` ${head[2]} `;

  // Bij een factuur, offerte of uren is de klant een veld: hij gaat uit de
  // omschrijving. Bij een taak of afspraak hoort hij erin: "Bel Van Dijk".
  const nameIsField = kind === 'factuur' || kind === 'offerte' || kind === 'uren';
  const client = bestMatch(tokens(rest), context.clients);
  if (client) {
    intent.clientId = client.item.id;
    intent.clientName = client.item.name;
    if (nameIsField) rest = removeWord(rest, client.word);
  }
  if (kind === 'taak' || kind === 'uren') {
    const open = context.projects.filter(project => !project.archived);
    // Eerst de projecten van die klant: "taak bloem menukaart" hoort bij Bloem.
    const own = intent.clientId ? open.filter(project => project.client_id === intent.clientId) : [];
    const project = bestMatch(tokens(rest), own) ?? bestMatch(tokens(rest), open);
    if (project) {
      intent.projectId = project.item.id;
      intent.projectName = project.item.name;
      if (nameIsField) rest = removeWord(rest, project.word);
    } else if (own.length === 1) {
      intent.projectId = own[0].id;
      intent.projectName = own[0].name;
    }
  }

  const day = /(^|\s)(vandaag|morgen|overmorgen|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)(?=\s|$)/i.exec(rest);
  if (day) {
    intent.dayWord = day[2].toLowerCase();
    intent.date = isoDay(dayFor(intent.dayWord, now));
    rest = rest.replace(day[0], ' ');
  }

  if (kind === 'afspraak' || kind === 'taak') {
    const time = /(?:\bom\s+)?\b(\d{1,2})[:.](\d{2})\b|\bom\s+(\d{1,2})\s*(?:uur\b)?/i.exec(rest);
    if (time) {
      const hour = Number(time[1] ?? time[3]);
      const minute = Number(time[2] ?? 0);
      if (hour < 24 && minute < 60) {
        intent.minute = hour * 60 + minute;
        rest = rest.replace(time[0], ' ');
      }
    }
  }
  if (kind === 'uren') {
    const hours = /\b(\d+(?:[.,]\d+)?)\s*(?:u|uur|h)\b|\b(\d+)\s*(?:m|min|minuten)\b/i.exec(rest);
    if (hours) {
      intent.minutes = hours[1] ? Math.round(Number(hours[1].replace(',', '.')) * 60) : Number(hours[2]);
      rest = rest.replace(hours[0], ' ');
    }
  } else if (kind === 'factuur' || kind === 'offerte') {
    const money = /(?:€\s*)?\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\b\s*(?:euro|eur)?/i.exec(rest);
    if (money) {
      intent.amount = Number(money[1].replace(/\./g, '').replace(',', '.'));
      rest = rest.replace(money[0], ' ');
    }
  }

  // Bij een taak of afspraak blijven de kleine woorden staan: "bel van dijk over de offerte".
  const words = (nameIsField ? rest.replace(FILLER, ' ') : rest.replace(/\b(om|op)\b/gi, ' ')).replace(/[€,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const description = words.join(' ');
    intent.description = description.charAt(0).toUpperCase() + description.slice(1);
  }
  return intent;
}

/** Wat ontbreekt er nog voor het formulier dit kan openen? Leeg = niets. */
export function intentGaps(intent: Intent): string[] {
  const gaps: string[] = [];
  if ((intent.kind === 'factuur' || intent.kind === 'offerte') && !intent.clientId) gaps.push('klant');
  if ((intent.kind === 'factuur' || intent.kind === 'offerte') && intent.amount == null) gaps.push('bedrag');
  if (intent.kind === 'taak' && !intent.description) gaps.push('wat');
  return gaps;
}
