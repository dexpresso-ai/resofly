// ============================================================
// Een pagina als HTML, om te lezen buiten de editor (stap 1C,
// docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §7).
//
// Een klant leest een gedeelde pagina in het portaal of via een geheime link,
// als webpagina. Die HTML maakt deze module op de server, uit de JSON van de
// vrijgegeven versie (document_versions.body). Zonder DOM en zonder pakketten:
// hij draait in een edge function (Deno), in de tests (Node), en later in de
// Worker van de klantadressen (§17).
//
// Keuzes, en waarom:
//  - Alles wordt opgebouwd uit de JSON. Er gaat geen tekst of HTML ongezien
//    door: tekst wordt ge-escaped, en een waarde die in een attribuut of
//    klasse komt (de soort kader, uitlijning, colspan, een adres) komt uit een
//    vaste lijst, of is een getal dat hier berekend is.
//  - Alleen de tags en attributen uit PAGE_HTML_TAGS en PAGE_HTML_ATTRIBUTES.
//    Het portaal haalt sanitizeRichContentHtml (src/lib/sanitizeHtml.ts) er
//    nog eens overheen, en die laat geen id, style of data-* staan. Daarom
//    gaat de opmaak via klassen (rf-…), en springt de inhoudsopgave niet naar
//    de koppen.
//  - Een subpagina staat er alleen in als de aanroeper haar meegeeft
//    (context.subpages). Wat niet gedeeld is, verschijnt niet, ook haar titel
//    niet. Een titel of naam die in een blok zelf staat, telt nooit: die kan
//    via de API in de pagina zijn gezet.
//  - Een afbeelding alleen met een https-adres van de aanroeper
//    (context.images). Die tekent het alleen voor afbeeldingen in deze versie;
//    anders staat er "[Afbeelding]". Nooit een adres uit de pagina zelf: dat
//    zou een volgpixel kunnen zijn.
//  - Een link alleen naar http(s), mailto of tel. Een link binnen de app (/…
//    of #…) wijst bij de klant nergens heen en wordt gewone tekst.
//  - Kop 1 tot 3 worden h2 tot h4: de titel van de pagina is de bovenste kop.
//  - Een uitklapper is dicht, zoals in de app (open is daar een weergave, geen
//    inhoud).
//  - Geen kolombreedtes uit de tabel: op een telefoon moet de tabel kunnen
//    krimpen, en een breedte vraagt style.
//  - Een blok dat deze module niet kent, verliest zijn vorm maar niet zijn
//    tekst. pageHtml.test.ts zet elk bloktype uit de database erin.
// ============================================================

/** Wat de pagina zelf niet weet, of niet mag bepalen. De aanroeper zoekt het op. */
export type PageHtmlContext = {
  /**
   * De subpagina's die de lezer ook mag zien: pageId → titel, en eventueel een
   * https-adres om haar te openen. Een subpagina die hier niet in staat, komt
   * niet in de HTML.
   */
  subpages?: Record<string, { title: string; href?: string | null }>;
  /** Namen van de bestanden in bestandsblokken: attachmentId → naam. Zonder naam blijft het blok weg. */
  fileNames?: Record<string, string>;
  /** Afbeeldingen: attachmentId → een https-adres, en de maat in pixels als die bekend is. */
  images?: Record<string, { src: string; width?: number | null; height?: number | null }>;
};

/** Elke tag die deze module maakt. */
export const PAGE_HTML_TAGS = [
  'div', 'p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's', 'code', 'mark', 'a',
  'ul', 'ol', 'li', 'span', 'blockquote', 'pre', 'hr',
  'table', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'nav', 'img',
] as const;

/** De attributen per tag, naast class (die mag op elke tag, en begint altijd met rf-). */
export const PAGE_HTML_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'target', 'rel'],
  ol: ['start'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  span: ['role', 'aria-label'],
  nav: ['aria-label'],
};

/** Spiegel van CALLOUT_VARIANTS in src/lib/pageSchema.ts; pageHtml.test.ts houdt ze gelijk. */
export const PAGE_HTML_CALLOUTS = ['info', 'tip', 'let-op', 'waarschuwing'] as const;

type Mark = { type?: string; attrs?: Record<string, unknown> };
type PmNode = { type?: string; attrs?: Record<string, unknown>; content?: PmNode[]; text?: string; marks?: Mark[] };
type TocEntry = { level: number; text: string };
type Ctx = { context: PageHtmlContext; toc: TocEntry[] };

/** Dieper dan dit nest geen pagina uit de editor. Een diepere body (via de API) stopt hier, in plaats van de stack op te blazen. */
const MAX_DEPTH = 64;
const MAX_COLSPAN = 63;
const MAX_IMAGE_SIDE = 10000;
const LINK_PATTERN = /^(https?:|mailto:|tel:)/i;
const HTTPS_PATTERN = /^https:\/\/[^\s"'<>\\]+$/i;
const ALIGN_CLASSES: Record<string, string> = { center: 'rf-align-center', right: 'rf-align-right' };
const LINK_ATTRIBUTES = 'target="_blank" rel="noopener noreferrer nofollow"';

export function escapeHtml(value: string): string {
  // Stuurtekens gaan eruit: ze horen niet in tekst, en sommige lezers struikelen erover.
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Een eigen veld van een opzoeklijst. Zonder deze controle gaf een id als "__proto__" iets terug dat er niet in staat. */
function own<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && key && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function whole(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function attrText(node: PmNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function textOf(node: PmNode, depth = 0): string {
  if (depth > MAX_DEPTH || !node || typeof node !== 'object') return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  return Array.isArray(node.content) ? node.content.map(child => textOf(child, depth + 1)).join('') : '';
}

function children(node: PmNode): PmNode[] {
  return Array.isArray(node.content) ? node.content.filter(child => child && typeof child === 'object') : [];
}

function safeHttps(value: unknown): string | null {
  return typeof value === 'string' && HTTPS_PATTERN.test(value.trim()) ? value.trim() : null;
}

function linkOf(marks: Mark[] | undefined): string | null {
  const href = marks?.find(mark => mark?.type === 'link')?.attrs?.href;
  if (typeof href !== 'string') return null;
  const value = href.trim();
  return LINK_PATTERN.test(value) && !/[\s<>"'\\]/.test(value) ? value : null;
}

function marked(text: string, marks: Mark[] | undefined): string {
  const has = new Set((Array.isArray(marks) ? marks : []).map(mark => mark?.type));
  let html = escapeHtml(text);
  // Van binnen naar buiten, altijd in deze volgorde: dan sluit alles netjes.
  if (has.has('code')) html = `<code>${html}</code>`;
  if (has.has('highlight')) html = `<mark>${html}</mark>`;
  if (has.has('strike')) html = `<s>${html}</s>`;
  if (has.has('underline')) html = `<u>${html}</u>`;
  if (has.has('italic')) html = `<em>${html}</em>`;
  if (has.has('bold')) html = `<strong>${html}</strong>`;
  const href = linkOf(marks);
  return href ? `<a href="${escapeHtml(href)}" ${LINK_ATTRIBUTES}>${html}</a>` : html;
}

function inlineHtml(nodes: PmNode[], depth: number): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'hardBreak') { out += '<br>'; continue; }
    if (node.type === 'text') {
      if (typeof node.text === 'string' && node.text) out += marked(node.text, node.marks);
      continue;
    }
    // Iets anders tussen de tekst: alleen de tekst gaat mee.
    const text = textOf(node, depth + 1);
    if (text) out += escapeHtml(text);
  }
  return out;
}

const isInline = (node: PmNode) => node.type === 'text' || node.type === 'hardBreak';

function blocksHtml(nodes: PmNode[], ctx: Ctx, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  return nodes.map(node => blockHtml(node, ctx, depth)).join('');
}

function blockHtml(node: PmNode, ctx: Ctx, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  const content = children(node);
  switch (node.type) {
    case 'paragraph':
      // Een lege alinea houdt haar hoogte, zoals in de editor.
      return `<p>${inlineHtml(content, depth) || '<br>'}</p>`;
    case 'heading': {
      const tag = `h${whole(node.attrs?.level, 1, 3) + 1}`;
      return `<${tag}>${inlineHtml(content, depth)}</${tag}>`;
    }
    case 'blockquote':
      return `<blockquote>${blocksHtml(content, ctx, depth + 1)}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml(textOf(node, depth))}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    case 'bulletList':
      return `<ul>${listItems(content, ctx, depth)}</ul>`;
    case 'orderedList': {
      const start = whole(node.attrs?.start, 1, 1_000_000);
      return `<ol${start > 1 ? ` start="${start}"` : ''}>${listItems(content, ctx, depth)}</ol>`;
    }
    case 'taskList':
      return `<ul class="rf-task-list">${listItems(content, ctx, depth)}</ul>`;
    case 'table':
      return tableHtml(content, ctx, depth);
    case 'callout': {
      const value = node.attrs?.variant;
      const variant = (PAGE_HTML_CALLOUTS as readonly unknown[]).includes(value) ? value as string : 'info';
      return `<div class="rf-callout rf-callout-${variant}">${blocksHtml(content, ctx, depth + 1)}</div>`;
    }
    case 'details':
      return detailsHtml(content, ctx, depth);
    case 'columns': {
      const columns = content.map(child => (child.type === 'column' ? children(child) : [child]));
      return `<div class="rf-columns">${columns.map(column => `<div class="rf-column">${blocksHtml(column, ctx, depth + 2)}</div>`).join('')}</div>`;
    }
    case 'tableOfContents':
      return tocHtml(ctx);
    case 'subpage': {
      const subpage = own(ctx.context.subpages, attrText(node, 'pageId'));
      if (!subpage || typeof subpage !== 'object') return '';
      const title = escapeHtml((typeof subpage.title === 'string' ? subpage.title.trim() : '') || 'Naamloze pagina');
      const href = safeHttps(subpage.href);
      return `<p class="rf-subpage">${href ? `<a href="${escapeHtml(href)}" ${LINK_ATTRIBUTES}>→ ${title}</a>` : `→ ${title}`}</p>`;
    }
    case 'fileBlock': {
      const name = own(ctx.context.fileNames, attrText(node, 'attachmentId'));
      if (typeof name !== 'string' || !name.trim()) return '';
      return `<p class="rf-file">Bijlage: ${escapeHtml(name.trim())}</p>`;
    }
    case 'image':
      return imageHtml(node, ctx);
    default:
      // Onbekend of nieuw: de tekst gaat mee, de vorm niet. Een lijstpunt of
      // cel op een plek waar hij niet hoort, valt hier ook onder.
      if (content.some(isInline)) return `<p>${inlineHtml(content, depth)}</p>`;
      if (content.length > 0) return blocksHtml(content, ctx, depth + 1);
      return node.type !== 'text' || typeof node.text !== 'string' || !node.text ? '' : `<p>${escapeHtml(node.text)}</p>`;
  }
}

function listItems(items: PmNode[], ctx: Ctx, depth: number): string {
  return items.map(item => {
    if (item.type === 'taskItem') {
      const done = item.attrs?.checked === true;
      return `<li${done ? ' class="rf-task-checked"' : ''}>`
        + `<span class="rf-task-checkbox" role="img" aria-label="${done ? 'Afgevinkt' : 'Niet afgevinkt'}"></span>`
        + `<div class="rf-task-content">${blocksHtml(children(item), ctx, depth + 2)}</div></li>`;
    }
    // Een los blok in een lijst krijgt toch een punt, anders is de HTML ongeldig.
    const inner = item.type === 'listItem' ? blocksHtml(children(item), ctx, depth + 2) : blockHtml(item, ctx, depth + 2);
    return `<li>${inner}</li>`;
  }).join('');
}

function tableHtml(content: PmNode[], ctx: Ctx, depth: number): string {
  const rows = content.filter(child => child.type === 'tableRow');
  const rest = content.filter(child => child.type !== 'tableRow');
  let out = '';
  if (rows.length > 0) {
    out += '<div class="rf-table-wrap"><table class="rf-table"><tbody>';
    rows.forEach((row, r) => {
      out += '<tr>';
      for (const cell of children(row)) {
        const tag = cell.type === 'tableHeader' ? 'th' : 'td';
        const colspan = whole(cell.attrs?.colspan, 1, MAX_COLSPAN);
        const rowspan = whole(cell.attrs?.rowspan, 1, rows.length - r);
        const align = ALIGN_CLASSES[attrText(cell, 'align')];
        const inner = cell.type === 'tableHeader' || cell.type === 'tableCell'
          ? blocksHtml(children(cell), ctx, depth + 3)
          : blockHtml(cell, ctx, depth + 3);
        out += `<${tag}${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${align ? ` class="${align}"` : ''}>${inner}</${tag}>`;
      }
      out += '</tr>';
    });
    out += '</tbody></table></div>';
  }
  // Wat niet in een rij staat, kan niet in de tabel: het komt eronder.
  return out + blocksHtml(rest, ctx, depth + 1);
}

function detailsHtml(content: PmNode[], ctx: Ctx, depth: number): string {
  const summary = content.find(child => child.type === 'detailsSummary');
  const inner = content.flatMap(child => {
    if (child === summary) return [];
    return child.type === 'detailsContent' ? children(child) : [child];
  });
  return `<details class="rf-details"><summary>${summary ? inlineHtml(children(summary), depth + 1) : ''}</summary>`
    + `<div class="rf-details-content">${blocksHtml(inner, ctx, depth + 2)}</div></details>`;
}

function tocHtml(ctx: Ctx): string {
  if (ctx.toc.length === 0) return '';
  return '<nav class="rf-toc" aria-label="Inhoud"><p class="rf-toc-title">Inhoud</p><ul>'
    + ctx.toc.map(entry => `<li class="rf-toc-${entry.level}">${escapeHtml(entry.text || 'Kop zonder tekst')}</li>`).join('')
    + '</ul></nav>';
}

function imageHtml(node: PmNode, ctx: Ctx): string {
  const alt = attrText(node, 'alt');
  const image = own(ctx.context.images, attrText(node, 'attachmentId'));
  const src = image && typeof image === 'object' ? safeHttps(image.src) : null;
  if (!image || !src) {
    return `<p class="rf-image-missing">${escapeHtml(alt ? `[Afbeelding: ${alt}]` : '[Afbeelding]')}</p>`;
  }
  const width = whole(image.width, 0, MAX_IMAGE_SIDE);
  const height = whole(image.height, 0, MAX_IMAGE_SIDE);
  const size = width > 0 && height > 0 ? ` width="${width}" height="${height}"` : '';
  return `<p class="rf-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${size} loading="lazy"></p>`;
}

function collectHeadings(node: PmNode, out: TocEntry[], depth: number): void {
  // Zoals de inhoudsopgave in de app (pageEditorExtensions.ts): alle koppen,
  // ook die in een kader of uitklapper, in volgorde.
  if (depth > MAX_DEPTH || !node || typeof node !== 'object') return;
  if (node.type === 'heading') { out.push({ level: whole(node.attrs?.level, 1, 3), text: textOf(node, depth).trim() }); return; }
  for (const child of children(node)) collectHeadings(child, out, depth + 1);
}

/**
 * De pagina als HTML-fragment, in een <div class="rf-page">. Een lege of
 * onleesbare body geeft een lege string.
 */
export function renderPageHtml(body: unknown, context: PageHtmlContext = {}): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const root = body as PmNode;
  const toc: TocEntry[] = [];
  collectHeadings(root, toc, 0);
  const html = blocksHtml(children(root), { context, toc }, 1);
  return html ? `<div class="rf-page">${html}</div>` : '';
}
