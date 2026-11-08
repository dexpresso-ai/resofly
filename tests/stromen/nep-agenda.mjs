// Nep-Google en nep-Microsoft voor de agendakoppeling: codes, tokens,
// profielen, agendalijsten (over meerdere pagina's) en afspraken, en wat er
// werd ingetrokken. Gedeeld door agenda.mjs (functies en database),
// videovergadering.mjs (Google Meet en Teams) en ui.mjs (de knoppen in de
// browser). Registreert zich bij het importeren.
//
// Google Meet en Teams zoals de echte diensten ze doen:
// - een Google-afspraak met conferenceData.createRequest (en
//   conferenceDataVersion=1) krijgt een Meet; zonder die versie negeert Google
//   het verzoek. Met `nep.meetBezig` staat hij eerst op "pending";
// - de Meet REST API (spaces.create) vraagt het recht meetings.space.created;
// - een Microsoft-afspraak met isOnlineMeeting krijgt alleen Teams op een
//   werkaccount (`teams: true`); isOnlineMeeting terug op false negeert Outlook;
// - Graph /me/onlineMeetings vraagt OnlineMeetings.ReadWrite en een werkaccount;
// - Microsoft weigert een tokenvernieuwing die om een recht vraagt dat nooit
//   gegeven is (invalid_grant, AADSTS65001), zoals in het echt.
import { randomUUID } from 'node:crypto';
import { registreerDienst } from './nepdiensten.mjs';

export const G = 'https://www.googleapis.com/auth/';
export const GOOGLE_MEET = `${G}meetings.space.created`;
export const GOOGLE_ALLES = ['openid', 'email', 'profile', `${G}calendar.calendarlist.readonly`, `${G}calendar.events`, `${G}contacts.readonly`, `${G}contacts.other.readonly`].join(' ');
export const MS_ALLES = 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.Read https://graph.microsoft.com/People.Read';
export const MS_TEAMS = 'https://graph.microsoft.com/OnlineMeetings.ReadWrite';

// ── Nep-Google en nep-Microsoft ─────────────────────────────────────────────

export const nep = {
  /** code → { account, scope } (eenmalig, zoals bij de echte providers) */
  codes: new Map(),
  /** toegangstoken → account */
  toegang: new Map(),
  /** toegangstoken → de rechten die erbij horen */
  toegangRechten: new Map(),
  /** vernieuwtoken → account */
  vernieuw: new Map(),
  /** vernieuwtoken → de rechten die de gebruiker gaf (bij het toestaan) */
  verleend: new Map(),
  /** account → { provider, id, email, naam, agendas: [{ id, ... }], afspraken: { agendaId: [...] } } */
  accounts: new Map(),
  /** Volgende tokenvernieuwing faalt zo: { status, body } (blijft staan tot je hem wist). */
  vernieuwFout: null,
  /** Elke tokenvernieuwing: { provider, scope } (de gevraagde rechten bij Microsoft). */
  vernieuwingen: [],
  /** Tokens die bij Google /revoke binnenkwamen. */
  ingetrokken: [],
  /** Agenda's die bij het ophalen van afspraken 404 geven (verwijderd bij de provider). */
  weg: new Set(),
  /** Hoeveel keer de agendalijst is opgevraagd, per pagina. */
  lijstPaginas: [],
  /** Google zet een nieuwe Meet eerst op "pending" (zo vaak als dit getal; de volgende GET geeft hem). */
  meetBezig: 0,
  /** De Meet REST API staat in het (nep-)Google Cloud-project uit. */
  meetApiUit: false,
  /** Elke aanvraag voor een Meet op een afspraak (createRequest), en elke losse ruimte (spaces.create). */
  meetAanvragen: [],
  ruimtes: [],
  /** Losse Teams-vergaderingen (onlineMeetings). */
  teamsVergaderingen: [],
  /** Elke PATCH op een afspraak: { provider, id, query, body }. */
  wijzigingen: [],
};

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function nieuwToken(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function meetLink() {
  const deel = (n) => Array.from({ length: n }, () => 'abcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 25)]).join('');
  return `https://meet.google.com/${deel(3)}-${deel(4)}-${deel(3)}`;
}

function teamsLink() {
  return `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${randomUUID().replace(/-/g, '')}%40thread.v2/0`;
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

/** Microsoft geeft rechten soms kaal ("OnlineMeetings.ReadWrite"), soms als volledige URI. */
function rechtSleutel(recht) {
  return String(recht).trim().split('/').pop().toLowerCase();
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
    nep.toegangRechten.set(access, gegeven.scope);
    nep.vernieuw.set(refresh, gegeven.sleutel);
    nep.verleend.set(refresh, gegeven.scope);
    return json(200, { access_token: access, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer', scope: gegeven.scope });
  }
  if (form.get('grant_type') === 'refresh_token') {
    if (nep.vernieuwFout) return json(nep.vernieuwFout.status, nep.vernieuwFout.body ?? {});
    const refresh = form.get('refresh_token');
    const sleutel = nep.vernieuw.get(refresh);
    if (!sleutel) return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    const verleend = nep.verleend.get(refresh) ?? (provider === 'google' ? GOOGLE_ALLES : MS_ALLES);
    let scope = verleend;
    if (provider === 'microsoft') {
      // Zoals Microsoft: alleen wat gevraagd is, en nooit iets wat niet gegeven is.
      const gevraagd = String(form.get('scope') ?? '').split(/\s+/).filter(Boolean);
      nep.vernieuwingen.push({ provider, scope: gevraagd });
      const gegeven = new Set(verleend.split(/\s+/).map(rechtSleutel));
      const teveel = gevraagd.filter((recht) => !gegeven.has(rechtSleutel(recht)));
      if (teveel.length) {
        return json(400, { error: 'invalid_grant', error_description: `AADSTS65001: The user or administrator has not consented to use the application. Send an interactive authorization request for this user and resource. (${teveel.join(' ')})` });
      }
      scope = gevraagd.map((recht) => (/^(openid|profile|email|offline_access)$/i.test(recht) ? recht : `https://graph.microsoft.com/${recht.split('/').pop()}`)).join(' ');
    } else {
      nep.vernieuwingen.push({ provider, scope: null });
    }
    const access = nieuwToken('toegang');
    nep.toegang.set(access, sleutel);
    nep.toegangRechten.set(access, scope);
    return json(200, { access_token: access, expires_in: 3599, token_type: 'Bearer', scope });
  }
  return json(400, { error: 'unsupported_grant_type' });
}

function tokenVan(request) {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
}

function wie(request) {
  const sleutel = nep.toegang.get(tokenVan(request));
  return sleutel ? nep.accounts.get(sleutel) : null;
}

function heeftRecht(request, recht) {
  const rechten = String(nep.toegangRechten.get(tokenVan(request)) ?? '').split(/\s+/).map(rechtSleutel);
  return rechten.includes(rechtSleutel(recht));
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

/** Een Meet op een Google-afspraak, zoals Google conferenceData teruggeeft. */
function googleMeet(acc, requestId) {
  nep.meetAanvragen.push({ account: acc.email, requestId });
  if (nep.meetBezig > 0) {
    nep.meetBezig -= 1;
    return { conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'pending' } } }, _wachtOpMeet: true };
  }
  const uri = meetLink();
  return {
    hangoutLink: uri,
    conferenceData: {
      createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'success' } },
      entryPoints: [{ entryPointType: 'video', uri, label: uri.replace('https://', '') }],
      conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
      conferenceId: uri.split('/').pop(),
    },
  };
}

/** Een afspraak zoals Google hem teruggeeft (zonder onze interne vlaggen). */
function googleUit(evt) {
  const { _wachtOpMeet, ...rest } = evt;
  return rest;
}

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
  const lijst = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
  const een = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);
  const agendaId = decodeURIComponent((lijst ?? een)?.[1] ?? '');
  if ((lijst || een) && (nep.weg.has(agendaId) || !acc.agendas.some((a) => a.id === agendaId))) {
    return json(404, { error: { code: 404, message: 'Not Found' } });
  }
  const metMeet = url.searchParams.get('conferenceDataVersion') === '1';
  if (lijst) {
    if (request.method === 'POST') {
      const body = await request.json();
      const { conferenceData, ...rest } = body;
      const nieuw = { id: `evt-${randomUUID()}`, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${randomUUID()}`, ...rest };
      // Zonder conferenceDataVersion=1 negeert Google het verzoek om een Meet.
      if (metMeet && conferenceData?.createRequest && !acc.meetUit) Object.assign(nieuw, googleMeet(acc, conferenceData.createRequest.requestId));
      (acc.afspraken[agendaId] ??= []).push(nieuw);
      return json(200, googleUit(nieuw));
    }
    return json(200, { items: (acc.afspraken[agendaId] ?? []).map(googleUit) });
  }
  if (een) {
    const id = decodeURIComponent(een[2]);
    const evt = (acc.afspraken[agendaId] ?? []).find((e) => e.id === id);
    if (!evt) return json(404, { error: { code: 404, message: 'Not Found' } });
    if (request.method === 'GET') {
      // Een Meet die "pending" stond, is er bij de volgende vraag.
      if (evt._wachtOpMeet) {
        delete evt._wachtOpMeet;
        Object.assign(evt, googleMeet(acc, evt.conferenceData.createRequest.requestId));
        nep.meetAanvragen.pop(); // dezelfde aanvraag, geen nieuwe
      }
      return json(200, googleUit(evt));
    }
    if (request.method === 'PATCH') {
      const body = await request.json();
      nep.wijzigingen.push({ provider: 'google', id, query: Object.fromEntries(url.searchParams), body });
      const { conferenceData, ...rest } = body;
      Object.assign(evt, rest);
      if (metMeet && 'conferenceData' in body) {
        if (conferenceData === null) {
          delete evt.conferenceData;
          delete evt.hangoutLink;
        } else if (conferenceData?.createRequest && !acc.meetUit) {
          Object.assign(evt, googleMeet(acc, conferenceData.createRequest.requestId));
        }
      }
      return json(200, googleUit(evt));
    }
    if (request.method === 'DELETE') {
      acc.afspraken[agendaId] = acc.afspraken[agendaId].filter((e) => e.id !== id);
      return new Response(null, { status: 204 });
    }
  }
  return json(404, { error: { code: 404, message: 'Not Found' } });
});

// De Meet REST API: een losse vergaderruimte.
registreerDienst('https://meet.googleapis.com', async (request, url) => {
  const acc = wie(request);
  if (!acc) return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
  if (url.pathname !== '/v2/spaces' || request.method !== 'POST') return json(404, { error: { code: 404, message: 'Not Found' } });
  if (nep.meetApiUit) {
    return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Meet REST API has not been used in project 123456 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } });
  }
  if (!heeftRecht(request, GOOGLE_MEET)) {
    return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
  }
  if (acc.meetUit) return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } });
  const uri = meetLink();
  const ruimte = { name: `spaces/${randomUUID().slice(0, 12)}`, meetingUri: uri, meetingCode: uri.split('/').pop(), config: { accessType: 'TRUSTED' } };
  nep.ruimtes.push({ account: acc.email, ...ruimte });
  return json(200, ruimte);
});

registreerDienst('https://login.microsoftonline.com', async (request, url) => {
  if (url.pathname.endsWith('/oauth2/v2.0/token')) return tokenEindpunt(request, 'microsoft');
  return json(404, {});
});

/** Een afspraak zoals Graph hem teruggeeft. */
function graphUit(evt) {
  return evt;
}

function bodyPreview(content) {
  return String(content ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);
}

registreerDienst('https://graph.microsoft.com', async (request, url) => {
  const acc = wie(request);
  if (!acc) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
  if (url.pathname === '/v1.0/me') return json(200, { id: acc.id, mail: acc.email, displayName: acc.naam });
  if (url.pathname === '/v1.0/me/calendars') {
    const vanaf = Number(url.searchParams.get('$skip') || 0);
    nep.lijstPaginas.push({ provider: 'microsoft', vanaf, top: url.searchParams.get('$top'), select: url.searchParams.get('$select') });
    const items = acc.agendas.slice(vanaf, vanaf + 2);
    const volgende = vanaf + 2 < acc.agendas.length ? `https://graph.microsoft.com/v1.0/me/calendars?$top=100&$skip=${vanaf + 2}` : undefined;
    return json(200, { value: items, ...(volgende ? { '@odata.nextLink': volgende } : {}) });
  }
  const view = url.pathname.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/);
  if (view) {
    const agendaId = decodeURIComponent(view[1]);
    if (nep.weg.has(agendaId)) return json(404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
    return json(200, { value: (acc.afspraken[agendaId] ?? []).map(graphUit) });
  }
  const maak = url.pathname.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/events$/);
  if (maak && request.method === 'POST') {
    const agendaId = decodeURIComponent(maak[1]);
    const body = await request.json();
    const nieuw = {
      id: `ms-${randomUUID()}`, ...body, bodyPreview: bodyPreview(body.body?.content), webLink: `https://outlook.office.com/calendar/item/${randomUUID()}`,
      isOnlineMeeting: false, onlineMeeting: null,
    };
    // Alleen een werkaccount met Teams krijgt een Teams-vergadering; een
    // privé-account krijgt de afspraak zonder, en geen foutmelding.
    if (body.isOnlineMeeting && body.onlineMeetingProvider === 'teamsForBusiness' && acc.teams) {
      Object.assign(nieuw, { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: teamsLink() } });
    }
    (acc.afspraken[agendaId] ??= []).push(nieuw);
    return json(201, graphUit(nieuw));
  }
  const een = url.pathname.match(/^\/v1\.0\/me\/events\/([^/]+)$/);
  if (een) {
    const id = decodeURIComponent(een[1]);
    const evt = Object.values(acc.afspraken).flat().find((e) => e.id === id);
    if (!evt) return json(404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
    if (request.method === 'GET') {
      if (/body-content-type="text"/.test(request.headers.get('prefer') ?? '')) {
        return json(200, { id, body: { contentType: 'text', content: String(evt.body?.content ?? '') } });
      }
      return json(200, graphUit(evt));
    }
    if (request.method === 'PATCH') {
      const body = await request.json();
      nep.wijzigingen.push({ provider: 'microsoft', id, query: Object.fromEntries(url.searchParams), body });
      const { isOnlineMeeting, onlineMeetingProvider, ...rest } = body;
      Object.assign(evt, rest);
      if (body.body) evt.bodyPreview = bodyPreview(body.body.content);
      // Eenmaal online blijft online (Outlook negeert false).
      if (isOnlineMeeting && onlineMeetingProvider === 'teamsForBusiness' && acc.teams && !evt.onlineMeeting) {
        Object.assign(evt, { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: teamsLink() } });
      }
      return json(200, graphUit(evt));
    }
  }
  if (url.pathname === '/v1.0/me/onlineMeetings' && request.method === 'POST') {
    if (!heeftRecht(request, MS_TEAMS)) return json(403, { error: { code: 'Forbidden', message: 'Insufficient privileges to complete the operation.' } });
    if (!acc.teams) return json(403, { error: { code: 'Forbidden', message: 'Forbidden' } });
    const body = await request.json();
    const vergadering = { id: randomUUID(), subject: body.subject, startDateTime: body.startDateTime, endDateTime: body.endDateTime, joinWebUrl: teamsLink() };
    nep.teamsVergaderingen.push({ account: acc.email, ...vergadering });
    return json(201, vergadering);
  }
  return json(404, { error: { code: 'NotFound', message: 'Not found' } });
});
