import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPortalPrefs,
  isPortalActor,
  isTicketRequester,
  normalizeEmail,
  planTicketNotifications,
  portalPeople,
  portalPrefsFor,
  portalSettingsUrl,
  portalStatusSentence,
  portalTicketStatusLabel,
  portalTicketUrl,
  type PortalActivity,
  type PortalTicketPlanInput,
} from './portalNotify.ts';
import { renderPortalTicketUpdateEmail } from './emailTemplates/portalTicketUpdate.ts';

/**
 * Wie krijgt welke mail over een ticket? Een klant met meer mensen op het
 * portaal moet niet bedolven worden, wie iets zelf deed krijgt er geen mail
 * over, en een antwoord dat weer intern is gemaakt gaat nooit de deur uit.
 */

const CLIENT = 'c0000000-0000-4000-8000-000000000001';
const TICKET = 't0000000-0000-4000-8000-000000000001';
const CONTACT_ANJA = 'a0000000-0000-4000-8000-000000000001';
const CONTACT_PIET = 'a0000000-0000-4000-8000-000000000002';

const people = portalPeople(
  { email: ' Joost@DeKorenaar.nl ', contact_name: 'Joost Vermeer', name: 'De Korenaar' },
  [
    { id: CONTACT_ANJA, name: 'Anja Vermeer', email: 'anja@dekorenaar.nl' },
    { id: CONTACT_PIET, name: 'Piet (boekhouding)', email: 'piet@boekhouder.nl' },
  ],
);
const [joost, anja, piet] = people;

let seq = 0;
function activity(partial: Partial<PortalActivity> & Pick<PortalActivity, 'kind'>): PortalActivity {
  seq += 1;
  return {
    id: `act-${seq}`,
    ticket_id: TICKET,
    client_id: CLIENT,
    note_id: null,
    old_status: null,
    new_status: null,
    actor_type: 'staff',
    actor_contact_id: null,
    actor_email: null,
    notified_emails: [],
    created_at: new Date(Date.UTC(2026, 9, 4, 10, 0, seq)).toISOString(),
    ...partial,
  };
}

function plan(overrides: Partial<PortalTicketPlanInput> = {}) {
  return planTicketNotifications({
    ticket: { id: TICKET, client_id: CLIENT, status: 'review', created_by_contact_id: CONTACT_ANJA, created_by_email: 'anja@dekorenaar.nl' },
    activity: [],
    people,
    settings: [],
    visibleNoteIds: new Set(),
    ...overrides,
  });
}

const recipients = (result: ReturnType<typeof plan>) => result.mails.map((mail) => mail.person.email);

test('portaalgebruikers: hoofdadres eerst, genormaliseerd, zonder dubbelen of kapotte adressen', () => {
  assert.deepEqual(people.map((p) => [p.email, p.isPrimary, p.contactId]), [
    ['joost@dekorenaar.nl', true, null],
    ['anja@dekorenaar.nl', false, CONTACT_ANJA],
    ['piet@boekhouder.nl', false, CONTACT_PIET],
  ]);
  const merged = portalPeople({ email: 'joost@dekorenaar.nl', name: 'De Korenaar' }, [
    { id: 'x', name: 'Joost V.', email: 'JOOST@dekorenaar.nl' },
    { id: 'y', name: 'Kapot', email: 'geen-adres' },
  ]);
  assert.equal(merged.length, 1, 'hetzelfde adres als contactpersoon is één mens');
  assert.equal(merged[0].contactId, 'x', 'met de contactpersoon-id, zoals het portaal reacties vastlegt');
  assert.equal(normalizeEmail('  Iemand@Voorbeeld.NL '), 'iemand@voorbeeld.nl');
  assert.equal(normalizeEmail('geen adres'), null);
});

test('standaard: hoofdadres over alle tickets, contactpersoon alleen over de eigen', () => {
  assert.deepEqual(defaultPortalPrefs(joost), { ticketCreated: true, ticketStatus: true, ticketReply: true, scope: 'all' });
  assert.deepEqual(defaultPortalPrefs(anja), { ticketCreated: true, ticketStatus: true, ticketReply: true, scope: 'own' });
  assert.deepEqual(
    portalPrefsFor(anja, [{ email: 'ANJA@dekorenaar.nl', notify_ticket_reply: false, notify_scope: 'all' }]),
    { ticketCreated: true, ticketStatus: true, ticketReply: false, scope: 'all' },
  );
  assert.equal(portalPrefsFor(piet, [{ email: 'piet@boekhouder.nl', notify_scope: 'raar' }]).scope, 'own', 'onbekende waarde = standaard');
});

test('indiener en "zelf gedaan" herkennen', () => {
  const ticket = { created_by_contact_id: CONTACT_ANJA, created_by_email: 'anja@dekorenaar.nl' };
  assert.equal(isTicketRequester(anja, ticket), true);
  assert.equal(isTicketRequester(joost, ticket), false);
  assert.equal(isTicketRequester(joost, { created_by_contact_id: null, created_by_email: 'Joost@dekorenaar.nl' }), true);
  // Een reactie uit het portaal zonder contactpersoon komt van het hoofdadres.
  assert.equal(isPortalActor(joost, { actor_type: 'client', actor_contact_id: null, actor_email: null }), true);
  assert.equal(isPortalActor(anja, { actor_type: 'client', actor_contact_id: null, actor_email: null }), false);
  assert.equal(isPortalActor(anja, { actor_type: 'client', actor_contact_id: CONTACT_ANJA, actor_email: null }), true);
  assert.equal(isPortalActor(joost, { actor_type: 'staff', actor_contact_id: null, actor_email: null }), false);
});

test('nieuw ticket uit het portaal: bevestiging voor de indiener, melding voor het hoofdadres, niets voor de boekhouder', () => {
  const created = activity({ kind: 'created', new_status: 'new', actor_type: 'client', actor_contact_id: CONTACT_ANJA, actor_email: 'anja@dekorenaar.nl' });
  const result = plan({ activity: [created], ticket: { id: TICKET, client_id: CLIENT, status: 'new', created_by_contact_id: CONTACT_ANJA, created_by_email: 'anja@dekorenaar.nl' } });
  assert.deepEqual(recipients(result), ['joost@dekorenaar.nl', 'anja@dekorenaar.nl']);
  const [toJoost, toAnja] = result.mails;
  assert.equal(toAnja.confirmation, true);
  assert.equal(toAnja.created, null);
  assert.equal(toJoost.confirmation, false);
  assert.equal(toJoost.created?.id, created.id);
  assert.deepEqual(toJoost.activityIds, [created.id]);
});

test('antwoord van het team gaat naar indiener en hoofdadres; status en antwoord samen in één mail', () => {
  const status = activity({ kind: 'status', old_status: 'new', new_status: 'review' });
  const reply = activity({ kind: 'reply', note_id: 'n1' });
  const result = plan({ activity: [reply, status], visibleNoteIds: new Set(['n1']) });
  assert.deepEqual(recipients(result), ['joost@dekorenaar.nl', 'anja@dekorenaar.nl']);
  for (const mail of result.mails) {
    assert.deepEqual(mail.status, { from: 'new', to: 'review' });
    assert.deepEqual(mail.replies.map((r) => r.id), [reply.id]);
    assert.deepEqual([...mail.activityIds].sort(), [reply.id, status.id].sort());
  }
});

test('wie zelf reageert, krijgt de eigen reactie niet gemaild — de anderen wel', () => {
  const fromAnja = activity({ kind: 'reply', note_id: 'n2', actor_type: 'client', actor_contact_id: CONTACT_ANJA });
  const result = plan({ activity: [fromAnja], visibleNoteIds: new Set(['n2']) });
  assert.deepEqual(recipients(result), ['joost@dekorenaar.nl']);

  const fromJoost = activity({ kind: 'reply', note_id: 'n3', actor_type: 'client' });
  assert.deepEqual(recipients(plan({ activity: [fromJoost], visibleNoteIds: new Set(['n3']) })), ['anja@dekorenaar.nl']);
});

test('eigen keuzes tellen: soort uit, of alleen eigen tickets', () => {
  const reply = activity({ kind: 'reply', note_id: 'n4' });
  const visibleNoteIds = new Set(['n4']);
  // Joost zet antwoorden uit; Piet wil alles van de klant zien.
  const result = plan({
    activity: [reply],
    visibleNoteIds,
    settings: [
      { email: 'joost@dekorenaar.nl', notify_ticket_reply: false },
      { email: 'piet@boekhouder.nl', notify_scope: 'all' },
    ],
  });
  assert.deepEqual(recipients(result), ['anja@dekorenaar.nl', 'piet@boekhouder.nl']);

  // Joost alleen over eigen tickets: dit ticket diende Anja in.
  const own = plan({ activity: [reply], visibleNoteIds, settings: [{ email: 'joost@dekorenaar.nl', notify_scope: 'own' }] });
  assert.deepEqual(recipients(own), ['anja@dekorenaar.nl']);
});

test('een antwoord dat weg is of weer intern is, gaat nooit de deur uit', () => {
  const gone = activity({ kind: 'reply', note_id: 'n5' });
  const deleted = activity({ kind: 'reply', note_id: null });
  const result = plan({ activity: [gone, deleted], visibleNoteIds: new Set() });
  assert.deepEqual(result.mails, []);
  assert.deepEqual(result.skipped.map((s) => s.id).sort(), [gone.id, deleted.id].sort());
});

test('status die per saldo terug is, is geen nieuws', () => {
  const a = activity({ kind: 'status', old_status: 'new', new_status: 'review' });
  const b = activity({ kind: 'status', old_status: 'review', new_status: 'new' });
  const result = plan({ activity: [a, b], ticket: { id: TICKET, client_id: CLIENT, status: 'new', created_by_contact_id: null, created_by_email: null } });
  assert.deepEqual(result.mails, []);
  assert.deepEqual(result.skipped.map((s) => s.id), [a.id, b.id]);

  const c = activity({ kind: 'status', old_status: 'new', new_status: 'review' });
  const d = activity({ kind: 'status', old_status: 'review', new_status: 'approved' });
  const net = plan({ activity: [d, c], ticket: { id: TICKET, client_id: CLIENT, status: 'approved', created_by_contact_id: null, created_by_email: null } });
  // Ticket van het team: alleen wie "alle tickets" volgt.
  assert.deepEqual(recipients(net), ['joost@dekorenaar.nl']);
  assert.deepEqual(net.mails[0].status, { from: 'new', to: 'approved' });
});

test('al bezorgd, onbestelbaar of verhuisd: overslaan', () => {
  const reply = activity({ kind: 'reply', note_id: 'n6', notified_emails: ['joost@dekorenaar.nl'] });
  const result = plan({ activity: [reply], visibleNoteIds: new Set(['n6']), suppressed: new Set(['anja@dekorenaar.nl']) });
  assert.deepEqual(result.mails, [], 'Joost had hem al, Anja is gebounced');

  const moved = activity({ kind: 'reply', note_id: 'n7', client_id: 'c0000000-0000-4000-8000-000000000999' });
  const movedResult = plan({ activity: [moved], visibleNoteIds: new Set(['n7']) });
  assert.deepEqual(movedResult.mails, []);
  assert.equal(movedResult.skipped[0].id, moved.id);
});

test('nieuw ticket door het team bundelt een gelijktijdige statuswijziging', () => {
  const created = activity({ kind: 'created', new_status: 'new' });
  const status = activity({ kind: 'status', old_status: 'new', new_status: 'review' });
  const result = plan({ activity: [created, status], ticket: { id: TICKET, client_id: CLIENT, status: 'review', created_by_contact_id: null, created_by_email: null } });
  assert.deepEqual(recipients(result), ['joost@dekorenaar.nl']);
  assert.equal(result.mails[0].status, null, 'de huidige status staat al in de mail over het nieuwe ticket');
  assert.deepEqual([...result.mails[0].activityIds].sort(), [created.id, status.id].sort());
});

test('labels en links', () => {
  assert.equal(portalTicketStatusLabel('review'), 'In behandeling');
  assert.equal(portalTicketStatusLabel('toString'), 'toString', 'geen prototype-lek');
  assert.equal(portalStatusSentence('converted'), 'omgezet naar een project');
  assert.equal(portalTicketUrl('https://app.resofly.nl/', CLIENT, TICKET), `https://app.resofly.nl/portal?dossier=${CLIENT}&ticket=${TICKET}`);
  assert.equal(portalSettingsUrl('https://app.resofly.nl', CLIENT), `https://app.resofly.nl/portal?dossier=${CLIENT}&view=instellingen`);
});

// ── De mail zelf ─────────────────────────────────────────────────────────

const base = {
  companyName: 'Studio Lopik',
  accentColor: '#3366FF',
  recipientName: 'Joost',
  ticket: { title: 'Website laadt traag', statusLabel: 'In behandeling' },
  ownTicket: true,
  confirmation: false,
  newTicket: false,
  replies: [] as Array<{ authorName: string; fromTeam: boolean; body: string; at: string }>,
  ticketUrl: `https://app.resofly.nl/portal?dossier=${CLIENT}&ticket=${TICKET}`,
  settingsUrl: `https://app.resofly.nl/portal?dossier=${CLIENT}&view=instellingen`,
};

test('mail: onderwerp volgt wat er gebeurde', () => {
  assert.equal(renderPortalTicketUpdateEmail({ ...base, confirmation: true }).subject, 'Ticket ontvangen: Website laadt traag');
  assert.equal(renderPortalTicketUpdateEmail({ ...base, newTicket: true }).subject, 'Nieuw ticket: Website laadt traag');
  const reply = { authorName: 'Studio Lopik', fromTeam: true, body: 'We kijken ernaar.', at: '2026-10-04T12:05:00Z' };
  assert.equal(renderPortalTicketUpdateEmail({ ...base, replies: [reply] }).subject, 'Nieuw antwoord: Website laadt traag');
  assert.equal(renderPortalTicketUpdateEmail({ ...base, replies: [reply, reply] }).subject, '2 nieuwe antwoorden: Website laadt traag');
  assert.equal(
    renderPortalTicketUpdateEmail({ ...base, status: { fromLabel: 'Nieuw', toLabel: 'In behandeling', sentence: 'in behandeling genomen' } }).subject,
    'Ticket in behandeling genomen: Website laadt traag',
  );
});

test('mail: tekst van mensen wordt ge-escaped, ook in titel en naam; onderwerp blijft één regel', () => {
  const rendered = renderPortalTicketUpdateEmail({
    ...base,
    ticket: { title: 'Fout <script>alert(1)</script>\nBcc: iemand@x.nl', statusLabel: 'Nieuw' },
    replies: [{ authorName: 'Anja <b>', fromTeam: false, body: 'Zie <img src=x onerror=alert(1)>\nregel twee', at: '2026-10-04T12:05:00Z' }],
  });
  assert.ok(!rendered.html.includes('<script>'));
  assert.ok(!rendered.html.includes('<img src=x'));
  assert.ok(rendered.html.includes('&lt;img src=x onerror=alert(1)&gt;<br/>regel twee'));
  assert.ok(rendered.html.includes('Anja &lt;b&gt;'));
  assert.ok(!/[\r\n]/.test(rendered.subject), 'geen header-injectie via de titel');
  assert.match(rendered.text, /regel twee/);
});

test('mail: deeplink naar het ticket en een link om meldingen te beheren; tijd in Nederlandse tijd', () => {
  const rendered = renderPortalTicketUpdateEmail({
    ...base,
    replies: [{ authorName: 'Studio Lopik', fromTeam: true, body: 'Opgelost.', at: '2026-10-04T12:05:00Z' }],
  });
  assert.ok(rendered.html.includes(`ticket=${TICKET}`));
  assert.ok(rendered.html.includes('view=instellingen'));
  assert.ok(rendered.html.includes('Meldingen beheren'));
  assert.ok(rendered.text.includes('14:05'), 'zomertijd: 12:05 UTC is 14:05 in Nederland');
  assert.equal(rendered.templateKey, 'portal.ticketUpdate');
});

test('mail: een lang antwoord wordt afgekapt; het hele stuk staat in het portaal', () => {
  const long = 'x'.repeat(5000);
  const rendered = renderPortalTicketUpdateEmail({ ...base, replies: [{ authorName: 'Studio Lopik', fromTeam: true, body: long, at: '2026-10-04T12:05:00Z' }] });
  assert.ok(!rendered.text.includes('x'.repeat(2100)));
  assert.ok(rendered.text.includes('…'));
});
