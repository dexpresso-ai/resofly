// ============================================================
// De factuur-inbox in gewone taal: statussen, redenen en de vraag "moet hier
// iemand naar kijken?". Bewust zonder runtime-imports, zodat `node --test`
// dit bestand draait (zie invoiceInbox.test.ts) en de labels op één plek
// staan voor het inbox-paneel en de instellingenkaart.
// ============================================================

import type { PurchaseInvoiceInboxAttachment, PurchaseInvoiceInboxItem, PurchaseInvoiceInboxStatus } from '../types';

/** Statussen waarbij een mens iets moet doen. */
export const INBOX_ATTENTION_STATUSES: PurchaseInvoiceInboxStatus[] = ['needs_review', 'duplicate', 'failed'];
/** Statussen waarbij het systeem nog bezig is. */
export const INBOX_BUSY_STATUSES: PurchaseInvoiceInboxStatus[] = ['received', 'processing'];

export const INBOX_STATUS_LABELS: Record<PurchaseInvoiceInboxStatus, string> = {
  received: 'Ontvangen',
  processing: 'Wordt uitgelezen…',
  ready: 'Concept klaargezet',
  booked: 'Geboekt',
  needs_review: 'Aandacht nodig',
  duplicate: 'Dubbel',
  rejected: 'Genegeerd',
  failed: 'Mislukt',
  dropped: 'Weggegooid',
};

/** Waarom een item niet (of niet vanzelf) tot een concept leidde. */
export const INBOX_REASON_LABELS: Record<string, string> = {
  supplier_unknown: 'Leverancier niet herkend — kies er een of maak hem aan',
  no_attachment: 'Geen factuurbestand (PDF, XML of afbeelding) in de mail, en de mailtekst zelf is geen factuur',
  attachments_missing: 'De bijlagen zijn niet meegekomen — is de Email Worker bijgewerkt?',
  oversized: 'De mail is te groot om te verwerken (limiet 12 MB)',
  nothing_extracted: 'In de bijlagen is geen factuur herkend',
  ai_disabled: 'AI-uitlezen staat uit in de instellingen (alleen UBL-e-facturen gaan automatisch)',
  // Bonnen uit de app (20261118120000): wie de foto maakte, koos voor geen AI.
  ai_declined: 'Gerrie staat uit voor wie deze bon instuurde, dus hij is niet gelezen — vul hem zelf in',
  declaration_declined: 'Declaratie afgewezen',
  ai_unavailable: 'AI is niet geconfigureerd op de server',
  budget_exhausted: 'Het AI-tegoed van deze maand is op',
  extraction_failed: 'Uitlezen mislukt',
  rate_limited: 'Ongewoon veel post tegelijk — niet automatisch verwerkt',
  duplicate_number: 'Dit factuurnummer staat al bij deze leverancier',
  duplicate_file: 'Precies dit bestand is al eerder verwerkt',
  draft_deleted: 'Het klaargezette concept is verwijderd',
  draft_cancelled: 'Het klaargezette concept is geannuleerd',
  storage_unavailable: 'Bestandsopslag is niet geconfigureerd (media-worker)',
  storage_failed: 'De bijlagen konden niet worden opgeslagen',
  processing_error: 'Onverwachte fout bij het verwerken',
  dismissed_by_user: 'Genegeerd',
  blocked: 'Afzender staat op je negeerlijst',
};

export const INBOX_SUPPLIER_MATCH_LABELS: Record<string, string> = {
  vat: 'herkend op BTW-nummer',
  iban: 'herkend op IBAN',
  email: 'herkend op e-mailadres',
  name: 'herkend op naam',
  manual: 'door jou gekozen',
  created: 'nieuw aangemaakt',
};

export function inboxReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return INBOX_REASON_LABELS[reason] ?? reason;
}

/**
 * Moet hier iemand naar kijken? Ook een declaratie met een concept: die wacht
 * op goedkeuring. Een concept uit de mail of een eigen bon niet; dat boek je
 * wanneer je wilt. (Zonder `channel`, van vóór 20261118120000, is het mail.)
 */
export function inboxNeedsAttention(item: Pick<PurchaseInvoiceInboxItem, 'status'> & { channel?: PurchaseInvoiceInboxItem['channel'] }): boolean {
  if (item.channel === 'declaration' && item.status === 'ready') return true;
  return INBOX_ATTENTION_STATUSES.includes(item.status);
}

export function inboxIsBusy(item: Pick<PurchaseInvoiceInboxItem, 'status'>): boolean {
  return INBOX_BUSY_STATUSES.includes(item.status);
}

/**
 * Twee stapels: wat nu aandacht vraagt of nog loopt (bovenaan, nieuwste eerst)
 * en wat afgehandeld is (concept klaar, geboekt, genegeerd), ook nieuwste eerst.
 */
export function splitInboxItems<T extends Pick<PurchaseInvoiceInboxItem, 'status' | 'received_at'> & { channel?: PurchaseInvoiceInboxItem['channel'] }>(items: T[]): { open: T[]; done: T[] } {
  const byDate = (a: T, b: T) => b.received_at.localeCompare(a.received_at);
  const open = items.filter(i => inboxNeedsAttention(i) || inboxIsBusy(i)).sort(byDate);
  const done = items.filter(i => !inboxNeedsAttention(i) && !inboxIsBusy(i)).sort(byDate);
  return { open, done };
}

export function countInboxAttention<T extends Pick<PurchaseInvoiceInboxItem, 'status'> & { channel?: PurchaseInvoiceInboxItem['channel'] }>(items: T[]): number {
  return items.filter(inboxNeedsAttention).length;
}

/**
 * Eén regel die zegt wat er is uitgelezen: leverancier, factuurnummer en
 * totaal. Zonder voorstel valt hij terug op afzender en onderwerp; bij een bon
 * uit de app op "Bon" of "Declaratie" (de afzender is daar het teamlid zelf,
 * en dat staat al op de regel eronder).
 */
export function inboxItemSummary(item: Pick<PurchaseInvoiceInboxItem, 'proposal' | 'sender_name' | 'sender_email' | 'subject'> & { channel?: PurchaseInvoiceInboxItem['channel'] }): {
  title: string; number: string | null; totalCents: number | null; fallback: boolean;
} {
  if (item.channel === 'receipt' || item.channel === 'declaration') {
    const p = item.proposal;
    const label = item.channel === 'declaration' ? 'Declaratie' : 'Bon';
    return {
      title: p?.supplier.name || label,
      number: p?.supplier_invoice_number ?? null,
      totalCents: p ? (p.totals.total_cents || p.extracted_totals?.total_cents || null) : null,
      fallback: !p?.supplier.name,
    };
  }
  const p = item.proposal;
  if (p && (p.supplier.name || p.supplier_invoice_number || p.totals.total_cents)) {
    return {
      title: p.supplier.name || item.sender_name || item.sender_email || 'Onbekende leverancier',
      number: p.supplier_invoice_number,
      totalCents: p.totals.total_cents || p.extracted_totals?.total_cents || null,
      fallback: false,
    };
  }
  return {
    title: item.sender_name || item.sender_email || 'Onbekende afzender',
    number: null,
    totalCents: null,
    fallback: true,
  };
}

/** De bijlagen die iets betekenen voor de gebruiker: opgeslagen bestanden eerst. */
export function describeAttachment(att: PurchaseInvoiceInboxAttachment): { label: string; downloadable: boolean; note: string | null } {
  const kindNote: Record<PurchaseInvoiceInboxAttachment['kind'], string | null> = {
    document: null,
    copy: 'kopie van de e-factuur',
    body: 'de factuur stond in de mail zelf',
    other: 'niet uitgelezen',
    oversized: 'te groot',
    unsupported: 'geen factuurbestand',
    skipped: 'niet uitgelezen',
  };
  return {
    label: att.name || 'bijlage',
    downloadable: Boolean(att.storage_key),
    note: att.note ?? kindNote[att.kind],
  };
}

/** Welke knoppen horen bij deze status? Eén plek, zodat paneel en tests het eens zijn. */
export function inboxActionsFor(item: Pick<PurchaseInvoiceInboxItem, 'status' | 'reason' | 'purchase_invoice_id' | 'duplicate_of_purchase_invoice_id' | 'proposal'>): {
  open: boolean; prepare: boolean; forceDuplicate: boolean; retry: boolean; reject: boolean; restore: boolean;
} {
  const hasProposal = Boolean(item.proposal);
  switch (item.status) {
    case 'ready':
    case 'booked':
      return { open: Boolean(item.purchase_invoice_id), prepare: false, forceDuplicate: false, retry: !item.purchase_invoice_id, reject: false, restore: false };
    case 'needs_review':
      return {
        open: false,
        prepare: item.reason === 'supplier_unknown' && hasProposal,
        forceDuplicate: false,
        retry: item.reason !== 'supplier_unknown' || !hasProposal,
        reject: true,
        restore: false,
      };
    case 'duplicate':
      // Bij een duplicaat is er géén eigen concept — de factuur die er al was,
      // staat in duplicate_of_purchase_invoice_id. Op purchase_invoice_id
      // kijken (wat hier eerder gebeurde) zette de knop dus altijd uit, precies
      // in het geval waarin "laat me die bestaande factuur zien" de enige
      // zinnige volgende stap is.
      return {
        open: Boolean(item.duplicate_of_purchase_invoice_id ?? item.purchase_invoice_id),
        prepare: false, forceDuplicate: hasProposal, retry: false, reject: true, restore: false,
      };
    case 'failed':
      return { open: false, prepare: false, forceDuplicate: false, retry: true, reject: true, restore: false };
    case 'rejected':
      return { open: false, prepare: false, forceDuplicate: false, retry: false, reject: false, restore: true };
    default:
      return { open: false, prepare: false, forceDuplicate: false, retry: false, reject: false, restore: false };
  }
}

/** Het adres dat de gebruiker kopieert en bij zijn provider of leveranciers gebruikt. */
export function invoiceInboxAddress(localPart: string | null | undefined, domain = 'inbound.resofly.com'): string {
  return localPart ? `${localPart}@${domain}` : '';
}
