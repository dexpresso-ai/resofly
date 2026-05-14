import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_WEBHOOK_SIGNING_SECRET = Deno.env.get('RESEND_WEBHOOK_SIGNING_SECRET') || '';
const RESEND_WEBHOOK_ALLOW_UNSIGNED = (Deno.env.get('RESEND_WEBHOOK_ALLOW_UNSIGNED') || 'false').toLowerCase() === 'true';
const RESEND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = Number(Deno.env.get('RESEND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS') || '300');

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const rawBody = await req.text();
  try {
    if (!RESEND_WEBHOOK_SIGNING_SECRET && !RESEND_WEBHOOK_ALLOW_UNSIGNED) {
      throw new Error('RESEND_WEBHOOK_SIGNING_SECRET ontbreekt. Zet RESEND_WEBHOOK_ALLOW_UNSIGNED=true alleen lokaal tijdens testen.');
    }
    if (RESEND_WEBHOOK_SIGNING_SECRET) await verifySvixSignature(req, rawBody, RESEND_WEBHOOK_SIGNING_SECRET);
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    await handleResendEvent(req, payload);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook error';
    console.error('resend-webhook error', message);
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
});

async function handleResendEvent(req: Request, payload: Record<string, unknown>) {
  const type = String(payload.type || payload.event || '');
  const createdAt = String(payload.created_at || payload.createdAt || new Date().toISOString());
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
  const providerEmailId = String(data.email_id || data.id || payload.email_id || '');
  const providerEventId = req.headers.get('svix-id') || String(payload.id || `${providerEmailId}:${type}:${createdAt}`);
  if (!type || !providerEmailId) throw new Error('Resend webhook mist type of email id.');

  const delivery = await findDelivery(providerEmailId);
  if (!delivery) {
    console.warn('No quote_email_delivery found for Resend email id', providerEmailId);
    return;
  }

  const eventType = normalizeEventType(type);
  const occurredAt = parseDate(createdAt) || new Date().toISOString();

  const { error: eventError } = await supabaseAdmin
    .from('quote_email_events')
    .insert({
      organization_id: delivery.organization_id,
      quote_id: delivery.quote_id,
      delivery_id: delivery.id,
      provider: 'resend',
      provider_event_id: providerEventId,
      provider_email_id: providerEmailId,
      event_type: type,
      payload,
      occurred_at: occurredAt,
    });
  if (eventError && !/duplicate key/i.test(eventError.message)) throw eventError;
  if (eventError && /duplicate key/i.test(eventError.message)) return;

  const nextDeliveryStatus = strongestEmailStatus(String(delivery.status || 'queued'), eventType);
  const deliveryPatch: Record<string, unknown> = {
    status: nextDeliveryStatus,
    last_event_at: maxIso(delivery.last_event_at, occurredAt),
    updated_at: new Date().toISOString(),
  };
  if (eventType === 'sent') deliveryPatch.sent_at = maxIso(delivery.sent_at, occurredAt);
  if (eventType === 'delivered') deliveryPatch.delivered_at = maxIso(delivery.delivered_at, occurredAt);
  if (eventType === 'opened') deliveryPatch.opened_at = maxIso(delivery.opened_at, occurredAt);
  if (eventType === 'clicked') deliveryPatch.clicked_at = maxIso(delivery.clicked_at, occurredAt);
  if (eventType === 'bounced') deliveryPatch.bounced_at = maxIso(delivery.bounced_at, occurredAt);
  if (eventType === 'failed') deliveryPatch.failed_at = maxIso(delivery.failed_at, occurredAt);
  if (eventType === 'complained') deliveryPatch.complained_at = maxIso(delivery.complained_at, occurredAt);
  if (eventType === 'failed' || eventType === 'bounced' || eventType === 'complained') deliveryPatch.error_message = String(data.reason || data.error || data.message || type);

  const { error: deliveryError } = await supabaseAdmin
    .from('quote_email_deliveries')
    .update(deliveryPatch)
    .eq('id', delivery.id);
  if (deliveryError) throw deliveryError;

  const quoteSummary = await loadQuoteEmailSummary(delivery.organization_id, delivery.quote_id);
  const isCurrentQuoteEmail = quoteSummary?.resend_last_email_id === providerEmailId;
  if (isCurrentQuoteEmail) {
    const nextQuoteStatus = strongestEmailStatus(String(quoteSummary?.last_email_delivery_status || 'queued'), eventType);
    const quotePatch: Record<string, unknown> = { last_email_delivery_status: nextQuoteStatus, updated_at: new Date().toISOString() };
    if (eventType === 'delivered') quotePatch.last_email_delivery_at = maxIso(quoteSummary?.last_email_delivery_at, occurredAt);
    if (eventType === 'opened') quotePatch.last_email_opened_at = maxIso(quoteSummary?.last_email_opened_at, occurredAt);
    if (eventType === 'clicked') quotePatch.last_email_clicked_at = maxIso(quoteSummary?.last_email_clicked_at, occurredAt);
    if (eventType === 'failed' || eventType === 'bounced' || eventType === 'complained') quotePatch.last_email_failed_at = maxIso(quoteSummary?.last_email_failed_at, occurredAt);
    const { error: quoteError } = await supabaseAdmin
      .from('quotes')
      .update(quotePatch)
      .eq('id', delivery.quote_id)
      .eq('organization_id', delivery.organization_id);
    if (quoteError) throw quoteError;
  }

  const timelineType = `email_${eventType}`;
  const title = eventTitle(eventType);
  await insertQuoteWorkflowEvent(delivery.organization_id, delivery.quote_id, null, timelineType, title, null, { providerEmailId, providerEventId });
  if (eventType === 'delivered') await insertQuoteAuditEvent(delivery.organization_id, delivery.quote_id, null, 'quote_email_delivered', delivery.subject, { providerEmailId });
  if (eventType === 'failed' || eventType === 'bounced' || eventType === 'complained') await insertQuoteAuditEvent(delivery.organization_id, delivery.quote_id, null, 'quote_email_failed', delivery.subject, { providerEmailId, eventType });
}

async function findDelivery(providerEmailId: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from('quote_email_deliveries')
    .select('id,organization_id,quote_id,subject,status,sent_at,delivered_at,opened_at,clicked_at,bounced_at,failed_at,complained_at,last_event_at')
    .eq('provider', 'resend')
    .eq('provider_email_id', providerEmailId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadQuoteEmailSummary(organizationId: string, quoteId: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from('quotes')
    .select('id,resend_last_email_id,last_email_delivery_status,last_email_delivery_at,last_email_opened_at,last_email_clicked_at,last_email_failed_at')
    .eq('organization_id', organizationId)
    .eq('id', quoteId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

function normalizeEventType(type: string): string {
  const short = type.replace(/^email\./, '');
  if (short === 'sent') return 'sent';
  if (short === 'delivered') return 'delivered';
  if (short === 'opened') return 'opened';
  if (short === 'clicked') return 'clicked';
  if (short === 'bounced') return 'bounced';
  if (short === 'complained') return 'complained';
  if (short === 'failed') return 'failed';
  return 'sent';
}

const EMAIL_STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 5,
  failed: 5,
  complained: 6,
};

function strongestEmailStatus(currentStatus: string, incomingStatus: string): string {
  const currentRank = EMAIL_STATUS_RANK[currentStatus] ?? 0;
  const incomingRank = EMAIL_STATUS_RANK[incomingStatus] ?? 0;
  return incomingRank >= currentRank ? incomingStatus : currentStatus;
}

function maxIso(currentValue: string | null | undefined, incomingValue: string): string {
  if (!currentValue) return incomingValue;
  const currentTime = Date.parse(currentValue);
  const incomingTime = Date.parse(incomingValue);
  if (!Number.isFinite(currentTime)) return incomingValue;
  if (!Number.isFinite(incomingTime)) return currentValue;
  return incomingTime >= currentTime ? incomingValue : currentValue;
}

function eventTitle(eventType: string): string {
  const labels: Record<string, string> = {
    sent: 'E-mail geaccepteerd door Resend',
    delivered: 'E-mail afgeleverd bij klant',
    opened: 'Klant opende de e-mail',
    clicked: 'Klant klikte op de offertelink',
    bounced: 'E-mail bounced',
    failed: 'E-mail verzenden mislukt',
    complained: 'Klant markeerde e-mail als spam',
  };
  return labels[eventType] || `Resend event: ${eventType}`;
}

async function insertQuoteWorkflowEvent(organizationId: string, quoteId: string, actorUserId: string | null, eventType: string, title: string, description?: string | null, metadata: Record<string, unknown> = {}) {
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

async function verifySvixSignature(req: Request, rawBody: string, secret: string): Promise<void> {
  const id = req.headers.get('svix-id') || '';
  const timestamp = req.headers.get('svix-timestamp') || '';
  const signature = req.headers.get('svix-signature') || '';
  if (!id || !timestamp || !signature) throw new Error('Webhook signature headers ontbreken.');
  assertFreshWebhookTimestamp(timestamp);

  const signedPayload = `${id}.${timestamp}.${rawBody}`;
  const secretBytes = decodeSvixSecret(secret);
  const secretBuffer = new Uint8Array(secretBytes).buffer;
  const key = await crypto.subtle.importKey('raw', secretBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = btoaBytes(new Uint8Array(mac));
  const provided = signature.split(' ').flatMap(part => part.split(',')).map(part => part.trim()).filter(Boolean).map(part => part.replace(/^v1,?/, ''));
  if (!provided.some(value => timingSafeEqual(value, expected))) throw new Error('Webhook signature ongeldig.');
}

function assertFreshWebhookTimestamp(timestamp: string): void {
  const raw = Number(timestamp);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error('Webhook timestamp ongeldig.');
  const timestampMs = raw > 10_000_000_000 ? raw : raw * 1000;
  const ageSeconds = Math.abs(Date.now() - timestampMs) / 1000;
  if (ageSeconds > RESEND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new Error('Webhook timestamp valt buiten de toegestane replay-window.');
  }
}

function decodeSvixSecret(secret: string): Uint8Array {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function btoaBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function parseDate(value: string): string | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
