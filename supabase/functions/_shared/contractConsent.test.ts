import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_CONSENT_TEXT as serverText } from './contractTokens.ts';
import { CONTRACT_CONSENT_TEXT as pageText } from '../../../src/lib/contractTokens.ts';

test('de ondertekenpagina toont precies de akkoordtekst die de server vastlegt', () => {
  assert.equal(pageText, serverText);
  assert.match(serverText, /ga ermee akkoord/);
});
