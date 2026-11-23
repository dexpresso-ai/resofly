import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursLabel, invoicedLabel, openHoursSummary } from './timeRates.ts';

// "Nog te factureren" op de pagina Uren, het project en de klant moet hetzelfde
// zeggen als time_invoice_preview in de database (migratie 20261123110000):
// declarabel, met een tarief, en nog op geen factuur.

test('nog te factureren: alleen declarabel, met tarief en nog niet op een factuur', () => {
  const summary = openHoursSummary([
    { billable: true, minutes: 66, hourly_rate_cents: 8500 },
    { billable: true, minutes: 66, hourly_rate_cents: 8500, invoice_id: 'factuur-1' },
    { billable: false, minutes: 120, hourly_rate_cents: 8500 },
    { billable: true, minutes: 90, hourly_rate_cents: null },
    { billable: true, minutes: 30, hourly_rate_cents: 0 },
    { billable: true, minutes: 0, hourly_rate_cents: 8500 },
  ]);
  assert.deepEqual(summary, { minutes: 66, valueCents: 9350, withoutRateMinutes: 120 });
});

test('110 registraties van 66 minuten à € 85 is 121 uur en € 10.285', () => {
  const entries = Array.from({ length: 110 }, () => ({ billable: true, minutes: 66, hourly_rate_cents: 8500 }));
  assert.deepEqual(openHoursSummary(entries), { minutes: 7260, valueCents: 1028500, withoutRateMinutes: 0 });
});

test('uren als tekst: hooguit twee decimalen, met een komma', () => {
  assert.equal(hoursLabel(7260), '121 uur');
  assert.equal(hoursLabel(1650), '27,5 uur');
  assert.equal(hoursLabel(50), '0,83 uur');
});

test('het label van een gefactureerd uur: concept of definitief, met het nummer', () => {
  const invoices = [{ id: 'a', number: 'F2026-001', status: 'draft' }, { id: 'b', number: 'F2026-002', status: 'sent' }];
  assert.equal(invoicedLabel({ invoice_id: null }, invoices), null);
  assert.equal(invoicedLabel({}, invoices), null);
  assert.equal(invoicedLabel({ invoice_id: 'a' }, invoices), 'Op concept F2026-001');
  assert.equal(invoicedLabel({ invoice_id: 'b' }, invoices), 'Gefactureerd F2026-002');
  // Zonder leesrecht op Financiën zit de factuur niet in de gegevens.
  assert.equal(invoicedLabel({ invoice_id: 'c' }, invoices), 'Gefactureerd');
});
