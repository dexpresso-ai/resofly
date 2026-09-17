/**
 * Tests voor het onderscheid "er is iets stuk" versus "de migratie is hier nog
 * niet gedraaid". Draaien met:  npm test
 *
 * Dit onderscheid bepaalt of een gebruiker een rode foutmelding ziet of een
 * rustige regel. Wordt het te breed, dan verdwijnt een échte fout stilletjes;
 * te smal, en het scherm kleurt rood terwijl er niets mis is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRelation, NotMigratedError } from './postgrestErrors.ts';

test('isMissingRelation herkent de foutcodes van een ontbrekende tabel of view', () => {
  assert.equal(isMissingRelation({ code: '42P01' }), true);
  assert.equal(isMissingRelation({ code: 'PGRST205' }), true);
});

test('isMissingRelation herkent de twee teksten die PostgREST en Postgres geven', () => {
  assert.equal(isMissingRelation({ message: 'Could not find the table \'public.foo\' in the schema cache' }), true);
  assert.equal(isMissingRelation({ message: 'relation "public.foo" does not exist' }), true);
});

test('isMissingRelation laat een echte fout een echte fout blijven', () => {
  assert.equal(isMissingRelation({ code: '42501', message: 'permission denied for table foo' }), false);
  assert.equal(isMissingRelation({ code: 'PGRST301', message: 'JWT expired' }), false);
  assert.equal(isMissingRelation({ message: 'Failed to fetch' }), false);
  assert.equal(isMissingRelation({}), false);
  assert.equal(isMissingRelation(null), false);
  assert.equal(isMissingRelation(undefined), false);
});

test('NotMigratedError is als zodanig te herkennen', () => {
  const error = new NotMigratedError();
  assert.ok(error instanceof NotMigratedError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'NotMigratedError');
  assert.match(error.message, /nog niet/);
});
