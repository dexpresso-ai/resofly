// ============================================================
// E-facturatie per klant — de regels, los van het versturen zelf.
//
// Per klant staat e-facturatie aan of uit (clients.e_invoicing_enabled). Staat
// hij aan, dan gaat elke factuur en creditnota aan die klant als e-factuur,
// langs één van twee wegen (clients.e_invoice_channel):
//   email  — de UBL met de PDF erin, per mail naar het e-factuuradres;
//   mollie — via Mollie (Sales Invoices API) over het Peppol-netwerk, met de
//            PDF als kopie per mail. Mollie geeft de factuur uit en int hem.
// Staat e-facturatie uit, dan krijgt de klant alleen de PDF.
//
// Boven de klant staat de keuze van de organisatie (Instellingen → Online
// betalen, company_settings.invoice_send_method): per e-mail of via Mollie.
// Per e-mail doet Mollie nergens mee, ook niet bij een klant op "via Mollie".
//
// Pure functies (geen Deno, geen database): invoice-workflow gebruikt ze bij
// het versturen, eInvoicing.test.ts legt ze vast.
// ============================================================

import type { UblEmbeddedDocument } from './ubl.ts';

/**
 * email            = factuur-PDF per mail;
 * e_invoice_email  = e-factuur (UBL met PDF) per mail;
 * e_invoice_mollie = e-factuur via Mollie over Peppol.
 */
export type InvoiceDeliveryChannel = 'email' | 'e_invoice_email' | 'e_invoice_mollie';

/** Hoe een klant met e-facturatie zijn e-facturen krijgt. */
export type EInvoiceChannel = 'email' | 'mollie';

/**
 * Hoe de organisatie haar facturen verstuurt:
 *   email  = ResoFly mailt ze, zonder Mollie (de klant betaalt per overboeking);
 *   mollie = met een betaallink van Mollie, en de e-factuur via Mollie bij een
 *            klant die daarop staat.
 */
export type InvoiceSendMethod = 'email' | 'mollie';

/** De opgeslagen keuze, of null: nog niets gekozen (of een waarde die we niet kennen). */
export function storedInvoiceSendMethod(value: unknown): InvoiceSendMethod | null {
  return value === 'email' || value === 'mollie' ? value : null;
}

/**
 * Mag Mollie meedoen: een betaallink maken, een e-factuur via Mollie uitgeven?
 * Alleen "per e-mail" zet hem uit. Nog niets gekozen is zoals het altijd was:
 * dan beslist de koppeling, en die controleert de aanroeper zelf (zonder
 * sleutel geen link). Voor deze keuze kon je Mollie alleen ontwijken door hem
 * te ontkoppelen; daarmee verdween ook het nakijken van lopende betalingen.
 */
export function mollieInvoicingAllowed(stored: unknown): boolean {
  return storedInvoiceSendMethod(stored) !== 'email';
}

/** Wat er nu geldt: de keuze, of (nog niets gekozen) via Mollie zodra Mollie gekoppeld is. */
export function effectiveInvoiceSendMethod(stored: unknown, mollieConnected: boolean): InvoiceSendMethod {
  return storedInvoiceSendMethod(stored) ?? (mollieConnected ? 'mollie' : 'email');
}

export interface EInvoiceClientSettings {
  email?: string | null;
  e_invoicing_enabled?: boolean | null;
  e_invoice_email?: string | null;
  e_invoice_channel?: string | null;
}

/** Gaan facturen aan deze klant als e-factuur? */
export function clientWantsEInvoice(client: EInvoiceClientSettings): boolean {
  return client.e_invoicing_enabled === true;
}

/**
 * Langs welke weg een factuur aan deze klant gaat. Verstuurt de organisatie
 * per e-mail (mollieAllowed false), dan gaat een klant op "via Mollie" als
 * e-factuur per mail: hij wil een e-factuur, alleen Mollie doet niet mee.
 */
export function invoiceDeliveryChannel(client: EInvoiceClientSettings, options: { mollieAllowed?: boolean } = {}): InvoiceDeliveryChannel {
  if (!clientWantsEInvoice(client)) return 'email';
  if (options.mollieAllowed === false) return 'e_invoice_email';
  return client.e_invoice_channel === 'mollie' ? 'e_invoice_mollie' : 'e_invoice_email';
}

/**
 * Naar welk adres een factuur gaat. Een adres dat de gebruiker zelf koos gaat
 * altijd voor. Anders: bij e-facturatie het e-factuuradres van de klant, en als
 * dat leeg is (of e-facturatie uit staat) het gewone e-mailadres.
 */
export function defaultInvoiceRecipient(client: EInvoiceClientSettings, chosen?: unknown): string {
  const explicit = typeof chosen === 'string' ? chosen.trim().toLowerCase() : '';
  if (explicit) return explicit;
  const eInvoiceAddress = clientWantsEInvoice(client) ? String(client.e_invoice_email ?? '').trim().toLowerCase() : '';
  return eInvoiceAddress || String(client.email ?? '').trim().toLowerCase();
}

/**
 * De PDF als ingesloten bijlage van de e-factuur (BT-122..BT-125). De referentie
 * is het document- of factuurnummer, de omschrijving zegt wat het is.
 */
export function embeddedPdf(input: { reference: string; label: string; fileName: string; base64: string }): UblEmbeddedDocument {
  return {
    id: input.reference,
    description: `${input.label} (PDF)`,
    fileName: input.fileName,
    mimeCode: 'application/pdf',
    base64: input.base64,
  };
}
