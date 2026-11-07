import test from 'node:test';
import assert from 'node:assert/strict';
import { clientEInvoiceChannel, clientWantsEInvoice, effectiveInvoiceSendMethod, eInvoiceReadiness, invoiceRecipientFor, latestEInvoiceDelivery, mollieCollecting, mollieInvoicingAllowed, mollieNeedsSync, molliePartialNote, mollieStatusLabel, peppolStatusLabel } from './eInvoicing.ts';
import { effectiveInvoiceSendMethod as serverEffectiveSendMethod, mollieInvoicingAllowed as serverMollieAllowed } from '../../supabase/functions/_shared/eInvoicing.ts';
import type { InvoiceEmailDelivery } from '../types.ts';

/**
 * Tests voor de e-factuurregels in de browser: welk adres het verzendvenster
 * voorstelt, en wat het klantformulier als ontbrekend meldt. Ze spiegelen de
 * server (supabase/functions/_shared/eInvoicing.ts en de UBL-validatie).
 */

const nlClient = {
  name: 'Klant BV', email: 'info@klant.nl', e_invoice_email: '', client_kind: 'business',
  address_line1: 'Dorpsstraat 2', postal_code: '3511 AA', city: 'Utrecht', country: 'Nederland',
  kvk_number: '87654321', vat_number: 'NL009876543B01',
};

test('alleen met e-facturatie aan gaat de factuur naar het e-factuuradres', () => {
  assert.equal(clientWantsEInvoice({ email: 'info@klant.nl', e_invoicing_enabled: true }), true);
  assert.equal(clientWantsEInvoice({ email: 'info@klant.nl' }), false);
  assert.equal(clientWantsEInvoice(null), false);
  assert.equal(invoiceRecipientFor({ email: 'info@klant.nl', e_invoicing_enabled: true, e_invoice_email: 'facturen@klant.nl' }), 'facturen@klant.nl');
  assert.equal(invoiceRecipientFor({ email: 'info@klant.nl', e_invoicing_enabled: true, e_invoice_email: ' ' }), 'info@klant.nl');
  assert.equal(invoiceRecipientFor({ email: 'info@klant.nl', e_invoicing_enabled: false, e_invoice_email: 'facturen@klant.nl' }), 'info@klant.nl');
});

test('een complete Nederlandse zakelijke klant mist niets', () => {
  assert.deepEqual(eInvoiceReadiness(nlClient), { missing: [], advice: [] });
});

test('bij een Nederlandse klant blokkeert een onvolledig adres', () => {
  const { missing } = eInvoiceReadiness({ ...nlClient, address_line1: '', city: ' ' });
  assert.deepEqual(missing, ['adres', 'plaats']);
});

test('zonder land of adres om naartoe te sturen gaat het niet', () => {
  const { missing } = eInvoiceReadiness({ ...nlClient, country: '', email: '', e_invoice_email: 'geen-adres' });
  assert.deepEqual(missing, ['een e-factuuradres of e-mailadres', 'land']);
});

test('zonder KVK-nummer kan het wel, maar niet via Peppol', () => {
  const { missing, advice } = eInvoiceReadiness({ ...nlClient, kvk_number: '' });
  assert.deepEqual(missing, []);
  assert.equal(advice.length, 1);
  assert.match(advice[0], /KVK-nummer/);
  // Een consument krijgt die opmerking niet.
  assert.deepEqual(eInvoiceReadiness({ ...nlClient, kvk_number: '', client_kind: 'consumer' }).advice, []);
});

test('een buitenlandse klant heeft een btw- of ondernemingsnummer nodig voor Peppol, geen Nederlands adres', () => {
  const belgian = { ...nlClient, country: 'België', address_line1: '', postal_code: '', city: '', kvk_number: '', vat_number: 'BE0123456789' };
  assert.deepEqual(eInvoiceReadiness(belgian), { missing: [], advice: [] });
  assert.match(eInvoiceReadiness({ ...belgian, vat_number: '' }).advice[0], /btw- of ondernemingsnummer/);
});

test('de laatste e-factuurverzending, niet een mislukte of een gewone mail', () => {
  const delivery = (over: Partial<InvoiceEmailDelivery>) => ({ id: 'd', invoice_id: 'i1', status: 'sent', delivery_channel: 'email', ...over }) as InvoiceEmailDelivery;
  const list = [
    delivery({ id: 'd3', delivery_channel: 'e_invoice_email', status: 'failed' }),
    delivery({ id: 'd2', delivery_channel: 'e_invoice_email', status: 'delivered' }),
    delivery({ id: 'd1' }),
  ];
  assert.equal(latestEInvoiceDelivery(list, 'i1')?.id, 'd2');
  assert.equal(latestEInvoiceDelivery([delivery({ id: 'd1' })], 'i1'), null);
  assert.equal(latestEInvoiceDelivery(list, 'i2'), null);
});

test('het kanaal: via Mollie alleen met e-facturatie aan en Mollie gekozen', () => {
  assert.equal(clientEInvoiceChannel({ email: 'a@b.nl', e_invoicing_enabled: true, e_invoice_channel: 'mollie' }), 'mollie');
  assert.equal(clientEInvoiceChannel({ email: 'a@b.nl', e_invoicing_enabled: true, e_invoice_channel: null }), 'email');
  assert.equal(clientEInvoiceChannel({ email: 'a@b.nl', e_invoicing_enabled: false, e_invoice_channel: 'mollie' }), null);
  // Een onbekende waarde gaat per mail, net als op de server.
  assert.equal(clientEInvoiceChannel({ email: 'a@b.nl', e_invoicing_enabled: true, e_invoice_channel: 'peppol' }), 'email');
});

test('verstuurt de organisatie per e-mail, dan gaat ook een klant op "via Mollie" per mail', () => {
  const viaMollie = { email: 'a@b.nl', e_invoicing_enabled: true, e_invoice_channel: 'mollie' };
  assert.equal(clientEInvoiceChannel(viaMollie, mollieInvoicingAllowed('email')), 'email');
  assert.equal(clientEInvoiceChannel(viaMollie, mollieInvoicingAllowed('mollie')), 'mollie');
  assert.equal(clientEInvoiceChannel(viaMollie, mollieInvoicingAllowed(null)), 'mollie');
  // Zonder e-facturatie blijft het geen e-factuur.
  assert.equal(clientEInvoiceChannel({ email: 'a@b.nl' }, false), null);
});

test('de verzendwijze in de browser zegt hetzelfde als op de server', () => {
  for (const stored of ['email', 'mollie', null, undefined, 'peppol', '']) {
    assert.equal(mollieInvoicingAllowed(stored), serverMollieAllowed(stored), `mag Mollie meedoen bij ${String(stored)}`);
    for (const connected of [true, false]) {
      assert.equal(effectiveInvoiceSendMethod(stored, connected), serverEffectiveSendMethod(stored, connected), `geldt bij ${String(stored)}, gekoppeld ${connected}`);
    }
  }
  // Nog niets gekozen: Mollie gekoppeld is via Mollie, anders per e-mail.
  assert.equal(effectiveInvoiceSendMethod(null, true), 'mollie');
  assert.equal(effectiveInvoiceSendMethod(null, false), 'email');
  assert.equal(effectiveInvoiceSendMethod('email', true), 'email');
});

test('via Mollie: alleen bedrijven in NL, BE of DE, met adres en Peppol-nummer', () => {
  assert.deepEqual(eInvoiceReadiness({ ...nlClient, channel: 'mollie' }), { missing: [], advice: [] });
  const belgian = { ...nlClient, country: 'België', kvk_number: '', vat_number: 'BE0123456789', channel: 'mollie' as const };
  assert.deepEqual(eInvoiceReadiness(belgian).missing, []);
  // Anders dan per mail is een Belgisch adres via Mollie wel nodig.
  assert.match(eInvoiceReadiness({ ...belgian, city: '' }).missing.join(), /plaats/);
  assert.match(eInvoiceReadiness({ ...nlClient, channel: 'mollie', country: 'Frankrijk' }).missing.join(), /Nederland, België of Duitsland \(niet Frankrijk\)/);
  assert.match(eInvoiceReadiness({ ...nlClient, channel: 'mollie', client_kind: 'consumer' }).missing.join(), /zakelijke klant/);
  assert.match(eInvoiceReadiness({ ...nlClient, channel: 'mollie', kvk_number: '', vat_number: '' }).missing.join(), /KVK-nummer/);
  assert.match(eInvoiceReadiness({ ...nlClient, channel: 'mollie', country: 'Duitsland', vat_number: '' }).missing.join(), /USt-IdNr/);
});

test('een verzending via Mollie telt als e-factuur, en de stand wordt niet te vaak opgehaald', () => {
  const delivery = (over: Partial<InvoiceEmailDelivery>) => ({ id: 'd', invoice_id: 'i1', status: 'sent', delivery_channel: 'e_invoice_mollie', ...over }) as InvoiceEmailDelivery;
  assert.equal(latestEInvoiceDelivery([delivery({ id: 'm1' })], 'i1')?.id, 'm1');
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(mollieNeedsSync(delivery({ external_synced_at: null }), now), true);
  assert.equal(mollieNeedsSync(delivery({ external_synced_at: '2026-10-11T11:55:00Z' }), now), false);
  assert.equal(mollieNeedsSync(delivery({ external_synced_at: '2026-10-11T11:40:00Z' }), now), true);
  // Betaald en afgeleverd: er verandert niets meer.
  assert.equal(mollieNeedsSync(delivery({ external_status: 'paid', e_invoice_status: 'issued', external_synced_at: null }), now), false);
  // Betaald, maar Peppol nog bezig: wel kijken.
  assert.equal(mollieNeedsSync(delivery({ external_status: 'paid', e_invoice_status: 'issuing', external_synced_at: null }), now), true);
  assert.equal(mollieNeedsSync(delivery({ delivery_channel: 'e_invoice_email' }), now), false);
  assert.equal(mollieNeedsSync(delivery({ status: 'failed' }), now), false);
  assert.equal(mollieStatusLabel('pending-payment'), 'betaling loopt');
  assert.equal(peppolStatusLabel('failed'), 'mislukt');
  assert.equal(peppolStatusLabel(null), 'nog onbekend');
});

test('Mollie bij een deelbetaling: alleen een link zolang Mollie int, en de laatste melding', () => {
  assert.equal(mollieCollecting('issued'), true);
  assert.equal(mollieCollecting('overdue'), true);
  assert.equal(mollieCollecting('paid'), false);
  assert.equal(mollieCollecting('pending-payment'), false);
  assert.equal(mollieCollecting(null), false);
  // Mollie schrijft 'payment-reversed' (met een streepje).
  assert.equal(mollieStatusLabel('payment-reversed'), 'betaling teruggedraaid');
  const partial = { event_type: 'e_invoice_partial', description: 'Er staat nog € 600,00 open.', created_at: '2026-11-06T10:00:00Z' };
  assert.equal(molliePartialNote([partial]), 'Er staat nog € 600,00 open.');
  // Daarna bij Mollie op betaald gezet, of nog een betaling: de melding geldt niet meer.
  assert.equal(molliePartialNote([partial, { event_type: 'e_invoice_settled', created_at: '2026-11-06T11:00:00Z' }]), null);
  assert.equal(molliePartialNote([{ event_type: 'payment_paid', created_at: '2026-11-06T11:00:00Z' }, partial]), null);
  // Andere gebeurtenissen tellen niet mee.
  assert.equal(molliePartialNote([partial, { event_type: 'email_opened', created_at: '2026-11-06T12:00:00Z' }]), 'Er staat nog € 600,00 open.');
  assert.equal(molliePartialNote([]), null);
});
