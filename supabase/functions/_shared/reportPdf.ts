// ============================================================
// Herbruikbare rapport-PDF-laag voor financiële stukken.
//
// Waarom een nieuwe module naast contractPdf.ts: er waren vier generatoren met
// elk hun eigen hardgecodeerde x-offsets en geen enkele tabel-abstractie. Een
// jaarrekening heeft drie soorten tabellen, twee vergelijkende bedragkolommen en
// tabellen die over meerdere pagina's lopen. Dat is met losse drawText-aanroepen
// niet vol te houden.
//
// De pagina-engine (A4, marges, ensureSpace/newPage, paginanummering achteraf)
// komt uit contractPdf.ts — dat is de enige echte pagina-engine in dit project.
// Wat hier nieuw is:
//
//   * drawTable()  — kolommen met breedte en uitlijning, rijtypes (regel,
//                    subtotaal met lijn erboven, totaal vet, resultaat met
//                    dubbele lijn, sectiekop, witregel, voetnoot), en kopherhaling
//                    op elke nieuwe pagina.
//   * fmtEuro()    — ÉÉN geldformatter voor alles. Concept en definitief moeten
//                    identiek drukken; twee formatters is één te veel.
//   * renderReportDocument() — een document als DATA (blokken) renderen, zodat de
//                    opbouw van een stuk los staat van het tekenwerk.
//
// HARDE BEPERKING — WinAnsi. pdf-lib tekent met de ingebouwde Helvetica en die
// kent alleen WinAnsi. Geen euroteken, geen vinkje, geen kastlijntje, geen pijl.
// normalizePdfText() vertaalt wat te vertalen is (€ → EUR, — → -, • → -, ≤ → <=)
// en gooit de rest weg. Daarom staat er in élk bedrag letterlijk "EUR" en nergens
// een symbool. Wie hier een Unicode-teken binnensmokkelt, ziet het niet
// terugkomen in de PDF — het verdwijnt stil.
//
// Bedragen zijn ALTIJD hele centen (bigint uit de database). Er wordt hier
// nergens gerekend: de renderer formatteert, hij herrekent niet.
// ============================================================

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'https://esm.sh/pdf-lib@1.17.1';

// Byte-hulpjes staan al in contractPdf.ts en worden hier alleen doorgegeven —
// twee implementaties van base64 en sha256 in één codebase is er één te veel.
export { base64ToBytes, bytesToBase64, sha256HexBytes } from './contractPdf.ts';

// ------------------------------------------------------------ pagina-maten
export const PAGE_W = 595.28; // A4 staand
export const PAGE_H = 841.89;
export const LEFT = 48;
export const RIGHT = 547;
export const CONTENT_W = RIGHT - LEFT; // 499
export const TOP = 790;
export const BOTTOM = 70; // alles daaronder is voetruimte

// ------------------------------------------------------------ types
export type Align = 'left' | 'right';

/** Eén kolom van een tabel. `width` is in punten; de som hoort CONTENT_W te zijn. */
export type Col = {
  key: string;
  header?: string;
  width: number;
  align?: Align;
  bold?: boolean;
};

/**
 * Rijtypes:
 *   line    — gewone regel
 *   sub     — subtotaal: dunne lijn boven de bedragkolommen, vette tekst
 *   total   — totaal: vet, lijn erboven over de volle breedte
 *   result  — resultaatregel: vet met dubbele lijn eronder
 *   section — rubriekkop binnen de tabel (geen bedragen)
 *   spacer  — witregel
 *   note    — kleine, cursieve toelichtingsregel over de volle breedte
 */
export type RowKind = 'line' | 'sub' | 'total' | 'result' | 'section' | 'spacer' | 'note';

export type Row = {
  kind: RowKind;
  /** Voor 'line' | 'sub' | 'total' | 'result': waarde per kolom-key. */
  cells?: Record<string, string>;
  /** Voor 'section' | 'note': de tekst over de volle breedte. */
  text?: string;
  /** Inspringing van de eerste (linker) kolom, in punten. */
  indent?: number;
};

export type Signer = {
  name: string;
  role: string;
  signed: boolean;
  signedOn?: string | null;
  /** Art. 2:210 lid 2 BW: ontbreekt een handtekening, dan de reden erbij. */
  missingReason?: string | null;
};

export type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  accent: RGB;
  muted: RGB;
  ink: RGB;
  warn: RGB;
};

// ------------------------------------------------------------ documentmodel
//
// Een stuk wordt eerst als DATA beschreven en pas daarna getekend. Dat is de
// hele reden dat de vier publicatievarianten geen if-boom in de renderer zijn:
// annualAccountsLayout.ts levert blokken, deze module tekent ze.

export type Block =
  | { type: 'coverTitle'; title: string; subtitle?: string; lines?: string[] }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string; italic?: boolean; muted?: boolean; small?: boolean }
  | { type: 'bullets'; items: string[] }
  | { type: 'keyValues'; pairs: Array<[string, string]>; labelWidth?: number }
  | { type: 'table'; cols: Col[]; rows: Row[]; caption?: string; note?: string }
  | { type: 'banner'; tone: 'info' | 'warn'; title: string; text: string }
  | { type: 'checklist'; title: string; intro?: string; items: Array<{ label: string; text: string }> }
  | { type: 'signatures'; signers: Signer[] }
  | { type: 'spacer'; height?: number }
  | { type: 'pageBreak' };

export type ReportDocument = {
  /** Titel in de PDF-metadata en op het titelblad. */
  title: string;
  /** Bestandsnaam zonder pad; wordt door de aanroeper gebruikt bij het opslaan. */
  fileName: string;
  /** Linksonder op elke pagina (meestal de bedrijfsnaam). */
  footerText: string;
  /** De verplichte disclaimer, op ELKE pagina onder de streep. */
  disclaimer: string;
  accentColor?: string | null;
  subject?: string;
  /**
   * De datum die in de PDF-metadata komt. Neem hier een datum UIT HET BEVROREN
   * STUK (de opmaakdatum), nooit de kloktijd: alleen dan levert een herdruk
   * dezelfde bytes en dus dezelfde sha256 op als het gearchiveerde exemplaar.
   */
  documentDate?: string | Date | null;
  blocks: Block[];
};

// ------------------------------------------------------------ document opzetten
export async function newDoc(
  opts: { accentColor?: string | null; title?: string; subject?: string; documentDate?: string | Date | null } = {},
): Promise<Ctx> {
  // updateMetadata: false — anders stempelt pdf-lib bij elke aanroep de kloktijd
  // in CreationDate/ModDate en krijgt een HERDRUK van hetzelfde bevroren stuk
  // andere bytes, dus een andere sha256. Juist die hash is de vergelijkingssleutel
  // waarmee je kunt vaststellen dat het opnieuw opgebouwde stuk hetzelfde stuk is.
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (opts.title) doc.setTitle(normalizePdfText(opts.title));
  if (opts.subject) doc.setSubject(normalizePdfText(opts.subject));
  doc.setProducer('ResoFly');
  doc.setCreator('ResoFly');
  // De datum komt uit het bevroren stuk zelf (opmaakdatum), niet van de klok.
  // Zonder opgave een vaste waarde, zodat de bytes reproduceerbaar blijven.
  const stamp = opts.documentDate ? new Date(opts.documentDate) : new Date(0);
  const safeStamp = Number.isNaN(stamp.getTime()) ? new Date(0) : stamp;
  doc.setCreationDate(safeStamp);
  doc.setModificationDate(safeStamp);
  return {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: TOP,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    accent: hexToPdfRgb(opts.accentColor || '#FFD966'),
    muted: rgb(0.38, 0.38, 0.38),
    ink: rgb(0.1, 0.1, 0.1),
    warn: rgb(0.62, 0.16, 0.12),
  };
}

export function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = TOP;
}

export function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < BOTTOM) newPage(ctx);
}

// ------------------------------------------------------------ tekst
export function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  opts: { align?: Align; color?: RGB } = {},
): void {
  const safe = normalizePdfText(text);
  if (!safe) return;
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, {
    x: opts.align === 'right' ? x - width : x,
    y,
    font,
    size,
    color: opts.color || rgb(0.1, 0.1, 0.1),
  });
}

/** Tekent doorlopende tekst met automatische pagina-overgang; geeft de nieuwe y terug. */
export function drawWrapped(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  font: PDFFont,
  size: number,
  lineHeight: number,
  color?: RGB,
): number {
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

export function drawHeading(ctx: Ctx, text: string, level: 1 | 2 | 3 = 1): void {
  const size = level === 1 ? 15 : level === 2 ? 12 : 10;
  const lead = level === 1 ? 18 : level === 2 ? 12 : 8;
  ensureSpace(ctx, lead + size + 14);
  ctx.y -= lead;
  ctx.y = drawWrapped(ctx, text, LEFT, ctx.y, CONTENT_W, ctx.bold, size, size + 4);
  if (level === 1) {
    ctx.page.drawLine({
      start: { x: LEFT, y: ctx.y + 6 },
      end: { x: RIGHT, y: ctx.y + 6 },
      thickness: 1.1,
      color: ctx.accent,
    });
    ctx.y -= 8;
  } else {
    ctx.y -= 4;
  }
}

export function drawParagraph(
  ctx: Ctx,
  text: string,
  opts: { italic?: boolean; muted?: boolean; small?: boolean } = {},
): void {
  const size = opts.small ? 8 : 9.5;
  const font = opts.italic ? ctx.italic : ctx.regular;
  ensureSpace(ctx, size + 8);
  ctx.y = drawWrapped(ctx, text, LEFT, ctx.y, CONTENT_W, font, size, size + 3.5, opts.muted ? ctx.muted : ctx.ink);
  ctx.y -= 6;
}

export function drawBullets(ctx: Ctx, items: string[]): void {
  for (const item of items) {
    ensureSpace(ctx, 16);
    drawText(ctx.page, '-', LEFT + 4, ctx.y, ctx.regular, 9.5, { color: ctx.muted });
    ctx.y = drawWrapped(ctx, item, LEFT + 14, ctx.y, CONTENT_W - 14, ctx.regular, 9.5, 13);
    ctx.y -= 2;
  }
  ctx.y -= 4;
}

/** Label links (vet, klein), waarde rechts ervan. Voor kopgegevens en besluiten. */
export function drawKeyValues(ctx: Ctx, pairs: Array<[string, string]>, labelWidth = 170): void {
  for (const [label, value] of pairs) {
    const lines = wrapPdfText(value, ctx.regular, 9.5, CONTENT_W - labelWidth);
    const height = Math.max(1, lines.length) * 13;
    ensureSpace(ctx, height + 2);
    const top = ctx.y;
    drawText(ctx.page, label, LEFT, top, ctx.bold, 9.5, { color: ctx.ink });
    let cursor = top;
    for (const line of lines) {
      drawText(ctx.page, line, LEFT + labelWidth, cursor, ctx.regular, 9.5);
      cursor -= 13;
    }
    ctx.y = top - height;
  }
  ctx.y -= 6;
}

// ------------------------------------------------------------ tabellen
/**
 * De tabelhelper. Kolommen krijgen een vaste x en breedte; bedragkolommen worden
 * rechts uitgelijnd op een VASTE rechterrand per kolom. Dat is bij Helvetica de
 * enige manier om cijferkolommen recht te krijgen — het lettertype heeft geen
 * tabular figures, dus uitlijnen op tekenbreedte werkt niet.
 *
 * De kop wordt op elke nieuwe pagina herhaald (tenzij repeatHeader: false), zodat
 * een balans die over twee pagina's loopt op pagina twee nog steeds vertelt welk
 * boekjaar in welke kolom staat.
 */
export function drawTable(
  ctx: Ctx,
  cols: Col[],
  rows: Row[],
  opts: { repeatHeader?: boolean; size?: number } = {},
): void {
  const size = opts.size ?? 9;
  const repeatHeader = opts.repeatHeader !== false;
  const hasHeader = cols.some((c) => (c.header ?? '').length > 0);

  const xs: number[] = [];
  let cursorX = LEFT;
  for (const col of cols) {
    xs.push(cursorX);
    cursorX += col.width;
  }
  const tableRight = cursorX;
  // Linkerrand van de eerste rechts uitgelijnde kolom: daar beginnen de
  // subtotaal- en totaallijnen, zodat ze onder de bedragen staan en niet onder de
  // omschrijving.
  const firstNumericIndex = cols.findIndex((c) => c.align === 'right');
  const numericStart = firstNumericIndex >= 0 ? xs[firstNumericIndex] : LEFT;

  const drawHeaderRow = () => {
    if (!hasHeader) return;
    ensureSpace(ctx, 22);
    cols.forEach((col, index) => {
      const text = col.header ?? '';
      if (!text) return;
      const x = col.align === 'right' ? xs[index] + col.width - 2 : xs[index] + 2;
      drawText(ctx.page, text.toUpperCase(), x, ctx.y, ctx.bold, size - 1.5, {
        align: col.align === 'right' ? 'right' : 'left',
        color: ctx.muted,
      });
    });
    ctx.y -= 5;
    ctx.page.drawLine({
      start: { x: LEFT, y: ctx.y },
      end: { x: tableRight, y: ctx.y },
      thickness: 0.7,
      color: ctx.accent,
    });
    ctx.y -= 11;
  };

  drawHeaderRow();

  for (const row of rows) {
    if (row.kind === 'spacer') {
      ctx.y -= 7;
      continue;
    }

    if (row.kind === 'section' || row.kind === 'note') {
      const font = row.kind === 'section' ? ctx.bold : ctx.italic;
      const fontSize = row.kind === 'section' ? size + 0.5 : size - 1.5;
      const lines = wrapPdfText(row.text ?? '', font, fontSize, CONTENT_W - (row.indent ?? 0));
      const height = lines.length * (fontSize + 3) + (row.kind === 'section' ? 6 : 4);
      if (ctx.y - height < BOTTOM) {
        newPage(ctx);
        if (repeatHeader) drawHeaderRow();
      }
      if (row.kind === 'section') ctx.y -= 4;
      let cursor = ctx.y;
      for (const line of lines) {
        drawText(ctx.page, line, LEFT + (row.indent ?? 0), cursor, font, fontSize, {
          color: row.kind === 'section' ? ctx.ink : ctx.muted,
        });
        cursor -= fontSize + 3;
      }
      ctx.y = cursor - 2;
      continue;
    }

    // Gewone bedragregels. De hoogte volgt uit de langste linkerkolom; bedragen
    // gaan er per definitie op één regel in.
    const bold = row.kind !== 'line';
    const font = bold ? ctx.bold : ctx.regular;
    const rowSize = row.kind === 'result' ? size + 0.5 : size;
    const wrapped: string[][] = cols.map((col, index) => {
      const value = row.cells?.[col.key] ?? '';
      if (col.align === 'right') return value ? [value] : [];
      const indent = index === 0 ? (row.indent ?? 0) : 0;
      return wrapPdfText(value, col.bold ? ctx.bold : font, rowSize, col.width - 4 - indent);
    });
    const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length));
    const lineHeight = rowSize + 3.5;
    const above = row.kind === 'sub' || row.kind === 'total' ? 8 : 0;
    const below = row.kind === 'result' ? 8 : 2;
    const height = lineCount * lineHeight + above + below;

    if (ctx.y - height < BOTTOM) {
      newPage(ctx);
      if (repeatHeader) drawHeaderRow();
    }

    if (row.kind === 'sub' || row.kind === 'total') {
      ctx.y -= above - 3;
      const startX = row.kind === 'total' ? LEFT : numericStart;
      ctx.page.drawLine({
        start: { x: startX, y: ctx.y },
        end: { x: tableRight, y: ctx.y },
        thickness: 0.6,
        color: ctx.muted,
      });
      ctx.y -= 4;
    }

    const top = ctx.y;
    cols.forEach((col, index) => {
      const lines = wrapped[index];
      const cellFont = col.bold ? ctx.bold : font;
      let cursor = top;
      for (const line of lines) {
        const x = col.align === 'right'
          ? xs[index] + col.width - 2
          : xs[index] + 2 + (index === 0 ? (row.indent ?? 0) : 0);
        drawText(ctx.page, line, x, cursor, cellFont, rowSize, {
          align: col.align === 'right' ? 'right' : 'left',
          color: ctx.ink,
        });
        cursor -= lineHeight;
      }
    });
    ctx.y = top - lineCount * lineHeight;

    if (row.kind === 'result') {
      // Dubbele lijn: de sluitregel van een resultaatoverzicht.
      ctx.y -= 1;
      ctx.page.drawLine({ start: { x: numericStart, y: ctx.y }, end: { x: tableRight, y: ctx.y }, thickness: 0.7, color: ctx.ink });
      ctx.y -= 2.4;
      ctx.page.drawLine({ start: { x: numericStart, y: ctx.y }, end: { x: tableRight, y: ctx.y }, thickness: 0.7, color: ctx.ink });
      ctx.y -= 6;
    } else {
      ctx.y -= 2;
    }
  }
  ctx.y -= 4;
}

// ------------------------------------------------------------ banner
/**
 * Een opvallend kader. Gebruikt voor de SBR/XBRL-mededeling boven elk
 * publicatiestuk en voor de markering van een verouderde of ingetrokken
 * jaarrekening — die mag nooit stilzwijgend meegedrukt worden.
 */
export function drawBanner(ctx: Ctx, title: string, text: string, tone: 'info' | 'warn' = 'info'): void {
  const innerWidth = CONTENT_W - 20;
  const titleLines = wrapPdfText(title, ctx.bold, 9.5, innerWidth);
  const textLines = wrapPdfText(text, ctx.regular, 8.5, innerWidth);
  const height = 12 + titleLines.length * 13 + textLines.length * 11.5 + 8;
  ensureSpace(ctx, height + 10);

  const color = tone === 'warn' ? ctx.warn : ctx.accent;
  ctx.page.drawRectangle({
    x: LEFT,
    y: ctx.y - height + 8,
    width: CONTENT_W,
    height,
    color,
    opacity: tone === 'warn' ? 0.1 : 0.16,
  });
  ctx.page.drawRectangle({ x: LEFT, y: ctx.y - height + 8, width: 3.2, height, color });

  let cursor = ctx.y - 4;
  for (const line of titleLines) {
    drawText(ctx.page, line, LEFT + 12, cursor, ctx.bold, 9.5, { color: tone === 'warn' ? ctx.warn : ctx.ink });
    cursor -= 13;
  }
  for (const line of textLines) {
    drawText(ctx.page, line, LEFT + 12, cursor, ctx.regular, 8.5, { color: ctx.ink });
    cursor -= 11.5;
  }
  ctx.y = ctx.y - height - 6;
}

/**
 * Checklist voor stukken die ResoFly bewust NIET genereert (bestuursverslag,
 * accountantsverklaring, overige gegevens). Ze worden benoemd waar ze verplicht
 * zijn; een gegenereerde accountantsverklaring zou per definitie vals zijn.
 */
export function drawChecklist(
  ctx: Ctx,
  title: string,
  items: Array<{ label: string; text: string }>,
  intro?: string,
): void {
  drawHeading(ctx, title, 2);
  if (intro) drawParagraph(ctx, intro, { small: true, muted: true });
  for (const item of items) {
    ensureSpace(ctx, 30);
    drawText(ctx.page, '[ ]', LEFT, ctx.y, ctx.bold, 9.5, { color: ctx.muted });
    drawText(ctx.page, item.label, LEFT + 20, ctx.y, ctx.bold, 9.5);
    ctx.y -= 12;
    ctx.y = drawWrapped(ctx, item.text, LEFT + 20, ctx.y, CONTENT_W - 20, ctx.regular, 8.5, 11, ctx.muted);
    ctx.y -= 5;
  }
  ctx.y -= 2;
}

/**
 * Ondertekeningsblok (art. 2:210 lid 2 BW). Alle bestuurders en commissarissen
 * krijgen een regel; ontbreekt een handtekening, dan wordt daarvan melding
 * gemaakt ONDER OPGAVE VAN REDEN — die reden staat dus in het stuk zelf.
 */
export function drawSignatureLines(ctx: Ctx, signers: Signer[]): void {
  for (const signer of signers) {
    ensureSpace(ctx, 62);
    ctx.page.drawLine({
      start: { x: LEFT, y: ctx.y },
      end: { x: LEFT + 230, y: ctx.y },
      thickness: 0.6,
      color: ctx.muted,
    });
    ctx.y -= 12;
    drawText(ctx.page, signer.name, LEFT, ctx.y, ctx.bold, 9.5);
    drawText(ctx.page, capitalize(signer.role), LEFT + 240, ctx.y, ctx.regular, 9, { color: ctx.muted });
    ctx.y -= 12;
    if (signer.signed) {
      drawText(
        ctx.page,
        signer.signedOn ? `Ondertekend op ${signer.signedOn}` : 'Ondertekend',
        LEFT,
        ctx.y,
        ctx.regular,
        8.5,
        { color: ctx.muted },
      );
      ctx.y -= 12;
    } else {
      const reason = (signer.missingReason ?? '').trim();
      ctx.y = drawWrapped(
        ctx,
        reason
          ? `Niet ondertekend door ${signer.name} (${signer.role}) - reden: ${reason}`
          : `Niet ondertekend door ${signer.name} (${signer.role}) - er is geen reden vastgelegd (art. 2:210 lid 2 BW verlangt melding onder opgave van reden).`,
        LEFT,
        ctx.y,
        CONTENT_W,
        ctx.italic,
        8.5,
        11,
        ctx.warn,
      );
      ctx.y -= 4;
    }
    ctx.y -= 10;
  }
}

// ------------------------------------------------------------ titelblad
export function drawCoverTitle(ctx: Ctx, title: string, subtitle?: string, lines: string[] = []): void {
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 18, width: PAGE_W, height: 18, color: ctx.accent, opacity: 0.85 });
  ctx.y = drawWrapped(ctx, title, LEFT, ctx.y, CONTENT_W, ctx.bold, 24, 28);
  ctx.y -= 6;
  if (subtitle) {
    ctx.y = drawWrapped(ctx, subtitle, LEFT, ctx.y, CONTENT_W, ctx.regular, 12, 16, ctx.muted);
    ctx.y -= 4;
  }
  ctx.page.drawLine({ start: { x: LEFT, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 1.4, color: ctx.accent });
  ctx.y -= 20;
  for (const line of lines) {
    ensureSpace(ctx, 16);
    ctx.y = drawWrapped(ctx, line, LEFT, ctx.y, CONTENT_W, ctx.regular, 10, 14);
    ctx.y -= 2;
  }
  ctx.y -= 10;
}

// ------------------------------------------------------------ voet
/**
 * Voettekst, disclaimer en paginanummering — achteraf over alle pagina's, want
 * pas dan is het totaal aantal pagina's bekend.
 *
 * De disclaimer staat op ELKE pagina. Dat is geen opsmuk: een losgeraakte pagina
 * van een financieel stuk moet zelf vertellen dat ResoFly geen accountant is.
 */
export function paintFootersAndPageNumbers(
  ctx: Ctx,
  opts: { footerText: string; disclaimer: string; skipFirst?: number },
): void {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  const skipFirst = opts.skipFirst ?? 0;
  const disclaimerLines = wrapPdfText(opts.disclaimer, ctx.regular, 6.5, CONTENT_W).slice(0, 3);

  pages.forEach((page, index) => {
    if (index < skipFirst) return;
    page.drawLine({ start: { x: LEFT, y: 62 }, end: { x: RIGHT, y: 62 }, thickness: 0.45, color: ctx.muted, opacity: 0.4 });
    drawText(page, opts.footerText, LEFT, 50, ctx.regular, 7.5, { color: ctx.muted });
    drawText(page, `Pagina ${index + 1} van ${total}`, RIGHT, 50, ctx.regular, 7.5, { align: 'right', color: ctx.muted });
    disclaimerLines.forEach((line, i) => {
      drawText(page, line, LEFT, 39 - i * 8.5, ctx.regular, 6.5, { color: ctx.muted });
    });
  });
}

// ------------------------------------------------------------ documentrenderer
/** Tekent een als data beschreven document en geeft de PDF-bytes terug. */
export async function renderReportDocument(document: ReportDocument): Promise<Uint8Array> {
  const ctx = await newDoc({
    accentColor: document.accentColor,
    title: document.title,
    subject: document.subject,
    documentDate: document.documentDate ?? null,
  });

  for (const block of document.blocks) {
    switch (block.type) {
      case 'coverTitle':
        drawCoverTitle(ctx, block.title, block.subtitle, block.lines ?? []);
        break;
      case 'heading':
        drawHeading(ctx, block.text, block.level);
        break;
      case 'paragraph':
        drawParagraph(ctx, block.text, { italic: block.italic, muted: block.muted, small: block.small });
        break;
      case 'bullets':
        drawBullets(ctx, block.items);
        break;
      case 'keyValues':
        drawKeyValues(ctx, block.pairs, block.labelWidth);
        break;
      case 'table':
        if (block.caption) drawHeading(ctx, block.caption, 3);
        drawTable(ctx, block.cols, block.rows);
        if (block.note) drawParagraph(ctx, block.note, { small: true, muted: true, italic: true });
        break;
      case 'banner':
        drawBanner(ctx, block.title, block.text, block.tone);
        break;
      case 'checklist':
        drawChecklist(ctx, block.title, block.items, block.intro);
        break;
      case 'signatures':
        drawSignatureLines(ctx, block.signers);
        break;
      case 'spacer':
        ctx.y -= block.height ?? 10;
        break;
      case 'pageBreak':
        newPage(ctx);
        break;
    }
  }

  paintFootersAndPageNumbers(ctx, { footerText: document.footerText, disclaimer: document.disclaimer });
  return await ctx.doc.save();
}

// ------------------------------------------------------------ formatters
/**
 * DE geldformatter. Eén implementatie voor concept, definitief en publicatiestuk,
 * zodat een herdruk letterlijk hetzelfde beeld geeft als het vastgestelde stuk.
 *
 * Bedragen komen als hele centen binnen. Geen euroteken: Helvetica is WinAnsi en
 * kent geen glyph voor de euro — die zou stil verdwijnen. Vandaar "EUR".
 * Een negatief bedrag krijgt het minteken ná "EUR", zodat de valuta-aanduiding in
 * een rechts uitgelijnde kolom op dezelfde plek blijft staan.
 */
export function fmtEuro(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const numeric = Number(cents);
  if (!Number.isFinite(numeric)) return '';
  const rounded = Math.round(numeric);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const euros = Math.floor(abs / 100);
  const cents2 = String(abs % 100).padStart(2, '0');
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `EUR ${negative ? '-' : ''}${grouped},${cents2}`;
}

/** Zelfde formatter, maar een leeg bedrag wordt een streepje (vergelijkende kolom). */
export function fmtEuroOrDash(cents: number | null | undefined): string {
  const formatted = fmtEuro(cents);
  return formatted || '-';
}

/** Nederlands getal met vaste decimalen (bijv. het gemiddelde aantal werknemers). */
export function fmtNumberNl(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined) return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const fixed = numeric.toFixed(decimals);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction ? `${grouped},${fraction}` : grouped;
}

/** dd-mm-jjjj. Bewust handmatig: geen afhankelijkheid van de ICU-locale van de runtime. */
export function fmtDateNl(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getUTCFullYear()}`;
}

export function fmtDateTimeNl(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${date.getUTCFullYear()} ${hh}:${mi} UTC`;
}

// ------------------------------------------------------------ tekst-hulpjes
export function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const source = normalizePdfText(text);
  if (!source) return [];
  const words = source.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const chunks = font.widthOfTextAtSize(word, size) > maxWidth
      ? splitLongWord(word, font, size, maxWidth)
      : [word];
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

/**
 * WinAnsi-filter. Alles buiten 32-126 en 160-255 kan Helvetica niet tekenen; wat
 * te vertalen is wordt vertaald, de rest verdwijnt. Let op de euro: die valt
 * buiten WinAnsi zoals pdf-lib hem codeert en wordt "EUR".
 */
export function normalizePdfText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/€/g, 'EUR')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/[→⇒]/g, '->')
    .replace(/[✓✔]/g, 'v')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Letters buiten Latin-1 worden EERST ontdaan van hun diakriet (NFD splitst
    // ě in e + combining caron, de tweede valt weg). Zonder deze stap zou het
    // filter hieronder de hele letter wegknippen en werd "Vaněk" stil "Vank" —
    // in een stuk waarin de namen van bestuurders juridisch meetellen.
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) return char;
      const stripped = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (stripped && /^[\x20-\x7e\xa0-\xff]+$/.test(stripped)) return stripped;
      // Losse gevallen die NFD niet oplost maar wel een gangbare transliteratie
      // hebben; Ł/ł zijn in Nederlandse aandeelhoudersregisters niet zeldzaam.
      const map: Record<string, string> = {
        'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h',
        'Œ': 'OE', 'œ': 'oe', 'Ŋ': 'N', 'ŋ': 'n', 'Ŧ': 'T', 'ŧ': 't',
      };
      if (map[char]) return map[char];
      // Wat er dan nog overblijft is niet te tekenen. Een vraagteken is beter
      // dan een stille verdwijning: het valt op en is te corrigeren.
      return '?';
    })
    .join('')
    .trim();
}

function capitalize(value: string): string {
  const text = String(value ?? '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function hexToPdfRgb(value: string): RGB {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  const hex = match ? match[1] : 'FFD966';
  const int = Number.parseInt(hex, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

/** Bestandsnaam zonder verrassingen: alleen letters, cijfers, streepje en punt. */
export function safePdfFileName(value: string): string {
  const base = normalizePdfText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `${base || 'document'}.pdf`;
}
