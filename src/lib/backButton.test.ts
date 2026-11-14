/**
 * Tests voor de terugknop (backButton.ts). Draaien met:  npm test
 *
 * Een nagebootste browser: een rij items met een plek erin, pushState kapt
 * alles na de plek af, en history.go() komt pas later aan, net als in een
 * echte browser. Een druk op de terugknop van de telefoon is `pressBack`:
 * staat de browser op het eerste item, dan gaat de app dicht ('weg').
 *
 * Wat hier vast moet blijven: per stap in de app precies één item, en een
 * item alleen neerzetten na een tik. Een item dat Chrome zonder tik ziet
 * verschijnen, slaat hij over: dan ging de app bij de tweede druk alsnog weg.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACK_MARKER, createBackButton, readBackMarker, type BackWindow } from './backButton.ts';

type Listener = (event: Event) => void;

function fakeBrowser(initialState: unknown = null) {
  const entries: unknown[] = [initialState];
  let index = 0;
  let now = 0;
  let timerIds = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const listeners = new Map<string, Set<Listener>>();
  const traversals: number[] = [];
  /** Wat de app met history deed, in volgorde. */
  const log: string[] = [];

  function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const event = { type, isTrusted: true, ...extra } as unknown as Event;
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  const win: BackWindow = {
    history: {
      get state() { return entries[index]; },
      pushState(data: unknown) {
        entries.splice(index + 1);
        entries.push(structuredClone(data));
        index += 1;
        log.push('push');
      },
      replaceState(data: unknown) {
        entries[index] = structuredClone(data);
      },
      go(delta: number) {
        traversals.push(delta);
        log.push(`go(${delta})`);
      },
    },
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    setTimeout(fn: () => void, ms = 0) {
      timerIds += 1;
      timers.set(timerIds, { due: now + ms, fn });
      return timerIds;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };

  /** Laat de klok lopen en voert wat er dan aan de beurt is uit, ook timers die timers zetten. */
  function tick(ms = 0) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].due);
      next[1].fn();
    }
    now = until;
  }

  /** De browser voert een history.go() uit, zoals hij dat even later doet. */
  function arrive() {
    while (traversals.length) {
      const target = index + traversals.shift()!;
      if (target < 0 || target >= entries.length) continue;
      index = target;
      dispatch('popstate', { state: entries[index] });
    }
  }

  /** Alles laten bezinken: korte timers (ook de wachttijd vóór een stap terug) en history.go(). */
  function settle() {
    for (let round = 0; round < 20; round += 1) {
      tick(300);
      if (!traversals.length) return;
      arrive();
    }
  }

  return {
    win,
    log,
    entries,
    get index() { return index; },
    tick,
    arrive,
    settle,
    /** Een tik op het scherm (touch): telt als user activation. */
    tap() { dispatch('pointerup', { pointerType: 'touch' }); },
    /** De terugknop van Android. */
    pressBack(): 'terug' | 'weg' {
      if (index === 0) return 'weg';
      index -= 1;
      dispatch('popstate', { state: entries[index] });
      return 'terug';
    },
    /** De vooruitknop van een computer. */
    pressForward() {
      if (index >= entries.length - 1) return;
      index += 1;
      dispatch('popstate', { state: entries[index] });
    },
  };
}

/** Een venster zoals useBackStep het aanmeldt: open tot iemand het sluit. */
function layer(button: ReturnType<typeof createBackButton>, steps = 1) {
  let remove: (() => void) | null = null;
  const closed: number[] = [];
  const handle = {
    closed,
    open() {
      remove = button.addLayer(button.nextSeq(), steps, (n) => { closed.push(n); handle.close(); });
      return handle;
    },
    close() { remove?.(); remove = null; },
  };
  return handle;
}

function started(initialState: unknown = null) {
  const browser = fakeBrowser(initialState);
  const button = createBackButton(browser.win);
  button.start();
  button.setEnabled(true);
  browser.settle();
  return { browser, button };
}

test('bij de start krijgt het huidige item stap 0, en blijft wat er al in history.state stond', () => {
  const { browser } = started({ andere: 'waarde' });
  assert.deepEqual(browser.entries, [{ andere: 'waarde', [BACK_MARKER]: 0 }]);
  assert.equal(readBackMarker(browser.entries[0]), 0);
});

test('een venster na een tik: één item; terug sluit het venster in plaats van de app', () => {
  const { browser, button } = started();
  browser.tap();
  const modal = layer(button).open();
  browser.settle();
  assert.equal(browser.entries.length, 2);
  assert.equal(browser.pressBack(), 'terug');
  browser.settle();
  assert.deepEqual(modal.closed, [1]);
  assert.equal(button.inspect().depth, 0);
  // Niets meer om naar terug te gaan: de volgende druk zet de app weg.
  assert.equal(browser.pressBack(), 'weg');
});

test('dicht met de knop in beeld: het item gaat weg, zonder dat er iets anders terug gaat', () => {
  const { browser, button } = started();
  browser.tap();
  const modal = layer(button).open();
  browser.settle();
  modal.close();
  browser.settle();
  assert.equal(browser.index, 0);
  assert.deepEqual(modal.closed, []);
  assert.deepEqual(browser.log, ['push', 'go(-1)']);
  assert.equal(browser.pressBack(), 'weg');
});

test('zonder tik geen item: dat wacht tot de volgende tik (Chrome zou het overslaan)', () => {
  const { browser, button } = started();
  layer(button).open();
  browser.settle();
  assert.equal(browser.entries.length, 1);
  browser.tap();
  assert.equal(browser.entries.length, 2, 'binnen de tik neergezet');
});

test('na een druk op terug telt een eerdere tik niet meer: een nieuw venster wacht op een nieuwe tik', () => {
  const { browser, button } = started();
  browser.tap();
  layer(button).open();
  browser.settle();
  browser.pressBack();
  browser.settle();
  // Een melding opent vanzelf een venster, zonder dat er getikt is.
  layer(button).open();
  browser.settle();
  assert.equal(browser.index, 0, 'geen item zonder nieuwe tik');
  browser.tap();
  assert.equal(browser.index, 1);
});

test('sluiten en openen in dezelfde klik vallen tegen elkaar weg', () => {
  const { browser, button } = started();
  browser.tap();
  const menu = layer(button).open();
  browser.settle();
  browser.log.length = 0;
  // Het menu sluit en een venster opent in dezelfde klik.
  browser.tap();
  menu.close();
  const modal = layer(button).open();
  browser.settle();
  assert.deepEqual(browser.log, [], 'geen stap terug en geen nieuw item');
  browser.pressBack();
  browser.settle();
  assert.deepEqual(modal.closed, [1]);
  assert.deepEqual(menu.closed, []);
});

test('een menu dat sluit bij het indrukken van de muis, en een klik die daarna een pagina opent', () => {
  // Op een computer zijn dat twee gebeurtenissen, een tiende seconde uit elkaar.
  const { browser, button } = started();
  let steps = 0;
  const back = (n: number) => { steps -= n; button.setBase(steps, back); };
  browser.tap();
  const menu = layer(button).open();
  browser.settle();
  assert.equal(browser.index, 1);
  browser.log.length = 0;
  menu.close();
  browser.tick(100);
  steps = 1;
  button.setBase(steps, back);
  browser.settle();
  assert.deepEqual(browser.log, [], 'het item van het menu is nu dat van de pagina');
  assert.equal(button.inspect().depth, 1);
  browser.pressBack();
  browser.settle();
  assert.equal(steps, 0);
  assert.equal(browser.pressBack(), 'weg');
});

test('dicht met de knop en meteen op terug: dan gaat de pagina terug', () => {
  const { browser, button } = started();
  let steps = 0;
  const pages: number[] = [];
  const back = (n: number) => { pages.push(n); steps -= n; button.setBase(steps, back); };
  browser.tap();
  steps = 1;
  button.setBase(steps, back);
  const modal = layer(button).open();
  browser.settle();
  modal.close();
  browser.tick(0);
  // Binnen de wachttijd: het item van het venster staat er nog.
  browser.pressBack();
  browser.settle();
  assert.deepEqual(pages, [1]);
  assert.equal(browser.index, 0);
  assert.equal(button.inspect().depth, 0);
});

test('het laatst geopende venster sluit als eerste, de pagina’s pas daarna', () => {
  const { browser, button } = started();
  const pages: number[] = [];
  let pageSteps = 1;
  const back = (n: number) => { pages.push(n); pageSteps -= n; button.setBase(pageSteps, back); };
  browser.tap();
  button.setBase(pageSteps, back);
  const first = layer(button).open();
  const second = layer(button).open();
  browser.settle();
  assert.equal(browser.index, 3);

  browser.pressBack(); browser.settle();
  assert.deepEqual([first.closed, second.closed, pages], [[], [1], []]);
  browser.pressBack(); browser.settle();
  assert.deepEqual([first.closed, second.closed, pages], [[1], [1], []]);
  browser.pressBack(); browser.settle();
  assert.deepEqual(pages, [1]);
  assert.equal(browser.index, 0);
  assert.equal(browser.pressBack(), 'weg');
});

test('door pagina’s terug: elke druk één pagina, zonder nieuwe items onderweg', () => {
  const { browser, button } = started();
  let steps = 0;
  const visited: number[] = [];
  const back = (n: number) => { visited.push(n); steps -= n; button.setBase(steps, back); };
  // Drie keer navigeren, telkens na een tik.
  for (let i = 0; i < 3; i += 1) {
    browser.tap();
    steps += 1;
    button.setBase(steps, back);
    browser.settle();
  }
  assert.equal(browser.index, 3);
  browser.log.length = 0;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(browser.pressBack(), 'terug');
    browser.settle();
  }
  assert.deepEqual(visited, [1, 1, 1]);
  assert.deepEqual(browser.log, [], 'terug zet geen items neer en haalt er geen weg');
  assert.equal(browser.pressBack(), 'weg');
});

test('vooruit (op een computer) doen we niet na: de app gaat weer terug', () => {
  const { browser, button } = started();
  browser.tap();
  const modal = layer(button).open();
  browser.settle();
  browser.pressBack();
  browser.settle();
  assert.deepEqual(modal.closed, [1]);
  browser.pressForward();
  browser.settle();
  assert.equal(browser.index, 0);
  assert.equal(button.inspect().depth, 0);
});

test('een item waarvan iets anders history.state wiste, telt als één stap terug', () => {
  const { browser, button } = started();
  let steps = 0;
  const visited: number[] = [];
  const back = (n: number) => { visited.push(n); steps -= n; button.setBase(steps, back); };
  browser.tap();
  steps = 2;
  button.setBase(steps, back);
  browser.settle();
  browser.pressBack();
  browser.settle();
  // Op het middelste item wist iets history.state, bijvoorbeeld
  // replaceState(null, '', '#ergens'). Daarna weer een pagina verder.
  browser.win.history.replaceState(null, '');
  browser.tap();
  steps += 1;
  button.setBase(steps, back);
  browser.settle();
  assert.equal(browser.index, 2);
  browser.pressBack();
  browser.settle();
  assert.deepEqual(visited, [1, 1]);
  assert.equal(readBackMarker(browser.entries[1]), 1, 'opnieuw gemerkt');
  assert.equal(button.inspect().depth, 1);
});

test('een venster dat meer stappen telt (een map diep in mappen): één stap per druk', () => {
  const { browser, button } = started();
  let depth = 2;
  const ups: number[] = [];
  let remove = () => {};
  const register = () => { remove(); remove = depth > 0 ? button.addLayer(1, depth, (n) => { ups.push(n); depth -= n; register(); }) : () => {}; };
  browser.tap();
  register();
  browser.settle();
  assert.equal(browser.index, 2);
  browser.pressBack(); browser.settle();
  browser.pressBack(); browser.settle();
  assert.deepEqual(ups, [1, 1]);
  assert.equal(browser.pressBack(), 'weg');
});

test('zonder werkruimte in beeld geen stappen: de items gaan weg', () => {
  const { browser, button } = started();
  browser.tap();
  layer(button).open();
  browser.settle();
  button.setEnabled(false);
  browser.settle();
  assert.equal(browser.index, 0);
  button.setEnabled(true);
  browser.settle();
  assert.equal(browser.index, 0, 'pas weer na een tik');
  browser.tap();
  assert.equal(browser.index, 1);
});

test('herladen midden in de app: eerst terug naar het begin, daarna klopt het weer', () => {
  // De pagina werd herladen op het derde item van de vorige keer.
  const browser = fakeBrowser({ [BACK_MARKER]: 0 });
  browser.win.history.pushState({ [BACK_MARKER]: 1 }, '');
  browser.win.history.pushState({ [BACK_MARKER]: 2 }, '');
  browser.log.length = 0;
  const button = createBackButton(browser.win);
  button.returnToStartAfterReload();
  assert.deepEqual(browser.log, ['go(-2)']);
  // React start de werkruimte terwijl de browser nog onderweg is: geen tweede go().
  button.start();
  button.setEnabled(true);
  browser.settle();
  assert.deepEqual(browser.log, ['go(-2)']);
  assert.equal(browser.index, 0);
  assert.equal(button.inspect().depth, 0);
  browser.tap();
  const modal = layer(button).open();
  browser.settle();
  browser.pressBack();
  browser.settle();
  assert.deepEqual(modal.closed, [1]);
});

test('gaat de browser niet terug, dan is de plek waar we staan het nieuwe begin', () => {
  const browser = fakeBrowser({ [BACK_MARKER]: 3 });
  const button = createBackButton(browser.win);
  button.start();
  button.setEnabled(true);
  // go(-3) kan niet: er is maar één item. Na de wachttijd opnieuw beginnen.
  browser.settle();
  assert.equal(button.inspect().pending, 0);
  browser.tick(10_000);
  assert.equal(button.inspect().pending, null);
  assert.equal(button.inspect().depth, 0);
  assert.equal(readBackMarker(browser.entries[0]), 0);
  browser.tap();
  layer(button).open();
  browser.settle();
  assert.equal(browser.index, 1);
});

test('een druk op terug terwijl onze eigen stap terug nog onderweg is, telt gewoon mee', () => {
  const { browser, button } = started();
  let steps = 1;
  const pages: number[] = [];
  const back = (n: number) => { pages.push(n); steps -= n; button.setBase(steps, back); };
  browser.tap();
  button.setBase(steps, back);
  const modal = layer(button).open();
  browser.settle();
  assert.equal(browser.index, 2);
  // Venster dicht met de knop: go(-1) staat klaar, maar is er nog niet.
  modal.close();
  browser.tick(300);
  assert.equal(button.inspect().pending, 1);
  // En vóór die aankomt drukt iemand op terug.
  browser.pressBack();
  browser.arrive();
  browser.settle();
  assert.deepEqual(pages, [1]);
  assert.equal(browser.index, 0);
  assert.equal(button.inspect().depth, 0);
});
