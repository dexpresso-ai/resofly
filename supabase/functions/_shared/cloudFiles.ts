// ============================================================
// De regels van Google Drive en OneDrive koppelen aan Inhoud.
//
// Puur (alleen calendarOAuth.ts, dat ook puur is), zodat cloudFiles.test.ts
// het onder node vastlegt; de edge function cloud-files gebruikt het onder
// Deno.
//
// Een gekoppeld bestand is een verwijzing in een dossiermap. Het bestand zelf
// blijft in Drive of OneDrive. Verwijderen in ResoFly zet het daar in de
// prullenbak (zie 20261123150000_drive_onedrive_koppelen.sql).
// ============================================================

import { base64UrlEncode } from './calendarOAuth.ts';

export type CloudProvider = 'google' | 'microsoft';

export const CLOUD_PROVIDERS: readonly CloudProvider[] = ['google', 'microsoft'];

export function isCloudProvider(value: unknown): value is CloudProvider {
  return value === 'google' || value === 'microsoft';
}

export function cloudProviderLabel(provider: CloudProvider | string): string {
  return provider === 'google' ? 'Google Drive' : provider === 'microsoft' ? 'OneDrive' : 'de cloudopslag';
}

/**
 * De parameters die de callback aan het terugkeeradres hangt. Andere namen dan
 * bij de agenda (calendar_code …): anders rondde de app een Drive-koppeling af
 * als agendakoppeling, en andersom.
 */
export const DRIVE_RETURN_PARAMS = ['drive_code', 'drive_state', 'drive_error', 'drive_provider'] as const;

/** Hoeveel bestanden je in één keer koppelt; de kiezers laten er ook niet meer toe. */
export const MAX_LINK_FILES = 50;

// ── Rechten ──────────────────────────────────────────────────────────────────

/** Google: alleen de bestanden die iemand zelf kiest in de kiezer. */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Bewust `drive.file` en niet `drive` of `drive.readonly`. Met drive.file ziet
 * ResoFly alleen wat iemand in de kiezer van Google aanwijst, en mag het alleen
 * die bestanden in de prullenbak zetten. De bredere rechten zijn bij Google
 * "restricted": dan eist Google elk jaar een betaalde beveiligingsbeoordeling,
 * en kan ResoFly in elk bestand van iedereen kijken.
 */
export function googleDriveScopes(): string[] {
  return ['openid', 'email', 'profile', GOOGLE_DRIVE_FILE_SCOPE];
}

/**
 * Microsoft kent geen "alleen wat je kiest". Files.ReadWrite geeft toegang tot
 * de eigen OneDrive (niet tot wat anderen delen of SharePoint): genoeg om
 * bestanden te kiezen en weg te gooien. De kiezer bouwt ResoFly zelf, met de
 * tokens op de server; een token komt bij Microsoft nooit in de browser.
 */
export function microsoftDriveScopes(): string[] {
  return ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Files.ReadWrite'];
}

/** Een scope zoals de provider hem teruggeeft, in één vorm: Microsoft geeft soms de volledige URI. */
function scopeKey(scope: string): string {
  return scope.trim().replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
}

/**
 * Gaf de gebruiker genoeg om bestanden te kiezen en weg te gooien? Google laat
 * het vinkje voor Drive uitzetten; zonder dat recht heeft de koppeling geen zin.
 */
export function hasDriveScope(provider: CloudProvider, granted: readonly string[] | null | undefined): boolean {
  const have = new Set((granted ?? []).map(s => scopeKey(String(s))));
  if (provider === 'google') {
    return have.has(scopeKey(GOOGLE_DRIVE_FILE_SCOPE)) || have.has(scopeKey('https://www.googleapis.com/auth/drive'));
  }
  return have.has('files.readwrite') || have.has('files.readwrite.all');
}

/** Wat een token voor de kiezer van Google mag dragen: inloggen en drive.file, verder niets. */
const PICKER_TOKEN_SCOPES = new Set([
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  GOOGLE_DRIVE_FILE_SCOPE,
]);

/**
 * Mag dit token naar de browser, voor de kiezer van Google? Alleen als het
 * niets kan buiten de gekozen bestanden. Gebruikt Drive dezelfde Google-app
 * als de agenda en voegt Google de rechten samen, dan draagt het token ook de
 * agenda en de contacten; dat geven we niet aan een script in de browser.
 */
export function pickerTokenScopesOk(scopes: readonly string[] | null | undefined): boolean {
  const list = (scopes ?? []).map(s => String(s).trim()).filter(Boolean);
  return list.includes(GOOGLE_DRIVE_FILE_SCOPE) && list.every(s => PICKER_TOKEN_SCOPES.has(s));
}

/** Microsoft: bij het vernieuwen alleen de rechten die de koppeling echt kreeg. */
export function microsoftDriveRefreshScopes(granted: readonly string[] | null | undefined): string[] {
  const have = new Set((granted ?? []).map(s => scopeKey(String(s))));
  if (have.size === 0) return microsoftDriveScopes();
  return microsoftDriveScopes().filter(s => s === 'offline_access' || have.has(scopeKey(s)));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * De toestemmingslink. Bij Google zonder `include_granted_scopes`: anders droeg
 * het token voor Drive ook de agendarechten van een eerdere koppeling met
 * dezelfde Google-app. Dat token komt (kort) in de browser, voor de kiezer van
 * Google; het mag dan niet meer kunnen dan bestanden kiezen.
 */
export function buildDriveAuthorizeUrl(input: {
  provider: CloudProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  microsoftTenant: string;
  loginHint?: unknown;
}): string {
  const hint = typeof input.loginHint === 'string' && input.loginHint.length <= 254 && EMAIL_RE.test(input.loginHint.trim())
    ? input.loginHint.trim()
    : null;
  if (input.provider === 'google') {
    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: hint ? 'consent' : 'select_account consent',
      include_granted_scopes: 'false',
      scope: googleDriveScopes().join(' '),
      state: input.state,
    });
    if (hint) params.set('login_hint', hint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: microsoftDriveScopes().join(' '),
    state: input.state,
  });
  if (hint) params.set('login_hint', hint);
  else params.set('prompt', 'select_account');
  return `https://login.microsoftonline.com/${encodeURIComponent(input.microsoftTenant || 'common')}/oauth2/v2.0/authorize?${params}`;
}

/**
 * Een eigen sleutel voor de state van deze koppeling, afgeleid van het geheim
 * van de agenda. Zo is een state van de agendakoppeling hier ongeldig, en
 * andersom, ook als beide hetzelfde geheim gebruiken.
 */
export function driveStateSecret(secret: string): string {
  return secret ? `${secret}:cloud-files` : '';
}

/** Haalt de eigen parameters uit een terugkeeradres (de agenda-parameters doet sanitizeReturnTo al). */
export function stripDriveReturnParams(returnTo: string): string {
  const url = new URL(returnTo);
  for (const key of DRIVE_RETURN_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

// ── Opslagsleutel en adressen ───────────────────────────────────────────────

/**
 * De sleutel van een gekoppeld bestand: '<organisatie>/cloud/<provider>/<id>'.
 * Daar ligt niets in R2. Het organisatieprefix moet erin
 * (enforce_storage_keys_in_org), en het segment 'cloud' zegt elke lezer dat het
 * bestand elders staat (attachments_cloud_shape, de export, de worker).
 */
export function cloudStorageKey(organizationId: string, provider: CloudProvider, id: string): string {
  return `${organizationId}/cloud/${provider}/${id}`;
}

export function isCloudStorageKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.split('/')[1] === 'cloud';
}

const GOOGLE_WEB_HOSTS = ['drive.google.com', 'docs.google.com'];

function hostAllowed(provider: CloudProvider, host: string): boolean {
  const h = host.toLowerCase();
  if (provider === 'google') return GOOGLE_WEB_HOSTS.includes(h);
  return h === 'onedrive.live.com' || h === '1drv.ms' || h.endsWith('.sharepoint.com') || h === 'sharepoint.com';
}

/**
 * Het adres waar het bestand opent. De app zet het in een link; alleen een
 * https-adres van Google of Microsoft zelf, zodat een bestandsnaam of een
 * verzonnen antwoord nooit naar een andere site kan leiden.
 */
export function safeCloudWebUrl(provider: CloudProvider, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return hostAllowed(provider, url.hostname) ? url.toString() : null;
}

/** Een eigen adres voor een Google-bestand als Google er (nog) geen gaf. */
export function googleFallbackWebUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/** Id's van Google en Microsoft: letters, cijfers en een paar tekens. Nooit een pad. */
export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9!_\-.]{1,512}$/.test(value);
}

export function cleanCloudName(raw: unknown): string {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '-').trim();
  return (text || 'Bestand').slice(0, 255);
}

// ── Wat Google en Microsoft over een bestand zeggen ────────────────────────

export type CloudFileMeta = {
  id: string;
  driveId: string | null;
  name: string;
  mimeType: string;
  size: number | null;
  webUrl: string | null;
  /** Mag dit account het in de prullenbak zetten? null = weet de provider niet te zeggen. */
  canDelete: boolean | null;
  isFolder: boolean;
  trashed: boolean;
};

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export function parseGoogleFile(payload: unknown): CloudFileMeta | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!isProviderId(p.id)) return null;
  const mimeType = typeof p.mimeType === 'string' && p.mimeType ? p.mimeType.slice(0, 200) : 'application/octet-stream';
  const size = p.size === undefined || p.size === null ? null : Number(p.size);
  const capabilities = (p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {}) as Record<string, unknown>;
  return {
    id: p.id,
    driveId: typeof p.driveId === 'string' && isProviderId(p.driveId) ? p.driveId : null,
    name: cleanCloudName(p.name),
    mimeType,
    size: Number.isFinite(size) && (size as number) >= 0 ? Math.floor(size as number) : null,
    webUrl: safeCloudWebUrl('google', p.webViewLink) ?? googleFallbackWebUrl(p.id),
    canDelete: typeof capabilities.canTrash === 'boolean' ? capabilities.canTrash : null,
    isFolder: mimeType === GOOGLE_FOLDER_MIME,
    trashed: p.trashed === true,
  };
}

export function parseMicrosoftItem(payload: unknown): CloudFileMeta | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!isProviderId(p.id)) return null;
  const parent = (p.parentReference && typeof p.parentReference === 'object' ? p.parentReference : {}) as Record<string, unknown>;
  const file = (p.file && typeof p.file === 'object' ? p.file : null) as Record<string, unknown> | null;
  const driveId = isProviderId(parent.driveId) ? parent.driveId : null;
  const size = Number(p.size);
  return {
    id: p.id,
    driveId,
    name: cleanCloudName(p.name),
    mimeType: file && typeof file.mimeType === 'string' && file.mimeType ? file.mimeType.slice(0, 200) : 'application/octet-stream',
    size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null,
    webUrl: safeCloudWebUrl('microsoft', p.webUrl),
    // In de eigen OneDrive mag je alles weggooien; meer zegt Graph hier niet.
    canDelete: null,
    isFolder: Boolean(p.folder) || Boolean(p.package),
    trashed: Boolean(p.deleted),
  };
}

/**
 * De volgende pagina van OneDrive: alleen een adres van Graph zelf. De app
 * geeft dit adres terug bij "meer laden"; zonder deze controle haalde de
 * server met het token van de gebruiker elk adres op dat de browser noemde.
 */
export function safeGraphNextLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || url.username || url.password) return null;
    if (!url.pathname.startsWith('/v1.0/')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ── Weggooien ───────────────────────────────────────────────────────────────

export type DeleteOutcome =
  | { kind: 'done'; note: string | null }
  | { kind: 'retry'; message: string }
  | { kind: 'failed'; failure: 'connection' | 'permission' | 'other'; message: string };

/**
 * Wat het antwoord van Google of Microsoft op "weggooien" betekent.
 * - 2xx: in de prullenbak.
 * - 404/410: het bestand is er niet meer (al weggegooid, of nooit van dit
 *   account). Niets meer te doen.
 * - 401: de toegang is weg; opnieuw koppelen helpt.
 * - 403: dit account mag het niet weggooien (geen eigenaar), of de beheerder
 *   blokkeert het. Bij Google ook een quotum ("rateLimitExceeded"): dat is
 *   later opnieuw.
 * - 423 (vergrendeld, OneDrive), 429, 5xx: later opnieuw.
 */
export function classifyDeleteResponse(provider: CloudProvider, status: number, body: unknown): DeleteOutcome {
  const label = cloudProviderLabel(provider);
  if (status >= 200 && status < 300) return { kind: 'done', note: null };
  if (status === 404 || status === 410) return { kind: 'done', note: `Stond al niet meer in ${label}.` };
  const reason = providerErrorReason(body);
  if (status === 401) {
    return { kind: 'failed', failure: 'connection', message: `${label} geeft ResoFly geen toegang meer. Koppel ${label} opnieuw; dan gooit ResoFly het bestand alsnog weg.` };
  }
  if (status === 403 && /rate ?limit|userRateLimitExceeded|rateLimitExceeded|quota/i.test(reason)) {
    return { kind: 'retry', message: `${label} vroeg om even te wachten.` };
  }
  if (status === 403) {
    return {
      kind: 'failed',
      failure: 'permission',
      message: provider === 'google'
        ? 'Google Drive laat dit account het bestand niet weggooien: alleen de eigenaar (of in een gedeelde Drive een beheerder) kan dat. Het staat dus nog in Google Drive.'
        : 'OneDrive laat dit account het bestand niet weggooien. Het staat dus nog in OneDrive.',
    };
  }
  if (status === 0 || status === 408 || status === 423 || status === 429 || status >= 500) {
    return { kind: 'retry', message: status === 423 ? `Het bestand is in ${label} even vergrendeld (iemand heeft het open).` : `${label} was even niet bereikbaar.` };
  }
  return { kind: 'failed', failure: 'other', message: `${label} weigerde het weggooien (${status}${reason ? `: ${reason.slice(0, 80)}` : ''}).` };
}

function providerErrorReason(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const error = (body as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const errors = Array.isArray(e.errors) ? e.errors as Array<Record<string, unknown>> : [];
    const reason = errors.map(x => String(x.reason ?? '')).filter(Boolean).join(' ');
    return [String(e.code ?? ''), reason, String(e.message ?? '')].filter(Boolean).join(' ').trim();
  }
  return '';
}

/** Na zoveel mislukte pogingen (storingen) wacht het weggooien op een mens. */
export const MAX_DELETE_ATTEMPTS = 8;

/** Wachttijd na poging n (1, 2, …): 5 minuten, dan steeds twee keer zo lang, hooguit 12 uur. */
export function nextAttemptDelaySeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(12 * 3600, 300 * 2 ** (n - 1));
}

// ── Tokens versleutelen (AES-GCM, sleutel afgeleid via SHA-256) ─────────────
//
// Hetzelfde formaat als de agenda (calendarCore.ts), maar met de sleutel als
// argument: zo hangt deze module niet aan omgevingsvariabelen en is hij te
// testen.

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
