import { supabase } from './supabase';
import type { ReportDefinition } from './reporting';
import type { UUID } from '../types';

/**
 * Frontend-koppeling met Gerrie (de `gerrie-agent` Edge Function).
 *
 * We gebruiken bewust géén `supabase.functions.invoke`: die buffert de hele
 * respons. Gerrie streamt via Server-Sent Events zodat de chat live kan tonen
 * waar hij mee bezig is ("Klanten zoeken…"). Daarom een directe `fetch` met het
 * sessietoken, en een kleine SSE-parser.
 */

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface GerrieStatus { kind: 'thinking' | 'tool'; label: string }

/** Door Gerrie voorgestelde acties — openen vooringevuld in het bestaande formulier. */
export interface GerrieProposalLine { description: string; quantity: number; unit_price: number; vat: number }
export interface GerrieInvoiceProposal {
  type: 'invoice';
  client_id: UUID;
  client_name: string;
  lines: GerrieProposalLine[];
  notes: string | null;
  due_date: string | null;
  total_eur: number;
}
export interface GerrieQuoteProposal {
  type: 'quote';
  client_id: UUID;
  client_name: string;
  lines: GerrieProposalLine[];
  notes: string | null;
  valid_until: string | null;
  total_eur: number;
}
export interface GerrieClientProposal {
  type: 'client';
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: string;
}
export interface GerrieSendInvoiceProposal {
  type: 'send_invoice';
  id: UUID;
  number: string;
  client_name: string;
  recipient_email: string;
  recipient_name: string | null;
}
export interface GerrieSendQuoteProposal {
  type: 'send_quote';
  id: UUID;
  number: string;
  client_name: string;
  recipient_email: string;
  recipient_name: string | null;
}
export interface GerrieConvertQuoteProposal {
  type: 'convert_quote';
  id: UUID;
  number: string;
  client_name: string;
  total_eur: number;
}
export interface GerrieEditInvoiceProposal {
  type: 'edit_invoice';
  id: UUID;
  number: string;
  client_name: string;
  changes: { lines?: GerrieProposalLine[]; notes?: string | null; due_date?: string | null };
}
export interface GerrieEditQuoteProposal {
  type: 'edit_quote';
  id: UUID;
  number: string;
  client_name: string;
  changes: { lines?: GerrieProposalLine[]; notes?: string | null; valid_until?: string | null };
}
export interface GerrieEditClientProposal {
  type: 'edit_client';
  id: UUID;
  name: string;
  changes: { name?: string; contact_name?: string | null; email?: string | null; phone?: string | null; notes?: string | null; status?: string };
}
export interface GerrieSendRemindersProposal {
  type: 'send_reminders';
  invoices: Array<{ id: UUID; number: string; client_name: string; level: number }>;
  total: number;
}
export interface GerrieProposalSubtask { label: string; done: boolean }
export interface GerrieProjectProposal {
  type: 'project';
  name: string;
  client_id: UUID | null;
  client_name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
}
export interface GerrieEditProjectProposal {
  type: 'edit_project';
  id: UUID;
  name: string;
  changes: { name?: string; client_id?: UUID | null; description?: string | null; start_date?: string | null; end_date?: string | null; archived?: boolean };
}
export interface GerrieTaskProposal {
  type: 'task';
  project_id: UUID;
  project_name: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  planned_date: string | null;
  start_date: string | null;
  end_date: string | null;
  estimated_minutes: number;
  tags: string[];
  subtasks: GerrieProposalSubtask[];
}
export interface GerrieEditTaskProposal {
  type: 'edit_task';
  id: UUID;
  title: string;
  project_id: UUID;
  changes: { title?: string; description?: string | null; status?: string; priority?: string; planned_date?: string | null; start_date?: string | null; end_date?: string | null; estimated_minutes?: number; tags?: string[]; subtasks?: GerrieProposalSubtask[] };
}
export interface GerrieCalendarEventProposal {
  type: 'calendar_event';
  source_id: UUID;
  source_name: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  description: string | null;
  location: string | null;
}
export interface GerrieWeekActionProposal {
  type: 'week_action';
  items: Array<{ title: string; planned_date: string }>;
  total: number;
}
export interface GerrieReportProposal {
  type: 'report';
  name: string;
  /** Pure JSON-rapportdefinitie; opent vooringevuld in de rapportbouwer. */
  definition: ReportDefinition;
}
/** Door Gerrie voorgestelde urenregistratie — bevestigen in de chat voert hem uit. */
export interface GerrieTimeEntryProposal {
  type: 'time_entry';
  project_id: UUID | null;
  project_name: string | null;
  client_id: UUID | null;
  client_name: string | null;
  date: string;
  minutes: number;
  description: string | null;
  billable: boolean;
  hourly_rate_cents: number | null;
}
export type GerrieProposal = GerrieInvoiceProposal | GerrieQuoteProposal | GerrieClientProposal | GerrieSendInvoiceProposal | GerrieSendQuoteProposal | GerrieConvertQuoteProposal | GerrieEditInvoiceProposal | GerrieEditQuoteProposal | GerrieEditClientProposal | GerrieSendRemindersProposal | GerrieProjectProposal | GerrieEditProjectProposal | GerrieTaskProposal | GerrieEditTaskProposal | GerrieCalendarEventProposal | GerrieWeekActionProposal | GerrieTimeEntryProposal | GerrieReportProposal;

/**
 * De uitvoer-handlers voor een door Gerrie voorgestelde actie. Draft-types openen een
 * vooringevuld formulier (void); verstuur-/aanmaak-types voeren de actie uit (Promise).
 * Gedeeld door de chat-dock (GerrieChat) én het Commandocentrum, zodat een goedgekeurd
 * voorstel overal identiek wordt uitgevoerd.
 */
export interface GerrieActionHandlers {
  onCreateInvoiceDraft?: (proposal: GerrieInvoiceProposal) => void;
  onCreateQuoteDraft?: (proposal: GerrieQuoteProposal) => void;
  onCreateClientDraft?: (proposal: GerrieClientProposal) => void;
  onSendInvoice?: (proposal: GerrieSendInvoiceProposal) => Promise<void>;
  onSendQuote?: (proposal: GerrieSendQuoteProposal) => Promise<void>;
  onConvertQuote?: (proposal: GerrieConvertQuoteProposal) => Promise<void>;
  onEditInvoice?: (proposal: GerrieEditInvoiceProposal) => void;
  onEditQuote?: (proposal: GerrieEditQuoteProposal) => void;
  onEditClient?: (proposal: GerrieEditClientProposal) => void;
  onSendReminders?: (proposal: GerrieSendRemindersProposal) => Promise<void>;
  onCreateProject?: (proposal: GerrieProjectProposal) => void;
  onEditProject?: (proposal: GerrieEditProjectProposal) => void;
  onCreateTask?: (proposal: GerrieTaskProposal) => void;
  onEditTask?: (proposal: GerrieEditTaskProposal) => void;
  onCreateCalendarEvent?: (proposal: GerrieCalendarEventProposal) => Promise<void>;
  onCreateWeekAction?: (proposal: GerrieWeekActionProposal) => Promise<void>;
  onLogTimeEntry?: (proposal: GerrieTimeEntryProposal) => Promise<void>;
  onCreateReport?: (proposal: GerrieReportProposal) => void;
}

export interface GerrieResult {
  conversationId: UUID;
  messageId: UUID;
  text: string;
  budget?: { remainingFraction: number };
  proposal?: GerrieProposal;
  /** Audit-id van een voorgestelde actie; gebruik om uitvoering terug te melden. */
  auditId?: string;
}

export interface GerrieRequest {
  organizationId: UUID;
  conversationId: UUID | null;
  message: string;
  /** 'cheap' = zuinig model (Haiku) voor parallelle deel-agents; laat weg voor de gewone chat ('strong'). */
  modelKind?: 'strong' | 'cheap';
  onStatus?: (status: GerrieStatus) => void;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export async function streamGerrieReply(req: GerrieRequest): Promise<GerrieResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in om met Gerrie te praten.');

  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ organizationId: req.organizationId, conversationId: req.conversationId, message: req.message, modelKind: req.modelKind }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    let message = 'Gerrie is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: GerrieResult | null = null;
  let errorMessage: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE-blokken zijn gescheiden door een lege regel.
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event === 'status') req.onStatus?.(parsed.data as GerrieStatus);
      else if (parsed.event === 'delta') req.onDelta?.(String((parsed.data as { text?: string }).text ?? ''));
      else if (parsed.event === 'done') result = parsed.data as GerrieResult;
      else if (parsed.event === 'error') errorMessage = String((parsed.data as { message?: string }).message ?? 'Onbekende fout.');
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!result) throw new Error('Gerrie gaf geen antwoord terug. Probeer het opnieuw.');
  return result;
}

/**
 * Meldt aan de backend dat een voorgestelde actie daadwerkelijk is uitgevoerd of
 * mislukt, zodat de audit (ai_action_audit) de status bijwerkt. Best-effort:
 * fouten worden genegeerd — het mag de UX nooit blokkeren.
 */
export async function confirmGerrieAction(organizationId: UUID, auditId: string, outcome: 'executed' | 'failed', detail?: string): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
      body: JSON.stringify({ action: 'confirm', organizationId, auditId, outcome, detail }),
    });
  } catch { /* best-effort logging */ }
}

/**
 * Haalt het resterende AI-tegoed op (fractie 0..1, of null als er geen limiet is),
 * zodat de tegoed-balk al bij het openen van de chat kan verschijnen. Best-effort.
 */
export async function loadGerrieBudget(organizationId: UUID): Promise<number | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
      body: JSON.stringify({ action: 'budget', organizationId }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    return typeof payload?.remainingFraction === 'number' ? payload.remainingFraction : null;
  } catch {
    return null;
  }
}

// ── Commandocentrum (multi-agent) ────────────────────────────────────────────

/** Eén deeltaak van een missie: draait als aparte (goedkope) deel-agent. */
export interface GerrieMissionSubtask { title: string; role: string; instruction: string; kind: 'read' | 'write' }
export interface GerrieMissionPlan {
  subtasks: GerrieMissionSubtask[];
  summary: string;
  /** Geschatte missiekosten als fractie 0..1 van het maandtegoed (null = geen limiet). */
  estimatePct: number | null;
  budget: { remainingFraction: number | null };
  conversationId: string;
}

async function postGerrie(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'Gerrie is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Laat Gerrie (sterk model) een groot doel opsplitsen in parallelle deeltaken. */
export async function planGerrieMission(organizationId: UUID, goal: string): Promise<GerrieMissionPlan> {
  const payload = await postGerrie({ action: 'plan', organizationId, goal });
  const subtasks = Array.isArray(payload?.subtasks) ? (payload.subtasks as GerrieMissionSubtask[]) : [];
  const budget = payload?.budget as { remainingFraction: number | null } | undefined;
  return {
    subtasks,
    summary: String(payload?.summary ?? ''),
    estimatePct: typeof payload?.estimatePct === 'number' ? payload.estimatePct : null,
    budget: { remainingFraction: budget && typeof budget.remainingFraction === 'number' ? budget.remainingFraction : null },
    conversationId: String(payload?.conversationId ?? ''),
  };
}

/** Kosteninschatting vooraf voor een (losse) missie — fractie van het maandtegoed. */
export async function estimateGerrieMission(organizationId: UUID, subtaskCount: number, withPlanner: boolean): Promise<{ estimatePct: number | null; remainingFraction: number | null }> {
  try {
    const payload = await postGerrie({ action: 'estimate', organizationId, subtaskCount, withPlanner });
    const budget = payload?.budget as { remainingFraction: number | null } | undefined;
    return {
      estimatePct: typeof payload?.estimatePct === 'number' ? payload.estimatePct : null,
      remainingFraction: budget && typeof budget.remainingFraction === 'number' ? budget.remainingFraction : null,
    };
  } catch {
    return { estimatePct: null, remainingFraction: null };
  }
}

export interface GerrieUsageRow { user_id: UUID; messages: number; tokens: number; cost_usd: number }

/**
 * Haalt het AI-gebruik op voor het admin-dashboard: PER GEBRUIKER over alle
 * organisaties (zelfde telling als de kostenlimiet). Loopt via de Edge Function
 * (service-role), zodat het niet door de per-org RLS wordt beperkt.
 */
export async function loadGerrieUsage(organizationId: UUID): Promise<GerrieUsageRow[]> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return [];
  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ action: 'usage', organizationId }),
  });
  if (!res.ok) {
    let message = 'AI-gebruik laden mislukt.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  const payload = await res.json();
  return (payload?.rows ?? []) as GerrieUsageRow[];
}

// ── Gerrie Routines (gebruikers bouwen eigen geplande agents) ─────────────────

export type RoutineScheduleKind = 'daily' | 'weekly' | 'monthly';
export type RoutineMode = 'report' | 'propose';
export type RoutineStatus = 'draft' | 'active' | 'paused' | 'archived';
export type RoutineRunStatus = 'claimed' | 'running' | 'succeeded' | 'failed' | 'partial' | 'skipped_budget' | 'cancelled';

export interface GerrieRoutine {
  id: UUID;
  name: string;
  description: string | null;
  instruction: string;
  model_kind: 'cheap' | 'strong';
  mode: RoutineMode;
  enabled_tools: string[];
  schedule_kind: RoutineScheduleKind;
  hour: number;
  day_of_week: number | null;
  day_of_month: number | null;
  timezone: string;
  status: RoutineStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  max_cost_eur_per_run: number;
  monthly_budget_eur: number | null;
  max_runs_per_day: number;
  consecutive_failures: number;
  delivery: { channels: string[]; recipient_user_ids: string[] };
  created_at: string;
  updated_at: string;
}

export interface GerrieRoutineRun {
  id: UUID;
  agent_id: UUID;
  triggered_by: 'schedule' | 'manual' | 'retry';
  status: RoutineRunStatus;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  cost_usd: number;
  proposals_created: number;
  error: string | null;
  created_at: string;
}

/** Velden die de beheer-Edge-Function (gerrie-agent-runner) accepteert bij create/update. */
export interface GerrieRoutineInput {
  name: string;
  description?: string | null;
  instruction: string;
  model_kind: 'cheap' | 'strong';
  mode: RoutineMode;
  enabled_tools: string[];
  schedule_kind: RoutineScheduleKind;
  hour: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  timezone: string;
  max_cost_eur_per_run?: number;
  monthly_budget_eur?: number | null;
  max_runs_per_day?: number;
  delivery: { channels: string[] };
}

const RUNNER_FN = 'gerrie-agent-runner';

async function postRunner(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  const res = await fetch(`${FUNCTIONS_BASE}/${RUNNER_FN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'De Routines-motor is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Alle Routines van de organisatie (owner/admin, via RLS). */
export async function listRoutines(organizationId: UUID): Promise<GerrieRoutine[]> {
  const { data, error } = await supabase.from('ai_agents')
    .select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as GerrieRoutine[];
}

/** De laatste runs van één Routine (nieuwste eerst). */
export async function listRoutineRuns(organizationId: UUID, agentId: UUID): Promise<GerrieRoutineRun[]> {
  const { data, error } = await supabase.from('ai_agent_runs')
    .select('*').eq('organization_id', organizationId).eq('agent_id', agentId)
    .order('created_at', { ascending: false }).limit(25);
  if (error) throw new Error(error.message);
  return (data ?? []) as GerrieRoutineRun[];
}

/** Maakt een nieuwe Routine aan (concept) of werkt een bestaande bij. */
export async function saveRoutine(organizationId: UUID, input: GerrieRoutineInput, id?: UUID): Promise<{ id?: string }> {
  const payload = await postRunner({ action: id ? 'update' : 'create', organizationId, id, ...input });
  return { id: typeof payload?.id === 'string' ? payload.id : id };
}

/** Activeer/pauzeer/archiveer een Routine. */
export async function setRoutineStatus(organizationId: UUID, id: UUID, status: RoutineStatus): Promise<{ next_run_at: string | null }> {
  const payload = await postRunner({ action: 'set_status', organizationId, id, status });
  return { next_run_at: typeof payload?.next_run_at === 'string' ? payload.next_run_at : null };
}

export async function deleteRoutine(organizationId: UUID, id: UUID): Promise<void> {
  await postRunner({ action: 'delete', organizationId, id });
}

/** Draait een Routine direct (handmatig; verandert het schema niet). Wacht op het resultaat. */
export async function runRoutineNow(organizationId: UUID, id: UUID): Promise<{ status: string; proposalsCreated?: number }> {
  const payload = await postRunner({ action: 'run_now', organizationId, id });
  return { status: String(payload?.status ?? 'onbekend'), proposalsCreated: Number(payload?.proposalsCreated ?? 0) };
}

/** Openstaande voorstellen van één run (uit de goedkeurwachtrij ai_action_audit). */
export async function listRunProposals(organizationId: UUID, runId: UUID): Promise<Array<{ auditId: string; proposal: GerrieProposal }>> {
  const { data, error } = await supabase.from('ai_action_audit')
    .select('id, params, status').eq('organization_id', organizationId).eq('agent_run_id', runId).eq('status', 'proposed');
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((r: { id: string; params: unknown }) => ({ auditId: String(r.id), proposal: r.params as GerrieProposal }))
    .filter((r) => r.proposal && typeof r.proposal.type === 'string');
}

/** De echte, org-scoped tool-namen die een Routine mag gebruiken (voor de UI-selectie). */
export const ROUTINE_READ_TOOLS: Array<{ name: string; label: string }> = [
  { name: 'list_invoices', label: 'Facturen bekijken' },
  { name: 'list_due_reminders', label: 'Openstaande herinneringen' },
  { name: 'get_financial_summary', label: 'Financieel overzicht' },
  { name: 'list_quotes', label: 'Offertes bekijken' },
  { name: 'search_clients', label: 'Klanten opzoeken' },
  { name: 'list_projects', label: 'Projecten bekijken' },
  { name: 'list_tasks', label: 'Taken bekijken' },
  { name: 'list_tickets', label: 'Tickets bekijken' },
];
export const ROUTINE_PROPOSE_TOOLS: Array<{ name: string; label: string }> = [
  { name: 'propose_send_reminders', label: 'Betalingsherinneringen voorstellen' },
];

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message';
  let dataStr = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  try { return { event, data: JSON.parse(dataStr) }; } catch { return null; }
}
