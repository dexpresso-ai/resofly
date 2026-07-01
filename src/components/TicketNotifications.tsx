import { useCallback, useEffect, useRef, useState } from 'react';
import { Ticket as TicketIcon, X } from 'lucide-react';
import { supabase, supabaseAuth } from '../lib/supabase';
import { loadTicketUnreadIds } from '../lib/repository';

export interface TicketToast {
  id: string; // dedup-sleutel (t:<ticketId> of n:<noteId>)
  ticketId: string;
  title: string; // "Nieuw ticket" | "Nieuwe reactie"
  label: string; // "<klant>: <tickettitel>"
}

/**
 * Beheert de per-gebruiker ongelezen-tickets (view ticket_unread) plus live
 * meldingen bij klant-activiteit: een nieuw ticket dat een klant via het portaal
 * aanmaakt (created_by is geen orglid) of een nieuwe klantreactie (ticket_note
 * author_type='client'). Telt óók bij navigeren/verversen, zodat de badge klopt
 * als realtime een event mist.
 */
export function useTicketUnread(params: {
  organizationId: string | null;
  currentUserId: string | null;
  teamMemberIds: Set<string>;
  resolveClientName: (clientId: string | null) => string;
  resolveTicket: (ticketId: string) => { title: string; clientName: string } | null;
  onActivity?: () => void;
}) {
  const { organizationId, currentUserId, teamMemberIds, resolveClientName, resolveTicket, onActivity } = params;
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<TicketToast[]>([]);

  // De realtime-callback mag niet opnieuw abonneren bij data-wijzigingen; via refs
  // pakt hij altijd de actuele leden/resolvers/callback.
  const teamRef = useRef(teamMemberIds); teamRef.current = teamMemberIds;
  const clientRef = useRef(resolveClientName); clientRef.current = resolveClientName;
  const ticketRef = useRef(resolveTicket); ticketRef.current = resolveTicket;
  const activityRef = useRef(onActivity); activityRef.current = onActivity;

  const refreshUnread = useCallback(() => {
    if (!organizationId) { setUnreadIds(new Set()); return; }
    loadTicketUnreadIds(organizationId)
      .then(setUnreadIds)
      .catch(() => { /* stil: badge is best-effort en telt bij navigeren opnieuw */ });
  }, [organizationId]);

  const dismissToast = useCallback((id: string) => {
    setToasts(list => list.filter(toast => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: TicketToast) => {
    setToasts(list => (list.some(t => t.id === toast.id) ? list : [...list, toast]));
  }, []);

  useEffect(() => {
    setToasts([]);
    if (!organizationId || !currentUserId) { setUnreadIds(new Set()); return; }
    refreshUnread();

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase
        .channel(`tickets-${organizationId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'tickets', filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            const row = payload.new as { id?: string; client_id?: string | null; title?: string; created_by?: string | null };
            if (!row.id) return;
            // Alleen tickets die de KLANT aanmaakte tellen als 'nieuw' (created_by
            // is geen organisatielid); interne tickets negeren we.
            const createdBy = row.created_by ?? null;
            if (!createdBy || teamRef.current.has(createdBy)) return;
            refreshUnread();
            activityRef.current?.();
            pushToast({
              id: `t:${row.id}`,
              ticketId: row.id,
              title: 'Nieuw ticket',
              label: `${clientRef.current(row.client_id ?? null)}: ${(row.title || '').trim() || '(geen titel)'}`,
            });
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'ticket_notes', filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            const row = payload.new as { id?: string; ticket_id?: string; author_type?: string };
            if (row.author_type !== 'client' || !row.ticket_id || !row.id) return;
            refreshUnread();
            activityRef.current?.();
            const info = ticketRef.current(row.ticket_id);
            pushToast({
              id: `n:${row.id}`,
              ticketId: row.ticket_id,
              title: 'Nieuwe reactie',
              label: info ? `${info.clientName}: ${info.title}` : 'op een ticket',
            });
          },
        )
        .subscribe();
    });

    return () => { cancelled = true; if (channel) supabase.removeChannel(channel); };
  }, [organizationId, currentUserId, refreshUnread, pushToast]);

  return { unreadIds, refreshUnread, toasts, dismissToast };
}

// Hergebruikt bewust de gedeelde .email-toast* styling (zie globals.css) — visueel
// identiek aan de klant-mail-melding.
export function TicketToasts({ toasts, onOpen, onDismiss }: {
  toasts: TicketToast[];
  onOpen: (ticketId: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return <div className="email-toast-stack" role="region" aria-label="Nieuwe tickets">
    {toasts.map(toast => (
      <TicketToastItem key={toast.id} toast={toast} onOpen={onOpen} onDismiss={onDismiss} />
    ))}
  </div>;
}

function TicketToastItem({ toast, onOpen, onDismiss }: {
  toast: TicketToast;
  onOpen: (ticketId: string) => void;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 9000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return <div className="email-toast" role="status">
    <button type="button" className="email-toast-main" onClick={() => onOpen(toast.ticketId)}>
      <span className="email-toast-icon"><TicketIcon size={16} /></span>
      <span className="email-toast-text">
        <strong>{toast.title}</strong>
        <span className="email-toast-sub">{toast.label}</span>
      </span>
    </button>
    <button type="button" className="email-toast-close" aria-label="Melding sluiten" onClick={() => onDismiss(toast.id)}>
      <X size={14} />
    </button>
  </div>;
}
