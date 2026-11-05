import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { takeEmailQuota } from '../_shared/emailQuota.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { getModuleLevel } from '../_shared/edgeAuth.ts';

import { renderEmailTemplate, type EmailTemplateContent } from '../_shared/emailTemplates/index.ts';
import { invoiceVatNotes, type VatCodeInfo } from '../_shared/invoiceVatNotes.ts';
import { loadDocumentDesign, renderSalesDocumentPdf } from '../_shared/documentPdf.ts';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer' | 'accountant';

type QuoteLine = {
  id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  vat?: number;
  // De btw-code van de regel (verlegd, ICP, vrijgesteld…); bepaalt de
  // verplichte vermelding op de PDF.
  vat_code?: string | null;
};

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

type ClientRow = {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  // Voor de PDF: het adres en de nummers van de klant. De offerte-PDF toonde
  // tot november 2026 alleen naam, t.a.v. en e-mail.
  phone?: string | null;
  client_code?: string | null;
  vat_number?: string | null;
  kvk_number?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
};

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

type QuotePdfAttachment = {
  fileName: string;
  mimeType: 'application/pdf';
  bytes: Uint8Array;
  base64: string;
  sizeBytes: number;
  sha256: string;
};

type WorkflowHttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;

type RenderedEmailTemplate = {
  subject: string;
  html: string;
  text: string;
  templateKey?: string;
};

type PreparedQuoteEmailSend = {
  deliveryId: string;
  quoteId?: string;
};

type StoredQuotePdfSnapshot = {
  provider: 'r2' | 'database';
  key: string | null;
  shouldStoreBase64InDatabase: boolean;
};

type CompletedQuoteEmailSend = {
  delivery?: unknown;
  quote?: unknown;
  version?: unknown;
};

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

const QUOTE_PUBLIC_BASE_URL =
  Deno.env.get('QUOTE_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '';

const QUOTE_TOKEN_TTL_DAYS = parsePositiveInt(
  Deno.env.get('QUOTE_TOKEN_TTL_DAYS'),
  30,
);

const QUOTE_PDF_MAX_ATTACHMENT_BYTES = parsePositiveInt(
  Deno.env.get('QUOTE_PDF_MAX_ATTACHMENT_BYTES'),
  8 * 1024 * 1024,
);

// Private R2 storage for immutable quote PDF snapshots, via the Cloudflare
// Worker. Falls back to the shared invoice storage config so a single Worker +
// secret powers both flows. When neither is set, the PDF is stored as a base64
// database fallback so downloads keep working in local/dev.
const QUOTE_PDF_STORAGE_WORKER_URL = (
  Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');

const QUOTE_PDF_STORAGE_SECRET =
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  '';

const QUOTE_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('QUOTE_ALLOWED_ORIGINS'),
  Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'),
  Deno.env.get('QUOTE_PUBLIC_BASE_URL'),
  Deno.env.get('APP_PUBLIC_URL'),
]);

const QUOTE_ALLOW_LOCAL_DEV =
  (Deno.env.get('QUOTE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
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
  if (req.method === 'OPTIONS') {
    return json(req, { ok: true });
  }

  try {
    assertAllowedOrigin(req);

    if (req.method !== 'POST') {
      return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const quoteId = String(body.quoteId || '');

    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);
    // Service-role omzeilt RLS: modulerechten hier expliciet controleren.
    const financeLevel = await getModuleLevel(supabaseAdmin, user.id, organizationId, 'finance');
    if (financeLevel === 'none') {
      throw new WorkflowHttpError('Je hebt geen toegang tot de module Financiën in deze organisatie.', 403);
    }

    switch (action) {
      case 'sendQuoteEmail': {
        if (!['owner', 'admin', 'member'].includes(role) || financeLevel !== 'write') {
          throw new WorkflowHttpError(
            'Geen schrijfrechten voor deze organisatie.',
            403,
          );
        }

        const result = await sendQuoteEmail(
          user.id,
          organizationId,
          quoteId,
          body,
        );

        return json(req, { ok: true, ...result });
      }

      case 'downloadQuotePdf': {
        // Any organization member (including viewers) may download the stored
        // PDF. Reading does not mutate anything, so no write role is required.
        if (!isUuid(quoteId)) {
          throw new WorkflowHttpError('Ongeldige offerte.', 400);
        }

        // Confirm the quote belongs to this organization before returning bytes.
        await loadQuote(organizationId, quoteId);

        const pdf = await loadQuotePdfSnapshot(organizationId, quoteId);

        return json(req, { ok: true, pdf });
      }

      default:
        return json(
          req,
          { ok: false, error: `Onbekende quote workflow action: ${action}` },
          400,
        );
    }
  } catch (error) {
    const status = error instanceof WorkflowHttpError ? error.status : 500;
    const internalMessage =
      error instanceof Error ? error.message : 'Onbekende fout.';

    if (status >= 500) {
      console.error('quote-workflow error', internalMessage);
    }

    const publicMessage =
      error instanceof WorkflowHttpError
        ? error.message
        : 'Quote workflow-actie mislukt door een server- of providerfout. Controleer de Edge Function logs.';

    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendQuoteEmail(
  userId: string,
  organizationId: string,
  quoteId: string,
  body: Record<string, unknown>,
) {
  if (!RESEND_API_KEY) {
    throw new WorkflowHttpError(
      'RESEND_API_KEY ontbreekt in de Edge Function secrets.',
      500,
    );
  }

  if (!RESEND_FROM_EMAIL) {
    throw new WorkflowHttpError(
      'RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.',
      500,
    );
  }

  if (!QUOTE_PUBLIC_BASE_URL) {
    throw new WorkflowHttpError(
      'QUOTE_PUBLIC_BASE_URL of APP_PUBLIC_URL ontbreekt.',
      500,
    );
  }

  if (!isUuid(quoteId)) {
    throw new WorkflowHttpError('Ongeldige offerte.', 400);
  }

  const quote = await loadQuote(organizationId, quoteId);

  if (
    quote.status !== 'internally_approved' ||
    quote.internal_approval_status !== 'approved'
  ) {
    throw new WorkflowHttpError(
      'Alleen intern goedgekeurde offertes kunnen naar de klant worden verstuurd.',
      409,
    );
  }

  if (!quote.client_id) {
    throw new WorkflowHttpError('Deze offerte heeft geen klant gekoppeld.', 422);
  }

  if (isDateBeforeToday(quote.valid_until)) {
    throw new WorkflowHttpError(
      'Deze offerte is verlopen. Pas de geldigheidsdatum aan en doorloop de goedkeuringsflow opnieuw voordat je verstuurt.',
      409,
    );
  }

  const [client, project, company, content] = await Promise.all([
    loadClient(organizationId, quote.client_id),
    quote.project_id
      ? loadProject(organizationId, quote.project_id)
      : Promise.resolve(null),
    loadCompanySettings(organizationId),
    loadQuoteEmailContent(organizationId),
  ]);

  const recipientEmail = String(body.recipientEmail || client.email || '')
    .trim()
    .toLowerCase();

  const recipientName = String(
    body.recipientName || client.contact_name || client.name || '',
  ).trim();

  if (!isEmail(recipientEmail)) {
    throw new WorkflowHttpError(
      'Vul een geldig klant-e-mailadres in voordat je de offerte verstuurt.',
      422,
    );
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);

  const expiresAt = new Date(
    Date.now() + Math.max(1, QUOTE_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000,
  ).toISOString();

  const publicUrl = `${QUOTE_PUBLIC_BASE_URL.replace(/\/$/, '')}/quote/${encodeURIComponent(
    token,
  )}`;

  const renderedEmail = renderEmailTemplate('quote.sent', {
    quote,
    client,
    project,
    company,
    publicUrl,
    recipientName,
    expiresAt,
    content,
  }) as RenderedEmailTemplate;

  const subject = String(body.subject || renderedEmail.subject || '').trim();

  if (!subject) {
    throw new WorkflowHttpError(
      'Er kon geen onderwerp voor de offerte-e-mail worden bepaald.',
      500,
    );
  }

  const html = renderedEmail.html;
  const text = renderedEmail.text;
  const templateKey = renderedEmail.templateKey || 'quote_sent';

  const pdfAttachment = await createQuotePdfAttachment({
    quote,
    client,
    project,
    company,
    publicUrl,
  });

  validateQuotePdfAttachment(pdfAttachment);

  // Persist the exact PDF the client receives as an immutable snapshot. Uses
  // private R2 through the Cloudflare Worker when configured, otherwise a
  // base64 database fallback. Either way the quote PDF stays downloadable.
  const storedPdf = await storeQuotePdfSnapshot(organizationId, quoteId, pdfAttachment);

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
    html,
    text,
    attachments: [
      {
        filename: pdfAttachment.fileName,
        content: pdfAttachment.base64,
      },
    ],
    tags: [
      { name: 'organization_id', value: sanitizeTagValue(organizationId) },
      { name: 'quote_id', value: sanitizeTagValue(quoteId) },
      { name: 'quote_number', value: sanitizeTagValue(quote.number) },
      { name: 'template_key', value: sanitizeTagValue(templateKey) },
    ],
  };

  // Quotum per organisatie (20261101050000): één organisatie maakt het gedeelde Resend-account niet voor iedereen op.
  await takeEmailQuota(supabaseAdmin, organizationId, 1, (message, status) => new WorkflowHttpError(message, status));
  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': sanitizeIdempotencyKey(
        `quote-${quoteId}-${prepared.deliveryId}`,
      ),
    },
    body: JSON.stringify(resendPayload),
  });

  const resendResponsePayload = (await resendResponse.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!resendResponse.ok) {
    const errorMessage = String(
      resendResponsePayload.message ||
        resendResponsePayload.error ||
        resendResponse.statusText ||
        'Resend send failed',
    );

    console.error('Resend quote send failed', resendResponsePayload);

    await failQuoteEmailSend(
      prepared.deliveryId,
      organizationId,
      userId,
      errorMessage,
    );

    throw new WorkflowHttpError(
      `Resend kon de offerte-e-mail niet versturen: ${errorMessage}`,
      502,
    );
  }

  const providerEmailId = String(
    resendResponsePayload.id || resendResponsePayload.email_id || '',
  ).trim();

  if (!providerEmailId) {
    await failQuoteEmailSend(
      prepared.deliveryId,
      organizationId,
      userId,
      'Resend accepted the request but did not return a provider email id.',
    );

    throw new WorkflowHttpError(
      'Resend heeft de e-mail aangenomen, maar gaf geen e-mail-ID terug. De verzending is niet als definitief verzonden gemarkeerd.',
      502,
    );
  }

  const finalized = await completeQuoteEmailSend(
    prepared.deliveryId,
    organizationId,
    userId,
    providerEmailId,
  );

  return {
    delivery: finalized.delivery,
    version: finalized.version,
    publicUrl,
    providerEmailId,
    attachment: {
      fileName: pdfAttachment.fileName,
      sizeBytes: pdfAttachment.sizeBytes,
      sha256: pdfAttachment.sha256,
    },
  };
}

async function loadQuote(
  organizationId: string,
  quoteId: string,
): Promise<QuoteRow> {
  const { data, error } = await supabaseAdmin
    .from('quotes')
    .select('*')
    .eq('id', quoteId)
    .eq('organization_id', organizationId)
    .single();

  if (error || !data) {
    throw new WorkflowHttpError('Offerte niet gevonden.', 404);
  }

  return data as QuoteRow;
}

async function loadClient(
  organizationId: string,
  clientId: string,
): Promise<ClientRow> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email,phone,client_code,vat_number,kvk_number,address_line1,address_line2,postal_code,city,country')
    .eq('id', clientId)
    .eq('organization_id', organizationId)
    .single();

  if (error || !data) {
    throw new WorkflowHttpError('Klant niet gevonden.', 404);
  }

  return data as ClientRow;
}

async function loadProject(
  organizationId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id,name,description')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as ProjectRow | null;
}

async function loadCompanySettings(
  organizationId: string,
): Promise<CompanySettingsRow | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select(
      'company_name,trade_name,address_line1,address_line2,postal_code,city,country,email,phone,website,kvk_number,vat_number,iban,invoice_payment_terms,invoice_footer,invoice_accent_color',
    )
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as CompanySettingsRow | null;
}

// Per-organisatie aanpasbare offerte-mailtekst. Geeft null terug als er geen
// aangepaste regel is — de template valt dan terug op de standaardtekst. Een
// lookup-fout is niet fataal: de offerte moet altijd verstuurd kunnen worden.
async function loadQuoteEmailContent(organizationId: string): Promise<EmailTemplateContent | null> {
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .eq('template_key', 'quote.sent')
    .maybeSingle();
  if (error) {
    console.warn('email_templates lookup mislukte', error.message);
    return null;
  }
  if (!data) return null;
  const row = data as { enabled: boolean; subject: string | null; intro: string | null; closing: string | null; cta_label: string | null };
  return { enabled: row.enabled, subject: row.subject, intro: row.intro, closing: row.closing, ctaLabel: row.cta_label };
}

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
  attachmentDataBase64?: string;
  attachmentStorageProvider?: string;
  attachmentStorageKey?: string;
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
    p_attachment_data_base64: input.attachmentDataBase64 ?? null,
    p_attachment_storage_provider: input.attachmentStorageProvider ?? null,
    p_attachment_storage_key: input.attachmentStorageKey ?? null,
  });

  if (error) {
    throw error;
  }

  const payload = data as PreparedQuoteEmailSend | null;

  if (!payload?.deliveryId) {
    throw new WorkflowHttpError(
      'Verzendpoging kon niet worden voorbereid.',
      500,
    );
  }

  return payload;
}

async function completeQuoteEmailSend(
  deliveryId: string,
  organizationId: string,
  userId: string,
  providerEmailId: string,
): Promise<CompletedQuoteEmailSend> {
  const { data, error } = await supabaseAdmin.rpc('complete_quote_email_send', {
    p_delivery_id: deliveryId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_provider_email_id: providerEmailId,
  });

  if (error) {
    throw error;
  }

  return (data ?? {}) as CompletedQuoteEmailSend;
}

async function failQuoteEmailSend(
  deliveryId: string,
  organizationId: string,
  userId: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('fail_quote_email_send', {
    p_delivery_id: deliveryId,
    p_organization_id: organizationId,
    p_actor_user_id: userId,
    p_error_message: errorMessage,
  });

  if (error) {
    console.warn('Quote email send failure registration failed', error.message);
  }
}

async function storeQuotePdfSnapshot(
  organizationId: string,
  quoteId: string,
  attachment: QuotePdfAttachment,
): Promise<StoredQuotePdfSnapshot> {
  const storageConfigured = Boolean(
    QUOTE_PDF_STORAGE_WORKER_URL && QUOTE_PDF_STORAGE_SECRET,
  );

  if (!storageConfigured) {
    // No private storage configured (e.g. local dev): keep the PDF as a base64
    // database fallback so it can still be downloaded later.
    return { provider: 'database', key: null, shouldStoreBase64InDatabase: true };
  }

  // Preserve the .pdf extension: sanitizeFileName() strips dots, which would
  // turn "...-OFF-2026-7612.pdf" into "...-OFF-2026-7612-pdf" and fail the
  // Worker's isPrivateQuoteSnapshotKey() check (it requires a trailing .pdf).
  const safeName = `${sanitizeFileName(attachment.fileName.replace(/\.pdf$/i, ''))}.pdf`;
  const key = `${organizationId}/quote-pdfs/${quoteId}/${crypto.randomUUID()}-${safeName}`;

  const response = await fetch(`${QUOTE_PDF_STORAGE_WORKER_URL}/internal/quote-snapshot`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${QUOTE_PDF_STORAGE_SECRET}`,
      'Content-Type': attachment.mimeType,
      'X-Storage-Key': key,
      'X-SHA256': attachment.sha256,
      'X-Size-Bytes': String(attachment.sizeBytes),
    },
    body: attachment.bytes,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    console.error('quote-workflow R2 snapshot upload failed', {
      status: response.status,
      message,
      key,
      organizationId,
      quoteId,
    });
    throw new WorkflowHttpError(
      `Offerte-PDF kon niet in private R2 storage worden opgeslagen: ${message || response.statusText}`,
      502,
    );
  }

  return { provider: 'r2', key, shouldStoreBase64InDatabase: false };
}

async function loadQuotePdfSnapshot(
  organizationId: string,
  quoteId: string,
): Promise<{ fileName: string; mimeType: string; base64: string; sizeBytes: number | null; sha256: string | null }> {
  const { data: versions, error } = await supabaseAdmin
    .from('quote_versions')
    .select(
      'snapshot_reason,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_data_base64,pdf_storage_provider,pdf_storage_key,created_at,version_number',
    )
    .eq('organization_id', organizationId)
    .eq('quote_id', quoteId)
    .not('pdf_file_name', 'is', null)
    .order('version_number', { ascending: false })
    .limit(20);

  if (error) {
    throw error;
  }

  const usableVersions = (versions || []).filter((candidate: Record<string, unknown>) => {
    const hasDatabasePdf = Boolean(String(candidate.pdf_data_base64 || '').trim());
    const hasPrivateStoragePdf =
      candidate.pdf_storage_provider === 'r2' && Boolean(candidate.pdf_storage_key);
    return hasDatabasePdf || hasPrivateStoragePdf;
  });

  // Prefer the version that was actually sent to the client; fall back to the
  // most recent usable snapshot.
  const version =
    usableVersions.find(
      (candidate: Record<string, unknown>) => candidate.snapshot_reason === 'sent_to_client',
    ) || usableVersions[0];

  if (!version) {
    throw new WorkflowHttpError(
      'Er is nog geen opgeslagen PDF-snapshot voor deze offerte. Verstuur de offerte eerst naar de klant.',
      404,
    );
  }

  let base64 = String(version.pdf_data_base64 || '').trim();

  if (!base64 && version.pdf_storage_provider === 'r2' && version.pdf_storage_key) {
    if (!QUOTE_PDF_STORAGE_WORKER_URL || !QUOTE_PDF_STORAGE_SECRET) {
      throw new WorkflowHttpError(
        'PDF-snapshot staat in private storage, maar de storage-koppeling ontbreekt in de Edge Function secrets.',
        500,
      );
    }

    const response = await fetch(
      `${QUOTE_PDF_STORAGE_WORKER_URL}/internal/quote-snapshot/${encodeURIComponent(
        String(version.pdf_storage_key),
      )}`,
      { headers: { Authorization: `Bearer ${QUOTE_PDF_STORAGE_SECRET}` } },
    );

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      console.error('quote-workflow R2 snapshot fetch failed', {
        status: response.status,
        message,
        key: version.pdf_storage_key,
        organizationId,
        quoteId,
      });
      throw new WorkflowHttpError(
        'PDF-snapshot kon niet uit private storage worden opgehaald.',
        502,
      );
    }

    base64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  if (!base64) {
    throw new WorkflowHttpError('PDF-snapshot ontbreekt of is niet beschikbaar.', 404);
  }

  return {
    fileName: String(version.pdf_file_name || `offerte-${quoteId}.pdf`),
    mimeType: String(version.pdf_mime_type || 'application/pdf'),
    sizeBytes: (version.pdf_size_bytes as number | null) ?? null,
    sha256: (version.pdf_sha256 as string | null) ?? null,
    base64,
  };
}

async function createQuotePdfAttachment(input: {
  quote: QuoteRow;
  client: ClientRow;
  project: ProjectRow | null;
  company: CompanySettingsRow | null;
  publicUrl: string;
}): Promise<QuotePdfAttachment> {
  const { quote, client, project, company, publicUrl } = input;
  const lines = Array.isArray(quote.lines) ? quote.lines : [];

  // Getekend met de opmaak, het logo en het briefpapier van de organisatie,
  // met dezelfde code als het voorbeeld in de app (_shared/documentLayout.ts).
  // Tot november 2026 stond hier een eigen vaste opmaak: zonder logo, zonder
  // klantadres, met de btw als één bedrag in plaats van per tarief, en met
  // KvK en btw-nummer die onderaan de afzender wegvielen.
  const [design, vatCodes] = await Promise.all([
    loadDocumentDesign(supabaseAdmin, quote.organization_id),
    loadVatCodeInfo(quote.organization_id),
  ]);
  // Bij btw verlegd of ICP hoort de reden er ook op de offerte bij: dan weet
  // de klant vooraf waarom er geen btw op staat.
  const vatNotes = invoiceVatNotes(lines, vatCodes);

  const bytes = await renderSalesDocumentPdf({
    kind: 'quote',
    design,
    company,
    client,
    number: quote.number || quote.id,
    date: quote.date,
    secondDate: quote.valid_until,
    lines,
    vatNotes: vatNotes.notes,
    notes: quote.notes,
    projectName: project?.name ?? null,
    onlineLink: publicUrl ? { label: 'Bekijk en keur deze offerte online goed:', url: publicUrl } : null,
  });
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

// Soort en rubriek per btw-code, voor de verplichte vermeldingen op de pdf.
// Fail-open: zonder btw-codes geen vermeldingen, maar wel een offerte.
async function loadVatCodeInfo(organizationId: string): Promise<Record<string, VatCodeInfo>> {
  const { data, error } = await supabaseAdmin
    .from('vat_codes')
    .select('code,kind,sales_box')
    .eq('organization_id', organizationId);
  if (error) {
    console.warn('vat_codes lookup voor de offerte-pdf mislukte:', error.message);
    return {};
  }
  const byCode: Record<string, VatCodeInfo> = {};
  for (const row of (data ?? []) as Array<{ code: string; kind: string; sales_box: string | null }>) {
    byCode[String(row.code)] = { kind: String(row.kind), salesBox: row.sales_box ?? null };
  }
  return byCode;
}

function validateQuotePdfAttachment(attachment: QuotePdfAttachment): void {
  if (attachment.mimeType !== 'application/pdf') {
    throw new WorkflowHttpError(
      'De gegenereerde offertebijlage is geen PDF.',
      500,
    );
  }

  if (!attachment.fileName.toLowerCase().endsWith('.pdf')) {
    throw new WorkflowHttpError(
      'De gegenereerde offertebijlage heeft geen PDF-bestandsnaam.',
      500,
    );
  }

  if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes <= 0) {
    throw new WorkflowHttpError('De gegenereerde offerte-PDF is leeg.', 500);
  }

  if (attachment.sizeBytes > QUOTE_PDF_MAX_ATTACHMENT_BYTES) {
    throw new WorkflowHttpError(
      `De offerte-PDF is te groot om als e-mailbijlage te versturen (${Math.ceil(
        attachment.sizeBytes / 1024 / 1024,
      )} MB).`,
      422,
    );
  }

  if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
    throw new WorkflowHttpError(
      'De offerte-PDF kon niet betrouwbaar worden gehasht.',
      500,
    );
  }
}

function sanitizeFileName(value: string): string {
  return (
    value
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'offerte'
  );
}

function sanitizeTagValue(value: unknown): string {
  return (
    String(value ?? '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 256) || 'quote'
  );
}

function sanitizeIdempotencyKey(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 256) || crypto.randomUUID()
  );
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

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoaUrlBytes(bytes);
}

function btoaUrlBytes(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedOrigins(values: Array<string | null>): string[] {
  const origins = new Set<string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');

      if (!part) {
        continue;
      }

      if (part.startsWith('http://') || part.startsWith('https://')) {
        try {
          origins.add(new URL(part).origin);
        } catch {
          origins.add(part);
        }
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
    QUOTE_ALLOWED_ORIGINS.includes(origin) ||
    (QUOTE_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
      ? origin
      : QUOTE_ALLOW_LOCAL_DEV && !origin
        ? '*'
        : '';

  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
    },
  });
}

function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  // Een pagina zonder herkomst (sandbox-iframe, data:, file:) is nooit de app.
  if (origin === 'null') throw new WorkflowHttpError('Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.', 403);

  if (!origin && QUOTE_ALLOW_LOCAL_DEV) {
    return;
  }

  if (QUOTE_ALLOWED_ORIGINS.includes(origin)) {
    return;
  }

  if (QUOTE_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) {
    return;
  }

  if (QUOTE_ALLOWED_ORIGINS.length === 0 && QUOTE_ALLOW_LOCAL_DEV) {
    return;
  }

  if (QUOTE_ALLOWED_ORIGINS.length === 0) {
    throw new WorkflowHttpError(
      'QUOTE_ALLOWED_ORIGINS, MAIL_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.',
      500,
    );
  }

  throw new WorkflowHttpError(
    'Deze frontend-origin is niet toegestaan voor quote workflow-acties.',
    403,
  );
}

function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}

async function requireUser(
  req: Request,
): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token) {
    throw new WorkflowHttpError(
      'Niet ingelogd: Authorization header ontbreekt.',
      401,
    );
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    throw new WorkflowHttpError(
      'Niet ingelogd of ongeldig sessietoken.',
      401,
    );
  }

  return {
    id: data.user.id,
    email: data.user.email || undefined,
  };
}

async function requireOrganizationAccess(
  userId: string,
  organizationId: string,
): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) {
    throw new WorkflowHttpError('Ongeldige organisatie.', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);

  if (error) {
    throw error;
  }

  const role = data?.[0]?.role as OrganizationRole | undefined;

  if (!role) {
    throw new WorkflowHttpError('Geen toegang tot deze organisatie.', 403);
  }

  return role;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isDateBeforeToday(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const parsed = Date.parse(`${value}T23:59:59`);

  if (!Number.isFinite(parsed)) {
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return parsed < today.getTime();
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}