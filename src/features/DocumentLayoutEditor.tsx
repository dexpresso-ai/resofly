// Instellingen → Documentopmaak: de gegevens van een offerte en factuur zelf
// op de pagina slepen, of een kant-en-klaar sjabloon kiezen.
//
// Wat je hier ziet IS de PDF. Het blad is het plan van src/lib/documentLayout.ts
// — dezelfde code waarmee invoice-workflow en quote-workflow de verstuurde PDF
// tekenen — als SVG getekend en gemeten met de lettertypen van pdf-lib zelf.
// Daarboven liggen alleen de handvatten om te slepen. Het oude voorbeeldkaartje
// bij Facturatie was nagebouwd in HTML en liep daardoor uit de pas met de PDF.
//
// De editor bewerkt `form.document_layouts` (en voor de stijl een paar
// bestaande kolommen: lettergrootte, tekstkleur, briefpapier). Opslaan gaat via
// de knop van de instellingenpagina, zoals bij Huisstijl.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react';
import * as PdfLib from 'pdf-lib';
import {
  ArrowDown, ArrowUp, Check, CircleAlert, Copy, Download, Eye, Image as ImageIcon, LayoutTemplate, Minus, Plus,
  Redo2, RotateCcw, Square, Trash2, Type, Undo2,
} from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import {
  DOCUMENT_FIELDS, FIELD_GROUPS, FLOW_ITEMS, FONT_CHOICES, LAYOUT_LIMITS, LAYOUT_PRESETS, PAGE_HEIGHT, PAGE_WIDTH,
  TABLE_STYLES, TOTALS_STYLES, builtInLayout, clampBlock, documentAssetsFromSettings, documentPdfFileName,
  embedDocumentFonts, fieldCaption, fieldDefinition, layoutIssues, measureWith, newFieldBlock, newShapeBlock,
  normalizeDocumentLayout, parseDocumentLayouts, planDocument, presetLayout, renderDocumentPdf, resolveDocumentLayout,
  resolveDocumentStyle, sampleDocumentData, serializeDocumentLayouts, tokenList, uniqueBlockId,
  type DocumentKind, type DocumentLayout, type DocumentLayouts, type DocumentStyle, type FontRef, type LayoutAlign,
  type LayoutBlock, type LayoutFlowKey, type LayoutFontChoice, type LayoutLabel, type LayoutPresetKey, type LayoutTone,
  type Measure, type PdfFamily, type PlanBox, type PlanOp, type TableStyle, type TotalsStyle,
} from '../lib/documentLayout';
import type { CompanySettingsInput } from '../types';

type SetForm = Dispatch<SetStateAction<CompanySettingsInput>>;
type Shape = 'text' | 'logo' | 'line' | 'box';
type Selection = { type: 'block'; id: string } | { type: 'flow'; key: LayoutFlowKey } | null;
type Guide = { axis: 'x' | 'y'; at: number };
type Draft =
  | { type: 'block'; block: LayoutBlock }
  | { type: 'divider'; which: 'bodyTop' | 'footerTop'; value: number }
  | null;
type DragState =
  | { type: 'move'; id: string; startX: number; startY: number; origin: LayoutBlock; moved: boolean }
  | { type: 'resize'; id: string; edge: 'e' | 's' | 'se'; startX: number; startY: number; origin: LayoutBlock }
  | { type: 'divider'; which: 'bodyTop' | 'footerTop'; startY: number; origin: number }
  | { type: 'new'; item: PaletteItem; startX: number; startY: number; active: boolean };
type PaletteItem = { field: string } | { shape: Shape };

const PT_PER_MM = 72 / 25.4;
/** Ruimte tussen het laagste kopblok en het begin van de inhoud. */
const HEADER_GAP = 10;
/** Binnen deze afstand (schermpixels) klikt een rand vast aan een hulplijn. */
const SNAP_PX = 6;
const MAX_HISTORY = 60;
/** Velden die thuishoren in de voet: een klik zet ze daar neer. */
const FOOTER_FIELDS = ['document.voettekst', 'document.pagina'];

const SHAPES: Array<{ shape: Shape; name: string; hint: string; Icon: typeof Type }> = [
  { shape: 'text', name: 'Eigen tekst', hint: 'Vaste tekst, met {{velden}} erin.', Icon: Type },
  { shape: 'logo', name: 'Logo', hint: 'Je logo uit Huisstijl; zonder logo je naam.', Icon: ImageIcon },
  { shape: 'line', name: 'Lijn', hint: 'Een scheidingslijn.', Icon: Minus },
  { shape: 'box', name: 'Vlak', hint: 'Een vlak in je merkkleur, bijv. een balk.', Icon: Square },
];

/** Wat de browser het dichtst bij de standaardletters van een PDF laat zien. */
const SVG_FONTS: Record<PdfFamily, string> = {
  helvetica: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  times: "'Times New Roman', Times, 'Liberation Serif', serif",
  courier: "'Courier New', Courier, 'Liberation Mono', monospace",
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const toMm = (pt: number) => Math.round((pt / PT_PER_MM) * 10) / 10;

function shapeName(type: LayoutBlock['type']): string {
  return SHAPES.find(item => item.shape === type)?.name ?? 'Blok';
}

function blockName(block: LayoutBlock, kind: DocumentKind): string {
  if (block.type === 'field') {
    const def = fieldDefinition(block.field);
    return def ? (def.key.startsWith('document.') && def.key !== 'document.titel' ? fieldCaption(def.key, kind) : def.name) : 'Veld';
  }
  return shapeName(block.type);
}

// ── Metingen en logo ────────────────────────────────────────────────────────

/**
 * Meet tekst met de échte standaardletters van pdf-lib, zodat elke regelbreuk
 * in de editor dezelfde is als in de PDF. De vorige meting blijft staan tot de
 * nieuwe klaar is, dan flikkert het blad niet bij een ander lettertype.
 */
function useDocumentMeasure(style: DocumentStyle): Measure | null {
  const key = `${style.headingFamily}|${style.bodyFamily}`;
  const [state, setState] = useState<{ key: string; measure: Measure } | null>(null);
  const styleRef = useRef(style);
  styleRef.current = style;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const doc = await PdfLib.PDFDocument.create();
      const fonts = await embedDocumentFonts(doc, styleRef.current);
      if (alive) setState({ key, measure: measureWith(fonts) });
    })().catch(error => console.warn('Lettertypen voor de opmaakeditor laden mislukt', error));
    return () => { alive = false; };
  }, [key]);
  return state?.measure ?? null;
}

/** De afmetingen van het logo; alleen PNG en JPEG, want alleen die kan een PDF aan. */
function useLogoSize(dataUrl: string | null | undefined): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!dataUrl || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) { setSize(null); return; }
    let alive = true;
    const image = new Image();
    image.onload = () => { if (alive) setSize({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { if (alive) setSize(null); };
    image.src = dataUrl;
    return () => { alive = false; };
  }, [dataUrl]);
  return size;
}

// ── Zones en vastklikken ────────────────────────────────────────────────────

function headerBottom(layout: DocumentLayout, except?: string): number {
  return layout.blocks
    .filter(block => block.id !== except && block.y < layout.bodyTop)
    .reduce((lowest, block) => Math.max(lowest, block.y + block.h), 0);
}

function footerTopmost(layout: DocumentLayout, except?: string): number {
  return layout.blocks
    .filter(block => block.id !== except && block.y >= layout.footerTop)
    .reduce((top, block) => Math.min(top, block.y), PAGE_HEIGHT);
}

/**
 * Zet een blok in de kop of de voet, wat het dichtst bij is. Valt het blok
 * over het inhoudsgebied heen, dan schuift de grens mee: wie een veld net
 * boven de regels neerzet, ziet de regels zakken in plaats van eroverheen te
 * lopen.
 */
function settleBlock(layout: DocumentLayout, input: LayoutBlock): DocumentLayout {
  let block = clampBlock(input);
  let { bodyTop, footerTop } = layout;
  if (block.y + block.h / 2 < (bodyTop + footerTop) / 2) {
    const needed = block.y + block.h + HEADER_GAP;
    if (needed > bodyTop) bodyTop = Math.min(LAYOUT_LIMITS.bodyTop.max, needed);
    if (block.y + block.h + HEADER_GAP > bodyTop) {
      const h = Math.min(block.h, bodyTop - HEADER_GAP);
      block = { ...block, h: Math.max(4, h), y: Math.max(0, bodyTop - HEADER_GAP - Math.max(4, h)) };
    }
  } else {
    if (block.y < footerTop) footerTop = Math.max(LAYOUT_LIMITS.footerTop.min, block.y);
    if (block.y < footerTop) block = { ...block, y: footerTop };
    if (block.y + block.h > PAGE_HEIGHT) block = { ...block, h: Math.max(4, PAGE_HEIGHT - block.y) };
  }
  const exists = layout.blocks.some(item => item.id === block.id);
  return {
    ...layout,
    bodyTop: round2(bodyTop),
    footerTop: round2(footerTop),
    blocks: exists ? layout.blocks.map(item => (item.id === block.id ? clampBlock(block) : item)) : [...layout.blocks, clampBlock(block)],
  };
}

function nearest(edges: number[], targets: number[], threshold: number): { delta: number; at: number } | null {
  let found: { delta: number; at: number } | null = null;
  for (const edge of edges) {
    for (const target of targets) {
      const delta = target - edge;
      if (Math.abs(delta) <= threshold && (!found || Math.abs(delta) < Math.abs(found.delta))) found = { delta, at: target };
    }
  }
  return found;
}

/** Hulplijnen: kantlijnen, het midden van de pagina, de randen van andere blokken. */
function snapTargets(layout: DocumentLayout, boxes: PlanBox[]): { xs: number[]; ys: number[] } {
  return {
    xs: [layout.marginX, PAGE_WIDTH - layout.marginX, PAGE_WIDTH / 2, ...boxes.flatMap(box => [box.x, box.x + box.w, box.x + box.w / 2])],
    ys: [layout.bodyTop - HEADER_GAP, layout.footerTop, ...boxes.flatMap(box => [box.y, box.y + box.h])],
  };
}

// ── Het blad ────────────────────────────────────────────────────────────────

function PlanSvg({ ops, style, measure, logoUrl, paperUrl }: {
  ops: PlanOp[];
  style: DocumentStyle;
  measure: Measure;
  logoUrl: string | null;
  paperUrl: string | null;
}) {
  const family = (font: FontRef) => SVG_FONTS[font === 'heading' || font === 'headingBold' ? style.headingFamily : style.bodyFamily];
  return <svg className="dle-svg" viewBox={`0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`} aria-hidden="true" focusable="false">
    <rect x={0} y={0} width={PAGE_WIDTH} height={PAGE_HEIGHT} fill="#FFFFFF" />
    {paperUrl && <image href={paperUrl} x={0} y={0} width={PAGE_WIDTH} height={PAGE_HEIGHT} preserveAspectRatio="xMidYMid slice" />}
    {ops.map((op, index) => {
      if (op.t === 'rect') return <rect key={index} x={op.x} y={op.y} width={op.w} height={op.h} fill={op.color} fillOpacity={op.opacity} />;
      if (op.t === 'line') return <line key={index} x1={op.x1} y1={op.y1} x2={op.x2} y2={op.y2} stroke={op.color} strokeWidth={op.width} strokeOpacity={op.opacity} />;
      if (op.t === 'image') return logoUrl ? <image key={index} href={logoUrl} x={op.x} y={op.y} width={op.w} height={op.h} preserveAspectRatio="none" /> : null;
      // textLength: precies zo breed als pdf-lib hem meet. Arial is net iets
      // anders dan Helvetica; zonder dit liep rechts uitgelijnde tekst een paar
      // pixels over de kantlijn, terwijl de PDF klopte.
      return <text
        key={index}
        x={op.x}
        y={op.y}
        fontSize={op.size}
        fontFamily={family(op.font)}
        fontWeight={op.font === 'bodyBold' || op.font === 'headingBold' ? 700 : 400}
        fill={op.color}
        textLength={Math.max(0.1, measure(op.text, op.size, op.font))}
        lengthAdjust="spacingAndGlyphs"
        style={{ whiteSpace: 'pre' }}
      >{op.text}</text>;
    })}
  </svg>;
}

// ── De editor ───────────────────────────────────────────────────────────────

export function DocumentLayoutEditor({ form, setForm, canWrite, onLetterheadSelected, onLetterheadRemoved, onOpenBrand }: {
  form: CompanySettingsInput;
  setForm: SetForm;
  canWrite: boolean;
  onLetterheadSelected: (file: File | undefined) => void;
  onLetterheadRemoved: () => void;
  onOpenBrand: () => void;
}) {
  const [kind, setKind] = useState<DocumentKind>('invoice');
  const [view, setView] = useState<'design' | 'pdf'>('design');
  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraftState] = useState<Draft>(null);
  // De laatste sleepstand ook in een ref: een pointerup vlak na de laatste
  // pointermove kan anders nog de stand van één frame eerder vastleggen.
  const draftRef = useRef<Draft>(null);
  const setDraft = (value: Draft) => { draftRef.current = value; setDraftState(value); };
  // Hoe het laatste veld in de lijst werd aangeraakt: muis en pen slepen (een
  // klik zonder slepen voegt toe bij het loslaten), touch en toetsenbord voegen
  // toe bij de klik.
  const lastPointer = useRef<string>('');
  const [guides, setGuides] = useState<Guide[]>([]);
  const [ghost, setGhost] = useState<{ item: PaletteItem; x: number; y: number } | null>(null);
  const [past, setPast] = useState<Array<DocumentLayouts | null>>([]);
  const [future, setFuture] = useState<Array<DocumentLayouts | null>>([]);
  const [zoom, setZoom] = useState(1);
  const [stageWidth, setStageWidth] = useState(0);
  const lastCommit = useRef<{ key: string; at: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const layouts = useMemo(() => parseDocumentLayouts(form.document_layouts), [form.document_layouts]);
  const hasPaper = form.invoice_template_kind !== 'none' && Boolean(form.invoice_template_data_url);
  const paperIsImage = hasPaper && form.invoice_template_kind === 'image';
  const custom = kind === 'quote' ? layouts.quote : layouts.invoice;
  const layout = useMemo(() => custom ?? builtInLayout(kind, { letterhead: hasPaper }), [custom, kind, hasPaper]);
  const style = useMemo(() => resolveDocumentStyle(form, layouts.font), [form, layouts.font]);
  const data = useMemo(() => sampleDocumentData(kind, form), [kind, form]);
  const measure = useDocumentMeasure(style);
  const logoSize = useLogoSize(form.brand_logo_data_url);
  const logoUrl = logoSize ? form.brand_logo_data_url ?? null : null;

  // Het blad zoals het nu staat, met wat er op dit moment wordt versleept.
  const shown = useMemo<DocumentLayout>(() => {
    if (!draft) return layout;
    if (draft.type === 'divider') return { ...layout, [draft.which]: draft.value };
    const exists = layout.blocks.some(block => block.id === draft.block.id);
    return { ...layout, blocks: exists ? layout.blocks.map(block => (block.id === draft.block.id ? draft.block : block)) : [...layout.blocks, draft.block] };
  }, [layout, draft]);
  const plan = useMemo(() => (measure ? planDocument(shown, data, style, { measure, logo: logoSize }) : null), [shown, data, style, measure, logoSize]);
  const issues = useMemo(() => layoutIssues(layout, kind, { kor: form.kor_enabled, letterhead: hasPaper }), [layout, kind, form.kor_enabled, hasPaper]);

  const fit = stageWidth > 0 ? Math.min(1.2, (stageWidth - 2) / PAGE_WIDTH) : 0.8;
  const scale = Math.max(0.3, fit * zoom);
  const selectedBlock = selection?.type === 'block' ? layout.blocks.find(block => block.id === selection.id) ?? null : null;
  const page = plan?.pages[0] ?? null;

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);

  // Een ander document: geen selectie meer van een blok dat daar niet is.
  useEffect(() => { setSelection(null); draftRef.current = null; setDraftState(null); }, [kind]);

  // ── Vastleggen, met ongedaan maken ──

  const commitLayouts = useCallback((next: DocumentLayouts, coalesce?: string) => {
    const before = form.document_layouts ?? null;
    const after = serializeDocumentLayouts(next);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    // Typen en schuiven met een schuifbalk worden één stap, geen honderd.
    const now = Date.now();
    const merge = Boolean(coalesce && lastCommit.current?.key === coalesce && now - lastCommit.current.at < 1200);
    lastCommit.current = coalesce ? { key: coalesce, at: now } : null;
    if (!merge) {
      setPast(stack => [...stack.slice(-(MAX_HISTORY - 1)), before]);
      setFuture([]);
    }
    setForm(prev => ({ ...prev, document_layouts: after }));
  }, [form.document_layouts, setForm]);

  /** Wijzigt de opmaak van het open document. De standaard wordt bij de eerste wijziging een eigen opmaak. */
  const updateLayout = useCallback((mutate: (current: DocumentLayout) => DocumentLayout, coalesce?: string) => {
    if (!canWrite) return;
    const base: DocumentLayout = custom ?? { ...builtInLayout(kind, { letterhead: hasPaper }), preset: 'standaard' };
    const next = normalizeDocumentLayout(mutate(base), kind);
    if (!next) return;
    commitLayouts({ ...layouts, [kind]: next }, coalesce);
  }, [canWrite, custom, kind, hasPaper, layouts, commitLayouts]);

  const setFont = (font: LayoutFontChoice) => { if (canWrite) commitLayouts({ ...layouts, font }); };

  const undo = useCallback(() => {
    if (!canWrite || past.length === 0) return;
    const previous = past[past.length - 1];
    setPast(stack => stack.slice(0, -1));
    setFuture(stack => [form.document_layouts ?? null, ...stack].slice(0, MAX_HISTORY));
    lastCommit.current = null;
    setForm(prev => ({ ...prev, document_layouts: previous }));
  }, [canWrite, past, form.document_layouts, setForm]);

  const redo = useCallback(() => {
    if (!canWrite || future.length === 0) return;
    const [next, ...rest] = future;
    setFuture(rest);
    setPast(stack => [...stack, form.document_layouts ?? null].slice(-MAX_HISTORY));
    lastCommit.current = null;
    setForm(prev => ({ ...prev, document_layouts: next }));
  }, [canWrite, future, form.document_layouts, setForm]);

  const updateBlock = (id: string, patch: Partial<LayoutBlock>, coalesce?: string) => {
    updateLayout(current => {
      const block = current.blocks.find(item => item.id === id);
      if (!block) return current;
      const next = { ...block, ...patch };
      // Plaats of maat veranderd: opnieuw in kop of voet zetten.
      return 'x' in patch || 'y' in patch || 'w' in patch || 'h' in patch
        ? settleBlock(current, next)
        : { ...current, blocks: current.blocks.map(item => (item.id === id ? next : item)) };
    }, coalesce ?? `blok:${id}`);
  };

  const removeBlock = (id: string) => {
    updateLayout(current => ({ ...current, blocks: current.blocks.filter(block => block.id !== id) }));
    setSelection(null);
  };

  const duplicateBlock = (id: string) => {
    const block = layout.blocks.find(item => item.id === id);
    if (!block) return;
    const copy: LayoutBlock = { ...block, id: uniqueBlockId(layout.blocks, block.id.replace(/-\d+$/, '')), x: block.x + 10, y: block.y + 10 };
    updateLayout(current => settleBlock(current, copy));
    setSelection({ type: 'block', id: copy.id });
  };

  const newBlock = (item: PaletteItem, at: { x: number; y: number }, blocks: LayoutBlock[]): LayoutBlock | null =>
    'field' in item ? newFieldBlock(item.field, blocks, at) : newShapeBlock(item.shape, blocks, at);

  /** Klik (of Enter) op een veld in de lijst: het komt op een vrije plek in de kop of de voet. */
  const addFromPalette = (item: PaletteItem) => {
    if (!canWrite) return;
    const toFooter = 'field' in item && FOOTER_FIELDS.includes(item.field);
    const probe = newBlock(item, { x: 0, y: 0 }, layout.blocks);
    if (!probe) return;
    const footerBottom = layout.blocks.filter(block => block.y >= layout.footerTop).reduce((low, block) => Math.max(low, block.y + block.h), layout.footerTop);
    const at = toFooter
      ? { x: layout.marginX, y: Math.min(PAGE_HEIGHT - probe.h - 4, footerBottom + 4) }
      : { x: layout.marginX, y: Math.max(40, headerBottom(layout) + 8) };
    const block = newBlock(item, at, layout.blocks);
    if (!block) return;
    updateLayout(current => settleBlock(current, block));
    setSelection({ type: 'block', id: block.id });
  };

  // ── Slepen ──

  const toPt = (clientX: number, clientY: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0, inside: false };
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
      inside: clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
    };
  };

  const otherBoxes = (id: string): PlanBox[] => Object.entries(page?.boxes ?? {}).filter(([key]) => key !== id).map(([, box]) => box);

  const onWindowMove = useRef<(event: PointerEvent) => void>(() => {});
  const onWindowUp = useRef<(event: PointerEvent) => void>(() => {});

  onWindowMove.current = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const snapOn = !event.altKey;
    const threshold = SNAP_PX / scale;
    if (drag.type === 'new') {
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.active = true;
      setGhost({ item: drag.item, x: event.clientX, y: event.clientY });
      const point = toPt(event.clientX, event.clientY);
      if (point.inside) {
        const block = newBlock(drag.item, { x: point.x - 12, y: point.y - 8 }, layout.blocks);
        if (block) setDraft({ type: 'block', block: clampBlock(block) });
      } else setDraft(null);
      return;
    }
    if (drag.type === 'divider') {
      const dy = (event.clientY - drag.startY) / scale;
      const min = drag.which === 'bodyTop'
        ? Math.max(LAYOUT_LIMITS.bodyTop.min, headerBottom(layout) + HEADER_GAP)
        : Math.max(LAYOUT_LIMITS.footerTop.min, layout.bodyTop + 120);
      const max = drag.which === 'bodyTop'
        ? Math.min(LAYOUT_LIMITS.bodyTop.max, layout.footerTop - 120)
        : Math.min(LAYOUT_LIMITS.footerTop.max, footerTopmost(layout));
      setDraft({ type: 'divider', which: drag.which, value: round2(Math.max(min, Math.min(max, drag.origin + dy))) });
      return;
    }
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    const targets = snapTargets(layout, otherBoxes(drag.id));
    const nextGuides: Guide[] = [];
    if (drag.type === 'move') {
      if (!drag.moved && Math.hypot(dx * scale, dy * scale) < 3) return;
      drag.moved = true;
      let x = drag.origin.x + dx;
      let y = drag.origin.y + dy;
      if (snapOn) {
        const fx = nearest([x, x + drag.origin.w, x + drag.origin.w / 2], targets.xs, threshold);
        const fy = nearest([y, y + drag.origin.h], targets.ys, threshold);
        if (fx) { x += fx.delta; nextGuides.push({ axis: 'x', at: fx.at }); }
        if (fy) { y += fy.delta; nextGuides.push({ axis: 'y', at: fy.at }); }
      }
      setDraft({ type: 'block', block: clampBlock({ ...drag.origin, x: round2(x), y: round2(y) }) });
    } else {
      let w = drag.origin.w + (drag.edge === 's' ? 0 : dx);
      let h = drag.origin.h + (drag.edge === 'e' ? 0 : dy);
      if (snapOn && drag.edge !== 's') {
        const fx = nearest([drag.origin.x + w], targets.xs, threshold);
        if (fx) { w += fx.delta; nextGuides.push({ axis: 'x', at: fx.at }); }
      }
      if (snapOn && drag.edge !== 'e') {
        const fy = nearest([drag.origin.y + h], targets.ys, threshold);
        if (fy) { h += fy.delta; nextGuides.push({ axis: 'y', at: fy.at }); }
      }
      setDraft({ type: 'block', block: clampBlock({ ...drag.origin, w: round2(Math.max(8, w)), h: round2(Math.max(4, h)) }) });
    }
    setGuides(nextGuides);
  };

  onWindowUp.current = (event: PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener('pointermove', handleWindowMove);
    window.removeEventListener('pointerup', handleWindowUp);
    window.removeEventListener('pointercancel', handleWindowUp);
    const current = draftRef.current;
    setGhost(null);
    setGuides([]);
    setDraft(null);
    if (!drag) return;
    if (drag.type === 'new') {
      if (!drag.active) { addFromPalette(drag.item); return; }
      const point = toPt(event.clientX, event.clientY);
      if (!point.inside || !current || current.type !== 'block') return;
      updateLayout(layoutNow => settleBlock(layoutNow, current.block));
      setSelection({ type: 'block', id: current.block.id });
      return;
    }
    if (!current) return;
    if (current.type === 'divider') {
      updateLayout(layoutNow => ({ ...layoutNow, [current.which]: current.value }));
      return;
    }
    if (drag.type === 'move' && !drag.moved) return;
    updateLayout(layoutNow => settleBlock(layoutNow, current.block));
  };

  const handleWindowMove = useCallback((event: PointerEvent) => onWindowMove.current(event), []);
  const handleWindowUp = useCallback((event: PointerEvent) => onWindowUp.current(event), []);

  useEffect(() => () => {
    window.removeEventListener('pointermove', handleWindowMove);
    window.removeEventListener('pointerup', handleWindowUp);
    window.removeEventListener('pointercancel', handleWindowUp);
  }, [handleWindowMove, handleWindowUp]);

  const startDrag = (event: ReactPointerEvent, state: DragState) => {
    if (!canWrite || event.button > 0) return;
    event.preventDefault();
    dragRef.current = state;
    window.addEventListener('pointermove', handleWindowMove);
    window.addEventListener('pointerup', handleWindowUp);
    window.addEventListener('pointercancel', handleWindowUp);
  };

  const onBlockPointerDown = (event: ReactPointerEvent, block: LayoutBlock) => {
    const wasSelected = selection?.type === 'block' && selection.id === block.id;
    setSelection({ type: 'block', id: block.id });
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    // Op een aanraakscherm kiest de eerste tik het blok; pas een gekozen blok
    // sleept (alleen dat blok heeft touch-action: none). Anders kon je de
    // pagina niet meer scrollen zodra je vinger op een veld begon.
    if (event.pointerType === 'touch' && !wasSelected) return;
    startDrag(event, { type: 'move', id: block.id, startX: event.clientX, startY: event.clientY, origin: block, moved: false });
  };

  const onPalettePointerDown = (event: ReactPointerEvent, item: PaletteItem) => {
    lastPointer.current = event.pointerType;
    // Op een aanraakscherm scrolt een veeg door de lijst; daar voegt tikken toe.
    if (event.pointerType === 'touch') return;
    startDrag(event, { type: 'new', item, startX: event.clientX, startY: event.clientY, active: false });
  };

  /** Klik op een veld in de lijst: alleen voor toetsenbord en touch (de muis voegt toe bij loslaten). */
  const onPaletteClick = (event: { detail: number }, item: PaletteItem) => {
    if (event.detail === 0 || lastPointer.current === 'touch') addFromPalette(item);
    lastPointer.current = '';
  };

  // ── Toetsen ──

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    // Schuiven en verwijderen alleen als een blok de focus heeft; een pijltje in
    // de lijst met velden mag niet stil het gekozen blok verplaatsen.
    if (!selectedBlock || !target.closest('.dle-block')) return;
    if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateBlock(selectedBlock.id); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeBlock(selectedBlock.id); return; }
    if (event.key === 'Escape') { setSelection(null); return; }
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      updateBlock(selectedBlock.id, { x: selectedBlock.x + move[0], y: selectedBlock.y + move[1] }, `pijl:${selectedBlock.id}`);
    }
  };

  // ── Weergave ──

  const sizePx = (pt: number) => round2(pt * scale);
  const ghostName = ghost ? ('field' in ghost.item ? fieldDefinition(ghost.item.field)?.name ?? '' : shapeName(ghost.item.shape)) : '';
  const shownBodyTop = shown.bodyTop;
  const shownFooterTop = shown.footerTop;

  return <div className="dle" onKeyDown={onKeyDown}>
    <div className="dle-toolbar">
      <div className="brand-seg" role="group" aria-label="Welk document">
        <button type="button" aria-pressed={kind === 'invoice'} onClick={() => setKind('invoice')}>Factuur</button>
        <button type="button" aria-pressed={kind === 'quote'} onClick={() => setKind('quote')}>Offerte</button>
      </div>
      <span className={`dle-state${custom ? ' is-custom' : ''}`}>
        {custom ? 'Eigen opmaak' : 'Standaardopmaak'}
      </span>
      <div className="dle-toolbar-actions">
        <Button onClick={undo} disabled={!canWrite || past.length === 0} title="Ongedaan maken (Ctrl+Z)" aria-label="Ongedaan maken"><Undo2 size={14} aria-hidden="true" /></Button>
        <Button onClick={redo} disabled={!canWrite || future.length === 0} title="Opnieuw (Ctrl+Shift+Z)" aria-label="Opnieuw"><Redo2 size={14} aria-hidden="true" /></Button>
        <div className="brand-seg" role="group" aria-label="Weergave">
          <button type="button" aria-pressed={view === 'design'} onClick={() => setView('design')}><LayoutTemplate size={14} aria-hidden="true" /><span>Ontwerpen</span></button>
          <button type="button" aria-pressed={view === 'pdf'} onClick={() => setView('pdf')}><Eye size={14} aria-hidden="true" /><span>PDF-voorbeeld</span></button>
        </div>
      </div>
    </div>

    <div className="dle-grid">
      <aside className="dle-palette" aria-label="Velden">
        <p className="dle-help">Sleep een veld naar de pagina, of klik erop om het toe te voegen.</p>
        {FIELD_GROUPS.map(group => <div key={group.key} className="dle-palette-group">
          <h4>{group.name}</h4>
          <div className="dle-palette-items">
            {DOCUMENT_FIELDS.filter(field => field.group === group.key && (!field.only || field.only === kind)).map(field => {
              const placed = layout.blocks.some(block => block.field === field.key);
              return <button
                key={field.key}
                type="button"
                className={`dle-chip${placed ? ' is-placed' : ''}`}
                title={field.hint}
                disabled={!canWrite}
                onPointerDown={event => onPalettePointerDown(event, { field: field.key })}
                onClick={event => onPaletteClick(event, { field: field.key })}
              >
                {placed && <Check size={12} aria-hidden="true" />}
                <span>{field.key.startsWith('document.') && field.key !== 'document.titel' && field.key !== 'document.gegevens' ? fieldCaption(field.key, kind) : field.name}</span>
              </button>;
            })}
          </div>
        </div>)}
        <div className="dle-palette-group">
          <h4>Tekst en vormen</h4>
          <div className="dle-palette-items">
            {SHAPES.map(item => <button
              key={item.shape}
              type="button"
              className="dle-chip"
              title={item.hint}
              disabled={!canWrite}
              onPointerDown={event => onPalettePointerDown(event, { shape: item.shape })}
              onClick={event => onPaletteClick(event, { shape: item.shape })}
            ><item.Icon size={12} aria-hidden="true" /><span>{item.name}</span></button>)}
          </div>
        </div>
      </aside>

      <section className="dle-stage-wrap" aria-label="De pagina">
        {view === 'design'
          ? <>
            <div className="dle-zoom" role="group" aria-label="Zoomen">
              <Button onClick={() => setZoom(z => Math.max(0.6, round2(z - 0.2)))} aria-label="Kleiner" title="Kleiner"><Minus size={14} aria-hidden="true" /></Button>
              <button type="button" className="dle-zoom-fit" onClick={() => setZoom(1)}>{zoom === 1 ? 'Passend' : `${Math.round(zoom * 100)}%`}</button>
              <Button onClick={() => setZoom(z => Math.min(2.4, round2(z + 0.2)))} aria-label="Groter" title="Groter"><Plus size={14} aria-hidden="true" /></Button>
            </div>
            <div className="dle-stage" ref={stageRef}>
              <div
                ref={pageRef}
                className={`dle-page${canWrite ? '' : ' is-readonly'}`}
                style={{ width: sizePx(PAGE_WIDTH), height: sizePx(PAGE_HEIGHT) }}
                onPointerDown={event => {
                  // De SVG ligt over het hele blad, dus "klik op het blad zelf"
                  // gebeurde nooit: een klik naast een blok, grens of inhoud
                  // heft de keuze nu op.
                  if (!(event.target as HTMLElement).closest('.dle-block, .dle-flow, .dle-divider')) setSelection(null);
                }}
              >
                {plan && measure && page
                  ? <PlanSvg ops={page.ops} style={style} measure={measure} logoUrl={logoUrl} paperUrl={paperIsImage ? form.invoice_template_data_url ?? null : null} />
                  : <div className="dle-loading">Pagina wordt opgebouwd…</div>}
                {hasPaper && !paperIsImage && <div className="dle-paper-note">Je PDF-briefpapier zie je in het PDF-voorbeeld.</div>}

                {/* De inhoud: regels, totalen enzovoort. Loopt door op volgende pagina's. */}
                <div
                  className="dle-zone-body"
                  style={{ top: sizePx(shownBodyTop), height: sizePx(Math.max(0, shownFooterTop - shownBodyTop)) }}
                  aria-hidden="true"
                >
                  <span>Inhoud · loopt door op de volgende pagina</span>
                </div>
                {page?.flow.map(part => <button
                  key={`${part.key}-${part.box.y}`}
                  type="button"
                  className={`dle-flow${selection?.type === 'flow' && selection.key === part.key ? ' is-selected' : ''}`}
                  style={{ left: sizePx(part.box.x), top: sizePx(part.box.y), width: sizePx(part.box.w), height: sizePx(Math.max(8, part.box.h)) }}
                  onClick={() => setSelection({ type: 'flow', key: part.key })}
                  aria-label={`${FLOW_ITEMS.find(item => item.key === part.key)?.name ?? part.key}: instellingen`}
                  title={FLOW_ITEMS.find(item => item.key === part.key)?.name}
                />)}

                {(['bodyTop', 'footerTop'] as const).map(which => <div
                  key={which}
                  className={`dle-divider dle-divider-${which}`}
                  style={{ top: sizePx(which === 'bodyTop' ? shownBodyTop : shownFooterTop) }}
                  onPointerDown={event => startDrag(event, { type: 'divider', which, startY: event.clientY, origin: which === 'bodyTop' ? layout.bodyTop : layout.footerTop })}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={which === 'bodyTop' ? 'Grens tussen kop en inhoud' : 'Grens tussen inhoud en voet'}
                >
                  <span>{which === 'bodyTop' ? 'Kop ↑ · Inhoud ↓' : 'Inhoud ↑ · Voet ↓'}</span>
                </div>)}

                {shown.blocks.map(block => {
                  const box = page?.boxes[block.id] ?? { x: block.x, y: block.y, w: block.w, h: block.h };
                  const selected = selection?.type === 'block' && selection.id === block.id;
                  // Een veld dat in het voorbeeld leeg is (de klant heeft geen
                  // KvK-nummer), toont zijn naam: anders zie je niet waar het staat.
                  const empty = block.type === 'field' && Boolean(page) && !page!.ops.some(op => op.t === 'text' && op.x >= box.x - 2 && op.x <= box.x + box.w + 2 && op.y >= box.y && op.y <= box.y + box.h + 4);
                  return <div
                    key={block.id}
                    className={`dle-block dle-block-${block.type}${selected ? ' is-selected' : ''}${empty ? ' is-empty' : ''}`}
                    style={{ left: sizePx(box.x), top: sizePx(box.y), width: sizePx(box.w), height: sizePx(Math.max(box.h, 6)) }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={selected}
                    aria-label={`${blockName(block, kind)}. Pijltjes om te verplaatsen, Delete om te verwijderen.`}
                    onPointerDown={event => onBlockPointerDown(event, block)}
                    onFocus={() => setSelection({ type: 'block', id: block.id })}
                  >
                    {selected && <span className="dle-block-tag">{blockName(block, kind)}</span>}
                    {empty && <span className="dle-block-empty" style={{ fontSize: Math.max(8, 9 * scale) }}>{blockName(block, kind)} · leeg in dit voorbeeld</span>}
                    {selected && canWrite && <>
                      <span className="dle-handle dle-handle-e" onPointerDown={event => { event.stopPropagation(); startDrag(event, { type: 'resize', id: block.id, edge: 'e', startX: event.clientX, startY: event.clientY, origin: block }); }} aria-hidden="true" />
                      <span className="dle-handle dle-handle-s" onPointerDown={event => { event.stopPropagation(); startDrag(event, { type: 'resize', id: block.id, edge: 's', startX: event.clientX, startY: event.clientY, origin: block }); }} aria-hidden="true" />
                      <span className="dle-handle dle-handle-se" onPointerDown={event => { event.stopPropagation(); startDrag(event, { type: 'resize', id: block.id, edge: 'se', startX: event.clientX, startY: event.clientY, origin: block }); }} aria-hidden="true" />
                    </>}
                  </div>;
                })}

                {guides.map((guide, index) => <span
                  key={index}
                  className={`dle-guide dle-guide-${guide.axis}`}
                  style={guide.axis === 'x' ? { left: sizePx(guide.at) } : { top: sizePx(guide.at) }}
                  aria-hidden="true"
                />)}
              </div>
            </div>
            <p className="dle-help dle-stage-foot">
              Voorbeeld met jouw bedrijfsgegevens en een verzonnen klant. Pijltjestoetsen schuiven een blok precies; Alt houdt slepen los van de hulplijnen.
            </p>
          </>
          : <PdfPreview form={form} layouts={layouts} kind={kind} />}
      </section>

      <aside className="dle-panel" aria-label="Instellingen van de opmaak">
        {selectedBlock
          ? <BlockPanel
            block={selectedBlock}
            kind={kind}
            canWrite={canWrite}
            onChange={(patch, coalesce) => updateBlock(selectedBlock.id, patch, coalesce)}
            onRemove={() => removeBlock(selectedBlock.id)}
            onDuplicate={() => duplicateBlock(selectedBlock.id)}
            onClose={() => setSelection(null)}
          />
          : <DocumentPanel
            form={form}
            setForm={setForm}
            kind={kind}
            layout={layout}
            layouts={layouts}
            custom={Boolean(custom)}
            canWrite={canWrite}
            hasPaper={hasPaper}
            focusFlow={selection?.type === 'flow' ? selection.key : null}
            issues={issues}
            onUpdate={updateLayout}
            onCommit={commitLayouts}
            onFont={setFont}
            onAdd={field => addFromPalette({ field })}
            onLetterheadSelected={onLetterheadSelected}
            onLetterheadRemoved={onLetterheadRemoved}
            onOpenBrand={onOpenBrand}
          />}
      </aside>
    </div>

    {ghost && <div className="dle-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 } as CSSProperties} aria-hidden="true">{ghostName}</div>}
  </div>;
}

// ── Het paneel van één blok ─────────────────────────────────────────────────

function MmField({ label, value, onChange, disabled }: { label: string; value: number; onChange: (pt: number) => void; disabled: boolean }) {
  return <label className="dle-num">
    <span>{label}</span>
    <input
      type="number"
      inputMode="decimal"
      step={0.5}
      value={toMm(value)}
      disabled={disabled}
      onChange={event => {
        const mm = Number(event.target.value.replace(',', '.'));
        if (Number.isFinite(mm)) onChange(round2(mm * PT_PER_MM));
      }}
    />
    <em>mm</em>
  </label>;
}

function Seg<T extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return <div className="dle-field">
    <span className="dle-label">{label}</span>
    <div className="brand-seg" role="group" aria-label={label}>
      {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)} disabled={disabled}>{option.label}</button>)}
    </div>
  </div>;
}

const ALIGN_OPTIONS: Array<{ value: LayoutAlign; label: string }> = [
  { value: 'left', label: 'Links' }, { value: 'center', label: 'Midden' }, { value: 'right', label: 'Rechts' },
];
const TONE_OPTIONS: Array<{ value: LayoutTone; label: string }> = [
  { value: 'text', label: 'Tekst' }, { value: 'muted', label: 'Gedempt' }, { value: 'accent', label: 'Merkkleur' },
];
const LABEL_OPTIONS: Array<{ value: LayoutLabel; label: string }> = [
  { value: 'none', label: 'Geen' }, { value: 'inline', label: 'Ervoor' }, { value: 'above', label: 'Erboven' },
];

function BlockPanel({ block, kind, canWrite, onChange, onRemove, onDuplicate, onClose }: {
  block: LayoutBlock;
  kind: DocumentKind;
  canWrite: boolean;
  onChange: (patch: Partial<LayoutBlock>, coalesce?: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const def = block.type === 'field' ? fieldDefinition(block.field) : null;
  const disabled = !canWrite;
  const isText = block.type === 'field' || block.type === 'text';
  const labelOptions = def && def.shape !== 'text' ? LABEL_OPTIONS.filter(option => option.value !== 'inline') : LABEL_OPTIONS;
  const label = block.label ?? def?.defaults.label ?? 'none';
  return <section className="settings-card dle-card">
    <div className="dle-card-head">
      <div>
        <h3>{blockName(block, kind)}</h3>
        {def && <p className="settings-help">{def.hint}</p>}
      </div>
      <Button onClick={onClose}>Klaar</Button>
    </div>

    <div className="dle-num-grid">
      <MmField label="Links" value={block.x} disabled={disabled} onChange={x => onChange({ x })} />
      <MmField label="Boven" value={block.y} disabled={disabled} onChange={y => onChange({ y })} />
      <MmField label="Breedte" value={block.w} disabled={disabled} onChange={w => onChange({ w })} />
      <MmField label={block.type === 'line' ? 'Ruimte' : 'Hoogte'} value={block.h} disabled={disabled} onChange={h => onChange({ h })} />
    </div>

    {block.type === 'text' && <div className="dle-field">
      <label className="dle-label" htmlFor={`dle-text-${block.id}`}>Tekst</label>
      <Textarea
        id={`dle-text-${block.id}`}
        value={block.text ?? ''}
        maxLength={LAYOUT_LIMITS.text}
        disabled={disabled}
        onChange={event => onChange({ text: event.target.value }, `tekst:${block.id}`)}
      />
      <TokenPicker kind={kind} disabled={disabled} onPick={token => onChange({ text: `${block.text ?? ''}${token}` })} />
    </div>}

    {isText && <>
      <div className="dle-field">
        <span className="dle-label">Lettergrootte</span>
        <div className="dle-size-row">
          <input
            type="range"
            min={LAYOUT_LIMITS.size.min}
            max={32}
            step={0.5}
            value={block.size ?? 0}
            disabled={disabled}
            aria-label="Lettergrootte"
            onChange={event => onChange({ size: Number(event.target.value) || undefined }, `grootte:${block.id}`)}
          />
          <span>{block.size ? `${block.size} pt` : 'Automatisch'}</span>
          {block.size && <button type="button" className="gal-linkbtn" onClick={() => onChange({ size: undefined })} disabled={disabled}>Automatisch</button>}
        </div>
      </div>
      <Seg label="Uitlijnen" value={block.align ?? def?.defaults.align ?? 'left'} options={ALIGN_OPTIONS} disabled={disabled} onChange={align => onChange({ align })} />
      <Seg label="Kleur" value={block.tone ?? def?.defaults.tone ?? 'text'} options={TONE_OPTIONS} disabled={disabled} onChange={tone => onChange({ tone })} />
      <label className="check-row">
        <input type="checkbox" checked={block.bold ?? def?.defaults.bold ?? false} disabled={disabled} onChange={event => onChange({ bold: event.target.checked })} />
        <span>Vet</span>
      </label>
    </>}

    {def && <>
      <Seg label="Label" value={label} options={labelOptions} disabled={disabled} onChange={value => onChange({ label: value })} />
      {label !== 'none' && <div className="dle-field">
        <label className="dle-label" htmlFor={`dle-caption-${block.id}`}>Labeltekst</label>
        <Input
          id={`dle-caption-${block.id}`}
          value={block.caption ?? ''}
          placeholder={fieldCaption(def.key, kind)}
          maxLength={LAYOUT_LIMITS.caption}
          disabled={disabled}
          onChange={event => onChange({ caption: event.target.value || undefined }, `label:${block.id}`)}
        />
      </div>}
      {def.shape !== 'text' && <label className="check-row">
        <input type="checkbox" checked={block.inline ?? false} disabled={disabled} onChange={event => onChange({ inline: event.target.checked })} />
        <span>Op één regel, met een punt ertussen</span>
      </label>}
      {def.shape === 'lines' && <label className="check-row">
        <input type="checkbox" checked={block.firstBold ?? def.defaults.firstBold ?? false} disabled={disabled} onChange={event => onChange({ firstBold: event.target.checked })} />
        <span>Eerste regel vet</span>
      </label>}
    </>}

    {block.type === 'logo' && <Seg label="Uitlijnen" value={block.align ?? 'left'} options={ALIGN_OPTIONS} disabled={disabled} onChange={align => onChange({ align })} />}

    {(block.type === 'line' || block.type === 'box') && <>
      <Seg label="Kleur" value={block.tone ?? 'accent'} options={TONE_OPTIONS} disabled={disabled} onChange={tone => onChange({ tone })} />
      {block.type === 'line'
        ? <div className="dle-field">
          <span className="dle-label">Dikte</span>
          <div className="dle-size-row">
            <input type="range" min={LAYOUT_LIMITS.weight.min} max={4} step={0.25} value={block.weight ?? 0.8} disabled={disabled} aria-label="Dikte van de lijn" onChange={event => onChange({ weight: Number(event.target.value) }, `dikte:${block.id}`)} />
            <span>{(block.weight ?? 0.8).toString().replace('.', ',')} pt</span>
          </div>
        </div>
        : <div className="dle-field">
          <span className="dle-label">Kleursterkte</span>
          <div className="dle-size-row">
            <input type="range" min={LAYOUT_LIMITS.opacity.min} max={1} step={0.02} value={block.opacity ?? 0.12} disabled={disabled} aria-label="Kleursterkte van het vlak" onChange={event => onChange({ opacity: Number(event.target.value) }, `dekking:${block.id}`)} />
            <span>{Math.round((block.opacity ?? 0.12) * 100)}%</span>
          </div>
        </div>}
    </>}

    <div className="dle-card-actions">
      <Button onClick={onDuplicate} disabled={disabled}><Copy size={14} aria-hidden="true" /> Dupliceren</Button>
      <Button variant="danger" onClick={onRemove} disabled={disabled}><Trash2 size={14} aria-hidden="true" /> Verwijderen</Button>
    </div>
  </section>;
}

function TokenPicker({ kind, disabled, onPick }: { kind: DocumentKind; disabled: boolean; onPick: (token: string) => void }) {
  const tokens = useMemo(() => tokenList(kind), [kind]);
  return <Select value="" onChange={event => { if (event.target.value) onPick(event.target.value); }} disabled={disabled} placeholder="Veld invoegen…" searchable>
    <option value="">Veld invoegen…</option>
    {tokens.map(token => <option key={token.token} value={token.token}>{token.name}</option>)}
  </Select>;
}

// ── Het paneel van het document ─────────────────────────────────────────────

function DocumentPanel({
  form, setForm, kind, layout, layouts, custom, canWrite, hasPaper, focusFlow, issues,
  onUpdate, onCommit, onFont, onAdd, onLetterheadSelected, onLetterheadRemoved, onOpenBrand,
}: {
  form: CompanySettingsInput;
  setForm: SetForm;
  kind: DocumentKind;
  layout: DocumentLayout;
  layouts: DocumentLayouts;
  custom: boolean;
  canWrite: boolean;
  hasPaper: boolean;
  focusFlow: LayoutFlowKey | null;
  issues: ReturnType<typeof layoutIssues>;
  onUpdate: (mutate: (current: DocumentLayout) => DocumentLayout, coalesce?: string) => void;
  onCommit: (next: DocumentLayouts, coalesce?: string) => void;
  onFont: (font: LayoutFontChoice) => void;
  onAdd: (field: string) => void;
  onLetterheadSelected: (file: File | undefined) => void;
  onLetterheadRemoved: () => void;
  onOpenBrand: () => void;
}) {
  const disabled = !canWrite;
  const other: DocumentKind = kind === 'invoice' ? 'quote' : 'invoice';
  const flowRef = useRef<HTMLElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (focusFlow) flowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [focusFlow]);

  const choosePreset = (key: LayoutPresetKey) => onCommit({ ...layouts, [kind]: presetLayout(key, kind) });
  const reset = () => {
    if (window.confirm(`De ${kind === 'invoice' ? 'factuur' : 'offerte'} terugzetten op de standaardopmaak van ResoFly? Je eigen opmaak verdwijnt (na Opslaan).`)) {
      onCommit({ ...layouts, [kind]: null });
    }
  };
  const copyToOther = () => {
    const copy = normalizeDocumentLayout(JSON.parse(JSON.stringify(layout)), other);
    // De betaalregel hoort bij een factuur; op een offerte staat hij standaard uit.
    if (copy) onCommit({ ...layouts, [other]: { ...copy, flow: copy.flow.map(item => (item.key === 'payment' ? { ...item, show: other === 'invoice' } : item)) } });
  };
  const setStyle = <K extends keyof CompanySettingsInput>(key: K, value: CompanySettingsInput[K]) => setForm(prev => ({ ...prev, [key]: value }));
  const moveFlow = (index: number, delta: number) => onUpdate(current => {
    const flow = [...current.flow];
    const target = index + delta;
    if (target < 0 || target >= flow.length) return current;
    [flow[index], flow[target]] = [flow[target], flow[index]];
    return { ...current, flow };
  });

  return <div className="dle-panel-stack">
    <section className="settings-card dle-card">
      <h3>Sjabloon</h3>
      <p className="settings-help">
        {custom
          ? `Je ${kind === 'invoice' ? 'facturen' : 'offertes'} gebruiken je eigen opmaak. Begin opnieuw met een sjabloon, of zet hem terug op de standaard.`
          : `Je ${kind === 'invoice' ? 'facturen' : 'offertes'} gebruiken de standaardopmaak van ResoFly. Geen zin om zelf te schuiven? Dan is dit prima zo. Sleep een veld of kies een sjabloon om hem aan te passen.`}
      </p>
      <div className="dle-presets">
        {LAYOUT_PRESETS.map(preset => <button
          key={preset.key}
          type="button"
          className={`dle-preset${layout.preset === preset.key || (!custom && preset.key === 'standaard') ? ' is-active' : ''}`}
          onClick={() => choosePreset(preset.key)}
          disabled={disabled}
        >
          <strong>{preset.name}</strong>
          <small>{preset.hint}</small>
        </button>)}
      </div>
      <div className="dle-card-actions">
        {custom && <Button onClick={reset} disabled={disabled}><RotateCcw size={14} aria-hidden="true" /> Terug naar standaard</Button>}
        <Button onClick={copyToOther} disabled={disabled} title={`Gebruik deze opmaak ook voor je ${other === 'invoice' ? 'facturen' : 'offertes'}`}>
          <Copy size={14} aria-hidden="true" /> Ook voor {other === 'invoice' ? 'facturen' : 'offertes'}
        </Button>
      </div>
    </section>

    <section className="settings-card dle-card">
      <h3>Controle</h3>
      {issues.length === 0
        ? <p className="dle-ok"><Check size={14} aria-hidden="true" /> Alles wat op een {kind === 'invoice' ? 'factuur' : 'offerte'} moet, staat erop.</p>
        : <ul className="dle-issues">
          {issues.map(issue => <li key={issue.id}>
            <CircleAlert size={14} aria-hidden="true" />
            <span>{issue.message}</span>
            <Button onClick={() => onAdd(issue.add[0])} disabled={disabled}>Toevoegen</Button>
          </li>)}
        </ul>}
    </section>

    <section className="settings-card dle-card">
      <h3>Stijl</h3>
      <div className="dle-field">
        <span className="dle-label">Lettertype</span>
        <Select value={layouts.font} onChange={event => onFont(event.target.value as LayoutFontChoice)} disabled={disabled}>
          {FONT_CHOICES.map(font => <option key={font.value} value={font.value}>{font.label}</option>)}
        </Select>
        <p className="settings-help">{FONT_CHOICES.find(font => font.value === layouts.font)?.hint} Een PDF heeft alleen deze drie letters bij zich; je eigen huisstijlletter kan er niet in.</p>
      </div>
      <div className="dle-field">
        <span className="dle-label">Lettergrootte — {form.invoice_font_size ?? 10} pt</span>
        <input
          type="range"
          min={LAYOUT_LIMITS.baseSize.min}
          max={LAYOUT_LIMITS.baseSize.max}
          step={1}
          value={form.invoice_font_size ?? 10}
          disabled={disabled}
          aria-label="Lettergrootte van de tekst"
          onChange={event => setStyle('invoice_font_size', Number(event.target.value))}
        />
      </div>
      <div className="dle-field">
        <label className="dle-label" htmlFor="dle-ink">Tekstkleur</label>
        <div className="brand-color-row">
          <input
            type="color"
            className="brand-color"
            value={/^#[0-9a-f]{6}$/i.test(form.invoice_template_text_color ?? '') ? (form.invoice_template_text_color as string).toLowerCase() : '#1a1a1a'}
            onChange={event => setStyle('invoice_template_text_color', event.target.value.toUpperCase())}
            disabled={disabled}
            aria-label="Tekstkleur kiezen"
          />
          <Input id="dle-ink" value={form.invoice_template_text_color ?? '#1A1A1A'} maxLength={7} disabled={disabled} onChange={event => setStyle('invoice_template_text_color', event.target.value.toUpperCase())} />
        </div>
      </div>
      <div className="dle-field">
        <span className="dle-label">Merkkleur en logo</span>
        <div className="dle-brand-row">
          <span className="brand-locked-dot" style={{ background: form.brand_accent_color || '#FFD966' }} aria-hidden="true" />
          <span>{form.brand_accent_color || '#FFD966'} · {form.brand_logo_data_url ? 'logo ingesteld' : 'nog geen logo'}</span>
          <button type="button" className="gal-linkbtn" onClick={onOpenBrand}>Wijzigen bij Huisstijl</button>
        </div>
        <p className="settings-help">Je merkkleur en logo komen uit Huisstijl, zodat je offertes, facturen, klantportaal en e-mails hetzelfde merk dragen. Een merkkleur die als tekst op wit te licht is, zetten we in de PDF iets donkerder, in dezelfde tint.</p>
      </div>
      <div className="dle-field">
        <span className="dle-label">Briefpapier</span>
        <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg" style={{ display: 'none' }} onChange={event => { onLetterheadSelected(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        <div className="dle-brand-row">
          <span>{hasPaper ? `${form.invoice_template_file_name || 'Briefpapier'} (${form.invoice_template_kind === 'pdf' ? 'PDF' : 'afbeelding'})` : 'Geen briefpapier'}</span>
          <Button onClick={() => fileRef.current?.click()} disabled={disabled}>{hasPaper ? 'Ander bestand' : 'Kiezen'}</Button>
          {hasPaper && <Button variant="ghost" onClick={onLetterheadRemoved} disabled={disabled}>Verwijderen</Button>}
        </div>
        <p className="settings-help">Een A4 als PDF, PNG of JPG; het komt onder elke pagina. Kies dan het sjabloon "Voor briefpapier" of schuif je velden naar de vrije plekken.</p>
      </div>
    </section>

    <section className={`settings-card dle-card${focusFlow ? ' is-focus' : ''}`} ref={flowRef}>
      <h3>Inhoud</h3>
      <p className="settings-help">Wat er onder de kop staat, van boven naar beneden. Dit loopt door op een volgende pagina als het niet past.</p>
      <ol className="dle-flow-list">
        {layout.flow.map((item, index) => {
          const def = FLOW_ITEMS.find(entry => entry.key === item.key)!;
          return <li key={item.key} className={focusFlow === item.key ? 'is-focus' : ''}>
            <div className="dle-flow-row">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={item.show}
                  disabled={disabled || def.required}
                  onChange={event => onUpdate(current => ({ ...current, flow: current.flow.map(entry => (entry.key === item.key ? { ...entry, show: event.target.checked } : entry)) }))}
                />
                <span><strong>{def.name}</strong>{def.required && <em> · altijd</em>}</span>
              </label>
              <span className="dle-flow-move">
                <button type="button" onClick={() => moveFlow(index, -1)} disabled={disabled || index === 0} aria-label={`${def.name} omhoog`}><ArrowUp size={13} aria-hidden="true" /></button>
                <button type="button" onClick={() => moveFlow(index, 1)} disabled={disabled || index === layout.flow.length - 1} aria-label={`${def.name} omlaag`}><ArrowDown size={13} aria-hidden="true" /></button>
              </span>
            </div>
            <small>{def.hint}</small>
            {def.hasText && item.show && <>
              <Textarea
                value={item.text ?? ''}
                maxLength={LAYOUT_LIMITS.text}
                disabled={disabled}
                placeholder={item.key === 'intro' ? 'Beste {{klant.contactpersoon|klant.naam}}, hierbij ontvang je…' : 'Met vriendelijke groet, {{bedrijf.naam}}'}
                onChange={event => onUpdate(current => ({ ...current, flow: current.flow.map(entry => (entry.key === item.key ? { ...entry, text: event.target.value } : entry)) }), `flow:${item.key}`)}
              />
              <TokenPicker kind={kind} disabled={disabled} onPick={token => onUpdate(current => ({ ...current, flow: current.flow.map(entry => (entry.key === item.key ? { ...entry, text: `${entry.text ?? ''}${token}` } : entry)) }))} />
            </>}
            {item.key === 'lines' && <div className="dle-sub">
              <div className="dle-check-grid">
                {([['quantity', 'Aantal'], ['unitPrice', 'Prijs per stuk'], ['vatRate', 'Btw-tarief']] as const).map(([key, label]) => <label key={key} className="check-row">
                  <input type="checkbox" checked={layout.table[key]} disabled={disabled} onChange={event => onUpdate(current => ({ ...current, table: { ...current.table, [key]: event.target.checked } }))} />
                  <span>{label}</span>
                </label>)}
              </div>
              <Seg label="Bedrag per regel" value={layout.table.lineTotals} options={[{ value: 'incl', label: 'Incl. btw' }, { value: 'excl', label: 'Excl. btw' }]} disabled={disabled} onChange={value => onUpdate(current => ({ ...current, table: { ...current.table, lineTotals: value } }))} />
              <Seg<TableStyle> label="Tabel" value={layout.table.style} options={TABLE_STYLES} disabled={disabled} onChange={value => onUpdate(current => ({ ...current, table: { ...current.table, style: value } }))} />
            </div>}
            {item.key === 'totals' && <div className="dle-sub">
              <Seg<TotalsStyle> label="Totaal" value={layout.totalsStyle} options={TOTALS_STYLES} disabled={disabled} onChange={value => onUpdate(current => ({ ...current, totalsStyle: value }))} />
            </div>}
          </li>;
        })}
      </ol>
    </section>

    <section className="settings-card dle-card">
      <h3>Pagina</h3>
      <div className="dle-field">
        <span className="dle-label">Kantlijn — {toMm(layout.marginX)} mm</span>
        <input
          type="range"
          min={LAYOUT_LIMITS.marginX.min}
          max={LAYOUT_LIMITS.marginX.max}
          step={1}
          value={layout.marginX}
          disabled={disabled}
          aria-label="Kantlijn links en rechts van de inhoud"
          onChange={event => onUpdate(current => ({ ...current, marginX: Number(event.target.value) }), 'kantlijn')}
        />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={layout.repeatHeader} disabled={disabled} onChange={event => onUpdate(current => ({ ...current, repeatHeader: event.target.checked }))} />
        <span>De kop op elke pagina herhalen</span>
      </label>
      {!layout.repeatHeader && <div className="dle-field">
        <span className="dle-label">Volgende pagina's beginnen op — {toMm(layout.continueTop)} mm</span>
        <input
          type="range"
          min={LAYOUT_LIMITS.continueTop.min}
          max={LAYOUT_LIMITS.continueTop.max}
          step={2}
          value={layout.continueTop}
          disabled={disabled}
          aria-label="Waar de inhoud op een volgende pagina begint"
          onChange={event => onUpdate(current => ({ ...current, continueTop: Number(event.target.value) }), 'vervolg')}
        />
        <p className="settings-help">Met briefpapier: laat ruimte voor de kop van je papier.</p>
      </div>}
    </section>
  </div>;
}

// ── Het PDF-voorbeeld ───────────────────────────────────────────────────────

/** De echte PDF, met briefpapier: precies wat je klant krijgt (met een verzonnen klant). */
function PdfPreview({ form, layouts, kind }: { form: CompanySettingsInput; layouts: DocumentLayouts; kind: DocumentKind }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'busy' | 'ready' | 'error'>('busy');
  const bytesRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    let cancelled = false;
    setState('busy');
    const handle = window.setTimeout(() => {
      const assets = documentAssetsFromSettings(form);
      renderDocumentPdf(PdfLib, {
        layout: resolveDocumentLayout(layouts, kind, { letterhead: Boolean(assets.letterhead) }),
        data: sampleDocumentData(kind, form),
        style: resolveDocumentStyle(form, layouts.font),
        assets,
        onWarning: (message, error) => console.warn(message, error),
      }).then(bytes => {
        if (cancelled) return;
        bytesRef.current = bytes;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        setUrl(URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' })));
        setState('ready');
      }).catch(error => {
        console.warn('PDF-voorbeeld mislukt', error);
        if (!cancelled) setState('error');
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [form, layouts, kind]);
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return <div className="dle-pdf">
    <div className="dle-pdf-bar">
      <span>{state === 'busy' ? 'PDF wordt bijgewerkt…' : state === 'error' ? 'Het voorbeeld lukte niet.' : 'Zo krijgt je klant hem, met een verzonnen klant.'}</span>
      {url && <a className="btn btn-ghost" href={url} download={documentPdfFileName(kind, kind === 'quote' ? 'voorbeeld-offerte' : 'voorbeeld-factuur')}><Download size={14} aria-hidden="true" /> Download</a>}
    </div>
    {url
      ? <iframe className="dle-pdf-frame" key={url} src={`${url}#toolbar=0&navpanes=0&view=FitH`} title="PDF-voorbeeld van de opmaak" />
      : <div className="dle-loading">{state === 'error' ? 'Het voorbeeld kon niet worden gemaakt.' : 'Voorbeeld wordt gemaakt…'}</div>}
  </div>;
}
