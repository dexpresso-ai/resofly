import type { Client, EInvoiceChannel, InvoiceEmailDelivery } from '../types';

/**
 * E-facturatie per klant, zoals het scherm hem nodig heeft.
 *
 * De regels zelf liggen op de server (supabase/functions/_shared/eInvoicing.ts
 * en de UBL-validatie in ubl.ts): die beslist bij het versturen. Dit is de
 * spiegel voor de browser — welk adres er in het verzendvenster staat, en welke
 * gegevens er bij de klant nog ontbreken, zodat je dat al in het klantformulier
 * ziet en niet pas bij het versturen.
 */

type EInvoiceClient = Pick<Client, 'email'> & { e_invoicing_enabled?: boolean | null; e_invoice_email?: string | null; e_invoice_channel?: string | null };

/** Gaan facturen aan deze klant als e-factuur? */
export function clientWantsEInvoice(client: EInvoiceClient | null | undefined): boolean {
  return client?.e_invoicing_enabled === true;
}

/** Langs welke weg de e-factuur gaat, of null zonder e-facturatie. Onbekend = per mail, net als op de server. */
export function clientEInvoiceChannel(client: EInvoiceClient | null | undefined): EInvoiceChannel | null {
  if (!clientWantsEInvoice(client)) return null;
  return client?.e_invoice_channel === 'mollie' ? 'mollie' : 'email';
}

/** Het adres waar een factuur heen gaat: bij e-facturatie het e-factuuradres, anders het gewone. */
export function invoiceRecipientFor(client: EInvoiceClient | null | undefined): string {
  if (!client) return '';
  const eInvoiceAddress = clientWantsEInvoice(client) ? String(client.e_invoice_email ?? '').trim() : '';
  return eInvoiceAddress || String(client.email ?? '').trim();
}

export function isValidEmail(value: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}

const NETHERLANDS = new Set(['nl', 'nld', 'nederland', 'netherlands', 'the netherlands', 'holland']);
const BELGIUM = new Set(['be', 'bel', 'belgie', 'belgium', 'belgique', 'belgien']);
const GERMANY = new Set(['de', 'deu', 'duitsland', 'germany', 'deutschland', 'allemagne']);

/** NL, BE of DE — de landen waar Mollie e-facturen tussen verstuurt — of null. */
function mollieCountry(country: string): 'NL' | 'BE' | 'DE' | null {
  const key = country.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (NETHERLANDS.has(key)) return 'NL';
  if (BELGIUM.has(key)) return 'BE';
  if (GERMANY.has(key)) return 'DE';
  return null;
}

/** De velden uit het klantformulier waar een e-factuur op leunt. */
export type EInvoiceReadinessInput = {
  name?: string | null;
  email?: string | null;
  e_invoice_email?: string | null;
  client_kind?: string | null;
  address_line1?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  /** 'mollie' = via Mollie over Peppol: dan gelden de eisen van Mollie. */
  channel?: EInvoiceChannel | null;
};

/**
 * Wat er bij de klant nog ontbreekt voor een e-factuur.
 *
 * `missing` houdt het versturen tegen (de server weigert dan, met dezelfde
 * reden); `advice` niet, maar zonder KVK- of btw-nummer kan de e-factuur later
 * niet via Peppol. Bewust grof: of een land te herleiden is en of de
 * btw-regels kloppen, beoordeelt de server per factuur.
 */
export function eInvoiceReadiness(input: EInvoiceReadinessInput): { missing: string[]; advice: string[] } {
  const text = (value: string | null | undefined) => String(value ?? '').trim();
  if (input.channel === 'mollie') return mollieReadiness(input, text);
  const missing: string[] = [];
  const advice: string[] = [];

  if (!text(input.name)) missing.push('klantnaam');
  if (!isValidEmail(input.e_invoice_email) && !isValidEmail(input.email)) missing.push('een e-factuuradres of e-mailadres');
  const country = text(input.country);
  if (!country) missing.push('land');
  const isNl = NETHERLANDS.has(country.toLowerCase());
  if (isNl) {
    if (!text(input.address_line1)) missing.push('adres');
    if (!text(input.postal_code)) missing.push('postcode');
    if (!text(input.city)) missing.push('plaats');
  }
  if (input.client_kind !== 'consumer') {
    const kvkDigits = text(input.kvk_number).replace(/\D/g, '');
    if (isNl && kvkDigits.length < 8) advice.push('KVK-nummer (verplicht voor e-facturen via Peppol aan Nederlandse bedrijven)');
    else if (!isNl && kvkDigits.length < 8 && text(input.vat_number).replace(/[^A-Za-z0-9]/g, '').length < 8) {
      advice.push('btw- of ondernemingsnummer (nodig voor e-facturen via Peppol)');
    }
  }
  return { missing, advice };
}

/**
 * Via Mollie gelden strengere eisen (die van Mollie en Peppol): alleen tussen
 * bedrijven in Nederland, België en Duitsland, met een volledig adres en het
 * nummer waarmee de klant op Peppol staat. Wat hier ontbreekt, weigert de server.
 */
function mollieReadiness(input: EInvoiceReadinessInput, text: (value: string | null | undefined) => string): { missing: string[]; advice: string[] } {
  const missing: string[] = [];
  if (!text(input.name)) missing.push('klantnaam');
  if (!isValidEmail(input.e_invoice_email) && !isValidEmail(input.email)) missing.push('een e-factuuradres of e-mailadres (voor de PDF-kopie)');
  if (input.client_kind === 'consumer') missing.push('een zakelijke klant (Mollie verstuurt e-facturen alleen naar bedrijven)');
  const country = text(input.country);
  const code = country ? mollieCountry(country) : null;
  if (!code) missing.push(country ? `een klant in Nederland, België of Duitsland (niet ${country})` : 'land');
  if (!text(input.address_line1)) missing.push('adres');
  if (!text(input.postal_code)) missing.push('postcode');
  if (!text(input.city)) missing.push('plaats');
  const kvk = text(input.kvk_number).replace(/\D/g, '');
  const vat = text(input.vat_number).replace(/[^A-Za-z0-9]/g, '');
  if (code === 'DE' && vat.length < 8) missing.push('btw-nummer (USt-IdNr.) — daarmee staat een Duitse klant op Peppol');
  else if (kvk.length < 8 && vat.length < 8) missing.push('KVK-nummer (of ondernemingsnummer) of btw-nummer — het nummer waarmee de klant op Peppol staat');
  return { missing, advice: [] };
}

/** De laatste e-factuurverzending van een factuur (per mail of via Mollie), als hij ooit als e-factuur ging. */
export function latestEInvoiceDelivery(deliveries: InvoiceEmailDelivery[], invoiceId: string): InvoiceEmailDelivery | null {
  return deliveries.find((delivery) => delivery.invoice_id === invoiceId
    && (delivery.delivery_channel === 'e_invoice_email' || delivery.delivery_channel === 'e_invoice_mollie')
    && delivery.status !== 'failed') ?? null;
}

/** Mollies status van zijn factuur, in gewone taal. */
export function mollieStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'draft': return 'concept';
    case 'issuing': return 'wordt uitgegeven';
    case 'issued': return 'uitgegeven';
    case 'pending-payment': return 'betaling loopt';
    case 'paid': return 'betaald';
    case 'overdue': return 'te laat';
    case 'payment_reversed': return 'betaling teruggedraaid';
    case 'cancelled':
    case 'canceled': return 'geannuleerd';
    case 'expired': return 'verlopen';
    case 'failed': return 'mislukt';
    default: return status ? status : 'nog onbekend';
  }
}

/** De Peppol-aflevering volgens Mollie, in gewone taal. */
export function peppolStatusLabel(status: string | null | undefined): string {
  if (status === 'issued') return 'afgeleverd';
  if (status === 'failed') return 'mislukt';
  if (status === 'issuing') return 'wordt afgeleverd';
  return 'nog onbekend';
}

const MOLLIE_SETTLED = new Set(['paid', 'cancelled', 'canceled', 'expired', 'failed']);

/**
 * Moet de stand bij Mollie (weer) opgehaald worden? Niet als er niets meer
 * verandert (betaald, geannuleerd …, en Peppol is klaar), en niet vaker dan
 * eens per `maxAgeMs`.
 */
export function mollieNeedsSync(delivery: InvoiceEmailDelivery | null | undefined, now = Date.now(), maxAgeMs = 10 * 60 * 1000): boolean {
  if (!delivery || delivery.delivery_channel !== 'e_invoice_mollie' || delivery.status === 'failed') return false;
  if (MOLLIE_SETTLED.has(String(delivery.external_status ?? '')) && delivery.e_invoice_status !== 'issuing') return false;
  const last = Date.parse(String(delivery.external_synced_at ?? ''));
  return !Number.isFinite(last) || now - last > maxAgeMs;
}
