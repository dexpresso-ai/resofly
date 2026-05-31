export interface Env {
  MEDIA_BUCKET: R2Bucket;
  APP_ENV: string;
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  MEDIA_SIGNING_SECRET?: string;
}

type JsonBody = Record<string, unknown> | Array<unknown>;

type RouteContext = {
  requestId: string;
  url: URL;
  corsHeaders: Headers;
};

const ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';
const MAX_AGE_SECONDS = '86400';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const context = createContext(request, env);

    if (request.method === 'OPTIONS') {
      return handleOptions(context);
    }

    try {
      return await routeRequest(request, env, context);
    } catch {
      return errorResponse('Internal server error', 500, context);
    }
  },
};

async function routeRequest(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const { pathname } = context.url;

  if (request.method === 'GET' && pathname === '/health') {
    return jsonResponse(
      {
        status: 'ok',
        service: 'resofly-media-api',
        environment: normalizeEnvironment(env.APP_ENV),
      },
      200,
      context,
    );
  }

  if (request.method === 'POST' && pathname === '/upload/request') {
    return notImplementedResponse('Upload request flow is not implemented yet.', context, {
      next: [
        'Validate Supabase JWT from Authorization header.',
        'Resolve organization_id and project/file metadata server-side.',
        'Generate a scoped private R2 object key.',
        'Return a short-lived signed upload contract or direct upload endpoint.',
      ],
    });
  }

  const fileMatch = matchFileRoute(pathname);
  if (fileMatch && request.method === 'GET') {
    return notImplementedResponse('Private file download flow is not implemented yet.', context, {
      fileId: fileMatch.fileId,
      next: [
        'Validate Supabase JWT from Authorization header.',
        'Authorize access by organization membership and file metadata.',
        'Read the private object from MEDIA_BUCKET.',
        'Return the object stream with safe private-cache headers.',
      ],
    });
  }

  if (fileMatch && request.method === 'DELETE') {
    return notImplementedResponse('Private file delete flow is not implemented yet.', context, {
      fileId: fileMatch.fileId,
      next: [
        'Validate Supabase JWT from Authorization header.',
        'Authorize delete permissions by organization role.',
        'Delete object from MEDIA_BUCKET.',
        'Record deletion metadata/audit event in Supabase.',
      ],
    });
  }

  if (isKnownPath(pathname)) {
    return errorResponse('Method not allowed', 405, context);
  }

  return errorResponse('Route not found', 404, context);
}

function createContext(request: Request, env: Env): RouteContext {
  const url = new URL(request.url);
  return {
    requestId: crypto.randomUUID(),
    url,
    corsHeaders: createCorsHeaders(request, env),
  };
}

function handleOptions(context: RouteContext): Response {
  return new Response(null, {
    status: 204,
    headers: context.corsHeaders,
  });
}

function jsonResponse(body: JsonBody, status: number, context: RouteContext): Response {
  const headers = new Headers(context.corsHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Request-Id', context.requestId);
  headers.set('Cache-Control', 'no-store');

  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  message: string,
  status: number,
  context: RouteContext,
  internalMessage?: string,
): Response {
  const errorBody: Record<string, unknown> = {
    message,
    status,
    requestId: context.requestId,
  };

  if (internalMessage) {
    errorBody.detail = internalMessage;
  }

  return jsonResponse({ error: errorBody }, status, context);
}

function notImplementedResponse(message: string, context: RouteContext, details: JsonBody): Response {
  return jsonResponse(
    {
      error: {
        message,
        status: 501,
        requestId: context.requestId,
      },
      details,
    },
    501,
    context,
  );
}

function createCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, env);

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
  }

  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  headers.set('Access-Control-Max-Age', MAX_AGE_SECONDS);
  headers.set('Vary', 'Origin');

  return headers;
}

function resolveAllowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) {
    return null;
  }

  const allowedOrigins = getAllowedOrigins(env);
  return allowedOrigins.has(origin) ? origin : null;
}

function getAllowedOrigins(env: Env): Set<string> {
  const configuredOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowedOrigins = new Set(configuredOrigins);
  const appEnv = normalizeEnvironment(env.APP_ENV);

  if (appEnv === 'local' || appEnv === 'staging') {
    allowedOrigins.add('http://localhost:5173');
  }

  return allowedOrigins;
}

function normalizeEnvironment(value: string | undefined): 'local' | 'staging' | 'production' {
  if (value === 'staging' || value === 'production') {
    return value;
  }

  return 'local';
}

function matchFileRoute(pathname: string): { fileId: string } | null {
  const match = pathname.match(/^\/files\/([^/]+)$/);
  if (!match?.[1]) {
    return null;
  }

  return { fileId: decodeURIComponent(match[1]) };
}

function isKnownPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/upload/request' || matchFileRoute(pathname) !== null;
}
