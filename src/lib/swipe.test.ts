/**
 * Tests voor het vegen in de lightbox van de galerij. Draaien met:  npm test
 *
 * Het belangrijkste geval is de tik: een vinger die een paar pixels beweegt
 * mag geen veeg worden, anders sluit een tik op de zwarte rand de foto niet
 * meer en bladert een onrustige hand per ongeluk door.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_SLOP_PX, swipeAxis, swipeStep, swipeVelocity } from './swipe.ts';

test('swipeAxis: binnen de dode zone is het nog een tik', () => {
  assert.equal(swipeAxis(0, 0), null);
  assert.equal(swipeAxis(3, -4), null);
  assert.equal(swipeAxis(SWIPE_SLOP_PX - 1, 0), null);
});

test('swipeAxis: daarbuiten wint de grootste beweging', () => {
  assert.equal(swipeAxis(-20, 5), 'x');
  assert.equal(swipeAxis(12, -3), 'x');
  assert.equal(swipeAxis(4, 15), 'y');
  // Precies schuin is geen bladerbeweging.
  assert.equal(swipeAxis(10, 10), 'y');
});

test('swipeVelocity: meet het eind van de veeg, niet het gemiddelde', () => {
  assert.equal(swipeVelocity([]), 0);
  assert.equal(swipeVelocity([{ x: 100, t: 0 }]), 0);
  // Eerst 400 ms stil, dan in 80 ms 60 px naar links.
  const samples = [
    { x: 300, t: 0 }, { x: 301, t: 200 }, { x: 300, t: 400 },
    { x: 280, t: 430 }, { x: 260, t: 455 }, { x: 240, t: 480 },
  ];
  assert.ok(Math.abs(swipeVelocity(samples) - (-60 / 80)) < 1e-9);
  // Over de hele veeg gemiddeld zou dat maar 0,125 px/ms zijn.
  assert.ok(Math.abs(swipeVelocity(samples, undefined, 10_000) - (-60 / 480)) < 1e-9);
});

test('swipeVelocity: losgelaten vlak na de laatste beweging telt de zwiep', () => {
  const samples = [{ x: 234, t: 0 }, { x: 217, t: 40 }, { x: 200, t: 80 }, { x: 184, t: 120 }];
  assert.ok(swipeVelocity(samples, 144) < -0.35);
});

test('swipeVelocity: eerst stilgehouden en dan losgelaten is geen zwiep', () => {
  const samples = [{ x: 234, t: 0 }, { x: 200, t: 40 }, { x: 160, t: 80 }];
  assert.equal(swipeVelocity(samples, 300), 0);
});

test('swipeStep: ver genoeg slepen bladert, ook langzaam', () => {
  // Telefoon van 390 px: een vijfde is 78 px.
  assert.equal(swipeStep({ dx: -90, dy: 4, velocity: -0.05, width: 390 }), 1);
  assert.equal(swipeStep({ dx: 90, dy: -4, velocity: 0.05, width: 390 }), -1);
  assert.equal(swipeStep({ dx: -60, dy: 0, velocity: -0.05, width: 390 }), 0);
  // Stilgehouden voor het loslaten: de afstand telt nog steeds.
  assert.equal(swipeStep({ dx: -90, dy: 0, velocity: 0, width: 390 }), 1);
});

test('swipeStep: op een breed scherm is 120 px genoeg', () => {
  assert.equal(swipeStep({ dx: -125, dy: 0, velocity: 0, width: 1920 }), 1);
  assert.equal(swipeStep({ dx: -100, dy: 0, velocity: 0, width: 1920 }), 0);
});

test('swipeStep: een korte snelle zwiep bladert', () => {
  assert.equal(swipeStep({ dx: -45, dy: 3, velocity: -0.5, width: 390 }), 1);
  assert.equal(swipeStep({ dx: 45, dy: 3, velocity: 0.5, width: 390 }), -1);
  // Snel maar te kort: dat is een schok van de hand, geen veeg.
  assert.equal(swipeStep({ dx: -20, dy: 0, velocity: -1, width: 390 }), 0);
});

test('swipeStep: ver weggesleept maar teruggezwiept blijft staan', () => {
  assert.equal(swipeStep({ dx: -150, dy: 0, velocity: 0.6, width: 390 }), 0);
  assert.equal(swipeStep({ dx: 150, dy: 0, velocity: -0.6, width: 390 }), 0);
});

test('swipeStep: meer op en neer dan opzij bladert nooit', () => {
  assert.equal(swipeStep({ dx: -100, dy: 140, velocity: -1, width: 390 }), 0);
  assert.equal(swipeStep({ dx: 80, dy: -80, velocity: 1, width: 390 }), 0);
});
