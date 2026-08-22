import { ACTIONS } from './index.ts';
import type { ActionDef } from './types.ts';

/**
 * Opzoeken in de handelingenregistry.
 *
 * Staat los van `index.ts` omdat dat bestand wordt GEGENEREERD uit de domeinen die
 * er liggen: alleen de imports en de lijst. Zou deze logica daar ook in staan, dan
 * werd hij bij elk nieuw domein opnieuw uitgeschreven en gingen commentaar en
 * verbeteringen verloren.
 */

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/** Dubbele id's zijn een programmeerfout: de tweede zou de eerste stil overschrijven. */
if (BY_ID.size !== ACTIONS.length) {
  const seen = new Set<string>();
  const dupes = ACTIONS.map((a) => a.id).filter((id) => seen.has(id) || (seen.add(id), false));
  throw new Error(`Dubbele handeling-id's in de registry: ${[...new Set(dupes)].join(', ')}`);
}

export function getAction(id: string): ActionDef | undefined {
  return BY_ID.get(id);
}

/** Wat `find_actions` teruggeeft: genoeg om te kiezen én meteen aan te roepen. */
export interface ActionSummary {
  id: string;
  label: string;
  module: string;
  kind: 'read' | 'write';
  description: string;
  input: Record<string, unknown>;
  required: string[];
}

export function summarize(action: ActionDef): ActionSummary {
  return {
    id: action.id,
    label: action.label,
    module: action.module,
    kind: action.kind,
    description: action.description,
    input: action.input,
    required: action.required ?? [],
  };
}

/**
 * De woorden van elke handeling, één keer uitgerekend.
 *
 * `strong` is de naam, het label en de trefwoorden; `weak` de omschrijving. Die laatste
 * weegt lichter omdat hij vaak zijdelings andere handelingen noemt ("gebruik hiervoor
 * propose_report") — een treffer daarin zegt minder dan een treffer in de naam.
 */
const INDEX = ACTIONS.map((action) => ({
  action,
  strong: new Set([...tokens(action.id), ...tokens(action.label), ...(action.keywords ?? []).flatMap(tokens)]),
  weak: new Set([...tokens(action.description), ...tokens(action.module)]),
}));

/**
 * Zoekt handelingen op woorden uit de vraag van de gebruiker.
 *
 * Bewust een woordscore en geen slimmigheid: het model formuleert de zoekterm zelf en
 * kan het gerust twee keer proberen. Wat hier telt is dat een handeling die er ÍS ook
 * gevonden wordt — vandaar `keywords` naast label en omschrijving, met de woorden die
 * een gebruiker gebruikt maar een ontwikkelaar niet ("aanmaning", "afletteren").
 *
 * Eén ding is niet zo simpel: een ZELDZAAM woord weegt zwaarder dan een alledaags.
 * "memoriaalboeking maken" liep anders stuk omdat "maken" op vijftig handelingen past
 * en ze daarmee allemaal op dezelfde score zet — de echte treffer verdronk in de
 * alfabetische volgorde. Hoe minder handelingen een woord raakt, hoe meer het zegt.
 *
 * Het antwoord draagt per handeling het volledige invoerschema mee, want daarmee kan
 * het model hem meteen aanroepen. Dat maakt een ruime uitslag duur, dus de standaard
 * staat laag: liever gericht zoeken dan een lijst van dertig schema's terugkrijgen.
 */
export function searchActions(
  query: string,
  opts: { allowedIds?: Set<string> | null; modules?: (module: string, kind: 'read' | 'write') => boolean; limit?: number } = {},
): ActionSummary[] {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 25);
  const terms = tokens(query);

  const pool = INDEX
    .filter((e) => !opts.allowedIds || opts.allowedIds.has(e.action.id))
    .filter((e) => !opts.modules || opts.modules(e.action.module, e.action.kind));

  if (terms.length === 0 || pool.length === 0) return pool.slice(0, limit).map((e) => summarize(e.action));

  // Eerst per zoekwoord tellen hoe breed het valt; daaruit volgt zijn gewicht.
  const weight = new Map<string, number>();
  for (const term of terms) {
    let matches = 0;
    for (const entry of pool) if (hits(entry.strong, term) || hits(entry.weak, term)) matches += 1;
    weight.set(term, matches === 0 ? 0 : Math.log(1 + pool.length / matches));
  }

  const scored = pool.map((entry) => {
    let score = 0;
    for (const term of terms) {
      const w = weight.get(term) ?? 0;
      if (w === 0) continue;
      if (hits(entry.strong, term)) score += w * 3;
      else if (hits(entry.weak, term)) score += w;
    }
    return { entry, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.entry.action.id.localeCompare(b.entry.action.id));
  return scored.slice(0, limit).map((s) => summarize(s.entry.action));
}

/**
 * Woorden uit een tekst. Splitst op alles wat geen letter of cijfer is — met
 * `\p{L}` en niet `a-z`, anders wordt "definiëren" twee halve woorden en vindt
 * niemand meer iets met een trema of een accent.
 */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
}

/**
 * Matcht dit woord op deze zoekterm?
 *
 * Twee dingen moeten allebei kunnen. Het Nederlands maakt meervouden die ná de stam
 * uiteenlopen ("factuur" / "facturen" delen alleen "factur"), dus puur op gelijkheid
 * vergelijken mist te veel. Maar losjes op een gedeelde stam vergelijken haalt er
 * onzin bij: "memo" is een prefix van "memoriaalboeking", en "aanmaning" deelt vijf
 * letters met "aanmaken" — dan verdringt "leverancier aanmaken" de aanmaning die je
 * zocht, en met 260 handelingen in de lijst is dat geen theoretisch risico.
 *
 * Eén regel dekt allebei: de gedeelde stam moet minstens vier tekens lang zijn én
 * het grootste deel van het LANGSTE van de twee woorden beslaan. Dan halen
 * factuur/facturen (6 van 8) en klant/klanten (5 van 7) het wel, en
 * memo/memoriaalboeking (4 van 16) en aanmaning/aanmaken (5 van 9) niet.
 */
function hits(haystack: Set<string>, term: string): boolean {
  if (haystack.has(term)) return true;
  for (const word of haystack) {
    const shared = sharedPrefix(word, term);
    if (shared >= 4 && shared >= 0.7 * Math.max(word.length, term.length)) return true;
  }
  return false;
}

function sharedPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}
