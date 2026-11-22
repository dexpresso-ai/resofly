import { supabase } from '../lib/supabase';
import { throwFunctionError } from '../lib/functionErrors';
import type { CreditNote, InvoiceRefund, UUID } from '../types';

/**
 * Een verstuurde factuur herstellen: crediteren wat openstaat, terugbetalen met
 * een reden, en vóór het versturen weten waar de boeking terechtkomt. Alles
 * loopt via invoice-workflow; de server rekent en beslist, hier staat alleen
 * de aanroep.
 */

/** Waar komt de boeking van deze factuur terecht als je hem nu verstuurt? */
export type InvoiceBookingNotice = {
  /**
   * closed_period: de factuurdatum valt in een afgesloten btw-tijdvak of boekjaar;
   * future_date: de factuurdatum ligt na vandaag;
   * before_start: de factuurdatum ligt vóór de startdatum van de boekhouding (wordt niet geboekt).
   */
  kind: 'closed_period' | 'future_date' | 'before_start';
  invoiceDate: string;
  /** De dag waarop omzet en btw geboekt worden; null: de factuur komt niet in de boeken. */
  bookingDate: string | null;
  message: string;
  advice: string;
};

/**
 * Vraagt de server vóór het versturen of de boeking op de factuurdatum komt.
 * Null: ja, niets te melden. De server weigert het versturen hier niet om; het
 * gaat erom dat je het weet voordat de factuur de deur uit is en vastligt.
 */
export async function previewInvoiceSend(organizationId: UUID, invoiceId: UUID): Promise<InvoiceBookingNotice | null> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'previewInvoiceSend', organizationId, invoiceId },
  });
  if (error) await throwFunctionError(error, 'De factuur kon niet worden gecontroleerd.');
  if (!data?.ok) throw new Error(data?.error || 'De factuur kon niet worden gecontroleerd.');
  return (data.bookingNotice ?? null) as InvoiceBookingNotice | null;
}

/**
 * Uitgeven zonder mail: voor wie de pdf zelf mailt, print of in een portaal
 * zet. De server controleert hetzelfde als bij versturen (btw-nummer bij ICP of
 * verlegd, 0% met een reden, KOR), maakt de pdf en legt hem vast als de
 * verzonden versie. Daarna is de factuur geboekt en ligt hij vast. Tot 22
 * november 2026 ging dit met "Verzonden" in het statusveld, zonder controles
 * en zonder pdf.
 */
export async function issueInvoiceWithoutEmail(organizationId: UUID, invoiceId: UUID): Promise<{ bookingNotice: InvoiceBookingNotice | null }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'issueInvoiceWithoutEmail', organizationId, invoiceId },
  });
  if (error) await throwFunctionError(error, 'De factuur kon niet worden uitgegeven.');
  if (!data?.ok) throw new Error(data?.error || 'De factuur kon niet worden uitgegeven.');
  return { bookingNotice: (data.bookingNotice ?? null) as InvoiceBookingNotice | null };
}

/** Wat er op een factuur te crediteren valt, zoals het grootboek het ziet. */
export type InvoiceCreditState = {
  number: string;
  status: string;
  totalCents: number;
  /** false: de factuur staat niet in het grootboek (van vóór de startdatum). */
  booked: boolean;
  /** Wat nog openstaat; meer dan dit kun je niet crediteren. */
  openCents: number;
  creditedCents: number;
  paidCents: number;
};

export async function loadInvoiceCreditState(organizationId: UUID, invoiceId: UUID): Promise<InvoiceCreditState> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'previewInvoiceCredit', organizationId, invoiceId },
  });
  if (error) await throwFunctionError(error, 'Het openstaande bedrag kon niet worden opgehaald.');
  if (!data?.ok) throw new Error(data?.error || 'Het openstaande bedrag kon niet worden opgehaald.');
  return data.credit as InvoiceCreditState;
}

export type CreditInvoiceInput = {
  /** Leeg: alles wat nog openstaat. */
  amountCents?: number;
  reason?: string;
  /** false: interne creditnota (afboeken als oninbaar); de klant krijgt geen mail. */
  sendToClient?: boolean;
};

export type CreditInvoiceResult = {
  creditNote: CreditNote | null;
  /** De status van de factuur daarna. */
  status: string;
  creditedCents: number;
  remainingCents: number;
  paidCents: number;
  sentToClient: boolean;
  /** Eén zin over wat er gebeurd is. */
  summary: string;
  warnings: string[];
};

/**
 * Crediteert wat er op een verstuurde factuur nog openstaat, of een deel
 * daarvan. Staat er daarna niets meer open, dan is de factuur afgehandeld:
 * geannuleerd (niets betaald), betaald (de rest was betaald) of afgeboekt
 * (oninbaar, zonder mail aan de klant).
 */
export async function creditInvoiceAmount(organizationId: UUID, invoiceId: UUID, input: CreditInvoiceInput = {}): Promise<CreditInvoiceResult> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'creditInvoice', organizationId, invoiceId, ...input },
  });
  if (error) await throwFunctionError(error, 'Crediteren mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Crediteren mislukt');
  return data as CreditInvoiceResult;
}

/**
 * Waarom betaal je terug?
 *  - sale: de verkoop gaat (deels) niet door. Creditfactuur; omzet en btw gaan terug.
 *  - overpayment: de klant betaalde te veel of dubbel. Alleen geld terug; de
 *    factuur klopt en blijft betaald.
 */
export type RefundPurpose = 'sale' | 'overpayment';

export type RefundInvoiceResult = {
  refund: InvoiceRefund;
  creditNote: CreditNote | null;
  purpose: RefundPurpose;
  /** Hoe je de uitgaande betaling bij Bank boekt. */
  bookingHint: string | null;
};

export async function refundInvoice(
  organizationId: UUID,
  invoiceId: UUID,
  input: { amountCents: number; purpose: RefundPurpose; reason?: string; idempotencyKey?: string; kind?: 'manual' | 'mollie' },
): Promise<RefundInvoiceResult> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'createInvoiceRefund', organizationId, invoiceId, ...input },
  });
  if (error) await throwFunctionError(error, 'Terugbetaling registreren mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Terugbetaling registreren mislukt');
  return data as RefundInvoiceResult;
}

/**
 * Geeft een terugbetaling zonder creditfactuur alsnog een creditfactuur (omzet
 * en btw gaan dan terug). Voor terugbetalingen van vóór 19 november, en voor
 * wie "te veel betaald" koos terwijl de verkoop toch verviel.
 */
export async function issueCreditNoteForRefund(organizationId: UUID, refundId: UUID): Promise<{ refund: InvoiceRefund; creditNote: CreditNote | null; alreadyIssued: boolean }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'issueRefundCreditNote', organizationId, refundId },
  });
  if (error) await throwFunctionError(error, 'Creditfactuur maken mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Creditfactuur maken mislukt');
  return data as { refund: InvoiceRefund; creditNote: CreditNote | null; alreadyIssued: boolean };
}
