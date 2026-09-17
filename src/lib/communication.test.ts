/**
 * Tests voor de hulpfuncties van de pagina Berichten. Draaien met:  npm test
 *
 * Het gesprekkenoverzicht is de plek waar iemand 's ochtends kijkt of er post
 * is; een filter dat stilletjes een gesprek verbergt, of "Re: Re: Re:" in een
 * onderwerp, valt daar meteen op. Daarom staan de regels hier vast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClientEmailThreadOverview } from '../types.ts';
import { countUnread, filterThreads, initials, listTime, previewLine, replySubject, senderShortName } from './communication.ts';

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

const korenaar = thread();
const fysio = thread({ id: 'thread-2', client_id: 'client-b', client_name: 'Fysio Centrum Zuid', subject: 'Planning fotoshoot', unread_count: 0, last_email_direction: 'outbound', last_from_name: 'Studio', last_from_email: 'info@studio.nl', last_preview: 'Zullen we donderdag doen?' });
const all = [korenaar, fysio];

test('filterThreads: zonder filters komt alles terug, in dezelfde volgorde', () => {
  assert.deepEqual(filterThreads(all, { tab: 'all', query: '', clientId: '' }), all);
});

test('filterThreads: het tabblad Ongelezen toont alleen gesprekken met ongelezen post', () => {
  assert.deepEqual(filterThreads(all, { tab: 'unread', query: '', clientId: '' }).map(t => t.id), ['thread-1']);
});

test('filterThreads: het tabblad Niet gekoppeld toont geen gesprekken', () => {
  assert.deepEqual(filterThreads(all, { tab: 'inbox', query: '', clientId: '' }), []);
});

test('filterThreads: zoekwoorden mogen in willekeurige volgorde over klant en onderwerp heen', () => {
  assert.deepEqual(filterThreads(all, { tab: 'all', query: 'korenaar offerte', clientId: '' }).map(t => t.id), ['thread-1']);
  assert.deepEqual(filterThreads(all, { tab: 'all', query: 'offerte korenaar', clientId: '' }).map(t => t.id), ['thread-1']);
});

test('filterThreads: zoeken negeert hoofdletters en accenten, en kijkt ook in de preview', () => {
  assert.deepEqual(filterThreads(all, { tab: 'all', query: 'DONDERDAG', clientId: '' }).map(t => t.id), ['thread-2']);
  const accent = thread({ id: 'thread-3', client_name: 'Café Résumé' });
  assert.deepEqual(filterThreads([accent], { tab: 'all', query: 'cafe resume', clientId: '' }).map(t => t.id), ['thread-3']);
});

test('filterThreads: klantfilter en zoektekst werken samen', () => {
  assert.deepEqual(filterThreads(all, { tab: 'all', query: '', clientId: 'client-b' }).map(t => t.id), ['thread-2']);
  assert.deepEqual(filterThreads(all, { tab: 'all', query: 'offerte', clientId: 'client-b' }), []);
});

test('countUnread telt over alle gesprekken en negeert negatieve waarden', () => {
  assert.equal(countUnread(all), 1);
  assert.equal(countUnread([thread({ unread_count: 2 }), thread({ unread_count: -5 })]), 2);
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

test('previewLine: uitgaand heet "Jij", inkomend de afzender', () => {
  assert.equal(previewLine(korenaar), 'Joost: Dank voor de offerte, we gaan akkoord.');
  assert.equal(previewLine(fysio), 'Jij: Zullen we donderdag doen?');
  assert.equal(previewLine(thread({ last_email_direction: null, message_count: 0 })), 'Nog geen berichten');
  assert.equal(previewLine(thread({ last_preview: '' })), 'Joost: (geen tekst)');
});

test('listTime: vandaag de tijd, gisteren als woord, ouder als datum', () => {
  const now = new Date(2026, 8, 17, 15, 30); // 17 september 2026, 15:30
  assert.equal(listTime(new Date(2026, 8, 17, 9, 5).toISOString(), now), '09:05');
  assert.equal(listTime(new Date(2026, 8, 16, 22, 0).toISOString(), now), 'gisteren');
  assert.match(listTime(new Date(2026, 8, 14, 10, 0).toISOString(), now), /^[a-z]{2}$/); // "ma"
  assert.match(listTime(new Date(2026, 5, 1, 10, 0).toISOString(), now), /^1 jun/);
  assert.equal(listTime(new Date(2025, 11, 24, 10, 0).toISOString(), now), '24-12-25');
  assert.equal(listTime(null, now), '');
  assert.equal(listTime('geen datum', now), '');
});
