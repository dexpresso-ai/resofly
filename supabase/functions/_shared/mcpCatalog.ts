// ============================================================
// De catalogus van de MCP-connector: bronnen en standaardvragen.
//
// Tools zijn wat een MODEL kiest. Deze twee zijn wat een MENS kiest, in zijn
// eigen AI-app:
//
//   BRONNEN (resources) — dingen die je aanhecht voordat je iets vraagt. "Neem
//     mijn postvak erbij." De gebruiker plakt geen id's over; hij pakt iets uit
//     een lijst en het staat in het gesprek.
//
//   STANDAARDVRAGEN (prompts) — een menu van wat deze koppeling goed kan.
//     Zonder zo'n menu moet iedere klant zelf bedenken wat hij kan vragen, en
//     dan blijft het bij "hoeveel facturen staan er open?". Mét dat menu ziet
//     hij meteen dat er een weekoverzicht in zit, en een doorlichting per klant.
//
// DIT BESTAND IS BEWUST PUUR: alleen data, geen database, geen Deno-imports.
// Daardoor kan mcpCatalog.test.ts nakijken dat elke bron en elke vraag naar een
// handeling verwijst die ECHT bestaat, met een module die bestaat, en dat een
// URI-sjabloon precies het veld invult dat die handeling verplicht stelt. Een
// hernoemde handeling breekt anders stilletjes een bron die niemand test —
// merkbaar pas als een klant hem aanklikt en er een foutmelding uitrolt.
//
// De org-grens verandert hier niets aan: een bron voert gewoon een LEES-handeling
// uit de registry uit, met organization_id uit de koppeling. Wat een teamlid
// niet mag zien, staat niet in zijn lijst en is ook niet op te halen.
// ============================================================

/** Dezelfde modulesleutels als de rest van de app. */
export type ModuleKey =
  | 'clients' | 'projects' | 'time' | 'calendar' | 'tickets'
  | 'content' | 'stats' | 'marketing' | 'finance' | 'chat' | 'gerrie';

// ── Bronnen ──────────────────────────────────────────────────────────────────

export interface McpResource {
  /** Vast adres, of een sjabloon met precies één veld: resofly://project/{project_id}. */
  uri: string;
  name: string;
  title: string;
  description: string;
  /** Welke module dit raakt; wie die niet mag lezen, ziet de bron niet. */
  module: ModuleKey | null;
  /**
   * De lees-handeling eronder. `null` = deze bron wordt door de server zelf
   * samengesteld (de werkruimte-samenvatting), zonder registry-handeling.
   */
  actionId: string | null;
  /** Vaste invoer voor die handeling. Sjabloonvelden komen daar bovenop. */
  input?: Record<string, unknown>;
}

/**
 * Wat een gebruiker zonder iets in te vullen kan aanhechten.
 *
 * Bewust kort gehouden. Een lijst van dertig bronnen is voor een mens net zo
 * onbruikbaar als tweehonderd tools voor een model: hij scrolt, ziet niet wat
 * het verschil is, en pakt de bovenste. Dit zijn de zes waar je 's ochtends
 * daadwerkelijk naar grijpt.
 */
export const MCP_RESOURCES: McpResource[] = [
  {
    uri: 'resofly://werkruimte',
    name: 'werkruimte',
    title: 'Deze werkruimte',
    description: 'Om welke organisatie het gaat, welke rol je hebt, welke onderdelen je mag inzien en welke datum het vandaag is.',
    module: null,
    actionId: null,
  },
  {
    uri: 'resofly://postvak',
    name: 'postvak',
    title: 'Postvak — mail die nergens bij hoort',
    description: 'Binnengekomen berichten van mensen die nog niet aan een klant gekoppeld zijn.',
    module: 'clients',
    actionId: 'inbox.list',
    input: { category: 'human', limit: 25 },
  },
  {
    uri: 'resofly://klantmail',
    name: 'klantmail',
    title: 'Recente klantmail',
    description: 'Wat klanten de afgelopen week mailden, over alle klanten heen, met of iemand het al las.',
    module: 'clients',
    actionId: 'client_email.recent_inbound',
    input: { limit: 20 },
  },
  {
    uri: 'resofly://deze-week',
    name: 'deze-week',
    title: 'Deze week — wat er op de planning staat',
    description: 'De actiepunten en taken van de lopende week uit de weekplanner.',
    module: 'projects',
    actionId: 'week_action.list',
    input: { include_done: true },
  },
  {
    uri: 'resofly://openstaande-posten',
    name: 'openstaande-posten',
    title: 'Openstaande posten',
    description: 'Wie er nog moet betalen en wat er aan leveranciers openstaat, op de datum van vandaag.',
    module: 'finance',
    actionId: 'ledger.open_items',
    input: { side: 'both' },
  },
  {
    uri: 'resofly://recente-notulen',
    name: 'recente-notulen',
    title: 'Recente notulen',
    description: 'Afgeronde gesprekken van de afgelopen twee weken met besproken punten, besluiten en actiepunten.',
    module: 'calendar',
    actionId: 'meeting_recording.recent',
    input: { limit: 10 },
  },
];

/**
 * Bronnen met een veld erin. De AI-client vult het in en haalt hem op.
 *
 * Eén veld per sjabloon, en dat veld heet precies zoals de handeling het
 * verwacht — zo hoeft er nergens een vertaaltabel te bestaan die kan gaan
 * afwijken. De test bewaakt dat.
 */
export const MCP_RESOURCE_TEMPLATES: McpResource[] = [
  {
    uri: 'resofly://project/{project_id}',
    name: 'project',
    title: 'Projectoverzicht',
    description: 'Alles van één project op een rij: fases, taken, uren, budget en team. Zoek het project-id eerst op met find_actions.',
    module: 'projects',
    actionId: 'project.dashboard',
  },
  {
    uri: 'resofly://factuur/{invoice_id}',
    name: 'factuur',
    title: 'Factuurgeschiedenis',
    description: 'De volledige gang van één factuur: versies, verzendingen, betalingen en herinneringen.',
    module: 'finance',
    actionId: 'invoice.history',
  },
];

/** Haalt het ene veld uit een sjabloon: 'resofly://project/{project_id}' → 'project_id'. */
export function templateField(uri: string): string | null {
  const match = /\{([a-z_][a-z0-9_]*)\}/.exec(uri);
  return match ? match[1] : null;
}

/**
 * Past een aangeboden adres op een sjabloon en geeft de ingevulde waarde terug.
 *
 * Geen losse regex per sjabloon maar één vergelijking op basis van het sjabloon
 * zelf, met de rest van het adres letterlijk vergeleken. Zo kan een adres nooit
 * op een sjabloon passen waar het niet bij hoort.
 */
export function matchTemplate(template: string, uri: string): string | null {
  const field = templateField(template);
  if (!field) return null;
  const [prefix, suffix] = template.split(`{${field}}`);
  if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) return null;
  const value = uri.slice(prefix.length, uri.length - (suffix.length || 0));
  // Eén segment, geen schuine strepen: anders past resofly://project/a/b ook.
  if (!value || value.includes('/')) return null;
  return decodeURIComponent(value);
}

// ── Standaardvragen ──────────────────────────────────────────────────────────

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  /** Wie deze modules niet mag lezen, krijgt de vraag niet aangeboden. */
  modules: ModuleKey[];
  arguments: McpPromptArgument[];
  /** Bouwt de opdracht. `args` bevat wat de gebruiker invulde. */
  build: (args: Record<string, string>) => string;
}

/**
 * De opdrachten zijn geschreven voor een model dat ONZE app niet kent. Ze zeggen
 * daarom steeds hetzelfde drietal: zoek eerst op wat er is, gebruik de exacte
 * id's, en verzin niets. Dat is geen wantrouwen maar ervaring: een model dat
 * zelf een factuurnummer invult, doet dat overtuigend.
 */
const WERKWIJZE =
  'Zoek eerst met find_actions op de woorden hieronder en gebruik daarna run_action met de exacte id\'s die je terugkrijgt. ' +
  'Vind je iets niet, zeg dat dan — verzin geen bedragen, namen of id\'s.';

export const MCP_PROMPTS: McpPrompt[] = [
  {
    name: 'weekoverzicht',
    title: 'Weekoverzicht',
    description: 'Wat er deze week speelt en waar aandacht naartoe moet.',
    modules: ['projects'],
    arguments: [],
    build: () => [
      'Geef me een overzicht van deze week in mijn ResoFly-werkruimte.',
      '',
      WERKWIJZE,
      '',
      'Loop langs: de planning van deze week, klantmail die nog geen antwoord kreeg, en facturen die over de vervaldatum zijn.',
      'Sluit af met hoogstens drie dingen die vandaag mijn aandacht nodig hebben, met per punt één zin waarom.',
      'Houd het kort en zakelijk; geen opsomming van alles wat er is.',
    ].join('\n'),
  },
  {
    name: 'klant-doorlichten',
    title: 'Klant doorlichten',
    description: 'Alles wat er over één klant bekend is: dossier, mail, projecten en facturen.',
    modules: ['clients'],
    arguments: [
      { name: 'klant', description: 'Naam van de klant, of een deel daarvan.', required: true },
    ],
    build: (args) => [
      `Licht de klant "${args.klant ?? ''}" voor me door.`,
      '',
      WERKWIJZE,
      'Zoek de klant eerst op; vind je er meerdere die passen, vraag dan welke ik bedoel in plaats van er een te kiezen.',
      '',
      'Behandel: wie het is en hoe we ervoor staan, wat er recent gemaild is en of daar nog iets op wacht,',
      'welke projecten er lopen, en hoe het financieel staat (openstaande facturen, offertes).',
      'Eindig met wat er volgens jou nog blijft liggen.',
    ].join('\n'),
  },
  {
    name: 'facturen-nalopen',
    title: 'Openstaande facturen nalopen',
    description: 'Wie moet er nog betalen, hoe lang al, en wat is de volgende stap.',
    modules: ['finance'],
    arguments: [],
    build: () => [
      'Loop mijn openstaande facturen na.',
      '',
      WERKWIJZE,
      '',
      'Zet ze op volgorde van hoe lang ze al over de vervaldatum zijn. Vermeld per regel de klant, het bedrag,',
      'hoeveel dagen te laat, en of er al een herinnering uit is.',
      'Noem daarna welke er wat jou betreft een herinnering verdienen en waarom — maar zet nog niets klaar tenzij ik erom vraag.',
    ].join('\n'),
  },
  {
    name: 'notulen-opvolgen',
    title: 'Notulen opvolgen',
    description: 'Actiepunten uit recente gesprekken, en wat daarvan nog niet is opgepakt.',
    modules: ['calendar', 'projects'],
    arguments: [],
    build: () => [
      'Wat is er de afgelopen twee weken besproken, en wat daarvan ligt er nog?',
      '',
      WERKWIJZE,
      '',
      'Neem de recente notulen erbij en haal daar de actiepunten uit. Kijk vervolgens welke daarvan al als taak klaarstaan',
      'en welke nergens terug te vinden zijn.',
      'Geef die laatste groep apart — dat is wat er dreigt te verdwijnen.',
    ].join('\n'),
  },
  {
    name: 'dag-voorbereiden',
    title: 'Mijn dag voorbereiden',
    description: 'Wat er vandaag op de agenda staat en wat je daarvoor moet weten.',
    modules: ['calendar', 'clients'],
    arguments: [],
    build: () => [
      'Help me mijn dag voorbereiden.',
      '',
      WERKWIJZE,
      '',
      'Kijk wat er vandaag en morgen op de planning staat. Bij afspraken met een klant: haal erbij wat er met die klant',
      'speelt — recente mail, lopende projecten, openstaande facturen — zodat ik weet waar ik in stap.',
      'Noem tot slot wat er vandaag nog af moet.',
    ].join('\n'),
  },
];

export function findPrompt(name: string): McpPrompt | undefined {
  return MCP_PROMPTS.find((p) => p.name === name);
}
