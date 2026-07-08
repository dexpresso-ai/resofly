import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { renderEmailLayout, escapeHtml } from '../_shared/emailTemplates/layout.ts';
import {
  sendViaResend,
  resendEmailId,
  sanitizeTagValue,
  sanitizeIdempotencyPart,
  extractEmailAddress,
  extractDisplayName,
  htmlToText,
} from '../_shared/resend.ts';
import { makeUnsubscribeToken } from '../_shared/unsubscribe.ts';

// ============================================================================
// ResoFly — Campagnes / e-mailmarketing (Edge Function)
//
// Twee soorten aanroepen:
//  1. App-acties (ingelogde organisatieleden): previewAudience, sendTestCampaign,
//     sendCampaign, scheduleCampaign, pause/resume/cancelCampaign. Auth via
//     requireUser() + requireOrganizationAccess() — identiek aan `mail`.
//  2. Cron (?cron=dispatch): batchverzending, geauthenticeerd via het gedeelde
//     CAMPAIGN_CRON_SECRET (x-cron-secret), net als de factuurherinnering-cron.
//
// Elke verzending schrijft een gewone outbound-rij in client_emails (met een
// campaign_recipient_id in metadata) zodat de bestaande resend-webhook +
// mail-inbound de tracking/antwoorden vullen; DB-triggers spiegelen dat naar de
// campagne-ontvanger. Campagne- en suppressie-CRUD loopt via RLS in de frontend;
// deze functie doet uitsluitend wat de service-role vereist (verzenden + rijen
// materialiseren).
// ============================================================================

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const MAIL_INBOUND_DOMAIN = (Deno.env.get('MAIL_INBOUND_DOMAIN') || '').trim().toLowerCase();

const CAMPAIGN_CRON_SECRET = Deno.env.get('CAMPAIGN_CRON_SECRET') || '';
const UNSUBSCRIBE_SECRET = Deno.env.get('UNSUBSCRIBE_SECRET') || '';
// Publieke basis-URL van de afmeldfunctie (Supabase functions-endpoint).
const UNSUBSCRIBE_BASE_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/email-unsubscribe`;

// Hoeveel ontvangers per campagne per tick/aanroep worden verstuurd.
const DISPATCH_BATCH = Number(Deno.env.get('CAMPAIGN_DISPATCH_BATCH') || '100') || 100;

const MAIL_ALLOWED_ORIGINS = (
  Deno.env.get('MAIL_ALLOWED_ORIGINS') ||
  Deno.env.get('QUOTE_ALLOWED_ORIGINS') ||
  Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') ||
  ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const MAIL_ALLOW_LOCAL_DEV = (Deno.env.get('MAIL_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class CampaignHttpError extends Error {
  status: HttpStatus;
  constructor(message: string, status: HttpStatus = 400) {
    super(message);
    this.name = 'CampaignHttpError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return json(req, { ok: true });
  }

  // ── Cron-pad (geen Supabase JWT, geen Origin) ──
  const url = new URL(req.url);
  const cron = url.searchParams.get('cron');
  if (cron) {
    try {
      if (req.method !== 'POST') {
        return json(req, { ok: false, error: 'Method not allowed.' }, 405);
      }
      assertCronSecret(req);
      if (cron === 'dispatch') {
        const result = await handleCampaignDispatch();
        return json(req, { ok: true, ...result });
      }
      return json(req, { ok: false, error: `Onbekende cron: ${cron}` }, 400);
    } catch (error) {
      const status = error instanceof CampaignHttpError ? error.status : 500;
      if (status >= 500) console.error('campaigns cron error', error instanceof Error ? error.message : error);
      const message = error instanceof CampaignHttpError ? error.message : 'Cronverwerking mislukt.';
      return json(req, { ok: false, error: message }, status);
    }
  }

  // ── App-pad (ingelogde organisatieleden) ──
  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') {
      return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');

    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    switch (action) {
      case 'previewAudience': {
        // Alleen lezen — elk lid mag een telling opvragen.
        const audience = (body.audience || {}) as Record<string, unknown>;
        const preview = await previewAudience(organizationId, audience);
        return json(req, { ok: true, ...preview });
      }
      case 'sendTestCampaign': {
        requireWrite(role);
        const result = await sendTestCampaign(organizationId, body);
        return json(req, { ok: true, ...result });
      }
      case 'sendCampaign': {
        requireWrite(role);
        const result = await sendCampaign(organizationId, String(body.campaignId || ''));
        return json(req, { ok: true, ...result });
      }
      case 'scheduleCampaign': {
        requireWrite(role);
        const result = await scheduleCampaign(organizationId, String(body.campaignId || ''), body.scheduledAt);
        return json(req, { ok: true, ...result });
      }
      case 'pauseCampaign': {
        requireWrite(role);
        const result = await setCampaignStatus(organizationId, String(body.campaignId || ''), 'paused', ['sending', 'scheduled']);
        return json(req, { ok: true, ...result });
      }
      case 'resumeCampaign': {
        requireWrite(role);
        const result = await setCampaignStatus(organizationId, String(body.campaignId || ''), 'sending', ['paused']);
        return json(req, { ok: true, ...result });
      }
      case 'cancelCampaign': {
        requireWrite(role);
        const result = await setCampaignStatus(organizationId, String(body.campaignId || ''), 'cancelled', ['draft', 'scheduled', 'sending', 'paused']);
        return json(req, { ok: true, ...result });
      }
      default:
        return json(req, { ok: false, error: `Onbekende campaigns action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof CampaignHttpError ? error.status : 500;
    const internalMessage = error instanceof Error ? error.message : 'Onbekende fout.';
    if (status >= 500) console.error('campaigns function error', internalMessage);
    const publicMessage = error instanceof CampaignHttpError
      ? error.message
      : 'Campagne-actie mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

// ── Doelgroep-resolutie ─────────────────────────────────────────────────────

type Candidate = { clientId: string | null; contactId: string | null; email: string; name: string | null };

type AudienceSpec = {
  mode: 'filter' | 'manual';
  statuses: string[];
  tags: string[];
  includeContacts: boolean;
  manualClientIds: string[];
};

function parseAudience(raw: Record<string, unknown>): AudienceSpec {
  const mode = raw.mode === 'manual' ? 'manual' : 'filter';
  const statuses = Array.isArray(raw.statuses) ? raw.statuses.map((v) => String(v)) : [];
  const tags = Array.isArray(raw.tags) ? raw.tags.map((v) => String(v)) : [];
  const manualClientIds = Array.isArray(raw.manualClientIds)
    ? raw.manualClientIds.map((v) => String(v)).filter((v) => isUuid(v))
    : [];
  const includeContacts = raw.includeContacts === true;
  return { mode, statuses, tags, includeContacts, manualClientIds };
}

type ClientRow = { id: string; name: string; contact_name: string | null; email: string | null; status: string; tags: string[] | null };

async function resolveAudience(
  organizationId: string,
  audienceRaw: Record<string, unknown>,
): Promise<{ candidates: Candidate[]; matchedClients: number; clientsWithoutEmail: number; suppressed: Set<string> }> {
  const audience = parseAudience(audienceRaw);

  const allClients = await loadAllClients(organizationId);
  const manualSet = new Set(audience.manualClientIds);

  const matched = allClients.filter((c) => {
    if (audience.mode === 'manual') return manualSet.has(c.id);
    const statusOk = audience.statuses.length === 0 || audience.statuses.includes(c.status);
    const tagsOk =
      audience.tags.length === 0 ||
      (Array.isArray(c.tags) && c.tags.some((t) => audience.tags.includes(t)));
    return statusOk && tagsOk;
  });

  const matchedIds = matched.map((c) => c.id);

  // Contactpersonen ophalen (optioneel).
  const contactsByClient = new Map<string, { id: string; name: string | null; email: string }[]>();
  if (audience.includeContacts && matchedIds.length > 0) {
    for (const idChunk of chunk(matchedIds, 200)) {
      const { data: contacts, error: contactError } = await supabaseAdmin
        .from('client_contacts')
        .select('id,client_id,name,email')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .in('client_id', idChunk);
      if (contactError) throw contactError;
      for (const row of (contacts || []) as { id: string; client_id: string; name: string | null; email: string }[]) {
        const list = contactsByClient.get(row.client_id) || [];
        list.push({ id: row.id, name: row.name, email: row.email });
        contactsByClient.set(row.client_id, list);
      }
    }
  }

  // Kandidaten bouwen (klant-eigen adres eerst, dan contacten), dedupe op e-mail.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let clientsWithoutEmail = 0;

  for (const c of matched) {
    let reachable = false;
    const ownEmail = normalizeEmail(c.email);
    if (isEmail(ownEmail)) {
      reachable = true;
      if (!seen.has(ownEmail)) {
        seen.add(ownEmail);
        candidates.push({ clientId: c.id, contactId: null, email: ownEmail, name: c.contact_name || c.name || null });
      }
    }
    for (const contact of contactsByClient.get(c.id) || []) {
      const email = normalizeEmail(contact.email);
      if (!isEmail(email)) continue;
      reachable = true;
      if (!seen.has(email)) {
        seen.add(email);
        candidates.push({ clientId: c.id, contactId: contact.id, email, name: contact.name || c.name || null });
      }
    }
    if (!reachable) clientsWithoutEmail += 1;
  }

  // Suppressielijst — bevraag alleen de kandidaat-adressen (chunked), zodat de
  // correctheid niet afhangt van de PostgREST-rijlimiet bij grote suppressielijsten.
  const suppressed = await loadSuppressedFor(organizationId, candidates.map((c) => c.email));

  return { candidates, matchedClients: matched.length, clientsWithoutEmail, suppressed };
}

/** Alle klanten van een organisatie, gepagineerd (voorbij de PostgREST-rijlimiet). */
async function loadAllClients(organizationId: string): Promise<ClientRow[]> {
  const pageSize = 1000;
  const out: ClientRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id,name,contact_name,email,status,tags')
      .eq('organization_id', organizationId)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data || []) as ClientRow[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/** Set van gesuppresseerde adressen onder de opgegeven kandidaat-e-mails. */
async function loadSuppressedFor(organizationId: string, emails: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  const unique = [...new Set(emails.map((e) => normalizeEmail(e)).filter(Boolean))];
  for (const emailChunk of chunk(unique, 200)) {
    const { data, error } = await supabaseAdmin
      .from('email_suppressions')
      .select('email')
      .eq('organization_id', organizationId)
      .in('email', emailChunk);
    if (error) throw error;
    for (const row of (data || []) as { email: string }[]) suppressed.add(normalizeEmail(row.email));
  }
  return suppressed;
}

async function previewAudience(
  organizationId: string,
  audienceRaw: Record<string, unknown>,
): Promise<{ total: number; sendable: number; suppressed: number; withoutEmail: number; matchedClients: number; sample: { email: string; name: string | null }[] }> {
  const { candidates, matchedClients, clientsWithoutEmail, suppressed } = await resolveAudience(organizationId, audienceRaw);
  const sendable = candidates.filter((c) => !suppressed.has(c.email));
  return {
    total: candidates.length,
    sendable: sendable.length,
    suppressed: candidates.length - sendable.length,
    withoutEmail: clientsWithoutEmail,
    matchedClients,
    sample: sendable.slice(0, 20).map((c) => ({ email: c.email, name: c.name })),
  };
}

// ── Campagne verzenden ──────────────────────────────────────────────────────

type CampaignRow = {
  id: string;
  organization_id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  body_text: string | null;
  accent_color: string | null;
  audience: Record<string, unknown> | null;
  status: string;
  scheduled_at: string | null;
};

const CAMPAIGN_COLUMNS =
  'id,organization_id,name,subject,preheader,body_html,body_text,accent_color,audience,status,scheduled_at';

async function loadCampaign(organizationId: string, campaignId: string): Promise<CampaignRow> {
  if (!isUuid(campaignId)) throw new CampaignHttpError('Ongeldige campagne.', 400);
  const { data, error } = await supabaseAdmin
    .from('email_campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CampaignHttpError('Campagne niet gevonden.', 404);
  return data as CampaignRow;
}

async function sendTestCampaign(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  requireResendConfigured();
  requireUnsubscribeConfigured();
  const campaign = await loadCampaign(organizationId, String(body.campaignId || ''));
  const recipientEmail = normalizeEmail(body.testEmail);
  if (!isEmail(recipientEmail)) throw new CampaignHttpError('Vul een geldig test-e-mailadres in.', 422);
  if (!campaign.subject.trim()) throw new CampaignHttpError('De campagne heeft nog geen onderwerp.', 422);

  const brandName = await loadOrgBrand(organizationId);
  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  if (!sender.from) throw new CampaignHttpError('Er is nog geen afzenderadres geconfigureerd (verzenddomein of RESEND_FROM_EMAIL).', 422);

  const unsubToken = await makeUnsubscribeToken(UNSUBSCRIBE_SECRET, organizationId, recipientEmail);
  const html = buildCampaignHtml(campaign, brandName, unsubToken);
  const text = campaign.body_text || htmlToText(campaign.body_html);

  const payload = await sendViaResend(
    RESEND_API_KEY,
    {
      from: sender.from,
      to: [recipientEmail],
      reply_to: sender.replyTo,
      subject: `[TEST] ${campaign.subject}`,
      html,
      text,
    },
    `campaign-test-${sanitizeIdempotencyPart(campaign.id)}-${crypto.randomUUID()}`,
  );
  return { providerEmailId: resendEmailId(payload), recipientEmail };
}

async function scheduleCampaign(
  organizationId: string,
  campaignId: string,
  scheduledAtRaw: unknown,
): Promise<{ campaignId: string; scheduledAt: string }> {
  const campaign = await loadCampaign(organizationId, campaignId);
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    throw new CampaignHttpError('Deze campagne kan niet meer worden ingepland.', 409);
  }
  const time = Date.parse(String(scheduledAtRaw || ''));
  if (!Number.isFinite(time)) throw new CampaignHttpError('Ongeldig verzendmoment.', 422);
  const scheduledAt = new Date(time).toISOString();
  const { data, error } = await supabaseAdmin
    .from('email_campaigns')
    .update({ status: 'scheduled', scheduled_at: scheduledAt })
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .in('status', ['draft', 'scheduled'])
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new CampaignHttpError('De campagne is inmiddels gewijzigd; herlaad en probeer opnieuw.', 409);
  }
  return { campaignId, scheduledAt };
}

async function setCampaignStatus(
  organizationId: string,
  campaignId: string,
  status: string,
  allowedFrom: string[],
): Promise<{ campaignId: string; status: string }> {
  const campaign = await loadCampaign(organizationId, campaignId);
  if (!allowedFrom.includes(campaign.status)) {
    throw new CampaignHttpError(`Deze campagne kan niet van '${campaign.status}' naar '${status}'.`, 409);
  }
  const { data, error } = await supabaseAdmin
    .from('email_campaigns')
    .update({ status })
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .in('status', allowedFrom)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new CampaignHttpError('De campagne is inmiddels gewijzigd; herlaad en probeer opnieuw.', 409);
  }
  return { campaignId, status };
}

async function sendCampaign(
  organizationId: string,
  campaignId: string,
): Promise<{ campaignId: string; materialized: number; sent: number; failed: number; remaining: number }> {
  requireResendConfigured();
  requireUnsubscribeConfigured();
  const campaign = await loadCampaign(organizationId, campaignId);
  // Een gepauzeerde campagne wordt hervat via resumeCampaign (geen re-materialize);
  // alleen een concept of ingeplande campagne mag hier gestart worden.
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    throw new CampaignHttpError('Alleen een concept- of ingeplande campagne kan hier verstuurd worden.', 409);
  }

  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  if (!sender.from) {
    throw new CampaignHttpError('Er is nog geen afzenderadres geconfigureerd (verzenddomein of RESEND_FROM_EMAIL).', 422);
  }

  // Atomair de verzending claimen: alleen als de status intussen niet gewijzigd is.
  const { data: flipped, error: flipError } = await supabaseAdmin
    .from('email_campaigns')
    .update({ status: 'sending', started_at: new Date().toISOString(), scheduled_at: null })
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .in('status', ['draft', 'scheduled'])
    .select('id');
  if (flipError) throw flipError;
  if (!flipped || flipped.length === 0) {
    throw new CampaignHttpError('De campagne is inmiddels gewijzigd; herlaad en probeer opnieuw.', 409);
  }

  const materialized = await materializeRecipients(campaign);

  // Eerste batch meteen versturen voor directe feedback; de rest volgt via cron.
  const { sent, failed } = await dispatchCampaign({ ...campaign, status: 'sending' }, DISPATCH_BATCH);
  const remaining = await countPending(campaignId);
  if (remaining === 0) {
    await supabaseAdmin
      .from('email_campaigns')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', campaignId)
      .eq('organization_id', organizationId)
      .eq('status', 'sending');
  }
  return { campaignId, materialized, sent, failed, remaining };
}

async function materializeRecipients(campaign: CampaignRow): Promise<number> {
  const { candidates, suppressed } = await resolveAudience(campaign.organization_id, campaign.audience || {});
  const rows = candidates
    .filter((c) => !suppressed.has(c.email))
    .map((c) => ({
      organization_id: campaign.organization_id,
      campaign_id: campaign.id,
      client_id: c.clientId,
      contact_id: c.contactId,
      to_email: c.email,
      to_name: c.name,
      status: 'pending',
    }));

  let inserted = 0;
  for (const rowChunk of chunk(rows, 500)) {
    const { data, error } = await supabaseAdmin
      .from('email_campaign_recipients')
      .upsert(rowChunk, { onConflict: 'campaign_id,to_email', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;
    inserted += (data || []).length;
  }
  return inserted;
}

async function countPending(campaignId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('email_campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'sending']);
  if (error) throw error;
  return count || 0;
}

type RecipientRow = {
  id: string;
  organization_id: string;
  campaign_id: string;
  client_id: string | null;
  contact_id: string | null;
  to_email: string;
  to_name: string | null;
};

async function dispatchCampaign(campaign: CampaignRow, limit: number): Promise<{ sent: number; failed: number }> {
  const sender = await resolveSenderIdentity(supabaseAdmin, campaign.organization_id, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  if (!sender.from || !RESEND_API_KEY) {
    // Zonder afzender/API-key kunnen we niet versturen: pauzeer i.p.v. rijen te verbranden.
    await supabaseAdmin
      .from('email_campaigns')
      .update({ status: 'paused' })
      .eq('id', campaign.id)
      .eq('status', 'sending');
    return { sent: 0, failed: 0 };
  }

  const { data: claimed, error } = await supabaseAdmin.rpc('claim_campaign_recipients', {
    p_campaign_id: campaign.id,
    p_limit: limit,
  });
  if (error) throw error;

  const claimedRecipients = (claimed || []) as RecipientRow[];
  if (claimedRecipients.length === 0) return { sent: 0, failed: 0 };

  // Opt-out afdwingen op VERZENDMOMENT: adressen die ná materialiseren op de
  // suppressielijst kwamen (handmatig geblokkeerd, afgemeld, of gebounced) worden
  // hier alsnog overgeslagen — de materialize-check alleen is niet genoeg voor een
  // campagne die al aan het verzenden is.
  const suppressed = await loadSuppressedFor(campaign.organization_id, claimedRecipients.map((r) => r.to_email));
  const skipped = claimedRecipients.filter((r) => suppressed.has(normalizeEmail(r.to_email)));
  const recipients = claimedRecipients.filter((r) => !suppressed.has(normalizeEmail(r.to_email)));
  if (skipped.length > 0) {
    await supabaseAdmin
      .from('email_campaign_recipients')
      .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
      .in('id', skipped.map((r) => r.id));
  }
  if (recipients.length === 0) return { sent: 0, failed: 0 };

  const brandName = await loadOrgBrand(campaign.organization_id);
  const fromEmailForRow = sender.fromEmail || extractEmailAddress(sender.from);
  const fromNameForRow = extractDisplayName(sender.from);

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await sendToRecipient(campaign, recipient, sender.from, sender.replyTo, fromEmailForRow, fromNameForRow, brandName);
      sent += 1;
    } catch (sendError) {
      failed += 1;
      await supabaseAdmin
        .from('email_campaign_recipients')
        .update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          error_message: sendError instanceof Error ? sendError.message.slice(0, 1000) : 'Versturen mislukt.',
        })
        .eq('id', recipient.id);
    }
  }
  return { sent, failed };
}

async function sendToRecipient(
  campaign: CampaignRow,
  recipient: RecipientRow,
  from: string,
  senderReplyTo: string | undefined,
  fromEmailForRow: string,
  fromNameForRow: string | null,
  brandName: string,
): Promise<void> {
  const unsubToken = await makeUnsubscribeToken(UNSUBSCRIBE_SECRET, campaign.organization_id, recipient.to_email);
  const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}?token=${encodeURIComponent(unsubToken)}`;
  const html = buildCampaignHtml(campaign, brandName, unsubToken);
  const text = `${campaign.body_text || htmlToText(campaign.body_html)}\n\nAfmelden: ${unsubscribeUrl}`;

  let threadId: string | null = null;
  let clientEmailId: string | null = null;

  // Alleen loggen/threaden wanneer de klant nog bestaat (client_id NOT NULL vereist
  // in client_emails). Zonder client_id versturen we standalone, zonder tracking.
  if (recipient.client_id) {
    const { data: thread, error: threadError } = await supabaseAdmin
      .from('client_email_threads')
      .insert({
        organization_id: campaign.organization_id,
        client_id: recipient.client_id,
        subject: campaign.subject,
        last_direction: 'outbound',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (threadError) throw threadError;
    threadId = String(thread.id);

    const { data: emailRow, error: emailError } = await supabaseAdmin
      .from('client_emails')
      .insert({
        organization_id: campaign.organization_id,
        thread_id: threadId,
        client_id: recipient.client_id,
        created_by: null,
        direction: 'outbound',
        provider: 'resend',
        from_email: fromEmailForRow,
        from_name: fromNameForRow,
        to_email: recipient.to_email,
        subject: campaign.subject,
        body_html: campaign.body_html || null,
        body_text: text,
        status: 'queued',
        metadata: { source: 'campaign', campaign_id: campaign.id, campaign_recipient_id: recipient.id },
      })
      .select('id')
      .single();
    if (emailError) throw emailError;
    clientEmailId = String(emailRow.id);
  }

  const replyTo = MAIL_INBOUND_DOMAIN && clientEmailId
    ? `reply+${clientEmailId}@${MAIL_INBOUND_DOMAIN}`
    : (senderReplyTo || fromEmailForRow || undefined);

  let providerEmailId = '';
  try {
    const payload = await sendViaResend(
      RESEND_API_KEY,
      {
        from,
        to: [recipient.to_email],
        reply_to: replyTo,
        subject: campaign.subject,
        html,
        text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: [
          { name: 'organization_id', value: sanitizeTagValue(campaign.organization_id) },
          { name: 'campaign_id', value: sanitizeTagValue(campaign.id) },
          { name: 'campaign_recipient_id', value: sanitizeTagValue(recipient.id) },
        ],
      },
      `campaign-${sanitizeIdempotencyPart(recipient.id)}`,
    );
    providerEmailId = resendEmailId(payload);
  } catch (error) {
    if (clientEmailId) {
      const now = new Date().toISOString();
      await supabaseAdmin
        .from('client_emails')
        .update({ status: 'failed', failed_at: now, last_event_at: now, error_message: error instanceof Error ? error.message : 'Versturen mislukt.' })
        .eq('id', clientEmailId);
    }
    throw error;
  }

  const sentAt = new Date().toISOString();
  if (clientEmailId) {
    await supabaseAdmin
      .from('client_emails')
      .update({ status: 'sent', sent_at: sentAt, last_event_at: sentAt, provider_email_id: providerEmailId || null })
      .eq('id', clientEmailId);
    if (threadId) {
      await supabaseAdmin
        .from('client_email_threads')
        .update({ last_message_at: sentAt, last_direction: 'outbound' })
        .eq('id', threadId);
    }
  }

  await supabaseAdmin
    .from('email_campaign_recipients')
    .update({ status: 'sent', sent_at: sentAt, thread_id: threadId, client_email_id: clientEmailId })
    .eq('id', recipient.id);
}

function buildCampaignHtml(campaign: CampaignRow, brandName: string, unsubToken: string): string {
  const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}?token=${encodeURIComponent(unsubToken)}`;
  const footerHtml = `Je ontvangt deze e-mail omdat je klant bent bij ${escapeHtml(brandName)}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9b9ba7;text-decoration:underline;">Afmelden voor deze mails</a>.`;
  return renderEmailLayout({
    brandName,
    eyebrow: brandName,
    title: campaign.subject || brandName,
    preheader: campaign.preheader || undefined,
    introHtml: campaign.body_html || '',
    footerHtml,
    accentColor: campaign.accent_color,
  });
}

// ── Cron: dispatch ──────────────────────────────────────────────────────────

async function handleCampaignDispatch(): Promise<{ promoted: number; campaigns: number; sent: number; failed: number }> {
  const nowIso = new Date().toISOString();

  // 1. Ingeplande campagnes die nu 'due' zijn: materialiseren + op 'sending'.
  const { data: due, error: dueError } = await supabaseAdmin
    .from('email_campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .limit(10);
  if (dueError) throw dueError;

  let promoted = 0;
  for (const campaign of (due || []) as CampaignRow[]) {
    try {
      await materializeRecipients(campaign);
      await supabaseAdmin
        .from('email_campaigns')
        .update({ status: 'sending', started_at: nowIso, scheduled_at: null })
        .eq('id', campaign.id)
        .eq('status', 'scheduled');
      promoted += 1;
    } catch (error) {
      console.error('campaign schedule promote failed', campaign.id, error instanceof Error ? error.message : error);
    }
  }

  // 2. Verzendende campagnes: batch versturen.
  const { data: sending, error: sendingError } = await supabaseAdmin
    .from('email_campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('status', 'sending')
    .limit(20);
  if (sendingError) throw sendingError;

  let campaignsProcessed = 0;
  let sent = 0;
  let failed = 0;
  for (const campaign of (sending || []) as CampaignRow[]) {
    try {
      const result = await dispatchCampaign(campaign, DISPATCH_BATCH);
      sent += result.sent;
      failed += result.failed;
      campaignsProcessed += 1;
      const remaining = await countPending(campaign.id);
      if (remaining === 0) {
        await supabaseAdmin
          .from('email_campaigns')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', campaign.id)
          .eq('status', 'sending');
      }
    } catch (error) {
      console.error('campaign dispatch failed', campaign.id, error instanceof Error ? error.message : error);
    }
  }

  return { promoted, campaigns: campaignsProcessed, sent, failed };
}

// ── Kleine helpers ──────────────────────────────────────────────────────────

async function loadOrgBrand(organizationId: string): Promise<string> {
  const { data: company } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (company && (company.trade_name || company.company_name)) {
    return String(company.trade_name || company.company_name);
  }
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('name')
    .eq('id', organizationId)
    .maybeSingle();
  return String(org?.name || 'ResoFly');
}

function requireResendConfigured(): void {
  if (!RESEND_API_KEY) throw new CampaignHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
}

function requireUnsubscribeConfigured(): void {
  if (!UNSUBSCRIBE_SECRET) {
    throw new CampaignHttpError('UNSUBSCRIBE_SECRET ontbreekt; zonder werkende afmeldlink mag er geen marketingmail uit.', 500);
  }
}

function requireWrite(role: OrganizationRole): void {
  if (!['owner', 'admin', 'member'].includes(role)) {
    throw new CampaignHttpError('Je hebt geen rechten om campagnes te beheren.', 403);
  }
}

function assertCronSecret(req: Request): void {
  if (!CAMPAIGN_CRON_SECRET) {
    throw new CampaignHttpError('CAMPAIGN_CRON_SECRET ontbreekt in de Edge Function secrets.', 500);
  }
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, CAMPAIGN_CRON_SECRET)) {
    throw new CampaignHttpError('Ongeldig of ontbrekend cron-secret.', 401);
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ── CORS / auth (identiek patroon aan `mail`) ───────────────────────────────

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin =
    MAIL_ALLOWED_ORIGINS.includes(origin) || (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
      ? origin
      : MAIL_ALLOW_LOCAL_DEV && !origin
        ? '*'
        : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
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
  if (!origin && MAIL_ALLOW_LOCAL_DEV) return;
  if (MAIL_ALLOWED_ORIGINS.includes(origin)) return;
  if (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (MAIL_ALLOWED_ORIGINS.length === 0 && MAIL_ALLOW_LOCAL_DEV) return;
  if (MAIL_ALLOWED_ORIGINS.length === 0) {
    throw new CampaignHttpError('MAIL_ALLOWED_ORIGINS of QUOTE_ALLOWED_ORIGINS is verplicht in productie.', 500);
  }
  throw new CampaignHttpError('Deze frontend-origin is niet toegestaan voor campagne-acties.', 403);
}

async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new CampaignHttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new CampaignHttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new CampaignHttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new CampaignHttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
