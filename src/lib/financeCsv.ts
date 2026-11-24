/**
 * De regels voor de CSV van de btw-aangifte per tijdvak en van de
 * kapitaalvergelijking (Financiën → Eigen vermogen), voor wie ze bewaart of
 * aan de boekhouder stuurt.
 *
 * Winst & verlies, Balans, Openstaande posten, de ICP-opgaaf en de
 * IB-specificatie hadden al een CSV; deze twee niet. De boekhouder nam de
 * kapitaalvergelijking dus over van het scherm, en de rubrieken van een
 * aangifte waren nergens te bewaren dan als schermafdruk. De bedragen komen
 * uit dezelfde berekening als het scherm (compute_vat_return en
 * loadOwnersEquityOverview), hier alleen in regels gezet.
 *
 * Puur, zodat `npm test` er rechtstreeks overheen draait. Bedragen als
 * "1234.56": csv.ts maakt er in de download een komma van.
 */
import type { OwnersEquityOverview, VatReturnBox, VatReturnRubrieken } from '../types';

const amount = (cents: number | null | undefined): string => ((cents ?? 0) / 100).toFixed(2);

export interface VatBoxDefinition { box: string; label: string; hasVat: boolean; alwaysShow: boolean }

export const VAT_RETURN_CSV_HEADER = ['Rubriek', 'Omschrijving', 'Grondslag', 'Btw', 'Aangifte omzet (hele €)', 'Aangifte btw (hele €)'];

/**
 * De rubrieken zoals op het scherm: dezelfde rijen (een lege 1c, 1d of 3c valt
 * weg), met de grondslag en btw in euro's en centen en wat je in Mijn
 * Belastingdienst invult in hele euro's. Een oude aangifte zonder
 * rubriekverdeling geeft de vijf vaste regels van toen.
 */
export function vatReturnCsvRows(r: VatReturnRubrieken, boxes: readonly VatBoxDefinition[]): (string | number)[][] {
  const form = (key: string): VatReturnBox | null => {
    const v = r.form?.[key];
    return v && typeof v === 'object' ? v : null;
  };
  const formTotal = (key: string): string => {
    const v = r.form?.[key];
    return typeof v === 'number' ? String(v) : '';
  };
  const saldoAfgerond = r.saldo_afgerond ?? (r.saldo < 0 ? -Math.round(-r.saldo / 100) : Math.round(r.saldo / 100)) * 100;
  const rows: (string | number)[][] = [];
  if (r.boxes) {
    for (const def of boxes) {
      const b = r.boxes[def.box];
      const base = b?.base ?? 0;
      const vat = b?.vat ?? 0;
      if (!def.alwaysShow && base === 0 && vat === 0) continue;
      const f = form(def.box);
      rows.push([def.box, def.label, amount(base), def.hasVat ? amount(vat) : '', f ? String(f.base ?? 0) : '', f && def.hasVat ? String(f.vat ?? 0) : '']);
    }
    rows.push(['5a', 'Verschuldigde omzetbelasting', '', amount(r.verschuldigd_total), '', formTotal('5a')]);
    rows.push(['5b', 'Voorbelasting', '', amount(r.voorbelasting), '', formTotal('5b')]);
    rows.push(['5c', 'Saldo (5a − 5b)', '', amount(r.saldo), '', formTotal('5c')]);
  } else {
    rows.push(['1a', 'Leveringen/diensten 21%', amount(r.omzet_hoog_base), amount(r.omzet_hoog_btw), '', '']);
    rows.push(['1b', 'Leveringen/diensten 9%', amount(r.omzet_laag_base), amount(r.omzet_laag_btw), '', '']);
    rows.push(['1e', 'Leveringen/diensten 0% of niet bij u belast', amount(r.omzet_nul_base), '', '', '']);
    rows.push(['2a', 'Verleggingsregelingen / intracommunautaire verwerving', '', amount(r.verlegd_btw), '', '']);
    rows.push(['5a', 'Verschuldigde omzetbelasting', '', amount(r.verschuldigd_total), '', '']);
    rows.push(['5b', 'Voorbelasting', '', amount(r.voorbelasting), '', '']);
    rows.push(['5c', 'Berekend saldo', '', amount(r.saldo), '', '']);
  }
  rows.push(['5g', saldoAfgerond >= 0 ? 'Totaal te betalen' : 'Totaal terug te vragen', '', amount(Math.abs(saldoAfgerond)), '', '']);
  return rows;
}

/**
 * Sinds 24 november 2026 met "Naar rekening-courant": het kapitaal van een
 * uitgetreden vennoot gaat bij de jaarafsluiting naar zijn rekening-courant,
 * en het eind is dan zoveel lager. Zonder die kolom telde een regel niet meer op.
 */
export const EQUITY_CSV_HEADER = ['Naam', 'Winstaandeel', 'Begin', 'Resultaat', 'Stortingen', 'Opnamen', 'Overig', 'Naar rekening-courant', 'Eind'];

/**
 * De kapitaalvergelijking: per ondernemer of vennoot begin, resultaat,
 * stortingen, opnamen (negatief, zoals op het scherm), overig en eind, met het
 * deel op geen enkele vennoot en het totaal.
 */
export function equityCsvRows(overview: OwnersEquityOverview): (string | number)[][] {
  const share = (bp: number) => `${(bp / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}%`;
  const rows: (string | number)[][] = overview.owners.map(o => [
    o.name + (o.isActive ? '' : ' (uitgetreden)'),
    overview.isPartnership ? share(o.shareBasisPoints) : '',
    amount(o.beginCents), amount(o.resultShareCents), amount(o.contributionsCents),
    amount(o.withdrawalsCents ? -o.withdrawalsCents : 0), amount(o.otherMovementsCents),
    amount(o.toCurrentAccountCents ? -o.toCurrentAccountCents : 0), amount(o.endCents),
  ]);
  const u = overview.unassigned;
  if (u) rows.push(['Nog niet aan een vennoot toegewezen', '', amount(u.beginCents), '', '', '', amount(u.movementsCents), '', amount(u.endCents)]);
  const sum = (pick: (o: OwnersEquityOverview['owners'][number]) => number) => overview.owners.reduce((s, o) => s + pick(o), 0);
  const withdrawals = sum(o => o.withdrawalsCents);
  const toCurrent = sum(o => o.toCurrentAccountCents ?? 0);
  rows.push([
    'Totaal', '',
    amount(sum(o => o.beginCents) + (u?.beginCents ?? 0)),
    amount(sum(o => o.resultShareCents)),
    amount(sum(o => o.contributionsCents)),
    amount(withdrawals ? -withdrawals : 0),
    amount(sum(o => o.otherMovementsCents) + (u?.movementsCents ?? 0)),
    amount(toCurrent ? -toCurrent : 0),
    amount(sum(o => o.endCents) + (u?.endCents ?? 0)),
  ]);
  rows.push([
    `Boekjaar ${overview.fiscalYear.label}`, overview.fiscalYear.status === 'closed' ? 'afgesloten' : 'voorlopig',
    '', amount(overview.resultCents), '', '', '', '', '',
  ]);
  return rows;
}

/** Een regel van het overzicht voor de aangifte IB, zoals Eigen vermogen hem toont. */
export interface IncomeTaxSummaryLine { label: string; cents: number; sign?: '' | '+' | '−' | '=' }

export const INCOME_TAX_SUMMARY_CSV_HEADER = ['Post', 'Bedrag'];

/**
 * Het overzicht voor de aangifte IB (van winst naar belastbare winst), regel
 * voor regel. Op het scherm staat het teken ervoor ("− € 1.200"); in de CSV is
 * een aftrek een negatief bedrag, zodat de kolom optelt. Een kolom met "=" of
 * "+" las Excel bovendien als formule.
 */
export function incomeTaxSummaryCsvRows(lines: readonly IncomeTaxSummaryLine[]): (string | number)[][] {
  return lines.map(l => [l.label, amount(l.sign === '−' ? -l.cents : l.cents)]);
}
