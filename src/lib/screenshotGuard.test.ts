/**
 * Tests voor de bescherming tegen schermafbeeldingen op de deellinkpagina van
 * een album. Draaien met:  npm test
 *
 * Een nagebootst venster en document (EventTarget van Node) met een eigen
 * klok: zo zien we per toetsaanslag of de foto's verborgen zijn.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORD_RELEASE_MS,
  PRINT_SCREEN_HIDE_MS,
  PROTECTED_CLASS,
  SHIELDED_CLASS,
  installScreenshotGuard,
  isEditable,
  isPrintScreen,
  isSaveOrPrint,
  isScreenshotChord,
} from './screenshotGuard.ts';

test('de toetsen waarmee een schermafbeelding begint', () => {
  // Mac: Cmd+Shift+3/4/5. Bij het indrukken van Shift staat shiftKey al aan.
  assert.equal(isScreenshotChord({ key: 'Shift', metaKey: true, shiftKey: true }), true);
  assert.equal(isScreenshotChord({ key: 'Meta', metaKey: true, shiftKey: true }), true);
  // Firefox op Windows: de Windows-toets heette `OS` en zette metaKey niet.
  assert.equal(isScreenshotChord({ key: 'OS', shiftKey: true }), true);
  assert.equal(isScreenshotChord({ key: 'Shift', shiftKey: false, metaKey: true }), true);
  // Chromebook: Ctrl+Shift.
  assert.equal(isScreenshotChord({ key: 'Control', shiftKey: true }), true);
  // Gewoon typen, of één modificatietoets: niets aan de hand.
  assert.equal(isScreenshotChord({ key: 'A', shiftKey: true }), false);
  assert.equal(isScreenshotChord({ key: 'Meta', metaKey: true }), false);
  assert.equal(isScreenshotChord({ key: 'c', ctrlKey: true }), false);

  assert.equal(isPrintScreen({ key: 'PrintScreen' }), true);
  assert.equal(isPrintScreen({ key: 'Unidentified', code: 'PrintScreen' }), true);
  assert.equal(isPrintScreen({ key: 'p' }), false);

  assert.equal(isSaveOrPrint({ key: 'p', ctrlKey: true }), true);
  assert.equal(isSaveOrPrint({ key: 's', metaKey: true }), true);
  assert.equal(isSaveOrPrint({ key: 'p' }), false);
  assert.equal(isSaveOrPrint({ key: 'c', ctrlKey: true }), false);
});

test('velden blijven gewoon bruikbaar', () => {
  assert.equal(isEditable({ tagName: 'INPUT' }), true);
  assert.equal(isEditable({ tagName: 'textarea' }), true);
  assert.equal(isEditable({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditable({ tagName: 'IMG' }), false);
  assert.equal(isEditable(null), false);
});

/** Een venster en document met precies wat de bescherming gebruikt. */
function fakePage() {
  const classes = new Set<string>();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  const writes: string[] = [];
  win.setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
  win.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  doc.body = {
    classList: {
      add: (...names: string[]) => names.forEach(n => classes.add(n)),
      remove: (...names: string[]) => names.forEach(n => classes.delete(n)),
      toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); return on; },
    },
  };
  doc.activeElement = { tagName: 'BODY' };
  doc.visibilityState = 'visible';
  doc.hasFocus = () => true;
  const clipboard = { writeText: async (text: string) => { writes.push(text); } };
  const uninstall = installScreenshotGuard(win as unknown as Window, doc as unknown as Document, { clipboard });

  /** `on` = het element waarop het event begon (event.target), zoals de browser dat invult. */
  const fire = (target: EventTarget, type: string, props: Record<string, unknown> = {}, on?: object) => {
    const event = Object.assign(new Event(type, { cancelable: true }), props);
    if (on) Object.defineProperty(event, 'target', { value: on });
    target.dispatchEvent(event);
    return event;
  };
  return {
    win, doc, writes, uninstall,
    shielded: () => classes.has(SHIELDED_CLASS),
    protectedPage: () => classes.has(PROTECTED_CLASS),
    key: (type: 'keydown' | 'keyup', props: Record<string, unknown>) => fire(win, type, props),
    fire,
  };
}

test('Cmd+Shift: de foto’s zijn weg zolang de toetsen vastzitten, en komen daarna terug', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const page = fakePage();
    assert.equal(page.protectedPage(), true);
    assert.equal(page.shielded(), false);

    page.key('keydown', { key: 'Meta', metaKey: true });
    assert.equal(page.shielded(), false, 'alleen Cmd: nog niets');
    page.key('keydown', { key: 'Shift', metaKey: true, shiftKey: true });
    assert.equal(page.shielded(), true, 'Cmd+Shift: meteen weg, vóór de 3 of de 4');
    page.key('keydown', { key: '4', metaKey: true, shiftKey: true });
    page.key('keyup', { key: '4', metaKey: true, shiftKey: true });
    assert.equal(page.shielded(), true, 'Cmd+Shift zit nog vast');

    page.key('keyup', { key: 'Shift', metaKey: true, shiftKey: false });
    mock.timers.tick(CHORD_RELEASE_MS - 1);
    assert.equal(page.shielded(), true, 'nog even weg na het loslaten');
    mock.timers.tick(2);
    assert.equal(page.shielded(), false);
    page.uninstall();
  } finally {
    mock.timers.reset();
  }
});

test('valt het loslaten weg, dan haalt een muisbeweging zonder toetsen de foto’s terug', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const page = fakePage();
    page.key('keydown', { key: 'Shift', metaKey: true, shiftKey: true });
    page.fire(page.win, 'pointermove', { metaKey: true, shiftKey: true });
    mock.timers.tick(CHORD_RELEASE_MS + 1);
    assert.equal(page.shielded(), true, 'toetsen nog vast: blijft weg');
    page.fire(page.win, 'pointermove', { metaKey: false, shiftKey: false });
    mock.timers.tick(CHORD_RELEASE_MS + 1);
    assert.equal(page.shielded(), false);
    page.uninstall();
  } finally {
    mock.timers.reset();
  }
});

test('Print Screen: beeld even weg en het klembord gewist', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const page = fakePage();
    // Windows meldt alleen het loslaten.
    page.key('keyup', { key: 'PrintScreen' });
    assert.equal(page.shielded(), true);
    assert.deepEqual(page.writes, ['']);
    mock.timers.tick(PRINT_SCREEN_HIDE_MS + 50);
    assert.equal(page.shielded(), false);
    page.uninstall();
  } finally {
    mock.timers.reset();
  }
});

test('venster kwijt (knipprogramma, ander programma): weg tot je terugkomt', () => {
  const page = fakePage();
  page.fire(page.win, 'blur');
  assert.equal(page.shielded(), true);
  page.fire(page.win, 'focus');
  assert.equal(page.shielded(), false);

  page.doc.visibilityState = 'hidden';
  page.fire(page.doc, 'visibilitychange');
  assert.equal(page.shielded(), true, 'ander tabblad of de app op de achtergrond');
  page.doc.visibilityState = 'visible';
  page.fire(page.doc, 'visibilitychange');
  assert.equal(page.shielded(), false);
  page.uninstall();
});

test('komt er na het wisselen van app geen focus-event, dan brengt een tik de foto’s terug', () => {
  const page = fakePage();
  page.fire(page.win, 'blur');
  assert.equal(page.shielded(), true);
  page.fire(page.win, 'pointerdown', { shiftKey: false, metaKey: false, ctrlKey: false });
  assert.equal(page.shielded(), false);
  page.uninstall();
});

test('klikken in de videospeler (iframe) verbergt niets', () => {
  const page = fakePage();
  page.doc.activeElement = { tagName: 'IFRAME' };
  page.fire(page.win, 'blur');
  assert.equal(page.shielded(), false);
  page.uninstall();
});

test('rechtsklik, slepen, Ctrl+P en Ctrl+S gaan niet; in een veld werkt rechtsklik wel', () => {
  const page = fakePage();
  const image = { tagName: 'IMG' };
  const field = { tagName: 'INPUT' };
  assert.equal(page.fire(page.doc, 'contextmenu', {}, image).defaultPrevented, true, 'Afbeelding opslaan');
  assert.equal(page.fire(page.doc, 'dragstart', {}, image).defaultPrevented, true, 'naar het bureaublad slepen');
  assert.equal(page.fire(page.doc, 'contextmenu', {}, field).defaultPrevented, false, 'plakken in de pincode');
  assert.equal(page.key('keydown', { key: 'p', ctrlKey: true }).defaultPrevented, true);
  assert.equal(page.key('keydown', { key: 's', metaKey: true }).defaultPrevented, true);
  assert.equal(page.key('keydown', { key: 'c', ctrlKey: true }).defaultPrevented, false);
  page.uninstall();
});

test('weg van de pagina: alle klassen en luisteraars weer weg', () => {
  const page = fakePage();
  page.fire(page.win, 'blur');
  page.uninstall();
  assert.equal(page.protectedPage(), false);
  assert.equal(page.shielded(), false);
  page.fire(page.win, 'blur');
  assert.equal(page.shielded(), false);
  assert.equal(page.fire(page.doc, 'contextmenu').defaultPrevented, false);
});
