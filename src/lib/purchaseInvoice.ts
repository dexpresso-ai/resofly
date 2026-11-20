// ============================================================
// Inkoopfacturen: de regels voor het formulier en de lijst.
//
// Welke btw-codes op een inkoopregel horen, hoe de totalen tellen (verlegde
// btw hoort niet in het totaal, het btw-bedrag van de leverancier wel), en
// wanneer een factuurdatum onwaarschijnlijk is.
//
// De rekenregels zijn een spiegel van supabase/functions/_shared/
// invoiceInboxRules.ts (de AI-route) en van book_purchase_invoice in de
// database (migratie 20261119180000). purchaseInvoice.test.ts houdt de twee
// TypeScript-kanten gelijk.
//
// Bewust zonder runtime-imports, zodat `node --test` dit bestand draait.
// ============================================================

import type { PurchaseInvoiceLine, VatCode } from '../types';

/**
 * Een inkoopregel met het btw-bedrag van de leverancier erbij. Leeg betekent:
 * grondslag × tarief. Alleen zinvol bij aftrekbare btw (21% en 9%).
 */
export type PurchaseLine = PurchaseInvoiceLine & { vat_cents?: number | null };

/**
 * Soorten btw-code die op een INKOOPregel horen. Een verkoopcode (ICP, btw
 * verlegd verkoop) op een inkoopregel gaf een boeking die in geen enkele
 * rubriek van de aangifte kwam: "ICP diensten" voor Google Ads sloeg 4b over.
 */
export const PURCHASE_VAT_KINDS = ['standard', 'reduced', 'zero', 'exempt', 'reverse_charge_purchase', 'eu_acquisition', 'import_non_eu', 'kor'];

/**
 * De leverancier rekent geen btw: je geeft hem zelf aan (2a, 4a, 4b) en trekt
 * hem af. Die btw hoort dus niet in het totaal van de factuur. De ICP-soorten
 * staan erbij omdat de database ze tot 20261119180000 zo boekte; een bestaand
 * concept met zo'n code telt dan hetzelfde als de boeking.
 */
export const SELF_ASSESSED_VAT_KINDS = ['reverse_charge_purchase', 'eu_acquisition', 'import_non_eu', 'icp_goods', 'icp_services'];

/**
 * Gewone btw (21% en 9%): alleen hier vul je het btw-bedrag van de leverancier
 * in (vat_cents op de regel). Verlegde btw reken je zelf uit, en bij 0% is er
 * geen btw.
 */
export const DEDUCTIBLE_VAT_KINDS = ['standard', 'reduced'];

/** Hoort deze btw-code op een inkoopregel? Export (3a) is omzet, geen inkoop. */
export function isPurchaseVatCode(code: { kind: string; sales_box?: string | null }): boolean {
  if (!PURCHASE_VAT_KINDS.includes(code.kind)) return false;
  return !(code.kind === 'zero' && code.sales_box === '3a');
}

/**
 * De keuzelijst voor de btw-code van een inkoopregel of een leverancier:
 * alleen actieve inkoopcodes. Staat er al een andere code (een oud concept met
 * een verkoopcode, of een code die intussen is uitgezet), dan blijft die
 * zichtbaar met `misplaced`, zodat het formulier kan waarschuwen in plaats van
 * stil een andere code te tonen dan er is opgeslagen.
 */
export function purchaseVatChoices<T extends Pick<VatCode, 'code' | 'kind' | 'sales_box' | 'is_active'>>(
  vatCodes: T[],
  current: string | null | undefined,
): Array<{ code: T; misplaced: boolean }> {
  const choices = vatCodes.filter(v => v.is_active !== false && isPurchaseVatCode(v)).map(code => ({ code, misplaced: false }));
  const code = (current ?? '').trim();
  if (code && !choices.some(c => c.code.code === code)) {
    const own = vatCodes.find(v => v.code === code);
    if (own) choices.push({ code: own, misplaced: !isPurchaseVatCode(own) });
  }
  return choices;
}

/**
 * Afronden zoals Postgres: de helft van nul af. Math.round rondt -220,5 af
 * naar -220, de database naar -221; bij een creditnota van de leverancier
 * scheelde het totaal dan een cent met de boeking.
 */
export function roundCents(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export interface PurchaseTotalsLine {
  amount_cents: number;
  vat_rate: number;
  vat_code?: string | null;
  account_id?: string | null;
  /** Het btw-bedrag zoals het op de factuur staat; leeg = grondslag × tarief. */
  vat_cents?: number | null;
}

export interface PurchaseTotals {
  subtotal_cents: number;
  /** De btw die de leverancier in rekening brengt. */
  vat_cents: number;
  /** Wat je de leverancier betaalt; gelijk aan de crediteurenregel (1600) van de boeking. */
  total_cents: number;
  /** Verlegde btw (2a, 4a, 4b): zelf aangeven, niet aan de leverancier betalen. */
  self_assessed_vat_cents: number;
  /** Met de KOR: btw die je niet aftrekt en die bij de kosten komt. */
  non_deductible_vat_cents: number;
}

export interface PurchaseTotalsOptions {
  /** Een regel zonder rekening valt in de database op 4500. */
  fallbackAccountId?: string | null;
  /** De soort van een btw-code; onbekend telt als 'standard', net als in de database. */
  kindOf?: (code: string) => string | null | undefined;
  /** Kleineondernemersregeling: geen aftrek; de btw van de leverancier komt bij de kosten. */
  kor?: boolean;
}

const lineVatCents = (line: PurchaseTotalsLine): number | null => {
  const raw = line.vat_cents;
  if (raw === null || raw === undefined || (raw as unknown) === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
};

/**
 * De totalen van een inkoopfactuur, zoals book_purchase_invoice ze boekt: per
 * (kostenrekening, btw-code, tarief) afgerond en dan opgeteld.
 *
 * Tot 20261119180000 telde de btw altijd bij het totaal. Een verlegde factuur
 * van € 100 toonde dan "BTW € 21,00, totaal € 121,00", terwijl er € 100 op
 * crediteuren kwam; en het btw-bedrag van de leverancier was niet in te
 * voeren, zodat een bon van € 10,00 een concept van € 9,99 werd.
 */
export function purchaseLineTotals(lines: PurchaseTotalsLine[], options: PurchaseTotalsOptions = {}): PurchaseTotals {
  const groups = new Map<string, { base: number; computedBase: number; given: number; rate: number; kind: string }>();
  let subtotal = 0;
  for (const line of lines) {
    const base = Number(line.amount_cents) || 0;
    subtotal += base;
    const rate = Number(line.vat_rate) || 0;
    const code = String(line.vat_code ?? '').trim();
    const kind = (code && options.kindOf ? options.kindOf(code) : null) || 'standard';
    const account = line.account_id || options.fallbackAccountId || '';
    const key = `${account}|${code}|${kind}|${rate}`;
    const group = groups.get(key) ?? { base: 0, computedBase: 0, given: 0, rate, kind };
    // Zoals book_purchase_invoice: het btw-bedrag van de regel telt, behalve
    // bij verlegde btw en bij 0%. Ook met de KOR: je betaalt wat er staat.
    const given = !SELF_ASSESSED_VAT_KINDS.includes(kind) && rate !== 0 ? lineVatCents(line) : null;
    group.base += base;
    if (given === null) group.computedBase += base;
    else group.given += given;
    groups.set(key, group);
  }
  let vat = 0;
  let selfAssessed = 0;
  let nonDeductible = 0;
  groups.forEach((group) => {
    const amount = group.given + roundCents((group.computedBase * group.rate) / 100);
    if (SELF_ASSESSED_VAT_KINDS.includes(group.kind)) { selfAssessed += amount; return; }
    vat += amount;
    if (options.kor) nonDeductible += amount;
  });
  return {
    subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat,
    self_assessed_vat_cents: selfAssessed, non_deductible_vat_cents: nonDeductible,
  };
}

/** Wat de totalen van deze organisatie nodig hebben: de soort per btw-code en de KOR. */
export function purchaseTotalsOptions(
  vatCodes: Array<Pick<VatCode, 'code' | 'kind'>>,
  settings: { kor?: boolean | null; fallbackAccountId?: string | null } = {},
): PurchaseTotalsOptions {
  const kindByCode = new Map(vatCodes.map(v => [v.code, v.kind as string]));
  return { kindOf: code => kindByCode.get(code), kor: Boolean(settings.kor), fallbackAccountId: settings.fallbackAccountId ?? null };
}

/** Het btw-bedrag dat bij deze regel hoort als de leverancier niets anders vermeldt. */
export function computedLineVat(line: Pick<PurchaseTotalsLine, 'amount_cents' | 'vat_rate'>): number {
  return roundCents(((Number(line.amount_cents) || 0) * (Number(line.vat_rate) || 0)) / 100);
}

/**
 * Kan bij deze regel het btw-bedrag van de leverancier worden ingevuld? Alleen
 * bij gewone btw (21% of 9%). Ook met de KOR: je trekt de btw dan niet af,
 * maar je betaalt wel wat er op de factuur staat.
 */
export function lineVatEditable(kind: string | null | undefined, rate: number): boolean {
  return DEDUCTIBLE_VAT_KINDS.includes(kind || 'standard') && Number(rate) > 0;
}

/**
 * Het ingevulde btw-bedrag op de regel zetten. Is het gelijk aan grondslag ×
 * tarief, of leeg, dan verdwijnt het veld: zo blijft "niets ingevuld" gewoon
 * meerekenen als het bedrag of het tarief later verandert.
 */
export function withLineVat<T extends PurchaseTotalsLine>(line: T, cents: number | null): T {
  const { vat_cents: _dropped, ...rest } = line;
  if (cents === null || !Number.isFinite(cents) || Math.round(cents) === computedLineVat(line)) return rest as T;
  return { ...rest, vat_cents: Math.round(cents) } as T;
}

/**
 * De regels zoals ze worden opgeslagen: een btw-bedrag blijft alleen staan
 * waar het telt. Staat het nog op een regel die intussen verlegd of 0% is,
 * dan weigert de database het boeken (btw-bedrag bij 0%) of negeert hij het.
 */
export function cleanLineVat<T extends PurchaseTotalsLine>(lines: T[], options: PurchaseTotalsOptions): T[] {
  return lines.map((line) => {
    if (line.vat_cents === null || line.vat_cents === undefined) return line;
    const code = String(line.vat_code ?? '').trim();
    const kind = (code && options.kindOf ? options.kindOf(code) : null) || 'standard';
    return lineVatEditable(kind, line.vat_rate) ? withLineVat(line, Number(line.vat_cents)) : withLineVat(line, null);
  });
}

export interface InvoiceDateConcern { kind: 'future' | 'before_start' | 'old'; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateNl = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/**
 * Is deze factuurdatum onwaarschijnlijk? In de toekomst, vóór de startdatum
 * van de boekhouding, of meer dan een jaar terug. Een bon met 2062 in plaats
 * van 2026 werd zonder vraag in boekjaar 2062 geboekt, en een bon van vóór de
 * start kwam in een jaar dat al in het oude pakket was afgesloten.
 */
export function invoiceDateConcern(
  date: string | null | undefined,
  options: { today: string; bookkeepingStart?: string | null },
): InvoiceDateConcern | null {
  if (!date || !ISO_DATE.test(date) || !ISO_DATE.test(options.today)) return null;
  if (date > options.today) {
    return { kind: 'future', message: `De factuurdatum ${dateNl(date)} ligt in de toekomst. Controleer de dag en het jaar.` };
  }
  const start = options.bookkeepingStart && ISO_DATE.test(options.bookkeepingStart) ? options.bookkeepingStart : null;
  if (start && date < start) {
    return {
      kind: 'before_start',
      message: `De factuurdatum ${dateNl(date)} ligt vóór de startdatum van je boekhouding (${dateNl(start)}). Klopt de datum, dan komt de boeking als nagekomen post op de startdatum.`,
    };
  }
  const yearAgo = `${String(Number(options.today.slice(0, 4)) - 1).padStart(4, '0')}${options.today.slice(4)}`;
  if (date < yearAgo) {
    return { kind: 'old', message: `De factuurdatum ${dateNl(date)} is meer dan een jaar geleden. Controleer het jaar.` };
  }
  return null;
}

/**
 * Wat er met "Concept verwijderen" gebeurt. Een verstuurde of geboekte
 * factuur ligt vast (CLAUDE.md, regel 6); een concept mag weg, behalve als er
 * iets aan hangt wat bewaard moet blijven:
 * - ooit geboekt en tegengeboekt: de boekstukken verwijzen ernaar;
 * - een declaratie: afwijzen met een reden, die de indiener leest;
 * - een bon of mail van de werklijst: het concept gaat weg via Negeren, de
 *   foto blijft bij het item (terug te halen met Herstellen);
 * - een los bewijsstuk: eerst zelf weghalen, anders blijft het bestand zonder
 *   factuur achter.
 */
export type DraftRemoval =
  | { kind: 'blocked'; message: string }
  | { kind: 'discard_inbox_item'; inboxId: string; confirm: string }
  | { kind: 'delete'; confirm: string };

export function draftRemoval(input: {
  status: string;
  /** Nummers van de boekstukken met deze factuur als bron. */
  entryNumbers: string[];
  inboxItem: { id: string; channel: 'email' | 'receipt' | 'declaration' } | null;
  attachments: number;
}): DraftRemoval {
  if (input.status !== 'draft') {
    return { kind: 'blocked', message: 'Deze factuur is geboekt en ligt vast. Klopt hij niet, boek dan de journaalpost tegen bij Grootboek → Journaal.' };
  }
  if (input.entryNumbers.length > 0) {
    const numbers = input.entryNumbers.slice(0, 4).join(', ');
    return {
      kind: 'blocked',
      message: `Dit concept is eerder geboekt en tegengeboekt (${numbers}). Die boekstukken verwijzen ernaar, dus het blijft bewaard, met zijn bewijsstuk. Verbeter het en boek het opnieuw.`,
    };
  }
  if (input.inboxItem?.channel === 'declaration') {
    return {
      kind: 'blocked',
      message: 'Dit is een declaratie van een teamlid. Wijs hem af op de werklijst (Binnengekomen → Afwijzen), met een reden: de indiener leest die. Het concept verdwijnt dan en de foto blijft bij de declaratie.',
    };
  }
  if (input.inboxItem) {
    const what = input.inboxItem.channel === 'email' ? 'De mail met de factuur' : 'De bon';
    return {
      kind: 'discard_inbox_item',
      inboxId: input.inboxItem.id,
      confirm: `Dit concept verwijderen? ${what} blijft bewaard op de werklijst, onder Afgehandeld (Genegeerd). Daar haal je hem binnen 30 dagen terug met Herstellen.`,
    };
  }
  if (input.attachments > 0) {
    return {
      kind: 'blocked',
      message: 'Aan dit concept hangt een bewijsstuk. Bewaar het zo nodig eerst (downloaden) en verwijder het hieronder bij Bewijsstukken; daarna kan het concept weg.',
    };
  }
  return { kind: 'delete', confirm: 'Dit concept verwijderen? Dat kan niet ongedaan worden gemaakt.' };
}
