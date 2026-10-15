import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayGreeting, firstName, portalSummary } from './portalGreeting.ts';

test('de groet volgt de klok, net als het dashboard', () => {
  assert.equal(dayGreeting(new Date(2026, 9, 15, 5, 59)), 'Goedenacht');
  assert.equal(dayGreeting(new Date(2026, 9, 15, 9, 0)), 'Goedemorgen');
  assert.equal(dayGreeting(new Date(2026, 9, 15, 12, 0)), 'Goedemiddag');
  assert.equal(dayGreeting(new Date(2026, 9, 15, 18, 0)), 'Goedenavond');
});

test('alleen een echte voornaam komt in de groet', () => {
  assert.equal(firstName('Joost Vermeer'), 'Joost');
  assert.equal(firstName('  Maria  '), 'Maria');
  assert.equal(firstName('joost@bakkerij.nl'), '');
  assert.equal(firstName(null), '');
});

test('de samenvatting telt goed en zet "en" tussen de laatste twee', () => {
  const none = { openInvoices: 0, overdueInvoices: 0, unreadTickets: 0, unreadThreads: 0 };
  assert.equal(portalSummary(none), 'Alles is bij: er staat niets voor je open.');
  assert.equal(portalSummary({ ...none, openInvoices: 1, unreadTickets: 1 }), 'Er staat 1 factuur open en er is 1 nieuw antwoord op je ticket.');
  assert.equal(portalSummary({ ...none, openInvoices: 3 }), 'Er staan 3 facturen open.');
  assert.equal(
    portalSummary({ openInvoices: 2, overdueInvoices: 1, unreadTickets: 2, unreadThreads: 1 }),
    'Er is 1 factuur vervallen, er zijn 2 nieuwe antwoorden op je tickets en je hebt 1 nieuw bericht.',
  );
  assert.equal(portalSummary({ ...none, unreadThreads: 4 }), 'Je hebt 4 nieuwe berichten.');
});
