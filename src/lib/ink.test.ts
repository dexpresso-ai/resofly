/**
 * Tests voor het inktmodel van handgeschreven notities. Draaien met:  npm test
 *
 * Het model is het contract tussen de canvas-editor, de miniaturen en de
 * database: een opgeslagen handschrift moet na een rondreis door JSON precies
 * dezelfde lijnen opleveren, kapotte data mag de editor nooit laten crashen,
 * en de gum mag alleen weghalen wat hij daadwerkelijk raakt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INK_DEFAULT_PRESSURE,
  INK_MAX_JSON_LENGTH,
  INK_PAGE_HEIGHT,
  INK_PAGE_WIDTH,
  createInkDocument,
  densifyPoints,
  distanceToSegment,
  drawPage,
  eraseAlong,
  eraseAt,
  inkColorHex,
  inkPageCount,
  inkSizeIssue,
  inkStrokeCount,
  isInkEmpty,
  parseInkDocument,
  pointsFromFlat,
  serializeInkDocument,
  simplifyPoints,
  strokeBounds,
  strokeHits,
  strokeWidthAt,
  traceStrokeOutline,
  type InkContext,
  type InkDocument,
  type InkStroke,
} from './ink.ts';

function stroke(points: number[], extra: Partial<InkStroke> = {}): InkStroke {
  return { id: extra.id ?? 'l1', tool: extra.tool ?? 'pen', color: extra.color ?? 'ink', width: extra.width ?? 3.6, points };
}

/** Een naspeel-context die alleen bijhoudt wat er getekend werd. */
function fakeContext() {
  const calls: string[] = [];
  const fills: string[] = [];
  const ctx: InkContext = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'round', lineJoin: 'round', globalAlpha: 1,
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    quadraticCurveTo: () => calls.push('quad'),
    arc: () => calls.push('arc'),
    closePath: () => calls.push('closePath'),
    fill: () => { calls.push('fill'); fills.push(`${String(ctx.fillStyle)}@${ctx.globalAlpha}`); },
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
  };
  return { ctx, calls, fills };
}

test('een nieuw document heeft één lege pagina op A4-verhouding', () => {
  const doc = createInkDocument('dotted');
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0].paper, 'dotted');
  assert.equal(doc.width, INK_PAGE_WIDTH);
  assert.equal(doc.height, INK_PAGE_HEIGHT);
  assert.equal(isInkEmpty(doc), true);
  assert.equal(inkPageCount(doc), 0);
});

test('serialiseren en teruglezen bewaart lijnen, kleuren en papier', () => {
  const doc = createInkDocument('lined');
  doc.pages[0].strokes.push(stroke([10.123, 20.456, 0.5123, 30, 40, 0.9], { color: 'blue', width: 2.25 }));
  doc.pages[0].strokes.push(stroke([100, 100, 1, 120, 100, 1], { id: 'm1', tool: 'highlighter', color: 'gold', width: 24 }));
  const roundTrip = parseInkDocument(JSON.stringify(serializeInkDocument(doc)));
  assert.equal(roundTrip.pages.length, 1);
  assert.equal(roundTrip.pages[0].paper, 'lined');
  assert.equal(roundTrip.pages[0].strokes.length, 2);
  const [pen, marker] = roundTrip.pages[0].strokes;
  assert.equal(pen.color, 'blue');
  assert.equal(pen.width, 2.3);
  assert.deepEqual(pen.points, [10.1, 20.5, 0.51, 30, 40, 0.9]);
  assert.equal(marker.tool, 'highlighter');
  assert.equal(marker.id, 'm1');
  assert.equal(inkStrokeCount(roundTrip), 2);
  assert.equal(inkPageCount(roundTrip), 1);
});

test('kapotte of vreemde opslag wordt een bruikbaar document', () => {
  assert.equal(parseInkDocument(null).pages.length, 1);
  assert.equal(parseInkDocument('geen json').pages.length, 1);
  assert.equal(parseInkDocument({ pages: 'nee' }).pages.length, 1);
  const doc = parseInkDocument({
    version: 99, width: 'breed', pages: [
      { paper: 'perkament', strokes: [
        { tool: 'kwast', color: 'oranje', width: 999, points: [1, 2, 3, 'x', 5, 6, 7, 8, 0.4] },
        { points: [] },
        null,
      ] },
      'geen pagina',
    ],
  });
  assert.equal(doc.width, INK_PAGE_WIDTH, 'onbruikbare breedte valt terug op de standaard');
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0].paper, 'lined', 'onbekend papier valt terug op gelinieerd');
  assert.equal(doc.pages[0].strokes.length, 1, 'lege en kapotte lijnen vallen weg');
  const s = doc.pages[0].strokes[0];
  assert.equal(s.tool, 'pen');
  assert.equal(s.color, 'ink');
  assert.equal(s.width, 60, 'dikte wordt begrensd');
  assert.deepEqual(s.points, [1, 2, 1, 7, 8, 0.4], 'een punt met een niet-numerieke coördinaat wordt overgeslagen, druk wordt begrensd');
  assert.ok(s.id.length > 0);
});

test('pointsFromFlat leest triples en negeert een losse rest', () => {
  assert.deepEqual(pointsFromFlat([1, 2, 0.5, 3, 4, 0.7, 9]), [{ x: 1, y: 2, p: 0.5 }, { x: 3, y: 4, p: 0.7 }]);
  assert.deepEqual(pointsFromFlat([]), []);
});

test('simplifyPoints laat stilstaande samples weg maar houdt begin en eind', () => {
  const points = [0, 0, 0.5, 0.1, 0.1, 0.5, 0.2, 0.1, 0.5, 5, 5, 0.6, 5.1, 5, 0.6, 5.2, 5.1, 0.6];
  const simplified = simplifyPoints(points, 0.8);
  assert.deepEqual(simplified, [0, 0, 0.5, 5, 5, 0.6, 5.2, 5.1, 0.6]);
  assert.deepEqual(simplifyPoints([1, 1, 1]), [1, 1, 1]);
  assert.deepEqual(simplifyPoints([]), []);
});

test('de druk moduleert de pendikte; de markeerstift blijft constant', () => {
  const pen = stroke([0, 0, 0.5], { width: 4 });
  assert.ok(strokeWidthAt(pen, 0) < strokeWidthAt(pen, 0.5));
  assert.ok(strokeWidthAt(pen, 0.5) < strokeWidthAt(pen, 1));
  assert.ok(Math.abs(strokeWidthAt(pen, 0.5) - 4.1) < 0.01);
  assert.equal(strokeWidthAt(pen, Number.NaN), strokeWidthAt(pen, INK_DEFAULT_PRESSURE));
  const marker = stroke([0, 0, 0.5], { tool: 'highlighter', width: 24 });
  assert.equal(strokeWidthAt(marker, 0.1), 24);
  assert.equal(strokeWidthAt(marker, 1), 24);
});

test('strokeBounds omvat de lijn inclusief de dikte', () => {
  const b = strokeBounds(stroke([10, 20, 0.5, 30, 5, 0.5], { width: 2 }));
  assert.deepEqual(b, { minX: 8, minY: 3, maxX: 32, maxY: 22 });
});

test('distanceToSegment meet loodrecht op het lijnstuk en naar de uiteinden erbuiten', () => {
  assert.equal(distanceToSegment(5, 3, 0, 0, 10, 0), 3);
  assert.equal(distanceToSegment(-4, 0, 0, 0, 10, 0), 4);
  assert.equal(distanceToSegment(2, 2, 1, 1, 1, 1), Math.hypot(1, 1), 'een lijnstuk van lengte nul is een punt');
});

test('de gum raakt alleen lijnen op zijn pad — ook tussen twee samples in', () => {
  const doc = createInkDocument();
  const horizontal = stroke([0, 100, 0.5, 200, 100, 0.5], { id: 'h', width: 2 });
  const farAway = stroke([0, 500, 0.5, 200, 500, 0.5], { id: 'v', width: 2 });
  doc.pages[0].strokes.push(horizontal, farAway);
  assert.equal(strokeHits(horizontal, 100, 104, 5), true, 'midden tussen de twee samples, net binnen bereik');
  assert.equal(strokeHits(horizontal, 100, 130, 5), false);
  const untouched = eraseAt(doc.pages[0], 100, 300, 10);
  assert.equal(untouched, doc.pages[0], 'niets geraakt: dezelfde pagina terug');
  const erased = eraseAt(doc.pages[0], 100, 104, 5);
  assert.deepEqual(erased.strokes.map(s => s.id), ['v']);
  const swept = eraseAlong(doc.pages[0], 100, 0, 100, 600, 6);
  assert.equal(swept.strokes.length, 0, 'een veeg dwars over beide lijnen gumt ze allebei');
  const dot = stroke([50, 50, 0.5], { id: 'd', width: 4 });
  assert.equal(strokeHits(dot, 53, 50, 1.5), true, 'een enkel punt telt als een stip');
  assert.equal(strokeHits(dot, 60, 50, 1.5), false);
});

test('tekenen: papier eerst, dan markeerstift, dan pen — elke lijn één vulling', () => {
  const doc = createInkDocument('lined');
  doc.pages[0].strokes.push(stroke([10, 10, 0.5, 50, 20, 0.6, 90, 10, 0.4], { id: 'pen', color: 'red' }));
  doc.pages[0].strokes.push(stroke([10, 40, 1, 90, 40, 1], { id: 'marker', tool: 'highlighter', color: 'gold', width: 24 }));
  const { ctx, calls, fills } = fakeContext();
  drawPage(ctx, doc, doc.pages[0], 1, 'light');
  assert.equal(calls[0], 'save');
  assert.ok(calls.indexOf('fillRect') < calls.indexOf('fill'), 'het papier gaat onder de lijnen');
  assert.equal(fills.length, 2);
  assert.equal(fills[0], `${inkColorHex('gold', 'light')}@0.38`, 'de markeerstift eerst, doorzichtig');
  assert.equal(fills[1], `${inkColorHex('red', 'light')}@1`, 'daarna de pen, dekkend');
  assert.equal(inkColorHex('ink', 'dark'), '#F4F1EA');
  assert.equal(inkColorHex('ink', 'light'), '#1A1710');
});

test('traceStrokeOutline: een enkel punt wordt een stip, een lijn wordt cirkels plus trapezia in één pad', () => {
  const dot = fakeContext();
  traceStrokeOutline(dot.ctx, stroke([10, 10, 0.5]), 1);
  assert.deepEqual(dot.calls, ['beginPath', 'moveTo', 'arc', 'closePath']);

  const line = fakeContext();
  // Vier punten, elk 2 eenheden uit elkaar: kort genoeg om niet verdicht te worden.
  traceStrokeOutline(line.ctx, stroke([0, 0, 0.5, 2, 0, 0.6, 4, 1, 0.7, 6, 1, 0.5]), 2);
  assert.equal(line.calls[0], 'beginPath');
  assert.equal(line.calls.filter(c => c === 'beginPath').length, 1, 'alles in één pad, dus één vulling');
  assert.equal(line.calls.filter(c => c === 'arc').length, 4, 'een cirkel per punt: ronde verbindingen en uiteinden');
  assert.equal(line.calls.filter(c => c === 'lineTo').length, 9, 'drie trapezia van elk drie lijnstukken');
  assert.equal(line.calls[line.calls.length - 1], 'closePath');
});

test('densifyPoints verdicht alleen lange segmenten, langs een vloeiende boog', () => {
  const dense = densifyPoints([{ x: 0, y: 0, p: 0.5 }, { x: 1, y: 0, p: 0.5 }, { x: 2, y: 0, p: 0.5 }]);
  assert.equal(dense.length, 3, 'korte segmenten blijven zoals ze zijn');
  const sparse = densifyPoints([{ x: 0, y: 0, p: 0.2 }, { x: 40, y: 0, p: 0.8 }, { x: 40, y: 40, p: 0.2 }], 4);
  assert.ok(sparse.length > 10, 'lange segmenten krijgen tussenpunten');
  for (const pt of sparse) assert.ok(pt.x >= -3 && pt.x <= 43 && pt.y >= -3 && pt.y <= 43, `geen overschot buiten de hoek: ${pt.x},${pt.y}`);
  // Een scherpe keer (heen en terug) mag geen lus of piek opleveren: alle
  // tussenpunten blijven dicht bij het lijnstuk zelf.
  const cusp = densifyPoints([{ x: 0, y: 0, p: 0.5 }, { x: 30, y: 0, p: 0.5 }, { x: 2, y: 3, p: 0.5 }, { x: 40, y: 6, p: 0.5 }], 4);
  for (const pt of cusp) assert.ok(pt.x >= -3 && pt.x <= 43 && pt.y >= -6 && pt.y <= 12, `piek bij een scherpe keer: ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
  assert.deepEqual(sparse[0], { x: 0, y: 0, p: 0.2 });
  assert.deepEqual(sparse[sparse.length - 1], { x: 40, y: 40, p: 0.2 });
  const mid = sparse[Math.floor(sparse.length / 4)];
  assert.ok(mid.p > 0.2 && mid.p < 0.8, 'de druk loopt mee met de tussenpunten');
  assert.deepEqual(densifyPoints([{ x: 1, y: 1, p: 1 }, { x: 50, y: 1, p: 1 }]), [{ x: 1, y: 1, p: 1 }, { x: 50, y: 1, p: 1 }], 'twee punten: geen boog te maken');
});

test('inkSizeIssue waarschuwt boven de opslaggrens', () => {
  const doc: InkDocument = createInkDocument();
  assert.equal(inkSizeIssue(doc), null);
  const pointsPerStroke = 3000;
  const strokesNeeded = Math.ceil(INK_MAX_JSON_LENGTH / (pointsPerStroke * 6)) + 1;
  for (let s = 0; s < strokesNeeded; s += 1) {
    const points: number[] = [];
    for (let i = 0; i < pointsPerStroke; i += 1) points.push(i * 0.3, (s % 40) * 30, 0.5);
    doc.pages[0].strokes.push(stroke(points, { id: `s${s}` }));
  }
  assert.match(inkSizeIssue(doc) ?? '', /te groot/);
});
