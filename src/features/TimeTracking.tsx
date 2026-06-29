import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, Clock, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { Modal } from '../components/Modal';
import { BarChart, LineChart } from '../components/Charts';
import { dateNL, euro, formatMinutes, minutesToHours } from '../lib/format';
import { addDays, formatISODate, parseISODate, startOfWeek } from '../lib/dates';
import { createTimeEntry, deleteTimeEntry, updateTimeEntry } from '../lib/repository';
import type { ReportRow } from '../lib/reporting';
import type { AppData, OrganizationMember, TimeEntry, TimeEntrySource, UUID } from '../types';

/* ── Helpers ──────────────────────────────────────────────────────────── */

type Period = 'week' | 'month' | 'quarter' | 'custom';

function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function startOfQuarter(d: Date): Date { return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); }
function endOfQuarter(d: Date): Date { return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 0); }

/** Berekende declarabele waarde van een post in centen (0 als niet declarabel of geen tarief). */
export function timeEntryValueCents(entry: TimeEntry): number {
  if (!entry.billable || !entry.hourly_rate_cents) return 0;
  return Math.round((entry.minutes / 60) * entry.hourly_rate_cents);
}

/** Resolve het standaardtarief (centen) voor een project: project-tarief, anders bedrijfsdefault. */
export function resolveRateCents(data: AppData, projectId: string | null): number | null {
  const project = projectId ? data.projects.find(p => p.id === projectId) : null;
  return project?.hourly_rate_cents ?? data.companySettings?.default_hourly_rate_cents ?? null;
}

const SOURCE_LABEL: Record<TimeEntrySource, string> = { calendar: 'Agenda', manual: 'Handmatig', timer: 'Timer' };

/* ── Gedeelde klant/project-keuze ─────────────────────────────────────── */

function ProjectClientFields({ data, clientId, projectId, onChange }: {
  data: AppData; clientId: string; projectId: string;
  onChange: (next: { clientId: string; projectId: string }) => void;
}) {
  const clients = useMemo(() => [...data.clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [data.clients]);
  const projects = useMemo(
    () => data.projects.filter(p => !p.archived && (!clientId || p.client_id === clientId)).sort((a, b) => a.name.localeCompare(b.name, 'nl')),
    [data.projects, clientId],
  );
  return (
    <div className="settings-grid compact">
      <label>Klant
        <Select value={clientId} onChange={e => {
          const nextClient = e.target.value;
          const keepProject = projectId && data.projects.find(p => p.id === projectId)?.client_id === nextClient;
          onChange({ clientId: nextClient, projectId: keepProject ? projectId : '' });
        }}>
          <option value="">Geen klant</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </label>
      <label>Project
        <Select value={projectId} onChange={e => {
          const nextProject = e.target.value;
          const proj = data.projects.find(p => p.id === nextProject);
          onChange({ clientId: clientId || (proj?.client_id ?? ''), projectId: nextProject });
        }}>
          <option value="">Geen project</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </label>
    </div>
  );
}

/* ── Handmatige registratie / bewerken ────────────────────────────────── */

export function TimeEntryModal({ organizationId, data, entry, defaults, onClose, onSaved }: {
  organizationId: UUID;
  data: AppData;
  entry: TimeEntry | null;
  defaults?: { projectId?: string | null; clientId?: string | null; date?: string; minutes?: number; description?: string };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const editing = Boolean(entry);
  const [clientId, setClientId] = useState(entry?.client_id ?? defaults?.clientId ?? '');
  const [projectId, setProjectId] = useState(entry?.project_id ?? defaults?.projectId ?? '');
  const [date, setDate] = useState(entry?.entry_date ?? defaults?.date ?? formatISODate(new Date()));
  const [hours, setHours] = useState(() => (entry ? Math.floor(entry.minutes / 60) : Math.floor((defaults?.minutes ?? 60) / 60)));
  const [minutes, setMinutes] = useState(() => (entry ? entry.minutes % 60 : (defaults?.minutes ?? 60) % 60));
  const [description, setDescription] = useState(entry?.description ?? defaults?.description ?? '');
  const [billable, setBillable] = useState(entry?.billable ?? true);
  // Tarief in euro's voor de invoer; leeg = projecttarief/bedrijfsdefault gebruiken.
  const initialRateCents = entry?.hourly_rate_cents ?? resolveRateCents(data, entry?.project_id ?? defaults?.projectId ?? null);
  const [rateEuro, setRateEuro] = useState(initialRateCents != null ? String(initialRateCents / 100) : '');
  const [rateTouched, setRateTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tarief automatisch meeschuiven met het gekozen project, zolang de gebruiker
  // het veld niet zelf heeft aangepast.
  useEffect(() => {
    if (editing || rateTouched) return;
    const r = resolveRateCents(data, projectId || null);
    setRateEuro(r != null ? String(r / 100) : '');
  }, [projectId, editing, rateTouched, data]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const totalMinutes = Math.max(0, Math.round(hours)) * 60 + Math.max(0, Math.round(minutes));
    if (totalMinutes <= 0) { setError('Vul een duur in (uren en/of minuten).'); return; }
    const rateCents = rateEuro.trim() === '' ? null : Math.round(Number(rateEuro.replace(',', '.')) * 100);
    if (rateCents != null && (!Number.isFinite(rateCents) || rateCents < 0)) { setError('Ongeldig uurtarief.'); return; }
    setBusy(true); setError(null);
    try {
      if (entry) {
        await updateTimeEntry(organizationId, entry.id, {
          project_id: projectId || null, client_id: clientId || null,
          description: description.trim() || null, entry_date: date,
          minutes: totalMinutes, billable, hourly_rate_cents: rateCents,
        });
      } else {
        await createTimeEntry(organizationId, {
          project_id: projectId || null, client_id: clientId || null, source: 'manual',
          description: description.trim() || null, entry_date: date,
          minutes: totalMinutes, billable, hourly_rate_cents: rateCents,
        });
      }
      await onSaved();
      onClose();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Opslaan mislukt.');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? 'Uren bewerken' : 'Uren registreren'} onClose={onClose} className="time-entry-modal"
      footer={<>
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" disabled={busy} onClick={() => submit()}>{editing ? 'Opslaan' : 'Registreren'}</Button>
      </>}>
      <form onSubmit={submit} className="time-entry-form">
        {error && <div className="error">{error}</div>}
        <ProjectClientFields data={data} clientId={clientId} projectId={projectId} onChange={next => { setClientId(next.clientId); setProjectId(next.projectId); }} />
        <div className="settings-grid compact">
          <label>Datum<Input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          <div className="time-duration-fields">
            <label>Uren<Input type="number" min={0} step={1} value={hours} onChange={e => setHours(Number(e.target.value))} /></label>
            <label>Minuten<Input type="number" min={0} max={59} step={5} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
          </div>
        </div>
        <label>Omschrijving<Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Waar is aan gewerkt?" /></label>
        <div className="settings-grid compact">
          <label>Uurtarief (€)<Input type="number" min={0} step="0.01" value={rateEuro} placeholder="Geen tarief"
            onChange={e => { setRateEuro(e.target.value); setRateTouched(true); }} /></label>
          <label className="check-row" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={billable} onChange={e => setBillable(e.target.checked)} /> Declarabel
          </label>
        </div>
      </form>
    </Modal>
  );
}

/* ── Timer ────────────────────────────────────────────────────────────── */

interface RunningTimer { projectId: string; clientId: string; description: string; startedAt: string; }

function TimerCard({ organizationId, data, storageKey, onSaved }: {
  organizationId: UUID; data: AppData; storageKey: string; onSaved: () => void | Promise<void>;
}) {
  const [running, setRunning] = useState<RunningTimer | null>(() => {
    try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) as RunningTimer : null; } catch { return null; }
  });
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  // Houd de verstreken-teller live terwijl de timer loopt.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick(t => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  function persist(next: RunningTimer | null) {
    setRunning(next);
    try { if (next) localStorage.setItem(storageKey, JSON.stringify(next)); else localStorage.removeItem(storageKey); } catch { /* localStorage kan geweigerd zijn */ }
  }

  function start() {
    persist({ projectId, clientId, description, startedAt: new Date().toISOString() });
  }

  async function stop() {
    if (!running) return;
    const started = new Date(running.startedAt);
    const ended = new Date();
    const minutes = Math.max(1, Math.round((ended.getTime() - started.getTime()) / 60000));
    setBusy(true);
    try {
      await createTimeEntry(organizationId, {
        project_id: running.projectId || null, client_id: running.clientId || null, source: 'timer',
        description: running.description.trim() || null, entry_date: formatISODate(started),
        started_at: running.startedAt, ended_at: ended.toISOString(), minutes,
        hourly_rate_cents: resolveRateCents(data, running.projectId || null),
      });
      persist(null);
      setDescription('');
      await onSaved();
    } finally { setBusy(false); }
  }

  const elapsedMs = running ? Date.now() - new Date(running.startedAt).getTime() : 0;
  const elapsed = new Date(elapsedMs);
  const hh = String(Math.floor(elapsedMs / 3600000)).padStart(2, '0');
  const mm = String(elapsed.getUTCMinutes()).padStart(2, '0');
  const ss = String(elapsed.getUTCSeconds()).padStart(2, '0');
  const runProject = running?.projectId ? data.projects.find(p => p.id === running.projectId) : null;
  const runClient = running?.clientId ? data.clients.find(c => c.id === running.clientId) : null;

  return (
    <article className="tt-timer-card">
      {running ? (
        <div className="tt-timer-running">
          <div className="tt-timer-clock">{hh}:{mm}:{ss}</div>
          <div className="tt-timer-meta">
            <strong>{running.description || 'Lopende registratie'}</strong>
            <span>{[runClient?.name, runProject?.name].filter(Boolean).join(' · ') || 'Geen koppeling'}</span>
          </div>
          <Button variant="danger" disabled={busy} onClick={stop}><Square size={14} /> Stop &amp; opslaan</Button>
        </div>
      ) : (
        <div className="tt-timer-idle">
          <div className="tt-timer-head"><Clock size={16} /><h3>Timer</h3></div>
          <ProjectClientFields data={data} clientId={clientId} projectId={projectId} onChange={next => { setClientId(next.clientId); setProjectId(next.projectId); }} />
          <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Waar ga je aan werken?" />
          <Button variant="primary" onClick={start}><Play size={14} /> Start timer</Button>
        </div>
      )}
    </article>
  );
}

/* ── Hoofdpagina ──────────────────────────────────────────────────────── */

export function TimeTracking({ data, organizationId, currentUserId, teamMembers, canWrite, canAdmin, onChanged }: {
  data: AppData;
  organizationId: UUID;
  currentUserId: UUID | null;
  teamMembers: OrganizationMember[];
  canWrite: boolean;
  canAdmin: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [period, setPeriod] = useState<Period>('week');
  const [customFrom, setCustomFrom] = useState(() => formatISODate(startOfWeek(new Date())));
  const [customTo, setCustomTo] = useState(() => formatISODate(addDays(startOfWeek(new Date()), 6)));
  const [scope, setScope] = useState<'me' | 'team'>('me');
  const [filterProject, setFilterProject] = useState('');
  const [filterClient, setFilterClient] = useState('');
  const [filterBillable, setFilterBillable] = useState<'all' | 'billable' | 'nonbillable'>('all');
  const [filterSource, setFilterSource] = useState<'all' | TimeEntrySource>('all');
  const [modal, setModal] = useState<{ entry: TimeEntry | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    const now = new Date();
    if (period === 'week') return { from: startOfWeek(now), to: addDays(startOfWeek(now), 6) };
    if (period === 'month') return { from: startOfMonth(now), to: endOfMonth(now) };
    if (period === 'quarter') return { from: startOfQuarter(now), to: endOfQuarter(now) };
    return { from: parseISODate(customFrom), to: parseISODate(customTo) };
  }, [period, customFrom, customTo]);

  const fromKey = formatISODate(range.from);
  const toKey = formatISODate(range.to);

  const memberName = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of teamMembers) map.set(m.user_id, m.email ?? 'Teamlid');
    return (userId: string) => userId === currentUserId ? 'Jij' : (map.get(userId) ?? 'Teamlid');
  }, [teamMembers, currentUserId]);

  // Posten binnen periode + scope (zonder de lijst-filters, voor de KPI's/grafieken).
  const scopedEntries = useMemo(() => data.timeEntries.filter(e => {
    if (e.entry_date < fromKey || e.entry_date > toKey) return false;
    if (scope === 'me' && e.user_id !== currentUserId) return false;
    return true;
  }), [data.timeEntries, fromKey, toKey, scope, currentUserId]);

  const entries = useMemo(() => scopedEntries.filter(e => {
    if (filterProject && e.project_id !== filterProject) return false;
    if (filterClient && e.client_id !== filterClient) return false;
    if (filterBillable === 'billable' && !e.billable) return false;
    if (filterBillable === 'nonbillable' && e.billable) return false;
    if (filterSource !== 'all' && e.source !== filterSource) return false;
    return true;
  }), [scopedEntries, filterProject, filterClient, filterBillable, filterSource]);

  // KPI's.
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  const billableMinutes = entries.filter(e => e.billable).reduce((s, e) => s + e.minutes, 0);
  const valueCents = entries.reduce((s, e) => s + timeEntryValueCents(e), 0);
  const dayCount = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86400000) + 1);
  const avgPerDay = totalMinutes / dayCount;

  // Grafiekrijen (waarden in uren).
  const perDayRows: ReportRow[] = useMemo(() => {
    const days: ReportRow[] = [];
    for (let d = new Date(range.from); d <= range.to; d = addDays(d, 1)) {
      const key = formatISODate(d);
      const mins = entries.filter(e => e.entry_date === key).reduce((s, e) => s + e.minutes, 0);
      days.push({ key, label: dateNL(key).slice(0, 5), value: minutesToHours(mins) });
    }
    return days;
  }, [entries, range.from, range.to]);

  function groupRows(getKey: (e: TimeEntry) => string, getLabel: (k: string) => string): ReportRow[] {
    const map = new Map<string, number>();
    for (const e of entries) map.set(getKey(e), (map.get(getKey(e)) ?? 0) + e.minutes);
    return [...map.entries()]
      .map(([key, mins]) => ({ key, label: getLabel(key), value: minutesToHours(mins) }))
      .sort((a, b) => b.value - a.value);
  }

  const perProjectRows = useMemo(() => groupRows(
    e => e.project_id ?? '__none', k => k === '__none' ? 'Zonder project' : (data.projects.find(p => p.id === k)?.name ?? 'Project'),
  ), [entries, data.projects]); // eslint-disable-line react-hooks/exhaustive-deps
  const perClientRows = useMemo(() => groupRows(
    e => e.client_id ?? '__none', k => k === '__none' ? 'Zonder klant' : (data.clients.find(c => c.id === k)?.name ?? 'Klant'),
  ), [entries, data.clients]); // eslint-disable-line react-hooks/exhaustive-deps
  const perMemberRows = useMemo(() => groupRows(e => e.user_id, memberName), [entries, memberName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lijst gegroepeerd per dag (nieuwste eerst).
  const grouped = useMemo(() => {
    const byDate = new Map<string, TimeEntry[]>();
    for (const e of [...entries].sort((a, b) => (a.started_at ?? a.entry_date).localeCompare(b.started_at ?? b.entry_date))) {
      (byDate.get(e.entry_date) ?? byDate.set(e.entry_date, []).get(e.entry_date)!).push(e);
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  const hoursFmt = (n: number) => `${n.toFixed(1)} u`;
  const timerKey = `resofly:timer:${organizationId}:${currentUserId ?? 'anon'}`;

  async function toggleBillable(entry: TimeEntry) {
    if (!canWrite) return;
    setError(null);
    try { await updateTimeEntry(organizationId, entry.id, { billable: !entry.billable }); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Bijwerken mislukt.'); }
  }

  async function removeEntry(entry: TimeEntry) {
    if (!canWrite) return;
    if (!confirm('Deze urenregistratie verwijderen?')) return;
    setError(null);
    try { await deleteTimeEntry(organizationId, entry.id); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt.'); }
  }

  return (
    <div className="time-tracking-page">
      {error && <div className="error">{error}</div>}

      {/* Hero / bedieningsbalk */}
      <section className="tt-hero">
        <div className="tt-hero-text">
          <h2>Urenregistratie</h2>
          <p>Uren uit je agenda, handmatig of via de timer — gebundeld met inzichten per project, klant en teamlid.</p>
        </div>
        <div className="tt-hero-controls">
          <div className="tt-period-tabs" role="tablist">
            {([['week', 'Deze week'], ['month', 'Deze maand'], ['quarter', 'Dit kwartaal'], ['custom', 'Aangepast']] as [Period, string][]).map(([p, label]) => (
              <button key={p} type="button" className={`tt-period-tab${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>{label}</button>
            ))}
          </div>
          {canAdmin && (
            <div className="tt-scope-tog">
              <button type="button" className={scope === 'me' ? 'active' : ''} onClick={() => setScope('me')}>Ikzelf</button>
              <button type="button" className={scope === 'team' ? 'active' : ''} onClick={() => setScope('team')}>Heel team</button>
            </div>
          )}
          {canWrite && <Button variant="primary" onClick={() => setModal({ entry: null })}><Plus size={14} /> Uren</Button>}
        </div>
      </section>

      {period === 'custom' && (
        <div className="tt-custom-range">
          <label>Van<Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} /></label>
          <label>Tot en met<Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} /></label>
        </div>
      )}

      {/* Timer */}
      {canWrite && <TimerCard organizationId={organizationId} data={data} storageKey={timerKey} onSaved={onChanged} />}

      {/* KPI's */}
      <section className="tt-kpis">
        <div className="tt-kpi"><span className="tt-kpi-val">{formatMinutes(totalMinutes)}</span><span className="tt-kpi-lbl">Totaal geregistreerd</span></div>
        <div className="tt-kpi"><span className="tt-kpi-val">{formatMinutes(billableMinutes)}</span><span className="tt-kpi-lbl">Declarabel</span></div>
        <div className="tt-kpi"><span className="tt-kpi-val">{valueCents > 0 ? euro(valueCents / 100) : '—'}</span><span className="tt-kpi-lbl">Declarabele waarde</span></div>
        <div className="tt-kpi"><span className="tt-kpi-val">{entries.length}</span><span className="tt-kpi-lbl">Registraties</span></div>
        <div className="tt-kpi"><span className="tt-kpi-val">{formatMinutes(Math.round(avgPerDay))}</span><span className="tt-kpi-lbl">Gemiddeld per dag</span></div>
      </section>

      {/* Grafieken */}
      <section className="tt-charts">
        <article className="client-panel"><div className="client-panel-head"><h3>Uren per dag</h3></div><LineChart rows={perDayRows} format={hoursFmt} /></article>
        <article className="client-panel"><div className="client-panel-head"><h3>Top projecten</h3></div><BarChart rows={perProjectRows} format={hoursFmt} /></article>
        <article className="client-panel"><div className="client-panel-head"><h3>Top klanten</h3></div><BarChart rows={perClientRows} format={hoursFmt} /></article>
        {scope === 'team' && <article className="client-panel"><div className="client-panel-head"><h3>Per teamlid</h3></div><BarChart rows={perMemberRows} format={hoursFmt} /></article>}
      </section>

      {/* Filters + lijst */}
      <section className="client-panel tt-list-panel">
        <div className="tt-filters">
          <Select value={filterClient} onChange={e => { setFilterClient(e.target.value); setFilterProject(''); }}>
            <option value="">Alle klanten</option>
            {[...data.clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={filterProject} onChange={e => setFilterProject(e.target.value)}>
            <option value="">Alle projecten</option>
            {data.projects.filter(p => !filterClient || p.client_id === filterClient).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select value={filterBillable} onChange={e => setFilterBillable(e.target.value as typeof filterBillable)}>
            <option value="all">Alles</option>
            <option value="billable">Alleen declarabel</option>
            <option value="nonbillable">Niet-declarabel</option>
          </Select>
          <Select value={filterSource} onChange={e => setFilterSource(e.target.value as typeof filterSource)}>
            <option value="all">Alle bronnen</option>
            <option value="calendar">Agenda</option>
            <option value="manual">Handmatig</option>
            <option value="timer">Timer</option>
          </Select>
        </div>

        {grouped.length === 0 ? (
          <div className="tt-empty">Geen registraties in deze periode. Koppel een afspraak aan een project, gebruik de timer of voeg handmatig uren toe.</div>
        ) : grouped.map(([day, rows]) => {
          const dayMinutes = rows.reduce((s, e) => s + e.minutes, 0);
          return (
            <div className="tt-day-group" key={day}>
              <div className="tt-day-head"><strong>{dateNL(day)}</strong><span>{formatMinutes(dayMinutes)}</span></div>
              <div className="tt-entry-list">
                {rows.map(e => {
                  const project = e.project_id ? data.projects.find(p => p.id === e.project_id) : null;
                  const client = e.client_id ? data.clients.find(c => c.id === e.client_id) : null;
                  const value = timeEntryValueCents(e);
                  const editable = canWrite && e.source !== 'calendar';
                  return (
                    <div className="tt-entry-row" key={e.id}>
                      <span className="tt-entry-dur">{formatMinutes(e.minutes)}</span>
                      <div className="tt-entry-main">
                        <strong>{e.description || (project?.name ?? client?.name ?? 'Registratie')}</strong>
                        <span className="tt-entry-sub">
                          {[client?.name, project?.name].filter(Boolean).join(' · ') || 'Geen koppeling'}
                          {scope === 'team' && ` · ${memberName(e.user_id)}`}
                        </span>
                      </div>
                      <span className={`tt-source-badge tt-source-${e.source}`}>{e.source === 'calendar' && <CalendarDays size={11} />}{SOURCE_LABEL[e.source]}</span>
                      <button type="button" className={`tt-billable-pill${e.billable ? ' is-billable' : ''}`} disabled={!canWrite} onClick={() => toggleBillable(e)} title="Declarabel aan/uit">
                        {e.billable ? 'Declarabel' : 'Niet decl.'}
                      </button>
                      <span className="tt-entry-value">{value > 0 ? euro(value / 100) : '—'}</span>
                      <div className="tt-entry-actions">
                        {editable && <button type="button" className="icon-btn" onClick={() => setModal({ entry: e })} title="Bewerken"><Pencil size={14} /></button>}
                        {editable && <button type="button" className="icon-btn danger" onClick={() => removeEntry(e)} title="Verwijderen"><Trash2 size={14} /></button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>

      {modal && (
        <TimeEntryModal organizationId={organizationId} data={data} entry={modal.entry}
          onClose={() => setModal(null)} onSaved={onChanged} />
      )}
    </div>
  );
}
