import { supabase } from './supabase';
import { throwFunctionError } from './functionErrors';
import { isMissingRelation } from './postgrestErrors';
import type { UUID } from '../types';

/**
 * De openbare API van deze organisatie, vanuit de browser (Instellingen → API &
 * webhooks).
 *
 * Twee kanten, net als bij de AI-koppelingen (mcp-api.ts):
 *  - AANMAKEN loopt via de edge function `api-admin`, omdat er een geheim bij
 *    hoort dat alleen de server mag maken. De platte sleutel komt één keer terug
 *    en bestaat daarna nergens meer in leesbare vorm.
 *  - ZIEN en INTREKKEN gaat rechtstreeks via RLS: owners en admins lezen de
 *    sleutels van hun organisatie en mogen `revoked_at` en de naam zetten — de
 *    database bewaakt dat er verder niets verandert. Zo kan de intrek-knop niet
 *    stilvallen als die functie het even niet doet.
 */

/**
 * Het adres dat een koppeling aanroept, zonder slash erachter. Staat de API
 * achter een eigen domein (API_PUBLIC_URL op de edge functions), zet
 * VITE_API_PUBLIC_URL dan op precies dezelfde waarde.
 */
export const API_BASE_URL = String(
  import.meta.env.VITE_API_PUBLIC_URL
    || `${String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')}/functions/v1/api`,
).replace(/\/+$/, '');

export const API_OPENAPI_URL = `${API_BASE_URL}/v1/openapi.json`;

/** Wat een sleutel mag: een trede, met alles eronder (zie publicApi.ts op de server). */
export type ApiAccessLevel = 'read' | 'propose' | 'execute' | 'execute_high';

export const API_ACCESS_LEVELS: ApiAccessLevel[] = ['read', 'propose', 'execute', 'execute_high'];

export const API_ACCESS_LABEL: Record<ApiAccessLevel, { label: string; badge: string; help: string }> = {
  read: {
    label: 'Alleen lezen',
    badge: 'Leest alleen',
    help: 'De koppeling kan gegevens ophalen, maar niets aanmaken, wijzigen of versturen.',
  },
  propose: {
    label: 'Lezen en klaarzetten',
    badge: 'Leest · zet klaar',
    help: 'Wijzigingen komen als voorstel in je goedkeurwachtrij; er gebeurt pas iets als iemand in ResoFly op Uitvoeren klikt.',
  },
  execute: {
    label: 'Lezen en rechtstreeks uitvoeren',
    badge: 'Leest · voert uit',
    help: 'Omkeerbare wijzigingen gebeuren meteen. Wat onomkeerbaar is of naar buiten gaat (post naar klanten, boekingen), en wat ResoFly niet op de server kan, komt alsnog in je goedkeurwachtrij.',
  },
  execute_high: {
    label: 'Alles rechtstreeks uitvoeren',
    badge: 'Voert alles uit',
    help: 'Ook onomkeerbare handelingen gebeuren meteen: post naar je klanten, boekingen, aangiftes, publieke links. Alleen voor koppelingen die je volledig vertrouwt.',
  },
};

/** Een API-sleutel zoals het scherm hem ziet. Nooit iets van het geheim. */
export interface ApiKey {
  id: UUID;
  organization_id: UUID;
  /** Namens wie de sleutel werkt (de maker). */
  user_id: UUID;
  name: string;
  /** Herkenbaar stukje: "rsfapi.Ab12Cd…". */
  key_hint: string;
  scope: string;
  /** Alleen de beperkingen; een module die er niet in staat, volgt de rechten van de maker. */
  module_access: Record<string, 'none' | 'read'>;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const KEY_COLUMNS = 'id, organization_id, user_id, name, key_hint, scope, module_access, expires_at, created_at, last_used_at, revoked_at';

/** De hoogste trede in een scope-tekst — spiegel van levelOfScope op de server. */
export function accessLevelOf(scope: string): ApiAccessLevel {
  const scopes = String(scope || '').split(/[\s,]+/).filter(Boolean);
  if (scopes.includes('execute_high') && scopes.includes('execute')) return 'execute_high';
  if (scopes.includes('execute')) return 'execute';
  if (scopes.includes('propose')) return 'propose';
  return 'read';
}

/**
 * De frontend loopt via Cloudflare Pages vóór op de database. Bestaat de tabel
 * hier nog niet, dan is dat geen fout maar "nog niet aangezet" — net als bij de
 * AI-koppelingen.
 */
export class PublicApiNotAvailableError extends Error {
  constructor() { super('De API is in deze omgeving nog niet ingeschakeld.'); this.name = 'PublicApiNotAvailableError'; }
}

/** De actieve sleutels van deze organisatie, nieuwste eerst. Alleen voor owners/admins (RLS). */
export async function listApiKeys(organizationId: UUID): Promise<ApiKey[]> {
  const { data, error } = await supabase
    .from('api_keys')
    .select(KEY_COLUMNS)
    .eq('organization_id', organizationId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingRelation(error)) throw new PublicApiNotAvailableError();
    throw new Error(`De API-sleutels konden niet worden opgehaald: ${error.message}`);
  }
  return (data ?? []) as ApiKey[];
}

export interface NewApiKeyInput {
  name: string;
  access: ApiAccessLevel;
  /** Alleen 'none' of 'read' per module; 'write' (of weglaten) = geen beperking. */
  moduleAccess: Record<string, 'none' | 'read'>;
  /** null = verloopt niet. */
  expiresInDays: number | null;
}

/** Maakt een sleutel aan. `secret` is de platte sleutel: die zie je maar één keer. */
export async function createApiKey(organizationId: UUID, input: NewApiKeyInput): Promise<{ key: ApiKey; secret: string }> {
  const { data, error } = await supabase.functions.invoke('api-admin', {
    body: { action: 'createKey', organizationId, ...input },
  });
  if (error) await throwFunctionError(error, 'De API-sleutel kon niet worden aangemaakt.');
  if (!data?.secret || !data?.key) throw new Error(String(data?.error || 'De API-sleutel kon niet worden aangemaakt.'));
  return { key: data.key as ApiKey, secret: String(data.secret) };
}

/**
 * Intrekken. Definitief: de database weigert een ingetrokken sleutel weer aan te
 * zetten, en annuleert wat die sleutel nog in de goedkeurwachtrij had staan.
 */
export async function revokeApiKey(keyId: UUID): Promise<void> {
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw new Error(`Intrekken is niet gelukt: ${error.message}`);
  // RLS laat een update die niet mag, stil niets raken. Dan niet "ingetrokken"
  // melden terwijl de sleutel gewoon blijft werken.
  if (!data || data.length === 0) {
    throw new Error('Intrekken is niet gelukt: de sleutel is al ingetrokken, of je hebt er de rechten niet voor.');
  }
}

export async function renameApiKey(keyId: UUID, name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) throw new Error('Een sleutel heeft een naam nodig.');
  const { data, error } = await supabase.from('api_keys').update({ name: clean }).eq('id', keyId).select('id');
  if (error) throw new Error(error.message || 'Hernoemen is niet gelukt.');
  if (!data || data.length === 0) throw new Error('Hernoemen is niet gelukt: de sleutel bestaat niet meer, of je hebt er de rechten niet voor.');
}

/** Eén regel uit het verzoeklog. */
export interface ApiRequestLogEntry {
  id: number;
  api_key_id: UUID | null;
  method: string;
  path: string;
  action_id: string | null;
  status: number;
  error_code: string | null;
  duration_ms: number | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

/** De laatste aanroepen, voor "wat ging er langs deze deur?". */
export async function listApiRequests(organizationId: UUID, limit = 50): Promise<ApiRequestLogEntry[]> {
  const { data, error } = await supabase
    .from('api_request_log')
    .select('id, api_key_id, method, path, action_id, status, error_code, duration_ms, ip, user_agent, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingRelation(error)) throw new PublicApiNotAvailableError();
    throw new Error(`Het verzoeklog kon niet worden opgehaald: ${error.message}`);
  }
  return (data ?? []) as ApiRequestLogEntry[];
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
//
// Zelfde tweedeling als bij de sleutels. Aanmaken, adres of gebeurtenissen
// wijzigen, het geheim vernieuwen en testen lopen via `api-admin`: daar wordt
// het adres gecontroleerd (geen intern netwerk) en het geheim versleuteld.
// Zien, aan/uit en verwijderen gaan rechtstreeks via RLS, zodat "stop hiermee"
// het altijd doet.

export interface WebhookEndpoint {
  id: UUID;
  organization_id: UUID;
  url: string;
  description: string;
  /** Exacte types, `onderwerp.*` of `*`. */
  events: string[];
  active: boolean;
  created_by: UUID | null;
  /** Gezet = aangemaakt door een koppeling via de API, met die sleutel. */
  api_key_id: UUID | null;
  disabled_reason: string | null;
  consecutive_failures: number;
  failing_since: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: UUID;
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'skipped';
  attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  response_status: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  event_type: string | null;
}

export interface WebhookEventInfo {
  type: string;
  module: string;
  label: string;
}

export interface WebhookTestResult {
  status: 'delivered' | 'retrying' | 'failed' | 'skipped';
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

const ENDPOINT_COLUMNS = 'id, organization_id, url, description, events, active, created_by, api_key_id, disabled_reason, consecutive_failures, failing_since, last_success_at, last_failure_at, created_at, updated_at';

async function invokeApiAdmin<T>(organizationId: UUID, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('api-admin', { body: { ...body, organizationId } });
  if (error) await throwFunctionError(error, fallback);
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

/** De gebeurtenissen waarop een webhook kan, en of webhooks in deze omgeving aan staan. */
export async function loadWebhookCatalog(organizationId: UUID): Promise<{ events: WebhookEventInfo[]; ready: boolean }> {
  const data = await invokeApiAdmin<{ events?: WebhookEventInfo[]; webhooksReady?: boolean }>(
    organizationId, { action: 'catalog' }, 'De lijst met gebeurtenissen kon niet worden opgehaald.');
  return { events: data.events ?? [], ready: data.webhooksReady === true };
}

export async function listWebhooks(organizationId: UUID): Promise<WebhookEndpoint[]> {
  const { data, error } = await supabase
    .from('webhook_endpoints')
    .select(ENDPOINT_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingRelation(error)) throw new PublicApiNotAvailableError();
    throw new Error(`De webhooks konden niet worden opgehaald: ${error.message}`);
  }
  return (data ?? []) as WebhookEndpoint[];
}

export async function listWebhookDeliveries(organizationId: UUID, endpointId: UUID, limit = 20): Promise<WebhookDelivery[]> {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .select('id, status, attempts, next_attempt_at, last_attempt_at, response_status, error, created_at, delivered_at, webhook_events(type)')
    .eq('organization_id', organizationId)
    .eq('endpoint_id', endpointId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`De bezorgingen konden niet worden opgehaald: ${error.message}`);
  return (data ?? []).map((row) => {
    const event = (row as { webhook_events?: { type?: string } | null }).webhook_events;
    return { ...(row as unknown as WebhookDelivery), event_type: event?.type ?? null };
  });
}

/** Een nieuwe webhook. `secret` (whsec_…) zie je maar één keer. */
export async function createWebhook(
  organizationId: UUID, input: { url: string; events: string[]; description: string },
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  return await invokeApiAdmin(organizationId, { action: 'createWebhook', ...input }, 'De webhook kon niet worden aangemaakt.');
}

export async function updateWebhook(
  organizationId: UUID, webhookId: UUID, patch: { url?: string; events?: string[]; description?: string },
): Promise<WebhookEndpoint> {
  const data = await invokeApiAdmin<{ endpoint: WebhookEndpoint }>(
    organizationId, { action: 'updateWebhook', webhookId, ...patch }, 'De webhook kon niet worden gewijzigd.');
  return data.endpoint;
}

/** Aan of uit, rechtstreeks via RLS. Weer aanzetten wist de foutreeks (database-trigger). */
export async function setWebhookActive(webhookId: UUID, active: boolean): Promise<void> {
  const { data, error } = await supabase.from('webhook_endpoints').update({ active }).eq('id', webhookId).select('id');
  if (error) throw new Error(error.message || 'De webhook kon niet worden aan- of uitgezet.');
  if (!data || data.length === 0) throw new Error('De webhook kon niet worden aan- of uitgezet: hij bestaat niet meer, of je hebt er de rechten niet voor.');
}

export async function deleteWebhook(webhookId: UUID): Promise<void> {
  const { data, error } = await supabase.from('webhook_endpoints').delete().eq('id', webhookId).select('id');
  if (error) throw new Error(`Verwijderen is niet gelukt: ${error.message}`);
  if (!data || data.length === 0) throw new Error('Verwijderen is niet gelukt: de webhook bestaat niet meer, of je hebt er de rechten niet voor.');
}

/** Een nieuw geheim; het oude werkt meteen niet meer. */
export async function rotateWebhookSecret(organizationId: UUID, webhookId: UUID): Promise<string> {
  const data = await invokeApiAdmin<{ secret: string }>(
    organizationId, { action: 'rotateWebhookSecret', webhookId }, 'Het geheim kon niet worden vernieuwd.');
  return data.secret;
}

/** Stuurt meteen een testbericht en geeft terug hoe het eindpunt antwoordde. */
export async function testWebhook(organizationId: UUID, webhookId: UUID): Promise<WebhookTestResult> {
  const data = await invokeApiAdmin<{ result: WebhookTestResult }>(
    organizationId, { action: 'testWebhook', webhookId }, 'Het testbericht kon niet worden verstuurd.');
  return data.result;
}
