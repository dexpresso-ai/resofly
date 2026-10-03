// ============================================================
// webhooks — de bezorger van uitgaande webhooks.
//
// pg_cron roept dit elke minuut aan (?cron=dispatch, met x-cron-secret =
// WEBHOOK_CRON_SECRET; zie PUBLIC_API_SETUP.md). Een ronde zet een handvol
// bezorgers aan het werk. Wie niets meer in handen heeft, claimt een nieuwe
// stapel (claim_webhook_deliveries: `for update skip locked`, dus twee rondes
// pakken nooit dezelfde), bezorgt, en legt de uitkomst vast — tot er niets meer
// klaarstaat of het budget van de ronde op is.
//
// Geen stapel-voor-stapel: dan wacht de hele ronde op het traagste bericht van
// elke stapel, en houdt één eindpunt dat niet antwoordt iedereen op. Nu loopt
// de rest door, en zorgt het plafond per eindpunt in de claim dat zo'n eindpunt
// nooit alle bezorgers tegelijk bezet.
//
// Geen Supabase-JWT (verify_jwt = false in config.toml): pg_cron heeft er geen.
// Het gedeelde cron-secret is de deur, net als bij web-push en campaigns.
// ============================================================

import { createAdminClient } from '../_shared/edgeAuth.ts';
import { deliver, type ClaimedDelivery, type KeyAccessCache } from '../_shared/webhookDelivery.ts';
import { MAX_DELIVERY_ATTEMPTS } from '../_shared/webhooks.ts';

const admin = createAdminClient();

const CRON_SECRET = Deno.env.get('WEBHOOK_CRON_SECRET') || '';
const ENCRYPTION_KEY = Deno.env.get('WEBHOOK_SECRET_ENCRYPTION_KEY') || '';

/** Zoveel bezorgingen tegelijk onderweg. */
const CONCURRENCY = 8;

/** Zoveel daarvan hooguit voor één eindpunt (zie claim_webhook_deliveries). */
const PER_ENDPOINT = 4;

/** Per keer claimen: genoeg om de bezorgers bezig te houden, niet meer. */
const CLAIM_SIZE = 16;

/**
 * Na deze tijd claimen we niets nieuws meer; wat al geclaimd is, maken we af
 * (hooguit één time-out per bezorging). Zo is een ronde rond de minuut klaar:
 * ruim binnen de grens van de Edge-runtime, en lang voordat een bezorging die
 * op 'sending' blijft hangen na vijf minuten wordt teruggepakt.
 */
const ROUND_BUDGET_MS = 40_000;

/** Even wachten als alles wat klaarstaat achter een vol eindpunt staat. */
const IDLE_WAIT_MS = 1_000;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Gebruik POST.' }, 405);
  const url = new URL(req.url);
  if (url.searchParams.get('cron') !== 'dispatch') return json({ error: 'Onbekende opdracht.' }, 400);

  if (!CRON_SECRET) return json({ error: 'WEBHOOK_CRON_SECRET ontbreekt in de Edge Function secrets.' }, 500);
  if (!timingSafeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)) {
    return json({ error: 'Ongeldig of ontbrekend cron-secret.' }, 401);
  }
  // Zonder deze sleutel is geen enkel geheim te ontsleutelen. Dan liever niets
  // claimen — anders gaat elke bezorging als mislukt het log in.
  if (!ENCRYPTION_KEY) return json({ error: 'WEBHOOK_SECRET_ENCRYPTION_KEY ontbreekt in de Edge Function secrets.' }, 500);

  const started = Date.now();
  const keyCache: KeyAccessCache = new Map();
  const tally = { delivered: 0, retrying: 0, failed: 0, skipped: 0 };
  const queue: ClaimedDelivery[] = [];
  let inFlight = 0;
  let claimError: string | null = null;
  let claiming: Promise<number> | null = null;

  /** Eén claim tegelijk; wie tegelijk leeg raakt, wacht op dezelfde. */
  const claim = (): Promise<number> => claiming ??= (async () => {
    try {
      const { data, error } = await admin.rpc('claim_webhook_deliveries', {
        p_limit: CLAIM_SIZE, p_max_attempts: MAX_DELIVERY_ATTEMPTS, p_per_endpoint: PER_ENDPOINT,
      });
      if (error) {
        claimError = error.message;
        return 0;
      }
      const batch = (data ?? []) as ClaimedDelivery[];
      queue.push(...batch);
      return batch.length;
    } finally {
      claiming = null;
    }
  })();

  const worker = async (): Promise<void> => {
    for (;;) {
      // Wat geclaimd is, wordt altijd bezorgd — ook na het budget. Anders blijft
      // het vijf minuten op 'sending' staan en telt het als een poging.
      const delivery = queue.shift();
      if (delivery) {
        inFlight += 1;
        try {
          const outcome = await deliver(admin, delivery, { encryptionKey: ENCRYPTION_KEY, keyCache });
          tally[outcome.status] += 1;
        } finally {
          inFlight -= 1;
        }
        continue;
      }
      if (claimError || Date.now() - started >= ROUND_BUDGET_MS) return;
      if (await claim() > 0) continue;
      // Niets te claimen. Is er nog iets onderweg, dan kan dat plaats maken bij
      // een eindpunt dat aan zijn plafond zit; anders is het werk op.
      if (inFlight === 0 && queue.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS));
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (claimError) {
    console.error('[webhooks] claimen mislukt:', claimError);
    return json({ error: `Claimen mislukt: ${claimError}`, ...tally }, 500);
  }
  return json({ ok: true, ...tally, ms: Date.now() - started });
});

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let result = 0;
  for (let i = 0; i < ea.length; i += 1) result |= ea[i] ^ eb[i];
  return result === 0;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
