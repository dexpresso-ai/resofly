// Volledig scherm, zonder de browservarianten door de rest van de app te slepen.
//
// Waarom dit bestaat: klanten bekijken hun galerij op de tv door hun telefoon of
// laptop te spiegelen. Wat de tv dan toont is letterlijk ons browservenster —
// inclusief adresbalk, tabbladen en bladwijzers. De Fullscreen API haalt precies
// die rand weg.
//
// Twee dingen zijn geen detail:
//  1. Safari op de iPhone kent GEEN element-fullscreen (alleen
//     `webkitEnterFullscreen` op een <video>). De aanvraag mislukt daar dus, en
//     dat mag de grootbeeldstand niet breken — vandaar dat niets hier gooit en
//     de aanroeper zijn eigen CSS-stand leidend houdt.
//  2. De browser verlaat volledig scherm buiten React om (Escape, F11, de knop
//     van de videospeler). Zonder `onFullscreenChange` loopt de stand van de
//     component uit de pas met wat er op het scherm gebeurt.

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FsDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
};

function doc(): FsDocument | null {
  return typeof document === 'undefined' ? null : (document as FsDocument);
}

/** Mag deze browser überhaupt een element schermvullend maken? */
export function fullscreenSupported(): boolean {
  const d = doc();
  if (!d) return false;
  return Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled);
}

/** Het element dat nu schermvullend is — of null. */
export function currentFullscreenElement(): Element | null {
  const d = doc();
  if (!d) return null;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * Vraag volledig scherm aan. Gooit nooit: de aanvraag kan legitiem mislukken
 * (iPhone, of buiten een gebruikersgebaar) en de aanroeper moet dan gewoon
 * doorgaan. `true` = het is gelukt.
 */
export async function enterFullscreen(el: HTMLElement | null): Promise<boolean> {
  if (!el) return false;
  const node = el as FsElement;
  try {
    if (node.requestFullscreen) await node.requestFullscreen();
    else if (node.webkitRequestFullscreen) await node.webkitRequestFullscreen();
    else return false;
  } catch {
    return false;
  }
  return currentFullscreenElement() === el;
}

/** Verlaat volledig scherm. Doet niets als er niets schermvullend is. */
export async function leaveFullscreen(): Promise<void> {
  const d = doc();
  if (!d || !currentFullscreenElement()) return;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
  } catch {
    /* al verlaten, of geweigerd — de aanroeper synct via onFullscreenChange */
  }
}

/** Luister op wisselingen; geeft de opruimfunctie terug. */
export function onFullscreenChange(callback: () => void): () => void {
  const d = doc();
  if (!d) return () => undefined;
  d.addEventListener('fullscreenchange', callback);
  d.addEventListener('webkitfullscreenchange', callback);
  return () => {
    d.removeEventListener('fullscreenchange', callback);
    d.removeEventListener('webkitfullscreenchange', callback);
  };
}
