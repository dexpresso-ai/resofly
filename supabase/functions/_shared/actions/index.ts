import type { ActionDef } from './types.ts';
import { CLIENT_ACTIONS } from './clients.ts';
import { TICKETS_ACTIONS } from './tickets.ts';
import { INSIGHT_ACTIONS } from './insight.ts';

/**
 * De volledige handelingenregistry, samengesteld uit de domeinbestanden.
 *
 * Voeg je een domein toe, dan hoort dat op twee plekken: hier in de lijst, én in
 * `src/lib/actions/` met de uitvoerder die de browser gebruikt zodra de gebruiker
 * akkoord geeft. Een handeling zonder uitvoerder komt netjes als "deze actie kan
 * hier niet uitgevoerd worden" terug in plaats van stilletjes niets te doen —
 * `npm test` bewaakt dat de twee kanten gelijk blijven lopen.
 */
export const ACTIONS: ActionDef[] = [
  ...CLIENT_ACTIONS,
  ...TICKETS_ACTIONS,
  ...INSIGHT_ACTIONS,
];

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
 */
export function searchActions(
  query: string,
  opts: { allowedIds?: Set<string> | null; modules?: (module: string, kind: 'read' | 'write') => boolean; limit?: number } = {},
): ActionSummary[] {
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 40);
  const terms = query.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 2);

  const pool = ACTIONS
    .filter((a) => !opts.allowedIds || opts.allowedIds.has(a.id))
    .filter((a) => !opts.modules || opts.modules(a.module, a.kind));

  if (terms.length === 0) return pool.slice(0, limit).map(summarize);

  const scored = pool.map((action) => {
    const hay = `${action.id} ${action.label} ${action.description} ${(action.keywords ?? []).join(' ')} ${action.module}`.toLowerCase();
    const label = `${action.id} ${action.label} ${(action.keywords ?? []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (label.includes(term)) score += 3;
      else if (hay.includes(term)) score += 1;
    }
    return { action, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id));
  return scored.slice(0, limit).map((s) => summarize(s.action));
}
