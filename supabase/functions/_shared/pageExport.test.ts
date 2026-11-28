/**
 * Tests voor het samenstellen van de Word-export (stap 1B-5). Draaien met:  npm test
 *
 * De app (Word, de Word-kopie) en de server (page-export, de PDF) halen elk
 * hun gegevens op, en geven ze hier door. Wat hier staat, moet dus voor allebei
 * kloppen: anders zien Word en PDF er verschillend uit (§9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSubpages, EXPORT_SUBPAGE_LIMIT, exportBrand, exportContext, exportCover, exportLogo, exportReferences, known, letterheadMargins,
} from './pageExport.ts';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const sub = (pageId: string) => ({ type: 'subpage', attrs: { pageId } });
const file = (attachmentId: string) => ({ type: 'fileBlock', attrs: { attachmentId } });
const image = (attachmentId: string) => ({ type: 'image', attrs: { attachmentId } });

test('de verwijzingen van de pagina en haar hoofdstukken samen, elk één keer', () => {
  assert.deepEqual(exportReferences([
    doc(sub('a'), file('f1'), image('i1')),
    doc(sub('a'), sub('b'), image('i1'), image('i2')),
    null,
    '{kapot',
  ]), { pages: ['a', 'b'], files: ['f1'], images: ['i1', 'i2'] });
});

type P = { id: string; title: string; parent_id: string | null; position: number | null };
const p = (id: string, parent: string, position: number | null = null, title = id): P => ({ id, title, parent_id: parent, position });

test('de subpagina\'s per laag: de volgorde van de boom, met diepte; een kring en dubbele rijen breken niets', async () => {
  const rows = [p('b', 'root', 2), p('a', 'root', 1), p('a1', 'a', null, 'Zeta'), p('a2', 'a', null, 'Alfa'), p('a', 'a1'), p('root', 'b')];
  const asked: string[][] = [];
  const result = await collectSubpages<P>('root', async (parents) => {
    asked.push(parents);
    return rows.filter(row => row.parent_id && parents.includes(row.parent_id));
  });
  assert.equal(result.tooMany, false);
  assert.deepEqual(result.subpages.map(entry => `${entry.page.id}:${entry.depth}`), ['a:1', 'a2:2', 'a1:2', 'b:1']);
  // Per laag één vraag; een pagina die al gezien is, wordt niet nog eens gevraagd.
  assert.deepEqual(asked, [['root'], ['b', 'a'], ['a1', 'a2']]);
});

test('meer dan de grens: geen lijst, en "te veel"; en nooit dieper dan 20 lagen', async () => {
  const many = Array.from({ length: EXPORT_SUBPAGE_LIMIT + 1 }, (_, i) => p(`p${i}`, 'root'));
  assert.deepEqual(await collectSubpages<P>('root', async (parents) => many.filter(row => parents.includes(row.parent_id as string))), { subpages: [], tooMany: true });
  let levels = 0;
  const deep = await collectSubpages<P>('root', async (parents) => {
    levels += 1;
    return parents.map(parent => p(`${parent}x`, parent));
  });
  assert.equal(levels, 20);
  assert.equal(deep.subpages.length, 20);
});

test('het logo: png, jpeg (ook als jpg) en gif; svg, webp of iets kapots niet', () => {
  const url = (mime: string) => `data:${mime};base64,${btoa('abc')}`;
  assert.deepEqual(exportLogo(url('image/png')), { bytes: new Uint8Array([97, 98, 99]), contentType: 'image/png' });
  assert.equal(exportLogo(url('image/jpg'))?.contentType, 'image/jpeg');
  assert.equal(exportLogo(url('image/gif'))?.contentType, 'image/gif');
  for (const value of [url('image/svg+xml'), url('image/webp'), 'data:image/png;base64,%%%', 'https://voorbeeld.nl/logo.png', null, undefined, '']) {
    assert.equal(exportLogo(value), null, String(value));
  }
});

test('kop en voet: de merkkleur, en de voettekst of anders de bedrijfsnaam', () => {
  assert.deepEqual(exportBrand({ brand_accent_color: '#123456', brand_footer_text: ' Studio · Noord ', company_name: 'Studio' }, null),
    { logo: null, color: '#123456', footerText: 'Studio · Noord' });
  assert.equal(exportBrand({ brand_footer_text: '  ', company_name: ' Studio ' }, null).footerText, 'Studio');
  assert.deepEqual(exportBrand(null, null), { logo: null, color: null, footerText: null });
});

test('het voorblad: klant en project alleen als ze er zijn, de datum zoals gegeven', () => {
  assert.deepEqual(exportCover({ clientName: 'Bakkerij Jansen', projectName: null, date: '28 november 2026', company: ' Studio ', logo: null }),
    { lines: ['Klant: Bakkerij Jansen', ''], date: '28 november 2026', company: 'Studio', logo: null });
});

test('de marges van het briefpapier: punten uit Documentopmaak naar twips', () => {
  // "Voor briefpapier": inhoud vanaf 150 pt, voet vanaf 740 pt, op A4 (841,89 pt).
  assert.deepEqual(letterheadMargins({ continueTop: 150, footerTop: 740 }, 841.89), { top: 3000, bottom: 2038 });
});

test('de context: alleen wat gevonden is, en zonder kopletter die van de tekst', () => {
  const font = { family: 'DM Sans' };
  const context = exportContext({
    titles: [['a', 'Hoofdstuk'], ['b', null]],
    fileNames: [['f', null]],
    images: [['i', { bytes: new Uint8Array([1]), contentType: 'image/png' }]],
    font,
    headingFont: null,
    brand: { logo: null, color: null, footerText: null },
  });
  assert.deepEqual(context.pageTitles, { a: 'Hoofdstuk' });
  assert.deepEqual(context.fileNames, {});
  assert.deepEqual(Object.keys(context.images ?? {}), ['i']);
  assert.equal(context.headingFont, font);
  assert.deepEqual(known([['x', 1], ['y', null]]), { x: 1 });
});
