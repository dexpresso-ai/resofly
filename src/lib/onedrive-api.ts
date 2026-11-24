import { supabase } from './supabase';
import { throwFunctionError } from './functionErrors';
import { isMissingRelation } from './postgrestErrors';
import { parseOneDriveOAuthReturn, type OneDriveOAuthReturn, type OneDriveStatus } from './onedrive';
import type { UUID } from '../types';

/**
 * De aanroepen naar de edge function onedrive-sync (de kopie van Inhoud in
 * OneDrive). De tokens van Microsoft blijven op de server.
 */

async function invoke<T>(organizationId: UUID | null, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('onedrive-sync', { body: organizationId ? { ...body, organizationId } : body });
  // De uitleg van de server staat in de body; error.message is bij elke fout
  // "Edge Function returned a non-2xx status code".
  if (error) await throwFunctionError(error, 'OneDrive gaf geen antwoord.');
  if (!data || data.ok !== true) throw new Error(data?.error ?? 'OneDrive gaf geen geldig antwoord terug.');
  return data as T;
}

export const loadOneDriveStatus = (organizationId: UUID) => invoke<OneDriveStatus>(organizationId, { action: 'status' });
export const enableOneDrive = (organizationId: UUID) => invoke<OneDriveStatus>(organizationId, { action: 'enable' });
export const disableOneDrive = (organizationId: UUID) => invoke<OneDriveStatus>(organizationId, { action: 'disable' });
export const disconnectOneDrive = (organizationId: UUID) => invoke<OneDriveStatus>(organizationId, { action: 'disconnect' });
export const resyncOneDrive = (organizationId: UUID) => invoke<OneDriveStatus & { queued: number }>(organizationId, { action: 'resyncAll' });
export const retryOneDrive = (organizationId: UUID) => invoke<OneDriveStatus>(organizationId, { action: 'retryFailed' });
export const processOneDrive = (organizationId: UUID) => invoke<{ done: number; retry: number; failed: number; paused: number; pending: number }>(organizationId, { action: 'process' });

/** De toestemmingslink; de browser gaat daarna naar Microsoft en komt hier terug. */
export async function getOneDriveAuthUrl(organizationId: UUID, returnTo: string): Promise<string> {
  return (await invoke<{ authUrl: string }>(organizationId, { action: 'oauthStart', returnTo })).authUrl;
}

/** Rondt de koppeling af; de server doet het alleen voor wie hem startte, en alleen voor een eigenaar. */
export function completeOneDriveOAuth(code: string, state: string): Promise<{ organizationId: UUID; account: string | null; enabled: boolean }> {
  return invoke(null, { action: 'oauthComplete', code, state });
}

/** Leest de terugkeer van Microsoft één keer uit de URL en haalt hem eruit. */
export function takeOneDriveOAuthReturn(): OneDriveOAuthReturn | null {
  if (typeof window === 'undefined') return null;
  try {
    const { result, cleaned } = parseOneDriveOAuthReturn(window.location.href);
    if (cleaned !== null) window.history.replaceState(window.history.state, '', cleaned);
    return result;
  } catch {
    return null;
  }
}

export type OneDriveMirrorSummary = { enabled: boolean; rootWebUrl: string | null };

/**
 * Staat er een kopie in OneDrive? Voor de verkenner (een icoon, en de zin bij
 * verwijderen). Een gewone leesvraag: de stand is te lezen voor wie Inhoud mag
 * lezen. Null als de migratie er nog niet is, of als er niets is gekoppeld.
 */
export async function loadOneDriveMirror(organizationId: UUID): Promise<OneDriveMirrorSummary | null> {
  const { data, error } = await supabase.from('onedrive_mirrors').select('enabled, root_web_url').eq('organization_id', organizationId).maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    return null;
  }
  if (!data) return null;
  const row = data as { enabled: boolean; root_web_url: string | null };
  return { enabled: row.enabled === true, rootWebUrl: safeOneDriveUrl(row.root_web_url) };
}

/** Een link naar OneDrive in de app: alleen https bij Microsoft. */
export function safeOneDriveUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'onedrive.live.com' || host === '1drv.ms' || host.endsWith('.sharepoint.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Na een wijziging in Inhoud: de wachtrij nu afwerken, in plaats van te
 * wachten op de geplande taak (elke twee minuten). Kort uitgesteld en
 * samengevoegd: wie tien bestanden uploadt, start één ronde, en loopt er al
 * een, dan komt er daarna nog één.
 */
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;
export function kickOneDriveSync(organizationId: UUID): void {
  if (running) { again = true; return; }
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    running = true;
    try {
      do {
        again = false;
        await processOneDrive(organizationId).catch(() => undefined);
      } while (again);
    } finally {
      running = false;
    }
  }, 1500);
}
