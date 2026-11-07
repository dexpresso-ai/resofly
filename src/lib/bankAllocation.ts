/**
 * Een banktransactie verdelen over facturen, creditnota's, inkoopfacturen en
 * grootboekrekeningen (migratie 20261107100000).
 *
 * Puur rekenwerk en voorstellen, zonder React of database, zodat de regels
 * unit-tests hebben. Het scherm (src/features/Bank.tsx) bouwt hierop; de
 * database rekent alles na en weigert wat niet klopt.
 *
 * Bedragen in een verdeling staan in de RICHTING VAN DE TRANSACTIE: positief =
 * mee met het geld (bij een ontvangst: wat er binnenkwam voor deze factuur;
 * bij een betaling: wat je betaalde), negatief = de andere kant op (kosten die
 * van een uitbetaling zijn afgehouden, een creditnota van een leverancier die
 * met de betaling is verrekend). De som is het hele bedrag van de transactie.
 */
import type { BankAllocationCandidates, BankAllocationKind, BankOpenDocument, BankTransaction, UUID } from '../types';
import { parseDutchAmountCents } from './money.ts';

export type { BankAllocationKind };

/** Eén regel zoals het scherm hem bijhoudt (bedrag als getypte tekst). */
export interface DraftAllocation {
  key: string;
  kind: BankAllocationKind;
  /** Factuur, creditnota of inkoopfactuur. */
  documentId: string;
  accountId: string;
  vatCode: string;
  /** Klant of leverancier bij een regel op debiteuren of crediteuren. */
  partyId: string;
  /** In euro's zoals getypt, in de richting van de transactie. Leeg bij één regel: dan het hele bedrag. */
  amount: string;
  description: string;
}

/** Wat book_bank_transaction aanneemt (zie BankAllocationInput in repository.ts). */
export interface AllocationPayload {
  kind: BankAllocationKind;
  amount_cents: number;
  invoice_id?: UUID;
  credit_note_id?: UUID;
  purchase_invoice_id?: UUID;
  account_id?: UUID;
  vat_code?: string | null;
  client_id?: UUID | null;
  supplier_id?: UUID | null;
  description?: string | null;
}

let counter = 0;
export function newDraftKey(): string {
  counter += 1;
  return `r${Date.now().toString(36)}${counter}`;
}

export function emptyDraft(kind: BankAllocationKind = 'ledger', patch: Partial<DraftAllocation> = {}): DraftAllocation {
  return { key: newDraftKey(), kind, documentId: '', accountId: '', vatCode: '', partyId: '', amount: '', description: '', ...patch };
}

/** Centen als euro-tekst om in een invoerveld te zetten: 12345 → "123,45". */
export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Staat een kenmerk als los woord in de banktekst? Spiegelt
 * bank_text_mentions_reference in de database: zonder spaties, niet midden in
 * een getal ("42" in "4211"), en te korte of kale getallen tellen niet.
 */
export function mentionsReference(haystack: string, reference: string | null | undefined): boolean {
  const ref = String(reference ?? '').replace(/\s/g, '').toLowerCase();
  const hay = String(haystack ?? '').replace(/\s/g, '').toLowerCase();
  if (ref.length < 3 || (/^[0-9]+$/.test(ref) && ref.length < 5)) return false;
  let from = 0;
  for (;;) {
    const pos = hay.indexOf(ref, from);
    if (pos < 0) return false;
    const before = pos > 0 ? hay[pos - 1] : '';
    const after = hay[pos + ref.length] ?? '';
    const digitBefore = /[0-9]/.test(ref[0]) && /[0-9]/.test(before);
    const digitAfter = /[0-9]/.test(ref[ref.length - 1]) && /[0-9]/.test(after);
    if (!digitBefore && !digitAfter) return true;
    from = pos + 1;
  }
}

/** Waar de documenten in de tekst staan, in de volgorde waarin ze genoemd worden. */
function mentioned(text: string, docs: BankOpenDocument[]): BankOpenDocument[] {
  const lower = text.replace(/\s/g, '').toLowerCase();
  return docs
    .filter(doc => mentionsReference(text, doc.number))
    .map(doc => ({ doc, at: lower.indexOf(String(doc.number).replace(/\s/g, '').toLowerCase()) }))
    .sort((a, b) => a.at - b.at)
    .map(x => x.doc);
}

/**
 * Een eerste verdeling voor een openstaande transactie. Het voorstel van de
 * server (matcher of bankregel) gaat voor; noemt de omschrijving meerdere
 * openstaande stukken, dan krijgt elk een regel met zijn openstaande bedrag en
 * gaat de rest op een grootboekregel. Dat laatste kan de server niet: die kent
 * per transactie maar één voorstel.
 */
export function suggestAllocations(txn: BankTransaction, candidates: BankAllocationCandidates | null): DraftAllocation[] {
  const full = Math.abs(txn.amount_cents);
  const incoming = txn.amount_cents > 0;
  const text = `${txn.description ?? ''} ${txn.structured_reference ?? ''}`;
  const ledgerFallback = (patch: Partial<DraftAllocation> = {}) => emptyDraft('ledger', {
    accountId: txn.suggested_account_id ?? '',
    vatCode: txn.suggested_vat_code ?? '',
    ...patch,
  });

  if (candidates) {
    const docs: Array<{ kind: BankAllocationKind; doc: BankOpenDocument; open: number }> = incoming
      ? mentioned(text, candidates.sales_invoices).map(doc => ({ kind: 'sales_invoice' as const, doc, open: doc.open_cents }))
      : [
          ...mentioned(text, candidates.purchase_invoices.filter(p => p.open_cents > 0)).map(doc => ({ kind: 'purchase_invoice' as const, doc, open: doc.open_cents })),
          ...mentioned(text, candidates.credit_notes).map(doc => ({ kind: 'sales_credit_note' as const, doc, open: doc.open_cents })),
        ];
    if (docs.length >= 2) {
      const lines: DraftAllocation[] = [];
      let left = full;
      for (const { kind, doc, open } of docs) {
        if (left <= 0) break;
        const take = Math.min(open, left);
        if (take <= 0) continue;
        lines.push(emptyDraft(kind, { documentId: doc.id, amount: centsToInput(take) }));
        left -= take;
      }
      if (lines.length >= 2) {
        if (left > 0) lines.push(ledgerFallback({ amount: centsToInput(left) }));
        return lines;
      }
    }
  }

  if (incoming && txn.matched_invoice_id) return [emptyDraft('sales_invoice', { documentId: txn.matched_invoice_id })];
  if (!incoming && txn.matched_purchase_invoice_id) return [emptyDraft('purchase_invoice', { documentId: txn.matched_purchase_invoice_id })];
  if (!incoming && candidates) {
    // Een terugbetaling waarvan de omschrijving de creditnota noemt.
    const [credit] = mentioned(text, candidates.credit_notes);
    if (credit) return [emptyDraft('sales_credit_note', { documentId: credit.id })];
  }
  return [ledgerFallback()];
}

/** Het bedrag van één regel in centen (richting van de transactie), of null als het geen bedrag is. */
export function lineCents(line: DraftAllocation, lines: DraftAllocation[], fullCents: number): number | null {
  if (lines.length === 1 && line.amount.trim() === '') return fullCents;
  if (line.amount.trim() === '') return null;
  return parseDutchAmountCents(line.amount);
}

export interface AllocationState {
  /** Opgeteld in centen (alleen regels met een geldig bedrag). */
  sumCents: number;
  /** Wat er nog verdeeld moet worden; 0 = precies. */
  remainderCents: number;
  /** Eerste reden waarom boeken nog niet kan, of null. */
  problem: string | null;
}

/** Klopt de verdeling? Dezelfde regels als de database, zodat de knop pas aan gaat als boeken kan. */
export function allocationState(lines: DraftAllocation[], fullCents: number): AllocationState {
  let sum = 0;
  let problem: string | null = null;
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const label = lines.length > 1 ? `Regel ${index + 1}: ` : '';
    const cents = lineCents(line, lines, fullCents);
    if (cents === null) problem ??= `${label}vul een bedrag in.`;
    else if (cents === 0) problem ??= `${label}een bedrag van € 0,00 kan niet.`;
    else sum += cents;
    if (line.kind === 'ledger') {
      if (!line.accountId) problem ??= `${label}kies een grootboekrekening.`;
    } else if (!line.documentId) {
      problem ??= `${label}kies ${line.kind === 'sales_invoice' ? 'een verkoopfactuur' : line.kind === 'sales_credit_note' ? 'een creditnota' : 'een inkoopfactuur'}.`;
    } else {
      const key = `${line.kind}:${line.documentId}`;
      if (seen.has(key)) problem ??= `${label}dit stuk staat al op een andere regel.`;
      seen.add(key);
    }
  });
  const remainder = fullCents - sum;
  if (!problem && remainder !== 0) problem = remainder > 0 ? 'Nog niet het hele bedrag verdeeld.' : 'Er is meer verdeeld dan het bedrag van de transactie.';
  return { sumCents: sum, remainderCents: remainder, problem };
}

/** De verdeling zoals book_bank_transaction hem aanneemt. Gooit als hij niet klopt. */
export function allocationPayload(lines: DraftAllocation[], fullCents: number): AllocationPayload[] {
  const state = allocationState(lines, fullCents);
  if (state.problem) throw new Error(state.problem);
  return lines.map(line => {
    const amount_cents = lineCents(line, lines, fullCents) as number;
    const description = line.description.trim() || null;
    if (line.kind === 'sales_invoice') return { kind: line.kind, amount_cents, invoice_id: line.documentId, description };
    if (line.kind === 'sales_credit_note') return { kind: line.kind, amount_cents, credit_note_id: line.documentId, description };
    if (line.kind === 'purchase_invoice') return { kind: line.kind, amount_cents, purchase_invoice_id: line.documentId, description };
    // partyId is 'c:<klant>' of 's:<leverancier>': het scherm weet welke van de
    // twee bij de gekozen rekening hoort (debiteuren of crediteuren).
    return {
      kind: 'ledger',
      amount_cents,
      account_id: line.accountId,
      vat_code: line.vatCode || null,
      client_id: line.partyId.startsWith('c:') ? line.partyId.slice(2) : null,
      supplier_id: line.partyId.startsWith('s:') ? line.partyId.slice(2) : null,
      description,
    };
  });
}

/**
 * Van één regel naar twee: de eerste houdt wat hij al had (bij een stuk met
 * minder open dan het hele bedrag: dat openstaande deel), de nieuwe krijgt de rest.
 */
export function addLine(lines: DraftAllocation[], fullCents: number, openOf: (line: DraftAllocation) => number | null): DraftAllocation[] {
  if (lines.length === 1) {
    const first = lines[0];
    const open = openOf(first);
    const firstCents = first.amount.trim() === '' ? (open !== null && open > 0 && open < fullCents ? open : fullCents) : (parseDutchAmountCents(first.amount) ?? fullCents);
    const rest = fullCents - firstCents;
    return [{ ...first, amount: centsToInput(firstCents) }, emptyDraft('ledger', { amount: rest !== 0 ? centsToInput(rest) : '' })];
  }
  const state = allocationState(lines, fullCents);
  const rest = fullCents - state.sumCents;
  return [...lines, emptyDraft('ledger', { amount: rest > 0 ? centsToInput(rest) : '' })];
}

/** Terug naar één regel: die krijgt dan weer stilzwijgend het hele bedrag. */
export function removeLine(lines: DraftAllocation[], key: string): DraftAllocation[] {
  const left = lines.filter(line => line.key !== key);
  if (left.length === 1) return [{ ...left[0], amount: '' }];
  return left.length ? left : lines;
}

/** De rest van de verdeling op deze regel zetten. */
export function putRemainder(lines: DraftAllocation[], key: string, fullCents: number): DraftAllocation[] {
  const others = lines.filter(line => line.key !== key);
  const othersSum = others.reduce((sum, line) => sum + (lineCents(line, lines, fullCents) ?? 0), 0);
  return lines.map(line => (line.key === key ? { ...line, amount: centsToInput(fullCents - othersSum) } : line));
}

/**
 * Het bedrag dat een stuk "van nature" krijgt, in de richting van de
 * transactie: wat er openstaat, met het teken van de kant van het geld. Een
 * verkoopfactuur is geld erbij, een creditnota-terugbetaling geld eraf, een
 * inkoopfactuur geld eraf (of erbij als het een creditnota van de leverancier
 * is: dan is open negatief).
 */
export function naturalAmount(kind: BankAllocationKind, openCents: number, txnAmountCents: number): number {
  const direction = txnAmountCents < 0 ? -1 : 1;
  const bankSign = kind === 'sales_invoice' ? 1 : kind === 'sales_credit_note' ? -1 : kind === 'purchase_invoice' ? (openCents > 0 ? -1 : 1) : 1;
  return bankSign * direction * Math.abs(openCents);
}

/** Handmatige mutaties die nog geen bankregel hebben, per rekening en bedrag. Eén keer per weergave opbouwen. */
export type ManualIndex = Map<string, BankTransaction[]>;

export function buildManualIndex(all: BankTransaction[]): ManualIndex {
  const confirmed = new Set<string>();
  for (const t of all) if (t.merged_into_id) confirmed.add(t.merged_into_id);
  const index: ManualIndex = new Map();
  for (const t of all) {
    if (!t.is_manual || t.status === 'ignored' || confirmed.has(t.id)) continue;
    const key = `${t.bank_account_id}|${t.amount_cents}`;
    const list = index.get(key);
    if (list) list.push(t); else index.set(key, [t]);
  }
  return index;
}

/** Handmatige mutaties die bij deze bankregel horen: zelfde rekening en bedrag, nog niet bevestigd, dichtstbij eerst. */
export function manualMatchesFor(txn: BankTransaction, index: ManualIndex): BankTransaction[] {
  if (txn.is_manual) return [];
  const list = index.get(`${txn.bank_account_id}|${txn.amount_cents}`);
  if (!list?.length) return [];
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  return [...list].sort((a, b) => Math.abs(day(a.booking_date) - day(txn.booking_date)) - Math.abs(day(b.booking_date) - day(txn.booking_date)));
}
