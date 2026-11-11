/**
 * Een auditfile (XAF 3.x) uit een ander boekhoudpakket inlezen, voor wie naar
 * ResoFly overstapt. Bijna elk Nederlands pakket kan er een maken: Exact,
 * Twinfield, SnelStart, Moneybird, e-Boekhouden en ResoFly zelf
 * (src/lib/xaf.ts).
 *
 * Wat eruit komt (zie docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md):
 *  - de klanten en leveranciers;
 *  - per balansrekening het saldo op de overstapdatum, met een voorstel welke
 *    rekening van ResoFly erbij hoort. Dat vult de beginbalans; vastleggen
 *    blijft de bestaande knop.
 *
 * De oude boekingen zelf worden geen boekingen in ResoFly. Dan zouden ze
 * meetellen in btw-aangiftes die het oude pakket al deed, en in perioden die
 * daar al dicht zijn. Het XAF-bestand zelf hoort in het archief (bewaarplicht).
 *
 * Geen bibliotheek: een kleine XML-lezer volstaat voor dit vaste formaat, en
 * hij werkt in de browser én in `npm test` (geen DOMParser nodig).
 */

// ── XML ──────────────────────────────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/**
 * Loopt door de XML en meldt elk element met zijn pad en, als het alleen tekst
 * bevat, die tekst. Namespaces (xaf:ledgerAccount) worden weggelaten.
 */
function walkXml(xml: string, handlers: {
  open?: (path: string[]) => void;
  close: (path: string[], text: string | null) => void;
}): void {
  const path: string[] = [];
  let text = '';
  const hasChild: boolean[] = [];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    text += xml.slice(last, match.index);
    last = token.lastIndex;
    if (match[1] !== undefined) { text += match[1]; continue; }
    if (!match[3]) continue; // commentaar, declaratie, doctype
    const name = match[3].includes(':') ? match[3].slice(match[3].indexOf(':') + 1) : match[3];
    if (match[2] === '/') {
      if (path[path.length - 1] !== name) throw new Error(`Ongeldige XML: </${name}> sluit <${path[path.length - 1] ?? '?'}>.`);
      const leaf = !hasChild[hasChild.length - 1];
      handlers.close(path, leaf ? decodeEntities(text).trim() : null);
      path.pop();
      hasChild.pop();
      text = '';
    } else {
      if (hasChild.length) hasChild[hasChild.length - 1] = true;
      path.push(name);
      hasChild.push(false);
      text = '';
      handlers.open?.(path);
      if (match[5] === '/') {
        handlers.close(path, '');
        path.pop();
        hasChild.pop();
      }
    }
  }
  if (path.length) throw new Error(`Ongeldige XML: <${path[path.length - 1]}> is niet gesloten. Is het bestand compleet?`);
}

// ── Het bestand ──────────────────────────────────────────────────────────────

export interface XafRelation {
  id: string;
  name: string;
  /** C = klant, S = leverancier, B = beide; leeg als het pakket het niet zegt. */
  type: 'C' | 'S' | 'B' | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  kvkNumber: string | null;
  vatNumber: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  iban: string | null;
}

export interface XafAccount {
  code: string;
  name: string;
  /** B = balans, P = winst-en-verlies. */
  type: 'B' | 'P' | null;
}

export interface XafLine {
  account: string;
  date: string;
  /** Debet positief, credit negatief. */
  cents: number;
  relation: string | null;
}

export interface XafFile {
  version: string | null;
  software: string | null;
  fiscalYear: string | null;
  startDate: string | null;
  endDate: string | null;
  currency: string | null;
  companyName: string | null;
  kvkNumber: string | null;
  vatNumber: string | null;
  relations: XafRelation[];
  accounts: XafAccount[];
  openingDate: string | null;
  opening: XafLine[];
  lines: XafLine[];
}

/** "1234.56", "-0.5", "1234,56" → centen, zonder afrondingsfouten van kommagetallen. */
export function decimalToCents(raw: string): number {
  const text = raw.trim().replace(/\s/g, '');
  const normalized = text.includes(',') && !text.includes('.') ? text.replace(',', '.') : text;
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(normalized);
  if (!match || (!match[2] && !match[3])) throw new Error(`Ongeldig bedrag in de auditfile: "${raw}"`);
  const fraction = (match[3] ?? '').padEnd(3, '0');
  let cents = Number(match[2] || '0') * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  return match[1] === '-' ? -cents : cents;
}

function signed(amount: string | undefined, kind: string | undefined): number {
  if (!amount) return 0;
  const cents = decimalToCents(amount);
  return (kind ?? 'D').trim().toUpperCase() === 'C' ? -cents : cents;
}

const empty = (value: string | undefined): string | null => (value && value.trim() ? value.trim() : null);

/**
 * De tekst van een auditfile. Oudere pakketten schrijven windows-1252 of
 * ISO-8859-1 (staat in de XML-declaratie); dan zou "Café" als "CafÃ©" of met
 * vraagtekens binnenkomen als je het als UTF-8 leest.
 */
export function decodeXafBytes(bytes: Uint8Array): string {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
  const declared = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  const label = /^(iso-8859-1|latin-?1|windows-1252|cp1252)$/.test(declared) ? 'windows-1252' : 'utf-8';
  return new TextDecoder(label).decode(bytes);
}

export function parseXaf(xml: string): XafFile {
  if (/<auditfileVersion>\s*CLAIR/i.test(xml.slice(0, 4000))) {
    throw new Error('Dit is een auditfile van versie 2 (CLAIR). Maak in je oude pakket een XAF van versie 3, dan kan ResoFly hem lezen.');
  }
  const namespace = /xmlns(?::\w+)?\s*=\s*["'](http:\/\/www\.auditfiles\.nl\/XAF\/(3\.\d))["']/.exec(xml.slice(0, 4000));
  const file: XafFile = {
    version: namespace?.[2] ?? null, software: null, fiscalYear: null, startDate: null, endDate: null, currency: null,
    companyName: null, kvkNumber: null, vatNumber: null, relations: [], accounts: [], openingDate: null, opening: [], lines: [],
  };
  let sawRoot = false;
  // Velden van het element dat nu gelezen wordt, op hun pad eronder (bijv. "streetAddress/city").
  let record: Record<string, string> = {};
  let recordDepth = -1;
  let transactionDate = '';
  const RECORDS = new Set(['customerSupplier', 'ledgerAccount', 'obLine', 'trLine']);

  walkXml(xml, {
    open(path) {
      const name = path[path.length - 1];
      if (path.length === 1) sawRoot = name === 'auditfile';
      if (name === 'transaction') transactionDate = '';
      if (RECORDS.has(name) && recordDepth < 0) { record = {}; recordDepth = path.length; }
    },
    close(path, text) {
      const name = path[path.length - 1];
      const parent = path[path.length - 2];
      if (recordDepth > 0 && path.length > recordDepth) {
        const key = path.slice(recordDepth).join('/');
        if (text !== null && !(key in record)) record[key] = text;
        return;
      }
      if (recordDepth > 0 && path.length === recordDepth) {
        if (name === 'customerSupplier') {
          const tp = (record.custSupTp ?? '').trim().toUpperCase();
          const address = (field: string) => empty(record[`streetAddress/${field}`]) ?? empty(record[`postalAddress/${field}`]);
          const street = [address('streetname'), address('number'), address('numberExtension')].filter(Boolean).join(' ');
          file.relations.push({
            id: (record.custSupID ?? '').trim(),
            name: (record.custSupName ?? '').trim(),
            type: tp === 'C' || tp === 'S' || tp === 'B' ? tp : null,
            contact: empty(record.contact),
            email: empty(record.eMail),
            phone: empty(record.telephone),
            website: empty(record.website),
            kvkNumber: empty(record.commerceNr),
            vatNumber: empty(record.taxRegIdent),
            addressLine1: street || null,
            postalCode: address('postalCode'),
            city: address('city'),
            country: address('country'),
            iban: empty(record['bankAccount/bankAccNr']),
          });
        } else if (name === 'ledgerAccount') {
          const tp = (record.accTp ?? '').trim().toUpperCase();
          file.accounts.push({ code: (record.accID ?? '').trim(), name: (record.accDesc ?? '').trim(), type: tp === 'B' || tp === 'P' ? tp : null });
        } else if (name === 'obLine') {
          file.opening.push({ account: (record.accID ?? '').trim(), date: file.openingDate ?? file.startDate ?? '', cents: signed(record.amnt, record.amntTp), relation: empty(record.custSupID) });
        } else if (name === 'trLine') {
          const date = transactionDate || (record.effDate ?? '').trim();
          file.lines.push({ account: (record.accID ?? '').trim(), date, cents: signed(record.amnt, record.amntTp), relation: empty(record.custSupID) });
        }
        recordDepth = -1;
        record = {};
        return;
      }
      if (text === null) return;
      if (parent === 'header') {
        if (name === 'fiscalYear') file.fiscalYear = empty(text);
        else if (name === 'startDate') file.startDate = empty(text);
        else if (name === 'endDate') file.endDate = empty(text);
        else if (name === 'curCode') file.currency = empty(text);
        else if (name === 'softwareDesc') file.software = empty(text);
      } else if (parent === 'company') {
        if (name === 'companyName') file.companyName = empty(text);
        else if (name === 'companyIdent') file.kvkNumber = empty(text);
        else if (name === 'taxRegIdent') file.vatNumber = empty(text);
      } else if (parent === 'openingBalance' && name === 'opBalDate') {
        file.openingDate = empty(text);
      } else if (parent === 'transaction' && name === 'trDt') {
        transactionDate = text.trim();
      }
    },
  });
  if (!sawRoot) throw new Error('Dit is geen auditfile: het bestand begint niet met <auditfile>.');
  // De datum van de beginbalans kan pas na de regels in het bestand staan.
  for (const line of file.opening) if (!line.date) line.date = file.openingDate ?? file.startDate ?? '';
  return file;
}

// ── Saldi op de overstapdatum ────────────────────────────────────────────────

export interface XafBalance {
  code: string;
  name: string;
  type: 'B' | 'P' | null;
  /** Debet positief, credit negatief. */
  cents: number;
}

export interface XafBalances {
  /** Balansrekeningen met een saldo, op code. */
  balance: XafBalance[];
  /** Het resultaat (winst-en-verliesrekeningen) tot de overstapdatum. Debet = verlies. */
  resultCents: number;
  /** Debet min credit van alles wat meetelt; 0 als het bestand sluit. */
  differenceCents: number;
  warnings: string[];
}

/**
 * Het saldo per rekening aan het begin van de overstapdatum: de beginbalans
 * van het bestand plus alle boekingen vóór die dag. Boekingen op of na die dag
 * horen al bij ResoFly en tellen niet mee.
 */
export function balancesAt(file: XafFile, switchDate: string): XafBalances {
  const warnings: string[] = [];
  const accountByCode = new Map(file.accounts.map(a => [a.code, a]));
  const totals = new Map<string, number>();
  const add = (line: XafLine) => totals.set(line.account, (totals.get(line.account) ?? 0) + line.cents);
  for (const line of file.opening) add(line);
  let later = 0;
  for (const line of file.lines) {
    if (line.date && line.date < switchDate) add(line);
    else later += 1;
  }
  if (file.startDate && switchDate < file.startDate) {
    warnings.push(`De overstapdatum ligt vóór het begin van deze auditfile (${file.startDate}). Dan telt alleen de beginbalans van het bestand.`);
  }
  if (file.endDate && switchDate > addDays(file.endDate, 1)) {
    warnings.push(`De overstapdatum ligt na het einde van deze auditfile (${file.endDate}). Wat daartussen geboekt is, ontbreekt in deze saldi.`);
  }
  if (later > 0) warnings.push(`${later} boekingsregel(s) op of na de overstapdatum tellen niet mee: die horen al in ResoFly.`);

  const balance: XafBalance[] = [];
  let resultCents = 0;
  let differenceCents = 0;
  const unknown: string[] = [];
  for (const [code, cents] of totals) {
    differenceCents += cents;
    const account = accountByCode.get(code);
    if (!account) unknown.push(code);
    if (account?.type === 'P') { resultCents += cents; continue; }
    if (cents !== 0) balance.push({ code, name: account?.name ?? code, type: account?.type ?? null, cents });
  }
  if (unknown.length) warnings.push(`Rekening ${unknown.sort().join(', ')} staat niet in het rekeningschema van de auditfile; ResoFly behandelt hem als balansrekening.`);
  if (differenceCents !== 0) warnings.push('De auditfile sluit niet: debet en credit zijn niet gelijk. De sluitpost vangt het verschil op, maar kijk of het bestand compleet is.');
  balance.sort((a, b) => a.code.localeCompare(b.code, 'nl', { numeric: true }));
  return { balance, resultCents, differenceCents, warnings };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Koppelen aan het rekeningschema van ResoFly ──────────────────────────────

export interface TargetAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
  is_active?: boolean;
}

export interface AccountProposal {
  targetId: string | null;
  reason: string | null;
}

const normalize = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Woorden in de naam van de oude rekening → het soort rekening in ResoFly. */
const KEYWORDS: ReadonlyArray<{ test: RegExp; subtype: string; reason: string }> = [
  { test: /\b(btw|omzetbelasting|voorbelasting|vat)\b/, subtype: 'vat_payable', reason: 'Btw die het oude pakket al aangaf: op 1530, anders telt hij mee in je eerste aangifte in ResoFly.' },
  { test: /\bdebiteur/, subtype: 'accounts_receivable', reason: 'Debiteuren' },
  { test: /\bcrediteur/, subtype: 'accounts_payable', reason: 'Crediteuren' },
  // Ook een IBAN als naam, met of zonder spaties ("NL91 ABNA 0417 …").
  { test: /\b(bank|rabo|rabobank|ing|abn|amro|knab|bunq|triodos|sns|asn|revolut)\b|\bnl ?\d{2} ?[a-z]{4}\b/, subtype: 'bank', reason: 'Bank' },
  { test: /\bcum(ulatieve)? afschrijving|\bafschrijving(en)? (op|cum)/, subtype: 'accumulated_depreciation', reason: 'Cumulatieve afschrijving' },
  { test: /\b(inventaris|vaste activa|machines?|computers?|auto|bedrijfsauto|apparatuur|verbouwing)\b/, subtype: 'fixed_asset', reason: 'Vaste activa' },
  { test: /\b(prive opname|prive opnamen|onttrekking)/, subtype: 'private_withdrawals', reason: 'Privé-opnamen' },
  { test: /\b(prive storting|prive stortingen)/, subtype: 'private_contributions', reason: 'Privé-stortingen' },
  { test: /\b(onverdeeld|resultaat|winst)\b/, subtype: 'retained_earnings', reason: 'Resultaat' },
  { test: /\b(eigen vermogen|kapitaal|aandelenkapitaal)\b/, subtype: 'equity', reason: 'Eigen vermogen' },
];

const BALANCE_TYPES = new Set(['asset', 'liability', 'equity']);

/** Een voorstel per rekening uit de auditfile: dezelfde naam, dan een herkend woord, dan dezelfde code. */
export function proposeAccount(account: { code: string; name: string }, targets: TargetAccount[]): AccountProposal {
  const options = targets.filter(t => BALANCE_TYPES.has(t.type) && t.is_active !== false);
  const name = normalize(account.name);
  const byName = options.find(t => normalize(t.name) === name);
  if (byName) return { targetId: byName.id, reason: 'Zelfde naam' };
  for (const keyword of KEYWORDS) {
    if (!keyword.test.test(name)) continue;
    const wanted = keyword.subtype === 'equity'
      ? options.find(t => t.subtype === 'equity' || t.subtype === 'share_capital')
      : options.find(t => t.subtype === keyword.subtype);
    if (wanted) return { targetId: wanted.id, reason: keyword.reason };
  }
  const byCode = options.find(t => t.code === account.code);
  if (byCode) return { targetId: byCode.id, reason: 'Zelfde rekeningnummer' };
  return { targetId: null, reason: null };
}

/** Rekeningen waar een beginbalans dubbel btw geeft (zie de uitleg bij de beginbalans). */
export const VAT_RETURN_CODES: ReadonlySet<string> = new Set(['1500', '1510', '1520']);

export interface OpeningLineDraft {
  account_id: string;
  /** Debet positief, credit negatief. */
  cents: number;
}

/**
 * Regels voor de beginbalans: per rekening van ResoFly opgeteld, zonder nullen.
 * Een rekening zonder koppeling geeft een fout: dan zou de balans stilletjes
 * niet kloppen.
 */
export function openingLines(balances: XafBalance[], mapping: Readonly<Record<string, string | null | undefined>>): OpeningLineDraft[] {
  const missing = balances.filter(b => !mapping[b.code]).map(b => b.code);
  if (missing.length) throw new Error(`Kies eerst een rekening voor ${missing.join(', ')}.`);
  const sums = new Map<string, number>();
  for (const b of balances) {
    const target = mapping[b.code]!;
    sums.set(target, (sums.get(target) ?? 0) + b.cents);
  }
  return [...sums.entries()].filter(([, cents]) => cents !== 0).map(([account_id, cents]) => ({ account_id, cents }));
}

// ── Klanten en leveranciers ──────────────────────────────────────────────────

export interface ExistingRelation {
  name: string;
  vat_number?: string | null;
}

export interface RelationPlan {
  clients: Array<Record<string, unknown>>;
  suppliers: Array<Record<string, unknown>>;
  existing: number;
  /** Zonder soort (klant of leverancier) of zonder naam. */
  skipped: number;
}

const normalizeVat = (vat: string | null | undefined) => (vat ? vat.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
// Alleen de rechtsvorm eraf; "Jansen Holding" en "Jansen" blijven twee relaties.
const normalizeName = (name: string) => normalize(name).replace(/\b(b ?v|v ?o ?f|n ?v|c ?v)\b/g, '').replace(/\s+/g, ' ').trim();

/**
 * Welke relaties nieuw zijn. Al in ResoFly: hetzelfde btw-nummer, of dezelfde
 * naam zonder rechtsvorm ("Jansen B.V." = "Jansen"). Een relatie van soort B
 * wordt klant én leverancier.
 */
export function planRelations(file: XafFile, existingClients: ExistingRelation[], existingSuppliers: ExistingRelation[]): RelationPlan {
  const known = (list: ExistingRelation[]) => ({
    vat: new Set(list.map(r => normalizeVat(r.vat_number)).filter(Boolean)),
    name: new Set(list.map(r => normalizeName(r.name)).filter(Boolean)),
  });
  const clientsKnown = known(existingClients);
  const suppliersKnown = known(existingSuppliers);
  const isKnown = (set: { vat: Set<string>; name: Set<string> }, r: XafRelation) =>
    (normalizeVat(r.vatNumber) && set.vat.has(normalizeVat(r.vatNumber))) || set.name.has(normalizeName(r.name));
  const source = file.software ? ` uit ${file.software}` : '';
  const plan: RelationPlan = { clients: [], suppliers: [], existing: 0, skipped: 0 };
  for (const r of file.relations) {
    if (!r.name || !r.type) { plan.skipped += 1; continue; }
    const note = `Overgenomen${source}, relatienummer ${r.id || 'onbekend'}.`;
    const common = {
      name: r.name, contact_name: r.contact, email: r.email, phone: r.phone, vat_number: r.vatNumber, kvk_number: r.kvkNumber,
      address_line1: r.addressLine1, postal_code: r.postalCode, city: r.city, country: r.country, notes: note,
    };
    for (const kind of r.type === 'B' ? ['C', 'S'] as const : [r.type]) {
      if (kind === 'C') {
        if (isKnown(clientsKnown, r)) { plan.existing += 1; continue; }
        clientsKnown.name.add(normalizeName(r.name));
        if (normalizeVat(r.vatNumber)) clientsKnown.vat.add(normalizeVat(r.vatNumber));
        plan.clients.push(common);
      } else {
        if (isKnown(suppliersKnown, r)) { plan.existing += 1; continue; }
        suppliersKnown.name.add(normalizeName(r.name));
        if (normalizeVat(r.vatNumber)) suppliersKnown.vat.add(normalizeVat(r.vatNumber));
        plan.suppliers.push({ ...common, supplier_code: r.id || null, iban: r.iban });
      }
    }
  }
  return plan;
}
