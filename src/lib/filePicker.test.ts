/**
 * Tests voor het accept-attribuut dat op Android de echte bestandsnaam
 * oplevert. Draaien met:  npm test
 *
 * Het gevaarlijke geval: een accept met alleen foto- en videotypes. Daar opent
 * Chrome op Android de fotokiezer, en die maakt van elke foto een nummer
 * (`1000022523.jpg`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REAL_FILE_NAME_TYPE, acceptWithRealFileNames } from './filePicker.ts';

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const SAMSUNG_INTERNET = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

test('Android: alleen foto’s of video’s krijgt het extra type, zodat de fotokiezer dicht blijft', () => {
  for (const ua of [ANDROID_CHROME, SAMSUNG_INTERNET]) {
    assert.equal(
      acceptWithRealFileNames('image/jpeg,image/png,image/webp', ua),
      `image/jpeg,image/png,image/webp,${REAL_FILE_NAME_TYPE}`,
    );
    assert.equal(acceptWithRealFileNames('video/*', ua), `video/*,${REAL_FILE_NAME_TYPE}`);
    assert.equal(
      acceptWithRealFileNames('image/jpeg, image/png ,video/*', ua),
      `image/jpeg,image/png,video/*,${REAL_FILE_NAME_TYPE}`,
    );
    assert.equal(acceptWithRealFileNames('.jpg,.png', ua), `.jpg,.png,${REAL_FILE_NAME_TYPE}`);
  }
});

test('het extra type is zelf geen foto of video, anders opent Chrome de fotokiezer toch', () => {
  assert.ok(!/^(image|video)\//.test(REAL_FILE_NAME_TYPE));
  assert.notEqual(REAL_FILE_NAME_TYPE, 'application/octet-stream', 'dan filtert de kiezer niets meer');
  // Een geldig MIME-type: één schuine streep, iets ervoor en erna.
  assert.match(REAL_FILE_NAME_TYPE, /^[a-z]+\/[a-z0-9.+-]+$/);
});

test('Android: een accept met al een ander type, of zonder accept, blijft zoals het is', () => {
  assert.equal(acceptWithRealFileNames('', ANDROID_CHROME), '');
  assert.equal(
    acceptWithRealFileNames('application/pdf,image/png,image/jpeg', ANDROID_CHROME),
    'application/pdf,image/png,image/jpeg',
  );
});

test('computer en iPhone: niets verandert, daar gaat de echte naam al mee', () => {
  for (const ua of [IPHONE, MAC_CHROME, '']) {
    assert.equal(acceptWithRealFileNames('image/jpeg,image/png,image/webp', ua), 'image/jpeg,image/png,image/webp');
    assert.equal(acceptWithRealFileNames('video/*', ua), 'video/*');
  }
});
