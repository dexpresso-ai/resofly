import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENT_ACTIONS, activeFolderShare } from './actions/clients.ts';
import { FINANCE_ACTIONS } from './actions/finance.ts';
import { CALENDAR_ACTIONS } from './actions/calendar.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';

/**
 * De herkontrole na de volledige API-controle: dezelfde soorten fouten, op de
 * plekken waar ze nog zaten.
 *
 *   - iets in een GEDEELDE map zetten (of zo'n map hernoemen) laat de ontvanger
 *     het meteen zien: dat is naar buiten, dus risico 'high';
 *   - een factuur of offerte zonder eigen klant aan een project MET klant hangen,
 *     zet hem in diens klantportaal: idem;
 *   - een afspraak, agenda of koppeling in andermans PRIVÉ-agenda bestaat voor je
 *     niet: geen titel, geen naam, geen genodigden, en hetzelfde antwoord als bij
 *     een id dat er niet is.
 *
 * Met een nep-database die de filters echt toepast: plan() en read() draaien
 * zoals op de server, alleen de rijen zijn verzonnen.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const ME = '00000000-0000-0000-0000-0000000000a1';
const COLLEAGUE = '00000000-0000-0000-0000-0000000000a3';
const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = Record<string, unknown>;

/** Een database die eq/in/is/or/limit echt toepast op de rijen per tabel. */
function fakeDb(tables: Record<string, Row[]>) {
  const queries: Array<{ table: string; filters: string[] }> = [];
  return {
    queries,
    db: {
      from(table: string) {
        let list = (tables[table] ?? []).map((r) => ({ organization_id: ORG, ...r }));
        let max: number | null = null;
        const filters: string[] = [];
        queries.push({ table, filters });
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.order = () => chain;
        chain.eq = (column: string, value: unknown) => { filters.push(`${column}=${value}`); list = list.filter((r) => r[column] === value); return chain; };
        chain.neq = (column: string, value: unknown) => { list = list.filter((r) => r[column] !== value); return chain; };
        chain.in = (column: string, values: unknown[]) => { filters.push(`${column} in`); list = list.filter((r) => values.includes(r[column])); return chain; };
        chain.is = (column: string, value: unknown) => { list = list.filter((r) => (r[column] ?? null) === value); return chain; };
        chain.gte = (column: string, value: string) => { list = list.filter((r) => String(r[column]) >= value); return chain; };
        chain.lte = (column: string, value: string) => { list = list.filter((r) => String(r[column]) <= value); return chain; };
        chain.or = (expression: string) => {
          // Alleen de vorm "kolom.eq.waarde,kolom.eq.waarde" (genoeg voor deze tests).
          const terms = expression.split(',').map((term) => term.split('.eq.'));
          list = list.filter((r) => terms.some(([column, value]) => String(r[column]) === value));
          return chain;
        };
        chain.limit = (n: number) => { max = n; return chain; };
        chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
        chain.single = async () => (list[0] ? { data: list[0], error: null } : { data: null, error: { message: 'niet gevonden' } });
        chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: max === null ? list : list.slice(0, max), error: null });
        return chain;
      },
      rpc() { throw new Error('geen rpc in deze test'); },
    },
  };
}

function ctxFor(tables: Record<string, Row[]>, options: { userId?: string; readable?: string[] } = {}): ActionCtx & { queries: Array<{ table: string; filters: string[] }> } {
  const { db, queries } = fakeDb(tables);
  const readable = options.readable;
  return {
    organizationId: ORG, userId: options.userId ?? ME, role: 'member', today: '2026-10-03', db, queries,
    canRead: (module) => !readable || readable.includes(module),
    canWrite: (module) => !readable || readable.includes(module),
  };
}

function action(list: ActionDef[], id: string): ActionDef {
  const found = list.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

const notFound = (pattern: RegExp) => (error: unknown) => error instanceof ActionError && pattern.test(error.message);

// ── Gedeelde mappen ─────────────────────────────────────────────────────────

const FOLDERS = {
  root: uuid(1), // gedeeld met de klant
  child: uuid(2), // valt onder root
  grandchild: uuid(3),
  loose: uuid(4), // niet gedeeld
  expired: uuid(5), // deling verlopen
  revoked: uuid(6), // deling ingetrokken
};
const NOTE = uuid(10);

function driveTables(): Record<string, Row[]> {
  return {
    content_folders: [
      { id: FOLDERS.root, name: 'Opleveringen', parent_id: null, client_id: uuid(90) },
      { id: FOLDERS.child, name: 'Ontwerpen', parent_id: FOLDERS.root, client_id: uuid(90) },
      { id: FOLDERS.grandchild, name: 'Concepten', parent_id: FOLDERS.child, client_id: uuid(90) },
      { id: FOLDERS.loose, name: 'Intern', parent_id: null, client_id: uuid(90) },
      { id: FOLDERS.expired, name: 'Oud', parent_id: null, client_id: uuid(90) },
      { id: FOLDERS.revoked, name: 'Ingetrokken', parent_id: null, client_id: uuid(90) },
    ],
    drive_shares: [
      { item_type: 'folder', item_id: FOLDERS.root, recipient_name: 'Kees Jansen', recipient_email: 'kees@jansen.nl', expires_at: null, revoked_at: null },
      { item_type: 'folder', item_id: FOLDERS.expired, recipient_name: 'Oud contact', recipient_email: null, expires_at: '2020-01-01T00:00:00Z', revoked_at: null },
      { item_type: 'folder', item_id: FOLDERS.revoked, recipient_name: 'Weg', recipient_email: null, expires_at: null, revoked_at: '2026-01-01T00:00:00Z' },
    ],
    notes: [{ id: NOTE, title: 'Interne prijsafspraak', client_id: uuid(90) }],
  };
}

test('een deling hoger in de boom telt ook; verlopen en ingetrokken delingen niet', async () => {
  const ctx = ctxFor(driveTables());
  assert.deepEqual(await activeFolderShare(ctx, FOLDERS.grandchild), { recipient: 'Kees Jansen' });
  assert.equal(await activeFolderShare(ctx, FOLDERS.loose), null);
  assert.equal(await activeFolderShare(ctx, FOLDERS.expired), null);
  assert.equal(await activeFolderShare(ctx, FOLDERS.revoked), null);
});

test('een kringetje in de mappen loopt niet eindeloos door', async () => {
  const tables = driveTables();
  tables.content_folders.push({ id: uuid(20), name: 'A', parent_id: uuid(21) }, { id: uuid(21), name: 'B', parent_id: uuid(20) });
  assert.equal(await activeFolderShare(ctxFor(tables), uuid(20)), null);
});

test('naar een gedeelde map verplaatsen: risico high, met de ontvanger erbij', async () => {
  const move = action(CLIENT_ACTIONS, 'content.move');
  const shared = await move.plan!(ctxFor(driveTables()), { kind: 'note', item_id: NOTE, folder_id: FOLDERS.child });
  assert.equal(shared.risk, 'high');
  assert.match(shared.warning ?? '', /gedeeld met Kees Jansen/);
  const internal = await move.plan!(ctxFor(driveTables()), { kind: 'note', item_id: NOTE, folder_id: FOLDERS.loose });
  assert.notEqual(internal.risk, 'high');
  assert.equal(internal.warning, undefined);
  const out = await move.plan!(ctxFor(driveTables()), { kind: 'note', item_id: NOTE });
  assert.notEqual(out.risk, 'high', 'uit een map halen verbergt alleen');
});

test('een map in een gedeelde map maken of een gedeelde map hernoemen: ook high', async () => {
  const tables = { ...driveTables(), clients: [{ id: uuid(90), name: 'Jansen BV' }] };
  const create = await action(CLIENT_ACTIONS, 'folder.create').plan!(ctxFor(tables), { client_id: uuid(90), name: 'Nieuw', parent_id: FOLDERS.child });
  assert.equal(create.risk, 'high');
  const createLoose = await action(CLIENT_ACTIONS, 'folder.create').plan!(ctxFor(tables), { client_id: uuid(90), name: 'Nieuw', parent_id: FOLDERS.loose });
  assert.notEqual(createLoose.risk, 'high');
  const rename = await action(CLIENT_ACTIONS, 'folder.rename').plan!(ctxFor(tables), { folder_id: FOLDERS.grandchild, name: 'Definitief' });
  assert.equal(rename.risk, 'high');
  assert.match(rename.warning ?? '', /Kees Jansen/);
});

// ── Klantportaal via het project ────────────────────────────────────────────

test('een factuur zonder klant aan een project met klant: high, met de klant die hem gaat zien', async () => {
  const link = action(FINANCE_ACTIONS, 'finance.link_project');
  const tables = {
    invoices: [
      { id: uuid(30), number: '2026-001', client_id: null, project_id: null },
      { id: uuid(31), number: '2026-002', client_id: uuid(90), project_id: null },
    ],
    projects: [{ id: uuid(40), name: 'Website', client_id: uuid(90) }, { id: uuid(41), name: 'Intern', client_id: null }],
    clients: [{ id: uuid(90), name: 'Jansen BV' }],
  };
  const exposed = await link.plan!(ctxFor(tables), { document: 'invoice', document_id: uuid(30), project_id: uuid(40) });
  assert.equal(exposed.risk, 'high');
  assert.match(exposed.warning ?? '', /klantportaal van Jansen BV/);
  const own = await link.plan!(ctxFor(tables), { document: 'invoice', document_id: uuid(31), project_id: uuid(40) });
  assert.notEqual(own.risk, 'high', 'stond al in het portaal van die klant');
  const internal = await link.plan!(ctxFor(tables), { document: 'invoice', document_id: uuid(30), project_id: uuid(41) });
  assert.notEqual(internal.risk, 'high');
});

// ── Privé-agenda's ──────────────────────────────────────────────────────────

const SRC = { minePrivate: uuid(50), colleaguePrivate: uuid(51), colleagueShared: uuid(52), colleaguePrivateIcs: uuid(53) };

function calendarTables(): Record<string, Row[]> {
  const base = { sync_enabled: true, write_enabled: true, connection_id: null, feed_url: null };
  return {
    calendar_sources: [
      { ...base, id: SRC.minePrivate, name: 'Mijn agenda', provider: 'native', user_id: ME, visibility: 'private' },
      { ...base, id: SRC.colleaguePrivate, name: 'Sollicitaties Piet', provider: 'native', user_id: COLLEAGUE, visibility: 'private' },
      { ...base, id: SRC.colleagueShared, name: 'Teamagenda', provider: 'native', user_id: COLLEAGUE, visibility: 'organization' },
      { ...base, id: SRC.colleaguePrivateIcs, name: 'Ziekenhuis Piet', provider: 'ics', user_id: COLLEAGUE, visibility: 'private', write_enabled: false },
    ],
    calendar_events: [
      { id: uuid(60), source_id: SRC.colleaguePrivate, uid: 'uid-geheim', title: 'Gesprek met concurrent', deleted_at: '2026-09-01T00:00:00Z', starts_at: '2026-10-05T09:00:00Z', ends_at: '2026-10-05T10:00:00Z' },
      { id: uuid(61), source_id: SRC.colleagueShared, uid: 'uid-team', title: 'Teamoverleg', deleted_at: null, starts_at: '2026-10-05T09:00:00Z', ends_at: '2026-10-05T10:00:00Z' },
    ],
    calendar_event_attendees: [
      { event_id: uuid(60), email: 'ceo@concurrent.nl', display_name: null, role: 'req', status: 'accepted' },
      { event_id: uuid(61), email: 'collega@resofly.nl', display_name: null, role: 'req', status: 'accepted' },
    ],
    note_calendar_links: [
      { id: uuid(70), note_id: uuid(80), calendar_source_id: SRC.colleagueShared, visibility_snapshot: 'organization', is_private_masked_snapshot: false, event_starts_at: '2026-10-05T09:00:00Z', event_title_snapshot: 'Teamoverleg', provider: 'native', provider_event_id: 'uid-team' },
      { id: uuid(71), note_id: uuid(81), calendar_source_id: SRC.colleaguePrivate, visibility_snapshot: 'organization', is_private_masked_snapshot: false, event_starts_at: '2026-10-04T09:00:00Z', event_title_snapshot: 'Gesprek met concurrent', provider: 'native', provider_event_id: 'uid-geheim' },
      { id: uuid(72), note_id: uuid(82), calendar_source_id: SRC.colleagueShared, visibility_snapshot: 'private', is_private_masked_snapshot: true, event_starts_at: '2026-10-03T09:00:00Z', event_title_snapshot: null, provider: 'native', provider_event_id: 'uid-oud' },
      { id: uuid(73), note_id: uuid(83), calendar_source_id: SRC.minePrivate, visibility_snapshot: 'private', is_private_masked_snapshot: false, event_starts_at: '2026-10-02T09:00:00Z', event_title_snapshot: 'Mijn eigen', provider: 'native', provider_event_id: 'uid-eigen' },
    ],
    notes: [80, 81, 82, 83].map((n) => ({ id: uuid(n), title: `Notitie ${n}` })),
    meeting_booking_links: [{ id: uuid(95), title: 'Kennismaking', status: 'active', client_id: null, source_id: SRC.colleagueShared, user_id: COLLEAGUE, max_total_bookings: 1, max_per_week: 1, auto_conference: true, meeting_url: null, public_token_hash: null }],
  };
}

test('een afspraak in andermans privé-agenda: "niet gevonden", vóór afgezegd of welke soort agenda', async () => {
  const attendees = action(CALENDAR_ACTIONS, 'calendar_event.list_attendees');
  // Bestaat niet en privé van een ander: precies hetzelfde antwoord.
  await assert.rejects(attendees.read!(ctxFor(calendarTables()), { native_event_id: uuid(60) }), notFound(/^Afspraak niet gevonden in deze organisatie\.$/));
  await assert.rejects(attendees.read!(ctxFor(calendarTables()), { native_event_id: uuid(69) }), notFound(/^Afspraak niet gevonden in deze organisatie\.$/));
  // De eigenaar zelf hoort wél dat hij afgezegd is.
  await assert.rejects(attendees.read!(ctxFor(calendarTables(), { userId: COLLEAGUE }), { native_event_id: uuid(60) }), notFound(/al afgezegd/));
  const shared = await attendees.read!(ctxFor(calendarTables()), { native_event_id: uuid(61) }) as { attendees: Row[] };
  assert.deepEqual(shared.attendees.map((a) => a.email), ['collega@resofly.nl']);
});

test('een agenda-id van andermans privé-agenda: geen naam, geen soort — hetzelfde als een onbekend id', async () => {
  const sharing = action(CALENDAR_ACTIONS, 'calendar_source.set_sharing');
  const refresh = action(CALENDAR_ACTIONS, 'calendar_source.refresh_ics');
  const update = action(CALENDAR_ACTIONS, 'calendar_source.update_native');
  const booking = action(CALENDAR_ACTIONS, 'booking_link.create');
  const same = /^Agenda niet gevonden in deze organisatie\.$/;
  for (const [def, input] of [
    [sharing, { source_id: SRC.colleaguePrivate, sync_enabled: false }],
    [refresh, { source_id: SRC.colleaguePrivateIcs }],
    [update, { source_id: SRC.colleaguePrivateIcs, name: 'x' }],
    [booking, { source_id: SRC.colleaguePrivateIcs }],
    [booking, { source_id: uuid(59) }],
  ] as const) {
    await assert.rejects(def.plan!(ctxFor(calendarTables()), input), notFound(same), `${def.id} ${JSON.stringify(input)}`);
  }
  // Een GEDEELDE agenda van een ander mag je wel bij naam horen (die zie je toch).
  await assert.rejects(sharing.plan!(ctxFor(calendarTables()), { source_id: SRC.colleagueShared, sync_enabled: false }), notFound(/"Teamagenda" is door iemand anders gekoppeld/));
});

test('een boekingslink niet naar een privé-agenda van een ander dan de eigenaar van de link', async () => {
  const update = action(CALENDAR_ACTIONS, 'booking_link.update');
  // Mijn eigen privé-agenda, maar de link is van een collega: daar zouden zijn boekingen in landen.
  await assert.rejects(update.plan!(ctxFor(calendarTables()), { link_id: uuid(95), source_id: SRC.minePrivate }), notFound(/de boekingslink is van iemand anders/));
  // Andermans privé-agenda: bestaat niet.
  await assert.rejects(update.plan!(ctxFor(calendarTables()), { link_id: uuid(95), source_id: SRC.colleaguePrivate }), notFound(/^Agenda niet gevonden in deze organisatie\.$/));
  // De eigenaar van de link mag naar zijn eigen privé-agenda.
  const own = await update.plan!(ctxFor(calendarTables(), { userId: COLLEAGUE }), { link_id: uuid(95), source_id: SRC.colleaguePrivate });
  assert.match(own.sub ?? '', /Sollicitaties Piet/);
});

test('koppelingen van notities met afspraken: alleen wat je in de app ook ziet', async () => {
  const list = action(CALENDAR_ACTIONS, 'note.list_event_links');
  const result = await list.read!(ctxFor(calendarTables()), {}) as { links: Row[] };
  const seen = JSON.stringify(result);
  assert.match(seen, /Teamoverleg/);
  assert.match(seen, /Mijn eigen/, 'je eigen agenda');
  assert.doesNotMatch(seen, /concurrent/, 'privé-agenda van een collega');
  assert.doesNotMatch(seen, /Notitie 82/, 'gemaskeerd vastgelegd');
  const noCalendar = await list.read!(ctxFor(calendarTables(), { readable: ['content'] }), {}) as { count: number };
  assert.equal(noCalendar.count, 0, 'zonder leesrecht op Agenda: niets');
  const unlink = action(CALENDAR_ACTIONS, 'note.unlink_from_event');
  await assert.rejects(unlink.plan!(ctxFor(calendarTables()), { link_id: uuid(71) }), notFound(/^Koppeling niet gevonden in deze organisatie\.$/));
  const ok = await unlink.plan!(ctxFor(calendarTables()), { link_id: uuid(70) });
  assert.match(ok.title, /Notitie 80/);
});

test('notulen mailen: geen genodigden van andermans privé-afspraak', async () => {
  const send = action(CALENDAR_ACTIONS, 'meeting_recording.send_summary');
  const recording = (eventRef: string) => ({
    id: uuid(99), event_title_snapshot: 'Overleg', status: 'done', transcript_text: 't', summary_text: 'Notulen',
    provider: 'native', event_ref: eventRef, summary_recipients: null,
  });
  const secret = { ...calendarTables(), meeting_recordings: [recording('uid-geheim')] };
  await assert.rejects(send.plan!(ctxFor(secret), { recording_id: uuid(99) }), notFound(/geen ontvangers/));
  const team = { ...calendarTables(), meeting_recordings: [recording('uid-team')] };
  const plan = await send.plan!(ctxFor(team), { recording_id: uuid(99) });
  assert.deepEqual(plan.payload.recipients, ['collega@resofly.nl']);
});

test('een agenda-link die al bestaat: alleen in je eigen lijst gezocht', async () => {
  const subscribe = action(CALENDAR_ACTIONS, 'calendar_source.subscribe_ics');
  const tables = calendarTables();
  tables.calendar_sources.push({ id: uuid(54), name: 'Geheime feed', provider: 'ics', user_id: COLLEAGUE, visibility: 'private', feed_url: 'https://agenda.example.com/x.ics' });
  const ctx = ctxFor(tables);
  const plan = await subscribe.plan!(ctx, { url: 'https://agenda.example.com/x.ics', name: 'Ook de mijne' });
  assert.doesNotMatch(JSON.stringify(plan), /Geheime feed/);
  assert.ok(ctx.queries.some((q) => q.table === 'calendar_sources' && q.filters.includes(`user_id=${ME}`)));
  tables.calendar_sources.push({ id: uuid(55), name: 'Mijn feed', provider: 'ics', user_id: ME, visibility: 'private', feed_url: 'https://agenda.example.com/y.ics' });
  await assert.rejects(subscribe.plan!(ctxFor(tables), { url: 'https://agenda.example.com/y.ics', name: 'Dubbel' }), notFound(/staat al in je lijst als "Mijn feed"/));
});

test('Gerrie: een agenda-id van andermans privé-agenda noemt geen naam', () => {
  const source = readFileSync(new URL('./gerrieCore.ts', import.meta.url), 'utf8');
  const resolver = source.slice(source.indexOf('async function resolveEventRef('), source.indexOf('async function findEvent('));
  const visibility = resolver.indexOf("source.visibility !== 'organization'");
  const named = resolver.indexOf('is een abonnement via een link');
  assert.ok(visibility > 0 && named > visibility, 'eerst de zichtbaarheid, dan pas een melding met de naam');
  assert.match(resolver, /select\('id, name, provider, user_id, visibility'\)/);
});

// ── Goedkeuren in de browser: de uitkomst hoort bij wie besliste ─────────────

test('de uitkomst-outbox levert alleen af namens de gebruiker die besliste', () => {
  const source = readFileSync(new URL('../../../src/lib/gerrie-api.ts', import.meta.url), 'utf8');
  assert.match(source, /userId: string \| null/, 'elke uitkomst onthoudt wie besliste');
  const deliver = source.slice(source.indexOf('async function deliverOutcome('), source.indexOf('\n}\n', source.indexOf('async function deliverOutcome(')));
  assert.match(deliver, /if \(!entry\.userId \|\| data\.session\?\.user\?\.id !== entry\.userId\) return false;/,
    'na uitloggen of met een ander account blijft hij liggen in plaats van onder de verkeerde naam te landen');
  // Per voorstel onthouden wie het vastzette — niet één globale "laatste gebruiker".
  assert.match(source, /if \(outcome === 'claim'\) claimedBy\.set\(auditId, data\.session\?\.user\?\.id \?\? null\);/);
  const confirm = source.slice(source.indexOf('export async function confirmGerrieAction('), source.indexOf('\n}\n', source.indexOf('export async function confirmGerrieAction(')));
  assert.match(confirm, /claimedBy\.has\(auditId\)/);
  assert.doesNotMatch(source, /lastDecisionUserId/);
});
