import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { STATIONS, clientPosition, type Stream, type StreamItem, type StationId } from '../lib/stroom';

/**
 * De stroom op Vandaag (Stroom, designvoorstel 2026-10-30): van een offerte in
 * de maak tot een betaalde factuur als één lichtband. Links koel maanlicht,
 * rechts zongoud. De dikte is het bedrag per halte, de strepen zijn de
 * richting, de poel rechts is wat er deze maand binnenkwam.
 *
 * Het canvas tekent alleen licht. De haltes en de kralen zijn echte knoppen
 * erboven: met de muis, het toetsenbord en een schermlezer te gebruiken.
 * Bij minder beweging staat de band stil (één beeld); buiten beeld en in een
 * verborgen tabblad tekent hij niet.
 */

type Rgb = [number, number, number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgba = (c: Rgb, a: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
function toRgb(value: string): Rgb {
  let hex = value.trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = Number.parseInt(hex.slice(0, 6) || '0', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const eur = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const eurShort = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** € 4.452,80 met de centen een tikje kleiner. */
export function Amount({ value, short = false }: { value: number; short?: boolean }) {
  if (short) return <span className="sl-amt">{eurShort.format(Math.floor(value))}</span>;
  const text = eur.format(value);
  const match = /^(.*\d)(,\d{2})$/.exec(text);
  return <span className="sl-amt">{match ? <>{match[1]}<small>{match[2]}</small></> : text}</span>;
}

interface Geometry {
  width: number;
  height: number;
  stX: (i: number) => number;
  thickAt: (i: number) => number;
  thick: (x: number) => number;
  yAt: (x: number, t: number) => number;
}

function geometry(width: number, height: number, totals: number[], mini: boolean): Geometry {
  const n = totals.length;
  const pad = width < 560 ? 0.1 : 0.085;
  const stX = (i: number) => pad * width + i * (width - 2 * pad * width) / (n - 1);
  const yMid = height * 0.7;
  const tMax = mini ? Math.min(30, height * 0.36) : Math.min(64, height * 0.3);
  const tMin = mini ? 5 : 9;
  const vMax = Math.max(...totals, 1);
  const thickAt = (i: number) => tMin + (tMax - tMin) * Math.sqrt(Math.max(0, totals[i]) / vMax);
  const smooth = (k: number) => k * k * (3 - 2 * k);
  const thick = (x: number) => {
    const x0 = stX(0), xn = stX(n - 1);
    if (x <= x0) return lerp(tMin * 0.5, thickAt(0), smooth(Math.max(0, x / x0)));
    if (x >= xn) return lerp(thickAt(n - 1), thickAt(n - 1) * 1.25, Math.min(1, (x - xn) / Math.max(1, width - xn)));
    const seg = (x - x0) / ((xn - x0) / (n - 1));
    const i = Math.floor(seg);
    return lerp(thickAt(i), thickAt(Math.min(n - 1, i + 1)), smooth(seg - i));
  };
  const yAt = (x: number, t: number) => yMid
    + Math.sin(x / width * Math.PI * 2.1 + t * 0.45) * height * 0.018
    + Math.sin(x / width * Math.PI * 5.3 - t * 0.3) * height * 0.006;
  return { width, height, stX, thickAt, thick, yAt };
}

const KNOT_TEXT: Record<string, string> = { late: 'te laat', wait: 'wacht', sent: 'opgevolgd' };

export function StreamRibbon({ stream, monthLabel, mini = false, sparkIds, onPick, onStation, onHover, label = 'De stroom: van offerte tot betaald' }: {
  stream: Stream;
  /** "oktober": onder Betaald. */
  monthLabel: string;
  /** De smalle stroom van de telefoon: korte bedragen, kleinere kralen. */
  mini?: boolean;
  /** Stukken waarvoor Gerrie iets klaar heeft staan (een kaart op de stapel). */
  sparkIds?: ReadonlySet<string>;
  onPick?: (item: StreamItem) => void;
  onStation?: (id: StationId) => void;
  onHover?: (item: StreamItem | null) => void;
  label?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tip, setTip] = useState<{ item: StreamItem; x: number; y: number } | null>(null);
  // Op waarde vergelijken: na elke verversing is de stroom een nieuw object, en
  // de band hoort dan niet opnieuw te beginnen als de bedragen gelijk bleven.
  const totalsKey = stream.stations.map(station => station.amount.toFixed(2)).join('|');
  const totals = useMemo(() => totalsKey.split('|').map(Number), [totalsKey]);
  const geo = useMemo(() => geometry(size.width || 10, size.height || 10, totals, mini), [size, totals, mini]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setSize({ width: Math.max(10, host.clientWidth), height: Math.max(10, host.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // ── Het licht ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || !size.width) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);

    const style = getComputedStyle(host);
    const f1 = toRgb(style.getPropertyValue('--flow-1') || '#AEB6D0');
    const f2 = toRgb(style.getPropertyValue('--flow-2') || '#F7C548');
    const body = Number.parseFloat(style.getPropertyValue('--flow-body')) || 0.16;
    const edge = Number.parseFloat(style.getPropertyValue('--flow-edge')) || 0.55;
    const day = document.documentElement.getAttribute('data-theme') === 'light';
    const add: GlobalCompositeOperation = day ? 'source-over' : 'lighter';

    const W = size.width, H = size.height;
    const streaks = Array.from({ length: mini ? 34 : 78 }, () => ({ x: Math.random(), l: (Math.random() - 0.5) * 1.7, v: 0.035 + Math.random() * 0.05, len: 0.02 + Math.random() * 0.05, a: 0.35 + Math.random() * 0.65 }));
    const dust = Array.from({ length: mini ? 10 : 26 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: 0.1 + Math.random() * 0.25, s: 0.6 + Math.random() * 1.4 }));
    const t0 = performance.now();
    let raf = 0;
    let visible = true;
    let last = 0;

    const colAt = (x: number) => {
      const g = geoRef.current;
      const k = Math.max(0, Math.min(1, (x - g.stX(0) * 0.4) / (W - g.stX(0) * 0.4)));
      return mix3(f1, f2, k * k * (3 - 2 * k) * 0.92 + k * 0.08);
    };

    function frame(now: number, still: boolean) {
      const g = geoRef.current;
      const t = still ? 0 : (now - t0) / 1000;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, W, H);
      const step = Math.max(3, W / 260);
      const top: [number, number][] = [];
      const bottom: [number, number][] = [];
      for (let x = 0; x <= W + step; x += step) {
        const y = g.yAt(x, t), h = g.thick(x) / 2;
        top.push([x, y - h]);
        bottom.push([x, y + h]);
      }
      const grad = ctx!.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, rgba(f1, 1));
      grad.addColorStop(0.45, rgba(mix3(f1, f2, 0.45), 1));
      grad.addColorStop(1, rgba(f2, 1));
      const ribbon = (k: number) => {
        ctx!.beginPath();
        top.forEach(([x, y], i) => { const c = g.yAt(x, t); const yy = c + (y - c) * k; if (i) ctx!.lineTo(x, yy); else ctx!.moveTo(x, yy); });
        for (let i = bottom.length - 1; i >= 0; i--) { const [x, y] = bottom[i]; const c = g.yAt(x, t); ctx!.lineTo(x, c + (y - c) * k); }
        ctx!.closePath();
      };
      // Lichaam: drie lagen, van breed en zacht naar smal en helder.
      ctx!.globalCompositeOperation = add;
      ctx!.fillStyle = grad;
      for (const [k, a] of [[1, body * 0.8], [0.62, body * 0.9], [0.26, body * 1.3]]) { ctx!.globalAlpha = a; ribbon(k); ctx!.fill(); }
      // Randen en kern.
      ctx!.strokeStyle = grad;
      ctx!.lineWidth = 1;
      ctx!.globalAlpha = edge * 0.55;
      ctx!.beginPath(); top.forEach(([x, y], i) => (i ? ctx!.lineTo(x, y) : ctx!.moveTo(x, y))); ctx!.stroke();
      ctx!.globalAlpha = edge * 0.3;
      ctx!.beginPath(); bottom.forEach(([x, y], i) => (i ? ctx!.lineTo(x, y) : ctx!.moveTo(x, y))); ctx!.stroke();
      ctx!.globalAlpha = day ? 0.5 : 0.55;
      ctx!.lineWidth = day ? 1.4 : 1.2;
      ctx!.beginPath(); top.forEach(([x], i) => { const y = g.yAt(x, t); if (i) ctx!.lineTo(x, y); else ctx!.moveTo(x, y); }); ctx!.stroke();

      // Strepen: de richting van de stroom.
      ctx!.lineCap = 'round';
      for (const s of streaks) {
        if (!still) { s.x += s.v / 60; if (s.x > 1.08) { s.x = -0.08; s.l = (Math.random() - 0.5) * 1.7; } }
        const x1 = s.x * W, x0 = x1 - s.len * W;
        const y1 = g.yAt(x1, t) + g.thick(Math.max(0, x1)) / 2 * s.l * 0.82;
        const y0 = g.yAt(x0, t) + g.thick(Math.max(0, x0)) / 2 * s.l * 0.82;
        const c = colAt(x1);
        const sg = ctx!.createLinearGradient(x0, y0, x1, y1);
        sg.addColorStop(0, rgba(c, 0));
        sg.addColorStop(1, rgba(c, (day ? 0.75 : 0.9) * s.a));
        ctx!.globalAlpha = 1;
        ctx!.strokeStyle = sg;
        ctx!.lineWidth = day ? 1.4 : 1.3;
        ctx!.beginPath(); ctx!.moveTo(x0, y0); ctx!.lineTo(x1, y1); ctx!.stroke();
      }
      // Een zachte gloed op elke halte.
      STATIONS.forEach((_, i) => {
        const x = g.stX(i), y = g.yAt(x, t), r = g.thick(x) * 0.9 + 10;
        const c = colAt(x);
        const rg = ctx!.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, rgba(c, day ? 0.22 : 0.28));
        rg.addColorStop(1, rgba(c, 0));
        ctx!.globalAlpha = 1; ctx!.fillStyle = rg;
        ctx!.beginPath(); ctx!.arc(x, y, r, 0, Math.PI * 2); ctx!.fill();
      });
      // De poel: wat binnen is, ademt goud.
      const end = STATIONS.length - 1;
      const px = g.stX(end), py = g.yAt(px, t);
      const breathe = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.3);
      const pr = g.thickAt(end) * 1.6 + 26;
      const pg = ctx!.createRadialGradient(px, py, 0, px, py, pr);
      pg.addColorStop(0, rgba(f2, (day ? 0.28 : 0.32) + breathe * 0.06));
      pg.addColorStop(1, rgba(f2, 0));
      ctx!.fillStyle = pg;
      ctx!.beginPath(); ctx!.arc(px, py, pr, 0, Math.PI * 2); ctx!.fill();
      for (const d of dust) {
        if (!still) d.a += d.v / 60;
        const rr = (g.thickAt(end) * 0.45 + 8) * (0.4 + d.r * 0.8);
        ctx!.fillStyle = rgba(f2, day ? 0.7 : 0.85);
        ctx!.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(d.a * 2 + d.r * 6));
        ctx!.beginPath(); ctx!.arc(px + Math.cos(d.a) * rr * 1.5, py + Math.sin(d.a) * rr * 0.55, d.s * (mini ? 0.7 : 1), 0, Math.PI * 2); ctx!.fill();
      }
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = 'source-over';
    }

    function loop(now: number) {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      if (now - last < 32) return; // ± 30 beelden per seconde
      last = now;
      frame(now, false);
    }
    if (reducedMotion()) frame(performance.now(), true);
    else raf = requestAnimationFrame(loop);

    const io = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; });
    io.observe(host);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [size, mini, totals]);

  // De kleuren van de band staan in de tokens: bij Dag en Nacht opnieuw lezen.
  const [themeKey, setThemeKey] = useState(0);
  useEffect(() => {
    const watch = new MutationObserver(() => setThemeKey(k => k + 1));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);
  useEffect(() => { if (themeKey) setSize(s => ({ ...s })); }, [themeKey]);

  // ── De kralen ──────────────────────────────────────────────────────────
  const cap = mini ? 5 : 8;
  const spacing = (geo.width - 2 * (geo.width < 560 ? 0.1 : 0.085) * geo.width) / (STATIONS.length - 1);
  const beads = stream.stations.flatMap((station, i) => {
    const shown = station.items.slice(-cap);
    const n = shown.length;
    const gap = Math.min(mini ? 13 : 30, spacing * 0.5 / Math.max(1, n));
    return shown.map((item, k) => {
      const x = geo.stX(i) + (k - (n - 1) / 2) * gap;
      const lane = (k % 2 ? 1 : -1) * Math.min(geo.thick(x) * 0.16, mini ? 3 : 7) * (n > 1 ? 1 : 0);
      return { item, x, y: geo.yAt(x, 0) + lane, delay: (k * 0.7 + i * 0.37).toFixed(2) };
    });
  });
  const overflow = stream.stations.map((station, i) => ({ id: station.id, extra: Math.max(0, station.items.length - cap), x: geo.stX(i) }));

  function stationMeta(index: number): React.ReactNode {
    const station = stream.stations[index];
    const n = station.items.length;
    if (station.id === 'betaald') return n ? `in ${monthLabel}` : `nog niets in ${monthLabel}`;
    if (n === 0) return 'niets onderweg';
    const noun = { gesprek: 'in de maak', offerte: 'bij de klant', werk: 'te factureren', factuur: 'open' }[station.id as Exclude<StationId, 'betaald'>];
    const knot = station.late ? <> · <b className="late">{station.late} te laat</b></>
      : station.wait ? <> · <b className="wait">{station.wait} wacht</b></>
        : station.sent ? <> · <b className="ok">{station.sent} opgevolgd</b></> : null;
    return <>{n} {noun}{knot}</>;
  }

  function showTip(item: StreamItem, x: number, y: number) {
    setTip({ item, x, y });
    onHover?.(item);
  }
  function hideTip() {
    setTip(null);
    onHover?.(null);
  }

  return <div ref={hostRef} className={`sl-stream${mini ? ' is-mini' : ''}`} role="group" aria-label={label}>
    <canvas ref={canvasRef} className="sl-stream-cv" aria-hidden="true" />
    <ol className="sl-stns">
      {stream.stations.map((station, i) => {
        const end = i === stream.stations.length - 1;
        const aria = `${station.label}: ${eur.format(station.amount)}, ${station.items.length} ${station.items.length === 1 ? 'stuk' : 'stukken'}`;
        return <li key={station.id} className="sl-stn-li" style={{ ['--x' as string]: `${geo.stX(i)}px` }}>
          <button type="button" className={`sl-stn${end ? ' is-end' : ''}`} aria-label={aria} onClick={() => onStation?.(station.id)}>
            <span className="sl-stn-l"><i className={`sl-stn-d d${i}`} aria-hidden="true" />{station.label}</span>
            <span className="sl-stn-a"><Amount value={station.amount} short={mini} /></span>
            {!mini && <span className="sl-stn-m">{stationMeta(i)}</span>}
          </button>
        </li>;
      })}
    </ol>
    <div className="sl-beads">
      {beads.map(({ item, x, y, delay }) => {
        const spark = sparkIds?.has(item.refId) ?? false;
        const aria = `${item.title}, ${item.clientName} — ${item.detail}${item.amount ? `, ${eur.format(item.amount)}` : ''}${item.knot ? ` (${KNOT_TEXT[item.knot]})` : ''}${spark ? '. Gerrie heeft iets klaar.' : ''}`;
        return <button
          type="button"
          key={item.id}
          className={`sl-bead${item.knot ? ` knot ${item.knot}` : ''}`}
          style={{ ['--x' as string]: `${x}px`, ['--y' as string]: `${y}px`, ['--c' as string]: item.color, ['--d' as string]: `${delay}s` }}
          aria-label={aria}
          onClick={() => onPick?.(item)}
          onPointerEnter={() => showTip(item, x, y)}
          onPointerLeave={hideTip}
          onFocus={() => showTip(item, x, y)}
          onBlur={hideTip}
        >{spark && <i className="sl-spark zorb" aria-hidden="true" />}</button>;
      })}
      {overflow.filter(o => o.extra > 0).map(o => <button
        type="button"
        key={`more-${o.id}`}
        className="sl-more"
        style={{ ['--x' as string]: `${o.x}px`, ['--y' as string]: `${geo.yAt(o.x, 0) + geo.thick(o.x) / 2 + (mini ? 10 : 14)}px` }}
        onClick={() => onStation?.(o.id)}
        aria-label={`Nog ${o.extra} bij ${STATIONS.find(s => s.id === o.id)?.label}`}
      >+{o.extra}</button>)}
    </div>
    {tip && <div
      className="sl-tip"
      role="tooltip"
      // Naast de kraal, niet erboven: zo blijven de haltes en hun bedragen leesbaar.
      style={tip.x > geo.width / 2
        ? { right: Math.max(6, geo.width - tip.x + 16), top: Math.max(4, Math.min(geo.height - 96, tip.y - 48)) }
        : { left: Math.max(6, tip.x + 16), top: Math.max(4, Math.min(geo.height - 96, tip.y - 48)) }}
    >
      <span className="sl-tip-h"><i style={{ background: tip.item.color }} aria-hidden="true" />{tip.item.clientName}</span>
      <b>{tip.item.title}</b>
      <span>{tip.item.detail}</span>
      {tip.item.amount > 0 && <span className="sl-tip-a"><Amount value={tip.item.amount} /></span>}
      {sparkIds?.has(tip.item.refId)
        ? <span className="sl-tip-ai"><Sparkles size={12} aria-hidden="true" />Gerrie heeft iets klaar</span>
        : tip.item.knot === 'sent' ? <span className="sl-tip-ok"><Check size={12} aria-hidden="true" />Opgevolgd</span> : null}
    </div>}
  </div>;
}

/** De stroomlijn: waar één klant staat, in dezelfde vijf haltes. */
export function StreamLine({ index, color, knot, label }: { index: number; color: string; knot: 'wait' | 'late' | 'sent' | null; label?: string }) {
  const at = index >= 0 ? STATIONS[index] : null;
  return <span
    className={`sl-line${knot === 'late' || knot === 'wait' ? ` knot-${knot}` : ''}`}
    style={{ ['--c' as string]: color }}
    role="img"
    aria-label={label ?? (at ? `Staat bij ${at.label.toLowerCase()} (${index + 1} van ${STATIONS.length})` : 'Niet in de stroom')}
  >
    {STATIONS.map((station, k) => <i key={station.id} className={k < index ? 'past' : k === index ? 'now' : undefined} />)}
  </span>;
}

const KNOT_LINE: Record<'wait' | 'late' | 'sent', string> = { wait: 'er wacht iets', late: 'er is iets te laat', sent: 'net opgevolgd' };

/**
 * Klant 360 in Stroom: waar deze klant in de stroom staat, en per halte zijn
 * stukken. Een stuk openen gaat naar de offerte of factuur zelf.
 */
export function ClientStream({ stream, clientId, color, onPick }: {
  stream: Stream;
  clientId: string;
  color: string;
  onPick: (item: StreamItem) => void;
}) {
  const position = clientPosition(stream, clientId);
  const at = position.index >= 0 ? STATIONS[position.index] : null;
  const summary = !at
    ? 'Niets onderweg met deze klant: geen offerte open en niets te factureren.'
    : `Staat bij ${at.label.toLowerCase()}${position.knot ? `, ${KNOT_LINE[position.knot]}` : ''}.`;
  return <section className="sl-panel sl-cstream" aria-label="Waar deze klant in de stroom staat">
    <header className="sl-panel-h">
      <div className="sl-panel-t"><h2>In de stroom</h2><StreamLine index={position.index} color={color} knot={position.knot} /></div>
      <p className="sl-panel-m">{summary}</p>
    </header>
    <ol className="sl-cs">
      {STATIONS.map((station, i) => {
        const items = position.items.filter(item => item.station === station.id);
        return <li key={station.id} className={`sl-cs-st${i === position.index ? ' is-now' : i < position.index ? ' is-past' : ''}`}>
          <span className="sl-cs-l"><i aria-hidden="true" />{station.label}</span>
          {items.length > 0
            ? items.map(item => <button type="button" key={item.id} className={`sl-cs-i${item.knot ? ` knot-${item.knot}` : ''}`} onClick={() => onPick(item)}>
                <b>{item.title}</b>
                <span>{item.detail}</span>
                <Amount value={item.amount} />
              </button>)
            : <span className="sl-cs-none">—</span>}
        </li>;
      })}
    </ol>
  </section>;
}

/** De stroomlijn in de kop van een klant: vijf punten en waar hij staat. */
export function ClientStreamBadge({ stream, clientId, color }: { stream: Stream; clientId: string; color: string }) {
  const position = clientPosition(stream, clientId);
  const at = position.index >= 0 ? STATIONS[position.index] : null;
  return <span className={`sl-cbadge${position.knot === 'late' ? ' is-late' : position.knot === 'wait' ? ' is-wait' : ''}`}>
    <StreamLine index={position.index} color={color} knot={position.knot} />
    <span>{at ? at.label : 'Niet in de stroom'}</span>
  </span>;
}
