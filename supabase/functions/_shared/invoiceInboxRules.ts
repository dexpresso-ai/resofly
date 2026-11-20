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
  /**
   * De leverancier is eerder door de inbox aangemaakt en nog niet door een mens
   * bevestigd. Dan is "het IBAN klopt" een vergelijking met zichzelf: het IBAN
   * kwam uit een eerdere, ongecontroleerde mail. Wie het inboxadres kent, kon zo
   * met een tweede factuur kosten en voorbelasting laten boeken.
   */
  supplierUnverified?: boolean;
  supplierMatch: string | null;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  lines: Array<{ account_id: string | null; amount_cents: number }>;
  totals: { total_cents: number };
  ibanMismatch?: boolean;
  /** Het IBAN op de factuur is bekend én gelijk aan dat van de leverancier. */
  ibanVerified?: boolean;
  /** Valuta van de factuur. Het grootboek boekt in euro's zonder omrekening. */
  currency?: string | null;
  /**
   * De factuurdatum is onwaarschijnlijk (invoiceDateConcern) of niet gelezen.
   * Een bon waarop 2062 was gelezen in plaats van 2026 werd zonder vraag
   * geboekt als JP-2062-00001: een boekjaar dat niemand ooit opent.
   */
  dateConcern?: string | null;
}): { ok: true } | { ok: false; why: string } {
  if (input.dateConcern) return { ok: false, why: 'de factuurdatum is onwaarschijnlijk of niet gelezen' };
  if (input.supplierCreated) return { ok: false, why: 'de leverancier is nieuw aangemaakt' };
  if (input.supplierUnverified) return { ok: false, why: 'de leverancier is door de inbox aangemaakt en nog niet door iemand bevestigd' };
  if (input.ibanMismatch) return { ok: false, why: 'het IBAN op de factuur wijkt af van het IBAN van deze leverancier' };
  if (!input.supplierMatch || input.supplierMatch === 'name') return { ok: false, why: 'de leverancier is alleen op naam herkend' };
  // Het afzenderadres van een mail is niet geverifieerd (geen DMARC-uitslag van
  // de email-worker), en een e-mailadres in de factuur zet de afzender zelf
  // neer. Daarop alleen boeken we niet vanzelf.
  if (input.supplierMatch === 'email') return { ok: false, why: 'de leverancier is alleen op e-mailadres herkend' };
  // "Het IBAN op de factuur is dat van de leverancier": dat moet dan ook te zien
  // zijn. Een factuur zonder IBAN, of een leverancier zonder bekend IBAN, kan de
  // fraudecontrole niet doorstaan en gaat langs een mens.
  if (!input.ibanVerified) return { ok: false, why: 'het IBAN op de factuur kon niet worden vergeleken met dat van de leverancier' };
  if (input.confidence !== 'high') return { ok: false, why: 'de zekerheid van de uitlezing is niet hoog' };
  if (input.warnings.length) return { ok: false, why: 'er zijn waarschuwingen bij de uitlezing' };
  if (!input.lines.length || input.lines.some((l) => !l.account_id)) return { ok: false, why: 'niet elke regel heeft een grootboekrekening' };
  if (input.totals.total_cents <= 0) return { ok: false, why: 'het totaal is niet positief' };
  // Een bedrag in vreemde valuta zou 1-op-1 als euro's in het grootboek komen.
  if (input.currency && input.currency.trim().toUpperCase() !== 'EUR') return { ok: false, why: 'de factuur is niet in euro\'s' };
  return { ok: true };
}

// ── Inkoop: btw-soorten, totalen en de datum ────────────────────────────────────
//
// Spiegel van src/lib/purchaseInvoice.ts (het formulier en de lijst) en van
// book_purchase_invoice in de database. src/lib/purchaseInvoice.test.ts houdt
// de twee TypeScript-kanten gelijk.

/**
 * Soorten btw-code die op een INKOOPregel horen. Een verkoopcode (ICP, btw
 * verlegd verkoop) op een inkoopregel gaf een boeking die in geen enkele
 * rubriek van de aangifte kwam: "ICP diensten" voor Google Ads sloeg 4b over.
 */
export const PURCHASE_VAT_KINDS = ['standard', 'reduced', 'zero', 'exempt', 'reverse_charge_purchase', 'eu_acquisition', 'import_non_eu', 'kor'];

/**
 * De leverancier rekent geen btw: je geeft hem zelf aan (2a, 4a, 4b) en trekt
 * hem af. Die btw hoort dus niet in het totaal van de factuur. De ICP-soorten
 * staan erbij omdat de database ze tot 20261119180000 zo boekte; een bestaand
 * concept met zo'n code telt dan hetzelfde als de boeking.
 */
export const SELF_ASSESSED_VAT_KINDS = ['reverse_charge_purchase', 'eu_acquisition', 'import_non_eu', 'icp_goods', 'icp_services'];

/**
 * Gewone btw (21% en 9%): alleen hier vul je het btw-bedrag van de leverancier
 * in (vat_cents op de regel). Verlegde btw reken je zelf uit, en bij 0% is er
 * geen btw.
 */
export const DEDUCTIBLE_VAT_KINDS = ['standard', 'reduced'];

/** Hoort deze btw-code op een inkoopregel? Export (3a) is omzet, geen inkoop. */
export function isPurchaseVatCode(code: { kind: string; sales_box?: string | null }): boolean {
  if (!PURCHASE_VAT_KINDS.includes(code.kind)) return false;
  return !(code.kind === 'zero' && code.sales_box === '3a');
}

/**
 * Afronden zoals Postgres: de helft van nul af. Math.round rondt -220,5 af
 * naar -220, de database naar -221; bij een creditnota van de leverancier
 * scheelde het totaal dan een cent met de boeking.
 */
export function roundCents(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export interface PurchaseTotalsLine {
  amount_cents: number;
  vat_rate: number;
  vat_code?: string | null;
  account_id?: string | null;
  /** Het btw-bedrag zoals het op de factuur staat; leeg = grondslag × tarief. */
  vat_cents?: number | null;
}

export interface PurchaseTotals {
  subtotal_cents: number;
  /** De btw die de leverancier in rekening brengt. */
  vat_cents: number;
  /** Wat je de leverancier betaalt; gelijk aan de crediteurenregel (1600) van de boeking. */
  total_cents: number;
  /** Verlegde btw (2a, 4a, 4b): zelf aangeven, niet aan de leverancier betalen. */
  self_assessed_vat_cents: number;
  /** Met de KOR: btw die je niet aftrekt en die bij de kosten komt. */
  non_deductible_vat_cents: number;
}

export interface PurchaseTotalsOptions {
  /** Een regel zonder rekening valt in de database op 4500. */
  fallbackAccountId?: string | null;
  /** De soort van een btw-code; onbekend telt als 'standard', net als in de database. */
  kindOf?: (code: string) => string | null | undefined;
  /** Kleineondernemersregeling: geen aftrek; de btw van de leverancier komt bij de kosten. */
  kor?: boolean;
}

const lineVatCents = (line: PurchaseTotalsLine): number | null => {
  const raw = line.vat_cents;
  if (raw === null || raw === undefined || (raw as unknown) === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
};

/**
 * De totalen van een inkoopfactuur, zoals book_purchase_invoice ze boekt: per
 * (kostenrekening, btw-code, tarief) afgerond en dan opgeteld.
 *
 * Tot 20261119180000 telde de btw altijd bij het totaal. Een verlegde factuur
 * van € 100 toonde dan "BTW € 21,00, totaal € 121,00", terwijl er € 100 op
 * crediteuren kwam; en het btw-bedrag van de leverancier was niet in te
 * voeren, zodat een bon van € 10,00 een concept van € 9,99 werd.
 */
export function purchaseLineTotals(lines: PurchaseTotalsLine[], options: PurchaseTotalsOptions = {}): PurchaseTotals {
  const groups = new Map<string, { base: number; computedBase: number; given: number; rate: number; kind: string }>();
  let subtotal = 0;
  for (const line of lines) {
    const base = Number(line.amount_cents) || 0;
    subtotal += base;
    const rate = Number(line.vat_rate) || 0;
    const code = String(line.vat_code ?? '').trim();
    const kind = (code && options.kindOf ? options.kindOf(code) : null) || 'standard';
    const account = line.account_id || options.fallbackAccountId || '';
    const key = `${account}|${code}|${kind}|${rate}`;
    const group = groups.get(key) ?? { base: 0, computedBase: 0, given: 0, rate, kind };
    // Zoals book_purchase_invoice: het btw-bedrag van de regel telt, behalve
    // bij verlegde btw en bij 0%. Ook met de KOR: je betaalt wat er staat.
    const given = !SELF_ASSESSED_VAT_KINDS.includes(kind) && rate !== 0 ? lineVatCents(line) : null;
    group.base += base;
    if (given === null) group.computedBase += base;
    else group.given += given;
    groups.set(key, group);
  }
  let vat = 0;
  let selfAssessed = 0;
  let nonDeductible = 0;
  groups.forEach((group) => {
    const amount = group.given + roundCents((group.computedBase * group.rate) / 100);
    if (SELF_ASSESSED_VAT_KINDS.includes(group.kind)) { selfAssessed += amount; return; }
    vat += amount;
    if (options.kor) nonDeductible += amount;
  });
  return {
    subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat,
    self_assessed_vat_cents: selfAssessed, non_deductible_vat_cents: nonDeductible,
  };
}

/** Tot zoveel centen verschil is het afronding, daarboven een leesfout. */
export const VAT_ADOPT_TOLERANCE_CENTS = 2;

/**
 * Het btw-bedrag van de bon of factuur overnemen als het een paar cent afwijkt
 * van grondslag × tarief. Een winkel rekent de btw uit het bedrag inclusief
 * (€ 10,00 = € 8,26 + € 1,74); wij rekenden hem uit het bedrag exclusief
 * (€ 8,26 × 21% = € 1,73), en het concept was dan € 9,99: een cent naast de
 * pinbetaling. Het verschil komt als vat_cents op de grootste regel met
 * aftrekbare btw. Is het verschil groter, dan blijft alles zoals het is en
 * waarschuwt de totalencontrole.
 */
export function adoptDocumentVat<T extends PurchaseTotalsLine>(
  lines: T[],
  document: { total_cents?: number | null; vat_cents?: number | null } | null | undefined,
  options: PurchaseTotalsOptions = {},
): { lines: T[]; adopted: boolean } {
  const same = { lines, adopted: false };
  if (!document) return same;
  const target = (totals: PurchaseTotals): number | null => {
    if (document.total_cents !== null && document.total_cents !== undefined) return document.total_cents - totals.total_cents;
    if (document.vat_cents !== null && document.vat_cents !== undefined) return document.vat_cents - totals.vat_cents;
    return null;
  };
  const before = purchaseLineTotals(lines, options);
  const diff = target(before);
  if (diff === null || diff === 0 || Math.abs(diff) > VAT_ADOPT_TOLERANCE_CENTS) return same;
  // Staat het btw-bedrag er ook op, dan moet het verschil dáár zitten. Zit de
  // cent in het bedrag exclusief, dan trekken we geen btw af die er niet staat.
  if (document.total_cents !== null && document.total_cents !== undefined
    && document.vat_cents !== null && document.vat_cents !== undefined
    && before.vat_cents + diff !== document.vat_cents) return same;

  let index = -1;
  lines.forEach((line, i) => {
    const code = String(line.vat_code ?? '').trim();
    const kind = (code && options.kindOf ? options.kindOf(code) : null) || 'standard';
    if (!DEDUCTIBLE_VAT_KINDS.includes(kind) || !(Number(line.vat_rate) > 0) || !Number(line.amount_cents)) return;
    if (index < 0 || Math.abs(Number(line.amount_cents)) > Math.abs(Number(lines[index].amount_cents))) index = i;
  });
  if (index < 0) return same;

  const own = lineVatCents(lines[index]) ?? roundCents((Number(lines[index].amount_cents) * Number(lines[index].vat_rate)) / 100);
  const withVat = (value: number) => lines.map((line, i) => (i === index ? { ...line, vat_cents: value } : line));
  // De regel valt nu buiten de afronding van zijn groep; de rest van de groep
  // kan daardoor een cent verspringen. Daarom één keer narekenen en bijstellen.
  let next = withVat(own + diff);
  const rest = target(purchaseLineTotals(next, options));
  if (rest) next = withVat(own + diff + rest);
  if (target(purchaseLineTotals(next, options)) !== 0) return same;
  return { lines: next, adopted: true };
}

export interface InvoiceDateConcern { kind: 'future' | 'before_start' | 'old'; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateNl = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** Vandaag in Nederland als JJJJ-MM-DD (de server draait op UTC). */
export function todayInAmsterdam(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Is deze factuurdatum onwaarschijnlijk? In de toekomst, vóór de startdatum
 * van de boekhouding, of meer dan een jaar terug. Een bon met 2062 in plaats
 * van 2026 werd zonder vraag in boekjaar 2062 geboekt, en een bon van vóór de
 * start kwam in een jaar dat al in het oude pakket was afgesloten.
 */
export function invoiceDateConcern(
  date: string | null | undefined,
  options: { today: string; bookkeepingStart?: string | null },
): InvoiceDateConcern | null {
  if (!date || !ISO_DATE.test(date) || !ISO_DATE.test(options.today)) return null;
  if (date > options.today) {
    return { kind: 'future', message: `De factuurdatum ${dateNl(date)} ligt in de toekomst. Controleer de dag en het jaar.` };
  }
  const start = options.bookkeepingStart && ISO_DATE.test(options.bookkeepingStart) ? options.bookkeepingStart : null;
  if (start && date < start) {
    return {
      kind: 'before_start',
      message: `De factuurdatum ${dateNl(date)} ligt vóór de startdatum van je boekhouding (${dateNl(start)}). Klopt de datum, dan komt de boeking als nagekomen post op de startdatum.`,
    };
  }
  const yearAgo = `${String(Number(options.today.slice(0, 4)) - 1).padStart(4, '0')}${options.today.slice(4)}`;
  if (date < yearAgo) {
    return { kind: 'old', message: `De factuurdatum ${dateNl(date)} is meer dan een jaar geleden. Controleer het jaar.` };
  }
  return null;
}

/**
 * Welke 0%-code krijgt een inkoopregel zonder btw? Nooit "Export buiten EU":
 * dat is een verkoopcode, en hij stond bij gelijk tarief vooraan omdat de
 * codes op alfabet komen (EXPORT vóór NUL).
 */
export function pickZeroPurchaseCode<T extends { code: string; kind: string; sales_box?: string | null }>(codes: T[]): T | undefined {
  const zero = codes.filter((v) => v.kind === 'zero' && v.sales_box !== '3a' && !/export/i.test(v.code));
  return zero.find((v) => v.code === 'NUL') ?? zero[0];
}

/**
 * Mag "Negeren" het concept van dit item weggooien? Alleen een concept dat
 * nooit geboekt is: bij een tegengeboekt concept verwijzen de boekstukken
 * ernaar, en dan blijft het met zijn bewijsstuk bewaard (bewaarplicht). De
 * foto zelf blijft altijd bij het item.
 */
export function discardDraftAllowed(input: {
  channel: string | null;
  invoiceStatus: string | null;
  journalEntries: number;
}): { ok: true } | { ok: false; why: string } {
  if (input.channel === 'declaration') return { ok: false, why: 'Een declaratie wijs je af met een reden (Afwijzen), zodat de indiener weet waarom.' };
  if (input.invoiceStatus && input.invoiceStatus !== 'draft') {
    return { ok: false, why: 'Deze factuur is al geboekt. Boek eerst de journaalpost tegen (Grootboek → Journaal) als hij niet klopt.' };
  }
  if (input.journalEntries > 0) {
    return { ok: false, why: 'Dit concept is eerder geboekt en tegengeboekt. De boekstukken verwijzen ernaar, dus het blijft met zijn bewijsstuk bewaard. Verbeter het en boek het opnieuw.' };
  }
  return { ok: true };
}

// ── Bonnen en declaraties (in de app gefotografeerd) ────────────────────────────
//
// Een bon komt niet per mail maar uit de camera van een teamlid. Wie Financiën
// mag bewerken, krijgt een concept dat hij zelf boekt ('receipt'); wie dat niet
// mag, dient een declaratie in die iemand met Financiën goedkeurt
// ('declaration'). Migratie 20261118120000.

export type InboxChannel = 'email' | 'receipt' | 'declaration';

/** Foto's en pdf-scans. Een e-factuur (XML) gaat via "Factuur scannen" of het factuuradres. */
export const UPLOAD_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** Ruim boven wat een mens met de hand fotografeert, ver onder een AI-rekening die uit de hand loopt. */
export const MAX_UPLOADS_PER_HOUR = 60;

/** Het kanaal volgt uit de rechten van wie de foto maakt, nooit uit de invoer. */
export function uploadChannelFor(financeLevel: 'none' | 'read' | 'write'): 'receipt' | 'declaration' {
  return financeLevel === 'write' ? 'receipt' : 'declaration';
}

export function isUploadChannel(channel: string | null | undefined): channel is 'receipt' | 'declaration' {
  return channel === 'receipt' || channel === 'declaration';
}

/** Mag dit bestand via "Bon fotograferen"? Op type, met de extensie als terugval. */
export function isUploadableReceipt(name: string, mimeType: string): boolean {
  const mime = normalizeDocumentMime(name, mimeType);
  return UPLOAD_MIME_TYPES.includes(mime);
}

/**
 * Zijn de bytes ook echt wat het type zegt? Een browser zet het type op
 * grond van de extensie; een hernoemd bestand (bon.jpg dat een HEIC is, of
 * een tekstbestand) kwam anders pas bij het model als fout terug, nadat het
 * al op R2 stond.
 */
export function bytesMatchType(bytes: Uint8Array, mimeType: string): boolean {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  switch (mimeType) {
    case 'image/jpeg': return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    case 'image/png': return at(0) === 0x89 && ascii(1, 'PNG');
    case 'image/webp': return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'application/pdf': {
      // De pdf-standaard staat toe dat de kop niet helemaal vooraan staat
      // (binnen de eerste 1024 bytes); sommige scanners doen dat ook.
      const head = Math.min(bytes.length, 1024);
      for (let i = 0; i + 4 <= head; i += 1) if (ascii(i, '%PDF')) return true;
      return false;
    }
    default: return false;
  }
}

/**
 * Heeft deze persoon de AI uitgezet? Een eigen "nee" tegen Gerrie (een rij in
 * ai_consents met enabled = false) of de module Gerrie dichtgezet door een
 * beheerder: dan gaat zijn bon niet langs het model. "Nog niet gekozen" telt
 * niet als nee: wie op "Bon fotograferen" drukt, vraagt Gerrie om deze ene bon
 * te lezen, zoals "Factuur scannen" dat altijd deed.
 */
export function aiRefusedBy(input: { consentEnabled: boolean | null; gerrieLevel: 'none' | 'read' | 'write' }): boolean {
  if (input.gerrieLevel === 'none') return true;
  return input.consentEnabled === false;
}

export type DeclarationStatus = 'processing' | 'submitted' | 'approved' | 'paid' | 'rejected';

/**
 * De status zoals de indiener hem leest. Spiegel van list_my_declarations: wat
 * bij Financiën op een keuze wacht (dubbel, leverancier onbekend, mislukt),
 * is voor de indiener gewoon "ingediend".
 */
export function declarationStatus(
  inboxStatus: string,
  invoice: { status: string | null; payment_status: string | null } | null,
): DeclarationStatus {
  if (inboxStatus === 'received' || inboxStatus === 'processing') return 'processing';
  if (inboxStatus === 'rejected') return 'rejected';
  if (invoice && (invoice.status === 'paid' || invoice.payment_status === 'paid')) return 'paid';
  if (inboxStatus === 'booked' || invoice?.status === 'booked') return 'approved';
  return 'submitted';
}

export interface DeclarationView {
  id: string;
  status: DeclarationStatus;
  store_name: string | null;
  receipt_date: string | null;
  total_cents: number | null;
  currency: string;
  /** Heeft Gerrie er een bon in gelezen (winkel of bedrag)? */
  read: boolean;
}

/**
 * Wat de indiener na het insturen terugkrijgt: alleen zijn eigen bon. Bewust
 * zonder waarschuwingen, reden, leverancier-id of concept-id: een waarschuwing
 * kan een andere factuur noemen ("staat al als INK-2026-0012") of het IBAN dat
 * bij een leverancier bekend is, en dat gaat een declarant niet aan.
 */
export function declarationView(row: {
  id: string;
  status: string;
  proposal: { supplier?: { name?: string | null } | null; date?: string | null; currency?: string | null; totals?: { total_cents?: number | null } | null } | null;
}): DeclarationView {
  const p = row.proposal;
  const store = (p?.supplier?.name ?? '').trim() || null;
  const total = typeof p?.totals?.total_cents === 'number' && Number.isFinite(p.totals.total_cents) ? Math.round(p.totals.total_cents) : null;
  const date = typeof p?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null;
  return {
    id: row.id,
    status: declarationStatus(row.status, null),
    store_name: store,
    receipt_date: date,
    total_cents: total,
    currency: ((p?.currency ?? '').trim() || 'EUR').toUpperCase().slice(0, 3),
    read: Boolean(store || (total != null && total !== 0)),
  };
}

/** Waarin een declaratie nog af te wijzen is: alles wat niet geboekt, al afgewezen of nog bezig is. */
export const DECLINABLE_STATUSES = ['received', 'ready', 'needs_review', 'duplicate', 'failed'];

export function declineAllowed(row: { channel: string | null; status: string }): { ok: true } | { ok: false; why: string } {
  if (row.channel !== 'declaration') return { ok: false, why: 'Alleen een declaratie wijs je af. Een bon of mail leg je weg met Negeren.' };
  if (row.status === 'booked') return { ok: false, why: 'Deze declaratie is al goedgekeurd en geboekt. Terugdraaien kan alleen met een tegenboeking.' };
  if (row.status === 'rejected') return { ok: false, why: 'Deze declaratie is al afgewezen.' };
  if (row.status === 'processing') return { ok: false, why: 'Deze declaratie wordt nog uitgelezen. Probeer het zo opnieuw.' };
  if (!DECLINABLE_STATUSES.includes(row.status)) return { ok: false, why: `Een declaratie in status '${row.status}' kan niet afgewezen worden.` };
  return { ok: true };
}

/**
 * Twee bonnen van dezelfde winkel, op dezelfde dag, voor hetzelfde bedrag: dat
 * is vaak twee keer dezelfde bon (twee foto's van één bonnetje hebben elk een
 * eigen bestand, dus de bestandscontrole ziet het niet). Soms is het echt twee
 * keer parkeren. Daarom een waarschuwing op het concept, geen blokkade.
 */
export function receiptTwinWarning(twin: { internal_number: string | null; supplier_invoice_number: string | null } | null): string | null {
  if (!twin) return null;
  const label = twin.internal_number || twin.supplier_invoice_number || 'een andere inkoopfactuur';
  return `Lijkt op ${label}: zelfde winkel, datum en bedrag. Controleer dat deze bon niet twee keer is ingestuurd.`;
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
