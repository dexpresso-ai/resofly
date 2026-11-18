import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECLARATION_STATUS_HINTS, DECLARATION_STATUS_LABELS, READING_LINES, RECEIPT_MAX_EDGE, canFillIn, declarationActionsFor,
  declarationAwaitsApproval, declarationStatusLabel, fitWithin, inboxChannelLabel, isImageFile, isPdfFile, readingLine,
  receiptFileName, receiptOutcomeKind, receiptUnreadReason, splitDeclarations, submitterShortName,
} from './receipts.ts';
import { buildPermissions, canSubmitDeclarations, DECLARATIONS_PAGE } from './permissions.ts';
import { inboxItemSummary, inboxNeedsAttention, splitInboxItems } from './invoiceInbox.ts';

/**
 * Bonnen fotograferen en declaraties (2026-11-17): wat het scherm beslist.
 * Na de foto moet er altijd een duidelijke volgende stap zijn (Verder, een
 * leverancier kiezen, zelf invullen), en een declarant ziet zijn eigen
 * declaratie in gewone woorden.
 */

const item = (over: Record<string, unknown>) => ({
  status: 'ready', reason: null, purchase_invoice_id: 'pi-1', duplicate_of_purchase_invoice_id: null, proposal: null,
  channel: 'receipt', attachments: [{ name: 'bon.jpg', mime_type: 'image/jpeg', size_bytes: 1, storage_key: 'o/purchase_invoice_inbox/i/bon.jpg', sha256: 'x', kind: 'document' }],
  ...over,
} as never);

test('een foto wordt verkleind tot de lange kant, nooit vergroot', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: RECEIPT_MAX_EDGE, height: 1800, scaled: true });
  assert.deepEqual(fitWithin(1080, 4000), { width: 648, height: RECEIPT_MAX_EDGE, scaled: true }, 'een lange bon blijft lang');
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1, scaled: false });
});

test('foto of pdf, op type en op naam', () => {
  assert.equal(isPdfFile({ name: 'scan.PDF', type: '' }), true);
  assert.equal(isPdfFile({ name: 'x', type: 'application/pdf' }), true);
  assert.equal(isImageFile({ name: 'IMG_0001.HEIC', type: '' }), true);
  assert.equal(isImageFile({ name: 'foto', type: 'image/jpeg' }), true);
  assert.equal(isImageFile({ name: 'notities.txt', type: 'text/plain' }), false);
});

test('het bewijsstuk heet naar de datum, niet "image.jpg"', () => {
  assert.equal(receiptFileName(new Date(2026, 10, 17, 9, 5)), 'bon-2026-11-17-0905.jpg');
});

test('Gerrie vertelt waar hij naar kijkt, en blijft bij de laatste regel', () => {
  assert.equal(readingLine(0), READING_LINES[0]);
  assert.equal(readingLine(-5), READING_LINES[0]);
  assert.equal(readingLine(4000), READING_LINES[1]);
  assert.equal(readingLine(10 * 60_000), READING_LINES[READING_LINES.length - 1]);
});

test('na de foto: altijd een volgende stap', () => {
  assert.equal(receiptOutcomeKind(item({})), 'concept');
  assert.equal(receiptOutcomeKind(item({ status: 'booked' })), 'concept');
  assert.equal(receiptOutcomeKind(item({ status: 'ready', purchase_invoice_id: null })), 'unread');
  assert.equal(receiptOutcomeKind(item({ status: 'needs_review', reason: 'supplier_unknown', purchase_invoice_id: null, proposal: { supplier: { name: 'Jumbo' } } })), 'supplier');
  // Zonder voorstel valt er geen leverancier te kiezen: dan zelf invullen.
  assert.equal(receiptOutcomeKind(item({ status: 'needs_review', reason: 'supplier_unknown', purchase_invoice_id: null })), 'unread');
  assert.equal(receiptOutcomeKind(item({ status: 'needs_review', reason: 'ai_declined', purchase_invoice_id: null })), 'unread');
  assert.equal(receiptOutcomeKind(item({ status: 'duplicate', purchase_invoice_id: null })), 'duplicate');
  assert.equal(receiptOutcomeKind(item({ status: 'failed', purchase_invoice_id: null })), 'failed');
  assert.equal(receiptOutcomeKind(item({ status: 'processing', purchase_invoice_id: null })), 'processing');
  assert.match(receiptUnreadReason('ai_declined'), /Gerrie staat voor jou uit/);
  assert.match(receiptUnreadReason('budget_exhausted'), /tegoed/);
  assert.match(receiptUnreadReason('iets-nieuws'), /niet kunnen lezen/);
});

test('zelf invullen kan als Gerrie niet las en het bestand er is', () => {
  assert.equal(canFillIn(item({ status: 'needs_review', reason: 'ai_disabled', purchase_invoice_id: null })), true);
  assert.equal(canFillIn(item({ status: 'failed', reason: 'extraction_failed', purchase_invoice_id: null })), true);
  // Met een voorstel en een onbekende winkel is Klaarzetten de snellere weg.
  assert.equal(canFillIn(item({ status: 'needs_review', reason: 'supplier_unknown', purchase_invoice_id: null })), false);
  assert.equal(canFillIn(item({ status: 'ready' })), false, 'er is al een concept');
  assert.equal(canFillIn(item({ status: 'needs_review', reason: 'nothing_extracted', purchase_invoice_id: null, attachments: [{ storage_key: null, kind: 'document' }] })), false, 'het bestand is opgeruimd');
});

test('een declaratie: goedkeuren als er een concept is, afwijzen tot hij geboekt is', () => {
  const decl = (over: Record<string, unknown>) => item({ channel: 'declaration', ...over });
  assert.deepEqual(declarationActionsFor(decl({})), { approve: true, decline: true });
  assert.equal(declarationAwaitsApproval(decl({})), true);
  assert.deepEqual(declarationActionsFor(decl({ status: 'needs_review', purchase_invoice_id: null })), { approve: false, decline: true });
  assert.deepEqual(declarationActionsFor(decl({ status: 'booked' })), { approve: false, decline: false });
  assert.deepEqual(declarationActionsFor(decl({ status: 'rejected', purchase_invoice_id: null })), { approve: false, decline: false });
  // Een eigen bon of een mail heeft geen goedkeuring.
  assert.deepEqual(declarationActionsFor(item({})), { approve: false, decline: false });
  assert.deepEqual(declarationActionsFor(item({ channel: 'email' })), { approve: false, decline: false });
});

test('een declaratie die op goedkeuring wacht, staat bovenaan de werklijst', () => {
  // Eerst stond hij onder "afgehandeld": een concept telde als klaar.
  assert.equal(inboxNeedsAttention({ status: 'ready', channel: 'declaration' }), true);
  assert.equal(inboxNeedsAttention({ status: 'ready', channel: 'receipt' }), false, 'een eigen bon boek je wanneer je wilt');
  assert.equal(inboxNeedsAttention({ status: 'ready', channel: 'email' }), false);
  assert.equal(inboxNeedsAttention({ status: 'booked', channel: 'declaration' }), false);
  assert.equal(inboxNeedsAttention({ status: 'ready' }), false, 'zonder kanaal: mail');
  const { open, done } = splitInboxItems([
    { status: 'ready', channel: 'declaration', received_at: '2026-11-16T10:00:00Z' },
    { status: 'ready', channel: 'email', received_at: '2026-11-17T10:00:00Z' },
  ]);
  assert.equal(open.length, 1);
  assert.equal(done.length, 1);
});

test('een bon zonder uitlezing heet Bon of Declaratie, niet het adres van het teamlid', () => {
  const base = { proposal: null, sender_name: null, sender_email: 'jan@studio.nl', subject: 'Bon: bon.jpg' };
  assert.equal(inboxItemSummary({ ...base, channel: 'receipt' }).title, 'Bon');
  assert.equal(inboxItemSummary({ ...base, channel: 'declaration' }).title, 'Declaratie');
  assert.equal(inboxItemSummary({ ...base, channel: 'email' }).title, 'jan@studio.nl');
});

test('wie het instuurde, in de werklijst', () => {
  assert.equal(inboxChannelLabel({ channel: 'declaration' }, 'jan'), 'Declaratie van jan');
  assert.equal(inboxChannelLabel({ channel: 'declaration' }, null), 'Declaratie van een teamlid');
  assert.equal(inboxChannelLabel({ channel: 'receipt' }, 'anne'), 'Bon van anne');
  assert.equal(inboxChannelLabel({ channel: 'email' }, 'anne'), 'Per e-mail');
  assert.equal(submitterShortName('jan.jansen@bedrijf.nl'), 'jan.jansen');
  assert.equal(submitterShortName('  '), null);
  assert.equal(submitterShortName(null), null);
});

test('mijn declaraties: open bovenaan, nieuwste eerst, elke status in gewone woorden', () => {
  const list = [
    { id: 'a', status: 'approved', submitted_at: '2026-11-10T10:00:00Z' },
    { id: 'b', status: 'submitted', submitted_at: '2026-11-12T10:00:00Z' },
    { id: 'c', status: 'processing', submitted_at: '2026-11-16T10:00:00Z' },
    { id: 'd', status: 'rejected', submitted_at: '2026-11-15T10:00:00Z' },
  ];
  const { open, done } = splitDeclarations(list);
  assert.deepEqual(open.map(d => d.id), ['c', 'b']);
  assert.deepEqual(done.map(d => d.id), ['d', 'a']);
  for (const status of Object.keys(DECLARATION_STATUS_LABELS)) {
    assert.ok(DECLARATION_STATUS_HINTS[status as keyof typeof DECLARATION_STATUS_HINTS], status);
  }
  assert.equal(declarationStatusLabel('paid'), 'Uitbetaald');
  assert.equal(declarationStatusLabel('onbekend'), 'onbekend');
});

test('Declaraties staat open voor wie schrijft maar Financiën niet beheert', () => {
  assert.equal(canSubmitDeclarations('member', 'none'), true);
  assert.equal(canSubmitDeclarations('member', 'read'), true);
  assert.equal(canSubmitDeclarations('member', 'write'), false, 'die maakt meteen een concept');
  assert.equal(canSubmitDeclarations('owner', 'write'), false);
  assert.equal(canSubmitDeclarations('viewer', 'read'), false, 'een viewer wijzigt nergens');
  assert.equal(canSubmitDeclarations('accountant', 'read'), false, 'de boekhouder is een gast');
  assert.equal(canSubmitDeclarations(null, 'none'), false);

  const employee = buildPermissions({ role: 'member', module_access: { finance: 'none' } });
  assert.equal(employee.canOpenPage(DECLARATIONS_PAGE), true);
  assert.equal(employee.canWritePage(DECLARATIONS_PAGE), true);
  assert.equal(employee.canOpenPage('purchase-invoices'), false);
  const bookkeeper = buildPermissions({ role: 'member', module_access: { finance: 'write' } });
  assert.equal(bookkeeper.canOpenPage(DECLARATIONS_PAGE), false);
  assert.equal(buildPermissions({ role: 'owner' }).canOpenPage(DECLARATIONS_PAGE), false);
  assert.equal(buildPermissions({ role: 'viewer' }).canOpenPage(DECLARATIONS_PAGE), false);
  assert.equal(buildPermissions({ role: 'accountant' }).canOpenPage(DECLARATIONS_PAGE), false);
});
