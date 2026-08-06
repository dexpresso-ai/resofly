import type { ReportDefinition } from './lib/reporting';

export type UUID = string;
export type ClientStatus = 'active' | 'prospect' | 'inactive';
export type ClientKind = 'business' | 'consumer';
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type Priority = 'low' | 'med' | 'high';
export type TicketStatus = 'new' | 'review' | 'approved' | 'rejected' | 'converted';
export type FinanceStatus = 'draft' | 'pending_internal_approval' | 'internally_approved' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'paid' | 'overdue' | 'cancelled';
export type InvoiceStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'cancelled' | 'void' | 'written_off' | 'refunded';
export type NoteType = 'general' | 'meeting' | 'action' | 'decision' | 'idea' | 'support';
export type DocumentType = 'contract' | 'general' | 'policy' | 'procedure' | 'other';
export type EntityType = 'client' | 'project' | 'task' | 'subtask' | 'ticket' | 'note' | 'document' | 'quote' | 'invoice' | 'folder' | 'supplier' | 'purchase_invoice' | 'fixed_asset' | 'meeting_recording' | 'chat_message';
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
  /** Rechtenniveau per module (none/read/write). Ontbrekende sleutel = volledig.
   *  Zie src/lib/permissions.ts; genegeerd voor owners en admins. */
  module_access?: Record<string, string> | null;
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
  /** Modulerechten die het teamlid krijgt zodra het de uitnodiging accepteert. */
  module_access?: Record<string, string> | null;
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
  billing_exempt: boolean;
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
  /** Creatieve module: leesbaar voor elk teamlid, anders dan billingOverview. */
  creativeStatus: OrganizationCreativeStatus | null;
}

export interface OrgScopedRow {
  id: UUID;
  organization_id: UUID;
  created_by: UUID | null;
}

export type ContractStatus =
  | 'draft'
  | 'pending_internal_approval'
  | 'internally_approved'
  | 'sent'
  | 'signed'
  | 'declined'
  | 'expired'
  | 'voided';

export interface Contract extends OrgScopedRow {
  client_id: UUID | null;
  quote_id: UUID | null;
  number: string;
  title: string;
  body: string;
  date: string;
  valid_until: string | null;
  status: ContractStatus;
  internal_approval_status: 'draft' | 'pending' | 'approved' | 'rejected';
  public_token_expires_at: string | null;
  sent_at: string | null;
  signed_at: string | null;
  signed_document_sha256: string | null;
  signed_storage_provider: 'r2' | 'database' | null;
  signed_pdf_file_name: string | null;
  signed_pdf_size_bytes: number | null;
  resend_last_email_id: string | null;
  last_email_delivery_status: string | null;
  last_email_delivery_at: string | null;
  last_email_failed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  supersedes_contract_id: UUID | null;
  amount_cents: number | null;
  currency: string;
  template_id: UUID | null;
  /**
   * 'office' = de inhoud is een .docx op R2 (`body_storage_key`), bewerkt in
   * Collabora; `body` blijft dan leeg. 'richtext' = de oude HTML in `body`.
   * Bestaande contracten blijven 'richtext' — een getekend contract wordt nooit
   * omgezet.
   */
  editor_mode: ContractEditorMode;
  body_storage_key: string | null;
  body_mime_type: string | null;
  body_size_bytes: number | null;
  edit_version: number;
  last_edited_by: UUID | null;
  last_edited_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ContractEditorMode = 'richtext' | 'office';

/** Koppeling contract ↔ project (meerdere projecten per contract, en omgekeerd). */
export interface ContractProject extends OrgScopedRow {
  contract_id: UUID;
  project_id: UUID;
  created_at: string;
}

export interface ContractSigner extends OrgScopedRow {
  contract_id: UUID;
  name: string;
  email: string;
  role: 'client' | 'internal_countersignature';
  signing_order: number;
  status: 'pending' | 'signed' | 'declined';
  signed_at: string | null;
  decline_reason: string | null;
  signature_method: 'typed' | 'drawn' | null;
  signed_ip: string | null;
  signed_user_agent: string | null;
  consent_text: string | null;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractEvent {
  id: UUID;
  organization_id: UUID;
  contract_id: UUID;
  actor_user_id: UUID | null;
  event_type: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ContractInternalNote extends OrgScopedRow {
  contract_id: UUID;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface ContractTemplate extends OrgScopedRow {
  name: string;
  body: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContractVersion {
  id: UUID;
  organization_id: UUID;
  contract_id: UUID;
  version_number: number;
  snapshot_reason: string;
  title: string;
  body: string;
  amount_cents: number | null;
  currency: string | null;
  created_by: UUID | null;
  created_at: string;
  /** Word-contracten: de PDF zoals verstuurd is de momentopname (er is geen HTML-body). */
  pdf_storage_key: string | null;
  pdf_sha256: string | null;
  pdf_size_bytes: number | null;
}

export interface Client extends OrgScopedRow {
  name: string; client_code: string | null; contact_name: string | null; email: string | null; phone: string | null; notes: string | null; color: string; status: ClientStatus; client_kind: ClientKind; tags: string[]; follow_up: string | null; value_eur: number; vat_number: string | null; kvk_number: string | null; address_line1: string | null; address_line2: string | null; postal_code: string | null; city: string | null; country: string | null; created_at: string; updated_at: string;
}
export interface ClientContact extends OrgScopedRow {
  client_id: UUID; name: string; email: string; phone: string | null; role: string | null; gives_portal_access: boolean; is_active: boolean; created_at: string; updated_at: string;
}

// ── E-mailmarketing / campagnes ─────────────────────────────────────────────
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'cancelled';
export interface CampaignAudience {
  /** 'filter' = op status/tags (leeg = alle klanten); 'manual' = handmatig gekozen klanten. */
  mode: 'filter' | 'manual';
  statuses: ClientStatus[];
  tags: string[];
  includeContacts: boolean;
  manualClientIds: UUID[];
}
export interface EmailCampaign extends OrgScopedRow {
  name: string; subject: string; preheader: string | null; body_html: string; body_text: string | null; accent_color: string | null; audience: CampaignAudience; status: CampaignStatus; scheduled_at: string | null; started_at: string | null; sent_at: string | null; created_at: string; updated_at: string;
}
export type CampaignRecipientStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'complained' | 'skipped' | 'unsubscribed';
export interface EmailCampaignRecipient extends OrgScopedRow {
  campaign_id: UUID; client_id: UUID | null; contact_id: UUID | null; to_email: string; to_name: string | null; thread_id: UUID | null; client_email_id: UUID | null; status: CampaignRecipientStatus; sent_at: string | null; delivered_at: string | null; opened_at: string | null; clicked_at: string | null; bounced_at: string | null; failed_at: string | null; replied_at: string | null; unsubscribed_at: string | null; error_message: string | null; created_at: string; updated_at: string;
}
export interface EmailCampaignStats {
  organization_id: UUID; campaign_id: UUID; total: number; sent: number; delivered: number; opened: number; clicked: number; replied: number; bounced: number; failed: number; unsubscribed: number; pending: number;
}
export type EmailSuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';
export interface EmailSuppression {
  organization_id: UUID; email: string; reason: EmailSuppressionReason; source: string | null; created_by: UUID | null; created_at: string;
}
export interface CampaignAudiencePreview {
  total: number; sendable: number; suppressed: number; withoutEmail: number; matchedClients: number; sample: { email: string; name: string | null }[];
}

// ── Follow-up-stromen ───────────────────────────────────────────────────────
export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type FlowStopCondition = 'reply' | 'open_click_reply' | 'click_reply';
export interface EmailFlow extends OrgScopedRow {
  name: string; status: FlowStatus; audience: CampaignAudience; stop_condition: FlowStopCondition; created_at: string; updated_at: string;
}
export interface EmailFlowStep {
  id: UUID; organization_id: UUID; flow_id: UUID; step_index: number; delay_days: number; subject: string; preheader: string | null; body_html: string; body_text: string | null; accent_color: string | null; created_at: string; updated_at: string;
}
export type FlowEnrollmentStatus = 'active' | 'completed' | 'stopped_reacted' | 'stopped_unsubscribed' | 'cancelled';
export interface EmailFlowEnrollment {
  id: UUID; organization_id: UUID; flow_id: UUID; client_id: UUID | null; contact_id: UUID | null; to_email: string; to_name: string | null; thread_id: UUID | null; status: FlowEnrollmentStatus; current_step_index: number; next_step_due_at: string | null; last_reply_at: string | null; enrolled_at: string; completed_at: string | null; created_at: string; updated_at: string;
}
export interface EmailFlowStats {
  organization_id: UUID; flow_id: UUID; enrollments: number; active: number; completed: number; stopped_reacted: number; stopped_unsubscribed: number; cancelled: number;
}
export interface EmailFlowStepStats {
  organization_id: UUID; flow_id: UUID; step_index: number; sent: number; opened: number; clicked: number; replied: number; bounced: number;
}
/** Bewerkbare stap-invoer voor de editor (nog zonder db-id/timestamps). */
export interface FlowStepInput {
  step_index: number; delay_days: number; subject: string; preheader?: string | null; body_html: string; body_text?: string | null; accent_color?: string | null;
}

/** Persoonlijke afzender van een teamlid (naam + optioneel adres op een geverifieerd org-domein). */
export interface UserSenderIdentity {
  organization_id: UUID; user_id: UUID; from_name: string | null; from_email: string | null; created_at: string; updated_at: string;
}
export type ProjectBillingType = 'hourly' | 'fixed_price';
export interface Project extends OrgScopedRow {
  client_id: UUID | null; name: string; description: string | null; color: string; archived: boolean; start_date: string | null; end_date: string | null; contract_id: UUID | null; hourly_rate_cents: number | null; billing_type: ProjectBillingType; budgeted_minutes: number | null; created_at: string; updated_at: string;
}
export interface Subtask { id: UUID; label: string; done: boolean; }
export interface Comment { id: UUID; text: string; author?: string; created_at: string; }
export interface Task extends OrgScopedRow {
  /** Optioneel: een taak kan los bestaan (bijv. snel toegevoegd in de weekplanner) en pas later aan een project worden gekoppeld. */
  project_id: UUID | null; client_id: UUID | null; title: string; description: string | null; status: TaskStatus; priority: Priority; tags: string[]; start_date: string | null; end_date: string | null; planned_date: string | null; planned_order: number | null; estimated_minutes: number; subtasks: Subtask[]; comments: Comment[]; created_at: string; updated_at: string;
}
// ── Projectsjablonen ────────────────────────────────────────────────────────
// Vaste werkwijze van een organisatie voor één soort project, één keer
// vastgelegd en bij elk nieuw project uit te rollen.

/** Subtaak in een sjabloon. Bewust zonder `done`: een sjabloon heeft geen voortgang. */
export interface TemplateSubtask { id: UUID; label: string; }

export interface ProjectTemplate extends OrgScopedRow {
  name: string; description: string | null; is_active: boolean; created_at: string; updated_at: string;
}

/**
 * Standaardtaak binnen een sjabloon. Datums staan relatief vast als dagoffsets
 * t.o.v. de startdatum van het project (`due_offset_days: 14` = twee weken na
 * de start); null laat die datum bij het uitrollen leeg.
 */
export interface ProjectTemplateTask extends OrgScopedRow {
  template_id: UUID; position: number; title: string; description: string | null; status: TaskStatus; priority: Priority; tags: string[];
  start_offset_days: number | null; due_offset_days: number | null; planned_offset_days: number | null;
  estimated_minutes: number; subtasks: TemplateSubtask[]; created_at: string; updated_at: string;
}

/** Bewerkbare sjabloontaak in de editor (nog zonder db-id/timestamps). */
export interface ProjectTemplateTaskInput {
  id?: UUID; position: number; title: string; description: string | null; status: TaskStatus; priority: Priority; tags: string[];
  start_offset_days: number | null; due_offset_days: number | null; planned_offset_days: number | null;
  estimated_minutes: number; subtasks: TemplateSubtask[];
}

/** Koppeling van een organisatielid aan een project ("projectteam"). */
export interface ProjectMember extends OrgScopedRow {
  project_id: UUID; user_id: UUID; created_at: string;
}
/** Toewijzing van een organisatielid aan een taak (meerdere per taak mogelijk). */
export interface TaskAssignee extends OrgScopedRow {
  task_id: UUID; user_id: UUID; created_at: string;
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
  /** Word-modus: is `storage_key` gezet, dan is dit een .docx op R2 (Collabora/WOPI) i.p.v. rich-text; `content` is dan een tekst-spiegel voor previews/zoeken. */
  storage_key?: string | null; mime_type?: string | null; size_bytes?: number | null; edit_version?: number; last_edited_by?: UUID | null; last_edited_at?: string | null;
}
export interface ContentFolder extends OrgScopedRow {
  client_id: UUID | null;
  /** null = map op klantniveau; gevuld = map binnen die projectmap. Vast na aanmaken. */
  project_id: UUID | null;
  parent_id: UUID | null; name: string; position: number; created_at: string; updated_at: string;
}

// ── Galerij-oplevering (foto/video per project) ─────────────────────────────
export type GalleryStatus = 'draft' | 'published' | 'archived';
/** Bepaalt de weergave bij de klant én welke media er in de galerij mogen. */
export type GalleryFormat = 'photo' | 'video' | 'hybrid';
/**
 * Opening van de galerij. De hero-foto is `cover_item_id`.
 * Basis: full/minimal · Modern: editorial/frame/split ·
 * Klassiek: classic/collage · Spectaculair: cinematic/mosaic.
 */
export type GalleryHeroTemplate =
  | 'full' | 'minimal'
  | 'editorial' | 'frame' | 'split'
  | 'classic' | 'collage'
  | 'cinematic' | 'mosaic' | 'netflix';

/** Huisstijl van de organisatie, zoals de klant de galerij ziet. */
export interface GalleryBranding {
  logoDataUrl: string | null;
  accentColor: string;
  footerText: string | null;
  hidePoweredBy: boolean;
  companyName: string | null;
  headingFont: string;
  bodyFont: string;
  galleryBg: string;
}

/** Categorie binnen één galerij (bijv. Ceremonie, Diner, Feest). */
export interface GalleryCategory extends OrgScopedRow {
  gallery_id: UUID;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Standaardcategorie op organisatieniveau; landt in elke nieuwe galerij. */
export interface GalleryCategoryPreset extends OrgScopedRow {
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}
export type GalleryDownloadQuality = 'original' | 'web';
export type GalleryMediaType = 'photo' | 'video';
export type GalleryStreamStatus = 'uploading' | 'processing' | 'ready' | 'error';

export interface Gallery extends OrgScopedRow {
  project_id: UUID;
  title: string;
  description: string | null;
  format: GalleryFormat;
  hero_template: GalleryHeroTemplate;
  status: GalleryStatus;
  published_at: string | null;
  cover_item_id: UUID | null;
  allow_downloads: boolean;
  download_quality: GalleryDownloadQuality;
  share_enabled: boolean;
  /** Alleen de SHA-256-hash; het token zelf bestaat alleen op het moment van genereren. */
  share_token_hash: string | null;
  share_pin_hash: string | null;
  share_pin_failed_count: number;
  share_pin_locked_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GalleryItem extends OrgScopedRow {
  gallery_id: UUID;
  category_id: UUID | null;
  media_type: GalleryMediaType;
  file_name: string;
  content_type: string | null;
  size_bytes: number;
  derived_bytes: number;
  storage_key: string | null;
  preview_key: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  stream_uid: string | null;
  stream_status: GalleryStreamStatus | null;
  stream_playback_base: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Accountbreed opslagverbruik + limiet (RPC organization_storage_status). limit_bytes null = geen limiet. */
export interface OrganizationStorageStatus {
  used_bytes: number;
  attachments_bytes: number;
  documents_bytes: number;
  recordings_bytes: number;
  gallery_bytes: number;
  limit_bytes: number | null;
  plan_storage_gb: number | null;
  storage_addons: number;
  storage_addon_gb: number | null;
}

/** favorite = persoonlijke selectie van de kijker; like = zichtbare waardering. */
export type GalleryReaction = 'favorite' | 'like';

export interface GalleryFavorite {
  id: UUID;
  organization_id: UUID;
  gallery_id: UUID;
  item_id: UUID;
  reaction: GalleryReaction;
  actor_kind: 'portal_contact' | 'share_link';
  contact_id: UUID | null;
  session_key: string | null;
  actor_label: string | null;
  created_at: string;
}
export interface CalendarEventLink extends OrgScopedRow {
  provider: CalendarProvider;
  calendar_source_id: UUID;
  provider_calendar_id: string | null;
  provider_event_id: string;
  event_starts_at: string;
  event_ends_at: string | null;
  event_all_day: boolean;
  event_title_snapshot: string | null;
  client_id: UUID | null;
  project_id: UUID | null;
  /** Telt dit gekoppelde agenda-item mee voor de urenregistratie? Standaard aan. */
  track_time: boolean;
  created_at: string;
  updated_at: string;
}
export interface CalendarEventLinkInput {
  provider: CalendarProvider;
  calendar_source_id: UUID;
  provider_calendar_id?: string | null;
  provider_event_id: string;
  event_starts_at: string;
  event_ends_at?: string | null;
  event_all_day?: boolean;
  event_title_snapshot?: string | null;
  client_id: UUID | null;
  project_id: UUID | null;
  track_time?: boolean;
}

export type TimeEntrySource = 'manual' | 'calendar' | 'timer';
/** Urencriterium: 'direct' = klantwerk, 'indirect' = administratie/acquisitie/reistijd/scholing. Beide tellen mee voor de 1225 uur. */
export type TimeEntryType = 'direct' | 'indirect';
/** Soort indirect werk, voor de uitsplitsing op het urendashboard. */
export type IndirectHoursCategory = 'admin' | 'acquisition' | 'travel' | 'education' | 'other';

/**
 * Geregistreerde uren. Enige bron van waarheid voor het uren-dashboard en de
 * uren-stat op het project. Posten met source='calendar' worden server-side
 * afgeleid/gesynchroniseerd uit een calendar_event_link (DB-trigger) en zijn in
 * de UI alleen-lezen; 'manual' en 'timer' maakt de gebruiker zelf aan.
 */
export interface TimeEntry extends OrgScopedRow {
  user_id: UUID;
  project_id: UUID | null;
  client_id: UUID | null;
  source: TimeEntrySource;
  calendar_event_link_id: UUID | null;
  description: string | null;
  entry_date: string;
  started_at: string | null;
  ended_at: string | null;
  minutes: number;
  billable: boolean;
  /** Urentype voor het urencriterium (1225 u/kalenderjaar) — los van `billable`. */
  entry_type: TimeEntryType;
  indirect_category: IndirectHoursCategory | null;
  hourly_rate_cents: number | null;
  created_at: string;
  updated_at: string;
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
// vat_code is optioneel: verwijst naar vat_codes.code van de organisatie en maakt
// 0%-regels ondubbelzinnig voor de UBL-e-factuur (nul/verlegd/ICP/vrijgesteld).
// Zonder code leidt de UBL-generator de categorie af uit het kale percentage.
export interface FinanceLine { id: UUID; description: string; quantity: number; unit_price: number; vat: number; vat_code?: string | null; }
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
  dunning_enabled?: boolean;
  dunning_offset_days?: number;
  dunning_collection_costs_vat?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type DunningNoticeStatus = 'proposed' | 'confirmed' | 'sent' | 'failed' | 'cancelled';

export interface DunningNotice {
  id: UUID;
  organization_id: UUID;
  invoice_id: UUID;
  stage: 'wik_14day';
  client_kind: ClientKind;
  interest_kind: 'consumer' | 'commercial';
  principal_cents: number;
  interest_cents: number;
  interest_days: number;
  daily_interest_cents: number;
  collection_costs_cents: number;
  collection_costs_vat_cents: number;
  total_claim_cents: number;
  calculation_date: string;
  due_date: string | null;
  deadline_date: string | null;
  rate_snapshot: Record<string, unknown>;
  status: DunningNoticeStatus;
  delivery_id: UUID | null;
  public_url: string | null;
  error_message: string | null;
  proposed_at: string;
  confirmed_at: string | null;
  sent_at: string | null;
  created_by: UUID | null;
  confirmed_by: UUID | null;
  created_at: string;
  updated_at: string;
}

// Eigen-domein e-mail: per organisatie een bij Resend geverifieerd verzenddomein.
export type SendingDomainStatus = 'pending' | 'verified' | 'failed' | 'temporary_failure';

export interface SendingDomainDnsRecord {
  record?: string;
  type: string;
  name: string;
  value: string;
  ttl?: string | number;
  priority?: number | null;
  status?: string;
}

export interface SendingDomain extends OrgScopedRow {
  domain: string;
  provider: string;
  resend_domain_id: string | null;
  region: string | null;
  from_email: string | null;
  from_name: string | null;
  status: SendingDomainStatus;
  dns_records: SendingDomainDnsRecord[];
  is_default: boolean;
  last_checked_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

// Vrije klant-mail: conversaties en berichten (uitgaand nu, inkomend in fase C).
export type ClientEmailDirection = 'outbound' | 'inbound';
export type ClientEmailStatus = 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'complained' | 'received';

export interface ClientEmailThread extends OrgScopedRow {
  client_id: UUID;
  subject: string;
  last_message_at: string;
  last_direction: ClientEmailDirection;
  created_at: string;
  updated_at: string;
}

export interface ClientEmail extends OrgScopedRow {
  thread_id: UUID;
  client_id: UUID;
  direction: ClientEmailDirection;
  provider: string;
  provider_email_id: string | null;
  from_email: string;
  from_name: string | null;
  to_email: string;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  status: ClientEmailStatus;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  failed_at: string | null;
  complained_at: string | null;
  received_at: string | null;
  last_event_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// Ongelezen inkomend bericht voor de huidige gebruiker (view client_email_unread).
export interface ClientEmailUnread {
  id: UUID;
  organization_id: UUID;
  client_id: UUID;
  thread_id: UUID;
  subject: string;
  from_email: string;
  from_name: string | null;
  received_at: string | null;
  created_at: string;
}

// Ongelezen-tellers: totaal (globale badge) + per klant (klantenlijst/tab).
export interface ClientEmailUnreadCounts {
  total: number;
  byClient: Record<UUID, number>;
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
  delivery_kind?: 'invoice' | 'reminder' | 'dunning';
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
  /** Grootboekkoppeling (post_credit_note_to_ledger); null = nog niet geboekt. */
  journal_entry_id?: UUID | null;
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
  | 'icp_goods' | 'icp_services' | 'eu_acquisition' | 'kor' | 'import_non_eu';
export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';
export type JournalSourceType =
  | 'sales_invoice' | 'purchase_invoice' | 'asset_depreciation' | 'asset_acquisition'
  | 'vat_return' | 'payment' | 'opening_balance' | 'manual' | 'year_close' | 'credit_note';
export type PurchaseInvoiceStatus = 'draft' | 'booked' | 'paid' | 'cancelled';
export type PurchaseInvoicePaymentStatus = 'unpaid' | 'partially_paid' | 'paid';
/** Herkomst van de inkoopfactuur: handmatig, door AI uitgelezen, bank of import. */
export type PurchaseInvoiceSource = 'manual' | 'ai_scan' | 'bank' | 'import';
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
  /** 'month' | 'quarter' | 'year' — sinds fase 4 een datumbereik i.p.v. enkel kwartaal. */
  period_type: 'month' | 'quarter' | 'year';
  quarter: number | null;
  month: number | null;
  period_start: string | null;
  period_end: string | null;
  closed_at: string;
  closed_by: UUID | null;
  created_at: string;
}

/** Een boekjaar (open of afgesloten). Mutatie loopt via de fiscal-year-RPC's. */
export interface FiscalYear {
  id: UUID;
  organization_id: UUID;
  created_by: UUID | null;
  label: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  close_journal_entry_id: UUID | null;
  result_account_code: string | null;
  result_cents: number | null;
  closed_at: string | null;
  closed_by: UUID | null;
  reopened_at: string | null;
  reopened_by: UUID | null;
  created_at: string;
  updated_at: string;
}

/** Rij uit list_fiscal_years: boekjaar + server-side (her)berekend resultaat. */
export interface FiscalYearListRow {
  id: UUID;
  label: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  result_cents: number | null;
  close_journal_entry_id: UUID | null;
  computed_result_cents: number;
  has_entries: boolean;
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
  /** Herkomst; 'ai_scan' als de factuur door de AI-scan is uitgelezen. */
  source: PurchaseInvoiceSource;
  /** AI-extractie-metadata (model, confidence, ruwe uitlezing) — alleen bij source='ai_scan'. */
  extraction_meta: Record<string, unknown> | null;
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
  acquisition_journal_entry_id: UUID | null;
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

/** Regel uit report_trial_balance (proef-/saldibalans). Over het geheel geldt Σdebit = Σcredit. */
export interface TrialBalanceRow {
  account_id: UUID;
  code: string;
  name: string;
  account_type: LedgerAccountType;
  debit_cents: number;
  credit_cents: number;
  balance_cents: number;
}

/** Regel uit report_account_ledger (grootboekkaart). De beginsaldo-regel heeft entry_id/date = null. */
export interface AccountLedgerRow {
  entry_id: UUID | null;
  entry_number: string | null;
  date: string | null;
  description: string | null;
  debit_cents: number;
  credit_cents: number;
  running_balance_cents: number;
}

export type VatReturnPeriodType = 'monthly' | 'quarterly';
export type VatReturnStatus = 'draft' | 'finalized' | 'filed' | 'paid';

/** Rubriektotalen uit compute_vat_return (bedragen in centen). */
/** Eén aangifterubriek in centen: grondslag + (waar van toepassing) btw. */
export interface VatReturnBox { base: number; vat?: number }

export interface VatReturnRubrieken {
  omzet_hoog_base: number;
  omzet_hoog_btw: number;
  omzet_laag_base: number;
  omzet_laag_btw: number;
  omzet_nul_base: number;
  verlegd_btw: number;
  verschuldigd_total: number;
  voorbelasting: number;
  saldo: number;
  /** Saldo afgerond op hele euro's (het bedrag dat werkelijk wordt afgedragen/teruggevraagd). Ontbreekt bij aangiftes van vóór deze afronding werd toegevoegd. */
  saldo_afgerond?: number;
  /** saldo - saldo_afgerond; geboekt op 4900 Afrondingsverschillen bij het doorboeken. */
  afronding_cents?: number;
  /** Volledige rubriekverdeling (1a–1e, 2a, 3a–3c, 4a/4b) in centen — sinds Blok C. Oudere snapshots hebben dit niet. */
  boxes?: Record<string, VatReturnBox>;
  /** Formulierwaarden in HELE EURO'S per rubriek + 5a/5b/5c, zoals in te vullen bij de Belastingdienst. */
  form?: Record<string, VatReturnBox | number>;
  /** Sluit de rubriek-metadata aan op het grootboek (1510+1520)? Zo niet, dan valt saldo_afgerond terug op afronding-op-het-totaal. */
  boxes_consistent?: boolean;
  boxes_vat_diff_cents?: number;
  clear_output?: number;
  clear_reverse?: number;
  clear_input?: number;
  /** Alleen op suppletie-rijen: de verrekende boekstukken. */
  is_supplement?: boolean;
  entry_ids?: UUID[];
}

/** Koppelrij: welk boekstuk is in welke btw-suppletie verrekend. */
export interface VatSupplementEntry {
  id: UUID;
  organization_id: UUID;
  supplement_id: UUID;
  entry_id: UUID;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Openstaande posten (report_open_items) en ICP-opgaaf (compute_icp_declaration).
// ---------------------------------------------------------------------------
export interface OpenReceivableRow {
  invoice_id: UUID; number: string | null; date: string; due_date: string | null;
  client_id: UUID | null; client_name: string | null;
  booked_cents: number; paid_cents: number; credited_cents: number; open_cents: number;
}
export interface OpenPayableRow {
  purchase_invoice_id: UUID; number: string | null; date: string; due_date: string | null;
  supplier_id: UUID | null; supplier_name: string | null;
  booked_cents: number; paid_cents: number; open_cents: number;
}
export interface OpenItemsSide<T> {
  rows: T[];
  open_total_cents: number;
  gl_balance_cents: number;
  /** Beweging op 1300/1600 die niet aan een factuur toe te rekenen is (beginbalans, vrije boekingen). */
  unmatched_cents: number;
}
export interface OpenItemsReport {
  as_of: string;
  receivables: OpenItemsSide<OpenReceivableRow>;
  payables: OpenItemsSide<OpenPayableRow>;
}

export interface IcpDeclarationRow {
  client_id: UUID | null; client_name: string; vat_number: string | null; country: string | null;
  goods_cents: number; services_cents: number;
}
export interface IcpDeclaration {
  rows: IcpDeclarationRow[];
  goods_total_cents: number;
  services_total_cents: number;
  total_cents: number;
  unassigned_cents: number;
  missing_vat_numbers: number;
}

export interface VatReturn {
  id: UUID;
  organization_id: UUID;
  created_by: UUID | null;
  /** In de database: 'month' | 'quarter' (de instelling gebruikt 'monthly'/'quarterly'). */
  period_type: 'month' | 'quarter';
  year: number;
  period_index: number;
  period_start: string;
  period_end: string;
  status: VatReturnStatus;
  rubrieken: VatReturnRubrieken;
  journal_entry_id: UUID | null;
  supplements_return_id: UUID | null;
  /** De banktransactie die de betaling/teruggave afletterde en de aangifte op 'paid' zette. */
  paid_bank_transaction_id: UUID | null;
  notes: string | null;
  finalized_at: string | null;
  /** Attestatie bij periode-afsluiting: moment + gebruiker die bevestigde de OB-aangifte zelf te hebben ingediend. */
  filed_at: string | null;
  filed_by: UUID | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Bankfeed: bankrekeningen, transacties en regels (automatisch journaliseren).
// ---------------------------------------------------------------------------
export type BankAccountSource = 'import' | 'gocardless' | 'enablebanking';
export type BankStatementFormat = 'camt053' | 'mt940' | 'csv' | 'gocardless';
export type BankTransactionStatus = 'unmatched' | 'suggested' | 'booked' | 'ignored';
export type BankRuleDirection = 'in' | 'out' | 'both';

export type BankRequisitionStatus = 'created' | 'linked' | 'expired' | 'error';

export interface BankAccount extends OrgScopedRow {
  name: string;
  iban: string | null;
  currency: string;
  ledger_account_id: UUID;
  source: BankAccountSource;
  provider: string | null;
  external_account_id: string | null;
  bank_requisition_id: UUID | null;
  last_synced_at: string | null;
  last_imported_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BankRequisition extends OrgScopedRow {
  provider: 'gocardless' | 'enablebanking';
  institution_id: string;
  institution_name: string | null;
  institution_country: string | null;
  reference: string;
  requisition_id: string | null;
  link: string | null;
  status: BankRequisitionStatus;
  accounts: string[];
  error: string | null;
  linked_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Bank (ASPSP) zoals de provider die teruggeeft bij de bankkiezer. */
export interface BankInstitution {
  id: string;
  name: string;
  bic: string | null;
  logo: string | null;
  transaction_total_days: number | null;
}

export interface BankStatement {
  id: UUID;
  organization_id: UUID;
  created_by: UUID | null;
  bank_account_id: UUID;
  format: BankStatementFormat;
  file_name: string | null;
  file_hash: string | null;
  period_start: string | null;
  period_end: string | null;
  opening_balance_cents: number | null;
  closing_balance_cents: number | null;
  transaction_count: number;
  imported_at: string;
  created_at: string;
}

export interface BankTransaction {
  id: UUID;
  organization_id: UUID;
  bank_account_id: UUID;
  statement_id: UUID | null;
  dedup_key: string;
  booking_date: string;
  value_date: string | null;
  /** Signed: positief = ontvangen, negatief = betaald. In hele centen. */
  amount_cents: number;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  structured_reference: string | null;
  end_to_end_id: string | null;
  bank_tx_id: string | null;
  status: BankTransactionStatus;
  suggested_account_id: UUID | null;
  suggested_vat_code: string | null;
  matched_rule_id: UUID | null;
  match_confidence: string | null;
  matched_invoice_id: UUID | null;
  matched_purchase_invoice_id: UUID | null;
  journal_entry_id: UUID | null;
  booked_at: string | null;
  booked_by: UUID | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BankRule extends OrgScopedRow {
  name: string;
  priority: number;
  match_direction: BankRuleDirection;
  match_counterparty_iban: string | null;
  match_counterparty_name_contains: string | null;
  match_description_contains: string | null;
  match_amount_cents: number | null;
  target_account_id: UUID | null;
  target_vat_code: string | null;
  set_supplier_id: UUID | null;
  set_client_id: UUID | null;
  auto_book: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Genormaliseerde transactie zoals een parser die aanlevert aan import_bank_transactions. */
export interface ParsedBankTransaction {
  // Géén dedup_key: die wordt sinds migratie 20260721010000 uitsluitend
  // server-side afgeleid (import_bank_transactions), zodat de afschrift-import
  // en de PSD2-sync per definitie dezelfde sleutel produceren.
  booking_date: string;
  value_date: string | null;
  amount_cents: number;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  structured_reference: string | null;
  end_to_end_id: string | null;
  bank_tx_id: string | null;
}

export interface ParsedBankStatement {
  format: BankStatementFormat;
  file_name: string | null;
  file_hash: string | null;
  period_start: string | null;
  period_end: string | null;
  opening_balance_cents: number | null;
  closing_balance_cents: number | null;
  /** Waarschuwingen van de parser (overgeslagen regels, niet-herkende kolommen). Getoond na de import. */
  warnings: string[];
  transactions: ParsedBankTransaction[];
}

/** Eén regel uit report_bank_reconciliation: sluit de bank aan op het grootboek. */
export interface BankReconciliation {
  bank_account_id: UUID;
  name: string;
  iban: string | null;
  source: BankAccountSource;
  ledger_code: string;
  ledger_name: string;
  /** Meerdere bankrekeningen boeken op dezelfde grootboekrekening → per rekening aansluiten kan niet. */
  shares_ledger_account: boolean;
  /** Peildatum = einde van het laatste afschrift mét eindsaldo; null als dat er niet is. */
  as_of: string | null;
  statement_id: UUID | null;
  statement_closing_cents: number | null;
  ledger_balance_cents: number;
  has_opening_balance: boolean;
  unbooked_count: number;
  unbooked_sum_cents: number;
  ignored_count: number;
  ignored_sum_cents: number;
  booked_count: number;
  expected_cents: number;
  /** Afschriftsaldo − (grootboekstand + nog niet geboekt). 0 = sluitend; null = geen afschriftsaldo bekend. */
  difference_cents: number | null;
  duplicate_suspects: number;
  statement_issues: Array<{
    statement_id: UUID;
    file_name: string | null;
    period_start: string | null;
    period_end: string | null;
    opening_balance_cents: number;
    closing_balance_cents: number;
    transactions_sum_cents: number;
    difference_cents: number;
  }>;
}

export interface Attachment extends OrgScopedRow {
  entity_type: EntityType; entity_id: UUID; parent_task_id: UUID | null; name: string; mime_type: string; size_bytes: number; storage_key: string; public_url: string | null; created_at: string;
  /** Online Office-bewerken: oplopend versienummer + laatst-bewerkt + zachte lock. Alleen gevuld voor office-bestanden die via de editor bewerkt zijn. */
  edit_version?: number; last_edited_by?: UUID | null; last_edited_at?: string | null; locked_by?: UUID | null; locked_at?: string | null;
}

// ── Teamchat (interne chat tussen organisatieleden) ──────────────────────────
export type ChatConversationKind = 'dm' | 'channel';
export type ChatParticipantRole = 'member' | 'admin';

export interface ChatConversation {
  id: UUID;
  organization_id: UUID;
  kind: ChatConversationKind;
  title: string | null;
  description: string | null;
  /** DM-only: de twee user-id's gesorteerd ("a:b"); uniek per organisatie. */
  dm_key: string | null;
  is_archived: boolean;
  last_message_at: string | null;
  created_by: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface ChatParticipant {
  conversation_id: UUID;
  organization_id: UUID;
  user_id: UUID;
  role: ChatParticipantRole;
  /** Laatste keer dat dit lid het gesprek opende — drijft ongelezen + leesbevestiging. */
  last_read_at: string;
  joined_at: string;
}

export interface ChatMessage {
  id: UUID;
  organization_id: UUID;
  conversation_id: UUID;
  sender_id: UUID | null;
  body: string;
  mentions: UUID[];
  attachment_count: number;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageReaction {
  message_id: UUID;
  conversation_id: UUID;
  organization_id: UUID;
  user_id: UUID;
  emoji: string;
  created_at: string;
}

export interface ChatUnreadCount {
  conversation_id: UUID;
  unread_count: number;
}

// ── Meeting-opnames + AI-notulen ─────────────────────────────────────────────
export type MeetingRecordingStatus = 'uploaded' | 'transcribing' | 'transcribed' | 'summarizing' | 'done' | 'error';

/** Eén spreker-gelabeld segment uit het ElevenLabs-transcript. */
export interface MeetingTranscriptSegment { speaker: string | null; text: string; start: number | null; end: number | null }

/** Gestructureerde notulen die Claude teruggeeft. */
export interface MeetingSummary {
  samenvatting: string;
  besproken: string[];
  besluiten: string[];
  actiepunten: string[];
  vervolgafspraken: string[];
}

export interface MeetingRecording extends OrgScopedRow {
  created_by: UUID | null;
  provider: CalendarProvider | 'native' | null;
  source_id: UUID | null;
  event_ref: string | null;
  event_title_snapshot: string | null;
  client_id: UUID | null;
  project_id: UUID | null;
  storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  consent_given: boolean;
  consent_at: string | null;
  status: MeetingRecordingStatus;
  error_message: string | null;
  elevenlabs_request_id: string | null;
  language: string | null;
  transcript_text: string | null;
  transcript_json: MeetingTranscriptSegment[] | null;
  transcription_cost_usd: number;
  summary_text: string | null;
  summary_json: MeetingSummary | null;
  /** Wanneer de notulen voor het laatst naar de genodigden zijn gemaild. */
  summary_sent_at: string | null;
  /** Ontvangers van de laatste notulen-mail. */
  summary_recipients: { email: string; name: string | null }[] | null;
  created_at: string;
  updated_at: string;
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
  vat_return_period: VatReturnPeriodType;
  /** Startmaand van het boekjaar (1 = januari). Ondersteunt gebroken boekjaren. */
  fiscal_year_start_month: number;
  /** Grootboekcode waar het jaarresultaat bij afsluiting heen wordt geboekt (default 0510). */
  year_result_account_code: string;
  /** Bedrijfsbreed standaard uurtarief (centen) — fallback als een project geen eigen tarief heeft. */
  default_hourly_rate_cents: number | null;
  /** Huisstijl op klantgerichte pagina's (galerij). Logo als data-URL: de
   *  publieke galerijpagina heeft geen sessie en dus geen media-token. */
  brand_logo_data_url: string | null;
  brand_accent_color: string;
  brand_footer_text: string | null;
  brand_hide_powered_by: boolean;
  /** Sleutels uit de lettertypelijst in src/lib/branding.ts, nooit rauwe CSS. */
  brand_heading_font: string;
  brand_body_font: string;
  /** Achtergrond van de galerij; de frontend leidt er het contrastpalet uit af. */
  brand_gallery_bg: string;
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
  | 'creditNote.sent'
  | 'contract.sent'
  | 'contract.signed.client'
  | 'meetingBooking.linkSent'
  | 'meetingBooking.confirmed';

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

// Zelfbouw-rapportbouwer (fase 2): een opgeslagen rapport bewaart de pure
// JSON-`ReportDefinition`; de aggregatie-engine draait volledig client-side.
export interface SavedReport extends OrgScopedRow {
  name: string;
  definition: ReportDefinition;
  is_pinned: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface AppData { clients: Client[]; clientContacts: ClientContact[]; projects: Project[]; projectTemplates: ProjectTemplate[]; projectTemplateTasks: ProjectTemplateTask[]; tasks: Task[]; projectMembers: ProjectMember[]; taskAssignees: TaskAssignee[]; contractProjects: ContractProject[]; tickets: Ticket[]; ticketNotes: TicketNote[]; notes: Note[]; documents: InternalDocument[]; folders: ContentFolder[]; noteCalendarLinks: NoteCalendarLink[]; calendarEventLinks: CalendarEventLink[]; timeEntries: TimeEntry[]; quotes: Quote[]; quoteApprovalEvents: QuoteApprovalEvent[]; quoteEmailDeliveries: QuoteEmailDelivery[]; quoteVersions: QuoteVersion[]; invoices: Invoice[]; invoiceWorkflowEvents: InvoiceWorkflowEvent[]; invoiceEmailDeliveries: InvoiceEmailDelivery[]; invoicePaymentRecords: InvoicePaymentRecord[]; invoiceVersions: InvoiceVersion[]; invoiceRefunds: InvoiceRefund[]; creditNotes: CreditNote[]; invoiceChargebacks: InvoiceChargeback[]; dunningNotices: DunningNotice[]; ledgerAccounts: LedgerAccount[]; vatCodes: VatCode[]; journalEntries: JournalEntry[]; journalLines: JournalLine[]; closedPeriods: ClosedPeriod[]; fiscalYears: FiscalYear[]; suppliers: Supplier[]; purchaseInvoices: PurchaseInvoice[]; fixedAssets: FixedAsset[]; assetDepreciations: AssetDepreciation[]; vatReturns: VatReturn[]; bankAccounts: BankAccount[]; bankStatements: BankStatement[]; bankTransactions: BankTransaction[]; bankRules: BankRule[]; bankRequisitions: BankRequisition[]; attachments: Attachment[]; galleries: Gallery[]; savedReports: SavedReport[]; companySettings: CompanySettings | null; }

export type CalendarProvider = 'google' | 'microsoft' | 'native' | 'ics';
export type CalendarConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';
export type CalendarVisibility = 'private' | 'organization';

/** Eenvoudige herhaling voor native ResoFly-agenda-items (fase 0). */
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';
export interface EventRecurrence {
  freq: RecurrenceFrequency;
  interval?: number;
  /** ISO-datum/tijd waarop de herhaling stopt (inclusief). */
  until?: string | null;
  count?: number | null;
}

export interface CalendarAppPassword {
  id: UUID;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type AttendeeStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative';

export interface CalendarEventAttendee {
  id: UUID;
  email: string;
  display_name: string | null;
  role: 'req' | 'opt';
  status: AttendeeStatus;
  invited_at: string | null;
  responded_at: string | null;
}

/** Invoer voor een genodigde bij het aanmaken/bewerken van een afspraak. */
export interface AttendeeInput {
  email: string;
  name?: string | null;
  role?: 'req' | 'opt';
}

/** Compacte genodigde-weergave op een agenda-item (o.a. van Google/Microsoft). */
export interface EventAttendeeLite {
  email: string;
  name: string | null;
  status: AttendeeStatus;
}

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
  connection_id: UUID | null;
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
  /** Alleen voor provider='ics' (agenda via iCal/ICS-link): de feed + sync-status. */
  feed_url?: string | null;
  feed_last_synced_at?: string | null;
  feed_last_error?: string | null;
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
  /** Videocall-link (Google Meet / Teams / Zoom / overig), indien aan dit item gekoppeld. */
  meeting_url?: string | null;
  /** Genodigden zoals bekend bij de provider (alleen extern Google/Microsoft; native via getCalendarEventAttendees). */
  attendees?: EventAttendeeLite[] | null;
  visibility: CalendarVisibility;
  is_private_masked?: boolean;
  /** Alleen voor native ResoFly-agenda-items: de database-id van het item (voor bewerken/verwijderen). */
  native_event_id?: UUID;
  /** RRULE-string van een herhalend native item, indien van toepassing. */
  rrule?: string | null;
  recurs?: boolean;
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
  yearly_price_cents: number;
  extra_seat_yearly_price_cents: number;
  currency: string;
  is_custom: boolean;
  is_active: boolean;
  sort_order: number;
  limits: Record<string, unknown>;
  storage_addon_price_cents?: number;
  storage_addon_yearly_price_cents?: number;
  creative_addon_price_cents?: number;
  creative_addon_yearly_price_cents?: number;
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
  billing_exempt: boolean;
  billing_interval: 'month' | 'year';
  yearly_price_cents: number;
  extra_seat_yearly_price_cents: number;
  /** Opslagbundels (accountbrede opslag): aantal + limieten + prijzen. Optioneel
   *  zolang de gallery-migratie nog niet overal is toegepast. */
  storage_addons?: number;
  plan_storage_gb?: number | null;
  storage_addon_gb?: number;
  storage_addon_price_cents?: number;
  storage_addon_yearly_price_cents?: number;
  storage_limit_gb?: number | null;
  storage_used_bytes?: number;
  /** Creatieve module (galerij-oplevering) als betaalde optie op het abonnement.
   *  Optioneel zolang migratie 20260806000000 nog niet overal is toegepast. */
  creative_enabled?: boolean;
  creative_included_in_plan?: boolean;
  creative_active?: boolean;
  creative_grace_until?: string | null;
  creative_addon_price_cents?: number;
  creative_addon_yearly_price_cents?: number;
}

/**
 * Entitlement van de creatieve module, leesbaar voor ELK teamlid (het
 * billingoverzicht is alleen voor owners/admins). Bepaalt of het galerij-tabblad
 * bestaat en of er nog geschreven mag worden.
 */
export interface OrganizationCreativeStatus {
  /** Mag er gewerkt worden: toevoegen, wijzigen, publiceren. */
  active: boolean;
  /** De losse add-on staat aan. */
  enabled: boolean;
  /** De module zit in het plan (custom-contract) of in een vrijstelling. */
  included_in_plan: boolean;
  /** Module uit, maar gedeelde links leven nog tot grace_until. */
  in_grace: boolean;
  grace_until: string | null;
  addon_price_cents: number;
  addon_yearly_price_cents: number;
  billing_interval: 'month' | 'year';
}

export interface BillingCheckoutResult {
  // Checkout-URL voor een eerste betaling (abonnement starten). Afwezig wanneer de
  // wijziging direct op een lopend mandaat is toegepast.
  checkoutUrl?: string;
  // True wanneer de seat-/planwijziging direct is toegepast (geen checkout nodig).
  applied?: boolean;
  mock?: boolean;
  providerPaymentId?: string;
  status?: string;
  paymentType?: 'extra_seat' | 'plan_change' | 'subscription';
}

// ── Meeting Booking Tool (Calendly-achtig) ──────────────────────────────────

export type MeetingBookingLinkStatus = 'active' | 'closed';
export type MeetingBookingSlotStatus = 'open' | 'pending' | 'booked' | 'cancelled';
export type MeetingBookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'failed';

export interface MeetingBookingLink {
  id: UUID;
  organization_id: UUID;
  user_id: UUID | null;
  client_id: UUID | null;
  source_id: UUID | null;
  title: string;
  intro_text: string | null;
  invite_message: string | null;
  meeting_url: string | null;
  max_total_bookings: number;
  max_per_week: number;
  auto_conference: boolean;
  status: MeetingBookingLinkStatus;
  public_token_hash: string | null;
  public_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Boekingslink verrijkt met afgeleide velden voor de lijstweergave. */
export interface MeetingBookingLinkListItem extends MeetingBookingLink {
  client_name: string | null;
  source_name: string | null;
  source_provider: CalendarProvider | null;
  booking_count: number;
  needs_reconnect: boolean;
}

export interface MeetingBookingSlot {
  id: UUID;
  booking_link_id: UUID;
  organization_id: UUID;
  starts_at: string;
  ends_at: string;
  status: MeetingBookingSlotStatus;
  pending_at: string | null;
  created_at: string;
}

export interface MeetingBooking {
  id: UUID;
  booking_link_id: UUID;
  slot_id: UUID;
  organization_id: UUID;
  client_id: UUID | null;
  booked_name: string | null;
  booked_email: string;
  native_event_id: UUID | null;
  external_event_id: string | null;
  external_provider: 'google' | 'microsoft' | null;
  status: MeetingBookingStatus;
  created_at: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
}
