import { supabase } from './supabase';
import type { UUID } from '../types';
import type { GerrieProposal } from './gerrie-api';

/**
 * De beslislijst ("Gerrie signaleert") vanuit de browser.
 *
 * Lezen gaat via RLS (kaarten zichtbaar bij leesrecht op module + Gerrie);
 * afhandelen via twee RPC's die de rechten server-side toetsen. Er is bewust
 * geen tweede uitvoerpad: Akkoord loopt via `executeProposal` (dezelfde weg als
 * de chat en de goedkeurwachtrij), en pas daarna wordt de kaart dichtgezet.
 */

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const SIGNALS_FN = 'gerrie-signals';

export type DecisionKind =
  | 'quote_opened_unanswered'
  | 'quote_expiring'
  | 'contract_unsigned'
  | 'inbound_mail'
  | 'mail_unmatched'
  | 'meeting_notes_ready'
  | 'meeting_notes_unsent'
  | 'gallery_favorites_chosen';

/**
 * Spiegel van SIGNAL_KINDS in supabase/functions/_shared/signalRules.ts —
 * signalKinds.test.ts bewaakt dat beide lijsten gelijk lopen.
 */
export const DECISION_KIND_INFO: Record<DecisionKind, { label: string; hint: string; origin: 'rule' | 'gerrie' }> = {
  quote_opened_unanswered: { label: 'Offerte geopend, niet beantwoord', hint: 'Na de wachttijd zet Gerrie een opvolgmail klaar.', origin: 'gerrie' },
  quote_expiring: { label: 'Offerte verloopt binnenkort', hint: 'Drie dagen vóór de vervaldatum een actiepunt om te bellen of te verlengen.', origin: 'rule' },
  contract_unsigned: { label: 'Contract nog niet getekend', hint: 'Na de wachttijd zet Gerrie een vriendelijke herinnering klaar.', origin: 'gerrie' },
  inbound_mail: { label: 'Klantmail die niemand oppakte', hint: 'Na vier uur ongelezen beoordeelt Gerrie de mail en zet een antwoord, ticket of taak klaar.', origin: 'gerrie' },
  mail_unmatched: { label: 'Mail in de opvangbak met een voorgestelde klant', hint: 'Koppel het bericht met één klik aan de klant die erbij lijkt te horen.', origin: 'rule' },
  meeting_notes_ready: { label: 'Actiepunten uit notulen', hint: 'Zodra de notulen klaar zijn: de actiepunten als afvinklijst van taken.', origin: 'rule' },
  meeting_notes_unsent: { label: 'Notulen nog niet gemaild', hint: 'Notulen die na een etmaal nog niet naar de genodigden zijn gestuurd.', origin: 'rule' },
  gallery_favorites_chosen: { label: 'Favorieten gekozen in een galerij', hint: 'Een taak om de selectie na te bewerken, zes uur na de eerste favoriet.', origin: 'rule' },
};

export type DecisionStatus = 'open' | 'snoozed' | 'done' | 'dismissed' | 'expired';
export type DecisionSeverity = 'info' | 'normal' | 'high';
export interface DecisionTarget { kind: 'client' | 'project' | 'quote' | 'contract' | 'calendar' | 'inbox' | 'gallery'; id: string | null }

export interface AiDecision {
  id: UUID;
  organization_id: UUID;
  signal_id: UUID | null;
  signal_key: string;
  kind: DecisionKind;
  module: string;
  origin: 'rule' | 'gerrie';
  severity: DecisionSeverity;
  entity_type: string;
  entity_id: UUID | null;
  client_id: UUID | null;
  assignee_user_id: UUID | null;
  title: string;
  summary: string;
  evidence: string[];
  proposal: GerrieProposal | null;
  audit_id: UUID | null;
  target: DecisionTarget | null;
  status: DecisionStatus;
  snoozed_until: string | null;
  expires_at: string | null;
  resolved_by: UUID | null;
  resolved_at: string | null;
  resolution: string | null;
  model_kind: 'cheap' | 'strong' | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface AiSignalSettings {
  organization_id: UUID;
  enabled: boolean;
  actor_user_id: UUID | null;
  kinds: Partial<Record<DecisionKind, boolean>>;
  digest_hour: number;
  timezone: string;
  quote_follow_up_days: number;
  contract_follow_up_days: number;
  max_gerrie_cards_per_day: number;
  next_sweep_at: string | null;
  sweep_lease_until: string | null;
  last_sweep_at: string | null;
  budget_blocked_at: string | null;
}

export const DEFAULT_SIGNAL_SETTINGS: Omit<AiSignalSettings, 'organization_id'> = {
  enabled: false, actor_user_id: null, kinds: {}, digest_hour: 7, timezone: 'Europe/Amsterdam',
  quote_follow_up_days: 3, contract_follow_up_days: 7, max_gerrie_cards_per_day: 10,
  next_sweep_at: null, sweep_lease_until: null, last_sweep_at: null, budget_blocked_at: null,
};

export interface AiDecisionMute {
  id: UUID;
  scope: 'kind' | 'entity' | 'client';
  kind: DecisionKind | null;
  entity_type: string | null;
  entity_id: UUID | null;
  client_id: UUID | null;
  until: string | null;
  created_at: string;
}

export interface AiSignal {
  id: UUID;
  kind: DecisionKind;
  signal_key: string;
  status: 'queued' | 'claimed' | 'decided' | 'skipped' | 'failed';
  due_at: string;
  occurred_at: string;
  reason: string | null;
  attempts: number;
  client_id: UUID | null;
  created_at: string;
}

export interface SignalStatus {
  enabled: boolean;
  queued: number;
  open: number;
  gerrie_today: number;
  last_sweep_at: string | null;
  next_sweep_at: string | null;
  budget_blocked_at: string | null;
}

// ── Lezen ────────────────────────────────────────────────────────────────────

/** Alle kaarten die nog een beslissing vragen (open, of "Later" — die filtert het scherm zelf). */
export async function listDecisions(organizationId: UUID): Promise<AiDecision[]> {
  const { data, error } = await supabase.from('ai_decisions').select('*')
    .eq('organization_id', organizationId).in('status', ['open', 'snoozed'])
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AiDecision[]).map((d) => ({ ...d, evidence: Array.isArray(d.evidence) ? d.evidence : [] }));
}

/** Kaarten die nú op je wachten: open, of teruggekomen uit "Later". */
export function isDue(d: AiDecision, now = Date.now()): boolean {
  if (d.status === 'open') return true;
  if (d.status === 'snoozed') return !d.snoozed_until || Date.parse(d.snoozed_until) <= now;
  return false;
}

export async function countDueDecisions(organizationId: UUID): Promise<number> {
  const rows = await listDecisions(organizationId);
  return rows.filter((d) => isDue(d)).length;
}

// ── Afhandelen (de enige schrijfweg) ──────────────────────────────────────────

export async function resolveDecision(id: UUID, status: 'open' | 'snoozed' | 'done' | 'dismissed', snoozedUntil: string | null = null, resolution: string | null = null): Promise<AiDecision> {
  const { data, error } = await supabase.rpc('ai_decision_resolve', { p_id: id, p_status: status, p_snoozed_until: snoozedUntil, p_resolution: resolution });
  if (error) throw new Error(friendly(error.message));
  return data as AiDecision;
}

export async function muteDecision(id: UUID, scope: 'kind' | 'entity' | 'client', until: string | null = null): Promise<void> {
  const { error } = await supabase.rpc('ai_decision_mute', { p_decision_id: id, p_scope: scope, p_until: until });
  if (error) throw new Error(friendly(error.message));
}

// ── Instellingen (RLS: lezen = lid, schrijven = owner/admin) ──────────────────

export async function loadSignalSettings(organizationId: UUID): Promise<AiSignalSettings | null> {
  const { data, error } = await supabase.from('ai_signal_settings').select('*').eq('organization_id', organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AiSignalSettings | null) ?? null;
}

export async function saveSignalSettings(organizationId: UUID, patch: Partial<Omit<AiSignalSettings, 'organization_id'>>): Promise<AiSignalSettings> {
  const { data, error } = await supabase.from('ai_signal_settings')
    .upsert({ organization_id: organizationId, ...patch }, { onConflict: 'organization_id' })
    .select('*').single();
  if (error) throw new Error(friendly(error.message));
  return data as AiSignalSettings;
}

export async function listDecisionMutes(organizationId: UUID): Promise<AiDecisionMute[]> {
  const { data, error } = await supabase.from('ai_decision_mutes').select('id, scope, kind, entity_type, entity_id, client_id, until, created_at')
    .eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as AiDecisionMute[];
}

export async function deleteDecisionMute(id: UUID): Promise<void> {
  const { error } = await supabase.from('ai_decision_mutes').delete().eq('id', id);
  if (error) throw new Error(friendly(error.message));
}

/** Wat er wacht op rijping (alleen owner/admin zien deze rijen). */
export async function listQueuedSignals(organizationId: UUID): Promise<AiSignal[]> {
  const { data, error } = await supabase.from('ai_signals').select('id, kind, signal_key, status, due_at, occurred_at, reason, attempts, client_id, created_at')
    .eq('organization_id', organizationId).in('status', ['queued', 'claimed']).order('due_at', { ascending: true }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as AiSignal[];
}

// ── De motor (edge function; owner/admin) ─────────────────────────────────────

async function postSignals(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  const res = await fetch(`${FUNCTIONS_BASE}/${SIGNALS_FN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'De beslislijst is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function runSweepNow(organizationId: UUID): Promise<{ signals: number; expired: number; open: number }> {
  const r = await postSignals({ action: 'sweep_now', organizationId });
  return { signals: Number(r.signals ?? 0), expired: Number(r.expired ?? 0), open: Number(r.open ?? 0) };
}

export async function evaluateSignalNow(organizationId: UUID, signalId: UUID): Promise<{ outcome: string; reason?: string }> {
  const r = await postSignals({ action: 'evaluate_now', organizationId, signalId });
  const result = (r.result ?? {}) as { outcome?: string; reason?: string };
  return { outcome: String(result.outcome ?? 'onbekend'), reason: result.reason };
}

export async function loadSignalStatus(organizationId: UUID): Promise<SignalStatus> {
  const r = await postSignals({ action: 'status', organizationId });
  return {
    enabled: Boolean(r.enabled), queued: Number(r.queued ?? 0), open: Number(r.open ?? 0), gerrie_today: Number(r.gerrie_today ?? 0),
    last_sweep_at: (r.last_sweep_at as string | null) ?? null, next_sweep_at: (r.next_sweep_at as string | null) ?? null,
    budget_blocked_at: (r.budget_blocked_at as string | null) ?? null,
  };
}

/** Postgres-fouten uit de RPC's in gewone taal; de rest gaat ongewijzigd door. */
function friendly(message: string): string {
  if (/geen schrijfrechten/i.test(message)) return 'Je hebt geen schrijfrechten voor deze kaart — vraag een owner of admin.';
  if (/niet gevonden/i.test(message)) return 'Deze kaart bestaat niet meer.';
  if (/owner of admin/i.test(message)) return 'Alleen een owner of admin kan de beslislijst instellen.';
  return message;
}
