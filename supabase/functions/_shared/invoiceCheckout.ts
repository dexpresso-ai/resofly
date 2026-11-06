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
import { invoiceMollieWebhookBase, invoiceMollieWebhookUrl } from './mollieWebhookUrl.ts';
import { mollieCheckoutDecision, readMollieSalesInvoice, type MolliePaymentSource } from './mollieSalesInvoice.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

type InvoiceLine = { id?: string; description?: string; quantity?: number; unit_price?: number; vat?: number };

export type PortalCheckoutResult =
  | { ok: true; checkoutUrl: string; providerPaymentId: string; status: string; mock: boolean; reused: boolean }
  | { ok: false; status: number; error: string };

const ALLOW_MOCK = (Deno.env.get('INVOICE_MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
// Nooit de billing-webhook (abonnementen) als terugval: zie mollieWebhookUrl.ts.
const MOLLIE_WEBHOOK_URL = invoiceMollieWebhookBase({
  invoiceWebhookUrl: Deno.env.get('INVOICE_MOLLIE_WEBHOOK_URL'),
  sharedWebhookUrl: Deno.env.get('MOLLIE_WEBHOOK_URL'),
  supabaseUrl: Deno.env.get('SUPABASE_URL'),
});
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
  input: {
    organizationId: string;
    invoiceId: string;
    actorUserId: string;
    redirectUrl: string;
    /** Specifieke geregistreerde contactpersoon die de betaling start (indien van
     *  toepassing) — puur voor traceerbaarheid in de payment-metadata, geen
     *  invloed op autorisatie (die is al gebeurd bij de aanroeper). */
    actorContact?: { id: string; name: string; email: string } | null;
  },
): Promise<PortalCheckoutResult> {
  const { organizationId, invoiceId, actorUserId, redirectUrl, actorContact } = input;

  const { data: invoice, error: invoiceError } = await supabaseAdmin
    .from('invoices')
    .select('id,number,status,client_id,lines,journal_entry_id')
    .eq('id', invoiceId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (invoiceError) return { ok: false, status: 500, error: describeError(invoiceError) };
  if (!invoice) return { ok: false, status: 404, error: 'Factuur niet gevonden.' };
  if (invoice.status === 'draft') return { ok: false, status: 409, error: 'Deze factuur is nog een concept en kan niet worden betaald.' };
  if (UNPAYABLE_STATUSES.includes(invoice.status)) return { ok: false, status: 409, error: 'Voor deze factuur kan geen betaallink worden aangemaakt.' };
  if (!invoice.client_id) return { ok: false, status: 422, error: 'Deze factuur heeft geen klant gekoppeld.' };

  // Betalen wat er nog openstaat, niet het factuurtotaal: na een deelbetaling of
  // creditnota betaalde de klant anders te veel. Niet in het grootboek → totaal.
  const totalCents = calculateTotalCents(Array.isArray(invoice.lines) ? invoice.lines : []);
  let amountCents = totalCents;
  if (invoice.journal_entry_id) {
    const { data: open, error: openError } = await supabaseAdmin.rpc('invoice_open_receivable_cents', {
      p_organization_id: organizationId,
      p_invoice_id: invoiceId,
    });
    if (openError) return { ok: false, status: 500, error: describeError(openError) };
    const openCents = Number(open);
    if (Number.isFinite(openCents)) {
      amountCents = Math.max(0, Math.min(totalCents, openCents));
      if (amountCents <= 0) return { ok: false, status: 409, error: 'Op deze factuur staat niets meer open.' };
    }
  }
  if (amountCents <= 0) return { ok: false, status: 422, error: 'Factuurbedrag moet groter zijn dan 0.' };

  // Via Mollie als e-factuur uitgegeven? Dan de betaallink van Mollie, maar alleen
  // als die vraagt wat er openstaat. Mollie kent geen deelbetalingen: na een
  // deelbetaling per bank of een creditnota vraagt zijn link nog het hele bedrag,
  // en wie erop klikte betaalde te veel. Dan een eigen link voor het restbedrag.
  // Loopt er bij Mollie een betaling of is hij daar al betaald: geen tweede link.
  const mollieInvoice = await loadMollieSalesInvoiceCheckout(supabaseAdmin, organizationId, invoiceId);
  // Niet weten of hij via Mollie loopt, is geen reden voor een tweede betaling ernaast.
  if (mollieInvoice === 'lookup_failed') return { ok: false, status: 503, error: 'Online betalen lukt nu even niet. Probeer het over een paar minuten opnieuw.' };
  if (mollieInvoice) {
    const decision = mollieCheckoutDecision({
      status: mollieInvoice.status,
      paymentSources: mollieInvoice.paymentSources,
      amountDueCents: mollieInvoice.amountDueCents ?? totalCents,
      paymentUrl: mollieInvoice.checkoutUrl,
      openCents: amountCents,
    });
    if (decision.use === 'mollie') {
      return { ok: true, checkoutUrl: decision.url, providerPaymentId: mollieInvoice.salesInvoiceId ?? '', status: 'open', mock: false, reused: true };
    }
    if (decision.use === 'none') {
      return {
        ok: false, status: 409,
        error: decision.reason === 'paid_at_mollie'
          ? 'Deze factuur is al via Mollie betaald. Het kan even duren voordat je dat hier ziet.'
          : decision.reason === 'payment_pending'
            ? 'Er loopt al een betaling voor deze factuur. Wacht tot die is afgerond.'
            : 'Deze factuur betaal je via de betaallink in de e-mail van Mollie.',
      };
    }
    // Eigen link: de betaalregel van de Mollie-factuur mag die niet in de weg zitten.
    if (mollieInvoice.salesInvoiceId) await retireMollieSalesInvoicePayment(supabaseAdmin, organizationId, invoiceId, mollieInvoice.salesInvoiceId, decision.reason);
  }

  // Bestaande, herbruikbare open betaallink? Meteen teruggeven — nooit dubbel
  // aanmaken (zelfde gedrag als de medewerkers-app).
  const existing = await loadLatestOpenPayment(supabaseAdmin, organizationId, invoiceId);
  // Alleen hergebruiken als de open link nog om hetzelfde bedrag vraagt (na een
  // deelbetaling laat begin_invoice_payment_checkout de oude link vervallen).
  if (existing?.provider_checkout_url && isReusableCheckoutUrl(existing.provider_checkout_url)
    && Number(existing.amount_cents) === amountCents) {
    // De metadata van de OORSPRONKELIJKE aanmaker blijft staan (wie de betaling
    // startte), maar als een ANDERE geautoriseerde contactpersoon dezelfde link
    // hergebruikt, leggen we dat apart vast i.p.v. dat stilzwijgend te negeren —
    // anders suggereert de metadata ten onrechte dat alleen de eerste aanmaker
    // ooit met deze betaling te maken heeft gehad.
    await recordPaymentReuseAccess(supabaseAdmin, existing.id, actorContact);
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
    metadata: {
      source: 'client_portal',
      redirectUrl,
      ...(actorContact ? { contactId: actorContact.id, contactName: actorContact.name, contactEmail: actorContact.email } : {}),
    },
  });
  if (!beginResult.ok) return beginResult;
  const payment = beginResult.payment;
  if (payment.provider_checkout_url) {
    // Zelfde race-conditiepad als hierboven: begin_invoice_payment_checkout kan
    // hier server-side ook al een bestaande betaling hebben teruggegeven.
    await recordPaymentReuseAccess(supabaseAdmin, payment.id, actorContact);
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
      metadata = { mock: true, source: 'client_portal', ...contactMetadata(actorContact) };
    } else {
      const orgKey = await resolveOrganizationMollieKey(supabaseAdmin, organizationId);
      if (!orgKey) return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 409, 'Online betalen is voor deze factuur (nog) niet beschikbaar. Neem contact op met je leverancier of gebruik de overschrijvingsgegevens.');
      if (!MOLLIE_WEBHOOK_URL) return await failAndReturn(supabaseAdmin, payment.id, organizationId, actorUserId, 500, 'INVOICE_MOLLIE_WEBHOOK_URL ontbreekt.');

      const webhookUrl = invoiceMollieWebhookUrl(MOLLIE_WEBHOOK_URL, MOLLIE_WEBHOOK_SECRET);

      const mollieResponse = await fetch('https://api.mollie.com/v2/payments', {
        method: 'POST',
        // Per betaalrecord, net als invoice-workflow: met één sleutel per factuur
        // gaf Mollie na een verlopen of mislukte betaling binnen het
        // idempotentievenster de oude betaling (of een 422) terug.
        headers: { Authorization: `Bearer ${orgKey.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(`invoice-payment-${payment.id}`) },
        body: JSON.stringify({
          // Het bedrag van het betaalrecord: de database begrenst het op wat er
          // nog openstaat (begin_invoice_payment_checkout).
          amount: { currency: 'EUR', value: (Number(payment.amount_cents ?? amountCents) / 100).toFixed(2) },
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
      metadata = { mollie: withoutWebhookSecret(molliePayload), source: 'client_portal', ...contactMetadata(actorContact) };
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
): Promise<{ ok: true; payment: { id: string; amount_cents: number | null; provider_checkout_url: string | null; provider_payment_id: string | null } } | { ok: false; status: number; error: string }> {
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
  return { ok: true, payment: data as { id: string; amount_cents: number | null; provider_checkout_url: string | null; provider_payment_id: string | null } };
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

type MollieSalesInvoiceCheckout = {
  checkoutUrl: string | null; salesInvoiceId: string | null; status: string | null;
  paymentSources: MolliePaymentSource[]; amountDueCents: number | null;
};

/**
 * De e-factuur via Mollie van deze factuur (niet mislukt), met de stand bij
 * Mollie: vers opgehaald, want de opgeslagen stand kan een uur oud zijn (de
 * statusronde) en wie net via Mollie betaalde, mag geen tweede link krijgen.
 * Is Mollie onbereikbaar, dan de opgeslagen stand. Lukt het opzoeken in de
 * database niet, dan 'lookup_failed': geen eigen link ernaast op de gok.
 */
async function loadMollieSalesInvoiceCheckout(
  supabaseAdmin: SupabaseAdmin, organizationId: string, invoiceId: string,
): Promise<MollieSalesInvoiceCheckout | 'lookup_failed' | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_email_deliveries')
    .select('status,provider_email_id,external_payment_url,external_status')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .eq('delivery_channel', 'e_invoice_mollie')
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('client-portal: Mollie-factuur opzoeken mislukte', describeError(error));
    return 'lookup_failed';
  }
  if (!data) return null;
  const row = data as { status: string; provider_email_id: string | null; external_payment_url: string | null; external_status: string | null };
  const stored: MollieSalesInvoiceCheckout = {
    checkoutUrl: isReusableCheckoutUrl(row.external_payment_url) ? row.external_payment_url : null,
    salesInvoiceId: row.provider_email_id,
    // Een verzending die nog loopt, geeft Mollie nog uit.
    status: row.status === 'queued' ? 'issuing' : row.external_status,
    paymentSources: [],
    amountDueCents: null,
  };
  if (!row.provider_email_id || row.status === 'queued' || ALLOW_MOCK) return stored;
  const orgKey = await resolveOrganizationMollieKey(supabaseAdmin, organizationId);
  if (!orgKey) return stored;
  try {
    const response = await fetch(`https://api.mollie.com/v2/sales-invoices/${encodeURIComponent(row.provider_email_id)}`, {
      headers: { Authorization: `Bearer ${orgKey.apiKey}` },
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) { console.warn('client-portal: Mollie-factuur ophalen mislukte; de opgeslagen stand telt', response.status); return stored; }
    const state = readMollieSalesInvoice(payload);
    return {
      checkoutUrl: isReusableCheckoutUrl(state.paymentUrl) ? state.paymentUrl : stored.checkoutUrl,
      salesInvoiceId: row.provider_email_id,
      status: state.status ?? stored.status,
      paymentSources: state.paymentSources,
      amountDueCents: state.amountDueCents ?? state.totalCents,
    };
  } catch (fetchError) {
    console.warn('client-portal: Mollie-factuur ophalen mislukte; de opgeslagen stand telt', describeError(fetchError));
    return stored;
  }
}

/**
 * De betaalregel van de Mollie-factuur laten vervallen, zodat een eigen
 * betaallink voor het restbedrag ernaast kan (er mag maar één actieve betaling
 * per factuur zijn). Gelijk aan invoice-workflow; betaalt de klant toch via de
 * link van Mollie, dan boekt de statusronde dat alsnog (verlopen → betaald mag).
 */
async function retireMollieSalesInvoicePayment(
  supabaseAdmin: SupabaseAdmin, organizationId: string, invoiceId: string, salesInvoiceId: string, reason: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,metadata')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .eq('provider', 'mollie')
    .eq('provider_payment_id', salesInvoiceId)
    .in('status', ['creating', 'open'])
    .maybeSingle();
  if (error || !data) { if (error) console.warn('client-portal: betaalregel van de Mollie-factuur opzoeken mislukte', describeError(error)); return; }
  const row = data as { id: string; metadata: Record<string, unknown> | null };
  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from('invoice_payment_records')
    .update({
      status: 'expired',
      checkout_expires_at: nowIso,
      metadata: { ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}), superseded: reason, superseded_at: nowIso },
      updated_at: nowIso,
    })
    .eq('id', row.id)
    .eq('organization_id', organizationId)
    .in('status', ['creating', 'open']);
  if (updateError) console.warn('client-portal: betaalregel van de Mollie-factuur laten vervallen mislukte', describeError(updateError));
}

async function loadLatestOpenPayment(
  supabaseAdmin: SupabaseAdmin, organizationId: string, invoiceId: string,
): Promise<{ id: string; amount_cents: number | null; provider_checkout_url: string | null; provider_payment_id: string | null; status: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,amount_cents,provider_checkout_url,provider_payment_id,status')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .in('status', ['creating', 'open', 'pending', 'authorized'])
    // Een verlopen link telt niet (zoals in begin_invoice_payment_checkout, dat hem
    // opruimt). Eerder bleef een onderbroken 'creating' zonder URL hier staan en
    // gaf elke nieuwe poging voorgoed "probeer het over enkele seconden opnieuw":
    // geen betaallink meer in de app, de herinnering, de aanmaning of het portaal.
    .or(`checkout_expires_at.is.null,checkout_expires_at.gt."${new Date().toISOString()}"`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as { id: string; amount_cents: number | null; provider_checkout_url: string | null; provider_payment_id: string | null; status: string } | null;
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

function contactMetadata(actorContact: { id: string; name: string; email: string } | null | undefined): Record<string, unknown> {
  if (!actorContact) return {};
  return { contactId: actorContact.id, contactName: actorContact.name, contactEmail: actorContact.email };
}

/**
 * Legt vast dat een ANDERE geautoriseerde contactpersoon een al bestaande,
 * openstaande betaallink hergebruikt — zonder de oorspronkelijke
 * contactId/contactName/contactEmail (wie de betaling startte) te overschrijven.
 * Best-effort: dit is puur traceerbaarheid, dus een fout hierin mag de
 * betaalflow zelf nooit blokkeren.
 */
async function recordPaymentReuseAccess(
  supabaseAdmin: SupabaseAdmin,
  paymentRecordId: string,
  actorContact: { id: string; name: string; email: string } | null | undefined,
): Promise<void> {
  if (!actorContact) return;
  try {
    const { data, error } = await supabaseAdmin
      .from('invoice_payment_records')
      .select('metadata')
      .eq('id', paymentRecordId)
      .maybeSingle();
    if (error || !data) return;
    const existingMetadata = (data.metadata && typeof data.metadata === 'object') ? data.metadata as Record<string, unknown> : {};
    // Als dezelfde contactpersoon zelf de link opnieuw opent, is er niets nieuws
    // vast te leggen.
    if (existingMetadata.contactId === actorContact.id && !existingMetadata.lastAccessedContactId) return;
    if (existingMetadata.lastAccessedContactId === actorContact.id) return;
    await supabaseAdmin
      .from('invoice_payment_records')
      .update({
        metadata: {
          ...existingMetadata,
          lastAccessedContactId: actorContact.id,
          lastAccessedContactName: actorContact.name,
          lastAccessedContactEmail: actorContact.email,
          lastAccessedAt: new Date().toISOString(),
        },
      })
      .eq('id', paymentRecordId);
  } catch (error) {
    console.warn('recordPaymentReuseAccess failed (non-fatal)', describeError(error));
  }
}

/**
 * Alleen een echte Mollie-checkout (https op mollie.com) hergebruiken: deze link
 * gaat rechtstreeks naar de klant. De oude regex liet elke host door die met
 * "mollie." begon of een /invoice/-pad had. In mock-modus wordt er daardoor
 * steeds een nieuwe (nep)betaling gemaakt; dat is alleen lokaal/test.
 */
function isReusableCheckoutUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'mollie.com' || host.endsWith('.mollie.com');
  } catch {
    return false;
  }
}

/** Het Mollie-antwoord bevat onze webhookUrl, met het webhook-secret erin. Die
 *  hoort niet in metadata die elk lid met Financiën-leesrecht kan inzien. */
function withoutWebhookSecret(payload: Record<string, unknown>): Record<string, unknown> {
  const { webhookUrl: _webhookUrl, ...rest } = payload;
  return rest;
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
