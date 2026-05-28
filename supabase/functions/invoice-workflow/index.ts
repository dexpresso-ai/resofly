import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'https://esm.sh/pdf-lib@1.17.1';
import { renderEmailTemplate } from '../_shared/emailTemplates/index.ts';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type InvoiceLine = { id?: string; description: string; quantity: number; unit_price: number; vat?: number };
type InvoiceRow = {
  id: string; organization_id: string; client_id: string | null; project_id: string | null; quote_id: string | null;
  number: string; date: string; due_date: string | null; lines: InvoiceLine[]; status: string; notes: string | null;
  public_token_hash?: string | null; public_token_expires_at?: string | null;
};
type ClientRow = { id: string; name: string; contact_name: string | null; email: string | null };
type ProjectRow = { id: string; name: string; description: string | null };
type QuoteRow = { id: string; number: string };
type CompanySettingsRow = {
  company_name: string; trade_name: string | null; address_line1?: string | null; address_line2?: string | null;
  postal_code?: string | null; city?: string | null; country?: string | null; email: string | null; phone: string | null;
  website: string | null; kvk_number?: string | null; vat_number?: string | null; iban?: string | null;
  invoice_payment_terms?: string | null; invoice_footer?: string | null; invoice_accent_color?: string | null;
};
type InvoicePdfAttachment = { fileName: string; mimeType: 'application/pdf'; bytes: Uint8Array; base64: string; sizeBytes: number; sha256: string };
type StoredInvoicePdfSnapshot = { provider: 'r2' | 'database'; key: string | null; shouldStoreBase64InDatabase: boolean };
type WorkflowHttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const INVOICE_PUBLIC_BASE_URL = Deno.env.get('INVOICE_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '';
const INVOICE_TOKEN_TTL_DAYS = parsePositiveInt(Deno.env.get('INVOICE_TOKEN_TTL_DAYS'), 60);
const INVOICE_PDF_MAX_ATTACHMENT_BYTES = parsePositiveInt(Deno.env.get('INVOICE_PDF_MAX_ATTACHMENT_BYTES'), 8 * 1024 * 1024);
const INVOICE_PDF_STORAGE_WORKER_URL = (Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') || '').replace(/\/$/, '');
const INVOICE_PDF_STORAGE_SECRET = Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || '';
const INVOICE_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'), Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'),
]);
const INVOICE_ALLOW_LOCAL_DEV = (Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || Deno.env.get('QUOTE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const MOLLIE_API_KEY = Deno.env.get('MOLLIE_INVOICE_API_KEY') || Deno.env.get('MOLLIE_API_KEY') || '';
const MOLLIE_WEBHOOK_URL = Deno.env.get('INVOICE_MOLLIE_WEBHOOK_URL') || Deno.env.get('MOLLIE_WEBHOOK_URL') || '';
const MOLLIE_WEBHOOK_SECRET = Deno.env.get('INVOICE_MOLLIE_WEBHOOK_SECRET') || Deno.env.get('MOLLIE_WEBHOOK_SECRET') || '';
const MOLLIE_ALLOW_MOCK = (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
const INVOICE_DEBUG_ERRORS = (Deno.env.get('INVOICE_DEBUG_ERRORS') || 'false').toLowerCase() === 'true';
const CHECKOUT_TTL_MINUTES = parsePositiveInt(Deno.env.get('INVOICE_CHECKOUT_TTL_MINUTES'), 30);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

class WorkflowHttpError extends Error {
  status: WorkflowHttpErrorStatus;
  constructor(message: string, status: WorkflowHttpErrorStatus = 400) { super(message); this.name = 'WorkflowHttpError'; this.status = status; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    const url = new URL(req.url);
    const contentType = req.headers.get('content-type') || '';

    if (url.searchParams.get('webhook') === 'mollie') {
      const body = await parseBody(req, contentType);
      return await handleMollieWebhook(req, url, body);
    }

    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const invoiceId = String(body.invoiceId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);
    if (!['owner', 'admin', 'member'].includes(role)) throw new WorkflowHttpError('Geen schrijfrechten voor deze organisatie.', 403);

    switch (action) {
      case 'sendInvoiceEmail': return json(req, { ok: true, ...(await sendInvoiceEmail(user.id, organizationId, invoiceId, body)) });
      case 'createInvoicePaymentCheckout': return json(req, { ok: true, ...(await createInvoicePaymentCheckout(user.id, organizationId, invoiceId, body)) });
      case 'markMockInvoicePaymentPaid': return json(req, { ok: true, payment: await markMockInvoicePaymentPaid(String(body.providerPaymentId || '')) });
      default: return json(req, { ok: false, error: `Onbekende invoice workflow action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof WorkflowHttpError ? error.status : 500;
    const internalMessage = describeError(error);
    if (status >= 500) {
      console.error('invoice-workflow error', internalMessage, serializeError(error));
    } else {
      console.warn('invoice-workflow warning', internalMessage, serializeError(error));
    }
    const publicMessage = error instanceof WorkflowHttpError
      ? error.message
      : INVOICE_DEBUG_ERRORS
        ? `Invoice workflow-actie mislukt: ${internalMessage}`
        : 'Invoice workflow-actie mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendInvoiceEmail(userId: string, organizationId: string, invoiceId: string, body: Record<string, unknown>) {
  if (!RESEND_API_KEY) throw new WorkflowHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  if (!RESEND_FROM_EMAIL) throw new WorkflowHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  if (!INVOICE_PUBLIC_BASE_URL) throw new WorkflowHttpError('INVOICE_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.', 500);
  if (!isUuid(invoiceId)) throw new WorkflowHttpError('Ongeldige factuur.', 400);

  const invoice = await loadInvoice(organizationId, invoiceId);
  if (['paid','cancelled','void','written_off'].includes(invoice.status)) throw new WorkflowHttpError('Betaalde, geannuleerde of afgeboekte facturen kunnen niet worden verstuurd.', 409);
  if (!invoice.client_id) throw new WorkflowHttpError('Deze factuur heeft geen klant gekoppeld.', 422);

  const [client, project, quote, company, latestPayment] = await Promise.all([
    loadClient(organizationId, invoice.client_id),
    invoice.project_id ? loadProject(organizationId, invoice.project_id) : Promise.resolve(null),
    invoice.quote_id ? loadQuote(organizationId, invoice.quote_id) : Promise.resolve(null),
    loadCompanySettings(organizationId),
    loadLatestOpenPayment(organizationId, invoiceId),
  ]);

  const recipientEmail = String(body.recipientEmail || client.email || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || client.contact_name || client.name || '').trim();
  if (!isEmail(recipientEmail)) throw new WorkflowHttpError('Vul een geldig klant-e-mailadres in voordat je de factuur verstuurt.', 422);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + Math.max(1, INVOICE_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const publicUrl = `${INVOICE_PUBLIC_BASE_URL.replace(/\/$/, '')}/invoice/${encodeURIComponent(token)}`;
  const paymentUrl = latestPayment?.provider_checkout_url || null;

  const renderedEmail = renderEmailTemplate('invoice.sent', { invoice, client, project, quote, company, publicUrl, paymentUrl, recipientName, expiresAt });
  const subject = String(body.subject || renderedEmail.subject || '').trim();
  if (!subject) throw new WorkflowHttpError('Er kon geen onderwerp voor de factuur-e-mail worden bepaald.', 500);

  const pdfAttachment = await createInvoicePdfAttachment({ invoice, client, project, quote, company, publicUrl, paymentUrl });
  validateInvoicePdfAttachment(pdfAttachment);
  const storedPdf = await storeInvoicePdfSnapshot(organizationId, invoiceId, pdfAttachment);

  const prepared = await beginInvoiceEmailSend({
    invoiceId,
    organizationId,
    userId,
    tokenHash,
    expiresAt,
    recipientEmail,
    recipientName,
    subject,
    publicUrl,
    attachmentFileName: pdfAttachment.fileName,
    attachmentMimeType: pdfAttachment.mimeType,
    attachmentSizeBytes: pdfAttachment.sizeBytes,
    attachmentSha256: pdfAttachment.sha256,
    attachmentDataBase64: storedPdf.shouldStoreBase64InDatabase ? pdfAttachment.base64 : undefined,
    attachmentStorageProvider: storedPdf.provider,
    attachmentStorageKey: storedPdf.key ?? undefined,
  });

  const resendPayload = {
    from: RESEND_FROM_EMAIL,
    to: [recipientEmail],
    reply_to: RESEND_REPLY_TO || undefined,
    subject,
    html: renderedEmail.html,
    text: renderedEmail.text,
    attachments: [{ filename: pdfAttachment.fileName, content: pdfAttachment.base64 }],
    tags: [
      { name: 'organization_id', value: sanitizeTagValue(organizationId) },
      { name: 'invoice_id', value: sanitizeTagValue(invoiceId) },
      { name: 'invoice_number', value: sanitizeTagValue(invoice.number) },
      { name: 'template_key', value: 'invoice_sent' },
    ],
  };

  let resendResponse: Response;
  let resendPayloadResponse: Record<string, unknown> = {};

  try {
    resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(`invoice-${invoiceId}-${prepared.deliveryId}`) },
      body: JSON.stringify(resendPayload),
    });
    resendPayloadResponse = (await resendResponse.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (error) {
    const errorMessage = `Resend provider request failed before a response was received: ${describeError(error)}`;
    await failInvoiceEmailSend(prepared.deliveryId, organizationId, userId, errorMessage);
    throw new WorkflowHttpError(`Resend kon de factuur-e-mail niet versturen: ${errorMessage}`, 502);
  }

  if (!resendResponse.ok) {
    const errorMessage = String(resendPayloadResponse.message || resendPayloadResponse.error || resendResponse.statusText || 'Resend send failed');
    await failInvoiceEmailSend(prepared.deliveryId, organizationId, userId, errorMessage);
    throw new WorkflowHttpError(`Resend kon de factuur-e-mail niet versturen: ${errorMessage}`, 502);
  }
  const providerEmailId = String(resendPayloadResponse.id || resendPayloadResponse.email_id || '').trim();
  if (!providerEmailId) {
    await failInvoiceEmailSend(prepared.deliveryId, organizationId, userId, 'Resend accepted the request but did not return a provider email id.');
    throw new WorkflowHttpError('Resend gaf geen e-mail-ID terug. De verzending is niet definitief gemarkeerd.', 502);
  }

  const finalized = await completeInvoiceEmailSend(prepared.deliveryId, organizationId, userId, providerEmailId);
  return { delivery: finalized.delivery, version: finalized.version, publicUrl, providerEmailId, attachment: { fileName: pdfAttachment.fileName, sizeBytes: pdfAttachment.sizeBytes, sha256: pdfAttachment.sha256, storageProvider: storedPdf.provider, storageKey: storedPdf.key } };
}

async function createInvoicePaymentCheckout(userId: string, organizationId: string, invoiceId: string, body: Record<string, unknown>) {
  if (!INVOICE_PUBLIC_BASE_URL) throw new WorkflowHttpError('INVOICE_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.', 500);
  const invoice = await loadInvoice(organizationId, invoiceId);
  if (['paid','cancelled','void','written_off'].includes(invoice.status)) throw new WorkflowHttpError('Voor deze factuur kan geen betaallink worden aangemaakt.', 409);
  if (!invoice.client_id) throw new WorkflowHttpError('Deze factuur heeft geen klant gekoppeld.', 422);
  const amountCents = calculateTotals(invoice.lines).totalCents;
  if (amountCents <= 0) throw new WorkflowHttpError('Factuurbedrag moet groter zijn dan 0.', 422);

  const existingPayment = await loadLatestOpenPayment(organizationId, invoiceId);
  if (existingPayment?.provider_checkout_url && isReusableCheckoutUrl(existingPayment.provider_checkout_url)) {
    return {
      payment: existingPayment,
      checkoutUrl: existingPayment.provider_checkout_url,
      providerPaymentId: existingPayment.provider_payment_id,
      mock: existingPayment.provider_payment_id?.startsWith('mock_') ?? false,
      reused: true,
    };
  }
  if (existingPayment?.status === 'creating' && !existingPayment.provider_checkout_url) {
    throw new WorkflowHttpError('Er wordt al een betaallink voor deze factuur voorbereid. Probeer het over enkele seconden opnieuw.', 409);
  }

  const client = await loadClient(organizationId, invoice.client_id);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const tokenExpiresAt = new Date(Date.now() + Math.max(1, INVOICE_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const publicUrl = `${INVOICE_PUBLIC_BASE_URL.replace(/\/$/, '')}/invoice/${encodeURIComponent(token)}`;
  const checkoutExpiresAt = new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString();
  // Use a server-side stable idempotency key. Do not trust a frontend-supplied
  // timestamp/random key here, because a double click must not create multiple
  // active Mollie payments for the same invoice.
  const idempotencyKey = `invoice-${invoice.id}-active-payment`;

  const payment = await beginInvoicePaymentCheckout({ invoiceId, organizationId, userId, amountCents, publicTokenHash: null, publicTokenExpiresAt: null, idempotencyKey, checkoutExpiresAt, metadata: { publicUrl } });
  if (payment.provider_checkout_url) return { payment, checkoutUrl: payment.provider_checkout_url, providerPaymentId: payment.provider_payment_id, mock: payment.provider_payment_id?.startsWith('mock_') ?? false, reused: true };

  let providerPaymentId = '';
  let checkoutUrl = '';
  let providerStatus = 'open';
  let metadata: Record<string, unknown> = {};

  try {
    if (MOLLIE_ALLOW_MOCK) {
      providerPaymentId = `mock_invoice_payment_${crypto.randomUUID()}`;
      checkoutUrl = `${publicUrl}?mock_payment=${encodeURIComponent(providerPaymentId)}`;
      metadata = { mock: true, publicUrl };
    } else {
      if (!MOLLIE_API_KEY) throw new WorkflowHttpError('MOLLIE_API_KEY of MOLLIE_INVOICE_API_KEY ontbreekt.', 500);
      if (!MOLLIE_WEBHOOK_URL) throw new WorkflowHttpError('INVOICE_MOLLIE_WEBHOOK_URL of MOLLIE_WEBHOOK_URL ontbreekt.', 500);
      const requestedRedirectUrl = String(body.redirectUrl || '').trim();
      const redirectUrl = isValidInvoiceRedirectUrl(requestedRedirectUrl, publicUrl) ? requestedRedirectUrl : publicUrl;
      const webhookUrl = MOLLIE_WEBHOOK_SECRET ? `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}webhook=mollie&secret=${encodeURIComponent(MOLLIE_WEBHOOK_SECRET)}` : `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}webhook=mollie`;
      const mollieResponse = await fetch('https://api.mollie.com/v2/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${MOLLIE_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(idempotencyKey) },
        body: JSON.stringify({
          amount: { currency: 'EUR', value: (amountCents / 100).toFixed(2) },
          description: `Factuur ${invoice.number}`,
          redirectUrl,
          webhookUrl,
          metadata: { organizationId, invoiceId, invoiceNumber: invoice.number, paymentRecordId: payment.id, clientEmail: client.email },
        }),
      });
      const molliePayload = (await mollieResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!mollieResponse.ok) throw new WorkflowHttpError(`Mollie kon geen betaallink maken: ${String(molliePayload.detail || molliePayload.title || mollieResponse.statusText)}`, 502);
      providerPaymentId = String(molliePayload.id || '').trim();
      checkoutUrl = String(((molliePayload._links as Record<string, { href?: string }> | undefined)?.checkout?.href) || '').trim();
      providerStatus = String(molliePayload.status || 'open');
      metadata = { mollie: molliePayload };
      if (!providerPaymentId || !checkoutUrl) throw new WorkflowHttpError('Mollie gaf geen payment-id of checkout-url terug.', 502);
    }

    const completed = await completeInvoicePaymentCheckout(payment.id, organizationId, userId, providerPaymentId, checkoutUrl, providerStatus, metadata);
    return { payment: completed, checkoutUrl, providerPaymentId, mock: providerPaymentId.startsWith('mock_'), reused: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Onbekende Mollie checkout-fout.';

    await failInvoicePaymentCheckout(payment.id, organizationId, userId, errorMessage, {
      publicUrl,
      providerPaymentId: providerPaymentId || null,
      checkoutUrl: checkoutUrl || null,
      providerStatus,
      metadata,
    }).catch((failError) => {
      console.warn(
        'Invoice payment checkout failure registration failed',
        failError instanceof Error ? failError.message : failError,
      );
    });

    if (error instanceof WorkflowHttpError) throw error;
    throw new WorkflowHttpError(`Mollie checkout kon niet worden afgerond: ${errorMessage}`, 502);
  }
}

async function handleMollieWebhook(req: Request, url: URL, body: Record<string, string>) {
  if (!MOLLIE_ALLOW_MOCK) {
    if (MOLLIE_WEBHOOK_SECRET && !timingSafeEqual(url.searchParams.get('secret') || '', MOLLIE_WEBHOOK_SECRET)) return json(req, { ok: false, error: 'Invalid webhook secret' }, 403);
    if (!MOLLIE_WEBHOOK_SECRET) return json(req, { ok: false, error: 'Webhook secret ontbreekt.' }, 500);
  }
  const paymentId = String(body.id || body.payment_id || '').trim();
  if (!paymentId) return json(req, { ok: false, error: 'Payment id ontbreekt.' }, 400);

  let status = 'open';
  let paidAt: string | null = null;
  let metadata: Record<string, unknown> = {};

  if (MOLLIE_ALLOW_MOCK && paymentId.startsWith('mock_invoice_payment_')) {
    status = 'paid';
    paidAt = new Date().toISOString();
    metadata = { mock: true, webhook: body };
  } else {
    if (!MOLLIE_API_KEY) return json(req, { ok: false, error: 'Mollie API key ontbreekt.' }, 500);
    const response = await fetch(`https://api.mollie.com/v2/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` } });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return json(req, { ok: false, error: 'Mollie payment ophalen mislukt.' }, 502);
    status = normalizeMollieStatus(String(payload.status || 'open'));
    paidAt = typeof payload.paidAt === 'string' ? payload.paidAt : null;
    metadata = { mollie: payload };
  }

  const { error } = await supabaseAdmin.rpc('update_invoice_payment_status', { p_provider_payment_id: paymentId, p_status: status, p_paid_at: paidAt, p_metadata: metadata });
  if (error) return json(req, { ok: false, error: error.message }, 500);
  return json(req, { ok: true });
}

async function markMockInvoicePaymentPaid(providerPaymentId: string) {
  if (!MOLLIE_ALLOW_MOCK) throw new WorkflowHttpError('Mock payments zijn uitgeschakeld.', 403);
  const { data, error } = await supabaseAdmin.rpc('update_invoice_payment_status', { p_provider_payment_id: providerPaymentId, p_status: 'paid', p_paid_at: new Date().toISOString(), p_metadata: { mock: true, manual: true } });
  if (error) throwRpcError('update_invoice_payment_status', error);
  return data;
}

async function loadInvoice(organizationId: string, invoiceId: string): Promise<InvoiceRow> {
  const { data, error } = await supabaseAdmin.from('invoices').select('*').eq('id', invoiceId).eq('organization_id', organizationId).single();
  if (error || !data) throw new WorkflowHttpError('Factuur niet gevonden.', 404);
  return data as InvoiceRow;
}
async function loadClient(organizationId: string, clientId: string): Promise<ClientRow> {
  const { data, error } = await supabaseAdmin.from('clients').select('id,name,contact_name,email').eq('id', clientId).eq('organization_id', organizationId).single();
  if (error || !data) throw new WorkflowHttpError('Klant niet gevonden.', 404);
  return data as ClientRow;
}
async function loadProject(organizationId: string, projectId: string): Promise<ProjectRow | null> {
  const { data, error } = await supabaseAdmin.from('projects').select('id,name,description').eq('id', projectId).eq('organization_id', organizationId).maybeSingle();
  if (error) throwSupabaseError('projects lookup', error); return (data ?? null) as ProjectRow | null;
}
async function loadQuote(organizationId: string, quoteId: string): Promise<QuoteRow | null> {
  const { data, error } = await supabaseAdmin.from('quotes').select('id,number').eq('id', quoteId).eq('organization_id', organizationId).maybeSingle();
  if (error) throwSupabaseError('quotes lookup', error); return (data ?? null) as QuoteRow | null;
}
async function loadCompanySettings(organizationId: string): Promise<CompanySettingsRow | null> {
  const { data, error } = await supabaseAdmin.from('company_settings').select('company_name,trade_name,address_line1,address_line2,postal_code,city,country,email,phone,website,kvk_number,vat_number,iban,invoice_payment_terms,invoice_footer,invoice_accent_color').eq('organization_id', organizationId).maybeSingle();
  if (error) throwSupabaseError('company_settings lookup', error); return (data ?? null) as CompanySettingsRow | null;
}
async function loadLatestOpenPayment(organizationId: string, invoiceId: string): Promise<{ id: string; provider_checkout_url: string | null; provider_payment_id: string | null; status: string; checkout_expires_at?: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,provider_checkout_url,provider_payment_id,status,checkout_expires_at')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .in('status', ['creating','open','pending','authorized'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as { id: string; provider_checkout_url: string | null; provider_payment_id: string | null; status: string; checkout_expires_at?: string | null } | null;
}

async function beginInvoiceEmailSend(input: { invoiceId: string; organizationId: string; userId: string; tokenHash: string; expiresAt: string; recipientEmail: string; recipientName: string; subject: string; publicUrl: string; attachmentFileName?: string; attachmentMimeType?: string; attachmentSizeBytes?: number; attachmentSha256?: string; attachmentDataBase64?: string; attachmentStorageProvider?: string; attachmentStorageKey?: string }): Promise<{ deliveryId: string; invoiceId?: string }> {
  const { data, error } = await supabaseAdmin.rpc('begin_invoice_email_send', {
    p_invoice_id: input.invoiceId,
    p_organization_id: input.organizationId,
    p_actor_user_id: input.userId,
    p_token_hash: input.tokenHash,
    p_token_expires_at: input.expiresAt,
    p_recipient_email: input.recipientEmail,
    p_recipient_name: input.recipientName,
    p_subject: input.subject,
    p_public_url: input.publicUrl,
    p_attachment_file_name: input.attachmentFileName ?? null,
    p_attachment_mime_type: input.attachmentMimeType ?? 'application/pdf',
    p_attachment_size_bytes: input.attachmentSizeBytes ?? null,
    p_attachment_sha256: input.attachmentSha256 ?? null,
    p_attachment_data_base64: input.attachmentDataBase64 ?? null,
    p_attachment_storage_provider: input.attachmentStorageProvider ?? null,
    p_attachment_storage_key: input.attachmentStorageKey ?? null,
  });
  if (error) throwRpcError('begin_invoice_email_send', error);
  const payload = data as { deliveryId?: string } | null;
  if (!payload?.deliveryId) throw new WorkflowHttpError('Verzendpoging kon niet worden voorbereid.', 500);
  return payload as { deliveryId: string; invoiceId?: string };
}
async function completeInvoiceEmailSend(deliveryId: string, organizationId: string, userId: string, providerEmailId: string): Promise<{ delivery?: unknown; invoice?: unknown; version?: unknown }> {
  const { data, error } = await supabaseAdmin.rpc('complete_invoice_email_send', { p_delivery_id: deliveryId, p_organization_id: organizationId, p_actor_user_id: userId, p_provider_email_id: providerEmailId });
  if (error) throwRpcError('complete_invoice_email_send', error); return (data ?? {}) as { delivery?: unknown; invoice?: unknown; version?: unknown };
}
async function failInvoiceEmailSend(deliveryId: string, organizationId: string, userId: string, errorMessage: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('fail_invoice_email_send', { p_delivery_id: deliveryId, p_organization_id: organizationId, p_actor_user_id: userId, p_error_message: errorMessage });
  if (error) console.warn('Invoice email send failure registration failed', error.message);
}
async function beginInvoicePaymentCheckout(input: { invoiceId: string; organizationId: string; userId: string; amountCents: number; publicTokenHash: string | null; publicTokenExpiresAt: string | null; idempotencyKey: string; checkoutExpiresAt: string; metadata: Record<string, unknown> }) {
  const { data, error } = await supabaseAdmin.rpc('begin_invoice_payment_checkout', { p_invoice_id: input.invoiceId, p_organization_id: input.organizationId, p_actor_user_id: input.userId, p_amount_cents: input.amountCents, p_public_token_hash: input.publicTokenHash, p_public_token_expires_at: input.publicTokenExpiresAt, p_currency: 'EUR', p_idempotency_key: input.idempotencyKey, p_checkout_expires_at: input.checkoutExpiresAt, p_metadata: input.metadata });
  if (error) throwRpcError('begin_invoice_payment_checkout', error); return data as { id: string; provider_checkout_url: string | null; provider_payment_id: string | null };
}
async function completeInvoicePaymentCheckout(paymentRecordId: string, organizationId: string, userId: string, providerPaymentId: string, checkoutUrl: string, status: string, metadata: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc('complete_invoice_payment_checkout', { p_payment_record_id: paymentRecordId, p_organization_id: organizationId, p_actor_user_id: userId, p_provider_payment_id: providerPaymentId, p_provider_checkout_url: checkoutUrl, p_status: status, p_metadata: metadata });
  if (error) throwRpcError('complete_invoice_payment_checkout', error); return data;
}
async function failInvoicePaymentCheckout(paymentRecordId: string, organizationId: string, userId: string, errorMessage: string, metadata: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc('fail_invoice_payment_checkout', {
    p_payment_record_id: paymentRecordId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_error_message: errorMessage,
    p_metadata: metadata,
    p_retry_after_seconds: 300,
    p_max_retries: 5,
  });
  if (error) throwRpcError('fail_invoice_payment_checkout', error);
  return data;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [
      record.message,
      record.details,
      record.hint,
      record.code ? `code=${String(record.code)}` : null,
    ].filter(Boolean).map(String);
    if (parts.length > 0) return parts.join(' | ');
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'Onbekende fout.';
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    } catch {
      return { value: String(error) };
    }
  }

  return { value: error ?? null };
}

function throwSupabaseError(context: string, error: unknown): never {
  throw new WorkflowHttpError(`${context} mislukt: ${describeError(error)}`, 500);
}

function throwRpcError(functionName: string, error: unknown): never {
  throw new WorkflowHttpError(`Databasefunctie ${functionName} mislukt: ${describeError(error)}`, 500);
}

async function storeInvoicePdfSnapshot(organizationId: string, invoiceId: string, attachment: InvoicePdfAttachment): Promise<StoredInvoicePdfSnapshot> {
  const storageConfigured = Boolean(INVOICE_PDF_STORAGE_WORKER_URL && INVOICE_PDF_STORAGE_SECRET);

  if (!storageConfigured) {
    return { provider: 'database', key: null, shouldStoreBase64InDatabase: true };
  }

  const key = `${organizationId}/invoice-pdfs/${invoiceId}/${crypto.randomUUID()}-${sanitizeFileName(attachment.fileName)}`;
  const response = await fetch(`${INVOICE_PDF_STORAGE_WORKER_URL}/internal/invoice-snapshot`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}`,
      'Content-Type': attachment.mimeType,
      'X-Storage-Key': key,
      'X-SHA256': attachment.sha256,
      'X-Size-Bytes': String(attachment.sizeBytes),
    },
    body: attachment.bytes,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new WorkflowHttpError(`Factuur-PDF kon niet in private R2 storage worden opgeslagen: ${message || response.statusText}`, 502);
  }

  return { provider: 'r2', key, shouldStoreBase64InDatabase: false };
}

async function createInvoicePdfAttachment(input: { invoice: InvoiceRow; client: ClientRow; project: ProjectRow | null; quote: QuoteRow | null; company: CompanySettingsRow | null; publicUrl: string; paymentUrl?: string | null }): Promise<InvoicePdfAttachment> {
  const { invoice, client, project, quote, company, publicUrl, paymentUrl } = input;
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToPdfRgb(company?.invoice_accent_color || '#FFD966');
  const muted = rgb(0.38, 0.38, 0.38);
  let page = pdfDoc.addPage([595.28, 841.89]);
  let y = 780;
  const companyName = company?.trade_name || company?.company_name || 'ResoFly';

  page.drawRectangle({ x: 0, y: 824, width: 595.28, height: 18, color: accent, opacity: 0.85 });
  drawPdfText(page, 'FACTUUR', 48, y, bold, 26);
  drawPdfText(page, invoice.number || '-', 547, y + 6, bold, 12, { align: 'right' });
  y -= 28;
  drawPdfText(page, companyName, 48, y, bold, 13); y -= 18;
  for (const line of companyAddressLines(company).slice(0, 8)) { drawPdfText(page, line, 48, y, regular, 9, { color: muted }); y -= 12; }
  let rightY = 742;
  drawPdfText(page, `Datum: ${formatDateNl(invoice.date)}`, 547, rightY, regular, 9, { align: 'right', color: muted }); rightY -= 14;
  drawPdfText(page, `Vervaldatum: ${formatDateNl(invoice.due_date)}`, 547, rightY, regular, 9, { align: 'right', color: muted }); rightY -= 14;
  if (project?.name) { drawPdfText(page, `Project: ${project.name}`, 547, rightY, regular, 9, { align: 'right', color: muted }); rightY -= 14; }
  if (quote?.number) drawPdfText(page, `Offerte: ${quote.number}`, 547, rightY, regular, 9, { align: 'right', color: muted });

  y = 620;
  drawSectionTitle(page, 'Klant', 48, y, bold, accent, muted); y -= 24;
  for (const line of clientAddressLines(client)) { drawPdfText(page, line, 48, y, line === client.name ? bold : regular, 10); y -= 14; }
  y = 500;
  drawTableHeader(page, y, bold, accent, muted); y -= 28;
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  for (const line of lines) {
    if (y < 155) { drawPdfFooter(page, regular, company); page = pdfDoc.addPage([595.28, 841.89]); y = 780; drawTableHeader(page, y, bold, accent, muted); y -= 28; }
    y -= drawLine(page, line, y, regular, bold, muted);
  }
  const totals = calculateTotals(invoice.lines);
  if (y < 230) { drawPdfFooter(page, regular, company); page = pdfDoc.addPage([595.28, 841.89]); y = 760; }
  y -= 10;
  drawPdfText(page, 'Subtotaal', 365, y, regular, 10); drawPdfText(page, formatEuro(totals.subtotal), 547, y, regular, 10, { align: 'right' }); y -= 18;
  if (totals.vatBreakdown.length > 0) {
    for (const row of totals.vatBreakdown) {
      drawPdfText(page, `BTW ${row.rate}%`, 365, y, regular, 10); drawPdfText(page, formatEuro(row.vat), 547, y, regular, 10, { align: 'right' }); y -= 18;
    }
    y -= 4;
  } else {
    drawPdfText(page, 'BTW', 365, y, regular, 10); drawPdfText(page, formatEuro(totals.vat), 547, y, regular, 10, { align: 'right' }); y -= 22;
  }
  page.drawLine({ start: { x: 365, y: y + 12 }, end: { x: 547, y: y + 12 }, thickness: 0.8, color: accent });
  drawPdfText(page, 'Totaal', 365, y, bold, 13); drawPdfText(page, formatEuro(totals.total), 547, y, bold, 13, { align: 'right' });
  if (company?.iban) { y -= 30; drawPdfText(page, `Betalen op IBAN: ${company.iban}`, 365, y, regular, 9, { color: muted }); }
  if (invoice.notes) { y -= 42; drawSectionTitle(page, 'Notities', 48, y, bold, accent, muted); y -= 24; y = drawWrappedPdfText(page, invoice.notes, 48, y, 310, regular, 9, 12, muted); }
  y = Math.max(94, y - 28);
  drawPdfText(page, paymentUrl ? 'Bekijk en betaal deze factuur online:' : 'Bekijk deze factuur online:', 48, y, bold, 9, { color: muted }); y -= 13;
  drawWrappedPdfText(page, paymentUrl || publicUrl, 48, y, 500, regular, 8, 11, muted);
  drawPdfFooter(page, regular, company);
  const bytes = await pdfDoc.save();
  const sha256 = await sha256HexBytes(bytes);
  const fileName = `factuur-${sanitizeFileName(invoice.number || invoice.id)}.pdf`;
  return { fileName, mimeType: 'application/pdf', bytes, base64: bytesToBase64(bytes), sizeBytes: bytes.byteLength, sha256 };
}

function drawTableHeader(page: PDFPage, y: number, bold: PDFFont, accent: RGB, muted: RGB): void { page.drawRectangle({ x: 48, y: y - 8, width: 499, height: 24, color: accent, opacity: 0.18 }); drawPdfText(page, 'Omschrijving', 56, y, bold, 8, { color: muted }); drawPdfText(page, 'Aantal', 356, y, bold, 8, { align: 'right', color: muted }); drawPdfText(page, 'Prijs', 424, y, bold, 8, { align: 'right', color: muted }); drawPdfText(page, 'BTW', 470, y, bold, 8, { align: 'right', color: muted }); drawPdfText(page, 'Totaal', 547, y, bold, 8, { align: 'right', color: muted }); }
function drawLine(page: PDFPage, line: InvoiceLine, y: number, regular: PDFFont, bold: PDFFont, muted: RGB): number { const descriptionLines = wrapPdfText(line.description || '-', regular, 9, 270); const quantity = Number(line.quantity || 0); const unitPrice = Number(line.unit_price || 0); const vatPercentage = Number(line.vat || 0); const lineTotal = lineGrossEuro(line); page.drawLine({ start: { x: 48, y: y + 8 }, end: { x: 547, y: y + 8 }, thickness: 0.35, color: muted, opacity: 0.25 }); let descY = y; for (const desc of descriptionLines) { drawPdfText(page, desc, 56, descY, regular, 9); descY -= 12; } drawPdfText(page, String(quantity), 356, y, regular, 9, { align: 'right' }); drawPdfText(page, formatEuro(unitPrice), 424, y, regular, 9, { align: 'right' }); drawPdfText(page, `${vatPercentage}%`, 470, y, regular, 9, { align: 'right' }); drawPdfText(page, formatEuro(lineTotal), 547, y, bold, 9, { align: 'right' }); return Math.max(26, descriptionLines.length * 12 + 12); }
function drawSectionTitle(page: PDFPage, title: string, x: number, y: number, bold: PDFFont, accent: RGB, muted: RGB): void { drawPdfText(page, title.toUpperCase(), x, y, bold, 8, { color: muted }); page.drawLine({ start: { x, y: y - 5 }, end: { x: x + 180, y: y - 5 }, thickness: 0.6, color: accent }); }
function drawPdfFooter(page: PDFPage, font: PDFFont, company: CompanySettingsRow | null): void { const footer = company?.invoice_footer || company?.invoice_payment_terms || 'Bedankt voor het vertrouwen.'; page.drawLine({ start: { x: 48, y: 58 }, end: { x: 547, y: 58 }, thickness: 0.45, color: rgb(0.38, 0.38, 0.38), opacity: 0.35 }); drawWrappedPdfText(page, footer, 48, 42, 499, font, 8, 10, rgb(0.38, 0.38, 0.38)); }
function drawPdfText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, opts: { align?: 'left' | 'right'; color?: RGB } = {}): void { const safe = normalizePdfText(text); if (!safe) return; const width = font.widthOfTextAtSize(safe, size); page.drawText(safe, { x: opts.align === 'right' ? x - width : x, y, font, size, color: opts.color || rgb(0.1, 0.1, 0.1) }); }
function drawWrappedPdfText(page: PDFPage, text: string, x: number, y: number, maxWidth: number, font: PDFFont, size: number, lineHeight: number, color?: RGB): number { let cursorY = y; for (const line of wrapPdfText(text, font, size, maxWidth)) { drawPdfText(page, line, x, cursorY, font, size, { color }); cursorY -= lineHeight; } return cursorY; }
function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] { const source = normalizePdfText(text); if (!source) return []; const words = source.split(' '); const lines: string[] = []; let current = ''; for (const word of words) { const chunks = font.widthOfTextAtSize(word, size) > maxWidth ? splitLongPdfWord(word, font, size, maxWidth) : [word]; for (const chunk of chunks) { const candidate = current ? `${current} ${chunk}` : chunk; if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate; else { if (current) lines.push(current); current = chunk; } } } if (current) lines.push(current); return lines; }
function splitLongPdfWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] { const chunks: string[] = []; let current = ''; for (const char of word) { const candidate = current + char; if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) { chunks.push(current); current = char; } else current = candidate; } if (current) chunks.push(current); return chunks; }
function normalizePdfText(value: unknown): string { return String(value ?? '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...').replace(/\u2022/g, '-').replace(/€/g, 'EUR').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').split('').filter((char) => { const code = char.charCodeAt(0); return (code >= 32 && code <= 126) || (code >= 160 && code <= 255); }).join('').trim(); }
function companyAddressLines(company: CompanySettingsRow | null): string[] { if (!company) return ['ResoFly']; const cityLine = [company.postal_code, company.city].filter(Boolean).join(' '); return [company.company_name, company.trade_name && company.trade_name !== company.company_name ? company.trade_name : '', company.address_line1, company.address_line2, cityLine, company.country, company.email ? `E-mail: ${company.email}` : '', company.phone ? `Tel: ${company.phone}` : '', company.website ? `Web: ${company.website}` : '', company.kvk_number ? `KvK: ${company.kvk_number}` : '', company.vat_number ? `BTW: ${company.vat_number}` : '', company.iban ? `IBAN: ${company.iban}` : ''].filter((value) => normalizePdfText(value).length > 0).map(normalizePdfText); }
function clientAddressLines(client: ClientRow): string[] { return [client.name, client.contact_name ? `T.a.v. ${client.contact_name}` : '', client.email ? `E-mail: ${client.email}` : ''].filter((value) => normalizePdfText(value).length > 0).map(normalizePdfText); }
function toCents(euros: number): number {
  if (!Number.isFinite(euros)) return 0;
  const scaled = euros * 100;
  return scaled >= 0 ? Math.round(scaled + 1e-6) : -Math.round(Math.abs(scaled) + 1e-6);
}

function calculateTotals(lines: InvoiceLine[] = []): { subtotal: number; vat: number; total: number; totalCents: number; vatBreakdown: Array<{ rate: number; base: number; vat: number }> } {
  const baseCentsByRate = new Map<number, number>();
  let subtotalCents = 0;
  for (const line of lines) {
    const netCents = toCents(Number(line.quantity || 0) * Number(line.unit_price || 0));
    subtotalCents += netCents;
    const rate = Number(line.vat || 0);
    baseCentsByRate.set(rate, (baseCentsByRate.get(rate) ?? 0) + netCents);
  }
  let vatCents = 0;
  const vatBreakdown: Array<{ rate: number; base: number; vat: number }> = [];
  for (const [rate, baseCents] of [...baseCentsByRate.entries()].sort((a, b) => a[0] - b[0])) {
    const rateVatCents = toCents((baseCents / 100) * (rate / 100));
    vatCents += rateVatCents;
    vatBreakdown.push({ rate, base: baseCents / 100, vat: rateVatCents / 100 });
  }
  const totalCents = subtotalCents + vatCents;
  return { subtotal: subtotalCents / 100, vat: vatCents / 100, total: totalCents / 100, totalCents, vatBreakdown };
}

function lineGrossEuro(line: InvoiceLine): number {
  const netCents = toCents(Number(line.quantity || 0) * Number(line.unit_price || 0));
  const vatCents = toCents((netCents / 100) * (Number(line.vat || 0) / 100));
  return (netCents + vatCents) / 100;
}
function validateInvoicePdfAttachment(attachment: InvoicePdfAttachment): void { if (attachment.mimeType !== 'application/pdf') throw new WorkflowHttpError('De gegenereerde factuurbijlage is geen PDF.', 500); if (!attachment.fileName.toLowerCase().endsWith('.pdf')) throw new WorkflowHttpError('De gegenereerde factuurbijlage heeft geen PDF-bestandsnaam.', 500); if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes <= 0) throw new WorkflowHttpError('De gegenereerde factuur-PDF is leeg.', 500); if (attachment.sizeBytes > INVOICE_PDF_MAX_ATTACHMENT_BYTES) throw new WorkflowHttpError(`De factuur-PDF is te groot om als e-mailbijlage te versturen (${Math.ceil(attachment.sizeBytes / 1024 / 1024)} MB).`, 422); if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) throw new WorkflowHttpError('De factuur-PDF kon niet betrouwbaar worden gehasht.', 500); }
function formatDateNl(value: string | null): string { if (!value) return '-'; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return date.toLocaleDateString('nl-NL'); }
function formatEuro(value: number): string { return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value || 0); }
function hexToPdfRgb(value: string): RGB { const match = /^#?([0-9a-f]{6})$/i.exec(value.trim()); const hex = match ? match[1] : 'FFD966'; const int = Number.parseInt(hex, 16); return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255); }
function sanitizeFileName(value: string): string { return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'factuur'; }
function sanitizeTagValue(value: unknown): string { return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || 'invoice'; }
function sanitizeIdempotencyKey(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || crypto.randomUUID(); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ''; const chunkSize = 0x8000; for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize)); return btoa(binary); }
async function sha256HexBytes(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(value: string): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function randomToken(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoaUrlBytes(bytes); }
function btoaUrlBytes(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function parsePositiveInt(value: string | null, fallback: number): number { const parsed = Number.parseInt(String(value ?? ''), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function parseAllowedOrigins(values: Array<string | null>): string[] { const origins = new Set<string>(); for (const value of values) { if (!value) continue; for (const rawPart of value.split(',')) { const part = rawPart.trim().replace(/\/$/, ''); if (!part) continue; if (part.startsWith('http://') || part.startsWith('https://')) { try { origins.add(new URL(part).origin); } catch { origins.add(part); } } else origins.add(part); } } return [...origins]; }
function corsHeaders(req: Request): HeadersInit { const origin = req.headers.get('origin') || ''; const allowOrigin = INVOICE_ALLOWED_ORIGINS.includes(origin) || (INVOICE_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) ? origin : INVOICE_ALLOW_LOCAL_DEV && !origin ? '*' : 'null'; return { 'Access-Control-Allow-Origin': allowOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' }; }
function json(req: Request, payload: unknown, status = 200): Response { return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }); }
function assertAllowedOrigin(req: Request): void { const origin = req.headers.get('origin') || ''; if (!origin && INVOICE_ALLOW_LOCAL_DEV) return; if (INVOICE_ALLOWED_ORIGINS.includes(origin)) return; if (INVOICE_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return; if (INVOICE_ALLOWED_ORIGINS.length === 0 && INVOICE_ALLOW_LOCAL_DEV) return; if (INVOICE_ALLOWED_ORIGINS.length === 0) throw new WorkflowHttpError('INVOICE_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500); throw new WorkflowHttpError('Deze frontend-origin is niet toegestaan voor invoice workflow-acties.', 403); }
function isLocalOrigin(origin: string): boolean { return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin); }
async function requireUser(req: Request): Promise<{ id: string; email?: string }> { const auth = req.headers.get('Authorization') || ''; const token = auth.replace(/^Bearer\s+/i, ''); if (!token) throw new WorkflowHttpError('Niet ingelogd: Authorization header ontbreekt.', 401); const { data, error } = await supabaseAdmin.auth.getUser(token); if (error || !data.user) throw new WorkflowHttpError('Niet ingelogd of ongeldig sessietoken.', 401); return { id: data.user.id, email: data.user.email || undefined }; }
async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> { if (!isUuid(organizationId)) throw new WorkflowHttpError('Ongeldige organisatie.', 400); const { data, error } = await supabaseAdmin.from('organization_members').select('role').eq('organization_id', organizationId).eq('user_id', userId).eq('status', 'active').limit(1); if (error) throwSupabaseError('organization_members lookup', error); const role = data?.[0]?.role as OrganizationRole | undefined; if (!role) throw new WorkflowHttpError('Geen toegang tot deze organisatie.', 403); return role; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isEmail(value: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
async function parseBody(req: Request, contentType: string): Promise<Record<string, string>> { if (contentType.includes('application/json')) return await req.json().catch(() => ({})); const text = await req.text(); return Object.fromEntries(new URLSearchParams(text)); }

function isReusableCheckoutUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    // Broken staging records used to contain only the app base URL. Reuse only
    // real Mollie checkout URLs or mock/public invoice URLs that point at /invoice/<token>.
    if (/\/invoice\/[^/?#]+/.test(url.pathname)) return true;
    return /(^|\.)mollie\./i.test(url.hostname) || /checkout\.mollie/i.test(url.hostname);
  } catch {
    return false;
  }
}


function isValidInvoiceRedirectUrl(candidate: string, expectedPublicUrl: string): boolean {
  if (!candidate) return false;
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(expectedPublicUrl);
    if (candidateUrl.origin !== expectedUrl.origin) return false;
    // Mollie should always return to the exact public invoice route, never the app root/dashboard.
    return candidateUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

function normalizeMollieStatus(status: string): string { if (status === 'paid') return 'paid'; if (status === 'expired') return 'expired'; if (status === 'canceled' || status === 'failed') return status; if (status === 'authorized') return 'authorized'; if (status === 'pending') return 'pending'; return 'open'; }
function timingSafeEqual(a: string, b: string): boolean { const enc = new TextEncoder(); const left = enc.encode(a); const right = enc.encode(b); if (left.length !== right.length) return false; let out = 0; for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i]; return out === 0; }
function requiredEnv(name: string): string { const value = Deno.env.get(name); if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
