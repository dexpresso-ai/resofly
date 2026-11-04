/**
 * De rekenregels achter de weergave van een galerij. Draaien met:  npm test
 *
 * De belangrijkste belofte staat bovenaan: met de standaardinstellingen komen
 * er exact dezelfde rijen uit als vóór de weergave-instellingen. Daarvoor staat
 * de oude rekenregel hieronder letterlijk gekopieerd (buildPhotoRows uit
 * GalleryViewer.tsx van vóór 4 november 2026). Een bestaande galerij mag na de
 * uitrol niet verschuiven.
 *
 * Daarna per indeling: geen overlap, binnen de breedte, de volgorde van de
 * fotograaf, de tussenruimte op de pixel, en wat "groot tonen" doet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GALLERY_LAYOUT_DEFAULTS, GALLERY_LAYOUT_STYLES, normalizeGalleryLayout, type GalleryLayout } from './galleryLayout.ts';
import {
  aspectRatioOf, columnsFor, deviceOf, effectiveGap, hashUnit, planPhotoLayout,
  type LayoutPhoto, type LayoutTile,
} from './galleryLayoutEngine.ts';

// ── Testfoto's: een vaste, gevarieerde reeks ────────────────────────────────

const SHAPES: Array<[number, number]> = [
  [6000, 4000], [4000, 6000], [5000, 5000], [6000, 4000], [3000, 4500], [6000, 3375],
  [4000, 5000], [6000, 4000], [2000, 6000], [8000, 3000], [4500, 3000], [3000, 4000],
];
function photos(count: number, over: (index: number) => Partial<LayoutPhoto> = () => ({})): LayoutPhoto[] {
  return Array.from({ length: count }, (_, i) => {
    const [width, height] = SHAPES[(i * 7 + Math.floor(i / 5)) % SHAPES.length];
    return { id: `p${String(i).padStart(3, '0')}`, width, height, ...over(i) };
  });
}
const layout = (raw: Partial<GalleryLayout> = {}) => normalizeGalleryLayout(raw);

// ── De oude rekenregel, letterlijk ──────────────────────────────────────────

const OLD_GAP = 6;
function oldTarget(width: number): number {
  if (width < 520) return 150;
  if (width < 900) return 200;
  if (width < 1400) return 250;
  return 290;
}
function oldRows(list: LayoutPhoto[], width: number, scale = 1): Array<{ ids: string[]; height: number }> {
  const target = oldTarget(width) * scale;
  const heightOf = (items: LayoutPhoto[]) => {
    const sum = items.reduce((t, item) => t + aspectRatioOf(item), 0);
    if (sum <= 0) return target;
    return (width - OLD_GAP * (items.length - 1)) / sum;
  };
  const rows: Array<{ items: LayoutPhoto[]; height: number }> = [];
  let current: LayoutPhoto[] = [];
  for (const photo of list) {
    current.push(photo);
    if (heightOf(current) <= target) { rows.push({ items: current, height: heightOf(current) }); current = []; }
  }
  if (current.length > 0) {
    let height = heightOf(current);
    let guard = 0;
    while (height > target * 1.45 && rows.length > 0 && guard < 20) {
      const previous = rows[rows.length - 1];
      if (previous.items.length <= 1) break;
      const moved = previous.items.pop() as LayoutPhoto;
      previous.height = heightOf(previous.items);
      current = [moved, ...current];
      height = heightOf(current);
      guard += 1;
    }
    rows.push({ items: current, height });
  }
  return rows.map(row => ({ ids: row.items.map(i => i.id), height: row.height }));
}

/** Tegels per rij, op hun y-positie. */
function rowsOf(tiles: LayoutTile[]): LayoutTile[][] {
  const byY = new Map<number, LayoutTile[]>();
  for (const tile of tiles) byY.set(tile.y, [...(byY.get(tile.y) ?? []), tile]);
  return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a.x - b.x));
}

function overlaps(a: LayoutTile, b: LayoutTile): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(tiles: LayoutTile[], label: string) {
  for (let i = 0; i < tiles.length; i += 1) {
    for (let j = i + 1; j < tiles.length; j += 1) {
      assert.ok(!overlaps(tiles[i], tiles[j]), `${label}: ${tiles[i].id} en ${tiles[j].id} overlappen`);
    }
  }
}

function assertInside(tiles: LayoutTile[], width: number, height: number, label: string) {
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.x + t.w <= width, `${label}: ${t.id} valt buiten de breedte (${t.x}+${t.w} > ${width})`);
    assert.ok(t.y >= 0 && t.y + t.h <= height, `${label}: ${t.id} valt buiten de hoogte`);
    assert.ok(Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.w) && Number.isInteger(t.h), `${label}: hele pixels`);
  }
}

// ── De belofte: de standaard verandert niets ────────────────────────────────

test('standaardinstellingen: dezelfde rijen als vóór de weergave-instellingen', () => {
  for (const width of [1600, 1200, 980, 1440]) {
    for (const count of [1, 2, 3, 7, 23, 60]) {
      const list = photos(count);
      const plan = planPhotoLayout(list, GALLERY_LAYOUT_DEFAULTS, { width });
      const expected = oldRows(list, width).filter(row => {
        // Alleen het randgeval dat bewust is verbeterd: een rij die niet in te
        // vullen is en meer dan 2,4× zo hoog zou worden als bedoeld.
        return row.height <= oldTarget(width) * 2.4;
      });
      const actual = rowsOf(plan.tiles).map(row => row.map(t => t.id));
      assert.deepEqual(actual.slice(0, expected.length), expected.map(r => r.ids), `${count} foto's op ${width}px`);
      rowsOf(plan.tiles).forEach((row, index) => {
        if (!expected[index]) return;
        assert.ok(Math.abs(row[0].h - expected[index].height) <= 1, 'rijhoogte gelijk op de pixel');
      });
    }
  }
});

test('ook grootbeeld (tv) rekent zoals vroeger', () => {
  const list = photos(40);
  const plan = planPhotoLayout(list, GALLERY_LAYOUT_DEFAULTS, { width: 1600, scale: 1.35 });
  assert.deepEqual(rowsOf(plan.tiles).map(r => r.map(t => t.id)), oldRows(list, 1600, 1.35).map(r => r.ids));
});

test('een losse staande foto wordt niet meer schermvullend opgeblazen', () => {
  const lone = [{ id: 'staand', width: 4000, height: 6000 }];
  const plan = planPhotoLayout(lone, GALLERY_LAYOUT_DEFAULTS, { width: 1200, viewportHeight: 900 });
  const [tile] = plan.tiles;
  assert.ok(tile.h <= 250 * 2.4 + 1, `begrensd (was ${Math.round(1200 / (4000 / 6000))} px hoog)`);
  assert.ok(Math.abs(tile.x + tile.w / 2 - 600) <= 1, 'en in het midden');
});

// ── Rijen ───────────────────────────────────────────────────────────────────

test('rijen vullen exact de breedte, met de tussenruimte op de pixel', () => {
  for (const gap of [0, 2, 6, 17, 40]) {
    for (const width of [390, 820, 1280]) {
      const plan = planPhotoLayout(photos(50), layout({ gap }), { width });
      const effective = effectiveGap(gap, width);
      assert.equal(plan.gap, effective);
      const rows = rowsOf(plan.tiles);
      rows.slice(0, -1).forEach(row => {
        assert.equal(row[0].x, 0, 'begint links');
        assert.equal(row[row.length - 1].x + row[row.length - 1].w, width, 'eindigt rechts');
        for (let i = 1; i < row.length; i += 1) assert.equal(row[i].x - (row[i - 1].x + row[i - 1].w), effective);
      });
      for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i][0].y - (rows[i - 1][0].y + rows[i - 1][0].h), effective, 'tussen de rijen');
      assertNoOverlap(plan.tiles, `rijen gap ${gap} op ${width}`);
      assertInside(plan.tiles, width, plan.height, `rijen gap ${gap}`);
    }
  }
});

test('naadloos: geen haarlijn tussen twee foto’s, ook niet op een oneven breedte', () => {
  const plan = planPhotoLayout(photos(30), layout({ gap: 0 }), { width: 1283.7 });
  for (const row of rowsOf(plan.tiles).slice(0, -1)) {
    for (let i = 1; i < row.length; i += 1) assert.equal(row[i].x, row[i - 1].x + row[i - 1].w);
  }
});

test('kolommen bij rijen = ongeveer zoveel foto’s per rij', () => {
  for (const columns of [2, 3, 5, 7]) {
    const plan = planPhotoLayout(photos(120), layout({ columns }), { width: 1400 });
    const rows = rowsOf(plan.tiles).slice(0, -1);
    const average = rows.reduce((sum, row) => sum + row.length, 0) / rows.length;
    assert.ok(Math.abs(average - columns) <= Math.max(1, columns * 0.3), `${columns} per rij, gemiddeld ${average.toFixed(1)}`);
  }
});

test('speelsheid geeft rijen van wisselende hoogte; strak niet', () => {
  const spread = (playfulness: number) => {
    const heights = rowsOf(planPhotoLayout(photos(90), layout({ playfulness: playfulness as 0 }), { width: 1400 }).tiles)
      .slice(0, -1).map(row => row[0].h);
    return Math.max(...heights) / Math.min(...heights);
  };
  assert.ok(spread(3) > spread(0), 'uitbundig wisselt meer dan strak');
  assert.ok(spread(2) > 1.5, 'speels heeft duidelijk ritme');
});

test('groot tonen in rijen: een eigen rij, groter dan de rest', () => {
  const list = photos(30, i => ({ featured: i === 9 }));
  const plan = planPhotoLayout(list, layout(), { width: 1200 });
  const row = rowsOf(plan.tiles).find(r => r.some(t => t.id === 'p009'))!;
  assert.equal(row.length, 1, 'alleen de uitgelichte foto');
  assert.ok(row[0].emphasis);
  const others = plan.tiles.filter(t => t.id !== 'p009').map(t => t.h);
  assert.ok(row[0].h > Math.max(...others), 'hoger dan elke gewone rij');
});

test('rijen: twee uitgelichte foto’s vlak na elkaar laten geen halve rij achter', () => {
  // Foto 3 en 5 uitgelicht: zonder wachten zouden 1+2 en 4 elk een rij vormen
  // die de breedte niet kan vullen — een paar losse plaatjes met gaten ernaast.
  for (const width of [1372, 1200, 820]) {
    const list = photos(40, i => ({ featured: i === 2 || i === 4 }));
    const plan = planPhotoLayout(list, layout(), { width });
    assert.deepEqual(plan.tiles.map(t => t.id), list.map(p => p.id), 'documentvolgorde = volgorde van de fotograaf');
    const rows = rowsOf(plan.tiles);
    const regular = rows.filter(row => !row[0].emphasis);
    for (const row of regular.slice(0, -1)) {
      assert.equal(row[0].x, 0, `${width}: rij begint links`);
      assert.equal(row[row.length - 1].x + row[row.length - 1].w, width, `${width}: rij vult de breedte`);
    }
    const big = rows.filter(row => row[0].emphasis);
    assert.equal(big.length, 2);
    for (const row of big) assert.equal(row.length, 1, 'elke uitgelichte foto alleen');
    // En ze komen niet ver van hun plek: hooguit één rij later.
    const firstBigY = big[0][0].y;
    assert.ok(rows.findIndex(row => row[0].y === firstBigY) <= 2);
  }
});

// ── Waterval ────────────────────────────────────────────────────────────────

test('waterval: kolommen op de pixel, foto’s in eigen verhouding, geen overlap', () => {
  for (const columns of [1, 2, 3, 4, 6]) {
    const plan = planPhotoLayout(photos(40), layout({ style: 'masonry', columns, gap: 12 }), { width: 1280 });
    assert.equal(plan.columns, columns);
    const columnWidth = (1280 - 12 * (columns - 1)) / columns;
    for (const tile of plan.tiles) {
      const photo = photos(40).find(p => p.id === tile.id)!;
      // Op de pixel na (beide randen worden afgerond): de hoogte hoort bij de breedte.
      const ratio = aspectRatioOf(photo);
      assert.ok(Math.abs(tile.h - tile.w / ratio) <= 1 + 1 / ratio, `niet bijgesneden (${tile.id})`);
      // Eén kolom breed — tenzij de foto dan hoger wordt dan het venster (een
      // staande foto in één kolom van 1280 px); die wordt begrensd en gecentreerd.
      const capped = tile.h >= 900 * 0.88 - 1;
      if (!tile.emphasis && !capped) assert.ok(Math.abs(tile.w - columnWidth) <= 1, `één kolom breed (${tile.id})`);
    }
    assertNoOverlap(plan.tiles, `waterval ${columns}`);
    assertInside(plan.tiles, 1280, plan.height, `waterval ${columns}`);
  }
});

test('waterval: speels verspringt bovenaan, uitgelicht loopt over twee kolommen', () => {
  const tops = (playfulness: number) => {
    const plan = planPhotoLayout(photos(8), layout({ style: 'masonry', columns: 4, playfulness: playfulness as 0 }), { width: 1200 });
    return new Set(plan.tiles.slice(0, 4).map(t => t.y)).size;
  };
  assert.equal(tops(0), 1, 'strak: alle kolommen beginnen gelijk');
  assert.ok(tops(2) > 1, 'speels: verspringend');
  const plan = planPhotoLayout(photos(20, i => ({ featured: i === 5 })), layout({ style: 'masonry', columns: 4, gap: 10 }), { width: 1210 });
  const big = plan.tiles.find(t => t.id === 'p005')!;
  const columnWidth = (1210 - 30) / 4;
  assert.ok(big.emphasis);
  assert.ok(big.w > columnWidth * 1.5, 'breder dan één kolom');
});

// ── Raster ──────────────────────────────────────────────────────────────────

test('raster: gelijke tegels in de gekozen vorm', () => {
  for (const [shape, ratio] of [['square', 1], ['portrait', 0.8], ['landscape', 1.5]] as const) {
    const plan = planPhotoLayout(photos(17), layout({ style: 'grid', columns: 4, gap: 8, tile_shape: shape }), { width: 1232 });
    const cell = (1232 - 24) / 4;
    for (const tile of plan.tiles) {
      assert.ok(Math.abs(tile.w - cell) <= 1);
      assert.ok(Math.abs(tile.w / tile.h - ratio) < 0.02, `${shape}: ${tile.w}×${tile.h}`);
    }
    assertNoOverlap(plan.tiles, `raster ${shape}`);
    assertInside(plan.tiles, 1232, plan.height, `raster ${shape}`);
  }
});

/** Hoeveel cellen van het raster zijn bedekt, en zit er een gat vóór de laatste rij? */
function gridHoles(tiles: LayoutTile[], columns: number, width: number, gap: number, ratio: number): number {
  const cellW = (width - gap * (columns - 1)) / columns;
  const cellH = cellW / ratio;
  const covered = new Set<string>();
  let lastRow = 0;
  for (const t of tiles) {
    const c0 = Math.round(t.x / (cellW + gap));
    const r0 = Math.round(t.y / (cellH + gap));
    const cs = Math.round((t.w + gap) / (cellW + gap));
    const rs = Math.round((t.h + gap) / (cellH + gap));
    for (let r = r0; r < r0 + rs; r += 1) for (let c = c0; c < c0 + cs; c += 1) covered.add(`${r}:${c}`);
    lastRow = Math.max(lastRow, r0 + rs - 1);
  }
  let holes = 0;
  for (let r = 0; r < lastRow; r += 1) for (let c = 0; c < columns; c += 1) if (!covered.has(`${r}:${c}`)) holes += 1;
  return holes;
}

test('raster met speelsheid: grote en brede tegels, zonder gaten en zonder overlap', () => {
  for (const playfulness of [1, 2, 3] as const) {
    for (const columns of [2, 3, 4, 6]) {
      const list = photos(140);
      const plan = planPhotoLayout(list, layout({ style: 'grid', columns, gap: 6, playfulness }), { width: 1300 });
      assert.deepEqual(plan.tiles.map(t => t.id), list.map(p => p.id), 'volgorde van de fotograaf');
      assert.ok(plan.tiles.some(t => t.emphasis), `speelsheid ${playfulness} bij ${columns} kolommen geeft grote tegels`);
      assertNoOverlap(plan.tiles, `raster speels ${playfulness}/${columns}`);
      assert.equal(gridHoles(plan.tiles, columns, 1300, 6, 1), 0, `geen gaten (${playfulness}/${columns})`);
    }
  }
  const strak = planPhotoLayout(photos(60), layout({ style: 'grid', columns: 4 }), { width: 1300 });
  assert.ok(!strak.tiles.some(t => t.emphasis), 'strak: niets groot');
});

test('raster: uitgelichte foto’s worden 2×2 en laten geen gat achter', () => {
  const list = photos(50, i => ({ featured: i === 3 || i === 4 || i === 21 }));
  const plan = planPhotoLayout(list, layout({ style: 'grid', columns: 4, gap: 10 }), { width: 1270 });
  const cell = (1270 - 30) / 4;
  for (const id of ['p003', 'p004', 'p021']) {
    const tile = plan.tiles.find(t => t.id === id)!;
    assert.ok(Math.abs(tile.w - (cell * 2 + 10)) <= 1 && Math.abs(tile.h - (cell * 2 + 10)) <= 1, `${id} is 2×2`);
  }
  assertNoOverlap(plan.tiles, 'raster uitgelicht');
  assert.equal(gridHoles(plan.tiles, 4, 1270, 10, 1), 0);
});

// ── Verhaal ─────────────────────────────────────────────────────────────────

test('verhaal: binnen de breedte, geen overlap, nooit hoger dan het venster', () => {
  for (const playfulness of [0, 1, 2, 3] as const) {
    for (const width of [390, 1240]) {
      const plan = planPhotoLayout(photos(45, i => ({ featured: i === 12 })), layout({ style: 'story', gap: 20, playfulness }), { width, viewportHeight: 900 });
      assertNoOverlap(plan.tiles, `verhaal ${playfulness} op ${width}`);
      assertInside(plan.tiles, width, plan.height, `verhaal ${playfulness}`);
      for (const tile of plan.tiles) assert.ok(tile.h <= 900 * 0.88 + 1, 'past in het venster');
      assert.equal(plan.tiles.length, 45);
    }
  }
  const featured = planPhotoLayout(photos(10, i => ({ featured: i === 0 })), layout({ style: 'story' }), { width: 1240 }).tiles[0];
  assert.ok(featured.emphasis);
  assert.ok(featured.w === 1240 || featured.h >= 900 * 0.88 - 1, 'uitgelicht: volle breedte (of zo hoog als het venster toelaat)');
});

test('verhaal: staande foto’s komen in paren, strak staat alles in het midden', () => {
  const portraits = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, width: 4000, height: 6000 }));
  const plan = planPhotoLayout(portraits, layout({ style: 'story', gap: 20 }), { width: 1240 });
  assert.equal(rowsOf(plan.tiles).length, 3, 'drie paren');
  for (const row of rowsOf(plan.tiles)) {
    const left = row[0].x;
    const right = 1240 - (row[row.length - 1].x + row[row.length - 1].w);
    assert.ok(Math.abs(left - right) <= 1, 'in het midden');
  }
});

// ── Afdrukken ───────────────────────────────────────────────────────────────

test('afdrukken: papierrand, draaiing volgens de speelsheid, deterministisch', () => {
  const list = photos(24);
  const straight = planPhotoLayout(list, layout({ style: 'prints', columns: 4, playfulness: 0 }), { width: 1200 });
  assert.ok(straight.tiles.every(t => t.rotate === 0), 'strak: recht');
  assert.ok(straight.tiles.every(t => t.paper >= 3 && t.paperBottom === t.paper), 'gelijke rand');
  assertNoOverlap(straight.tiles, 'afdrukken strak');
  const wild = planPhotoLayout(list, layout({ style: 'prints', columns: 4, playfulness: 3 }), { width: 1200 });
  assert.ok(wild.tiles.some(t => Math.abs(t.rotate) > 1), 'uitbundig: scheef');
  assert.ok(wild.tiles.every(t => Math.abs(t.rotate) <= 4.6), 'maar nooit meer dan 4,6°');
  assert.ok(wild.tiles.every(t => t.paperBottom > t.paper * 2), 'polaroidrand');
  assert.deepEqual(planPhotoLayout(list, layout({ style: 'prints', columns: 4, playfulness: 3 }), { width: 1200 }), wild, 'elke keer dezelfde tafel');
});

test('afdrukken: liggend en staand even lang, een halve rij in het midden', () => {
  const list = [
    { id: 'l', width: 6000, height: 4000 }, { id: 's', width: 4000, height: 6000 }, { id: 'x', width: 6000, height: 4000 },
  ];
  const plan = planPhotoLayout(list, layout({ style: 'prints', columns: 4, gap: 20 }), { width: 1220 });
  const [l, s] = plan.tiles;
  assert.ok(Math.abs((l.w - 2 * l.paper) - (s.h - s.paper - s.paperBottom)) <= 1, 'zelfde lange zijde');
  const left = plan.tiles[0].x;
  const right = 1220 - (plan.tiles[2].x + plan.tiles[2].w);
  assert.ok(Math.abs(left - right) < 40, 'drie afdrukken in een rij van vier staan in het midden');
});

// ── Kolommen, tussenruimte, apparaten ───────────────────────────────────────

test('tussenruimte krimpt mee op kleine schermen, de standaard blijft wat hij was', () => {
  assert.equal(effectiveGap(6, 1200), 6);
  assert.equal(effectiveGap(6, 820), 6);
  assert.equal(effectiveGap(6, 390), 4, 'op een telefoon was dit al 4 px');
  assert.equal(effectiveGap(32, 820), 24);
  assert.equal(effectiveGap(32, 390), 16);
  assert.equal(effectiveGap(64, 390), 32);
  assert.equal(effectiveGap(0, 390), 0);
  assert.equal(deviceOf(559), 'phone');
  assert.equal(deviceOf(560), 'tablet');
  assert.equal(deviceOf(980), 'desktop');
});

test('kolommen: zelf gekozen op een breed scherm, naar verhouding op een tablet, telefoon apart', () => {
  const four = layout({ style: 'grid', columns: 4 });
  assert.equal(columnsFor(four, 1400), 4);
  assert.equal(columnsFor(four, 820), 3);
  assert.equal(columnsFor(four, 390), 2);
  assert.equal(columnsFor(layout({ style: 'grid', columns: 4, phone_columns: 1 }), 390), 1);
  assert.equal(columnsFor(layout({ style: 'grid', columns: 6, phone_columns: 3 }), 600), 3);
  assert.equal(columnsFor(layout({ style: 'masonry' }), 1200), 4, 'automatisch: zo’n 300 px per kolom');
  assert.equal(columnsFor(layout({ style: 'masonry' }), 390), 2);
  assert.equal(columnsFor(layout({ style: 'masonry' }), 1600, 1.35), 4, 'grootbeeld: grotere kolommen');
});

test('elke indeling: volgorde intact, alles op hele pixels, geen NaN', () => {
  for (const style of GALLERY_LAYOUT_STYLES) {
    for (const width of [320, 390, 768, 1280, 1920]) {
      // Foto 7 zonder maten (een oud item): die valt terug op 3:2.
      const list = photos(33, i => ({ featured: i % 11 === 4, ...(i === 7 ? { width: null } : {}) }));
      const plan = planPhotoLayout(list, layout({ style, gap: 14, playfulness: 2 }), { width });
      assert.deepEqual(plan.tiles.map(t => t.id), list.map(p => p.id), `${style} op ${width}`);
      for (const tile of plan.tiles) {
        for (const value of [tile.x, tile.y, tile.w, tile.h, tile.rotate]) assert.ok(Number.isFinite(value), `${style}: eindige getallen`);
        assert.ok(tile.w >= 1 && tile.h >= 1);
      }
      assert.ok(plan.height >= Math.max(...plan.tiles.map(t => t.y + t.h)) - 1);
      if (style !== 'prints') assertNoOverlap(plan.tiles, `${style} op ${width}`);
    }
  }
});

test('lege galerij en een container zonder breedte geven niets', () => {
  assert.deepEqual(planPhotoLayout([], GALLERY_LAYOUT_DEFAULTS, { width: 1200 }).tiles, []);
  assert.deepEqual(planPhotoLayout(photos(3), GALLERY_LAYOUT_DEFAULTS, { width: 0 }).tiles, []);
});

test('de hash is stabiel en verdeelt gelijkmatig', () => {
  assert.equal(hashUnit('abc', 1), hashUnit('abc', 1));
  assert.notEqual(hashUnit('abc', 1), hashUnit('abc', 2));
  const values = Array.from({ length: 2000 }, (_, i) => hashUnit(`item-${i}`, 3));
  assert.ok(values.every(v => v >= 0 && v < 1));
  const low = values.filter(v => v < 0.5).length;
  assert.ok(low > 900 && low < 1100, `ongeveer de helft onder 0,5 (${low})`);
});

test('ook duizenden foto’s rekenen in een oogwenk', () => {
  const list = photos(3000, i => ({ featured: i % 97 === 0 }));
  for (const style of GALLERY_LAYOUT_STYLES) {
    const started = performance.now();
    planPhotoLayout(list, layout({ style, playfulness: 3, columns: 5 }), { width: 1600 });
    const took = performance.now() - started;
    assert.ok(took < 400, `${style}: ${took.toFixed(0)} ms`);
  }
});
