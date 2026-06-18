import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'https://esm.sh/pdf-lib@1.17.1';
import { renderEmailTemplate, type EmailTemplateContent, type EmailTemplateContentKey } from '../_shared/emailTemplates/index.ts';
import { decryptSecret, encryptSecret, mollieKeySuffix, validateMollieApiKey } from '../_shared/mollieSecrets.ts';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type InvoiceLine = { id?: string; description: string; quantity: number; unit_price: number; vat?: number };
type InvoiceRow = {
  id: string; organization_id: string; client_id: string | null; project_id: string | null; quote_id: string | null;
  number: string; date: string; due_date: string | null; lines: InvoiceLine[]; status: string; notes: string | null;
  public_token_hash?: string | null; public_token_expires_at?: string | null;
  reminder_level?: number | null; last_reminder_at?: string | null; reminders_paused?: boolean | null; currency?: string | null;
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
// Gedeeld secret waarmee de pg_cron-job (via pg_net) de herinneringsbatch mag
// triggeren. Zonder dit secret weigert de ?cron=reminders-ingang elke aanroep.
const INVOICE_REMINDER_CRON_SECRET = Deno.env.get('INVOICE_REMINDER_CRON_SECRET') || '';
const INVOICE_REMINDER_BATCH_LIMIT = parsePositiveInt(Deno.env.get('INVOICE_REMINDER_BATCH_LIMIT'), 200);
const INVOICE_PUBLIC_BASE_URL = Deno.env.get('INVOICE_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '';
const INVOICE_TOKEN_TTL_DAYS = parsePositiveInt(Deno.env.get('INVOICE_TOKEN_TTL_DAYS'), 60);
const INVOICE_PDF_MAX_ATTACHMENT_BYTES = parsePositiveInt(Deno.env.get('INVOICE_PDF_MAX_ATTACHMENT_BYTES'), 8 * 1024 * 1024);
// Falls back to the shared quote storage config so a single Worker + secret
// powers both the invoice and quote PDF snapshot flows.
const INVOICE_PDF_STORAGE_WORKER_URL = (
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const INVOICE_PDF_STORAGE_SECRET =
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  '';
const INVOICE_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'), Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'),
]);
const INVOICE_ALLOW_LOCAL_DEV = (Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || Deno.env.get('QUOTE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
// Invoice payments use each organization's OWN Mollie key (resolveOrganizationMollieKey),
// not a shared platform key — so the client's payment lands in the right account.
const MOLLIE_WEBHOOK_URL = Deno.env.get('INVOICE_MOLLIE_WEBHOOK_URL') || Deno.env.get('MOLLIE_WEBHOOK_URL') || '';
const MOLLIE_WEBHOOK_SECRET = Deno.env.get('INVOICE_MOLLIE_WEBHOOK_SECRET') || Deno.env.get('MOLLIE_WEBHOOK_SECRET') || '';
// Mock mode for INVOICE payments is deliberately independent of the platform
// billing flag (MOLLIE_ALLOW_MOCK). On staging the billing function runs in mock
// mode because it lacks Mollie Connect OAuth credentials, but customer invoice
// payments must always hit the REAL Mollie API with the organisation's own key —
// otherwise links get faked and auto-marked paid. Only set INVOICE_MOLLIE_ALLOW_MOCK
// =true for isolated local testing, never on an environment with real org keys.
const INVOICE_ALLOW_MOCK = (Deno.env.get('INVOICE_MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
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

    // Machine-to-machine ingang voor de dagelijkse herinneringsbatch (pg_cron +
    // pg_net). Geauthenticeerd met een gedeeld secret i.p.v. een gebruikerssessie,
    // net als de Mollie-webhook hierboven — dus vóór assertAllowedOrigin/requireUser.
    if (url.searchParams.get('cron') === 'reminders') {
      return await handleReminderCron(req, url);
    }

    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const invoiceId = String(body.invoiceId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    // Reading the stored PDF snapshot doesn't mutate anything, so any
    // organization member (including viewers) may download it. Handle it
    // before the write-role gate below.
    if (action === 'downloadInvoicePdf') {
      if (!isUuid(invoiceId)) throw new WorkflowHttpError('Ongeldige factuur.', 400);
      await loadInvoice(organizationId, invoiceId);
      const pdf = await loadInvoicePdfSnapshot(organizationId, invoiceId);
      return json(req, { ok: true, pdf });
    }

    // Reading a stored credit-note PDF is non-mutating, so any active member may
    // download it (mirrors downloadInvoicePdf). Handle before the write gate.
    if (action === 'downloadCreditNotePdf') {
      return json(req, { ok: true, ...(await downloadCreditNotePdf(organizationId, body)) });
    }

    // Masked Mollie status is readable by any active member (no secret leaves the
    // server), so the send dialog can decide whether to offer a payment link.
    if (action === 'getInvoiceMollieStatus') {
      return json(req, { ok: true, status: await getInvoiceMollieStatus(organizationId) });
    }

    if (!['owner', 'admin', 'member'].includes(role)) throw new WorkflowHttpError('Geen schrijfrechten voor deze organisatie.', 403);

    switch (action) {
      case 'sendInvoiceEmail': return json(req, { ok: true, ...(await sendInvoiceEmail(user.id, organizationId, invoiceId, body)) });
      case 'sendInvoiceReminderEmail': return json(req, { ok: true, ...(await sendInvoiceReminderEmail(user.id, organizationId, invoiceId, body)) });
      case 'createInvoicePaymentCheckout': return json(req, { ok: true, ...(await createInvoicePaymentCheckout(user.id, organizationId, invoiceId, body)) });
      case 'createInvoiceRefund': return json(req, { ok: true, ...(await createInvoiceRefund(user.id, organizationId, role, invoiceId, body)) });
      case 'sendCreditNoteEmail': return json(req, { ok: true, ...(await sendCreditNoteEmail(user.id, organizationId, body)) });
      case 'markMockInvoicePaymentPaid': return json(req, { ok: true, payment: await markMockInvoicePaymentPaid(String(body.providerPaymentId || '')) });
      case 'saveInvoiceMollieKey': return json(req, { ok: true, status: await saveInvoiceMollieKey(user.id, organizationId, role, body) });
      case 'deleteInvoiceMollieKey': return json(req, { ok: true, ...(await deleteInvoiceMollieKey(organizationId, role)) });
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

  const [client, project, quote, company, content] = await Promise.all([
    loadClient(organizationId, invoice.client_id),
    invoice.project_id ? loadProject(organizationId, invoice.project_id) : Promise.resolve(null),
    invoice.quote_id ? loadQuote(organizationId, invoice.quote_id) : Promise.resolve(null),
    loadCompanySettings(organizationId),
    loadEmailTemplateContent(organizationId, 'invoice.sent'),
  ]);

  const recipientEmail = String(body.recipientEmail || client.email || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || client.contact_name || client.name || '').trim();
  if (!isEmail(recipientEmail)) throw new WorkflowHttpError('Vul een geldig klant-e-mailadres in voordat je de factuur verstuurt.', 422);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + Math.max(1, INVOICE_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const publicUrl = `${INVOICE_PUBLIC_BASE_URL.replace(/\/$/, '')}/invoice/${encodeURIComponent(token)}`;

  // Payment link is OPT-IN per send, and only possible when this organization has
  // connected its OWN Mollie account. There is deliberately no shared-key fallback:
  // that would route the client's payment into the platform account.
  const includePaymentLink = body.includePaymentLink === true;
  let paymentUrl: string | null = null;
  let paymentLinkError: string | null = null;
  if (includePaymentLink) {
    try {
      const paymentCheckout = await createInvoicePaymentCheckout(userId, organizationId, invoiceId, body);
      paymentUrl = paymentCheckout.checkoutUrl || null;
    } catch (error) {
      // A payment-link failure (missing Mollie/webhook config, a Mollie API
      // error, a revoked key, …) must NEVER block sending the invoice itself.
      // We fall back to a PDF-only email and report the reason back so the user
      // can fix the configuration without losing the send.
      paymentLinkError = error instanceof Error ? error.message : 'Mollie-betaallink kon niet worden aangemaakt.';
      console.warn('Invoice payment link creation failed, sending PDF-only:', paymentLinkError);
      paymentUrl = null;
    }
  }

  const renderedEmail = renderEmailTemplate('invoice.sent', { invoice, client, project, quote, company, publicUrl, paymentUrl, recipientName, expiresAt, content });
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

  const senderIdentity = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  const resendPayload = {
    from: senderIdentity.from,
    to: [recipientEmail],
    reply_to: senderIdentity.replyTo,
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
  return { delivery: finalized.delivery, version: finalized.version, publicUrl, providerEmailId, paymentLinkIncluded: Boolean(paymentUrl), paymentLinkError, attachment: { fileName: pdfAttachment.fileName, sizeBytes: pdfAttachment.sizeBytes, sha256: pdfAttachment.sha256, storageProvider: storedPdf.provider, storageKey: storedPdf.key } };
}

// ============================================================
// Betalingsherinneringen (getrapt, 3 niveaus) — automatisch + handmatig.
// ============================================================

type ReminderSettingsRow = {
  auto_reminders_enabled: boolean;
  include_payment_link: boolean;
  level1_offset_days: number;
  level2_offset_days: number;
  level3_offset_days: number;
};

// Cron-ingang: door pg_cron (via pg_net) dagelijks aangeroepen met een gedeeld
// secret. Markeert te-late facturen en stuurt de openstaande herinneringen.
async function handleReminderCron(req: Request, url: URL): Promise<Response> {
  if (!INVOICE_REMINDER_CRON_SECRET) return json(req, { ok: false, error: 'INVOICE_REMINDER_CRON_SECRET ontbreekt in de Edge Function secrets.' }, 500);
  const provided = req.headers.get('x-cron-secret') || url.searchParams.get('secret') || '';
  if (!timingSafeEqual(provided, INVOICE_REMINDER_CRON_SECRET)) return json(req, { ok: false, error: 'Invalid cron secret' }, 401);
  try {
    const summary = await runInvoiceReminderBatch();
    return json(req, { ok: true, ...summary });
  } catch (error) {
    console.error('invoice reminder cron error', describeError(error), serializeError(error));
    return json(req, { ok: false, error: describeError(error) }, 500);
  }
}

// Markeer te-late facturen en verstuur per kandidaat het eerstvolgende niveau.
// Eén factuurfout stopt de batch niet — die wordt geregistreerd en overgeslagen.
async function runInvoiceReminderBatch(): Promise<{ markedOverdue: number; candidates: number; sent: number; failed: number; errors: Array<{ invoiceId: string; level: number; error: string }> }> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) throw new WorkflowHttpError('Resend-secrets ontbreken; herinneringen kunnen niet worden verstuurd.', 500);
  if (!INVOICE_PUBLIC_BASE_URL) throw new WorkflowHttpError('INVOICE_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.', 500);

  const markedOverdue = await markInvoicesOverdue(null);
  const candidates = await findDueInvoiceReminders(INVOICE_REMINDER_BATCH_LIMIT);

  let sent = 0;
  let failed = 0;
  const errors: Array<{ invoiceId: string; level: number; error: string }> = [];
  for (const candidate of candidates) {
    try {
      const settings = await loadReminderSettings(candidate.organization_id);
      const actorUserId = await resolveOrgActorUserId(candidate.organization_id);
      await deliverInvoiceReminder({
        organizationId: candidate.organization_id,
        invoiceId: candidate.invoice_id,
        level: candidate.next_level,
        daysOverdue: candidate.days_overdue,
        actorUserId,
        includePaymentLink: settings?.include_payment_link ?? true,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      errors.push({ invoiceId: candidate.invoice_id, level: candidate.next_level, error: describeError(error) });
      console.warn('Herinnering voor factuur mislukt', candidate.invoice_id, describeError(error));
    }
  }
  return { markedOverdue, candidates: candidates.length, sent, failed, errors };
}

// Handmatige actie (owner/admin/member): stuur één herinnering op afroep. Het
// niveau is expliciet (body.level) of automatisch het volgende (reminder_level + 1).
async function sendInvoiceReminderEmail(userId: string, organizationId: string, invoiceId: string, body: Record<string, unknown>) {
  if (!isUuid(invoiceId)) throw new WorkflowHttpError('Ongeldige factuur.', 400);
  const invoice = await loadInvoice(organizationId, invoiceId);
  if (['paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status)) throw new WorkflowHttpError('Voor een betaalde, geannuleerde of afgeboekte factuur kan geen herinnering worden verstuurd.', 409);

  const explicitLevel = Number(body.level);
  const level = Number.isFinite(explicitLevel) && explicitLevel >= 1 && explicitLevel <= 3
    ? Math.round(explicitLevel)
    : Math.min(3, (Number(invoice.reminder_level) || 0) + 1);

  const settings = await loadReminderSettings(organizationId);
  const includePaymentLink = body.includePaymentLink === undefined
    ? (settings?.include_payment_link ?? true)
    : body.includePaymentLink === true;

  return await deliverInvoiceReminder({
    organizationId,
    invoiceId,
    level,
    actorUserId: userId,
    includePaymentLink,
    recipientEmail: body.recipientEmail ? String(body.recipientEmail) : undefined,
    recipientName: body.recipientName ? String(body.recipientName) : undefined,
  });
}

// Gedeelde verzendkern voor cron én handmatig. Hergebruikt de factuur-PDF-snapshot,
// publieke token en (optioneel) de Mollie-betaallink-logica van de gewone verzending.
async function deliverInvoiceReminder(input: { organizationId: string; invoiceId: string; level: number; daysOverdue?: number | null; actorUserId: string | null; includePaymentLink: boolean; recipientEmail?: string; recipientName?: string }) {
  const { organizationId, invoiceId, actorUserId, includePaymentLink } = input;
  const level = Math.min(3, Math.max(1, Math.round(input.level))) as 1 | 2 | 3;
  if (!RESEND_API_KEY) throw new WorkflowHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  if (!RESEND_FROM_EMAIL) throw new WorkflowHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  if (!INVOICE_PUBLIC_BASE_URL) throw new WorkflowHttpError('INVOICE_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.', 500);
  if (!isUuid(invoiceId)) throw new WorkflowHttpError('Ongeldige factuur.', 400);

  const invoice = await loadInvoice(organizationId, invoiceId);
  if (['paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status)) throw new WorkflowHttpError('Voor deze factuur kan geen herinnering worden verstuurd.', 409);
  if (!invoice.client_id) throw new WorkflowHttpError('Deze factuur heeft geen klant gekoppeld.', 422);

  const [client, project, company, content] = await Promise.all([
    loadClient(organizationId, invoice.client_id),
    invoice.project_id ? loadProject(organizationId, invoice.project_id) : Promise.resolve(null),
    loadCompanySettings(organizationId),
    loadEmailTemplateContent(organizationId, `invoice.reminder.${level}` as EmailTemplateContentKey),
  ]);

  const recipientEmail = String(input.recipientEmail || client.email || '').trim().toLowerCase();
  const recipientName = String(input.recipientName || client.contact_name || client.name || '').trim();
  if (!isEmail(recipientEmail)) throw new WorkflowHttpError('Vul een geldig klant-e-mailadres in voordat je een herinnering verstuurt.', 422);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + Math.max(1, INVOICE_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const publicUrl = `${INVOICE_PUBLIC_BASE_URL.replace(/\/$/, '')}/invoice/${encodeURIComponent(token)}`;

  // Betaallink is best-effort: de Mollie-checkout vereist een echte actor-user, en
  // een fout (geen Mollie, revoked key, …) mag de herinnering nooit blokkeren.
  let paymentUrl: string | null = null;
  let paymentLinkError: string | null = null;
  if (includePaymentLink && actorUserId) {
    try {
      const checkout = await createInvoicePaymentCheckout(actorUserId, organizationId, invoiceId, {});
      paymentUrl = checkout.checkoutUrl || null;
    } catch (error) {
      paymentLinkError = error instanceof Error ? error.message : 'Mollie-betaallink kon niet worden aangemaakt.';
      console.warn('Reminder payment link creation failed, sending without link:', paymentLinkError);
      paymentUrl = null;
    }
  }

  const rendered = renderEmailTemplate('invoice.reminder', { level, invoice, client, project, company, publicUrl, paymentUrl, recipientName, daysOverdue: input.daysOverdue ?? null, content });
  const subject = rendered.subject;

  // PDF: hergebruik de opgeslagen snapshot (exact wat de klant eerder kreeg). Is er
  // nog geen snapshot, dan genereren we er één en slaan die best-effort op.
  let pdfFileName: string;
  let pdfBase64: string;
  let pdfMime = 'application/pdf';
  let pdfSize: number | null = null;
  let pdfSha: string | null = null;
  try {
    const snapshot = await loadInvoicePdfSnapshot(organizationId, invoiceId);
    pdfFileName = snapshot.fileName; pdfBase64 = snapshot.base64; pdfMime = snapshot.mimeType; pdfSize = snapshot.sizeBytes; pdfSha = snapshot.sha256;
  } catch {
    const quote = invoice.quote_id ? await loadQuote(organizationId, invoice.quote_id) : null;
    const attachment = await createInvoicePdfAttachment({ invoice, client, project, quote, company, publicUrl, paymentUrl });
    validateInvoicePdfAttachment(attachment);
    await storeInvoicePdfSnapshot(organizationId, invoiceId, attachment).catch((storeError) => console.warn('Reminder PDF-snapshot opslaan mislukte (niet fataal):', storeError instanceof Error ? storeError.message : storeError));
    pdfFileName = attachment.fileName; pdfBase64 = attachment.base64; pdfMime = attachment.mimeType; pdfSize = attachment.sizeBytes; pdfSha = attachment.sha256;
  }

  const prepared = await beginInvoiceReminderSend({
    invoiceId, organizationId, userId: actorUserId, level, tokenHash, expiresAt, recipientEmail, recipientName, subject, publicUrl,
    attachmentFileName: pdfFileName, attachmentMimeType: pdfMime, attachmentSizeBytes: pdfSize ?? undefined, attachmentSha256: pdfSha ?? undefined,
  });

  const senderIdentity = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  const resendPayload = {
    from: senderIdentity.from,
    to: [recipientEmail],
    reply_to: senderIdentity.replyTo,
    subject,
    html: rendered.html,
    text: rendered.text,
    attachments: [{ filename: pdfFileName, content: pdfBase64 }],
    tags: [
      { name: 'organization_id', value: sanitizeTagValue(organizationId) },
      { name: 'invoice_id', value: sanitizeTagValue(invoiceId) },
      { name: 'invoice_number', value: sanitizeTagValue(invoice.number) },
      { name: 'template_key', value: 'invoice_reminder' },
      { name: 'reminder_level', value: sanitizeTagValue(`L${level}`) },
    ],
  };

  let resendResponse: Response;
  let resendPayloadResponse: Record<string, unknown> = {};
  try {
    resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(`reminder-${invoiceId}-L${level}-${prepared.deliveryId}`) },
      body: JSON.stringify(resendPayload),
    });
    resendPayloadResponse = (await resendResponse.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (error) {
    const message = `Resend provider request failed before a response was received: ${describeError(error)}`;
    await failInvoiceReminderSend(prepared.deliveryId, organizationId, actorUserId, message);
    throw new WorkflowHttpError(`Resend kon de herinnering niet versturen: ${message}`, 502);
  }

  if (!resendResponse.ok) {
    const message = String(resendPayloadResponse.message || resendPayloadResponse.error || resendResponse.statusText || 'Resend send failed');
    await failInvoiceReminderSend(prepared.deliveryId, organizationId, actorUserId, message);
    throw new WorkflowHttpError(`Resend kon de herinnering niet versturen: ${message}`, 502);
  }
  const providerEmailId = String(resendPayloadResponse.id || resendPayloadResponse.email_id || '').trim();
  if (!providerEmailId) {
    await failInvoiceReminderSend(prepared.deliveryId, organizationId, actorUserId, 'Resend accepted the request but did not return a provider email id.');
    throw new WorkflowHttpError('Resend gaf geen e-mail-ID terug. De herinnering is niet definitief gemarkeerd.', 502);
  }

  const finalized = await completeInvoiceReminderSend(prepared.deliveryId, organizationId, actorUserId, providerEmailId, level);
  return { delivery: finalized.delivery, invoice: finalized.invoice, level, publicUrl, providerEmailId, paymentLinkIncluded: Boolean(paymentUrl), paymentLinkError, recipientEmail };
}

async function markInvoicesOverdue(organizationId: string | null): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('mark_invoices_overdue', { p_organization_id: organizationId });
  if (error) throwRpcError('mark_invoices_overdue', error);
  return Number(data ?? 0) || 0;
}

async function findDueInvoiceReminders(limit: number): Promise<Array<{ organization_id: string; invoice_id: string; next_level: number; days_overdue: number }>> {
  const { data, error } = await supabaseAdmin.rpc('find_due_invoice_reminders', { p_now: new Date().toISOString(), p_limit: limit });
  if (error) throwRpcError('find_due_invoice_reminders', error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    organization_id: String(row.organization_id),
    invoice_id: String(row.invoice_id),
    next_level: Number(row.next_level) || 1,
    days_overdue: Number(row.days_overdue) || 0,
  }));
}

async function loadReminderSettings(organizationId: string): Promise<ReminderSettingsRow | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_reminder_settings')
    .select('auto_reminders_enabled,include_payment_link,level1_offset_days,level2_offset_days,level3_offset_days')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) { console.warn('reminder settings lookup mislukte', error.message); return null; }
  return (data ?? null) as ReminderSettingsRow | null;
}

// Resolve een schrijfbevoegde actor (owner > admin > member) voor cron-acties die
// een echte gebruiker vereisen (de Mollie-betaallink-checkout). Geeft null als de
// organisatie geen actieve leden heeft — dan gaat de herinnering zonder betaallink.
async function resolveOrgActorUserId(organizationId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('user_id,role')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin', 'member'])
    .limit(20);
  if (error) { console.warn('actor lookup mislukte', error.message); return null; }
  const rows = (data ?? []) as Array<{ user_id: string; role: string }>;
  const pick = rows.find((r) => r.role === 'owner') ?? rows.find((r) => r.role === 'admin') ?? rows[0];
  return pick?.user_id ?? null;
}

async function beginInvoiceReminderSend(input: { invoiceId: string; organizationId: string; userId: string | null; level: number; tokenHash: string; expiresAt: string; recipientEmail: string; recipientName: string; subject: string; publicUrl: string; attachmentFileName?: string; attachmentMimeType?: string; attachmentSizeBytes?: number; attachmentSha256?: string }): Promise<{ deliveryId: string }> {
  const { data, error } = await supabaseAdmin.rpc('begin_invoice_reminder_send', {
    p_invoice_id: input.invoiceId,
    p_organization_id: input.organizationId,
    p_actor_user_id: input.userId,
    p_level: input.level,
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
  });
  if (error) throwRpcError('begin_invoice_reminder_send', error);
  const payload = data as { deliveryId?: string } | null;
  if (!payload?.deliveryId) throw new WorkflowHttpError('Herinnering kon niet worden voorbereid.', 500);
  return { deliveryId: payload.deliveryId };
}

async function completeInvoiceReminderSend(deliveryId: string, organizationId: string, userId: string | null, providerEmailId: string, level: number): Promise<{ delivery?: unknown; invoice?: unknown }> {
  const { data, error } = await supabaseAdmin.rpc('complete_invoice_reminder_send', { p_delivery_id: deliveryId, p_organization_id: organizationId, p_actor_user_id: userId, p_provider_email_id: providerEmailId, p_level: level });
  if (error) throwRpcError('complete_invoice_reminder_send', error);
  return (data ?? {}) as { delivery?: unknown; invoice?: unknown };
}

async function failInvoiceReminderSend(deliveryId: string, organizationId: string, userId: string | null, errorMessage: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('fail_invoice_reminder_send', { p_delivery_id: deliveryId, p_organization_id: organizationId, p_actor_user_id: userId, p_error_message: errorMessage });
  if (error) console.warn('Reminder failure registration failed', error.message);
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
    if (INVOICE_ALLOW_MOCK) {
      providerPaymentId = `mock_invoice_payment_${crypto.randomUUID()}`;
      checkoutUrl = `${publicUrl}?mock_payment=${encodeURIComponent(providerPaymentId)}`;
      metadata = { mock: true, publicUrl };
    } else {
      const orgKey = await resolveOrganizationMollieKey(organizationId);
      if (!orgKey) throw new WorkflowHttpError('Koppel eerst het eigen Mollie-account van deze organisatie in de instellingen voordat je een betaallink aanmaakt.', 409);
      if (!MOLLIE_WEBHOOK_URL) throw new WorkflowHttpError('INVOICE_MOLLIE_WEBHOOK_URL of MOLLIE_WEBHOOK_URL ontbreekt.', 500);
      const requestedRedirectUrl = String(body.redirectUrl || '').trim();
      const redirectUrl = isValidInvoiceRedirectUrl(requestedRedirectUrl, publicUrl) ? requestedRedirectUrl : publicUrl;
      const webhookUrl = MOLLIE_WEBHOOK_SECRET ? `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}webhook=mollie&secret=${encodeURIComponent(MOLLIE_WEBHOOK_SECRET)}` : `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}webhook=mollie`;
      const mollieResponse = await fetch('https://api.mollie.com/v2/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${orgKey.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(idempotencyKey) },
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

async function createInvoiceRefund(userId: string, organizationId: string, role: OrganizationRole, invoiceId: string, body: Record<string, unknown>) {
  // Terugbetalingen zijn gevoelig: alleen owners en admins mogen ze registreren.
  if (!['owner', 'admin'].includes(role)) throw new WorkflowHttpError('Alleen owners en admins mogen terugbetalingen registreren.', 403);
  if (!isUuid(invoiceId)) throw new WorkflowHttpError('Ongeldige factuur.', 400);

  const invoice = await loadInvoice(organizationId, invoiceId);
  if (!['paid', 'refunded'].includes(invoice.status)) throw new WorkflowHttpError('Alleen betaalde facturen kunnen worden terugbetaald.', 409);
  if (!invoice.client_id) throw new WorkflowHttpError('Deze factuur heeft geen klant gekoppeld.', 422);

  const totals = calculateTotals(invoice.lines);
  const invoiceTotalCents = totals.totalCents;
  if (invoiceTotalCents <= 0) throw new WorkflowHttpError('Deze factuur heeft geen positief bedrag om terug te betalen.', 422);

  const amountCents = Math.round(Number(body.amountCents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new WorkflowHttpError('Vul een geldig terugbetaalbedrag (in centen) in.', 422);
  if (amountCents > invoiceTotalCents) throw new WorkflowHttpError('Het terugbetaalbedrag mag niet groter zijn dan het factuurbedrag.', 422);

  const reason = String(body.reason || '').trim() || null;
  const createCreditNote = body.createCreditNote !== false; // standaard: wel een creditfactuur
  const kind: 'manual' | 'mollie' = body.kind === 'mollie' ? 'mollie' : 'manual';
  // Stabiele idempotency-key per terugbetaalactie (voorkomt dubbel boeken bij
  // dubbelklik/retry), maar staat bewust meerdere losse (deel)terugbetalingen toe.
  const idempotencyKey = sanitizeIdempotencyKey(String(body.idempotencyKey || `invoice-${invoiceId}-refund-${crypto.randomUUID()}`));

  // Fase 2: echte Mollie-terugbetaling (async afgehandeld via webhook).
  if (kind === 'mollie') {
    return await createMollieInvoiceRefund({ userId, organizationId, invoice, invoiceTotalCents, totals, amountCents, reason, createCreditNote, idempotencyKey });
  }

  // Fase 1: handmatige (offline) terugbetaling — direct als 'refunded' geboekt.
  const refund = await beginInvoiceRefund({ invoiceId, organizationId, userId, amountCents, reason, kind: 'manual', idempotencyKey, metadata: { create_credit_note: createCreditNote } });

  let creditNote: Record<string, unknown> | null = null;
  if (refund.credit_note_id) {
    // Idempotente retry: er was al een creditfactuur voor deze terugbetaling.
    creditNote = await loadCreditNote(organizationId, String(refund.credit_note_id));
  } else if (createCreditNote) {
    const [client, company] = await Promise.all([
      loadClient(organizationId, invoice.client_id),
      loadCompanySettings(organizationId),
    ]);
    creditNote = await issueCreditNoteForRefund({ userId, organizationId, invoice, client, company, refund, amountCents, invoiceTotalCents, totals, reason });
  }

  return { refund, creditNote };
}

// ------------------------------------------------------------
// Fase 2: Mollie-terugbetaling uitvoeren
// ------------------------------------------------------------
// Het geld loopt terug via de oorspronkelijke Mollie-betaling. De terugbetaling
// is asynchroon: Mollie zet de refund eerst op queued/pending/processing en pingt
// later de payment-webhook met de eindstatus. De creditfactuur wordt daarom pas
// aangemaakt wanneer de refund de status 'refunded' bereikt (synchroon bij mock,
// anders via de webhook-reconciliatie).
async function createMollieInvoiceRefund(input: {
  userId: string; organizationId: string; invoice: InvoiceRow; invoiceTotalCents: number;
  totals: ReturnType<typeof calculateTotals>; amountCents: number; reason: string | null;
  createCreditNote: boolean; idempotencyKey: string;
}): Promise<{ refund: RefundRow; creditNote: Record<string, unknown> | null }> {
  const { userId, organizationId, invoice, amountCents, reason, createCreditNote, idempotencyKey } = input;

  // 1. Vind de betaalde Mollie-betaling met genoeg resterend terugbetaalbaar bedrag.
  const payment = await findRefundableMolliePayment(organizationId, invoice.id, amountCents);
  if (!payment) {
    throw new WorkflowHttpError('Geen terugbetaalbare Mollie-betaling gevonden voor deze factuur. Is de factuur wel via Mollie betaald, en is er nog voldoende terug te betalen? Gebruik anders een handmatige terugbetaling.', 409);
  }

  // 2. Registreer de terugbetaling als 'queued' (telt mee in de over-refund-guard).
  const refund = await beginInvoiceRefund({
    invoiceId: invoice.id, organizationId, userId, amountCents, reason,
    kind: 'mollie', idempotencyKey, paymentRecordId: payment.id,
    metadata: { create_credit_note: createCreditNote },
  });

  // Idempotente retry: deze terugbetaling is al (deels) verwerkt.
  if (refund.status === 'refunded' || refund.provider_refund_id) {
    const creditNote = refund.credit_note_id ? await loadCreditNote(organizationId, String(refund.credit_note_id)) : null;
    return { refund, creditNote };
  }

  // 3. Voer de terugbetaling uit bij Mollie (of simuleer bij mock).
  let providerRefundId = '';
  let mollieStatus = 'queued';
  let molliePayload: Record<string, unknown> = {};
  try {
    if (INVOICE_ALLOW_MOCK && (payment.provider_payment_id || '').startsWith('mock_')) {
      providerRefundId = `mock_refund_${crypto.randomUUID()}`;
      mollieStatus = 'refunded'; // mock: direct verwerkt zodat de dev-flow synchroon afrondt
      molliePayload = { mock: true };
    } else {
      const orgKey = await resolveOrganizationMollieKey(organizationId);
      if (!orgKey) throw new WorkflowHttpError('De Mollie-koppeling van deze organisatie ontbreekt; de terugbetaling kan niet worden uitgevoerd.', 409);
      if (!payment.provider_payment_id) throw new WorkflowHttpError('De Mollie-betaling heeft geen geldig payment-id.', 422);
      const created = await createMollieRefund(orgKey.apiKey, payment.provider_payment_id, amountCents, invoice, refund.id, organizationId);
      providerRefundId = created.id;
      mollieStatus = created.status;
      molliePayload = created.payload;
    }
  } catch (error) {
    // Mollie heeft niets (of niet bevestigd iets) geboekt → de terugbetaling vrijgeven
    // zodat het bedrag niet onterecht in de over-refund-guard blijft hangen.
    const message = error instanceof Error ? error.message : 'Onbekende Mollie-fout bij terugbetaling.';
    await failInvoiceRefund(refund.id, organizationId, message, 'failed', { stage: 'create_refund' })
      .catch((failError) => console.warn('fail_invoice_refund na Mollie-fout mislukte', failError instanceof Error ? failError.message : failError));
    if (error instanceof WorkflowHttpError) throw error;
    throw new WorkflowHttpError(`Mollie kon de terugbetaling niet aanmaken: ${message}`, 502);
  }

  // 4. Sla provider_refund_id + status op. 'refunded' = direct verwerkt (mock/zeldzaam).
  const normalized = normalizeMollieRefundStatus(mollieStatus);
  const updated = await completeInvoiceRefund(refund.id, organizationId, providerRefundId, normalized, { mollie_refund: molliePayload });

  let creditNote: Record<string, unknown> | null = null;
  if (normalized === 'refunded') {
    creditNote = await ensureCreditNoteForRefund(updated);
  }
  return { refund: updated, creditNote };
}

async function issueCreditNoteForRefund(input: { userId: string | null; organizationId: string; invoice: InvoiceRow; client: ClientRow; company: CompanySettingsRow | null; refund: { id: string }; amountCents: number; invoiceTotalCents: number; totals: ReturnType<typeof calculateTotals>; reason: string | null }) {
  const { userId, organizationId, invoice, client, company, refund, amountCents, invoiceTotalCents, totals, reason } = input;
  const currency = invoice.currency || 'EUR';
  const isFull = amountCents >= invoiceTotalCents;

  let subtotal: number;
  let vat: number;
  let total: number;
  let lines: InvoiceLine[];

  if (isFull) {
    // Volledige terugbetaling: spiegel de factuur exact, zodat de btw netjes terugloopt.
    subtotal = totals.subtotal;
    vat = totals.vat;
    total = totals.total;
    lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  } else {
    // Gedeeltelijk: één creditregel, btw pro-rata over het terugbetaalde brutobedrag.
    total = amountCents / 100;
    const ratio = amountCents / invoiceTotalCents;
    subtotal = Math.round(totals.subtotal * ratio * 100) / 100;
    vat = Math.round((total - subtotal) * 100) / 100;
    const blendedRate = subtotal > 0 ? Math.round((vat / subtotal) * 10000) / 100 : 0;
    lines = [{ description: `Gedeeltelijke terugbetaling factuur ${invoice.number}${reason ? ` – ${reason}` : ''}`, quantity: 1, unit_price: subtotal, vat: blendedRate }];
  }

  // 1. Creditfactuur server-side aanmaken (kent atomair het CN-nummer toe).
  const created = await issueCreditNote({ organizationId, invoiceId: invoice.id, refundId: refund.id, userId, reason, currency, subtotal, vat, total, lines });
  const creditNoteNumber = String(created.number || '');

  // 2. PDF renderen met het toegekende nummer. Bij geconfigureerde storage gaat de
  //    PDF naar private R2 (consistent met facturen), anders als base64 in de DB.
  //    De creditfactuur (ledger + nummer) is al definitief; een PDF- of mailfout
  //    mag de terugbetaling niet laten falen.
  let finalCreditNote: Record<string, unknown> = created;
  let pdfBase64: string | null = null;
  try {
    const attachment = await createCreditNotePdfAttachment({ creditNoteNumber, date: String(created.date || ''), invoice, client, company, currency, subtotal, vat, total, lines, reason });
    validateInvoicePdfAttachment(attachment);
    const stored = await storeCreditNotePdfSnapshot(organizationId, invoice.id, String(created.id), attachment);
    pdfBase64 = attachment.base64;

    const { error } = await supabaseAdmin
      .from('credit_notes')
      .update({
        pdf_file_name: attachment.fileName,
        pdf_mime_type: attachment.mimeType,
        pdf_size_bytes: attachment.sizeBytes,
        pdf_sha256: attachment.sha256,
        pdf_data_base64: stored.shouldStoreBase64InDatabase ? attachment.base64 : null,
        pdf_storage_provider: stored.provider,
        pdf_storage_key: stored.key,
      })
      .eq('id', created.id)
      .eq('organization_id', organizationId);
    if (error) throw new Error(error.message);

    finalCreditNote = { ...created, pdf_file_name: attachment.fileName, pdf_mime_type: attachment.mimeType, pdf_size_bytes: attachment.sizeBytes, pdf_sha256: attachment.sha256, pdf_data_base64: stored.shouldStoreBase64InDatabase ? attachment.base64 : null, pdf_storage_provider: stored.provider, pdf_storage_key: stored.key };
  } catch (pdfError) {
    console.warn('Creditfactuur-PDF kon niet worden gegenereerd/opgeslagen; de creditnota zelf is wel aangemaakt.', pdfError instanceof Error ? pdfError.message : pdfError);
    return created;
  }

  // 3. Creditfactuur automatisch naar de klant mailen (best-effort). Een mailfout
  //    mag de terugbetaling niet laten falen; de handmatige knop kan 'm opnieuw sturen.
  //    Enkel als alle vereiste voorwaarden zijn vervuld en de PDF beschikbaar is.
  const hasPdfAvailable = Boolean(finalCreditNote.pdf_data_base64 || (finalCreditNote.pdf_storage_provider === 'r2' && finalCreditNote.pdf_storage_key));
  if (client.email && RESEND_API_KEY && RESEND_FROM_EMAIL && hasPdfAvailable) {
    try {
      await deliverCreditNoteEmail({ organizationId, userId, creditNote: finalCreditNote, invoice, client, company, recipientEmail: client.email, recipientName: null, pdfBase64: pdfBase64 ?? undefined });
    } catch (emailError) {
      console.warn('Creditfactuur automatisch mailen mislukt; de creditnota is wel aangemaakt.', emailError instanceof Error ? emailError.message : emailError);
    }
  }

  return finalCreditNote;
}

// Volledige rijvorm van public.invoice_refunds zoals de RPC's die teruggeven.
type RefundRow = {
  id: string; organization_id: string; invoice_id: string; payment_record_id: string | null;
  kind: string; provider: string | null; provider_refund_id: string | null; status: string;
  amount_cents: number; currency: string; reason: string | null; credit_note_id: string | null;
  idempotency_key: string | null; initiated_by: string | null; metadata: Record<string, unknown> | null;
  refunded_at: string | null; failed_at: string | null; error_message: string | null;
};

async function beginInvoiceRefund(input: { invoiceId: string; organizationId: string; userId: string; amountCents: number; reason: string | null; kind: 'manual' | 'mollie'; idempotencyKey: string; paymentRecordId?: string | null; metadata?: Record<string, unknown> }): Promise<RefundRow> {
  const { data, error } = await supabaseAdmin.rpc('begin_invoice_refund', {
    p_invoice_id: input.invoiceId,
    p_organization_id: input.organizationId,
    p_actor_user_id: input.userId,
    p_amount_cents: input.amountCents,
    p_reason: input.reason,
    p_kind: input.kind,
    p_payment_record_id: input.paymentRecordId ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_metadata: input.metadata ?? {},
  });
  if (error) throwRpcError('begin_invoice_refund', error);
  return data as RefundRow;
}

// Werk een terugbetaling bij naar (in-flight of finale) status + provider_refund_id.
// Bij status 'refunded' logt de RPC zelf het event/audit en herberekent de aggregaten.
async function completeInvoiceRefund(refundId: string, organizationId: string, providerRefundId: string | null, status: string, metadata: Record<string, unknown> = {}): Promise<RefundRow> {
  const { data, error } = await supabaseAdmin.rpc('complete_invoice_refund', {
    p_refund_id: refundId,
    p_organization_id: organizationId,
    p_provider_refund_id: providerRefundId || null,
    p_status: status,
    p_metadata: metadata,
  });
  if (error) throwRpcError('complete_invoice_refund', error);
  return data as RefundRow;
}

// Markeer een terugbetaling als mislukt/geannuleerd (geeft het bedrag vrij in de guard).
async function failInvoiceRefund(refundId: string, organizationId: string, errorMessage: string | null, status: 'failed' | 'canceled' = 'failed', metadata: Record<string, unknown> = {}): Promise<RefundRow> {
  const { data, error } = await supabaseAdmin.rpc('fail_invoice_refund', {
    p_refund_id: refundId,
    p_organization_id: organizationId,
    p_error_message: errorMessage || null,
    p_status: status,
    p_metadata: metadata,
  });
  if (error) throwRpcError('fail_invoice_refund', error);
  return data as RefundRow;
}

// Vind de betaalde Mollie-betaling met genoeg resterend terugbetaalbaar bedrag.
// amount_refunded_cents wordt door recompute_invoice_refund_state bijgehouden; we
// gebruiken het als lokale proxy — Mollie doet alsnog de autoritatieve controle.
async function findRefundableMolliePayment(organizationId: string, invoiceId: string, amountCents: number): Promise<{ id: string; provider_payment_id: string | null; amount_cents: number; amount_refunded_cents: number } | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,provider_payment_id,amount_cents,amount_refunded_cents,status')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .eq('provider', 'mollie')
    .in('status', ['paid', 'refunded'])
    .order('paid_at', { ascending: false, nullsFirst: false });
  if (error) throwSupabaseError('Mollie-betaling zoeken', error);
  const rows = (data ?? []) as Array<{ id: string; provider_payment_id: string | null; amount_cents: number; amount_refunded_cents: number | null }>;
  for (const row of rows) {
    if (!row.provider_payment_id) continue;
    if (!INVOICE_ALLOW_MOCK && row.provider_payment_id.startsWith('mock_')) continue;
    const remaining = (row.amount_cents || 0) - (row.amount_refunded_cents || 0);
    if (remaining >= amountCents) return { id: row.id, provider_payment_id: row.provider_payment_id, amount_cents: row.amount_cents, amount_refunded_cents: row.amount_refunded_cents || 0 };
  }
  return null;
}

// Maak een terugbetaling aan bij Mollie tegen de oorspronkelijke betaling.
async function createMollieRefund(apiKey: string, molliePaymentId: string, amountCents: number, invoice: InvoiceRow, refundId: string, organizationId: string): Promise<{ id: string; status: string; payload: Record<string, unknown> }> {
  const response = await fetch(`https://api.mollie.com/v2/payments/${encodeURIComponent(molliePaymentId)}/refunds`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Stabiele key per terugbetaalrij: een retry boekt nooit een dubbele Mollie-refund.
      'Idempotency-Key': sanitizeIdempotencyKey(`invoice-refund-${refundId}`),
    },
    body: JSON.stringify({
      amount: { currency: invoice.currency || 'EUR', value: (amountCents / 100).toFixed(2) },
      description: `Terugbetaling factuur ${invoice.number}`,
      metadata: { organizationId, invoiceId: invoice.id, invoiceNumber: invoice.number, refundId },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = String((payload as Record<string, unknown>).detail || (payload as Record<string, unknown>).title || response.statusText);
    throw new WorkflowHttpError(`Mollie weigerde de terugbetaling: ${detail}`, 502);
  }
  const id = String(payload.id || '').trim();
  const status = String(payload.status || 'queued');
  if (!id) throw new WorkflowHttpError('Mollie gaf geen refund-id terug.', 502);
  return { id, status, payload };
}

function normalizeMollieRefundStatus(status: string): 'queued' | 'pending' | 'processing' | 'refunded' | 'failed' | 'canceled' {
  switch ((status || '').toLowerCase()) {
    case 'queued': return 'queued';
    case 'pending': return 'pending';
    case 'processing': return 'processing';
    case 'refunded': return 'refunded';
    case 'failed': return 'failed';
    case 'canceled':
    case 'cancelled': return 'canceled';
    default: return 'pending';
  }
}

// Maak (idempotent) de creditfactuur voor een terugbetaalde refund. Respecteert de
// create_credit_note-intentie uit de metadata en doet niets als er al een CN bestaat.
async function ensureCreditNoteForRefund(refund: RefundRow): Promise<Record<string, unknown> | null> {
  if (refund.credit_note_id) return await loadCreditNote(refund.organization_id, String(refund.credit_note_id));
  const wantsCreditNote = !(refund.metadata && (refund.metadata as Record<string, unknown>).create_credit_note === false);
  if (!wantsCreditNote) return null;
  if (refund.status !== 'refunded') return null;

  const invoice = await loadInvoice(refund.organization_id, refund.invoice_id);
  if (!invoice.client_id) { console.warn('Creditfactuur overgeslagen: factuur heeft geen klant.'); return null; }
  const totals = calculateTotals(invoice.lines);
  const [client, company] = await Promise.all([
    loadClient(refund.organization_id, invoice.client_id),
    loadCompanySettings(refund.organization_id),
  ]);
  return await issueCreditNoteForRefund({
    userId: refund.initiated_by, organizationId: refund.organization_id, invoice, client, company,
    refund: { id: refund.id }, amountCents: refund.amount_cents, invoiceTotalCents: totals.totalCents, totals, reason: refund.reason,
  });
}

async function issueCreditNote(input: { organizationId: string; invoiceId: string; refundId: string; userId: string | null; reason: string | null; currency: string; subtotal: number; vat: number; total: number; lines: InvoiceLine[] }): Promise<Record<string, unknown> & { id: string; number: string; date: string }> {
  const { data, error } = await supabaseAdmin.rpc('issue_credit_note', {
    p_organization_id: input.organizationId,
    p_invoice_id: input.invoiceId,
    p_refund_id: input.refundId,
    p_actor_user_id: input.userId,
    p_reason: input.reason,
    p_currency: input.currency,
    p_subtotal: input.subtotal,
    p_vat: input.vat,
    p_total: input.total,
    p_lines: input.lines,
  });
  if (error) throwRpcError('issue_credit_note', error);
  return data as Record<string, unknown> & { id: string; number: string; date: string };
}

async function loadCreditNote(organizationId: string, creditNoteId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from('credit_notes')
    .select('id,organization_id,invoice_id,refund_id,number,date,reason,currency,subtotal_amount,vat_amount,total_amount,status,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_data_base64,pdf_storage_provider,pdf_storage_key,created_at')
    .eq('id', creditNoteId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throwSupabaseError('creditnota laden', error);
  return (data ?? null) as Record<string, unknown> | null;
}

// Haal de creditfactuur-PDF als base64 op uit de DB of (bij R2-opslag) uit private storage.
async function loadCreditNotePdfBase64(creditNote: Record<string, unknown>): Promise<string> {
  let base64 = String(creditNote.pdf_data_base64 || '').trim();
  if (base64) return base64;

  if (creditNote.pdf_storage_provider === 'r2' && creditNote.pdf_storage_key) {
    if (!INVOICE_PDF_STORAGE_WORKER_URL || !INVOICE_PDF_STORAGE_SECRET) {
      throw new WorkflowHttpError('Creditfactuur-PDF staat in private storage, maar de storage-koppeling ontbreekt in de Edge Function secrets.', 500);
    }
    try {
      const response = await fetch(
        `${INVOICE_PDF_STORAGE_WORKER_URL}/internal/invoice-snapshot/${encodeURIComponent(String(creditNote.pdf_storage_key))}`,
        { headers: { Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}` } },
      );
      if (!response.ok) throw new WorkflowHttpError('Creditfactuur-PDF kon niet uit private storage worden opgehaald.', 502);
      base64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof WorkflowHttpError) throw error;
      throw new WorkflowHttpError('Creditfactuur-PDF kon niet uit private storage worden opgehaald.', 502);
    }
  }
  return base64;
}

async function downloadCreditNotePdf(organizationId: string, body: Record<string, unknown>): Promise<{ pdf: { fileName: string; mimeType: string; base64: string; sizeBytes: number | null; sha256: string | null } }> {
  const creditNoteId = String(body.creditNoteId || '');
  if (!isUuid(creditNoteId)) throw new WorkflowHttpError('Ongeldige creditfactuur.', 400);
  const creditNote = await loadCreditNote(organizationId, creditNoteId);
  if (!creditNote) throw new WorkflowHttpError('Creditfactuur niet gevonden.', 404);
  const base64 = await loadCreditNotePdfBase64(creditNote);
  if (!base64) throw new WorkflowHttpError('Voor deze creditfactuur is nog geen PDF beschikbaar.', 404);
  return {
    pdf: {
      fileName: String(creditNote.pdf_file_name || `creditfactuur-${creditNoteId}.pdf`),
      mimeType: String(creditNote.pdf_mime_type || 'application/pdf'),
      base64,
      sizeBytes: (creditNote.pdf_size_bytes as number | null) ?? null,
      sha256: (creditNote.pdf_sha256 as string | null) ?? null,
    },
  };
}

// Stuur de creditfactuur-PDF naar de klant via Resend. Gedeeld door de automatische
// verzending (bij aanmaken) en de handmatige 'Mail creditfactuur'-actie.
async function deliverCreditNoteEmail(input: { organizationId: string; userId: string | null; creditNote: Record<string, unknown>; invoice: InvoiceRow; client: ClientRow; company: CompanySettingsRow | null; recipientEmail: string; recipientName: string | null; pdfBase64?: string }): Promise<{ providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) throw new WorkflowHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  if (!RESEND_FROM_EMAIL) throw new WorkflowHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  const recipientEmail = String(input.recipientEmail || '').trim().toLowerCase();
  if (!isEmail(recipientEmail)) throw new WorkflowHttpError('Vul een geldig klant-e-mailadres in voor de creditfactuur.', 422);

  const base64 = input.pdfBase64 || await loadCreditNotePdfBase64(input.creditNote);
  if (!base64) throw new WorkflowHttpError('Voor deze creditfactuur is nog geen PDF beschikbaar om te mailen.', 404);

  const creditNoteNumber = String(input.creditNote.number || '');
  const fileName = String(input.creditNote.pdf_file_name || `creditfactuur-${creditNoteNumber}.pdf`);
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || null;
  const content = await loadEmailTemplateContent(input.organizationId, 'creditNote.sent');

  const rendered = renderEmailTemplate('creditNote.sent', {
    creditNote: {
      number: creditNoteNumber,
      date: String(input.creditNote.date || ''),
      total_amount: (input.creditNote.total_amount as number | string | null) ?? 0,
      currency: String(input.creditNote.currency || input.invoice.currency || 'EUR'),
      reason: (input.creditNote.reason as string | null) ?? null,
    },
    invoice: { number: input.invoice.number },
    client: { name: input.client.name, contact_name: input.client.contact_name, email: input.client.email },
    company: input.company,
    recipientName,
    content,
  });

  const senderIdentity = await resolveSenderIdentity(supabaseAdmin, input.organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  const resendPayload = {
    from: senderIdentity.from,
    to: [recipientEmail],
    reply_to: senderIdentity.replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    attachments: [{ filename: fileName, content: base64 }],
    tags: [
      { name: 'organization_id', value: sanitizeTagValue(input.organizationId) },
      { name: 'invoice_id', value: sanitizeTagValue(input.invoice.id) },
      { name: 'credit_note_number', value: sanitizeTagValue(creditNoteNumber) },
      { name: 'template_key', value: 'credit_note_sent' },
    ],
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': sanitizeIdempotencyKey(`credit-note-${String(input.creditNote.id)}-${recipientEmail}`) },
    body: JSON.stringify(resendPayload),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = String(payload.message || payload.error || response.statusText || 'Resend send failed');
    throw new WorkflowHttpError(`Resend kon de creditfactuur niet versturen: ${message}`, 502);
  }
  const providerEmailId = String(payload.id || payload.email_id || '').trim();

  // Event + audit (best-effort: een log-fout mag de geslaagde verzending niet ongedaan maken).
  await supabaseAdmin.rpc('insert_invoice_workflow_event', {
    p_organization_id: input.organizationId,
    p_invoice_id: input.invoice.id,
    p_event_type: 'credit_note_emailed',
    p_title: 'Creditfactuur gemaild',
    p_description: `Creditfactuur ${creditNoteNumber} verstuurd naar ${recipientEmail}.`,
    p_metadata: { credit_note_id: input.creditNote.id, recipient_email: recipientEmail, provider_email_id: providerEmailId },
    p_actor_user_id: input.userId,
  }).catch((eventError) => console.warn('credit_note_emailed event insert mislukte', eventError instanceof Error ? eventError.message : eventError));

  await supabaseAdmin.from('audit_logs').insert({
    organization_id: input.organizationId,
    actor_user_id: input.userId,
    action: 'credit_note_emailed',
    entity_type: 'credit_note',
    entity_id: String(input.creditNote.id),
    entity_label: creditNoteNumber,
    metadata: { invoice_id: input.invoice.id, recipient_email: recipientEmail, provider_email_id: providerEmailId },
  }).then(({ error }) => { if (error) console.warn('credit_note_emailed audit insert mislukte', error.message); });

  return { providerEmailId, recipientEmail };
}

// Handmatige 'Mail creditfactuur'-actie (owner/admin/member via de write-gate).
async function sendCreditNoteEmail(userId: string, organizationId: string, body: Record<string, unknown>) {
  const creditNoteId = String(body.creditNoteId || '');
  if (!isUuid(creditNoteId)) throw new WorkflowHttpError('Ongeldige creditfactuur.', 400);
  const creditNote = await loadCreditNote(organizationId, creditNoteId);
  if (!creditNote) throw new WorkflowHttpError('Creditfactuur niet gevonden.', 404);
  const invoice = await loadInvoice(organizationId, String(creditNote.invoice_id));
  if (!invoice.client_id) throw new WorkflowHttpError('Deze factuur heeft geen klant gekoppeld.', 422);
  const [client, company] = await Promise.all([loadClient(organizationId, invoice.client_id), loadCompanySettings(organizationId)]);
  const recipientEmail = String(body.recipientEmail || client.email || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || '').trim() || null;
  const result = await deliverCreditNoteEmail({ organizationId, userId, creditNote, invoice, client, company, recipientEmail, recipientName });
  return { sent: true, ...result };
}

// Slaat de creditfactuur-PDF op in private R2 (zelfde worker-route als facturen). De
// key voldoet aan de worker-keyvalidatie {org}/invoice-pdfs/{uuid}/{uuid}-{naam}.pdf:
// de factuur-id als midden-UUID, de creditnota-id als bestandsprefix. Een R2-fout is
// niet fataal: dan vallen we terug op database-opslag (base64), zodat de creditfactuur
// altijd beschikbaar blijft.
async function storeCreditNotePdfSnapshot(organizationId: string, invoiceId: string, creditNoteId: string, attachment: InvoicePdfAttachment): Promise<StoredInvoicePdfSnapshot> {
  const storageConfigured = Boolean(INVOICE_PDF_STORAGE_WORKER_URL && INVOICE_PDF_STORAGE_SECRET);
  if (!storageConfigured) return { provider: 'database', key: null, shouldStoreBase64InDatabase: true };

  const safeName = `${sanitizeFileName(attachment.fileName.replace(/\.pdf$/i, ''))}.pdf`;
  const key = `${organizationId}/invoice-pdfs/${invoiceId}/${creditNoteId}-${safeName}`;
  try {
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
      console.warn('Creditfactuur R2-upload mislukte; val terug op database-opslag.', { status: response.status, message, key });
      return { provider: 'database', key: null, shouldStoreBase64InDatabase: true };
    }
    return { provider: 'r2', key, shouldStoreBase64InDatabase: false };
  } catch (error) {
    console.warn('Creditfactuur R2-upload gooide een fout; val terug op database-opslag.', error instanceof Error ? error.message : error);
    return { provider: 'database', key: null, shouldStoreBase64InDatabase: true };
  }
}

async function handleMollieWebhook(req: Request, url: URL, body: Record<string, string>) {
  if (!INVOICE_ALLOW_MOCK) {
    if (MOLLIE_WEBHOOK_SECRET && !timingSafeEqual(url.searchParams.get('secret') || '', MOLLIE_WEBHOOK_SECRET)) return json(req, { ok: false, error: 'Invalid webhook secret' }, 403);
    if (!MOLLIE_WEBHOOK_SECRET) return json(req, { ok: false, error: 'Webhook secret ontbreekt.' }, 500);
  }
  const eventId = String(body.id || body.payment_id || '').trim();
  if (!eventId) return json(req, { ok: false, error: 'Payment id ontbreekt.' }, 400);

  // Mock-betaling: direct als betaald markeren (mock-refunds zijn al synchroon afgehandeld).
  if (INVOICE_ALLOW_MOCK && eventId.startsWith('mock_invoice_payment_')) {
    const { error } = await supabaseAdmin.rpc('update_invoice_payment_status', { p_provider_payment_id: eventId, p_status: 'paid', p_paid_at: new Date().toISOString(), p_metadata: { mock: true, webhook: body } });
    if (error) return json(req, { ok: false, error: error.message }, 500);
    return json(req, { ok: true });
  }

  // Mollie pingt de payment-webhook met de payment-id (tr_) — óók bij refund- en
  // chargeback-statuswijzigingen. Voor de zekerheid vangen we ook een refund-id (re_) op.
  let record = await findInvoicePaymentRecordByProviderId(eventId);
  let molliePaymentId = eventId;
  if (!record && eventId.startsWith('re_')) {
    const viaRefund = await findPaymentRecordByRefundId(eventId);
    if (viaRefund?.provider_payment_id) {
      record = { id: viaRefund.id, organization_id: viaRefund.organization_id, invoice_id: viaRefund.invoice_id };
      molliePaymentId = viaRefund.provider_payment_id;
    }
  }
  if (!record) { console.warn('invoice-workflow webhook: unknown Mollie id'); return json(req, { ok: true, ignored: true }); }

  const orgKey = await resolveOrganizationMollieKey(record.organization_id);
  if (!orgKey) { console.warn('invoice-workflow webhook: no Mollie key for organization; cannot verify payment'); return json(req, { ok: true, unverifiable: true }); }

  // embed=refunds,chargebacks: in één call de betaalstatus + alle refunds + chargebacks.
  const response = await fetch(`https://api.mollie.com/v2/payments/${encodeURIComponent(molliePaymentId)}?embed=refunds,chargebacks`, { headers: { Authorization: `Bearer ${orgKey.apiKey}` } });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return json(req, { ok: false, error: 'Mollie payment ophalen mislukt.' }, 502);

  const status = normalizeMollieStatus(String(payload.status || 'open'));
  const paidAt = typeof payload.paidAt === 'string' ? payload.paidAt : null;
  const { error } = await supabaseAdmin.rpc('update_invoice_payment_status', { p_provider_payment_id: molliePaymentId, p_status: status, p_paid_at: paidAt, p_metadata: { mollie: payload } });
  if (error) return json(req, { ok: false, error: error.message }, 500);

  // Refunds + chargebacks reconciliëren (Fase 2/3). Fouten hier mogen de webhook niet
  // 500'en — Mollie zou dan blijven retryen; alle vervolgstappen zijn idempotent.
  const paymentContext: PaymentContext = { invoiceId: record.invoice_id, paymentRecordId: record.id };
  await reconcilePaymentRefunds(record.organization_id, payload, paymentContext)
    .catch((reconcileError) => console.warn('refund-reconciliatie mislukte', reconcileError instanceof Error ? reconcileError.message : reconcileError));
  await reconcilePaymentChargebacks(record.organization_id, payload, paymentContext)
    .catch((reconcileError) => console.warn('chargeback-reconciliatie mislukte', reconcileError instanceof Error ? reconcileError.message : reconcileError));

  return json(req, { ok: true });
}

type PaymentContext = { invoiceId: string; paymentRecordId: string };

// Reken een Mollie-bedrag ({ currency, value: "10.00" }) om naar hele centen.
function mollieAmountToCents(amount: unknown): number {
  const value = (amount && typeof amount === 'object') ? (amount as Record<string, unknown>).value : amount;
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function mollieAmountCurrency(amount: unknown, fallback = 'EUR'): string {
  const currency = (amount && typeof amount === 'object') ? (amount as Record<string, unknown>).currency : null;
  return String(currency || fallback) || fallback;
}

// Werk de refund-ledger bij op basis van de in de payment ge-embedde refunds.
async function reconcilePaymentRefunds(organizationId: string, paymentPayload: Record<string, unknown>, context: PaymentContext): Promise<void> {
  const embedded = paymentPayload._embedded as Record<string, unknown> | undefined;
  const refunds = Array.isArray(embedded?.refunds) ? (embedded!.refunds as Array<Record<string, unknown>>) : [];
  for (const mollieRefund of refunds) {
    const providerRefundId = String(mollieRefund.id || '').trim();
    if (!providerRefundId) continue;
    const status = normalizeMollieRefundStatus(String(mollieRefund.status || ''));
    try {
      await reconcileOneRefund(organizationId, providerRefundId, status, mollieRefund, context);
    } catch (refundError) {
      console.warn(`refund ${providerRefundId} reconciliatie mislukte`, refundError instanceof Error ? refundError.message : refundError);
    }
  }
}

async function reconcileOneRefund(organizationId: string, providerRefundId: string, status: 'queued' | 'pending' | 'processing' | 'refunded' | 'failed' | 'canceled', mollieRefund: Record<string, unknown>, context: PaymentContext): Promise<void> {
  let refund = await findRefundByProviderId(organizationId, providerRefundId);

  // Externe refund (bijv. via het Mollie-dashboard): in de administratie opnemen (Fase 3).
  if (!refund) {
    const amountCents = mollieAmountToCents(mollieRefund.amount);
    if (amountCents <= 0) return;
    refund = await ingestExternalRefund(
      organizationId, context.invoiceId, context.paymentRecordId, providerRefundId,
      amountCents, status, mollieAmountCurrency(mollieRefund.amount), String(mollieRefund.description || '') || null, { mollie_refund: mollieRefund },
    );
  }

  if (refund.status === status) {
    // Status ongewijzigd; vang alleen het geval op dat 'refunded' is maar de
    // creditfactuur eerder niet kon worden aangemaakt.
    if (status === 'refunded' && !refund.credit_note_id) await ensureCreditNoteForRefund(refund);
    return;
  }

  if (status === 'refunded') {
    const updated = await completeInvoiceRefund(refund.id, organizationId, providerRefundId, 'refunded', { mollie_refund: mollieRefund });
    await ensureCreditNoteForRefund(updated);
  } else if (status === 'failed' || status === 'canceled') {
    await failInvoiceRefund(refund.id, organizationId, `Mollie meldde status '${status}'.`, status, { mollie_refund: mollieRefund });
  } else {
    // In-flight (queued/pending/processing): status verversen, geen creditfactuur.
    await completeInvoiceRefund(refund.id, organizationId, providerRefundId, status, { mollie_refund: mollieRefund });
  }
}

async function findRefundByProviderId(organizationId: string, providerRefundId: string): Promise<RefundRow | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_refunds')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider_refund_id', providerRefundId)
    .maybeSingle();
  if (error) { console.warn('refund lookup mislukte', error.message); return null; }
  return (data ?? null) as RefundRow | null;
}

// Neem een in Mollie aangemaakte refund op in de ledger (idempotent op provider_refund_id).
async function ingestExternalRefund(organizationId: string, invoiceId: string, paymentRecordId: string, providerRefundId: string, amountCents: number, status: string, currency: string, reason: string | null, metadata: Record<string, unknown>): Promise<RefundRow> {
  const { data, error } = await supabaseAdmin.rpc('ingest_external_refund', {
    p_organization_id: organizationId,
    p_invoice_id: invoiceId,
    p_payment_record_id: paymentRecordId,
    p_provider_refund_id: providerRefundId,
    p_amount_cents: amountCents,
    p_status: status,
    p_currency: currency,
    p_reason: reason,
    p_metadata: metadata,
  });
  if (error) throwRpcError('ingest_external_refund', error);
  return data as RefundRow;
}

// Werk de chargeback-ledger bij op basis van de in de payment ge-embedde chargebacks.
async function reconcilePaymentChargebacks(organizationId: string, paymentPayload: Record<string, unknown>, context: PaymentContext): Promise<void> {
  const embedded = paymentPayload._embedded as Record<string, unknown> | undefined;
  const chargebacks = Array.isArray(embedded?.chargebacks) ? (embedded!.chargebacks as Array<Record<string, unknown>>) : [];
  for (const mollieChargeback of chargebacks) {
    const providerChargebackId = String(mollieChargeback.id || '').trim();
    if (!providerChargebackId) continue;
    try {
      await reconcileOneChargeback(organizationId, providerChargebackId, mollieChargeback, context);
    } catch (chargebackError) {
      console.warn(`chargeback ${providerChargebackId} reconciliatie mislukte`, chargebackError instanceof Error ? chargebackError.message : chargebackError);
    }
  }
}

async function reconcileOneChargeback(organizationId: string, providerChargebackId: string, mollieChargeback: Record<string, unknown>, context: PaymentContext): Promise<void> {
  const amountCents = mollieAmountToCents(mollieChargeback.amount);
  if (amountCents <= 0) return;
  const settlementCents = mollieChargeback.settlementAmount ? mollieAmountToCents(mollieChargeback.settlementAmount) : null;
  const reversed = Boolean(mollieChargeback.reversedAt);
  const reasonObj = mollieChargeback.reason as Record<string, unknown> | string | undefined;
  const reason = typeof reasonObj === 'object' && reasonObj ? String(reasonObj.description || '') : String(reasonObj || '');
  const { error } = await supabaseAdmin.rpc('record_invoice_chargeback', {
    p_organization_id: organizationId,
    p_invoice_id: context.invoiceId,
    p_payment_record_id: context.paymentRecordId,
    p_provider_chargeback_id: providerChargebackId,
    p_amount_cents: amountCents,
    p_currency: mollieAmountCurrency(mollieChargeback.amount),
    p_reason: reason || null,
    p_reversed: reversed,
    p_settlement_amount_cents: settlementCents,
    p_metadata: { mollie_chargeback: mollieChargeback },
  });
  if (error) throwRpcError('record_invoice_chargeback', error);
}

// Fallback voor een webhook met een refund-id (re_): zoek het bijbehorende payment-record.
async function findPaymentRecordByRefundId(providerRefundId: string): Promise<{ id: string; organization_id: string; invoice_id: string; provider_payment_id: string | null } | null> {
  const { data: refund } = await supabaseAdmin
    .from('invoice_refunds')
    .select('id,organization_id,payment_record_id')
    .eq('provider_refund_id', providerRefundId)
    .maybeSingle();
  const paymentRecordId = (refund as { payment_record_id?: string | null } | null)?.payment_record_id;
  if (!paymentRecordId) return null;
  const { data: payment } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,organization_id,invoice_id,provider_payment_id')
    .eq('id', paymentRecordId)
    .maybeSingle();
  return (payment ?? null) as { id: string; organization_id: string; invoice_id: string; provider_payment_id: string | null } | null;
}

async function markMockInvoicePaymentPaid(providerPaymentId: string) {
  if (!INVOICE_ALLOW_MOCK) throw new WorkflowHttpError('Mock payments zijn uitgeschakeld.', 403);
  const { data, error } = await supabaseAdmin.rpc('update_invoice_payment_status', { p_provider_payment_id: providerPaymentId, p_status: 'paid', p_paid_at: new Date().toISOString(), p_metadata: { mock: true, manual: true } });
  if (error) throwRpcError('update_invoice_payment_status', error);
  return data;
}

type InvoiceMollieStatusPayload = {
  status: 'not_connected' | 'connected' | 'revoked';
  mode: 'test' | 'live' | null;
  key_suffix: string | null;
  connected_at: string | null;
  last_validated_at: string | null;
};

async function getInvoiceMollieStatus(organizationId: string): Promise<InvoiceMollieStatusPayload> {
  const { data, error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .select('status,mode,key_suffix,connected_at,last_validated_at')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throwSupabaseError('invoice Mollie status lookup', error);
  const row = (data ?? null) as Partial<InvoiceMollieStatusPayload> | null;
  return {
    status: row?.status ?? 'not_connected',
    mode: row?.mode ?? null,
    key_suffix: row?.key_suffix ?? null,
    connected_at: row?.connected_at ?? null,
    last_validated_at: row?.last_validated_at ?? null,
  };
}

async function saveInvoiceMollieKey(userId: string, organizationId: string, role: OrganizationRole, body: Record<string, unknown>): Promise<InvoiceMollieStatusPayload> {
  if (!['owner', 'admin'].includes(role)) throw new WorkflowHttpError('Alleen owners en admins mogen de Mollie-koppeling beheren.', 403);
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) throw new WorkflowHttpError('Vul een Mollie API-key in.', 422);

  const validation = await validateMollieApiKey(apiKey);
  if (!validation.valid || !validation.mode) throw new WorkflowHttpError(validation.error || 'Mollie API-key is ongeldig.', 422);

  const encrypted = await encryptSecret(apiKey);
  const suffix = mollieKeySuffix(apiKey);
  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .upsert({
      organization_id: organizationId,
      status: 'connected',
      mode: validation.mode,
      api_key_encrypted: encrypted,
      key_suffix: suffix,
      connected_by: userId,
      connected_at: nowIso,
      revoked_at: null,
      last_validated_at: nowIso,
      last_error: null,
    }, { onConflict: 'organization_id' });
  if (error) throwSupabaseError('invoice Mollie key opslaan', error);

  return { status: 'connected', mode: validation.mode, key_suffix: suffix, connected_at: nowIso, last_validated_at: nowIso };
}

async function deleteInvoiceMollieKey(organizationId: string, role: OrganizationRole): Promise<{ status: InvoiceMollieStatusPayload; hadOpenPayments: boolean }> {
  if (!['owner', 'admin'].includes(role)) throw new WorkflowHttpError('Alleen owners en admins mogen de Mollie-koppeling beheren.', 403);

  // Open payment links still need the key for webhook verification. We surface
  // this so the UI can warn, but still revoke — the admin explicitly asked to.
  const { data: openRows } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id')
    .eq('organization_id', organizationId)
    .in('status', ['creating', 'open', 'pending', 'authorized'])
    .limit(1);
  const hadOpenPayments = Array.isArray(openRows) && openRows.length > 0;

  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .update({ status: 'revoked', api_key_encrypted: null, key_suffix: null, mode: null, revoked_at: nowIso, last_error: null })
    .eq('organization_id', organizationId);
  if (error) throwSupabaseError('invoice Mollie key verwijderen', error);

  return {
    status: { status: 'revoked', mode: null, key_suffix: null, connected_at: null, last_validated_at: null },
    hadOpenPayments,
  };
}

// Resolve the organization's OWN decrypted Mollie key for creating/verifying
// invoice payments. Returns null when Mollie is not connected — callers must
// treat that as "no payment link" and never fall back to a shared key.
async function resolveOrganizationMollieKey(organizationId: string): Promise<{ apiKey: string; mode: 'test' | 'live' | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .select('status,api_key_encrypted,mode')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { status?: string; api_key_encrypted?: string | null; mode?: 'test' | 'live' | null };
  if (row.status !== 'connected' || !row.api_key_encrypted) return null;
  try {
    const apiKey = await decryptSecret(row.api_key_encrypted);
    if (!apiKey) return null;
    return { apiKey, mode: row.mode ?? null };
  } catch (decryptError) {
    console.error('invoice-workflow could not decrypt organization Mollie key', describeError(decryptError));
    return null;
  }
}

async function findInvoicePaymentRecordByProviderId(providerPaymentId: string): Promise<{ id: string; organization_id: string; invoice_id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,organization_id,invoice_id')
    .eq('provider', 'mollie')
    .eq('provider_payment_id', providerPaymentId)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as { id: string; organization_id: string; invoice_id: string } | null;
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

// Per-organisatie aanpasbare e-mailtekst (onderwerp/aanhef/afsluiting/knoptekst).
// Geeft null terug als er geen aangepaste regel is — de template valt dan terug op
// de ingebouwde standaardtekst. Een lookup-fout is bewust niet fataal: de mail moet
// altijd verstuurd kunnen worden, desnoods met de standaardtekst.
async function loadEmailTemplateContent(organizationId: string, templateKey: EmailTemplateContentKey): Promise<EmailTemplateContent | null> {
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .eq('template_key', templateKey)
    .maybeSingle();
  if (error) { console.warn('email_templates lookup mislukte', error.message); return null; }
  if (!data) return null;
  const row = data as { enabled: boolean; subject: string | null; intro: string | null; closing: string | null; cta_label: string | null };
  return { enabled: row.enabled, subject: row.subject, intro: row.intro, closing: row.closing, ctaLabel: row.cta_label };
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

  // Preserve the .pdf extension: sanitizeFileName() strips dots, which would
  // turn "...-INV-2026-001.pdf" into "...-INV-2026-001-pdf" and fail the
  // Worker's isPrivateInvoiceSnapshotKey() check (it requires a trailing .pdf).
  const safeName = `${sanitizeFileName(attachment.fileName.replace(/\.pdf$/i, ''))}.pdf`;
  const key = `${organizationId}/invoice-pdfs/${invoiceId}/${crypto.randomUUID()}-${safeName}`;
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
    console.error('invoice-workflow R2 snapshot upload failed', {
      status: response.status,
      message,
      key,
      organizationId,
      invoiceId,
    });
    throw new WorkflowHttpError(`Factuur-PDF kon niet in private R2 storage worden opgeslagen: ${message || response.statusText}`, 502);
  }

  return { provider: 'r2', key, shouldStoreBase64InDatabase: false };
}

async function loadInvoicePdfSnapshot(organizationId: string, invoiceId: string): Promise<{ fileName: string; mimeType: string; base64: string; sizeBytes: number | null; sha256: string | null }> {
  const { data: versions, error } = await supabaseAdmin
    .from('invoice_versions')
    .select('snapshot_reason,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_data_base64,pdf_storage_provider,pdf_storage_key,created_at,version_number')
    .eq('organization_id', organizationId)
    .eq('invoice_id', invoiceId)
    .not('pdf_file_name', 'is', null)
    .order('version_number', { ascending: false })
    .limit(20);

  if (error) throw error;

  const usableVersions = (versions || []).filter((candidate: Record<string, unknown>) => {
    const hasDatabasePdf = Boolean(String(candidate.pdf_data_base64 || '').trim());
    const hasPrivateStoragePdf = candidate.pdf_storage_provider === 'r2' && Boolean(candidate.pdf_storage_key);
    return hasDatabasePdf || hasPrivateStoragePdf;
  });

  // Prefer the version that was actually sent to the client; fall back to the
  // most recent usable snapshot.
  const version =
    usableVersions.find((candidate: Record<string, unknown>) => candidate.snapshot_reason === 'sent_to_client') ||
    usableVersions[0];

  if (!version) {
    throw new WorkflowHttpError('Er is nog geen opgeslagen PDF-snapshot voor deze factuur. Verstuur de factuur eerst naar de klant.', 404);
  }

  let base64 = String(version.pdf_data_base64 || '').trim();

  if (!base64 && version.pdf_storage_provider === 'r2' && version.pdf_storage_key) {
    if (!INVOICE_PDF_STORAGE_WORKER_URL || !INVOICE_PDF_STORAGE_SECRET) {
      throw new WorkflowHttpError('PDF-snapshot staat in private storage, maar de storage-koppeling ontbreekt in de Edge Function secrets.', 500);
    }

    const response = await fetch(
      `${INVOICE_PDF_STORAGE_WORKER_URL}/internal/invoice-snapshot/${encodeURIComponent(String(version.pdf_storage_key))}`,
      { headers: { Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}` } },
    );

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      console.error('invoice-workflow R2 snapshot fetch failed', { status: response.status, message, key: version.pdf_storage_key, organizationId, invoiceId });
      throw new WorkflowHttpError('PDF-snapshot kon niet uit private storage worden opgehaald.', 502);
    }

    base64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  if (!base64) {
    throw new WorkflowHttpError('PDF-snapshot ontbreekt of is niet beschikbaar.', 404);
  }

  return {
    fileName: String(version.pdf_file_name || `factuur-${invoiceId}.pdf`),
    mimeType: String(version.pdf_mime_type || 'application/pdf'),
    sizeBytes: (version.pdf_size_bytes as number | null) ?? null,
    sha256: (version.pdf_sha256 as string | null) ?? null,
    base64,
  };
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

async function createCreditNotePdfAttachment(input: { creditNoteNumber: string; date: string; invoice: InvoiceRow; client: ClientRow; company: CompanySettingsRow | null; currency: string; subtotal: number; vat: number; total: number; lines: InvoiceLine[]; reason: string | null }): Promise<InvoicePdfAttachment> {
  const { creditNoteNumber, date, invoice, client, company, subtotal, vat, total, lines, reason } = input;
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToPdfRgb(company?.invoice_accent_color || '#FFD966');
  const muted = rgb(0.38, 0.38, 0.38);
  let page = pdfDoc.addPage([595.28, 841.89]);
  let y = 780;
  const companyName = company?.trade_name || company?.company_name || 'ResoFly';

  page.drawRectangle({ x: 0, y: 824, width: 595.28, height: 18, color: accent, opacity: 0.85 });
  drawPdfText(page, 'CREDITFACTUUR', 48, y, bold, 24);
  drawPdfText(page, creditNoteNumber || '-', 547, y + 6, bold, 12, { align: 'right' });
  y -= 28;
  drawPdfText(page, companyName, 48, y, bold, 13); y -= 18;
  for (const line of companyAddressLines(company).slice(0, 8)) { drawPdfText(page, line, 48, y, regular, 9, { color: muted }); y -= 12; }
  let rightY = 742;
  drawPdfText(page, `Datum: ${formatDateNl(date)}`, 547, rightY, regular, 9, { align: 'right', color: muted }); rightY -= 14;
  drawPdfText(page, `Creditering van factuur: ${invoice.number}`, 547, rightY, regular, 9, { align: 'right', color: muted }); rightY -= 14;
  if (invoice.date) drawPdfText(page, `Factuurdatum: ${formatDateNl(invoice.date)}`, 547, rightY, regular, 9, { align: 'right', color: muted });

  y = 620;
  drawSectionTitle(page, 'Klant', 48, y, bold, accent, muted); y -= 24;
  for (const line of clientAddressLines(client)) { drawPdfText(page, line, 48, y, line === client.name ? bold : regular, 10); y -= 14; }

  y = 510;
  drawTableHeader(page, y, bold, accent, muted); y -= 28;
  for (const line of (Array.isArray(lines) ? lines : [])) {
    if (y < 180) { drawPdfFooter(page, regular, company); page = pdfDoc.addPage([595.28, 841.89]); y = 780; drawTableHeader(page, y, bold, accent, muted); y -= 28; }
    y -= drawLine(page, line, y, regular, bold, muted);
  }
  if (y < 230) { drawPdfFooter(page, regular, company); page = pdfDoc.addPage([595.28, 841.89]); y = 760; }
  // Bedragen komen uit de opgeslagen creditnota (autoritatief), niet uit een
  // herberekening van de regels — zo matcht de PDF exact het geboekte bedrag.
  y -= 10;
  drawPdfText(page, 'Subtotaal', 365, y, regular, 10); drawPdfText(page, `- ${formatEuro(subtotal)}`, 547, y, regular, 10, { align: 'right' }); y -= 18;
  drawPdfText(page, 'BTW', 365, y, regular, 10); drawPdfText(page, `- ${formatEuro(vat)}`, 547, y, regular, 10, { align: 'right' }); y -= 22;
  page.drawLine({ start: { x: 365, y: y + 12 }, end: { x: 547, y: y + 12 }, thickness: 0.8, color: accent });
  drawPdfText(page, 'Totaal credit', 365, y, bold, 13); drawPdfText(page, `- ${formatEuro(total)}`, 547, y, bold, 13, { align: 'right' });
  y -= 28;
  drawPdfText(page, 'Dit bedrag wordt aan u terugbetaald.', 365, y, regular, 9, { color: muted });
  if (reason) { y -= 40; drawSectionTitle(page, 'Reden', 48, y, bold, accent, muted); y -= 24; y = drawWrappedPdfText(page, reason, 48, y, 310, regular, 9, 12, muted); }
  drawPdfFooter(page, regular, company);

  const bytes = await pdfDoc.save();
  const sha256 = await sha256HexBytes(bytes);
  const fileName = `creditfactuur-${sanitizeFileName(creditNoteNumber || invoice.id)}.pdf`;
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
