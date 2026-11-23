/**
 * Google Drive en OneDrive in Inhoud, de kant van de app (cloudDrive.ts).
 * Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_OAUTH_ERROR_CODES,
  DRIVE_RETURN_PARAMS,
  attachmentDisplayBytes,
  cloudOpenUrl,
  cloudProviderOf,
  deleteConfirmText,
  deletionStatusText,
  driveOAuthErrorText,
  isCloudAttachment,
  markCloudDrivePendingLinked,
  parseDriveOAuthReturn,
  rememberCloudDrivePending,
  takeLinkedCloudDrivePending,
} from './cloudDrive.ts';
import { DRIVE_RETURN_PARAMS as SERVER_PARAMS } from '../../supabase/functions/_shared/cloudFiles.ts';
import { CALENDAR_OAUTH_ERROR_CODES } from '../../supabase/functions/_shared/calendarOAuth.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const APP = 'https://app.resofly.nl';

test('de app en de server gebruiken dezelfde terugkeerparameters en foutcodes', () => {
  assert.deepEqual([...DRIVE_RETURN_PARAMS], [...SERVER_PARAMS]);
  assert.deepEqual([...DRIVE_OAUTH_ERROR_CODES], [...CALENDAR_OAUTH_ERROR_CODES], 'de callback deelt classifyProviderError met de agenda');
});

test('een gekoppeld bestand herken je aan de kolom, en anders aan de sleutel', () => {
  assert.equal(isCloudAttachment({ storage_key: `${ORG}/folder/a.pdf` }), false);
  assert.equal(isCloudAttachment({ storage_key: `${ORG}/folder/a.pdf`, cloud_provider: 'google' }), true);
  assert.equal(isCloudAttachment({ storage_key: `${ORG}/cloud/microsoft/x` }), true);
  assert.equal(cloudProviderOf({ storage_key: `${ORG}/cloud/microsoft/x` }), 'microsoft');
  assert.equal(cloudProviderOf({ storage_key: `${ORG}/cloud/dropbox/x` }), null);
});

test('openen gaat alleen naar Google of Microsoft', () => {
  const key = `${ORG}/cloud/google/x`;
  assert.equal(cloudOpenUrl({ storage_key: key, cloud_provider: 'google', cloud_web_url: 'https://docs.google.com/document/d/abc/edit' }), 'https://docs.google.com/document/d/abc/edit');
  assert.equal(cloudOpenUrl({ storage_key: key, cloud_provider: 'google', cloud_web_url: 'javascript:alert(1)', cloud_file_id: 'abc' }), 'https://drive.google.com/file/d/abc/view', 'een rare link: dan de vaste van Drive');
  assert.equal(cloudOpenUrl({ storage_key: key, cloud_provider: 'google', cloud_web_url: 'https://evil.example/' }), null);
  assert.equal(cloudOpenUrl({ storage_key: `${ORG}/cloud/microsoft/x`, cloud_provider: 'microsoft', cloud_web_url: 'https://contoso-my.sharepoint.com/x' }), 'https://contoso-my.sharepoint.com/x');
  assert.equal(cloudOpenUrl({ storage_key: `${ORG}/cloud/microsoft/x`, cloud_provider: 'microsoft', cloud_web_url: 'https://drive.google.com/x' }), null);
  assert.equal(cloudOpenUrl({ storage_key: `${ORG}/folder/a.pdf` }), null);
});

test('de grootte van een gekoppeld bestand komt uit Drive, niet uit onze opslag', () => {
  assert.equal(attachmentDisplayBytes({ size_bytes: 0, cloud_provider: 'google', cloud_size_bytes: 2048 }), 2048);
  assert.equal(attachmentDisplayBytes({ size_bytes: 0, cloud_provider: 'google', cloud_size_bytes: null }), null, 'een Google-document heeft geen grootte');
  assert.equal(attachmentDisplayBytes({ size_bytes: 512 }), 512);
});

test('de bevestiging zegt wat er in Drive of OneDrive gebeurt', () => {
  assert.match(deleteConfirmText([{ name: 'a.pdf', storage_key: `${ORG}/cloud/google/x`, cloud_provider: 'google' }]), /Google Drive naar de prullenbak/);
  assert.match(deleteConfirmText([{ name: 'a.pdf', storage_key: `${ORG}/folder/a.pdf` }]), /Cloudflare-opslag/);
  const mixed = deleteConfirmText([
    { name: 'a', storage_key: `${ORG}/folder/a` },
    { name: 'b', storage_key: `${ORG}/cloud/google/b`, cloud_provider: 'google' },
    { name: 'c', storage_key: `${ORG}/cloud/microsoft/c`, cloud_provider: 'microsoft' },
  ]);
  assert.match(mixed, /^3 bestanden verwijderen\? 2 ervan gaan ook in Google Drive en OneDrive naar de prullenbak/);
});

test('de terugkeer: code en state, of een vaste foutcode', () => {
  const ok = parseDriveOAuthReturn(`${APP}/?drive_code=abc&drive_state=p.s&tab=inhoud#x`);
  assert.deepEqual(ok.result, { kind: 'code', code: 'abc', state: 'p.s' });
  assert.equal(ok.cleaned, '/?tab=inhoud#x');
  const fout = parseDriveOAuthReturn(`${APP}/?drive_error=geweigerd&drive_provider=microsoft`);
  assert.deepEqual(fout.result, { kind: 'error', error: 'geweigerd', provider: 'microsoft' });
  const verzonnen = parseDriveOAuthReturn(`${APP}/?drive_error=${encodeURIComponent('Bel 0900-OPLICHTER')}`);
  assert.deepEqual(verzonnen.result, { kind: 'error', error: 'mislukt', provider: null }, 'eigen tekst in het adres telt niet');
  assert.deepEqual(parseDriveOAuthReturn(`${APP}/?calendar_code=abc&calendar_state=x`), { result: null, cleaned: null }, 'de agenda is niet van ons');
  assert.equal(parseDriveOAuthReturn(`${APP}/?drive_code=abc`).result, null, 'zonder state niets afronden');
});

test('elke foutcode heeft een eigen uitleg', () => {
  const texts = DRIVE_OAUTH_ERROR_CODES.map(code => driveOAuthErrorText(code, 'google'));
  assert.equal(new Set(texts).size, texts.length);
  assert.match(driveOAuthErrorText('beheerder', 'microsoft'), /Microsoft-account/);
});

test('na het koppelen terug naar de map waar je begon: pas na het afronden, niet te laat, niet elders', () => {
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  const OTHER = '22222222-2222-4222-8222-222222222222';
  rememberCloudDrivePending({ provider: 'google', organizationId: ORG, clientId: 'c1', projectId: null, folderId: 'f1' }, fake, 1_000);
  assert.equal(takeLinkedCloudDrivePending(ORG, undefined, fake, 2_000), null, 'het afronden loopt nog');
  assert.ok(store.size === 1, 'en dan blijft hij staan');
  markCloudDrivePendingLinked(OTHER, fake, 2_000);
  assert.equal(takeLinkedCloudDrivePending(ORG, undefined, fake, 2_000), null, 'een andere organisatie rondt hem niet af');
  markCloudDrivePendingLinked(ORG, fake, 2_000);
  assert.equal(takeLinkedCloudDrivePending(OTHER, undefined, fake, 2_000), null, 'en leest hem niet');
  assert.equal(takeLinkedCloudDrivePending(ORG, p => p.clientId === 'c2', fake, 2_000), null, 'het dossier van een andere klant laat hem liggen');
  assert.deepEqual(takeLinkedCloudDrivePending(ORG, undefined, fake, 3_000), { provider: 'google', organizationId: ORG, clientId: 'c1', projectId: null, folderId: 'f1', at: 1_000, linked: true });
  assert.equal(takeLinkedCloudDrivePending(ORG, undefined, fake, 3_000), null, 'en daarna is hij weg');
  rememberCloudDrivePending({ provider: 'microsoft', organizationId: ORG, clientId: 'c1', projectId: 'p1', folderId: 'f2' }, fake, 1_000);
  markCloudDrivePendingLinked(ORG, fake, 2_000);
  assert.equal(takeLinkedCloudDrivePending(ORG, undefined, fake, 1_000 + 31 * 60 * 1000), null, 'na een half uur telt het niet meer');
  assert.equal(store.size, 0, 'en is hij opgeruimd');
});

test('wat er nog weg moet, in gewone woorden', () => {
  assert.match(deletionStatusText({ status: 'pending', failure: null, lastError: null, provider: 'google', mine: true }), /prullenbak van Google Drive/);
  assert.match(deletionStatusText({ status: 'failed', failure: 'connection', lastError: 'x', provider: 'microsoft', mine: false }), /collega/);
  assert.equal(deletionStatusText({ status: 'failed', failure: 'permission', lastError: 'Alleen de eigenaar.', provider: 'google', mine: true }), 'Alleen de eigenaar.');
});
