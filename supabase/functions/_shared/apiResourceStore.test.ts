import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceStoreError, translateDbError } from './apiResourceStore.ts';
import { RESOURCES } from './apiResourceSpecs.ts';

/**
 * Een databasefout als antwoord voor een koppeling: de app-regels in gewone
 * taal, en de kale meldingen van Postgres (met tabel- en constraintnamen, of de
 * invoer erin herhaald) als een zin zonder interne details.
 */

const clients = RESOURCES.clients;

function translated(error: { code?: string; message?: string }): ResourceStoreError {
  const result = translateDbError(clients, error);
  assert.ok(result instanceof ResourceStoreError, `verwacht een ResourceStoreError, kreeg ${result}`);
  return result;
}

test('iets wat het portaal raakt zonder execute_high: 403, en dat ligt aan het toegangsniveau', () => {
  const error = translated({ code: 'RS403', message: 'Een reactie die de klant in het portaal ziet, is een bericht naar buiten.' });
  assert.equal(error.status, 403);
  assert.equal(error.code, 'insufficient_scope');
  assert.match(error.message, /portaal/);
});

test('een dubbele waarde: 409, zonder de naam van de constraint', () => {
  const error = translated({ code: '23505', message: 'duplicate key value violates unique constraint "clients_org_code_key"' });
  assert.equal(error.status, 409);
  assert.doesNotMatch(error.message, /constraint|clients_org/);
  // De eigen melding van een trigger (Nederlands) gaat wel door.
  assert.equal(translated({ code: '23505', message: 'Er bestaat al een klant met dit e-mailadres.' }).message, 'Er bestaat al een klant met dit e-mailadres.');
});

test('een ontbrekend verplicht veld: 422 met het veld, zonder tabelnaam', () => {
  const error = translated({ code: '23502', message: 'null value in column "name" of relation "clients" violates not-null constraint' });
  assert.equal(error.status, 422);
  assert.equal(error.field, 'name');
  assert.doesNotMatch(error.message, /relation|constraint/);
});

test('een waarde in de verkeerde vorm: 422 met het type, zonder de invoer te herhalen', () => {
  const error = translated({ code: '22P02', message: 'invalid input syntax for type uuid: "<script>"' });
  assert.equal(error.status, 422);
  assert.match(error.message, /uuid/);
  assert.doesNotMatch(error.message, /script/);
});

test('rechten: de kale RLS-melding wordt een zin, een eigen melding blijft', () => {
  assert.match(translated({ code: '42501', message: 'new row violates row-level security policy for table "clients"' }).message,
    /mag klanten niet wijzigen/);
  assert.equal(translated({ code: '42501', message: 'Je hebt geen schrijfrecht in de module Klanten.' }).message,
    'Je hebt geen schrijfrecht in de module Klanten.');
});

test('iets onbekends is een fout aan onze kant (500), geen 4xx met de databasetekst', () => {
  const result = translateDbError(clients, { code: '57014', message: 'canceling statement due to statement timeout' });
  assert.ok(!(result instanceof ResourceStoreError));
});
