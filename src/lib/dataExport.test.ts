import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  auditfilePeriods, buildDataExport, csvCell, csvHeaderLabel, ExportAbortedError, exportFileName,
  type ExportPageRequest, type ExportRow, type ExportSource,
} from './dataExport.ts';

/**
 * De hele export met een nep-bron: een kleine "database" per tabel en een
 * opslag met bestanden. De bron gedraagt zich als Supabase (filter op de
 * organisatie, sorteren, bladeren) en als de media-worker (null bij een
 * ontbrekend bestand).
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const stored = buffer.subarray(start, start + compressedSize);
    out.set(name, method === 8 ? inflateRawSync(stored) : Buffer.from(stored));
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const pdfBytes = Buffer.from('%PDF-1.4 factuur FAC-2025-0001');

function makeDb(): Record<string, ExportRow[]> {
  return {
    organizations: [{ id: ORG, name: 'Bakkerij Jansen', slug: 'bakkerij-jansen' }, { id: OTHER, name: 'Iemand anders' }],
    company_settings: [{ id: id(1), organization_id: ORG, company_name: 'Bakkerij Jansen BV', kvk_number: '12345678', vat_number: 'NL001234567B01' }],
    clients: [
      { id: id(10), organization_id: ORG, name: 'Café de Hoek', client_code: 'K-001', vat_number: null, value_eur: 1200 },
      { id: id(11), organization_id: ORG, name: '=HYPERLINK("https://evil.example")', client_code: 'K-002', vat_number: 'NL999999999B01', value_eur: null },
      { id: id(12), organization_id: OTHER, name: 'Klant van een ander', client_code: 'X-1' },
    ],
    invoices: [{
      id: id(20), organization_id: ORG, client_id: id(10), number: 'FAC-2025-0001', total_cents: 12100, paid: true,
      public_token_hash: 'geheim', public_token_created_at: '2025-03-01T10:00:00Z', public_token_expires_at: null, rate: 21.5,
    }],
    invoice_versions: [{ id: id(21), organization_id: ORG, invoice_id: id(20), pdf_storage_key: `${ORG}/invoice-pdfs/${id(20)}/abc-FAC-2025-0001.pdf` }],
    attachments: [
      { id: id(30), organization_id: ORG, entity_type: 'client', entity_id: id(10), name: 'contract.pdf', storage_key: `${ORG}/client/${id(10)}/def-contract.pdf` },
      { id: id(31), organization_id: ORG, entity_type: 'client', entity_id: id(10), name: 'weg.pdf', storage_key: `${ORG}/client/${id(10)}/ghi-weg.pdf` },
    ],
    purchase_invoice_inbox: [{ id: id(40), organization_id: ORG, attachments: [{ storage_key: `${ORG}/purchase_invoice_inbox/${id(40)}/jkl-bon.pdf`, name: 'bon.pdf' }] }],
    // Een "lek": de bron geeft hier een rij van een andere organisatie terug.
    tickets: [{ id: id(50), organization_id: OTHER, title: 'Niet van ons' }],
    email_suppressions: [
      { organization_id: ORG, email: 'a@voorbeeld.nl', reason: 'unsubscribed' },
      { organization_id: ORG, email: 'b@voorbeeld.nl', reason: 'bounced' },
      { organization_id: ORG, email: 'c@voorbeeld.nl', reason: 'complained' },
    ],
    calendar_sources: [{ id: id(60), organization_id: ORG, name: 'Werk', feed_url: 'https://geheim.example/ics?token=x', feed_etag: 'e1' }],
    ledger_accounts: [
      { id: id(70), organization_id: ORG, code: '1100', name: 'Bank', type: 'asset' },
      { id: id(71), organization_id: ORG, code: '8000', name: 'Omzet', type: 'revenue' },
    ],
    vat_codes: [{ id: id(72), organization_id: ORG, code: 'H', label: 'Hoog', rate: 21 }],
    fiscal_years: [{ id: id(73), organization_id: ORG, label: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }],
    journal_entries: [{ id: id(74), organization_id: ORG, entry_number: 'MEM-1', date: '2025-03-01', description: 'Verkoop', source_type: 'manual', status: 'posted' }],
    journal_lines: [
      { id: id(75), organization_id: ORG, entry_id: id(74), account_id: id(70), line_index: 0, debit_cents: 12100, credit_cents: 0 },
      { id: id(76), organization_id: ORG, entry_id: id(74), account_id: id(71), line_index: 1, debit_cents: 0, credit_cents: 12100 },
    ],
  };
}

function makeSource(db: Record<string, ExportRow[]>, files: Record<string, Buffer>) {
  const calls: ExportPageRequest[] = [];
  const fileCalls: string[] = [];
  const source: ExportSource = {
    async fetchRows(request) {
      calls.push(request);
      let rows = (db[request.table] ?? []).filter(row => request.table === 'tickets' || row[request.orgColumn] === request.organizationId);
      const key = (row: ExportRow) => request.orderBy.map(c => String(row[c] ?? '')).join('|');
      rows = [...rows].sort((a, b) => key(a).localeCompare(key(b)));
      if (request.after !== undefined) rows = rows.filter(row => String(row[request.orderBy[0]]) > String(request.after));
      rows = rows.slice(request.offset ?? 0, (request.offset ?? 0) + request.limit);
      if (request.select !== '*') {
        const columns = request.select.split(',');
        rows = rows.map(row => Object.fromEntries(columns.filter(c => c in row).map(c => [c, row[c]])));
      }
      return rows;
    },
    async fetchFile(key) {
      fileCalls.push(key);
      return files[key] ? new Blob([files[key]]) : null;
    },
  };
  return { source, calls, fileCalls };
}

const files = {
  [`${ORG}/invoice-pdfs/${id(20)}/abc-FAC-2025-0001.pdf`]: pdfBytes,
  [`${ORG}/client/${id(10)}/def-contract.pdf`]: Buffer.from('contract'),
  [`${ORG}/purchase_invoice_inbox/${id(40)}/jkl-bon.pdf`]: Buffer.from('bonnetje'),
};

test('de hele export: data, lijsten, bestanden, auditfile, manifest en uitleg', async () => {
  const { source, calls, fileCalls } = makeSource(makeDb(), files);
  const phases = new Set<string>();
  const result = await buildDataExport({
    source, organizationId: ORG, organizationName: 'Bakkerij Jansen', exportedBy: { id: id(99), email: 'gerjan@voorbeeld.nl' },
    now: new Date('2026-11-11T10:00:00Z'), pageSize: 2, onProgress: p => phases.add(p.phase),
  });
  const zip = readZip(Buffer.from(await result.blob.arrayBuffer()));
  const jsonl = (name: string) => zip.get(`data/${name}.jsonl`)!.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

  assert.equal(result.fileName, 'resofly-export-bakkerij-jansen-2026-11-11.zip');
  assert.deepEqual([...phases], ['tabellen', 'bestanden', 'boekhouding', 'inpakken']);

  // Alleen deze organisatie, zonder geheime kolommen.
  assert.deepEqual(jsonl('organizations').map(r => r.id), [ORG]);
  assert.deepEqual(jsonl('clients').map(r => r.client_code), ['K-001', 'K-002']);
  const invoice = jsonl('invoices')[0];
  assert.equal(invoice.number, 'FAC-2025-0001');
  assert.ok(!('public_token_hash' in invoice) && !('public_token_created_at' in invoice));
  assert.ok(!('feed_url' in jsonl('calendar_sources')[0]));

  // Bladeren met pagina's van 2: alle drie de afmeldingen, op de sorteerkolom.
  assert.deepEqual(jsonl('email_suppressions').map(r => r.email), ['a@voorbeeld.nl', 'b@voorbeeld.nl', 'c@voorbeeld.nl']);
  const suppressionCalls = calls.filter(c => c.table === 'email_suppressions');
  assert.deepEqual(suppressionCalls.map(c => c.after), [undefined, 'b@voorbeeld.nl']);
  assert.equal(calls.find(c => c.table === 'calendar_sources')?.select.includes('feed_url'), false);

  // Een rij van een ander: de tabel gaat niet mee, met een melding.
  assert.ok(!zip.has('data/tickets.jsonl'));
  assert.match(result.summary.tableErrors.find(e => e.table === 'tickets')?.message ?? '', /andere organisatie/);

  // Galerijen worden niet eens opgevraagd.
  assert.ok(!calls.some(c => c.table.startsWith('galler')), 'een galerijtabel opgevraagd');

  // Bestanden: met hun pad, de SHA-256 klopt, en een ontbrekend bestand staat in het manifest.
  assert.deepEqual(zip.get(`bestanden/facturen-pdf/${id(20)}/abc-FAC-2025-0001.pdf`), pdfBytes);
  assert.ok(zip.has(`bestanden/klanten/${id(10)}/def-contract.pdf`));
  assert.ok(zip.has(`bestanden/inkoopfacturen-inbox/${id(40)}/jkl-bon.pdf`));
  assert.equal(fileCalls.length, 4);
  assert.deepEqual(result.summary.missingFiles.map(f => f.key), [`${ORG}/client/${id(10)}/ghi-weg.pdf`]);
  const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8'));
  const pdf = manifest.bestanden.find((f: { pad: string }) => f.pad.endsWith('abc-FAC-2025-0001.pdf'));
  assert.equal(pdf.sha256, createHash('sha256').update(pdfBytes).digest('hex'));
  assert.equal(manifest.formaat, 'resofly-export');
  assert.equal(manifest.organisatie.id, ORG);
  assert.ok(manifest.niet_in_de_export.some((t: { tabel: string; soort: string }) => t.tabel === 'galleries' && t.soort === 'galerij'));
  assert.ok(manifest.weggelaten_kolommen.some((c: { tabel: string; kolom: string }) => c.tabel === 'invoices' && c.kolom === 'public_token_hash'));
  assert.equal(manifest.tabellen.find((t: { tabel: string }) => t.tabel === 'clients').rijen, 2);

  // Lijst voor Excel: BOM, ;, euro's met een komma, een formule wordt tekst.
  const csv = zip.get('lijsten/klanten.csv')!.toString('utf8');
  assert.ok(csv.startsWith('﻿"id";"organization_id";"name"'));
  assert.match(csv, /"'=HYPERLINK/);
  const invoicesCsv = zip.get('lijsten/facturen.csv')!.toString('utf8');
  assert.match(invoicesCsv, /"total_eur"/);
  assert.match(invoicesCsv, /"121,00"/);
  assert.match(invoicesCsv, /"ja"/);
  assert.match(invoicesCsv, /"21,5"/);

  // De boekhouding als auditfile.
  const xaf = zip.get('boekhouding/auditfile-2025.xaf')!.toString('utf8');
  assert.match(xaf, /<auditfile xmlns="http:\/\/www\.auditfiles\.nl\/XAF\/3\.2">/);
  assert.match(xaf, /<companyName>Bakkerij Jansen BV<\/companyName>/);
  assert.deepEqual(result.summary.auditfiles, ['boekhouding/auditfile-2025.xaf']);

  // De uitleg.
  const readme = zip.get('LEESMIJ.txt')!.toString('utf8');
  assert.match(readme, /^Export van Bakkerij Jansen uit ResoFly/);
  assert.match(readme, /GALERIJEN/);
  assert.match(readme, /1 bestand\(en\) stonden niet meer in de opslag/);
});

test('stoppen breekt de export af', async () => {
  const { source } = makeSource(makeDb(), files);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => buildDataExport({
    source, organizationId: ORG, organizationName: 'X', exportedBy: { id: id(99) }, signal: controller.signal,
  }), ExportAbortedError);
});

test('een tabel die niet te lezen is, staat als fout in het manifest en de rest gaat door', async () => {
  const { source } = makeSource(makeDb(), files);
  const failing: ExportSource = {
    ...source,
    async fetchRows(request) {
      if (request.table === 'notes') throw { message: 'permission denied for table notes', code: '42501' };
      return source.fetchRows(request);
    },
  };
  const result = await buildDataExport({ source: failing, organizationId: ORG, organizationName: 'X', exportedBy: { id: id(99) } });
  assert.deepEqual(result.summary.tableErrors.map(e => e.table).sort(), ['notes', 'tickets']);
  assert.match(result.summary.tableErrors.find(e => e.table === 'notes')!.message, /permission denied/);
  assert.ok(result.summary.tables > 100);
});

test('csv-cellen en koppen', () => {
  assert.equal(csvHeaderLabel('total_cents'), 'total_eur');
  assert.equal(csvHeaderLabel('name'), 'name');
  assert.equal(csvCell('total_cents', -12345), '-123.45');
  assert.equal(csvCell('archived', false), 'nee');
  assert.equal(csvCell('tags', ['a', 'b']), '["a","b"]');
  assert.equal(csvCell('rate', 21), 21);
  assert.equal(csvCell('name', null), '');
});

test('boekjaren voor de auditfiles: uit de tabel, of per kalenderjaar', () => {
  const entries = [
    { status: 'posted', date: '2024-06-01' }, { status: 'posted', date: '2025-02-01' }, { status: 'draft', date: '2026-01-01' },
  ];
  assert.deepEqual(auditfilePeriods([], entries).map(p => p.label), ['2024', '2025']);
  assert.deepEqual(auditfilePeriods([
    { label: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    { label: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
  ], entries).map(p => p.label), ['2025']);
  assert.deepEqual(auditfilePeriods([], []), []);
});

test('bestandsnaam van de export', () => {
  assert.equal(exportFileName('Café De Ster & Zn.', new Date('2026-01-02T00:00:00Z')), 'resofly-export-cafe-de-ster-zn-2026-01-02.zip');
  assert.equal(exportFileName('', new Date('2026-01-02T00:00:00Z')), 'resofly-export-organisatie-2026-01-02.zip');
});
