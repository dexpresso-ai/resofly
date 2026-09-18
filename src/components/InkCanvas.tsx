import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, Eraser, Hand, Highlighter, Maximize2, Minimize2, Pen, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import {
  INK_COLORS, INK_DEFAULT_PRESSURE, INK_ERASER_RADIUS, INK_HIGHLIGHTER_WIDTH, INK_PAPERS, INK_PEN_WIDTHS,
  createInkPage, drawPage, drawStroke, eraseAlong, eraseAt, inkColorHex, inkId, inkPagesToPngBlobs, inkPaperColors,
  simplifyPoints, type InkColorKey, type InkDocument, type InkPage, type InkPaper, type InkStroke, type InkStrokeTool, type InkTheme, type InkTool,
} from '../lib/ink';
import { currentFullscreenElement, enterFullscreen, leaveFullscreen, onFullscreenChange } from '../lib/fullscreen';

/**
 * Handschrift-editor: schrijven met een pen op een tablet, alsof je op een
 * reMarkable werkt.
 *
 * Twee canvaslagen: de onderste toont het papier en alle vastgelegde lijnen,
 * de bovenste alleen de lijn die je nú trekt (plus de gumcursor). Zo hoeft er
 * per pennenstreek niets opnieuw getekend te worden en blijft het vloeiend,
 * ook op een pagina vol aantekeningen.
 *
 * Invoer via Pointer Events:
 *  - pen → tekent, met druk als lijndikte; de gum-kant/knop van de pen gumt;
 *  - muis → tekent (vaste druk);
 *  - vinger → scrolt de pagina (palmafwijzing); tekent alleen als "vinger
 *    tekent" aanstaat én er geen pen in gebruik is.
 *
 * Het document is "controlled": de ouder geeft `value` en krijgt bij elke
 * vastgelegde streek `onChange`. Tijdens een streek of gumbeweging wordt de
 * ouder bewust niét lastiggevallen — pas aan het einde van het gebaar.
 */

export interface InkCanvasProps {
  value: InkDocument;
  onChange: (next: InkDocument) => void;
  readOnly?: boolean;
  /** Kop boven het tekenvlak in tabletmodus (meestal de titel van de notitie). */
  title?: string;
  /** Kleine statusregel rechts in de knoppenbalk, bijvoorbeeld "Opgeslagen". */
  status?: ReactNode;
  /** Extra knoppen in de knoppenbalk (bijvoorbeeld "Opslaan" vanuit de agenda). */
  actions?: ReactNode;
  /** Start meteen in tabletmodus (schermvullend). */
  initialSheet?: boolean;
  /** Wordt aangeroepen als de gebruiker de tabletmodus verlaat. */
  onSheetChange?: (sheet: boolean) => void;
  /** Bestandsnaam (zonder extensie) voor de PNG-download. */
  exportName?: string;
  /** 'width' (standaard): de pagina vult de breedte; 'contain': past in hoogte én breedte (eigen overlay). */
  fit?: 'width' | 'contain';
  /** Knop "Tabletmodus" tonen (standaard ja). Uit in een eigen schermvullende overlay. */
  allowSheet?: boolean;
}

interface PaperSize { cssWidth: number; cssHeight: number; scale: number; dpr: number }

type GestureMode = 'draw' | 'erase' | 'pan';

interface Gesture {
  pointerId: number;
  pointerType: string;
  mode: GestureMode;
  /** Laatste gumpositie in paginapunten. */
  lastX: number;
  lastY: number;
  /** Laatste vingerpositie in schermpixels (scrollen). */
  lastClientX: number;
  lastClientY: number;
  /** Positie en schaal van het vel bij het neerzetten van de pen. Vast voor
   *  de duur van het gebaar: verschuift de lay-out onder de pen (statusregel,
   *  knoppenbalk die omslaat), dan verspringt de streek niet. */
  left: number;
  top: number;
  scale: number;
  /** Document zoals het was vóór dit gebaar — voor undo. */
  before: InkDocument;
  changed: boolean;
  /** Scrollen met de vinger: eerst het vel zelf (als dat scrolt), daarna de omliggende container. */
  scrollEl: HTMLElement | null;
  scrollFallback: HTMLElement | null;
}

const MAX_HISTORY = 120;
const MAX_DPR = 2;

function readTheme(): InkTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Volgt het app-thema (attribuut op <html>), zodat papier en inkt meewisselen. */
export function useInkTheme(): InkTheme {
  const [theme, setTheme] = useState<InkTheme>(readTheme);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    const scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    if (scrollable) return node;
    node = node.parentElement;
  }
  return null;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'handschrift';
}

/**
 * De lopende streek zoals de live-laag hem tekent.
 *
 * `drawStroke` trekt per frame de héle streek opnieuw na: pointsFromFlat,
 * densifyPoints en een map over de radii, allemaal over alle punten. Een pen
 * die op 240 Hz bemonstert haalt bij één doorlopende lijn van twintig seconden
 * — een handtekening, een lange onderstreping, een pagina vullen zonder
 * optillen — al gauw vijfduizend punten. Dat is per frame vijftienduizend
 * objecten en twee volledige passes, en dan loopt de inkt zichtbaar achter de
 * punt van de pen aan.
 *
 * Boven een drempel tekent de PREVIEW daarom uit een uitgedund kopietje: elk
 * n-de punt, plus de laatste punten onverkort zodat de tip exact onder de pen
 * blijft. `active.points` zelf blijft ongemoeid, dus wat er bij het optillen
 * wordt vastgelegd is tot op het punt identiek aan voorheen — het verschil
 * zit alleen in wat je tijdens het trekken ziet, en dat is bij deze
 * puntdichtheid niet te zien.
 */
const LIVE_PREVIEW_MAX_POINTS = 900;
/** Zoveel punten aan het eind blijven onverkort: daar kijkt de gebruiker naar. */
const LIVE_PREVIEW_TAIL_POINTS = 120;

function previewStroke(stroke: InkStroke): InkStroke {
  const total = stroke.points.length / 3;
  if (total <= LIVE_PREVIEW_MAX_POINTS) return stroke;

  const tailStart = Math.max(0, total - LIVE_PREVIEW_TAIL_POINTS);
  const step = Math.ceil(tailStart / Math.max(1, LIVE_PREVIEW_MAX_POINTS - LIVE_PREVIEW_TAIL_POINTS));
  const points: number[] = [];
  for (let i = 0; i < tailStart; i += step) {
    points.push(stroke.points[i * 3], stroke.points[i * 3 + 1], stroke.points[i * 3 + 2]);
  }
  for (let i = tailStart; i < total; i += 1) {
    points.push(stroke.points[i * 3], stroke.points[i * 3 + 1], stroke.points[i * 3 + 2]);
  }
  return { ...stroke, points };
}

function replacePage(doc: InkDocument, index: number, page: InkPage): InkDocument {
  const pages = doc.pages.slice();
  pages[index] = page;
  return { ...doc, pages };
}

export function InkCanvas({ value, onChange, readOnly = false, title, status, actions, initialSheet = false, onSheetChange, exportName, fit = 'width', allowSheet = true }: InkCanvasProps) {
  const theme = useInkTheme();
  const [tool, setTool] = useState<InkTool>('pen');
  const [color, setColor] = useState<InkColorKey>('ink');
  const [penWidth, setPenWidth] = useState<number>(INK_PEN_WIDTHS[1].value);
  const [pageIndex, setPageIndexState] = useState(0);
  const [fingerDraws, setFingerDraws] = useState(false);
  const [sheet, setSheetState] = useState(initialSheet);
  const [penSeen, setPenSeen] = useState(false);
  const undoRef = useRef<InkDocument[]>([]);
  const redoRef = useRef<InkDocument[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  const [paperCss, setPaperCss] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [exporting, setExporting] = useState(false);

  const docRef = useRef<InkDocument>(value);
  const lastDrawnRef = useRef<InkDocument | null>(null);
  const pageIndexRef = useRef(0);
  const toolRef = useRef<InkTool>('pen');
  const colorRef = useRef<InkColorKey>('ink');
  const penWidthRef = useRef<number>(INK_PEN_WIDTHS[1].value);
  const fingerDrawsRef = useRef(false);
  const themeRef = useRef<InkTheme>(theme);
  const sizeRef = useRef<PaperSize>({ cssWidth: 0, cssHeight: 0, scale: 1, dpr: 1 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef<InkStroke | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const baseDirtyRef = useRef(false);
  const penActiveRef = useRef(false);
  const lastPenAtRef = useRef(0);

  // Alleen een écht nieuw document van de ouder overnemen. Een ouder die om
  // een andere reden opnieuw rendert (statusregel, autosave) mag een gum- of
  // pennenstreek die nog bezig is niet stilletjes terugdraaien.
  const lastValueRef = useRef<InkDocument>(value);
  if (lastValueRef.current !== value) {
    lastValueRef.current = value;
    docRef.current = value;
  }
  pageIndexRef.current = pageIndex;
  toolRef.current = tool;
  colorRef.current = color;
  penWidthRef.current = penWidth;
  fingerDrawsRef.current = fingerDraws;
  themeRef.current = theme;

  const pageCount = value.pages.length;
  const safePageIndex = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const page = value.pages[safePageIndex] ?? value.pages[0];

  useEffect(() => {
    if (pageIndex !== safePageIndex) setPageIndexState(safePageIndex);
  }, [pageIndex, safePageIndex]);

  const setPageIndex = useCallback((next: number) => {
    setPageIndexState(next);
    pageIndexRef.current = next;
  }, []);

  // ── Tekenen van de lagen ──────────────────────────────────────────────

  const redrawBase = useCallback(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const doc = docRef.current;
    const current = doc.pages[Math.min(pageIndexRef.current, doc.pages.length - 1)];
    const { scale, dpr } = sizeRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!current || scale <= 0) return;
    drawPage(ctx, doc, current, scale * dpr, themeRef.current, true);
    lastDrawnRef.current = doc;
    baseDirtyRef.current = false;
  }, []);

  const renderLive = useCallback(() => {
    const canvas = liveRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { scale, dpr } = sizeRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = scale * dpr;
    const active = activeRef.current;
    if (active && active.points.length >= 3) drawStroke(ctx, previewStroke(active), k, themeRef.current);
    const cursor = cursorRef.current;
    if (cursor && toolRef.current === 'eraser') {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1, 1.2 * dpr);
      ctx.strokeStyle = themeRef.current === 'light' ? 'rgba(26,23,16,0.55)' : 'rgba(246,244,239,0.6)';
      ctx.fillStyle = themeRef.current === 'light' ? 'rgba(26,23,16,0.06)' : 'rgba(246,244,239,0.08)';
      ctx.beginPath();
      ctx.arc(cursor.x * k, cursor.y * k, INK_ERASER_RADIUS * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, []);

  const scheduleFrame = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (baseDirtyRef.current) redrawBase();
      renderLive();
    });
  }, [redrawBase, renderLive]);

  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  /** Tekent één vastgelegde lijn bovenop de onderste laag zonder alles opnieuw te doen. */
  const paintCommitted = useCallback((stroke: InkStroke) => {
    const canvas = baseRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { scale, dpr } = sizeRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawStroke(ctx, stroke, scale * dpr, themeRef.current);
  }, []);

  // ── Maat van het papier volgt de beschikbare ruimte ───────────────────

  const applySize = useCallback(() => {
    const stage = stageRef.current;
    const base = baseRef.current;
    const live = liveRef.current;
    if (!stage || !base || !live) return;
    const doc = docRef.current;
    const aspect = doc.height / doc.width;
    const stageWidth = Math.max(0, stage.clientWidth);
    const stageHeight = Math.max(0, stage.clientHeight);
    let cssWidth: number;
    if (sheet || fit === 'contain') {
      // Schermvullend: zo groot mogelijk binnen het scherm, hoogte én breedte.
      cssWidth = Math.max(120, Math.min(stageWidth, stageHeight > 0 ? stageHeight / aspect : stageWidth));
    } else {
      cssWidth = Math.max(120, stageWidth);
    }
    const cssHeight = cssWidth * aspect;
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const scale = cssWidth / doc.width;
    sizeRef.current = { cssWidth, cssHeight, scale, dpr };
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    for (const canvas of [base, live]) {
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    setPaperCss(prev => (prev.width === cssWidth && prev.height === cssHeight ? prev : { width: cssWidth, height: cssHeight }));
    redrawBase();
    renderLive();
  }, [redrawBase, renderLive, sheet, fit]);

  useLayoutEffect(() => {
    applySize();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => applySize());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [applySize]);

  // Nieuw document van buiten (geladen, undo, andere pagina, ander thema): alles opnieuw tekenen.
  useEffect(() => {
    if (lastDrawnRef.current !== value) redrawBase();
  }, [value, redrawBase]);
  useEffect(() => { redrawBase(); renderLive(); }, [safePageIndex, theme, redrawBase, renderLive]);

  // ── Tabletmodus (schermvullend) ───────────────────────────────────────

  const setSheet = useCallback((next: boolean) => {
    setSheetState(next);
    onSheetChange?.(next);
  }, [onSheetChange]);

  useEffect(() => {
    if (!sheet) return;
    document.body.classList.add('ink-sheet-open');
    const root = rootRef.current;
    // Echt schermvullend waar de browser het toelaat (niet op de iPhone); de
    // vaste overlay is leidend, dus een weigering is geen probleem.
    if (root) void enterFullscreen(root);
    const stop = onFullscreenChange(() => {
      if (!currentFullscreenElement()) setSheet(false);
    });
    return () => {
      stop();
      document.body.classList.remove('ink-sheet-open');
      void leaveFullscreen();
    };
  }, [sheet, setSheet]);

  // ── Geschiedenis ──────────────────────────────────────────────────────

  const commitDocument = useCallback((before: InkDocument, next: InkDocument, alreadyPainted: boolean) => {
    undoRef.current = [...undoRef.current.slice(-(MAX_HISTORY - 1)), before];
    redoRef.current = [];
    setHistoryTick(t => t + 1);
    docRef.current = next;
    if (alreadyPainted) lastDrawnRef.current = next;
    else baseDirtyRef.current = true;
    onChange(next);
    if (!alreadyPainted) scheduleFrame();
  }, [onChange, scheduleFrame]);

  const undo = useCallback(() => {
    const stack = undoRef.current;
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1];
    undoRef.current = stack.slice(0, -1);
    redoRef.current = [...redoRef.current, docRef.current];
    setHistoryTick(t => t + 1);
    docRef.current = previous;
    onChange(previous);
  }, [onChange]);

  const redo = useCallback(() => {
    const stack = redoRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1];
    redoRef.current = stack.slice(0, -1);
    undoRef.current = [...undoRef.current, docRef.current];
    setHistoryTick(t => t + 1);
    docRef.current = next;
    onChange(next);
  }, [onChange]);

  // Sneltoetsen in tabletmodus: undo/redo, gereedschap, Escape. In de
  // capture-fase, zodat Escape alleen de tabletmodus sluit en niet ook het
  // paneel of venster eronder (de agenda luistert zelf op Escape).
  useEffect(() => {
    if (!sheet) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setSheet(false);
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'p') setTool('pen');
        else if (key === 'm') setTool('highlighter');
        else if (key === 'g') setTool('eraser');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sheet, undo, redo, setSheet]);

  // ── Invoer ────────────────────────────────────────────────────────────

  const toPage = useCallback((clientX: number, clientY: number) => {
    const canvas = liveRef.current;
    const { scale } = sizeRef.current;
    if (!canvas || scale <= 0) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }, []);

  const toPageInGesture = (gesture: Gesture, clientX: number, clientY: number) => ({
    x: (clientX - gesture.left) / gesture.scale,
    y: (clientY - gesture.top) / gesture.scale,
  });

  const pressureOf = useCallback((event: PointerEvent, pointerType: string) => {
    if (pointerType !== 'pen') return INK_DEFAULT_PRESSURE;
    const p = event.pressure;
    return Number.isFinite(p) && p > 0 ? Math.min(1, p) : INK_DEFAULT_PRESSURE;
  }, []);

  const isEraserButton = (event: { button: number; buttons: number }, pointerType: string) =>
    pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) === 32);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly || gestureRef.current) return;
    const pointerType = event.pointerType || 'mouse';
    if (pointerType === 'mouse' && event.button !== 0) return;
    const now = Date.now();
    if (pointerType === 'pen') {
      lastPenAtRef.current = now;
      penActiveRef.current = true;
      if (!penSeen) setPenSeen(true);
    }
    const doc = docRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = sizeRef.current.scale > 0 ? sizeRef.current.scale : 1;
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;

    let mode: GestureMode;
    if (pointerType === 'touch') {
      // Palmafwijzing: zolang de pen actief is of net boven het scherm hing,
      // telt een aanraking niet — ook niet als scrollen. Anders schuift de
      // rustende hand de pagina onder de pen weg.
      if (penActiveRef.current || now - lastPenAtRef.current < 1500) return;
      mode = fingerDrawsRef.current ? (toolRef.current === 'eraser' ? 'erase' : 'draw') : 'pan';
    } else {
      mode = toolRef.current === 'eraser' || isEraserButton(event, pointerType) ? 'erase' : 'draw';
    }

    const gesture: Gesture = {
      pointerId: event.pointerId,
      pointerType,
      mode,
      lastX: x,
      lastY: y,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      left: rect.left,
      top: rect.top,
      scale,
      before: doc,
      changed: false,
      scrollEl: mode === 'pan' ? stageRef.current : null,
      scrollFallback: mode === 'pan' ? findScrollParent(stageRef.current) : null,
    };
    gestureRef.current = gesture;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* oude browsers */ }

    if (mode === 'draw') {
      const currentTool: InkStrokeTool = toolRef.current === 'highlighter' ? 'highlighter' : 'pen';
      activeRef.current = {
        id: inkId(),
        tool: currentTool,
        color: colorRef.current,
        width: currentTool === 'highlighter' ? INK_HIGHLIGHTER_WIDTH : penWidthRef.current,
        points: [x, y, pressureOf(event.nativeEvent, pointerType)],
      };
      scheduleFrame();
    } else if (mode === 'erase') {
      cursorRef.current = { x, y };
      const index = pageIndexRef.current;
      const current = doc.pages[index];
      if (current) {
        const erased = eraseAt(current, x, y);
        if (erased !== current) {
          docRef.current = replacePage(docRef.current, index, erased);
          gesture.changed = true;
          baseDirtyRef.current = true;
        }
      }
      scheduleFrame();
    }
  }, [readOnly, penSeen, pressureOf, scheduleFrame]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    const pointerType = event.pointerType || 'mouse';
    if (pointerType === 'pen') lastPenAtRef.current = Date.now();
    if (!gesture || gesture.pointerId !== event.pointerId) {
      // Zwevende pen of muis: de gumcursor volgt alvast.
      if (toolRef.current === 'eraser' && pointerType !== 'touch') {
        cursorRef.current = toPage(event.clientX, event.clientY);
        scheduleFrame();
      }
      return;
    }

    if (gesture.mode === 'pan') {
      const dx = event.clientX - gesture.lastClientX;
      const dy = event.clientY - gesture.lastClientY;
      gesture.lastClientX = event.clientX;
      gesture.lastClientY = event.clientY;
      const el = gesture.scrollEl;
      const fallback = gesture.scrollFallback;
      if (el) {
        const beforeTop = el.scrollTop;
        const beforeLeft = el.scrollLeft;
        el.scrollTop -= dy;
        el.scrollLeft -= dx;
        // Het vel zit aan zijn rand: dan scrolt de container eromheen verder.
        if (fallback && el.scrollTop === beforeTop && el.scrollLeft === beforeLeft) {
          fallback.scrollTop -= dy;
          fallback.scrollLeft -= dx;
        }
      } else if (fallback) {
        fallback.scrollTop -= dy;
        fallback.scrollLeft -= dx;
      }
      return;
    }

    const native = event.nativeEvent;
    const samples: PointerEvent[] = typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
      ? native.getCoalescedEvents()
      : [native];

    if (gesture.mode === 'draw') {
      const active = activeRef.current;
      if (!active) return;
      for (const sample of samples) {
        const { x, y } = toPageInGesture(gesture, sample.clientX, sample.clientY);
        active.points.push(x, y, pressureOf(sample, pointerType));
      }
      scheduleFrame();
      return;
    }

    // Gummen: langs het pad tussen het vorige en dit punt.
    const index = pageIndexRef.current;
    for (const sample of samples) {
      const { x, y } = toPageInGesture(gesture, sample.clientX, sample.clientY);
      const current = docRef.current.pages[index];
      if (current) {
        const erased = eraseAlong(current, gesture.lastX, gesture.lastY, x, y);
        if (erased !== current) {
          docRef.current = replacePage(docRef.current, index, erased);
          gesture.changed = true;
          baseDirtyRef.current = true;
        }
      }
      gesture.lastX = x;
      gesture.lastY = y;
      cursorRef.current = { x, y };
    }
    scheduleFrame();
  }, [toPage, pressureOf, scheduleFrame]);

  const finishGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.pointerType === 'pen') penActiveRef.current = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* al losgelaten */ }

    if (gesture.mode === 'draw') {
      const active = activeRef.current;
      activeRef.current = null;
      if (!active || cancelled) { scheduleFrame(); return; }
      const points = simplifyPoints(active.points);
      const stroke: InkStroke = { ...active, points };
      const index = pageIndexRef.current;
      const current = docRef.current.pages[index];
      if (!current) { scheduleFrame(); return; }
      const nextPage: InkPage = { ...current, strokes: [...current.strokes, stroke] };
      const next = replacePage(docRef.current, index, nextPage);
      // Een pennenstreek komt er bovenop; een markeerstreek moet ónder de pen
      // blijven en vraagt dus om een volledige hertekening.
      if (stroke.tool === 'pen') {
        paintCommitted(stroke);
        commitDocument(gesture.before, next, true);
      } else {
        commitDocument(gesture.before, next, false);
      }
      scheduleFrame();
      return;
    }

    if (gesture.mode === 'erase') {
      if (gesture.pointerType === 'touch') cursorRef.current = null;
      if (gesture.changed) {
        const next = docRef.current;
        baseDirtyRef.current = true;
        commitDocument(gesture.before, next, false);
      }
      scheduleFrame();
    }
  }, [commitDocument, paintCommitted, scheduleFrame]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => finishGesture(event, false), [finishGesture]);
  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => finishGesture(event, true), [finishGesture]);
  const onPointerLeave = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!gestureRef.current && cursorRef.current) {
      cursorRef.current = null;
      scheduleFrame();
    }
    if (event.pointerType === 'pen') penActiveRef.current = false;
  }, [scheduleFrame]);

  // ── Pagina's en papier ────────────────────────────────────────────────

  const currentPaper: InkPaper = page?.paper ?? 'lined';

  function addPage() {
    if (readOnly) return;
    const doc = docRef.current;
    const pages = [...doc.pages.slice(0, safePageIndex + 1), createInkPage(currentPaper), ...doc.pages.slice(safePageIndex + 1)];
    const next = { ...doc, pages };
    setPageIndex(safePageIndex + 1);
    commitDocument(doc, next, false);
  }

  function removePage() {
    if (readOnly) return;
    const doc = docRef.current;
    if (doc.pages.length <= 1) {
      if (page.strokes.length > 0 && !window.confirm('Deze pagina leegmaken? Dit is met "ongedaan maken" terug te draaien.')) return;
      commitDocument(doc, replacePage(doc, 0, { ...doc.pages[0], strokes: [] }), false);
      return;
    }
    if (page.strokes.length > 0 && !window.confirm('Deze pagina met inhoud verwijderen? Dit is met "ongedaan maken" terug te draaien.')) return;
    const pages = doc.pages.filter((_, i) => i !== safePageIndex);
    setPageIndex(Math.max(0, safePageIndex - 1));
    commitDocument(doc, { ...doc, pages }, false);
  }

  function setPaper(paper: InkPaper) {
    if (readOnly || paper === currentPaper) return;
    const doc = docRef.current;
    commitDocument(doc, replacePage(doc, safePageIndex, { ...page, paper }), false);
  }

  async function exportPng() {
    if (exporting) return;
    setExporting(true);
    try {
      const blobs = await inkPagesToPngBlobs(docRef.current, 'light', 2);
      const base = safeFileName(exportName || title || 'handschrift');
      blobs.forEach((blob, i) => saveBlob(blob, blobs.length > 1 ? `${base} - pagina ${i + 1}.png` : `${base}.png`));
    } finally {
      setExporting(false);
    }
  }

  // ── Opbouw ────────────────────────────────────────────────────────────

  void historyTick; // herberekening van de knoppen na elke wijziging in de geschiedenis
  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  const documentEmpty = value.pages.every(p => p.strokes.length === 0);
  const strokesOnPage = page?.strokes.length ?? 0;
  const paperColors = inkPaperColors(theme);
  const cursorStyle = readOnly ? 'default' : tool === 'eraser' ? 'none' : 'crosshair';

  const toolButton = (key: InkTool, label: string, icon: ReactNode, shortcut: string) => (
    <button
      type="button"
      className={`ink-tool${tool === key ? ' is-active' : ''}`}
      onClick={() => setTool(key)}
      aria-pressed={tool === key}
      aria-label={label}
      title={`${label} (${shortcut})`}
      disabled={readOnly}
    >{icon}<span>{label}</span></button>
  );

  const toolbar = (
    <div className="ink-toolbar" role="toolbar" aria-label="Handschrift">
      <div className="ink-toolbar-group">
        {toolButton('pen', 'Pen', <Pen size={15} />, 'P')}
        {toolButton('highlighter', 'Marker', <Highlighter size={15} />, 'M')}
        {toolButton('eraser', 'Gum', <Eraser size={15} />, 'G')}
      </div>
      <div className="ink-toolbar-group ink-colors" role="radiogroup" aria-label="Inktkleur">
        {INK_COLORS.map(c => (
          <button
            type="button"
            key={c.key}
            role="radio"
            aria-checked={color === c.key}
            aria-label={c.label}
            title={c.label}
            className={`ink-color${color === c.key ? ' is-active' : ''}`}
            style={{ '--ink-swatch': inkColorHex(c.key, theme) } as CSSProperties}
            disabled={readOnly || tool === 'eraser'}
            onClick={() => { setColor(c.key); if (tool === 'eraser') setTool('pen'); }}
          />
        ))}
      </div>
      <div className="ink-toolbar-group ink-widths" role="radiogroup" aria-label="Pendikte">
        {INK_PEN_WIDTHS.map(w => (
          <button
            type="button"
            key={w.value}
            role="radio"
            aria-checked={penWidth === w.value}
            aria-label={w.label}
            title={w.label}
            className={`ink-width${penWidth === w.value ? ' is-active' : ''}`}
            disabled={readOnly || tool !== 'pen'}
            onClick={() => setPenWidth(w.value)}
          ><i style={{ width: 6 + w.value * 2, height: 6 + w.value * 2 }} /></button>
        ))}
      </div>
      <div className="ink-toolbar-group">
        <button type="button" className="ink-tool ink-tool-icon" onClick={undo} disabled={!canUndo || readOnly} aria-label="Ongedaan maken" title="Ongedaan maken (Ctrl+Z)"><Undo2 size={15} /></button>
        <button type="button" className="ink-tool ink-tool-icon" onClick={redo} disabled={!canRedo || readOnly} aria-label="Opnieuw" title="Opnieuw (Ctrl+Shift+Z)"><Redo2 size={15} /></button>
      </div>
      <div className="ink-toolbar-group">
        <label className="ink-paper-select">
          <span>Papier</span>
          <select value={currentPaper} onChange={e => setPaper(e.target.value as InkPaper)} disabled={readOnly} aria-label="Papiersoort">
            {INK_PAPERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className={`ink-tool ink-tool-icon${fingerDraws ? ' is-active' : ''}`}
          onClick={() => setFingerDraws(v => !v)}
          aria-pressed={fingerDraws}
          aria-label="Vinger tekent"
          title={fingerDraws ? 'Vinger tekent — tik om te scrollen met je vinger' : 'Vinger scrolt — tik om ook met je vinger te tekenen'}
          disabled={readOnly}
        ><Hand size={15} /></button>
        <button type="button" className="ink-tool ink-tool-icon" onClick={() => void exportPng()} disabled={exporting || documentEmpty} aria-label="Download als PNG" title="Download als PNG"><Download size={15} /></button>
      </div>
      <div className="ink-toolbar-spacer" />
      <span className="ink-toolbar-status" aria-live="polite">
        {penSeen && <span className="ink-pen-chip" title="Druk en palm worden herkend"><Pen size={12} /> Pen herkend</span>}
        {status && <span className="ink-status">{status}</span>}
      </span>
      {actions}
      {allowSheet && <button
        type="button"
        className="ink-tool ink-tool-sheet"
        onClick={() => setSheet(!sheet)}
        aria-label={sheet ? 'Tabletmodus verlaten' : 'Tabletmodus'}
        title={sheet ? 'Tabletmodus verlaten (Esc)' : 'Schermvullend schrijven'}
      >{sheet ? <Minimize2 size={15} /> : <Maximize2 size={15} />}<span>{sheet ? 'Klaar' : 'Tabletmodus'}</span></button>}
    </div>
  );

  const pagebar = (
    <div className="ink-pagebar">
      <button type="button" className="ink-tool ink-tool-icon" onClick={() => setPageIndex(Math.max(0, safePageIndex - 1))} disabled={safePageIndex === 0} aria-label="Vorige pagina"><ChevronLeft size={16} /></button>
      <span className="ink-page-indicator" aria-live="polite">Pagina {safePageIndex + 1} / {pageCount}</span>
      <button type="button" className="ink-tool ink-tool-icon" onClick={() => setPageIndex(Math.min(pageCount - 1, safePageIndex + 1))} disabled={safePageIndex >= pageCount - 1} aria-label="Volgende pagina"><ChevronRight size={16} /></button>
      {!readOnly && <>
        <button type="button" className="ink-tool" onClick={addPage} aria-label="Pagina toevoegen" title="Nieuwe pagina na deze"><Plus size={15} /><span>Pagina</span></button>
        <button type="button" className="ink-tool ink-tool-danger" onClick={removePage} aria-label={pageCount > 1 ? 'Pagina verwijderen' : 'Pagina leegmaken'} title={pageCount > 1 ? 'Deze pagina verwijderen' : 'Deze pagina leegmaken'} disabled={pageCount <= 1 && strokesOnPage === 0}><Trash2 size={15} /><span>{pageCount > 1 ? 'Verwijder' : 'Leegmaken'}</span></button>
      </>}
    </div>
  );

  const editor = (
    <div
      ref={rootRef}
      className={`ink-editor ${sheet ? 'ink-editor-sheet' : 'ink-editor-inline'} ink-theme-${theme}${readOnly ? ' is-readonly' : ''}`}
      style={{ '--ink-paper': paperColors.paper } as CSSProperties}
    >
      {sheet && (
        <div className="ink-sheet-head">
          <div className="ink-sheet-title">
            <span className="ink-sheet-kicker">Handschrift</span>
            <strong>{title || 'Notitie'}</strong>
          </div>
          <span className="ink-sheet-hint">Pen tekent · vinger scrolt · Esc sluit</span>
        </div>
      )}
      {toolbar}
      <div className="ink-stage" ref={stageRef}>
        <div className="ink-paper" style={{ width: paperCss.width || undefined, height: paperCss.height || undefined }}>
          <canvas ref={baseRef} className="ink-layer ink-layer-base" aria-hidden="true" />
          <canvas
            ref={liveRef}
            className="ink-layer ink-layer-live"
            role="img"
            aria-label={`Tekenvlak, pagina ${safePageIndex + 1} van ${pageCount}, ${strokesOnPage} lijnen`}
            style={{ touchAction: 'none', cursor: cursorStyle }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onPointerLeave={onPointerLeave}
            onContextMenu={e => e.preventDefault()}
          />
          {strokesOnPage === 0 && !readOnly && (
            <div className="ink-empty-hint" aria-hidden="true">Schrijf hier met je pen</div>
          )}
        </div>
      </div>
      {pagebar}
    </div>
  );

  if (sheet && typeof document !== 'undefined') {
    return createPortal(<div className="ink-sheet-backdrop">{editor}</div>, document.body);
  }
  return editor;
}
