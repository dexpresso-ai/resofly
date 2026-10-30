import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarPlus, Check, ChevronRight, Clock, CornerDownLeft, FilePlus2, FileText, ListPlus, Plus, ReceiptText, ShieldCheck, Sunrise, Undo2, X, type LucideIcon } from 'lucide-react';
import type { AppData } from '../types';
import { kindMeta, looksLikeQuestion, searchWorkspace, type SearchResult } from './GlobalSearch';
import { PAGE_ICON } from './TabBar';
import { intentGaps, parseIntent, type Intent } from '../lib/stroom';
import { commitNow, dismiss, undo, useStroomNotes, type StroomNote } from '../lib/stroomBus';
import { useElapsedLabel, useRunningTimer, type RunningTimer } from '../lib/useTimer';

/**
 * Het eiland van Stroom (designvoorstel 2026-10-30): één plek bovenin om te
 * vragen, te zoeken, te springen en te maken. In rust een pil met het orbje
 * van Gerrie; open een palet; bij een melding een regel met tijd om terug te
 * halen; met een lopende timer de klok ernaast.
 *
 * - Zoeken gebruikt dezelfde zoekfunctie als de zoekbalk (searchWorkspace).
 * - Maken: "factuur bloem content oktober 650" opent het factuurformulier
 *   vooringevuld. Er wordt niets opgeslagen of verstuurd: dat doe jij in het
 *   formulier. Een afspraak of uren gaan naar Gerrie, die ze klaarzet.
 * - De werktabs wonen hier ("Open tabbladen"): het eiland opent met je open
 *   tabbladen bovenaan, en Ctrl+Tab wisselt waar de browser hem doorlaat
 *   (in het geïnstalleerde venster; een gewone browser houdt hem zelf).
 *
 * Toetsen: Ctrl/⌘ K of / opent, ↑↓ kiest, Enter doet, Tab vraagt Gerrie,
 * Esc sluit.
 */

export interface IslandTab { id: string; label: string; page: string; active: boolean }

type Row = {
  key: string;
  group: string;
  title: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
  tone?: 'ai' | 'make' | 'tab';
  badge?: string;
  run: () => void;
  /** Tekst die in het veld komt in plaats van iets te doen ("factuur "). */
  fill?: string;
  disabled?: boolean;
};

const MAKE: { word: string; label: string; Icon: LucideIcon; hint: string }[] = [
  { word: 'factuur', label: 'Factuur maken', Icon: ReceiptText, hint: 'factuur bloem content oktober 650' },
  { word: 'offerte', label: 'Offerte maken', Icon: FilePlus2, hint: 'offerte korenaar huisstijl 2400' },
  { word: 'taak', label: 'Taak maken', Icon: ListPlus, hint: 'taak bel van dijk morgen' },
  { word: 'afspraak', label: 'Afspraak plannen', Icon: CalendarPlus, hint: 'afspraak bloem vrijdag 10:00' },
  { word: 'uren', label: 'Uren schrijven', Icon: Clock, hint: 'uren korenaar 2,5u' },
];

const eur = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** Wat het eiland van een opdracht begrijpt, in één regel. */
function intentSummary(intent: Intent): { title: string; parts: string[] } {
  const parts: string[] = [];
  if (intent.clientName) parts.push(intent.clientName);
  if (intent.projectName && intent.kind !== 'factuur' && intent.kind !== 'offerte') parts.push(intent.projectName);
  if (intent.description) parts.push(intent.description);
  if (intent.amount != null) parts.push(`${eur.format(intent.amount)} excl. btw`);
  if (intent.dayWord) parts.push(intent.dayWord);
  if (intent.minute != null) parts.push(clock(intent.minute));
  if (intent.minutes != null) parts.push(`${Math.floor(intent.minutes / 60)}:${String(intent.minutes % 60).padStart(2, '0')} uur`);
  const title = {
    factuur: 'Factuur opstellen', offerte: 'Offerte opstellen', taak: 'Taak aanmaken',
    afspraak: 'Afspraak laten plannen door Gerrie', uren: 'Uren laten schrijven door Gerrie',
  }[intent.kind];
  return { title, parts };
}

/** Vandaag heeft in Stroom het icoon van de rail (de opkomende zon). */
const tabIcon = (page: string): LucideIcon => (page === 'dashboard' ? Sunrise : PAGE_ICON[page] ?? FileText);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function StroomIsland({
  data, canOpenPage, onNavigate, onAsk, onCreate, tabs, onSwitchTab, onCloseTab, onNewTab, timerKeys, onOpenTimer, narrow,
}: {
  data: AppData;
  canOpenPage?: (page: string) => boolean;
  onNavigate: (result: SearchResult) => void;
  /** Zonder: geen Gerrie (de module staat dicht voor dit teamlid). */
  onAsk?: (text: string) => void;
  /** Een opdracht uitvoeren: het formulier openen of Gerrie vragen. */
  onCreate?: (intent: Intent) => void;
  tabs: IslandTab[];
  onSwitchTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  /** Waar een lopende timer kan staan (urenregistratie en weekplanner). */
  timerKeys: string[];
  onOpenTimer?: () => void;
  narrow: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const faceRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { note } = useStroomNotes();

  // De timer: urenregistratie en weekplanner hebben elk hun eigen sleutel.
  const first = useRunningTimer(timerKeys[0] ?? 'resofly-timer');
  const second = useRunningTimer(timerKeys[1] ?? timerKeys[0] ?? 'resofly-timer');
  const running: RunningTimer | null = first.running ?? second.running;
  const elapsed = useElapsedLabel(running?.startedAt ?? null);
  const timerLabel = running
    ? running.description || data.projects.find(p => p.id === running.projectId)?.name || data.clients.find(c => c.id === running.clientId)?.name || 'Timer'
    : '';

  const term = query.trim().toLowerCase();
  const intent = useMemo(() => parseIntent(query, { clients: data.clients, projects: data.projects }), [query, data.clients, data.projects]);
  const results = useMemo(() => (intent ? [] : searchWorkspace(data, term, canOpenPage)), [intent, data, term, canOpenPage]);

  function close(returnFocus = true) {
    setOpen(false);
    setQuery('');
    if (returnFocus) window.requestAnimationFrame(() => faceRef.current?.focus({ preventScroll: true }));
  }
  function openIsland(text = '') {
    setOpen(true);
    setQuery(text);
    setActive(0);
    // Meteen focussen (niet pas na een frame): anders vallen de eerste
    // toetsaanslagen van wie al aan het typen is, weg.
    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
  }

  // ── De rijen ─────────────────────────────────────────────────────────────
  const rows: Row[] = [];
  if (intent) {
    const { title, parts } = intentSummary(intent);
    const gaps = intentGaps(intent);
    const viaGerrie = intent.kind === 'afspraak' || intent.kind === 'uren';
    rows.push({
      key: 'make', group: 'Maken', tone: viaGerrie ? 'ai' : 'make',
      icon: viaGerrie ? <span className="zorb sm" aria-hidden="true" /> : (() => { const Icon = MAKE.find(m => m.word === intent.kind)?.Icon ?? Plus; return <Icon size={16} aria-hidden="true" />; })(),
      title,
      sub: parts.length > 0 ? parts.join(' · ') : 'Typ verder: voor wie, wat en hoeveel',
      badge: gaps.length > 0 ? `nog: ${gaps.join(', ')}` : viaGerrie ? 'Gerrie' : 'formulier',
      disabled: !onCreate || (viaGerrie && !onAsk),
      run: () => { if (onCreate) { onCreate(intent); close(false); } },
    });
    if (onAsk && !viaGerrie) {
      rows.push({ key: 'ask', group: 'Maken', tone: 'ai', icon: <span className="zorb sm" aria-hidden="true" />, title: <>Vraag Gerrie: “{query.trim()}”</>, sub: 'Gerrie zet het klaar met alles erbij; jij beslist', run: () => { onAsk(query.trim()); close(false); } });
    }
  } else if (term.length === 0) {
    tabs.forEach(tab => {
      const Icon = tabIcon(tab.page);
      rows.push({
        key: `tab-${tab.id}`, group: 'Open tabbladen', tone: 'tab', icon: <Icon size={16} aria-hidden="true" />,
        title: tab.label, sub: tab.active ? 'hier ben je nu' : undefined, badge: tab.active ? 'nu' : undefined,
        run: () => { onSwitchTab(tab.id); close(false); },
      });
    });
    rows.push({ key: 'newtab', group: 'Open tabbladen', icon: <Plus size={16} aria-hidden="true" />, title: 'Nieuw tabblad', run: () => { onNewTab(); close(false); } });
    if (onCreate) {
      MAKE.forEach(make => {
        if ((make.word === 'afspraak' || make.word === 'uren') && !onAsk) return;
        rows.push({ key: `make-${make.word}`, group: 'Maken', icon: <make.Icon size={16} aria-hidden="true" />, title: make.label, sub: <>bijv. <i>{make.hint}</i></>, fill: `${make.word} `, run: () => undefined });
      });
    }
  } else {
    const askFirst = Boolean(onAsk) && term.length >= 2 && (results.length === 0 || looksLikeQuestion(query.trim()));
    const askRow: Row | null = onAsk && term.length >= 2
      ? { key: 'ask', group: 'Gerrie', tone: 'ai', icon: <span className="zorb sm" aria-hidden="true" />, title: <>Vraag Gerrie: “{query.trim()}”</>, sub: 'Gerrie zoekt het uit of zet het klaar; jij beslist', badge: 'Tab', run: () => { onAsk(query.trim()); close(false); } }
      : null;
    if (askRow && askFirst) rows.push(askRow);
    tabs.filter(tab => tab.label.toLowerCase().includes(term)).forEach(tab => {
      const Icon = tabIcon(tab.page);
      rows.push({ key: `tab-${tab.id}`, group: 'Open tabbladen', tone: 'tab', icon: <Icon size={16} aria-hidden="true" />, title: tab.label, badge: tab.active ? 'nu' : 'tabblad', run: () => { onSwitchTab(tab.id); close(false); } });
    });
    results.slice(0, 9).forEach(result => {
      const meta = kindMeta[result.kind];
      rows.push({ key: `${result.kind}-${result.id}`, group: meta.label, icon: <meta.icon size={16} aria-hidden="true" />, title: result.title, sub: result.subtitle, badge: meta.badge, run: () => { onNavigate(result); close(false); } });
    });
    if (results.length > 9) rows.push({ key: 'more', group: 'Meer', icon: <ChevronRight size={16} aria-hidden="true" />, title: `Nog ${results.length - 9} resultaten`, sub: 'Typ verder om te verfijnen', run: () => inputRef.current?.focus(), disabled: true });
    if (askRow && !askFirst) rows.push(askRow);
    if (term.length < 2 && rows.length === 0) rows.push({ key: 'short', group: 'Zoeken', icon: <ChevronRight size={16} aria-hidden="true" />, title: 'Blijf typen…', sub: 'Vanaf twee tekens zoekt het eiland in je werkruimte', run: () => undefined, disabled: true });
    if (term.length >= 2 && results.length === 0 && !onAsk) rows.push({ key: 'none', group: 'Zoeken', icon: <ChevronRight size={16} aria-hidden="true" />, title: 'Niets gevonden', sub: `Niets voor “${query.trim()}” in je werkruimte`, run: () => undefined, disabled: true });
  }
  const selectable = rows.map((row, index) => (row.disabled ? -1 : index)).filter(index => index >= 0);
  const activeIndex = selectable.includes(active) ? active : selectable[0] ?? -1;

  useEffect(() => { setActive(0); }, [term, Boolean(intent)]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function runRow(row: Row | undefined) {
    if (!row || row.disabled) return;
    if (row.fill) { setQuery(row.fill); inputRef.current?.focus(); return; }
    row.run();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (selectable.length === 0) return;
      const at = selectable.indexOf(activeIndex);
      const next = event.key === 'ArrowDown' ? selectable[(at + 1) % selectable.length] : selectable[(at - 1 + selectable.length) % selectable.length];
      setActive(next);
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); runRow(rows[activeIndex]); return; }
    if (event.key === 'Tab' && !event.shiftKey && onAsk && query.trim().length >= 2) {
      event.preventDefault();
      onAsk(query.trim());
      close(false);
    }
  }

  // ── Toetsen door de hele app ─────────────────────────────────────────────
  const stateRef = useRef({ open, tabs, onSwitchTab });
  stateRef.current = { open, tabs, onSwitchTab };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (stateRef.current.open) close(); else openIsland();
        return;
      }
      // Ctrl+Tab: het volgende werktabblad (met Shift het vorige), waar de browser hem doorlaat.
      if (event.ctrlKey && event.key === 'Tab') {
        const list = stateRef.current.tabs;
        if (list.length < 2) return;
        event.preventDefault();
        const at = Math.max(0, list.findIndex(tab => tab.active));
        const next = list[(at + (event.shiftKey ? -1 : 1) + list.length) % list.length];
        stateRef.current.onSwitchTab(next.id);
        return;
      }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !stateRef.current.open && !isEditable(event.target) && !document.querySelector('.modal-bg')) {
        event.preventDefault();
        openIsland();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const state = open ? 'open' : note ? 'note' : running ? 'live' : 'idle';
  const groups: { name: string; rows: { row: Row; index: number }[] }[] = [];
  rows.forEach((row, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === row.group) last.rows.push({ row, index });
    else groups.push({ name: row.group, rows: [{ row, index }] });
  });
  const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

  const palette = open && <>
    <div className="sl-scrim" onClick={() => close()} aria-hidden="true" />
    <div className="sl-pal" role="dialog" aria-label="Vraag, zoek of maak">
      <div className="sl-pal-in">
        <span className="zorb sm" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-activedescendant={activeIndex >= 0 ? `${uid}-r${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-label={onAsk ? 'Vraag Gerrie, zoek of maak iets' : 'Zoek of maak iets'}
          placeholder={onAsk ? 'Vraag Gerrie, zoek of maak iets…' : 'Zoek of maak iets…'}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="sl-pal-esc" onClick={() => close()} aria-label="Sluiten">{narrow ? <X size={18} aria-hidden="true" /> : <kbd>esc</kbd>}</button>
      </div>
      {intent && <div className="sl-chips" aria-live="polite">
        <span className="sl-chip is-kind">{intent.kind}</span>
        <span className={`sl-chip${intent.clientName ? ' is-on' : ''}`}>{intent.clientName ?? 'klant?'}</span>
        {(intent.kind === 'factuur' || intent.kind === 'offerte') && <span className={`sl-chip${intent.amount != null ? ' is-on' : ''}`}>{intent.amount != null ? eur.format(intent.amount) : 'bedrag?'}</span>}
        {(intent.kind === 'taak' || intent.kind === 'afspraak') && <span className={`sl-chip${intent.dayWord ? ' is-on' : ''}`}>{intent.dayWord ?? 'wanneer?'}</span>}
        {intent.minute != null && <span className="sl-chip is-on">{clock(intent.minute)}</span>}
        {intent.kind === 'uren' && <span className={`sl-chip${intent.minutes != null ? ' is-on' : ''}`}>{intent.minutes != null ? `${(intent.minutes / 60).toLocaleString('nl-NL')} uur` : 'hoe lang?'}</span>}
      </div>}
      <div className="sl-list" id={`${uid}-list`} role="listbox" aria-label="Resultaten" ref={listRef}>
        {groups.map(group => <div className="sl-g" key={group.name} role="presentation">
          <div className="sl-g-h" role="presentation">{group.name}</div>
          {group.rows.map(({ row, index }) => <div
            key={row.key}
            id={`${uid}-r${index}`}
            role="option"
            aria-selected={index === activeIndex}
            aria-disabled={row.disabled || undefined}
            className={`sl-o${row.tone ? ` is-${row.tone}` : ''}${row.disabled ? ' is-dis' : ''}`}
            onMouseEnter={() => { if (!row.disabled) setActive(index); }}
            onMouseDown={event => event.preventDefault()}
            onClick={() => runRow(row)}
          >
            <span className="sl-oi">{row.icon}</span>
            <span className="sl-ot"><b>{row.title}</b>{row.sub && <span>{row.sub}</span>}</span>
            {row.badge && <span className="sl-ob">{row.badge}</span>}
            {row.key.startsWith('tab-') && tabs.length > 1 && <button
              type="button"
              className="sl-ox"
              aria-label={`Tabblad "${String(row.title)}" sluiten`}
              onMouseDown={event => event.preventDefault()}
              onClick={event => { event.stopPropagation(); onCloseTab(row.key.slice(4)); }}
            ><X size={13} aria-hidden="true" /></button>}
          </div>)}
        </div>)}
      </div>
      <div className="sl-pal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> kiezen</span>
        <span><kbd><CornerDownLeft size={11} aria-hidden="true" /></kbd> doen</span>
        {onAsk && <span><kbd>Tab</kbd> vraag Gerrie</span>}
        <span className="sl-safe"><ShieldCheck size={12} aria-hidden="true" />Er gaat niets de deur uit zonder jouw akkoord</span>
      </div>
      {note && <NoteRow note={note} compact />}
    </div>
  </>;

  return <div className={`sl-isl${narrow ? ' is-narrow' : ''}`} data-state={state}>
    <div className="sl-isl-shell">
      {state === 'note' && note
        ? <NoteRow note={note} />
        : <div className="sl-isl-idle">
            <button
              ref={faceRef}
              type="button"
              className="sl-face"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={`${onAsk ? 'Vraag Gerrie, zoek of maak iets' : 'Zoek of maak iets'} (${shortcut})`}
              onClick={() => (open ? close() : openIsland())}
            >
              <span className="zorb sm" aria-hidden="true" />
              <span className="sl-ph">{narrow ? (onAsk ? 'Vraag of zoek…' : 'Zoek…') : onAsk ? 'Vraag Gerrie, zoek of maak iets…' : 'Zoek of maak iets…'}</span>
              {!narrow && <kbd className="sl-k">{shortcut}</kbd>}
            </button>
            {running && <button type="button" className="sl-live" onClick={onOpenTimer} aria-label={`Timer: ${timerLabel}, ${elapsed}. Open de urenregistratie`}>
              <span className="sl-live-dot" aria-hidden="true" />
              <b>{elapsed.replace(/^00:/, '')}</b>
              {!narrow && <span className="sl-live-l">{timerLabel}</span>}
            </button>}
          </div>}
    </div>
    {palette && (narrow ? createPortal(palette, document.body) : palette)}
  </div>;
}

/** Een melding in het eiland. Met een klok: Terughalen en Nu. */
function NoteRow({ note, compact = false }: { note: StroomNote; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!note.until) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [note.until]);
  const left = note.until ? Math.max(0, Math.ceil((note.until - now) / 1000)) : null;
  const total = note.seconds ?? 10;
  const detail = note.until && left != null ? (note.detail ?? '').replace('{s}', String(left)) : note.detail;
  return <div className={`sl-note${compact ? ' is-compact' : ''}`} role="status" aria-live="polite">
    <span className={`sl-ni ${note.tone}`} aria-hidden="true">
      {note.tone === 'ai' ? <span className="zorb sm" /> : note.until ? <Undo2 size={15} /> : <Check size={16} />}
      {note.until && <svg className="sl-cd" viewBox="0 0 42 42" style={{ ['--secs' as string]: `${total}s` }}><circle cx="21" cy="21" r="19" pathLength={100} /><circle className="pr" cx="21" cy="21" r="19" pathLength={100} /></svg>}
    </span>
    <span className="sl-nt"><b>{note.title}</b>{detail && <span>{detail}</span>}</span>
    {note.until
      ? <span className="sl-na">
          <button type="button" className="sl-btn is-gold" onClick={() => undo(note.id)}><Undo2 size={14} aria-hidden="true" />Terughalen</button>
          <button type="button" className="sl-btn" onClick={() => commitNow(note.id)}>Nu</button>
        </span>
      : <button type="button" className="sl-nx" onClick={() => dismiss(note.id)} aria-label="Melding sluiten"><X size={14} aria-hidden="true" /></button>}
  </div>;
}
