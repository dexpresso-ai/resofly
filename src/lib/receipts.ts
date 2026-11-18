// ============================================================
// Bonnen fotograferen en declaraties: de regels voor het scherm.
//
// Wie Financiën mag bewerken, fotografeert een bon en krijgt een concept-
// inkoopfactuur. Ieder ander teamlid dient zo een declaratie in, die iemand
// met Financiën goedkeurt. Hier staat wat het scherm daarover beslist: hoe
// groot een foto mag zijn, wat er na het uitlezen te kiezen valt, en de
// woorden voor de status van een declaratie.
//
// Bewust zonder runtime-imports, zodat `node --test` dit bestand draait
// (receipts.test.ts).
// ============================================================

import type { DeclarationStatus, PurchaseInvoiceInboxItem } from '../types';

/** Wat de bestandskiezer aanbiedt: foto's en pdf-scans. */
export const RECEIPT_ACCEPT = 'image/*,application/pdf,.pdf';

/** Gelijk aan de limiet van de edge function invoice-inbox. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Een foto van een telefoon is 3 tot 8 MB. Verkleind tot 2400 pixels aan de
 * lange kant blijft een bon goed leesbaar (ook als bewijsstuk voor de
 * Belastingdienst), en is hij een halve megabyte: snel verstuurd op 4G.
 */
export const RECEIPT_MAX_EDGE = 2400;
export const RECEIPT_JPEG_QUALITY = 0.85;

/** Hoeveel bonnen je in één keer uit je galerij kunt kiezen. */
export const RECEIPTS_PER_BATCH = 10;

/** Past een foto binnen de lange kant? Nooit vergroten. */
export function fitWithin(width: number, height: number, maxEdge = RECEIPT_MAX_EDGE): { width: number; height: number; scaled: boolean } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scaled: false };
  const factor = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * factor)), height: Math.max(1, Math.round(h * factor)), scaled: true };
}

export function isPdfFile(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function isImageFile(file: { name: string; type: string }): boolean {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name);
}

/**
 * De naam van het bewijsstuk. Een camera noemt elke foto "image.jpg" of een
 * reeks cijfers; in de lijst met bewijsstukken zegt "bon-2026-11-17-1425.jpg"
 * meer. Een pdf houdt zijn eigen naam.
 */
export function receiptFileName(now: Date, extension = 'jpg'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `bon-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.${extension}`;
}

// ── Gerrie aan het werk ──────────────────────────────────────────────────────

/** De stappen in beeld. De eerste twee gebeuren in de app; de rest doet de server in één keer. */
export const RECEIPT_STEPS = ['Foto klaarmaken', 'Versturen', 'Gerrie leest de bon', 'Opslaan als concept'] as const;
export const DECLARATION_STEPS = ['Foto klaarmaken', 'Versturen', 'Gerrie leest de bon', 'Declaratie indienen'] as const;

/**
 * Wat Gerrie intussen doet, in de volgorde waarin het op een bon staat. Dit
 * zijn geen meldingen van de server (die geeft één antwoord); het laat zien
 * waar hij naar kijkt, zodat tien seconden wachten niet als vastlopen voelt.
 */
export const READING_LINES = [
  'Winkel en datum zoeken…',
  'Bedragen en btw lezen…',
  'Btw-tarieven controleren…',
  'Grootboekrekening kiezen…',
  'Bijna klaar…',
] as const;

export function readingLine(elapsedMs: number): string {
  const index = Math.min(READING_LINES.length - 1, Math.floor(Math.max(0, elapsedMs) / 3500));
  return READING_LINES[index];
}

// ── Wat er na het uitlezen te kiezen valt ────────────────────────────────────

/**
 * De uitkomst van één bon voor iemand met Financiën:
 *  - concept    staat klaar; Verder opent het
 *  - supplier   gelezen, maar de winkel is nog geen leverancier: kies of maak er een
 *  - duplicate  deze bon (of dit bestand) is er al
 *  - unread     niet gelezen (AI uit, tegoed op, niets herkend): zelf invullen
 *  - failed     een storing: opnieuw proberen of zelf invullen
 *  - processing nog bezig (verbinding viel weg); verschijnt zo op de werklijst
 */
export type ReceiptOutcomeKind = 'concept' | 'supplier' | 'duplicate' | 'unread' | 'failed' | 'processing';

export function receiptOutcomeKind(item: Pick<PurchaseInvoiceInboxItem, 'status' | 'reason' | 'purchase_invoice_id' | 'proposal'>): ReceiptOutcomeKind {
  switch (item.status) {
    case 'ready':
    case 'booked':
      return item.purchase_invoice_id ? 'concept' : 'unread';
    case 'needs_review':
      return item.reason === 'supplier_unknown' && item.proposal ? 'supplier' : 'unread';
    case 'duplicate':
      return 'duplicate';
    case 'failed':
      return 'failed';
    case 'received':
    case 'processing':
      return 'processing';
    default:
      return 'unread';
  }
}

/** Waarom Gerrie een bon niet las, in gewone woorden. */
export const RECEIPT_UNREAD_REASONS: Record<string, string> = {
  ai_disabled: 'Uitlezen met AI staat uit voor je organisatie (Instellingen → E-mail).',
  ai_declined: 'Gerrie staat voor jou uit, dus hij heeft de bon niet gelezen.',
  ai_unavailable: 'AI is op de server nog niet ingesteld.',
  budget_exhausted: 'Het AI-tegoed van deze maand is op.',
  nothing_extracted: 'Gerrie zag op deze foto geen bon. Is hij scherp, en staat de hele bon erop?',
  extraction_failed: 'Uitlezen mislukte door een storing.',
  processing_error: 'Er ging iets mis bij het verwerken.',
  rate_limited: 'Er kwam ongewoon veel tegelijk binnen.',
  draft_deleted: 'Het concept is verwijderd.',
};

export function receiptUnreadReason(reason: string | null | undefined): string {
  return (reason && RECEIPT_UNREAD_REASONS[reason]) || 'Gerrie heeft deze bon niet kunnen lezen.';
}

// ── Declaraties ──────────────────────────────────────────────────────────────

export const DECLARATION_STATUS_LABELS: Record<DeclarationStatus, string> = {
  processing: 'Wordt gelezen',
  submitted: 'Ingediend',
  approved: 'Goedgekeurd',
  paid: 'Uitbetaald',
  rejected: 'Afgewezen',
};

/** Een korte uitleg onder de status, voor wie niet weet wat er nu gebeurt. */
export const DECLARATION_STATUS_HINTS: Record<DeclarationStatus, string> = {
  processing: 'Gerrie leest de bon nog.',
  submitted: 'Iemand van Financiën kijkt hem na en keurt hem goed.',
  approved: 'Goedgekeurd en geboekt. Je krijgt het bedrag terug.',
  paid: 'Het bedrag is aan je overgemaakt.',
  rejected: 'Niet goedgekeurd.',
};

export function declarationStatusLabel(status: string): string {
  return DECLARATION_STATUS_LABELS[status as DeclarationStatus] ?? status;
}

/** Nog open (bovenaan) of afgehandeld (eronder), nieuwste eerst. */
export function splitDeclarations<T extends { status: string; submitted_at: string }>(items: T[]): { open: T[]; done: T[] } {
  const byDate = (a: T, b: T) => b.submitted_at.localeCompare(a.submitted_at);
  const isOpen = (d: T) => d.status === 'processing' || d.status === 'submitted';
  return { open: items.filter(isOpen).sort(byDate), done: items.filter(d => !isOpen(d)).sort(byDate) };
}

/**
 * Een werklijst-item voor iemand met Financiën: wat voor soort binnenkomst is
 * het? Een envelop voor mail, een camera voor een bon, en bij een declaratie
 * de naam van wie hem indiende.
 */
export function inboxChannelLabel(item: Pick<PurchaseInvoiceInboxItem, 'channel'>, submitter: string | null): string {
  if (item.channel === 'declaration') return `Declaratie van ${submitter || 'een teamlid'}`;
  if (item.channel === 'receipt') return submitter ? `Bon van ${submitter}` : 'Bon uit de app';
  return 'Per e-mail';
}

/** Wacht deze declaratie op goedkeuring? (een concept dat nog niet geboekt is) */
export function declarationAwaitsApproval(item: Pick<PurchaseInvoiceInboxItem, 'channel' | 'status' | 'purchase_invoice_id'>): boolean {
  return item.channel === 'declaration' && item.status === 'ready' && Boolean(item.purchase_invoice_id);
}

/**
 * De knoppen van een declaratie op de werklijst. Goedkeuren boekt het concept
 * (dat is de goedkeuring die de indiener ziet); afwijzen kan zolang hij niet
 * geboekt is, en vraagt altijd een reden. Spiegel van declineAllowed in
 * supabase/functions/_shared/invoiceInboxRules.ts.
 */
export function declarationActionsFor(item: Pick<PurchaseInvoiceInboxItem, 'channel' | 'status' | 'purchase_invoice_id'>): { approve: boolean; decline: boolean } {
  if (item.channel !== 'declaration') return { approve: false, decline: false };
  return {
    approve: declarationAwaitsApproval(item),
    decline: ['received', 'ready', 'needs_review', 'duplicate', 'failed'].includes(item.status),
  };
}

/**
 * Kan iemand dit item zelf invullen? Als Gerrie het niet las (AI uit, tegoed
 * op, niets herkend, een storing) en het bestand bewaard is. Een item dat op
 * een leverancierkeuze wacht, heeft al een voorstel: daar is Klaarzetten de
 * snellere weg.
 */
export function canFillIn(item: Pick<PurchaseInvoiceInboxItem, 'status' | 'reason' | 'purchase_invoice_id' | 'attachments'>): boolean {
  if (item.purchase_invoice_id) return false;
  if (item.status !== 'needs_review' && item.status !== 'failed') return false;
  if (item.status === 'needs_review' && item.reason === 'supplier_unknown') return false;
  return item.attachments.some(a => Boolean(a.storage_key) && (a.kind === 'document' || a.kind === 'body'));
}

/** De korte naam van wie een bon instuurde: het deel vóór de @ van zijn adres. */
export function submitterShortName(email: string | null | undefined): string | null {
  const value = (email ?? '').trim();
  if (!value) return null;
  return value.includes('@') ? value.split('@')[0] : value;
}
