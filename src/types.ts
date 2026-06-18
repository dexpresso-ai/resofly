export type UUID = string;
export type ClientStatus = 'active' | 'prospect' | 'inactive';
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type Priority = 'low' | 'med' | 'high';
export type TicketStatus = 'new' | 'review' | 'approved' | 'rejected' | 'converted';
export type FinanceStatus = 'draft' | 'pending_internal_approval' | 'internally_approved' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'paid' | 'overdue' | 'cancelled';
export type InvoiceStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'cancelled' | 'void' | 'written_off' | 'refunded';
export type NoteType = 'general' | 'meeting' | 'action' | 'decision' | 'idea' | 'support';
export type DocumentType = 'contract' | 'general' | 'policy' | 'procedure' | 'other';
export type EntityType = 'client' | 'project' | 'task' | 'subtask' | 'ticket' | 'note' | 'document' | 'quote' | 'invoice' | 'folder' | 'supplier' | 'purchase_invoice' | 'fixed_asset';
export type QuoteApprovalStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type QuoteWorkflowEventType = 'created' | 'updated' | 'submitted_for_internal_approval' | 'internal_approval_granted' | 'internal_approval_rejected' | 'public_token_created' | 'sent_to_client' | 'email_sent' | 'email_delivered' | 'email_opened' | 'email_clicked' | 'email_bounced' | 'email_failed' | 'email_complained' | 'client_viewed' | 'client_accepted' | 'client_rejected' | 'quote_version_created' | 'quote_pdf_attached' | 'expired' | 'cancelled' | 'void' | 'written_off';
export type QuoteEmailDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'complained';
export type InvoiceEmailDeliveryStatus = QuoteEmailDeliveryStatus;
export type InvoiceWorkflowEventType = 'created_from_quote' | 'public_token_created' | 'public_link_created' | 'sent_to_client' | 'email_sent' | 'email_delivered' | 'email_opened' | 'email_clicked' | 'email_bounced' | 'email_failed' | 'email_complained' | 'client_viewed' | 'payment_link_created' | 'payment_open' | 'payment_paid' | 'payment_failed' | 'payment_expired' | 'invoice_version_created' | 'invoice_pdf_attached' | 'locked' | 'expired' | 'cancelled' | 'void' | 'written_off' | 'payment_refunded' | 'credit_note_issued' | 'payment_charged_back' | 'chargeback_reversed' | 'credit_note_emailed';
export type InvoiceVersionReason = 'sent_to_client' | 'payment_created' | 'paid' | 'manual';
export type InvoicePaymentStatus = 'creating' | 'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'expired' | 'canceled' | 'refunded' | 'charged_back';
export type InvoiceRefundKind = 'manual' | 'mollie';
export type InvoiceRefundStatus = 'queued' | 'pending' | 'processing' | 'refunded' | 'failed' | 'canceled';
export type InvoiceChargebackStatus = 'charged_back' | 'reversed';
export type CreditNoteStatus = 'draft' | 'issued' | 'void';
export type InvoiceTemplateKind = 'none' | 'pdf' | 'image';
export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
export type OrganizationMemberStatus = 'active' | 'disabled';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type LicenseStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';
export type AuditAction = 'created' | 'updated' | 'deleted' | 'invited' | 'accepted' | 'revoked' | 'role_changed' | 'disabled' | string;

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
  project_id: UUID; title: string; description: string | null; status: TaskStatus; priority: Priority; tags: string[]; start_date: string | null; end_date: string | null; planned_date: string | null; planned_order: number | null; estimated_minutes: number; subtasks: Subtask[]; comments: Comment[]; created_at: string; updated_at: string;
}
export interface Ticket extends OrgScopedRow {
  client_id: UUID | null; title: string; description: string | null; priority: Priority; status: TicketStatus; notes: string | null; converted_to_project_id: UUID | null; created_at: string; updated_at: string;
}
export type TicketNoteAuthorType = 'user' | 'client';
export interface TicketNote extends OrgScopedRow {
  ticket_id: UUID; author_type: TicketNoteAuthorType; author_user_id: UUID | null; author_name: string | null; body: string; is_internal: boolean; created_at: string; updated_at: string;
}
export interface Note extends OrgScopedRow {
  client_id: UUID | null; project_id: UUID | null; folder_id: UUID | null; title: string; content: string; note_type: NoteType; tags: string[]; created_at: string; updated_at: string;
}
export interface InternalDocument extends OrgScopedRow {
  client_id: UUID | null; project_id: UUID | null; folder_id: UUID | null; title: string; content: string; document_type: DocumentType; created_at: string; updated_at: string;
}
export interface ContentFolder extends OrgScopedRow {
  client_id: UUID | null; parent_id: UUID | null; name: string; position: number; created_at: string; updated_at: string;
}
export interface CalendarEventLink extends OrgScopedRow {
  provider: CalendarProvider;
  calendar_source_id: UUID;
  provider_calendar_id: string | null;
  provider_event_id: string;
  event_starts_at: string;
  event_title_snapshot: string | null;
  client_id: UUID | null;
  project_id: UUID | null;
  created_at: string;
  updated_at: string;
}
export interface CalendarEventLinkInput {
  provider: CalendarProvider;
  calendar_source_id: UUID;
  provider_calendar_id?: string | null;
  provider_event_id: string;
  event_starts_at: string;
  event_title_snapshot?: string | null;
  client_id: UUID | null;
  project_id: UUID | null;
}

export interface NoteCalendarLink extends OrgScopedRow {
  note_id: UUID;
  provider: CalendarProvider;
  calendar_source_id: UUID;
  provider_calendar_id: string | null;
  provider_event_id: string;
  event_starts_at: string;
  event_ends_at: string | null;
  event_title_snapshot: string | null;
  event_location_snapshot: string | null;
  event_html_link: string | null;
  visibility_snapshot: CalendarVisibility;
  is_private_masked_snapshot: boolean;
  created_at: string;
}

export interface CalendarNoteLinkInput {
  provider: CalendarProvider;
  calendar_source_id: UUID;
  provider_calendar_id?: string | null;
  provider_event_id: string;
  event_starts_at: string;
  event_ends_at?: string | null;
  event_title_snapshot?: string | null;
  event_location_snapshot?: string | null;
  event_html_link?: string | null;
  visibility_snapshot: CalendarVisibility;
  is_private_masked_snapshot: boolean;
}
export interface FinanceLine { id: UUID; description: string; quantity: number; unit_price: number; vat: number; }
export interface Quote extends OrgScopedRow {
  client_id: UUID | null;
  project_id: UUID | null;
  number: string;
  date: string;
  valid_until: string | null;
  lines: FinanceLine[];
  status: FinanceStatus;
  notes: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  internal_approval_status: QuoteApprovalStatus;
  internal_approval_requested_at: string | null;
  internal_approval_requested_by: UUID | null;
  internal_approved_at: string | null;
  internal_approved_by: UUID | null;
  internal_rejected_at: string | null;
  internal_rejected_by: UUID | null;
  internal_rejection_note: string | null;
  client_decision_at: string | null;
  client_decision_by_name: string | null;
  client_decision_by_email: string | null;
  client_decision_note: string | null;
  public_token_hash: string | null;
  public_token_created_at: string | null;
  public_token_expires_at: string | null;
  resend_last_email_id: string | null;
  last_email_delivery_status: QuoteEmailDeliveryStatus | null;
  last_email_delivery_at: string | null;
  last_email_opened_at: string | null;
  last_email_clicked_at: string | null;
  last_email_failed_at: string | null;
  latest_version_id: UUID | null;
  internal_approved_version_id: UUID | null;
  sent_version_id: UUID | null;
  accepted_version_id: UUID | null;
  accepted_sent_version_id: UUID | null;
  last_pdf_file_name: string | null;
  last_pdf_mime_type: string | null;
  last_pdf_size_bytes: number | null;
  last_pdf_sha256: string | null;
  created_at: string;
  updated_at: string;
}

export type QuoteVersionReason = 'internal_approval' | 'sent_to_client' | 'client_accepted' | 'manual';

export interface QuoteVersion {
  id: UUID;
  organization_id: UUID;
  quote_id: UUID;
  delivery_id: UUID | null;
  accepted_sent_version_id: UUID | null;
  version_number: number;
  snapshot_reason: QuoteVersionReason | string;
  status_at_snapshot: FinanceStatus | string;
  internal_approval_status_at_snapshot: QuoteApprovalStatus | string | null;
  quote_number: string;
  client_id: UUID | null;
  project_id: UUID | null;
  quote_date: string;
  valid_until: string | null;
  notes: string | null;
  subtotal_amount: number;
  vat_amount: number;
  total_amount: number;
  quote_version_pdf_url: string | null;
  pdf_file_name: string | null;
  pdf_mime_type: string | null;
  pdf_size_bytes: number | null;
  pdf_sha256: string | null;
  snapshot_data: Record<string, unknown>;
  created_by: UUID | null;
  created_at: string;
}

export interface QuoteVersionItem {
  id: UUID;
  organization_id: UUID;
  quote_id: UUID;
  quote_version_id: UUID;
  source_line_id: string | null;
  line_index: number;
  description: string;
  quantity: number;
  unit_price: number;
  vat_percentage: number;
  line_subtotal: number;
  line_vat: number;
  line_total: number;
  created_at: string;
}

export interface QuoteApprovalEvent {
  id: UUID;
  organization_id: UUID;
  quote_id: UUID;
  actor_user_id: UUID | null;
  event_type: QuoteWorkflowEventType | string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface QuoteEmailDelivery {
  id: UUID;
  organization_id: UUID;
  quote_id: UUID;
  provider: 'resend' | string;
  provider_email_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  status: QuoteEmailDeliveryStatus;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  failed_at: string | null;
  complained_at: string | null;
  last_event_at: string | null;
  quote_version_id: UUID | null;
  attachment_file_name: string | null;
  attachment_mime_type: string | null;
  attachment_size_bytes: number | null;
  attachment_sha256: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface Invoice extends OrgScopedRow {
  client_id: UUID | null;
  project_id: UUID | null;
  quote_id: UUID | null;
  number: string;
  date: string;
  due_date: string | null;
  lines: FinanceLine[];
  status: InvoiceStatus;
  notes: string | null;
  sent_at: string | null;
  paid_at: string | null;
  source_quote_version_id?: UUID | null;
  subtotal_amount?: number;
  vat_amount?: number;
  total_amount?: number;
  currency?: string;
  refunded_amount?: number;
  refunded_at?: string | null;
  charged_back_amount?: number;
  charged_back_at?: string | null;
  locked_at?: string | null;
  locked_reason?: string | null;
  public_token_hash?: string | null;
  public_token_created_at?: string | null;
  public_token_expires_at?: string | null;
  resend_last_email_id?: string | null;
  last_email_delivery_status?: InvoiceEmailDeliveryStatus | null;
  last_email_delivery_at?: string | null;
  last_email_opened_at?: string | null;
  last_email_clicked_at?: string | null;
  last_email_failed_at?: string | null;
  reminder_level?: number;
  last_reminder_at?: string | null;
  reminders_paused?: boolean;
  latest_version_id?: UUID | null;
  sent_version_id?: UUID | null;
  paid_version_id?: UUID | null;
  last_pdf_file_name?: string | null;
  last_pdf_mime_type?: string | null;
  last_pdf_size_bytes?: number | null;
  last_pdf_sha256?: string | null;
  journal_entry_id?: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceReminderSettings {
  organization_id: UUID;
  auto_reminders_enabled: boolean;
  level1_offset_days: number;
  level2_offset_days: number;
  level3_offset_days: number;
  include_payment_link: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface InvoiceWorkflowEvent {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  actor_user_id: UUID | null;
  event_type: InvoiceWorkflowEventType | string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InvoiceEmailDelivery {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  provider: 'resend' | string;
  provider_email_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  status: InvoiceEmailDeliveryStatus;
  delivery_kind?: 'invoice' | 'reminder';
  reminder_level?: number | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  failed_at: string | null;
  complained_at: string | null;
  last_event_at: string | null;
  invoice_version_id: UUID | null;
  attachment_file_name: string | null;
  attachment_mime_type: string | null;
  attachment_size_bytes: number | null;
  attachment_sha256: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface InvoicePaymentRecord {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  provider: 'mollie' | string;
  provider_payment_id: string | null;
  provider_checkout_url: string | null;
  idempotency_key: string | null;
  status: InvoicePaymentStatus;
  amount_cents: number;
  amount_refunded_cents: number;
  currency: string;
  checkout_expires_at: string | null;
  paid_at: string | null;
  last_webhook_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_by: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceVersion {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  delivery_id: UUID | null;
  payment_record_id: UUID | null;
  version_number: number;
  snapshot_reason: InvoiceVersionReason | string;
  status_at_snapshot: FinanceStatus | string;
  invoice_number: string;
  client_id: UUID | null;
  project_id: UUID | null;
  quote_id: UUID | null;
  invoice_date: string | null;
  due_date: string | null;
  notes: string | null;
  subtotal_amount: number;
  vat_amount: number;
  total_amount: number;
  invoice_version_pdf_url: string | null;
  pdf_file_name: string | null;
  pdf_mime_type: string | null;
  pdf_size_bytes: number | null;
  pdf_sha256: string | null;
  pdf_data_base64?: string | null;
  pdf_storage_provider?: string | null;
  pdf_storage_key?: string | null;
  is_immutable?: boolean;
  snapshot_data: Record<string, unknown>;
  created_by: UUID | null;
  created_at: string;
}
export interface InvoiceRefund {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  payment_record_id: UUID | null;
  kind: InvoiceRefundKind;
  provider: string;
  provider_refund_id: string | null;
  status: InvoiceRefundStatus;
  amount_cents: number;
  currency: string;
  reason: string | null;
  credit_note_id: UUID | null;
  idempotency_key: string | null;
  refunded_at: string | null;
  failed_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  initiated_by: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceChargeback {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  payment_record_id: UUID | null;
  provider: string;
  provider_chargeback_id: string | null;
  status: InvoiceChargebackStatus;
  amount_cents: number;
  settlement_amount_cents: number | null;
  currency: string;
  reason: string | null;
  charged_back_at: string;
  reversed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreditNote {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  refund_id: UUID | null;
  number: string;
  date: string;
  reason: string | null;
  currency: string;
  subtotal_amount: number;
  vat_amount: number;
  total_amount: number;
  lines: FinanceLine[];
  status: CreditNoteStatus;
  pdf_file_name: string | null;
  pdf_mime_type: string | null;
  pdf_size_bytes: number | null;
  pdf_sha256: string | null;
  pdf_storage_provider: string | null;
  pdf_storage_key: string | null;
  issued_by: UUID | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Boekhouding (dubbel boekhouden): grootboek, BTW-codes, journaalposten, inkoop.
// ---------------------------------------------------------------------------
export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type VatCodeKind =
  | 'standard' | 'reduced' | 'zero' | 'exempt'
  | 'reverse_charge_sales' | 'reverse_charge_purchase'
  | 'icp_goods' | 'icp_services' | 'eu_acquisition' | 'kor';
export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';
export type JournalSourceType =
  | 'sales_invoice' | 'purchase_invoice' | 'asset_depreciation'
  | 'vat_return' | 'payment' | 'opening_balance' | 'manual';
export type PurchaseInvoiceStatus = 'draft' | 'booked' | 'paid' | 'cancelled';
export type PurchaseInvoicePaymentStatus = 'unpaid' | 'partially_paid' | 'paid';
export type SupplierStatus = 'active' | 'inactive';

export interface LedgerAccount extends OrgScopedRow {
  code: string;
  name: string;
  type: LedgerAccountType;
  subtype: string | null;
  default_vat_code: string | null;
  is_system: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VatCode extends OrgScopedRow {
  code: string;
  label: string;
  rate: number;
  kind: VatCodeKind;
  sales_box: string | null;
  vat_box: string | null;
  is_system: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface JournalEntry extends OrgScopedRow {
  entry_number: string | null;
  date: string;
  year: number;
  quarter: number;
  month: number;
  description: string | null;
  source_type: JournalSourceType;
  source_id: UUID | null;
  status: JournalEntryStatus;
  reverses_entry_id: UUID | null;
  reversed_by_entry_id: UUID | null;
  posted_at: string | null;
  posted_by: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface JournalLine {
  id: UUID;
  organization_id: UUID;
  entry_id: UUID;
  account_id: UUID;
  line_index: number;
  description: string | null;
  debit_cents: number;
  credit_cents: number;
  vat_code: string | null;
  vat_rate: number | null;
  vat_base_cents: number | null;
  vat_amount_cents: number | null;
  client_id: UUID | null;
  supplier_id: UUID | null;
  project_id: UUID | null;
  created_at: string;
}

export interface ClosedPeriod {
  id: UUID;
  organization_id: UUID;
  year: number;
  quarter: number;
  closed_at: string;
  closed_by: UUID | null;
  created_at: string;
}

export interface Supplier extends OrgScopedRow {
  name: string;
  supplier_code: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  vat_number: string | null;
  kvk_number: string | null;
  iban: string | null;
  default_expense_account_id: UUID | null;
  default_vat_code: string | null;
  notes: string | null;
  status: SupplierStatus;
  created_at: string;
  updated_at: string;
}

/** Inkoopfactuur-regel: bedrag excl. btw in centen, met doelrekening + btw-code. */
export interface PurchaseInvoiceLine {
  id: UUID;
  description: string;
  amount_cents: number;
  vat_code: string;
  vat_rate: number;
  account_id: UUID | null;
}

export interface PurchaseInvoice extends OrgScopedRow {
  supplier_id: UUID | null;
  supplier_invoice_number: string | null;
  internal_number: string | null;
  date: string;
  due_date: string | null;
  lines: PurchaseInvoiceLine[];
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  currency: string;
  status: PurchaseInvoiceStatus;
  payment_status: PurchaseInvoicePaymentStatus;
  paid_at: string | null;
  project_id: UUID | null;
  journal_entry_id: UUID | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type FixedAssetStatus = 'active' | 'fully_depreciated' | 'disposed';
export type DepreciationStatus = 'scheduled' | 'posted';

export interface FixedAsset extends OrgScopedRow {
  name: string;
  asset_number: string | null;
  category: string | null;
  acquisition_date: string;
  acquisition_cost_cents: number;
  residual_value_cents: number;
  useful_life_months: number;
  method: string;
  start_date: string;
  asset_account_id: UUID;
  depreciation_account_id: UUID;
  accumulated_depreciation_account_id: UUID;
  source_purchase_invoice_id: UUID | null;
  status: FixedAssetStatus;
  disposal_date: string | null;
  disposal_proceeds_cents: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetDepreciation {
  id: UUID;
  organization_id: UUID;
  asset_id: UUID;
  period_index: number;
  year: number;
  month: number;
  date: string;
  amount_cents: number;
  accumulated_after_cents: number;
  book_value_after_cents: number;
  journal_entry_id: UUID | null;
  status: DepreciationStatus;
  posted_at: string | null;
  created_at: string;
}

/** Regel uit report_profit_and_loss. amount_cents is positief georiënteerd per soort. */
export interface ProfitAndLossRow {
  account_id: UUID | null;
  code: string | null;
  name: string;
  account_type: 'revenue' | 'expense';
  amount_cents: number;
}

/** Regel uit report_balance_sheet. 'result' is het cumulatieve onverdeelde resultaat. */
export interface BalanceSheetRow {
  account_id: UUID | null;
  code: string | null;
  name: string;
  section: 'asset' | 'liability' | 'equity' | 'result';
  amount_cents: number;
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
  invoice_font_size: number;
  invoice_template_updated_at: string | null;
  bookkeeping_start_date: string | null;
  kor_enabled: boolean;
  created_at: string;
  updated_at: string;
}
export type CompanySettingsInput = Omit<CompanySettings, 'id' | 'organization_id' | 'created_by' | 'created_at' | 'updated_at'>;

// Per-organisatie aanpasbare e-mailteksten. De sleutels komen exact overeen met de
// template_key-waarden in de email_templates-tabel en de Edge Function-registry.
// Herinneringen hebben een sleutel per niveau zodat de toon per niveau verschilt.
export type EmailTemplateKey =
  | 'quote.sent'
  | 'invoice.sent'
  | 'invoice.reminder.1'
  | 'invoice.reminder.2'
  | 'invoice.reminder.3'
  | 'creditNote.sent';

export interface EmailTemplate extends OrgScopedRow {
  template_key: EmailTemplateKey;
  enabled: boolean;
  subject: string | null;
  intro: string | null;
  closing: string | null;
  cta_label: string | null;
}

export type EmailTemplateInput = {
  enabled: boolean;
  subject: string | null;
  intro: string | null;
  closing: string | null;
  cta_label: string | null;
};

export type InvoiceMollieConnectionStatus = 'not_connected' | 'connected' | 'revoked';
export interface InvoiceMollieSettingsStatus {
  status: InvoiceMollieConnectionStatus;
  mode: 'test' | 'live' | null;
  key_suffix: string | null;
  connected_at: string | null;
  last_validated_at: string | null;
}

export interface AppData { clients: Client[]; projects: Project[]; tasks: Task[]; tickets: Ticket[]; ticketNotes: TicketNote[]; notes: Note[]; documents: InternalDocument[]; folders: ContentFolder[]; noteCalendarLinks: NoteCalendarLink[]; calendarEventLinks: CalendarEventLink[]; quotes: Quote[]; quoteApprovalEvents: QuoteApprovalEvent[]; quoteEmailDeliveries: QuoteEmailDelivery[]; quoteVersions: QuoteVersion[]; invoices: Invoice[]; invoiceWorkflowEvents: InvoiceWorkflowEvent[]; invoiceEmailDeliveries: InvoiceEmailDelivery[]; invoicePaymentRecords: InvoicePaymentRecord[]; invoiceVersions: InvoiceVersion[]; invoiceRefunds: InvoiceRefund[]; creditNotes: CreditNote[]; invoiceChargebacks: InvoiceChargeback[]; ledgerAccounts: LedgerAccount[]; vatCodes: VatCode[]; journalEntries: JournalEntry[]; journalLines: JournalLine[]; closedPeriods: ClosedPeriod[]; suppliers: Supplier[]; purchaseInvoices: PurchaseInvoice[]; fixedAssets: FixedAsset[]; assetDepreciations: AssetDepreciation[]; attachments: Attachment[]; companySettings: CompanySettings | null; }

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
