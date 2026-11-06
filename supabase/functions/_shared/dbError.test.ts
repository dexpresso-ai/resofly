import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALREADY_HAPPENING_MESSAGE, INVALID_CHARACTER_MESSAGE, containsNulCharacter, dbErrorAnswer } from './dbError.ts';

/**
 * Een databasefout (een gewoon object van supabase-js, geen Error) werd in de
 * edge functions een 500 met "Onbekende fout.". Eigen meldingen uit de
 * database horen als 4xx bij de gebruiker; technische meldingen nooit.
 */

test('eigen meldingen uit de database worden een 4xx met die zin', () => {
  assert.deepEqual(
    dbErrorAnswer({ code: '23514', message: 'Dit contract kan niet (opnieuw) ter ondertekening worden verstuurd vanuit status signed.' }),
    { status: 409, message: 'Dit contract kan niet (opnieuw) ter ondertekening worden verstuurd vanuit status signed.' },
  );
  assert.deepEqual(dbErrorAnswer({ code: '22023', message: 'Ongeldige beslissing: x' }), { status: 422, message: 'Ongeldige beslissing: x' });
  assert.deepEqual(dbErrorAnswer({ code: '42501', message: 'Geen schrijfrechten voor deze organisatie.' }), { status: 403, message: 'Geen schrijfrechten voor deze organisatie.' });
  assert.deepEqual(dbErrorAnswer({ code: '02000', message: 'Offerte niet gevonden' }), { status: 404, message: 'Offerte niet gevonden' });
});

test('dubbel of tegelijk: 409, met de eigen zin als die er is', () => {
  assert.deepEqual(
    dbErrorAnswer({ code: '23505', message: 'Er loopt al een recente Resend-verzendpoging voor deze offerte' }),
    { status: 409, message: 'Er loopt al een recente Resend-verzendpoging voor deze offerte' },
  );
  assert.deepEqual(
    dbErrorAnswer({ code: '23505', message: 'duplicate key value violates unique constraint "invoice_dunning_notices_open_key"' }),
    { status: 409, message: ALREADY_HAPPENING_MESSAGE },
  );
});

test('een NUL-teken is een 422 met uitleg, nooit de Engelse melding', () => {
  assert.deepEqual(dbErrorAnswer({ code: '22P05', message: 'unsupported Unicode escape sequence' }), { status: 422, message: INVALID_CHARACTER_MESSAGE });
});

test('technische meldingen en echte fouten blijven een 500 (null)', () => {
  assert.equal(dbErrorAnswer({ code: '23514', message: 'new row for relation "quotes" violates check constraint "quotes_status_check"' }), null);
  assert.equal(dbErrorAnswer({ code: '42P01', message: 'relation "x" does not exist' }), null);
  assert.equal(dbErrorAnswer({ code: '42501', message: 'permission denied for table invoices' }), null);
  assert.equal(dbErrorAnswer(new Error('fetch failed')), null);
  assert.equal(dbErrorAnswer(null), null);
  assert.equal(dbErrorAnswer({ message: 'zonder code' }), null);
});

test('NUL-tekens worden gevonden, ook diep in de invoer', () => {
  assert.equal(containsNulCharacter('akkoord\u0000'), true);
  assert.equal(containsNulCharacter({ action: 'acceptQuote', name: 'Anna', note: ['ok', { x: 'a\u0000' }] }), true);
  assert.equal(containsNulCharacter({ ['sleutel\u0000']: 1 }), true);
  assert.equal(containsNulCharacter({ name: 'Anna', note: 'Regel 1\nRegel 2\tmet tab', bedrag: 12 }), false);
  assert.equal(containsNulCharacter(null), false);
});
