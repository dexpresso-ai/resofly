/**
 * Tests voor de regels van de boekingslinks (meetingBookingRules.ts). Draaien
 * met:  npm test
 *
 * Ook een paar controles op de twee edge functions en de migratie zelf, zodat
 * een volgende wijziging niet stilletjes een regel terugdraait die hier ooit
 * misging (CHANGELOG_BOEKINGSLINKS_2026-11-10.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOOKING_STALE_MINUTES,
  MAX_TOKEN_TTL_DAYS,
  bookingLinkState,
  bookingVideoLabel,
  bookingVideoService,
  checkNewSlots,
  isBookingVideoKind,
  videoKindOfUrl,
  clampTtlDays,
  cleanVisitorEmail,
  cleanVisitorName,
  expiryAfter,
  isActiveBooking,
  isBookableSlot,
  isStalePending,
  parseSlotIds,
  slotClash,
  withoutDuplicateSlots,
} from './meetingBookingRules.ts';

const NOW = Date.parse('2026-11-10T09:00:00Z');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('geldigheid: een geheel aantal dagen van 1 tot en met 365', () => {
  assert.equal(clampTtlDays(undefined), 120);
  assert.equal(clampTtlDays('abc'), 120);
  assert.equal(clampTtlDays(''), 120);
  assert.equal(clampTtlDays(0), 1);
  assert.equal(clampTtlDays(-5), 1);
  assert.equal(clampTtlDays(30.4), 30);
  assert.equal(clampTtlDays('60'), 60);
  // Eerst: 1e9 dagen gaf een ongeldige datum (500), 100.000 een link voor altijd.
  assert.equal(clampTtlDays(1e9), MAX_TOKEN_TTL_DAYS);
  assert.equal(clampTtlDays(Infinity), 120);
  assert.equal(expiryAfter(1e9, NOW), new Date(NOW + 365 * 86400000).toISOString());
});

test('naam van de bezoeker: geen stuurtekens, hooguit 160 tekens', () => {
  assert.equal(cleanVisitorName('  Els\nde\tBoer  '), 'Els de Boer');
  assert.equal(cleanVisitorName('A\u0000B\u2028C'), 'A B C');
  assert.equal(cleanVisitorName(null), '');
  assert.equal(cleanVisitorName('x'.repeat(500)).length, 160);
});

test('e-mailadres van de bezoeker: klein, geldig en niet te lang', () => {
  assert.equal(cleanVisitorEmail(' Els@Zonnetje.NL '), 'els@zonnetje.nl');
  assert.equal(cleanVisitorEmail('geen-adres'), null);
  assert.equal(cleanVisitorEmail('a b@c.nl'), null);
  assert.equal(cleanVisitorEmail(`${'a'.repeat(250)}@b.nl`), null);
  assert.equal(cleanVisitorEmail(undefined), null);
});

test('gekozen momenten: alleen id\'s, elk één keer', () => {
  const a = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const b = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
  assert.deepEqual(parseSlotIds([a, a.toUpperCase(), b, 'x', 42, null]), [a, b]);
  assert.deepEqual(parseSlotIds('niet-een-lijst'), []);
});

test('stand van een link: gesloten, verlopen, niet beschikbaar, vol of open', () => {
  const base = { status: 'active', expiresAt: '2026-12-01T00:00:00Z', ownerCanBook: true, hasSource: true, activeBookings: 0, maxTotal: 1, now: NOW };
  assert.equal(bookingLinkState(base), 'open');
  assert.equal(bookingLinkState({ ...base, status: 'closed' }), 'closed');
  assert.equal(bookingLinkState({ ...base, expiresAt: '2026-11-01T00:00:00Z' }), 'expired');
  assert.equal(bookingLinkState({ ...base, expiresAt: null }), 'expired');
  // Een oud-teamlid of iemand zonder schrijfrecht op de Agenda: de link boekt niets meer.
  assert.equal(bookingLinkState({ ...base, ownerCanBook: false }), 'unavailable');
  assert.equal(bookingLinkState({ ...base, hasSource: false }), 'unavailable');
  assert.equal(bookingLinkState({ ...base, activeBookings: 1 }), 'full');
  assert.equal(bookingLinkState({ ...base, activeBookings: 1, maxTotal: 3 }), 'open');
});

test('een poging die blijft hangen, telt na tien minuten niet meer mee', () => {
  const recent = new Date(NOW - 60_000).toISOString();
  const old = new Date(NOW - (BOOKING_STALE_MINUTES + 1) * 60_000).toISOString();
  assert.equal(isStalePending('pending', recent, NOW), false);
  assert.equal(isStalePending('pending', old, NOW), true);
  assert.equal(isStalePending('confirmed', old, NOW), false);
  assert.equal(isActiveBooking('pending', recent, NOW), true);
  assert.equal(isActiveBooking('pending', old, NOW), false);
  assert.equal(isActiveBooking('confirmed', old, NOW), true);
  assert.equal(isActiveBooking('failed', recent, NOW), false);
});

test('alleen een blok dat nog moet beginnen, is te boeken', () => {
  const future = new Date(NOW + 3600_000).toISOString();
  const started = new Date(NOW - 20 * 60_000).toISOString();
  assert.equal(isBookableSlot({ status: 'open', starts_at: future }, NOW), true);
  // Eerst stond een blok tot het eind op de pagina: om 10.20 uur kon je 10.00 uur nog boeken.
  assert.equal(isBookableSlot({ status: 'open', starts_at: started }, NOW), false);
  assert.equal(isBookableSlot({ status: 'booked', starts_at: future }, NOW), false);
  assert.equal(isBookableSlot({ status: 'pending', starts_at: future, pending_at: new Date(NOW - 60_000).toISOString() }, NOW), false);
  assert.equal(isBookableSlot({ status: 'pending', starts_at: future, pending_at: new Date(NOW - 11 * 60_000).toISOString() }, NOW), true);
});

test('videogesprek in woorden voor de klant', () => {
  assert.equal(bookingVideoLabel({ meetingUrl: 'https://x.test/a', autoConference: true, conferenceProvider: 'jitsi', sourceProvider: 'native' }), 'Videogesprek — de link staat in je bevestiging');
  assert.equal(bookingVideoLabel({ meetingUrl: null, autoConference: true, conferenceProvider: 'jitsi', sourceProvider: 'native' }), 'Videogesprek via Jitsi Meet');
  assert.equal(bookingVideoLabel({ meetingUrl: null, autoConference: true, conferenceProvider: 'teams', sourceProvider: 'native' }), 'Videogesprek via Microsoft Teams');
  assert.equal(bookingVideoLabel({ meetingUrl: null, autoConference: true, conferenceProvider: 'calendar', sourceProvider: 'google' }), 'Videogesprek via Google Meet');
  assert.equal(bookingVideoLabel({ meetingUrl: null, autoConference: true, conferenceProvider: 'calendar', sourceProvider: 'native' }), null);
  assert.equal(bookingVideoLabel({ meetingUrl: null, autoConference: false, conferenceProvider: 'jitsi', sourceProvider: 'native' }), null);
});

test('welk videogesprek: Jitsi, Google Meet, Teams of Zoom, ook bij een vaste link', () => {
  const base = { meetingUrl: null, autoConference: true, conferenceProvider: 'calendar', sourceProvider: 'native' };
  assert.equal(bookingVideoService({ ...base, conferenceProvider: 'jitsi' }), 'jitsi');
  assert.equal(bookingVideoService({ ...base, conferenceProvider: 'google_meet' }), 'google_meet');
  assert.equal(bookingVideoService({ ...base, conferenceProvider: 'teams' }), 'teams');
  assert.equal(bookingVideoService({ ...base, sourceProvider: 'google' }), 'google_meet');
  assert.equal(bookingVideoService({ ...base, sourceProvider: 'microsoft' }), 'teams');
  // Een ResoFly-agenda maakt zelf niets.
  assert.equal(bookingVideoService(base), null);
  assert.equal(bookingVideoService({ ...base, autoConference: false, conferenceProvider: 'jitsi' }), null);
  // Een vaste link gaat voor, en zegt nu ook welke dienst het is (eerst alleen
  // "de link staat in je bevestiging").
  assert.equal(bookingVideoService({ ...base, meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }), 'teams');
  assert.equal(bookingVideoService({ ...base, meetingUrl: 'https://meet.google.com/abc-defg-hij' }), 'google_meet');
  assert.equal(bookingVideoService({ ...base, meetingUrl: 'https://us02web.zoom.us/j/123' }), 'zoom');
  assert.equal(bookingVideoService({ ...base, meetingUrl: 'https://meet.jit.si/Overleg' }), 'jitsi');
  assert.equal(bookingVideoService({ ...base, meetingUrl: 'https://video.eigen.nl/ResoFly-abcdefghijkmno' }), 'jitsi');
  assert.equal(bookingVideoService({ ...base, meetingUrl: 'https://whereby.com/kamer' }), 'link');
});

test('een videolink is alleen http(s)', () => {
  assert.equal(videoKindOfUrl('javascript:alert(1)'), null);
  assert.equal(videoKindOfUrl('geen link'), null);
  assert.equal(videoKindOfUrl(''), null);
  assert.equal(videoKindOfUrl(`https://x.nl/${'a'.repeat(3000)}`), null);
  assert.equal(videoKindOfUrl('http://meet.google.com/abc'), 'google_meet');
  assert.equal(isBookingVideoKind('teams'), true);
  assert.equal(isBookingVideoKind('skype'), false);
});

test('nieuwe blokken: niet in het verleden, einde na begin, hooguit twaalf uur', () => {
  const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();
  assert.doesNotThrow(() => checkNewSlots([{ starts_at: at(1), ends_at: at(2) }], NOW));
  assert.throws(() => checkNewSlots([{ starts_at: at(-2), ends_at: at(-1) }], NOW), /verleden/);
  assert.throws(() => checkNewSlots([{ starts_at: at(2), ends_at: at(1) }], NOW), /na de begintijd/);
  assert.throws(() => checkNewSlots([{ starts_at: at(1), ends_at: at(14) }], NOW), /twaalf uur/);
  assert.throws(() => checkNewSlots([{ starts_at: 'gisteren', ends_at: at(1) }], NOW), /Ongeldige/);
});

test('dubbele blokken worden overgeslagen, ook binnen één aanvraag', () => {
  const s = { starts_at: '2026-11-12T09:00:00.000Z', ends_at: '2026-11-12T09:30:00.000Z' };
  const t = { starts_at: '2026-11-12T10:00:00.000Z', ends_at: '2026-11-12T10:30:00.000Z' };
  const res = withoutDuplicateSlots([s, t, { ...t }], [{ ...s, starts_at: '2026-11-12T09:00:00+00:00', status: 'open' }]);
  assert.deepEqual(res.fresh, [t]);
  assert.equal(res.skipped, 2);
  // Een geannuleerd blok telt niet: dat moment mag opnieuw worden aangeboden.
  assert.equal(withoutDuplicateSlots([s], [{ ...s, status: 'cancelled' }]).fresh.length, 1);
});

test('botsingen: de agenda van de link en je andere agenda\'s, niet die van collega\'s', () => {
  const slot = { starts_at: '2026-11-12T09:00:00.000Z', ends_at: '2026-11-12T09:30:00.000Z' };
  const scope = { linkSourceId: 'link-cal', ownSourceIds: ['link-cal', 'google', 'ics'] };
  const ev = (source_id: string, starts_at: string, ends_at: string, extra: Record<string, unknown> = {}) => ({ source_id, starts_at, ends_at, all_day: false, title: source_id, ...extra });
  // Een afspraak in je Google-agenda telde eerst niet mee: alleen de agenda van de link.
  assert.equal(slotClash(slot, [ev('google', '2026-11-12T09:15:00Z', '2026-11-12T10:00:00Z')], scope)?.title, 'google');
  assert.equal(slotClash(slot, [ev('ics', '2026-11-12T08:00:00Z', '2026-11-12T09:01:00Z')], scope)?.title, 'ics');
  // Aansluitend is geen botsing.
  assert.equal(slotClash(slot, [ev('google', '2026-11-12T09:30:00Z', '2026-11-12T10:00:00Z')], scope), null);
  assert.equal(slotClash(slot, [ev('google', '2026-11-12T08:30:00Z', '2026-11-12T09:00:00Z')], scope), null);
  // Een collega die zijn agenda deelt, maakt jou niet bezet.
  assert.equal(slotClash(slot, [ev('collega', '2026-11-12T09:00:00Z', '2026-11-12T09:30:00Z')], scope), null);
  // Een hele dag telt alleen in de agenda van de link (de publieke pagina weigert de boeking dan ook).
  const allDay = { all_day: true };
  assert.equal(slotClash(slot, [ev('google', '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z', allDay)], scope), null);
  assert.equal(slotClash(slot, [ev('link-cal', '2026-11-12T00:00:00Z', '2026-11-13T00:00:00Z', allDay)], scope)?.title, 'link-cal');
  // De agenda van de link telt ook als hij van een ander is (een gedeelde ResoFly-agenda).
  assert.equal(slotClash(slot, [ev('gedeeld', '2026-11-12T09:00:00Z', '2026-11-12T09:30:00Z')], { linkSourceId: 'gedeeld', ownSourceIds: [] })?.title, 'gedeeld');
  // Onzin in een afspraak breekt niets.
  assert.equal(slotClash(slot, [ev('google', 'geen datum', '2026-11-12T10:00:00Z')], scope), null);
});

test('het beheer slaat botsende momenten over als daarom gevraagd is, anders waarschuwt het', () => {
  const src = read('../meeting-booking/index.ts');
  assert.match(src, /skipClashes: body\.skipClashes === true/);
  assert.match(src, /slotClash\(slot, events, \{ linkSourceId: link\.source_id, ownSourceIds \}\)/);
  // De agenda's van wie de link maakte, niet alleen die van de link zelf.
  assert.match(src, /calendarIdsOf\(organizationId, link\.user_id \?\? userId\)/);
  assert.doesNotMatch(src, /const sameSource = events\.filter/);
});

test('de publieke functie controleert de maker, remt, en lekt geen interne fouten', () => {
  const src = read('../meeting-booking-public/index.ts');
  // De maker van de link moet nog een actief teamlid zijn met schrijfrecht op de Agenda.
  assert.match(src, /ownerCanBook/);
  // Een rem per afzender en per link (portal_login_hit, gehashte sleutels).
  assert.match(src, /booking-view:ip:/);
  assert.match(src, /booking-book:ip:/);
  assert.match(src, /booking-book:link:/);
  // Een NUL-teken gaf een 500; nu een nette melding.
  assert.match(src, /containsNulCharacter/);
  // Nooit de hash of het id van de link naar de bezoeker.
  assert.doesNotMatch(src, /public_token_hash:\s*link\./);
});

test('het beheer: lezen met leesrecht, schrijven met schrijfrecht, geen hash naar buiten', () => {
  const src = read('../meeting-booking/index.ts');
  assert.match(src, /READ_ACTIONS/);
  assert.match(src, /assertModuleAccess\(supabaseAdmin, user\.id, organizationId, 'calendar', 'read'\)/);
  assert.match(src, /assertWriteRole\(role\)/);
  assert.match(src, /clampTtlDays/);
  assert.match(src, /publicLinkRow/);
});

test('de migratie: vastgelopen boekingen, voorbije blokken, de maker en annuleren', () => {
  const sql = read('../../migrations/20261110030000_boekingslinks_veilig.sql');
  assert.match(sql, /release_stale_meeting_bookings/);
  assert.match(sql, /v_slot\.starts_at <= now\(\)/);
  assert.match(sql, /member_module_level\(m\.role, m\.module_access, 'calendar'\) = 'write'/);
  assert.match(sql, /if v_booking\.status = 'confirmed' then/);
  assert.match(sql, /interval '10 minutes'/);
  // Alleen de service-role roept deze functies aan.
  for (const fn of ['release_stale_meeting_bookings(uuid, uuid)', 'reserve_meeting_slot_by_token(text, uuid, text, text)', 'cancel_meeting_booking(uuid, uuid)']) {
    assert.ok(sql.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn);
    assert.ok(sql.includes(`grant execute on function public.${fn} to service_role;`), fn);
  }
});
