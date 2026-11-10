import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatienceNote, formatElapsed, nextBuildPhase, type BuildPhase } from './reportBuild.ts';

// De bouwanimatie van een rapportage volgt de statusmeldingen van gerrie-agent.
// Getoetst: de vaste stap wint, het label is de terugval, en een melding zonder
// stap laat de voortgang staan (anders sprong de balk terug naar het begin).

test('de vaste stap uit de backend bepaalt de fase', () => {
  assert.equal(nextBuildPhase(0, { step: 'gegevens', label: 'Facturen ophalen…' }), 1);
  assert.equal(nextBuildPhase(1, { step: 'bouwen', label: 'Rapportage opbouwen… (5k tekens)' }), 2);
  assert.equal(nextBuildPhase(2, { step: 'controleren', label: 'Rapportage controleren…' }), 3);
  assert.equal(nextBuildPhase(2, { step: 'lezen', label: 'Gerrie denkt na…' }), 0);
});

test('een afgekeurde pagina gaat terug naar gegevens of bouwen', () => {
  assert.equal(nextBuildPhase(3, { step: 'gegevens', label: 'Gegevens berekenen…' }), 1);
  assert.equal(nextBuildPhase(3, { step: 'bouwen', label: 'Rapportage opbouwen…' }), 2);
});

test('zonder stap: het label als terugval', () => {
  assert.equal(nextBuildPhase(0, { label: 'Gegevens berekenen…' }), 1);
  assert.equal(nextBuildPhase(0, { label: 'Zoeken wat de app kan…' }), 1);
  assert.equal(nextBuildPhase(1, { label: 'Rapportage opbouwen… (12k tekens)' }), 2);
  assert.equal(nextBuildPhase(2, { label: 'Rapportage controleren…' }), 3);
});

test('een melding zonder stap laat de fase staan', () => {
  for (const prev of [0, 1, 2, 3] as BuildPhase[]) {
    assert.equal(nextBuildPhase(prev, { label: 'Gerrie werkt verder…' }), prev);
    assert.equal(nextBuildPhase(prev, { label: 'Gerrie rondt af…' }), prev);
    assert.equal(nextBuildPhase(prev, {}), prev);
  }
  // Een onbekende stap (een nieuwere backend) is geen reden om te springen.
  assert.equal(nextBuildPhase(2, { step: 'iets-nieuws', label: 'Gerrie werkt verder…' }), 2);
});

test('verstreken tijd in minuten en seconden', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(7_900), '0:07');
  assert.equal(formatElapsed(102_000), '1:42');
  assert.equal(formatElapsed(725_000), '12:05');
  assert.equal(formatElapsed(-500), '0:00');
  assert.equal(formatElapsed(Number.NaN), '0:00');
});

test('geruststelling pas als het lang duurt', () => {
  assert.equal(buildPatienceNote(30_000), null);
  assert.match(buildPatienceNote(61_000) ?? '', /paar minuten/);
  assert.match(buildPatienceNote(200_000) ?? '', /nog bezig/);
});
