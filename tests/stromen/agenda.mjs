// Agendakoppeling: Google en Microsoft koppelen, gebruiken, opnieuw koppelen en
// loskoppelen, door de echte edge function `calendar-integrations` tegen de
// echte database. Google en Microsoft zelf zijn nep (hieronder): die geven
// codes, tokens, profielen, agendalijsten (over meerdere pagina's) en afspraken,
// en houden bij wat er werd ingetrokken.
//
// Waarom zo: de koppeling is een rondgang langs drie partijen (app, provider,
// edge function) met een eenmalige code en een ondertekende state ertussen.
// Wat er mis kan gaan, zit in de naden: een code die bij de verkeerde gebruiker
// belandt, een fout van de provider die als kale JSON-pagina eindigt, een
// verdwenen agenda die de hele koppeling op slot zet, of loskoppelen dat uren wist.
//
//   npm run test:stromen -- agenda
import { createHmac, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { AGENDA_STATE_GEHEIM, ORIGIN } from './omgeving.mjs';
import { post } from './nepdiensten.mjs';
import { G, GOOGLE_ALLES, MS_ALLES, account, geefCode, nep } from './nep-agenda.mjs';
import { maakGebruiker, rest, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

// ── Hulpjes ─────────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function agenda(token, orgId, action, body = {}) {
  return roep('calendar-integrations', { token, body: { action, organizationId: orgId, ...body } });
}

/** De browser die Google of Microsoft terugstuurt naar de callback. */
function terug(query) {
  return roep('calendar-integrations', { method: 'GET', query, origin: null });
}

function onderteken(state, geheim = AGENDA_STATE_GEHEIM) {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const handtekening = createHmac('sha256', geheim).update(payload).digest('base64url');
  return `${payload}.${handtekening}`;
}

function stateVan(authUrl) {
  return new URL(authUrl).searchParams.get('state');
}

function locatie(res) {
  const waar = res.headers.get('location');
  verwacht(res.status === 302 && waar, `verwacht een redirect, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
  return new URL(waar);
}

/** Start, toestemming en terugkeer: wat de browser doet tot de app de code heeft. */
async function rondgang(gebruiker, orgId, provider, sleutel, scope, extra = {}) {
  const start = gelukt(await agenda(gebruiker.token, orgId, 'oauthStart', { provider, returnTo: `${ORIGIN}/#calendar-connections`, ...extra }), 'koppelen starten');
  const state = stateVan(start.authUrl);
  const code = geefCode(sleutel, scope);
  const terugkeer = locatie(await terug(`?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`));
  return { authUrl: start.authUrl, code: terugkeer.searchParams.get('calendar_code'), state: terugkeer.searchParams.get('calendar_state'), terugkeer };
}

function bronnen(connectionId) {
  return sqlRijen(`select id, provider_calendar_id, name, color, is_primary, access_role, sync_enabled, write_enabled, visibility
                     from public.calendar_sources where connection_id = ${q(connectionId)} order by provider_calendar_id`);
}

/** Een afspraak aan een klant koppelen met "telt mee voor de uren", zoals het agendascherm doet. */
async function koppelAanKlant(gebruiker, orgId, bron, afspraakId, klantId) {
  const start = new Date(Date.now() - 3 * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const res = await rest('calendar_event_links?on_conflict=organization_id,provider,calendar_source_id,provider_event_id,event_starts_at&select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'resolution=merge-duplicates,return=representation',
    body: {
      organization_id: orgId, provider: bron.provider ?? 'google', calendar_source_id: bron.id, provider_calendar_id: bron.provider_calendar_id,
      provider_event_id: afspraakId, event_starts_at: start.toISOString(), event_ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
      event_all_day: false, event_title_snapshot: 'Werksessie', client_id: klantId, project_id: null, track_time: true,
    },
  });
  gelukt(res, 'afspraak koppelen');
  const link = res.json[0];
  const uren = sqlRij(`select id, source, minutes, calendar_event_link_id from public.time_entries where calendar_event_link_id = ${q(link.id)}`);
  verwacht(uren && uren.source === 'calendar' && uren.minutes === 90, `geen afgeleide urenpost: ${JSON.stringify(uren)}`);
  return { link, urenId: uren.id };
}

// ── Het scenario ────────────────────────────────────────────────────────────

export default async function agendaScenario() {
  groep('Agenda koppelen: Google');
  const w = await stap('wereld maken', () => maakWereld('agenda'));
  if (!w) return;
  const nu = Date.now();
  const iso = (uren) => new Date(nu + uren * 3_600_000).toISOString();

  const googleJan = account('google-jan', {
    provider: 'google', id: `g-${randomUUID()}`, email: `jan.${randomUUID().slice(0, 8)}@gmail.test`, naam: 'Jan Medewerker',
    agendas: [
      { id: 'primair', summary: 'Jan', primary: true, accessRole: 'owner', backgroundColor: '#9fe1e7', selected: true, timeZone: 'Europe/Amsterdam' },
      { id: 'feestdagen', summary: 'Feestdagen in Nederland', accessRole: 'reader', backgroundColor: '#16a765', selected: true },
      { id: 'verborgen', summary: 'Oud project', accessRole: 'owner', hidden: true, selected: false },
      { id: 'gedeeld-werk', summary: 'Teamplanning', summaryOverride: 'Planning team', accessRole: 'writer', selected: false, backgroundColor: 'geen-kleur' },
      { id: 'verjaardagen', summary: 'Verjaardagen', accessRole: 'reader', selected: false },
    ],
  });
  googleJan.afspraken.primair = [
    { id: 'evt-open', status: 'confirmed', summary: 'Intake klant A', start: { dateTime: iso(2) }, end: { dateTime: iso(3) } },
    { id: 'evt-prive', status: 'confirmed', summary: 'Tandarts (privé)', visibility: 'private', description: 'wortelkanaal', start: { dateTime: iso(5) }, end: { dateTime: iso(6) } },
  ];
  googleJan.afspraken.feestdagen = [{ id: 'evt-feest', status: 'confirmed', summary: 'Sinterklaas', start: { date: '2026-12-05' }, end: { date: '2026-12-06' } }];
  googleJan.afspraken['gedeeld-werk'] = [{ id: 'evt-werk', status: 'confirmed', summary: 'Werksessie', start: { dateTime: iso(-70) }, end: { dateTime: iso(-68.5) } }];

  const start = await stap('koppelen starten: een Google-link met accountkeuze en een ondertekende state', async () => {
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'oauthStart', { provider: 'google', returnTo: `${ORIGIN}/#calendar-connections` }), 'starten');
    const url = new URL(res.authUrl);
    gelijk(url.origin, 'https://accounts.google.com', 'naar Google');
    gelijk(url.searchParams.get('prompt'), 'select_account consent', 'accountkeuze en toestemming');
    gelijk(url.searchParams.get('access_type'), 'offline', 'vernieuwtoken gevraagd');
    verwacht(url.searchParams.get('redirect_uri').endsWith('/functions/v1/calendar-integrations'), 'callback is de edge function');
    verwacht((url.searchParams.get('state') ?? '').split('.').length === 2, 'state is ondertekend');
    return res;
  });

  await stap('een vreemd terugkeeradres wordt geweigerd (anders lekt de code naar die site)', async () => {
    const res = await agenda(w.medewerker.token, w.orgId, 'oauthStart', { provider: 'google', returnTo: 'https://kwaadwillend.example/vang' });
    geweigerd(res, 'vreemd adres', [400]);
    verwacht(/niet toegestaan/.test(res.json?.error ?? ''), `uitleg ontbreekt: ${res.tekst}`);
  });

  await stap('kijker en boekhouder mogen niet koppelen', async () => {
    geweigerd(await agenda(w.kijker.token, w.orgId, 'oauthStart', { provider: 'google', returnTo: `${ORIGIN}/` }), 'kijker', [403]);
    geweigerd(await agenda(w.boekhouder.token, w.orgId, 'oauthStart', { provider: 'google', returnTo: `${ORIGIN}/` }), 'boekhouder', [403]);
    geweigerd(await agenda(null, w.orgId, 'oauthStart', { provider: 'google', returnTo: `${ORIGIN}/` }), 'zonder login', [401]);
  });

  const eerste = await stap('terug van Google: de callback geeft de code door aan de app en wisselt hem niet zelf in', async () => {
    const state = stateVan(start.authUrl);
    const code = geefCode('google-jan', GOOGLE_ALLES);
    const tokenAanroepen = post.log.filter((r) => r.startsWith('oauth2.googleapis.com')).length;
    const res = await terug(`?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    const waar = locatie(res);
    gelijk(waar.origin, ORIGIN, 'terug naar de app');
    gelijk(waar.hash, '#calendar-connections', 'naar de koppelingen');
    gelijk(waar.searchParams.get('calendar_code'), code, 'code doorgegeven');
    gelijk(waar.searchParams.get('calendar_state'), state, 'state doorgegeven');
    gelijk(res.headers.get('cache-control'), 'no-store', 'niet in een cache');
    gelijk(post.log.filter((r) => r.startsWith('oauth2.googleapis.com')).length, tokenAanroepen, 'geen tokenaanroep in de callback');
    verwacht(nep.codes.has(code), 'de code is nog niet gebruikt');
    return { code, state };
  });

  await stap('annuleren bij Google: terug naar de app met een vaste code, niet met de tekst van Google', async () => {
    const state = stateVan(start.authUrl);
    const res = await terug(`?error=access_denied&error_description=${encodeURIComponent('<b>Bel 0900-1234</b>')}&state=${encodeURIComponent(state)}`);
    const waar = locatie(res);
    gelijk(waar.origin, ORIGIN, 'terug naar de app');
    gelijk(waar.searchParams.get('calendar_error'), 'geweigerd', 'foutcode');
    gelijk(waar.searchParams.get('calendar_provider'), 'google', 'provider');
    verwacht(!waar.href.includes('0900'), 'tekst van buiten staat in het adres');
  });

  await stap('een vervalste state: terug naar de app zelf, niet naar het adres erin', async () => {
    const vals = onderteken({ provider: 'google', userId: w.medewerker.id, organizationId: w.orgId, returnTo: 'https://kwaadwillend.example/', nonce: randomUUID(), iat: Math.floor(nu / 1000), exp: Math.floor(nu / 1000) + 600 }, 'verkeerd-geheim');
    const waar = locatie(await terug(`?code=x&state=${encodeURIComponent(vals)}`));
    gelijk(waar.origin, ORIGIN, 'naar de app');
    gelijk(waar.searchParams.get('calendar_error'), 'ongeldig', 'foutcode');
    gelijk(waar.searchParams.get('calendar_code'), null, 'geen code doorgegeven');
    const zonder = locatie(await terug('?code=x'));
    gelijk(zonder.searchParams.get('calendar_error'), 'ongeldig', 'zonder state');
  });

  await stap('een verlopen state: terug met "duurde te lang" in plaats van een JSON-foutpagina', async () => {
    const oud = onderteken({ provider: 'microsoft', userId: w.medewerker.id, organizationId: w.orgId, returnTo: `${ORIGIN}/`, nonce: randomUUID(), iat: Math.floor(nu / 1000) - 3600, exp: Math.floor(nu / 1000) - 1800 });
    const waar = locatie(await terug(`?code=x&state=${encodeURIComponent(oud)}`));
    gelijk(waar.searchParams.get('calendar_error'), 'verlopen', 'foutcode');
    gelijk(waar.searchParams.get('calendar_provider'), 'microsoft', 'provider');
  });

  await stap('een collega kan andermans koppeling niet afronden, en verbruikt de code niet', async () => {
    const res = await agenda(w.beheerder.token, w.orgId, 'oauthComplete', eerste);
    geweigerd(res, 'collega', [403]);
    verwacht(/ander account/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    verwacht(nep.codes.has(eerste.code), 'de code is toch ingewisseld');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_connections where organization_id = ${q(w.orgId)}`).n, 0, 'koppelingen');
  });

  const koppeling = await stap('afronden: koppeling, versleutelde tokens en agenda\'s met de juiste beginstand', async () => {
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'oauthComplete', eerste), 'afronden');
    gelijk(res.provider, 'google', 'provider');
    gelijk(res.account, googleJan.email, 'account');
    gelijk(res.organizationId, w.orgId, 'organisatie');
    const conn = sqlRij(`select * from public.calendar_connections where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    gelijk(conn.status, 'active', 'status');
    const tok = sqlRij(`select access_token_encrypted, refresh_token_encrypted from public.calendar_connection_tokens where connection_id = ${q(conn.id)}`);
    verwacht(tok.refresh_token_encrypted && !tok.refresh_token_encrypted.includes('vernieuw-'), 'vernieuwtoken staat leesbaar in de database');
    verwacht(!tok.access_token_encrypted.includes('toegang-'), 'toegangstoken staat leesbaar in de database');
    const rijen = bronnen(conn.id);
    gelijk(rijen.length, 5, 'alle agenda\'s, ook na de eerste pagina en de verborgen');
    verwacht(nep.lijstPaginas.filter((p) => p.provider === 'google').every((p) => p.showHidden === 'true'), 'verborgen agenda\'s niet meegevraagd');
    const per = Object.fromEntries(rijen.map((r) => [r.provider_calendar_id, r]));
    gelijk([per.primair.sync_enabled, per.primair.write_enabled], [true, true], 'hoofdagenda: tonen en schrijven');
    gelijk([per.feestdagen.sync_enabled, per.feestdagen.write_enabled], [true, false], 'feestdagen: tonen, niet schrijven');
    gelijk(per.verborgen.sync_enabled, false, 'verborgen agenda staat uit');
    gelijk([per['gedeeld-werk'].sync_enabled, per['gedeeld-werk'].write_enabled], [false, false], 'niet aangevinkt bij Google: uit');
    gelijk(per['gedeeld-werk'].name, 'Planning team', 'de eigen naam uit Google');
    gelijk(per['gedeeld-werk'].color, null, 'geen kleur die geen kleur is');
    verwacht(rijen.every((r) => r.visibility === 'private'), 'een nieuwe agenda is niet privé');
    return { conn, per };
  });
  if (!koppeling) return;

  await stap('de code is eenmalig: nog eens afronden mislukt netjes', async () => {
    const res = await agenda(w.medewerker.token, w.orgId, 'oauthComplete', eerste);
    geweigerd(res, 'tweede keer', [400]);
    verwacht(/al gebruikt of verlopen/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
  });

  await stap('zonder agenda-vinkje bij Google: geen koppeling, wel uitleg', async () => {
    account('google-zonder', { provider: 'google', id: `g-${randomUUID()}`, email: 'zonder@gmail.test', naam: 'Zonder', agendas: [{ id: 'p', primary: true, accessRole: 'owner' }] });
    const r = await rondgang(w.medewerker, w.orgId, 'google', 'google-zonder', `openid email ${G}contacts.readonly`);
    const res = await agenda(w.medewerker.token, w.orgId, 'oauthComplete', { code: r.code, state: r.state });
    geweigerd(res, 'zonder agendarecht', [400]);
    verwacht(/geen toegang tot je agenda/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_connections where provider_account_email = 'zonder@gmail.test'`).n, 0, 'koppeling gemaakt');
  });

  await stap('privé: een collega ziet de koppeling en de afspraken niet', async () => {
    const lijst = gelukt(await agenda(w.beheerder.token, w.orgId, 'listIntegrations'), 'lijst');
    gelijk(lijst.connections.length, 0, 'koppelingen van een ander');
    gelijk(lijst.sources.length, 0, 'agenda\'s van een ander');
    const items = gelukt(await agenda(w.beheerder.token, w.orgId, 'listEvents', { start: iso(-200), end: iso(200) }), 'afspraken');
    gelijk(items.events.length, 0, 'afspraken van een ander');
  });

  await stap('gedeeld: een collega ziet de agenda, maar niet wat in Google privé is', async () => {
    gelukt(await agenda(w.medewerker.token, w.orgId, 'updateSource', { sourceId: koppeling.per.primair.id, patch: { visibility: 'organization' } }), 'delen');
    const lijst = gelukt(await agenda(w.beheerder.token, w.orgId, 'listIntegrations'), 'lijst');
    gelijk(lijst.connections.length, 1, 'gedeelde koppeling');
    gelijk([lijst.connections[0].provider_account_email, lijst.connections[0].display_name], [null, 'Gedeelde agenda'], 'accountgegevens afgeschermd');
    const items = gelukt(await agenda(w.beheerder.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken').events;
    const open = items.find((e) => e.provider_event_id === 'evt-open');
    const prive = items.find((e) => e.provider_event_id === 'evt-prive');
    gelijk(open?.title, 'Intake klant A', 'gewone afspraak');
    gelijk([prive?.title, prive?.description, prive?.is_private_masked], ['Bezet', null, true], 'privé in Google blijft privé');
    verwacht(!JSON.stringify(items).includes('wortelkanaal'), 'omschrijving van een privé-afspraak lekt');
  });

  await stap('de eigenaar ziet alles van zijn eigen agenda', async () => {
    const items = gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken').events;
    gelijk(items.find((e) => e.provider_event_id === 'evt-prive')?.title, 'Tandarts (privé)', 'eigen privé-afspraak');
  });

  await stap('een notitie bij een gedeelde afspraak: maken en een bestaande koppelen (stond sinds 1 november stuk)', async () => {
    const afspraak = {
      p_provider: 'google', p_calendar_source_id: koppeling.per.primair.id, p_provider_calendar_id: 'primair',
      p_provider_event_id: 'evt-open', p_event_starts_at: iso(2), p_event_ends_at: iso(3), p_event_title_snapshot: 'Intake klant A',
      p_event_location_snapshot: null, p_event_html_link: null, p_visibility_snapshot: 'organization', p_is_private_masked_snapshot: false,
    };
    const res = await rest('rpc/create_note_with_calendar_link', {
      method: 'POST', token: w.beheerder.token,
      body: { p_organization_id: w.orgId, p_client_id: w.klantA.id, p_project_id: null, p_title: 'Verslag intake', p_content: 'Afspraken', p_note_type: 'general', p_tags: [], ...afspraak },
    });
    gelukt(res, 'notitie met afspraak');
    const notitie = gelukt(await rest('notes?select=id', {
      method: 'POST', token: w.beheerder.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, title: 'Losse notitie', content: '' },
    }), 'losse notitie')[0];
    const link = await rest('note_calendar_links?on_conflict=organization_id,note_id,provider,calendar_source_id,provider_event_id,event_starts_at&select=id', {
      method: 'POST', token: w.beheerder.token, prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        organization_id: w.orgId, created_by: w.beheerder.id, note_id: notitie.id, provider: 'google', calendar_source_id: koppeling.per.primair.id,
        provider_calendar_id: 'primair', provider_event_id: 'evt-open', event_starts_at: iso(2), event_ends_at: iso(3),
        event_title_snapshot: 'Intake klant A', visibility_snapshot: 'organization', is_private_masked_snapshot: false,
      },
    });
    gelukt(link, 'bestaande notitie koppelen');
  });

  await stap('een collega kan niets aan andermans koppeling of agenda veranderen', async () => {
    geweigerd(await agenda(w.beheerder.token, w.orgId, 'updateSource', { sourceId: koppeling.per.primair.id, patch: { write_enabled: false } }), 'instelling', [400]);
    geweigerd(await agenda(w.beheerder.token, w.orgId, 'disconnectConnection', { connectionId: koppeling.conn.id }), 'loskoppelen', [400]);
    geweigerd(await agenda(w.beheerder.token, w.orgId, 'refreshSources', { connectionId: koppeling.conn.id }), 'verversen', [400]);
    gelijk(sqlRij(`select write_enabled from public.calendar_sources where id = ${q(koppeling.per.primair.id)}`).write_enabled, true, 'schrijven');
  });

  await stap('een verdwenen agenda zet de koppeling niet op "fout" (en schrijven niet op slot)', async () => {
    gelukt(await agenda(w.medewerker.token, w.orgId, 'updateSource', { sourceId: koppeling.per['gedeeld-werk'].id, patch: { sync_enabled: true } }), 'tonen aan');
    nep.weg.add('gedeeld-werk');
    const items = gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken').events;
    verwacht(items.some((e) => e.provider_event_id === 'evt-open'), 'de andere agenda\'s werken niet meer');
    gelijk(sqlRij(`select status from public.calendar_connections where id = ${q(koppeling.conn.id)}`).status, 'active', 'status');
    gelijk(sqlRij(`select sync_enabled from public.calendar_sources where id = ${q(koppeling.per['gedeeld-werk'].id)}`).sync_enabled, false, 'verdwenen agenda uit');
    nep.weg.delete('gedeeld-werk');
  });

  await stap('een oude foutstatus verdwijnt zodra alles weer werkt', async () => {
    sql(`update public.calendar_connections set status = 'error', last_error = 'Bad Request' where id = ${q(koppeling.conn.id)}`);
    gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken');
    const conn = sqlRij(`select status, last_error from public.calendar_connections where id = ${q(koppeling.conn.id)}`);
    gelijk([conn.status, conn.last_error], ['active', null], 'hersteld');
  });

  await stap('met status "fout" kun je toch een afspraak in je hoofdagenda zetten', async () => {
    sql(`update public.calendar_connections set status = 'error', last_error = 'Agenda "Planning team": Not Found' where id = ${q(koppeling.conn.id)}`);
    const res = await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: koppeling.per.primair.id, title: 'Nieuwe afspraak', startsAt: iso(30), endsAt: iso(31) } });
    gelukt(res, 'afspraak maken');
    verwacht(googleJan.afspraken.primair.some((e) => e.summary === 'Nieuwe afspraak'), 'niet bij Google aangekomen');
  });

  await stap('een storing bij Google laat de koppeling met rust', async () => {
    sql(`update public.calendar_connections set status = 'active', last_error = null where id = ${q(koppeling.conn.id)};
         update public.calendar_connection_tokens set expires_at = now() - interval '1 hour' where connection_id = ${q(koppeling.conn.id)}`);
    nep.vernieuwFout = { status: 503, body: { error: 'backend_error' } };
    gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken');
    gelijk(sqlRij(`select status from public.calendar_connections where id = ${q(koppeling.conn.id)}`).status, 'active', 'status na storing');
  });

  await stap('Google trekt de toegang in: "verlopen" met uitleg, en schrijven zegt "koppel opnieuw"', async () => {
    nep.vernieuwFout = { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } };
    gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken');
    const conn = sqlRij(`select status, last_error from public.calendar_connections where id = ${q(koppeling.conn.id)}`);
    gelijk(conn.status, 'expired', 'status');
    verwacht(/Koppel het account opnieuw/.test(conn.last_error) && !/Bad Request/.test(conn.last_error), `uitleg: ${conn.last_error}`);
    const res = await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: koppeling.per.primair.id, title: 'Gaat niet', startsAt: iso(40), endsAt: iso(41) } });
    geweigerd(res, 'schrijven zonder toegang', [409]);
    verwacht(/Koppel het account opnieuw/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    nep.vernieuwFout = null;
  });

  await stap('opnieuw koppelen: het bekende account klaar, en alles blijft staan', async () => {
    const r = await rondgang(w.medewerker, w.orgId, 'google', 'google-jan', GOOGLE_ALLES, { loginHint: googleJan.email });
    const url = new URL(r.authUrl);
    gelijk([url.searchParams.get('login_hint'), url.searchParams.get('prompt')], [googleJan.email, 'consent'], 'hint en toestemming');
    gelukt(await agenda(w.medewerker.token, w.orgId, 'oauthComplete', { code: r.code, state: r.state }), 'afronden');
    const conn = sqlRij(`select id, status, last_error from public.calendar_connections where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    gelijk([conn.id, conn.status, conn.last_error], [koppeling.conn.id, 'active', null], 'dezelfde koppeling, weer actief');
    const per = Object.fromEntries(bronnen(conn.id).map((b) => [b.provider_calendar_id, b]));
    gelijk(per.primair.id, koppeling.per.primair.id, 'dezelfde agenda');
    gelijk([per.primair.visibility, per.primair.write_enabled], ['organization', true], 'eigen instellingen bewaard');
  });

  await stap('een agenda die bij Google weg is, gaat bij "Agenda\'s ophalen" uit de lijst; de uren blijven', async () => {
    const bron = { ...koppeling.per['gedeeld-werk'], provider: 'google' };
    const { urenId } = await koppelAanKlant(w.medewerker, w.orgId, bron, 'evt-werk', w.klantA.id);
    googleJan.agendas = googleJan.agendas.filter((a) => a.id !== 'gedeeld-werk');
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'refreshSources', { connectionId: koppeling.conn.id }), 'ophalen');
    verwacht(!res.sources.some((s) => s.provider_calendar_id === 'gedeeld-werk'), 'verdwenen agenda staat er nog');
    gelijk(bronnen(koppeling.conn.id).length, 4, 'agenda\'s over');
    const uren = sqlRij(`select source, minutes, calendar_event_link_id, client_id from public.time_entries where id = ${q(urenId)}`);
    gelijk([uren?.source, uren?.minutes, uren?.calendar_event_link_id, uren?.client_id], ['manual', 90, null, w.klantA.id], 'urenpost bewaard en los van de afspraak');
  });

  await stap('een lege lijst van Google wist niets (elk account heeft een hoofdagenda)', async () => {
    const bewaard = googleJan.agendas;
    googleJan.agendas = [];
    gelukt(await agenda(w.medewerker.token, w.orgId, 'refreshSources', { connectionId: koppeling.conn.id }), 'ophalen');
    gelijk(bronnen(koppeling.conn.id).length, 4, 'agenda\'s na een lege lijst');
    googleJan.agendas = bewaard;
  });

  const tweedeOrg = await stap('hetzelfde Google-account in een tweede organisatie', async () => {
    const w2 = await maakWereld('agenda-b');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status)
         values (${q(w2.orgId)}, ${q(w.medewerker.id)}, ${q(w.medewerker.email)}, 'member', 'active') on conflict do nothing`);
    const r = await rondgang(w.medewerker, w2.orgId, 'google', 'google-jan', GOOGLE_ALLES);
    gelukt(await agenda(w.medewerker.token, w2.orgId, 'oauthComplete', { code: r.code, state: r.state }), 'afronden in B');
    return w2;
  });

  await stap('loskoppelen: de toestemming blijft als het account elders nog gekoppeld is; de uren blijven', async () => {
    const bron = { ...koppeling.per.primair, provider: 'google' };
    const { urenId } = await koppelAanKlant(w.medewerker, w.orgId, bron, 'evt-open', w.klantA.id);
    const voor = nep.ingetrokken.length;
    gelukt(await agenda(w.medewerker.token, w.orgId, 'disconnectConnection', { connectionId: koppeling.conn.id }), 'loskoppelen');
    gelijk(nep.ingetrokken.length, voor, 'Google-toestemming ingetrokken terwijl organisatie B hem nog gebruikt');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_connections where id = ${q(koppeling.conn.id)}`).n, 0, 'koppeling weg');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_sources where connection_id = ${q(koppeling.conn.id)}`).n, 0, 'agenda\'s weg');
    const uren = sqlRij(`select source, calendar_event_link_id from public.time_entries where id = ${q(urenId)}`);
    gelijk([uren?.source, uren?.calendar_event_link_id], ['manual', null], 'urenpost bewaard');
    if (tweedeOrg) {
      gelijk(sqlRij(`select status from public.calendar_connections where organization_id = ${q(tweedeOrg.orgId)} and user_id = ${q(w.medewerker.id)}`).status, 'active', 'koppeling in B');
    }
  });

  await stap('loskoppelen van de laatste: de toestemming bij Google wordt ingetrokken, met het vernieuwtoken', async () => {
    if (!tweedeOrg) throw new Error('tweede organisatie ontbreekt');
    const conn = sqlRij(`select id from public.calendar_connections where organization_id = ${q(tweedeOrg.orgId)} and user_id = ${q(w.medewerker.id)}`);
    const voor = nep.ingetrokken.length;
    gelukt(await agenda(w.medewerker.token, tweedeOrg.orgId, 'disconnectConnection', { connectionId: conn.id }), 'loskoppelen');
    gelijk(nep.ingetrokken.length, voor + 1, 'ingetrokken');
    verwacht(String(nep.ingetrokken.at(-1)).startsWith('vernieuw-'), `niet het vernieuwtoken: ${nep.ingetrokken.at(-1)}`);
  });

  groep('Agenda koppelen: Microsoft');
  const msPiet = account('ms-piet', {
    provider: 'microsoft', id: `m-${randomUUID()}`, email: `piet.${randomUUID().slice(0, 8)}@bedrijf.test`, naam: 'Piet Beheerder',
    agendas: [
      { id: 'ms-agenda', name: 'Agenda', isDefaultCalendar: true, canEdit: true, color: 'auto', hexColor: '#3b82f6' },
      { id: 'ms-verjaardagen', name: 'Verjaardagen', isDefaultCalendar: false, canEdit: false, color: 'lightGreen', hexColor: '' },
      { id: 'ms-project', name: 'Project X', isDefaultCalendar: false, canEdit: true, color: 'lightRed', hexColor: '#ef4444' },
    ],
  });
  msPiet.afspraken['ms-agenda'] = [
    { id: 'ms-1', subject: 'Overleg', start: { dateTime: iso(1).replace('Z', '') }, end: { dateTime: iso(2).replace('Z', '') }, sensitivity: 'normal' },
    { id: 'ms-2', subject: 'Sollicitatie', bodyPreview: 'vertrouwelijk', start: { dateTime: iso(3).replace('Z', '') }, end: { dateTime: iso(4).replace('Z', '') }, sensitivity: 'private' },
  ];

  await stap('koppelen starten: een Microsoft-link met accountkiezer', async () => {
    const res = gelukt(await agenda(w.beheerder.token, w.orgId, 'oauthStart', { provider: 'microsoft', returnTo: `${ORIGIN}/` }), 'starten');
    const url = new URL(res.authUrl);
    gelijk(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'naar Microsoft');
    gelijk(url.searchParams.get('prompt'), 'select_account', 'accountkiezer');
  });

  const msKoppeling = await stap('afronden: alle agenda\'s, ook na de eerste pagina, met hun echte kleur', async () => {
    const r = await rondgang(w.beheerder, w.orgId, 'microsoft', 'ms-piet', MS_ALLES);
    const res = gelukt(await agenda(w.beheerder.token, w.orgId, 'oauthComplete', { code: r.code, state: r.state }), 'afronden');
    gelijk(res.provider, 'microsoft', 'provider');
    const conn = sqlRij(`select * from public.calendar_connections where organization_id = ${q(w.orgId)} and user_id = ${q(w.beheerder.id)}`);
    const per = Object.fromEntries(bronnen(conn.id).map((b) => [b.provider_calendar_id, b]));
    gelijk(Object.keys(per).length, 3, 'agenda\'s');
    verwacht(nep.lijstPaginas.some((p) => p.provider === 'microsoft' && p.top === '100'), 'zonder $top geeft Graph er tien');
    gelijk([per['ms-agenda'].color, per['ms-agenda'].write_enabled, per['ms-agenda'].sync_enabled], ['#3b82f6', true, true], 'hoofdagenda');
    gelijk([per['ms-verjaardagen'].color, per['ms-verjaardagen'].write_enabled], [null, false], 'verjaardagen');
    gelijk(per['ms-project'].write_enabled, false, 'alleen de hoofdagenda is meteen schrijfbaar');
    return { conn, per };
  });

  await stap('gedeelde Outlook-agenda: een afspraak die in Outlook privé is, blijft afgeschermd', async () => {
    if (!msKoppeling) throw new Error('geen Microsoft-koppeling');
    gelukt(await agenda(w.beheerder.token, w.orgId, 'updateSource', { sourceId: msKoppeling.per['ms-agenda'].id, patch: { visibility: 'organization' } }), 'delen');
    const items = gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken').events;
    gelijk(items.find((e) => e.provider_event_id === 'ms-1')?.title, 'Overleg', 'gewone afspraak');
    gelijk(items.find((e) => e.provider_event_id === 'ms-2')?.title, 'Bezet', 'privé in Outlook');
    verwacht(!JSON.stringify(items).includes('vertrouwelijk'), 'inhoud van een privé-afspraak lekt');
  });

  await stap('Microsoft zonder agendarecht: geen koppeling, wel uitleg', async () => {
    account('ms-zonder', { provider: 'microsoft', id: `m-${randomUUID()}`, email: 'zonder@bedrijf.test', naam: 'Zonder', agendas: [] });
    const r = await rondgang(w.medewerker, w.orgId, 'microsoft', 'ms-zonder', 'openid profile https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read');
    const res = await agenda(w.medewerker.token, w.orgId, 'oauthComplete', { code: r.code, state: r.state });
    geweigerd(res, 'zonder Calendars.ReadWrite', [400]);
    verwacht(/Microsoft gaf geen toegang tot je agenda/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
  });

  await stap('beheerder moet eerst toestemming geven: vaste code "beheerder"', async () => {
    const start = gelukt(await agenda(w.medewerker.token, w.orgId, 'oauthStart', { provider: 'microsoft', returnTo: `${ORIGIN}/` }), 'starten');
    const waar = locatie(await terug(`?error=access_denied&error_description=${encodeURIComponent('AADSTS65001: The user or administrator has not consented to use the application')}&state=${encodeURIComponent(stateVan(start.authUrl))}`));
    gelijk(waar.searchParams.get('calendar_error'), 'beheerder', 'foutcode');
  });

  groep('Agenda: vertrek van een teamlid en andere organisaties');

  await stap('vertrekt het teamlid, dan is zijn koppeling ingetrokken en blijft dat zo', async () => {
    if (!msKoppeling) throw new Error('geen Microsoft-koppeling');
    sql(`update public.organization_members set status = 'disabled' where organization_id = ${q(w.orgId)} and user_id = ${q(w.beheerder.id)}`);
    const conn = sqlRij(`select status from public.calendar_connections where id = ${q(msKoppeling.conn.id)}`);
    gelijk(conn.status, 'revoked', 'status na vertrek');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_connection_tokens where connection_id = ${q(msKoppeling.conn.id)}`).n, 0, 'tokens');
    const items = gelukt(await agenda(w.medewerker.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken').events;
    verwacht(!items.some((e) => e.provider === 'microsoft'), 'afspraken van een vertrokken teamlid');
    const na = sqlRij(`select status, last_error from public.calendar_connections where id = ${q(msKoppeling.conn.id)}`);
    gelijk(na.status, 'revoked', 'de agendaweergave overschreef "ingetrokken"');
    verwacht(/teamlid is uit de organisatie/.test(na.last_error ?? ''), `reden weg: ${na.last_error}`);
  });

  await stap('iemand uit een andere organisatie kan niets met deze agenda\'s', async () => {
    const vreemde = await maakGebruiker('agenda-vreemd');
    geweigerd(await agenda(vreemde.token, w.orgId, 'listIntegrations'), 'lijst', [403]);
    geweigerd(await agenda(vreemde.token, w.orgId, 'listEvents', { start: iso(-1), end: iso(24) }), 'afspraken', [403]);
    if (tweedeOrg && msKoppeling) {
      // Lid van B, met het id van een agenda uit A en organisatie B: niet gevonden.
      const res = await agenda(tweedeOrg.medewerker.token, tweedeOrg.orgId, 'updateSource', { sourceId: msKoppeling.per['ms-agenda'].id, patch: { visibility: 'private' } });
      geweigerd(res, 'agenda uit A via B', [400]);
      gelijk(sqlRij(`select visibility from public.calendar_sources where id = ${q(msKoppeling.per['ms-agenda'].id)}`).visibility, 'organization', 'instelling in A');
    }
  });

  await stap('de cron voor ICS-abonnementen wil zijn geheim', async () => {
    geweigerd(await roep('calendar-integrations', { method: 'POST', query: '?cron=ics', body: {} }), 'zonder geheim', [401]);
  });
}
