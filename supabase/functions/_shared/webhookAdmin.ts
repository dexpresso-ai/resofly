// ============================================================
// Webhook-eindpunten beheren: aanmaken, wijzigen, geheim vernieuwen, testen,
// verwijderen.
//
// Twee deuren komen hier uit, met dezelfde regels:
//   - api-admin: een owner/admin in Instellingen → API & webhooks. Het eindpunt
//     is van de ORGANISATIE (api_key_id = null).
//   - api: een koppeling met een API-sleutel (`POST /v1/webhooks`), het
//     "REST hooks"-patroon van Zapier en Make. Het eindpunt hoort bij die
//     SLEUTEL: de koppeling ziet en beheert alleen haar eigen eindpunten, krijgt
//     alleen wat de sleutel mag lezen, en het eindpunt verdwijnt als de sleutel
//     wordt ingetrokken.
//
// Het adres wordt hier gecontroleerd (alleen https, niets intern), de
// gebeurtenissen tegen de catalogus gelegd, en het geheim versleuteld bewaard.
// Daarom loopt alles behalve aan/uit en verwijderen hierlangs en niet via RLS.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { sendTestEvent, type DeliveryOutcome } from './webhookDelivery.ts';
import {
  createWebhookSecret, encryptSecret, modulesOf, normalizeEventList, WEBHOOK_EVENTS, webhookUrlProblem,
} from './webhooks.ts';

/** Van wie is dit eindpunt? Bepaalt wat je ziet en wat je mag. */
export interface EndpointOwner {
  organizationId: string;
  /** Het teamlid dat het aanmaakt (de maker van de sleutel, of de ingelogde owner/admin). */
  userId: string | null;
  /** Gezet = een koppeling via de API: alleen haar eigen eindpunten. */
  apiKeyId: string | null;
  /** Welke modules deze kant mag lezen; null = alles (owner/admin in de app). */
  canRead?: ((module: string) => boolean) | null;
}

/** Invoer die niet klopt. De functie zet dit om naar een 400/404/409/422. */
export class WebhookInputError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422 = 422) {
    super(message);
    this.name = 'WebhookInputError';
  }
}

export const ENDPOINT_COLUMNS = 'id, organization_id, url, description, events, active, created_by, api_key_id, disabled_reason, consecutive_failures, failing_since, last_success_at, last_failure_at, created_at, updated_at';

const MAX_ENDPOINTS_PER_ORG = 50;
const MAX_ENDPOINTS_PER_KEY = 20;

export interface EndpointInput {
  url?: unknown;
  events?: unknown;
  description?: unknown;
  active?: unknown;
}

export async function listEndpoints(admin: SupabaseClient, owner: EndpointOwner): Promise<Record<string, unknown>[]> {
  let query = admin.from('webhook_endpoints').select(ENDPOINT_COLUMNS).eq('organization_id', owner.organizationId);
  if (owner.apiKeyId) query = query.eq('api_key_id', owner.apiKeyId);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(`Webhooks ophalen mislukt: ${error.message}`);
  return data ?? [];
}

/** Eén eindpunt, als het van deze kant is. Anders bestaat het niet. */
export async function getEndpoint(admin: SupabaseClient, owner: EndpointOwner, endpointId: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(endpointId)) {
    throw new WebhookInputError('Deze webhook bestaat niet.', 404);
  }
  let query = admin.from('webhook_endpoints').select(ENDPOINT_COLUMNS)
    .eq('organization_id', owner.organizationId).eq('id', endpointId);
  if (owner.apiKeyId) query = query.eq('api_key_id', owner.apiKeyId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Webhook ophalen mislukt: ${error.message}`);
  if (!data) throw new WebhookInputError('Deze webhook bestaat niet, of hoort niet bij deze sleutel.', 404);
  return data;
}

/**
 * Een nieuw eindpunt. Geeft het eindpunt én het ondertekengeheim terug; dat
 * geheim is daarna nooit meer leesbaar op te vragen, alleen te vernieuwen.
 */
export async function createEndpoint(
  admin: SupabaseClient, owner: EndpointOwner, input: EndpointInput, encryptionKey: string,
): Promise<{ endpoint: Record<string, unknown>; secret: string }> {
  const url = checkUrl(input.url);
  const events = checkEvents(input.events, owner);
  const description = checkDescription(input.description);

  await assertRoom(admin, owner);

  // Eerst het geheim versleutelen: ontbreekt de sleutel daarvoor, dan liever
  // geen eindpunt dan een eindpunt dat nooit iets kan ondertekenen.
  const secret = createWebhookSecret();
  const encrypted = await encryptSecret(secret, encryptionKey);

  const { data: endpoint, error } = await admin.from('webhook_endpoints').insert({
    organization_id: owner.organizationId,
    url,
    events,
    description,
    created_by: owner.userId,
    api_key_id: owner.apiKeyId,
  }).select(ENDPOINT_COLUMNS).single();
  if (error || !endpoint) throw new Error(`De webhook kon niet worden aangemaakt: ${error?.message ?? 'onbekende fout'}`);

  const { error: secretError } = await admin.from('webhook_endpoint_secrets')
    .insert({ endpoint_id: endpoint.id, secret_encrypted: encrypted });
  if (secretError) {
    await admin.from('webhook_endpoints').delete().eq('id', endpoint.id);
    throw new Error(`De webhook kon niet worden aangemaakt: ${secretError.message}`);
  }
  return { endpoint, secret };
}

export async function updateEndpoint(
  admin: SupabaseClient, owner: EndpointOwner, endpointId: string, input: EndpointInput,
): Promise<Record<string, unknown>> {
  await getEndpoint(admin, owner, endpointId);
  const patch: Record<string, unknown> = {};
  if (input.url !== undefined) patch.url = checkUrl(input.url);
  if (input.events !== undefined) patch.events = checkEvents(input.events, owner);
  if (input.description !== undefined) patch.description = checkDescription(input.description);
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw new WebhookInputError('active moet true of false zijn.', 400);
    patch.active = input.active;
  }
  if (Object.keys(patch).length === 0) throw new WebhookInputError('Er valt niets te wijzigen: geef url, events, description of active mee.', 400);

  const { data, error } = await admin.from('webhook_endpoints').update(patch)
    .eq('organization_id', owner.organizationId).eq('id', endpointId)
    .select(ENDPOINT_COLUMNS).single();
  if (error || !data) throw new Error(`De webhook kon niet worden gewijzigd: ${error?.message ?? 'onbekende fout'}`);
  return data;
}

/** Een nieuw geheim; het oude werkt meteen niet meer. */
export async function rotateSecret(
  admin: SupabaseClient, owner: EndpointOwner, endpointId: string, encryptionKey: string,
): Promise<string> {
  await getEndpoint(admin, owner, endpointId);
  const secret = createWebhookSecret();
  const { error } = await admin.from('webhook_endpoint_secrets').upsert({
    endpoint_id: endpointId,
    secret_encrypted: await encryptSecret(secret, encryptionKey),
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Het geheim kon niet worden vernieuwd: ${error.message}`);
  return secret;
}

export async function deleteEndpoint(admin: SupabaseClient, owner: EndpointOwner, endpointId: string): Promise<void> {
  await getEndpoint(admin, owner, endpointId);
  const { error } = await admin.from('webhook_endpoints').delete()
    .eq('organization_id', owner.organizationId).eq('id', endpointId);
  if (error) throw new Error(`De webhook kon niet worden verwijderd: ${error.message}`);
}

/** De laatste bezorgingen van één eindpunt, nieuwste eerst. */
export async function listDeliveries(
  admin: SupabaseClient, owner: EndpointOwner, endpointId: string, limit = 25,
): Promise<Record<string, unknown>[]> {
  await getEndpoint(admin, owner, endpointId);
  const { data, error } = await admin.from('webhook_deliveries')
    .select('id, status, attempts, next_attempt_at, last_attempt_at, response_status, error, created_at, delivered_at, webhook_events(id, type, created_at)')
    .eq('organization_id', owner.organizationId).eq('endpoint_id', endpointId)
    .order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`Bezorgingen ophalen mislukt: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => {
    const event = row.webhook_events as { id?: string; type?: string; created_at?: string } | null;
    const { webhook_events: _event, ...rest } = row;
    return { ...rest, event_id: event?.id ?? null, event_type: event?.type ?? null, event_created_at: event?.created_at ?? null };
  });
}

/** Stuurt meteen een testbericht (`ping`) en geeft terug hoe het eindpunt antwoordde. */
export async function testEndpoint(
  admin: SupabaseClient, owner: EndpointOwner, endpointId: string, options: { encryptionKey: string; sentBy: string },
): Promise<DeliveryOutcome & { deliveryId: string; eventId: string }> {
  const endpoint = await getEndpoint(admin, owner, endpointId);
  if (!endpoint.active) throw new WebhookInputError('Deze webhook staat uit. Zet hem eerst aan om te testen.', 409);
  return await sendTestEvent(admin, {
    id: String(endpoint.id),
    organization_id: String(endpoint.organization_id),
    url: String(endpoint.url),
    api_key_id: endpoint.api_key_id ? String(endpoint.api_key_id) : null,
  }, options);
}

/** De catalogus zoals deze kant hem mag zien: alleen gebeurtenissen uit leesbare modules. */
export function visibleEvents(owner: EndpointOwner): Array<{ type: string; module: string; label: string }> {
  return WEBHOOK_EVENTS.filter((event) => !owner.canRead || owner.canRead(event.module)).map((event) => ({ ...event }));
}

// ── Controles ────────────────────────────────────────────────────────────────

function checkUrl(raw: unknown): string {
  const url = String(raw ?? '').trim();
  const problem = webhookUrlProblem(url);
  if (problem) throw new WebhookInputError(problem, 422);
  return url;
}

function checkEvents(raw: unknown, owner: EndpointOwner): string[] {
  let events: string[];
  try {
    events = normalizeEventList(raw);
  } catch (error) {
    throw new WebhookInputError(error instanceof Error ? error.message : 'De gebeurtenissen kloppen niet.', 422);
  }
  // Een koppeling met een beperkte sleutel kan `*` kiezen — dan krijgt hij wat
  // hij mag lezen, de rest wordt bij het bezorgen overgeslagen. Maar wie
  // uitdrukkelijk om iets vraagt wat hij niet mag zien, hoort dat nu te horen.
  if (owner.canRead && !events.includes('*')) {
    const forbidden = modulesOf(events).filter((module) => !owner.canRead!(module));
    if (forbidden.length > 0) {
      throw new WebhookInputError(`Deze sleutel mag niet lezen in: ${forbidden.join(', ')}. Kies alleen gebeurtenissen uit modules die hij wel mag lezen.`, 422);
    }
  }
  return events;
}

function checkDescription(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

async function assertRoom(admin: SupabaseClient, owner: EndpointOwner): Promise<void> {
  const { count, error } = await admin.from('webhook_endpoints')
    .select('id', { count: 'exact', head: true }).eq('organization_id', owner.organizationId);
  if (error) throw new Error(`Webhooks tellen mislukt: ${error.message}`);
  if ((count ?? 0) >= MAX_ENDPOINTS_PER_ORG) {
    throw new WebhookInputError(`Deze organisatie heeft al ${count} webhooks. Verwijder er eerst een die niet meer gebruikt wordt.`, 409);
  }
  if (owner.apiKeyId) {
    const { count: keyCount, error: keyError } = await admin.from('webhook_endpoints')
      .select('id', { count: 'exact', head: true }).eq('api_key_id', owner.apiKeyId);
    if (keyError) throw new Error(`Webhooks tellen mislukt: ${keyError.message}`);
    if ((keyCount ?? 0) >= MAX_ENDPOINTS_PER_KEY) {
      throw new WebhookInputError(`Deze sleutel heeft al ${keyCount} webhooks. Verwijder er eerst een.`, 409);
    }
  }
}
