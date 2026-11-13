// De agendaserver (workers/caldav): de ResoFly-agenda op een telefoon of
// computer (CalDAV), en deellinks voor mensen buiten ResoFly. De echte Worker
// draait hier in Node tegen de lokale database; app-wachtwoorden en deellinks
// komen uit de echte edge function `calendar-integrations`.
//
// Waarom zo: de Worker gebruikt de service-role en slaat RLS dus over. Of een
// telefoon alleen de eigen organisatie ziet, een alleen-lezen-lid niets kan
// wijzigen en een ingetrokken link echt dicht is, zie je pas als de Worker,
// de database-functies en de edge function samen draaien.
//
//   npm run test:stromen -- caldav
import worker from '../../workers/caldav/src/index.ts';
import { API_URL, SERVICE_KEY } from './omgeving.mjs';
import { roep } from './functies.mjs';
import { rest, rpc, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const ENV = { SUPABASE_URL: API_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const HOST = 'https://caldav.stromen.test';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function agenda(token, orgId, action, body = {}) {
  return roep('calendar-integrations', { token, body: { action, organizationId: orgId, ...body } });
}

/** Een verzoek aan de Worker, zoals een agenda-app het doet. */
async function dav(method, pad, { wie, body, headers = {} } = {}) {
  const kop = { ...headers };
  if (wie) kop.authorization = `Basic ${Buffer.from(`${wie.email}:${wie.wachtwoord}`, 'utf8').toString('base64')}`;
  if (body !== undefined && !kop['content-type']) kop['content-type'] = method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8';
  const res = await worker.fetch(new Request(`${HOST}${pad}`, { method, headers: kop, body }), ENV);
  const tekst = method === 'HEAD' ? '' : await res.text();
  return { status: res.status, tekst, headers: res.headers };
}

async function appWachtwoord(gebruiker, orgId, label = 'iPhone') {
  const uit = gelukt(await agenda(gebruiker.token, orgId, 'createAppPassword', { label }), `app-wachtwoord ${gebruiker.email}`);
  return { email: gebruiker.email, wachtwoord: uit.secret, id: uit.appPassword.id };
}

function hrefs(xml) {
  return [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => decodeURIComponent(m[1]));
}

function namen(xml) {
  return [...xml.matchAll(/<D:displayname>([^<]*)<\/D:displayname>/g)].map((m) => m[1]);
}

function iphoneAfspraak(uid, titel, { dag = '20261116', omschrijving = null } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.1//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261110T090000Z',
    `DTSTART;TZID=Europe/Amsterdam:${dag}T090000`, `DTEND;TZID=Europe/Amsterdam:${dag}T100000`,
    `SUMMARY:${titel}`, 'LOCATION:Kantoor',
    ...(omschrijving ? [`DESCRIPTION:${omschrijving}`] : []),
    'ATTENDEE;CN=Jan:mailto:jan@klant.test',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Herinnering', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

const QUERY_ETAGS = '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>';
const PROP_ALL = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

export default async function caldav() {
  const w = await maakWereld('caldav');
  const v = await maakWereld('caldav-ander');

  let kantoor, team, prive;
  let eigenaar, medewerker, kijker;

  groep('CalDAV: inloggen en de agenda\'s die je ziet');

  await stap('klaarzetten: agenda\'s en app-wachtwoorden via de app', async () => {
    kantoor = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createNativeCalendar', { name: 'Kantoor' }), 'agenda Kantoor').source;
    team = gelukt(await agenda(w.medewerker.token, w.orgId, 'createNativeCalendar', { name: 'Team', visibility: 'organization' }), 'agenda Team').source;
    prive = gelukt(await agenda(w.medewerker.token, w.orgId, 'createNativeCalendar', { name: 'Privé medewerker' }), 'agenda Privé').source;
    eigenaar = await appWachtwoord(w.eigenaar, w.orgId);
    medewerker = await appWachtwoord(w.medewerker, w.orgId);
    kijker = await appWachtwoord(w.kijker, w.orgId);
    verwacht(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/.test(eigenaar.wachtwoord), `vorm van het app-wachtwoord: ${eigenaar.wachtwoord}`);
  });

  await stap('zonder of met een verkeerd wachtwoord: niets', async () => {
    gelijk((await dav('PROPFIND', '/', {})).status, 401, 'zonder inlog');
    const fout = await dav('PROPFIND', '/', { wie: { ...eigenaar, wachtwoord: 'aaaaa-bbbbb-ccccc-ddddd' } });
    gelijk(fout.status, 401, 'verkeerd wachtwoord');
    verwacht(/Basic realm/.test(fout.headers.get('www-authenticate') ?? ''), 'vraagt om inloggen');
    // Het wachtwoord van de een met het mailadres van de ander werkt niet.
    gelijk((await dav('PROPFIND', '/', { wie: { email: w.medewerker.email, wachtwoord: eigenaar.wachtwoord } })).status, 401, 'kruislings');
    gelijk((await dav('OPTIONS', '/', {})).status, 204, 'OPTIONS zonder inlog');
  });

  await stap('de iPhone vindt zijn agenda\'s via .well-known', async () => {
    const res = await dav('PROPFIND', '/.well-known/caldav', { wie: eigenaar, body: PROP_ALL, headers: { depth: '0' } });
    gelijk(res.status, 207, 'status');
    verwacht(res.tekst.includes(`<C:calendar-home-set><D:href>/calendars/${w.eigenaar.id}/</D:href>`), 'calendar-home-set');
    // Een wachtwoord met spaties of hoofdletters (overgetypt) werkt ook.
    const getypt = { ...eigenaar, wachtwoord: eigenaar.wachtwoord.toUpperCase().replace(/-/g, ' ') };
    gelijk((await dav('PROPFIND', '/.well-known/caldav', { wie: getypt, body: PROP_ALL })).status, 207, 'overgetypt');
  });

  await stap('eigen agenda\'s en wat het team deelt, niet de privé-agenda van een collega', async () => {
    const res = await dav('PROPFIND', `/calendars/${w.eigenaar.id}/`, { wie: eigenaar, body: PROP_ALL, headers: { depth: '1' } });
    gelijk(res.status, 207, 'status');
    const n = namen(res.tekst);
    verwacht(n.includes('Kantoor') && n.includes('Team'), `ziet: ${n.join(', ')}`);
    verwacht(!n.includes('Privé medewerker'), 'de privé-agenda van een collega');
    gelijk((await dav('PROPFIND', `/calendars/${w.eigenaar.id}/${prive.id}/`, { wie: eigenaar, headers: { depth: '0' } })).status, 404, 'privé-agenda rechtstreeks');
    gelijk((await dav('PROPFIND', `/calendars/${w.medewerker.id}/`, { wie: eigenaar, headers: { depth: '1' } })).status, 403, 'het pad van een ander');
  });

  await stap('een andere organisatie bestaat niet', async () => {
    const ander = await appWachtwoord(v.eigenaar, v.orgId);
    const home = await dav('PROPFIND', `/calendars/${v.eigenaar.id}/`, { wie: ander, headers: { depth: '1' } });
    verwacht(!namen(home.tekst).includes('Kantoor'), 'ziet Kantoor van een andere organisatie');
    gelijk((await dav('PROPFIND', `/calendars/${v.eigenaar.id}/${kantoor.id}/`, { wie: ander, headers: { depth: '1' } })).status, 404, 'agenda-id van een andere organisatie');
    gelijk((await dav('PUT', `/calendars/${v.eigenaar.id}/${kantoor.id}/inbraak.ics`, { wie: ander, body: iphoneAfspraak('inbraak', 'Inbraak') })).status, 404, 'schrijven in een andere organisatie');
  });

  groep('CalDAV: afspraken heen en weer');

  let etag;
  await stap('een afspraak van de iPhone komt goed in ResoFly', async () => {
    const res = await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/iphone-1.ics`, { wie: eigenaar, body: iphoneAfspraak('iphone-1', 'Weekstart'), headers: { 'if-none-match': '*' } });
    gelijk(res.status, 201, `status ${res.tekst}`);
    etag = res.headers.get('etag');
    verwacht(etag, 'ETag');
    const rij = sqlRij(`select title, description, location, starts_at, timezone, organization_id, created_by from public.calendar_events where source_id = ${q(kantoor.id)} and uid = 'iphone-1'`);
    gelijk(rij.title, 'Weekstart', 'titel');
    gelijk(rij.description, null, 'de tekst van de herinnering is geen omschrijving');
    gelijk(new Date(rij.starts_at).toISOString(), '2026-11-16T08:00:00.000Z', '9.00 uur Amsterdam');
    gelijk(rij.timezone, 'Europe/Amsterdam', 'tijdzone');
    gelijk(rij.organization_id, w.orgId, 'organisatie');
    gelijk(rij.created_by, w.eigenaar.id, 'gemaakt door');
    // En in de app staat hij in de agenda.
    const lijst = gelukt(await agenda(w.eigenaar.token, w.orgId, 'listEvents', { start: '2026-11-15T00:00:00Z', end: '2026-11-18T00:00:00Z' }), 'agenda in de app');
    verwacht(lijst.events.some((e) => e.title === 'Weekstart'), 'de app toont de afspraak van de telefoon');
  });

  await stap('nog eens aanmaken met If-None-Match: * wordt geweigerd; met de oude ETag ook', async () => {
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/iphone-1.ics`, { wie: eigenaar, body: iphoneAfspraak('iphone-1', 'Dubbel'), headers: { 'if-none-match': '*' } })).status, 412, 'bestaat al');
    const bijgewerkt = await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/iphone-1.ics`, { wie: eigenaar, body: iphoneAfspraak('iphone-1', 'Weekstart (nieuw)'), headers: { 'if-match': etag } });
    gelijk(bijgewerkt.status, 204, 'bijwerken met de juiste ETag');
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/iphone-1.ics`, { wie: eigenaar, body: iphoneAfspraak('iphone-1', 'Oud'), headers: { 'if-match': etag } })).status, 412, 'met een oude ETag');
  });

  await stap('een afspraak uit de app staat op de telefoon', async () => {
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'createEvent', { event: { sourceId: kantoor.id, title: 'Lunch met klant', description: 'Over de offerte', location: 'Café', startsAt: '2026-11-17T11:00:00.000Z', endsAt: '2026-11-17T12:00:00.000Z' } }), 'afspraak in de app');
    const query = await dav('REPORT', `/calendars/${w.eigenaar.id}/${kantoor.id}/`, { wie: eigenaar, body: QUERY_ETAGS, headers: { depth: '1' } });
    gelijk(query.status, 207, 'calendar-query');
    gelijk(hrefs(query.tekst).length, 2, 'twee afspraken');
    verwacht(!query.tekst.includes('calendar-data'), 'zonder te vragen geen inhoud');
    const multiget = `<?xml version="1.0"?><C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop>${hrefs(query.tekst).map((h) => `<D:href>${h}</D:href>`).join('')}</C:calendar-multiget>`;
    const res = await dav('REPORT', `/calendars/${w.eigenaar.id}/${kantoor.id}/`, { wie: eigenaar, body: multiget, headers: { depth: '1' } });
    verwacht(res.tekst.includes('SUMMARY:Lunch met klant') && res.tekst.includes('DESCRIPTION:Over de offerte'), 'de afspraak uit de app, met omschrijving');
    verwacht(res.tekst.includes('Weekstart (nieuw)'), 'de afspraak van de telefoon');
  });

  let token;
  await stap('alleen de wijzigingen ophalen, ook een verwijdering', async () => {
    const eerst = await dav('REPORT', `/calendars/${w.eigenaar.id}/${kantoor.id}/`, { wie: eigenaar, body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:prop><D:getetag/></D:prop></D:sync-collection>' });
    gelijk(hrefs(eerst.tekst).length, 2, 'eerste keer alles');
    token = eerst.tekst.match(/<D:sync-token>([^<]+)<\/D:sync-token>/)[1];
    const weg = await dav('DELETE', `/calendars/${w.eigenaar.id}/${kantoor.id}/iphone-1.ics`, { wie: eigenaar });
    gelijk(weg.status, 204, 'verwijderen');
    const daarna = await dav('REPORT', `/calendars/${w.eigenaar.id}/${kantoor.id}/`, { wie: eigenaar, body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:prop><D:getetag/></D:prop></D:sync-collection>` });
    verwacht(/iphone-1\.ics<\/D:href><D:status>HTTP\/1\.1 404/.test(daarna.tekst), 'de verwijdering komt mee');
    gelijk(hrefs(daarna.tekst).length, 1, 'alleen wat er veranderde');
    // Terugzetten (ongedaan maken op de iPhone) maakt de grafsteen weer levend.
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/iphone-1.ics`, { wie: eigenaar, body: iphoneAfspraak('iphone-1', 'Terug') })).status, 201, 'terugzetten');
  });

  await stap('te groot of geen agenda-tekst: geweigerd', async () => {
    const groot = iphoneAfspraak('groot', 'Groot', { omschrijving: 'x'.repeat(600 * 1024) });
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/groot.ics`, { wie: eigenaar, body: groot })).status, 413, 'te groot');
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/leeg.ics`, { wie: eigenaar, body: 'geen agenda' })).status, 400, 'geen VEVENT');
  });

  await stap('meer dan 1000 afspraken: de telefoon krijgt ze allemaal', async () => {
    const vol = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createNativeCalendar', { name: 'Vol' }), 'agenda Vol').source;
    sql(`insert into public.calendar_events (organization_id, source_id, created_by, uid, title, starts_at, ends_at)
         select ${q(w.orgId)}, ${q(vol.id)}, ${q(w.eigenaar.id)}, 'vol-' || i, 'Afspraak ' || i,
                timestamptz '2026-01-01 08:00Z' + i * interval '1 hour', timestamptz '2026-01-01 08:30Z' + i * interval '1 hour'
         from generate_series(1, 1005) i`);
    const res = await dav('PROPFIND', `/calendars/${w.eigenaar.id}/${vol.id}/`, { wie: eigenaar, headers: { depth: '1' } });
    gelijk(hrefs(res.tekst).length, 1006, 'de agenda en 1005 afspraken');
    const sync = await dav('REPORT', `/calendars/${w.eigenaar.id}/${vol.id}/`, { wie: eigenaar, body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/></D:sync-collection>' });
    gelijk(hrefs(sync.tekst).length, 1005, 'ook bij de eerste synchronisatie');
  });

  await stap('een reeks uit de app houdt over de klokwissel zijn kloktijd, in de app, op de telefoon en in de deellink', async () => {
    // Maandag 15 maart 2027, 9.00 uur wintertijd; op 28 maart gaat de klok vooruit.
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'createEvent', { event: {
      sourceId: kantoor.id, title: 'Weekstart (reeks)', startsAt: '2027-03-15T08:00:00.000Z', endsAt: '2027-03-15T09:00:00.000Z',
      recurrence: { freq: 'weekly', until: '2027-04-30T23:59:59.000Z' },
    } }), 'reeks in de app');
    const lijst = gelukt(await agenda(w.eigenaar.token, w.orgId, 'listEvents', { start: '2027-03-14T00:00:00Z', end: '2027-04-13T00:00:00Z' }), 'agenda');
    const keren = lijst.events.filter((e) => e.title === 'Weekstart (reeks)').map((e) => e.starts_at).sort();
    gelijk(keren, ['2027-03-15T08:00:00.000Z', '2027-03-22T08:00:00.000Z', '2027-03-29T07:00:00.000Z', '2027-04-05T07:00:00.000Z', '2027-04-12T07:00:00.000Z'], 'elke maandag 9.00 uur, ook in de zomertijd');
    const uid = sqlRij(`select uid from public.calendar_events where source_id = ${q(kantoor.id)} and title = 'Weekstart (reeks)'`).uid;
    const ics = (await dav('GET', `/calendars/${w.eigenaar.id}/${kantoor.id}/${encodeURIComponent(uid)}.ics`, { wie: eigenaar })).tekst;
    verwacht(ics.includes('DTSTART;TZID=Europe/Amsterdam:20270315T090000'), `op de telefoon met tijdzone: ${ics.slice(0, 300)}`);
    verwacht(ics.includes('BEGIN:VTIMEZONE') && ics.includes('BYMONTH=3;BYDAY=-1SU'), 'met de regel voor de zomertijd');
    const feed = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createFeedLink', { sourceId: kantoor.id, label: 'Klokwissel', detail: 'busy' }), 'link');
    const tekst = (await dav('GET', `/feed/${feed.token}.ics`)).tekst;
    verwacht(tekst.includes('DTSTART;TZID=Europe/Amsterdam:20270315T090000') && tekst.includes('BEGIN:VTIMEZONE'), 'in de deellink met tijdzone');
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'revokeFeedLink', { feedLinkId: feed.feedLink.id }), 'opruimen');
  });

  await stap('een op de telefoon weggehaalde keer in de zomer valt in de app weg', async () => {
    const reeks = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.1//EN',
      'BEGIN:VEVENT', 'UID:reeks-zomer', 'DTSTAMP:20261110T090000Z',
      'DTSTART;TZID=Europe/Amsterdam:20270315T140000', 'DTEND;TZID=Europe/Amsterdam:20270315T150000',
      'RRULE:FREQ=WEEKLY;COUNT=6', 'EXDATE;TZID=Europe/Amsterdam:20270405T140000', 'SUMMARY:Sport',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${kantoor.id}/reeks-zomer.ics`, { wie: eigenaar, body: reeks })).status, 201, 'reeks van de telefoon');
    const lijst = gelukt(await agenda(w.eigenaar.token, w.orgId, 'listEvents', { start: '2027-03-14T00:00:00Z', end: '2027-05-01T00:00:00Z' }), 'agenda');
    const keren = lijst.events.filter((e) => e.title === 'Sport').map((e) => e.starts_at).sort();
    // Eerst schoof de reeks in de app in de zomer naar 15.00 uur, en bleef 5 april staan.
    gelijk(keren, ['2027-03-15T13:00:00.000Z', '2027-03-22T13:00:00.000Z', '2027-03-29T12:00:00.000Z', '2027-04-12T12:00:00.000Z', '2027-04-19T12:00:00.000Z'], 'elke maandag 14.00 uur, zonder 5 april');
  });

  groep('CalDAV: rechten');

  await stap('een collega schrijft in de gedeelde agenda, maar hernoemt hem niet', async () => {
    gelijk((await dav('PUT', `/calendars/${w.eigenaar.id}/${team.id}/team-1.ics`, { wie: eigenaar, body: iphoneAfspraak('team-1', 'Teamoverleg') })).status, 201, 'schrijven in Team');
    const hernoem = '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>Van mij</D:displayname></D:prop></D:set></D:propertyupdate>';
    gelijk((await dav('PROPPATCH', `/calendars/${w.eigenaar.id}/${team.id}/`, { wie: eigenaar, body: hernoem })).status, 403, 'hernoemen');
    gelijk(sqlRij(`select name from public.calendar_sources where id = ${q(team.id)}`).name, 'Team', 'naam ongewijzigd');
  });

  await stap('een kijker leest, maar schrijft niet', async () => {
    const res = await dav('PROPFIND', `/calendars/${w.kijker.id}/`, { wie: kijker, headers: { depth: '1' } });
    verwacht(namen(res.tekst).includes('Team'), 'ziet de gedeelde agenda');
    verwacht(!res.tekst.includes('<D:write/>'), 'geen schrijfrecht aangeboden');
    gelijk((await dav('PUT', `/calendars/${w.kijker.id}/${team.id}/kijker.ics`, { wie: kijker, body: iphoneAfspraak('kijker', 'Mag niet') })).status, 403, 'schrijven');
    gelijk((await dav('DELETE', `/calendars/${w.kijker.id}/${team.id}/team-1.ics`, { wie: kijker })).status, 403, 'verwijderen');
  });

  await stap('de boekhouder heeft geen agenda, en dus geen app-wachtwoord', async () => {
    geweigerd(await agenda(w.boekhouder.token, w.orgId, 'createAppPassword', { label: 'iPhone' }), 'app-wachtwoord voor de boekhouder');
  });

  await stap('Agenda op "geen toegang": het wachtwoord werkt niet meer', async () => {
    sql(`update public.organization_members set module_access = '{"calendar":"none"}'::jsonb where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    gelijk((await dav('PROPFIND', `/calendars/${w.medewerker.id}/`, { wie: medewerker, headers: { depth: '1' } })).status, 401, 'zonder Agenda');
    sql(`update public.organization_members set module_access = null where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    gelijk((await dav('PROPFIND', `/calendars/${w.medewerker.id}/`, { wie: medewerker, headers: { depth: '1' } })).status, 207, 'weer met Agenda');
  });

  await stap('een ingetrokken app-wachtwoord werkt niet meer', async () => {
    const extra = await appWachtwoord(w.eigenaar, w.orgId, 'Oude iPad');
    gelijk((await dav('PROPFIND', '/', { wie: extra, body: PROP_ALL })).status, 207, 'eerst wel');
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'revokeAppPassword', { appPasswordId: extra.id }), 'intrekken');
    gelijk((await dav('PROPFIND', '/', { wie: extra, body: PROP_ALL })).status, 401, 'daarna niet');
    verwacht(sqlRij(`select last_used_at from public.calendar_app_passwords where id = ${q(extra.id)}`).last_used_at, 'laatst gebruikt is bijgehouden');
  });

  groep('Deellinks: een agenda buiten ResoFly');

  let bezet, details;
  await stap('de eigenaar maakt twee links: alleen bezet, en titel, tijd en plaats', async () => {
    bezet = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createFeedLink', { sourceId: kantoor.id, label: 'Partner', detail: 'busy' }), 'link bezet');
    details = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createFeedLink', { sourceId: kantoor.id, label: 'Assistent', detail: 'details' }), 'link details');
    verwacht(/^[A-Za-z0-9_-]{43}$/.test(bezet.token), `vorm van het token: ${bezet.token}`);
    gelijk([bezet.feedLink.label, bezet.feedLink.detail], ['Partner', 'busy'], 'link bezet');
    verwacht(!('token_hash' in bezet.feedLink), 'de hash gaat niet naar de app');
    const rij = sqlRij(`select token_hash from public.calendar_feed_links where id = ${q(bezet.feedLink.id)}`);
    verwacht(rij.token_hash !== bezet.token && /^[0-9a-f]{64}$/.test(rij.token_hash), 'alleen de hash staat in de database');
    const lijst = gelukt(await agenda(w.eigenaar.token, w.orgId, 'listFeedLinks'), 'lijst');
    gelijk(lijst.feedLinks.map((l) => l.label).sort(), ['Assistent', 'Partner'], 'eigen links');
    gelijk(gelukt(await agenda(w.medewerker.token, w.orgId, 'listFeedLinks'), 'lijst collega').feedLinks.length, 0, 'een collega ziet ze niet');
  });

  await stap('"alleen bezet": tijden, geen titel, plaats of omschrijving', async () => {
    const res = await dav('GET', `/feed/${bezet.token}.ics`);
    gelijk(res.status, 200, 'status');
    verwacht(/^text\/calendar/.test(res.headers.get('content-type') ?? ''), 'text/calendar');
    gelijk(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive, nosnippet', 'niet in zoekmachines');
    verwacht(res.tekst.includes('X-WR-CALNAME:Kantoor'), 'de naam van de agenda');
    verwacht(res.tekst.includes('SUMMARY:Bezet'), 'Bezet');
    for (const geheim of ['Lunch met klant', 'Over de offerte', 'Café', 'Terug', 'jan@klant.test', 'LOCATION', 'DESCRIPTION', 'ATTENDEE', 'VALARM']) {
      verwacht(!res.tekst.includes(geheim), `${geheim} staat in een link die alleen bezet toont`);
    }
    verwacht(res.tekst.includes('DTSTART:20261117T110000Z'), 'de tijd van de lunch');
    verwacht(res.tekst.includes('DTSTART;TZID=Europe/Amsterdam:20261116T090000'), 'de tijd van de telefoon, met zone');
  });

  await stap('"titel, tijd en plaats": nog steeds geen omschrijving of genodigden', async () => {
    const res = await dav('GET', `/feed/${details.token}.ics`);
    verwacht(res.tekst.includes('SUMMARY:Lunch met klant') && res.tekst.includes('LOCATION:Café'), 'titel en plaats');
    for (const geheim of ['Over de offerte', 'jan@klant.test', 'DESCRIPTION', 'ATTENDEE', 'VALARM']) verwacht(!res.tekst.includes(geheim), geheim);
  });

  await stap('opnieuw ophalen: 304 als er niets veranderde, HEAD zonder inhoud, POST niet', async () => {
    const eerst = await dav('GET', `/feed/${bezet.token}.ics`);
    gelijk((await dav('GET', `/feed/${bezet.token}.ics`, { headers: { 'if-none-match': eerst.headers.get('etag') } })).status, 304, 'niets veranderd');
    const kop = await dav('HEAD', `/feed/${bezet.token}.ics`);
    gelijk(kop.status, 200, 'HEAD');
    gelijk((await dav('POST', `/feed/${bezet.token}.ics`, { body: 'x' })).status, 405, 'POST');
    verwacht(sqlRij(`select last_used_at from public.calendar_feed_links where id = ${q(bezet.feedLink.id)}`).last_used_at, 'laatst opgehaald is bijgehouden');
    const robots = await dav('GET', '/robots.txt');
    verwacht(robots.status === 200 && robots.tekst.includes('Disallow: /'), 'robots.txt');
    verwacht(robots.tekst.includes('User-agent: Googlebot'), 'zoekmachines met hun eigen naam');
    for (const [methode, pad] of [['PROPFIND', '/'], ['GET', '/feed/onzin.ics'], ['OPTIONS', '/'], ['GET', '/robots.txt']]) {
      const r = await dav(methode, pad);
      verwacht(/noindex/.test(r.headers.get('x-robots-tag') ?? ''), `${methode} ${pad}: geen X-Robots-Tag`);
    }
  });

  await stap('een verzonnen, half of oud token: niets', async () => {
    gelijk((await dav('GET', `/feed/${'A'.repeat(43)}.ics`)).status, 404, 'verzonnen');
    gelijk((await dav('GET', `/feed/${bezet.token.slice(0, 20)}.ics`)).status, 404, 'half');
    gelijk((await dav('GET', '/feed/')).status, 404, 'leeg');
  });

  await stap('alleen je eigen ResoFly-agenda, en alleen met schrijfrecht', async () => {
    geweigerd(await agenda(w.eigenaar.token, w.orgId, 'createFeedLink', { sourceId: team.id, label: 'Niet van mij' }), 'de agenda van een collega');
    geweigerd(await agenda(v.eigenaar.token, v.orgId, 'createFeedLink', { sourceId: kantoor.id, label: 'Andere organisatie' }), 'een agenda van een andere organisatie');
    geweigerd(await agenda(v.eigenaar.token, w.orgId, 'createFeedLink', { sourceId: kantoor.id, label: 'Geen lid' }), 'als buitenstaander');
    // Een kijker met een eigen agenda (van toen hij nog lid was): delen kan niet meer.
    const eigenKijker = sql(`insert into public.calendar_sources (organization_id, user_id, provider, provider_calendar_id, name, visibility)
                             values (${q(w.orgId)}, ${q(w.kijker.id)}, 'native', gen_random_uuid()::text, 'Kijker', 'private') returning id`).split('\n')[0];
    geweigerd(await agenda(w.kijker.token, w.orgId, 'createFeedLink', { sourceId: eigenKijker, label: 'Kijker' }), 'een kijker', [403]);
  });

  await stap('de app en een gebruiker komen niet bij de tabel of de lookup', async () => {
    const tabel = await rest('calendar_feed_links?select=*', { token: w.eigenaar.token });
    verwacht(tabel.status >= 400 || (Array.isArray(tabel.json) && tabel.json.length === 0), `tabel: ${tabel.status} ${tabel.tekst.slice(0, 200)}`);
    const zoek = await rpc('calendar_feed_lookup', { p_token_hash: 'a'.repeat(64) }, w.eigenaar.token);
    verwacht(zoek.status >= 400, `lookup: ${zoek.status}`);
    const insert = await rest('calendar_feed_links', { method: 'POST', token: w.eigenaar.token, body: { organization_id: w.orgId, source_id: kantoor.id, user_id: w.eigenaar.id, token_hash: 'b'.repeat(64) } });
    verwacht(insert.status >= 400, `rechtstreeks een link maken: ${insert.status}`);
    // En de database laat geen link toe op een agenda van een ander.
    let fout = '';
    try { sql(`insert into public.calendar_feed_links (organization_id, source_id, user_id, token_hash) values (${q(w.orgId)}, ${q(team.id)}, ${q(w.eigenaar.id)}, '${'c'.repeat(64)}')`); } catch (e) { fout = String(e.stderr ?? e); }
    verwacht(/eigen ResoFly-agenda/.test(fout), `grendel in de database: ${fout.slice(0, 200)}`);
  });

  await stap('intrekken: de link is dicht, ook voor een collega die het id kent', async () => {
    gelukt(await agenda(w.medewerker.token, w.orgId, 'revokeFeedLink', { feedLinkId: details.feedLink.id }), 'een collega "trekt in"');
    gelijk((await dav('GET', `/feed/${details.token}.ics`)).status, 200, 'die van de eigenaar werkt nog');
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'revokeFeedLink', { feedLinkId: details.feedLink.id }), 'intrekken');
    gelijk((await dav('GET', `/feed/${details.token}.ics`)).status, 404, 'daarna dicht');
    gelijk(gelukt(await agenda(w.eigenaar.token, w.orgId, 'listFeedLinks'), 'lijst').feedLinks.map((l) => l.label), ['Partner'], 'uit de lijst');
  });

  await stap('wie de Agenda niet meer mag zien, deelt niets meer', async () => {
    const eigen = gelukt(await agenda(w.lezer.token, w.orgId, 'createNativeCalendar', { name: 'Lezer' }), 'agenda').source;
    const link = gelukt(await agenda(w.lezer.token, w.orgId, 'createFeedLink', { sourceId: eigen.id, label: 'Thuis' }), 'link');
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 200, 'eerst wel');
    sql(`update public.organization_members set module_access = '{"finance":"read","calendar":"none"}'::jsonb where organization_id = ${q(w.orgId)} and user_id = ${q(w.lezer.id)}`);
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 404, 'zonder Agenda');
    sql(`update public.organization_members set module_access = '{"finance":"read","calendar":"read"}'::jsonb where organization_id = ${q(w.orgId)} and user_id = ${q(w.lezer.id)}`);
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 200, 'met leesrecht weer wel');
    // Met alleen leesrecht kun je nog wel intrekken.
    gelukt(await agenda(w.lezer.token, w.orgId, 'revokeFeedLink', { feedLinkId: link.feedLink.id }), 'intrekken met leesrecht');
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 404, 'ingetrokken');
  });

  await stap('wie vertrekt, deelt niets meer: links en app-wachtwoorden vervallen', async () => {
    const link = gelukt(await agenda(w.medewerker.token, w.orgId, 'createFeedLink', { sourceId: prive.id, label: 'Familie' }), 'link');
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 200, 'eerst wel');
    sql(`update public.organization_members set status = 'disabled' where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 404, 'na vertrek');
    verwacht(sqlRij(`select revoked_at from public.calendar_feed_links where id = ${q(link.feedLink.id)}`).revoked_at, 'link ingetrokken');
    gelijk((await dav('PROPFIND', '/', { wie: medewerker, body: PROP_ALL })).status, 401, 'app-wachtwoord ook');
    sql(`update public.organization_members set status = 'active' where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 404, 'terugkomen geeft de link niet terug');
  });

  await stap('een agenda verwijderen ruimt zijn links op', async () => {
    const tijdelijk = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createNativeCalendar', { name: 'Tijdelijk' }), 'agenda').source;
    const link = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createFeedLink', { sourceId: tijdelijk.id }), 'link');
    gelijk(link.feedLink.label, 'Deellink', 'naam als je niets invult');
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'deleteNativeCalendar', { sourceId: tijdelijk.id }), 'verwijderen');
    gelijk((await dav('GET', `/feed/${link.token}.ics`)).status, 404, 'link dicht');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_feed_links where id = ${q(link.feedLink.id)}`).n, 0, 'rij weg');
  });

  await stap('"caldav-staging" is geen klantnaam', async () => {
    gelijk(sqlRij(`select public.client_subdomain_problem('caldav-staging') as p`).p, 'gereserveerd', 'caldav-staging');
  });
}
