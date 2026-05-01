import type { AppData, OrganizationContext } from '../types';
import { euro } from '../lib/format';
import { Button } from '../components/Ui';

export function Dashboard({
  data,
  organizationContext,
  openProject,
  openSettings,
}: {
  data: AppData;
  organizationContext: OrganizationContext;
  openProject: (id: string) => void;
  openSettings: () => void;
}) {
  const openTasks = data.tasks.filter(t => t.status !== 'done').length;
  const dueTasks = data.tasks.filter(t => t.status !== 'done' && t.end_date && new Date(`${t.end_date}T23:59:59`) < new Date()).length;
  const revenue = data.invoices
    .filter(i => i.status === 'paid')
    .reduce((s, i) => s + (i.lines ?? []).reduce((a, l) => a + l.quantity * l.unit_price * (1 + l.vat / 100), 0), 0);
  const activeClients = data.clients.filter(c => c.status === 'active').length;
  const activeProjects = data.projects.filter(p => !p.archived);
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

  return <>
    <section className="workspace-hero">
      <div>
        <span className="eyebrow">Werkruimte</span>
        <h1>{activeOrganization?.name ?? 'BrandCore'}</h1>
        <p>Dagelijkse cockpit voor je organisatie: klanten, projecten, taken, tickets, offertes, facturen en teamtoegang zitten onder dezelfde tenant.</p>
      </div>
      <div className="workspace-meta-card">
        <span>Jouw rol</span>
        <strong>{activeRole}</strong>
        <small>{organizationContext.teamMembers.length} actief teamlid{organizationContext.teamMembers.length === 1 ? '' : 'en'}</small>
      </div>
    </section>

    <div className="dash-stats">
      <Stat label="Actieve klanten" value={activeClients}/>
      <Stat label="Projecten" value={activeProjects.length}/>
      <Stat label="Open taken" value={openTasks}/>
      <Stat label="Taken te laat" value={dueTasks}/>
      <Stat label="Betaald" value={euro(revenue)}/>
    </div>

    <section className="dashboard-layout">
      <div className="dash-main">
        <div className="section-head-inline">
          <div>
            <h2>Actieve projecten</h2>
            <p>Open snel een project en bewaak de voortgang per werkstroom.</p>
          </div>
        </div>
        <div className="dash-grid">
          {activeProjects.map(project => {
            const tasks = data.tasks.filter(t => t.project_id === project.id);
            const done = tasks.filter(t => t.status === 'done').length;
            const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
            const client = data.clients.find(c => c.id === project.client_id);
            return <article className="proj-card" key={project.id} onClick={() => openProject(project.id)}>
              <div className="pc-name">{project.name}</div><p className="pc-desc">{project.description ?? 'Geen omschrijving'}</p>
              <div className="prog-bar"><div className="prog-fill" style={{ width: `${pct}%`, background: project.color }}/></div>
              <div className="pc-bottom"><span className="pc-tasks">{done}/{tasks.length} taken · {pct}%</span><span className="tag-pill">{client?.name ?? 'Geen klant'}</span></div>
            </article>;
          })}
          {activeProjects.length === 0 && <div className="empty inline-empty"><div className="e-big">Nog geen actieve projecten</div><p>Maak links een nieuw project aan of zet een ticket om naar project.</p></div>}
        </div>
      </div>

      <aside className="dash-side">
        <div className="onboarding-card">
          <div className="onboarding-head">
            <div><h3>Sprint 1 setup</h3><p>{onboardingDone}/{onboardingItems.length} stappen afgerond</p></div>
            <strong>{onboardingPct}%</strong>
          </div>
          <div className="prog-bar setup"><div className="prog-fill" style={{ width: `${onboardingPct}%` }}/></div>
          <div className="onboarding-list">
            {onboardingItems.map(item => <div className={`onboarding-row ${item.done ? 'done' : ''}`} key={item.label}><span>{item.done ? '✓' : '•'}</span>{item.label}</div>)}
          </div>
          <Button onClick={openSettings}>Organisatie instellen</Button>
        </div>

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
function Stat({ label, value }: { label: string; value: string | number }) { return <div className="stat-card"><div className="sc-label">{label}</div><div className="sc-val">{value}</div></div>; }
function auditLabel(action: string) {
  const labels: Record<string, string> = { created: 'Aangemaakt', updated: 'Bijgewerkt', deleted: 'Verwijderd', invited: 'Uitgenodigd', accepted: 'Geaccepteerd', revoked: 'Ingetrokken', role_changed: 'Rol gewijzigd', disabled: 'Uitgeschakeld' };
  return labels[action] ?? action;
}
function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}
