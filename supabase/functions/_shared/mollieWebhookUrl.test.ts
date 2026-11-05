import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceMollieWebhookBase, invoiceMollieWebhookUrl } from './mollieWebhookUrl.ts';

const SUPABASE = 'https://abc.supabase.co';

test('de billing-webhook wordt nooit de webhook van factuurbetalingen (dit ging mis)', () => {
  // .env.example: MOLLIE_WEBHOOK_URL wijst naar billing; INVOICE_MOLLIE_WEBHOOK_URL ontbreekt.
  const base = invoiceMollieWebhookBase({
    sharedWebhookUrl: 'https://abc.functions.supabase.co/billing?webhook=mollie',
    supabaseUrl: SUPABASE,
  });
  assert.equal(base, 'https://abc.supabase.co/functions/v1/invoice-workflow');
});

test('een eigen INVOICE_MOLLIE_WEBHOOK_URL gaat voor, en een gedeelde URL naar invoice-workflow mag', () => {
  assert.equal(invoiceMollieWebhookBase({ invoiceWebhookUrl: 'https://x.test/hook', sharedWebhookUrl: 'https://y.test/billing', supabaseUrl: SUPABASE }), 'https://x.test/hook');
  assert.equal(invoiceMollieWebhookBase({ sharedWebhookUrl: 'https://abc.supabase.co/functions/v1/invoice-workflow?webhook=mollie', supabaseUrl: SUPABASE }),
    'https://abc.supabase.co/functions/v1/invoice-workflow?webhook=mollie');
  assert.equal(invoiceMollieWebhookBase({}), '');
});

test('de volledige URL: één keer webhook=mollie, en het geheim erachter', () => {
  assert.equal(invoiceMollieWebhookUrl('https://h.test/f', 's e'), 'https://h.test/f?webhook=mollie&secret=s%20e');
  assert.equal(invoiceMollieWebhookUrl('https://h.test/f?webhook=mollie', 'x'), 'https://h.test/f?webhook=mollie&secret=x');
  assert.equal(invoiceMollieWebhookUrl('https://h.test/f?a=1', ''), 'https://h.test/f?a=1&webhook=mollie');
  assert.equal(invoiceMollieWebhookUrl('', 'x'), '');
});
