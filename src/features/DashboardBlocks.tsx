import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical, LayoutDashboard, RotateCcw } from 'lucide-react';
import { Button } from '../components/Ui';
import { useBackStep } from '../lib/useBackStep';
import {
  dashRows,
  isDefaultDashLayout,
  moveDashBlock,
  parseDashLayout,
  serializeDashLayout,
  stepDashBlock,
  toggleDashBlock,
  type DashBlockId,
  type DashLayout,
} from '../lib/dashboardLayout';

/**
 * De blokken van het dashboard, in- en uitklapbaar en in je eigen volgorde
 * (2026-11-24). Het rekenwerk staat in `lib/dashboardLayout.ts`; hier staan
 * het blok, de rijen en het indelen.
 *
 * Inklappen gebeurt met het pijltje rechtsboven in de kop van elk blok. Het
 * pijltje staat óver de kop en niet erboven: op de telefoon stond de eerste
 * taak al op 273 van de 280 pixels die de lay-outtest toestaat, dus een regel
 * extra per blok paste niet. Ingeklapt is een blok één balk met zijn naam en
 * een korte samenvatting ("7 acties").
 *
 * Verplaatsen gebeurt in "Blokken indelen": dan is elk blok een balk die je
 * aan het handvat versleept of met de pijltjes verplaatst. Slepen met een blok
 * van duizend pixels hoog, zoals de projectplanning, ging nergens heen.
 */

export type DashBlockContext = {
  /** Opent "Blokken indelen", voor een knop in een blok zelf (de cockpit). */
  arrange: () => void;
};

export type DashBlockView = {
  id: DashBlockId;
  title: string;
  icon: ReactNode;
  /** Eén regel voor als het blok dicht is, of in het indelen: "7 acties". */
  summary?: string | null;
  /**
   * Verdwijnt het blok vanzelf als er niets is (de beslislijst, je akkoord)?
   * Dan blijft het ook ingeklapt geladen: alleen zo weten we of er iets is,
   * en een balk "Te beslissen" boven een lege lijst zou je voor niets laten
   * klikken.
   */
  selfHiding?: boolean;
  render: (context: DashBlockContext) => ReactNode;
};

/** De indeling uit de browser; per organisatie en per persoon. */
function useDashLayout(storageKey: string): [DashLayout, (next: DashLayout) => void] {
  const read = (key: string) => {
    try { return parseDashLayout(window.localStorage.getItem(key)); } catch { return parseDashLayout(null); }
  };
  const [state, setState] = useState(() => ({ key: storageKey, layout: read(storageKey) }));
  // Een andere organisatie heeft een eigen indeling.
  const layout = state.key === storageKey ? state.layout : read(storageKey);
  if (state.key !== storageKey) setState({ key: storageKey, layout });
  const update = useCallback((next: DashLayout) => {
    setState({ key: storageKey, layout: next });
    try {
      if (isDefaultDashLayout(next)) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, serializeDashLayout(next));
    } catch { /* privémodus: dan geldt de indeling tot je de pagina verlaat */ }
  }, [storageKey]);
  return [layout, update];
}

export function DashBlocks({ blocks, storageKey }: {
  /** De blokken die deze persoon mag en kan zien, met hun inhoud. */
  blocks: DashBlockView[];
  storageKey: string;
}) {
  const [layout, setLayout] = useDashLayout(storageKey);
  const [arranging, setArranging] = useState(false);
  const footRef = useRef<HTMLButtonElement | null>(null);
  const wasArranging = useRef(false);
  const byId = new Map(blocks.map(block => [block.id, block]));
  const visible = new Set(blocks.map(block => block.id));
  const ids = layout.order.filter(id => visible.has(id));
  const context: DashBlockContext = { arrange: () => setArranging(true) };

  // De terugknop van de telefoon sluit het indelen, net als Klaar.
  useBackStep(arranging, () => setArranging(false));

  // Terug uit het indelen: de focus naar de knop waarmee je het opent, zodat
  // een toetsenbordgebruiker niet bovenaan de pagina opnieuw moet beginnen.
  useEffect(() => {
    if (wasArranging.current && !arranging) footRef.current?.focus({ preventScroll: true });
    wasArranging.current = arranging;
  }, [arranging]);

  if (arranging) {
    return <div className="dash-stack dash-blocks">
      <DashArrange
        blocks={ids.map(id => byId.get(id)!)}
        collapsed={new Set(layout.collapsed)}
        canReset={!isDefaultDashLayout(layout)}
        onMove={(id, to) => setLayout({ ...layout, order: moveDashBlock(layout.order, id, to, visible) })}
        onStep={(id, delta) => setLayout({ ...layout, order: stepDashBlock(layout.order, id, delta, visible) })}
        onToggle={id => setLayout(toggleDashBlock(layout, id))}
        onReset={() => setLayout(parseDashLayout(null))}
        onDone={() => setArranging(false)}
      />
    </div>;
  }

  const block = (id: DashBlockId) => <DashBlock
    key={id}
    view={byId.get(id)!}
    collapsed={layout.collapsed.includes(id)}
    onToggle={() => setLayout(toggleDashBlock(layout, id))}
    context={context}
  />;

  return <div className="dash-stack dash-blocks">
    {dashRows(ids).map(row => row.kind === 'single'
      ? block(row.id)
      : <section key={`rij-${row.main}`} className={`dashboard-layout dash-row${row.sideFirst ? ' is-side-first' : ''}`}>
          {row.sideFirst && <aside className="dash-side">{row.side.map(block)}</aside>}
          <div className="dash-main">{block(row.main)}</div>
          {!row.sideFirst && <aside className="dash-side">{row.side.map(block)}</aside>}
        </section>)}
    <div className="dash-arrange-foot">
      <button type="button" ref={footRef} className="dash-arrange-open" onClick={() => setArranging(true)}>
        <LayoutDashboard size={14} aria-hidden="true" /> Blokken indelen
      </button>
    </div>
  </div>;
}

function DashBlock({ view, collapsed, onToggle, context }: {
  view: DashBlockView;
  collapsed: boolean;
  onToggle: () => void;
  context: DashBlockContext;
}) {
  const bodyId = `dash-block-${view.id}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toggled = useRef(false);

  // De knop waarop je klikte verdwijnt (het pijltje wordt een balk en
  // andersom). Zonder dit viel de focus terug naar het begin van de pagina.
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    rootRef.current?.querySelector<HTMLButtonElement>(collapsed ? '.dash-block-bar' : '.dash-block-fold')?.focus({ preventScroll: true });
  }, [collapsed]);

  const toggle = () => { toggled.current = true; onToggle(); };

  if (collapsed) {
    return <div ref={rootRef} className="dash-block is-collapsed" data-block={view.id}>
      {/* Het lijf staat vóór de balk: `:has(> .dash-block-body:empty)` verbergt
          zo het hele blok als een beslislijst niets te tonen heeft. */}
      {view.selfHiding && <div className="dash-block-body" id={bodyId} hidden>{view.render(context)}</div>}
      <button
        type="button"
        className="dash-block-bar"
        aria-expanded={false}
        aria-controls={view.selfHiding ? bodyId : undefined}
        onClick={toggle}
        title={`${view.title} uitklappen`}
      >
        <span className="dash-block-icon" aria-hidden="true">{view.icon}</span>
        <span className="dash-block-title">{view.title}</span>
        {view.summary && <span className="dash-block-summary">{view.summary}</span>}
        <ChevronDown size={16} className="dash-block-caret" aria-hidden="true" />
      </button>
    </div>;
  }

  return <div ref={rootRef} className="dash-block" data-block={view.id}>
    <div className="dash-block-body" id={bodyId}>{view.render(context)}</div>
    <button
      type="button"
      className="dash-block-fold"
      aria-expanded
      aria-controls={bodyId}
      aria-label={`${view.title} inklappen`}
      title="Inklappen"
      onClick={toggle}
    ><ChevronUp size={15} aria-hidden="true" /></button>
  </div>;
}

type DragState = {
  id: DashBlockId;
  /** De plek waar hij nu zou landen, tussen de andere blokken. */
  over: number;
  /** Midden van elk ander blok, gemeten vanaf de bovenkant van de lijst. */
  mids: number[];
};

/** Waar de focus heen moet na een verplaatsing: hetzelfde knopje van hetzelfde blok. */
type FocusTarget = { id: DashBlockId; control: 'grip' | 'up' | 'down' };

function DashArrange({ blocks, collapsed, canReset, onMove, onStep, onToggle, onReset, onDone }: {
  blocks: DashBlockView[];
  collapsed: ReadonlySet<DashBlockId>;
  canReset: boolean;
  onMove: (id: DashBlockId, toIndex: number) => void;
  onStep: (id: DashBlockId, delta: number) => void;
  onToggle: (id: DashBlockId) => void;
  onReset: () => void;
  onDone: () => void;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const headRef = useRef<HTMLHeadingElement | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [announce, setAnnounce] = useState('');
  const ids = blocks.map(block => block.id);
  const byId = new Map(blocks.map(block => [block.id, block]));

  // Bij openen de focus op de kop: wie met het toetsenbord kwam, hoort waar hij
  // is. Zonder preventScroll: wie onderaan op "Blokken indelen" drukte, stond
  // anders onder een lege pagina terwijl de lijst bovenaan stond.
  useEffect(() => { headRef.current?.focus(); }, []);

  const orderKey = ids.join(',');
  useEffect(() => {
    if (!focusTarget) return;
    const wanted = controls.current.get(`${focusTarget.id}:${focusTarget.control}`);
    // Bovenaan is "omhoog" uitgeschakeld; dan het handvat.
    (wanted && !wanted.disabled ? wanted : controls.current.get(`${focusTarget.id}:grip`))?.focus({ preventScroll: true });
  }, [focusTarget, orderKey]);

  const say = (id: DashBlockId, index: number) => {
    setAnnounce(`${byId.get(id)?.title ?? 'Blok'} staat nu op plek ${index + 1} van ${ids.length}.`);
  };
  const step = (id: DashBlockId, delta: number, control: FocusTarget['control']) => {
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (to === from) return;
    onStep(id, delta);
    setFocusTarget({ id, control });
    say(id, to);
  };

  const relativeY = (clientY: number) => clientY - (listRef.current?.getBoundingClientRect().top ?? 0);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: DashBlockId) => {
    if (event.button !== 0 || !listRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const top = listRef.current.getBoundingClientRect().top;
    const mids = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-bar]'))
      .filter(element => element.dataset.bar !== id)
      .map(element => { const rect = element.getBoundingClientRect(); return rect.top - top + rect.height / 2; });
    setDrag({ id, over: ids.indexOf(id), mids });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const y = relativeY(event.clientY);
    const over = drag.mids.filter(mid => mid < y).length;
    if (over !== drag.over) setDrag({ ...drag, over });
  };
  const endDrag = () => {
    if (!drag) return;
    const { id, over } = drag;
    setDrag(null);
    if (over !== ids.indexOf(id)) {
      onMove(id, over);
      say(id, over);
    }
    setFocusTarget({ id, control: 'grip' });
  };

  // Tijdens het slepen staat de lijst al in de nieuwe volgorde: het blok springt
  // mee naar de plek waar het zou landen. Alle balken zijn even hoog, dus dat
  // leest als slepen zonder een zwevende kopie.
  const shown = drag ? (() => {
    const rest = ids.filter(id => id !== drag.id);
    rest.splice(drag.over, 0, drag.id);
    return rest;
  })() : ids;

  const register = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) controls.current.set(key, element); else controls.current.delete(key);
  };

  return <section
    className="dash-arrange"
    aria-labelledby="dash-arrange-title"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onDone(); } }}
  >
    <header className="dash-arrange-head">
      <div>
        <h2 id="dash-arrange-title" ref={headRef} tabIndex={-1}><LayoutDashboard size={16} aria-hidden="true" /> Blokken indelen</h2>
        <p id="dash-arrange-hint">Sleep een blok aan het handvat, of gebruik de pijltjes. Met Open en Ingeklapt kies je hoe het op je dashboard staat.</p>
      </div>
      <div className="dash-arrange-actions">
        {canReset && <Button onClick={onReset} title="Terug naar de volgorde van ResoFly, alles open"><RotateCcw size={14} aria-hidden="true" /> Standaard</Button>}
        <Button variant="primary" onClick={onDone}>Klaar</Button>
      </div>
    </header>
    <ol className={`dash-arrange-list${drag ? ' is-dragging' : ''}`} ref={listRef}>
      {shown.map((id, index) => {
        const view = byId.get(id)!;
        const isCollapsed = collapsed.has(id);
        return <li key={id} className={`dash-arrange-item${drag?.id === id ? ' is-dragged' : ''}${isCollapsed ? ' is-collapsed' : ''}`} data-bar={id}>
            <button
              type="button"
              ref={register(`${id}:grip`)}
              className="dash-arrange-grip"
              aria-label={`${view.title} verplaatsen, plek ${index + 1} van ${shown.length}`}
              aria-describedby="dash-arrange-hint"
              title="Slepen om te verplaatsen; of pijltje omhoog en omlaag"
              onPointerDown={event => startDrag(event, id)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={event => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  step(id, event.key === 'ArrowUp' ? -1 : 1, 'grip');
                }
              }}
            ><GripVertical size={16} aria-hidden="true" /></button>
            <span className="dash-arrange-icon" aria-hidden="true">{view.icon}</span>
            <span className="dash-arrange-text">
              <b>{view.title}</b>
              {view.summary && <small>{view.summary}</small>}
            </span>
            <button
              type="button"
              className={`dash-arrange-fold${isCollapsed ? '' : ' is-open'}`}
              aria-pressed={!isCollapsed}
              aria-label={`${view.title}: ${isCollapsed ? 'ingeklapt' : 'open'}`}
              title={isCollapsed ? 'Staat ingeklapt; klik om open te zetten' : 'Staat open; klik om in te klappen'}
              onClick={() => onToggle(id)}
            >
              {isCollapsed ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
              <span>{isCollapsed ? 'Ingeklapt' : 'Open'}</span>
            </button>
            <span className="dash-arrange-steps">
              <button type="button" ref={register(`${id}:up`)} aria-label={`${view.title} omhoog`} title="Omhoog" disabled={index === 0} onClick={() => step(id, -1, 'up')}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" ref={register(`${id}:down`)} aria-label={`${view.title} omlaag`} title="Omlaag" disabled={index === shown.length - 1} onClick={() => step(id, 1, 'down')}><ArrowDown size={14} aria-hidden="true" /></button>
            </span>
          </li>;
      })}
    </ol>
    <p className="dash-sr" aria-live="polite">{announce}</p>
  </section>;
}
