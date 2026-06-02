import { supabase, supabaseAuth } from './supabase';
import { recordInvitationBlockedBySeats } from '../services/licenseService';
import { deleteR2Object } from './r2-api';
import type {
  AppData,
  AuditLog,
  Attachment,
  Client,
  CompanySettings,
  CompanySettingsInput,
  EntityType,
  Invoice,
  InvoiceEmailDelivery,
  InvoicePaymentRecord,
  InvoiceVersion,
  InvoiceWorkflowEvent,
  InvoiceMollieSettingsStatus,
  Note,
  CalendarNoteLinkInput,
  NoteCalendarLink,
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
  Task,
  Ticket,
  UUID,
} from '../types';

const tables = ['clients', 'projects', 'tasks', 'tickets', 'notes', 'quotes', 'invoices', 'attachments', 'company_settings'] as const;
export type Table = typeof tables[number];

type AttachmentRef = Pick<Attachment, 'id' | 'storage_key'>;

type MembershipRow = OrganizationMember & { organization: Organization | Organization[] | null };

const tableToEntity: Record<Table, EntityType | null> = {
  clients: 'client',
  projects: 'project',
  tasks: 'task',
  tickets: 'ticket',
  notes: 'note',
  quotes: 'quote',
  invoices: 'invoice',
  attachments: null,
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
    notes,
    noteCalendarLinks,
    quotes,
    quoteApprovalEvents,
    quoteEmailDeliveries,
    quoteVersions,
    invoices,
    invoiceWorkflowEvents,
    invoiceEmailDeliveries,
    invoicePaymentRecords,
    invoiceVersions,
    attachments,
    companySettings,
  ] = await Promise.all([
    select<Client>('clients', organizationId), select<Project>('projects', organizationId), select<Task>('tasks', organizationId), select<Ticket>('tickets', organizationId),
    select<Note>('notes', organizationId), selectNoteCalendarLinks(organizationId), select<Quote>('quotes', organizationId), selectQuoteApprovalEvents(organizationId), selectQuoteEmailDeliveries(organizationId), selectQuoteVersions(organizationId), select<Invoice>('invoices', organizationId),
    selectInvoiceWorkflowEvents(organizationId), selectInvoiceEmailDeliveries(organizationId), selectInvoicePaymentRecords(organizationId), selectInvoiceVersions(organizationId),
    select<Attachment>('attachments', organizationId),
    loadCompanySettings(organizationId),
  ]);
  return { clients, projects, tasks, tickets, notes, noteCalendarLinks, quotes, quoteApprovalEvents, quoteEmailDeliveries, quoteVersions, invoices, invoiceWorkflowEvents, invoiceEmailDeliveries, invoicePaymentRecords, invoiceVersions, attachments, companySettings };
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
