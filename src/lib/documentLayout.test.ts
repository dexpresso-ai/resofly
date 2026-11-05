/**
 * De opmaak van offertes en facturen: standaardsjablonen, strenge controle van
 * wat uit de database komt, het plannen van de pagina's, de PDF zelf — en dat
 * de app en de edge functions dezelfde code draaien. Draaien met:  npm test
 *
 * Het gevaarlijke geval is uit de pas lopen. Tekent de app het voorbeeld anders
 * dan invoice-workflow de verstuurde factuur, dan keurt de gebruiker iets goed
 * wat de klant niet krijgt. Dat was precies de fout die deze module oploste.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as PdfLib from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as app from './documentLayout.ts';
import * as server from '../../supabase/functions/_shared/documentLayout.ts';
import { BRAND_FONTS } from './branding.ts';
import { computeTotals, lineGross, lineNet } from './money.ts';
import { PDF_FONT_FILES } from '../../supabase/functions/_shared/pdfFonts.ts';

const {
  DOCUMENT_FIELDS, FLOW_ITEMS, LAYOUT_LIMITS, LAYOUT_PRESETS, PAGE_HEIGHT, PAGE_WIDTH, PDF_FONTS,
  buildDocumentData, builtInLayout, creditNoteDocument, documentAssetsFromSettings, documentFontTools, dunningDocument,
  embedDocumentFonts, formatDocDate, formatDocMoney, formatQuantity, layoutIssues, newFieldBlock, normalizeDocumentLayout,
  parseDocumentLayouts, pdfSafeText, planDocument, presetLayout, renderDocumentPdf, resolveDocumentLayout,
  resolveDocumentStyle, sampleDocumentData,
} = app;

const MARK = '// ---- Vanaf hier is dit bestand gelijk aan zijn spiegel (zie de test). ----';
const lib = PdfLib as unknown as app.PdfLibLike;

const COMPANY = {
  company_name: 'Noord Holding B.V.',
  trade_name: 'Studio Noord',
  address_line1: 'Keizersgracht 12',
  postal_code: '1015 CS',
  city: 'Amsterdam',
  country: 'Nederland',
  email: 'hallo@studionoord.nl',
  phone: '020 123 4567',
  website: 'studionoord.nl',
  kvk_number: '87654321',
  vat_number: 'NL001234567B01',
  iban: 'NL91ABNA0417164300',
  invoice_payment_terms: 'Graag betalen binnen 14 dagen.',
  invoice_footer: 'Bedankt voor het vertrouwen.',
  brand_accent_color: '#2457C5',
};

/** De lettertypen zoals de app ze laadt (public/fonts/pdf), met de echte fontkit. */
const FONT_SOURCE: app.PdfFontSource = {
  fontkit,
  load: async (name: string) => new Uint8Array(readFileSync(new URL(`../../public/fonts/pdf/${name}.woff`, import.meta.url))),
};

/** Meten, opschonen en basislijn met de echte letters, zoals de editor en de PDF het doen. */
async function toolsFor(style = resolveDocumentStyle(COMPANY), source: app.PdfFontSource | null = FONT_SOURCE) {
  const doc = await PdfLib.PDFDocument.create();
  return documentFontTools(await embedDocumentFonts(doc as unknown as app.PdfDocumentLike, style, source));
}

/** Alleen de meting (de meeste plantests). */
async function measurer(style = resolveDocumentStyle(COMPANY)) {
  return (await toolsFor(style)).measure;
}

function texts(plan: app.DocumentPlan): string[] {
  return plan.pages.flatMap(page => page.ops.filter(op => op.t === 'text').map(op => (op as { text: string }).text));
}

test('de spiegel voor de edge functions is teken voor teken gelijk', () => {
  const body = (path: string) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const at = source.indexOf(MARK);
    assert.ok(at > 0, `markering ontbreekt in ${path}`);
    return source.slice(at);
  };
  assert.equal(body('../../supabase/functions/_shared/documentLayout.ts'), body('./documentLayout.ts'));
  // En geen imports: het bestand moet ongewijzigd in Deno draaien.
  assert.doesNotMatch(body('./documentLayout.ts'), /^import /m);
});

test('zonder opmaak (of met rommel) geldt de standaard', () => {
  for (const raw of [undefined, null, 42, 'opmaak', [], {}, { invoice: 'x', quote: [] }, { version: 2, invoice: { version: 2 } }]) {
    const parsed = parseDocumentLayouts(raw);
    assert.equal(parsed.headingFont, 'auto');
    assert.equal(parsed.bodyFont, 'auto');
    assert.equal(parsed.invoice, null);
    assert.equal(parsed.quote, null);
    assert.deepEqual(resolveDocumentLayout(parsed, 'invoice'), builtInLayout('invoice'));
  }
  // Met briefpapier geen gekleurde balk over de kop van dat papier.
  assert.ok(builtInLayout('invoice').blocks.some(block => block.id === 'balk'));
  assert.ok(!builtInLayout('invoice', { letterhead: true }).blocks.some(block => block.id === 'balk'));
});

test('elk standaardsjabloon overleeft de controle ongeschonden', () => {
  for (const preset of LAYOUT_PRESETS) {
    for (const kind of ['invoice', 'quote'] as const) {
      const layout = presetLayout(preset.key, kind);
      assert.deepEqual(normalizeDocumentLayout(JSON.parse(JSON.stringify(layout)), kind), layout, `${preset.key}/${kind}`);
    }
  }
});

test('de controle laat niets van buiten de pagina of buiten de lijst door', () => {
  const raw = {
    version: 1,
    bodyTop: -50,
    footerTop: 99999,
    marginX: 'veel',
    repeatHeader: 'ja',
    table: { quantity: false, style: 'neon', lineTotals: 'excl' },
    totalsStyle: 'glitter',
    flow: [{ key: 'notes', show: true }, { key: 'lines', show: false }, { key: 'lines', show: true }, { key: 'hack', show: true }],
    blocks: [
      { id: 'a', type: 'field', field: 'klant.naam', x: -20, y: 5000, w: 9000, h: -3, size: 400, align: 'diagonal', tone: 'red' },
      { id: 'a', type: 'field', field: 'bestaat.niet', x: 10, y: 10, w: 10, h: 10 },
      { id: '<script>', type: 'text', text: 'x'.repeat(5000), x: 10, y: 10, w: 100, h: 20, caption: 'c'.repeat(100) },
      { id: 'b', type: 'iframe', x: 0, y: 0, w: 1, h: 1 },
      ...Array.from({ length: 80 }, (_, i) => ({ id: `l${i}`, type: 'line', x: 0, y: 0, w: 10, h: 4 })),
    ],
  };
  const layout = normalizeDocumentLayout(raw)!;
  assert.equal(layout.bodyTop, LAYOUT_LIMITS.bodyTop.min);
  assert.equal(layout.footerTop, LAYOUT_LIMITS.footerTop.max);
  assert.equal(layout.marginX, 48);
  assert.equal(layout.repeatHeader, false);
  assert.deepEqual(layout.table, { quantity: false, unitPrice: true, vatRate: true, lineTotals: 'excl', style: 'tinted' });
  assert.equal(layout.totalsStyle, 'line');
  assert.ok(layout.blocks.length <= LAYOUT_LIMITS.blocks);
  const field = layout.blocks[0];
  assert.equal(field.id, 'a');
  assert.ok(field.x >= 0 && field.x + field.w <= PAGE_WIDTH + 0.01);
  assert.ok(field.y >= 0 && field.y + field.h <= PAGE_HEIGHT + 0.01);
  assert.equal(field.size, LAYOUT_LIMITS.size.max);
  assert.equal(field.align, undefined);
  assert.equal(field.tone, undefined);
  assert.ok(!layout.blocks.some(block => block.field === 'bestaat.niet'));
  assert.ok(!layout.blocks.some(block => (block.type as string) === 'iframe'));
  const text = layout.blocks.find(block => block.type === 'text')!;
  assert.match(text.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(text.text!.length, LAYOUT_LIMITS.text);
  assert.equal(text.caption!.length, LAYOUT_LIMITS.caption);
  assert.equal(new Set(layout.blocks.map(block => block.id)).size, layout.blocks.length, 'unieke kenmerken');
  // Regels, totalen en btw-vermeldingen gaan nooit weg en komen in die volgorde
  // na elkaar; de gekozen volgorde blijft, wat ontbrak staat uit achteraan.
  const keys = layout.flow.map(item => item.key);
  assert.deepEqual(keys.slice(0, 4), ['notes', 'lines', 'totals', 'vat_notes']);
  assert.ok(layout.flow.slice(4).every(item => !item.show));
  for (const required of FLOW_ITEMS.filter(item => item.required)) {
    assert.ok(layout.flow.find(item => item.key === required.key)?.show, `${required.key} staat aan`);
  }
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes('hack' as app.LayoutFlowKey));
});

test('de standaardopmaak bevat alles wat wettelijk op een factuur en offerte hoort', () => {
  for (const kind of ['invoice', 'quote'] as const) {
    assert.deepEqual(layoutIssues(builtInLayout(kind), kind), [], kind);
    assert.deepEqual(layoutIssues(presetLayout('strak', kind), kind), [], `strak/${kind}`);
  }
  // Het sjabloon voor briefpapier laat afzender en nummers aan het papier over,
  // en de melding zegt dat ook.
  const issues = layoutIssues(presetLayout('briefpapier', 'invoice'), 'invoice', { letterhead: true });
  assert.deepEqual(issues.map(issue => issue.id), ['afzender', 'kvk', 'btw']);
  assert.match(issues[0].message, /briefpapier/);
  // Met de KOR hoeft het btw-nummer er niet op.
  assert.ok(!layoutIssues(presetLayout('briefpapier', 'invoice'), 'invoice', { kor: true }).some(issue => issue.id === 'btw'));
  const empty = { ...builtInLayout('invoice'), blocks: [] };
  assert.deepEqual(layoutIssues(empty, 'invoice').map(issue => issue.id), ['nummer', 'datum', 'afzender', 'kvk', 'btw', 'klant']);
});

test('notatie: euro, datum, aantal, en tekst die Helvetica kan tekenen', () => {
  assert.equal(formatDocMoney(1234.5), '€ 1.234,50');
  assert.equal(formatDocMoney(-12), '€ -12,00');
  assert.equal(formatDocMoney(0.005), '€ 0,01');
  assert.equal(formatDocMoney(Number.NaN), '€ 0,00');
  assert.equal(formatDocMoney(1234567.891), '€ 1.234.567,89');
  assert.equal(formatDocDate('2026-11-05'), '5-11-2026');
  assert.equal(formatDocDate('2026-01-31T10:00:00Z'), '31-1-2026');
  assert.equal(formatDocDate(null), '-');
  assert.equal(formatQuantity(1.5), '1,5');
  assert.equal(formatQuantity(2), '2');
  assert.equal(pdfSafeText('Taart 🎂 – € 12 − 3 “ok” x'), 'Taart  – € 12 - 3 “ok” x');
  assert.equal(pdfSafeText('regel 1\r\nregel 2'), 'regel 1\nregel 2');
});

test('de juridische naam staat erop, maar niet dubbel', async () => {
  const measure = await measurer();
  const style = resolveDocumentStyle(COMPANY);
  // Merknaam en juridische naam verschillen: allebei erop.
  const withTrade = planDocument(builtInLayout('invoice'), sampleDocumentData('invoice', COMPANY), style, { measure, logo: null });
  assert.ok(texts(withTrade).includes('Studio Noord'));
  assert.ok(texts(withTrade).includes('Noord Holding B.V.'));
  // Alleen een juridische naam en geen logo: die staat groot bovenaan, niet nog eens boven het adres.
  const plain = { ...COMPANY, trade_name: null };
  const once = planDocument(builtInLayout('invoice'), sampleDocumentData('invoice', plain), style, { measure, logo: null });
  assert.equal(texts(once).filter(text => text === 'Noord Holding B.V.').length, 1);
  // Met een logo staat de naam er niet als tekst; dan wel boven het adres.
  const logo = planDocument(builtInLayout('invoice'), sampleDocumentData('invoice', plain), style, { measure, logo: { width: 600, height: 200 } });
  assert.equal(texts(logo).filter(text => text === 'Noord Holding B.V.').length, 1);
  assert.ok(logo.pages[0].ops.some(op => op.t === 'image'));
  // KvK en btw-nummer staan er altijd los op (in de oude PDF vielen ze weg).
  for (const plan of [withTrade, once, logo]) {
    assert.ok(texts(plan).includes('87654321'));
    assert.ok(texts(plan).includes('NL001234567B01'));
  }
});

test('alles blijft op de pagina, en de inhoud blijft tussen kop en voet', async () => {
  const measure = await measurer();
  for (const preset of LAYOUT_PRESETS) {
    for (const kind of ['invoice', 'quote'] as const) {
      const layout = presetLayout(preset.key, kind);
      const plan = planDocument(layout, sampleDocumentData(kind, COMPANY), resolveDocumentStyle(COMPANY), { measure, logo: null });
      for (const page of plan.pages) {
        for (const op of page.ops) {
          if (op.t !== 'text') continue;
          const width = measure(op.text, op.size, op.font);
          assert.ok(op.x >= -0.01 && op.x + width <= PAGE_WIDTH + 0.01, `${preset.key}/${kind}: "${op.text}" valt van de pagina`);
          assert.ok(op.y > 0 && op.y < PAGE_HEIGHT, `${preset.key}/${kind}: "${op.text}" valt van de pagina`);
        }
        for (const part of page.flow) {
          assert.ok(part.box.y >= page.flowTop - 0.01, `${part.key} begint boven de inhoud`);
          assert.ok(part.box.y + part.box.h <= page.flowBottom + 0.01, `${part.key} loopt de voet in`);
        }
      }
      // De kopblokken liggen in het voorbeeld niet over elkaar heen.
      const boxes = Object.entries(plan.pages[0].boxes).filter(([id]) => {
        const block = layout.blocks.find(item => item.id === id)!;
        return block.type === 'field' && block.y < layout.bodyTop;
      });
      for (const [a, boxA] of boxes) {
        for (const [b, boxB] of boxes) {
          if (a >= b) continue;
          const overlap = boxA.x < boxB.x + boxB.w && boxB.x < boxA.x + boxA.w && boxA.y < boxB.y + boxB.h && boxB.y < boxA.y + boxA.h;
          assert.ok(!overlap, `${preset.key}/${kind}: ${a} en ${b} overlappen`);
        }
      }
    }
  }
});

test('een lang document loopt door, elke regel precies één keer, met paginanummers', async () => {
  const measure = await measurer();
  const data = sampleDocumentData('invoice', COMPANY);
  data.lines = Array.from({ length: 60 }, (_, i) => ({
    description: i % 9 === 0 ? `Regel ${i}: ${'een lange omschrijving van het werk '.repeat(8)}` : `Regel ${i}`,
    quantity: 1, unitPrice: 10, vatRate: 21, net: 10, gross: 12.1,
  }));
  const plan = planDocument(builtInLayout('invoice'), data, resolveDocumentStyle(COMPANY), { measure, logo: null });
  assert.ok(plan.pages.length >= 2);
  const all = texts(plan);
  for (let i = 0; i < 60; i++) {
    assert.equal(all.filter(text => text === `Regel ${i}` || text.startsWith(`Regel ${i}:`)).length, 1, `Regel ${i}`);
  }
  plan.pages.forEach((page, index) => {
    const label = `Pagina ${index + 1} van ${plan.pages.length}`;
    assert.ok(page.ops.some(op => op.t === 'text' && op.text === label), label);
    // Elke pagina met regels heeft een tabelkop; een pagina met alleen het totaal niet.
    if (page.flow.some(part => part.key === 'lines')) {
      assert.ok(page.ops.some(op => op.t === 'text' && op.text === 'Omschrijving'), `tabelkop op pagina ${index + 1}`);
    }
  });
  // Het totaal staat na de laatste regel: op dezelfde pagina eronder, of verder.
  const at = (text: string) => plan.pages.findIndex(page => page.ops.some(op => op.t === 'text' && op.text === text));
  const lastLine = at('Regel 59');
  const totalPage = at('€ 2.070,40');
  assert.ok(totalPage >= lastLine && lastLine >= 0, `regel op ${lastLine}, totaal op ${totalPage}`);
  if (totalPage === lastLine) {
    const y = (text: string) => (plan.pages[lastLine].ops.find(op => op.t === 'text' && op.text === text) as { y: number }).y;
    assert.ok(y('€ 2.070,40') > y('Regel 59'));
  }
});

test('een groeiend klantadres duwt het blok eronder en de regels omlaag', async () => {
  const measure = await measurer();
  const layout = builtInLayout('invoice');
  layout.blocks.push(newFieldBlock('klant.email', layout.blocks, { x: 48, y: 300 })!);
  const data = sampleDocumentData('invoice', COMPANY);
  data.client = { ...data.client!, addressLines: Array.from({ length: 9 }, (_, i) => `Adresregel ${i + 1}`) };
  const plan = planDocument(layout, data, resolveDocumentStyle(COMPANY), { measure, logo: null });
  const page = plan.pages[0];
  const klant = page.boxes.klant;
  const email = page.boxes[layout.blocks[layout.blocks.length - 1].id];
  assert.ok(email.y >= klant.y + klant.h, 'het blok eronder schoof mee');
  assert.ok(page.flowTop >= email.y + email.h, 'de regels beginnen onder de kop');
});

test('{{velden}} in een eigen tekst, met terugval', async () => {
  const measure = await measurer();
  const layout = builtInLayout('quote');
  layout.flow = layout.flow.map(item => item.key === 'intro'
    ? { ...item, show: true, text: 'Beste {{klant.contactpersoon|klant.naam}}, hierbij {{document.titel}} {{document.nummer}} — geldig tot {{document.geldig_tot}}. {{bestaat.niet|Groet}}' }
    : item);
  const data = sampleDocumentData('quote', COMPANY);
  const plan = planDocument(layout, data, resolveDocumentStyle(COMPANY), { measure, logo: null });
  const intro = texts(plan).join(' ');
  assert.match(intro, /Beste Sanne de Vries, hierbij OFFERTE OFF-2026-0042 — geldig tot 5-12-2026\. Groet/);
  data.client = { ...data.client!, contactName: '' };
  const fallback = texts(planDocument(layout, data, resolveDocumentStyle(COMPANY), { measure, logo: null })).join(' ');
  assert.match(fallback, /Beste Bakkerij De Korenaar,/);
});

test('stijl: merkkleur leesbaar als tekst, letters volgen de huisstijl', () => {
  const gold = resolveDocumentStyle({ brand_accent_color: '#FFD966' });
  assert.equal(gold.accent, '#FFD966');
  assert.ok(app.documentContrast(gold.accentInk, '#FFFFFF') >= 4.5, gold.accentInk);
  assert.equal(gold.onAccent, '#111111');
  assert.equal(resolveDocumentStyle({ brand_accent_color: '#00084D' }).onAccent, '#FFFFFF');
  assert.equal(resolveDocumentStyle({ invoice_font_size: 40 }).baseSize, LAYOUT_LIMITS.baseSize.max);
  // Zoals je huisstijl: letterlijk de letters van de huisstijl, nu ook in de PDF.
  const brand = resolveDocumentStyle({ brand_heading_font: 'playfair', brand_body_font: 'inter' });
  assert.equal(brand.headingFont, 'playfair');
  assert.equal(brand.bodyFont, 'inter');
  assert.equal(resolveDocumentStyle(null).bodyFont, 'system');
  // Een eigen keuze wint; Bebas Neue (alleen kapitalen) nooit als tekstletter.
  assert.equal(resolveDocumentStyle({ brand_heading_font: 'playfair' }, { heading: 'courier' }).headingFont, 'courier');
  assert.equal(resolveDocumentStyle({ brand_body_font: 'bebas' }).bodyFont, 'system');
  assert.equal(resolveDocumentStyle(null, { body: 'bebas' }).bodyFont, 'system');
  assert.equal(resolveDocumentStyle(null, { heading: 'bebas' }).headingFont, 'bebas');
  // Een oude opmaak met één letter voor alles.
  const legacy = parseDocumentLayouts({ font: 'times' });
  assert.equal(legacy.headingFont, 'times');
  assert.equal(legacy.bodyFont, 'times');
});

test('elke letter van de huisstijl kan ook in de PDF', () => {
  for (const font of BRAND_FONTS) {
    const pdf = PDF_FONTS.find(item => item.key === font.key);
    assert.ok(pdf, `${font.key} ontbreekt in PDF_FONTS`);
    assert.equal(Boolean(pdf!.headingOnly), Boolean(font.headingOnly), `${font.key}: alleen koppen`);
    assert.equal(pdf!.serif, /\bserif\b/.test(font.stack.replace('sans-serif', '')), `${font.key}: schreef`);
    assert.ok(!pdf!.standard && pdf!.file, `${font.key}: moet ingesloten worden`);
  }
});

test('de lettertypebestanden van app en server zijn dezelfde bytes', () => {
  const files = readdirSync(new URL('../../public/fonts/pdf/', import.meta.url)).filter(name => name.endsWith('.woff'));
  const expected = PDF_FONTS.filter(font => font.file).flatMap(font => (font.bold ? [400, 700] : [400]).map(weight => `${font.file}-${weight}`));
  assert.deepEqual(files.map(name => name.replace('.woff', '')).sort(), [...expected].sort());
  assert.deepEqual(Object.keys(PDF_FONT_FILES).sort(), [...expected].sort());
  for (const name of expected) {
    const bytes = readFileSync(new URL(`../../public/fonts/pdf/${name}.woff`, import.meta.url));
    assert.equal(PDF_FONT_FILES[name], bytes.toString('base64'), `${name} verschilt tussen public/fonts/pdf en pdfFonts.ts`);
  }
});

test('de letters gaan mee in de PDF, en zonder letters wordt het Helvetica', async () => {
  const data = sampleDocumentData('invoice', COMPANY);
  for (const font of PDF_FONTS) {
    const style = resolveDocumentStyle(COMPANY, { heading: font.key, body: font.headingOnly ? 'inter' : font.key });
    const warnings: string[] = [];
    const bytes = await renderDocumentPdf(lib, { layout: builtInLayout('invoice'), data, style, fonts: FONT_SOURCE, onWarning: message => warnings.push(message) });
    assert.deepEqual(warnings, [], font.key);
    const loaded = await PdfLib.PDFDocument.load(bytes);
    assert.equal(loaded.getPageCount(), 1);
    // Een ingesloten letter heeft een FontFile2/FontFile3 in de PDF; een standaardletter niet.
    const embedded = loaded.context.enumerateIndirectObjects().some(([, object]) =>
      object instanceof PdfLib.PDFDict && (object.has(PdfLib.PDFName.of('FontFile2')) || object.has(PdfLib.PDFName.of('FontFile3'))));
    assert.equal(embedded, !font.standard, `${font.key}: ${font.standard ? 'niets' : 'wel'} ingesloten verwacht`);
  }
  const warnings: string[] = [];
  const fallback = await renderDocumentPdf(lib, { layout: builtInLayout('invoice'), data, style: resolveDocumentStyle({ brand_body_font: 'lora' }), onWarning: message => warnings.push(message) });
  assert.equal(new TextDecoder().decode(fallback.slice(0, 5)), '%PDF-');
  assert.ok(warnings.some(message => /Lora/.test(message) && /Times/.test(message)), warnings.join(' | '));
});

test('een teken dat de ingesloten letter mist, valt terug op de letter zonder accent', async () => {
  const poppins = await toolsFor(resolveDocumentStyle(null, { heading: 'system', body: 'system' }));
  assert.equal(poppins.clean('Škoda Žižkov ƒ – € “ok” 😀', 'body'), 'Skoda Zizkov f – € “ok” ');
  // Helvetica kent die tekens wel (WinAnsi): daar blijven ze staan.
  const helvetica = await toolsFor(resolveDocumentStyle(null, { heading: 'helvetica', body: 'helvetica' }));
  assert.equal(helvetica.clean('Škoda Žižkov', 'body'), 'Škoda Žižkov');
  // De basislijn komt uit de letter zelf, binnen redelijke grenzen.
  for (const tools of [poppins, helvetica]) {
    for (const ref of ['body', 'bodyBold', 'heading', 'headingBold'] as const) {
      assert.ok(tools.ascent(ref) >= 0.68 && tools.ascent(ref) <= 0.82, `${ref}: ${tools.ascent(ref)}`);
    }
  }
  assert.equal(helvetica.ascent('body'), 0.718);
});

test('creditfactuur: opmaak van de factuur, negatieve bedragen, reden en wat er met het geld gebeurt', async () => {
  const style = resolveDocumentStyle(COMPANY);
  const tools = await toolsFor(style);
  const layout = builtInLayout('invoice');
  // Een eigen inleiding hoort bij de factuur, niet bij de creditfactuur.
  layout.flow = layout.flow.map(item => (item.key === 'intro' ? { ...item, show: true, text: 'Hierbij ontvang je onze factuur.' } : item));
  // Ook als de betaalregel op de factuur uit staat, zegt de creditfactuur wat er met het bedrag gebeurt.
  layout.flow = layout.flow.map(item => (item.key === 'payment' ? { ...item, show: false } : item));
  const data = creditNoteDocument({
    number: 'CN-1', date: '2026-11-12', invoiceReference: 'F-1', invoiceDate: '2026-11-05', company: COMPANY,
    client: { name: 'Klant B.V.', client_code: 'K-9' },
    lines: [{ description: 'Werk', quantity: 2, unit_price: 50, vat: 21 }, { description: 'Boek', quantity: 1, unit_price: 20, vat: 9 }],
    subtotal: 120, vat: 22.8, total: 142.8, reason: 'Dubbel gefactureerd', refunded: false,
  });
  const plan = planDocument(layout, data, style, { ...tools, logo: null });
  const all = texts(plan);
  for (const expected of ['CREDITFACTUUR', 'CN-1', 'F-1', 'Creditering van factuur', '€ -50,00', '€ -121,00', '€ -142,80', 'Totaal credit', 'REDEN', 'Dubbel gefactureerd', 'Hiermee vervalt de factuur; u hoeft niets meer te betalen.', 'Btw 21% over € -100,00']) {
    assert.ok(all.some(text => text.includes(expected)), `"${expected}" ontbreekt`);
  }
  assert.ok(!all.some(text => text.includes('Hierbij ontvang je onze factuur')), 'geen factuurinleiding op een creditfactuur');
  assert.ok(!all.some(text => text.includes('Bekijk en betaal')), 'geen betaallink');

  // Komt de btw uit de regels niet precies uit op de geboekte btw, dan één regel, nooit een afwijking.
  const blended = creditNoteDocument({
    number: 'CN-2', date: '2026-11-12', invoiceReference: 'F-2', invoiceDate: null, company: COMPANY, client: null,
    lines: [{ description: 'Deel', quantity: 1, unit_price: 82.64, vat: 20.99 }], subtotal: 82.64, vat: 17.36, total: 100, refunded: true,
  });
  assert.deepEqual(blended.totals, { subtotal: -82.64, vat: -17.36, total: -100, vatBreakdown: [] });
  assert.deepEqual(blended.paymentLines, ['Dit bedrag wordt aan u terugbetaald.']);
});

test('aanmaning: de brief in de opmaak van de factuur, zonder regels', async () => {
  const style = resolveDocumentStyle(COMPANY);
  const tools = await toolsFor(style);
  const base = {
    company: COMPANY, client: { name: 'Klant B.V.', contact_name: 'Jan', client_code: 'K-9' },
    letterDate: '2026-12-10', invoiceNumber: 'F-1', invoiceDate: '2026-11-05', invoiceDueDate: '2026-11-19',
    principalCents: 121000, interestCents: 1500, interestDays: 21, interestRatePct: '10,15',
    collectionCostsCents: 18150, collectionCostsVatCents: 3812, totalClaimCents: 144462, deadlineDate: '2026-12-24',
    iban: 'NL91ABNA0417164300', publicUrl: 'https://example.test/invoice/x',
  };
  const business = planDocument(builtInLayout('invoice'), dunningDocument({ ...base, consumer: false }), style, { ...tools, logo: null });
  const all = texts(business).join('\n');
  for (const expected of ['AANMANING', 'Betreft: aanmaning factuur F-1', 'Uiterste betaaldatum', '24-12-2026', 'SPECIFICATIE', 'Hoofdsom (openstaand)', 'Totaal te voldoen', '€ 1.444,62', 'Met vriendelijke groet,', 'Studio Noord', 'Noord Holding B.V.', 'Uw onderneming is van rechtswege in verzuim']) {
    assert.ok(all.includes(expected), `"${expected}" ontbreekt`);
  }
  // T.n.v. de juridische naam (de rekeninghouder), niet de merknaam.
  assert.match(all.replace(/\n/g, ' '), /t\.n\.v\. Noord Holding B\.V\./);
  assert.ok(!all.includes('Omschrijving'), 'geen regeltabel in een brief');
  const consumer = texts(planDocument(builtInLayout('invoice'), dunningDocument({ ...base, consumer: true }), style, { ...tools, logo: null })).join(' ');
  assert.ok(consumer.includes('Nu te voldoen (hoofdsom + rente)'));
  assert.ok(consumer.includes('veertien dagen vanaf de dag nadat deze brief bij u is bezorgd'));
  assert.ok(!consumer.includes('Uiterste betaaldatum'), 'een consument krijgt geen vaste datum (art. 6:96 lid 6 BW)');
  // De voorbeelden van de editor gebruiken dezelfde bouwstenen.
  assert.equal(sampleDocumentData('dunning', COMPANY).kind, 'dunning');
  assert.equal(sampleDocumentData('credit_note', COMPANY).totalsLabel, 'Totaal credit');
});

test('de PDF: logo, briefpapier, en een kapot plaatje laat hem niet mislukken', async () => {
  const data = sampleDocumentData('invoice', COMPANY);
  const style = resolveDocumentStyle(COMPANY);
  const layout = builtInLayout('invoice');
  const plain = await renderDocumentPdf(lib, { layout, data, style, fonts: FONT_SOURCE });
  assert.equal(new TextDecoder().decode(plain.slice(0, 5)), '%PDF-');

  // Een echt (piepklein) PNG-logo, en een PDF als briefpapier.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const paperDoc = await PdfLib.PDFDocument.create();
  paperDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const paper = `data:application/pdf;base64,${Buffer.from(await paperDoc.save()).toString('base64')}`;
  const assets = documentAssetsFromSettings({ brand_logo_data_url: png, invoice_template_kind: 'pdf', invoice_template_data_url: paper, invoice_template_mime_type: 'application/pdf' });
  assert.equal(assets.logo?.type, 'png');
  assert.equal(assets.letterhead?.kind, 'pdf');
  const warnings: string[] = [];
  const branded = await renderDocumentPdf(lib, { layout, data, style, assets, fonts: FONT_SOURCE, onWarning: message => warnings.push(message) });
  assert.deepEqual(warnings, []);
  const loaded = await PdfLib.PDFDocument.load(branded);
  assert.equal(loaded.getPageCount(), 1);

  const broken = await renderDocumentPdf(lib, {
    layout, data, style, fonts: FONT_SOURCE,
    assets: { logo: { bytes: new Uint8Array([1, 2, 3]), type: 'png' }, letterhead: { kind: 'pdf', bytes: new Uint8Array([4, 5]) } },
    onWarning: message => warnings.push(message),
  });
  assert.equal(new TextDecoder().decode(broken.slice(0, 5)), '%PDF-');
  assert.equal(warnings.length, 2);
  // WebP kan een PDF niet aan: dan geen logo (de naam staat er dan).
  assert.equal(documentAssetsFromSettings({ brand_logo_data_url: 'data:image/webp;base64,UklGRg==' }).logo, undefined);
});

test('app en server maken van dezelfde rijen hetzelfde document', async () => {
  const input = {
    kind: 'invoice' as const, number: 'F-1', date: '2026-11-05', secondDate: '2026-11-19',
    company: COMPANY, client: { name: 'Klant B.V.', contact_name: 'Jan', city: 'Utrecht', postal_code: '3511 AB' },
    lines: [{ description: 'Werk', quantity: 2, unitPrice: 50, vatRate: 21, net: 100, gross: 121 }],
    totals: { subtotal: 100, vat: 21, total: 121, vatBreakdown: [{ rate: 21, base: 100, vat: 21 }] },
    vatNotes: [], notes: 'Notitie', projectName: 'Project', quoteNumber: 'O-1', onlineLink: null,
  };
  const a = buildDocumentData(input);
  const b = server.buildDocumentData(input);
  assert.deepEqual(a, b);
  assert.deepEqual(a.client?.addressLines, ['3511 AB Utrecht']);
  const measure = await measurer();
  const style = resolveDocumentStyle(COMPANY);
  assert.deepEqual(
    planDocument(builtInLayout('invoice'), a, style, { measure, logo: null }),
    server.planDocument(server.builtInLayout('invoice'), b, server.resolveDocumentStyle(COMPANY), { measure, logo: null }),
  );
});

test('bedragen: precies dezelfde centen als de geldmodule van de app', () => {
  // Een vaste reeks "willekeurige" regels, met de lastige gevallen erin: halve
  // centen, kommagetallen als tekst, lege velden, negatieve aantallen.
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 200; round++) {
    const lines = Array.from({ length: 1 + Math.floor(next() * 6) }, () => ({
      description: 'x',
      quantity: [1, 2.5, 3, 0.333, -1, '1,5', null][Math.floor(next() * 7)] as number,
      unit_price: Math.round(next() * 100000) / 100 + (next() > 0.8 ? 0.005 : 0),
      vat: [0, 9, 21, 21, 5.5][Math.floor(next() * 5)],
    }));
    const ours = app.documentAmounts(lines);
    const theirs = computeTotals(lines);
    assert.equal(ours.totals.subtotal, theirs.subtotal);
    assert.equal(ours.totals.vat, theirs.vat);
    assert.equal(ours.totals.total, theirs.total);
    assert.deepEqual(ours.totals.vatBreakdown, theirs.vatBreakdown);
    lines.forEach((line, index) => {
      assert.equal(ours.lines[index].net, lineNet(line));
      assert.equal(ours.lines[index].gross, lineGross(line));
    });
  }
});

test('elk veld in de lijst heeft een naam, uitleg en label', () => {
  const keys = new Set<string>();
  for (const field of DOCUMENT_FIELDS) {
    assert.ok(!keys.has(field.key), `${field.key} dubbel`);
    keys.add(field.key);
    assert.match(field.key, /^(bedrijf|klant|document)\.[a-z_]+$/);
    assert.ok(field.name && field.hint && field.caption[0] && field.caption[1], field.key);
  }
});

test('de migratie bewaakt type en grootte van de opmaak', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261105100000_document_layouts.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists document_layouts jsonb/i);
  assert.match(sql, /jsonb_typeof\(document_layouts\) = 'object'/);
  assert.match(sql, /pg_column_size\(document_layouts\) <= 262144/);
  // Een opmaak met het maximum aan blokken, tekst en tekens past er, ook
  // ongecomprimeerd en in UTF-8 (é is twee bytes): anders weigert de database
  // een opmaak die de editor gewoon toeliet.
  const full = presetLayout('standaard', 'invoice');
  full.blocks = Array.from({ length: LAYOUT_LIMITS.blocks }, (_, i) => ({ id: `tekst-${i}`, type: 'text' as const, text: 'é'.repeat(LAYOUT_LIMITS.text), x: 100.25, y: 100.25, w: 100.25, h: 20.25, size: 12.5, caption: 'é'.repeat(LAYOUT_LIMITS.caption), align: 'center' as const, tone: 'accent' as const, bold: true }));
  full.flow = full.flow.map(item => (item.key === 'intro' || item.key === 'closing' ? { ...item, text: 'é'.repeat(LAYOUT_LIMITS.text) } : item));
  const bytes = Buffer.byteLength(JSON.stringify({ version: 1, font: 'auto', invoice: full, quote: full }), 'utf8');
  assert.ok(bytes < 262144, `${bytes} bytes`);
});
