#!/usr/bin/env node
/*
 * Lettertypen voor de PDF's — `node scripts/pdf-lettertypen.mjs`
 *
 * Een PDF heeft zonder ingesloten bestanden alleen Helvetica, Times en
 * Courier. Om de letters van de huisstijl (src/lib/branding.ts → BRAND_FONTS)
 * ook in offertes, facturen en creditfacturen te zetten, sluiten we ze in. Dit
 * script haalt de bestanden uit de fontsource-pakketten en zet ze op twee
 * plekken:
 *
 *   public/fonts/pdf/<naam>-<gewicht>.woff
 *       voor de app (voorbeeld, editor, concept-PDF), via fetch('/fonts/pdf/…');
 *   supabase/functions/_shared/pdfFonts.ts
 *       dezelfde bytes als base64, voor de edge functions die de verstuurde
 *       PDF maken. Zo hangt een factuur niet af van een lettertype-server die
 *       op dat moment bereikbaar moet zijn.
 *
 * Waarom WOFF en geen WOFF2: @pdf-lib/fontkit crasht bij het inkorten van
 * WOFF2 (gemeten 2026-11-05); WOFF werkt voor alle negen families.
 * Waarom alleen "latin": dat deel bevat alles wat een PDF met standaardletters
 * ook kan (WinAnsi), behalve Š š Ž ž Ÿ ƒ; die vallen terug op de letter zonder
 * accent (zie documentLayout.ts). Samen ~360 kB in plaats van enkele MB.
 *
 * Opnieuw maken (de pakketten staan bewust niet in package.json; ze zijn alleen
 * hiervoor nodig):
 *   npm install --no-save @fontsource/poppins@5.3.0 @fontsource/inter@5.3.0 \
 *     @fontsource/jost@5.3.0 @fontsource/space-grotesk@5.3.0 @fontsource/dm-sans@5.3.0 \
 *     @fontsource/playfair-display@5.3.0 @fontsource/cormorant-garamond@5.3.0 \
 *     @fontsource/lora@5.3.0 @fontsource/bebas-neue@5.3.0
 *   node scripts/pdf-lettertypen.mjs
 *
 * src/lib/documentLayout.test.ts controleert dat de twee kopieën gelijk zijn.
 * Alle families staan onder de SIL Open Font License 1.1, die insluiten in
 * documenten uitdrukkelijk toestaat (zie public/fonts/pdf/LICENTIES.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bestandsnaam in public/fonts/pdf → fontsource-pakket en gewichten. */
const FAMILIES = [
  ['poppins', 'poppins', [400, 700]],
  ['inter', 'inter', [400, 700]],
  ['jost', 'jost', [400, 700]],
  ['space-grotesk', 'space-grotesk', [400, 700]],
  ['dm-sans', 'dm-sans', [400, 700]],
  ['playfair-display', 'playfair-display', [400, 700]],
  ['cormorant-garamond', 'cormorant-garamond', [400, 700]],
  ['lora', 'lora', [400, 700]],
  ['bebas-neue', 'bebas-neue', [400]],
];

const outDir = path.join(ROOT, 'public', 'fonts', 'pdf');
fs.mkdirSync(outDir, { recursive: true });
const entries = [];
for (const [name, pkg, weights] of FAMILIES) {
  for (const weight of weights) {
    const source = path.join(ROOT, 'node_modules', '@fontsource', pkg, 'files', `${pkg}-latin-${weight}-normal.woff`);
    if (!fs.existsSync(source)) {
      console.error(`Ontbreekt: ${source}\nInstalleer eerst de fontsource-pakketten (zie de kop van dit script).`);
      process.exit(1);
    }
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(outDir, `${name}-${weight}.woff`), bytes);
    entries.push([`${name}-${weight}`, bytes.toString('base64')]);
  }
}

const module = `// GEGENEREERD door scripts/pdf-lettertypen.mjs — niet met de hand wijzigen.
//
// De lettertypen van de huisstijl als base64, voor de edge functions die de
// PDF van een offerte, factuur, creditfactuur of aanmaning maken. Dezelfde
// bytes staan in public/fonts/pdf/ voor de app; src/lib/documentLayout.test.ts
// controleert dat ze gelijk zijn. Licentie: SIL Open Font License 1.1.

export const PDF_FONT_FILES: Record<string, string> = {
${entries.map(([key, data]) => `  '${key}': '${data}',`).join('\n')}
};
`;
fs.writeFileSync(path.join(ROOT, 'supabase', 'functions', '_shared', 'pdfFonts.ts'), module);
console.log(`${entries.length} bestanden geschreven naar public/fonts/pdf en supabase/functions/_shared/pdfFonts.ts`);
