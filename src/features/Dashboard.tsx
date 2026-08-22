import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, CheckCircle2, ChevronRight, Clock, FileText, FolderOpen, Landmark, ListTodo, Percent, Pin, Ticket as TicketIcon } from 'lucide-react';
import type { AppData, CalendarExternalEvent, Invoice, OrganizationContext, SavedReport, Task, TaskStatus, UUID } from '../types';
import { coversDay, isOverdue, scopeTasks, taskDayKey, taskLastDayKey } from '../lib/workweek';
import { euro, formatMinutes, total } from '../lib/format';
import { addDays, formatISODate, isoWeekNumber, startOfWeek } from '../lib/dates';
import { getCachedCalendarEvents, listCalendarEventsCached } from '../lib/calendar-api';
import { Button } from '../components/Ui';
import { BarChart, LineChart, PieChart, Sparkline } from '../components/Charts';
import { REPORT_SOURCES, formatMeasure, runReport } from '../lib/reporting';
import { ProjectTimeline } from './ProjectTimeline';
import { AgentApprovals } from '../components/AgentApprovals';
import type { GerrieActionHandlers } from '../lib/gerrie-api';
import { FULL_PERMISSIONS, type Permissions } from '../lib/permissions';

export type DashboardNavPage =
  | 'clients' | 'projects' | 'tickets' | 'quotes' | 'invoices' | 'bank' | 'vat-returns' | 'weekplanner' | 'settings' | 'stats' | 'calendar' | 'gerrie';

type StatTone = 'default' | 'accent' | 'danger';
type AttentionItem = { key: string; tone: 'default' | 'danger'; icon: ReactNode; label: string; meta?: string; count: number; onClick: () => void };
/** "Mijn" = aan mij toegewezen én wat nog aan niemand hangt; gelijk aan de weekplanner. */
type Scope = 'mine' | 'team';

const SCOPE_STORAGE_KEY = 'resofly-dashboard-scope';

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Telt bij binnenkomst op naar `target`, zodat het belangrijkste cijfer op het
 *  dashboard even de aandacht pakt. Respecteert prefers-reduced-motion (dan
 *  meteen de eindwaarde) en telt opnieuw zodra het doel wijzigt. Geeft `null`
 *  terug wanneer er niets te tellen valt, zodat de kaart de gewone waarde toont. */
function useCountUp(target: number | undefined): number | null {
  const prefersReduced = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  const [value, setValue] = useState<number | null>(() => {
    if (target == null || !Number.isFinite(target)) return null;
    return prefersReduced() ? target : 0;
  });

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) { setValue(null); return; }
    if (prefersReduced()) { setValue(target); return; }

    let frame = 0;
    let startedAt: number | null = null;
    const duration = 600;
    const step = (now: number) => {
      if (startedAt === null) startedAt = now;
      const progress = Math.min((now - startedAt) / duration, 1);
      // ease-out cubic: snel op gang, zacht uitdempend op de eindwaarde.
      setValue(target * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // Vangnet: requestAnimationFrame staat stil zolang het tabblad op de
    // achtergrond ligt. Zonder dit zou een dashboard dat daar wordt geladen
    // blijven hangen op € 0 — onacceptabel voor bedragen. Deze timer zet
    // hoe dan ook de echte eindwaarde neer.
    const settle = window.setTimeout(() => setValue(target), duration + 400);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); };
  }, [target]);

  return value;
}

export function Dashboard({
  data,
  organizationContext,
  organizationId,
  currentUserId = null,
  canWriteTasks = false,
  openProject,
  openSettings,
  openPage,
  openReport,
  openTask,
  onSetTaskStatus,
  permissions = FULL_PERMISSIONS,
  gerrieActions,
  canWriteGerrie = false,
}: {
  data: AppData;
  organizationContext: OrganizationContext;
  organizationId: string;
  /** Uitvoer-handlers voor een goedgekeurd Gerrie-voorstel; zonder deze prop
   *  verdwijnt de goedkeurwachtrij van het startscherm. */
  gerrieActions?: GerrieActionHandlers;
  /** Mag dit teamlid een voorstel écht laten uitvoeren (versturen/aanmaken)? */
  canWriteGerrie?: boolean;
  /** Ingelogde gebruiker; bepaalt wat "Mijn" in de acties-blokken betekent. */
  currentUserId?: string | null;
  /** Mag dit lid taken afvinken? (organisatiebreed schrijfrecht én module 'projects'). */
  canWriteTasks?: boolean;
  openProject: (id: string) => void;
  openSettings: () => void;
  /** Modulerechten: kaarten van een dichtgezette module tonen we niet — anders
   *  suggereert "€ 0 omzet" dat er niets is, terwijl je het alleen niet mág zien. */
  permissions?: Permissions;
  openPage: (page: DashboardNavPage) => void;
  openReport: (id: string) => void;
  /** Opent het taakvenster; zonder deze prop is een taakregel niet klikbaar. */
  openTask?: (task: Task) => void;
  onSetTaskStatus?: (task: Task, status: TaskStatus) => void | Promise<void>;
}) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = formatISODate(startOfToday);

  // ── Modulerechten van dit teamlid ───────────────────────────────────────
  const showFinance = permissions.canRead('finance');
  const showProjects = permissions.canRead('projects');
  const showCalendar = permissions.canRead('calendar');

  // ── Mijn / team ─────────────────────────────────────────────────────────
  // Alleen zinvol zodra je niet alleen bent; in je eentje is elke taak de jouwe.
  const teamMembers = organizationContext.teamMembers;
  const canSwitchScope = Boolean(currentUserId) && teamMembers.length > 1;
  const [scope, setScope] = useState<Scope>(() => {
    if (typeof window === 'undefined') return 'mine';
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) === 'team' ? 'team' : 'mine';
  });
  useEffect(() => {
    try { window.localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch { /* privémodus: voorkeur is niet essentieel */ }
  }, [scope]);
  const effectiveScope: Scope = canSwitchScope ? scope : 'team';

  // ── Financieel ──────────────────────────────────────────────────────────
  const paidInvoices = data.invoices.filter(i => i.status === 'paid');
  const revenueThisMonth = sumInvoices(paidInvoices.filter(i => isSameMonth(paidDate(i), now.getFullYear(), now.getMonth())));
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const revenuePrevMonth = sumInvoices(paidInvoices.filter(i => isSameMonth(paidDate(i), prevMonth.getFullYear(), prevMonth.getMonth())));
  const revenueTrend = revenuePrevMonth > 0 ? Math.round(((revenueThisMonth - revenuePrevMonth) / revenuePrevMonth) * 100) : null;
  // Betaalde omzet per maand over het laatste halfjaar (oud → nieuw); voedt de
  // trendlijn in de omzetkaart, zodat die richting toont in plaats van decoratie.
  const revenueSeries = Array.from({ length: 6 }, (_, index) => {
    const month = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return sumInvoices(paidInvoices.filter(invoice => isSameMonth(paidDate(invoice), month.getFullYear(), month.getMonth())));
  });

  const outstandingInvoices = data.invoices.filter(i => i.status === 'sent' || i.status === 'overdue');
  const outstandingTotal = sumInvoices(outstandingInvoices);
  const overdueInvoices = data.invoices.filter(invoiceOverdue);
  const overdueTotal = sumInvoices(overdueInvoices);

  // ── Operationeel ────────────────────────────────────────────────────────
  const newTickets = data.tickets.filter(t => t.status === 'new').length;
  const openTickets = data.tickets.filter(t => t.status === 'new' || t.status === 'review').length;
  const openQuotes = data.quotes.filter(q => q.status === 'sent').length;
  const bankToReconcile = (data.bankTransactions ?? []).filter(t => t.status === 'unmatched' || t.status === 'suggested').length;
  const vatToFile = (data.vatReturns ?? []).filter(v => v.status === 'finalized').length;

  const openTaskCount = data.tasks.filter(t => t.status !== 'done').length;
  const overdueTaskCount = data.tasks.filter(t => t.status !== 'done' && isOverdue(t, todayKey)).length;

  const activeClients = data.clients.filter(c => c.status === 'active').length;

  // ── Gepinde rapportages ─────────────────────────────────────────────────
  const pinnedReports = data.savedReports
    .filter(r => r.is_pinned && Boolean(REPORT_SOURCES[r.definition?.source]))
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  // ── Taken binnen mijn blikveld ──────────────────────────────────────────
  const assigneesByTask = useMemo(() => {
    const map = new Map<string, UUID[]>();
    for (const link of data.taskAssignees) {
      const list = map.get(link.task_id);
      if (list) list.push(link.user_id); else map.set(link.task_id, [link.user_id]);
    }
    return map;
  }, [data.taskAssignees]);

  // Dezelfde definitie van "mijn werk" als de weekplanner, uit één module.
  const scopedTasks = useMemo(
    () => scopeTasks(data.tasks, effectiveScope, currentUserId, assigneesByTask),
    [assigneesByTask, currentUserId, data.tasks, effectiveScope],
  );

  // ── Vandaag ─────────────────────────────────────────────────────────────
  // Twee groepen, in deze volgorde: eerst wat is blijven liggen, dan wat je
  // voor vandaag hebt gepland. Een afgeronde dagtaak blijft staan (doorgestreept),
  // zodat afvinken geen regel onder je muis vandaan laat verdwijnen.
  const lingering = scopedTasks
    .filter(task => task.status !== 'done' && isOverdue(task, todayKey))
    .sort((a, b) => (taskLastDayKey(a) ?? '').localeCompare(taskLastDayKey(b) ?? '') || a.title.localeCompare(b.title));

  const todaysTasks = scopedTasks
    .filter(task => coversDay(task, todayKey) || task.end_date === todayKey)
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done')
      || priorityRank(b) - priorityRank(a)
      || a.title.localeCompare(b.title));

  const todayOpenCount = todaysTasks.filter(task => task.status !== 'done').length + lingering.length;

  // ── Agenda van vandaag ──────────────────────────────────────────────────
  const dayStartIso = startOfToday.toISOString();
  const dayEndIso = addDays(startOfToday, 1).toISOString();
  const [events, setEvents] = useState<CalendarExternalEvent[]>(
    () => (showCalendar ? getCachedCalendarEvents(organizationId, dayStartIso, dayEndIso) ?? [] : []),
  );
  useEffect(() => {
    if (!showCalendar) { setEvents([]); return; }
    let cancelled = false;
    setEvents(getCachedCalendarEvents(organizationId, dayStartIso, dayEndIso) ?? []);
    listCalendarEventsCached(organizationId, dayStartIso, dayEndIso)
      .then(fetched => { if (!cancelled) setEvents(fetched); })
      // Geen agenda gekoppeld of even niet bereikbaar: het dashboard werkt dan
      // gewoon door met alleen de taken. Dit mag de pagina nooit blokkeren.
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [organizationId, dayStartIso, dayEndIso, showCalendar]);

  const todaysEvents = useMemo(() => events
    .filter(event => event.starts_at < dayEndIso && event.ends_at > dayStartIso)
    .sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.starts_at.localeCompare(b.starts_at)),
  [dayEndIso, dayStartIso, events]);

  // ── Weekacties ──────────────────────────────────────────────────────────
  const weekStart = startOfWeek(startOfToday);
  const weekDayKeys = Array.from({ length: 7 }, (_, index) => formatISODate(addDays(weekStart, index)));
  const weekStartKey = weekDayKeys[0];
  const weekEndKey = weekDayKeys[6];
  const weekTasks = scopedTasks.filter(task => {
    if (task.status === 'done') return false;
    const key = taskDayKey(task);
    return key != null && key >= weekStartKey && key <= weekEndKey;
  });
  const looseWeekTasks = weekTasks.filter(task => !task.project_id);
  const projectWeekTasks = weekTasks.filter(task => Boolean(task.project_id));

  // ── Vereist je aandacht ─────────────────────────────────────────────────
  // Elke regel hangt aan een module; staat die dicht, dan hoort de regel er
  // niet te staan (de tellingen zijn dan sowieso 0 door RLS, maar expliciet is beter).
  const attention: AttentionItem[] = [];
  if (showFinance && overdueInvoices.length) attention.push({ key: 'overdue-inv', tone: 'danger', icon: <AlertTriangle size={16} />, label: pl(overdueInvoices.length, 'factuur te laat', 'facturen te laat'), meta: `${euro(overdueTotal)} openstaand`, count: overdueInvoices.length, onClick: () => openPage('invoices') });
  if (showFinance && bankToReconcile) attention.push({ key: 'bank', tone: 'default', icon: <Landmark size={16} />, label: pl(bankToReconcile, 'banktransactie af te letteren', 'banktransacties af te letteren'), count: bankToReconcile, onClick: () => openPage('bank') });
  if (showFinance && openQuotes) attention.push({ key: 'quotes', tone: 'default', icon: <FileText size={16} />, label: pl(openQuotes, 'offerte open bij klanten', 'offertes open bij klanten'), count: openQuotes, onClick: () => openPage('quotes') });
  if (permissions.canRead('tickets') && newTickets) attention.push({ key: 'tickets', tone: 'default', icon: <TicketIcon size={16} />, label: pl(newTickets, 'ticket onbehandeld', 'tickets onbehandeld'), count: newTickets, onClick: () => openPage('tickets') });
  if (showProjects && overdueTaskCount) attention.push({ key: 'tasks', tone: 'default', icon: <Clock size={16} />, label: pl(overdueTaskCount, 'taak over de deadline', 'taken over de deadline'), count: overdueTaskCount, onClick: () => openPage('weekplanner') });
  if (showFinance && vatToFile) attention.push({ key: 'vat', tone: 'default', icon: <Percent size={16} />, label: pl(vatToFile, 'btw-aangifte klaar om in te dienen', 'btw-aangiftes klaar om in te dienen'), count: vatToFile, onClick: () => openPage('vat-returns') });

  // ── Onboarding ──────────────────────────────────────────────────────────
  const activeOrganization = organizationContext.activeOrganization;
  const activeRole = organizationContext.activeMembership?.role ?? 'geen rol';
  const onboardingItems = [
    { label: 'Organisatie aangemaakt', done: Boolean(activeOrganization) },
    { label: 'Bedrijfsgegevens ingevuld', done: Boolean(data.companySettings?.company_name?.trim()) },
    { label: 'Teamrol actief', done: Boolean(organizationContext.activeMembership) },
    { label: 'Eerste klant toegevoegd', done: data.clients.length > 0 },
    { label: 'Eerste project ingericht', done: data.projects.length > 0 },
  ];
  const onboardingDone = onboardingItems.filter(item => item.done).length;
  const onboardingPct = Math.round((onboardingDone / onboardingItems.length) * 100);
  const showOnboarding = onboardingPct < 100;

  const showToday = showProjects || showCalendar;
  const scopeToggle = canSwitchScope
    ? <span className="dash-scope" role="group" aria-label="Wiens acties">
        <button type="button" className={effectiveScope === 'mine' ? 'is-on' : ''} aria-pressed={effectiveScope === 'mine'} onClick={() => setScope('mine')}>Mijn</button>
        <button type="button" className={effectiveScope === 'team' ? 'is-on' : ''} aria-pressed={effectiveScope === 'team'} onClick={() => setScope('team')}>Team</button>
      </span>
    : null;

  const taskRowProps = { data, todayKey, canWrite: canWriteTasks, openTask, onSetTaskStatus };

  return <>
    <section className="workspace-hero">
      <div>
        <span className="eyebrow">ResoFly cockpit</span>
        <h1>{activeOrganization?.name ?? 'ResoFly'}</h1>
        <p>Vandaag, deze week en je projecten — in één beeld, in de volgorde waarin je ze nodig hebt.</p>
      </div>
      <div className="workspace-meta-card">
        <span>Jouw rol</span>
        <strong>{activeRole}</strong>
        <small>{teamMembers.length} actief teamlid{teamMembers.length === 1 ? '' : 'en'}</small>
      </div>
    </section>

    <div className="dash-stats dash-stats-rich">
      {showFinance && <Stat label="Omzet deze maand" value={euro(revenueThisMonth)} tone="accent" trend={revenueTrend} sub={revenueTrend != null ? 'vs. vorige maand' : undefined} spark={revenueSeries} countTo={revenueThisMonth} countFormat={euro} onClick={() => openPage('invoices')} />}
      {showFinance && <Stat label="Openstaand" value={euro(outstandingTotal)} sub={pl(outstandingInvoices.length, 'openstaande factuur', 'openstaande facturen')} onClick={() => openPage('invoices')} />}
      {showFinance && <Stat label="Te laat betaald" value={euro(overdueTotal)} tone={overdueInvoices.length ? 'danger' : 'default'} sub={pl(overdueInvoices.length, 'factuur', 'facturen')} onClick={() => openPage('invoices')} />}
      {permissions.canRead('tickets') && <Stat label="Open tickets" value={openTickets} sub={newTickets ? `${newTickets} nieuw` : undefined} onClick={() => openPage('tickets')} />}
      {showProjects && <Stat label="Open taken" value={openTaskCount} tone={overdueTaskCount ? 'danger' : 'default'} sub={overdueTaskCount ? `${overdueTaskCount} te laat` : undefined} onClick={() => openPage('weekplanner')} />}
      {permissions.canRead('clients') && <Stat label="Actieve klanten" value={activeClients} onClick={() => openPage('clients')} />}
    </div>

    <div className="dash-stack">
      {/* Wat je agents hebben klaargezet staat vóór al het andere: het is het enige
          blok op dit scherm waar iets op JOU wacht in plaats van andersom. De kaart
          verbergt zichzelf zodra de wachtrij leeg is. */}
      {gerrieActions && permissions.canRead('gerrie') && <AgentApprovals
        organizationId={organizationId}
        canWrite={canWriteGerrie}
        handlers={gerrieActions}
        variant="dashboard"
        onOpenCommandCenter={() => openPage('gerrie')}
      />}

      <section className={`dashboard-layout${showToday ? '' : ' dash-layout-single'}`}>
        {showToday && <div className="today-card">
          <header className="dash-card-head">
            <div>
              <h2>Vandaag</h2>
              <p>{capitalize(formatLongDay(startOfToday))}{showProjects ? ` · ${pl(todayOpenCount, 'actie', 'acties')}` : ''}</p>
            </div>
            {showProjects && scopeToggle}
          </header>

          {showProjects && <>
            {lingering.length > 0 && <>
              <div className="dash-group-label dash-group-late"><span>Blijft liggen</span></div>
              {lingering.slice(0, 6).map(task => <TaskRow key={task.id} task={task} {...taskRowProps} />)}
              {lingering.length > 6 && <button type="button" className="dash-more" onClick={() => openPage('weekplanner')}>
                Nog {lingering.length - 6} in de weekplanner <ChevronRight size={13} />
              </button>}
            </>}

            <div className="dash-group-label"><span>{lingering.length > 0 ? 'Gepland voor vandaag' : 'Vandaag'}</span></div>
            {todaysTasks.length === 0
              ? <p className="dash-empty">Niets gepland voor vandaag. Plan werk in de weekplanner of pak iets uit deze week op.</p>
              : todaysTasks.map(task => <TaskRow key={task.id} task={task} {...taskRowProps} />)}
          </>}

          {todaysEvents.length > 0 && <div className="today-agenda">
            {todaysEvents.slice(0, 6).map(event => <button
              key={`${event.source_id}:${event.id}`}
              type="button"
              className="today-ag"
              onClick={() => openPage('calendar')}
              title={`${event.title}${event.location ? ` · ${event.location}` : ''}`}
            >
              <strong>{event.all_day ? 'Hele dag' : formatTime(event.starts_at)}</strong>
              <span>{event.title || 'Afspraak'}</span>
            </button>)}
          </div>}
        </div>}

        <div className="attention-card">
          <header>
            <h2>Vereist je aandacht</h2>
            <p>Klik een regel om er direct heen te gaan</p>
          </header>
          {attention.length === 0
            ? <div className="attention-empty">
                <span className="attention-icon"><CheckCircle2 size={16} /></span>
                <div><strong>Alles is bij</strong>Er staat op dit moment niets open dat je aandacht vraagt.</div>
              </div>
            : <div className="attention-list">
                {attention.map(item => <button type="button" key={item.key} className={`attention-row attention-${item.tone}`} onClick={item.onClick}>
                  <span className="attention-icon">{item.icon}</span>
                  <span className="attention-text"><strong>{item.label}</strong>{item.meta && <span>{item.meta}</span>}</span>
                  <span className="attention-count">{item.count}</span>
                  <ChevronRight size={16} className="attention-chevron" />
                </button>)}
              </div>}
        </div>
      </section>

      {showProjects && <div className="weekactions-card">
        <header className="dash-card-head">
          <div>
            <h2>Weekacties</h2>
            <p>Week {isoWeekNumber(weekStart)} · {formatDayShort(weekStart)} t/m {formatDayShort(addDays(weekStart, 6))} · {pl(weekTasks.length, 'actie', 'acties')}</p>
          </div>
          <div className="dash-head-tools">
            {scopeToggle}
            <button type="button" className="dash-link" onClick={() => openPage('weekplanner')}>Weekplanner <ChevronRight size={14} /></button>
          </div>
        </header>
        <div className="weekactions-panes">
          <WeekPane
            title="Losse taken"
            tone="loose"
            icon={<ListTodo size={14} />}
            tasks={looseWeekTasks}
            dayKeys={weekDayKeys}
            emptyText="Geen losse taken deze week."
            {...taskRowProps}
          />
          <WeekPane
            title="Projecttaken"
            tone="project"
            icon={<FolderOpen size={14} />}
            tasks={projectWeekTasks}
            dayKeys={weekDayKeys}
            emptyText="Geen projecttaken deze week."
            {...taskRowProps}
          />
        </div>
      </div>}

      {showProjects && <ProjectTimeline data={data} openProject={openProject} />}

      <section className="dashboard-layout dash-layout-tail">
        <div className="dash-main">
          {permissions.canRead('stats') && pinnedReports.length > 0 && <div className="dash-reports">
            <header className="dash-reports-head">
              <h2><BarChart3 size={16} /> Mijn rapportages</h2>
              <button type="button" onClick={() => openPage('stats')}>Rapportbouwer <ChevronRight size={14} /></button>
            </header>
            <div className="dash-reports-grid">
              {pinnedReports.map(report => <PinnedReportCard key={report.id} report={report} data={data} onOpen={() => openReport(report.id)} />)}
            </div>
          </div>}
        </div>

        <aside className="dash-side">
          {showOnboarding && <div className="onboarding-card">
            <div className="onboarding-head">
              <div><h3>Workspace setup</h3><p>{onboardingDone}/{onboardingItems.length} stappen afgerond</p></div>
              <strong>{onboardingPct}%</strong>
            </div>
            <div className="prog-bar setup"><div className="prog-fill" style={{ width: `${onboardingPct}%` }} /></div>
            <div className="onboarding-list">
              {onboardingItems.map(item => <div className={`onboarding-row ${item.done ? 'done' : ''}`} key={item.label}><span>{item.done ? '✓' : '•'}</span>{item.label}</div>)}
            </div>
            <Button onClick={openSettings}>Organisatie instellen</Button>
          </div>}

          <div className="activity-card compact-activity">
            <h3>Laatste activiteit</h3>
            {organizationContext.auditLogs.slice(0, 5).map(log => <div className="activity-row" key={log.id}>
              <div><strong>{auditLabel(log.action)}</strong><span>{log.entity_label || log.entity_type}</span></div>
              <time>{formatRelativeTime(log.created_at)}</time>
            </div>)}
            {organizationContext.auditLogs.length === 0 && <p className="settings-help">Nog geen audit-events. Nieuwe wijzigingen worden hier zichtbaar zodra de database-migratie is uitgevoerd.</p>}
          </div>
        </aside>
      </section>
    </div>
  </>;
}

/** Eén kolom van het weekblok: taken per dag, met de dag als kopregel. */
function WeekPane({ title, tone, icon, tasks, dayKeys, emptyText, data, todayKey, canWrite, openTask, onSetTaskStatus }: {
  title: string;
  tone: 'loose' | 'project';
  icon: ReactNode;
  tasks: Task[];
  dayKeys: string[];
  emptyText: string;
  data: AppData;
  todayKey: string;
  canWrite: boolean;
  openTask?: (task: Task) => void;
  onSetTaskStatus?: (task: Task, status: TaskStatus) => void | Promise<void>;
}) {
  const byDay = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = taskDayKey(task);
    if (!key) continue;
    const list = byDay.get(key);
    if (list) list.push(task); else byDay.set(key, [task]);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => priorityRank(b) - priorityRank(a) || a.title.localeCompare(b.title));
  }

  return <section className={`week-pane week-pane-${tone}`}>
    <header className="week-pane-head">
      <span className="week-pane-icon">{icon}</span>
      <h3>{title}</h3>
      <span className="week-pane-count">{tasks.length}</span>
    </header>
    {tasks.length === 0
      ? <p className="dash-empty">{emptyText}</p>
      : dayKeys.map(dayKey => {
          const dayTasks = byDay.get(dayKey);
          if (!dayTasks || dayTasks.length === 0) return null;
          const isToday = dayKey === todayKey;
          return <div className="week-day-block" key={dayKey}>
            <div className={`dash-group-label${isToday ? ' is-today' : ''}`}>
              <span>{formatDayLabel(dayKey)}{isToday ? ' · vandaag' : ''}</span>
            </div>
            {dayTasks.map(task => <TaskRow
              key={task.id}
              task={task}
              data={data}
              todayKey={todayKey}
              canWrite={canWrite}
              openTask={openTask}
              onSetTaskStatus={onSetTaskStatus}
            />)}
          </div>;
        })}
  </section>;
}

/** Eén actieregel: afvinken links, taak openen door op de regel te klikken. */
function TaskRow({ task, data, todayKey, canWrite, openTask, onSetTaskStatus }: {
  task: Task;
  data: AppData;
  todayKey: string;
  canWrite: boolean;
  openTask?: (task: Task) => void;
  onSetTaskStatus?: (task: Task, status: TaskStatus) => void | Promise<void>;
}) {
  const project = task.project_id ? data.projects.find(p => p.id === task.project_id) ?? null : null;
  const clientId = project?.client_id ?? task.client_id ?? null;
  const client = clientId ? data.clients.find(c => c.id === clientId) ?? null : null;
  const done = task.status === 'done';
  const late = !done && isOverdue(task, todayKey);
  const lastDay = taskLastDayKey(task);
  const canToggle = canWrite && Boolean(onSetTaskStatus);

  // Zonder project is "Losse taak" de context; de klant staat er als tweede bij
  // wanneer die er is — een losse taak mag namelijk wél aan een klant hangen.
  const context = project?.name ?? 'Losse taak';
  const secondary = client?.name ?? null;
  const spanning = Boolean(task.planned_date && task.planned_end_date && task.planned_end_date > task.planned_date);

  return <div className={`dash-task${late ? ' is-late' : ''}${done ? ' is-done' : ''}`}>
    <button
      type="button"
      className="dash-task-check"
      aria-pressed={done}
      aria-label={done ? `${task.title} weer openzetten` : `${task.title} afvinken`}
      disabled={!canToggle}
      onClick={() => onSetTaskStatus?.(task, done ? 'todo' : 'done')}
    >
      {done && <CheckCircle2 size={13} aria-hidden="true" />}
    </button>
    <button type="button" className="dash-task-main" onClick={() => openTask?.(task)} disabled={!openTask}>
      <strong>{task.title}</strong>
      <span>
        {context}
        {secondary && <em> · {secondary}</em>}
        {spanning && <em> · t/m {formatDayLabel(task.planned_end_date!)}</em>}
      </span>
    </button>
    <span className="dash-task-tags">
      {late && lastDay && <span className="dash-chip dash-chip-late">{lateLabel(lastDay, todayKey)}</span>}
      {!done && task.priority === 'high' && <span className="dash-chip dash-chip-high">Hoog</span>}
      {task.estimated_minutes != null && task.estimated_minutes > 0 && <span className="dash-task-time">{formatMinutes(task.estimated_minutes)}</span>}
    </span>
  </div>;
}

function PinnedReportCard({ report, data, onOpen }: { report: SavedReport; data: AppData; onOpen: () => void }) {
  const def = report.definition;
  const result = useMemo(() => runReport(def, data), [def, data]);
  const format = (n: number) => formatMeasure(n, result.measureType);
  return (
    <button type="button" className="dash-report-card" onClick={onOpen}>
      <div className="drc-head">
        <span className="drc-name">{report.is_pinned && <Pin size={11} />}{report.name}</span>
        <span className="drc-total">{format(result.total)}</span>
      </div>
      <div className="drc-sub">{result.measureLabel}{result.dimensionLabel ? ` · per ${result.dimensionLabel.toLowerCase()}` : ''}</div>
      <div className="drc-chart">
        {result.rowCount === 0 ? <span className="drc-empty">Geen gegevens</span>
          : def.chart === 'line' ? <LineChart rows={result.rows} format={format} />
          : def.chart === 'pie' ? <PieChart rows={result.rows.slice(0, 6)} format={format} />
          : def.chart === 'kpi' ? <span className="drc-kpi">{format(result.total)}</span>
          : <BarChart rows={result.rows.slice(0, 5)} format={format} />}
      </div>
    </button>
  );
}

function Stat({ label, value, sub, tone = 'default', trend, spark, countTo, countFormat, onClick }: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: StatTone;
  trend?: number | null;
  /** Reeks voor de trendlijn rechtsboven in de kaart (minimaal 2 punten). */
  spark?: number[];
  /** Wanneer gezet telt de kaart bij binnenkomst op naar deze waarde. */
  countTo?: number;
  /** Formatter voor de tellende waarde; zonder deze blijft `value` staan. */
  countFormat?: (n: number) => string;
  onClick?: () => void;
}) {
  const counted = useCountUp(countTo);
  const shown = counted != null && countFormat ? countFormat(counted) : value;
  const hasSpark = Boolean(spark && spark.length > 1);
  const inner = <>
    {hasSpark && <Sparkline values={spark!} tone={tone === 'danger' ? 'danger' : 'accent'} />}
    <div className="sc-label">{label}</div>
    <div className="sc-val">{shown}</div>
    {(sub || trend != null) && <div className="sc-sub">
      {trend != null && <span className={`sc-trend ${trend >= 0 ? 'up' : 'down'}`}>{trend >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(trend)}%</span>}
      {sub && <span>{sub}</span>}
    </div>}
  </>;
  const className = `stat-card stat-card-${tone}${hasSpark ? ' has-spark' : ''}`;
  if (onClick) return <button type="button" className={`${className} stat-card-clickable`} onClick={onClick}>{inner}</button>;
  return <div className={className}>{inner}</div>;
}

// Cent-exacte bruto-totalen via de centrale geldmodule, identiek aan de Financiën-module.
function sumInvoices(invoices: Invoice[]) {
  return invoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
}

function paidDate(invoice: Invoice): Date | null {
  const value = invoice.paid_at ?? invoice.date;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameMonth(date: Date | null, year: number, month: number) {
  return date != null && date.getFullYear() === year && date.getMonth() === month;
}

// Spiegelt de cron-/Financiën-logica: onbetaald én vervaldatum verstreken.
function invoiceOverdue(invoice: Invoice): boolean {
  if (['paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status)) return false;
  if (invoice.status === 'overdue') return true;
  if (!invoice.due_date) return false;
  const due = new Date(invoice.due_date);
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
}

function priorityRank(task: Task): number {
  return task.priority === 'high' ? 2 : task.priority === 'med' ? 1 : 0;
}

/** "gisteren" / "3 dagen te laat" — concreter dan alleen een datum. */
function lateLabel(lastDayKey: string, todayKey: string): string {
  const days = Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${lastDayKey}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return 'te laat';
  if (days === 1) return 'gisteren';
  return `${days} dagen te laat`;
}

function formatDayShort(date: Date) {
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short' }).format(date).replace('.', '');
}

/** "Do 14" voor een ISO-datumsleutel. */
function formatDayLabel(dayKey: string) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1);
  if (Number.isNaN(date.getTime())) return dayKey;
  const weekday = new Intl.DateTimeFormat('nl-NL', { weekday: 'short' }).format(date).replace('.', '');
  return `${capitalize(weekday)} ${date.getDate()}`;
}

function formatLongDay(date: Date) {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function auditLabel(action: string) {
  const labels: Record<string, string> = { created: 'Aangemaakt', updated: 'Bijgewerkt', deleted: 'Verwijderd', invited: 'Uitgenodigd', accepted: 'Geaccepteerd', revoked: 'Ingetrokken', role_changed: 'Rol gewijzigd', disabled: 'Uitgeschakeld' };
  return labels[action] ?? action;
}

function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}
