import { useEffect, useState, type ReactNode } from 'react';
import { CalendarClock, ChevronRight, Video } from 'lucide-react';
import { STATIONS, type Stream, type StreamItem, type StationId } from '../lib/stroom';
import { formatClock } from '../lib/sun';
import { Amount, StreamRibbon } from '../components/StreamRibbon';
import type { DayArcItem } from './DayArc';

/**
 * Vandaag in Stroom (designvoorstel 2026-10-30). De groet staat los op het
 * licht, daaronder de stroom van offerte tot betaald, en dan de stapel met wat
 * Gerrie klaarzette naast je dag. De zon zit in het licht; de Dagboog van
 * Zenit is hier niet nodig.
 *
 * Alles hier is weergave. Wat erin gaat, rekent Dashboard.tsx en lib/stroom.ts
 * uit; zo blijven de regels voor bedragen, rechten en "te laat" op één plek.
 */

const minutesOfDay = (date: Date) => date.getHours() * 60 + date.getMinutes();

function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** De groet, wat er vandaag staat, en de Nu-kaart. */
export function StroomHero({ eyebrow, greeting, name, brief, items, allDay, actions }: {
  eyebrow: string;
  greeting: string;
  name: string;
  brief: ReactNode;
  /** Afspraken en geplande blokken van vandaag (dezelfde als de Dagboog van Zenit). */
  items: DayArcItem[];
  allDay: string[];
  actions?: ReactNode;
}) {
  return <header className="sl-hero">
    <div className="sl-hero-t">
      <span className="sl-eyebrow">{eyebrow}</span>
      <h1 className="sl-hello">{greeting}, <span>{name}</span></h1>
      <p className="sl-brief">{brief}</p>
      {actions && <div className="sl-hero-acts">{actions}</div>}
    </div>
    <NowCard items={items} allDay={allDay} />
  </header>;
}

/** Nu: wat er op dit moment loopt, met een balk die meeloopt; anders wat er straks komt. */
function NowCard({ items, allDay }: { items: DayArcItem[]; allDay: string[] }) {
  const now = useMinute();
  const minute = minutesOfDay(now);
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const current = sorted.find(item => item.start <= minute && minute < item.end && !item.done) ?? null;
  const next = sorted.find(item => item.start > minute && !item.done) ?? null;

  if (!current && !next) {
    return <section className="sl-now is-off" aria-label="Nu">
      <span className="sl-now-k">Nu</span>
      <b className="sl-now-t">{allDay.length > 0 ? `Hele dag: ${allDay[0]}` : sorted.length > 0 ? 'Je afspraken van vandaag zijn voorbij' : 'Geen afspraken vandaag'}</b>
      <span className="sl-now-p">Ruimte voor je eigen werk.</span>
    </section>;
  }

  const shown = current ?? next!;
  const progress = current ? Math.max(0, Math.min(1, (minute - current.start) / Math.max(1, current.end - current.start))) : 0;
  const after = current ? sorted.find(item => item.start >= current.end && !item.done) ?? null : sorted.find(item => item.start > (next?.start ?? 0) && !item.done) ?? null;
  const left = current ? Math.max(0, Math.round(current.end - minute)) : Math.max(0, Math.round(shown.start - minute));

  return <section className={`sl-now${current ? ' is-live' : ''}`} aria-label="Nu">
    <span className="sl-now-k">{current ? <><i className="sl-now-live" aria-hidden="true" />Nu bezig</> : `Straks, over ${left < 60 ? `${left} min` : `${Math.floor(left / 60)} uur${left % 60 ? ` ${left % 60} min` : ''}`}`}</span>
    <button type="button" className="sl-now-main" onClick={shown.onOpen} disabled={!shown.onOpen}>
      <b className="sl-now-t">{shown.title}</b>
      <span className="sl-now-p"><i style={{ background: shown.color }} aria-hidden="true" />{shown.kind === 'meeting' ? 'Afspraak' : 'Gepland blok'}{shown.where ? ` · ${shown.where}` : ''}</span>
    </button>
    {current
      ? <div className="sl-now-time">
          <span className="sl-now-clock">{formatClock(minute)}</span>
          <span className="sl-now-bar" role="progressbar" aria-label="Voortgang" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${progress * 100}%` }} /></span>
          <span className="sl-now-end">nog {left < 60 ? `${left} min` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} uur`}</span>
        </div>
      : <div className="sl-now-time"><span className="sl-now-clock">{formatClock(shown.start)}</span><span className="sl-now-end">tot {formatClock(shown.end)}</span></div>}
    {shown.meetingUrl && <a className="sl-btn is-gold sl-now-join" href={shown.meetingUrl} target="_blank" rel="noreferrer"><Video size={14} aria-hidden="true" />Deelnemen</a>}
    {after && <div className="sl-now-next">
      <CalendarClock size={14} aria-hidden="true" />
      <span className="sl-now-nx"><b>{after.title}</b><em>{formatClock(after.start)}{after.where ? ` · ${after.where}` : ''}</em></span>
    </div>}
  </section>;
}

/** De stroom in zijn glazen paneel, met de som erboven. */
export function StreamPanel({ stream, monthLabel, mini, sparkIds, onPick, onStation, onHover }: {
  stream: Stream;
  monthLabel: string;
  mini: boolean;
  sparkIds?: ReadonlySet<string>;
  onPick: (item: StreamItem) => void;
  onStation: (id: StationId) => void;
  onHover?: (item: StreamItem | null) => void;
}) {
  const open = stream.stations.filter(station => station.id === 'factuur');
  const outstanding = open.reduce((sum, station) => sum + station.amount, 0);
  const late = stream.items.filter(item => item.station === 'factuur' && item.knot === 'late').reduce((sum, item) => sum + item.amount, 0);
  const paid = stream.stations.find(station => station.id === 'betaald')?.amount ?? 0;
  const empty = stream.items.length === 0;

  return <section className="sl-panel sl-flow" aria-label="De stroom">
    <header className="sl-panel-h">
      <div className="sl-panel-t"><h2>De stroom</h2><span className="sl-panel-m">van offerte tot betaald</span></div>
      {!empty && <p className="sl-flow-sum">
        <b><Amount value={outstanding} /></b> open{late > 0 && <>, waarvan <b className="sl-late"><Amount value={late} /></b> te laat</>}{!mini && <> · <b><Amount value={paid} /></b> binnen in {monthLabel}</>}
      </p>}
    </header>
    {empty
      ? <div className="sl-flow-empty">
          <ol>{STATIONS.map(station => <li key={station.id}>{station.label}</li>)}</ol>
          <p>Zodra er een offerte of factuur is, stroomt hij hier van links naar rechts: van in de maak tot betaald.</p>
        </div>
      : <div className="sl-flow-host"><StreamRibbon stream={stream} monthLabel={monthLabel} mini={mini} sparkIds={sparkIds} onPick={onPick} onStation={onStation} onHover={onHover} /></div>}
  </section>;
}

/** Een regel onder de stapel en je dag: wat de stroom niet laat zien maar wel wacht. */
export function StroomAttention({ items }: { items: { key: string; label: string; meta?: string; tone: 'default' | 'danger'; icon: ReactNode; onClick: () => void }[] }) {
  if (items.length === 0) return null;
  return <section className="sl-panel sl-attn" aria-label="Wacht op je">
    <header className="sl-panel-h"><div className="sl-panel-t"><h2>Wacht op je</h2></div></header>
    <div className="sl-attn-list">
      {items.map(item => <button type="button" key={item.key} className={`sl-attn-i${item.tone === 'danger' ? ' is-danger' : ''}`} onClick={item.onClick}>
        <span className="sl-attn-ic" aria-hidden="true">{item.icon}</span>
        <span className="sl-attn-t"><b>{item.label}</b>{item.meta && <em>{item.meta}</em>}</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>)}
    </div>
  </section>;
}
