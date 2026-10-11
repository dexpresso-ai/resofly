// ============================================================
// E-facturatie via Mollie — de Sales Invoices API (Peppol).
//
// Kiest een klant met e-facturatie voor "via Mollie", dan maakt ResoFly de
// factuur bij Mollie aan (POST /v2/sales-invoices, isEInvoice). Mollie geeft hem
// uit, stuurt hem over het Peppol-netwerk naar het boekhoudpakket van de klant,
// mailt een PDF-kopie en int de betaling. Drie gevolgen die ResoFly opvangt:
//   - Mollie geeft een EIGEN factuurnummer (INV-…); het ResoFly-nummer staat in
//     de memo (op de PDF) en in de metadata.
//   - Mollie kent alleen vaste betaaltermijnen en geeft vandaag uit; de
//     factuurdatum en vervaldatum in ResoFly worden daarop gelijkgezet.
//   - Mollie rekent de btw zelf uit; het concept wordt pas uitgegeven als het
//     totaal precies gelijk is aan dat van ResoFly.
//
// Pure functies (geen Deno, geen database), gedekt door mollieSalesInvoice.test.ts.
// De velden volgen het SalesInvoiceRequest-model van Mollie.
// ============================================================

import { computeUblTotals, deriveSalesLineCategory, normalizeCountryCode, toCents, type UblLine, type VatKindRef } from './ubl.ts';

/** Mollie-e-facturatie kan alleen tussen bedrijven in deze landen. */
export const MOLLIE_E_INVOICE_COUNTRIES = ['NL', 'BE', 'DE'] as const;
/** De betaaltermijnen die Mollie kent, in dagen. */
export const MOLLIE_PAYMENT_TERM_DAYS = [7, 14, 30, 45, 60, 90, 120] as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MollieAmount = { currency: string; value: string };
export type MollieSalesInvoiceLine = { description: string; quantity: number; vatRate: string; unitPrice: MollieAmount };

export interface MollieSalesInvoiceSource {
  invoice: {
    id: string; number: string; notes?: string | null; currency?: string | null;
    lines: Array<{ description?: string | null; quantity?: number | null; unit_price?: number | null; vat?: number | null; vat_code?: string | null }>;
  };
  client: {
    id: string; name: string; client_code?: string | null; client_kind?: string | null;
    vat_number?: string | null; kvk_number?: string | null;
    address_line1?: string | null; address_line2?: string | null; postal_code?: string | null; city?: string | null; country?: string | null;
  };
  /** Land van de eigen organisatie (company_settings.country); leeg = Nederland. */
  sellerCountry?: string | null;
  /** Waar Mollie de PDF-kopie heen mailt: het e-factuuradres of het gewone. */
  recipientEmail: string;
  /** Vandaag (JJJJ-MM-DD): Mollie geeft uit op de dag dat het verzoek binnenkomt. */
  issueDate: string;
  /** De gewenste vervaldatum uit ResoFly; Mollie rondt af naar een vaste termijn. */
  dueDate?: string | null;
  vatKinds: Record<string, VatKindRef>;
  korEnabled: boolean;
}

export interface MollieSalesInvoiceDraft {
  /** De body voor POST /v2/sales-invoices (als concept). */
  body: Record<string, unknown>;
  /** Het totaal incl. btw zoals ResoFly het rekent; het concept van Mollie moet hetzelfde zeggen. */
  totalCents: number;
  /** De vervaldatum die bij Mollies termijn hoort (JJJJ-MM-DD). */
  dueDate: string;
  paymentTermDays: number;
  /** Niet blokkerend, wel melden. */
  warnings: string[];
}

const CATEGORY_LABEL: Record<string, string> = {
  E: 'vrijgestelde btw', AE: 'verlegde btw', K: 'intracommunautaire btw (ICP)', G: 'exportbtw (0%, buiten de EU)',
};

/** Euro -> Mollie-bedrag: altijd twee decimalen, als tekst. */
export function mollieAmount(cents: number, currency: string): MollieAmount {
  return { currency, value: (cents / 100).toFixed(2) };
}

/** Mollie-bedrag ({ value: '121.00' }) -> centen; null als het er niet (goed) staat. */
export function mollieAmountCents(amount: unknown): number | null {
  const value = amount && typeof amount === 'object' ? (amount as { value?: unknown }).value : null;
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  return toCents(Number(value));
}

/**
 * De vervaldatum naar een termijn die Mollie kent: de kortste termijn die minstens
 * zo lang is als gevraagd, zodat de klant nooit minder tijd krijgt dan afgesproken.
 * Zonder vervaldatum 30 dagen (de wettelijke termijn tussen bedrijven).
 */
export function molliePaymentTerm(issueDate: string, dueDate?: string | null): { days: number; requestedDays: number | null } {
  if (!dueDate) return { days: 30, requestedDays: null };
  const requested = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${issueDate}T00:00:00Z`)) / DAY_MS);
  if (!Number.isFinite(requested)) return { days: 30, requestedDays: null };
  const days = MOLLIE_PAYMENT_TERM_DAYS.find((term) => term >= requested) ?? MOLLIE_PAYMENT_TERM_DAYS[MOLLIE_PAYMENT_TERM_DAYS.length - 1];
  return { days, requestedDays: requested };
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const normalizeVat = (raw: string | null | undefined): string => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const digitsOnly = (raw: string | null | undefined): string => String(raw ?? '').replace(/\D/g, '');

function formatQuantity(quantity: number): string {
  return String(Math.round(quantity * 10000) / 10000).replace('.', ',');
}

function formatEuro(euros: number): string {
  return `€ ${euros.toFixed(Math.abs(euros * 100 - Math.round(euros * 100)) < 1e-6 ? 2 : 4).replace('.', ',')}`;
}

/**
 * ResoFly-factuur -> concept voor Mollie, of de lijst met wat dat tegenhoudt.
 *
 * Mollie kent per regel alleen een aantal (geheel), een prijs (twee decimalen)
 * en een btw-tarief. Een regel met een gebroken aantal (2,5 uur) of een prijs
 * met meer decimalen wordt één regel met het regeltotaal, met aantal en prijs in
 * de omschrijving — dan klopt het bedrag op de cent. Verlegde, vrijgestelde en
 * ICP-btw kan Mollie niet uitdrukken; zo'n factuur gaat niet via Mollie.
 */
export function buildMollieSalesInvoice(source: MollieSalesInvoiceSource): { draft: MollieSalesInvoiceDraft | null; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { invoice, client } = source;
  const currency = String(invoice.currency || 'EUR').toUpperCase();
  if (currency !== 'EUR') errors.push('Een e-factuur via Mollie kan alleen in euro.');

  // Verkoper en koper moeten allebei in NL, BE of DE zitten.
  const sellerCountry = normalizeCountryCode(source.sellerCountry) ?? (String(source.sellerCountry ?? '').trim() ? null : 'NL');
  if (!sellerCountry || !(MOLLIE_E_INVOICE_COUNTRIES as readonly string[]).includes(sellerCountry)) {
    errors.push('E-facturatie via Mollie kan alleen voor bedrijven in Nederland, België of Duitsland — controleer het land bij Instellingen → Facturatie.');
  }
  const country = normalizeCountryCode(client.country);
  if (!country) {
    errors.push(client.country ? `Het land van de klant ('${client.country}') is onbekend — pas het aan in het klantdossier.` : 'Het land van de klant ontbreekt — vul het in bij de klantgegevens.');
  } else if (!(MOLLIE_E_INVOICE_COUNTRIES as readonly string[]).includes(country)) {
    errors.push(`Mollie verstuurt e-facturen alleen naar klanten in Nederland, België of Duitsland (deze klant: ${country}). Kies bij deze klant "per e-mail".`);
  }
  if (client.client_kind === 'consumer') {
    errors.push('Een e-factuur via Mollie gaat over Peppol en kan alleen naar een bedrijf. Zet de klant op zakelijk, of kies bij deze klant "per e-mail".');
  }
  const name = String(client.name ?? '').trim();
  if (!name) errors.push('De klantnaam ontbreekt.');
  const kvk = digitsOnly(client.kvk_number);
  const vat = normalizeVat(client.vat_number);
  if (kvk.length < 8 && vat.length < 8) {
    errors.push('Mollie heeft het KVK-nummer (of ondernemingsnummer) of het btw-nummer van de klant nodig — het nummer waarmee de klant op Peppol staat.');
  }
  if (country === 'DE' && vat.length < 8) errors.push('Voor een Duitse klant is het btw-nummer (USt-IdNr.) verplicht: daarmee staat hij op Peppol.');
  const street = String(client.address_line1 ?? '').trim();
  const postalCode = String(client.postal_code ?? '').trim();
  const city = String(client.city ?? '').trim();
  if (!street || !postalCode || !city) errors.push('Het adres van de klant (straat, postcode en plaats) is onvolledig — vul het aan in het klantdossier.');
  const email = String(source.recipientEmail ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) errors.push('Er is geen geldig e-mailadres voor de PDF-kopie — vul het e-factuuradres of e-mailadres van de klant in.');

  // Regels.
  const sourceLines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const lines: MollieSalesInvoiceLine[] = [];
  const ublLines: UblLine[] = [];
  sourceLines.forEach((line, index) => {
    const description = String(line.description ?? '').trim() || `Regel ${index + 1}`;
    const label = `Regel ${index + 1} (“${description.slice(0, 60)}”)`;
    const derived = deriveSalesLineCategory({ vat: Number(line.vat || 0), vat_code: line.vat_code ?? null }, source.vatKinds, source.korEnabled);
    if (derived.category !== 'S' && derived.category !== 'Z') {
      errors.push(`${label} heeft ${CATEGORY_LABEL[derived.category] ?? 'een btw-soort'} die Mollie niet op een e-factuur kan zetten — verstuur deze factuur per e-mail.`);
      return;
    }
    const quantity = Number(line.quantity) || 0;
    const unitPrice = Number(line.unit_price) || 0;
    const netCents = toCents(quantity * unitPrice);
    if (quantity === 0) { warnings.push(`${label} heeft aantal 0 en gaat niet mee naar Mollie.`); return; }
    if (netCents < 0 || quantity < 0) {
      errors.push(`${label} heeft een negatief bedrag; kortingsregels kan Mollie zo niet overnemen. Verwerk de korting in de prijs, of verstuur per e-mail.`);
      return;
    }
    const vatRate = derived.vatRate.toFixed(2);
    const exact = Number.isInteger(quantity) && Math.abs(unitPrice * 100 - Math.round(unitPrice * 100)) < 1e-6;
    lines.push(exact
      ? { description: description.slice(0, 255), quantity, vatRate, unitPrice: mollieAmount(toCents(unitPrice), currency) }
      : { description: `${description} (${formatQuantity(quantity)} × ${formatEuro(unitPrice)})`.slice(0, 255), quantity: 1, vatRate, unitPrice: mollieAmount(netCents, currency) });
    ublLines.push({ description, quantity: 1, unitPrice: netCents / 100, vatRate: derived.vatRate, category: derived.category });
  });
  if (sourceLines.length === 0 || (lines.length === 0 && errors.length === 0)) errors.push('De factuur heeft geen regels om te versturen.');

  if (errors.length > 0) return { draft: null, errors };

  const term = molliePaymentTerm(source.issueDate, source.dueDate);
  if (term.requestedDays !== null && term.requestedDays !== term.days) {
    warnings.push(`Mollie kent alleen vaste betaaltermijnen: de klant krijgt ${term.days} dagen in plaats van ${term.requestedDays}.`);
  }
  const notes = String(invoice.notes ?? '').trim();
  const body: Record<string, unknown> = {
    status: 'draft',
    vatScheme: 'standard',
    vatMode: 'exclusive',
    memo: `Factuur ${invoice.number}${notes ? `\n${notes.slice(0, 1000)}` : ''}`,
    metadata: { resofly_invoice_id: invoice.id, resofly_invoice_number: invoice.number },
    paymentTerm: `${term.days} days`,
    recipientIdentifier: String(client.client_code || client.id).slice(0, 100),
    recipient: {
      type: 'business',
      organizationName: name,
      ...(kvk.length >= 8 ? { organizationNumber: kvk } : {}),
      ...(vat.length >= 8 ? { vatNumber: vat } : {}),
      email,
      streetAndNumber: street,
      ...(String(client.address_line2 ?? '').trim() ? { streetAdditional: String(client.address_line2).trim() } : {}),
      postalCode,
      city,
      country,
      locale: country === 'BE' ? 'nl_BE' : country === 'DE' ? 'de_DE' : 'nl_NL',
    },
    lines,
    isEInvoice: true,
  };
  return {
    draft: {
      body,
      totalCents: computeUblTotals(ublLines).grossCents,
      dueDate: addDays(source.issueDate, term.days),
      paymentTermDays: term.days,
      warnings,
    },
    errors: [],
  };
}

/** Wat ResoFly van een Mollie-factuur bijhoudt. */
export interface MollieSalesInvoiceState {
  id: string;
  invoiceNumber: string | null;
  status: string | null;
  /** issuing | issued | failed — de Peppol-aflevering. */
  eInvoiceStatus: 'issuing' | 'issued' | 'failed' | null;
  totalCents: number | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  pdfUrl: string | null;
  paymentUrl: string | null;
}

function linkHref(links: unknown, key: string): string | null {
  const link = links && typeof links === 'object' ? (links as Record<string, unknown>)[key] : null;
  const href = link && typeof link === 'object' ? (link as { href?: unknown }).href : null;
  return typeof href === 'string' && href.startsWith('https://') ? href : null;
}

/** Een antwoord van GET/POST/PATCH /v2/sales-invoices -> de velden die ResoFly bewaart. */
export function readMollieSalesInvoice(payload: Record<string, unknown>): MollieSalesInvoiceState {
  const eInvoiceStatus = String(payload.eInvoiceStatus ?? '');
  return {
    id: String(payload.id ?? ''),
    invoiceNumber: typeof payload.invoiceNumber === 'string' && payload.invoiceNumber ? payload.invoiceNumber : null,
    status: typeof payload.status === 'string' ? payload.status : null,
    eInvoiceStatus: eInvoiceStatus === 'issuing' || eInvoiceStatus === 'issued' || eInvoiceStatus === 'failed' ? eInvoiceStatus : null,
    totalCents: mollieAmountCents(payload.totalAmount),
    issuedAt: typeof payload.issuedAt === 'string' && payload.issuedAt ? payload.issuedAt : null,
    dueAt: typeof payload.dueAt === 'string' && payload.dueAt ? payload.dueAt : null,
    paidAt: typeof payload.paidAt === 'string' && payload.paidAt ? payload.paidAt : null,
    pdfUrl: linkHref(payload._links, 'pdfLink'),
    paymentUrl: linkHref(payload._links, 'invoicePayment'),
  };
}

/**
 * Mag ResoFly deze URL ophalen met de Mollie-sleutel erbij? Alleen de API van
 * Mollie zelf krijgt de sleutel; een andere Mollie-host (een PDF-opslag) wordt
 * zonder sleutel opgehaald, en alles buiten mollie.com niet.
 */
export function mollieFetchPolicy(url: string | null): 'with-key' | 'without-key' | 'refuse' {
  if (!url) return 'refuse';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return 'refuse';
    const host = parsed.hostname.toLowerCase();
    if (host === 'api.mollie.com') return 'with-key';
    return host === 'mollie.com' || host.endsWith('.mollie.com') ? 'without-key' : 'refuse';
  } catch {
    return 'refuse';
  }
}

/** Vandaag (of een ander moment) als JJJJ-MM-DD op Nederlandse tijd — zo dateert Mollie. */
export function amsterdamDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** issuedAt/dueAt van Mollie (een datum of een tijdstip) -> JJJJ-MM-DD, of null. */
export function mollieDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : amsterdamDate(parsed);
}

/**
 * Status van de Mollie-factuur -> status van de betaalregel in ResoFly, of null
 * als er niets verandert. Een teruggedraaide betaling (payment_reversed) neemt
 * ResoFly niet vanzelf over: die staat bij de factuur, de gebruiker beslist.
 */
export function molliePaymentStatus(status: string | null): 'paid' | 'canceled' | 'expired' | 'failed' | null {
  switch (status) {
    case 'paid': return 'paid';
    case 'cancelled':
    case 'canceled': return 'canceled';
    case 'expired': return 'expired';
    case 'failed': return 'failed';
    default: return null;
  }
}

/** Is er bij Mollie niets meer te volgen (betaald, geannuleerd, verlopen of mislukt)? */
export function mollieSalesInvoiceSettled(status: string | null): boolean {
  return molliePaymentStatus(status) !== null;
}

/**
 * Een SHA-256 (hex) -> een UUID in v4-vorm. Mollie wil een UUID als
 * Idempotency-Key; door hem af te leiden krijgt een herhaald verzoek dezelfde.
 */
export function uuidFromHex(hex: string): string {
  const h = hex.toLowerCase().replace(/[^0-9a-f]/g, '').padEnd(32, '0');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * De tekst van de mail die Mollie bij de e-factuur meestuurt (platte tekst). Geen
 * vervaldatum: die rekent Mollie zelf uit en staat op de PDF van Mollie.
 */
export function mollieEmailBody(input: { recipientName?: string | null; invoiceNumber: string; companyName: string; totalLabel: string }): string {
  const name = String(input.recipientName ?? '').trim();
  return [
    name ? `Beste ${name},` : 'Beste klant,',
    '',
    `Hierbij ontvang je factuur ${input.invoiceNumber} van ${input.companyName} (${input.totalLabel}).`,
    'De factuur is ook als e-factuur via het Peppol-netwerk verstuurd, zodat hij direct in je boekhoudpakket binnenkomt.',
    '',
    'Met vriendelijke groet,',
    input.companyName,
  ].join('\n');
}
