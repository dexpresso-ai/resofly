import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { normalizeDate } from './dedup.ts';

/**
 * Bankexports zonder kopregel: ABN AMRO (TXT), ASN Bank, SNS en RegioBank
 * (CSV) en Triodos (CSV).
 *
 * Waarom een eigen lezer. De gewone CSV-lezer zoekt de kolommen op hun naam in
 * de eerste regel. Deze banken geven geen namen mee: de eerste regel is al een
 * mutatie. Het bestand werd geweigerd met "Kon de datum- of bedragkolom niet
 * herkennen", en de zzp'er liep vast met de export die zijn bank standaard
 * geeft (controle bank van 22 november 2026, bevinding 8).
 *
 * Zonder kolomnamen is een vaste indeling de enige weg, en een verkeerde vaste
 * indeling leest stil verkeerd. Daarom leest deze lezer alleen wat hij zeker
 * weet:
 *
 *   - elke regel moet precies de vorm van die bank hebben (aantal kolommen, waar
 *     de datums, het eigen rekeningnummer, de valuta en de bedragen staan);
 *   - waar het bestand een saldo per regel heeft (ABN AMRO, ASN/SNS/RegioBank)
 *     rekenen we dat na: saldo + mutatie = volgend saldo. Klopt die som, dan
 *     staan het bedrag en het teken in de kolom die wij denken. Klopt hij
 *     nergens, dan lezen we niet;
 *   - bij Triodos staat de richting er in woorden bij (Debet of Credit).
 *
 * Past een bestand zonder kopregel bij geen van de drie, dan komt er een
 * melding die zegt wat wel werkt (CAMT.053 of MT940), in plaats van een gok.
 *
 * De indelingen komen uit de formaatbeschrijvingen van de banken zoals wij ze
 * kennen; er waren bij het bouwen geen echte exports. De controles hierboven
 * zijn er juist daarvoor: wijkt een echt bestand af, dan weigert de lezer het
 * met uitleg en leest hij niets verkeerd in.
 */

type Row = {
  account: string;
  date: string;
  valueDate: string | null;
  cents: number;
  /** Saldo vóór en na deze mutatie, als het bestand dat geeft. */
  before: number | null;
  after: number | null;
  name: string | null;
  iban: string | null;
  description: string | null;
  /** Betalingskenmerk. */
  reference: string | null;
  /** End-to-end-kenmerk van de opdrachtgever. */
  endToEnd: string | null;
};

type Matched = { bank: string; rows: Row[]; warnings: string[]; opening: number | null; closing: number | null };

/** Een regel splitsen met respect voor dubbele aanhalingstekens. */
function splitQuoted(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; } else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(cell => cell.trim());
}

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Bedrag met een punt als decimaalteken en precies twee decimalen: "1210.00", "-45.50". Anders null. */
function centsDot(raw: string): number | null {
  const s = raw.trim();
  if (!/^[+-]?\d+\.\d{2}$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Bedrag met een komma als decimaalteken: "1210,00", "1.210,00", "-12,34". Anders null. */
function centsComma(raw: string): number | null {
  const s = raw.trim();
  if (!/^[+-]?(\d{1,3}(\.\d{3})+|\d+),\d{2}$/.test(s)) return null;
  return Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
}

const dateDmy = (raw: string): string | null => (/^\d{2}-\d{2}-\d{4}$/.test(raw.trim()) ? normalizeDate(raw) : null);
const dateYmd = (raw: string): string | null => (/^\d{8}$/.test(raw.trim()) ? normalizeDate(raw) : null);

/**
 * Loopt het saldo door van regel naar regel? Per rekening, in de volgorde van
 * het bestand of andersom (nieuwste eerst). Geeft het aandeel overgangen dat
 * klopt en, als alles klopt, het begin- en eindsaldo.
 */
function balanceChain(rows: Row[]): { checked: number; ok: number; opening: number | null; closing: number | null } {
  const run = (list: Row[]) => {
    let ok = 0;
    for (let i = 0; i < list.length - 1; i += 1) {
      if (list[i].after !== null && list[i].after === list[i + 1].before) ok += 1;
    }
    return ok;
  };
  const checked = Math.max(rows.length - 1, 0);
  const forward = run(rows);
  const backward = run([...rows].reverse());
  const ordered = forward >= backward ? rows : [...rows].reverse();
  const ok = Math.max(forward, backward);
  const complete = checked > 0 && ok === checked;
  return {
    checked,
    ok,
    opening: complete ? ordered[0].before : null,
    closing: complete ? ordered[ordered.length - 1].after : null,
  };
}

// ── ABN AMRO: TXT met tabs ───────────────────────────────────────────────────
// rekeningnummer · valuta · datum (jjjjmmdd) · beginsaldo · eindsaldo ·
// rentedatum (jjjjmmdd) · bedrag · omschrijving

/** De omschrijving van ABN AMRO: /TRTP/…/IBAN/…/NAME/…/REMI/…, of "IBAN: … Naam: … Omschrijving: …", of vrije tekst (pin). */
function abnDescription(raw: string): { name: string | null; iban: string | null; description: string | null; endToEnd: string | null } {
  const text = raw.trim();
  if (text.startsWith('/')) {
    const parts = text.split('/').slice(1);
    const fields: Record<string, string> = {};
    const KEYS = new Set(['TRTP', 'IBAN', 'BIC', 'NAME', 'REMI', 'EREF', 'CSID', 'MARF', 'ORDP', 'ID', 'ADDR', 'RTRN', 'BENM', 'ISDT', 'PREF', 'NRTX', 'PURP']);
    let key: string | null = null;
    for (const part of parts) {
      if (KEYS.has(part)) { key = part; fields[key] = fields[key] ?? ''; continue; }
      if (key) fields[key] = fields[key] ? `${fields[key]}/${part}` : part;
    }
    const eref = fields.EREF && fields.EREF !== 'NOTPROVIDED' ? fields.EREF.trim() : null;
    return {
      name: fields.NAME?.trim() || null,
      iban: fields.IBAN?.replace(/\s+/g, '') || null,
      description: fields.REMI?.trim() || fields.TRTP?.trim() || null,
      endToEnd: eref,
    };
  }
  const labelled = /IBAN:\s*([A-Z]{2}\d{2}[A-Z0-9]+)/.exec(text);
  if (labelled) {
    const name = /Naam:\s*(.+?)(?=\s{2,}|\s+(?:Omschrijving|Kenmerk|Machtiging|Incassant|Voor):|$)/.exec(text)?.[1]?.trim() ?? null;
    const description = /Omschrijving:\s*(.+?)(?=\s+(?:Kenmerk|Machtiging|Incassant|Voor|IBAN|BIC):|$)/.exec(text)?.[1]?.trim() ?? null;
    return { name, iban: labelled[1], description: description || text.replace(/\s{2,}/g, ' '), endToEnd: null };
  }
  return { name: null, iban: null, description: text.replace(/\s{2,}/g, ' ') || null, endToEnd: null };
}

function matchAbnAmro(lines: string[]): Matched | null {
  const rows: Row[] = [];
  for (const line of lines) {
    const c = line.split('\t').map(cell => cell.trim());
    if (c.length !== 8) return null;
    const date = dateYmd(c[2]);
    const valueDate = dateYmd(c[5]);
    const before = centsComma(c[3]);
    const after = centsComma(c[4]);
    const cents = centsComma(c[6]);
    if (!/^\d{6,10}$/.test(c[0]) && !IBAN.test(c[0])) return null;
    if (!CURRENCY.test(c[1]) || !date || !valueDate || before === null || after === null || cents === null) return null;
    const d = abnDescription(c[7]);
    rows.push({ account: c[0], date, valueDate, cents, before, after, name: d.name, iban: d.iban, description: d.description, reference: null, endToEnd: d.endToEnd });
  }
  // De som moet op elke regel kloppen: beginsaldo + bedrag = eindsaldo. Dat is
  // het bewijs dat het bedrag in kolom 7 staat en het teken klopt. Sommige
  // exports geven het saldo per dag in plaats van per regel; dan moet het per
  // dag kloppen.
  const perLine = rows.every(r => (r.before as number) + r.cents === r.after);
  if (!perLine) {
    const days = new Map<string, Row[]>();
    for (const r of rows) days.set(`${r.account}|${r.date}`, [...(days.get(`${r.account}|${r.date}`) ?? []), r]);
    const perDay = [...days.values()].every(list =>
      list.every(r => r.before === list[0].before && r.after === list[0].after)
      && (list[0].before as number) + list.reduce((sum, r) => sum + r.cents, 0) === list[0].after);
    if (!perDay) return null;
    const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    return { bank: 'ABN AMRO', rows, warnings: [], opening: ordered[0].before, closing: ordered[ordered.length - 1].after };
  }
  const chain = balanceChain(rows);
  const single = rows.length === 1;
  return {
    bank: 'ABN AMRO', rows, warnings: [],
    opening: single ? rows[0].before : chain.opening,
    closing: single ? rows[0].after : chain.closing,
  };
}

// ── ASN Bank, SNS en RegioBank: CSV met komma's, 19 kolommen ─────────────────
//  1 boekdatum · 2 eigen rekening · 3 tegenrekening · 4 naam · 5-7 adres ·
//  8 valuta rekening · 9 saldo vóór de mutatie · 10 valuta mutatie · 11 bedrag ·
// 12 journaaldatum · 13 valutadatum · 14 interne code · 15 soort (3 letters) ·
// 16 volgnummer · 17 betalingskenmerk · 18 omschrijving · 19 afschriftnummer

function matchVolksbank(lines: string[]): Matched | null {
  const rows: Row[] = [];
  for (const line of lines) {
    const c = splitQuoted(line, ',');
    if (c.length !== 19) return null;
    const date = dateDmy(c[0]);
    const before = centsDot(c[8]);
    const cents = centsDot(c[10]);
    if (!date || !dateDmy(c[11]) || !dateDmy(c[12])) return null;
    if (!IBAN.test(c[1]) || !/^NL\d{2}(ASNB|SNSB|RBRB)/.test(c[1])) return null;
    if (!CURRENCY.test(c[7]) || !CURRENCY.test(c[9]) || before === null || cents === null) return null;
    if (!/^[A-Z]{3}$/.test(c[14]) || !/^\d+$/.test(c[15])) return null;
    const description = c[17].replace(/^'|'$/g, '').replace(/\s{2,}/g, ' ').trim();
    const counter = c[2].replace(/\s+/g, '');
    rows.push({
      account: c[1], date, valueDate: dateDmy(c[12]), cents, before, after: before + cents,
      name: c[3] || null, iban: counter || null, description: description || null, reference: c[16].trim() || null, endToEnd: null,
    });
  }
  const warnings: string[] = [];
  const chain = balanceChain(rows);
  // Eén regel kunnen we niet narekenen, en een export met een filter (alleen
  // ontvangsten) heeft gaten. Klopt het saldo nergens, dan staat het bedrag
  // of het saldo niet waar wij denken: niet lezen. Ook niet bij twee regels:
  // eerst stond hier ">= 2 overgangen", en dan las een bestand van twee regels
  // met bedrag en saldo omgewisseld gewoon in, met alleen een waarschuwing.
  if (chain.checked >= 1 && chain.ok === 0) return null;
  if (chain.checked > 0 && chain.ok < chain.checked) {
    warnings.push(`Het saldo in dit bestand loopt niet overal door (${chain.checked - chain.ok} keer een sprong). Er ontbreken regels, of het is een export met een filter. Controleer of de periode compleet is.`);
  }
  if (chain.checked === 0) {
    warnings.push('Dit bestand heeft één regel, dus ResoFly kon de indeling niet narekenen aan het saldo. Controleer het bedrag en of het een ontvangst of een uitgave is.');
  }
  const bank = /SNSB/.test(rows[0].account) ? 'SNS' : /RBRB/.test(rows[0].account) ? 'RegioBank' : 'ASN Bank';
  return { bank, rows, warnings, opening: chain.opening, closing: chain.closing };
}

// ── Triodos: CSV met komma's, 8 kolommen (soms een 9e met het saldo) ─────────
// 1 datum · 2 eigen rekening · 3 bedrag (altijd positief) · 4 Debet/Credit ·
// 5 naam · 6 tegenrekening · 7 code (2 letters) · 8 omschrijving

function matchTriodos(lines: string[]): Matched | null {
  const rows: Row[] = [];
  for (const line of lines) {
    const c = splitQuoted(line, ',');
    if (c.length !== 8 && c.length !== 9) return null;
    const date = dateDmy(c[0]);
    const amount = centsComma(c[2]);
    const direction = c[3].toLowerCase();
    if (!date || !IBAN.test(c[1]) || !/^NL\d{2}TRIO/.test(c[1])) return null;
    if (amount === null || amount < 0 || (direction !== 'debet' && direction !== 'credit')) return null;
    if (!/^[A-Z0-9]{2}$/.test(c[6])) return null;
    if (c.length === 9 && c[8] !== '' && centsComma(c[8]) === null) return null;
    const counter = c[5].replace(/\s+/g, '');
    rows.push({
      account: c[1], date, valueDate: null, cents: direction === 'debet' ? -amount : amount, before: null, after: null,
      name: c[4] || null, iban: counter || null, description: c[7].replace(/\s{2,}/g, ' ').trim() || null, reference: null, endToEnd: null,
    });
  }
  return { bank: 'Triodos', rows, warnings: [], opening: null, closing: null };
}

/** Is de eerste regel al een mutatie (er staat een datum in) en dus geen kopregel? */
export function looksHeaderless(firstLine: string): boolean {
  // Elk scheidingsteken proberen, niet alleen het meest voorkomende: in een
  // ABN AMRO-TXT staan in de omschrijving van een pinbetaling vaak meer
  // komma's dan er tabs in de regel zitten. Dan won de komma, stond de datum
  // midden in een cel, en ging het bestand toch naar de lezer met kolomnamen.
  return ['\t', ';', ','].some(delim => {
    const cells = splitQuoted(firstLine, delim).map(cell => cell.replace(/^'|'$/g, ''));
    if (cells.length < 4) return false;
    return cells.some(cell => /^\d{2}-\d{2}-\d{4}$/.test(cell) || /^\d{4}-\d{2}-\d{2}$/.test(cell) || (/^(19|20)\d{6}$/.test(cell) && normalizeDate(cell) !== null));
  });
}

/** Welke bank is dit waarschijnlijk? Alleen voor de melding. */
function guessBank(text: string): string | null {
  if (/NL\d{2}ASNB/.test(text)) return 'ASN Bank';
  if (/NL\d{2}SNSB/.test(text)) return 'SNS';
  if (/NL\d{2}RBRB/.test(text)) return 'RegioBank';
  if (/NL\d{2}TRIO/.test(text)) return 'Triodos';
  if (/^\d{6,10}\t[A-Z]{3}\t\d{8}\t/.test(text)) return 'ABN AMRO';
  return null;
}

const HOW_TO = 'Kies bij je bank een ander formaat: CAMT.053 of MT940. Die vind je in internetbankieren op de plek waar je je transacties of afschriften downloadt, bij de keuze voor het bestandsformaat. In die bestanden staan ook het begin- en eindsaldo, zodat ResoFly kan controleren of je afschrift compleet is.';

/**
 * Leest een bankbestand zonder kopregel, als het zeker een van de bekende
 * indelingen is. Null als het bestand een kopregel heeft: dan is het voor de
 * gewone CSV-lezer. Gooit een fout met uitleg als het geen kopregel heeft en
 * ook niet zeker te lezen is.
 */
export function parseHeaderlessBankFile(raw: string, fileName: string): ParsedBankStatement | null {
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0 || !looksHeaderless(lines[0])) return null;

  const matched = matchAbnAmro(lines) ?? matchVolksbank(lines) ?? matchTriodos(lines);
  if (!matched) {
    const bank = guessBank(lines[0]);
    throw new Error(`Dit bestand heeft geen regel met kolomnamen${bank ? ` (het lijkt een export van ${bank})` : ''}, en ResoFly herkent de indeling niet zeker genoeg om hem in te lezen. Een gok zou bedragen of ontvangst en uitgave kunnen verwisselen. ${HOW_TO}`);
  }

  // Twee rekeningen in één bestand: alles zou op de rekening komen waar je het
  // inleest, en de regels van de andere rekening krijg je er daarna maar met
  // moeite af (controle bank, bevinding 1 en 2).
  const accounts = [...new Set(matched.rows.map(r => r.account))];
  if (accounts.length > 1) {
    throw new Error(`In dit bestand staan mutaties van ${accounts.length} rekeningen (${accounts.join(', ')}). Download bij ${matched.bank} per rekening een eigen bestand en lees elk bestand in bij de rekening waar het bij hoort.`);
  }

  const warnings = [...matched.warnings];
  const transactions: ParsedBankTransaction[] = [];
  let zero = 0;
  for (const r of matched.rows) {
    if (r.cents === 0) { zero += 1; continue; }
    // De eigen rekening gaat mee, net als bij de andere lezers, zodat de
    // controle vóór het inlezen ("staat dit afschrift op de rekening die je
    // koos?") ook dit bestand ziet. Zonder die controle kwam een afschrift van
    // een andere rekening stil op de verkeerde (controle bank, bevinding 1).
    const tx: ParsedBankTransaction & { account?: string | null } = {
      account: r.account,
      booking_date: r.date,
      value_date: r.valueDate,
      amount_cents: r.cents,
      currency: 'EUR',
      counterparty_name: r.name,
      counterparty_iban: r.iban,
      description: r.description,
      structured_reference: r.reference,
      end_to_end_id: r.endToEnd,
      bank_tx_id: null,
    };
    transactions.push(tx);
  }
  if (transactions.length === 0) throw new Error('Geen bruikbare transacties gevonden in dit bestand.');
  if (zero > 0) warnings.push(`${zero} regel(s) overgeslagen: een bedrag van € 0,00.`);

  const dates = transactions.map(t => t.booking_date).sort();
  return {
    format: 'csv',
    file_name: fileName,
    file_hash: null,
    period_start: dates[0] ?? null,
    period_end: dates[dates.length - 1] ?? null,
    opening_balance_cents: matched.opening,
    closing_balance_cents: matched.closing,
    warnings,
    transactions,
  };
}
