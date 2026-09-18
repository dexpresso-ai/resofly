import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countInboxAttention, describeAttachment, inboxActionsFor, inboxItemSummary, inboxNeedsAttention,
  inboxReasonLabel, invoiceInboxAddress, splitInboxItems,
} from './invoiceInbox.ts';

/**
 * De factuur-inbox is een werklijst: wat bovenaan staat, moet iemand doen. Deze
 * tests bewaken dat de indeling (aandacht / bezig / klaar) en de knoppen per
 * status niet stilletjes verschuiven — precies het soort fout dat een gebruiker
 * pas merkt als een dubbele factuur toch geboekt blijkt.
 */

const item = (over: Record<string, unknown>) => ({
  status: 'received', reason: null, purchase_invoice_id: null, duplicate_of_purchase_invoice_id: null, proposal: null,
  received_at: '2026-09-18T08:00:00Z', sender_name: null, sender_email: 'facturen@leverancier.nl', subject: 'Factuur 123',
  ...over,
} as never);

test('aandacht: alleen wat op een mens wacht', () => {
  assert.equal(inboxNeedsAttention(item({ status: 'needs_review' })), true);
  assert.equal(inboxNeedsAttention(item({ status: 'duplicate' })), true);
  assert.equal(inboxNeedsAttention(item({ status: 'failed' })), true);
  assert.equal(inboxNeedsAttention(item({ status: 'ready' })), false);
  assert.equal(inboxNeedsAttention(item({ status: 'processing' })), false);
  assert.equal(countInboxAttention([item({ status: 'failed' }), item({ status: 'booked' }), item({ status: 'duplicate' })]), 2);
});

test('splitsen: open (aandacht + bezig) boven, afgehandeld eronder, nieuwste eerst', () => {
  const rows = [
    item({ status: 'ready', received_at: '2026-09-18T09:00:00Z' }),
    item({ status: 'needs_review', received_at: '2026-09-17T09:00:00Z' }),
    item({ status: 'processing', received_at: '2026-09-18T10:00:00Z' }),
    item({ status: 'rejected', received_at: '2026-09-16T09:00:00Z' }),
  ];
  const { open, done } = splitInboxItems(rows);
  assert.deepEqual(open.map(r => (r as { status: string }).status), ['processing', 'needs_review']);
  assert.deepEqual(done.map(r => (r as { status: string }).status), ['ready', 'rejected']);
});

test('samenvatting: uit het voorstel, anders uit de afzender', () => {
  const withProposal = inboxItemSummary(item({
    proposal: { supplier: { name: 'Groothandel BV' }, supplier_invoice_number: 'F-2026-001', totals: { total_cents: 121000 }, extracted_totals: null },
  }));
  assert.equal(withProposal.title, 'Groothandel BV');
  assert.equal(withProposal.number, 'F-2026-001');
  assert.equal(withProposal.totalCents, 121000);
  assert.equal(withProposal.fallback, false);

  const bare = inboxItemSummary(item({ sender_name: 'Piet' }));
  assert.equal(bare.title, 'Piet');
  assert.equal(bare.totalCents, null);
  assert.equal(bare.fallback, true);
});

test('knoppen per status', () => {
  const proposal = { supplier: { name: 'X' }, supplier_invoice_number: '1', totals: { total_cents: 100 }, extracted_totals: null };
  assert.deepEqual(inboxActionsFor(item({ status: 'ready', purchase_invoice_id: 'pi-1' })),
    { open: true, prepare: false, forceDuplicate: false, retry: false, reject: false, restore: false });
  // Concept weg (trigger zet needs_review, maar ook een oude 'ready' zonder concept mag opnieuw).
  assert.equal(inboxActionsFor(item({ status: 'ready', purchase_invoice_id: null })).retry, true);
  assert.deepEqual(inboxActionsFor(item({ status: 'needs_review', reason: 'supplier_unknown', proposal })),
    { open: false, prepare: true, forceDuplicate: false, retry: false, reject: true, restore: false });
  assert.deepEqual(inboxActionsFor(item({ status: 'needs_review', reason: 'ai_unavailable' })),
    { open: false, prepare: false, forceDuplicate: false, retry: true, reject: true, restore: false });
  // Zoals een duplicaat er in het echt uitziet: applyCandidate maakt géén eigen
  // concept aan, dus purchase_invoice_id blijft leeg en de bestaande factuur
  // staat in duplicate_of_purchase_invoice_id. De knop "open" hoort dan juist
  // aan te staan — dat is de hele handeling die dit geval vraagt.
  assert.equal(
    inboxActionsFor(item({ status: 'duplicate', proposal, purchase_invoice_id: null, duplicate_of_purchase_invoice_id: 'pi-bestaand' })).open,
    true,
  );
  // Zonder enige verwijzing valt er niets te openen.
  assert.equal(inboxActionsFor(item({ status: 'duplicate', proposal })).open, false);
  assert.deepEqual(inboxActionsFor(item({ status: 'duplicate', proposal, purchase_invoice_id: 'pi-9' })),
    { open: true, prepare: false, forceDuplicate: true, retry: false, reject: true, restore: false });
  assert.deepEqual(inboxActionsFor(item({ status: 'failed' })),
    { open: false, prepare: false, forceDuplicate: false, retry: true, reject: true, restore: false });
  assert.deepEqual(inboxActionsFor(item({ status: 'rejected' })),
    { open: false, prepare: false, forceDuplicate: false, retry: false, reject: false, restore: true });
  assert.equal(inboxActionsFor(item({ status: 'processing' })).reject, false);
});

test('redenen en bijlagen in gewone taal', () => {
  assert.match(inboxReasonLabel('supplier_unknown') ?? '', /Leverancier niet herkend/);
  assert.equal(inboxReasonLabel('iets_nieuws'), 'iets_nieuws');
  assert.equal(inboxReasonLabel(null), null);
  const doc = describeAttachment({ name: 'factuur.pdf', mime_type: 'application/pdf', size_bytes: 10, storage_key: 'k', sha256: 'h', kind: 'document' });
  assert.deepEqual(doc, { label: 'factuur.pdf', downloadable: true, note: null });
  const big = describeAttachment({ name: 'scan.pdf', mime_type: 'application/pdf', size_bytes: 10, storage_key: null, sha256: null, kind: 'oversized' });
  assert.equal(big.downloadable, false);
  assert.equal(big.note, 'te groot');
});

test('het adres', () => {
  assert.equal(invoiceInboxAddress('facturen-jansen-abcdefghijklmnop'), 'facturen-jansen-abcdefghijklmnop@inbound.resofly.com');
  assert.equal(invoiceInboxAddress(null), '');
});
