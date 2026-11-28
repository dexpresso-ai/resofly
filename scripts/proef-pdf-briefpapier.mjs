#!/usr/bin/env node
// ============================================================
// Proef van een briefpapier als PDF onder de PDF van een pagina (stap 1B-5).
//
// Een PDF die pdf-lib zelf maakt, zegt hier weinig. Die van LibreOffice (de
// motor van Collabora) zit anders in elkaar: meer inhoudsstromen, links en
// bladwijzers. Dit script loopt daarom de echte weg na, zonder Collabora.
//
//   1. De Word-file van de server, met alleen de ruimte voor het briefpapier
//      (pageDocx.ts, letterhead zonder afbeelding).
//   2. Omzetten met LibreOffice: soffice --convert-to pdf.
//   3. Het briefpapier eronder (pdfLetterhead.ts).
//   4. Nakijken:
//      - evenveel bladzijden, links en bladwijzers als ervoor, en de titel;
//      - de tekst van het briefpapier en van de pagina op elke bladzijde
//        (pdftotext);
//      - op een bladzijde (pdftoppm): het briefpapier zichtbaar naast de
//        tekst, en de tekst zichtbaar óp het briefpapier. Dat vangt de twee
//        echte fouten: het briefpapier over de tekst, of verstopt onder een
//        witte bladzijde;
//      - hoe lang het duurt, ook voor een pagina van zo'n 20 bladzijden met
//        afbeeldingen.
//
// Gebruik (Node 22 of nieuwer, met soffice, pdftotext en pdftoppm):
//
//   node --experimental-strip-types scripts/proef-pdf-briefpapier.mjs <uitmap>
//
// In <uitmap>: handboek.pdf (met briefpapier), handboek-zonder.pdf,
// handboek-blad2.png om te bekijken, en groot.pdf voor de tijd.
// ============================================================

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import { buildPageDocx } from '../supabase/functions/_shared/pageDocx.ts';
import { loadLetterhead, underlayLetterhead } from '../supabase/functions/_shared/pdfLetterhead.ts';

const uit = process.argv[2] ? resolve(process.argv[2]) : '';
if (!uit) {
  console.error('Gebruik: node --experimental-strip-types scripts/proef-pdf-briefpapier.mjs <uitmap>');
  process.exit(2);
}
mkdirSync(uit, { recursive: true });

let fouten = 0;
const controle = (ok, wat) => {
  console.log(`${ok ? 'ok   ' : 'FOUT '} ${wat}`);
  if (!ok) fouten += 1;
};

/** Een png met één kleur: een afbeelding in de pagina. */
function png(breedte, hoogte, [r, g, b]) {
  const blok = (soort, data) => {
    const lengte = Buffer.alloc(4); lengte.writeUInt32BE(data.length);
    const som = Buffer.alloc(4); som.writeUInt32BE(crc32(Buffer.concat([Buffer.from(soort), data])) >>> 0);
    return Buffer.concat([lengte, Buffer.from(soort), data, som]);
  };
  const kop = Buffer.alloc(13);
  kop.writeUInt32BE(breedte, 0); kop.writeUInt32BE(hoogte, 4); kop[8] = 8; kop[9] = 2;
  const regel = Buffer.alloc(1 + breedte * 3);
  for (let x = 0; x < breedte; x += 1) { regel[1 + x * 3] = r; regel[2 + x * 3] = g; regel[3 + x * 3] = b; }
  const data = deflateSync(Buffer.concat(Array.from({ length: hoogte }, () => regel)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), blok('IHDR', kop), blok('IDAT', data), blok('IEND', Buffer.alloc(0))]);
}

const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...content) => ({ type: 'paragraph', content });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const alinea = (i) => p(t(`Alinea ${i}: een regel tekst om te zien of hij leesbaar op het briefpapier staat, `), t('met een link', [{ type: 'link', attrs: { href: 'https://example.com/handboek' } }]), t('.'));

// Het briefpapier: een lichte tint over de hele bladzijde, een donkere kopband
// met tekst, en een lichte voetband. De tint laat zien of de tekst erop staat.
const TINT = [214, 228, 250];
async function maakBriefpapier() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(TINT[0] / 255, TINT[1] / 255, TINT[2] / 255) });
  page.drawRectangle({ x: 0, y: 771.89, width: 595.28, height: 70, color: rgb(32 / 255, 64 / 255, 120 / 255) });
  page.drawText('BRIEFPAPIER PROEF', { x: 40, y: 800, size: 16, font, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 50, color: rgb(230 / 255, 236 / 255, 245 / 255) });
  page.drawText('Studio Noord - Havenstraat 1, Noorddorp', { x: 40, y: 20, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  return doc.save();
}

/** Bladzijden, links per bladzijde, bladwijzers en titel: wat er na het briefpapier hetzelfde moet zijn. */
async function vingerafdruk(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    bladzijden: doc.getPageCount(),
    links: doc.getPages().map(page => page.node.Annots()?.size() ?? 0),
    bladwijzers: Boolean(doc.catalog.get(PDFName.of('Outlines'))),
    titel: doc.getTitle() ?? null,
  };
}

/** De kleur van een punt (x, y in punten vanaf linksboven) op een bladzijde, via pdftoppm. */
function pixels(pdf, blad, dpi) {
  const ppm = execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(blad), '-l', String(blad), '-singlefile', pdf], { maxBuffer: 64 * 1024 * 1024 });
  const kop = ppm.toString('latin1', 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  if (!kop) throw new Error('pdftoppm gaf geen PPM');
  const [hele, breedte, hoogte] = [kop[0], Number(kop[1]), Number(kop[2])];
  const start = hele.length;
  return {
    breedte, hoogte,
    kleur(xPt, yPt) {
      const x = Math.min(breedte - 1, Math.round(xPt * dpi / 72));
      const y = Math.min(hoogte - 1, Math.round(yPt * dpi / 72));
      const i = start + (y * breedte + x) * 3;
      return [ppm[i], ppm[i + 1], ppm[i + 2]];
    },
  };
}

const soffice = (docx, naam) => {
  const map = join(uit, `lo-${naam}`);
  mkdirSync(map, { recursive: true });
  const bron = join(map, `${naam}.docx`);
  writeFileSync(bron, docx);
  execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${join(uit, 'lo-profiel')}`, '--convert-to', 'pdf', '--outdir', map, bron], { stdio: 'ignore', timeout: 180000 });
  return readFileSync(join(map, `${naam}.pdf`));
};

const pdfLib = { PDFDocument };
const briefpapier = await maakBriefpapier();
const blauw = png(400, 200, [37, 99, 235]);
const context = { images: { img1: { bytes: new Uint8Array(blauw), contentType: 'image/png' } } };
// De marges van "Voor briefpapier" in Documentopmaak, zoals in de Word-proef: inhoud vanaf 150 pt, voet vanaf 740 pt.
const ruimte = { image: null, top: 3000, bottom: 2038 };

// ── 1. Een handboek: voorblad, inhoudsopgave, hoofdstukken, links, een afbeelding.
const handboek = { type: 'doc', content: [h(1, 'Inleiding'), ...Array.from({ length: 30 }, (_, i) => alinea(i + 1)), { type: 'image', attrs: { attachmentId: 'img1', alt: 'Blauw vlak' } }] };
const hoofdstukken = [
  { title: 'Werkwijze', depth: 1, body: { type: 'doc', content: [h(1, 'Afspraken'), ...Array.from({ length: 12 }, (_, i) => alinea(100 + i))] } },
  { title: 'Tarieven', depth: 1, body: { type: 'doc', content: [p(t('Uurtarief € 95,00, exclusief btw.'))] } },
];
const voorblad = { lines: ['Klant: Bakkerij Jansen'], date: '28 november 2026', company: 'Studio Noord', logo: null };
const docx = Buffer.from(await (await buildPageDocx('Bedrijfshandboek', handboek, context, { cover: voorblad, toc: true, chapters: hoofdstukken, letterhead: ruimte })).arrayBuffer());
const zonder = soffice(docx, 'handboek');
writeFileSync(join(uit, 'handboek-zonder.pdf'), zonder);

const geladen = await loadLetterhead(pdfLib, new Uint8Array(briefpapier));
controle(geladen !== null, 'het briefpapier laadt');
let begin = performance.now();
const met = await underlayLetterhead(pdfLib, new Uint8Array(zonder), geladen);
const duurHandboek = performance.now() - begin;
writeFileSync(join(uit, 'handboek.pdf'), met);

const voor = await vingerafdruk(zonder);
const na = await vingerafdruk(met);
controle(voor.bladzijden > 2, `meer dan twee bladzijden (${voor.bladzijden})`);
controle(na.bladzijden === voor.bladzijden, `evenveel bladzijden (${voor.bladzijden} → ${na.bladzijden})`);
controle(voor.links.some(n => n > 0), `er zijn links om te bewaren (${voor.links.join(', ')})`);
controle(JSON.stringify(na.links) === JSON.stringify(voor.links), `dezelfde links per bladzijde (${na.links.join(', ')})`);
controle(na.bladwijzers === voor.bladwijzers, `de bladwijzers blijven (${voor.bladwijzers ? 'aanwezig' : 'geen'})`);
controle(na.titel === voor.titel && na.titel === 'Bedrijfshandboek', `de titel blijft (${na.titel})`);

const pdfMet = join(uit, 'handboek.pdf');
for (let blad = 1; blad <= na.bladzijden; blad += 1) {
  const tekst = execFileSync('pdftotext', ['-f', String(blad), '-l', String(blad), '-layout', pdfMet, '-']).toString('utf8');
  controle(tekst.includes('BRIEFPAPIER PROEF'), `bladzijde ${blad}: de tekst van het briefpapier`);
}
const alles = execFileSync('pdftotext', [pdfMet, '-']).toString('utf8');
controle(alles.includes('Alinea 30') && alles.includes('Uurtarief'), 'de tekst van de pagina en de hoofdstukken');

// Bladzijde 2 en 3 bekijken: de inhoudsopgave of de tekst, op het briefpapier.
const dpi = 72;
for (const blad of [2, 3]) {
  const beeld = pixels(pdfMet, blad, dpi);
  // In de kopband (zonder tekst van de pagina): het donkerblauw van het briefpapier.
  const band = beeld.kleur(560, 20);
  controle(band[2] > 100 && band[0] < 60, `bladzijde ${blad}: de kopband van het briefpapier is te zien (${band.join(',')})`);
  // De tint in de rechtermarge: het briefpapier is niet verstopt onder een witte bladzijde.
  const marge = beeld.kleur(580, 420);
  controle(Math.abs(marge[0] - TINT[0]) < 12 && Math.abs(marge[2] - TINT[2]) < 12, `bladzijde ${blad}: de tint van het briefpapier in de marge (${marge.join(',')})`);
  // In het tekstvlak donkere punten: de tekst staat óp het briefpapier.
  let donker = 0;
  for (let y = 160; y < 740; y += 2) for (let x = 72; x < 520; x += 2) { const [r, g, b] = beeld.kleur(x, y); if (r + g + b < 200) donker += 1; }
  controle(donker > 200, `bladzijde ${blad}: tekst op het briefpapier (${donker} donkere punten)`);
}
execFileSync('pdftoppm', ['-r', '60', '-f', '2', '-l', '2', '-singlefile', '-png', pdfMet, join(uit, 'handboek-blad2')]);

// ── 2. De tijd voor een grote pagina: zo'n 20 bladzijden, met afbeeldingen.
const groot = { type: 'doc', content: Array.from({ length: 20 }, (_, i) => [h(1, `Hoofdstuk ${i + 1}`), ...Array.from({ length: 14 }, (__, j) => alinea(i * 100 + j)), { type: 'image', attrs: { attachmentId: 'img1', alt: 'Blauw vlak' } }]).flat() };
const grootDocx = Buffer.from(await (await buildPageDocx('Groot handboek', groot, context, { letterhead: ruimte })).arrayBuffer());
const grootZonder = soffice(grootDocx, 'groot');
begin = performance.now();
const grootGeladen = await loadLetterhead(pdfLib, new Uint8Array(briefpapier));
const grootMet = await underlayLetterhead(pdfLib, new Uint8Array(grootZonder), grootGeladen);
const duurGroot = performance.now() - begin;
writeFileSync(join(uit, 'groot.pdf'), grootMet);
const grootNa = await vingerafdruk(grootMet);
controle(grootNa.bladzijden >= 15, `de grote pagina heeft ${grootNa.bladzijden} bladzijden`);
console.log(`tijd: handboek ${Math.round(duurHandboek)} ms (${voor.bladzijden} bladzijden, ${Math.round(zonder.length / 1024)} → ${Math.round(met.length / 1024)} kB); groot ${Math.round(duurGroot)} ms (${grootNa.bladzijden} bladzijden, ${Math.round(grootZonder.length / 1024)} → ${Math.round(grootMet.length / 1024)} kB)`);

console.log(fouten ? `${fouten} fout.` : 'Alles klopt.');
process.exit(fouten ? 1 : 0);
