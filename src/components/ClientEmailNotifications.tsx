import { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, Mail, X } from 'lucide-react';
import { supabase, supabaseAuth } from '../lib/supabase';
import { loadClientEmailUnreadCounts, loadInboundOpenCount } from '../lib/repository';
import type { ClientEmailUnreadCounts } from '../types';

const EMPTY_COUNTS: ClientEmailUnreadCounts = { total: 0, byClient: {} };

export interface EmailToast {
  id: string; // client_email id of `inbox:<inbound_message id>` — tevens dedup-sleutel
  /** 'client': antwoord in een klantdossier; 'inbox': post die nog niet aan een klant hangt. */
  kind: 'client' | 'inbox';
  clientId: string | null;
  threadId: string | null;
  clientName: string;
  from: string;
  subject: string;
}

/**
 * Beheert de per-gebruiker ongelezen-tellers voor klant-mail, de teller van de
 * opvangbak (post die nog niet aan een klant gekoppeld is) en een live
 * notificatie bij inkomende berichten (Supabase Realtime op client_emails en
 * inbound_messages). Beide tellers verversen óók bij navigeren/verversen,
 * zodat de badge klopt ook als realtime (bijv. door RLS-token-timing) een
 * event mist.
 *
 * `activity` loopt op bij elk live-event; de pagina Berichten laadt dan haar
 * lijst opnieuw zonder zelf een tweede abonnement te hoeven openen.
 */
export function useClientEmailUnread(params: {
  organizationId: string | null;
  currentUserId: string | null;
  resolveClientName: (clientId: string) => string;
}) {
  const { organizationId, currentUserId, resolveClientName } = params;
  const [unread, setUnread] = useState<ClientEmailUnreadCounts>(EMPTY_COUNTS);
  const [inboxCount, setInboxCount] = useState(0);
  const [activity, setActivity] = useState(0);
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

  // Faalt dit (bijv. geen leesrecht op de module Klanten), dan blijft de
  // teller op nul en verdwijnt het tabblad simpelweg uit beeld.
  const refreshInbox = useCallback(() => {
    if (!organizationId) { setInboxCount(0); return; }
    loadInboundOpenCount(organizationId)
      .then(setInboxCount)
      .catch(() => setInboxCount(0));
  }, [organizationId]);

  const dismissToast = useCallback((id: string) => {
    setToasts(list => list.filter(toast => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: EmailToast) => {
    setToasts(list => (list.some(t => t.id === toast.id) ? list : [...list, toast]));
  }, []);

  useEffect(() => {
    setToasts([]);
    if (!organizationId || !currentUserId) { setUnread(EMPTY_COUNTS); setInboxCount(0); return; }
    refreshUnread();
    refreshInbox();

    let cancelled = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];

    // Realtime met RLS heeft de JWT van de gebruiker nodig, anders komen de
    // org-scoped inbound-events niet door. Zet de auth expliciet vóór abonneren.
    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channels.push(supabase
        .channel(`client-emails-${organizationId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'client_emails', filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            const row = payload.new as {
              id?: string; direction?: string; client_id?: string; thread_id?: string;
              subject?: string; from_email?: string; from_name?: string;
            };
            if (row.direction !== 'inbound' || !row.id || !row.client_id) return;
            refreshUnread();
            setActivity(n => n + 1);
            pushToast({
              id: row.id,
              kind: 'client',
              clientId: row.client_id,
              threadId: row.thread_id ?? null,
              clientName: resolveRef.current(row.client_id),
              from: (row.from_name || row.from_email || '').trim() || 'onbekende afzender',
              subject: (row.subject || '').trim() || '(geen onderwerp)',
            });
          },
        )
        .subscribe());

      // De opvangbak staat bewust op een EIGEN kanaal. Een kanaal met twee
      // bindingen valt in zijn geheel om als er één niet deugt, en
      // inbound_messages is pas sinds kort onderdeel van de publicatie: in een
      // omgeving waar die migratie nog niet gedraaid is, zou de bestaande
      // melding voor klantmail dan mee omvallen.
      //
      // Een binnenkomende mail wordt eerst onvoorwaardelijk vastgelegd (INSERT,
      // status 'unmatched') en in dezelfde transactie afgehandeld (UPDATE:
      // gekoppeld, geparkeerd of weggegooid). Pas de UPDATE zegt dus of er echt
      // iets in de opvangbak ligt: status 'unmatched' mét een reden en zonder
      // afhandeling. Op elk event tellen we opnieuw — de server is de waarheid,
      // niet het event.
      channels.push(supabase
        .channel(`inbound-messages-${organizationId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'inbound_messages', filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            refreshInbox();
            setActivity(n => n + 1);
            if (payload.eventType !== 'UPDATE') return;
            const row = payload.new as {
              id?: string; status?: string; reason?: string | null; category?: string;
              handled_at?: string | null; subject?: string; sender_email?: string | null; sender_name?: string | null;
            };
            if (!row.id || row.status !== 'unmatched' || !row.reason || row.category !== 'human' || row.handled_at) return;
            pushToast({
              id: `inbox:${row.id}`,
              kind: 'inbox',
              clientId: null,
              threadId: null,
              clientName: '',
              from: (row.sender_name || row.sender_email || '').trim() || 'onbekende afzender',
              subject: (row.subject || '').trim() || '(geen onderwerp)',
            });
          },
        )
        .subscribe());
    });

    return () => { cancelled = true; for (const channel of channels) supabase.removeChannel(channel); };
  }, [organizationId, currentUserId, refreshUnread, refreshInbox, pushToast]);

  return { unread, refreshUnread, inboxCount, refreshInbox, activity, toasts, dismissToast };
}

export function ClientEmailToasts({ toasts, onOpen, onDismiss }: {
  toasts: EmailToast[];
  onOpen: (toast: EmailToast) => void;
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
  onOpen: (toast: EmailToast) => void;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 9000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const title = toast.kind === 'inbox'
    ? 'Nieuw bericht — nog niet gekoppeld'
    : `Nieuw bericht${toast.clientName ? ` — ${toast.clientName}` : ''}`;

  return <div className="email-toast" role="status">
    <button type="button" className="email-toast-main" onClick={() => onOpen(toast)}>
      <span className="email-toast-icon">{toast.kind === 'inbox' ? <Inbox size={16} /> : <Mail size={16} />}</span>
      <span className="email-toast-text">
        <strong>{title}</strong>
        <span className="email-toast-sub">{toast.from}: {toast.subject}</span>
      </span>
    </button>
    <button type="button" className="email-toast-close" aria-label="Melding sluiten" onClick={() => onDismiss(toast.id)}>
      <X size={14} />
    </button>
  </div>;
}
