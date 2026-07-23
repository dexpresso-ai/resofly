export interface Env {
  MEDIA_BUCKET: R2Bucket;
  APP_ENV: string;
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Shared secret for server-side (Edge Function) PDF snapshot storage. */
  INTERNAL_UPLOAD_SECRET?: string;
  /** HMAC-secret voor korte office-edit-tokens (WOPI access_token). */
  MEDIA_SIGNING_SECRET?: string;
  /** Publieke URL van de office-server Worker (Collabora), voor WOPI-discovery + editor-URL. */
  COLLABORA_URL?: string;
  /** Service binding naar de office-server: Worker→Worker via workers.dev is geblokkeerd op hetzelfde account. */
  OFFICE_SERVER?: Fetcher;
  /** Optionele override voor de eigen publieke basis-URL (host in de WOPISrc). Standaard: request-origin. */
  MEDIA_PUBLIC_URL?: string;
}

type JsonBody = Record<string, unknown> | Array<unknown>;

type RouteContext = {
  requestId: string;
  url: URL;
  corsHeaders: Headers;
  /** Laat werk doorlopen ná de response (ExecutionContext.waitUntil) — voor de office-warmup. */
  waitUntil: (promise: Promise<unknown>) => void;
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
  'chat_message',
  // Boekhouding: originele inkoopfactuur als bewijsstuk, plus leverancier-/activabijlagen
  // en cloud-drive-mappen (de DB-constraint op attachments.entity_type staat deze al toe).
  'purchase_invoice',
  'supplier',
  'folder',
  'fixed_asset',
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const context = createContext(request, env, ctx);

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

  // ── Online Office-bewerken (Collabora via WOPI) ────────────────────────
  // Boot-health: bewijst zonder login dat media-api de Collabora-discovery kan bereiken
  // (via de service binding). Lekt niets — alleen ok/fail.
  if (method === 'GET' && pathname === '/office/health') {
    try {
      const xml = await collaboraDiscovery(env);
      return jsonResponse({ ok: true, discovery: xml.includes('urlsrc') ? 'ok' : 'unexpected-body' }, 200, context);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'onbekende fout';
      return jsonResponse({ ok: false, discovery: 'failed', error: message }, 502, context);
    }
  }
  // App-gerichte routes (Supabase-JWT):
  if (method === 'POST' && pathname === '/office/warmup') {
    return handleOfficeWarmup(request, env, context);
  }
  if (method === 'POST' && pathname === '/office/session') {
    return handleOfficeSession(request, env, context);
  }
  if (method === 'POST' && pathname === '/office/new') {
    return handleOfficeNew(request, env, context);
  }
  if (method === 'POST' && pathname === '/office/document-upload') {
    return handleOfficeDocumentUpload(request, env, context);
  }
  if (method === 'POST' && pathname === '/office/document-new') {
    return handleOfficeDocumentNew(request, env, context);
  }
  const officeFile = pathname.match(/^\/office\/document-file\/([^/]+)$/);
  if (officeFile) {
    if (!isUuid(officeFile[1])) return errorResponse('Ongeldige document-id.', 400, context);
    if (method === 'GET') return handleOfficeDocumentDownload(request, env, context, officeFile[1]);
    return errorResponse('Method not allowed', 405, context);
  }
  // WOPI-host-routes (Collabora → media-api, geauthenticeerd met een edit-token in de URL):
  const wopi = pathname.match(/^\/wopi\/files\/([^/]+?)(\/contents)?$/);
  if (wopi) {
    const id = wopi[1];
    const isContents = Boolean(wopi[2]);
    if (!isUuid(id)) return errorResponse('Ongeldige bestand-id.', 400, context);
    if (isContents) {
      if (method === 'GET') return handleWopiGetFile(request, env, context, id);
      if (method === 'POST') return handleWopiPutFile(request, env, context, id);
      return errorResponse('Method not allowed', 405, context);
    }
    if (method === 'GET') return handleWopiCheckFileInfo(request, env, context, id);
    if (method === 'POST') return handleWopiOperation(request, env, context, id);
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

// ── Online Office-bewerken (Collabora via WOPI) ─────────────────────────────
//
// De media-api Worker is de WOPI-HOST. Collabora (op de office-server Worker) is de
// WOPI-client. Flow:
//   1. Browser → POST /office/session (Supabase-JWT). We verifiëren lidmaatschap,
//      munten een kort HMAC-token (gebonden aan bestand + gebruiker + schrijfrecht) en
//      geven de Collabora-editor-URL terug (via WOPI-discovery).
//   2. Collabora → GET /wopi/files/{id}            (CheckFileInfo) — metadata.
//   3. Collabora → GET /wopi/files/{id}/contents   (GetFile)      — bytes uit R2.
//   4. Collabora → POST /wopi/files/{id}/contents  (PutFile)      — bewerkte bytes → R2,
//      versie + last_edited bijgewerkt.
// Het token in de URL (access_token) is de capability; elke WOPI-handler verifieert het
// en controleert dat het bij exact dit bestand + deze organisatie hoort.

/** Office-mimetypes die we in de browser laten bewerken (Collabora/LibreOffice-engine). */
const OFFICE_MIME_EXT: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
};

/** Mimetype per nieuw-aan-te-maken office-type. */
const OFFICE_NEW_MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 10 uur — dekt ruim een lange bewerksessie zonder token-vernieuwing. */
const OFFICE_TOKEN_TTL_MS = 10 * 60 * 60 * 1000;
/** Office-bestanden met afbeeldingen kunnen groter zijn dan de 25 MB upload-cap. */
const OFFICE_MAX_BYTES = 50 * 1024 * 1024;

type OfficeTokenPayload = { fid: string; org: string; uid: string; w: boolean; exp: number; nm?: string; k?: 'a' | 'd' };

function officeSecret(env: Env): string {
  if (!env.MEDIA_SIGNING_SECRET) throw new HttpError(500, 'Office-bewerken niet geconfigureerd (MEDIA_SIGNING_SECRET).');
  return env.MEDIA_SIGNING_SECRET;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToStr(value: string): string {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function signOfficeToken(payload: OfficeTokenPayload, secret: string): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyOfficeToken(token: string, secret: string): Promise<OfficeTokenPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body))));
  if (!timingSafeEqual(providedSig, expectedSig)) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToStr(body)) as OfficeTokenPayload;
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!isUuid(payload.fid) || !isUuid(payload.org) || !isUuid(payload.uid)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Verifieer het WOPI-access_token uit de query en controleer dat het bij dit bestand hoort. */
async function requireOfficeToken(request: Request, env: Env, id: string): Promise<OfficeTokenPayload> {
  const secret = officeSecret(env);
  const token = new URL(request.url).searchParams.get('access_token') || '';
  const payload = token ? await verifyOfficeToken(token, secret) : null;
  if (!payload) throw new HttpError(401, 'Ongeldig of verlopen office-token.');
  if (payload.fid !== id) throw new HttpError(403, 'Token hoort niet bij dit bestand.');
  return payload;
}

// ── Supabase REST-helpers (service-role, net als requireMembership) ──────────

type AttachmentRow = {
  id: string; organization_id: string; entity_type: string; entity_id: string;
  storage_key: string; name: string; mime_type: string; size_bytes: number; edit_version: number | null;
};

function supabaseBase(env: Env): string {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, 'Server niet geconfigureerd (Supabase).');
  return env.SUPABASE_URL.replace(/\/$/, '');
}

function serviceHeaders(env: Env, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
    accept: 'application/json',
    ...(extra || {}),
  };
}

async function fetchAttachment(env: Env, id: string): Promise<AttachmentRow> {
  const query = new URLSearchParams({
    select: 'id,organization_id,entity_type,entity_id,storage_key,name,mime_type,size_bytes,edit_version',
    id: `eq.${id}`,
    limit: '1',
  });
  const res = await fetch(`${supabaseBase(env)}/rest/v1/attachments?${query.toString()}`, { headers: serviceHeaders(env) });
  if (!res.ok) throw new HttpError(502, 'Kon bijlage niet ophalen.');
  const rows = (await res.json()) as AttachmentRow[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) throw new HttpError(404, 'Bestand niet gevonden.');
  return row;
}

async function patchAttachment(env: Env, id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${supabaseBase(env)}/rest/v1/attachments?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: serviceHeaders(env, { 'content-type': 'application/json', prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new HttpError(502, 'Kon bijlage-status niet bijwerken.');
}

/** Best-effort weergavenaam van de ingelogde gebruiker (voor de co-editing-labels in Collabora). */
async function fetchUserName(request: Request, env: Env, fallback: string): Promise<string> {
  try {
    const token = bearerToken(request);
    const res = await fetch(`${supabaseBase(env)}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY! },
    });
    if (!res.ok) return fallback;
    const u = (await res.json()) as { email?: string; user_metadata?: { full_name?: string; name?: string } };
    return u.user_metadata?.full_name || u.user_metadata?.name || u.email || fallback;
  } catch {
    return fallback;
  }
}

/** Rol van de gebruiker binnen de organisatie, of null als geen (actief) lid. */
async function membershipRole(env: Env, organizationId: string, userId: string): Promise<string | null> {
  if (!isUuid(organizationId)) return null;
  const query = new URLSearchParams({
    select: 'role',
    organization_id: `eq.${organizationId}`,
    user_id: `eq.${userId}`,
    limit: '1',
  });
  const res = await fetch(`${supabaseBase(env)}/rest/v1/organization_members?${query.toString()}`, { headers: serviceHeaders(env) });
  if (!res.ok) throw new HttpError(502, 'Kon lidmaatschap niet verifiëren.');
  const rows = (await res.json()) as Array<{ role?: string }>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row?.role ?? null;
}

// ── Office-doel: attachment OF document (Word-modus) ────────────────────────
//
// De WOPI-laag bedient twee bronnen: geüploade `attachments` (kind 'a') én interne
// `documents` in Word-modus (kind 'd', `documents.storage_key` gezet). Het edit-token
// draagt de soort mee zodat GetFile/PutFile de juiste tabel raadplegen/bijwerken.

type OfficeKind = 'a' | 'd';
type OfficeTarget = { organization_id: string; storage_key: string; name: string; mime_type: string; size_bytes: number; edit_version: number };

/** Normaliseer een attachment- of document-rij naar één office-doelvorm. */
async function fetchOfficeTarget(env: Env, kind: OfficeKind, id: string): Promise<OfficeTarget> {
  if (kind === 'd') {
    const query = new URLSearchParams({
      select: 'organization_id,title,storage_key,mime_type,size_bytes,edit_version',
      id: `eq.${id}`,
      limit: '1',
    });
    const res = await fetch(`${supabaseBase(env)}/rest/v1/documents?${query.toString()}`, { headers: serviceHeaders(env) });
    if (!res.ok) throw new HttpError(502, 'Kon document niet ophalen.');
    const rows = (await res.json()) as Array<{ organization_id: string; title: string; storage_key: string | null; mime_type: string | null; size_bytes: number | null; edit_version: number | null }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) throw new HttpError(404, 'Document niet gevonden.');
    if (!row.storage_key) throw new HttpError(409, 'Dit document is geen Word-document.');
    const mime = row.mime_type || OFFICE_NEW_MIME.docx;
    const ext = OFFICE_MIME_EXT[mime] || 'docx';
    const title = (row.title || 'Document').replace(/[\\/]+/g, ' ').trim() || 'Document';
    return {
      organization_id: row.organization_id,
      storage_key: row.storage_key,
      name: title.toLowerCase().endsWith(`.${ext}`) ? title : `${title}.${ext}`,
      mime_type: mime,
      size_bytes: row.size_bytes ?? 0,
      edit_version: row.edit_version ?? 1,
    };
  }
  const att = await fetchAttachment(env, id);
  return {
    organization_id: att.organization_id,
    storage_key: att.storage_key,
    name: att.name,
    mime_type: att.mime_type,
    size_bytes: att.size_bytes,
    edit_version: att.edit_version ?? 1,
  };
}

/** Werk edit-state bij op de juiste tabel (attachments of documents). */
async function patchOfficeTarget(env: Env, kind: OfficeKind, id: string, patch: Record<string, unknown>): Promise<void> {
  if (kind === 'd') {
    const res = await fetch(`${supabaseBase(env)}/rest/v1/documents?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(env, { 'content-type': 'application/json', prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new HttpError(502, 'Kon document-status niet bijwerken.');
    return;
  }
  await patchAttachment(env, id, patch);
}

// ── Collabora WOPI-discovery ─────────────────────────────────────────────────

let discoveryCache: { at: number; xml: string } | null = null;
/** Lopende discovery-fetch — dedupet parallelle aanvragen zodat een koude containerboot
 *  maar één keer wordt afgewacht (en de warmup + sessie-call dezelfde promise delen). */
let discoveryInflight: Promise<string> | null = null;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Haal de discovery-XML op bij de office-server. Dit wékt de Collabora-container als die
 *  slaapt — bij een koude start blokkeert deze fetch tot de container geboot is. */
async function fetchDiscoveryXml(env: Env): Promise<string> {
  const url = `${env.COLLABORA_URL!.replace(/\/$/, '')}/hosting/discovery`;
  // Via de service binding: een gewone fetch naar de workers.dev-URL van een Worker op
  // hetzelfde account wordt door Cloudflare geblokkeerd; de binding is de interne route.
  const res = env.OFFICE_SERVER ? await env.OFFICE_SERVER.fetch(url) : await fetch(url);
  if (!res.ok) throw new HttpError(502, 'Kon Collabora-discovery niet ophalen.');
  const xml = await res.text();
  discoveryCache = { at: Date.now(), xml };
  return xml;
}

async function collaboraDiscovery(env: Env): Promise<string> {
  if (!env.COLLABORA_URL) throw new HttpError(500, 'Office-editor niet geconfigureerd (COLLABORA_URL).');
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.xml;
  if (!discoveryInflight) {
    discoveryInflight = fetchDiscoveryXml(env).finally(() => { discoveryInflight = null; });
  }
  return discoveryInflight;
}

function normalizeUrlSrc(u: string): string {
  if (/[?&]$/.test(u)) return u;
  return u.includes('?') ? `${u}&` : `${u}?`;
}

/** Vind de editor-urlsrc voor een extensie uit de discovery-XML (voorkeur voor 'edit'/'view'). */
async function collaboraUrlSrc(env: Env, ext: string, prefer: 'edit' | 'view'): Promise<string> {
  const xml = await collaboraDiscovery(env);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  let preferred: string | undefined;
  let editable: string | undefined;
  let any: string | undefined;
  for (const m of xml.matchAll(/<action\b[^>]*?\/?>/g)) {
    const tag = m[0];
    if (attr(tag, 'ext') !== ext) continue;
    const urlsrc = attr(tag, 'urlsrc');
    if (!urlsrc) continue;
    const name = attr(tag, 'name');
    if (name === prefer && !preferred) preferred = urlsrc;
    if ((name === 'edit' || name === 'view') && !editable) editable = urlsrc;
    if (!any) any = urlsrc;
  }
  const chosen = preferred || editable || any;
  if (!chosen) throw new HttpError(415, 'Collabora ondersteunt dit bestandstype niet.');
  return normalizeUrlSrc(chosen);
}

function fileExt(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

function mediaPublicOrigin(request: Request, env: Env): string {
  return env.MEDIA_PUBLIC_URL ? env.MEDIA_PUBLIC_URL.replace(/\/$/, '') : new URL(request.url).origin;
}

// ── Route-handlers ───────────────────────────────────────────────────────────

// Warmup-throttle per isolate: herhaalde warmups binnen dit venster doen niets extra —
// de container is dan al wakker (of aan het booten) door een eerdere ping.
let lastWarmupAt = 0;
const WARMUP_MIN_INTERVAL_MS = 60_000;

/**
 * Wek de Collabora-container alvast (fire-and-forget). De frontend roept dit aan zodra de
 * gebruiker op een pagina komt waar office-bestanden geopend kunnen worden, zodat een koude
 * containerboot (placement + image + Collabora-start, tientallen seconden) overlapt met het
 * navigeren in plaats van met de klik op het bestand. JWT vereist — anoniem internetverkeer
 * mag onze container niet laten draaien (kosten).
 */
async function handleOfficeWarmup(request: Request, env: Env, context: RouteContext): Promise<Response> {
  await requireUser(request, env);
  if (!env.COLLABORA_URL) return jsonResponse({ ok: false, warming: 'not-configured' }, 200, context);

  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_MIN_INTERVAL_MS) {
    return jsonResponse({ ok: true, warming: 'recent' }, 202, context);
  }
  lastWarmupAt = now;

  // Bewust géén discovery-cache-shortcut: de cache (1 u TTL) kan warm zijn terwijl de
  // container allang weer slaapt — het doel hier is de container zélf raken. De fetch loopt
  // via waitUntil door ná de response; ook als de runtime 'm later afbreekt is de
  // containerstart dan al getriggerd (de boot loopt in de container-DO gewoon door).
  if (!discoveryInflight) {
    discoveryInflight = fetchDiscoveryXml(env).finally(() => { discoveryInflight = null; });
  }
  context.waitUntil(discoveryInflight.catch(() => undefined));
  return jsonResponse({ ok: true, warming: 'started' }, 202, context);
}

/** Bouw een editor-sessie voor een bestaand office-bestand. */
async function handleOfficeSession(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  const secret = officeSecret(env);

  const body = (await request.json().catch(() => ({}))) as { attachmentId?: string; documentId?: string };
  const kind: OfficeKind = body.documentId ? 'd' : 'a';
  const id = ((kind === 'd' ? body.documentId : body.attachmentId) || '').trim();
  if (!isUuid(id)) throw new HttpError(400, kind === 'd' ? 'Ongeldige documentId.' : 'Ongeldige attachmentId.');

  // Start de (bij een koude container trage) discovery alvast, parallel met de DB-checks
  // hieronder — collaboraUrlSrc pakt straks dezelfde in-flight promise. Fouten hier niet
  // fataal: de echte foutafhandeling zit bij collaboraUrlSrc.
  void collaboraDiscovery(env).catch(() => undefined);
  // Weergavenaam parallel ophalen (eigen try/catch — rejectet nooit).
  const displayNamePromise = fetchUserName(request, env, 'ResoFly-gebruiker');

  const target = await fetchOfficeTarget(env, kind, id);
  const role = await membershipRole(env, target.organization_id, userId);
  if (!role) throw new HttpError(403, 'Geen toegang tot dit bestand.');
  const canWrite = role !== 'viewer';

  const ext = OFFICE_MIME_EXT[target.mime_type] || fileExt(target.name);
  if (!ext) throw new HttpError(415, 'Dit bestandstype kan niet online bewerkt worden.');

  const urlsrc = await collaboraUrlSrc(env, ext, canWrite ? 'edit' : 'view');
  const wopiSrc = `${mediaPublicOrigin(request, env)}/wopi/files/${id}`;
  const editorUrl = `${urlsrc}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=nl-NL`;

  const exp = Date.now() + OFFICE_TOKEN_TTL_MS;
  const displayName = await displayNamePromise;
  const accessToken = await signOfficeToken(
    { fid: id, org: target.organization_id, uid: userId, w: canWrite, exp, nm: displayName, k: kind },
    secret,
  );

  return jsonResponse(
    { editorUrl, accessToken, accessTokenTtl: OFFICE_TOKEN_TTL_MS, accessTokenExp: exp, fileName: target.name, canWrite },
    200,
    context,
  );
}

/** Maak een nieuw, leeg office-bestand in een map (kopie van een blanco sjabloon in R2). */
async function handleOfficeNew(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  officeSecret(env); // faal snel als edit-config ontbreekt

  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; folderId?: string; docType?: string; name?: string };
  const organizationId = (body.organizationId || '').trim();
  const folderId = (body.folderId || '').trim();
  const docType = (body.docType || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!isUuid(folderId)) throw new HttpError(400, 'Ongeldige map id.');
  if (!OFFICE_NEW_MIME[docType]) throw new HttpError(400, 'Ongeldig documenttype.');

  const role = await membershipRole(env, organizationId, userId);
  if (!role || role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');

  const templateKey = `_office-templates/blank.${docType}`;
  const template = await env.MEDIA_BUCKET.get(templateKey);
  if (!template) throw new HttpError(500, `Sjabloon ontbreekt (${templateKey}). Seed de blanco sjablonen — zie deploy-runbook.`);

  const cleaned = sanitizeFileName(body.name || 'Nieuw document');
  const base = cleaned.toLowerCase().endsWith(`.${docType}`) ? cleaned.slice(0, -(docType.length + 1)) : cleaned;
  const fileName = `${base || 'Nieuw_document'}.${docType}`;
  const mime = OFFICE_NEW_MIME[docType];
  const key = `${organizationId}/folder/${folderId}/${crypto.randomUUID()}-${fileName}`;

  const object = await env.MEDIA_BUCKET.put(key, template.body, {
    httpMetadata: { contentType: mime },
    customMetadata: {
      name: fileName, organizationId, entityType: 'folder', entityId: folderId,
      uploadedBy: userId, uploadedAt: new Date().toISOString(),
    },
  });

  // De attachments-rij maakt de frontend aan (RLS + created_by = auth.uid()), net als bij
  // een gewone upload. We geven de gegevens terug die daarvoor nodig zijn.
  return jsonResponse(
    { ok: true, key, size_bytes: object.size, mime_type: mime, name: fileName },
    200,
    context,
  );
}

/**
 * Ontvang de .docx-bytes van een Word-document (nieuw of geconverteerd uit rich-text) en
 * schrijf ze naar R2. De `documents`-rij maakt/werkt de frontend zelf bij (RLS + created_by).
 */
async function handleOfficeDocumentUpload(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  officeSecret(env);

  const organizationId = (request.headers.get('x-organization-id') || '').trim();
  const fileName = sanitizeFileName(decodeMaybe(request.headers.get('x-file-name')) || 'document.docx');
  const mime = (request.headers.get('x-file-type') || OFFICE_NEW_MIME.docx).trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  // Documents-in-Office-modus zijn per definitie bewerkbare office-bestanden; weiger de rest
  // zodat een documents-rij nooit naar een willekeurige blob kan wijzen.
  if (!OFFICE_MIME_EXT[mime]) throw new HttpError(415, 'Alleen Word-, Excel- of PowerPoint-bestanden zijn toegestaan.');

  const role = await membershipRole(env, organizationId, userId);
  if (!role || role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');
  if (!request.body) throw new HttpError(400, 'Lege upload.');

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'Lege upload.');
  if (buf.byteLength > OFFICE_MAX_BYTES) {
    throw new HttpError(413, `Bestand is te groot. Maximum is ${Math.round(OFFICE_MAX_BYTES / 1024 / 1024)} MB.`);
  }

  const key = `${organizationId}/document/${crypto.randomUUID()}-${fileName}`;
  const object = await env.MEDIA_BUCKET.put(key, buf, {
    httpMetadata: { contentType: mime },
    customMetadata: { name: fileName, organizationId, entityType: 'document', uploadedBy: userId, uploadedAt: new Date().toISOString() },
  });

  return jsonResponse({ ok: true, key, size_bytes: object.size, mime_type: mime, name: fileName }, 200, context);
}

/**
 * Maak een nieuw, leeg Office-document (kopie van een blanco sjabloon in R2) — Office-modus
 * vanaf het aanmaken, zonder dat de gebruiker eerst zelf een bestand hoeft te uploaden.
 */
async function handleOfficeDocumentNew(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  officeSecret(env); // faal snel als edit-config ontbreekt

  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; docType?: string; name?: string };
  const organizationId = (body.organizationId || '').trim();
  const docType = (body.docType || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!OFFICE_NEW_MIME[docType]) throw new HttpError(400, 'Ongeldig documenttype.');

  const role = await membershipRole(env, organizationId, userId);
  if (!role || role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');

  const templateKey = `_office-templates/blank.${docType}`;
  const template = await env.MEDIA_BUCKET.get(templateKey);
  if (!template) throw new HttpError(500, `Sjabloon ontbreekt (${templateKey}). Seed de blanco sjablonen — zie deploy-runbook.`);

  const cleaned = sanitizeFileName(body.name || 'Nieuw document');
  const base = cleaned.toLowerCase().endsWith(`.${docType}`) ? cleaned.slice(0, -(docType.length + 1)) : cleaned;
  const fileName = `${base || 'Nieuw_document'}.${docType}`;
  const mime = OFFICE_NEW_MIME[docType];
  const key = `${organizationId}/document/${crypto.randomUUID()}-${fileName}`;

  const object = await env.MEDIA_BUCKET.put(key, template.body, {
    httpMetadata: { contentType: mime },
    customMetadata: { name: fileName, organizationId, entityType: 'document', uploadedBy: userId, uploadedAt: new Date().toISOString() },
  });

  // De documents-rij maakt de frontend aan (RLS + created_by = auth.uid()), net als bij
  // een geüploade Office-file.
  return jsonResponse({ ok: true, key, size_bytes: object.size, mime_type: mime, name: fileName }, 200, context);
}

/** Download de originele bytes van een Office-modus document, in het native formaat. */
async function handleOfficeDocumentDownload(request: Request, env: Env, context: RouteContext, id: string): Promise<Response> {
  const userId = await requireUser(request, env);
  const target = await fetchOfficeTarget(env, 'd', id);
  await requireMembership(env, target.organization_id, userId);

  const object = await env.MEDIA_BUCKET.get(target.storage_key);
  if (!object) throw new HttpError(404, 'Bestand niet gevonden.');

  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', target.mime_type || 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Request-Id', context.requestId);
  // target.name volgt de actuele documenttitel (niet de upload-naam van destijds).
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`);
  return new Response(object.body, { status: 200, headers });
}

/** WOPI CheckFileInfo — metadata voor Collabora. */
async function handleWopiCheckFileInfo(request: Request, env: Env, context: RouteContext, id: string): Promise<Response> {
  const token = await requireOfficeToken(request, env, id);
  const target = await fetchOfficeTarget(env, token.k ?? 'a', id);
  if (target.organization_id !== token.org) throw new HttpError(403, 'Token/bestand-mismatch.');

  const appOrigin = getAllowedOrigins(env).values().next().value || '';
  const info = {
    BaseFileName: target.name,
    Size: target.size_bytes,
    Version: String(target.edit_version),
    OwnerId: target.organization_id,
    UserId: token.uid,
    UserFriendlyName: token.nm || 'ResoFly-gebruiker',
    UserCanWrite: token.w,
    UserCanNotWriteRelative: true,
    SupportsUpdate: true,
    SupportsLocks: false,
    PostMessageOrigin: appOrigin,
  };
  return jsonResponse(info, 200, context);
}

/** WOPI GetFile — lever de bytes uit R2 (inline, geen forced download). */
async function handleWopiGetFile(request: Request, env: Env, context: RouteContext, id: string): Promise<Response> {
  const token = await requireOfficeToken(request, env, id);
  const target = await fetchOfficeTarget(env, token.k ?? 'a', id);
  if (target.organization_id !== token.org) throw new HttpError(403, 'Token/bestand-mismatch.');

  const object = await env.MEDIA_BUCKET.get(target.storage_key);
  if (!object) throw new HttpError(404, 'Bestand niet gevonden.');

  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Request-Id', context.requestId);
  return new Response(object.body, { status: 200, headers });
}

/** WOPI PutFile — schrijf de bewerkte bytes terug naar dezelfde R2-key + bump versie. */
async function handleWopiPutFile(request: Request, env: Env, context: RouteContext, id: string): Promise<Response> {
  const token = await requireOfficeToken(request, env, id);
  if (!token.w) throw new HttpError(403, 'Geen schrijfrechten.');
  const kind: OfficeKind = token.k ?? 'a';
  const target = await fetchOfficeTarget(env, kind, id);
  if (target.organization_id !== token.org) throw new HttpError(403, 'Token/bestand-mismatch.');
  if (!request.body) throw new HttpError(400, 'Lege PutFile.');

  // Buffer de body zodat we de grootte kunnen afdwingen vóór het overschrijven van R2. Een
  // pre-check op Content-Length alleen is te omzeilen met chunked transfer (geen lengte).
  // De body is begrensd door Cloudflare's request-limiet; 50 MB past in het Worker-geheugen.
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'Lege PutFile.');
  if (buf.byteLength > OFFICE_MAX_BYTES) {
    throw new HttpError(413, `Bestand is te groot. Maximum is ${Math.round(OFFICE_MAX_BYTES / 1024 / 1024)} MB.`);
  }

  const object = await env.MEDIA_BUCKET.put(target.storage_key, buf, {
    httpMetadata: { contentType: target.mime_type || 'application/octet-stream' },
    customMetadata: {
      name: target.name,
      organizationId: target.organization_id,
      editedBy: token.uid,
      editedAt: new Date().toISOString(),
    },
  });

  const nextVersion = target.edit_version + 1;
  await patchOfficeTarget(env, kind, id, {
    edit_version: nextVersion,
    size_bytes: object.size,
    last_edited_by: token.uid,
    last_edited_at: new Date().toISOString(),
  });

  const headers = new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-WOPI-ItemVersion', String(nextVersion));
  return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers });
}

/**
 * WOPI-operaties op /wopi/files/{id} (X-WOPI-Override). We adverteren SupportsLocks:false
 * en UserCanNotWriteRelative:true, dus Collabora stuurt normaal geen LOCK/PUT_RELATIVE;
 * we beantwoorden lock-varianten idempotent voor de zekerheid.
 */
async function handleWopiOperation(request: Request, env: Env, context: RouteContext, id: string): Promise<Response> {
  await requireOfficeToken(request, env, id);
  const op = (request.headers.get('x-wopi-override') || '').toUpperCase();
  switch (op) {
    case 'LOCK':
    case 'UNLOCK':
    case 'REFRESH_LOCK':
    case 'GET_LOCK':
      return new Response(null, { status: 200, headers: { 'X-WOPI-Lock': '' } });
    default:
      throw new HttpError(501, `WOPI-operatie niet ondersteund: ${op || 'onbekend'}`);
  }
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

function createContext(request: Request, env: Env, ctx: ExecutionContext): RouteContext {
  return {
    requestId: crypto.randomUUID(),
    url: new URL(request.url),
    corsHeaders: createCorsHeaders(request, env),
    waitUntil: (promise) => ctx.waitUntil(promise),
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
