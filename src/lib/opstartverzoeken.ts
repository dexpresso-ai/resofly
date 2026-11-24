/**
 * Opstartverzoeken: de leesverzoeken van de vorige start, al tijdens het
 * lezen van de HTML.
 *
 * Waarom: de werkruimte vroeg zijn gegevens pas op als de hele bundel was
 * uitgevoerd en de sessie bekend was. Op een telefoon (gemeten met 4× tragere
 * CPU) ging het eerste verzoek bij een tweede start pas op ~0,65-0,9 s weg,
 * terwijl de HTML er na 0,17 s was. Daartussen: de bundel uitvoeren (vendor,
 * repository, main) en de sessie van supabase-js, die achter de eerste render
 * van React in de rij stond. Later renderen of in stukjes renderen won
 * nauwelijks: zolang de verzoeken in de bundel zitten, kunnen ze niet eerder.
 *
 * Twee delen:
 *  - het inline script in index.html leest de sessie van supabase-js en de
 *    lijst die hieronder wordt bewaard, en vuurt die leesverzoeken meteen af
 *    met hetzelfde token (window.__resoflyOpstart). Alleen GET op /rest/v1 van
 *    de eigen Supabase, alleen met een token dat nog minstens twee minuten
 *    geldig is, en alleen in de werkruimte (/ en /app/…);
 *  - `supabaseFetch` is de fetch van de Supabase-client (lib/supabase.ts). Een
 *    GET met precies hetzelfde adres, dezelfde Accept en Prefer en hetzelfde
 *    token krijgt dat antwoord, één keer. Al het andere gaat ongewijzigd naar
 *    de server.
 * Wat de app opvraagt en wat hij met het antwoord doet, verandert dus niet;
 * de RLS beslist zoals altijd.
 *
 * Daarnaast onthoudt `supabaseFetch` welke leesverzoeken de app bij het
 * opstarten deed, tot saveOpstartLijst (een paar tellen na de eerste
 * geslaagde ronde). Verzoeken met een datum of tijd in het adres slaan we
 * over: die zijn de volgende keer anders, en een verzoek dat de app dan toch
 * niet doet, is alleen werk voor de server.
 */

import { GROUP_TABLES } from './dataGroups.ts';

export interface Vooruitgehaald {
  at: number;
  token: string;
  entries: Map<string, Promise<Response>>;
}

declare global {
  interface Window { __resoflyOpstart?: Vooruitgehaald }
}

const SUPABASE_URL = ((import.meta.env?.VITE_SUPABASE_URL as string | undefined) ?? '').replace(/\/+$/, '');

/** Dezelfde sleutel als het inline script in index.html maakt (de test vergelijkt ze). */
export function opstartSleutel(url: string, accept: string | null, prefer: string | null): string {
  return `GET ${url}\n${accept ?? ''}\n${prefer ?? ''}`;
}

export const OPSTART_LIJST_PREFIX = 'resofly.opstartverzoeken.';
export const OPSTART_LIJST_VERSIE = 1;
const OPSTART_MAX_VERZOEKEN = 80;
/** Zo lang mag een vooruitgehaald antwoord wachten op de app. */
const VOORUIT_GELDIG_MS = 30_000;
/** Een datum in het adres (2026-11-23, ook als begin van een tijdstip). */
const DATUM = /\d{4}-\d{2}-\d{2}/;

type Verzoek = { url: string; accept: string | null; prefer: string | null };

const GROEP_TABELLEN = new Set<string>(Object.values(GROUP_TABLES).flat());

let opname: Verzoek[] | null = [];

/** Of dit adres een leesverzoek op de eigen database is dat de volgende start mag herhalen. */
export function herhaalbaar(url: string, supabaseUrl: string = SUPABASE_URL): boolean {
  const prefix = `${supabaseUrl}/rest/v1/`;
  if (!supabaseUrl || !url.startsWith(prefix)) return false;
  // De groepen (dataGroups.ts) niet: welke de volgende start nodig heeft, hangt
  // af van de pagina waarop hij opent. De opstartronde haalt die zelf vooruit;
  // hier zou het bij een andere beginpagina zware tabellen voor niets opvragen.
  const table = url.slice(prefix.length).split(/[?/]/)[0];
  if (GROEP_TABELLEN.has(table)) return false;
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* laat zoals het is */ }
  return !DATUM.test(decoded);
}

function onthoud(verzoek: Verzoek) {
  if (!opname || opname.length >= OPSTART_MAX_VERZOEKEN || !herhaalbaar(verzoek.url)) return;
  if (opname.some(v => v.url === verzoek.url && v.accept === verzoek.accept && v.prefer === verzoek.prefer)) return;
  opname.push(verzoek);
}

function neemOver(verzoek: Verzoek, authorization: string | null, headers: Headers): Promise<Response> | null {
  if (typeof window === 'undefined') return null;
  const vooruit = window.__resoflyOpstart;
  if (!vooruit) return null;
  if (Date.now() - vooruit.at > VOORUIT_GELDIG_MS) {
    // Te oud: de app had het al lang moeten vragen. Weg ermee, ook uit het geheugen.
    delete window.__resoflyOpstart;
    return null;
  }
  // Een herhaling na een netwerkfout (postgrest-js) gaat naar de server.
  if (headers.has('X-Retry-Count')) return null;
  if (authorization !== `Bearer ${vooruit.token}`) return null;
  const sleutel = opstartSleutel(verzoek.url, verzoek.accept, verzoek.prefer);
  const antwoord = vooruit.entries.get(sleutel);
  if (!antwoord) return null;
  vooruit.entries.delete(sleutel);
  return antwoord;
}

/** De fetch van de Supabase-client. */
export const supabaseFetch: typeof fetch = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  const verzoek: Verzoek = { url, accept: headers.get('Accept'), prefer: headers.get('Prefer') };
  onthoud(verzoek);
  const overgenomen = neemOver(verzoek, headers.get('Authorization'), headers);
  // Mislukte het vooruit (geen netwerk op dat moment), dan alsnog zelf.
  return overgenomen ? overgenomen.catch(() => fetch(input, init)) : fetch(input, init);
};

/**
 * Bewaart wat de app bij deze start opvroeg, voor de volgende start van deze
 * gebruiker. Eén keer per laadbeurt; daarna onthoudt hij niets meer.
 */
export function saveOpstartLijst(userId: string): void {
  if (!opname) return;
  const requests = opname;
  opname = null;
  if (!requests.length) return;
  try {
    localStorage.setItem(OPSTART_LIJST_PREFIX + userId, JSON.stringify({ v: OPSTART_LIJST_VERSIE, at: Date.now(), requests }));
  } catch { /* geen opslag: dan de volgende keer gewoon zonder */ }
}

/** Bij uitloggen: geen lijst en niets vooruitgehaald meer, van niemand op dit apparaat. */
export function clearOpstartLijsten(): void {
  opname = null;
  if (typeof window !== 'undefined') delete window.__resoflyOpstart;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(OPSTART_LIJST_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch { /* geen opslag */ }
}
