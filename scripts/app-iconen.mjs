#!/usr/bin/env node
/*
 * Tekent de iconen van de werkruimte (public/icons/icon-<maat>.png, met de R
 * uit het logo), de witte R voor meldingen (badge-72.png) en die van de losse
 * apps (Agenda, Financiën, Communicatie, public/icons/app-<id>-<maat>.png)
 * — `node scripts/app-iconen.mjs`.
 *
 * Eén oranje tegel voor alle vier, in de kleur van het logo. De losse apps
 * hebben in plaats van de R het teken van de module, uit lucide: hetzelfde
 * teken als in het menu van de app. Zo staan de vier naast elkaar op een
 * beginscherm als één familie, en zie je toch in één oogopslag welke welke is.
 * De kleur en de R komen uit src/components/BrandMark.tsx, zodat het icoon en
 * de tegel in de app altijd hetzelfde zijn.
 *
 * Het teken blijft binnen de cirkel van 80% (de veilige zone van een
 * `maskable` icoon): Android knipt het icoon rond of als druppel, en dan mag er
 * niets van het teken af vallen. Daarom kan één bestand zowel `any` als
 * `maskable` zijn. Voor de R betekent dat: kleiner dan in het logo (de
 * onderhoek van de stam viel op de maat van het logo buiten de cirkel), en het
 * been loopt door tot onder de rand. Anders hield het in een cirkel net vóór
 * de rand op, en zag het er afgebroken uit.
 *
 * Chromium: zie CLAUDE.md (RESOFLY_CHROMIUM in een cloudsessie).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');

/** De tekens op het raster van lucide (24×24), zoals in lucide-react 0.408. */
const GLYPHS = {
  agenda: [
    '<path d="M8 2v4"/>',
    '<path d="M16 2v4"/>',
    '<rect width="18" height="18" x="3" y="4" rx="2"/>',
    '<path d="M3 10h18"/>',
    // Vandaag: een gevuld vakje, zodat het meer een agenda is dan een leeg blad.
    '<rect x="13.5" y="13.5" width="4" height="4" rx="0.8" fill="currentColor" stroke="none"/>',
  ],
  financien: [
    '<path d="M4 10h12"/>',
    '<path d="M4 14h9"/>',
    '<path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/>',
  ],
  communicatie: [
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/>',
    '<path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  ],
};

const brandSource = fs.readFileSync(path.join(ROOT, 'src', 'components', 'BrandMark.tsx'), 'utf8');
function constant(name) {
  const match = new RegExp(`export const ${name} =\\s*'([^']+)'`).exec(brandSource);
  if (!match) throw new Error(`${name} niet gevonden in BrandMark.tsx`);
  return match[1];
}
const TILE = constant('BRAND_TILE_COLOR');
const R_PATH = constant('BRAND_MARK_PATH');
const R_INK = '#000000';
const INK = '#1A1A1A';
// 20 eenheden van lucide worden 260px: ruim binnen de veilige zone (straal 205px).
const SCALE = 13;
const OFFSET = 256 - 12 * SCALE;

// Het been van de R: van de boog (rechts) en de teller (links) schuin naar de
// onderrand. In het icoon loopt het met dezelfde schuinte door tot onder de tegel.
const leg = /A[\d.]+ [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)L([\d.]+) 512H([\d.]+)L([\d.]+) ([\d.]+)H/.exec(R_PATH);
if (!leg) throw new Error('Het been van de R is niet te vinden in BRAND_MARK_PATH; pas de regex aan.');
const [rightTopX, rightTopY, rightBottomX, leftBottomX, leftTopX, leftTopY] = leg.slice(1).map(Number);
// Het verlengstuk begint ruim in het been (y 400): sloot het precies op de
// onderrand aan, dan bleef in het icoon van 192 een licht haarlijntje over waar
// twee halfgedekte pixelrijen elkaar raakten.
const slopeRight = (rightBottomX - rightTopX) / (512 - rightTopY);
const slopeLeft = (leftBottomX - leftTopX) / (512 - leftTopY);
const along = (bottomX, slope, y) => (bottomX + slope * (y - 512)).toFixed(1);
const legExtension = `M${along(leftBottomX, slopeLeft, 400)} 400L${along(rightBottomX, slopeRight, 400)} 400`
  + `L${along(rightBottomX, slopeRight, 700)} 700L${along(leftBottomX, slopeLeft, 700)} 700Z`;
// De verste hoek van de stam (88,406) komt zo op straal 196: binnen de veilige zone van 205.
const R_SCALE = 0.87;

function resoflySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${TILE}"/>
  <g transform="translate(256 256) scale(${R_SCALE}) translate(-256 -256)" fill="${R_INK}"><path d="${R_PATH}"/><path d="${legExtension}"/></g>
</svg>`;
}

/** De witte R in de statusbalk van Android: alleen de vorm telt, het been loopt tot de onderrand. */
function badgeSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="46 92 420 420"><path d="${R_PATH}" fill="#FFFFFF"/></svg>`;
}

function svg(id) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${TILE}"/>
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${SCALE})" fill="none" stroke="${INK}" color="${INK}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    ${GLYPHS[id].join('\n    ')}
  </g>
</svg>`;
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const icons = [[`icon-${size}.png`, resoflySvg()], ...Object.keys(GLYPHS).map(id => [`app-${id}-${size}.png`, svg(id)])];
    for (const [name, icon] of icons) {
      await page.setContent(`<!doctype html><html><body style="margin:0">${icon.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
      const file = path.join(OUT, name);
      await page.locator('svg').screenshot({ path: file, omitBackground: false });
      console.log(`${path.relative(ROOT, file)}`);
    }
    await page.close();
  }
  // De badge is doorzichtig: Android gebruikt alleen de vorm.
  const page = await browser.newPage({ viewport: { width: 72, height: 72 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${badgeSvg().replace('width="512" height="512"', 'width="72" height="72"')}</body></html>`);
  await page.locator('svg').screenshot({ path: path.join(OUT, 'badge-72.png'), omitBackground: true });
  console.log('public/icons/badge-72.png');
} finally {
  await browser.close();
}
fs.accessSync(OUT);
