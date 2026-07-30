import type { OrganizationRole } from '../types';

/**
 * Modulerechten per teamlid.
 *
 * Owners/admins stellen per medewerker en per module in wat diegene mag:
 * geen / alleen lezen / volledig. De database dwingt dit af (restrictive
 * RLS-policies + schrijf-triggers, migratie 20260730100000); dit bestand is
 * puur de beleving: zijbalk, pagina's en knoppen tonen niets waar het lid
 * toch niets mee kan.
 *
 * De regels hieronder zijn een exacte spiegel van `public.org_module_level`
 * in de database. Wijken ze af, dan volgt de database — dat is de waarheid.
 */

export type ModuleKey =
  | 'clients'
  | 'projects'
  | 'time'
  | 'calendar'
  | 'tickets'
  | 'content'
  | 'stats'
  | 'marketing'
  | 'finance'
  | 'chat'
  | 'gerrie';

export type ModuleLevel = 'none' | 'read' | 'write';

/** Wat er per lid is opgeslagen. Een ontbrekende sleutel betekent volledig. */
export type ModuleAccess = Partial<Record<ModuleKey, ModuleLevel>>;

export const MODULE_KEYS: ModuleKey[] = [
  'clients', 'projects', 'time', 'calendar', 'tickets',
  'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie',
];

/** Volgorde en teksten van het rechtenraster op de instellingenpagina. */
export const MODULES: Array<{ key: ModuleKey; label: string; description: string }> = [
  { key: 'clients', label: 'Klanten', description: 'Klantenkaarten, contactpersonen en klant-e-mail.' },
  { key: 'projects', label: 'Projecten', description: 'Projecten, taken, weekplanner, archief en projectsjablonen.' },
  { key: 'time', label: 'Uren', description: 'Urenregistratie en het urenoverzicht.' },
  { key: 'calendar', label: 'Agenda', description: 'Agenda, gekoppelde agenda’s, boekingslinks en meetings.' },
  { key: 'tickets', label: 'Tickets', description: 'Binnenkomende tickets en de ticket-tijdlijn.' },
  { key: 'content', label: 'Inhoud', description: 'Notities, documenten en mappen.' },
  { key: 'stats', label: 'Statistieken', description: 'Rapportages en opgeslagen rapporten.' },
  { key: 'marketing', label: 'Marketing', description: 'E-mailcampagnes en automatische e-mailstromen.' },
  { key: 'finance', label: 'Financiën', description: 'Offertes, contracten, facturen, inkoop, grootboek, bank, activa, W&V en BTW.' },
  { key: 'chat', label: 'Teamchat', description: 'Interne chatkanalen en directe berichten.' },
  { key: 'gerrie', label: 'Gerrie (AI)', description: 'De AI-assistent en het commandocentrum.' },
];

export const MODULE_LABELS: Record<ModuleKey, string> = MODULES.reduce((acc, m) => {
  acc[m.key] = m.label;
  return acc;
}, {} as Record<ModuleKey, string>);

export const LEVEL_LABELS: Record<ModuleLevel, string> = {
  none: 'Geen toegang',
  read: 'Alleen lezen',
  write: 'Volledig',
};

/**
 * Welke module hoort bij welke pagina. Pagina's die hier ontbreken
 * (dashboard, instellingen) zijn altijd bereikbaar.
 */
export const PAGE_MODULE: Record<string, ModuleKey> = {
  gerrie: 'gerrie',
  chat: 'chat',
  weekplanner: 'projects',
  projects: 'projects',
  project: 'projects',
  'project-planning': 'projects',
  archive: 'projects',
  calendar: 'calendar',
  'calendar-settings': 'calendar',
  'meeting-booking': 'calendar',
  time: 'time',
  stats: 'stats',
  content: 'content',
  notes: 'content',
  documents: 'content',
  clients: 'clients',
  client: 'clients',
  tickets: 'tickets',
  marketing: 'marketing',
  quotes: 'finance',
  contracts: 'finance',
  invoices: 'finance',
  suppliers: 'finance',
  'purchase-invoices': 'finance',
  ledger: 'finance',
  bank: 'finance',
  assets: 'finance',
  pnl: 'finance',
  'vat-returns': 'finance',
  'fiscal-years': 'finance',
};

/**
 * Welke module hoort bij welk soort bewerkvenster. Het bewerkvenster leeft naast
 * de pagina (je kunt vanaf een project een factuur openen), dus het leidt zijn
 * rechten af uit wat er bewerkt wordt — niet uit de pagina eronder.
 */
export const EDIT_KIND_MODULE: Record<string, ModuleKey> = {
  client: 'clients',
  project: 'projects',
  task: 'projects',
  ticket: 'tickets',
  note: 'content',
  document: 'content',
  quote: 'finance',
  invoice: 'finance',
};

/** Ruwe jsonb uit de database omzetten naar een getypeerde, gevalideerde map. */
export function parseModuleAccess(raw: unknown): ModuleAccess {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ModuleAccess = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MODULE_KEYS as string[]).includes(key)) continue;
    if (value === 'none' || value === 'read' || value === 'write') out[key as ModuleKey] = value;
  }
  return out;
}

export interface MembershipLike {
  role: OrganizationRole;
  module_access?: unknown;
}

export interface Permissions {
  /** Effectief niveau voor één module. */
  level: (module: ModuleKey) => ModuleLevel;
  canRead: (module: ModuleKey) => boolean;
  canWrite: (module: ModuleKey) => boolean;
  /** Mag deze pagina geopend worden? Pagina's zonder module zijn altijd open. */
  canOpenPage: (page: string) => boolean;
  /** Mag er op deze pagina gewijzigd worden? */
  canWritePage: (page: string) => boolean;
  /** Is dit lid ergens beperkt? (bepaalt of we het uitlegzinnetje tonen) */
  isRestricted: boolean;
}

/**
 * Bepaal de effectieve rechten. Spiegel van `public.org_module_level`:
 * owners/admins zijn nooit beperkt, een viewer nooit meer dan lezen, en een
 * ontbrekende sleutel betekent volledige toegang.
 */
export function resolveModuleLevel(
  role: OrganizationRole | null | undefined,
  access: ModuleAccess,
  module: ModuleKey,
): ModuleLevel {
  if (!role) return 'none';
  if (role === 'owner' || role === 'admin') return 'write';
  const stored = access[module] ?? 'write';
  if (role === 'viewer') return stored === 'none' ? 'none' : 'read';
  return stored;
}

export function buildPermissions(membership: MembershipLike | null | undefined): Permissions {
  const role = membership?.role ?? null;
  const access = parseModuleAccess(membership?.module_access);
  const level = (module: ModuleKey): ModuleLevel => resolveModuleLevel(role, access, module);
  const canRead = (module: ModuleKey) => level(module) !== 'none';
  const canWrite = (module: ModuleKey) => level(module) === 'write';

  return {
    level,
    canRead,
    canWrite,
    canOpenPage: (page: string) => {
      const module = PAGE_MODULE[page];
      return module ? canRead(module) : Boolean(role);
    },
    canWritePage: (page: string) => {
      // Een viewer schrijft nergens; pagina's zonder module (dashboard,
      // instellingen) volgen verder de organisatiebrede rol.
      if (!role || role === 'viewer') return false;
      const module = PAGE_MODULE[page];
      return module ? canWrite(module) : true;
    },
    isRestricted: Boolean(role) && role !== 'owner' && role !== 'admin'
      && MODULE_KEYS.some(key => level(key) !== 'write'),
  };
}

/** Alle rechten volledig — voor plekken zonder membership-context (portaal, publieke pagina's). */
export const FULL_PERMISSIONS: Permissions = buildPermissions({ role: 'owner' });

/**
 * Eerste pagina waar dit lid wél bij mag. Gebruikt wanneer iemand op een
 * afgeschermde pagina landt (bijv. via een onthouden tabblad of een deeplink).
 */
export function firstAllowedPage(permissions: Permissions): string {
  const order = ['dashboard', 'weekplanner', 'projects', 'clients', 'calendar', 'time', 'tickets', 'content', 'stats', 'chat', 'marketing', 'quotes', 'gerrie'];
  return order.find(page => permissions.canOpenPage(page)) ?? 'dashboard';
}
