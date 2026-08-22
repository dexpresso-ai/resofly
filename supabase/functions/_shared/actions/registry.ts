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
 * Zoekt handelingen op woorden uit de vraag van de gebruiker.
 *
 * Bewust een simpele woordscore en geen slimmigheid: het model formuleert de zoekterm
 * zelf en kan het gerust twee keer proberen. Wat hier vooral telt is dat een handeling
 * die er ÍS ook gevonden wordt — vandaar `keywords` naast label en omschrijving, met
 * de woorden die een gebruiker gebruikt maar een ontwikkelaar niet ("aanmaning",
 * "afletteren", "deponeren").
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

  const pool = ACTIONS
    .filter((a) => !opts.allowedIds || opts.allowedIds.has(a.id))
    .filter((a) => !opts.modules || opts.modules(a.module, a.kind));

  if (terms.length === 0) return pool.slice(0, limit).map(summarize);

  const scored = pool.map((action) => {
    // De naam en de trefwoorden wegen zwaarder dan de omschrijving: die laatste
    // noemt vaak zijdelings andere handelingen ("gebruik hiervoor propose_report").
    const strong = new Set([...tokens(action.id), ...tokens(action.label), ...(action.keywords ?? []).flatMap(tokens)]);
    const weak = new Set([...tokens(action.description), ...tokens(action.module)]);
    let score = 0;
    for (const term of terms) {
      if (hits(strong, term)) score += 3;
      else if (hits(weak, term)) score += 1;
    }
    return { action, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id));
  return scored.slice(0, limit).map((s) => summarize(s.action));
}

/**
 * Woorden uit een tekst. Splitst op alles wat geen letter of cijfer is — met
 * `\p{L}` en niet `a-z`, anders wordt "definiëren" twee halve woorden en vindt
 * niemand meer iets met een trema of een accent.
 */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
}

/** Treffer op een heel woord of op een woord dat ermee begint ("factuur" ↔ "facturen"). */
function hits(haystack: Set<string>, term: string): boolean {
  if (haystack.has(term)) return true;
  for (const word of haystack) if (word.startsWith(term) || term.startsWith(word)) return true;
  return false;
}
