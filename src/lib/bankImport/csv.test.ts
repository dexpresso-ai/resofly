/**
 * De CSV-lezer met de exports van de banken uit de controle bank van 22
 * november 2026. Draaien met: npm test
 *
 * Waar het formaat van een bank niet zeker is (Revolut, Knab), is de lezer
 * ruim gemaakt: hij neemt de varianten aan, en weigert niet strenger dan eerst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv.ts';

test('Knab: de regel "KNAB EXPORT" boven de kop, de naam uit Tegenrekeninghouder, de boekdatum', () => {
  const csv = [
    'KNAB EXPORT;;;;;;;;;;;;;;;;',
    '"Rekeningnummer";"Transactiedatum";"Valutacode";"CreditDebet";"Bedrag";"Tegenrekeningnummer";"Tegenrekeninghouder";"Valutadatum";"Betaalwijze";"Omschrijving";"Type betaling";"Machtigingsnummer";"Incassant ID";"Adres";"Referentie";"Boekdatum"',
    '"NL12KNAB0123456789";"02-11-2026";"EUR";"C";"1210,00";"NL91ABNA0417164300";"Bakkerij Jansen";"02-11-2026";"Ontvangen betaling";"Factuur F2026-0012";"";"";"";"";"C2K02XXX";"02-11-2026"',
    '"NL12KNAB0123456789";"31-10-2026";"EUR";"D";"12,34";"";"Albert Heijn 1234";"31-10-2026";"Betaalpas";"Albert Heijn 1234 UTRECHT";"";"";"";"";"P2K03XXX";"02-11-2026"',
  ].join('\r\n');
  const s = parseCsv(csv, 'knab.csv');
  assert.equal(s.transactions.length, 2);
  const [ontvangst, pin] = s.transactions;
  assert.equal(ontvangst.counterparty_name, 'Bakkerij Jansen');
  assert.equal(ontvangst.counterparty_iban, 'NL91ABNA0417164300');
  assert.equal(ontvangst.amount_cents, 121000);
  // Geboekt op 2-11, betaald op 31-10: de boekdatum, net als CAMT en de koppeling.
  assert.equal(pin.booking_date, '2026-11-02');
  assert.equal(pin.amount_cents, -1234);
  assert.equal(pin.account, 'NL12KNAB0123456789');
});

test('Revolut Business: alleen voltooide regels, met kosten, kenmerk, Nederlandse datum en valuta', () => {
  const csv = [
    'Date started (UTC),Date completed (UTC),ID,Type,State,Description,Reference,Payer,Card number,Card label,Card state,Orig currency,Orig amount,Payment currency,Amount,Total amount,Exchange rate,Fee,Fee currency,Balance,Account,Beneficiary account number,Beneficiary sort code or routing number,Beneficiary IBAN,Beneficiary BIC,MCC,Related transaction id,Spend program',
    '2026-11-02,2026-11-02,a1,TRANSFER,COMPLETED,Payment from Bakkerij Jansen,F2026-0012,Bakkerij Jansen,,,,EUR,1210.00,EUR,1210.00,1210.00,,0.00,EUR,2210.00,Main EUR,,,,,,,',
    '2026-11-01 23:30:00,2026-11-01 23:31:10,a2,CARD_PAYMENT,COMPLETED,Albert Heijn 1234,,,4111********1111,,ACTIVE,EUR,-12.34,EUR,-12.34,-12.34,,0.00,EUR,2197.66,Main EUR,,,,,5411,,',
    '2026-11-03,2026-11-03,a3,CARD_PAYMENT,COMPLETED,AWS EMEA,,,4111********1111,,ACTIVE,USD,-100.00,EUR,-89.10,-90.88,0.8910,1.78,EUR,2106.78,Main EUR,,,,,5734,,',
    '2026-11-03,,a4,CARD_PAYMENT,PENDING,Hotel Amsterdam,,,4111********1111,,ACTIVE,EUR,-250.00,EUR,-250.00,-250.00,,0.00,EUR,,Main EUR,,,,,7011,,',
    '2026-11-04,2026-11-04,a5,CARD_PAYMENT,REVERTED,Bol.com,,,4111********1111,,ACTIVE,EUR,-59.95,EUR,-59.95,-59.95,,0.00,EUR,,Main EUR,,,,,5999,,',
  ].join('\n');
  const s = parseCsv(csv, 'revolut.csv');
  assert.equal(s.transactions.length, 3, 'de regel in behandeling en de teruggedraaide niet');
  const total = s.transactions.reduce((sum, t) => sum + t.amount_cents, 0);
  assert.equal(total, 210678 - 100000, 'samen precies het verschil in de kolom Balance');
  const [ontvangst, pin, aws] = s.transactions;
  assert.match(String(ontvangst.description), /F2026-0012/, 'het kenmerk staat in de omschrijving');
  assert.equal(ontvangst.counterparty_name, 'Bakkerij Jansen');
  assert.equal(pin.booking_date, '2026-11-02', '23:31 UTC is 00:31 in Nederland');
  assert.equal(pin.counterparty_name, 'Albert Heijn 1234');
  assert.equal(aws.amount_cents, -9088, 'met de kosten van € 1,78');
  assert.ok(s.transactions.every(t => t.currency === 'EUR'));
  assert.ok(s.transactions.every(t => !t.account), '"Main EUR" is geen rekeningnummer');
  assert.ok(s.warnings.some(w => /2 regel\(s\) overgeslagen/.test(w) && /PENDING/.test(w) && /REVERTED/.test(w)), s.warnings.join(' | '));
});

test('Revolut zonder "Total amount": de kosten gaan van het bedrag af', () => {
  const csv = [
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
    'CARD_PAYMENT,Current,2026-11-03 10:00:00,2026-11-03 10:01:00,AWS EMEA,-89.10,1.78,EUR,COMPLETED,2106.78',
    'TOPUP,Current,2026-11-04 10:00:00,,Top-up,100.00,0.00,EUR,PENDING,',
  ].join('\n');
  const s = parseCsv(csv, 'revolut-privé.csv');
  assert.deepEqual(s.transactions.map(t => [t.booking_date, t.amount_cents]), [['2026-11-03', -9088]]);
});

test('bunq: het IBAN van de tegenpartij staat in "Counterparty"', () => {
  for (const csv of [
    ['"Date","Interest Date","Amount","Account","Counterparty","Name","Description"',
      '"2026-11-02","2026-11-02","1210.00","NL12BUNQ2025123456","NL91ABNA0417164300","Bakkerij Jansen","Factuur F2026-0012"',
      '"2026-11-03","2026-11-03","-12.34","NL12BUNQ2025123456","","Albert Heijn 1234","Albert Heijn 1234 UTRECHT, NL"'],
    ['"Date";"Interest Date";"Amount";"Account";"Counterparty";"Name";"Description"',
      '"2026-11-02";"2026-11-02";"1.210,00";"NL12BUNQ2025123456";"NL91ABNA0417164300";"Bakkerij Jansen";"Factuur F2026-0012"',
      '"2026-11-03";"2026-11-03";"-12,34";"NL12BUNQ2025123456";"";"Albert Heijn 1234";"Albert Heijn 1234 UTRECHT, NL"'],
  ]) {
    const s = parseCsv(csv.join('\n'), 'bunq.csv');
    assert.equal(s.transactions[0].counterparty_iban, 'NL91ABNA0417164300');
    assert.equal(s.transactions[0].counterparty_name, 'Bakkerij Jansen');
    assert.equal(s.transactions[0].amount_cents, 121000);
    assert.equal(s.transactions[1].counterparty_iban, null);
    assert.equal(s.transactions[0].account, 'NL12BUNQ2025123456');
  }
});

test('de eigen rekening per regel: ING "Rekening" (ook een spaarrekening V…), Rabobank "IBAN/BBAN"', () => {
  const ing = parseCsv([
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"',
    '"20261102";"Bakkerij Jansen";"NL69INGB0123456789";"NL91ABNA0417164300";"OV";"Bij";"1210,00";"Overschrijving";"Factuur F2026-0012";"2210,00";""',
    '"20261102";"Zakelijke rekening";"V12345678";"NL69INGB0123456789";"OV";"Bij";"500,00";"Overschrijving";"Van Zakelijke rekening";"5500,00";""',
  ].join('\n'), 'ing.csv');
  assert.deepEqual(ing.transactions.map(t => t.account), ['NL69INGB0123456789', 'V12345678']);
  assert.equal(ing.transactions[0].counterparty_iban, 'NL91ABNA0417164300', 'de tegenrekening blijft de tegenrekening');

  const rabo = parseCsv([
    '"IBAN/BBAN","Munt","BIC","Volgnr","Datum","Rentedatum","Bedrag","Saldo na trn","Tegenrekening IBAN/BBAN","Naam tegenpartij","Naam uiteindelijke partij","Naam initiërende partij","BIC tegenpartij","Code","Batch ID","Transactiereferentie","Machtigingskenmerk","Incassant ID","Betalingskenmerk","Omschrijving-1","Omschrijving-2","Omschrijving-3","Reden retour","Oorspr bedrag","Oorspr munt","Koers"',
    '"NL11RABO0123456789","EUR","RABONL2U","000000000000007004","2026-11-04","2026-11-04","-89,10","+2.063,06","","AMAZON WEB SERVICES","","","","bc","","","","","","Betaalpas","","","","-100,00","USD","0,8910"',
    '"NL22RABO0987654321","EUR","RABONL2U","000000000000000101","2026-11-05","2026-11-05","+5.000,00","+15.000,00","NL11RABO0123456789","Fotografie Van Dijk","","","RABONL2U","tb","","","","","","Naar spaarrekening","","","","","",""',
  ].join('\n'), 'rabo.csv');
  assert.deepEqual(rabo.transactions.map(t => t.account), ['NL11RABO0123456789', 'NL22RABO0987654321']);
  assert.equal(rabo.transactions[1].counterparty_iban, 'NL11RABO0123456789');
  assert.equal(rabo.transactions[0].currency, 'EUR', '"Munt", niet "Oorspr munt"');
  assert.equal(rabo.transactions[0].amount_cents, -8910);
});
