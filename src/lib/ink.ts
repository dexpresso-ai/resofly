/**
 * Handschrift — het inktmodel.
 *
 * Wat je met een pen op een tablet schrijft, bewaren we als vectoren: per
 * pagina een lijst lijnen, elke lijn een platte reeks [x, y, druk, x, y, druk…]
 * in paginacoördinaten. Geen bitmap, dus: scherp op elk scherm, later nog te
 * gummen per lijn, en klein genoeg om als jsonb bij de notitie te bewaren.
 *
 * Alles hier is puur rekenwerk zonder React en zonder DOM-afhankelijkheid,
 * zodat het rechtstreeks onder de Node-testrunner draait (`npm test`). Tekenen
 * gebeurt via een smalle context-interface (`InkContext`) die een echte
 * CanvasRenderingContext2D vanzelf vervult — en een test kan naspelen.
 *
 * Kleuren zijn sleutels, geen hex: "inkt" is donker op licht papier en licht op
 * donker papier. Zo blijft één opgeslagen handschrift leesbaar in beide thema's.
 */

export const INK_VERSION = 1 as const;
/** Logische paginabreedte. De hoogte volgt de A4-verhouding (1 : √2). */
export const INK_PAGE_WIDTH = 1000;
export const INK_PAGE_HEIGHT = 1414;
/** Bovengrens per notitie, in tekens JSON. De database weigert boven 6 MB; wij eerder. */
export const INK_MAX_JSON_LENGTH = 4_000_000;

export type InkPaper = 'blank' | 'lined' | 'dotted' | 'grid';
export type InkStrokeTool = 'pen' | 'highlighter';
export type InkTool = InkStrokeTool | 'eraser';
export type InkColorKey = 'ink' | 'blue' | 'red' | 'green' | 'gold' | 'purple';
export type InkTheme = 'dark' | 'light';

export interface InkStroke {
  id: string;
  tool: InkStrokeTool;
  color: InkColorKey;
  /** Basisdikte in paginapunten; de druk moduleert eromheen. */
  width: number;
  /** Platte reeks [x, y, druk, x, y, druk, …]; druk 0..1. */
  points: number[];
}

export interface InkPage {
  id: string;
  paper: InkPaper;
  strokes: InkStroke[];
}

export interface InkDocument {
  version: typeof INK_VERSION;
  width: number;
  height: number;
  pages: InkPage[];
}

export interface InkPoint { x: number; y: number; p: number }

export const INK_PAPERS: { value: InkPaper; label: string }[] = [
  { value: 'lined', label: 'Gelinieerd' },
  { value: 'dotted', label: 'Stippen' },
  { value: 'grid', label: 'Ruitjes' },
  { value: 'blank', label: 'Blanco' },
];

/** Kleur per thema: op licht papier verzadigd en donker, op donker papier licht. */
export const INK_COLORS: { key: InkColorKey; label: string; light: string; dark: string }[] = [
  { key: 'ink', label: 'Inkt', light: '#1A1710', dark: '#F4F1EA' },
  { key: 'blue', label: 'Blauw', light: '#1D4ED8', dark: '#7CC2FF' },
  { key: 'red', label: 'Rood', light: '#B91C1C', dark: '#FF7B7B' },
  { key: 'green', label: 'Groen', light: '#15803D', dark: '#4FCB92' },
  { key: 'gold', label: 'Goud', light: '#9A6B00', dark: '#FFD966' },
  { key: 'purple', label: 'Paars', light: '#6D28D9', dark: '#BBA2FF' },
];

export const INK_PEN_WIDTHS: { value: number; label: string }[] = [
  { value: 2.2, label: 'Fijn' },
  { value: 3.6, label: 'Normaal' },
  { value: 5.6, label: 'Dik' },
];
export const INK_HIGHLIGHTER_WIDTH = 24;
export const INK_ERASER_RADIUS = 14;
/** Druk voor invoer zonder drukgevoeligheid (muis, vinger, oudere pennen). */
export const INK_DEFAULT_PRESSURE = 0.5;

const COLOR_KEYS = new Set<InkColorKey>(INK_COLORS.map(c => c.key));
const PAPERS = new Set<InkPaper>(INK_PAPERS.map(p => p.value));

// ── Aanmaken en lezen ──────────────────────────────────────────────────────

let idCounter = 0;
/** Korte unieke id zonder afhankelijkheid van crypto (werkt ook in oudere WebViews). */
export function inkId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createInkPage(paper: InkPaper = 'lined'): InkPage {
  return { id: inkId(), paper, strokes: [] };
}

export function createInkDocument(paper: InkPaper = 'lined'): InkDocument {
  return { version: INK_VERSION, width: INK_PAGE_WIDTH, height: INK_PAGE_HEIGHT, pages: [createInkPage(paper)] };
}

export function inkStrokeCount(doc: InkDocument | null | undefined): number {
  if (!doc) return 0;
  return doc.pages.reduce((sum, page) => sum + page.strokes.length, 0);
}

/** Pagina's die daadwerkelijk iets bevatten. Een lege eerste pagina telt niet mee. */
export function inkPageCount(doc: InkDocument | null | undefined): number {
  if (!doc) return 0;
  return doc.pages.filter(page => page.strokes.length > 0).length;
}

export function isInkEmpty(doc: InkDocument | null | undefined): boolean {
  return inkStrokeCount(doc) === 0;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseStroke(raw: unknown): InkStroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const points: number[] = [];
  if (Array.isArray(r.points)) {
    for (let i = 0; i + 2 < r.points.length; i += 3) {
      const x = num(r.points[i], NaN);
      const y = num(r.points[i + 1], NaN);
      const p = num(r.points[i + 2], INK_DEFAULT_PRESSURE);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push(x, y, Math.min(1, Math.max(0, p)));
    }
  }
  if (points.length === 0) return null;
  const tool: InkStrokeTool = r.tool === 'highlighter' ? 'highlighter' : 'pen';
  const color = COLOR_KEYS.has(r.color as InkColorKey) ? (r.color as InkColorKey) : 'ink';
  const width = Math.min(60, Math.max(0.5, num(r.width, tool === 'highlighter' ? INK_HIGHLIGHTER_WIDTH : INK_PEN_WIDTHS[1].value)));
  return { id: typeof r.id === 'string' && r.id ? r.id : inkId(), tool, color, width, points };
}

/**
 * Leest een opgeslagen inktdocument defensief: onbekende velden vallen weg,
 * kapotte lijnen worden overgeslagen, en wat er niet uitziet als een document
 * wordt een leeg document. Zo kan een oud of half opgeslagen record de editor
 * nooit laten crashen.
 */
export function parseInkDocument(raw: unknown, fallbackPaper: InkPaper = 'lined'): InkDocument {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (!value || typeof value !== 'object') return createInkDocument(fallbackPaper);
  const r = value as Record<string, unknown>;
  const width = Math.max(100, num(r.width, INK_PAGE_WIDTH));
  const height = Math.max(100, num(r.height, INK_PAGE_HEIGHT));
  const pages: InkPage[] = [];
  if (Array.isArray(r.pages)) {
    for (const rawPage of r.pages) {
      if (!rawPage || typeof rawPage !== 'object') continue;
      const p = rawPage as Record<string, unknown>;
      const strokes = Array.isArray(p.strokes)
        ? (p.strokes.map(parseStroke).filter((s): s is InkStroke => s !== null))
        : [];
      pages.push({
        id: typeof p.id === 'string' && p.id ? p.id : inkId(),
        paper: PAPERS.has(p.paper as InkPaper) ? (p.paper as InkPaper) : fallbackPaper,
        strokes,
      });
    }
  }
  if (pages.length === 0) pages.push(createInkPage(fallbackPaper));
  return { version: INK_VERSION, width, height, pages };
}

/** Compacte JSON-vorm voor opslag: coördinaten op één decimaal, druk op twee. */
export function serializeInkDocument(doc: InkDocument): InkDocument {
  return {
    version: INK_VERSION,
    width: doc.width,
    height: doc.height,
    pages: doc.pages.map(page => ({
      id: page.id,
      paper: page.paper,
      strokes: page.strokes.map(stroke => ({
        id: stroke.id,
        tool: stroke.tool,
        color: stroke.color,
        width: Math.round(stroke.width * 10) / 10,
        points: compactPoints(stroke.points),
      })),
    })),
  };
}

function compactPoints(points: number[]): number[] {
  const out = new Array<number>(points.length);
  for (let i = 0; i < points.length; i += 3) {
    out[i] = Math.round(points[i] * 10) / 10;
    out[i + 1] = Math.round(points[i + 1] * 10) / 10;
    out[i + 2] = Math.round(points[i + 2] * 100) / 100;
  }
  return out;
}

/** Klopt deze structuur, en past hij binnen de opslaggrens? Geeft de reden terug als het niet past. */
export function inkSizeIssue(doc: InkDocument): string | null {
  const length = JSON.stringify(serializeInkDocument(doc)).length;
  if (length > INK_MAX_JSON_LENGTH) {
    return 'Dit handschrift is te groot om op te slaan. Verdeel het over meerdere notities of gum wat weg.';
  }
  return null;
}

// ── Punten en lijnen ───────────────────────────────────────────────────────

export function pointsFromFlat(points: number[]): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    out.push({ x: points[i], y: points[i + 1], p: points[i + 2] });
  }
  return out;
}

/**
 * Laat punten weg die (vrijwel) op hun voorganger liggen. Een pen levert
 * honderden samples per seconde; op een stilstaande hand zijn dat tientallen
 * identieke punten. Het eerste en laatste punt blijven altijd staan.
 */
export function simplifyPoints(points: number[], minDistance = 0.8): number[] {
  if (points.length <= 3) return points.slice();
  const out: number[] = [points[0], points[1], points[2]];
  let lastX = points[0];
  let lastY = points[1];
  const minSq = minDistance * minDistance;
  for (let i = 3; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const dx = x - lastX;
    const dy = y - lastY;
    const isLast = i + 3 >= points.length;
    if (dx * dx + dy * dy < minSq && !isLast) continue;
    out.push(x, y, points[i + 2]);
    lastX = x;
    lastY = y;
  }
  return out;
}

export interface InkBounds { minX: number; minY: number; maxX: number; maxY: number }

export function strokeBounds(stroke: InkStroke): InkBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < stroke.points.length; i += 3) {
    const x = stroke.points[i];
    const y = stroke.points[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = stroke.width;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Afstand van een punt tot een lijnstuk. */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = 0;
  if (lengthSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Raakt een cirkel (gum) deze lijn? Kijkt naar de lijnstukken, niet alleen de samples. */
export function strokeHits(stroke: InkStroke, x: number, y: number, radius: number): boolean {
  const reach = radius + stroke.width / 2;
  const pts = stroke.points;
  if (pts.length < 3) return false;
  if (pts.length === 3) return Math.hypot(pts[0] - x, pts[1] - y) <= reach;
  const b = strokeBounds(stroke);
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) return false;
  for (let i = 3; i < pts.length; i += 3) {
    if (distanceToSegment(x, y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1]) <= reach) return true;
  }
  return false;
}

/** Gumt lijnen weg die het gum-pad raken. Geeft dezelfde pagina terug als er niets raakt. */
export function eraseAt(page: InkPage, x: number, y: number, radius = INK_ERASER_RADIUS): InkPage {
  const kept = page.strokes.filter(stroke => !strokeHits(stroke, x, y, radius));
  if (kept.length === page.strokes.length) return page;
  return { ...page, strokes: kept };
}

/** Gumt langs een lijnstuk (van het vorige naar het huidige gumpunt), zodat snel bewegen geen gaten laat. */
export function eraseAlong(page: InkPage, fromX: number, fromY: number, toX: number, toY: number, radius = INK_ERASER_RADIUS): InkPage {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius)));
  let current = page;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    current = eraseAt(current, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, radius);
  }
  return current;
}

// ── Tekenen ────────────────────────────────────────────────────────────────

/** Het stukje CanvasRenderingContext2D dat we gebruiken — zodat tests kunnen meespelen. */
export interface InkContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
}

export interface InkPaperColors { paper: string; line: string; margin: string }

export function inkPaperColors(theme: InkTheme): InkPaperColors {
  return theme === 'light'
    ? { paper: '#FBF8F1', line: 'rgba(26,23,16,0.13)', margin: 'rgba(163,42,48,0.28)' }
    : { paper: '#1C1A16', line: 'rgba(246,244,239,0.10)', margin: 'rgba(255,123,123,0.30)' };
}

export function inkColorHex(key: InkColorKey, theme: InkTheme): string {
  const entry = INK_COLORS.find(c => c.key === key) ?? INK_COLORS[0];
  return theme === 'light' ? entry.light : entry.dark;
}

/** Lijnafstand van het papier in paginapunten (~7 mm op A4). */
export const INK_LINE_SPACING = 34;

/** Tekent het papier (achtergrond + liniatuur) op schaal `scale` (schermpixels per paginapunt). */
export function drawPaper(ctx: InkContext, paper: InkPaper, width: number, height: number, scale: number, theme: InkTheme): void {
  const colors = inkPaperColors(theme);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, width * scale, height * scale);
  const spacing = INK_LINE_SPACING * scale;
  const top = INK_LINE_SPACING * 2 * scale;
  const left = INK_LINE_SPACING * 1.5 * scale;
  ctx.strokeStyle = colors.line;
  ctx.fillStyle = colors.line;
  ctx.lineWidth = Math.max(0.6, scale * 0.8);
  if (paper === 'lined') {
    ctx.beginPath();
    for (let y = top; y < height * scale; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(width * scale, y);
    }
    ctx.stroke();
    ctx.strokeStyle = colors.margin;
    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.lineTo(left, height * scale);
    ctx.stroke();
  } else if (paper === 'grid') {
    ctx.beginPath();
    for (let y = spacing; y < height * scale; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(width * scale, y);
    }
    for (let x = spacing; x < width * scale; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height * scale);
    }
    ctx.stroke();
  } else if (paper === 'dotted') {
    const radius = Math.max(0.9, scale * 1.4);
    for (let y = spacing; y < height * scale; y += spacing) {
      for (let x = spacing; x < width * scale; x += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** Lijndikte op een punt: de druk moduleert tussen ruim de helft en anderhalf keer de basis. */
export function strokeWidthAt(stroke: InkStroke, pressure: number): number {
  if (stroke.tool === 'highlighter') return stroke.width;
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : INK_DEFAULT_PRESSURE;
  return stroke.width * (0.55 + 0.95 * p);
}

/**
 * Verdicht een schaarse puntenreeks (muis, trage sampling) langs een
 * centripetale Catmull-Rom-spline, zodat ook een handvol punten een vloeiende
 * boog wordt. Centripetaal (α = ½) in plaats van uniform: die variant maakt
 * geen lussen of pieken bij ongelijke afstanden tussen de samples. Dichte
 * peninvoer blijft ongemoeid: alleen lange segmenten krijgen tussenpunten.
 */
export function densifyPoints(pts: InkPoint[], maxSegment = 6): InkPoint[] {
  if (pts.length < 3) return pts;
  const alpha = 0.5;
  const knot = (a: InkPoint, b: InkPoint, from: number) => from + Math.max(1e-4, Math.pow(Math.hypot(b.x - a.x, b.y - a.y), alpha));
  const out: InkPoint[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.min(24, Math.ceil(length / maxSegment));
    if (steps > 1) {
      const t0 = 0;
      const t1 = knot(p0, p1, t0);
      const t2 = knot(p1, p2, t1);
      const t3 = knot(p2, p3, t2);
      for (let s = 1; s < steps; s += 1) {
        const t = t1 + (t2 - t1) * (s / steps);
        const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
        const a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y;
        const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
        const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
        const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
        const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;
        const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
        const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
        const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
        const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
        const x = ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x;
        const y = ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y;
        out.push({ x, y, p: p1.p + (p2.p - p1.p) * (s / steps) });
      }
    }
    out.push(p2);
  }
  return out;
}

/**
 * Bouwt de vorm van een lijn met variabele dikte als één pad: per punt een
 * cirkel (ronde verbinding én ronde uiteinden) en per segment een trapezium
 * tussen de linker- en rechterrand. Alles in dezelfde draairichting, zodat de
 * nonzero-vulling de overlappende delen samenvoegt zonder gaten of pieken —
 * ook bij scherpe hoeken, waar een doorlopende omtrek zichzelf zou kruisen.
 * Eén `fill()` tekent het geheel, dus een doorzichtige marker blijft egaal.
 */
export function traceStrokeOutline(ctx: InkContext, stroke: InkStroke, scale: number): void {
  const raw = pointsFromFlat(stroke.points);
  if (raw.length === 0) return;
  ctx.beginPath();
  if (raw.length === 1) {
    const r = Math.max(0.4, strokeWidthAt(stroke, raw[0].p) / 2 * scale);
    ctx.moveTo(raw[0].x * scale + r, raw[0].y * scale);
    ctx.arc(raw[0].x * scale, raw[0].y * scale, r, 0, Math.PI * 2, false);
    ctx.closePath();
    return;
  }

  const pts = densifyPoints(raw);
  // Druk uitmiddelen over de buren: een pen "hapert" anders zichtbaar.
  const radii = pts.map((pt, i) => {
    const prev = pts[Math.max(0, i - 1)].p;
    const next = pts[Math.min(pts.length - 1, i + 1)].p;
    const p = (prev + pt.p * 2 + next) / 4;
    return Math.max(0.35, strokeWidthAt(stroke, p) / 2) * scale;
  });

  for (let i = 0; i < pts.length; i += 1) {
    const cx = pts[i].x * scale;
    const cy = pts[i].y * scale;
    ctx.moveTo(cx + radii[i], cy);
    ctx.arc(cx, cy, radii[i], 0, Math.PI * 2, false);
    ctx.closePath();
  }

  for (let i = 0; i < pts.length - 1; i += 1) {
    const ax = pts[i].x * scale;
    const ay = pts[i].y * scale;
    const bx = pts[i + 1].x * scale;
    const by = pts[i + 1].y * scale;
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    dx /= len;
    dy /= len;
    const nx = -dy;
    const ny = dx;
    const ra = radii[i];
    const rb = radii[i + 1];
    // Hoekpunten: linkerrand heen, rechterrand terug. Dezelfde draairichting
    // als de cirkels (positieve oppervlakte in schermcoördinaten), anders
    // heffen de windingen elkaar op en valt er een gat in de overlap.
    let quad = [
      [ax + nx * ra, ay + ny * ra],
      [bx + nx * rb, by + ny * rb],
      [bx - nx * rb, by - ny * rb],
      [ax - nx * ra, ay - ny * ra],
    ];
    let area = 0;
    for (let k = 0; k < 4; k += 1) {
      const [x1, y1] = quad[k];
      const [x2, y2] = quad[(k + 1) % 4];
      area += x1 * y2 - x2 * y1;
    }
    if (area < 0) quad = quad.reverse();
    ctx.moveTo(quad[0][0], quad[0][1]);
    ctx.lineTo(quad[1][0], quad[1][1]);
    ctx.lineTo(quad[2][0], quad[2][1]);
    ctx.lineTo(quad[3][0], quad[3][1]);
    ctx.closePath();
  }
}

export function drawStroke(ctx: InkContext, stroke: InkStroke, scale: number, theme: InkTheme): void {
  if (stroke.points.length < 3) return;
  ctx.save();
  ctx.fillStyle = inkColorHex(stroke.color, theme);
  ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.38 : 1;
  traceStrokeOutline(ctx, stroke, scale);
  ctx.fill();
  ctx.restore();
}

export function drawPage(ctx: InkContext, doc: InkDocument, page: InkPage, scale: number, theme: InkTheme, withPaper = true): void {
  if (withPaper) drawPaper(ctx, page.paper, doc.width, doc.height, scale, theme);
  // Markeerstift onder de pen: zo blijft de tekst erdoorheen leesbaar, zoals op papier.
  for (const stroke of page.strokes) if (stroke.tool === 'highlighter') drawStroke(ctx, stroke, scale, theme);
  for (const stroke of page.strokes) if (stroke.tool !== 'highlighter') drawStroke(ctx, stroke, scale, theme);
}

// ── Browserhulpjes (alleen aanroepen waar een DOM is) ───────────────────────

export interface RenderOptions { scale?: number; theme?: InkTheme; withPaper?: boolean }

/** Rendert één pagina naar een nieuw canvas (voor miniaturen en PNG-export). */
export function renderPageToCanvas(doc: InkDocument, page: InkPage, options: RenderOptions = {}): HTMLCanvasElement {
  const scale = options.scale ?? 1;
  const theme = options.theme ?? 'light';
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(doc.width * scale));
  canvas.height = Math.max(1, Math.round(doc.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx) drawPage(ctx, doc, page, scale, theme, options.withPaper ?? true);
  return canvas;
}

/**
 * Miniatuur van de eerste pagina met inhoud, als data-URL. Klein genoeg voor
 * een kaartje (standaard 220 px breed), en in het thema van het scherm.
 */
export function inkThumbnailDataUrl(doc: InkDocument, theme: InkTheme, width = 220): string | null {
  const page = doc.pages.find(p => p.strokes.length > 0) ?? null;
  if (!page) return null;
  const scale = width / doc.width;
  const canvas = renderPageToCanvas(doc, page, { scale, theme, withPaper: true });
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** Alle pagina's met inhoud als PNG-blobs (voor download of als bijlage). */
export async function inkPagesToPngBlobs(doc: InkDocument, theme: InkTheme = 'light', scale = 2): Promise<Blob[]> {
  const pages = doc.pages.filter(p => p.strokes.length > 0);
  const blobs: Blob[] = [];
  for (const page of pages) {
    const canvas = renderPageToCanvas(doc, page, { scale, theme, withPaper: true });
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob) blobs.push(blob);
  }
  return blobs;
}
