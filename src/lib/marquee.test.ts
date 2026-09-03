/**
 * Tests voor het selectiekader in de verkenner. Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxesIntersect, clampPoint, combineMarquee, edgeScrollSpeed, hitKeys, marqueeBox, marqueeMode, passedThreshold,
  type Box,
} from './marquee.ts';

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

test('het kader is hetzelfde, welke kant je ook op sleept', () => {
  assert.deepEqual(marqueeBox({ x: 10, y: 10 }, { x: 50, y: 40 }), box(10, 10, 50, 40));
  assert.deepEqual(marqueeBox({ x: 50, y: 40 }, { x: 10, y: 10 }), box(10, 10, 50, 40));
  assert.deepEqual(marqueeBox({ x: 10, y: 40 }, { x: 50, y: 10 }), box(10, 10, 50, 40));
});

test('raken: overlap telt, een gedeelde rand niet', () => {
  assert.ok(boxesIntersect(box(0, 0, 10, 10), box(5, 5, 20, 20)));
  assert.ok(boxesIntersect(box(0, 0, 100, 100), box(20, 20, 30, 30)), 'helemaal erin');
  assert.ok(!boxesIntersect(box(0, 0, 10, 10), box(10, 0, 20, 10)), 'alleen de rand');
  assert.ok(!boxesIntersect(box(0, 0, 10, 10), box(0, 11, 10, 20)));
});

test('de rijen die het kader raakt komen terug in lijstvolgorde', () => {
  const rijen = [
    { key: 'a', box: box(0, 0, 500, 47) },
    { key: 'b', box: box(0, 47, 500, 94) },
    { key: 'c', box: box(0, 94, 500, 141) },
  ];
  assert.deepEqual(hitKeys(box(300, 60, 320, 120), rijen), ['b', 'c']);
  assert.deepEqual(hitKeys(box(300, 200, 320, 260), rijen), []);
});

test('Windows-toetsen: gewoon vervangt, Shift voegt toe, Ctrl schakelt om', () => {
  assert.equal(marqueeMode({ ctrlKey: false, metaKey: false, shiftKey: false }), 'replace');
  assert.equal(marqueeMode({ ctrlKey: false, metaKey: false, shiftKey: true }), 'add');
  assert.equal(marqueeMode({ ctrlKey: true, metaKey: false, shiftKey: false }), 'toggle');
  assert.equal(marqueeMode({ ctrlKey: false, metaKey: true, shiftKey: false }), 'toggle', '⌘ op een Mac');
  assert.equal(marqueeMode({ ctrlKey: true, metaKey: false, shiftKey: true }), 'toggle', 'Ctrl wint van Shift');
});

test('vervangen negeert wat er al aanstond', () => {
  assert.deepEqual([...combineMarquee(new Set(['x']), ['a', 'b'], 'replace')], ['a', 'b']);
  assert.deepEqual([...combineMarquee(new Set(['x']), [], 'replace')], []);
});

test('toevoegen houdt de oude selectie en zet de geraakte rijen erbij', () => {
  assert.deepEqual([...combineMarquee(new Set(['x']), ['a', 'x'], 'add')].sort(), ['a', 'x']);
});

test('omschakelen keert de geraakte rijen om ten opzichte van het uitgangspunt — niet cumulatief', () => {
  const basis = new Set(['a', 'x']);
  assert.deepEqual([...combineMarquee(basis, ['a', 'b'], 'toggle')].sort(), ['b', 'x']);
  // Het kader krimpt weer: 'a' loopt eruit en staat weer gewoon aan, 'b' valt af.
  assert.deepEqual([...combineMarquee(basis, [], 'toggle')].sort(), ['a', 'x']);
});

test('een klik wordt pas een sleep na een paar pixels', () => {
  assert.ok(!passedThreshold({ x: 10, y: 10 }, { x: 12, y: 13 }));
  assert.ok(passedThreshold({ x: 10, y: 10 }, { x: 14, y: 10 }));
  assert.ok(passedThreshold({ x: 10, y: 10 }, { x: 10, y: 4 }));
});

test('automatisch scrollen: stil in het midden, sneller naarmate je verder voorbij de rand zit, met een plafond', () => {
  assert.equal(edgeScrollSpeed(300, 0, 600), 0);
  assert.ok(edgeScrollSpeed(10, 0, 600) < 0, 'bovenaan → omhoog');
  assert.ok(edgeScrollSpeed(595, 0, 600) > 0, 'onderaan → omlaag');
  assert.ok(edgeScrollSpeed(-40, 0, 600) < edgeScrollSpeed(10, 0, 600), 'verder voorbij de rand is sneller');
  assert.equal(edgeScrollSpeed(-1000, 0, 600), -18, 'plafond omhoog');
  assert.equal(edgeScrollSpeed(2000, 0, 600), 18, 'plafond omlaag');
});

test('het kader blijft binnen de inhoud', () => {
  assert.deepEqual(clampPoint({ x: -5, y: 900 }, { width: 400, height: 600 }), { x: 0, y: 600 });
  assert.deepEqual(clampPoint({ x: 20, y: 30 }, { width: 400, height: 600 }), { x: 20, y: 30 });
});
