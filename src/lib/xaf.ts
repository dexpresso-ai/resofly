import type { AppData, BankAllocation, JournalEntry, JournalLine, LedgerAccount, VatCode } from '../types';

/**
 * XML Auditfile Financieel (XAF) 3.2 — het standaard uitwisselformaat van de
 * Belastingdienst/SBR waarmee een accountant of een ander boekhoudpakket de
 * volledige administratie kan inlezen (review 3.1: dit was een harde blocker).
 *
 * De export is bewust client-side: sinds de pagineringsfix (review 3.10) bevat
 * AppData het VOLLEDIGE journaal, dus alle gegevens zijn al in de browser. De
 * opbouw volgt het 3.2-schema (http://www.auditfiles.nl/XAF/3.2): header →
 * company (klanten/leveranciers, rekeningschema, btw-codes, perioden,
 * beginbalans, transacties per dagboek).
 *
 * Alleen 'posted' boekstukken tellen mee — 'reversed' (boekjaar-heropening)
 * staat ook in de rapportages niet; een tegengeboekt paar is twee keer posted
 * en telt netto nul, precies zoals in de W&V/balans.
 */

const XAF_NS = 'http://www.auditfiles.nl/XAF/3.2';

const esc = (v: string): string => v
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Bedrag in euro's met twee decimalen (XAF verwacht decimalen, geen centen). */
const amt = (cents: number): string => (Math.abs(cents) / 100).toFixed(2);
const amntTp = (cents: number): 'D' | 'C' => (cents >= 0 ? 'D' : 'C');

const tag = (name: string, value: string | number): string => `<${name}>${esc(String(value))}</${name}>`;

/**
 * De tekst afgekapt op de maximale lengte uit het XSD (String50, String30,
 * IdentificationString35, …). Het XSD telt tekens, niet bytes of entiteiten:
 * "&" telt als één, ook al staat er "&amp;". Array.from splitst op tekens, zodat
 * een emoji of ander teken buiten het basisvlak niet half wordt afgebroken.
 *
 * Tot november 2026 ging de naam van een klant of leverancier er volledig in.
 * "Stichting Vrienden van het Centraal Museum Utrecht en omstreken" (63 tekens)
 * maakte zo elke auditfile ongeldig, ook van jaren waarin die klant niets deed:
 * custSupName is String50, en de Belastingdienst en de pakketten van
 * boekhouders valideren tegen het XSD.
 */
export function fitXaf(value: string | number | null | undefined, max: number): string {
  return Array.from(String(value ?? '').trim()).slice(0, max).join('').trim();
}
const tagMax = (name: string, value: string | number | null | undefined, max: number): string => tag(name, fitXaf(value, max));
/** Een optioneel veld: leeg = geen element. */
const optMax = (name: string, value: string | number | null | undefined, max: number): string => {
  const text = fitXaf(value, max);
  return text ? tag(name, text) : '';
};

/** CountrycodeIso3166 uit het XSD: alleen deze codes zijn geldig. */
const ISO_COUNTRIES = new Set(('AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
/** Het land is in ResoFly vrije tekst (standaard "Nederland"). */
const COUNTRY_NAMES: Record<string, string> = {
  nederland: 'NL', netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL',
  belgie: 'BE', 'belgië': 'BE', belgium: 'BE', belgique: 'BE',
  duitsland: 'DE', germany: 'DE', deutschland: 'DE',
  frankrijk: 'FR', france: 'FR', luxemburg: 'LU', luxembourg: 'LU',
  'verenigd koninkrijk': 'GB', 'united kingdom': 'GB', engeland: 'GB', uk: 'GB',
  spanje: 'ES', spain: 'ES', italie: 'IT', 'italië': 'IT', italy: 'IT',
  oostenrijk: 'AT', austria: 'AT', ierland: 'IE', ireland: 'IE', denemarken: 'DK', denmark: 'DK',
  zweden: 'SE', sweden: 'SE', noorwegen: 'NO', norway: 'NO', polen: 'PL', poland: 'PL', portugal: 'PT', finland: 'FI',
  zwitserland: 'CH', switzerland: 'CH', 'verenigde staten': 'US', 'united states': 'US', usa: 'US',
};
/** Een geldige landcode of null: een onbekend land laat het veld weg in plaats van het bestand ongeldig te maken. */
export function xafCountry(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const code = COUNTRY_NAMES[value.toLowerCase()] ?? (/^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null);
  return code && ISO_COUNTRIES.has(code) ? code : null;
}

/** Een adresblok (streetAddress), in de volgorde van het XSD; leeg = niets. */
function addressXml(a: { address_line1?: string | null; postal_code?: string | null; city?: string | null; country?: string | null }): string {
  const country = xafCountry(a.country);
  const inner = optMax('streetname', a.address_line1, 999)
    + optMax('city', a.city, 50)
    + optMax('postalCode', a.postal_code, 10)
    + (country ? tag('country', country) : '');
  return inner ? `<streetAddress>${inner}</streetAddress>` : '';
}

/** Decimal8 uit het XSD: hoogstens drie decimalen, niet negatief. */
const vatPercent = (rate: number | null | undefined): string => {
  const n = Math.max(0, Number(rate) || 0);
  return n.toFixed(3).replace(/\.?0+$/, '') || '0';
};

/** Dagboekindeling: elk boekstuk valt op basis van zijn bron in één dagboek. */
const JOURNALS: { jrnID: string; desc: string; jrnTp: string; sources: string[] }[] = [
  { jrnID: 'VRK', desc: 'Verkoopboek', jrnTp: 'S', sources: ['sales_invoice', 'credit_note'] },
  { jrnID: 'INK', desc: 'Inkoopboek', jrnTp: 'P', sources: ['purchase_invoice'] },
  { jrnID: 'BNK', desc: 'Bankboek', jrnTp: 'B', sources: ['payment'] },
  { jrnID: 'OPN', desc: 'Openingsbalans', jrnTp: 'O', sources: ['opening_balance'] },
  // Elk brontype moet in precies één dagboek vallen: een boekstuk waarvan het
  // brontype hier ontbreekt, verdwijnt geruisloos uit <transactions> én uit de
  // totalen, terwijl het in de beginbalans van het volgende jaar wél meetelt —
  // dan sluiten twee auditfiles onderling niet meer aan.
  { jrnID: 'MEM', desc: 'Memoriaal', jrnTp: 'M', sources: ['manual', 'asset_depreciation', 'asset_acquisition', 'asset_disposal', 'vat_return', 'year_close', 'result_appropriation', 'corporate_tax', 'dga_interest', 'payroll', 'dividend', 'prepaid_start', 'prepaid_release', 'prepaid_end', 'purchase_private_payment'] },
];

/**
 * Wat niet in de kern van AppData zit, maar wel het factuurnummer van een
 * boekstukregel geeft: de nummers van creditnota's en hoe een bankboeking over
 * facturen verdeeld is. De auditfile haalt ze los op (Grootboek laadt ze niet).
 * Zonder deze gegevens blijft invRef op die regels weg; de rest is gelijk.
 */
export interface XafReferences {
  /** Creditnota-id → nummer. */
  creditNoteNumbers?: ReadonlyMap<string, string>;
  /** bank_transaction_allocations: welke factuur een bankregel aflettert. */
  paymentAllocations?: ReadonlyArray<Pick<BankAllocation,
    'journal_entry_id' | 'position' | 'kind' | 'invoice_id' | 'credit_note_id' | 'purchase_invoice_id' | 'client_id' | 'supplier_id' | 'amount_cents'>>;
}

export interface XafInput {
  data: AppData;
  /** Boekjaargrenzen (kunnen een gebroken boekjaar zijn). */
  fiscalYearLabel: string;
  startDate: string;
  endDate: string;
  references?: XafReferences;
}

/**
 * De btw-code van een omzetregel zonder code, op dezelfde manier als de
 * btw-aangifte hem afleidt (compute_vat_boxes): tarief 21% of meer → rubriek
 * 1a, meer dan 0% → 1b, anders 1e. Financiële baten en lasten zijn geen omzet
 * voor de omzetbelasting, en het jaarafsluitboekstuk telt niet mee.
 *
 * Een nieuwe factuurregel heeft in de editor alleen `vat: 21` en geen code, en
 * het boeken neemt de code ongewijzigd over. De auditfile schreef alleen een
 * <vat>-blok bij een code: de meest voorkomende regel, omzet tegen 21%, kwam er
 * zo in als omzet zonder btw, terwijl de aangifte hem wel in 1a telde.
 *
 * Een code die de organisatie niet (meer) heeft, telt net als in de aangifte
 * als geen code: een vatID die niet in <vatCodes> staat, maakt het bestand
 * bovendien ongeldig (keyref in het XSD).
 */
export function xafVatCodeForLine(
  line: Pick<JournalLine, 'vat_code' | 'vat_rate'>,
  account: Pick<LedgerAccount, 'type' | 'report_group'> | undefined,
  sourceType: string,
  vatCodes: readonly Pick<VatCode, 'code' | 'rate' | 'kind' | 'sales_box' | 'is_active'>[],
): Pick<VatCode, 'code' | 'rate'> | null {
  const own = line.vat_code ? vatCodes.find(v => v.code === line.vat_code) : undefined;
  if (own) return own;
  if (account?.type !== 'revenue' || sourceType === 'year_close') return null;
  if (account.report_group === 'financiele_baten' || account.report_group === 'financiele_lasten' || account.report_group === 'resultaat_deelnemingen') return null;
  const rate = Number(line.vat_rate ?? 0) || 0;
  const box = rate >= 21 ? '1a' : rate > 0 ? '1b' : '1e';
  const kinds = box === '1a' ? ['standard'] : box === '1b' ? ['reduced'] : ['zero'];
  const preferred = box === '1a' ? 'HOOG' : box === '1b' ? 'LAAG' : 'NUL';
  const candidates = vatCodes.filter(v => v.sales_box === box && kinds.includes(v.kind));
  return candidates.find(v => v.code === preferred)
    ?? candidates.find(v => v.is_active && Number(v.rate) === rate)
    ?? candidates.find(v => v.is_active)
    ?? candidates[0]
    ?? null;
}

export function buildXaf({ data, fiscalYearLabel, startDate, endDate, references }: XafInput): string {
  const company = data.companySettings;
  const linesByEntry = new Map<string, JournalLine[]>();
  for (const line of data.journalLines) {
    const arr = linesByEntry.get(line.entry_id) ?? [];
    arr.push(line);
    linesByEntry.set(line.entry_id, arr);
  }
  linesByEntry.forEach(arr => arr.sort((a, b) => a.line_index - b.line_index));

  const accountById = new Map(data.ledgerAccounts.map(a => [a.id, a]));
  const posted = data.journalEntries.filter(e => e.status === 'posted');
  // De beginbalans op de eerste dag van het boekjaar hoort in <openingBalance>,
  // niet als boekstuk in dagboek OPN. Daar stond hij tot november 2026, met een
  // lege <openingBalance>: een pakket (en de eigen import van ResoFly) las de
  // auditfile van het eerste jaar dan als een bestand "zonder beginbalans".
  const isOpening = (e: JournalEntry) => e.date < startDate || (e.date === startDate && e.source_type === 'opening_balance');
  const inYear = posted.filter(e => !isOpening(e) && e.date <= endDate);
  const beforeYear = posted.filter(isOpening);

  // ---------------- Klanten & leveranciers ----------------
  // Volgorde volgens de XSD van XAF 3.2: custSupID, custSupName, contact,
  // telephone, eMail, commerceNr, taxRegIdent, custSupTp, streetAddress,
  // bankAccount. In een andere volgorde keurde een validator elk bestand af
  // met een btw-nummer bij een klant of leverancier. Een id zonder eigen code
  // gebruikt de UUID zonder streepjes ("C-" + 32 tekens), binnen de 35.
  //
  // Adres, KvK, e-mail en IBAN staan er sinds november 2026 bij: zonder die
  // gegevens maakte het pakket van de boekhouder (en de eigen import van
  // ResoFly) relaties zonder adres.
  const custSupId = (prefix: 'C' | 'S', code: string | null | undefined, id: string) =>
    fitXaf(`${prefix}-${code || id.replace(/-/g, '')}`, 35);
  type Relation = {
    name?: string | null; contact_name?: string | null; phone?: string | null; email?: string | null;
    kvk_number?: string | null; vat_number?: string | null; iban?: string | null;
    address_line1?: string | null; postal_code?: string | null; city?: string | null; country?: string | null;
  };
  const relationXml = (id: string, r: Relation, tp: 'C' | 'S') => {
    const iban = fitXaf(String(r.iban ?? '').replace(/\s/g, '').toUpperCase(), 35);
    return '<customerSupplier>'
      + tag('custSupID', id)
      + tagMax('custSupName', r.name || '—', 50)
      + optMax('contact', r.contact_name, 50)
      + optMax('telephone', r.phone, 30)
      + optMax('eMail', r.email, 999)
      + optMax('commerceNr', r.kvk_number, 999)
      + optMax('taxRegIdent', r.vat_number, 30)
      + tag('custSupTp', tp)
      + addressXml(r)
      + (iban ? `<bankAccount>${tag('bankAccNr', iban)}</bankAccount>` : '')
      + '</customerSupplier>';
  };
  const custSup: string[] = [];
  for (const c of data.clients) custSup.push(relationXml(custSupId('C', c.client_code, c.id), c, 'C'));
  for (const s of data.suppliers) custSup.push(relationXml(custSupId('S', s.supplier_code, s.id), s, 'S'));
  const clientCode = new Map(data.clients.map(c => [c.id, custSupId('C', c.client_code, c.id)]));
  const supplierCode = new Map(data.suppliers.map(s => [s.id, custSupId('S', s.supplier_code, s.id)]));

  // ---------------- Rekeningschema ----------------
  // accTp: B = balansrekening, P = winst-en-verliesrekening.
  const ledger = data.ledgerAccounts.map(a => '<ledgerAccount>'
    + tagMax('accID', a.code, 35)
    + tagMax('accDesc', a.name, 999)
    + tag('accTp', a.type === 'revenue' || a.type === 'expense' ? 'P' : 'B')
    + '</ledgerAccount>');

  // ---------------- BTW-codes ----------------
  const vat = data.vatCodes.map(v => '<vatCode>'
    + tagMax('vatID', v.code, 35)
    + tagMax('vatDesc', `${v.label} (${v.rate}%)`, 999)
    + '</vatCode>');

  // ---------------- Factuurnummers (invRef) ----------------
  // docRef is het boekstuknummer; het factuurnummer stond alleen in de
  // omschrijving ("Debiteuren — factuur F2025-69d54d"). Een boekhouder kon de
  // openstaande posten zo niet per factuur aansluiten.
  const invoiceNumber = new Map((data.invoices ?? []).map(i => [i.id, i.number]));
  const purchaseNumber = new Map((data.purchaseInvoices ?? []).map(p => [p.id, p.supplier_invoice_number || p.internal_number || '']));
  const creditNumber = references?.creditNoteNumbers ?? new Map<string, string>();
  const documentRef = (entry: JournalEntry): string | null => {
    if (!entry.source_id) return null;
    if (entry.source_type === 'sales_invoice') return invoiceNumber.get(entry.source_id) || null;
    if (entry.source_type === 'credit_note') return creditNumber.get(entry.source_id) || null;
    if (entry.source_type === 'purchase_invoice') return purchaseNumber.get(entry.source_id) || null;
    return null;
  };
  const allocationsByEntry = new Map<string, NonNullable<XafReferences['paymentAllocations']>[number][]>();
  for (const a of references?.paymentAllocations ?? []) {
    const arr = allocationsByEntry.get(a.journal_entry_id) ?? [];
    arr.push(a);
    allocationsByEntry.set(a.journal_entry_id, arr);
  }
  allocationsByEntry.forEach(arr => arr.sort((a, b) => a.position - b.position));
  /**
   * Bij een bankboeking: per regel op een klant of leverancier de factuur die
   * hij aflettert. Een boeking kan meerdere facturen tegelijk afletteren; de
   * verdeling (bank_transaction_allocations) zegt welke regel bij welke hoort,
   * op bedrag en relatie. Elke verdeelregel wordt één keer gebruikt.
   */
  const paymentRefs = (entry: JournalEntry, lines: JournalLine[]): Map<string, string> => {
    const out = new Map<string, string>();
    const pool = [...(allocationsByEntry.get(entry.id) ?? [])];
    for (const line of lines) {
      if (!line.client_id && !line.supplier_id) continue;
      const cents = Math.abs(line.debit_cents - line.credit_cents);
      const index = pool.findIndex(a => Math.abs(a.amount_cents) === cents
        && (line.client_id ? (a.client_id ?? line.client_id) === line.client_id : (a.supplier_id ?? line.supplier_id) === line.supplier_id)
        && (a.invoice_id || a.credit_note_id || a.purchase_invoice_id));
      if (index < 0) continue;
      const [a] = pool.splice(index, 1);
      const ref = a.kind === 'sales_credit_note' && a.credit_note_id ? creditNumber.get(a.credit_note_id)
        : a.purchase_invoice_id ? purchaseNumber.get(a.purchase_invoice_id)
        : a.invoice_id ? invoiceNumber.get(a.invoice_id)
        : undefined;
      if (ref) out.set(line.id, ref);
    }
    return out;
  };
  const invRefFor = (entry: JournalEntry, lines: JournalLine[]): (line: JournalLine) => string | null => {
    const doc = documentRef(entry);
    if (doc) return () => doc;
    if (entry.source_type === 'payment') {
      const refs = paymentRefs(entry, lines);
      return line => refs.get(line.id) ?? null;
    }
    return () => null;
  };

  // ---------------- Perioden (maanden binnen het boekjaar) ----------------
  const periods: string[] = [];
  const periodNumberOf = (date: string): number => {
    const [sy, sm] = startDate.split('-').map(Number);
    const [y, m] = date.split('-').map(Number);
    return (y - sy) * 12 + (m - sm) + 1;
  };
  {
    // Zolang er maanden in het boekjaar vallen, niet vast twaalf: een verlengd
    // eerste boekjaar (bijv. 1-7-2025 t/m 31-12-2026) had anders maar twaalf
    // perioden, terwijl een boeking in november 2026 periode 17 kreeg, die in
    // het bestand niet bestond. En de eerste periode begint op de startdatum,
    // niet op de eerste van die maand. Achttien maanden is het wettelijke
    // maximum voor een verlengd boekjaar; 36 is een ruime vangrail.
    const [sy, sm] = startDate.split('-').map(Number);
    for (let i = 0; i < 36; i++) {
      const y = sy + Math.floor((sm - 1 + i) / 12);
      const m = ((sm - 1 + i) % 12) + 1;
      const monthFirst = `${y}-${String(m).padStart(2, '0')}-01`;
      const first = i === 0 && startDate > monthFirst ? startDate : monthFirst;
      const monthLast = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      if (first > endDate) break;
      const last = monthLast > endDate ? endDate : monthLast;
      periods.push('<period>'
        + tag('periodNumber', i + 1)
        + tagMax('periodDesc', `Periode ${i + 1} (${first} t/m ${last})`, 50)
        + tag('startDatePeriod', first)
        + tag('endDatePeriod', last)
        + '</period>');
    }
  }

  // ---------------- Beginbalans ----------------
  // Balansstand per rekening uit alles vóór de startdatum; het cumulatieve
  // W&V-saldo van vóór het boekjaar (nog niet via jaarafsluiting bestemd)
  // wordt als één regel op de resultaatrekening gezet zodat de beginbalans
  // per constructie sluit (elke journaalpost is immers in balans).
  const obByAccount = new Map<string, number>();
  let obResult = 0;
  for (const entry of beforeYear) {
    for (const line of linesByEntry.get(entry.id) ?? []) {
      const account = accountById.get(line.account_id);
      const delta = line.debit_cents - line.credit_cents;
      if (!account || account.type === 'revenue' || account.type === 'expense') {
        obResult += delta;
      } else {
        obByAccount.set(line.account_id, (obByAccount.get(line.account_id) ?? 0) + delta);
      }
    }
  }
  const obLines: string[] = [];
  let obNr = 0;
  let obDebit = 0;
  let obCredit = 0;
  for (const [accountId, cents] of obByAccount) {
    if (cents === 0) continue;
    const account = accountById.get(accountId);
    obNr += 1;
    if (cents >= 0) obDebit += cents; else obCredit += -cents;
    obLines.push('<obLine>'
      + tag('nr', obNr)
      + tagMax('accID', account?.code ?? '????', 35)
      + tag('amnt', amt(cents))
      + tag('amntTp', amntTp(cents))
      + '</obLine>');
  }
  if (obResult !== 0) {
    const resultCode = data.ledgerAccounts.find(a => a.code === (company?.year_result_account_code || '0510'))?.code
      ?? data.ledgerAccounts.find(a => a.code === '0500')?.code ?? '0500';
    obNr += 1;
    if (obResult >= 0) obDebit += obResult; else obCredit += -obResult;
    obLines.push('<obLine>'
      + tag('nr', obNr)
      + tag('accID', resultCode)
      + tag('amnt', amt(obResult))
      + tag('amntTp', amntTp(obResult))
      + '</obLine>');
  }

  // ---------------- Transacties per dagboek ----------------
  let totalLines = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  const journalXml: string[] = [];
  for (const journal of JOURNALS) {
    const entries = inYear
      .filter(e => journal.sources.includes(e.source_type))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.entry_number ?? '').localeCompare(b.entry_number ?? '')));
    if (entries.length === 0) continue;
    const txXml = entries.map(entry => {
      const lines = linesByEntry.get(entry.id) ?? [];
      return transactionXml(entry, lines, {
        accountById, clientCode, supplierCode, periodNumberOf, vatCodes: data.vatCodes,
        invRef: invRefFor(entry, lines),
        onLine: (debit, credit) => { totalLines += 1; totalDebit += debit; totalCredit += credit; },
      });
    });
    journalXml.push('<journal>'
      + tag('jrnID', journal.jrnID)
      + tag('desc', journal.desc)
      + tag('jrnTp', journal.jrnTp)
      + txXml.join('')
      + '</journal>');
  }

  const header = '<header>'
    + tagMax('fiscalYear', fiscalYearLabel, 9)
    + tag('startDate', startDate)
    + tag('endDate', endDate)
    + tag('curCode', 'EUR')
    + tag('dateCreated', new Date().toISOString().slice(0, 10))
    + tag('softwareDesc', 'ResoFly')
    + tag('softwareVersion', '1.0')
    + '</header>';

  // taxRegIdent is bij de onderneming verplicht in het XSD (anders dan bij een
  // relatie). Zonder btw-nummer (bijvoorbeeld met de KOR) liet de export het
  // element weg, en was het bestand ongeldig; een leeg element mag wel.
  const companyXml = '<company>'
    + optMax('companyIdent', company?.kvk_number, 35)
    + tagMax('companyName', company?.company_name || 'Onbekend', 999)
    + tag('taxRegistrationCountry', 'NL')
    + tagMax('taxRegIdent', company?.vat_number ?? '', 30)
    + (company ? addressXml(company) : '')
    + `<customersSuppliers>${custSup.join('')}</customersSuppliers>`
    + `<generalLedger>${ledger.join('')}</generalLedger>`
    + `<vatCodes>${vat.join('')}</vatCodes>`
    + `<periods>${periods.join('')}</periods>`
    + '<openingBalance>'
    + tag('opBalDate', startDate)
    + tag('linesCount', obNr)
    + tag('totalDebit', amt(obDebit))
    + tag('totalCredit', amt(obCredit))
    + obLines.join('')
    + '</openingBalance>'
    + '<transactions>'
    + tag('linesCount', totalLines)
    + tag('totalDebit', amt(totalDebit))
    + tag('totalCredit', amt(totalCredit))
    + journalXml.join('')
    + '</transactions>'
    + '</company>';

  return `<?xml version="1.0" encoding="UTF-8"?>\n<auditfile xmlns="${XAF_NS}">${header}${companyXml}</auditfile>`;
}

function transactionXml(
  entry: JournalEntry,
  lines: JournalLine[],
  ctx: {
    accountById: Map<string, Pick<LedgerAccount, 'code' | 'type' | 'report_group'>>;
    clientCode: Map<string, string>;
    supplierCode: Map<string, string>;
    periodNumberOf: (date: string) => number;
    vatCodes: readonly VatCode[];
    invRef: (line: JournalLine) => string | null;
    onLine: (debit: number, credit: number) => void;
  },
): string {
  const totalDebit = lines.reduce((s, l) => s + l.debit_cents, 0);
  // IdentificationString35: een boekstuk zonder nummer kreeg zijn UUID (36
  // tekens, één te veel). Zonder streepjes past hij.
  const entryNr = fitXaf(entry.entry_number || entry.id.replace(/-/g, ''), 35);
  const lineXml = lines.map((line, i) => {
    ctx.onLine(line.debit_cents, line.credit_cents);
    const cents = line.debit_cents - line.credit_cents;
    const account = ctx.accountById.get(line.account_id);
    const custSupId = line.client_id
      ? ctx.clientCode.get(line.client_id)
      : line.supplier_id
        ? ctx.supplierCode.get(line.supplier_id)
        : undefined;
    // De kant van de btw-boeking, niet het teken van het bedrag: op een
    // omzetregel staat de btw credit (1510) en een negatief bedrag (creditnota,
    // tegenboeking) is debet; op een kosten- of activaregel is het andersom.
    const vatCents = line.vat_amount_cents ?? 0;
    const onRevenue = account?.type === 'revenue';
    const vatTp: 'D' | 'C' = onRevenue ? (vatCents >= 0 ? 'C' : 'D') : (vatCents >= 0 ? 'D' : 'C');
    const vatCode = xafVatCodeForLine(line, account, entry.source_type, ctx.vatCodes);
    const vatXml = vatCode
      ? '<vat>'
        + tagMax('vatID', vatCode.code, 35)
        + tag('vatPerc', vatPercent(line.vat_rate ?? vatCode.rate))
        + tag('vatAmnt', amt(vatCents))
        + tag('vatAmntTp', vatTp)
        + '</vat>'
      : '';
    const invRef = ctx.invRef(line);
    return '<trLine>'
      + tag('nr', i + 1)
      + tagMax('accID', account?.code ?? '????', 35)
      + tagMax('docRef', entryNr, 999)
      + tag('effDate', entry.date)
      + tag('desc', line.description ?? entry.description ?? '')
      + tag('amnt', amt(cents))
      + tag('amntTp', amntTp(cents))
      + (custSupId ? tag('custSupID', custSupId) : '')
      + optMax('invRef', invRef, 999)
      + vatXml
      + '</trLine>';
  }).join('');

  return '<transaction>'
    + tag('nr', entryNr)
    + tag('desc', entry.description ?? '')
    + tag('periodNumber', ctx.periodNumberOf(entry.date))
    + tag('trDt', entry.date)
    + tag('amnt', amt(totalDebit))
    + tag('amntTp', 'D')
    + lineXml
    + '</transaction>';
}

export function downloadXaf(input: XafInput): void {
  const xml = buildXaf(input);
  const orgSlug = (input.data.companySettings?.company_name || 'administratie')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auditfile-${orgSlug}-${input.fiscalYearLabel.replace(/[^0-9a-zA-Z-]/g, '')}.xaf`;
  a.click();
  URL.revokeObjectURL(url);
}
