import type { AppData, UUID } from '../../types';

/**
 * De UITVOERDERS van de handelingenregistry.
 *
 * De server (supabase/functions/_shared/actions/) bepaalt WAT er kan en zet een
 * voorstel klaar met een leesbare titel en een `payload`. Zodra de gebruiker akkoord
 * geeft, komt dat voorstel hier terecht: één functie per handeling-id die de bestaande
 * repository-functie aanroept — precies dezelfde weg als de knop in het scherm.
 *
 * Dat is bewust. Zou een handeling zijn eigen insert schrijven, dan mist hij de
 * normalisatie, de triggers en de foutafhandeling die het scherm wél heeft, en merk
 * je dat pas aan een scheve rij. Dus: de uitvoerder is een doorgeefluik, geen kopie.
 *
 * Wat een uitvoerder teruggeeft, leest de gebruiker als bevestiging. Schrijf hem in
 * de voltooide tijd en noem het ding bij naam: "Adres van Jansen BV bijgewerkt".
 */
export interface ActionRunCtx {
  organizationId: UUID;
  /** De werkruimte zoals hij nu geladen is; voor namen en afgeleide waarden. */
  data: AppData;
}

export type ActionExecutor = (payload: Record<string, unknown>, ctx: ActionRunCtx) => Promise<string>;

// ── Uitpakhulpjes ───────────────────────────────────────────────────────────
// De payload komt als JSON van de server. Die kant heeft hem al gevalideerd; hier
// gaat het er alleen om dat we niet stilletjes `undefined` doorgeven.

export function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error(`Deze actie mist "${key}".`);
  return value;
}

export function optText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value ? value : null;
}

export function flag(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

export function patchOf(payload: Record<string, unknown>, key = 'patch'): Record<string, unknown> {
  const value = payload[key];
  if (!value || typeof value !== 'object') throw new Error(`Deze actie mist "${key}".`);
  return value as Record<string, unknown>;
}

export function list(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Deze actie mist "${key}".`);
  return value.map(String);
}
