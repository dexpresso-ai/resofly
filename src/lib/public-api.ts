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
  const { error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .is('revoked_at', null);
  if (error) throw new Error(`Intrekken is niet gelukt: ${error.message}`);
}

export async function renameApiKey(keyId: UUID, name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) throw new Error('Een sleutel heeft een naam nodig.');
  const { error } = await supabase.from('api_keys').update({ name: clean }).eq('id', keyId);
  if (error) throw new Error(error.message || 'Hernoemen is niet gelukt.');
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
