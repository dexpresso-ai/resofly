/**
 * Tests voor verbindingsfouten en opnieuw proberen. Draaien met:  npm test
 *
 * Aanleiding: een galerij-upload op een telefoon. Viel de verbinding even weg,
 * dan kreeg de rest van de wachtrij "Failed to fetch", en één bestand "Niet
 * ingelogd." Het belangrijkste geval staat bij withRetry: een poging zonder
 * netwerk of met het scherm uit mag niet meetellen, anders is een upload na
 * een paar tellen scherm-uit alsnog verloren.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_LOST_MESSAGE,
  ConnectionError,
  HttpStatusError,
  isConnectionError,
  isRetryableError,
  messageFromResponseText,
  readableError,
  waitForConnection,
  withRetry,
  type Connectivity,
} from './networkRetry.ts';

/** Een nagebootst netwerk en scherm; `set` meldt de verandering zoals de browser dat doet. */
function fakeConnectivity(initial: { online: boolean; visible: boolean }) {
  const state = { ...initial };
  const listeners = new Set<() => void>();
  const connectivity: Connectivity = {
    online: () => state.online,
    visible: () => state.visible,
    watch: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    connectivity,
    listeners,
    set(next: Partial<typeof state>) {
      Object.assign(state, next);
      for (const listener of [...listeners]) listener();
    },
  };
}

const noSleep = async () => undefined;

test('herkent hoe elke browser een verbroken verbinding meldt', () => {
  assert.equal(isConnectionError(new TypeError('Failed to fetch')), true); // Chrome
  assert.equal(isConnectionError(new TypeError('Load failed')), true); // Safari
  assert.equal(isConnectionError(new TypeError('NetworkError when attempting to fetch resource.')), true); // Firefox
  assert.equal(isConnectionError(new TypeError('network error')), true); // Chrome, midden in een antwoord
  assert.equal(isConnectionError(new Error('The network connection was lost.')), true);
});

test('herkent een verbindingsfout van Supabase (database en inloggen)', () => {
  // postgrest-js maakt van de TypeError een gewoon object.
  assert.equal(isConnectionError({ message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }), true);
  // auth-js: verversen van het token lukte niet door het netwerk. Dat is geen uitlog.
  const authError = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
  assert.equal(isConnectionError(authError), true);
  assert.equal(isConnectionError(new ConnectionError()), true);
});

test('een gewone fout is geen verbindingsfout', () => {
  assert.equal(isConnectionError(new Error('Geen toegang tot deze galerij.')), false);
  assert.equal(isConnectionError({ message: 'duplicate key value violates unique constraint', code: '23505' }), false);
  assert.equal(isConnectionError(new Error('Je bent niet meer ingelogd. Log opnieuw in en probeer het nog eens.')), false);
  assert.equal(isConnectionError(null), false);
  assert.equal(isConnectionError(undefined), false);
});

test('opnieuw proberen alleen bij een tijdelijke serverfout', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 522]) {
    assert.equal(isRetryableError(new HttpStatusError('x', status)), true, `status ${status}`);
  }
  for (const status of [400, 401, 403, 404, 409, 413]) {
    assert.equal(isRetryableError(new HttpStatusError('x', status)), false, `status ${status}`);
  }
  assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryableError(new Error('Foto is groter dan 4 GB.')), false);
});

test('een foutpagina van Cloudflare wordt een zin in gewone woorden', () => {
  assert.equal(
    messageFromResponseText(502, '<!DOCTYPE html><html><body>Bad gateway</body></html>'),
    'De server is even niet bereikbaar (fout 502). Probeer het zo opnieuw.',
  );
  assert.equal(messageFromResponseText(404, ''), 'De server weigerde dit (fout 404).');
  assert.equal(messageFromResponseText(403, 'Geen toegang tot deze galerij.'), 'Geen toegang tot deze galerij.');
});

test('readableError: "Failed to fetch" wordt Nederlands, de rest blijft wat het was', () => {
  assert.equal(readableError(new TypeError('Failed to fetch'), 'Mislukt.'), CONNECTION_LOST_MESSAGE);
  assert.equal(readableError({ message: 'TypeError: Failed to fetch' }, 'Mislukt.'), CONNECTION_LOST_MESSAGE);
  assert.equal(readableError(new Error('Foto is groter dan 4 GB.'), 'Mislukt.'), 'Foto is groter dan 4 GB.');
  assert.equal(readableError({ message: 'Rij bestaat al.' }, 'Mislukt.'), 'Rij bestaat al.');
  assert.equal(readableError(undefined, 'Mislukt.'), 'Mislukt.');
  assert.equal(readableError(new Error('  '), 'Mislukt.'), 'Mislukt.');
});

test('withRetry: lukt na twee keer verbinding kwijt', async () => {
  const { connectivity } = fakeConnectivity({ online: true, visible: true });
  const slept: number[] = [];
  const retries: boolean[] = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('Failed to fetch');
    return 'gelukt';
  }, {
    connectivity,
    delaysMs: [10, 20, 30],
    sleep: async (ms) => { slept.push(ms); },
    onRetry: ({ waiting }) => retries.push(waiting),
  });
  assert.equal(result, 'gelukt');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [10, 20]);
  assert.deepEqual(retries, [false, false]);
});

test('withRetry: een fout die niet vanzelf overgaat, gaat meteen door', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new HttpStatusError('Geen toegang tot deze galerij.', 403);
    }, { sleep: noSleep }),
    /Geen toegang/,
  );
  assert.equal(calls, 1);
});

test('withRetry: geeft op na het aantal pogingen mét verbinding', async () => {
  const { connectivity } = fakeConnectivity({ online: true, visible: true });
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    }, { attempts: 4, connectivity, sleep: noSleep }),
    /Failed to fetch/,
  );
  assert.equal(calls, 4);
});

test('withRetry: pogingen met het scherm uit tellen niet mee, en de upload gaat verder als je terug bent', async () => {
  const net = fakeConnectivity({ online: true, visible: false });
  const retries: boolean[] = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    // Drie keer mislukt met het scherm uit (Android: ERR_NETWORK_IO_SUSPENDED).
    if (calls <= 3) {
      if (calls === 3) setTimeout(() => net.set({ visible: true }), 0);
      throw new TypeError('Failed to fetch');
    }
    return 'gelukt';
  }, {
    // Met maar één poging zou een getelde mislukking meteen fataal zijn.
    attempts: 1,
    connectivity: net.connectivity,
    sleep: noSleep,
    maxWaitMs: 5,
    onRetry: ({ waiting }) => retries.push(waiting),
  });
  assert.equal(result, 'gelukt');
  assert.equal(calls, 4);
  assert.deepEqual(retries, [true, true, true]);
  assert.equal(net.listeners.size, 0, 'luistert na afloop nergens meer naar');
});

test('withRetry: zonder netwerk telt een poging ook niet mee', async () => {
  const net = fakeConnectivity({ online: false, visible: true });
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      setTimeout(() => net.set({ online: true }), 0);
      throw new TypeError('Failed to fetch');
    }
    return 'gelukt';
  }, { attempts: 1, connectivity: net.connectivity, sleep: noSleep, maxWaitMs: 1_000 });
  assert.equal(result, 'gelukt');
  assert.equal(calls, 2);
});

test('waitForConnection: meteen klaar met verbinding en een zichtbaar scherm', async () => {
  const net = fakeConnectivity({ online: true, visible: true });
  await waitForConnection(60_000, net.connectivity);
  assert.equal(net.listeners.size, 0);
});

test('waitForConnection: wacht op het netwerk, en ruimt zijn luisteraar op', async () => {
  const net = fakeConnectivity({ online: false, visible: true });
  let done = false;
  const waiting = waitForConnection(60_000, net.connectivity).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(done, false);
  // Alleen het scherm aan is niet genoeg; het netwerk moet er ook zijn.
  net.set({ visible: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(done, false);
  net.set({ online: true });
  await waiting;
  assert.equal(done, true);
  assert.equal(net.listeners.size, 0);
});

test('waitForConnection: wacht nooit langer dan het maximum', async () => {
  const net = fakeConnectivity({ online: false, visible: false });
  const started = Date.now();
  await waitForConnection(20, net.connectivity);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(net.listeners.size, 0);
});
