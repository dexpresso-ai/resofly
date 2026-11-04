/**
 * De weergave-instellingen van een galerij: standaard, herstellen, strenge
 * controle, stijlen — en dat de app, de edge functions en de database dezelfde
 * regels kennen. Draaien met:  npm test
 *
 * Het gevaarlijke geval is uit de pas lopen. Kent de app een waarde die de
 * database weigert, dan mislukt opslaan; kent de database een waarde die de edge
 * function niet doorlaat, dan ziet de klant iets anders dan de fotograaf.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as app from './galleryLayout.ts';
import * as server from '../../supabase/functions/_shared/galleryLayout.ts';

const {
  GALLERY_LAYOUT_DEFAULTS, GALLERY_LAYOUT_KEYS, GALLERY_LAYOUT_PRESETS,
  applyGalleryLayoutPreset, describeGalleryLayout, galleryLayoutIssues, gapLabel,
  matchGalleryLayoutPreset, normalizeGalleryLayout, playfulnessHint,
} = app;

test('zonder instellingen: precies de weergave van vóór deze instellingen', () => {
  for (const raw of [undefined, null, {}, 'rows', 42, [], { onbekend: true }]) {
    assert.deepEqual(normalizeGalleryLayout(raw), GALLERY_LAYOUT_DEFAULTS);
  }
  assert.equal(GALLERY_LAYOUT_DEFAULTS.style, 'rows');
  assert.equal(GALLERY_LAYOUT_DEFAULTS.gap, 6);
  assert.equal(GALLERY_LAYOUT_DEFAULTS.columns, null);
  assert.equal(GALLERY_LAYOUT_DEFAULTS.playfulness, 0);
  assert.equal(GALLERY_LAYOUT_DEFAULTS.corners, 'soft');
  assert.equal(GALLERY_LAYOUT_DEFAULTS.hover, 'zoom');
  assert.equal(GALLERY_LAYOUT_DEFAULTS.reveal, false);
});

test('herstellen: onzin valt terug, getallen worden afgekapt, 0 kolommen is automatisch', () => {
  const layout = normalizeGalleryLayout({
    style: 'carousel', columns: 0, phone_columns: 9, gap: 100, playfulness: -3,
    width: 'NARROW', reveal: 'ja', corners: 'round', headings: 'numbered',
  });
  assert.equal(layout.style, 'rows');
  assert.equal(layout.columns, null);
  assert.equal(layout.phone_columns, 3);
  assert.equal(layout.gap, 64);
  assert.equal(layout.playfulness, 0);
  assert.equal(layout.width, 'full', 'hoofdletters zijn geen geldige waarde');
  assert.equal(layout.reveal, false);
  assert.equal(layout.corners, 'round');
  assert.equal(layout.headings, 'numbered');
  assert.equal(normalizeGalleryLayout({ gap: 7.6 }).gap, 8, 'afronden op hele pixels');
  assert.equal(normalizeGalleryLayout({ columns: 3.4 }).columns, 3);
  assert.equal(normalizeGalleryLayout({ columns: '4' }).columns, null, 'tekst is geen getal');
});

test('strenge controle noemt elke fout bij naam', () => {
  assert.deepEqual(galleryLayoutIssues({}), []);
  assert.deepEqual(galleryLayoutIssues(GALLERY_LAYOUT_DEFAULTS), []);
  assert.deepEqual(galleryLayoutIssues({ columns: null, phone_columns: null }), []);
  assert.deepEqual(galleryLayoutIssues(null), ['De weergave moet een object zijn.']);
  assert.deepEqual(galleryLayoutIssues([]), ['De weergave moet een object zijn.']);
  const issues = galleryLayoutIssues({ stijl: 'x', style: 'carousel', gap: 6.5, columns: 0, reveal: 1, playfulness: 4 });
  assert.equal(issues.length, 6);
  assert.match(issues.join(' '), /Onbekende instelling "stijl"/);
  assert.match(issues.join(' '), /"style" moet een van deze zijn: rows, masonry, grid, story, prints/);
  assert.match(issues.join(' '), /"gap" moet een heel getal van 0 tot en met 64 zijn\./);
  assert.match(issues.join(' '), /"columns" moet een heel getal van 1 tot en met 8 zijn, of leeg voor automatisch/);
  assert.match(issues.join(' '), /"reveal" moet waar of onwaar zijn/);
  assert.deepEqual(galleryLayoutIssues({ gap: null }).length, 1, 'tussenruimte kent geen automatisch');
});

test('wat de normalisatie oplevert, keurt de strenge controle altijd goed', () => {
  const inputs: unknown[] = [
    {}, { style: 'grid', columns: 12, gap: -4 }, { playfulness: 2.6, reveal: true },
    { phone_columns: 0, columns: 1 }, { video_layout: 'grid', video_size: 'xl' },
  ];
  for (const raw of inputs) assert.deepEqual(galleryLayoutIssues(normalizeGalleryLayout(raw)), []);
});

test('stijlen: geldig, uniek, herkenbaar, en ze laten de video-instellingen staan', () => {
  const keys = GALLERY_LAYOUT_PRESETS.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys[0], 'standard');
  const custom = normalizeGalleryLayout({ video_layout: 'grid', video_size: 'large', style: 'masonry', gap: 13 });
  assert.equal(matchGalleryLayoutPreset(custom), null);
  for (const preset of GALLERY_LAYOUT_PRESETS) {
    assert.deepEqual(galleryLayoutIssues(preset.layout), [], preset.key);
    const applied = applyGalleryLayoutPreset(custom, preset.key);
    assert.equal(applied.video_layout, 'grid', `${preset.key} laat de video's met rust`);
    assert.equal(applied.video_size, 'large');
    assert.equal(matchGalleryLayoutPreset(applied), preset.key, `${preset.key} wordt herkend`);
  }
  assert.equal(matchGalleryLayoutPreset(GALLERY_LAYOUT_DEFAULTS), 'standard');
  assert.deepEqual(applyGalleryLayoutPreset(custom, 'bestaat-niet'), custom);
});

test('de woorden kloppen bij de waarden', () => {
  assert.equal(gapLabel(0), 'Naadloos');
  assert.equal(gapLabel(6), 'Smal');
  assert.equal(gapLabel(16), 'Ruim');
  assert.equal(gapLabel(32), 'Royaal');
  assert.equal(gapLabel(64), 'Museaal');
  assert.equal(describeGalleryLayout(GALLERY_LAYOUT_DEFAULTS), 'rijen · kolommen automatisch · 6 px tussenruimte · strak');
  assert.equal(
    describeGalleryLayout(normalizeGalleryLayout({ style: 'grid', columns: 1, gap: 0, playfulness: 3 })),
    'raster · 1 kolom · 0 px tussenruimte · uitbundig',
  );
  for (const style of app.GALLERY_LAYOUT_STYLES) {
    for (const level of [0, 1, 2, 3] as const) assert.ok(playfulnessHint(style, level).length > 10);
  }
});

// ── App en server: twee kopieën, één waarheid ───────────────────────────────

test('de kopie voor de edge functions is gelijk aan die van de app', () => {
  for (const name of [
    'GALLERY_LAYOUT_STYLES', 'GALLERY_LAYOUT_WIDTHS', 'GALLERY_SECTION_SPACINGS', 'GALLERY_TILE_SHAPES',
    'GALLERY_CORNERS', 'GALLERY_FRAMES', 'GALLERY_HOVERS', 'GALLERY_HEADINGS', 'GALLERY_VIDEO_LAYOUTS',
    'GALLERY_VIDEO_SIZES', 'GALLERY_LAYOUT_LIMITS', 'GALLERY_LAYOUT_DEFAULTS', 'GALLERY_LAYOUT_KEYS',
    'GALLERY_LAYOUT_PRESETS', 'GALLERY_LAYOUT_PRESET_KEYS', 'GALLERY_LAYOUT_STYLE_LABELS', 'GALLERY_PLAYFULNESS_LABELS',
  ] as const) {
    assert.deepEqual((server as Record<string, unknown>)[name], (app as Record<string, unknown>)[name], name);
  }
  const inputs: unknown[] = [
    undefined, null, {}, [], 'x', GALLERY_LAYOUT_DEFAULTS,
    { style: 'story', columns: 0, phone_columns: 2, gap: 33.3, playfulness: 3, reveal: true },
    { style: 'prints', width: 'narrow', frame: 'shadow', hover: 'none', headings: 'title', extra: 1 },
    { columns: 8, phone_columns: 1, gap: 0, tile_shape: 'landscape', video_layout: 'rows', video_size: 'small' },
  ];
  for (const raw of inputs) {
    assert.deepEqual(server.normalizeGalleryLayout(raw), normalizeGalleryLayout(raw));
    assert.deepEqual(server.galleryLayoutIssues(raw), galleryLayoutIssues(raw));
  }
  const sample = normalizeGalleryLayout(inputs[6]);
  for (const key of app.GALLERY_LAYOUT_PRESET_KEYS) {
    assert.deepEqual(server.applyGalleryLayoutPreset(sample, key), applyGalleryLayoutPreset(sample, key));
  }
  assert.equal(server.describeGalleryLayout(sample), describeGalleryLayout(sample));
});

test('de databasetrigger kent dezelfde keuzes en grenzen', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261104065000_gallery_layout.sql', import.meta.url), 'utf8');
  const block = sql.slice(sql.indexOf('-- layout-keuzes:begin'), sql.indexOf('-- layout-keuzes:eind'));
  const literals = [...block.matchAll(/'(\{[\s\S]*?\})'::jsonb/g)].map(m => JSON.parse(m[1]));
  assert.equal(literals.length, 2, 'twee lijsten: keuzes en getallen');
  const [choices, numbers] = literals as [Record<string, string[]>, Record<string, [number, number, boolean]>];
  assert.deepEqual(choices, {
    style: [...app.GALLERY_LAYOUT_STYLES],
    width: [...app.GALLERY_LAYOUT_WIDTHS],
    section_spacing: [...app.GALLERY_SECTION_SPACINGS],
    tile_shape: [...app.GALLERY_TILE_SHAPES],
    corners: [...app.GALLERY_CORNERS],
    frame: [...app.GALLERY_FRAMES],
    hover: [...app.GALLERY_HOVERS],
    headings: [...app.GALLERY_HEADINGS],
    video_layout: [...app.GALLERY_VIDEO_LAYOUTS],
    video_size: [...app.GALLERY_VIDEO_SIZES],
  });
  const L = app.GALLERY_LAYOUT_LIMITS;
  assert.deepEqual(numbers, {
    columns: [L.columns.min, L.columns.max, true],
    phone_columns: [L.phone_columns.min, L.phone_columns.max, true],
    gap: [L.gap.min, L.gap.max, false],
    playfulness: [L.playfulness.min, L.playfulness.max, false],
  });
  // En elke sleutel heeft een regel: een keuzelijst, een getal, of reveal.
  const covered = new Set([...Object.keys(choices), ...Object.keys(numbers), 'reveal']);
  assert.deepEqual([...covered].sort(), [...GALLERY_LAYOUT_KEYS].sort());
});
