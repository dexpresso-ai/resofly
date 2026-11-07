/**
 * Laden per module.
 *
 * Tot november 2026 laadde de werkruimte bij het opstarten 56 tabellen in hun
 * geheel, en na bijna elke wijziging deed refresh() dat opnieuw. Voor één
 * bureau met een jaar aan gegevens is dat te doen; voor een administratie met
 * vijf jaar journaalregels, banktransacties en uren wordt elke klik trager.
 *
 * Daarom twee soorten gegevens:
 *  - de KERN: wat bijna elke pagina en de vaste delen van het scherm gebruiken
 *    (klanten, projecten, taken, offertes, facturen, zoeken, de tabbladen,
 *    Gerrie). Die laadt bij het opstarten en bij elke ververs.
 *  - vijf GROEPEN met de tabellen die het hardst groeien en maar op een paar
 *    pagina's nodig zijn. Een groep laadt pas als een pagina hem nodig heeft,
 *    en blijft daarna bewaard.
 *
 * Na een wijziging ververst de app de kern plus de groepen van de pagina die
 * openstaat. De andere geladen groepen worden "verouderd": die verversen zodra
 * een pagina die ze nodig heeft weer openstaat, en tot dan toont zo'n pagina
 * wat er was. Een pagina rendert pas als al zijn groepen geladen zijn; hij ziet
 * dus nooit een lege lijst die eigenlijk nog moet binnenkomen.
 *
 * DE REGEL BIJ NIEUWE CODE: lees je in een bestand een veld uit een groep
 * (bijvoorbeeld `data.journalLines`), zet dat bestand dan in GROUP_FILES en de
 * pagina('s) die het tonen in PAGE_DATA_GROUPS. dataGroups.test.ts houdt het
 * eerste bij en faalt op een bestand dat er niet in staat.
 *
 * Puur (alleen types), zodat `npm test` er rechtstreeks overheen draait.
 */
import type { AppData } from '../types';

export type DataGroup = 'time' | 'communication' | 'financeHistory' | 'bookkeeping' | 'bank';

export const DATA_GROUPS: readonly DataGroup[] = ['time', 'communication', 'financeHistory', 'bookkeeping', 'bank'];

/** De velden van AppData per groep. Alles wat hier niet staat, hoort bij de kern. */
export const GROUP_FIELDS = {
  time: ['timeEntries'],
  communication: ['ticketNotes', 'clientCalls'],
  financeHistory: [
    'quoteApprovalEvents', 'quoteEmailDeliveries', 'quoteVersions',
    'invoiceWorkflowEvents', 'invoiceEmailDeliveries', 'invoicePaymentRecords', 'invoiceVersions',
    'invoiceRefunds', 'creditNotes', 'invoiceChargebacks', 'dunningNotices',
  ],
  bookkeeping: ['journalEntries', 'journalLines', 'closedPeriods', 'fiscalYears', 'fixedAssets', 'assetDepreciations', 'vatReturns'],
  bank: ['bankAccounts', 'bankStatements', 'bankTransactions', 'bankAllocations', 'bankRules', 'bankRequisitions'],
} as const satisfies Record<DataGroup, readonly (keyof AppData)[]>;

export type GroupField = (typeof GROUP_FIELDS)[DataGroup][number];
export type GroupData<G extends DataGroup> = Pick<AppData, (typeof GROUP_FIELDS)[G][number]>;
export type CoreData = Omit<AppData, GroupField>;

/**
 * Welke groepen een pagina nodig heeft. Een pagina die hier niet staat, heeft
 * genoeg aan de kern. Waarom per pagina: zie GROUP_FILES.
 */
export const PAGE_DATA_GROUPS: Readonly<Record<string, readonly DataGroup[]>> = {
  project: ['time', 'financeHistory'],
  client: ['time', 'communication'],
  communication: ['communication'],
  weekplanner: ['time'],
  calendar: ['time'],
  time: ['time'],
  quotes: ['financeHistory'],
  invoices: ['financeHistory'],
  ledger: ['bookkeeping'],
  bank: ['bank', 'bookkeeping'],
  'vat-returns': ['bookkeeping', 'bank'],
  assets: ['bookkeeping'],
  pnl: ['bookkeeping'],
};

/**
 * Bewerkvensters die zelf een groep nodig hebben, los van de pagina eronder:
 * het ticketvenster toont de tijdlijn, en dat venster opent vanaf elke pagina
 * (zoeken, een melding, de klantenkaart).
 */
export const EDIT_DATA_GROUPS: Readonly<Record<string, readonly DataGroup[]>> = {
  ticket: ['communication'],
};

/**
 * Welke bestanden een veld uit een groep lezen, en waar dat op het scherm komt.
 * dataGroups.test.ts faalt op elk ander bestand dat zo'n veld leest.
 */
export const GROUP_FILES: Readonly<Record<DataGroup, readonly string[]>> = {
  time: [
    'src/features/Projects.tsx', // ProjectPage: de uren per project (project)
    'src/features/Clients.tsx', // ClientDetailPage: de uren per klant (client)
    'src/features/WeekPlanner.tsx', // geboekt per taak en per afspraak (weekplanner)
    'src/features/CalendarPage.tsx', // geregistreerd per afspraak (calendar)
    'src/features/TimeTracking.tsx', // (time)
    'src/main.tsx', // reserveTimeForTask laadt de groep zelf; stopTimerForTask voegt één post toe
  ],
  communication: [
    'src/features/Clients.tsx', // ClientDetailPage: tickettijdlijn en gesprekken (client)
    'src/features/Communication.tsx', // Berichten (communication)
    'src/main.tsx', // het ticketvenster: EDIT_DATA_GROUPS
  ],
  financeHistory: [
    'src/features/Finance.tsx', // Quotes, Invoices (quotes, invoices) en ProjectQuotesPanel (project)
  ],
  bookkeeping: [
    'src/features/Bookkeeping.tsx', // LedgerPage (ledger)
    'src/lib/xaf.ts', // de auditfile, vanuit LedgerPage (ledger)
    'src/features/Bank.tsx', // (bank)
    'src/features/VatReturns.tsx', // (vat-returns)
    'src/features/Assets.tsx', // (assets)
    'src/features/ProfitLoss.tsx', // (pnl)
  ],
  bank: [
    'src/features/Bank.tsx', // (bank)
    'src/features/VatReturns.tsx', // betaalde aangiftes (vat-returns)
  ],
};

/** De groepen voor wat er nu op het scherm staat: de pagina plus een open bewerkvenster. */
export function groupsFor(page: string, editKind?: string | null): DataGroup[] {
  const wanted = new Set<DataGroup>([...(PAGE_DATA_GROUPS[page] ?? []), ...(editKind ? EDIT_DATA_GROUPS[editKind] ?? [] : [])]);
  return DATA_GROUPS.filter(group => wanted.has(group));
}

/** Lege waarden voor alle velden van alle groepen (allemaal lijsten). */
export function emptyGroupData(): Pick<AppData, GroupField> {
  const out: Record<string, unknown[]> = {};
  for (const group of DATA_GROUPS) for (const field of GROUP_FIELDS[group]) out[field] = [];
  return out as unknown as Pick<AppData, GroupField>;
}

// ── Wat de app per groep weet ───────────────────────────────────────────────

export interface GroupState {
  /** Geladen voor de organisatie die nu openstaat. */
  loaded: ReadonlySet<DataGroup>;
  /** Geladen, maar er is sindsdien iets gewijzigd: verversen zodra hij nodig is. */
  stale: ReadonlySet<DataGroup>;
  /** Laden mislukt, met de melding. Niet vanzelf opnieuw: dat doet Ververs of de knop op de pagina. */
  failed: ReadonlyMap<DataGroup, string>;
}

export const EMPTY_GROUP_STATE: GroupState = { loaded: new Set(), stale: new Set(), failed: new Map() };

/** Nog niet geladen. Een pagina die een van deze nodig heeft, wacht. */
export function missingGroups(state: GroupState, groups: readonly DataGroup[]): DataGroup[] {
  return groups.filter(group => !state.loaded.has(group));
}

/** Op te halen: niet geladen of verouderd, en niet mislukt. */
export function groupsToFetch(state: GroupState, groups: readonly DataGroup[]): DataGroup[] {
  return groups.filter(group => !state.failed.has(group) && (!state.loaded.has(group) || state.stale.has(group)));
}

/**
 * Er is iets gewijzigd: alle geladen groepen zijn verouderd, behalve `fresh`
 * (die worden nu opnieuw opgehaald). Oude meldingen vervallen, zodat een
 * mislukte groep het bij de volgende pagina opnieuw probeert.
 */
export function markStale(state: GroupState, fresh: readonly DataGroup[]): GroupState {
  const stale = new Set(state.stale);
  for (const group of state.loaded) if (!fresh.includes(group)) stale.add(group);
  return { loaded: state.loaded, stale, failed: new Map() };
}

/**
 * Een ophaalronde is terug. `outdated`: tijdens het ophalen begon een nieuwe
 * ververs, dus wat binnenkwam is van vóór die wijziging en blijft verouderd.
 */
export function applyFetch(
  state: GroupState,
  result: { loaded: readonly DataGroup[]; failed: ReadonlyArray<readonly [DataGroup, string]>; outdated: boolean },
): GroupState {
  // Alles vervallen (een nieuwere aanvraag liep al): niets te melden.
  if (result.loaded.length === 0 && result.failed.length === 0) return state;
  const loaded = new Set(state.loaded);
  const stale = new Set(state.stale);
  const failed = new Map(state.failed);
  for (const group of result.loaded) {
    loaded.add(group);
    failed.delete(group);
    if (result.outdated) stale.add(group); else stale.delete(group);
  }
  for (const [group, message] of result.failed) {
    failed.set(group, message);
    // Al in beeld, maar niet ververst: wat er staat, is van vóór de wijziging.
    if (loaded.has(group)) stale.add(group);
  }
  return { loaded, stale, failed };
}

/** Opnieuw proberen na een mislukte ronde (de knop op de pagina). */
export function clearFailed(state: GroupState, groups: readonly DataGroup[]): GroupState {
  if (!groups.some(group => state.failed.has(group))) return state;
  const failed = new Map(state.failed);
  for (const group of groups) failed.delete(group);
  return { ...state, failed };
}
