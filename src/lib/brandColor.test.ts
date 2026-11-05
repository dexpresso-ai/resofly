/**
 * De merkkleur leesbaar houden (brandColor.ts): één rekenregel voor de
 * klantpagina's, de PDF en de mails. Draaien met: npm test
 *
 * Tot november 2026 stond deze berekening op drie plekken, elk net anders. De
 * tekst op een vlak in de merkkleur viel in de mail en op de klantpagina's
 * terug op puur zwart als niets 4,5 : 1 haalde, in de PDF niet: bij een grijs
 * of middenblauw merk (#7A7A7A, #0077DD) stond die tekst op de PDF onder de norm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blendColors, contrastRatio, hexToHsl, hslToHex, readableShade, relativeLuminance, textOnColor } from './brandColor.ts';

const MARK = '// ---- Vanaf hier is dit bestand gelijk aan zijn spiegel (zie de test). ----';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Alle kleuren van een 12-bits raster (#000, #001 … #FFF), plus een paar merken uit de praktijk. */
const COLORS: string[] = [];
const hex2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) COLORS.push(`#${hex2(r * 17)}${hex2(g * 17)}${hex2(b * 17)}`);
COLORS.push('#FFD966', '#00084D', '#8A7F70', '#2457C5', '#0077DD', '#7A7A7A');

test('de spiegel voor de edge functions is teken voor teken gelijk, en zonder imports', () => {
  const body = (path: string) => {
    const source = read(path);
    const at = source.indexOf(MARK);
    assert.ok(at > 0, `markering ontbreekt in ${path}`);
    return source.slice(at);
  };
  assert.equal(body('../../supabase/functions/_shared/brandColor.ts'), body('./brandColor.ts'));
  for (const path of ['./brandColor.ts', '../../supabase/functions/_shared/brandColor.ts']) {
    assert.doesNotMatch(read(path), /^import /m, `${path} moet ongewijzigd in browser, node en Deno draaien`);
  }
});

test('de formule staat op één plek: geen eigen kopie meer in de klantpagina\'s, de PDF of de mail', () => {
  // 0.03928 is de drempel uit de luminantieformule; wie hem opnieuw ergens
  // neerzet, kopieert de berekening in plaats van brandColor.ts te gebruiken.
  for (const path of [
    './branding.ts',
    './documentLayout.ts',
    '../../supabase/functions/_shared/documentLayout.ts',
    '../../supabase/functions/_shared/emailTemplates/layout.ts',
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /0\.03928/, `${path} rekent zelf de helderheid uit`);
    assert.match(source, /from '\.\.?\/brandColor\.ts';/, `${path} gebruikt brandColor.ts niet`);
  }
});

test('contrast en helderheid volgens WCAG 2', () => {
  assert.equal(contrastRatio('#000000', '#FFFFFF'), 21);
  assert.equal(contrastRatio('#FFFFFF', '#000000'), 21);
  assert.equal(contrastRatio('#2457C5', '#2457C5'), 1);
  assert.equal(relativeLuminance('#FFFFFF'), 1);
  assert.equal(relativeLuminance('#000000'), 0);
  // Een kleur die je omrekent naar HSL en terug, blijft dezelfde kleur.
  for (const color of COLORS) assert.equal(hslToHex(hexToHsl(color)), color);
  assert.equal(blendColors('#FFFFFF', '#000000', 0.5), '#808080');
});

test('readableShade: haalt het doel, behoudt de tint, en laat een leesbare kleur precies staan', () => {
  for (const color of COLORS) {
    const onWhite = readableShade(color, ['#FFFFFF'], { direction: 'darker' });
    assert.ok(contrastRatio(onWhite, '#FFFFFF') >= 4.5, `${color} op wit: ${onWhite}`);
    const onDark = readableShade(color, ['#1B1B1F', '#121215'], { direction: 'lighter' });
    assert.ok(contrastRatio(onDark, '#1B1B1F') >= 4.5 && contrastRatio(onDark, '#121215') >= 4.5, `${color} op donker: ${onDark}`);
    if (contrastRatio(color, '#FFFFFF') >= 4.5) assert.equal(onWhite, color);
    // Alleen de helderheid schuift: een gekleurd merk houdt zijn tint (binnen afronding).
    const before = hexToHsl(color);
    const after = hexToHsl(onWhite);
    if (before.s > 0.2 && after.s > 0.2 && after.l > 0.08 && after.l < 0.92) {
      const turn = Math.abs(before.h - after.h);
      assert.ok(Math.min(turn, 360 - turn) < 12, `${color} → ${onWhite} draait van tint`);
    }
  }
  // Een strenger doel (de klantpagina's mikken op 4,75) wordt ook gehaald.
  assert.ok(contrastRatio(readableShade('#FFD966', ['#FFFFFF', '#F6F4F1'], { direction: 'darker', target: 4.75 }), '#F6F4F1') >= 4.75);
});

test('textOnColor: tekst op elke merkkleur haalt 4,5 : 1, ook midden in de grijstrap', () => {
  for (const color of COLORS) {
    const ink = textOnColor(color);
    assert.ok(contrastRatio(ink, color) >= 4.5, `${ink} op ${color}`);
  }
  // Bijna-zwart of wit haalt hier geen 4,5; puur zwart wel.
  assert.equal(textOnColor('#7A7A7A'), '#000000');
  assert.equal(textOnColor('#0077DD'), '#000000');
  assert.equal(textOnColor('#FFD966'), '#111111');
  assert.equal(textOnColor('#00084D'), '#FFFFFF');
});
