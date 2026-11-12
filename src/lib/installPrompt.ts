import { useSyncExternalStore } from 'react';

/**
 * De installeerknop van de browser, voor de losse apps (standaloneApps.ts).
 *
 * Chrome, Edge en Android sturen `beforeinstallprompt` zodra de pagina een
 * installeerbaar manifest heeft. Wie dat event bewaart, kan later zelf de vraag
 * "App installeren?" laten verschijnen, vanaf een eigen knop. Het event komt
 * maar één keer en vaak vóórdat React draait; daarom vangt dit bestand het op
 * zodra main.tsx captureInstallPrompt() aanroept, en onthoudt het tot de knop
 * erom vraagt.
 *
 * Safari en Firefox kennen dit event niet. Daar kan alleen de gebruiker zelf
 * installeren (Deel → Zet op beginscherm, Archief → Voeg toe aan Dock); die
 * uitleg geeft installHint().
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
let captured = false;
const listeners = new Set<() => void>();
let snapshot = { canPrompt: false, installed: false };

function emit() {
  snapshot = { canPrompt: deferred !== null, installed: installedNow };
  listeners.forEach(listener => listener());
}

/**
 * Begin met opvangen. Alleen in een losse app: daar staat onze eigen knop. In
 * de werkruimte laten we het gedrag van de browser zoals het was (op Android
 * het balkje onderin), want daar is geen knop die het overneemt.
 */
export function captureInstallPrompt(): void {
  if (captured || typeof window === 'undefined') return;
  captured = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    // Zonder preventDefault toont Android zijn eigen balkje, en dan staan er
    // twee vragen om hetzelfde in beeld.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    emit();
  });
}

/** Laat de vraag van de browser zien. Het event werkt één keer; daarna is het op. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  emit();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return 'unavailable';
  }
}

export function useInstallPrompt(): { canPrompt: boolean; installed: boolean } {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => snapshot,
    () => snapshot,
  );
}

export type InstallHint = 'ios' | 'mac-safari' | 'chromium' | 'other';

/**
 * Hoe installeer je op dit apparaat, als de browser geen knop aanbiedt? Op
 * userAgent, want daar is geen nette functie voor. Een iPad meldt zich sinds
 * iPadOS 13 als Mac; hij is te herkennen aan het aanraakscherm.
 */
export function installHint(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): InstallHint {
  const ua = nav.userAgent;
  const iPad = /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPad) return 'ios';
  if (/Edg\/|Chrome\/|Chromium\//.test(ua)) return 'chromium';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Firefox\//.test(ua)) return 'mac-safari';
  return 'other';
}

/** De uitleg bij een InstallHint, in gewone woorden. */
export const INSTALL_STEPS: Record<InstallHint, string> = {
  ios: 'Tik in Safari op Deel (het vierkantje met de pijl omhoog) en kies "Zet op beginscherm".',
  'mac-safari': 'Kies in Safari in de menubalk Archief → "Voeg toe aan Dock".',
  chromium: 'Klik in de adresbalk op het installeericoon, of open het menu (⋮) en kies "App installeren".',
  other: 'Deze browser kan geen apps installeren. Open het adres in Chrome, Edge of Safari.',
};
