import { normalizePhoneE164 } from './calls';

/**
 * De brug tussen een tik op een telefoonlink en het gesprekslog.
 *
 * Een webapp kan het gesprekslog van een telefoon niet uitlezen — dat staat
 * geen enkel besturingssysteem toe, ook een native app niet (iOS geeft die
 * toegang aan niemand, en Google Play houdt de Android-permissie bij alles
 * wat geen standaard telefoon-app is). Wat een webapp wél weet: dat jij op
 * "bel" hebt getikt, en wanneer je terugkwam.
 *
 * Meer is het niet, en het is belangrijk dat de app dat ook niet doet alsof:
 * de tijd tussen weggaan en terugkomen is een BOVENGRENS voor de gespreksduur,
 * geen meting. Bel je vier minuten en kijk je daarna zes minuten op WhatsApp,
 * dan staat hier tien minuten. Het venster vult die waarde daarom in als
 * voorstel dat je bevestigt, nooit als feit.
 *
 * Inkomende gesprekken ziet de browser helemaal niet. Die log je met de hand,
 * of automatisch zodra er een koppeling met de telefooncentrale is.
 */

const STORAGE_KEY = 'resofly.pendingCall';
/** Ouder dan dit is geen "net gebeld" meer, maar een vergeten tabblad. */
const MAX_AGE_MS = 4 * 60 * 60 * 1000;
/** Korter dan dit betekent: verkeerd getikt, of meteen weggedrukt. */
const MIN_AWAY_SECONDS = 5;

export interface PendingCall {
  phone: string;
  /** Wie je dacht te bellen, voor zover de app dat wist toen je tikte. */
  counterpartName: string | null;
  clientId: string | null;
  contactId: string | null;
  supplierId: string | null;
  /** Wanneer er getikt werd (ISO). */
  startedAt: string;
}

/** De afronding: het voorstel dat het logvenster invult. */
export interface FinishedCall extends PendingCall {
  /**
   * Hoe lang het tabblad weg was, in seconden. Een BOVENGRENS voor de
   * gespreksduur — zie de toelichting boven dit bestand.
   */
  awaySeconds: number;
}

/**
 * Staat het logvenster open? Dan is dat venster de eigenaar van het lopende
 * gesprek en houdt `watchForReturn` zich stil. Bewust module-state en geen
 * React-context: de wachter hangt in de app-shell en het venster kan overal
 * vandaan geopend worden.
 */
let dialogOpen = false;

export function setCallDialogOpen(open: boolean): void {
  dialogOpen = open;
}

function read(): PendingCall | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCall;
    if (!parsed?.phone || !parsed?.startedAt) return null;
    if (Date.now() - Date.parse(parsed.startedAt) > MAX_AGE_MS) { clearPendingCall(); return null; }
    return parsed;
  } catch {
    // Privémodus, geblokkeerde opslag, kapotte JSON: de brug is een extraatje,
    // geen voorwaarde. Zonder opslag log je gewoon met de hand.
    return null;
  }
}

function write(pending: PendingCall | null): void {
  try {
    if (pending) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* zie read(): zonder opslag werkt de rest gewoon door */
  }
}

/**
 * Onthoudt dat er gebeld wordt. Aanroepen op het moment dat de gebruiker op
 * een telefoonlink tikt — niet erna, want dan is het tabblad mogelijk al weg.
 */
export function rememberCall(input: Omit<PendingCall, 'startedAt'>): void {
  if (!normalizePhoneE164(input.phone)) return;
  write({ ...input, startedAt: new Date().toISOString() });
}

export function clearPendingCall(): void {
  write(null);
}

export function peekPendingCall(): PendingCall | null {
  return read();
}

/**
 * Is er een gesprek af te ronden? Geeft het onthouden gesprek terug mét hoe
 * lang het tabblad weg was, en wist de herinnering — een voorstel komt één
 * keer langs. Te kort weg (mis-tik) telt niet als gesprek.
 */
export function takeFinishedCall(): FinishedCall | null {
  const pending = read();
  if (!pending) return null;
  const awaySeconds = Math.max(0, Math.round((Date.now() - Date.parse(pending.startedAt)) / 1000));
  // Te kort weg: NIET wissen. Dit is bijna altijd het 'focus'-event dat afgaat
  // op het moment dat de telefoon zijn "Bellen naar +31…?"-bevestiging toont of
  // sluit — het gesprek moet dan nog beginnen. Wissen zou precies het gesprek
  // weggooien dat we wilden vastleggen; de herinnering blijft dus staan tot er
  // een terugkeer is die er wél een is (of tot MAX_AGE_MS hem laat vervallen).
  if (awaySeconds < MIN_AWAY_SECONDS) return null;
  clearPendingCall();
  return { ...pending, awaySeconds };
}

/**
 * Roept `onReturn` aan zodra de gebruiker terugkomt in de app terwijl er een
 * gesprek openstaat. Geeft een opruimfunctie terug.
 *
 * Twee gebeurtenissen, omdat geen van beide overal betrouwbaar is:
 * `visibilitychange` vuurt als het tabblad weer zichtbaar wordt (de gewone
 * weg), en `focus` vangt de gevallen waarin het tabblad zichtbaar bleef maar
 * de telefoon-app er overheen stond. De tweede is een vangnet; dat de
 * afhandeling maar één keer loopt, regelt `takeFinishedCall` door te wissen.
 */
export function watchForReturn(onReturn: (call: FinishedCall) => void): () => void {
  const handle = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    // Staat het logvenster al open, dan handelt dát het gesprek af. Zonder deze
    // rem zou een gesprek dat vanuit het venster gestart is twee keer gelogd
    // kunnen worden: één keer via het venster en één keer via deze vraag.
    if (dialogOpen) return;
    const finished = takeFinishedCall();
    if (finished) onReturn(finished);
  };
  document.addEventListener('visibilitychange', handle);
  window.addEventListener('focus', handle);
  return () => {
    document.removeEventListener('visibilitychange', handle);
    window.removeEventListener('focus', handle);
  };
}
