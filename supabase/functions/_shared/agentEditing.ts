import { SCHEDULE_KINDS } from './agentSchedule.ts';

/**
 * Een agent aanpassen via de chat (2026-11-11).
 *
 * Bij een nieuwe agent begint de bouwer leeg. Bij aanpassen krijgt hij de huidige
 * instellingen mee, zodat hij een complete nieuwe versie kan opleveren in plaats
 * van een agent die alleen de laatste wens kent. Voorheen kon aanpassen alleen in
 * het formulier: wie "maak hem maandelijks" wilde zeggen, moest weten welk veld
 * dat was.
 *
 * Wat de app meestuurt is invoer van de gebruiker: hier gaat alleen door wat de
 * bouwer nodig heeft, met een lengtegrens, en de rest (eigenaar, status, logboek)
 * blijft buiten het gesprek.
 */
export function agentForEditing(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined);
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, max) : undefined);
  const out: Record<string, unknown> = {
    name: text(r.name, 120),
    instruction: text(r.instruction, 4000),
    mode: r.mode === 'propose' ? 'propose' : r.mode === 'report' ? 'report' : undefined,
    enabled_tools: list(r.enabled_tools, 60),
    schedule_kind: typeof r.schedule_kind === 'string' && (SCHEDULE_KINDS as readonly string[]).includes(r.schedule_kind) ? r.schedule_kind : undefined,
    hour: int(r.hour), minute: int(r.minute), end_hour: int(r.end_hour),
    day_of_week: int(r.day_of_week), day_of_month: int(r.day_of_month),
    trigger_events: list(r.trigger_events, 12), max_event_runs_per_day: int(r.max_event_runs_per_day),
    max_proposals_per_run: int(r.max_proposals_per_run),
    email_mode: r.email_mode === 'template' ? 'template' : r.email_mode === 'compose' ? 'compose' : undefined,
    email_subject: text(r.email_subject, 200), email_body: text(r.email_body, 4000), max_emails_per_run: int(r.max_emails_per_run),
    icon: text(r.icon, 40),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out.name || out.instruction ? out : null;
}
