// De PDF van een offerte of factuur zoals de klant hem krijgt, voor
// invoice-workflow en quote-workflow.
//
// De opmaak zelf staat in documentLayout.ts (dezelfde code als het voorbeeld in
// de app). Hier alleen wat de server erbij doet: de opmaak, het logo en het
// briefpapier van de organisatie ophalen, en alles aan de tekenmodule geven.
//
// Waarom een eigen query en niet de bedrijfsgegevens die de workflow al heeft:
// het briefpapier kan een paar MB zijn. Dat halen we alleen op als er echt een
// PDF wordt gemaakt, niet bij elke actie van de workflow.

import * as PdfLib from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  buildDocumentData,
  creditNoteDocument,
  documentAmounts,
  documentAssetsFromSettings,
  dunningDocument,
  layoutFonts,
  parseDocumentLayouts,
  renderDocumentPdf,
  resolveDocumentLayout,
  resolveDocumentStyle,
  type ClientRowLike,
  type CompanyRowLike,
  type DocumentData,
  type DocumentKind,
  type DunningLetterInput,
  type PdfFontSource,
  type SalesLineLike,
} from './documentLayout.ts';
import { PDF_FONT_FILES } from './pdfFonts.ts';

/** Huisstijl, briefpapier en opmaak: alles wat bepaalt hoe de PDF eruitziet. */
export interface DocumentDesignRow {
  brand_logo_data_url?: string | null;
  brand_accent_color?: string | null;
  brand_heading_font?: string | null;
  brand_body_font?: string | null;
  invoice_accent_color?: string | null;
  invoice_template_kind?: string | null;
  invoice_template_data_url?: string | null;
  invoice_template_mime_type?: string | null;
  invoice_template_text_color?: string | null;
  invoice_font_size?: number | null;
  document_layouts?: unknown;
}

export const DOCUMENT_DESIGN_COLUMNS =
  'brand_logo_data_url,brand_accent_color,brand_heading_font,brand_body_font,invoice_accent_color,' +
  'invoice_template_kind,invoice_template_data_url,invoice_template_mime_type,invoice_template_text_color,' +
  'invoice_font_size,document_layouts';

/**
 * Haalt de vormgeving van één organisatie op, gefilterd op `organizationId`
 * (de service-role ziet alles; de workflow heeft de organisatie al uit de
 * sessie gehaald).
 *
 * Gooit niet. Draait de functie al terwijl de migratie met de opmaak nog moet,
 * dan opnieuw zonder die kolom; mislukt het helemaal, dan de standaardopmaak.
 * Een factuur mag niet blijven liggen op een sierlaag: de standaardopmaak
 * bevat alles wat wettelijk op een factuur moet.
 */
export async function loadDocumentDesign(supabaseAdmin: SupabaseClient, organizationId: string): Promise<DocumentDesignRow | null> {
  try {
    const query = (columns: string) => supabaseAdmin
      .from('company_settings')
      .select(columns)
      .eq('organization_id', organizationId)
      .maybeSingle();
    let { data, error } = await query(DOCUMENT_DESIGN_COLUMNS);
    if (error && /document_layouts/i.test(error.message ?? '')) {
      ({ data, error } = await query(DOCUMENT_DESIGN_COLUMNS.replace(',document_layouts', '')));
    }
    if (error) {
      console.warn('documentopmaak laden mislukt; de standaardopmaak wordt gebruikt', error.message);
      return null;
    }
    return (data ?? null) as DocumentDesignRow | null;
  } catch (error) {
    console.warn('documentopmaak laden crashte; de standaardopmaak wordt gebruikt', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * De letters van de huisstijl, uit de base64-module (geen lettertype-server
 * nodig op het moment dat een factuur de deur uit gaat). Eén keer per
 * instantie omgezet.
 */
const fontBytes = new Map<string, Uint8Array>();
const FONT_SOURCE: PdfFontSource = {
  fontkit,
  load(name: string) {
    const cached = fontBytes.get(name);
    if (cached) return Promise.resolve(cached);
    const base64 = PDF_FONT_FILES[name];
    if (!base64) return Promise.resolve(null);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    fontBytes.set(name, bytes);
    return Promise.resolve(bytes);
  },
};

/** Tekent een stuk met de opmaak, het logo, het briefpapier en de letters van de organisatie. */
async function renderWithDesign(kind: DocumentKind, design: DocumentDesignRow | null, data: DocumentData): Promise<Uint8Array> {
  const layouts = parseDocumentLayouts(design?.document_layouts);
  const assets = documentAssetsFromSettings(design);
  return renderDocumentPdf(PdfLib, {
    layout: resolveDocumentLayout(layouts, kind, { letterhead: Boolean(assets.letterhead) }),
    data,
    style: resolveDocumentStyle(design, layoutFonts(layouts)),
    assets,
    fonts: FONT_SOURCE,
    onWarning: (message, error) => console.warn(`documentpdf: ${message}`, error instanceof Error ? error.message : error),
  });
}

/** Tekent een offerte of factuur met de opmaak, het logo en het briefpapier van de organisatie. */
export async function renderSalesDocumentPdf(input: {
  kind: DocumentKind;
  design: DocumentDesignRow | null;
  company: CompanyRowLike | null;
  client: ClientRowLike | null;
  number: string | null;
  date: string | null;
  secondDate: string | null;
  lines: SalesLineLike[];
  vatNotes: string[];
  /** Btw verlegd of ICP: het btw-nummer van de afnemer moet op de factuur. */
  customerVatRequired?: boolean;
  notes: string | null;
  projectName?: string | null;
  quoteNumber?: string | null;
  onlineLink?: { label: string; url: string } | null;
}): Promise<Uint8Array> {
  const amounts = documentAmounts(input.lines);
  const data = buildDocumentData({
    kind: input.kind,
    number: input.number,
    date: input.date,
    secondDate: input.secondDate,
    company: input.company,
    client: input.client,
    lines: amounts.lines,
    totals: amounts.totals,
    vatNotes: input.vatNotes,
    customerVatRequired: input.customerVatRequired,
    notes: input.notes,
    projectName: input.projectName,
    quoteNumber: input.quoteNumber,
    onlineLink: input.onlineLink ?? null,
  });
  return renderWithDesign(input.kind, input.design, data);
}

/**
 * Een creditfactuur in de opmaak van de factuur, met logo. De bedragen zijn
 * die van de opgeslagen creditnota (positief aangeleverd, negatief op papier).
 */
export async function renderCreditNotePdf(input: {
  design: DocumentDesignRow | null;
  company: CompanyRowLike | null;
  client: ClientRowLike | null;
  number: string | null;
  date: string | null;
  invoiceReference: string | null;
  invoiceDate: string | null;
  lines: SalesLineLike[];
  subtotal: number;
  vat: number;
  total: number;
  vatNotes: string[];
  customerVatRequired?: boolean;
  reason: string | null;
  refunded?: boolean;
}): Promise<Uint8Array> {
  const { design, ...rest } = input;
  return renderWithDesign('credit_note', design, creditNoteDocument(rest));
}

/** Een aanmaning in de opmaak van de factuur: kop, voet en logo, met de brief ertussen. */
export async function renderDunningLetterPdf(input: Omit<DunningLetterInput, 'signature' | 'accountHolder'> & {
  design: DocumentDesignRow | null;
  company: CompanyRowLike | null;
  client: ClientRowLike | null;
  letterDate: string | null;
  invoiceDate: string | null;
}): Promise<Uint8Array> {
  const { design, ...rest } = input;
  return renderWithDesign('dunning', design, dunningDocument(rest));
}
