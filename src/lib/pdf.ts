// PDF van een offerte of factuur in de app: het live voorbeeld naast de editor,
// de detailweergave en de knop "Download concept-PDF".
//
// Tekent met dezelfde module als de verstuurde PDF (src/lib/documentLayout.ts,
// gespiegeld in supabase/functions/_shared/). Tot november 2026 had de app hier
// een eigen tekenroutine: die gebruikte wel het briefpapier en de lettergrootte,
// de verstuurde PDF niet, en geen van beide zette het logo erop. Het voorbeeld
// beloofde dus iets wat de klant niet kreeg.
import * as PdfLib from 'pdf-lib';
import { invoiceVatNotes } from './invoiceVatNotes';
import { total } from './format';
import { lineGross, lineNet, toNumber } from './money';
import {
  buildDocumentData,
  documentAssetsFromSettings,
  documentPdfFileName,
  parseDocumentLayouts,
  renderDocumentPdf,
  resolveDocumentLayout,
  resolveDocumentStyle,
  type DocumentLayouts,
} from './documentLayout';
import type { AppData, Client, CompanySettings, Invoice, Quote } from '../types';

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

export interface PdfOptions {
  company?: CompanySettings | null;
  /** Voor de verplichte btw-vermeldingen (verlegd, ICP, export, vrijgesteld). */
  vatCodes?: Array<{ code: string; kind: string; sales_box: string | null }>;
  /** "Project: …" in de documentgegevens, zoals op de verstuurde PDF. */
  projectName?: string | null;
  /** Bij een factuur: het nummer van de offerte waar hij uit komt. */
  quoteNumber?: string | null;
  /** Een opmaak die nog niet is opgeslagen (de editor); anders die uit de instellingen. */
  layouts?: DocumentLayouts | null;
}

/**
 * De opties die het voorbeeld gelijk houden aan de verstuurde PDF: btw-codes,
 * projectnaam en offertenummer komen uit de kern van AppData (geen laadgroep).
 */
export function financePdfOptions(
  data: Pick<AppData, 'companySettings' | 'vatCodes' | 'projects' | 'quotes'>,
  doc: { project_id?: string | null; quote_id?: string | null },
): PdfOptions {
  return {
    company: data.companySettings,
    vatCodes: data.vatCodes,
    projectName: doc.project_id ? data.projects.find(project => project.id === doc.project_id)?.name ?? null : null,
    quoteNumber: doc.quote_id ? data.quotes.find(quote => quote.id === doc.quote_id)?.number ?? null : null,
  };
}

export async function createFinancePDFBytes(doc: Quote | Invoice, kind: 'quote' | 'invoice', client: Client | null, opts: PdfOptions = {}): Promise<Uint8Array> {
  const company = opts.company ?? null;
  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  const totals = total(lines);

  // Verplichte vermeldingen bij 0% of geen btw (art. 35a Wet OB), dezelfde als
  // op de verstuurde factuur. Ontbreekt het btw-nummer van de klant, dan
  // waarschuwt het concept; de server weigert dan te versturen.
  const vatCodeInfo = Object.fromEntries((opts.vatCodes ?? []).map(v => [v.code, { kind: v.kind, salesBox: v.sales_box }]));
  const vat = invoiceVatNotes(lines, vatCodeInfo);
  const vatNotes = [...vat.notes];
  if (kind === 'invoice' && vat.needsCustomerVatNumber && !String(client?.vat_number ?? '').trim()) {
    vatNotes.push(`Let op: bij ${vat.reasons.join(' en ')} hoort het btw-nummer van de klant op de factuur. Vul het in bij de klant voordat je verstuurt.`);
  }

  const data = buildDocumentData({
    kind,
    number: doc.number,
    date: doc.date,
    secondDate: kind === 'quote' ? (doc as Quote).valid_until : (doc as Invoice).due_date,
    company,
    client,
    lines: lines.map(line => ({
      description: line.description,
      quantity: toNumber(line.quantity),
      unitPrice: toNumber(line.unit_price),
      vatRate: toNumber(line.vat),
      net: lineNet(line),
      gross: lineGross(line),
    })),
    totals: { subtotal: totals.subtotal, vat: totals.vat, total: totals.total, vatBreakdown: totals.vatBreakdown },
    vatNotes,
    notes: doc.notes,
    projectName: opts.projectName,
    quoteNumber: opts.quoteNumber,
    // De link naar de online factuur bestaat pas bij versturen.
    onlineLink: null,
  });

  const layouts = parseDocumentLayouts(opts.layouts !== undefined ? opts.layouts : company?.document_layouts);
  const assets = documentAssetsFromSettings(company);
  return renderDocumentPdf(PdfLib, {
    layout: resolveDocumentLayout(layouts, kind, { letterhead: Boolean(assets.letterhead) }),
    data,
    style: resolveDocumentStyle(company, layouts.font),
    assets,
    onWarning: (message, error) => console.warn(message, error),
  });
}

export async function createFinancePDFBlob(doc: Quote | Invoice, kind: 'quote' | 'invoice', client: Client | null, opts: PdfOptions = {}): Promise<Blob> {
  const bytes = await createFinancePDFBytes(doc, kind, client, opts);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([arrayBuffer], { type: 'application/pdf' });
}

export async function exportFinancePDF(
  doc: Quote | Invoice,
  kind: 'quote' | 'invoice',
  client: Client | null,
  opts: PdfOptions = {},
): Promise<void> {
  const blob = await createFinancePDFBlob(doc, kind, client, opts);
  downloadBlob(blob, documentPdfFileName(kind, doc.number));
}
