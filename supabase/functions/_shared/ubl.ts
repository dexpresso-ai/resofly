// ============================================================
// UBL 2.1 e-facturatie (Peppol BIS Billing 3.0, NL-regels) — gedeelde module.
//
// Twee verantwoordelijkheden, met de categorie-/landlogica en het
// centenrekenwerk die de parser (ublParse.ts) hier vandaan haalt:
//  1. buildUblXml()      — verkoopfactuur/creditnota -> UBL 2.1 XML-string,
//                          desgewenst mét de PDF erin (AdditionalDocumentReference).
//  2. validateUblInput() — NL-foutenlijst VÓÓR generatie (ontbrekende KVK,
//                          adres, IBAN, btw-nummer bij verlegd/ICP, …).
// De parser voor inkomende UBL staat sinds de e-facturatie per klant in
// ublParse.ts: hij heeft als enige een externe import, en zonder die import
// is deze module in node te testen (ubl.test.ts).
//
// Normkeuzes:
//  - CustomizationID = Peppol BIS Billing 3.0. De Peppol-schematron bevat de
//    NL-regels (NL-R-001 t/m NL-R-009) die voor Nederlandse verkopers gelden;
//    de rule test gebruikt starts-with(), dus deze waarde is ook geldig voor
//    NLCIUS-conforme ontvangers.
//  - Bedragen: intern in hele CENTEN (round half away from zero), btw per
//    TARIEFGROEP afgerond — exact dezelfde conventie als calculateTotals in
//    invoice-workflow en src/lib/money.ts, zodat XML, PDF en betaallink
//    hetzelfde totaal tonen én BR-CO-10/13/15 en BR-S-08/BR-CO-17 sluiten.
//  - Builder/validator zijn pure functies (patroon _shared/dunning.ts).
//  - De factuur-PDF gaat als ingesloten bijlage mee (BT-122..BT-125), zodat
//    de ontvanger hem in zijn boekhoudpakket naast de gestructureerde
//    gegevens ziet. Toegestane MIME-typen: de Peppol-lijst hieronder.
// ============================================================

// Peppol BIS Billing 3.0 (bevat de NL-R-regels; geverifieerd tegen
// docs.peppol.eu PEPPOL-EN16931-R004/R007, 2026-07).
export const UBL_CUSTOMIZATION_ID = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
export const UBL_PROFILE_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

// EN 16931 btw-categorieën die deze module ondersteunt (BT-151).
export type UblVatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G';

export interface UblParty {
  name: string;
  tradeName?: string | null;
  vatNumber?: string | null;
  kvkNumber?: string | null;
  /** Vrije tekst ('Nederland') of ISO-code ('NL') — wordt genormaliseerd. */
  country?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  email?: string | null;
  /**
   * Elektronisch adres als er geen Peppol-ID (KVK, OIN, btw-nummer) af te leiden
   * is: dan wordt dit het EndpointID met schemeID EM. Bij een klant met
   * e-facturatie is dat het e-factuuradres, want daar gaat de e-factuur heen.
   */
  endpointEmail?: string | null;
}

/**
 * Ingesloten bijlage (BT-122..BT-125), bijvoorbeeld de factuur-PDF. Peppol staat
 * alleen de MIME-typen uit UBL_ATTACHMENT_MIME_CODES toe; de inhoud gaat als
 * base64 in cbc:EmbeddedDocumentBinaryObject.
 */
export interface UblEmbeddedDocument {
  /** BT-122 — referentie van de bijlage, bv. het factuurnummer. */
  id: string;
  /** BT-123 — korte omschrijving, bv. "Factuur 2026-014 (PDF)". */
  description?: string | null;
  /** BT-125-2 — bestandsnaam. */
  fileName: string;
  /** BT-125-1 — MIME-type. */
  mimeCode: string;
  /** De inhoud als base64, zonder data:-voorvoegsel. */
  base64: string;
}

/** Peppol BIS Billing 3.0: toegestane MIME-typen voor een ingesloten bijlage. */
export const UBL_ATTACHMENT_MIME_CODES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
] as const;

export interface UblLine {
  description: string;
  quantity: number;
  /** Prijs per eenheid in EURO'S, excl. btw. */
  unitPrice: number;
  /** Btw-percentage (alleen relevant voor categorie S). */
  vatRate: number;
  category: UblVatCategory;
  exemptionReason?: string | null;
}

export interface UblDocumentInput {
  docType: 'invoice' | 'creditNote';
  number: string;
  issueDate: string; // YYYY-MM-DD
  dueDate?: string | null;
  currency: string;
  note?: string | null;
  /** BT-10 — Peppol verplicht een koperreferentie óf orderreferentie. */
  buyerReference: string;
  /** Creditnota: referentie naar de oorspronkelijke factuur (NL-R-001). */
  originalInvoiceNumber?: string | null;
  originalInvoiceDate?: string | null;
  /** Betalingskenmerk (BT-83) — meestal het factuurnummer. */
  paymentReference?: string | null;
  paymentTermsNote?: string | null;
  sellerIban?: string | null;
  seller: UblParty;
  buyer: UblParty;
  /** Consument-koper: KVK/btw-eisen worden dan niet als gebrek gemeld. */
  buyerIsConsumer?: boolean;
  lines: UblLine[];
  /** Ingesloten bijlagen — in de praktijk de factuur-PDF zelf. */
  attachments?: UblEmbeddedDocument[];
}

export interface UblValidationResult {
  /** Blokkerend: zonder deze gegevens is de XML ongeldig of misleidend. */
  errors: string[];
  /** Niet blokkerend: de XML wordt gemaakt, maar Peppol-validatie kan klagen. */
  warnings: string[];
}

// ── Landnormalisatie ───────────────────────────────────────────────────────────
// country is in dit systeem vrije tekst (default 'Nederland'); UBL eist ISO
// 3166-1 alpha-2. Onbekende invoer levert null -> validatiefout met duidelijke
// melding, nooit een gok.
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  'nederland': 'NL', 'the netherlands': 'NL', 'netherlands': 'NL', 'holland': 'NL',
  'belgie': 'BE', 'belgië': 'BE', 'belgium': 'BE', 'belgique': 'BE',
  'duitsland': 'DE', 'germany': 'DE', 'deutschland': 'DE',
  'frankrijk': 'FR', 'france': 'FR',
  'luxemburg': 'LU', 'luxembourg': 'LU',
  'verenigd koninkrijk': 'GB', 'united kingdom': 'GB', 'engeland': 'GB', 'uk': 'GB', 'groot-brittannie': 'GB', 'groot-brittannië': 'GB',
  'spanje': 'ES', 'spain': 'ES', 'espana': 'ES', 'españa': 'ES',
  'italie': 'IT', 'italië': 'IT', 'italy': 'IT', 'italia': 'IT',
  'oostenrijk': 'AT', 'austria': 'AT', 'osterreich': 'AT', 'österreich': 'AT',
  'ierland': 'IE', 'ireland': 'IE',
  'denemarken': 'DK', 'denmark': 'DK',
  'zweden': 'SE', 'sweden': 'SE',
  'noorwegen': 'NO', 'norway': 'NO',
  'polen': 'PL', 'poland': 'PL',
  'portugal': 'PT',
  'finland': 'FI',
  'griekenland': 'GR', 'greece': 'GR',
  'tsjechie': 'CZ', 'tsjechië': 'CZ', 'czech republic': 'CZ', 'czechia': 'CZ',
  'hongarije': 'HU', 'hungary': 'HU',
  'roemenie': 'RO', 'roemenië': 'RO', 'romania': 'RO',
  'bulgarije': 'BG', 'bulgaria': 'BG',
  'kroatie': 'HR', 'kroatië': 'HR', 'croatia': 'HR',
  'slovenie': 'SI', 'slovenië': 'SI', 'slovenia': 'SI',
  'slowakije': 'SK', 'slovakia': 'SK',
  'estland': 'EE', 'estonia': 'EE',
  'letland': 'LV', 'latvia': 'LV',
  'litouwen': 'LT', 'lithuania': 'LT',
  'malta': 'MT',
  'cyprus': 'CY',
  'zwitserland': 'CH', 'switzerland': 'CH', 'schweiz': 'CH',
  'verenigde staten': 'US', 'united states': 'US', 'usa': 'US', 'amerika': 'US',
};

/** Normaliseert een landnaam of -code naar ISO 3166-1 alpha-2, of null. */
export function normalizeCountryCode(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return COUNTRY_NAME_TO_ISO[value.toLowerCase()] ?? null;
}

// ── Identifier-normalisatie ────────────────────────────────────────────────────

const normalizeVat = (raw: string | null | undefined): string => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normalizeIban = (raw: string | null | undefined): string => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normalizeKvk = (raw: string | null | undefined): string => String(raw ?? '').replace(/\D/g, '');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Een Belgisch ondernemingsnummer (KBO, 10 cijfers) in het KVK-veld van een
 * Belgische partij: dat is schema 0208, niet het Nederlandse 0106.
 */
function isBelgianEnterpriseNumber(party: Pick<UblParty, 'country'>, kvk: string): boolean {
  return kvk.length === 10 && normalizeCountryCode(party.country) === 'BE';
}

/**
 * Peppol-ID (BT-34/BT-49) afleiden: KVK (0106) of OIN (0190, 20 cijfers) heeft
 * voorrang; dan het NL-btw-nummer (9944). Voor een Belgische partij het
 * ondernemingsnummer (0208) — het schema waarmee Belgische bedrijven sinds de
 * B2B-plicht van 2026 op Peppol staan — uit het KVK-veld of het BE-btw-nummer.
 * Is er niets af te leiden, dan null.
 */
export function derivePeppolEndpoint(party: Pick<UblParty, 'kvkNumber' | 'vatNumber' | 'country'>): { schemeId: string; value: string } | null {
  const kvk = normalizeKvk(party.kvkNumber);
  if (isBelgianEnterpriseNumber(party, kvk)) return { schemeId: '0208', value: kvk };
  if (kvk.length === 20) return { schemeId: '0190', value: kvk };
  if (kvk.length >= 8) return { schemeId: '0106', value: kvk };
  const vat = normalizeVat(party.vatNumber);
  if (vat.startsWith('NL') && vat.length >= 12) return { schemeId: '9944', value: vat };
  const belgian = /^BE(\d{9,10})$/.exec(vat);
  if (belgian) return { schemeId: '0208', value: belgian[1].padStart(10, '0') };
  return null;
}

/**
 * Het elektronisch adres in de XML: het Peppol-ID, of anders het e-mailadres
 * waarop de e-factuur binnenkomt (schemeID EM). Zonder allebei geen endpoint —
 * dat levert een waarschuwing op, geen fout, want een download heeft hem niet
 * nodig.
 */
function deriveElectronicAddress(party: UblParty): { schemeId: string; value: string } | null {
  const peppol = derivePeppolEndpoint(party);
  if (peppol) return peppol;
  const email = String(party.endpointEmail ?? '').trim().toLowerCase();
  return EMAIL_PATTERN.test(email) ? { schemeId: 'EM', value: email } : null;
}

// ── Btw-categorie afleiden uit verkoopregels ───────────────────────────────────

export interface VatKindRef { kind: string; rate: number }

const EXEMPTION_REASONS: Partial<Record<UblVatCategory, string>> = {
  E: 'Vrijgesteld van btw',
  AE: 'Btw verlegd',
  K: 'Intracommunautaire levering, btw verlegd naar afnemer',
  G: 'Export buiten de EU, 0% btw',
};
const KOR_EXEMPTION_REASON = 'Vrijgesteld van omzetbelasting (kleineondernemersregeling)';

/**
 * FinanceLine ({vat, vat_code?}) -> UBL-categorie. De mapping loopt op de KIND
 * van de organisatie-eigen btw-code (nooit op de code-string: gebruikers kunnen
 * eigen codes aanmaken). Zonder code valt hij terug op het tarief: >0 -> S,
 * 0 -> Z (of E bij KOR). Inkoop-kinds op een verkoopregel zijn een fout in de
 * invoer en leveren een waarschuwing + tarief-fallback op.
 */
export function deriveSalesLineCategory(
  line: { vat: number; vat_code?: string | null },
  vatKindByCode: Record<string, VatKindRef>,
  korEnabled: boolean,
): { category: UblVatCategory; vatRate: number; exemptionReason: string | null; warning: string | null } {
  const rate = Number(line.vat) || 0;
  const code = String(line.vat_code ?? '').trim();
  const ref = code ? vatKindByCode[code] : undefined;
  if (ref) {
    switch (ref.kind) {
      case 'standard':
      case 'reduced':
        return { category: 'S', vatRate: rate, exemptionReason: null, warning: null };
      case 'zero':
        return { category: 'Z', vatRate: 0, exemptionReason: null, warning: null };
      case 'exempt':
        return { category: 'E', vatRate: 0, exemptionReason: EXEMPTION_REASONS.E!, warning: null };
      case 'kor':
        return { category: 'E', vatRate: 0, exemptionReason: KOR_EXEMPTION_REASON, warning: null };
      case 'reverse_charge_sales':
        return { category: 'AE', vatRate: 0, exemptionReason: EXEMPTION_REASONS.AE!, warning: null };
      case 'icp_goods':
      case 'icp_services':
        return { category: 'K', vatRate: 0, exemptionReason: EXEMPTION_REASONS.K!, warning: null };
      default:
        // reverse_charge_purchase / eu_acquisition horen op inkoop, niet verkoop.
        return {
          category: rate > 0 ? 'S' : 'Z', vatRate: rate, exemptionReason: null,
          warning: `Btw-code '${code}' (${ref.kind}) is een inkoopcode en hoort niet op een verkoopregel; teruggevallen op het tarief.`,
        };
    }
  }
  if (rate > 0) return { category: 'S', vatRate: rate, exemptionReason: null, warning: null };
  if (korEnabled) return { category: 'E', vatRate: 0, exemptionReason: KOR_EXEMPTION_REASON, warning: null };
  return { category: 'Z', vatRate: 0, exemptionReason: null, warning: null };
}

// ── Geldrekenwerk (identiek aan calculateTotals in invoice-workflow) ───────────

/** Euro -> hele centen, round half away from zero. Ook voor de parser (ublParse.ts). */
export function toCents(euros: number): number {
  if (!Number.isFinite(euros)) return 0;
  const scaled = euros * 100;
  return scaled >= 0 ? Math.round(scaled + 1e-6) : -Math.round(Math.abs(scaled) + 1e-6);
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatRate(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function formatQuantity(quantity: number): string {
  const rounded = Math.round(quantity * 10000) / 10000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** BT-146: prijs per eenheid; 2 decimalen tenzij er meer precisie in zit. */
function formatUnitPrice(unitPrice: number): string {
  const cents = unitPrice * 100;
  if (Math.abs(cents - Math.round(cents)) < 1e-6) return unitPrice.toFixed(2);
  return unitPrice.toFixed(4);
}

interface TaxGroup { category: UblVatCategory; rate: number; baseCents: number; taxCents: number; exemptionReason: string | null }

/** Groepeert regels per (categorie, tarief) en rekent btw per groep af. */
export function computeUblTotals(lines: UblLine[]): {
  lineNetCents: number[];
  groups: TaxGroup[];
  netCents: number;
  taxCents: number;
  grossCents: number;
} {
  const lineNetCents = lines.map((line) => toCents((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0)));
  const groupMap = new Map<string, TaxGroup>();
  lines.forEach((line, index) => {
    const rate = line.category === 'S' ? (Number(line.vatRate) || 0) : 0;
    const key = `${line.category}|${rate}`;
    const group = groupMap.get(key) ?? { category: line.category, rate, baseCents: 0, taxCents: 0, exemptionReason: line.exemptionReason ?? EXEMPTION_REASONS[line.category] ?? null };
    group.baseCents += lineNetCents[index];
    groupMap.set(key, group);
  });
  let taxCents = 0;
  const groups = [...groupMap.values()].sort((a, b) => a.category.localeCompare(b.category) || a.rate - b.rate);
  for (const group of groups) {
    group.taxCents = group.category === 'S' ? toCents((group.baseCents / 100) * (group.rate / 100)) : 0;
    taxCents += group.taxCents;
  }
  const netCents = lineNetCents.reduce((sum, cents) => sum + cents, 0);
  return { lineNetCents, groups, netCents, taxCents, grossCents: netCents + taxCents };
}

// ── Validatie ──────────────────────────────────────────────────────────────────

/**
 * Controleert of de invoer een geldige NL e-factuur kan opleveren. errors
 * blokkeren de generatie (de gebruiker moet eerst gegevens aanvullen);
 * warnings gaan mee in het resultaat maar houden niets tegen.
 */
export function validateUblInput(input: UblDocumentInput): UblValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isCredit = input.docType === 'creditNote';

  if (!String(input.number || '').trim()) errors.push('Het factuurnummer ontbreekt.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.issueDate || ''))) errors.push('De factuurdatum ontbreekt of is ongeldig.');
  if (input.lines.length === 0) errors.push('De factuur heeft geen regels.');
  if (!String(input.buyerReference || '').trim()) errors.push('Er kon geen koperreferentie worden bepaald.');

  // Verkoper (NL-R-002/003 + BR-S-02): eigen instellingen, dus harde eisen met
  // een melding die vertelt wáár de gebruiker het oplost.
  const seller = input.seller;
  if (!String(seller.name || '').trim()) errors.push('Bedrijfsnaam ontbreekt — vul deze in bij Instellingen → Facturatie.');
  if (!seller.addressLine1 || !seller.postalCode || !seller.city) {
    errors.push('Het bedrijfsadres (straat, postcode en plaats) is onvolledig — vul dit in bij Instellingen → Facturatie (NL-R-002).');
  }
  const sellerCountry = normalizeCountryCode(seller.country) ?? (seller.country == null || seller.country === '' ? 'NL' : null);
  if (!sellerCountry) errors.push(`Het land van je bedrijf ('${seller.country}') kon niet naar een ISO-landcode worden vertaald.`);
  const sellerIsNl = sellerCountry === 'NL';
  if (sellerIsNl && normalizeKvk(seller.kvkNumber).length < 8) {
    errors.push('KVK-nummer ontbreekt — voor een Nederlandse e-factuur is dit verplicht (NL-R-003). Vul het in bij Instellingen → Facturatie.');
  }
  // Het verkoper-btw-nummer (BT-31) is niet alleen bij standaard-btw verplicht:
  // EN16931 BR-Z-02/BR-E-02/BR-AE-02/BR-IC-02/BR-G-02 eisen het óók zodra er een
  // nul/vrijgesteld/verlegd/ICP/export-regel op de factuur staat. Alleen KOR (→ E
  // zonder btw-nummer) kan dat niet vervullen; die facturen zijn niet Peppol-
  // verzendbaar — we waarschuwen i.p.v. blokkeren zodat de download wel lukt.
  const requiresSellerVat = input.lines.some((line) => ['S', 'Z', 'E', 'AE', 'K', 'G'].includes(line.category));
  const isKorInvoice = input.lines.length > 0 && input.lines.every((line) => line.exemptionReason === KOR_EXEMPTION_REASON);
  if (requiresSellerVat && normalizeVat(seller.vatNumber).length < 8) {
    if (isKorInvoice) {
      warnings.push('Als kleineondernemer (KOR) heb je geen btw-nummer; deze e-factuur kan daardoor niet via Peppol worden verstuurd, maar wel als PDF/XML worden gedownload.');
    } else {
      errors.push('Btw-nummer van je bedrijf ontbreekt — verplicht voor deze btw-categorie (BR-S/Z/E/AE/IC-02). Vul het in bij Instellingen → Facturatie.');
    }
  }
  if (!isCredit && normalizeIban(input.sellerIban).length < 15) {
    errors.push('IBAN ontbreekt — een e-factuur moet een betaalwijze bevatten (NL-R-007). Vul het IBAN in bij Instellingen → Facturatie.');
  }
  // BR-CO-25: bij een positief te betalen bedrag moet er óf een vervaldatum
  // (BT-9) óf een betaaltermijn-tekst (BT-20) zijn.
  if (!isCredit && computeUblTotals(input.lines).grossCents > 0
    && !String(input.dueDate ?? '').trim() && !String(input.paymentTermsNote ?? '').trim()) {
    errors.push('Een vervaldatum of een betaaltermijn is verplicht op een e-factuur (BR-CO-25). Vul een vervaldatum in op de factuur, of een betaaltermijn bij Instellingen → Facturatie.');
  }

  // Koper (BT-55 + NL-R-004/005): klantgegevens, dus meldingen die naar het
  // klantdossier verwijzen.
  const buyer = input.buyer;
  if (!String(buyer.name || '').trim()) errors.push('De klantnaam ontbreekt.');
  const buyerCountry = normalizeCountryCode(buyer.country);
  if (!buyerCountry) {
    errors.push(buyer.country
      ? `Het land van de klant ('${buyer.country}') kon niet naar een ISO-landcode worden vertaald — pas het aan in het klantdossier.`
      : 'Het land van de klant ontbreekt — vul het in bij de klantgegevens (verplicht voor een e-factuur).');
  }
  const buyerIsNl = buyerCountry === 'NL';
  if (buyerIsNl && (!buyer.addressLine1 || !buyer.postalCode || !buyer.city)) {
    errors.push('Het adres van de NL-klant (straat, postcode en plaats) is onvolledig — vul het aan in het klantdossier (NL-R-004).');
  }
  if (buyerIsNl && !input.buyerIsConsumer && normalizeKvk(buyer.kvkNumber).length < 8) {
    warnings.push('De NL-klant heeft geen KVK-nummer — voor verzending via Peppol is dat verplicht (NL-R-005); voor download/e-mail kan de e-factuur wel gemaakt worden.');
  }
  if (!input.buyerIsConsumer && !derivePeppolEndpoint(buyer)) {
    warnings.push('Voor deze klant is geen Peppol-ID (KVK-, OIN- of btw-nummer) af te leiden — nodig zodra je via Peppol wilt versturen.');
  }

  // Verlegd/ICP: zonder koper-btw-nummer is de verleggingsfactuur ongeldig.
  const hasReverseOrIntraEu = input.lines.some((line) => line.category === 'AE' || line.category === 'K');
  if (hasReverseOrIntraEu && normalizeVat(buyer.vatNumber).length < 8) {
    errors.push('Deze factuur bevat verlegde of intracommunautaire btw, maar de klant heeft geen btw-nummer — vul het in bij de klantgegevens.');
  }
  if (input.lines.some((line) => line.category === 'K') && buyerIsNl) {
    warnings.push('Intracommunautaire regels (ICP) op een factuur aan een NL-klant zijn ongebruikelijk — controleer de btw-code.');
  }

  if (isCredit && !String(input.originalInvoiceNumber || '').trim()) {
    errors.push('Een creditnota moet verwijzen naar de oorspronkelijke factuur (NL-R-001).');
  }

  // Ingesloten bijlagen (BT-122..BT-125): referentie, bestandsnaam en een
  // MIME-type uit de Peppol-lijst zijn verplicht, en de inhoud moet base64 zijn.
  (input.attachments ?? []).forEach((doc, index) => {
    const label = String(doc.fileName ?? '').trim() ? `'${String(doc.fileName).trim()}'` : `nr. ${index + 1}`;
    if (!String(doc.id ?? '').trim()) errors.push(`Bijlage ${label} heeft geen referentie (BT-122).`);
    if (!String(doc.fileName ?? '').trim()) errors.push(`Bijlage ${label} heeft geen bestandsnaam (BT-125).`);
    if (!(UBL_ATTACHMENT_MIME_CODES as readonly string[]).includes(String(doc.mimeCode ?? ''))) {
      errors.push(`Bijlage ${label} is van een type (${doc.mimeCode || 'onbekend'}) dat een e-factuur niet toestaat.`);
    }
    if (!isBase64(doc.base64)) errors.push(`Bijlage ${label} is leeg of geen geldige base64.`);
  });

  return { errors, warnings };
}

function compactBase64(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, '');
}

function isBase64(value: string | null | undefined): boolean {
  const compact = compactBase64(value);
  return compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

// ── XML-generatie ──────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Element met tekstinhoud; leeg/null -> geen element (UBL verbiedt lege tags). */
function el(tag: string, value: string | null | undefined, attrs = ''): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return `<${tag}${attrs}>${escapeXml(text)}</${tag}>`;
}

function amountEl(tag: string, cents: number, currency: string): string {
  return `<${tag} currencyID="${escapeXml(currency)}">${formatCents(cents)}</${tag}>`;
}

/** Partijblok — elementvolgorde volgt het UBL 2.1 Party-schema. */
function renderParty(role: 'AccountingSupplierParty' | 'AccountingCustomerParty', party: UblParty, fallbackCountry: string): string {
  const endpoint = deriveElectronicAddress(party);
  const country = normalizeCountryCode(party.country) ?? fallbackCountry;
  const vat = normalizeVat(party.vatNumber);
  const kvk = normalizeKvk(party.kvkNumber);
  const kvkSchemeId = isBelgianEnterpriseNumber(party, kvk) ? '0208' : kvk.length === 20 ? '0190' : '0106';
  const tradeName = String(party.tradeName ?? '').trim();
  const parts = [
    endpoint ? el('cbc:EndpointID', endpoint.value, ` schemeID="${endpoint.schemeId}"`) : '',
    tradeName && tradeName !== party.name ? `<cac:PartyName>${el('cbc:Name', tradeName)}</cac:PartyName>` : '',
    '<cac:PostalAddress>',
    el('cbc:StreetName', party.addressLine1),
    el('cbc:AdditionalStreetName', party.addressLine2),
    el('cbc:CityName', party.city),
    el('cbc:PostalZone', party.postalCode),
    `<cac:Country>${el('cbc:IdentificationCode', country)}</cac:Country>`,
    '</cac:PostalAddress>',
    vat ? `<cac:PartyTaxScheme>${el('cbc:CompanyID', vat)}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '',
    '<cac:PartyLegalEntity>',
    el('cbc:RegistrationName', party.name),
    kvk ? el('cbc:CompanyID', kvk, ` schemeID="${kvkSchemeId}"`) : '',
    '</cac:PartyLegalEntity>',
    party.email ? `<cac:Contact>${el('cbc:ElectronicMail', party.email)}</cac:Contact>` : '',
  ].filter(Boolean).join('');
  return `<cac:${role}><cac:Party>${parts}</cac:Party></cac:${role}>`;
}

/**
 * Bouwt de UBL 2.1 XML. Roep eerst validateUblInput() aan: deze functie gaat
 * ervan uit dat blokkerende gebreken al zijn afgevangen en vult zelf niets aan.
 */
export function buildUblXml(input: UblDocumentInput): string {
  const isCredit = input.docType === 'creditNote';
  const currency = String(input.currency || 'EUR').toUpperCase();
  const totals = computeUblTotals(input.lines);
  const sellerCountry = normalizeCountryCode(input.seller.country) ?? 'NL';
  const buyerCountry = normalizeCountryCode(input.buyer.country) ?? sellerCountry;
  const iban = normalizeIban(input.sellerIban);

  const rootTag = isCredit ? 'CreditNote' : 'Invoice';
  const lineTag = isCredit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine';
  const quantityTag = isCredit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';

  const linesXml = input.lines.map((line, index) => {
    const rate = line.category === 'S' ? (Number(line.vatRate) || 0) : 0;
    const name = String(line.description || '').trim() || `Regel ${index + 1}`;
    return [
      `<${lineTag}>`,
      el('cbc:ID', String(index + 1)),
      `<${quantityTag} unitCode="C62">${formatQuantity(Number(line.quantity) || 0)}</${quantityTag}>`,
      amountEl('cbc:LineExtensionAmount', totals.lineNetCents[index], currency),
      '<cac:Item>',
      el('cbc:Name', name.slice(0, 100)),
      '<cac:ClassifiedTaxCategory>',
      el('cbc:ID', line.category),
      el('cbc:Percent', formatRate(rate)),
      '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
      '</cac:ClassifiedTaxCategory>',
      '</cac:Item>',
      `<cac:Price>${el('cbc:PriceAmount', formatUnitPrice(Number(line.unitPrice) || 0), ` currencyID="${escapeXml(currency)}"`)}</cac:Price>`,
      `</${lineTag}>`,
    ].filter(Boolean).join('');
  }).join('');

  const taxSubtotals = totals.groups.map((group) => [
    '<cac:TaxSubtotal>',
    amountEl('cbc:TaxableAmount', group.baseCents, currency),
    amountEl('cbc:TaxAmount', group.taxCents, currency),
    '<cac:TaxCategory>',
    el('cbc:ID', group.category),
    el('cbc:Percent', formatRate(group.rate)),
    group.category !== 'S' && group.category !== 'Z' ? el('cbc:TaxExemptionReason', group.exemptionReason) : '',
    '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
    '</cac:TaxCategory>',
    '</cac:TaxSubtotal>',
  ].filter(Boolean).join('')).join('');

  const billingReference = input.originalInvoiceNumber
    ? `<cac:BillingReference><cac:InvoiceDocumentReference>${el('cbc:ID', input.originalInvoiceNumber)}${el('cbc:IssueDate', input.originalInvoiceDate)}</cac:InvoiceDocumentReference></cac:BillingReference>`
    : '';

  // Ingesloten bijlagen, zoals de factuur-PDF. In zowel Invoice als CreditNote
  // staat AdditionalDocumentReference ná BillingReference en vóór de partijen.
  // Geen DocumentTypeCode: in Peppol betekent 130 "gefactureerd object", niet
  // "bijlage".
  const additionalDocuments = (input.attachments ?? []).map((doc) => [
    '<cac:AdditionalDocumentReference>',
    el('cbc:ID', doc.id),
    el('cbc:DocumentDescription', doc.description),
    '<cac:Attachment>',
    `<cbc:EmbeddedDocumentBinaryObject mimeCode="${escapeXml(String(doc.mimeCode).trim())}" filename="${escapeXml(String(doc.fileName).trim())}">${compactBase64(doc.base64)}</cbc:EmbeddedDocumentBinaryObject>`,
    '</cac:Attachment>',
    '</cac:AdditionalDocumentReference>',
  ].filter(Boolean).join('')).join('');

  // Betaalwijze alleen op facturen: NL-R-007 geldt "als de betaling van koper
  // naar verkoper loopt" — bij een creditnota is dat andersom.
  const paymentMeans = !isCredit && iban
    ? `<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>${el('cbc:PaymentID', input.paymentReference)}<cac:PayeeFinancialAccount>${el('cbc:ID', iban)}${el('cbc:Name', input.seller.name)}</cac:PayeeFinancialAccount></cac:PaymentMeans>`
    : '';
  const paymentTerms = !isCredit && String(input.paymentTermsNote ?? '').trim()
    ? `<cac:PaymentTerms>${el('cbc:Note', input.paymentTermsNote)}</cac:PaymentTerms>`
    : '';

  const body = [
    el('cbc:CustomizationID', UBL_CUSTOMIZATION_ID),
    el('cbc:ProfileID', UBL_PROFILE_ID),
    el('cbc:ID', input.number),
    el('cbc:IssueDate', input.issueDate),
    // UBL 2.1 CreditNote kent geen DueDate op documentniveau.
    isCredit ? '' : el('cbc:DueDate', input.dueDate),
    isCredit ? el('cbc:CreditNoteTypeCode', '381') : el('cbc:InvoiceTypeCode', '380'),
    el('cbc:Note', input.note),
    el('cbc:DocumentCurrencyCode', currency),
    el('cbc:BuyerReference', input.buyerReference),
    billingReference,
    additionalDocuments,
    renderParty('AccountingSupplierParty', input.seller, 'NL'),
    renderParty('AccountingCustomerParty', input.buyer, buyerCountry),
    paymentMeans,
    paymentTerms,
    `<cac:TaxTotal>${amountEl('cbc:TaxAmount', totals.taxCents, currency)}${taxSubtotals}</cac:TaxTotal>`,
    '<cac:LegalMonetaryTotal>',
    amountEl('cbc:LineExtensionAmount', totals.netCents, currency),
    amountEl('cbc:TaxExclusiveAmount', totals.netCents, currency),
    amountEl('cbc:TaxInclusiveAmount', totals.grossCents, currency),
    amountEl('cbc:PayableAmount', totals.grossCents, currency),
    '</cac:LegalMonetaryTotal>',
    linesXml,
  ].filter(Boolean).join('');

  return `<?xml version="1.0" encoding="UTF-8"?><${rootTag} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${rootTag}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">${body}</${rootTag}>`;
}

// ── Herkenning (inkomende UBL) ─────────────────────────────────────────────────
// De parser zelf staat in ublParse.ts; deze snelle vooraf-check heeft geen
// XML-parser nodig en blijft daarom hier.

/** Snelle vooraf-check: is dit bestand vermoedelijk een UBL-factuur? */
export function looksLikeUblXml(fileName: string, mimeType: string, contentStart: string): boolean {
  const xmlByType = ['application/xml', 'text/xml'].includes(mimeType.toLowerCase()) || fileName.toLowerCase().endsWith('.xml');
  const start = contentStart.slice(0, 2000);
  const xmlByContent = start.trimStart().startsWith('<?xml') || /<\s*(?:\w+:)?(?:Invoice|CreditNote)[\s>]/.test(start);
  return xmlByType || xmlByContent;
}
