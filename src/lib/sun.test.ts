/**
 * Tests voor de zonnemodule (thema "Met de zon mee" en de Dagboog). Draaien met:  npm test
 *
 * De referentietijden komen uit de NOAA-rekenmodule voor Lopik op 22 oktober
 * 2026 (zomertijd, UTC+2): op 08:15, zenit 13:25, onder 18:34. Een paar minuten
 * speling, want de formule is een benadering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, isDaylight, nextSunChange, sunTimes } from './sun.ts';

const LOPIK = { lat: 51.97, lon: 4.94 };
const near = (actual: number, expected: number, slack = 4) =>
  assert.ok(Math.abs(actual - expected) <= slack, `verwacht ${formatClock(expected)}, kreeg ${formatClock(actual)}`);

test('zon op, zenit en zon onder in Lopik op 22 oktober (zomertijd)', () => {
  const t = sunTimes(new Date(2026, 9, 22, 12), LOPIK, 120);
  near(t.rise, 8 * 60 + 15);
  near(t.noon, 13 * 60 + 25);
  near(t.set, 18 * 60 + 34);
});

test('midzomer in Utrecht: lange dag, zon onder na tien uur', () => {
  const t = sunTimes(new Date(2026, 5, 21, 12), undefined, 120);
  assert.ok(t.rise < 5 * 60 + 25 && t.rise > 5 * 60, `zon op ${formatClock(t.rise)}`);
  assert.ok(t.set > 21 * 60 + 55 && t.set < 22 * 60 + 15, `zon onder ${formatClock(t.set)}`);
});

test('midwinter in Utrecht: korte dag (wintertijd)', () => {
  const t = sunTimes(new Date(2026, 11, 21, 12), undefined, 60);
  assert.ok(t.rise > 8 * 60 + 40 && t.rise < 8 * 60 + 55, `zon op ${formatClock(t.rise)}`);
  assert.ok(t.set > 16 * 60 + 20 && t.set < 16 * 60 + 35, `zon onder ${formatClock(t.set)}`);
});

test('poolnacht en middernachtzon geven een hele dag nacht of dag', () => {
  const winter = sunTimes(new Date(2026, 11, 21, 12), { lat: 78.2, lon: 15.6 }, 60);
  assert.equal(winter.rise, winter.set);
  const summer = sunTimes(new Date(2026, 5, 21, 12), { lat: 78.2, lon: 15.6 }, 120);
  assert.equal(summer.rise, 0);
  assert.equal(summer.set, 1440);
});

test('dag of nacht, en het volgende omslagpunt, in de wandklok van de browser', () => {
  const noon = new Date(2026, 9, 22, 13, 0);
  const night = new Date(2026, 9, 22, 23, 30);
  assert.equal(isDaylight(noon), true);
  assert.equal(isDaylight(night), false);
  // Het volgende omslagpunt ligt na het moment zelf, en binnen een etmaal.
  for (const moment of [noon, night, new Date(2026, 9, 22, 4, 0)]) {
    const next = nextSunChange(moment);
    assert.ok(next > moment, `${next.toISOString()} ligt niet na ${moment.toISOString()}`);
    assert.ok(next.getTime() - moment.getTime() <= 24 * 3600e3);
    assert.notEqual(isDaylight(new Date(next.getTime() + 60e3)), isDaylight(moment));
  }
});

test('klokweergave', () => {
  assert.equal(formatClock(495.2), '08:15');
  assert.equal(formatClock(1440 + 61), '01:01');
  assert.equal(formatClock(-30), '23:30');
});
