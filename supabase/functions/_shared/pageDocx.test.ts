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

// ── De huisstijlletter (proef 1B-1) ─────────────────────────────────────────

/** Terug uit de versleuteling, los nagebouwd uit ECMA-376 deel 1, 17.8.1. */
function deobfuscate(data: Uint8Array, key: string): Uint8Array {
  const guid = Buffer.from(key.replace(/[{}-]/g, ''), 'hex');
  const out = Uint8Array.from(data);
  for (let i = 0; i < 32; i += 1) out[i] ^= guid[15 - (i % 16)];
  return out;
}

test('de huisstijlletter gaat versleuteld mee, en is de letter van het hele document', () => {
  const regular = Uint8Array.from({ length: 64 }, (_, i) => i);
  const bold = Uint8Array.from({ length: 48 }, (_, i) => 200 - i);
  const all = files(doc(p(t('tekst'))), { font: { family: 'Poppins', regular, bold } });
  const table = all.get('word/fontTable.xml') as string;
  const keys = [...table.matchAll(/w:fontKey="(\{[0-9A-F-]{36}\})"/g)].map(match => match[1]);
  assert.match(table, /<w:font w:name="Poppins"><w:embedRegular r:id="rId1" w:fontKey="\{[0-9A-F-]{36}\}"\/><w:embedBold r:id="rId2" w:fontKey="\{[0-9A-F-]{36}\}"\/><\/w:font>/);
  assert.equal(new Set(keys).size, 2, 'elke letter een eigen sleutel');
  assert.match(all.get('word/_rels/fontTable.xml.rels') as string, /Id="rId1" Type="[^"]+\/font" Target="fonts\/font1\.odttf".*Id="rId2" Type="[^"]+\/font" Target="fonts\/font2\.odttf"/);
  // Versleuteld: de eerste 32 bytes anders, de rest gelijk, en terug te zetten.
  const stored = all.get('word/fonts/font1.odttf') as Uint8Array;
  assert.notDeepEqual(stored.slice(0, 32), regular.slice(0, 32));
  assert.deepEqual(stored.slice(32), regular.slice(32));
  assert.deepEqual(deobfuscate(stored, keys[0]), regular);
  assert.deepEqual(deobfuscate(all.get('word/fonts/font2.odttf') as Uint8Array, keys[1]), bold);
  // De letter van het document, en Word weet dat hij ingesloten is.
  assert.match(all.get('word/styles.xml') as string, /<w:rPrDefault><w:rPr><w:rFonts w:ascii="Poppins" w:hAnsi="Poppins" w:eastAsia="Poppins" w:cs="Poppins"\/>/);
  assert.match(all.get('word/settings.xml') as string, /<w:settings [^>]*><w:embedTrueTypeFonts\/><w:defaultTabStop /);
  assert.match(all.get('word/_rels/document.xml.rels') as string, /<Relationship Id="rId5" Type="[^"]+\/fontTable" Target="fontTable\.xml"\/>/);
  const types = all.get('[Content_Types].xml') as string;
  assert.match(types, /<Default Extension="odttf" ContentType="application\/vnd\.openxmlformats-officedocument\.obfuscatedFont"\/>/);
  assert.match(types, /<Override PartName="\/word\/fontTable\.xml" /);
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
});

test('zonder letter blijft het Calibri, zonder lettertabel; met alleen vet krijgt vet de eerste plek', () => {
  const zonder = files(doc(p(t('tekst'))));
  assert.equal(zonder.has('word/fontTable.xml'), false);
  assert.match(zonder.get('word/styles.xml') as string, /w:ascii="Calibri"/);
  assert.doesNotMatch(zonder.get('word/settings.xml') as string, /embedTrueTypeFonts/);
  assert.doesNotMatch(zonder.get('[Content_Types].xml') as string, /odttf|fontTable/);
  // Een naam zonder bestanden: wel die naam, niets ingesloten.
  const alleenNaam = files(doc(p(t('tekst'))), { font: { family: 'Arial' } });
  assert.match(alleenNaam.get('word/styles.xml') as string, /w:ascii="Arial"/);
  assert.equal(alleenNaam.has('word/fontTable.xml'), false);
  // Alleen vet, en een naam met een teken dat XML niet zomaar neemt.
  const vet = files(doc(p(t('tekst'))), { font: { family: 'Huis & Stijl', bold: new Uint8Array(40) } });
  assert.match(vet.get('word/fontTable.xml') as string, /<w:font w:name="Huis &amp; Stijl"><w:embedBold r:id="rId1" /);
  assert.equal(vet.has('word/fonts/font1.odttf'), true);
});

/** Alles tot het einde van dezelfde stijl, niet verder: anders telt de rFonts van een latere stijl mee. */
const BINNEN_STIJL = '(?:(?!</w:style>).)*?';

test('koppen in hun eigen letter; dezelfde familie gaat één keer mee', () => {
  const bytes = (n: number) => Uint8Array.from({ length: 40 }, (_, i) => (i * n) % 256);
  const twee = files(doc(h(1, 'Kop'), p(t('tekst'))), {
    font: { family: 'Poppins', regular: bytes(1), bold: bytes(2) },
    headingFont: { family: 'Bebas Neue', regular: bytes(3) },
  });
  const table = twee.get('word/fontTable.xml') as string;
  assert.match(table, /<w:font w:name="Poppins"><w:embedRegular r:id="rId1" [^>]*\/><w:embedBold r:id="rId2" [^>]*\/><\/w:font><w:font w:name="Bebas Neue"><w:embedRegular r:id="rId3" [^>]*\/><\/w:font>/);
  assert.equal(new Set([...table.matchAll(/w:fontKey="([^"]+)"/g)].map(match => match[1])).size, 3, 'elk bestand een eigen sleutel');
  assert.deepEqual([...twee.keys()].filter(path => path.endsWith('.odttf')), ['word/fonts/font1.odttf', 'word/fonts/font2.odttf', 'word/fonts/font3.odttf']);
  const styles = twee.get('word/styles.xml') as string;
  assert.match(styles, /<w:rPrDefault><w:rPr><w:rFonts w:ascii="Poppins"/);
  for (const id of ['Title', 'Heading1', 'Heading2', 'Heading3']) {
    assert.match(styles, new RegExp(`w:styleId="${id}">${BINNEN_STIJL}<w:rPr><w:rFonts w:ascii="Bebas Neue" w:hAnsi="Bebas Neue" w:eastAsia="Bebas Neue" w:cs="Bebas Neue"/><w:b/>`), id);
  }
  // Voor koppen en tekst dezelfde: één familie, en de koppen zonder eigen letter.
  const een = files(doc(h(1, 'Kop')), { font: { family: 'Lora', regular: bytes(1) }, headingFont: { family: 'Lora', regular: bytes(1) } });
  assert.equal((een.get('word/fontTable.xml') as string).match(/<w:font /g)?.length, 1);
  assert.doesNotMatch(een.get('word/styles.xml') as string, new RegExp(`w:styleId="Heading1">${BINNEN_STIJL}<w:rFonts`));
  // Alleen een letter voor koppen: de tekst blijft Calibri.
  const kop = files(doc(h(1, 'Kop')), { headingFont: { family: 'Lora', regular: bytes(1) } });
  assert.match(kop.get('word/styles.xml') as string, /<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/);
  assert.match(kop.get('word/styles.xml') as string, new RegExp(`w:styleId="Heading1">${BINNEN_STIJL}<w:rFonts w:ascii="Lora"`));
  for (const [path, data] of twee) if (typeof data === 'string') assertWellFormed(data, path);
});

// ── De opties van het exportvenster (stap 1B-4) ─────────────────────────────

/** Elke alinea- en tekenstijl die document.xml gebruikt, bestaat in styles.xml. De XSD ziet dat niet. */
function assertStylesExist(all: Map<string, string | Uint8Array>, label: string): void {
  const styles = all.get('word/styles.xml') as string;
  const defined = new Set([...styles.matchAll(/w:styleId="([^"]+)"/g)].map(match => match[1]));
  const used = new Set([...(all.get('word/document.xml') as string).matchAll(/<w:[pr]Style w:val="([^"]+)"\/>/g)].map(match => match[1]));
  for (const style of used) assert.ok(defined.has(style), `${label}: stijl ${style} ontbreekt in styles.xml`);
}

const RICH = doc(
  { type: 'tableOfContents' },
  h(1, 'Inleiding'),
  p(t('Tekst van de pagina.')),
  { type: 'image', attrs: { attachmentId: 'beeld' } },
);

test('zonder opties is het bestand gelijk, hoe de opties ook leeg zijn; geen extra stijlen of secties', () => {
  const context = { images: { beeld: { bytes: pngHeader(200, 100), contentType: 'image/png' } } };
  const plain = pageDocxFiles('Handboek', RICH, context);
  for (const options of [{}, { cover: null, toc: false, chapters: [] }]) {
    assert.deepEqual(pageDocxFiles('Handboek', RICH, context, options), plain);
  }
  const all = new Map(plain.map(file => [file.path, file.data]));
  assert.doesNotMatch(all.get('word/styles.xml') as string, /Heading4|Subtitle/);
  assert.equal((all.get('word/document.xml') as string).match(/<w:sectPr>/g)?.length, 1);
  assertStylesExist(all, 'zonder opties');
});

test('voorblad: een eerste bladzijde zonder voet, met logo, titel, klant, project en datum, dan een paginagrens; de titel niet nog eens', () => {
  const cover = {
    lines: ['Klant: Bakkerij Jansen', ' ', 'Project: Verbouwing'],
    date: '28 november 2026',
    company: 'Studio Noord',
    logo: { bytes: pngHeader(800, 200), contentType: 'image/png' },
  };
  const all = files(RICH, {}, 'Handboek');
  const withCover = new Map(pageDocxFiles('Handboek', RICH, {}, { cover }).map(file => [file.path, file.data]));
  const xml = withCover.get('word/document.xml') as string;
  // Eén sectie, met een eigen eerste bladzijde (titlePg) zonder voet: geen
  // tweede sectie, want die schrijft LibreOffice bij opnieuw opslaan tegen het schema in.
  const sections = [...xml.matchAll(/<w:sectPr>(.*?)<\/w:sectPr>/g)].map(match => match[1]);
  assert.equal(sections.length, 1);
  assert.match(sections[0], /^<w:footerReference w:type="default" r:id="rId4"\/><w:pgSz [^>]*\/><w:pgMar [^>]*\/><w:titlePg\/>$/);
  // Het voorblad staat vóór de paginagrens, de tekst erna.
  const [voor, na] = xml.split('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  assert.match(voor, /<w:drawing>.*descr="Logo van Studio Noord".*Handboek.*Klant: Bakkerij Jansen.*Project: Verbouwing.*28 november 2026/);
  assert.doesNotMatch(voor, /Studio Noord<\/w:t>/, 'met logo niet ook de naam');
  assert.equal(xml.match(/<w:pStyle w:val="Title"\/>/g)?.length, 1, 'de titel staat één keer');
  assert.match(na, /Inleiding.*Tekst van de pagina/);
  // 800 bij 200 px past niet in 5 bij 2,5 cm: terug tot 5 cm breed.
  assert.match(voor, /<wp:extent cx="1800000" cy="450000"\/>/);
  assert.ok(withCover.has('word/media/afbeelding1.png'));
  assertStylesExist(withCover, 'voorblad');
  assert.match(withCover.get('word/styles.xml') as string, /w:styleId="Subtitle"/);
  // Een logo dat Word niet kan tonen (svg, webp): de naam van het bedrijf.
  const svg = pageDocxFiles('Handboek', RICH, {}, { cover: { ...cover, logo: { bytes: new Uint8Array([60, 115]), contentType: 'image/svg+xml' } } });
  const svgXml = svg.find(file => file.path === 'word/document.xml')?.data as string;
  assert.match(svgXml.split('<w:br w:type="page"/>')[0], /<w:b\/><w:color w:val="64748B"\/><\/w:rPr><w:t xml:space="preserve">Studio Noord<\/w:t>/);
  assert.ok(!svg.some(file => file.path.startsWith('word/media/')), 'een svg komt niet in het bestand');
  // Zonder voorblad blijft het zoals het was.
  assert.doesNotMatch(all.get('word/document.xml') as string, /Subtitle/);
});

test('inhoudsopgave vooraan: één TOC-veld met de koppen van het hele bestand; de blokken in de pagina vallen weg', () => {
  const chapters = [{ title: 'Werkwijze', body: doc({ type: 'tableOfContents' }, h(1, 'Afspraken'), h(3, 'Te diep')), depth: 1 }];
  const xml = pageDocxFiles('Handboek', RICH, {}, { toc: true, chapters }).find(file => file.path === 'word/document.xml')?.data as string;
  assert.equal(xml.match(/fldCharType="begin"/g)?.length, 1, 'één veld');
  assert.equal(xml.match(/TOCHeading/g)?.length, 1);
  // Vooraan: direct na de titel, vóór de tekst van de pagina.
  assert.ok(xml.indexOf('TOCHeading') < xml.indexOf('Tekst van de pagina'));
  const toc = xml.slice(xml.indexOf('TOCHeading'), xml.indexOf('<w:pStyle w:val="Heading1"/>'));
  assert.deepEqual([...toc.matchAll(/<w:pStyle w:val="(TOC\d)"\/><\/w:pPr>(?:<w:r><w:fldChar[^>]*><\/w:r><w:r><w:instrText[^<]*<\/w:instrText><\/w:r><w:r><w:fldChar[^>]*><\/w:r>)?<w:r><w:t xml:space="preserve">([^<]*)</g)].map(match => `${match[1]} ${match[2]}`),
    // De kop 3 in het hoofdstuk wordt niveau 4: die toont het veld (\o "1-3") niet, en dus wij ook niet.
    ['TOC1 Inleiding', 'TOC1 Werkwijze', 'TOC2 Afspraken']);
});

test('hoofdstukken: de titel op zijn diepte, de koppen een niveau lager, een nieuwe bladzijde per hoofdstuk, en nooit dieper dan Heading6', () => {
  const chapters = [
    { title: 'Werkwijze', body: doc(h(1, 'Afspraken'), p(t('Tekst van het hoofdstuk.')), { type: 'image', attrs: { attachmentId: 'beeld2' } }), depth: 1 },
    { title: ' ', body: doc(h(2, 'Onder de werkwijze')), depth: 2 },
    { title: 'Diep', body: doc(h(3, 'Heel diep')), depth: 9 },
    { title: 'Tarieven', body: '{kapot', depth: 1 },
  ];
  const context = { images: { beeld: { bytes: pngHeader(200, 100), contentType: 'image/png' }, beeld2: { bytes: pngHeader(100, 50), contentType: 'image/png' } } };
  const all = new Map(pageDocxFiles('Handboek', RICH, context, { chapters }).map(file => [file.path, file.data]));
  const xml = all.get('word/document.xml') as string;
  const heading = (style: string, text: string) => new RegExp(`<w:pStyle w:val="${style}"/>(<w:pageBreakBefore/>)?</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t>`);
  assert.match(xml, heading('Heading1', 'Werkwijze'));
  assert.match(xml, /<w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/><\/w:pPr><w:r><w:t xml:space="preserve">Werkwijze/);
  assert.match(xml, /<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">Afspraken/);
  // Diepte 2: de titel als Heading2 zonder nieuwe bladzijde; een lege titel zoals in de app.
  assert.match(xml, /<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">Naamloze pagina/);
  assert.match(xml, /<w:pStyle w:val="Heading4"\/><\/w:pPr><w:r><w:t xml:space="preserve">Onder de werkwijze/);
  // Diepte 9: alles Heading6.
  assert.match(xml, /<w:pStyle w:val="Heading6"\/><\/w:pPr><w:r><w:t xml:space="preserve">Diep/);
  assert.match(xml, /<w:pStyle w:val="Heading6"\/><\/w:pPr><w:r><w:t xml:space="preserve">Heel diep/);
  // Een kapotte inhoud: het hoofdstuk staat er, met alleen zijn titel.
  assert.match(xml, /<w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/><\/w:pPr><w:r><w:t xml:space="preserve">Tarieven<\/w:t><\/w:r><\/w:p><w:sectPr>/);
  // De volgorde: de pagina, dan de hoofdstukken zoals gegeven. Na de
  // inhoudsopgave tellen: daarin staan de hoofdstuktitels al vooraan.
  const text = xml.slice(xml.indexOf('fldCharType="end"'));
  const order = ['Tekst van de pagina', 'Werkwijze', 'Tekst van het hoofdstuk', 'Naamloze pagina', 'Diep', 'Tarieven'].map(part => text.indexOf(part));
  assert.ok(order.every(index => index >= 0), `niet alles na de inhoudsopgave: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Een afbeelding in een hoofdstuk gaat mee, net als die in de pagina.
  assert.deepEqual([...all.keys()].filter(path => path.startsWith('word/media/')), ['word/media/afbeelding1.png', 'word/media/afbeelding2.png']);
  // Het inhoudsopgave-blok in de pagina blijft, met de hoofdstukken erin.
  assert.equal(xml.match(/fldCharType="begin"/g)?.length, 1);
  assert.match(xml.slice(0, xml.indexOf('Tekst van de pagina')), /<w:pStyle w:val="TOC1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Werkwijze/);
  assertStylesExist(all, 'hoofdstukken');
  for (const style of ['Heading4', 'Heading5', 'Heading6']) assert.match(all.get('word/styles.xml') as string, new RegExp(`w:styleId="${style}"`));
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
});

test('alles tegelijk: voorblad, inhoudsopgave en hoofdstukken; elke stijl bestaat en elke XML is welgevormd', () => {
  const all = new Map(pageDocxFiles('Handboek', RICH, {}, {
    cover: { lines: ['Klant: Bakkerij Jansen'], date: '28 november 2026', company: 'Studio Noord' },
    toc: true,
    chapters: [{ title: 'Werkwijze', body: doc(h(1, 'Afspraken')), depth: 1 }, { title: 'Details', body: doc(h(3, 'Klein')), depth: 2 }],
  }).map(file => [file.path, file.data]));
  assertStylesExist(all, 'alles');
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
  const xml = all.get('word/document.xml') as string;
  assert.equal(xml.match(/fldCharType="begin"/g)?.length, 1);
  // De inhoudsopgave staat na het voorblad, niet erop.
  assert.ok(xml.indexOf('<w:br w:type="page"/>') < xml.indexOf('TOCHeading'));
});

test('briefpapier: een afbeelding over de hele bladzijde, achter de tekst, op elke bladzijde, met de marges die het vrijlaat', () => {
  const letterhead = { image: { bytes: pngHeader(2480, 3508), contentType: 'image/png' }, top: 3000, bottom: 2040 };
  const all = new Map(pageDocxFiles('Handboek', RICH, {}, { letterhead }).map(file => [file.path, file.data]));
  const header = all.get('word/header1.xml') as string;
  assert.match(header, /<wp:anchor [^>]*behindDoc="1"[^>]*>/);
  assert.match(header, /<wp:positionH relativeFrom="page"><wp:posOffset>0<\/wp:posOffset><\/wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0<\/wp:posOffset><\/wp:positionV>/);
  // Zo groot als A4: 11906 bij 16838 twips.
  assert.match(header, /<wp:extent cx="7560310" cy="10692130"\/>.*<wp:wrapNone\/>/);
  assert.match(all.get('word/_rels/header1.xml.rels') as string, /Id="rId1" Type="[^"]+\/image" Target="media\/briefpapier\.png"/);
  assert.ok(all.has('word/media/briefpapier.png'));
  assert.match(all.get('word/_rels/document.xml.rels') as string, /Id="rId6" Type="[^"]+\/header" Target="header1\.xml"/);
  const types = all.get('[Content_Types].xml') as string;
  assert.match(types, /PartName="\/word\/header1\.xml" ContentType="[^"]+header\+xml"/);
  assert.match(types, /<Default Extension="png" ContentType="image\/png"\/>/);
  const xml = all.get('word/document.xml') as string;
  assert.match(xml, /<w:sectPr><w:headerReference w:type="default" r:id="rId6"\/><w:footerReference w:type="default" r:id="rId4"\/>/);
  // De marges van het briefpapier; het paginanummer net boven zijn voet.
  assert.match(xml, /<w:pgMar w:top="3000" w:right="1418" w:bottom="2040" w:left="1418" w:header="709" w:footer="1720" w:gutter="0"\/>/);
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
  // Met een voorblad: daar ook het briefpapier (de kop van de eerste bladzijde), maar geen voet.
  const withCover = pageDocxFiles('Handboek', RICH, {}, { letterhead, cover: { date: '28 november 2026' } }).find(file => file.path === 'word/document.xml')?.data as string;
  assert.match(withCover, /<w:sectPr><w:headerReference w:type="default" r:id="rId6"\/><w:headerReference w:type="first" r:id="rId6"\/><w:footerReference w:type="default" r:id="rId4"\/>.*<w:titlePg\/><\/w:sectPr>/);
  assert.doesNotMatch(withCover, /footerReference w:type="first"/);
  // Minder dan de gewone marge, of iets anders dan een getal: de gewone marge.
  const small = pageDocxFiles('Handboek', RICH, {}, { letterhead: { ...letterhead, top: 10, bottom: Number.NaN } }).find(file => file.path === 'word/document.xml')?.data as string;
  assert.match(small, /<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"\/>/);
});

test('briefpapier dat Word niet kan tonen (een pdf, svg of webp): geen kop, en de gewone marges', () => {
  for (const contentType of ['application/pdf', 'image/svg+xml', 'image/webp']) {
    const all = new Map(pageDocxFiles('Handboek', RICH, {}, { letterhead: { image: { bytes: new Uint8Array([1, 2, 3]), contentType }, top: 3000 } }).map(file => [file.path, file.data]));
    assert.ok(!all.has('word/header1.xml'), contentType);
    assert.deepEqual([...all.keys()], pageDocxFiles('Handboek', RICH, {}).map(file => file.path), contentType);
    assert.doesNotMatch(all.get('word/document.xml') as string, /headerReference/, contentType);
  }
});

test('briefpapier dat een PDF is (stap 1B-5): geen afbeelding, wel de ruimte, en de kop en voet van een briefpapier', () => {
  // Het briefpapier zelf komt na het omzetten onder de PDF (pdfLetterhead.ts).
  const brand = { logo: { bytes: pngHeader(600, 200), contentType: 'image/png' }, color: '#1d4ed8', footerText: 'Studio Noord · Havenstraat 1' };
  const letterhead = { image: null, top: 3000, bottom: 2040 };
  const all = new Map(pageDocxFiles('Handboek', RICH, { brand }, { letterhead }).map(file => [file.path, file.data]));
  // Geen kop: geen afbeelding van het briefpapier, en geen logo of lijn eroverheen.
  assert.ok(!all.has('word/header1.xml'));
  assert.ok(![...all.keys()].some(path => /briefpapier|logo-kop/.test(path)));
  const xml = all.get('word/document.xml') as string;
  assert.doesNotMatch(xml, /headerReference/);
  // Dezelfde marges als bij een briefpapier dat een afbeelding is; het nummer net boven zijn voet.
  assert.match(xml, /<w:pgMar w:top="3000" w:right="1418" w:bottom="2040" w:left="1418" w:header="709" w:footer="1720" w:gutter="0"\/>/);
  assert.doesNotMatch(all.get('word/footer1.xml') as string, /Studio Noord/);
  assert.doesNotMatch(all.get('word/styles.xml') as string, /w:styleId="Header"/);
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
  assertStylesExist(all, 'briefpapier als PDF');
  // Met een voorblad: de eerste bladzijde zonder voet, en nog steeds geen kop.
  const withCover = pageDocxFiles('Handboek', RICH, { brand }, { letterhead, cover: { date: '28 november 2026' } }).find(file => file.path === 'word/document.xml')?.data as string;
  assert.match(withCover, /<w:sectPr><w:footerReference w:type="default" r:id="rId4"\/><w:pgSz [^>]*\/><w:pgMar w:top="3000" [^>]*\/>.*<w:titlePg\/><\/w:sectPr>/);
  assert.doesNotMatch(withCover, /headerReference/);
});

test('kop en voet in de huisstijl: het logo rechts in de kop met een lijn in de merkkleur, de voettekst links en het nummer rechts', () => {
  const brand = { logo: { bytes: pngHeader(600, 200), contentType: 'image/png' }, color: '#1d4ed8', footerText: 'Studio Noord · Havenstraat 1' };
  const all = new Map(pageDocxFiles('Handboek', RICH, { brand }).map(file => [file.path, file.data]));
  const header = all.get('word/header1.xml') as string;
  assert.match(header, /<w:pPr><w:pStyle w:val="Header"\/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="6" w:color="1D4ED8"\/><\/w:pBdr><w:jc w:val="right"\/><\/w:pPr>/);
  // 600 bij 200 px past niet in 4,5 bij 1,1 cm: terug tot 1,1 cm hoog.
  assert.match(header, /<wp:extent cx="1188000" cy="396000"\/>.*<a:blip r:embed="rId1"\/>/);
  assert.match(all.get('word/_rels/header1.xml.rels') as string, /Id="rId1" Type="[^"]+\/image" Target="media\/logo-kop\.png"/);
  assert.ok(all.has('word/media/logo-kop.png'));
  assert.match(all.get('word/_rels/document.xml.rels') as string, /Id="rId6" Type="[^"]+\/header" Target="header1\.xml"/);
  assert.match(all.get('[Content_Types].xml') as string, /PartName="\/word\/header1\.xml"/);
  assert.match(all.get('word/document.xml') as string, /<w:sectPr><w:headerReference w:type="default" r:id="rId6"\/><w:footerReference w:type="default" r:id="rId4"\/>/);
  assert.match(all.get('word/styles.xml') as string, /w:styleId="Header"/);
  const footer = all.get('word/footer1.xml') as string;
  assert.match(footer, /<w:tabs><w:tab w:val="right" w:pos="9070"\/><\/w:tabs><\/w:pPr><w:r><w:t xml:space="preserve">Studio Noord · Havenstraat 1<\/w:t><\/w:r><w:r><w:tab\/><\/w:r><w:r><w:t xml:space="preserve">Pagina /);
  for (const [path, data] of all) if (typeof data === 'string') assertWellFormed(data, path);
  assertStylesExist(all, 'huisstijl');
  // Alleen een kleur: de lijn, zonder logo en zonder relaties van de kop.
  const line = new Map(pageDocxFiles('Handboek', RICH, { brand: { color: '#FD6' } }).map(file => [file.path, file.data]));
  assert.match(line.get('word/header1.xml') as string, /w:color="FFDD66"/);
  assert.doesNotMatch(line.get('word/header1.xml') as string, /w:drawing/);
  assert.ok(!line.has('word/_rels/header1.xml.rels'));
  // Een kleur die geen kleur is, geen logo, en een lege voettekst: geen kop, en de voet zoals in 1B-3.
  const none = new Map(pageDocxFiles('Handboek', RICH, { brand: { color: 'red; x', footerText: '  ' } }).map(file => [file.path, file.data]));
  assert.ok(!none.has('word/header1.xml'));
  assert.equal(none.get('word/footer1.xml'), new Map(pageDocxFiles('Handboek', RICH, {}).map(file => [file.path, file.data])).get('word/footer1.xml'));
  // Met een voorblad: de eerste bladzijde blijft kaal (geen eigen kop).
  const cover = pageDocxFiles('Handboek', RICH, { brand }, { cover: { date: '28 november 2026' } }).find(file => file.path === 'word/document.xml')?.data as string;
  assert.match(cover, /<w:sectPr><w:headerReference w:type="default" r:id="rId6"\/><w:footerReference w:type="default" r:id="rId4"\/>.*<w:titlePg\/><\/w:sectPr>/);
  assert.doesNotMatch(cover, /w:type="first"/);
  // Met briefpapier: alleen het briefpapier, geen logo of lijn, en in de voet alleen het nummer.
  const paper = new Map(pageDocxFiles('Handboek', RICH, { brand }, { letterhead: { image: { bytes: pngHeader(2480, 3508), contentType: 'image/png' }, top: 3000 } }).map(file => [file.path, file.data]));
  assert.match(paper.get('word/header1.xml') as string, /behindDoc="1"/);
  assert.doesNotMatch(paper.get('word/header1.xml') as string, /Header|pBdr/);
  assert.ok(!paper.has('word/media/logo-kop.png'));
  assert.doesNotMatch(paper.get('word/footer1.xml') as string, /Studio Noord/);
});

test('een lege bovenste pagina met hoofdstukken: het eerste hoofdstuk begint niet na een lege bladzijde', () => {
  const chapters = [{ title: 'Eén', body: doc(p(t('a'))), depth: 1 }, { title: 'Twee', body: doc(p(t('b'))), depth: 1 }];
  const xml = (options: Record<string, unknown>) => pageDocxFiles('Handboek', doc({ type: 'paragraph' }, p(t('  '))), {}, { chapters, ...options })
    .find(file => file.path === 'word/document.xml')?.data as string;
  for (const options of [{}, { cover: { date: '28 november 2026' } }]) {
    const out = xml(options);
    assert.match(out, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Eén/, JSON.stringify(options));
    assert.match(out, /<w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/><\/w:pPr><w:r><w:t xml:space="preserve">Twee/, JSON.stringify(options));
  }
  // Met een inhoudsopgave vooraan staat er wel iets: dan begint het eerste hoofdstuk op een nieuwe bladzijde.
  assert.match(xml({ toc: true }), /<w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/><\/w:pPr><w:r><w:t xml:space="preserve">Eén/);
});
