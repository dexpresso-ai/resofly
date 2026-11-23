/**
 * De jaarwissel: waar een pagina op opent als het kalenderjaar net om is.
 *
 * Puur rekenwerk, met de datum van vandaag als argument (zie
 * jaarwissel.test.ts). Bij de controle van 22 november 2026, met de klok op
 * 2 januari 2027, opende Inkomstenbelasting op "Winst 2027 € 0,00" en
 * Omzetbelasting op "Saldo Q1 2027 € 0,00", terwijl de zzp'er in januari iets
 * heel anders moet: de btw over Q4 aangeven en zijn aangifte over 2026
 * voorbereiden. Hij vond het pas door het jaar terug te zetten.
 */
import type { VatFrequency, VatPeriodDue } from './vatPeriods';

/** De aangifte inkomstenbelasting over een jaar doe je vóór 1 mei van het jaar erna. */
const INCOME_TAX_FILING_LAST_MONTH = 4;

export interface IncomeTaxOpening {
  /** Het jaar waarop de pagina opent. */
  year: number;
  /**
   * In de maanden van de aangifte (januari t/m april): het jaar waarover je nu
   * aangifte doet. De pagina zet er dan een knop bij. Null buiten die maanden,
   * of als ResoFly dat jaar niet kent.
   */
  filingYear: number | null;
}

/**
 * Inkomstenbelasting opent tot 1 mei op het vorige jaar: dat is het jaar van
 * je aangifte. Alleen als de boekhouding in ResoFly toen al liep. Wie in
 * januari begint, of geen startdatum heeft vastgelegd, heeft over vorig jaar
 * niets staan en zou naar een lege raming kijken.
 */
export function incomeTaxOpening(input: { today: string; firstYear: number; bookkeepingStart: string | null }): IncomeTaxOpening {
  const [year, month] = input.today.split('-').map(Number);
  const current = Math.max(year, input.firstYear);
  const previous = year - 1;
  const startYear = input.bookkeepingStart ? Number(input.bookkeepingStart.slice(0, 4)) : null;
  const filing = month <= INCOME_TAX_FILING_LAST_MONTH && previous >= input.firstYear && startYear !== null && startYear <= previous;
  return filing ? { year: previous, filingYear: previous } : { year: current, filingYear: null };
}

export interface VatOpening {
  view: VatFrequency;
  year: number;
  /** 1 t/m 12. */
  month: number;
  /** 1 t/m 4. */
  quarter: number;
}

/**
 * Omzetbelasting opent op het oudste tijdvak dat nog moet (hetzelfde tijdvak
 * als de herinnering op het dashboard), en anders op het tijdvak van vandaag.
 * Een tijdvak dat nog moet kan in een andere soort staan dan de instelling:
 * na een wissel per 1 januari doe je het laatste kwartaal nog per kwartaal.
 */
export function vatOpening(input: { today: string; frequency: VatFrequency; nextDue: Pick<VatPeriodDue, 'type' | 'year' | 'index'> | null }): VatOpening {
  const [year, month] = input.today.split('-').map(Number);
  const due = input.nextDue;
  if (!due) return { view: input.frequency, year, month, quarter: Math.floor((month - 1) / 3) + 1 };
  if (due.type === 'month') return { view: 'monthly', year: due.year, month: due.index, quarter: Math.floor((due.index - 1) / 3) + 1 };
  // De maand volgt het kwartaal, voor wie daarna naar Maand schakelt.
  return { view: 'quarterly', year: due.year, month: (due.index - 1) * 3 + 1, quarter: due.index };
}

/**
 * Het kalenderjaar dat nog geen boekjaar heeft, terwijl het vorige jaar er wel
 * een had. Bij een eenmanszaak, vof, maatschap of cv opent de database het
 * boekjaar vanzelf bij de eerste boeking in het nieuwe jaar (20261123141000).
 * Wie in januari nog niets geboekt heeft, zag op Eigen vermogen alleen het
 * oude jaar, zonder één woord over het nieuwe. Hiermee kan de pagina het
 * zeggen en een knop tonen. Null als er niets ontbreekt, of als een mens het
 * boekjaar moet kiezen (een BV met een gebroken boekjaar, geen boekjaren).
 */
export function missingFiscalYear(input: { today: string; calendarYearOnly: boolean; years: ReadonlyArray<{ period_start: string; period_end: string }> }): number | null {
  if (!input.calendarYearOnly) return null;
  const year = Number(input.today.slice(0, 4));
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  if (input.years.some(y => y.period_start.slice(0, 10) <= to && y.period_end.slice(0, 10) >= from)) return null;
  return input.years.some(y => y.period_end.slice(0, 10) === `${year - 1}-12-31`) ? year : null;
}
