/**
 * Eén banktransactie verdelen over verkoopfacturen, inkoopfacturen en
 * grootboekregels (Bank → Af te letteren → Verdelen). De server controleert
 * alles opnieuw (book_bank_transaction met p_allocations); dit is wat het scherm
 * vooraf laat zien: wat er nog te verdelen is en wat er niet klopt.
 */

export type SplitRowKind = 'invoice' | 'purchase' | 'account';

export interface SplitRow {
  /** Alleen voor React. */
  key: string;
  kind: SplitRowKind;
  /** Factuur-, inkoopfactuur- of grootboekrekening-id; leeg = nog niet gekozen. */
  targetId: string;
  /** Zoals getypt, in euro's ("120,50"). */
  amount: string;
  /** Alleen bij een grootboekregel; leeg = geen btw. */
  vatCode: string;
}

export type SplitAllocation = {
  invoice_id?: string;
  purchase_invoice_id?: string;
  amount_cents: number;
};

export type SplitLine = {
  account_id: string;
  amount_cents: number;
  vat_code: string | null;
  description: string;
};

const EURO = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
export const formatCents = (cents: number) => EURO.format(cents / 100);

/**
 * Een bedrag zoals iemand het typt, in centen: "1.234,56", "1234,56", "1234.56",
 * "€ 12,50", "12". Staan er een punt én een komma in, dan is de laatste het
 * decimaalteken. Alleen een punt met precies drie cijfers erna ("1.234") is een
 * duizendtal, zoals in het Nederlands. Null als het geen bedrag is.
 */
export function parseEuroCents(input: string): number | null {
  let s = String(input ?? '').replace(/€|eur/gi, '').replace(/[\s ]/g, '');
  if (!s) return null;
  let negative = false;
  if (s.startsWith('-') || s.startsWith('−')) { negative = true; s = s.slice(1); }
  if (!/^[0-9.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let fracPart = '';
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = Math.max(lastComma, lastDot);
    intPart = s.slice(0, dec).replace(/[.,]/g, '');
    fracPart = s.slice(dec + 1);
  } else if (lastComma >= 0) {
    if (s.indexOf(',') !== lastComma) return null; // "1,234,56"
    intPart = s.slice(0, lastComma);
    fracPart = s.slice(lastComma + 1);
  } else if (lastDot >= 0) {
    const groups = s.split('.');
    if (groups.length > 2 || groups[groups.length - 1].length === 3) {
      // Duizendtallen: elke groep na de eerste precies drie cijfers.
      if (!groups.slice(1).every((g) => g.length === 3) || !groups[0] || groups[0].startsWith('0')) return null;
      intPart = groups.join('');
    } else {
      intPart = groups[0];
      fracPart = groups[1];
    }
  } else {
    intPart = s;
  }
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]{0,2}$/.test(fracPart) || (intPart === '' && fracPart === '')) return null;
  const cents = Number(intPart || '0') * 100 + Number(fracPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Centen als invoertekst: 12050 → "120,50". */
export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

export interface SplitContext {
  /** Openstaand bedrag in centen (negatief = tegoed), als het bekend is. */
  openOf?: (kind: SplitRowKind, id: string) => number | undefined;
  /** Hoe een factuur of rekening in een melding heet. */
  labelOf?: (kind: SplitRowKind, id: string) => string;
  /** Ontvangst (true) of betaling. */
  incoming: boolean;
}

export interface SplitCheck {
  /** Opgeteld over de regels met een geldig bedrag. */
  allocatedCents: number;
  /** Transactie min verdeeld: positief = nog te verdelen, negatief = te veel. */
  remainingCents: number;
  /** Per regel (index → melding) wat er niet klopt. */
  rowErrors: Map<number, string>;
  /** Boeken kan: elke regel klopt en het totaal is precies de transactie. */
  ready: boolean;
}

/**
 * Wat er nog te verdelen is en wat er per regel niet klopt. Per factuur: niet
 * meer dan wat er openstaat (in de richting van het geld: een ontvangst op een
 * verkoopfactuur met iets open, een terugbetaling op een tegoed).
 */
export function checkSplit(rows: SplitRow[], totalCents: number, ctx: SplitContext): SplitCheck {
  const rowErrors = new Map<number, string>();
  let allocated = 0;
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const cents = parseEuroCents(row.amount);
    if (cents !== null && cents > 0) allocated += cents;
    const label = row.targetId ? (ctx.labelOf?.(row.kind, row.targetId) ?? '') : '';
    if (!row.targetId) {
      rowErrors.set(i, row.kind === 'invoice' ? 'Kies een verkoopfactuur.' : row.kind === 'purchase' ? 'Kies een inkoopfactuur.' : 'Kies een grootboekrekening.');
      return;
    }
    if (cents === null || cents <= 0) {
      rowErrors.set(i, 'Vul een bedrag in, bijvoorbeeld 120,50.');
      return;
    }
    if (row.kind !== 'account') {
      const key = `${row.kind}:${row.targetId}`;
      if (seen.has(key)) { rowErrors.set(i, `${label || 'Deze factuur'} staat al in de verdeling; tel de bedragen bij elkaar op.`); return; }
      seen.add(key);
      const open = ctx.openOf?.(row.kind, row.targetId);
      if (open !== undefined) {
        // Ontvangst op een verkoopfactuur en betaling op een inkoopfactuur gaan van
        // het openstaande bedrag af; de andere richting is een terugbetaling van een tegoed.
        const paying = (row.kind === 'invoice') === ctx.incoming;
        const room = paying ? open : -open;
        if (room <= 0) rowErrors.set(i, paying ? `Op ${label || 'deze factuur'} staat niets meer open.` : `Op ${label || 'deze factuur'} is geen tegoed om terug te betalen.`);
        else if (cents > room) rowErrors.set(i, paying ? `Op ${label || 'deze factuur'} staat nog ${formatCents(room)} open.` : `Het tegoed op ${label || 'deze factuur'} is ${formatCents(room)}.`);
      }
    }
  });
  const remainingCents = totalCents - allocated;
  return { allocatedCents: allocated, remainingCents, rowErrors, ready: rows.length > 0 && rowErrors.size === 0 && remainingCents === 0 };
}

/** De delen en grootboekregels voor book_bank_transaction. Alleen voor een verdeling die klopt. */
export function splitPayload(rows: SplitRow[], description: string): { allocations: SplitAllocation[]; lines: SplitLine[] } {
  const allocations: SplitAllocation[] = [];
  const lines: SplitLine[] = [];
  for (const row of rows) {
    const cents = parseEuroCents(row.amount) ?? 0;
    if (row.kind === 'invoice') allocations.push({ invoice_id: row.targetId, amount_cents: cents });
    else if (row.kind === 'purchase') allocations.push({ purchase_invoice_id: row.targetId, amount_cents: cents });
    else lines.push({ account_id: row.targetId, amount_cents: cents, vat_code: row.vatCode || null, description });
  }
  return { allocations, lines };
}

let rowCounter = 0;
export function newSplitRow(kind: SplitRowKind, targetId = '', amountCents?: number): SplitRow {
  rowCounter += 1;
  return { key: `r${rowCounter}`, kind, targetId, amount: amountCents !== undefined ? centsToInput(amountCents) : '', vatCode: '' };
}

/** Regels uit een verdeelvoorstel van de matcher (bank_transactions.suggested_allocations). */
export function rowsFromSuggestion(suggested: unknown): SplitRow[] {
  if (!Array.isArray(suggested)) return [];
  const rows: SplitRow[] = [];
  for (const item of suggested) {
    const s = item as Record<string, unknown>;
    const cents = Number(s?.amount_cents);
    if (!Number.isSafeInteger(cents) || cents <= 0) continue;
    if (typeof s.invoice_id === 'string' && s.invoice_id) rows.push(newSplitRow('invoice', s.invoice_id, cents));
    else if (typeof s.purchase_invoice_id === 'string' && s.purchase_invoice_id) rows.push(newSplitRow('purchase', s.purchase_invoice_id, cents));
  }
  return rows;
}
