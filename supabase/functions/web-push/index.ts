// ============================================================
// ResoFly — Web Push (Edge Function)
//
// Twee soorten aanroepen (zelfde tweedeling als `campaigns`):
//  1. Cron (?cron=drain): leegt de notification_outbox en verstuurt de pushes via
//     de push-diensten. Geen Supabase-JWT; geauthenticeerd met x-cron-secret
//     (PUSH_CRON_SECRET). pg_cron roept dit per minuut aan (zie PUSH_SETUP.md).
//  2. App-acties (ingelogde leden): `getVapidKey` (publieke sleutel om te
//     abonneren) en `test` (stuur een testmelding naar je eigen apparaten).
//
// Abonnementen (push_subscriptions) en voorkeuren (notification_preferences)
// schrijft de frontend zelf via RLS — die staan hier bewust NIET; de service-role
// doet alleen wat RLS niet mag: de outbox legen en dode abonnementen opruimen.
// ============================================================

import {
  createAdminClient,
  makeCors,
  parseAllowedOrigins,
  requireUser,
  HttpError,
} from '../_shared/edgeAuth.ts';
import { sendWebPush, type VapidKeys } from '../_shared/webPush.ts';

const admin = createAdminClient();

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@resofly.nl';
const PUSH_CRON_SECRET = Deno.env.get('PUSH_CRON_SECRET') || '';
const DRAIN_BATCH = Number(Deno.env.get('PUSH_DRAIN_BATCH') || '50') || 50;

const PUSH_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('PUSH_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('PUSH_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(PUSH_ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

function vapidKeys(): VapidKeys {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new HttpError('VAPID-sleutels ontbreken in de Edge Function secrets.', 500);
  }
  return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let result = 0;
  for (let i = 0; i < ea.length; i += 1) result |= ea[i] ^ eb[i];
  return result === 0;
}

function assertCronSecret(req: Request): void {
  if (!PUSH_CRON_SECRET) throw new HttpError('PUSH_CRON_SECRET ontbreekt in de Edge Function secrets.', 500);
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, PUSH_CRON_SECRET)) throw new HttpError('Ongeldig of ontbrekend cron-secret.', 401);
}

function plainJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

/**
 * Verstuur `payload` naar alle apparaten van één gebruiker. Ruimt dode
 * abonnementen op (404/410) en telt uitkomsten voor de outbox-afhandeling.
 */
async function sendToUser(userId: string, payload: Record<string, unknown>): Promise<{
  delivered: number; gone: number; error: number; lastError?: string;
}> {
  const keys = vapidKeys();
  const { data, error } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, failure_count')
    .eq('user_id', userId);
  if (error) throw new HttpError(`push_subscriptions ophalen mislukt: ${error.message}`, 500);

  const subs = (data ?? []) as SubscriptionRow[];
  let delivered = 0, gone = 0, errorCount = 0;
  let lastError: string | undefined;

  for (const sub of subs) {
    const outcome = await sendWebPush(keys, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
    if (outcome.result === 'delivered') {
      delivered += 1;
      await admin.from('push_subscriptions')
        .update({ failure_count: 0, last_seen_at: new Date().toISOString() })
        .eq('id', sub.id);
    } else if (outcome.result === 'gone') {
      gone += 1;
      await admin.from('push_subscriptions').delete().eq('id', sub.id);
    } else {
      errorCount += 1;
      lastError = `HTTP ${outcome.status} ${outcome.detail ?? ''}`.trim();
      const nextFailures = (sub.failure_count ?? 0) + 1;
      // Blijft een abonnement lang falen (zonder nette 404/410), ruim het dan op.
      if (nextFailures >= 20) await admin.from('push_subscriptions').delete().eq('id', sub.id);
      else await admin.from('push_subscriptions').update({ failure_count: nextFailures }).eq('id', sub.id);
    }
  }
  return { delivered, gone, error: errorCount, lastError };
}

/** Cron: claim een batch en verstuur. */
async function drain(): Promise<Record<string, number>> {
  vapidKeys(); // faal snel als de sleutels ontbreken
  const { data, error } = await admin.rpc('claim_push_outbox', { p_limit: DRAIN_BATCH });
  if (error) throw new HttpError(`claim_push_outbox mislukt: ${error.message}`, 500);

  const rows = (data ?? []) as Array<{ id: string; recipient_user_id: string; payload: Record<string, unknown> }>;
  let delivered = 0, gone = 0, requeued = 0, done = 0;

  for (const row of rows) {
    // Eén falende rij (DB-hik e.d.) mag de rest van de batch niet blokkeren; laat hem
    // in 'sending' staan — claim_push_outbox pikt hem na 5 min opnieuw op (tot attempts>=5).
    try {
      const res = await sendToUser(row.recipient_user_id, row.payload ?? {});
      delivered += res.delivered; gone += res.gone;
      let status: 'sent' | 'queued';
      if (res.delivered > 0) { status = 'sent'; done += 1; }
      else if (res.error > 0) { status = 'queued'; requeued += 1; }
      else { status = 'sent'; done += 1; } // geen apparaten meer of allemaal opgeruimd
      await admin.rpc('mark_push_outbox', { p_id: row.id, p_status: status, p_error: res.lastError ?? null });
    } catch (err) {
      requeued += 1;
      console.error('web-push drain row error', err instanceof Error ? err.message : err);
      try {
        await admin.rpc('mark_push_outbox', { p_id: row.id, p_status: 'queued', p_error: err instanceof Error ? err.message : 'drain row error' });
      } catch { /* al gelogd; claim pikt de rij later opnieuw op */ }
    }
  }
  return { claimed: rows.length, delivered, gone, requeued, done };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const cronParam = url.searchParams.get('cron');

  // ── Cron-pad (geen JWT, geen Origin) ──
  if (cronParam) {
    try {
      if (req.method !== 'POST') return plainJson({ ok: false, error: 'Method not allowed.' }, 405);
      assertCronSecret(req);
      if (cronParam === 'drain') {
        const result = await drain();
        return plainJson({ ok: true, ...result });
      }
      return plainJson({ ok: false, error: `Onbekende cron: ${cronParam}` }, 400);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('web-push cron error', err instanceof Error ? err.message : err);
      return plainJson({ ok: false, error: err instanceof HttpError ? err.message : 'Cronverwerking mislukt.' }, status);
    }
  }

  // ── App-pad (ingelogde leden) ──
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });
  try {
    if (req.method !== 'POST') return cors.json(req, { ok: false, error: 'Method not allowed.' }, 405);
    cors.assert(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const user = await requireUser(admin, req);

    if (action === 'getVapidKey') {
      if (!VAPID_PUBLIC_KEY) throw new HttpError('VAPID_PUBLIC_KEY ontbreekt in de Edge Function secrets.', 500);
      return cors.json(req, { ok: true, publicKey: VAPID_PUBLIC_KEY });
    }
    if (action === 'test') {
      const res = await sendToUser(user.id, {
        title: 'ResoFly', body: 'Testmelding — je meldingen werken. 🎉', url: '/', tag: 'push-test',
      });
      return cors.json(req, { ok: true, sent: res.delivered, gone: res.gone });
    }
    throw new HttpError(`Onbekende actie: ${action}`, 400);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('web-push app error', err instanceof Error ? err.message : err);
    return cors.json(req, { ok: false, error: err instanceof HttpError ? err.message : 'Serverfout.' }, status);
  }
});
