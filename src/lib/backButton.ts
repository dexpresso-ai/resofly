/**
 * De terugknop van de telefoon als "terug" in ResoFly.
 *
 * ResoFly wisselt van pagina in React-state, niet via adressen. Voor de
 * browser bleef het dus altijd dezelfde pagina, zonder geschiedenis. Drukte
 * je in de geïnstalleerde app op de terugknop van Android, dan was er niets
 * om naar terug te gaan, en ging de app naar de achtergrond: ResoFly
 * verdween midden in het werk van het scherm (melding van een gebruiker,
 * november 2026).
 *
 * Hoe het nu werkt. Alles waar "terug" iets aan kan doen, is een stap:
 *  - een open venster, menu of paneel, en een gesprek dat op de telefoon het
 *    hele scherm vult (useBackStep, bovenop);
 *  - eronder de vorige pagina's van het werktabblad (de basis, uit main.tsx).
 * Per stap staat er één item in de browsergeschiedenis. Drukt iemand op
 * terug, dan neemt de browser één item weg en doen wij de bovenste stap.
 * Sluit iemand een venster met de knop in beeld, dan halen wij zijn item weg.
 * Is er niets meer om naar terug te gaan, dan staat er ook geen item meer, en
 * doet de terugknop wat hij op elke startpagina doet: de app wegzetten.
 *
 * Waarom we niet bij elke druk op terug een nieuw item neerzetten (het
 * bekende trucje): Chrome slaat items over die een pagina toevoegt zonder dat
 * iemand op het scherm tikte. Dat is tegen sites die de terugknop kapen. Na
 * een stap terug telt een eerdere tik bovendien niet meer mee, tot er een
 * nieuwe komt. Een item dat we als antwoord op een druk op terug toevoegen,
 * sloeg Chrome dus over, en de tweede druk sloot alsnog de app. Daarom zetten
 * we items alleen neer als er sinds de laatste stap terug getikt is (honored),
 * en anders bij de eerstvolgende tik.
 *
 * Puur, zonder React, en met het venster als argument: zo draait
 * backButton.test.ts er met `node --test` overheen.
 */

/** Onder deze sleutel staat in history.state op welke stap een item staat. */
export const BACK_MARKER = 'resoflyBack';

/** Zo lang wachten we op de browser na history.go() voordat we opnieuw meten. */
const TRAVERSE_TIMEOUT_MS = 1500;
/**
 * Zo lang wachten we voordat we een item weghalen. Een menu dat sluit bij het
 * indrukken van de muis, en een klik die daarna een pagina opent, zijn op een
 * computer twee aparte gebeurtenissen. Haalden we het item van het menu meteen
 * weg, dan telde de klik daarna voor Chrome niet meer als tik (zie hierboven):
 * de nieuwe pagina kreeg geen item, en terug sloeg hem over.
 */
const TRAVERSE_DELAY_MS = 250;
/** Na herladen laadt de browser het begin opnieuw; dat mag langer duren. */
const RELOAD_TIMEOUT_MS = 8000;

/** Het deel van `window` dat de terugknop gebruikt. */
export type BackWindow = {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string): void;
    replaceState(data: unknown, unused: string): void;
    go(delta: number): void;
  };
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(id: number): void;
};

/** Doet de stap(pen) terug. `steps` is bijna altijd 1. */
export type BackHandler = (steps: number) => void;

type Layer = { seq: number; steps: number; onBack: BackHandler };

export type BackButton = ReturnType<typeof createBackButton>;

/** Leest de stap uit history.state, of null als het item niet van ons is. */
export function readBackMarker(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[BACK_MARKER];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Telt deze gebeurtenis als een tik of toets van iemand (user activation)? */
function isActivation(event: Event): boolean {
  if (!event.isTrusted) return false;
  switch (event.type) {
    case 'keydown': return (event as KeyboardEvent).key !== 'Escape';
    case 'mousedown': return true;
    case 'pointerdown': return (event as PointerEvent).pointerType === 'mouse';
    case 'pointerup': return (event as PointerEvent).pointerType !== 'mouse';
    case 'touchend': return true;
    default: return false;
  }
}

const ACTIVATION_EVENTS = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'];

export function createBackButton(win: BackWindow) {
  const layers = new Map<number, Layer>();
  let base: { steps: number; back: BackHandler } = { steps: 0, back: () => {} };
  let started = false;
  /** Staat de werkruimte in beeld? Zo niet, dan is er niets om naar terug te gaan. */
  let enabled = false;
  /** Op welk item van ons we staan: 0 is het begin. */
  let depth = 0;
  /** Een history.go() van ons die nog loopt. */
  let pending: { target: number; timer: number } | null = null;
  /** Is er getikt sinds de laatste stap terug? Alleen dan telt Chrome een nieuw item mee. */
  let honored = false;
  let syncTimer: number | null = null;
  let traverseTimer: number | null = null;
  let layerIds = 0;
  let seqs = 0;

  /** Hoeveel stappen terug er nu zijn, en dus hoeveel items er hoort te staan. */
  function wanted(): number {
    if (!enabled) return 0;
    let total = base.steps;
    for (const layer of layers.values()) total += layer.steps;
    return total;
  }

  function marker(step: number): Record<string, number> {
    return { [BACK_MARKER]: step };
  }

  /** Zet het huidige item op `step`, met behoud van wat er verder in history.state stond. */
  function markCurrent(step: number) {
    const state = win.history.state;
    const rest = state && typeof state === 'object' ? state as Record<string, unknown> : {};
    try { win.history.replaceState({ ...rest, [BACK_MARKER]: step }, ''); } catch { /* sandbox zonder history: dan niets */ }
  }

  function push(target: number) {
    while (depth < target) {
      try {
        win.history.pushState(marker(depth + 1), '');
      } catch {
        return;
      }
      depth += 1;
    }
  }

  function traverse(target: number, timeout = TRAVERSE_TIMEOUT_MS) {
    const delta = target - depth;
    // history.go(0) herlaadt de pagina.
    if (delta === 0) return;
    pending = { target, timer: win.setTimeout(onTraverseTimeout, timeout) };
    try {
      win.history.go(delta);
    } catch {
      win.clearTimeout(pending.timer);
      pending = null;
    }
  }

  /**
   * De browser ging niet terug (er waren minder items dan we dachten, of hij
   * weigerde). Dan is waar we nu staan het nieuwe begin; ontbrekende items
   * zetten we bij de volgende tik opnieuw neer. Zonder dit bleven we elke
   * anderhalve seconde opnieuw proberen.
   */
  function onTraverseTimeout() {
    pending = null;
    depth = 0;
    markCurrent(0);
    schedule();
  }

  /** Brengt het aantal items in lijn met het aantal stappen. */
  function sync() {
    syncTimer = null;
    if (!started || pending) return;
    const want = wanted();
    if (want > depth) {
      if (honored) push(want);
    } else if (want < depth && traverseTimer === null) {
      traverseTimer = win.setTimeout(() => {
        traverseTimer = null;
        if (started && !pending && wanted() < depth) traverse(wanted());
      }, TRAVERSE_DELAY_MS);
    }
  }

  /**
   * Na de huidige taak, zodat een venster dat sluit en een pagina die opent
   * in dezelfde klik tegen elkaar wegvallen in plaats van een stap terug en
   * een nieuw item te geven.
   */
  function schedule() {
    if (syncTimer !== null) return;
    syncTimer = win.setTimeout(sync, 0);
  }

  /** Doet de bovenste `steps` stappen: eerst vensters (laatst geopend eerst), dan de basis. */
  function undo(steps: number) {
    let remaining = steps;
    const ordered = [...layers.values()].sort((a, b) => b.seq - a.seq);
    for (const layer of ordered) {
      if (remaining <= 0) break;
      const take = Math.min(layer.steps, remaining);
      if (take <= 0) continue;
      remaining -= take;
      try { layer.onBack(take); } catch (error) { console.error('Terug lukte niet', error); }
    }
    if (remaining > 0 && base.steps > 0) {
      try { base.back(Math.min(remaining, base.steps)); } catch (error) { console.error('Terug lukte niet', error); }
    }
  }

  function onPopState(event: Event) {
    // Een stap terug: een eerdere tik telt voor Chrome niet meer mee.
    honored = false;
    const found = readBackMarker((event as PopStateEvent).state);
    if (pending) {
      // Ons eigen history.go(): alleen bijhouden waar we staan.
      win.clearTimeout(pending.timer);
      depth = found ?? pending.target;
      pending = null;
      schedule();
      return;
    }
    // Een item zonder ons merk (iets anders heeft history.state gewist): reken
    // het als één stap terug, en merk het opnieuw.
    const target = found ?? Math.max(0, depth - 1);
    if (found === null) markCurrent(target);
    const steps = depth - target;
    depth = target;
    // Vooruit (alleen op een computer) maken we niet na: sync gaat weer terug.
    if (steps > 0 && enabled) undo(steps);
    schedule();
  }

  function onActivation(event: Event) {
    if (!isActivation(event)) return;
    honored = true;
    // Items die op een tik wachtten, nu neerzetten: binnen de tik telt Chrome ze mee.
    if (started && !pending && wanted() > depth) push(wanted());
  }

  let listening = false;
  function listen() {
    if (listening) return;
    listening = true;
    win.addEventListener('popstate', onPopState);
    for (const type of ACTIVATION_EVENTS) win.addEventListener(type, onActivation, { capture: true, passive: true });
  }

  return {
    /**
     * Herladen midden in de app (of Android haalde de app terug nadat hij hem
     * had gestopt): dan staan we op een item van de vorige keer, en horen de
     * items eronder bij een document dat er niet meer is. Terug naar zo'n item
     * laadt de app opnieuw, bij elke druk. Daarom meteen terug naar het begin:
     * één keer extra laden, en daarna klopt het weer. Zo vroeg mogelijk
     * aanroepen, vóór React, zodat er nog niets geladen wordt dat we weggooien.
     */
    returnToStartAfterReload() {
      const found = readBackMarker(win.history.state);
      if (!found || pending) return;
      listen();
      depth = found;
      traverse(0, RELOAD_TIMEOUT_MS);
    },

    /** Begint met luisteren. Eén keer per laadbeurt; vaker aanroepen doet niets. */
    start() {
      if (started) return;
      started = true;
      listen();
      // Al onderweg naar het begin (returnToStartAfterReload): daarop wachten.
      if (pending) return;
      const found = readBackMarker(win.history.state);
      if (found) {
        depth = found;
        traverse(0, RELOAD_TIMEOUT_MS);
      } else {
        depth = 0;
        markCurrent(0);
      }
      schedule();
    },

    /** Staat de werkruimte in beeld? Zonder werkruimte geen stappen. */
    setEnabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      schedule();
    },

    /** De pagina's van het werktabblad: hoeveel stappen, en hoe je ze terug doet. */
    setBase(steps: number, back: BackHandler) {
      const changed = steps !== base.steps;
      base = { steps: Math.max(0, steps), back };
      if (changed) schedule();
    },

    /** Volgnummer voor een nieuw venster: hoe hoger, hoe eerder terug het sluit. */
    nextSeq(): number {
      seqs += 1;
      return seqs;
    },

    /** Een venster (of ander scherm) dat met terug dicht kan. Geeft de opruimfunctie. */
    addLayer(seq: number, steps: number, onBack: BackHandler): () => void {
      layerIds += 1;
      const id = layerIds;
      layers.set(id, { seq, steps: Math.max(0, steps), onBack });
      schedule();
      return () => {
        if (layers.delete(id)) schedule();
      };
    },

    /** Voor de tests: waar we staan en wat we willen. */
    inspect() {
      return { depth, wanted: wanted(), pending: pending?.target ?? null, honored, layers: layers.size, base: base.steps };
    },
  };
}

let shared: BackButton | null = null;

/** De terugknop van deze laadbeurt. */
export function backButton(): BackButton {
  if (!shared) shared = createBackButton(window as unknown as BackWindow);
  return shared;
}
