import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, RefreshCcw, Unplug } from 'lucide-react';
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

function providerLabel(provider: CalendarProvider): string {
  return provider === 'google' ? 'Google' : 'Microsoft';
}

function providerClass(provider: CalendarProvider): string {
  return provider === 'google' ? 'provider-google' : 'provider-microsoft';
}

function visibilityLabel(visibility: CalendarVisibility): string {
  return visibility === 'organization' ? 'Gedeeld met organisatie' : 'Privé';
}

export function CalendarPage({ organizationId, currentUserId, data, canWrite, onEditTask }: { organizationId: UUID; currentUserId: UUID | null; data: AppData; canWrite: boolean; onEditTask: (task: Task) => void }) {
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [integrations, setIntegrations] = useState<CalendarIntegrationsPayload>({ connections: [], sources: [] });
  const [events, setEvents] = useState<CalendarExternalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newEvent, setNewEvent] = useState(() => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    return { sourceId: '', title: '', description: '', location: '', startsAt: toInputDateTime(start), endsAt: toInputDateTime(end), allDay: false };
  });

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const rangeStart = useMemo(() => days[0].toISOString(), [days]);
  const rangeEnd = useMemo(() => addDays(days[6], 1).toISOString(), [days]);
  const canManageSource = (source: CalendarSource) => Boolean(canWrite && currentUserId && source.user_id === currentUserId);
  const canManageConnection = (connectionUserId: UUID) => Boolean(canWrite && currentUserId && connectionUserId === currentUserId);
  const writeableSources = useMemo(
    () => integrations.sources.filter(s => s.write_enabled && s.sync_enabled && (s.user_id === currentUserId || s.visibility === 'organization')),
    [integrations.sources, currentUserId],
  );

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  useEffect(() => {
    void refreshEventsOnly();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart, rangeEnd]);

  useEffect(() => {
    if (!newEvent.sourceId && writeableSources[0]) setNewEvent(prev => ({ ...prev, sourceId: writeableSources[0].id }));
    if (newEvent.sourceId && !writeableSources.some(s => s.id === newEvent.sourceId)) setNewEvent(prev => ({ ...prev, sourceId: writeableSources[0]?.id ?? '' }));
  }, [newEvent.sourceId, writeableSources]);

  async function refreshAll() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const next = await loadCalendarIntegrations(organizationId);
      setIntegrations(next);
      await refreshEventsOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agenda-koppelingen laden mislukt.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshEventsOnly() {
    setEventsLoading(true);
    setError(null);
    try {
      setEvents(await listExternalCalendarEvents(organizationId, rangeStart, rangeEnd));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agenda-events laden mislukt.');
    } finally {
      setEventsLoading(false);
    }
  }

  async function connect(provider: CalendarProvider) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const authUrl = await getCalendarOAuthUrl(organizationId, provider, window.location.href.split('?')[0]);
      window.location.assign(authUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OAuth starten mislukt.');
      setLoading(false);
    }
  }

  async function refreshSources(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const next = await refreshCalendarSources(organizationId, connectionId);
      setIntegrations(next);
      setMessage('Agenda’s opnieuw opgehaald. Nieuwe agenda’s staan standaard privé.');
      await refreshEventsOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agenda’s ophalen mislukt.');
    } finally {
      setLoading(false);
    }
  }

  async function disconnect(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    if (!confirm('Deze persoonlijke agenda-koppeling loskoppelen? De externe agenda zelf wordt niet verwijderd.')) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await disconnectCalendarConnection(organizationId, connectionId);
      const next = await loadCalendarIntegrations(organizationId);
      setIntegrations(next);
      setMessage('Agenda-koppeling losgekoppeld.');
      await refreshEventsOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loskoppelen mislukt.');
    } finally {
      setLoading(false);
    }
  }

  async function toggleSource(source: CalendarSource, key: 'sync_enabled' | 'write_enabled' | 'visibility') {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    if (!canManageSource(source)) { setError('Alleen de gebruiker die deze agenda heeft gekoppeld kan delen, tonen of schrijven aanpassen.'); return; }
    const patch: Pick<Partial<CalendarSource>, 'sync_enabled' | 'write_enabled' | 'visibility'> = {};
    if (key === 'visibility') patch.visibility = source.visibility === 'organization' ? 'private' : 'organization';
    else if (key === 'sync_enabled') patch.sync_enabled = !source.sync_enabled;
    else patch.write_enabled = !source.write_enabled;
    setError(null);
    setMessage(null);
    try {
      const updated = await updateCalendarSource(organizationId, source.id, patch);
      setIntegrations(prev => ({ ...prev, sources: prev.sources.map(s => s.id === updated.id ? updated : s) }));
      if (key === 'sync_enabled' || key === 'visibility') await refreshEventsOnly();
      if (key === 'visibility') setMessage(updated.visibility === 'organization' ? 'Agenda gedeeld met de organisatie.' : 'Agenda staat weer privé.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agenda-instelling bijwerken mislukt.');
    }
  }

  async function submitNewEvent(e: FormEvent) {
    e.preventDefault();
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    if (!newEvent.sourceId) { setError('Kies eerst een schrijfbare agenda.'); return; }
    if (!newEvent.title.trim()) { setError('Geef het event een titel.'); return; }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await createExternalCalendarEvent(organizationId, {
        sourceId: newEvent.sourceId,
        title: newEvent.title.trim(),
        description: newEvent.description.trim() || null,
        location: newEvent.location.trim() || null,
        startsAt: inputDateTimeToIso(newEvent.startsAt),
        endsAt: inputDateTimeToIso(newEvent.endsAt),
        allDay: newEvent.allDay,
      });
      setNewEvent(prev => ({ ...prev, title: '', description: '', location: '' }));
      setMessage('Extern agenda-event aangemaakt.');
      await refreshEventsOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Event aanmaken mislukt.');
    } finally {
      setLoading(false);
    }
  }

  function tasksForDay(day: Date) {
    return data.tasks.filter(task => task.status !== 'done' && task.end_date && isSameDay(new Date(`${task.end_date}T12:00:00`), day));
  }

  function eventsForDay(day: Date) {
    return events.filter(event => isSameDay(new Date(event.starts_at), day));
  }

  return <div className="calendar-page">
    <div className="calendar-hero">
      <div>
        <h2>Agenda</h2>
        <p>Koppel Google Calendar en Microsoft Outlook persoonlijk. Agenda’s staan standaard privé; deel ze alleen expliciet met de organisatie als ze in de teamplanning mogen verschijnen.</p>
        <p className="calendar-help">Admins kunnen privé-agenda’s van teamleden niet openen of beheren. Niet-gedeelde agenda’s blijven buiten de teamplanning.</p>
        {!canWrite && <p className="calendar-help">Je hebt alleen-lezen toegang: events bekijken kan, maar koppelen, loskoppelen en schrijven zijn uitgeschakeld.</p>}
      </div>
      <div className="calendar-actions">
        <Button variant="primary" onClick={() => connect('google')} disabled={loading || !canWrite}>Google koppelen</Button>
        <Button variant="primary" onClick={() => connect('microsoft')} disabled={loading || !canWrite}>Microsoft koppelen</Button>
        <Button onClick={refreshAll} disabled={loading || eventsLoading}><RefreshCcw size={14}/> Ververs</Button>
      </div>
    </div>

    {error && <div className="error">{error}</div>}
    {message && <div className="success">{message}</div>}

    <section className="calendar-section">
      <div className="calendar-section-head">
        <div>
          <h3>Gekoppelde accounts</h3>
          <p>Je ziet je eigen koppelingen en agenda’s die expliciet met de organisatie zijn gedeeld. Tokens blijven versleuteld server-side.</p>
        </div>
      </div>
      {integrations.connections.length === 0 ? <div className="calendar-empty">Nog geen agenda gekoppeld of gedeeld.</div> : <div className="connection-list">
        {integrations.connections.map(connection => {
          const sources = integrations.sources.filter(s => s.connection_id === connection.id);
          const ownsConnection = canManageConnection(connection.user_id);
          return <article className="connection-card" key={connection.id}>
            <div className="connection-top">
              <div className={`provider-badge ${providerClass(connection.provider)}`}>{providerLabel(connection.provider)}</div>
              <div className="connection-info">
                <strong>{ownsConnection ? (connection.display_name || connection.provider_account_email || 'Mijn gekoppelde account') : 'Gedeelde agenda'}</strong>
                <span>{ownsConnection ? (connection.provider_account_email || connection.provider_account_id) : 'Accountgegevens afgeschermd'}</span>
              </div>
              <span className={`connection-status status-${connection.status}`}>{connection.status}</span>
              <Button onClick={() => refreshSources(connection.id)} disabled={loading || !ownsConnection}><RefreshCcw size={14}/> Agenda’s</Button>
              <Button variant="danger" onClick={() => disconnect(connection.id)} disabled={loading || !ownsConnection}><Unplug size={14}/> Loskoppelen</Button>
            </div>
            <div className="source-list">
              {sources.map(source => {
                const ownsSource = canManageSource(source);
                return <div className="source-row privacy" key={source.id}>
                  <span className="source-dot" style={{ background: source.color || '#FFD966' }}/>
                  <div className="source-info">
                    <strong>{source.name}</strong>
                    <span>{source.is_primary ? 'Primair · ' : ''}{source.access_role || 'geen rol'}{source.timezone ? ` · ${source.timezone}` : ''}</span>
                    <span className={`privacy-pill ${source.visibility === 'organization' ? 'shared' : 'private'}`}>{visibilityLabel(source.visibility)}{source.user_id === currentUserId ? ' · van jou' : ''}</span>
                  </div>
                  <label className="toggle-row"><input type="checkbox" checked={source.sync_enabled} disabled={!ownsSource} onChange={() => toggleSource(source, 'sync_enabled')}/> Tonen</label>
                  <label className="toggle-row"><input type="checkbox" checked={source.visibility === 'organization'} disabled={!ownsSource} onChange={() => toggleSource(source, 'visibility')}/> Delen met organisatie</label>
                  <label className="toggle-row"><input type="checkbox" checked={source.write_enabled} disabled={!ownsSource} onChange={() => toggleSource(source, 'write_enabled')}/> Schrijven</label>
                </div>;
              })}
              {sources.length === 0 && <div className="calendar-empty small">Klik op “Agenda’s” om beschikbare agenda’s op te halen. Nieuwe agenda’s staan standaard privé.</div>}
            </div>
          </article>;
        })}
      </div>}
    </section>

    <section className="calendar-layout">
      <div className="calendar-main-card">
        <div className="calendar-toolbar">
          <Button onClick={() => setAnchor(prev => addDays(prev, -7))}>Vorige week</Button>
          <Button onClick={() => setAnchor(startOfWeek(new Date()))}>Vandaag</Button>
          <Button onClick={() => setAnchor(prev => addDays(prev, 7))}>Volgende week</Button>
          <div className="calendar-range">{formatISODate(days[0])} t/m {formatISODate(days[6])}{eventsLoading ? ' · events laden…' : ''}</div>
        </div>
        <div className="calendar-week-grid">
          {days.map((day, index) => {
            const dayTasks = tasksForDay(day);
            const dayEvents = eventsForDay(day);
            return <div className="calendar-day" key={formatISODate(day)}>
              <div className="calendar-day-head">
                <span>{DAY_NAMES_NL[index]}</span>
                <strong>{day.getDate()}</strong>
              </div>
              <div className="calendar-day-body">
                {dayTasks.map(task => <button className="calendar-item task" key={task.id} onClick={() => onEditTask(task)}>
                  <span className="calendar-item-time">Taak</span>
                  <strong>{task.title}</strong>
                  <small>{data.projects.find(p => p.id === task.project_id)?.name ?? 'Project'}</small>
                </button>)}
                {dayEvents.map(event => <a className={`calendar-item external ${event.visibility === 'private' ? 'private-event' : ''}`} key={`${event.provider}-${event.provider_event_id}-${event.starts_at}`} href={event.html_link || undefined} target="_blank" rel="noreferrer">
                  <span className="calendar-item-time">{formatTime(event.starts_at, event.all_day)}</span>
                  <strong>{event.title}</strong>
                  <small>{providerLabel(event.provider)} · {event.source_name}{event.visibility === 'private' ? ' · privé' : ' · team'}</small>
                </a>)}
                {dayTasks.length === 0 && dayEvents.length === 0 && <div className="calendar-no-items">Geen items</div>}
              </div>
            </div>;
          })}
        </div>
      </div>

      <form className="calendar-create-card" onSubmit={submitNewEvent}>
        <div className="calendar-create-head"><CalendarDays size={18}/><div><h3>Nieuw extern event</h3><p>Schrijf naar je eigen agenda of naar een gedeelde agenda waarvoor schrijven expliciet is ingeschakeld.</p></div></div>
        <label>Agenda<Select value={newEvent.sourceId} onChange={e => setNewEvent(prev => ({ ...prev, sourceId: e.target.value }))}>
          <option value="">Kies agenda</option>
          {writeableSources.map(source => <option value={source.id} key={source.id}>{providerLabel(source.provider)} · {source.name}{source.visibility === 'private' ? ' · privé' : ' · team'}</option>)}
        </Select></label>
        <label>Titel<Input value={newEvent.title} onChange={e => setNewEvent(prev => ({ ...prev, title: e.target.value }))} placeholder="Bijv. Intake klant"/></label>
        <label>Locatie<Input value={newEvent.location} onChange={e => setNewEvent(prev => ({ ...prev, location: e.target.value }))} placeholder="Optioneel"/></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(prev => ({ ...prev, startsAt: e.target.value }))}/></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(prev => ({ ...prev, endsAt: e.target.value }))}/></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(prev => ({ ...prev, description: e.target.value }))} placeholder="Optioneel"/></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(prev => ({ ...prev, allDay: e.target.checked }))}/> Hele dag</label>
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>Event aanmaken</Button>
        {!writeableSources.length && <p className="calendar-help">Zet bij je eigen agenda eerst “Schrijven” aan. Teamleden kunnen alleen schrijven naar agenda’s die gedeeld zijn én waarvoor schrijven aanstaat.</p>}
      </form>
    </section>
  </div>;
}
