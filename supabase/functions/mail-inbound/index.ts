import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// Eigen-domein e-mail, fase C: inkomende antwoorden van klanten.
//
// De Cloudflare Email Worker ontvangt het antwoord (op reply+<id>@inbound-domein),
// parseert de MIME en POST't hier een JSON-payload met een gedeeld secret. Wij
// zoeken het oorspronkelijke uitgaande bericht op via <id> (of, als fallback, via
// het afzenderadres) en schrijven het antwoord als inbound-bericht in dezelfde
// thread, zodat het in de Communicatie-tab onder de klant verschijnt.

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const MAIL_INBOUND_WEBHOOK_SECRET = Deno.env.get('MAIL_INBOUND_WEBHOOK_SECRET') || '';
const MAIL_INBOUND_ALLOW_UNSIGNED =
  (Deno.env.get('MAIL_INBOUND_ALLOW_UNSIGNED') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class InboundError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'InboundError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed.' }, 405);
  }
  try {
    assertSecret(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await handleInbound(body);
    return json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof InboundError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Inbound verwerking mislukt.';
    if (status >= 500) console.error('mail-inbound error', message);
    return json(
      { ok: false, error: error instanceof InboundError ? message : 'Inbound verwerking mislukt door een serverfout.' },
      status,
    );
  }
});

async function handleInbound(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fromEmail = normalizeEmail(body.from);
  if (!isEmail(fromEmail)) {
    throw new InboundError('Inbound mist een geldig afzenderadres.', 400);
  }

  // Negeer automatische mail (out-of-office, mailer-daemon, no-reply) om lussen te voorkomen.
  if (looksAutomated(body, fromEmail)) {
    return { skipped: 'automated' };
  }

  const messageId = String(body.messageId || '').trim() || null;
  if (messageId) {
    const existing = await findInboundByMessageId(messageId);
    if (existing) return { skipped: 'duplicate', clientEmailId: existing.id, threadId: existing.thread_id };
  }

  const subject = String(body.subject || '').trim();
  const html = typeof body.html === 'string' && body.html.trim() ? body.html : null;
  const text = typeof body.text === 'string' && body.text.trim() ? body.text : null;
  const fromName = String(body.fromName || '').trim() || null;
  const receivedAt = parseDate(body.receivedAt) || new Date().toISOString();

  const token = extractToken(body.token, body.to);

  let organizationId: string;
  let clientId: string;
  let threadId: string;
  let toEmail: string | null = null;

  const origin = token ? await loadOutboundByToken(token) : null;
  if (origin) {
    organizationId = origin.organization_id;
    clientId = origin.client_id;
    threadId = origin.thread_id;
    toEmail = origin.from_email;
  } else {
    const fallback = await resolveBySender(fromEmail, subject, receivedAt);
    if (!fallback) return { skipped: 'no_match' };
    ({ organizationId, clientId, threadId } = fallback);
  }

  const { data, error } = await supabaseAdmin
    .from('client_emails')
    .insert({
      organization_id: organizationId,
      thread_id: threadId,
      client_id: clientId,
      created_by: null,
      direction: 'inbound',
      provider: 'inbound',
      provider_email_id: messageId,
      from_email: fromEmail,
      from_name: fromName,
      to_email: toEmail || fromEmail,
      subject,
      body_html: html,
      body_text: text || (html ? htmlToText(html) : ''),
      status: 'received',
      received_at: receivedAt,
      last_event_at: receivedAt,
    })
    .select('id,thread_id')
    .single();
  if (error) throw error;

  await supabaseAdmin
    .from('client_email_threads')
    .update({ last_message_at: receivedAt, last_direction: 'inbound' })
    .eq('id', threadId);

  return { clientEmailId: data.id, threadId: data.thread_id };
}

async function loadOutboundByToken(token: string): Promise<
  { organization_id: string; client_id: string; thread_id: string; from_email: string } | null
> {
  const { data, error } = await supabaseAdmin
    .from('client_emails')
    .select('organization_id,client_id,thread_id,from_email')
    .eq('id', token)
    .eq('direction', 'outbound')
    .maybeSingle();
  if (error) {
    if (/invalid input syntax for type uuid/i.test(`${error.message ?? ''}`)) return null;
    throw error;
  }
  return data ?? null;
}

// Fallback wanneer er geen token-match is: koppel op het afzender-e-mailadres,
// maar alleen als dat eenduidig één klant oplevert.
async function resolveBySender(
  fromEmail: string,
  subject: string,
  receivedAt: string,
): Promise<{ organizationId: string; clientId: string; threadId: string } | null> {
  const { data: clients, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,organization_id')
    .ilike('email', fromEmail)
    .limit(2);
  if (clientError) throw clientError;
  if (!clients || clients.length !== 1) return null; // 0 = onbekend, 2+ = ambigu

  const client = clients[0] as { id: string; organization_id: string };

  const { data: threads, error: threadError } = await supabaseAdmin
    .from('client_email_threads')
    .select('id')
    .eq('organization_id', client.organization_id)
    .eq('client_id', client.id)
    .order('last_message_at', { ascending: false })
    .limit(1);
  if (threadError) throw threadError;

  let threadId = threads?.[0]?.id as string | undefined;
  if (!threadId) {
    const { data: newThread, error: insertError } = await supabaseAdmin
      .from('client_email_threads')
      .insert({
        organization_id: client.organization_id,
        client_id: client.id,
        subject: subject || '(antwoord van klant)',
        last_direction: 'inbound',
        last_message_at: receivedAt,
      })
      .select('id')
      .single();
    if (insertError) throw insertError;
    threadId = newThread.id as string;
  }

  return { organizationId: client.organization_id, clientId: client.id, threadId };
}

async function findInboundByMessageId(messageId: string): Promise<{ id: string; thread_id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('client_emails')
    .select('id,thread_id')
    .eq('direction', 'inbound')
    .eq('provider_email_id', messageId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

function assertSecret(req: Request): void {
  if (!MAIL_INBOUND_WEBHOOK_SECRET && !MAIL_INBOUND_ALLOW_UNSIGNED) {
    throw new InboundError(
      'MAIL_INBOUND_WEBHOOK_SECRET ontbreekt. Zet MAIL_INBOUND_ALLOW_UNSIGNED=true alleen lokaal tijdens testen.',
      500,
    );
  }
  if (!MAIL_INBOUND_WEBHOOK_SECRET) return; // bewust unsigned (alleen dev)
  const provided = req.headers.get('x-inbound-secret') || '';
  if (!timingSafeEqual(provided, MAIL_INBOUND_WEBHOOK_SECRET)) {
    throw new InboundError('Ongeldig of ontbrekend inbound-secret.', 401);
  }
}

function extractToken(tokenField: unknown, toField: unknown): string | null {
  const direct = String(tokenField || '').trim();
  if (isUuid(direct)) return direct;
  const match = String(toField || '').match(/reply\+([^@]+)@/i);
  if (match && isUuid(match[1])) return match[1];
  return null;
}

function looksAutomated(body: Record<string, unknown>, fromEmail: string): boolean {
  const autoSubmitted = String(body.autoSubmitted || '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  return /^(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i.test(fromEmail);
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseDate(value: unknown): string | null {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
