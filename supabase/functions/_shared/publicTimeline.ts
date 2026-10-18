// ============================================================
// Tijdlijn op de publieke offerte-, factuur- en contractpagina.
//
// De event-tabellen zijn in de eerste plaats het interne logboek: daar staan ook
// de interne goedkeuring (met afwijzingsreden), mislukte verzendingen met de
// fouttekst van de provider, voorgestelde aanmaningen en open-/kliktracking. Een
// klant ziet alleen de stappen die over HEM gaan, met een vaste titel en zonder
// omschrijving of metadata — ook als er later nieuwe interne event-types bijkomen
// (allowlist, geen denylist).
// ============================================================

export type PublicTimelineKind = 'quote' | 'invoice' | 'contract';

const CUSTOMER_EVENT_TITLES: Record<PublicTimelineKind, Record<string, string>> = {
  quote: {
    sent_to_client: 'Offerte verstuurd',
    email_sent: 'Offerte per e-mail verstuurd',
    client_viewed: 'Offerte bekeken',
    client_accepted: 'Offerte geaccepteerd',
    client_rejected: 'Offerte afgewezen',
    expired: 'Offerte verlopen',
    cancelled: 'Offerte ingetrokken',
  },
  invoice: {
    sent_to_client: 'Factuur verstuurd',
    email_sent: 'Factuur per e-mail verstuurd',
    client_viewed: 'Factuur bekeken',
    payment_paid: 'Betaald',
    payment_refunded: 'Bedrag terugbetaald',
    credit_note_issued: 'Creditnota opgemaakt',
    credit_note_emailed: 'Creditnota verstuurd',
    reminder_sent: 'Betalingsherinnering verstuurd',
    dunning_sent: 'Aanmaning verstuurd',
    cancelled: 'Factuur geannuleerd',
    void: 'Factuur vervallen',
  },
  contract: {
    sent_to_client: 'Contract verstuurd ter ondertekening',
    email_sent: 'Contract per e-mail verstuurd',
    client_viewed: 'Contract bekeken',
    client_signed: 'Contract ondertekend',
    client_declined: 'Contract geweigerd',
    question_asked: 'Vraag gesteld',
    reminded: 'Herinnering verstuurd',
    voided: 'Contract ingetrokken',
    expired: 'Contract verlopen',
  },
};

export interface PublicTimelineEvent {
  id?: string;
  event_type: string;
  title: string;
  description: null;
  created_at: string;
}

/**
 * Een teruggedraaide bankbetaling ('payment_unbooked', intern) heft de laatste
 * "Betaald" ervóór op: de klant zag anders "Betaald" bij een factuur die weer
 * openstaat. Op hetzelfde tijdstip telt de betaling als eerst.
 */
function revokedPayments(events: ReadonlyArray<Record<string, unknown>>): Set<number> {
  const rank = (type: string) => (type === 'payment_unbooked' ? 1 : 0);
  const order = events
    .map((event, index) => ({ index, type: String(event.event_type ?? ''), at: String(event.created_at ?? '') }))
    .filter((e) => e.type === 'payment_paid' || e.type === 'payment_unbooked')
    .sort((a, b) => (a.at === b.at ? rank(a.type) - rank(b.type) : a.at < b.at ? -1 : 1));
  const paid: number[] = [];
  const revoked = new Set<number>();
  for (const e of order) {
    if (e.type === 'payment_paid') paid.push(e.index);
    else {
      const last = paid.pop();
      if (last !== undefined) revoked.add(last);
    }
  }
  return revoked;
}

/** Alleen klantgerichte stappen, met vaste titel; omschrijving en metadata vallen weg. */
export function toPublicTimeline(kind: PublicTimelineKind, events: ReadonlyArray<Record<string, unknown>>): PublicTimelineEvent[] {
  const titles = CUSTOMER_EVENT_TITLES[kind];
  const revoked = kind === 'invoice' ? revokedPayments(events) : new Set<number>();
  const out: PublicTimelineEvent[] = [];
  for (const [index, event] of events.entries()) {
    if (revoked.has(index)) continue;
    const type = String(event.event_type ?? '');
    const title = Object.prototype.hasOwnProperty.call(titles, type) ? titles[type] : undefined;
    if (!title) continue;
    out.push({
      ...(event.id ? { id: String(event.id) } : {}),
      event_type: type,
      title,
      description: null,
      created_at: String(event.created_at ?? ''),
    });
  }
  return out;
}
