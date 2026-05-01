import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import type { Client, CompanySettings, Invoice, Quote } from '../types';
import { dateNL, total } from './format';

const A4: [number, number] = [595.28, 841.89];
const DEFAULT_TEXT = '#1a1a1a';
const DEFAULT_ACCENT = '#FFD966';

function fmtMoney(amount: number): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(amount).replace('€', 'EUR');
}

function downloadBlob(blob: Blob, filename: string): void {
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

interface PdfOptions {
  company?: CompanySettings | null;
  brandName?: string;
  brandTagline?: string;
}

interface PreparedTemplate {
  sourcePdf?: PDFDocument;
  sourcePageIndex: number;
  image?: PDFImage;
  pageSize: [number, number];
}

interface DrawContext {
  regular: PDFFont;
  bold: PDFFont;
  textColor: RGB;
  mutedColor: RGB;
  accentColor: RGB;
}

function normalizePdfText(value: string): string {
  // pdf-lib standard Helvetica uses WinAnsi encoding. Normalize common Unicode
  // punctuation and drop unsupported glyphs so one emoji or smart symbol never
  // breaks the complete PDF export.
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/€/g, 'EUR');

  return Array.from(normalized)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 10 || code === 13 || code === 9 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255);
    })
    .join('');
}

function clean(value: unknown): string {
  return normalizePdfText(String(value ?? '')).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function hasText(value: unknown): boolean {
  return clean(value).length > 0;
}

function hexToRgb(value: string | null | undefined, fallback: string): RGB {
  const source = (value || fallback).trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(source);
  const hex = match ? match[1] : fallback.replace('#', '');
  const int = Number.parseInt(hex, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error('Factuurtemplate heeft geen geldig data-url formaat.');
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, mimeType };
}

async function prepareTemplate(pdfDoc: PDFDocument, company?: CompanySettings | null): Promise<PreparedTemplate | null> {
  if (!company?.invoice_template_data_url || company.invoice_template_kind === 'none') return null;

  try {
    const { bytes, mimeType } = dataUrlToBytes(company.invoice_template_data_url);
    if (company.invoice_template_kind === 'pdf' || mimeType === 'application/pdf') {
      const sourcePdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const page = sourcePdf.getPage(0);
      const size = page.getSize();
      return { sourcePdf, sourcePageIndex: 0, pageSize: [size.width, size.height] };
    }

    const resolvedMime = company.invoice_template_mime_type || mimeType;
    const image = /jpe?g/i.test(resolvedMime) ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
    return { image, sourcePageIndex: 0, pageSize: A4 };
  } catch (error) {
    console.warn('Factuurtemplate kon niet worden gebruikt. Er wordt teruggevallen op de standaard layout.', error);
    return null;
  }
}

function drawImageCover(page: PDFPage, image: PDFImage): void {
  const { width, height } = page.getSize();
  const imageRatio = image.width / image.height;
  const pageRatio = width / height;
  const drawWidth = imageRatio > pageRatio ? height * imageRatio : width;
  const drawHeight = imageRatio > pageRatio ? height : width / imageRatio;
  page.drawImage(image, {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  });
}

async function addPage(pdfDoc: PDFDocument, template: PreparedTemplate | null): Promise<PDFPage> {
  if (template?.sourcePdf) {
    const [copied] = await pdfDoc.copyPages(template.sourcePdf, [template.sourcePageIndex]);
    pdfDoc.addPage(copied);
    return copied;
  }

  const page = pdfDoc.addPage(template?.pageSize ?? A4);
  if (template?.image) drawImageCover(page, template.image);
  return page;
}

function drawText(page: PDFPage, text: string, x: number, y: number, ctx: DrawContext, opts: { size?: number; bold?: boolean; color?: RGB; align?: 'left' | 'right' } = {}) {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.regular;
  const safe = clean(text);
  if (!safe) return;
  const width = font.widthOfTextAtSize(safe, size);
  const drawX = opts.align === 'right' ? x - width : x;
  page.drawText(safe, { x: drawX, y, size, font, color: opts.color ?? ctx.textColor });
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const source = clean(text);
  if (!source) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of source.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    let chunk = '';
    for (const char of word) {
      const next = `${chunk}${char}`;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) chunk = next;
      else {
        if (chunk) lines.push(chunk);
        chunk = char;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function drawWrappedText(page: PDFPage, text: string, x: number, y: number, maxWidth: number, ctx: DrawContext, opts: { size?: number; bold?: boolean; lineHeight?: number; color?: RGB } = {}): number {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.regular;
  const lineHeight = opts.lineHeight ?? size + 4;
  const lines = wrapText(text, font, size, maxWidth);
  let cursorY = y;
  for (const line of lines) {
    drawText(page, line, x, cursorY, ctx, { size, bold: opts.bold, color: opts.color });
    cursorY -= lineHeight;
  }
  return cursorY;
}

function drawSectionLabel(page: PDFPage, label: string, x: number, y: number, ctx: DrawContext) {
  drawText(page, label.toUpperCase(), x, y, ctx, { size: 8, bold: true, color: ctx.mutedColor });
  page.drawLine({ start: { x, y: y - 5 }, end: { x: x + 180, y: y - 5 }, thickness: 0.6, color: ctx.accentColor });
}

function companyDisplayName(company?: CompanySettings | null, opts?: PdfOptions): string {
  return clean(company?.company_name) || clean(company?.trade_name) || opts?.brandName || 'BrandCore';
}

function companyLines(company?: CompanySettings | null, opts?: PdfOptions): string[] {
  const fallbackName = opts?.brandName ?? 'BrandCore';
  if (!company) return [fallbackName, opts?.brandTagline ?? 'Werkruimte'];

  const cityLine = [company.postal_code, company.city].filter(hasText).map(clean).join(' ');
  return [
    companyDisplayName(company, opts),
    company.trade_name && clean(company.trade_name) !== clean(company.company_name) ? company.trade_name : '',
    company.address_line1,
    company.address_line2,
    cityLine,
    company.country,
    company.email ? `E-mail: ${company.email}` : '',
    company.phone ? `Tel: ${company.phone}` : '',
    company.website ? `Web: ${company.website}` : '',
  ].filter(hasText).map(clean);
}

function companyLegalLines(company?: CompanySettings | null): string[] {
  if (!company) return [];
  return [
    company.kvk_number ? `KvK: ${company.kvk_number}` : '',
    company.vat_number ? `BTW: ${company.vat_number}` : '',
    company.iban ? `IBAN: ${company.iban}` : '',
  ].filter(hasText).map(clean);
}

function clientLines(client: Client | null): string[] {
  return [
    client?.name ?? 'Geen klant',
    client?.contact_name ? `T.a.v. ${client.contact_name}` : '',
    client?.email ? `E-mail: ${client.email}` : '',
    client?.phone ? `Tel: ${client.phone}` : '',
  ].filter(hasText).map(clean);
}

function drawDocumentHeader(page: PDFPage, doc: Quote | Invoice, kind: 'quote' | 'invoice', client: Client | null, ctx: DrawContext, opts: PdfOptions, hasTemplate: boolean) {
  const { width, height } = page.getSize();
  const marginX = 48;
  const isQuote = kind === 'quote';
  const title = isQuote ? 'OFFERTE' : 'FACTUUR';
  const secondDateLabel = isQuote ? 'Geldig tot' : 'Vervaldatum';
  const secondDateValue = isQuote ? (doc as Quote).valid_until : (doc as Invoice).due_date;

  if (!hasTemplate) {
    page.drawRectangle({ x: 0, y: height - 18, width, height: 18, color: ctx.accentColor, opacity: 0.9 });
  }

  drawWrappedText(page, companyDisplayName(opts.company, opts), marginX, height - 58, 260, ctx, { size: 16, bold: true, lineHeight: 18 });
  let y = height - 86;
  for (const line of companyLines(opts.company, opts).slice(1, 8)) {
    drawText(page, line, marginX, y, ctx, { size: 9, color: ctx.mutedColor });
    y -= 12;
  }

  drawText(page, title, width - marginX, height - 62, ctx, { size: 25, bold: true, align: 'right' });
  drawText(page, `${isQuote ? 'Offertenummer' : 'Factuurnummer'}: ${doc.number || '-'}`, width - marginX, height - 94, ctx, { size: 10, bold: true, align: 'right' });
  drawText(page, `Datum: ${dateNL(doc.date)}`, width - marginX, height - 110, ctx, { size: 9, align: 'right', color: ctx.mutedColor });
  drawText(page, `${secondDateLabel}: ${dateNL(secondDateValue)}`, width - marginX, height - 124, ctx, { size: 9, align: 'right', color: ctx.mutedColor });

  const blockY = height - 190;
  drawSectionLabel(page, 'Factuur aan', marginX, blockY, ctx);
  y = blockY - 24;
  for (const line of clientLines(client)) {
    drawText(page, line, marginX, y, ctx, { size: 10, bold: y === blockY - 24 });
    y -= 14;
  }

  const legal = companyLegalLines(opts.company);
  if (legal.length) {
    drawSectionLabel(page, 'Bedrijfsgegevens', width - 235, blockY, ctx);
    y = blockY - 24;
    for (const line of legal) {
      drawText(page, line, width - 235, y, ctx, { size: 9, color: ctx.mutedColor });
      y -= 13;
    }
  }
}

function drawTableHeader(page: PDFPage, y: number, ctx: DrawContext) {
  const x = 48;
  page.drawRectangle({ x, y: y - 8, width: 500, height: 24, color: ctx.accentColor, opacity: 0.18 });
  drawText(page, 'Omschrijving', x + 8, y, ctx, { size: 8, bold: true, color: ctx.mutedColor });
  drawText(page, 'Aantal', x + 302, y, ctx, { size: 8, bold: true, color: ctx.mutedColor });
  drawText(page, 'Prijs', x + 362, y, ctx, { size: 8, bold: true, color: ctx.mutedColor });
  drawText(page, 'BTW', x + 428, y, ctx, { size: 8, bold: true, color: ctx.mutedColor });
  drawText(page, 'Totaal', x + 500, y, ctx, { size: 8, bold: true, color: ctx.mutedColor, align: 'right' });
}

function drawFooter(page: PDFPage, ctx: DrawContext, company?: CompanySettings | null) {
  const { width } = page.getSize();
  const footer = clean(company?.invoice_footer) || 'Bedankt voor het vertrouwen.';
  const payment = clean(company?.invoice_payment_terms);
  page.drawLine({ start: { x: 48, y: 58 }, end: { x: width - 48, y: 58 }, thickness: 0.5, color: ctx.mutedColor, opacity: 0.35 });
  drawWrappedText(page, payment || footer, 48, 42, width - 96, ctx, { size: 8, lineHeight: 10, color: ctx.mutedColor });
}

export async function createFinancePDFBlob(doc: Quote | Invoice, kind: 'quote' | 'invoice', client: Client | null, opts: PdfOptions = {}): Promise<Blob> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const template = await prepareTemplate(pdfDoc, opts.company);
  const ctx: DrawContext = {
    regular,
    bold,
    textColor: hexToRgb(opts.company?.invoice_template_text_color, DEFAULT_TEXT),
    mutedColor: rgb(0.38, 0.38, 0.38),
    accentColor: hexToRgb(opts.company?.invoice_accent_color, DEFAULT_ACCENT),
  };

  let page = await addPage(pdfDoc, template);
  drawDocumentHeader(page, doc, kind, client, ctx, opts, Boolean(template));

  let cursorY = page.getHeight() - 300;
  drawTableHeader(page, cursorY, ctx);
  cursorY -= 28;

  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  for (const line of lines) {
    const descLines = wrapText(line.description || '-', regular, 9, 270);
    const rowHeight = Math.max(24, descLines.length * 12 + 10);
    if (cursorY - rowHeight < 132) {
      drawFooter(page, ctx, opts.company);
      page = await addPage(pdfDoc, template);
      cursorY = page.getHeight() - 76;
      drawTableHeader(page, cursorY, ctx);
      cursorY -= 28;
    }

    const lineNet = Number(line.quantity || 0) * Number(line.unit_price || 0);
    const lineGross = lineNet * (1 + Number(line.vat || 0) / 100);
    const x = 48;
    page.drawLine({ start: { x, y: cursorY + 7 }, end: { x: x + 500, y: cursorY + 7 }, thickness: 0.4, color: ctx.mutedColor, opacity: 0.25 });
    let descY = cursorY;
    for (const descLine of descLines) {
      drawText(page, descLine, x + 8, descY, ctx, { size: 9 });
      descY -= 12;
    }
    drawText(page, String(line.quantity ?? 0), x + 322, cursorY, ctx, { size: 9, align: 'right' });
    drawText(page, fmtMoney(Number(line.unit_price || 0)), x + 405, cursorY, ctx, { size: 9, align: 'right' });
    drawText(page, `${line.vat ?? 0}%`, x + 449, cursorY, ctx, { size: 9, align: 'right' });
    drawText(page, fmtMoney(lineGross), x + 500, cursorY, ctx, { size: 9, bold: true, align: 'right' });
    cursorY -= rowHeight;
  }

  const totals = total(lines);
  if (cursorY < 230) {
    drawFooter(page, ctx, opts.company);
    page = await addPage(pdfDoc, template);
    cursorY = page.getHeight() - 86;
  }

  const totalX = page.getWidth() - 248;
  page.drawLine({ start: { x: totalX, y: cursorY + 10 }, end: { x: page.getWidth() - 48, y: cursorY + 10 }, thickness: 0.8, color: ctx.accentColor });
  const summaryRows: Array<[string, string, boolean]> = [
    ['Subtotaal', fmtMoney(totals.subtotal), false],
    ['BTW', fmtMoney(totals.vat), false],
    ['Totaal', fmtMoney(totals.total), true],
  ];
  for (const [label, value, isBold] of summaryRows) {
    drawText(page, label, totalX, cursorY, ctx, { size: isBold ? 12 : 9, bold: isBold });
    drawText(page, value, page.getWidth() - 48, cursorY, ctx, { size: isBold ? 12 : 9, bold: isBold, align: 'right' });
    cursorY -= isBold ? 20 : 16;
  }

  if (doc.notes) {
    cursorY -= 8;
    drawSectionLabel(page, 'Notities', 48, cursorY, ctx);
    drawWrappedText(page, doc.notes, 48, cursorY - 24, 300, ctx, { size: 9, lineHeight: 12, color: ctx.mutedColor });
  }

  drawFooter(page, ctx, opts.company);
  const bytes = await pdfDoc.save();
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([arrayBuffer], { type: 'application/pdf' });
}

export async function exportFinancePDF(
  doc: Quote | Invoice,
  kind: 'quote' | 'invoice',
  client: Client | null,
  opts: PdfOptions = {},
): Promise<void> {
  const isQuote = kind === 'quote';
  const filename = `${isQuote ? 'offerte' : 'factuur'}-${(doc.number || 'concept').replace(/[^a-z0-9_-]+/gi, '-')}.pdf`;
  const blob = await createFinancePDFBlob(doc, kind, client, opts);
  downloadBlob(blob, filename);
}
