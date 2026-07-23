// ============================================================
// UBL 2.1 e-facturatie (Peppol BIS Billing 3.0, NL-regels) — gedeelde module.
//
// Drie verantwoordelijkheden, bewust in één bestand zodat builder en parser
// dezelfde categorie-/landlogica delen:
//  1. buildUblXml()      — verkoopfactuur/creditnota -> UBL 2.1 XML-string.
//  2. validateUblInput() — NL-foutenlijst VÓÓR generatie (ontbrekende KVK,
//                          adres, IBAN, btw-nummer bij verlegd/ICP, …).
//  3. parseUblDocument() — inkomende UBL-XML -> genormaliseerde factuurdata
//                          (deterministisch, geen AI), voor de inkoopflow.
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
//  - Builder/validator zijn pure functies (patroon _shared/dunning.ts); alleen
//    de parser heeft een dependency (fast-xml-parser, gepind via esm.sh).
// ============================================================

import { XMLParser } from 'https://esm.sh/fast-xml-parser@4.5.0';

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
}

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

/**
 * Peppol-endpoint (BT-34/BT-49) afleiden: KVK (0106) of OIN (0190, 20 cijfers)
 * heeft voorrang; anders het NL-btw-nummer (9944). Buitenlandse partijen zonder
 * KVK krijgen geen endpoint — dat levert een waarschuwing op, geen fout, want
 * levering per download/e-mail heeft geen endpoint nodig.
 */
function deriveEndpoint(party: UblParty): { schemeId: string; value: string } | null {
  const kvk = normalizeKvk(party.kvkNumber);
  if (kvk.length === 20) return { schemeId: '0190', value: kvk };
  if (kvk.length >= 8) return { schemeId: '0106', value: kvk };
  const vat = normalizeVat(party.vatNumber);
  if (vat.startsWith('NL') && vat.length >= 12) return { schemeId: '9944', value: vat };
  return null;
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

function toCents(euros: number): number {
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
  if (!input.buyerIsConsumer && !deriveEndpoint(buyer)) {
    warnings.push('Voor deze klant is geen elektronisch adres (KVK- of NL-btw-nummer) af te leiden — nodig zodra je via Peppol wilt versturen.');
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

  return { errors, warnings };
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
  const endpoint = deriveEndpoint(party);
  const country = normalizeCountryCode(party.country) ?? fallbackCountry;
  const vat = normalizeVat(party.vatNumber);
  const kvk = normalizeKvk(party.kvkNumber);
  const kvkSchemeId = kvk.length === 20 ? '0190' : '0106';
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

// ── Parser (inkomende UBL) ─────────────────────────────────────────────────────

export interface ParsedUblParty {
  name: string;
  vatNumber: string | null;
  kvkNumber: string | null;
  iban: string | null;
  email: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
}

export interface ParsedUblLine {
  description: string;
  /** Regelbedrag EXCL btw in centen (creditnota: negatief). */
  netCents: number;
  vatRate: number;
  category: string;
}

export interface ParsedUblDocument {
  docType: 'invoice' | 'creditNote';
  customizationId: string | null;
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  note: string | null;
  buyerReference: string | null;
  paymentReference: string | null;
  supplier: ParsedUblParty;
  lines: ParsedUblLine[];
  /** Documenttotalen zoals de afzender ze vermeldt (creditnota: negatief). */
  totals: { netCents: number | null; vatCents: number | null; grossCents: number | null };
  /** Korting/toeslag op documentniveau — wordt niet als regel overgenomen. */
  hasDocumentAllowanceCharge: boolean;
}

/** Snelle vooraf-check: is dit bestand vermoedelijk een UBL-factuur? */
export function looksLikeUblXml(fileName: string, mimeType: string, contentStart: string): boolean {
  const xmlByType = ['application/xml', 'text/xml'].includes(mimeType.toLowerCase()) || fileName.toLowerCase().endsWith('.xml');
  const start = contentStart.slice(0, 2000);
  const xmlByContent = start.trimStart().startsWith('<?xml') || /<\s*(?:\w+:)?(?:Invoice|CreditNote)[\s>]/.test(start);
  return xmlByType || xmlByContent;
}

// Elementen die (ook) meervoudig kunnen voorkomen — altijd als array parsen.
const UBL_ARRAY_ELEMENTS = new Set(['InvoiceLine', 'CreditNoteLine', 'TaxSubtotal', 'TaxTotal', 'PaymentMeans', 'PartyTaxScheme', 'Note', 'Description', 'PartyIdentification']);

/** Tekstwaarde van een fast-xml-parser-knoop ('#text' bij attributen). */
function nodeText(node: unknown): string | null {
  if (node == null) return null;
  if (Array.isArray(node)) return nodeText(node[0]);
  if (typeof node === 'object') {
    const text = (node as Record<string, unknown>)['#text'];
    return text == null ? null : String(text).trim() || null;
  }
  const text = String(node).trim();
  return text || null;
}

function nodeAttr(node: unknown, attr: string): string | null {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return null;
  const value = (node as Record<string, unknown>)[`@_${attr}`];
  return value == null ? null : String(value).trim() || null;
}

function asArray<T>(node: T | T[] | undefined | null): T[] {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

/**
 * Bedrag -> centen. UBL schrijft '.' als decimaalteken voor, maar sommige
 * afzenders sturen een decimaalkomma of zelfs duizend-scheiders. Naïef ','->'.'
 * verminkt '1.234,56' tot 1.234 (stille factor-1000-fout). We nemen daarom het
 * LAATSTE scheidingsteken als decimaalteken en strippen de rest, en verwerpen
 * alles wat daarna nog geen zuiver getal is (null -> zichtbare mismatch/warning).
 */
function centsFromAmount(node: unknown): number | null {
  const text = nodeText(node);
  if (text == null) return null;
  const cleaned = text.replace(/\s/g, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized: string;
  if (lastDot === -1 && lastComma === -1) {
    normalized = cleaned;
  } else {
    const decimalPos = Math.max(lastDot, lastComma);
    const intPart = cleaned.slice(0, decimalPos).replace(/[.,]/g, '');
    const fracPart = cleaned.slice(decimalPos + 1);
    normalized = `${intPart}.${fracPart}`;
  }
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return toCents(value);
}

function rateFromPercent(node: unknown): number {
  const text = nodeText(node);
  const value = Number.parseFloat(String(text ?? '').replace(',', '.'));
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function parseParty(partyContainer: Record<string, unknown> | undefined): ParsedUblParty {
  const party = (asArray(partyContainer?.Party as unknown)[0] ?? {}) as Record<string, unknown>;
  // Defensief het eerste element pakken: bij (technisch ongeldige) herhaalde
  // elementen maakt fast-xml-parser er een array van, en dan zou een directe
  // property-toegang undefined geven -> stil naamverlies.
  const legalEntity = (asArray(party.PartyLegalEntity as unknown)[0] ?? {}) as Record<string, unknown>;
  const address = (asArray(party.PostalAddress as unknown)[0] ?? {}) as Record<string, unknown>;
  const contact = (asArray(party.Contact as unknown)[0] ?? {}) as Record<string, unknown>;
  const partyName = (asArray(party.PartyName as unknown)[0] ?? {}) as Record<string, unknown>;

  // Btw-nummer: de PartyTaxScheme met TaxScheme/ID = VAT (er kan er ook één
  // met een lokale heffing tussen zitten).
  let vatNumber: string | null = null;
  for (const scheme of asArray(party.PartyTaxScheme as unknown)) {
    const schemeObj = (scheme ?? {}) as Record<string, unknown>;
    const taxSchemeId = nodeText(((schemeObj.TaxScheme ?? {}) as Record<string, unknown>).ID);
    const companyId = nodeText(schemeObj.CompanyID);
    if (companyId && (!taxSchemeId || taxSchemeId.toUpperCase() === 'VAT')) { vatNumber = companyId; break; }
  }

  // KVK: PartyLegalEntity/CompanyID met schemeID 0106/0190, of een kaal
  // 8-cijferig nummer (veel afzenders laten de schemeID weg).
  let kvkNumber: string | null = null;
  const legalCompanyId = legalEntity.CompanyID;
  const legalIdText = nodeText(legalCompanyId);
  const legalIdScheme = nodeAttr(legalCompanyId, 'schemeID');
  if (legalIdText && (legalIdScheme === '0106' || legalIdScheme === '0190' || /^\d{8}$/.test(legalIdText.replace(/\D/g, '')))) {
    kvkNumber = legalIdText;
  }

  const country = (address.Country ?? {}) as Record<string, unknown>;
  return {
    name: nodeText(legalEntity.RegistrationName) ?? nodeText(partyName.Name) ?? '',
    vatNumber,
    kvkNumber,
    iban: null, // wordt uit PaymentMeans gevuld
    email: nodeText(contact.ElectronicMail),
    addressLine1: nodeText(address.StreetName),
    postalCode: nodeText(address.PostalZone),
    city: nodeText(address.CityName),
    countryCode: nodeText(country.IdentificationCode),
  };
}

/**
 * Parseert een UBL 2.1 Invoice of CreditNote naar genormaliseerde factuurdata.
 * Namespace-agnostisch (removeNSPrefix): afzenders gebruiken cbc:/cac:-prefixen
 * in alle varianten. Gooit een Error met NL-melding als het geen UBL-factuur is.
 */
export function parseUblDocument(xmlText: string): ParsedUblDocument {
  // Weiger een DTD/DOCTYPE: geldige UBL-facturen hebben er nooit één, en het
  // dicht een entity-amplificatie (billion laughs / lineaire expansie) af vóór
  // de parser hem verwerkt — de 10MB-cap is daar geen bescherming tegen.
  if (/<!DOCTYPE/i.test(xmlText)) {
    throw new Error('Dit XML-bestand bevat een DTD/DOCTYPE en wordt om veiligheidsredenen geweigerd — een UBL-factuur heeft die niet nodig.');
  }
  if (!xmlText.includes('urn:oasis:names:specification:ubl')) {
    throw new Error('Dit XML-bestand is geen UBL-factuur (de UBL-naamruimte ontbreekt).');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name: string) => UBL_ARRAY_ELEMENTS.has(name),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch {
    throw new Error('Het XML-bestand kon niet worden gelezen (geen geldige XML).');
  }

  const invoiceRoot = parsed.Invoice as Record<string, unknown> | undefined;
  const creditRoot = parsed.CreditNote as Record<string, unknown> | undefined;
  const root = invoiceRoot ?? creditRoot;
  if (!root) throw new Error('Dit XML-bestand is geen UBL-factuur (rootelement Invoice of CreditNote ontbreekt).');
  const docType: 'invoice' | 'creditNote' = invoiceRoot ? 'invoice' : 'creditNote';
  // Creditnota: bedragen negatief overnemen zodat de inkoopadministratie de
  // creditering als negatieve kosten/voorbelasting boekt.
  const sign = docType === 'creditNote' ? -1 : 1;

  const currency = nodeText(root.DocumentCurrencyCode)?.toUpperCase() || 'EUR';

  const supplier = parseParty(root.AccountingSupplierParty as Record<string, unknown> | undefined);
  const paymentMeans = asArray(root.PaymentMeans as unknown).map((pm) => (pm ?? {}) as Record<string, unknown>);
  for (const pm of paymentMeans) {
    const account = (pm.PayeeFinancialAccount ?? {}) as Record<string, unknown>;
    const accountId = nodeText(account.ID);
    if (accountId && /^[A-Z]{2}\d{2}[A-Z0-9]{6,}$/i.test(accountId.replace(/\s/g, ''))) {
      supplier.iban = accountId.replace(/\s/g, '').toUpperCase();
      break;
    }
  }
  const paymentReference = paymentMeans.map((pm) => nodeText(pm.PaymentID)).find(Boolean) ?? null;

  const lineNodes = asArray((docType === 'invoice' ? root.InvoiceLine : root.CreditNoteLine) as unknown);
  const lines: ParsedUblLine[] = lineNodes.map((node, index) => {
    const line = (node ?? {}) as Record<string, unknown>;
    const item = (asArray(line.Item as unknown)[0] ?? {}) as Record<string, unknown>;
    const taxCategory = (asArray(item.ClassifiedTaxCategory as unknown)[0] ?? {}) as Record<string, unknown>;
    const descriptions = asArray(item.Description as unknown).map(nodeText).filter(Boolean) as string[];
    const noteTexts = asArray(line.Note as unknown).map(nodeText).filter(Boolean) as string[];
    // Artikelidentificatie (BT-155/BT-157) als extra fallback vóór 'Regel N':
    // sommige afzenders zetten de omschrijving alleen als artikelnummer.
    const sellersId = nodeText((asArray(item.SellersItemIdentification as unknown)[0] as Record<string, unknown> | undefined)?.ID);
    const standardId = nodeText((asArray(item.StandardItemIdentification as unknown)[0] as Record<string, unknown> | undefined)?.ID);
    const description = nodeText(item.Name) ?? descriptions[0] ?? noteTexts[0] ?? sellersId ?? standardId ?? `Regel ${index + 1}`;
    return {
      description,
      netCents: sign * (centsFromAmount(line.LineExtensionAmount) ?? 0),
      vatRate: rateFromPercent(taxCategory.Percent),
      category: (nodeText(taxCategory.ID) ?? 'S').toUpperCase(),
    };
  });

  // Documenttotalen: LegalMonetaryTotal + de TaxTotal in documentvaluta.
  const monetary = (root.LegalMonetaryTotal ?? {}) as Record<string, unknown>;
  const taxTotals = asArray(root.TaxTotal as unknown).map((tt) => (tt ?? {}) as Record<string, unknown>);
  const documentTaxTotal = taxTotals.find((tt) => nodeAttr(tt.TaxAmount, 'currencyID') === currency) ?? taxTotals[0];
  const netCents = centsFromAmount(monetary.TaxExclusiveAmount) ?? centsFromAmount(monetary.LineExtensionAmount);
  const vatCents = documentTaxTotal ? centsFromAmount(documentTaxTotal.TaxAmount) : null;
  const grossCents = centsFromAmount(monetary.TaxInclusiveAmount) ?? centsFromAmount(monetary.PayableAmount);

  return {
    docType,
    customizationId: nodeText(root.CustomizationID),
    number: nodeText(root.ID),
    issueDate: nodeText(root.IssueDate),
    dueDate: docType === 'invoice' ? nodeText(root.DueDate) : null,
    currency,
    note: asArray(root.Note as unknown).map(nodeText).find(Boolean) ?? null,
    buyerReference: nodeText(root.BuyerReference),
    paymentReference,
    supplier,
    lines,
    totals: {
      netCents: netCents == null ? null : sign * netCents,
      vatCents: vatCents == null ? null : sign * vatCents,
      grossCents: grossCents == null ? null : sign * grossCents,
    },
    hasDocumentAllowanceCharge: asArray(root.AllowanceCharge as unknown).length > 0,
  };
}
