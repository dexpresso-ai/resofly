import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoBookEligible, isDocumentAttachment, looksLikeInvoice, looksLikeInvoiceText, normalizeDocumentMime,
  purgeEligible, retryEligibility, safeFileName, sameInvoice,
} from './invoiceInboxRules.ts';

/**
 * De factuur-inbox boekt en ruimt op zonder dat er iemand kijkt. Deze regels
 * beslissen wanneer dat mag; een verschuiving erin merk je pas aan een dubbel
 * geboekte factuur of een verdwenen bewijsstuk. Daarom vaste gevallen.
 */

test('welke bijlage een factuur kan zijn', () => {
  assert.equal(isDocumentAttachment('factuur.pdf', 'application/octet-stream'), true);
  assert.equal(isDocumentAttachment('factuur.PDF', ''), true);
  assert.equal(isDocumentAttachment('e-factuur.xml', 'text/xml'), true);
  assert.equal(isDocumentAttachment('scan', 'image/jpeg'), true);
  assert.equal(isDocumentAttachment('voorwaarden.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
  assert.equal(normalizeDocumentMime('factuur.pdf', 'application/octet-stream'), 'application/pdf');
  assert.equal(normalizeDocumentMime('foto.JPG', ''), 'image/jpeg');
  assert.equal(normalizeDocumentMime('x.bin', ''), 'application/octet-stream');
  assert.equal(safeFileName('Factuur Jansen (sept) €.pdf'), 'Factuur_Jansen_sept_.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'etc_passwd');
});

test('een factuur heeft regels én een bedrag', () => {
  const base = { supplier: { name: 'X' }, supplier_invoice_number: null, lines: [{}], totals: { total_cents: 0 }, extracted_totals: null };
  assert.equal(looksLikeInvoice({ ...base, totals: { total_cents: 12100 } }), true);
  assert.equal(looksLikeInvoice({ ...base, extracted_totals: { total_cents: 500 } }), true);
  assert.equal(looksLikeInvoice(base), false);
  assert.equal(looksLikeInvoice({ ...base, lines: [], totals: { total_cents: 100 } }), false);
});

test('mailtekst is pas een factuur met factuurwoorden en meerdere bedragen', () => {
  const invoiceMail = 'Factuur 2026-0142 van Groothandel BV. Levering kantoorartikelen 120,00. BTW 21% 25,20. Totaal te betalen € 145,20 binnen 14 dagen op IBAN NL00BANK0123456789. Vervaldatum 2 oktober 2026. Met vriendelijke groet, de administratie.';
  assert.equal(looksLikeInvoiceText(invoiceMail), true);
  assert.equal(looksLikeInvoiceText('Hierbij onze factuur, zie de bijlage. Met vriendelijke groet, Piet. ' + 'x'.repeat(200)), false);
  assert.equal(looksLikeInvoiceText('Bedankt voor je bestelling van € 50,00, de factuur volgt.'), false);
  assert.equal(looksLikeInvoiceText(''), false);
  assert.equal(looksLikeInvoiceText(null), false);
});

test('dezelfde factuur twee keer bijgevoegd', () => {
  const a = { supplier: { name: 'Groothandel BV' }, supplier_invoice_number: 'F-2026-001', lines: [{}], totals: { total_cents: 12100 }, extracted_totals: null };
  assert.equal(sameInvoice(a, { ...a, supplier_invoice_number: 'F2026001' }), true);
  assert.equal(sameInvoice(a, { ...a, supplier_invoice_number: 'F-2026-002' }), false);
  assert.equal(sameInvoice({ ...a, supplier_invoice_number: null }, { ...a, supplier_invoice_number: null, totals: { total_cents: 12101 } }), true);
  assert.equal(sameInvoice({ ...a, supplier_invoice_number: null }, { ...a, supplier_invoice_number: null, supplier: { name: 'Ander' } }), false);
});

test('automatisch boeken alleen als er niets te kiezen valt', () => {
  const ok = { supplierCreated: false, supplierMatch: 'vat', confidence: 'high' as const, warnings: [], lines: [{ account_id: 'a', amount_cents: 100 }], totals: { total_cents: 121 } };
  assert.deepEqual(autoBookEligible(ok), { ok: true });
  assert.equal(autoBookEligible({ ...ok, supplierCreated: true }).ok, false);
  assert.equal(autoBookEligible({ ...ok, supplierMatch: 'name' }).ok, false);
  assert.equal(autoBookEligible({ ...ok, confidence: 'medium' }).ok, false);
  assert.equal(autoBookEligible({ ...ok, warnings: ['totalen wijken af'] }).ok, false);
  assert.equal(autoBookEligible({ ...ok, lines: [{ account_id: null, amount_cents: 100 }] }).ok, false);
  assert.equal(autoBookEligible({ ...ok, totals: { total_cents: 0 } }).ok, false);
});

test('de opruimronde pakt alleen storingen opnieuw op, en niet eindeloos', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const row = (over: Record<string, unknown>) => ({ status: 'received', reason: null, attempts: 0, processing_started_at: null, updated_at: ago(30), ...over });
  assert.equal(retryEligibility(row({}), now).retry, true);
  assert.equal(retryEligibility(row({ updated_at: ago(1) }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'processing', processing_started_at: ago(11) }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'processing', processing_started_at: ago(2) }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'failed', reason: 'processing_error', attempts: 2 }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'failed', reason: 'storage_failed' }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'failed', reason: 'processing_error', attempts: 4 }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'ai_unavailable' }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'supplier_unknown' }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'rate_limited', updated_at: ago(30) }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'needs_review', reason: 'rate_limited', updated_at: ago(90) }), now).retry, true);
  assert.equal(retryEligibility(row({ status: 'ready' }), now).retry, false);
  assert.equal(retryEligibility(row({ status: 'duplicate' }), now).retry, false);
});

test('bijlagen van afgedane items gaan pas na een wachttijd weg, bewijsstukken nooit', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const row = (over: Record<string, unknown>) => ({ status: 'rejected', purged_at: null, purchase_invoice_id: null, updated_at: daysAgo(31), attachments: [{ storage_key: 'k' }], ...over });
  assert.equal(purgeEligible(row({}), now), true);
  assert.equal(purgeEligible(row({ updated_at: daysAgo(10) }), now), false);
  assert.equal(purgeEligible(row({ status: 'duplicate', updated_at: daysAgo(60) }), now), false);
  assert.equal(purgeEligible(row({ status: 'duplicate', updated_at: daysAgo(91) }), now), true);
  assert.equal(purgeEligible(row({ purchase_invoice_id: 'pi' }), now), false);
  assert.equal(purgeEligible(row({ status: 'ready', updated_at: daysAgo(400) }), now), false);
  assert.equal(purgeEligible(row({ purged_at: daysAgo(1) }), now), false);
  assert.equal(purgeEligible(row({ attachments: [{ storage_key: null }] }), now), false);
});
