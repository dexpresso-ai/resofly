import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentState } from './bankConsent.ts';

const now = Date.parse('2026-10-18T10:00:00Z');
const at = (days: number) => new Date(now + days * 86_400_000).toISOString();

test('toestemming: ruim geldig, bijna verlopen, verlopen', () => {
  assert.deepEqual(consentState({ status: 'linked', expires_at: at(100) }, now), { kind: 'ok', until: at(100), daysLeft: 100 });
  assert.equal(consentState({ status: 'linked', expires_at: at(14) }, now).kind, 'soon', 'twee weken vooraf: waarschuwen');
  assert.equal(consentState({ status: 'linked', expires_at: at(15) }, now).kind, 'ok');
  assert.deepEqual(consentState({ status: 'linked', expires_at: at(0.5) }, now), { kind: 'soon', until: at(0.5), daysLeft: 1 });
  // De datum is voorbij maar de status staat nog op linked (de cron komt pas straks): verlopen.
  assert.equal(consentState({ status: 'linked', expires_at: at(-1) }, now).kind, 'expired');
  // De sync kreeg een weigering: verlopen, ook al zegt de datum iets anders.
  assert.equal(consentState({ status: 'expired', expires_at: at(30) }, now).kind, 'expired');
});

test('toestemming: zonder requisition of datum', () => {
  assert.deepEqual(consentState(undefined, now), { kind: 'none' });
  assert.deepEqual(consentState({ status: 'linked', expires_at: null }, now), { kind: 'ok', until: null, daysLeft: null });
  assert.equal(consentState({ status: 'linked', expires_at: 'onzin' }, now).kind, 'ok');
});
