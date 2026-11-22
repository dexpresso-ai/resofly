/**
 * Bankexports zonder kopregel (controle bank van 22 november 2026, bevinding 8).
 * Draaien met:  npm test
 *
 * De bestanden hieronder zijn gemaakt naar de formaatbeschrijvingen van de
 * banken; er waren geen echte exports. Daarom toetsen we vooral dat de lezer
 * weigert zodra een bestand afwijkt, in plaats van stil verkeerd te lezen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksHeaderless, parseHeaderlessBankFile } from './bankImport/headerless.ts';
import { parseCsv } from './bankImport/csv.ts';

const ASN = [
  "02-11-2026,NL12ASNB0123456789,NL91ABNA0417164300,Bakkerij Jansen,,,,EUR,1000.00,EUR,1210.00,02-11-2026,02-11-2026,8810,OVB,12345678,,'Factuur F2026-0012',1",
  "03-11-2026,NL12ASNB0123456789,NL08ABNA0430096617,KPN B.V.,,,,EUR,2210.00,EUR,-45.50,03-11-2026,03-11-2026,8810,INC,12345679,,'Factuur 123456789',1",
  "04-11-2026,NL12ASNB0123456789,NL86INGB0002445588,Belastingdienst,,,,EUR,2164.50,EUR,-500.00,04-11-2026,04-11-2026,8810,OVB,12345680,1234567890123456,'Btw Q3',1",
].join('\r\n');

const TRIODOS = [
  '02-11-2026,NL12TRIO0123456789,"1.210,00",Credit,Bakkerij Jansen,NL91ABNA0417164300,ID,Factuur F2026-0012',
  '03-11-2026,NL12TRIO0123456789,"45,50",Debet,KPN B.V.,NL08ABNA0430096617,IC,Factuur 123456789',
].join('\n');

const ABN = [
  '123456789\tEUR\t20261102\t1000,00\t2210,00\t20261102\t1210,00\t/TRTP/SEPA OVERBOEKING/IBAN/NL91ABNA0417164300/BIC/ABNANL2A/NAME/Bakkerij Jansen/REMI/Factuur F2026-0012/EREF/NOTPROVIDED',
  '123456789\tEUR\t20261103\t2210,00\t2197,66\t20261103\t-12,34\tBEA, Apple Pay                   Albert Heijn 1234,PAS123        NR:CT123456, 03.11.26/14:23     UTRECHT',
  '123456789\tEUR\t20261104\t2197,66\t2152,16\t20261104\t-45,50\tSEPA Incasso algemeen doorlopend Incassant: NL00ZZZ123456780000  Naam: KPN B.V.  Machtiging: 123  Omschrijving: Factuur 123456789  IBAN: NL08ABNA0430096617',
].join('\n');

test('ASN/SNS/RegioBank: bedragen, teken, tegenpartij, omschrijving en saldo', () => {
  const s = parseCsv(ASN, 'asn.csv');
  assert.deepEqual(s.transactions.map(t => t.amount_cents), [121000, -4550, -50000]);
  assert.deepEqual(s.transactions.map(t => t.booking_date), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual([s.transactions[0].counterparty_name, s.transactions[0].counterparty_iban, s.transactions[0].description],
    ['Bakkerij Jansen', 'NL91ABNA0417164300', 'Factuur F2026-0012']);
  assert.equal(s.transactions[2].structured_reference, '1234567890123456');
  // Het saldo loopt door, dus het afschrift krijgt een begin- en eindsaldo.
  assert.deepEqual([s.opening_balance_cents, s.closing_balance_cents], [100000, 166450]);
  assert.deepEqual(s.warnings, []);
  assert.equal(s.format, 'csv');
});

test('ASN nieuwste eerst: hetzelfde afschrift, hetzelfde saldo', () => {
  const s = parseCsv(ASN.split('\r\n').reverse().join('\n'), 'asn.csv');
  assert.deepEqual([s.opening_balance_cents, s.closing_balance_cents], [100000, 166450]);
});

test('ASN: klopt het saldo nergens, dan wordt het bestand geweigerd met uitleg', () => {
  // Het bedrag en het saldo omgewisseld: de vorm klopt, de som niet.
  const wrong = ASN.split('\r\n').map(line => {
    const c = line.split(',');
    [c[8], c[10]] = [c[10], c[8]];
    return c.join(',');
  }).join('\n');
  assert.throws(() => parseCsv(wrong, 'asn.csv'), /geen regel met kolomnamen \(het lijkt een export van ASN Bank\)[\s\S]*CAMT\.053 of MT940/);
});

test('ASN met een gat (een filter in de export): wel lezen, met een waarschuwing en zonder saldo', () => {
  const lines = ASN.split('\r\n');
  const more = [...lines, "06-11-2026,NL12ASNB0123456789,NL91ABNA0417164300,Bakkerij Jansen,,,,EUR,5000.00,EUR,100.00,06-11-2026,06-11-2026,8810,OVB,12345690,,'Later',1"];
  const s = parseCsv(more.join('\n'), 'asn.csv');
  assert.equal(s.transactions.length, 4);
  assert.equal(s.opening_balance_cents, null);
  assert.match(s.warnings.join(' '), /saldo in dit bestand loopt niet overal door/);
});

test('Triodos: Debet en Credit bepalen het teken', () => {
  const s = parseCsv(TRIODOS, 'triodos.csv');
  assert.deepEqual(s.transactions.map(t => [t.booking_date, t.amount_cents, t.counterparty_name, t.counterparty_iban, t.description]), [
    ['2026-11-02', 121000, 'Bakkerij Jansen', 'NL91ABNA0417164300', 'Factuur F2026-0012'],
    ['2026-11-03', -4550, 'KPN B.V.', 'NL08ABNA0430096617', 'Factuur 123456789'],
  ]);
  assert.equal(s.closing_balance_cents, null);
});

test('Triodos met een onbekende richting wordt geweigerd', () => {
  assert.throws(() => parseCsv(TRIODOS.replace('Debet', 'Storno'), 'triodos.csv'), /het lijkt een export van Triodos/);
});

test('ABN AMRO TXT: de som per regel bewijst de indeling, en de omschrijving wordt uitgepakt', () => {
  const s = parseCsv(ABN, 'abnamro.txt');
  assert.deepEqual(s.transactions.map(t => t.amount_cents), [121000, -1234, -4550]);
  assert.deepEqual([s.transactions[0].counterparty_name, s.transactions[0].counterparty_iban, s.transactions[0].description, s.transactions[0].end_to_end_id],
    ['Bakkerij Jansen', 'NL91ABNA0417164300', 'Factuur F2026-0012', null]);
  assert.match(s.transactions[1].description ?? '', /^BEA, Apple Pay Albert Heijn 1234/);
  assert.deepEqual([s.transactions[2].counterparty_name, s.transactions[2].counterparty_iban, s.transactions[2].description],
    ['KPN B.V.', 'NL08ABNA0430096617', 'Factuur 123456789']);
  assert.deepEqual([s.opening_balance_cents, s.closing_balance_cents], [100000, 215216]);
  assert.deepEqual([s.period_start, s.period_end], ['2026-11-02', '2026-11-04']);
});

test('ABN AMRO TXT waarin de som niet klopt, wordt geweigerd', () => {
  assert.throws(() => parseCsv(ABN.replace('\t1210,00\t', '\t1200,00\t'), 'abnamro.txt'), /geen regel met kolomnamen \(het lijkt een export van ABN AMRO\)/);
});

test('twee rekeningen in één bestand: weigeren, met de rekeningen erbij', () => {
  const two = `${ABN}\n987654321\tEUR\t20261104\t50,00\t60,00\t20261104\t10,00\tRente`;
  assert.throws(() => parseCsv(two, 'abnamro.txt'), /mutaties van 2 rekeningen \(123456789, 987654321\)/);
});

test('een onbekend bestand zonder kopregel: een melding met de weg, geen gok', () => {
  const unknown = '02-11-2026;Bakkerij Jansen;1210,00;Factuur F2026-0012\n03-11-2026;KPN;-45,50;Factuur 1';
  assert.throws(() => parseCsv(unknown, 'onbekend.csv'), /geen regel met kolomnamen, en ResoFly herkent de indeling niet zeker genoeg[\s\S]*CAMT\.053 of MT940/);
});

test('een bestand met een kopregel gaat naar de gewone lezer', () => {
  assert.equal(looksHeaderless('"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"'), false);
  assert.equal(looksHeaderless('KNAB EXPORT;;;;;;;;;;;;;;;;'), false);
  assert.equal(parseHeaderlessBankFile('Datum;Bedrag;Omschrijving\n02-11-2026;10,00;x', 'x.csv'), null);
  const ing = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"\n"20261102";"Bakkerij Jansen";"NL69INGB0123456789";"NL91ABNA0417164300";"OV";"Bij";"1210,00";"Overschrijving";"Factuur F2026-0012"';
  assert.deepEqual(parseCsv(ing, 'ing.csv').transactions.map(t => t.amount_cents), [121000]);
});

test('ASN van twee regels waarin het saldo niet doorloopt, wordt geweigerd', () => {
  const two = ASN.split('\r\n').slice(0, 2).map(line => {
    const c = line.split(',');
    [c[8], c[10]] = [c[10], c[8]];
    return c.join(',');
  }).join('\n');
  assert.throws(() => parseCsv(two, 'asn.csv'), /het lijkt een export van ASN Bank/);
});

test('ABN AMRO TXT met veel komma\'s in de eerste omschrijving wordt toch herkend', () => {
  const first = '123456789\tEUR\t20261103\t2210,00\t2197,66\t20261103\t-12,34\tBEA, Apple Pay, Albert Heijn, 1234, PAS123, NR:CT123456, 03.11.26, 14:23, UTRECHT';
  assert.equal(looksHeaderless(first), true);
  assert.deepEqual(parseCsv(first, 'abnamro.txt').transactions.map(t => t.amount_cents), [-1234]);
});

test('een BOM voor de eerste regel stoort niet', () => {
  assert.deepEqual(parseCsv(`\uFEFF${TRIODOS}`, 'triodos.csv').transactions.map(t => t.amount_cents), [121000, -4550]);
});
