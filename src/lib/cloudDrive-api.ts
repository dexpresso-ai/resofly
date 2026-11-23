import { supabase } from './supabase';
import { throwFunctionError } from './functionErrors';
import { parseDriveOAuthReturn, type CloudDeletion, type DriveOAuthReturn } from './cloudDrive';
import type { Attachment, CloudDriveProvider, UUID } from '../types';

/**
 * De aanroepen naar de edge function cloud-files (Google Drive en OneDrive).
 * De tokens blijven op de server; alleen het korte token voor de kiezer van
 * Google komt hier langs, en dat kan niets buiten de bestanden die je kiest.
 */

export type CloudDriveConnection = {
  id: UUID;
  provider: CloudDriveProvider;
  account: string | null;
  name: string | null;
  status: 'active' | 'expired' | 'revoked' | 'error';
  lastError: string | null;
  createdAt: string;
  linkedFiles: number;
};

export type CloudDriveStatus = {
  providers: Record<CloudDriveProvider, { configured: boolean }>;
  connections: CloudDriveConnection[];
  deletions: CloudDeletion[];
};

export type OneDriveItem = {
  id: string;
  driveId: string | null;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string;
  modified: string | null;
  webUrl: string | null;
};

export type LinkResult = {
  added: Attachment[];
  skipped: Array<{ name: string; reason: string }>;
  notDeletable: string[];
};

async function invoke<T>(organizationId: UUID | null, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('cloud-files', { body: organizationId ? { ...body, organizationId } : body });
  // De uitleg van de server staat in de body; error.message is bij elke fout
  // "Edge Function returned a non-2xx status code".
  if (error) await throwFunctionError(error, 'Google Drive of OneDrive gaf geen antwoord.');
  if (!data || data.ok !== true) throw new Error(data?.error ?? 'Google Drive of OneDrive gaf geen geldig antwoord terug.');
  return data as T;
}

export function loadCloudDriveStatus(organizationId: UUID): Promise<CloudDriveStatus> {
  return invoke<CloudDriveStatus>(organizationId, { action: 'status' });
}

/** De toestemmingslink; de browser gaat daarna naar Google of Microsoft en komt hier terug. */
export async function getCloudDriveAuthUrl(organizationId: UUID, provider: CloudDriveProvider, returnTo: string, loginHint?: string | null): Promise<string> {
  const data = await invoke<{ authUrl: string }>(organizationId, { action: 'oauthStart', provider, returnTo, ...(loginHint ? { loginHint } : {}) });
  return data.authUrl;
}

export type CloudDriveOAuthCompletion = { provider: CloudDriveProvider; organizationId: UUID; account: string | null; retried: number };

/** Rondt de koppeling af; de server doet het alleen voor wie hem startte. */
export function completeCloudDriveOAuth(code: string, state: string): Promise<CloudDriveOAuthCompletion> {
  return invoke<CloudDriveOAuthCompletion>(null, { action: 'oauthComplete', code, state });
}

export async function disconnectCloudDrive(organizationId: UUID, connectionId: UUID): Promise<{ linkedFiles: number }> {
  return invoke<{ linkedFiles: number }>(organizationId, { action: 'disconnect', connectionId });
}

export type GooglePickerToken = { accessToken: string; apiKey: string; appId: string; account: string | null };

export function getGooglePickerToken(organizationId: UUID): Promise<GooglePickerToken> {
  return invoke<GooglePickerToken>(organizationId, { action: 'pickerToken' });
}

export function browseOneDrive(organizationId: UUID, options: { folderId?: string | null; query?: string; next?: string | null }): Promise<{ items: OneDriveItem[]; next: string | null; account: string | null }> {
  return invoke(organizationId, {
    action: 'browse',
    ...(options.folderId ? { folderId: options.folderId } : {}),
    ...(options.query ? { query: options.query } : {}),
    ...(options.next ? { next: options.next } : {}),
  });
}

export function linkCloudFiles(organizationId: UUID, provider: CloudDriveProvider, folderId: UUID, files: Array<{ id: string; driveId?: string | null }>): Promise<LinkResult> {
  return invoke<LinkResult>(organizationId, { action: 'link', provider, folderId, files });
}

export function processCloudDeletions(organizationId: UUID): Promise<{ done: number; failed: number; pending: number; deletions: CloudDeletion[] }> {
  return invoke(organizationId, { action: 'processDeletions' });
}

export function retryCloudDeletion(organizationId: UUID, deletionId: string): Promise<{ outcome: 'done' | 'failed' | 'pending'; deletions: CloudDeletion[] }> {
  return invoke(organizationId, { action: 'retryDeletion', deletionId });
}

export function dismissCloudDeletion(organizationId: UUID, deletionId: string): Promise<{ deletions: CloudDeletion[] }> {
  return invoke(organizationId, { action: 'dismissDeletion', deletionId });
}

/**
 * Na het verwijderen van een gekoppeld bestand: zet het nu in de prullenbak
 * van Drive of OneDrive, in plaats van te wachten op de geplande taak. Wat
 * niet lukt, blijft in de wachtrij staan; het venster bij "Uit Google Drive" of
 * "Uit OneDrive" laat het zien. Eén aanroep per keer: wie tien bestanden
 * weggooit, start er geen tien.
 */
type ProcessResult = Awaited<ReturnType<typeof processCloudDeletions>>;
let pendingRun: Promise<ProcessResult | null> | null = null;
let runAgain = false;
export function kickCloudDeletions(organizationId: UUID): Promise<ProcessResult | null> {
  // Loopt er al een ronde, dan komt er daarna nog één: wie een selectie
  // verwijdert, haalt de rijen één voor één weg, en de laatste mag niet op de
  // geplande taak (een kwartier) hoeven wachten.
  if (pendingRun) { runAgain = true; return pendingRun; }
  const run = async (): Promise<ProcessResult | null> => {
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    let result: ProcessResult | null = null;
    do {
      runAgain = false;
      result = await processCloudDeletions(organizationId).catch(() => null);
    } while (runAgain);
    return result;
  };
  pendingRun = run().finally(() => { pendingRun = null; });
  return pendingRun;
}

/** Leest de terugkeer van Google of Microsoft één keer uit de URL en haalt hem eruit. */
export function takeDriveOAuthReturn(): DriveOAuthReturn | null {
  if (typeof window === 'undefined') return null;
  try {
    const { result, cleaned } = parseDriveOAuthReturn(window.location.href);
    if (cleaned !== null) window.history.replaceState(window.history.state, '', cleaned);
    return result;
  } catch {
    return null;
  }
}
