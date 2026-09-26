// ============================================================
// De REGELS van de factuur-inbox — zonder imports, zodat `node --test` ze draait.
//
// Alles wat een beslissing is en geen I/O: welke bijlage een factuur kan zijn,
// of een uitgelezen voorstel op een factuur lijkt, of twee bijlagen dezelfde
// factuur zijn, of er automatisch geboekt mag worden, welk item de opruimronde
// opnieuw mag proberen en wanneer bijlagen van een afgedaan item weg mogen.
// invoiceInbox.ts (Deno) voert ze uit; invoiceInboxRules.test.ts bewaakt ze.
// ============================================================

export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const XML_MIME_TYPES = ['application/xml', 'text/xml'];
const DOCUMENT_EXT = /\.(pdf|xml|jpe?g|png|webp|gif)$/i;

export type InboxAttachmentKind = 'document' | 'copy' | 'body' | 'other' | 'oversized' | 'unsupported' | 'skipped';

export function isXmlFile(fileName: string, mimeType: string): boolean {
  return XML_MIME_TYPES.includes((mimeType || '').toLowerCase()) || (fileName || '').toLowerCase().endsWith('.xml');
}

/** Kan dit bestand een factuur zijn die we kunnen uitlezen? */
export function isDocumentAttachment(name: string, mimeType: string): boolean {
  const mime = (mimeType || '').toLowerCase();
  if (DOCUMENT_MIME_TYPES.includes(mime)) return true;
  if (isXmlFile(name, mime)) return true;
  return DOCUMENT_EXT.test(name || '');
}

/** MIME-type normaliseren op extensie (mailclients sturen soms application/octet-stream). */
export function normalizeDocumentMime(name: string, mimeType: string): string {
  const mime = (mimeType || '').toLowerCase();
  if (DOCUMENT_MIME_TYPES.includes(mime) || XML_MIME_TYPES.includes(mime)) return mime;
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.xml')) return 'application/xml';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return mime || 'application/octet-stream';
}

/** Bestandsnaam die in een R2-sleutel past (zie isSafeStorageKey in de media-worker). */
export function safeFileName(name: string): string {
  const cleaned = (name || 'bijlage').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 120);
  return cleaned || 'bijlage';
}

// ── Normalisatie ────────────────────────────────────────────────────────────────

export const normVat = (s: string | null | undefined) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normIban = (s: string | null | undefined) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normName = (s: string | null | undefined) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export const normEmail = (s: string | null | undefined) => (s || '').toLowerCase().trim();
export const normNumber = (s: string | null | undefined) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── Is dit een factuur? ─────────────────────────────────────────────────────────

export interface ProposalLike {
  supplier: { name: string };
  supplier_invoice_number: string | null;
  lines: unknown[];
  totals: { total_cents: number };
  extracted_totals: { total_cents: number | null } | null;
}

/** Ziet dit voorstel eruit als een factuur (en niet als een brief of een logo)? */
export function looksLikeInvoice(proposal: ProposalLike): boolean {
  if (!proposal.lines.length) return false;
  const total = proposal.totals.total_cents || proposal.extracted_totals?.total_cents || 0;
  return total !== 0;
}

const INVOICE_WORDS = /\b(factuur|invoice|rechnung|facture|totaal|total|btw|vat|te betalen|amount due|bedrag|iban|vervaldatum|due date)\b/i;
const AMOUNT = /(€|eur\b|\$)\s?\d|(?<!\d)\d{1,3}(?:[.,]\d{3})*[.,]\d{2}(?!\d)/i;

/**
 * Staat de factuur in de mailtekst zelf? Bewust streng: een AI-call kost geld
 * en een gewone mail ("hierbij onze factuur, zie bijlage") noemt het woord
 * factuur ook. Er moet een bedrag ín staan én genoeg tekst om regels uit te halen.
 */
export function looksLikeInvoiceText(text: string | null | undefined): boolean {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 160) return false;
  if (!INVOICE_WORDS.test(value)) return false;
  if (!AMOUNT.test(value)) return false;
  // Eén bedrag is een "kosten: € 50"-zin; een factuur heeft er meerdere.
  const amounts = value.match(/(?<!\d)\d{1,3}(?:[.,]\d{3})*[.,]\d{2}(?!\d)/g) ?? [];
  return amounts.length >= 2;
}

/** Dezelfde factuur, twee keer bijgevoegd? Op nummer, anders op leverancier + totaal. */
export function sameInvoice(a: ProposalLike, b: ProposalLike): boolean {
  const na = normNumber(a.supplier_invoice_number);
  const nb = normNumber(b.supplier_invoice_number);
  if (na && nb) return na === nb && normName(a.supplier.name) === normName(b.supplier.name);
  return normName(a.supplier.name) === normName(b.supplier.name)
    && Math.abs((a.totals.total_cents || 0) - (b.totals.total_cents || 0)) <= 2;
}

/**
 * Automatisch boeken mag alleen als er niets meer te kiezen of te controleren
 * valt: bekende leverancier (niet zojuist aangemaakt, niet alleen op naam),
 * hoge zekerheid, geen enkele waarschuwing, elke regel met een grootboekrekening,
 * positief totaal — en het IBAN op de factuur is dat van de leverancier. Een
 * ander rekeningnummer op een verder bekende factuur is hét patroon van
 * factuurfraude; dat moet een mens zien.
 */
export function autoBookEligible(input: {
  supplierCreated: boolean;
  supplierMatch: string | null;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  lines: Array<{ account_id: string | null; amount_cents: number }>;
  totals: { total_cents: number };
  ibanMismatch?: boolean;
}): { ok: true } | { ok: false; why: string } {
  if (input.supplierCreated) return { ok: false, why: 'de leverancier is nieuw aangemaakt' };
  if (input.ibanMismatch) return { ok: false, why: 'het IBAN op de factuur wijkt af van het IBAN van deze leverancier' };
  if (!input.supplierMatch || input.supplierMatch === 'name') return { ok: false, why: 'de leverancier is alleen op naam herkend' };
  if (input.confidence !== 'high') return { ok: false, why: 'de zekerheid van de uitlezing is niet hoog' };
  if (input.warnings.length) return { ok: false, why: 'er zijn waarschuwingen bij de uitlezing' };
  if (!input.lines.length || input.lines.some((l) => !l.account_id)) return { ok: false, why: 'niet elke regel heeft een grootboekrekening' };
  if (input.totals.total_cents <= 0) return { ok: false, why: 'het totaal is niet positief' };
  return { ok: true };
}

// ── De opruimronde ──────────────────────────────────────────────────────────────

export interface SweepRowLike {
  status: string;
  reason: string | null;
  attempts: number;
  processing_started_at: string | null;
  updated_at: string;
}

export const MAX_AUTOMATIC_ATTEMPTS = 4;
const STALE_PROCESSING_MS = 10 * 60_000;
const NEVER_STARTED_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const RETRYABLE_FAILED = ['processing_error', 'extraction_failed'];
const RETRYABLE_REVIEW = ['ai_unavailable', 'budget_exhausted', 'rate_limited'];

/**
 * Mag de opruimronde dit item opnieuw proberen? Alleen wat door een STORING
 * bleef liggen — nooit iets waar een mens over moet beslissen (leverancier
 * onbekend, dubbel, geen bijlage), en nooit eindeloos.
 */
export function retryEligibility(row: SweepRowLike, now: Date): { retry: boolean; why: string } {
  const age = now.getTime() - new Date(row.updated_at).getTime();
  if (row.attempts >= MAX_AUTOMATIC_ATTEMPTS && row.status !== 'processing') {
    return { retry: false, why: 'maximum aantal automatische pogingen bereikt' };
  }
  switch (row.status) {
    case 'received':
      return age >= NEVER_STARTED_MS
        ? { retry: true, why: 'verwerking is nooit gestart' }
        : { retry: false, why: 'net ontvangen' };
    case 'processing': {
      const started = row.processing_started_at ? new Date(row.processing_started_at).getTime() : 0;
      return (now.getTime() - started) >= STALE_PROCESSING_MS
        ? { retry: true, why: 'verwerking is blijven hangen' }
        : { retry: false, why: 'wordt verwerkt' };
    }
    case 'failed':
      return RETRYABLE_FAILED.includes(row.reason ?? '')
        ? { retry: true, why: `mislukt door een storing (${row.reason})` }
        : { retry: false, why: 'mislukt om een blijvende reden' };
    case 'needs_review':
      if (!RETRYABLE_REVIEW.includes(row.reason ?? '')) return { retry: false, why: 'wacht op een mens' };
      if (row.reason === 'rate_limited' && age < RATE_LIMIT_COOLDOWN_MS) return { retry: false, why: 'limiet nog van kracht' };
      return { retry: true, why: `tijdelijk niet verwerkt (${row.reason})` };
    default:
      return { retry: false, why: 'niets te doen' };
  }
}

export interface PurgeRowLike {
  status: string;
  purged_at: string | null;
  purchase_invoice_id: string | null;
  updated_at: string;
  attachments: Array<{ storage_key: string | null }>;
}

const PURGE_AFTER_MS: Record<string, number> = {
  rejected: 30 * 86_400_000,
  dropped: 30 * 86_400_000,
  duplicate: 90 * 86_400_000,
};

/**
 * Mogen de R2-bestanden van dit item weg? Alleen van items die niets hebben
 * opgeleverd (genegeerd, weggegooid, dubbel) en dat al een tijd zijn. Alles wat
 * aan een concept hangt is een bewijsstuk en blijft — dat is de bewaarplicht.
 */
export function purgeEligible(row: PurgeRowLike, now: Date): boolean {
  if (row.purged_at || row.purchase_invoice_id) return false;
  const wait = PURGE_AFTER_MS[row.status];
  if (wait === undefined) return false;
  if (!row.attachments.some((a) => a.storage_key)) return false;
  return now.getTime() - new Date(row.updated_at).getTime() >= wait;
}
