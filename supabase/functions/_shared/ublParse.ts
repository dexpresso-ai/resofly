// ============================================================
// UBL 2.1 e-facturatie — de PARSER voor inkomende UBL (inkoopkant).
//
// Afgesplitst van ubl.ts zodat de bouwer en validator daar zonder externe
// import blijven: die zijn zo in node te testen (ubl.test.ts), net als
// invoiceInboxRules.ts naast invoiceInbox.ts. De categorie-/landlogica en het
// centenrekenwerk blijven gedeeld: die komen hieronder uit ubl.ts.
//
// parseUblDocument() — inkomende UBL-XML -> genormaliseerde factuurdata
// (deterministisch, geen AI), voor de inkoopflow. De enige dependency is
// fast-xml-parser, gepind via esm.sh.
// ============================================================

import { XMLParser } from 'https://esm.sh/fast-xml-parser@4.5.0';
import { toCents } from './ubl.ts';

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
