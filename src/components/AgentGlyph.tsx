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
 *   2. een KLEURTINT die hem van zijn buren onderscheidt,
 *   3. een SIGIL: een ringpatroon dat uit het agent-id wordt gerekend, zodat twee
 *      agents met hetzelfde icoon en dezelfde kleur tóch niet identiek zijn.
 *
 * Alle drie zijn AFLEIDBAAR. Een agent hoeft dus niets te kiezen om er goed uit
 * te zien; kiest de gebruiker wél iets (kolommen `icon`/`hue`), dan wint dat.
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

/**
 * Kleurtint 0..359. Eigen keuze wint; anders uit het id — maar niet zomaar
 * `hash % 360`: de gele band (45–70°) botst met het merkgoud en zou elke agent op
 * een gouden knop laten lijken. We kiezen daarom uit een vaste reeks tinten die
 * náást het goud staan in plaats van erop.
 */
const HUE_WHEEL = [4, 20, 96, 140, 168, 190, 208, 226, 258, 284, 312, 338];

export function agentHue(agent: AgentLike): number {
  if (typeof agent.hue === 'number' && agent.hue >= 0 && agent.hue <= 359) return agent.hue;
  return HUE_WHEEL[hash(`${agent.id || ''}|${agent.name || ''}`) % HUE_WHEEL.length];
}

/** De tinten die de kiezer aanbiedt — dezelfde reeks als de automatische afleiding. */
export const AGENT_HUES = HUE_WHEEL;

export type AgentGlyphSize = 'sm' | 'md' | 'lg';
export type AgentGlyphState = 'active' | 'paused' | 'draft' | 'archived' | 'running';

const GLYPH_PX: Record<AgentGlyphSize, number> = { sm: 34, md: 46, lg: 68 };

/**
 * Het embleem zelf. `state` kleurt alleen de ring eromheen; het embleem blijft in
 * alle standen hetzelfde, zodat je een gepauzeerde agent nog steeds herkent.
 */
export function AgentGlyph({ agent, size = 'md', state, title }: {
  agent: AgentLike;
  size?: AgentGlyphSize;
  state?: AgentGlyphState;
  title?: string;
}) {
  const key = agentIconKey(agent);
  const hue = agentHue(agent);
  const def = ICON_BY_KEY.get(key) ?? AGENT_ICONS[AGENT_ICONS.length - 1];
  const px = GLYPH_PX[size];
  const seed = useMemo(() => hash(`${agent.id || ''}|${agent.name || ''}|${key}`), [agent.id, agent.name, key]);

  return (
    <span
      className={`ag-glyph ag-glyph-${size}${state ? ` is-${state}` : ''}`}
      style={{ '--ag-h': hue } as CSSProperties}
      title={title}
      aria-hidden="true"
    >
      <span className="ag-glyph-tile">
        <Sigil seed={seed} />
        <span className="ag-glyph-icon"><def.Icon size={Math.round(px * 0.42)} strokeWidth={1.9} /></span>
      </span>
    </span>
  );
}

/**
 * Het sigil: twee ringen met een uit de seed gerekend streepjespatroon plus drie
 * satellieten. Zit onder het icoon en blijft bewust vaag — het is textuur, geen
 * informatie. Puur decoratief, dus buiten de toegankelijkheidsboom.
 */
function Sigil({ seed }: { seed: number }) {
  const dash = 3 + (seed % 7);
  const gap = 2 + ((seed >> 3) % 6);
  const rot = seed % 360;
  const innerRot = (seed >> 5) % 360;
  const dots = [0, 1, 2].map((i) => {
    const angle = ((seed >> (i * 4)) % 360) * (Math.PI / 180);
    const radius = 27 + ((seed >> (i * 3)) % 12);
    return { x: 50 + Math.cos(angle) * radius, y: 50 + Math.sin(angle) * radius, r: 1.6 + ((seed >> i) % 3) * 0.6 };
  });

  return (
    <svg className="ag-sigil" viewBox="0 0 100 100" focusable="false" aria-hidden="true">
      <circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" strokeWidth="2"
        strokeDasharray={`${dash * 2} ${gap * 2}`} transform={`rotate(${rot} 50 50)`} opacity="0.5" />
      <circle cx="50" cy="50" r="30" fill="none" stroke="currentColor" strokeWidth="1.2"
        strokeDasharray={`${gap * 3} ${dash}`} transform={`rotate(${innerRot} 50 50)`} opacity="0.35" />
      {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="currentColor" opacity="0.45" />)}
    </svg>
  );
}
