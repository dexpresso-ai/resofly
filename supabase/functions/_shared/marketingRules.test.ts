import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIALIZE_GRACE_MINUTES, releasedRecipientStatus, singleLine,
  suppressionLockedMessage, suppressionRemovableByTeam,
} from './marketingRules.ts';

test('het team kan alleen een eigen blokkade of een bounce opheffen', () => {
  assert.equal(suppressionRemovableByTeam('manual'), true);
  assert.equal(suppressionRemovableByTeam('bounced'), true);
  assert.equal(suppressionRemovableByTeam('unsubscribed'), false);
  assert.equal(suppressionRemovableByTeam('complained'), false);
  // Een reden die de code niet kent, ligt vast: liever te streng dan iemand
  // opnieuw mailen die dat niet wil.
  assert.equal(suppressionRemovableByTeam('iets-nieuws'), false);
  assert.equal(suppressionRemovableByTeam(null), false);
  assert.equal(suppressionRemovableByTeam(undefined), false);
});

test('de melding zegt waarom een blokkering vastligt', () => {
  assert.match(suppressionLockedMessage('complained'), /spam/);
  assert.match(suppressionLockedMessage('unsubscribed'), /zelf afgemeld/);
});

test('opgepakte maar onverstuurde ontvangers: terug in de rij bij pauze, overgeslagen bij annuleren', () => {
  assert.equal(releasedRecipientStatus('paused'), 'pending');
  assert.equal(releasedRecipientStatus('cancelled'), 'skipped');
  // Campagne verwijderd of onbekend: die mail gaat nooit meer uit.
  assert.equal(releasedRecipientStatus(null), 'skipped');
  assert.equal(releasedRecipientStatus('sent'), 'skipped');
});

test('een onderwerp blijft één regel', () => {
  assert.equal(singleLine('Hallo Jan\r\nBcc: iemand@elders.nl'), 'Hallo Jan Bcc: iemand@elders.nl');
  assert.equal(singleLine('Nieuws voor\n\n  Bakkerij de Vries  '), 'Nieuws voor Bakkerij de Vries  ');
  assert.equal(singleLine('Gewoon een onderwerp'), 'Gewoon een onderwerp');
});

test('de wachttijd voor het klaarzetten ligt ruim boven de looptijd van een edge function', () => {
  assert.ok(MATERIALIZE_GRACE_MINUTES * 60 > 400);
});
