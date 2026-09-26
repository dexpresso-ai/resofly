import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCheckoutUrl, safeHttpUrl } from './safeUrl.ts';

test('alleen http(s) komt door', () => {
  assert.equal(safeHttpUrl('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(safeHttpUrl('  http://example.com/x '), 'http://example.com/x');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('JavaScript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<b>x</b>'), null);
  assert.equal(safeHttpUrl('msteams://teams.microsoft.com/l/x'), null);
  assert.equal(safeHttpUrl(''), null);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl('geen url'), null);
});

test('betaallink: alleen Mollie of de eigen origin', () => {
  assert.equal(safeCheckoutUrl('https://www.mollie.com/checkout/select-method/abc'), 'https://www.mollie.com/checkout/select-method/abc');
  assert.equal(safeCheckoutUrl('https://mollie.com/pay/abc'), 'https://mollie.com/pay/abc');
  assert.equal(safeCheckoutUrl('https://mollie.com.evil.example/pay'), null);
  assert.equal(safeCheckoutUrl('https://evilmollie.com/pay'), null);
  assert.equal(safeCheckoutUrl('http://www.mollie.com/checkout'), null);
  assert.equal(safeCheckoutUrl('https://app.resofly.nl/invoice/tok', 'https://app.resofly.nl'), 'https://app.resofly.nl/invoice/tok');
  assert.equal(safeCheckoutUrl('https://elders.example/invoice/tok', 'https://app.resofly.nl'), null);
  assert.equal(safeCheckoutUrl('javascript:alert(1)', 'https://app.resofly.nl'), null);
});
