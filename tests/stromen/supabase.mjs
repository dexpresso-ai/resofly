// De database zoals de app hem ziet: PostgREST met het token van een
// gebruiker (RLS geldt), of met de service-sleutel voor het klaarzetten.
// `sql()` is alleen voor wat geen gebruiker kan: datums terugzetten, plekken.
import { execFileSync } from 'node:child_process';
import { API_URL, ANON_KEY, SERVICE_KEY, DB_URL } from './omgeving.mjs';

export async function rest(pad, { token, method = 'GET', body, prefer, sleutel } = {}) {
  const headers = {
    apikey: sleutel ?? ANON_KEY,
    authorization: `Bearer ${token ?? ANON_KEY}`,
    'content-type': 'application/json',
  };
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${API_URL}/rest/v1/${pad}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

/** Als de server (service role): RLS geldt niet. */
export function dienst(pad, opties = {}) {
  return rest(pad, { ...opties, token: SERVICE_KEY, sleutel: SERVICE_KEY });
}

export function rpc(naam, args = {}, token) {
  return rest(`rpc/${naam}`, { method: 'POST', body: args, token });
}

export function sql(query) {
  return execFileSync('psql', [DB_URL, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function sqlRijen(query) {
  const uit = sql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`);
  return JSON.parse(uit || '[]');
}

export function sqlRij(query) {
  return sqlRijen(query)[0] ?? null;
}

const RUN = Date.now().toString(36);
let teller = 0;

/** Een bevestigde gebruiker met een sessietoken, zoals na inloggen. */
export async function maakGebruiker(naam, email) {
  const adres = (email ?? `${naam}.${RUN}.${++teller}@stromen.test`).toLowerCase();
  const wachtwoord = `Stromen-${RUN}-Wachtwoord!9`;
  const maak = await fetch(`${API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: adres, password: wachtwoord, email_confirm: true }),
  });
  const gebruiker = await maak.json();
  if (!maak.ok) throw new Error(`gebruiker ${adres} aanmaken: ${JSON.stringify(gebruiker)}`);
  const login = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: adres, password: wachtwoord }),
  });
  const sessie = await login.json();
  if (!login.ok) throw new Error(`inloggen ${adres}: ${JSON.stringify(sessie)}`);
  return { id: gebruiker.id, email: adres, token: sessie.access_token };
}

export function uniek(prefix) {
  return `${prefix}-${RUN}-${++teller}`;
}
