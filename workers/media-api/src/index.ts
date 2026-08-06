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
  /**
   * Gedeeld geheim voor Collabora's convert-to-endpoint. De office-server laat
   * /cool/convert-to alleen door mét dit geheim — anders is onze render-container
   * een gratis, publieke conversiedienst én een documentparser-aanvalsoppervlak.
   */
  OFFICE_CONVERT_SECRET?: string;
  /** Optionele override voor de eigen publieke basis-URL (host in de WOPISrc). Standaard: request-origin. */
  MEDIA_PUBLIC_URL?: string;
  /** Cloudflare Stream (galerij-video's). Zonder deze twee valt video-upload terug op R2. */
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  /** Stream signing key voor signed playback-tokens (requireSignedURLs). */
  STREAM_SIGNING_KEY_ID?: string;
  /** Private key als JWK: het base64-veld `jwk` uit POST /stream/keys, of de gedecodeerde JSON. */
  STREAM_SIGNING_KEY_JWK?: string;
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
// LET OP: elke header die de frontend meestuurt moet hier staan, anders
// blokkeert de browser het request al bij de preflight — de Worker ziet dat
// niet eens. X-Key/X-Upload-Id/X-Part-Number horen bij /gallery/multipart/part.
const ALLOWED_HEADERS =
  'Content-Type, Authorization, X-File-Name, X-File-Type, X-Organization-Id, X-Entity-Type, X-Entity-Id, X-Parent-Task-Id, X-Storage-Key, X-SHA256, X-Size-Bytes, X-Gallery-Id, X-Item-Id, X-Variant, X-Key, X-Upload-Id, X-Part-Number';
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

  // Contract-PDF's (getekend exemplaar + de bij versturen vastgelegde PDF). De
  // contract-edge-functions schreven hier al naartoe, maar de route ontbrak: die
  // POST liep stil op 404 en viel terug op base64-in-de-database.
  if (method === 'POST' && pathname === '/internal/contract-snapshot') {
    return handleInternalUpload(request, env, context);
  }
  const contractSnapshotKey = matchInternalContractSnapshotRoute(pathname);
  if (contractSnapshotKey) {
    if (method === 'GET') return handleInternalDownload(request, env, context, contractSnapshotKey);
    return errorResponse('Method not allowed', 405, context);
  }

  // Docx → PDF via Collabora, server-side. Alleen intern: de edge-functions
  // maken hiermee de contract-PDF, de browser komt er niet bij.
  if (method === 'POST' && pathname === '/internal/office/convert-pdf') {
    return handleInternalOfficeConvertPdf(request, env, context);
  }

  // ── Internal media fetch (shared secret) — laat de edge-functie audiobytes
  //    server-side ophalen voor transcriptie zonder ze via de browser te sturen.
  const mediaKey = matchInternalMediaRoute(pathname);
  if (mediaKey) {
    if (method === 'GET') return handleInternalDownload(request, env, context, mediaKey);
    return errorResponse('Method not allowed', 405, context);
  }

  // ── Galerij-oplevering (foto/video) ────────────────────────────────────
  // App-routes (Supabase-JWT):
  if (method === 'POST' && pathname === '/gallery/upload') {
    return handleGalleryUpload(request, env, context);
  }
  // Multipart-upload voor grote bestanden (video-masters tot 30 GB). De browser
  // stuurt parts van 64 MiB; groter mag een Worker niet ontvangen.
  if (method === 'POST' && pathname === '/gallery/multipart/create') {
    return handleGalleryMultipartCreate(request, env, context);
  }
  if (method === 'PUT' && pathname === '/gallery/multipart/part') {
    return handleGalleryMultipartPart(request, env, context);
  }
  if (method === 'POST' && pathname === '/gallery/multipart/complete') {
    return handleGalleryMultipartComplete(request, env, context);
  }
  if (method === 'POST' && pathname === '/gallery/multipart/abort') {
    return handleGalleryMultipartAbort(request, env, context);
  }
  // Stream haalt de master zelf op uit R2 — één upload, twee producten.
  if (method === 'POST' && pathname === '/gallery/stream-copy') {
    return handleGalleryStreamCopy(request, env, context);
  }
  // DEPRECATED: directe Stream-upload (tus/basic) vanuit de browser. De huidige
  // frontend uploadt de master naar R2 en laat Stream die kopiëren; deze route
  // blijft staan zodat een nog niet vernieuwd tabblad blijft werken.
  if (method === 'POST' && pathname === '/gallery/stream-upload') {
    return handleGalleryStreamUpload(request, env, context);
  }
  if (method === 'POST' && pathname === '/gallery/stream-status') {
    return handleGalleryStreamStatus(request, env, context);
  }
  if (method === 'POST' && pathname === '/gallery/stream-delete') {
    return handleGalleryStreamDelete(request, env, context);
  }
  if (method === 'POST' && pathname === '/gallery/view-session') {
    return handleGalleryViewSession(request, env, context);
  }
  // Interne route (shared secret): tokenbundels voor portaal + publieke deellink.
  if (method === 'POST' && pathname === '/internal/gallery/tokens') {
    return handleInternalGalleryTokens(request, env, context);
  }
  // Media-serving met galerij-token in de URL (<img>/<video> kunnen geen Bearer sturen):
  const galleryFileKey = matchGalleryFileRoute(pathname);
  if (galleryFileKey) {
    // HEAD hoort erbij: downloaders (en de fetcher van Cloudflare Stream die de
    // master ophaalt) vragen eerst grootte en type op voordat ze beginnen.
    if (method === 'GET' || method === 'HEAD') return handleGalleryFile(request, env, context, galleryFileKey);
    return errorResponse('Method not allowed', 405, context);
  }
  const galleryZip = pathname.match(/^\/gallery\/zip\/([^/]+)$/);
  if (galleryZip) {
    if (!isUuid(galleryZip[1])) return errorResponse('Ongeldige galerij-id.', 400, context);
    if (method === 'GET') return handleGalleryZip(request, env, context, galleryZip[1]);
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
  if (method === 'POST' && pathname === '/office/contract-upload') {
    return handleOfficeContractUpload(request, env, context);
  }
  const contractFile = pathname.match(/^\/office\/contract-file\/([^/]+)$/);
  if (contractFile) {
    if (!isUuid(contractFile[1])) return errorResponse('Ongeldige contract-id.', 400, context);
    if (method === 'GET') return handleOfficeContractDownload(request, env, context, contractFile[1]);
    return errorResponse('Method not allowed', 405, context);
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
  // Accountbreed opslagquotum (GB per abonnement) geldt voor álle gebruikersuploads.
  await assertStorageCapacity(env, organizationId, declaredSize);

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

// ── Galerij-oplevering (foto/video) ─────────────────────────────────────────
//
// Foto's gaan full-res naar R2 (met client-side gegenereerde preview + thumb als
// aparte objecten); video's gaan bij voorkeur naar Cloudflare Stream (adaptieve
// HLS + signed playback) en vallen zonder Stream-secrets terug op R2. Weergave
// loopt via HMAC-tokens in de URL omdat <img>/<video> geen Authorization-header
// kunnen meesturen; het token is gebonden aan één galerij + organisatie en heeft
// een korte levensduur. Downloads (los + zip) vereisen een token met dl-recht.

/** Originele galerijbestanden (foto full-res of video-fallback in R2). R2 single-put ondersteunt ~5 GiB. */
const GALLERY_ORIGINAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** Client-side gegenereerde previews/thumbs horen klein te zijn. */
const GALLERY_DERIVED_MAX_BYTES = 30 * 1024 * 1024;
/**
 * Levensduur van kijk-/downloadtokens. Bewust kort: een token blijft geldig
 * ook nadat de galerij is gedepubliceerd of de deellink is ingetrokken (de
 * media-route doet geen DB-lookup per afbeelding). Alle drie de weergaven
 * (app, portaal, deellink) vernieuwen de bundel automatisch vóór het verloopt.
 */
const GALLERY_TOKEN_TTL_MS = 60 * 60 * 1000;
/**
 * Varianten in de R2-key. `original` = full-res foto (alleen te serveren met
 * een downloadtoken op originele kwaliteit), `master` = het onbewerkte
 * videobestand dat de klant downloadt (Cloudflare Stream geeft het bronbestand
 * nooit terug, dus dít is het archief), `source` = video-bestand voor de oude
 * R2-fallback (moet altijd afspeelbaar zijn, ook met een kijk-token),
 * `preview`/`thumb` = de client-side gegenereerde weergavebestanden.
 */
const GALLERY_VARIANTS = ['original', 'master', 'source', 'preview', 'thumb'];

/**
 * Maximale grootte van een video-master. 30 GB is het plafond dat Cloudflare
 * Stream standaard accepteert; boven die grens kunnen we het bestand wel
 * bewaren maar geen kijkkopie meer maken, dus weigeren we het bewust.
 */
const GALLERY_MASTER_MAX_BYTES = 30 * 1024 * 1024 * 1024;

/**
 * Partgrootte voor multipart-uploads. Een Worker mag maximaal ~100 MB request
 * body ontvangen (Free/Pro), dus 64 MiB past op elk plan. R2 eist minimaal
 * 5 MiB per part, maximaal 10.000 parts en dezelfde grootte voor alle parts
 * behalve de laatste: 30 GB / 64 MiB = 480 parts, ruim binnen de marge.
 */
const GALLERY_MULTIPART_PART_BYTES = 64 * 1024 * 1024;

/**
 * Wat er maximaal in ÉÉN request langs kan. Cloudflare kapt een Worker-request
 * af rond 100 MB; daarboven krijgt de browser een Cloudflare-foutpagina in
 * plaats van onze nette melding. Alles wat groter kan zijn gaat via multipart.
 */
const GALLERY_SINGLE_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

/** Marge bovenop de partgrootte; een part mag nooit groter binnenkomen. */
const GALLERY_MULTIPART_PART_MAX_BYTES = GALLERY_MULTIPART_PART_BYTES + 1024 * 1024;

/**
 * Levensduur van het token waarmee Cloudflare Stream de master bij ons ophaalt.
 * Stream haalt het bestand asynchroon op; ruim genomen zodat een grote master
 * ook bij drukte binnen het venster valt.
 */
const GALLERY_STREAM_COPY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/** Boven deze grootte gebruikt de frontend het tus-protocol voor Stream-uploads. */
const STREAM_BASIC_UPLOAD_MAX_BYTES = 190 * 1024 * 1024;
/** Max videoduur voor Stream-uploads (6 uur). */
const STREAM_MAX_DURATION_SECONDS = 21600;

/**
 * `dl` = downloaden toegestaan, `q` = downloadkwaliteit. Beide worden
 * server-side afgedwongen in handleGalleryFile: een kijk-token (dl=false) of
 * een web-kwaliteit-token krijgt de full-res originelen niet te zien, ook niet
 * als de client de storage_key kent.
 */
type GalleryTokenPayload = {
  t: 'gal'; org: string; gal: string; exp: number; dl: boolean; q: 'original' | 'web';
  /**
   * Optioneel: bindt het token aan één exacte R2-key. Gebruikt voor het token
   * dat Cloudflare Stream meekrijgt om de master op te halen — dat token leeft
   * uren, dus het mag niet ook de rest van de galerij openzetten.
   */
  k?: string;
};

function gallerySecret(env: Env): string {
  if (!env.MEDIA_SIGNING_SECRET) throw new HttpError(500, 'Galerij-links niet geconfigureerd (MEDIA_SIGNING_SECRET).');
  return env.MEDIA_SIGNING_SECRET;
}

async function signGalleryToken(payload: GalleryTokenPayload, secret: string): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyGalleryToken(token: string, secret: string): Promise<GalleryTokenPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body))));
  if (!timingSafeEqual(providedSig, expectedSig)) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToStr(body)) as GalleryTokenPayload;
    if (!payload || payload.t !== 'gal') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!isUuid(payload.org) || !isUuid(payload.gal)) return null;
    // Ontbrekende kwaliteit = de veiligste stand (geen full-res originelen).
    if (payload.q !== 'original') payload.q = 'web';
    return payload;
  } catch {
    return null;
  }
}

async function requireGalleryToken(request: Request, env: Env): Promise<GalleryTokenPayload> {
  const secret = gallerySecret(env);
  const token = new URL(request.url).searchParams.get('token') || '';
  const payload = token ? await verifyGalleryToken(token, secret) : null;
  if (!payload) throw new HttpError(401, 'Ongeldig of verlopen galerij-token.');
  return payload;
}

// ── PostgREST-helpers voor galerijen ────────────────────────────────────────

type GalleryRow = {
  id: string;
  organization_id: string;
  title: string;
  status: string;
  allow_downloads: boolean;
  download_quality: string;
};

async function fetchGalleryRow(env: Env, galleryId: string, organizationId: string): Promise<GalleryRow> {
  const query = new URLSearchParams({
    select: 'id,organization_id,title,status,allow_downloads,download_quality',
    id: `eq.${galleryId}`,
    organization_id: `eq.${organizationId}`,
    limit: '1',
  });
  const res = await fetch(`${supabaseBase(env)}/rest/v1/galleries?${query.toString()}`, { headers: serviceHeaders(env) });
  if (!res.ok) throw new HttpError(502, 'Kon galerij niet ophalen.');
  const rows = (await res.json()) as GalleryRow[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) throw new HttpError(404, 'Galerij niet gevonden.');
  return row;
}

type GalleryItemRow = {
  id: string;
  file_name: string;
  media_type: string;
  storage_key: string | null;
  preview_key: string | null;
  stream_uid: string | null;
};

async function fetchGalleryItemRows(
  env: Env,
  galleryId: string,
  organizationId: string,
  opts?: { onlyStream?: boolean },
): Promise<GalleryItemRow[]> {
  const query = new URLSearchParams({
    select: 'id,file_name,media_type,storage_key,preview_key,stream_uid',
    gallery_id: `eq.${galleryId}`,
    organization_id: `eq.${organizationId}`,
    order: 'sort_order.asc,created_at.asc',
    limit: '20000',
  });
  // Voor de tokenbundel hoeven we alleen video's met een Stream-id te kennen;
  // dat houdt de query klein ook bij galerijen met duizenden foto's.
  if (opts?.onlyStream) query.set('stream_uid', 'not.is.null');
  const res = await fetch(`${supabaseBase(env)}/rest/v1/gallery_items?${query.toString()}`, { headers: serviceHeaders(env) });
  if (!res.ok) throw new HttpError(502, 'Kon galerij-items niet ophalen.');
  const rows = (await res.json()) as GalleryItemRow[];
  return Array.isArray(rows) ? rows : [];
}

/** Eigendomscheck op een Stream-video via onze eigen DB (werkt ook als Stream-meta ontbreekt). */
async function streamUidBelongsToOrg(env: Env, uid: string, organizationId: string): Promise<boolean> {
  const query = new URLSearchParams({
    select: 'id',
    stream_uid: `eq.${uid}`,
    organization_id: `eq.${organizationId}`,
    limit: '1',
  });
  const res = await fetch(`${supabaseBase(env)}/rest/v1/gallery_items?${query.toString()}`, { headers: serviceHeaders(env) });
  if (!res.ok) return false;
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

// ── Accountbreed opslagquotum ───────────────────────────────────────────────

type StorageStatus = { used_bytes: number; limit_bytes: number | null };

/**
 * Vraag het accountbrede verbruik + de limiet op via de RPC. Fail-open bij
 * fouten (bijv. migratie nog niet toegepast): uploads mogen nooit stuk gaan
 * op een kapotte teller — de limiet wordt dan gewoon niet gehandhaafd.
 */
async function fetchStorageStatus(env: Env, organizationId: string): Promise<StorageStatus | null> {
  try {
    const res = await fetch(`${supabaseBase(env)}/rest/v1/rpc/organization_storage_status`, {
      method: 'POST',
      headers: serviceHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ p_organization_id: organizationId }),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ used_bytes: number; limit_bytes: number | null }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row.used_bytes !== 'number') return null;
    return { used_bytes: row.used_bytes, limit_bytes: row.limit_bytes ?? null };
  } catch {
    return null;
  }
}

/** Gooi 413 wanneer de upload het accountbrede opslagquotum zou overschrijden. */
async function assertStorageCapacity(env: Env, organizationId: string, incomingBytes: number): Promise<void> {
  const status = await fetchStorageStatus(env, organizationId);
  if (!status || status.limit_bytes == null) return;
  if (status.used_bytes + Math.max(incomingBytes, 0) > status.limit_bytes) {
    const usedGb = (status.used_bytes / 1073741824).toFixed(1);
    const limitGb = Math.round(status.limit_bytes / 1073741824);
    throw new HttpError(
      413,
      `Opslaglimiet bereikt (${usedGb} van ${limitGb} GB in gebruik). Koop een opslagbundel bij via Instellingen → Abonnement, of ruim bestanden op.`,
    );
  }
}

// ── Creatieve module (abonnementsoptie) ─────────────────────────────────────

/**
 * De galerij hoort bij de creatieve module. Staat die niet aan, dan mag er niets
 * meer bij: geen upload, geen kijkkopie, geen wijziging. Lezen en verwijderen
 * blijven wel werken (bevriezen, niet buitensluiten) — die paden komen hier dus
 * niet langs.
 *
 * Fail-open bij een kapotte of nog niet uitgerolde RPC, net als de opslagmeter:
 * de database dwingt dezelfde regel af met een restrictive policy + trigger, dus
 * een storing hier maakt de module niet gratis — het scheelt alleen de nette
 * foutmelding.
 */
async function assertCreativeModule(env: Env, organizationId: string): Promise<void> {
  let active: boolean | null = null;
  try {
    const res = await fetch(`${supabaseBase(env)}/rest/v1/rpc/organization_creative_status`, {
      method: 'POST',
      headers: serviceHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ p_organization_id: organizationId }),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ active?: boolean }>;
      const row = Array.isArray(rows) ? rows[0] : (rows as { active?: boolean } | undefined);
      if (typeof row?.active === 'boolean') active = row.active;
    }
  } catch {
    active = null;
  }
  if (active === false) {
    throw new HttpError(
      403,
      'De creatieve module staat niet aan voor deze organisatie. Zet hem aan via Instellingen → Abonnement om galerijen te kunnen vullen.',
    );
  }
}

// ── Cloudflare Stream ───────────────────────────────────────────────────────

/**
 * Stream is pas bruikbaar als we óók signed playback-tokens kunnen maken.
 * We laden de signing key echt (niet alleen "is het secret gezet?"): een
 * onbruikbare sleutel zou anders video's naar Stream sturen die daarna nooit
 * afspeelbaar zijn. Bij twijfel valt de upload terug op R2.
 */
async function streamConfigured(env: Env): Promise<boolean> {
  if (!env.STREAM_ACCOUNT_ID || !env.STREAM_API_TOKEN || !env.STREAM_SIGNING_KEY_ID || !env.STREAM_SIGNING_KEY_JWK) return false;
  return (await streamSigningKey(env)) !== null;
}

async function streamApi(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (!env.STREAM_ACCOUNT_ID || !env.STREAM_API_TOKEN) throw new HttpError(500, 'Cloudflare Stream niet geconfigureerd.');
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}${path}`;
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${env.STREAM_API_TOKEN}`);
  return fetch(url, { ...init, headers });
}

let streamKeyCache: { id: string; key: CryptoKey } | null = null;

async function streamSigningKey(env: Env): Promise<{ id: string; key: CryptoKey } | null> {
  if (!env.STREAM_SIGNING_KEY_ID || !env.STREAM_SIGNING_KEY_JWK) return null;
  if (streamKeyCache && streamKeyCache.id === env.STREAM_SIGNING_KEY_ID) return streamKeyCache;
  try {
    const raw = env.STREAM_SIGNING_KEY_JWK.trim();
    const json = raw.startsWith('{') ? raw : atob(raw);
    const jwk = JSON.parse(json) as JsonWebKey;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    streamKeyCache = { id: env.STREAM_SIGNING_KEY_ID, key };
    return streamKeyCache;
  } catch {
    return null;
  }
}

/** Zelf-getekend Stream playback-token (RS256) — geen rate-limits, geen extra API-call. */
async function streamSignedToken(env: Env, uid: string, expUnixSeconds: number, downloadable: boolean): Promise<string | null> {
  const signing = await streamSigningKey(env);
  if (!signing) return null;
  const enc = (value: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const header = { alg: 'RS256', kid: signing.id };
  const payload = { sub: uid, kid: signing.id, exp: expUnixSeconds, ...(downloadable ? { downloadable: true } : {}) };
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signing.key, new TextEncoder().encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ── Tokenbundel (app, portaal én deellink gebruiken dezelfde vorm) ──────────

type GalleryTokenBundle = {
  mediaToken: string;
  streamTokens: Record<string, string>;
  exp: number;
};

async function buildGalleryTokenBundle(
  env: Env,
  organizationId: string,
  galleryId: string,
  allowDownload: boolean,
  quality: 'original' | 'web',
  ttlMs: number,
): Promise<GalleryTokenBundle> {
  const secret = gallerySecret(env);
  const exp = Date.now() + ttlMs;
  const mediaToken = await signGalleryToken(
    { t: 'gal', org: organizationId, gal: galleryId, exp, dl: allowDownload, q: quality },
    secret,
  );

  const streamTokens: Record<string, string> = {};
  const items = await fetchGalleryItemRows(env, galleryId, organizationId, { onlyStream: true });
  const expSeconds = Math.floor(exp / 1000);
  for (const item of items) {
    if (!item.stream_uid) continue;
    const token = await streamSignedToken(env, item.stream_uid, expSeconds, allowDownload);
    if (token) streamTokens[item.stream_uid] = token;
  }

  return { mediaToken, streamTokens, exp };
}

// ── Galerij-routehandlers ───────────────────────────────────────────────────

async function handleGalleryUpload(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);

  const organizationId = (request.headers.get('x-organization-id') || '').trim();
  const galleryId = (request.headers.get('x-gallery-id') || '').trim();
  const itemId = (request.headers.get('x-item-id') || '').trim();
  const variant = (request.headers.get('x-variant') || 'original').trim();
  const fileName = sanitizeFileName(decodeMaybe(request.headers.get('x-file-name')) || 'bestand');
  const contentType = (request.headers.get('x-file-type') || 'application/octet-stream').trim();

  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige of ontbrekende organization id.');
  if (!isUuid(galleryId)) throw new HttpError(400, 'Ongeldige of ontbrekende galerij id.');
  if (!isUuid(itemId)) throw new HttpError(400, 'Ongeldige of ontbrekende item id.');
  if (!GALLERY_VARIANTS.includes(variant)) throw new HttpError(400, 'Ongeldige variant.');
  if (!request.body) throw new HttpError(400, 'Lege upload.');

  const role = await membershipRole(env, organizationId, userId);
  if (!role) throw new HttpError(403, 'Geen toegang tot deze organisatie.');
  if (role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');
  await requireGalleryAccess(env, organizationId, userId, 'write');
  await assertCreativeModule(env, organizationId);

  // Galerij moet bestaan én bij deze organisatie horen (voorkomt key-wedging).
  await fetchGalleryRow(env, galleryId, organizationId);

  // LET OP: deze route neemt het hele bestand in één request aan en loopt dus
  // tegen de Worker-limiet van ~100 MB aan, hoe hoog de variantgrens ook staat.
  // Alles wat groter kan zijn hoort via /gallery/multipart/* te gaan.
  const maxBytes = Math.min(galleryVariantMaxBytes(variant), GALLERY_SINGLE_REQUEST_MAX_BYTES);
  const declaredSize = Number(request.headers.get('content-length') || '0');
  if (declaredSize > maxBytes) {
    throw new HttpError(413, tooLargeMessage(maxBytes));
  }
  // Elke variant telt mee in het quotum — previews/thumbs zijn klein, maar een
  // stroom van 30 MB-derivaten mag de limiet niet alsnog kunnen omzeilen.
  await assertStorageCapacity(env, organizationId, declaredSize);

  const key = `${organizationId}/gallery/${galleryId}/${itemId}/${variant}-${crypto.randomUUID()}-${fileName}`;

  const object = await env.MEDIA_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      name: fileName,
      organizationId,
      entityType: 'gallery',
      entityId: galleryId,
      uploadedBy: userId,
      uploadedAt: new Date().toISOString(),
    },
  });

  // Defensief: dwing de limiet ook af als Content-Length ontbrak of gespooft was.
  if (object.size > maxBytes) {
    await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
    throw new HttpError(413, tooLargeMessage(maxBytes));
  }

  return jsonResponse({ ok: true, key, size: object.size }, 200, context);
}

// ── Multipart-upload (grote bestanden, video-masters) ───────────────────────
//
// De browser knipt het bestand in parts van 64 MiB en stuurt elk part als een
// eigen request. Dat is nodig omdat een Worker maximaal ~100 MB body accepteert:
// de oude route /gallery/upload beloofde 4 GB maar liep in de praktijk al bij
// ~100 MB tegen een Cloudflare-foutpagina aan. Parts mogen parallel en in
// willekeurige volgorde; R2 eist alleen dat álle parts behalve de laatste
// dezelfde grootte hebben.

/** Varianten die groot genoeg zijn om multipart te rechtvaardigen. */
const GALLERY_MULTIPART_VARIANTS = ['master', 'original', 'source'];

/**
 * De vijf controles die elke schrijfactie op een galerij moet doorstaan:
 * ingelogd, lid met schrijfrecht, module 'projects' toegankelijk, de creatieve
 * module staat aan op het abonnement, en de galerij hoort echt bij deze
 * organisatie. Die laatste voorkomt key-wedging: zonder die check kun je in de
 * key-prefix van een andere tenant schrijven.
 */
async function authorizeGalleryWrite(request: Request, env: Env, organizationId: string, galleryId: string): Promise<string> {
  const userId = await requireUser(request, env);
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige of ontbrekende organization id.');
  if (!isUuid(galleryId)) throw new HttpError(400, 'Ongeldige of ontbrekende galerij id.');
  const role = await membershipRole(env, organizationId, userId);
  if (!role) throw new HttpError(403, 'Geen toegang tot deze organisatie.');
  if (role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');
  await requireGalleryAccess(env, organizationId, userId, 'write');
  await assertCreativeModule(env, organizationId);
  await fetchGalleryRow(env, galleryId, organizationId);
  return userId;
}

/** De client geeft de key terug bij elk part; die moet binnen deze galerij liggen. */
function assertGalleryKeyBelongs(key: string, organizationId: string, galleryId: string): void {
  if (!isSafeStorageKey(key)) throw new HttpError(400, 'Ongeldige key.');
  if (!key.startsWith(`${organizationId}/gallery/${galleryId}/`)) {
    throw new HttpError(403, 'Key hoort niet bij deze galerij.');
  }
}

function galleryVariantMaxBytes(variant: string): number {
  if (variant === 'master') return GALLERY_MASTER_MAX_BYTES;
  if (variant === 'original' || variant === 'source') return GALLERY_ORIGINAL_MAX_BYTES;
  return GALLERY_DERIVED_MAX_BYTES;
}

function tooLargeMessage(maxBytes: number): string {
  return maxBytes >= 1073741824
    ? `Bestand is te groot. Maximum is ${Math.round(maxBytes / 1073741824)} GB.`
    : `Bestand is te groot. Maximum is ${Math.round(maxBytes / 1048576)} MB.`;
}

async function handleGalleryMultipartCreate(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string; galleryId?: string; itemId?: string;
    variant?: string; fileName?: string; contentType?: string; fileSize?: number;
  };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  const itemId = (body.itemId || '').trim();
  const variant = (body.variant || 'master').trim();
  const fileName = sanitizeFileName(body.fileName || 'bestand');
  const contentType = (body.contentType || 'application/octet-stream').trim();
  const fileSize = Number(body.fileSize || 0);

  const userId = await authorizeGalleryWrite(request, env, organizationId, galleryId);
  if (!isUuid(itemId)) throw new HttpError(400, 'Ongeldige of ontbrekende item id.');
  if (!GALLERY_MULTIPART_VARIANTS.includes(variant)) throw new HttpError(400, 'Ongeldige variant.');
  if (!Number.isFinite(fileSize) || fileSize <= 0) throw new HttpError(400, 'Ongeldige bestandsgrootte.');

  const maxBytes = galleryVariantMaxBytes(variant);
  if (fileSize > maxBytes) throw new HttpError(413, tooLargeMessage(maxBytes));
  await assertStorageCapacity(env, organizationId, fileSize);

  const key = `${organizationId}/gallery/${galleryId}/${itemId}/${variant}-${crypto.randomUUID()}-${fileName}`;
  const upload = await env.MEDIA_BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: {
      name: fileName,
      organizationId,
      entityType: 'gallery',
      entityId: galleryId,
      uploadedBy: userId,
      uploadedAt: new Date().toISOString(),
    },
  });

  return jsonResponse(
    { ok: true, key, uploadId: upload.uploadId, partSize: GALLERY_MULTIPART_PART_BYTES },
    200,
    context,
  );
}

async function handleGalleryMultipartPart(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const organizationId = (request.headers.get('x-organization-id') || '').trim();
  const galleryId = (request.headers.get('x-gallery-id') || '').trim();
  const key = decodeMaybe(request.headers.get('x-key')) || '';
  const uploadId = decodeMaybe(request.headers.get('x-upload-id')) || '';
  const partNumber = Number(request.headers.get('x-part-number') || '0');

  await authorizeGalleryWrite(request, env, organizationId, galleryId);
  assertGalleryKeyBelongs(key, organizationId, galleryId);
  if (!uploadId) throw new HttpError(400, 'Ontbrekende upload id.');
  // R2 staat 10.000 parts toe; hoger is per definitie een fout aan onze kant.
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new HttpError(400, 'Ongeldig partnummer.');
  }
  if (!request.body) throw new HttpError(400, 'Leeg part.');
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > GALLERY_MULTIPART_PART_MAX_BYTES) throw new HttpError(413, 'Part is te groot.');

  const upload = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return jsonResponse({ ok: true, partNumber: part.partNumber, etag: part.etag }, 200, context);
}

async function handleGalleryMultipartComplete(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string; galleryId?: string; key?: string; uploadId?: string;
    parts?: Array<{ partNumber?: number; etag?: string }>;
  };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  const key = (body.key || '').trim();
  const uploadId = (body.uploadId || '').trim();

  await authorizeGalleryWrite(request, env, organizationId, galleryId);
  assertGalleryKeyBelongs(key, organizationId, galleryId);
  if (!uploadId) throw new HttpError(400, 'Ontbrekende upload id.');

  const parts = (body.parts || []).map(part => ({
    partNumber: Number(part?.partNumber),
    etag: String(part?.etag ?? ''),
  }));
  if (parts.length === 0 || parts.some(p => !Number.isInteger(p.partNumber) || p.partNumber < 1 || !p.etag)) {
    throw new HttpError(400, 'Ongeldige partlijst.');
  }

  const upload = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
  const object = await upload.complete(parts);

  // Pas hier is de werkelijke omvang bekend: een client die bij het aanmaken
  // een kleine fileSize opgaf en daarna méér parts stuurt, wordt hier alsnog
  // gepakt — inclusief opruimen, anders blijven de bytes in R2 achter.
  const maxBytes = galleryVariantMaxBytes(galleryVariantFromKey(key));
  if (object.size > maxBytes) {
    await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
    throw new HttpError(413, tooLargeMessage(maxBytes));
  }

  return jsonResponse({ ok: true, key, size: object.size }, 200, context);
}

async function handleGalleryMultipartAbort(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string; galleryId?: string; key?: string; uploadId?: string;
  };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  const key = (body.key || '').trim();
  const uploadId = (body.uploadId || '').trim();

  await authorizeGalleryWrite(request, env, organizationId, galleryId);
  assertGalleryKeyBelongs(key, organizationId, galleryId);
  if (!uploadId) throw new HttpError(400, 'Ontbrekende upload id.');

  // Mislukt afbreken is niet erg: R2 ruimt onvoltooide uploads na 7 dagen zelf op.
  await env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId).abort().catch(() => undefined);
  return jsonResponse({ ok: true }, 200, context);
}

/**
 * Laat Cloudflare Stream de master ophalen uit R2 en er een kijkkopie van maken.
 * Zo uploadt de gebruiker één keer: R2 bewaart het origineel (dát downloadt de
 * klant), Stream levert het afspelen. Het token dat Stream meekrijgt is aan deze
 * ene key gebonden, zodat het uren mag leven zonder de galerij open te zetten.
 */
async function handleGalleryStreamCopy(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string; galleryId?: string; key?: string; fileName?: string;
  };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  const key = (body.key || '').trim();
  const fileName = sanitizeFileName(body.fileName || 'video');

  await authorizeGalleryWrite(request, env, organizationId, galleryId);
  assertGalleryKeyBelongs(key, organizationId, galleryId);

  // Zonder volledige Stream-configuratie is er geen kijkkopie; de master staat
  // er wel. De frontend meldt dat dan aan de gebruiker.
  if (!(await streamConfigured(env))) {
    return jsonResponse({ ok: true, mode: 'r2' }, 200, context);
  }

  const head = await env.MEDIA_BUCKET.head(key);
  if (!head) throw new HttpError(404, 'Bestand niet gevonden.');
  if (head.size > GALLERY_MASTER_MAX_BYTES) throw new HttpError(413, tooLargeMessage(GALLERY_MASTER_MAX_BYTES));

  const exp = Date.now() + GALLERY_STREAM_COPY_TOKEN_TTL_MS;
  const token = await signGalleryToken(
    { t: 'gal', org: organizationId, gal: galleryId, exp, dl: true, q: 'original', k: key },
    gallerySecret(env),
  );
  // Pin de host: Stream belt ons terug, dus de URL moet publiek kloppen ook als
  // het request via een ander domein binnenkwam.
  const base = (env.MEDIA_PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '');
  const sourceUrl = `${base}/gallery/file/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;

  const res = await streamApi(env, '/stream/copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: sourceUrl,
      requireSignedURLs: true,
      meta: { name: fileName, organizationId, galleryId },
    }),
  });
  if (!res.ok) throw new HttpError(502, 'Kon de kijkkopie bij Stream niet starten.');
  const json = (await res.json()) as { result?: { uid?: string } };
  if (!json.result?.uid) throw new HttpError(502, 'Onverwacht Stream-antwoord (copy).');

  return jsonResponse({ ok: true, mode: 'stream', uid: json.result.uid }, 200, context);
}

/** Vraag een directe upload-URL bij Cloudflare Stream aan (of meld R2-fallback). */
async function handleGalleryStreamUpload(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);

  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string; galleryId?: string; fileName?: string; fileSize?: number;
  };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  const fileName = sanitizeFileName(body.fileName || 'video');
  const fileSize = Number(body.fileSize || 0);

  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!isUuid(galleryId)) throw new HttpError(400, 'Ongeldige galerij id.');
  if (!Number.isFinite(fileSize) || fileSize <= 0) throw new HttpError(400, 'Ongeldige bestandsgrootte.');

  const role = await membershipRole(env, organizationId, userId);
  if (!role || role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');
  await requireGalleryAccess(env, organizationId, userId, 'write');
  await assertCreativeModule(env, organizationId);
  await fetchGalleryRow(env, galleryId, organizationId);

  // Zonder volledige Stream-configuratie (incl. bruikbare signing key) valt video terug op R2.
  if (!(await streamConfigured(env))) {
    return jsonResponse({ ok: true, mode: 'r2' }, 200, context);
  }

  await assertStorageCapacity(env, organizationId, fileSize);

  if (fileSize <= STREAM_BASIC_UPLOAD_MAX_BYTES) {
    const res = await streamApi(env, '/stream/direct_upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxDurationSeconds: STREAM_MAX_DURATION_SECONDS,
        requireSignedURLs: true,
        meta: { name: fileName, organizationId, galleryId },
      }),
    });
    if (!res.ok) throw new HttpError(502, 'Kon Stream-upload niet starten.');
    const json = (await res.json()) as { result?: { uploadURL?: string; uid?: string } };
    if (!json.result?.uploadURL || !json.result?.uid) throw new HttpError(502, 'Onverwacht Stream-antwoord.');
    return jsonResponse({ ok: true, mode: 'stream-basic', uploadURL: json.result.uploadURL, uid: json.result.uid }, 200, context);
  }

  // tus voor grote bestanden: één creatie-call hier, de browser PATCH't daarna
  // rechtstreeks (en hervattbaar) naar de eenmalige upload-URL.
  const b64 = (value: string) => btoa(value);
  const res = await streamApi(env, '/stream?direct_user=true', {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': `requiresignedurls,maxDurationSeconds ${b64(String(STREAM_MAX_DURATION_SECONDS))},name ${b64(fileName)}`,
    },
  });
  if (!res.ok && res.status !== 201) throw new HttpError(502, 'Kon Stream-upload (tus) niet starten.');
  const uploadURL = res.headers.get('location');
  const uid = res.headers.get('stream-media-id');
  if (!uploadURL || !uid) throw new HttpError(502, 'Onverwacht Stream-antwoord (tus).');

  // tus-Upload-Metadata kent geen eigen sleutels zoals organizationId, dus zetten
  // we de meta direct na het aanmaken alsnog server-side. Zonder deze stap zou de
  // tenant-check in stream-status/stream-delete elke tus-video afwijzen.
  context.waitUntil(
    streamApi(env, `/stream/${uid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { name: fileName, organizationId, galleryId } }),
    }).catch(() => undefined),
  );

  return jsonResponse({ ok: true, mode: 'stream-tus', uploadURL, uid }, 200, context);
}

/**
 * Eigendomscheck op een Stream-video. Primair via de meta die wij bij het
 * aanmaken zetten; ontbreekt die (tus-race, meta-patch mislukt), dan valt de
 * check terug op onze eigen database. Zo kan een video nooit van een andere
 * organisatie zijn, én blijven eigen video's altijd beheerbaar.
 */
async function assertStreamVideoBelongsToOrg(env: Env, uid: string, organizationId: string, meta: Record<string, string> | undefined): Promise<void> {
  if (meta?.organizationId === organizationId) return;
  if (meta?.organizationId && meta.organizationId !== organizationId) {
    throw new HttpError(403, 'Video hoort niet bij deze organisatie.');
  }
  if (await streamUidBelongsToOrg(env, uid, organizationId)) return;
  throw new HttpError(403, 'Video hoort niet bij deze organisatie.');
}

/** Poll de verwerkingsstatus van een Stream-video en geef de playback-basis terug. */
async function handleGalleryStreamStatus(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; uid?: string };
  const organizationId = (body.organizationId || '').trim();
  const uid = (body.uid || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!uid || !/^[a-f0-9]{32}$/i.test(uid)) throw new HttpError(400, 'Ongeldige video-id.');
  await requireMembership(env, organizationId, userId);
  await requireGalleryAccess(env, organizationId, userId, 'read');

  const res = await streamApi(env, `/stream/${uid}`);
  if (res.status === 404) throw new HttpError(404, 'Video niet gevonden bij Stream.');
  if (!res.ok) throw new HttpError(502, 'Kon videostatus niet ophalen.');
  const json = (await res.json()) as {
    result?: {
      readyToStream?: boolean;
      status?: { state?: string; errorReasonText?: string };
      duration?: number;
      size?: number;
      playback?: { hls?: string };
      meta?: Record<string, string>;
    };
  };
  const result = json.result;
  if (!result) throw new HttpError(502, 'Onverwacht Stream-antwoord.');
  await assertStreamVideoBelongsToOrg(env, uid, organizationId, result.meta);

  const playbackBase = result.playback?.hls?.match(/^https:\/\/[^/]+/)?.[0] ?? null;

  // Zodra de video klaar is: MP4-download-rendition laten maken (idempotent),
  // zodat 'Downloaden' via /downloads/default.mp4 werkt met een downloadable-token.
  if (result.readyToStream === true) {
    context.waitUntil(
      streamApi(env, `/stream/${uid}/downloads`, { method: 'POST' }).catch(() => undefined),
    );
  }

  return jsonResponse(
    {
      ok: true,
      ready: result.readyToStream === true,
      state: result.status?.state ?? 'unknown',
      error: result.status?.errorReasonText ?? null,
      durationSeconds: typeof result.duration === 'number' && result.duration > 0 ? result.duration : null,
      sizeBytes: typeof result.size === 'number' ? result.size : null,
      playbackBase,
    },
    200,
    context,
  );
}

/** Verwijder een Stream-video (bij item-verwijdering of mislukte upload). */
async function handleGalleryStreamDelete(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; uid?: string };
  const organizationId = (body.organizationId || '').trim();
  const uid = (body.uid || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!uid || !/^[a-f0-9]{32}$/i.test(uid)) throw new HttpError(400, 'Ongeldige video-id.');
  const role = await membershipRole(env, organizationId, userId);
  if (!role || role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');
  await requireGalleryAccess(env, organizationId, userId, 'write');

  const lookup = await streamApi(env, `/stream/${uid}`);
  if (lookup.status === 404) return jsonResponse({ ok: true, deleted: false }, 200, context);
  if (!lookup.ok) throw new HttpError(502, 'Kon video niet ophalen.');
  const json = (await lookup.json()) as { result?: { meta?: Record<string, string> } };
  await assertStreamVideoBelongsToOrg(env, uid, organizationId, json.result?.meta);

  const res = await streamApi(env, `/stream/${uid}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new HttpError(502, 'Kon video niet verwijderen.');
  return jsonResponse({ ok: true, deleted: true }, 200, context);
}

/** Tokenbundel voor ingelogde teamleden (app-weergave + downloads). */
async function handleGalleryViewSession(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; galleryId?: string };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!isUuid(galleryId)) throw new HttpError(400, 'Ongeldige galerij id.');
  await requireMembership(env, organizationId, userId);
  await requireGalleryAccess(env, organizationId, userId, 'read');
  await fetchGalleryRow(env, galleryId, organizationId);

  // Teamleden zien altijd de originelen — de download-instellingen van de galerij
  // gelden voor de klant, niet voor de eigenaar van het materiaal.
  const bundle = await buildGalleryTokenBundle(env, organizationId, galleryId, true, 'original', GALLERY_TOKEN_TTL_MS);
  return jsonResponse(bundle, 200, context);
}

/** Tokenbundel voor de edge functions (portaal + publieke deellink). */
async function handleInternalGalleryTokens(request: Request, env: Env, context: RouteContext): Promise<Response> {
  requireInternalSecret(request, env);
  const body = (await request.json().catch(() => ({}))) as {
    organizationId?: string; galleryId?: string; allowDownload?: boolean; ttlSeconds?: number;
  };
  const organizationId = (body.organizationId || '').trim();
  const galleryId = (body.galleryId || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!isUuid(galleryId)) throw new HttpError(400, 'Ongeldige galerij id.');
  const gallery = await fetchGalleryRow(env, galleryId, organizationId);

  const ttlMs = Math.min(Math.max(Number(body.ttlSeconds || 0) * 1000, 15 * 60 * 1000), GALLERY_TOKEN_TTL_MS) || GALLERY_TOKEN_TTL_MS;
  // Downloadrecht én -kwaliteit komen uit de galerij zelf, niet uit de aanroep:
  // de edge function kan zichzelf zo geen ruimere rechten toekennen.
  const allowDownload = body.allowDownload === true && gallery.allow_downloads === true;
  const quality: 'original' | 'web' = gallery.download_quality === 'web' ? 'web' : 'original';
  const bundle = await buildGalleryTokenBundle(env, organizationId, galleryId, allowDownload, quality, ttlMs);
  return jsonResponse(bundle, 200, context);
}

/** De variant staat vooraan in de bestandsnaam van de key (`{variant}-{uuid}-{naam}`). */
function galleryVariantFromKey(key: string): string {
  const fileName = key.slice(key.lastIndexOf('/') + 1);
  const dash = fileName.indexOf('-');
  return dash > 0 ? fileName.slice(0, dash) : '';
}

/** Serveer een galerijbestand inline (met Range-support voor video-seek). */
async function handleGalleryFile(request: Request, env: Env, context: RouteContext, key: string): Promise<Response> {
  const payload = await requireGalleryToken(request, env);
  if (!key.startsWith(`${payload.org}/gallery/${payload.gal}/`)) {
    throw new HttpError(403, 'Token hoort niet bij dit bestand.');
  }
  // Een key-gebonden token (Stream haalt de master op) mag niets anders raken.
  if (payload.k && payload.k !== key) throw new HttpError(403, 'Token hoort niet bij dit bestand.');
  const wantsDownload = context.url.searchParams.get('dl') === '1';
  if (wantsDownload && !payload.dl) throw new HttpError(403, 'Downloaden is niet toegestaan voor deze link.');

  const variant = galleryVariantFromKey(key);
  // Full-res originelen zijn alleen bereikbaar met een token dat downloaden op
  // originele kwaliteit toestaat. Zonder deze check zou het kennen van de
  // storage_key (die in de galerij-payload staat) genoeg zijn om de instellingen
  // "downloaden uit" en "webkwaliteit" te omzeilen. Video's in de oude
  // R2-fallback liggen onder de variant `source`: die moeten altijd afspeelbaar
  // zijn.
  if (variant === 'original' && !(payload.dl && payload.q === 'original')) {
    throw new HttpError(403, 'Het originele bestand is niet beschikbaar voor deze link.');
  }
  // De video-master kent geen webvariant: Stream levert het kijken, R2 levert
  // het origineel. "Downloadkwaliteit" gaat dus alleen over foto's — een
  // web-token mag de master gewoon downloaden zolang downloaden aan staat.
  if (variant === 'master' && !payload.dl) {
    throw new HttpError(403, 'Downloaden is niet toegestaan voor deze link.');
  }

  const head = await env.MEDIA_BUCKET.head(key);
  if (!head) throw new HttpError(404, 'Bestand niet gevonden.');
  const totalSize = head.size;

  // Range-parsing voor <video>-seek en hervatte downloads. We rekenen zelf
  // start/eind uit tegen de bekende objectgrootte, zodat het 206-antwoord altijd
  // een kloppende Content-Range/Content-Length heeft en onzinnige ranges een
  // nette 416 geven in plaats van stilletjes de hele body.
  const rangeHeader = request.headers.get('range') || '';
  const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  let start: number | null = null;
  let end: number | null = null;
  if (rangeMatch && (rangeMatch[1] !== '' || rangeMatch[2] !== '')) {
    if (rangeMatch[1] === '') {
      const suffix = Number(rangeMatch[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) throw new HttpError(416, 'Ongeldige range.');
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    } else {
      start = Number(rangeMatch[1]);
      end = rangeMatch[2] === '' ? totalSize - 1 : Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        throw new HttpError(416, 'Ongeldige range.');
      }
      if (start >= totalSize) {
        const headers = new Headers(context.corsHeaders);
        headers.set('Content-Range', `bytes */${totalSize}`);
        return new Response(null, { status: 416, headers });
      }
      end = Math.min(end, totalSize - 1);
    }
  }

  const isRanged = start !== null && end !== null && totalSize > 0;

  // Bij HEAD is de head() hierboven al genoeg: we halen het object niet op,
  // maar antwoorden wel met dezelfde headers als een GET zou geven.
  if (request.method === 'HEAD') {
    const headers = new Headers(context.corsHeaders);
    headers.set('Content-Type', head.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'private, max-age=900');
    headers.set('X-Request-Id', context.requestId);
    if (head.httpEtag) headers.set('ETag', head.httpEtag);
    headers.set('Content-Length', String(totalSize));
    return new Response(null, { status: 200, headers });
  }

  const object = await env.MEDIA_BUCKET.get(
    key,
    isRanged ? { range: { offset: start as number, length: (end as number) - (start as number) + 1 } } : undefined,
  );
  if (!object) throw new HttpError(404, 'Bestand niet gevonden.');

  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Accept-Ranges', 'bytes');
  // Tokens zijn kortlevend; previews/thumbs mogen binnen die sessie gecachet worden.
  headers.set('Cache-Control', 'private, max-age=900');
  headers.set('X-Request-Id', context.requestId);
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  const name = object.customMetadata?.name;
  headers.set(
    'Content-Disposition',
    wantsDownload && name ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}` : 'inline',
  );

  if (isRanged) {
    headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    headers.set('Content-Length', String((end as number) - (start as number) + 1));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(totalSize));
  return new Response(object.body, { status: 200, headers });
}

/** `/gallery/file/{key}` — key bevat slashes (org/gallery/galerij-id/item-id/bestand). */
function matchGalleryFileRoute(pathname: string): string | null {
  const match = pathname.match(/^\/gallery\/file\/(.+)$/);
  if (!match?.[1]) return null;
  const key = decodeURIComponent(match[1]);
  return isSafeStorageKey(key) ? key : null;
}

// ── Zip-download (streamend, store-only, zip64 waar nodig) ──────────────────
//
// JPEG/MP4 zijn al gecomprimeerd, dus we archiveren zonder compressie (method 0)
// en streamen elk R2-object rechtstreeks door de zip heen. CRC32 wordt tijdens
// het streamen berekend en achteraf in een data descriptor geschreven (flag bit
// 3), omdat de local file header al onderweg is vóór de CRC bekend is. Bestanden
// of offsets ≥ 4 GiB krijgen zip64-velden.

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32Update(crc: number, bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = crc;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

const ZIP_DOS_TIME = 12 << 11; // 12:00
const ZIP_DOS_DATE = ((2026 - 1980) << 9) | (8 << 5) | 2; // 2026-08-02

type ZipCentralEntry = {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
};

function zipLocalHeader(nameBytes: Uint8Array, zip64: boolean): Uint8Array {
  // Bij zip64 signaleert een (lege) zip64-extra in de local header dat de data
  // descriptor 8-byte-groottes gebruikt (APPNOTE 4.3.9.1/4.3.9.2).
  const extraLen = zip64 ? 20 : 0;
  const buf = new Uint8Array(30 + nameBytes.length + extraLen);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, zip64 ? 45 : 20, true); // version needed
  view.setUint16(6, 0x0808, true); // bit 3 (descriptor) + bit 11 (UTF-8)
  view.setUint16(8, 0, true); // store
  view.setUint16(10, ZIP_DOS_TIME, true);
  view.setUint16(12, ZIP_DOS_DATE, true);
  view.setUint32(14, 0, true); // crc in descriptor
  view.setUint32(18, zip64 ? 0xffffffff : 0, true);
  view.setUint32(22, zip64 ? 0xffffffff : 0, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, extraLen, true);
  buf.set(nameBytes, 30);
  if (zip64) {
    const ev = new DataView(buf.buffer, 30 + nameBytes.length);
    ev.setUint16(0, 0x0001, true);
    ev.setUint16(2, 16, true);
    // sizes 0 — de echte waarden volgen in de data descriptor.
  }
  return buf;
}

function zipDataDescriptor(crc: number, size: number, zip64: boolean): Uint8Array {
  const buf = new Uint8Array(zip64 ? 24 : 16);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc >>> 0, true);
  if (zip64) {
    view.setBigUint64(8, BigInt(size), true);
    view.setBigUint64(16, BigInt(size), true);
  } else {
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  }
  return buf;
}

function zipCentralDirectory(entries: ZipCentralEntry[], cdOffset: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let cdSize = 0;
  for (const entry of entries) {
    const sizeOver = entry.size >= 0xffffffff;
    const offsetOver = entry.offset >= 0xffffffff;
    const extraFields: number[] = [];
    if (sizeOver) extraFields.push(entry.size, entry.size);
    if (offsetOver) extraFields.push(entry.offset);
    const extraLen = extraFields.length > 0 ? 4 + extraFields.length * 8 : 0;
    const buf = new Uint8Array(46 + entry.nameBytes.length + extraLen);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 45, true); // version made by
    view.setUint16(6, entry.zip64 || sizeOver || offsetOver ? 45 : 20, true);
    view.setUint16(8, 0x0808, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, ZIP_DOS_TIME, true);
    view.setUint16(14, ZIP_DOS_DATE, true);
    view.setUint32(16, entry.crc >>> 0, true);
    view.setUint32(20, sizeOver ? 0xffffffff : entry.size, true);
    view.setUint32(24, sizeOver ? 0xffffffff : entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, extraLen, true);
    view.setUint16(32, 0, true); // comment
    view.setUint16(34, 0, true); // disk
    view.setUint16(36, 0, true); // int attrs
    view.setUint32(38, 0, true); // ext attrs
    view.setUint32(42, offsetOver ? 0xffffffff : entry.offset, true);
    buf.set(entry.nameBytes, 46);
    if (extraLen > 0) {
      const ev = new DataView(buf.buffer, 46 + entry.nameBytes.length);
      ev.setUint16(0, 0x0001, true);
      ev.setUint16(2, extraFields.length * 8, true);
      extraFields.forEach((value, i) => ev.setBigUint64(4 + i * 8, BigInt(value), true));
    }
    parts.push(buf);
    cdSize += buf.length;
  }

  const needsZip64Eocd = cdOffset >= 0xffffffff || cdSize >= 0xffffffff || entries.length >= 0xffff;
  if (needsZip64Eocd) {
    const eocd64 = new Uint8Array(56);
    const v = new DataView(eocd64.buffer);
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, BigInt(44), true);
    v.setUint16(12, 45, true);
    v.setUint16(14, 45, true);
    v.setUint32(16, 0, true);
    v.setUint32(20, 0, true);
    v.setBigUint64(24, BigInt(entries.length), true);
    v.setBigUint64(32, BigInt(entries.length), true);
    v.setBigUint64(40, BigInt(cdSize), true);
    v.setBigUint64(48, BigInt(cdOffset), true);
    parts.push(eocd64);

    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setUint32(4, 0, true);
    lv.setBigUint64(8, BigInt(cdOffset + cdSize), true);
    lv.setUint32(16, 1, true);
    parts.push(locator);
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, Math.min(entries.length, 0xffff), true);
  ev.setUint16(10, Math.min(entries.length, 0xffff), true);
  ev.setUint32(12, cdSize >= 0xffffffff ? 0xffffffff : cdSize, true);
  ev.setUint32(16, cdOffset >= 0xffffffff ? 0xffffffff : cdOffset, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);
  return parts;
}

/** Download de hele galerij als streamende zip (originelen of web-previews). */
async function handleGalleryZip(request: Request, env: Env, context: RouteContext, galleryId: string): Promise<Response> {
  const payload = await requireGalleryToken(request, env);
  if (payload.gal !== galleryId) throw new HttpError(403, 'Token hoort niet bij deze galerij.');
  if (!payload.dl) throw new HttpError(403, 'Downloaden is niet toegestaan voor deze link.');

  const gallery = await fetchGalleryRow(env, galleryId, payload.org);
  const items = await fetchGalleryItemRows(env, galleryId, payload.org);

  const useWeb = gallery.download_quality === 'web';
  const used = new Set<string>();
  const entries: Array<{ key: string; zipName: string }> = [];
  for (const item of items) {
    const key = useWeb && item.media_type === 'photo' ? item.preview_key || item.storage_key : item.storage_key;
    if (!key || !key.startsWith(`${payload.org}/`)) continue; // Stream-only video's zitten niet in de zip
    // Video-masters ook niet: tientallen gigabytes door de CRC32-lus van een
    // Worker halen loopt over de CPU-limiet, en dan levert de zip stilzwijgend
    // een afgekapt bestand op. Die download de klant per stuk.
    if (galleryVariantFromKey(key) === 'master') continue;
    const base = sanitizeFileName(item.file_name || 'bestand');
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    // Blijf ophogen tot de naam écht vrij is: een simpele teller kan botsen met
    // een bestand dat toevallig al "foto_2.jpg" heet.
    let zipName = base;
    let suffix = 1;
    while (used.has(zipName.toLowerCase())) {
      suffix += 1;
      zipName = `${stem}_${suffix}${ext}`;
    }
    used.add(zipName.toLowerCase());
    entries.push({ key, zipName });
  }
  if (entries.length === 0) throw new HttpError(404, 'Geen downloadbare bestanden in deze galerij.');

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = (async () => {
    const encoder = new TextEncoder();
    const central: ZipCentralEntry[] = [];
    let offset = 0;
    try {
      for (const entry of entries) {
        const object = await env.MEDIA_BUCKET.get(entry.key);
        if (!object) continue;
        const zip64 = object.size >= 0xffffffff;
        const nameBytes = encoder.encode(entry.zipName);
        const localHeader = zipLocalHeader(nameBytes, zip64);
        await writer.write(localHeader);

        let crc = 0xffffffff;
        let written = 0;
        const reader = object.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32Update(crc, value);
          written += value.length;
          await writer.write(value);
        }
        const finalCrc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = zipDataDescriptor(finalCrc, written, zip64);
        await writer.write(descriptor);

        central.push({ nameBytes, crc: finalCrc, size: written, offset, zip64 });
        offset += localHeader.length + written + descriptor.length;
      }
      for (const part of zipCentralDirectory(central, offset)) {
        await writer.write(part);
      }
      await writer.close();
    } catch (error) {
      console.error('gallery zip stream error', {
        requestId: context.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      await writer.abort(error).catch(() => undefined);
    }
  })();
  context.waitUntil(pump);

  const zipName = `${sanitizeFileName(gallery.title || 'galerij').replace(/\.[A-Za-z0-9]+$/, '') || 'galerij'}.zip`;
  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', 'application/zip');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  headers.set('X-Request-Id', context.requestId);
  return new Response(readable, { status: 200, headers });
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

type OfficeTokenPayload = { fid: string; org: string; uid: string; w: boolean; exp: number; nm?: string; k?: 'a' | 'd' | 'c' };

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

type ModuleLevel = 'none' | 'read' | 'write';

/**
 * Exacte spiegel van `public.org_module_level` (en van getModuleLevel in
 * supabase/functions/_shared/edgeAuth.ts): owners/admins zijn nooit beperkt,
 * een viewer nooit meer dan lezen, een ontbrekende sleutel = volledig.
 *
 * Deze Worker praat met de service-role en omzeilt daarmee RLS én de
 * zzz_module_write_gate-triggers. Zonder deze check zou een teamlid met
 * module_access.projects = 'none' via de galerij-routes alsnog tokens kunnen
 * munten, uploaden of Stream-video's verwijderen.
 */
async function moduleLevel(env: Env, organizationId: string, userId: string, module: string): Promise<ModuleLevel> {
  if (!isUuid(organizationId)) return 'none';
  const query = new URLSearchParams({
    select: 'role,module_access',
    organization_id: `eq.${organizationId}`,
    user_id: `eq.${userId}`,
    status: 'eq.active',
    limit: '1',
  });
  const res = await fetch(`${supabaseBase(env)}/rest/v1/organization_members?${query.toString()}`, { headers: serviceHeaders(env) });
  if (!res.ok) throw new HttpError(502, 'Kon modulerechten niet verifiëren.');
  const rows = (await res.json()) as Array<{ role?: string; module_access?: Record<string, unknown> | null }>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row?.role) return 'none';
  if (row.role === 'owner' || row.role === 'admin') return 'write';
  const raw = row.module_access?.[module];
  const stored: ModuleLevel = raw === 'none' || raw === 'read' || raw === 'write' ? raw : 'write';
  if (row.role === 'viewer') return stored === 'none' ? 'none' : 'read';
  return stored;
}

/** Galerijen vallen onder de Projecten-module (zie apply_module_gate in de migratie). */
async function requireGalleryAccess(env: Env, organizationId: string, userId: string, need: 'read' | 'write'): Promise<ModuleLevel> {
  const level = await moduleLevel(env, organizationId, userId, 'projects');
  const ok = need === 'read' ? level !== 'none' : level === 'write';
  if (!ok) {
    throw new HttpError(403, level === 'none'
      ? 'Je hebt geen toegang tot de module Projecten in deze organisatie.'
      : 'Je mag niets wijzigen in de module Projecten van deze organisatie.');
  }
  return level;
}

// ── Office-doel: attachment, document (Word-modus) OF contract ──────────────
//
// De WOPI-laag bedient drie bronnen: geüploade `attachments` (kind 'a'), interne
// `documents` in Word-modus (kind 'd', `documents.storage_key` gezet) en
// `contracts` in office-modus (kind 'c', `contracts.body_storage_key` gezet). Het
// edit-token draagt de soort mee zodat GetFile/PutFile de juiste tabel
// raadplegen/bijwerken.
//
// Contracten hebben één extra regel: hun status bepaalt of er nog geschreven mag
// worden. `locked` draagt dat naar boven, zodat zowel de sessie-uitgifte als
// PutFile het kan afdwingen.

type OfficeKind = 'a' | 'd' | 'c';
type OfficeTarget = {
  organization_id: string;
  storage_key: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  edit_version: number;
  /** Gezet als het doel inhoudelijk bevroren is (getekend/ingetrokken contract). */
  locked?: boolean;
};

/** Contractstatussen waarin de inhoud nog bewerkt mag worden. Spiegelt de
 *  readOnly-regel in de contractpagina (alleen een concept is bewerkbaar) en de
 *  onveranderlijkheidstrigger in de database. */
const CONTRACT_EDITABLE_STATUSES = new Set(['draft']);

/** Normaliseer een attachment-, document- of contractrij naar één office-doelvorm. */
async function fetchOfficeTarget(env: Env, kind: OfficeKind, id: string): Promise<OfficeTarget> {
  if (kind === 'c') {
    const query = new URLSearchParams({
      select: 'organization_id,number,title,editor_mode,body_storage_key,body_mime_type,body_size_bytes,edit_version,status',
      id: `eq.${id}`,
      limit: '1',
    });
    const res = await fetch(`${supabaseBase(env)}/rest/v1/contracts?${query.toString()}`, { headers: serviceHeaders(env) });
    if (!res.ok) throw new HttpError(502, 'Kon contract niet ophalen.');
    const rows = (await res.json()) as Array<{
      organization_id: string; number: string | null; title: string | null; editor_mode: string | null;
      body_storage_key: string | null; body_mime_type: string | null; body_size_bytes: number | null;
      edit_version: number | null; status: string | null;
    }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) throw new HttpError(404, 'Contract niet gevonden.');
    if (row.editor_mode !== 'office' || !row.body_storage_key) {
      throw new HttpError(409, 'Dit contract is niet in Word-modus opgesteld.');
    }
    const mime = row.body_mime_type || OFFICE_NEW_MIME.docx;
    const ext = OFFICE_MIME_EXT[mime] || 'docx';
    // Naam zoals de gebruiker hem in de editor-titelbalk ziet: nummer + onderwerp.
    const label = [row.number, row.title].map((v) => (v || '').trim()).filter(Boolean).join(' - ') || 'Contract';
    const safeLabel = label.replace(/[\\/]+/g, ' ').trim() || 'Contract';
    return {
      organization_id: row.organization_id,
      storage_key: row.body_storage_key,
      name: safeLabel.toLowerCase().endsWith(`.${ext}`) ? safeLabel : `${safeLabel}.${ext}`,
      mime_type: mime,
      size_bytes: row.body_size_bytes ?? 0,
      edit_version: row.edit_version ?? 1,
      locked: !CONTRACT_EDITABLE_STATUSES.has(row.status || ''),
    };
  }
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

/** Werk edit-state bij op de juiste tabel (attachments, documents of contracts). */
async function patchOfficeTarget(env: Env, kind: OfficeKind, id: string, patch: Record<string, unknown>): Promise<void> {
  if (kind === 'c') {
    const res = await fetch(`${supabaseBase(env)}/rest/v1/contracts?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(env, { 'content-type': 'application/json', prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      // De onveranderlijkheidstrigger weigert elke inhoudswijziging op een
      // getekend/ingetrokken contract — óók vanuit de service-role. Dat is de
      // laatste vangrail als er nog een oude editorsessie openstond.
      const detail = await res.text().catch(() => '');
      console.error('media-api contract patch geweigerd', { id, status: res.status, detail: detail.slice(0, 300) });
      throw new HttpError(409, 'Dit contract kan niet meer worden gewijzigd.');
    }
    return;
  }
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

  const body = (await request.json().catch(() => ({}))) as { attachmentId?: string; documentId?: string; contractId?: string };
  const kind: OfficeKind = body.contractId ? 'c' : body.documentId ? 'd' : 'a';
  const rawId = kind === 'c' ? body.contractId : kind === 'd' ? body.documentId : body.attachmentId;
  const id = (rawId || '').trim();
  if (!isUuid(id)) {
    throw new HttpError(400, kind === 'c' ? 'Ongeldige contractId.' : kind === 'd' ? 'Ongeldige documentId.' : 'Ongeldige attachmentId.');
  }

  // Start de (bij een koude container trage) discovery alvast, parallel met de DB-checks
  // hieronder — collaboraUrlSrc pakt straks dezelfde in-flight promise. Fouten hier niet
  // fataal: de echte foutafhandeling zit bij collaboraUrlSrc.
  void collaboraDiscovery(env).catch(() => undefined);
  // Weergavenaam parallel ophalen (eigen try/catch — rejectet nooit).
  const displayNamePromise = fetchUserName(request, env, 'ResoFly-gebruiker');

  const target = await fetchOfficeTarget(env, kind, id);
  const role = await membershipRole(env, target.organization_id, userId);
  if (!role) throw new HttpError(403, 'Geen toegang tot dit bestand.');
  // Een bevroren doel (getekend/ingetrokken contract) opent alleen-lezen: de
  // klant heeft dan een exemplaar met precies deze inhoud in handen.
  const canWrite = role !== 'viewer' && !target.locked;

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

/**
 * Ontvang de .docx-bytes van een contract dat in Word-modus wordt opgesteld.
 * De contractrij zelf maakt/werkt de frontend bij (RLS + created_by), net als bij
 * documenten. Bewust een eigen route en géén attachments-rij: een contract is zijn
 * eigen entiteit en hoeft niet in de attachments-CHECK/trigger-allowlist te passen.
 */
async function handleOfficeContractUpload(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const userId = await requireUser(request, env);
  officeSecret(env);

  const organizationId = (request.headers.get('x-organization-id') || '').trim();
  const fileName = sanitizeFileName(decodeMaybe(request.headers.get('x-file-name')) || 'contract.docx');
  const mime = (request.headers.get('x-file-type') || OFFICE_NEW_MIME.docx).trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!OFFICE_MIME_EXT[mime]) throw new HttpError(415, 'Alleen Word-, Excel- of PowerPoint-bestanden zijn toegestaan.');

  const role = await membershipRole(env, organizationId, userId);
  if (!role || role === 'viewer') throw new HttpError(403, 'Geen schrijfrechten.');
  if (!request.body) throw new HttpError(400, 'Lege upload.');

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'Lege upload.');
  if (buf.byteLength > OFFICE_MAX_BYTES) {
    throw new HttpError(413, `Bestand is te groot. Maximum is ${Math.round(OFFICE_MAX_BYTES / 1024 / 1024)} MB.`);
  }

  const key = `${organizationId}/contract/${crypto.randomUUID()}-${fileName}`;
  const object = await env.MEDIA_BUCKET.put(key, buf, {
    httpMetadata: { contentType: mime },
    customMetadata: { name: fileName, organizationId, entityType: 'contract', uploadedBy: userId, uploadedAt: new Date().toISOString() },
  });

  return jsonResponse({ ok: true, key, size_bytes: object.size, mime_type: mime, name: fileName }, 200, context);
}

/** Download het .docx-bronbestand van een contract in Word-modus. */
async function handleOfficeContractDownload(request: Request, env: Env, context: RouteContext, id: string): Promise<Response> {
  const userId = await requireUser(request, env);
  const target = await fetchOfficeTarget(env, 'c', id);
  await requireMembership(env, target.organization_id, userId);

  const object = await env.MEDIA_BUCKET.get(target.storage_key);
  if (!object) throw new HttpError(404, 'Bestand niet gevonden.');

  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', target.mime_type || 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Request-Id', context.requestId);
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`);
  return new Response(object.body, { status: 200, headers });
}

/**
 * Zet een office-bestand uit R2 om naar PDF met Collabora's convert-to.
 *
 * Alleen intern (gedeeld secret): dit is de enige weg waarlangs de contract-edge-
 * functions aan een PDF van een Word-contract komen. De office-server laat
 * convert-to uitsluitend door met OFFICE_CONVERT_SECRET, zodat onze render-
 * container geen publieke conversiedienst is.
 */
async function handleInternalOfficeConvertPdf(request: Request, env: Env, context: RouteContext): Promise<Response> {
  requireInternalSecret(request, env);
  if (!env.COLLABORA_URL) throw new HttpError(500, 'Office-editor niet geconfigureerd (COLLABORA_URL).');
  if (!env.OFFICE_CONVERT_SECRET) throw new HttpError(500, 'Conversie niet geconfigureerd (OFFICE_CONVERT_SECRET).');

  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; storageKey?: string };
  const organizationId = (body.organizationId || '').trim();
  const storageKey = (body.storageKey || '').trim();
  if (!isUuid(organizationId)) throw new HttpError(400, 'Ongeldige organization id.');
  if (!isSafeStorageKey(storageKey)) throw new HttpError(400, 'Ongeldige opslagsleutel.');
  // De sleutel moet in de map van deze organisatie liggen: een intern secret mag
  // geen willekeurig object uit een andere tenant kunnen laten converteren.
  if (organizationFromKey(storageKey) !== organizationId) {
    throw new HttpError(403, 'Opslagsleutel hoort niet bij deze organisatie.');
  }

  const object = await env.MEDIA_BUCKET.get(storageKey);
  if (!object) throw new HttpError(404, 'Bronbestand niet gevonden.');

  const sourceMime = object.httpMetadata?.contentType || OFFICE_NEW_MIME.docx;
  const ext = OFFICE_MIME_EXT[sourceMime] || 'docx';
  const form = new FormData();
  // Collabora leidt het invoerformaat af uit de bestandsnaam-extensie; de naam
  // zelf komt verder nergens terug.
  form.append('data', new Blob([await object.arrayBuffer()], { type: sourceMime }), `bron.${ext}`);

  const convertUrl = `${env.COLLABORA_URL.replace(/\/$/, '')}/cool/convert-to/pdf`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'x-resofly-convert': env.OFFICE_CONVERT_SECRET },
    body: form,
  };
  const res = env.OFFICE_SERVER ? await env.OFFICE_SERVER.fetch(convertUrl, init) : await fetch(convertUrl, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    console.error('Collabora convert-to mislukt', { status: res.status, detail: detail.slice(0, 300) });
    throw new HttpError(502, 'Kon het document niet naar PDF omzetten.');
  }

  const pdf = new Uint8Array(await res.arrayBuffer());
  // Collabora antwoordt op een mislukte conversie soms met 200 + lege/niet-PDF
  // body; die mag niet als contract-PDF de deur uit.
  if (pdf.byteLength < 5 || String.fromCharCode(...pdf.slice(0, 5)) !== '%PDF-') {
    console.error('Collabora convert-to gaf geen PDF terug', { bytes: pdf.byteLength });
    throw new HttpError(502, 'De PDF-conversie leverde geen geldig PDF-bestand op.');
  }

  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', 'application/pdf');
  headers.set('Content-Length', String(pdf.byteLength));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Request-Id', context.requestId);
  return new Response(pdf, { status: 200, headers });
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
  // Het edit-token leeft 10 uur; de status kan sinds de sessie-uitgifte veranderd
  // zijn (contract verstuurd, getekend of ingetrokken). Opnieuw controleren vóór
  // we R2 overschrijven — daarna is het origineel weg.
  if (target.locked) throw new HttpError(409, 'Dit contract is definitief en kan niet meer worden gewijzigd.');
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
  // Contracten dragen hun bestandsmetadata onder body_*-namen, zodat de
  // bestaande signed_pdf_*-kolommen ondubbelzinnig het getekende exemplaar
  // blijven aanduiden.
  await patchOfficeTarget(env, kind, id, {
    edit_version: nextVersion,
    ...(kind === 'c' ? { body_size_bytes: object.size } : { size_bytes: object.size }),
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

/** `/internal/contract-snapshot/{key}` — contract-PDF's (getekend + verstuurd). */
function matchInternalContractSnapshotRoute(pathname: string): string | null {
  const match = pathname.match(/^\/internal\/contract-snapshot\/(.+)$/);
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
