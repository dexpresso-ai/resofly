// ============================================================
// Gedeelde contract-PDF generator (concept én getekend exemplaar).
//
// Eén bron van waarheid zodat het concept dat de klant ter ondertekening krijgt
// en het uiteindelijke getekende exemplaar identiek ogen. Bij een meegegeven
// `signature` wordt een handtekeningblok + een apart ondertekenbewijs
// (certificaat) toegevoegd; anders toont de PDF de beveiligde ondertekenlink.
//
// pdf-lib tekent alleen platte tekst, dus rich-text body wordt naar nette
// paragrafen geconverteerd. De pagina-engine breekt netjes af en nummert achteraf
// elke pagina ("Pagina x van y").
// ============================================================

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'https://esm.sh/pdf-lib@1.17.1';

export type PdfContract = {
  id?: string;
  number: string;
  title: string;
  body: string;
  date: string;
  valid_until: string | null;
};

export type PdfClient = {
  name: string;
  contact_name: string | null;
  email: string | null;
};

export type PdfCompany = {
  company_name?: string | null;
  trade_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  invoice_footer?: string | null;
  invoice_accent_color?: string | null;
} | null;

export type PdfSignature = {
  signerName: string;
  signerEmail: string;
  signedAt: string; // ISO timestamp
  method: 'typed' | 'drawn';
  signatureImage?: string | null; // data:image/png;base64,... (drawn)
  ip?: string | null;
  userAgent?: string | null;
  consentText?: string | null;
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 48;
const RIGHT = 547;
const CONTENT_W = RIGHT - LEFT; // 499
const TOP = 790;
const BOTTOM = 70;

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  accent: RGB;
  muted: RGB;
};

export async function renderContractPdf(params: {
  contract: PdfContract;
  client: PdfClient;
  company: PdfCompany;
  publicUrl?: string | null;
  signature?: PdfSignature | null;
}): Promise<Uint8Array> {
  const { contract, client, company, publicUrl, signature } = params;
  const doc = await PDFDocument.create();
  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: TOP,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    accent: hexToPdfRgb(company?.invoice_accent_color || '#FFD966'),
    muted: rgb(0.38, 0.38, 0.38),
  };

  drawHeader(ctx, contract, company);
  drawParties(ctx, client);

  if (contract.title) {
    ensureSpace(ctx, 26);
    ctx.y = drawWrapped(ctx, contract.title, LEFT, ctx.y, CONTENT_W, ctx.bold, 14, 18);
    ctx.y -= 10;
  }

  for (const block of htmlToBlocks(contract.body)) {
    if (!block.text.trim()) continue;
    ensureSpace(ctx, 18);
    switch (block.type) {
      case 'h2':
        ctx.y -= 4;
        ctx.y = drawWrapped(ctx, block.text, LEFT, ctx.y, CONTENT_W, ctx.bold, 15, 19);
        ctx.y -= 6;
        break;
      case 'h3':
        ctx.y -= 2;
        ctx.y = drawWrapped(ctx, block.text, LEFT, ctx.y, CONTENT_W, ctx.bold, 12, 16);
        ctx.y -= 5;
        break;
      case 'h4':
        ctx.y = drawWrapped(ctx, block.text, LEFT, ctx.y, CONTENT_W, ctx.bold, 11, 15);
        ctx.y -= 4;
        break;
      case 'li':
        ctx.y = drawWrapped(ctx, block.text, LEFT + 14, ctx.y, CONTENT_W - 14, ctx.regular, 10, 14);
        ctx.y -= 3;
        break;
      case 'quote':
        ctx.y = drawWrapped(ctx, block.text, LEFT + 12, ctx.y, CONTENT_W - 12, ctx.italic, 10, 14, ctx.muted);
        ctx.y -= 5;
        break;
      default:
        ctx.y = drawWrapped(ctx, block.text, LEFT, ctx.y, CONTENT_W, ctx.regular, 10, 14);
        ctx.y -= 6;
    }
  }

  if (signature) {
    await drawSignatureBlock(ctx, signature);
  } else if (publicUrl) {
    ensureSpace(ctx, 50);
    ctx.y -= 18;
    drawText(ctx.page, 'Onderteken dit contract online via de beveiligde link:', LEFT, ctx.y, ctx.bold, 9, { color: ctx.muted });
    ctx.y -= 13;
    drawWrapped(ctx, publicUrl, LEFT, ctx.y, CONTENT_W, ctx.regular, 8, 11, ctx.muted);
  }

  if (signature) {
    drawCertificatePage(ctx, contract, client, company, signature);
  }

  paintFootersAndPageNumbers(ctx, company);

  return await doc.save();
}

/**
 * Zet het handtekeningblok + ondertekenbewijs ACHTER een bestaand PDF.
 *
 * Voor contracten die in Word (Collabora) zijn opgesteld is de PDF al gemaakt —
 * door Collabora, uit het .docx dat de klant ook echt te zien kreeg. Die pagina's
 * mogen we niet opnieuw opbouwen (dan zouden opmaak, tabellen en afbeeldingen
 * door onze eenvoudige HTML-parser heen moeten), dus laten we het bronbestand
 * ongemoeid en hangen we er alleen onze eigen pagina's achter.
 *
 * Voettekst en paginanummering worden bewust alléén op de toegevoegde pagina's
 * gezet: over het Word-document heen stempelen zou de opmaak van de klant
 * beschadigen.
 */
export async function appendSignaturePagesToPdf(params: {
  basePdf: Uint8Array;
  contract: PdfContract;
  client: PdfClient;
  company: PdfCompany;
  signature: PdfSignature;
}): Promise<Uint8Array> {
  const { basePdf, contract, client, company, signature } = params;
  const doc = await PDFDocument.load(basePdf);
  const untouchedPages = doc.getPageCount();

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: TOP,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    accent: hexToPdfRgb(company?.invoice_accent_color || '#FFD966'),
    muted: rgb(0.38, 0.38, 0.38),
  };

  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 18, width: PAGE_W, height: 18, color: ctx.accent, opacity: 0.85 });
  drawText(ctx.page, 'ONDERTEKENING', LEFT, ctx.y, ctx.bold, 20);
  ctx.y -= 18;
  drawText(
    ctx.page,
    `Behorend bij contract ${contract.number}${contract.title ? ` — ${contract.title}` : ''}`,
    LEFT, ctx.y, ctx.regular, 9, { color: ctx.muted },
  );
  ctx.y -= 20;

  await drawSignatureBlock(ctx, signature);
  drawCertificatePage(ctx, contract, client, company, signature);

  paintFootersAndPageNumbers(ctx, company, untouchedPages);
  return await doc.save();
}

// ------------------------------------------------------------ sections
function drawHeader(ctx: Ctx, contract: PdfContract, company: PdfCompany): void {
  const { page, accent, muted } = ctx;
  const companyName = company?.trade_name || company?.company_name || 'ResoFly';

  page.drawRectangle({ x: 0, y: PAGE_H - 18, width: PAGE_W, height: 18, color: accent, opacity: 0.85 });
  drawText(page, 'CONTRACT', LEFT, ctx.y, ctx.bold, 26);
  drawText(page, contract.number || '-', RIGHT, ctx.y + 6, ctx.bold, 12, { align: 'right' });
  ctx.y -= 28;
  drawText(page, companyName, LEFT, ctx.y, ctx.bold, 13);
  ctx.y -= 18;
  for (const line of companyAddressLines(company).slice(0, 7)) {
    drawText(page, line, LEFT, ctx.y, ctx.regular, 9, { color: muted });
    ctx.y -= 12;
  }

  let rightY = TOP - 48;
  drawText(page, `Datum: ${formatDateNl(contract.date)}`, RIGHT, rightY, ctx.regular, 9, { align: 'right', color: muted });
  rightY -= 14;
  if (contract.valid_until) {
    drawText(page, `Ondertekenen vóór: ${formatDateNl(contract.valid_until)}`, RIGHT, rightY, ctx.regular, 9, { align: 'right', color: muted });
  }

  ctx.y = Math.min(ctx.y, 648) - 8;
}

function drawParties(ctx: Ctx, client: PdfClient): void {
  drawSectionTitle(ctx, 'Partijen', ctx.y);
  ctx.y -= 22;
  for (const line of clientAddressLines(client)) {
    drawText(ctx.page, line, LEFT, ctx.y, line === client.name ? ctx.bold : ctx.regular, 10);
    ctx.y -= 14;
  }
  ctx.y -= 16;
}

async function drawSignatureBlock(ctx: Ctx, signature: PdfSignature): Promise<void> {
  ensureSpace(ctx, 130);
  ctx.y -= 16;
  drawSectionTitle(ctx, 'Handtekening', ctx.y);
  ctx.y -= 26;

  const boxTop = ctx.y;
  let drewImage = false;
  if (signature.method === 'drawn' && signature.signatureImage) {
    const embedded = await tryEmbedImage(ctx.doc, signature.signatureImage);
    if (embedded) {
      const maxW = 200;
      const maxH = 70;
      const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      ctx.page.drawImage(embedded, { x: LEFT, y: ctx.y - h, width: w, height: h });
      ctx.y -= h + 6;
      drewImage = true;
    }
  }
  if (!drewImage) {
    // Getypte handtekening: de naam in een schuine letter als faux-signature.
    drawText(ctx.page, signature.signerName || '—', LEFT, ctx.y - 22, ctx.italic, 22);
    ctx.y -= 34;
  }

  ctx.page.drawLine({ start: { x: LEFT, y: ctx.y }, end: { x: LEFT + 240, y: ctx.y }, thickness: 0.6, color: ctx.muted });
  ctx.y -= 14;
  drawText(ctx.page, `Digitaal ondertekend door ${signature.signerName}`, LEFT, ctx.y, ctx.bold, 9);
  ctx.y -= 12;
  drawText(ctx.page, `${signature.signerEmail} · ${formatDateTimeNl(signature.signedAt)}`, LEFT, ctx.y, ctx.regular, 9, { color: ctx.muted });
  ctx.y -= 6;
  void boxTop;
}

function drawCertificatePage(ctx: Ctx, contract: PdfContract, client: PdfClient, company: PdfCompany, signature: PdfSignature): void {
  newPage(ctx);
  const companyName = company?.trade_name || company?.company_name || 'ResoFly';
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 18, width: PAGE_W, height: 18, color: ctx.accent, opacity: 0.85 });
  drawText(ctx.page, 'ONDERTEKENBEWIJS', LEFT, ctx.y, ctx.bold, 20);
  ctx.y -= 18;
  drawText(ctx.page, `Bewijs van digitale ondertekening · ${companyName}`, LEFT, ctx.y, ctx.regular, 9, { color: ctx.muted });
  ctx.y -= 28;

  const rows: Array<[string, string]> = [
    ['Contract', `${contract.number}${contract.title ? ` — ${contract.title}` : ''}`],
    ['Klant', client.name],
    ['Ondertekend door', signature.signerName],
    ['E-mailadres', signature.signerEmail],
    ['Ondertekend op', formatDateTimeNl(signature.signedAt)],
    ['Methode', signature.method === 'drawn' ? 'Getekende handtekening' : 'Getypte handtekening'],
    ['IP-adres', signature.ip || 'onbekend'],
    ['Apparaat / browser', truncate(signature.userAgent || 'onbekend', 160)],
  ];

  for (const [label, value] of rows) {
    ensureSpace(ctx, 26);
    drawText(ctx.page, label.toUpperCase(), LEFT, ctx.y, ctx.bold, 7, { color: ctx.muted });
    ctx.y -= 12;
    ctx.y = drawWrapped(ctx, value, LEFT, ctx.y, CONTENT_W, ctx.regular, 10, 13);
    ctx.y -= 8;
  }

  if (signature.consentText) {
    ensureSpace(ctx, 40);
    drawText(ctx.page, 'AKKOORDVERKLARING', LEFT, ctx.y, ctx.bold, 7, { color: ctx.muted });
    ctx.y -= 12;
    ctx.y = drawWrapped(ctx, `"${signature.consentText}"`, LEFT, ctx.y, CONTENT_W, ctx.italic, 9, 12, ctx.muted);
    ctx.y -= 8;
  }

  ensureSpace(ctx, 60);
  ctx.y -= 10;
  ctx.page.drawLine({ start: { x: LEFT, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 0.5, color: ctx.muted, opacity: 0.4 });
  ctx.y -= 14;
  const legal = 'Eenvoudige elektronische handtekening conform eIDAS (Verordening (EU) nr. 910/2014). De integriteit van dit ' +
    'document is geborgd met een SHA-256-controlewaarde die is vastgelegd in het auditspoor. Dit ondertekenbewijs hoort ' +
    `onlosmakelijk bij contract ${contract.number}.`;
  drawWrapped(ctx, legal, LEFT, ctx.y, CONTENT_W, ctx.regular, 8, 11, ctx.muted);
}

// ------------------------------------------------------------ page engine
function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < BOTTOM) newPage(ctx);
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = TOP;
}

/**
 * `skipFirst` laat de eerste N pagina's ongemoeid. Alleen gebruikt bij het
 * aanvullen van een bestaand (door Collabora gerenderd) PDF: daar zou een
 * voettekst over de opmaak van het Word-document heen komen.
 */
function paintFootersAndPageNumbers(ctx: Ctx, company: PdfCompany, skipFirst = 0): void {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  const footerText = company?.invoice_footer || 'Bedankt voor het vertrouwen.';
  pages.forEach((page, index) => {
    if (index < skipFirst) return;
    page.drawLine({ start: { x: LEFT, y: 58 }, end: { x: RIGHT, y: 58 }, thickness: 0.45, color: ctx.muted, opacity: 0.35 });
    for (const [i, line] of wrapPdfText(footerText, ctx.regular, 8, 380).slice(0, 2).entries()) {
      drawText(page, line, LEFT, 44 - i * 10, ctx.regular, 8, { color: ctx.muted });
    }
    drawText(page, `Pagina ${index + 1} van ${total}`, RIGHT, 44, ctx.regular, 8, { align: 'right', color: ctx.muted });
  });
}

// ------------------------------------------------------------ drawing helpers
function drawText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, opts: { align?: 'left' | 'right'; color?: RGB } = {}): void {
  const safe = normalizePdfText(text);
  if (!safe) return;
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: opts.align === 'right' ? x - width : x, y, font, size, color: opts.color || rgb(0.1, 0.1, 0.1) });
}

function drawWrapped(ctx: Ctx, text: string, x: number, y: number, maxWidth: number, font: PDFFont, size: number, lineHeight: number, color?: RGB): number {
  let cursorY = y;
  for (const line of wrapPdfText(text, font, size, maxWidth)) {
    if (cursorY - lineHeight < BOTTOM) {
      newPage(ctx);
      cursorY = ctx.y;
    }
    drawText(ctx.page, line, x, cursorY, font, size, { color });
    cursorY -= lineHeight;
  }
  return cursorY;
}

function drawSectionTitle(ctx: Ctx, title: string, y: number): void {
  drawText(ctx.page, title.toUpperCase(), LEFT, y, ctx.bold, 8, { color: ctx.muted });
  ctx.page.drawLine({ start: { x: LEFT, y: y - 5 }, end: { x: LEFT + 180, y: y - 5 }, thickness: 0.6, color: ctx.accent });
}

async function tryEmbedImage(doc: PDFDocument, dataUrl: string): Promise<PDFImage | null> {
  try {
    const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
    if (!match) return null;
    const isPng = match[1].toLowerCase() === 'png';
    const bytes = base64ToBytes(match[2].replace(/\s+/g, ''));
    if (bytes.byteLength === 0 || bytes.byteLength > 3 * 1024 * 1024) return null;
    return isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch (_error) {
    return null;
  }
}

// ------------------------------------------------------------ text utils
type PdfBlock = { type: 'h2' | 'h3' | 'h4' | 'p' | 'li' | 'quote'; text: string };

// Zet de (al gesanitizede) rich-text body om in blokken met behoud van structuur:
// koppen, alinea's, lijst-items (genummerd/bullet) en citaten. Inline-opmaak
// (vet/cursief) wordt platgeslagen — pdf-lib tekent per regel één lettertype.
function htmlToBlocks(value: string): PdfBlock[] {
  const src = String(value ?? '');
  if (!src.trim()) return [];
  if (!/<[a-z]/i.test(src)) {
    return src.replace(/\r\n/g, '\n').split(/\n{2,}/).map((t) => ({ type: 'p' as const, text: t.trim() })).filter((b) => b.text);
  }
  const out: PdfBlock[] = [];
  const re = /<(h2|h3|h4)\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>|<(ul|ol)\b[^>]*>([\s\S]*?)<\/\5>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) {
      const t = inlineToText(m[2]);
      if (t) out.push({ type: m[1].toLowerCase() as PdfBlock['type'], text: t });
    } else if (m[3] !== undefined) {
      const t = inlineToText(m[3]);
      if (t) out.push({ type: 'p', text: t });
    } else if (m[4] !== undefined) {
      const t = inlineToText(m[4]);
      if (t) out.push({ type: 'quote', text: t });
    } else if (m[5]) {
      const ordered = m[5].toLowerCase() === 'ol';
      let i = 0;
      for (const li of m[6].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const t = inlineToText(li[1]);
        if (!t) continue;
        i += 1;
        out.push({ type: 'li', text: (ordered ? `${i}. ` : '•  ') + t });
      }
    }
  }
  if (out.length === 0) {
    const t = inlineToText(src);
    if (t) out.push({ type: 'p', text: t });
  }
  return out;
}

function inlineToText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const source = normalizePdfText(text);
  if (!source) return [];
  const words = source.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const chunks = font.widthOfTextAtSize(word, size) > maxWidth ? splitLongWord(word, font, size, maxWidth) : [word];
    for (const chunk of chunks) {
      const candidate = current ? `${current} ${chunk}` : chunk;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitLongWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const char of word) {
    const candidate = current + char;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizePdfText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    .replace(/€/g, 'EUR')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return (code >= 32 && code <= 126) || (code >= 160 && code <= 255);
    })
    .join('')
    .trim();
}

function companyAddressLines(company: PdfCompany): string[] {
  if (!company) return ['ResoFly'];
  const cityLine = [company.postal_code, company.city].filter(Boolean).join(' ');
  return [
    company.company_name,
    company.trade_name && company.trade_name !== company.company_name ? company.trade_name : '',
    company.address_line1,
    company.address_line2,
    cityLine,
    company.country,
    company.email ? `E-mail: ${company.email}` : '',
    company.phone ? `Tel: ${company.phone}` : '',
    company.kvk_number ? `KvK: ${company.kvk_number}` : '',
    company.vat_number ? `BTW: ${company.vat_number}` : '',
  ].filter((value) => normalizePdfText(value).length > 0).map(normalizePdfText);
}

function clientAddressLines(client: PdfClient): string[] {
  return [
    client.name,
    client.contact_name ? `T.a.v. ${client.contact_name}` : '',
    client.email ? `E-mail: ${client.email}` : '',
  ].filter((value) => normalizePdfText(value).length > 0).map(normalizePdfText);
}

function truncate(value: string, max: number): string {
  const v = String(value || '');
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function formatDateNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}

function formatDateTimeNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
}

function hexToPdfRgb(value: string): RGB {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  const hex = match ? match[1] : 'FFD966';
  const int = Number.parseInt(hex, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

// ------------------------------------------------------------ byte utils (exported)
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
