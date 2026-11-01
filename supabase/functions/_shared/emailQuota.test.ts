import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quotaRefusal } from './emailQuota.ts';

test('binnen de grens: geen weigering', () => {
  assert.equal(quotaRefusal({ ok: true, hour: 3, day: 10, hourly_limit: 200, daily_limit: 1000 }), null);
  assert.equal(quotaRefusal(null), null);
});

test('over de grens: een duidelijke zin met de grenzen', () => {
  const message = quotaRefusal({ ok: false, hour: 200, day: 200, hourly_limit: 200, daily_limit: 1000 });
  assert.ok(message && message.includes('200 per uur') && message.includes('1000 per dag'));
});

test('de vrije klantmail en de agenda-uitnodigingen tellen mee', () => {
  const mail = readFileSync(new URL('../mail/index.ts', import.meta.url), 'utf8');
  const calendar = readFileSync(new URL('./calendarEventWrite.ts', import.meta.url), 'utf8');
  assert.match(mail, /await takeEmailQuota\(supabaseAdmin, organizationId, 1,/);
  assert.match(calendar, /await takeEmailQuota\(supabaseAdmin, organizationId, current\.length,/);
});
