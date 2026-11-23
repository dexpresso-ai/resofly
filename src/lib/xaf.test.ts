/**
 * Tests voor de auditfile (xaf.ts). Draaien met:  npm test
 *
 * Wat hier vastligt is wat de boekhouder en de Belastingdienst inlezen:
 *  - het bestand blijft geldig tegen het officiële XSD van XAF 3.2, ook met een
 *    lange naam (tests/fixtures/XmlAuditfileFinancieel3.2.xsd, met xmllint als
 *    dat er is);
 *  - omzet tegen 21% zonder btw-code krijgt toch zijn btw, met de code die de
 *    aangifte ook kiest;
 *  - elke regel van een factuur, creditnota, inkoopfactuur of betaling draagt
 *    het factuurnummer (invRef), en relaties hebben adres en KvK;
 *  - de beginbalans van het eerste jaar staat in <openingBalance>.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppData } from '../types';
import { buildXaf, fitXaf, xafCountry, xafVatCodeForLine, type XafReferences } from './xaf.ts';
import { balancesAt, parseXaf } from './xafImport.ts';

const XSD = new URL('../../tests/fixtures/XmlAuditfileFinancieel3.2.xsd', import.meta.url).pathname;
const LONG_NAME = 'Stichting Vrienden & Donateurs van het Centraal Museum Utrecht';

const VAT_CODES = [
  { code: 'HOOG', label: 'Hoog', rate: 21, kind: 'standard', sales_box: '1a', vat_box: null, is_active: true },
  { code: 'LAAG', label: 'Laag', rate: 9, kind: 'reduced', sales_box: '1b', vat_box: null, is_active: true },
  { code: 'NUL', label: 'Nul', rate: 0, kind: 'zero', sales_box: '1e', vat_box: null, is_active: true },
  { code: 'EXPORT', label: 'Export buiten EU (0%)', rate: 0, kind: 'zero', sales_box: '3a', vat_box: null, is_active: true },
];

/** Een eenmanszaak met een gevuld eerste jaar. */
function world(over: { company?: Record<string, unknown> } = {}) {
  const accounts = [
    { id: 'L0500', code: '0500', name: 'Eigen vermogen', type: 'equity', report_group: 'eigen_vermogen' },
    { id: 'L1100', code: '1100', name: 'Bank', type: 'asset', report_group: 'liquide_middelen' },
    { id: 'L1300', code: '1300', name: 'Debiteuren', type: 'asset', report_group: 'vorderingen' },
    { id: 'L1520', code: '1520', name: 'Voorbelasting', type: 'asset', report_group: 'vorderingen' },
    { id: 'L1510', code: '1510', name: 'Af te dragen btw', type: 'liability', report_group: 'kortlopende_schulden' },
    { id: 'L1600', code: '1600', name: 'Crediteuren', type: 'liability', report_group: 'kortlopende_schulden' },
    { id: 'L4500', code: '4500', name: 'Software', type: 'expense', report_group: 'overige_bedrijfskosten' },
    { id: 'L8000', code: '8000', name: 'Omzet hoog', type: 'revenue', report_group: 'netto_omzet' },
    { id: 'L8010', code: '8010', name: 'Omzet laag', type: 'revenue', report_group: 'netto_omzet' },
    { id: 'L8900', code: '8900', name: 'Rente', type: 'revenue', report_group: 'financiele_baten' },
  ];
  const entries = [
    // De beginbalans op de eerste dag van het boekjaar, zoals ResoFly hem boekt.
    { id: 'E0', entry_number: 'OPN-2025-00001', date: '2025-01-01', description: 'Beginbalans', source_type: 'opening_balance', source_id: null, status: 'posted' },
    { id: 'E1', entry_number: 'JP-2025-00002', date: '2025-03-01', description: 'Verkoopfactuur F2025-001', source_type: 'sales_invoice', source_id: 'I1', status: 'posted' },
    { id: 'E2', entry_number: 'JP-2025-00003', date: '2025-03-10', description: 'Creditnota C2025-001', source_type: 'credit_note', source_id: 'CN1', status: 'posted' },
    { id: 'E3', entry_number: 'JP-2025-00004', date: '2025-03-20', description: 'Ontvangst', source_type: 'payment', source_id: 'T1', status: 'posted' },
    { id: 'E4', entry_number: 'JP-2025-00005', date: '2025-04-02', description: 'Inkoop', source_type: 'purchase_invoice', source_id: 'P1', status: 'posted' },
    // Een boekstuk zonder nummer: de UUID is 36 tekens, één te veel voor het XSD.
    { id: '0b8a3c1e-1111-4222-8333-944455556666', entry_number: null, date: '2025-05-01', description: 'Rente', source_type: 'manual', source_id: null, status: 'posted' },
    { id: 'E6', entry_number: 'JP-2025-00007', date: '2025-12-31', description: 'Jaarafsluiting', source_type: 'year_close', source_id: null, status: 'posted' },
  ];
  let n = 0;
  const line = (entry: string, account: string, debit: number, credit: number, extra: Record<string, unknown> = {}) =>
    ({ id: `J${++n}`, entry_id: entry, account_id: account, line_index: n, debit_cents: debit, credit_cents: credit, vat_code: null, vat_rate: null, vat_amount_cents: null, client_id: null, supplier_id: null, ...extra });
  const lines = [
    line('E0', 'L1100', 200000, 0), line('E0', 'L0500', 0, 200000),
    // De standaardregel uit de editor: 21%, maar zonder btw-code.
    line('E1', 'L1300', 59300, 0, { client_id: 'C1' }),
    line('E1', 'L8000', 0, 40000, { vat_rate: 21, vat_amount_cents: 8400 }),
    line('E1', 'L8010', 0, 10000, { vat_code: 'LAAG', vat_rate: 9, vat_amount_cents: 900 }),
    line('E1', 'L1510', 0, 9300),
    // Een creditnota van 100 + 21; daarna staat er 593 − 121 = 472 open.
    line('E2', 'L8000', 10000, 0, { vat_rate: 21, vat_amount_cents: -2100 }),
    line('E2', 'L1510', 2100, 0),
    line('E2', 'L1300', 0, 12100, { client_id: 'C1' }),
    line('E3', 'L1100', 47200, 0),
    line('E3', 'L1300', 0, 47200, { client_id: 'C1' }),
    line('E4', 'L4500', 5000, 0, { vat_code: 'HOOG', vat_rate: 21, vat_amount_cents: 1050 }),
    line('E4', 'L1520', 1050, 0),
    line('E4', 'L1600', 0, 6050, { supplier_id: 'S1' }),
    line('0b8a3c1e-1111-4222-8333-944455556666', 'L1100', 500, 0),
    line('0b8a3c1e-1111-4222-8333-944455556666', 'L8900', 0, 500),
    line('E6', 'L8000', 30000, 0), line('E6', 'L0500', 0, 30000),
  ];
  const data = {
    companySettings: {
      company_name: 'Fotografie Van Dijk & Zoë', kvk_number: '87654321', vat_number: 'NL004495445B01',
      address_line1: 'Lange Nieuwstraat 12', postal_code: '3512 PH', city: 'Utrecht', country: 'Nederland',
      ...over.company,
    },
    ledgerAccounts: accounts, vatCodes: VAT_CODES, journalEntries: entries, journalLines: lines,
    clients: [{
      id: 'C1', name: LONG_NAME, client_code: 'K-001', vat_number: 'NL888888888B01', kvk_number: '11223344',
      contact_name: 'Anna de Vries', email: 'info@vrienden.test', phone: '030 123 45 67',
      address_line1: 'Museumlaan 1', postal_code: '3511 AA', city: 'Utrecht', country: 'Nederland',
    }],
    suppliers: [{
      id: 'S1', name: 'Software & Co', supplier_code: null, vat_number: null, kvk_number: null, iban: 'nl91 abna 0417 1643 00',
      address_line1: 'Hauptstraße 3', postal_code: '10115', city: 'Berlin', country: 'Duitsland',
    }],
    invoices: [{ id: 'I1', number: 'F2025-001' }],
    purchaseInvoices: [{ id: 'P1', supplier_invoice_number: 'SW-9981', internal_number: 'INK-2025-001' }],
  } as unknown as AppData;
  const references: XafReferences = {
    creditNoteNumbers: new Map([['CN1', 'C2025-001']]),
    paymentAllocations: [{
      journal_entry_id: 'E3', position: 1, kind: 'sales_invoice', invoice_id: 'I1', credit_note_id: null, purchase_invoice_id: null,
      client_id: 'C1', supplier_id: null, amount_cents: 47200,
    }],
  };
  return { data, references };
}

function build(over: { company?: Record<string, unknown> } = {}, withReferences = true): string {
  const { data, references } = world(over);
  return buildXaf({ data, fiscalYearLabel: '2025', startDate: '2025-01-01', endDate: '2025-12-31', references: withReferences ? references : undefined });
}

/** De trLine-blokken van een transactie, op boekstuknummer. */
function trLines(xml: string, nr: string): string[] {
  const start = xml.indexOf(`<transaction><nr>${nr}</nr>`);
  assert.ok(start >= 0, `transactie ${nr} niet gevonden`);
  const tx = xml.slice(start, xml.indexOf('</transaction>', start));
  return tx.match(/<trLine>.*?<\/trLine>/g) ?? [];
}

let xmllint: boolean;
try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); xmllint = true; } catch { xmllint = false; }

function validate(xml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'xaf-'));
  try {
    const file = join(dir, 'auditfile.xaf');
    writeFileSync(file, xml);
    execFileSync('xmllint', ['--noout', '--schema', XSD, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 'geldig';
  } catch (error) {
    const e = error as { stderr?: string };
    return e.stderr ?? String(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('afkappen op de lengte uit het XSD telt tekens, niet entiteiten of UTF-16-eenheden', () => {
  assert.equal(fitXaf(LONG_NAME, 50).length, 50);
  assert.equal(fitXaf('A & B', 3), 'A &');
  assert.equal(fitXaf('📷📷📷', 2), '📷📷');
  assert.equal(fitXaf(null, 10), '');
});

test('een naam van meer dan 50 tekens wordt afgekapt in plaats van het bestand ongeldig te maken', () => {
  const xml = build();
  assert.ok(xml.includes('<custSupName>Stichting Vrienden &amp; Donateurs van het Centraal Mu</custSupName>'), xml.slice(0, 2000));
});

test('de auditfile van een gevulde eenmanszaak is geldig tegen het XSD van XAF 3.2', { skip: !xmllint && 'xmllint ontbreekt' }, () => {
  assert.equal(validate(build()), 'geldig');
  // Zonder btw-nummer (KOR): taxRegIdent is bij de onderneming verplicht.
  assert.equal(validate(build({ company: { vat_number: null, country: 'Atlantis' } })), 'geldig');
  // Zonder de los opgehaalde nummers blijft hij geldig, alleen zonder die invRef.
  assert.equal(validate(build({}, false)), 'geldig');
});

test('omzet tegen 21% zonder btw-code krijgt de btw met de code die de aangifte kiest', () => {
  const xml = build();
  const [, revenue21, revenue9] = trLines(xml, 'JP-2025-00002');
  assert.match(revenue21, /<vat><vatID>HOOG<\/vatID><vatPerc>21<\/vatPerc><vatAmnt>84\.00<\/vatAmnt><vatAmntTp>C<\/vatAmntTp><\/vat>/);
  assert.match(revenue9, /<vat><vatID>LAAG<\/vatID><vatPerc>9<\/vatPerc><vatAmnt>9\.00<\/vatAmnt><vatAmntTp>C<\/vatAmntTp><\/vat>/);
  // Een creditnota draait de btw om.
  assert.match(trLines(xml, 'JP-2025-00003')[0], /<vatID>HOOG<\/vatID><vatPerc>21<\/vatPerc><vatAmnt>21\.00<\/vatAmnt><vatAmntTp>D<\/vatAmntTp>/);
  // Rente is geen omzet voor de btw, en de jaarafsluiting telt niet mee.
  assert.ok(!trLines(xml, '0b8a3c1e111142228333944455556666').some(l => l.includes('<vat>')));
  assert.ok(!trLines(xml, 'JP-2025-00007').some(l => l.includes('<vat>')));
});

test('de afleiding volgt compute_vat_boxes: 21 → 1a, 9 → 1b, 0 → 1e; een onbekende code telt als geen code', () => {
  const revenue = { type: 'revenue', report_group: 'netto_omzet' } as const;
  const code = (vat_rate: number | null, vat_code: string | null = null) =>
    xafVatCodeForLine({ vat_rate, vat_code }, revenue, 'sales_invoice', VAT_CODES as never)?.code ?? null;
  assert.equal(code(21), 'HOOG');
  assert.equal(code(9), 'LAAG');
  assert.equal(code(0), 'NUL');
  assert.equal(code(null), 'NUL');
  assert.equal(code(0, 'EXPORT'), 'EXPORT');
  assert.equal(code(21, 'WEG'), 'HOOG');
  // Kosten zonder code: de aangifte leidt daar niets af, de auditfile ook niet.
  assert.equal(xafVatCodeForLine({ vat_rate: 21, vat_code: null }, { type: 'expense', report_group: null }, 'manual', VAT_CODES as never), null);
});

test('elke regel draagt het factuurnummer: verkoop, creditnota, betaling en inkoop', () => {
  const xml = build();
  for (const l of trLines(xml, 'JP-2025-00002')) assert.match(l, /<invRef>F2025-001<\/invRef>/);
  for (const l of trLines(xml, 'JP-2025-00003')) assert.match(l, /<invRef>C2025-001<\/invRef>/);
  const [bank, debtor] = trLines(xml, 'JP-2025-00004');
  assert.equal(bank.includes('<invRef>'), false);
  assert.match(debtor, /<custSupID>C-K-001<\/custSupID><invRef>F2025-001<\/invRef>/);
  for (const l of trLines(xml, 'JP-2025-00005')) assert.match(l, /<invRef>SW-9981<\/invRef>/);
  // Zonder de losse gegevens blijven alleen de creditnota en de betaling zonder nummer.
  const zonder = build({}, false);
  assert.ok(trLines(zonder, 'JP-2025-00002').every(l => l.includes('<invRef>F2025-001</invRef>')));
  assert.ok(!trLines(zonder, 'JP-2025-00004').some(l => l.includes('<invRef>')));
});

test('relaties krijgen contact, KvK, adres en IBAN, in de volgorde van het XSD', () => {
  const xml = build();
  assert.ok(xml.includes('<custSupID>C-K-001</custSupID><custSupName>Stichting Vrienden &amp; Donateurs van het Centraal Mu</custSupName>'
    + '<contact>Anna de Vries</contact><telephone>030 123 45 67</telephone><eMail>info@vrienden.test</eMail><commerceNr>11223344</commerceNr>'
    + '<taxRegIdent>NL888888888B01</taxRegIdent><custSupTp>C</custSupTp>'
    + '<streetAddress><streetname>Museumlaan 1</streetname><city>Utrecht</city><postalCode>3511 AA</postalCode><country>NL</country></streetAddress>'
    + '</customerSupplier>'));
  assert.ok(xml.includes('<custSupTp>S</custSupTp><streetAddress><streetname>Hauptstraße 3</streetname><city>Berlin</city><postalCode>10115</postalCode><country>DE</country></streetAddress>'
    + '<bankAccount><bankAccNr>NL91ABNA0417164300</bankAccNr></bankAccount>'));
  // De eigen import leest ze terug.
  const relation = parseXaf(xml).relations.find(r => r.id === 'C-K-001')!;
  assert.deepEqual([relation.kvkNumber, relation.addressLine1, relation.postalCode, relation.city, relation.country], ['11223344', 'Museumlaan 1', '3511 AA', 'Utrecht', 'NL']);
});

test('een land dat geen ISO-code is, laat het veld weg', () => {
  assert.equal(xafCountry('Nederland'), 'NL');
  assert.equal(xafCountry('de'), 'DE');
  assert.equal(xafCountry('UK'), 'GB');
  assert.equal(xafCountry('XX'), null);
  assert.equal(xafCountry('Atlantis'), null);
});

test('een boekstuk zonder nummer krijgt zijn id zonder streepjes, binnen de 35 tekens', () => {
  const xml = build();
  assert.ok(xml.includes('<transaction><nr>0b8a3c1e111142228333944455556666</nr>'));
});

test('de beginbalans van het eerste jaar staat in <openingBalance>, en de import ziet hem', () => {
  const xml = build();
  assert.ok(!xml.includes('<jrnID>OPN</jrnID>'));
  assert.match(xml, /<openingBalance><opBalDate>2025-01-01<\/opBalDate><linesCount>2<\/linesCount><totalDebit>2000\.00<\/totalDebit><totalCredit>2000\.00<\/totalCredit>/);
  const file = parseXaf(xml);
  const end = balancesAt(file, '2026-01-01');
  assert.equal(end.missingOpening, false);
  assert.ok(!end.warnings.some(w => w.includes('geen beginbalans')));
  assert.equal(end.differenceCents, 0);
  assert.equal(end.balance.find(b => b.code === '1100')?.cents, 200000 + 47200 + 500);
});

test('een dagboek van soort O (beginbalans als boekstuk) telt voor de import als beginbalans', () => {
  const xml = `<?xml version="1.0"?><auditfile xmlns="http://www.auditfiles.nl/XAF/3.2"><header><fiscalYear>2025</fiscalYear><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate><curCode>EUR</curCode></header>
    <company><companyName>X</companyName><generalLedger><ledgerAccount><accID>1100</accID><accDesc>Bank</accDesc><accTp>B</accTp></ledgerAccount><ledgerAccount><accID>0500</accID><accDesc>Kapitaal</accDesc><accTp>B</accTp></ledgerAccount></generalLedger>
    <transactions><journal><jrnID>OPN</jrnID><desc>Openingsbalans</desc><jrnTp>O</jrnTp><transaction><nr>1</nr><periodNumber>1</periodNumber><trDt>2025-03-01</trDt>
    <trLine><nr>1</nr><accID>1100</accID><docRef>1</docRef><effDate>2025-03-01</effDate><amnt>100.00</amnt><amntTp>D</amntTp></trLine>
    <trLine><nr>2</nr><accID>0500</accID><docRef>1</docRef><effDate>2025-03-01</effDate><amnt>100.00</amnt><amntTp>C</amntTp></trLine>
    </transaction></journal></transactions></company></auditfile>`;
  const result = balancesAt(parseXaf(xml), '2026-01-01');
  assert.equal(result.missingOpening, false);
});
