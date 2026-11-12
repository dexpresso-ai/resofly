/**
 * Losse apps (2026-11-12): Agenda, Financiën en Communicatie elk als eigen app
 * op het beginscherm, in het dock of in de taakbalk.
 *
 * Het is dezelfde app als de werkruimte, op een eigen adres (/app/agenda/, …)
 * met een eigen manifest. Daar opent hij meteen op de pagina van die module,
 * en toont het menu alleen de pagina's die erbij horen. Zo spring je met één
 * tik naar je agenda of je facturen, zonder eerst langs het dashboard en het
 * menu.
 *
 * Een eigen adres per app is nodig omdat een browser een geïnstalleerde app
 * herkent aan zijn manifest (`id`) en aan het adres waarop hij woont (`scope`).
 * Met één manifest voor alles kun je maar één app installeren. Zo deden Docs,
 * Sheets en Slides van Google het ook: één site, drie apps, elk een eigen pad.
 *
 * Rechten veranderen hier niet. Een app laat alleen zien wat dit teamlid in de
 * werkruimte ook mag openen (`permissions.canOpenPage`); staat de module dicht,
 * dan is de app leeg en wijst hij naar de werkruimte.
 *
 * `page` is hier bewust een string, net als in workspaceTabs.ts: de `Page`-union
 * woont in main.tsx, en een import daarvandaan zou een kring maken.
 *
 * De werkruimte zelf is sinds dezelfde dag ook een app op een eigen adres
 * (/app/werkruimte/, zie WORKSPACE_APP). Eerst was zijn scope "/", heel
 * ResoFly. Android zag dan /app/agenda/ als een pagina van de al geïnstalleerde
 * ResoFly-app en zei bij Installeren "deze app is al geïnstalleerd": wie
 * ResoFly op zijn telefoon had, kon er geen tweede app bij zetten. Vier apps
 * naast elkaar kan alleen als geen van hun adressen onder een ander valt.
 */

export type StandaloneAppId = 'agenda' | 'financien' | 'communicatie';

/** Wat elke app heeft die je kunt installeren, de werkruimte ook. */
export interface InstallableApp {
  id: StandaloneAppId | 'werkruimte';
  /** Waar de app woont, met een slash aan het eind. Dat is ook de `scope` en de
   *  `start_url` van zijn manifest: alles daaronder hoort bij deze app. */
  path: string;
  /** De naam onder het icoon en in de titelbalk. */
  name: string;
  /** Korte naam, voor onder het icoon op een telefoon (±12 tekens). */
  shortName: string;
  /** Eén zin, voor bij Instellingen → Apps. */
  description: string;
  manifest: string;
  /** Het tabblad en Instellingen → Apps: het icoon zoals het is, met ronde hoeken. */
  icon: string;
  /** Voor `apple-touch-icon`: Safari op iOS leest het icoon niet uit het manifest.
   *  Een volle tegel zonder doorzichtige hoeken: iOS rondt zelf af, en maakt
   *  wat doorzichtig is zwart. Daarom niet `icon` (scripts/app-iconen.mjs). */
  touchIcon: string;
}

/**
 * De hele werkruimte als app. Hetzelfde manifest als altijd
 * (public/manifest.webmanifest, met `id` "/"), zodat een ResoFly-app die al
 * op een telefoon of computer staat dezelfde app blijft en zich bijwerkt naar
 * het nieuwe adres. Op "/" in de browser verandert er niets.
 */
export const WORKSPACE_APP: InstallableApp = {
  id: 'werkruimte',
  path: '/app/werkruimte/',
  name: 'ResoFly',
  shortName: 'ResoFly',
  description: 'De hele werkruimte, met alles wat je hier ook hebt.',
  manifest: '/manifest.webmanifest',
  icon: '/icons/icon-192.png',
  touchIcon: '/icons/apple-touch-icon.png',
};

export interface StandaloneApp extends InstallableApp {
  id: StandaloneAppId;
  /** De pagina's die bij deze app horen; het menu toont alleen deze. */
  pages: readonly string[];
  /** Waar de app opent: de eerste die openstaat voor dit teamlid. */
  home: readonly string[];
  /** De duimbalk op de telefoon (hooguit vijf). De rest staat in het uitschuifmenu. */
  dock: ReadonlyArray<{ page: string; label: string }>;
}

/** Zelfde lijst als financePages in Sidebar.tsx en FINANCE_PAGES in ZenitNav.tsx. */
const FINANCE_PAGES = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'prepaid', 'pnl', 'vat-returns', 'corporate-tax', 'dga', 'shareholders', 'owners', 'fiscal-years', 'annual-accounts'] as const;

export const STANDALONE_APPS: readonly StandaloneApp[] = [
  {
    id: 'agenda',
    path: '/app/agenda/',
    name: 'ResoFly Agenda',
    shortName: 'Agenda',
    description: 'Je agenda en je boekingslinks, zonder de rest van de werkruimte eromheen.',
    manifest: '/apps/agenda.webmanifest',
    icon: '/icons/app-agenda-192.png',
    touchIcon: '/icons/app-agenda-maskable-192.png',
    pages: ['calendar', 'meeting-booking'],
    home: ['calendar', 'meeting-booking'],
    dock: [{ page: 'calendar', label: 'Agenda' }, { page: 'meeting-booking', label: 'Boekingslinks' }],
  },
  {
    id: 'financien',
    path: '/app/financien/',
    name: 'ResoFly Financiën',
    shortName: 'Financiën',
    description: 'Offertes, facturen, inkoop, bank en boekhouding: opent meteen op je facturen.',
    manifest: '/apps/financien.webmanifest',
    icon: '/icons/app-financien-192.png',
    touchIcon: '/icons/app-financien-maskable-192.png',
    pages: FINANCE_PAGES,
    // Facturen eerst: daar begint en eindigt het meeste werk in Financiën.
    home: ['invoices', ...FINANCE_PAGES],
    // Korte namen: vijf knoppen op 390px laten ±75px per label over.
    dock: [
      { page: 'invoices', label: 'Facturen' },
      { page: 'quotes', label: 'Offertes' },
      { page: 'purchase-invoices', label: 'Inkoop' },
      { page: 'bank', label: 'Bank' },
      { page: 'ledger', label: 'Grootboek' },
    ],
  },
  {
    id: 'communicatie',
    path: '/app/communicatie/',
    name: 'ResoFly Communicatie',
    shortName: 'Communicatie',
    description: 'Je berichten, de teamchat en marketing: alle gesprekken op één plek.',
    manifest: '/apps/communicatie.webmanifest',
    icon: '/icons/app-communicatie-192.png',
    touchIcon: '/icons/app-communicatie-maskable-192.png',
    pages: ['communication', 'chat', 'marketing'],
    home: ['communication', 'chat', 'marketing'],
    dock: [{ page: 'communication', label: 'Berichten' }, { page: 'chat', label: 'Chat' }, { page: 'marketing', label: 'Marketing' }],
  },
];

/**
 * Bij welke app hoort dit adres? Zonder slash aan het eind telt ook
 * (/app/agenda), want zo typt een mens het; de app zet hem er daarna zelf bij
 * (zie canonicalAppUrl), anders valt de pagina buiten de scope van zijn manifest.
 */
export function standaloneAppFromPath(pathname: string): StandaloneApp | null {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return STANDALONE_APPS.find(app => path.startsWith(app.path)) ?? null;
}

/**
 * Welke installeerbare app woont op dit adres: een losse app, de werkruimte op
 * /app/werkruimte/, of geen (de werkruimte op "/" in de browser).
 */
export function installableAppFromPath(pathname: string): InstallableApp | null {
  const standalone = standaloneAppFromPath(pathname);
  if (standalone) return standalone;
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return path.startsWith(WORKSPACE_APP.path) ? WORKSPACE_APP : null;
}

/** Het adres met de slash erbij, of null als het al klopt. */
export function canonicalAppUrl(app: InstallableApp, location: { pathname: string; search: string; hash: string }): string | null {
  if (location.pathname.startsWith(app.path)) return null;
  return `${app.path}${location.search}${location.hash}`;
}

export function isPageInApp(app: StandaloneApp, page: string): boolean {
  return app.pages.includes(page);
}

/** De pagina waarop de app opent, of null als alles van deze app dichtstaat. */
export function appHomePage(app: StandaloneApp, canOpenPage: (page: string) => boolean): string | null {
  return app.home.find(page => canOpenPage(page)) ?? null;
}

/**
 * Welke apps dit teamlid kan gebruiken: minstens één pagina staat open. De
 * boekhouder (alleen Financiën, alleen lezen) ziet zo alleen de app Financiën.
 */
export function availableApps(canOpenPage: (page: string) => boolean): StandaloneApp[] {
  return STANDALONE_APPS.filter(app => appHomePage(app, canOpenPage) !== null);
}

/** Instellingen → Apps: de werkruimte voorop, dan de losse apps die openstaan. */
export function installableApps(canOpenPage: (page: string) => boolean): InstallableApp[] {
  return [WORKSPACE_APP, ...availableApps(canOpenPage)];
}

/**
 * Zet in de <head> het manifest, de naam en het icoon van deze app.
 *
 * index.html linkt het manifest van de werkruimte. Chrome en Edge lezen het
 * manifest pas als de pagina geladen is, en volgen een gewijzigde link; Safari
 * leest naam en icoon pas bij "Zet op beginscherm". Dit draait vóór React, dus
 * op tijd voor allebei.
 */
export function applyStandaloneAppHead(app: StandaloneApp, doc: Document = document): void {
  const ensure = (selector: string, create: () => HTMLElement) => doc.head.querySelector<HTMLElement>(selector) ?? doc.head.appendChild(create());
  const link = (rel: string) => () => { const el = doc.createElement('link'); el.rel = rel; return el; };
  const meta = (name: string) => () => { const el = doc.createElement('meta'); el.name = name; return el; };
  ensure('link[rel="manifest"]', link('manifest')).setAttribute('href', app.manifest);
  ensure('link[rel="apple-touch-icon"]', link('apple-touch-icon')).setAttribute('href', app.touchIcon);
  ensure('link[rel="icon"]', link('icon')).setAttribute('href', app.icon);
  ensure('meta[name="apple-mobile-web-app-title"]', meta('apple-mobile-web-app-title')).setAttribute('content', app.shortName);
  ensure('meta[name="application-name"]', meta('application-name')).setAttribute('content', app.name);
  doc.title = app.name;
}

/** Draait de app nu als geïnstalleerde app (eigen venster, geen adresbalk)? */
export function isRunningInstalled(win: Window = window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true
    || ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'].some(mode => win.matchMedia?.(`(display-mode: ${mode})`).matches);
}
