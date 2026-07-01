import { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, X } from 'lucide-react';
import { supabase, supabaseAuth } from '../lib/supabase';
import { loadClientEmailUnreadCounts } from '../lib/repository';
import type { ClientEmailUnreadCounts } from '../types';

const EMPTY_COUNTS: ClientEmailUnreadCounts = { total: 0, byClient: {} };

export interface EmailToast {
  id: string; // client_email id — tevens dedup-sleutel
  clientId: string;
  clientName: string;
  from: string;
  subject: string;
}

/**
 * Beheert de per-gebruiker ongelezen-tellers voor klant-mail plus een live
 * notificatie bij inkomende berichten (Supabase Realtime op client_emails).
 * De teller ververst óók bij navigeren/verversen, zodat de badge klopt ook als
 * realtime (bijv. door RLS-token-timing) een event mist.
 */
export function useClientEmailUnread(params: {
  organizationId: string | null;
  currentUserId: string | null;
  resolveClientName: (clientId: string) => string;
}) {
  const { organizationId, currentUserId, resolveClientName } = params;
  const [unread, setUnread] = useState<ClientEmailUnreadCounts>(EMPTY_COUNTS);
  const [toasts, setToasts] = useState<EmailToast[]>([]);

  // De realtime-callback mag niet opnieuw abonneren als alleen de klantnamen
  // wijzigen; via een ref pakt hij altijd de actuele resolver.
  const resolveRef = useRef(resolveClientName);
  resolveRef.current = resolveClientName;

  const refreshUnread = useCallback(() => {
    if (!organizationId) { setUnread(EMPTY_COUNTS); return; }
    loadClientEmailUnreadCounts(organizationId)
      .then(setUnread)
      .catch(() => { /* stil: badge is best-effort en telt bij navigeren opnieuw */ });
  }, [organizationId]);

  const dismissToast = useCallback((id: string) => {
    setToasts(list => list.filter(toast => toast.id !== id));
  }, []);

  useEffect(() => {
    setToasts([]);
    if (!organizationId || !currentUserId) { setUnread(EMPTY_COUNTS); return; }
    refreshUnread();

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Realtime met RLS heeft de JWT van de gebruiker nodig, anders komen de
    // org-scoped inbound-events niet door. Zet de auth expliciet vóór abonneren.
    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase
        .channel(`client-emails-${organizationId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'client_emails', filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            const row = payload.new as {
              id?: string; direction?: string; client_id?: string;
              subject?: string; from_email?: string; from_name?: string;
            };
            if (row.direction !== 'inbound' || !row.id || !row.client_id) return;
            refreshUnread();
            const toast: EmailToast = {
              id: row.id,
              clientId: row.client_id,
              clientName: resolveRef.current(row.client_id),
              from: (row.from_name || row.from_email || '').trim() || 'onbekende afzender',
              subject: (row.subject || '').trim() || '(geen onderwerp)',
            };
            setToasts(list => (list.some(t => t.id === toast.id) ? list : [...list, toast]));
          },
        )
        .subscribe();
    });

    return () => { cancelled = true; if (channel) supabase.removeChannel(channel); };
  }, [organizationId, currentUserId, refreshUnread]);

  return { unread, refreshUnread, toasts, dismissToast };
}

export function ClientEmailToasts({ toasts, onOpen, onDismiss }: {
  toasts: EmailToast[];
  onOpen: (clientId: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return <div className="email-toast-stack" role="region" aria-label="Nieuwe klantberichten">
    {toasts.map(toast => (
      <EmailToastItem key={toast.id} toast={toast} onOpen={onOpen} onDismiss={onDismiss} />
    ))}
  </div>;
}

function EmailToastItem({ toast, onOpen, onDismiss }: {
  toast: EmailToast;
  onOpen: (clientId: string) => void;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 9000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return <div className="email-toast" role="status">
    <button type="button" className="email-toast-main" onClick={() => onOpen(toast.clientId)}>
      <span className="email-toast-icon"><Mail size={16} /></span>
      <span className="email-toast-text">
        <strong>Nieuw bericht{toast.clientName ? ` — ${toast.clientName}` : ''}</strong>
        <span className="email-toast-sub">{toast.from}: {toast.subject}</span>
      </span>
    </button>
    <button type="button" className="email-toast-close" aria-label="Melding sluiten" onClick={() => onDismiss(toast.id)}>
      <X size={14} />
    </button>
  </div>;
}
