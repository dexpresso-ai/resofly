import { supabase } from './supabase';
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
export type GerrieProposal = GerrieInvoiceProposal | GerrieQuoteProposal | GerrieClientProposal | GerrieSendInvoiceProposal | GerrieSendQuoteProposal | GerrieConvertQuoteProposal | GerrieEditInvoiceProposal | GerrieEditQuoteProposal | GerrieEditClientProposal | GerrieSendRemindersProposal | GerrieProjectProposal | GerrieEditProjectProposal | GerrieTaskProposal | GerrieEditTaskProposal | GerrieCalendarEventProposal;

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
    body: JSON.stringify({ organizationId: req.organizationId, conversationId: req.conversationId, message: req.message }),
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
