/**
 * Waar Mollie de status van een FACTUURbetaling naartoe meldt.
 *
 * Waarom dit bestaat: invoice-workflow en de portaalbetaling vielen terug op
 * MOLLIE_WEBHOOK_URL als INVOICE_MOLLIE_WEBHOOK_URL ontbrak. Die staat in
 * .env.example (en in de rapporten) op .../billing?webhook=mollie: de webhook
 * van de abonnementen. Elke factuurbetaling meldde zich dan bij billing, die hem
 * met de platformsleutel niet kon vinden, en geen enkele factuur ging op
 * betaald. INVOICE_MOLLIE_WEBHOOK_URL staat nergens gedocumenteerd.
 *
 * Nu: INVOICE_MOLLIE_WEBHOOK_URL als die er is; anders MOLLIE_WEBHOOK_URL
 * alleen als die echt naar invoice-workflow wijst; anders de standaard-URL van
 * de functie op dit project.
 *
 * Puur: geen Deno. Getest in mollieWebhookUrl.test.ts.
 */
export function invoiceMollieWebhookBase(input: {
  invoiceWebhookUrl?: string | null;
  sharedWebhookUrl?: string | null;
  supabaseUrl?: string | null;
}): string {
  const explicit = String(input.invoiceWebhookUrl ?? '').trim();
  if (explicit) return explicit;
  const shared = String(input.sharedWebhookUrl ?? '').trim();
  if (shared && /\/invoice-workflow(?:[/?#]|$)/.test(shared)) return shared;
  const base = String(input.supabaseUrl ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/functions/v1/invoice-workflow` : '';
}

/** De volledige webhook-URL: basis + ?webhook=mollie (+ &secret=…). */
export function invoiceMollieWebhookUrl(base: string, secret: string | null | undefined): string {
  if (!base) return '';
  const joiner = base.includes('?') ? '&' : '?';
  const withHook = /[?&]webhook=mollie(?:&|$)/.test(base) ? base : `${base}${joiner}webhook=mollie`;
  return secret ? `${withHook}&secret=${encodeURIComponent(secret)}` : withHook;
}
