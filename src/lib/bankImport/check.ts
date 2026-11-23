import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';

/**
 * Controles rond het inlezen van een afschrift, zonder imports van de app: zo
 * zijn ze met `node --test` te testen (check.test.ts).
 *
 * Aanleiding (controle bank, 22 november 2026): een afschrift van een andere
 * rekening, of een bestand met twee rekeningen erin, ging zonder vraag de
 * gekozen rekening in. Een Rabobank-CSV met de spaarrekening erbij zette
 * + € 5.000 "Naar spaarrekening" op de zakelijke rekening, met de eigen naam
 * als tegenpartij: dat leek een privéstorting. En die regel kreeg je er
 * daarna niet meer af.
 */

/** Hoofdletters, zonder spaties: "nl69 ingb 0123 4567 89" en "NL69INGB0123456789" zijn gelijk. */
export function compactAccount(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, '').toUpperCase();
}

const IBAN_IN = /[A-Z]{2}\d{2}[A-Z]{4}\d{6,}/;

/**
 * Is `fileAccount` (zoals het bestand de eigen rekening noemt) dezelfde
 * rekening als het IBAN van de gekozen bankrekening?
 *
 * Banken noemen hem verschillend: ING MT940 `NL69INGB0123456789EUR`, Rabobank
 * `NL11RABO0123456789 EUR`, soms met de BIC ervoor, en ABN AMRO in MT940 nog
 * het oude rekeningnummer zonder IBAN (`123456789`). Dat laatste vergelijken
 * we met het rekeningnummer achteraan het IBAN, zonder voorloopnullen.
 */
export function sameAccount(fileAccount: string | null | undefined, accountIban: string | null | undefined): boolean {
  const file = compactAccount(fileAccount);
  const iban = compactAccount(accountIban);
  if (!file || !iban) return false;
  if (file === iban || file.includes(iban)) return true;
  // Een ander IBAN in het bestand is een andere rekening.
  if (IBAN_IN.test(file)) return false;
  const digits = /^0*(\d{6,})(?:[A-Z]{3})?$/.exec(file)?.[1];
  if (!digits) return false;
  return iban.endsWith(digits);
}

export type StatementAccountCheck =
  /** Inlezen: alleen de regels van deze rekening, met wat er is overgeslagen in `notes`. */
  | { kind: 'ok'; statement: ParsedBankStatement; notes: string[] }
  /** Alles is van één andere rekening: eerst vragen. Zegt de gebruiker ja, dan lees je `statement` in. */
  | { kind: 'ask'; statement: ParsedBankStatement; message: string }
  /** Niet inlezen: niet te zeggen welke regels bij deze rekening horen. */
  | { kind: 'refuse'; message: string };

function distinctAccounts(transactions: ParsedBankTransaction[]): string[] {
  const seen = new Map<string, string>();
  for (const t of transactions) {
    const raw = (t.account ?? '').trim();
    const key = compactAccount(raw);
    if (key && !seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()];
}

const list = (accounts: string[]) => accounts.join(', ');

/**
 * Legt de eigen rekening uit het bestand naast het IBAN van de gekozen
 * bankrekening, vóór er iets wordt ingelezen.
 *
 * - Noemt het bestand geen eigen rekening (de meeste CSV's zonder die kolom),
 *   dan verandert er niets.
 * - Eén andere rekening: eerst vragen ("dit afschrift is van …").
 * - Meer rekeningen: alleen de regels van de gekozen rekening, met het saldo
 *   van die rekening, en zeggen hoeveel er zijn overgeslagen.
 * - Meer rekeningen en de gekozen rekening heeft geen IBAN: weigeren; welke
 *   regels erbij horen is dan niet te zeggen.
 */
export function checkStatementAccount(statement: ParsedBankStatement, accountIban: string | null | undefined): StatementAccountCheck {
  const fileAccounts = distinctAccounts(statement.transactions);
  if (fileAccounts.length === 0) return { kind: 'ok', statement, notes: [] };

  if (!compactAccount(accountIban)) {
    if (fileAccounts.length > 1) {
      return {
        kind: 'refuse',
        message: `Dit bestand bevat regels van ${fileAccounts.length} rekeningen (${list(fileAccounts)}). Vul bij deze bankrekening het IBAN in, dan leest ResoFly alleen de regels van deze rekening in. Of exporteer bij je bank per rekening.`,
      };
    }
    return {
      kind: 'ok', statement,
      notes: [`Dit afschrift is van ${fileAccounts[0]}. Vul bij deze bankrekening het IBAN in, dan controleert ResoFly voortaan of een afschrift bij de rekening hoort.`],
    };
  }

  const matching = fileAccounts.filter(a => sameAccount(a, accountIban));
  const others = fileAccounts.filter(a => !sameAccount(a, accountIban));
  if (matching.length === 0) {
    if (others.length > 1) {
      return {
        kind: 'refuse',
        message: `Dit bestand bevat regels van ${list(others)}, maar niet van deze rekening (${accountIban}). Lees het in bij de rekening waar het bij hoort, of exporteer bij je bank per rekening.`,
      };
    }
    return {
      kind: 'ask', statement,
      message: `Dit afschrift is van ${others[0]}, niet van deze rekening (${accountIban}). Lees het in bij de rekening waar het bij hoort.`,
    };
  }
  if (others.length === 0) return { kind: 'ok', statement, notes: [] };

  // Een regel zonder eigen rekening (lege cel) houden we: dan zegt het bestand
  // niet dat hij van een andere rekening is.
  const kept = statement.transactions.filter(t => !compactAccount(t.account) || sameAccount(t.account, accountIban));
  const skipped = statement.transactions.length - kept.length;
  const section = (statement.accounts ?? []).find(s => sameAccount(s.account, accountIban));
  const dates = kept.map(t => t.booking_date).filter(Boolean).sort();
  const selected: ParsedBankStatement = {
    ...statement,
    transactions: kept,
    // Het saldo van déze rekening. Zonder (CSV) geen saldo: dat van het hele
    // bestand zou de afschriftcontrole vals laten afgaan.
    period_start: section ? section.period_start : (dates[0] ?? null),
    period_end: section ? section.period_end : (dates[dates.length - 1] ?? null),
    opening_balance_cents: section ? section.opening_balance_cents : null,
    closing_balance_cents: section ? section.closing_balance_cents : null,
    accounts: section ? [section] : [],
  };
  return {
    kind: 'ok', statement: selected,
    notes: [`${skipped} regel(s) van een andere rekening (${list(others)}) niet ingelezen. Lees die in bij de rekening waar ze bij horen.`],
  };
}

/**
 * De melding als beginsaldo + mutaties niet op het eindsaldo uitkomt.
 * `differenceCents` = eindsaldo − (beginsaldo + mutaties), zoals
 * import_bank_transactions en report_bank_reconciliation hem geven.
 *
 * Eerder zei de melding altijd "er ontbreken transacties". Staat er een
 * betaling dubbel (een afschrift na de bankkoppeling, met een iets andere
 * omschrijving), dan is het verschil negatief en stuurde die tekst de zzp'er
 * de verkeerde kant op.
 */
export function describeStatementDifference(differenceCents: number, formatEuro: (cents: number) => string): string {
  const amount = formatEuro(Math.abs(differenceCents));
  const cause = differenceCents < 0
    ? `${amount} hoger uit dan het eindsaldo van het afschrift. Er staat een bijschrijving dubbel, of er ontbreekt een afschrijving.`
    : `${amount} lager uit dan het eindsaldo van het afschrift. Er staat een afschrijving dubbel, of er ontbreekt een bijschrijving.`;
  return `Let op: beginsaldo + alle mutaties in deze periode komen ${cause} ${DUPLICATE_HINT}`;
}

/** Waar je een dubbele mutatie vindt; ook gebruikt in de aansluiting op de Bankpagina. */
export const DUPLICATE_HINT = 'Staat er bij "Af te letteren" een mutatie met de knop "Dubbele verwijderen", begin dan daar. Anders mist het bestand regels: exporteer die periode opnieuw bij je bank.';
