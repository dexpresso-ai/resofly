/**
 * De MT940-lezer met de afschriften uit de controle bank van 22 november 2026.
 * Draaien met: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMt940 } from './mt940.ts';

// Zoals ING het levert: :86: afgebroken op 65 tekens, midden in een woord.
const ING_NOV = [
  '0000 01INGBNL2AXXXX00001',
  '0000 01INGBNL2AXXXX00001',
  '940 00',
  ':20:P261130000000001',
  ':25:NL69INGB0123456789EUR',
  ':28C:00000',
  ':60F:C261031EUR1000,00',
  ':61:2611021102C2420,00NTRFNONREF//00000000001001',
  '/TRCD/00100/',
  ':86:/EREF/NOTPROVIDED//CNTP/NL91ABNA0417164300/ABNANL2A/Jan de V',
  'ries/UTRECHT//REMI/USTD//Factuur F2026-0012 en F2026-0013 nov/',
  ':61:2611031103D45,50NDDTEREF//00000000001002',
  '/TRCD/01016/',
  ':86:/EREF/0012345678//MARF/KPN-0042//CSID/NL93ZZZ270880000000//CN',
  'TP/NL08ABNA0430096617/ABNANL2A/KPN B.V./AMSTERDAM//REMI/USTD//Fac',
  'tuur 123456789/',
  ':61:2611051105RD45,50NDDTEREF//00000000001003',
  '/TRCD/01016/',
  ':86:/RTRN/MD06/EREF/0012345678//MARF/KPN-0042//CNTP/NL08ABNA04300',
  '96617/ABNANL2A/KPN B.V./AMSTERDAM//REMI/USTD//Factuur 123456789/',
  ':62F:C261130EUR3420,00',
  ':64:C261130EUR3420,00',
  ':86:/SUM/1/2/45,50/2465,50/',
  '-',
].join('\r\n');

test('MT940: de periode begint de dag ná :60F: (dat is het vorige eindsaldo)', () => {
  const s = parseMt940(ING_NOV, 'ing-nov.940');
  // Eerder 31-10: dan telde de mutatie van het oktober-afschrift mee en gaf
  // de afschriftcontrole € 100 vals alarm.
  assert.equal(s.period_start, '2026-11-01');
  assert.equal(s.period_end, '2026-11-30');
  const sum = s.transactions.reduce((total, t) => total + t.amount_cents, 0);
  assert.equal((s.opening_balance_cents ?? 0) + sum, s.closing_balance_cents, 'het afschrift klopt met zichzelf');
});

test('MT940: zet :60F: de eerste dag zelf, dan begint de periode bij de eerste mutatie', () => {
  const s = parseMt940([
    ':20:X', ':25:NL69INGB0123456789', ':28C:1', ':60F:C261102EUR1000,00',
    ':61:2611021102C10,00NTRFNONREF', ':86:/NAME/Klant/REMI/Factuur 1', ':62F:C261102EUR1010,00', '-',
  ].join('\n'), 'x.940');
  assert.equal(s.period_start, '2026-11-02');
});

test('ING-MT940: een afgebroken :86: kost geen tegenpartij, naam of factuurnummer', () => {
  const [ontvangst, incasso, storno] = parseMt940(ING_NOV, 'ing-nov.940').transactions;
  assert.equal(ontvangst.counterparty_name, 'Jan de Vries');
  assert.equal(ontvangst.description, 'Factuur F2026-0012 en F2026-0013 nov');
  assert.equal(ontvangst.end_to_end_id, 'NOTPROVIDED', 'zonder slot-"/"');
  assert.equal(incasso.counterparty_name, 'KPN B.V.');
  assert.equal(incasso.counterparty_iban, 'NL08ABNA0430096617');
  assert.equal(incasso.description, 'Factuur 123456789');
  assert.equal(incasso.end_to_end_id, '0012345678');
  assert.equal(storno.amount_cents, 4550, 'RD is een bijschrijving');
  assert.equal(storno.counterparty_iban, 'NL08ABNA0430096617');
});

test('MT940 vrije tekst (ABN AMRO-pin) houdt de spaties', () => {
  const s = parseMt940([
    'ABNANL2A', '940', 'ABNANL2A', ':20:ABN AMRO BANK NV', ':25:123456789', ':28:30401/1', ':60F:C261101EUR1000,00',
    ':61:261102C1210,00N654NONREF',
    ':86:/TRTP/SEPA OVERBOEKING/IBAN/NL91ABNA0417164300/BIC/ABNANL2A/NAME/',
    'Bakkerij Jansen/REMI/Factuur F2026-0012/EREF/NOTPROVIDED',
    ':61:261103D12,34N426NONREF',
    ':86:BEA, Apple Pay                   Albert Heijn 1234,PAS123',
    'NR:CT123456, 03.11.26/14:23     UTRECHT',
    ':62F:C261103EUR2197,66', '-',
  ].join('\n'), 'abnamro.sta');
  const [ontvangst, pin] = s.transactions;
  assert.equal(ontvangst.counterparty_name, 'Bakkerij Jansen');
  assert.equal(ontvangst.counterparty_iban, 'NL91ABNA0417164300');
  assert.equal(ontvangst.description, 'Factuur F2026-0012');
  assert.match(String(pin.description), /PAS123 NR:CT123456/);
  assert.equal(pin.account, '123456789', 'het oude rekeningnummer uit :25:');
});

test('Rabobank-MT940: het IBAN van de tegenpartij op de tweede regel van :61:', () => {
  const s = parseMt940([
    ':940:', ':20:940S261102', ':25:NL11RABO0123456789 EUR', ':28C:00000', ':60F:C261101EUR000000001000,00',
    ':61:261102C000000001210,00N541EREF',
    'NL91ABNA0417164300',
    ':86:/EREF/NOTPROVIDED/ORDP//NAME/Bakkerij Jansen/ADDR/Hoofdstraat 1 Utrecht NL/REMI/Factuur F2026-0012/ISDT/2026-11-02',
    ':62F:C261102EUR000000002210,00',
  ].join('\n'), 'rabo.swi');
  const [t] = s.transactions;
  assert.equal(t.counterparty_iban, 'NL91ABNA0417164300');
  assert.equal(t.counterparty_name, 'Bakkerij Jansen');
  assert.equal(t.description, 'Factuur F2026-0012');
});

test('MT940 met twee rekeningen: elke regel weet van welke rekening hij is, met het saldo per rekening', () => {
  const s = parseMt940([
    ':20:A', ':25:NL69INGB0123456789EUR', ':28C:1', ':60F:C261101EUR1000,00',
    ':61:2611021102C10,00NTRFNONREF', ':86:/NAME/Klant/REMI/Factuur 1', ':62F:C261102EUR1010,00', '-',
    ':20:B', ':25:NL69INGB0987654321EUR', ':28C:1', ':60F:C261101EUR5000,00',
    ':61:2611021102C500,00NTRFNONREF', ':86:/NAME/Zelf/REMI/Sparen', ':62F:C261102EUR5500,00', '-',
  ].join('\n'), 'twee.940');
  assert.deepEqual(s.transactions.map(t => t.account), ['NL69INGB0123456789EUR', 'NL69INGB0987654321EUR']);
  assert.deepEqual(s.accounts?.map(a => [a.account, a.opening_balance_cents, a.closing_balance_cents]), [
    ['NL69INGB0123456789EUR', 100000, 101000],
    ['NL69INGB0987654321EUR', 500000, 550000],
  ]);
  // Het afschrift als geheel is dat van de eerste rekening, niet het
  // beginsaldo van de ene en het eindsaldo van de andere.
  assert.equal(s.opening_balance_cents, 100000);
  assert.equal(s.closing_balance_cents, 101000);
});
