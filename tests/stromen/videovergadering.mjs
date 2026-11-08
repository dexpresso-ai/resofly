// Google Meet en Teams vanuit ResoFly, door de echte edge functions
// (`calendar-integrations`, `meeting-booking`, `meeting-booking-public`) tegen de
// echte database. Google en Microsoft zijn nep (nep-agenda.mjs), en doen wat de
// echte diensten doen: een Meet op een Google-afspraak, de Meet REST API, Teams
// alleen op een werkaccount, en een Microsoft die een tokenvernieuwing weigert
// als die om een recht vraagt dat nooit gegeven is.
//
// Waarom zo: een videovergadering raakt drie partijen (ResoFly, de agenda, de
// vergaderdienst) en twee rechten (de agenda, en het aparte Meet/Teams-recht).
// Wat misgaat zit in de naden: een tweede Meet bij opnieuw opslaan, een
// Meet-link die bij elke bewerking in de omschrijving belandt, een bewerking
// via Gerrie die de omschrijving en de genodigden wist, een collega die met
// andermans account vergaderingen maakt, of een Microsoft-koppeling die na de
// uitrol op "Verlopen" springt.
//
//   npm run test:stromen -- videovergadering
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { ORIGIN } from './omgeving.mjs';
import { mailsAan, post } from './nepdiensten.mjs';
import { G, GOOGLE_ALLES, GOOGLE_MEET, MS_ALLES, MS_TEAMS, account, geefCode, nep } from './nep-agenda.mjs';
import { sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const JITSI = 'https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function agenda(token, orgId, action, body = {}) {
  return roep('calendar-integrations', { token, body: { action, organizationId: orgId, ...body } });
}

function boeking(token, orgId, action, body = {}) {
  return roep('meeting-booking', { token, body: { action, organizationId: orgId, ...body } });
}

function publiek(action, body) {
  return roep('meeting-booking-public', { body: { action, ...body } });
}

function locatie(res) {
  const waar = res.headers.get('location');
  verwacht(res.status === 302 && waar, `verwacht een redirect, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
  return new URL(waar);
}

/** Start, toestemming en terugkeer: wat de browser doet tot de app de code heeft. */
async function rondgang(gebruiker, orgId, provider, sleutel, scope, extra = {}) {
  const start = gelukt(await agenda(gebruiker.token, orgId, 'oauthStart', { provider, returnTo: `${ORIGIN}/#calendar-connections`, ...extra }), 'koppelen starten');
  const state = new URL(start.authUrl).searchParams.get('state');
  const code = geefCode(sleutel, scope);
  const terugkeer = locatie(await roep('calendar-integrations', { method: 'GET', query: `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, origin: null }));
  return { authUrl: start.authUrl, code: terugkeer.searchParams.get('calendar_code'), state: terugkeer.searchParams.get('calendar_state') };
}

async function koppel(gebruiker, orgId, provider, sleutel, scope, extra = {}) {
  const r = await rondgang(gebruiker, orgId, provider, sleutel, scope, extra);
  return { ...gelukt(await agenda(gebruiker.token, orgId, 'oauthComplete', { code: r.code, state: r.state }), 'afronden'), authUrl: r.authUrl };
}

function bron(orgId, userId, providerCalendarId) {
  return sqlRij(`select id, conference_types, write_enabled from public.calendar_sources
                  where organization_id = ${q(orgId)} and user_id = ${q(userId)} and provider_calendar_id = ${q(providerCalendarId)}`);
}

function googleAfspraak(acc, agendaId, id) {
  return (acc.afspraken[agendaId] ?? []).find((e) => e.id === id);
}

/** Over een uur of zo, op een heel kwartier: genoeg voor een afspraak die niet botst. */
function moment(urenVanaf, duurMinuten = 60) {
  const start = new Date(Date.now() + urenVanaf * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duurMinuten * 60_000).toISOString() };
}

const laatsteWijziging = (provider) => nep.wijzigingen.filter((w) => w.provider === provider).at(-1);

export default async function videovergaderingScenario() {
  groep('Google Meet: van de Google-agenda zelf');
  const w = await stap('wereld maken', () => maakWereld('video'));
  if (!w) return;

  const jan = account('google-video-jan', {
    provider: 'google', id: `g-${randomUUID()}`, email: `jan.${randomUUID().slice(0, 8)}@gmail.test`, naam: 'Jan Video',
    agendas: [
      { id: 'jan-primair', summary: 'Jan', primary: true, accessRole: 'owner', selected: true, timeZone: 'Europe/Amsterdam', conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
      // Een agenda waarop de Workspace-beheerder Meet uitzette.
      { id: 'jan-zonder-meet', summary: 'Zonder Meet', accessRole: 'owner', selected: true, conferenceProperties: { allowedConferenceSolutionTypes: ['eventHangout'] } },
    ],
  });

  const gekoppeld = await stap('koppelen: per agenda onthouden of hij zelf Meet maakt', async () => {
    const res = await koppel(w.medewerker, w.orgId, 'google', 'google-video-jan', GOOGLE_ALLES);
    gelijk(res.provider, 'google', 'provider');
    gelijk(res.meetings, undefined, 'zonder Meet-recht geen melding dat Meet aan staat');
    const authScopes = new URL(res.authUrl).searchParams.get('scope').split(' ');
    verwacht(!authScopes.includes(GOOGLE_MEET), 'de gewone koppeling vraagt het Meet-recht niet');
    const primair = bron(w.orgId, w.medewerker.id, 'jan-primair');
    const zonder = bron(w.orgId, w.medewerker.id, 'jan-zonder-meet');
    gelijk(primair.conference_types, ['hangoutsMeet'], 'hoofdagenda');
    gelijk(zonder.conference_types, ['eventHangout'], 'agenda zonder Meet');
    return { primair, zonder };
  });
  if (!gekoppeld) return;

  await stap('de app weet wat kan: Meet "nog aanzetten" buiten de agenda, Teams niet gekoppeld', async () => {
    const lijst = gelukt(await agenda(w.medewerker.token, w.orgId, 'listIntegrations'), 'lijst');
    gelijk(lijst.videoServices.google_meet.state, 'toestemming', 'Meet');
    gelijk(lijst.videoServices.teams.state, 'geen_koppeling', 'Teams');
    gelijk(lijst.videoServices.google_meet.account, jan.email, 'eigen account');
    // Een collega ziet niets van andermans koppelingen.
    const collega = gelukt(await agenda(w.beheerder.token, w.orgId, 'videoServices'), 'collega');
    gelijk([collega.videoServices.google_meet.state, collega.videoServices.google_meet.account], ['geen_koppeling', null], 'collega');
  });

  const metMeet = await stap('een afspraak met Google Meet: de agenda maakt hem, zonder regel in de omschrijving', async () => {
    const voor = nep.meetAanvragen.length;
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', {
      event: { sourceId: gekoppeld.primair.id, title: 'Intake met Meet', description: 'Agenda', ...moment(26), videoService: 'google_meet', attendees: [{ email: 'klant@klant.test' }] },
    }), 'aanmaken').event;
    gelijk(nep.meetAanvragen.length, voor + 1, 'één Meet aangevraagd');
    verwacht(/^https:\/\/meet\.google\.com\//.test(res.meeting_url ?? ''), `geen Meet-link: ${res.meeting_url}`);
    gelijk(res.conference?.service, 'google_meet', 'de vergadering van de agenda');
    gelijk(res.video_warning, undefined, 'geen kanttekening');
    const opGoogle = googleAfspraak(jan, 'jan-primair', res.provider_event_id);
    gelijk(opGoogle.description, 'Agenda', 'geen Videocall-regel in de omschrijving');
    return res;
  });

  await stap('Google maakt de Meet nog ("pending"): ResoFly wacht even en heeft dan de link', async () => {
    nep.meetBezig = 1;
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', {
      event: { sourceId: gekoppeld.primair.id, title: 'Meet die even duurt', ...moment(28), videoService: 'google_meet' },
    }), 'aanmaken').event;
    gelijk(nep.meetBezig, 0, 'pending gebruikt');
    verwacht(/^https:\/\/meet\.google\.com\//.test(res.meeting_url ?? ''), `geen link na het wachten: ${JSON.stringify(res)}`);
    gelijk(res.video_warning, undefined, 'geen kanttekening');
  });

  await stap('een agenda waarop Meet uit staat: uitleg in plaats van een afspraak zonder link', async () => {
    gelukt(await agenda(w.medewerker.token, w.orgId, 'updateSource', { sourceId: gekoppeld.zonder.id, patch: { write_enabled: true } }), 'schrijven aan');
    const voor = (jan.afspraken['jan-zonder-meet'] ?? []).length;
    const res = await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: gekoppeld.zonder.id, title: 'Gaat niet', ...moment(30), videoService: 'google_meet' } });
    geweigerd(res, 'Meet op een agenda zonder Meet', [409]);
    verwacht(/Google Meet uit/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    gelijk((jan.afspraken['jan-zonder-meet'] ?? []).length, voor, 'geen afspraak gemaakt');
  });

  await stap('opnieuw opslaan met Google Meet: geen tweede Meet (de genodigden hebben de eerste)', async () => {
    if (!metMeet) throw new Error('geen afspraak met Meet');
    const voor = nep.meetAanvragen.length;
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { sourceId: gekoppeld.primair.id, providerEventId: metMeet.provider_event_id, title: 'Intake met Meet (2)', description: 'Agenda 2', ...moment(26), allDay: false, videoService: 'google_meet', meetingUrl: null },
    }), 'bewerken').event;
    gelijk(nep.meetAanvragen.length, voor, 'geen nieuwe Meet');
    verwacht(!('conferenceData' in laatsteWijziging('google').body), 'een createRequest bij een Meet die er al was');
    gelijk(res.meeting_url, metMeet.meeting_url, 'dezelfde link');
  });

  await stap('bewerken zoals het scherm (Meet ongemoeid): de link komt niet in de omschrijving', async () => {
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { sourceId: gekoppeld.primair.id, providerEventId: metMeet.provider_event_id, title: 'Intake met Meet (3)', description: 'Agenda 3', ...moment(26), allDay: false, meetingUrl: null },
    }), 'bewerken').event;
    gelijk(laatsteWijziging('google').body.description, 'Agenda 3', 'omschrijving zonder regel');
    gelijk(res.meeting_url, metMeet.meeting_url, 'de Meet blijft');
  });

  await stap('alleen titel en tijd (zoals Gerrie): omschrijving, locatie en genodigden blijven staan', async () => {
    gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { sourceId: gekoppeld.primair.id, providerEventId: metMeet.provider_event_id, title: 'Intake verplaatst', ...moment(27), allDay: false },
    }), 'bewerken');
    const wijziging = laatsteWijziging('google');
    gelijk(Object.keys(wijziging.body).sort(), ['end', 'start', 'summary'], 'alleen wat verandert');
    gelijk(wijziging.query.sendUpdates, 'all', 'de genodigden horen de nieuwe tijd');
    const opGoogle = googleAfspraak(jan, 'jan-primair', metMeet.provider_event_id);
    gelijk([opGoogle.description, opGoogle.attendees?.length], ['Agenda 3', 1], 'omschrijving en genodigde staan er nog');
    verwacht(opGoogle.hangoutLink === metMeet.meeting_url, 'de Meet is weg');
  });

  await stap('overstappen naar Jitsi: de Jitsi-link komt erop en de Meet gaat eraf', async () => {
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { sourceId: gekoppeld.primair.id, providerEventId: metMeet.provider_event_id, title: 'Intake verplaatst', description: 'Agenda 3', ...moment(27), allDay: false, meetingUrl: JITSI, removeConference: true },
    }), 'bewerken').event;
    const opGoogle = googleAfspraak(jan, 'jan-primair', metMeet.provider_event_id);
    gelijk(opGoogle.description, `Agenda 3\n\n🎥 Videocall: ${JITSI}`, 'Jitsi-regel onderaan');
    gelijk([opGoogle.conferenceData, opGoogle.hangoutLink], [undefined, undefined], 'Meet weggehaald');
    gelijk(laatsteWijziging('google').body, { conferenceData: null }, 'weghalen met conferenceData: null');
    gelijk([res.meeting_url, res.conference, res.video_warning], [JITSI, null, undefined], 'wat de app terugkrijgt');
  });

  await stap('een bestaande afspraak zonder vergadering krijgt er alsnog een Meet bij', async () => {
    const kaal = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: gekoppeld.primair.id, title: 'Kaal', ...moment(32) } }), 'kaal').event;
    gelijk(kaal.meeting_url, null, 'eerst geen link');
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { sourceId: gekoppeld.primair.id, providerEventId: kaal.provider_event_id, title: 'Kaal', ...moment(32), allDay: false, videoService: 'google_meet' },
    }), 'Meet erbij').event;
    verwacht(/^https:\/\/meet\.google\.com\//.test(res.meeting_url ?? ''), `geen Meet: ${res.meeting_url}`);
    gelijk(laatsteWijziging('google').query.conferenceDataVersion, '1', 'met conferenceDataVersion');
  });

  groep('Google Meet buiten de Google-agenda: de ResoFly-agenda, de teamchat');
  const eigen = await stap('een eigen ResoFly-agenda', async () =>
    gelukt(await agenda(w.medewerker.token, w.orgId, 'createNativeCalendar', { name: 'Kantoor' }), 'agenda').source);
  if (!eigen) return;

  await stap('Meet in de ResoFly-agenda zonder toestemming: uitleg wat te doen', async () => {
    const res = await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: eigen.id, title: 'Nog niet', ...moment(34), videoService: 'google_meet' } });
    geweigerd(res, 'zonder Meet-recht', [409]);
    verwacht(/Instellingen → Agenda, bij je Google-account/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_events where source_id = ${q(eigen.id)}`).n, 0, 'geen afspraak');
  });

  await stap('een collega zonder Google kan geen Meet maken, ook niet met andermans koppeling', async () => {
    const res = await agenda(w.beheerder.token, w.orgId, 'createMeeting', { service: 'google_meet' });
    geweigerd(res, 'collega', [409]);
    verwacht(/Koppel eerst je Google-account/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    geweigerd(await agenda(w.kijker.token, w.orgId, 'createMeeting', { service: 'google_meet' }), 'kijker', [403]);
  });

  await stap('Meet aanzetten, maar bij Google het vinkje uit: gekoppeld, met eerlijke melding', async () => {
    const res = await koppel(w.medewerker, w.orgId, 'google', 'google-video-jan', GOOGLE_ALLES, { meetings: true, loginHint: jan.email });
    verwacht(new URL(res.authUrl).searchParams.get('scope').split(' ').includes(GOOGLE_MEET), 'Meet-recht niet gevraagd');
    verwacht(/zonder Google Meet/.test(res.warning ?? ''), `melding: ${res.warning}`);
    gelijk(res.meetings, undefined, 'niet aan');
  });

  await stap('Meet aanzetten: het recht erbij, en de app zegt dat het kan', async () => {
    const res = await koppel(w.medewerker, w.orgId, 'google', 'google-video-jan', `${GOOGLE_ALLES} ${GOOGLE_MEET}`, { meetings: true, loginHint: jan.email });
    gelijk([res.meetings, res.warning], [true, undefined], 'aan');
    const lijst = gelukt(await agenda(w.medewerker.token, w.orgId, 'listIntegrations'), 'lijst');
    gelijk(lijst.videoServices.google_meet.state, 'klaar', 'Meet buiten de agenda');
    // Dezelfde koppeling, met al zijn agenda's en instellingen.
    gelijk(bron(w.orgId, w.medewerker.id, 'jan-zonder-meet').write_enabled, true, 'instelling bewaard');
  });

  const losseMeet = await stap('een afspraak in de ResoFly-agenda met Google Meet: een losse Meet met de eigen koppeling', async () => {
    const voor = nep.ruimtes.length;
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', {
      event: { sourceId: eigen.id, title: 'Overleg kantoor', description: 'Bespreekpunten', ...moment(36), videoService: 'google_meet', attendees: [{ email: 'gast@klant.test', name: 'Gast' }] },
    }), 'aanmaken').event;
    gelijk(nep.ruimtes.length, voor + 1, 'één ruimte');
    gelijk(nep.ruimtes.at(-1).account, jan.email, 'met het eigen Google-account');
    gelijk(res.meeting_url, nep.ruimtes.at(-1).meetingUri, 'de link op de afspraak');
    const rij = sqlRij(`select meeting_url, description from public.calendar_events where id = ${q(res.native_event_id)}`);
    gelijk([rij.meeting_url, rij.description], [res.meeting_url, 'Bespreekpunten'], 'in de database');
    const uitnodiging = mailsAan('gast@klant.test').at(-1);
    verwacht(uitnodiging && uitnodiging.text.includes(res.meeting_url), 'de Meet-link staat niet in de uitnodiging');
    return res;
  });

  await stap('opnieuw opslaan: dezelfde Meet, geen nieuwe ruimte', async () => {
    if (!losseMeet) throw new Error('geen afspraak');
    const voor = nep.ruimtes.length;
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { eventId: losseMeet.native_event_id, sourceId: eigen.id, title: 'Overleg kantoor (2)', description: 'Bespreekpunten', ...moment(36), allDay: false, videoService: 'google_meet', attendees: [{ email: 'gast@klant.test', name: 'Gast' }] },
    }), 'bewerken').event;
    gelijk(nep.ruimtes.length, voor, 'geen tweede ruimte');
    gelijk(res.meeting_url, losseMeet.meeting_url, 'dezelfde link');
  });

  await stap('alleen titel en tijd (zoals Gerrie): genodigden en link blijven, niemand krijgt een afzegging', async () => {
    const afzeggingenVoor = mailsAan('gast@klant.test').filter((m) => /^Geannuleerd/.test(m.subject)).length;
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', {
      event: { eventId: losseMeet.native_event_id, sourceId: eigen.id, title: 'Overleg verplaatst', ...moment(37), allDay: false },
    }), 'bewerken').event;
    const rij = sqlRij(`select meeting_url, description, location from public.calendar_events where id = ${q(losseMeet.native_event_id)}`);
    gelijk([rij.meeting_url, rij.description], [losseMeet.meeting_url, 'Bespreekpunten'], 'link en omschrijving');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_event_attendees where event_id = ${q(losseMeet.native_event_id)}`).n, 1, 'genodigde');
    gelijk(mailsAan('gast@klant.test').filter((m) => /^Geannuleerd/.test(m.subject)).length, afzeggingenVoor, 'afzeggingen');
    const laatste = mailsAan('gast@klant.test').at(-1);
    verwacht(/^Uitnodiging/.test(laatste.subject) && laatste.text.includes(losseMeet.meeting_url), 'de genodigde kreeg geen bijgewerkte uitnodiging met de link');
    gelijk(res.title, 'Overleg verplaatst', 'titel');
  });

  await stap('de Meet API staat in Google Cloud uit: uitleg voor de beheerder', async () => {
    nep.meetApiUit = true;
    try {
      const res = await agenda(w.medewerker.token, w.orgId, 'createMeeting', { service: 'google_meet' });
      geweigerd(res, 'Meet API uit', [409]);
      verwacht(/Google Meet REST API aan in Google Cloud/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    } finally { nep.meetApiUit = false; }
  });

  await stap('teamchat "Nu vergaderen met Google Meet": een losse Meet', async () => {
    const res = gelukt(await agenda(w.medewerker.token, w.orgId, 'createMeeting', { service: 'google_meet', title: 'Vergadering via ResoFly' }), 'Meet');
    gelijk([res.url, res.account], [nep.ruimtes.at(-1).meetingUri, jan.email], 'link en account');
    geweigerd(await agenda(w.medewerker.token, w.orgId, 'createMeeting', { service: 'zoom' }), 'onbekende dienst', [400]);
  });

  await stap('Teams bij een Google-afspraak zonder Microsoft-koppeling: uitleg', async () => {
    const res = await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: gekoppeld.primair.id, title: 'Teams?', ...moment(38), videoService: 'teams' } });
    geweigerd(res, 'Teams zonder koppeling', [409]);
    verwacht(/Koppel eerst je Microsoft-account/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
  });

  groep('Teams: alleen met een werk- of schoolaccount');
  account('ms-video-prive', {
    provider: 'microsoft', id: `m-${randomUUID()}`, email: `piet.${randomUUID().slice(0, 8)}@outlook.test`, naam: 'Piet Privé', teams: false,
    agendas: [{ id: 'prive-agenda', name: 'Agenda', isDefaultCalendar: true, canEdit: true, hexColor: '#3b82f6', allowedOnlineMeetingProviders: ['skypeForConsumer'] }],
  });
  await stap('een privé-Microsoftaccount: geen Teams, en dat zegt ResoFly vooraf', async () => {
    gelukt(await koppel(w.beheerder, w.orgId, 'microsoft', 'ms-video-prive', MS_ALLES), 'koppelen');
    verwacht(nep.lijstPaginas.some((p) => p.provider === 'microsoft' && /allowedOnlineMeetingProviders/.test(p.select ?? '')), 'niet gevraagd wat de agenda kan');
    const src = bron(w.orgId, w.beheerder.id, 'prive-agenda');
    gelijk(src.conference_types, ['skypeForConsumer'], 'wat de agenda kan');
    const lijst = gelukt(await agenda(w.beheerder.token, w.orgId, 'listIntegrations'), 'lijst');
    gelijk(lijst.videoServices.teams.state, 'account', 'Teams kan dit account niet');
    const res = await agenda(w.beheerder.token, w.orgId, 'createEvent', { event: { sourceId: src.id, title: 'Teams?', ...moment(40), videoService: 'teams' } });
    geweigerd(res, 'Teams op een privé-account', [409]);
    verwacht(/werk- of schoolaccount/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
  });

  await stap('nog niet opgehaald wat de agenda kan, en Microsoft zet er geen Teams bij: de afspraak staat, met kanttekening', async () => {
    const src = bron(w.orgId, w.beheerder.id, 'prive-agenda');
    sql(`update public.calendar_sources set conference_types = null where id = ${q(src.id)}`);
    const res = gelukt(await agenda(w.beheerder.token, w.orgId, 'createEvent', { event: { sourceId: src.id, title: 'Oude manier', ...moment(41), addConference: true } }), 'aanmaken').event;
    gelijk(res.meeting_url, null, 'geen link');
    verwacht(/Microsoft zette er geen Teams-vergadering bij/.test(res.video_warning ?? ''), `kanttekening: ${res.video_warning}`);
  });

  const werk = account('ms-video-werk', {
    provider: 'microsoft', id: `m-${randomUUID()}`, email: `els.${randomUUID().slice(0, 8)}@bedrijf.test`, naam: 'Els Werk', teams: true,
    agendas: [{ id: 'werk-agenda', name: 'Agenda', isDefaultCalendar: true, canEdit: true, hexColor: '#0ea5e9', allowedOnlineMeetingProviders: ['teamsForBusiness'] }],
  });
  const werkBron = await stap('een werkaccount: Teams van de Microsoft-agenda zelf', async () => {
    gelukt(await koppel(w.eigenaar, w.orgId, 'microsoft', 'ms-video-werk', MS_ALLES), 'koppelen');
    const src = bron(w.orgId, w.eigenaar.id, 'werk-agenda');
    const res = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createEvent', { event: { sourceId: src.id, title: 'Teams-overleg', description: 'Agenda', ...moment(42), videoService: 'teams' } }), 'aanmaken').event;
    verwacht(/^https:\/\/teams\.microsoft\.com\//.test(res.meeting_url ?? ''), `geen Teams-link: ${res.meeting_url}`);
    gelijk([res.conference?.service, res.video_warning], ['teams', undefined], 'Teams van de agenda');
    gelijk((werk.afspraken['werk-agenda'] ?? []).at(-1).body.content, 'Agenda', 'geen regel in de omschrijving');
    return { src, event: res };
  });

  await stap('Microsoft vernieuwen zonder Teams-recht: alleen de gegeven rechten, de koppeling blijft actief', async () => {
    const conn = sqlRij(`select id from public.calendar_connections where organization_id = ${q(w.orgId)} and user_id = ${q(w.eigenaar.id)} and provider = 'microsoft'`);
    sql(`update public.calendar_connection_tokens set expires_at = now() - interval '1 hour' where connection_id = ${q(conn.id)}`);
    gelukt(await agenda(w.eigenaar.token, w.orgId, 'listEvents', { start: moment(-1).startsAt, end: moment(48).endsAt }), 'afspraken');
    const gevraagd = nep.vernieuwingen.filter((v) => v.provider === 'microsoft').at(-1).scope;
    verwacht(!gevraagd.some((s) => /OnlineMeetings/i.test(s)), `vroeg om Teams zonder dat recht: ${gevraagd.join(' ')}`);
    gelijk(sqlRij(`select status from public.calendar_connections where id = ${q(conn.id)}`).status, 'active', 'status');
  });

  await stap('Teams aanzetten: het recht erbij, vernieuwen vraagt het dan ook, en een losse Teams-vergadering kan', async () => {
    const res = await koppel(w.eigenaar, w.orgId, 'microsoft', 'ms-video-werk', `${MS_ALLES} ${MS_TEAMS}`, { meetings: true, loginHint: werk.email });
    verwacht(new URL(res.authUrl).searchParams.get('scope').split(' ').includes('OnlineMeetings.ReadWrite'), 'Teams-recht niet gevraagd');
    gelijk(res.meetings, true, 'aan');
    const conn = sqlRij(`select id from public.calendar_connections where organization_id = ${q(w.orgId)} and user_id = ${q(w.eigenaar.id)} and provider = 'microsoft'`);
    sql(`update public.calendar_connection_tokens set expires_at = now() - interval '1 hour' where connection_id = ${q(conn.id)}`);
    const voor = nep.teamsVergaderingen.length;
    const vergadering = gelukt(await agenda(w.eigenaar.token, w.orgId, 'createMeeting', { service: 'teams', title: 'Vergadering via ResoFly' }), 'Teams');
    const gevraagd = nep.vernieuwingen.filter((v) => v.provider === 'microsoft').at(-1).scope;
    verwacht(gevraagd.includes('OnlineMeetings.ReadWrite'), `vernieuwing zonder Teams-recht: ${gevraagd.join(' ')}`);
    gelijk(nep.teamsVergaderingen.length, voor + 1, 'één vergadering');
    gelijk([vergadering.url, nep.teamsVergaderingen.at(-1).subject], [nep.teamsVergaderingen.at(-1).joinWebUrl, 'Vergadering via ResoFly'], 'link en onderwerp');
  });

  await stap('opnieuw koppelen van een account met Teams: het Teams-recht blijft gevraagd', async () => {
    const r = await rondgang(w.eigenaar, w.orgId, 'microsoft', 'ms-video-werk', `${MS_ALLES} ${MS_TEAMS}`, { loginHint: werk.email });
    verwacht(new URL(r.authUrl).searchParams.get('scope').split(' ').includes('OnlineMeetings.ReadWrite'), 'Teams-recht vergeten bij opnieuw koppelen');
  });

  await stap('van Teams naar Jitsi: de Jitsi-link komt erop, en ResoFly zegt dat Teams in Outlook blijft', async () => {
    if (!werkBron) throw new Error('geen werkafspraak');
    const res = gelukt(await agenda(w.eigenaar.token, w.orgId, 'updateEvent', {
      event: { sourceId: werkBron.src.id, providerEventId: werkBron.event.provider_event_id, title: 'Teams-overleg', description: 'Agenda', ...moment(42), allDay: false, meetingUrl: JITSI, removeConference: true },
    }), 'bewerken').event;
    gelijk(res.meeting_url, JITSI, 'Jitsi wint');
    verwacht(/blijft in Outlook/.test(res.video_warning ?? ''), `kanttekening: ${res.video_warning}`);
    gelijk(laatsteWijziging('microsoft').body.body.content, `🎥 Videocall: ${JITSI}\n\nAgenda`, 'regel bovenaan');
  });

  groep('Boekingslinks met Google Meet');
  const link = await stap('een boekingslink op de ResoFly-agenda met Google Meet per boeking', async () => {
    const res = gelukt(await boeking(w.medewerker.token, w.orgId, 'createLink', { sourceId: eigen.id, title: 'Kennismaking', autoConference: true, conferenceProvider: 'google_meet', maxTotalBookings: 2, maxPerWeek: 2 }), 'link');
    gelijk(res.link.conference_provider, 'google_meet', 'opgeslagen');
    return res;
  });

  await stap('een collega kan andermans boekingslink niet op Teams van zijn eigen account zetten', async () => {
    const res = await boeking(w.eigenaar.token, w.orgId, 'updateLink', { linkId: link.link.id, patch: { conferenceProvider: 'teams' } });
    geweigerd(res, 'collega', [403]);
    verwacht(/Alleen wie de boekingslink maakte/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    gelijk(sqlRij(`select conference_provider from public.meeting_booking_links where id = ${q(link.link.id)}`).conference_provider, 'google_meet', 'ongewijzigd');
  });

  await stap('zonder Google-koppeling geen boekingslink met Google Meet (wel met Jitsi)', async () => {
    const zijne = gelukt(await agenda(w.beheerder.token, w.orgId, 'createNativeCalendar', { name: 'Beheer' }), 'agenda').source;
    const res = await boeking(w.beheerder.token, w.orgId, 'createLink', { sourceId: zijne.id, title: 'Mag niet', autoConference: true, conferenceProvider: 'google_meet' });
    geweigerd(res, 'zonder koppeling', [409]);
    verwacht(/Koppel eerst je Google-account/.test(res.json?.error ?? ''), `uitleg: ${res.tekst}`);
    gelukt(await boeking(w.beheerder.token, w.orgId, 'createLink', { sourceId: zijne.id, title: 'Met Jitsi', autoConference: true, conferenceProvider: 'jitsi' }), 'Jitsi kan altijd');
  });

  const klantEmail = `boeker.${randomUUID().slice(0, 8)}@klant.test`;
  const slots = await stap('tijdblokken erbij', async () => {
    const een = moment(50, 30);
    const twee = moment(52, 30);
    gelukt(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: link.link.id, slots: [een, twee] }), 'blokken');
    const info = gelukt(await publiek('getLink', { token: link.token }), 'boekingspagina');
    gelijk(info.slots.length, 2, 'twee blokken');
    return info.slots;
  });

  await stap('de klant boekt: een eigen Google Meet, in de bevestiging en de uitnodiging', async () => {
    const voor = nep.ruimtes.length;
    const res = gelukt(await publiek('bookSlots', { token: link.token, name: 'Klaas Klant', email: klantEmail, slotIds: [slots[0].id] }), 'boeken');
    gelijk(res.confirmed.length, 1, 'geboekt');
    gelijk(nep.ruimtes.length, voor + 1, 'een Meet per boeking');
    gelijk(res.meeting_url, nep.ruimtes.at(-1).meetingUri, 'link op de bevestigingspagina');
    verwacht(mailsAan(klantEmail).some((m) => m.text.includes(res.meeting_url)), 'de link staat niet in de mail aan de klant');
  });

  await stap('lukt de Meet niet (API uit), dan gaat de boeking toch door en hoort de eigenaar het', async () => {
    nep.meetApiUit = true;
    try {
      const res = gelukt(await publiek('bookSlots', { token: link.token, name: 'Klaas Klant', email: klantEmail, slotIds: [slots[1].id] }), 'boeken');
      gelijk([res.confirmed.length, res.failed.length], [1, 0], 'geboekt');
      gelijk(res.meeting_url, null, 'geen link');
      const melding = post.mails.filter((m) => m.subject === 'Nieuwe boeking: Kennismaking').at(-1);
      verwacht(melding && /Let op/.test(melding.text) && /Google Meet REST API/.test(melding.text), `melding aan de eigenaar: ${melding?.text}`);
    } finally { nep.meetApiUit = false; }
  });

  await stap('een boekingslink op de Google-agenda: Google maakt per boeking de Meet', async () => {
    const res = gelukt(await boeking(w.medewerker.token, w.orgId, 'createLink', { sourceId: gekoppeld.primair.id, title: 'Google-boeking', autoConference: true, conferenceProvider: 'calendar' }), 'link');
    const blok = moment(54, 30);
    gelukt(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: res.link.id, slots: [blok] }), 'blok');
    const info = gelukt(await publiek('getLink', { token: res.token }), 'boekingspagina');
    const voorRuimtes = nep.ruimtes.length;
    const voorMeet = nep.meetAanvragen.length;
    const geboekt = gelukt(await publiek('bookSlots', { token: res.token, name: 'Gerda Google', email: klantEmail, slotIds: [info.slots[0].id] }), 'boeken');
    gelijk(geboekt.confirmed.length, 1, 'geboekt');
    gelijk([nep.meetAanvragen.length, nep.ruimtes.length], [voorMeet + 1, voorRuimtes], 'een Meet van de agenda, geen losse ruimte');
    verwacht(/^https:\/\/meet\.google\.com\//.test(geboekt.meeting_url ?? ''), `geen Meet-link: ${geboekt.meeting_url}`);
    const opGoogle = (jan.afspraken['jan-primair'] ?? []).at(-1);
    gelijk([opGoogle.hangoutLink, opGoogle.attendees?.[0]?.email], [geboekt.meeting_url, klantEmail], 'op Google, met de klant als genodigde');
  });

  groep('Gerrie en een gekoppelde AI (MCP): een videocall klaarzetten');
  // Een echte MCP-koppeling voor de medewerker, zoals mcp-oauth hem uitgeeft.
  const mcp = await stap('een MCP-koppeling die mag klaarzetten', async () => {
    const clientId = `stromen-${randomUUID()}`;
    sql(`insert into public.mcp_clients (client_id, client_name, redirect_uris) values (${q(clientId)}, 'Stromen-AI', array['https://stromen.test/cb'])`);
    const grant = { id: sql(`insert into public.mcp_grants (organization_id, user_id, client_id, scope, label)
                             values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(clientId)}, 'read propose', 'stromen') returning id`) };
    const selector = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(`${salt}:${verifier}`).digest('hex');
    sql(`insert into public.mcp_tokens (grant_id, kind, selector, verifier_hash, salt, expires_at)
         values (${q(grant.id)}, 'access', ${q(selector)}, ${q(hash)}, ${q(salt)}, now() + interval '1 hour')`);
    return { token: `rsfmcp.${selector}.${verifier}`, grantId: grant.id };
  });

  /** propose_action via JSON-RPC, zoals Claude of ChatGPT hem aanroept. */
  async function klaarzetten(actionId, input) {
    const res = await roep('mcp', { token: mcp.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_action', arguments: { action_id: actionId, input } } } });
    const resultaat = res.json?.result;
    const tekst = resultaat?.content?.[0]?.text ?? '';
    return { fout: resultaat?.isError === true, tekst, json: (() => { try { return JSON.parse(tekst); } catch { return null; } })() };
  }

  /** Het laatste voorstel van deze koppeling in de wachtrij (een mislukte poging staat er als 'failed'). */
  function laatsteVoorstel() {
    return sqlRij(`select params from public.ai_action_audit where mcp_grant_id = ${q(mcp.grantId)} and status = 'proposed' order by created_at desc limit 1`)?.params;
  }

  await stap('"plan een videocall" in de Google-agenda: Google Meet van de agenda, nog niets aangemaakt', async () => {
    if (!mcp) throw new Error('geen koppeling');
    const voor = nep.meetAanvragen.length + nep.ruimtes.length;
    const uit = await klaarzetten('propose_calendar_event', { title: 'Videocall met Jan', date: '2026-12-01', start_time: '10:00', source_id: gekoppeld.primair.id, video_call: true });
    verwacht(!uit.fout, `klaarzetten: ${uit.tekst}`);
    const voorstel = laatsteVoorstel();
    gelijk([voorstel.type, voorstel.video_service, voorstel.meeting_url], ['calendar_event', 'google_meet', null], 'voorstel');
    gelijk(nep.meetAanvragen.length + nep.ruimtes.length, voor, 'er is nog niets gemaakt (dat gebeurt pas bij het akkoord)');
  });

  await stap('expliciet Jitsi: de link staat al op de kaart', async () => {
    const uit = await klaarzetten('propose_calendar_event', { title: 'Jitsi-call', date: '2026-12-01', start_time: '11:00', source_id: gekoppeld.primair.id, video_service: 'jitsi' });
    verwacht(!uit.fout, `klaarzetten: ${uit.tekst}`);
    const voorstel = laatsteVoorstel();
    gelijk(voorstel.video_service, 'jitsi', 'dienst');
    verwacht(/^https:\/\/meet\.jit\.si\/ResoFly-/.test(voorstel.meeting_url ?? ''), `Jitsi-link: ${voorstel.meeting_url}`);
  });

  await stap('Teams gevraagd zonder Microsoft-koppeling: Gerrie krijgt de uitleg terug, en zet niets klaar', async () => {
    const voor = laatsteVoorstel();
    const uit = await klaarzetten('propose_calendar_event', { title: 'Teams-call', date: '2026-12-01', start_time: '12:00', source_id: gekoppeld.primair.id, video_service: 'teams' });
    verwacht(uit.fout && /Koppel eerst je Microsoft-account/.test(uit.tekst) && /Jitsi Meet altijd/.test(uit.tekst), `uitleg: ${uit.tekst}`);
    gelijk(laatsteVoorstel(), voor, 'geen nieuw voorstel');
  });

  /**
   * Wat de app bij het akkoord met een wijziging doet (main.tsx,
   * onEditCalendarEvent), zonder andere tijden: dezelfde weg als de knop.
   */
  async function akkoordWijziging(p) {
    const input = { sourceId: p.ref.source_id, title: p.changes.title ?? p.title, startsAt: p.current.starts_at, endsAt: p.current.ends_at, allDay: p.current.all_day ?? false };
    if ('description' in p.changes) input.description = p.changes.description ?? null;
    if ('location' in p.changes) input.location = p.changes.location ?? null;
    const service = p.changes.video_service;
    if (service === 'google_meet' || service === 'teams') input.videoService = service;
    else if (service) input.meetingUrl = p.changes.meeting_url ?? null;
    if (service && p.changes.remove_conference) input.removeConference = true;
    const ref = { eventId: p.ref.event_id ?? undefined, sourceId: p.ref.source_id, providerEventId: p.ref.provider_event_id ?? undefined };
    return gelukt(await agenda(w.medewerker.token, w.orgId, 'updateEvent', { event: { ...input, ...ref } }), 'akkoord').event;
  }

  /** Een dag over `dagen` dagen, als YYYY-MM-DD (UTC, zoals de agenda een hele dag bewaart). */
  const dagOver = (dagen) => new Date(Date.now() + dagen * 86_400_000).toISOString().slice(0, 10);

  await stap('een bestaande afspraak: Google Meet erbij klaarzetten, en bij het akkoord komt hij er, met de tijden zoals ze waren', async () => {
    const afspraak = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: gekoppeld.primair.id, title: 'Zonder video', description: 'Blijft', ...moment(60) } }), 'afspraak').event;
    const uit = await klaarzetten('propose_edit_calendar_event', { source_id: gekoppeld.primair.id, provider_event_id: afspraak.provider_event_id, video_service: 'google_meet' });
    verwacht(!uit.fout, `klaarzetten: ${uit.tekst}`);
    const voorstel = laatsteVoorstel();
    gelijk([voorstel.type, voorstel.changes.video_service], ['edit_calendar_event', 'google_meet'], 'voorstel');
    gelijk([voorstel.current.starts_at, voorstel.current.ends_at, voorstel.current.all_day], [afspraak.starts_at, afspraak.ends_at, false], 'de tijden zoals ze zijn');
    verwacht(!('description' in voorstel.changes) && !('location' in voorstel.changes), 'velden die niet veranderen, horen niet in het voorstel');
    const voor = nep.meetAanvragen.length;
    const na = await akkoordWijziging(voorstel);
    gelijk(nep.meetAanvragen.length, voor + 1, 'de Meet ontstaat pas bij het akkoord');
    verwacht(/^https:\/\/meet\.google\.com\//.test(na.meeting_url ?? ''), `geen Meet: ${na.meeting_url}`);
    const opGoogle = googleAfspraak(jan, 'jan-primair', afspraak.provider_event_id);
    gelijk([opGoogle.start.dateTime, opGoogle.end.dateTime, opGoogle.description], [afspraak.starts_at, afspraak.ends_at, 'Blijft'], 'tijden en omschrijving ongemoeid');
  });

  await stap('een hele dag in de Google-agenda via Gerrie hernoemen: dezelfde dag, geen dag erbij', async () => {
    const dag = dagOver(12);
    const afspraak = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', {
      event: { sourceId: gekoppeld.primair.id, title: 'Studiedag', startsAt: `${dag}T00:00:00.000Z`, endsAt: `${dag}T00:00:00.000Z`, allDay: true },
    }), 'hele dag').event;
    const eindVoor = googleAfspraak(jan, 'jan-primair', afspraak.provider_event_id).end.date;
    const uit = await klaarzetten('propose_edit_calendar_event', { source_id: gekoppeld.primair.id, provider_event_id: afspraak.provider_event_id, title: 'Studiedag (verzet)' });
    verwacht(!uit.fout, `klaarzetten: ${uit.tekst}`);
    const voorstel = laatsteVoorstel();
    gelijk([voorstel.current.all_day, voorstel.current.starts_at, voorstel.current.ends_at], [true, `${dag}T00:00:00.000Z`, `${dag}T00:00:00.000Z`], 'Google wil de laatste dag zelf');
    await akkoordWijziging(voorstel);
    const opGoogle = googleAfspraak(jan, 'jan-primair', afspraak.provider_event_id);
    gelijk([opGoogle.summary, opGoogle.start.date, opGoogle.end.date], ['Studiedag (verzet)', dag, eindVoor], 'dezelfde dag');
  });

  await stap('een meerdaagse hele dag in de ResoFly-agenda via Gerrie hernoemen: even lang als eerst', async () => {
    if (!eigen) throw new Error('geen ResoFly-agenda');
    const [van, totMet, eindNa] = [dagOver(14), dagOver(16), dagOver(17)];
    const afspraak = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', {
      event: { sourceId: eigen.id, title: 'Beurs', startsAt: `${van}T00:00:00.000Z`, endsAt: `${eindNa}T00:00:00.000Z`, allDay: true },
    }), 'meerdaags').event;
    const uit = await klaarzetten('propose_edit_calendar_event', { source_id: eigen.id, event_id: afspraak.native_event_id, title: 'Beurs (drie dagen)' });
    verwacht(!uit.fout, `klaarzetten: ${uit.tekst}`);
    const voorstel = laatsteVoorstel();
    gelijk([voorstel.current.all_day, voorstel.current.ends_at], [true, `${eindNa}T00:00:00.000Z`], 'de ResoFly-agenda bewaart de dag ná de laatste');
    await akkoordWijziging(voorstel);
    const rij = sqlRij(`select title, to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD') as van, to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD') as tot, all_day
                          from public.calendar_events where id = ${q(afspraak.native_event_id)}`);
    gelijk([rij.title, rij.van, rij.tot, rij.all_day], ['Beurs (drie dagen)', van, eindNa, true], `nog steeds ${van} t/m ${totMet}`);
  });

  await stap('de Meet eraf via Gerrie: bij het akkoord haalt Google hem weg', async () => {
    const afspraak = gelukt(await agenda(w.medewerker.token, w.orgId, 'createEvent', { event: { sourceId: gekoppeld.primair.id, title: 'Met Meet', ...moment(62), videoService: 'google_meet' } }), 'afspraak').event;
    const uit = await klaarzetten('propose_edit_calendar_event', { source_id: gekoppeld.primair.id, provider_event_id: afspraak.provider_event_id, video_service: 'none' });
    verwacht(!uit.fout, `klaarzetten: ${uit.tekst}`);
    const voorstel = laatsteVoorstel();
    gelijk([voorstel.current.video_service, voorstel.changes.meeting_url, voorstel.changes.remove_conference], ['google_meet', null, true], 'voorstel');
    const na = await akkoordWijziging(voorstel);
    const opGoogle = googleAfspraak(jan, 'jan-primair', afspraak.provider_event_id);
    gelijk([opGoogle.conferenceData, opGoogle.hangoutLink, na.meeting_url, na.video_warning], [undefined, undefined, null, undefined], 'geen Meet meer');
  });

  groep('Videovergadering: andere organisaties');
  await stap('iemand van een andere organisatie maakt niets met deze koppelingen', async () => {
    const w2 = await maakWereld('video-b');
    const res = await agenda(w2.medewerker.token, w.orgId, 'createMeeting', { service: 'google_meet' });
    geweigerd(res, 'andere organisatie', [403]);
    const eigenOrg = await agenda(w2.medewerker.token, w2.orgId, 'createMeeting', { service: 'google_meet' });
    geweigerd(eigenOrg, 'eigen organisatie zonder koppeling', [409]);
    gelijk(eigenOrg.json?.error?.includes(jan.email), false, 'noemt andermans account');
  });
}
