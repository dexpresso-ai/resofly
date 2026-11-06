import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amsterdamToday, isBeforeAmsterdamToday } from './nlDate.ts';

/**
 * De edge functions draaien in UTC. Tussen middernacht en 01:00 (winter) of
 * 02:00 (zomer) is het in Nederland al de volgende dag; dan moet een datum van
 * gisteren voorbij zijn, ook al zegt UTC nog "vandaag".
 */

test('kort na middernacht in de winter is het in Nederland al de volgende dag', () => {
  const at = new Date('2026-11-06T23:30:00Z'); // 7 november, 00:30 in Nederland
  assert.equal(amsterdamToday(at), '2026-11-07');
  assert.equal(isBeforeAmsterdamToday('2026-11-06', at), true);
  assert.equal(isBeforeAmsterdamToday('2026-11-07', at), false);
});

test('in de zomer scheelt het twee uur', () => {
  const at = new Date('2026-07-01T22:30:00Z'); // 2 juli, 00:30 in Nederland
  assert.equal(amsterdamToday(at), '2026-07-02');
  assert.equal(isBeforeAmsterdamToday('2026-07-01', at), true);
  const avond = new Date('2026-07-01T21:30:00Z'); // 1 juli, 23:30 in Nederland
  assert.equal(isBeforeAmsterdamToday('2026-07-01', avond), false);
});

test('een tijdstempel telt op zijn datum; leeg of onleesbaar is nooit voorbij', () => {
  const at = new Date('2026-11-06T12:00:00Z');
  assert.equal(isBeforeAmsterdamToday('2026-11-05T23:59:59Z', at), true);
  assert.equal(isBeforeAmsterdamToday(null, at), false);
  assert.equal(isBeforeAmsterdamToday('', at), false);
  assert.equal(isBeforeAmsterdamToday('morgen', at), false);
});
