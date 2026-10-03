// ============================================================
// Welke browser-herkomst (Origin) mag een Edge Function aanroepen?
//
// Puur, zonder imports, zodat de regels los te testen zijn (origins.test.ts).
// edgeAuth.ts (makeCors) gebruikt ze; functies met een eigen kopie van de
// CORS-code houden zich aan dezelfde twee regels, en edgeFunctionsCors.test.ts
// bewaakt dat:
//   1. Access-Control-Allow-Origin is nooit "null". Geen match = geen header,
//      dan blokkeert de browser het lezen.
//   2. Een verzoek met `Origin: null` wordt geweigerd, ook lokaal.
// ============================================================

/**
 * De origin die een browser meestuurt als een pagina geen echte herkomst heeft:
 * een sandbox-iframe, een data:- of file:-pagina, een formulier dat via een
 * andere site werd doorgestuurd. Dat is nooit de app — en wie "null" als
 * toegestane origin terugstuurt, geeft juist zo'n pagina toegang.
 */
export const OPAQUE_ORIGIN = 'null';

/** `https://App.ResoFly.nl/pad/` → `https://app.resofly.nl`; al het andere → null. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const origin = new URL(trimmed).origin;
    return origin === OPAQUE_ORIGIN ? null : origin;
  } catch {
    return null;
  }
}

/**
 * De toegestane origins uit de instellingen: alleen echte webherkomsten
 * (`https://app.resofly.nl`, eventueel met poort), zoals een browser ze
 * meestuurt — een pad of een slash aan het eind valt weg. "null", "*" en wat
 * geen http(s)-adres is, tellen niet: die zouden elke herkomst toelaten.
 */
export function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(',')) {
      const origin = normalizeOrigin(part);
      if (origin) origins.add(origin);
    }
  }
  return [...origins];
}

/** De Vite-ontwikkelserver en dergelijke, op deze machine. */
export function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Wat er in Access-Control-Allow-Origin hoort voor dit verzoek, of null: dan
 * gaat de header niet mee. Een sterretje alleen lokaal, voor een verzoek zonder
 * Origin (curl, een script).
 */
export function corsAllowOrigin(origin: string, allowed: string[], allowLocalDev: boolean): string | null {
  if (origin === OPAQUE_ORIGIN) return null;
  if (origin && (allowed.includes(origin) || (allowLocalDev && isLocalDevOrigin(origin)))) return origin;
  return allowLocalDev && !origin ? '*' : null;
}

/**
 * Mag een verzoek met deze Origin binnen? Null als het mag, anders de status
 * en de zin. Zonder Origin (server-naar-server, curl) alleen lokaal; zonder
 * ingestelde origins alleen lokaal (in productie is dat een configuratiefout).
 */
export function originRefusal(
  origin: string, allowed: string[], allowLocalDev: boolean,
): { status: 403 | 500; message: string } | null {
  if (origin === OPAQUE_ORIGIN) {
    return { status: 403, message: 'Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.' };
  }
  if (!origin && allowLocalDev) return null;
  if (origin && allowed.includes(origin)) return null;
  if (allowLocalDev && isLocalDevOrigin(origin)) return null;
  if (allowed.length === 0 && allowLocalDev) return null;
  if (allowed.length === 0) return { status: 500, message: 'Toegestane origins ontbreken in de configuratie.' };
  return { status: 403, message: 'Deze frontend-origin is niet toegestaan.' };
}
