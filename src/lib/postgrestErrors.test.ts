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
import { isMissingColumn, isMissingRelation, NotMigratedError } from './postgrestErrors.ts';

test('isMissingRelation herkent de foutcodes van een ontbrekende tabel of view', () => {
  assert.equal(isMissingRelation({ code: '42P01' }), true);
  assert.equal(isMissingRelation({ code: 'PGRST205' }), true);
});

test('isMissingRelation herkent de twee teksten die PostgREST en Postgres geven', () => {
  assert.equal(isMissingRelation({ message: 'Could not find the table \'public.foo\' in the schema cache' }), true);
  assert.equal(isMissingRelation({ message: 'relation "public.foo" does not exist' }), true);
});

test('een ontbrekende KOLOM of FUNCTIE is geen ontbrekende tabel', () => {
  // Dit was de bug: beide zinnen bevatten "does not exist", en op dat losse
  // stukje tekst matchen maakte een kapotte deploy visueel identiek aan een
  // ongemigreerde — én verborg levende AI-koppelingen inclusief hun
  // intrekknop, omdat mcp_grants.scope_ceiling in een tussenstand ontbrak.
  assert.equal(isMissingRelation({ code: '42703', message: 'column mcp_grants.scope_ceiling does not exist' }), false);
  assert.equal(isMissingRelation({ code: '42883', message: 'function public.search_client_emails(uuid, text, integer) does not exist' }), false);
  assert.equal(isMissingRelation({ message: 'column client_email_threads.foo does not exist' }), false);
});

test('een écht ontbrekende tabel of view wordt nog steeds herkend', () => {
  assert.equal(isMissingRelation({ code: '42P01', message: 'relation "public.client_calls" does not exist' }), true);
  assert.equal(isMissingRelation({ message: 'relation "public.client_calls" does not exist' }), true);
  assert.equal(isMissingRelation({ message: 'ERROR: relation public.foo does not exist' }), true);
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

test('isMissingColumn herkent de twee manieren waarop een kolom kan ontbreken', () => {
  // Postgres zelf, en dezelfde constatering uit de schema-cache van PostgREST.
  assert.equal(isMissingColumn({ code: '42703', message: 'column "share_token" of relation "galleries" does not exist' }, 'share_token'), true);
  assert.equal(isMissingColumn({ code: 'PGRST204', message: "Could not find the 'share_token' column of 'galleries' in the schema cache" }, 'share_token'), true);
});

test('isMissingColumn geldt alleen voor de kolom waar de aanroeper op rekent', () => {
  // Anders vangt een terugval op "zonder share_token" ook het geval af waarin
  // een heel ander veld ontbreekt — en dan verdwijnt een echte fout stilletjes.
  assert.equal(isMissingColumn({ code: '42703', message: 'column "share_pin_hash" of relation "galleries" does not exist' }, 'share_token'), false);
  assert.equal(isMissingColumn({ code: '42P01', message: 'relation "public.galleries" does not exist' }, 'share_token'), false);
  assert.equal(isMissingColumn({ code: '42501', message: 'permission denied for table galleries' }, 'share_token'), false);
  assert.equal(isMissingColumn(null, 'share_token'), false);
  assert.equal(isMissingColumn(undefined, 'share_token'), false);
  assert.equal(isMissingColumn({}, 'share_token'), false);
});

test('isMissingColumn trapt niet in de zin van een ontbrekende tabel', () => {
  // Die zin bevat de tabelnaam, dus zonder de codecontrole zou een ontbrekende
  // tabel hier als "kolom ontbreekt" doorgaan — en dan zou een terugval de
  // opdracht nog een keer proberen in een database waar de tabel niet bestaat.
  assert.equal(isMissingColumn({ code: '42P01', message: 'relation "public.galleries" does not exist' }, 'galleries'), false);
});
