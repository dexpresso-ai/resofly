/**
 * Tests voor de Word-export van pagina's (stap 1B-2). Draaien met:  npm test
 *
 * Bovenaan de belangrijkste: elk bloktype dat de database toelaat, komt in het
 * bestand terecht. Zonder die test verdwijnt een nieuw blok stil uit de export,
 * omdat de module een onbekend blok alleen als tekst meeneemt.
 *
 * Met de hand gecontroleerd: het bestand klopt met de XSD's van ECMA-376, en
 * LibreOffice maakt er een goede PDF van (zie
 * docs/changelog/CHANGELOG_PAGINAS_WORD_2026-11-28.md). In Word zelf is het nog
 * niet geopend. Hier staat wat daarna stuk kan gaan: welgevormde XML, de
 * volgorde in rPr, de zip zelf.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { PAGE_MARK_TYPES, PAGE_NODE_TYPES } from '../../../src/lib/pageSchema.ts';
import { buildPageDocx, DOCX_MIME, escapeXml, imageSize, pageDocxFiles, type PageDocxContext } from './pageDocx.ts';

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };

const t = (text: string, ...marks: Node['marks'] & object): Node => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const p = (...content: Node[]): Node => ({ type: 'paragraph', content });
const h = (level: number, text: string): Node => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const li = (...content: Node[]): Node => ({ type: 'listItem', content });
const cell = (type: 'tableHeader' | 'tableCell', text: string, attrs: Record<string, unknown> = {}): Node =>
  ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs }, content: [p(t(text))] });
const doc = (...content: Node[]) => ({ type: 'doc', content });

function files(body: unknown, context: PageDocxContext = {}, title = 'Proef') {
  return new Map(pageDocxFiles(title, body, context).map(file => [file.path, file.data]));
}

function documentXml(body: unknown, context: PageDocxContext = {}): string {
  return files(body, context).get('word/document.xml') as string;
}

/** Welgevormd genoeg voor wat deze module maakt: elk element dicht, geen losse < of &. */
function assertWellFormed(xml: string, label: string): void {
  const stack: string[] = [];
  const tag = /<\?xml[^>]*\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let pos = 0;
  for (const match of xml.matchAll(tag)) {
    const between = xml.slice(pos, match.index);
    assert.doesNotMatch(between, /<|&(?!(?:amp|lt|gt|quot|apos);)/, `${label}: losse < of & vóór positie ${match.index}`);
    pos = (match.index ?? 0) + match[0].length;
    if (match[0].startsWith('<?xml')) continue;
    const [, close, name, , selfClose] = match;
    if (close) assert.equal(stack.pop(), name, `${label}: </${name}> sluit niet wat open staat`);
    else if (!selfClose) stack.push(name);
  }
  assert.equal(xml.slice(pos).trim(), '', `${label}: tekst na het laatste element`);
  assert.deepEqual(stack, [], `${label}: niet gesloten`);
}

function readZip(bytes: Uint8Array): Array<{ name: string; data: Buffer }> {
  const buffer = Buffer.from(bytes);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'geen einde van de centrale map');
  const count = buffer.readUInt16LE(end + 10);
  let pos = buffer.readUInt32LE(end + 16);
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(pos), 0x02014b50);
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const stored = buffer.subarray(start, start + compressed);
    entries.push({ name, data: method === 8 ? inflateRawSync(stored) : Buffer.from(stored) });
    pos += 46 + nameLength + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return entries;
}

/** Een PNG-kop met een maat: meer leest imageSize() niet. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

// ── Elk blok komt mee ───────────────────────────────────────────────────────

const PAGE_ID = '11111111-1111-4111-8111-111111111111';

const SAMPLES: Record<string, { node: Node; expect: RegExp }> = {
  paragraph: { node: p(t('alinea-tekst'), { type: 'hardBreak' }, t('na-de-breuk')), expect: /alinea-tekst<\/w:t><\/w:r><w:r><w:br\/><\/w:r><w:r><w:t xml:space="preserve">na-de-breuk/ },
  heading: { node: h(2, 'kop-tekst'), expect: /<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">kop-tekst/ },
  bulletList: { node: { type: 'bulletList', content: [li(p(t('punt-tekst')))] }, expect: /<w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">punt-tekst/ },
  orderedList: { node: { type: 'orderedList', content: [li(p(t('stap-tekst')))] }, expect: /<w:numId w:val="2"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">stap-tekst/ },
  taskList: { node: { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p(t('taak-tekst'))] }] }, expect: /☐<\/w:t><w:tab\/><\/w:r><w:r><w:t xml:space="preserve">taak-tekst/ },
  blockquote: { node: { type: 'blockquote', content: [p(t('citaat-tekst'))] }, expect: /<w:pStyle w:val="Quote"\/><\/w:pPr><w:r><w:t xml:space="preserve">citaat-tekst/ },
  codeBlock: { node: { type: 'codeBlock', content: [t('code-tekst')] }, expect: /<w:pStyle w:val="Code"\/><\/w:pPr><w:r><w:t xml:space="preserve">code-tekst/ },
  horizontalRule: { node: { type: 'horizontalRule' }, expect: /<w:pBdr><w:bottom w:val="single"/ },
  table: {
    node: { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'kopcel-tekst'), cell('tableCell', 'cel-tekst')] }] },
    expect: /<w:tbl>.*kopcel-tekst.*cel-tekst.*<\/w:tbl>/,
  },
  image: { node: { type: 'image', attrs: { attachmentId: 'a1', alt: 'beeld-tekst' } }, expect: /\[Afbeelding: beeld-tekst\]/ },
  fileBlock: { node: { type: 'fileBlock', attrs: { attachmentId: 'f1' } }, expect: /Bijlage: Bestand niet gevonden/ },
  callout: { node: { type: 'callout', attrs: { variant: 'tip' }, content: [p(t('kader-tekst'))] }, expect: /<w:shd w:val="clear" w:color="auto" w:fill="ECFDF5"\/>.*kader-tekst/ },
  details: {
    node: { type: 'details', content: [{ type: 'detailsSummary', content: [t('kopregel-tekst')] }, { type: 'detailsContent', content: [p(t('inhoud-tekst'))] }] },
    expect: /<w:b\/><\/w:rPr><w:t xml:space="preserve">kopregel-tekst.*<w:ind w:left="360"\/><\/w:pPr><w:r><w:t xml:space="preserve">inhoud-tekst/,
  },
  columns: {
    node: { type: 'columns', content: [{ type: 'column', content: [p(t('links-tekst'))] }, { type: 'column', content: [p(t('rechts-tekst'))] }] },
    expect: /<w:gridCol w:w="4535"\/><w:gridCol w:w="4535"\/>.*links-tekst.*rechts-tekst/,
  },
  tableOfContents: { node: { type: 'tableOfContents' }, expect: /TOC \\o "1-3"/ },
  subpage: { node: { type: 'subpage', attrs: { pageId: PAGE_ID } }, expect: /→ Pagina niet gevonden/ },
};

/** Deze staan alleen binnen een ander blok, en worden daar getest. */
const INSIDE: Record<string, string> = {
  doc: 'paragraph', text: 'paragraph', hardBreak: 'paragraph',
  listItem: 'bulletList', taskItem: 'taskList',
  tableRow: 'table', tableHeader: 'table', tableCell: 'table',
  detailsSummary: 'details', detailsContent: 'details', column: 'columns',
};

test('elk bloktype dat de database toelaat, komt met zijn tekst in het bestand', () => {
  for (const type of PAGE_NODE_TYPES) {
    assert.ok(SAMPLES[type] || INSIDE[type], `Geen voorbeeld voor "${type}": zet het in SAMPLES en zorg dat pageDocx.ts het omzet.`);
  }
  for (const [type, sample] of Object.entries(SAMPLES)) {
    // De inhoudsopgave heeft een kop nodig om iets te tonen.
    const body = type === 'tableOfContents' ? doc(sample.node, h(1, 'Een kop')) : doc(sample.node);
    const xml = documentXml(body);
    assert.match(xml, sample.expect, type);
    assertWellFormed(xml, type);
  }
});

test('een onbekend blok verliest zijn vorm, niet zijn tekst', () => {
  assert.match(documentXml(doc({ type: 'nieuwBlok', content: [t('nieuwe-tekst')] })), /<w:p><w:r><w:t xml:space="preserve">nieuwe-tekst/);
  assert.match(documentXml(doc({ type: 'omhulsel', content: [p(t('binnen-tekst'))] })), /binnen-tekst/);
});

// ── Opmaak ──────────────────────────────────────────────────────────────────

test('elke markering uit de database wordt opmaak, in de volgorde van het schema', () => {
  const expected: Record<string, RegExp> = {
    bold: /<w:rPr><w:b\/><\/w:rPr>/,
    italic: /<w:rPr><w:i\/><\/w:rPr>/,
    underline: /<w:rPr><w:u w:val="single"\/><\/w:rPr>/,
    strike: /<w:rPr><w:strike\/><\/w:rPr>/,
    code: /<w:rPr><w:rFonts w:ascii="Consolas"[^>]*\/><w:shd [^>]*\/><\/w:rPr>/,
    link: /<w:hyperlink r:id="rId11"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr>/,
    highlight: /<w:rPr><w:highlight w:val="yellow"\/><\/w:rPr>/,
  };
  for (const mark of PAGE_MARK_TYPES) {
    assert.ok(expected[mark], `Geen verwachting voor de markering "${mark}"`);
    const attrs = mark === 'link' ? { href: 'https://example.com' } : undefined;
    assert.match(documentXml(doc(p(t('x', { type: mark, ...(attrs ? { attrs } : {}) })))), expected[mark], mark);
  }
  // Alles tegelijk: rStyle, rFonts, b, i, strike, highlight, u, shd. Een andere volgorde keurt het schema af.
  const all = PAGE_MARK_TYPES.map(type => (type === 'link' ? { type, attrs: { href: 'https://example.com' } } : { type }));
  assert.match(documentXml(doc(p(t('x', ...all)))),
    /<w:rPr><w:rStyle w:val="Hyperlink"\/><w:rFonts [^>]*\/><w:b\/><w:i\/><w:strike\/><w:highlight w:val="yellow"\/><w:u w:val="single"\/><w:shd [^>]*\/><\/w:rPr>/);
});

test('tekst wordt veilig: <, &, aanhalingstekens en stuurtekens', () => {
  assert.equal(escapeXml('<b>&"x"\u0001\u000B'), '&lt;b&gt;&amp;&quot;x&quot;');
  const all = files(doc(p(t('<script>alert("x")</script> & \u0007'))), {}, 'Titel <met> & "tekens"');
  const xml = all.get('word/document.xml') as string;
  assert.match(xml, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; </);
  assert.doesNotMatch(xml, /\u0007|<script>/);
  assert.match(all.get('docProps/core.xml') as string, /<dc:title>Titel &lt;met&gt; &amp; &quot;tekens&quot;<\/dc:title>/);
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
});

test('een link alleen naar http(s), mailto of tel, en één relatie per adres', () => {
  const link = (href: string) => ({ type: 'link', attrs: { href } });
  const all = files(doc(p(
    t('deel een', link('https://example.com/?a=1&b=2')),
    t(' en twee', link('https://example.com/?a=1&b=2'), { type: 'bold' }),
    t(' mail', link('mailto:info@example.com')),
    t(' intern', link('/projecten')),
    t(' kop', link('#inleiding')),
    t(' gevaar', link('javascript:alert(1)')),
  )));
  const xml = all.get('word/document.xml') as string;
  const rels = all.get('word/_rels/document.xml.rels') as string;
  assert.equal(xml.match(/<w:hyperlink r:id="rId11">/g)?.length, 2, 'beide stukken van de eerste link wijzen naar dezelfde relatie');
  assert.match(xml, /<w:hyperlink r:id="rId12">.*mail/);
  assert.equal(rels.match(/TargetMode="External"/g)?.length, 2);
  assert.match(rels, /Target="https:\/\/example\.com\/\?a=1&amp;b=2" TargetMode="External"/);
  // Binnen de app of gevaarlijk: gewone tekst, zonder relatie.
  for (const text of ['intern', 'kop', 'gevaar']) assert.match(xml, new RegExp(`<w:r><w:t xml:space="preserve"> ${text}</w:t></w:r>`));
  assert.doesNotMatch(rels, /javascript|projecten|#inleiding/);
});

// ── Lijsten ─────────────────────────────────────────────────────────────────

test('elke genummerde lijst begint weer bij 1; een geneste lijst gaat een niveau dieper', () => {
  const all = files(doc(
    { type: 'orderedList', content: [li(p(t('een')), { type: 'orderedList', content: [li(p(t('een-a')))] }), li(p(t('twee')))] },
    p(t('tussendoor')),
    { type: 'orderedList', content: [li(p(t('opnieuw')))] },
    { type: 'bulletList', content: [li(p(t('punt')), { type: 'bulletList', content: [li(p(t('subpunt')))] })] },
  ));
  const xml = all.get('word/document.xml') as string;
  assert.match(xml, /<w:ilvl w:val="0"\/><w:numId w:val="2"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">een</);
  assert.match(xml, /<w:ilvl w:val="1"\/><w:numId w:val="3"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">een-a</);
  assert.match(xml, /<w:ilvl w:val="0"\/><w:numId w:val="2"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">twee</);
  assert.match(xml, /<w:numId w:val="4"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">opnieuw</);
  assert.match(xml, /<w:ilvl w:val="1"\/><w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">subpunt</);
  const numbering = all.get('word/numbering.xml') as string;
  for (const numId of [2, 3, 4]) {
    assert.match(numbering, new RegExp(`<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>`));
  }
  assert.match(numbering, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/><\/w:num>/);
  assertWellFormed(numbering, 'numbering.xml');
});

test('een tweede alinea in een lijstpunt staat onder de tekst, zonder teken', () => {
  const xml = documentXml(doc({ type: 'bulletList', content: [li(p(t('punt')), p(t('vervolg')))] }));
  assert.match(xml, /<w:p><w:pPr><w:ind w:left="720"\/><\/w:pPr><w:r><w:t xml:space="preserve">vervolg/);
});

test('een takenlijst toont afgevinkt en open', () => {
  const xml = documentXml(doc({ type: 'taskList', content: [
    { type: 'taskItem', attrs: { checked: true }, content: [p(t('klaar'))] },
    { type: 'taskItem', attrs: { checked: false }, content: [p(t('open'))] },
  ] }));
  assert.match(xml, /☒<\/w:t><w:tab\/><\/w:r><w:r><w:rPr><w:color w:val="64748B"\/><\/w:rPr><w:t xml:space="preserve">klaar/);
  assert.match(xml, /☐<\/w:t><w:tab\/><\/w:r><w:r><w:t xml:space="preserve">open/);
});

// ── Tabellen ────────────────────────────────────────────────────────────────

test('een tabel: kopregel, samengevoegde cellen, breedtes en uitlijning', () => {
  const xml = documentXml(doc({ type: 'table', content: [
    { type: 'tableRow', content: [cell('tableHeader', 'Naam', { colwidth: [100] }), cell('tableHeader', 'Rol'), cell('tableHeader', 'Uren', { align: 'right' })] },
    { type: 'tableRow', content: [cell('tableCell', 'Anna', { rowspan: 2 }), cell('tableCell', 'Ontwerp'), cell('tableCell', '12', { align: 'right' })] },
    { type: 'tableRow', content: [cell('tableCell', 'Bouw'), cell('tableCell', '8')] },
    { type: 'tableRow', content: [cell('tableCell', 'Samen', { colspan: 2 }), cell('tableCell', '20')] },
  ] }));
  // 100 px is 1500 twips; de andere twee delen de rest van de 9070.
  assert.match(xml, /<w:tblGrid><w:gridCol w:w="1500"\/><w:gridCol w:w="3785"\/><w:gridCol w:w="3785"\/><\/w:tblGrid>/);
  // Alleen de bovenste rij herhaalt; kopcellen vet en gearceerd.
  assert.equal(xml.match(/<w:tblHeader\/>/g)?.length, 1);
  assert.match(xml, /<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"\/><\/w:tcPr><w:p><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Naam/);
  assert.match(xml, /<w:jc w:val="right"\/><\/w:pPr><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Uren/);
  // Anna loopt over twee rijen: begin, en in de rij eronder het vervolg (leeg).
  assert.match(xml, /<w:vMerge w:val="restart"\/><\/w:tcPr><w:p><w:r><w:t xml:space="preserve">Anna/);
  assert.match(xml, /<w:tc><w:tcPr><w:tcW w:w="1500" w:type="dxa"\/><w:vMerge\/><\/w:tcPr><w:p\/><\/w:tc><w:tc>.*Bouw/);
  // Samen loopt over twee kolommen.
  assert.match(xml, /<w:tcW w:w="5285" w:type="dxa"\/><w:gridSpan w:val="2"\/><\/w:tcPr><w:p><w:r><w:t xml:space="preserve">Samen/);
  // Elke cel eindigt op een alinea, en na de tabel komt er een.
  assert.doesNotMatch(xml, /<\/w:tcPr><\/w:tc>|<\/w:tbl><\/w:tc>/);
  assert.match(xml, /<\/w:tbl><w:p><\/w:p>/);
  assertWellFormed(xml, 'tabel');
});

test('een te brede tabel krimpt tot de breedte van de tekst', () => {
  const xml = documentXml(doc({ type: 'table', content: [
    { type: 'tableRow', content: [cell('tableCell', 'a', { colwidth: [800] }), cell('tableCell', 'b', { colwidth: [400] })] },
  ] }));
  const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(match => Number(match[1]));
  assert.deepEqual(widths, [6047, 3023]);
  assert.ok(Math.abs(widths[0] + widths[1] - 9070) <= 1);
});

test('een kader krijgt de kleur van zijn soort; een onbekende soort wordt info', () => {
  assert.match(documentXml(doc({ type: 'callout', attrs: { variant: 'waarschuwing' }, content: [p(t('x'))] })), /w:color="EF4444".*w:fill="FEF2F2"/);
  assert.match(documentXml(doc({ type: 'callout', attrs: { variant: 'raar' }, content: [p(t('x'))] })), /w:color="3B82F6".*w:fill="EFF6FF"/);
});

// ── Inhoudsopgave, subpagina's, bestanden en afbeeldingen ───────────────────

test('de inhoudsopgave is een TOC-veld met de koppen van de hele pagina', () => {
  const xml = documentXml(doc(
    { type: 'tableOfContents' },
    h(1, 'Begin'),
    { type: 'callout', attrs: { variant: 'info' }, content: [h(2, 'In een kader')] },
    h(3, ''),
  ));
  const toc = xml.slice(xml.indexOf('TOCHeading'), xml.indexOf('Heading1'));
  assert.match(toc, /<w:pStyle w:val="TOC1"\/><\/w:pPr><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t xml:space="preserve">Begin/);
  assert.match(toc, /<w:pStyle w:val="TOC2"\/><\/w:pPr><w:r><w:t xml:space="preserve">In een kader/);
  assert.match(toc, /<w:pStyle w:val="TOC3"\/><\/w:pPr><w:r><w:t xml:space="preserve">Kop zonder tekst<\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="end"\/>/);
  assert.equal(xml.match(/fldCharType="begin"/g)?.length, 1);
  assert.equal(xml.match(/fldCharType="end"/g)?.length, 1);
  // Zonder koppen: niets, ook geen leeg veld.
  assert.doesNotMatch(documentXml(doc({ type: 'tableOfContents' }, p(t('alleen tekst')))), /TOC|Inhoud/);
});

test('subpagina en bestand: titel en naam uit de context, anders zoals in de app', () => {
  const context = { pageTitles: { [PAGE_ID]: 'Bedrijfshandboek', leeg: '  ' }, fileNames: { f1: 'Offerte 2026.pdf' } };
  const xml = documentXml(doc(
    { type: 'subpage', attrs: { pageId: PAGE_ID } },
    { type: 'subpage', attrs: { pageId: 'leeg' } },
    { type: 'fileBlock', attrs: { attachmentId: 'f1' } },
  ), context);
  assert.match(xml, /→ Bedrijfshandboek/);
  assert.match(xml, /→ Naamloze pagina/);
  assert.match(xml, /Bijlage: Offerte 2026\.pdf/);
});

test('een afbeelding gaat mee als bestand, op maat; zonder bytes wordt het een regel', () => {
  const images = {
    breed: { bytes: pngHeader(3000, 1000), contentType: 'image/png' },
    klein: { bytes: pngHeader(200, 100), contentType: 'image/png', width: 200, height: 100 },
    webp: { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/webp' },
  };
  const all = files(doc(
    { type: 'image', attrs: { attachmentId: 'breed', alt: 'Breed "plaatje"' } },
    { type: 'image', attrs: { attachmentId: 'klein' } },
    { type: 'image', attrs: { attachmentId: 'breed' } },
    { type: 'image', attrs: { attachmentId: 'webp', alt: 'Ander formaat' } },
    { type: 'image', attrs: { attachmentId: 'weg' } },
  ), { images });
  const xml = all.get('word/document.xml') as string;
  // 3000 px is breder dan de tekst (9070 twips): terug naar de tekstbreedte, in verhouding.
  assert.match(xml, /<wp:extent cx="5759450" cy="1919817"\/><wp:docPr id="1" name="Afbeelding 1" descr="Breed &quot;plaatje&quot;"\/>/);
  assert.match(xml, /<wp:extent cx="1905000" cy="952500"\/>/);
  // Twee keer dezelfde afbeelding: één bestand.
  assert.deepEqual([...all.keys()].filter(path => path.startsWith('word/media/')), ['word/media/afbeelding1.png', 'word/media/afbeelding2.png']);
  assert.equal(xml.match(/r:embed="rId11"/g)?.length, 2);
  assert.match(xml, /\[Afbeelding: Ander formaat\]/);
  assert.match(xml, /\[Afbeelding\]/);
  assert.match(all.get('[Content_Types].xml') as string, /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.doesNotMatch(all.get('[Content_Types].xml') as string, /webp|jpeg/);
  assert.match(all.get('word/_rels/document.xml.rels') as string, /<Relationship Id="rId11" Type="[^"]+\/image" Target="media\/afbeelding1\.png"\/>/);
});

test('imageSize leest de maat uit png, gif en jpeg', () => {
  assert.deepEqual(imageSize(pngHeader(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02])), { width: 800, height: 600 });
  // SOI, een APP0-segment van 16 bytes, dan SOF0 met hoogte 300 en breedte 400.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03]);
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 300 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null);
  assert.equal(imageSize(pngHeader(0, 10)), null);
});

// ── Het bestand ─────────────────────────────────────────────────────────────

test('het .docx-bestand is een zip met alle onderdelen, en elke XML is welgevormd', async () => {
  const body = doc(h(1, 'Kop'), p(t('Tekst met een '), t('link', { type: 'link', attrs: { href: 'https://example.com' } })));
  const blob = await buildPageDocx('Handboek', body, {});
  assert.equal(blob.type, DOCX_MIME);
  const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(entries.map(entry => entry.name), [
    '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml', 'word/_rels/document.xml.rels',
    'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/footer1.xml',
  ]);
  const expected = files(body, {}, 'Handboek');
  for (const entry of entries) {
    const xml = entry.data.toString('utf8');
    assert.equal(xml, expected.get(entry.name), entry.name);
    assertWellFormed(xml, entry.name);
  }
  // Elk onderdeel waar document.xml naar verwijst, staat in de zip en in [Content_Types].xml.
  const types = expected.get('[Content_Types].xml') as string;
  for (const part of ['styles.xml', 'numbering.xml', 'settings.xml', 'footer1.xml']) {
    assert.match(expected.get('word/_rels/document.xml.rels') as string, new RegExp(`Target="${part}"`));
    assert.match(types, new RegExp(`PartName="/word/${part}"`));
  }
  assert.match(expected.get('word/footer1.xml') as string, /Pagina .*w:instr=" PAGE ".* van .*w:instr=" NUMPAGES "/);
});

test('een lege of kapotte inhoud geeft een bestand met alleen de titel', () => {
  for (const body of [null, undefined, '{kapot', [], 42, { type: 'doc' }]) {
    const xml = documentXml(body);
    assert.match(xml, /<w:body><w:p><w:pPr><w:pStyle w:val="Title"\/><\/w:pPr><w:r><w:t xml:space="preserve">Proef<\/w:t><\/w:r><\/w:p><w:sectPr>/, String(body));
  }
  // Een body als tekst (zoals hij soms uit de database komt) werkt ook.
  assert.match(documentXml(JSON.stringify(doc(p(t('uit-json'))))), /uit-json/);
  assert.match(files(doc(), {}, '   ').get('word/document.xml') as string, /Naamloze pagina/);
});
