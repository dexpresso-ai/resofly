import { useMemo, type CSSProperties } from 'react';
import {
  BarChart3, BellRing, Bot, Brain, CalendarClock, Clock4, Compass, Flame, FolderKanban,
  Gem, HandCoins, Inbox, LifeBuoy, ListChecks, Mail, Megaphone, PiggyBank, Radar, Receipt,
  Rocket, Scale, ShieldCheck, Sparkles, Telescope, TrendingUp, Users, Wallet, Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Het gezicht van een agent.
 *
 * Een aangemaakte agent is voor de gebruiker geen regel in een lijst maar een
 * *personage*: iets met een eigen kop en kleur dat je herkent voordat je de naam
 * leest. Dit bestand maakt dat embleem, en doet dat in drie lagen:
 *
 *   1. een ICOON dat zegt waar hij over gaat (facturen, agenda, klanten …),
 *   2. een STAND: draait hij, dan is de tegel gevuld met het merkgoud; staat hij
 *      stil, dan zakt hij terug naar een tonale tegel met een gouden icoon,
 *   3. LICHTVAL: twee zachte vlekken op een uit het agent-id gerekende plek, zodat
 *      twee agents met hetzelfde icoon het licht net anders vangen.
 *
 * Alle drie zijn AFLEIDBAAR. Een agent hoeft dus niets te kiezen om er goed uit
 * te zien; kiest de gebruiker wél iets (kolom `icon`), dan wint dat.
 * Puur cosmetisch — er hangt geen enkele runner-beslissing aan.
 */

export type AgentIconKey =
  | 'receipt' | 'bell' | 'trending' | 'wallet' | 'coins' | 'piggy' | 'scale'
  | 'calendar' | 'clock' | 'users' | 'folder' | 'checks' | 'lifebuoy' | 'inbox'
  | 'mail' | 'megaphone' | 'chart' | 'shield' | 'radar' | 'telescope' | 'compass'
  | 'rocket' | 'brain' | 'bot' | 'zap' | 'flame' | 'gem' | 'sparkles';

interface AgentIconDef {
  key: AgentIconKey;
  label: string;
  Icon: LucideIcon;
  /** Woorden die dit icoon "winnen" wanneer ze in de opdracht of tools voorkomen. */
  hints: string[];
}

/**
 * LET OP: de sleutels moeten gelijk lopen met `AGENT_ICON_KEYS` in
 * `supabase/functions/gerrie-agent-runner/index.ts`. Een sleutel die daar
 * ontbreekt wordt bij het opslaan stil op null gezet.
 */
export const AGENT_ICONS: AgentIconDef[] = [
  { key: 'receipt', label: 'Facturen', Icon: Receipt, hints: ['factuur', 'facturen', 'list_invoices', 'debiteur', 'openstaand'] },
  { key: 'bell', label: 'Herinneringen', Icon: BellRing, hints: ['herinnering', 'herinneringen', 'aanmaning', 'reminder', 'list_due_reminders', 'propose_send_reminders'] },
  { key: 'trending', label: 'Omzet & groei', Icon: TrendingUp, hints: ['omzet', 'groei', 'resultaat', 'get_financial_summary'] },
  { key: 'wallet', label: 'Geld', Icon: Wallet, hints: ['geld', 'kas', 'cashflow', 'saldo'] },
  { key: 'coins', label: 'Betalingen', Icon: HandCoins, hints: ['betaling', 'betalingen', 'incasso', 'mollie'] },
  { key: 'piggy', label: 'Reserveren', Icon: PiggyBank, hints: ['reserve', 'potje', 'sparen', 'buffer'] },
  { key: 'scale', label: 'Btw & belasting', Icon: Scale, hints: ['btw', 'belasting', 'aangifte', 'fiscaal', 'vpb'] },
  { key: 'calendar', label: 'Agenda', Icon: CalendarClock, hints: ['agenda', 'afspraak', 'afspraken', 'kalender', 'propose_calendar_event'] },
  { key: 'clock', label: 'Uren', Icon: Clock4, hints: ['uren', 'urenregistratie', 'tijd', 'propose_time_entry'] },
  { key: 'users', label: 'Klanten', Icon: Users, hints: ['klant', 'klanten', 'relatie', 'search_clients'] },
  { key: 'folder', label: 'Projecten', Icon: FolderKanban, hints: ['project', 'projecten', 'list_projects'] },
  { key: 'checks', label: 'Taken', Icon: ListChecks, hints: ['taak', 'taken', 'actiepunt', 'list_tasks', 'todo'] },
  { key: 'lifebuoy', label: 'Tickets', Icon: LifeBuoy, hints: ['ticket', 'tickets', 'support', 'list_tickets'] },
  { key: 'inbox', label: 'Postvak', Icon: Inbox, hints: ['inbox', 'postvak', 'binnengekomen'] },
  { key: 'mail', label: 'Mail', Icon: Mail, hints: ['mail', 'e-mail', 'versturen', 'propose_send_invoice', 'propose_send_quote'] },
  { key: 'megaphone', label: 'Marketing', Icon: Megaphone, hints: ['campagne', 'marketing', 'nieuwsbrief', 'mailing'] },
  { key: 'chart', label: 'Rapportage', Icon: BarChart3, hints: ['rapport', 'rapportage', 'overzicht', 'statistiek', 'samenvatting'] },
  { key: 'shield', label: 'Bewaking', Icon: ShieldCheck, hints: ['controle', 'bewaking', 'risico', 'check', 'audit'] },
  { key: 'radar', label: 'Signalen', Icon: Radar, hints: ['signaal', 'signalen', 'afwijking', 'monitor'] },
  { key: 'telescope', label: 'Vooruitblik', Icon: Telescope, hints: ['prognose', 'vooruit', 'verwacht', 'forecast'] },
  { key: 'compass', label: 'Verkenner', Icon: Compass, hints: ['verken', 'onderzoek', 'analyse'] },
  { key: 'rocket', label: 'Aanjager', Icon: Rocket, hints: ['offerte', 'offertes', 'kans', 'sales', 'list_quotes'] },
  { key: 'brain', label: 'Denker', Icon: Brain, hints: ['denk', 'advies', 'strategie'] },
  { key: 'bot', label: 'Robot', Icon: Bot, hints: [] },
  { key: 'zap', label: 'Bliksem', Icon: Zap, hints: ['snel', 'direct'] },
  { key: 'flame', label: 'Urgent', Icon: Flame, hints: ['urgent', 'te laat', 'achterstand', 'spoed'] },
  // Geen losse woordjes als "top" hier: die zitten in "laptop" en "stoppen" en
  // laten dan het verkeerde embleem winnen.
  { key: 'gem', label: 'Waarde', Icon: Gem, hints: ['waarde', 'grootste klant'] },
  { key: 'sparkles', label: 'Magie', Icon: Sparkles, hints: [] },
];

const ICON_BY_KEY = new Map<string, AgentIconDef>(AGENT_ICONS.map((d) => [d.key, d]));

/** Stabiele 32-bits hash (FNV-1a). Zelfde tekst → altijd hetzelfde embleem. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** De agent-eigenschappen die het embleem nodig heeft — zowel een echte routine als een concept. */
export interface AgentLike {
  id?: string;
  name?: string | null;
  instruction?: string | null;
  enabled_tools?: string[] | null;
  icon?: string | null;
  hue?: number | null;
}

/**
 * Welk icoon hoort bij deze agent? Eerst de eigen keuze; anders het icoon met de
 * meeste treffers in naam + opdracht + tools; en als niets aanslaat een vast
 * icoon uit het id (dus stabiel, niet elke render een andere robot).
 */
export function agentIconKey(agent: AgentLike): AgentIconKey {
  if (agent.icon && ICON_BY_KEY.has(agent.icon)) return agent.icon as AgentIconKey;

  const haystack = `${agent.name ?? ''} ${agent.instruction ?? ''} ${(agent.enabled_tools ?? []).join(' ')}`.toLowerCase();
  let best: AgentIconDef | null = null;
  let bestScore = 0;
  for (const def of AGENT_ICONS) {
    let score = 0;
    for (const hint of def.hints) if (haystack.includes(hint)) score += hint.length;
    if (score > bestScore) { best = def; bestScore = score; }
  }
  if (best) return best.key;

  const pool: AgentIconKey[] = ['bot', 'sparkles', 'compass', 'brain', 'radar', 'zap'];
  return pool[hash(agent.id || agent.name || 'gerrie') % pool.length];
}

/*
 * Over KLEUR staat hier geen code meer.
 *
 * Er stond een wiel van twaalf tinten, zodat elke agent zijn eigen kleur kreeg.
 * Dat gaf herkenning per agent, maar het maakte de app bont: twaalf willekeurige
 * kleuren náást een merk dat maar één kleur heeft. De PO koos voor één merkkleur,
 * en die staat nu gewoon in `globals.css` (--accent). De functie die hier de tint
 * teruggaf, gaf dus altijd hetzelfde getal terug en is daarmee weg.
 *
 * Onderscheid tússen agents komt volledig van het ICOON en de lichtval — allebei
 * per agent afgeleid, dus twee agents zien er nog steeds anders uit. De kolom
 * `hue` in de database wordt bewust genegeerd in plaats van gewist: dan blijft
 * hij bruikbaar als je ooit terug wilt.
 */

export type AgentGlyphSize = 'sm' | 'md' | 'lg';
export type AgentGlyphState = 'active' | 'paused' | 'draft' | 'archived' | 'running';

const GLYPH_PX: Record<AgentGlyphSize, number> = { sm: 34, md: 46, lg: 68 };

/**
 * Het embleem zelf.
 *
 * Drie lagen, in deze volgorde: een tegel, twee uit de seed gerekende lichtvlekken
 * erop, en het icoon erbovenop. Meer is het niet — en dat is precies het punt.
 *
 * Wat hier VROEGER stond en bewust weg is: een glans-verloop met een opstaand
 * randje (`inset 0 1px 0 wit`) en een "sigil" van gestreepte ringen met drie
 * satellieten. Samen gaven die het embleem de glimmende-knop-look van een decennium
 * geleden, en de ringen lazen als ruis in plaats van als informatie. De herkenning
 * die de sigil moest leveren zit nu in de lichtvlekken: hun plek komt uit dezelfde
 * seed, dus twee agents met hetzelfde icoon vangen het licht nog steeds anders,
 * zonder dat je een patroon ziet dat iets lijkt te betekenen.
 *
 * `state` bepaalt de STAND van de tegel, niet alleen een ring eromheen:
 * een agent die draait of actief staat krijgt het merkgoud als vulling, een
 * gepauzeerde of gearchiveerde agent zakt terug naar een tonale tegel met een
 * gouden icoon. Dat verving het oude `filter:saturate(.3)`, dat van elk goud een
 * vuilbeige vlek maakte — vier van die vlekken naast elkaar was de kern van de
 * "niet modern"-klacht.
 */
export function AgentGlyph({ agent, size = 'md', state, title }: {
  agent: AgentLike;
  size?: AgentGlyphSize;
  state?: AgentGlyphState;
  title?: string;
}) {
  const key = agentIconKey(agent);
  const def = ICON_BY_KEY.get(key) ?? AGENT_ICONS[AGENT_ICONS.length - 1];
  const px = GLYPH_PX[size];
  const seed = useMemo(() => hash(`${agent.id || ''}|${agent.name || ''}|${key}`), [agent.id, agent.name, key]);

  /**
   * De twee lichtvlekken. De eerste zit in de bovenste helft (daar valt licht
   * vandaan), de tweede in de onderste — zo blijft het een belichte tegel en wordt
   * het nooit een willekeurige vlekkenwolk. De marges houden elke vlek van de rand
   * af, anders valt hij half buiten de tegel en zie je alleen een lichte hoek.
   */
  const face = useMemo<CSSProperties>(() => ({
    '--ag-x1': `${20 + (seed % 60)}%`,
    '--ag-y1': `${6 + ((seed >>> 5) % 34)}%`,
    '--ag-x2': `${18 + ((seed >>> 11) % 64)}%`,
    '--ag-y2': `${64 + ((seed >>> 17) % 32)}%`,
  } as CSSProperties), [seed]);

  return (
    <span
      className={`ag-glyph ag-glyph-${size}${state ? ` is-${state}` : ''}`}
      style={face}
      title={title}
      aria-hidden="true"
    >
      <span className="ag-glyph-tile">
        <span className="ag-glyph-icon"><def.Icon size={Math.round(px * 0.44)} strokeWidth={1.75} /></span>
      </span>
    </span>
  );
}
