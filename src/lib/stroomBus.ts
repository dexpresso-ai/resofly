import { useSyncExternalStore } from 'react';

/**
 * Wat Stroom door de app heen laat lopen: meldingen in het eiland (met tijd om
 * terug te halen) en het licht onder het glas (een rimpel, de kleur van de
 * klant waar je bent).
 *
 * Bewust buiten React-state: een melding met "terughalen" moet doorlopen als
 * je intussen naar een andere pagina gaat, en het lichtveld hoort niet bij
 * elke render van de app opnieuw te tekenen.
 */

export type NoteTone = 'ok' | 'gold' | 'ai' | 'muted';

export interface StroomNote {
  id: string;
  tone: NoteTone;
  title: string;
  detail?: string;
  /** Met terughalen: zo lang (seconden) loopt de klok. */
  seconds?: number;
  /** Wanneer de klok afloopt (ms sinds epoch). */
  until?: number;
  /** Een melding zonder terughalen verdwijnt na zoveel ms. */
  ttl?: number;
}

interface Pending {
  note: StroomNote;
  /** 0 zolang de klok nog niet loopt: hij wacht tot hij vooraan in het eiland staat. */
  timer: number;
  seconds: number;
  resolve: (outcome: 'done' | 'undone') => void;
  run: () => Promise<void> | void;
}

let queue: StroomNote[] = [];
const pending = new Map<string, Pending>();
const plain = new Map<string, number>();
const listeners = new Set<() => void>();
let seq = 0;

function emit() { listeners.forEach(listener => listener()); }
function remove(id: string) {
  queue = queue.filter(note => note.id !== id);
  emit();
}

/** Een gewone melding: verschijnt in het eiland en gaat vanzelf weg. Een
 *  melding met terughalen gaat altijd voor. */
export function notify(note: Omit<StroomNote, 'id'>): string {
  const id = `n${++seq}`;
  const full: StroomNote = { ttl: 4200, ...note, id };
  queue = [...queue, full];
  emit();
  plain.set(id, window.setTimeout(() => { plain.delete(id); remove(id); }, full.ttl));
  return id;
}

/**
 * Doe iets pas na `seconds` seconden, met een melding waarin je het kunt
 * terughalen. Zo gaat een mail niet meteen de deur uit: tien seconden lang
 * staat er "gaat over 10 s de deur uit" met Terughalen ernaast.
 *
 * Er loopt één klok tegelijk: die vooraan in het eiland. Geef je twee keer
 * kort na elkaar akkoord, dan begint de tweede klok pas als de eerste klaar
 * is. Zo zie je elke klok helemaal, en gaat er nooit iets de deur uit dat je
 * niet kon terughalen.
 *
 * Sluit je het venster binnen die tijd, dan gebeurt er niets: het voorstel
 * blijft gewoon staan, en je ziet het de volgende keer weer.
 */
export function deferred(note: Omit<StroomNote, 'id' | 'until'> & { seconds: number }, run: () => Promise<void> | void): Promise<'done' | 'undone'> {
  const id = `n${++seq}`;
  const full: StroomNote = { ...note, id };
  // Terughalen gaat voor: vooraan in de rij, na eventuele andere klokken.
  const clocks = queue.filter(item => pending.has(item.id));
  const rest = queue.filter(item => !pending.has(item.id));
  queue = [...clocks, full, ...rest];
  return new Promise(resolve => {
    pending.set(id, { note: full, timer: 0, seconds: note.seconds, resolve, run });
    startClock();
  });
}

/** Zet de klok van de eerste melding met terughalen aan, als die nog niet loopt. */
function startClock() {
  const first = queue.find(item => pending.has(item.id));
  const entry = first ? pending.get(first.id) : undefined;
  if (entry && !entry.timer) {
    const until = Date.now() + entry.seconds * 1000;
    entry.note = { ...entry.note, until };
    queue = queue.map(item => (item.id === entry.note.id ? entry.note : item));
    entry.timer = window.setTimeout(() => { void commit(entry.note.id); }, entry.seconds * 1000);
  }
  emit();
}

async function commit(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  remove(id);
  startClock();
  try {
    await entry.run();
    entry.resolve('done');
  } catch (error) {
    // De aanroeper meldt de fout zelf; het eiland laat zien dat het niet lukte.
    entry.resolve('done');
    notify({ tone: 'muted', title: 'Dat lukte niet', detail: error instanceof Error ? error.message : 'Er ging iets mis.' });
  }
}

/** Haal terug: de klok stopt en er gebeurt niets. */
export function undo(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  pending.delete(id);
  remove(id);
  startClock();
  entry.resolve('undone');
}

/** Nu doen in plaats van wachten. */
export function commitNow(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  void commit(id);
}

export function dismiss(id: string): void {
  if (pending.has(id)) return; // een klok sluit je met Terughalen of Nu
  const timer = plain.get(id);
  if (timer) window.clearTimeout(timer);
  plain.delete(id);
  remove(id);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** De melding die nu in het eiland staat (de eerste in de rij), en hoeveel er wachten. */
export function useStroomNotes(): { note: StroomNote | null; waiting: number } {
  const list = useSyncExternalStore(subscribe, () => queue, () => queue);
  return { note: list[0] ?? null, waiting: Math.max(0, list.length - 1) };
}

// ── Het licht ──────────────────────────────────────────────────────────────
export type LightCommand =
  | { kind: 'ripple'; x: number; y: number; amount: number }
  | { kind: 'tint'; color: string | null };

const lightListeners = new Set<(command: LightCommand) => void>();
let lastTint: string | null = null;

export function onLight(listener: (command: LightCommand) => void): () => void {
  lightListeners.add(listener);
  if (lastTint) listener({ kind: 'tint', color: lastTint });
  return () => { lightListeners.delete(listener); };
}

/** Een rimpel van goud door het veld: er kwam geld binnen, of je gaf akkoord.
 *  x en y zijn 0..1 vanaf linksboven, zoals een positie op het scherm. */
export function rippleLight(x = 0.5, y = 0.3, amount = 1): void {
  lightListeners.forEach(listener => listener({ kind: 'ripple', x, y, amount }));
}

/** Rippel vanaf een element: het midden ervan. */
export function rippleFrom(element: Element | null, amount = 1): void {
  if (!element || typeof window === 'undefined') { rippleLight(0.5, 0.3, amount); return; }
  const box = element.getBoundingClientRect();
  rippleLight((box.left + box.width / 2) / window.innerWidth, (box.top + box.height / 2) / window.innerHeight, amount);
}

/** Het licht van de klant waar je bent, of geen (null). */
export function tintLight(color: string | null): void {
  if (color === lastTint) return;
  lastTint = color;
  lightListeners.forEach(listener => listener({ kind: 'tint', color }));
}
