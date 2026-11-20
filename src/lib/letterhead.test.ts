import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { letterheadFieldsForSave, letterheadMissing, withoutUnloadedLetterhead, LETTERHEAD_COLUMNS } from './letterhead.ts';

/**
 * Het briefpapier zit sinds 19 november 2026 niet meer in de kern
 * (lib/letterhead.ts). Een verstuurde factuur ligt vast; een voorbeeld of
 * download zonder het briefpapier, of een opslag die het wist, mag dus niet.
 */

const paper = 'data:application/pdf;base64,JVBERi0xLjQK';

test('pas ophalen als er briefpapier is en het niet geladen is', () => {
  assert.equal(letterheadMissing({ invoice_template_kind: 'pdf' }), true);
  assert.equal(letterheadMissing({ invoice_template_kind: 'pdf', invoice_template_data_url: paper }), false);
  assert.equal(letterheadMissing({ invoice_template_kind: 'none' }), false);
  assert.equal(letterheadMissing({ invoice_template_kind: 'pdf', invoice_template_data_url: null }), false);
  assert.equal(letterheadMissing(null), false);
});

test('opslaan zonder geladen briefpapier laat alle zes de kolommen staan', () => {
  // Het formulier zoals Instellingen het opbouwt vóór het briefpapier binnen is.
  const fields = letterheadFieldsForSave({ invoice_template_kind: 'pdf', invoice_template_file_name: 'papier.pdf', invoice_template_mime_type: 'application/pdf', invoice_template_file_size: 1234 });
  assert.equal(fields.invoice_template_kind, 'pdf', 'een niet-geladen briefpapier is geen "geen briefpapier"');
  assert.equal(fields.invoice_template_data_url, undefined);
  const row = withoutUnloadedLetterhead({ company_name: 'Jansen', ...fields });
  for (const column of LETTERHEAD_COLUMNS) assert.ok(!(column in row), `${column} gaat mee terwijl het briefpapier niet geladen is`);
  assert.equal(row.company_name, 'Jansen');
  // JSON laat undefined weg; zonder deze regel ging kind 'none' wel mee.
  assert.ok(!JSON.stringify(row).includes('invoice_template'));
});

test('een geladen briefpapier gaat mee; weghalen maakt alles leeg', () => {
  const kept = letterheadFieldsForSave({ invoice_template_kind: 'pdf', invoice_template_file_name: ' papier.pdf ', invoice_template_mime_type: 'application/pdf', invoice_template_file_size: 1234, invoice_template_data_url: paper, invoice_template_updated_at: '2026-11-19T10:00:00Z' });
  assert.equal(kept.invoice_template_data_url, paper);
  assert.equal(kept.invoice_template_file_name, 'papier.pdf');
  assert.deepEqual(withoutUnloadedLetterhead({ ...kept }), { ...kept });
  const removed = letterheadFieldsForSave({ invoice_template_kind: 'none', invoice_template_data_url: null });
  assert.deepEqual(removed, { invoice_template_kind: 'none', invoice_template_file_name: null, invoice_template_mime_type: null, invoice_template_file_size: 0, invoice_template_data_url: null, invoice_template_updated_at: null });
  assert.equal(withoutUnloadedLetterhead({ ...removed }).invoice_template_data_url, null, 'weghalen moet de database bereiken');
});

// ── De plekken in de app ────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

test('een PDF in de browser gaat altijd via het opgehaalde briefpapier', () => {
  // documentAssetsFromSettings zet het briefpapier in de PDF. Buiten
  // documentLayout.ts zelf mag dat alleen in lib/pdf.ts (na
  // withInvoiceLetterhead) en in de documentopmaak-editor (het formulier van
  // Instellingen, dat het briefpapier zelf ophaalt). Een nieuwe plek: haal het
  // briefpapier daar eerst op en zet hem in deze lijst.
  const callers = sourceFiles(SRC)
    .filter(file => /documentAssetsFromSettings\(/.test(readFileSync(file, 'utf8')))
    .map(file => file.slice(SRC.length).split('\\').join('/').replace(/^\//, ''))
    .filter(file => file !== 'lib/documentLayout.ts')
    .sort();
  assert.deepEqual(callers, ['features/DocumentLayoutEditor.tsx', 'lib/pdf.ts']);

  const pdf = read('lib/pdf.ts');
  const load = pdf.indexOf('await withInvoiceLetterhead(');
  const use = pdf.indexOf('documentAssetsFromSettings(');
  assert.ok(load > 0 && load < use, 'lib/pdf.ts moet het briefpapier ophalen vóór documentAssetsFromSettings');
});

test('Instellingen haalt het briefpapier op en maakt van "niet geladen" geen "geen briefpapier"', () => {
  const settings = read('features/SimplePages.tsx');
  assert.match(settings, /loadInvoiceLetterhead\(/, 'Instellingen moet het briefpapier zelf ophalen');
  assert.doesNotMatch(settings, /invoice_template_data_url: settings\.invoice_template_data_url \?\? null/, 'undefined (niet geladen) mag geen null worden');
  assert.match(settings, /letterheadFieldsForSave\(input\)/);
  const repository = read('lib/repository.ts');
  const upsert = repository.slice(repository.indexOf('export async function upsertCompanySettings'));
  assert.match(upsert.slice(0, 1500), /withoutUnloadedLetterhead\(/, 'upsertCompanySettings moet een niet-geladen briefpapier ongemoeid laten');
});
