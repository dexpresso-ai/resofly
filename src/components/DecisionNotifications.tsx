import { useCallback, useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { supabase, supabaseAuth } from '../lib/supabase';
import { countDueDecisions } from '../lib/decisions-api';

/**
 * Teller + live melding voor de beslislijst, op app-niveau (zoals de
 * klantmail-melding): de badge op de menuregel Gerrie en een toast zodra een
 * nieuwe kaart binnenkomt, ook als je niet op het startscherm staat.
 *
 * Realtime met RLS heeft de JWT nodig; daarom setAuth vóór het abonneren. De
 * teller ververst óók bij navigeren, zodat de badge klopt als een event mist.
 */

export interface DecisionToast {
  id: string; // ai_decisions.id — tevens dedup-sleutel
  title: string;
  origin: 'rule' | 'gerrie';
}

export function useDecisionAlerts(params: { organizationId: string | null; currentUserId: string | null }) {
  const { organizationId, currentUserId } = params;
  const [count, setCount] = useState(0);
  const [toasts, setToasts] = useState<DecisionToast[]>([]);

  const refresh = useCallback(() => {
    if (!organizationId) { setCount(0); return; }
    countDueDecisions(organizationId).then(setCount).catch(() => { /* badge is best-effort */ });
  }, [organizationId]);

  const dismissToast = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    setToasts([]);
    if (!organizationId || !currentUserId) { setCount(0); return; }
    refresh();

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase
        .channel(`decisions-${organizationId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_decisions', filter: `organization_id=eq.${organizationId}` }, (payload) => {
          const row = payload.new as { id?: string; title?: string; origin?: string; status?: string };
          refresh();
          if (!row.id || row.status !== 'open') return;
          const toast: DecisionToast = { id: row.id, title: (row.title || 'Nieuwe kaart').trim(), origin: row.origin === 'gerrie' ? 'gerrie' : 'rule' };
          setToasts((list) => (list.some((t) => t.id === toast.id) ? list : [...list, toast]));
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ai_decisions', filter: `organization_id=eq.${organizationId}` }, () => refresh())
        .subscribe();
    });

    return () => { cancelled = true; if (channel) supabase.removeChannel(channel); };
  }, [organizationId, currentUserId, refresh]);

  return { count, refresh, toasts, dismissToast };
}

export function DecisionToasts({ toasts, onOpen, onDismiss }: {
  toasts: DecisionToast[];
  onOpen: () => void;
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return <div className="email-toast-stack" role="region" aria-label="Nieuwe beslissingen">
    {toasts.map((toast) => <DecisionToastItem key={toast.id} toast={toast} onOpen={onOpen} onDismiss={onDismiss} />)}
  </div>;
}

function DecisionToastItem({ toast, onOpen, onDismiss }: { toast: DecisionToast; onOpen: () => void; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 9000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return <div className="email-toast" role="status">
    <button type="button" className="email-toast-main" onClick={() => { onOpen(); onDismiss(toast.id); }}>
      <span className="email-toast-icon"><Sparkles size={16} /></span>
      <span className="email-toast-text">
        <strong>{toast.origin === 'gerrie' ? 'Gerrie stelt voor' : 'Te beslissen'}</strong>
        <span className="email-toast-sub">{toast.title}</span>
      </span>
    </button>
    <button type="button" className="email-toast-close" aria-label="Melding sluiten" onClick={() => onDismiss(toast.id)}>
      <X size={14} />
    </button>
  </div>;
}
