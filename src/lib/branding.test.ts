import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accentFace,
  brandStyle,
  brandThemeVars,
  contrastRatio,
  headerTheme,
  logoNeedsPlate,
  sanitizeStoredBranding,
  type BrandingPayload,
} from './branding.ts';
import { summarizeLogoPixels } from './logoColors.ts';

// Merkkleuren die in de praktijk lastig zijn: heel licht, heel donker, precies
// grijs, verzadigd, en de standaard. Plus kopkleuren van navy tot wit en
// precies in het midden van de grijstrap.
const ACCENTS = [
  '#FFD966', '#F7C548', '#2457C5', '#E4572E', '#3F8F4E', '#2B2B2B', '#8A7F70', '#00084D',
  '#FF00AA', '#7A7A7A', '#FFFFFF', '#000000', '#C2410C', '#14B8A6', '#FFFF00', '#6D28D9',
];
const HEADERS: Array<string | null> = [
  null, '#0F2A4A', '#173A2A', '#FFFFFF', '#F5F0E6', '#E4572E', '#7A7A7A', '#000000',
  '#FFD966', '#3B0A24', '#808080', '#2457C5', '#14B8A6', '#9CA3AF', '#FF00AA',
];

function branding(accentColor: string, headerColor: string | null, clientTheme = 'dark'): BrandingPayload {
  return { logoDataUrl: null, accentColor, footerText: null, hidePoweredBy: false, companyName: null, clientTheme, headerColor };
}

test('alles op de kop leest, voor elke merk- en kopkleur', () => {
  const failures: string[] = [];
  for (const accent of ACCENTS) {
    for (const header of HEADERS) {
      const h = headerTheme(branding(accent, header));
      for (const surface of h.surfaces) {
        for (const [name, ink] of [['tekst', h.ink], ['gedempt', h.ink2], ['merkkleur', h.accent]] as const) {
          const ratio = contrastRatio(ink, surface);
          if (ratio < 4.5) failures.push(`${accent} / ${header ?? 'auto'}: ${name} ${ink} op ${surface} = ${ratio.toFixed(2)}`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('zonder kopkleur is de kop het grafiet van de cockpit, in de tint van het merk', () => {
  const gold = headerTheme(branding('#FFD966', null));
  assert.equal(gold.custom, false);
  assert.equal(gold.dark, true);
  // Donker genoeg dat het grafiet blijft: helderheid onder 2%.
  for (const stop of [gold.top, gold.mid, gold.bottom]) assert.ok(contrastRatio(stop, '#000000') < 1.6, stop);
  // Een grijs merk krijgt gewoon grijs grafiet, geen getinte kop.
  const grey = headerTheme(branding('#7A7A7A', null));
  const [r, g, b] = [1, 3, 5].map(i => parseInt(grey.mid.slice(i, i + 2), 16));
  assert.equal(r, g);
  assert.equal(g, b);
});

test('een eigen kopkleur staat er letterlijk, tenzij er niets op leest', () => {
  const navy = headerTheme(branding('#E4572E', '#0F2A4A'));
  assert.equal(navy.mid, '#0F2A4A');
  assert.equal(navy.headerAdjusted, false);
  assert.equal(navy.dark, true);
  // Koraal op navy haalt de 4,5 net niet: op de kop schuift hij op, de tint blijft.
  assert.equal(navy.accentAdjusted, true);

  const grey = headerTheme(branding('#000000', '#808080'));
  assert.equal(grey.headerAdjusted, true);
  assert.notEqual(grey.mid, '#808080');

  const white = headerTheme(branding('#2457C5', '#FFFFFF'));
  assert.equal(white.dark, false, 'op een witte kop staat donkere tekst');
});

test('het knopvlak houdt de tekst erop leesbaar', () => {
  for (const accent of ACCENTS) {
    const vars = brandThemeVars(branding(accent, null));
    const face = vars['--accent-face'];
    const onAccent = vars['--on-accent'];
    assert.equal(face, accentFace(accent.toUpperCase(), onAccent));
    const stops = face.startsWith('linear-gradient') ? face.match(/#[0-9A-F]{6}/g) ?? [] : [face];
    for (const stop of stops) {
      assert.ok(contrastRatio(onAccent, stop) >= 4.5, `${accent}: ${onAccent} op ${stop}`);
    }
  }
});

test('brandThemeVars levert de koptokens, ook zonder huisstijl', () => {
  const vars = brandThemeVars(null);
  for (const token of ['--hdr-top', '--hdr-mid', '--hdr-bottom', '--hdr-ink', '--hdr-ink-2', '--hdr-accent', '--hdr-glass', '--hdr-rings', '--accent-face']) {
    assert.ok(vars[token], `${token} ontbreekt`);
  }
  const h = headerTheme(branding('#2457C5', '#0F2A4A'));
  const themed = brandThemeVars(branding('#2457C5', '#0F2A4A'));
  assert.equal(themed['--hdr-mid'], h.mid);
  assert.equal(themed['--hdr-ink'], h.ink);
  assert.equal(themed['--hdr-scheme'], 'dark');
  assert.match(themed['--hdr-rings'], /^url\("data:image\/svg\+xml,/);
});

test('een donker logo op een donkere kop krijgt een plaatje, een licht logo niet', () => {
  const h = headerTheme(branding('#FFD966', null));
  assert.equal(logoNeedsPlate('#1A1A1A', [h.top, h.mid, h.bottom]), true);
  assert.equal(logoNeedsPlate('#F2F2F2', [h.top, h.mid, h.bottom]), false);
  assert.equal(logoNeedsPlate(null, [h.mid]), false);
  assert.equal(logoNeedsPlate('rood', [h.mid]), false);
});

test('de accenttekst van de galerij wordt tegen de galerij gemeten', () => {
  for (const galleryBg of ['#0B0B0B', '#12110E', '#F6F4F1', '#FFFFFF']) {
    for (const accentColor of ['#FFD966', '#2457C5', '#2B2B2B', '#E4572E']) {
      const style = brandStyle({ ...branding(accentColor, null), galleryBg }) as Record<string, string>;
      const ink = style['--gal-accent-ink'];
      assert.ok(contrastRatio(ink, galleryBg) >= 4.5, `${accentColor} op ${galleryBg}: ${ink}`);
    }
  }
});

test('opgeslagen huisstijl van de schijf wordt opnieuw gekeurd', () => {
  const clean = sanitizeStoredBranding({
    accentColor: '#2457C5',
    headerColor: 'url(javascript:alert(1))',
    logoDarkDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
  });
  assert.equal(clean?.headerColor, null);
  assert.equal(clean?.logoDarkDataUrl, null);
  const kept = sanitizeStoredBranding({
    accentColor: '#2457C5',
    headerColor: '#0F2A4A',
    logoDarkDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(kept?.headerColor, '#0F2A4A');
  assert.equal(kept?.logoDarkDataUrl, 'data:image/png;base64,iVBORw0KGgo=');
});

test('kleuren uit een logo: doorzichtig telt niet, wit alleen voor de gemiddelde kleur', () => {
  const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
  const data = [
    ...px(15, 42, 74), ...px(15, 42, 74), ...px(15, 42, 74), ...px(16, 43, 75), // navy
    ...px(228, 87, 46), ...px(228, 87, 46), // koraal
    ...px(255, 255, 255), ...px(255, 255, 255), // wit (achtergrond van een jpg)
    ...px(200, 0, 0, 0), ...px(0, 200, 0, 40), // doorzichtig
  ];
  const summary = summarizeLogoPixels(data);
  assert.deepEqual(summary.colors, ['#0F2A4A', '#E4572E']);
  // Gemiddelde van de acht zichtbare pixels, wit meegeteld.
  assert.equal(summary.ink, '#806B70');
  assert.deepEqual(summarizeLogoPixels([0, 0, 0, 0]), { ink: null, colors: [] });
});
