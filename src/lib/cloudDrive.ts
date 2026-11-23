import type { Attachment, CloudDriveProvider } from '../types';

/**
 * Google Drive en OneDrive in Inhoud: wat de app over een gekoppeld bestand
 * weet, en de terugkeer na het koppelen. Puur (geen supabase-client), zodat
 * cloudDrive.test.ts het onder node vastlegt.
 *
 * Een gekoppeld bestand is een bijlage in een dossiermap met cloud_provider
 * erbij. Het bestand zelf staat in Drive of OneDrive en opent daar. Verwijder
 * je het in ResoFly, dan gaat het daar naar de prullenbak (de database zet het
 * in cloud_file_deletions, de edge function cloud-files doet de rest).
 */

export const CLOUD_PROVIDERS: readonly CloudDriveProvider[] = ['google', 'microsoft'];

export function cloudProviderLabel(provider: CloudDriveProvider | string | null | undefined): string {
  return provider === 'google' ? 'Google Drive' : provider === 'microsoft' ? 'OneDrive' : 'de cloudopslag';
}

/** Staat dit bestand in Google Drive of OneDrive (en niet in onze eigen opslag)? */
export function isCloudAttachment(att: Pick<Attachment, 'storage_key'> & { cloud_provider?: CloudDriveProvider | null }): boolean {
  if (att.cloud_provider === 'google' || att.cloud_provider === 'microsoft') return true;
  // Ook als de kolom (nog) niet is meegekomen: de sleutel zegt het al.
  return typeof att.storage_key === 'string' && att.storage_key.split('/')[1] === 'cloud';
}

export function cloudProviderOf(att: Pick<Attachment, 'storage_key'> & { cloud_provider?: CloudDriveProvider | null }): CloudDriveProvider | null {
  if (att.cloud_provider === 'google' || att.cloud_provider === 'microsoft') return att.cloud_provider;
  const parts = typeof att.storage_key === 'string' ? att.storage_key.split('/') : [];
  return parts[1] === 'cloud' && (parts[2] === 'google' || parts[2] === 'microsoft') ? parts[2] : null;
}

/**
 * Het adres om het bestand te openen. Alleen https bij Google of Microsoft: de
 * server zet het zo, maar een link in de app volgt nooit blind wat er in een
 * rij staat.
 */
export function cloudOpenUrl(att: Pick<Attachment, 'storage_key'> & { cloud_provider?: CloudDriveProvider | null; cloud_web_url?: string | null; cloud_file_id?: string | null }): string | null {
  const provider = cloudProviderOf(att);
  if (!provider) return null;
  const raw = att.cloud_web_url;
  if (typeof raw === 'string' && raw) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const ok = url.protocol === 'https:' && (provider === 'google'
        ? host === 'drive.google.com' || host === 'docs.google.com'
        : host === 'onedrive.live.com' || host === '1drv.ms' || host === 'sharepoint.com' || host.endsWith('.sharepoint.com'));
      if (ok) return url.toString();
    } catch { /* geen adres */ }
  }
  if (provider === 'google' && att.cloud_file_id && /^[A-Za-z0-9_\-]{1,512}$/.test(att.cloud_file_id)) {
    return `https://drive.google.com/file/d/${att.cloud_file_id}/view`;
  }
  return null;
}

/** De grootte om te tonen: een gekoppeld bestand telt niet in onze opslag (size_bytes = 0). */
export function attachmentDisplayBytes(att: Pick<Attachment, 'size_bytes'> & { cloud_size_bytes?: number | null; cloud_provider?: CloudDriveProvider | null; storage_key?: string }): number | null {
  if (att.cloud_provider || (typeof att.storage_key === 'string' && att.storage_key.split('/')[1] === 'cloud')) {
    return typeof att.cloud_size_bytes === 'number' ? att.cloud_size_bytes : null;
  }
  return att.size_bytes;
}

/** De bevestiging bij verwijderen, met wat er buiten ResoFly gebeurt. */
export function deleteConfirmText(atts: Array<Pick<Attachment, 'name' | 'storage_key'> & { cloud_provider?: CloudDriveProvider | null }>): string {
  if (atts.length === 1) {
    const att = atts[0];
    const provider = cloudProviderOf(att);
    return provider
      ? `"${att.name}" verwijderen? Het bestand gaat ook in ${cloudProviderLabel(provider)} naar de prullenbak (daar kun je het nog terugzetten).`
      : `"${att.name}" verwijderen? Het bestand wordt ook uit de Cloudflare-opslag gehaald.`;
  }
  const cloud = atts.filter(a => isCloudAttachment(a));
  const providers = [...new Set(cloud.map(a => cloudProviderLabel(cloudProviderOf(a))))];
  const base = `${atts.length} bestanden verwijderen?`;
  if (!cloud.length) return `${base} Ze worden ook uit de Cloudflare-opslag gehaald.`;
  return `${base} ${cloud.length === atts.length ? 'Ze gaan' : `${cloud.length} ervan gaan`} ook in ${providers.join(' en ')} naar de prullenbak (daar kun je ze nog terugzetten).`;
}

// ── De terugkeer van Google of Microsoft ────────────────────────────────────

/** Gelijk aan DRIVE_RETURN_PARAMS in supabase/functions/_shared/cloudFiles.ts (de test bewaakt dat). */
export const DRIVE_RETURN_PARAMS = ['drive_code', 'drive_state', 'drive_error', 'drive_provider'] as const;

/** Dezelfde vaste foutcodes als bij de agenda (CALENDAR_OAUTH_ERROR_CODES): de callback deelt classifyProviderError. */
export const DRIVE_OAUTH_ERROR_CODES = ['geweigerd', 'beheerder', 'verlopen', 'ongeldig', 'storing', 'mislukt'] as const;
export type DriveOAuthErrorCode = typeof DRIVE_OAUTH_ERROR_CODES[number];

export type DriveOAuthReturn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: DriveOAuthErrorCode; provider: CloudDriveProvider | null };

/**
 * Leest de terugkeer uit een adres. `cleaned` is hetzelfde adres zonder de
 * koppelparameters (voor history.replaceState), of null als er niets te lezen
 * was. De tekst die de gebruiker leest komt hier vandaan, nooit uit het adres.
 */
export function parseDriveOAuthReturn(href: string): { result: DriveOAuthReturn | null; cleaned: string | null } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { result: null, cleaned: null };
  }
  if (!DRIVE_RETURN_PARAMS.some(key => url.searchParams.has(key))) return { result: null, cleaned: null };
  const code = url.searchParams.get('drive_code');
  const state = url.searchParams.get('drive_state');
  const error = url.searchParams.get('drive_error');
  const provider = url.searchParams.get('drive_provider');
  for (const key of DRIVE_RETURN_PARAMS) url.searchParams.delete(key);
  const cleaned = `${url.pathname}${url.search}${url.hash}`;
  let result: DriveOAuthReturn | null = null;
  if (error !== null) {
    const known = (DRIVE_OAUTH_ERROR_CODES as readonly string[]).includes(error) ? error as DriveOAuthErrorCode : 'mislukt';
    result = { kind: 'error', error: known, provider: provider === 'google' || provider === 'microsoft' ? provider : null };
  } else if (code && state && code.length <= 4096 && state.length <= 4096) {
    result = { kind: 'code', code, state };
  }
  return { result, cleaned };
}

export function driveOAuthErrorText(error: DriveOAuthErrorCode, provider: CloudDriveProvider | null): string {
  const name = provider ? cloudProviderLabel(provider) : 'Google Drive of OneDrive';
  const company = provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : 'Google of Microsoft';
  switch (error) {
    case 'geweigerd':
      return `Je hebt ${company} geen toestemming gegeven, dus ${name} is niet gekoppeld. Wil je het toch? Kies dan opnieuw "Uit ${name}".`;
    case 'beheerder':
      return `Je organisatie laat deze koppeling alleen toe met toestemming van een beheerder. Vraag de beheerder van je ${company}-account om ResoFly toe te staan, en koppel daarna opnieuw.`;
    case 'verlopen':
      return 'Het koppelen duurde te lang. Begin opnieuw; het duurt meestal maar een minuut.';
    case 'ongeldig':
      return 'Deze koppellink klopt niet (meer). Begin opnieuw met koppelen vanuit Inhoud.';
    case 'storing':
      return `${company} had even een storing. Probeer het over een paar minuten opnieuw.`;
    default:
      return `Het koppelen met ${name} lukte niet. Probeer het opnieuw; blijft het misgaan, laat het ons dan weten.`;
  }
}

// ── Terug naar de map waar je begon ─────────────────────────────────────────
//
// Koppelen gaat via Google of Microsoft en komt terug in een vers geladen app.
// Waar je stond (welke map), is dan weg. Dat onthouden we even in de
// sessionStorage, zodat de verkenner na het koppelen weer in die map opent met
// de kiezer erbij. Pas als het afronden gelukt is (markCloudDrivePendingLinked):
// eerder opende het venster met "nog niet gekoppeld", terwijl het afronden nog
// liep. Hooguit een half uur: daarna is het een ander moment.

const PENDING_KEY = 'resofly:cloudDrivePending';
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

export type CloudDrivePending = {
  provider: CloudDriveProvider;
  organizationId: string;
  clientId: string;
  projectId: string | null;
  folderId: string;
  at: number;
  linked?: boolean;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null; } catch { return null; }
}

function readPending(organizationId: string, store: StorageLike | null, now: number): CloudDrivePending | null | 'invalid' {
  let raw: string | null = null;
  try { raw = store?.getItem(PENDING_KEY) ?? null; } catch { return null; }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<CloudDrivePending>;
    if ((p.provider !== 'google' && p.provider !== 'microsoft') || typeof p.organizationId !== 'string') return 'invalid';
    if (typeof p.clientId !== 'string' || typeof p.folderId !== 'string' || typeof p.at !== 'number') return 'invalid';
    if (now - p.at > PENDING_MAX_AGE_MS || p.at > now + 60_000) return 'invalid';
    if (p.organizationId !== organizationId) return null;
    return { provider: p.provider, organizationId, clientId: p.clientId, projectId: typeof p.projectId === 'string' ? p.projectId : null, folderId: p.folderId, at: p.at, linked: p.linked === true };
  } catch {
    return 'invalid';
  }
}

export function rememberCloudDrivePending(pending: Omit<CloudDrivePending, 'at' | 'linked'>, store: StorageLike | null = storage(), now = Date.now()): void {
  try { store?.setItem(PENDING_KEY, JSON.stringify({ ...pending, at: now })); } catch { /* privévenster */ }
}

/** Het afronden is gelukt: nu mag de verkenner terug naar de map. */
export function markCloudDrivePendingLinked(organizationId: string, store: StorageLike | null = storage(), now = Date.now()): void {
  const p = readPending(organizationId, store, now);
  if (!p || p === 'invalid') return;
  try { store?.setItem(PENDING_KEY, JSON.stringify({ ...p, linked: true })); } catch { /* privévenster */ }
}

export function clearCloudDrivePending(store: StorageLike | null = storage()): void {
  try { store?.removeItem(PENDING_KEY); } catch { /* privévenster */ }
}

/**
 * Het doel na een gelukte koppeling, voor deze organisatie, en dan meteen weg.
 * Nog niet afgerond: laten staan. Verlopen of kapot: weggooien.
 */
export function takeLinkedCloudDrivePending(
  organizationId: string,
  accept: (pending: CloudDrivePending) => boolean = () => true,
  store: StorageLike | null = storage(),
  now = Date.now(),
): CloudDrivePending | null {
  const p = readPending(organizationId, store, now);
  if (p === 'invalid') { clearCloudDrivePending(store); return null; }
  // Een verkenner in een ander klantdossier laat hem liggen voor de juiste.
  if (!p || !p.linked || !accept(p)) return null;
  clearCloudDrivePending(store);
  return p;
}

// ── Wat er nog in Drive of OneDrive weg moet ────────────────────────────────

export type CloudDeletion = {
  id: string;
  provider: CloudDriveProvider;
  name: string;
  status: 'pending' | 'failed';
  failure: 'connection' | 'permission' | 'other' | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  mine: boolean;
};

/** Eén zin voor een regel in "Nog niet uit Drive of OneDrive". */
export function deletionStatusText(d: Pick<CloudDeletion, 'status' | 'failure' | 'lastError' | 'provider' | 'mine'>): string {
  const label = cloudProviderLabel(d.provider);
  if (d.status === 'pending') return d.lastError ? `Wordt opnieuw geprobeerd. ${d.lastError}` : `Gaat zo naar de prullenbak van ${label}.`;
  if (d.failure === 'connection' && !d.mine) {
    return `De koppeling van een collega met ${label} is verlopen. Zodra die opnieuw koppelt, gaat het bestand alsnog naar de prullenbak.`;
  }
  return d.lastError ?? `Lukte niet in ${label}.`;
}
