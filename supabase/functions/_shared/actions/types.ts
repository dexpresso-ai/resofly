/**
 * De HANDELINGENREGISTRY — wat Gerrie en zijn agents in deze app kunnen doen.
 *
 * WAAROM DIT BESTAAT
 * Gerrie had 65 tools, elk met de hand geschreven: een tooldefinitie op de server,
 * een voorsteltype, een label, een uitvoerder in de browser en een kaart in de chat.
 * De app zelf biedt bijna zeshonderd handelingen. Op die manier doorbouwen loopt op
 * twee muren stuk:
 *
 *  1. GELD. Elke tooldefinitie gaat bij ELKE chatbeurt en ELKE agentronde mee als
 *     invoertokens. Vijfhonderd definities is tienduizenden tokens per verzoek —
 *     bij een maandtegoed van een paar euro is dat het hele budget aan een lijst
 *     die je meestal niet gebruikt.
 *  2. TREFZEKERHEID. Een model dat uit vijfhonderd tools moet kiezen, kiest slechter
 *     dan een model dat er twintig ziet en de rest kan opzoeken.
 *
 * HOE HET WERKT
 * Handelingen staan hier als DATA, niet als tools. Het model krijgt drie meta-tools:
 *   `find_actions`   — zoek in de registry ("wat kan ik met een galerij?")
 *   `run_action`     — voer een LEES-handeling uit
 *   `propose_action` — zet een SCHRIJF-handeling klaar; die komt als kaart bij de
 *                      gebruiker en gebeurt pas na diens akkoord
 *
 * Zo kost de lange staart alleen tokens op het moment dat hij nodig is, terwijl de
 * agent-bouwer wél de volledige lijst kan tonen: daar vink je per handeling aan wat
 * een agent mag, en die selectie wordt bij het draaien in de tooluitleg gezet.
 *
 * DE VIER HARDE REGELS BLIJVEN GELDEN
 *  1. `organization_id` komt nooit uit het model maar uit de geverifieerde sessie.
 *  2. Elke query is org-scoped; de service-role slaat RLS over, dus dit is de grens.
 *  3. Schrijven gebeurt nooit hier. `plan()` bouwt alleen een VOORSTEL; de browser
 *     voert het uit nadat een mens akkoord gaf — langs dezelfde weg als de knop in
 *     het scherm.
 *  4. Data uit de database is data, geen instructie.
 */

/**
 * Supabase-client met service-role. ALTIJD zelf op organization_id filteren — de
 * service-role slaat RLS over, dus dat filter is hier de enige grens.
 *
 * Bewust structureel en losjes getypt in plaats van de generieke SupabaseClient:
 * dit project heeft geen gegenereerde tabeltypes, en de generieke variant levert
 * alleen strijd op met de schema-parameters zonder iets te vangen.
 */
// deno-lint-ignore no-explicit-any
type Query = any;
export interface Db {
  from(table: string): Query;
  rpc(fn: string, params?: Record<string, unknown>): Query;
}

/** Soort voorstel; bepaalt alleen het icoontje in de goedkeurwachtrij. */
export type ProposalKind = 'money' | 'mail' | 'agenda' | 'work' | 'insight' | 'agent';

/** Alles wat een handeling van zijn omgeving nodig heeft. */
export interface ActionCtx {
  organizationId: string;
  userId: string;
  role: string;
  /** Vandaag in Europe/Amsterdam, als YYYY-MM-DD. */
  today: string;
  db: Db;
}

/**
 * Wat een schrijf-handeling klaarzet.
 *
 * `title` en `sub` zijn wat de gebruiker op de kaart leest vóór hij akkoord geeft —
 * schrijf ze zo dat je op die twee regels alleen kunt beslissen. `payload` is wat de
 * uitvoerder in de browser nodig heeft: id's en waarden, geen halve zinnen.
 */
export interface ActionPlan {
  title: string;
  sub: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
}

/** Invoer klopt niet; de tekst gaat terug naar het model zodat het zichzelf corrigeert. */
export class ActionError extends Error {
  constructor(message: string) { super(message); this.name = 'ActionError'; }
}

export interface ActionDef {
  /** Stabiele sleutel, `domein.werkwoord`: 'client.set_address'. Verandert nooit — een
   *  opgeslagen agent verwijst ernaar, en een hernoemde id breekt die agent stil. */
  id: string;
  /** Wat de gebruiker aanvinkt in de agent-bouwer. Nederlands, actief, concreet. */
  label: string;
  /** Modulesleutel: clients/projects/time/calendar/tickets/content/stats/marketing/finance/gerrie. */
  module: string;
  kind: 'read' | 'write';
  /** Voor het model: wanneer gebruik je dit, en wat gebeurt er dan? */
  description: string;
  /** Extra zoekwoorden voor `find_actions`, naast label en omschrijving. */
  keywords?: string[];
  /** JSON-schema-eigenschappen van de invoer. */
  input: Record<string, unknown>;
  required?: string[];
  /** Alleen bij kind 'read'. */
  read?: (ctx: ActionCtx, input: Record<string, unknown>) => Promise<unknown>;
  /** Alleen bij kind 'write'. Gooit ActionError bij onbruikbare invoer. */
  plan?: (ctx: ActionCtx, input: Record<string, unknown>) => Promise<ActionPlan>;
}

// ── Kleine hulpjes, zodat elke handeling er hetzelfde uitziet ────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verplichte tekst. */
export function str(input: Record<string, unknown>, key: string, max = 500): string {
  const value = String(input[key] ?? '').trim();
  if (!value) throw new ActionError(`"${key}" is verplicht.`);
  return value.slice(0, max);
}

/** Optionele tekst; leeg wordt null. */
export function optStr(input: Record<string, unknown>, key: string, max = 500): string | null {
  const value = String(input[key] ?? '').trim();
  return value ? value.slice(0, max) : null;
}

/** Verplicht getal. */
export function num(input: Record<string, unknown>, key: string): number {
  const value = Number(input[key]);
  if (!Number.isFinite(value)) throw new ActionError(`"${key}" moet een getal zijn.`);
  return value;
}

/** Optioneel getal; ontbrekend wordt null. */
export function optNum(input: Record<string, unknown>, key: string): number | null {
  if (input[key] === undefined || input[key] === null || input[key] === '') return null;
  const value = Number(input[key]);
  if (!Number.isFinite(value)) throw new ActionError(`"${key}" moet een getal zijn.`);
  return value;
}

export function bool(input: Record<string, unknown>, key: string, fallback = false): boolean {
  return typeof input[key] === 'boolean' ? input[key] as boolean : fallback;
}

/** Verplichte keuze uit een vaste lijst. */
export function choice<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = String(input[key] ?? '').trim() as T;
  if (!allowed.includes(value)) throw new ActionError(`"${key}" moet een van deze zijn: ${allowed.join(', ')}.`);
  return value;
}

/** Optionele keuze; ontbrekend wordt null. */
export function optChoice<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T | null {
  if (input[key] === undefined || input[key] === null || input[key] === '') return null;
  return choice(input, key, allowed);
}

/** Verplichte datum YYYY-MM-DD. */
export function isoDate(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ActionError(`"${key}" moet een datum zijn als JJJJ-MM-DD.`);
  return value;
}

export function optIsoDate(input: Record<string, unknown>, key: string): string | null {
  if (input[key] === undefined || input[key] === null || input[key] === '') return null;
  return isoDate(input, key);
}

/** Verplichte id; controleert alleen de vorm, niet het bestaan. */
export function id(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? '').trim();
  if (!UUID_RE.test(value)) throw new ActionError(`"${key}" moet een geldig id zijn. Zoek het eerst op en gebruik het exacte id.`);
  return value;
}

export function optId(input: Record<string, unknown>, key: string): string | null {
  if (input[key] === undefined || input[key] === null || input[key] === '') return null;
  return id(input, key);
}

/** Lijst met id's; minstens één. */
export function ids(input: Record<string, unknown>, key: string, max = 200): string[] {
  const raw = Array.isArray(input[key]) ? input[key] as unknown[] : [];
  const list = [...new Set(raw.map((v) => String(v).trim()).filter((v) => UUID_RE.test(v)))];
  if (list.length === 0) throw new ActionError(`"${key}" heeft minstens één geldig id nodig.`);
  return list.slice(0, max);
}

/**
 * Haalt één rij op binnen de organisatie en geeft een leesbare fout als hij er niet is.
 * Alle handelingen gaan hierlangs — dat is de plek waar de org-grens wordt afgedwongen.
 */
export async function row<T = Record<string, unknown>>(
  ctx: ActionCtx, table: string, rowId: string, select = '*', label = 'Rij',
): Promise<T> {
  const { data, error } = await ctx.db.from(table).select(select)
    .eq('organization_id', ctx.organizationId).eq('id', rowId).maybeSingle();
  if (error) throw new ActionError(`${label} ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError(`${label} niet gevonden in deze organisatie.`);
  return data as T;
}

/** Lijst binnen de organisatie, met een harde bovengrens op het aantal rijen. */
export function orgQuery(ctx: ActionCtx, table: string, select = '*') {
  return ctx.db.from(table).select(select).eq('organization_id', ctx.organizationId);
}

/** Maakt een `%zoekterm%` veilig voor ILIKE. */
export function likeSafe(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Bedrag in hele euro's als leesbare tekst: "€ 1.250,00". */
export function euro(amount: number): string {
  return `€ ${amount.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Centen naar een leesbaar bedrag. */
export function euroCents(cents: number): string {
  return euro(Math.round(cents) / 100);
}

/** Knipt een lijst af tot een leesbaar onderschrift. */
export function joinShort(parts: Array<string | null | undefined>, max = 90): string {
  const text = parts.filter(Boolean).join(' · ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
