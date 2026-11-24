// Een bestand uit R2 naar een uploadsessie van OneDrive (route
// /internal/onedrive/push). Hier de regels; de route zelf staat in index.ts.
//
// Waarom zo: de edge function onedrive-sync vraagt bij Microsoft een
// uploadadres aan. Dat adres geldt kort en draagt de toegang zelf; de worker
// heeft dus geen sleutel van Microsoft nodig en stuurt het bestand rechtstreeks
// uit R2, zonder dat het door de edge function gaat. Wie het adres levert, is
// alleen de edge function (gedeeld geheim). Toch toetst de worker het adres:
// anders kon wie het geheim had, elk bestand naar elke host laten sturen.
//
// Plan: docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md.

/**
 * Stukken van 10 MiB. Microsoft wil stukken die een veelvoud zijn van
 * 320 KiB (behalve het laatste), en hooguit 60 MiB.
 */
export const ONEDRIVE_CHUNK_BYTES = 32 * 320 * 1024;

/** De grens per bestand. Een bestand in Inhoud is hooguit 25 MB; een document uit de editor kan groeien. */
export const ONEDRIVE_PUSH_MAX_BYTES = 250 * 1024 * 1024;

/** Uit welke mappen van R2 een kopie naar OneDrive mag. Nooit financiële bewijsstukken, de galerij of zendingen. */
export const ONEDRIVE_PUSH_SEGMENTS: ReadonlySet<string> = new Set(['folder', 'document', 'client', 'project', 'task', 'subtask', 'ticket', 'note']);

/**
 * Een uploadadres van OneDrive. Zakelijk: {tenant}-my.sharepoint.com. Privé:
 * api.onedrive.com of *.up.1drv.com (de voorbeelden in de documentatie van
 * Microsoft Graph). Alleen https, zonder gebruikersnaam in het adres.
 */
export function isMicrosoftUploadUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return host.endsWith('.sharepoint.com')
    || host === 'api.onedrive.com'
    || host.endsWith('.onedrive.com')
    || host.endsWith('.1drv.com');
}

/** De stukken van een bestand: [begin, eind] (eind inbegrepen), zoals Content-Range ze noemt. */
export function uploadChunks(total: number, chunkBytes = ONEDRIVE_CHUNK_BYTES): Array<{ start: number; end: number }> {
  if (!Number.isFinite(total) || total <= 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < total; start += chunkBytes) {
    out.push({ start, end: Math.min(total, start + chunkBytes) - 1 });
  }
  return out;
}

/** Wat de edge function van het antwoord van OneDrive nodig heeft; de rest laten we weg. */
export function pickDriveItem(payload: unknown): { id: string; name: string; eTag: string | null; cTag: string | null; webUrl: string | null; parentId: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return null;
  const parent = (p.parentReference && typeof p.parentReference === 'object' ? p.parentReference : {}) as Record<string, unknown>;
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : '',
    eTag: typeof p.eTag === 'string' ? p.eTag : null,
    cTag: typeof p.cTag === 'string' ? p.cTag : null,
    webUrl: typeof p.webUrl === 'string' ? p.webUrl : null,
    parentId: typeof parent.id === 'string' ? parent.id : null,
  };
}
