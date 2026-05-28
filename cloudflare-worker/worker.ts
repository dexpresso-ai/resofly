export interface Env {
  MEDIA_BUCKET: R2Bucket;
  ALLOWED_ORIGIN: string; // comma-separated list, or '*' for any origin
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  INTERNAL_UPLOAD_SECRET?: string; // server-to-server only, used by Supabase Edge Functions for immutable finance PDFs
}

const allowedEntityTypes = new Set(['client','project','task','subtask','ticket','note','quote','invoice']);
const entityTable: Record<string, string> = { client: 'clients', project: 'projects', task: 'tasks', ticket: 'tickets', note: 'notes', quote: 'quotes', invoice: 'invoices' };
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/internal/invoice-snapshot' && request.method === 'POST') {
        if (!isInternalRequest(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
        if (!request.body) return json({ error: 'Missing body' }, 400, cors);
        const key = request.headers.get('x-storage-key') || '';
        const type = request.headers.get('content-type') || 'application/pdf';
        const declaredLength = Number(request.headers.get('content-length') || '0');
        const sha256 = request.headers.get('x-sha256') || '';
        if (!isPrivateInvoiceSnapshotKey(key)) return json({ error: 'Invalid storage key' }, 400, cors);
        if (type !== 'application/pdf') return json({ error: 'Only application/pdf is allowed' }, 400, cors);
        if (declaredLength > MAX_UPLOAD_BYTES) return json({ error: 'Bestand is te groot' }, 413, cors);
        const limited = limitBodySize(request.body, MAX_UPLOAD_BYTES);
        try {
          await env.MEDIA_BUCKET.put(key, limited, {
            httpMetadata: { contentType: type },
            customMetadata: { private: 'true', entity_type: 'invoice_pdf_snapshot', sha256 },
          });
        } catch (e) {
          if (e instanceof Error && e.message === 'PAYLOAD_TOO_LARGE') return json({ error: 'Bestand is te groot' }, 413, cors);
          throw e;
        }
        return json({ ok: true, key }, 200, cors);
      }

      if (url.pathname.startsWith('/internal/invoice-snapshot/') && request.method === 'GET') {
        if (!isInternalRequest(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
        const key = decodeURIComponent(url.pathname.replace('/internal/invoice-snapshot/', ''));
        if (!isPrivateInvoiceSnapshotKey(key)) return json({ error: 'Invalid storage key' }, 400, cors);
        const object = await env.MEDIA_BUCKET.get(key);
        if (!object) return json({ error: 'Not found' }, 404, cors);
        const headers = new Headers(cors);
        object.writeHttpMetadata(headers);
        headers.set('cache-control', 'private, max-age=300');
        headers.set('x-resofly-private-snapshot', 'true');
        return new Response(object.body, { headers });
      }

      if (request.method === 'POST' && url.pathname === '/upload') {
        const user = await verifySupabaseUser(request, env);
        if (!user?.id) return json({ error: 'Unauthorized' }, 401, cors);
        if (!request.body) return json({ error: 'Missing body' }, 400, cors);

        const entityType = request.headers.get('x-entity-type') || '';
        const entityId = request.headers.get('x-entity-id') || '';
        const organizationId = request.headers.get('x-organization-id') || '';
        const fileName = decodeHeaderFileName(request.headers.get('x-file-name') || 'bestand');
        const type = request.headers.get('x-file-type') || 'application/octet-stream';
        const declaredLength = Number(request.headers.get('content-length') || '0');
        const parentTaskId = request.headers.get('x-parent-task-id') || '';

        if (!allowedEntityTypes.has(entityType)) return json({ error: 'Invalid entity type' }, 400, cors);
        if (!isUuid(organizationId)) return json({ error: 'Invalid organization id' }, 400, cors);
        if (!isUuid(entityId)) return json({ error: 'Invalid entity id' }, 400, cors);
        if (!isAllowedMimeType(type)) return json({ error: 'Bestandstype niet toegestaan' }, 400, cors);
        if (declaredLength > MAX_UPLOAD_BYTES) return json({ error: 'Bestand is te groot' }, 413, cors);
        const ownsEntity = await verifyEntityOwnership(env, request, user.id, organizationId, entityType, entityId, parentTaskId);
        if (!ownsEntity) return json({ error: 'Entity niet gevonden of geen toegang' }, 403, cors);

        const key = `${organizationId}/${entityType}/${entityId}/${crypto.randomUUID()}-${safeName(fileName)}`;

        // Stream-cap: refuse if the actual body exceeds the limit, even when Content-Length lied.
        const limited = limitBodySize(request.body, MAX_UPLOAD_BYTES);
        try {
          await env.MEDIA_BUCKET.put(key, limited, {
            httpMetadata: { contentType: type },
            customMetadata: { organization_id: organizationId, user_id: user.id, entity_type: entityType, entity_id: entityId },
          });
        } catch (e) {
          if (e instanceof Error && e.message === 'PAYLOAD_TOO_LARGE') {
            return json({ error: 'Bestand is te groot' }, 413, cors);
          }
          throw e;
        }
        return json({ ok: true, key }, 200, cors);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/file/')) {
        const user = await verifySupabaseUser(request, env);
        if (!user?.id) return json({ error: 'Unauthorized' }, 401, cors);
        const key = decodeURIComponent(url.pathname.replace('/file/', ''));
        if (!await canAccessObjectKey(env, request, user.id, key)) return json({ error: 'Invalid key' }, 400, cors);
        const object = await env.MEDIA_BUCKET.get(key);
        if (!object) return new Response('Not found', { status: 404, headers: cors });
        const headers = new Headers(cors);
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('cache-control', 'private, max-age=3600');
        return new Response(object.body, { headers });
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/file/')) {
        const user = await verifySupabaseUser(request, env);
        if (!user?.id) return json({ error: 'Unauthorized' }, 401, cors);
        const key = decodeURIComponent(url.pathname.replace('/file/', ''));
        if (!await canAccessObjectKey(env, request, user.id, key, true)) return json({ error: 'Invalid key' }, 400, cors);
        await env.MEDIA_BUCKET.delete(key);
        return json({ ok: true }, 200, cors);
      }

      return json({ ok: true, service: 'brandcore-r2-worker' }, 200, cors);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500, cors);
    }
  },
};

async function verifySupabaseUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!response.ok) return null;
  return response.json() as Promise<{ id: string }>;
}

/**
 * Strict CORS:
 *   - Empty/missing ALLOWED_ORIGIN → no Access-Control-Allow-Origin header at all (browser blocks).
 *   - '*' → reflects the request origin (or '*' if none), useful for dev only.
 *   - Comma-separated list → exact-match against the request origin.
 */

async function verifyEntityOwnership(env: Env, request: Request, userId: string, organizationId: string, entityType: string, entityId: string, parentTaskId: string): Promise<boolean> {
  if (!await verifyOrganizationAccess(env, request, userId, organizationId, true)) return false;
  if (entityType === 'subtask') {
    if (!isUuid(parentTaskId)) return false;
    return verifySubtaskOwnership(env, request, organizationId, entityId, parentTaskId);
  }

  const table = entityTable[entityType];
  if (!table) return false;

  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(entityId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id&limit=1`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: request.headers.get('authorization') || '',
      accept: 'application/json',
    },
  });
  if (!response.ok) return false;
  const rows = await response.json() as Array<{ id: string }>;
  return rows.length === 1;
}

async function verifySubtaskOwnership(env: Env, request: Request, organizationId: string, subtaskId: string, parentTaskId: string): Promise<boolean> {
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const query = [
    `id=eq.${encodeURIComponent(parentTaskId)}`,
    `organization_id=eq.${encodeURIComponent(organizationId)}`,
    'select=id,subtasks',
    'limit=1',
  ].join('&');
  const response = await fetch(`${base}/rest/v1/tasks?${query}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: request.headers.get('authorization') || '',
      accept: 'application/json',
    },
  });
  if (!response.ok) return false;

  const rows = await response.json() as Array<{ id: string; subtasks?: Array<{ id?: string }> }>;
  const task = rows[0];
  if (!task) return false;
  return Array.isArray(task.subtasks) && task.subtasks.some(subtask => subtask?.id === subtaskId);
}

function isInternalRequest(request: Request, env: Env): boolean {
  const configured = env.INTERNAL_UPLOAD_SECRET || '';
  if (!configured) return false;
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return timingSafeEqual(token, configured);
}

function isPrivateInvoiceSnapshotKey(key: string): boolean {
  if (key.includes('..') || key.startsWith('/') || key.length > 900) return false;
  return /^[0-9a-f-]{36}\/invoice-pdfs\/[0-9a-f-]{36}\/[0-9a-f-]{36}-[a-z0-9._-]+\.pdf$/i.test(key);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i];
  return out === 0;
}

function decodeHeaderFileName(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function corsHeaders(env: Env, origin: string): Record<string, string> {
  const configured = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-file-name,x-file-type,x-entity-type,x-entity-id,x-organization-id,x-parent-task-id',
    'vary': 'Origin',
  };
  let allowOrigin = '';
  if (configured.includes('*')) allowOrigin = origin || '*';
  else if (origin && configured.includes(origin)) allowOrigin = origin;
  if (allowOrigin) headers['access-control-allow-origin'] = allowOrigin;
  return headers;
}

function json(body: unknown, status: number, headers: Record<string,string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function canAccessObjectKey(env: Env, request: Request, userId: string, key: string, requireWrite = false): Promise<boolean> {
  if (key.includes('..') || key.startsWith('/') || key.length > 900) return false;
  const organizationId = key.split('/')[0] || '';
  if (!isUuid(organizationId)) return false;
  return verifyOrganizationAccess(env, request, userId, organizationId, requireWrite);
}

async function verifyOrganizationAccess(env: Env, request: Request, userId: string, organizationId: string, requireWrite = false): Promise<boolean> {
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const query = [
    `organization_id=eq.${encodeURIComponent(organizationId)}`,
    `user_id=eq.${encodeURIComponent(userId)}`,
    'status=eq.active',
    'select=id,role',
    ...(requireWrite ? ['role=in.(owner,admin,member)'] : []),
    'limit=1',
  ].join('&');
  const response = await fetch(`${base}/rest/v1/organization_members?${query}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: request.headers.get('authorization') || '',
      accept: 'application/json',
    },
  });
  if (!response.ok) return false;
  const rows = await response.json() as Array<{ id: string }>;
  return rows.length === 1;
}

function safeName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9.\-_]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120);
  return safe || 'bestand';
}

function isAllowedMimeType(type: string): boolean {
  return type.startsWith('image/') || [
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
  ].includes(type);
}

/**
 * Wrap a ReadableStream so it errors out the moment cumulative bytes exceed `max`.
 * Defends against clients that lie about Content-Length.
 */
function limitBodySize(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = stream.getReader();
      function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) { controller.close(); return; }
          total += value.byteLength;
          if (total > max) {
            controller.error(new Error('PAYLOAD_TOO_LARGE'));
            reader.cancel().catch(() => undefined);
            return;
          }
          controller.enqueue(value);
          return pump();
        }).catch(err => controller.error(err));
      }
      pump();
    },
  });
}
