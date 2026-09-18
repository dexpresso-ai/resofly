// ============================================================
// Frontend-koppeling met de factuur-inbox (`invoice-inbox` Edge Function).
//
// De automatische verwerking start server-side zodra een mail op het
// factuur-doorstuuradres binnenkomt (mail-inbound). Wat hier staat zijn de
// knoppen in het scherm: opnieuw verwerken, klaarzetten met een gekozen of
// nieuwe leverancier, toch klaarzetten bij een duplicaat, negeren, herstellen.
// Elke actie geeft het bijgewerkte inbox-item terug.
// ============================================================

import { supabase } from './supabase';
import type { PurchaseInvoiceInboxItem, UUID } from '../types';

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export type InvoiceInboxAction =
  | { action: 'process'; allowDuplicate?: boolean }
  | { action: 'prepare'; supplierId?: UUID | null; createSupplier?: boolean; allowDuplicate?: boolean }
  | { action: 'reject' }
  | { action: 'restore' };

type InboxResponse = { ok: true; item: PurchaseInvoiceInboxItem } | { ok: false; error: string };

export async function runInvoiceInboxAction(organizationId: UUID, inboxId: UUID, input: InvoiceInboxAction): Promise<PurchaseInvoiceInboxItem> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');

  const res = await fetch(`${FUNCTIONS_BASE}/invoice-inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ organizationId, inboxId, ...input }),
  });

  const payload = (await res.json().catch(() => null)) as InboxResponse | null;
  if (!res.ok || !payload || payload.ok === false) {
    const msg = payload && 'error' in payload && payload.error ? payload.error : `Actie mislukt (${res.status}).`;
    throw new Error(msg);
  }
  return payload.item;
}
