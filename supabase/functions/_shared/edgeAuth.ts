// ============================================================
// Gedeelde edge-helpers: auth (Supabase JWT) + org-toegang + CORS/JSON.
//
// Gespiegeld van het beproefde patroon in gerrie-agent. Bewust een los
// hulpbestand zodat nieuwe functies (meeting-transcribe / -webhook) het delen
// zonder de grote, werkende gerrie-agent te hoeven aanpassen.
//
// Harde regel (zoals overal): organization_id komt NOOIT uit de client zonder
// dat we het lidmaatschap van de geverifieerde gebruiker controleren.
// ============================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502;

export class HttpError extends Error {
  status: HttpStatus;
  constructor(message: string, status: HttpStatus = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Ontbrekende environment variable: ${name}`);
  return value;
}

/** Service-role client — omzeilt RLS; alle schrijfacties lopen hierlangs. */
export function createAdminClient(): SupabaseClient {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function requireUser(admin: SupabaseClient, req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

export async function requireOrganizationAccess(admin: SupabaseClient, userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new HttpError('Ongeldige organisatie.', 400);
  const { data, error } = await admin.from('organization_members').select('role')
    .eq('organization_id', organizationId).eq('user_id', userId).eq('status', 'active').limit(1);
  if (error) throw new HttpError(`organization_members lookup mislukt: ${error.message}`, 500);
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new HttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

export function assertWriteRole(role: OrganizationRole): void {
  if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError('Geen schrijfrechten in deze organisatie.', 403);
}

// ── Modulerechten ────────────────────────────────────────────────────────────
//
// Edge functions draaien op de service-role en omzeilen daarmee RLS én de
// schrijf-triggers. De modulerechten van het teamlid moeten hier dus expliciet
// gecontroleerd worden, anders is elke edge function een achterdeur naar een
// module die de owner juist heeft dichtgezet.
//
// Deze helpers geven alleen het niveau terug; de aanroeper gooit zijn eigen
// foutklasse, zodat de HTTP-status per functie klopt.

export type ModuleKey =
  | 'clients' | 'projects' | 'time' | 'calendar' | 'tickets'
  | 'content' | 'stats' | 'marketing' | 'finance' | 'chat' | 'gerrie';

export type ModuleLevel = 'none' | 'read' | 'write';

export const MODULE_LABELS: Record<ModuleKey, string> = {
  clients: 'Klanten', projects: 'Projecten', time: 'Uren', calendar: 'Agenda',
  tickets: 'Tickets', content: 'Inhoud', stats: 'Statistieken',
  marketing: 'Marketing', finance: 'Financiën', chat: 'Teamchat', gerrie: 'Gerrie',
};

/** Exacte spiegel van `public.org_module_level`: owners/admins zijn nooit
 *  beperkt, een viewer nooit meer dan lezen, ontbrekende sleutel = volledig. */
export async function getModuleLevel(
  admin: SupabaseClient,
  userId: string,
  organizationId: string,
  module: ModuleKey,
): Promise<ModuleLevel> {
  const { data, error } = await admin.from('organization_members')
    .select('role, module_access')
    .eq('organization_id', organizationId).eq('user_id', userId).eq('status', 'active').limit(1);
  if (error) throw new HttpError(`organization_members lookup mislukt: ${error.message}`, 500);
  const row = data?.[0] as { role?: string; module_access?: Record<string, unknown> } | undefined;
  if (!row?.role) return 'none';
  if (row.role === 'owner' || row.role === 'admin') return 'write';
  const raw = row.module_access?.[module];
  const stored: ModuleLevel = raw === 'none' || raw === 'read' || raw === 'write' ? raw : 'write';
  if (row.role === 'viewer') return stored === 'none' ? 'none' : 'read';
  return stored;
}

/** Gooit een 403 wanneer het teamlid deze module niet op het vereiste niveau mag. */
export async function assertModuleAccess(
  admin: SupabaseClient,
  userId: string,
  organizationId: string,
  module: ModuleKey,
  need: 'read' | 'write' = 'write',
): Promise<void> {
  const level = await getModuleLevel(admin, userId, organizationId, module);
  const ok = need === 'read' ? level !== 'none' : level === 'write';
  if (!ok) {
    throw new HttpError(
      level === 'none'
        ? `Je hebt geen toegang tot de module ${MODULE_LABELS[module]} in deze organisatie.`
        : `Je mag niets wijzigen in de module ${MODULE_LABELS[module]} van deze organisatie.`,
      403,
    );
  }
}

// ── CORS ─────────────────────────────────────────────────────────────────────

export interface Cors {
  headers(req: Request): HeadersInit;
  assert(req: Request): void;
  json(req: Request, payload: unknown, status?: number): Response;
}

export function makeCors(allowedOrigins: string[], allowLocalDev: boolean): Cors {
  const isLocal = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const headers = (req: Request): HeadersInit => {
    const origin = req.headers.get('origin') || '';
    const allowOrigin = allowedOrigins.includes(origin) || (allowLocalDev && isLocal(origin))
      ? origin : allowLocalDev && !origin ? '*' : 'null';
    return {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    };
  };
  return {
    headers,
    assert(req: Request) {
      const origin = req.headers.get('origin') || '';
      if (!origin && allowLocalDev) return;
      if (allowedOrigins.includes(origin)) return;
      if (allowLocalDev && isLocal(origin)) return;
      if (allowedOrigins.length === 0 && allowLocalDev) return;
      if (allowedOrigins.length === 0) throw new HttpError('Toegestane origins ontbreken in de configuratie.', 500);
      throw new HttpError('Deze frontend-origin is niet toegestaan.', 403);
    },
    json(req: Request, payload: unknown, status = 200): Response {
      return new Response(JSON.stringify(payload), { status, headers: { ...headers(req), 'Content-Type': 'application/json' } });
    },
  };
}

export function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(',')) {
      const trimmed = part.trim().replace(/\/$/, '');
      if (trimmed) origins.add(trimmed);
    }
  }
  return [...origins];
}
