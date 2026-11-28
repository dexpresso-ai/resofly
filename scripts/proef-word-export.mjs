#!/usr/bin/env node
// ============================================================
// Proefbestanden van de Word-export van pagina's (bouwplan pagina's, §9 en
// stap 1B-2 tot en met 1B-4). Ze staan naast het rapport, om in echte Word te
// openen; scripts/proef-word-rondgang.sh houdt ze tegen het schema, ook nadat
// LibreOffice (de motor van Collabora) ze opnieuw heeft opgeslagen.
//
// Gebruik (Node 22 of nieuwer):
//
//   node --experimental-strip-types scripts/proef-word-export.mjs <uitmap>
//
// Maakt in <uitmap>:
//   zonder-huisstijl.docx  elk blok, zonder letters en zonder huisstijl;
//   huisstijl.docx         elk blok, met Playfair Display en DM Sans, en de kop
//                          en voet in de huisstijl (logo, merkkleur, voettekst);
//   opties.docx            dat, met een voorblad, een inhoudsopgave vooraan en
//                          drie subpagina's als hoofdstukken;
//   briefpapier.docx       een briefpapier met een kop- en voetband achter elke
//                          bladzijde, de marges van "Voor briefpapier", een
//                          voorblad en genoeg tekst voor meer bladzijden.
//
// Waarom een script: de controle ging eerst met de hand, en een uitkomst werd
// een keer verkeerd gelezen (zie CHANGELOG_PAGINAS_EXPORTEREN_2026-11-28.md).
// ============================================================

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { buildPageDocx } from '../supabase/functions/_shared/pageDocx.ts';
import { sfntFamilyName, woffToSfnt } from '../supabase/functions/_shared/woff.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uit = process.argv[2];
if (!uit) {
  console.error('Gebruik: node --experimental-strip-types scripts/proef-word-export.mjs <uitmap>');
  process.exit(2);
}
mkdirSync(uit, { recursive: true });

/** Een png met vlakken (rechthoeken in een kleur) op een achtergrond: genoeg voor een logo en een briefpapier. */
function png(breedte, hoogte, achtergrond, vlakken = []) {
  const blok = (soort, data) => {
    const lengte = Buffer.alloc(4); lengte.writeUInt32BE(data.length);
    const som = Buffer.alloc(4); som.writeUInt32BE(crc32(Buffer.concat([Buffer.from(soort), data])) >>> 0);
    return Buffer.concat([lengte, Buffer.from(soort), data, som]);
  };
  const kop = Buffer.alloc(13);
  kop.writeUInt32BE(breedte, 0); kop.writeUInt32BE(hoogte, 4); kop[8] = 8; kop[9] = 2;
  const regels = [];
  for (let y = 0; y < hoogte; y += 1) {
    const regel = Buffer.alloc(1 + breedte * 3);
    for (let x = 0; x < breedte; x += 1) {
      const vlak = vlakken.find(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
      const [r, g, b] = vlak ? vlak[4] : achtergrond;
      regel[1 + x * 3] = r; regel[2 + x * 3] = g; regel[3 + x * 3] = b;
    }
    regels.push(regel);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), blok('IHDR', kop), blok('IDAT', deflateSync(Buffer.concat(regels))), blok('IEND', Buffer.alloc(0))]);
}

const woff = (naam) => woffToSfnt(new Uint8Array(readFileSync(join(ROOT, 'public/fonts/pdf', `${naam}.woff`))));
const letter = async (naam) => {
  const regular = await woff(`${naam}-400`);
  const bold = await woff(`${naam}-700`);
  return { family: sfntFamilyName(regular), regular, bold };
};

const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...content) => ({ type: 'paragraph', content });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const li = (...content) => ({ type: 'listItem', content });
const cel = (type, text, attrs = {}) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs }, content: [p(t(text))] });

// Elk blok, zoals in de proef van 1B-2.
const elkBlok = { type: 'doc', content: [
  { type: 'tableOfContents' },
  h(1, 'Inleiding'),
  p(t('Gewoon, '), t('vet', [{ type: 'bold' }]), t(', '), t('schuin', [{ type: 'italic' }]), t(', '), t('onderstreept', [{ type: 'underline' }]), t(' en een '), t('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]), t('. € 1.234,56, café, naïef.')),
  h(2, 'Lijsten'),
  { type: 'bulletList', content: [li(p(t('Eerste punt'))), li(p(t('Tweede punt')), { type: 'bulletList', content: [li(p(t('Genest punt')))] })] },
  { type: 'orderedList', content: [li(p(t('Stap een'))), li(p(t('Stap twee')))] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('Klaar'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('Nog te doen'))] }] },
  h(2, 'Tabel'),
  { type: 'table', content: [
    { type: 'tableRow', content: [cel('tableHeader', 'Naam', { colwidth: [200] }), cel('tableHeader', 'Rol'), cel('tableHeader', 'Uren', { align: 'right' })] },
    { type: 'tableRow', content: [cel('tableCell', 'Anna', { rowspan: 2 }), cel('tableCell', 'Ontwerp'), cel('tableCell', '12', { align: 'right' })] },
    { type: 'tableRow', content: [cel('tableCell', 'Bouw'), cel('tableCell', '8', { align: 'right' })] },
  ] },
  h(3, 'Kaders en meer'),
  { type: 'callout', attrs: { variant: 'let-op' }, content: [p(t('Een kader met "let op".'))] },
  { type: 'details', content: [{ type: 'detailsSummary', content: [t('Meer lezen')] }, { type: 'detailsContent', content: [p(t('Uitgeklapte inhoud.'))] }] },
  { type: 'blockquote', content: [p(t('Een citaat.'))] },
  { type: 'codeBlock', content: [t('const a = 1;')] },
  { type: 'horizontalRule' },
  { type: 'subpage', attrs: { pageId: 'kind' } },
  { type: 'fileBlock', attrs: { attachmentId: 'f1' } },
  { type: 'image', attrs: { attachmentId: 'img1', alt: 'Rood blok' } },
] };

const rood = png(200, 100, [220, 38, 38]);
// Een logo: een donkerblauw vlak met een lichte balk, 3 bij 1.
const logo = png(300, 100, [30, 58, 138], [[20, 40, 280, 60, [191, 219, 254]]]);
// Een briefpapier op A4 (150 dpi): een kopband en een voetband.
const briefpapier = png(1240, 1754, [255, 255, 255], [[0, 0, 1240, 150, [32, 64, 120]], [0, 1634, 1240, 1754, [230, 236, 245]]]);

const context = {
  pageTitles: { kind: 'Bedrijfshandboek' },
  fileNames: { f1: 'Offerte 2026.pdf' },
  images: { img1: { bytes: new Uint8Array(rood), contentType: 'image/png' } },
};
const huisstijl = {
  headingFont: await letter('playfair-display'),
  font: await letter('dm-sans'),
  brand: { logo: { bytes: new Uint8Array(logo), contentType: 'image/png' }, color: '#1E3A8A', footerText: 'Studio Noord · Havenstraat 1, Noorddorp' },
};
const hoofdstukken = [
  { title: 'Werkwijze', depth: 1, body: { type: 'doc', content: [p(t('Zo werken we samen.')), h(1, 'Afspraken'), p(t('Elke week een overleg.')), { type: 'tableOfContents' }, h(2, 'Bij spoed'), p(t('Bel ons direct.'))] } },
  { title: 'Planning', depth: 2, body: { type: 'doc', content: [h(1, 'Fasen'), p(t('Ontwerp, bouw, oplevering.'))] } },
  { title: 'Tarieven', depth: 1, body: { type: 'doc', content: [p(t('Uurtarief € 95,00, exclusief btw.')), { type: 'image', attrs: { attachmentId: 'img1', alt: 'Rood blok' } }] } },
];
const voorblad = {
  lines: ['Klant: Bakkerij Jansen', 'Project: Verbouwing 2026'],
  date: '28 november 2026',
  company: 'Studio Noord',
  logo: { bytes: new Uint8Array(logo), contentType: 'image/png' },
};
const lang = { type: 'doc', content: [h(1, 'Inleiding'), ...Array.from({ length: 40 }, (_, i) => p(t(`Alinea ${i + 1}: een regel tekst om te zien waar de bladzijde eindigt, onder en boven het briefpapier.`)))] };

const bestanden = [
  ['zonder-huisstijl.docx', 'Proefpagina', elkBlok, context, {}],
  ['huisstijl.docx', 'Proefpagina', elkBlok, { ...context, ...huisstijl }, {}],
  ['opties.docx', 'Bedrijfshandboek', elkBlok, { ...context, ...huisstijl }, { cover: voorblad, toc: true, chapters: hoofdstukken }],
  ['briefpapier.docx', 'Bedrijfshandboek', lang, { ...context, ...huisstijl }, {
    cover: voorblad, toc: true, chapters: hoofdstukken.slice(0, 1),
    // De marges van "Voor briefpapier" in Documentopmaak: inhoud vanaf 150 pt, voet vanaf 740 pt.
    letterhead: { image: { bytes: new Uint8Array(briefpapier), contentType: 'image/png' }, top: 3000, bottom: 2038 },
  }],
];
for (const [naam, titel, body, ctx, opties] of bestanden) {
  const blob = await buildPageDocx(titel, body, ctx, opties);
  writeFileSync(join(uit, naam), Buffer.from(await blob.arrayBuffer()));
  console.log(join(uit, naam));
}
