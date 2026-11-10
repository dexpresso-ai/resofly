/**
 * Waar Gerrie is terwijl hij een rapportage bouwt: vier stappen, afgeleid uit de
 * statusmeldingen van gerrie-agent (supabase/functions/_shared/gerrieReports.ts).
 *
 * Los van aiReports.ts, zodat de test dit zonder Supabase kan laden.
 */

export const BUILD_STEPS = ['Vraag lezen', 'Gegevens ophalen', 'Pagina bouwen', 'Controleren'] as const;
export type BuildPhase = 0 | 1 | 2 | 3;

const STEP_PHASE: Record<string, BuildPhase> = { lezen: 0, gegevens: 1, bouwen: 2, controleren: 3 };

/**
 * De volgende stap bij een statusmelding. De backend stuurt sinds 2026-11-10
 * een vaste `step` mee; zonder die (een oudere edge function) lezen we het
 * label. Een melding zonder stap ("Gerrie werkt verder…") laat de stap staan:
 * anders sprong de balk na elke opgehaalde dataset terug naar het begin.
 * Een afgekeurde pagina gaat wél terug (controleren → gegevens of bouwen),
 * want dat is wat Gerrie dan echt doet.
 */
export function nextBuildPhase(prev: BuildPhase, status: { step?: unknown; label?: unknown }): BuildPhase {
  if (typeof status.step === 'string' && status.step in STEP_PHASE) return STEP_PHASE[status.step];
  const label = typeof status.label === 'string' ? status.label.toLowerCase() : '';
  if (!label) return prev;
  if (label.includes('controleren')) return 3;
  if (label.includes('opbouwen')) return 2;
  if (label.includes('denkt na') || label.includes('werkt verder') || label.includes('rondt af')) return prev;
  return 1;
}

/** 0:07, 1:42, 12:05 — hoe lang Gerrie al bezig is. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Een geruststelling als het lang duurt. Een uitgebreide pagina schrijven kost
 * Gerrie soms een paar minuten; zonder uitleg dacht men dat hij vastzat.
 */
export function buildPatienceNote(ms: number): string | null {
  if (ms >= 150_000) return 'Dit is een flinke rapportage. Gerrie is nog bezig; je hoeft niets te doen.';
  if (ms >= 60_000) return 'Een uitgebreide rapportage kost soms een paar minuten.';
  return null;
}
