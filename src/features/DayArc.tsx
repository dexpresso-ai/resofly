import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CalendarRange, Pause, Play, RotateCcw, Sun, Sunrise, Sunset, Video } from 'lucide-react';
import { formatClock, sunTimes } from '../lib/sun';
import { useNarrowViewport } from '../lib/useNarrowViewport';

/**
 * De Dagboog (Zenit, designvoorstel 2026-10-22): je dag als horizon. De zon
 * loopt van zon op naar zon onder; je afspraken en ingeplande taken liggen als
 * gekleurde stukken op de boog, en eronder staat wat er nú is en wat er
 * daarna komt. Sleep de zon (of gebruik de pijltjestoetsen) om vooruit of
 * terug te kijken; "Nu" zet hem terug.
 *
 * Tijden zijn minuten na middernacht in de wandklok van de browser, net als in
 * src/lib/sun.ts.
 */

export interface DayArcItem {
  id: string;
  title: string;
  /** Minuten na middernacht. */
  start: number;
  end: number;
  /** Een afspraak uit de agenda, of een ingepland blok uit de weekplanner. */
  kind: 'meeting' | 'focus';
  /** Een CSS-kleur, ook een var(): de kleur van het project, of die van afspraken. */
  color: string;
  /** Waar: de locatie of het project. */
  where?: string | null;
  meetingUrl?: string | null;
  done?: boolean;
  onOpen?: () => void;
}

/* De boog in een viewBox van 1000 × 200, getekend op 120px hoogte (schaal .6):
   horizon op 150, de zon op zijn hoogst 128 erboven, 's nachts hooguit 30% van
   die hoogte eronder. Het svg staat 38px onder de bovenrand van het podium,
   zodat het label boven de zon (en het zenit) ruimte heeft. Op de telefoon is
   alles kleiner (80px hoog, 26px marge): dezelfde maten staan in zenit.css. */
const HZ = 150;
const AMP = 128;
const BELOW = 0.3;
const GEOMETRY = { wide: { top: 38, scale: 0.6 }, compact: { top: 26, scale: 0.4 } };
const LANE_ROW = 30;

const STARS = Array.from({ length: 22 }, (_, i) => ({
  left: (i * 47.3 + 13) % 100,
  top: (i * 29.7 + 7) % 62,
  opacity: 0.35 + ((i * 37) % 60) / 100,
}));

const minutesOf = (date: Date) => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;

/** "1u 15m", "45m" */
function duration(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}u ${m % 60}m` : `${h}u`;
}

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DayArc({ items, allDay = [], onOpenPlanner, showLane = true, quietStrip = false }: {
  items: DayArcItem[];
  /** Titels van afspraken die de hele dag duren; die passen niet op de boog. */
  allDay?: string[];
  onOpenPlanner?: () => void;
  /** De strook met blokjes onder de boog. Staat er een lijst met dezelfde
   *  afspraken en taken onder (Je dag op Vandaag), dan is hij dubbel: de boog
   *  is het beeld, de lijst de woorden. */
  showLane?: boolean;
  /** Nu en Volgende alleen tonen terwijl je de zon versleept of de dag
   *  afspeelt. In rust staat "nu" al in de lijst eronder. */
  quietStrip?: boolean;
}) {
  const compact = useNarrowViewport();
  const { top: TOP, scale: SCALE } = compact ? GEOMETRY.compact : GEOMETRY.wide;
  // De klok: elke halve minuut, en meteen bij terugkomen in het tabblad.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  // Eén keer per dag rekenen, niet bij elke tik van de klok.
  const sun = useMemo(() => sunTimes(now), [dayKey]);
  const nowMin = minutesOf(now);

  const sorted = useMemo(() => [...items].filter(item => item.end > item.start).sort((a, b) => a.start - b.start || a.end - b.end), [items]);

  // Het venster: minstens 07:00–21:00, en ruimer als je dag eerder begint of later eindigt.
  const t0 = Math.max(0, Math.min(420, ...sorted.map(item => Math.floor(item.start / 60) * 60)));
  const t1 = Math.min(1440, Math.max(1260, ...sorted.map(item => Math.ceil(item.end / 60) * 60)));
  const clamp = (t: number) => Math.max(t0, Math.min(t1, t));

  // Kijken naar een ander moment: slepen, toetsen of afspelen. null = nu.
  const [preview, setPreview] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const t = clamp(preview ?? nowMin);
  const isPreview = preview !== null && Math.abs(preview - nowMin) >= 1;

  const span = sun.set - sun.rise;
  const isDay = (time: number) => time >= sun.rise && time < sun.set;
  const ax = (time: number) => ((time - t0) / (t1 - t0)) * 1000;
  const ay = (time: number) => {
    if (span <= 0) return HZ + AMP * BELOW * 0.6;
    if (span >= 1440) return HZ - AMP;
    const s = Math.sin((Math.PI * (time - sun.rise)) / span);
    return HZ - AMP * (s >= 0 ? s : s * BELOW);
  };
  const path = (from: number, to: number, step = 4) => {
    const a = Math.max(t0, from);
    const b = Math.min(t1, to);
    if (b <= a) return '';
    let d = '';
    for (let time = a; ; time += step) {
      const tt = Math.min(time, b);
      d += `${d ? 'L' : 'M'}${ax(tt).toFixed(1)} ${ay(tt).toFixed(1)}`;
      if (tt >= b) break;
    }
    return d;
  };
  const sunX = ax(t) / 10;
  const sunY = TOP + ay(t) * SCALE;
  const night = !isDay(t);

  // Afspelen: van nu (of zon op) tot het eind van het venster, ~0,6 s per uur.
  const playRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = t >= t1 - 30 ? Math.max(t0, sun.rise - 30) : t;
    const total = t1 - from;
    if (reduced) { setPreview(t1); setPlaying(false); return; }
    const ms = Math.max(2500, (total / 60) * 620);
    const started = performance.now();
    const step = (stamp: number) => {
      const k = Math.min(1, (stamp - started) / ms);
      setPreview(from + total * k);
      if (k < 1) playRef.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    playRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(playRef.current);
  }, [playing]);

  // Slepen over het podium: de zon volgt je vinger of muis.
  const stageRef = useRef<HTMLDivElement>(null);
  const timeAt = (clientX: number) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return t;
    return t0 + Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * (t1 - t0);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    setPlaying(false);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview(timeAt(event.clientX));
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { if (dragging) setPreview(timeAt(event.clientX)); };
  const endDrag = () => setDragging(false);
  const onSunKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -60, PageUp: 60 };
    if (event.key in steps) {
      event.preventDefault();
      setPlaying(false);
      setPreview(clamp(t + (event.shiftKey ? steps[event.key] * 6 : steps[event.key])));
    } else if (event.key === 'Home') { event.preventDefault(); setPreview(clamp(sun.rise)); }
    else if (event.key === 'End') { event.preventDefault(); setPreview(clamp(sun.set)); }
    else if (event.key === 'Escape' && preview !== null) { event.preventDefault(); setPreview(null); }
  };
  const backToNow = () => { setPlaying(false); setPreview(null); };

  // De strook met gekleurde blokjes onder de boog, in rijen zodat niets over
  // elkaar valt: eerst de afspraken, daaronder de ingeplande blokken.
  const laneRef = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState(0);
  useLayoutEffect(() => {
    const node = laneRef.current;
    if (!node) return;
    setLaneWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => setLaneWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [showLane]);
  const lane = useMemo(() => {
    const placed: { item: DayArcItem; left: number; row: number; compact: boolean }[] = [];
    const rowEnds: Record<DayArcItem['kind'], number[]> = { meeting: [], focus: [] };
    for (const item of sorted) {
      const left = (ax(item.start) / 1000) * laneWidth - 4;
      const bar = Math.max(7, ((item.end - item.start) / (t1 - t0)) * laneWidth);
      const width = 22 + bar + Math.min(item.title.length, 22) * 6.4;
      const ends = rowEnds[item.kind];
      let row = ends.findIndex(end => end + 6 <= left);
      let compact = false;
      if (row === -1 && ends.length < 2) { row = ends.length; ends.push(0); }
      if (row === -1) { row = ends.indexOf(Math.min(...ends)); compact = true; }
      ends[row] = left + (compact ? bar + 16 : width);
      placed.push({ item, left, row, compact });
    }
    const meetingRows = rowEnds.meeting.length;
    return {
      chips: placed.map(chip => ({ ...chip, top: (chip.item.kind === 'meeting' ? chip.row : meetingRows + chip.row) * LANE_ROW })),
      rows: meetingRows + rowEnds.focus.length,
    };
  }, [sorted, laneWidth, t0, t1]);

  // Nu, daarna, en wat er nog over is.
  const current = sorted.find(item => item.start <= t && t < item.end && !item.done) ?? null;
  const next = sorted.find(item => item.start > t) ?? null;
  const left = sorted.filter(item => item.start > t);
  const meetingsLeft = left.filter(item => item.kind === 'meeting').length;
  const focusLeft = left.length - meetingsLeft;
  const lastEnd = sorted.length ? Math.max(...sorted.map(item => item.end)) : null;
  const nowLabel = isPreview ? `Om ${formatClock(t)}` : 'Nu';

  let nowTitle: string;
  let nowMeta: string;
  let progress: number | null = null;
  if (current) {
    nowTitle = `${current.kind === 'focus' ? 'Focus · ' : ''}${current.title}`;
    nowMeta = `nog ${duration(current.end - t)}${current.where ? ` · ${current.where}` : ''}`;
    progress = (t - current.start) / (current.end - current.start);
  } else if (sorted.length === 0) {
    nowTitle = 'Niets op de boog';
    nowMeta = 'Geen afspraken en geen ingeplande blokken vandaag';
  } else if (t < sorted[0].start) {
    nowTitle = 'Nog niets gepland';
    nowMeta = `Je dag begint om ${formatClock(sorted[0].start)}`;
  } else if (!next) {
    nowTitle = 'Werkdag klaar';
    nowMeta = t >= sun.set ? 'De zon is onder · tijd voor jezelf' : 'Niets meer gepland vandaag';
  } else {
    nowTitle = `Vrij tot ${formatClock(next.start)}`;
    nowMeta = `${duration(next.start - t)} zonder afspraken`;
  }

  const arcLabel = `Dagboog: ${formatClock(t)}, ${night ? 'na zon onder of voor zon op' : 'overdag'}. ${nowTitle}.`;

  return <section className={`zarc${night ? ' is-night' : ''}${compact ? ' is-compact' : ''}${quietStrip ? ' is-quiet' : ''}`} style={{ '--night': night ? 1 : 0 } as CSSProperties} aria-label="Dagboog">
    <div className="zarc-stars" aria-hidden="true">
      {STARS.map((star, index) => <i key={index} style={{ left: `${star.left.toFixed(1)}%`, top: `${star.top.toFixed(1)}%`, opacity: star.opacity }} />)}
    </div>
    <div className="zarc-head">
      <h2 className="zarc-t"><Sun size={16} aria-hidden="true" />Dagboog</h2>
      <span className="zarc-meta">zon op {formatClock(sun.rise)} · zenit {formatClock(sun.noon)} · onder {formatClock(sun.set)}</span>
      {allDay.length > 0 && <span className="zarc-allday" title={allDay.join(' · ')}>Hele dag: {allDay[0]}{allDay.length > 1 ? ` +${allDay.length - 1}` : ''}</span>}
      <div className="zarc-ctl">
        {!isPreview && !playing && <span className="zarc-meta zarc-hint">Sleep de zon</span>}
        <button type="button" className="btn btn-ghost zarc-btn" onClick={() => setPlaying(on => !on)} aria-pressed={playing}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{playing ? 'Pauze' : 'Speel de dag af'}
        </button>
        {(isPreview || playing) && <button type="button" className="btn btn-ghost zarc-btn" onClick={backToNow}><RotateCcw size={14} aria-hidden="true" />Nu</button>}
      </div>
    </div>

    <div
      ref={stageRef}
      className={`zarc-stage${dragging ? ' is-drag' : ''}${playing ? ' is-playing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg className="zarc-svg" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <line className="zarc-hz" x1="0" y1={HZ} x2="1000" y2={HZ} />
        <path className="zarc-p zarc-night" d={path(t0, sun.rise)} />
        <path className="zarc-p zarc-night" d={path(sun.set, t1)} />
        <path className="zarc-p zarc-day" d={path(sun.rise, sun.set)} />
        <path className="zarc-p zarc-past" d={t > sun.rise ? path(sun.rise, Math.min(t, sun.set)) : ''} />
        {sorted.map(item => <path
          key={item.id}
          className={`zarc-p zarc-ev${item.kind === 'focus' ? ' is-focus' : ''}${item.end <= t || item.done ? ' is-past' : ''}`}
          d={path(item.start, item.end, 2)}
          style={{ stroke: item.color }}
        ><title>{`${formatClock(item.start)} – ${formatClock(item.end)} · ${item.title}`}</title></path>)}
      </svg>
      {sun.noon > t0 && sun.noon < t1 && <span className={`zarc-mk is-zenit${Math.abs(sunX - ax(sun.noon) / 10) < 7 ? ' is-near' : ''}`} style={{ left: `${(ax(sun.noon) / 10).toFixed(2)}%`, top: `${(TOP + ay(sun.noon) * SCALE - 34).toFixed(1)}px` }} aria-hidden="true">Zenit {formatClock(sun.noon)}</span>}
      {sun.rise > t0 && sun.rise < t1 && <span className="zarc-mk" style={{ left: `${(ax(sun.rise) / 10).toFixed(2)}%`, top: `${(TOP + HZ * SCALE + 8).toFixed(1)}px` }} aria-hidden="true"><Sunrise size={13} />{formatClock(sun.rise)}</span>}
      {sun.set > t0 && sun.set < t1 && <span className="zarc-mk" style={{ left: `${(ax(sun.set) / 10).toFixed(2)}%`, top: `${(TOP + HZ * SCALE + 8).toFixed(1)}px` }} aria-hidden="true"><Sunset size={13} />{formatClock(sun.set)}</span>}
      <button
        type="button"
        className="zarc-sun"
        style={{ left: `${sunX.toFixed(2)}%`, top: `${sunY.toFixed(1)}px` }}
        role="slider"
        aria-label="Tijd van de dag"
        aria-valuemin={Math.round(t0)}
        aria-valuemax={Math.round(t1)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={arcLabel}
        onKeyDown={onSunKey}
      >
        <span className="zarc-sun-t" aria-hidden="true">{formatClock(t)}</span>
      </button>
    </div>

    <div className="zarc-ticks" aria-hidden="true">
      {Array.from({ length: Math.floor((t1 - Math.ceil(t0 / 120) * 120) / 120) + 1 }, (_, index) => Math.ceil(t0 / 120) * 120 + index * 120)
        .map(tick => <span key={tick} style={{ left: `${(ax(tick) / 10).toFixed(2)}%` }}>{formatClock(tick)}</span>)}
    </div>

    {showLane && <div ref={laneRef} className="zarc-lane" style={{ height: `${Math.max(1, lane.rows) * LANE_ROW + 4}px` }}>
      {laneWidth > 0 && lane.chips.map(({ item, left: x, top, compact }) => {
        const past = item.end <= t || item.done;
        const live = item.start <= t && t < item.end && !item.done;
        const bar = Math.max(7, ((item.end - item.start) / (t1 - t0)) * laneWidth);
        return <button
          type="button"
          key={item.id}
          className={`zarc-chip${item.kind === 'focus' ? ' is-focus' : ''}${past ? ' is-past' : ''}${live ? ' is-now' : ''}${compact ? ' is-compact' : ''}`}
          style={{ left: `${x.toFixed(1)}px`, top: `${top}px`, '--c': item.color, '--w': `${bar.toFixed(1)}px` } as CSSProperties}
          title={`${formatClock(item.start)} – ${formatClock(item.end)} · ${item.title}${item.where ? ` · ${item.where}` : ''}`}
          onClick={item.onOpen}
          disabled={!item.onOpen}
        >
          <i aria-hidden="true" />{!compact && <span>{item.title}</span>}
        </button>;
      })}
    </div>}

    {(!quietStrip || isPreview || playing) && <div className="zarc-nn" aria-live="polite">
      <div>
        <span className={`zarc-nn-l${isPreview ? '' : ' is-now'}`}>{nowLabel}</span>
        <div className="zarc-nn-b">
          <div className="zarc-nn-t">{nowTitle}</div>
          <div className="zarc-nn-m">
            {progress !== null && <span className="zarc-bar" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
            <span>{nowMeta}</span>
          </div>
        </div>
      </div>
      <div>
        <span className="zarc-nn-l">{next ? 'Volgende' : 'Daarna'}</span>
        <div className="zarc-nn-b">
          <div className="zarc-nn-t">{next ? `${formatClock(next.start)} · ${next.title}` : 'Niets meer vandaag'}</div>
          <div className="zarc-nn-m"><span>{next ? `over ${duration(next.start - t)}${next.where ? ` · ${next.where}` : ''}` : 'Kijk vooruit in de weekplanner'}</span></div>
        </div>
        {next?.meetingUrl
          ? <a className="btn zarc-btn" href={next.meetingUrl} target="_blank" rel="noreferrer"><Video size={14} aria-hidden="true" />Deelnemen</a>
          : !next && onOpenPlanner && <button type="button" className="btn zarc-btn" onClick={onOpenPlanner}><CalendarRange size={14} aria-hidden="true" />Weekplanner</button>}
      </div>
      <div className="zarc-nn-rest">
        <div className="zarc-nn-b">
          <div className="zarc-nn-t">{left.length ? (meetingsLeft ? `Nog ${pl(meetingsLeft, 'afspraak', 'afspraken')}` : 'Geen afspraken meer') : sorted.length ? 'Alles gehad' : 'Lege dag'}</div>
          <div className="zarc-nn-m"><span>{left.length
            ? [focusLeft ? `${pl(focusLeft, 'blok', 'blokken')} ingepland` : 'geen blokken meer', lastEnd !== null ? `klaar ± ${formatClock(lastEnd)}` : ''].filter(Boolean).join(' · ')
            : 'Morgen weer een dag'}</span></div>
        </div>
      </div>
    </div>}
  </section>;
}
