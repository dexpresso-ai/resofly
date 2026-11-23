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

import { splitByShares } from './inkomstenbelasting.ts';

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
  /**
   * Regels in een dagboek van soort O (openingsbalans). Een pakket dat de
   * beginbalans als boekstuk in zo'n dagboek zet in plaats van in
   * <openingBalance>, heeft wel degelijk een beginbalans.
   */
  openingJournalLines?: number;
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
    openingJournalLines: 0,
  };
  let sawRoot = false;
  // Velden van het element dat nu gelezen wordt, op hun pad eronder (bijv. "streetAddress/city").
  let record: Record<string, string> = {};
  let recordDepth = -1;
  let transactionDate = '';
  let journalType = '';
  const RECORDS = new Set(['customerSupplier', 'ledgerAccount', 'obLine', 'trLine']);

  walkXml(xml, {
    open(path) {
      const name = path[path.length - 1];
      if (path.length === 1) sawRoot = name === 'auditfile';
      if (name === 'transaction') transactionDate = '';
      if (name === 'journal') journalType = '';
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
          if (journalType === 'O') file.openingJournalLines = (file.openingJournalLines ?? 0) + 1;
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
      } else if (parent === 'journal' && name === 'jrnTp') {
        journalType = text.trim().toUpperCase();
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
  /**
   * Het bestand heeft geen <openingBalance>: de saldi zijn dan alleen de
   * boekingen uit het bestand. Staat ook in `warnings`; het scherm vraagt er
   * een bevestiging voor.
   */
  missingOpening: boolean;
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
  // Zonder <openingBalance> zijn de saldi alleen de mutaties uit het bestand.
  // Een auditfile van 2024 zonder beginbalans gaf de bank € 210 in plaats van
  // € 3.210, en geen lening, inventaris of eigen vermogen, zonder één woord
  // erbij. Voor wie in dat jaar begon klopt het wel; daarom een waarschuwing
  // en geen fout.
  // Een dagboek van soort O (openingsbalans) telt als beginbalans. De auditfile
  // van het eerste jaar uit ResoFly zelf had zijn beginbalans tot november 2026
  // in zo'n dagboek, en kreeg hier dan ten onrechte de waarschuwing.
  const missingOpening = file.opening.length === 0 && !(file.openingJournalLines ?? 0);
  if (missingOpening) {
    const since = file.startDate ? ` vanaf ${dutchDate(file.startDate)}` : '';
    warnings.push(`Deze auditfile heeft geen beginbalans: de saldi hieronder zijn alleen de boekingen${since} uit dit bestand. Bestond je administratie daarvoor al, dan ontbreekt wat er toen stond (bank, leningen, activa, eigen vermogen). Maak in je oude pakket een auditfile mét beginbalans, of vul de beginbalans hieronder zelf aan.`);
  }

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
  return { balance, resultCents, differenceCents, missingOpening, warnings };
}

/** "2024-01-01" → "1-1-2024", zonder Intl: hetzelfde in de browser en in `npm test`. */
function dutchDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d}-${m}-${y}` : date;
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
  /** Waarom dit voorstel. Zonder voorstel (targetId null): waarom ResoFly er bewust geen doet, of null. */
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
  // Cumulatieve afschrijving staat niet hier maar in DEPRECIATION: die gaat
  // vóór een activawoord als "inventaris".
  { test: /\b(inventaris|vaste activa|machines?|computers?|auto|bedrijfsauto|apparatuur|verbouwing)\b/, subtype: 'fixed_asset', reason: 'Vaste activa' },
  { test: /\b(prive opname|prive opnamen|onttrekking)/, subtype: 'private_withdrawals', reason: 'Privé-opnamen' },
  { test: /\b(prive storting|prive stortingen)/, subtype: 'private_contributions', reason: 'Privé-stortingen' },
  { test: /\b(onverdeeld|resultaat|winst)\b/, subtype: 'retained_earnings', reason: 'Resultaat' },
  { test: /\b(eigen vermogen|kapitaal|aandelenkapitaal)\b/, subtype: 'equity', reason: 'Eigen vermogen' },
];

const BALANCE_TYPES = new Set(['asset', 'liability', 'equity']);

/**
 * Een lening, hypotheek, krediet, financiering, lease, creditcard,
 * spaarrekening of deposito is geen betaalrekening, ook niet als de naam van
 * een bank erin staat. Tot november 2026 herkende "Lening Rabobank" het woord
 * "rabobank" en ging naar 1100 Bank, net als "Creditcard ING" en
 * "Spaarrekening Rabobank". Vier rekeningen telden zo op tot één banksaldo:
 * € 3.210 op de bank en € 28.000 aan leningen werden "Bank € 24.290 credit",
 * en de lening stond nergens meer. "Lening auto" werd door het woord "auto"
 * bovendien een vast activum. Zo'n rekening krijgt daarom geen voorstel uit een
 * woord of een nummer: de gebruiker kiest (of maakt eerst) de juiste rekening.
 *
 * "verlening" (dienstverlening) is geen lening.
 */
function isNotPaymentAccount(name: string): boolean {
  return /lening|hypothe|krediet|financiering|lease|credit ?card|creditkaart|spaar|deposito|\b(loan|mortgage|savings?)\b/.test(name.replace(/verlening/g, ''));
}

const NOT_PAYMENT_ACCOUNT_REASON = 'Geen voorstel: een lening, krediet, lease, creditcard of spaarrekening is geen betaalrekening en hoort niet op 1100 Bank. Kies de rekening die erbij hoort, of maak hem eerst aan onder Rekeningschema.';

/**
 * Cumulatieve afschrijving, ook afgekort ("Cum. afschr. inventaris") of
 * zonder "cum." ("Afschrijving(en) inventaris"). Tot november 2026 herkende
 * ResoFly alleen "cumulatieve afschrijving" en "afschrijving op/cum"; daarna
 * won het woord "inventaris", en kwamen alle drie op 0100 Vaste activa. Daar
 * stond dan de aanschafwaarde min de afschrijving (netto € 2.100), en een
 * activum van vóór de start koppelen aan de beginbalans werd geweigerd. Niet
 * "afschrijvingskosten": dat is een kostenrekening.
 */
const DEPRECIATION = /\bafschr(ijving(en|sfonds)?)?\b|\bcum(ulatieve)? afschr/;

const NO_DEPRECIATION_ACCOUNT_REASON = 'Geen voorstel: dit is afschrijving, en er is geen rekening voor cumulatieve afschrijving (in het standaardschema 0150). Op de activarekening zelf klopt de aanschafwaarde niet meer. Maak die rekening eerst aan onder Rekeningschema, of kies zelf.';

/**
 * Een rekening-courant ("Rekening-courant vennoot Van Dam", "R/C Jansen") is
 * een schuld of vordering, geen eigen vermogen en geen privé. Tot november
 * 2026 kreeg zo'n rekening met oud nummer 0560 via "zelfde rekeningnummer"
 * 0560 Privé-stortingen (geen vennoot), en ging hij bij de jaarafsluiting naar
 * 0500.
 */
const CURRENT_ACCOUNT = /\b(rekening courant|r c|rc)\b/;
const PARTNER_WORD = /\b(vennoot|vennoten|firmant|firmanten)\b/;
const PRIVATE_SUBTYPES = new Set(['private_withdrawals', 'private_contributions', 'partner_withdrawals', 'partner_contributions']);

const CURRENT_ACCOUNT_REASON = 'Geen voorstel: een rekening-courant met een vennoot is een schuld of vordering, geen privé of eigen vermogen. Kies de schuld- of vorderingsrekening die erbij hoort, of maak hem eerst aan onder Rekeningschema.';

/** De naam van een vennotenrekening in ResoFly, genormaliseerd, zonder de vennoot. */
const PARTNER_PREFIX: Readonly<Record<string, string>> = {
  partner_capital: 'kapitaal ',
  partner_withdrawals: 'prive opnamen ',
  partner_contributions: 'prive stortingen ',
};

const PARTNER_KIND: Readonly<Record<string, string>> = {
  partner_capital: 'kapitaal',
  partner_withdrawals: 'privé-opnamen',
  partner_contributions: 'privé-stortingen',
};

/**
 * Tussenvoegsels. Tot november 2026 telde elk woord van drie letters als naam,
 * dus ook "van": "Kapitaal vennoot L. van Leeuwen" werd 0502 Kapitaal Jan van
 * Dam, en Jan stond in de beginbalans op € 10.000 in plaats van € 6.000.
 * "t" en "d" zijn wat er van 't en d' overblijft na normalize.
 */
const TUSSENVOEGSELS = new Set([
  'van', 'de', 'der', 'den', 'ter', 'ten', 'het', 'te', 't', 'd', 'in', 'op', 'aan', 'bij', 'uit', 'voor', 'onder', 'over',
  'vd', 'vande', 'vander', 'vanden', 'la', 'le', 'du', 'des', 'del', 'della', 'di', 'da', 'dos', 'el', 'von', 'zu',
]);

/** Woorden in de naam van een kapitaal- of privérekening die geen naam van een vennoot zijn. */
const NOT_A_NAME = new Set([
  'kapitaal', 'eigen', 'vermogen', 'vennoot', 'vennoten', 'firmant', 'firmanten', 'prive', 'opname', 'opnamen', 'opnames',
  'storting', 'stortingen', 'onttrekking', 'onttrekkingen', 'inbreng', 'rekening', 'courant', 'saldo', 'stand', 'per', 'begin',
  'eind', 'boekjaar', 'jaar', 'totaal', 'algemeen', 'overig', 'overige', 'en', 'of', 'met', 'naar', 'vof', 'cv', 'maatschap',
  'firma', 'onderneming', 'ondernemer', 'beherend', 'beherende', 'commanditair', 'commanditaire', 'stille',
]);

/**
 * De namen in een (genormaliseerde) rekeningnaam: zonder tussenvoegsels,
 * getallen en woorden als "kapitaal" of "vennoot". Losse letters zijn
 * voorletters ("l" uit "L. van Leeuwen"); "v d" (v/d) is een tussenvoegsel.
 */
function nameParts(text: string): { words: string[]; initials: string[]; startsWithName: boolean } {
  const tokens = text.split(' ').filter(Boolean);
  const words: string[] = [];
  const initials: string[] = [];
  // Begint de naam met een woord ("Anna Jansen"), dan is dat de voornaam; met
  // een voorletter of tussenvoegsel ("A. Jansen", "van Dam") is er geen.
  let startsWithName = false;
  let started = false;
  tokens.forEach((token, index) => {
    if (NOT_A_NAME.has(token) || /\d/.test(token)) return;
    const tussenvoegsel = TUSSENVOEGSELS.has(token) || (token === 'v' && TUSSENVOEGSELS.has(tokens[index + 1] ?? ''));
    if (tussenvoegsel) { started = true; return; }
    if (token.length === 1) { initials.push(token); started = true; return; }
    if (!started) startsWithName = true;
    started = true;
    words.push(token);
  });
  return { words, initials, startsWithName };
}

interface Partner {
  /** "Anna Jansen", voor de uitleg. */
  label: string;
  /** De voornaam, als die er staat ("anna"). */
  given: string | null;
  /** De achternaam zonder tussenvoegsels ("dam" van "Jan van Dam"). */
  surname: string[];
  initials: string[];
  accounts: TargetAccount[];
}

/**
 * De vennoten, uit hun rekeningen 050n, 055n en 056n. Per vennootnummer (het
 * laatste cijfer), zodat privé en kapitaal van dezelfde vennoot samen tellen:
 * "Privé-opnamen Jansen" moet ook twijfelen als maar één Jansen al een
 * opnamenrekening heeft.
 */
function partnersFrom(options: TargetAccount[]): Partner[] {
  const byKey = new Map<string, Partner>();
  for (const target of options) {
    if (!target.subtype || !(target.subtype in PARTNER_PREFIX)) continue;
    const label = target.name.trim().replace(/^\S+\s+/, '');
    const parts = nameParts(normalize(label));
    const key = /^05[056][1-9]$/.test(target.code) ? `n${target.code[3]}` : parts.words.join(' ');
    const existing = byKey.get(key);
    if (existing) {
      existing.accounts.push(target);
      if (target.subtype === 'partner_capital') existing.label = label;
      continue;
    }
    const given = parts.startsWithName && parts.words.length >= 2 ? parts.words[0] : null;
    byKey.set(key, { label, given, surname: given ? parts.words.slice(1) : parts.words, initials: parts.initials, accounts: [target] });
  }
  return [...byKey.values()];
}

const partnerWords = (p: Partner) => (p.given ? [p.given, ...p.surname] : p.surname);

/** Past een voorletter uit de oude rekening bij deze vennoot? Zonder voorletters: ja. */
function initialsFit(p: Partner, initials: string[]): boolean {
  if (initials.length === 0) return true;
  const letters = [...(p.given ? [p.given[0]] : []), ...p.initials];
  return letters.length === 0 || initials.some(i => letters.includes(i));
}

const listNames = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`);

/**
 * Bij een vof, maatschap of cv: het kapitaal of het privé van één vennoot,
 * herkend aan zijn naam ("Kapitaal vennoot B. de Vries" → 0502 Kapitaal Bram
 * de Vries). Tot november 2026 ging zo'n rekening naar het algemene 0500 of
 * 0550, en stond het hele beginvermogen daarna op geen enkele vennoot.
 *
 * De achternaam beslist; tussenvoegsels, voorletters en woorden als
 * "vennoot" tellen niet. Een voornaam alleen ("Privé-opnamen Anna") mag, als
 * er verder niets in de naam staat. Noemt de rekening iemand die niet in
 * ResoFly staat, of passen twee vennoten (Anna en Piet Jansen), dan geen
 * voorstel. Tot november 2026 viel zo'n rekening dan terug op 0500 of 0550,
 * met een voorstel; de changelog van 18 november beloofde er juist geen.
 *
 * Geeft null als de rekening geen kapitaal of privé is, er geen vennoten
 * zijn, of er geen naam in staat: dan beslist de rest van proposeAccount.
 */
function partnerProposal(name: string, partners: Partner[]): AccountProposal | null {
  const subtype = /\b(prive opname|prive opnamen|onttrekking)/.test(name) ? 'partner_withdrawals'
    : /\b(prive storting|prive stortingen)/.test(name) ? 'partner_contributions'
    : /\b(kapitaal|eigen vermogen)\b/.test(name) ? 'partner_capital'
    : null;
  if (!subtype || partners.length === 0) return null;
  const { words, initials } = nameParts(name);
  if (words.length === 0) return null;

  const explains = (p: Partner) => words.every(w => partnerWords(p).includes(w));
  const bySurname = partners.filter(p => p.surname.some(w => words.includes(w)));
  // Een voorletter beslist tussen twee Jansens ("A. Jansen"), en sluit uit
  // wie niet past ("L. Jansen" is geen Anna Jansen).
  const found = (bySurname.length > 0
    ? bySurname.filter(explains)
    : partners.filter(p => p.given !== null && words.includes(p.given) && explains(p))
  ).filter(p => initialsFit(p, initials));

  if (found.length === 0) {
    // Twee vennoten in één naam ("Kapitaal Jansen en De Vries") is twijfel;
    // een naam die bij niemand hoort ("L. van Leeuwen") is een onbekende vennoot.
    const named = partners.filter(p => p.surname.some(w => words.includes(w)) && initialsFit(p, initials));
    if (named.length > 1 && words.every(w => named.some(p => partnerWords(p).includes(w)))) {
      return { targetId: null, reason: `Geen voorstel: deze naam past bij ${named.length === 2 ? 'twee' : named.length} vennoten (${listNames(named.map(p => p.label))}). Kies zelf van wie deze rekening is.` };
    }
    return { targetId: null, reason: 'Geen voorstel: deze rekening noemt een vennoot die niet in ResoFly staat. Leg die vennoot eerst vast bij Vennoten, of kies zelf de rekening.' };
  }
  if (found.length > 1) {
    return { targetId: null, reason: `Geen voorstel: deze naam past bij ${found.length === 2 ? 'twee' : found.length} vennoten (${listNames(found.map(p => p.label))}). Kies zelf van wie deze rekening is.` };
  }
  const target = found[0].accounts.find(t => t.subtype === subtype);
  return target
    ? { targetId: target.id, reason: 'Vennoot' }
    : { targetId: null, reason: `Geen voorstel: ${found[0].label} heeft in ResoFly geen rekening voor ${PARTNER_KIND[subtype]}. Kies zelf de rekening.` };
}

/** Een voorstel per rekening uit de auditfile: dezelfde naam, dan een herkend woord, dan dezelfde code. */
export function proposeAccount(account: { code: string; name: string }, targets: TargetAccount[]): AccountProposal {
  const options = targets.filter(t => BALANCE_TYPES.has(t.type) && t.is_active !== false);
  const name = normalize(account.name);
  const byName = options.find(t => normalize(t.name) === name);
  if (byName) return { targetId: byName.id, reason: 'Zelfde naam' };
  if (isNotPaymentAccount(name)) {
    // Alleen hetzelfde nummer bij een rekening die zelf ook zo heet ("0700
    // Leningen" voor "0700 Lening Rabobank"); nooit de bank, en geen woord
    // als "rabobank" of "auto" uit de naam.
    const sameKind = options.find(t => t.code === account.code && t.subtype !== 'bank' && isNotPaymentAccount(normalize(t.name)));
    return sameKind ? { targetId: sameKind.id, reason: 'Zelfde rekeningnummer' } : { targetId: null, reason: NOT_PAYMENT_ACCOUNT_REASON };
  }
  if (DEPRECIATION.test(name)) {
    const wanted = options.find(t => t.subtype === 'accumulated_depreciation')
      ?? options.find(t => t.code === account.code && DEPRECIATION.test(normalize(t.name)));
    return wanted ? { targetId: wanted.id, reason: 'Cumulatieve afschrijving' } : { targetId: null, reason: NO_DEPRECIATION_ACCOUNT_REASON };
  }
  const partners = partnersFrom(options);
  const partner = partnerProposal(name, partners);
  if (partner) return partner;
  for (const keyword of KEYWORDS) {
    if (!keyword.test.test(name)) continue;
    const wanted = keyword.subtype === 'equity'
      ? options.find(t => t.subtype === 'equity' || t.subtype === 'share_capital')
      : options.find(t => t.subtype === keyword.subtype);
    if (wanted) return { targetId: wanted.id, reason: keyword.reason };
  }
  const byCode = options.find(t => t.code === account.code);
  if (byCode) {
    if (CURRENT_ACCOUNT.test(name) && (byCode.type === 'equity' || PRIVATE_SUBTYPES.has(byCode.subtype ?? ''))) {
      return { targetId: null, reason: CURRENT_ACCOUNT_REASON };
    }
    const words = nameParts(name).words;
    const namesPartner = PARTNER_WORD.test(name) || partners.some(p => p.surname.some(w => words.includes(w)));
    if (namesPartner && (byCode.subtype === 'private_withdrawals' || byCode.subtype === 'private_contributions')) {
      return { targetId: null, reason: `Geen voorstel: deze rekening noemt een vennoot, en ${byCode.code} ${byCode.name} is van geen enkele vennoot. Kies de rekening van die vennoot, of maak hem eerst aan onder Rekeningschema.` };
    }
    return { targetId: byCode.id, reason: 'Zelfde rekeningnummer' };
  }
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
 * niet kloppen. `extra` zijn regels die er los bij komen, zoals het resultaat
 * per vennoot (splitResultOverPartners); ze tellen op bij dezelfde rekening.
 */
export function openingLines(
  balances: XafBalance[],
  mapping: Readonly<Record<string, string | null | undefined>>,
  extra: ReadonlyArray<OpeningLineDraft> = [],
): OpeningLineDraft[] {
  const missing = balances.filter(b => !mapping[b.code]).map(b => b.code);
  if (missing.length) throw new Error(`Kies eerst een rekening voor ${missing.join(', ')}.`);
  const sums = new Map<string, number>();
  for (const b of balances) {
    const target = mapping[b.code]!;
    sums.set(target, (sums.get(target) ?? 0) + b.cents);
  }
  for (const line of extra) sums.set(line.account_id, (sums.get(line.account_id) ?? 0) + line.cents);
  return [...sums.entries()].filter(([, cents]) => cents !== 0).map(([account_id, cents]) => ({ account_id, cents }));
}

// ── Het resultaat tot de overstapdatum, bij een vof ──────────────────────────

export interface PartnerShare {
  /** De kapitaalrekening van de vennoot (050n). */
  capitalAccountId: string;
  name: string;
  /** Het vennootnummer: bij een gelijke rest krijgt het laagste de cent. */
  partnerNumber: number;
  /** Winstaandeel in basispunten (5000 = 50%). */
  basisPoints: number;
}

export interface ResultShareLine extends OpeningLineDraft {
  name: string;
  basisPoints: number;
}

export type ResultSplit =
  | { kind: 'split'; lines: ResultShareLine[] }
  | { kind: 'no_partners' }
  | { kind: 'shares_not_100'; totalBasisPoints: number };

/**
 * Bij een vof, maatschap of cv die halverwege het jaar overstapt: het
 * resultaat tot de overstapdatum per vennoot op zijn kapitaalrekening, naar
 * zijn winstaandeel. Zonder dit kwam het als sluitpost op 0500: de winst van
 * januari t/m juni (€ 12.000) stond op geen enkele vennoot en werd nooit
 * verdeeld, en het winstaandeel bij Vennoten was alleen dat van de tweede
 * helft.
 *
 * Tot op de cent sluitend, met dezelfde afronding als de jaarafsluiting
 * (splitByShares, gelijk aan partnership_result_shares). Telt de verdeling
 * niet op tot 100%, dan niets: die weigert de jaarafsluiting ook, en een
 * verdeling die niet sluit zou een rest op 0500 laten.
 *
 * `resultCents` zoals balancesAt het geeft: credit (negatief) is winst. Een
 * regel is dus credit bij winst en debet bij verlies.
 */
export function splitResultOverPartners(resultCents: number, partners: ReadonlyArray<PartnerShare>): ResultSplit {
  if (partners.length === 0) return { kind: 'no_partners' };
  const totalBasisPoints = partners.reduce((sum, p) => sum + p.basisPoints, 0);
  if (totalBasisPoints !== 10000) return { kind: 'shares_not_100', totalBasisPoints };
  const shares = splitByShares(resultCents, partners.map(p => ({ key: p.capitalAccountId, basisPoints: p.basisPoints, order: p.partnerNumber })));
  const lines = [...partners]
    .sort((a, b) => a.partnerNumber - b.partnerNumber)
    .map(p => ({ account_id: p.capitalAccountId, cents: shares.get(p.capitalAccountId) ?? 0, name: p.name, basisPoints: p.basisPoints }))
    .filter(line => line.cents !== 0);
  return { kind: 'split', lines };
}

const euroText = (cents: number) => {
  const abs = Math.abs(Math.trunc(cents));
  return `€ ${Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(abs % 100).padStart(2, '0')}`;
};

/** De eigen-vermogensrekeningen waar samenkomen opvalt: 0500 en die van elke vennoot (050n, 055n, 056n). */
const OWNER_SUBTYPES = new Set(['equity', 'partner_capital', 'partner_withdrawals', 'partner_contributions']);

/**
 * Wat er aan de gekozen koppeling niet lijkt te kloppen:
 *  - meer dan één rekening uit de auditfile komt samen op een bankrekening
 *    van ResoFly (subtype bank, 1100). openingLines telt ze stil op; een
 *    lening of creditcard die de gebruiker zelf op de bank zet, verdwijnt dan
 *    in één saldo;
 *  - een bankrekening komt credit uit. Een betaalrekening staat zelden rood:
 *    meestal zit er dan een schuld tussen;
 *  - meer dan één rekening komt samen op 0500 of op een rekening van één
 *    vennoot. Tot november 2026 kwam "Kapitaal vennoot L. van Leeuwen" zo bij
 *    het kapitaal van Jan van Dam: Jan stond op € 10.000 in plaats van
 *    € 6.000, zonder één woord.
 * Het scherm toont ze en vraagt een bevestiging vóór het overnemen; tot
 * november 2026 ging "Zet in de beginbalans" zonder vraag door.
 */
export function mappingWarnings(
  balances: XafBalance[],
  mapping: Readonly<Record<string, string | null | undefined>>,
  targets: TargetAccount[],
): string[] {
  const warnings: string[] = [];
  for (const target of targets) {
    if (!OWNER_SUBTYPES.has(target.subtype ?? '')) continue;
    const sources = balances.filter(b => mapping[b.code] === target.id && b.cents !== 0);
    if (sources.length < 2) continue;
    const list = `${target.code} ${target.name}: ${sources.map(b => `${b.code} ${b.name}`).join(', ')}`;
    warnings.push(target.subtype === 'equity'
      ? `${sources.length} rekeningen uit de auditfile komen samen op ${list}. Ze worden één saldo, op geen enkele vennoot. Bij een eenmanszaak is dat goed. Is het kapitaal of privé van verschillende vennoten, zet het dan op de rekening van elke vennoot; een vennoot die nog niet in ResoFly staat, leg je eerst vast bij Vennoten.`
      : `${sources.length} rekeningen uit de auditfile komen samen op ${list}. Ze worden één saldo, van één vennoot. Klopt dat niet, kies dan bij elke rekening de vennoot van wie hij is; een vennoot die nog niet in ResoFly staat, leg je eerst vast bij Vennoten.`);
  }
  for (const target of targets) {
    if (target.subtype !== 'bank') continue;
    const sources = balances.filter(b => mapping[b.code] === target.id && b.cents !== 0);
    if (sources.length === 0) continue;
    const label = `${target.code} ${target.name}`;
    if (sources.length > 1) {
      warnings.push(`${sources.length} rekeningen uit de auditfile komen samen op ${label}: ${sources.map(b => `${b.code} ${b.name}`).join(', ')}. Ze worden één saldo. Dat klopt alleen als het allemaal betaalrekeningen zijn; een lening, creditcard of spaarrekening hoort op een eigen rekening.`);
    }
    const total = sources.reduce((sum, b) => sum + b.cents, 0);
    if (total < 0) {
      warnings.push(`${label} komt uit op ${euroText(total)} credit: een schuld aan de bank. Sta je niet rood, kijk dan of er een lening, krediet of creditcard op deze rekening is gezet.`);
    }
  }
  return warnings;
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
