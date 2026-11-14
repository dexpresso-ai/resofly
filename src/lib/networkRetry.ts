// Verbindingsfouten: herkennen, in gewone woorden melden, en het opnieuw
// proberen zodra de verbinding terug is.
//
// Aanleiding (14 november): een album van 51 foto's uploaden op een
// Android-telefoon. Halverwege viel de verbinding even weg: het scherm ging
// uit, of de telefoon wisselde van wifi naar 4G. Chrome breekt lopende
// verzoeken dan af en meldt `TypeError: Failed to fetch`. De app gaf die tekst
// letterlijk door en probeerde niets opnieuw. De rest van de wachtrij liep in
// een paar tellen leeg, elk bestand met "Failed to fetch". Eén bestand kreeg
// "Niet ingelogd.", omdat ook de vraag wie er is ingelogd over het netwerk
// ging (zie currentUserId in repository.ts).
//
// Dit bestand heeft bewust geen imports: de tests draaien het los in Node.

/** Wat de gebruiker leest als een verzoek de server niet haalde. */
export const CONNECTION_LOST_MESSAGE = 'Geen verbinding. Controleer je internet en probeer het opnieuw.';

/** Wat de gebruiker leest als de sessie echt weg is (niet: als het netwerk hapert). */
export const SIGNED_OUT_MESSAGE = 'Je bent niet meer ingelogd. Log opnieuw in en probeer het nog eens.';

/** Een verzoek dat de server niet haalde, of waarvan het antwoord niet terugkwam. */
export class ConnectionError extends Error {
  constructor(message = CONNECTION_LOST_MESSAGE) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** Een antwoord met een foutstatus; de status beslist of opnieuw proberen zin heeft. */
export class HttpStatusError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

// Hoe elke browser een verbroken verbinding meldt. Chrome: "Failed to fetch",
// en "network error" als de verbinding wegvalt terwijl het antwoord binnenkomt.
// Safari: "Load failed", "The network connection was lost.". Firefox:
// "NetworkError when attempting to fetch resource.".
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror when attempting to fetch|\bnetwork error\b|network request failed|network connection was lost|internet connection appears to be offline|err_network|err_internet_disconnected|err_connection_(?:reset|closed|aborted)/i;

/** Haalde dit verzoek de server niet? Dan kan het een tel later wél lukken. */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof ConnectionError) return true;
  if (typeof error === 'string') return NETWORK_FAILURE.test(error);
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ConnectionError') return true;
  // Van supabase-js: de inlogserver was niet bereikbaar (of gaf een 502–504).
  // Dat is iets anders dan "je bent niet ingelogd".
  if (name === 'AuthRetryableFetchError') return true;
  return typeof message === 'string' && NETWORK_FAILURE.test(message);
}

/** Statussen waarbij het een tel later wel kan lukken: time-out, te druk, een storing onderweg. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429
    || (status >= 500 && status <= 504)
    // Cloudflare: de worker of zijn bron was even niet bereikbaar.
    || (status >= 520 && status <= 524);
}

export function isRetryableError(error: unknown): boolean {
  if (isConnectionError(error)) return true;
  return error instanceof HttpStatusError && isTransientStatus(error.status);
}

/**
 * De tekst van een foutantwoord, zo dat de gebruiker er iets aan heeft. Een
 * foutpagina van Cloudflare is HTML; die gaf de app eerst letterlijk door.
 */
export function messageFromResponseText(status: number, text: string): string {
  const trimmed = text.trim();
  if (trimmed && !trimmed.startsWith('<')) return trimmed;
  return isTransientStatus(status)
    ? `De server is even niet bereikbaar (fout ${status}). Probeer het zo opnieuw.`
    : `De server weigerde dit (fout ${status}).`;
}

/** De melding voor in het scherm: een verbindingsfout in gewone woorden, anders de eigen tekst. */
export function readableError(error: unknown, fallback: string): string {
  if (isConnectionError(error)) return CONNECTION_LOST_MESSAGE;
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : error;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

// ── Wachten op verbinding ────────────────────────────────────────────────────

/** Wat de browser over het netwerk en het scherm weet; los te vervangen in tests. */
export type Connectivity = {
  online(): boolean;
  visible(): boolean;
  /** Meldt elke verandering; geeft een functie terug die stopt met luisteren. */
  watch(listener: () => void): () => void;
};

export const browserConnectivity: Connectivity = {
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  watch: (listener) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
    window.addEventListener('online', listener);
    document.addEventListener('visibilitychange', listener);
    return () => {
      window.removeEventListener('online', listener);
      document.removeEventListener('visibilitychange', listener);
    };
  },
};

/**
 * Wacht tot de browser weer online is en het scherm weer aan staat, maar
 * nooit langer dan `maxMs`. Op een telefoon met het scherm uit lukt geen
 * enkel verzoek (Chrome: ERR_NETWORK_IO_SUSPENDED); opnieuw proberen heeft
 * pas zin als je terug bent.
 */
export function waitForConnection(maxMs: number, connectivity: Connectivity = browserConnectivity): Promise<void> {
  if (connectivity.online() && connectivity.visible()) return Promise.resolve();
  return new Promise((resolve) => {
    let stop: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      stop();
      resolve();
    };
    timer = setTimeout(finish, maxMs);
    stop = connectivity.watch(() => {
      if (connectivity.online() && connectivity.visible()) finish();
    });
  });
}

export type RetryInfo = {
  /** Er is nu geen verbinding, of het scherm staat uit: we wachten tot dat over is. */
  waiting: boolean;
};

export type RetryOptions = {
  /** Na zoveel mislukte pogingen mét verbinding geven we op (de eerste telt mee). */
  attempts?: number;
  /** Wachttijd na de 1e, 2e, … mislukte poging; de laatste geldt daarna. */
  delaysMs?: readonly number[];
  /** Hoe lang hooguit per keer wachten op verbinding of op een scherm dat weer aan is. */
  maxWaitMs?: number;
  /** Er komt zo een nieuwe poging. */
  onRetry?: (info: RetryInfo) => void;
  connectivity?: Connectivity;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

// Een vangnet tegen eeuwig wachten in een tabblad dat op de achtergrond staat
// en waar het verzoek steeds mislukt: met een minuut wachten per ronde is dit
// ruim twee uur.
const MAX_ROUNDS = 150;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Voert `run` uit en probeert het opnieuw bij een verbindingsfout of een
 * tijdelijke serverfout. Andere fouten (geen toegang, ongeldige invoer) gaan
 * meteen door: die lossen zich niet vanzelf op.
 *
 * Een poging zonder netwerk, of met het scherm uit, telt niet mee. Zo raakt
 * een telefoon die even in slaap valt zijn pogingen niet kwijt: als je terug
 * bent, gaat de upload verder. `run` moet dus veilig opnieuw kunnen; bij elke
 * poging een vers token ophalen hoort daarbij.
 */
export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delays = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const connectivity = options.connectivity ?? browserConnectivity;
  const sleep = options.sleep ?? defaultSleep;
  let failures = 0;
  for (let round = 1; ; round += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      const reachable = connectivity.online() && connectivity.visible();
      if (reachable) failures += 1;
      if (failures >= attempts || round >= MAX_ROUNDS) throw error;
      options.onRetry?.({ waiting: !reachable });
      await sleep(delays[Math.min(Math.max(failures - 1, 0), delays.length - 1)]);
      await waitForConnection(maxWaitMs, connectivity);
    }
  }
}
