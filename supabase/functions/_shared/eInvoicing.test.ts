/**
 * Tests voor de regels van e-facturatie per klant (eInvoicing.ts). Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clientWantsEInvoice, defaultInvoiceRecipient, effectiveInvoiceSendMethod, embeddedPdf, invoiceDeliveryChannel, mollieInvoicingAllowed,
  storedInvoiceSendMethod,
} from './eInvoicing.ts';

const client = (over: Record<string, unknown> = {}) => ({
  email: 'Info@Klant.nl', e_invoicing_enabled: false, e_invoice_email: null, ...over,
});

test('alleen een klant met e-facturatie AAN krijgt een e-factuur', () => {
  assert.equal(clientWantsEInvoice(client({ e_invoicing_enabled: true })), true);
  assert.equal(clientWantsEInvoice(client()), false);
  // Een klantrij van vóór de migratie heeft de kolom nog niet.
  assert.equal(clientWantsEInvoice({ email: 'info@klant.nl' }), false);
  assert.equal(invoiceDeliveryChannel(client({ e_invoicing_enabled: true })), 'e_invoice_email');
  assert.equal(invoiceDeliveryChannel(client()), 'email');
});

test('via Mollie alleen als e-facturatie aan staat én Mollie gekozen is', () => {
  assert.equal(invoiceDeliveryChannel(client({ e_invoicing_enabled: true, e_invoice_channel: 'mollie' })), 'e_invoice_mollie');
  assert.equal(invoiceDeliveryChannel(client({ e_invoicing_enabled: true, e_invoice_channel: 'email' })), 'e_invoice_email');
  // Uit is uit, ook als er nog een kanaal bij staat.
  assert.equal(invoiceDeliveryChannel(client({ e_invoicing_enabled: false, e_invoice_channel: 'mollie' })), 'email');
  // Een onbekende waarde valt terug op de mail, niet op Mollie.
  assert.equal(invoiceDeliveryChannel(client({ e_invoicing_enabled: true, e_invoice_channel: 'peppol' })), 'e_invoice_email');
});

test('verstuurt de organisatie per e-mail, dan gaat een klant op "via Mollie" als e-factuur per mail', () => {
  const viaMollie = client({ e_invoicing_enabled: true, e_invoice_channel: 'mollie' });
  assert.equal(invoiceDeliveryChannel(viaMollie, { mollieAllowed: false }), 'e_invoice_email');
  assert.equal(invoiceDeliveryChannel(viaMollie, { mollieAllowed: true }), 'e_invoice_mollie');
  // Zonder e-facturatie blijft het de PDF, met of zonder Mollie.
  assert.equal(invoiceDeliveryChannel(client(), { mollieAllowed: false }), 'email');
  assert.equal(invoiceDeliveryChannel(client({ e_invoicing_enabled: true, e_invoice_channel: 'email' }), { mollieAllowed: false }), 'e_invoice_email');
});

test('de verzendwijze: alleen "per e-mail" zet Mollie uit', () => {
  assert.equal(mollieInvoicingAllowed('email'), false);
  assert.equal(mollieInvoicingAllowed('mollie'), true);
  // Nog niets gekozen (of een kolom van vóór de migratie): zoals het was.
  assert.equal(mollieInvoicingAllowed(null), true);
  assert.equal(mollieInvoicingAllowed(undefined), true);
  // Een waarde die we niet kennen telt als niet gekozen, niet als "per e-mail".
  assert.equal(storedInvoiceSendMethod('peppol'), null);
  assert.equal(storedInvoiceSendMethod(' email '), null);
  assert.equal(storedInvoiceSendMethod('email'), 'email');
});

test('wat er geldt als nog niemand koos: via Mollie zodra Mollie gekoppeld is', () => {
  assert.equal(effectiveInvoiceSendMethod(null, true), 'mollie');
  assert.equal(effectiveInvoiceSendMethod(null, false), 'email');
  // Een keuze gaat voor de koppeling.
  assert.equal(effectiveInvoiceSendMethod('email', true), 'email');
  assert.equal(effectiveInvoiceSendMethod('mollie', false), 'mollie');
});

test('e-facturatie gaat naar het e-factuuradres, anders naar het gewone adres', () => {
  assert.equal(defaultInvoiceRecipient(client({ e_invoicing_enabled: true, e_invoice_email: ' Facturen@Klant.nl ' })), 'facturen@klant.nl');
  assert.equal(defaultInvoiceRecipient(client({ e_invoicing_enabled: true, e_invoice_email: '' })), 'info@klant.nl');
  // Staat e-facturatie uit, dan telt het e-factuuradres niet mee.
  assert.equal(defaultInvoiceRecipient(client({ e_invoice_email: 'facturen@klant.nl' })), 'info@klant.nl');
  assert.equal(defaultInvoiceRecipient({ email: null }), '');
});

test('een zelf gekozen adres gaat altijd voor', () => {
  assert.equal(defaultInvoiceRecipient(client({ e_invoicing_enabled: true, e_invoice_email: 'facturen@klant.nl' }), ' Boekhouding@Klant.nl'), 'boekhouding@klant.nl');
  assert.equal(defaultInvoiceRecipient(client({ e_invoicing_enabled: true, e_invoice_email: 'facturen@klant.nl' }), '   '), 'facturen@klant.nl');
  assert.equal(defaultInvoiceRecipient(client(), 42), 'info@klant.nl');
});

test('de PDF als bijlage van de e-factuur', () => {
  assert.deepEqual(embeddedPdf({ reference: '2026-014', label: 'Factuur 2026-014', fileName: 'factuur-2026-014.pdf', base64: 'JVBERi0xLjQK' }), {
    id: '2026-014',
    description: 'Factuur 2026-014 (PDF)',
    fileName: 'factuur-2026-014.pdf',
    mimeCode: 'application/pdf',
    base64: 'JVBERi0xLjQK',
  });
});
