import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, Clock, LayoutList, Plus, RefreshCcw, Unplug, X } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { addDays, DAY_NAMES_NL, formatISODate, isSameDay, startOfWeek } from '../lib/dates';
import {
  createExternalCalendarEvent,
  disconnectCalendarConnection,
  getCalendarOAuthUrl,
  listExternalCalendarEvents,
  loadCalendarIntegrations,
  refreshCalendarSources,
  updateCalendarSource,
  type CalendarIntegrationsPayload,
} from '../lib/calendar-api';
import type { AppData, CalendarExternalEvent, CalendarProvider, CalendarSource, CalendarVisibility, Task, UUID } from '../types';

/* ── Constants & helpers ─────────────────────────────────────────────── */

const HOUR_START = 7;
const HOUR_END = 22;
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = (HOUR_END - HOUR_START) * (60 / SLOT_MINUTES);

function toInputDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputDateTimeToIso(value: string): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function formatTime(value: string, allDay?: boolean): string {
  if (allDay) return 'Hele dag';
  return new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatHour(hour: number, minutes: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function providerLabel(p: CalendarProvider): string { return p === 'google' ? 'Google' : 'Microsoft'; }
function providerClass(p: CalendarProvider): string { return p === 'google' ? 'provider-google' : 'provider-microsoft'; }
function visibilityLabel(v: CalendarVisibility): string { return v === 'organization' ? 'Gedeeld met organisatie' : 'Privé'; }

function slotToTime(slot: number): { hour: number; minutes: number } {
  const totalMin = HOUR_START * 60 + slot * SLOT_MINUTES;
  return { hour: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

/** Fractional position (0..1) within the visible HOUR_START..HOUR_END window */
function dateToFraction(d: Date): number {
  const totalMin = d.getHours() * 60 + d.getMinutes();
  const sMin = HOUR_START * 60;
  const eMin = HOUR_END * 60;
  if (totalMin <= sMin) return 0;
  if (totalMin >= eMin) return 1;
  return (totalMin - sMin) / (eMin - sMin);
}

type CalendarView = 'list' | 'timeblock';

interface DragState { dayIndex: number; startSlot: number; endSlot: number }

/* ── TimeBlockGrid ───────────────────────────────────────────────────── */

function TimeBlockGrid({ days, events, tasks, data, canWrite, writeableSources, onSelectSlot, onEditTask }: {
  days: Date[];
  events: CalendarExternalEvent[];
  tasks: Task[];
  data: AppData;
  canWrite: boolean;
  writeableSources: CalendarSource[];
  onSelectSlot: (day: Date, startSlot: number, endSlot: number) => void;
  onEditTask: (task: Task) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const canSelect = canWrite && writeableSources.length > 0;

  const handleMouseDown = useCallback((dayIndex: number, slot: number) => {
    if (!canSelect) return;
    setDrag({ dayIndex, startSlot: slot, endSlot: slot });
    setIsDragging(true);
  }, [canSelect]);

  const handleMouseEnter = useCallback((_dayIndex: number, slot: number) => {
    if (!isDragging || !drag) return;
    if (_dayIndex !== drag.dayIndex) return;
    setDrag(prev => prev ? { ...prev, endSlot: slot } : null);
  }, [isDragging, drag]);

  const handleMouseUp = useCallback(() => {
    if (drag && isDragging) {
      const minS = Math.min(drag.startSlot, drag.endSlot);
      const maxS = Math.max(drag.startSlot, drag.endSlot);
      onSelectSlot(days[drag.dayIndex], minS, maxS);
    }
    setIsDragging(false);
    setDrag(null);
  }, [drag, isDragging, days, onSelectSlot]);

  useEffect(() => {
    const up = () => { if (isDragging) handleMouseUp(); };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [isDragging, handleMouseUp]);

  const hourLabels: { hour: number; minutes: number; label: string }[] = [];
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    const t = slotToTime(s);
    hourLabels.push({ ...t, label: formatHour(t.hour, t.minutes) });
  }

  function timedEventsForDay(day: Date) { return events.filter(e => !e.all_day && isSameDay(new Date(e.starts_at), day)); }
  function allDayEventsForDay(day: Date) { return events.filter(e => e.all_day && isSameDay(new Date(e.starts_at), day)); }
  function tasksForDay(day: Date) { return tasks.filter(t => t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day)); }

  function isInSelection(di: number, si: number): boolean {
    if (!drag || !isDragging || di !== drag.dayIndex) return false;
    const lo = Math.min(drag.startSlot, drag.endSlot);
    const hi = Math.max(drag.startSlot, drag.endSlot);
    return si >= lo && si <= hi;
  }

  function selectionLabel(): string | null {
    if (!drag || !isDragging) return null;
    const lo = Math.min(drag.startSlot, drag.endSlot);
    const hi = Math.max(drag.startSlot, drag.endSlot);
    const s = slotToTime(lo);
    const e = slotToTime(hi + 1);
    return `${formatHour(s.hour, s.minutes)} – ${formatHour(e.hour, e.minutes)}`;
  }

  const today = (d: Date) => isSameDay(d, new Date());
  const nowFrac = dateToFraction(new Date());

  return (
    <div className="tb-container" onMouseLeave={() => { if (isDragging) handleMouseUp(); }}>
      {/* All-day row */}
      <div className="tb-allday-row">
        <div className="tb-gutter tb-allday-label">Hele dag</div>
        {days.map((day, di) => {
          const ad = allDayEventsForDay(day);
          const dt = tasksForDay(day);
          return (
            <div className={`tb-allday-cell${today(day) ? ' tb-today-col' : ''}`} key={di}>
              {ad.map(ev => (
                <a className="tb-ad-chip ext" key={ev.id} href={ev.html_link || undefined} target="_blank" rel="noreferrer" title={ev.title}>{ev.title}</a>
              ))}
              {dt.map(t => (
                <button className="tb-ad-chip task" key={t.id} onClick={() => onEditTask(t)} title={t.title}>{t.title}</button>
              ))}
              {ad.length === 0 && dt.length === 0 && <span className="tb-ad-empty">—</span>}
            </div>
          );
        })}
      </div>

      {/* Scrollable time grid */}
      <div className="tb-scroll">
        <div className="tb-grid">
          {/* Gutter labels */}
          {hourLabels.map((h, si) => (
            <div className={`tb-gutter${h.minutes === 0 ? ' tb-gutter-full' : ' tb-gutter-half'}`} key={`g${si}`} style={{ gridRow: si + 1 }}>
              {h.minutes === 0 && <span>{h.label}</span>}
            </div>
          ))}

          {/* Day columns */}
          {days.map((day, di) => {
            const dayEv = timedEventsForDay(day);
            const isToday = today(day);
            return (
              <div className={`tb-col${isToday ? ' tb-today-col' : ''}`} key={di} style={{ gridColumn: di + 2, gridRow: `1 / span ${TOTAL_SLOTS}` }}>
                {/* Interactive slot cells */}
                {hourLabels.map((h, si) => {
                  const selected = isInSelection(di, si);
                  return (
                    <div
                      className={`tb-cell${h.minutes === 0 ? ' tb-cell-hour' : ' tb-cell-half'}${selected ? ' tb-cell-sel' : ''}${canSelect ? ' tb-cell-can' : ''}`}
                      key={si}
                      style={{ top: `calc(var(--tb-h) * ${si})`, height: 'var(--tb-h)' }}
                      onMouseDown={() => handleMouseDown(di, si)}
                      onMouseEnter={() => handleMouseEnter(di, si)}
                    >
                      {selected && si === Math.min(drag!.startSlot, drag!.endSlot) && (
                        <span className="tb-sel-label">{selectionLabel()}</span>
                      )}
                    </div>
                  );
                })}

                {/* Now-line */}
                {isToday && nowFrac > 0 && nowFrac < 1 && (
                  <div className="tb-now" style={{ top: `${nowFrac * 100}%` }}><div className="tb-now-dot" /></div>
                )}

                {/* Event blocks */}
                {dayEv.map(ev => {
                  const t0 = dateToFraction(new Date(ev.starts_at)) * 100;
                  const t1 = dateToFraction(new Date(ev.ends_at)) * 100;
                  const h = Math.max(t1 - t0, 100 / TOTAL_SLOTS * 0.6);
                  return (
                    <a className={`tb-ev${ev.visibility === 'private' ? ' tb-ev-priv' : ''}`} key={ev.id}
                      href={ev.html_link || undefined} target="_blank" rel="noreferrer"
                      style={{ top: `${t0}%`, height: `${h}%` }}
                      title={`${formatTime(ev.starts_at)} – ${formatTime(ev.ends_at)}\n${ev.title}`}>
                      <span className="tb-ev-time">{formatTime(ev.starts_at)}</span>
                      <span className="tb-ev-title">{ev.title}</span>
                      <span className="tb-ev-src">{providerLabel(ev.provider)} · {ev.source_name}</span>
                    </a>
                  );
                })}
              </div>
            );
          })}

          {/* Grid lines */}
          {hourLabels.map((h, si) => (
            <div className={`tb-line${h.minutes === 0 ? ' tb-line-hour' : ''}`} key={`l${si}`} style={{ gridRow: si + 1, gridColumn: '2 / -1' }} />
          ))}
        </div>
      </div>

      {canSelect && <p className="tb-hint">Sleep over lege tijdslots om snel een event aan te maken</p>}
    </div>
  );
}

/* ── Floating creation panel ─────────────────────────────────────────── */

function EventCreationPanel({ newEvent, setNewEvent, writeableSources, loading, canWrite, onSubmit, onClose }: {
  newEvent: { sourceId: string; title: string; description: string; location: string; startsAt: string; endsAt: string; allDay: boolean };
  setNewEvent: (fn: (prev: typeof newEvent) => typeof newEvent) => void;
  writeableSources: CalendarSource[];
  loading: boolean;
  canWrite: boolean;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <div className="tb-overlay" onClick={onClose}>
      <form className="tb-panel" onClick={e => e.stopPropagation()} onSubmit={onSubmit}>
        <div className="tb-panel-head">
          <div className="tb-panel-title"><CalendarDays size={16} /><h3>Nieuw event</h3></div>
          <button type="button" className="tb-panel-close" onClick={onClose}><X size={16} /></button>
        </div>
        <label>Agenda<Select value={newEvent.sourceId} onChange={e => setNewEvent(p => ({ ...p, sourceId: e.target.value }))}>
          <option value="">Kies agenda</option>
          {writeableSources.map(s => <option value={s.id} key={s.id}>{providerLabel(s.provider)} · {s.name}{s.visibility === 'private' ? ' · privé' : ' · team'}</option>)}
        </Select></label>
        <label>Titel<Input autoFocus value={newEvent.title} onChange={e => setNewEvent(p => ({ ...p, title: e.target.value }))} placeholder="Bijv. Intake klant" /></label>
        <label>Locatie<Input value={newEvent.location} onChange={e => setNewEvent(p => ({ ...p, location: e.target.value }))} placeholder="Optioneel" /></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(p => ({ ...p, startsAt: e.target.value }))} /></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(p => ({ ...p, endsAt: e.target.value }))} /></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(p => ({ ...p, description: e.target.value }))} placeholder="Optioneel" /></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(p => ({ ...p, allDay: e.target.checked }))} /> Hele dag</label>
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>Event aanmaken</Button>
      </form>
    </div>
  );
}

/* ── Main CalendarPage ───────────────────────────────────────────────── */

export function CalendarPage({ organizationId, currentUserId, data, canWrite, onEditTask }: {
  organizationId: UUID; currentUserId: UUID | null; data: AppData; canWrite: boolean; onEditTask: (task: Task) => void;
}) {
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [integrations, setIntegrations] = useState<CalendarIntegrationsPayload>({ connections: [], sources: [] });
  const [events, setEvents] = useState<CalendarExternalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CalendarView>('timeblock');
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [newEvent, setNewEvent] = useState(() => {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    const e = new Date(s); e.setHours(e.getHours() + 1);
    return { sourceId: '', title: '', description: '', location: '', startsAt: toInputDateTime(s), endsAt: toInputDateTime(e), allDay: false };
  });

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const rangeStart = useMemo(() => days[0].toISOString(), [days]);
  const rangeEnd = useMemo(() => addDays(days[6], 1).toISOString(), [days]);
  const canManageSource = (src: CalendarSource) => Boolean(canWrite && currentUserId && src.user_id === currentUserId);
  const canManageConnection = (uid: UUID) => Boolean(canWrite && currentUserId && uid === currentUserId);
  const writeableSources = useMemo(
    () => integrations.sources.filter(s => s.write_enabled && s.sync_enabled && (s.user_id === currentUserId || s.visibility === 'organization')),
    [integrations.sources, currentUserId],
  );

  useEffect(() => { void refreshAll(); }, [organizationId]); // eslint-disable-line
  useEffect(() => { void refreshEventsOnly(); }, [rangeStart, rangeEnd]); // eslint-disable-line
  useEffect(() => {
    if (!newEvent.sourceId && writeableSources[0]) setNewEvent(p => ({ ...p, sourceId: writeableSources[0].id }));
    if (newEvent.sourceId && !writeableSources.some(s => s.id === newEvent.sourceId)) setNewEvent(p => ({ ...p, sourceId: writeableSources[0]?.id ?? '' }));
  }, [newEvent.sourceId, writeableSources]);

  async function refreshAll() {
    setLoading(true); setError(null); setMessage(null);
    try { const n = await loadCalendarIntegrations(organizationId); setIntegrations(n); await refreshEventsOnly(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Agenda-koppelingen laden mislukt.'); }
    finally { setLoading(false); }
  }
  async function refreshEventsOnly() {
    setEventsLoading(true); setError(null);
    try { setEvents(await listExternalCalendarEvents(organizationId, rangeStart, rangeEnd)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Agenda-events laden mislukt.'); }
    finally { setEventsLoading(false); }
  }
  async function connect(provider: CalendarProvider) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try { window.location.assign(await getCalendarOAuthUrl(organizationId, provider, window.location.href.split('?')[0])); }
    catch (err) { setError(err instanceof Error ? err.message : 'OAuth starten mislukt.'); setLoading(false); }
  }
  async function refreshSources(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try { const n = await refreshCalendarSources(organizationId, connectionId); setIntegrations(n); setMessage('Agenda's opnieuw opgehaald.'); await refreshEventsOnly(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Agenda's ophalen mislukt.'); }
    finally { setLoading(false); }
  }
  async function disconnect(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    if (!confirm('Deze persoonlijke agenda-koppeling loskoppelen?')) return;
    setLoading(true); setError(null); setMessage(null);
    try { await disconnectCalendarConnection(organizationId, connectionId); setIntegrations(await loadCalendarIntegrations(organizationId)); setMessage('Agenda-koppeling losgekoppeld.'); await refreshEventsOnly(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Loskoppelen mislukt.'); }
    finally { setLoading(false); }
  }
  async function toggleSource(source: CalendarSource, key: 'sync_enabled' | 'write_enabled' | 'visibility') {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang.'); return; }
    if (!canManageSource(source)) { setError('Alleen de eigenaar kan deze instelling wijzigen.'); return; }
    const patch: Partial<Pick<CalendarSource, 'sync_enabled' | 'write_enabled' | 'visibility'>> = {};
    if (key === 'visibility') patch.visibility = source.visibility === 'organization' ? 'private' : 'organization';
    else if (key === 'sync_enabled') patch.sync_enabled = !source.sync_enabled;
    else patch.write_enabled = !source.write_enabled;
    setError(null); setMessage(null);
    try {
      const upd = await updateCalendarSource(organizationId, source.id, patch);
      setIntegrations(prev => ({ ...prev, sources: prev.sources.map(s => s.id === upd.id ? upd : s) }));
      if (key === 'sync_enabled' || key === 'visibility') await refreshEventsOnly();
      if (key === 'visibility') setMessage(upd.visibility === 'organization' ? 'Agenda gedeeld met de organisatie.' : 'Agenda staat weer privé.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Instelling bijwerken mislukt.'); }
  }

  function makeDefaultTimes() {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    const e = new Date(s); e.setHours(e.getHours() + 1);
    return { startsAt: toInputDateTime(s), endsAt: toInputDateTime(e) };
  }

  const handleSlotSelect = useCallback((day: Date, startSlot: number, endSlot: number) => {
    const st = slotToTime(startSlot);
    const et = slotToTime(endSlot + 1);
    const sd = new Date(day); sd.setHours(st.hour, st.minutes, 0, 0);
    const ed = new Date(day); ed.setHours(et.hour, et.minutes, 0, 0);
    setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: toInputDateTime(sd), endsAt: toInputDateTime(ed) }));
    setShowCreatePanel(true);
  }, []);

  async function submitNewEvent(e: FormEvent) {
    e.preventDefault();
    if (!canWrite) { setError('Je hebt alleen-lezen toegang.'); return; }
    if (!newEvent.sourceId) { setError('Kies eerst een schrijfbare agenda.'); return; }
    if (!newEvent.title.trim()) { setError('Geef het event een titel.'); return; }
    const sIso = inputDateTimeToIso(newEvent.startsAt);
    const eIso = inputDateTimeToIso(newEvent.endsAt);
    if (!newEvent.allDay && new Date(eIso).getTime() <= new Date(sIso).getTime()) { setError('Eindtijd moet na starttijd liggen.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try {
      const created = await createExternalCalendarEvent(organizationId, {
        sourceId: newEvent.sourceId, title: newEvent.title.trim(),
        description: newEvent.description.trim() || null, location: newEvent.location.trim() || null,
        startsAt: sIso, endsAt: eIso, allDay: newEvent.allDay,
      });
      setEvents(prev => [...prev, created].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
      const d = makeDefaultTimes();
      setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt }));
      setMessage('Event aangemaakt en zichtbaar in je externe agenda.');
      setShowCreatePanel(false);
      refreshEventsOnly().catch(() => {});
    } catch (err) { setError(err instanceof Error ? err.message : 'Event aanmaken mislukt.'); }
    finally { setLoading(false); }
  }

  function tasksForDay(day: Date) { return data.tasks.filter(t => t.status !== 'done' && t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day)); }
  function eventsForDay(day: Date) { return events.filter(ev => isSameDay(new Date(ev.starts_at), day)); }

  return <div className="calendar-page">
    {/* Hero */}
    <div className="calendar-hero">
      <div>
        <h2>Agenda</h2>
        <p>Koppel Google Calendar en Microsoft Outlook. Agenda's staan standaard privé; deel ze expliciet met de organisatie.</p>
        {!canWrite && <p className="calendar-help">Je hebt alleen-lezen toegang.</p>}
      </div>
      <div className="calendar-actions">
        <Button variant="primary" onClick={() => connect('google')} disabled={loading || !canWrite}>Google koppelen</Button>
        <Button variant="primary" onClick={() => connect('microsoft')} disabled={loading || !canWrite}>Microsoft koppelen</Button>
        <Button onClick={refreshAll} disabled={loading || eventsLoading}><RefreshCcw size={14} /> Ververs</Button>
      </div>
    </div>

    {error && <div className="error">{error}</div>}
    {message && <div className="success">{message}</div>}

    {/* Connections */}
    <section className="calendar-section">
      <div className="calendar-section-head"><div><h3>Gekoppelde accounts</h3><p>Je ziet je eigen koppelingen en gedeelde agenda's. Tokens blijven versleuteld server-side.</p></div></div>
      {integrations.connections.length === 0 ? <div className="calendar-empty">Nog geen agenda gekoppeld of gedeeld.</div> : <div className="connection-list">
        {integrations.connections.map(conn => {
          const srcs = integrations.sources.filter(s => s.connection_id === conn.id);
          const owns = canManageConnection(conn.user_id);
          return <article className="connection-card" key={conn.id}>
            <div className="connection-top">
              <div className={`provider-badge ${providerClass(conn.provider)}`}>{providerLabel(conn.provider)}</div>
              <div className="connection-info">
                <strong>{owns ? (conn.display_name || conn.provider_account_email || 'Mijn account') : 'Gedeelde agenda'}</strong>
                <span>{owns ? (conn.provider_account_email || conn.provider_account_id) : 'Accountgegevens afgeschermd'}</span>
              </div>
              <span className={`connection-status status-${conn.status}`}>{conn.status}</span>
              <Button onClick={() => refreshSources(conn.id)} disabled={loading || !owns}><RefreshCcw size={14} /> Agenda's</Button>
              <Button variant="danger" onClick={() => disconnect(conn.id)} disabled={loading || !owns}><Unplug size={14} /> Loskoppelen</Button>
            </div>
            <div className="source-list">
              {srcs.map(src => {
                const ownsSrc = canManageSource(src);
                return <div className="source-row privacy" key={src.id}>
                  <span className="source-dot" style={{ background: src.color || '#FFD966' }} />
                  <div className="source-info">
                    <strong>{src.name}</strong>
                    <span>{src.is_primary ? 'Primair · ' : ''}{src.access_role || 'geen rol'}{src.timezone ? ` · ${src.timezone}` : ''}</span>
                    <span className={`privacy-pill ${src.visibility === 'organization' ? 'shared' : 'private'}`}>{visibilityLabel(src.visibility)}{src.user_id === currentUserId ? ' · van jou' : ''}</span>
                  </div>
                  <label className="toggle-row"><input type="checkbox" checked={src.sync_enabled} disabled={!ownsSrc} onChange={() => toggleSource(src, 'sync_enabled')} /> Tonen</label>
                  <label className="toggle-row"><input type="checkbox" checked={src.visibility === 'organization'} disabled={!ownsSrc} onChange={() => toggleSource(src, 'visibility')} /> Delen</label>
                  <label className="toggle-row"><input type="checkbox" checked={src.write_enabled} disabled={!ownsSrc} onChange={() => toggleSource(src, 'write_enabled')} /> Schrijven</label>
                </div>;
              })}
              {srcs.length === 0 && <div className="calendar-empty small">Klik "Agenda's" om beschikbare agenda's op te halen.</div>}
            </div>
          </article>;
        })}
      </div>}
    </section>

    {/* Calendar view */}
    <div className="calendar-main-card">
      <div className="calendar-toolbar">
        <Button onClick={() => setAnchor(p => addDays(p, -7))}>Vorige week</Button>
        <Button onClick={() => setAnchor(startOfWeek(new Date()))}>Vandaag</Button>
        <Button onClick={() => setAnchor(p => addDays(p, 7))}>Volgende week</Button>
        <div className="calendar-range">{formatISODate(days[0])} t/m {formatISODate(days[6])}{eventsLoading ? ' · laden…' : ''}</div>
        <div className="tb-view-tog">
          <button className={`tb-vbtn${view === 'timeblock' ? ' active' : ''}`} onClick={() => setView('timeblock')} title="Tijdlijn"><Clock size={14} /></button>
          <button className={`tb-vbtn${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')} title="Lijst"><LayoutList size={14} /></button>
        </div>
      </div>

      {view === 'timeblock' && (
        <div className="tb-day-headers">
          <div className="tb-gutter" />
          {days.map((day, i) => {
            const td = isSameDay(day, new Date());
            return <div className={`tb-dh${td ? ' tb-today' : ''}`} key={i}>
              <span className="tb-dh-name">{DAY_NAMES_NL[i]}</span>
              <span className={`tb-dh-num${td ? ' tb-today-num' : ''}`}>{day.getDate()}</span>
            </div>;
          })}
        </div>
      )}

      {view === 'timeblock' ? (
        <TimeBlockGrid days={days} events={events} tasks={data.tasks.filter(t => t.status !== 'done')} data={data}
          canWrite={canWrite} writeableSources={writeableSources} onSelectSlot={handleSlotSelect} onEditTask={onEditTask} />
      ) : (
        <div className="calendar-week-grid">
          {days.map((day, idx) => {
            const dt = tasksForDay(day); const de = eventsForDay(day);
            return <div className="calendar-day" key={formatISODate(day)}>
              <div className="calendar-day-head"><span>{DAY_NAMES_NL[idx]}</span><strong>{day.getDate()}</strong></div>
              <div className="calendar-day-body">
                {dt.map(t => <button className="calendar-item task" key={t.id} onClick={() => onEditTask(t)}>
                  <span className="calendar-item-time">Taak</span><strong>{t.title}</strong>
                  <small>{data.projects.find(p => p.id === t.project_id)?.name ?? 'Project'}</small>
                </button>)}
                {de.map(ev => <a className={`calendar-item external${ev.visibility === 'private' ? ' private-event' : ''}`}
                  key={`${ev.provider}-${ev.provider_event_id}-${ev.starts_at}`} href={ev.html_link || undefined} target="_blank" rel="noreferrer">
                  <span className="calendar-item-time">{formatTime(ev.starts_at, ev.all_day)}</span><strong>{ev.title}</strong>
                  <small>{providerLabel(ev.provider)} · {ev.source_name}{ev.visibility === 'private' ? ' · privé' : ' · team'}</small>
                </a>)}
                {dt.length === 0 && de.length === 0 && <div className="calendar-no-items">Geen items</div>}
              </div>
            </div>;
          })}
        </div>
      )}
    </div>

    {/* List-view sidebar form */}
    {view === 'list' && (
      <form className="calendar-create-card" onSubmit={submitNewEvent}>
        <div className="calendar-create-head"><CalendarDays size={18} /><div><h3>Nieuw extern event</h3><p>Schrijf naar je eigen of een gedeelde agenda.</p></div></div>
        <label>Agenda<Select value={newEvent.sourceId} onChange={e => setNewEvent(p => ({ ...p, sourceId: e.target.value }))}>
          <option value="">Kies agenda</option>
          {writeableSources.map(s => <option value={s.id} key={s.id}>{providerLabel(s.provider)} · {s.name}{s.visibility === 'private' ? ' · privé' : ' · team'}</option>)}
        </Select></label>
        <label>Titel<Input value={newEvent.title} onChange={e => setNewEvent(p => ({ ...p, title: e.target.value }))} placeholder="Bijv. Intake klant" /></label>
        <label>Locatie<Input value={newEvent.location} onChange={e => setNewEvent(p => ({ ...p, location: e.target.value }))} placeholder="Optioneel" /></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(p => ({ ...p, startsAt: e.target.value }))} /></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(p => ({ ...p, endsAt: e.target.value }))} /></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(p => ({ ...p, description: e.target.value }))} placeholder="Optioneel" /></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(p => ({ ...p, allDay: e.target.checked }))} /> Hele dag</label>
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>Event aanmaken</Button>
        {!writeableSources.length && <p className="calendar-help">Zet bij je eigen agenda eerst "Schrijven" aan.</p>}
      </form>
    )}

    {/* FAB for timeblock view */}
    {view === 'timeblock' && canWrite && writeableSources.length > 0 && !showCreatePanel && (
      <button className="tb-fab" onClick={() => { const d = makeDefaultTimes(); setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt })); setShowCreatePanel(true); }} title="Nieuw event aanmaken">
        <Plus size={22} />
      </button>
    )}

    {/* Floating panel */}
    {showCreatePanel && <EventCreationPanel newEvent={newEvent} setNewEvent={setNewEvent} writeableSources={writeableSources}
      loading={loading} canWrite={canWrite} onSubmit={submitNewEvent} onClose={() => setShowCreatePanel(false)} />}
  </div>;
}
