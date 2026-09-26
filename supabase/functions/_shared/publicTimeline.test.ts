import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPublicTimeline } from './publicTimeline.ts';

/**
 * De publieke tijdlijn mag nooit het interne logboek doorgeven: geen interne
 * goedkeuring met afwijzingsreden, geen fouttekst van de mailprovider, geen
 * voorgestelde aanmaning, geen open-/kliktracking.
 */

test('interne stappen verdwijnen, klantstappen krijgen een vaste titel', () => {
  const events = [
    { id: 'a', event_type: 'internal_approval_rejected', title: 'Intern afgekeurd', description: 'Marge te laag, eerst met Piet overleggen', metadata: { note: 'x' }, created_at: '2026-09-01T10:00:00Z' },
    { id: 'b', event_type: 'sent_to_client', title: 'Verstuurd door Jan', description: 'naar klant@example.com', metadata: {}, created_at: '2026-09-02T10:00:00Z' },
    { id: 'c', event_type: 'email_failed', title: 'Mail mislukt', description: 'Resend: domain not verified', created_at: '2026-09-02T10:01:00Z' },
    { id: 'd', event_type: 'email_opened', title: 'Geopend', created_at: '2026-09-02T11:00:00Z' },
    { id: 'e', event_type: 'client_accepted', title: 'Akkoord', description: 'door de klant', created_at: '2026-09-03T10:00:00Z' },
  ];
  assert.deepEqual(toPublicTimeline('quote', events), [
    { id: 'b', event_type: 'sent_to_client', title: 'Offerte verstuurd', description: null, created_at: '2026-09-02T10:00:00Z' },
    { id: 'e', event_type: 'client_accepted', title: 'Offerte geaccepteerd', description: null, created_at: '2026-09-03T10:00:00Z' },
  ]);
});

test('factuur: voorgestelde aanmaning en afboeking blijven intern', () => {
  const events = [
    { event_type: 'dunning_proposed', title: 'Aanmaning voorgesteld', description: 'Wacht op bevestiging', created_at: '2026-09-05T10:00:00Z' },
    { event_type: 'written_off', title: 'Afgeboekt', created_at: '2026-09-06T10:00:00Z' },
    { event_type: 'payment_paid', title: 'Betaald via Mollie', description: 'tr_123', created_at: '2026-09-07T10:00:00Z' },
  ];
  assert.deepEqual(toPublicTimeline('invoice', events), [
    { event_type: 'payment_paid', title: 'Betaald', description: null, created_at: '2026-09-07T10:00:00Z' },
  ]);
});

test('onbekende of nieuwe event-types worden niet getoond', () => {
  assert.deepEqual(toPublicTimeline('contract', [
    { event_type: 'some_future_internal_event', title: 'x', created_at: '2026-09-01T00:00:00Z' },
    { event_type: 'toString', title: 'x', created_at: '2026-09-01T00:00:00Z' },
  ]), []);
});
