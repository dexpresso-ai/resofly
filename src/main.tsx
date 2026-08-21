import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { BottomNav } from './components/BottomNav';
import { loadPersistedTabs, savePersistedTabs, viewTitle, PAGE_TITLES, type PersistedTab } from './lib/workspaceTabs';
import { buildPermissions, EDIT_KIND_MODULE, firstAllowedPage, MODULE_LABELS, PAGE_MODULE, type ModuleAccess } from './lib/permissions';
import type { SearchResult } from './components/GlobalSearch';
import { Button, ColorPicker, DEFAULT_PROJECT_COLOR, Input, Select, Textarea, normalizeColor } from './components/Ui';
import { RichTextEditor, sanitizeRichText } from './components/RichTextEditor';
import { Modal } from './components/Modal';
import { Menu, X } from 'lucide-react';
import { isSupabaseConfigured, supabase, supabaseAuth } from './lib/supabase';
import {
  acceptOrganizationInvitation,
  convertAcceptedQuoteToInvoice,
  convertTicketToProject,
  createClientWithServerCode,
  createCampaign,
  createTicketNote,
  setTicketNoteInternal,
  deleteTicketNote,
  sendClientPortalWelcomeEmail,
  deleteAttachment,
  createNoteCalendarLink,
  createNoteWithCalendarLink,
  createOrganization,
  createChildOrganization,
  applyProjectTemplate,
  deleteEntityCascade,
  deleteNoteCalendarLink,
  upsertCalendarEventLink,
  deleteCalendarEventLink,
  createTimeEntry,
  updateTimeEntry,
  disableOrganizationMember,
  createSavedReport,
  insertRow,
  inviteOrganizationMember,
  sendTeamInvitationEmail,
  loadAppData,
  loadOrganizationContext,
  previewNextClientCode,
  planTaskInWeek,
  setTaskPlanningPeriod,
  fetchTasksForPlannedDates,
  selectTaskAssignees,
  createPlannerNote,
  updatePlannerNote,
  deletePlannerNote,
  revokeOrganizationInvitation,
  submitQuoteForInternalApproval,
  approveQuoteInternal,
  rejectQuoteInternal,
  sendInvoiceEmailViaResend,
  sendInvoiceReminderEmail,
  setInvoiceRemindersPaused,
  proposeInvoiceDunningNotice,
  sendInvoiceDunningNotice,
  cancelInvoiceDunningNotice,
  sendQuoteEmailViaResend,
  downloadQuotePdfSnapshot,
  downloadInvoicePdfSnapshot,
  downloadInvoiceUbl,
  downloadCreditNoteUbl,
  createInvoiceRefund,
  postSalesInvoiceToLedger,
  bookAllUnbookedSalesInvoices,
  postCreditNoteToLedger,
  downloadCreditNotePdf,
  sendCreditNoteEmail,
  loadInvoiceMollieStatus,
  updateOrganizationMemberRole,
  setMemberModuleAccess,
  updateRow,
  upsertCompanySettings,
  markTicketRead,
  setTaskAssignees,
  addProjectMember,
  removeProjectMember,
  createClientContact,
  updateClientContact,
  type Table,
} from './lib/repository';
import { memberShortName, memberColor, memberInitials } from './lib/members';
import { uploadToR2 } from './lib/r2';
import { listExternalCalendarEvents, createExternalCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from './lib/calendar-api';
import { buildDocumentPdfBlob, buildDocumentDocxBlob, downloadBlob, documentFileBaseName, type DocumentExportMeta } from './lib/documentExport';
import { createOfficeSessionForDocument, uploadDocumentDocx, uploadOfficeDocumentFile, createBlankOfficeDocument, downloadOfficeDocument, officeFileNameForDocument, warmupOfficeEditor, OFFICE_UPLOAD_ACCEPT, NEW_OFFICE_LABEL, type OfficeSession, type NewOfficeType } from './lib/office';
import { deleteR2Object } from './lib/r2-api';
import { OfficeEditor } from './features/OfficeEditor';
import { Dashboard } from './features/Dashboard';
import { ClientDetailPage, Clients } from './features/Clients';
import { useClientEmailUnread, ClientEmailToasts } from './components/ClientEmailNotifications';
import { useTicketUnread, TicketToasts } from './components/TicketNotifications';
import { useTeamChat, TeamChatPage, TeamChatDock } from './components/TeamChat';
import { usePushNotifications } from './components/usePushNotifications';
import { ProjectPage, ProjectsListPage, ProjectsPlanningPage } from './features/Projects';
import { TimeTracking } from './features/TimeTracking';
import { Tickets } from './features/Tickets';
import { Marketing } from './features/Marketing';
import { RelatedNotes, noteTypeLabels } from './features/Notes';
import { documentTypeLabels } from './features/Documents';
import { ContentLibrary } from './features/ContentLibrary';
import { clientFolderOptions } from './lib/folders';
import { Invoices, Quotes, type RefundInput } from './features/Finance';
import { LedgerPage, PurchaseInvoicesPage, SuppliersPage, nextPurchaseNumber, purchaseTotals } from './features/Bookkeeping';
import type { InvoiceFormSeed } from './features/Bookkeeping';
import { BankPage } from './features/Bank';
import { AssetsPage } from './features/Assets';
import { ProfitLossPage } from './features/ProfitLoss';
import { VatReturnsPage } from './features/VatReturns';
import { FiscalYearsPage } from './features/FiscalYears';
import { CorporateTaxPage } from './features/CorporateTax';
import { DgaPage } from './features/Dga';
import { ShareholdersPage } from './features/Shareholders';
import { AnnualAccountsPage } from './features/AnnualAccounts';
import { PublicQuotePage } from './features/PublicQuotePage';
import { PublicInvoicePage } from './features/PublicInvoicePage';
import { PublicContractPage } from './features/PublicContractPage';
import { PublicBookingPage } from './features/PublicBookingPage';
import { PublicGalleryPage } from './features/PublicGalleryPage';
import { GalleryTab } from './features/ProjectGallery';
import { Contracts } from './features/Contracts';
import { ClientPortal } from './features/portal/ClientPortal';
import { Archive, Settings, type SettingsTab } from './features/SimplePages';
import { ProjectTemplatePicker } from './features/ProjectTemplates';
import { Statistics } from './features/Statistics';
import type { ReportDefinition } from './lib/reporting';
import { CalendarPage } from './features/CalendarPage';
import { MeetingBookingManager } from './features/MeetingBookingManager';
import { WeekPlanner } from './features/WeekPlanner';
import { applyPeriodLocally, applyPlanningLocally, mergeTaskRows } from './lib/planning';
import { formatISODate, parseISODate, startOfWeek } from './lib/dates';
import { AttachmentList } from './components/AttachmentList';
import { GerrieChat } from './components/GerrieChat';
import { GerrieCommandCenter } from './features/GerrieCommandCenter';
import type { GerrieActionHandlers, GerrieProposal } from './lib/gerrie-api';
import { runRegistryAction } from './lib/actions';
import { saveRoutine, setRoutineStatus, runRoutineNow } from './lib/gerrie-api';
import { plainTextToEmailHtml, sendClientEmail } from './services/mailService';
import { exportFinancePDF } from './lib/pdf';
import { FinanceDocPreview } from './components/FinanceDocPreview';
import type {
  AppData, CalendarEventLink, CalendarExternalEvent, CalendarNoteLinkInput, Client, ClientFieldDefinition, CompanySettingsInput, Contract, CreditNote, DunningNotice, EntityType, FinanceLine, InternalDocument, Invoice, Note, OrganizationContext, OrganizationMember, OrganizationRole, Project, ProjectMember, PurchaseInvoice, PurchaseInvoiceLine, Quote, Supplier, Task, TaskStatus, Ticket, TicketNote, Subtask, Comment as TaskComment,
} from './types';
import { CustomFieldsSection, normalizeCustomFieldValues } from './components/CustomFields';
import { euro, total, uid, lineGross } from './lib/format';
import './styles/globals.css';

type Page = 'dashboard'|'gerrie'|'weekplanner'|'calendar'|'meeting-booking'|'time'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'projects'|'project-planning'|'tickets'|'chat'|'marketing'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'pnl'|'vat-returns'|'corporate-tax'|'dga'|'shareholders'|'fiscal-years'|'annual-accounts'|'archive'|'settings'|'project'|'gallery';
type EditMode =
  | { kind: 'client'; item?: Client; defaults?: Partial<Pick<Client, 'name' | 'contact_name' | 'email' | 'phone' | 'notes' | 'status'>> }
  | { kind: 'project'; item?: Project; defaults?: Partial<Pick<Project, 'name' | 'client_id' | 'description' | 'start_date' | 'end_date'>> }
  | { kind: 'task'; item?: Task; projectId?: string | null; defaults?: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'start_date' | 'end_date' | 'planned_date' | 'estimated_minutes' | 'subtasks' | 'project_id' | 'client_id'>> }
  | { kind: 'ticket'; item?: Ticket; defaults?: Partial<Pick<Ticket, 'title' | 'description' | 'client_id' | 'priority' | 'status' | 'notes'>> }
  | { kind: 'note'; item?: Note; defaults?: Partial<Pick<Note, 'client_id' | 'project_id' | 'folder_id' | 'title' | 'content' | 'note_type' | 'tags'>>; calendarLink?: CalendarNoteLinkInput }
  | { kind: 'document'; item?: InternalDocument; defaults?: Partial<Pick<InternalDocument, 'client_id' | 'project_id' | 'folder_id' | 'title' | 'content' | 'document_type'>> }
  | { kind: 'quote'; item?: Quote; defaults?: Partial<Pick<Quote, 'client_id' | 'project_id' | 'notes' | 'valid_until' | 'lines'>> }
  | { kind: 'invoice'; item?: Invoice; defaults?: Partial<Pick<Invoice, 'client_id' | 'project_id' | 'notes' | 'due_date' | 'lines'>> }
  | null;

const emptyData: AppData = { clients: [], clientContacts: [], clientFieldDefinitions: [], projects: [], projectTemplates: [], projectTemplateTasks: [], tasks: [], projectMembers: [], taskAssignees: [], contractProjects: [], tickets: [], ticketNotes: [], notes: [], documents: [], folders: [], noteCalendarLinks: [], calendarEventLinks: [], timeEntries: [], quotes: [], quoteApprovalEvents: [], quoteEmailDeliveries: [], quoteVersions: [], invoices: [], invoiceWorkflowEvents: [], invoiceEmailDeliveries: [], invoicePaymentRecords: [], invoiceVersions: [], invoiceRefunds: [], creditNotes: [], invoiceChargebacks: [], dunningNotices: [], ledgerAccounts: [], vatCodes: [], journalEntries: [], journalLines: [], closedPeriods: [], fiscalYears: [], suppliers: [], purchaseInvoices: [], fixedAssets: [], assetDepreciations: [], vatReturns: [], bankAccounts: [], bankStatements: [], bankTransactions: [], bankRules: [], bankRequisitions: [], attachments: [], galleries: [], savedReports: [], plannerNotes: [], companySettings: null };
const emptyOrganizationContext: OrganizationContext = { memberships: [], organizations: [], activeOrganization: null, activeMembership: null, teamMembers: [], pendingInvitations: [], organizationInvitations: [], licenseUsage: null, auditLogs: [], billingOverview: null, creativeStatus: null, businessStatus: null };
const activeOrgStorageKey = 'brandcore.activeOrganizationId';

// === Actieve tabbladen =====================================================
// De view-state (welke pagina, welk project/klant, welke editor open staat) leeft
// per tabblad. Zo blijft half afgemaakt werk staan als je naar een ander tabblad
// wisselt. De werkruimte-state (data, organisatie, notificaties) blijft gedeeld.
type ViewState = {
  page: Page;
  projectId: string | null;
  clientId: string | null;
  statsReportId: string | null;
  /** Alleen gevuld op de pagina 'gallery': welke galerij dit tabblad toont. */
  galleryId: string | null;
  settingsNav: { tab: SettingsTab; key: number } | null;
  pendingReport: { key: string; name: string; definition: ReportDefinition } | null;
  /** Net aangemaakte agent; de Gerrie-pagina klapt hem meteen open zodat je ziet
   *  wie er nu voor je aan het werk is. */
  openAgentId: string | null;
  /**
   * Door een agent klaargezet concept dat in het formulier van een ándere pagina
   * moet openen (leverancier, inkoopfactuur, contract, campagne). Eén veld voor
   * alle vier: het patroon is telkens hetzelfde en vier losse velden zou vier keer
   * dezelfde plumbing zijn. `key` maakt hem uniek, zodat twee keer hetzelfde
   * concept ook twee keer opent.
   */
  pendingDraft: { key: string; kind: 'supplier' | 'purchase_invoice' | 'contract' | 'campaign'; payload: Record<string, unknown> } | null;
  edit: EditMode;
};
type WorkspaceTab = ViewState & { id: string };

/** Nieuw, leeg tabblad op een gegeven pagina (standaard het dashboard). */
function freshTab(page: Page = 'dashboard'): WorkspaceTab {
  return { id: uid(), page, projectId: null, clientId: null, statsReportId: null, galleryId: null, settingsNav: null, pendingReport: null, openAgentId: null, pendingDraft: null, edit: null };
}

/** Terugkomst van de directe bankkoppeling (PSD2, ?code=&state=…): dan opent het
 *  eerste tabblad meteen de Bankpagina, die de koppeling afrondt. */
function hasBankReturn(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('code')
    && new URLSearchParams(window.location.search).has('state');
}

/** Past een React-setterwaarde (directe waarde óf updater-functie) toe op de vorige waarde. */
function applyUpdater<T>(value: React.SetStateAction<T>, prev: T): T {
  return typeof value === 'function' ? (value as (p: T) => T)(prev) : value;
}

/** Herbouwt volledige tabbladen uit de (route-only) opgeslagen versie. Verwijzingen
 *  naar niet langer bestaande projecten/klanten vallen terug op de lijstpagina. */
function rebuildTabs(persisted: PersistedTab[], data: AppData): WorkspaceTab[] {
  return persisted.map(p => {
    // De agenda-instellingen zijn verhuisd naar Instellingen → tabblad Agenda.
    // Een tabblad dat nog op de oude pagina stond komt daar netjes uit.
    const legacyCalendarSettings = p.page === 'calendar-settings';
    let page = (legacyCalendarSettings ? 'settings' : PAGE_TITLES[p.page] ? p.page : 'dashboard') as Page;
    let projectId = p.projectId;
    let clientId = p.clientId;
    let galleryId = p.galleryId;
    if (page === 'project' && !data.projects.some(x => x.id === projectId)) { page = 'projects'; projectId = null; }
    if (page === 'client' && !data.clients.some(x => x.id === clientId)) { page = 'clients'; clientId = null; }
    // Een galerij die intussen is verwijderd zou een leeg tabblad geven; val dan
    // terug op het project waar hij bij hoorde, of anders op de projectlijst.
    if (page === 'gallery' && !data.galleries.some(x => x.id === galleryId)) {
      galleryId = null;
      page = data.projects.some(x => x.id === projectId) ? 'project' : 'projects';
      if (page === 'projects') projectId = null;
    }
    return { id: uid(), page, projectId, clientId, statsReportId: p.statsReportId, galleryId, settingsNav: legacyCalendarSettings ? { tab: 'agenda', key: 0 } : null, pendingReport: null, openAgentId: null, pendingDraft: null, edit: null };
  });
}

/**
 * Vertaalt een concept-contract naar de vorm die `ContractForm` verwacht. De editor
 * denkt in centen; het voorstel praat in euro's, omdat een model daar minder mee
 * mis rekent.
 */
function contractDraftFrom(payload: Record<string, unknown>): Partial<Contract> {
  const amount = typeof payload.amount_eur === 'number' ? Math.round(payload.amount_eur * 100) : null;
  return {
    client_id: (payload.client_id as string | null) ?? null,
    title: String(payload.title ?? ''),
    body: String(payload.body ?? ''),
    valid_until: (payload.valid_until as string | null) ?? null,
    amount_cents: amount,
  };
}

/**
 * Vertaalt een concept-inkoopfactuur naar de `InvoiceFormSeed` die het formulier al
 * kende van de AI-factuurscan. Bedragen gaan naar centen; de grootboekrekening laten
 * we bewust leeg — die kiest de gebruiker, dat is precies het stuk dat een mens hoort
 * te doen.
 */
function purchaseInvoiceSeedFrom(payload: Record<string, unknown>): InvoiceFormSeed {
  const rawLines = Array.isArray(payload.lines) ? (payload.lines as Array<Record<string, unknown>>) : [];
  return {
    supplierId: (payload.supplierId as string | null) ?? null,
    newSupplier: null,
    source: 'ai_scan',
    form: {
      supplier_invoice_number: String(payload.supplier_invoice_number ?? ''),
      date: String(payload.date ?? ''),
      due_date: String(payload.due_date ?? ''),
      notes: String(payload.notes ?? ''),
    },
    lines: rawLines.map((l) => ({
      id: uid(),
      description: String(l.description ?? ''),
      amount_cents: Math.round(Number(l.amount_eur ?? 0) * 100),
      vat_code: Number(l.vat_rate) === 9 ? 'LAAG' : Number(l.vat_rate) === 0 ? 'GEEN' : 'HOOG',
      vat_rate: Number(l.vat_rate ?? 21),
      account_id: null,
    })),
    pendingFile: null,
    extractionMeta: { source: 'gerrie_agent' },
    ai: { confidence: 'medium', warnings: ['Door een agent opgesteld — controleer de regels en kies de grootboekrekeningen.'] },
  };
}

/** Een voorstel dat op een bewerkformulier uitkomt: waar het scherm heen moet, en wat erin staat. */
type ProposalEditTarget = { edit: NonNullable<EditMode>; page: Page; projectId?: string | null };

/**
 * Vertaalt een voorstel van Gerrie naar dezelfde bewerking die het formulier zou tonen.
 *
 * Eén bron, twee uitgangen: het scherm openen zodat je het nakijkt, óf meteen
 * wegschrijven omdat je op Aanmaken drukt. Zouden die twee elk hun eigen vertaling
 * hebben, dan is het een kwestie van tijd tot "openen" iets anders invult dan
 * "aanmaken" — en dat verschil zie je pas terug in de database.
 *
 * Geeft null voor voorstellen die geen bewerkformulier hebben (leverancier, contract,
 * inkoopfactuur, rapportage — die kennen hun eigen scherm), en een error-object als het
 * voorstel naar een rij verwijst die hier niet (meer) bestaat.
 */
function editModeForProposal(p: GerrieProposal, data: AppData): ProposalEditTarget | { error: string } | null {
  switch (p.type) {
    case 'invoice':
      return { page: 'invoices', edit: { kind: 'invoice', item: undefined, defaults: {
        client_id: p.client_id, notes: p.notes ?? undefined, due_date: p.due_date ?? undefined,
        lines: p.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat })),
      } } };
    case 'quote':
      return { page: 'quotes', edit: { kind: 'quote', item: undefined, defaults: {
        client_id: p.client_id, notes: p.notes ?? undefined, valid_until: p.valid_until ?? undefined,
        lines: p.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat })),
      } } };
    case 'client':
      return { page: 'clients', edit: { kind: 'client', item: undefined, defaults: {
        name: p.name, contact_name: p.contact_name ?? undefined, email: p.email ?? undefined,
        phone: p.phone ?? undefined, notes: p.notes ?? undefined, status: (p.status as Client['status']),
      } } };
    case 'edit_invoice': {
      const existing = data.invoices.find((i) => i.id === p.id);
      if (!existing) return { error: 'Factuur niet gevonden.' };
      const merged: Invoice = { ...existing };
      if (p.changes.lines) merged.lines = p.changes.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat }));
      if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
      if (p.changes.due_date !== undefined) merged.due_date = p.changes.due_date;
      return { page: 'invoices', edit: { kind: 'invoice', item: merged } };
    }
    case 'edit_quote': {
      const existing = data.quotes.find((q) => q.id === p.id);
      if (!existing) return { error: 'Offerte niet gevonden.' };
      const merged: Quote = { ...existing };
      if (p.changes.lines) merged.lines = p.changes.lines.map((l) => ({ id: uid(), description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat: l.vat }));
      if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
      if (p.changes.valid_until !== undefined) merged.valid_until = p.changes.valid_until;
      return { page: 'quotes', edit: { kind: 'quote', item: merged } };
    }
    case 'edit_client': {
      const existing = data.clients.find((c) => c.id === p.id);
      if (!existing) return { error: 'Klant niet gevonden.' };
      const merged: Client = { ...existing };
      if (p.changes.name !== undefined) merged.name = p.changes.name;
      if (p.changes.contact_name !== undefined) merged.contact_name = p.changes.contact_name;
      if (p.changes.email !== undefined) merged.email = p.changes.email;
      if (p.changes.phone !== undefined) merged.phone = p.changes.phone;
      if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
      if (p.changes.status !== undefined) merged.status = p.changes.status as Client['status'];
      return { page: 'clients', edit: { kind: 'client', item: merged } };
    }
    case 'project':
      return { page: 'projects', edit: { kind: 'project', item: undefined, defaults: {
        name: p.name, client_id: p.client_id ?? undefined, description: p.description ?? undefined,
        start_date: p.start_date ?? undefined, end_date: p.end_date ?? undefined,
      } } };
    case 'edit_project': {
      const existing = data.projects.find((pr) => pr.id === p.id);
      if (!existing) return { error: 'Project niet gevonden.' };
      const merged: Project = { ...existing };
      if (p.changes.name !== undefined) merged.name = p.changes.name;
      if (p.changes.client_id !== undefined) merged.client_id = p.changes.client_id;
      if (p.changes.description !== undefined) merged.description = p.changes.description;
      if (p.changes.start_date !== undefined) merged.start_date = p.changes.start_date;
      if (p.changes.end_date !== undefined) merged.end_date = p.changes.end_date;
      if (p.changes.archived !== undefined) merged.archived = p.changes.archived;
      return { page: 'projects', edit: { kind: 'project', item: merged } };
    }
    case 'task':
      return { page: 'project', projectId: p.project_id, edit: { kind: 'task', item: undefined, projectId: p.project_id, defaults: {
        title: p.title, description: p.description ?? undefined, status: p.status as Task['status'], priority: p.priority as Task['priority'],
        tags: p.tags, start_date: p.start_date ?? undefined, end_date: p.end_date ?? undefined, planned_date: p.planned_date ?? undefined,
        estimated_minutes: p.estimated_minutes, subtasks: p.subtasks.map((sub) => ({ id: uid(), label: sub.label, done: sub.done })),
      } } };
    case 'edit_task': {
      const existing = data.tasks.find((t) => t.id === p.id);
      if (!existing) return { error: 'Taak niet gevonden.' };
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
      if (c.subtasks !== undefined) merged.subtasks = c.subtasks.map((sub) => ({ id: uid(), label: sub.label, done: sub.done }));
      return { page: existing.project_id ? 'project' : 'weekplanner', projectId: existing.project_id, edit: { kind: 'task', item: merged, projectId: existing.project_id } };
    }
    case 'ticket':
      return { page: 'tickets', edit: { kind: 'ticket', item: undefined, defaults: {
        title: p.title, description: p.description ?? undefined, client_id: p.client_id ?? undefined,
        priority: p.priority as Ticket['priority'], status: p.status as Ticket['status'],
      } } };
    case 'edit_ticket': {
      const existing = data.tickets.find((t) => t.id === p.id);
      if (!existing) return { error: 'Ticket niet gevonden.' };
      const merged: Ticket = { ...existing };
      if (p.changes.title !== undefined) merged.title = p.changes.title;
      if (p.changes.description !== undefined) merged.description = p.changes.description;
      if (p.changes.notes !== undefined) merged.notes = p.changes.notes;
      if (p.changes.status !== undefined) merged.status = p.changes.status as Ticket['status'];
      if (p.changes.priority !== undefined) merged.priority = p.changes.priority as Ticket['priority'];
      return { page: 'tickets', edit: { kind: 'ticket', item: merged } };
    }
    case 'content': {
      const defaults = {
        title: p.title, content: p.content,
        client_id: p.client_id ?? undefined, project_id: p.project_id ?? undefined,
      };
      return p.kind === 'note'
        ? { page: 'notes', edit: { kind: 'note', item: undefined, defaults } }
        : { page: 'documents', edit: { kind: 'document', item: undefined, defaults } };
    }
    default:
      return null;
  }
}

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

function getPublicBookingTokenFromLocation(): string | null {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('booking_token');
  if (queryToken) return queryToken;
  const match = url.pathname.match(/^\/booking\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getPublicGalleryTokenFromLocation(): string | null {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('gallery_token');
  if (queryToken) return queryToken;
  const match = url.pathname.match(/^\/gallerij\/([^/]+)\/?$/);
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

const ORG_ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/** Getoond wanneer de ingelogde gebruiker (nog) geen actieve organisatie heeft.
 *  Cruciaal voor een teamlid dat voor het eerst inlogt: een uitnodiging wordt pas
 *  een lidmaatschap zodra het teamlid die accepteert. Zonder deze knop belandde de
 *  invitee op een doodlopend "Geen organisatie gevonden"-scherm waar de enige actie
 *  was om een eigen (losse) organisatie te maken — precies niet de bedoeling.
 *  Openstaande uitnodigingen (server-side al gefilterd op het eigen e-mailadres)
 *  kunnen hier direct worden aanvaard; wie er geen heeft, maakt een eigen org. */
function NoOrganizationScreen({
  pendingInvitations,
  onAcceptInvitation,
  onCreateOrganization,
}: {
  pendingInvitations: OrganizationContext['pendingInvitations'];
  onAcceptInvitation: (invitationId: string) => Promise<void>;
  onCreateOrganization: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept(invitationId: string) {
    setError(null);
    setBusyId(invitationId);
    try {
      // Bij succes herlaadt de aanroeper de werkruimte (switchOrganization), waardoor
      // dit scherm vanzelf plaatsmaakt voor de app. Faalt het, dan blijven we hier.
      await onAcceptInvitation(invitationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uitnodiging accepteren mislukt.');
      setBusyId(null);
    }
  }

  if (pendingInvitations.length > 0) {
    return <div className="boot"><div className="login-card">
      <h1>Je bent uitgenodigd</h1>
      <p>Accepteer je uitnodiging om samen te werken in het team.</p>
      {error && <div className="error">{error}</div>}
      <div className="team-list">
        {pendingInvitations.map(invitation => <div className="team-row" key={invitation.id}>
          <div><span>{invitation.email}</span><small>Rol: {ORG_ROLE_LABELS[invitation.role]}</small></div>
          <Button variant="primary" disabled={busyId !== null} onClick={() => accept(invitation.id)}>
            {busyId === invitation.id ? 'Bezig…' : 'Accepteren'}
          </Button>
        </div>)}
      </div>
      <Button variant="ghost" disabled={busyId !== null} onClick={onCreateOrganization}>Of maak een eigen organisatie</Button>
    </div></div>;
  }

  return <div className="boot"><div className="login-card">
    <h1>Geen organisatie gevonden</h1>
    <p>Er kon geen organisatie voor je account worden geladen.</p>
    <Button variant="primary" onClick={onCreateOrganization}>Organisatie maken</Button>
  </div></div>;
}

function App() {
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [data, setData] = useState<AppData>(emptyData);
  const [organizationContext, setOrganizationContext] = useState<OrganizationContext>(emptyOrganizationContext);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(() => localStorage.getItem(activeOrgStorageKey));
  // Open tabbladen blijven allemaal gemount (keep-alive); alleen het actieve is
  // zichtbaar. Het opstart-tabblad opent de Bankpagina bij een PSD2-terugkomst
  // (?code=&state=…), anders het dashboard. De opgeslagen tabbladen per organisatie
  // worden na het laden van de werkruimte hersteld (zie restoreTabsForOrganization).
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => [freshTab(hasBankReturn() ? 'bank' : 'dashboard')]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  // Muteer uitsluitend het actieve tabblad. Door de setters onder hun vertrouwde
  // namen te herdefiniëren blijven alle bestaande handlers, Gerrie-acties en toasts
  // hieronder ongewijzigd werken en richten ze zich vanzelf op het zichtbare tabblad.
  function patchActiveTab(patch: (t: WorkspaceTab) => Partial<ViewState>) {
    setTabs(ts => ts.map(t => (t.id === activeTab.id ? { ...t, ...patch(t) } : t)));
  }
  const page = activeTab.page;
  const projectId = activeTab.projectId;
  const clientId = activeTab.clientId;
  const statsReportId = activeTab.statsReportId;
  const settingsNav = activeTab.settingsNav;
  const pendingReport = activeTab.pendingReport;
  const edit = activeTab.edit;
  const setPage = (v: React.SetStateAction<Page>) => patchActiveTab(t => ({ page: applyUpdater(v, t.page) }));
  const setProjectId = (v: React.SetStateAction<string | null>) => patchActiveTab(t => ({ projectId: applyUpdater(v, t.projectId) }));
  const setClientId = (v: React.SetStateAction<string | null>) => patchActiveTab(t => ({ clientId: applyUpdater(v, t.clientId) }));
  const setStatsReportId = (v: React.SetStateAction<string | null>) => patchActiveTab(t => ({ statsReportId: applyUpdater(v, t.statsReportId) }));
  const galleryId = activeTab.galleryId;
  const setSettingsNav = (v: React.SetStateAction<{ tab: SettingsTab; key: number } | null>) => patchActiveTab(t => ({ settingsNav: applyUpdater(v, t.settingsNav) }));
  const setPendingReport = (v: React.SetStateAction<{ key: string; name: string; definition: ReportDefinition } | null>) => patchActiveTab(t => ({ pendingReport: applyUpdater(v, t.pendingReport) }));
  const setOpenAgentId = (v: React.SetStateAction<string | null>) => patchActiveTab(t => ({ openAgentId: applyUpdater(v, t.openAgentId) }));
  const setPendingDraft = (v: ViewState['pendingDraft']) => patchActiveTab(() => ({ pendingDraft: v }));
  const setEdit = (v: React.SetStateAction<EditMode>) => patchActiveTab(t => ({ edit: applyUpdater(v, t.edit) }));
  // Word-modus voor interne Documents: de Collabora-editor leeft op app-niveau, zodat een
  // Word-document vanuit elke pagina (project/klant/Inhoud) geopend kan worden.
  const [officeSession, setOfficeSession] = useState<OfficeSession | null>(null);
  const [officeOpening, setOfficeOpening] = useState(false);
  // Wek de Collabora-render-engine alvast op pagina's waar office-bestanden geopend kunnen
  // worden — een koude containerboot overlapt dan met het navigeren i.p.v. met de klik op
  // het bestand. Throttled in warmupOfficeEditor (5 min per tab) + server-side (1 min).
  useEffect(() => {
    if (page === 'content' || page === 'notes' || page === 'documents' || page === 'client' || page === 'project') {
      warmupOfficeEditor();
    }
  }, [page]);
  /** Het document dat in de editor openstaat — drijft de "Downloaden"-knop (native formaat). */
  const [officeDoc, setOfficeDoc] = useState<InternalDocument | null>(null);
  // Mobiel uitschuifmenu (drawer). Op laptop/desktop is de zijbalk een iconenbalk
  // die bij hover openschuift; dit stuurt alleen het mobiele gedrag (≤760px) aan.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Laptop/desktop: menu vastzetten (blijft uitgeklapt, content schuift mee).
  // Keuze onthouden tussen sessies.
  const [sidebarPinned, setSidebarPinned] = useState(() => localStorage.getItem('brandcore.sidebarPinned') === '1');
  const [loading, setLoading] = useState(false);
  // Wanneer dit een tekst bevat, draait er een schermvullende laad-overlay. Wordt
  // gezet bij trage Resend-verzendacties (offerte/factuur/creditfactuur) zodat de
  // gebruiker ziet dat de app bezig is en niet per ongeluk dubbel verstuurt.
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const publicQuoteToken = getPublicQuoteTokenFromLocation();
  const publicInvoiceToken = getPublicInvoiceTokenFromLocation();
  const publicContractToken = getPublicContractTokenFromLocation();
  const publicBookingToken = getPublicBookingTokenFromLocation();
  const publicGalleryToken = getPublicGalleryTokenFromLocation();
  const portalRoute = isClientPortalRoute();

  // Track which user + organization we have loaded data for, so auth events do not
  // trigger duplicate refreshes for the same workspace.
  const loadedForRef = useRef<string | null>(null);
  // Voor welke organisatie de opgeslagen tabbladen al zijn hersteld, zodat een
  // gewone ververs de open tabbladen niet opnieuw laadt (alleen bij eerste
  // load / organisatiewissel).
  const tabsLoadedForRef = useRef<string | null>(null);

  const activeOrganization = organizationContext.activeOrganization;
  const activeMembership = organizationContext.activeMembership;
  // Organisatiebreed schrijfrecht (rol). Per módule kan dit alsnog beperkt zijn —
  // gebruik daarom binnen een pagina `permissions.canWritePage(...)`.
  const orgCanWrite = activeMembership ? ['owner', 'admin', 'member'].includes(activeMembership.role) : false;
  const canAdmin = activeMembership ? ['owner', 'admin'].includes(activeMembership.role) : false;
  // Modulerechten van dit lid: bepaalt welke modules in de navigatie verschijnen
  // en of er binnen een module gewijzigd mag worden. De database dwingt hetzelfde
  // af (restrictive RLS + schrijf-triggers); dit is de beleving eromheen.
  const permissions = useMemo(() => buildPermissions(activeMembership), [activeMembership]);

  // Ongelezen klant-mail (per gebruiker) + live notificaties bij nieuwe berichten.
  const {
    unread: clientEmailUnread,
    refreshUnread: refreshClientEmailUnread,
    toasts: clientEmailToasts,
    dismissToast: dismissClientEmailToast,
  } = useClientEmailUnread({
    organizationId: activeOrganization?.id ?? null,
    currentUserId,
    resolveClientName: (clientId) => data.clients.find(c => c.id === clientId)?.name ?? '',
  });

  // Ongelezen tickets (per gebruiker) + live meldingen bij nieuwe klant-activiteit.
  const {
    unreadIds: ticketUnreadIds,
    refreshUnread: refreshTicketUnread,
    toasts: ticketToasts,
    dismissToast: dismissTicketToast,
  } = useTicketUnread({
    organizationId: activeOrganization?.id ?? null,
    currentUserId,
    teamMemberIds: new Set((organizationContext.teamMembers ?? []).map(m => m.user_id).filter((id): id is string => !!id)),
    resolveClientName: (clientId) => (clientId ? data.clients.find(c => c.id === clientId)?.name ?? 'Onbekende klant' : 'Geen klant'),
    resolveTicket: (ticketId) => {
      const ticket = data.tickets.find(t => t.id === ticketId);
      if (!ticket) return null;
      return { title: ticket.title, clientName: ticket.client_id ? data.clients.find(c => c.id === ticket.client_id)?.name ?? 'Onbekende klant' : 'Geen klant' };
    },
    onActivity: () => { void refresh(); },
  });

  // Teamchat — één realtime-/presence-abonnement op App-niveau, gedeeld door de
  // sidebar-badge, de volledige chatpagina en het zwevende paneel.
  const teamChat = useTeamChat({
    organizationId: activeOrganization?.id ?? null,
    currentUserId,
    teamMembers: organizationContext.teamMembers ?? [],
  });

  // OS-/device-pushmeldingen (service worker + Web Push). Registreert de worker,
  // houdt het abonnement bij en biedt aan/uit + per-gebeurtenis voorkeuren aan.
  // De UI hiervoor leeft in Instellingen → Meldingen.
  const push = usePushNotifications({
    organizationId: activeOrganization?.id ?? null,
    currentUserId,
  });

  // Herstel de open tabbladen voor een organisatie: de opgeslagen set (route-only),
  // of anders één vers dashboard-tabblad. Bij een PSD2-bankterugkomst altijd één
  // Bank-tabblad zodat de koppeling wordt afgerond.
  function restoreTabsForOrganization(organizationId: string, loaded: AppData) {
    if (hasBankReturn()) {
      const bank = freshTab('bank');
      setTabs([bank]); setActiveTabId(bank.id);
      return;
    }
    const persisted = loadPersistedTabs(organizationId);
    const rebuilt = persisted ? rebuildTabs(persisted.tabs, loaded) : [];
    if (rebuilt.length) {
      const index = Math.min(Math.max(0, persisted!.activeIndex), rebuilt.length - 1);
      setTabs(rebuilt); setActiveTabId(rebuilt[index].id);
    } else {
      const fresh = freshTab('dashboard');
      setTabs([fresh]); setActiveTabId(fresh.id);
    }
  }

  async function loadWorkspace(preferredOrganizationId = activeOrganizationId) {
    setLoading(true); setError(null);
    try {
      const orgContext = await loadOrganizationContext(preferredOrganizationId);
      setOrganizationContext(orgContext);
      const orgId = orgContext.activeOrganization?.id ?? null;
      setActiveOrganizationId(orgId);
      if (orgId) {
        localStorage.setItem(activeOrgStorageKey, orgId);
        const loaded = await loadAppData(orgId);
        setData(loaded);
        // Herstel de open tabbladen éénmalig per organisatie (eerste load of wissel);
        // een gewone ververs laat de tabbladen ongemoeid.
        if (orgId !== tabsLoadedForRef.current) {
          tabsLoadedForRef.current = orgId;
          restoreTabsForOrganization(orgId, loaded);
        }
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

  /**
   * Herlaadt de werkruimte, maar hoogstens één keer per reeks.
   *
   * Een afvinklijst verstuurt regel voor regel: vink je twintig facturen aan, dan
   * zou een volledige herlaadslag per factuur de lijst tot stilstand brengen.
   * Deze bundelt ze tot één slag kort nadat de laatste regel klaar is — de
   * verzending zelf is dan al bevestigd, alleen het beeld loopt een tel achter.
   */
  const refreshTimer = useRef<number | null>(null);
  function scheduleRefresh() {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void refresh(); }, 400);
  }
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current); }, []);

  /** Staat de Mollie-koppeling aan? Kort gecachet per organisatie (30 s), zodat een
   *  reeks facturen niet per regel dezelfde vraag stelt. */
  const mollieCache = useRef<{ orgId: string; at: number; connected: boolean } | null>(null);
  async function mollieConnected(orgId: string): Promise<boolean> {
    const cached = mollieCache.current;
    if (cached && cached.orgId === orgId && Date.now() - cached.at < 30_000) return cached.connected;
    const mollie = await loadInvoiceMollieStatus(orgId);
    const connected = mollie.status === 'connected';
    mollieCache.current = { orgId, at: Date.now(), connected };
    return connected;
  }

  async function switchOrganization(organizationId: string) {
    // De open tabbladen worden door loadWorkspace hersteld voor de nieuwe organisatie
    // (org verschilt van tabsLoadedForRef → herstel volgt automatisch).
    loadedForRef.current = null;
    await loadWorkspace(organizationId);
  }

  // Opent de instellingenpagina op een specifieke sectie (standaard 'organisatie').
  // De oplopende `key` zorgt dat óók herhaald op dezelfde sectie klikken de tab opent.
  // Gebruikt door zowel het account-menu (zijbalk) als de dashboard-onboarding.
  function openSettings(tab: SettingsTab = 'organisatie') {
    setSettingsNav(prev => ({ tab, key: (prev?.key ?? 0) + 1 }));
    setPage('settings');
    setProjectId(null);
    setClientId(null);
    setStatsReportId(null);
    setMobileNavOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
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

  // Een extra administratie onder dezelfde organisatie: holding + werk-BV. De
  // rechtsvorm start op BV (daar is de module voor) en is daarna aan te passen
  // bij Instellingen → Bedrijfsgegevens.
  async function createNewEntity() {
    if (!activeOrganizationId) return;
    const name = prompt('Naam van de nieuwe administratie (bijvoorbeeld de werk-BV)');
    if (!name?.trim()) return;
    setLoading(true); setError(null);
    try {
      const org = await createChildOrganization(activeOrganizationId, name, 'bv');
      await switchOrganization(org.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Administratie aanmaken mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function inviteMember(email: string, role: OrganizationRole, moduleAccess: ModuleAccess = {}): Promise<{ emailSent: boolean; emailError?: string }> {
    if (!ensureCanAdmin()) throw new Error('Alleen owners en admins kunnen teamleden uitnodigen.');
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    const invitation = await inviteOrganizationMember(activeOrganizationId, email, role, moduleAccess);
    // De uitnodiging staat nu in de database. De e-mail is een aparte stap: faalt
    // die, dan blijft de uitnodiging bestaan en melden we dat apart terug.
    let emailSent = false;
    let emailError: string | undefined;
    try {
      await sendTeamInvitationEmail(activeOrganizationId, invitation.id);
      emailSent = true;
    } catch (error) {
      emailError = error instanceof Error ? error.message : 'Uitnodigingsmail verzenden mislukt.';
    }
    await loadWorkspace(activeOrganizationId);
    return { emailSent, emailError };
  }

  async function acceptInvitation(invitationId: string) {
    const membership = await acceptOrganizationInvitation(invitationId);
    await switchOrganization(membership.organization_id);
  }

  /** Owners zijn tegen elkaar beschermd: niemand raakt de rij van een ándere
   *  actieve owner aan. De database dwingt dit ook af (RLS + trigger, migratie
   *  20260802000000); hier vangen we het vóór de call af met een nette melding. */
  function assertNotPeerOwner(memberId: string, action: string) {
    const target = organizationContext.teamMembers.find(member => member.id === memberId);
    if (target && target.role === 'owner' && target.status === 'active' && target.user_id !== currentUserId) {
      throw new Error(`Owners zijn tegen elkaar beschermd: je kunt een andere owner niet ${action}.`);
    }
  }

  async function changeMemberRole(memberId: string, role: OrganizationRole) {
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    if (!activeMembership || activeMembership.role !== 'owner') throw new Error('Alleen owners kunnen rollen wijzigen.');
    assertNotPeerOwner(memberId, 'degraderen');
    await updateOrganizationMemberRole(memberId, activeOrganizationId, role);
    await loadWorkspace(activeOrganizationId);
  }

  /** Modulerechten van één teamlid opslaan. De RPC bewaakt zelf wie dit mag
   *  (owner/admin, en niet op een owner); hier alleen de snelle voorcontrole. */
  async function changeMemberModuleAccess(memberId: string, moduleAccess: ModuleAccess) {
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    if (!canAdmin) throw new Error('Alleen owners en admins kunnen modulerechten aanpassen.');
    await setMemberModuleAccess(memberId, moduleAccess);
    await loadWorkspace(activeOrganizationId);
  }

  async function disableMember(memberId: string) {
    if (!activeOrganizationId) throw new Error('Geen actieve organisatie.');
    if (!activeMembership || activeMembership.role !== 'owner') throw new Error('Alleen owners kunnen teamleden uitschakelen.');
    assertNotPeerOwner(memberId, 'uitschakelen');
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
    if (!orgCanWrite) {
      setError('Je hebt alleen-lezen toegang tot deze organisatie. Vraag een owner/admin om schrijfrechten.');
      return false;
    }
    // Binnen de organisatie mag je schrijven, maar deze módule kan dichtstaan.
    if (!permissions.canWritePage(page)) {
      const moduleKey = PAGE_MODULE[page];
      const label = moduleKey ? MODULE_LABELS[moduleKey] : 'deze module';
      setError(`Je hebt geen wijzigrechten voor ${label}. Vraag een owner of admin om deze module voor je open te zetten.`);
      return false;
    }
    return true;
  }

  /** Mag er in het bewerkvenster van dit soort record gewijzigd worden? Volgt de
   *  module van het record zelf (een factuur blijft financieel, ook als je hem
   *  vanuit een project opent). */
  function canEditKind(kind: string): boolean {
    if (!orgCanWrite) return false;
    const moduleKey = EDIT_KIND_MODULE[kind];
    return moduleKey ? permissions.canWrite(moduleKey) : true;
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
      // De runtime-sessie draagt het e-mailadres, ook al is het type smaller.
      setCurrentUserEmail((session?.user as { email?: string | null } | undefined)?.email ?? null);
      setSessionReady(true);
      if (userId && userId !== loadedForRef.current) {
        loadedForRef.current = userId;
        await loadWorkspace(localStorage.getItem(activeOrgStorageKey));
      } else if (!userId) {
        loadedForRef.current = null;
        tabsLoadedForRef.current = null;
        localStorage.removeItem(activeOrgStorageKey);
        setActiveOrganizationId(null);
        setOrganizationContext(emptyOrganizationContext);
        setData(emptyData);
        const fresh = freshTab('dashboard');
        setTabs([fresh]); setActiveTabId(fresh.id);
      }
    }

    supabaseAuth.getSession().then(({ data }) => { void applySession(data.session); });
    const { data: sub } = supabaseAuth.onAuthStateChange((_event, session) => { void applySession(session); });

    return () => { active = false; sub.subscription.unsubscribe(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mobiel menu sluiten met Escape.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  const project = useMemo(() => data.projects.find(p => p.id === projectId) ?? null, [data.projects, projectId]);
  const client = useMemo(() => data.clients.find(c => c.id === clientId) ?? null, [data.clients, clientId]);

  // Onthoud de open tabbladen (alleen routes) per organisatie zodat ze na een
  // herlaad terugkomen. Pas opslaan nadat we voor deze organisatie hersteld hebben,
  // anders zou het opstart-tabblad de opgeslagen set overschrijven.
  useEffect(() => {
    if (!activeOrganizationId || tabsLoadedForRef.current !== activeOrganizationId) return;
    const persisted: PersistedTab[] = tabs.map(t => ({ page: t.page, projectId: t.projectId, clientId: t.clientId, statsReportId: t.statsReportId, galleryId: t.galleryId }));
    const activeIndex = Math.max(0, tabs.findIndex(t => t.id === activeTabId));
    savePersistedTabs(activeOrganizationId, persisted, activeIndex);
  }, [tabs, activeTabId, activeOrganizationId]);

  // "+" opent een nieuw (dashboard)tabblad; het menu navigeert vervolgens het
  // actieve tabblad.
  function openTab() {
    const tab = freshTab('dashboard');
    setTabs([...tabs, tab]);
    setActiveTabId(tab.id);
    setMobileNavOpen(false);
  }
  /**
   * Opent één galerij als eigen tabblad. Staat hij al open, dan springen we
   * daarheen in plaats van een tweede tabblad met hetzelfde te maken — anders
   * verzamel je duplicaten bij elke klik.
   */
  function openGalleryTab(targetGalleryId: string, targetProjectId: string | null) {
    const existing = tabs.find(t => t.page === 'gallery' && t.galleryId === targetGalleryId);
    if (existing) {
      setActiveTabId(existing.id);
      setMobileNavOpen(false);
      return;
    }
    const tab: WorkspaceTab = {
      ...freshTab('gallery'),
      galleryId: targetGalleryId,
      // Het project onthouden zodat "terug" en het herstellen na herladen weten
      // waar deze galerij bij hoort.
      projectId: targetProjectId,
    };
    setTabs([...tabs, tab]);
    setActiveTabId(tab.id);
    setMobileNavOpen(false);
  }
  function switchTab(id: string) {
    setActiveTabId(id);
    setMobileNavOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  function closeTab(id: string) {
    const target = tabs.find(t => t.id === id);
    if (!target) return;
    if (target.edit && !confirm('Dit tabblad heeft een niet-opgeslagen bewerking open. Toch sluiten?')) return;
    // Nooit 0 tabbladen: het laatste sluiten vervangt door een vers dashboard-tabblad.
    if (tabs.length <= 1) {
      const fresh = freshTab('dashboard');
      setTabs([fresh]); setActiveTabId(fresh.id);
      return;
    }
    const idx = tabs.findIndex(t => t.id === id);
    const next = tabs.filter(t => t.id !== id);
    setTabs(next);
    if (activeTab.id === id) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      setActiveTabId(neighbor.id);
    }
  }

  if (portalRoute) return <ClientPortal />;
  if (!isSupabaseConfigured) return <div className="boot"><div className="login-card"><h1>Configuratie ontbreekt</h1><p>Vul eerst VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in .env.local in.</p></div></div>;
  if (publicQuoteToken) return <PublicQuotePage token={publicQuoteToken} />;
  if (publicInvoiceToken) return <PublicInvoicePage token={publicInvoiceToken} />;
  if (publicContractToken) return <PublicContractPage token={publicContractToken} />;
  if (publicBookingToken) return <PublicBookingPage token={publicBookingToken} />;
  if (publicGalleryToken) return <PublicGalleryPage token={publicGalleryToken} />;
  if (!sessionReady) return <BootLoading />;
  if (!loggedIn) return <Login />;
  // Zolang de werkruimte nog wordt geladen weten we nog niet of er een organisatie
  // is. Toon dan het laadscherm i.p.v. kort "Geen organisatie gevonden" te flitsen;
  // die melding is alléén terecht als het laden klaar is en er echt geen org is.
  if (!activeOrganization && loading) return <BootLoading />;
  if (!activeOrganization) return <NoOrganizationScreen pendingInvitations={organizationContext.pendingInvitations} onAcceptInvitation={acceptInvitation} onCreateOrganization={createNewOrganization} />;

  const activeOrg = activeOrganization;

  /**
   * Controleert de waarden vóór opslaan. Zit los van het formulier omdat Gerrie
   * dezelfde weg gebruikt: een voorstel dat hier niet doorheen komt, hoort ook niet
   * ongezien in de database te belanden.
   */
  function validateEditValues(kind: NonNullable<EditMode>['kind'], values: Record<string, unknown>): string | null {
    if (kind !== 'quote' && kind !== 'invoice') return null;
    const financeLines = Array.isArray(values.lines) ? (values.lines as FinanceLine[]) : [];
    const meaningfulLines = financeLines.filter(line => String(line.description || '').trim().length > 0 && Number(line.quantity || 0) > 0);
    if (meaningfulLines.length === 0) return 'Voeg minimaal één regel toe met een omschrijving en een aantal groter dan 0.';
    if (!(total(financeLines).total > 0)) return 'Het documenttotaal moet groter zijn dan € 0,00.';
    return null;
  }

  /**
   * Schrijft één bewerking weg — de enige plek waar dat gebeurt.
   *
   * Zowel de knop Opslaan in het formulier als Gerrie's "Aanmaken" komt hier langs.
   * Dat is bewust: zou Gerrie een eigen insert doen, dan lopen de twee wegen vroeg of
   * laat uiteen (een veld dat het formulier wél normaliseert, een sjabloon dat alleen
   * daar wordt uitgerold) en merk je dat pas aan een scheve rij in de database.
   *
   * Geeft terug wat er gebeurd is (voor de bevestiging in de chat) plus een
   * niet-blokkerende waarschuwing, bijvoorbeeld: klant is aangemaakt maar de
   * welkomstmail ging niet weg.
   */
  async function persistEdit(mode: NonNullable<EditMode>, values: Record<string, unknown>): Promise<{ label: string; warning: string | null }> {
    const edit = mode;
    let deferredWarning: string | null = null;
    let label = '';
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
        label = `Klant "${String(clientValues.name ?? '')}" ${edit.item ? 'bijgewerkt' : 'aangemaakt'}`;
        break;
      }
      case 'project': {
        // _templateId is een UI-keuze bij het aanmaken, geen projectkolom.
        const { _templateId, ...rest } = values;
        const projectValues = {
          ...rest,
          archived: typeof rest.archived === 'boolean' ? rest.archived : false,
        };

        if (edit.item) {
          await updateRow<Project>('projects', edit.item.id, projectValues, activeOrg.id);
        } else {
          const newProject = await insertRow<Project>('projects', activeOrg.id, projectValues);
          const templateId = typeof _templateId === 'string' ? _templateId : '';
          if (templateId) {
            try {
              await applyProjectTemplate(activeOrg.id, newProject.id, templateId, newProject.start_date);
            } catch (templateError) {
              // Het project staat er al; alleen het uitrollen faalde. Niet
              // terugdraaien, wél melden — de gebruiker kan het sjabloon
              // daarna alsnog handmatig nalopen.
              deferredWarning = `Project "${newProject.name}" is aangemaakt, maar de sjabloontaken konden niet worden toegevoegd: ${templateError instanceof Error ? templateError.message : 'onbekende fout'}`;
            }
          }
        }
        label = `Project "${String(values.name ?? '')}" ${edit.item ? 'bijgewerkt' : 'aangemaakt'}`;
        break;
      }
      case 'task': {
        // _assigneeIds is een UI-veld (relatie), geen taakkolom: eruit halen
        // vóór opslaan en daarna apart als task_assignees wegschrijven.
        const { _assigneeIds, ...taskValues } = values;
        const assigneeIds = Array.isArray(_assigneeIds) ? (_assigneeIds as string[]) : null;
        // project_id/client_id komen uit het formulier zelf: een taak mag ook los
        // (zonder project of klant) bestaan en later pas gekoppeld worden.
        const savedTask = edit.item
          ? await updateRow<Task>('tasks', edit.item.id, taskValues, activeOrg.id)
          : await insertRow<Task>('tasks', activeOrg.id, taskValues);
        if (assigneeIds) await setTaskAssignees(activeOrg.id, savedTask.id, assigneeIds);
        label = `Taak "${savedTask.title}" ${edit.item ? 'bijgewerkt' : 'aangemaakt'}`;
        break;
      }
      case 'ticket': {
        const sanitizedValues = sanitizeTicketValues(values, edit.item);
        edit.item
          ? await updateRow<Ticket>('tickets', edit.item.id, sanitizedValues, activeOrg.id)
          : await insertRow<Ticket>('tickets', activeOrg.id, sanitizedValues);
        label = `Ticket "${String(sanitizedValues.title ?? '')}" ${edit.item ? 'bijgewerkt' : 'aangemaakt'}`;
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
        label = `Notitie "${String(noteValues.title ?? '')}" ${edit.item ? 'bijgewerkt' : 'aangemaakt'}`;
        break;
      }
      case 'document':
        edit.item
          ? await updateRow<InternalDocument>('documents', edit.item.id, values, activeOrg.id)
          : await insertRow<InternalDocument>('documents', activeOrg.id, values);
        label = `Document "${String(values.title ?? '')}" ${edit.item ? 'bijgewerkt' : 'aangemaakt'}`;
        break;
      case 'quote':
        edit.item
          ? await updateRow<Quote>('quotes', edit.item.id, values, activeOrg.id)
          : await insertRow<Quote>('quotes', activeOrg.id, values);
        label = `Offerte ${String(values.number ?? '')} ${edit.item ? 'bijgewerkt' : 'aangemaakt als concept'}`;
        break;
      case 'invoice':
        edit.item
          ? await updateRow<Invoice>('invoices', edit.item.id, values, activeOrg.id)
          : await insertRow<Invoice>('invoices', activeOrg.id, values);
        label = `Factuur ${String(values.number ?? '')} ${edit.item ? 'bijgewerkt' : 'aangemaakt als concept'}`;
        break;
    }
    return { label, warning: deferredWarning };
  }

  /**
   * Menselijke uitleg bij een opslagfout. Een dubbel factuurnummer levert anders
   * alleen de kale Postgres-index op, en daar kan niemand iets mee.
   */
  function saveErrorMessage(e: unknown): string {
    const msg = e instanceof Error ? e.message : 'Opslaan mislukt';
    // Uniek-factuurnummer-index (migratie 20260721): race of handmatig dubbel nummer.
    return /invoices_org_number_key|duplicate key.*invoices/i.test(msg)
      ? 'Dit factuurnummer bestaat al binnen je organisatie. Kies een ander nummer en sla opnieuw op.'
      : msg;
  }

  /** Opslaan vanuit het bewerkformulier: valideren, wegschrijven, sluiten, verversen. */
  async function saveEdit(values: Record<string, unknown>) {
    if (!edit) return;
    if (!ensureCanWrite()) return;
    const invalid = validateEditValues(edit.kind, values);
    if (invalid) { setError(invalid); return; }
    setLoading(true); setError(null);
    try {
      const { warning } = await persistEdit(edit, values);
      setEdit(null);
      await refresh();
      // Pas ná refresh tonen: refresh wist de foutbanner.
      if (warning) setError(warning);
    } catch (e) {
      setError(saveErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  /** Open een intern Document: Word-modus → Collabora-editor; rich-text → de gewone editor-modal. */
  async function openDocument(doc: InternalDocument) {
    if (!doc.storage_key) { setEdit({ kind: 'document', item: doc }); return; }
    setOfficeOpening(true); setError(null);
    try {
      setOfficeSession(await createOfficeSessionForDocument(doc.id));
      setOfficeDoc(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kon de Word-editor niet openen');
    } finally {
      setOfficeOpening(false);
    }
  }

  /** Zet een bestaand rich-text Document eenmalig om naar een Word-document (.docx op R2) en open het. */
  async function convertDocumentToWord(doc: InternalDocument) {
    if (doc.storage_key) { await openDocument(doc); return; }
    setOfficeOpening(true); setError(null);
    try {
      const client = data.clients.find(c => c.id === doc.client_id);
      const project = data.projects.find(p => p.id === doc.project_id);
      const meta: DocumentExportMeta = {
        title: doc.title || 'Document',
        categoryLabel: documentTypeLabels[(doc.document_type || 'general') as keyof typeof documentTypeLabels] ?? 'Algemeen',
        clientName: client?.name ?? null,
        projectName: project?.name ?? null,
        dateLabel: new Date(doc.created_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }),
        companyName: data.companySettings?.company_name ?? null,
        content: doc.content || '',
      };
      const blob = buildDocumentDocxBlob(meta);
      const up = await uploadDocumentDocx(activeOrg.id, doc.title || 'Document', blob);
      await updateRow<InternalDocument>('documents', doc.id, { storage_key: up.key, mime_type: up.mime_type, size_bytes: up.size_bytes }, activeOrg.id);
      await refresh();
      setOfficeSession(await createOfficeSessionForDocument(doc.id));
      setOfficeDoc({ ...doc, storage_key: up.key, mime_type: up.mime_type, size_bytes: up.size_bytes });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Omzetten naar Word mislukt');
    } finally {
      setOfficeOpening(false);
    }
  }

  /**
   * Maak een document rechtstreeks vanuit een geüpload Word/Excel/PowerPoint-bestand
   * (Office-modus vanaf dag één) en open het meteen in de editor.
   */
  async function createDocumentFromOfficeFile(file: File, values: Record<string, unknown>) {
    if (!ensureCanWrite()) return;
    setOfficeOpening(true); setError(null);
    try {
      const up = await uploadOfficeDocumentFile(activeOrg.id, file);
      const title = String(values.title || '').trim() || file.name.replace(/\.[a-z0-9]+$/i, '') || 'Document';
      let doc: InternalDocument;
      try {
        doc = await insertRow<InternalDocument>('documents', activeOrg.id, {
          title,
          document_type: values.document_type || 'general',
          client_id: values.client_id ?? null,
          project_id: values.project_id ?? null,
          folder_id: values.folder_id ?? null,
          content: '',
          storage_key: up.key,
          mime_type: up.mime_type,
          size_bytes: up.size_bytes,
        });
      } catch (e) {
        await deleteR2Object(up.key).catch((cleanupErr) => {
          console.warn('Office-upload opruimen mislukt na documents-insert-fout (mogelijk weesbestand in R2):', up.key, cleanupErr);
        });
        throw e;
      }
      setEdit(null);
      await refresh();
      setOfficeSession(await createOfficeSessionForDocument(doc.id));
      setOfficeDoc(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kon het document niet aanmaken vanuit het bestand');
    } finally {
      setOfficeOpening(false);
    }
  }

  /**
   * Maak een document aan als nieuw, leeg Word/Excel/PowerPoint-bestand — Office-modus vanaf
   * dag één, zonder dat er eerst iets geüpload hoeft te worden — en open het meteen in de editor.
   */
  async function createDocumentFromBlankOffice(docType: NewOfficeType, values: Record<string, unknown>) {
    if (!ensureCanWrite()) return;
    setOfficeOpening(true); setError(null);
    try {
      const title = String(values.title || '').trim() || 'Nieuw document';
      const up = await createBlankOfficeDocument(activeOrg.id, docType, title);
      let doc: InternalDocument;
      try {
        doc = await insertRow<InternalDocument>('documents', activeOrg.id, {
          title,
          document_type: values.document_type || 'general',
          client_id: values.client_id ?? null,
          project_id: values.project_id ?? null,
          folder_id: values.folder_id ?? null,
          content: '',
          storage_key: up.key,
          mime_type: up.mime_type,
          size_bytes: up.size_bytes,
        });
      } catch (e) {
        await deleteR2Object(up.key).catch((cleanupErr) => {
          console.warn('Office-sjabloon opruimen mislukt na documents-insert-fout (mogelijk weesbestand in R2):', up.key, cleanupErr);
        });
        throw e;
      }
      setEdit(null);
      await refresh();
      setOfficeSession(await createOfficeSessionForDocument(doc.id));
      setOfficeDoc(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kon het document niet aanmaken');
    } finally {
      setOfficeOpening(false);
    }
  }

  /** Download het openstaande Office-document in z'n originele formaat (.docx/.xlsx/.pptx). */
  async function downloadOfficeDoc() {
    if (!officeDoc) return;
    try {
      await downloadOfficeDocument(officeDoc.id, officeFileNameForDocument(officeDoc));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download mislukt');
    }
  }

  async function removeCurrent() {
    if (!edit || !('item' in edit) || !edit.item) return;
    if (!ensureCanWrite()) return;
    // Geboekte/verstuurde facturen zijn niet verwijderbaar (bewaarplicht + het
    // grootboek zou een journaalpost zonder brondocument overhouden). De database
    // blokkeert dit sinds migratie 20260721 ook hard; hier vangen we het vóór de
    // confirm af met een duidelijke uitleg.
    if (edit.kind === 'invoice') {
      const inv = edit.item as Invoice;
      if (inv.journal_entry_id) {
        setError('Deze factuur staat in het grootboek en kan niet worden verwijderd. Boek de journaalpost tegen of maak een creditnota.');
        return;
      }
      if (inv.status && inv.status !== 'draft') {
        setError(inv.status === 'cancelled' || inv.status === 'void'
          ? 'Deze factuur is geannuleerd maar valt onder de bewaarplicht en kan niet worden verwijderd.'
          : `Deze factuur is al verstuurd (status: ${inv.status}) en valt onder de bewaarplicht. Annuleer of crediteer de factuur in plaats van verwijderen.`);
        return;
      }
    }
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

  /**
   * Verplaatst een taak in de weekplanner. De kaart staat meteen op zijn nieuwe
   * plek (dezelfde hernummering als de database zou doen), daarna bevestigt de
   * RPC en lezen we alleen de geraakte plandagen terug. Een volledige refresh
   * zou bij elke sleepbeweging de hele werkruimte opnieuw ophalen.
   */
  async function updateTaskPlanning(taskId: string, plannedDate: string | null, beforeTaskId?: string | null) {
    if (!ensureCanWrite()) return;
    setError(null);
    const previousTasks = data.tasks;
    const moving = previousTasks.find(task => task.id === taskId);
    if (!moving) return;
    const fromDate = moving.planned_date ?? null;

    setData(prev => ({ ...prev, tasks: applyPlanningLocally(prev.tasks, taskId, plannedDate, beforeTaskId ?? null) }));
    try {
      const moved = await planTaskInWeek(activeOrg.id, taskId, plannedDate, beforeTaskId ?? null);
      const affected = await fetchTasksForPlannedDates(
        activeOrg.id,
        [fromDate, plannedDate].filter((date): date is string => !!date),
      );
      setData(prev => ({ ...prev, tasks: mergeTaskRows(prev.tasks, [moved, ...affected]) }));
    } catch (e) {
      // Terug naar de stand van vóór het slepen; de planner toont de melding.
      setData(prev => ({ ...prev, tasks: previousTasks }));
      throw e;
    }
  }

  /** Verschuift of herschaalt een weekstrook. Zelfde optimistische route als het
   *  verslepen van een dagkaart. */
  async function updateTaskPeriod(taskId: string, plannedDate: string, plannedEndDate: string | null) {
    if (!ensureCanWrite()) return;
    setError(null);
    const previousTasks = data.tasks;
    const moving = previousTasks.find(task => task.id === taskId);
    if (!moving) return;
    const fromDate = moving.planned_date ?? null;

    setData(prev => ({ ...prev, tasks: applyPeriodLocally(prev.tasks, taskId, plannedDate, plannedEndDate) }));
    try {
      const moved = await setTaskPlanningPeriod(activeOrg.id, taskId, plannedDate, plannedEndDate);
      const affected = await fetchTasksForPlannedDates(
        activeOrg.id,
        [fromDate, plannedDate].filter((date): date is string => !!date),
      );
      setData(prev => ({ ...prev, tasks: mergeTaskRows(prev.tasks, [moved, ...affected]) }));
    } catch (e) {
      setData(prev => ({ ...prev, tasks: previousTasks }));
      throw e;
    }
  }

  /** Neemt blijven liggen werk mee naar één dag. Eén ronde RPC's, daarna één
   *  keer de geraakte dagen teruglezen — niet per taak de hele boel verversen. */
  async function carryOverTasks(taskIds: string[], toDate: string) {
    if (!ensureCanWrite() || taskIds.length === 0) return;
    setError(null);
    const previousTasks = data.tasks;
    const fromDates = previousTasks
      .filter(task => taskIds.includes(task.id))
      .map(task => task.planned_date)
      .filter((date): date is string => !!date);

    setData(prev => {
      let tasks = prev.tasks;
      for (const taskId of taskIds) tasks = applyPlanningLocally(tasks, taskId, toDate, null);
      return { ...prev, tasks };
    });

    try {
      for (const taskId of taskIds) await planTaskInWeek(activeOrg.id, taskId, toDate, null);
      const affected = await fetchTasksForPlannedDates(activeOrg.id, [...fromDates, toDate]);
      setData(prev => ({ ...prev, tasks: mergeTaskRows(prev.tasks, affected) }));
    } catch (e) {
      setData(prev => ({ ...prev, tasks: previousTasks }));
      throw e;
    }
  }

  /** Zet in de teamweergave de toewijzing van een taak op één persoon (of maakt
   *  hem vrij). Slepen naar de rij van een collega doet dit. */
  async function assignTaskToMember(taskId: string, userId: string | null) {
    if (!ensureCanWrite()) return;
    setError(null);
    await setTaskAssignees(activeOrg.id, taskId, userId ? [userId] : []);
    const rows = await selectTaskAssignees(activeOrg.id);
    setData(prev => ({ ...prev, taskAssignees: rows }));
  }

  // ── Actiepunten van de week (persoonlijk, in de database) ────────────────
  async function addPlannerNote(weekStart: string, text: string) {
    if (!ensureCanWrite() || !currentUserId) return;
    setError(null);
    const position = data.plannerNotes.filter(note => note.week_start === weekStart).length;
    const created = await createPlannerNote(activeOrg.id, currentUserId, weekStart, text, position);
    setData(prev => ({ ...prev, plannerNotes: [...prev.plannerNotes, created] }));
  }

  async function togglePlannerNote(id: string, done: boolean) {
    if (!ensureCanWrite()) return;
    setError(null);
    setData(prev => ({ ...prev, plannerNotes: prev.plannerNotes.map(note => note.id === id ? { ...note, done } : note) }));
    const updated = await updatePlannerNote(activeOrg.id, id, { done });
    setData(prev => ({ ...prev, plannerNotes: prev.plannerNotes.map(note => note.id === id ? updated : note) }));
  }

  async function removePlannerNote(id: string) {
    if (!ensureCanWrite()) return;
    setError(null);
    const previous = data.plannerNotes;
    setData(prev => ({ ...prev, plannerNotes: prev.plannerNotes.filter(note => note.id !== id) }));
    try {
      await deletePlannerNote(activeOrg.id, id);
    } catch (e) {
      setData(prev => ({ ...prev, plannerNotes: previous }));
      throw e;
    }
  }

  /** Snel een losse taak op een dag zetten vanuit de weekplanner. Project en klant
   *  koppel je daarna in het taakvenster — die zijn hier bewust nog leeg.
   *  Met een einddatum erbij ontstaat meteen een weekstrook. */
  async function quickAddTask(plannedDate: string, title: string, plannedEndDate?: string | null) {
    if (!ensureCanWrite()) return;
    setError(null);
    const created = await insertRow<Task>('tasks', activeOrg.id, {
      title,
      planned_date: plannedDate,
      planned_end_date: plannedEndDate && plannedEndDate > plannedDate ? plannedEndDate : null,
    });
    setData(prev => ({ ...prev, tasks: mergeTaskRows(prev.tasks, [created]) }));
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

  // UBL-e-factuur (Peppol BIS 3.0): server-side gegenereerd. Blokkerende
  // gebreken (ontbrekende KVK/adres/land) komen als duidelijke NL-fout terug;
  // niet-blokkerende Peppol-waarschuwingen tonen we informatief.
  async function downloadInvoiceUblFile(invoice: Invoice) {
    setLoading(true); setError(null);
    try {
      const { warnings } = await downloadInvoiceUbl(activeOrg.id, invoice.id);
      if (warnings.length > 0) alert(`E-factuur gedownload, met aandachtspunten:\n\n- ${warnings.join('\n- ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'E-factuur (UBL) downloaden mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function downloadCreditNoteUblFile(creditNote: CreditNote) {
    setLoading(true); setError(null);
    try {
      const { warnings } = await downloadCreditNoteUbl(activeOrg.id, creditNote.id);
      if (warnings.length > 0) alert(`E-creditnota gedownload, met aandachtspunten:\n\n- ${warnings.join('\n- ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'E-creditnota (UBL) downloaden mislukt');
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
      // De factuur zelf ging goed de deur uit; alleen niet-blokkerende bijzaken
      // (Mollie-link, e-factuur) verdienen een melding zodat de gebruiker weet
      // wat er wél/niet is meegestuurd en de configuratie kan bijwerken.
      const notes: string[] = [];
      if (includePaymentLink && result.paymentLinkError) {
        notes.push(`de Mollie-betaallink kon niet worden aangemaakt: ${result.paymentLinkError}`);
      }
      if (result.ubl && !result.ubl.attached) {
        notes.push(`de e-factuur (UBL) is niet meegestuurd${result.ubl.reason ? ` — ${result.ubl.reason}` : ''}. Vul de ontbrekende gegevens aan om ook de e-factuur mee te sturen.`);
      } else if (result.ubl?.attached && result.ubl.warnings && result.ubl.warnings.length > 0) {
        notes.push(`e-factuur meegestuurd met aandachtspunten: ${result.ubl.warnings.join('; ')}`);
      }
      if (notes.length > 0) setError(`Factuur is verstuurd, maar ${notes.join(' Daarnaast: ')}`);
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

  async function proposeDunning(invoice: Invoice) {
    if (!ensureCanWrite()) return;
    const client = data.clients.find(item => item.id === invoice.client_id);
    if (!client?.email) { setError('Deze factuur heeft geen klant met e-mailadres; vul dat eerst in bij de klant.'); return; }
    if (!confirm(`Een formele aanmaning voorstellen voor factuur ${invoice.number}? Je bevestigt daarna zelf vóór verzending.`)) return;
    setLoading(true); setError(null);
    try {
      await proposeInvoiceDunningNotice(activeOrg.id, invoice.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aanmaning voorstellen mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function sendDunning(notice: DunningNotice) {
    if (!ensureCanWrite()) return;
    const invoice = data.invoices.find(i => i.id === notice.invoice_id);
    const client = invoice ? data.clients.find(c => c.id === invoice.client_id) : null;
    if (!client?.email) { setError('Deze factuur heeft geen klant met e-mailadres.'); return; }
    if (!confirm(`Aanmaning versturen naar ${client.email} voor factuur ${invoice?.number ?? ''}? De rente wordt op vandaag herberekend en de formele brief (PDF) gaat mee.`)) return;
    setSending('Aanmaning wordt verstuurd via Resend…');
    setLoading(true); setError(null);
    try {
      await sendInvoiceDunningNotice(activeOrg.id, notice.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aanmaning verzenden mislukt');
    } finally {
      setLoading(false); setSending(null);
    }
  }

  async function cancelDunning(notice: DunningNotice) {
    if (!ensureCanWrite()) return;
    if (!confirm('Dit aanmaningsvoorstel annuleren?')) return;
    setLoading(true); setError(null);
    try {
      await cancelInvoiceDunningNotice(activeOrg.id, notice.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aanmaning annuleren mislukt');
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

  async function bookAllUnbookedInvoices() {
    if (!ensureCanWrite()) return;
    setLoading(true); setError(null);
    try {
      const count = await bookAllUnbookedSalesInvoices(activeOrg.id);
      await refresh();
      alert(count > 0
        ? `${count} factuur(en) alsnog naar het grootboek geboekt.`
        : 'Er stonden geen niet-geboekte facturen open.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Facturen naar grootboek boeken mislukt');
    } finally {
      setLoading(false);
    }
  }

  async function postCreditNoteLedger(creditNote: CreditNote) {
    if (!ensureCanWrite()) return;
    if (!confirm(`Creditnota ${creditNote.number} naar het grootboek boeken? Omzet en af te dragen btw worden teruggenomen en de vordering op de klant wordt verlaagd.`)) return;
    setLoading(true); setError(null);
    try {
      await postCreditNoteToLedger(activeOrg.id, creditNote.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Creditnota naar grootboek boeken mislukt');
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

  async function setCalendarEventLink(event: CalendarExternalEvent, clientId: string | null, projectId: string | null, trackTime: boolean = true) {
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
          event_ends_at: event.ends_at,
          event_all_day: event.all_day,
          // Bewaar de titel niet voor privé-agenda-items: de koppeltabel is org-breed leesbaar.
          event_title_snapshot: event.visibility === 'organization' && !event.is_private_masked ? event.title : null,
          client_id: clientId,
          project_id: projectId,
          track_time: trackTime,
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
        // Een losse taak (nog zonder project) hoort thuis in de weekplanner.
        setProjectId(result.item.project_id);
        setPage(result.item.project_id ? 'project' : 'weekplanner');
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

  const title = viewTitle(activeTab, data);

  // Gedeelde uitvoer-handlers voor een door Gerrie voorgesteld actie — hergebruikt door
  // de chat-dock (GerrieChat) én het Commandocentrum, zodat een goedgekeurd voorstel
  // overal identiek wordt uitgevoerd (één bron van waarheid).
  /**
   * Opent een voorstel van Gerrie als vooringevuld formulier — de tweede knop, voor
   * wie eerst wil kijken. Er wordt niets weggeschreven; dat gebeurt pas als je in dat
   * scherm op Opslaan drukt.
   */
  function openProposalForm(proposal: GerrieProposal) {
    if (!ensureCanWrite()) return;
    const target = editModeForProposal(proposal, data);
    if (!target) return;
    if ('error' in target) { setError(target.error); return; }
    setPage(target.page); setProjectId(target.projectId ?? null); setClientId(null);
    setEdit(target.edit);
  }

  /**
   * Voert een concept-voorstel ECHT uit en geeft terug wat er gebeurd is.
   *
   * Alles wat een bewerkformulier kent, loopt via `persistEdit` — precies dezelfde weg
   * als de knop Opslaan, inclusief de nummering, de opschoning van de velden en de
   * validatie. De vier voorstellen zonder bewerkformulier (leverancier, inkoopfactuur,
   * contract, rapportage) schrijven hier hun eigen rij weg, maar houden zich aan wat
   * hun scherm ook zou doen: een CONCEPT, niets geboekt en niets verstuurd.
   */
  async function applyProposal(proposal: GerrieProposal): Promise<string> {
    switch (proposal.type) {
      case 'supplier': {
        const created = await insertRow<Supplier>('suppliers', activeOrg.id, {
          name: proposal.name, contact_name: proposal.contact_name, email: proposal.email,
          phone: proposal.phone, iban: proposal.iban, vat_number: proposal.vat_number,
          kvk_number: proposal.kvk_number, city: proposal.city, status: 'active',
        });
        return `Leverancier "${created.name}" aangemaakt`;
      }
      case 'purchase_invoice': {
        if (!proposal.supplier_id) throw new Error('Deze inkoopfactuur heeft geen leverancier; open hem in het formulier en kies er een.');
        const seed = purchaseInvoiceSeedFrom({
          supplierId: proposal.supplier_id,
          supplier_invoice_number: proposal.supplier_invoice_number,
          date: proposal.date, due_date: proposal.due_date ?? '', notes: proposal.notes ?? '',
          lines: proposal.lines.map((l) => ({ description: l.description, amount_eur: l.amount_eur, vat_rate: l.vat_rate })),
        });
        const lines = seed.lines.filter((l) => String(l.description || '').trim() || Number(l.amount_cents));
        if (lines.length === 0) throw new Error('Deze inkoopfactuur heeft geen regels.');
        // Een lege kostenrekening valt server-side terug op de vangnetrekening 4500;
        // de btw-som moet daar hier al van uitgaan, anders sluit het totaal niet aan.
        const fallbackAccountId = data.ledgerAccounts.find((a) => a.code === '4500')?.id ?? null;
        const totals = purchaseTotals(lines, fallbackAccountId);
        const internalNumber = nextPurchaseNumber(data);
        await insertRow<PurchaseInvoice>('purchase_invoices', activeOrg.id, {
          supplier_id: proposal.supplier_id,
          supplier_invoice_number: proposal.supplier_invoice_number || null,
          internal_number: internalNumber,
          date: seed.form.date || new Date().toISOString().slice(0, 10),
          due_date: seed.form.due_date || null,
          project_id: null, notes: seed.form.notes || null, lines,
          subtotal_cents: totals.subtotal_cents, vat_cents: totals.vat_cents, total_cents: totals.total_cents,
          status: 'draft', payment_status: 'unpaid',
          source: seed.source, extraction_meta: seed.extractionMeta,
        });
        return `Inkoopfactuur ${internalNumber} aangemaakt als concept — kies zelf de grootboekrekeningen voordat je hem boekt`;
      }
      case 'contract': {
        const title = proposal.title.trim();
        if (!title) throw new Error('Geef het contract een titel.');
        const { data: row, error } = await supabase.from('contracts').insert({
          organization_id: activeOrg.id,
          client_id: proposal.client_id ?? null,
          title,
          body: proposal.body,
          date: new Date().toISOString().slice(0, 10),
          valid_until: proposal.valid_until ?? null,
          amount_cents: proposal.amount_eur != null ? Math.round(proposal.amount_eur * 100) : null,
          currency: 'EUR',
        }).select('*').single();
        if (error) throw error;
        return `Contract "${(row as Contract).title}" aangemaakt als concept — versturen ter ondertekening doe je zelf`;
      }
      case 'report': {
        const saved = await createSavedReport(activeOrg.id, { name: proposal.name, definition: proposal.definition });
        return `Rapportage "${saved.name}" opgeslagen bij Statistieken`;
      }
      default:
        break;
    }

    const target = editModeForProposal(proposal, data);
    if (!target) throw new Error('Dit voorstel kan hier niet uitgevoerd worden.');
    if ('error' in target) throw new Error(target.error);
    const values = cleanForm(target.edit.kind, initialForm(target.edit, data), data.clientFieldDefinitions);
    // Het formulier vinkt "welkomstmail sturen" standaard aan bij een nieuwe klant.
    // Dat is daar zichtbaar; hier niet. Post naar een klant hoort niet mee te liften
    // op een kaart die alleen "Klant aanmaken" belooft.
    if (target.edit.kind === 'client') values._sendWelcomeEmail = false;
    const invalid = validateEditValues(target.edit.kind, values);
    if (invalid) throw new Error(invalid);
    const { label, warning } = await persistEdit(target.edit, values);
    if (warning) setError(warning);
    return label;
  }

  const gerrieActions: GerrieActionHandlers = {
    // Akkoord op een concept-voorstel schrijft het ECHT weg, langs dezelfde weg als
    // het formulier. Het formulier blijft ernaast bestaan (onCreate*Draft hieronder)
    // voor wie eerst wil kijken; die knop staat op elke kaart.
    onApplyProposal: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      let label: string;
      try { label = await applyProposal(p); }
      catch (e) { throw new Error(saveErrorMessage(e)); }
      await refresh();
      return label;
    },
    // De handelingenregistry: alles wat de app kan maar geen eigen kaart heeft —
    // van een galerij publiceren tot een banktransactie afletteren. De server heeft
    // het voorstel al opgebouwd en gecontroleerd; hier gaat het langs dezelfde
    // repository-functie als de knop in het scherm zelf.
    onRunRegistryAction: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      let label: string;
      try { label = await runRegistryAction(p.action_id, p.payload, { organizationId: activeOrg.id, data }); }
      catch (e) { throw new Error(saveErrorMessage(e)); }
      await refresh();
      return label;
    },
    onCreateInvoiceDraft: openProposalForm,
    onCreateQuoteDraft: openProposalForm,
    onCreateClientDraft: openProposalForm,
    onSendInvoice: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      const invoice = data.invoices.find((i) => i.id === p.id);
      let includePaymentLink = false;
      if (invoice && !['paid', 'cancelled', 'void', 'written_off'].includes(invoice.status)) {
        // Kort gecachet: bij een afvinklijst van twintig facturen is de
        // Mollie-koppeling niet twintig keer opnieuw op te halen.
        try { includePaymentLink = await mollieConnected(activeOrg.id); } catch { /* PDF-only als de status niet op te halen is */ }
      }
      await sendInvoiceEmailViaResend(activeOrg.id, p.id, { recipientEmail: p.recipient_email, recipientName: p.recipient_name ?? undefined, includePaymentLink });
      scheduleRefresh();
    },
    onSendQuote: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await sendQuoteEmailViaResend(activeOrg.id, p.id, { recipientEmail: p.recipient_email, recipientName: p.recipient_name ?? undefined });
      scheduleRefresh();
    },
    onConvertQuote: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      const invoice = await convertAcceptedQuoteToInvoice(activeOrg.id, p.id);
      await refresh();
      setPage('invoices'); setProjectId(null); setClientId(null);
      setEdit({ kind: 'invoice', item: invoice });
    },
    onEditInvoice: openProposalForm,
    onEditQuote: openProposalForm,
    onEditClient: openProposalForm,
    onSendReminders: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      let sent = 0;
      const failed: string[] = [];
      for (const inv of p.invoices) {
        try { await sendInvoiceReminderEmail(activeOrg.id, inv.id); sent += 1; }
        catch { failed.push(inv.number); }
      }
      scheduleRefresh();
      if (failed.length) throw new Error(`${sent} verstuurd, ${failed.length} mislukt (${failed.join(', ')}).`);
    },
    // Eén klantmail, langs precies dezelfde weg als de knop op de klantenkaart:
    // eigen verzenddomein, thread + logging. De wachtrij roept dit per aangevinkte
    // mail aan, zodat een mislukte mail de rest niet meesleept.
    onSendClientEmail: async (item) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await sendClientEmail(activeOrg.id, {
        clientId: item.client_id,
        subject: item.subject,
        bodyHtml: plainTextToEmailHtml(item.body),
        bodyText: item.body,
      });
      await refreshClientEmailUnread();
    },
    // Een door Gerrie bedachte agent gaat na jouw akkoord METEEN aan de slag.
    // De kaart in de chat liet al zien wat hij mag en wanneer hij draait, dus een
    // tweede ronde langs het formulier zou alleen maar vertraging zijn. De grens
    // blijft waar hij hoort: alles wat deze agent daarna wil versturen komt als
    // afvinklijst bij je terug.
    //
    // De eerste run starten we bewust ZONDER erop te wachten — die duurt tientallen
    // seconden en het resultaat hoort thuis in de run-historie, niet in een
    // spinnende chatkaart. Mislukt hij, dan staat dat daar met reden en logboek.
    onCreateAgent: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      const saved = await saveRoutine(activeOrg.id, {
        name: p.name, instruction: p.instruction, icon: p.icon, hue: null,
        email_mode: p.email_mode, email_subject: p.email_subject, email_body: p.email_body,
        max_emails_per_run: p.max_emails_per_run,
        model_kind: 'cheap', mode: p.mode, enabled_tools: p.enabled_tools,
        schedule_kind: p.schedule_kind, hour: p.hour,
        day_of_week: p.day_of_week, day_of_month: p.day_of_month,
        timezone: 'Europe/Amsterdam', delivery: { channels: ['inapp'] },
      }, undefined, true);
      if (!saved.id) throw new Error('De agent is niet aangemaakt.');
      const agentId = saved.id;
      // Activeren zat al in het aanmaken; loopt dat toch mis, dan is een gepauzeerde
      // agent een eerlijker uitkomst dan doen alsof hij draait.
      if (saved.status !== 'active') await setRoutineStatus(activeOrg.id, agentId, 'active');
      void runRoutineNow(activeOrg.id, agentId).catch(() => { /* staat in de run-historie */ });
      setPage('gerrie'); setProjectId(null); setClientId(null);
      setOpenAgentId(agentId);
    },
    onCreateProject: openProposalForm,
    onEditProject: openProposalForm,
    onCreateTask: openProposalForm,
    onEditTask: openProposalForm,
    onCreateCalendarEvent: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      // Lokale tijd (browser = Europe/Amsterdam) -> UTC ISO voor de agenda-API.
      const startsAt = new Date(`${p.date}T${p.start_time}:00`).toISOString();
      const endsAt = new Date(`${p.date}T${p.end_time}:00`).toISOString();
      await createExternalCalendarEvent(activeOrg.id, { sourceId: p.source_id, title: p.title, startsAt, endsAt, description: p.description ?? undefined, location: p.location ?? undefined });
    },
    onCreateWeekAction: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      // Actiepunten op de lijst "Actiepunten deze week" van de juiste week. Die
      // staat sinds migratie 20260811000000 in de database, per persoon.
      for (const item of p.items) {
        await addPlannerNote(formatISODate(startOfWeek(parseISODate(item.planned_date))), item.title);
      }
    },
    onLogTimeEntry: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await createTimeEntry(activeOrg.id, {
        project_id: p.project_id, client_id: p.client_id, source: 'manual',
        description: p.description, entry_date: p.date, minutes: p.minutes,
        billable: p.billable, hourly_rate_cents: p.hourly_rate_cents,
      });
      await refresh();
    },
    // De agenda is multi-provider: native items hebben een eigen id, Google/Microsoft
    // alleen een provider-id binnen hun bron. De `ref` draagt beide mee en de
    // agenda-functie kiest — precies zoals slepen/herschalen in de agenda zelf werkt.
    onEditCalendarEvent: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      const date = p.changes.date ?? p.current.date;
      const startTime = p.changes.start_time ?? p.current.start_time;
      const endTime = p.changes.end_time ?? p.current.end_time;
      await updateCalendarEvent(
        activeOrg.id,
        { eventId: p.ref.event_id ?? undefined, sourceId: p.ref.source_id, providerEventId: p.ref.provider_event_id ?? undefined },
        {
          sourceId: p.ref.source_id,
          title: p.changes.title ?? p.title,
          startsAt: new Date(`${date}T${startTime}:00`).toISOString(),
          endsAt: new Date(`${date}T${endTime}:00`).toISOString(),
          description: p.changes.description ?? undefined,
          location: p.changes.location ?? undefined,
        },
      );
      scheduleRefresh();
    },
    onCancelCalendarEvent: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await deleteCalendarEvent(activeOrg.id, {
        eventId: p.ref.event_id ?? undefined, sourceId: p.ref.source_id, providerEventId: p.ref.provider_event_id ?? undefined,
      });
      scheduleRefresh();
    },
    onCreateClientContact: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await createClientContact(activeOrg.id, {
        client_id: p.client_id, name: p.name, email: p.email, phone: p.phone,
        role: p.role, gives_portal_access: p.gives_portal_access,
      });
      scheduleRefresh();
    },
    onEditClientContact: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await updateClientContact(p.id, p.changes, activeOrg.id);
      scheduleRefresh();
    },
    // Toevoegen en verwijderen apart: `project_members` heeft een eigen rij-id, dus
    // eraf halen vraagt om die rij, niet om de user_id.
    onSetProjectTeam: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      for (const m of p.add) {
        if (data.projectMembers.some((row) => row.project_id === p.project_id && row.user_id === m.user_id)) continue;
        await addProjectMember(activeOrg.id, p.project_id, m.user_id);
      }
      for (const m of p.remove) {
        const row = data.projectMembers.find((x) => x.project_id === p.project_id && x.user_id === m.user_id);
        if (row) await removeProjectMember(activeOrg.id, row.id);
      }
      scheduleRefresh();
    },
    onAssignTask: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await setTaskAssignees(activeOrg.id, p.task_id, p.assignees.map((a) => a.user_id));
      scheduleRefresh();
    },
    // Een correctie op geboekte uren voert direct uit: er is geen los urenformulier
    // om te openen, en de wijziging is één regel die je in de kaart al hebt gelezen.
    onEditTimeEntry: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await updateTimeEntry(activeOrg.id, p.id, p.changes);
      scheduleRefresh();
    },
    // Notities en documenten hebben allebei al een formulier dat `defaults` aanneemt,
    // dus dit is dezelfde weg als "Nieuwe notitie" op de klantenkaart.
    // De vier concepten gaan langs dezelfde weg: navigeren naar de pagina en het
    // concept meegeven, waarna dat scherm zijn eigen formulier vooringevuld opent.
    // Er wordt niets geboekt of verstuurd; de mens drukt op opslaan.
    onCreateSupplier: (p) => {
      if (!ensureCanWrite()) return;
      setPage('suppliers'); setProjectId(null); setClientId(null);
      setPendingDraft({ key: uid(), kind: 'supplier', payload: {
        name: p.name, contact_name: p.contact_name, email: p.email, phone: p.phone,
        iban: p.iban, vat_number: p.vat_number, kvk_number: p.kvk_number, city: p.city,
      } });
    },
    onCreatePurchaseInvoice: (p) => {
      if (!ensureCanWrite()) return;
      setPage('purchase-invoices'); setProjectId(null); setClientId(null);
      setPendingDraft({ key: uid(), kind: 'purchase_invoice', payload: {
        supplierId: p.supplier_id,
        supplier_invoice_number: p.supplier_invoice_number,
        date: p.date, due_date: p.due_date ?? '', notes: p.notes ?? '',
        lines: p.lines.map((l) => ({ description: l.description, amount_eur: l.amount_eur, vat_rate: l.vat_rate })),
      } });
    },
    onCreateContract: (p) => {
      if (!ensureCanWrite()) return;
      setPage('contracts'); setProjectId(null); setClientId(null);
      setPendingDraft({ key: uid(), kind: 'contract', payload: {
        client_id: p.client_id, title: p.title, body: p.body,
        valid_until: p.valid_until, amount_eur: p.amount_eur,
      } });
    },
    // Een campagne moet als échte (concept)rij bestaan voordat de editor hem kan
    // openen. Aanmaken met status 'draft' verstuurt niets: een concept is inert tot
    // iemand op verzenden drukt, en de doelgroep is bewust leeg gelaten.
    onCreateCampaign: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      const created = await createCampaign(activeOrg.id, {
        name: p.name, subject: p.subject, preheader: p.preheader ?? undefined,
        body_html: plainTextToEmailHtml(p.body_text), body_text: p.body_text,
        audience: { mode: 'filter', statuses: [], tags: [], includeContacts: false, manualClientIds: [], customFilters: [] },
      });
      setPage('marketing'); setProjectId(null); setClientId(null);
      setPendingDraft({ key: uid(), kind: 'campaign', payload: { id: created.id } });
    },
    onCreateContent: openProposalForm,
    onCreateTicket: openProposalForm,
    onEditTicket: openProposalForm,
    // Een reactie op een ticket gaat direct de tijdlijn in — langs dezelfde weg als
    // de knop op het ticket zelf, dus met jouw naam eronder. Staat `is_internal` op
    // false, dan leest de klant hem in het portaal; dat staat op de kaart die je
    // goedkeurt.
    onAddTicketNote: async (p) => {
      if (!ensureCanWrite()) throw new Error('Je hebt geen schrijfrechten.');
      await createTicketNote(activeOrg.id, { ticketId: p.ticket_id, body: p.body, isInternal: p.is_internal });
      scheduleRefresh();
    },
    onCreateReport: (p) => {
      if (!ensureCanWrite()) return;
      // Open de rapportbouwer vooringevuld (nog niet opgeslagen); de gebruiker
      // controleert de live grafiek en slaat zelf op via "Rapport opslaan".
      setProjectId(null); setClientId(null); setStatsReportId(null);
      setPendingReport({ key: uid(), name: p.name, definition: p.definition });
      setPage('stats');
    },
  };

  return <div className={`app${sidebarPinned ? ' sidebar-pinned' : ''}`}>
    <button
      type="button"
      className="mobile-nav-toggle"
      aria-label={mobileNavOpen ? 'Menu sluiten' : 'Menu openen'}
      aria-expanded={mobileNavOpen}
      onClick={() => setMobileNavOpen(open => !open)}
    >{mobileNavOpen ? <X size={22}/> : <Menu size={22}/>}</button>
    <div className={`sidebar-backdrop${mobileNavOpen ? ' is-open' : ''}`} onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
    <Sidebar page={page} data={data} organizations={organizationContext.organizations} activeOrganizationId={activeOrg.id} activeRole={activeMembership?.role ?? null} onOrganization={switchOrganization} onNewOrganization={createNewOrganization} onNewEntity={(organizationContext.businessStatus?.active && activeMembership?.role === 'owner') ? createNewEntity : null} onPage={(p) => { setPage(p); setProjectId(null); setClientId(null); setStatsReportId(null); setMobileNavOpen(false); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }} onSearchNavigate={handleSearchNavigate} userEmail={currentUserEmail ?? activeMembership?.email ?? null} onOpenSettings={openSettings} onSignOut={() => supabaseAuth.signOut()} clientEmailUnread={clientEmailUnread.total} ticketUnread={ticketUnreadIds.size} chatUnread={teamChat.unreadTotal} mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} pinned={sidebarPinned} onTogglePin={() => setSidebarPinned(pinned => { const next = !pinned; localStorage.setItem('brandcore.sidebarPinned', next ? '1' : '0'); return next; })} permissions={permissions}/>
    <main className="main">
      <TabBar tabs={tabs} activeTabId={activeTab.id} data={data} onSelect={switchTab} onClose={closeTab} onNew={openTab} />
      {page !== 'calendar' && page !== 'gerrie' && <header className="topbar"><div><div className="topbar-eyebrow">ResoFly workspace</div><div className="topbar-title">{title}</div></div><div className="topbar-actions">{!(orgCanWrite && permissions.canWritePage(page)) && <span className="status-pill readonly">Alleen lezen</span>}<Button onClick={refresh}>{loading ? 'Laden…' : 'Ververs'}</Button></div></header>}
      {/* Alle open tabbladen blijven gemount (keep-alive); alleen het actieve is
          zichtbaar. Elk pane is z'n eigen scrollcontainer én bevat z'n eigen
          EditModal, zodat een openstaande bewerking bij het wisselen bewaard blijft. */}
      {tabs.map(tab => (
        <section key={tab.id} className="content" hidden={tab.id !== activeTab.id}>
          {tab.id === activeTab.id && error && <div className="error">{error}</div>}
          {renderPage(tab)}
          {tab.edit && <EditModal edit={tab.edit} data={data} organizationId={activeOrg.id} currentUserId={currentUserId} teamMembers={organizationContext.teamMembers} canWrite={canEditKind(tab.edit.kind)} readOnly={!canEditKind(tab.edit.kind)} onClose={() => setEdit(null)} onSave={saveEdit} onDelete={removeCurrent} onAttachmentsChanged={refresh} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewClientNote={(client) => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { client_id: client.id }})} onConvertToWord={convertDocumentToWord} onCreateFromOfficeFile={createDocumentFromOfficeFile} onCreateBlankOffice={createDocumentFromBlankOffice} />}
        </section>
      ))}
    </main>
    <GerrieChat organizationId={activeOrg.id} {...gerrieActions} />
    {officeSession && <OfficeEditor session={officeSession} onClose={() => { setOfficeSession(null); setOfficeDoc(null); refresh(); }} onDownload={officeDoc ? downloadOfficeDoc : undefined} />}
    {officeOpening && !officeSession && <div style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 2100, background: 'var(--panel-strong)', border: '1px solid var(--border2)', borderRadius: 10, padding: '8px 14px', fontWeight: 600 }}>Editor openen…</div>}
    {/* Zwevend teamchat-paneel — overal beschikbaar, behalve op de volledige chatpagina. */}
    <TeamChatDock api={teamChat} hidden={page === 'chat'} />
    {/* Mobiele duim-onderbalk (alleen ≤760px, zie globals.css). Navigeert het
        actieve tabblad naar een kerndestinatie; sluit onderweg het uitschuifmenu. */}
    <BottomNav page={page} permissions={permissions} onNavigate={(p) => { setPage(p); setProjectId(null); setClientId(null); setStatsReportId(null); setMobileNavOpen(false); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }} />
    {sending && <div className="send-overlay" role="status" aria-live="polite">
      <div className="send-overlay-card">
        <span className="send-spinner" aria-hidden="true" />
        <span>{sending}</span>
        <small>Sluit dit venster niet — dit kan enkele seconden duren.</small>
      </div>
    </div>}
    <div className="toast-region">
      <ClientEmailToasts
        toasts={clientEmailToasts}
        onOpen={(clientId) => { setClientId(clientId); setProjectId(null); setPage('client'); }}
        onDismiss={dismissClientEmailToast}
      />
      <TicketToasts
        toasts={ticketToasts}
        onOpen={(ticketId) => { const t = data.tickets.find(x => x.id === ticketId); if (t) { setEdit({ kind: 'ticket', item: t }); markTicketRead(t.id).then(refreshTicketUnread).catch(() => {}); } }}
        onDismiss={dismissTicketToast}
      />
    </div>
  </div>;

  // Rendert de inhoud van één tabblad. Leest de view-state uit `view` (het eigen
  // tabblad), zodat elk gemount pane z'n eigen pagina/project/klant toont. De
  // handlers (setEdit/setPage/…) muteren het actieve tabblad — alleen het zichtbare
  // pane is interactief, dus dat klopt.
  function renderPage(view: WorkspaceTab) {
    const page = view.page;
    const project = data.projects.find(p => p.id === view.projectId) ?? null;
    const client = data.clients.find(c => c.id === view.clientId) ?? null;
    const statsReportId = view.statsReportId;
    const settingsNav = view.settingsNav;
    const pendingReport = view.pendingReport;

    // Staat deze module dicht voor dit teamlid, dan tonen we hier niets — ook
    // niet via een onthouden tabblad of een gedeelde link. De database geeft
    // sowieso geen rijen terug; dit voorkomt een verwarrende lege pagina.
    if (!permissions.canOpenPage(page)) {
      const moduleKey = PAGE_MODULE[page];
      return <div className="empty">
        <div className="e-big">Geen toegang tot {moduleKey ? MODULE_LABELS[moduleKey] : 'deze module'}</div>
        <p>Een owner of admin van deze organisatie heeft deze module voor jou dichtgezet. Vraag hen om toegang als je die nodig hebt voor je werk.</p>
        <Button onClick={() => { setPage(firstAllowedPage(permissions) as Page); setProjectId(null); setClientId(null); setStatsReportId(null); }}>Naar een pagina die wél open is</Button>
      </div>;
    }

    // Binnen een open module bepaalt het niveau (lezen/volledig) of de
    // wijzig-knoppen in de pagina actief zijn. Schaduwt bewust de organisatie-
    // brede canWrite hierboven, zodat elke pagina automatisch het juiste niveau
    // meekrijgt zonder dat elke prop apart aangepast hoeft te worden.
    const canWrite = orgCanWrite && permissions.canWritePage(page);
    // Contracten horen bij de financiële module, ook als je ze vanaf een project
    // bekijkt. De projectpagina leunt dus niet op canWrite hierboven (dat is
    // 'projects'), maar op het niveau van 'finance'.
    const canReadContracts = permissions.canRead('finance');
    const canWriteContracts = orgCanWrite && permissions.canWrite('finance');
    if (page === 'dashboard') return <Dashboard data={data} organizationContext={organizationContext} organizationId={activeOrg.id} currentUserId={currentUserId} canWriteTasks={orgCanWrite && permissions.canWrite('projects')} permissions={permissions} gerrieActions={gerrieActions} canWriteGerrie={orgCanWrite && permissions.canWrite('gerrie')} openProject={(id) => { setProjectId(id); setPage('project'); }} openSettings={() => openSettings('organisatie')} openPage={(p) => { setPage(p); setProjectId(null); setClientId(null); setStatsReportId(null); }} openReport={(id) => { setStatsReportId(id); setProjectId(null); setClientId(null); setPage('stats'); }} openTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onSetTaskStatus={setTaskStatus} />;
    if (page === 'project' && project) return <ProjectPage data={data} project={project} organizationId={activeOrg.id} teamMembers={organizationContext.teamMembers} currentUserId={currentUserId} onChanged={refresh} canWrite={canWrite} canAdmin={canAdmin} canReadContracts={canReadContracts} canWriteContracts={canWriteContracts} creativeActive={organizationContext.creativeStatus?.active ?? true} creativeGraceUntil={organizationContext.creativeStatus?.grace_until ?? null} onOpenGalleryTab={(gid) => openGalleryTab(gid, project.id)} onNewTask={() => ensureCanWrite() && setEdit({kind:'task', projectId: project.id})} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: project.id})} onEditProject={() => setEdit({kind:'project', item: project})} onNewQuote={() => ensureCanWrite() && setEdit({kind:'quote', defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditQuote={(quote) => setEdit({kind:'quote', item: quote})} onNewInvoice={() => ensureCanWrite() && setEdit({kind:'invoice', defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditInvoice={(invoice) => setEdit({kind:'invoice', item: invoice})} onSubmitQuoteApproval={submitQuoteApproval} onApproveQuote={approveQuote} onRejectQuote={rejectQuote} onSendQuote={sendQuote} onConvertQuoteToInvoice={convertQuoteToInvoice} onDownloadQuotePdf={downloadQuotePdf} onNewNote={() => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewDocument={() => ensureCanWrite() && setEdit({kind:'document', item: undefined, defaults: { project_id: project.id, client_id: project.client_id ?? '' }})} onEditDocument={openDocument} setTaskStatus={setTaskStatus}/>;
    if (page === 'gallery') {
      // Het project leiden we uit de galerij zelf af: dat blijft kloppen ook als
      // de projectverwijzing van het tabblad ooit achterloopt.
      const gallery = data.galleries.find(g => g.id === view.galleryId) ?? null;
      const galleryProject = gallery ? data.projects.find(p => p.id === gallery.project_id) ?? null : null;
      if (!gallery || !galleryProject) {
        return <div className="empty">
          <div className="e-big">Deze galerij bestaat niet meer</div>
          <div>Sluit dit tabblad, of open een andere galerij vanuit het project.</div>
        </div>;
      }
      return <GalleryTab
        data={data}
        project={galleryProject}
        organizationId={activeOrg.id}
        canWrite={canWrite && (organizationContext.creativeStatus?.active ?? true)}
        onChanged={refresh}
        initialGalleryId={gallery.id}
      />;
    }
    if (page === 'projects') return <ProjectsListPage data={data} canWrite={canWrite} onNewProject={() => ensureCanWrite() && setEdit({kind:'project'})} onOpenProject={(item) => { setProjectId(item.id); setClientId(null); setPage('project'); }} onEditProject={(item) => setEdit({kind:'project', item})}/>;
    if (page === 'project-planning') return <ProjectsPlanningPage data={data} onOpenProject={(item) => { setProjectId(item.id); setClientId(null); setPage('project'); }} />;
    if (page === 'client' && client) return <ClientDetailPage data={data} client={client} canWrite={canWrite} organizationId={activeOrg.id} onChanged={refresh} onBack={() => { setClientId(null); setPage('clients'); }} onEditClient={() => setEdit({kind:'client', item: client})} onNewQuote={() => ensureCanWrite() && setEdit({kind:'quote', defaults: { client_id: client.id }})} onEditQuote={(item)=>setEdit({kind:'quote', item})} onNewInvoice={() => ensureCanWrite() && setEdit({kind:'invoice', defaults: { client_id: client.id }})} onEditInvoice={(item)=>setEdit({kind:'invoice', item})} onOpenProject={(project) => { setProjectId(project.id); setClientId(null); setPage('project'); }} onNewNote={(folderId) => ensureCanWrite() && setEdit({kind:'note', item: undefined, defaults: { client_id: client.id, folder_id: folderId ?? null }})} onEditNote={(note) => setEdit({kind:'note', item: note})} onNewDocument={(folderId) => ensureCanWrite() && setEdit({kind:'document', item: undefined, defaults: { client_id: client.id, folder_id: folderId ?? null }})} onEditDocument={openDocument} unreadCount={clientEmailUnread.byClient[client.id] ?? 0} onUnreadChanged={refreshClientEmailUnread}/>;
    if (page === 'clients') return <Clients data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh} onNew={() => ensureCanWrite() && setEdit({kind:'client'})} onOpen={(item)=>{ setClientId(item.id); setProjectId(null); setPage('client'); }} unreadByClient={clientEmailUnread.byClient}/>;
    if (page === 'tickets') return <Tickets data={data} onNew={() => ensureCanWrite() && setEdit({kind:'ticket'})} onEdit={(item)=>{ setEdit({kind:'ticket', item}); markTicketRead(item.id).then(refreshTicketUnread).catch(()=>{}); }} onConvert={convert} unreadTicketIds={ticketUnreadIds}/>;
    if (page === 'chat') return <TeamChatPage api={teamChat} />;
    if (page === 'gerrie') return <GerrieCommandCenter organizationId={activeOrg.id} canWrite={canWrite} openAgentId={view.openAgentId} onOpenAgentConsumed={() => setOpenAgentId(null)} {...gerrieActions} />;
    if (page === 'marketing') return <Marketing data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}
      openCampaignId={view.pendingDraft?.kind === 'campaign' ? String(view.pendingDraft.payload.id ?? '') : null} onCampaignOpened={() => setPendingDraft(null)}/>;
    if (page === 'content' || page === 'notes' || page === 'documents') return <ContentLibrary key={page} data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh} initialView={page === 'notes' ? 'notes' : page === 'documents' ? 'documents' : 'all'} onNewNote={(t) => ensureCanWrite() && setEdit({kind:'note', defaults: { client_id: t?.client_id ?? null, project_id: t?.project_id ?? null, folder_id: t?.folder_id ?? null }})} onEditNote={(item)=>setEdit({kind:'note', item})} onNewDocument={(t) => ensureCanWrite() && setEdit({kind:'document', defaults: { client_id: t?.client_id ?? null, project_id: t?.project_id ?? null, folder_id: t?.folder_id ?? null }})} onNewOfficeDocument={(docType, title, t) => { if (!ensureCanWrite()) return; void createDocumentFromBlankOffice(docType, { title, client_id: t?.client_id ?? null, project_id: t?.project_id ?? null, folder_id: t?.folder_id ?? null }); }} onEditDocument={openDocument}/>;
    if (page === 'quotes') return <Quotes data={data} canWrite={canWrite} canAdmin={canAdmin} onNew={() => ensureCanWrite() && setEdit({kind:'quote'})} onEdit={(item)=>setEdit({kind:'quote', item})} onSubmitApproval={submitQuoteApproval} onApprove={approveQuote} onReject={rejectQuote} onSend={sendQuote} onConvertToInvoice={convertQuoteToInvoice} onDownloadPdf={downloadQuotePdf}/>;
    if (page === 'contracts') return <Contracts data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}
      draft={view.pendingDraft?.kind === 'contract' ? contractDraftFrom(view.pendingDraft.payload) : null} onDraftConsumed={() => setPendingDraft(null)}/>;
    if (page === 'invoices') return <Invoices data={data} canWrite={canWrite} canAdmin={canAdmin} onNew={() => ensureCanWrite() && setEdit({kind:'invoice'})} onEdit={(item)=>setEdit({kind:'invoice', item})} onSend={sendInvoice} onSendReminder={sendInvoiceReminder} onToggleRemindersPaused={toggleInvoiceRemindersPaused} onDownloadPdf={downloadInvoicePdf} onDownloadUbl={downloadInvoiceUblFile} onRefund={refundInvoice} onDownloadCreditNote={downloadCreditNote} onDownloadCreditNoteUbl={downloadCreditNoteUblFile} onEmailCreditNote={emailCreditNote} onPostCreditNote={postCreditNoteLedger} onPostToLedger={postInvoiceToLedger} onBookAllUnbooked={bookAllUnbookedInvoices} onProposeDunning={proposeDunning} onSendDunning={sendDunning} onCancelDunning={cancelDunning}/>;
    if (page === 'suppliers') return <SuppliersPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}
      draft={view.pendingDraft?.kind === 'supplier' ? (view.pendingDraft.payload as Partial<Supplier>) : null} onDraftConsumed={() => setPendingDraft(null)}/>;
    if (page === 'purchase-invoices') return <PurchaseInvoicesPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}
      draft={view.pendingDraft?.kind === 'purchase_invoice' ? purchaseInvoiceSeedFrom(view.pendingDraft.payload) : null} onDraftConsumed={() => setPendingDraft(null)}/>;
    if (page === 'ledger') return <LedgerPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'bank') return <BankPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'assets') return <AssetsPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'pnl') return <ProfitLossPage data={data} organizationId={activeOrg.id} onChanged={refresh}/>;
    if (page === 'vat-returns') return <VatReturnsPage data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh}/>;
    if (page === 'dga') return <DgaPage data={data} organizationId={activeOrg.id} canWrite={canWrite} canAdmin={canAdmin} businessActive={organizationContext.businessStatus?.active ?? false} onChanged={refresh}/>;
    if (page === 'corporate-tax') return <CorporateTaxPage data={data} organizationId={activeOrg.id} canWrite={canWrite} canAdmin={canAdmin} businessActive={organizationContext.businessStatus?.active ?? false} onChanged={refresh}/>;
    if (page === 'shareholders') return <ShareholdersPage data={data} organizationId={activeOrg.id} canWrite={canWrite} canAdmin={canAdmin} businessActive={organizationContext.businessStatus?.active ?? false} onChanged={refresh}/>;
    if (page === 'fiscal-years') return <FiscalYearsPage data={data} organizationId={activeOrg.id} canWrite={canWrite} canAdmin={canAdmin} businessActive={organizationContext.businessStatus?.active ?? false} onChanged={refresh}/>;
    if (page === 'annual-accounts') return <AnnualAccountsPage data={data} organizationId={activeOrg.id} canWrite={canWrite} canAdmin={canAdmin} businessActive={organizationContext.businessStatus?.active ?? false} onChanged={refresh}/>;
    if (page === 'weekplanner') return <WeekPlanner data={data} organizationId={activeOrg.id} canWrite={canWrite} teamMembers={organizationContext.teamMembers} currentUserId={currentUserId} onPlanTask={updateTaskPlanning} onSetTaskPeriod={updateTaskPeriod} onQuickAddTask={quickAddTask} onCarryOver={carryOverTasks} onAssignTask={assignTaskToMember} onAddNote={addPlannerNote} onToggleNote={togglePlannerNote} onRemoveNote={removePlannerNote} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})}/>;
    if (page === 'calendar') return <CalendarPage mode="agenda" organizationId={activeOrg.id} currentUserId={currentUserId} data={data} canWrite={canWrite} onChanged={refresh} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onNewNoteForEvent={openNoteForCalendarEvent} onNewDocumentForEvent={openDocumentForCalendarEvent} onSetEventLink={setCalendarEventLink} onEditNote={(note) => setEdit({kind:'note', item: note})} onLinkExistingNoteToEvent={linkExistingNoteToCalendarEvent} onUnlinkNoteFromEvent={unlinkNoteFromCalendarEvent}/>;
    if (page === 'meeting-booking') return <MeetingBookingManager organizationId={activeOrg.id} currentUserId={currentUserId ?? ''} data={data} canWrite={canWrite}/>;
    if (page === 'time') return <TimeTracking data={data} organizationId={activeOrg.id} currentUserId={currentUserId} teamMembers={organizationContext.teamMembers} canWrite={canWrite} canAdmin={canAdmin} onChanged={refresh}/>;
    if (page === 'stats') return <Statistics data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh} openReportId={statsReportId} pendingReport={pendingReport}/>;
    if (page === 'archive') return <Archive data={data} onOpen={(id) => { setProjectId(id); setPage('project'); }} onRestore={async (project) => { if (!ensureCanWrite()) return; setError(null); try { await updateRow<Project>('projects', project.id, { archived: false }, activeOrg.id); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Herstellen mislukt'); } }}/>;
    if (page === 'settings') {
      // De agenda-instellingen zijn geen eigen pagina meer maar het tabblad
      // "Agenda" binnen Instellingen. Het element wordt hier gemaakt maar pas
      // gemount als dat tabblad openstaat; staat de agenda-module dicht voor dit
      // teamlid, dan geven we niets mee en verdwijnt het tabblad. Schrijfrecht
      // komt hier uit de agenda-module, niet uit de instellingenpagina.
      const calendarSettings = permissions.canRead('calendar')
        ? <CalendarPage mode="settings" organizationId={activeOrg.id} currentUserId={currentUserId} data={data} canWrite={orgCanWrite && permissions.canWrite('calendar')} onChanged={refresh} onEditTask={(task) => setEdit({kind:'task', item: task, projectId: task.project_id})} onNewNoteForEvent={openNoteForCalendarEvent} onNewDocumentForEvent={openDocumentForCalendarEvent} onSetEventLink={setCalendarEventLink} onEditNote={(note) => setEdit({kind:'note', item: note})} onLinkExistingNoteToEvent={linkExistingNoteToCalendarEvent} onUnlinkNoteFromEvent={unlinkNoteFromCalendarEvent}/>
        : null;
      return <Settings settings={data.companySettings} data={data} organizationId={activeOrg.id} canWrite={canWrite} onChanged={refresh} organizationContext={organizationContext} currentUserId={currentUserId} push={push} settingsNav={settingsNav} calendarSettings={calendarSettings} onCreateOrganization={createNewOrganization} onSwitchOrganization={switchOrganization} onInviteMember={inviteMember} onAcceptInvitation={acceptInvitation} onUpdateMemberRole={changeMemberRole} onSetMemberModuleAccess={changeMemberModuleAccess} onDisableMember={disableMember} onRevokeInvitation={revokeInvitation} onSave={saveCompanySettings}/>;
    }
    return <div className="empty"><div className="e-big">Geen project geselecteerd</div></div>;
  }
}

function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signIn() {
    setError(null);
    // Zelf-registratie staat op instance-niveau uit. Teamleden krijgen hun
    // auth-account al bij de uitnodiging (mail-functie → ensureAuthUser), dus het
    // loginscherm hoeft — en mag — nooit zelf een account aanmaken. shouldCreateUser:
    // false voorkomt dat een onbekend adres alsnog op "Signups not allowed" stuit.
    const { error } = await supabaseAuth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin, shouldCreateUser: false } });
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

/**
 * Kiezer om een taak toe te wijzen aan één of meer teamleden. Biedt uitsluitend
 * de leden van het projectteam aan (data.projectMembers voor dit project); is
 * dat team nog leeg, dan een verwijzing naar het projectdashboard.
 */
function TaskAssigneePicker({ projectId, assigneeIds, teamMembers, projectMembers, currentUserId, disabled, onChange }: {
  projectId: string | null;
  assigneeIds: string[];
  teamMembers: OrganizationMember[];
  projectMembers: ProjectMember[];
  currentUserId: string | null;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  // Zonder project is er geen projectteam om uit te kiezen: dan mag iedereen in de
  // organisatie toegewezen worden (dat is ook wat de database toestaat).
  const memberUserIds = projectId
    ? projectMembers.filter(pm => pm.project_id === projectId).map(pm => pm.user_id)
    : teamMembers.map(member => member.user_id);
  if (memberUserIds.length === 0) {
    return <div className="assignee-empty-hint">Nog geen teamleden aan dit project gekoppeld. Voeg ze toe in het projectdashboard onder <strong>Projectteam</strong> om taken te kunnen toewijzen.</div>;
  }
  const toggle = (userId: string) =>
    onChange(assigneeIds.includes(userId) ? assigneeIds.filter(id => id !== userId) : [...assigneeIds, userId]);
  return <div className="assignee-picker">
    {memberUserIds.map(userId => {
      const active = assigneeIds.includes(userId);
      return <button
        type="button"
        key={userId}
        className={`assignee-chip${active ? ' active' : ''}`}
        onClick={() => toggle(userId)}
        disabled={disabled}
        aria-pressed={active}
      >
        <span className="assignee-chip-avatar" style={{ background: memberColor(userId) }}>{memberInitials(userId, teamMembers)}</span>
        <span className="assignee-chip-name">{memberShortName(userId, teamMembers, currentUserId)}</span>
        {active && <span className="assignee-chip-check" aria-hidden="true">✓</span>}
      </button>;
    })}
  </div>;
}

function EditModal({ edit, data, organizationId, currentUserId, teamMembers, canWrite, readOnly, onClose, onSave, onDelete, onAttachmentsChanged, onEditNote, onNewClientNote, onConvertToWord, onCreateFromOfficeFile, onCreateBlankOffice }: { edit: NonNullable<EditMode>; data: AppData; organizationId: string; currentUserId: string | null; teamMembers: OrganizationMember[]; canWrite: boolean; readOnly: boolean; onClose: () => void; onSave: (v: Record<string, unknown>) => void; onDelete: () => void; onAttachmentsChanged: () => void; onEditNote: (note: Note) => void; onNewClientNote: (client: Client) => void; onConvertToWord: (doc: InternalDocument) => void; onCreateFromOfficeFile: (file: File, values: Record<string, unknown>) => void; onCreateBlankOffice: (docType: NewOfficeType, values: Record<string, unknown>) => void }) {
  const item = 'item' in edit ? edit.item : undefined;
  const [form, setForm] = useState<Record<string, any>>(() => initialForm(edit, data));
  const set = (k: string, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));
  const officeFileRef = useRef<HTMLInputElement>(null);

  // Taakkoppeling: een taak mag los bestaan, alleen een klant hebben, alleen een project,
  // of allebei. Zodra er een project mét klant gekozen is, is dat project leidend voor de
  // klant — precies zoals de database het ook afdwingt.
  const taskProject = edit.kind === 'task' ? data.projects.find(p => p.id === form.project_id) ?? null : null;
  const taskClientFollowsProject = Boolean(taskProject?.client_id);
  const taskProjectOptions = edit.kind === 'task'
    ? data.projects.filter(p =>
        (!p.archived || p.id === form.project_id) &&
        (!form.client_id || !p.client_id || p.client_id === form.client_id || p.id === form.project_id))
    : [];

  function setTaskProject(nextProjectId: string) {
    set('project_id', nextProjectId);
    const next = data.projects.find(p => p.id === nextProjectId);
    if (next?.client_id) set('client_id', next.client_id);
  }

  function setTaskClient(nextClientId: string) {
    set('client_id', nextClientId);
    // Een project van een ándere klant past niet meer bij deze taak.
    if (taskProject?.client_id && taskProject.client_id !== nextClientId) set('project_id', '');
  }

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

  return <Modal title={title} className={modalClassName} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{effectiveReadOnly ? 'Sluiten' : 'Annuleren'}</Button>{!effectiveReadOnly && item && <Button variant="danger" onClick={onDelete}>Verwijderen</Button>}{!effectiveReadOnly && edit.kind === 'document' && item && !(item as InternalDocument).storage_key && <Button variant="ghost" onClick={() => { onClose(); onConvertToWord(item as InternalDocument); }}>Bewerk als Word</Button>}{!effectiveReadOnly && <Button variant="primary" onClick={() => onSave(cleanForm(edit.kind, form, data.clientFieldDefinitions))} disabled={saveBlockedByDuplicate}>Opslaan</Button>}</>}>
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
      <Field label="Type klant" hint="Bepaalt bij aanmaningen de rentesoort (consument: wettelijke rente; zakelijk: handelsrente) en of de WIK-14-dagenbrief verplicht is.">
        <Select value={form.client_kind} onChange={e=>set('client_kind',e.target.value)} disabled={disabled}><option value="business">Zakelijk (B2B)</option><option value="consumer">Consument</option></Select>
      </Field>
      <Field label="Adres" hint="Straat + huisnummer. Nodig voor de UBL-e-factuur (verplicht bij NL-klanten).">
        <Input value={form.address_line1} onChange={e=>set('address_line1',e.target.value)} placeholder="Straatnaam 1" disabled={disabled}/>
      </Field>
      <Field label="Adresregel 2">
        <Input value={form.address_line2} onChange={e=>set('address_line2',e.target.value)} placeholder="Toevoeging (optioneel)" disabled={disabled}/>
      </Field>
      <Field label="Postcode">
        <Input value={form.postal_code} onChange={e=>set('postal_code',e.target.value)} placeholder="1234 AB" disabled={disabled}/>
      </Field>
      <Field label="Plaats">
        <Input value={form.city} onChange={e=>set('city',e.target.value)} placeholder="Amsterdam" disabled={disabled}/>
      </Field>
      <Field label="Land" hint="Landnaam of ISO-code (bv. Nederland of NL).">
        <Input value={form.country} onChange={e=>set('country',e.target.value)} placeholder="Nederland" disabled={disabled}/>
      </Field>
      <Field label="Btw-nummer" hint="Bv. NL123456789B01. Verplicht bij verlegde of intracommunautaire facturen.">
        <Input value={form.vat_number} onChange={e=>set('vat_number',e.target.value)} placeholder="NL123456789B01" disabled={disabled}/>
      </Field>
      <Field label="KVK-nummer" hint="8 cijfers (of 20-cijferig OIN voor overheden). Verplicht voor e-facturen aan NL-bedrijven via Peppol.">
        <Input value={form.kvk_number} onChange={e=>set('kvk_number',e.target.value)} placeholder="12345678" disabled={disabled}/>
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
      <CustomFieldsSection
        definitions={data.clientFieldDefinitions}
        values={(form.custom_fields ?? {}) as Record<string, unknown>}
        disabled={disabled}
        onChange={(fieldKey, value) => set('custom_fields', { ...(form.custom_fields ?? {}), [fieldKey]: value })}
      />
      {!item && <label className="check-row client-welcome-toggle">
        <input type="checkbox" checked={Boolean(form._sendWelcomeEmail)} onChange={e=>set('_sendWelcomeEmail', e.target.checked)} disabled={disabled || !String(form.email || '').trim()}/>
        <span>Welkomstmail met portaaltoegang sturen naar de klant{!String(form.email || '').trim() && <em className="client-welcome-hint"> — vul eerst een e-mailadres in</em>}</span>
      </label>}
      {item && <RelatedNotes title="Klantnotities" notes={data.notes.filter(note => note.client_id === item.id || data.projects.some(project => project.client_id === item.id && project.id === note.project_id))} data={data} canWrite={canWrite} onNew={() => onNewClientNote(item as Client)} onEdit={onEditNote} emptyText="Nog geen notities bij deze klant." />}
      {!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.client} id={item.id} onUploaded={onAttachmentsChanged}/>}
      {attachmentBlock}
    </FormGrid>}
    {edit.kind === 'project' && <FormGrid><Input value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Projectnaam"/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Omschrijving"/><Input type="date" value={form.start_date} onChange={e=>set('start_date',e.target.value)}/><Input type="date" value={form.end_date} onChange={e=>set('end_date',e.target.value)}/>{!item && <ProjectTemplatePicker data={data} value={String(form._templateId ?? '')} startDate={String(form.start_date ?? '')} disabled={disabled} onChange={templateId=>set('_templateId',templateId)}/>}<Field label="Facturatie" hint="Urenbasis: geregistreerde uren zijn declarabel en vormen de factuurbasis. Aangenomen prijs: factureren via offerte/factuur; uren worden geregistreerd maar standaard niet-declarabel."><Select value={form.billing_type} onChange={e=>set('billing_type',e.target.value)} disabled={disabled}><option value="hourly">Urenbasis</option><option value="fixed_price">Aangenomen prijs (offerte)</option></Select></Field><Field label="Uurtarief (€)" hint="Voor de declarabele waarde van geregistreerde uren. Leeg = bedrijfsbreed standaardtarief."><Input type="number" min="0" step="0.01" value={form.hourly_rate_euro} onChange={e=>set('hourly_rate_euro',e.target.value)} placeholder="Standaardtarief" disabled={disabled}/></Field><Field label="Begrote uren" hint="Urenbudget voor dit project — op het projectdashboard zie je begroot vs. werkelijk geboekt en het effectieve uurtarief."><Input type="number" min="0" step="0.5" value={form.budgeted_hours} onChange={e=>set('budgeted_hours',e.target.value)} placeholder="Geen budget" disabled={disabled}/></Field><Field label="Projectkleur" hint="Bepaalt de kleur van het project in lijsten, kanban en de timeline."><ColorPicker value={form.color} onChange={color=>set('color',color)} disabled={disabled}/></Field><label className="check-row"><input type="checkbox" checked={Boolean(form.archived)} onChange={e=>set('archived',e.target.checked)}/><span>Project archiveren</span></label>{!disabled && (item ? <FileUpload organizationId={organizationId} entity={editKindToEntity.project} id={item.id} onUploaded={onAttachmentsChanged}/> : <UploadHint/>)}{attachmentBlock}</FormGrid>}
    {edit.kind === 'task' && <FormGrid><Field label="Taaktitel"><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Taaktitel" disabled={disabled}/></Field><Field label="Status"><Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={disabled}><option value="todo">Te doen</option><option value="doing">Bezig</option><option value="review">Review</option><option value="done">Klaar</option></Select></Field><Field label="Prioriteit"><Select value={form.priority} onChange={e=>set('priority',e.target.value)} disabled={disabled}><option value="low">Laag</option><option value="med">Normaal</option><option value="high">Hoog</option></Select></Field><Field label="Klant" hint={taskClientFollowsProject ? 'Volgt automatisch uit het gekozen project.' : 'Optioneel — handig als je het project nog niet weet.'}><Select value={form.client_id} onChange={e=>setTaskClient(e.target.value)} disabled={disabled || taskClientFollowsProject}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field><Field label="Project" hint="Optioneel — een taak mag ook los in de weekplanner staan."><Select value={form.project_id} onChange={e=>setTaskProject(e.target.value)} disabled={disabled}><option value="">Geen project</option>{taskProjectOptions.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field><Field label="Tags" hint="Gebruik komma’s om meerdere tags toe te voegen."><Input value={form.tags} onChange={e=>set('tags',e.target.value)} placeholder="Tags" disabled={disabled}/></Field><Field label="Toegewezen aan" hint={form.project_id ? 'Kies teamleden uit het projectteam die aan deze taak werken.' : 'Zonder project kun je iedereen uit je organisatie toewijzen.'}><TaskAssigneePicker projectId={form.project_id || null} assigneeIds={(form._assigneeIds as string[]) ?? []} teamMembers={teamMembers} projectMembers={data.projectMembers} currentUserId={currentUserId} disabled={disabled} onChange={ids => set('_assigneeIds', ids)}/></Field><Field label="Beschrijving"><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Beschrijving" disabled={disabled}/></Field><Field label="Startdatum"><Input type="date" value={form.start_date} onChange={e=>set('start_date',e.target.value)} disabled={disabled}/></Field><Field label="Deadline" hint="Deze datum blijft de inhoudelijke deadline en wordt niet meer aangepast door de weekplanner."><Input type="date" value={form.end_date} onChange={e=>set('end_date',e.target.value)} disabled={disabled}/></Field><Field label="Plandatum" hint="Deze datum bepaalt op welke dag de taak in de weekplanner staat."><Input type="date" value={form.planned_date} onChange={e=>set('planned_date',e.target.value)} disabled={disabled}/></Field><Field label="Loopt door tot" hint="Laat leeg voor werk van één dag. Vul je een latere dag in, dan wordt het een weekstrook over die dagen heen."><Input type="date" value={form.planned_end_date} min={form.planned_date || undefined} onChange={e=>set('planned_end_date',e.target.value)} disabled={disabled || !form.planned_date}/></Field><Field label="Geschatte duur" hint="In minuten. Laat leeg als je het nog niet weet — de taak telt dan nergens als tijd mee."><Input type="number" min="0" max="1440" step="15" placeholder="Nog geen schatting" value={form.estimated_minutes} onChange={e=>set('estimated_minutes',e.target.value)} disabled={disabled}/></Field><TaskDetailEditor subtasks={form.subtasks} comments={form.comments} set={set}/>{!disabled && (item ? <FileUpload organizationId={organizationId} entity={editKindToEntity.task} id={item.id} onUploaded={onAttachmentsChanged}/> : <UploadHint/>)}{attachmentBlock}</FormGrid>}
    {edit.kind === 'ticket' && <FormGrid><Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Ticket titel"/><Select value={form.client_id} onChange={e=>set('client_id',e.target.value)} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select><Select value={form.priority} onChange={e=>set('priority',e.target.value)}><option value="low">Laag</option><option value="med">Normaal</option><option value="high">Hoog</option></Select><Select value={form.status} onChange={e=>set('status',e.target.value)} disabled={Boolean((item as Ticket | undefined)?.converted_to_project_id)}><option value="new">Nieuw</option><option value="review">Review</option><option value="approved">Goedgekeurd</option><option value="rejected">Geweigerd</option>{(item as Ticket | undefined)?.converted_to_project_id && <option value="converted">Omgezet</option>}</Select><Textarea value={form.description} onChange={e=>set('description',e.target.value)} placeholder="Beschrijving"/><Field label="Korte interne notitie" hint="Privé memo op het ticket. Voor een gesprek met de klant gebruik je de tijdlijn hieronder."><Textarea value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="Interne notities (privé, niet in de tijdlijn)"/></Field><small className="ticket-status-hint">Gebruik <strong>Project maken</strong> om een ticket om te zetten. <strong>Omgezet</strong> is geen handmatige status.</small>{item ? <TicketNotesTimeline ticketId={item.id} organizationId={organizationId} currentUserId={currentUserId} notes={data.ticketNotes.filter(n => n.ticket_id === item.id)} canWrite={!disabled} onChanged={onAttachmentsChanged}/> : <div className="ticket-timeline-hint">Sla het ticket eerst op om de notitietijdlijn te gebruiken — daar kunnen jij en de klant berichten plaatsen.</div>}{!disabled && item && <FileUpload organizationId={organizationId} entity={editKindToEntity.ticket} id={item.id} onUploaded={onAttachmentsChanged}/>}{attachmentBlock}</FormGrid>}
    {edit.kind === 'note' && <FormGrid>
      <Input value={form.title} onChange={e=>set('title',e.target.value)} placeholder="Titel"/>
      <Select value={form.note_type} onChange={e=>set('note_type',e.target.value)}>{Object.entries(noteTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
      <RichTextEditor value={form.content} onChange={value=>set('content', value)} placeholder="Schrijf je notitie…" disabled={disabled}/>
      <Select value={form.client_id} onChange={e=>{set('client_id',e.target.value);set('folder_id','');}} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      <Select value={form.project_id} onChange={e=>{set('project_id',e.target.value);set('folder_id','');}} disabled={disabled}><option value="">Geen project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      {form.client_id && <Field label="Map" hint={form.project_id ? 'Plaats deze notitie in een map van het gekozen project.' : 'Plaats deze notitie in een map van de gekozen klant.'}>
        <Select value={form.folder_id} onChange={e=>set('folder_id',e.target.value)} disabled={disabled}><option value="">Geen map</option>{clientFolderOptions(data.folders, form.client_id || null, form.project_id || null).map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</Select>
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
      {!disabled && !item && <div className="document-export">
        <input ref={officeFileRef} type="file" accept={OFFICE_UPLOAD_ACCEPT} hidden onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onCreateFromOfficeFile(file, cleanForm('document', form));
        }}/>
        <span className="document-export-label">Kies het type bestand dat je wilt aanmaken</span>
        <div className="document-export-actions">
          <Button onClick={() => onCreateBlankOffice('docx', cleanForm('document', form))}>+ {NEW_OFFICE_LABEL.docx}</Button>
          <Button onClick={() => onCreateBlankOffice('xlsx', cleanForm('document', form))}>+ {NEW_OFFICE_LABEL.xlsx}</Button>
          <Button onClick={() => onCreateBlankOffice('pptx', cleanForm('document', form))}>+ {NEW_OFFICE_LABEL.pptx}</Button>
          <Button variant="ghost" onClick={() => officeFileRef.current?.click()}>Bestaand bestand uploaden…</Button>
        </div>
        <span className="document-export-hint">Elk type opent leeg in de online editor — uploaden is optioneel, geen verplichte stap. Typ je liever hieronder zelf, dan blijft het een gewoon tekstdocument.</span>
      </div>}
      <RichTextEditor value={form.content} onChange={value=>set('content', value)} placeholder="Schrijf de inhoud van het document…" disabled={disabled}/>
      <Field label="Klant">
        <Select value={form.client_id} onChange={e=>{set('client_id',e.target.value);set('folder_id','');}} disabled={disabled}><option value="">Geen klant</option>{data.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </Field>
      <Field label="Project">
        <Select value={form.project_id} onChange={e=>{set('project_id',e.target.value);set('folder_id','');}} disabled={disabled}><option value="">Geen project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      </Field>
      {form.client_id && <Field label="Map" hint={form.project_id ? 'Plaats dit document in een map van het gekozen project.' : 'Plaats dit document in een map van de gekozen klant.'}>
        <Select value={form.folder_id} onChange={e=>set('folder_id',e.target.value)} disabled={disabled}><option value="">Geen map</option>{clientFolderOptions(data.folders, form.client_id || null, form.project_id || null).map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</Select>
      </Field>}
      {item && <div className="document-export">
        <div className="document-export-actions">
          <Button onClick={handleDownloadPdf} disabled={docExport.busy !== null}>{docExport.busy === 'pdf' ? 'PDF maken…' : 'Download PDF'}</Button>
        </div>
        <span className="document-export-hint">De PDF wordt ook opgeslagen in Cloudflare R2 en verschijnt hieronder als bijlage. Een Word-bestand nodig? Gebruik "Bewerk als Word" — daarna download je het origineel vanuit de editor.</span>
        {docExport.error && <span className="document-export-error">{docExport.error}</span>}
      </div>}
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

    {/* Eén kolom: schrijfvak boven, tijdlijn eronder — allebei op volle breedte. */}
    <div className="ticket-timeline-grid">
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

  // Verkooprelevante btw-codes van de organisatie: die bepalen naast het tarief
  // ook de UBL-categorie van de e-factuur (verlegd/ICP/vrijgesteld i.p.v. een
  // ambigu 0%). Zonder geconfigureerde codes valt de editor terug op het kale
  // percentageveld (en leidt de UBL-generator de categorie af uit het tarief).
  const SALES_VAT_KINDS = ['standard', 'reduced', 'zero', 'exempt', 'reverse_charge_sales', 'icp_goods', 'icp_services'];
  const salesVatCodes = data.vatCodes.filter(v => SALES_VAT_KINDS.includes(v.kind) && v.is_active !== false);
  const lineVatSelectValue = (line: FinanceLine): string => {
    if (line.vat_code && salesVatCodes.some(v => v.code === line.vat_code)) return line.vat_code;
    // Een opgeslagen code die niet meer bestaat/actief is niet stil op een
    // andere code laten matchen — dan maskeer je verlies. Toon '__custom'.
    if (line.vat_code) return '__custom';
    const byRate = salesVatCodes.find(v => ['standard', 'reduced', 'zero'].includes(v.kind) && Math.abs(v.rate - (Number(line.vat) || 0)) < 0.005);
    return byRate?.code ?? '__custom';
  };
  const setLineVatCode = (id: string, code: string) => set('lines', lines.map(l => {
    if (l.id !== id) return l;
    const vc = salesVatCodes.find(v => v.code === code);
    return vc ? { ...l, vat: vc.rate, vat_code: vc.code } : l;
  }));

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
            <Field label="BTW" compact>
              {salesVatCodes.length > 0
                ? <Select value={lineVatSelectValue(line)} onChange={e=>setLineVatCode(line.id, e.target.value)} disabled={disabled}>
                    {lineVatSelectValue(line) === '__custom' && <option value="__custom">{line.vat}% (aangepast)</option>}
                    {salesVatCodes.map(v => <option key={v.code} value={v.code}>{v.label}</option>)}
                  </Select>
                : <Input type="number" min="0" step="0.01" value={line.vat} onChange={e=>updateLine(line.id,'vat',e.target.value)} disabled={disabled}/>}
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
    return { name: item?.name ?? edit.defaults?.name ?? "", client_code: item?.client_code ?? "", contact_name: item?.contact_name ?? edit.defaults?.contact_name ?? "", email: item?.email ?? edit.defaults?.email ?? "", phone: item?.phone ?? edit.defaults?.phone ?? "", status: item?.status ?? edit.defaults?.status ?? "active", client_kind: item?.client_kind ?? "business", value_eur: item?.value_eur ?? 0, tags: item?.tags?.join(", ") ?? "", notes: item?.notes ?? edit.defaults?.notes ?? "", color: item?.color ?? "#FFD966", address_line1: item?.address_line1 ?? "", address_line2: item?.address_line2 ?? "", postal_code: item?.postal_code ?? "", city: item?.city ?? "", country: item?.country ?? (item ? "" : "Nederland"), vat_number: item?.vat_number ?? "", kvk_number: item?.kvk_number ?? "", custom_fields: { ...(item?.custom_fields ?? {}) }, _sendWelcomeEmail: !item };
  }
  if (edit.kind === "project") {
    const item = edit.item;
    return { name: item?.name ?? edit.defaults?.name ?? "", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", description: item?.description ?? edit.defaults?.description ?? "", color: normalizeColor(item?.color, DEFAULT_PROJECT_COLOR), archived: item?.archived ?? false, start_date: item?.start_date ?? edit.defaults?.start_date ?? "", end_date: item?.end_date ?? edit.defaults?.end_date ?? "", billing_type: item?.billing_type ?? "hourly", hourly_rate_euro: item?.hourly_rate_cents != null ? String(item.hourly_rate_cents / 100) : "", budgeted_hours: item?.budgeted_minutes != null ? String(Math.round((item.budgeted_minutes / 60) * 100) / 100) : "", _templateId: "" };
  }
  if (edit.kind === "task") {
    const item = edit.item;
    return { title: item?.title ?? edit.defaults?.title ?? "", description: item?.description ?? edit.defaults?.description ?? "", status: item?.status ?? edit.defaults?.status ?? "todo", priority: item?.priority ?? edit.defaults?.priority ?? "med", project_id: item?.project_id ?? edit.defaults?.project_id ?? edit.projectId ?? "", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", tags: item?.tags?.join(", ") ?? edit.defaults?.tags?.join(", ") ?? "", start_date: item?.start_date ?? edit.defaults?.start_date ?? "", end_date: item?.end_date ?? edit.defaults?.end_date ?? "", planned_date: item?.planned_date ?? edit.defaults?.planned_date ?? "", planned_end_date: item?.planned_end_date ?? "", estimated_minutes: item?.estimated_minutes ?? edit.defaults?.estimated_minutes ?? "", subtasks: normalizeSubtasks(item?.subtasks ?? edit.defaults?.subtasks), comments: normalizeComments(item?.comments), _assigneeIds: item ? data.taskAssignees.filter(a => a.task_id === item.id).map(a => a.user_id) : [] };
  }
  if (edit.kind === "ticket") {
    const item = edit.item;
    return { title: item?.title ?? edit.defaults?.title ?? "", description: item?.description ?? edit.defaults?.description ?? "", client_id: item?.client_id ?? edit.defaults?.client_id ?? "", priority: item?.priority ?? edit.defaults?.priority ?? "med", status: item?.status ?? edit.defaults?.status ?? "new", notes: item?.notes ?? edit.defaults?.notes ?? "" };
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

function cleanForm(kind: string, form: Record<string, any>, clientFieldDefinitions: ClientFieldDefinition[] = []) {
  const cleaned: Record<string, any> = { ...form };
  if (kind === 'client') {
    // De vrije velden komen als formulierstrings binnen; de databasetrigger
    // verwacht getallen, booleans en arrays. Normaliseren is dus verplicht.
    cleaned.custom_fields = normalizeCustomFieldValues(cleaned.custom_fields, clientFieldDefinitions);
    cleaned.name = String(cleaned.name ?? '').trim();
    cleaned.client_code = normalizeOptionalText(cleaned.client_code);
    cleaned.contact_name = normalizeOptionalText(cleaned.contact_name);
    cleaned.email = normalizeOptionalText(cleaned.email)?.toLowerCase() ?? null;
    cleaned.phone = normalizeOptionalText(cleaned.phone);
    cleaned.notes = normalizeOptionalText(cleaned.notes);
    cleaned.address_line1 = normalizeOptionalText(cleaned.address_line1);
    cleaned.address_line2 = normalizeOptionalText(cleaned.address_line2);
    cleaned.postal_code = normalizeOptionalText(cleaned.postal_code);
    cleaned.city = normalizeOptionalText(cleaned.city);
    cleaned.country = normalizeOptionalText(cleaned.country);
    cleaned.vat_number = normalizeOptionalText(cleaned.vat_number);
    cleaned.kvk_number = normalizeOptionalText(cleaned.kvk_number);
  }
  for (const key of ["client_id","project_id","folder_id","quote_id","valid_until","due_date","start_date","end_date","planned_date","planned_end_date"]) {
    if (cleaned[key] === "") cleaned[key] = null;
  }
  if (kind === 'task') {
    // Een einddatum zonder startdag, of eentje die niet ná de startdag ligt, is
    // geen weekstrook — en zou op de check-constraint stuklopen.
    if (!cleaned.planned_date || (cleaned.planned_end_date && cleaned.planned_end_date <= cleaned.planned_date)) {
      cleaned.planned_end_date = null;
    }
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
    // Leeg laten mag: dan is er simpelweg nog geen schatting, en telt de taak
    // nergens als tijd mee in plaats van stilletjes als een uur.
    const rawEstimate = String(cleaned.estimated_minutes ?? '').trim();
    const estimatedMinutes = Number(rawEstimate);
    cleaned.estimated_minutes = rawEstimate === '' || !Number.isFinite(estimatedMinutes)
      ? null
      : Math.max(0, Math.min(1440, Math.round(estimatedMinutes)));
    delete cleaned.planned_order;
  }
  if (kind === 'project') {
    const euros = String(cleaned.hourly_rate_euro ?? '').replace(',', '.').trim();
    const cents = euros === '' ? null : Math.round(Number(euros) * 100);
    cleaned.hourly_rate_cents = cents != null && Number.isFinite(cents) && cents >= 0 ? cents : null;
    delete cleaned.hourly_rate_euro;
    cleaned.billing_type = cleaned.billing_type === 'fixed_price' ? 'fixed_price' : 'hourly';
    // Begrote uren (decimaal, bv. "37,5") → minuten voor begroot vs. werkelijk.
    const budgetHours = String(cleaned.budgeted_hours ?? '').replace(',', '.').trim();
    const budgetMinutes = budgetHours === '' ? null : Math.round(Number(budgetHours) * 60);
    cleaned.budgeted_minutes = budgetMinutes != null && Number.isFinite(budgetMinutes) && budgetMinutes >= 0 ? budgetMinutes : null;
    delete cleaned.budgeted_hours;
  }
  if (Array.isArray(cleaned.lines)) {
    cleaned.lines = cleaned.lines
      .map((line: FinanceLine) => ({
        id: line.id || uid(),
        description: String(line.description || "").trim(),
        quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : 0,
        unit_price: Number.isFinite(Number(line.unit_price)) ? Number(line.unit_price) : 0,
        vat: Number.isFinite(Number(line.vat)) ? Number(line.vat) : 0,
        // vat_code moet behouden blijven: het maakt 0%-regels ondubbelzinnig voor
        // de UBL-e-factuur (verlegd/ICP/vrijgesteld i.p.v. nul). Zonder deze regel
        // valt de server-side UBL-generator terug op tarief-afleiding en wordt een
        // verlegde regel als 'zero-rated' geëxporteerd.
        ...(typeof line.vat_code === "string" && line.vat_code.trim() ? { vat_code: line.vat_code } : {}),
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
