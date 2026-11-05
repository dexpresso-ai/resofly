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
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  buildDocumentData,
  documentAmounts,
  documentAssetsFromSettings,
  parseDocumentLayouts,
  renderDocumentPdf,
  resolveDocumentLayout,
  resolveDocumentStyle,
  type ClientRowLike,
  type CompanyRowLike,
  type DocumentKind,
  type SalesLineLike,
} from './documentLayout.ts';

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
    notes: input.notes,
    projectName: input.projectName,
    quoteNumber: input.quoteNumber,
    onlineLink: input.onlineLink ?? null,
  });
  const layouts = parseDocumentLayouts(input.design?.document_layouts);
  const assets = documentAssetsFromSettings(input.design);
  return renderDocumentPdf(PdfLib, {
    layout: resolveDocumentLayout(layouts, input.kind, { letterhead: Boolean(assets.letterhead) }),
    data,
    style: resolveDocumentStyle(input.design, layouts.font),
    assets,
    onWarning: (message, error) => console.warn(`documentpdf: ${message}`, error instanceof Error ? error.message : error),
  });
}
