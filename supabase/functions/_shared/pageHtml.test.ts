/**
 * Tests voor een pagina als HTML (stap 1C). Draaien met:  npm test
 *
 * Deze HTML gaat naar klanten: het portaal en de geheime link tonen hem. Wat
 * hier vastligt:
 *  - elk bloktype dat de database toelaat, komt erin, met zijn tekst;
 *  - er staan alleen tags en attributen uit de lijst in, ook als de pagina
 *    vijandig is (een rare link, een verzonnen soort kader, HTML als tekst);
 *  - wat de aanroeper niet meegeeft (een subpagina die niet gedeeld is, een
 *    afbeelding buiten de versie), staat er niet in, ook niet als de pagina
 *    zelf een titel of adres noemt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALLOUT_VARIANTS, PAGE_MARK_TYPES, PAGE_NODE_TYPES } from '../../../src/lib/pageSchema.ts';
import { escapeHtml, PAGE_HTML_ATTRIBUTES, PAGE_HTML_CALLOUTS, PAGE_HTML_TAGS, renderPageHtml, type PageHtmlContext } from './pageHtml.ts';
import { pageReferences } from './pageReferences.ts';
import { RICH_CONTENT_URI_SAFE_ATTRS } from '../../../src/lib/sanitizeHtml.ts';

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };

const t = (text: string, ...marks: Node['marks'] & object): Node => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const p = (...content: Node[]): Node => ({ type: 'paragraph', content });
const h = (level: number, text: string): Node => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const li = (...content: Node[]): Node => ({ type: 'listItem', content });
const cell = (type: 'tableHeader' | 'tableCell', text: string, attrs: Record<string, unknown> = {}): Node =>
  ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs }, content: [p(t(text))] });
const doc = (...content: Node[]) => ({ type: 'doc', content });

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const IMAGE_ID = '33333333-3333-4333-8333-333333333333';

const VOID = new Set(['br', 'hr', 'img']);

/**
 * Leest de HTML zoals deze module hem maakt, en keurt elke tag en elk
 * attribuut tegen de lijst. Faalt op alles wat er niet hoort: een onbekende
 * tag, een attribuut zonder aanhalingstekens, een losse < of &, iets dat niet
 * sluit.
 */
function assertAllowed(html: string, label: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/g;
  let pos = 0;
  for (const match of html.matchAll(tag)) {
    const between = html.slice(pos, match.index);
    assert.doesNotMatch(between, /[<>]|&(?!(?:amp|lt|gt|quot|#39);)/, `${label}: losse < > of & vóór positie ${match.index}`);
    pos = (match.index ?? 0) + match[0].length;
    const [, close, name, attributes] = match;
    assert.ok((PAGE_HTML_TAGS as readonly string[]).includes(name), `${label}: tag <${name}> staat niet in de lijst`);
    if (close) {
      assert.equal(stack.pop(), name, `${label}: </${name}> sluit niet wat open staat`);
      continue;
    }
    for (const attr of attributes.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      const [, attrName, value] = attr;
      if (attrName === 'class') {
        for (const name of value.split(' ')) assert.match(name, /^rf-[a-z0-9-]+$/, `${label}: klasse "${name}"`);
        continue;
      }
      assert.ok((PAGE_HTML_ATTRIBUTES[name] ?? []).includes(attrName), `${label}: <${name} ${attrName}> staat niet in de lijst`);
      if (attrName === 'href') assert.match(value, /^(https?:|mailto:|tel:)/i, `${label}: href ${value}`);
      if (attrName === 'src') assert.match(value, /^https:\/\//, `${label}: src ${value}`);
      if (['colspan', 'rowspan', 'start', 'width', 'height'].includes(attrName)) assert.match(value, /^\d+$/, `${label}: ${attrName}=${value}`);
    }
    if (!VOID.has(name)) stack.push(name);
  }
  assert.doesNotMatch(html.slice(pos), /[<>]/, `${label}: tekst na het laatste element`);
  assert.deepEqual(stack, [], `${label}: niet gesloten`);
}

// ── De lijst zelf ───────────────────────────────────────────────────────────

test('de lijst overleeft de sanitizer van het portaal: geen id, style, data-* of verboden tag', () => {
  // sanitizeRichContentHtml (src/lib/sanitizeHtml.ts) haalt deze weg; de
  // opmaak zou dan stil verdwijnen. FORBID_TAGS daar, plus wat DOMPurify
  // zelf nooit doorlaat.
  const forbiddenTags = ['style', 'link', 'base', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math', 'script'];
  for (const name of PAGE_HTML_TAGS) assert.ok(!forbiddenTags.includes(name), name);
  for (const [name, attributes] of Object.entries(PAGE_HTML_ATTRIBUTES)) {
    assert.ok((PAGE_HTML_TAGS as readonly string[]).includes(name), `attributen voor een tag die niet bestaat: ${name}`);
    for (const attr of attributes) assert.doesNotMatch(attr, /^(id|style|data-.*|on.*)$/, `${name} ${attr}`);
  }
});

test('elk attribuut zonder adres houdt de sanitizer van het portaal heel', () => {
  // DOMPurify toetst elk attribuut dat hij niet als URI-veilig kent aan de
  // adresregel van de app (alleen https:, mailto: …). colspan="2" en start="3"
  // gingen zo verloren, en de Node-test hierboven zag dat niet: hij keek alleen
  // naar verboden namen (gevonden met ui.mjs paginadelen, 28 november 2026).
  // href en src zijn adressen; alt en role kent DOMPurify als veilig; aria-*
  // laat hij staan; target en rel zet de hook van sanitizeHtml.ts bij elke link.
  const vanzelf = new Set(['href', 'src', 'alt', 'role', 'target', 'rel']);
  for (const [tag, attributes] of Object.entries(PAGE_HTML_ATTRIBUTES)) {
    for (const attr of attributes) {
      if (vanzelf.has(attr) || attr.startsWith('aria-')) continue;
      assert.ok((RICH_CONTENT_URI_SAFE_ATTRS as readonly string[]).includes(attr), `<${tag} ${attr}> verdwijnt in het portaal`);
    }
  }
});

test('de soorten kader zijn die van de editor', () => {
  assert.deepEqual([...PAGE_HTML_CALLOUTS], [...CALLOUT_VARIANTS]);
});

// ── Elk blok komt mee ───────────────────────────────────────────────────────

const CONTEXT: PageHtmlContext = {
  subpages: { [PAGE_ID]: { title: 'subpagina-tekst' } },
  fileNames: { [FILE_ID]: 'bestand-tekst.pdf' },
  images: { [IMAGE_ID]: { src: 'https://media.example/getekend?x=1&y=2', width: 640, height: 480 } },
};

const SAMPLES: Record<string, { node: Node; expect: RegExp }> = {
  paragraph: { node: p(t('alinea-tekst'), { type: 'hardBreak' }, t('na-de-breuk')), expect: /<p>alinea-tekst<br>na-de-breuk<\/p>/ },
  heading: { node: h(2, 'kop-tekst'), expect: /<h3>kop-tekst<\/h3>/ },
  bulletList: { node: { type: 'bulletList', content: [li(p(t('punt-tekst')))] }, expect: /<ul><li><p>punt-tekst<\/p><\/li><\/ul>/ },
  orderedList: { node: { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('stap-tekst')))] }, expect: /<ol start="3"><li><p>stap-tekst<\/p><\/li><\/ol>/ },
  taskList: {
    node: { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('taak-tekst'))] }] },
    expect: /<ul class="rf-task-list"><li class="rf-task-checked"><span class="rf-task-checkbox" role="img" aria-label="Afgevinkt"><\/span><div class="rf-task-content"><p>taak-tekst<\/p><\/div><\/li><\/ul>/,
  },
  blockquote: { node: { type: 'blockquote', content: [p(t('citaat-tekst'))] }, expect: /<blockquote><p>citaat-tekst<\/p><\/blockquote>/ },
  codeBlock: { node: { type: 'codeBlock', content: [t('code-tekst\n  <b>&')] }, expect: /<pre><code>code-tekst\n {2}&lt;b&gt;&amp;<\/code><\/pre>/ },
  horizontalRule: { node: { type: 'horizontalRule' }, expect: /<hr>/ },
  table: {
    node: { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'kopcel-tekst'), cell('tableCell', 'cel-tekst')] }] },
    expect: /<div class="rf-table-wrap"><table class="rf-table"><tbody><tr><th><p>kopcel-tekst<\/p><\/th><td><p>cel-tekst<\/p><\/td><\/tr><\/tbody><\/table><\/div>/,
  },
  image: {
    node: { type: 'image', attrs: { attachmentId: IMAGE_ID, alt: 'beeld-tekst' } },
    expect: /<p class="rf-image"><img src="https:\/\/media\.example\/getekend\?x=1&amp;y=2" alt="beeld-tekst" width="640" height="480" loading="lazy"><\/p>/,
  },
  fileBlock: { node: { type: 'fileBlock', attrs: { attachmentId: FILE_ID } }, expect: /<p class="rf-file">Bijlage: bestand-tekst\.pdf<\/p>/ },
  callout: { node: { type: 'callout', attrs: { variant: 'tip' }, content: [p(t('kader-tekst'))] }, expect: /<div class="rf-callout rf-callout-tip"><p>kader-tekst<\/p><\/div>/ },
  details: {
    node: { type: 'details', content: [{ type: 'detailsSummary', content: [t('kopregel-tekst')] }, { type: 'detailsContent', content: [p(t('inhoud-tekst'))] }] },
    expect: /<details class="rf-details"><summary>kopregel-tekst<\/summary><div class="rf-details-content"><p>inhoud-tekst<\/p><\/div><\/details>/,
  },
  columns: {
    node: { type: 'columns', content: [{ type: 'column', content: [p(t('links-tekst'))] }, { type: 'column', content: [p(t('rechts-tekst'))] }] },
    expect: /<div class="rf-columns"><div class="rf-column"><p>links-tekst<\/p><\/div><div class="rf-column"><p>rechts-tekst<\/p><\/div><\/div>/,
  },
  tableOfContents: { node: { type: 'tableOfContents' }, expect: /<nav class="rf-toc" aria-label="Inhoud"><p class="rf-toc-title">Inhoud<\/p><ul><li class="rf-toc-1">inhoud-kop<\/li><\/ul><\/nav>/ },
  subpage: { node: { type: 'subpage', attrs: { pageId: PAGE_ID } }, expect: /<p class="rf-subpage">→ subpagina-tekst<\/p>/ },
};

/** Deze staan alleen binnen een ander blok, en worden daar getest. */
const INSIDE: Record<string, string> = {
  doc: 'de pagina zelf',
  text: 'paragraph',
  mention: 'een eigen test hieronder',
  hardBreak: 'paragraph',
  listItem: 'bulletList',
  taskItem: 'taskList',
  tableRow: 'table',
  tableHeader: 'table',
  tableCell: 'table',
  detailsSummary: 'details',
  detailsContent: 'details',
  column: 'columns',
};

test('elk bloktype uit de database komt in de HTML, met zijn tekst', () => {
  for (const type of PAGE_NODE_TYPES) {
    assert.ok(SAMPLES[type] || INSIDE[type], `geen proef voor bloktype "${type}": voeg hem toe aan SAMPLES of INSIDE`);
  }
  for (const [type, sample] of Object.entries(SAMPLES)) {
    // De inhoudsopgave heeft een kop nodig om iets te tonen.
    const body = type === 'tableOfContents' ? doc(sample.node, h(1, 'inhoud-kop')) : doc(sample.node);
    const html = renderPageHtml(body, CONTEXT);
    assert.match(html, sample.expect, type);
    assert.match(html, /^<div class="rf-page">.*<\/div>$/s, type);
    assertAllowed(html, type);
  }
});

// Stap 2-1a, de strenge standaard: de klant ziet bij een vermelding alleen de
// soort, geen naam en geen id. Of hij de naam mag zien, vraagt het rapport.
test('de klant ziet bij een @-vermelding alleen de soort', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const html = renderPageHtml(doc(p(t('Bel '), { type: 'mention', attrs: { kind: 'project', id } }, t(' morgen.'))), CONTEXT);
  assert.match(html, /<p>Bel <span class="rf-mention">project<\/span> morgen\.<\/p>/);
  assert.ok(!html.includes(id), 'het id staat in de HTML');
  assertAllowed(html, 'vermelding');
  assert.match(renderPageHtml(doc(p({ type: 'mention', attrs: { kind: '<b>', id: 'x' } })), CONTEXT), /<span class="rf-mention">vermelding<\/span>/);
});

test('alle opmaak, binnen naar buiten in een vaste volgorde', () => {
  const all = PAGE_MARK_TYPES.map(type => (type === 'link' ? { type, attrs: { href: 'https://example.com/a?b=1&c=2' } } : { type }));
  const html = renderPageHtml(doc(p(t('alles', ...all))));
  assert.equal(html, '<div class="rf-page"><p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">'
    + '<strong><em><u><s><mark><code>alles</code></mark></s></u></em></strong></a></p></div>');
  assertAllowed(html, 'opmaak');
});

// ── Vijandige invoer ────────────────────────────────────────────────────────

test('links: alleen http(s), mailto en tel; de rest wordt gewone tekst', () => {
  const link = (href: unknown) => renderPageHtml(doc(p(t('klik', { type: 'link', attrs: { href } }))));
  assert.match(link('mailto:info@example.com'), /<a href="mailto:info@example\.com"/);
  assert.match(link('tel:+31201234567'), /<a href="tel:\+31201234567"/);
  assert.match(link('HTTP://example.com'), /<a href="HTTP:\/\/example\.com"/);
  for (const href of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>', '/intern/pad', '#kop', 'vbscript:x',
    'https://x.com/" onmouseover="alert(1)', 'https://x.com/\nnext', 42, null]) {
    const html = link(href);
    assert.equal(html, '<div class="rf-page"><p>klik</p></div>', String(href));
  }
});

test('tekst wordt nooit HTML: in een alinea, een kop, code, een titel, een naam en een alt-tekst', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const body = doc(
    p(t(evil)),
    h(1, evil),
    { type: 'codeBlock', content: [t(evil)] },
    { type: 'tableOfContents' },
    { type: 'subpage', attrs: { pageId: PAGE_ID } },
    { type: 'fileBlock', attrs: { attachmentId: FILE_ID } },
    { type: 'image', attrs: { attachmentId: IMAGE_ID, alt: evil } },
    { type: 'image', attrs: { attachmentId: 'ontbreekt', alt: evil } },
    { type: 'details', content: [{ type: 'detailsSummary', content: [t(evil)] }] },
  );
  const html = renderPageHtml(body, {
    subpages: { [PAGE_ID]: { title: evil, href: 'https://portaal.example/p' } },
    fileNames: { [FILE_ID]: evil },
    images: { [IMAGE_ID]: { src: 'https://media.example/x' } },
  });
  assertAllowed(html, 'vijandige tekst');
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes(escapeHtml(evil)), 'de tekst zelf blijft leesbaar');
});

test('een vijandige pagina: verzonnen soorten, rare getallen en blokken op de verkeerde plek', () => {
  const body = doc(
    { type: 'callout', attrs: { variant: 'info" onclick="alert(1)' }, content: [p(t('kader'))] },
    { type: 'heading', attrs: { level: '9"><script>' }, content: [t('kop')] },
    { type: 'heading', attrs: { level: 9 }, content: [t('te diepe kop')] },
    { type: 'orderedList', attrs: { start: '1" onclick="x' }, content: [li(p(t('a'))), p(t('los in een lijst'))] },
    { type: 'table', content: [
      { type: 'tableRow', content: [cell('tableCell', 'c', { colspan: '2" x="1', rowspan: -4, align: 'center" onclick="x' }), p(t('los in een rij'))] },
      p(t('los in een tabel')),
    ] },
    { type: 'listItem', content: [p(t('lijstpunt zonder lijst'))] },
    { type: 'tableCell', content: [p(t('cel zonder tabel'))] },
    { type: 'onbekend-blok', content: [t('onbekende tekst')] },
    { type: 'onbekend-blok', content: [p(t('onbekende alinea'))] },
    { type: 'script', text: '<script>alert(1)</script>' },
    { type: 'text', text: 'tekst los in de pagina' },
    'geen object',
    null,
  );
  const html = renderPageHtml(body as unknown);
  assertAllowed(html, 'vijandig');
  for (const text of ['kader', 'kop', 'los in een lijst', 'los in een rij', 'los in een tabel', 'lijstpunt zonder lijst',
    'cel zonder tabel', 'onbekende tekst', 'onbekende alinea', 'tekst los in de pagina']) {
    assert.ok(html.includes(text), `tekst kwijt: ${text}`);
  }
  assert.match(html, /<div class="rf-callout rf-callout-info">/);
  // Geen getal: kop 1. Te diep: kop 3.
  assert.match(html, /<h2>kop<\/h2>/);
  assert.match(html, /<h4>te diepe kop<\/h4>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<td>/);
  assert.doesNotMatch(html, /script/);
});

test('een heel diep geneste pagina stopt, zonder de stack op te blazen', () => {
  let node: Node = p(t('bodem'));
  for (let i = 0; i < 20000; i += 1) node = { type: 'blockquote', content: [node] };
  const html = renderPageHtml(doc(node, p(t('erna'))));
  assert.ok(html.includes('erna'));
  assert.ok(!html.includes('bodem'), 'dieper dan de grens komt niet mee');
  assertAllowed(html, 'diep');
  assert.deepEqual(pageReferences(doc(node)), { pages: [], files: [], images: [] });
});

test('een lege of kapotte body geeft niets', () => {
  for (const body of [null, undefined, 'tekst', 42, [], {}, { type: 'doc' }, { type: 'doc', content: 'kapot' }, { type: 'doc', content: [] }]) {
    assert.equal(renderPageHtml(body), '', JSON.stringify(body) ?? 'undefined');
  }
  assert.equal(renderPageHtml(doc(p())), '<div class="rf-page"><p><br></p></div>');
});

// ── Alleen wat de aanroeper meegeeft ────────────────────────────────────────

test('een subpagina die niet gedeeld is, staat er niet in, ook haar titel niet', () => {
  const body = doc({ type: 'subpage', attrs: { pageId: PAGE_ID, title: 'Geheime titel' } }, p(t('erna')));
  for (const context of [undefined, {}, { subpages: {} }, { subpages: { [`${PAGE_ID}x`]: { title: 'Ander' } } }]) {
    const html = renderPageHtml(body, context);
    assert.equal(html, '<div class="rf-page"><p>erna</p></div>');
  }
  // Ook geen id dat via het prototype iets teruggeeft.
  for (const pageId of ['__proto__', 'constructor', 'toString']) {
    assert.equal(renderPageHtml(doc({ type: 'subpage', attrs: { pageId } }), { subpages: {} }), '');
  }
});

test('een gedeelde subpagina: de titel van de aanroeper, een link alleen naar https', () => {
  const body = doc({ type: 'subpage', attrs: { pageId: PAGE_ID, title: 'Oude titel' } });
  const html = (href: unknown) => renderPageHtml(body, { subpages: { [PAGE_ID]: { title: '  Werkwijze  ', href: href as string } } });
  assert.equal(html(undefined), '<div class="rf-page"><p class="rf-subpage">→ Werkwijze</p></div>');
  assert.equal(html('https://portaal.example/gedeeld/abc'),
    '<div class="rf-page"><p class="rf-subpage"><a href="https://portaal.example/gedeeld/abc" target="_blank" rel="noopener noreferrer nofollow">→ Werkwijze</a></p></div>');
  for (const href of ['http://portaal.example/x', 'javascript:alert(1)', '/gedeeld/abc', 'https://x.example/"y']) {
    assert.equal(html(href), '<div class="rf-page"><p class="rf-subpage">→ Werkwijze</p></div>', href);
  }
  assert.equal(renderPageHtml(body, { subpages: { [PAGE_ID]: { title: ' ' } } }), '<div class="rf-page"><p class="rf-subpage">→ Naamloze pagina</p></div>');
  assert.doesNotMatch(html(undefined), /Oude titel/);
});

test('een bestand: alleen de naam van de aanroeper, zonder link', () => {
  const body = doc({ type: 'fileBlock', attrs: { attachmentId: FILE_ID, name: 'Naam uit het blok.pdf' } });
  assert.equal(renderPageHtml(body), '');
  assert.equal(renderPageHtml(body, { fileNames: { [FILE_ID]: '  ' } }), '');
  assert.equal(renderPageHtml(body, { fileNames: { [FILE_ID]: 'Offerte.pdf' } }), '<div class="rf-page"><p class="rf-file">Bijlage: Offerte.pdf</p></div>');
});

test('een afbeelding alleen met een https-adres van de aanroeper; nooit een adres uit de pagina', () => {
  const body = doc({ type: 'image', attrs: { attachmentId: IMAGE_ID, alt: 'Plattegrond', src: 'https://volg.example/pixel.gif' } });
  const missing = '<div class="rf-page"><p class="rf-image-missing">[Afbeelding: Plattegrond]</p></div>';
  assert.equal(renderPageHtml(body), missing);
  for (const src of ['http://media.example/x', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '//media.example/x', 'https://media.example/x y', 42]) {
    assert.equal(renderPageHtml(body, { images: { [IMAGE_ID]: { src: src as string } } }), missing, String(src));
  }
  assert.equal(renderPageHtml(doc({ type: 'image', attrs: { attachmentId: IMAGE_ID } })), '<div class="rf-page"><p class="rf-image-missing">[Afbeelding]</p></div>');
  // De maat alleen als beide er zijn, en begrensd.
  const sized = (width: unknown, height: unknown) => renderPageHtml(body, { images: { [IMAGE_ID]: { src: 'https://media.example/x', width: width as number, height: height as number } } });
  assert.match(sized(null, 100), /<img src="https:\/\/media\.example\/x" alt="Plattegrond" loading="lazy">/);
  assert.match(sized(800, 600), / width="800" height="600" /);
  assert.match(sized(99999, 600.7), / width="10000" height="600" /);
  assert.doesNotMatch(renderPageHtml(body, { images: { [IMAGE_ID]: { src: 'https://media.example/x' } } }), /volg\.example/);
});

// ── Tabellen, lijsten, uitklappers, inhoudsopgave ───────────────────────────

test('een tabel: samengevoegde cellen, kopcellen en uitlijning uit een vaste lijst', () => {
  const body = doc({ type: 'table', content: [
    { type: 'tableRow', content: [cell('tableHeader', 'A', { colspan: 2 }), cell('tableHeader', 'B', { rowspan: 9, align: 'right' })] },
    { type: 'tableRow', content: [cell('tableCell', 'C', { align: 'center' }), cell('tableCell', 'D', { align: 'left' })] },
  ] });
  const html = renderPageHtml(body);
  assertAllowed(html, 'tabel');
  assert.match(html, /<tr><th colspan="2"><p>A<\/p><\/th><th rowspan="2" class="rf-align-right"><p>B<\/p><\/th><\/tr>/);
  assert.match(html, /<tr><td class="rf-align-center"><p>C<\/p><\/td><td><p>D<\/p><\/td><\/tr>/);
});

test('geneste lijsten en takenlijsten', () => {
  const body = doc(
    { type: 'bulletList', content: [li(p(t('een')), { type: 'orderedList', content: [li(p(t('een.een')))] })] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: false }, content: [p(t('open')), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: 'true' }, content: [p(t('dieper'))] }] }] },
    ] },
  );
  const html = renderPageHtml(body);
  assertAllowed(html, 'lijsten');
  assert.match(html, /<ul><li><p>een<\/p><ol><li><p>een\.een<\/p><\/li><\/ol><\/li><\/ul>/);
  // Alleen true is afgevinkt; de tekst "true" niet.
  assert.equal(html.match(/rf-task-checked/g), null);
  assert.equal(html.match(/aria-label="Niet afgevinkt"/g)?.length, 2);
});

test('een uitklapper is dicht, en houdt alles wat erin staat', () => {
  const body = doc({ type: 'details', attrs: { open: true }, content: [
    { type: 'detailsSummary', content: [t('Meer', { type: 'bold' })] },
    { type: 'detailsContent', content: [p(t('binnen'))] },
    p(t('ernaast')),
  ] });
  const html = renderPageHtml(body);
  assert.equal(html, '<div class="rf-page"><details class="rf-details"><summary><strong>Meer</strong></summary>'
    + '<div class="rf-details-content"><p>binnen</p><p>ernaast</p></div></details></div>');
});

test('de inhoudsopgave: alle koppen in volgorde, ook in een kader; niets zonder koppen', () => {
  const body = doc(
    { type: 'tableOfContents' },
    h(1, 'Een'),
    { type: 'callout', content: [h(3, 'In een kader')] },
    h(2, ''),
  );
  const html = renderPageHtml(body);
  assert.match(html, /<ul><li class="rf-toc-1">Een<\/li><li class="rf-toc-3">In een kader<\/li><li class="rf-toc-2">Kop zonder tekst<\/li><\/ul>/);
  assert.equal(renderPageHtml(doc({ type: 'tableOfContents' }, p(t('x')))), '<div class="rf-page"><p>x</p></div>');
});

test('pageReferences vindt subpagina\'s, bestanden en afbeeldingen, ook diep in de pagina', () => {
  const body = doc(
    { type: 'callout', content: [{ type: 'image', attrs: { attachmentId: IMAGE_ID } }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'fileBlock', attrs: { attachmentId: FILE_ID } }] }] }] },
    { type: 'subpage', attrs: { pageId: PAGE_ID } },
    { type: 'image', attrs: { attachmentId: IMAGE_ID } },
  );
  assert.deepEqual(pageReferences(body), { pages: [PAGE_ID], files: [FILE_ID], images: [IMAGE_ID] });
});
