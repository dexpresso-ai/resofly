// ============================================================
// Gedeelde, zelfstandige Mollie-checkout voor factuurbetalingen door de klant.
//
// Spiegelt de orchestratie van invoice-workflow's createInvoicePaymentCheckout,
// maar zonder de payment-STATE te dupliceren: alle state-overgangen lopen via
// dezelfde service-role SQL-RPC's (begin_/complete_/fail_invoice_payment_checkout)
// en dezelfde stabiele idempotency-key `invoice-<id>-active-payment`. Daardoor is
// er hooguit één actieve betaling per factuur, ongeacht of de medewerkers-app of
// het klantportaal de link aanmaakt, en blijft de money-logica één bron van waarheid.
//
// Gebruikt door de client-portal edge function zodat een geverifieerde
// portaalklant een factuur on-demand kan betalen. De verificatie van
// factuureigendom gebeurt door de aanroeper (client-portal) vóór deze helper.
// ============================================================

import { decryptSecret } from './mollieSecrets.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

type InvoiceLine = { id?: string; description?: string; quantity?: number; unit_price?: number; vat?: number };

export type PortalCheckoutResult =
  | { ok: true; checkoutUrl: string; providerPaymentId: string; status: string; mock: boolean; reused: boolean }
  | { ok: false; status: number; error: string };

const ALLOW_MOCK = (Deno.env.get('INVOICE_MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
const MOLLIE_WEBHOOK_URL = Deno.env.get('INVOICE_MOLLIE_WEBHOOK_URL') || Deno.env.get('MOLLIE_WEBHOOK_URL') || '';
const MOLLIE_WEBHOOK_SECRET = Deno.env.get('INVOICE_MOLLIE_WEBHOOK_SECRET') || Deno.env.get('MOLLIE_WEBHOOK_SECRET') || '';
const CHECKOUT_TTL_MINUTES = parsePositiveInt(Deno.env.get('INVOICE_CHECKOUT_TTL_MINUTES'), 30);

const UNPAYABLE_STATUSES = ['paid', 'cancelled', 'void', 'written_off', 'refunded'];

/**
 * Maakt (of hergebruikt) een Mollie-betaallink voor een factuur die de klant al
 * geverifieerd bezit. Geeft een resultaatobject terug i.p.v. te throwen zodat de
 * aanroeper verwachte condities (geen Mollie gekoppeld, al betaald) netjes op de
 * juiste HTTP-status kan mappen.
 *
 * `redirectUrl` is waar Mollie de klant na betalen naartoe stuurt (het portaal).
 * De definitieve betaalstatus komt hoe dan ook via de Mollie-webhook binnen.
 */
export async function createPortalInvoiceCheckout(
  supabaseAdmin: SupabaseAdmin,
  input: { organizationId: string; invoiceId: string; actorUserId: string; redirectUrl: string },
): Promise<PortalCheckoutResult> {
  const { organizationId, invoiceId, actorUserId, redirectUrl } = input;

  const { data: invoice, error: invoiceError } = await supabaseAdmin
    .from('invoices')
    .select('id,number,status,client_id,lines')
    .eq('id', invoiceId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (invoiceError) return { ok: false, status: 500, error: describeError(invoiceError) };
  if (!invoice) return { ok: false, status: 404, error: 'Factuur niet gevonden.' };
  if (invoice.status === 'draft') return { ok: false, status: 409, error: 'Deze factuur is nog een concept en kan niet worden betaald.' };
  if (UNPAYABLE_STATUSES.includes(invoice.status)) return { ok: false, status: 409, error: 'Voor deze factuur kan geen betaallink worden aangemaakt.' };
  if (!invoice.client_id) return { ok: false, status: 422, error: 'Deze factuur heeft geen klant gekoppeld.' };

  const amountCents = calculateTotalCents(Array.isArray(invoice.lines) ? invoice.lines : []);
  if (amountCents <= 0) return { ok: false, status: 422, error: 'Factuurbedrag moet groter zijn dan 0.' };

  // Bestaande, herbruikbare open betaallink? Meteen teruggeven — nooit dubbel
  // aanmaken (zelfde gedrag als de medewerkers-app).
  const existing = await loadLatestOpenPayment(supabaseAdmin, organizationId, invoiceId);
  if (existing?.provider_checkout_url && isReusableCheckoutUrl(existing.provider_checkout_url)) {
    return {
      ok: true,
      checkoutUrl: existing.provider_checkout_url,
      providerPaymentId: existing.provider_payment_id || '',
      status: existing.status,
      mock: (existing.provider_payment_id || '').startsWith('mock_'),
      reused: true,
    };
  }
  if (existing?.status === 'creating' && !existing.provider_checkout_url) {
    return { ok: false, status: 409, error: 'Er wordt al een betaallink voor deze factuur voorbereid. Probeer het over enkele seconden opnieuw.' };
  }

  const checkoutExpiresAt = new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString();
  // Server-side stabiele idempotency-key: identiek aan invoice-workflow, zodat een
  // dubbelklik (of gelijktijdige medewerkers-actie) niet meerdere actieve Mollie-
  // betalingen voor dezelfde factuur oplevert.
  const idempotencyKey = `invoice-${invoice.id}-active-payment`;

  const beginResult = await beginPayment(supabaseAdmin, {
    invoiceId, organizationId, actorUserId, amountCents, idempotencyKey, checkoutExpiresAt,
    metadata: { source: 'client_portal', redirectUrl },
  });
  if (!beginResult.ok) return beginResult;
  const payment = beginResult.payment;
  if (payment.provider_checkout_url) {
    return {
      ok: true,
      checkoutUrl: payment.provider_checkout_url,
      providerPaymentId: payment.provider_payment_id || '',
      status: 'open',
      mock: (payment.provider_payment_id || '').startsWith('mock_'),
      reused: true,
    };
  }

  let providerPaymentId = '';
  let checkoutUrl = '';
  let providerStatus = 'open';
  let metadata: Record<string, unknown> = {};

  try {
    if (ALLOW_MOCK) {
      providerPaymentId = `mock_invoice_payment_${crypto.randomUUID()}`;
      checkoutUrl = redirectUrl;
      metadata = { mock: true, source: 'client_portal' };
    } else {
      const orgKey = await resolveOrganizationMollieKey(supabaseAdmin, organizationId);
      if (!orgKey) return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 409, 'Online betalen is voor deze factuur (nog) niet beschikbaar. Neem contact op met je leverancier of gebruik de overschrijvingsgegevens.');
      if (!MOLLIE_WEBHOOK_URL) return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 500, 'INVOICE_MOLLIE_WEBHOOK_URL of MOLLIE_WEBHOOK_URL ontbreekt.');

      const webhookUrl = MOLLIE_WEBHOOK_SECRET
        ? `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}webhook=mollie&secret=${encodeURIComponent(MOLLIE_WEBHOOK_SECRET)}`
        : `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}webhook=mollie`;

      const mollieResponse = await fetch('https://api.mollie.com/v2/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${orgKey.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(idempotencyKey) },
        body: JSON.stringify({
          amount: { currency: 'EUR', value: (amountCents / 100).toFixed(2) },
          description: `Factuur ${invoice.number}`,
          redirectUrl,
          webhookUrl,
          metadata: { organizationId, invoiceId, invoiceNumber: invoice.number, paymentRecordId: payment.id, source: 'client_portal' },
        }),
      });
      const molliePayload = (await mollieResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!mollieResponse.ok) {
        return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 502, `Mollie kon geen betaallink maken: ${String(molliePayload.detail || molliePayload.title || mollieResponse.statusText)}`);
      }
      providerPaymentId = String(molliePayload.id || '').trim();
      checkoutUrl = String(((molliePayload._links as Record<string, { href?: string }> | undefined)?.checkout?.href) || '').trim();
      providerStatus = String(molliePayload.status || 'open');
      metadata = { mollie: molliePayload, source: 'client_portal' };
      if (!providerPaymentId || !checkoutUrl) {
        return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 502, 'Mollie gaf geen payment-id of checkout-url terug.');
      }
    }

    const completeResult = await completePayment(supabaseAdmin, payment.id, organizationId, actorUserId, providerPaymentId, checkoutUrl, providerStatus, metadata);
    if (!completeResult.ok) return completeResult;
    return { ok: true, checkoutUrl, providerPaymentId, status: providerStatus, mock: providerPaymentId.startsWith('mock_'), reused: false };
  } catch (error) {
    return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 502, `Mollie-checkout kon niet worden afgerond: ${describeError(error)}`);
  }
}

// ── RPC-wrappers (identiek aan invoice-workflow, zelfde service-role RPC's) ──

async function beginPayment(
  supabaseAdmin: SupabaseAdmin,
  input: { invoiceId: string; organizationId: string; actorUserId: string; amountCents: number; idempotencyKey: string; checkoutExpiresAt: string; metadata: Record<string, unknown> },
): Promise<{ ok: true; payment: { id: string; provider_checkout_url: string | null; provider_payment_id: string | null } } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabaseAdmin.rpc('begin_invoice_payment_checkout', {
    p_invoice_id: input.invoiceId,
    p_organization_id: input.organizationId,
    p_actor_user_id: input.actorUserId,
    p_amount_cents: input.amountCents,
    p_public_token_hash: null,
    p_public_token_expires_at: null,
    p_currency: 'EUR',
    p_idempotency_key: input.idempotencyKey,
    p_checkout_expires_at: input.checkoutExpiresAt,
    p_metadata: input.metadata,
  });
  if (error) return { ok: false, status: 500, error: describeError(error) };
  return { ok: true, payment: data as { id: string; provider_checkout_url: string | null; provider_payment_id: string | null } };
}

async function completePayment(
  supabaseAdmin: SupabaseAdmin,
  paymentRecordId: string, organizationId: string, actorUserId: string,
  providerPaymentId: string, checkoutUrl: string, status: string, metadata: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { error } = await supabaseAdmin.rpc('complete_invoice_payment_checkout', {
    p_payment_record_id: paymentRecordId,
    p_organization_id: organizationId,
    p_actor_user_id: actorUserId,
    p_provider_payment_id: providerPaymentId,
    p_provider_checkout_url: checkoutUrl,
    p_status: status,
    p_metadata: metadata,
  });
  if (error) return { ok: false, status: 500, error: describeError(error) };
  return { ok: true };
}

async function failAndReturn(
  supabaseAdmin: SupabaseAdmin,
  paymentRecordId: string, organizationId: string, actorUserId: string, status: number, message: string,
): Promise<{ ok: false; status: number; error: string }> {
  const { error } = await supabaseAdmin.rpc('fail_invoice_payment_checkout', {
    p_payment_record_id: paymentRecordId,
    p_organization_id: organizationId,
    p_actor_user_id: actorUserId,
    p_error_message: message,
    p_metadata: { source: 'client_portal' },
    p_retry_after_seconds: 300,
    p_max_retries: 5,
  });
  if (error) console.warn('client-portal payment checkout failure registration failed', describeError(error));
  return { ok: false, status, error: message };
}

async function loadLatestOpenPayment(
  supabaseAdmin: SupabaseAdmin, organizationId: string, invoiceId: string,
): Promise<{ id: string; provider_checkout_url: string | null; provider_payment_id: string | null; status: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,provider_checkout_url,provider_payment_id,status')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .in('status', ['creating', 'open', 'pending', 'authorized'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as { id: string; provider_checkout_url: string | null; provider_payment_id: string | null; status: string } | null;
}

/**
 * Heeft deze organisatie een eigen Mollie-account gekoppeld zodat online betalen
 * mogelijk is? Gebruikt door de portaal-payload om vooraf te tonen of "Betaal nu"
 * of alleen de overschrijvingsgegevens verschijnen. In mock-modus (lokale dev)
 * is online betalen altijd "beschikbaar".
 */
export async function orgHasInvoiceMollie(supabaseAdmin: SupabaseAdmin, organizationId: string): Promise<boolean> {
  if (ALLOW_MOCK) return true;
  const { data, error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .select('status')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error || !data) return false;
  return data.status === 'connected';
}

async function resolveOrganizationMollieKey(supabaseAdmin: SupabaseAdmin, organizationId: string): Promise<{ apiKey: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .select('status,api_key_encrypted')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { status?: string; api_key_encrypted?: string | null };
  if (row.status !== 'connected' || !row.api_key_encrypted) return null;
  try {
    const apiKey = await decryptSecret(row.api_key_encrypted);
    if (!apiKey) return null;
    return { apiKey };
  } catch (decryptError) {
    console.error('client-portal could not decrypt organization Mollie key', describeError(decryptError));
    return null;
  }
}

// ── Money-math (verbatim uit invoice-workflow, één-op-één identiek) ──────────

export function calculateTotalCents(lines: InvoiceLine[] = []): number {
  const baseCentsByRate = new Map<number, number>();
  let subtotalCents = 0;
  for (const line of lines) {
    const netCents = toCents(Number(line.quantity || 0) * Number(line.unit_price || 0));
    subtotalCents += netCents;
    const rate = Number(line.vat || 0);
    baseCentsByRate.set(rate, (baseCentsByRate.get(rate) ?? 0) + netCents);
  }
  let vatCents = 0;
  for (const [rate, baseCents] of baseCentsByRate.entries()) {
    vatCents += toCents((baseCents / 100) * (rate / 100));
  }
  return subtotalCents + vatCents;
}

function toCents(euros: number): number {
  if (!Number.isFinite(euros)) return 0;
  const scaled = euros * 100;
  return scaled >= 0 ? Math.round(scaled + 1e-6) : -Math.round(Math.abs(scaled) + 1e-6);
}

// ── Kleine utils (verbatim uit invoice-workflow) ────────────────────────────

function isReusableCheckoutUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (/\/invoice\/[^/?#]+/.test(url.pathname)) return true;
    return /(^|\.)mollie\./i.test(url.hostname) || /checkout\.mollie/i.test(url.hostname);
  } catch {
    return false;
  }
}

function sanitizeIdempotencyKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || crypto.randomUUID();
}

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.code === 'string' && obj.code) parts.push(`(code ${obj.code})`);
    if (typeof obj.details === 'string' && obj.details) parts.push(`details: ${obj.details}`);
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(obj); } catch { /* val terug op String() */ }
  }
  return String(error);
}
