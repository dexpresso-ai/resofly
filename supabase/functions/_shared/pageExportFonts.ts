// ============================================================
// Welke letters een geëxporteerde pagina krijgt (stap 1B-2): die van de
// huisstijl, voor koppen en voor tekst.
//
// Dezelfde keuze als de PDF van een offerte of factuur (resolveDocumentStyle
// in documentLayout.ts): een onbekende of standaardletter wordt Poppins, en
// Bebas Neue (alleen kapitalen) nooit voor lopende tekst. pageExportFonts.test.ts
// legt beide naast elkaar.
//
// Hier alleen de keuze en de bestandsnamen; de bytes haalt de aanroeper op (de
// app uit /fonts/pdf, de server uit pdfFonts.ts), en woff.ts zet ze om.
// ============================================================

import { pdfFont, type PdfFontDefinition, type StyleRowLike } from './documentLayout.ts';

export type PageExportFont = {
  /** De sleutel uit PDF_FONTS ('system' is Poppins). */
  key: string;
  /** De naam van de familie, als de letter zelf niet laadt. */
  family: string;
  /** "poppins-400": public/fonts/pdf/poppins-400.woff, en PDF_FONT_FILES in pdfFonts.ts. */
  regular: string | null;
  /** Het vette gewicht, als de letter dat heeft. */
  bold: string | null;
};

function brandFont(key: string | null | undefined): PdfFontDefinition {
  const font = pdfFont(key);
  return font.standard ? pdfFont('system') : font;
}

function exportFont(font: PdfFontDefinition): PageExportFont {
  return {
    key: font.key,
    family: font.label,
    regular: font.file ? `${font.file}-400` : null,
    bold: font.file && font.bold ? `${font.file}-700` : null,
  };
}

export function pageExportFonts(row: Pick<StyleRowLike, 'brand_heading_font' | 'brand_body_font'> | null | undefined): {
  heading: PageExportFont;
  body: PageExportFont;
} {
  const heading = brandFont(row?.brand_heading_font);
  let body = brandFont(row?.brand_body_font);
  if (body.headingOnly) body = pdfFont('system');
  return { heading: exportFont(heading), body: exportFont(body) };
}
