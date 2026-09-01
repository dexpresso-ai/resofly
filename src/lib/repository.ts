import { supabase, supabaseAuth } from './supabase';
import { recordInvitationBlockedBySeats } from '../services/licenseService';
import { deleteR2Object } from './r2-api';
import { throwFunctionError } from './functionErrors';
import type { ReportDefinition } from './reporting';
import type { ModuleAccess } from './permissions';
import type {
  AppData,
  AuditLog,
  Attachment,
  Client,
  ClientContact,
  ClientFieldDefinition,
  CompanySettings,
  CompanySettingsInput,
  EmailTemplate,
  EmailTemplateInput,
  EmailTemplateKey,
  EntityType,
  Invoice,
  InvoiceEmailDelivery,
  InvoicePaymentRecord,
  InvoiceRefund,
  InvoiceVersion,
  InvoiceWorkflowEvent,
  InvoiceMollieSettingsStatus,
  InvoiceReminderSettings,
  DunningNotice,
  SendingDomain,
  ClientEmail,
  ClientEmailThread,
  ClientEmailUnreadCounts,
  OrganizationInboundAlias,
  InboundMessage,
  InboundMessageCategory,
  EmailCampaign,
  EmailCampaignRecipient,
  EmailCampaignStats,
  EmailSuppression,
  EmailSuppressionReason,
  CampaignAudience,
  EmailFlow,
  EmailFlowStep,
  EmailFlowEnrollment,
  EmailFlowStats,
  EmailFlowStepStats,
  FlowStopCondition,
  FlowStepInput,
  UserSenderIdentity,
  CreditNote,
  InvoiceChargeback,
  Note,
  InternalDocument,
  ContentFolder,
  Gallery,
  GalleryCategory,
  GalleryCategoryPreset,
  GalleryFavorite,
  GalleryItem,
  LedgerAccount,
  VatCode,
  JournalEntry,
  JournalLine,
  ClosedPeriod,
  FiscalYear,
  FiscalYearListRow,
  Supplier,
  PurchaseInvoice,
  FixedAsset,
  AssetDepreciation,
  ProfitAndLossRow,
  BalanceSheetRow,
  TrialBalanceRow,
  AccountLedgerRow,
  VatReturn,
  VatReturnRubrieken,
  VatSupplementEntry,
  OpenItemsReport,
  IcpDeclaration,
  BankAccount,
  BankStatement,
  BankTransaction,
  BankRule,
  BankRequisition,
  BankInstitution,
  BankReconciliation,
  ParsedBankStatement,
  CalendarNoteLinkInput,
  NoteCalendarLink,
  CalendarEventLink,
  CalendarEventLinkInput,
  TimeEntry,
  TimeEntryType,
  IndirectHoursCategory,
  Organization,
  OrganizationStorageStatus,
  OrganizationContext,
  OrganizationInvitation,
  OrganizationBillingOverview,
  OrganizationCreativeStatus,
  OrganizationBusinessStatus,
  LegalForm,
  OrganizationLicenseUsage,
  OrganizationMember,
  OrganizationMembershipView,
  OrganizationRole,
  Project,
  ProjectMember,
  ProjectTemplate,
  ProjectTemplateTask,
  ProjectTemplateTaskInput,
  Quote,
  QuoteApprovalEvent,
  QuoteEmailDelivery,
  QuoteVersion,
  CorporateTaxCorrectionRow,
  CorporateTaxReturn,
  DgaInterestComputation,
  AnnualAccount,
  AnnualAccountSnapshot,
  AnnualAccountAdoptionMethod,
  AnnualAccountListRow,
  AnnualAccountSignature,
  AnnualAccountSignatureRole,
  AccountingBasis,
  CompanySizeResult,
  FiscalYearSizeInputs,
  SizeClass,
  DgaInterestPosting,
  DgaInterestRate,
  DgaSignals,
  DividendDistributionLine,
  DividendDistributionRow,
  DividendKind,
  ResultAppropriation,
  ResultAppropriationRow,
  ShareEncumbrance,
  Shareholder,
  ShareholderPosition,
  ShareTransaction,
  SavedReport,
  PlannerNote,
  PlannerDayCapacity,
  ContractProject,
  Task,
  TaskAssignee,
  Ticket,
  TicketNote,
  UUID,
} from '../types';

const tables = ['clients', 'client_contacts', 'client_field_definitions', 'projects', 'project_templates', 'project_template_tasks', 'tasks', 'project_members', 'task_assignees', 'contract_projects', 'tickets', 'notes', 'documents', 'content_folders', 'quotes', 'invoices', 'ledger_accounts', 'vat_codes', 'suppliers', 'purchase_invoices', 'fixed_assets', 'vat_returns', 'bank_accounts', 'bank_rules', 'attachments', 'galleries', 'gallery_items', 'gallery_favorites', 'gallery_categories', 'gallery_category_presets', 'saved_reports', 'planner_notes', 'company_settings'] as const;
export type Table = typeof tables[number];

type AttachmentRef = Pick<Attachment, 'id' | 'storage_key'>;

type MembershipRow = OrganizationMember & { organization: Organization | Organization[] | null };

const tableToEntity: Record<Table, EntityType | null> = {
  clients: 'client',
  client_contacts: null,
  client_field_definitions: null,
  projects: 'project',
  project_templates: null,
  project_template_tasks: null,
  tasks: 'task',
  project_members: null,
  task_assignees: null,
  contract_projects: null,
  tickets: 'ticket',
  notes: 'note',
  documents: 'document',
  content_folders: null,
  quotes: 'quote',
  invoices: 'invoice',
  ledger_accounts: null,
  vat_codes: null,
  suppliers: 'supplier',
  purchase_invoices: 'purchase_invoice',
  fixed_assets: 'fixed_asset',
  vat_returns: null,
  bank_accounts: null,
  bank_rules: null,
  attachments: null,
  galleries: null,
  gallery_items: null,
  gallery_favorites: null,
  gallery_categories: null,
  gallery_category_presets: null,
  saved_reports: null,
  planner_notes: null,
  company_settings: null,
};

const protectedMutationFields = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

function sanitizeMutationValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !protectedMutationFields.has(key)),
  );
}

export async function loadOrganizationContext(activeOrganizationId?: UUID | null): Promise<OrganizationContext> {
  await ensureDefaultOrganization();
  const { data: userData, error: userError } = await supabaseAuth.getUser();
  if (userError) throw userError;

  const currentUserId = userData.user?.id;
  if (!currentUserId) throw new Error('Niet ingelogd.');
  const currentEmail = userData.user?.email?.trim().toLowerCase() ?? '';
  const nowIso = new Date().toISOString();

  const [{ data: membershipRows, error: membershipError }, { data: invitationRows, error: invitationError }] = await Promise.all([
    supabase
      .from('organization_members')
      .select('*, organization:organizations(*)')
      .eq('user_id', currentUserId)
      .eq('status', 'active')
      .order('created_at', { ascending: true }),
    currentEmail
      ? supabase
        .from('organization_invitations')
        .select('*')
        .eq('status', 'pending')
        .eq('email', currentEmail)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (membershipError) throw membershipError;
  if (invitationError) throw invitationError;

  const memberships = ((membershipRows ?? []) as MembershipRow[])
    .map(row => {
      const organization = Array.isArray(row.organization) ? row.organization[0] : row.organization;
      if (!organization) return null;
      return { ...row, organization } as OrganizationMembershipView;
    })
    .filter(Boolean) as OrganizationMembershipView[];

  const organizations = memberships.map(membership => membership.organization);
  const activeOrganization = organizations.find(org => org.id === activeOrganizationId) ?? organizations[0] ?? null;
  const activeMembership = activeOrganization
    ? memberships.find(membership => membership.organization_id === activeOrganization.id && membership.user_id === currentUserId) ?? null
    : null;

  let teamMembers: OrganizationMember[] = [];
  let organizationInvitations: OrganizationInvitation[] = [];
  let auditLogs: AuditLog[] = [];
  let licenseUsage: OrganizationLicenseUsage | null = null;
  let billingOverview: OrganizationBillingOverview | null = null;
  let creativeStatus: OrganizationCreativeStatus | null = null;
  let businessStatus: OrganizationBusinessStatus | null = null;
  if (activeOrganization) {
    const [{ data: teamRows, error: teamError }, { data: orgInvitationRows, error: orgInvitationError }, { data: auditRows, error: auditError }, { data: licenseRows, error: licenseError }, { data: billingRows, error: billingError }, { data: creativeRows, error: creativeError }, { data: businessRows, error: businessError }] = await Promise.all([
      supabase
        .from('organization_members')
        .select('*')
        .eq('organization_id', activeOrganization.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true }),
      supabase
        .from('organization_invitations')
        .select('*')
        .eq('organization_id', activeOrganization.id)
        .eq('status', 'pending')
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .order('created_at', { ascending: false }),
      supabase
        .from('audit_logs')
        .select('*')
        .eq('organization_id', activeOrganization.id)
        .order('created_at', { ascending: false })
        .limit(40),
      supabase.rpc('organization_license_usage', { p_organization_id: activeOrganization.id }),
      supabase.rpc('organization_billing_overview', { p_organization_id: activeOrganization.id }),
      supabase.rpc('organization_creative_status', { p_organization_id: activeOrganization.id }),
      supabase.rpc('organization_business_status', { p_organization_id: activeOrganization.id }),
    ]);
    if (teamError) throw teamError;
    if (orgInvitationError) throw orgInvitationError;
    if (licenseError) throw licenseError;
    if (billingError) {
      console.warn('Billing-overview kon niet worden geladen. Controleer of de Sprint 2 database-migratie is uitgevoerd.', billingError);
    }
    if (auditError) {
      console.warn('Audit-log kon niet worden geladen. Controleer of de Sprint 1 database-migratie is uitgevoerd.', auditError);
    }
    teamMembers = (teamRows ?? []) as OrganizationMember[];
    organizationInvitations = (orgInvitationRows ?? []) as OrganizationInvitation[];
    auditLogs = auditError ? [] : (auditRows ?? []) as AuditLog[];
    const firstLicenseRow = Array.isArray(licenseRows) ? licenseRows[0] : licenseRows;
    licenseUsage = (firstLicenseRow ?? null) as OrganizationLicenseUsage | null;
    const firstBillingRow = Array.isArray(billingRows) ? billingRows[0] : billingRows;
    billingOverview = billingError ? null : (firstBillingRow ?? null) as OrganizationBillingOverview | null;
    if (creativeError) {
      // Migratie 20260806000000 nog niet toegepast: geen entitlement-informatie.
      // De galerij valt dan terug op het gedrag van vóór de creatieve module.
      console.warn('Status van de creatieve module kon niet worden geladen.', creativeError);
    }
    const firstCreativeRow = Array.isArray(creativeRows) ? creativeRows[0] : creativeRows;
    creativeStatus = creativeError ? null : (firstCreativeRow ?? null) as OrganizationCreativeStatus | null;
    if (businessError) {
      // Migratie 20260807000000 nog niet toegepast: geen rechtsvorm/entiteit-informatie.
      // De app gedraagt zich dan als vóór de zakelijke module (alles IB-ondernemer).
      console.warn('Status van de zakelijke module kon niet worden geladen.', businessError);
    }
    const firstBusinessRow = Array.isArray(businessRows) ? businessRows[0] : businessRows;
    businessStatus = businessError ? null : (firstBusinessRow ?? null) as OrganizationBusinessStatus | null;
  }

  return {
    memberships,
    organizations,
    activeOrganization,
    activeMembership,
    teamMembers,
    pendingInvitations: (invitationRows ?? []) as OrganizationInvitation[],
    organizationInvitations,
    licenseUsage,
    auditLogs,
    billingOverview,
    creativeStatus,
    businessStatus,
  };
}

/**
 * Een extra administratie (entiteit) toevoegen onder dezelfde organisatie —
 * bijvoorbeeld een werk-BV naast de holding. Vereist de zakelijke module en
 * owner-rechten op de hoofdorganisatie; de RPC bewaakt beide.
 */
export async function createChildOrganization(parentOrganizationId: UUID, name: string, legalForm: LegalForm): Promise<Organization> {
  const { data, error } = await supabase.rpc('create_child_organization', {
    p_parent_organization_id: parentOrganizationId,
    p_name: name,
    p_legal_form: legalForm,
  });
  if (error) throw error;
  return data as Organization;
}

export async function ensureDefaultOrganization(): Promise<void> {
  const { error } = await supabase.rpc('ensure_user_default_organization');
  if (error) throw error;
}

export async function createOrganization(name: string): Promise<Organization> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Organisatienaam ontbreekt.');
  const { data, error } = await supabase.rpc('create_organization', { p_name: cleanName });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Organization;
}

export async function inviteOrganizationMember(
  organizationId: UUID,
  email: string,
  role: OrganizationRole,
  moduleAccess: ModuleAccess = {},
): Promise<OrganizationInvitation> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) throw new Error('E-mailadres ontbreekt.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Vul een geldig e-mailadres in.');
  const { data, error } = await supabase.rpc('invite_organization_member', {
    p_organization_id: organizationId,
    p_email: cleanEmail,
    p_role: role,
    p_module_access: moduleAccess,
  });
  if (error) {
    if (/licentie|seat|Geen vrije/i.test(error.message)) {
      await recordInvitationBlockedBySeats(organizationId, cleanEmail);
    }
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row as OrganizationInvitation;
}

/**
 * Stuurt de uitgenodigde persoon een e-mail met uitleg + inloglink, server-side
 * via de `mail`-edge function (Resend). Bewust losgekoppeld van
 * inviteOrganizationMember, zodat een mislukte mail de (al aangemaakte)
 * uitnodiging niet terugdraait — de aanroeper beslist hoe hij dat aan de
 * gebruiker toont.
 */
export async function sendTeamInvitationEmail(organizationId: UUID, invitationId: UUID): Promise<{ providerEmailId?: string; recipientEmail?: string }> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: {
      action: 'sendTeamInvitation',
      organizationId,
      invitationId,
    },
  });
  if (error) await throwFunctionError(error, 'Uitnodigingsmail verzenden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Uitnodigingsmail verzenden mislukt.');
  return data as { providerEmailId?: string; recipientEmail?: string };
}

export async function acceptOrganizationInvitation(invitationId: UUID): Promise<OrganizationMember> {
  const { data, error } = await supabase.rpc('accept_organization_invitation', { p_invitation_id: invitationId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as OrganizationMember;
}

export async function revokeOrganizationInvitation(invitationId: UUID, organizationId: UUID): Promise<void> {
  const { error } = await supabase
    .from('organization_invitations')
    .update({ status: 'revoked', consumes_license: false })
    .eq('id', invitationId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

export async function updateOrganizationMemberRole(memberId: UUID, organizationId: UUID, role: OrganizationRole): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .update({ role })
    .eq('id', memberId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

/**
 * Zet de modulerechten van één teamlid (owner/admin). Loopt via een RPC omdat
 * de tabel-policy alleen owners laat schrijven — de RPC laat ook admins toe,
 * behalve op owners en (voor een admin) op andere admins.
 */
export async function setMemberModuleAccess(memberId: UUID, moduleAccess: ModuleAccess): Promise<OrganizationMember> {
  const { data, error } = await supabase.rpc('set_member_module_access', {
    p_member_id: memberId,
    p_module_access: moduleAccess,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as OrganizationMember;
}

export async function disableOrganizationMember(memberId: UUID, organizationId: UUID): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .update({ status: 'disabled' })
    .eq('id', memberId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

export async function loadOrganizationMembers(organizationId: UUID): Promise<OrganizationMember[]> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OrganizationMember[];
}

export async function loadOrganizationInvitations(organizationId: UUID): Promise<OrganizationInvitation[]> {
  const { data, error } = await supabase
    .from('organization_invitations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OrganizationInvitation[];
}

export async function loadAppData(organizationId: UUID): Promise<AppData> {
  const [
    clients,
    clientContacts,
    clientFieldDefinitions,
    projects,
    tasks,
    tickets,
    ticketNotes,
    notes,
    documents,
    noteCalendarLinks,
    calendarEventLinks,
    timeEntries,
    quotes,
    quoteApprovalEvents,
    quoteEmailDeliveries,
    quoteVersions,
    invoices,
    invoiceWorkflowEvents,
    invoiceEmailDeliveries,
    invoicePaymentRecords,
    invoiceVersions,
    invoiceRefunds,
    creditNotes,
    invoiceChargebacks,
    dunningNotices,
    ledgerAccounts,
    vatCodes,
    journalEntries,
    journalLines,
    closedPeriods,
    fiscalYears,
    suppliers,
    purchaseInvoices,
    fixedAssets,
    assetDepreciations,
    vatReturns,
    bankAccounts,
    bankStatements,
    bankTransactions,
    bankRules,
    bankRequisitions,
    attachments,
    folders,
    galleries,
    savedReports,
    plannerNotes,
    plannerCapacity,
    companySettings,
    projectMembers,
    taskAssignees,
    projectTemplates,
    projectTemplateTasks,
    contractProjects,
  ] = await Promise.all([
    select<Client>('clients', organizationId), selectClientContacts(organizationId), selectClientFieldDefinitions(organizationId), select<Project>('projects', organizationId), select<Task>('tasks', organizationId), select<Ticket>('tickets', organizationId),
    selectTicketNotes(organizationId), select<Note>('notes', organizationId), selectDocuments(organizationId), selectNoteCalendarLinks(organizationId), selectCalendarEventLinks(organizationId), selectTimeEntries(organizationId), select<Quote>('quotes', organizationId), selectQuoteApprovalEvents(organizationId), selectQuoteEmailDeliveries(organizationId), selectQuoteVersions(organizationId), select<Invoice>('invoices', organizationId),
    selectInvoiceWorkflowEvents(organizationId), selectInvoiceEmailDeliveries(organizationId), selectInvoicePaymentRecords(organizationId), selectInvoiceVersions(organizationId),
    selectInvoiceRefunds(organizationId), selectCreditNotes(organizationId), selectInvoiceChargebacks(organizationId), selectDunningNotices(organizationId),
    selectLedgerAccounts(organizationId), selectVatCodes(organizationId), selectJournalEntries(organizationId), selectJournalLines(organizationId), selectClosedPeriods(organizationId), selectFiscalYears(organizationId), selectSuppliers(organizationId), selectPurchaseInvoices(organizationId), selectFixedAssets(organizationId), selectAssetDepreciations(organizationId), selectVatReturns(organizationId),
    selectBankAccounts(organizationId), selectBankStatements(organizationId), selectBankTransactions(organizationId), selectBankRules(organizationId), selectBankRequisitions(organizationId),
    select<Attachment>('attachments', organizationId),
    selectFolders(organizationId),
    selectGalleries(organizationId),
    selectSavedReports(organizationId),
    selectPlannerNotes(organizationId),
    selectPlannerDayCapacity(organizationId),
    loadCompanySettings(organizationId),
    selectProjectMembers(organizationId),
    selectTaskAssignees(organizationId),
    selectProjectTemplates(organizationId),
    selectProjectTemplateTasks(organizationId),
    selectContractProjects(organizationId),
  ]);
  return { clients, clientContacts, clientFieldDefinitions, projects, projectTemplates, projectTemplateTasks, tasks, projectMembers, taskAssignees, contractProjects, tickets, ticketNotes, notes, documents, folders, noteCalendarLinks, calendarEventLinks, timeEntries, quotes, quoteApprovalEvents, quoteEmailDeliveries, quoteVersions, invoices, invoiceWorkflowEvents, invoiceEmailDeliveries, invoicePaymentRecords, invoiceVersions, invoiceRefunds, creditNotes, invoiceChargebacks, dunningNotices, ledgerAccounts, vatCodes, journalEntries, journalLines, closedPeriods, fiscalYears, suppliers, purchaseInvoices, fixedAssets, assetDepreciations, vatReturns, bankAccounts, bankStatements, bankTransactions, bankRules, bankRequisitions, attachments, galleries, savedReports, plannerNotes, plannerCapacity, companySettings };
}

const CONTRACT_PROJECTS_MIGRATION_HINT =
  'Voer de migratie 20260803000000_contract_office_editing_and_projects.sql uit in Supabase om contracten aan meerdere projecten te kunnen koppelen.';

/**
 * Contract↔project-koppelingen. De contracten zélf zitten niet in AppData (die
 * laadt elke contractpagina zelf), maar de koppelrijen wél: de projectpagina en
 * het contractformulier hebben ze allebei nodig en ze zijn klein.
 */
export async function selectContractProjects(organizationId: UUID): Promise<ContractProject[]> {
  return selectOptional<ContractProject>('contract_projects', organizationId, {
    orderBy: 'created_at', ascending: true, hint: CONTRACT_PROJECTS_MIGRATION_HINT,
  });
}

/** Koppel een project aan een contract (idempotent: dubbel koppelen is geen fout). */
export async function addContractProject(organizationId: UUID, contractId: UUID, projectId: UUID): Promise<void> {
  const { error } = await supabase
    .from('contract_projects')
    .upsert({ organization_id: organizationId, contract_id: contractId, project_id: projectId }, { onConflict: 'contract_id,project_id', ignoreDuplicates: true });
  if (error) throw error;
}

/** Ontkoppel een project van een contract. */
export async function removeContractProject(organizationId: UUID, contractId: UUID, projectId: UUID): Promise<void> {
  const { error } = await supabase
    .from('contract_projects')
    .delete()
    .eq('organization_id', organizationId)
    .eq('contract_id', contractId)
    .eq('project_id', projectId);
  if (error) throw error;
}

/** Zet de projectkoppelingen van één contract op exact deze lijst. */
export async function setContractProjects(organizationId: UUID, contractId: UUID, projectIds: UUID[]): Promise<void> {
  const wanted = [...new Set(projectIds)];
  const { data, error } = await supabase
    .from('contract_projects').select('project_id')
    .eq('organization_id', organizationId).eq('contract_id', contractId);
  if (error) throw error;
  const current = ((data ?? []) as Array<{ project_id: UUID }>).map(r => r.project_id);

  const toAdd = wanted.filter(id => !current.includes(id));
  const toRemove = current.filter(id => !wanted.includes(id));

  if (toAdd.length) {
    const { error: insertError } = await supabase.from('contract_projects').insert(
      toAdd.map(projectId => ({ organization_id: organizationId, contract_id: contractId, project_id: projectId })),
    );
    if (insertError) throw insertError;
  }
  if (toRemove.length) {
    const { error: deleteError } = await supabase
      .from('contract_projects').delete()
      .eq('organization_id', organizationId).eq('contract_id', contractId)
      .in('project_id', toRemove);
    if (deleteError) throw deleteError;
  }
}

const GALLERY_MIGRATION_HINT =
  'Voer de migratie 20260802000000_gallery_module.sql uit in Supabase om galerij-oplevering te activeren.';

/** Galerijen (org-breed; filter client-side op project_id). */
export async function selectGalleries(organizationId: UUID): Promise<Gallery[]> {
  return selectOptional<Gallery>('galleries', organizationId, {
    orderBy: 'created_at', ascending: false, hint: GALLERY_MIGRATION_HINT,
  });
}

/** Items van één galerij (lazy — kan honderden rijen per galerij zijn). */
export async function selectGalleryItems(organizationId: UUID, galleryId: UUID): Promise<GalleryItem[]> {
  const { data, error } = await supabase
    .from('gallery_items')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('gallery_id', galleryId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as GalleryItem[];
}

/** Accountbreed opslagverbruik + limiet; null bij fouten (bijv. migratie nog niet toegepast). */
export async function fetchOrganizationStorageStatus(organizationId: UUID): Promise<OrganizationStorageStatus | null> {
  const { data, error } = await supabase.rpc('organization_storage_status', { p_organization_id: organizationId });
  if (error) {
    console.warn(`organization_storage_status niet beschikbaar. ${GALLERY_MIGRATION_HINT}`, error);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as OrganizationStorageStatus | null;
}

/** Categorieën van één galerij, in weergavevolgorde. */
export async function selectGalleryCategories(organizationId: UUID, galleryId: UUID): Promise<GalleryCategory[]> {
  const { data, error } = await supabase
    .from('gallery_categories')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('gallery_id', galleryId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as GalleryCategory[];
}

/** Standaardcategorieën van de organisatie (startpunt voor nieuwe galerijen). */
export async function selectGalleryCategoryPresets(organizationId: UUID): Promise<GalleryCategoryPreset[]> {
  return selectOptional<GalleryCategoryPreset>('gallery_category_presets', organizationId, {
    orderBy: 'position', ascending: true, hint: GALLERY_MIGRATION_HINT,
  });
}

/**
 * Vervangt de standaardlijst van de organisatie door deze namen. Wordt gebruikt
 * vanuit een galerij ("bewaar deze indeling als standaard"), zodat de gebruiker
 * geen apart instellingenscherm nodig heeft.
 */
export async function replaceGalleryCategoryPresets(organizationId: UUID, names: string[]): Promise<GalleryCategoryPreset[]> {
  const { error: deleteError } = await supabase
    .from('gallery_category_presets')
    .delete()
    .eq('organization_id', organizationId);
  if (deleteError) throw deleteError;

  const cleaned = names.map(name => name.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const createdBy = await currentUserId();
  const { data, error } = await supabase
    .from('gallery_category_presets')
    .insert(cleaned.map((name, index) => ({
      organization_id: organizationId,
      created_by: createdBy,
      name,
      position: index,
    })))
    .select('*');
  if (error) throw error;
  return (data ?? []) as GalleryCategoryPreset[];
}

/**
 * Zet de volledige volgorde van een galerij in één statement. `itemIds` is de
 * gewenste volgorde; de database schrijft sort_order 0..n-1. Eén round-trip,
 * dus ook bij honderden foto's geen half toegepaste volgorde.
 */
export async function setGalleryItemOrder(galleryId: UUID, itemIds: UUID[]): Promise<void> {
  if (itemIds.length === 0) return;
  const { error } = await supabase.rpc('gallery_set_item_order', {
    p_gallery_id: galleryId,
    p_item_ids: itemIds,
  });
  if (error) throw error;
}

/** Zet de categorie van meerdere items in één keer (bulk-toewijzing). */
export async function setGalleryItemsCategory(organizationId: UUID, itemIds: UUID[], categoryId: UUID | null): Promise<void> {
  if (itemIds.length === 0) return;
  const { error } = await supabase
    .from('gallery_items')
    .update({ category_id: categoryId, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .in('id', itemIds);
  if (error) throw error;
}

/** Favorieten (klantselectie) van één galerij. */
export async function selectGalleryFavorites(organizationId: UUID, galleryId: UUID): Promise<GalleryFavorite[]> {
  const { data, error } = await supabase
    .from('gallery_favorites')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('gallery_id', galleryId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as GalleryFavorite[];
}

const PROJECT_TEAM_MIGRATION_HINT =
  'Voer de migratie 20260710040000_project_members_task_assignees.sql uit in Supabase om projectteams en taak-toewijzingen te activeren.';

/** Projectteam-koppelingen (org-breed; filter client-side op project_id). */
export async function selectProjectMembers(organizationId: UUID): Promise<ProjectMember[]> {
  return selectOptional<ProjectMember>('project_members', organizationId, {
    orderBy: 'created_at', ascending: true, hint: PROJECT_TEAM_MIGRATION_HINT,
  });
}

/** Taak-toewijzingen (org-breed; filter client-side op task_id). */
/** Alle toewijzingen van de organisatie, of — met `taskId` — alleen die van één
 *  taak. Dat tweede is voor de weekplanner: na het slepen van één kaart hoeft
 *  niet de hele tabel opnieuw opgehaald te worden. */
export async function selectTaskAssignees(organizationId: UUID, taskId?: UUID): Promise<TaskAssignee[]> {
  return selectOptional<TaskAssignee>('task_assignees', organizationId, {
    orderBy: 'created_at', ascending: true, hint: PROJECT_TEAM_MIGRATION_HINT,
    eq: taskId ? { task_id: taskId } : undefined,
  });
}

/** Voeg een organisatielid toe aan het projectteam. */
export async function addProjectMember(organizationId: UUID, projectId: UUID, userId: UUID): Promise<ProjectMember> {
  return insertRow<ProjectMember>('project_members', organizationId, { project_id: projectId, user_id: userId });
}

/** Haal een lid van het projectteam af (de DB ruimt diens taak-toewijzingen op dit project op). */
export async function removeProjectMember(organizationId: UUID, id: UUID): Promise<void> {
  return deleteRow('project_members', id, organizationId);
}

/**
 * Zet de volledige toewijzingslijst van één taak gelijk aan `userIds`
 * (diff-based: voegt alleen ontbrekende toe en verwijdert alleen weggevallen
 * rijen, zodat bestaande rijen — en hun audit/aanmaakdatum — behouden blijven).
 */
export async function setTaskAssignees(organizationId: UUID, taskId: UUID, userIds: UUID[]): Promise<void> {
  const desired = new Set(userIds);
  const { data, error } = await supabase
    .from('task_assignees')
    .select('id,user_id')
    .eq('organization_id', organizationId)
    .eq('task_id', taskId);
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    // Ontbreekt de tabel nog (migratie niet uitgevoerd), degradeer stil.
    if (/task_assignees|schema cache|does not exist|relation/i.test(message)) {
      console.warn(`task_assignees is nog niet beschikbaar. ${PROJECT_TEAM_MIGRATION_HINT}`, error);
      return;
    }
    throw error;
  }
  const existing = (data ?? []) as { id: UUID; user_id: UUID }[];
  const existingIds = new Set(existing.map(row => row.user_id));

  const toAdd = userIds.filter(userId => !existingIds.has(userId));
  const toRemoveIds = existing.filter(row => !desired.has(row.user_id)).map(row => row.id);

  if (toRemoveIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('task_assignees')
      .delete()
      .eq('organization_id', organizationId)
      .in('id', toRemoveIds);
    if (deleteError) throw deleteError;
  }
  for (const userId of toAdd) {
    await insertRow<TaskAssignee>('task_assignees', organizationId, { task_id: taskId, user_id: userId });
  }
}

// ── Projectsjablonen ────────────────────────────────────────────────────────

const PROJECT_TEMPLATES_MIGRATION_HINT =
  'Voer de migratie 20260730000000_project_templates.sql uit in Supabase om projectsjablonen te activeren.';

/** Sjabloonkoppen (org-breed). */
export async function selectProjectTemplates(organizationId: UUID): Promise<ProjectTemplate[]> {
  return selectOptional<ProjectTemplate>('project_templates', organizationId, {
    orderBy: 'name', ascending: true, hint: PROJECT_TEMPLATES_MIGRATION_HINT,
  });
}

/** Sjabloontaken (org-breed; filter client-side op template_id). */
export async function selectProjectTemplateTasks(organizationId: UUID): Promise<ProjectTemplateTask[]> {
  return selectOptional<ProjectTemplateTask>('project_template_tasks', organizationId, {
    orderBy: 'position', ascending: true, hint: PROJECT_TEMPLATES_MIGRATION_HINT,
  });
}

export async function createProjectTemplate(organizationId: UUID, values: { name: string; description?: string | null }): Promise<ProjectTemplate> {
  return insertRow<ProjectTemplate>('project_templates', organizationId, {
    name: values.name.trim(),
    description: values.description?.trim() || null,
  });
}

export async function updateProjectTemplate(organizationId: UUID, id: UUID, patch: Partial<{ name: string; description: string | null; is_active: boolean }>): Promise<ProjectTemplate> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.is_active !== undefined) values.is_active = patch.is_active;
  return updateRow<ProjectTemplate>('project_templates', id, values, organizationId);
}

/** Verwijdert een sjabloon; de database ruimt de bijbehorende taken op (on delete cascade). */
export async function deleteProjectTemplate(organizationId: UUID, id: UUID): Promise<void> {
  return deleteRow('project_templates', id, organizationId);
}

/**
 * Zet de takenlijst van één sjabloon gelijk aan `tasks` (in die volgorde).
 * Diff-based, net als setTaskAssignees: bestaande rijen worden bijgewerkt i.p.v.
 * weggegooid en opnieuw aangemaakt, zodat id's en aanmaakdatums blijven staan.
 *
 * Geeft de opgeslagen rijen terug (mét database-id), zodat de editor zijn eigen
 * concepten kan bijwerken. Zonder dat zou een net toegevoegde taak lokaal id-loos
 * blijven en bij de volgende keer opslaan onnodig verwijderd + opnieuw aangemaakt
 * worden.
 */
export async function saveProjectTemplateTasks(organizationId: UUID, templateId: UUID, tasks: ProjectTemplateTaskInput[]): Promise<ProjectTemplateTask[]> {
  const { data, error } = await supabase
    .from('project_template_tasks')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('template_id', templateId);
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/project_template_tasks|schema cache|does not exist|relation/i.test(message)) {
      throw new Error(`Projectsjablonen zijn nog niet beschikbaar. ${PROJECT_TEMPLATES_MIGRATION_HINT}`);
    }
    throw error;
  }

  const existingIds = new Set(((data ?? []) as { id: UUID }[]).map(row => row.id));
  const keptIds = new Set(tasks.map(task => task.id).filter((id): id is UUID => Boolean(id && existingIds.has(id))));
  const removedIds = [...existingIds].filter(id => !keptIds.has(id));

  if (removedIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('project_template_tasks')
      .delete()
      .eq('organization_id', organizationId)
      .eq('template_id', templateId)
      .in('id', removedIds);
    if (deleteError) throw deleteError;
  }

  const saved: ProjectTemplateTask[] = [];
  for (const [index, task] of tasks.entries()) {
    const values = {
      template_id: templateId,
      position: index,
      title: task.title.trim(),
      description: task.description?.trim() || null,
      status: task.status,
      priority: task.priority,
      tags: task.tags,
      start_offset_days: task.start_offset_days,
      due_offset_days: task.due_offset_days,
      planned_offset_days: task.planned_offset_days,
      estimated_minutes: task.estimated_minutes,
      subtasks: task.subtasks.map(subtask => ({ id: subtask.id, label: subtask.label })),
    };
    saved.push(task.id && existingIds.has(task.id)
      ? await updateRow<ProjectTemplateTask>('project_template_tasks', task.id, values, organizationId)
      : await insertRow<ProjectTemplateTask>('project_template_tasks', organizationId, values));
  }
  return saved;
}

/**
 * Rolt een sjabloon uit op een bestaand project: maakt server-side in één
 * transactie alle sjabloontaken aan en geeft het aantal terug. `startDate` is het
 * ankerpunt voor de dagoffsets; zonder ankerpunt komen de taken datumloos binnen.
 */
export async function applyProjectTemplate(organizationId: UUID, projectId: UUID, templateId: UUID, startDate: string | null): Promise<number> {
  const { data, error } = await supabase.rpc('apply_project_template', {
    p_organization_id: organizationId,
    p_project_id: projectId,
    p_template_id: templateId,
    p_start_date: startDate || null,
  });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/apply_project_template|schema cache|does not exist|function/i.test(message)) {
      throw new Error(`Projectsjablonen zijn nog niet beschikbaar. ${PROJECT_TEMPLATES_MIGRATION_HINT}`);
    }
    throw error;
  }
  return Number(Array.isArray(data) ? data[0] : data) || 0;
}

const SAVED_REPORTS_MIGRATION_HINT =
  'Voer de migratie 20260623000000_saved_reports.sql uit in Supabase om opgeslagen rapportages te activeren.';

export async function selectSavedReports(organizationId: UUID): Promise<SavedReport[]> {
  return selectOptional<SavedReport>('saved_reports', organizationId, {
    orderBy: 'created_at', ascending: false, hint: SAVED_REPORTS_MIGRATION_HINT,
  });
}

export async function createSavedReport(organizationId: UUID, values: { name: string; definition: ReportDefinition; is_pinned?: boolean; position?: number }): Promise<SavedReport> {
  return insertRow<SavedReport>('saved_reports', organizationId, values as unknown as Record<string, unknown>);
}

// ── Actiepunten van de week (persoonlijk) ──────────────────────────────────

const PLANNER_NOTES_MIGRATION_HINT =
  'Voer de migratie 20260811000000_weekplanner_notes_and_estimates.sql uit in Supabase om de actiepunten van de weekplanner te activeren.';

/** RLS beperkt dit al tot je eigen notities; er is dus geen user-filter nodig. */
export async function selectPlannerNotes(organizationId: UUID): Promise<PlannerNote[]> {
  return selectOptional<PlannerNote>('planner_notes', organizationId, {
    orderBy: 'position', ascending: true, hint: PLANNER_NOTES_MIGRATION_HINT,
  });
}

// ── Persoonlijke dagstreep ─────────────────────────────────────────────────

const PLANNER_CAPACITY_MIGRATION_HINT =
  'Voer de migratie 20260822000000_planner_day_capacity.sql uit in Supabase om de persoonlijke dagstreep te activeren.';

/** Jouw eigen dagstreep, of null als je er (nog) geen hebt gezet. De RLS zorgt
 *  dat je hier nooit die van een ander ziet — hoeveel uur iemand op een dag
 *  kwijt wil is geen bedrijfsgegeven. */
export async function selectPlannerDayCapacity(organizationId: UUID): Promise<PlannerDayCapacity | null> {
  const rows = await selectOptional<PlannerDayCapacity>('planner_day_capacity', organizationId, {
    orderBy: 'created_at', ascending: true, hint: PLANNER_CAPACITY_MIGRATION_HINT,
  });
  return rows[0] ?? null;
}

/** Zet of wijzigt de streep. Nul minuten betekent "geen streep". */
export async function savePlannerDayCapacity(
  organizationId: UUID,
  userId: UUID,
  input: { minutes: number; include_weekend: boolean },
): Promise<PlannerDayCapacity> {
  const { data, error } = await supabase
    .from('planner_day_capacity')
    .upsert(
      { organization_id: organizationId, user_id: userId, ...input },
      { onConflict: 'organization_id,user_id' },
    )
    .select()
    .single();
  if (error) throw error;
  return data as PlannerDayCapacity;
}

/**
 * Schuift de planning van een reeks projecttaken op. Eén RPC in één transactie:
 * een lus vanuit de client die halverwege strandt laat de helft van je project
 * verzet achter.
 */
export async function shiftProjectTaskPlanning(
  organizationId: UUID,
  projectId: UUID,
  taskIds: UUID[],
  days: number,
  shiftDeadlines: boolean,
): Promise<Task[]> {
  if (taskIds.length === 0 || days === 0) return [];
  const { data, error } = await supabase.rpc('shift_project_task_planning', {
    p_organization_id: organizationId,
    p_project_id: projectId,
    p_task_ids: taskIds,
    p_days: days,
    p_shift_deadlines: shiftDeadlines,
  });
  if (error) throw error;
  return (data ?? []) as Task[];
}

export async function createPlannerNote(organizationId: UUID, userId: UUID, weekStart: string, text: string, position: number): Promise<PlannerNote> {
  return insertRow<PlannerNote>('planner_notes', organizationId, { user_id: userId, week_start: weekStart, text, position });
}

export async function updatePlannerNote(organizationId: UUID, id: UUID, changes: { text?: string; done?: boolean; position?: number }): Promise<PlannerNote> {
  return updateRow<PlannerNote>('planner_notes', id, changes, organizationId);
}

export async function deletePlannerNote(organizationId: UUID, id: UUID): Promise<void> {
  await deleteRow('planner_notes', id, organizationId);
}

export async function updateSavedReport(organizationId: UUID, id: UUID, patch: Partial<{ name: string; definition: ReportDefinition; is_pinned: boolean; position: number }>): Promise<SavedReport> {
  return updateRow<SavedReport>('saved_reports', id, patch as Record<string, unknown>, organizationId);
}

export async function deleteSavedReport(organizationId: UUID, id: UUID): Promise<void> {
  return deleteRow('saved_reports', id, organizationId);
}

export async function selectQuoteApprovalEvents(organizationId: UUID): Promise<QuoteApprovalEvent[]> {
  const { data, error } = await supabase
    .from('quote_approval_events')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/quote_approval_events|schema cache|does not exist|relation/i.test(message)) {
      console.warn('quote_approval_events is nog niet beschikbaar. Voer de migratie 20260515_quote_approval_resend_flow.sql uit om offerte-timeline te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as QuoteApprovalEvent[];
}


export async function selectQuoteVersions(organizationId: UUID): Promise<QuoteVersion[]> {
  const { data, error } = await supabase
    .from('quote_versions')
    .select('*')
    .eq('organization_id', organizationId)
    .order('version_number', { ascending: false });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/quote_versions|schema cache|does not exist|relation/i.test(message)) {
      console.warn('quote_versions is nog niet beschikbaar. Voer de migraties t/m 20260519_quote_versions_audit_context_hardening.sql uit om offerteversies te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as QuoteVersion[];
}

export async function selectQuoteEmailDeliveries(organizationId: UUID): Promise<QuoteEmailDelivery[]> {
  const { data, error } = await supabase
    .from('quote_email_deliveries')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/quote_email_deliveries|schema cache|does not exist|relation/i.test(message)) {
      console.warn('quote_email_deliveries is nog niet beschikbaar. Voer de migratie 20260515_quote_approval_resend_flow.sql uit om Resend e-mailstatus te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as QuoteEmailDelivery[];
}


export async function selectInvoiceWorkflowEvents(organizationId: UUID): Promise<InvoiceWorkflowEvent[]> {
  const { data, error } = await supabase
    .from('invoice_workflow_events')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/invoice_workflow_events|schema cache|does not exist|relation/i.test(message)) {
      console.warn('invoice_workflow_events is nog niet beschikbaar. Voer de migratie 20260526_invoice_workflow_public_payment.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as InvoiceWorkflowEvent[];
}

export async function selectInvoiceEmailDeliveries(organizationId: UUID): Promise<InvoiceEmailDelivery[]> {
  const { data, error } = await supabase
    .from('invoice_email_deliveries')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/invoice_email_deliveries|schema cache|does not exist|relation/i.test(message)) {
      console.warn('invoice_email_deliveries is nog niet beschikbaar. Voer de migratie 20260526_invoice_workflow_public_payment.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as InvoiceEmailDelivery[];
}

export async function selectInvoicePaymentRecords(organizationId: UUID): Promise<InvoicePaymentRecord[]> {
  const { data, error } = await supabase
    .from('invoice_payment_records')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/invoice_payment_records|schema cache|does not exist|relation/i.test(message)) {
      console.warn('invoice_payment_records is nog niet beschikbaar. Voer de migratie 20260526_invoice_workflow_public_payment.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as InvoicePaymentRecord[];
}

export async function selectInvoiceRefunds(organizationId: UUID): Promise<InvoiceRefund[]> {
  const { data, error } = await supabase
    .from('invoice_refunds')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/invoice_refunds|schema cache|does not exist|relation/i.test(message)) {
      console.warn('invoice_refunds is nog niet beschikbaar. Voer de migratie 20260602_invoice_refunds_credit_notes.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as InvoiceRefund[];
}

export async function selectCreditNotes(organizationId: UUID): Promise<CreditNote[]> {
  // pdf_data_base64 bewust NIET meeladen: dat blob hoort alleen bij de download.
  const { data, error } = await supabase
    .from('credit_notes')
    .select('id,organization_id,invoice_id,refund_id,number,date,reason,currency,subtotal_amount,vat_amount,total_amount,lines,status,journal_entry_id,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_storage_provider,pdf_storage_key,issued_by,created_at,updated_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/credit_notes|schema cache|does not exist|relation/i.test(message)) {
      console.warn('credit_notes is nog niet beschikbaar. Voer de migratie 20260602_invoice_refunds_credit_notes.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as CreditNote[];
}

export async function selectInvoiceChargebacks(organizationId: UUID): Promise<InvoiceChargeback[]> {
  const { data, error } = await supabase
    .from('invoice_chargebacks')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/invoice_chargebacks|schema cache|does not exist|relation/i.test(message)) {
      console.warn('invoice_chargebacks is nog niet beschikbaar. Voer de migratie 20260603_invoice_chargebacks_external_refunds.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as InvoiceChargeback[];
}

export async function selectInvoiceVersions(organizationId: UUID): Promise<InvoiceVersion[]> {
  const { data, error } = await supabase
    .from('invoice_versions')
    .select('*')
    .eq('organization_id', organizationId)
    .order('version_number', { ascending: false });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/invoice_versions|schema cache|does not exist|relation/i.test(message)) {
      console.warn('invoice_versions is nog niet beschikbaar. Voer de migratie 20260526_invoice_workflow_public_payment.sql uit.', error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as InvoiceVersion[];
}

export async function selectTicketNotes(organizationId: UUID): Promise<TicketNote[]> {
  const { data, error } = await supabase
    .from('ticket_notes')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/ticket_notes|schema cache|does not exist|relation/i.test(message)) {
      console.warn('ticket_notes is nog niet beschikbaar. Voer de migratie 20260616000001_ticket_notes_timeline.sql uit om de tickettijdlijn te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as TicketNote[];
}

/**
 * Voeg een notitie toe aan de tickettijdlijn vanuit de medewerkers-app
 * (author_type = 'user'). `isInternal` bepaalt of de notitie verborgen blijft
 * voor de klant. De auteursnaam wordt als snapshot meegegeven zodat de tijdlijn
 * leesbaar blijft, ook als het lidmaatschap later wijzigt.
 */
export async function createTicketNote(
  organizationId: UUID,
  input: { ticketId: UUID; body: string; isInternal: boolean },
): Promise<TicketNote> {
  const body = input.body.trim();
  if (!body) throw new Error('Een notitie mag niet leeg zijn.');

  const { data: userData } = await supabaseAuth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Niet ingelogd.');
  const authorName = userData.user?.email ?? null;

  const { data, error } = await supabase
    .from('ticket_notes')
    .insert({
      organization_id: organizationId,
      ticket_id: input.ticketId,
      created_by: userId,
      author_type: 'user',
      author_user_id: userId,
      author_name: authorName,
      body,
      is_internal: input.isInternal,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as TicketNote;
}

export async function setTicketNoteInternal(noteId: UUID, isInternal: boolean, organizationId: UUID): Promise<TicketNote> {
  const { data, error } = await supabase
    .from('ticket_notes')
    .update({ is_internal: isInternal })
    .eq('id', noteId)
    .eq('organization_id', organizationId)
    .select('*')
    .single();
  if (error) throw error;
  return data as TicketNote;
}

export async function deleteTicketNote(noteId: UUID, organizationId: UUID): Promise<void> {
  const { error } = await supabase
    .from('ticket_notes')
    .delete()
    .eq('id', noteId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

/** Ids van tickets met ongelezen klant-activiteit voor de huidige gebruiker. */
export async function loadTicketUnreadIds(organizationId: UUID): Promise<Set<UUID>> {
  const { data, error } = await supabase
    .from('ticket_unread')
    .select('id')
    .eq('organization_id', organizationId);
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    // Nog niet gemigreerd: geef leeg terug i.p.v. de hele app te breken.
    if (/ticket_unread|schema cache|does not exist|relation/i.test(message)) return new Set();
    throw error;
  }
  return new Set((data ?? []).map(row => (row as { id: UUID }).id));
}

/** Markeer een ticket als gelezen voor de huidige gebruiker (server-side now()). */
export async function markTicketRead(ticketId: UUID): Promise<void> {
  const { error } = await supabase.rpc('mark_ticket_read', { p_ticket_id: ticketId });
  if (error) throw error;
}

export async function selectDocuments(organizationId: UUID): Promise<InternalDocument[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/documents|schema cache|does not exist|relation/i.test(message)) {
      console.warn('documents is nog niet beschikbaar. Voer de migratie 20260604000000_internal_documents.sql uit om interne documenten te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as InternalDocument[];
}

export async function selectFolders(organizationId: UUID): Promise<ContentFolder[]> {
  const { data, error } = await supabase
    .from('content_folders')
    .select('*')
    .eq('organization_id', organizationId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/content_folders|schema cache|does not exist|relation/i.test(message)) {
      console.warn('content_folders is nog niet beschikbaar. Voer de migratie 20260616000002_content_folders.sql uit om mappen te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as ContentFolder[];
}

/**
 * Verwijdert een map inclusief alle submappen (DB-cascade via parent_id) en
 * ruimt de geüploade bestanden (attachments met entity_type 'folder') van de
 * map én submappen op in R2. Notities/documenten in deze mappen blijven bestaan:
 * hun folder_id valt terug naar null (FK on delete set null).
 */
export async function deleteContentFolder(folderId: UUID, descendantFolderIds: UUID[], organizationId: UUID): Promise<void> {
  const allIds = [folderId, ...descendantFolderIds];
  for (const id of allIds) {
    const refs = await selectAttachmentRefsForEntity('folder', id, organizationId);
    for (const att of refs) {
      await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: organizationId });
    }
  }
  await deleteRow('content_folders', folderId, organizationId);
}

export async function selectNoteCalendarLinks(organizationId: UUID): Promise<NoteCalendarLink[]> {
  const { data, error } = await supabase
    .from('note_calendar_links')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/note_calendar_links|schema cache|does not exist|relation/i.test(message)) {
      console.warn('note_calendar_links is nog niet beschikbaar. Voer de migratie 20260514_calendar_event_notes_complete.sql uit om agenda-notities te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as NoteCalendarLink[];
}

export async function selectCalendarEventLinks(organizationId: UUID): Promise<CalendarEventLink[]> {
  const { data, error } = await supabase
    .from('calendar_event_links')
    .select('*')
    .eq('organization_id', organizationId)
    .order('event_starts_at', { ascending: false });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/calendar_event_links|schema cache|does not exist|relation/i.test(message)) {
      console.warn('calendar_event_links is nog niet beschikbaar. Voer de migratie 20260617000002_calendar_event_links.sql uit om agenda-koppelingen te activeren.', error);
      return [];
    }
    throw error;
  }

  return (data ?? []) as CalendarEventLink[];
}

/**
 * Maakt of werkt de klant/project-koppeling van een agenda-item bij. De
 * koppeling wordt geïdentificeerd door provider + agenda + provider_event_id +
 * starttijd (unieke sleutel), zodat opnieuw koppelen het bestaande record
 * overschrijft in plaats van te dupliceren.
 */
export async function upsertCalendarEventLink(organizationId: UUID, input: CalendarEventLinkInput): Promise<CalendarEventLink> {
  const { data, error } = await supabase
    .from('calendar_event_links')
    .upsert({
      organization_id: organizationId,
      provider: input.provider,
      calendar_source_id: input.calendar_source_id,
      provider_calendar_id: input.provider_calendar_id ?? null,
      provider_event_id: input.provider_event_id,
      event_starts_at: input.event_starts_at,
      event_ends_at: input.event_ends_at ?? null,
      event_all_day: input.event_all_day ?? false,
      event_title_snapshot: input.event_title_snapshot ?? null,
      client_id: input.client_id,
      project_id: input.project_id,
      track_time: input.track_time ?? true,
    }, { onConflict: 'organization_id,provider,calendar_source_id,provider_event_id,event_starts_at' })
    .select('*')
    .single();
  if (error) throw error;
  return data as CalendarEventLink;
}

export async function deleteCalendarEventLink(linkId: UUID, organizationId: UUID): Promise<void> {
  const { error } = await supabase
    .from('calendar_event_links')
    .delete()
    .eq('id', linkId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

const TIME_TRACKING_MIGRATION_HINT =
  'Voer de migratie 20260629000000_time_tracking.sql uit in Supabase om de urenregistratie te activeren.';

export async function selectTimeEntries(organizationId: UUID): Promise<TimeEntry[]> {
  return selectOptional<TimeEntry>('time_entries', organizationId, {
    orderBy: 'entry_date', ascending: false, hint: TIME_TRACKING_MIGRATION_HINT,
  });
}

const DUNNING_MIGRATION_HINT =
  'Voer de migratie 20260722000000_debtor_dunning.sql uit in Supabase om de debiteurenautomaat (aanmaningen) te activeren.';

export async function selectDunningNotices(organizationId: UUID): Promise<DunningNotice[]> {
  return selectOptional<DunningNotice>('invoice_dunning_notices', organizationId, {
    orderBy: 'created_at', ascending: false, hint: DUNNING_MIGRATION_HINT,
  });
}

export interface TimeEntryInput {
  project_id: UUID | null;
  client_id: UUID | null;
  /** Optioneel: de taak waar dit uur bij hoort. De database leidt project en
   *  klant dan uit die taak af, zodat een uur nooit op een ander project landt. */
  task_id?: UUID | null;
  source?: 'manual' | 'timer';
  description?: string | null;
  entry_date: string;
  started_at?: string | null;
  ended_at?: string | null;
  minutes: number;
  billable?: boolean;
  /** Urentype voor het urencriterium; default 'direct'. */
  entry_type?: TimeEntryType;
  indirect_category?: IndirectHoursCategory | null;
  hourly_rate_cents?: number | null;
}

/** Maakt een handmatige/timer-urenpost aan, toegerekend aan de ingelogde gebruiker. */
export async function createTimeEntry(organizationId: UUID, input: TimeEntryInput): Promise<TimeEntry> {
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from('time_entries')
    .insert({
      organization_id: organizationId,
      created_by: userId,
      user_id: userId,
      project_id: input.project_id,
      client_id: input.client_id,
      source: input.source ?? 'manual',
      description: input.description ?? null,
      entry_date: input.entry_date,
      started_at: input.started_at ?? null,
      ended_at: input.ended_at ?? null,
      minutes: input.minutes,
      billable: input.billable ?? true,
      entry_type: input.entry_type ?? 'direct',
      // Categorie alleen bij indirecte uren (DB-check dwingt dit ook af).
      indirect_category: (input.entry_type ?? 'direct') === 'indirect' ? (input.indirect_category ?? null) : null,
      hourly_rate_cents: input.hourly_rate_cents ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as TimeEntry;
}

export async function updateTimeEntry(
  organizationId: UUID,
  id: UUID,
  patch: Partial<Pick<TimeEntry, 'project_id' | 'client_id' | 'description' | 'entry_date' | 'started_at' | 'ended_at' | 'minutes' | 'billable' | 'entry_type' | 'indirect_category' | 'hourly_rate_cents'>>,
): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('time_entries')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', organizationId)
    .select('*')
    .single();
  if (error) throw error;
  return data as TimeEntry;
}

export async function deleteTimeEntry(organizationId: UUID, id: UUID): Promise<void> {
  const { error } = await supabase
    .from('time_entries')
    .delete()
    .eq('id', id)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

export async function loadCompanySettings(organizationId: UUID): Promise<CompanySettings | null> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as CompanySettings | null;
}

export async function upsertCompanySettings(organizationId: UUID, values: CompanySettingsInput): Promise<CompanySettings> {
  const createdBy = await currentUserId();
  const { data, error } = await supabase
    .from('company_settings')
    .upsert({ ...sanitizeMutationValues(values as unknown as Record<string, unknown>), organization_id: organizationId, created_by: createdBy }, { onConflict: 'organization_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as CompanySettings;
}

/**
 * PostgREST kapt elk antwoord stil af op ~1000 rijen (review 3.10: onafgeletterde
 * banktransacties verdwenen uit de inbox, het Grootboek toonde onvolledige
 * boekstukken met een niet-sluitend totaal). Daarom halen alle lijst-loaders
 * hun data in pagina's van 1000 op tot een pagina niet meer vol is. De vaste
 * secundaire sortering op id houdt de paginagrenzen stabiel wanneer de primaire
 * sorteerkolom gelijke waarden heeft (created_at/date zijn niet uniek).
 */
const FETCH_PAGE_SIZE = 1000;

async function fetchAllPages<T>(
  makeQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string; details?: string } | null }> },
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += FETCH_PAGE_SIZE) {
    const { data, error } = await makeQuery().range(offset, offset + FETCH_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < FETCH_PAGE_SIZE) break;
  }
  return rows;
}

export async function select<T>(table: Table, organizationId: UUID): Promise<T[]> {
  return fetchAllPages<T>(() => supabase
    .from(table)
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true }));
}

const BOOKKEEPING_MIGRATION_HINT =
  'Voer de migratie 20260618000000_bookkeeping_ledger_core.sql uit in Supabase om de boekhoudmodule te activeren.';

const FISCAL_YEAR_MIGRATION_HINT =
  'Voer de migratie 20260706120000_bookkeeping_fiscal_year_close.sql uit in Supabase om boekjaren (afsluiten/openen) te activeren.';

const CLIENT_CONTACTS_MIGRATION_HINT =
  'Voer de migratie 20260707000000_client_contacts.sql uit in Supabase om contactpersonen per klant te activeren.';

const CLIENT_FIELD_DEFINITIONS_MIGRATION_HINT =
  'Voer de migratie 20260814000000_client_custom_fields.sql uit in Supabase om vrije klantvelden en variabelen in mailings te activeren.';

/**
 * Leest een nog-jonge tabel en degradeert gracieus: ontbreekt de tabel (migratie
 * nog niet uitgevoerd), dan een waarschuwing + lege lijst i.p.v. een harde fout.
 * Zelfde patroon als selectQuoteVersions/selectInvoiceVersions.
 */
async function selectOptional<T>(
  table: string,
  organizationId: UUID,
  opts: { orderBy: string; ascending: boolean; hint: string; eq?: Record<string, string> },
): Promise<T[]> {
  try {
    return await fetchAllPages<T>(() => {
      let query = supabase
        .from(table)
        .select('*')
        .eq('organization_id', organizationId);
      for (const [column, value] of Object.entries(opts.eq ?? {})) query = query.eq(column, value);
      return query
        .order(opts.orderBy, { ascending: opts.ascending })
        .order('id', { ascending: true });
    });
  } catch (error) {
    const err = error as { message?: string; details?: string };
    const message = `${err?.message ?? ''} ${err?.details ?? ''}`;
    if (new RegExp(`${table}|schema cache|does not exist|relation`, 'i').test(message)) {
      console.warn(`${table} is nog niet beschikbaar. ${opts.hint}`, error);
      return [];
    }
    throw error;
  }
}

export const selectClientContacts = (organizationId: UUID) =>
  selectOptional<ClientContact>('client_contacts', organizationId, { orderBy: 'name', ascending: true, hint: CLIENT_CONTACTS_MIGRATION_HINT });
export const selectClientFieldDefinitions = (organizationId: UUID) =>
  selectOptional<ClientFieldDefinition>('client_field_definitions', organizationId, { orderBy: 'position', ascending: true, hint: CLIENT_FIELD_DEFINITIONS_MIGRATION_HINT });
export const selectLedgerAccounts = (organizationId: UUID) =>
  selectOptional<LedgerAccount>('ledger_accounts', organizationId, { orderBy: 'code', ascending: true, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectVatCodes = (organizationId: UUID) =>
  selectOptional<VatCode>('vat_codes', organizationId, { orderBy: 'code', ascending: true, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectJournalEntries = (organizationId: UUID) =>
  selectOptional<JournalEntry>('journal_entries', organizationId, { orderBy: 'date', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectJournalLines = (organizationId: UUID) =>
  selectOptional<JournalLine>('journal_lines', organizationId, { orderBy: 'created_at', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectClosedPeriods = (organizationId: UUID) =>
  selectOptional<ClosedPeriod>('closed_periods', organizationId, { orderBy: 'closed_at', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectSuppliers = (organizationId: UUID) =>
  selectOptional<Supplier>('suppliers', organizationId, { orderBy: 'name', ascending: true, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectPurchaseInvoices = (organizationId: UUID) =>
  selectOptional<PurchaseInvoice>('purchase_invoices', organizationId, { orderBy: 'date', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectFixedAssets = (organizationId: UUID) =>
  selectOptional<FixedAsset>('fixed_assets', organizationId, { orderBy: 'acquisition_date', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectAssetDepreciations = (organizationId: UUID) =>
  selectOptional<AssetDepreciation>('asset_depreciations', organizationId, { orderBy: 'date', ascending: true, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectVatReturns = (organizationId: UUID) =>
  selectOptional<VatReturn>('vat_returns', organizationId, { orderBy: 'period_start', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT });
export const selectFiscalYears = (organizationId: UUID) =>
  selectOptional<FiscalYear>('fiscal_years', organizationId, { orderBy: 'period_start', ascending: false, hint: FISCAL_YEAR_MIGRATION_HINT });

const BANKFEED_MIGRATION_HINT =
  'Voer de migratie 20260622000004_bankfeed_core.sql uit in Supabase om de bankkoppeling te activeren.';

export const selectBankAccounts = (organizationId: UUID) =>
  selectOptional<BankAccount>('bank_accounts', organizationId, { orderBy: 'name', ascending: true, hint: BANKFEED_MIGRATION_HINT });
export const selectBankStatements = (organizationId: UUID) =>
  selectOptional<BankStatement>('bank_statements', organizationId, { orderBy: 'imported_at', ascending: false, hint: BANKFEED_MIGRATION_HINT });
export const selectBankTransactions = (organizationId: UUID) =>
  selectOptional<BankTransaction>('bank_transactions', organizationId, { orderBy: 'booking_date', ascending: false, hint: BANKFEED_MIGRATION_HINT });
export const selectBankRules = (organizationId: UUID) =>
  selectOptional<BankRule>('bank_rules', organizationId, { orderBy: 'priority', ascending: true, hint: BANKFEED_MIGRATION_HINT });
export const selectBankRequisitions = (organizationId: UUID) =>
  selectOptional<BankRequisition>('bank_requisitions', organizationId, { orderBy: 'created_at', ascending: false, hint: BANKFEED_MIGRATION_HINT });

/**
 * Directe PSD2-koppeling (Enable Banking) — alles loopt via de `bank-sync` Edge
 * Function zodat de private sleutel nooit in de browser staat. De functie signeert
 * zelf een JWT, praat met de provider en schrijft via de service-role naar de database.
 */
async function invokeBankSync<T>(action: string, organizationId: UUID, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('bank-sync', {
    body: { action, organizationId, ...payload },
  });
  if (error) await throwFunctionError(error, 'Bankkoppeling mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Bankkoppeling mislukt.');
  return data as T;
}

/** Lijst van banken (instituten) voor de bankkiezer. */
export async function listBankInstitutions(organizationId: UUID, country?: string): Promise<BankInstitution[]> {
  const data = await invokeBankSync<{ institutions: BankInstitution[] }>('listInstitutions', organizationId, { country });
  return data.institutions ?? [];
}

/** Start een koppeling: maakt een requisition en geeft de consent-link terug. */
export async function createBankRequisition(
  organizationId: UUID,
  input: { institutionId: string; institutionName?: string; redirectUrl: string },
): Promise<{ link: string; reference: string }> {
  return invokeBankSync('createRequisition', organizationId, {
    institutionId: input.institutionId,
    institutionName: input.institutionName ?? null,
    redirectUrl: input.redirectUrl,
  });
}

/**
 * Rondt de koppeling af na de redirect: wisselt de autorisatiecode in, koppelt de
 * rekeningen en synchroniseert. `state` is onze referentie (de bank geeft hem samen
 * met `code` terug op de redirect); daaruit leidt de server de organisatie af.
 */
export async function finalizeBankRequisition(organizationId: UUID, input: { code: string; state: string }): Promise<{ status: string; linked: number; imported: number }> {
  return invokeBankSync('finalizeRequisition', organizationId, { code: input.code, state: input.state });
}

/** Haalt nieuwe transacties op voor één of alle gekoppelde rekeningen. */
export async function syncBankAccount(organizationId: UUID, bankAccountId?: UUID): Promise<{ results: Array<{ bankAccountId: string; inserted: number; skipped: number; error?: string }>; needsReconsent: boolean }> {
  return invokeBankSync('sync', organizationId, { bankAccountId: bankAccountId ?? null });
}

/**
 * Leest een afschrift in: voegt nieuwe transacties idempotent toe (de dedup-sleutel
 * wordt server-side uit de inhoud afgeleid) en stelt direct matches/voorstellen voor.
 * `balanceOk` zegt of beginsaldo + de regels van dit afschrift het eindsaldo geven;
 * null als het afschrift geen saldi meelevert (CSV, PSD2-sync).
 */
export async function importBankTransactions(
  organizationId: UUID,
  bankAccountId: UUID,
  statement: ParsedBankStatement,
): Promise<{
  inserted: number; skipped: number; statement_id: UUID | null;
  duplicates: number; skippedNoDate: number; skippedZeroAmount: number;
  balanceOk: boolean | null; balanceDifferenceCents: number | null;
}> {
  const { transactions, warnings: _warnings, ...meta } = statement;
  const { data, error } = await supabase.rpc('import_bank_transactions', {
    p_organization_id: organizationId,
    p_bank_account_id: bankAccountId,
    p_statement: meta,
    p_transactions: transactions,
  });
  if (error) throw bookkeepingError(error);
  const row = (data ?? {}) as {
    inserted?: number; skipped?: number; statement_id?: UUID | null;
    duplicates?: number; skipped_no_date?: number; skipped_zero_amount?: number;
    balance_ok?: boolean | null; balance_difference_cents?: number | null;
  };
  return {
    inserted: row.inserted ?? 0,
    skipped: row.skipped ?? 0,
    statement_id: row.statement_id ?? null,
    duplicates: row.duplicates ?? row.skipped ?? 0,
    skippedNoDate: row.skipped_no_date ?? 0,
    skippedZeroAmount: row.skipped_zero_amount ?? 0,
    balanceOk: row.balance_ok ?? null,
    balanceDifferenceCents: row.balance_difference_cents ?? null,
  };
}

/**
 * Sluit de bank aan op het grootboek: per bankrekening het eindsaldo van het
 * laatste afschrift naast de grootboekstand (plus wat nog niet geboekt is).
 * Server-side omdat de journaalregels ver boven de PostgREST-rijlimiet uitkomen.
 */
export async function selectBankReconciliation(organizationId: UUID): Promise<BankReconciliation[]> {
  const { data, error } = await supabase.rpc('report_bank_reconciliation', {
    p_organization_id: organizationId,
  });
  if (error) {
    // De RPC komt uit migratie 20260721010000; vóór het toepassen daarvan tonen
    // we gewoon geen aansluiting in plaats van de hele Bankpagina te breken.
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/report_bank_reconciliation|schema cache|does not exist|function/i.test(message)) {
      console.warn('report_bank_reconciliation is nog niet beschikbaar.', error);
      return [];
    }
    throw bookkeepingError(error);
  }
  return (data ?? []) as BankReconciliation[];
}

/** Stelt opnieuw matches/voorstellen voor over de openstaande transacties. */
export async function matchBankTransactions(
  organizationId: UUID,
  bankAccountId?: UUID | null,
): Promise<{ suggested: number; auto_booked: number }> {
  const { data, error } = await supabase.rpc('match_bank_transactions', {
    p_organization_id: organizationId,
    p_bank_account_id: bankAccountId ?? null,
  });
  if (error) throw bookkeepingError(error);
  const row = (data ?? {}) as { suggested?: number; auto_booked?: number };
  return { suggested: row.suggested ?? 0, auto_booked: row.auto_booked ?? 0 };
}

/**
 * Boekt een banktransactie naar het grootboek. Geef óf een af te letteren factuur
 * (matchedInvoiceId / matchedPurchaseInvoiceId) óf vrije regels (lines: bruto
 * bedrag + BTW-code per grootboekrekening).
 */
export async function bookBankTransaction(
  organizationId: UUID,
  transactionId: UUID,
  options: {
    lines?: Array<Record<string, unknown>>;
    matchedInvoiceId?: UUID | null;
    matchedPurchaseInvoiceId?: UUID | null;
  } = {},
): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('book_bank_transaction', {
    p_organization_id: organizationId,
    p_transaction_id: transactionId,
    p_lines: options.lines ?? null,
    p_matched_invoice_id: options.matchedInvoiceId ?? null,
    p_matched_purchase_invoice_id: options.matchedPurchaseInvoiceId ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Draait een geboekte banktransactie terug (tegenboeking) en zet hem weer open. */
export async function unbookBankTransaction(organizationId: UUID, transactionId: UUID): Promise<BankTransaction> {
  const { data, error } = await supabase.rpc('unbook_bank_transaction', {
    p_organization_id: organizationId,
    p_transaction_id: transactionId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as BankTransaction;
}

/** Negeert een transactie ('ignored') of zet hem weer open ('unmatched'). */
export async function setBankTransactionStatus(
  organizationId: UUID,
  transactionId: UUID,
  status: 'unmatched' | 'ignored',
): Promise<BankTransaction> {
  const { data, error } = await supabase.rpc('set_bank_transaction_status', {
    p_organization_id: organizationId,
    p_transaction_id: transactionId,
    p_status: status,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as BankTransaction;
}

/** Berekent de BTW-rubrieken over een periode (alleen geboekte journaalposten). */
export async function computeVatReturn(organizationId: UUID, from: string, to: string): Promise<VatReturnRubrieken> {
  const { data, error } = await supabase.rpc('compute_vat_return', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? {}) as VatReturnRubrieken;
}

/** Maakt de aangifte definitief: boekt door naar 1530 en vergrendelt de periode. */
export async function finalizeVatReturn(
  organizationId: UUID,
  input: { periodType: 'month' | 'quarter'; year: number; periodIndex: number; from: string; to: string },
): Promise<VatReturn> {
  const { data, error } = await supabase.rpc('finalize_vat_return', {
    p_organization_id: organizationId,
    p_period_type: input.periodType,
    p_year: input.year,
    p_period_index: input.periodIndex,
    p_from: input.from,
    p_to: input.to,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as VatReturn;
}

/**
 * Sluit een OB-periode af: de gebruiker bevestigt de aangifte zelf bij de
 * Belastingdienst te hebben ingediend, waarna in één transactie wordt
 * doorgeboekt naar 1530, de periode wordt vergrendeld en de aangifte op 'filed'
 * komt (met wie/wanneer als audit-spoor via filed_at/filed_by).
 */
export async function closeVatPeriod(
  organizationId: UUID,
  input: { periodType: 'month' | 'quarter'; year: number; periodIndex: number; from: string; to: string },
): Promise<VatReturn> {
  const { data, error } = await supabase.rpc('close_vat_period', {
    p_organization_id: organizationId,
    p_period_type: input.periodType,
    p_year: input.year,
    p_period_index: input.periodIndex,
    p_from: input.from,
    p_to: input.to,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as VatReturn;
}

/** Lijst met boekjaren + server-side (her)berekend resultaat per boekjaar. */
export async function listFiscalYears(organizationId: UUID): Promise<FiscalYearListRow[]> {
  const { data, error } = await supabase.rpc('list_fiscal_years', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as FiscalYearListRow[];
}

/** Opent een nieuw boekjaar (mag ook vóór het oude is afgesloten). */
export async function openFiscalYear(
  organizationId: UUID,
  input: { periodStart: string; periodEnd: string; label?: string | null },
): Promise<FiscalYear> {
  const { data, error } = await supabase.rpc('open_fiscal_year', {
    p_organization_id: organizationId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_label: input.label ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FiscalYear;
}

/** Sluit een boekjaar af: boekt het resultaat naar eigen vermogen en vergrendelt het jaar. */
export async function closeFiscalYear(organizationId: UUID, fiscalYearId: UUID): Promise<FiscalYear> {
  const { data, error } = await supabase.rpc('close_fiscal_year', {
    p_organization_id: organizationId,
    p_fiscal_year_id: fiscalYearId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FiscalYear;
}

/** Heropent een afgesloten boekjaar (alleen eigenaar/admin). */
export async function reopenFiscalYear(organizationId: UUID, fiscalYearId: UUID): Promise<FiscalYear> {
  const { data, error } = await supabase.rpc('reopen_fiscal_year', {
    p_organization_id: organizationId,
    p_fiscal_year_id: fiscalYearId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FiscalYear;
}

// ── DGA: rekening-courant en gebruikelijk loon ─────────────────────────────

export async function loadDgaSignals(organizationId: UUID, year: number): Promise<DgaSignals> {
  const { data, error } = await supabase.rpc('dga_signals', { p_organization_id: organizationId, p_year: year });
  if (error) throw bookkeepingError(error);
  return data as DgaSignals;
}

export async function computeDgaInterest(organizationId: UUID, year: number): Promise<DgaInterestComputation> {
  const { data, error } = await supabase.rpc('compute_dga_interest', { p_organization_id: organizationId, p_year: year });
  if (error) throw bookkeepingError(error);
  return data as DgaInterestComputation;
}

export async function listDgaInterestRates(organizationId: UUID): Promise<DgaInterestRate[]> {
  const { data, error } = await supabase
    .from('dga_interest_rates').select('*')
    .eq('organization_id', organizationId)
    .order('valid_from', { ascending: false });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as DgaInterestRate[];
}

/** Het percentage is een bewuste invoer van de gebruiker; ResoFly kent geen standaard. */
export async function addDgaInterestRate(
  organizationId: UUID,
  input: { validFrom: string; rateBasisPoints: number; basisNote?: string | null },
): Promise<void> {
  const { error } = await supabase.from('dga_interest_rates').insert({
    organization_id: organizationId,
    valid_from: input.validFrom,
    rate_basis_points: input.rateBasisPoints,
    basis_note: input.basisNote ?? null,
  });
  if (error) throw bookkeepingError(error);
}

export async function deleteDgaInterestRate(organizationId: UUID, id: UUID): Promise<void> {
  const { error } = await supabase.from('dga_interest_rates').delete()
    .eq('id', id).eq('organization_id', organizationId);
  if (error) throw bookkeepingError(error);
}

export async function listDgaInterestPostings(organizationId: UUID): Promise<DgaInterestPosting[]> {
  const { data, error } = await supabase
    .from('dga_interest_postings').select('*')
    .eq('organization_id', organizationId)
    .order('year', { ascending: false });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as DgaInterestPosting[];
}

export async function bookDgaInterest(organizationId: UUID, year: number): Promise<DgaInterestPosting> {
  const { data, error } = await supabase.rpc('book_dga_interest', { p_organization_id: organizationId, p_year: year });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as DgaInterestPosting;
}

export async function reverseDgaInterest(organizationId: UUID, postingId: UUID): Promise<DgaInterestPosting> {
  const { data, error } = await supabase.rpc('reverse_dga_interest', { p_organization_id: organizationId, p_posting_id: postingId });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as DgaInterestPosting;
}

/**
 * De loonjournaalpost van de salarisverwerker als één boekstuk innemen. ResoFly
 * rekent niets na — wij kennen de loonheffingstabellen niet — maar controleert
 * wel dat de post exact sluit en dat elke rekening bestaat.
 */
export async function postPayrollJournal(
  organizationId: UUID,
  input: { date: string; description: string; lines: Array<{ accountCode: string; description: string; debitCents: number; creditCents: number }> },
): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('post_payroll_journal', {
    p_organization_id: organizationId,
    p_date: input.date,
    p_description: input.description,
    p_lines: input.lines.map(l => ({
      account_code: l.accountCode,
      description: l.description,
      debit_cents: l.debitCents,
      credit_cents: l.creditCents,
    })),
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

// ── Vennootschapsbelasting ─────────────────────────────────────────────────
// De berekening loopt via de edge function (corporateTaxService); dit zijn de
// gewone lees- en schrijfacties eromheen.

export async function listCorporateTaxReturns(organizationId: UUID): Promise<CorporateTaxReturn[]> {
  const { data, error } = await supabase
    .from('corporate_tax_returns')
    .select('*')
    .eq('organization_id', organizationId)
    .order('year', { ascending: false });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as CorporateTaxReturn[];
}

export async function listCorporateTaxCorrections(organizationId: UUID, fiscalYearId: UUID): Promise<CorporateTaxCorrectionRow[]> {
  const { data, error } = await supabase
    .from('corporate_tax_corrections')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('fiscal_year_id', fiscalYearId)
    .order('created_at', { ascending: true });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as CorporateTaxCorrectionRow[];
}

export async function addCorporateTaxCorrection(
  organizationId: UUID,
  input: { fiscalYearId: UUID; code: string; label: string; amountCents: number; note?: string | null },
): Promise<void> {
  const { error } = await supabase.from('corporate_tax_corrections').insert({
    organization_id: organizationId,
    fiscal_year_id: input.fiscalYearId,
    code: input.code,
    label: input.label,
    amount_cents: input.amountCents,
    note: input.note ?? null,
  });
  if (error) throw bookkeepingError(error);
}

export async function deleteCorporateTaxCorrection(organizationId: UUID, id: UUID): Promise<void> {
  const { error } = await supabase
    .from('corporate_tax_corrections')
    .delete()
    .eq('id', id)
    .eq('organization_id', organizationId);
  if (error) throw bookkeepingError(error);
}

/** Draait een vastgestelde Vpb-berekening terug (alleen eigenaar/admin). */
export async function reverseCorporateTaxReturn(organizationId: UUID, returnId: UUID): Promise<CorporateTaxReturn> {
  const { data, error } = await supabase.rpc('reverse_corporate_tax_return', {
    p_organization_id: organizationId,
    p_return_id: returnId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as CorporateTaxReturn;
}

/**
 * Op welke rekening de sluitpost van de beginbalans landt. Hangt aan de
 * rechtsvorm: bij een BV gaat meegebracht vermogen naar de reserves en niet naar
 * het gestorte aandelenkapitaal.
 */
export async function openingBalancePlugAccount(organizationId: UUID): Promise<{ code: string; name: string } | null> {
  const { data, error } = await supabase.rpc('opening_balance_plug_account', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as { code: string; name: string } | null;
}

/** Besluiten van de algemene vergadering over de bestemming van het resultaat. */
export async function listResultAppropriations(organizationId: UUID): Promise<ResultAppropriationRow[]> {
  const { data, error } = await supabase.rpc('list_result_appropriations', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as ResultAppropriationRow[];
}

/**
 * Legt het besluit van de algemene vergadering vast en boekt het: van de
 * resultaatrekening naar de overige reserves en/of een dividendschuld.
 * `boardApproved` is de bestuursgoedkeuring van de uitkeringstest
 * (art. 2:216 lid 2 BW) en is verplicht zodra er dividend wordt uitgekeerd.
 */
export async function appropriateResult(
  organizationId: UUID,
  input: {
    fiscalYearId: UUID;
    decisionDate: string;
    reservesCents: number;
    dividendCents?: number;
    boardApproved?: boolean;
    reservesAccountCode?: string;
    dividendAccountCode?: string;
    note?: string | null;
  },
): Promise<ResultAppropriation> {
  const { data, error } = await supabase.rpc('appropriate_result', {
    p_organization_id: organizationId,
    p_fiscal_year_id: input.fiscalYearId,
    p_decision_date: input.decisionDate,
    p_reserves_cents: input.reservesCents,
    p_dividend_cents: input.dividendCents ?? 0,
    p_board_approved: input.boardApproved ?? false,
    p_reserves_account_code: input.reservesAccountCode ?? '0520',
    p_dividend_account_code: input.dividendAccountCode ?? '1580',
    p_note: input.note ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as ResultAppropriation;
}

/**
 * Draait een resultaatbestemming terug (alleen eigenaar/admin): het boekstuk
 * gaat op 'reversed' en telt daarmee nergens meer mee, net zoals bij het
 * heropenen van een boekjaar. Geen spiegelpost — die zou op een datum vallen
 * die inmiddels in een afgesloten aangifteperiode kan liggen.
 */
export async function reverseResultAppropriation(
  organizationId: UUID,
  appropriationId: UUID,
): Promise<ResultAppropriation> {
  const { data, error } = await supabase.rpc('reverse_result_appropriation', {
    p_organization_id: organizationId,
    p_appropriation_id: appropriationId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as ResultAppropriation;
}

// ── Aandeelhouders en dividend ─────────────────────────────────────────────
// Het register van art. 2:194 BW is een gewone tabel: lezen en schrijven via
// RLS. De uitkeringen niet — daar zitten de balanstest, de inhouding en twee
// boekstukken aan vast, dus die lopen over RPC's.

export async function listShareholders(organizationId: UUID): Promise<Shareholder[]> {
  const { data, error } = await supabase
    .from('shareholders').select('*')
    .eq('organization_id', organizationId)
    .order('name', { ascending: true });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as Shareholder[];
}

export type ShareholderInput = {
  name: string;
  kind: Shareholder['kind'];
  addressLine?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string;
  email?: string | null;
  isDga?: boolean;
  withholdingExempt?: boolean;
  withholdingExemptNote?: string | null;
  note?: string | null;
};

function shareholderPayload(input: ShareholderInput) {
  return {
    name: input.name.trim(),
    kind: input.kind,
    address_line: input.addressLine?.trim() || null,
    postal_code: input.postalCode?.trim() || null,
    city: input.city?.trim() || null,
    country_code: (input.countryCode || 'NL').trim().toUpperCase(),
    email: input.email?.trim() || null,
    is_dga: input.isDga ?? false,
    withholding_exempt: input.withholdingExempt ?? false,
    withholding_exempt_note: input.withholdingExemptNote?.trim() || null,
    note: input.note?.trim() || null,
  };
}

export async function createShareholder(organizationId: UUID, input: ShareholderInput): Promise<Shareholder> {
  const { data, error } = await supabase
    .from('shareholders')
    .insert({ organization_id: organizationId, ...shareholderPayload(input) })
    .select('*').single();
  if (error) throw bookkeepingError(error);
  return data as Shareholder;
}

export async function updateShareholder(organizationId: UUID, id: UUID, input: ShareholderInput): Promise<void> {
  const { error } = await supabase
    .from('shareholders').update(shareholderPayload(input))
    .eq('id', id).eq('organization_id', organizationId);
  if (error) throw bookkeepingError(error);
}

/**
 * Verwijderen kan alleen zolang er niets aan hangt: de mutaties en de
 * dividendregels verwijzen met `on delete restrict`, want een aandeelhouder
 * wissen zou het register en de onderbouwing van een uitkering laten verdampen.
 */
export async function deleteShareholder(organizationId: UUID, id: UUID): Promise<void> {
  const { error } = await supabase
    .from('shareholders').delete()
    .eq('id', id).eq('organization_id', organizationId);
  if (error) throw bookkeepingError(error);
}

export async function listShareTransactions(organizationId: UUID): Promise<ShareTransaction[]> {
  const { data, error } = await supabase
    .from('share_transactions').select('*')
    .eq('organization_id', organizationId)
    .order('event_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as ShareTransaction[];
}

export async function addShareTransaction(
  organizationId: UUID,
  input: {
    kind: ShareTransaction['kind'];
    eventDate: string;
    acknowledgedOn?: string | null;
    shareClass: string;
    quantity: number;
    nominalValueCents: number;
    paidUpCents: number;
    fromShareholderId?: UUID | null;
    toShareholderId?: UUID | null;
    deedReference?: string | null;
    note?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from('share_transactions').insert({
    organization_id: organizationId,
    kind: input.kind,
    event_date: input.eventDate,
    acknowledged_on: input.acknowledgedOn || null,
    share_class: input.shareClass.trim() || 'gewoon',
    quantity: input.quantity,
    nominal_value_cents: input.nominalValueCents,
    paid_up_cents: input.paidUpCents,
    from_shareholder_id: input.fromShareholderId ?? null,
    to_shareholder_id: input.toShareholderId ?? null,
    deed_reference: input.deedReference?.trim() || null,
    note: input.note?.trim() || null,
  });
  if (error) throw bookkeepingError(error);
}

export async function deleteShareTransaction(organizationId: UUID, id: UUID): Promise<void> {
  const { error } = await supabase
    .from('share_transactions').delete()
    .eq('id', id).eq('organization_id', organizationId);
  if (error) throw bookkeepingError(error);
}

/** De stand van het register op een peildatum, met het belang in basispunten. */
export async function loadShareholderPositions(organizationId: UUID, asOf: string): Promise<ShareholderPosition[]> {
  const { data, error } = await supabase.rpc('shareholder_positions', {
    p_organization_id: organizationId,
    p_as_of: asOf,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as ShareholderPosition[];
}

export async function listShareEncumbrances(organizationId: UUID): Promise<ShareEncumbrance[]> {
  const { data, error } = await supabase
    .from('share_encumbrances').select('*')
    .eq('organization_id', organizationId)
    .order('established_on', { ascending: false });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as ShareEncumbrance[];
}

export async function addShareEncumbrance(
  organizationId: UUID,
  input: {
    shareholderId: UUID;
    kind: ShareEncumbrance['kind'];
    holderName: string;
    holderAddress?: string | null;
    shareClass: string;
    quantity: number;
    establishedOn: string;
    acknowledgedOn?: string | null;
    endedOn?: string | null;
    hasVotingRights?: boolean;
    hasDividendRights?: boolean;
    note?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from('share_encumbrances').insert({
    organization_id: organizationId,
    shareholder_id: input.shareholderId,
    kind: input.kind,
    holder_name: input.holderName.trim(),
    holder_address: input.holderAddress?.trim() || null,
    share_class: input.shareClass.trim() || 'gewoon',
    quantity: input.quantity,
    established_on: input.establishedOn,
    acknowledged_on: input.acknowledgedOn || null,
    ended_on: input.endedOn || null,
    has_voting_rights: input.hasVotingRights ?? false,
    has_dividend_rights: input.hasDividendRights ?? false,
    note: input.note?.trim() || null,
  });
  if (error) throw bookkeepingError(error);
}

export async function deleteShareEncumbrance(organizationId: UUID, id: UUID): Promise<void> {
  const { error } = await supabase
    .from('share_encumbrances').delete()
    .eq('id', id).eq('organization_id', organizationId);
  if (error) throw bookkeepingError(error);
}

/**
 * Het tarief dividendbelasting dat op een datum gold (art. 5 Wet DB 1965).
 * Alleen om de gebruiker vooraf te laten zien wat er wordt ingehouden; de RPC
 * zoekt het bij het boeken zelf opnieuw op.
 */
export async function dividendTaxRateOn(onDate: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('dividend_tax_rate_on', { p_date: onDate });
  if (error) throw bookkeepingError(error);
  return (data ?? null) as number | null;
}

export async function listDividendDistributions(organizationId: UUID): Promise<DividendDistributionRow[]> {
  const { data, error } = await supabase.rpc('list_dividend_distributions', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as DividendDistributionRow[];
}

/** De regels van één uitkering: onderbouwing van de aangifte en de dividendnota. */
export async function loadDividendDistributionLines(
  organizationId: UUID,
  distributionId: UUID,
): Promise<DividendDistributionLine[]> {
  const { data, error } = await supabase.rpc('dividend_distribution_detail', {
    p_organization_id: organizationId,
    p_distribution_id: distributionId,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as DividendDistributionLine[];
}

/**
 * Legt een dividendbesluit vast, houdt de dividendbelasting in en boekt beide.
 * Het bruto bedrag volgt uit de regels; per aandeelhouder wordt ingehouden
 * tenzij de inhoudingsvrijstelling op hem van toepassing is (art. 4 Wet DB
 * 1965). Bij `interim` toetst de RPC de balanstest en eist hij de
 * bestuursgoedkeuring; bij `final` gebeurde dat al bij de resultaatbestemming.
 */
export async function declareDividend(
  organizationId: UUID,
  input: {
    kind: DividendKind;
    decisionDate: string;
    availableDate: string;
    lines: Array<{ shareholderId: UUID; grossCents: number }>;
    resultAppropriationId?: UUID | null;
    boardApproved?: boolean;
    sourceAccountCode?: string;
    note?: string | null;
  },
): Promise<{ id: UUID }> {
  const { data, error } = await supabase.rpc('declare_dividend', {
    p_organization_id: organizationId,
    p_kind: input.kind,
    p_decision_date: input.decisionDate,
    p_available_date: input.availableDate,
    p_lines: input.lines.map(l => ({ shareholder_id: l.shareholderId, gross_cents: l.grossCents })),
    p_result_appropriation_id: input.resultAppropriationId ?? null,
    p_board_approved: input.boardApproved ?? false,
    p_source_account_code: input.sourceAccountCode ?? '0520',
    p_note: input.note ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as { id: UUID };
}

/** Draait een uitkering terug (alleen eigenaar/admin): beide boekstukken op 'reversed'. */
export async function reverseDividendDistribution(organizationId: UUID, distributionId: UUID): Promise<void> {
  const { error } = await supabase.rpc('reverse_dividend_distribution', {
    p_organization_id: organizationId,
    p_distribution_id: distributionId,
  });
  if (error) throw bookkeepingError(error);
}

// ── Jaarrekening en groottecriteria (fase 5) ───────────────────────────────
// De PDF's lopen via de edge function (annualAccountsService); dit zijn de
// lees- en schrijfacties op de database. Alle mutaties gaan via SECURITY
// DEFINER-RPC's: de tabellen zelf zijn alleen leesbaar.

/**
 * De gegevens die de groottetoets niet uit het grootboek kan halen. Null als
 * er voor dit boekjaar nog niets is vastgelegd — dan geeft
 * determine_company_size een blokkerende reden in plaats van een klasse.
 */
export async function loadFiscalYearSizeInputs(
  organizationId: UUID,
  fiscalYearId: UUID,
): Promise<FiscalYearSizeInputs | null> {
  const { data, error } = await supabase
    .from('fiscal_year_size_inputs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('fiscal_year_id', fiscalYearId)
    .maybeSingle();
  if (error) throw bookkeepingError(error);
  return (data ?? null) as FiscalYearSizeInputs | null;
}

/**
 * Legt het gemiddeld aantal werknemers en de overige groottegegevens vast
 * (art. 2:395a/396/397 lid 1 BW). `isFirstFiscalYearOfEntity` en
 * `openingSizeClass` zijn het startpunt van de plakkerige tweejaarstoets:
 * zonder een van beide draagt de keten niet.
 */
export async function saveFiscalYearSizeInputs(
  organizationId: UUID,
  input: {
    fiscalYearId: UUID;
    averageEmployees: number;
    totalAssetsCents?: number | null;
    netTurnoverCents?: number | null;
    overrideReason?: string | null;
    earlyAdoptNewThresholds?: boolean;
    consolidatingParentName?: string | null;
    consolidatingParentCity?: string | null;
    note?: string | null;
    isFirstFiscalYearOfEntity?: boolean;
    openingSizeClass?: SizeClass | null;
  },
): Promise<FiscalYearSizeInputs> {
  const { data, error } = await supabase.rpc('save_fiscal_year_size_inputs', {
    p_organization_id: organizationId,
    p_fiscal_year_id: input.fiscalYearId,
    p_average_employees: input.averageEmployees,
    p_total_assets_cents: input.totalAssetsCents ?? null,
    p_net_turnover_cents: input.netTurnoverCents ?? null,
    p_override_reason: input.overrideReason ?? null,
    p_early_adopt_new_thresholds: input.earlyAdoptNewThresholds ?? false,
    p_consolidating_parent_name: input.consolidatingParentName ?? null,
    p_consolidating_parent_city: input.consolidatingParentCity ?? null,
    p_note: input.note ?? null,
    p_is_first_fiscal_year_of_entity: input.isFirstFiscalYearOfEntity ?? false,
    p_opening_size_class: input.openingSizeClass ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FiscalYearSizeInputs;
}

/**
 * De grootteklasse van een boekjaar met haar volledige onderbouwing. De
 * tweejaarstoets is plakkerig: de klasse blijft staan tot de rechtspersoon er
 * twee opeenvolgende balansdata niet meer in valt.
 */
export async function determineCompanySize(
  organizationId: UUID,
  fiscalYearId: UUID,
): Promise<CompanySizeResult> {
  const { data, error } = await supabase.rpc('determine_company_size', {
    p_organization_id: organizationId,
    p_fiscal_year_id: fiscalYearId,
  });
  if (error) throw bookkeepingError(error);
  return data as CompanySizeResult;
}

/**
 * De cijfers zoals ze bij het opmaken bevroren zouden worden — het concept.
 * Exact hetzelfde beeld als de jaarrekening, alleen ongehashed en niet
 * vastgelegd.
 */
export async function buildAnnualAccountsSnapshot(
  organizationId: UUID,
  fiscalYearId: UUID,
): Promise<AnnualAccountSnapshot> {
  const { data, error } = await supabase.rpc('build_annual_accounts_snapshot', {
    p_organization_id: organizationId,
    p_fiscal_year_id: fiscalYearId,
  });
  if (error) throw bookkeepingError(error);
  return data as AnnualAccountSnapshot;
}

export async function listAnnualAccounts(organizationId: UUID): Promise<AnnualAccountListRow[]> {
  const { data, error } = await supabase.rpc('list_annual_accounts', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as AnnualAccountListRow[];
}

/** Eén jaarrekening met haar bevroren snapshot, ondertekenaars en termijnen. */
export async function getAnnualAccount(organizationId: UUID, annualAccountId: UUID): Promise<AnnualAccount> {
  const { data, error } = await supabase.rpc('get_annual_account', {
    p_organization_id: organizationId,
    p_annual_account_id: annualAccountId,
  });
  if (error) throw bookkeepingError(error);
  return data as AnnualAccount;
}

/**
 * Maakt de jaarrekening op (art. 2:210 lid 1 BW): bevriest de cijfers met een
 * sha256-hash en klinkt de opmaaktermijn van vijf maanden vast. Ligt er voor
 * dit boekjaar al een gedeponeerde jaarrekening, dan zijn
 * `supersedesAnnualAccountId` en `supersedeReason` verplicht — die deponering
 * blijft immers staan (art. 2:394 BW).
 */
export async function prepareAnnualAccounts(
  organizationId: UUID,
  input: {
    fiscalYearId: UUID;
    preparedOn: string;
    accountingBasis?: AccountingBasis;
    signatories: Array<{ name: string; role: AnnualAccountSignatureRole; shareholderId?: UUID | null }>;
    offBalanceCommitments?: string | null;
    policyChangeNote?: string | null;
    sizeClassOverride?: SizeClass | null;
    sizeOverrideReason?: string | null;
    note?: string | null;
    allShareholdersAreDirectors?: boolean;
    supersedesAnnualAccountId?: UUID | null;
    supersedeReason?: string | null;
  },
): Promise<{ id: UUID }> {
  const { data, error } = await supabase.rpc('prepare_annual_accounts', {
    p_organization_id: organizationId,
    p_fiscal_year_id: input.fiscalYearId,
    p_prepared_on: input.preparedOn,
    p_accounting_basis: input.accountingBasis ?? 'commercieel',
    p_signatories: input.signatories.map(s => ({
      name: s.name,
      role: s.role,
      shareholderId: s.shareholderId ?? null,
    })),
    p_off_balance_commitments: input.offBalanceCommitments ?? null,
    p_policy_change_note: input.policyChangeNote ?? null,
    p_size_class_override: input.sizeClassOverride ?? null,
    p_size_override_reason: input.sizeOverrideReason ?? null,
    p_note: input.note ?? null,
    p_all_shareholders_are_directors: input.allShareholdersAreDirectors ?? false,
    p_supersedes_annual_account_id: input.supersedesAnnualAccountId ?? null,
    p_supersede_reason: input.supersedeReason ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as { id: UUID };
}

/**
 * Verlenging van de opmaaktermijn door de algemene vergadering: ten hoogste
 * vijf maanden en alleen op grond van bijzondere omstandigheden (art. 2:210
 * lid 1 BW). Grond én besluitdatum zijn dus verplicht.
 */
export async function extendPreparationTerm(
  organizationId: UUID,
  annualAccountId: UUID,
  input: { months: number; reason: string; decidedOn: string },
): Promise<{ id: UUID }> {
  const { data, error } = await supabase.rpc('extend_preparation_term', {
    p_organization_id: organizationId,
    p_annual_account_id: annualAccountId,
    p_months: input.months,
    p_reason: input.reason,
    p_decided_on: input.decidedOn,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as { id: UUID };
}

/**
 * Zet één handtekening (art. 2:210 lid 2 BW), of legt vast waaróm zij
 * ontbreekt — die reden wordt in het gedrukte stuk vermeld.
 */
export async function signAnnualAccounts(
  organizationId: UUID,
  signatureId: UUID,
  input: { signed: boolean; signedOn?: string | null; missingReason?: string | null },
): Promise<AnnualAccountSignature> {
  const { data, error } = await supabase.rpc('sign_annual_accounts', {
    p_organization_id: organizationId,
    p_signature_id: signatureId,
    p_signed: input.signed,
    p_signed_on: input.signedOn ?? null,
    p_missing_reason: input.missingReason ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as AnnualAccountSignature;
}

/**
 * Stelt de jaarrekening vast. Bij `signature_210_5` dwingt de database de
 * kwijting af (art. 2:210 lid 5 BW) en moet de vaststellingsdatum gelijk zijn
 * aan de dag van de laatste handtekening.
 */
export async function adoptAnnualAccounts(
  organizationId: UUID,
  annualAccountId: UUID,
  input: {
    adoptionDate: string;
    method: AnnualAccountAdoptionMethod;
    dischargeGranted?: boolean;
    allShareholdersAreDirectors?: boolean | null;
    otherMeetingRightsInformed?: boolean | null;
    articlesAllow2105?: boolean | null;
    auditorOpinionReceived?: boolean | null;
    auditorName?: string | null;
    auditorMissingGround?: string | null;
  },
): Promise<{ id: UUID }> {
  const { data, error } = await supabase.rpc('adopt_annual_accounts', {
    p_organization_id: organizationId,
    p_annual_account_id: annualAccountId,
    p_adoption_date: input.adoptionDate,
    p_method: input.method,
    p_discharge_granted: input.dischargeGranted ?? false,
    p_all_shareholders_are_directors: input.allShareholdersAreDirectors ?? null,
    p_other_meeting_rights_informed: input.otherMeetingRightsInformed ?? null,
    p_articles_allow_210_5: input.articlesAllow2105 ?? null,
    p_auditor_opinion_received: input.auditorOpinionReceived ?? null,
    p_auditor_name: input.auditorName ?? null,
    p_auditor_missing_ground: input.auditorMissingGround ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as { id: UUID };
}

/**
 * Legt vast dát en wannéér er is gedeponeerd (art. 2:394 BW). ResoFly
 * deponeert niet zelf: micro, kleine en middelgrote rechtspersonen deponeren
 * digitaal in SBR/XBRL en dat bestand levert ResoFly niet.
 */
export async function fileAnnualAccounts(
  organizationId: UUID,
  annualAccountId: UUID,
  input: {
    filingDate: string;
    filingReference?: string | null;
    unadopted?: boolean;
    note?: string | null;
    auditorOpinionReceived?: boolean | null;
    auditorName?: string | null;
    auditorMissingGround?: string | null;
  },
): Promise<{ id: UUID }> {
  const { data, error } = await supabase.rpc('file_annual_accounts', {
    p_organization_id: organizationId,
    p_annual_account_id: annualAccountId,
    p_filing_date: input.filingDate,
    p_filing_reference: input.filingReference ?? null,
    p_unadopted: input.unadopted ?? false,
    p_note: input.note ?? null,
    p_auditor_opinion_received: input.auditorOpinionReceived ?? null,
    p_auditor_name: input.auditorName ?? null,
    p_auditor_missing_ground: input.auditorMissingGround ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as { id: UUID };
}

/**
 * Trekt een opgemaakte of vastgestelde jaarrekening in (alleen eigenaar of
 * beheerder). Een gedeponeerd stuk kan niet worden ingetrokken; dat wordt
 * hersteld met een opvolgend stuk.
 */
export async function reverseAnnualAccounts(
  organizationId: UUID,
  annualAccountId: UUID,
  reason: string,
): Promise<{ id: UUID }> {
  const { data, error } = await supabase.rpc('reverse_annual_accounts', {
    p_organization_id: organizationId,
    p_annual_account_id: annualAccountId,
    p_reason: reason,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as { id: UUID };
}

/** (Her)berekent het lineaire afschrijvingsschema van een activum. */
export async function generateDepreciationSchedule(organizationId: UUID, assetId: UUID): Promise<AssetDepreciation[]> {
  const { data, error } = await supabase.rpc('generate_depreciation_schedule', {
    p_organization_id: organizationId,
    p_asset_id: assetId,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as AssetDepreciation[];
}

/** Boekt alle openstaande afschrijvingsregels van een activum t/m een datum. */
export async function postAssetDepreciation(organizationId: UUID, assetId: UUID, throughDate: string): Promise<FixedAsset> {
  const { data, error } = await supabase.rpc('post_asset_depreciation', {
    p_organization_id: organizationId,
    p_asset_id: assetId,
    p_through_date: throughDate,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FixedAsset;
}

/** Boekt de aanschaf van een activum naar de balans (debet activa / credit tegenrekening). */
export async function bookAssetAcquisition(organizationId: UUID, assetId: UUID, creditAccountId: UUID, date?: string): Promise<FixedAsset> {
  const { data, error } = await supabase.rpc('book_asset_acquisition', {
    p_organization_id: organizationId,
    p_asset_id: assetId,
    p_credit_account_id: creditAccountId,
    p_date: date ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FixedAsset;
}

/** Stoot een activum af: boekt boekwaarde af, verwerkt de opbrengst tegen de
 *  tegenrekening en boekt boekwinst/-verlies naar 4950. */
export async function bookAssetDisposal(organizationId: UUID, assetId: UUID, counterAccountId: UUID, proceedsCents: number, date?: string): Promise<FixedAsset> {
  const { data, error } = await supabase.rpc('book_asset_disposal', {
    p_organization_id: organizationId,
    p_asset_id: assetId,
    p_counter_account_id: counterAccountId,
    p_proceeds_cents: proceedsCents,
    p_disposal_date: date ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as FixedAsset;
}

/** Winst- en verliesrekening over een periode (alleen geboekte journaalposten). */
export async function reportProfitAndLoss(organizationId: UUID, from: string, to: string): Promise<ProfitAndLossRow[]> {
  const { data, error } = await supabase.rpc('report_profit_and_loss', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as ProfitAndLossRow[];
}

/** Balans per peildatum (activa/passiva/eigen vermogen + cumulatief resultaat). */
export async function reportBalanceSheet(organizationId: UUID, asOf: string): Promise<BalanceSheetRow[]> {
  const { data, error } = await supabase.rpc('report_balance_sheet', {
    p_organization_id: organizationId,
    p_as_of: asOf,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as BalanceSheetRow[];
}

/** Proef-/saldibalans per peildatum: debet/credit/saldo per grootboekrekening (incl. jaarafsluiting). */
export async function reportTrialBalance(organizationId: UUID, asOf: string): Promise<TrialBalanceRow[]> {
  const { data, error } = await supabase.rpc('report_trial_balance', {
    p_organization_id: organizationId,
    p_as_of: asOf,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as TrialBalanceRow[];
}

/** Grootboekkaart: alle mutaties op één rekening in een periode, met beginsaldo en lopend saldo. */
export async function reportAccountLedger(organizationId: UUID, accountId: UUID, from: string, to: string): Promise<AccountLedgerRow[]> {
  const { data, error } = await supabase.rpc('report_account_ledger', {
    p_organization_id: organizationId,
    p_account_id: accountId,
    p_from: from,
    p_to: to,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? []) as AccountLedgerRow[];
}

/** Boekt een inkoopfactuur naar het grootboek (server-side, security definer). */
export async function bookPurchaseInvoice(organizationId: UUID, purchaseInvoiceId: UUID): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('book_purchase_invoice', {
    p_organization_id: organizationId,
    p_purchase_invoice_id: purchaseInvoiceId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Boekt een verkoopfactuur naar het grootboek (omzet + af te dragen BTW). */
export async function postSalesInvoiceToLedger(organizationId: UUID, invoiceId: UUID): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('post_sales_invoice_to_ledger', {
    p_organization_id: organizationId,
    p_invoice_id: invoiceId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Boekt alle nog niet-geboekte uitgegeven verkoopfacturen alsnog naar het
 *  grootboek (vangnet naast de automatische boeking bij versturen). Geeft het
 *  aantal alsnog geboekte facturen terug. */
export async function bookAllUnbookedSalesInvoices(organizationId: UUID): Promise<number> {
  const { data, error } = await supabase.rpc('book_all_unbooked_sales_invoices', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
  return Number(data ?? 0);
}

/** Maakt een tegenboeking van een geboekt boekstuk. */
export async function reverseJournalEntry(entryId: UUID, date?: string): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('reverse_journal_entry', {
    p_entry_id: entryId,
    p_date: date ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Boekt een vrije/handmatige journaalpost. p_lines is een array van boekingsregels. */
export async function postManualJournalEntry(
  organizationId: UUID,
  input: { date: string; description: string; lines: Array<Record<string, unknown>> },
): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('post_journal_entry', {
    p_organization_id: organizationId,
    p_date: input.date,
    p_description: input.description,
    p_source_type: 'manual',
    p_source_id: null,
    p_lines: input.lines,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Legt de beginbalans vast als één onveranderbaar openingsbalans-boekstuk. */
export async function createOpeningBalance(
  organizationId: UUID,
  asOfDate: string,
  lines: Array<Record<string, unknown>>,
): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('create_opening_balance', {
    p_organization_id: organizationId,
    p_as_of_date: asOfDate,
    p_lines: lines,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Boekt een uitgegeven creditnota naar het grootboek (debet omzet + 1510, credit 1300). */
export async function postCreditNoteToLedger(organizationId: UUID, creditNoteId: UUID): Promise<JournalEntry> {
  const { data, error } = await supabase.rpc('post_credit_note_to_ledger', {
    p_organization_id: organizationId,
    p_credit_note_id: creditNoteId,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as JournalEntry;
}

/** Rubriek-delta (voorvertoning) van een set correctieboekstukken voor een suppletie. */
export async function computeVatSupplementDelta(organizationId: UUID, entryIds: UUID[]): Promise<VatReturnRubrieken> {
  const { data, error } = await supabase.rpc('compute_vat_supplement_delta', {
    p_organization_id: organizationId,
    p_entry_ids: entryIds,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? {}) as VatReturnRubrieken;
}

/** Maakt een btw-suppletie definitief: boekt het delta-saldo door naar 1530 en sluit de verrekende boekstukken uit van de reguliere aangifte. */
export async function createVatSupplement(
  organizationId: UUID,
  input: { originalReturnId: UUID; entryIds: UUID[]; date?: string; notes?: string | null },
): Promise<VatReturn> {
  const { data, error } = await supabase.rpc('create_vat_supplement', {
    p_organization_id: organizationId,
    p_original_return_id: input.originalReturnId,
    p_entry_ids: input.entryIds,
    p_date: input.date ?? null,
    p_notes: input.notes ?? null,
  });
  if (error) throw bookkeepingError(error);
  return (Array.isArray(data) ? data[0] : data) as VatReturn;
}

/** Welke boekstukken zijn al in een suppletie verrekend (voor de kandidatenlijst). */
export async function listVatSupplementEntries(organizationId: UUID): Promise<VatSupplementEntry[]> {
  return selectOptional<VatSupplementEntry>('vat_supplement_entries', organizationId, {
    orderBy: 'created_at', ascending: false, hint: BOOKKEEPING_MIGRATION_HINT,
  });
}

/** ICP-opgaaf: intracommunautaire leveringen/diensten per afnemer over een periode. */
export async function computeIcpDeclaration(organizationId: UUID, from: string, to: string): Promise<IcpDeclaration> {
  const { data, error } = await supabase.rpc('compute_icp_declaration', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  });
  if (error) throw bookkeepingError(error);
  return (data ?? { rows: [] }) as IcpDeclaration;
}

/** Openstaande debiteuren/crediteuren per factuur uit het grootboek, met 1300/1600-aansluiting. */
export async function reportOpenItems(organizationId: UUID, asOf?: string): Promise<OpenItemsReport> {
  const { data, error } = await supabase.rpc('report_open_items', {
    p_organization_id: organizationId,
    p_as_of: asOf ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw bookkeepingError(error);
  return data as OpenItemsReport;
}

/** Zorgt dat het standaard rekeningschema + BTW-codes geseed zijn voor de organisatie. */
export async function ensureDefaultLedgerAccounts(organizationId: UUID): Promise<void> {
  const { error } = await supabase.rpc('ensure_default_ledger_accounts', {
    p_organization_id: organizationId,
  });
  if (error) throw bookkeepingError(error);
}

function bookkeepingError(error: { message?: string; details?: string }): Error {
  const message = `${error.message ?? ''} ${error.details ?? ''}`;
  if (/does not exist|schema cache|function|relation/i.test(message)) {
    return new Error(`Boekhoud-databasefunctie ontbreekt. ${BOOKKEEPING_MIGRATION_HINT}`);
  }
  return new Error(error.message || 'Boekhoudbewerking mislukt.');
}

export async function insertRow<T>(table: Table, organizationId: UUID, values: Record<string, unknown>): Promise<T> {
  const createdBy = await currentUserId();
  const { data, error } = await supabase
    .from(table)
    .insert({ ...sanitizeMutationValues(values), organization_id: organizationId, created_by: createdBy })
    .select('*')
    .single();
  if (error) throw error;
  return data as T;
}

export async function previewNextClientCode(organizationId: UUID): Promise<string> {
  const { data, error } = await supabase.rpc('preview_next_client_code', {
    p_organization_id: organizationId,
  });
  if (error) throw error;
  return String(data || '');
}

export async function createClientWithServerCode(organizationId: UUID, values: Record<string, unknown>): Promise<Client> {
  const payload = sanitizeMutationValues(values);

  // Nieuwe klantnummers worden vanaf nu uitsluitend server-side/RPC toegekend.
  // Een eventuele UI-preview wordt bewust niet meegestuurd als bron van waarheid.
  delete payload.client_code;

  const { data, error } = await supabase.rpc('create_client_with_next_code', {
    p_organization_id: organizationId,
    p_payload: payload,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Client;
}

/**
 * Stuurt de klant een welkomstmail met een link naar het klantportaal (/portal).
 * Server-side via de `mail`-edge function (Resend), zodat de API-key niet in de
 * browser staat. De klant moet een e-mailadres hebben.
 */
export async function sendClientPortalWelcomeEmail(organizationId: UUID, clientId: UUID): Promise<{ providerEmailId?: string; recipientEmail?: string }> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: {
      action: 'sendClientPortalWelcome',
      organizationId,
      clientId,
    },
  });
  if (error) await throwFunctionError(error, 'Welkomstmail verzenden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Welkomstmail verzenden mislukt.');
  return data as { providerEmailId?: string; recipientEmail?: string };
}

/**
 * Contactpersonen bij een klant. Elke rij kan onafhankelijk portaaltoegang
 * krijgen (gives_portal_access) waarmee die persoon met zijn/haar eigen
 * e-mailadres kan inloggen op /portal en daar offertes goedkeurt/weigert,
 * facturen betaalt en tickets indient — los van het hoofd-e-mailadres van de
 * klant, dat ongewijzigd blijft werken.
 */
export async function createClientContact(organizationId: UUID, values: Record<string, unknown>): Promise<ClientContact> {
  return insertRow<ClientContact>('client_contacts', organizationId, values);
}

export async function updateClientContact(id: UUID, values: Record<string, unknown>, organizationId: UUID): Promise<ClientContact> {
  return updateRow<ClientContact>('client_contacts', id, values, organizationId);
}

export async function deleteClientContact(id: UUID, organizationId: UUID): Promise<void> {
  return deleteRow('client_contacts', id, organizationId);
}

export async function updateRow<T>(table: Table, id: UUID, values: Record<string, unknown>, organizationId?: UUID): Promise<T> {
  let query = supabase
    .from(table)
    .update({ ...sanitizeMutationValues(values), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query.select('*').single();
  if (error) throw error;
  return data as T;
}

/**
 * Leest de taken van een handvol plandagen terug. `reorder_task_planning`
 * hernummert naast de versleepte taak ook de bron- en doeldag, en dit is het
 * goedkoopste manier om die waarheid op te halen: één query op hooguit twee
 * datums, in plaats van de hele werkruimte opnieuw laden.
 */
export async function fetchTasksForPlannedDates(organizationId: UUID, dates: string[]): Promise<Task[]> {
  const unique = [...new Set(dates.filter(Boolean))];
  if (unique.length === 0) return [];
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('organization_id', organizationId)
    .in('planned_date', unique);
  if (error) throw error;
  return (data ?? []) as Task[];
}

/**
 * Zet of verschuift de looptijd van een weekstrook. Verplaatsen en herschalen
 * lopen allebei hierlangs: de server bepaalt of het een strook blijft of weer
 * een gewone dagtaak wordt.
 */
export async function setTaskPlanningPeriod(
  organizationId: UUID,
  taskId: UUID,
  plannedDate: string | null,
  plannedEndDate: string | null,
): Promise<Task> {
  const { data, error } = await supabase.rpc('set_task_planning_period', {
    p_organization_id: organizationId,
    p_task_id: taskId,
    p_planned_date: plannedDate,
    p_planned_end_date: plannedEndDate,
  });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/set_task_planning_period|schema cache|does not exist|function/i.test(message)) {
      throw new Error('Weekstroken-databasefunctie ontbreekt. Voer eerst de migratie 20260810000000_weekplanner_week_bars.sql uit in Supabase.');
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row as Task;
}

export async function planTaskInWeek(organizationId: UUID, taskId: UUID, plannedDate: string | null, beforeTaskId?: UUID | null): Promise<Task> {
  const { data, error } = await supabase.rpc('reorder_task_planning', {
    p_organization_id: organizationId,
    p_task_id: taskId,
    p_planned_date: plannedDate,
    p_before_task_id: beforeTaskId ?? null,
  });

  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (/reorder_task_planning|schema cache|does not exist|function/i.test(message)) {
      throw new Error('Weekplanner-databasefunctie ontbreekt. Voer eerst de migratie 20260528_weekplanner_planning_fields.sql uit in Supabase.');
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row as Task;
}

export async function deleteRow(table: Table, id: UUID, organizationId?: UUID): Promise<void> {
  let query = supabase.from(table).delete().eq('id', id);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { error } = await query;
  if (error) throw error;
}

async function currentUserId(): Promise<UUID> {
  const { data: userData } = await supabaseAuth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Niet ingelogd.');
  return userId;
}


export async function createNoteWithCalendarLink(organizationId: UUID, values: Record<string, unknown>, input: CalendarNoteLinkInput): Promise<Note> {
  if (input.visibility_snapshot !== 'organization' || input.is_private_masked_snapshot) {
    throw new Error('Notities koppelen is alleen toegestaan bij gedeelde agenda-items waarvan de details zichtbaar zijn.');
  }

  const cleanValues = sanitizeMutationValues(values);
  const { data, error } = await supabase.rpc('create_note_with_calendar_link', {
    p_organization_id: organizationId,
    p_client_id: (cleanValues.client_id as UUID | null) ?? null,
    p_project_id: (cleanValues.project_id as UUID | null) ?? null,
    p_title: String(cleanValues.title ?? '').trim(),
    p_content: String(cleanValues.content ?? ''),
    p_note_type: String(cleanValues.note_type ?? 'general'),
    p_tags: Array.isArray(cleanValues.tags) ? cleanValues.tags : [],
    p_provider: input.provider,
    p_calendar_source_id: input.calendar_source_id,
    p_provider_calendar_id: input.provider_calendar_id ?? null,
    p_provider_event_id: input.provider_event_id,
    p_event_starts_at: input.event_starts_at,
    p_event_ends_at: input.event_ends_at ?? null,
    p_event_title_snapshot: input.event_title_snapshot ?? null,
    p_event_location_snapshot: input.event_location_snapshot ?? null,
    p_event_html_link: input.event_html_link ?? null,
    p_visibility_snapshot: input.visibility_snapshot,
    p_is_private_masked_snapshot: input.is_private_masked_snapshot,
  });

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Note;
}

export async function createNoteCalendarLink(organizationId: UUID, noteId: UUID, input: CalendarNoteLinkInput): Promise<NoteCalendarLink> {
  if (input.visibility_snapshot !== 'organization' || input.is_private_masked_snapshot) {
    throw new Error('Notities koppelen is alleen toegestaan bij gedeelde agenda-items waarvan de details zichtbaar zijn.');
  }

  const createdBy = await currentUserId();
  const row = {
    organization_id: organizationId,
    created_by: createdBy,
    note_id: noteId,
    provider: input.provider,
    calendar_source_id: input.calendar_source_id,
    provider_calendar_id: input.provider_calendar_id ?? null,
    provider_event_id: input.provider_event_id,
    event_starts_at: input.event_starts_at,
    event_ends_at: input.event_ends_at ?? null,
    event_title_snapshot: input.event_title_snapshot ?? null,
    event_location_snapshot: input.event_location_snapshot ?? null,
    event_html_link: input.event_html_link ?? null,
    visibility_snapshot: input.visibility_snapshot,
    is_private_masked_snapshot: input.is_private_masked_snapshot,
  };

  const { data, error } = await supabase
    .from('note_calendar_links')
    .upsert(row, { onConflict: 'organization_id,note_id,provider,calendar_source_id,provider_event_id,event_starts_at' })
    .select('*')
    .single();

  if (error) throw error;
  return data as NoteCalendarLink;
}

export async function deleteNoteCalendarLink(linkId: UUID, organizationId: UUID): Promise<void> {
  const { error } = await supabase
    .from('note_calendar_links')
    .delete()
    .eq('id', linkId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}


export async function submitQuoteForInternalApproval(organizationId: UUID, quoteId: UUID): Promise<Quote> {
  const { data, error } = await supabase.rpc('submit_quote_for_internal_approval', {
    p_quote_id: quoteId,
    p_organization_id: organizationId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Quote;
}

export async function approveQuoteInternal(organizationId: UUID, quoteId: UUID): Promise<Quote> {
  const { data, error } = await supabase.rpc('approve_quote_internal', {
    p_quote_id: quoteId,
    p_organization_id: organizationId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Quote;
}

export async function rejectQuoteInternal(organizationId: UUID, quoteId: UUID, note?: string): Promise<Quote> {
  const { data, error } = await supabase.rpc('reject_quote_internal', {
    p_quote_id: quoteId,
    p_organization_id: organizationId,
    p_note: note ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Quote;
}

export async function sendQuoteEmailViaResend(organizationId: UUID, quoteId: UUID, input: { recipientEmail?: string; recipientName?: string; subject?: string } = {}): Promise<{ publicUrl?: string; providerEmailId?: string }> {
  const { data, error } = await supabase.functions.invoke('quote-workflow', {
    body: {
      action: 'sendQuoteEmail',
      organizationId,
      quoteId,
      ...input,
    },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Offerte verzenden mislukt');
  return data as { publicUrl?: string; providerEmailId?: string };
}

/**
 * Download the immutable, server-stored PDF snapshot for a quote (the exact PDF
 * that was e-mailed to the client). The Edge Function returns the bytes as
 * base64; we turn that into a Blob and trigger a browser download. This never
 * regenerates the PDF, so the downloaded file always matches what was sent.
 */
export async function downloadQuotePdfSnapshot(organizationId: UUID, quoteId: UUID): Promise<void> {
  const { data, error } = await supabase.functions.invoke('quote-workflow', {
    body: {
      action: 'downloadQuotePdf',
      organizationId,
      quoteId,
    },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Offerte-PDF downloaden mislukt');

  const pdf = data.pdf as { fileName?: string; mimeType?: string; base64?: string } | undefined;
  if (!pdf?.base64) throw new Error('Geen PDF-snapshot beschikbaar voor deze offerte.');

  const binary = atob(pdf.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: pdf.mimeType || 'application/pdf' });

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = pdf.fileName || `offerte-${quoteId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/**
 * Download the immutable, server-stored PDF snapshot for an invoice (the exact
 * PDF that was e-mailed to the client). Mirrors downloadQuotePdfSnapshot: the
 * Edge Function returns base64, which we turn into a Blob and download. Never
 * regenerates the PDF, so the file always matches what was sent.
 */
export async function downloadInvoicePdfSnapshot(organizationId: UUID, invoiceId: UUID): Promise<void> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: {
      action: 'downloadInvoicePdf',
      organizationId,
      invoiceId,
    },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Factuur-PDF downloaden mislukt');

  const pdf = data.pdf as { fileName?: string; mimeType?: string; base64?: string } | undefined;
  if (!pdf?.base64) throw new Error('Geen PDF-snapshot beschikbaar voor deze factuur.');

  const binary = atob(pdf.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: pdf.mimeType || 'application/pdf' });

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = pdf.fileName || `factuur-${invoiceId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}


/**
 * Download de factuur als UBL 2.1 e-factuur (Peppol BIS 3.0). De XML wordt
 * server-side opgebouwd uit factuur + klant + bedrijfsgegevens; bij ontbrekende
 * gegevens (KVK, adres, land, …) gooit de Edge Function een duidelijke NL-fout.
 * Geeft eventuele niet-blokkerende waarschuwingen terug (bv. Peppol-endpoint
 * niet afleidbaar) zodat de UI ze kan tonen.
 */
export async function downloadInvoiceUbl(organizationId: UUID, invoiceId: UUID): Promise<{ warnings: string[] }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'downloadInvoiceUbl', organizationId, invoiceId },
  });
  if (error) await throwFunctionError(error, 'E-factuur (UBL) downloaden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'E-factuur (UBL) downloaden mislukt');
  const ubl = data.ubl as { fileName?: string; mimeType?: string; base64?: string; warnings?: string[] } | undefined;
  if (!ubl?.base64) throw new Error('Er kwam geen UBL-bestand terug van de server.');
  downloadBase64File(ubl.base64, ubl.fileName || `factuur-${invoiceId}-ubl.xml`, ubl.mimeType || 'application/xml');
  return { warnings: Array.isArray(ubl.warnings) ? ubl.warnings : [] };
}

/** Download een creditnota als UBL 2.1 CreditNote (spiegel van downloadInvoiceUbl). */
export async function downloadCreditNoteUbl(organizationId: UUID, creditNoteId: UUID): Promise<{ warnings: string[] }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'downloadCreditNoteUbl', organizationId, creditNoteId },
  });
  if (error) await throwFunctionError(error, 'E-creditnota (UBL) downloaden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'E-creditnota (UBL) downloaden mislukt');
  const ubl = data.ubl as { fileName?: string; mimeType?: string; base64?: string; warnings?: string[] } | undefined;
  if (!ubl?.base64) throw new Error('Er kwam geen UBL-bestand terug van de server.');
  downloadBase64File(ubl.base64, ubl.fileName || `creditfactuur-${creditNoteId}-ubl.xml`, ubl.mimeType || 'application/xml');
  return { warnings: Array.isArray(ubl.warnings) ? ubl.warnings : [] };
}

/** Base64 -> Blob -> browserdownload (zelfde patroon als de PDF-snapshots). */
function downloadBase64File(base64: string, fileName: string, mimeType: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

export async function convertAcceptedQuoteToInvoice(organizationId: UUID, quoteId: UUID): Promise<Invoice> {
  const { data, error } = await supabase.rpc('convert_accepted_quote_to_invoice', {
    p_quote_id: quoteId,
    p_organization_id: organizationId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Invoice;
}

export async function sendInvoiceEmailViaResend(organizationId: UUID, invoiceId: UUID, input: { recipientEmail?: string; recipientName?: string; subject?: string; includePaymentLink?: boolean } = {}): Promise<{ publicUrl?: string; providerEmailId?: string; paymentLinkIncluded?: boolean; paymentLinkError?: string | null; ubl?: { attached: boolean; fileName?: string; reason?: string | null; warnings?: string[] } }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: {
      action: 'sendInvoiceEmail',
      organizationId,
      invoiceId,
      ...input,
    },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Factuur verzenden mislukt');
  return data as { publicUrl?: string; providerEmailId?: string; paymentLinkIncluded?: boolean; paymentLinkError?: string | null; ubl?: { attached: boolean; fileName?: string; reason?: string | null; warnings?: string[] } };
}

/**
 * Stuur handmatig een betalingsherinnering voor een te late factuur via Resend.
 * Zonder `level` pakt de Edge Function automatisch het eerstvolgende niveau
 * (reminder_level + 1, max 3). De automatische cron-flow gebruikt dezelfde kern.
 */
export async function sendInvoiceReminderEmail(
  organizationId: UUID,
  invoiceId: UUID,
  input: { level?: 1 | 2 | 3; recipientEmail?: string; recipientName?: string; includePaymentLink?: boolean } = {},
): Promise<{ level?: number; publicUrl?: string; providerEmailId?: string; paymentLinkIncluded?: boolean; paymentLinkError?: string | null; recipientEmail?: string }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'sendInvoiceReminderEmail', organizationId, invoiceId, ...input },
  });
  if (error) await throwFunctionError(error, 'Herinnering verzenden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Herinnering verzenden mislukt');
  return data as { level?: number; publicUrl?: string; providerEmailId?: string; paymentLinkIncluded?: boolean; paymentLinkError?: string | null; recipientEmail?: string };
}

/**
 * Lees de automatische-herinneringsinstellingen van een organisatie. Geeft de
 * standaardwaarden terug (auto uit) als er nog geen rij bestaat.
 */
export async function loadInvoiceReminderSettings(organizationId: UUID): Promise<InvoiceReminderSettings> {
  const { data, error } = await supabase
    .from('invoice_reminder_settings')
    .select('organization_id,auto_reminders_enabled,level1_offset_days,level2_offset_days,level3_offset_days,include_payment_link,dunning_enabled,dunning_offset_days,dunning_collection_costs_vat,created_at,updated_at')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as InvoiceReminderSettings;
  return {
    organization_id: organizationId,
    auto_reminders_enabled: false,
    level1_offset_days: 3,
    level2_offset_days: 10,
    level3_offset_days: 17,
    include_payment_link: true,
    dunning_enabled: false,
    dunning_offset_days: 30,
    dunning_collection_costs_vat: false,
  };
}

/**
 * Sla de automatische-herinneringsinstellingen op (RLS: alleen schrijfbevoegde
 * leden). Een directe upsert volstaat — er zit geen secret in deze instellingen.
 */
export async function saveInvoiceReminderSettings(
  organizationId: UUID,
  input: Pick<InvoiceReminderSettings, 'auto_reminders_enabled' | 'level1_offset_days' | 'level2_offset_days' | 'level3_offset_days' | 'include_payment_link'>,
): Promise<InvoiceReminderSettings> {
  const { data, error } = await supabase
    .from('invoice_reminder_settings')
    .upsert({ organization_id: organizationId, ...input, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' })
    .select('organization_id,auto_reminders_enabled,level1_offset_days,level2_offset_days,level3_offset_days,include_payment_link,created_at,updated_at')
    .single();
  if (error) throw error;
  return data as InvoiceReminderSettings;
}

/**
 * Sla de debiteurenautomaat-instellingen op (op dezelfde invoice_reminder_settings-
 * rij als de herinneringen; de partiële upsert raakt alleen de dunning-kolommen).
 */
export async function saveInvoiceDunningSettings(
  organizationId: UUID,
  input: { dunning_enabled: boolean; dunning_offset_days: number; dunning_collection_costs_vat: boolean },
): Promise<void> {
  const { error } = await supabase
    .from('invoice_reminder_settings')
    .upsert({ organization_id: organizationId, ...input, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' });
  if (error) throw error;
}

/**
 * Nationale wettelijke rentetarieven (read-only) voor een informatieve weergave in de
 * instellingen. Leeg bij ontbrekende tabel (migratie nog niet uitgevoerd).
 */
export async function loadStatutoryInterestRates(): Promise<Array<{ kind: 'consumer' | 'commercial'; rate_basis_points: number; valid_from: string; source_note: string | null }>> {
  const { data, error } = await supabase
    .from('statutory_interest_rates')
    .select('kind,rate_basis_points,valid_from,source_note')
    .order('valid_from', { ascending: false });
  if (error) return [];
  return (data ?? []) as Array<{ kind: 'consumer' | 'commercial'; rate_basis_points: number; valid_from: string; source_note: string | null }>;
}

/**
 * Stel een formele aanmaning (WIK-14-dagenbrief) voor één factuur VOOR. De cron doet
 * dit automatisch; deze functie is voor handmatig voorstellen vanuit de UI.
 */
export async function proposeInvoiceDunningNotice(organizationId: UUID, invoiceId: UUID): Promise<{ noticeId?: string }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'proposeDunningNotice', organizationId, invoiceId },
  });
  if (error) await throwFunctionError(error, 'Aanmaning voorstellen mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Aanmaning voorstellen mislukt');
  return data as { noticeId?: string };
}

/**
 * Bevestig én verstuur een voorgestelde aanmaning. De rente wordt server-side op de
 * verzenddatum herberekend en de formele brief-PDF gaat via Resend naar de klant.
 */
export async function sendInvoiceDunningNotice(
  organizationId: UUID,
  noticeId: UUID,
  input: { recipientEmail?: string; recipientName?: string } = {},
): Promise<{ deadlineDate?: string; totalClaimCents?: number; recipientEmail?: string }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'sendDunningNotice', organizationId, noticeId, ...input },
  });
  if (error) await throwFunctionError(error, 'Aanmaning verzenden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Aanmaning verzenden mislukt');
  return data as { deadlineDate?: string; totalClaimCents?: number; recipientEmail?: string };
}

/** Annuleer een voorgestelde aanmaning (kan niet meer nadat die verstuurd is). */
export async function cancelInvoiceDunningNotice(organizationId: UUID, noticeId: UUID): Promise<void> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'cancelDunningNotice', organizationId, noticeId },
  });
  if (error) await throwFunctionError(error, 'Aanmaning annuleren mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Aanmaning annuleren mislukt');
}

const SENDING_DOMAIN_COLUMNS = 'id,organization_id,created_by,domain,provider,resend_domain_id,region,from_email,from_name,status,dns_records,is_default,last_checked_at,verified_at,created_at,updated_at';

/**
 * Laad de gekoppelde verzenddomeinen van een organisatie (eigen-domein e-mail).
 * Alleen-lezen: aanmaken/verifiëren/verwijderen loopt via de `mail` Edge Function
 * (Resend-API), maar elk lid mag de status en DNS-records inzien (RLS: can_read_org).
 */
// ── Persoonlijke afzender (per teamlid) ─────────────────────────────────────

/** De persoonlijke afzender van de ingelogde gebruiker binnen deze organisatie. */
export async function loadMySenderIdentity(organizationId: UUID): Promise<UserSenderIdentity | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from('user_sender_identities')
    .select('organization_id,user_id,from_name,from_email,created_at,updated_at')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as UserSenderIdentity | null;
}

/** Sla de persoonlijke afzender op (upsert op eigen rij; RLS dwingt user_id = auth.uid() af). */
export async function saveMySenderIdentity(organizationId: UUID, input: { from_name: string | null; from_email: string | null }): Promise<UserSenderIdentity> {
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from('user_sender_identities')
    .upsert(
      { organization_id: organizationId, user_id: userId, from_name: input.from_name, from_email: input.from_email },
      { onConflict: 'organization_id,user_id' },
    )
    .select('organization_id,user_id,from_name,from_email,created_at,updated_at')
    .single();
  if (error) throw error;
  return data as UserSenderIdentity;
}

/** Verwijder de persoonlijke afzender (terug naar de organisatie-afzender). */
export async function clearMySenderIdentity(organizationId: UUID): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  const { error } = await supabase
    .from('user_sender_identities')
    .delete()
    .eq('organization_id', organizationId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function loadSendingDomains(organizationId: UUID): Promise<SendingDomain[]> {
  const { data, error } = await supabase
    .from('organization_email_domains')
    .select(SENDING_DOMAIN_COLUMNS)
    .eq('organization_id', organizationId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SendingDomain[];
}

const CLIENT_EMAIL_THREAD_COLUMNS = 'id,organization_id,created_by,client_id,subject,last_message_at,last_direction,created_at,updated_at';
const CLIENT_EMAIL_COLUMNS = 'id,organization_id,created_by,thread_id,client_id,direction,provider,provider_email_id,from_email,from_name,to_email,subject,body_html,body_text,status,sent_at,delivered_at,opened_at,clicked_at,bounced_at,failed_at,complained_at,received_at,last_event_at,error_message,link_source,link_confidence,rfc_message_id,metadata,created_at,updated_at';

/**
 * Laad de e-mail-conversaties (threads) van een klant, nieuwste eerst. Alleen-lezen;
 * versturen loopt via de `mail` Edge Function en de webhook werkt de status bij.
 */
export async function loadClientEmailThreads(organizationId: UUID, clientId: UUID): Promise<ClientEmailThread[]> {
  const { data, error } = await supabase
    .from('client_email_threads')
    .select(CLIENT_EMAIL_THREAD_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('client_id', clientId)
    .order('last_message_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ClientEmailThread[];
}

/**
 * Laad alle e-mailberichten van een klant (uitgaand + inkomend), **nieuwste
 * eerst** — binnen een gesprek staat het laatste antwoord dus bovenaan.
 *
 * Bewust hier en niet in de weergave: een lang gesprek stond anders met het
 * verse antwoord onderaan, en dan scrol je een heel gesprek door voor het enige
 * bericht dat je nog niet had gelezen. De gesprekkenlijst zelf sorteert al op
 * dezelfde manier (`last_message_at` aflopend).
 */
export async function loadClientEmails(organizationId: UUID, clientId: UUID): Promise<ClientEmail[]> {
  const { data, error } = await supabase
    .from('client_emails')
    .select(CLIENT_EMAIL_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ClientEmail[];
}

/** Ids van klant-e-mails die de huidige gebruiker als gelezen heeft gemarkeerd. */
export async function loadClientEmailReadIds(organizationId: UUID, clientId: UUID): Promise<Set<UUID>> {
  const { data, error } = await supabase
    .from('client_email_reads')
    .select('client_email_id')
    .eq('organization_id', organizationId)
    .eq('client_id', clientId);
  if (error) throw error;
  return new Set((data ?? []).map(row => (row as { client_email_id: UUID }).client_email_id));
}

/**
 * Markeer inkomende berichten als gelezen voor de huidige gebruiker (idempotent).
 * user_id wordt server-side ingevuld via de kolom-default auth.uid().
 */
export async function markClientEmailsRead(organizationId: UUID, clientId: UUID, clientEmailIds: UUID[]): Promise<void> {
  if (clientEmailIds.length === 0) return;
  const rows = clientEmailIds.map(id => ({ organization_id: organizationId, client_id: clientId, client_email_id: id }));
  const { error } = await supabase
    .from('client_email_reads')
    .upsert(rows, { onConflict: 'client_email_id,user_id', ignoreDuplicates: true });
  if (error) throw error;
}

/** Tel ongelezen inkomende berichten voor de huidige gebruiker: totaal + per klant. */
export async function loadClientEmailUnreadCounts(organizationId: UUID): Promise<ClientEmailUnreadCounts> {
  const { data, error } = await supabase
    .from('client_email_unread')
    .select('client_id')
    .eq('organization_id', organizationId);
  if (error) throw error;
  const rows = (data ?? []) as { client_id: UUID }[];
  const byClient: Record<UUID, number> = {};
  for (const row of rows) byClient[row.client_id] = (byClient[row.client_id] ?? 0) + 1;
  return { total: rows.length, byClient };
}

// ── Doorstuuradres + opvangbak voor inkomende mail ──────────────────────────
//
// Alle schrijfacties lopen via RPC's: die zijn `security definer` met een eigen
// rechtencontrole, net als set_bank_transaction_status. Rechtstreeks schrijven
// op deze tabellen kan niet — er is bewust geen insert/update-policy.

const INBOUND_ALIAS_COLUMNS = 'id,organization_id,created_by,local_part,label,forward_from_email,status,retires_at,blocked_senders,last_received_at,received_total,pending_confirmation_code,pending_confirmation_at,created_at,updated_at';
const INBOUND_MESSAGE_COLUMNS = 'id,organization_id,created_by,alias_id,route,recipient,sender_email,sender_name,sender_source,sender_confidence,forwarding_evidence,subject,body_text,body_html,rfc_message_id,attachment_names,truncated,received_at,status,reason,category,candidates,suggested_client_id,linked_client_id,client_email_id,handled_at,purge_after,created_at,updated_at';

/** Het actieve doorstuuradres van de organisatie, of null als er nog geen is. */
export async function loadInboundAlias(organizationId: UUID): Promise<OrganizationInboundAlias | null> {
  const { data, error } = await supabase
    .from('organization_inbound_aliases')
    .select(INBOUND_ALIAS_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as OrganizationInboundAlias | null;
}

/** Maak het doorstuuradres aan als het nog niet bestaat (owner/admin). */
export async function ensureInboundAlias(organizationId: UUID): Promise<OrganizationInboundAlias> {
  const { data, error } = await supabase.rpc('ensure_organization_inbound_alias', { p_organization_id: organizationId });
  if (error) throw error;
  return data as OrganizationInboundAlias;
}

/**
 * Vervang het doorstuuradres. Het oude blijft 30 dagen werken maar koppelt niets
 * meer automatisch — mail die al onderweg is landt in de opvangbak in plaats van
 * te verdwijnen.
 */
export async function rotateInboundAlias(organizationId: UUID): Promise<OrganizationInboundAlias> {
  const { data, error } = await supabase.rpc('rotate_organization_inbound_alias', { p_organization_id: organizationId });
  if (error) throw error;
  return data as OrganizationInboundAlias;
}

/** Leg vast wélk eigen adres wordt doorgestuurd (info@…), voor herkenning. */
export async function setInboundAliasForwardFrom(organizationId: UUID, aliasId: UUID, email: string): Promise<OrganizationInboundAlias> {
  const { data, error } = await supabase.rpc('set_inbound_alias_forward_from', {
    p_organization_id: organizationId, p_alias_id: aliasId, p_email: email,
  });
  if (error) throw error;
  return data as OrganizationInboundAlias;
}

/** Berichten in de opvangbak: nog niet aan een klant gekoppeld. */
export async function loadInboundMessages(organizationId: UUID, category: InboundMessageCategory = 'human'): Promise<InboundMessage[]> {
  const { data, error } = await supabase
    .from('inbound_messages')
    .select(INBOUND_MESSAGE_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('category', category)
    .in('status', ['unmatched', 'conflict'])
    .order('received_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as InboundMessage[];
}

/** Aantal openstaande berichten in de opvangbak (voor het tabblad-badge). */
export async function loadInboundOpenCount(organizationId: UUID): Promise<number> {
  const { count, error } = await supabase
    .from('inbound_messages')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('category', 'human')
    .in('status', ['unmatched', 'conflict']);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Koppel een binnengekomen bericht alsnog aan een klant. Levert het id op van de
 * aangemaakte `client_emails`-rij. `rememberSender` staat bewust standaard uit:
 * het maakt een contactpersoon aan en dat is een permanente route.
 */
export async function linkInboundMessage(
  organizationId: UUID, inboundMessageId: UUID, clientId: UUID, rememberSender = false,
): Promise<UUID> {
  const { data, error } = await supabase.rpc('link_inbound_message', {
    p_organization_id: organizationId,
    p_inbound_message_id: inboundMessageId,
    p_client_id: clientId,
    p_remember_sender: rememberSender,
  });
  if (error) throw error;
  return data as UUID;
}

/** Negeren ('dropped') of terugzetten in de opvangbak ('unmatched'). */
export async function setInboundMessageStatus(
  organizationId: UUID, inboundMessageId: UUID, status: 'unmatched' | 'dropped',
): Promise<InboundMessage> {
  const { data, error } = await supabase.rpc('set_inbound_message_status', {
    p_organization_id: organizationId, p_inbound_message_id: inboundMessageId, p_status: status,
  });
  if (error) throw error;
  return data as InboundMessage;
}

/**
 * "Altijd negeren". Weigert bewust adressen die bij een bekende klant horen:
 * de afzender bepaalt zelf welke naam er in beeld staat, en anders kun je een
 * gebruiker laten blokkeren op het échte adres van zijn eigen klant.
 */
export async function blockInboundSender(organizationId: UUID, aliasId: UUID, value: string): Promise<OrganizationInboundAlias> {
  const { data, error } = await supabase.rpc('block_inbound_sender', {
    p_organization_id: organizationId, p_alias_id: aliasId, p_value: value,
  });
  if (error) throw error;
  return data as OrganizationInboundAlias;
}

/** Verwijder een bericht uit het klantdossier (soft delete, blijft in de RLS verborgen). */
export async function deleteClientEmail(organizationId: UUID, clientEmailId: UUID): Promise<void> {
  const { error } = await supabase.rpc('delete_client_email', {
    p_organization_id: organizationId, p_client_email_id: clientEmailId,
  });
  if (error) throw error;
}

// ── E-mailmarketing / campagnes ─────────────────────────────────────────────
const CAMPAIGN_COLUMNS = 'id,organization_id,created_by,name,subject,preheader,body_html,body_text,accent_color,audience,status,scheduled_at,started_at,sent_at,created_at,updated_at';
const CAMPAIGN_RECIPIENT_COLUMNS = 'id,organization_id,created_by,campaign_id,client_id,contact_id,to_email,to_name,thread_id,client_email_id,status,sent_at,delivered_at,opened_at,clicked_at,bounced_at,failed_at,replied_at,unsubscribed_at,error_message,created_at,updated_at';

export interface CampaignInput {
  name: string;
  subject: string;
  preheader?: string | null;
  body_html: string;
  body_text?: string | null;
  accent_color?: string | null;
  audience: CampaignAudience;
}

/** Laad alle campagnes van een organisatie (nieuwste eerst). RLS: elk lid leest. */
export async function loadCampaigns(organizationId: UUID): Promise<EmailCampaign[]> {
  const { data, error } = await supabase
    .from('email_campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EmailCampaign[];
}

/** Geaggregeerde verzend-/tracking-statistieken per campagne (view, security_invoker). */
export async function loadCampaignStats(organizationId: UUID): Promise<EmailCampaignStats[]> {
  const { data, error } = await supabase
    .from('email_campaign_stats')
    .select('organization_id,campaign_id,total,sent,delivered,opened,clicked,replied,bounced,failed,unsubscribed,pending')
    .eq('organization_id', organizationId);
  if (error) throw error;
  return (data ?? []) as EmailCampaignStats[];
}

/** Laad de ontvangers (+ per-ontvanger tracking) van één campagne. */
export async function loadCampaignRecipients(organizationId: UUID, campaignId: UUID): Promise<EmailCampaignRecipient[]> {
  const { data, error } = await supabase
    .from('email_campaign_recipients')
    .select(CAMPAIGN_RECIPIENT_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as EmailCampaignRecipient[];
}

/** De suppressielijst (afgemelde/gebouncede adressen) van een organisatie. */
export async function loadSuppressions(organizationId: UUID): Promise<EmailSuppression[]> {
  const { data, error } = await supabase
    .from('email_suppressions')
    .select('organization_id,email,reason,source,created_by,created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EmailSuppression[];
}

/** Maak een nieuwe (concept)campagne. RLS: schrijvers (can_write_org). */
export async function createCampaign(organizationId: UUID, input: CampaignInput): Promise<EmailCampaign> {
  const createdBy = await currentUserId();
  const { data, error } = await supabase
    .from('email_campaigns')
    .insert({
      organization_id: organizationId,
      created_by: createdBy,
      name: input.name,
      subject: input.subject,
      preheader: input.preheader ?? null,
      body_html: input.body_html,
      body_text: input.body_text ?? null,
      accent_color: input.accent_color ?? null,
      audience: input.audience,
      status: 'draft',
    })
    .select(CAMPAIGN_COLUMNS)
    .single();
  if (error) throw error;
  return data as EmailCampaign;
}

/** Werk een concept-/gepauzeerde campagne bij. */
export async function updateCampaign(organizationId: UUID, campaignId: UUID, patch: Partial<CampaignInput>): Promise<EmailCampaign> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.subject !== undefined) values.subject = patch.subject;
  if (patch.preheader !== undefined) values.preheader = patch.preheader;
  if (patch.body_html !== undefined) values.body_html = patch.body_html;
  if (patch.body_text !== undefined) values.body_text = patch.body_text;
  if (patch.accent_color !== undefined) values.accent_color = patch.accent_color;
  if (patch.audience !== undefined) values.audience = patch.audience;
  const { data, error } = await supabase
    .from('email_campaigns')
    .update(values)
    .eq('id', campaignId)
    .eq('organization_id', organizationId)
    .select(CAMPAIGN_COLUMNS)
    .single();
  if (error) throw error;
  return data as EmailCampaign;
}

/** Verwijder een campagne (ontvangers cascaden via FK). */
export async function deleteCampaign(organizationId: UUID, campaignId: UUID): Promise<void> {
  const { error } = await supabase
    .from('email_campaigns')
    .delete()
    .eq('id', campaignId)
    .eq('organization_id', organizationId);
  if (error) throw error;
}

/** Voeg een adres handmatig toe aan de suppressielijst (idempotent). */
export async function addSuppression(organizationId: UUID, email: string, reason: EmailSuppressionReason = 'manual'): Promise<void> {
  const createdBy = await currentUserId();
  const { error } = await supabase
    .from('email_suppressions')
    .upsert(
      { organization_id: organizationId, email: email.trim().toLowerCase(), reason, source: 'handmatig', created_by: createdBy },
      { onConflict: 'organization_id,email', ignoreDuplicates: true },
    );
  if (error) throw error;
}

/** Verwijder een adres van de suppressielijst (weer aanschrijfbaar maken). */
export async function removeSuppression(organizationId: UUID, email: string): Promise<void> {
  const { error } = await supabase
    .from('email_suppressions')
    .delete()
    .eq('organization_id', organizationId)
    .eq('email', email.trim().toLowerCase());
  if (error) throw error;
}

// ── Follow-up-stromen ───────────────────────────────────────────────────────
const FLOW_COLUMNS = 'id,organization_id,created_by,name,status,audience,stop_condition,created_at,updated_at';
const FLOW_STEP_COLUMNS = 'id,organization_id,flow_id,step_index,delay_days,subject,preheader,body_html,body_text,accent_color,created_at,updated_at';
const FLOW_ENROLLMENT_COLUMNS = 'id,organization_id,flow_id,client_id,contact_id,to_email,to_name,thread_id,status,current_step_index,next_step_due_at,last_reply_at,enrolled_at,completed_at,created_at,updated_at';

export async function loadFlows(organizationId: UUID): Promise<EmailFlow[]> {
  const { data, error } = await supabase
    .from('email_flows')
    .select(FLOW_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EmailFlow[];
}

export async function loadFlowSteps(organizationId: UUID, flowId: UUID): Promise<EmailFlowStep[]> {
  const { data, error } = await supabase
    .from('email_flow_steps')
    .select(FLOW_STEP_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('flow_id', flowId)
    .order('step_index', { ascending: true });
  if (error) throw error;
  return (data ?? []) as EmailFlowStep[];
}

export async function loadFlowStats(organizationId: UUID): Promise<EmailFlowStats[]> {
  const { data, error } = await supabase
    .from('email_flow_stats')
    .select('organization_id,flow_id,enrollments,active,completed,stopped_reacted,stopped_unsubscribed,cancelled')
    .eq('organization_id', organizationId);
  if (error) throw error;
  return (data ?? []) as EmailFlowStats[];
}

export async function loadFlowStepStats(organizationId: UUID): Promise<EmailFlowStepStats[]> {
  const { data, error } = await supabase
    .from('email_flow_step_stats')
    .select('organization_id,flow_id,step_index,sent,opened,clicked,replied,bounced')
    .eq('organization_id', organizationId);
  if (error) throw error;
  return (data ?? []) as EmailFlowStepStats[];
}

export async function loadFlowEnrollments(organizationId: UUID, flowId: UUID): Promise<EmailFlowEnrollment[]> {
  const { data, error } = await supabase
    .from('email_flow_enrollments')
    .select(FLOW_ENROLLMENT_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('flow_id', flowId)
    .order('enrolled_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as EmailFlowEnrollment[];
}

export async function createFlow(organizationId: UUID, input: { name: string; audience: CampaignAudience; stop_condition: FlowStopCondition }): Promise<EmailFlow> {
  const createdBy = await currentUserId();
  const { data, error } = await supabase
    .from('email_flows')
    .insert({ organization_id: organizationId, created_by: createdBy, name: input.name, audience: input.audience, stop_condition: input.stop_condition, status: 'draft' })
    .select(FLOW_COLUMNS)
    .single();
  if (error) throw error;
  return data as EmailFlow;
}

export async function updateFlow(organizationId: UUID, flowId: UUID, patch: Partial<{ name: string; audience: CampaignAudience; stop_condition: FlowStopCondition }>): Promise<EmailFlow> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.audience !== undefined) values.audience = patch.audience;
  if (patch.stop_condition !== undefined) values.stop_condition = patch.stop_condition;
  const { data, error } = await supabase
    .from('email_flows')
    .update(values)
    .eq('id', flowId)
    .eq('organization_id', organizationId)
    .select(FLOW_COLUMNS)
    .single();
  if (error) throw error;
  return data as EmailFlow;
}

export async function deleteFlow(organizationId: UUID, flowId: UUID): Promise<void> {
  const { error } = await supabase.from('email_flows').delete().eq('id', flowId).eq('organization_id', organizationId);
  if (error) throw error;
}

/**
 * Vervang alle stappen van een concept-stroom. Loopt via de atomaire RPC
 * replace_flow_steps (delete + insert in één transactie + draft-check), zodat een
 * mislukte insert de stappen niet permanent wist en een gestarte stroom niet
 * gewijzigd kan worden.
 */
export async function replaceFlowSteps(organizationId: UUID, flowId: UUID, steps: FlowStepInput[]): Promise<void> {
  const payload = steps.map((s, i) => ({
    step_index: i,
    delay_days: Math.min(3650, Math.max(0, Math.round(s.delay_days || 0))),
    subject: s.subject,
    preheader: s.preheader ?? null,
    body_html: s.body_html,
    body_text: s.body_text ?? null,
    accent_color: s.accent_color ?? null,
  }));
  const { error } = await supabase.rpc('replace_flow_steps', { p_organization_id: organizationId, p_flow_id: flowId, p_steps: payload });
  if (error) throw error;
}

const EMAIL_TEMPLATE_COLUMNS = 'id,organization_id,created_by,template_key,enabled,subject,intro,closing,cta_label,created_at,updated_at';

/**
 * Laad alle aangepaste e-mailteksten van een organisatie. Sleutels zonder rij
 * gebruiken in de mail de ingebouwde standaardtekst — de editor toont die default
 * dan vanuit de frontend-catalogus. RLS: elk lid mag lezen.
 */
export async function loadEmailTemplates(organizationId: UUID): Promise<EmailTemplate[]> {
  const { data, error } = await supabase
    .from('email_templates')
    .select(EMAIL_TEMPLATE_COLUMNS)
    .eq('organization_id', organizationId);
  if (error) throw error;
  return (data ?? []) as EmailTemplate[];
}

/**
 * Sla de aangepaste tekst voor één template-sleutel op (RLS: alleen owners/admins).
 * Een directe upsert volstaat — er zit geen secret in deze teksten. Lege velden
 * worden als null bewaard zodat de mail terugvalt op de standaardtekst.
 */
export async function upsertEmailTemplate(organizationId: UUID, templateKey: EmailTemplateKey, input: EmailTemplateInput): Promise<EmailTemplate> {
  const createdBy = await currentUserId();
  const trimOrNull = (value: string | null) => {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed : null;
  };
  const { data, error } = await supabase
    .from('email_templates')
    .upsert({
      organization_id: organizationId,
      created_by: createdBy,
      template_key: templateKey,
      enabled: input.enabled,
      subject: trimOrNull(input.subject),
      intro: trimOrNull(input.intro),
      closing: trimOrNull(input.closing),
      cta_label: trimOrNull(input.cta_label),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,template_key' })
    .select(EMAIL_TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;
  return data as EmailTemplate;
}

/**
 * Zet één template terug naar de standaardtekst door de aangepaste rij te
 * verwijderen (RLS: alleen owners/admins). De mail valt daarna terug op de
 * ingebouwde standaardtekst van de Edge Function.
 */
export async function resetEmailTemplate(organizationId: UUID, templateKey: EmailTemplateKey): Promise<void> {
  const { error } = await supabase
    .from('email_templates')
    .delete()
    .eq('organization_id', organizationId)
    .eq('template_key', templateKey);
  if (error) throw error;
}

/**
 * Pauzeer of hervat de (automatische) herinneringen voor één factuur. Gepauzeerde
 * facturen worden door de cron-zoekopdracht overgeslagen.
 */
export async function setInvoiceRemindersPaused(organizationId: UUID, invoiceId: UUID, paused: boolean): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({ reminders_paused: paused })
    .eq('organization_id', organizationId)
    .eq('id', invoiceId);
  if (error) throw error;
}

export async function createInvoicePaymentCheckout(organizationId: UUID, invoiceId: UUID, input: { redirectUrl?: string; idempotencyKey?: string } = {}): Promise<{ checkoutUrl?: string; providerPaymentId?: string; reused?: boolean; mock?: boolean }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: {
      action: 'createInvoicePaymentCheckout',
      organizationId,
      invoiceId,
      ...input,
    },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Betaallink aanmaken mislukt');
  return data as { checkoutUrl?: string; providerPaymentId?: string; reused?: boolean; mock?: boolean };
}

/**
 * Register a refund for a paid invoice (Fase 1: handmatige/offline terugbetaling)
 * and optionally issue a credit note. The amount is in cents; the Edge Function
 * validates it against the remaining refundable amount and books it atomically.
 * idempotencyKey should be stable per refund action (generate once per modal) so
 * a double-click never books two refunds.
 */
export async function createInvoiceRefund(
  organizationId: UUID,
  invoiceId: UUID,
  input: { amountCents: number; reason?: string; createCreditNote?: boolean; idempotencyKey?: string; kind?: 'manual' | 'mollie' },
): Promise<{ refund: InvoiceRefund; creditNote: CreditNote | null }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'createInvoiceRefund', organizationId, invoiceId, ...input },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Terugbetaling registreren mislukt');
  return data as { refund: InvoiceRefund; creditNote: CreditNote | null };
}

/**
 * Download the stored credit-note PDF (mirrors downloadInvoicePdfSnapshot). The
 * Edge Function returns base64, which we turn into a Blob and download.
 */
export async function downloadCreditNotePdf(organizationId: UUID, creditNoteId: UUID): Promise<void> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'downloadCreditNotePdf', organizationId, creditNoteId },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Creditfactuur-PDF downloaden mislukt');

  const pdf = data.pdf as { fileName?: string; mimeType?: string; base64?: string } | undefined;
  if (!pdf?.base64) throw new Error('Geen PDF beschikbaar voor deze creditfactuur.');

  const binary = atob(pdf.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: pdf.mimeType || 'application/pdf' });

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = pdf.fileName || `creditfactuur-${creditNoteId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/**
 * Mail de creditfactuur-PDF naar de klant via de Edge Function (Resend). Optioneel
 * een afwijkend e-mailadres; standaard gaat hij naar het klant-e-mailadres.
 */
export async function sendCreditNoteEmail(organizationId: UUID, creditNoteId: UUID, recipientEmail?: string): Promise<{ providerEmailId: string; recipientEmail: string }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'sendCreditNoteEmail', organizationId, creditNoteId, recipientEmail },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Creditfactuur mailen mislukt');
  return data as { providerEmailId: string; recipientEmail: string };
}

/**
 * Per-organization invoice Mollie key management. The plaintext key only ever
 * travels (over HTTPS) to the invoice-workflow Edge Function, which validates,
 * encrypts and stores it. These helpers only ever receive masked status back.
 */
export async function loadInvoiceMollieStatus(organizationId: UUID): Promise<InvoiceMollieSettingsStatus> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'getInvoiceMollieStatus', organizationId },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Mollie-status laden mislukt');
  return data.status as InvoiceMollieSettingsStatus;
}

export async function saveInvoiceMollieKey(organizationId: UUID, apiKey: string): Promise<InvoiceMollieSettingsStatus> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'saveInvoiceMollieKey', organizationId, apiKey },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Mollie koppelen mislukt');
  return data.status as InvoiceMollieSettingsStatus;
}

export async function deleteInvoiceMollieKey(organizationId: UUID): Promise<{ status: InvoiceMollieSettingsStatus; hadOpenPayments: boolean }> {
  const { data, error } = await supabase.functions.invoke('invoice-workflow', {
    body: { action: 'deleteInvoiceMollieKey', organizationId },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Mollie ontkoppelen mislukt');
  return { status: data.status as InvoiceMollieSettingsStatus, hadOpenPayments: Boolean(data.hadOpenPayments) };
}

/**
 * Hernoem een geüpload bestand. Alleen de weergavenaam verandert: de `storage_key`
 * in R2 blijft precies waar hij is, zodat bestaande links, office-sessies en
 * downloads gewoon blijven werken. Deze update loopt bewust niet via `updateRow`,
 * want `attachments` heeft geen `updated_at`-kolom.
 */
export async function renameAttachment(id: UUID, name: string, organizationId?: UUID): Promise<Attachment> {
  let query = supabase.from('attachments').update({ name }).eq('id', id);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query.select('*').single();
  if (error) throw error;
  return data as Attachment;
}

/**
 * Delete a single attachment: remove the DB row first (so the UI can never show a ghost
 * pointing at a missing file), then best-effort R2 cleanup. An R2 failure leaves an orphan
 * in storage but does not block the user.
 */
export async function deleteAttachment(att: { id: UUID; storage_key: string; organization_id?: UUID }): Promise<void> {
  let query = supabase.from('attachments').delete().eq('id', att.id);
  if (att.organization_id) query = query.eq('organization_id', att.organization_id);
  const { error } = await query;
  if (error) throw error;
  try { await deleteR2Object(att.storage_key); }
  catch (e) { console.warn('R2 cleanup mislukt voor', att.storage_key, e); }
}

async function selectAttachmentRefsForEntity(type: EntityType, id: UUID, organizationId?: UUID): Promise<AttachmentRef[]> {
  let query = supabase
    .from('attachments')
    .select('id, storage_key')
    .eq('entity_type', type)
    .eq('entity_id', id);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AttachmentRef[];
}

async function selectSubtaskAttachmentRefsForParentTask(taskId: UUID, organizationId?: UUID): Promise<AttachmentRef[]> {
  let query = supabase
    .from('attachments')
    .select('id, storage_key')
    .eq('entity_type', 'subtask')
    .eq('parent_task_id', taskId);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AttachmentRef[];
}

async function getChildTaskIds(projectId: UUID, organizationId?: UUID): Promise<UUID[]> {
  let query = supabase.from('tasks').select('id').eq('project_id', projectId);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row: { id: UUID }) => row.id);
}

function uniqueAttachmentRefs(refs: AttachmentRef[]): AttachmentRef[] {
  const byId = new Map<string, AttachmentRef>();
  for (const ref of refs) byId.set(ref.id, ref);
  return [...byId.values()];
}

/**
 * Delete an entity together with its attachments in R2 and the attachments table.
 * For tasks, this also cleans latent subtask attachments linked through parent_task_id.
 * For projects, it also cleans attachments of cascading child tasks and their subtasks.
 */
export async function deleteEntityCascade(table: Table, id: UUID, organizationId?: UUID): Promise<void> {
  const entityType = tableToEntity[table];
  const refsToDelete: AttachmentRef[] = [];

  if (entityType) {
    refsToDelete.push(...await selectAttachmentRefsForEntity(entityType, id, organizationId));

    const taskIds: UUID[] = [];
    if (entityType === 'task') taskIds.push(id);
    if (entityType === 'project') taskIds.push(...await getChildTaskIds(id, organizationId));

    for (const taskId of taskIds) {
      refsToDelete.push(...await selectAttachmentRefsForEntity('task', taskId, organizationId));
      refsToDelete.push(...await selectSubtaskAttachmentRefsForParentTask(taskId, organizationId));
    }
  }

  for (const att of uniqueAttachmentRefs(refsToDelete)) {
    await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: organizationId });
  }

  await deleteRow(table, id, organizationId);
}

/** Atomic ticket → project conversion via Postgres function. */
export async function convertTicketToProject(ticket: Ticket, organizationId = ticket.organization_id): Promise<Project> {
  const { data, error } = await supabase.rpc('convert_ticket_to_project', { p_ticket_id: ticket.id, p_organization_id: organizationId });
  if (error) throw error;
  if (!data) throw new Error('Conversie gaf geen project terug.');
  return (Array.isArray(data) ? data[0] : data) as Project;
}

export async function createAttachment(organizationId: UUID, input: {
  entity_type: EntityType; entity_id: UUID; parent_task_id?: UUID | null; name: string; mime_type: string; size_bytes: number; storage_key: string; public_url?: string | null;
}) {
  return insertRow<Attachment>('attachments', organizationId, input);
}
