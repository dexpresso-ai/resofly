import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar } from './components/Sidebar';
import type { SearchResult } from './components/GlobalSearch';
import { Button, ColorPicker, DEFAULT_PROJECT_COLOR, Input, Select, Textarea, normalizeColor } from './components/Ui';
import { RichTextEditor, sanitizeRichText } from './components/RichTextEditor';
import { Modal } from './components/Modal';
import { isSupabaseConfigured, supabase, supabaseAuth } from './lib/supabase';
import {
  acceptOrganizationInvitation,
  convertAcceptedQuoteToInvoice,
  convertTicketToProject,
  createClientWithServerCode,
  createTicketNote,
  setTicketNoteInternal,
  deleteTicketNote,
  sendClientPortalWelcomeEmail,
  deleteAttachment,
  createNoteCalendarLink,
  createNoteWithCalendarLink,
  createOrganization,
  deleteEntityCascade,
  deleteNoteCalendarLink,
  upsertCalendarEventLink,
  deleteCalendarEventLink,
  disableOrganizationMember,
  insertRow,
  inviteOrganizationMember,
  loadAppData,
  loadOrganizationContext,
  previewNextClientCode,
  planTaskInWeek,
  revokeOrganizationInvitation,
  submitQuoteForInternalApproval,
  approveQuoteInternal,
  rejectQuoteInternal,
  sendInvoiceEmailViaResend,
  sendInvoiceReminderEmail,
  setInvoiceRemindersPaused,
  sendQuoteEmailViaResend,
  downloadQuotePdfSnapshot,
  downloadInvoicePdfSnapshot,
  createInvoiceRefund,
  postSalesInvoiceToLedger,
  downloadCreditNotePdf,
  sendCreditNoteEmail,
  loadInvoiceMollieStatus,
  updateOrganizationMemberRole,
  updateRow,
  upsertCompanySettings,
  type Table,
} from './lib/repository';
import { uploadToR2 } from './lib/r2';
import { listExternalCalendarEvents } from './lib/calendar-api';
import { buildDocumentPdfBlob, buildDocumentDocxBlob, downloadBlob, documentFileBaseName, type DocumentExportMeta } from './lib/documentExport';
import { Dashboard } from './features/Dashboard';
import { ClientDetailPage, Clients } from './features/Clients';
import { ProjectPage, ProjectsListPage, ProjectsPlanningPage } from './features/Projects';
import { Tickets } from './features/Tickets';
import { RelatedNotes, noteTypeLabels } from './features/Notes';
import { documentTypeLabels } from './features/Documents';
import { ContentLibrary } from './features/ContentLibrary';
import { clientFolderOptions } from './lib/folders';
import { Invoices, Quotes, type RefundInput } from './features/Finance';
import { LedgerPage, PurchaseInvoicesPage, SuppliersPage } from './features/Bookkeeping';
import { BankPage } from './features/Bank';
import { AssetsPage } from './features/Assets';
import { ProfitLossPage } from './features/ProfitLoss';
import { VatReturnsPage } from './features/VatReturns';
import { PublicQuotePage } from './features/PublicQuotePage';
import { PublicInvoicePage } from './features/PublicInvoicePage';
import { PublicContractPage } from './features/PublicContractPage';
import { Contracts } from './features/Contracts';
import { ClientPortal } from './features/portal/ClientPortal';
import { Archive, Settings } from './features/SimplePages';
import { Statistics } from './features/Statistics';
import { CalendarPage } from './features/CalendarPage';
import { WeekPlanner } from './features/WeekPlanner';
import { AttachmentList } from './components/AttachmentList';
import { GerrieChat } from './components/GerrieChat';
import { exportFinancePDF } from './lib/pdf';
import { FinanceDocPreview } from './components/FinanceDocPreview';
import type {
  AppData, CalendarEventLink, CalendarExternalEvent, CalendarNoteLinkInput, Client, CompanySettingsInput, CreditNote, EntityType, FinanceLine, InternalDocument, Invoice, Note, OrganizationContext, OrganizationRole, Project, Quote, Task, TaskStatus, Ticket, TicketNote, Subtask, Comment as TaskComment,
} from './types';
import { euro, total, uid, lineGross } from './lib/format';
import './styles/globals.css';

type Page = 'dashboard'|'weekplanner'|'calendar'|'calendar-settings'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'projects'|'project-planning'|'tickets'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'pnl'|'vat-returns'|'archive'|'settings'|'project';
type EditMode =
  | { kind: 'client'; item?: Client; defaults?: Partial<Pick<Client, 'name' | 'contact_name' | 'email' | 'phone' | 'notes' | 'status'>> }
  | { kind: 'project'; item?: Project; defaults?: Partial<Pick<Project, 'name' | 'client_id' | 'description' | 'start_date' | 'end_date'>> }
  | { kind: 'task'; item?: Task; projectId: string; defaults?: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'start_date' | 'end_date' | 'planned_date' | 'estimated_minutes' | 'subtasks'>> }
  | { kind: 'ticket'; item?: Ticket }
  | { kind: 'note'; item?: Note; defaults?: Partial<Pick<Note, 'client_id' | 'project_id' | 'folder_id' | 'title' | 'content' | 'note_type' | 'tags'>>; calendarLink?: CalendarNoteLinkInput }
  | { kind: 'document'; item?: InternalDocument; defaults?: Partial<Pick<InternalDocument, 'client_id' | 'project_id' | 'folder_id' | 'title' | 'content' | 'document_type'>> }
  | { kind: 'quote'; item?: Quote; defaults?: Partial<Pick<Quote, 'client_id' | 'project_id' | 'notes' | 'valid_until' | 'lines'>> }
  | { kind: 'invoice'; item?: Invoice; defaults?: Partial<Pick<Invoice, 'client_id' | 'project_id' | 'notes' | 'due_date' | 'lines'>> }
  | null;

const emptyData: AppData = { clients: [], projects: [], tasks: [], tickets: [], ticketNotes: [], notes: [], documents: [], folders: [], noteCalendarLinks: [], calendarEventLinks: [], quotes: [], quoteApprovalEvents: [], quoteEmailDeliveries: [], quoteVersions: [], invoices: [], invoiceWorkflowEvents: [], invoiceEmailDeliveries: [], invoicePaymentRecords: [], invoiceVersions: [], invoiceRefunds: [], creditNotes: [], invoiceChargebacks: [], ledgerAccounts: [], vatCodes: [], journalEntries: [], journalLines: [], closedPeriods: [], suppliers: [], purchaseInvoices: [], fixedAssets: [], assetDepreciations: [], vatReturns: [], bankAccounts: [], bankStatements: [], bankTransactions: [], bankRules: [], bankRequisitions: [], attachments: [], savedReports: [], companySettings: null };
const emptyOrganizationContext: OrganizationContext = { memberships: [], organizations: [], activeOrganization: null, activeMembership: null, teamMembers: [], pendingInvitations: [], organizationInvitations: [], licenseUsage: null, auditLogs: [], billingOverview: null };
const activeOrgStorageKey = 'brandcore.activeOrganizationId';

const editKindToTable: Record<NonNullable<EditMode>['kind'], Table> = {
  client: 'clients',
  project: 'projects',
  task: 'tasks',
  ticket: 'tickets',
  note: 'notes',
  document: 'documents',
  quote: 'quotes',
  invoice: 'invoices',
};

const editKindToEntity: Record<NonNullable<EditMode>['kind'], EntityType> = {
  client: 'client',
  project: 'project',
  task: 'task',
  ticket: 'ticket',
  note: 'note',
  document: 'document',
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

function getPublicContractTokenFromLocation(): string | null {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('contract_token');
  if (queryToken) return queryToken;
  const match = url.pathname.match(/^\/contract\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Het klantportaal leeft op /portal. Aparte route met eigen, wachtwoordloze
 *  login (magische e-maillink) en eigen Supabase-client (src/lib/supabasePortal.ts);
 *  los van de medewerkers-app en -sessie. */
function isClientPortalRoute(): boolean {
  return window.location.pathname === '/portal' || window.location.pathname.startsWith('/portal/');
}

/** Schermvullend opstartscherm met draaiend laadicoon. Wordt getoond zolang de
 *  sessie of de werkruimte nog wordt opgehaald, zodat er niet kort een lege of
 *  misleidende staat ("Geen organisatie gevonden") in beeld flitst. */
function BootLoading({ message = 'ResoFly is aan het laden…' }: { message?: string }) {
  return <div className="boot"><div className="boot-loading"><span className="boot-spinner" aria-hidden="true" /><span>{message}</span></div></div>;
}

function App() {
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [data, setData] = useState<AppData>(emptyData);
  const [organizationContext, setOrganizationContext] = useState<OrganizationContext>(emptyOrganizationContext);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(() => localStorage.getItem(activeOrgStorageKey));
  // Terugkomst van de GoCardless-bankkoppeling (?ref=…) opent direct de Bankpagina,
  // die de koppeling vervolgens afrondt.
  const [page, setPage] = useState<Page>(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ref') ? 'bank' : 'dashboard');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [statsReportId, setStatsReportId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditMode>(null);
  const [loading, setLoading] = useState(false);
  // Wanneer dit een tekst bevat, draait er een schermvullende laad-overlay. Wordt
  // gezet bij trage Resend-verzendacties (offerte/factuur/creditfactuur) zodat de
  // gebruiker ziet dat de app bezig is en niet per ongeluk dubbel verstuurt.
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const publicQuoteToken = getPublicQuoteTokenFromLocation();
  const publicInvoiceToken = getPublicInvoiceTokenFromLocation();
  const publicContractToken = getPublicContractTokenFromLocation();
  const portalRoute = isClientPortalRoute();

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
    // Op /portal draait de medewerkers-auth niet: het klantportaal heeft een eigen
    // Supabase-client en sessie. Zo blijft de medewerkers-sessie ongemoeid en wordt
    // er geen werkruimte voor een klant-account geladen.
    if (portalRoute) { setSessionReady(true); return; }
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

  if (portalRoute) return <ClientPortal />;
  if (!isSupabaseConfigured) return <div className="boot"><div className="login-card"><h1>Configuratie ontbreekt</h1><p>Vul eerst VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in .env.local in.</p></div></div>;
  if (publicQuoteToken) return <PublicQuotePage token={publicQuoteToken} />;
  if (publicInvoiceToken) return <PublicInvoicePage token={publicInvoiceToken} />;
  if (publicContractToken) return <PublicContractPage token={publicContractToken} />;
  if (!sessionReady) return <BootLoading />;
  if (!loggedIn) return <Login />;
  // Zolang de werkruimte nog wordt geladen weten we nog niet of er een organisatie
  // is. Toon dan het laadscherm i.p.v. kort "Geen organisatie gevonden" te flitsen;
  // die melding is alléén terecht als het laden klaar is en er echt geen org is.
  if (!activeOrganization && loading) return <BootLoading />;
  if (!activeOrganization) return <div className="boot"><div className="login-card"><h1>Geen organisatie gevonden</h1><p>Er kon geen organisatie voor je account worden geladen.</p><Button variant="primary" onClick={createNewOrganization}>Organisatie maken</Button></div></div>;

  const activeOrg = activeOrganization;

  async function saveEdit(values: Record<string, unknown>) {
    if (!edit) return;
    if (!ensureCanWrite()) return;
    if (edit.kind === 'quote' || edit.kind === 'invoice') {
      const financeLines = Array.isArray(values.lines) ? (values.lines as FinanceLine[]) : [];
      const meaningfulLines = financeLines.filter(line => String(line.description || '').trim().length > 0 && Number(line.quantity || 0) > 0);
      if (meaningfulLines.length === 0) {
        setError('Voeg minimaal één regel toe met een omschrijving en een aantal groter dan 0.');
        return;
      }
      const docTotal = total(financeLines).total;
      if (!(docTotal > 0)) {
        setError('Het documenttotaal moet groter zijn dan € 0,00.');
        return;
      }
    }
    setLoading(true); setError(null);
    // Niet-blokkerende waarschuwing die we pas ná refresh tonen (refresh wist de
    // foutbanner): bijv. klant aangemaakt maar welkomstmail mislukt.
    let deferredWarning: string | null = null;
    try {
      switch (edit.kind) {
        case 'client': {
          const duplicateIssue = findClientDuplicateIssue(data.clients, values, edit.item);
          if (duplicateIssue?.blocksSave) throw new Error(duplicateIssue.message);

          // _sendWelcomeEmail is een UI-keuze, geen klantkolom: eruit halen vóór opslaan.
          const { _sendWelcomeEmail, ...clientValues } = values;
          if (edit.item) {
            await updateRow<Client>('clients', edit.item.id, clientValues, activeOrg.id);
          } else {
            const newClient = await createClientWithServerCode(activeOrg.id, clientValues);
            if (_sendWelcomeEmail && newClient.email) {
              try {
                await sendClientPortalWelcomeEmail(activeOrg.id, newClient.id);
              } catch (mailError) {
                // De klant is wél aangemaakt; alleen de welkomstmail faalde. De opslag
                // niet laten klappen, maar de gebruiker wel waarschuwen.
                deferredWarning = `Klant is aangemaakt, maar de welkomstmail kon niet worden verzonden: ${mailError instanceof Error ? mailError.message : 'onbekende fout'}`;
              }
            }
          }
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
          const calLink = (values._calLink as CalendarNoteLinkInput | null) ?? edit.calendarLink ?? null;
          const { _calLink, ...noteValues } = values;
          if (edit.item) {
            await updateRow<Note>('notes', edit.item.id, noteValues, activeOrg.id);
          } else if (calLink) {
            await createNoteWithCalendarLink(activeOrg.id, noteValues, calLink);
          } else {
            await insertRow<Note>('notes', activeOrg.id, noteValues);
          }
          break;
        }
        case 'document':
          edit.item
            ? await updateRow<InternalDocument>('documents', edit.item.id, values, activeOrg.id)
            : await insertRow<InternalDocument>('documents', activeOrg.id, values);
          break;
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
      if (deferredWarning) setError(deferredWarning);
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

  async function updateTaskPlanning(taskId: string, plannedDate: string | null, beforeTaskId?: string | null) {
    if (!ensureCanWrite()) return;
    setError(null);
    await planTaskInWeek(activeOrg.id, taskId, plannedDate, beforeTaskId ?? null);
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
    setLoading(true); setSending('Offerte wordt verstuurd via Resend…'); setError(null);
    try {
      await sendQuoteEmailViaResend(activeOrg.id, quote.id, { recipientEmail, recipientName });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte verzenden via Resend mislukt');
    } finally {
      setLoading(false); setSending(null);
    }
  }

  async function downloadQuotePdf(quote: Quote) {
    setLoading(true); setError(null);
    try {
      await downloadQuotePdfSnapshot(activeOrg.id, quote.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte-PDF downloaden mislukt');
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

  async function downloadInvoicePdf(invoice: Invoice) {
    setLoading(true); setError(null);
    try {
      await downloadInvoicePdfSnapshot(activeOrg.id, invoice.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Factuur-PDF downloaden mislukt');
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

    // Toon meteen de laad-overlay: de Mollie-statuscheck hieronder plus het
    // versturen zelf kunnen samen enkele seconden duren.
    setSending('Factuur wordt verstuurd via Resend…');

    // A Mollie payment link is included automatically whenever this organization
    // has its own Mollie account connected and the invoice is still payable. No
    // per-send prompt: connecting Mollie is the opt-in, disconnecting is the
    // opt-out. Organizations without a Mollie key simply send the PDF only.
    let includePaymentLink = false;
    const invoiceIsPayable = !['paid', 'cancelled', 'void', 'written_off'].includes(invoice.status);
    if (invoiceIsPayable) {
      try {
        const mollie = await loadInvoiceMollieStatus(activeOrg.id);
        includePaymentLink = mollie.status === 'connected';
      } catch {
        // Status niet kunnen ophalen mag het versturen niet blokkeren: dan PDF-only.
      }
    }

    setLoading(true); setError(null);
    try {
      const result = await sendInvoiceEmailViaResend(activeOrg.id, invoice.id, { recipientEmail, recipientName, includePaymentLink });
      await refresh();
      // The invoice itself went out fine; only the optional Mollie link failed.
      // Surface it as a non-blocking warning so the user can fix Mollie config.
      if (includePaymentLink && result.paymentLinkError) {
        setError(`Factuur is verstuurd, maar de Mollie-betaallink kon niet worden aangemaakt (alleen de PDF is meegestuurd): ${result.paymentLinkError}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Factuur verzenden via Resend mislukt');
    } finally {
      setLoading(false); setSending(null);
    }
  }

  async function sendInvoiceReminder(invoice: Invoice) {
    if (!ensureCanWrite()) return;
    const client = data.clients.find(item => item.id === invoice.client_id);
    if (!client?.email) {
      setError('Deze factuur heeft geen klant met e-mailadres; vul eerst een e-mailadres in bij de klant.');
      return;
    }
    const nextLevel = Math.min(3, (invoice.reminder_level ?? 0) + 1);
    const levelLabel = nextLevel === 3 ? 'aanmaning (niveau 3)' : `herinnering (niveau ${nextLevel})`;
    if (!confirm(`Betalings${levelLabel} versturen voor factuur ${invoice.number} naar ${client.email}?`)) return;

    setSending('Herinnering wordt verstuurd via Resend…');
    setLoading(true); setError(null);
    try {
      const result = await sendInvoiceReminderEmail(activeOrg.id, invoice.id);
      await refresh();
      if (result.paymentLinkError) {
        setError(`Herinnering is verstuurd, maar de Mollie-betaallink kon niet worden aangemaakt (alleen de PDF is meegestuurd): ${result.paymentLinkError}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Herinnering verzenden via Resend mislukt');
    } finally {
      setLoading(false); setSending(null);
    }
  }

  async function toggleInvoiceRemindersPaused(invoice: Invoice, paused: boolean) {
    if (!ensureCanWrite()) return;
    setLoading(true); setError(null);
    try {
      await setInvoiceRemindersPaused(activeOrg.id, invoice.id, paused);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Herinneringsstatus bijwerken mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function postInvoiceToLedger(invoice: Invoice) {
    if (!ensureCanWrite()) return;
    setLoading(true); setError(null);
    try {
      await postSalesInvoiceToLedger(activeOrg.id, invoice.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Factuur naar grootboek boeken mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function refundInvoice(invoice: Invoice, input: RefundInput) {
    if (!ensureCanAdmin()) throw new Error('Alleen owners en admins mogen terugbetalingen registreren.');
    setLoading(true); setError(null);
    try {
      await createInvoiceRefund(activeOrg.id, invoice.id, {
        amountCents: input.amountCents,
        reason: input.reason,
        createCreditNote: input.createCreditNote,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
      });
      await refresh();
    } catch (e) {
      // Re-throw zodat de RefundModal de fout toont en open blijft; geen globale
      // banner zodat de melding niet dubbel verschijnt.
      throw e instanceof Error ? e : new Error('Terugbetaling registreren mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function downloadCreditNote(creditNote: CreditNote) {
    setLoading(true); setError(null);
    try {
      await downloadCreditNotePdf(activeOrg.id, creditNote.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Creditfactuur-PDF downloaden mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function emailCreditNote(creditNote: CreditNote) {
    if (!ensureCanWrite()) return;
    setLoading(true); setSending('Creditfactuur wordt gemaild via Resend…'); setError(null);
    try {
      await sendCreditNoteEmail(activeOrg.id, creditNote.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Creditfactuur mailen mislukt');
    } finally {
      setLoading(false); setSending(null);
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
    return buildCalendarNoteLinkInput(event);
  }

  function eventLinkFor(event: CalendarExternalEvent): CalendarEventLink | undefined {
    return data.calendarEventLinks.find(link => calendarEventLinkMatchesEvent(link, event));
  }

  function openNoteForCalendarEvent(event: CalendarExternalEvent) {
    if (!ensureCanWrite()) return;
    if (event.visibility !== 'organization' || event.is_private_masked) {
      setError('Notities koppelen is bewust uitgeschakeld voor privé-afspraken. Deel de agenda eerst met de organisatie of voeg later persoonlijke notities toe.');
      return;
    }
    setError(null);
    const link = eventLinkFor(event);
    setEdit({
      kind: 'note',
      item: undefined,
      defaults: {
        title: `Notitie: ${event.title}`,
        content: '',
        note_type: 'meeting',
        tags: ['agenda'],
        client_id: link?.client_id ?? null,
        project_id: link?.project_id ?? null,
      },
      calendarLink: calendarNoteLinkInput(event),
    });
  }

  function openDocumentForCalendarEvent(event: CalendarExternalEvent) {
    if (!ensureCanWrite()) return;
    if (event.visibility !== 'organization' || event.is_private_masked) {
      setError('Documenten maken vanuit een agenda-item is uitgeschakeld voor privé-afspraken. Deel de agenda eerst met de organisatie.');
      return;
    }
    setError(null);
    const link = eventLinkFor(event);
    setEdit({
      kind: 'document',
      item: undefined,
      defaults: {
        title: event.title,
        client_id: link?.client_id ?? null,
        project_id: link?.project_id ?? null,
      },
    });
  }

  async function setCalendarEventLink(event: CalendarExternalEvent, clientId: string | null, projectId: string | null) {
    if (!ensureCanWrite()) return;
    setLoading(true); setError(null);
    try {
      if (!clientId && !projectId) {
        const existing = eventLinkFor(event);
        if (existing) await deleteCalendarEventLink(existing.id, activeOrg.id);
      } else {
        await upsertCalendarEventLink(activeOrg.id, {
          provider: event.provider,
          calendar_source_id: event.source_id,
          provider_event_id: event.provider_event_id,
          event_starts_at: event.starts_at,
          // Bewaar de titel niet voor privé-agenda-items: de koppeltabel is org-breed leesbaar.
          event_title_snapshot: event.visibility === 'organization' && !event.is_private_masked ? event.title : null,
          client_id: clientId,
          project_id: projectId,
        });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Agenda-koppeling opslaan mislukt');
    } finally {
      setLoading(false);
    }
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

  // Globale zoekfunctie: stuurt een resultaat door naar de juiste pagina/detail.
  // Voor entiteiten met een bewerkmodal openen we die meteen; klant/project hebben
  // een eigen detailpagina.
  function handleSearchNavigate(result: SearchResult) {
    setProjectId(null);
    setClientId(null);
    setStatsReportId(null);
    switch (result.kind) {
      case 'client':
        setClientId(result.item.id);
        setPage('client');
        break;
      case 'project':
        setProjectId(result.item.id);
        setPage(result.item.archived ? 'archive' : 'project');
        break;
      case 'task':
        setProjectId(result.item.project_id);
        setPage('project');
        setEdit({ kind: 'task', item: result.item, projectId: result.item.project_id });
        break;
      case 'ticket':
        setPage('tickets');
        setEdit({ kind: 'ticket', item: result.item });
        break;
      case 'note':
        setPage('notes');
        setEdit({ kind: 'note', item: result.item });
        break;
      case 'document':
        setPage('documents');
        setEdit({ kind: 'document', item: result.item });
        break;
      case 'quote':
        setPage('quotes');
        setEdit({ kind: 'quote', item: result.item });
        break;
      case 'invoice':
        setPage('invoices');
        setEdit({ kind: 'invoice', item: result.item });
        break;
      case 'supplier':
        setPage('suppliers');
        break;
    }
  }

  const title = page === 'project' ? project?.name ?? 'Project' : page === 'client' ? client?.name ?? 'Klant' : ({dashboard:'Dashboard',weekplanner:'Weekplanner',calendar:'Kalender','calendar-settings':'Agenda-instellingen',stats:'Statistieken',content:'Inhoud',notes:'Notities',documents:'Documenten',clients:'Klanten',projects:'Projecten','project-planning':'Projectplanning',tickets:'Tickets',quotes:'Offertes',invoices:'Facturen',suppliers:'Leveranciers','purchase-invoices':'Inkoopfacturen',ledger:'Grootboek',bank:'Bank',assets:'Activa',pnl:'Winst & verlies','vat-returns':'Omzetbelasting',archive:'Archief',settings:'Instellingen',project:'Project',client:'Klant'} as Record<Page,string>)[page];

  return <div className="app">
    <Sidebar page={page} data={data} organizations={organizationContext.organizations} activeOrganizationId={activeOrg.id} activeRole={activeMembership?.role ?? null} onOrganization={switchOrganization} onNewOrganization={createNewOrganization} onPage={(p) => { setPage(p); setProjectId(null); setClientId(null); setStatsReportId(null); }} onSearchNavigate={handleSearchNavigate}/>
    <main className="main">{page !== 'calendar' && <header className="topbar"><div><div className="topbar-eyebrow">ResoFly workspace</div><div className="topbar-title">{title}</div></div><div className="topbar-actions">{!canWrite && <span className="status-pill readonly">Alleen lezen</span>}<Button onClick={refresh}>{loading ? 'Laden…' : 'Ververs'}</Button><Button onClick={() => supabaseAuth.signOut()}>Uitloggen</Button></div></header>}
      <section className="content">{error && <div className="error">{error}</div>}{renderPage()}</section>
    </main>{edit && <EditModal edit={edit} data={data} organizationId={activeOrg.id} currentUserId={currentUserId} canWrite={canWrite} readOnly={!canWrite} onClose={() => setEdit(null)} onSave={saveEdit} onDelete={removeCurrent} onAttachmentsChanged={refresh} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewClientNote={(client) => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { client_id: client.id }})} />}
    <GerrieChat organizationId={activeOrg.id}
      onCreateInvoiceDraft={(p) => {
        if (!ensureCanWrite()) return;
        setPage('invoices'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'invoice', item: undefined, defaults: {
          client_id: p.client_id, notes: p.notes ?? undefined, due_date: p.due_date ?? undefined,
          lines: p.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat })),
        } });
      }}
      onCreateQuoteDraft={(p) => {
        if (!ensureCanWrite()) return;
        setPage('quotes'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'quote', item: undefined, defaults: {
          client_id: p.client_id, notes: p.notes ?? undefined, valid_until: p.valid_until ?? undefined,
          lines: p.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat })),
        } });
      }}
      onCreateClientDraft={(p) => {
        if (!ensureCanWrite()) return;
        setPage('clients'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'client', item: undefined, defaults: {
          name: p.name, contact_name: p.contact_name ?? undefined, email: p.email ?? undefined,
          phone: p.phone ?? undefined, notes: p.notes ?? undefined, status: (p.status as Client['status']),
        } });
      }}
      onSendInvoice={async (p) => {
        if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
        const invoice = data.invoices.find((i) => i.id === p.id);
        let includePaymentLink = false;
        if (invoice && !['paid', 'cancelled', 'void', 'written_off'].includes(invoice.status)) {
          try { const mollie = await loadInvoiceMollieStatus(activeOrg.id); includePaymentLink = mollie.status === 'connected'; } catch { /* PDF-only als de status niet op te halen is */ }
        }
        await sendInvoiceEmailViaResend(activeOrg.id, p.id, { recipientEmail: p.recipient_email, recipientName: p.recipient_name ?? undefined, includePaymentLink });
        await refresh();
      }}
      onSendQuote={async (p) => {
        if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
        await sendQuoteEmailViaResend(activeOrg.id, p.id, { recipientEmail: p.recipient_email, recipientName: p.recipient_name ?? undefined });
        await refresh();
      }}
      onConvertQuote={async (p) => {
        if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
        const invoice = await convertAcceptedQuoteToInvoice(activeOrg.id, p.id);
        await refresh();
        setPage('invoices'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'invoice', item: invoice });
      }}
      onEditInvoice={(p) => {
        if (!ensureCanWrite()) return;
        const existing = data.invoices.find((i) => i.id === p.id);
        if (!existing) { setError('Factuur niet gevonden.'); return; }
        const merged: Invoice = { ...existing };
        if (p.changes.lines) merged.lines = p.changes.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat }));
        if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
        if (p.changes.due_date !== undefined) merged.due_date = p.changes.due_date;
        setPage('invoices'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'invoice', item: merged });
      }}
      onEditQuote={(p) => {
        if (!ensureCanWrite()) return;
        const existing = data.quotes.find((q) => q.id === p.id);
        if (!existing) { setError('Offerte niet gevonden.'); return; }
        const merged: Quote = { ...existing };
        if (p.changes.lines) merged.lines = p.changes.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat }));
        if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
        if (p.changes.valid_until !== undefined) merged.valid_until = p.changes.valid_until;
        setPage('quotes'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'quote', item: merged });
      }}
      onEditClient={(p) => {
        if (!ensureCanWrite()) return;
        const existing = data.clients.find((c) => c.id === p.id);
        if (!existing) { setError('Klant niet gevonden.'); return; }
        const merged: Client = { ...existing };
        if (p.changes.name !== undefined) merged.name = p.changes.name;
        if (p.changes.contact_name !== undefined) merged.contact_name = p.changes.contact_name;
        if (p.changes.email !== undefined) merged.email = p.changes.email;
        if (p.changes.phone !== undefined) merged.phone = p.changes.phone;
        if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
        if (p.changes.status !== undefined) merged.status = p.changes.status as Client['status'];
        setPage('clients'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'client', item: merged });
      }}
      onSendReminders={async (p) => {
        if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
        let sent = 0;
        const failed: string[] = [];
        for (const inv of p.invoices) {
          try { await sendInvoiceReminderEmail(activeOrg.id, inv.id); sent += 1; }
          catch { failed.push(inv.number); }
        }
        await refresh();
        if (failed.length) throw new Error(`${sent} verstuurd, ${failed.length} mislukt (${failed.join(', ')}).`);
      }}
      onCreateProject={(p) => {
        if (!ensureCanWrite()) return;
        setPage('projects'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'project', item: undefined, defaults: { name: p.name, client_id: p.client_id ?? undefined, description: p.description ?? undefined, start_date: p.start_date ?? undefined, end_date: p.end_date ?? undefined } });
      }}
      onEditProject={(p) => {
        if (!ensureCanWrite()) return;
        const existing = data.projects.find((pr) => pr.id === p.id);
        if (!existing) { setError('Project niet gevonden.'); return; }
        const merged: Project = { ...existing };
        if (p.changes.name !== undefined) merged.name = p.changes.name;
        if (p.changes.client_id !== undefined) merged.client_id = p.changes.client_id;
        if (p.changes.description !== undefined) merged.description = p.changes.description;
        if (p.changes.start_date !== undefined) merged.start_date = p.changes.start_date;
        if (p.changes.end_date !== undefined) merged.end_date = p.changes.end_date;
        if (p.changes.archived !== undefined) merged.archived = p.changes.archived;
        setPage('projects'); setProjectId(null); setClientId(null);
        setEdit({ kind: 'project', item: merged });
      }}
      onCreateTask={(p) => {
        if (!ensureCanWrite()) return;
        setProjectId(p.project_id); setClientId(null); setPage('project');
        setEdit({ kind: 'task', item: undefined, projectId: p.project_id, defaults: {
          title: p.title, description: p.description ?? undefined, status: p.status as Task['status'], priority: p.priority as Task['priority'],
          tags: p.tags, start_date: p.start_date ?? undefined, end_date: p.end_date ?? undefined, planned_date: p.planned_date ?? undefined,
          estimated_minutes: p.estimated_minutes, subtasks: p.subtasks.map((s) => ({ id: uid(), label: s.label, done: s.done })),
        } });
      }}
      onEditTask={(p) => {
        if (!ensureCanWrite()) return;
        const existing = data.tasks.find((t) => t.id === p.id);
        if (!existing) { setError('Taak niet gevonden.'); return; }
        const merged: Task = { ...existing };
        const c = p.changes;
        if (c.title !== undefined) merged.title = c.title;
        if (c.description !== undefined) merged.description = c.description;
        if (c.status !== undefined) merged.status = c.status as Task['status'];
        if (c.priority !== undefined) merged.priority = c.priority as Task['priority'];
        if (c.planned_date !== undefined) merged.planned_date = c.planned_date;
        if (c.start_date !== undefined) merged.start_date = c.start_date;
        if (c.end_date !== undefined) merged.end_date = c.end_date;
        if (c.estimated_minutes !== undefined) merged.estimated_minutes = c.estimated_minutes;
        if (c.tags !== undefined) merged.tags = c.tags;
        if (c.subtasks !== undefined) merged.subtasks = c.subtasks.map((s) => ({ id: uid(), label: s.label, done: s.done }));
        setProjectId(existing.project_id); setClientId(null); setPage('project');
        setEdit({ kind: 'task', item: merged, projectId: existing.project_id });
      }}
    />
    {sending && <div className="send-overlay" role="status" aria-live="polite">
      <div className="send-overlay-card">
        <span className="send-spinner" aria-hidden="true" />
        <span>{sending}</span>
        <small>Sluit dit venster niet — dit kan enkele seconden duren.</small>
      </div>
    </div>}
  </div>;

  function renderPage() {
    if (page === 'dashboard') return <Dashboard data={data} organizationContext={organizationContext} openProject={(id) => { setProjectId(id); setPage('project'); }} openSettings={() => setPage('settings')} openPage={(p) => { setPage(p); setProjectId(null); setClientId(null); setStatsReportId(null); }} openReport={(id) => { setStatsReportId(id); setProjectId(null); setClientId(null); setPage('stats'); }} />;
    if (page === 'project' && project) return <ProjectPage data={data} project={project} canWrite={canWrite} canAdmin={canAdmin} onNewTask={() => ensureCanWrite() && setEdit({kind:'task', projectId: project.id})} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: project.id})} onEditProject={() => setEdit({kind:'project', item: project})} onNewQuote={() => ensureCanWrite() && setEdit({kind:'quote', defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditQuote={(quote) => setEdit({kind:'quote', item: quote})} onNewInvoice={() => ensureCanWrite() && setEdit({kind:'invoice', defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditInvoice={(invoice) => setEdit({kind:'invoice', item: invoice})} onSubmitQuoteApproval={submitQuoteApproval} onApproveQuote={approveQuote} onRejectQuote={rejectQuote} onSendQuote={sendQuote} onConvertQuoteToInvoice={convertQuoteToInvoice} onNewNote={() => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewDocument={() => ensureCanWrite() && setEdit({kind:'document', item: undefined, defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditDocument={(doc) => setEdit({kind:'document', item: doc})} setTaskStatus={setTaskStatus}/>;
    if (page === 'projects') return <ProjectsListPage data={data} canWrite={canWrite} onNewProject={() => ensureCanWrite() && setEdit({kind:'project'})} onOpenProject={(item) => { setProjectId(item.id); setClientId(null); setPage('project'); }} onEditProject={(item) => setEdit({kind:'project', item})}/>;
    if (page === 'project-planning') return <ProjectsPlanningPage data={data} onOpenProject={(item) => { setProjectId(item.id); setClientId(null); setPage('project'); }} />;
    if (page === 'client' && client) return <ClientDetailPage data={data} client={client} canWrite={canWrite} organizationId={activeOrg.id} onChanged={refresh} onBack={() => { setClientId(null); setPage('clients'); }} onEditClient={() => setEdit({kind:'client', item: client})} onNewQuote={() => ensureCanWrite() && setEdit({kind:'quote', defaults: { client_id: client.id }})} onEditQuote={(item)=>setEdit({kind:'quote', item})} onNewInvoice={() => ensureCanWrite() && setEdit({kind:'invoice', defaults: { client_id: client.id }})} onEditInvoice={(item)=>setEdit({kind:'invoice', item})} onOpenProject={(project) => { setProjectId(project.id); setClientId(null); setPage('project'); }} onNewNote={(folderId) => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { client_id: client.id, folder_id: folderId ?? null }})} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewDocument={(folderId) => ensureCanWrite() && setEdit({kind:'document', item: undefined, defaults: { client_id: client.id, folder_id: folderId ?? null }})} onEditDocument={(doc) => setEdit({kind:'document', item: doc})}/>;
    if (page === 'clients') return <Clients data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh} onNew={() => ensureCanWrite() && setEdit({kind:'client'})} onOpen={(item)=>{ setClientId(item.id); setProjectId(null); setPage('client'); }}/>;
    if (page === 'tickets') return <Tickets data={data} onNew={() => ensureCanWrite() && setEdit({kind:'ticket'})} onEdit={(item)=>setEdit({kind:'ticket', item})} onConvert={convert}/>;
    if (page === 'content' || page === 'notes' || page === 'documents') return <ContentLibrary key={page} data={data} initialView={page === 'notes' ? 'notes' : page === 'documents' ? 'documents' : 'all'} onNewNote={(t) => ensureCanWrite() && setEdit({kind:'note', defaults: { client_id: t?.client_id ?? null, project_id: t?.project_id ?? null }})} onEditNote={(item)=>setEdit({kind:'note', item})} onNewDocument={(t) => ensureCanWrite() && setEdit({kind:'document', defaults: { client_id: t?.client_id ?? null, project_id: t?.project_id ?? null }})} onEditDocument={(item)=>setEdit({kind:'document', item})}/>;
    if (page === 'quotes') return <Quotes data={data} canWrite={canWrite} canAdmin={canAdmin} onNew={() => ensureCanWrite() && setEdit({kind:'quote'})} onEdit={(item)=>setEdit({kind:'quote', item})} onSubmitApproval={submitQuoteApproval} onApprove={approveQuote} onReject={rejectQuote} onSend={sendQuote} onConvertToInvoice={convertQuoteToInvoice} onDownloadPdf={downloadQuotePdf}/>;
    if (page === 'contracts') return <Contracts data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'invoices') return <Invoices data={data} canWrite={canWrite} canAdmin={canAdmin} onNew={() => ensureCanWrite() && setEdit({kind:'invoice'})} onEdit={(item)=>setEdit({kind:'invoice', item})} onSend={sendInvoice} onSendReminder={sendInvoiceReminder} onToggleRemindersPaused={toggleInvoiceRemindersPaused} onDownloadPdf={downloadInvoicePdf} onRefund={refundInvoice} onDownloadCreditNote={downloadCreditNote} onEmailCreditNote={emailCreditNote} onPostToLedger={postInvoiceToLedger}/>;
    if (page === 'suppliers') return <SuppliersPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'purchase-invoices') return <PurchaseInvoicesPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'ledger') return <LedgerPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'bank') return <BankPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'assets') return <AssetsPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'pnl') return <ProfitLossPage data={data} organizationId={activeOrg.id} onChanged={refresh}/>;
    if (page === 'vat-returns') return <VatReturnsPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'weekplanner') return <WeekPlanner data={data} canWrite={canWrite} onPlanTask={updateTaskPlanning} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})}/>;
    if (page === 'calendar') return <CalendarPage mode="agenda" organizationId={activeOrg.id} currentUserId={currentUserId} data={data} canWrite={canWrite} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onNewNoteForEvent={openNoteForCalendarEvent} onNewDocumentForEvent={openDocumentForCalendarEvent} onSetEventLink={setCalendarEventLink} onEditNote={(note) => setEdit({kind:'note', item: note})} onLinkExistingNoteToEvent={linkExistingNoteToCalendarEvent} onUnlinkNoteFromEvent={unlinkNoteFromCalendarEvent}/>;
    if (page === 'calendar-settings') return <CalendarPage mode="settings" organizationId={activeOrg.id} currentUserId={currentUserId} data={data} canWrite={canWrite} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onNewNoteForEvent={openNoteForCalendarEvent} onNewDocumentForEvent={openDocumentForCalendarEvent} onSetEventLink={setCalendarEventLink} onEditNote={(note) => setEdit({kind:'note', item: note})} onLinkExistingNoteToEvent={linkExistingNoteToCalendarEvent} onUnlinkNoteFromEvent={unlinkNoteFromCalendarEvent}/>;
    if (page === 'stats') return <Statistics data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh} openReportId={statsReportId}/>;
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

function formatMeetingLabel(ev: CalendarExternalEvent): string {
  const d = new Date(ev.starts_at);
  return `${d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })} – ${ev.title}`;
}

function MeetingPicker({ events, selectedId, onSelect, disabled }: {
  events: CalendarExternalEvent[];
  selectedId: string | null;
  onSelect: (event: CalendarExternalEvent | null) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const filtered = search.trim()
    ? events.filter(ev => {
        const q = search.toLowerCase();
        return ev.title.toLowerCase().includes(q) ||
          new Date(ev.starts_at).toLocaleDateString('nl-NL').includes(q);
      })
    : events;
  const selectedEvent = events.find(ev => ev.provider_event_id === selectedId);
  return (
    <div className="meeting-picker">
      {selectedEvent && (
        <div className="meeting-picker-selected">
          <span>✓ {formatMeetingLabel(selectedEvent)}</span>
          {!disabled && <button type="button" className="meeting-picker-clear" onClick={() => onSelect(null)}>×</button>}
        </div>
      )}
      <input type="text" className="form-input meeting-picker-search" placeholder="Zoek op naam of datum…" value={search} onChange={e => setSearch(e.target.value)} disabled={disabled} />
      <div className="meeting-picker-list">
        {filtered.length === 0 && <div className="meeting-picker-empty">Geen meetings gevonden</div>}
        {filtered.map(ev => (
          <button type="button" key={`${ev.provider}-${ev.provider_event_id}`}
            className={`meeting-picker-item${ev.provider_event_id === selectedId ? ' selected' : ''}`}
            onClick={() => !disabled && onSelect(ev.provider_event_id === selectedId ? null : ev)}
          >
            <span className="meeting-picker-label">{formatMeetingLabel(ev)}</span>
            {ev.provider_event_id === selectedId && <span className="meeting-picker-check">✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function buildCalendarNoteLinkInput(event: CalendarExternalEvent): CalendarNoteLinkInput {
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

/** Identificeert dezelfde event-instantie als de UI: provider + agenda + event-id + starttijd. */
function calendarEventLinkMatchesEvent(link: CalendarEventLink, event: CalendarExternalEvent): boolean {
  return link.provider === event.provider
    && link.calendar_source_id === event.source_id
    && link.provider_event_id === event.provider_event_id
    && new Date(link.event_starts_at).getTime() === new Date(event.starts_at).getTime();
}

function EditModal({ edit, data, organizationId, currentUserId, canWrite, readOnly, onClose, onSave, onDelete, onAttachmentsChanged, onEditNote, onNewClientNote }: { edit: NonNullable<EditMode>; data: AppData; organizationId: string; currentUserId: string | null; canWrite: boolean; readOnly: boolean; onClose: () => void; onSave: (v: Record<string, unknown>) => void; onDelete: () => void; onAttachmentsChanged: () => void; onEditNote: (note: Note) => void; onNewClientNote: (client: Client) => void }) {
  const item = 'item' in edit ? edit.item : undefined;
  const [form, setForm] = useState<Record<string, any>>(() => initialForm(edit, data));
  const set = (k: string, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));

  const [noteCalEvents, setNoteCalEvents] = useState<CalendarExternalEvent[]>([]);
  const [noteCalEventsLoading, setNoteCalEventsLoading] = useState(false);

  useEffect(() => {
    if (edit.kind !== 'note') return;
    let cancelled = false;
    setNoteCalEventsLoading(true);
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    listExternalCalendarEvents(organizationId, start, end)
      .then(events => {
        if (cancelled) return;
        setNoteCalEvents(
          events
            .filter(e => e.visibility === 'organization' && !e.is_private_masked && !e.all_day)
            .sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())
        );
      })
      .catch(() => { if (!cancelled) setNoteCalEvents([]); })
      .finally(() => { if (!cancelled) setNoteCalEventsLoading(false); });
    return () => { cancelled = true; };
  }, [organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const [docExport, setDocExport] = useState<{ busy: 'pdf' | 'docx' | null; error: string | null }>({ busy: null, error: null });

  function buildDocumentMeta(): DocumentExportMeta {
    const client = data.clients.find(c => c.id === form.client_id);
    const project = data.projects.find(p => p.id === form.project_id);
    const created = item ? (item as InternalDocument).created_at : new Date().toISOString();
    return {
      title: String(form.title || '').trim() || 'Document',
      categoryLabel: documentTypeLabels[(form.document_type || 'general') as keyof typeof documentTypeLabels] ?? 'Algemeen',
      clientName: client?.name ?? null,
      projectName: project?.name ?? null,
      dateLabel: new Date(created).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }),
      companyName: data.companySettings?.company_name ?? null,
      content: String(form.content || ''),
    };
  }

  async function handleDownloadDocx() {
    setDocExport({ busy: 'docx', error: null });
    try {
      const meta = buildDocumentMeta();
      const blob = buildDocumentDocxBlob(meta);
      downloadBlob(blob, `${documentFileBaseName(meta.title)}.docx`);
      setDocExport({ busy: null, error: null });
    } catch (e) {
      setDocExport({ busy: null, error: e instanceof Error ? e.message : 'Word-export mislukt' });
    }
  }

  async function handleDownloadPdf() {
    setDocExport({ busy: 'pdf', error: null });
    try {
      const meta = buildDocumentMeta();
      const filename = `${documentFileBaseName(meta.title)}.pdf`;
      const blob = await buildDocumentPdfBlob(meta);
      downloadBlob(blob, filename);
      // Store the generated PDF in Cloudflare R2 as an attachment on the saved document.
      if (item) {
        const stale = data.attachments.filter(a => a.entity_type === 'document' && a.entity_id === item.id && a.name === filename);
        for (const att of stale) await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: organizationId }).catch(() => undefined);
        const pdfFile = new File([blob], filename, { type: 'application/pdf' });
        await uploadToR2(pdfFile, organizationId, { entity_type: 'document', entity_id: item.id });
        onAttachmentsChanged();
      }
      setDocExport({ busy: null, error: null });
    } catch (e) {
      setDocExport({ busy: null, error: e instanceof Error ? e.message : 'PDF-export mislukt' });
    }
  }

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
    edit.kind === 'note' || edit.kind === 'document' ? 'modal-note-editor' : '',
    edit.kind === 'quote' || edit.kind === 'invoice' ? 'modal-finance-editor' : '',
    edit.kind === 'quote' ? 'modal-quote-editor' : '',
    edit.kind === 'client' ? 'modal-client-editor' : '',
    edit.kind === 'task' || edit.kind === 'ticket' || edit.kind === 'project' ? 'modal-task-editor' : '',
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
      {!item && <label className="check-row client-welcome-toggle">
        <input type="checkbox" checked={Boolean(form._sendWelcomeEmail)} onChange={e=>set('_sendWelcomeEmail', e.target.checked)} disabled={disabled || !String(form.email || '').trim()}/>
        <span>Welkomstmail met portaaltoegang sturen naar de klant{!String(form.email || '').trim() && <em className="client-welcome-hint"> — vul eerst een e-mailadres in</em>}</span>
      </label>}
      {item && <RelatedNotes title="Klantnotities" notes={data.notes.filter(note => note.client_id === item.id || data.projects.some(project => project.client_id === item.id && project.id === note.project_id))} data={data} canWrite={canWrite} onNew={() => onNewClientNote(item as Client)} onEdit={onEditNote} emptyText="Nog geen notities bij deze klant." />}
      {!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.client} id={item.id} onUploaded={onAttachmentsChanged}/>}
      {attachmentBlock}
    </FormGrid>}
    {edit.kind === 'project' && <FormGrid><Input value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Projectnaam"/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Omschrijving"/><Input type="date" value={form.start_date} onChange={e=>set('start_date',e.target.value)}/><Input type="date" value={form.end_date} onChange={e=>set('end_date',e.target.value)}/><Field label="Projectkleur" hint="Bepaalt de kleur van het project in lijsten, kanban en de timeline."><ColorPicker value={form.color} onChange={color=>set('color',color)} disabled={disabled}/></Field><label className="check-row"><input type="checkbox" checked={Boolean(form.archived)} onChange={e=>set('archived',e.target.checked)}/><span>Project archiveren</span></label>{!disabled && (item ? <FileUpload organizationId={organizationId} entity={editKindToEntity.project} id={item.id} onUploaded={onAttachmentsChanged}/> : <UploadHint/>)}{attachmentBlock}</FormGrid>}
    {edit.kind === 'task' && <FormGrid><Field label="Taaktitel"><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Taaktitel" disabled={disabled}/></Field><Field label="Status"><Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={disabled}><option value="todo">Te doen</option><option value="doing">Bezig</option><option value="review">Review</option><option value="done">Klaar</option></Select></Field><Field label="Prioriteit"><Select value={form.priority} onChange={e=>set('priority',e.target.value)} disabled={disabled}><option value="low">Laag</option><option value="med">Normaal</option><option value="high">Hoog</option></Select></Field><Field label="Tags" hint="Gebruik komma’s om meerdere tags toe te voegen."><Input value={form.tags} onChange={e=>set('tags',e.target.value)} placeholder="Tags" disabled={disabled}/></Field><Field label="Beschrijving"><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Beschrijving" disabled={disabled}/></Field><Field label="Startdatum"><Input type="date" value={form.start_date} onChange={e=>set('start_date',e.target.value)} disabled={disabled}/></Field><Field label="Deadline" hint="Deze datum blijft de inhoudelijke deadline en wordt niet meer aangepast door de weekplanner."><Input type="date" value={form.end_date} onChange={e=>set('end_date',e.target.value)} disabled={disabled}/></Field><Field label="Plandatum" hint="Deze datum bepaalt op welke dag de taak in de weekplanner staat."><Input type="date" value={form.planned_date} onChange={e=>set('planned_date',e.target.value)} disabled={disabled}/></Field><Field label="Geschatte duur" hint="In minuten. Wordt gebruikt voor de dag- en weekcapaciteit."><Input type="number" min="0" max="1440" step="15" value={form.estimated_minutes} onChange={e=>set('estimated_minutes',Number(e.target.value))} disabled={disabled}/></Field><TaskDetailEditor subtasks={form.subtasks} comments={form.comments} set={set}/>{!disabled && (item ? <FileUpload organizationId={organizationId} entity={editKindToEntity.task} id={item.id} onUploaded={onAttachmentsChanged}/> : <UploadHint/>)}{attachmentBlock}</FormGrid>}
    {edit.kind === 'ticket' && <FormGrid><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Ticket titel"/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Select value={form.priority} onChange={e=>set('priority',e.target.value)}><option value="low">Laag</option><option value="med">Normaal</option><option value="high">Hoog</option></Select><Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={Boolean((item as Ticket | undefined)?.converted_to_project_id)}><option value="new">Nieuw</option><option value="review">Review</option><option value="approved">Goedgekeurd</option><option value="rejected">Geweigerd</option>{(item as Ticket | undefined)?.converted_to_project_id && <option value="converted">Omgezet</option>}</Select><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Beschrijving"/><Field label="Korte interne notitie" hint="Privé memo op het ticket. Voor een gesprek met de klant gebruik je de tijdlijn hieronder."><Textarea value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="Interne notities (privé, niet in de tijdlijn)"/></Field><small className="ticket-status-hint">Gebruik <strong>Project maken</strong> om een ticket om te zetten. <strong>Omgezet</strong> is geen handmatige status.</small>{item ? <TicketNotesTimeline ticketId={item.id} organizationId={organizationId} currentUserId={currentUserId} notes={data.ticketNotes.filter(n => n.ticket_id === item.id)} canWrite={!disabled} onChanged={onAttachmentsChanged}/> : <div className="ticket-timeline-hint">Sla het ticket eerst op om de notitietijdlijn te gebruiken — daar kunnen jij en de klant berichten plaatsen.</div>}{!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.ticket} id={item.id} onUploaded={onAttachmentsChanged}/>}{attachmentBlock}</FormGrid>}
    {edit.kind === 'note' && <FormGrid>
      <Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Titel"/>
      <Select value={form.note_type} onChange={e=>set('note_type',e.target.value)}>{Object.entries(noteTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
      <RichTextEditor value={form.content} onChange={value=>set('content', value)} placeholder="Schrijf je notitie…" disabled={disabled}/>
      <Select value={form.client_id} onChange={e=>{set('client_id',e.target.value);set('folder_id','');}} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      <Select value={form.project_id} onChange={e=>set('project_id',e.target.value)} disabled={disabled}><option value="">Geen project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      {form.client_id && <Field label="Map" hint="Plaats deze notitie in een map van de gekozen klant.">
        <Select value={form.folder_id} onChange={e=>set('folder_id',e.target.value)} disabled={disabled}><option value="">Geen map</option>{clientFolderOptions(data.folders, form.client_id || null).map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</Select>
      </Field>}
      {noteCalEventsLoading && <div className="note-cal-hint">Meetings laden…</div>}
      {!noteCalEventsLoading && noteCalEvents.length > 0 && (
        <Field label="Koppel aan meeting" hint="Afgelopen 7 dagen en komende 14 dagen uit je gekoppelde agenda.">
          <MeetingPicker
            events={noteCalEvents}
            selectedId={(form._calLink as CalendarNoteLinkInput | null)?.provider_event_id ?? null}
            onSelect={ev => set('_calLink', ev ? buildCalendarNoteLinkInput(ev) : null)}
            disabled={disabled}
          />
        </Field>
      )}
      <Input value={form.tags} onChange={e=>set('tags',e.target.value)} placeholder="Tags, komma gescheiden" />
      {item && <div className="note-created-meta"><span>Aangemaakt: {new Date((item as Note).created_at).toLocaleString('nl-NL')}</span><span>Bijgewerkt: {new Date((item as Note).updated_at).toLocaleString('nl-NL')}</span></div>}
      {!disabled && (item ? <FileUpload organizationId={organizationId} entity={editKindToEntity.note} id={item.id} onUploaded={onAttachmentsChanged}/> : <UploadHint/>)}
      {attachmentBlock}
    </FormGrid>}
    {edit.kind === 'document' && <FormGrid>
      <Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Documenttitel"/>
      <Field label="Categorie">
        <Select value={form.document_type} onChange={e=>set('document_type',e.target.value)} disabled={disabled}>{Object.entries(documentTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
      </Field>
      <RichTextEditor value={form.content} onChange={value=>set('content', value)} placeholder="Schrijf de inhoud van het document…" disabled={disabled}/>
      <Field label="Klant">
        <Select value={form.client_id} onChange={e=>{set('client_id',e.target.value);set('folder_id','');}} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </Field>
      <Field label="Project">
        <Select value={form.project_id} onChange={e=>set('project_id',e.target.value)} disabled={disabled}><option value="">Geen project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      </Field>
      {form.client_id && <Field label="Map" hint="Plaats dit document in een map van de gekozen klant.">
        <Select value={form.folder_id} onChange={e=>set('folder_id',e.target.value)} disabled={disabled}><option value="">Geen map</option>{clientFolderOptions(data.folders, form.client_id || null).map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</Select>
      </Field>}
      <div className="document-export">
        <div className="document-export-actions">
          <Button onClick={handleDownloadPdf} disabled={docExport.busy !== null}>{docExport.busy === 'pdf' ? 'PDF maken…' : 'Download PDF'}</Button>
          <Button onClick={handleDownloadDocx} disabled={docExport.busy !== null}>{docExport.busy === 'docx' ? 'Word maken…' : 'Download Word (.docx)'}</Button>
        </div>
        <span className="document-export-hint">{item ? 'De PDF wordt ook opgeslagen in Cloudflare R2 en verschijnt hieronder als bijlage.' : 'Sla het document eerst op om de PDF ook in Cloudflare R2 te bewaren.'}</span>
        {docExport.error && <span className="document-export-error">{docExport.error}</span>}
      </div>
      {item && <div className="note-created-meta"><span>Aangemaakt: {new Date((item as InternalDocument).created_at).toLocaleString('nl-NL')}</span><span>Bijgewerkt: {new Date((item as InternalDocument).updated_at).toLocaleString('nl-NL')}</span></div>}
      {!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.document} id={item.id} onUploaded={onAttachmentsChanged}/>}
      {attachmentBlock}
    </FormGrid>}
    {(edit.kind === 'quote' || edit.kind === 'invoice') && <FinanceEditorLayout kind={edit.kind} data={data} organizationId={organizationId} form={form} set={set} item={item} readOnly={effectiveReadOnly} onUploaded={onAttachmentsChanged} attachmentBlock={attachmentBlock}/>}
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


/**
 * Tickettijdlijn: gedeelde notities/conversatie tussen medewerker en klant.
 * Toont alle notities chronologisch (nieuwste bovenaan). De medewerker kan een
 * notitie als intern markeren (verborgen voor de klant) en eigen/teamnotities
 * weer zichtbaar maken of verwijderen. Klantnotities komen binnen via het
 * portaal en zijn hier herkenbaar gelabeld.
 */
function TicketNotesTimeline({ ticketId, organizationId, currentUserId, notes, canWrite, onChanged }: { ticketId: string; organizationId: string; currentUserId: string | null; notes: TicketNote[]; canWrite: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...notes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [notes],
  );
  const clientCount = sorted.filter(n => n.author_type === 'client').length;
  const hiddenCount = sorted.filter(n => n.is_internal).length;

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Actie mislukt');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const body = draft.trim();
    if (!body) return;
    await run(async () => {
      await createTicketNote(organizationId, { ticketId, body, isInternal: internal });
      setDraft(''); setInternal(false);
    });
  }

  return <section className="ticket-timeline">
    <div className="ticket-timeline-head">
      <div>
        <strong>Tijdlijn</strong>
        <span>{sorted.length} notitie{sorted.length === 1 ? '' : 's'}{clientCount > 0 ? ` · ${clientCount} van klant` : ''}{hiddenCount > 0 ? ` · ${hiddenCount} verborgen` : ''}</span>
      </div>
    </div>

    <div className={`ticket-timeline-grid${canWrite ? '' : ' is-readonly'}`}>
      {canWrite && <div className="ticket-timeline-compose-col">
        <div className="ticket-timeline-composer">
          <Textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Schrijf een update voor de klant of een interne notitie…" rows={4} disabled={busy} />
          <div className="ticket-timeline-composer-actions">
            <label className={`ticket-visibility-toggle${internal ? ' is-internal' : ''}`}>
              <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} disabled={busy} />
              <span>{internal ? 'Verborgen voor klant' : 'Zichtbaar voor klant'}</span>
            </label>
            <Button variant="primary" onClick={add} disabled={busy || !draft.trim()}>{busy ? 'Plaatsen…' : (internal ? 'Plaats interne notitie' : 'Plaats notitie')}</Button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>}

      <div className="ticket-timeline-feed-col">
        {sorted.length === 0 ? <div className="ticket-timeline-empty">Nog geen notities. Plaats de eerste update — de klant ziet zichtbare notities terug in het portaal.</div> : <ol className="ticket-timeline-list">
          {sorted.map(note => {
            const isClient = note.author_type === 'client';
            const mine = note.author_user_id && currentUserId && note.author_user_id === currentUserId;
            return <li className={`ticket-timeline-item${isClient ? ' from-client' : ''}${note.is_internal ? ' is-internal' : ''}`} key={note.id}>
              <span className="ttl-dot" aria-hidden="true" />
              <div className="ttl-body">
                <div className="ttl-meta">
                  <span className="ttl-author">{isClient ? (note.author_name ? `${note.author_name} (klant)` : 'Klant') : (mine ? 'Jij' : (note.author_name || 'Teamlid'))}</span>
                  <span className={`ttl-badge ${isClient ? 'client' : note.is_internal ? 'internal' : 'visible'}`}>{isClient ? 'Klant' : note.is_internal ? 'Intern' : 'Zichtbaar voor klant'}</span>
                  <span className="ttl-time">{new Date(note.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="ttl-text">{note.body}</p>
                {canWrite && <div className="ttl-actions">
                  {!isClient && <button type="button" disabled={busy} onClick={() => run(() => setTicketNoteInternal(note.id, !note.is_internal, organizationId))}>{note.is_internal ? 'Zichtbaar maken voor klant' : 'Verbergen voor klant'}</button>}
                  <button type="button" className="ttl-delete" disabled={busy} onClick={() => { if (confirm('Deze notitie uit de tijdlijn verwijderen?')) void run(() => deleteTicketNote(note.id, organizationId)); }}>Verwijderen</button>
                </div>}
              </div>
            </li>;
          })}
        </ol>}
      </div>
    </div>
  </section>;
}


/** Hint shown in editors for not-yet-saved items: an entity id is required before uploading. */
function UploadHint() {
  return <div className="file-upload-hint">Sla dit item eerst op om officiële documenten en bijlagen toe te voegen.</div>;
}

function FileUpload({ organizationId, entity, id, onUploaded }: { organizationId: string; entity: EntityType; id: string; onUploaded: () => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="file-upload">
    <label className="file-upload-label">
      <span className="file-upload-cta">{busy ? 'Uploaden…' : 'Document of bijlage uploaden'}</span>
      <input type="file" disabled={busy} onChange={async e => {
        const f = e.target.files?.[0];
        if (!f) return;
        setMsg(''); setBusy(true);
        try {
          await uploadToR2(f, organizationId, { entity_type: entity, entity_id: id });
          setMsg(`Upload klaar: ${f.name}`);
          onUploaded();
        } catch (err) {
          setMsg(err instanceof Error ? err.message : 'Upload mislukt');
        } finally {
          setBusy(false);
          // Allow re-uploading the same file: clear the input.
          e.target.value = '';
        }
      }}/>
    </label>
    <small className="file-upload-meta">Max 25 MB per bestand. Opslag gaat versleuteld naar Cloudflare R2.</small>
    {msg && <small>{msg}</small>}
  </div>;
}


function isQuoteWorkflowLocked(quote: Quote): boolean {
  return quote.status !== 'draft';
}

// Bouw uit het bewerkformulier een doc-vormig object zodat dezelfde PDF-generator
// (createFinancePDFBlob/exportFinancePDF) gebruikt kan worden voor zowel de live preview
// als de download-knop. Eén bron voorkomt dat preview en download uit elkaar lopen.
function buildFinanceDocLike(kind: 'quote'|'invoice', form: Record<string, any>, item?: { id: string }): Quote & Invoice {
  const lines: FinanceLine[] = Array.isArray(form.lines) ? form.lines : [];
  return {
    id: item?.id ?? '',
    number: form.number || createFallbackFinanceNumber(kind),
    date: form.date,
    valid_until: form.valid_until ?? null,
    due_date: form.due_date ?? null,
    lines,
    notes: form.notes ?? null,
    status: form.status ?? 'draft',
    client_id: form.client_id ?? null,
    project_id: form.project_id ?? null,
  } as unknown as Quote & Invoice;
}

// Twee-panelen-layout: links het invulformulier, rechts de live PDF-preview.
// Op smalle schermen wordt er met een tab geschakeld tussen 'Bewerken' en 'Voorbeeld'.
function FinanceEditorLayout({ kind, data, organizationId, form, set, item, readOnly, onUploaded, attachmentBlock }: { kind: 'quote'|'invoice'; data: AppData; organizationId: string; form: Record<string, any>; set: (k:string,v:unknown)=>void; item?: { id: string }; readOnly: boolean; onUploaded: () => void; attachmentBlock: React.ReactNode }) {
  const [view, setView] = useState<'edit'|'preview'>('edit');
  const client = useMemo(() => data.clients.find(c => c.id === form.client_id) ?? null, [data.clients, form.client_id]);
  // Alleen de velden die het document beïnvloeden; bij wijziging hiervan regenereert de preview.
  const docLike = useMemo(
    () => buildFinanceDocLike(kind, form, item),
    [kind, item, form.number, form.date, form.valid_until, form.due_date, form.lines, form.notes, form.status, form.client_id, form.project_id],
  );

  return <div className="finance-editor-layout" data-view={view}>
    <div className="finance-editor-tabs" role="tablist" aria-label="Editor en voorbeeld">
      <button type="button" role="tab" aria-selected={view === 'edit'} className={view === 'edit' ? 'is-active' : ''} onClick={() => setView('edit')}>Bewerken</button>
      <button type="button" role="tab" aria-selected={view === 'preview'} className={view === 'preview' ? 'is-active' : ''} onClick={() => setView('preview')}>Voorbeeld</button>
    </div>
    <div className="finance-form-pane">
      <FinanceForm kind={kind} data={data} organizationId={organizationId} form={form} set={set} item={item} readOnly={readOnly} onUploaded={onUploaded} attachmentBlock={attachmentBlock}/>
    </div>
    <div className="finance-preview-pane">
      <FinanceDocPreview doc={docLike} kind={kind} client={client} company={data.companySettings}/>
    </div>
  </div>;
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

  const updateLine = (id: string, k: keyof FinanceLine, v: string | number) => set('lines', lines.map(l => {
    if (l.id !== id) return l;
    if (k === 'description') return { ...l, description: v };
    // Geldvelden: nooit negatief, en btw op een realistisch maximum begrenzen.
    const numeric = Number(v);
    const safe = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
    const clamped = k === 'vat' ? Math.min(safe, 100) : safe;
    return { ...l, [k]: clamped };
  }));
  const addLine = () => set('lines', [...lines, { id: uid(), description: '', quantity: 1, unit_price: 0, vat: 21 }]);
  const removeLine = (id: string) => set('lines', lines.length <= 1 ? lines : lines.filter(x => x.id !== id));

  const handleDownloadPdf = () => {
    const client = data.clients.find(c => c.id === form.client_id) ?? null;
    // Build a doc-shaped object from the current form so the user can preview before saving.
    const docLike = buildFinanceDocLike(kind, form, item);
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
          const lineTotal = lineGross(line);
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
            <div className="finance-line-total"><span>Regeltotaal</span><strong>{euro(lineTotal)}</strong></div>
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
    return { name: item?.name ?? edit.defaults?.name ?? "", client_code: item?.client_code ?? "", contact_name: item?.contact_name ?? edit.defaults?.contact_name ?? "", email: item?.email ?? edit.defaults?.email ?? "", phone: item?.phone ?? edit.defaults?.phone ?? "", status: item?.status ?? edit.defaults?.status ?? "active", value_eur: item?.value_eur ?? 0, tags: item?.tags?.join(", ") ?? "", notes: item?.notes ?? edit.defaults?.notes ?? "", color: item?.color ?? "#FFD966", _sendWelcomeEmail: !item };
  }
  if (edit.kind === "project") {
    const item = edit.item;
    return { name: item?.name ?? edit.defaults?.name ?? "", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", description: item?.description ?? edit.defaults?.description ?? "", color: normalizeColor(item?.color, DEFAULT_PROJECT_COLOR), archived: item?.archived ?? false, start_date: item?.start_date ?? edit.defaults?.start_date ?? "", end_date: item?.end_date ?? edit.defaults?.end_date ?? "" };
  }
  if (edit.kind === "task") {
    const item = edit.item;
    return { title: item?.title ?? edit.defaults?.title ?? "", description: item?.description ?? edit.defaults?.description ?? "", status: item?.status ?? edit.defaults?.status ?? "todo", priority: item?.priority ?? edit.defaults?.priority ?? "med", tags: item?.tags?.join(", ") ?? edit.defaults?.tags?.join(", ") ?? "", start_date: item?.start_date ?? edit.defaults?.start_date ?? "", end_date: item?.end_date ?? edit.defaults?.end_date ?? "", planned_date: item?.planned_date ?? edit.defaults?.planned_date ?? "", estimated_minutes: item?.estimated_minutes ?? edit.defaults?.estimated_minutes ?? 60, subtasks: normalizeSubtasks(item?.subtasks ?? edit.defaults?.subtasks), comments: normalizeComments(item?.comments) };
  }
  if (edit.kind === "ticket") {
    const item = edit.item;
    return { title: item?.title ?? "", description: item?.description ?? "", client_id: item?.client_id ?? "", priority: item?.priority ?? "med", status: item?.status ?? "new", notes: item?.notes ?? "" };
  }
  if (edit.kind === "note") {
    const item = edit.item;
    return { title: item?.title ?? edit.defaults?.title ?? "", content: item?.content ?? edit.defaults?.content ?? "", note_type: item?.note_type ?? edit.defaults?.note_type ?? "general", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", folder_id: item?.folder_id ?? edit.defaults?.folder_id ?? "", tags: item?.tags?.join(", ") ?? edit.defaults?.tags?.join(", ") ?? "", _calLink: edit.calendarLink ?? null };
  }
  if (edit.kind === "document") {
    const item = edit.item;
    return { title: item?.title ?? edit.defaults?.title ?? "", content: item?.content ?? edit.defaults?.content ?? "", document_type: item?.document_type ?? edit.defaults?.document_type ?? "general", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", folder_id: item?.folder_id ?? edit.defaults?.folder_id ?? "" };
  }
  const today = new Date().toISOString().slice(0,10);
  if (edit.kind === "quote") {
    const item = edit.item;
    return { number: item?.number ?? createNextFinanceNumber('quote', data), client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", date: item?.date ?? today, valid_until: item?.valid_until ?? edit.defaults?.valid_until ?? "", status: item?.status ?? "draft", internal_approval_status: item?.internal_approval_status ?? "draft", notes: item?.notes ?? edit.defaults?.notes ?? "", lines: item?.lines ?? edit.defaults?.lines ?? [{ id: uid(), description: "", quantity: 1, unit_price: 0, vat: 21 }] };
  }
  const item = edit.item;
  return { number: item?.number ?? createNextFinanceNumber('invoice', data), client_id: item?.client_id ?? edit.defaults?.client_id ?? "", project_id: item?.project_id ?? edit.defaults?.project_id ?? "", date: item?.date ?? today, due_date: item?.due_date ?? edit.defaults?.due_date ?? "", status: item?.status ?? "draft", notes: item?.notes ?? edit.defaults?.notes ?? "", lines: item?.lines ?? edit.defaults?.lines ?? [{ id: uid(), description: "", quantity: 1, unit_price: 0, vat: 21 }] };
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
  for (const key of ["client_id","project_id","folder_id","quote_id","valid_until","due_date","start_date","end_date","planned_date"]) {
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
  if (kind === 'document') {
    cleaned.document_type = typeof cleaned.document_type === 'string' && cleaned.document_type ? cleaned.document_type : 'general';
    cleaned.title = String(cleaned.title || '').trim() || `Document ${new Date().toLocaleDateString('nl-NL')}`;
    cleaned.content = sanitizeRichText(String(cleaned.content || ''));
  }
  if (kind === 'task') {
    cleaned.subtasks = normalizeSubtasks(cleaned.subtasks).filter((subtask: Subtask) => subtask.label.trim().length > 0);
    cleaned.comments = normalizeComments(cleaned.comments).filter((comment: TaskComment) => comment.text.trim().length > 0);
    const estimatedMinutes = Number(cleaned.estimated_minutes);
    cleaned.estimated_minutes = Number.isFinite(estimatedMinutes) ? Math.max(0, Math.min(1440, Math.round(estimatedMinutes))) : 60;
    delete cleaned.planned_order;
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
