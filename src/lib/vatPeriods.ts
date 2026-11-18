/**
 * Btw-tijdvakken en hun deadline.
 *
 * De aangifte omzetbelasting over een maand of kwartaal doe én betaal je
 * uiterlijk op de laatste dag van de maand na afloop van het tijdvak: Q1 op
 * 30 april, Q4 op 31 januari. Doen kan pas na afloop van het tijdvak; de
 * database weigert daarom ook een tijdvak dat nog loopt af te sluiten
 * (finalize_vat_return, 20261118090000).
 *
 * Het dashboard telde tot 18 november aangiftes met status "doorgeboekt",
 * terwijl afsluiten in het scherm ze meteen op "ingediend" zet: de melding
 * kwam vrijwel nooit. Nu telt het wat er echt nog moet: afgelopen tijdvakken
 * zonder aangifte, vanaf de start van de boekhouding in ResoFly.
 */

export type VatFrequency = 'monthly' | 'quarterly';

export interface VatPeriod {
  type: 'month' | 'quarter';
  year: number;
  index: number;
  /** Eerste en laatste dag (JJJJ-MM-DD). */
  from: string;
  to: string;
  /** "Q3 2026" of "september 2026". */
  label: string;
}

export interface VatPeriodDue extends VatPeriod {
  /** Uiterlijk deze dag aangifte doen en betalen. */
  deadline: string;
  /** De deadline is voorbij. */
  overdue: boolean;
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function vatPeriod(type: 'month' | 'quarter', year: number, index: number): VatPeriod {
  const firstMonth = type === 'month' ? index : (index - 1) * 3 + 1;
  const lastMonth = type === 'month' ? index : firstMonth + 2;
  return {
    type, year, index,
    from: `${year}-${pad2(firstMonth)}-01`,
    to: `${year}-${pad2(lastMonth)}-${pad2(lastDayOf(year, lastMonth))}`,
    label: type === 'month' ? `${MONTHS[index - 1]} ${year}` : `Q${index} ${year}`,
  };
}

/** De laatste dag van de maand na het einde van het tijdvak. */
export function vatFilingDeadline(periodTo: string): string {
  const [year, month] = periodTo.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${pad2(nextMonth)}-${pad2(lastDayOf(nextYear, nextMonth))}`;
}

/** Het tijdvak waarin `date` valt. */
export function vatPeriodOf(date: string, frequency: VatFrequency): VatPeriod {
  const [year, month] = date.split('-').map(Number);
  return frequency === 'monthly' ? vatPeriod('month', year, month) : vatPeriod('quarter', year, Math.floor((month - 1) / 3) + 1);
}

function previous(period: VatPeriod): VatPeriod {
  if (period.type === 'month') return period.index === 1 ? vatPeriod('month', period.year - 1, 12) : vatPeriod('month', period.year, period.index - 1);
  return period.index === 1 ? vatPeriod('quarter', period.year - 1, 4) : vatPeriod('quarter', period.year, period.index - 1);
}

export const vatPeriodKey = (type: string, year: number, index: number) => `${type}:${year}:${index}`;

/**
 * Afgelopen tijdvakken zonder aangifte, oudste eerst. Vanaf de start van de
 * boekhouding (wat daarvóór viel, deed je buiten ResoFly) en hooguit twee
 * jaar terug. Met de KOR doe je geen aangifte: dan niets.
 */
export function vatPeriodsToFile(input: {
  today: string;
  frequency: VatFrequency;
  kor: boolean;
  bookkeepingStart: string | null;
  /** Sleutels (vatPeriodKey) van tijdvakken met een aangifte. */
  filed: ReadonlySet<string>;
}): VatPeriodDue[] {
  if (input.kor) return [];
  const [ty] = input.today.split('-').map(Number);
  const start = input.bookkeepingStart ?? `${ty - 1}-01-01`;
  const twoYearsBack = `${ty - 2}-01-01`;
  const floor = start > twoYearsBack ? start : twoYearsBack;
  const due: VatPeriodDue[] = [];
  let period = previous(vatPeriodOf(input.today, input.frequency));
  for (let i = 0; i < 40 && period.to >= floor; i++) {
    if (!input.filed.has(vatPeriodKey(period.type, period.year, period.index))) {
      const deadline = vatFilingDeadline(period.to);
      due.push({ ...period, deadline, overdue: input.today > deadline });
    }
    period = previous(period);
  }
  return due.reverse();
}
