import type { ReactNode } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronRight, Clock, FileText, Landmark, ListChecks, Percent, Ticket as TicketIcon, Users } from 'lucide-react';
import type { AppData, Invoice, OrganizationContext, Task } from '../types';
import { euro, total } from '../lib/format';
import { Button } from '../components/Ui';
import { ProjectTimeline } from './ProjectTimeline';

export type DashboardNavPage =
  | 'clients' | 'projects' | 'tickets' | 'quotes' | 'invoices' | 'bank' | 'vat-returns' | 'weekplanner' | 'settings';

type StatTone = 'default' | 'accent' | 'danger';
type AttentionItem = { key: string; tone: 'default' | 'danger'; icon: ReactNode; label: string; meta?: string; count: number; onClick: () => void };

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Dashboard({
  data,
  organizationContext,
  openProject,
  openSettings,
  openPage,
}: {
  data: AppData;
  organizationContext: OrganizationContext;
  openProject: (id: string) => void;
  openSettings: () => void;
  openPage: (page: DashboardNavPage) => void;
}) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // ── Financieel ──────────────────────────────────────────────────────────
  const paidInvoices = data.invoices.filter(i => i.status === 'paid');
  const revenueThisMonth = sumInvoices(paidInvoices.filter(i => isSameMonth(paidDate(i), now.getFullYear(), now.getMonth())));
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const revenuePrevMonth = sumInvoices(paidInvoices.filter(i => isSameMonth(paidDate(i), prevMonth.getFullYear(), prevMonth.getMonth())));
  const revenueTrend = revenuePrevMonth > 0 ? Math.round(((revenueThisMonth - revenuePrevMonth) / revenuePrevMonth) * 100) : null;

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

  const openTasks = data.tasks.filter(t => t.status !== 'done').length;
  const overdueTasks = data.tasks.filter(t => t.status !== 'done' && t.end_date && new Date(`${t.end_date}T23:59:59`) < now).length;

  const activeClients = data.clients.filter(c => c.status === 'active').length;

  // ── Deze week (taken met planning/deadline binnen 7 dagen of te laat) ────
  const horizon = new Date(startOfToday);
  horizon.setDate(horizon.getDate() + 7);
  horizon.setHours(23, 59, 59, 999);
  const weekTasks = data.tasks
    .filter(t => t.status !== 'done')
    .map(t => ({ task: t, date: taskDate(t) }))
    .filter((x): x is { task: Task; date: Date } => x.date != null && x.date <= horizon)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 6);

  // ── Vereist je aandacht ─────────────────────────────────────────────────
  const attention: AttentionItem[] = [];
  if (overdueInvoices.length) attention.push({ key: 'overdue-inv', tone: 'danger', icon: <AlertTriangle size={16} />, label: pl(overdueInvoices.length, 'factuur te laat', 'facturen te laat'), meta: `${euro(overdueTotal)} openstaand`, count: overdueInvoices.length, onClick: () => openPage('invoices') });
  if (bankToReconcile) attention.push({ key: 'bank', tone: 'default', icon: <Landmark size={16} />, label: pl(bankToReconcile, 'banktransactie af te letteren', 'banktransacties af te letteren'), count: bankToReconcile, onClick: () => openPage('bank') });
  if (openQuotes) attention.push({ key: 'quotes', tone: 'default', icon: <FileText size={16} />, label: pl(openQuotes, 'offerte open bij klanten', 'offertes open bij klanten'), count: openQuotes, onClick: () => openPage('quotes') });
  if (newTickets) attention.push({ key: 'tickets', tone: 'default', icon: <TicketIcon size={16} />, label: pl(newTickets, 'ticket onbehandeld', 'tickets onbehandeld'), count: newTickets, onClick: () => openPage('tickets') });
  if (overdueTasks) attention.push({ key: 'tasks', tone: 'default', icon: <Clock size={16} />, label: pl(overdueTasks, 'taak over de deadline', 'taken over de deadline'), count: overdueTasks, onClick: () => openPage('weekplanner') });
  if (vatToFile) attention.push({ key: 'vat', tone: 'default', icon: <Percent size={16} />, label: pl(vatToFile, 'btw-aangifte klaar om in te dienen', 'btw-aangiftes klaar om in te dienen'), count: vatToFile, onClick: () => openPage('vat-returns') });

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

  return <>
    <section className="workspace-hero">
      <div>
        <span className="eyebrow">ResoFly cockpit</span>
        <h1>{activeOrganization?.name ?? 'ResoFly'}</h1>
        <p>Direct overzicht over klanten, projecten, tickets, offertes, facturen en teamtoegang — ontworpen als één strakke flow in plaats van losse schermen.</p>
      </div>
      <div className="workspace-meta-card">
        <span>Jouw rol</span>
        <strong>{activeRole}</strong>
        <small>{organizationContext.teamMembers.length} actief teamlid{organizationContext.teamMembers.length === 1 ? '' : 'en'}</small>
      </div>
    </section>

    <div className="dash-stats dash-stats-rich">
      <Stat label="Omzet deze maand" value={euro(revenueThisMonth)} tone="accent" trend={revenueTrend} sub={revenueTrend != null ? 'vs. vorige maand' : undefined} onClick={() => openPage('invoices')} />
      <Stat label="Openstaand" value={euro(outstandingTotal)} sub={pl(outstandingInvoices.length, 'openstaande factuur', 'openstaande facturen')} onClick={() => openPage('invoices')} />
      <Stat label="Te laat betaald" value={euro(overdueTotal)} tone={overdueInvoices.length ? 'danger' : 'default'} sub={pl(overdueInvoices.length, 'factuur', 'facturen')} onClick={() => openPage('invoices')} />
      <Stat label="Open tickets" value={openTickets} sub={newTickets ? `${newTickets} nieuw` : undefined} onClick={() => openPage('tickets')} />
      <Stat label="Open taken" value={openTasks} tone={overdueTasks ? 'danger' : 'default'} sub={overdueTasks ? `${overdueTasks} te laat` : undefined} onClick={() => openPage('weekplanner')} />
      <Stat label="Actieve klanten" value={activeClients} onClick={() => openPage('clients')} />
    </div>

    <section className="dashboard-layout">
      <div className="dash-main">
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

        <ProjectTimeline data={data} openProject={openProject} />
      </div>

      <aside className="dash-side">
        <div className="week-card">
          <h3>Deze week</h3>
          {weekTasks.length === 0
            ? <p className="week-empty">Geen taken met een planning of deadline in de komende 7 dagen.</p>
            : <div className="week-list">
                {weekTasks.map(({ task, date }) => {
                  const project = data.projects.find(p => p.id === task.project_id);
                  const overdue = date < startOfToday;
                  return <button type="button" key={task.id} className={`week-row ${overdue ? 'is-overdue' : ''}`} onClick={() => openProject(task.project_id)}>
                    <span className="week-row-main">
                      <strong>{task.title}</strong>
                      <span>{project?.name ?? 'Project'}</span>
                    </span>
                    <span className="week-date">{overdue ? 'te laat · ' : ''}{formatDayShort(date)}</span>
                  </button>;
                })}
              </div>}
        </div>

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
  </>;
}

function Stat({ label, value, sub, tone = 'default', trend, onClick }: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: StatTone;
  trend?: number | null;
  onClick?: () => void;
}) {
  const inner = <>
    <div className="sc-label">{label}</div>
    <div className="sc-val">{value}</div>
    {(sub || trend != null) && <div className="sc-sub">
      {trend != null && <span className={`sc-trend ${trend >= 0 ? 'up' : 'down'}`}>{trend >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(trend)}%</span>}
      {sub && <span>{sub}</span>}
    </div>}
  </>;
  if (onClick) return <button type="button" className={`stat-card stat-card-${tone} stat-card-clickable`} onClick={onClick}>{inner}</button>;
  return <div className={`stat-card stat-card-${tone}`}>{inner}</div>;
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

function taskDate(task: Task): Date | null {
  const value = task.planned_date ?? task.end_date;
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDayShort(date: Date) {
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short' }).format(date).replace('.', '');
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
