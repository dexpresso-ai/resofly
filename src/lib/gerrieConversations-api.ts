import { supabase } from './supabase';
import { proposalLabel } from './gerrie-proposals';
import type { GerrieProposal } from './gerrie-api';
import type { UUID } from '../types';
import {
  buildThread, ilikePattern, mergeSearchHits, normalizeQuery, snippetAround, MIN_QUERY,
  type AuditRow, type ConversationMessage, type ConversationSummary, type MessageRow,
} from './gerrieConversations';

/**
 * Gerrie → Gesprekken: lezen uit de database.
 *
 * Alleen lezen, en alleen je eigen chats. De RLS dwingt dat al af
 * (20261112120000_gerrie_gesprekken): een chat is leesbaar voor wie hem voerde,
 * en de module Gerrie moet open staan. Elke query filtert toch zelf op
 * organisatie, op jou en op de soort 'chat'. Zonder dat stonden verslagen van
 * agent-runs en proefruns tussen je gesprekken, en zag een beheerder in de
 * lijst ook die van de agents van collega's.
 *
 * Verwijderen loopt niet hier maar via de edge function (deleteGerrieConversation
 * in gerrie-api.ts): de app schrijft niet in de ai_*-tabellen.
 */

const PAGE_SIZE = 40;
const CONVERSATION_COLUMNS = 'id, title, created_at, updated_at';

interface ConversationRow { id: string; title: string | null; created_at: string; updated_at: string }

function toSummary(row: ConversationRow, snippet: string | null = null): ConversationSummary {
  return { id: row.id, title: row.title ?? '', createdAt: row.created_at, updatedAt: row.updated_at, snippet };
}

/** Je gesprekken, nieuwste eerst. `before` = de updated_at van de laatste die je al hebt. */
export async function listGerrieConversations(
  organizationId: UUID, userId: UUID, options: { before?: string | null; limit?: number } = {},
): Promise<{ items: ConversationSummary[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? PAGE_SIZE, 1), 100);
  let query = supabase.from('ai_conversations').select(CONVERSATION_COLUMNS)
    .eq('organization_id', organizationId).eq('created_by', userId).eq('kind', 'chat')
    .order('updated_at', { ascending: false }).limit(limit + 1);
  if (options.before) query = query.lt('updated_at', options.before);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ConversationRow[];
  return { items: rows.slice(0, limit).map((r) => toSummary(r)), hasMore: rows.length > limit };
}

/**
 * Zoeken in titels en in de berichten zelf. Twee eenvoudige queries in plaats
 * van één database-functie: zo blijft het binnen de RLS die er al is.
 */
export async function searchGerrieConversations(organizationId: UUID, userId: UUID, rawQuery: string): Promise<ConversationSummary[]> {
  const query = normalizeQuery(rawQuery);
  if (query.length < MIN_QUERY) return [];
  const pattern = ilikePattern(query);

  const [titles, messages] = await Promise.all([
    supabase.from('ai_conversations').select(CONVERSATION_COLUMNS)
      .eq('organization_id', organizationId).eq('created_by', userId).eq('kind', 'chat')
      .ilike('title', pattern).order('updated_at', { ascending: false }).limit(50),
    supabase.from('ai_messages').select('conversation_id, content, created_at')
      .eq('organization_id', organizationId).eq('created_by', userId)
      .ilike('content', pattern).order('created_at', { ascending: false }).limit(200),
  ]);
  if (titles.error) throw new Error(titles.error.message);
  if (messages.error) throw new Error(messages.error.message);

  const byTitle = ((titles.data ?? []) as ConversationRow[]).map((r) => toSummary(r));

  // Per gesprek het nieuwste bericht met de treffer, voor het stukje eronder.
  const snippets = new Map<string, string>();
  for (const m of (messages.data ?? []) as Array<{ conversation_id: string; content: string | null }>) {
    if (snippets.has(m.conversation_id)) continue;
    const snippet = snippetAround(String(m.content ?? ''), query);
    if (snippet) snippets.set(m.conversation_id, snippet);
  }

  // Berichten staan ook in verslagen van agents; welke daarvan een chat zijn,
  // weet alleen ai_conversations.
  let byMessage: ConversationSummary[] = [];
  const ids = [...snippets.keys()].slice(0, 100);
  if (ids.length) {
    const { data, error } = await supabase.from('ai_conversations').select(CONVERSATION_COLUMNS)
      .eq('organization_id', organizationId).eq('created_by', userId).eq('kind', 'chat')
      .in('id', ids);
    if (error) throw new Error(error.message);
    byMessage = ((data ?? []) as ConversationRow[]).map((r) => toSummary(r, snippets.get(r.id) ?? null));
  }
  return mergeSearchHits(byTitle, byMessage);
}

/**
 * Wat Gerrie in dit gesprek voorstelde, als titel en onderschrift. De
 * parameters zijn het voorstel zoals het destijds op de kaart stond; is dat
 * een soort die deze versie van de app niet (meer) kent, dan blijft het bij
 * de naam van de handeling in plaats van een fout.
 */
function describeAudit(action: string, params: unknown): { title: string; sub: string } {
  if (params && typeof params === 'object' && 'type' in params) {
    try {
      const info = proposalLabel(params as GerrieProposal);
      if (info.title) return { title: info.title, sub: info.sub ?? '' };
    } catch { /* oudere of onbekende vorm: hieronder */ }
  }
  const readable = action.replace(/^propose_/, '').replace(/_/g, ' ').trim();
  return { title: readable ? `Voorstel: ${readable}` : 'Voorstel', sub: '' };
}

/** Eén gesprek om terug te lezen: de kop, de berichten en wat er met de voorstellen gebeurde. */
export async function loadGerrieConversation(
  organizationId: UUID, userId: UUID, conversationId: UUID,
): Promise<{ conversation: ConversationSummary; messages: ConversationMessage[] }> {
  const [conv, msgs, audits] = await Promise.all([
    supabase.from('ai_conversations').select(CONVERSATION_COLUMNS)
      .eq('id', conversationId).eq('organization_id', organizationId).eq('created_by', userId).eq('kind', 'chat')
      .maybeSingle(),
    supabase.from('ai_messages').select('id, role, content, created_at')
      .eq('conversation_id', conversationId).eq('organization_id', organizationId).eq('created_by', userId)
      .order('created_at', { ascending: true }).limit(1000),
    supabase.from('ai_action_audit').select('id, message_id, action, status, params, created_at')
      .eq('conversation_id', conversationId).eq('organization_id', organizationId).eq('user_id', userId)
      .order('created_at', { ascending: true }).limit(200),
  ]);
  if (conv.error) throw new Error(conv.error.message);
  if (!conv.data) throw new Error('Dit gesprek bestaat niet (meer).');
  if (msgs.error) throw new Error(msgs.error.message);
  // Het auditspoor is extra: lukt dat niet, dan lees je het gesprek nog steeds.
  const auditRows: AuditRow[] = audits.error ? [] : ((audits.data ?? []) as Array<{ id: string; message_id: string | null; action: string; status: string | null; params: unknown; created_at: string }>)
    .map((a) => ({ id: a.id, message_id: a.message_id, status: a.status, created_at: a.created_at, ...describeAudit(String(a.action ?? ''), a.params) }));
  return {
    conversation: toSummary(conv.data as ConversationRow),
    messages: buildThread((msgs.data ?? []) as MessageRow[], auditRows),
  };
}
