import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { getModuleLevel } from '../_shared/edgeAuth.ts';
import { renderEmailTemplate, type EmailTemplateContent } from '../_shared/emailTemplates/index.ts';
import { renderContractPdf, bytesToBase64, sha256HexBytes } from '../_shared/contractPdf.ts';
import { sanitizeContractHtml } from '../_shared/htmlSanitize.ts';
import { buildContractTokens, fillContractTokens } from '../_shared/contractTokens.ts';

// ============================================================
// contract-workflow (ingelogd): verstuurt een contract ter ondertekening en
// levert het getekende PDF terug. Gemodelleerd op quote-workflow; de PDF-opbouw
// loopt via de gedeelde module _shared/contractPdf.ts.
// ============================================================

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';

type ContractRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  number: string;
  title: string;
  body: string;
  date: string;
  valid_until: string | null;
  status: string;
  signed_storage_provider: string | null;
  signed_storage_key: string | null;
  signed_pdf_file_name: string | null;
  signed_pdf_size_bytes: number | null;
  signed_pdf_data_base64: string | null;
  signed_document_sha256: string | null;
  amount_cents: number | null;
  currency: string | null;
};

type ClientRow = { id: string; name: string; contact_name: string | null; email: string | null };
type CompanyRow = {
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
  invoice_footer?: string | null;
  invoice_accent_color?: string | null;
};

type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

const CONTRACT_PUBLIC_BASE_URL =
  Deno.env.get('CONTRACT_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '';

const CONTRACT_TOKEN_TTL_DAYS = parsePositiveInt(Deno.env.get('CONTRACT_TOKEN_TTL_DAYS'), 30);
const CONTRACT_PDF_MAX_ATTACHMENT_BYTES = parsePositiveInt(
  Deno.env.get('CONTRACT_PDF_MAX_ATTACHMENT_BYTES'),
  8 * 1024 * 1024,
);

// Private R2 voor het onveranderlijke getekende PDF (gedeeld met de invoice/quote
// storage Worker). Wordt door contract-public geschreven en hier gelezen.
const CONTRACT_PDF_STORAGE_WORKER_URL = (
  Deno.env.get('CONTRACT_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const CONTRACT_PDF_STORAGE_SECRET =
  Deno.env.get('CONTRACT_PDF_STORAGE_SECRET') || Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || '';

const CONTRACT_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('CONTRACT_ALLOWED_ORIGINS'),
  Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_ALLOWED_ORIGINS'),
  Deno.env.get('CONTRACT_PUBLIC_BASE_URL'),
  Deno.env.get('APP_PUBLIC_URL'),
]);
const CONTRACT_ALLOW_LOCAL_DEV =
  (Deno.env.get('CONTRACT_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class HttpError extends Error {
  status: HttpErrorStatus;
  constructor(message: string, status: HttpErrorStatus = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const contractId = String(body.contractId || '');

    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);
    // Service-role omzeilt RLS: modulerechten hier expliciet controleren.
    // Contracten vallen onder Financiën, net als in de zijbalk.
    const financeLevel = await getModuleLevel(supabaseAdmin, user.id, organizationId, 'finance');
    if (financeLevel === 'none') {
      throw new HttpError('Je hebt geen toegang tot de module Financiën in deze organisatie.', 403);
    }

    switch (action) {
      case 'sendContractForSignature': {
        if (!['owner', 'admin', 'member'].includes(role) || financeLevel !== 'write') {
          throw new HttpError('Geen schrijfrechten voor deze organisatie.', 403);
        }
        const result = await sendContractForSignature(user.id, organizationId, contractId, body);
        return json(req, { ok: true, ...result });
      }
      case 'downloadContractPdf': {
        if (!isUuid(contractId)) throw new HttpError('Ongeldig contract.', 400);
        const pdf = await loadSignedContractPdf(organizationId, contractId);
        return json(req, { ok: true, pdf });
      }
      case 'previewContractPdf': {
        if (!isUuid(contractId)) throw new HttpError('Ongeldig contract.', 400);
        const pdf = await previewContractPdf(organizationId, contractId);
        return json(req, { ok: true, pdf });
      }
      default:
        return json(req, { ok: false, error: `Onbekende contract workflow action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internalMessage = error instanceof Error ? error.message : 'Onbekende fout.';
    if (status >= 500) console.error('contract-workflow error', internalMessage);
    const publicMessage = error instanceof HttpError
      ? error.message
      : 'Contract workflow-actie mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendContractForSignature(
  userId: string,
  organizationId: string,
  contractId: string,
  body: Record<string, unknown>,
) {
  if (!RESEND_API_KEY) throw new HttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  if (!RESEND_FROM_EMAIL) throw new HttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  if (!CONTRACT_PUBLIC_BASE_URL) throw new HttpError('CONTRACT_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.', 500);
  if (!isUuid(contractId)) throw new HttpError('Ongeldig contract.', 400);

  const contract = await loadContract(organizationId, contractId);

  if (['signed', 'voided', 'declined'].includes(contract.status)) {
    throw new HttpError('Dit contract kan niet meer ter ondertekening worden verstuurd.', 409);
  }
  if (!contract.client_id) throw new HttpError('Dit contract heeft geen klant gekoppeld.', 422);
  if (!String(contract.title || '').trim() || !String(contract.body || '').trim()) {
    throw new HttpError('Vul een titel en inhoud in voordat je het contract verstuurt.', 422);
  }
  if (isDateBeforeToday(contract.valid_until)) {
    throw new HttpError('De ondertekendeadline ligt in het verleden. Pas de datum aan voordat je verstuurt.', 409);
  }

  const [client, company, content] = await Promise.all([
    loadClient(organizationId, contract.client_id),
    loadCompanySettings(organizationId),
    loadContractEmailContent(organizationId),
  ]);

  const recipientEmail = String(body.recipientEmail || client.email || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || client.contact_name || client.name || '').trim();
  const personalMessage = String(body.personalMessage || '').trim() || null;

  if (!isEmail(recipientEmail)) {
    throw new HttpError('Vul een geldig klant-e-mailadres in voordat je het contract verstuurt.', 422);
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(
    Date.now() + Math.max(1, CONTRACT_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const publicUrl = `${CONTRACT_PUBLIC_BASE_URL.replace(/\/$/, '')}/contract/${encodeURIComponent(token)}`;

  const rendered = renderEmailTemplate('contract.sent', {
    contract: { number: contract.number, title: contract.title, valid_until: contract.valid_until },
    client,
    company,
    publicUrl,
    recipientName,
    personalMessage,
    expiresAt,
    content,
  });

  const subject = String(body.subject || rendered.subject || '').trim();
  if (!subject) throw new HttpError('Er kon geen onderwerp voor de contract-e-mail worden bepaald.', 500);

  const projectName = await loadLinkedProjectName(organizationId, contractId);
  const tokens = buildContractTokens({
    contract: { number: contract.number, date: contract.date, amount_cents: contract.amount_cents, currency: contract.currency },
    client, company, projectName,
  });
  const filledBody = sanitizeContractHtml(fillContractTokens(contract.body, tokens));

  const pdf = await buildConceptAttachment(contract, client, company, publicUrl, filledBody);
  validatePdf(pdf);

  const deliveryId = await beginSignatureSend({
    contractId,
    organizationId,
    userId,
    tokenHash,
    expiresAt,
    recipientEmail,
    recipientName,
    subject,
  });

  const senderIdentity = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  const resendPayload = {
    from: senderIdentity.from,
    to: [recipientEmail],
    reply_to: senderIdentity.replyTo,
    subject,
    html: rendered.html,
    text: rendered.text,
    attachments: [{ filename: pdf.fileName, content: pdf.base64 }],
    tags: [
      { name: 'organization_id', value: sanitizeTagValue(organizationId) },
      { name: 'contract_id', value: sanitizeTagValue(contractId) },
      { name: 'contract_number', value: sanitizeTagValue(contract.number) },
      { name: 'template_key', value: 'contract_sent' },
    ],
  };

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': sanitizeIdempotencyKey(`contract-${contractId}-${deliveryId}`),
    },
    body: JSON.stringify(resendPayload),
  });
  const resendResponsePayload = (await resendResponse.json().catch(() => ({}))) as Record<string, unknown>;

  if (!resendResponse.ok) {
    const errorMessage = String(
      resendResponsePayload.message || resendResponsePayload.error || resendResponse.statusText || 'Resend send failed',
    );
    console.error('Resend contract send failed', resendResponsePayload);
    await failSignatureSend(deliveryId, organizationId, userId, errorMessage);
    throw new HttpError(`Resend kon de contract-e-mail niet versturen: ${errorMessage}`, 502);
  }

  const providerEmailId = String(resendResponsePayload.id || resendResponsePayload.email_id || '').trim();
  if (!providerEmailId) {
    await failSignatureSend(deliveryId, organizationId, userId, 'Resend gaf geen e-mail-ID terug.');
    throw new HttpError('Resend nam de e-mail aan maar gaf geen e-mail-ID terug.', 502);
  }

  const contractAfter = await completeSignatureSend(deliveryId, organizationId, userId, providerEmailId);

  // Bevries de verstuurde versie (onveranderlijk). Niet-fataal als dit faalt.
  const snapshotResult = await supabaseAdmin.rpc('snapshot_contract_version', {
    p_contract_id: contractId,
    p_organization_id: organizationId,
    p_reason: 'sent_to_client',
    p_title: contract.title,
    p_body: filledBody,
    p_amount_cents: contract.amount_cents,
    p_currency: contract.currency,
    p_created_by: userId,
  });
  if (snapshotResult.error) console.warn('contract version snapshot failed', snapshotResult.error.message);

  return {
    contract: contractAfter,
    publicUrl,
    providerEmailId,
    attachment: { fileName: pdf.fileName, sizeBytes: pdf.sizeBytes, sha256: pdf.sha256 },
  };
}

type ContractAttachment = { fileName: string; mimeType: 'application/pdf'; base64: string; sizeBytes: number; sha256: string };

async function buildConceptAttachment(contract: ContractRow, client: ClientRow, company: CompanyRow | null, publicUrl: string, body: string): Promise<ContractAttachment> {
  const bytes = await renderContractPdf({
    contract: { id: contract.id, number: contract.number, title: contract.title, body, date: contract.date, valid_until: contract.valid_until },
    client,
    company,
    publicUrl,
  });
  const sha256 = await sha256HexBytes(bytes);
  return {
    fileName: `contract-${sanitizeFileName(contract.number || contract.id)}.pdf`,
    mimeType: 'application/pdf',
    base64: bytesToBase64(bytes),
    sizeBytes: bytes.byteLength,
    sha256,
  };
}

function validatePdf(pdf: ContractAttachment): void {
  if (pdf.mimeType !== 'application/pdf') throw new HttpError('De gegenereerde bijlage is geen PDF.', 500);
  if (!pdf.fileName.toLowerCase().endsWith('.pdf')) throw new HttpError('De bijlage heeft geen PDF-bestandsnaam.', 500);
  if (!Number.isFinite(pdf.sizeBytes) || pdf.sizeBytes <= 0) throw new HttpError('De gegenereerde PDF is leeg.', 500);
  if (pdf.sizeBytes > CONTRACT_PDF_MAX_ATTACHMENT_BYTES) {
    throw new HttpError(`De contract-PDF is te groot om als bijlage te versturen (${Math.ceil(pdf.sizeBytes / 1024 / 1024)} MB).`, 422);
  }
  if (!/^[a-f0-9]{64}$/i.test(pdf.sha256)) throw new HttpError('De contract-PDF kon niet betrouwbaar worden gehasht.', 500);
}

// Genereert een concept-PDF (met ingevulde variabelen) van een opgeslagen
// concept, puur voor preview — niets wordt opgeslagen of verstuurd.
async function previewContractPdf(
  organizationId: string,
  contractId: string,
): Promise<{ fileName: string; mimeType: string; base64: string }> {
  const contract = await loadContract(organizationId, contractId);
  const [client, company, projectName] = await Promise.all([
    contract.client_id ? loadClient(organizationId, contract.client_id).catch(() => null) : Promise.resolve(null),
    loadCompanySettings(organizationId),
    loadLinkedProjectName(organizationId, contractId),
  ]);
  const tokens = buildContractTokens({
    contract: { number: contract.number, date: contract.date, amount_cents: contract.amount_cents, currency: contract.currency },
    client, company, projectName,
  });
  const filledBody = sanitizeContractHtml(fillContractTokens(contract.body, tokens));
  const bytes = await renderContractPdf({
    contract: { id: contract.id, number: contract.number, title: contract.title, body: filledBody, date: contract.date, valid_until: contract.valid_until },
    client: client ?? { name: '(klant)', contact_name: null, email: null },
    company,
    publicUrl: null,
  });
  return { fileName: `contract-${sanitizeFileName(contract.number || contract.id)}-preview.pdf`, mimeType: 'application/pdf', base64: bytesToBase64(bytes) };
}

// ------------------------------------------------------------ data access
async function loadContract(organizationId: string, contractId: string): Promise<ContractRow> {
  const { data, error } = await supabaseAdmin
    .from('contracts')
    .select(
      'id,organization_id,client_id,number,title,body,date,valid_until,status,signed_storage_provider,signed_storage_key,signed_pdf_file_name,signed_pdf_size_bytes,signed_pdf_data_base64,signed_document_sha256,amount_cents,currency',
    )
    .eq('id', contractId)
    .eq('organization_id', organizationId)
    .single();
  if (error || !data) throw new HttpError('Contract niet gevonden.', 404);
  return data as ContractRow;
}

async function loadLinkedProjectName(organizationId: string, contractId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('projects').select('name')
    .eq('organization_id', organizationId).eq('contract_id', contractId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

async function loadClient(organizationId: string, clientId: string): Promise<ClientRow> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email')
    .eq('id', clientId)
    .eq('organization_id', organizationId)
    .single();
  if (error || !data) throw new HttpError('Klant niet gevonden.', 404);
  return data as ClientRow;
}

async function loadCompanySettings(organizationId: string): Promise<CompanyRow | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select(
      'company_name,trade_name,address_line1,address_line2,postal_code,city,country,email,phone,website,kvk_number,vat_number,invoice_footer,invoice_accent_color',
    )
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as CompanyRow | null;
}

async function loadContractEmailContent(organizationId: string): Promise<EmailTemplateContent | null> {
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .eq('template_key', 'contract.sent')
    .maybeSingle();
  if (error) {
    console.warn('email_templates lookup mislukte', error.message);
    return null;
  }
  if (!data) return null;
  const row = data as { enabled: boolean; subject: string | null; intro: string | null; closing: string | null; cta_label: string | null };
  return { enabled: row.enabled, subject: row.subject, intro: row.intro, closing: row.closing, ctaLabel: row.cta_label };
}

async function beginSignatureSend(input: {
  contractId: string;
  organizationId: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc('begin_contract_signature_send', {
    p_contract_id: input.contractId,
    p_organization_id: input.organizationId,
    p_actor_user_id: input.userId,
    p_token_hash: input.tokenHash,
    p_token_expires_at: input.expiresAt,
    p_recipient_email: input.recipientEmail,
    p_recipient_name: input.recipientName,
    p_subject: input.subject,
  });
  if (error) throw error;
  const deliveryId = String(data || '');
  if (!deliveryId) throw new HttpError('Verzendpoging kon niet worden voorbereid.', 500);
  return deliveryId;
}

async function completeSignatureSend(deliveryId: string, organizationId: string, userId: string, providerEmailId: string): Promise<unknown> {
  const { data, error } = await supabaseAdmin.rpc('complete_contract_signature_send', {
    p_delivery_id: deliveryId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_provider_email_id: providerEmailId,
  });
  if (error) throw error;
  return data;
}

async function failSignatureSend(deliveryId: string, organizationId: string, userId: string, message: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('fail_contract_signature_send', {
    p_delivery_id: deliveryId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_error_message: message,
  });
  if (error) console.warn('Contract email send failure registration failed', error.message);
}

async function loadSignedContractPdf(
  organizationId: string,
  contractId: string,
): Promise<{ fileName: string; mimeType: string; base64: string; sizeBytes: number | null; sha256: string | null }> {
  const contract = await loadContract(organizationId, contractId);
  let base64 = String(contract.signed_pdf_data_base64 || '').trim();

  if (!base64 && contract.signed_storage_provider === 'r2' && contract.signed_storage_key) {
    if (!CONTRACT_PDF_STORAGE_WORKER_URL || !CONTRACT_PDF_STORAGE_SECRET) {
      throw new HttpError('Getekend PDF staat in private storage, maar de storage-koppeling ontbreekt in de Edge Function secrets.', 500);
    }
    const response = await fetch(
      `${CONTRACT_PDF_STORAGE_WORKER_URL}/internal/contract-snapshot/${encodeURIComponent(contract.signed_storage_key)}`,
      { headers: { Authorization: `Bearer ${CONTRACT_PDF_STORAGE_SECRET}` } },
    );
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      console.error('contract-workflow R2 fetch failed', { status: response.status, message });
      throw new HttpError('Getekend PDF kon niet uit private storage worden opgehaald.', 502);
    }
    base64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  if (!base64) throw new HttpError('Er is nog geen getekend PDF voor dit contract.', 404);
  return {
    fileName: String(contract.signed_pdf_file_name || `contract-${contract.number}.pdf`),
    mimeType: 'application/pdf',
    sizeBytes: contract.signed_pdf_size_bytes ?? null,
    sha256: contract.signed_document_sha256 ?? null,
    base64,
  };
}

// ------------------------------------------------------------ generic helpers
function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'contract';
}
function sanitizeTagValue(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || 'contract';
}
function sanitizeIdempotencyKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || crypto.randomUUID();
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;
      if (part.startsWith('http://') || part.startsWith('https://')) {
        try { origins.add(new URL(part).origin); } catch { origins.add(part); }
      } else {
        origins.add(part);
      }
    }
  }
  return [...origins];
}
function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin =
    CONTRACT_ALLOWED_ORIGINS.includes(origin) || (CONTRACT_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
      ? origin
      : CONTRACT_ALLOW_LOCAL_DEV && !origin ? '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}
function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}
function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  if (!origin && CONTRACT_ALLOW_LOCAL_DEV) return;
  if (CONTRACT_ALLOWED_ORIGINS.includes(origin)) return;
  if (CONTRACT_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (CONTRACT_ALLOWED_ORIGINS.length === 0 && CONTRACT_ALLOW_LOCAL_DEV) return;
  if (CONTRACT_ALLOWED_ORIGINS.length === 0) {
    throw new HttpError('CONTRACT_ALLOWED_ORIGINS, MAIL_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500);
  }
  throw new HttpError('Deze frontend-origin is niet toegestaan voor contract workflow-acties.', 403);
}
function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}
async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}
async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new HttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new HttpError('Geen toegang tot deze organisatie.', 403);
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
function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
