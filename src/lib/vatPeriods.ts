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

export const vatPeriodKey = (type: string, year: number, index: number) => `${type}:${year}:${index}`;

/**
 * Afgelopen tijdvakken zonder aangifte, oudste eerst. Vanaf de start van de
 * boekhouding (wat daarvóór viel, deed je buiten ResoFly) en hooguit twee
 * jaar terug. Met de KOR doe je geen aangifte: dan niets.
 *
 * Wisselen van tijdvak (kwartaal ↔ maand) gebeurt in de praktijk per
 * 1 januari: de Belastingdienst zet je om, of je vraagt het zelf aan. Hier
 * telde eerst alleen de frequentie van nu, en na zo'n wissel stonden alle
 * kwartalen van vorig jaar als twaalf niet aangegeven maanden op het
 * dashboard, rood. Daarom:
 * - een eerder jaar telt in de soort waarin het is aangegeven (alleen
 *   kwartalen of alleen maanden), anders in de frequentie van nu;
 * - een tijdvak is aangegeven als al zijn maanden in een aangifte vallen, per
 *   maand of per kwartaal (een wissel midden in het jaar).
 * Dezelfde regel als finalize_vat_return en close_fiscal_year (20261118100000).
 *
 * Sinds de inrichting elke organisatie een rekeningschema geeft
 * (20261118090000), zegt een rekeningschema niet meer dat je de btw in
 * ResoFly doet. Een organisatie die vandaag begon, kreeg zo "7
 * btw-aangiftes nog doen" in het rood: vanaf 1 januari vorig jaar, want de
 * startdatum is bij de inrichting niet verplicht. Daarom:
 * - zonder startdatum van de boekhouding én zonder één aangifte in ResoFly:
 *   geen herinnering;
 * - geen herinnering voor een deadline die al voorbij was toen de
 *   organisatie in ResoFly begon (`since`): die aangifte deed je elders. De
 *   jaarafsluiting vraagt die tijdvakken wel; die zegt dat zelf.
 */
export function vatPeriodsToFile(input: {
  today: string;
  frequency: VatFrequency;
  kor: boolean;
  bookkeepingStart: string | null;
  /** De dag waarop de organisatie in ResoFly begon (JJJJ-MM-DD). */
  since?: string | null;
  /** Sleutels (vatPeriodKey) van tijdvakken met een aangifte. */
  filed: ReadonlySet<string>;
}): VatPeriodDue[] {
  if (input.kor) return [];
  if (!input.bookkeepingStart && input.filed.size === 0) return [];
  const [ty] = input.today.split('-').map(Number);
  const start = input.bookkeepingStart ?? `${ty - 1}-01-01`;
  const twoYearsBack = `${ty - 2}-01-01`;
  const floor = start > twoYearsBack ? start : twoYearsBack;

  const kindsPerYear = new Map<number, Set<'month' | 'quarter'>>();
  const coveredMonths = new Set<string>();
  for (const key of input.filed) {
    const [type, y, i] = key.split(':');
    const year = Number(y);
    const index = Number(i);
    if (type !== 'month' && type !== 'quarter') continue;
    if (!kindsPerYear.has(year)) kindsPerYear.set(year, new Set());
    kindsPerYear.get(year)!.add(type);
    const firstMonth = type === 'month' ? index : (index - 1) * 3 + 1;
    for (let m = firstMonth; m < firstMonth + (type === 'month' ? 1 : 3); m++) coveredMonths.add(`${year}:${m}`);
  }
  const current: 'month' | 'quarter' = input.frequency === 'monthly' ? 'month' : 'quarter';

  const due: VatPeriodDue[] = [];
  for (let year = Number(floor.slice(0, 4)); year <= ty; year++) {
    const kinds = kindsPerYear.get(year);
    const type = year < ty && kinds?.size === 1 ? [...kinds][0] : current;
    for (let index = 1; index <= (type === 'month' ? 12 : 4); index++) {
      const period = vatPeriod(type, year, index);
      // Het lopende tijdvak (en wat erna komt) kan nog niet.
      if (period.to >= input.today) break;
      if (period.to < floor) continue;
      const firstMonth = type === 'month' ? index : (index - 1) * 3 + 1;
      const months = type === 'month' ? [firstMonth] : [firstMonth, firstMonth + 1, firstMonth + 2];
      if (months.every(m => coveredMonths.has(`${year}:${m}`))) continue;
      const deadline = vatFilingDeadline(period.to);
      if (input.since && deadline < input.since) continue;
      due.push({ ...period, deadline, overdue: input.today > deadline });
    }
  }
  return due;
}
