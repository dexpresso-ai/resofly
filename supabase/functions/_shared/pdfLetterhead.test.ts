/**
 * Tests voor het briefpapier als PDF onder de PDF van een pagina (stap 1B-5).
 * Draaien met:  npm test
 *
 * Hier met PDF's van pdf-lib zelf. De echte weg (een PDF van LibreOffice, de
 * motor van Collabora, en een afbeelding om naar te kijken) loopt
 * scripts/proef-pdf-briefpapier.mjs na: een PDF van pdf-lib zit anders in
 * elkaar, en een controle op de volgorde alleen zegt niet of je het ziet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts, type PDFPage } from 'pdf-lib';
import { LetterheadUnusable, loadLetterhead, underlayLetterhead } from './pdfLetterhead.ts';

const lib = { PDFDocument };
const A4: [number, number] = [595.28, 841.89];

/** Een PDF van twee bladzijden, elk met tekst en een link. */
async function content(options: { singleStream?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Handboek');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['een', 'twee']) {
    const page = doc.addPage(A4);
    page.drawText(`Bladzijde ${label}`, { x: 72, y: 700, size: 12, font });
    const link = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [72, 690, 200, 715], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: 'https://example.com' },
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
    if (options.singleStream) {
      // Zoals LibreOffice: één inhoudsstroom, geen lijst.
      const contents = page.node.Contents();
      if (contents instanceof PDFArray) page.node.set(PDFName.of('Contents'), contents.get(0));
    }
  }
  return doc.save();
}

/** Een briefpapier: een gekleurde band met tekst, op het formaat dat je kiest. */
async function letterhead(size: [number, number] = A4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(size);
  page.drawRectangle({ x: 0, y: size[1] - 60, width: size[0], height: 60, color: rgb(0.1, 0.2, 0.5) });
  page.drawText('BRIEFPAPIER', { x: 20, y: size[1] - 40, size: 14, font: await doc.embedFont(StandardFonts.Helvetica), color: rgb(1, 1, 1) });
  return doc.save();
}

/** De inhoudsstromen van een bladzijde, als tekst, in volgorde. */
function streams(doc: PDFDocument, page: PDFPage): string[] {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of('Contents'))];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    assert.ok(stream instanceof PDFRawStream, 'een inhoudsstroom');
    return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  });
}

test('het briefpapier komt onder elke bladzijde: zijn tekening eerst, dan de pagina zoals ze was', async () => {
  for (const singleStream of [false, true]) {
    const paper = await loadLetterhead(lib, await letterhead());
    assert.ok(paper);
    const out = await PDFDocument.load(await underlayLetterhead(lib, await content({ singleStream }), paper));
    assert.equal(out.getPageCount(), 2);
    out.getPages().forEach((page, index) => {
      const parts = streams(out, page);
      // Eerst het briefpapier (een ingesloten pagina: "Do"), tussen q en Q.
      assert.match(parts[0], /^q\b[\s\S]*\/EmbeddedPdfPage-\d+ Do\s+Q\s*$/, `bladzijde ${index + 1}, één stroom: ${singleStream}`);
      // Daarna de pagina, ingepakt in q … Q, zodat haar stand van zaken de hare blijft.
      assert.equal(parts[1].trim(), 'q');
      assert.equal(parts[parts.length - 1].trim(), 'Q');
      assert.ok(parts.slice(1).some(part => /BT[\s\S]*Tj[\s\S]*ET/.test(part)), 'de tekst van de pagina staat er nog');
    });
  }
});

test('links, de titel en de maker blijven die van het origineel', async () => {
  const paper = await loadLetterhead(lib, await letterhead());
  assert.ok(paper);
  const before = await PDFDocument.load(await content(), { updateMetadata: false });
  const out = await PDFDocument.load(await underlayLetterhead(lib, await content(), paper), { updateMetadata: false });
  assert.deepEqual(out.getPages().map(page => page.node.Annots()?.size()), [1, 1]);
  assert.equal(out.getTitle(), 'Handboek');
  assert.equal(out.getProducer(), before.getProducer());
});

test('een briefpapier op een ander formaat vult de bladzijde, zonder te vervormen', async () => {
  const paper = await loadLetterhead(lib, await letterhead([420, 595]));
  assert.ok(paper);
  const out = await PDFDocument.load(await underlayLetterhead(lib, await content(), paper));
  const [first] = streams(out, out.getPage(0));
  // pdf-lib schrijft verschuiven, draaien, schalen en scheeftrekken elk als een eigen cm.
  const scale = [...first.matchAll(/(-?[\d.]+) 0 0 (-?[\d.]+) 0 0 cm/g)].find(match => match[1] !== '1' || match[2] !== '1');
  assert.ok(scale, first);
  const expected = Math.max(A4[0] / 420, A4[1] / 595);
  assert.ok(Math.abs(Number(scale[1]) - expected) < 0.001 && Math.abs(Number(scale[2]) - expected) < 0.001, scale[0]);
  // Gecentreerd: wat er boven en onder af valt, is aan beide kanten even veel.
  const shift = first.match(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/);
  assert.ok(shift, first);
  assert.ok(Math.abs(Number(shift[1])) < 0.001 && Math.abs(Number(shift[2]) - (A4[1] - 595 * expected) / 2) < 0.001, shift[0]);
});

test('een lege eerste pagina: er valt niets te tekenen, en dat is geen fout', async () => {
  const empty = await PDFDocument.create();
  empty.addPage(A4);
  assert.equal(await loadLetterhead(lib, await empty.save()), null);
});

test('een briefpapier dat geen bruikbare PDF is, geeft een duidelijke melding', async () => {
  for (const bytes of [Buffer.from('%PDF-1.4\n'), Buffer.from('hallo'), new Uint8Array(0)]) {
    await assert.rejects(loadLetterhead(lib, new Uint8Array(bytes)), (error: unknown) => {
      assert.ok(error instanceof LetterheadUnusable);
      assert.match(error.message, /briefpapier is geen bruikbare PDF.*Documentopmaak/);
      return true;
    });
  }
});
