import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTeamTestRecipient } from './testRecipient.ts';

test('je eigen adres mag, ook met andere hoofdletters', () => {
  assert.equal(isTeamTestRecipient('Jan@Bedrijf.nl', 'jan@bedrijf.nl', []), true);
});

test('een actief teamlid mag', () => {
  assert.equal(isTeamTestRecipient('collega@bedrijf.nl', 'jan@bedrijf.nl', ['collega@bedrijf.nl']), true);
});

test('een willekeurig adres mag niet', () => {
  assert.equal(isTeamTestRecipient('iemand@elders.nl', 'jan@bedrijf.nl', ['collega@bedrijf.nl']), false);
  assert.equal(isTeamTestRecipient('', 'jan@bedrijf.nl', []), false);
  assert.equal(isTeamTestRecipient('iemand@elders.nl', undefined, []), false);
});
