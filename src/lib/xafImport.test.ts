import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppData } from '../types';
import { buildXaf } from './xaf.ts';
import {
  balancesAt, decimalToCents, decodeXafBytes, openingLines, parseXaf, planRelations, proposeAccount, type TargetAccount,
} from './xafImport.ts';

/**
 * Een auditfile inlezen voor wie overstapt. Twee bronnen: een rondje via de
 * eigen buildXaf (src/lib/xaf.ts), en een bestand zoals een ander pakket het
 * schrijft: met een namespace-voorvoegsel, windows-1252, adressen en een
 * relatie die klant én leverancier is.
 */

// Het standaardschema van ResoFly (ensure_default_ledger_accounts), voor de voorstellen.
const resofly: TargetAccount[] = [
  { id: 'a0100', code: '0100', name: 'Vaste activa', type: 'asset', subtype: 'fixed_asset' },
  { id: 'a0150', code: '0150', name: 'Cumulatieve afschrijving', type: 'asset', subtype: 'accumulated_depreciation' },
  { id: 'a0500', code: '0500', name: 'Eigen vermogen', type: 'equity', subtype: 'equity' },
  { id: 'a0510', code: '0510', name: 'Onverdeeld resultaat', type: 'equity', subtype: 'retained_earnings' },
  { id: 'a1100', code: '1100', name: 'Bank', type: 'asset', subtype: 'bank' },
  { id: 'a1300', code: '1300', name: 'Debiteuren', type: 'asset', subtype: 'accounts_receivable' },
  { id: 'a1500', code: '1500', name: 'Te vorderen BTW (voorbelasting)', type: 'asset', subtype: 'vat_input' },
  { id: 'a1510', code: '1510', name: 'Af te dragen BTW (verkoop)', type: 'liability', subtype: 'vat_output' },
  { id: 'a1530', code: '1530', name: 'Te betalen omzetbelasting', type: 'liability', subtype: 'vat_payable' },
  { id: 'a1600', code: '1600', name: 'Crediteuren', type: 'liability', subtype: 'accounts_payable' },
  { id: 'a8000', code: '8000', name: 'Omzet hoog (21%)', type: 'revenue', subtype: 'sales' },
];

function resoflyXaf(): string {
  const accounts = [
    { id: 'L1', code: '0500', name: 'Eigen vermogen', type: 'equity' },
    { id: 'L2', code: '1100', name: 'Bank', type: 'asset' },
    { id: 'L3', code: '1300', name: 'Debiteuren', type: 'asset' },
    { id: 'L4', code: '1510', name: 'Af te dragen BTW (verkoop)', type: 'liability' },
    { id: 'L5', code: '8000', name: 'Omzet hoog (21%)', type: 'revenue' },
  ];
  const entries = [
    { id: 'E0', entry_number: 'OPN-1', date: '2024-12-31', description: 'Beginbalans', source_type: 'opening_balance', status: 'posted' },
    { id: 'E1', entry_number: 'VRK-1', date: '2025-03-01', description: 'Factuur 1', source_type: 'sales_invoice', status: 'posted' },
    { id: 'E2', entry_number: 'BNK-1', date: '2025-03-20', description: 'Betaling', source_type: 'payment', status: 'posted' },
    { id: 'E3', entry_number: 'VRK-2', date: '2025-12-15', description: 'Factuur 2', source_type: 'sales_invoice', status: 'posted' },
    { id: 'E4', entry_number: 'VRK-3', date: '2025-12-20', description: 'Concept', source_type: 'sales_invoice', status: 'draft' },
  ];
  const line = (id: string, entry: string, account: string, debit: number, credit: number, extra: Record<string, unknown> = {}) =>
    ({ id, entry_id: entry, account_id: account, line_index: Number(id.slice(1)), debit_cents: debit, credit_cents: credit, ...extra });
  const lines = [
    line('J1', 'E0', 'L2', 100000, 0), line('J2', 'E0', 'L1', 0, 100000),
    line('J3', 'E1', 'L3', 12100, 0, { client_id: 'C1' }), line('J4', 'E1', 'L5', 0, 10000, { vat_code: 'HOOG', vat_rate: 21, vat_amount_cents: 2100 }), line('J5', 'E1', 'L4', 0, 2100),
    line('J6', 'E2', 'L2', 12100, 0), line('J7', 'E2', 'L3', 0, 12100, { client_id: 'C1' }),
    line('J8', 'E3', 'L3', 24200, 0, { client_id: 'C1' }), line('J9', 'E3', 'L5', 0, 20000), line('J10', 'E3', 'L4', 0, 4200),
  ];
  const data = {
    companySettings: { company_name: 'Bakkerij Jansen BV', kvk_number: '12345678', vat_number: 'NL001234567B01' },
    ledgerAccounts: accounts, vatCodes: [{ code: 'HOOG', label: 'Hoog', rate: 21 }], journalEntries: entries, journalLines: lines,
    clients: [{ id: 'C1', name: 'Café de Hoek', client_code: 'K-001', vat_number: 'NL888888888B01' }],
    suppliers: [{ id: 'S1', name: 'Groothandel & Zn', supplier_code: 'L-001', vat_number: null }],
  } as unknown as AppData;
  return buildXaf({ data, fiscalYearLabel: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
}

test('een rondje: wat ResoFly als auditfile schrijft, leest ResoFly ook weer in', () => {
  const file = parseXaf(resoflyXaf());
  assert.equal(file.version, '3.2');
  assert.equal(file.software, 'ResoFly');
  assert.equal(file.companyName, 'Bakkerij Jansen BV');
  assert.deepEqual([file.startDate, file.endDate], ['2025-01-01', '2025-12-31']);
  assert.deepEqual(file.relations.map(r => [r.id, r.name, r.type, r.vatNumber]), [
    ['C-K-001', 'Café de Hoek', 'C', 'NL888888888B01'],
    ['S-L-001', 'Groothandel & Zn', 'S', null],
  ]);
  assert.deepEqual(file.accounts.map(a => [a.code, a.type]), [['0500', 'B'], ['1100', 'B'], ['1300', 'B'], ['1510', 'B'], ['8000', 'P']]);

  // Op 1 januari 2026: alles van 2025 telt.
  const end = balancesAt(file, '2026-01-01');
  assert.deepEqual(end.balance.map(b => [b.code, b.cents]), [['0500', -100000], ['1100', 112100], ['1300', 24200], ['1510', -6300]]);
  assert.equal(end.resultCents, -30000, 'een winst van 300 euro staat credit');
  assert.equal(end.differenceCents, 0);

  // Op 1 december 2025: factuur 2 telt nog niet mee.
  const mid = balancesAt(file, '2025-12-01');
  assert.deepEqual(mid.balance.map(b => [b.code, b.cents]), [['0500', -100000], ['1100', 112100], ['1510', -2100]]);
  assert.equal(mid.resultCents, -10000);
  assert.match(mid.warnings.join(' '), /3 boekingsregel\(s\) op of na de overstapdatum/);
});

const otherPackage = `<?xml version="1.0" encoding="windows-1252"?>
<!-- gemaakt door een ander pakket -->
<xaf:auditfile xmlns:xaf="http://www.auditfiles.nl/XAF/3.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <xaf:header>
    <xaf:fiscalYear>2025</xaf:fiscalYear><xaf:startDate>2025-01-01</xaf:startDate><xaf:endDate>2025-12-31</xaf:endDate>
    <xaf:curCode>EUR</xaf:curCode><xaf:softwareDesc>Ander Pakket</xaf:softwareDesc>
  </xaf:header>
  <xaf:company>
    <xaf:companyIdent>87654321</xaf:companyIdent><xaf:companyName>Café Zon &amp; Zee</xaf:companyName>
    <xaf:taxRegistrationCountry>NL</xaf:taxRegistrationCountry><xaf:taxRegIdent>NL111111111B01</xaf:taxRegIdent>
    <xaf:customersSuppliers>
      <xaf:customerSupplier>
        <xaf:custSupID>1001</xaf:custSupID><xaf:custSupName>Jansen B.V.</xaf:custSupName><xaf:contact>Piet</xaf:contact>
        <xaf:telephone>010-1234567</xaf:telephone><xaf:eMail>info@jansen.nl</xaf:eMail><xaf:commerceNr>11223344</xaf:commerceNr>
        <xaf:taxRegIdent>NL222222222B01</xaf:taxRegIdent><xaf:custSupTp>B</xaf:custSupTp>
        <xaf:streetAddress><xaf:streetname>Dorpsstraat</xaf:streetname><xaf:number>12</xaf:number><xaf:numberExtension>a</xaf:numberExtension><xaf:city>Utrecht</xaf:city><xaf:postalCode>3511 AA</xaf:postalCode><xaf:country>NL</xaf:country></xaf:streetAddress>
        <xaf:bankAccount><xaf:bankAccNr>NL91ABNA0417164300</xaf:bankAccNr></xaf:bankAccount>
      </xaf:customerSupplier>
      <xaf:customerSupplier><xaf:custSupID>1002</xaf:custSupID><xaf:custSupName><![CDATA[De Boer & Co]]></xaf:custSupName><xaf:custSupTp>C</xaf:custSupTp></xaf:customerSupplier>
      <xaf:customerSupplier><xaf:custSupID>1003</xaf:custSupID><xaf:custSupName>Zonder soort</xaf:custSupName></xaf:customerSupplier>
    </xaf:customersSuppliers>
    <xaf:generalLedger>
      <xaf:ledgerAccount><xaf:accID>1000</xaf:accID><xaf:accDesc>Kas</xaf:accDesc><xaf:accTp>B</xaf:accTp></xaf:ledgerAccount>
      <xaf:ledgerAccount><xaf:accID>1010</xaf:accID><xaf:accDesc>Rabobank 1234</xaf:accDesc><xaf:accTp>B</xaf:accTp></xaf:ledgerAccount>
      <xaf:ledgerAccount><xaf:accID>1600</xaf:accID><xaf:accDesc>Te betalen btw</xaf:accDesc><xaf:accTp>B</xaf:accTp></xaf:ledgerAccount>
      <xaf:ledgerAccount><xaf:accID>0600</xaf:accID><xaf:accDesc>Kapitaal</xaf:accDesc><xaf:accTp>B</xaf:accTp></xaf:ledgerAccount>
      <xaf:ledgerAccount><xaf:accID>8000</xaf:accID><xaf:accDesc>Omzet</xaf:accDesc><xaf:accTp>P</xaf:accTp></xaf:ledgerAccount>
    </xaf:generalLedger>
    <xaf:openingBalance>
      <xaf:opBalDate>2025-01-01</xaf:opBalDate>
      <xaf:obLine><xaf:nr>1</xaf:nr><xaf:accID>1010</xaf:accID><xaf:amnt>5000.00</xaf:amnt><xaf:amntTp>D</xaf:amntTp></xaf:obLine>
      <xaf:obLine><xaf:nr>2</xaf:nr><xaf:accID>0600</xaf:accID><xaf:amnt>5000</xaf:amnt><xaf:amntTp>C</xaf:amntTp></xaf:obLine>
    </xaf:openingBalance>
    <xaf:transactions>
      <xaf:journal><xaf:jrnID>VK</xaf:jrnID>
        <xaf:transaction><xaf:nr>1</xaf:nr><xaf:trDt>2025-06-01</xaf:trDt>
          <xaf:trLine><xaf:accID>1000</xaf:accID><xaf:amnt>121.005</xaf:amnt><xaf:amntTp>D</xaf:amntTp><xaf:custSupID>1002</xaf:custSupID></xaf:trLine>
          <xaf:trLine><xaf:accID>8000</xaf:accID><xaf:amnt>100.00</xaf:amnt><xaf:amntTp>C</xaf:amntTp></xaf:trLine>
          <xaf:trLine><xaf:accID>1600</xaf:accID><xaf:amnt>21.01</xaf:amnt><xaf:amntTp>C</xaf:amntTp></xaf:trLine>
        </xaf:transaction>
      </xaf:journal>
    </xaf:transactions>
  </xaf:company>
</xaf:auditfile>`;

function windows1252(text: string): Uint8Array {
  // Alles in deze test is ASCII op de é na: 0xE9 in windows-1252.
  return Uint8Array.from([...text].map(ch => (ch === 'é' ? 0xe9 : ch.charCodeAt(0))));
}

test('een auditfile van een ander pakket: namespace, windows-1252, adressen, CDATA', () => {
  const file = parseXaf(decodeXafBytes(windows1252(otherPackage)));
  assert.equal(file.version, '3.1');
  assert.equal(file.companyName, 'Café Zon & Zee');
  assert.equal(file.kvkNumber, '87654321');
  const jansen = file.relations[0];
  assert.deepEqual(
    [jansen.name, jansen.type, jansen.contact, jansen.email, jansen.phone, jansen.kvkNumber, jansen.addressLine1, jansen.postalCode, jansen.city, jansen.country, jansen.iban],
    ['Jansen B.V.', 'B', 'Piet', 'info@jansen.nl', '010-1234567', '11223344', 'Dorpsstraat 12 a', '3511 AA', 'Utrecht', 'NL', 'NL91ABNA0417164300'],
  );
  assert.equal(file.relations[1].name, 'De Boer & Co');
  assert.equal(file.relations[2].type, null);

  const balances = balancesAt(file, '2026-01-01');
  assert.deepEqual(balances.balance.map(b => [b.code, b.cents]), [['0600', -500000], ['1000', 12101], ['1010', 500000], ['1600', -2101]]);
  assert.equal(balances.resultCents, -10000);
  assert.equal(balances.differenceCents, 0);
  assert.deepEqual(balances.warnings, []);
});

test('bedragen worden centen zonder afrondingsfouten', () => {
  assert.equal(decimalToCents('1234.56'), 123456);
  assert.equal(decimalToCents('0.1'), 10);
  assert.equal(decimalToCents('-0.29'), -29);
  assert.equal(decimalToCents('1234,5'), 123450);
  assert.equal(decimalToCents('100'), 10000);
  assert.equal(decimalToCents('2.675'), 268);
  assert.equal(decimalToCents('.5'), 50);
  assert.throws(() => decimalToCents('twaalf'), /Ongeldig bedrag/);
});

test('voorstellen voor het rekeningschema', () => {
  const propose = (code: string, name: string) => proposeAccount({ code, name }, resofly).targetId;
  assert.equal(propose('1010', 'Rabobank 1234'), 'a1100');
  assert.equal(propose('1050', 'NL91 ABNA 0417 1643 00'), 'a1100');
  assert.equal(propose('1200', 'Debiteuren'), 'a1300');
  assert.equal(propose('1400', 'Crediteuren'), 'a1600');
  assert.equal(propose('1600', 'Te betalen btw'), 'a1530', 'btw gaat naar 1530, niet naar 1510');
  assert.equal(propose('1610', 'Omzetbelasting hoog'), 'a1530');
  assert.equal(propose('0600', 'Kapitaal'), 'a0500');
  assert.equal(propose('0200', 'Inventaris'), 'a0100');
  assert.equal(propose('0210', 'Cumulatieve afschrijving inventaris'), 'a0150');
  assert.equal(propose('0999', 'Bank'), 'a1100', 'dezelfde naam gaat voor');
  assert.equal(propose('1000', 'Kas'), null, 'geen kas in het standaardschema: zelf kiezen');
  assert.equal(propose('1300', 'Iets onbekends'), 'a1300', 'als laatste: hetzelfde nummer');
  assert.equal(propose('8000', 'Omzet'), null, 'een W&V-rekening van ResoFly is nooit een doel');
});

test('regels voor de beginbalans: per rekening opgeteld, en niets zonder koppeling', () => {
  const balances = [
    { code: '1010', name: 'Rabo', type: 'B' as const, cents: 500000 },
    { code: '1020', name: 'ING', type: 'B' as const, cents: 25000 },
    { code: '1600', name: 'Btw', type: 'B' as const, cents: -2101 },
    { code: '1700', name: 'Nul', type: 'B' as const, cents: 0 },
  ];
  assert.deepEqual(openingLines(balances, { 1010: 'a1100', 1020: 'a1100', 1600: 'a1530', 1700: 'a1600' }), [
    { account_id: 'a1100', cents: 525000 }, { account_id: 'a1530', cents: -2101 },
  ]);
  assert.throws(() => openingLines(balances, { 1010: 'a1100' }), /Kies eerst een rekening voor 1020, 1600, 1700/);
});

test('klanten en leveranciers: wat er al is, wordt overgeslagen', () => {
  const file = parseXaf(otherPackage);
  const plan = planRelations(file, [{ name: 'jansen', vat_number: null }], [{ name: 'Iemand', vat_number: 'nl 222222222 b01' }]);
  // Jansen (B): als klant al bekend op naam, als leverancier al bekend op btw-nummer.
  assert.equal(plan.existing, 2);
  assert.deepEqual(plan.clients.map(c => c.name), ['De Boer & Co']);
  assert.deepEqual(plan.suppliers, []);
  assert.equal(plan.skipped, 1, 'een relatie zonder soort');

  const fresh = planRelations(file, [], []);
  assert.deepEqual(fresh.clients.map(c => c.name), ['Jansen B.V.', 'De Boer & Co']);
  assert.deepEqual(fresh.suppliers.map(s => [s.name, s.supplier_code, s.iban]), [['Jansen B.V.', '1001', 'NL91ABNA0417164300']]);
  assert.match(String(fresh.clients[0].notes), /Overgenomen uit Ander Pakket, relatienummer 1001/);
});

test('wat geen auditfile van versie 3 is, krijgt een duidelijke melding', () => {
  assert.throws(() => parseXaf('<?xml version="1.0"?><auditfile><header><auditfileVersion>CLAIR2.00.00</auditfileVersion></header></auditfile>'), /versie 2/);
  assert.throws(() => parseXaf('<?xml version="1.0"?><factuur><nr>1</nr></factuur>'), /geen auditfile/);
  assert.throws(() => parseXaf('<auditfile><header><fiscalYear>2025</fiscalYear></header>'), /niet gesloten/);
});
