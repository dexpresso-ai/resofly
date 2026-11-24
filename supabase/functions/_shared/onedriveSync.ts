// ============================================================
// De regels van de kopie van Inhoud in OneDrive.
//
// Puur (alleen calendarOAuth.ts, dat ook puur is), zodat onedriveSync.test.ts
// het onder node vastlegt; de edge function onedrive-sync gebruikt het onder
// Deno. Plan: docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md.
// ============================================================

import { base64UrlEncode } from './calendarOAuth.ts';

// ── Rechten bij Microsoft ───────────────────────────────────────────────────

/**
 * Files.ReadWrite: de eigen OneDrive van wie koppelt. Genoeg om een map aan te
 * maken en bestanden te zetten, te hernoemen, te verplaatsen en weg te gooien.
 * Niet Files.ReadWrite.All: dat geeft ook alles wat anderen met hem delen en
 * SharePoint, en dat is voor de kopie niet nodig (keuze C: eerst alleen OneDrive).
 */
export function onedriveScopes(): string[] {
  return ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Files.ReadWrite'];
}

/** Microsoft geeft een scope soms als volledige URI. */
function scopeKey(scope: string): string {
  return scope.trim().replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
}

/** Gaf Microsoft het recht op bestanden? Zonder dat heeft de koppeling geen zin. */
export function hasFilesScope(granted: readonly string[] | null | undefined): boolean {
  const have = new Set((granted ?? []).map(s => scopeKey(String(s))));
  return have.has('files.readwrite') || have.has('files.readwrite.all');
}

/**
 * Bij het vernieuwen alleen de rechten die de koppeling echt kreeg: vraagt de
 * vernieuwing om een recht dat nooit gegeven is, dan weigert Microsoft hem
 * (dezelfde les als bij de agenda, microsoftRefreshScopes).
 */
export function onedriveRefreshScopes(granted: readonly string[] | null | undefined): string[] {
  const have = new Set((granted ?? []).map(s => scopeKey(String(s))));
  if (have.size === 0) return onedriveScopes();
  return onedriveScopes().filter(s => s === 'offline_access' || have.has(scopeKey(s)));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildOneDriveAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  tenant: string;
  loginHint?: unknown;
}): string {
  const hint = typeof input.loginHint === 'string' && input.loginHint.length <= 254 && EMAIL_RE.test(input.loginHint.trim())
    ? input.loginHint.trim()
    : null;
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: onedriveScopes().join(' '),
    state: input.state,
  });
  if (hint) params.set('login_hint', hint);
  else params.set('prompt', 'select_account');
  return `https://login.microsoftonline.com/${encodeURIComponent(input.tenant || 'common')}/oauth2/v2.0/authorize?${params}`;
}

/**
 * Een eigen sleutel voor de state, afgeleid van het geheim van de agenda. Zo
 * geldt een state van de agendakoppeling hier niet, en andersom.
 */
export function onedriveStateSecret(secret: string): string {
  return secret ? `${secret}:onedrive-sync` : '';
}

// ── Het terugkeeradres ──────────────────────────────────────────────────────

/** De parameters die de callback aan het terugkeeradres hangt. */
export const ONEDRIVE_RETURN_PARAMS = ['onedrive_code', 'onedrive_state', 'onedrive_error'] as const;

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Het adres van de app waar de browser na het koppelen naartoe gaat. Strenger
 * dan bij de agenda (sanitizeReturnTo): alleen de ingestelde adressen, geen
 * Cloudflare-previews. Wie een preview kan uitrollen, kon anders een koppellink
 * starten met zijn eigen preview als terugkeeradres en die naar een eigenaar
 * sturen; na diens "toestaan" kwam de code bij hem binnen (review van
 * 24 november). Zonder ingestelde adressen alleen de lokale ontwikkelserver.
 */
export function strictReturnTo(raw: unknown, allowedOrigins: string[]): string {
  const candidate = String(raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Ongeldig terugkeeradres.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Ongeldig terugkeeradres.');
  url.username = '';
  url.password = '';
  const ok = allowedOrigins.length ? allowedOrigins.includes(url.origin) : isLocalDevOrigin(url.origin);
  if (!ok) throw new Error(`Terugkeeradres niet toegestaan: ${url.origin}`);
  for (const key of ONEDRIVE_RETURN_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

// ── Namen in OneDrive ───────────────────────────────────────────────────────

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Een naam die OneDrive accepteert. Niet toegestaan zijn " * : < > ? / \ |,
 * een naam die eindigt op een punt of spatie, ~$ vooraan, _vti_ ergens,
 * .lock en desktop.ini, en de oude apparaatnamen (CON, PRN, …).
 */
export function safeDriveName(raw: unknown, fallback = 'Naamloos'): string {
  let name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["*:<>?/\\|]/g, '-')
    .replace(/_vti_/gi, '_vti-')
    .trim()
    .replace(/[. ]+$/g, '');
  if (name.startsWith('~$')) name = `_${name.slice(2)}`;
  if (!name || name === '.lock' || name.toLowerCase() === 'desktop.ini' || RESERVED.test(name)) {
    name = name ? `_${name}` : fallback;
  }
  // OneDrive staat 255 tekens toe; houd de extensie heel.
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = `${name.slice(0, 200 - ext.length).trimEnd()}${ext}`;
  }
  return name || fallback;
}

/** "rapport.pdf", 2 → "rapport (2).pdf". Voor als de naam in die map al bestaat. */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 12) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

const OFFICE_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'text/csv': '.csv',
};

/**
 * De bestandsnaam van een Word/Excel/PowerPoint-document. Een document heeft
 * een titel zonder extensie ("Offerte website"); in OneDrive moet het
 * "Offerte website.docx" heten, anders opent niets het.
 */
export function documentFileName(title: unknown, mimeType: unknown, storageKey: unknown): string {
  const base = safeDriveName(title, 'Document');
  const fromMime = OFFICE_EXTENSIONS[String(mimeType ?? '').toLowerCase()] ?? '';
  const fromKey = String(storageKey ?? '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[0] ?? '';
  const ext = fromMime || fromKey;
  if (!ext || base.toLowerCase().endsWith(ext)) return base;
  return safeDriveName(`${base}${ext}`, 'Document');
}

/** De map van de organisatie in OneDrive. */
export function rootFolderName(organizationName: unknown): string {
  const name = safeDriveName(organizationName, '');
  return name ? safeDriveName(`ResoFly - ${name}`) : 'ResoFly';
}

export const NO_CLIENT_FOLDER = 'Zonder klant';

/**
 * Wanneer de inhoud opnieuw naar OneDrive moet: een ander bestand in R2, een
 * nieuwe versie uit de editor, of een andere grootte.
 */
export function contentVersion(row: { storage_key?: string | null; edit_version?: number | null; size_bytes?: number | null }): string {
  return `${row.storage_key ?? ''}|${row.edit_version ?? 0}|${row.size_bytes ?? 0}`;
}

/**
 * Id's van Microsoft: letters, cijfers en een paar tekens, met minstens één
 * letter of cijfer. Nooit een pad: ".." komt er niet door (review van
 * 24 november: de eerste versie liet het door).
 */
export function isDriveId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9!_\-.]{1,512}$/.test(value)
    && /[A-Za-z0-9]/.test(value)
    && !value.includes('..');
}

/** De opslagsegmenten waarvan een kopie in OneDrive mag. Nooit financiële bewijsstukken. */
export const MIRROR_KEY_SEGMENTS: ReadonlySet<string> = new Set(['folder', 'document', 'client', 'project', 'task', 'subtask', 'ticket', 'note']);

export function mirrorableKey(key: unknown, organizationId: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 1024 || key.includes('..') || key.startsWith('/')) return false;
  const [org, segment] = key.split('/');
  return org === organizationId && MIRROR_KEY_SEGMENTS.has(segment ?? '');
}

// ── Antwoorden van Microsoft ────────────────────────────────────────────────

export type GraphOutcome =
  | { kind: 'ok' }
  | { kind: 'gone' }
  | { kind: 'conflict' }
  | { kind: 'retry'; message: string; retryAfterSeconds: number | null }
  | { kind: 'reconnect'; message: string }
  | { kind: 'full'; message: string }
  | { kind: 'failed'; message: string };

function graphErrorCode(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const error = (body as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const inner = e.innerError && typeof e.innerError === 'object' ? String((e.innerError as Record<string, unknown>).code ?? '') : '';
    return [String(e.code ?? ''), inner].filter(Boolean).join(' ');
  }
  return '';
}

function graphErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const error = (body as Record<string, unknown>).error;
  if (error && typeof error === 'object') return String((error as Record<string, unknown>).message ?? '').slice(0, 160);
  return '';
}

/**
 * Wat een antwoord van Microsoft Graph betekent voor een taak.
 * - 2xx: gelukt. 404/410: het item is er niet (meer).
 * - 409: de naam bestaat al in die map (de aanroeper probeert "naam (2)").
 * - 401: de toegang is weg; opnieuw koppelen.
 * - 507 of "quotaLimitReached": OneDrive is vol.
 * - 423 (vergrendeld), 429, 5xx, of geen antwoord: later opnieuw, met de
 *   wachttijd die Microsoft noemt (Retry-After).
 */
export function classifyGraphResponse(status: number, body: unknown, retryAfter?: string | null): GraphOutcome {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 404 || status === 410) return { kind: 'gone' };
  if (status === 409) return { kind: 'conflict' };
  const code = graphErrorCode(body);
  const after = retryAfter != null && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  if (status === 401) return { kind: 'reconnect', message: 'OneDrive geeft ResoFly geen toegang meer. De eigenaar moet OneDrive opnieuw koppelen.' };
  if (status === 507 || /quotaLimitReached|insufficientStorage/i.test(code)) {
    return { kind: 'full', message: 'De OneDrive van de eigenaar is vol. Maak ruimte in OneDrive; daarna gaat de kopie vanzelf verder.' };
  }
  if (status === 0 || status === 408 || status === 423 || status === 429 || status >= 500) {
    return {
      kind: 'retry',
      message: status === 423 ? 'Het bestand is in OneDrive even vergrendeld (iemand heeft het open).' : 'OneDrive was even niet bereikbaar of vroeg om te wachten.',
      retryAfterSeconds: after,
    };
  }
  if (status === 403) return { kind: 'failed', message: `OneDrive weigerde dit (${code || 'geen toegang'}).` };
  const detail = graphErrorMessage(body);
  return { kind: 'failed', message: `OneDrive weigerde dit (${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}).` };
}

/** Na zoveel mislukte pogingen wacht een taak op een mens (Opnieuw proberen). */
export const MAX_JOB_ATTEMPTS = 8;

/** Wachttijd na poging n: 1 minuut, dan steeds twee keer zo lang, hooguit 6 uur. Microsoft mag langer vragen. */
export function nextAttemptDelaySeconds(attempt: number, retryAfterSeconds?: number | null): number {
  const n = Math.max(1, Math.floor(attempt));
  const backoff = Math.min(6 * 3600, 60 * 2 ** (n - 1));
  return Math.max(backoff, Math.min(retryAfterSeconds ?? 0, 24 * 3600));
}

// ── Tokens versleutelen (AES-GCM, sleutel afgeleid via SHA-256) ─────────────
//
// Hetzelfde formaat als de agenda (calendarCore.ts), met de sleutel als
// argument: zo hangt deze module niet aan omgevingsvariabelen.

async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error('De sleutel voor het versleutelen van tokens ontbreekt of is te kort.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(value));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export async function decryptToken(value: string, secret: string): Promise<string> {
  const [ivRaw, dataRaw] = String(value || '').split('.');
  if (!ivRaw || !dataRaw) throw new Error('Token decryptieformaat is ongeldig.');
  const decode = (raw: string) => {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');
    const binary = atob(padded);
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(ivRaw) }, await aesKey(secret), decode(dataRaw));
  return new TextDecoder().decode(decrypted);
}
