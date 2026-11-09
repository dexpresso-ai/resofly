import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_TOKEN_STORAGE_KEY, isPortalTokenValue, onPortalTokenChange, portalTokenMode, storePortalToken, storedPortalToken,
} from './portalToken.ts';

/** Een browser in het klein: localStorage en storage-events. */
function fakeWindow() {
  const data = new Map<string, string>();
  const handlers = new Set<(event: { key: string | null }) => void>();
  const win = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
      removeItem: (key: string) => { data.delete(key); },
    },
    addEventListener: (_type: string, handler: (event: { key: string | null }) => void) => { handlers.add(handler); },
    removeEventListener: (_type: string, handler: (event: { key: string | null }) => void) => { handlers.delete(handler); },
    /** Zoals een ander tabblad dat de sleutel wijzigt. */
    fire: (key: string | null) => { for (const handler of handlers) handler({ key }); },
    data,
    handlers,
  };
  (globalThis as { window?: unknown }).window = win;
  return win;
}

const SLEUTEL = 'Ab3_kQ9-xYz12345678901234567890abcdefghijk';

test('isPortalTokenValue: alleen wat de server maakt', () => {
  assert.equal(isPortalTokenValue(SLEUTEL), true);
  for (const value of ['kort', `${SLEUTEL}=`, `<script>${SLEUTEL}`, 'a'.repeat(101), null, 42]) assert.equal(isPortalTokenValue(value), false, String(value));
});

test('de sleutel bewaren, lezen en weggooien; wat er raar op schijf staat telt niet', () => {
  const win = fakeWindow();
  assert.equal(storedPortalToken(), null);
  storePortalToken(SLEUTEL);
  assert.equal(win.data.get(PORTAL_TOKEN_STORAGE_KEY), SLEUTEL);
  assert.equal(storedPortalToken(), SLEUTEL);
  win.data.set(PORTAL_TOKEN_STORAGE_KEY, 'iets-anders');
  assert.equal(storedPortalToken(), null, 'een rare waarde is geen sleutel');
  storePortalToken(null);
  assert.equal(win.data.has(PORTAL_TOKEN_STORAGE_KEY), false);
  storePortalToken('<geen sleutel>');
  assert.equal(win.data.has(PORTAL_TOKEN_STORAGE_KEY), false, 'een rare waarde wordt niet bewaard');
});

test('wie luistert, hoort het: in dit tabblad en uit een ander', () => {
  const win = fakeWindow();
  let gehoord = 0;
  const stop = onPortalTokenChange(() => { gehoord += 1; });
  storePortalToken(SLEUTEL);
  storePortalToken(null);
  assert.equal(gehoord, 2);
  win.fire(PORTAL_TOKEN_STORAGE_KEY);
  win.fire('iets.anders');
  win.fire(null);
  assert.equal(gehoord, 4, 'alleen de sleutel zelf, of alles gewist');
  stop();
  storePortalToken(SLEUTEL);
  win.fire(PORTAL_TOKEN_STORAGE_KEY);
  assert.equal(gehoord, 4, 'na stoppen niets meer');
  assert.equal(win.handlers.size, 0);
});

test('zonder pagina (zoals hier) geen sleutelmodus', () => {
  assert.equal(portalTokenMode(), false);
});
