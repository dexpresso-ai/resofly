export interface Env {
  MEDIA_BUCKET: R2Bucket;
  APP_ENV: string;
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Shared secret for server-side (Edge Function) PDF snapshot storage. */
  INTERNAL_UPLOAD_SECRET?: string;
  MEDIA_SIGNING_SECRET?: string;
}

type JsonBody = Record<string, unknown> | Array<unknown>;

type RouteContext = {
  requestId: string;
  url: URL;
  corsHeaders: Headers;
};

const ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const ALLOWED_HEADERS =
  'Content-Type, Authorization, X-File-Name, X-File-Type, X-Organization-Id, X-Entity-Type, X-Entity-Id, X-Parent-Task-Id, X-Storage-Key, X-SHA256, X-Size-Bytes';
const MAX_AGE_SECONDS = '86400';

/** 25 MB — must stay in sync with MAX_UPLOAD_BYTES in src/lib/r2.ts. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ENTITY_TYPES = new Set([
  'client',
  'project',
  'task',
  'subtask',
  'ticket',
  'note',
  'document',
  'quote',
  'invoice',
  'meeting_recording',
]);

/**
 * Meeting-opnames zijn audio en mogen groter zijn dan een gewone bijlage. Mono
 * Opus op lage bitrate is ~11–14 MB/uur, dus 150 MB ≈ 10 uur — ruim genoeg.
 */
const MAX_AUDIO_UPLOAD_BYTES = 150 * 1024 * 1024;
function maxUploadBytesFor(entityType: string): number {
  return entityType === 'meeting_recording' ? MAX_AUDIO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

/** Small, in-memory token→userId cache to avoid hitting /auth/v1/user on every request. */
const tokenCache = new Map<string, { userId: string; expires: number }>();
const TOKEN_CACHE_TTL_MS = 60_000;

/** Thrown by helpers to short-circuit a request with a specific HTTP status. */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const context = createContext(request, env);

    if (request.method === 'OPTIONS') {
      return handleOptions(context);
    }

    try {
      return await routeRequest(request, env, context);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.message, error.status, context);
      }
      console.error('media-api unhandled error', {
        requestId: context.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('Internal server error', 500, context);
    }
  },
};

async function routeRequest(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const { pathname } = context.url;
  const { method } = request;

  if (method === 'GET' && pathname === '/health') {
    return jsonResponse(
      { status: 'ok', service: 'resofly-media-api', environment: normalizeEnvironment(env.APP_ENV) },
      200,
      context,
    );
  }

  // ── User-facing attachment routes (Supabase JWT) ───────────────────────
  if (method === 'POST' && pathname === '/upload') {
    return handleUserUpload(request, env, context);
  }

  const fileKey = matchFileRoute(pathname);
  if (fileKey) {
    if (method === 'GET') return handleUserDownload(request, env, context, fileKey);
    if (method === 'DELETE') return handleUserDelete(request, env, context, fileKey);
    return errorResponse('Method not allowed', 405, context);
  }

  // ── Internal PDF snapshot routes (shared secret) ───────────────────────
  if (method === 'POST' && pathname === '/internal/invoice-snapshot') {
    return handleInternalUpload(request, env, context);
  }
  const snapshotKey = matchInternalSnapshotRoute(pathname);
  if (snapshotKey) {
    if (method === 'GET') return handleInternalDownload(request, env, context, snapshotKey);
    return errorResponse('Method not allowed', 405, context);
  }

  // ── Internal media fetch (shared secret) — laat de edge-functie audiobytes
  //    server-side ophalen voor transcriptie zonder ze via de browser te sturen.
  const mediaKey = matchInternalMediaRoute(pathname);
  if (mediaKey) {
    if (method === 'GET') return handleInternalDownload(request, env, context, mediaKey);
    return errorResponse('Method not allowed', 405, context);
  }

  return errorResponse('Route not found', 404, context);
}

// ── Route handlers ───────────────────────────────────────────────────────

async function handleUserUpload(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);

  const organizationId = (request.headers.get('x-organization-id') || '').trim();
  const entityType = (request.headers.get('x-entity-type') || '').trim();
  const entityId = (request.headers.get('x-entity-id') || '').trim();
  const fileName = sanitizeFileName(decodeMaybe(request.headers.get('x-file-name')) || 'bestand');
  const contentType = (request.headers.get('x-file-type') || 'application/octet-stream').trim();

  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige of ontbrekende organization id.');
  if (!ENTITY_TYPES.has(entityType)) throw new HttpError(400, 'Ongeldig entity type.');
  if (!isUuid(entityId)) throw new HttpError(400, 'Ongeldige of ontbrekende entity id.');

  const maxBytes = maxUploadBytesFor(entityType);
  const declaredSize = Number(request.headers.get('content-length') || '0');
  if (declaredSize > maxBytes) {
    throw new HttpError(413, `Bestand is te groot. Maximum is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  if (!request.body) throw new HttpError(400, 'Lege upload.');

  await requireMembership(env, organizationId, userId);

  const key = `${organizationId}/${entityType}/${entityId}/${crypto.randomUUID()}-${fileName}`;

  const object = await env.MEDIA_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      name: fileName,
      organizationId,
      entityType,
      entityId,
      uploadedBy: userId,
      uploadedAt: new Date().toISOString(),
    },
  });

  // Defensive: enforce the size limit even when Content-Length was absent/spoofed.
  if (object.size > maxBytes) {
    await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
    throw new HttpError(413, `Bestand is te groot. Maximum is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }

  return jsonResponse({ ok: true, key }, 200, context);
}

async function handleUserDownload(
  request: Request,
  env: Env,
  context: RouteContext,
  key: string,
): Promise<Response> {
  const userId = await requireUser(request, env);
  await requireMembership(env, organizationFromKey(key), userId);

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) throw new HttpError(404, 'Bestand niet gevonden.');

  return streamObject(object, context);
}

async function handleUserDelete(
  request: Request,
  env: Env,
  context: RouteContext,
  key: string,
): Promise<Response> {
  const userId = await requireUser(request, env);
  await requireMembership(env, organizationFromKey(key), userId);

  await env.MEDIA_BUCKET.delete(key);
  return jsonResponse({ ok: true }, 200, context);
}

async function handleInternalUpload(request: Request, env: Env, context: RouteContext): Promise<Response> {
  requireInternalSecret(request, env);

  const key = (request.headers.get('x-storage-key') || '').trim();
  if (!key || !isSafeStorageKey(key)) throw new HttpError(400, 'Ongeldige of ontbrekende X-Storage-Key.');
  if (!request.body) throw new HttpError(400, 'Lege upload.');

  const contentType = (request.headers.get('content-type') || 'application/pdf').trim();
  const sha256 = request.headers.get('x-sha256') || undefined;

  const object = await env.MEDIA_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      source: 'internal-snapshot',
      ...(sha256 ? { sha256 } : {}),
      uploadedAt: new Date().toISOString(),
    },
  });

  return jsonResponse({ ok: true, key, size: object.size }, 200, context);
}

async function handleInternalDownload(
  request: Request,
  env: Env,
  context: RouteContext,
  key: string,
): Promise<Response> {
  requireInternalSecret(request, env);

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) throw new HttpError(404, 'Snapshot niet gevonden.');

  return streamObject(object, context);
}

// ── Auth helpers ───────────────────────────────────────────────────────────

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new HttpError(401, 'Authenticatie vereist.');
  return match[1].trim();
}

/** Validate the Supabase user JWT via the Auth API and return the user id. */
async function requireUser(request: Request, env: Env): Promise<string> {
  const token = bearerToken(request);

  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.userId;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, 'Server niet geconfigureerd (Supabase).');
  }

  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!response.ok) throw new HttpError(401, 'Ongeldige of verlopen sessie.');

  const user = (await response.json()) as { id?: string };
  if (!user.id) throw new HttpError(401, 'Sessie zonder gebruiker.');

  tokenCache.set(token, { userId: user.id, expires: Date.now() + TOKEN_CACHE_TTL_MS });
  return user.id;
}

/** Ensure the user is a member of the organization that owns the object. */
async function requireMembership(env: Env, organizationId: string, userId: string): Promise<void> {
  if (!isUuid(organizationId)) throw new HttpError(403, 'Geen toegang tot dit bestand.');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, 'Server niet geconfigureerd (Supabase).');
  }

  const query = new URLSearchParams({
    select: 'user_id',
    organization_id: `eq.${organizationId}`,
    user_id: `eq.${userId}`,
    limit: '1',
  });
  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/organization_members?${query.toString()}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: 'application/json',
      },
    },
  );
  if (!response.ok) throw new HttpError(502, 'Kon lidmaatschap niet verifiëren.');

  const rows = (await response.json()) as unknown[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new HttpError(403, 'Geen toegang tot dit bestand.');
  }
}

function requireInternalSecret(request: Request, env: Env): void {
  if (!env.INTERNAL_UPLOAD_SECRET) throw new HttpError(500, 'Interne uploadroute niet geconfigureerd.');
  const token = bearerToken(request);
  if (!timingSafeEqual(token, env.INTERNAL_UPLOAD_SECRET)) {
    throw new HttpError(403, 'Ongeldig intern token.');
  }
}

// ── Key + response helpers ──────────────────────────────────────────────────

function organizationFromKey(key: string): string {
  return key.split('/')[0] ?? '';
}

/** Reject path traversal and absolute keys; allow the org-scoped key shapes we generate. */
function isSafeStorageKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.includes('..') || key.startsWith('/')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(key);
}

function streamObject(object: R2ObjectBody, context: RouteContext): Response {
  const headers = new Headers(context.corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Request-Id', context.requestId);
  const name = object.customMetadata?.name;
  if (name) headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  return new Response(object.body, { status: 200, headers });
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'bestand';
  // Space-free, safe charset so generated keys always satisfy isSafeStorageKey().
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '');
  return (cleaned || 'bestand').slice(0, 200);
}

function decodeMaybe(value: string | null): string {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i];
  return result === 0;
}

// ── Generic helpers (CORS / responses / routing) ────────────────────────────

function createContext(request: Request, env: Env): RouteContext {
  return {
    requestId: crypto.randomUUID(),
    url: new URL(request.url),
    corsHeaders: createCorsHeaders(request, env),
  };
}

function handleOptions(context: RouteContext): Response {
  return new Response(null, { status: 204, headers: context.corsHeaders });
}

function jsonResponse(body: JsonBody, status: number, context: RouteContext): Response {
  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Request-Id', context.requestId);
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(message: string, status: number, context: RouteContext): Response {
  return jsonResponse({ error: message, status, requestId: context.requestId }, status, context);
}

function createCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const allowedOrigin = resolveAllowedOrigin(request.headers.get('Origin'), env);
  if (allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  headers.set('Access-Control-Max-Age', MAX_AGE_SECONDS);
  headers.set('Vary', 'Origin');
  return headers;
}

function resolveAllowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  return getAllowedOrigins(env).has(origin) ? origin : null;
}

function getAllowedOrigins(env: Env): Set<string> {
  const configured = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = new Set(configured);
  const appEnv = normalizeEnvironment(env.APP_ENV);
  if (appEnv === 'local' || appEnv === 'staging') origins.add('http://localhost:5173');
  return origins;
}

function normalizeEnvironment(value: string | undefined): 'local' | 'staging' | 'production' {
  if (value === 'staging' || value === 'production') return value;
  return 'local';
}

/** `/file/{key}` — key may contain slashes (org/entity/id/file). */
function matchFileRoute(pathname: string): string | null {
  const match = pathname.match(/^\/file\/(.+)$/);
  if (!match?.[1]) return null;
  const key = decodeURIComponent(match[1]);
  return isSafeStorageKey(key) ? key : null;
}

/** `/internal/invoice-snapshot/{key}` */
function matchInternalSnapshotRoute(pathname: string): string | null {
  const match = pathname.match(/^\/internal\/invoice-snapshot\/(.+)$/);
  if (!match?.[1]) return null;
  const key = decodeURIComponent(match[1]);
  return isSafeStorageKey(key) ? key : null;
}

/** `/internal/media/{key}` — generieke, met intern secret beveiligde objectophaal. */
function matchInternalMediaRoute(pathname: string): string | null {
  const match = pathname.match(/^\/internal\/media\/(.+)$/);
  if (!match?.[1]) return null;
  const key = decodeURIComponent(match[1]);
  return isSafeStorageKey(key) ? key : null;
}
