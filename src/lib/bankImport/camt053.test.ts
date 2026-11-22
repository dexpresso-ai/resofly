/**
 * De CAMT.053-lezer met de afschriften uit de controle bank van 22 november
 * 2026. Draaien met: npm test. Node heeft geen DOMParser; testDom.ts is een
 * kleine vervanger met alleen wat de lezer gebruikt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTestDomParser } from './testDom.ts';
import { parseCamt053 } from './camt053.ts';

installTestDomParser();

const doc = (version: string, stmts: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.${version}">
  <BkToCstmrStmt><GrpHdr><MsgId>M</MsgId></GrpHdr>${stmts}</BkToCstmrStmt>
</Document>`;

const bal = (code: string, amount: string) =>
  `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-03</Dt></Dt></Bal>`;

const stmt = (iban: string, day: string, balances: string, entries: string) => `
  <Stmt><Id>S-${iban}-${day}</Id>
    <FrToDt><FrDtTm>${day}T00:00:00</FrDtTm><ToDtTm>${day}T23:59:59</ToDtTm></FrToDt>
    <Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>
    ${balances}${entries}
  </Stmt>`;

const entry = (amount: string, ind: 'CRDT' | 'DBIT', parties: string, text: string, extra = '') => `
  <Ntry><NtryRef>R</NtryRef><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${ind}</CdtDbtInd>${extra}<Sts>BOOK</Sts>
    <BookgDt><Dt>2026-11-03</Dt></BookgDt><ValDt><Dt>2026-11-03</Dt></ValDt>
    <NtryDtls><TxDtls><RltdPties>${parties}</RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls></NtryDtls>
  </Ntry>`;

test('CAMT: bij een storno is de tegenpartij de incassant, niet de zzp\'er zelf', () => {
  const s = parseCamt053(doc('02', stmt('NL69INGB0123456789', '2026-11-03', bal('OPBD', '100.00') + bal('CLBD', '145.50'), entry('45.50', 'CRDT',
    '<Dbtr><Nm>Fotografie Van Dijk</Nm></Dbtr><DbtrAcct><Id><IBAN>NL69INGB0123456789</IBAN></Id></DbtrAcct>'
    + '<Cdtr><Nm>KPN B.V.</Nm></Cdtr><CdtrAcct><Id><IBAN>NL08ABNA0430096617</IBAN></Id></CdtrAcct>',
    'Factuur 123456789', '<RvslInd>true</RvslInd>'))), 'camt-dag2.xml');
  const [t] = s.transactions;
  assert.equal(t.amount_cents, 4550);
  assert.equal(t.counterparty_name, 'KPN B.V.');
  assert.equal(t.counterparty_iban, 'NL08ABNA0430096617');
});

test('CAMT: ook zonder storno-teken nooit de eigen rekening als tegenpartij', () => {
  const s = parseCamt053(doc('02', stmt('NL69INGB0123456789', '2026-11-03', '', entry('45.50', 'CRDT',
    '<Dbtr><Nm>Fotografie Van Dijk</Nm></Dbtr><DbtrAcct><Id><IBAN>NL69 INGB 0123 4567 89</IBAN></Id></DbtrAcct>'
    + '<Cdtr><Nm>KPN B.V.</Nm></Cdtr><CdtrAcct><Id><IBAN>NL08ABNA0430096617</IBAN></Id></CdtrAcct>',
    'Terugboeking'))), 'x.xml');
  assert.equal(s.transactions[0].counterparty_name, 'KPN B.V.');
});

test('CAMT: een gewone bijschrijving houdt de debiteur als tegenpartij', () => {
  const s = parseCamt053(doc('02', stmt('NL69INGB0123456789', '2026-11-03', '', entry('1210.00', 'CRDT',
    '<Dbtr><Nm>Bakkerij Jansen</Nm></Dbtr><DbtrAcct><Id><IBAN>NL91ABNA0417164300</IBAN></Id></DbtrAcct>', 'Factuur F2026-0012'))), 'x.xml');
  assert.equal(s.transactions[0].counterparty_name, 'Bakkerij Jansen');
  assert.equal(s.transactions[0].account, 'NL69INGB0123456789');
});

test('CAMT: beginsaldo PRCD als er geen OPBD is', () => {
  const s = parseCamt053(doc('08', stmt('NL69INGB0123456789', '2026-11-02', bal('PRCD', '1000.00') + bal('CLBD', '2210.00'), entry('1210.00', 'CRDT',
    '<Dbtr><Nm>Bakkerij Jansen</Nm></Dbtr>', 'Factuur F2026-0012'))), 'camt-v8-prcd.xml');
  assert.equal(s.opening_balance_cents, 100000);
  assert.equal(s.closing_balance_cents, 221000);
});

test('CAMT met twee rekeningen: de rekening per regel en het saldo per rekening', () => {
  const s = parseCamt053(doc('02',
    stmt('NL69INGB0123456789', '2026-11-03', bal('OPBD', '100.00') + bal('CLBD', '110.00'),
      entry('10.00', 'CRDT', '<Dbtr><Nm>Klant</Nm></Dbtr>', 'Factuur 1'))
    + stmt('NL69INGB0987654321', '2026-11-03', bal('OPBD', '0.00') + bal('CLBD', '5000.00'),
      entry('5000.00', 'CRDT', '<Dbtr><Nm>Zelf</Nm></Dbtr><DbtrAcct><Id><IBAN>NL69INGB0123456789</IBAN></Id></DbtrAcct>', 'Naar spaarrekening'))),
  'camt-twee-rekeningen.xml');
  assert.deepEqual(s.transactions.map(t => t.account), ['NL69INGB0123456789', 'NL69INGB0987654321']);
  assert.deepEqual(s.accounts?.map(a => [a.account, a.opening_balance_cents, a.closing_balance_cents]), [
    ['NL69INGB0123456789', 10000, 11000],
    ['NL69INGB0987654321', 0, 500000],
  ]);
  // Niet meer de oude waarschuwing "alle transacties komen op deze ene
  // rekening": dat beslist het scherm vóór het inlezen (check.ts).
  assert.ok(!s.warnings.some(w => /meerdere rekeningen/.test(w)));
});
