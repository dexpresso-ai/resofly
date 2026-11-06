import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financeLineGross, financeTotals } from './financeTotals.ts';
import { computeTotals, lineGross } from '../../../src/lib/money.ts';

test('offerte met twee tarieven: dezelfde cent als de factuur (€ 173,63, niet € 173,62)', () => {
  const lines = [
    { quantity: 1, unit_price: 102.5, vat: 21 },
    { quantity: 1, unit_price: 45.5, vat: 9 },
  ];
  const totals = financeTotals(lines);
  assert.equal(totals.totalCents, 17363);
  assert.equal(totals.vat, 25.63);
  assert.deepEqual(totals.vatBreakdown, [
    { rate: 9, base: 45.5, vat: 4.1 },
    { rate: 21, base: 102.5, vat: 21.53 },
  ]);
});

test('kleine bedragen: btw per tarief, niet per regel (€ 0,30 en niet € 0,31)', () => {
  const totals = financeTotals([
    { quantity: 1, unit_price: 1.02, vat: 21 },
    { quantity: 1, unit_price: 1.05, vat: 9 },
  ]);
  assert.equal(totals.vat, 0.3);
  assert.equal(totals.total, 2.37);
});

test('lege of onleesbare regels tellen als 0, geen NaN', () => {
  const totals = financeTotals([{ quantity: 'x', unit_price: null, vat: undefined }, {}]);
  assert.deepEqual([totals.subtotal, totals.vat, totals.total, totals.totalCents], [0, 0, 0, 0]);
  assert.equal(financeTotals(undefined as unknown as []).totalCents, 0);
});

test('gelijk aan de app (src/lib/money.ts) over duizend willekeurige offertes', () => {
  let seed = 20261105;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const rates = [0, 9, 21];
  for (let i = 0; i < 1000; i++) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
      quantity: Math.round(random() * 2000) / 100 - (random() < 0.1 ? 5 : 0),
      unit_price: Math.round(random() * 100000) / 1000,
      vat: rates[Math.floor(random() * rates.length)],
    }));
    const app = computeTotals(lines);
    const edge = financeTotals(lines);
    assert.equal(edge.totalCents, app.totalCents, JSON.stringify(lines));
    assert.equal(edge.subtotal, app.subtotal);
    assert.equal(edge.vat, app.vat);
    assert.deepEqual(edge.vatBreakdown, app.vatBreakdown);
    for (const line of lines) assert.equal(financeLineGross(line), lineGross(line));
  }
});

test('mails noemen hetzelfde totaal als de PDF en de betaallink', async () => {
  const { renderInvoiceSentEmail } = await import('./emailTemplates/invoiceSent.ts');
  const { renderQuoteSentEmail } = await import('./emailTemplates/quoteSent.ts');
  const { renderInvoiceReminderEmail } = await import('./emailTemplates/invoiceReminder.ts');
  const lines = [
    { description: 'Fotografie', quantity: 1, unit_price: 102.5, vat: 21 },
    { description: 'Fotoboek', quantity: 1, unit_price: 45.5, vat: 9 },
  ];
  const client = { name: 'Klant BV' };
  const invoiceMail = renderInvoiceSentEmail({ invoice: { number: 'FAC-2026-0001', due_date: '2026-12-01', lines }, client, publicUrl: 'https://example.com/invoice/x' } as Parameters<typeof renderInvoiceSentEmail>[0]);
  assert.match(invoiceMail.text, /173,63/);
  assert.doesNotMatch(invoiceMail.text, /173,62/);
  const quoteMail = renderQuoteSentEmail({ quote: { number: 'OFF-2026-0001', valid_until: '2026-12-01', lines }, client, publicUrl: 'https://example.com/quote/x', expiresAt: '2026-12-01' } as unknown as Parameters<typeof renderQuoteSentEmail>[0]);
  assert.match(quoteMail.text, /173,63/);
  // Er staat precies het factuurbedrag open: dus geen "deels betaald".
  const reminder = renderInvoiceReminderEmail({ level: 1, invoice: { number: 'FAC-2026-0001', due_date: '2026-10-01', lines }, client, publicUrl: 'https://example.com/invoice/x', openAmountCents: 17363 } as Parameters<typeof renderInvoiceReminderEmail>[0]);
  assert.doesNotMatch(reminder.text, /Factuurbedrag/);
  assert.match(reminder.text, /Openstaand bedrag: €\s173,63/);
});
