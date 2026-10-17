// ============================================================
// Claude-modellen — één plek voor welk model we gebruiken, wat het kost en
// welke vorm een request voor dat model moet hebben.
//
// Gerrie (chat, agents, beslislijst), de notulen en de factuurherkenning
// praten allemaal rechtstreeks met de Messages API. Elk had zijn eigen
// prijstabel en zijn eigen aannames over het model ("Sonnet kent adaptive
// thinking, Haiku niet"). Met Claude Sonnet 5.5 schuiven die aannames:
//   - een geforceerde tool_choice (`any` of `tool`) geeft een 400;
//   - thinking staat altijd aan; je stuurt de diepgang met `effort`;
//   - een weigering van de veiligheidsfilters komt binnen als een gewone 200
//     met stop_reason 'refusal', en met `fallbacks: "default"` neemt een
//     vangnetmodel het in dezelfde aanroep over.
// Dat hoort op één plek te staan, zodat een ander model kiezen via
// GERRIE_MODEL geen code-wijziging en geen verrassing in productie is.
//
// Puur, net als roles.ts: geen Deno-imports, zodat `npm test` er rechtstreeks
// overheen draait (claudeModels.test.ts).
// ============================================================

/** Het model van Gerrie, de agents, de notulen en de factuurherkenning. */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_VERSION = '2023-06-01';
/**
 * Server-side fallback in de `"default"`-vorm: bij een weigering kiest de API
 * zelf het vangnetmodel, per soort weigering. Hoort bij precies deze header;
 * de array-vorm heeft een andere en de twee door elkaar geeft een 400.
 */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Effort = 'low' | 'medium' | 'high';

export interface ClaudeModelSpec {
  id: string;
  /** Prijzen in USD per 1M tokens (cacheWrite = schrijven met de standaard-TTL van 5 minuten). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Kent adaptive thinking + `output_config.effort`. Haiku 4.5 niet: die geeft er een 400 op. */
  adaptiveThinking: boolean;
  /** Accepteert `tool_choice` any/tool. Sonnet 5.5, Opus 5.5 en Fable 5.1 weigeren dat met een 400. */
  forcedToolChoice: boolean;
  /** Kent `fallbacks: "default"` (beta, alleen op de Claude API). */
  serverFallback: boolean;
}

type KnownSpec = Omit<ClaudeModelSpec, 'id'>;

/**
 * De modellen die we kennen. Een onbekend model (een nieuwe naam, of een
 * gedateerde variant) valt terug op de langste bekende naam waar hij mee
 * begint, en anders op de veilige standaard hieronder.
 */
const KNOWN_MODELS: ReadonlyArray<readonly [string, KnownSpec]> = [
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, adaptiveThinking: true, forcedToolChoice: false, serverFallback: true }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, adaptiveThinking: true, forcedToolChoice: true, serverFallback: false }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, adaptiveThinking: true, forcedToolChoice: true, serverFallback: false }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, adaptiveThinking: true, forcedToolChoice: false, serverFallback: true }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, adaptiveThinking: true, forcedToolChoice: true, serverFallback: true }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, adaptiveThinking: true, forcedToolChoice: true, serverFallback: false }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, adaptiveThinking: true, forcedToolChoice: true, serverFallback: false }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, adaptiveThinking: true, forcedToolChoice: true, serverFallback: false }],
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, adaptiveThinking: true, forcedToolChoice: false, serverFallback: true }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, adaptiveThinking: true, forcedToolChoice: true, serverFallback: false }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, adaptiveThinking: false, forcedToolChoice: true, serverFallback: false }],
];

/**
 * Een model dat we niet kennen: rekenen tegen Sonnet 5.5-prijzen, adaptive
 * thinking aan (dat kent elk huidig model), en GEEN geforceerde tool_choice of
 * fallback — `auto` werkt overal, een onbekende parameter niet.
 */
const UNKNOWN_MODEL: KnownSpec = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, adaptiveThinking: true, forcedToolChoice: false, serverFallback: false };

/** Wat we van dit model weten. Leeg of alleen spaties = het standaardmodel. */
export function claudeModelSpec(rawId: string | null | undefined): ClaudeModelSpec {
  const id = String(rawId ?? '').trim() || DEFAULT_CLAUDE_MODEL;
  const exact = KNOWN_MODELS.find(([name]) => name === id);
  if (exact) return { id, ...exact[1] };
  // Een gedateerde variant ('claude-haiku-4-5-20251001') hoort bij de langste
  // bekende naam waar hij mee begint — niet bij 'claude-sonnet-5' als het
  // eigenlijk 'claude-sonnet-5-5-…' is.
  const prefix = KNOWN_MODELS
    .filter(([name]) => id.startsWith(`${name}-`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return { id, ...(prefix ? prefix[1] : UNKNOWN_MODEL) };
}

/**
 * De model-afhankelijke velden van een Messages-request: welk model, hoe diep
 * het nadenkt, en het vangnet bij een weigering. Wie dit samenvoegt met zijn
 * eigen velden, hoeft niet te weten welk model er draait.
 */
export function modelRequestFields(spec: ClaudeModelSpec, effort: Effort): Record<string, unknown> {
  const fields: Record<string, unknown> = { model: spec.id };
  if (spec.adaptiveThinking) {
    fields.thinking = { type: 'adaptive' };
    fields.output_config = { effort };
  }
  if (spec.serverFallback) fields.fallbacks = 'default';
  return fields;
}

/** De headers voor dit model; de fallback-beta alleen waar `fallbacks` meegaat. */
export function anthropicHeaders(apiKey: string, spec: ClaudeModelSpec): Record<string, string> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (spec.serverFallback) headers['anthropic-beta'] = SERVER_FALLBACK_BETA;
  return headers;
}

/** Een content-blok zoals de API het teruggeeft. */
export interface ContentBlock { type: string; [key: string]: unknown }

/**
 * Wat er van een assistentbeurt terug de geschiedenis in mag.
 *
 * Weigert het model halverwege en neemt het vangnetmodel het over, dan staat er
 * een `fallback`-blok in de content. Alles dáárvoor kwam van de poging die
 * weigerde: de TEKST daarvan mag mee (het vangnetmodel ging erop verder), maar
 * thinking- en tool_use-blokken van vóór de grens niet — die horen bij een
 * poging die niet doorging, en een tool_use daarvan uitvoeren zou iets doen wat
 * geen model meer wil. Het fallback-blok zelf is alleen een markering.
 */
export function assistantContentForHistory(blocks: ContentBlock[]): ContentBlock[] {
  let boundary = -1;
  blocks.forEach((block, index) => { if (block.type === 'fallback') boundary = index; });
  if (boundary < 0) return blocks;
  return blocks.filter((block, index) => index > boundary || block.type === 'text');
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Wat het kostte, per poging tegen het model dat hem deed (onafgerond, USD).
   * Alleen gezet als usageFromResponse het gevraagde model kreeg; anders rekent
   * modelCostUsd alles tegen één model.
   */
  costUsd?: number;
}

function tokens(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function rowUsage(row: Record<string, unknown> | null | undefined): TokenUsage {
  return {
    input: tokens(row?.input_tokens),
    output: tokens(row?.output_tokens),
    cacheRead: tokens(row?.cache_read_input_tokens),
    cacheWrite: tokens(row?.cache_creation_input_tokens),
  };
}

function exactCostUsd(spec: ClaudeModelSpec, usage: TokenUsage): number {
  return (usage.input * spec.input + usage.output * spec.output
    + usage.cacheRead * spec.cacheRead + usage.cacheWrite * spec.cacheWrite) / 1_000_000;
}

/**
 * Het verbruik van één antwoord.
 *
 * Normaal is dat de top-level `usage`. Na een fallback telt die alleen de
 * poging die het antwoord leverde; `usage.iterations` noemt elke poging apart,
 * en dan tellen we die op. Een weigering vóór de eerste output wordt niet altijd
 * gefactureerd; die toch meetellen is bewust royaal — het maandtegoed hoort
 * eerder te krap dan te ruim te zijn.
 *
 * Met `requested` erbij komt ook de prijs mee, per poging tegen het model dat hem
 * deed: de geweigerde pogingen (`message`) tegen het gevraagde model, de poging
 * die het antwoord leverde (`fallback_message`) tegen `servedModel` — het
 * vangnetmodel rekent zijn eigen tarief.
 */
export function usageFromResponse(
  raw: Record<string, unknown> | null | undefined,
  requested?: ClaudeModelSpec,
  servedModel?: string | null,
): TokenUsage {
  const usage = raw ?? {};
  const iterations = Array.isArray(usage.iterations) ? (usage.iterations as Array<Record<string, unknown>>) : [];
  const fellBack = iterations.some((entry) => entry?.type === 'fallback_message');
  const rows = fellBack ? iterations : [usage];
  const total = rows.reduce<TokenUsage>((sum, row) => {
    const add = rowUsage(row);
    return {
      input: sum.input + add.input,
      output: sum.output + add.output,
      cacheRead: sum.cacheRead + add.cacheRead,
      cacheWrite: sum.cacheWrite + add.cacheWrite,
    };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  if (!requested) return total;
  const served = servedModel ? claudeModelSpec(servedModel) : requested;
  total.costUsd = fellBack
    ? rows.reduce((sum, row) => sum + exactCostUsd(row?.type === 'fallback_message' ? served : requested, rowUsage(row)), 0)
    : exactCostUsd(served, total);
  return total;
}

/** Telt het verbruik van een volgende beurt bij `total` op, prijs inbegrepen. */
export function addUsage(total: TokenUsage, add: TokenUsage, spec: ClaudeModelSpec): void {
  // Wie al een prijs per poging heeft, houdt die; anders tegen het gevraagde model.
  const cost = (total.costUsd ?? exactCostUsd(spec, total)) + (add.costUsd ?? exactCostUsd(spec, add));
  total.input += add.input;
  total.output += add.output;
  total.cacheRead += add.cacheRead;
  total.cacheWrite += add.cacheWrite;
  total.costUsd = cost;
}

/**
 * Kosten in USD, afgerond op vier decimalen (zoals ai_usage ze bewaart). Draagt
 * het verbruik een prijs per poging (`costUsd`), dan telt die: na een fallback
 * rekent niet alles tegen één model.
 */
export function modelCostUsd(spec: ClaudeModelSpec, usage: TokenUsage): number {
  const cost = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : exactCostUsd(spec, usage);
  return Math.round(cost * 10000) / 10000;
}

/**
 * Wat de gebruiker leest als de veiligheidsfilter van het model een verzoek
 * tegenhoudt. In een bedrijfsadministratie gebeurt dat zelden, en juist dan
 * hoort er een gewone zin te staan in plaats van een leeg antwoord.
 */
export function refusalText(category: unknown): string {
  const base = 'Hier kan ik niet mee verder: de veiligheidsfilter van het AI-model hield dit verzoek tegen.';
  if (category === 'reasoning_extraction') {
    return `${base} Vraag me niet om mijn interne redenering uit te schrijven; vraag gewoon om het resultaat.`;
  }
  return `${base} Formuleer het anders, of doe dit stuk zelf in de app.`;
}
