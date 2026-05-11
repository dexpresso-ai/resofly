export type UUID = string;
export type ClientStatus = 'active' | 'prospect' | 'inactive';
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type Priority = 'low' | 'med' | 'high';
export type TicketStatus = 'new' | 'review' | 'approved' | 'rejected' | 'converted';
export type FinanceStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'paid' | 'overdue' | 'cancelled';
export type NoteType = 'general' | 'meeting' | 'action' | 'decision' | 'idea' | 'support';
export type EntityType = 'client' | 'project' | 'task' | 'subtask' | 'ticket' | 'note' | 'quote' | 'invoice';
export type InvoiceTemplateKind = 'none' | 'pdf' | 'image';
export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
export type OrganizationMemberStatus = 'active' | 'disabled';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type LicenseStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';
export type AuditAction = 'created' | 'updated' | 'deleted' | 'invited' | 'accepted' | 'revoked' | 'role_changed' | 'disabled';

export interface Organization {
  id: UUID;
  name: string;
  slug: string;
  created_by: UUID | null;
  licensed_seats: number;
  license_status: LicenseStatus;
  license_provider: string | null;
  license_external_customer_id: string | null;
  license_external_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  id: UUID;
  organization_id: UUID;
  user_id: UUID;
  role: OrganizationRole;
  status: OrganizationMemberStatus;
  invited_by: UUID | null;
  joined_at: string;
  created_at: string;
  updated_at: string;
  email?: string | null;
}

export interface AuditLog {
  id: UUID;
  organization_id: UUID;
  actor_user_id: UUID | null;
  action: AuditAction | string;
  entity_type: string;
  entity_id: UUID | null;
  entity_label: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface OrganizationInvitation {
  id: UUID;
  organization_id: UUID;
  email: string;
  role: OrganizationRole;
  status: InvitationStatus;
  consumes_license: boolean;
  invited_by: UUID;
  accepted_by: UUID | null;
  accepted_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMembershipView extends OrganizationMember {
  organization: Organization;
}


export interface OrganizationLicenseUsage {
  organization_id: UUID;
  licensed_seats: number;
  active_members: number;
  pending_invitations: number;
  used_seats: number;
  available_seats: number;
  license_status: LicenseStatus;
}

export interface OrganizationContext {
  memberships: OrganizationMembershipView[];
  organizations: Organization[];
  activeOrganization: Organization | null;
  activeMembership: OrganizationMembershipView | null;
  teamMembers: OrganizationMember[];
  pendingInvitations: OrganizationInvitation[];
  organizationInvitations: OrganizationInvitation[];
  licenseUsage: OrganizationLicenseUsage | null;
  auditLogs: AuditLog[];
  billingOverview: OrganizationBillingOverview | null;
}

export interface OrgScopedRow {
  id: UUID;
  organization_id: UUID;
  created_by: UUID | null;
}

export interface Client extends OrgScopedRow {
  name: string; client_code: string | null; contact_name: string | null; email: string | null; phone: string | null; notes: string | null; color: string; status: ClientStatus; tags: string[]; follow_up: string | null; value_eur: number; created_at: string; updated_at: string;
}
export interface Project extends OrgScopedRow {
  client_id: UUID | null; name: string; description: string | null; color: string; archived: boolean; start_date: string | null; end_date: string | null; created_at: string; updated_at: string;
}
export interface Subtask { id: UUID; label: string; done: boolean; }
export interface Comment { id: UUID; text: string; author?: string; created_at: string; }
export interface Task extends OrgScopedRow {
  project_id: UUID; title: string; description: string | null; status: TaskStatus; priority: Priority; tags: string[]; start_date: string | null; end_date: string | null; subtasks: Subtask[]; comments: Comment[]; created_at: string; updated_at: string;
}
export interface Ticket extends OrgScopedRow {
  client_id: UUID | null; title: string; description: string | null; priority: Priority; status: TicketStatus; notes: string | null; converted_to_project_id: UUID | null; created_at: string; updated_at: string;
}
export interface Note extends OrgScopedRow {
  client_id: UUID | null; project_id: UUID | null; title: string; content: string; note_type: NoteType; tags: string[]; created_at: string; updated_at: string;
}
export interface FinanceLine { id: UUID; description: string; quantity: number; unit_price: number; vat: number; }
export interface Quote extends OrgScopedRow {
  client_id: UUID | null; project_id: UUID | null; number: string; date: string; valid_until: string | null; lines: FinanceLine[]; status: FinanceStatus; notes: string | null; sent_at: string | null; accepted_at: string | null; created_at: string; updated_at: string;
}
export interface Invoice extends OrgScopedRow {
  client_id: UUID | null; project_id: UUID | null; quote_id: UUID | null; number: string; date: string; due_date: string | null; lines: FinanceLine[]; status: FinanceStatus; notes: string | null; sent_at: string | null; paid_at: string | null; created_at: string; updated_at: string;
}
export interface Attachment extends OrgScopedRow {
  entity_type: EntityType; entity_id: UUID; parent_task_id: UUID | null; name: string; mime_type: string; size_bytes: number; storage_key: string; public_url: string | null; created_at: string;
}
export interface CompanySettings extends OrgScopedRow {
  company_name: string;
  trade_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  kvk_number: string | null;
  vat_number: string | null;
  iban: string | null;
  invoice_payment_terms: string | null;
  invoice_footer: string | null;
  invoice_template_kind: InvoiceTemplateKind;
  invoice_template_file_name: string | null;
  invoice_template_mime_type: string | null;
  invoice_template_file_size: number;
  invoice_template_data_url: string | null;
  invoice_template_text_color: string;
  invoice_accent_color: string;
  invoice_template_updated_at: string | null;
  created_at: string;
  updated_at: string;
}
export type CompanySettingsInput = Omit<CompanySettings, 'id' | 'organization_id' | 'created_by' | 'created_at' | 'updated_at'>;

export interface AppData { clients: Client[]; projects: Project[]; tasks: Task[]; tickets: Ticket[]; notes: Note[]; quotes: Quote[]; invoices: Invoice[]; attachments: Attachment[]; companySettings: CompanySettings | null; }

export type CalendarProvider = 'google' | 'microsoft';
export type CalendarConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';
export type CalendarVisibility = 'private' | 'organization';

export interface CalendarConnection {
  id: UUID;
  organization_id: UUID;
  user_id: UUID;
  provider: CalendarProvider;
  provider_account_id: string;
  provider_account_email: string | null;
  display_name: string | null;
  status: CalendarConnectionStatus;
  scopes: string[];
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarSource {
  id: UUID;
  organization_id: UUID;
  user_id: UUID;
  connection_id: UUID;
  provider: CalendarProvider;
  provider_calendar_id: string;
  name: string;
  description: string | null;
  color: string | null;
  timezone: string | null;
  is_primary: boolean;
  access_role: string | null;
  sync_enabled: boolean;
  write_enabled: boolean;
  visibility: CalendarVisibility;
  created_at: string;
  updated_at: string;
}

export interface CalendarExternalEvent {
  id: string;
  provider: CalendarProvider;
  source_id: UUID;
  source_name: string;
  provider_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  html_link: string | null;
  visibility: CalendarVisibility;
  is_private_masked?: boolean;
}

export type BillingPlanKey = 'starter' | 'team' | 'pro' | 'custom';
export type BillingSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'incomplete' | 'incomplete_expired' | 'paused';
export type BillingPaymentStatus = 'none' | 'open' | 'pending' | 'paid' | 'failed' | 'expired' | 'canceled' | 'authorized' | 'refunded' | 'charged_back';
export type MollieConnectStatus = 'not_connected' | 'pending' | 'connected' | 'mock_connected' | 'error' | 'revoked';

export interface BillingPlan {
  plan_key: BillingPlanKey;
  name: string;
  description: string | null;
  included_seats: number | null;
  monthly_price_cents: number;
  extra_seat_price_cents: number;
  currency: string;
  is_custom: boolean;
  is_active: boolean;
  sort_order: number;
  limits: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrganizationBillingProfile {
  id: UUID;
  organization_id: UUID;
  plan_key: BillingPlanKey;
  included_seats: number;
  purchased_seats: number;
  licensed_seats: number;
  subscription_status: BillingSubscriptionStatus;
  payment_status: BillingPaymentStatus;
  mollie_connect_status: MollieConnectStatus;
  mollie_connect_account_id: string | null;
  mollie_customer_id: string | null;
  mollie_mandate_id: string | null;
  mollie_subscription_id: string | null;
  last_payment_status: string | null;
  next_invoice_date: string | null;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
  billing_email: string | null;
  vat_number: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrganizationBillingOverview {
  organization_id: UUID;
  plan_key: BillingPlanKey;
  plan_name: string;
  included_seats: number;
  purchased_seats: number;
  licensed_seats: number;
  active_members: number;
  pending_invitations: number;
  used_seats: number;
  available_seats: number;
  subscription_status: BillingSubscriptionStatus;
  payment_status: BillingPaymentStatus;
  mollie_connect_status: MollieConnectStatus;
  mollie_customer_id: string | null;
  mollie_mandate_id: string | null;
  mollie_subscription_id: string | null;
  last_payment_status: string | null;
  next_invoice_date: string | null;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
  monthly_price_cents: number;
  extra_seat_price_cents: number;
  currency: string;
}

export interface BillingCheckoutResult {
  paymentId: string;
  providerPaymentId: string;
  checkoutUrl: string;
  mock: boolean;
  paymentType?: 'extra_seat' | 'plan_change';
  reused?: boolean;
}
