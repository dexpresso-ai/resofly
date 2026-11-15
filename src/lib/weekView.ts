/**
 * Rekenwerk voor de kop van de weekplanner: welke week is dit voor jou, hoe
 * heet hij, welke weken laat de weekkiezer zien en hoe vol zit de week.
 *
 * Bewust zonder imports (alleen datums en getallen): zo draait het direct
 * onder `npm test`, en kan de kop er niet stilletjes iets anders van maken dan
 * de tests verwachten.
 */

const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'] as const;
export const MONTHS_LONG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'] as const;

function mondayOf(d: Date): Date {
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = result.getDay();
  result.setDate(result.getDate() + (day === 0 ? -6 : 1 - day));
  return result;
}

/** Hele weken tussen twee maandagen; zomertijd telt niet als een uur verschil. */
function weeksBetween(fromMonday: Date, toMonday: Date): number {
  const a = Date.UTC(fromMonday.getFullYear(), fromMonday.getMonth(), fromMonday.getDate());
  const b = Date.UTC(toMonday.getFullYear(), toMonday.getMonth(), toMonday.getDate());
  return Math.round((b - a) / (7 * 86400000));
}

/**
 * "Deze week", "Volgende week", "Over 3 weken", "2 weken geleden". Het
 * weeknummer alleen zei je niet waar je stond: na twee keer bladeren wist je
 * niet meer of week 48 volgende week was of die daarna.
 */
export function relativeWeekLabel(anchor: Date, today: Date): string {
  const diff = weeksBetween(mondayOf(today), mondayOf(anchor));
  if (diff === 0) return 'Deze week';
  if (diff === 1) return 'Volgende week';
  if (diff === -1) return 'Vorige week';
  return diff > 1 ? `Over ${diff} weken` : `${-diff} weken geleden`;
}

/**
 * "9 – 15 nov 2026"; over een maandgrens "30 nov – 6 dec 2026", over een
 * jaargrens "29 dec 2025 – 4 jan 2026". Eerder stond er "09 nov – 15 nov
 * 2026": twee keer dezelfde maand en voorloopnullen die niemand uitspreekt.
 */
export function weekRangeLabel(anchor: Date, days = 7): string {
  const start = mondayOf(anchor);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days - 1);
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  const endLabel = `${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${end.getFullYear()}`;
  if (sameMonth) return `${start.getDate()} – ${endLabel}`;
  if (sameYear) return `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} – ${endLabel}`;
  return `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} ${start.getFullYear()} – ${endLabel}`;
}

/**
 * De maandagen van de weken die in een maand vallen, voor de weekkiezer.
 * Altijd zes rijen: dan springt het venster niet op en neer als je van een
 * maand met vijf naar een maand met zes weken bladert.
 */
export function pickerWeeks(year: number, month: number): Date[] {
  const first = mondayOf(new Date(year, month, 1));
  return Array.from({ length: 6 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i * 7));
}

export type WeekMeter = {
  /** Aandelen van de balk, in procenten (samen hooguit 100). */
  agendaPct: number;
  taskPct: number;
  /** Ruimte die nog over is tot je streep; `null` zonder streep. */
  freeMinutes: number | null;
  /** Hoeveel er boven je streep uitkomt; 0 als het past. */
  overMinutes: number;
};

/**
 * Hoe vol zit de week? Met een streep is de streep de maat, en zegt de balk
 * hoeveel er nog vrij is. Zonder streep is er geen norm (zo is de planner
 * bedoeld: zeven gelijkwaardige dagen, geen werkweek van iemand anders), en
 * toont de balk alleen de verhouding tussen afspraken en taken.
 */
export function weekMeter(agendaMinutes: number, taskMinutes: number, capacityMinutes: number | null): WeekMeter {
  const agenda = Math.max(0, agendaMinutes);
  const tasks = Math.max(0, taskMinutes);
  const used = agenda + tasks;
  if (capacityMinutes && capacityMinutes > 0) {
    const scale = Math.max(capacityMinutes, used);
    return {
      agendaPct: (agenda / scale) * 100,
      taskPct: (tasks / scale) * 100,
      freeMinutes: Math.max(0, capacityMinutes - used),
      overMinutes: Math.max(0, used - capacityMinutes),
    };
  }
  if (used <= 0) return { agendaPct: 0, taskPct: 0, freeMinutes: null, overMinutes: 0 };
  return { agendaPct: (agenda / used) * 100, taskPct: (tasks / used) * 100, freeMinutes: null, overMinutes: 0 };
}

/**
 * Hoeveel filters staan er écht aan? De oude telling vergeleek met een lege
 * waarde, terwijl "Alle prioriteiten" `all` is en "Open taken" `open`: de
 * planner meldde daardoor altijd "2 filters actief", ook als er niets
 * gefilterd werd, en bood "Filters wissen" aan voor niets.
 */
export function countActiveFilters(values: Record<string, string>, rest: Record<string, string>): number {
  return Object.keys(rest).filter(key => (values[key] ?? rest[key]).trim() !== rest[key]).length;
}
