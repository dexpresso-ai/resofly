/**
 * Tests voor de rekenkern van Stroom: de stroom op Vandaag, de stroomlijn van
 * een klant en het ontleden van een opdracht in het eiland. Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPosition, computeStream, intentGaps, parseIntent, type StreamInput } from './stroom.ts';
import { computeTotals } from './money.ts';

const NOW = new Date(2026, 9, 30, 10, 0, 0); // vrijdag 30 oktober 2026, 10:00
const line = (unit_price: number, quantity = 1, vat = 21) => ({ id: `l${unit_price}-${quantity}`, description: 'Werk', quantity, unit_price, vat });
const amount: StreamInput['amount'] = lines => computeTotals(lines).total;

const clients = [
  { id: 'c-bloem', name: 'Restaurant Bloem', color: '#E86A6A' },
  { id: 'c-koren', name: 'Bakkerij De Korenaar', color: '#E0A11B' },
  { id: 'c-dijk', name: 'Van Dijk Installatietechniek', color: '#4C8EE6' },
  { id: 'c-content', name: 'Content Factory', color: '#34B98A' },
];
const projects = [
  { id: 'p-menu', name: 'Menukaart & social', client_id: 'c-bloem', archived: false },
  { id: 'p-huis', name: 'Nieuwe huisstijl', client_id: 'c-koren', archived: false },
  { id: 'p-oud', name: 'Oude website', client_id: 'c-koren', archived: true },
];

// Alleen de velden die de stroom leest; de rest van een offerte of factuur doet er niet toe.
type Doc = Record<string, unknown>;
const quote = (over: Doc) => ({ id: 'q', number: '2026-001', client_id: 'c-bloem', project_id: null, date: '2026-10-01', valid_until: null, lines: [line(1000)], status: 'sent', sent_at: '2026-10-01T09:00:00Z', accepted_at: null, client_decision_at: null, last_email_opened_at: null, ...over });
const invoice = (over: Doc) => ({ id: 'i', number: '2026-101', client_id: 'c-bloem', project_id: null, quote_id: null, date: '2026-10-01', due_date: '2026-11-14', lines: [line(500)], status: 'sent', sent_at: '2026-10-01T09:00:00Z', paid_at: null, last_reminder_at: null, ...over });

function streamOf(quotes: Doc[], invoices: Doc[]) {
  return computeStream({ quotes: quotes as never, invoices: invoices as never, clients, amount, now: NOW });
}

test('Factuur in de stroom = Openstaand op Vandaag: verstuurd of te laat, bruto', () => {
  const invoices = [
    invoice({ id: 'i1', status: 'sent', lines: [line(650)] }),
    invoice({ id: 'i2', status: 'overdue', lines: [line(1234.56)] }),
    invoice({ id: 'i3', status: 'draft', lines: [line(99)] }),
    invoice({ id: 'i4', status: 'cancelled', lines: [line(5000)] }),
    invoice({ id: 'i5', status: 'paid', paid_at: '2026-09-12T10:00:00Z', lines: [line(300)] }),
  ];
  const stream = streamOf([], invoices);
  const factuur = stream.stations.find(s => s.id === 'factuur');
  // Zoals Dashboard.tsx: status sent of overdue, opgeteld met total(lines).total.
  const outstanding = invoices.filter(i => i.status === 'sent' || i.status === 'overdue').reduce((sum, i) => sum + computeTotals(i.lines as never).total, 0);
  assert.equal(factuur?.amount, outstanding);
  assert.equal(factuur?.amount, 786.5 + 1493.82);
  assert.deepEqual(factuur?.items.map(i => i.refId).sort(), ['i1', 'i2']);
});

test('Betaald in de stroom = Omzet deze maand: betaald in de lopende maand', () => {
  const stream = streamOf([], [
    invoice({ id: 'i1', status: 'paid', paid_at: '2026-10-03T10:00:00Z', lines: [line(1000)] }),
    invoice({ id: 'i2', status: 'paid', paid_at: '2026-09-30T10:00:00Z', lines: [line(1000)] }),
    // Zonder betaaldatum telt de factuurdatum, net als op Vandaag.
    invoice({ id: 'i3', status: 'paid', paid_at: null, date: '2026-10-20', lines: [line(100)] }),
  ]);
  const betaald = stream.stations.find(s => s.id === 'betaald');
  assert.equal(betaald?.amount, 1210 + 121);
  assert.deepEqual(betaald?.items.map(i => i.refId).sort(), ['i1', 'i3']);
});

test('een offerte reist van Gesprek naar Offerte naar Werk; gefactureerd verlaat hij Werk', () => {
  const stream = streamOf([
    quote({ id: 'q-draft', status: 'draft' }),
    quote({ id: 'q-int', status: 'pending_internal_approval' }),
    quote({ id: 'q-sent', status: 'sent' }),
    quote({ id: 'q-ok', status: 'accepted' }),
    quote({ id: 'q-done', status: 'accepted' }),
    quote({ id: 'q-no', status: 'rejected' }),
  ], [invoice({ id: 'i-done', status: 'sent', quote_id: 'q-done' })]);
  const at = (id: string) => stream.items.find(item => item.refId === id)?.station ?? null;
  assert.equal(at('q-draft'), 'gesprek');
  assert.equal(at('q-int'), 'gesprek');
  assert.equal(at('q-sent'), 'offerte');
  assert.equal(at('q-ok'), 'werk');
  assert.equal(at('q-done'), null, 'al gefactureerd: de factuur staat in de stroom, niet de offerte nog eens');
  assert.equal(at('q-no'), null);
  assert.equal(at('i-done'), 'factuur');
});

test('knopen: een week bij de klant wacht, verlopen en te laat zijn rood, een herinnering maakt los', () => {
  const stream = streamOf([
    quote({ id: 'q-new', sent_at: '2026-10-28T09:00:00Z' }),
    quote({ id: 'q-wait', sent_at: '2026-10-20T09:00:00Z' }),
    quote({ id: 'q-exp', sent_at: '2026-10-28T09:00:00Z', valid_until: '2026-10-29' }),
  ], [
    invoice({ id: 'i-late', due_date: '2026-10-15' }),
    invoice({ id: 'i-calm', due_date: '2026-10-15', last_reminder_at: '2026-10-29T08:00:00Z' }),
    invoice({ id: 'i-ok', due_date: '2026-11-20' }),
  ]);
  const knot = (id: string) => stream.items.find(item => item.refId === id)?.knot ?? null;
  assert.equal(knot('q-new'), null);
  assert.equal(knot('q-wait'), 'wait');
  assert.equal(knot('q-exp'), 'late');
  assert.equal(knot('i-late'), 'late');
  assert.equal(knot('i-calm'), 'sent');
  assert.equal(knot('i-ok'), null);
  const factuur = stream.stations.find(s => s.id === 'factuur');
  assert.equal(factuur?.late, 1);
  assert.equal(factuur?.sent, 1);
});

test('stroomlijn: de verste open halte van een klant, met zijn zwaarste knoop', () => {
  const stream = streamOf([quote({ id: 'q1', client_id: 'c-koren', sent_at: '2026-10-10T09:00:00Z' })], [
    invoice({ id: 'i1', client_id: 'c-koren', status: 'paid', paid_at: '2026-10-02T10:00:00Z' }),
    invoice({ id: 'i2', client_id: 'c-bloem', status: 'paid', paid_at: '2026-10-02T10:00:00Z' }),
  ]);
  const koren = clientPosition(stream, 'c-koren');
  assert.equal(koren.station, 'offerte');
  assert.equal(koren.knot, 'wait');
  assert.equal(koren.items.length, 2);
  assert.equal(clientPosition(stream, 'c-bloem').station, 'betaald');
  assert.equal(clientPosition(stream, 'c-dijk').station, null);
});

const ctx = { clients, projects };

test('factuur: klant, omschrijving en bedrag excl. btw', () => {
  const intent = parseIntent('factuur bloem content oktober 650', ctx, NOW);
  assert.equal(intent?.kind, 'factuur');
  assert.equal(intent?.clientId, 'c-bloem');
  assert.equal(intent?.description, 'Content oktober');
  assert.equal(intent?.amount, 650);
  assert.deepEqual(intentGaps(intent!), []);
});

test('bij gelijke stand wint het woord dat eerst staat', () => {
  assert.equal(parseIntent('factuur bloem content 650', ctx, NOW)?.clientId, 'c-bloem');
  assert.equal(parseIntent('factuur content bloemstukken 650', ctx, NOW)?.clientId, 'c-content');
});

test('bedragen in Nederlandse notatie, met of zonder euroteken', () => {
  assert.equal(parseIntent('offerte korenaar huisstijl € 1.250,50', ctx, NOW)?.amount, 1250.5);
  assert.equal(parseIntent('offerte korenaar 2400 euro', ctx, NOW)?.amount, 2400);
  const gaps = intentGaps(parseIntent('factuur nieuwe klant', ctx, NOW)!);
  assert.deepEqual(gaps, ['klant', 'bedrag']);
});

test('taak: de klant blijft in de omschrijving staan, met dag en tijd eruit', () => {
  const intent = parseIntent('taak bel van dijk over de offerte morgen om 14:30', ctx, NOW);
  assert.equal(intent?.kind, 'taak');
  assert.equal(intent?.clientId, 'c-dijk');
  assert.equal(intent?.date, '2026-10-31');
  assert.equal(intent?.minute, 14 * 60 + 30);
  assert.equal(intent?.description, 'Bel van dijk over de offerte');
});

test('taak bij een klant met één open project hangt aan dat project', () => {
  const intent = parseIntent('taak korenaar logo-schetsen afronden', ctx, NOW);
  assert.equal(intent?.projectId, 'p-huis', 'het gearchiveerde project telt niet mee');
});

test('weekdagen: de eerstvolgende, vandaag meegerekend', () => {
  assert.equal(parseIntent('afspraak bloem vrijdag 10.00', ctx, NOW)?.date, '2026-10-30');
  assert.equal(parseIntent('afspraak bloem maandag', ctx, NOW)?.date, '2026-11-02');
  assert.equal(parseIntent('afspraak bloem overmorgen om 9 uur', ctx, NOW)?.minute, 9 * 60);
});

test('uren: tijd in uren of minuten, project als veld', () => {
  const a = parseIntent('uren korenaar huisstijl 2,5u', ctx, NOW);
  assert.equal(a?.minutes, 150);
  assert.equal(a?.projectId, 'p-huis');
  assert.equal(parseIntent('uren bloem 45 min', ctx, NOW)?.minutes, 45);
});

test('geen opdracht: dan zoekt het eiland of vraagt het Gerrie', () => {
  assert.equal(parseIntent('wat staat er open bij bloem?', ctx, NOW), null);
  assert.equal(parseIntent('Restaurant Bloem', ctx, NOW), null);
  assert.equal(parseIntent('facturen', ctx, NOW), null);
});
