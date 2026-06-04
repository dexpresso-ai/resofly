import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { parseRichTextToBlocks, type DocBlock, type DocRun } from './richTextModel';

export interface DocumentExportMeta {
  title: string;
  categoryLabel: string;
  clientName?: string | null;
  projectName?: string | null;
  dateLabel: string;
  companyName?: string | null;
  content: string;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const NEAR_BLACK = rgb(0.1, 0.1, 0.1);
const BODY = rgb(0.16, 0.16, 0.16);
const MUTED = rgb(0.42, 0.42, 0.42);
const ACCENT = rgb(1, 0.85, 0.4);

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

export function documentFileBaseName(title: string): string {
  const base = (title || 'document').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return base || 'document';
}

/** pdf-lib's standard fonts use WinAnsi; drop glyphs they cannot encode so one emoji never breaks export. */
function normalizePdfText(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/€/g, 'EUR');
  return Array.from(normalized)
    .filter(char => {
      const code = char.charCodeAt(0);
      return code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255);
    })
    .join('');
}

// ── PDF ────────────────────────────────────────────────────────────────────

interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont }

function pickFont(f: Fonts, run: { bold?: boolean; italic?: boolean }): PDFFont {
  if (run.bold && run.italic) return f.boldItalic;
  if (run.bold) return f.bold;
  if (run.italic) return f.italic;
  return f.regular;
}

interface Seg { text: string; font: PDFFont; underline: boolean; width: number }

function layoutRuns(runs: DocRun[], fonts: Fonts, size: number, maxWidth: number): Seg[][] {
  const lines: Seg[][] = [];
  let cur: Seg[] = [];
  let curW = 0;
  const space = fonts.regular.widthOfTextAtSize(' ', size);
  const flush = () => { lines.push(cur); cur = []; curW = 0; };

  for (const run of runs) {
    const text = normalizePdfText(run.text);
    const parts = text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) flush();
      for (const word of part.split(/\s+/).filter(Boolean)) {
        const font = pickFont(fonts, run);
        const w = font.widthOfTextAtSize(word, size);
        if (curW > 0 && curW + space + w > maxWidth) flush();
        if (curW > 0) { cur.push({ text: ' ', font: fonts.regular, underline: false, width: space }); curW += space; }
        cur.push({ text: word, font, underline: Boolean(run.underline), width: w });
        curW += w;
      }
    });
  }
  flush();
  return lines.length ? lines : [[]];
}

interface RenderCtx {
  pdfDoc: PDFDocument;
  page: PDFPage;
  y: number;
}

function newPage(ctx: RenderCtx): void {
  ctx.page = ctx.pdfDoc.addPage(A4);
  ctx.y = A4[1] - MARGIN;
}

function ensureSpace(ctx: RenderCtx, needed: number): void {
  if (ctx.y - needed < MARGIN) newPage(ctx);
}

function drawParagraph(ctx: RenderCtx, runs: DocRun[], fonts: Fonts, opts: {
  size: number; color: RGB; x: number; maxWidth: number; lineHeight: number; spaceAfter: number; prefix?: { text: string; font: PDFFont }; barColor?: RGB;
}): void {
  const lines = layoutRuns(runs, fonts, opts.size, opts.maxWidth);
  lines.forEach((line, lineIndex) => {
    ensureSpace(ctx, opts.lineHeight);
    const y = ctx.y;
    if (opts.barColor) {
      ctx.page.drawRectangle({ x: opts.x - 12, y: y - 2, width: 3, height: opts.size + 2, color: opts.barColor });
    }
    let x = opts.x;
    if (lineIndex === 0 && opts.prefix && opts.prefix.text) {
      const ptext = normalizePdfText(opts.prefix.text);
      ctx.page.drawText(ptext, { x: x - opts.prefix.font.widthOfTextAtSize(ptext, opts.size), y, size: opts.size, font: opts.prefix.font, color: opts.color });
    }
    for (const seg of line) {
      if (seg.text) ctx.page.drawText(seg.text, { x, y, size: opts.size, font: seg.font, color: opts.color });
      if (seg.underline && seg.text.trim()) {
        ctx.page.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + seg.width, y: y - 1.5 }, thickness: 0.5, color: opts.color });
      }
      x += seg.width;
    }
    ctx.y -= opts.lineHeight;
  });
  ctx.y -= opts.spaceAfter;
}

function listPrefix(block: DocBlock, counters: number[]): string {
  if (block.type === 'bullet') return '-  ';
  if (block.type === 'task') return block.checked ? '[x]  ' : '[ ]  ';
  if (block.type === 'ordered') return `${counters[block.depth] ?? 1}.  `;
  return '';
}

export async function buildDocumentPdfBlob(meta: DocumentExportMeta): Promise<Blob> {
  const pdfDoc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const ctx: RenderCtx = { pdfDoc, page: pdfDoc.addPage(A4), y: A4[1] - MARGIN };
  const contentWidth = A4[0] - MARGIN * 2;

  // Header
  drawParagraph(ctx, [{ text: meta.title, bold: true }], fonts, { size: 20, color: NEAR_BLACK, x: MARGIN, maxWidth: contentWidth, lineHeight: 24, spaceAfter: 6 });
  const metaBits = [meta.categoryLabel, meta.clientName ? `Klant: ${meta.clientName}` : '', meta.projectName ? `Project: ${meta.projectName}` : '', meta.dateLabel].filter(Boolean).join('   •   ');
  drawParagraph(ctx, [{ text: metaBits }], fonts, { size: 9, color: MUTED, x: MARGIN, maxWidth: contentWidth, lineHeight: 12, spaceAfter: 8 });
  ensureSpace(ctx, 8);
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y }, end: { x: A4[0] - MARGIN, y: ctx.y }, thickness: 1, color: ACCENT });
  ctx.y -= 18;

  const blocks = parseRichTextToBlocks(meta.content);
  const counters: number[] = [];
  let prevWasOrdered = false;
  let prevDepth = -1;

  if (blocks.length === 0) {
    drawParagraph(ctx, [{ text: 'Dit document heeft nog geen inhoud.' }], fonts, { size: 10.5, color: MUTED, x: MARGIN, maxWidth: contentWidth, lineHeight: 15, spaceAfter: 4 });
  }

  for (const block of blocks) {
    if (block.type === 'ordered') {
      if (!prevWasOrdered || prevDepth !== block.depth) counters[block.depth] = 0;
      counters[block.depth] = (counters[block.depth] ?? 0) + 1;
      counters.length = block.depth + 1;
    }
    prevWasOrdered = block.type === 'ordered';
    prevDepth = block.depth;

    const indent = MARGIN + block.depth * 18;
    if (block.type === 'h1') {
      drawParagraph(ctx, block.runs, fonts, { size: 15, color: NEAR_BLACK, x: MARGIN, maxWidth: contentWidth, lineHeight: 19, spaceAfter: 6 });
    } else if (block.type === 'h2') {
      drawParagraph(ctx, block.runs.map(r => ({ ...r, bold: true })), fonts, { size: 12.5, color: NEAR_BLACK, x: MARGIN, maxWidth: contentWidth, lineHeight: 16, spaceAfter: 5 });
    } else if (block.type === 'h3') {
      drawParagraph(ctx, block.runs.map(r => ({ ...r, bold: true })), fonts, { size: 11, color: NEAR_BLACK, x: MARGIN, maxWidth: contentWidth, lineHeight: 14, spaceAfter: 4 });
    } else if (block.type === 'quote') {
      drawParagraph(ctx, block.runs.map(r => ({ ...r, italic: true })), fonts, { size: 10.5, color: MUTED, x: MARGIN + 16, maxWidth: contentWidth - 16, lineHeight: 15, spaceAfter: 6, barColor: ACCENT });
    } else if (block.type === 'bullet' || block.type === 'ordered' || block.type === 'task') {
      const prefix = listPrefix(block, counters);
      const textX = indent + 18;
      drawParagraph(ctx, block.runs, fonts, { size: 10.5, color: BODY, x: textX, maxWidth: A4[0] - MARGIN - textX, lineHeight: 15, spaceAfter: 3, prefix: { text: prefix, font: fonts.regular } });
    } else {
      drawParagraph(ctx, block.runs, fonts, { size: 10.5, color: BODY, x: MARGIN, maxWidth: contentWidth, lineHeight: 15, spaceAfter: 6 });
    }
  }

  const bytes = await pdfDoc.save();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/pdf' });
}

// ── DOCX (OOXML + dependency-free store-only ZIP) ───────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runXml(run: DocRun, opts: { bold?: boolean; size?: number } = {}): string {
  const props: string[] = [];
  if (run.bold || opts.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.underline) props.push('<w:u w:val="single"/>');
  if (opts.size) props.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const pieces = run.text.split('\n');
  const body = pieces
    .map(piece => `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`)
    .join('<w:br/>');
  return `<w:r>${rPr}${body}</w:r>`;
}

function paragraphXml(runsXml: string, opts: { indent?: number; before?: number; after?: number; quote?: boolean } = {}): string {
  const pPr: string[] = [];
  const spacingBefore = opts.before ?? 0;
  const spacingAfter = opts.after ?? 120;
  pPr.push(`<w:spacing w:before="${spacingBefore}" w:after="${spacingAfter}"/>`);
  if (opts.indent) pPr.push(`<w:ind w:left="${opts.indent}" w:hanging="360"/>`);
  if (opts.quote) pPr.push('<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="E0B84D"/></w:pBdr>');
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${runsXml}</w:p>`;
}

function blocksToDocxBody(blocks: DocBlock[]): string {
  const counters: number[] = [];
  let prevWasOrdered = false;
  let prevDepth = -1;
  const paras: string[] = [];

  for (const block of blocks) {
    if (block.type === 'ordered') {
      if (!prevWasOrdered || prevDepth !== block.depth) counters[block.depth] = 0;
      counters[block.depth] = (counters[block.depth] ?? 0) + 1;
      counters.length = block.depth + 1;
    }
    prevWasOrdered = block.type === 'ordered';
    prevDepth = block.depth;

    if (block.type === 'h1') {
      paras.push(paragraphXml(block.runs.map(r => runXml(r, { bold: true, size: 32 })).join(''), { before: 160, after: 80 }));
    } else if (block.type === 'h2') {
      paras.push(paragraphXml(block.runs.map(r => runXml(r, { bold: true, size: 26 })).join(''), { before: 140, after: 60 }));
    } else if (block.type === 'h3') {
      paras.push(paragraphXml(block.runs.map(r => runXml(r, { bold: true, size: 23 })).join(''), { before: 120, after: 60 }));
    } else if (block.type === 'quote') {
      paras.push(paragraphXml(block.runs.map(r => runXml({ ...r, italic: true }, { size: 21 })).join(''), { quote: true, after: 120 }));
    } else if (block.type === 'bullet' || block.type === 'ordered' || block.type === 'task') {
      const prefix = block.type === 'bullet' ? '• ' : block.type === 'task' ? (block.checked ? '☑ ' : '☐ ') : `${counters[block.depth] ?? 1}. `;
      const prefixRun = runXml({ text: prefix }, { size: 21 });
      const body = block.runs.map(r => runXml(r, { size: 21 })).join('');
      paras.push(paragraphXml(prefixRun + body, { indent: 360 * (block.depth + 1), after: 40 }));
    } else {
      const body = block.runs.length ? block.runs.map(r => runXml(r, { size: 21 })).join('') : runXml({ text: '' }, { size: 21 });
      paras.push(paragraphXml(body, { after: 120 }));
    }
  }
  return paras.join('');
}

function buildDocumentXml(meta: DocumentExportMeta): string {
  const blocks = parseRichTextToBlocks(meta.content);
  const header: string[] = [];
  header.push(paragraphXml(runXml({ text: meta.title, bold: true }, { size: 40 }), { after: 60 }));
  const metaBits = [meta.categoryLabel, meta.clientName ? `Klant: ${meta.clientName}` : '', meta.projectName ? `Project: ${meta.projectName}` : '', meta.dateLabel].filter(Boolean).join('   •   ');
  header.push(paragraphXml(runXml({ text: metaBits, italic: true }, { size: 18 }), { after: 200 }));
  const body = blocks.length ? blocksToDocxBody(blocks) : paragraphXml(runXml({ text: 'Dit document heeft nog geen inhoud.', italic: true }, { size: 21 }));
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${header.join('')}${body}${sectPr}</w:body></w:document>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const DOC_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array }

function buildZip(entries: ZipEntry[]): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  const u16 = (arr: number[], v: number) => arr.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (arr: number[], v: number) => arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const enc = new TextEncoder();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localStart = out.length;
    u32(out, 0x04034b50);
    u16(out, 20); u16(out, 0); u16(out, 0); // version, flags, method=store
    u16(out, 0); u16(out, 0);               // mod time, date
    u32(out, crc); u32(out, size); u32(out, size);
    u16(out, nameBytes.length); u16(out, 0);
    for (const b of nameBytes) out.push(b);
    for (const b of entry.data) out.push(b);

    u32(central, 0x02014b50);
    u16(central, 20); u16(central, 20); u16(central, 0); u16(central, 0);
    u16(central, 0); u16(central, 0);
    u32(central, crc); u32(central, size); u32(central, size);
    u16(central, nameBytes.length); u16(central, 0); u16(central, 0);
    u16(central, 0); u16(central, 0); u32(central, 0);
    u32(central, offset);
    for (const b of nameBytes) central.push(b);

    offset += out.length - localStart;
  }

  const centralStart = out.length;
  for (const b of central) out.push(b);
  u32(out, 0x06054b50);
  u16(out, 0); u16(out, 0);
  u16(out, entries.length); u16(out, entries.length);
  u32(out, central.length); u32(out, centralStart);
  u16(out, 0);

  return new Uint8Array(out);
}

export function buildDocumentDocxBlob(meta: DocumentExportMeta): Blob {
  const enc = new TextEncoder();
  const zip = buildZip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS_XML) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(DOC_RELS_XML) },
    { name: 'word/document.xml', data: enc.encode(buildDocumentXml(meta)) },
  ]);
  const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
