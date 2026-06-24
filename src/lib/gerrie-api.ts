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

/** Door Gerrie voorgestelde conceptfactuur — opent vooringevuld in het factuurformulier. */
export interface GerrieInvoiceProposal {
  type: 'invoice';
  client_id: UUID;
  client_name: string;
  lines: Array<{ description: string; quantity: number; unit_price: number; vat: number }>;
  notes: string | null;
  due_date: string | null;
  total_eur: number;
}

export interface GerrieResult {
  conversationId: UUID;
  messageId: UUID;
  text: string;
  budget?: { remainingFraction: number };
  proposal?: GerrieInvoiceProposal;
}

export interface GerrieRequest {
  organizationId: UUID;
  conversationId: UUID | null;
  message: string;
  onStatus?: (status: GerrieStatus) => void;
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
      else if (parsed.event === 'done') result = parsed.data as GerrieResult;
      else if (parsed.event === 'error') errorMessage = String((parsed.data as { message?: string }).message ?? 'Onbekende fout.');
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!result) throw new Error('Gerrie gaf geen antwoord terug. Probeer het opnieuw.');
  return result;
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
