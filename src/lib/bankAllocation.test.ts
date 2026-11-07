/**
 * Tests voor het verdelen van een banktransactie (bankAllocation.ts): wat het
 * scherm voorstelt en wanneer de knop Boeken aan mag. De database rekent alles
 * na (tests/stromen/bank.mjs); hier gaat het om wat de gebruiker ziet.
 * Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLine, allocationPayload, allocationState, buildManualIndex, centsToInput, emptyDraft, manualMatchesFor, mentionsReference,
  naturalAmount, putRemainder, removeLine, suggestAllocations, type DraftAllocation,
} from './bankAllocation.ts';
import type { BankAllocationCandidates, BankTransaction } from '../types';

function txn(patch: Partial<BankTransaction>): BankTransaction {
  return {
    id: 't1', organization_id: 'o1', bank_account_id: 'b1', statement_id: null, dedup_key: 'c:x:1',
    booking_date: '2026-11-05', value_date: null, amount_cents: 0, currency: 'EUR',
    counterparty_name: null, counterparty_iban: null, description: null, structured_reference: null,
    end_to_end_id: null, bank_tx_id: null, status: 'unmatched', suggested_account_id: null, suggested_vat_code: null,
    matched_rule_id: null, match_confidence: null, matched_invoice_id: null, matched_purchase_invoice_id: null,
    journal_entry_id: null, booked_at: null, booked_by: null, notes: null, created_at: '', updated_at: '',
    ...patch,
  };
}

const CANDIDATES: BankAllocationCandidates = {
  sales_invoices: [
    { id: 'f1', number: 'FAC-2026-0101', date: '2026-10-01', total_cents: 17363, open_cents: 17363 },
    { id: 'f2', number: 'FAC-2026-0102', date: '2026-10-02', total_cents: 17363, open_cents: 10000 },
    { id: 'f3', number: 'FAC-2026-0103', date: '2026-10-03', total_cents: 17363, open_cents: 17363 },
  ],
  credit_notes: [
    { id: 'cn1', number: 'CRED-2026-0004', date: '2026-10-10', total_cents: 5000, open_cents: 5000, invoice_id: 'f9', invoice_number: 'FAC-2026-0099' },
  ],
  purchase_invoices: [
    { id: 'p1', number: 'INK-0001', date: '2026-10-01', total_cents: 12100, open_cents: 12100 },
    { id: 'p2', number: 'INK-0002', date: '2026-10-01', total_cents: 6050, open_cents: 6050 },
    { id: 'pc', number: 'CRED-77', date: '2026-10-01', total_cents: -2420, open_cents: -2420 },
  ],
};

const amounts = (lines: DraftAllocation[]) => lines.map(l => [l.kind, l.documentId || l.accountId, l.amount]);

test('een kenmerk telt als los woord, zoals in de database', () => {
  assert.equal(mentionsReference('Betaling FAC-2026-0101 en FAC-2026-0102', 'FAC-2026-0101'), true);
  assert.equal(mentionsReference('fac 2026 0101', 'FAC-2026-0101'), false, 'streepjes horen erbij');
  assert.equal(mentionsReference('BEA Shell 4211', '42'), false, 'te kort');
  assert.equal(mentionsReference('ref 202601011', '20260101'), false, 'midden in een langer getal');
  assert.equal(mentionsReference('ref 20260101/2', '20260101'), true);
  assert.equal(mentionsReference('', 'FAC-1'), false);
});

test('een omschrijving met twee facturen: een regel per factuur met het openstaande bedrag, de rest op een grootboekregel', () => {
  const lines = suggestAllocations(txn({ amount_cents: 17363 + 10000 + 5000, description: 'Betaling FAC-2026-0102 en FAC-2026-0101', suggested_account_id: 'acc8000', suggested_vat_code: 'HOOG' }), CANDIDATES);
  assert.deepEqual(amounts(lines), [
    ['sales_invoice', 'f2', '100,00'],
    ['sales_invoice', 'f1', '173,63'],
    ['ledger', 'acc8000', '50,00'],
  ]);
  assert.equal(lines[2].vatCode, 'HOOG');
  assert.equal(allocationState(lines, 32363).problem, null);
});

test('minder binnengekomen dan er openstaat: de laatste factuur krijgt wat er over is', () => {
  const lines = suggestAllocations(txn({ amount_cents: 20000, description: 'FAC-2026-0101 FAC-2026-0103' }), CANDIDATES);
  assert.deepEqual(amounts(lines), [['sales_invoice', 'f1', '173,63'], ['sales_invoice', 'f3', '26,37']]);
});

test('één factuur: het voorstel van de server, op één regel zonder bedrag (het hele bedrag)', () => {
  assert.deepEqual(amounts(suggestAllocations(txn({ amount_cents: 17363, matched_invoice_id: 'f1' }), CANDIDATES)), [['sales_invoice', 'f1', '']]);
  assert.deepEqual(amounts(suggestAllocations(txn({ amount_cents: -12100, matched_purchase_invoice_id: 'p1' }), CANDIDATES)), [['purchase_invoice', 'p1', '']]);
  assert.deepEqual(amounts(suggestAllocations(txn({ amount_cents: -5000, description: 'Terugbetaling CRED-2026-0004' }), CANDIDATES)), [['sales_credit_note', 'cn1', '']]);
  assert.deepEqual(amounts(suggestAllocations(txn({ amount_cents: -995, suggested_account_id: 'acc4500' }), null)), [['ledger', 'acc4500', '']]);
});

test('een betaling over twee inkoopfacturen wordt ook verdeeld', () => {
  const lines = suggestAllocations(txn({ amount_cents: -18150, description: 'INK-0001 INK-0002' }), CANDIDATES);
  assert.deepEqual(amounts(lines), [['purchase_invoice', 'p1', '121,00'], ['purchase_invoice', 'p2', '60,50']]);
});

test('één regel zonder bedrag is het hele bedrag; bij meer regels moet het precies kloppen', () => {
  const one = [emptyDraft('ledger', { accountId: 'a' })];
  assert.deepEqual(allocationState(one, 1000), { sumCents: 1000, remainderCents: 0, problem: null });
  const two = [emptyDraft('ledger', { accountId: 'a', amount: '6,00' }), emptyDraft('ledger', { accountId: 'b', amount: '' })];
  assert.match(allocationState(two, 1000).problem ?? '', /Regel 2: vul een bedrag in/);
  two[1].amount = '3,00';
  assert.deepEqual(allocationState(two, 1000), { sumCents: 900, remainderCents: 100, problem: 'Nog niet het hele bedrag verdeeld.' });
  two[1].amount = '5,00';
  assert.equal(allocationState(two, 1000).problem, 'Er is meer verdeeld dan het bedrag van de transactie.');
  two[1].amount = '4,00';
  assert.equal(allocationState(two, 1000).problem, null);
});

test('een negatieve regel mag: kosten die van een uitbetaling zijn afgehouden', () => {
  const lines = [emptyDraft('ledger', { accountId: 'omzet', amount: '121,00' }), emptyDraft('ledger', { accountId: 'kosten', amount: '-26,00' })];
  assert.equal(allocationState(lines, 9500).problem, null);
  assert.deepEqual(allocationPayload(lines, 9500).map(p => p.amount_cents), [12100, -2600]);
});

test('zonder rekening of stuk, met € 0,00, of twee keer hetzelfde stuk: niet boeken', () => {
  assert.match(allocationState([emptyDraft('ledger')], 100).problem ?? '', /kies een grootboekrekening/);
  assert.match(allocationState([emptyDraft('sales_credit_note')], 100).problem ?? '', /kies een creditnota/);
  assert.match(allocationState([emptyDraft('ledger', { accountId: 'a', amount: '0' }), emptyDraft('ledger', { accountId: 'b', amount: '1,00' })], 100).problem ?? '', /€ 0,00/);
  const dubbel = [emptyDraft('sales_invoice', { documentId: 'f1', amount: '0,50' }), emptyDraft('sales_invoice', { documentId: 'f1', amount: '0,50' })];
  assert.match(allocationState(dubbel, 100).problem ?? '', /al op een andere regel/);
  assert.throws(() => allocationPayload(dubbel, 100), /al op een andere regel/);
});

test('de verdeling voor de database: per soort het juiste id, klant of leverancier op een grootboekregel', () => {
  const payload = allocationPayload([
    emptyDraft('sales_invoice', { documentId: 'f1', amount: '173,63' }),
    emptyDraft('sales_credit_note', { documentId: 'cn1', amount: '-50,00', description: ' Verrekend ' }),
    emptyDraft('purchase_invoice', { documentId: 'p1', amount: '10,00' }),
    emptyDraft('ledger', { accountId: '1300', partyId: 'c:klant1', amount: '1,00' }),
    emptyDraft('ledger', { accountId: '1600', partyId: 's:lev1', amount: '1,00', vatCode: '' }),
  ], 17363 - 5000 + 1000 + 200);
  assert.deepEqual(payload, [
    { kind: 'sales_invoice', amount_cents: 17363, invoice_id: 'f1', description: null },
    { kind: 'sales_credit_note', amount_cents: -5000, credit_note_id: 'cn1', description: 'Verrekend' },
    { kind: 'purchase_invoice', amount_cents: 1000, purchase_invoice_id: 'p1', description: null },
    { kind: 'ledger', amount_cents: 100, account_id: '1300', vat_code: null, client_id: 'klant1', supplier_id: null, description: null },
    { kind: 'ledger', amount_cents: 100, account_id: '1600', vat_code: null, client_id: null, supplier_id: 'lev1', description: null },
  ]);
});

test('een regel toevoegen: een factuur met minder open houdt dat bedrag, de nieuwe regel krijgt de rest', () => {
  const start = [emptyDraft('sales_invoice', { documentId: 'f2' })];
  const two = addLine(start, 15000, () => 10000);
  assert.deepEqual(two.map(l => [l.kind, l.amount]), [['sales_invoice', '100,00'], ['ledger', '50,00']]);
  const fromLedger = addLine([emptyDraft('ledger', { accountId: 'a' })], 15000, () => null);
  assert.deepEqual(fromLedger.map(l => l.amount), ['150,00', '']);
  const three = addLine([...two.slice(0, 1), { ...two[1], amount: '20,00' }], 15000, () => null);
  assert.deepEqual(three.map(l => l.amount), ['100,00', '20,00', '30,00']);
  assert.deepEqual(removeLine(two, two[1].key).map(l => [l.kind, l.amount]), [['sales_invoice', '']], 'terug naar één regel: het hele bedrag');
  assert.deepEqual(putRemainder([{ ...two[0] }, { ...two[1], amount: '' }], two[1].key, 15000).map(l => l.amount), ['100,00', '50,00']);
});

test('bedragen als invoertekst', () => {
  assert.equal(centsToInput(17363), '173,63');
  assert.equal(centsToInput(-2420), '-24,20');
  assert.equal(centsToInput(5), '0,05');
});

test('welke handmatige mutatie bij een bankregel hoort: zelfde rekening en bedrag, nog niet bevestigd, dichtstbij eerst', () => {
  const bankRow = txn({ id: 'b', amount_cents: -5000, booking_date: '2026-11-05' });
  const all = [
    bankRow,
    txn({ id: 'm1', is_manual: true, amount_cents: -5000, booking_date: '2026-10-20' }),
    txn({ id: 'm2', is_manual: true, amount_cents: -5000, booking_date: '2026-11-04' }),
    txn({ id: 'm3', is_manual: true, amount_cents: -5000, booking_date: '2026-11-05', status: 'ignored' }),
    txn({ id: 'm4', is_manual: true, amount_cents: -4999, booking_date: '2026-11-05' }),
    txn({ id: 'm5', is_manual: true, amount_cents: -5000, booking_date: '2026-11-05', bank_account_id: 'b2' }),
    txn({ id: 'm6', is_manual: true, amount_cents: -5000, booking_date: '2026-11-05' }),
    txn({ id: 'r6', amount_cents: -5000, status: 'merged', merged_into_id: 'm6' }),
  ];
  const index = buildManualIndex(all);
  assert.deepEqual(manualMatchesFor(bankRow, index).map(t => t.id), ['m2', 'm1']);
  assert.deepEqual(manualMatchesFor(all[1], index), [], 'een handmatige mutatie zelf heeft geen kandidaten');
});

test('het bedrag van een stuk heeft het teken van de kant van het geld', () => {
  // Ontvangst: een factuur positief; een inkoopfactuur ertegen verrekend negatief; een creditnota van een leverancier positief.
  assert.equal(naturalAmount('sales_invoice', 17363, 30000), 17363);
  assert.equal(naturalAmount('purchase_invoice', 12100, 30000), -12100);
  assert.equal(naturalAmount('purchase_invoice', -2420, 30000), 2420);
  // Betaling: een inkoopfactuur positief, een creditnota van een leverancier negatief, een terugbetaling van een creditnota positief.
  assert.equal(naturalAmount('purchase_invoice', 12100, -15730), 12100);
  assert.equal(naturalAmount('purchase_invoice', -2420, -15730), -2420);
  assert.equal(naturalAmount('sales_credit_note', 5000, -5000), 5000);
  assert.equal(naturalAmount('sales_invoice', 17363, -1000), -17363);
});
