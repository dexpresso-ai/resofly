import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar } from './components/Sidebar';
import { Button, Input, Select, Textarea } from './components/Ui';
import { RichTextEditor, sanitizeRichText } from './components/RichTextEditor';
import { Modal } from './components/Modal';
import { isSupabaseConfigured, supabase, supabaseAuth } from './lib/supabase';
import {
  acceptOrganizationInvitation,
  convertAcceptedQuoteToInvoice,
  convertTicketToProject,
  createClientWithServerCode,
  createNoteCalendarLink,
  createNoteWithCalendarLink,
  createOrganization,
  deleteEntityCascade,
  deleteNoteCalendarLink,
  disableOrganizationMember,
  insertRow,
  inviteOrganizationMember,
  loadAppData,
  loadOrganizationContext,
  previewNextClientCode,
  revokeOrganizationInvitation,
  submitQuoteForInternalApproval,
  approveQuoteInternal,
  rejectQuoteInternal,
  sendInvoiceEmailViaResend,
  sendQuoteEmailViaResend,
  createInvoicePaymentCheckout,
  updateOrganizationMemberRole,
  updateRow,
  upsertCompanySettings,
  type Table,
} from './lib/repository';
import { uploadToR2 } from './lib/r2';
import { Dashboard } from './features/Dashboard';
import { ClientDetailPage, Clients } from './features/Clients';
import { ProjectPage, ProjectsListPage } from './features/Projects';
import { Tickets } from './features/Tickets';
import { Notes, RelatedNotes, noteTypeLabels } from './features/Notes';
import { Invoices, Quotes } from './features/Finance';
import { PublicQuotePage } from './features/PublicQuotePage';
import { PublicInvoicePage } from './features/PublicInvoicePage';
import { Archive, Settings, Stats } from './features/SimplePages';
import { CalendarPage } from './features/CalendarPage';
import { WeekPlanner } from './features/WeekPlanner';
import { AttachmentList } from './components/AttachmentList';
import { exportFinancePDF } from './lib/pdf';
import type {
  AppData, CalendarExternalEvent, CalendarNoteLinkInput, Client, CompanySettingsInput, EntityType, FinanceLine, Invoice, Note, OrganizationContext, OrganizationRole, Project, Quote, Task, TaskStatus, Ticket, Subtask, Comment as TaskComment,
} from './types';
import { euro, total, uid } from './lib/format';
import './styles/globals.css';

type Page = 'dashboard'|'weekplanner'|'calendar'|'calendar-settings'|'stats'|'notes'|'clients'|'client'|'projects'|'tickets'|'quotes'|'invoices'|'archive'|'settings'|'project';
type EditMode =
  | { kind: 'client'; item?: Client }
  | { kind: 'project'; item?: Project }
  | { kind: 'task'; item?: Task; projectId: string }
  | { kind: 'ticket'; item?: Ticket }
  | { kind: 'note'; item?: Note; defaults?: Partial<Pick<Note, 'client_id' | 'project_id' | 'title' | 'content' | 'note_type' | 'tags'>>; calendarLink?: CalendarNoteLinkInput }
  | { kind: 'quote'; item?: Quote; defaults?: Partial<Pick<Quote, 'client_id' | 'project_id'>> }
  | { kind: 'invoice'; item?: Invoice; defaults?: Partial<Pick<Invoice, 'client_id' | 'project_id'>> }
  | null;

const emptyData: AppData = { clients: [], projects: [], tasks: [], tickets: [], notes: [], noteCalendarLinks: [], quotes: [], quoteApprovalEvents: [], quoteEmailDeliveries: [], quoteVersions: [], invoices: [], invoiceWorkflowEvents: [], invoiceEmailDeliveries: [], invoicePaymentRecords: [], invoiceVersions: [], attachments: [], companySettings: null };
const emptyOrganizationContext: OrganizationContext = { memberships: [], organizations: [], activeOrganization: null, activeMembership: null, teamMembers: [], pendingInvitations: [], organizationInvitations: [], licenseUsage: null, auditLogs: [], billingOverview: null };
const activeOrgStorageKey = 'brandcore.activeOrganizationId';

const editKindToTable: Record<NonNullable<EditMode>['kind'], Table> = {
  client: 'clients',
  project: 'projects',
  task: 'tasks',
  ticket: 'tickets',
  note: 'notes',
  quote: 'quotes',
  invoice: 'invoices',
};

const editKindToEntity: Record<NonNullable<EditMode>['kind'], EntityType> = {
  client: 'client',
  project: 'project',
  task: 'task',
  ticket: 'ticket',
  note: 'note',
  quote: 'quote',
  invoice: 'invoice',
};


function getPublicQuoteTokenFromLocation(): string | null {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('quote_token') || url.searchParams.get('token');
  if (queryToken) return queryToken;
  const match = url.pathname.match(/^\/quote\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getPublicInvoiceTokenFromLocation(): string | null {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('invoice_token');
  if (queryToken) return queryToken;
  const match = url.pathname.match(/^\/invoice\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function App() {
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [data, setData] = useState<AppData>(emptyData);
  const [organizationContext, setOrganizationContext] = useState<OrganizationContext>(emptyOrganizationContext);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(() => localStorage.getItem(activeOrgStorageKey));
  const [page, setPage] = useState<Page>('dashboard');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditMode>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicQuoteToken = getPublicQuoteTokenFromLocation();
  const publicInvoiceToken = getPublicInvoiceTokenFromLocation();

  // Track which user + organization we have loaded data for, so auth events do not
  // trigger duplicate refreshes for the same workspace.
  const loadedForRef = useRef<string | null>(null);

  const activeOrganization = organizationContext.activeOrganization;
  const activeMembership = organizationContext.activeMembership;
  const canWrite = activeMembership ? ['owner', 'admin', 'member'].includes(activeMembership.role) : false;
  const canAdmin = activeMembership ? ['owner', 'admin'].includes(activeMembership.role) : false;

  async function loadWorkspace(preferredOrganizationId = activeOrganizationId) {
    setLoading(true); setError(null);
    try {
      const orgContext = await loadOrganizationContext(preferredOrganizationId);
      setOrganizationContext(orgContext);
      const orgId = orgContext.activeOrganization?.id ?? null;
      setActiveOrganizationId(orgId);
      if (orgId) {
        localStorage.setItem(activeOrgStorageKey, orgId);
        setData(await loadAppData(orgId));
      } else {
        localStorage.removeItem(activeOrgStorageKey);
        setData(emptyData);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Onbekende fout');
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await loadWorkspace(activeOrganizationId);
  }

  async function switchOrganization(organizationId: string) {
    setProjectId(null);
    setClientId(null);
    setPage('dashboard');
    loadedForRef.current = null;
    await loadWorkspace(organizationId);
  }

  async function createNewOrganization() {
    const name = prompt('Naam van de nieuwe organisatie');
    if (!name?.trim()) return;
    setLoading(true); setError(null);
    try {
      const org = await createOrganization(name);
      await switchOrganization(org.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Organisatie aanmaken mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function inviteMember(email: string, role: OrganizationRole) {
    if (!ensureCanAdmin()) throw new Error('Alleen owners en admins kunnen teamleden uitnodigen.');
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    await inviteOrganizationMember(activeOrganizationId, email, role);
    await loadWorkspace(activeOrganizationId);
  }

  async function acceptInvitation(invitationId: string) {
    const membership = await acceptOrganizationInvitation(invitationId);
    await switchOrganization(membership.organization_id);
  }

  async function changeMemberRole(memberId: string, role: OrganizationRole) {
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    if (!activeMembership || activeMembership.role !== 'owner') throw new Error('Alleen owners kunnen rollen wijzigen.');
    await updateOrganizationMemberRole(memberId, activeOrganizationId, role);
    await loadWorkspace(activeOrganizationId);
  }

  async function disableMember(memberId: string) {
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    if (!activeMembership || activeMembership.role !== 'owner') throw new Error('Alleen owners kunnen teamleden uitschakelen.');
    await disableOrganizationMember(memberId, activeOrganizationId);
    await loadWorkspace(activeOrganizationId);
  }

  async function revokeInvitation(invitationId: string) {
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    if (!ensureCanAdmin()) throw new Error('Alleen owners en admins kunnen uitnodigingen intrekken.');
    await revokeOrganizationInvitation(invitationId, activeOrganizationId);
    await loadWorkspace(activeOrganizationId);
  }

  function ensureCanWrite(): boolean {
    if (canWrite) return true;
    setError('Je hebt alleen-lezen toegang tot deze organisatie. Vraag een owner/admin om schrijfrechten.');
    return false;
  }

  function ensureCanAdmin(): boolean {
    if (canAdmin) return true;
    setError('Alleen owners en admins kunnen deze organisatie-instellingen aanpassen.');
    return false;
  }

  useEffect(() => {
    let active = true;

    async function applySession(session: { user: { id: string } } | null) {
      if (!active) return;
      const userId = session?.user.id ?? null;
      setLoggedIn(Boolean(session));
      setCurrentUserId(userId);
      setSessionReady(true);
      if (userId && userId !== loadedForRef.current) {
        loadedForRef.current = userId;
        await loadWorkspace(localStorage.getItem(activeOrgStorageKey));
      } else if (!userId) {
        loadedForRef.current = null;
        localStorage.removeItem(activeOrgStorageKey);
        setActiveOrganizationId(null);
        setOrganizationContext(emptyOrganizationContext);
        setData(emptyData);
      }
    }

    supabaseAuth.getSession().then(({ data }) => { void applySession(data.session); });
    const { data: sub } = supabaseAuth.onAuthStateChange((_event, session) => { void applySession(session); });

    return () => { active = false; sub.subscription.unsubscribe(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const project = useMemo(() => data.projects.find(p => p.id === projectId) ?? null, [data.projects, projectId]);
  const client = useMemo(() => data.clients.find(c => c.id === clientId) ?? null, [data.clients, clientId]);

  if (!isSupabaseConfigured) return <div className="boot"><div className="login-card"><h1>Configuratie ontbreekt</h1><p>Vul eerst VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in .env.local in.</p></div></div>;
  if (publicQuoteToken) return <PublicQuotePage token={publicQuoteToken} />;
  if (publicInvoiceToken) return <PublicInvoicePage token={publicInvoiceToken} />;
  if (!sessionReady) return <div className="boot">ResoFly laden…</div>;
  if (!loggedIn) return <Login />;
  if (!activeOrganization) return <div className="boot"><div className="login-card"><h1>Geen organisatie gevonden</h1><p>Er kon geen organisatie voor je account worden geladen.</p><Button variant="primary" onClick={createNewOrganization}>Organisatie maken</Button></div></div>;

  const activeOrg = activeOrganization;

  async function saveEdit(values: Record<string, unknown>) {
    if (!edit) return;
    if (!ensureCanWrite()) return;
    setLoading(true); setError(null);
    try {
      switch (edit.kind) {
        case 'client': {
          const duplicateIssue = findClientDuplicateIssue(data.clients, values, edit.item);
          if (duplicateIssue?.blocksSave) throw new Error(duplicateIssue.message);

          edit.item
            ? await updateRow<Client>('clients', edit.item.id, values, activeOrg.id)
            : await createClientWithServerCode(activeOrg.id, values);
          break;
        }
        case 'project': {
          const projectValues = {
            ...values,
            archived: typeof values.archived === 'boolean' ? values.archived : false,
          };

          edit.item
            ? await updateRow<Project>('projects', edit.item.id, projectValues, activeOrg.id)
            : await insertRow<Project>('projects', activeOrg.id, projectValues);
          break;
        }
        case 'task':
          edit.item
            ? await updateRow<Task>('tasks', edit.item.id, values, activeOrg.id)
            : await insertRow<Task>('tasks', activeOrg.id, { ...values, project_id: edit.projectId });
          break;
        case 'ticket': {
          const sanitizedValues = sanitizeTicketValues(values, edit.item);
          edit.item
            ? await updateRow<Ticket>('tickets', edit.item.id, sanitizedValues, activeOrg.id)
            : await insertRow<Ticket>('tickets', activeOrg.id, sanitizedValues);
          break;
        }
        case 'note': {
          if (edit.item) {
            await updateRow<Note>('notes', edit.item.id, values, activeOrg.id);
          } else if (edit.calendarLink) {
            await createNoteWithCalendarLink(activeOrg.id, values, edit.calendarLink);
          } else {
            await insertRow<Note>('notes', activeOrg.id, values);
          }
          break;
        }
        case 'quote':
          edit.item
            ? await updateRow<Quote>('quotes', edit.item.id, values, activeOrg.id)
            : await insertRow<Quote>('quotes', activeOrg.id, values);
          break;
        case 'invoice':
          edit.item
            ? await updateRow<Invoice>('invoices', edit.item.id, values, activeOrg.id)
            : await insertRow<Invoice>('invoices', activeOrg.id, values);
          break;
      }
      setEdit(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function removeCurrent() {
    if (!edit || !('item' in edit) || !edit.item) return;
    if (!ensureCanWrite()) return;
    if (!confirm('Weet je zeker dat je dit item wilt verwijderen? Bijbehorende bijlagen worden ook verwijderd.')) return;
    setLoading(true); setError(null);
    try {
      const table = editKindToTable[edit.kind];
      await deleteEntityCascade(table, edit.item.id, activeOrg.id);
      setEdit(null);
      // If we just deleted the active project, navigate away.
      if (edit.kind === 'project' && projectId === edit.item.id) {
        setProjectId(null);
        setPage('projects');
      }
      if (edit.kind === 'client' && clientId === edit.item.id) {
        setClientId(null);
        setPage('clients');
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function setTaskStatus(task: Task, status: TaskStatus) {
    if (!ensureCanWrite()) return;
    setError(null);
    try { await updateRow<Task>('tasks', task.id, { status }, activeOrg.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Status bijwerken mislukt'); }
  }

  async function updateTaskDate(taskId: string, endDate: string | null) {
    if (!ensureCanWrite()) return;
    setError(null);
    await updateRow<Task>('tasks', taskId, { end_date: endDate }, activeOrg.id);
    await refresh();
  }

  async function convert(ticket: Ticket) {
    if (!ensureCanWrite()) return;
    if (!confirm(`Ticket "${ticket.title}" omzetten naar een project? Dit kan niet ongedaan worden gemaakt.`)) return;
    setLoading(true); setError(null);
    try {
      const project = await convertTicketToProject(ticket, activeOrg.id);
      await refresh();
      setProjectId(project.id);
      setPage('project');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Conversie mislukt');
    } finally {
      setLoading(false);
    }
  }


  async function submitQuoteApproval(quote: Quote) {
    if (!ensureCanWrite()) return;
    if (!confirm(`Offerte ${quote.number} ter interne goedkeuring indienen?`)) return;
    setLoading(true); setError(null);
    try {
      await submitQuoteForInternalApproval(activeOrg.id, quote.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte indienen mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function approveQuote(quote: Quote) {
    if (!ensureCanAdmin()) return;
    if (!confirm(`Offerte ${quote.number} intern goedkeuren? Daarna kan deze via Resend naar de klant.`)) return;
    setLoading(true); setError(null);
    try {
      await approveQuoteInternal(activeOrg.id, quote.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte goedkeuren mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function rejectQuote(quote: Quote) {
    if (!ensureCanAdmin()) return;
    const note = prompt(`Waarom wijs je offerte ${quote.number} intern af?`, quote.internal_rejection_note || '');
    if (note === null) return;
    setLoading(true); setError(null);
    try {
      await rejectQuoteInternal(activeOrg.id, quote.id, note);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte afwijzen mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function sendQuote(quote: Quote) {
    if (!ensureCanWrite()) return;
    const client = data.clients.find(item => item.id === quote.client_id);
    const recipientEmail = prompt('Naar welk e-mailadres wil je de offerte versturen?', client?.email || '');
    if (!recipientEmail) return;
    const recipientName = prompt('Naam/contactpersoon voor de e-mail', client?.contact_name || client?.name || '') || undefined;
    setLoading(true); setError(null);
    try {
      await sendQuoteEmailViaResend(activeOrg.id, quote.id, { recipientEmail, recipientName });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte verzenden via Resend mislukt');
    } finally {
      setLoading(false);
    }
  }


  async function convertQuoteToInvoice(quote: Quote) {
    if (!ensureCanWrite()) return;
    if (quote.status !== 'accepted') {
      setError('Alleen geaccepteerde offertes kunnen worden omgezet naar een factuur.');
      return;
    }
    if (!confirm(`Factuur maken van offerte ${quote.number}? Dit gebeurt server-side en voorkomt dubbele facturen bij dubbelklikken.`)) return;
    setLoading(true); setError(null);
    try {
      const invoice = await convertAcceptedQuoteToInvoice(activeOrg.id, quote.id);
      await refresh();
      setPage('invoices');
      setEdit({ kind: 'invoice', item: invoice });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte omzetten naar factuur mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function sendInvoice(invoice: Invoice) {
    if (!ensureCanWrite()) return;
    const client = data.clients.find(item => item.id === invoice.client_id);
    const recipientEmail = prompt('Naar welk e-mailadres wil je de factuur versturen?', client?.email || '');
    if (!recipientEmail) return;
    const recipientName = prompt('Naam/contactpersoon voor de e-mail', client?.contact_name || client?.name || '') || undefined;
    setLoading(true); setError(null);
    try {
      await sendInvoiceEmailViaResend(activeOrg.id, invoice.id, { recipientEmail, recipientName });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Factuur verzenden via Resend mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function createInvoicePayment(invoice: Invoice) {
    if (!ensureCanWrite()) return;
    if (['paid','cancelled','void','written_off'].includes(invoice.status)) {
      setError('Voor deze factuur kan geen betaallink worden aangemaakt.');
      return;
    }
    setLoading(true); setError(null);
    try {
      const result = await createInvoicePaymentCheckout(activeOrg.id, invoice.id, {
        idempotencyKey: `invoice-${invoice.id}-active-payment`,
      });
      await refresh();
      if (result.checkoutUrl && confirm('Betaallink is aangemaakt. Wil je de link nu openen?')) {
        window.open(result.checkoutUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mollie-betaallink aanmaken mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function saveCompanySettings(values: CompanySettingsInput) {
    if (!ensureCanAdmin()) throw new Error('Alleen owners en admins kunnen deze organisatie-instellingen aanpassen.');
    setLoading(true); setError(null);
    try {
      await upsertCompanySettings(activeOrg.id, values);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bedrijfsinstellingen opslaan mislukt');
      throw e;
    } finally {
      setLoading(false);
    }
  }

  function calendarNoteLinkInput(event: CalendarExternalEvent): CalendarNoteLinkInput {
    return {
      provider: event.provider,
      calendar_source_id: event.source_id,
      provider_event_id: event.provider_event_id,
      event_starts_at: event.starts_at,
      event_ends_at: event.ends_at,
      event_title_snapshot: event.visibility === 'organization' && !event.is_private_masked ? event.title : null,
      event_location_snapshot: event.visibility === 'organization' && !event.is_private_masked ? event.location : null,
      event_html_link: event.visibility === 'organization' && !event.is_private_masked ? event.html_link : null,
      visibility_snapshot: event.visibility,
      is_private_masked_snapshot: Boolean(event.is_private_masked),
    };
  }

  function openNoteForCalendarEvent(event: CalendarExternalEvent) {
    if (!ensureCanWrite()) return;
    if (event.visibility !== 'organization' || event.is_private_masked) {
      setError('Notities koppelen is bewust uitgeschakeld voor privé-afspraken. Deel de agenda eerst met de organisatie of voeg later persoonlijke notities toe.');
      return;
    }
    setError(null);
    setEdit({
      kind: 'note',
      item: undefined,
      defaults: {
        title: `Notitie: ${event.title}`,
        content: '',
        note_type: 'meeting',
        tags: ['agenda'],
      },
      calendarLink: calendarNoteLinkInput(event),
    });
  }

  async function linkExistingNoteToCalendarEvent(noteId: string, event: CalendarExternalEvent) {
    if (!ensureCanWrite()) return;
    setLoading(true); setError(null);
    try {
      await createNoteCalendarLink(activeOrg.id, noteId, calendarNoteLinkInput(event));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Notitie koppelen aan agenda-item mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function unlinkNoteFromCalendarEvent(linkId: string) {
    if (!ensureCanWrite()) return;
    if (!confirm('Deze notitie loskoppelen van dit agenda-item? De notitie zelf blijft bestaan.')) return;
    setLoading(true); setError(null);
    try {
      await deleteNoteCalendarLink(linkId, activeOrg.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Notitie ontkoppelen mislukt');
    } finally {
      setLoading(false);
    }
  }

  const title = page === 'project' ? project?.name ?? 'Project' : page === 'client' ? client?.name ?? 'Klant' : ({dashboard:'Dashboard',weekplanner:'Weekplanner',calendar:'Kalender','calendar-settings':'Agenda-instellingen',stats:'Statistieken',notes:'Notities',clients:'Klanten',projects:'Projecten',tickets:'Tickets',quotes:'Offertes',invoices:'Facturen',archive:'Archief',settings:'Instellingen',project:'Project',client:'Klant'} as Record<Page,string>)[page];

  return <div className="app">
    <Sidebar page={page} organizations={organizationContext.organizations} activeOrganizationId={activeOrg.id} activeRole={activeMembership?.role ?? null} onOrganization={switchOrganization} onNewOrganization={createNewOrganization} onPage={(p) => { setPage(p); setProjectId(null); setClientId(null); }}/>
    <main className="main"><header className="topbar"><div><div className="topbar-eyebrow">ResoFly workspace</div><div className="topbar-title">{title}</div></div><div className="topbar-actions">{!canWrite && <span className="status-pill readonly">Alleen lezen</span>}<Button onClick={refresh}>{loading ? 'Laden…' : 'Ververs'}</Button><Button onClick={() => supabaseAuth.signOut()}>Uitloggen</Button></div></header>
      <section className="content">{error && <div className="error">{error}</div>}{renderPage()}</section>
    </main>{edit && <EditModal edit={edit} data={data} organizationId={activeOrg.id} canWrite={canWrite} readOnly={!canWrite} onClose={() => setEdit(null)} onSave={saveEdit} onDelete={removeCurrent} onAttachmentsChanged={refresh} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewClientNote={(client) => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { client_id: client.id }})} />}
  </div>;

  function renderPage() {
    if (page === 'dashboard') return <Dashboard data={data} organizationContext={organizationContext} openProject={(id) => { setProjectId(id); setPage('project'); }} openSettings={() => setPage('settings')} />;
    if (page === 'project' && project) return <ProjectPage data={data} project={project} canWrite={canWrite} canAdmin={canAdmin} onNewTask={() => ensureCanWrite() && setEdit({kind:'task', projectId: project.id})} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: project.id})} onEditProject={() => setEdit({kind:'project', item: project})} onNewQuote={() => ensureCanWrite() && setEdit({kind:'quote', defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditQuote={(quote) => setEdit({kind:'quote', item: quote})} onSubmitQuoteApproval={submitQuoteApproval} onApproveQuote={approveQuote} onRejectQuote={rejectQuote} onSendQuote={sendQuote} onConvertQuoteToInvoice={convertQuoteToInvoice} onNewNote={() => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditNote={(note) => setEdit({kind:'note', item: note})} setTaskStatus={setTaskStatus}/>;
    if (page === 'projects') return <ProjectsListPage data={data} canWrite={canWrite} onNewProject={() => ensureCanWrite() && setEdit({kind:'project'})} onOpenProject={(item) => { setProjectId(item.id); setClientId(null); setPage('project'); }} onEditProject={(item) => setEdit({kind:'project', item})}/>;
    if (page === 'client' && client) return <ClientDetailPage data={data} client={client} canWrite={canWrite} onBack={() => { setClientId(null); setPage('clients'); }} onEditClient={() => setEdit({kind:'client', item: client})} onNewQuote={() => ensureCanWrite() && setEdit({kind:'quote', defaults: { client_id: client.id }})} onEditQuote={(item)=>setEdit({kind:'quote', item})} onNewInvoice={() => ensureCanWrite() && setEdit({kind:'invoice', defaults: { client_id: client.id }})} onEditInvoice={(item)=>setEdit({kind:'invoice', item})} onOpenProject={(project) => { setProjectId(project.id); setClientId(null); setPage('project'); }} onNewNote={() => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { client_id: client.id }})} onEditNote={(note) => setEdit({kind:'note', item: note})}/>;
    if (page === 'clients') return <Clients data={data} onNew={() => ensureCanWrite() && setEdit({kind:'client'})} onOpen={(item)=>{ setClientId(item.id); setProjectId(null); setPage('client'); }}/>;
    if (page === 'tickets') return <Tickets data={data} onNew={() => ensureCanWrite() && setEdit({kind:'ticket'})} onEdit={(item)=>setEdit({kind:'ticket', item})} onConvert={convert}/>;
    if (page === 'notes') return <Notes data={data} onNew={() => ensureCanWrite() && setEdit({kind:'note'})} onEdit={(item)=>setEdit({kind:'note', item})}/>;
    if (page === 'quotes') return <Quotes data={data} canWrite={canWrite} canAdmin={canAdmin} onNew={() => ensureCanWrite() && setEdit({kind:'quote'})} onEdit={(item)=>setEdit({kind:'quote', item})} onSubmitApproval={submitQuoteApproval} onApprove={approveQuote} onReject={rejectQuote} onSend={sendQuote} onConvertToInvoice={convertQuoteToInvoice}/>;
    if (page === 'invoices') return <Invoices data={data} canWrite={canWrite} onNew={() => ensureCanWrite() && setEdit({kind:'invoice'})} onEdit={(item)=>setEdit({kind:'invoice', item})} onSend={sendInvoice} onCreatePayment={createInvoicePayment}/>;
    if (page === 'weekplanner') return <WeekPlanner data={data} canWrite={canWrite} onUpdateTaskDate={updateTaskDate} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})}/>;
    if (page === 'calendar') return <CalendarPage mode="agenda" organizationId={activeOrg.id} currentUserId={currentUserId} data={data} canWrite={canWrite} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onNewNoteForEvent={openNoteForCalendarEvent} onEditNote={(note) => setEdit({kind:'note', item: note})} onLinkExistingNoteToEvent={linkExistingNoteToCalendarEvent} onUnlinkNoteFromEvent={unlinkNoteFromCalendarEvent}/>;
    if (page === 'calendar-settings') return <CalendarPage mode="settings" organizationId={activeOrg.id} currentUserId={currentUserId} data={data} canWrite={canWrite} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onNewNoteForEvent={openNoteForCalendarEvent} onEditNote={(note) => setEdit({kind:'note', item: note})} onLinkExistingNoteToEvent={linkExistingNoteToCalendarEvent} onUnlinkNoteFromEvent={unlinkNoteFromCalendarEvent}/>;
    if (page === 'stats') return <Stats data={data}/>;
    if (page === 'archive') return <Archive data={data} onOpen={(id) => { setProjectId(id); setPage('project'); }} onRestore={async (project) => { if (!ensureCanWrite()) return; setError(null); try { await updateRow<Project>('projects', project.id, { archived: false }, activeOrg.id); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Herstellen mislukt'); } }}/>;
    if (page === 'settings') return <Settings settings={data.companySettings} organizationContext={organizationContext} currentUserId={currentUserId} onCreateOrganization={createNewOrganization} onSwitchOrganization={switchOrganization} onInviteMember={inviteMember} onAcceptInvitation={acceptInvitation} onUpdateMemberRole={changeMemberRole} onDisableMember={disableMember} onRevokeInvitation={revokeInvitation} onSave={saveCompanySettings}/>;
    return <div className="empty"><div className="e-big">Geen project geselecteerd</div></div>;
  }
}

function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signIn() {
    setError(null);
    const { error } = await supabaseAuth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (error) setError(error.message); else setSent(true);
  }
  return <main className="login"><div className="login-card"><div className="app-brand"><div className="brand-icon">R</div><span>ResoFly</span></div><p className="eyebrow login-eyebrow">Tickets • Projecten • Serviceflows</p><h1>Werkruimte</h1><p>Login met je e-mailadres om je CRM/project-app te gebruiken.</p><Input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="jij@bedrijf.nl"/><Button variant="primary" onClick={signIn} disabled={!email}>Stuur magic link</Button>{sent && <p className="success">Check je mailbox. Open de link in dezelfde browser als waar je deze pagina hebt geopend.</p>}{error && <p className="error">{error}</p>}</div></main>;
}

function EditModal({ edit, data, organizationId, canWrite, readOnly, onClose, onSave, onDelete, onAttachmentsChanged, onEditNote, onNewClientNote }: { edit: NonNullable<EditMode>; data: AppData; organizationId: string; canWrite: boolean; readOnly: boolean; onClose: () => void; onSave: (v: Record<string, unknown>) => void; onDelete: () => void; onAttachmentsChanged: () => void; onEditNote: (note: Note) => void; onNewClientNote: (client: Client) => void }) {
  const item = 'item' in edit ? edit.item : undefined;
  const [form, setForm] = useState<Record<string, any>>(() => initialForm(edit, data));
  const set = (k: string, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    let cancelled = false;
    if (edit.kind !== 'client' || item || readOnly || !canWrite) return;

    previewNextClientCode(organizationId)
      .then(code => {
        if (!cancelled && code) {
          setForm(prev => ({ ...prev, client_code: code }));
        }
      })
      .catch(error => {
        console.warn('Klantnummer-preview kon niet worden opgehaald.', error);
      });

    return () => { cancelled = true; };
  }, [canWrite, edit.kind, item, organizationId, readOnly]);

  const title = `${item ? 'Bewerk' : 'Nieuw'} ${edit.kind}`;
  const quoteWorkflowLocked = edit.kind === 'quote' && item ? isQuoteWorkflowLocked(item as Quote) : false;
  const effectiveReadOnly = readOnly || quoteWorkflowLocked;
  const disabled = effectiveReadOnly;
  const clientDuplicateIssue = useMemo(() => {
    if (edit.kind !== 'client') return null;

    // Bij een nieuwe klant is client_code slechts een server-preview.
    // De definitieve waarde wordt atomair in Postgres/RPC toegekend, dus voorkom
    // dat een stale preview de frontend onterecht blokkeert.
    const duplicateValues = item ? form : { ...form, client_code: '' };
    return findClientDuplicateIssue(data.clients, duplicateValues, item as Client | undefined);
  }, [data.clients, edit.kind, form, item]);
  const saveBlockedByDuplicate = Boolean(clientDuplicateIssue?.blocksSave);

  const attachmentBlock = item ? <AttachmentList
    attachments={data.attachments}
    entityType={editKindToEntity[edit.kind]}
    entityId={item.id}
    onChanged={onAttachmentsChanged}
    canDelete={!effectiveReadOnly}
  /> : null;

  const modalClassName = [
    edit.kind === 'note' ? 'modal-note-editor' : '',
    edit.kind === 'quote' || edit.kind === 'invoice' ? 'modal-finance-editor' : '',
    edit.kind === 'quote' ? 'modal-quote-editor' : '',
    edit.kind === 'client' ? 'modal-client-editor' : '',
  ].filter(Boolean).join(' ');

  return <Modal title={title} className={modalClassName} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{effectiveReadOnly ? 'Sluiten' : 'Annuleren'}</Button>{!effectiveReadOnly && item && <Button variant="danger" onClick={onDelete}>Verwijderen</Button>}{!effectiveReadOnly && <Button variant="primary" onClick={() => onSave(cleanForm(edit.kind, form))} disabled={saveBlockedByDuplicate}>Opslaan</Button>}</>}>
    {readOnly && <div className="readonly-note">Je bekijkt dit item met alleen-lezen rechten. Wijzigen, verwijderen en uploaden zijn uitgeschakeld.</div>}
    {quoteWorkflowLocked && <div className="readonly-note">Deze offerte zit al in de goedkeuringsflow. Inhoudelijke velden zijn vergrendeld zodat een goedgekeurde of verzonden offerte niet ongemerkt kan wijzigen.</div>}
    {edit.kind === 'client' && <FormGrid className="client-form-grid">
      <section className="client-form-intro">
        <div>
          <span>Klantdossier</span>
          <h3>{item ? 'Klantgegevens bijwerken' : 'Nieuwe klant aanmaken'}</h3>
          <p>Het klantnummer wordt server-side voorgesteld en definitief toegekend bij opslaan. Zo blijft de reeks veilig, ook als twee teamleden tegelijk een klant aanmaken.</p>
        </div>
        <strong>{form.client_code || 'Wordt automatisch gevuld'}</strong>
      </section>
      <Field label="Klantnaam">
        <Input value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Bijv. Acme BV" disabled={disabled}/>
      </Field>
      <Field label="Klantnummer" hint={item ? "Bestaand klantnummer. Wijzig dit alleen bewust." : "Preview vanuit Supabase. Bij opslaan wordt het definitieve nummer atomair gereserveerd."}>
        <Input value={form.client_code} onChange={e=>set('client_code',e.target.value)} placeholder="Wordt door de server aangemaakt" disabled={disabled || !item}/>
      </Field>
      <Field label="Contactpersoon">
        <Input value={form.contact_name} onChange={e=>set('contact_name',e.target.value)} placeholder="Naam contactpersoon" disabled={disabled}/>
      </Field>
      <Field label="E-mail">
        <Input value={form.email} onChange={e=>set('email',e.target.value)} placeholder="contact@bedrijf.nl" disabled={disabled}/>
      </Field>
      {clientDuplicateIssue && <div className={`client-duplicate-notice ${clientDuplicateIssue.severity}`}>
        <strong>{clientDuplicateIssue.title}</strong>
        <span>{clientDuplicateIssue.message}</span>
      </div>}
      <Field label="Telefoon">
        <Input value={form.phone} onChange={e=>set('phone',e.target.value)} placeholder="Telefoonnummer" disabled={disabled}/>
      </Field>
      <Field label="Status">
        <Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={disabled}><option value="active">Actief</option><option value="prospect">Prospect</option><option value="inactive">Inactief</option></Select>
      </Field>
      <Field label="Klantwaarde" hint="Indicatieve waarde voor dashboard en klantoverzicht.">
        <Input type="number" value={form.value_eur} onChange={e=>set('value_eur',Number(e.target.value))} placeholder="Waarde" disabled={disabled}/>
      </Field>
      <Field label="Tags" hint="Gebruik komma’s om meerdere tags toe te voegen.">
        <Input value={form.tags} onChange={e=>set('tags',e.target.value)} placeholder="VIP, Retainer, Lead" disabled={disabled}/>
      </Field>
      <Field label="Notities">
        <Textarea value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="Interne klantnotities" disabled={disabled}/>
      </Field>
      {item && <RelatedNotes title="Klantnotities" notes={data.notes.filter(note => note.client_id === item.id || data.projects.some(project => project.client_id === item.id && project.id === note.project_id))} data={data} canWrite={canWrite} onNew={() => onNewClientNote(item as Client)} onEdit={onEditNote} emptyText="Nog geen notities bij deze klant." />}
      {!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.client} id={item.id} onUploaded={onAttachmentsChanged}/>}
      {attachmentBlock}
    </FormGrid>}
    {edit.kind === 'project' && <FormGrid><Input value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Projectnaam"/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Omschrijving"/><Input type="date" value={form.start_date} onChange={e=>set('start_date',e.target.value)}/><Input type="date" value={form.end_date} onChange={e=>set('end_date',e.target.value)}/><Input value={form.color} onChange={e=>set('color',e.target.value)} placeholder="#FFD966"/><label className="check-row"><input type="checkbox" checked={Boolean(form.archived)} onChange={e=>set('archived',e.target.checked)}/><span>Project archiveren</span></label>{!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.project} id={item.id} onUploaded={onAttachmentsChanged}/>}{attachmentBlock}</FormGrid>}
    {edit.kind === 'task' && <FormGrid><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Taaktitel"/><Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={disabled}><option value="todo">Te doen</option><option value="doing">Bezig</option><option value="review">Review</option><option value="done">Klaar</option></Select><Select value={form.priority} onChange={e=>set('priority',e.target.value)}><option value="low">Laag</option><option value="med">Normaal</option><option value="high">Hoog</option></Select><Input value={form.tags} onChange={e=>set('tags',e.target.value)} placeholder="Tags"/><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Beschrijving"/><Input type="date" value={form.start_date} onChange={e=>set('start_date',e.target.value)}/><Input type="date" value={form.end_date} onChange={e=>set('end_date',e.target.value)}/><TaskDetailEditor subtasks={form.subtasks} comments={form.comments} set={set}/>{!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.task} id={item.id} onUploaded={onAttachmentsChanged}/>}{attachmentBlock}</FormGrid>}
    {edit.kind === 'ticket' && <FormGrid><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Ticket titel"/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Select value={form.priority} onChange={e=>set('priority',e.target.value)}><option value="low">Laag</option><option value="med">Normaal</option><option value="high">Hoog</option></Select><Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={Boolean((item as Ticket | undefined)?.converted_to_project_id)}><option value="new">Nieuw</option><option value="review">Review</option><option value="approved">Goedgekeurd</option><option value="rejected">Geweigerd</option>{(item as Ticket | undefined)?.converted_to_project_id && <option value="converted">Omgezet</option>}</Select><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Beschrijving"/><Textarea value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="Interne notities"/><small className="ticket-status-hint">Gebruik <strong>Project maken</strong> om een ticket om te zetten. <strong>Omgezet</strong> is geen handmatige status.</small>{!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.ticket} id={item.id} onUploaded={onAttachmentsChanged}/>}{attachmentBlock}</FormGrid>}
    {edit.kind === 'note' && <FormGrid><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Titel"/><Select value={form.note_type} onChange={e=>set('note_type',e.target.value)}>{Object.entries(noteTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><RichTextEditor value={form.content} onChange={value=>set('content', value)} placeholder="Schrijf je notitie…" disabled={disabled}/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Select value={form.project_id} onChange={e=>set('project_id',e.target.value)} disabled={disabled}><option value="">Geen project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select><Input value={form.tags} onChange={e=>set('tags',e.target.value)} placeholder="Tags, komma gescheiden" />{item && <div className="note-created-meta"><span>Aangemaakt: {new Date((item as Note).created_at).toLocaleString('nl-NL')}</span><span>Bijgewerkt: {new Date((item as Note).updated_at).toLocaleString('nl-NL')}</span></div>}{!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.note} id={item.id} onUploaded={onAttachmentsChanged}/>}{attachmentBlock}</FormGrid>}
    {(edit.kind === 'quote' || edit.kind === 'invoice') && <FinanceForm kind={edit.kind} data={data} organizationId={organizationId} form={form} set={set} item={item} readOnly={effectiveReadOnly} onUploaded={onAttachmentsChanged} attachmentBlock={attachmentBlock}/>}
  </Modal>;
}

function FormGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <div className={`form-grid ${className}`.trim()}>{children}</div>; }

function normalizeSubtasks(value: unknown): Subtask[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = item as Partial<Subtask> | undefined;
      return {
        id: String(source?.id || uid()),
        label: String(source?.label || '').trim(),
        done: Boolean(source?.done),
      };
    })
    .filter((item) => item.id);
}

function normalizeComments(value: unknown): TaskComment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = item as Partial<TaskComment> | undefined;
      return {
        id: String(source?.id || uid()),
        text: String(source?.text || '').trim(),
        author: source?.author ? String(source.author).trim() : undefined,
        created_at: source?.created_at ? String(source.created_at) : new Date().toISOString(),
      };
    })
    .filter((item) => item.id && item.text);
}

function TaskDetailEditor({ subtasks, comments, set }: { subtasks: Subtask[]; comments: TaskComment[]; set: (k: string, v: unknown) => void }) {
  const safeSubtasks = normalizeSubtasks(subtasks);
  const safeComments = normalizeComments(comments);
  const [draftComment, setDraftComment] = useState('');
  const doneCount = safeSubtasks.filter(s => s.done).length;

  const updateSubtask = (id: string, patch: Partial<Subtask>) => {
    set('subtasks', safeSubtasks.map(subtask => subtask.id === id ? { ...subtask, ...patch } : subtask));
  };

  const addSubtask = () => {
    set('subtasks', [...safeSubtasks, { id: uid(), label: '', done: false }]);
  };

  const removeSubtask = (id: string) => {
    set('subtasks', safeSubtasks.filter(subtask => subtask.id !== id));
  };

  const addComment = () => {
    const text = draftComment.trim();
    if (!text) return;
    set('comments', [{ id: uid(), text, created_at: new Date().toISOString() }, ...safeComments]);
    setDraftComment('');
  };

  const removeComment = (id: string) => {
    if (!confirm('Deze reactie verwijderen?')) return;
    set('comments', safeComments.filter(comment => comment.id !== id));
  };

  return <div className="task-detail-editor">
    <section className="task-editor-section">
      <div className="tes-head">
        <div><strong>Subtaken</strong><span>{doneCount}/{safeSubtasks.length} afgerond</span></div>
        <Button onClick={addSubtask}>+ Subtaak</Button>
      </div>
      <div className="subtask-list">
        {safeSubtasks.map(subtask => <div className="subtask-row" key={subtask.id}>
          <input type="checkbox" checked={subtask.done} onChange={e => updateSubtask(subtask.id, { done: e.target.checked })}/>
          <Input value={subtask.label} onChange={e => updateSubtask(subtask.id, { label: e.target.value })} placeholder="Bijv. feedback verwerken" />
          <Button variant="ghost" onClick={() => removeSubtask(subtask.id)}>×</Button>
        </div>)}
        {safeSubtasks.length === 0 && <div className="task-empty-line">Nog geen subtaken. Voeg concrete stappen toe om voortgang zichtbaar te maken.</div>}
      </div>
    </section>

    <section className="task-editor-section">
      <div className="tes-head"><div><strong>Comments</strong><span>{safeComments.length} reactie(s)</span></div></div>
      <div className="comment-composer">
        <Textarea value={draftComment} onChange={e => setDraftComment(e.target.value)} placeholder="Schrijf een update, beslissing of overdracht…" />
        <Button onClick={addComment} disabled={!draftComment.trim()}>Plaats comment</Button>
      </div>
      <div className="comment-list">
        {safeComments.map(comment => <article className="comment-item" key={comment.id}>
          <div className="comment-head"><span>{new Date(comment.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><button type="button" onClick={() => removeComment(comment.id)}>Verwijderen</button></div>
          <p>{comment.text}</p>
        </article>)}
        {safeComments.length === 0 && <div className="task-empty-line">Nog geen comments.</div>}
      </div>
    </section>
  </div>;
}


function FileUpload({ organizationId, entity, id, onUploaded }: { organizationId: string; entity: EntityType; id: string; onUploaded: () => void }) {
  const [msg, setMsg] = useState('');
  return <div className="file-upload">
    <input type="file" onChange={async e => {
      const f = e.target.files?.[0];
      if (!f) return;
      setMsg('Uploaden…');
      try {
        await uploadToR2(f, organizationId, { entity_type: entity, entity_id: id });
        setMsg(`Upload klaar: ${f.name}`);
        onUploaded();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Upload mislukt');
      } finally {
        // Allow re-uploading the same file: clear the input.
        e.target.value = '';
      }
    }}/>
    {msg && <small>{msg}</small>}
  </div>;
}


function isQuoteWorkflowLocked(quote: Quote): boolean {
  return quote.status !== 'draft';
}

function FinanceForm({ kind, data, organizationId, form, set, item, readOnly, onUploaded, attachmentBlock }: { kind: 'quote'|'invoice'; data: AppData; organizationId: string; form: Record<string, any>; set: (k:string,v:unknown)=>void; item?: { id: string }; readOnly: boolean; onUploaded: () => void; attachmentBlock: React.ReactNode }) {
  const lines: FinanceLine[] = Array.isArray(form.lines) ? form.lines : [];
  const disabled = readOnly;
  const isQuote = kind === 'quote';
  const amounts = total(lines);
  const selectedClientId = typeof form.client_id === 'string' ? form.client_id : '';
  const projectOptions = data.projects.filter(project => {
    if (!selectedClientId) return true;
    return project.client_id === selectedClientId || !project.client_id || project.id === form.project_id;
  });

  const updateLine = (id: string, k: keyof FinanceLine, v: string | number) => set('lines', lines.map(l => l.id === id ? { ...l, [k]: k === 'description' ? v : Number(v) } : l));
  const addLine = () => set('lines', [...lines, { id: uid(), description: '', quantity: 1, unit_price: 0, vat: 21 }]);
  const removeLine = (id: string) => set('lines', lines.length <= 1 ? lines : lines.filter(x => x.id !== id));

  const handleDownloadPdf = () => {
    const client = data.clients.find(c => c.id === form.client_id) ?? null;
    // Build a doc-shaped object from the current form so the user can preview before saving.
    const docLike = {
      id: item?.id ?? '',
      number: form.number || createFallbackFinanceNumber(kind),
      date: form.date,
      valid_until: form.valid_until ?? null,
      due_date: form.due_date ?? null,
      lines: lines ?? [],
      notes: form.notes ?? null,
      status: form.status ?? 'draft',
      client_id: form.client_id ?? null,
      project_id: form.project_id ?? null,
    } as unknown as Quote & Invoice;
    void exportFinancePDF(docLike, kind, client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt'));
  };

  return <div className={`finance-editor ${isQuote ? 'quote-editor' : 'invoice-editor'}`}>
    <section className="finance-editor-hero">
      <div>
        <span>{isQuote ? 'Offerte aanmaken' : 'Factuur aanmaken'}</span>
        <h3>{form.number || createFallbackFinanceNumber(kind)}</h3>
        <p>{isQuote ? 'Het offertenummer wordt automatisch voorgesteld en is direct zichtbaar. Je kunt het nummer nog wijzigen vóór opslaan.' : 'Het factuurnummer wordt automatisch voorgesteld en is direct zichtbaar.'}</p>
      </div>
      <div className="finance-editor-totals" aria-label="Totaalberekening">
        <FinanceTotal label="Excl. btw" value={euro(amounts.subtotal)} />
        <FinanceTotal label="BTW" value={euro(amounts.vat)} />
        <FinanceTotal label="Totaal" value={euro(amounts.total)} strong />
      </div>
    </section>

    <section className="finance-editor-section">
      <div className="finance-section-head"><strong>Basisgegevens</strong><span>Klant, project en documentnummer</span></div>
      <div className="finance-form-grid">
        <Field label={isQuote ? 'Offertenummer' : 'Factuurnummer'} hint="Automatisch gegenereerd, maar nog handmatig aanpasbaar vóór opslaan.">
          <Input value={form.number} onChange={e=>set('number',e.target.value)} placeholder={isQuote ? 'OFF-2026-0001' : 'FAC-2026-0001'} disabled={disabled}/>
        </Field>
        <Field label="Klant" hint="Koppel de offerte aan de juiste relatie.">
          <Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}>
            <option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Project" hint="Optioneel, maar sterk aanbevolen voor context en rapportage.">
          <Select value={form.project_id} onChange={e=>set('project_id',e.target.value)} disabled={disabled}>
            <option value="">Geen project</option>{projectOptions.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        {isQuote ? <div className="readonly-workflow-status finance-status-card"><span>Offertestatus</span><strong>{quoteFormStatusLabel(form.status, form.internal_approval_status)}</strong><small>Status loopt via de goedkeuringsflow, niet via handmatig opslaan.</small></div> : <Field label="Factuurstatus" hint="Status van de factuur.">
          <Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={disabled}>
            <option value="draft">Concept</option>
            <option value="sent">Verzonden</option>
            <option value="overdue">Te laat</option>
            <option value="paid">Betaald</option>
            <option value="cancelled">Geannuleerd</option>
            <option value="void">Ongeldig gemaakt</option>
            <option value="written_off">Afgeboekt</option>
          </Select>
        </Field>}
      </div>
    </section>

    <section className="finance-editor-section finance-date-section">
      <div className="finance-section-head"><strong>{isQuote ? 'Offertedatums' : 'Factuurdatums'}</strong><span>Maak publicatie- en verloopdatum expliciet zichtbaar</span></div>
      <div className="finance-date-grid">
        <Field label={isQuote ? 'Offertedatum' : 'Factuurdatum'} hint="De datum waarop het document wordt opgesteld.">
          <Input type="date" value={form.date} onChange={e=>set('date',e.target.value)} disabled={disabled}/>
        </Field>
        <Field label={isQuote ? 'Verloopdatum' : 'Vervaldatum'} hint={isQuote ? 'Tot wanneer de offerte geldig blijft.' : 'Uiterste betaaldatum voor de factuur.'}>
          <Input type="date" value={isQuote ? form.valid_until : form.due_date} onChange={e=>set(isQuote ? 'valid_until' : 'due_date',e.target.value)} disabled={disabled}/>
        </Field>
      </div>
    </section>

    <section className="finance-editor-section finance-lines-section">
      <div className="finance-section-head finance-lines-head">
        <div><strong>{isQuote ? 'Offerteregels' : 'Factuurregels'}</strong><span>Omschrijving, aantallen, prijs per stuk en btw staan nu duidelijk naast elkaar.</span></div>
        <Button onClick={addLine} disabled={disabled}>+ Regel</Button>
      </div>
      <div className="finance-lines-table" role="table" aria-label={isQuote ? 'Offerteregels' : 'Factuurregels'}>
        <div className="finance-line-header" role="row">
          <span>Regelomschrijving</span>
          <span>Aantal</span>
          <span>Prijs ex. btw</span>
          <span>BTW %</span>
          <span>Regeltotaal</span>
          <span />
        </div>
        {lines.map(line => {
          const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
          const vatAmount = subtotal * Number(line.vat || 0) / 100;
          return <div className="finance-line-row" role="row" key={line.id}>
            <Field label="Regelomschrijving" compact>
              <Input value={line.description} onChange={e=>updateLine(line.id,'description',e.target.value)} placeholder="Bijv. Strategie, ontwerp en implementatie" disabled={disabled}/>
            </Field>
            <Field label="Aantal" compact>
              <Input type="number" min="0" step="0.01" value={line.quantity} onChange={e=>updateLine(line.id,'quantity',e.target.value)} disabled={disabled}/>
            </Field>
            <Field label="Prijs ex. btw" compact>
              <Input type="number" min="0" step="0.01" value={line.unit_price} onChange={e=>updateLine(line.id,'unit_price',e.target.value)} disabled={disabled}/>
            </Field>
            <Field label="BTW %" compact>
              <Input type="number" min="0" step="0.01" value={line.vat} onChange={e=>updateLine(line.id,'vat',e.target.value)} disabled={disabled}/>
            </Field>
            <div className="finance-line-total"><span>Regeltotaal</span><strong>{euro(subtotal + vatAmount)}</strong></div>
            <Button className="finance-line-remove" onClick={()=>removeLine(line.id)} disabled={disabled || lines.length <= 1} title="Regel verwijderen">×</Button>
          </div>;
        })}
      </div>
    </section>

    <section className="finance-editor-section">
      <div className="finance-section-head"><strong>Notities</strong><span>Interne toelichting of aanvullende voorwaarden</span></div>
      <Textarea value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="Bijv. geldigheid, voorwaarden of aanvullende afspraken" disabled={disabled}/>
    </section>

    <div className="finance-actions"><Button onClick={handleDownloadPdf} disabled={!lines || lines.length === 0}>Download PDF</Button></div>
    {!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity[kind]} id={item.id} onUploaded={onUploaded}/>} 
    {attachmentBlock}
  </div>;
}

function Field({ label, hint, compact = false, children }: { label: string; hint?: string; compact?: boolean; children: React.ReactNode }) {
  return <label className={`field ${compact ? 'field-compact' : ''}`}>
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>;
}

function FinanceTotal({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`finance-total ${strong ? 'strong' : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>;
}

type ClientDuplicateIssue = {
  severity: 'warning' | 'block';
  blocksSave: boolean;
  title: string;
  message: string;
};

function normalizeClientText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeClientEmail(value: unknown): string {
  return normalizeClientText(value);
}

function normalizeClientCode(value: unknown): string {
  return normalizeClientText(value);
}

function normalizeClientPhone(value: unknown): string {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

function clientLabel(client: Client): string {
  return `${client.name}${client.client_code ? ` (${client.client_code})` : ''}`;
}

function findClientDuplicateIssue(clients: Client[], values: Record<string, unknown>, currentClient?: Client): ClientDuplicateIssue | null {
  const candidates = clients.filter(client => client.id !== currentClient?.id);
  const code = normalizeClientCode(values.client_code);
  const email = normalizeClientEmail(values.email);
  const name = normalizeClientText(values.name);
  const phone = normalizeClientPhone(values.phone);
  const contactName = normalizeClientText(values.contact_name);

  if (code) {
    const duplicate = candidates.find(client => normalizeClientCode(client.client_code) === code);
    if (duplicate) {
      return {
        severity: 'block',
        blocksSave: true,
        title: 'Klantnummer bestaat al',
        message: `Klantnummer ${values.client_code} is al gekoppeld aan ${clientLabel(duplicate)}. Kies een ander nummer of open de bestaande klant.`,
      };
    }
  }

  if (email) {
    const duplicate = candidates.find(client => normalizeClientEmail(client.email) === email);
    if (duplicate) {
      return {
        severity: 'block',
        blocksSave: true,
        title: 'Deze klant lijkt al te bestaan',
        message: `Er bestaat binnen deze organisatie al een klant met dit e-mailadres: ${clientLabel(duplicate)}. Open de bestaande klant of gebruik een ander e-mailadres.`,
      };
    }
  }

  if (name && phone) {
    const duplicate = candidates.find(client => normalizeClientText(client.name) === name && normalizeClientPhone(client.phone) === phone);
    if (duplicate) {
      return {
        severity: 'block',
        blocksSave: true,
        title: 'Dubbele klant gevonden',
        message: `Naam en telefoonnummer komen overeen met ${clientLabel(duplicate)}. Open de bestaande klant of pas de gegevens aan.`,
      };
    }
  }

  if (name && contactName) {
    const duplicate = candidates.find(client => normalizeClientText(client.name) === name && normalizeClientText(client.contact_name) === contactName);
    if (duplicate) {
      return {
        severity: 'block',
        blocksSave: true,
        title: 'Dubbele klant gevonden',
        message: `Naam en contactpersoon komen overeen met ${clientLabel(duplicate)}. Open de bestaande klant of pas de gegevens aan.`,
      };
    }
  }

  if (name) {
    const duplicate = candidates.find(client => normalizeClientText(client.name) === name);
    if (duplicate) {
      return {
        severity: 'warning',
        blocksSave: false,
        title: 'Let op: dezelfde klantnaam bestaat al',
        message: `Er staat al een klant met deze naam in deze organisatie: ${clientLabel(duplicate)}. Opslaan mag nog, maar controleer even of dit geen dubbel dossier wordt.`,
      };
    }
  }

  return null;
}

function createNextFinanceNumber(kind: 'quote' | 'invoice', data: AppData, date = new Date()): string {
  const prefix = kind === 'quote' ? 'OFF' : 'FAC';
  const year = date.getFullYear();
  const documents = kind === 'quote' ? data.quotes : data.invoices;
  const pattern = new RegExp(`^${prefix}-${year}-(\\d+)$`, 'i');
  const highest = documents.reduce((max, document) => {
    const match = String(document.number || '').match(pattern);
    const parsed = match ? Number.parseInt(match[1], 10) : NaN;
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  return `${prefix}-${year}-${String(highest + 1).padStart(4, '0')}`;
}

function createFallbackFinanceNumber(kind: 'quote' | 'invoice'): string {
  const prefix = kind === 'quote' ? 'OFF' : 'FAC';
  return `${prefix}-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
}

function quoteFormStatusLabel(status: string, approvalStatus?: string): string {
  if (status === 'draft' && approvalStatus === 'rejected') return 'Intern afgewezen';
  const labels: Record<string, string> = {
    draft: 'Concept',
    pending_internal_approval: 'Wacht op interne goedkeuring',
    internally_approved: 'Intern goedgekeurd',
    sent: 'Verzonden',
    accepted: 'Geaccepteerd',
    rejected: 'Afgewezen door klant',
    expired: 'Verlopen',
    cancelled: 'Geannuleerd',
  };
  return labels[status] || status || 'Concept';
}


function normalizeOptionalText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function sanitizeTicketValues(values: Record<string, unknown>, existingTicket?: Ticket): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...values };
  delete sanitized.converted_to_project_id;

  const requestedStatus = typeof sanitized.status === 'string' ? sanitized.status : undefined;
  const ticketIsActuallyConverted = Boolean(existingTicket?.converted_to_project_id);

  if (ticketIsActuallyConverted) {
    sanitized.status = 'converted';
    return sanitized;
  }

  if (requestedStatus === 'converted') {
    sanitized.status = existingTicket?.status && existingTicket.status !== 'converted' ? existingTicket.status : 'new';
  }

  return sanitized;
}

function initialForm(edit: NonNullable<EditMode>, data: AppData): Record<string, any> {
  if (edit.kind === "client") {
    const item = edit.item;
    return { name: item?.name ?? "", client_code: item?.client_code ?? "", contact_name: item?.contact_name ?? "", email: item?.email ?? "", phone: item?.phone ?? "", status: item?.status ?? "active", value_eur: item?.value_eur ?? 0, tags: item?.tags?.join(", ") ?? "", notes: item?.notes ?? "", color: item?.color ?? "#FFD966" };
  }
  if (edit.kind === "project") {
    const item = edit.item;
    return { name: item?.name ?? "", client_id: item?.client_id ?? "", description: item?.description ?? "", color: item?.color ?? "#FFD966", archived: item?.archived ?? false, start_date: item?.start_date ?? "", end_date: item?.end_date ?? "" };
  }
  if (edit.kind === "task") {
    const item = edit.item;
    return { title: item?.title ?? "", description: item?.description ?? "", status: item?.status ?? "todo", priority: item?.priority ?? "med", tags: item?.tags?.join(", ") ?? "", start_date: item?.start_date ?? "", end_date: item?.end_date ?? "", subtasks: normalizeSubtasks(item?.subtasks), comments: normalizeComments(item?.comments) };
  }
  if (edit.kind === "ticket") {
    const item = edit.item;
    return { title: item?.title ?? "", description: item?.description ?? "", client_id: item?.client_id ?? "", priority: item?.priority ?? "med", status: item?.status ?? "new", notes: item?.notes ?? "" };
  }
  if (edit.kind === "note") {
    const item = edit.item;
    return { title: item?.title ?? edit.defaults?.title ?? "", content: item?.content ?? edit.defaults?.content ?? "", note_type: item?.note_type ?? edit.defaults?.note_type ?? "general", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", tags: item?.tags?.join(", ") ?? edit.defaults?.tags?.join(", ") ?? "" };
  }
  const today = new Date().toISOString().slice(0,10);
  if (edit.kind === "quote") {
    const item = edit.item;
    return { number: item?.number ?? createNextFinanceNumber('quote', data), client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", date: item?.date ?? today, valid_until: item?.valid_until ?? "", status: item?.status ?? "draft", internal_approval_status: item?.internal_approval_status ?? "draft", notes: item?.notes ?? "", lines: item?.lines ?? [{ id: uid(), description: "", quantity: 1, unit_price: 0, vat: 21 }] };
  }
  const item = edit.item;
  return { number: item?.number ?? createNextFinanceNumber('invoice', data), client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", date: item?.date ?? today, due_date: item?.due_date ?? "", status: item?.status ?? "draft", notes: item?.notes ?? "", lines: item?.lines ?? [{ id: uid(), description: "", quantity: 1, unit_price: 0, vat: 21 }] };
}

function cleanForm(kind: string, form: Record<string, any>) {
  const cleaned: Record<string, any> = { ...form };
  if (kind === 'client') {
    cleaned.name = String(cleaned.name ?? '').trim();
    cleaned.client_code = normalizeOptionalText(cleaned.client_code);
    cleaned.contact_name = normalizeOptionalText(cleaned.contact_name);
    cleaned.email = normalizeOptionalText(cleaned.email)?.toLowerCase() ?? null;
    cleaned.phone = normalizeOptionalText(cleaned.phone);
    cleaned.notes = normalizeOptionalText(cleaned.notes);
  }
  for (const key of ["client_id","project_id","quote_id","valid_until","due_date","start_date","end_date"]) {
    if (cleaned[key] === "") cleaned[key] = null;
  }
  if ("tags" in cleaned && typeof cleaned.tags === "string") {
    cleaned.tags = cleaned.tags.split(",").map((x:string)=>x.trim()).filter(Boolean);
  }
  if (kind === 'note') {
    cleaned.note_type = typeof cleaned.note_type === 'string' && cleaned.note_type ? cleaned.note_type : 'general';
    cleaned.title = String(cleaned.title || '').trim() || `Notitie ${new Date().toLocaleDateString('nl-NL')}`;
    cleaned.content = sanitizeRichText(String(cleaned.content || ''));
  }
  if (kind === 'task') {
    cleaned.subtasks = normalizeSubtasks(cleaned.subtasks).filter((subtask: Subtask) => subtask.label.trim().length > 0);
    cleaned.comments = normalizeComments(cleaned.comments).filter((comment: TaskComment) => comment.text.trim().length > 0);
  }
  if (Array.isArray(cleaned.lines)) {
    cleaned.lines = cleaned.lines
      .map((line: FinanceLine) => ({
        id: line.id || uid(),
        description: String(line.description || "").trim(),
        quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : 0,
        unit_price: Number.isFinite(Number(line.unit_price)) ? Number(line.unit_price) : 0,
        vat: Number.isFinite(Number(line.vat)) ? Number(line.vat) : 0,
      }))
      .filter((line: FinanceLine) => line.description || line.quantity || line.unit_price);
  }
  if (kind === "quote") {
    if (!cleaned.number) cleaned.number = createFallbackFinanceNumber('quote');
    delete cleaned.due_date;
    delete cleaned.quote_id;
    // Offerte-status en approvalvelden lopen via de beveiligde workflow/RPC's.
    delete cleaned.status;
    delete cleaned.internal_approval_status;
    delete cleaned.internal_approval_requested_at;
    delete cleaned.internal_approval_requested_by;
    delete cleaned.internal_approved_at;
    delete cleaned.internal_approved_by;
    delete cleaned.internal_rejected_at;
    delete cleaned.internal_rejected_by;
    delete cleaned.internal_rejection_note;
    delete cleaned.client_decision_at;
    delete cleaned.client_decision_by_name;
    delete cleaned.client_decision_by_email;
    delete cleaned.client_decision_note;
    delete cleaned.public_token_hash;
    delete cleaned.public_token_created_at;
    delete cleaned.public_token_expires_at;
    delete cleaned.resend_last_email_id;
    delete cleaned.last_email_delivery_status;
    delete cleaned.last_email_delivery_at;
    delete cleaned.last_email_opened_at;
    delete cleaned.last_email_clicked_at;
    delete cleaned.last_email_failed_at;
    delete cleaned.sent_at;
    delete cleaned.accepted_at;
  }
  if (kind === "invoice") {
    if (!cleaned.number) cleaned.number = createFallbackFinanceNumber('invoice');
    delete cleaned.valid_until;
  }
  if (!["quote","invoice"].includes(kind)) {
    delete cleaned.lines; delete cleaned.number; delete cleaned.valid_until; delete cleaned.due_date; delete cleaned.quote_id;
    if (kind !== 'task') { delete cleaned.subtasks; delete cleaned.comments; }
  }
  return cleaned;
}

createRoot(document.getElementById('root')!).render(<App />);
