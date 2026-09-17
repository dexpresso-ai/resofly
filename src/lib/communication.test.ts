/**
 * Tests voor de hulpfuncties van de pagina Berichten. Draaien met:  npm test
 *
 * Het gesprekkenoverzicht is de plek waar iemand 's ochtends kijkt of er post
 * is; een filter dat stilletjes een gesprek verbergt, of "Re: Re: Re:" in een
 * onderwerp, valt daar meteen op. Daarom staan de regels hier vast — ook nu
 * tickets tussen de mail staan en er op datum en door alle notities gezocht
 * kan worden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClientEmailThreadOverview, Ticket, TicketNote } from '../types.ts';
import {
  NO_CLIENT, countUnread, emailConversation, filterConversations, initials, listTime, matchesWords, periodRange,
  previewLine, queryWords, replySubject, searchSnippet, senderShortName, sortConversations,
} from './communication.ts';
import { groupNotesByTicket, noteAuthorShort, ticketConversation, ticketLastActivity, ticketMatchesStatus } from './tickets.ts';

function thread(over: Partial<ClientEmailThreadOverview> = {}): ClientEmailThreadOverview {
  return {
    id: 'thread-1', organization_id: 'org-1', created_by: null, client_id: 'client-a',
    client_name: 'Bakkerij De Korenaar', client_email: 'joost@dekorenaar.nl',
    subject: 'Re: offerte huisstijl', last_message_at: '2026-09-17T09:00:00Z', last_direction: 'inbound',
    created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-17T09:00:00Z',
    message_count: 3, unread_count: 1, has_delivery_problem: false,
    last_email_id: 'mail-3', last_email_direction: 'inbound', last_from_name: 'Joost Vermeer',
    last_from_email: 'joost@dekorenaar.nl', last_status: 'received', last_email_at: '2026-09-17T09:00:00Z',
    last_preview: 'Dank voor de offerte, we gaan akkoord.',
    ...over,
  };
}

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1', organization_id: 'org-1', created_by: null, client_id: 'client-a',
    title: 'Website laadt traag op mobiel', description: 'Vooral de startpagina.', priority: 'high', status: 'new',
    notes: null, converted_to_project_id: null, created_at: '2026-09-10T08:00:00Z', updated_at: '2026-09-10T08:00:00Z',
    ...over,
  };
}

function note(over: Partial<TicketNote> = {}): TicketNote {
  return {
    id: 'note-1', organization_id: 'org-1', created_by: null, ticket_id: 'ticket-1',
    author_type: 'client', author_user_id: null, author_name: 'Maria Jansen',
    body: 'Vooral op de pagina met afspraken duurt het lang.', is_internal: false,
    created_at: '2026-09-16T14:00:00Z', updated_at: '2026-09-16T14:00:00Z',
    ...over,
  };
}

const korenaar = emailConversation(thread());
const fysio = emailConversation(thread({ id: 'thread-2', client_id: 'client-b', client_name: 'Fysio Centrum Zuid', subject: 'Planning fotoshoot', unread_count: 0, last_message_at: '2026-09-12T10:00:00Z', last_email_direction: 'outbound', last_from_name: 'Studio', last_from_email: 'info@studio.nl', last_preview: 'Zullen we donderdag doen?' }));
const traag = ticketConversation(ticket(), [note(), note({ id: 'note-2', author_type: 'user', author_user_id: 'user-me', author_name: 'gerjan@studio.nl', body: 'We kijken naar de afbeeldingen, die zijn te groot.', is_internal: true, created_at: '2026-09-16T15:00:00Z' })], { clientName: 'Bakkerij De Korenaar', unread: true, currentUserId: 'user-me' });
const losTicket = ticketConversation(ticket({ id: 'ticket-2', client_id: null, title: 'Vraag via de website', description: null, status: 'review', created_at: '2026-08-01T08:00:00Z' }), [], { clientName: null, unread: false });
const all = [korenaar, fysio, traag, losTicket];
const noFilter = { tab: 'all' as const, query: '', clientId: '', kind: '' as const, from: null, to: null };

test('emailConversation: sleutel, onderwerp en preview komen uit de view', () => {
  assert.equal(korenaar.key, 'email:thread-1');
  assert.equal(korenaar.subject, 'Re: offerte huisstijl');
  assert.equal(korenaar.preview, 'Joost: Dank voor de offerte, we gaan akkoord.');
  assert.equal(korenaar.unread, 1);
  assert.equal(emailConversation(thread({ subject: '' })).subject, '(geen onderwerp)');
});

test('ticketConversation: de laatste notitie is de preview, "Jij" voor je eigen notitie, activiteit = laatste notitie', () => {
  assert.equal(traag.key, 'ticket:ticket-1');
  assert.equal(traag.preview, 'Jij: We kijken naar de afbeeldingen, die zijn te groot.');
  assert.equal(traag.lastAt, '2026-09-16T15:00:00Z');
  assert.equal(traag.unread, 1);
  assert.equal(traag.notes.map(n => n.id).join(','), 'note-1,note-2');
});

test('ticketConversation: zonder notities is de omschrijving de preview, zonder klant heet de klant "Geen klant"', () => {
  const t = ticketConversation(ticket(), [], { clientName: 'Bakkerij De Korenaar', unread: false });
  assert.equal(t.preview, 'Vooral de startpagina.');
  assert.equal(t.lastAt, '2026-09-10T08:00:00Z');
  assert.equal(losTicket.preview, 'Nog geen reacties');
  assert.equal(losTicket.clientName, 'Geen klant');
  assert.equal(losTicket.clientId, null);
});

test('sortConversations: nieuwste activiteit bovenaan, mail en tickets door elkaar', () => {
  assert.deepEqual(sortConversations([losTicket, fysio, traag, korenaar]).map(c => c.key), ['email:thread-1', 'ticket:ticket-1', 'email:thread-2', 'ticket:ticket-2']);
});

test('filterConversations: zonder filters komt alles terug, in dezelfde volgorde', () => {
  assert.deepEqual(filterConversations(all, noFilter), all);
});

test('filterConversations: het tabblad Ongelezen toont ongelezen mail én tickets met nieuwe klant-activiteit', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, tab: 'unread' }).map(c => c.key), ['email:thread-1', 'ticket:ticket-1']);
});

test('filterConversations: het tabblad Niet gekoppeld toont geen gesprekken', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, tab: 'inbox' }), []);
});

test('filterConversations: het soortfilter houdt alleen mail of alleen tickets over', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, kind: 'email' }).map(c => c.key), ['email:thread-1', 'email:thread-2']);
  assert.deepEqual(filterConversations(all, { ...noFilter, kind: 'ticket' }).map(c => c.key), ['ticket:ticket-1', 'ticket:ticket-2']);
});

test('filterConversations: klantfilter geldt voor mail en tickets samen; "zonder klant" vindt het losse ticket', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, clientId: 'client-a' }).map(c => c.key), ['email:thread-1', 'ticket:ticket-1']);
  assert.deepEqual(filterConversations(all, { ...noFilter, clientId: NO_CLIENT }).map(c => c.key), ['ticket:ticket-2']);
});

test('filterConversations: datumfilter kijkt naar de laatste activiteit, van en tot zijn inclusief (lokale dagen)', () => {
  // De tijden liggen op 09:00Z / 15:00Z, ruim binnen dezelfde lokale dag in elke tijdzone van Europa.
  assert.deepEqual(filterConversations(all, { ...noFilter, from: '2026-09-16', to: null }).map(c => c.key), ['email:thread-1', 'ticket:ticket-1']);
  assert.deepEqual(filterConversations(all, { ...noFilter, from: null, to: '2026-09-12' }).map(c => c.key), ['email:thread-2', 'ticket:ticket-2']);
  assert.deepEqual(filterConversations(all, { ...noFilter, from: '2026-09-16', to: '2026-09-16' }).map(c => c.key), ['ticket:ticket-1']);
});

test('filterConversations: zoekwoorden mogen in willekeurige volgorde over klant en onderwerp heen', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'korenaar offerte' }).map(c => c.key), ['email:thread-1']);
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'offerte korenaar' }).map(c => c.key), ['email:thread-1']);
});

test('filterConversations: zoeken negeert hoofdletters en accenten, en kijkt ook in de preview', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'DONDERDAG' }).map(c => c.key), ['email:thread-2']);
  const accent = emailConversation(thread({ id: 'thread-3', client_name: 'Café Résumé' }));
  assert.deepEqual(filterConversations([accent], { ...noFilter, query: 'cafe resume' }).map(c => c.key), ['email:thread-3']);
});

test('filterConversations: bij een ticket wordt in élke notitie gezocht, ook een interne', () => {
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'afbeeldingen te groot' }).map(c => c.key), ['ticket:ticket-1']);
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'afspraken' }).map(c => c.key), ['ticket:ticket-1']);
});

test('filterConversations: een treffer van de server telt mee, ook als de lokale tekst het woord niet bevat — maar de andere filters blijven gelden', () => {
  const matchKeys = new Set(['email:thread-2']);
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'lichtbak', matchKeys }).map(c => c.key), ['email:thread-2']);
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'lichtbak', matchKeys, clientId: 'client-a' }), []);
  assert.deepEqual(filterConversations(all, { ...noFilter, query: 'lichtbak', matchKeys, kind: 'ticket' }), []);
});

test('queryWords en matchesWords: woorden splitsen, normaliseren en allemaal terugvinden', () => {
  assert.deepEqual(queryWords('  Offerte  Café '), ['offerte', 'cafe']);
  assert.equal(matchesWords('Re: offerte voor Café Résumé', ['offerte', 'cafe']), true);
  assert.equal(matchesWords('Re: offerte', ['offerte', 'factuur']), false);
  assert.equal(matchesWords('', []), true);
});

test('periodRange: vandaag, deze week (vanaf maandag), deze maand, 30 dagen en dit jaar', () => {
  const now = new Date(2026, 8, 17, 15, 30); // donderdag 17 september 2026
  assert.deepEqual(periodRange('today', now), { from: '2026-09-17', to: '2026-09-17' });
  assert.deepEqual(periodRange('week', now), { from: '2026-09-14', to: '2026-09-17' });
  assert.deepEqual(periodRange('month', now), { from: '2026-09-01', to: '2026-09-17' });
  assert.deepEqual(periodRange('30d', now), { from: '2026-08-19', to: '2026-09-17' });
  assert.deepEqual(periodRange('90d', now), { from: '2026-06-20', to: '2026-09-17' });
  assert.deepEqual(periodRange('year', now), { from: '2026-01-01', to: '2026-09-17' });
  assert.deepEqual(periodRange('', now), { from: null, to: null });
  assert.deepEqual(periodRange('custom', now), { from: null, to: null });
  // Een zondag hoort nog bij de week die op maandag begon.
  assert.deepEqual(periodRange('week', new Date(2026, 8, 20)), { from: '2026-09-14', to: '2026-09-20' });
});

test('searchSnippet: een stukje rond de eerste treffer, uit de originele tekst, met puntjes waar geknipt is', () => {
  const text = 'Beste Joost, hierbij de offerte voor de nieuwe lichtbak aan de gevel. We rekenen op levering in oktober. Groet, Studio';
  const snippet = searchSnippet(text, ['lichtbak'], 20);
  assert.ok(snippet, 'er hoort een snippet te zijn');
  assert.ok(snippet.includes('lichtbak'), snippet);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), snippet);
  assert.equal(searchSnippet(text, ['factuur']), null);
  assert.equal(searchSnippet('', ['x']), null);
  // Accenten: gezocht zonder, getoond mét.
  assert.equal(searchSnippet('Café Résumé belde', ['resume'], 40), 'Café Résumé belde');
  // Een emoji vóór de treffer verschuift de knip niet.
  assert.ok(searchSnippet('🎉 feest lichtbak klaar', ['lichtbak'], 3)?.includes('lichtbak'));
});

test('countUnread telt mail-berichten en tickets samen en negeert negatieve waarden', () => {
  assert.equal(countUnread(all), 2);
  assert.equal(countUnread([{ unread: 2 }, { unread: -5 }]), 2);
});

test('ticketLastActivity en groupNotesByTicket: laatste notitie wint, notities oudste eerst per ticket', () => {
  const notes = [note({ id: 'b', created_at: '2026-09-16T15:00:00Z' }), note({ id: 'a', created_at: '2026-09-16T14:00:00Z' }), note({ id: 'c', ticket_id: 'ticket-2' })];
  const grouped = groupNotesByTicket(notes);
  assert.deepEqual(grouped.get('ticket-1')?.map(n => n.id), ['a', 'b']);
  assert.deepEqual(grouped.get('ticket-2')?.map(n => n.id), ['c']);
  assert.equal(ticketLastActivity(ticket(), grouped.get('ticket-1') ?? []), '2026-09-16T15:00:00Z');
  assert.equal(ticketLastActivity(ticket(), []), '2026-09-10T08:00:00Z');
});

test('ticketMatchesStatus: leeg = alles, open = nieuw/review/goedgekeurd, anders precies die status', () => {
  assert.equal(ticketMatchesStatus(ticket({ status: 'rejected' }), ''), true);
  assert.equal(ticketMatchesStatus(ticket({ status: 'approved' }), 'open'), true);
  assert.equal(ticketMatchesStatus(ticket({ status: 'rejected' }), 'open'), false);
  assert.equal(ticketMatchesStatus(ticket({ status: 'review' }), 'review'), true);
  assert.equal(ticketMatchesStatus(ticket({ status: 'review' }), 'new'), false);
});

test('noteAuthorShort: klant met voornaam, teamlid als deel vóór de @, jijzelf als "Jij"', () => {
  assert.equal(noteAuthorShort(note()), 'Maria');
  assert.equal(noteAuthorShort(note({ author_name: null })), 'Klant');
  assert.equal(noteAuthorShort(note({ author_type: 'user', author_user_id: 'u1', author_name: 'gerjan@studio.nl' })), 'gerjan');
  assert.equal(noteAuthorShort(note({ author_type: 'user', author_user_id: 'u1', author_name: 'gerjan@studio.nl' }), 'u1'), 'Jij');
  assert.equal(noteAuthorShort(note({ author_type: 'user', author_user_id: 'u1', author_name: null })), 'Teamlid');
});

test('replySubject zet één keer "Re:" ervoor', () => {
  assert.equal(replySubject('offerte huisstijl'), 'Re: offerte huisstijl');
  assert.equal(replySubject('Re: offerte huisstijl'), 'Re: offerte huisstijl');
  assert.equal(replySubject('RE: offerte'), 'RE: offerte');
  assert.equal(replySubject('Antw: factuur'), 'Antw: factuur');
  assert.equal(replySubject('   '), 'Re: (geen onderwerp)');
  assert.equal(replySubject(null), 'Re: (geen onderwerp)');
});

test('initials: twee woorden geven twee letters, één woord de eerste twee', () => {
  assert.equal(initials('Bakkerij De Korenaar'), 'BD');
  assert.equal(initials('Bloem'), 'BL');
  assert.equal(initials('  '), '?');
});

test('senderShortName: voornaam uit de weergavenaam, anders het deel vóór de @', () => {
  assert.equal(senderShortName('Joost Vermeer', 'joost@dekorenaar.nl'), 'Joost');
  assert.equal(senderShortName('', 'joost@dekorenaar.nl'), 'joost');
  assert.equal(senderShortName(null, null), 'Onbekend');
});

test('previewLine: "Jij:" bij uitgaand, de afzender bij inkomend, en een nette leegte', () => {
  assert.equal(previewLine(fysio.thread), 'Jij: Zullen we donderdag doen?');
  assert.equal(previewLine(korenaar.thread), 'Joost: Dank voor de offerte, we gaan akkoord.');
  assert.equal(previewLine(thread({ last_email_direction: null, message_count: 0 })), 'Nog geen berichten');
  assert.equal(previewLine(thread({ last_preview: '' })), 'Joost: (geen tekst)');
});

test('listTime: vandaag de tijd, gisteren, de weekdag, anders de datum', () => {
  const now = new Date(2026, 8, 17, 15, 30);
  assert.equal(listTime(new Date(2026, 8, 17, 9, 5).toISOString(), now), '09:05');
  assert.equal(listTime(new Date(2026, 8, 16, 9, 5).toISOString(), now), 'gisteren');
  assert.equal(listTime(new Date(2026, 8, 14, 9, 5).toISOString(), now), 'ma');
  assert.equal(listTime(new Date(2026, 8, 3, 9, 5).toISOString(), now), '3 sep');
  assert.equal(listTime(new Date(2025, 11, 24, 9, 5).toISOString(), now), '24-12-25');
  assert.equal(listTime('', now), '');
  assert.equal(listTime('nonsens', now), '');
});
