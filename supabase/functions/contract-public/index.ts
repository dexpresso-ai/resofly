import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { renderEmailTemplate, type EmailTemplateContent } from '../_shared/emailTemplates/index.ts';
import { renderContractPdf, bytesToBase64, sha256HexBytes, type PdfSignature } from '../_shared/contractPdf.ts';

// ============================================================
// contract-public (publiek, geen login): de API achter de ondertekenpagina
// /contract/:token. Spiegelt quote-public. Muteren loopt via security-definer
// RPC's met de service-role; de browser gebruikt de anon-key.
//
// Bij ondertekenen wordt het bewijs vastgelegd (IP + user-agent server-side,
// consent-tekst, tijdstempel), een onveranderlijk getekend PDF + ondertekenbewijs
// gegenereerd en opgeslagen (R2 of base64-fallback), en de bevestigingsmails
// verstuurd (klant + intern). E-mailfouten blokkeren de ondertekening nooit.
// ============================================================

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
  signed_at: string | null;
  public_token_expires_at: string | null;
};

type PublicHttpErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 422 | 500;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

const APP_PUBLIC_URL = (Deno.env.get('APP_PUBLIC_URL') || Deno.env.get('CONTRACT_PUBLIC_BASE_URL') || '').replace(/\/$/, '');

const CONTRACT_PDF_STORAGE_WORKER_URL = (
  Deno.env.get('CONTRACT_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const CONTRACT_PDF_STORAGE_SECRET =
  Deno.env.get('CONTRACT_PDF_STORAGE_SECRET') || Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || '';

const CONTRACT_PDF_MAX_ATTACHMENT_BYTES = parsePositiveInt(Deno.env.get('CONTRACT_PDF_MAX_ATTACHMENT_BYTES'), 8 * 1024 * 1024);

const CONTRACT_PUBLIC_ALLOWED_ORIGINS = (
  Deno.env.get('CONTRACT_PUBLIC_ALLOWED_ORIGINS') ||
  Deno.env.get('CONTRACT_ALLOWED_ORIGINS') ||
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS') ||
  Deno.env.get('APP_PUBLIC_URL') ||
  ''
).split(',').map((v) => v.trim()).filter(Boolean);
const CONTRACT_ALLOW_LOCAL_DEV = (Deno.env.get('CONTRACT_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class PublicHttpError extends Error {
  status: PublicHttpErrorStatus;
  constructor(message: string, status: PublicHttpErrorStatus = 400) {
    super(message);
    this.name = 'PublicHttpError';
    this.status = status;
  }
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || 'getContract');
    const token = String(body.token || '').trim();
    if (!token || token.length < 24) throw new PublicHttpError('Ondertekenlink ontbreekt of is ongeldig.', 400);
    const tokenHash = await sha256Hex(token);

    switch (action) {
      case 'getContract':
        return json(req, { ok: true, ...(await getPublicContract(tokenHash)) });
      case 'signContract':
        return json(req, { ok: true, ...(await signPublicContract(tokenHash, body, req)) });
      case 'declineContract':
        return json(req, { ok: true, ...(await declinePublicContract(tokenHash, body)) });
      case 'askQuestion':
        return json(req, { ok: true, ...(await askQuestionPublic(tokenHash, body)) });
      default:
        return json(req, { ok: false, error: `Onbekende publieke contract-actie: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof PublicHttpError ? error.status : 500;
    const internalMessage = describeError(error);
    if (status >= 500) console.error('contract-public error', internalMessage, error instanceof Error ? error.stack : undefined);
    const publicMessage = error instanceof PublicHttpError
      ? error.message
      : `Contract kon niet worden geladen: ${internalMessage}`.slice(0, 500);
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

// ------------------------------------------------------------ actions
async function getPublicContract(tokenHash: string) {
  const contract = await loadContractByTokenHash(tokenHash);
  await insertClientViewedEvent(contract.organization_id, contract.id);
  return await buildPayload(contract);
}

async function signPublicContract(tokenHash: string, body: Record<string, unknown>, req: Request) {
  const signerName = String(body.signerName || '').trim();
  const signerEmail = String(body.signerEmail || '').trim().toLowerCase();
  const method = String(body.signatureMethod || '').trim();
  const signatureImage = typeof body.signatureImage === 'string' ? body.signatureImage : '';
  const consentText = String(body.consentText || '').trim();

  if (!signerName) throw new PublicHttpError('Vul je naam in om te ondertekenen.', 422);
  if (!isEmail(signerEmail)) throw new PublicHttpError('Vul een geldig e-mailadres in.', 422);
  if (method !== 'typed' && method !== 'drawn') throw new PublicHttpError('Kies een geldige ondertekenmethode.', 422);
  if (method === 'drawn' && !/^data:image\/(png|jpe?g);base64,/.test(signatureImage)) {
    throw new PublicHttpError('De getekende handtekening ontbreekt of is ongeldig.', 422);
  }
  if (!consentText) throw new PublicHttpError('Akkoordverklaring ontbreekt.', 422);

  const ip = clientIp(req);
  const userAgent = req.headers.get('user-agent');

  // 1. Markeer ondertekend + leg het bewijs vast (atomair, met statuscontrole).
  const { data: signedData, error: signError } = await supabaseAdmin.rpc('sign_contract_public', {
    p_token_hash: tokenHash,
    p_signer_name: signerName,
    p_signer_email: signerEmail,
    p_signature_method: method,
    p_signature_image: method === 'drawn' ? signatureImage : null,
    p_consent_text: consentText,
    p_ip: ip,
    p_user_agent: userAgent,
  });
  if (signError) {
    if (/ongeldig|verlopen|niet meer/i.test(signError.message)) throw new PublicHttpError(signError.message, 409);
    throw signError;
  }
  const contract = (Array.isArray(signedData) ? signedData[0] : signedData) as ContractRow;
  const signedAt = contract.signed_at || new Date().toISOString();

  const [client, company] = await Promise.all([
    contract.client_id ? loadClient(contract.organization_id, contract.client_id) : Promise.resolve(null),
    loadCompanySettings(contract.organization_id),
  ]);

  // 2. Genereer het getekende PDF + ondertekenbewijs.
  const signature: PdfSignature = {
    signerName,
    signerEmail,
    signedAt,
    method,
    signatureImage: method === 'drawn' ? signatureImage : null,
    ip,
    userAgent,
    consentText,
  };
  const pdfBytes = await renderContractPdf({
    contract: { id: contract.id, number: contract.number, title: contract.title, body: contract.body, date: contract.date, valid_until: contract.valid_until },
    client: client || { name: client?.name || 'Klant', contact_name: null, email: signerEmail },
    company,
    signature,
  });
  const sha256 = await sha256HexBytes(pdfBytes);
  const base64 = bytesToBase64(pdfBytes);
  const fileName = `contract-${sanitizeFileName(contract.number || contract.id)}-getekend.pdf`;

  // 3. Sla onveranderlijk op (R2 of base64-fallback) en koppel aan het contract.
  const stored = await storeSignedPdf(contract.organization_id, contract.id, pdfBytes, sha256);
  const { error: attachError } = await supabaseAdmin.rpc('attach_signed_contract_pdf', {
    p_contract_id: contract.id,
    p_organization_id: contract.organization_id,
    p_storage_provider: stored.provider,
    p_storage_key: stored.key,
    p_sha256: sha256,
    p_file_name: fileName,
    p_size_bytes: pdfBytes.byteLength,
    p_data_base64: stored.storeBase64 ? base64 : null,
  });
  if (attachError) console.error('attach_signed_contract_pdf failed', attachError.message);

  // 4. Bevestigingsmails (best-effort: blokkeren de ondertekening nooit).
  await sendConfirmationEmails(contract, client, company, { signerName, signerEmail, signedAt }, { fileName, base64, sizeBytes: pdfBytes.byteLength }).catch((e) => {
    console.error('contract confirmation emails failed', describeError(e));
  });

  return await buildPayload(contract);
}

async function declinePublicContract(tokenHash: string, body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const reason = String(body.reason || '').trim();
  if (!name) throw new PublicHttpError('Vul je naam in.', 422);

  const { data, error } = await supabaseAdmin.rpc('decline_contract_public', {
    p_token_hash: tokenHash,
    p_name: name,
    p_email: email || null,
    p_reason: reason || null,
  });
  if (error) {
    if (/ongeldig|verlopen|niet meer/i.test(error.message)) throw new PublicHttpError(error.message, 409);
    throw error;
  }
  const contract = (Array.isArray(data) ? data[0] : data) as ContractRow;
  return await buildPayload(contract);
}

async function askQuestionPublic(tokenHash: string, body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const message = String(body.message || '').trim();
  if (!message) throw new PublicHttpError('Schrijf eerst je vraag.', 422);

  const { error } = await supabaseAdmin.rpc('ask_contract_question_public', {
    p_token_hash: tokenHash,
    p_name: name,
    p_email: email || null,
    p_message: message,
  });
  if (error) {
    if (/ongeldig|verlopen|leeg/i.test(error.message)) throw new PublicHttpError(error.message, 409);
    throw error;
  }
  return { sent: true };
}

// ------------------------------------------------------------ confirmation emails
async function sendConfirmationEmails(
  contract: ContractRow,
  client: { name: string; contact_name: string | null; email: string | null } | null,
  company: CompanyRow | null,
  signer: { signerName: string; signerEmail: string; signedAt: string },
  pdf: { fileName: string; base64: string; sizeBytes: number },
): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return;
  const senderIdentity = await resolveSenderIdentity(supabaseAdmin, contract.organization_id, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  const attachPdf = pdf.sizeBytes <= CONTRACT_PDF_MAX_ATTACHMENT_BYTES;
  const portalUrl = APP_PUBLIC_URL ? `${APP_PUBLIC_URL}/portal` : null;

  // Klantbevestiging (met getekend PDF als bijlage).
  const content = await loadContractEmailContent(contract.organization_id, 'contract.signed.client');
  const clientEmail = renderEmailTemplate('contract.signed.client', {
    contract: { number: contract.number, title: contract.title },
    client: { name: client?.name || signer.signerName, contact_name: client?.contact_name ?? null, email: signer.signerEmail },
    company,
    signedAt: signer.signedAt,
    recipientName: signer.signerName,
    portalUrl,
    content,
  });
  await sendResend({
    from: senderIdentity.from,
    replyTo: senderIdentity.replyTo,
    to: signer.signerEmail,
    subject: clientEmail.subject,
    html: clientEmail.html,
    text: clientEmail.text,
    attachments: attachPdf ? [{ filename: pdf.fileName, content: pdf.base64 }] : undefined,
    tags: contractTags(contract, 'contract_signed_client'),
  }).then(() => insertEvent(contract.organization_id, contract.id, 'email_sent', 'Bevestiging naar klant verstuurd'))
    .catch((e) => console.error('client confirmation send failed', describeError(e)));

  // Interne melding naar het bedrijfs-e-mailadres (indien bekend).
  const internalTo = (company?.email || '').trim().toLowerCase();
  if (internalTo && isEmail(internalTo)) {
    const internalEmail = renderEmailTemplate('contract.signed.internal', {
      contract: { number: contract.number, title: contract.title },
      client: { name: client?.name || signer.signerName },
      company,
      signerName: signer.signerName,
      signerEmail: signer.signerEmail,
      signedAt: signer.signedAt,
      appUrl: APP_PUBLIC_URL || null,
    });
    await sendResend({
      from: senderIdentity.from,
      replyTo: senderIdentity.replyTo,
      to: internalTo,
      subject: internalEmail.subject,
      html: internalEmail.html,
      text: internalEmail.text,
      tags: contractTags(contract, 'contract_signed_internal'),
    }).catch((e) => console.error('internal notification send failed', describeError(e)));
  }
}

async function sendResend(input: {
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: string }>;
  tags: Array<{ name: string; value: string }>;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    reply_to: input.replyTo,
    subject: input.subject,
    html: input.html,
    text: input.text,
    tags: input.tags,
  };
  if (input.attachments) payload.attachments = input.attachments;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Resend ${response.status}: ${detail}`);
  }
}

function contractTags(contract: ContractRow, templateKey: string): Array<{ name: string; value: string }> {
  return [
    { name: 'organization_id', value: sanitizeTagValue(contract.organization_id) },
    { name: 'contract_id', value: sanitizeTagValue(contract.id) },
    { name: 'template_key', value: sanitizeTagValue(templateKey) },
  ];
}

// ------------------------------------------------------------ storage
async function storeSignedPdf(
  organizationId: string,
  contractId: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<{ provider: 'r2' | 'database'; key: string | null; storeBase64: boolean }> {
  const configured = Boolean(CONTRACT_PDF_STORAGE_WORKER_URL && CONTRACT_PDF_STORAGE_SECRET);
  if (!configured) return { provider: 'database', key: null, storeBase64: true };

  const key = `${organizationId}/contract-pdfs/${contractId}/${crypto.randomUUID()}-getekend-contract.pdf`;
  const response = await fetch(`${CONTRACT_PDF_STORAGE_WORKER_URL}/internal/contract-snapshot`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONTRACT_PDF_STORAGE_SECRET}`,
      'Content-Type': 'application/pdf',
      'X-Storage-Key': key,
      'X-SHA256': sha256,
      'X-Size-Bytes': String(bytes.byteLength),
    },
    body: bytes,
  });
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    console.error('contract-public R2 upload failed', { status: response.status, message, key });
    // Val terug op base64 in de database zodat de ondertekening niet verloren gaat.
    return { provider: 'database', key: null, storeBase64: true };
  }
  return { provider: 'r2', key, storeBase64: false };
}

// ------------------------------------------------------------ data access
async function loadContractByTokenHash(tokenHash: string): Promise<ContractRow> {
  const { data, error } = await supabaseAdmin
    .from('contracts')
    .select('id,organization_id,client_id,number,title,body,date,valid_until,status,signed_at,public_token_expires_at')
    .eq('public_token_hash', tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PublicHttpError('Ondertekenlink is ongeldig of verlopen.', 404);
  const contract = data as ContractRow;
  if (!contract.public_token_expires_at || new Date(contract.public_token_expires_at).getTime() < Date.now()) {
    throw new PublicHttpError('Deze ondertekenlink is verlopen.', 410);
  }
  if (!['sent', 'signed', 'declined', 'expired'].includes(contract.status)) {
    throw new PublicHttpError('Dit contract is nog niet beschikbaar om te ondertekenen.', 409);
  }
  return contract;
}

async function loadClient(organizationId: string, clientId: string) {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email,phone')
    .eq('organization_id', organizationId)
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

type CompanyRow = {
  company_name: string;
  trade_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  invoice_footer?: string | null;
  invoice_accent_color?: string | null;
};

async function loadCompanySettings(organizationId: string): Promise<CompanyRow | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name,email,phone,website,address_line1,address_line2,postal_code,city,country,kvk_number,vat_number,invoice_footer,invoice_accent_color')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as CompanyRow | null;
}

async function loadContractEmailContent(organizationId: string, templateKey: string): Promise<EmailTemplateContent | null> {
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .eq('template_key', templateKey)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { enabled: boolean; subject: string | null; intro: string | null; closing: string | null; cta_label: string | null };
  return { enabled: row.enabled, subject: row.subject, intro: row.intro, closing: row.closing, ctaLabel: row.cta_label };
}

async function loadSigner(organizationId: string, contractId: string) {
  const { data, error } = await supabaseAdmin
    .from('contract_signers')
    .select('name,email,status,signed_at,signature_method')
    .eq('organization_id', organizationId)
    .eq('contract_id', contractId)
    .eq('role', 'client')
    .order('signing_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadEvents(organizationId: string, contractId: string) {
  const { data, error } = await supabaseAdmin
    .from('contract_events')
    .select('id,event_type,title,description,created_at')
    .eq('organization_id', organizationId)
    .eq('contract_id', contractId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function insertClientViewedEvent(organizationId: string, contractId: string): Promise<void> {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('contract_events')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('contract_id', contractId)
    .eq('event_type', 'client_viewed')
    .gte('created_at', since)
    .limit(1);
  if (data && data.length > 0) return;
  await insertEvent(organizationId, contractId, 'client_viewed', 'Klant heeft het contract geopend');
}

async function insertEvent(organizationId: string, contractId: string, eventType: string, title: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('insert_contract_event', {
    p_organization_id: organizationId,
    p_contract_id: contractId,
    p_event_type: eventType,
    p_title: title,
    p_description: null,
    p_metadata: {},
    p_actor_user_id: null,
  });
  if (error) console.warn('contract event insert failed', error.message);
}

async function buildPayload(contract: ContractRow) {
  const [client, company, signer, events] = await Promise.all([
    contract.client_id ? loadClient(contract.organization_id, contract.client_id) : Promise.resolve(null),
    loadCompanySettings(contract.organization_id),
    loadSigner(contract.organization_id, contract.id),
    loadEvents(contract.organization_id, contract.id),
  ]);
  return {
    contract: {
      id: contract.id,
      number: contract.number,
      title: contract.title,
      body: contract.body,
      date: contract.date,
      valid_until: contract.valid_until,
      status: contract.status,
      signed_at: contract.signed_at,
      public_token_expires_at: contract.public_token_expires_at,
    },
    client: client ? { name: client.name, contact_name: client.contact_name, email: client.email } : null,
    company: company
      ? { company_name: company.company_name, trade_name: company.trade_name, email: company.email, phone: company.phone, website: company.website, invoice_accent_color: company.invoice_accent_color }
      : null,
    signer,
    events,
  };
}

// ------------------------------------------------------------ helpers
function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || null;
}
function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'contract';
}
function sanitizeTagValue(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || 'contract';
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
  const allowOrigin = CONTRACT_PUBLIC_ALLOWED_ORIGINS.includes(origin) || (CONTRACT_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin
    : (CONTRACT_ALLOW_LOCAL_DEV && !origin ? '*' : 'null');
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
  if (CONTRACT_PUBLIC_ALLOWED_ORIGINS.includes(origin)) return;
  if (CONTRACT_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (CONTRACT_PUBLIC_ALLOWED_ORIGINS.length === 0 && CONTRACT_ALLOW_LOCAL_DEV) return;
  if (CONTRACT_PUBLIC_ALLOWED_ORIGINS.length === 0) throw new PublicHttpError('CONTRACT_PUBLIC_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500);
  throw new PublicHttpError('Deze frontend-origin is niet toegestaan voor publieke contract-acties.', 403);
}
function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
