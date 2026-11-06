// Nep-Google en nep-Microsoft voor de agendakoppeling: codes, tokens,
// profielen, agendalijsten (over meerdere pagina's) en afspraken, en wat er
// werd ingetrokken. Gedeeld door agenda.mjs (functies en database) en ui.mjs
// (de knoppen in de browser). Registreert zich bij het importeren.
import { randomUUID } from 'node:crypto';
import { registreerDienst } from './nepdiensten.mjs';

export const G = 'https://www.googleapis.com/auth/';
export const GOOGLE_ALLES = ['openid', 'email', 'profile', `${G}calendar.calendarlist.readonly`, `${G}calendar.events`, `${G}contacts.readonly`, `${G}contacts.other.readonly`].join(' ');
export const MS_ALLES = 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.Read https://graph.microsoft.com/People.Read';

// ── Nep-Google en nep-Microsoft ─────────────────────────────────────────────

export const nep = {
  /** code → { account, scope } (eenmalig, zoals bij de echte providers) */
  codes: new Map(),
  /** toegangstoken → account */
  toegang: new Map(),
  /** vernieuwtoken → account */
  vernieuw: new Map(),
  /** account → { provider, id, email, naam, agendas: [{ id, ... }], afspraken: { agendaId: [...] } } */
  accounts: new Map(),
  /** Volgende tokenvernieuwing faalt zo: { status, body } (blijft staan tot je hem wist). */
  vernieuwFout: null,
  /** Tokens die bij Google /revoke binnenkwamen. */
  ingetrokken: [],
  /** Agenda's die bij het ophalen van afspraken 404 geven (verwijderd bij de provider). */
  weg: new Set(),
  /** Hoeveel keer de agendalijst is opgevraagd, per pagina. */
  lijstPaginas: [],
};

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function nieuwToken(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function account(sleutel, gegevens) {
  nep.accounts.set(sleutel, { afspraken: {}, ...gegevens });
  return nep.accounts.get(sleutel);
}

/** Een code zoals de provider hem na "toestaan" aan de browser meegeeft. */
export function geefCode(sleutel, scope) {
  const code = nieuwToken('code');
  nep.codes.set(code, { sleutel, scope });
  return code;
}

async function tokenEindpunt(request, provider) {
  const form = new URLSearchParams(await request.text());
  const clientId = provider === 'google' ? 'google-client-stromen' : 'microsoft-client-stromen';
  const geheim = provider === 'google' ? 'google-geheim-stromen' : 'microsoft-geheim-stromen';
  if (form.get('client_id') !== clientId || form.get('client_secret') !== geheim) return json(401, { error: 'invalid_client' });
  if (form.get('grant_type') === 'authorization_code') {
    const gegeven = nep.codes.get(form.get('code'));
    nep.codes.delete(form.get('code'));
    if (!gegeven) return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    const access = nieuwToken('toegang');
    const refresh = nieuwToken('vernieuw');
    nep.toegang.set(access, gegeven.sleutel);
    nep.vernieuw.set(refresh, gegeven.sleutel);
    return json(200, { access_token: access, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer', scope: gegeven.scope });
  }
  if (form.get('grant_type') === 'refresh_token') {
    if (nep.vernieuwFout) return json(nep.vernieuwFout.status, nep.vernieuwFout.body ?? {});
    const sleutel = nep.vernieuw.get(form.get('refresh_token'));
    if (!sleutel) return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    const access = nieuwToken('toegang');
    nep.toegang.set(access, sleutel);
    return json(200, { access_token: access, expires_in: 3599, token_type: 'Bearer', scope: provider === 'google' ? GOOGLE_ALLES : MS_ALLES });
  }
  return json(400, { error: 'unsupported_grant_type' });
}

function wie(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const sleutel = nep.toegang.get(token);
  return sleutel ? nep.accounts.get(sleutel) : null;
}

registreerDienst('https://oauth2.googleapis.com', async (request, url) => {
  if (url.pathname === '/token') return tokenEindpunt(request, 'google');
  if (url.pathname === '/revoke') {
    const token = new URLSearchParams(await request.text()).get('token') || url.searchParams.get('token');
    nep.ingetrokken.push(token);
    return new Response('', { status: 200 });
  }
  return json(404, {});
});

registreerDienst('https://www.googleapis.com', async (request, url) => {
  const acc = wie(request);
  if (!acc) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
  if (url.pathname === '/oauth2/v3/userinfo') return json(200, { sub: acc.id, email: acc.email, name: acc.naam });
  if (url.pathname === '/calendar/v3/users/me/calendarList') {
    // Twee per pagina, zodat de functie nextPageToken moet volgen.
    const vanaf = Number(url.searchParams.get('pageToken') || 0);
    nep.lijstPaginas.push({ provider: 'google', vanaf, showHidden: url.searchParams.get('showHidden') });
    const zichtbaar = acc.agendas.filter((a) => url.searchParams.get('showHidden') === 'true' || !a.hidden);
    const items = zichtbaar.slice(vanaf, vanaf + 2);
    const volgende = vanaf + 2 < zichtbaar.length ? String(vanaf + 2) : undefined;
    return json(200, { items, ...(volgende ? { nextPageToken: volgende } : {}) });
  }
  const m = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
  if (m) {
    const agendaId = decodeURIComponent(m[1]);
    if (nep.weg.has(agendaId) || !acc.agendas.some((a) => a.id === agendaId)) return json(404, { error: { code: 404, message: 'Not Found' } });
    if (request.method === 'POST') {
      const body = await request.json();
      const nieuw = { id: `evt-${randomUUID()}`, status: 'confirmed', ...body };
      (acc.afspraken[agendaId] ??= []).push(nieuw);
      return json(200, nieuw);
    }
    return json(200, { items: acc.afspraken[agendaId] ?? [] });
  }
  return json(404, { error: { code: 404, message: 'Not Found' } });
});

registreerDienst('https://login.microsoftonline.com', async (request, url) => {
  if (url.pathname.endsWith('/oauth2/v2.0/token')) return tokenEindpunt(request, 'microsoft');
  return json(404, {});
});

registreerDienst('https://graph.microsoft.com', async (request, url) => {
  const acc = wie(request);
  if (!acc) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
  if (url.pathname === '/v1.0/me') return json(200, { id: acc.id, mail: acc.email, displayName: acc.naam });
  if (url.pathname === '/v1.0/me/calendars') {
    const vanaf = Number(url.searchParams.get('$skip') || 0);
    nep.lijstPaginas.push({ provider: 'microsoft', vanaf, top: url.searchParams.get('$top') });
    const items = acc.agendas.slice(vanaf, vanaf + 2);
    const volgende = vanaf + 2 < acc.agendas.length ? `https://graph.microsoft.com/v1.0/me/calendars?$top=100&$skip=${vanaf + 2}` : undefined;
    return json(200, { value: items, ...(volgende ? { '@odata.nextLink': volgende } : {}) });
  }
  const m = url.pathname.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/);
  if (m) {
    const agendaId = decodeURIComponent(m[1]);
    if (nep.weg.has(agendaId)) return json(404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
    return json(200, { value: acc.afspraken[agendaId] ?? [] });
  }
  return json(404, { error: { code: 'NotFound', message: 'Not found' } });
});
