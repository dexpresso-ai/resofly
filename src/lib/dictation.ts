// Inspreken bij Gerrie: van de losse resultaten van de spraakherkenning in de
// browser één lopende tekst maken, zonder herhalingen.
//
// Waarom dit een eigen bestand is: de eerste versie plakte elk "definitief"
// resultaat achter het vorige. In Chrome op de computer klopt dat, maar elders
// leverde het veel dubbele woorden op:
// - Chrome op Android meldt bij doorlopend luisteren elk tussenresultaat al als
//   definitief, telkens met de hele zin tot dan toe en een zekerheid
//   (confidence) van 0. Pas de echte uitslag aan het eind heeft een zekerheid.
//   Van "hallo hoe gaat het" maakten we zo "hallohallo hoehallo hoe gaat het…".
// - Safari (en Chrome op de iPhone, dat dezelfde motor gebruikt) geeft soms de
//   hele tekst sinds de start opnieuw als definitief resultaat, meldt hetzelfde
//   resultaat twee keer, of zet een zin twee keer achter elkaar in één resultaat.
// Daarom vergelijken we de woorden met wat er al staat, in plaats van blind
// achter elkaar te plakken.

/** Eén resultaat zoals de browser het geeft (alleen het beste alternatief). */
export interface SpeechPiece {
  transcript: string;
  isFinal: boolean;
  confidence?: number;
}

export interface DictationState {
  /** Wat er tot nu toe is vastgelegd, in volgorde. */
  readonly segments: readonly string[];
  /** Het laatste stuk is een voorlopig resultaat van Android, dat nog kan wijzigen. */
  readonly lastProvisional: boolean;
}

export const EMPTY_DICTATION: DictationState = { segments: [], lastProvisional: false };

/** Chrome op Android gedraagt zich anders (zie boven); daar letten we op de zekerheid. */
export function isAndroidUserAgent(userAgent: string): boolean {
  return /android/i.test(userAgent);
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Vergelijk woorden zonder hoofdletters en leestekens: "Hallo," en "hallo" zijn hetzelfde. */
function wordKey(word: string): string {
  return word.toLocaleLowerCase('nl').replace(/[^\p{L}\p{N}]+/gu, '');
}

function keysOf(text: string): string[] {
  return splitWords(text).map(wordKey).filter(Boolean);
}

function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((w, i) => words[i] === w);
}

/** Lengte van de langste gemeenschappelijke woordreeks, met gaten (LCS). */
function sharedWords(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Een zin die in z'n geheel twee (of meer) keer achter elkaar staat, één keer.
 * Safari deed dat soms ("stuur de factuur stuur de factuur"). Eén los woord
 * dubbel laten we staan: "nee nee" kan iemand echt zeggen.
 */
export function collapseRepeats(text: string): string {
  const words = splitWords(text);
  const keys = words.map(wordKey);
  for (let size = 2; size <= words.length / 2; size += 1) {
    if (words.length % size !== 0) continue;
    if (keys.every((k, i) => k === keys[i % size])) return words.slice(0, size).join(' ');
  }
  return words.join(' ');
}

/** Voeg één stuk tekst toe aan wat er al staat, zonder iets dubbel te zetten. */
function addPiece(state: DictationState, raw: string, provisional: boolean): DictationState {
  const text = collapseRepeats(raw);
  const incoming = keysOf(text);
  if (!incoming.length) return state;
  const { segments } = state;

  // Herhaalt het nieuwe stuk het einde van wat er staat en gaat het verder?
  // Dan vervangt het dat einde. Zo werken Android (de hele zin tot nu toe) en
  // Safari (alle tekst sinds de start). We beginnen bij het langste einde.
  for (let k = 0; k < segments.length; k += 1) {
    if (startsWithWords(incoming, keysOf(segments.slice(k).join(' ')))) {
      return { segments: [...segments.slice(0, k), text], lastProvisional: provisional };
    }
  }

  // Staat het nieuwe stuk er al? Dan is het een herhaalde melding. Alleen een
  // voorlopig laatste stuk maakt plaats, want wat later komt weet het beter.
  for (let k = 0; k < segments.length; k += 1) {
    if (startsWithWords(keysOf(segments.slice(k).join(' ')), incoming)) {
      if (state.lastProvisional && k === segments.length - 1) {
        return { segments: [...segments.slice(0, k), text], lastProvisional: provisional };
      }
      return state;
    }
  }

  // Een voorlopig resultaat dat sterk op het nieuwe lijkt, is door de
  // herkenner verbeterd ("hallo koe gaat" → "hallo hoe gaat het"). Lijkt het
  // er niet op, dan is het een nieuwe zin en blijft het vorige staan.
  const last = segments[segments.length - 1];
  if (state.lastProvisional && last !== undefined) {
    const previous = keysOf(last);
    const needed = Math.ceil(Math.min(previous.length, incoming.length) * 0.6);
    if (sharedWords(previous, incoming) >= needed) {
      return { segments: [...segments.slice(0, -1), text], lastProvisional: provisional };
    }
  }

  return { segments: [...segments, text], lastProvisional: provisional };
}

/**
 * Verwerk één `result`-gebeurtenis van de spraakherkenning.
 *
 * `state` is wat er tot nu toe vastligt; geef de teruggegeven `state` bij de
 * volgende gebeurtenis weer mee. `text` is wat er nu in beeld hoort, inclusief
 * het nog niet definitieve deel.
 */
export function readDictationEvent(
  state: DictationState,
  resultIndex: number,
  results: ArrayLike<SpeechPiece>,
  options: { android: boolean },
): { state: DictationState; text: string } {
  let next = state;
  let interim = '';
  for (let i = Math.max(0, resultIndex); i < results.length; i += 1) {
    const result = results[i];
    const transcript = result?.transcript ?? '';
    if (!result?.isFinal) {
      // De tussenstukken van één gebeurtenis horen aan elkaar (Chrome zet zelf
      // de spatie ervoor), net als de oude versie deed.
      interim += transcript;
      continue;
    }
    const provisional = options.android && !((result.confidence ?? 0) > 0);
    next = addPiece(next, transcript, provisional);
  }
  const shown = interim.trim() ? addPiece(next, interim, true) : next;
  return { state: next, text: shown.segments.join(' ') };
}

/** De tekst in het invoerveld: wat er al stond, met de ingesproken tekst erachter. */
export function composeDraft(base: string, spoken: string, max = 4000): string {
  const head = base.replace(/\s+$/, '');
  const tail = spoken.trim();
  return (head && tail ? `${head} ${tail}` : head || tail).slice(0, max);
}
