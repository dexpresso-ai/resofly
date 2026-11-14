// Schermafbeeldingen tegengaan op de deellinkpagina van een album
// (/gallerij/<token>).
//
// Een webpagina kan een schermafbeelding niet verbieden. De toetsen en knoppen
// daarvoor horen bij het besturingssysteem, en op een telefoon krijgt de
// pagina er niets van mee. Wat wel kan: het beeld weghalen op de momenten die
// aan een opname voorafgaan, en de makkelijke routes dichtzetten.
//
// - Cmd+Shift (Mac: Cmd+Shift+3, 4 of 5), Windows-toets+Shift (Win+Shift+S) en
//   Ctrl+Shift (Chromebook). De pagina ziet die toetsen vóór de cijfer- of
//   lettertoets. Als die valt, zijn de foto's dus al weg.
// - Print Screen. Windows meldt de pagina alleen het loslaten, en dan is de
//   opname al gemaakt. We wissen dan het klembord (lukt in Chrome en Edge) en
//   verbergen het beeld even.
// - Het venster verliest de focus. Dat gebeurt als het knipprogramma van
//   Windows of de schermafbeeldingsbalk van macOS opent, of een ander
//   programma met een timer. De foto's blijven weg tot je terugkomt.
// - Rechtsklik ("Afbeelding opslaan"), slepen naar het bureaublad, lang drukken
//   op een telefoon, Ctrl+S en afdrukken gaan niet.
//
// Wat hier niet tegen helpt: de knoppen van een telefoon, een camera op het
// scherm, of iemand die de ontwikkelaarstools gebruikt. Wie dat wil
// tegenhouden, heeft een watermerk nodig.

/** De velden van een toetsaanslag (of muisbeweging) die we lezen. */
export type GuardKey = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
};

/** Print Screen, zoals browsers hem melden. */
export function isPrintScreen(e: GuardKey): boolean {
  return e.key === 'PrintScreen' || e.code === 'PrintScreen';
}

/**
 * Houdt iemand de toetsen vast waarmee een schermafbeelding begint? Shift
 * samen met Cmd/Windows-toets of met Ctrl.
 *
 * De ingedrukte toets zelf telt mee, ook als zijn vlag nog niet aan staat:
 * Firefox op Windows zette metaKey niet voor de Windows-toets, en die heette
 * daar tot versie 118 `OS` in plaats van `Meta`.
 */
export function isScreenshotChord(e: GuardKey): boolean {
  const meta = Boolean(e.metaKey) || e.key === 'Meta' || e.key === 'OS';
  const ctrl = Boolean(e.ctrlKey) || e.key === 'Control';
  const shift = Boolean(e.shiftKey) || e.key === 'Shift';
  return shift && (meta || ctrl);
}

/** Ctrl/Cmd+P (afdrukken) en Ctrl/Cmd+S (pagina opslaan, met de foto's erbij). */
export function isSaveOrPrint(e: GuardKey): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  const key = (e.key || '').toLowerCase();
  return key === 'p' || key === 's';
}

/** Een veld waarin je typt: daar blijven rechtsklik en plakken gewoon werken. */
export function isEditable(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el !== 'object') return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Op <body> zolang de pagina beschermd is: de CSS hangt eraan (afdrukken, slepen, lang drukken). */
export const PROTECTED_CLASS = 'pgal-protected';
/** Op <body> zolang de foto's verborgen zijn. */
export const SHIELDED_CLASS = 'pgal-shielded';

/** Zo lang blijft het beeld weg na Print Screen. */
export const PRINT_SCREEN_HIDE_MS = 1500;
/**
 * Zo lang blijft het beeld weg na het loslaten van Cmd+Shift of Win+Shift.
 * De opname valt bij het indrukken, maar een knipprogramma dat even nodig
 * heeft om te starten, moet ook nog niets zien.
 */
export const CHORD_RELEASE_MS = 500;

type GuardOptions = {
  clipboard?: { writeText(text: string): Promise<void> } | null;
};

/**
 * Zet de bescherming aan op deze pagina. Geeft een functie terug die alles
 * weer opruimt (bij het verlaten van de pagina).
 *
 * Het verbergen loopt via een klasse op <body>, rechtstreeks in de handler en
 * niet via React-state. Zo staat het in de eerstvolgende frame, vóór de
 * cijfertoets van Cmd+Shift+3 valt.
 */
export function installScreenshotGuard(win: Window, doc: Document, options: GuardOptions = {}): () => void {
  const body = doc.body;
  const clipboard = options.clipboard === undefined
    ? (win.navigator?.clipboard ?? null)
    : options.clipboard;

  let chordHeld = false;
  let blurred = doc.visibilityState === 'hidden';
  let flashUntil = 0;
  let releaseTimer: number | null = null;
  let flashTimer: number | null = null;

  const update = () => {
    const shielded = chordHeld || blurred || Date.now() < flashUntil;
    body.classList.toggle(SHIELDED_CLASS, shielded);
  };

  const holdChord = () => {
    if (releaseTimer !== null) { win.clearTimeout(releaseTimer); releaseTimer = null; }
    chordHeld = true;
    update();
  };

  const releaseChord = () => {
    if (!chordHeld || releaseTimer !== null) return;
    releaseTimer = win.setTimeout(() => {
      releaseTimer = null;
      chordHeld = false;
      update();
    }, CHORD_RELEASE_MS);
  };

  const flash = () => {
    flashUntil = Date.now() + PRINT_SCREEN_HIDE_MS;
    update();
    if (flashTimer !== null) win.clearTimeout(flashTimer);
    flashTimer = win.setTimeout(() => { flashTimer = null; update(); }, PRINT_SCREEN_HIDE_MS + 20);
    // Wat Print Screen op het klembord zette, overschrijven. Firefox en Safari
    // staan dat zonder klik niet toe; dan blijft het bij verbergen.
    try {
      void clipboard?.writeText('').catch(() => undefined);
    } catch {
      /* geen klembord: niets te wissen */
    }
  };

  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (isPrintScreen(e)) { flash(); return; }
    if (isScreenshotChord(e)) { holdChord(); return; }
    if (isSaveOrPrint(e)) { e.preventDefault(); return; }
  };

  const onKeyUp = (event: Event) => {
    const e = event as KeyboardEvent;
    if (isPrintScreen(e)) { flash(); return; }
    // Na het loslaten zeggen de vlaggen welke toetsen nog vast zitten. De
    // losgelaten toets zelf staat er niet meer in.
    const stillHeld = Boolean(e.shiftKey) && (Boolean(e.metaKey) || Boolean(e.ctrlKey));
    if (!stillHeld) releaseChord();
  };

  const onPointer = (event: Event) => {
    const e = event as PointerEvent;
    // Een klik of tik op de pagina: de bezoeker is terug. Daar wachten we niet
    // op een focus-event: niet elke browser stuurt dat na het wisselen van
    // app, en zonder dit bleef de melding dan staan tot de volgende blur.
    if (e.type === 'pointerdown' && blurred) {
      blurred = false;
      update();
    }
    // Viel het loslaten van Cmd+Shift weg (de schermafbeeldingsbalk van macOS
    // vangt de toetsen op), dan bleef het beeld weg. Een muisbeweging of tik
    // draagt de stand van de toetsen mee; daaraan zien we dat ze los zijn.
    if (chordHeld && !(e.shiftKey && (e.metaKey || e.ctrlKey))) releaseChord();
  };

  const focusInFrame = () => String(doc.activeElement?.tagName || '').toUpperCase() === 'IFRAME';

  const onBlur = () => {
    // Klikken in de videospeler (een iframe van Cloudflare Stream) haalt de
    // focus ook weg bij het venster. Dat is kijken, geen schermafbeelding.
    if (focusInFrame()) return;
    blurred = true;
    update();
    // In sommige browsers staat het iframe pas na de blur als actief element.
    win.setTimeout(() => {
      if (blurred && focusInFrame()) { blurred = false; update(); }
    }, 0);
  };

  const onFocus = () => {
    blurred = false;
    update();
  };

  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      blurred = true;
    } else if (doc.hasFocus()) {
      blurred = false;
    }
    update();
  };

  const onContextMenu = (event: Event) => {
    if (!isEditable(event.target)) event.preventDefault();
  };

  const onDragStart = (event: Event) => {
    if (!isEditable(event.target)) event.preventDefault();
  };

  body.classList.add(PROTECTED_CLASS);
  update();

  // In de capture-fase: dan zien we de toets ook als iets in de pagina (de
  // viewer, een veld) hem daarna voor zichzelf houdt met stopPropagation.
  // Als object en niet als losse `true`: de EventTarget van Node (de tests)
  // haalde een luisteraar met `true` niet weg bij het opruimen.
  const capture = { capture: true };
  win.addEventListener('keydown', onKeyDown, capture);
  win.addEventListener('keyup', onKeyUp, capture);
  win.addEventListener('pointermove', onPointer, capture);
  win.addEventListener('pointerdown', onPointer, capture);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('contextmenu', onContextMenu, capture);
  doc.addEventListener('dragstart', onDragStart, capture);

  return () => {
    win.removeEventListener('keydown', onKeyDown, capture);
    win.removeEventListener('keyup', onKeyUp, capture);
    win.removeEventListener('pointermove', onPointer, capture);
    win.removeEventListener('pointerdown', onPointer, capture);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('contextmenu', onContextMenu, capture);
    doc.removeEventListener('dragstart', onDragStart, capture);
    if (releaseTimer !== null) win.clearTimeout(releaseTimer);
    if (flashTimer !== null) win.clearTimeout(flashTimer);
    body.classList.remove(PROTECTED_CLASS, SHIELDED_CLASS);
  };
}
