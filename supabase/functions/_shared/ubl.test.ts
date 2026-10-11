/**
 * Tests voor de UBL-bouwer en -validator (ubl.ts). Draaien met:  npm test
 *
 * Wat hier vastligt is wat de ontvanger van een e-factuur ziet: dat de PDF er
 * als ingesloten bijlage in zit (BT-122..BT-125) op de plek waar het UBL-schema
 * hem verwacht, en dat de koper een elektronisch adres heeft (BT-49) — ook als
 * er geen KVK-nummer is. De verwachte schema-codes komen uit de Peppol-codelijst
 * (EAS): 0106 KVK, 0190 OIN, 9944 NL-btw, 0208 Belgisch ondernemingsnummer,
 * EM e-mail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUblXml, derivePeppolEndpoint, validateUblInput, type UblDocumentInput } from './ubl.ts';

/** "%PDF-1.4\n" als base64 — genoeg om de bijlage te herkennen. */
const PDF_BASE64 = 'JVBERi0xLjQK';

function invoiceInput(over: Partial<UblDocumentInput> = {}): UblDocumentInput {
  return {
    docType: 'invoice',
    number: '2026-014',
    issueDate: '2026-10-10',
    dueDate: '2026-10-24',
    currency: 'EUR',
    buyerReference: 'K-0042',
    paymentReference: '2026-014',
    sellerIban: 'NL91ABNA0417164300',
    seller: {
      name: 'Studio Voorbeeld BV', vatNumber: 'NL001234567B01', kvkNumber: '12345678', country: 'Nederland',
      addressLine1: 'Keizersgracht 1', postalCode: '1015 AA', city: 'Amsterdam', email: 'facturen@studio.nl',
    },
    buyer: {
      name: 'Klant BV', vatNumber: 'NL009876543B01', kvkNumber: '87654321', country: 'NL',
      addressLine1: 'Dorpsstraat 2', postalCode: '3511 AA', city: 'Utrecht', email: 'info@klant.nl',
    },
    lines: [{ description: 'Ontwerp', quantity: 2, unitPrice: 100, vatRate: 21, category: 'S' }],
    ...over,
  };
}

const pdfAttachment = {
  id: '2026-014',
  description: 'Factuur 2026-014 (PDF)',
  fileName: 'factuur-2026-014.pdf',
  mimeCode: 'application/pdf',
  base64: PDF_BASE64,
};

/** Het blok van één partij uit de XML, om er gericht in te zoeken. */
function partyBlock(xml: string, role: 'AccountingSupplierParty' | 'AccountingCustomerParty'): string {
  const start = xml.indexOf(`<cac:${role}>`);
  const end = xml.indexOf(`</cac:${role}>`);
  assert.ok(start >= 0 && end > start, `${role} niet gevonden`);
  return xml.slice(start, end);
}

test('zonder bijlagen geen AdditionalDocumentReference', () => {
  const xml = buildUblXml(invoiceInput());
  assert.equal(xml.includes('AdditionalDocumentReference'), false);
});

test('de PDF zit als ingesloten bijlage in de factuur', () => {
  const input = invoiceInput({ attachments: [pdfAttachment] });
  assert.deepEqual(validateUblInput(input).errors, []);
  const xml = buildUblXml(input);
  assert.ok(xml.includes(
    '<cac:AdditionalDocumentReference><cbc:ID>2026-014</cbc:ID><cbc:DocumentDescription>Factuur 2026-014 (PDF)</cbc:DocumentDescription>'
    + `<cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="factuur-2026-014.pdf">${PDF_BASE64}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>`
    + '</cac:AdditionalDocumentReference>',
  ), xml);
  // Geen DocumentTypeCode: 130 betekent in Peppol "gefactureerd object".
  assert.equal(xml.includes('DocumentTypeCode'), false);
});

test('in een factuur staat de bijlage na BuyerReference en vóór de partijen', () => {
  const xml = buildUblXml(invoiceInput({ attachments: [pdfAttachment] }));
  const buyerRef = xml.indexOf('<cbc:BuyerReference>');
  const attachment = xml.indexOf('<cac:AdditionalDocumentReference>');
  const supplier = xml.indexOf('<cac:AccountingSupplierParty>');
  assert.ok(buyerRef >= 0 && buyerRef < attachment && attachment < supplier);
});

test('in een creditnota staat de bijlage na BillingReference en vóór de partijen', () => {
  const xml = buildUblXml(invoiceInput({
    docType: 'creditNote', number: 'CN-2026-003', originalInvoiceNumber: '2026-014', originalInvoiceDate: '2026-10-10',
    attachments: [{ ...pdfAttachment, id: 'CN-2026-003', fileName: 'creditfactuur-CN-2026-003.pdf' }],
  }));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><CreditNote '));
  const billing = xml.indexOf('<cac:BillingReference>');
  const attachment = xml.indexOf('<cac:AdditionalDocumentReference>');
  const supplier = xml.indexOf('<cac:AccountingSupplierParty>');
  assert.ok(billing >= 0 && billing < attachment && attachment < supplier);
});

test('base64 met regeleinden wordt aaneengesloten, een bestandsnaam ge-escaped', () => {
  const xml = buildUblXml(invoiceInput({
    attachments: [{ ...pdfAttachment, base64: 'JVBE\nRi0x\r\nLjQK', fileName: 'factuur R&D "1".pdf' }],
  }));
  assert.ok(xml.includes(`filename="factuur R&amp;D &quot;1&quot;.pdf">${PDF_BASE64}<`));
});

test('een bijlage zonder naam, van een verkeerd type of zonder inhoud blokkeert', () => {
  const errors = (attachment: Partial<typeof pdfAttachment>) =>
    validateUblInput(invoiceInput({ attachments: [{ ...pdfAttachment, ...attachment }] })).errors;
  assert.equal(errors({ fileName: '' }).length, 1);
  assert.match(errors({ mimeCode: 'application/zip' })[0], /type \(application\/zip\)/);
  assert.match(errors({ base64: '' })[0], /geen geldige base64/);
  assert.match(errors({ base64: 'dit is geen base64!' })[0], /geen geldige base64/);
  assert.match(errors({ id: ' ' })[0], /referentie \(BT-122\)/);
});

test('Peppol-ID: KVK 0106, OIN 0190, NL-btw 9944', () => {
  assert.deepEqual(derivePeppolEndpoint({ kvkNumber: '8765 4321', vatNumber: null, country: 'NL' }), { schemeId: '0106', value: '87654321' });
  assert.deepEqual(derivePeppolEndpoint({ kvkNumber: '00000001234567890000', vatNumber: null, country: 'NL' }), { schemeId: '0190', value: '00000001234567890000' });
  assert.deepEqual(derivePeppolEndpoint({ kvkNumber: null, vatNumber: 'NL 0098.76543.B01', country: 'NL' }), { schemeId: '9944', value: 'NL009876543B01' });
});

test('Peppol-ID: Belgische klant via het ondernemingsnummer (0208)', () => {
  assert.deepEqual(derivePeppolEndpoint({ kvkNumber: null, vatNumber: 'BE 0123.456.789', country: 'België' }), { schemeId: '0208', value: '0123456789' });
  // Oud btw-nummer met negen cijfers: het ondernemingsnummer krijgt een voorloopnul.
  assert.deepEqual(derivePeppolEndpoint({ kvkNumber: null, vatNumber: 'BE123456789', country: 'BE' }), { schemeId: '0208', value: '0123456789' });
  // Het KBO-nummer in het KVK-veld van een Belgische klant is geen KVK-nummer.
  assert.deepEqual(derivePeppolEndpoint({ kvkNumber: '0123.456.789', vatNumber: null, country: 'Belgium' }), { schemeId: '0208', value: '0123456789' });
  assert.equal(derivePeppolEndpoint({ kvkNumber: null, vatNumber: null, country: 'BE' }), null);
});

test('de koper krijgt het Peppol-ID als EndpointID, en de KBO het schema 0208', () => {
  const nl = partyBlock(buildUblXml(invoiceInput()), 'AccountingCustomerParty');
  assert.ok(nl.includes('<cbc:EndpointID schemeID="0106">87654321</cbc:EndpointID>'));

  const be = partyBlock(buildUblXml(invoiceInput({
    buyer: { name: 'Klant NV', kvkNumber: '0123456789', vatNumber: 'BE0123456789', country: 'België', addressLine1: 'Grote Markt 1', postalCode: '1000', city: 'Brussel' },
  })), 'AccountingCustomerParty');
  assert.ok(be.includes('<cbc:EndpointID schemeID="0208">0123456789</cbc:EndpointID>'));
  assert.ok(be.includes('<cbc:CompanyID schemeID="0208">0123456789</cbc:CompanyID>'));
});

test('zonder Peppol-ID wordt het e-factuuradres het elektronisch adres (EM)', () => {
  const input = invoiceInput({
    buyer: { name: 'Klant GmbH', country: 'DE', addressLine1: 'Hauptstraße 3', postalCode: '10115', city: 'Berlin', email: 'info@klant.de', endpointEmail: 'Rechnungen@Klant.de' },
  });
  const buyer = partyBlock(buildUblXml(input), 'AccountingCustomerParty');
  assert.ok(buyer.includes('<cbc:EndpointID schemeID="EM">rechnungen@klant.de</cbc:EndpointID>'));
  // Per e-mail kan hij er dus heen, maar via Peppol nog niet: dat blijft gemeld.
  assert.ok(validateUblInput(input).warnings.some((warning) => warning.includes('geen Peppol-ID')));
});

test('zonder Peppol-ID en zonder adres geen EndpointID bij de koper', () => {
  const input = invoiceInput({
    buyer: { name: 'Klant GmbH', country: 'DE', addressLine1: 'Hauptstraße 3', postalCode: '10115', city: 'Berlin', endpointEmail: 'geen-adres' },
  });
  const buyer = partyBlock(buildUblXml(input), 'AccountingCustomerParty');
  assert.equal(buyer.includes('EndpointID'), false);
});

test('de verkoper houdt zijn KVK als EndpointID', () => {
  const supplier = partyBlock(buildUblXml(invoiceInput({ attachments: [pdfAttachment] })), 'AccountingSupplierParty');
  assert.ok(supplier.includes('<cbc:EndpointID schemeID="0106">12345678</cbc:EndpointID>'));
});
