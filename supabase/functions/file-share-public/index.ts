import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { BRANDING_COLUMNS, sanitizeBranding } from '../_shared/branding.ts';

// ============================================================
// ResoFly — Publieke deellink (file-share-public)
//
// Bedient /gedeeld/<token>: de pagina waar iemand zónder account een met hem
// gedeelde map, bestand, notitie of document bekijkt.
//
// Beveiliging:
// - De token staat NIET in de database, alleen sha256(token). Dit endpoint hasht
//   de binnenkomende token en zoekt daarmee (RPC resolve_drive_share_link,
//   service-role only, die ook revoked_at en expires_at bewaakt).
// - Alleen `recipient_kind = 'link'`-delingen zijn hier te vinden. Portaaldelingen
//   (contactpersonen) lopen uitsluitend via het ingelogde klantportaal.
// - Een klantgerelateerd bestand kan hier per definitie niet opduiken: de
//   database weigert al bij het aanmaken een deellink op zo'n item.
// - Downloaden mag alleen als de deling dat toestaat (can_download).
// - Bytes komen server-side uit R2 via de interne, met een gedeeld geheim
//   beveiligde worker-route; de browser krijgt nooit een opslag-URL te zien.
// ============================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const MEDIA_WORKER_URL = (
  Deno.env.get('MEDIA_WORKER_URL') ||
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const MEDIA_INTERNAL_SECRET =
  Deno.env.get('INTERNAL_UPLOAD_SECRET') ||
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  '';

/** 25 MB — gelijk aan MAX_UPLOAD_BYTES; groter past niet in één base64-antwoord. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('FILE_SHARE_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class ShareError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type ShareRow = {
  id: string;
  organization_id: string;
  item_type: string;
  item_id: string;
  item_name: string | null;
  recipient_kind: string;
  recipient_name: string | null;
  can_download: boolean;
  message: string | null;
  expires_at: string | null;
};

type ShareItem = {
  item_type: string;
  item_id: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_key: string | null;
  modified: string | null;
  path: string | null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'get');
    const token = String(body.token || '').trim();
    if (!isPlausibleToken(token)) throw new ShareError('Deze deellink is ongeldig.', 400);
    const tokenHash = await sha256Hex(token);

    switch (action) {
      case 'get':
        return json(req, { ok: true, ...(await getShare(tokenHash)) });
      case 'download':
        return json(req, { ok: true, ...(await downloadItem(tokenHash, body)) });
      default:
        throw new ShareError(`Onbekende actie: ${action}`, 400);
    }
  } catch (error) {
    const status = error instanceof ShareError ? error.status : 500;
    // Geen rauwe databasetekst naar een niet-ingelogde bezoeker.
    const message = error instanceof ShareError ? error.message : 'De deellink kon niet worden geopend.';
    if (status >= 500) console.error('file-share-public error', error);
    return json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ────────────────────────────────────────────────────────────

async function getShare(tokenHash: string) {
  const share = await resolveShare(tokenHash, true);
  const items = await loadItems(share.id);
  const company = await loadCompany(share.organization_id);

  return {
    share: {
      itemType: share.item_type,
      itemName: share.item_name,
      recipientName: share.recipient_name,
      message: share.message,
      canDownload: share.can_download === true,
      expiresAt: share.expires_at,
    },
    items: items.map((item) => ({
      itemType: item.item_type,
      itemId: item.item_id,
      name: item.name,
      mimeType: item.mime_type,
      sizeBytes: item.size_bytes,
      modified: item.modified,
      path: item.path || null,
      /** Downloadbaar = er zit een bestand achter én de deling staat downloaden toe. */
      downloadable: share.can_download === true && Boolean(item.storage_key),
      /** Notities en tekstdocumenten worden op de pagina zelf gelezen. */
      readable: item.item_type === 'note' || (item.item_type === 'document' && !item.storage_key),
    })),
    company: sanitizeCompany(company),
    branding: sanitizeBranding(company),
  };
}

async function downloadItem(tokenHash: string, body: Record<string, unknown>) {
  const share = await resolveShare(tokenHash, false);
  const itemType = String(body.itemType || '');
  const itemId = String(body.itemId || '');
  if (!isUuid(itemId)) throw new ShareError('Ongeldig bestand.', 400);

  // Het gevraagde item MOET binnen deze deling vallen. Nooit vertrouwen op wat de
  // browser stuurt: opnieuw uitklappen en controleren.
  const items = await loadItems(share.id);
  const item = items.find((candidate) => candidate.item_id === itemId && candidate.item_type === itemType);
  if (!item) throw new ShareError('Dit bestand hoort niet bij deze deellink.', 403);

  // Lezen is kijken, geen downloaden: een notitie of tekstdocument blijft dus ook
  // leesbaar als de afzender downloaden heeft uitgezet.
  if (item.item_type === 'note' || (!item.storage_key && item.item_type === 'document')) {
    return { text: await loadTextItem(share.organization_id, item) };
  }
  if (share.can_download !== true) throw new ShareError('Downloaden is voor deze deling uitgezet.', 403);
  if (!item.storage_key) throw new ShareError('Voor dit item is geen bestand om te downloaden.', 404);

  return {
    file: {
      fileName: item.name,
      mimeType: item.mime_type || 'application/octet-stream',
      sizeBytes: item.size_bytes,
      base64: await fetchStorageBase64(item.storage_key),
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

async function resolveShare(tokenHash: string, touch: boolean): Promise<ShareRow> {
  const { data, error } = await supabaseAdmin.rpc('resolve_drive_share_link', {
    p_token_hash: tokenHash,
    p_touch: touch,
  });
  if (error) {
    if (/does not exist|schema cache/i.test(`${error.message} ${error.details ?? ''}`)) {
      throw new ShareError('De deelfunctie is nog niet geactiveerd.', 503);
    }
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as ShareRow | undefined;
  if (!row) {
    throw new ShareError('Deze deellink bestaat niet meer, is ingetrokken of is verlopen.', 404);
  }
  return row;
}

async function loadItems(shareId: string): Promise<ShareItem[]> {
  const { data, error } = await supabaseAdmin.rpc('drive_share_items', { p_share_id: shareId });
  if (error) throw error;
  return ((data || []) as ShareItem[]).sort((a, b) =>
    (a.path || '').localeCompare(b.path || '', 'nl') || a.name.localeCompare(b.name, 'nl', { numeric: true }));
}

async function loadTextItem(organizationId: string, item: ShareItem): Promise<{ title: string; html: string }> {
  const table = item.item_type === 'note' ? 'notes' : 'documents';
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('title,content')
    .eq('id', item.item_id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ShareError('Dit item bestaat niet meer.', 404);
  const row = data as { title: string; content: string | null };
  return { title: row.title, html: row.content || '' };
}

async function fetchStorageBase64(storageKey: string): Promise<string> {
  if (!MEDIA_WORKER_URL || !MEDIA_INTERNAL_SECRET) {
    throw new ShareError('De bestandsopslag is niet gekoppeld. Neem contact op met de afzender.', 503);
  }
  const response = await fetch(`${MEDIA_WORKER_URL}/internal/media/${encodeURIComponent(storageKey)}`, {
    headers: { Authorization: `Bearer ${MEDIA_INTERNAL_SECRET}` },
  });
  if (!response.ok) {
    if (response.status === 404) throw new ShareError('Dit bestand is niet meer beschikbaar.', 404);
    throw new ShareError('Het bestand kon niet worden opgehaald.', 502);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new ShareError('Dit bestand is te groot om via de deellink te downloaden.', 413);
  }
  return arrayBufferToBase64(buffer);
}

async function loadCompany(organizationId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select(`email,phone,website,city,country,${BRANDING_COLUMNS}`)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    console.warn('file-share-public company_settings overgeslagen', error.message);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

function sanitizeCompany(company: Record<string, unknown> | null) {
  if (!company) return null;
  return {
    company_name: (company.company_name as string | null) ?? null,
    trade_name: (company.trade_name as string | null) ?? null,
    email: (company.email as string | null) ?? null,
    phone: (company.phone as string | null) ?? null,
    website: (company.website as string | null) ?? null,
    city: (company.city as string | null) ?? null,
    country: (company.country as string | null) ?? null,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Vormcontrole vóór de databaseronde: 32 random bytes base64url is 43 tekens. */
function isPlausibleToken(token: string): boolean {
  return token.length >= 20 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  if (!origin) return; // server-to-server / curl: geen browser-origin om te toetsen
  if (allowedOrigins.length === 0) return;
  if (allowedOrigins.includes(origin)) return;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  throw new ShareError('Deze frontend-origin is niet toegestaan voor de deellink.', 403);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allow = !origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ? (origin || '*')
    : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Ontbrekende environment variable: ${name}`);
  return value;
}
