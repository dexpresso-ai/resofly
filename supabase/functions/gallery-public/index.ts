import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ============================================================
// ResoFly — Publieke galerij-deellink (gallery-public)
//
// Login-loze toegang tot een gepubliceerde galerij via een deellink
// (/gallerij/<token>), naar het model van quote-public/contract-public.
//
// Beveiliging:
// - verify_jwt = false (config.toml): geen Supabase-sessie nodig.
// - Het token staat NIET in de database; alleen de SHA-256-hash
//   (galleries.share_token_hash). Het token zelf is 32 bytes entropie.
// - Optionele pincode: hash met het token als zout (share_pin_hash =
//   sha256(`${token}:${pin}`)), met teller + lockout tegen brute force
//   (8 pogingen → 15 minuten slot, per galerij).
// - Alleen status 'published' en niet-verlopen galerijen zijn bereikbaar;
//   intrekken van de link (share_enabled=false) sluit de deur direct.
// - Media-bytes lopen nooit door deze functie: de media-api worker munt
//   kortlevende kijk-/downloadtokens via /internal/gallery/tokens.
// - Favorieten van deellink-bezoekers hangen aan een client-side
//   session_key (localStorage) met actor_kind 'share_link'.
// ============================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const MEDIA_WORKER_URL = (Deno.env.get('MEDIA_WORKER_URL') || '').replace(/\/$/, '');
const MEDIA_INTERNAL_SECRET =
  Deno.env.get('INTERNAL_UPLOAD_SECRET') ||
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  '';

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('GALLERY_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Pin-pogingen en lockout worden in de database bewaakt (RPC
// gallery_verify_share_pin: 8 pogingen, daarna 15 minuten op slot).

class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type GalleryRow = {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  description: string | null;
  format: string | null;
  hero_template: string | null;
  status: string;
  published_at: string | null;
  cover_item_id: string | null;
  allow_downloads: boolean;
  download_quality: string;
  share_enabled: boolean;
  share_token_hash: string | null;
  share_pin_hash: string | null;
  share_pin_failed_count: number;
  share_pin_locked_until: string | null;
  expires_at: string | null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'getGallery');

    switch (action) {
      case 'getGallery':
        return json(req, await getGallery(body));
      case 'toggleFavorite':
        return json(req, { ok: true, ...(await toggleFavorite(body)) });
      default:
        throw new PublicError(`Onbekende actie: ${action}`, 400);
    }
  } catch (error) {
    const status = error instanceof PublicError ? error.status : 500;
    const message = error instanceof PublicError
      ? error.message
      : 'De galerij kon niet worden geladen. Probeer het later opnieuw.';
    if (status >= 500) {
      console.error('gallery-public error', error instanceof Error ? error.message : error);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ────────────────────────────────────────────────────────────

async function getGallery(body: Record<string, unknown>) {
  const { gallery, needsPin } = await resolveGallery(body);
  if (needsPin) {
    // Nog geen (geldige) pincode: alleen de titel prijsgeven voor het pinscherm.
    return { ok: true, needsPin: true, gallery: { title: gallery.title } };
  }

  const sessionKey = normalizeSessionKey(body.sessionKey);
  const [items, favorites, tokens, categories] = await Promise.all([
    selectRows('gallery_items', (q) => q.eq('gallery_id', gallery.id).eq('organization_id', gallery.organization_id).order('sort_order', { ascending: true }).order('created_at', { ascending: true })),
    // Alle reacties van deze galerij: de like-teller is voor iedereen zichtbaar,
    // de eigen favorieten filteren we er hieronder uit op sessiesleutel.
    selectRows('gallery_favorites', (q) => q.eq('gallery_id', gallery.id).eq('organization_id', gallery.organization_id)),
    fetchGalleryTokens(gallery.organization_id, gallery.id, gallery.allow_downloads),
    selectRows('gallery_categories', (q) => q.eq('gallery_id', gallery.id).eq('organization_id', gallery.organization_id).order('position', { ascending: true }).order('created_at', { ascending: true }))
      .catch(() => [] as Record<string, unknown>[]),
  ]);

  const branding = await loadBranding(gallery.organization_id);

  const reactionOf = (row: Record<string, unknown>) => String(row.reaction ?? 'favorite');
  const isMine = (row: Record<string, unknown>) => Boolean(sessionKey) && row.session_key === sessionKey;

  const likeCounts: Record<string, number> = {};
  for (const row of favorites) {
    if (reactionOf(row) !== 'like') continue;
    const id = String(row.item_id);
    likeCounts[id] = (likeCounts[id] ?? 0) + 1;
  }

  return {
    ok: true,
    needsPin: false,
    gallery: sanitizeGallery(gallery),
    items: items.map(sanitizeGalleryItem),
    categories: categories.map((row) => ({ id: row.id, name: row.name })),
    branding,
    tokens,
    myFavoriteIds: favorites.filter((f) => reactionOf(f) === 'favorite' && isMine(f)).map((f) => String(f.item_id)),
    myLikeIds: favorites.filter((f) => reactionOf(f) === 'like' && isMine(f)).map((f) => String(f.item_id)),
    likeCounts,
  };
}

async function toggleFavorite(body: Record<string, unknown>) {
  const { gallery, needsPin } = await resolveGallery(body);
  if (needsPin) throw new PublicError('Pincode vereist.', 401);

  const itemId = String(body.itemId || '').trim();
  const on = body.on === true;
  const reaction = String(body.reaction || 'favorite') === 'like' ? 'like' : 'favorite';
  const sessionKey = normalizeSessionKey(body.sessionKey);
  if (!isUuid(itemId)) throw new PublicError('Ongeldig galerij-item.', 400);
  if (!sessionKey) throw new PublicError('Ongeldige sessie.', 400);

  const { data: item, error: itemError } = await supabaseAdmin
    .from('gallery_items')
    .select('id')
    .eq('id', itemId)
    .eq('gallery_id', gallery.id)
    .eq('organization_id', gallery.organization_id)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item) throw new PublicError('Galerij-item niet gevonden.', 404);

  if (on) {
    const visitorName = String(body.visitorName || '').trim().slice(0, 120);
    const { error } = await supabaseAdmin.from('gallery_favorites').insert({
      organization_id: gallery.organization_id,
      gallery_id: gallery.id,
      item_id: itemId,
      reaction,
      actor_kind: 'share_link',
      session_key: sessionKey,
      actor_label: visitorName || 'Via deellink',
    });
    if (error && error.code !== '23505') throw error;
  } else {
    const { error } = await supabaseAdmin
      .from('gallery_favorites')
      .delete()
      .eq('item_id', itemId)
      .eq('gallery_id', gallery.id)
      .eq('reaction', reaction)
      .eq('session_key', sessionKey);
    if (error) throw error;
  }
  return { itemId, on, reaction };
}

// ── Token + pincode ───────────────────────────────────────────────────

async function resolveGallery(body: Record<string, unknown>): Promise<{ gallery: GalleryRow; needsPin: boolean }> {
  const token = String(body.token || '').trim();
  if (!token || token.length < 20 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new PublicError('Ongeldige galerijlink.', 404);
  }

  const tokenHash = await sha256Hex(token);
  const { data, error } = await supabaseAdmin
    .from('galleries')
    .select('*')
    .eq('share_token_hash', tokenHash)
    .eq('share_enabled', true)
    .maybeSingle();
  if (error) throw error;
  const gallery = data as GalleryRow | null;
  if (!gallery) throw new PublicError('Deze galerijlink bestaat niet (meer).', 404);
  if (gallery.status !== 'published') throw new PublicError('Deze galerij is niet (meer) gepubliceerd.', 403);
  if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) {
    throw new PublicError('De toegang tot deze galerij is verlopen.', 403);
  }

  if (!gallery.share_pin_hash) return { gallery, needsPin: false };

  // Lockout vóór elke pincontrole (definitief oordeel komt uit de RPC hieronder,
  // die de rij vergrendelt; dit voorkomt alleen onnodig werk).
  if (gallery.share_pin_locked_until && new Date(gallery.share_pin_locked_until) > new Date()) {
    throw new PublicError('Te veel foute pincodes. Probeer het over een kwartier opnieuw.', 429);
  }

  const pin = String(body.pin || '').trim();
  if (!pin) return { gallery, needsPin: true };

  // Vergelijken + tellen gebeurt atomair in de database (SELECT ... FOR UPDATE),
  // anders kunnen parallelle pogingen de lockout omzeilen.
  const pinHash = await sha256Hex(`${token}:${pin}`);
  const { data: pinResult, error: pinError } = await supabaseAdmin.rpc('gallery_verify_share_pin', {
    p_gallery_id: gallery.id,
    p_pin_hash: pinHash,
  });
  if (pinError) throw pinError;
  const verdict = (Array.isArray(pinResult) ? pinResult[0] : pinResult) as { ok?: boolean; locked?: boolean } | null;
  if (verdict?.locked) {
    throw new PublicError('Te veel foute pincodes. Probeer het over een kwartier opnieuw.', 429);
  }
  if (!verdict?.ok) {
    throw new PublicError('Onjuiste pincode.', 401);
  }
  return { gallery, needsPin: false };
}

async function fetchGalleryTokens(organizationId: string, galleryId: string, allowDownload: boolean) {
  if (!MEDIA_WORKER_URL || !MEDIA_INTERNAL_SECRET) {
    throw new PublicError('Galerij-weergave is niet geconfigureerd (MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET).', 500);
  }
  const res = await fetch(`${MEDIA_WORKER_URL}/internal/gallery/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MEDIA_INTERNAL_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId, galleryId, allowDownload, ttlSeconds: 21600 }),
  });
  if (!res.ok) throw new PublicError('Kon galerij-tokens niet ophalen.', 502);
  return (await res.json()) as { mediaToken: string; streamTokens: Record<string, string>; exp: number };
}

/**
 * Huisstijl van de beeldmaker. Nooit blokkerend: zonder instellingen (of als de
 * migratie nog niet is toegepast) valt de galerij terug op de ResoFly-stijl.
 */
async function loadBranding(organizationId: string) {
  const fallback = { logoDataUrl: null, accentColor: '#FFD966', footerText: null, hidePoweredBy: false, companyName: null };
  try {
    const { data, error } = await supabaseAdmin
      .from('company_settings')
      .select('company_name,trade_name,brand_logo_data_url,brand_accent_color,brand_footer_text,brand_hide_powered_by')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error || !data) return fallback;
    const row = data as Record<string, unknown>;
    const accent = String(row.brand_accent_color ?? '');
    return {
      logoDataUrl: (row.brand_logo_data_url as string | null) ?? null,
      accentColor: /^#[0-9A-Fa-f]{6}$/.test(accent) ? accent : fallback.accentColor,
      footerText: (row.brand_footer_text as string | null) ?? null,
      hidePoweredBy: row.brand_hide_powered_by === true,
      companyName: (row.trade_name as string | null) || (row.company_name as string | null) || null,
    };
  } catch {
    return fallback;
  }
}

// ── Saneren ───────────────────────────────────────────────────────────

function sanitizeGallery(row: GalleryRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    format: row.format ?? 'hybrid',
    hero_template: row.hero_template ?? 'full',
    published_at: row.published_at ?? null,
    allow_downloads: Boolean(row.allow_downloads),
    download_quality: row.download_quality ?? 'original',
    cover_item_id: row.cover_item_id ?? null,
    expires_at: row.expires_at ?? null,
  };
}

function sanitizeGalleryItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    media_type: row.media_type,
    file_name: row.file_name,
    category_id: row.category_id ?? null,
    storage_key: row.storage_key ?? null,
    preview_key: row.preview_key ?? null,
    thumb_key: row.thumb_key ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    stream_uid: row.stream_uid ?? null,
    stream_status: row.stream_status ?? null,
    stream_playback_base: row.stream_playback_base ?? null,
  };
}

// ── Generieke helpers ─────────────────────────────────────────────────

function normalizeSessionKey(value: unknown): string | null {
  const key = String(value || '').trim();
  if (key.length < 16 || key.length > 64 || !/^[A-Za-z0-9_-]+$/.test(key)) return null;
  return key;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// deno-lint-ignore no-explicit-any
type QueryBuilder = any;

async function selectRows(table: string, build: (q: QueryBuilder) => QueryBuilder): Promise<Record<string, unknown>[]> {
  const { data, error } = await build(supabaseAdmin.from(table).select('*'));
  if (error) throw error;
  return (data || []) as Record<string, unknown>[];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;
      try { origins.add(new URL(part).origin); } catch { origins.add(part); }
    }
  }
  return Array.from(origins);
}

function assertAllowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PublicError('Deze frontend-origin is niet toegestaan voor de galerij.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
