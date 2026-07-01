import { supabase, supabaseAuth } from './supabase';
import { recordInvitationBlockedBySeats } from '../services/licenseService';
import { deleteR2Object } from './r2-api';
import { throwFunctionError } from './functionErrors';
import type { ReportDefinition } from './reporting';
import type {
  AppData,
  AuditLog,
  Attachment,
  Client,
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
  SendingDomain,
  ClientEmail,
  ClientEmailThread,
  ClientEmailUnreadCounts,
  CreditNote,
  InvoiceChargeback,
  Note,
  InternalDocument,
  ContentFolder,
  LedgerAccount,
  VatCode,
  JournalEntry,
  JournalLine,
  ClosedPeriod,
  Supplier,
  PurchaseInvoice,
  FixedAsset,
  AssetDepreciation,
  ProfitAndLossRow,
  BalanceSheetRow,
  VatReturn,
  VatReturnRubrieken,
  BankAccount,
  BankStatement,
  BankTransaction,
  BankRule,
  BankRequisition,
  BankInstitution,
  ParsedBankStatement,
  CalendarNoteLinkInput,
  NoteCalendarLink,
  CalendarEventLink,
  CalendarEventLinkInput,
  TimeEntry,
  Organization,
  OrganizationContext,
  OrganizationInvitation,
  OrganizationBillingOverview,
  OrganizationLicenseUsage,
  OrganizationMember,
  OrganizationMembershipView,
  OrganizationRole,
  Project,
  Quote,
  QuoteApprovalEvent,
  QuoteEmailDelivery,
  QuoteVersion,
  SavedReport,
  Task,
  Ticket,
  TicketNote,
  UUID,
} from '../types';

const tables = ['clients', 'projects', 'tasks', 'tickets', 'notes', 'documents', 'content_folders', 'quotes', 'invoices', 'ledger_accounts', 'vat_codes', 'suppliers', 'purchase_invoices', 'fixed_assets', 'vat_returns', 'bank_accounts', 'bank_rules', 'attachments', 'saved_reports', 'company_settings'] as const;
export type Table = typeof tables[number];

type AttachmentRef = Pick<Attachment, 'id' | 'storage_key'>;

type MembershipRow = OrganizationMember & { organization: Organization | Organization[] | null };

const tableToEntity: Record<Table, EntityType | null> = {
  clients: 'client',
  projects: 'project',
  tasks: 'task',
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
  saved_reports: null,
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
  if (activeOrganization) {
    const [{ data: teamRows, error: teamError }, { data: orgInvitationRows, error: orgInvitationError }, { data: auditRows, error: auditError }, { data: licenseRows, error: licenseError }, { data: billingRows, error: billingError }] = await Promise.all([
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
  };
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

export async function inviteOrganizationMember(organizationId: UUID, email: string, role: OrganizationRole): Promise<OrganizationInvitation> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) throw new Error('E-mailadres ontbreekt.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Vul een geldig e-mailadres in.');
  const { data, error } = await supabase.rpc('invite_organization_member', {
    p_organization_id: organizationId,
    p_email: cleanEmail,
    p_role: role,
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
    ledgerAccounts,
    vatCodes,
    journalEntries,
    journalLines,
    closedPeriods,
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
    savedReports,
    companySettings,
  ] = await Promise.all([
    select<Client>('clients', organizationId), select<Project>('projects', organizationId), select<Task>('tasks', organizationId), select<Ticket>('tickets', organizationId),
    selectTicketNotes(organizationId), select<Note>('notes', organizationId), selectDocuments(organizationId), selectNoteCalendarLinks(organizationId), selectCalendarEventLinks(organizationId), selectTimeEntries(organizationId), select<Quote>('quotes', organizationId), selectQuoteApprovalEvents(organizationId), selectQuoteEmailDeliveries(organizationId), selectQuoteVersions(organizationId), select<Invoice>('invoices', organizationId),
    selectInvoiceWorkflowEvents(organizationId), selectInvoiceEmailDeliveries(organizationId), selectInvoicePaymentRecords(organizationId), selectInvoiceVersions(organizationId),
    selectInvoiceRefunds(organizationId), selectCreditNotes(organizationId), selectInvoiceChargebacks(organizationId),
    selectLedgerAccounts(organizationId), selectVatCodes(organizationId), selectJournalEntries(organizationId), selectJournalLines(organizationId), selectClosedPeriods(organizationId), selectSuppliers(organizationId), selectPurchaseInvoices(organizationId), selectFixedAssets(organizationId), selectAssetDepreciations(organizationId), selectVatReturns(organizationId),
    selectBankAccounts(organizationId), selectBankStatements(organizationId), selectBankTransactions(organizationId), selectBankRules(organizationId), selectBankRequisitions(organizationId),
    select<Attachment>('attachments', organizationId),
    selectFolders(organizationId),
    selectSavedReports(organizationId),
    loadCompanySettings(organizationId),
  ]);
  return { clients, projects, tasks, tickets, ticketNotes, notes, documents, folders, noteCalendarLinks, calendarEventLinks, timeEntries, quotes, quoteApprovalEvents, quoteEmailDeliveries, quoteVersions, invoices, invoiceWorkflowEvents, invoiceEmailDeliveries, invoicePaymentRecords, invoiceVersions, invoiceRefunds, creditNotes, invoiceChargebacks, ledgerAccounts, vatCodes, journalEntries, journalLines, closedPeriods, suppliers, purchaseInvoices, fixedAssets, assetDepreciations, vatReturns, bankAccounts, bankStatements, bankTransactions, bankRules, bankRequisitions, attachments, savedReports, companySettings };
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
    .select('id,organization_id,invoice_id,refund_id,number,date,reason,currency,subtotal_amount,vat_amount,total_amount,lines,status,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_storage_provider,pdf_storage_key,issued_by,created_at,updated_at')
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

export interface TimeEntryInput {
  project_id: UUID | null;
  client_id: UUID | null;
  source?: 'manual' | 'timer';
  description?: string | null;
  entry_date: string;
  started_at?: string | null;
  ended_at?: string | null;
  minutes: number;
  billable?: boolean;
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
  patch: Partial<Pick<TimeEntry, 'project_id' | 'client_id' | 'description' | 'entry_date' | 'started_at' | 'ended_at' | 'minutes' | 'billable' | 'hourly_rate_cents'>>,
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

export async function select<T>(table: Table, organizationId: UUID): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as T[];
}

const BOOKKEEPING_MIGRATION_HINT =
  'Voer de migratie 20260618000000_bookkeeping_ledger_core.sql uit in Supabase om de boekhoudmodule te activeren.';

/**
 * Leest een nog-jonge tabel en degradeert gracieus: ontbreekt de tabel (migratie
 * nog niet uitgevoerd), dan een waarschuwing + lege lijst i.p.v. een harde fout.
 * Zelfde patroon als selectQuoteVersions/selectInvoiceVersions.
 */
async function selectOptional<T>(
  table: string,
  organizationId: UUID,
  opts: { orderBy: string; ascending: boolean; hint: string },
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('organization_id', organizationId)
    .order(opts.orderBy, { ascending: opts.ascending });
  if (error) {
    const message = `${error.message ?? ''} ${error.details ?? ''}`;
    if (new RegExp(`${table}|schema cache|does not exist|relation`, 'i').test(message)) {
      console.warn(`${table} is nog niet beschikbaar. ${opts.hint}`, error);
      return [];
    }
    throw error;
  }
  return (data ?? []) as T[];
}

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
 * Leest een afschrift in: voegt nieuwe transacties idempotent toe (dedup op
 * bank_account_id + dedup_key) en stelt direct matches/voorstellen voor. Geeft
 * het aantal toegevoegde en overgeslagen (reeds bekende) regels terug.
 */
export async function importBankTransactions(
  organizationId: UUID,
  bankAccountId: UUID,
  statement: ParsedBankStatement,
): Promise<{ inserted: number; skipped: number; statement_id: UUID | null }> {
  const { transactions, ...meta } = statement;
  const { data, error } = await supabase.rpc('import_bank_transactions', {
    p_organization_id: organizationId,
    p_bank_account_id: bankAccountId,
    p_statement: meta,
    p_transactions: transactions,
  });
  if (error) throw bookkeepingError(error);
  const row = (data ?? {}) as { inserted?: number; skipped?: number; statement_id?: UUID | null };
  return { inserted: row.inserted ?? 0, skipped: row.skipped ?? 0, statement_id: row.statement_id ?? null };
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


export async function convertAcceptedQuoteToInvoice(organizationId: UUID, quoteId: UUID): Promise<Invoice> {
  const { data, error } = await supabase.rpc('convert_accepted_quote_to_invoice', {
    p_quote_id: quoteId,
    p_organization_id: organizationId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Invoice;
}

export async function sendInvoiceEmailViaResend(organizationId: UUID, invoiceId: UUID, input: { recipientEmail?: string; recipientName?: string; subject?: string; includePaymentLink?: boolean } = {}): Promise<{ publicUrl?: string; providerEmailId?: string; paymentLinkIncluded?: boolean; paymentLinkError?: string | null }> {
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
  return data as { publicUrl?: string; providerEmailId?: string; paymentLinkIncluded?: boolean; paymentLinkError?: string | null };
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
    .select('organization_id,auto_reminders_enabled,level1_offset_days,level2_offset_days,level3_offset_days,include_payment_link,created_at,updated_at')
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

const SENDING_DOMAIN_COLUMNS = 'id,organization_id,created_by,domain,provider,resend_domain_id,region,from_email,from_name,status,dns_records,is_default,last_checked_at,verified_at,created_at,updated_at';

/**
 * Laad de gekoppelde verzenddomeinen van een organisatie (eigen-domein e-mail).
 * Alleen-lezen: aanmaken/verifiëren/verwijderen loopt via de `mail` Edge Function
 * (Resend-API), maar elk lid mag de status en DNS-records inzien (RLS: can_read_org).
 */
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
const CLIENT_EMAIL_COLUMNS = 'id,organization_id,created_by,thread_id,client_id,direction,provider,provider_email_id,from_email,from_name,to_email,subject,body_html,body_text,status,sent_at,delivered_at,opened_at,clicked_at,bounced_at,failed_at,complained_at,received_at,last_event_at,error_message,created_at,updated_at';

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

/** Laad alle e-mailberichten van een klant (uitgaand + inkomend), oplopend op tijd. */
export async function loadClientEmails(organizationId: UUID, clientId: UUID): Promise<ClientEmail[]> {
  const { data, error } = await supabase
    .from('client_emails')
    .select(CLIENT_EMAIL_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
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
