import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, supabaseAuth } from '../lib/supabase';
import { loadPurchaseInvoiceInboxOpenCount } from '../lib/repository';

/**
 * De factuur-inbox op App-niveau: de teller voor de badge op Inkoopfacturen
 * (items die op een mens wachten) en een `activity`-tikker waarop het paneel
 * op de pagina Inkoopfacturen zijn lijst herlaadt. Eén realtime-abonnement op
 * purchase_invoice_inbox voor de hele organisatie, zoals useClientEmailUnread
 * dat voor de opvangbak doet.
 *
 * Realtime is best effort: mist een event (RLS-token-timing, verbinding weg),
 * dan telt de langzame terugvalpoll alsnog goed. De server is de waarheid, het
 * event alleen de aanleiding om opnieuw te kijken.
 */
export function usePurchaseInvoiceInbox(params: {
  organizationId: string | null;
  currentUserId: string | null;
  /** Uit zolang de module Financiën dicht staat voor dit teamlid: dan is er niets te tellen. */
  enabled: boolean;
}) {
  const { organizationId, currentUserId, enabled } = params;
  const [count, setCount] = useState(0);
  const [activity, setActivity] = useState(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refresh = useCallback(() => {
    if (!organizationId || !enabledRef.current) { setCount(0); return; }
    loadPurchaseInvoiceInboxOpenCount(organizationId)
      .then(setCount)
      .catch(() => setCount(0));
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId || !currentUserId || !enabled) { setCount(0); return; }
    refresh();

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Realtime met RLS heeft de JWT van de gebruiker nodig, anders komen de
    // org-scoped events niet door. Zet de auth expliciet vóór abonneren.
    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase
        .channel(`purchase-invoice-inbox-${organizationId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'purchase_invoice_inbox', filter: `organization_id=eq.${organizationId}` },
          () => { refresh(); setActivity(n => n + 1); },
        )
        .subscribe();
    });

    // Terugval: elke twee minuten opnieuw tellen, ook als realtime niets zegt.
    const poll = window.setInterval(refresh, 120_000);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      if (channel) supabase.removeChannel(channel);
    };
  }, [organizationId, currentUserId, enabled, refresh]);

  return { count, activity, refresh };
}
