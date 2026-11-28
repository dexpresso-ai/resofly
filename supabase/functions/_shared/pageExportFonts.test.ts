/**
 * Tests voor de letters van een geëxporteerde pagina. Draaien met:  npm test
 *
 * De belangrijkste: dezelfde keuze als de PDF van een offerte of factuur. Een
 * pagina en een factuur van hetzelfde bedrijf horen dezelfde huisstijl te hebben.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PDF_FONTS, resolveDocumentStyle } from './documentLayout.ts';
import { PDF_FONT_FILES } from './pdfFonts.ts';
import { pageExportFonts } from './pageExportFonts.ts';

const KEYS = [null, '', 'onbekend', ...PDF_FONTS.map(font => font.key)];

test('dezelfde letters als de PDF van een offerte of factuur, voor elke combinatie', () => {
  for (const heading of KEYS) {
    for (const body of KEYS) {
      const row = { brand_heading_font: heading, brand_body_font: body };
      const style = resolveDocumentStyle(row);
      const fonts = pageExportFonts(row);
      assert.equal(fonts.heading.key, style.headingFont, `koppen bij ${heading}/${body}`);
      assert.equal(fonts.body.key, style.bodyFont, `tekst bij ${heading}/${body}`);
    }
  }
});

test('Bebas Neue alleen voor koppen, en zonder vet', () => {
  const fonts = pageExportFonts({ brand_heading_font: 'bebas', brand_body_font: 'bebas' });
  assert.deepEqual(fonts.heading, { key: 'bebas', family: 'Bebas Neue', regular: 'bebas-neue-400', bold: null });
  assert.equal(fonts.body.key, 'system');
  assert.deepEqual(pageExportFonts(null).body, { key: 'system', family: 'Poppins', regular: 'poppins-400', bold: 'poppins-700' });
});

test('elk bestand dat de keuze noemt, bestaat in de app en op de server', () => {
  for (const key of KEYS) {
    const fonts = pageExportFonts({ brand_heading_font: key, brand_body_font: key });
    for (const name of [fonts.heading.regular, fonts.heading.bold, fonts.body.regular, fonts.body.bold]) {
      if (!name) continue;
      assert.ok(existsSync(new URL(`../../../public/fonts/pdf/${name}.woff`, import.meta.url)), `public/fonts/pdf/${name}.woff`);
      assert.ok(PDF_FONT_FILES[name], `PDF_FONT_FILES['${name}']`);
    }
  }
});
