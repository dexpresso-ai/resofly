/**
 * Tests voor e-facturatie via Mollie (mollieSalesInvoice.ts). Draaien met:  npm test
 *
 * De vorm van het verzoek volgt het SalesInvoiceRequest-model van Mollie
 * (POST /v2/sales-invoices): gehele aantallen, bedragen als tekst met twee
 * decimalen, btw-tarief als tekst, vaste betaaltermijnen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  amsterdamDate, buildMollieSalesInvoice, mollieAmountCents, mollieDate, mollieEmailBody, mollieFetchPolicy, molliePaymentStatus,
  molliePaymentTerm, mollieSalesInvoiceSettled, readMollieSalesInvoice, uuidFromHex, type MollieSalesInvoiceSource,
} from './mollieSalesInvoice.ts';

const VAT_KINDS = {
  HOOG: { kind: 'standard', rate: 21 },
  LAAG: { kind: 'reduced', rate: 9 },
  VERL: { kind: 'reverse_charge_sales', rate: 0 },
};

function source(over: Partial<MollieSalesInvoiceSource> = {}): MollieSalesInvoiceSource {
  return {
    invoice: {
      id: 'inv-1', number: '2026-041', notes: 'Bedankt!', currency: 'EUR',
      lines: [
        { description: 'Huisstijl', quantity: 1, unit_price: 2400, vat: 21, vat_code: 'HOOG' },
        { description: 'Drukwerk', quantity: 3, unit_price: 12.5, vat: 9, vat_code: 'LAAG' },
      ],
    },
    client: {
      id: 'c-1', name: 'Bakkerij De Korenaar BV', client_code: 'K-1001', client_kind: 'business',
      vat_number: 'NL 0012.34567.B01', kvk_number: '1234 5678',
      address_line1: 'Dorpsstraat 10', address_line2: null, postal_code: '3411 AB', city: 'Lopik', country: 'Nederland',
    },
    sellerCountry: 'NL',
    recipientEmail: 'Facturen@Korenaar.nl',
    issueDate: '2026-10-11',
    dueDate: '2026-10-25',
    vatKinds: VAT_KINDS,
    korEnabled: false,
    ...over,
  };
}

test('een gewone factuur wordt een e-factuurconcept met de velden die Mollie verwacht', () => {
  const { draft, errors } = buildMollieSalesInvoice(source());
  assert.deepEqual(errors, []);
  assert.ok(draft);
  assert.equal(draft.body.status, 'draft');
  assert.equal(draft.body.isEInvoice, true);
  assert.equal(draft.body.vatMode, 'exclusive');
  assert.equal(draft.body.paymentTerm, '14 days');
  assert.equal(draft.body.recipientIdentifier, 'K-1001');
  assert.deepEqual(draft.body.metadata, { resofly_invoice_id: 'inv-1', resofly_invoice_number: '2026-041' });
  assert.equal(draft.body.memo, 'Factuur 2026-041\nBedankt!');
  assert.deepEqual(draft.body.recipient, {
    type: 'business', organizationName: 'Bakkerij De Korenaar BV', organizationNumber: '12345678', vatNumber: 'NL001234567B01',
    email: 'facturen@korenaar.nl', streetAndNumber: 'Dorpsstraat 10', postalCode: '3411 AB', city: 'Lopik', country: 'NL', locale: 'nl_NL',
  });
  assert.deepEqual(draft.body.lines, [
    { description: 'Huisstijl', quantity: 1, vatRate: '21.00', unitPrice: { currency: 'EUR', value: '2400.00' } },
    { description: 'Drukwerk', quantity: 3, vatRate: '9.00', unitPrice: { currency: 'EUR', value: '12.50' } },
  ]);
  // 2400 + 504 btw + 37,50 + 3,38 btw (9% van 37,50 = 3,375 -> 3,38)
  assert.equal(draft.totalCents, 294488);
  assert.equal(draft.dueDate, '2026-10-25');
  assert.deepEqual(draft.warnings, []);
});

test('een gebroken aantal of een prijs met meer decimalen wordt één regel met het regeltotaal', () => {
  const { draft } = buildMollieSalesInvoice(source({ invoice: { ...source().invoice, lines: [
    { description: 'Advies', quantity: 2.5, unit_price: 85, vat: 21 },
    { description: 'Kilometers', quantity: 3, unit_price: 0.235, vat: 21 },
  ] } }));
  assert.ok(draft);
  assert.deepEqual(draft.body.lines, [
    { description: 'Advies (2,5 × € 85,00)', quantity: 1, vatRate: '21.00', unitPrice: { currency: 'EUR', value: '212.50' } },
    // 3 × 0,235 = 0,705 -> 0,71 (half naar boven, zoals ResoFly rekent)
    { description: 'Kilometers (3 × € 0,2350)', quantity: 1, vatRate: '21.00', unitPrice: { currency: 'EUR', value: '0.71' } },
  ]);
  // btw per tarief: (212,50 + 0,71) × 21% = 44,7741 -> 44,77
  assert.equal(draft.totalCents, 21321 + 4477);
});

test('Mollie kent alleen vaste termijnen: nooit korter dan afgesproken', () => {
  assert.deepEqual(molliePaymentTerm('2026-10-11', '2026-10-18'), { days: 7, requestedDays: 7 });
  assert.deepEqual(molliePaymentTerm('2026-10-11', '2026-11-01'), { days: 30, requestedDays: 21 });
  assert.deepEqual(molliePaymentTerm('2026-10-11', '2026-10-11'), { days: 7, requestedDays: 0 });
  assert.deepEqual(molliePaymentTerm('2026-10-11', '2027-06-01'), { days: 120, requestedDays: 233 });
  assert.deepEqual(molliePaymentTerm('2026-10-11', null), { days: 30, requestedDays: null });
  const { draft } = buildMollieSalesInvoice(source({ dueDate: '2026-11-01' }));
  assert.equal(draft?.body.paymentTerm, '30 days');
  assert.equal(draft?.dueDate, '2026-11-10');
  assert.match(draft?.warnings[0] ?? '', /30 dagen in plaats van 21/);
});

test('verlegde btw, kortingsregels en consumenten gaan niet via Mollie', () => {
  const reverse = buildMollieSalesInvoice(source({ invoice: { ...source().invoice, lines: [{ description: 'Montage', quantity: 1, unit_price: 500, vat: 0, vat_code: 'VERL' }] } }));
  assert.equal(reverse.draft, null);
  assert.match(reverse.errors[0], /verlegde btw/);
  const discount = buildMollieSalesInvoice(source({ invoice: { ...source().invoice, lines: [{ description: 'Korting', quantity: 1, unit_price: -50, vat: 21 }] } }));
  assert.match(discount.errors.join(' '), /negatief bedrag/);
  const consumer = buildMollieSalesInvoice(source({ client: { ...source().client, client_kind: 'consumer' } }));
  assert.match(consumer.errors.join(' '), /alleen naar een bedrijf/);
  // KOR: 0% wordt "vrijgesteld" en ook dat kan Mollie niet uitdrukken.
  const kor = buildMollieSalesInvoice(source({ korEnabled: true, invoice: { ...source().invoice, lines: [{ description: 'Les', quantity: 1, unit_price: 40, vat: 0 }] } }));
  assert.match(kor.errors.join(' '), /vrijgestelde btw/);
});

test('alleen tussen Nederland, België en Duitsland, met een nummer waarmee de klant op Peppol staat', () => {
  const french = buildMollieSalesInvoice(source({ client: { ...source().client, country: 'Frankrijk' } }));
  assert.match(french.errors.join(' '), /alleen naar klanten in Nederland, België of Duitsland \(deze klant: FR\)/);
  const noIds = buildMollieSalesInvoice(source({ client: { ...source().client, kvk_number: '', vat_number: '' } }));
  assert.match(noIds.errors.join(' '), /KVK-nummer \(of ondernemingsnummer\) of het btw-nummer/);
  const german = buildMollieSalesInvoice(source({ client: { ...source().client, country: 'DE', vat_number: '' } }));
  assert.match(german.errors.join(' '), /Duitse klant is het btw-nummer/);
  const seller = buildMollieSalesInvoice(source({ sellerCountry: 'Frankrijk' }));
  assert.match(seller.errors.join(' '), /alleen voor bedrijven in Nederland, België of Duitsland/);
  // Een leeg land bij de eigen organisatie telt als Nederland (zoals bij de UBL).
  assert.deepEqual(buildMollieSalesInvoice(source({ sellerCountry: '' })).errors, []);
});

test('een Belgische klant krijgt nl_BE en zijn ondernemingsnummer', () => {
  const { draft } = buildMollieSalesInvoice(source({ client: { ...source().client, country: 'België', kvk_number: '0123.456.789', vat_number: 'BE0123456789' } }));
  const recipient = draft?.body.recipient as Record<string, unknown>;
  assert.equal(recipient.country, 'BE');
  assert.equal(recipient.locale, 'nl_BE');
  assert.equal(recipient.organizationNumber, '0123456789');
});

test('bedragen van Mollie terug naar centen, en zijn antwoord naar wat ResoFly bewaart', () => {
  assert.equal(mollieAmountCents({ currency: 'EUR', value: '2944.88' }), 294488);
  assert.equal(mollieAmountCents({ currency: 'EUR', value: '12' }), 1200);
  assert.equal(mollieAmountCents({ value: 'twaalf' }), null);
  assert.equal(mollieAmountCents(null), null);
  const state = readMollieSalesInvoice({
    resource: 'sales-invoice', id: 'invoice_4Y0eZitmBnQ6IDoMqZQKh', invoiceNumber: 'INV-0000001', status: 'issued', eInvoiceStatus: 'issuing',
    totalAmount: { currency: 'EUR', value: '2944.88' }, issuedAt: '2026-10-11T09:12:44+00:00', dueAt: '2026-10-25', paidAt: null,
    _links: { pdfLink: { href: 'https://api.mollie.com/v2/sales-invoices/invoice_4Y0eZitmBnQ6IDoMqZQKh/pdf', type: 'application/pdf' }, invoicePayment: { href: 'https://www.mollie.com/checkout/select-method/abc', type: 'text/html' } },
  });
  assert.deepEqual(state, {
    id: 'invoice_4Y0eZitmBnQ6IDoMqZQKh', invoiceNumber: 'INV-0000001', status: 'issued', eInvoiceStatus: 'issuing', totalCents: 294488,
    issuedAt: '2026-10-11T09:12:44+00:00', dueAt: '2026-10-25', paidAt: null,
    pdfUrl: 'https://api.mollie.com/v2/sales-invoices/invoice_4Y0eZitmBnQ6IDoMqZQKh/pdf', paymentUrl: 'https://www.mollie.com/checkout/select-method/abc',
  });
  assert.equal(readMollieSalesInvoice({ id: 'x', eInvoiceStatus: 'vreemd', _links: { pdfLink: { href: 'http://onveilig' } } }).pdfUrl, null);
});

test('de Mollie-sleutel gaat alleen mee naar de API van Mollie zelf', () => {
  assert.equal(mollieFetchPolicy('https://api.mollie.com/v2/sales-invoices/x/pdf'), 'with-key');
  assert.equal(mollieFetchPolicy('https://files.mollie.com/invoices/x.pdf'), 'without-key');
  assert.equal(mollieFetchPolicy('https://api.mollie.com.evil.example/x'), 'refuse');
  assert.equal(mollieFetchPolicy('http://api.mollie.com/x'), 'refuse');
  assert.equal(mollieFetchPolicy(null), 'refuse');
});

test('datums van Mollie op Nederlandse tijd, ook rond middernacht', () => {
  assert.equal(mollieDate('2026-10-25'), '2026-10-25');
  // 23:30 UTC op 10 oktober is in Nederland al 11 oktober (zomertijd, UTC+2).
  assert.equal(mollieDate('2026-10-10T23:30:00+00:00'), '2026-10-11');
  assert.equal(mollieDate('geen datum'), null);
  assert.equal(mollieDate(null), null);
  // Wintertijd (UTC+1): 22:59 UTC op 1 december is nog 1 december.
  assert.equal(amsterdamDate(new Date('2026-12-01T22:59:00Z')), '2026-12-01');
});

test('de status bij Mollie bepaalt de betaalregel; alles daartussen laat hem staan', () => {
  assert.equal(molliePaymentStatus('paid'), 'paid');
  assert.equal(molliePaymentStatus('cancelled'), 'canceled');
  assert.equal(molliePaymentStatus('expired'), 'expired');
  assert.equal(molliePaymentStatus('issued'), null);
  assert.equal(molliePaymentStatus('overdue'), null);
  assert.equal(molliePaymentStatus('payment_reversed'), null);
  assert.equal(mollieSalesInvoiceSettled('paid'), true);
  assert.equal(mollieSalesInvoiceSettled('pending-payment'), false);
});

test('een vaste Idempotency-Key in UUID v4-vorm', () => {
  const hex = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  assert.match(uuidFromHex(hex), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(uuidFromHex('0123456789abcdef0123456789abcdef'), '01234567-89ab-4def-8123-456789abcdef');
  assert.equal(uuidFromHex(hex), uuidFromHex(hex));
});

test('de mail van Mollie noemt het ResoFly-nummer en Peppol', () => {
  const body = mollieEmailBody({ recipientName: 'Anna', invoiceNumber: '2026-041', companyName: 'Studio Lopik', totalLabel: '€ 2.944,88' });
  assert.match(body, /^Beste Anna,\n\nHierbij ontvang je factuur 2026-041 van Studio Lopik \(€ 2\.944,88\)\./);
  assert.match(body, /Peppol/);
  assert.match(mollieEmailBody({ invoiceNumber: '1', companyName: 'X', totalLabel: '€ 1,00' }), /^Beste klant,/);
});
