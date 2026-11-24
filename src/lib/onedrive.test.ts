/**
 * De kopie van Inhoud in OneDrive, de kant van de app (onedrive.ts).
 * Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONEDRIVE_OAUTH_ERROR_CODES,
  ONEDRIVE_RETURN_PARAMS,
  oneDriveOAuthErrorText,
  oneDriveStage,
  parseOneDriveOAuthReturn,
  syncSummary,
  type OneDriveStatus,
} from './onedrive.ts';
import { ONEDRIVE_RETURN_PARAMS as SERVER_PARAMS } from '../../supabase/functions/_shared/onedriveSync.ts';
import { CALENDAR_OAUTH_ERROR_CODES } from '../../supabase/functions/_shared/calendarOAuth.ts';

const APP = 'https://app.resofly.nl';

test('de app en de server gebruiken dezelfde terugkeerparameters en foutcodes', () => {
  assert.deepEqual([...ONEDRIVE_RETURN_PARAMS], [...SERVER_PARAMS]);
  assert.deepEqual([...ONEDRIVE_OAUTH_ERROR_CODES], [...CALENDAR_OAUTH_ERROR_CODES]);
});

test('de terugkeer: code en state, of een vaste foutcode', () => {
  const ok = parseOneDriveOAuthReturn(`${APP}/?onedrive_code=abc&onedrive_state=p.s&x=1#y`);
  assert.deepEqual(ok.result, { kind: 'code', code: 'abc', state: 'p.s' });
  assert.equal(ok.cleaned, '/?x=1#y');
  assert.deepEqual(parseOneDriveOAuthReturn(`${APP}/?onedrive_error=beheerder`).result, { kind: 'error', error: 'beheerder' });
  assert.deepEqual(parseOneDriveOAuthReturn(`${APP}/?onedrive_error=${encodeURIComponent('Bel 0900-OPLICHTER')}`).result, { kind: 'error', error: 'mislukt' }, 'eigen tekst in het adres telt niet');
  assert.deepEqual(parseOneDriveOAuthReturn(`${APP}/?calendar_code=a&calendar_state=b`), { result: null, cleaned: null }, 'de agenda is niet van ons');
  assert.equal(parseOneDriveOAuthReturn(`${APP}/?onedrive_code=abc`).result, null, 'zonder state niets afronden');
});

test('elke foutcode heeft een eigen uitleg', () => {
  const texts = ONEDRIVE_OAUTH_ERROR_CODES.map(code => oneDriveOAuthErrorText(code));
  assert.equal(new Set(texts).size, texts.length);
});

const base: OneDriveStatus = { configured: true, connection: null, queue: { pending: 0, failed: 0, failedItems: [] } };
const connection = {
  account: 'eigenaar@bedrijf.nl', name: 'Eigenaar', status: 'active' as const, lastError: null, enabled: true,
  rootName: 'ResoFly - Bureau', rootWebUrl: null, lastSyncedAt: null, enabledAt: null, connectedByMe: true,
};

test('waar het gesprek staat', () => {
  assert.equal(oneDriveStage({ ...base, configured: false }), 'niet-ingericht');
  assert.equal(oneDriveStage(base), 'niet-gekoppeld');
  assert.equal(oneDriveStage({ ...base, connection: { ...connection, status: 'expired' } }), 'opnieuw-koppelen');
  assert.equal(oneDriveStage({ ...base, connection: { ...connection, enabled: false } }), 'uit');
  assert.equal(oneDriveStage({ ...base, connection }), 'aan');
});

test('hoe de kopie ervoor staat, in één zin', () => {
  const now = new Date('2026-11-24T13:00:00Z');
  assert.equal(syncSummary({ ...base, connection }, now).tone, 'ok');
  assert.match(syncSummary({ ...base, connection: { ...connection, lastSyncedAt: '2026-11-24T12:32:00Z' } }, now).text, /vandaag om 13:32/);
  assert.match(syncSummary({ ...base, connection, queue: { pending: 3, failed: 0, failedItems: [] } }, now).text, /3 wijzigingen gaan/);
  assert.equal(syncSummary({ ...base, connection, queue: { pending: 3, failed: 1, failedItems: [] } }, now).tone, 'warn', 'een fout gaat voor');
  assert.equal(syncSummary({ ...base, connection: { ...connection, lastError: 'OneDrive is vol.' } }, now).text, 'OneDrive is vol.');
});
