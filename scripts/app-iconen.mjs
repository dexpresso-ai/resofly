#!/usr/bin/env node
/*
 * Tekent alle iconen in public/icons/ — `node scripts/app-iconen.mjs`.
 *
 *   resofly-logo.svg                het logo zelf, als vector
 *   icon-<maat>.png                 de werkruimte, `any`: het logo zoals het is
 *   icon-maskable-<maat>.png        de werkruimte, `maskable`: tegel tot de rand
 *   apple-touch-icon.png            het beginscherm van een iPhone of iPad
 *   badge-72.png                    de witte R in de statusbalk bij een melding
 *   app-<id>-<maat>.png             Agenda, Financiën, Communicatie, `any`
 *   app-<id>-maskable-<maat>.png    idem, `maskable` (ook hun apple-touch-icon)
 *
 * Tegel, kleuren en de R komen uit src/components/BrandMark.tsx: het logo in de
 * app en de iconen op een telefoon zijn zo altijd hetzelfde. Wie het logo
 * wijzigt, wijzigt BrandMark.tsx en draait dit script.
 *
 * Waarom twee soorten iconen:
 *   - `any` is het logo zoals het is, met de kleine ronde hoeken en daarbuiten
 *     doorzichtig. Dat gebruikt een computer (Windows, macOS, het tabblad).
 *     Tot 12 november was `any` een volle vierkante tegel; op een bureaublad
 *     stond ResoFly dan als enige app als hoekig blok tussen de rest.
 *   - `maskable` is een volle tegel tot aan de rand. Android knipt er zelf een
 *     cirkel of druppel uit; alleen wat binnen de cirkel van 80% valt (de
 *     veilige zone, straal 205 op 512) blijft zeker staan. Daarom staat de R
 *     daar kleiner in. Het been loopt in het logo tot de onderrand, en hier dus
 *     door tot onder de tegel: anders hield het in een cirkel net vóór de rand
 *     op, en zag het er afgebroken uit.
 *   - iOS leest het manifest niet en rondt zelf de hoeken af (±22%). Het
 *     apple-touch-icon is daarom een volle tegel met de R op de maat van het
 *     logo; de stam valt ruim binnen de hoeken van iOS. Een doorzichtige hoek
 *     maakt iOS zwart.
 *
 * Chromium: zie CLAUDE.md (RESOFLY_CHROMIUM in een cloudsessie).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');

// ── Het logo, uit BrandMark.tsx ────────────────────────────────────────────
const brandSource = fs.readFileSync(path.join(ROOT, 'src', 'components', 'BrandMark.tsx'), 'utf8');
function constant(name) {
  const match = new RegExp(`export const ${name} =\\s*'([^']+)'`).exec(brandSource) ?? new RegExp(`export const ${name} = (\\d+)`).exec(brandSource);
  if (!match) throw new Error(`${name} niet gevonden in BrandMark.tsx`);
  return match[1];
}
const TILE = constant('BRAND_TILE_COLOR');
const INK = constant('BRAND_INK');
const RADIUS = Number(constant('BRAND_TILE_RADIUS'));
const R_PATH = constant('BRAND_MARK_PATH');

// Het been van de R: van de boog (rechts) en de teller (links) schuin naar de
// onderrand. Voor de maskable versie loopt het met dezelfde schuinte door.
const leg = /A[\d.]+ [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)L([\d.]+) 512H([\d.]+)L([\d.]+) ([\d.]+)H/.exec(R_PATH);
if (!leg) throw new Error('Het been van de R is niet te vinden in BRAND_MARK_PATH; pas de regex aan.');
const [rightTopX, rightTopY, rightBottomX, leftBottomX, leftTopX, leftTopY] = leg.slice(1).map(Number);
const slopeRight = (rightBottomX - rightTopX) / (512 - rightTopY);
const slopeLeft = (leftBottomX - leftTopX) / (512 - leftTopY);
const LEG_END = 700;
const LEG_EXTENSION = `M${leftBottomX} 511L${rightBottomX} 511L${(rightBottomX + slopeRight * (LEG_END - 512)).toFixed(1)} ${LEG_END}L${(leftBottomX + slopeLeft * (LEG_END - 512)).toFixed(1)} ${LEG_END}Z`;
// Zo groot dat de verste hoek van de stam (88,406) op straal 196 komt: binnen de
// veilige zone van 205, met wat lucht.
const MASKABLE_SCALE = 0.87;

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>ResoFly</title>
  <rect width="512" height="512" rx="${RADIUS}" fill="${TILE}"/>
  <path d="${R_PATH}" fill="${INK}"/>
</svg>
`;

/** De werkruimte. `kind`: logo (any), maskable, apple (volle tegel, R op logomaat) of badge (wit, geen tegel). */
function resoflySvg(kind) {
  if (kind === 'logo') return logoSvg;
  if (kind === 'badge') {
    // Alleen de R, zo groot als het kan; het been loopt tot de onderrand, net als in het logo.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="46 92 420 420"><path d="${R_PATH}" fill="#FFFFFF"/></svg>`;
  }
  const r = kind === 'maskable'
    ? `<g transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256)" fill="${INK}"><path d="${R_PATH}"/><path d="${LEG_EXTENSION}"/></g>`
    : `<path d="${R_PATH}" fill="${INK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${TILE}"/>${r}</svg>`;
}

// ── De losse apps: dezelfde tegel, met het teken van de module ──────────────
/** De tekens op het raster van lucide (24×24), zoals in lucide-react 0.408: hetzelfde teken als in het menu van de app. */
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
// 20 eenheden van lucide worden 260px: ruim binnen de veilige zone (straal 205px),
// zodat één teken zowel in de ronde tegel (any) als in de volle (maskable) past.
const SCALE = 13;
const OFFSET = 256 - 12 * SCALE;

function appSvg(id, maskable) {
  const tile = maskable ? `<rect width="512" height="512" fill="${TILE}"/>` : `<rect width="512" height="512" rx="${RADIUS}" fill="${TILE}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${tile}
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${SCALE})" fill="none" stroke="${INK}" color="${INK}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    ${GLYPHS[id].join('\n    ')}
  </g>
</svg>`;
}

// ── Tekenen ───────────────────────────────────────────────────────────────
const jobs = [
  ...[192, 512].flatMap(size => [
    { file: `icon-${size}.png`, size, svg: resoflySvg('logo') },
    { file: `icon-maskable-${size}.png`, size, svg: resoflySvg('maskable') },
    ...Object.keys(GLYPHS).flatMap(id => [
      { file: `app-${id}-${size}.png`, size, svg: appSvg(id, false) },
      { file: `app-${id}-maskable-${size}.png`, size, svg: appSvg(id, true) },
    ]),
  ]),
  { file: 'apple-touch-icon.png', size: 180, svg: resoflySvg('apple') },
  { file: 'badge-72.png', size: 72, svg: resoflySvg('badge') },
];

fs.writeFileSync(path.join(OUT, 'resofly-logo.svg'), logoSvg);
console.log(path.relative(ROOT, path.join(OUT, 'resofly-logo.svg')));

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  for (const job of jobs) {
    const svg = job.svg.replace('<svg ', `<svg width="${job.size}" height="${job.size}" `);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const file = path.join(OUT, job.file);
    // Doorzichtig waar niets getekend is: de hoeken van `any` en de badge.
    await page.locator('svg').screenshot({ path: file, omitBackground: true });
    console.log(path.relative(ROOT, file));
  }
} finally {
  await browser.close();
}
