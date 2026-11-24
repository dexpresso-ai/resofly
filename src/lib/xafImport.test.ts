import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppData } from '../types';
import { buildXaf } from './xaf.ts';
import {
  balancesAt, decimalToCents, decodeXafBytes, mappingWarnings, openingLines, parseXaf, planRelations, proposeAccount, splitResultOverPartners,
  type TargetAccount,
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

// Tot november 2026 gingen deze allemaal naar 1100 Bank, omdat de naam van een
// bank erin staat: de lening, de creditcard en de spaarrekening telden op tot
// één banksaldo (€ 24.290 credit in plaats van € 3.210 debet).
test('een lening, creditcard of spaarrekening wordt geen Bank, ook niet met de naam van een bank erin', () => {
  const propose = (code: string, name: string) => proposeAccount({ code, name }, resofly);
  for (const [code, name] of [
    ['0700', 'Lening Rabobank'], ['0710', 'Lening ING auto'], ['0720', 'Hypotheek o/g ABN AMRO'], ['0730', 'Rekening-courant krediet Rabobank'],
    ['0740', 'Financiering bestelbus'], ['0750', 'Financial lease bedrijfsauto'], ['1150', 'Creditcard ING'], ['1151', 'Credit card Knab'],
    ['1160', 'Spaarrekening Rabobank'], ['1170', 'Deposito ASN'], ['1180', 'Bankleningen'],
  ] as const) {
    const p = propose(code, name);
    assert.equal(p.targetId, null, `${name} krijgt geen voorstel`);
    assert.match(p.reason ?? '', /geen betaalrekening/, `${name}: het scherm zegt waarom`);
  }
  // Ook niet via hetzelfde nummer: een creditcard op 1100 in het oude pakket is nog geen Bank.
  assert.equal(propose('1100', 'Creditcard ING').targetId, null);
  assert.equal(propose('0100', 'Lening auto').targetId, null, 'en geen vast activum door het woord "auto"');
  // Een gewone betaalrekening blijft Bank, en "dienstverlening" is geen lening.
  assert.equal(propose('1010', 'Rabobank NL11RABO').targetId, 'a1100');
  assert.equal(propose('1011', 'ING zakelijke rekening').targetId, 'a1100');
  assert.equal(propose('1300', 'Nog te factureren dienstverlening').targetId, 'a1300');

  // Staat de rekening al in ResoFly, dan wel: op naam, of op nummer bij een rekening die zelf ook een lening is.
  const metLening: TargetAccount[] = [
    ...resofly,
    { id: 'a0700', code: '0700', name: 'Leningen', type: 'liability', subtype: null },
    { id: 'a1160', code: '1160', name: 'Spaarrekening Rabobank', type: 'asset', subtype: null },
  ];
  assert.deepEqual(proposeAccount({ code: '0700', name: 'Lening Rabobank' }, metLening), { targetId: 'a0700', reason: 'Zelfde rekeningnummer' });
  assert.deepEqual(proposeAccount({ code: '9999', name: 'Spaarrekening Rabobank' }, metLening), { targetId: 'a1160', reason: 'Zelfde naam' });
  assert.equal(proposeAccount({ code: '0710', name: 'Lening ING auto' }, metLening).targetId, null, 'een ander nummer: zelf kiezen');
});

test('waarschuwingen bij de koppeling: meer rekeningen op de bank, of een bank die credit staat', () => {
  const balances = [
    { code: '0700', name: 'Lening Rabobank', type: 'B' as const, cents: -2_000_000 },
    { code: '1100', name: 'Rabobank NL11RABO', type: 'B' as const, cents: 321_000 },
    { code: '1150', name: 'Creditcard ING', type: 'B' as const, cents: -50_000 },
    { code: '1300', name: 'Debiteuren', type: 'B' as const, cents: 100_000 },
    { code: '1310', name: 'Dubieuze debiteuren', type: 'B' as const, cents: 5_000 },
  ];
  // Eén betaalrekening op de bank, debet: niets te melden. Twee rekeningen op Debiteuren ook niet.
  assert.deepEqual(mappingWarnings(balances, { 1100: 'a1100', 1300: 'a1300', 1310: 'a1300' }, resofly), []);
  // De gebruiker zet de creditcard er zelf bij: gemeld, met de namen.
  const twee = mappingWarnings(balances, { 1100: 'a1100', 1150: 'a1100' }, resofly);
  assert.equal(twee.length, 1);
  assert.match(twee[0], /2 rekeningen uit de auditfile komen samen op 1100 Bank: 1100 Rabobank NL11RABO, 1150 Creditcard ING/);
  // Met de lening erbij staat de bank credit: twee meldingen.
  const drie = mappingWarnings(balances, { '0700': 'a1100', 1100: 'a1100', 1150: 'a1100' }, resofly);
  assert.equal(drie.length, 2);
  assert.match(drie[0], /3 rekeningen/);
  assert.match(drie[1], /1100 Bank komt uit op € 17\.290,00 credit/);
  // Eén rekening die rood staat: alleen de creditmelding.
  const rood = mappingWarnings(balances, { 1150: 'a1100' }, resofly);
  assert.equal(rood.length, 1);
  assert.match(rood[0], /€ 500,00 credit/);
  // Een saldo van nul telt niet als tweede rekening.
  assert.deepEqual(mappingWarnings([...balances, { code: '1105', name: 'Oude bank', type: 'B' as const, cents: 0 }], { 1100: 'a1100', 1105: 'a1100' }, resofly), []);
});

// Zonder <openingBalance> zijn de saldi alleen de mutaties van het jaar: de
// bank stond op € 210 in plaats van € 3.210 en de lening ontbrak, zonder melding.
test('een auditfile zonder beginbalans geeft een waarschuwing', () => {
  const metBeginbalans = parseXaf(otherPackage);
  const met = balancesAt(metBeginbalans, '2026-01-01');
  assert.equal(met.missingOpening, false);
  assert.doesNotMatch(met.warnings.join(' '), /geen beginbalans/);

  const zonder = balancesAt(parseXaf(otherPackage.replace(/<xaf:openingBalance>[\s\S]*<\/xaf:openingBalance>/, '')), '2026-01-01');
  assert.equal(zonder.missingOpening, true);
  assert.match(zonder.warnings.join(' '), /geen beginbalans: de saldi hieronder zijn alleen de boekingen vanaf 1-1-2025 uit dit bestand/);
  assert.deepEqual(zonder.balance.map(b => [b.code, b.cents]), [['1000', 12101], ['1600', -2101]], 'alleen de mutaties: de bank en het kapitaal ontbreken');

  // Wat ResoFly zelf schrijft, heeft altijd een beginbalans.
  assert.equal(balancesAt(parseXaf(resoflyXaf()), '2026-01-01').missingOpening, false);
});

test('vof: kapitaal en privé van een vennoot gaan naar zijn eigen rekening', () => {
  const vof: TargetAccount[] = [
    ...resofly,
    { id: 'a0501', code: '0501', name: 'Kapitaal Anna Jansen', type: 'equity', subtype: 'partner_capital' },
    { id: 'a0502', code: '0502', name: 'Kapitaal Bram de Vries', type: 'equity', subtype: 'partner_capital' },
    { id: 'a0551', code: '0551', name: 'Privé-opnamen Anna Jansen', type: 'equity', subtype: 'partner_withdrawals' },
    { id: 'a0562', code: '0562', name: 'Privé-stortingen Bram de Vries', type: 'equity', subtype: 'partner_contributions' },
    { id: 'a0503', code: '0503', name: 'Kapitaal Piet Jansen', type: 'equity', subtype: 'partner_capital' },
  ];
  const propose = (code: string, name: string) => proposeAccount({ code, name }, vof).targetId;
  assert.equal(propose('0610', 'Kapitaal vennoot B. de Vries'), 'a0502');
  assert.equal(propose('0620', 'Privé-opnamen Anna'), 'a0551');
  assert.equal(propose('0630', 'Prive stortingen Bram'), 'a0562');
  assert.equal(propose('0640', 'Kapitaal Anna Jansen'), 'a0501', 'dezelfde naam');
  // Tot november 2026 viel dit terug op 0500, met een voorstel; de changelog
  // van 18 november (punt 11) beloofde er juist geen.
  assert.equal(propose('0650', 'Kapitaal Jansen'), null, 'twee vennoten heten Jansen: geen vennoot raden, en ook geen 0500');
  assert.equal(propose('0660', 'Kapitaal'), 'a0500', 'zonder naam: het algemene kapitaal');
});

// De vennoten van de reviewer: Anna Jansen en Jan van Dam. Lisa van Leeuwen
// staat nog niet in ResoFly.
const vofAnnaJan: TargetAccount[] = [
  ...resofly,
  { id: 'a0550', code: '0550', name: 'Privé-opnamen (geen vennoot)', type: 'equity', subtype: 'private_withdrawals' },
  { id: 'a0560', code: '0560', name: 'Privé-stortingen (geen vennoot)', type: 'equity', subtype: 'private_contributions' },
  { id: 'a0501', code: '0501', name: 'Kapitaal Anna Jansen', type: 'equity', subtype: 'partner_capital' },
  { id: 'a0502', code: '0502', name: 'Kapitaal Jan van Dam', type: 'equity', subtype: 'partner_capital' },
  { id: 'a0551', code: '0551', name: 'Privé-opnamen Anna Jansen', type: 'equity', subtype: 'partner_withdrawals' },
  { id: 'a0552', code: '0552', name: 'Privé-opnamen Jan van Dam', type: 'equity', subtype: 'partner_withdrawals' },
  { id: 'a0561', code: '0561', name: 'Privé-stortingen Anna Jansen', type: 'equity', subtype: 'partner_contributions' },
  { id: 'a0562', code: '0562', name: 'Privé-stortingen Jan van Dam', type: 'equity', subtype: 'partner_contributions' },
];

// Tot november 2026 telde "van" als naam: het kapitaal van L. van Leeuwen
// (€ 4.000) werd 0502 Kapitaal Jan van Dam, en Jan stond op € 10.000.
test('vof: "van" is geen naam, Van Leeuwen wordt geen Van Dam', () => {
  const propose = (code: string, name: string) => proposeAccount({ code, name }, vofAnnaJan);
  for (const [code, name] of [['0610', 'Kapitaal vennoot L. van Leeuwen'], ['0620', 'Privé-opnamen L. van Leeuwen'], ['0630', 'Prive stortingen van Leeuwen']] as const) {
    const p = propose(code, name);
    assert.equal(p.targetId, null, `${name}: geen voorstel`);
    assert.match(p.reason ?? '', /noemt een vennoot die niet in ResoFly staat/, `${name}: het scherm zegt waarom`);
  }
  // Van Dam zelf wordt wel herkend, met of zonder voorletter of "vennoot".
  assert.deepEqual(propose('0640', 'Kapitaal vennoot Van Dam'), { targetId: 'a0502', reason: 'Vennoot' });
  assert.equal(propose('0641', 'Kapitaal J. van Dam').targetId, 'a0502');
  assert.equal(propose('0642', 'Privé-opnamen v/d Dam').targetId, 'a0552', '"v/d" is een tussenvoegsel, geen voorletter');
  assert.equal(propose('0643', 'Privé-stortingen Jan').targetId, 'a0562', 'alleen een voornaam mag, als er verder niets staat');
  // Een andere voorletter of voornaam bij dezelfde achternaam is iemand anders.
  assert.equal(propose('0644', 'Kapitaal A. van Dam').targetId, null);
  assert.equal(propose('0645', 'Kapitaal Lisa van Dam').targetId, null);
  assert.match(propose('0645', 'Kapitaal Lisa van Dam').reason ?? '', /niet in ResoFly/);
  // Zonder vennoten in ResoFly: het algemene kapitaal, zoals altijd.
  assert.equal(proposeAccount({ code: '0610', name: 'Kapitaal vennoot L. van Leeuwen' }, resofly).targetId, 'a0500');
});

// Anna en Piet Jansen: "Kapitaal Jansen" ging naar 0500 en "Privé-opnamen
// Jansen" naar 0550 (geen vennoot), steeds mét voorstel.
test('vof: twee vennoten met dezelfde achternaam krijgen geen voorstel', () => {
  const tweeJansen: TargetAccount[] = [
    ...resofly,
    { id: 'a0550', code: '0550', name: 'Privé-opnamen (geen vennoot)', type: 'equity', subtype: 'private_withdrawals' },
    { id: 'a0501', code: '0501', name: 'Kapitaal Anna Jansen', type: 'equity', subtype: 'partner_capital' },
    { id: 'a0502', code: '0502', name: 'Kapitaal Piet Jansen', type: 'equity', subtype: 'partner_capital' },
    { id: 'a0551', code: '0551', name: 'Privé-opnamen Anna Jansen', type: 'equity', subtype: 'partner_withdrawals' },
    // Piet heeft (nog) geen opnamenrekening: toch twijfel, want hij is wel een Jansen.
  ];
  const propose = (code: string, name: string) => proposeAccount({ code, name }, tweeJansen);
  for (const [code, name] of [['0600', 'Kapitaal vennoot Jansen'], ['0550', 'Privé-opnamen Jansen']] as const) {
    const p = propose(code, name);
    assert.equal(p.targetId, null, `${name}: geen 0500 of 0550`);
    assert.match(p.reason ?? '', /past bij twee vennoten \(Anna Jansen en Piet Jansen\)/);
  }
  // Een voorletter of voornaam beslist.
  assert.equal(propose('0601', 'Kapitaal A. Jansen').targetId, 'a0501');
  assert.equal(propose('0602', 'Kapitaal Piet Jansen').targetId, 'a0502');
  assert.equal(propose('0603', 'Privé-opnamen A.J. Jansen').targetId, 'a0551');
  // Een Jansen die er niet is.
  assert.match(propose('0604', 'Kapitaal L. Jansen').reason ?? '', /niet in ResoFly/);
  // Wel een Jansen, maar zonder rekening voor dit soort: zeg dat.
  const piet = propose('0605', 'Privé-opnamen Piet Jansen');
  assert.equal(piet.targetId, null);
  assert.match(piet.reason ?? '', /Piet Jansen heeft in ResoFly geen rekening voor privé-opnamen/);
});

// "Cum. afschr. inventaris", "Afschrijving inventaris" en "Afschrijvingen
// inventaris" kwamen alle drie op 0100 Vaste activa.
test('cumulatieve afschrijving gaat naar 0150, ook afgekort, en niet naar het activum', () => {
  const propose = (code: string, name: string) => proposeAccount({ code, name }, resofly);
  for (const name of ['Cum. afschr. inventaris', 'Afschrijving inventaris', 'Afschrijvingen inventaris', 'Cumulatieve afschrijving inventaris', 'Afschr. cum. bedrijfsauto']) {
    assert.deepEqual(propose('0110', name), { targetId: 'a0150', reason: 'Cumulatieve afschrijving' }, name);
  }
  assert.equal(propose('0100', 'Inventaris').targetId, 'a0100', 'het activum zelf blijft 0100');
  // Zonder rekening voor cumulatieve afschrijving: geen voorstel, ook niet op nummer.
  const zonder = resofly.filter(t => t.subtype !== 'accumulated_depreciation');
  const p = proposeAccount({ code: '0100', name: 'Cum. afschr. inventaris' }, zonder);
  assert.equal(p.targetId, null);
  assert.match(p.reason ?? '', /geen rekening voor cumulatieve afschrijving/);
  // Een eigen rekening met dat nummer en "afschrijving" in de naam mag wel.
  const eigen: TargetAccount[] = [...zonder, { id: 'a0110', code: '0110', name: 'Afschrijving inventaris', type: 'asset', subtype: null }];
  assert.equal(proposeAccount({ code: '0110', name: 'Cum. afschr. inventaris' }, eigen).targetId, 'a0110');
});

// "Rekening-courant vennoot Van Dam" met oud nummer 0560 werd 0560
// Privé-stortingen (geen vennoot), en ging bij de jaarafsluiting naar 0500.
test('een rekening-courant met een vennoot wordt geen privé, ook niet op nummer', () => {
  const propose = (code: string, name: string) => proposeAccount({ code, name }, vofAnnaJan);
  // Een administratie zonder rekening-courant per vennoot (van vóór 20261124120000).
  for (const [code, name] of [['0560', 'Rekening-courant vennoot Van Dam'], ['0550', 'R/C Jansen'], ['0552', 'Rekening courant Jan van Dam']] as const) {
    const p = propose(code, name);
    assert.equal(p.targetId, null, `${code} ${name}`);
    assert.match(p.reason ?? '', /geen rekening voor rekening-courant/);
  }
  const zonderNaam = propose('0500', 'RC vennoten');
  assert.equal(zonderNaam.targetId, null);
  assert.match(zonderNaam.reason ?? '', /schuld of vordering, geen privé/);
  // Noemt de naam een vennoot, dan ook niet op nummer naar 0550 of 0560 (geen vennoot).
  assert.match(propose('0550', 'Privé Jansen').reason ?? '', /noemt een vennoot.*0550 Privé-opnamen \(geen vennoot\) is van geen enkele vennoot/);
  // Gewoon privé blijft gewoon privé.
  assert.equal(propose('0560', 'Privé-stortingen').targetId, 'a0560');
  assert.equal(propose('0550', 'Privé-opnamen').targetId, 'a0550');
});

test('een waarschuwing als meer rekeningen samenkomen op 0500 of op de rekening van één vennoot', () => {
  const balances = [
    { code: '0600', name: 'Kapitaal vennoot J. van Dam', type: 'B' as const, cents: -600_000 },
    { code: '0610', name: 'Kapitaal vennoot L. van Leeuwen', type: 'B' as const, cents: -400_000 },
    { code: '0620', name: 'Kapitaal vennoot A. Jansen', type: 'B' as const, cents: -500_000 },
    { code: '0630', name: 'Privé-opnamen A. Jansen', type: 'B' as const, cents: 20_000 },
  ];
  // Ieder op zijn eigen rekening: niets te melden.
  assert.deepEqual(mappingWarnings(balances, { '0600': 'a0502', '0620': 'a0501', '0630': 'a0551', '0610': 'a0500' }, vofAnnaJan), []);
  // Van Leeuwen bij Van Dam: gemeld, met de namen.
  const bijJan = mappingWarnings(balances, { '0600': 'a0502', '0610': 'a0502', '0620': 'a0501', '0630': 'a0551' }, vofAnnaJan);
  assert.equal(bijJan.length, 1);
  assert.match(bijJan[0], /2 rekeningen uit de auditfile komen samen op 0502 Kapitaal Jan van Dam: 0600 Kapitaal vennoot J\. van Dam, 0610 Kapitaal vennoot L\. van Leeuwen\. Ze worden één saldo, van één vennoot/);
  // Twee kapitalen op 0500: ook gemeld, op geen enkele vennoot.
  const op0500 = mappingWarnings(balances, { '0600': 'a0500', '0610': 'a0500', '0620': 'a0501', '0630': 'a0551' }, vofAnnaJan);
  assert.equal(op0500.length, 1);
  assert.match(op0500[0], /komen samen op 0500 Eigen vermogen: .*op geen enkele vennoot/);
  // Privé-opnamen bij elkaar op 055n tellen ook.
  assert.equal(mappingWarnings(balances, { '0600': 'a0502', '0610': 'a0551', '0620': 'a0501', '0630': 'a0551' }, vofAnnaJan).length, 1);
});

// Een vof stapt per 1-7-2025 over. De winst van januari t/m juni (€ 12.000)
// kwam als sluitpost op 0500 en werd nooit over de vennoten verdeeld.
test('vof: de winst tot de overstap komt per vennoot op zijn kapitaal, tot op de cent', () => {
  const vofXaf = `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="http://www.auditfiles.nl/XAF/3.2"><header><fiscalYear>2025</fiscalYear><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate></header>
<company><companyName>Jansen &amp; Van Dam vof</companyName><generalLedger>
<ledgerAccount><accID>1000</accID><accDesc>Bank</accDesc><accTp>B</accTp></ledgerAccount>
<ledgerAccount><accID>0600</accID><accDesc>Kapitaal Anna Jansen</accDesc><accTp>B</accTp></ledgerAccount>
<ledgerAccount><accID>0610</accID><accDesc>Kapitaal Jan van Dam</accDesc><accTp>B</accTp></ledgerAccount>
<ledgerAccount><accID>8000</accID><accDesc>Omzet</accDesc><accTp>P</accTp></ledgerAccount>
</generalLedger><openingBalance><opBalDate>2025-01-01</opBalDate>
<obLine><nr>1</nr><accID>1000</accID><amnt>10000</amnt><amntTp>D</amntTp></obLine>
<obLine><nr>2</nr><accID>0600</accID><amnt>6000</amnt><amntTp>C</amntTp></obLine>
<obLine><nr>3</nr><accID>0610</accID><amnt>4000</amnt><amntTp>C</amntTp></obLine>
</openingBalance><transactions><journal><jrnID>VK</jrnID>
<transaction><nr>1</nr><trDt>2025-03-01</trDt><trLine><accID>1000</accID><amnt>12000</amnt><amntTp>D</amntTp></trLine><trLine><accID>8000</accID><amnt>12000</amnt><amntTp>C</amntTp></trLine></transaction>
<transaction><nr>2</nr><trDt>2025-08-01</trDt><trLine><accID>1000</accID><amnt>5000</amnt><amntTp>D</amntTp></trLine><trLine><accID>8000</accID><amnt>5000</amnt><amntTp>C</amntTp></trLine></transaction>
</journal></transactions></company></auditfile>`;
  const balances = balancesAt(parseXaf(vofXaf), '2025-07-01');
  assert.equal(balances.resultCents, -1_200_000, '€ 12.000 winst tot de overstap');
  const partners = [
    { capitalAccountId: 'a0502', name: 'Jan van Dam', partnerNumber: 2, basisPoints: 4000 },
    { capitalAccountId: 'a0501', name: 'Anna Jansen', partnerNumber: 1, basisPoints: 6000 },
  ];
  const split = splitResultOverPartners(balances.resultCents, partners);
  assert.deepEqual(split, { kind: 'split', lines: [
    { account_id: 'a0501', cents: -720_000, name: 'Anna Jansen', basisPoints: 6000 },
    { account_id: 'a0502', cents: -480_000, name: 'Jan van Dam', basisPoints: 4000 },
  ] });
  const mapping = Object.fromEntries(balances.balance.map(b => [b.code, proposeAccount(b, vofAnnaJan).targetId]));
  const lines = openingLines(balances.balance, mapping, split.kind === 'split' ? split.lines : []);
  assert.deepEqual([...lines].sort((a, b) => a.account_id.localeCompare(b.account_id)), [
    { account_id: 'a0501', cents: -1_320_000 }, { account_id: 'a0502', cents: -880_000 }, { account_id: 'a1100', cents: 2_200_000 },
  ]);
  assert.equal(lines.reduce((sum, l) => sum + l.cents, 0), 0, 'de beginbalans sluit: geen sluitpost op 0500');

  // Dezelfde afronding als de jaarafsluiting (vennoten_jaarafsluiting.sql): € 1.000,01 wordt € 600,01 en € 400,00.
  assert.deepEqual(splitResultOverPartners(-100_001, partners), { kind: 'split', lines: [
    { account_id: 'a0501', cents: -60_001, name: 'Anna Jansen', basisPoints: 6000 },
    { account_id: 'a0502', cents: -40_000, name: 'Jan van Dam', basisPoints: 4000 },
  ] });
  // Verlies is debet; drie gelijke delen sluiten ook.
  const derden = [
    { capitalAccountId: 'x', name: 'X', partnerNumber: 1, basisPoints: 3333 },
    { capitalAccountId: 'y', name: 'Y', partnerNumber: 2, basisPoints: 3333 },
    { capitalAccountId: 'z', name: 'Z', partnerNumber: 3, basisPoints: 3334 },
  ];
  const verlies = splitResultOverPartners(30_001, derden);
  assert.equal(verlies.kind, 'split');
  if (verlies.kind === 'split') {
    assert.ok(verlies.lines.every(l => l.cents > 0), 'verlies staat debet');
    assert.equal(verlies.lines.reduce((sum, l) => sum + l.cents, 0), 30_001);
  }
  // Geen vennoten, of een verdeling die niet op 100% uitkomt: niets verdelen.
  assert.deepEqual(splitResultOverPartners(-1_200_000, []), { kind: 'no_partners' });
  assert.deepEqual(splitResultOverPartners(-1_200_000, partners.slice(0, 1)), { kind: 'shares_not_100', totalBasisPoints: 4000 });
  assert.deepEqual(splitResultOverPartners(0, partners), { kind: 'split', lines: [] });
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

// Sinds 20261124120000 heeft elke vennoot een rekening-courant (141n).
test('een rekening-courant met een vennoot gaat naar zijn rekening-courant', () => {
  const metRc: TargetAccount[] = [
    ...vofAnnaJan,
    { id: 'a1411', code: '1411', name: 'Rekening-courant Anna Jansen', type: 'liability', subtype: 'partner_current_account' },
    { id: 'a1412', code: '1412', name: 'Rekening-courant Jan van Dam', type: 'liability', subtype: 'partner_current_account' },
  ];
  const propose = (code: string, name: string) => proposeAccount({ code, name }, metRc);
  assert.equal(propose('0560', 'Rekening-courant vennoot Van Dam').targetId, 'a1412');
  assert.equal(propose('1700', 'R/C Jansen').targetId, 'a1411');
  assert.equal(propose('1710', 'Rekening courant A. Jansen').targetId, 'a1411');
  // Iemand die niet in ResoFly staat, of geen naam: geen voorstel.
  assert.equal(propose('1720', 'Rekening-courant L. van Leeuwen').targetId, null);
  assert.match(propose('0500', 'RC vennoten').reason ?? '', /schuld of vordering, geen privé/);
  // Het kapitaal blijft het kapitaal.
  assert.equal(propose('0600', 'Kapitaal vennoot J. van Dam').targetId, 'a0502');
});
