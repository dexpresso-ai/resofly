import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as app from './marketingRules.ts';
import * as server from '../../supabase/functions/_shared/marketingRules.ts';

// Het scherm toont "Weer toestaan" alleen waar de database het toestaat. Lopen
// de twee kopieën uit elkaar, dan krijgt iemand een knop die niets doet, of
// (erger) mist de waarschuwing waar hij hoort.
const REDENEN = ['manual', 'bounced', 'unsubscribed', 'complained', 'onbekend', '', null, undefined];

test('scherm en server zijn het eens over welke blokkering het team mag opheffen', () => {
  for (const reden of REDENEN) {
    assert.equal(app.suppressionRemovableByTeam(reden), server.suppressionRemovableByTeam(reden), `reden ${String(reden)}`);
    assert.equal(app.suppressionLockedMessage(reden), server.suppressionLockedMessage(reden), `melding bij ${String(reden)}`);
  }
});

test('de database laat precies dezelfde redenen weghalen', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261107140000_marketing_afmelden_en_afzender.sql', import.meta.url), 'utf8');
  const policy = sql.match(/create policy "email suppressions delete"[\s\S]*?;/);
  assert.ok(policy, 'de delete-policy op email_suppressions ontbreekt in de migratie');
  const toegestaan = [...policy[0].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  const volgensRegel = REDENEN.filter((r): r is string => typeof r === 'string' && app.suppressionRemovableByTeam(r)).sort();
  assert.deepEqual(toegestaan, volgensRegel);
});
