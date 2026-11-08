/**
 * Google Meet en Teams in de handelingenregistry (Gerrie, de agents, MCP en de
 * API): wat de goedkeurkaart belooft, en wie wat mag. Draaien met:  npm test
 *
 *   - een Meet of Teams ontstaat pas bij het akkoord; de kaart belooft hem alleen
 *     als het ook echt kan (de agenda maakt hem, of de gebruiker gaf het recht);
 *   - alleen de eigen koppelingen tellen, nooit die van een collega;
 *   - een boekingslink met Google Meet of Teams buiten de agenda om kiest alleen
 *     de maker van de link (die vergaderingen komen van zijn account).
 *
 * Met een nep-database die de filters echt toepast, zoals recheckFixes.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_ACTIONS } from './actions/calendar.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';
import { GOOGLE_MEET_SCOPE } from './calendarOAuth.ts';

const ORG = '0000000b-0000-0000-0000-000000000000';
const ME = '00000000-0000-0000-0000-0000000000b1';
const COLLEAGUE = '00000000-0000-0000-0000-0000000000b3';
const uuid = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let list = (tables[table] ?? []).map((r) => ({ organization_id: ORG, ...r }));
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.eq = (column: string, value: unknown) => { list = list.filter((r) => r[column] === value); return chain; };
      chain.in = (column: string, values: unknown[]) => { list = list.filter((r) => values.includes(r[column])); return chain; };
      chain.is = (column: string, value: unknown) => { list = list.filter((r) => (r[column] ?? null) === value); return chain; };
      chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      chain.single = async () => (list[0] ? { data: list[0], error: null } : { data: null, error: { message: 'niet gevonden' } });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null });
      return chain;
    },
    rpc() { throw new Error('geen rpc in deze test'); },
  };
}

function ctxFor(tables: Record<string, Row[]>, userId = ME): ActionCtx {
  return {
    organizationId: ORG, userId, role: 'member', today: '2026-11-08', db: fakeDb(tables) as unknown as ActionCtx['db'],
    canRead: () => true, canWrite: () => true,
  };
}

function action(id: string): ActionDef {
  const found = CALENDAR_ACTIONS.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

const fails = (pattern: RegExp) => (error: unknown) => error instanceof ActionError && pattern.test(error.message);

const SRC = { mineNative: uuid(1), mineGoogle: uuid(2), mineGoogleNoMeet: uuid(3), colleagueNative: uuid(4) };
const EVT = { plain: uuid(10), withMeet: uuid(11) };
const CONN = { mine: uuid(20), colleague: uuid(21) };

function tables(options: { myScopes?: string[] | null; colleagueScopes?: string[] } = {}): Record<string, Row[]> {
  const base = { sync_enabled: true, write_enabled: true, feed_url: null, visibility: 'private' };
  const connections: Row[] = [
    { id: CONN.colleague, provider: 'google', user_id: COLLEAGUE, status: 'active', scopes: options.colleagueScopes ?? ['openid', GOOGLE_MEET_SCOPE], created_at: '2026-01-01' },
  ];
  if (options.myScopes !== null) {
    connections.push({ id: CONN.mine, provider: 'google', user_id: ME, status: 'active', scopes: options.myScopes ?? ['openid'], created_at: '2026-02-01' });
  }
  return {
    calendar_sources: [
      { ...base, id: SRC.mineNative, name: 'Kantoor', provider: 'native', user_id: ME, connection_id: null, conference_types: null },
      { ...base, id: SRC.mineGoogle, name: 'Jan', provider: 'google', user_id: ME, connection_id: CONN.mine, conference_types: ['hangoutsMeet'] },
      { ...base, id: SRC.mineGoogleNoMeet, name: 'Zonder Meet', provider: 'google', user_id: ME, connection_id: CONN.mine, conference_types: ['eventHangout'] },
      { ...base, id: SRC.colleagueNative, name: 'Piet', provider: 'native', user_id: COLLEAGUE, connection_id: null, conference_types: null, visibility: 'organization' },
    ],
    calendar_connections: connections,
    calendar_events: [
      { id: EVT.plain, source_id: SRC.mineNative, uid: 'u1', title: 'Overleg', description: 'Punten', location: null, meeting_url: null, starts_at: '2026-11-10T09:00:00Z', ends_at: '2026-11-10T10:00:00Z', all_day: false, recurs: false, deleted_at: null },
      { id: EVT.withMeet, source_id: SRC.mineNative, uid: 'u2', title: 'Met Meet', description: null, location: null, meeting_url: 'https://meet.google.com/abc-defg-hij', starts_at: '2026-11-11T09:00:00Z', ends_at: '2026-11-11T10:00:00Z', all_day: false, recurs: false, deleted_at: null },
    ],
    calendar_event_attendees: [{ event_id: EVT.plain, email: 'gast@klant.nl', display_name: 'Gast', role: 'req', status: 'accepted' }],
    meeting_booking_links: [{ id: uuid(30), title: 'Kennismaking', status: 'active', client_id: null, source_id: SRC.colleagueNative, user_id: COLLEAGUE, max_total_bookings: 1, max_per_week: 1, auto_conference: true, conference_provider: 'jitsi', meeting_url: null, public_token_hash: null }],
    company_settings: [{ jitsi_base_url: null }],
  };
}

test('Meet op een ResoFly-afspraak: alleen met het eigen recht, en nooit met de koppeling van een collega', async () => {
  const setUrl = action('calendar_event.set_meeting_url');
  // Geen eigen Google-koppeling; die van de collega (mét Meet-recht) telt niet.
  await assert.rejects(setUrl.plan!(ctxFor(tables({ myScopes: null })), { native_event_id: EVT.plain, video_service: 'google_meet' }), fails(/Koppel eerst je Google-account/));
  // Wel gekoppeld, maar zonder het Meet-recht.
  await assert.rejects(setUrl.plan!(ctxFor(tables()), { native_event_id: EVT.plain, video_service: 'google_meet' }), fails(/Geef ResoFly eerst toestemming/));
  // Met het recht: de kaart belooft een Meet; die ontstaat pas bij het akkoord.
  const plan = await setUrl.plan!(ctxFor(tables({ myScopes: ['openid', GOOGLE_MEET_SCOPE] })), { native_event_id: EVT.plain, video_service: 'google_meet' });
  assert.match(plan.title, /Google Meet-vergadering op "Overleg"/);
  const event = (plan.payload as { event: Record<string, unknown> }).event;
  assert.equal(event.videoService, 'google_meet');
  assert.equal(event.meetingUrl, undefined, 'geen link verzonnen bij het plannen');
  // De genodigden en de omschrijving gaan mee (anders kregen ze een afzegging).
  assert.deepEqual(event.attendees, [{ email: 'gast@klant.nl', name: 'Gast', role: 'req' }]);
  assert.equal(event.description, 'Punten');
  assert.equal(plan.risk, 'high', 'genodigden krijgen post');
});

test('Meet op een afspraak die er al een heeft, of samen met een andere keuze: nee', async () => {
  const setUrl = action('calendar_event.set_meeting_url');
  const ctx = ctxFor(tables({ myScopes: ['openid', GOOGLE_MEET_SCOPE] }));
  await assert.rejects(setUrl.plan!(ctx, { native_event_id: EVT.withMeet, video_service: 'google_meet' }), fails(/Er staat al een Google Meet-vergadering/));
  await assert.rejects(setUrl.plan!(ctx, { native_event_id: EVT.plain, video_service: 'google_meet', jitsi: true }), fails(/Kies één ding/));
  await assert.rejects(setUrl.plan!(ctx, { native_event_id: EVT.plain, video_service: 'zoom' }), (error: unknown) => error instanceof ActionError);
});

test('boekingslink met Google Meet: kan op de Google-agenda zelf, of los met het eigen recht', async () => {
  const create = action('booking_link.create');
  // Op de ResoFly-agenda zonder het recht: niet.
  await assert.rejects(create.plan!(ctxFor(tables()), { source_id: SRC.mineNative, conference_provider: 'google_meet' }), fails(/Google Meet kan bij deze boekingslink niet/));
  // Met het recht wel.
  const plan = await create.plan!(ctxFor(tables({ myScopes: ['openid', GOOGLE_MEET_SCOPE] })), { source_id: SRC.mineNative, conference_provider: 'google_meet' });
  assert.equal((plan.payload as Record<string, unknown>).conferenceProvider, 'google_meet');
  assert.match(plan.sub ?? '', /Google Meet/);
  // Op een Google-agenda die Meet maakt: altijd, ook zonder het losse recht.
  const ownCalendar = await create.plan!(ctxFor(tables()), { source_id: SRC.mineGoogle, conference_provider: 'google_meet' });
  assert.equal((ownCalendar.payload as Record<string, unknown>).conferenceProvider, 'google_meet');
  // Op een Google-agenda waarop Meet uit staat: niet.
  await assert.rejects(create.plan!(ctxFor(tables({ myScopes: ['openid', GOOGLE_MEET_SCOPE] })), { source_id: SRC.mineGoogleNoMeet, conference_provider: 'google_meet' }), fails(/Google Meet uit/));
  // Een vaste link of geen automatische vergadering: dan doet de dienst er niet toe.
  await create.plan!(ctxFor(tables()), { source_id: SRC.mineNative, conference_provider: 'google_meet', auto_conference: false });
});

test('andermans boekingslink op Google Meet of Teams van je eigen account zetten: nee', async () => {
  const update = action('booking_link.update');
  // De link is van de collega; zijn vergaderingen zouden van zíjn account komen.
  await assert.rejects(update.plan!(ctxFor(tables({ myScopes: ['openid', GOOGLE_MEET_SCOPE] })), { link_id: uuid(30), conference_provider: 'google_meet' }), fails(/Alleen wie de boekingslink maakte/));
  // De maker zelf, met het recht, mag het wel.
  const plan = await update.plan!(ctxFor(tables(), COLLEAGUE), { link_id: uuid(30), conference_provider: 'google_meet' });
  assert.equal((plan.payload as { patch: Record<string, unknown> }).patch.conferenceProvider, 'google_meet');
  assert.match(plan.sub ?? '', /videovergadering via Google Meet/);
});
