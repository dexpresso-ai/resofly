/**
 * Een bestand uit R2 naar OneDrive (onedrivePush.ts). Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONEDRIVE_CHUNK_BYTES, ONEDRIVE_PUSH_SEGMENTS, isMicrosoftUploadUrl, pickDriveItem, uploadChunks } from './onedrivePush.ts';

test('alleen uploadadressen van OneDrive', () => {
  assert.equal(isMicrosoftUploadUrl('https://contoso-my.sharepoint.com/personal/x/_api/v2.0/drives/b!a/items/01X/uploadSession?guid=1'), true);
  assert.equal(isMicrosoftUploadUrl('https://api.onedrive.com/rup/abc'), true);
  assert.equal(isMicrosoftUploadUrl('https://sn3302.up.1drv.com/up/fe6987415ace7X4e1eF866337'), true);
  assert.equal(isMicrosoftUploadUrl('https://my.microsoftpersonalcontent.com/personal/abc/_api/v2.0/uploadSession'), true);
  assert.equal(isMicrosoftUploadUrl('https://microsoftpersonalcontent.com.evil.example/x'), false);
  assert.equal(isMicrosoftUploadUrl('http://contoso-my.sharepoint.com/x'), false, 'alleen https');
  assert.equal(isMicrosoftUploadUrl('https://sharepoint.com.evil.example/x'), false);
  assert.equal(isMicrosoftUploadUrl('https://evil.example/?u=https://x.sharepoint.com'), false);
  assert.equal(isMicrosoftUploadUrl('https://user:pw@x.sharepoint.com/x'), false);
  assert.equal(isMicrosoftUploadUrl('https://x.sharepoint.com:8443/x'), false, 'geen eigen poort');
  assert.equal(isMicrosoftUploadUrl('https://169.254.169.254/latest'), false);
  assert.equal(isMicrosoftUploadUrl(42), false);
});

test('stukken die Microsoft accepteert', () => {
  assert.equal(ONEDRIVE_CHUNK_BYTES % (320 * 1024), 0, 'een veelvoud van 320 KiB');
  assert.ok(ONEDRIVE_CHUNK_BYTES <= 60 * 1024 * 1024);
  assert.deepEqual(uploadChunks(0), []);
  assert.deepEqual(uploadChunks(5), [{ start: 0, end: 4 }]);
  const parts = uploadChunks(ONEDRIVE_CHUNK_BYTES * 2 + 1);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[1], { start: ONEDRIVE_CHUNK_BYTES, end: ONEDRIVE_CHUNK_BYTES * 2 - 1 });
  assert.deepEqual(parts[2], { start: ONEDRIVE_CHUNK_BYTES * 2, end: ONEDRIVE_CHUNK_BYTES * 2 });
});

test('nooit financiële stukken, de galerij of zendingen', () => {
  for (const segment of ['invoice-pdfs', 'quote-pdfs', 'contract-pdfs', 'annual-account-pdfs', 'e-invoices', 'invoice', 'quote', 'purchase_invoice', 'fixed_asset', 'gallery', 'transfer']) {
    assert.equal(ONEDRIVE_PUSH_SEGMENTS.has(segment), false, segment);
  }
  assert.equal(ONEDRIVE_PUSH_SEGMENTS.has('folder'), true);
  assert.equal(ONEDRIVE_PUSH_SEGMENTS.has('document'), true);
});

test('wat de edge function van het antwoord krijgt', () => {
  assert.deepEqual(pickDriveItem({ id: '01X', name: 'a.pdf', eTag: 'e', cTag: 'c', webUrl: 'https://x', parentReference: { id: '01P', driveId: 'b!d' }, '@content.downloadUrl': 'geheim' }),
    { id: '01X', name: 'a.pdf', eTag: 'e', cTag: 'c', webUrl: 'https://x', parentId: '01P' });
  assert.equal(pickDriveItem({ name: 'zonder id' }), null);
  assert.equal(pickDriveItem(null), null);
});
