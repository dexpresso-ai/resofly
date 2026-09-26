import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPushEndpoint, sendWebPush } from './webPush.ts';

/**
 * De push-dispatcher POST met de service-role naar het endpoint dat een lid zelf
 * in push_subscriptions heeft gezet. Alleen de echte push-diensten mogen daar
 * dus doorheen; al het andere moet als 'gone' terugkomen zodat het opgeruimd wordt.
 */

test('echte push-diensten worden doorgelaten', () => {
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def'), true);
  assert.equal(isAllowedPushEndpoint('https://android.googleapis.com/gcm/send/abc'), true);
  assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAA'), true);
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/QGx1'), true);
  assert.equal(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc'), true);
  assert.equal(isAllowedPushEndpoint('https://FCM.GoogleAPIs.com/fcm/send/abc'), true);
});

test('andere hosts, lookalikes en geen https worden geweigerd', () => {
  assert.equal(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
  assert.equal(isAllowedPushEndpoint('https://evil.example/fcm.googleapis.com'), false);
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
  assert.equal(isAllowedPushEndpoint('https://evilpush.apple.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://push.apple.com.evil.example/x'), false);
  assert.equal(isAllowedPushEndpoint('https://xnotify.windows.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://www.googleapis.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isAllowedPushEndpoint('https://localhost/x'), false);
  assert.equal(isAllowedPushEndpoint('file:///etc/passwd'), false);
  assert.equal(isAllowedPushEndpoint('geen url'), false);
});

test('een onbekend endpoint wordt niet aangeroepen maar als gone gemeld', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response(null, { status: 201 }); }) as typeof fetch;
  try {
    const keys = { publicKey: 'x', privateKey: 'y', subject: 'mailto:test@example.com' };
    const outcome = await sendWebPush(keys, { endpoint: 'https://intern.example/hook', p256dh: 'a', auth: 'b' }, { title: 't' });
    assert.equal(outcome.result, 'gone');
    assert.equal(outcome.status, 0);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
