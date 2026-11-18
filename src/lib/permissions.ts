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
 * De regels hieronder zijn een exacte spiegel van `public.member_module_level`
 * in de database (en van memberModuleLevel in supabase/functions/_shared/roles.ts;
 * roles.test.ts houdt die twee gelijk). Wijken ze af, dan volgt de database —
 * dat is de waarheid.
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
  gallery: 'projects',
  'project-planning': 'projects',
  archive: 'projects',
  calendar: 'calendar',
  'meeting-booking': 'calendar',
  time: 'time',
  stats: 'stats', report: 'stats',
  content: 'content',
  notes: 'content',
  documents: 'content',
  clients: 'clients',
  client: 'clients',
  // Berichten leest klantmail en de opvangbak: dezelfde tabellen (en dus
  // dezelfde RLS) als het klantdossier, dus dezelfde module.
  communication: 'clients',
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
  prepaid: 'finance',
  pnl: 'finance',
  // De prognose toont omzet, kosten en winst (migratie 20261118144500).
  forecast: 'finance',
  'vat-returns': 'finance',
  'corporate-tax': 'finance',
  'income-tax': 'finance',
  dga: 'finance',
  shareholders: 'finance',
  // Eenmanszaak, vof, maatschap en cv: vennoten en kapitaalvergelijking.
  owners: 'finance',
  'fiscal-years': 'finance',
  // VERPLICHT: canOpenPage laat een pagina zonder module voor iedereen open.
  // Zonder deze regel zou de jaarrekening zichtbaar zijn voor een teamlid met
  // finance = 'none', terwijl de tabellen eronder wél zijn afgeschermd.
  'annual-accounts': 'finance',
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
  /**
   * De module Gerrie staat open, maar dit lid heeft nog niet gekozen of hij
   * Gerrie wil (src/lib/aiConsent.ts). Dan is Gerrie overal dicht, behalve de
   * pagina Gerrie: daar staat het scherm om hem aan te zetten.
   */
  gerrieNeedsConsent: boolean;
  /**
   * De module Gerrie staat open, maar dit lid koos zelf voor geen AI. Dan is
   * Gerrie overal dicht, ook de pagina en het menu. Aanzetten kan alleen nog
   * onder Instellingen → AI.
   */
  gerrieDeclined: boolean;
  /**
   * Staat de module Gerrie open, los van de eigen keuze? Zo niet, dan heeft
   * een owner of admin hem dichtgezet en kan dit lid hem ook niet aanzetten.
   */
  gerrieModuleOpen: boolean;
}

export interface PermissionOptions {
  /**
   * Heeft dit lid Gerrie aangezet (ai_consents)? Zonder akkoord is de module
   * Gerrie voor de rest van de app dicht: geen chat, geen "Vraag Gerrie", geen
   * beslislijst en geen rapportages met Gerrie. Standaard aan, voor plekken
   * waar het niet speelt (het portaal, het laden van de gegevens).
   */
  aiEnabled?: boolean;
  /**
   * Koos dit lid zelf voor geen AI (een rij in ai_consents met Gerrie uit)?
   * Dan verdwijnt ook de pagina Gerrie, en daarmee Gerrie uit het menu.
   * Alleen van belang als aiEnabled false is.
   */
  aiDeclined?: boolean;
}

/** Rollen die mogen wijzigen (als de module het ook toestaat). Een allowlist:
 *  een viewer en de boekhouder wijzigen nergens. */
export const WRITER_ROLES: OrganizationRole[] = ['owner', 'admin', 'member'];

export function isWriterRole(role: OrganizationRole | null | undefined): boolean {
  return Boolean(role && WRITER_ROLES.includes(role));
}

/** Owners en admins: zij beheren de organisatie, zoals het abonnement. Spiegel
 *  van `public.can_admin_org` in de database. */
export function isAdminRole(role: OrganizationRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** De boekhouder: een gast die alleen Financiën mag lezen. */
export function isAccountantRole(role: OrganizationRole | null | undefined): boolean {
  return role === 'accountant';
}

/**
 * Bepaal de effectieve rechten. Spiegel van `public.member_module_level`:
 * owners/admins zijn nooit beperkt, de boekhouder leest alleen Financiën, een
 * viewer nooit meer dan lezen, bij een member betekent een ontbrekende sleutel
 * volledige toegang, en een onbekende rol krijgt niets.
 */
export function resolveModuleLevel(
  role: OrganizationRole | null | undefined,
  access: ModuleAccess,
  module: ModuleKey,
): ModuleLevel {
  if (!role) return 'none';
  if (role === 'owner' || role === 'admin') return 'write';
  if (role === 'accountant') return module === 'finance' ? 'read' : 'none';
  const stored = access[module] ?? 'write';
  if (role === 'viewer') return stored === 'none' ? 'none' : 'read';
  if (role === 'member') return stored;
  return 'none';
}

export function buildPermissions(membership: MembershipLike | null | undefined, options: PermissionOptions = {}): Permissions {
  const role = membership?.role ?? null;
  const access = parseModuleAccess(membership?.module_access);
  const aiEnabled = options.aiEnabled ?? true;
  // Wat de eigenaar of een beheerder instelde, los van het eigen akkoord.
  const moduleLevel = (module: ModuleKey): ModuleLevel => resolveModuleLevel(role, access, module);
  // Wat er nu kan: zonder akkoord is Gerrie dicht. Via canRead('gerrie')
  // verdwijnen zo in één keer de chat, de knoppen en de kaarten van Gerrie,
  // op elke plek die al naar de module keek.
  const level = (module: ModuleKey): ModuleLevel => (module === 'gerrie' && !aiEnabled ? 'none' : moduleLevel(module));
  const canRead = (module: ModuleKey) => level(module) !== 'none';
  const canWrite = (module: ModuleKey) => level(module) === 'write';
  const gerrieModuleOpen = moduleLevel('gerrie') !== 'none';
  const gerrieDeclined = !aiEnabled && Boolean(options.aiDeclined) && gerrieModuleOpen;
  const gerrieNeedsConsent = !aiEnabled && !gerrieDeclined && gerrieModuleOpen;

  return {
    level,
    canRead,
    canWrite,
    canOpenPage: (page: string) => {
      if (page === DECLARATIONS_PAGE) return canSubmitDeclarations(role, level('finance'));
      const module = PAGE_MODULE[page];
      // De pagina Gerrie blijft open zolang de module open is en het lid nog
      // niet koos: daar zet je hem aan. Koos hij voor geen AI, dan is ook de
      // pagina dicht. Zo verdwijnt Gerrie uit de zijbalk, Zenit, de duimbalk
      // en het zoeken, die allemaal naar canOpenPage kijken.
      if (module === 'gerrie') return gerrieModuleOpen && !gerrieDeclined;
      return module ? canRead(module) : Boolean(role);
    },
    canWritePage: (page: string) => {
      // Een viewer en de boekhouder schrijven nergens; pagina's zonder module
      // (dashboard, instellingen) volgen verder de organisatiebrede rol.
      if (!isWriterRole(role)) return false;
      const module = PAGE_MODULE[page];
      return module ? canWrite(module) : true;
    },
    // Over de rechten die iemand kreeg, niet over zijn eigen keuze voor Gerrie.
    isRestricted: Boolean(role) && role !== 'owner' && role !== 'admin'
      && MODULE_KEYS.some(key => moduleLevel(key) !== 'write'),
    gerrieNeedsConsent,
    gerrieDeclined,
    gerrieModuleOpen,
  };
}

/**
 * De pagina Declaraties (2026-11-18). Hij hoort bij geen module: iedereen die
 * schrijft, mag een bon insturen. Maar wie Financiën mag bewerken, fotografeert
 * zijn bon op Inkoopfacturen en krijgt meteen een concept; voor hem is er
 * niets te declareren, en de pagina zou alleen een lege lijst tonen. De server
 * (invoice-inbox) beslist het kanaal op dezelfde regel.
 */
export const DECLARATIONS_PAGE = 'declarations';

export function canSubmitDeclarations(role: OrganizationRole | null | undefined, financeLevel: ModuleLevel): boolean {
  return isWriterRole(role) && financeLevel !== 'write';
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
