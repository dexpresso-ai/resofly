/**
 * Het logboek: wie wat wanneer en waar heeft aangepast.
 *
 *  - AuditLogPanel: Instellingen → Logboek. Een tijdlijn per dag met per regel
 *    een zin in gewone taal, waar het was (klant, project) en hoe (per veld van
 *    oud naar nieuw, uit te klappen). Filters op periode, persoon, soort, klant
 *    en project, en zoeken. Nieuwe regels meldt hij bovenaan.
 *  - AuditFeed: het blok op het dashboard (vervangt "Laatste activiteit"),
 *    met de laatste regels en een knop naar het hele logboek.
 *
 * Alleen voor owners en admins: de app toont het tabblad en het blok niet aan
 * anderen, en de database geeft hun geen regel (migratie 20261111140000;
 * daarvóór las een teamlid per module mee). De zinnen komen uit
 * src/lib/auditLog.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight, BarChart3, CalendarDays, ChevronDown, ChevronRight, Clock, FileText, FolderKanban, History, Lock, Megaphone,
  Receipt, RefreshCw, ShieldCheck, Ticket as TicketIcon, UserCog, Users, type LucideIcon,
} from 'lucide-react';
import type { AppData, AuditLog, OrganizationMember } from '../types';
import type { Permissions } from '../lib/permissions';
import { Button, Skeleton } from '../components/Ui';
import { SearchFilterPanel, type FilterField } from '../components/SearchFilterPanel';
import { AUDIT_PAGE_SIZE, countAuditLogSince, loadAuditLogPage } from '../lib/repository';
import {
  AUDIT_CATEGORIES, AUDIT_PERIODS, actorEmail, actorName, auditCategory, auditTarget, changeLines, changeSummary, dayLabel,
  groupByDay, relativeTime, sentence, timeLabel, toAuditEntry, viaLabel,
  type AuditCategory, type AuditEntry, type AuditFilters, type AuditLookup, type AuditPeriod, type AuditTarget,
} from '../lib/auditLog';

const CATEGORY_ICON: Record<AuditCategory, LucideIcon> = {
  finance: Receipt, clients: Users, projects: FolderKanban, content: FileText, tickets: TicketIcon, time: Clock,
  calendar: CalendarDays, marketing: Megaphone, stats: BarChart3, team: UserCog, admin: ShieldCheck,
};

/** Welke categorie in het filter staat: wat je in de app ook mag lezen. Het
 *  logboek is alleen voor owners en admins, dus team en beheer altijd. */
function visibleCategories(permissions: Permissions) {
  return AUDIT_CATEGORIES.filter(c => c.key === 'team' || c.key === 'admin' || permissions.canRead(c.key));
}

function useLookup(data: AppData, members: OrganizationMember[], currentUserId: string | null): AuditLookup {
  return useMemo(() => ({
    clients: new Map(data.clients.map(c => [c.id, c.name])),
    projects: new Map(data.projects.map(p => [p.id, p.name])),
    tasks: new Map(data.tasks.map(t => [t.id, t.title])),
    members,
    currentUserId,
  }), [data.clients, data.projects, data.tasks, members, currentUserId]);
}

/** Kan deze regel geopend worden, met de rechten van wie kijkt? */
function canOpen(target: AuditTarget | null, permissions: Permissions, data: AppData): target is AuditTarget {
  if (!target) return false;
  if (target.kind === 'task') return permissions.canRead('projects') && data.tasks.some(t => t.id === target.id);
  if (target.kind === 'project') return permissions.canOpenPage('project') && data.projects.some(p => p.id === target.id);
  if (target.kind === 'client') return permissions.canOpenPage('client') && data.clients.some(c => c.id === target.id);
  return permissions.canOpenPage(target.page);
}

// ── Instellingen → Logboek ─────────────────────────────────────────────────

export function AuditLogPanel({ organizationId, data, members, currentUserId, permissions, onOpenTarget }: {
  organizationId: string;
  data: AppData;
  members: OrganizationMember[];
  currentUserId: string | null;
  permissions: Permissions;
  onOpenTarget?: (target: AuditTarget) => void;
}) {
  const [period, setPeriod] = useState<AuditPeriod>('30d');
  const [actor, setActor] = useState('');
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const seq = useRef(0);
  const lookup = useLookup(data, members, currentUserId);

  const filters: AuditFilters = useMemo(() => ({
    period, actor: actor || undefined, category: category || undefined, clientId: clientId || undefined,
    projectId: projectId || undefined, q: q || undefined,
  }), [period, actor, category, clientId, projectId, q]);

  // Zoeken pas als je even stopt met typen.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (offset: number) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await loadAuditLogPage(organizationId, filters, offset);
      if (mine !== seq.current) return;
      const next = page.rows.map(toAuditEntry);
      setEntries(prev => {
        if (offset === 0) return next;
        const seen = new Set(prev.map(e => e.id));
        return [...prev, ...next.filter(e => !seen.has(e.id))];
      });
      setTotal(page.total);
      if (offset === 0) setFresh(0);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : 'Het logboek kon niet worden geladen.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [organizationId, filters]);

  useEffect(() => { void load(0); }, [load]);

  // Nieuwe regels: elke halve minuut kijken, zolang dit tabblad zichtbaar is.
  const newest = entries[0]?.createdAt ?? null;
  useEffect(() => {
    if (!newest) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void countAuditLogSince(organizationId, newest).then(setFresh);
    };
    const timer = window.setInterval(tick, 30000);
    return () => window.clearInterval(timer);
  }, [organizationId, newest]);

  const categories = visibleCategories(permissions);
  const people = useMemo(() => [...members]
    .filter(m => m.user_id)
    .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? '', 'nl')), [members]);
  const clientOptions = useMemo(() => [...data.clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [data.clients]);
  const projectOptions = useMemo(() => data.projects
    .filter(p => !clientId || p.client_id === clientId)
    .sort((a, b) => a.name.localeCompare(b.name, 'nl')), [data.projects, clientId]);

  const fields: FilterField[] = [
    { key: 'period', label: 'Periode', value: period === '30d' ? '' : period,
      options: [{ value: '', label: '30 dagen' }, ...AUDIT_PERIODS.filter(p => p.value !== '30d').map(p => ({ value: p.value, label: p.label }))] },
    { key: 'actor', label: 'Wie', value: actor, searchable: people.length >= 10,
      options: [{ value: '', label: 'Iedereen' }, ...people.map(m => ({ value: m.user_id, label: m.user_id === currentUserId ? `${m.email ?? 'Jij'} (jij)` : m.email ?? 'Teamlid' })), { value: 'systeem', label: 'Systeem (zonder gebruiker)' }] },
    { key: 'category', label: 'Soort', value: category,
      options: [{ value: '', label: 'Alle soorten' }, ...categories.map(c => ({ value: c.key, label: c.label }))] },
    { key: 'client', label: 'Klant', value: clientId, searchable: true, searchPlaceholder: 'Zoek een klant…',
      options: [{ value: '', label: 'Alle klanten' }, ...clientOptions.map(c => ({ value: c.id, label: c.name }))] },
    { key: 'project', label: 'Project', value: projectId, searchable: true, searchPlaceholder: 'Zoek een project…',
      options: [{ value: '', label: 'Alle projecten' }, ...projectOptions.map(p => ({ value: p.id, label: p.name }))] },
  ];

  function setField(key: string, value: string) {
    if (key === 'period') setPeriod((value || '30d') as AuditPeriod);
    if (key === 'actor') setActor(value);
    if (key === 'category') setCategory(value as AuditCategory | '');
    if (key === 'client') { setClientId(value); setProjectId(''); }
    if (key === 'project') setProjectId(value);
  }

  function reset() {
    setPeriod('30d'); setActor(''); setCategory(''); setClientId(''); setProjectId(''); setSearch(''); setQ('');
  }

  const groups = groupByDay(entries);
  const filtered = Boolean(actor || category || clientId || projectId || q || period !== '30d');
  const more = total !== null ? entries.length < total : entries.length > 0 && entries.length % AUDIT_PAGE_SIZE === 0;

  return <div className="alog">
    <section className="alog-privacy" aria-label="Wat er in het logboek staat">
      <button type="button" className="alog-privacy-head" onClick={() => setPrivacyOpen(open => !open)} aria-expanded={privacyOpen}>
        <Lock size={15} aria-hidden="true" />
        <span>
          <strong>Alleen owners en admins zien het logboek.</strong>
          {' '}Niemand kan het aanpassen of wissen.
        </span>
        <ChevronDown size={16} className={`alog-chevron${privacyOpen ? ' is-open' : ''}`} aria-hidden="true" />
      </button>
      {privacyOpen && <ul>
        <li>De database schrijft het logboek zelf, bij elke wijziging — ook als Gerrie, een agent of de API iets doet namens een teamlid (dan staat er <em>via koppeling</em>), en als de server iets doet zonder gebruiker, zoals een betaling of een synchronisatie (<em>Systeem</em>).</li>
        <li>Teamleden, kijkers en je boekhouder zien het logboek niet: niet hier, niet op het dashboard en ook niet via Gerrie, een agent of de API. Wat zij doen, staat er wel in.</li>
        <li>Van teksten staat alleen <strong>dát</strong> ze veranderden, niet wat erin staat: omschrijvingen, notities, documenten, mails, e-mailadressen, telefoonnummers, adressen en IBAN's. Links, tokens en wachtwoorden nooit.</li>
        <li>De teamchat, meldingen en de titels van afspraken in een privé-agenda staan er niet in.</li>
        <li>Kleine wijzigingen kort na elkaar aan hetzelfde ding (typen, automatisch opslaan) staan samen in één regel, met het aantal. Bij Financiën telt elke stap apart.</li>
      </ul>}
    </section>

    <SearchFilterPanel
      ariaLabel="Zoeken en filteren in het logboek"
      className="is-bar is-wide alog-filters"
      query={search}
      queryPlaceholder="Zoek op naam, nummer of e-mailadres"
      onQueryChange={setSearch}
      visibleCount={entries.length}
      totalCount={total ?? entries.length}
      noun="regels"
      fields={fields}
      onFieldChange={setField}
      onReset={reset}
    />

    {fresh > 0 && <div className="alog-fresh">
      <button type="button" className="btn btn-primary" onClick={() => void load(0)}>
        <RefreshCw size={14} aria-hidden="true" /> {fresh === 1 ? '1 nieuwe wijziging' : `${fresh} nieuwe wijzigingen`} — tonen
      </button>
    </div>}

    {error
      ? <div className="alog-empty">
          <History size={28} aria-hidden="true" />
          <strong>Het logboek kon niet worden geladen</strong>
          <p>{error}</p>
          <Button onClick={() => void load(0)}>Opnieuw proberen</Button>
        </div>
      : loading && entries.length === 0
        ? <Skeleton lines={6} className="alog-skeleton" />
        : entries.length === 0
          ? <div className="alog-empty">
              <History size={28} aria-hidden="true" />
              <strong>{filtered ? 'Geen wijzigingen gevonden' : 'Nog niets in het logboek'}</strong>
              <p>{filtered ? 'Pas de filters of de periode aan.' : 'Zodra iemand iets aanmaakt, verstuurt of wijzigt, staat het hier.'}</p>
            </div>
          : <div className="alog-days">
              {groups.map(group => <section key={group.key} className="alog-day" aria-label={dayLabel(group.key)}>
                <h4 className="alog-day-head">{dayLabel(group.key)} <span>· {group.entries.length}</span></h4>
                <ul className="alog-list">
                  {group.entries.map(entry => <AuditRow
                    key={entry.id}
                    entry={entry}
                    lookup={lookup}
                    data={data}
                    permissions={permissions}
                    onOpenTarget={onOpenTarget}
                  />)}
                </ul>
              </section>)}
              {more && <div className="alog-more">
                <Button onClick={() => void load(entries.length)} disabled={loading}>{loading ? 'Laden…' : 'Meer laden'}</Button>
              </div>}
            </div>}
  </div>;
}

function AuditRow({ entry: e, lookup, data, permissions, onOpenTarget }: {
  entry: AuditEntry;
  lookup: AuditLookup;
  data: AppData;
  permissions: Permissions;
  onOpenTarget?: (target: AuditTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const category = auditCategory(e.entityType);
  const Icon = CATEGORY_ICON[category];
  const lines = changeLines(e, lookup);
  const said = sentence(e, lookup);
  const who = actorName(e, lookup.members, lookup.currentUserId);
  const email = actorEmail(e, lookup.members);
  const client = e.clientId ? lookup.clients?.get(e.clientId) : undefined;
  const project = e.projectId && e.entityType !== 'project' ? lookup.projects?.get(e.projectId) : undefined;
  const target = auditTarget(e);
  const openable = Boolean(onOpenTarget) && canOpen(target, permissions, data);
  const tone = e.action === 'deleted' || /failed|rejected|revoked|disabled|charged_back|cancelled/.test(e.action) ? 'is-removed'
    : e.action === 'created' || /sent|paid|accepted|approved|issued|invited|connected/.test(e.action) ? 'is-added' : '';
  const exact = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeStyle: 'medium' });

  return <li className={`alog-row${open ? ' is-open' : ''}`}>
    <button type="button" className="alog-row-main" onClick={() => setOpen(v => !v)} aria-expanded={open}>
      <span className={`alog-icon cat-${category} ${tone}`} title={AUDIT_CATEGORIES.find(c => c.key === category)?.label}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="alog-body">
        <span className="alog-sentence">
          {!said.subjectless && <><b className="alog-actor" title={email ?? undefined}>{who}</b>{' '}</>}
          {said.parts.map((part, i) => part.strong ? <b key={i}>{part.text}</b> : <span key={i}>{part.text}</span>)}
        </span>
        <span className="alog-meta">
          {client && <span className="alog-chip"><Users size={11} aria-hidden="true" />{client}</span>}
          {project && <span className="alog-chip"><FolderKanban size={11} aria-hidden="true" />{project}</span>}
          {e.count > 1 && <span className="alog-chip is-count" title="Wijzigingen kort na elkaar, samengevoegd">{e.count}×</span>}
          {e.via === 'koppeling' && <span className="alog-chip is-via" title={viaLabel(e.via)}>via koppeling</span>}
          {lines.length > 0 && !open && <span className="alog-summary">{changeSummary(lines)}</span>}
        </span>
      </span>
      <span className="alog-time">
        <time dateTime={e.createdAt}>{timeLabel(e)}</time>
        <ChevronDown size={15} className={`alog-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
      </span>
    </button>
    {open && <div className="alog-details">
      {lines.length > 0 && <dl className="alog-changes">
        {lines.map(line => <div key={line.key}>
          <dt>{line.label}</dt>
          <dd>
            {line.kind === 'changed'
              ? <span className="alog-muted">gewijzigd <small>(de inhoud staat bewust niet in het logboek)</small></span>
              : line.kind === 'snapshot'
                ? <span>{line.to ?? '—'}</span>
                : <span><s>{line.from ?? '—'}</s><span className="alog-arrow" aria-label="werd">→</span><b>{line.to ?? '—'}</b></span>}
          </dd>
        </div>)}
      </dl>}
      <p className="alog-facts">
        <span>{exact.format(new Date(e.createdAt))}{e.count > 1 && ` — tot ${new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short' }).format(new Date(e.lastAt))} (${e.count} wijzigingen)`}</span>
        {email && <span>{email}</span>}
        <span>{viaLabel(e.via)}</span>
        {openable && <button type="button" className="alog-open" onClick={() => onOpenTarget?.(target as AuditTarget)}>Openen <ArrowUpRight size={12} aria-hidden="true" /></button>}
      </p>
    </div>}
  </li>;
}

// ── Het dashboard ─────────────────────────────────────────────────────────

export function AuditFeed({ logs, data, members, currentUserId, permissions, onOpenTarget, onOpenLog, limit = 6 }: {
  logs: AuditLog[];
  data: AppData;
  members: OrganizationMember[];
  currentUserId: string | null;
  permissions: Permissions;
  onOpenTarget?: (target: AuditTarget) => void;
  onOpenLog: () => void;
  limit?: number;
}) {
  const lookup = useLookup(data, members, currentUserId);
  const entries = useMemo(() => logs.slice(0, limit).map(toAuditEntry), [logs, limit]);
  const now = new Date();

  return <div className="activity-card compact-activity alog-feed">
    <div className="alog-feed-head">
      <h3>Logboek</h3>
      <button type="button" className="dash-link" onClick={onOpenLog}>Alles bekijken <ChevronRight size={14} aria-hidden="true" /></button>
    </div>
    {entries.length === 0
      ? <p className="settings-help">Nog niets in het logboek. Zodra iemand iets aanmaakt, verstuurt of wijzigt, staat het hier.</p>
      : <ul className="alog-feed-list">
          {entries.map(e => {
            const category = auditCategory(e.entityType);
            const Icon = CATEGORY_ICON[category];
            const said = sentence(e, lookup);
            const target = auditTarget(e);
            const openable = Boolean(onOpenTarget) && canOpen(target, permissions, data);
            const client = e.clientId ? lookup.clients?.get(e.clientId) : undefined;
            const content = <>
              <span className={`alog-icon cat-${category}`}><Icon size={14} aria-hidden="true" /></span>
              <span className="alog-feed-text">
                <span className="alog-sentence">
                  {!said.subjectless && <><b>{actorName(e, members, currentUserId)}</b>{' '}</>}
                  {said.parts.map((part, i) => part.strong ? <b key={i}>{part.text}</b> : <span key={i}>{part.text}</span>)}
                </span>
                {client && <span className="alog-feed-meta">{client}{e.count > 1 ? ` · ${e.count}×` : ''}</span>}
              </span>
              <time dateTime={e.createdAt}>{relativeTime(e.lastAt, now)}</time>
            </>;
            return <li key={e.id}>
              {openable
                ? <button type="button" className="alog-feed-row" onClick={() => onOpenTarget?.(target as AuditTarget)}>{content}</button>
                : <div className="alog-feed-row">{content}</div>}
            </li>;
          })}
        </ul>}
  </div>;
}
