import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDutchAmount, parseDutchAmountCents } from './money.ts';
import { normalizeDate } from './bankImport/dedup.ts';
import { parseMt940 } from './bankImport/mt940.ts';
import { parseCsv } from './bankImport/csv.ts';
import { buildXaf } from './xaf.ts';
import { formatDocUnitPrice } from './documentLayout.ts';
import { amsterdamTodayIso } from './dates.ts';
import { invoiceContentLocked, paymentBlocksCredit, paymentsBlockCredit, quoteDecision } from './financeRules.ts';

/**
 * Tweede controle op Financiën (5 november 2026): de rekenregels die in de app
 * zelf zitten. Elk geval hieronder ging eerder fout; de opmerking zegt hoe.
 */

test('bedragen zoals je ze in een Nederlands scherm typt', () => {
  // Eerder: "1.500" werd € 1,50 en "8.000.000,00" niets.
  assert.equal(parseDutchAmount('1.500'), 1500);
  assert.equal(parseDutchAmount('8.000.000,00'), 8000000);
  assert.equal(parseDutchAmount('450.000'), 450000);
  assert.equal(parseDutchAmount('1.500,25'), 1500.25);
  assert.equal(parseDutchAmount('1500,25'), 1500.25);
  assert.equal(parseDutchAmount('12.5'), 12.5);
  assert.equal(parseDutchAmount('12.50'), 12.5);
  assert.equal(parseDutchAmount('0.125'), 0.125, 'een getal dat met 0. begint is nooit een duizendtal');
  assert.equal(parseDutchAmount('€ 1.234,56'), 1234.56);
  assert.equal(parseDutchAmount('-12,50'), -12.5);
  assert.equal(parseDutchAmount('12,50-'), -12.5);
  assert.equal(parseDutchAmount(''), null);
  assert.equal(parseDutchAmount('12,5,0'), null);
  assert.equal(parseDutchAmount('abc'), null);
  // Een bankregel van "12,50" werd € 12,00.
  assert.equal(parseDutchAmountCents('12,50'), 1250);
  assert.equal(parseDutchAmountCents('1.000'), 100000);
});

test('datums uit een bankbestand: dag-maand-jaar, zonder UTC-verschuiving', () => {
  // Eerder via new Date(): maand-dag, en een dag terug door UTC.
  assert.equal(normalizeDate('5-1-2026'), '2026-01-05');
  assert.equal(normalizeDate('1-12-2025'), '2025-12-01');
  assert.equal(normalizeDate('13-1-2026'), '2026-01-13', 'viel eerder weg');
  assert.equal(normalizeDate('05-01-26'), '2026-01-05');
  assert.equal(normalizeDate('05.01.2026'), '2026-01-05');
  assert.equal(normalizeDate('2026-01-05'), '2026-01-05');
  assert.equal(normalizeDate('2026-01-05T23:30:00+01:00'), '2026-01-05');
  assert.equal(normalizeDate('20260105'), '2026-01-05');
  assert.equal(normalizeDate('31-2-2026'), null, '31 februari bestaat niet');
  assert.equal(normalizeDate(''), null);
});

test('MT940: een :86: na het eindsaldo hoort niet bij de laatste transactie', () => {
  const file = [
    ':20:STARTUMS',
    ':25:NL91ABNA0417164300',
    ':28C:1',
    ':60F:C260105EUR1000,00',
    ':61:2601050105D12,50NTRFNONREF',
    ':86:/NAME/Leverancier/IBAN/NL12INGB0001234567/REMI/USTD//Factuur 2026-0008',
    ':62F:C260105EUR987,50',
    ':86:/SUM/1/1/12,50/0,00/',
    '-',
  ].join('\n');
  const statement = parseMt940(file, 'test.940');
  assert.equal(statement.transactions.length, 1);
  assert.match(String(statement.transactions[0].description), /Factuur 2026-0008/);
  assert.equal(statement.closing_balance_cents, 98750);
});

test('CSV: een kolom telt pas als af/bij-kolom als de waarden zo luiden', () => {
  // Knab-achtig: "Type betaling" stond eerder op de plek van "CreditDebet".
  const csv = [
    'Datum;CreditDebet;Bedrag;Omschrijving;Type betaling',
    '05-01-2026;D;12,50;Shell;Pinbetaling',
    '06-01-2026;C;100,00;Klant;Overboeking',
  ].join('\n');
  const statement = parseCsv(csv, 'knab.csv');
  const amounts = statement.transactions.map(t => t.amount_cents);
  assert.deepEqual(amounts, [-1250, 10000]);
});

test('XAF: een verlengd boekjaar krijgt alle perioden, de eerste vanaf de startdatum', () => {
  const data = {
    companySettings: null, journalLines: [], ledgerAccounts: [], journalEntries: [],
    clients: [], suppliers: [], vatCodes: [],
  } as unknown as Parameters<typeof buildXaf>[0]['data'];
  const xml = buildXaf({ data, fiscalYearLabel: '2025/2026', startDate: '2025-07-15', endDate: '2026-12-31' });
  const numbers = [...xml.matchAll(/<periodNumber>(\d+)<\/periodNumber>/g)].map(m => Number(m[1]));
  assert.equal(numbers.length, 18, 'juli 2025 t/m december 2026');
  assert.equal(numbers[17], 18);
  assert.match(xml, /<startDatePeriod>2025-07-15<\/startDatePeriod>/);
  assert.match(xml, /<endDatePeriod>2026-12-31<\/endDatePeriod>/);
});

test('XAF: btw-nummer vóór custSupTp, en een id binnen 35 tekens', () => {
  const data = {
    companySettings: null, journalLines: [], ledgerAccounts: [], journalEntries: [], vatCodes: [],
    clients: [{ id: '0f8a2b3c-1d2e-4f5a-8b9c-0d1e2f3a4b5c', client_code: null, name: 'Klant BV', vat_number: 'NL001234567B01' }],
    suppliers: [],
  } as unknown as Parameters<typeof buildXaf>[0]['data'];
  const xml = buildXaf({ data, fiscalYearLabel: '2026', startDate: '2026-01-01', endDate: '2026-12-31' });
  const block = /<customerSupplier>(.*?)<\/customerSupplier>/s.exec(xml)?.[1] ?? '';
  assert.ok(block.indexOf('<taxRegIdent>') > -1 && block.indexOf('<taxRegIdent>') < block.indexOf('<custSupTp>'));
  const id = /<custSupID>([^<]+)<\/custSupID>/.exec(block)?.[1] ?? '';
  assert.ok(id.length <= 35, `custSupID is ${id.length} tekens`);
});

test('eenheidsprijs: geen afronding op centen die het regelbedrag tegenspreekt', () => {
  assert.equal(formatDocUnitPrice(0.125), '€ 0,125');
  assert.equal(formatDocUnitPrice(1234.5678), '€ 1.234,5678');
  assert.equal(formatDocUnitPrice(12.5), '€ 12,50');
  assert.equal(formatDocUnitPrice(85.5), '€ 85,50');
});

test('vandaag in Nederland, ook net na middernacht als het in UTC nog gisteren is', () => {
  // Wintertijd (UTC+1) en zomertijd (UTC+2): de UTC-datum loopt dan een dag achter.
  assert.equal(amsterdamTodayIso(new Date('2026-11-05T23:30:00Z')), '2026-11-06');
  assert.equal(amsterdamTodayIso(new Date('2026-11-05T22:59:00Z')), '2026-11-05');
  assert.equal(amsterdamTodayIso(new Date('2026-07-01T22:30:00Z')), '2026-07-02');
  assert.equal(amsterdamTodayIso(new Date('2026-12-31T23:00:00Z')), '2027-01-01');
});

test('offerte: akkoord geven kan alleen als hij verstuurd en nog geldig is', () => {
  // Eerder toonden de publieke pagina en het portaal ook bij een ingetrokken of
  // verlopen offerte het akkoordformulier; de server weigerde daarna.
  const today = '2026-11-06';
  assert.equal(quoteDecision({ status: 'sent', valid_until: '2026-11-06' }, today), 'open', 'geldig tot en met vandaag');
  assert.equal(quoteDecision({ status: 'sent', valid_until: null }, today), 'open', 'zonder einddatum blijft hij geldig');
  assert.equal(quoteDecision({ status: 'sent', valid_until: '2026-11-05' }, today), 'expired', 'de status springt niet vanzelf op verlopen');
  assert.equal(quoteDecision({ status: 'expired', valid_until: '2026-12-31' }, today), 'expired');
  assert.equal(quoteDecision({ status: 'cancelled', valid_until: '2026-12-31' }, today), 'withdrawn');
  assert.equal(quoteDecision({ status: 'accepted', valid_until: '2026-01-01' }, today), 'accepted', 'een beslissing blijft staan na de datum');
  assert.equal(quoteDecision({ status: 'rejected', valid_until: '2026-01-01' }, today), 'rejected');
  assert.equal(quoteDecision({ status: 'draft', valid_until: null }, today), 'unavailable');
});

test('crediteren: alleen een lopende of afgeronde betaling houdt het tegen', () => {
  // Eerder hield elke 'creating' of 'open' het tegen, ook een allang verlopen
  // checkout. Een herinnering zonder Mollie liet zo een 'creating' achter, en
  // dan was de factuur nooit meer te crediteren.
  const now = Date.parse('2026-11-06T12:00:00Z');
  const past = '2026-11-06T11:00:00Z';
  const future = '2026-11-06T12:30:00Z';
  assert.equal(paymentBlocksCredit({ status: 'creating', checkout_expires_at: past }, now), false);
  assert.equal(paymentBlocksCredit({ status: 'open', checkout_expires_at: past }, now), false);
  assert.equal(paymentBlocksCredit({ status: 'open', checkout_expires_at: future }, now), true);
  assert.equal(paymentBlocksCredit({ status: 'creating', checkout_expires_at: null }, now), true, 'zonder vervaltijd kan hij nog lopen');
  for (const status of ['pending', 'authorized', 'paid']) {
    assert.equal(paymentBlocksCredit({ status, checkout_expires_at: past }, now), true, status);
  }
  for (const status of ['failed', 'expired', 'canceled']) {
    assert.equal(paymentBlocksCredit({ status, checkout_expires_at: null }, now), false, status);
  }
  // Een oudere link die nog loopt, telt ook als er een nieuwere (verlopen) bovenop ligt.
  assert.equal(paymentsBlockCredit([
    { status: 'expired', checkout_expires_at: past },
    { status: 'open', checkout_expires_at: future },
  ], now), true);
  assert.equal(paymentsBlockCredit([
    { status: 'creating', checkout_expires_at: past },
    { status: 'failed', checkout_expires_at: null },
  ], now), false);
});

test('bewerken: een concept met alleen een ongebruikte betaallink blijft bewerkbaar (zoals de database)', () => {
  // Versturen mét betaallink maakt de link vóór de mail. Mislukte de mail, dan
  // zat het concept eerder voorgoed op slot (locked_reason payment_checkout_created).
  const concept = { status: 'draft', locked_at: '2026-11-06T10:00:00Z', locked_reason: 'payment_checkout_created' };
  assert.equal(invoiceContentLocked(concept, [{ status: 'open' }]), false);
  assert.equal(invoiceContentLocked(concept, [{ status: 'creating' }, { status: 'expired' }]), false);
  assert.equal(invoiceContentLocked({ status: 'draft', locked_at: null }, []), false);
  // Een betaling die loopt of rond is, vergrendelt wél, ook bij een concept.
  for (const status of ['pending', 'authorized', 'paid', 'refunded', 'charged_back']) {
    assert.equal(invoiceContentLocked(concept, [{ status }]), true, status);
  }
  // Een concept dat om een andere reden op slot zit, blijft op slot.
  assert.equal(invoiceContentLocked({ status: 'draft', locked_at: '2026-11-06T10:00:00Z', locked_reason: 'sent' }, []), true);
  // Verstuurd of afgesloten: altijd op slot.
  for (const status of ['sent', 'overdue', 'paid', 'cancelled', 'void', 'written_off', 'refunded']) {
    assert.equal(invoiceContentLocked({ status, locked_at: null }, []), true, status);
  }
});

