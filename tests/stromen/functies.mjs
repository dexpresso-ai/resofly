// De echte edge functions, rechtstreeks aangeroepen met een Request zoals de
// browser (supabase.functions.invoke), een klant of Mollie die zou sturen.
import { API_URL, ORIGIN } from './omgeving.mjs';

const handlers = new Map();
let rij = Promise.resolve();

/** Laadt supabase/functions/<naam>/index.ts één keer en geeft de handler. */
export async function handler(naam) {
  if (handlers.has(naam)) return handlers.get(naam);
  // Na elkaar laden: serve() meldt zich bij de functie die op dat moment laadt.
  const laden = rij.then(async () => {
    if (handlers.has(naam)) return;
    let gevangen = null;
    globalThis.__stromenServe = (h) => { gevangen = h; };
    await import(new URL(`../../supabase/functions/${naam}/index.ts`, import.meta.url).href);
    if (!gevangen) throw new Error(`${naam}: de functie riep serve() niet aan`);
    handlers.set(naam, gevangen);
  });
  rij = laden.catch(() => undefined);
  await laden;
  return handlers.get(naam);
}

const CONN = { remoteAddr: { transport: 'tcp', hostname: '203.0.113.9', port: 443 } };

export async function roepRequest(naam, request) {
  const h = await handler(naam);
  return h(request, CONN);
}

/**
 * Roept een functie aan. `token` = het sessietoken van een gebruiker (of niets).
 * Antwoord: { status, json, tekst, headers, bytes }.
 */
export async function roep(naam, { token, body, method = 'POST', query = '', headers = {}, origin = ORIGIN, ruw = false, ip } = {}) {
  const url = `${API_URL}/functions/v1/${naam}${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`;
  const kop = { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  if (ip) kop['x-forwarded-for'] = ip;
  const init = { method, headers: kop };
  if (body !== undefined) {
    init.body = ruw ? body : JSON.stringify(body);
    if (!ruw && !kop['content-type']) init.headers['content-type'] = 'application/json';
  }
  const res = await roepRequest(naam, new Request(url, init));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tekst = new TextDecoder().decode(bytes);
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst, headers: res.headers, bytes };
}
