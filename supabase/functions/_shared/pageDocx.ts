// ============================================================
// Een pagina als Word-bestand (stap 1B-2, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §9).
//
// Zet de blokken van een pagina (de ProseMirror-JSON in documents.body) om in
// WordprocessingML, en pakt dat in als .docx. Zonder DOM en zonder pakketten:
// het draait straks in de edge function page-export (Deno), en nu al in de
// tests (Node). De PDF komt later uit ditzelfde bestand, via de office-server
// (Collabora). Zo zien Word en PDF er hetzelfde uit.
//
// Keuzes, en waarom:
//  - De volgorde van de elementen volgt het schema (ECMA-376), zie para() en
//    runProps(). Het bestand is tegen de XSD's van dat schema gecontroleerd en
//    in LibreOffice omgezet naar PDF (zie de changelog).
//  - Koppen, citaat en code zijn stijlen in styles.xml. Zo zijn het in Word en
//    LibreOffice echte koppen (navigatievenster, inhoudsopgave).
//  - Een lijst krijgt echte nummering (numbering.xml). Elke genummerde lijst
//    heeft een eigen w:num met een nieuwe start: lijsten met dezelfde
//    definitie tellen in Word anders door.
//  - Een tabel wordt w:tbl. De kopregel herhaalt op elke pagina,
//    samengevoegde cellen worden gridSpan en vMerge, en de breedtes komen uit
//    colwidth. Is de tabel te breed voor het papier, dan krimpen alle kolommen
//    even hard. Een kader (callout) is een gekleurde tabel van één cel, kolommen
//    zijn een tabel zonder randen, en een uitklapper staat open.
//  - Een link alleen naar http(s), mailto of tel. Een link binnen de app (/…
//    of #…) wijst buiten de app nergens heen en wordt gewone tekst.
//  - Het inhoudsopgave-blok wordt een TOC-veld, al gevuld met de koppen. Word
//    zet er bij bijwerken (F9) de paginanummers bij.
//  - Een afbeelding alleen als de bytes er zijn (png, jpeg of gif), anders de
//    regel "[Afbeelding]". Nooit een adres van buiten: het bestand moet ook
//    zonder internet compleet zijn, en zo'n adres zou laten zien wie het opent.
//  - Een blok dat deze module niet kent, verliest zijn vorm maar niet zijn
//    tekst. pageDocx.test.ts zet elk bloktype uit de database erin.
//  - De huisstijlletter gaat als TTF mee in het bestand (context.font). Zonder
//    die letter vervangt LibreOffice (en dus de PDF via Collabora) hem door een
//    andere, en een .woff neemt hij niet aan (docs/rapporten/
//    PROEF_1B1_LETTERS_EMOJI_2026-11-28.md). Een .woff zet woff.ts eerst om.
// ============================================================

import { ZipBuilder } from './zipWriter.ts';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type PageDocxImage = {
  bytes: Uint8Array;
  contentType: string;
  /** In pixels. Ontbreekt de maat, dan leest imageSize() hem uit de bytes. */
  width?: number;
  height?: number;
};

/**
 * Een letter om in te sluiten, als TTF of OTF (geen WOFF: woffToSfnt in
 * woff.ts zet die om). `family` is de naam zoals de letter zichzelf noemt
 * (sfntFamilyName), anders vindt Word hem niet terug.
 */
export type PageDocxFont = { family: string; regular?: Uint8Array; bold?: Uint8Array };

/** Wat de pagina zelf niet weet. De aanroeper zoekt het op, met de rechten van wie exporteert. */
export type PageDocxContext = {
  /** De letter van de huisstijl; zonder deze letter wordt het Calibri. */
  font?: PageDocxFont;
  /** Titels van subpagina's (pageId → titel). Ontbreekt er een, dan "Pagina niet gevonden", zoals in de app. */
  pageTitles?: Record<string, string>;
  /** Namen van de bestanden in bestandsblokken (attachmentId → naam). */
  fileNames?: Record<string, string>;
  /** Afbeeldingen (attachmentId → bytes). */
  images?: Record<string, PageDocxImage>;
};

type Mark = { type?: string; attrs?: Record<string, unknown> };
type PmNode = { type?: string; attrs?: Record<string, unknown>; content?: PmNode[]; text?: string; marks?: Mark[] };

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:w="${W_NS}" xmlns:r="${REL}" `
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// A4 met 2,5 cm marge. Maten in twips (1/20 punt) en EMU (1/914400 inch).
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1418;
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const TEXT_HEIGHT = PAGE_HEIGHT - 2 * MARGIN;
const TWIPS_PER_PX = 15;
const EMU_PER_PX = 9525;
const EMU_PER_TWIP = 635;
/** Meer kolommen kan Word niet aan. */
const MAX_COLUMNS = 63;

const BORDER = 'CBD5E1';
const SHADE = 'F1F5F9';
const MUTED = '64748B';
/** numId van alle opsommingen; genummerde lijsten krijgen er elk een na. */
const BULLETS = 1;

const LINK_PATTERN = /^(https?:|mailto:|tel:)/i;
const ALIGN: Record<string, string> = { left: 'left', center: 'center', right: 'right' };
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };
/** De kleuren van de kaders in de app (blauw, groen, oranje, rood), maar vast: papier kent geen donker thema. */
const CALLOUTS: Record<string, { fill: string; border: string }> = {
  info: { fill: 'EFF6FF', border: '3B82F6' },
  tip: { fill: 'ECFDF5', border: '10B981' },
  'let-op': { fill: 'FFFBEB', border: 'F59E0B' },
  waarschuwing: { fill: 'FEF2F2', border: 'EF4444' },
};

export function escapeXml(value: string): string {
  // Tekens die XML 1.0 niet toelaat, gaan eruit: één zo'n teken maakt het
  // hele bestand onleesbaar.
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** De maat in pixels uit de kop van een png, gif of jpeg; null als dat niet lukt. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  // PNG: de handtekening, dan het IHDR-blok met breedte en hoogte.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return size(view.getUint32(16), view.getUint32(20));
  }
  // GIF: "GIF8", dan breedte en hoogte (little-endian).
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return size(view.getUint16(6, true), view.getUint16(8, true));
  }
  // JPEG: de segmenten langs tot het frame (SOF0 tot SOF15, behalve C4, C8 en CC).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 8 < bytes.length) {
      if (bytes[pos] !== 0xff) return null;
      const marker = bytes[pos + 1];
      if (marker === 0xff) { pos += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return size(view.getUint16(pos + 7), view.getUint16(pos + 5));
      }
      const length = view.getUint16(pos + 2);
      if (length < 2) return null;
      pos += 2 + length;
    }
  }
  return null;
}

// ── Opbouw ──────────────────────────────────────────────────────────────────

class DocxBuilder {
  readonly context: PageDocxContext;
  readonly rels: Array<{ id: string; type: string; target: string; external: boolean }> = [];
  readonly media: Array<{ path: string; bytes: Uint8Array; contentType: string }> = [];
  readonly orderedLists: number[] = [];
  private readonly links = new Map<string, string>();
  private readonly images = new Map<string, string>();
  private relCount = 10;
  private drawingCount = 0;

  constructor(context: PageDocxContext) {
    this.context = context;
  }

  private rel(type: string, target: string, external: boolean): string {
    this.relCount += 1;
    const id = `rId${this.relCount}`;
    this.rels.push({ id, type, target, external });
    return id;
  }

  /** Eén relatie per adres, ook als de link in stukken staat (deels vet). */
  hyperlink(href: string): string {
    let id = this.links.get(href);
    if (!id) { id = this.rel(`${REL}/hyperlink`, href, true); this.links.set(href, id); }
    return id;
  }

  /** Eén kopie per afbeelding, ook als hij twee keer op de pagina staat. */
  image(attachmentId: string, image: PageDocxImage, ext: string): string {
    let id = this.images.get(attachmentId);
    if (!id) {
      const path = `media/afbeelding${this.media.length + 1}.${ext}`;
      this.media.push({ path: `word/${path}`, bytes: image.bytes, contentType: image.contentType });
      id = this.rel(`${REL}/image`, path, false);
      this.images.set(attachmentId, id);
    }
    return id;
  }

  orderedList(): number {
    const numId = BULLETS + 1 + this.orderedLists.length;
    this.orderedLists.push(numId);
    return numId;
  }

  drawingId(): number {
    this.drawingCount += 1;
    return this.drawingCount;
  }
}

type TocEntry = { level: number; text: string };

type Ctx = {
  /** Inspringen vanaf de linkerkant van wat eromheen staat (pagina of cel), in twips. */
  indent: number;
  /** De breedte die hier nog over is, in twips. */
  width: number;
  listDepth: number;
  quote: boolean;
  /** In een kopcel: alles vet. */
  bold: boolean;
  align?: string;
  toc: TocEntry[];
};

type RunLook = { bold?: boolean; italic?: boolean; color?: string; style?: string };

function runProps(marks: Mark[] | undefined, look: RunLook): string {
  const has = new Set((marks ?? []).map(mark => mark.type));
  const code = has.has('code');
  // De volgorde van CT_RPr.
  let props = '';
  if (look.style) props += `<w:rStyle w:val="${look.style}"/>`;
  if (code) props += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
  if (look.bold || has.has('bold')) props += '<w:b/>';
  if (look.italic || has.has('italic')) props += '<w:i/>';
  if (has.has('strike')) props += '<w:strike/>';
  if (look.color) props += `<w:color w:val="${look.color}"/>`;
  if (has.has('highlight')) props += '<w:highlight w:val="yellow"/>';
  if (has.has('underline')) props += '<w:u w:val="single"/>';
  if (code) props += `<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/>`;
  return props ? `<w:rPr>${props}</w:rPr>` : '';
}

function run(text: string, marks?: Mark[], look: RunLook = {}): string {
  let body = '';
  text.split('\n').forEach((line, i) => {
    if (i > 0) body += '<w:br/>';
    line.split('\t').forEach((part, j) => {
      if (j > 0) body += '<w:tab/>';
      if (part) body += `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
    });
  });
  return `<w:r>${runProps(marks, look)}${body}</w:r>`;
}

type ParaLook = { style?: string; numId?: number; ilvl?: number; rule?: boolean; tab?: number; indent?: number; hanging?: number; align?: string };

function para(look: ParaLook, runs: string): string {
  // De volgorde van CT_PPrBase.
  let props = '';
  if (look.style) props += `<w:pStyle w:val="${look.style}"/>`;
  if (look.numId !== undefined) props += `<w:numPr><w:ilvl w:val="${look.ilvl ?? 0}"/><w:numId w:val="${look.numId}"/></w:numPr>`;
  if (look.rule) props += `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${BORDER}"/></w:pBdr>`;
  if (look.tab) props += `<w:tabs><w:tab w:val="left" w:pos="${look.tab}"/></w:tabs>`;
  if (look.indent) props += `<w:ind w:left="${look.indent}"${look.hanging ? ` w:hanging="${look.hanging}"` : ''}/>`;
  if (look.align) props += `<w:jc w:val="${look.align}"/>`;
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`;
}

/**
 * Het inspringen van een gewone alinea. Een citaat springt al in via zijn
 * stijl, maar een directe waarde wint van de stijl: daarom telt die het hier mee.
 */
function indentOf(ctx: Ctx): number | undefined {
  return ctx.indent > 0 ? ctx.indent + (ctx.quote ? 360 : 0) : undefined;
}

/** Een cel moet op een alinea eindigen, anders is het bestand ongeldig. */
function closeCell(xml: string): string {
  return xml.endsWith('</w:p>') ? xml : `${xml}<w:p/>`;
}

function whole(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function textOf(node: PmNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textOf).join('');
}

const headingLevel = (node: PmNode) => whole(node.attrs?.level, 1, 3);
const isInline = (node: PmNode) => node.type === 'text' || node.type === 'hardBreak';
const attrText = (node: PmNode, name: string) => (typeof node.attrs?.[name] === 'string' ? (node.attrs[name] as string).trim() : '');

function linkOf(node: PmNode): string | null {
  const href = node.marks?.find(mark => mark.type === 'link')?.attrs?.href;
  return typeof href === 'string' && LINK_PATTERN.test(href.trim()) ? href.trim() : null;
}

function inlineXml(nodes: PmNode[] | undefined, b: DocxBuilder, ctx: Ctx, look: RunLook = {}): string {
  const base = ctx.bold ? { ...look, bold: true } : look;
  let out = '';
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') { out += '<w:r><w:br/></w:r>'; continue; }
    const text = node.type === 'text' ? node.text ?? '' : textOf(node);
    if (!text) continue;
    const href = node.type === 'text' ? linkOf(node) : null;
    out += href
      ? `<w:hyperlink r:id="${b.hyperlink(href)}">${run(text, node.marks, { ...base, style: 'Hyperlink' })}</w:hyperlink>`
      : run(text, node.type === 'text' ? node.marks : undefined, base);
  }
  return out;
}

function blocksXml(nodes: PmNode[] | undefined, b: DocxBuilder, ctx: Ctx): string {
  return (nodes ?? []).map(node => blockXml(node, b, ctx)).join('');
}

function blockXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  switch (node.type) {
    case 'paragraph':
      return para({ style: ctx.quote ? 'Quote' : undefined, indent: indentOf(ctx), align: ctx.align }, inlineXml(node.content, b, ctx));
    case 'heading':
      return para({ style: `Heading${headingLevel(node)}`, indent: indentOf(ctx), align: ctx.align }, inlineXml(node.content, b, ctx));
    case 'blockquote':
      return blocksXml(node.content, b, { ...ctx, quote: true });
    case 'codeBlock':
      return para({ style: 'Code', indent: indentOf(ctx) }, run(textOf(node)));
    case 'horizontalRule':
      return para({ rule: true, indent: indentOf(ctx) }, '');
    case 'bulletList':
      return listXml(node, b, ctx, BULLETS);
    case 'orderedList':
      return listXml(node, b, ctx, b.orderedList());
    case 'taskList':
      return taskListXml(node, b, ctx);
    case 'table':
      return tableXml(node, b, ctx);
    case 'callout':
      return calloutXml(node, b, ctx);
    case 'details':
      return detailsXml(node, b, ctx);
    case 'columns':
      return columnsXml(node, b, ctx);
    case 'tableOfContents':
      return tocXml(ctx);
    case 'subpage': {
      const title = b.context.pageTitles?.[attrText(node, 'pageId')];
      const label = title === undefined ? 'Pagina niet gevonden' : title.trim() || 'Naamloze pagina';
      return para({ indent: indentOf(ctx), align: ctx.align }, run(`→ ${label}`, undefined, { bold: true }));
    }
    case 'fileBlock': {
      const name = b.context.fileNames?.[attrText(node, 'attachmentId')]?.trim();
      return para({ indent: indentOf(ctx), align: ctx.align }, run(`Bijlage: ${name || 'Bestand niet gevonden'}`, undefined, { italic: true }));
    }
    case 'image':
      return imageXml(node, b, ctx);
    default:
      // Onbekend of nieuw: de tekst gaat mee, de vorm niet.
      if (node.content?.some(isInline)) return para({ indent: indentOf(ctx), align: ctx.align }, inlineXml(node.content, b, ctx));
      if (node.content) return blocksXml(node.content, b, ctx);
      return node.text ? para({ indent: indentOf(ctx) }, run(node.text)) : '';
  }
}

function listXml(node: PmNode, b: DocxBuilder, ctx: Ctx, numId: number): string {
  const ilvl = Math.min(8, ctx.listDepth);
  const step = 720 * (ilvl + 1);
  // De nummering springt zelf in (numbering.xml). In een uitklapper of
  // lijstpunt moet de lijst verder naar rechts: dan een directe waarde, die
  // wint van de nummering.
  const shift = ctx.indent > 0 ? { indent: ctx.indent + step, hanging: 360 } : {};
  let out = '';
  for (const item of node.content ?? []) {
    (item.content ?? []).forEach((child, index) => {
      if (index === 0 && child.type === 'paragraph') {
        out += para({ style: ctx.quote ? 'Quote' : undefined, numId, ilvl, ...shift }, inlineXml(child.content, b, ctx));
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        out += listXml(child, b, { ...ctx, listDepth: ctx.listDepth + 1 }, child.type === 'orderedList' ? b.orderedList() : BULLETS);
      } else {
        // Een tweede alinea in hetzelfde punt: zonder teken, onder de tekst.
        out += blockXml(child, b, { ...ctx, indent: ctx.indent + step, width: ctx.width - step });
      }
    });
  }
  return out;
}

function taskListXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  const left = ctx.indent + 360 * (ctx.listDepth + 1);
  let out = '';
  for (const item of node.content ?? []) {
    const done = item.attrs?.checked === true;
    (item.content ?? []).forEach((child, index) => {
      if (index === 0 && child.type === 'paragraph') {
        // Het vakje hangt links, de tekst begint bij de tabstop.
        out += para({ tab: left, indent: left, hanging: 360 }, run(done ? '☒\t' : '☐\t') + inlineXml(child.content, b, ctx, done ? { color: MUTED } : {}));
      } else if (child.type === 'taskList') {
        out += taskListXml(child, b, { ...ctx, listDepth: ctx.listDepth + 1 });
      } else {
        out += blockXml(child, b, { ...ctx, indent: left, width: ctx.width - (left - ctx.indent) });
      }
    });
  }
  return out;
}

/** Kolombreedtes in twips. Zonder breedte: een gelijk deel van wat over is. Te breed: alles krimpt even hard. */
function fitWidths(widths: Array<number | null>, available: number): number[] {
  const known = widths.reduce<number>((sum, width) => sum + (width ?? 0), 0);
  const open = widths.filter(width => width === null).length;
  const share = open > 0 ? Math.max(720, (available - known) / open) : 0;
  const raw = widths.map(width => width ?? share);
  const total = raw.reduce((sum, width) => sum + width, 0);
  const factor = total > available ? available / total : 1;
  return raw.map(width => Math.max(1, Math.round(width * factor)));
}

const CELL_MARGINS = '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>'
  + '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>';

function tableBorders(value: string): string {
  return `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(side => `<w:${side} ${value}/>`).join('')}</w:tblBorders>`;
}

type Slot = { cell: PmNode; start: boolean; colspan: number; rowspan: number };

function tableXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  const rows = (node.content ?? []).filter(row => row.type === 'tableRow');
  if (rows.length === 0) return '';
  // Het raster: per rij en kolom de cel die daar staat. Een cel over meer
  // kolommen laat null achter in de kolommen erna; een cel over meer rijen
  // staat in de rijen eronder nog eens, als vervolg (vMerge).
  const grid: Array<Array<Slot | null | undefined>> = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row.content ?? []) {
      while (grid[r][c] !== undefined) c += 1;
      const colspan = whole(cell.attrs?.colspan, 1, MAX_COLUMNS);
      const rowspan = whole(cell.attrs?.rowspan, 1, rows.length - r);
      for (let dr = 0; dr < rowspan; dr += 1) {
        grid[r + dr][c] = { cell, start: dr === 0, colspan, rowspan };
        for (let dc = 1; dc < colspan; dc += 1) grid[r + dr][c + dc] = null;
      }
      c += colspan;
    }
  });
  const columns = Math.min(MAX_COLUMNS, Math.max(1, ...grid.map(row => row.length)));
  const wanted: Array<number | null> = Array.from({ length: columns }, () => null);
  grid.forEach(row => row.forEach((slot, c) => {
    if (!slot || c >= columns) return;
    const colwidth = Array.isArray(slot.cell.attrs?.colwidth) ? slot.cell.attrs.colwidth as unknown[] : [];
    for (let k = 0; k < slot.colspan && c + k < columns; k += 1) {
      const px = Number(colwidth[k]);
      if (wanted[c + k] === null && Number.isFinite(px) && px > 0) wanted[c + k] = px * TWIPS_PER_PX;
    }
  }));
  const widths = fitWidths(wanted, ctx.width);
  let out = '<w:tbl><w:tblPr>'
    + `<w:tblW w:w="${widths.reduce((sum, w) => sum + w, 0)}" w:type="dxa"/>`
    + (ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '')
    + tableBorders(`w:val="single" w:sz="4" w:space="0" w:color="${BORDER}"`)
    + `<w:tblLayout w:type="fixed"/>${CELL_MARGINS}</w:tblPr>`
    + `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  // Alleen de kopregels bovenaan herhalen op een nieuwe pagina.
  let headerRows = true;
  grid.forEach((slots, r) => {
    const cells = rows[r].content ?? [];
    headerRows = headerRows && cells.length > 0 && cells.every(cell => cell.type === 'tableHeader');
    out += `<w:tr>${headerRows ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
    for (let c = 0; c < columns; c += 1) {
      const slot = slots[c];
      if (slot === null) continue;
      if (slot === undefined) {
        out += `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
        continue;
      }
      const span = Math.min(slot.colspan, columns - c);
      const width = widths.slice(c, c + span).reduce((sum, w) => sum + w, 0);
      const header = slot.cell.type === 'tableHeader';
      const align = ALIGN[attrText(slot.cell, 'align')];
      const inner = slot.start
        ? blocksXml(slot.cell.content, b, { ...ctx, indent: 0, listDepth: 0, quote: false, bold: header, align, width: width - 200 })
        : '';
      out += `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`
        + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '')
        + (slot.rowspan > 1 ? `<w:vMerge${slot.start ? ' w:val="restart"' : ''}/>` : '')
        + (header ? `<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/>` : '')
        + `</w:tcPr>${closeCell(inner)}</w:tc>`;
    }
    out += '</w:tr>';
  });
  // Een lege alinea erna: twee tabellen direct achter elkaar worden in Word één tabel.
  return `${out}</w:tbl>${para({}, '')}`;
}

function calloutXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  const look = CALLOUTS[attrText(node, 'variant')] ?? CALLOUTS.info;
  const body = blocksXml(node.content, b, { ...ctx, indent: 0, listDepth: 0, quote: false, align: undefined, width: ctx.width - 400 });
  return '<w:tbl><w:tblPr>'
    + `<w:tblW w:w="${ctx.width}" w:type="dxa"/>`
    + (ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '')
    + `<w:tblBorders><w:left w:val="single" w:sz="24" w:space="0" w:color="${look.border}"/></w:tblBorders>`
    + '<w:tblLayout w:type="fixed"/>'
    + '<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="200" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="200" w:type="dxa"/></w:tblCellMar>'
    + `</w:tblPr><w:tblGrid><w:gridCol w:w="${ctx.width}"/></w:tblGrid>`
    + `<w:tr><w:tc><w:tcPr><w:tcW w:w="${ctx.width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${look.fill}"/></w:tcPr>`
    + `${closeCell(body)}</w:tc></w:tr></w:tbl>${para({}, '')}`;
}

function detailsXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  // Op papier klap je niets uit: de kopregel vet, de inhoud eronder, ingesprongen.
  const summary = node.content?.find(child => child.type === 'detailsSummary');
  const content = node.content?.find(child => child.type === 'detailsContent');
  return para({ indent: indentOf(ctx), align: ctx.align }, inlineXml(summary?.content, b, ctx, { bold: true }))
    + blocksXml(content?.content, b, { ...ctx, indent: ctx.indent + 360, width: ctx.width - 360 });
}

function columnsXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  const columns = (node.content ?? []).filter(child => child.type === 'column').slice(0, MAX_COLUMNS);
  if (columns.length === 0) return blocksXml(node.content, b, ctx);
  const width = Math.floor(ctx.width / columns.length);
  return '<w:tbl><w:tblPr>'
    + `<w:tblW w:w="${width * columns.length}" w:type="dxa"/>`
    + (ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '')
    + tableBorders('w:val="none" w:sz="0" w:space="0" w:color="auto"')
    + '<w:tblLayout w:type="fixed"/>'
    + '<w:tblCellMar><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>'
    + `</w:tblPr><w:tblGrid>${columns.map(() => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid><w:tr>`
    + columns.map(column => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>`
      + `${closeCell(blocksXml(column.content, b, { ...ctx, indent: 0, listDepth: 0, width: width - 240 }))}</w:tc>`).join('')
    + `</w:tr></w:tbl>${para({}, '')}`;
}

function tocXml(ctx: Ctx): string {
  if (ctx.toc.length === 0) return '';
  // Een veld over meer alinea's: het begin in de eerste, het einde in de laatste.
  const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const last = ctx.toc.length - 1;
  return para({ style: 'TOCHeading' }, run('Inhoud'))
    + ctx.toc.map((entry, i) => para({ style: `TOC${entry.level}` },
      `${i === 0 ? begin : ''}${run(entry.text || 'Kop zonder tekst')}${i === last ? end : ''}`)).join('');
}

function imageXml(node: PmNode, b: DocxBuilder, ctx: Ctx): string {
  const id = attrText(node, 'attachmentId');
  const alt = attrText(node, 'alt');
  const image = b.context.images?.[id];
  const ext = image ? IMAGE_EXT[image.contentType] : undefined;
  const given = image?.width && image.height && image.width > 0 && image.height > 0 ? { width: image.width, height: image.height } : null;
  const size = image && ext ? given ?? imageSize(image.bytes) : null;
  if (!image || !ext || !size) {
    return para({ indent: indentOf(ctx), align: ctx.align }, run(alt ? `[Afbeelding: ${alt}]` : '[Afbeelding]', undefined, { italic: true, color: MUTED }));
  }
  // Op ware grootte (96 dpi), maar nooit breder dan de tekst of hoger dan de pagina.
  const scale = Math.min(1,
    (ctx.width * EMU_PER_TWIP) / (size.width * EMU_PER_PX),
    ((TEXT_HEIGHT - 720) * EMU_PER_TWIP) / (size.height * EMU_PER_PX));
  const cx = Math.max(1, Math.round(size.width * EMU_PER_PX * scale));
  const cy = Math.max(1, Math.round(size.height * EMU_PER_PX * scale));
  const relId = b.image(id, image, ext);
  const docPr = b.drawingId();
  return para({ indent: indentOf(ctx), align: ctx.align }, '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPr}" name="Afbeelding ${docPr}" descr="${escapeXml(alt)}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
    + `<pic:nvPicPr><pic:cNvPr id="0" name="Afbeelding ${docPr}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>');
}

function collectHeadings(node: PmNode, out: TocEntry[]): void {
  // Zoals de inhoudsopgave in de app (pageEditorExtensions.ts): alle koppen,
  // ook die in een kader of uitklapper, in volgorde.
  if (node.type === 'heading') { out.push({ level: headingLevel(node), text: textOf(node).trim() }); return; }
  for (const child of node.content ?? []) collectHeadings(child, out);
}

// ── De vaste onderdelen ─────────────────────────────────────────────────────

/**
 * Versleutelen zoals ECMA-376 deel 1, 17.8.1 vraagt: de eerste 32 bytes XOR met
 * de bytes van de fontKey, van achter naar voren. Het is geen beveiliging, maar
 * Word en LibreOffice lezen een ingesloten letter alleen zo.
 */
function obfuscateFont(bytes: Uint8Array, key: string): Uint8Array {
  const hex = key.replace(/[{}-]/g, '');
  const guid = Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  const out = bytes.slice();
  for (let i = 0; i < Math.min(32, out.length); i += 1) out[i] ^= guid[15 - (i % 16)];
  return out;
}

/** Vaste sleutels: elke GUID is goed, en zo blijft de uitkomst van een export voorspelbaar. */
const FONT_KEYS = { Regular: '{5C1A9D2E-7B3F-4E8A-9C6D-1F2E3A4B5C6D}', Bold: '{6D2B0E3F-8C4A-4F9B-AD7E-2A3F4B5C6D7E}' } as const;

function stylesXml(fontFamily: string | null): string {
  const family = escapeXml(fontFamily ?? 'Calibri');
  const style = (id: string, name: string, pPr: string, rPr: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
    + `${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`;
  return `${XML_HEAD}<w:styles xmlns:w="${W_NS}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:eastAsia="${family}" w:cs="${family}"/>`
    + '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="nl-NL"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + style('Title', 'Title', '<w:spacing w:after="240"/>', '<w:b/><w:sz w:val="48"/><w:szCs w:val="48"/>')
    + style('Heading1', 'heading 1', '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>')
    + style('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/>')
    + style('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="26"/><w:szCs w:val="26"/>')
    + style('Quote', 'Quote', `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${BORDER}"/></w:pBdr><w:ind w:left="360"/>`, '<w:i/><w:color w:val="475569"/>')
    + style('Code', 'Code', `<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/>`,
      '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/>')
    + style('TOCHeading', 'TOC Heading', '<w:keepNext/><w:spacing w:before="120" w:after="60"/>', `<w:b/><w:caps/><w:color w:val="${MUTED}"/><w:sz w:val="18"/><w:szCs w:val="18"/>`)
    + style('TOC1', 'toc 1', '<w:spacing w:after="60"/>', '')
    + style('TOC2', 'toc 2', '<w:spacing w:after="60"/><w:ind w:left="360"/>', '')
    + style('TOC3', 'toc 3', '<w:spacing w:after="60"/><w:ind w:left="720"/>', '')
    + style('Footer', 'footer', '<w:spacing w:after="0"/>', `<w:color w:val="${MUTED}"/><w:sz w:val="18"/><w:szCs w:val="18"/>`)
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2563EB"/><w:u w:val="single"/></w:rPr></w:style>'
    + '</w:styles>';
}

function numberingXml(orderedLists: number[]): string {
  const levels = (format: 'bullet' | 'decimal') => Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>`
    + `<w:numFmt w:val="${format}"/><w:lvlText w:val="${format === 'bullet' ? ['•', '◦', '▪'][i % 3] : `%${i + 1}.`}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const restart = Array.from({ length: 9 }, (_, i) => `<w:lvlOverride w:ilvl="${i}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('');
  return `${XML_HEAD}<w:numbering xmlns:w="${W_NS}">`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('decimal')}</w:abstractNum>`
    + `<w:num w:numId="${BULLETS}"><w:abstractNumId w:val="0"/></w:num>`
    + orderedLists.map(numId => `<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/>${restart}</w:num>`).join('')
    + '</w:numbering>';
}

function footerXml(): string {
  // Paginanummers, zoals §9 vraagt. Kop en voet in de huisstijl komen met het exportvenster.
  const field = (instr: string) => `<w:fldSimple w:instr=" ${instr} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
  return `${XML_HEAD}<w:ftr xmlns:w="${W_NS}">`
    + `<w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>${run('Pagina ')}${field('PAGE')}${run(' van ')}${field('NUMPAGES')}</w:p>`
    + '</w:ftr>';
}

function settingsXml(embedsFonts: boolean): string {
  // De volgorde van CT_Settings: embedTrueTypeFonts staat vóór defaultTabStop.
  return `${XML_HEAD}<w:settings xmlns:w="${W_NS}">${embedsFonts ? '<w:embedTrueTypeFonts/>' : ''}<w:defaultTabStop w:val="720"/>`
    + '<w:characterSpacingControl w:val="doNotCompress"/>'
    // Zonder compatibilityMode 15 opent Word het bestand in compatibiliteitsmodus.
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + '</w:settings>';
}

// ── Samenvoegen ─────────────────────────────────────────────────────────────

export type PageDocxFile = { path: string; data: string | Uint8Array };

function asDoc(body: unknown): PmNode {
  let value = body;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as PmNode : { type: 'doc', content: [] };
}

/** De onderdelen van het Word-bestand, met hun plek in de zip. Los, zodat de tests de XML kunnen lezen. */
export function pageDocxFiles(title: string, body: unknown, context: PageDocxContext = {}): PageDocxFile[] {
  const b = new DocxBuilder(context);
  const doc = asDoc(body);
  const toc: TocEntry[] = [];
  collectHeadings(doc, toc);
  const name = title.trim() || 'Naamloze pagina';
  const ctx: Ctx = { indent: 0, width: TEXT_WIDTH, listDepth: 0, quote: false, bold: false, toc };
  // De letter van de huisstijl, met wat er van mee kan: normaal en vet.
  const fontFamily = context.font?.family.trim() || null;
  const embedded = fontFamily
    ? (['Regular', 'Bold'] as const)
      .filter(style => (style === 'Regular' ? context.font?.regular : context.font?.bold)?.length)
      .map((style, i) => ({ style, relId: `rId${i + 1}`, path: `fonts/font${i + 1}.odttf`, key: FONT_KEYS[style],
        bytes: (style === 'Regular' ? context.font?.regular : context.font?.bold) as Uint8Array }))
    : [];
  const content = para({ style: 'Title' }, run(name)) + blocksXml(doc.content, b, ctx);
  const documentXml = `${XML_HEAD}<w:document ${NS}><w:body>${content}`
    + '<w:sectPr><w:footerReference w:type="default" r:id="rId4"/>'
    + `<w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>`
    + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="709" w:footer="709" w:gutter="0"/>`
    + '</w:sectPr></w:body></w:document>';
  const rels = [
    { id: 'rId1', type: `${REL}/styles`, target: 'styles.xml', external: false },
    { id: 'rId2', type: `${REL}/numbering`, target: 'numbering.xml', external: false },
    { id: 'rId3', type: `${REL}/settings`, target: 'settings.xml', external: false },
    { id: 'rId4', type: `${REL}/footer`, target: 'footer1.xml', external: false },
    ...(embedded.length ? [{ id: 'rId5', type: `${REL}/fontTable`, target: 'fontTable.xml', external: false }] : []),
    ...b.rels,
  ];
  const relsXml = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + rels.map(rel => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';
  const used = new Set(b.media.map(item => item.contentType));
  const contentTypesXml = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + Object.entries(IMAGE_EXT).filter(([type]) => used.has(type)).map(([type, ext]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('')
    + (embedded.length ? '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>' : '')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    + (embedded.length ? '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>';
  const rootRelsXml = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '</Relationships>';
  // De titel ook in de eigenschappen: een PDF neemt hem daaruit over.
  const coreXml = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escapeXml(name)}</dc:title><dc:language>nl-NL</dc:language></cp:coreProperties>`;
  const fontFiles: PageDocxFile[] = embedded.length && fontFamily ? [
    { path: 'word/fontTable.xml', data: `${XML_HEAD}<w:fonts xmlns:w="${W_NS}" xmlns:r="${REL}"><w:font w:name="${escapeXml(fontFamily)}">`
      + embedded.map(font => `<w:embed${font.style} r:id="${font.relId}" w:fontKey="${font.key}"/>`).join('')
      + '</w:font></w:fonts>' },
    { path: 'word/_rels/fontTable.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + embedded.map(font => `<Relationship Id="${font.relId}" Type="${REL}/font" Target="${font.path}"/>`).join('')
      + '</Relationships>' },
    ...embedded.map(font => ({ path: `word/${font.path}`, data: obfuscateFont(font.bytes, font.key) })),
  ] : [];
  return [
    { path: '[Content_Types].xml', data: contentTypesXml },
    { path: '_rels/.rels', data: rootRelsXml },
    { path: 'docProps/core.xml', data: coreXml },
    { path: 'word/document.xml', data: documentXml },
    { path: 'word/_rels/document.xml.rels', data: relsXml },
    { path: 'word/styles.xml', data: stylesXml(fontFamily) },
    { path: 'word/numbering.xml', data: numberingXml(b.orderedLists) },
    { path: 'word/settings.xml', data: settingsXml(embedded.length > 0) },
    { path: 'word/footer1.xml', data: footerXml() },
    ...fontFiles,
    ...b.media.map(item => ({ path: item.path, data: item.bytes })),
  ];
}

/** Het Word-bestand van een pagina. */
export async function buildPageDocx(title: string, body: unknown, context: PageDocxContext = {}): Promise<Blob> {
  const zip = new ZipBuilder();
  for (const file of pageDocxFiles(title, body, context)) {
    // De XML en de letters comprimeren; afbeeldingen zijn dat al.
    await zip.add(file.path, file.data, { compress: typeof file.data === 'string' || file.path.endsWith('.odttf') });
  }
  return new Blob([zip.finish()], { type: DOCX_MIME });
}
