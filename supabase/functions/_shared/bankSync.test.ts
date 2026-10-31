/**
 * Tests voor de regels van de bankkoppeling (bankSync.ts). Draaien met:  npm test
 *
 * Aanleiding (controle 2026-10-30): op staging stonden twee koppelingen maanden
 * na hun verloopdatum nog op "gekoppeld", bleef een afgebroken koppeling stil op
 * "created" staan en kapte de toestemming op 90 dagen af terwijl de meeste
 * banken er 180 toestaan. Deze test legt de regels vast, en vergelijkt ze met
 * src/lib/bankLink.ts zodat de app en bank-sync hetzelfde blijven verstaan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bankReturnError, choosePsuType, consentExpired, consentValidUntil, ebErrorCode, FALLBACK_CONSENT_DAYS,
  isBookedTransaction, mapAspsp, mapEbTransaction, needsReconsent, psuTypesOf, syncDateFrom,
} from './bankSync.ts';
import * as app from '../../../src/lib/bankLink.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-30T12:00:00Z');

test('bankkiezer: de naam is het id, en alleen bekende rekeningsoorten', () => {
  assert.deepEqual(mapAspsp({ name: ' Rabobank ', bic: 'RABONL2U', logo: 'https://x/rabo.png', psu_types: ['personal', 'Business', 'corporate'] }), {
    id: 'Rabobank', name: 'Rabobank', bic: 'RABONL2U', logo: 'https://x/rabo.png', psu_types: ['business', 'personal'],
  });
  assert.equal(mapAspsp({ bic: 'X' }), null, 'zonder naam valt er niets te koppelen');
  assert.deepEqual(mapAspsp({ name: 'Mock ASPSP' })?.psu_types, [], 'onbekend = leeg, niet "alles"');
  assert.deepEqual(psuTypesOf('business'), []);
});

test('rekeningsoort: de keuze van de gebruiker, mits de bank hem aankan', () => {
  assert.equal(choosePsuType('personal', ['business', 'personal'], 'business'), 'personal');
  assert.equal(choosePsuType(undefined, ['business', 'personal'], 'business'), 'business', 'niets gekozen = standaard');
  assert.equal(choosePsuType('corporate', ['personal'], 'personal'), 'personal', 'onzin = standaard');
  assert.equal(choosePsuType('business', ['personal'], 'business'), null, 'bank kan geen zakelijk');
  assert.equal(choosePsuType('business', [], 'personal'), 'business', 'onbekende bank: vertrouwen op de keuze');
});

test('toestemming: het maximum van de bank, nooit erboven', () => {
  const days = (iso: string) => (Date.parse(iso) - NOW) / DAY;
  const d180 = 180 * 24 * 3600;
  // Zonder eigen instelling: het maximum van de bank, met een uur speling.
  assert.equal(Date.parse(consentValidUntil(NOW, d180, null)), NOW + 180 * DAY - 60 * 60 * 1000);
  // Ingesteld = bovengrens, maar de bank wint als die strenger is.
  assert.equal(days(consentValidUntil(NOW, d180, 30)), 30);
  assert.ok(days(consentValidUntil(NOW, 90 * 24 * 3600, 180)) < 90);
  // De bank noemt niets: 90 dagen, of wat is ingesteld.
  for (const unknown of [null, undefined, 'abc', -5, 0]) {
    assert.equal(days(consentValidUntil(NOW, unknown, null)), FALLBACK_CONSENT_DAYS, `maximum ${String(unknown)}`);
  }
  assert.equal(days(consentValidUntil(NOW, null, 120)), 120);
  // Wat de bank ook noemt: valid_until ligt er altijd vóór.
  for (const max of [600, 3600, 86_400, 30 * 86_400, 90 * 86_400, d180, 365 * 86_400]) {
    for (const configured of [null, 1, 90, 180, 400]) {
      const until = Date.parse(consentValidUntil(NOW, max, configured));
      assert.ok(until < NOW + max * 1000 && until > NOW, `max ${max}s, ingesteld ${configured}`);
    }
  }
});

test('alleen geboekte transacties', () => {
  for (const status of ['BOOK', 'book', ' BOOK ', '', undefined, null]) assert.equal(isBookedTransaction({ status }), true, String(status));
  for (const status of ['PDNG', 'pdng', 'INFO', 'OTHR', 'CNCL', 'HOLD']) assert.equal(isBookedTransaction({ status }), false, status);
  assert.equal(isBookedTransaction(null), true);
});

test('transactie: teken, tegenpartij en omschrijving', () => {
  const out = mapEbTransaction({
    entry_reference: 'ref-1', credit_debit_indicator: 'DBIT', transaction_amount: { amount: '12.30', currency: 'EUR' },
    booking_date: '2026-10-01', value_date: '2026-10-02', creditor: { name: 'KPN' }, creditor_account: { iban: 'NL01KPN0000000001' },
    debtor: { name: 'Ik' }, remittance_information: ['Factuur 2026-0042', '', 'oktober'],
  });
  assert.equal(out.amount_cents, -1230);
  assert.equal(out.counterparty_name, 'KPN');
  assert.equal(out.counterparty_iban, 'NL01KPN0000000001');
  assert.equal(out.description, 'Factuur 2026-0042 oktober');
  assert.equal(out.bank_tx_id, 'ref-1');
  assert.equal('dedup_key' in out, false, 'de sleutel leidt de server af uit de inhoud');

  const incoming = mapEbTransaction({ credit_debit_indicator: 'CRDT', transaction_amount: { amount: '100' }, value_date: '2026-10-05', debtor: { name: 'Klant BV' } });
  assert.equal(incoming.amount_cents, 10000);
  assert.equal(incoming.counterparty_name, 'Klant BV');
  assert.equal(incoming.booking_date, '2026-10-05', 'geen boekdatum: de valutadatum');
  assert.equal(incoming.currency, 'EUR');
});

test('sync-venster: een week overlap, of 90 dagen bij de eerste keer', () => {
  assert.equal(syncDateFrom('2026-10-20T12:00:00Z', NOW), '2026-10-13');
  assert.equal(syncDateFrom(null, NOW), '2026-08-01');
  assert.equal(syncDateFrom('geen datum', NOW), '2026-08-01');
});

test('verlopen: ook zonder mislukte sync, op de verloopdatum', () => {
  assert.equal(consentExpired({ status: 'linked', expires_at: '2026-09-24T09:11:58Z' }, NOW), true, 'het staging-geval');
  assert.equal(consentExpired({ status: 'linked', expires_at: '2027-01-26T10:11:00Z' }, NOW), false);
  assert.equal(consentExpired({ status: 'expired', expires_at: '2027-01-26T10:11:00Z' }, NOW), true);
  assert.equal(consentExpired({ status: 'linked', expires_at: null }, NOW), false);
  assert.equal(consentExpired({ status: 'linked', expires_at: 'onzin' }, NOW), false);
  assert.equal(consentExpired(null, NOW), false);
});

test('terug van de bank met ?error=: afgebroken of geweigerd', () => {
  assert.deepEqual(bankReturnError('access_denied', ''), { status: 'cancelled', detail: 'access_denied' });
  assert.equal(bankReturnError('CANCELLED', 'Session authorisation cancelled').status, 'cancelled');
  assert.deepEqual(bankReturnError('server_error', 'ASPSP niet bereikbaar'), { status: 'error', detail: 'server_error: ASPSP niet bereikbaar' });
  assert.equal(bankReturnError('', '').detail, 'onbekende fout');
  assert.equal(bankReturnError('x', 'y'.repeat(900)).detail.length, 500);
});

test('foutcodes van Enable Banking en wanneer de klant opnieuw toestemming moet geven', () => {
  assert.equal(ebErrorCode({ error: 'WRONG_TRANSACTIONS_PERIOD', message: 'Wrong period' }), 'WRONG_TRANSACTIONS_PERIOD');
  assert.equal(ebErrorCode({ code: 'ASPSP_ERROR' }), 'ASPSP_ERROR');
  assert.equal(ebErrorCode({ code: 422, error: 'iets ging mis' }), null, 'geen code, maar tekst');
  assert.equal(ebErrorCode(null), null);
  assert.equal(needsReconsent(401, null), true);
  assert.equal(needsReconsent(403, null), true);
  assert.equal(needsReconsent(422, 'EXPIRED_SESSION'), true);
  assert.equal(needsReconsent(400, 'CLOSED_SESSION'), true);
  assert.equal(needsReconsent(502, 'ASPSP_ERROR'), false);
  assert.equal(needsReconsent(undefined, null), false);
});

test('app en server verstaan hetzelfde onder "verlopen" en "afgebroken"', () => {
  const requisitions = [
    null, { status: 'linked', expires_at: '2026-09-24T09:11:58Z' }, { status: 'linked', expires_at: '2027-01-26T10:11:00Z' },
    { status: 'expired', expires_at: null }, { status: 'created', expires_at: new Date(NOW).toISOString() },
    { status: 'linked', expires_at: 'onzin' }, { status: 'error', expires_at: new Date(NOW + 1).toISOString() },
  ];
  for (const req of requisitions) {
    assert.equal(app.consentState(req, NOW).expired, consentExpired(req, NOW), `verschil bij ${JSON.stringify(req)}`);
  }
  for (const error of ['access_denied', 'ACCESS_DENIED', 'CANCELLED', 'canceled', 'user_cancelled', 'server_error', 'invalid_request', '']) {
    assert.equal(app.isCancelledBankReturn(error), bankReturnError(error, '').status === 'cancelled', `verschil bij ${error}`);
  }
});

test('bank-sync: de cron vóór de origin-check, en de regels uit dit bestand', () => {
  const source = readFileSync(new URL('../bank-sync/index.ts', import.meta.url), 'utf8');
  // pg_cron stuurt geen Origin mee; kwam de origin-check eerst, dan faalde elke ronde.
  const cron = source.indexOf('return await handleCron(req, cron)');
  const origin = source.indexOf('assertAllowedOrigin(req);');
  assert.ok(cron > 0 && origin > 0 && cron < origin, 'handleCron moet vóór assertAllowedOrigin');
  // Eén afleiding op één plek: geen eigen kopie van de mapping in de functie.
  assert.doesNotMatch(source, /function mapEbTransaction\b/);
  assert.match(source, /from '\.\.\/_shared\/bankSync\.ts'/);
  assert.match(source, /filter\(isBookedTransaction\)/, 'pending-transacties niet importeren');
});
