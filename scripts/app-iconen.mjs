#!/usr/bin/env node
/*
 * Tekent de iconen van de losse apps (Agenda, Financiën, Communicatie) naar
 * public/icons/app-<id>-<maat>.png — `node scripts/app-iconen.mjs`.
 *
 * Dezelfde gele tegel als het icoon van de werkruimte (public/icons/icon-512.png),
 * met in plaats van de R het teken van de module, uit lucide: hetzelfde teken
 * als in het menu van de app. Zo staan de vier naast elkaar op een beginscherm
 * als één familie, en zie je toch in één oogopslag welke welke is.
 *
 * Het teken blijft binnen de cirkel van 80% (de veilige zone van een
 * `maskable` icoon): Android knipt het icoon rond of als druppel, en dan mag er
 * niets van het teken af vallen. Daarom kan één bestand zowel `any` als
 * `maskable` zijn.
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

const TILE = '#FFD966';
const INK = '#1A1A1A';
// 20 eenheden van lucide worden 260px: ruim binnen de veilige zone (straal 205px).
const SCALE = 13;
const OFFSET = 256 - 12 * SCALE;

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
    for (const id of Object.keys(GLYPHS)) {
      await page.setContent(`<!doctype html><html><body style="margin:0">${svg(id).replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
      const file = path.join(OUT, `app-${id}-${size}.png`);
      await page.locator('svg').screenshot({ path: file, omitBackground: false });
      console.log(`${path.relative(ROOT, file)}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
fs.accessSync(OUT);
