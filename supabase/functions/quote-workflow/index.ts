import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'https://esm.sh/pdf-lib@1.17.1';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type QuoteLine = { id?: string; description: string; quantity: number; unit_price: number; vat?: number };
type QuoteRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  project_id: string | null;
  number: string;
  date: string;
  valid_until: string | null;
  lines: QuoteLine[];
  status: string;
  notes: string | null;
  internal_approval_status?: string;
  public_token_hash?: string | null;
  public_token_expires_at?: string | null;
};
type ClientRow = { id: string; name: string; contact_name: string | null; email: string | null };
type ProjectRow = { id: string; name: string; description: string | null };
type CompanySettingsRow = {
  company_name: string;
  trade_name: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  iban?: string | null;
  invoice_payment_terms?: string | null;
  invoice_footer?: string | null;
  invoice_accent_color?: string | null;
};
type QuotePdfAttachment = { fileName: string; mimeType: 'application/pdf'; bytes: Uint8Array; base64: string; sizeBytes: number; sha256: string };

type WorkflowHttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const QUOTE_PUBLIC_BASE_URL = Deno.env.get('QUOTE_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '';
const QUOTE_TOKEN_TTL_DAYS = parsePositiveInt(Deno.env.get('QUOTE_TOKEN_TTL_DAYS'), 30);
const QUOTE_PDF_MAX_ATTACHMENT_BYTES = parsePositiveInt(Deno.env.get('QUOTE_PDF_MAX_ATTACHMENT_BYTES'), 8 * 1024 * 1024);
const QUOTE_ALLOWED_ORIGINS = (Deno.env.get('QUOTE_ALLOWED_ORIGINS') || Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const QUOTE_ALLOW_LOCAL_DEV = (Deno.env.get('QUOTE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class WorkflowHttpError extends Error {
  status: WorkflowHttpErrorStatus;
  constructor(message: string, status: WorkflowHttpErrorStatus = 400) {
    super(message);
    this.name = 'WorkflowHttpError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const quoteId = String(body.quoteId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    switch (action) {
      case 'sendQuoteEmail': {
        if (!['owner', 'admin', 'member'].includes(role)) throw new WorkflowHttpError('Geen schrijfrechten voor deze organisatie.', 403);
        return json(req, { ok: true, ...(await sendQuoteEmail(user.id, organizationId, quoteId, body)) });
      }
      default:
        return json(req, { ok: false, error: `Onbekende quote workflow action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof WorkflowHttpError ? error.status : 500;
    const internalMessage = error instanceof Error ? error.message : 'Onbekende fout.';
    if (status >= 500) console.error('quote-workflow error', internalMessage);
    const publicMessage = error instanceof WorkflowHttpError
      ? error.message
      : 'Quote workflow-actie mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendQuoteEmail(userId: string, organizationId: string, quoteId: string, body: Record<string, unknown>) {
  if (!RESEND_API_KEY) throw new WorkflowHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  if (!RESEND_FROM_EMAIL) throw new WorkflowHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  if (!QUOTE_PUBLIC_BASE_URL) throw new WorkflowHttpError('QUOTE_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.', 500);
  if (!isUuid(quoteId)) throw new WorkflowHttpError('Ongeldige offerte.', 400);

  const quote = await loadQuote(organizationId, quoteId);
  if (quote.status !== 'internally_approved' || quote.internal_approval_status !== 'approved') {
    throw new WorkflowHttpError('Alleen intern goedgekeurde offertes kunnen naar de klant worden verstuurd.', 409);
  }
  if (!quote.client_id) throw new WorkflowHttpError('Deze offerte heeft geen klant gekoppeld.', 422);
  if (isDateBeforeToday(quote.valid_until)) {
    throw new WorkflowHttpError('Deze offerte is verlopen. Pas de geldigheidsdatum aan en doorloop de goedkeuringsflow opnieuw voordat je verstuurt.', 409);
  }

  const [client, project, company] = await Promise.all([
    loadClient(organizationId, quote.client_id),
    quote.project_id ? loadProject(organizationId, quote.project_id) : Promise.resolve(null),
    loadCompanySettings(organizationId),
  ]);

  const recipientEmail = String(body.recipientEmail || client.email || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || client.contact_name || client.name || '').trim();
  if (!isEmail(recipientEmail)) throw new WorkflowHttpError('Vul een geldig klant-e-mailadres in voordat je de offerte verstuurt.', 422);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + Math.max(1, QUOTE_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const publicUrl = `${QUOTE_PUBLIC_BASE_URL.replace(/\/$/, '')}/quote/${encodeURIComponent(token)}`;
  const subject = String(body.subject || `Offerte ${quote.number} van ${company?.trade_name || company?.company_name || 'BrandCore'}`).trim();
  const html = buildQuoteEmailHtml({ quote, client, project, company, publicUrl, recipientName, expiresAt });
  const text = buildQuoteEmailText({ quote, client, project, company, publicUrl, recipientName, expiresAt });
  const pdfAttachment = await createQuotePdfAttachment({ quote, client, project, company, publicUrl });
  validateQuotePdfAttachment(pdfAttachment);

  const prepared = await beginQuoteEmailSend({
    quoteId,
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
  });

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `quote-${quoteId}-${prepared.deliveryId}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [recipientEmail],
      reply_to: RESEND_REPLY_TO || undefined,
      subject,
      html,
      text,
      attachments: [
        { filename: pdfAttachment.fileName, content: pdfAttachment.base64, contentType: pdfAttachment.mimeType },
      ],
      tags: [
        { name: 'organization_id', value: organizationId },
        { name: 'quote_id', value: quoteId },
        { name: 'quote_number', value: sanitizeTagValue(quote.number) },
      ],
    }),
  });

  const resendPayload = await resendResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!resendResponse.ok) {
    const errorMessage = String(resendPayload.message || resendPayload.error || resendResponse.statusText || 'Resend send failed');
    console.error('Resend send failed', resendPayload);
    await failQuoteEmailSend(prepared.deliveryId, organizationId, userId, errorMessage);
    throw new WorkflowHttpError('Resend kon de offerte-e-mail niet versturen.', 502);
  }

  const providerEmailId = String(resendPayload.id || resendPayload.email_id || '').trim();
  if (!providerEmailId) {
    await failQuoteEmailSend(prepared.deliveryId, organizationId, userId, 'Resend accepted the request but did not return a provider email id.');
    throw new WorkflowHttpError('Resend heeft de e-mail aangenomen, maar gaf geen e-mail-ID terug. De verzending is niet als definitief verzonden gemarkeerd.', 502);
  }
  const finalized = await completeQuoteEmailSend(prepared.deliveryId, organizationId, userId, providerEmailId);

  return { delivery: finalized.delivery, version: finalized.version, publicUrl, providerEmailId, attachment: { fileName: pdfAttachment.fileName, sizeBytes: pdfAttachment.sizeBytes, sha256: pdfAttachment.sha256 } };
}

async function loadQuote(organizationId: string, quoteId: string): Promise<QuoteRow> {
  const { data, error } = await supabaseAdmin
    .from('quotes')
    .select('*')
    .eq('id', quoteId)
    .eq('organization_id', organizationId)
    .single();
  if (error || !data) throw new WorkflowHttpError('Offerte niet gevonden.', 404);
  return data as QuoteRow;
}

async function loadClient(organizationId: string, clientId: string): Promise<ClientRow> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email')
    .eq('id', clientId)
    .eq('organization_id', organizationId)
    .single();
  if (error || !data) throw new WorkflowHttpError('Klant niet gevonden.', 404);
  return data as ClientRow;
}

async function loadProject(organizationId: string, projectId: string): Promise<ProjectRow | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id,name,description')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as ProjectRow | null;
}

async function loadCompanySettings(organizationId: string): Promise<CompanySettingsRow | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name,address_line1,address_line2,postal_code,city,country,email,phone,website,kvk_number,vat_number,iban,invoice_payment_terms,invoice_footer,invoice_accent_color')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as CompanySettingsRow | null;
}

async function insertQuoteWorkflowEvent(organizationId: string, quoteId: string, actorUserId: string | null, eventType: string, title: string, description?: string, metadata: Record<string, unknown> = {}) {
  const { error } = await supabaseAdmin.rpc('insert_quote_workflow_event', {
    p_organization_id: organizationId,
    p_quote_id: quoteId,
    p_event_type: eventType,
    p_title: title,
    p_description: description ?? null,
    p_metadata: metadata,
    p_actor_user_id: actorUserId,
  });
  if (error) console.warn('Quote workflow event insert failed', error.message);
}

async function insertQuoteAuditEvent(organizationId: string, quoteId: string, actorUserId: string | null, action: string, label: string, metadata: Record<string, unknown> = {}) {
  const { error } = await supabaseAdmin.rpc('insert_quote_audit_event', {
    p_organization_id: organizationId,
    p_quote_id: quoteId,
    p_action: action,
    p_entity_label: label,
    p_metadata: metadata,
    p_actor_user_id: actorUserId,
  });
  if (error) console.warn('Quote audit event insert failed', error.message);
}

type PreparedQuoteEmailSend = { deliveryId: string; quoteId?: string };
type CompletedQuoteEmailSend = { delivery?: unknown; quote?: unknown; version?: unknown };

async function beginQuoteEmailSend(input: {
  quoteId: string;
  organizationId: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  publicUrl: string;
  attachmentFileName?: string | null;
  attachmentMimeType?: string | null;
  attachmentSizeBytes?: number | null;
  attachmentSha256?: string | null;
}): Promise<PreparedQuoteEmailSend> {
  const { data, error } = await supabaseAdmin.rpc('begin_quote_email_send', {
    p_quote_id: input.quoteId,
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
  });
  if (error) throw error;
  const payload = data as PreparedQuoteEmailSend | null;
  if (!payload?.deliveryId) throw new WorkflowHttpError('Verzendpoging kon niet worden voorbereid.', 500);
  return payload;
}

async function completeQuoteEmailSend(deliveryId: string, organizationId: string, userId: string, providerEmailId: string): Promise<CompletedQuoteEmailSend> {
  const { data, error } = await supabaseAdmin.rpc('complete_quote_email_send', {
    p_delivery_id: deliveryId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_provider_email_id: providerEmailId,
  });
  if (error) throw error;
  return (data ?? {}) as CompletedQuoteEmailSend;
}

async function failQuoteEmailSend(deliveryId: string, organizationId: string, userId: string, errorMessage: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('fail_quote_email_send', {
    p_delivery_id: deliveryId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_error_message: errorMessage,
  });
  if (error) console.warn('Quote email send failure registration failed', error.message);
}

function buildQuoteEmailHtml(input: { quote: QuoteRow; client: ClientRow; project: ProjectRow | null; company: CompanySettingsRow | null; publicUrl: string; recipientName: string; expiresAt: string }): string {
  const { quote, client, project, company, publicUrl, recipientName, expiresAt } = input;
  const companyName = escapeHtml(company?.trade_name || company?.company_name || 'BrandCore');
  const introName = escapeHtml(recipientName || client.contact_name || client.name || '');
  const totalAmount = formatEuro(calculateTotal(quote.lines));
  const expiry = new Date(expiresAt).toLocaleDateString('nl-NL');
  return `<!doctype html><html><body style="margin:0;background:#111111;font-family:Arial,sans-serif;color:#f5f5f5;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
    <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
      <p style="margin:0 0 8px;color:#b6b6c2;font-size:13px;text-transform:uppercase;letter-spacing:.08em;">${companyName}</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.15;">Offerte ${escapeHtml(quote.number)} staat klaar</h1>
      <p style="margin:0 0 18px;color:#d8d8df;font-size:16px;line-height:1.6;">Beste ${introName || 'relatie'},<br/>Je offerte staat klaar om te bekijken en digitaal goed te keuren.</p>
      <div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
        <p style="margin:0;color:#b6b6c2;">${project ? `Project: ${escapeHtml(project.name)}<br/>` : ''}Totaalbedrag: <strong style="color:#ffffff;">${totalAmount}</strong><br/>Geldig tot: ${escapeHtml(quote.valid_until || expiry)}</p>
      </div>
      <p style="margin:26px 0;"><a href="${escapeHtml(publicUrl)}" style="display:inline-block;background:#FFD966;color:#111111;text-decoration:none;font-weight:bold;padding:14px 20px;border-radius:14px;">Bekijk en keur offerte goed</a></p>
      <p style="margin:0;color:#9b9ba7;font-size:13px;line-height:1.5;">Deze beveiligde link is geldig tot ${expiry}. Werkt de knop niet? Kopieer deze link: ${escapeHtml(publicUrl)}</p>
    </div>
  </div></body></html>`;
}

function buildQuoteEmailText(input: { quote: QuoteRow; client: ClientRow; project: ProjectRow | null; company: CompanySettingsRow | null; publicUrl: string; recipientName: string; expiresAt: string }): string {
  const { quote, client, project, company, publicUrl, recipientName, expiresAt } = input;
  const companyName = company?.trade_name || company?.company_name || 'BrandCore';
  return [
    `${companyName}`,
    `Offerte ${quote.number} staat klaar`,
    '',
    `Beste ${recipientName || client.contact_name || client.name || 'relatie'},`,
    'Je offerte staat klaar om te bekijken en digitaal goed te keuren.',
    project ? `Project: ${project.name}` : '',
    `Totaalbedrag: ${formatEuro(calculateTotal(quote.lines))}`,
    quote.valid_until ? `Geldig tot: ${quote.valid_until}` : `Link geldig tot: ${new Date(expiresAt).toLocaleDateString('nl-NL')}`,
    '',
    publicUrl,
  ].filter(Boolean).join('\n');
}


async function createQuotePdfAttachment(input: { quote: QuoteRow; client: ClientRow; project: ProjectRow | null; company: CompanySettingsRow | null; publicUrl: string }): Promise<QuotePdfAttachment> {
  const { quote, client, project, company, publicUrl } = input;
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToPdfRgb(company?.invoice_accent_color || '#FFD966');
  const muted = rgb(0.38, 0.38, 0.38);
  let page = pdfDoc.addPage([595.28, 841.89]);
  let y = 780;

  const companyName = company?.trade_name || company?.company_name || 'BrandCore';
  page.drawRectangle({ x: 0, y: 824, width: 595.28, height: 18, color: accent, opacity: 0.85 });
  drawPdfText(page, 'OFFERTE', 48, y, bold, 26);
  drawPdfText(page, quote.number || '-', 547, y + 6, bold, 12, { align: 'right' });
  y -= 28;
  drawPdfText(page, companyName, 48, y, bold, 13);
  y -= 18;
  for (const line of companyAddressLines(company).slice(0, 7)) {
    drawPdfText(page, line, 48, y, regular, 9, { color: muted });
    y -= 12;
  }

  let rightY = 742;
  drawPdfText(page, `Datum: ${formatDateNl(quote.date)}`, 547, rightY, regular, 9, { align: 'right', color: muted });
  rightY -= 14;
  drawPdfText(page, `Geldig tot: ${formatDateNl(quote.valid_until)}`, 547, rightY, regular, 9, { align: 'right', color: muted });
  rightY -= 14;
  if (project?.name) drawPdfText(page, `Project: ${project.name}`, 547, rightY, regular, 9, { align: 'right', color: muted });

  y = 620;
  drawSectionTitle(page, 'Klant', 48, y, bold, accent, muted);
  y -= 24;
  for (const line of clientAddressLines(client)) {
    drawPdfText(page, line, 48, y, line === client.name ? bold : regular, 10);
    y -= 14;
  }

  y = 500;
  drawQuoteTableHeader(page, y, bold, accent, muted);
  y -= 28;
  const lines = Array.isArray(quote.lines) ? quote.lines : [];
  for (const line of lines) {
    if (y < 155) {
      drawPdfFooter(page, regular, company);
      page = pdfDoc.addPage([595.28, 841.89]);
      y = 780;
      drawQuoteTableHeader(page, y, bold, accent, muted);
      y -= 28;
    }
    const rowHeight = drawQuoteLine(page, line, y, regular, bold, muted);
    y -= rowHeight;
  }

  const totals = calculateTotals(quote.lines);
  if (y < 230) {
    drawPdfFooter(page, regular, company);
    page = pdfDoc.addPage([595.28, 841.89]);
    y = 760;
  }

  y -= 10;
  drawPdfText(page, 'Subtotaal', 365, y, regular, 10);
  drawPdfText(page, formatEuro(totals.subtotal), 547, y, regular, 10, { align: 'right' });
  y -= 18;
  drawPdfText(page, 'BTW', 365, y, regular, 10);
  drawPdfText(page, formatEuro(totals.vat), 547, y, regular, 10, { align: 'right' });
  y -= 22;
  page.drawLine({ start: { x: 365, y: y + 12 }, end: { x: 547, y: y + 12 }, thickness: 0.8, color: accent });
  drawPdfText(page, 'Totaal', 365, y, bold, 13);
  drawPdfText(page, formatEuro(totals.total), 547, y, bold, 13, { align: 'right' });

  if (quote.notes) {
    y -= 46;
    drawSectionTitle(page, 'Notities', 48, y, bold, accent, muted);
    y -= 24;
    y = drawWrappedPdfText(page, quote.notes, 48, y, 310, regular, 9, 12, muted);
  }

  y = Math.max(94, y - 28);
  drawPdfText(page, 'Bekijk en keur deze offerte online goed:', 48, y, bold, 9, { color: muted });
  y -= 13;
  drawWrappedPdfText(page, publicUrl, 48, y, 500, regular, 8, 11, muted);
  drawPdfFooter(page, regular, company);

  const bytes = await pdfDoc.save();
  const sha256 = await sha256HexBytes(bytes);
  const fileName = `offerte-${sanitizeFileName(quote.number || quote.id)}.pdf`;
  return {
    fileName,
    mimeType: 'application/pdf',
    bytes,
    base64: bytesToBase64(bytes),
    sizeBytes: bytes.byteLength,
    sha256,
  };
}

function drawQuoteTableHeader(page: PDFPage, y: number, bold: PDFFont, accent: RGB, muted: RGB) {
  page.drawRectangle({ x: 48, y: y - 8, width: 499, height: 24, color: accent, opacity: 0.18 });
  drawPdfText(page, 'Omschrijving', 56, y, bold, 8, { color: muted });
  drawPdfText(page, 'Aantal', 356, y, bold, 8, { align: 'right', color: muted });
  drawPdfText(page, 'Prijs', 424, y, bold, 8, { align: 'right', color: muted });
  drawPdfText(page, 'BTW', 470, y, bold, 8, { align: 'right', color: muted });
  drawPdfText(page, 'Totaal', 547, y, bold, 8, { align: 'right', color: muted });
}

function drawQuoteLine(page: PDFPage, line: QuoteLine, y: number, regular: PDFFont, bold: PDFFont, muted: RGB): number {
  const descriptionLines = wrapPdfText(line.description || '-', regular, 9, 270);
  const quantity = Number(line.quantity || 0);
  const unitPrice = Number(line.unit_price || 0);
  const vatPercentage = Number(line.vat || 0);
  const lineSubtotal = quantity * unitPrice;
  const lineTotal = lineSubtotal * (1 + vatPercentage / 100);
  page.drawLine({ start: { x: 48, y: y + 8 }, end: { x: 547, y: y + 8 }, thickness: 0.35, color: muted, opacity: 0.25 });
  let descY = y;
  for (const desc of descriptionLines) {
    drawPdfText(page, desc, 56, descY, regular, 9);
    descY -= 12;
  }
  drawPdfText(page, String(quantity), 356, y, regular, 9, { align: 'right' });
  drawPdfText(page, formatEuro(unitPrice), 424, y, regular, 9, { align: 'right' });
  drawPdfText(page, `${vatPercentage}%`, 470, y, regular, 9, { align: 'right' });
  drawPdfText(page, formatEuro(lineTotal), 547, y, bold, 9, { align: 'right' });
  return Math.max(26, descriptionLines.length * 12 + 12);
}

function drawSectionTitle(page: PDFPage, title: string, x: number, y: number, bold: PDFFont, accent: RGB, muted: RGB) {
  drawPdfText(page, title.toUpperCase(), x, y, bold, 8, { color: muted });
  page.drawLine({ start: { x, y: y - 5 }, end: { x: x + 180, y: y - 5 }, thickness: 0.6, color: accent });
}

function drawPdfFooter(page: PDFPage, font: PDFFont, company: CompanySettingsRow | null) {
  const footer = company?.invoice_footer || company?.invoice_payment_terms || 'Bedankt voor het vertrouwen.';
  page.drawLine({ start: { x: 48, y: 58 }, end: { x: 547, y: 58 }, thickness: 0.45, color: rgb(0.38, 0.38, 0.38), opacity: 0.35 });
  drawWrappedPdfText(page, footer, 48, 42, 499, font, 8, 10, rgb(0.38, 0.38, 0.38));
}

function drawPdfText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, opts: { align?: 'left' | 'right'; color?: RGB } = {}) {
  const safe = normalizePdfText(text);
  if (!safe) return;
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: opts.align === 'right' ? x - width : x, y, font, size, color: opts.color || rgb(0.1, 0.1, 0.1) });
}

function drawWrappedPdfText(page: PDFPage, text: string, x: number, y: number, maxWidth: number, font: PDFFont, size: number, lineHeight: number, color?: RGB): number {
  let cursorY = y;
  for (const line of wrapPdfText(text, font, size, maxWidth)) {
    drawPdfText(page, line, x, cursorY, font, size, { color });
    cursorY -= lineHeight;
  }
  return cursorY;
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const source = normalizePdfText(text);
  if (!source) return [];
  const words = source.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const wordChunks = font.widthOfTextAtSize(word, size) > maxWidth ? splitLongPdfWord(word, font, size, maxWidth) : [word];
    for (const chunk of wordChunks) {
      const candidate = current ? `${current} ${chunk}` : chunk;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitLongPdfWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const char of word) {
    const candidate = current + char;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizePdfText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '-')
    .replace(/€/g, 'EUR')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .split('')
    .filter(char => {
      const code = char.charCodeAt(0);
      return (code >= 32 && code <= 126) || (code >= 160 && code <= 255);
    })
    .join('')
    .trim();
}

function companyAddressLines(company: CompanySettingsRow | null): string[] {
  if (!company) return ['BrandCore'];
  const cityLine = [company.postal_code, company.city].filter(Boolean).join(' ');
  return [
    company.company_name,
    company.trade_name && company.trade_name !== company.company_name ? company.trade_name : '',
    company.address_line1,
    company.address_line2,
    cityLine,
    company.country,
    company.email ? `E-mail: ${company.email}` : '',
    company.phone ? `Tel: ${company.phone}` : '',
    company.website ? `Web: ${company.website}` : '',
    company.kvk_number ? `KvK: ${company.kvk_number}` : '',
    company.vat_number ? `BTW: ${company.vat_number}` : '',
    company.iban ? `IBAN: ${company.iban}` : '',
  ].filter(value => normalizePdfText(value).length > 0).map(normalizePdfText);
}

function clientAddressLines(client: ClientRow): string[] {
  return [
    client.name,
    client.contact_name ? `T.a.v. ${client.contact_name}` : '',
    client.email ? `E-mail: ${client.email}` : '',
  ].filter(value => normalizePdfText(value).length > 0).map(normalizePdfText);
}

function calculateTotals(lines: QuoteLine[] = []): { subtotal: number; vat: number; total: number } {
  return lines.reduce((acc, line) => {
    const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
    const vat = subtotal * (Number(line.vat || 0) / 100);
    acc.subtotal += subtotal;
    acc.vat += vat;
    acc.total += subtotal + vat;
    return acc;
  }, { subtotal: 0, vat: 0, total: 0 });
}

function formatDateNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}

function hexToPdfRgb(value: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  const hex = match ? match[1] : 'FFD966';
  const int = Number.parseInt(hex, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'offerte';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function calculateTotal(lines: QuoteLine[] = []): number {
  return lines.reduce((sum, line) => {
    const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
    const vat = subtotal * (Number(line.vat || 0) / 100);
    return sum + subtotal + vat;
  }, 0);
}

function formatEuro(value: number): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value || 0);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
}

function sanitizeTagValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 256) || 'quote';
}

function validateQuotePdfAttachment(attachment: QuotePdfAttachment): void {
  if (attachment.mimeType !== 'application/pdf') {
    throw new WorkflowHttpError('De gegenereerde offertebijlage is geen PDF.', 500);
  }
  if (!attachment.fileName.toLowerCase().endsWith('.pdf')) {
    throw new WorkflowHttpError('De gegenereerde offertebijlage heeft geen PDF-bestandsnaam.', 500);
  }
  if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes <= 0) {
    throw new WorkflowHttpError('De gegenereerde offerte-PDF is leeg.', 500);
  }
  if (attachment.sizeBytes > QUOTE_PDF_MAX_ATTACHMENT_BYTES) {
    throw new WorkflowHttpError(`De offerte-PDF is te groot om als e-mailbijlage te versturen (${Math.ceil(attachment.sizeBytes / 1024 / 1024)} MB).`, 422);
  }
  if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
    throw new WorkflowHttpError('De offerte-PDF kon niet betrouwbaar worden gehasht.', 500);
  }
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = QUOTE_ALLOWED_ORIGINS.includes(origin) || (QUOTE_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin
    : (QUOTE_ALLOW_LOCAL_DEV && !origin ? '*' : 'null');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  if (!origin && QUOTE_ALLOW_LOCAL_DEV) return;
  if (QUOTE_ALLOWED_ORIGINS.includes(origin)) return;
  if (QUOTE_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (QUOTE_ALLOWED_ORIGINS.length === 0 && QUOTE_ALLOW_LOCAL_DEV) return;
  if (QUOTE_ALLOWED_ORIGINS.length === 0) throw new WorkflowHttpError('QUOTE_ALLOWED_ORIGINS is verplicht in productie.', 500);
  throw new WorkflowHttpError('Deze frontend-origin is niet toegestaan voor quote workflow-acties.', 403);
}

function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}

async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new WorkflowHttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new WorkflowHttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new WorkflowHttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new WorkflowHttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isDateBeforeToday(value: string | null): boolean {
  if (!value) return false;
  const parsed = Date.parse(`${value}T23:59:59`);
  if (!Number.isFinite(parsed)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed < today.getTime();
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoaUrlBytes(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function btoaUrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
