/**
 * Het logboek leesbaar maken: van een regel uit audit_logs naar een zin in
 * gewone taal ("Anne verstuurde factuur 2026-014"), de wijzigingen per veld
 * ("Status: Concept → Verzonden"), de soorten voor het filter en de dagen in
 * de tijdlijn.
 *
 * Wat erin staat, schrijft de database (migratie 20261108100000): de triggers
 * op de tabellen en de functies rond facturen, offertes en betalingen. Wie
 * welke regel leest, beslist de database ook (per module, net als de rest).
 * Hier alleen het rekenwerk, zonder React of Supabase, zodat `npm test` het
 * kan nalopen.
 */
import type { AuditLog, OrganizationMember, UUID } from '../types';

// ── De regel ────────────────────────────────────────────────────────────────

export type AuditVia = 'app' | 'koppeling' | 'systeem';

/** Eén veld: van oud naar nieuw, of alleen dát het veranderde. */
export interface AuditFieldChange {
  old?: unknown;
  new?: unknown;
  changed?: boolean;
  count?: boolean;
}

export interface AuditEntry {
  id: UUID;
  createdAt: string;
  lastAt: string;
  count: number;
  actorId: UUID | null;
  actorLabel: string | null;
  via: AuditVia;
  action: string;
  entityType: string;
  entityId: UUID | null;
  entityLabel: string | null;
  clientId: UUID | null;
  projectId: UUID | null;
  metadata: Record<string, unknown>;
  /** Per veld; leeg bij regels van vóór 20261108100000 (dan alleen changedColumns). */
  changes: Record<string, AuditFieldChange>;
  changedColumns: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function toAuditEntry(row: AuditLog): AuditEntry {
  const metadata = isObject(row.metadata) ? row.metadata : {};
  const rawChanges = isObject(metadata.changes) ? metadata.changes : {};
  const changes: Record<string, AuditFieldChange> = {};
  for (const [key, value] of Object.entries(rawChanges)) if (isObject(value)) changes[key] = value as AuditFieldChange;
  const changedColumns = Array.isArray(metadata.changed_columns) ? metadata.changed_columns.map(String) : [];
  const via: AuditVia = row.via === 'koppeling' || row.via === 'systeem' ? row.via : row.actor_user_id ? 'app' : 'systeem';
  return {
    id: row.id,
    createdAt: row.created_at,
    lastAt: row.last_at ?? row.created_at,
    count: Math.max(1, Number(row.event_count ?? 1) || 1),
    actorId: row.actor_user_id ?? null,
    actorLabel: row.actor_label ?? null,
    via,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id ?? null,
    entityLabel: row.entity_label ?? null,
    clientId: row.client_id ?? null,
    projectId: row.project_id ?? null,
    metadata,
    changes,
    changedColumns,
  };
}

// ── Soorten (het filter en het icoon) ───────────────────────────────────────

/** De soorten in het filter: de modules, plus het team en het beheer. */
export type AuditCategory =
  | 'clients' | 'projects' | 'time' | 'calendar' | 'tickets' | 'content' | 'stats' | 'marketing' | 'finance'
  | 'team' | 'admin';

/**
 * Bij welke module een soort regel hoort — dezelfde indeling als
 * audit_entity_module() in de database en AUDIT_ENTITY_MODULE in
 * supabase/functions/_shared/actions/admin.ts (auditLog.test.ts houdt ze
 * gelijk). `null` = het team en de organisatie, 'admin' = beheer.
 */
export const AUDIT_ENTITY_MODULE: Readonly<Record<string, string | null>> = {
  member: null, organization: null,
  api_key: 'admin', webhook_endpoint: 'admin', invitation: 'admin', calendar_connection: 'admin', mollie_connection: 'admin', subscription: 'admin',
  billing_profile: 'admin', billing_event: 'admin', payment: 'admin', license_change: 'admin', license_event: 'admin', email_template: 'admin',
  annual_account: 'finance', annual_account_filing: 'finance', annual_account_signature: 'finance', bank_account: 'finance',
  bank_rule: 'finance', bank_transaction: 'finance', company_settings: 'finance', contract: 'finance', contract_note: 'finance', contract_project: 'finance',
  contract_template: 'finance', corporate_tax_return: 'finance', credit_note: 'finance', dividend_distribution: 'finance',
  fiscal_year: 'finance', fiscal_year_size_input: 'finance', fixed_asset: 'finance', invoice: 'finance', journal_entry: 'finance',
  ledger_account: 'finance', partnership_partner: 'finance', purchase_invoice: 'finance', quote: 'finance', result_appropriation: 'finance',
  share_transaction: 'finance', shareholder: 'finance', supplier: 'finance', vat_return: 'finance',
  calendar_event: 'calendar', calendar_event_link: 'calendar', calendar_source: 'calendar', note_calendar_link: 'calendar',
  client: 'clients', client_call: 'clients', client_contact: 'clients', client_field: 'clients',
  project: 'projects', project_member: 'projects', project_template: 'projects', project_template_task: 'projects',
  task: 'projects', task_assignee: 'projects', gallery: 'projects',
  ticket: 'tickets', ticket_note: 'tickets',
  time_entry: 'time',
  attachment: 'content', content_folder: 'content', document: 'content', drive_share: 'content', file_transfer: 'content',
  note: 'content', note_handwriting: 'content',
  saved_report: 'stats',
  email_campaign: 'marketing', email_flow: 'marketing',
};

export const AUDIT_CATEGORIES: ReadonlyArray<{ key: AuditCategory; label: string }> = [
  { key: 'finance', label: 'Financiën' },
  { key: 'clients', label: 'Klanten' },
  { key: 'projects', label: 'Projecten en taken' },
  { key: 'content', label: 'Documenten en bestanden' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'time', label: 'Uren' },
  { key: 'calendar', label: 'Agenda' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'stats', label: 'Rapportages' },
  { key: 'team', label: 'Team en organisatie' },
  { key: 'admin', label: 'Beheer en koppelingen' },
];

export function auditCategory(entityType: string): AuditCategory {
  if (!(entityType in AUDIT_ENTITY_MODULE)) return 'admin';
  const module = AUDIT_ENTITY_MODULE[entityType];
  return module === null ? 'team' : module as AuditCategory;
}

/** De soorten regels van een categorie (voor het filter in de database). */
export function entityTypesFor(category: AuditCategory): string[] {
  return Object.keys(AUDIT_ENTITY_MODULE).filter(type => auditCategory(type) === category);
}

// ── Wie ─────────────────────────────────────────────────────────────────────

/** Gebeurtenissen die de klant zelf deed (via de offertepagina of het portaal). */
const CLIENT_ACTIONS = new Set(['quote_client_accepted', 'quote_client_rejected']);
/** Gebeurtenissen die van de betaalprovider komen. */
const PAYMENT_ACTIONS = new Set(['invoice_paid', 'payment_succeeded', 'payment_failed', 'payment_expired', 'invoice_charged_back', 'chargeback_reversed']);

/** Een e-mailadres als korte naam: "anne.jansen@studio.nl" → "anne.jansen". */
function shortEmail(email: string): string {
  return email.includes('@') ? email.split('@')[0] : email;
}

/**
 * Wie het deed, zoals het logboek het noemt. "Jij" voor jezelf; anders het
 * teamlid (of het adres van toen, als het account er niet meer is). Zonder
 * gebruiker: de klant, de betaling of "Systeem".
 */
export function actorName(e: AuditEntry, members: OrganizationMember[] = [], currentUserId?: string | null): string {
  // Via de offertepagina of het portaal is de klant ingelogd; dan is hij geen teamlid.
  if (CLIENT_ACTIONS.has(e.action) && !members.some(m => m.user_id === e.actorId)) return 'De klant';
  if (e.actorId) {
    if (currentUserId && e.actorId === currentUserId) return 'Jij';
    const member = members.find(m => m.user_id === e.actorId);
    const email = member?.email?.trim() || e.actorLabel?.trim();
    return email ? shortEmail(email) : 'Een oud-teamlid';
  }
  if (CLIENT_ACTIONS.has(e.action)) return 'De klant';
  if (e.entityType === 'ticket_note' && changeValue(e, 'author_type') === 'client') return 'De klant';
  if (PAYMENT_ACTIONS.has(e.action)) return 'De betaling';
  return 'Systeem';
}

/** Het volledige adres voor de details en de tooltip. */
export function actorEmail(e: AuditEntry, members: OrganizationMember[] = []): string | null {
  if (!e.actorId) return null;
  return members.find(m => m.user_id === e.actorId)?.email?.trim() || e.actorLabel || null;
}

export function viaLabel(via: AuditVia): string {
  if (via === 'koppeling') return 'Via Gerrie of een koppeling (agent, MCP, API), namens dit teamlid';
  if (via === 'systeem') return 'Zonder gebruiker: de server, een betaling, synchronisatie of een webhook';
  return 'In de app';
}

// ── Velden en waarden ──────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  title: 'Titel', name: 'Naam', label: 'Naam', number: 'Nummer', status: 'Status', priority: 'Prioriteit', tags: 'Labels',
  description: 'Omschrijving', notes: 'Notities', note: 'Notitie', content: 'Inhoud', body: 'Tekst',
  start_date: 'Start', end_date: 'Eind', planned_date: 'Ingepland op', planned_end_date: 'Ingepland tot',
  planned_start_minute: 'Begintijd', estimated_minutes: 'Geschatte tijd', subtasks: 'Subtaken', comments: 'Opmerkingen',
  project_id: 'Project', client_id: 'Klant', ticket_id: 'Ticket', task_id: 'Taak', user_id: 'Teamlid', folder_id: 'Map',
  parent_id: 'Map', contract_id: 'Contract', quote_id: 'Offerte', supplier_id: 'Leverancier', journal_entry_id: 'Boeking',
  archived: 'Gearchiveerd', color: 'Kleur', hourly_rate_cents: 'Uurtarief', billing_type: 'Facturering', budgeted_minutes: 'Budget (uren)',
  client_code: 'Klantnummer', client_kind: 'Soort klant', follow_up: 'Opvolgen op', value_eur: 'Klantwaarde', country: 'Land',
  email: 'E-mailadres', phone: 'Telefoon', contact_name: 'Contactpersoon', address_line1: 'Adres', address_line2: 'Adres (2)',
  postal_code: 'Postcode', city: 'Plaats', vat_number: 'Btw-nummer', kvk_number: 'KvK-nummer', iban: 'IBAN',
  custom_fields: 'Eigen velden', e_invoicing_enabled: 'E-factureren', e_invoice_channel: 'E-factuur via', e_invoice_email: 'E-factuuradres',
  role: 'Rol', is_active: 'Actief', gives_portal_access: 'Toegang tot het portaal', origin: 'Herkomst',
  date: 'Datum', due_date: 'Vervaldatum', valid_until: 'Geldig tot', currency: 'Valuta', subtotal_amount: 'Subtotaal',
  vat_amount: 'Btw', total_amount: 'Totaal', lines: 'Regels', sent_at: 'Verstuurd', paid_at: 'Betaald op', accepted_at: 'Geaccepteerd op',
  refunded_amount: 'Terugbetaald', charged_back_amount: 'Gestorneerd', reminder_level: 'Herinneringen', reminders_paused: 'Herinneringen gepauzeerd',
  locked_at: 'Vastgelegd', last_email_delivery_status: 'E-mailstatus', last_email_opened_at: 'Mail geopend',
  last_email_clicked_at: 'Link in mail aangeklikt', last_email_failed_at: 'Mail mislukt',
  internal_approval_status: 'Interne goedkeuring', internal_approved_at: 'Intern goedgekeurd op', internal_rejected_at: 'Intern afgekeurd op',
  internal_approval_requested_by: 'Goedkeuring gevraagd door', internal_approved_by: 'Goedgekeurd door', internal_rejected_by: 'Afgekeurd door',
  internal_rejection_note: 'Reden van afkeuren', client_decision_at: 'Besluit van de klant', client_decision_by_name: 'Besloten door',
  client_decision_by_email: 'E-mailadres van de klant', client_decision_note: 'Toelichting van de klant',
  amount_cents: 'Bedrag', signed_at: 'Ondertekend op', voided_at: 'Ingetrokken op', void_reason: 'Reden van intrekken',
  editor_mode: 'Bewerkt in', template_id: 'Sjabloon', supersedes_contract_id: 'Vervangt contract', voided_by: 'Ingetrokken door',
  document_type: 'Soort document', note_type: 'Soort notitie', mime_type: 'Soort bestand', size_bytes: 'Grootte',
  last_edited_at: 'Online bewerkt', parent_task_id: 'Bij taak', page_count: 'Pagina\'s',
  item_type: 'Soort', item_name: 'Wat', recipient_kind: 'Met', recipient_email: 'E-mailadres ontvanger', recipient_name: 'Ontvanger',
  can_download: 'Downloaden toegestaan', expires_at: 'Verloopt op', revoked_at: 'Ingetrokken op', notified_at: 'Bericht gestuurd op',
  member_user_id: 'Teamlid', client_contact_id: 'Contactpersoon', message: 'Bericht', subject: 'Onderwerp',
  purged_at: 'Opgeruimd op', item_count: 'Bestanden', total_bytes: 'Totale grootte',
  published_at: 'Gepubliceerd op', allow_downloads: 'Downloaden toegestaan', download_quality: 'Downloadkwaliteit',
  share_enabled: 'Delen aan', format: 'Weergave', hero_template: 'Omslag', layout: 'Indeling', share_token_hash: 'Deellink', share_pin_hash: 'Pincode',
  entry_date: 'Datum', minutes: 'Tijd', billable: 'Declarabel', entry_type: 'Soort', indirect_category: 'Categorie',
  source: 'Bron', started_at: 'Begon', ended_at: 'Eindigde', direction: 'Richting', outcome: 'Uitkomst', duration_seconds: 'Duur',
  contact_id: 'Contactpersoon', counterpart_name: 'Naam', phone_raw: 'Telefoonnummer', phone_e164: 'Telefoonnummer',
  is_internal: 'Intern', author_type: 'Van', resolved_at: 'Afgehandeld op', converted_to_project_id: 'Omgezet naar project',
  internal_number: 'Nummer', supplier_invoice_number: 'Factuurnummer leverancier', subtotal_cents: 'Subtotaal', vat_cents: 'Btw',
  total_cents: 'Totaal', payment_status: 'Betaalstatus', supplier_code: 'Leveranciersnummer', default_vat_code: 'Standaard btw',
  inbox_unverified: 'Nog te controleren', default_expense_account_id: 'Standaard kostenrekening',
  entry_number: 'Boekingsnummer', source_type: 'Bron', posted_at: 'Geboekt op', reverses_entry_id: 'Tegenboeking van',
  reversed_by_entry_id: 'Teruggedraaid met', code: 'Code', type: 'Soort', subtype: 'Subsoort', report_group: 'Rapportgroep',
  is_restricted_reserve: 'Wettelijke reserve', is_system: 'Systeemrekening', provider: 'Aanbieder', ledger_account_id: 'Grootboekrekening',
  auto_book: 'Automatisch boeken', match_direction: 'Richting', target_vat_code: 'Btw-code', target_account_id: 'Rekening',
  period_type: 'Periode', year: 'Jaar', period_index: 'Periode', period_start: 'Begin periode', period_end: 'Eind periode',
  finalized_at: 'Definitief op', filed_at: 'Ingediend op', rubrieken: 'Rubrieken', paid_bank_transaction_id: 'Betaald met',
  asset_number: 'Activumnummer', category: 'Categorie', acquisition_date: 'Aanschafdatum', acquisition_cost_cents: 'Aanschafprijs',
  residual_value_cents: 'Restwaarde', useful_life_months: 'Levensduur (maanden)', method: 'Methode', disposal_date: 'Verkocht of afgestoten op',
  disposal_proceeds_cents: 'Opbrengst', result_cents: 'Resultaat', closed_at: 'Afgesloten op', reopened_at: 'Heropend op',
  taxable_amount_cents: 'Belastbaar bedrag', tax_cents: 'Belasting', balance_due_cents: 'Te betalen',
  prepared_on: 'Opgemaakt op', prepare_deadline: 'Uiterlijk op te maken', adoption_date: 'Vastgesteld op', adoption_method: 'Vastgesteld via',
  filing_date: 'Gedeponeerd op', size_class: 'Grootteklasse', size_class_override: 'Grootteklasse (handmatig)', reversed_at: 'Teruggedraaid op',
  module_access: 'Modulerechten', joined_at: 'Lid sinds', invited_by: 'Uitgenodigd door', accepted_by: 'Geaccepteerd door', consumes_license: 'Gebruikt een licentie',
  licensed_seats: 'Licenties', license_status: 'Licentie', onboarding_completed_at: 'Inrichting afgerond', parent_organization_id: 'Hoort bij',
  legal_form: 'Rechtsvorm', kor_enabled: 'KOR', vat_return_period: 'Btw-aangifte per', bookkeeping_start_date: 'Boekhouding vanaf',
  fiscal_year_start_month: 'Boekjaar begint in', invoice_send_method: 'Facturen versturen via', default_hourly_rate_cents: 'Standaard uurtarief',
  invoice_template_kind: 'Briefpapier', brand_client_theme: 'Thema voor klanten', brand_hide_powered_by: '"Powered by" verbergen',
  company_name: 'Bedrijfsnaam', trade_name: 'Handelsnaam', website: 'Website', invoice_payment_terms: 'Betaaltekst', invoice_footer: 'Voettekst',
  brand_logo_data_url: 'Logo', brand_logo_dark_data_url: 'Logo (donker)', brand_accent_color: 'Merkkleur', document_layouts: 'Documentopmaak',
  scheduled_at: 'Ingepland voor', preheader: 'Voorvertoning', body_html: 'Inhoud', body_text: 'Inhoud (tekst)', audience: 'Ontvangers',
  stop_condition: 'Stopt bij', template_key: 'Soort mail', enabled: 'Aan', intro: 'Aanhef', closing: 'Afsluiting', cta_label: 'Knoptekst',
  field_key: 'Sleutel', field_type: 'Soort veld', is_archived: 'Gearchiveerd', show_in_list: 'In de lijst', options: 'Keuzes',
  help_text: 'Uitleg', default_fallback: 'Standaardwaarde', is_pinned: 'Vastgezet', definition: 'Instellingen',
  provider_account_email: 'Account', last_error: 'Laatste fout',
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? (key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, ' ');
}

const TASK_STATUS: Record<string, string> = { todo: 'Te doen', doing: 'Bezig', review: 'Review', done: 'Klaar' };
const TICKET_STATUS: Record<string, string> = {
  new: 'Nieuw', review: 'Review', approved: 'Goedgekeurd', rejected: 'Geweigerd', converted: 'Omgezet', resolved: 'Afgehandeld',
};
const FINANCE_STATUS: Record<string, string> = {
  draft: 'Concept', pending_internal_approval: 'Wacht op interne goedkeuring', internally_approved: 'Intern goedgekeurd',
  sent: 'Verzonden', accepted: 'Geaccepteerd', rejected: 'Afgewezen', expired: 'Verlopen', paid: 'Betaald', overdue: 'Te laat',
  cancelled: 'Geannuleerd', void: 'Ongeldig gemaakt', written_off: 'Afgeboekt', refunded: 'Terugbetaald', signed: 'Ondertekend',
  declined: 'Geweigerd', voided: 'Ingetrokken', issued: 'Uitgegeven', booked: 'Geboekt', posted: 'Geboekt', reversed: 'Teruggedraaid',
  finalized: 'Definitief', filed: 'Ingediend', open: 'Open', closed: 'Afgesloten', reopened: 'Heropend', active: 'Actief',
  disposed: 'Afgestoten', sold: 'Verkocht', fully_depreciated: 'Afgeschreven', unpaid: 'Niet betaald', partial: 'Deels betaald',
  adopted: 'Vastgesteld', prepared: 'Opgemaakt', deposited: 'Gedeponeerd',
};
const CLIENT_STATUS: Record<string, string> = { active: 'Actief', prospect: 'Prospect', inactive: 'Inactief' };
const MEMBER_STATUS: Record<string, string> = { active: 'Actief', disabled: 'Uitgeschakeld' };
const INVITATION_STATUS: Record<string, string> = { pending: 'Openstaand', accepted: 'Geaccepteerd', revoked: 'Ingetrokken', expired: 'Verlopen' };
const CAMPAIGN_STATUS: Record<string, string> = {
  draft: 'Concept', scheduled: 'Ingepland', sending: 'Wordt verstuurd', sent: 'Verzonden', paused: 'Gepauzeerd', cancelled: 'Geannuleerd', active: 'Actief',
};
const GALLERY_STATUS: Record<string, string> = { draft: 'Concept', published: 'Gepubliceerd', archived: 'Gearchiveerd' };
const TRANSFER_STATUS: Record<string, string> = { draft: 'Concept', sent: 'Verstuurd', revoked: 'Ingetrokken', expired: 'Verlopen' };
const PRIORITY: Record<string, string> = { low: 'Laag', med: 'Normaal', high: 'Hoog' };
const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer', accountant: 'Boekhouder' };
const MODULE_LABEL: Record<string, string> = {
  clients: 'Klanten', projects: 'Projecten', time: 'Uren', calendar: 'Agenda', tickets: 'Tickets', content: 'Inhoud',
  stats: 'Statistieken', marketing: 'Marketing', finance: 'Financiën', chat: 'Teamchat', gerrie: 'Gerrie',
};
const LEVEL: Record<string, string> = { none: 'geen toegang', read: 'alleen lezen', write: 'volledig' };
const EMAIL_STATUS: Record<string, string> = {
  queued: 'In de wachtrij', sent: 'Verstuurd', delivered: 'Afgeleverd', opened: 'Geopend', clicked: 'Aangeklikt',
  bounced: 'Niet afgeleverd', failed: 'Mislukt', complained: 'Gemeld als spam',
};
const VALUE_WORDS: Record<string, Record<string, string>> = {
  client_kind: { business: 'Zakelijk', consumer: 'Particulier' },
  billing_type: { hourly: 'Per uur', fixed: 'Vaste prijs', none: 'Niet' },
  e_invoice_channel: { email: 'E-mail', peppol: 'Peppol', mollie: 'Mollie' },
  note_type: { general: 'Algemeen', meeting: 'Overleg', action: 'Actie', decision: 'Besluit', idea: 'Idee', support: 'Support' },
  document_type: { contract: 'Contract', general: 'Algemeen', policy: 'Beleid', procedure: 'Procedure', other: 'Overig' },
  recipient_kind: { client_contact: 'een contactpersoon', member: 'een teamlid', email: 'een e-mailadres', link: 'iedereen met de link' },
  author_type: { user: 'Teamlid', client: 'Klant', system: 'Systeem' },
  direction: { inbound: 'Inkomend', outbound: 'Uitgaand' },
  entry_type: { direct: 'Direct', indirect: 'Indirect' },
  period_type: { month: 'Maand', quarter: 'Kwartaal', year: 'Jaar' },
  invoice_send_method: { email: 'E-mail', mollie: 'Mollie' },
  editor_mode: { rich: 'ResoFly', office: 'Office' },
};

function statusWord(entityType: string, value: string): string {
  if (entityType === 'task' || entityType === 'project_template_task') return TASK_STATUS[value] ?? value;
  if (entityType === 'ticket') return TICKET_STATUS[value] ?? value;
  if (entityType === 'client' || entityType === 'supplier') return CLIENT_STATUS[value] ?? FINANCE_STATUS[value] ?? value;
  if (entityType === 'member') return MEMBER_STATUS[value] ?? value;
  if (entityType === 'invitation') return INVITATION_STATUS[value] ?? value;
  if (entityType === 'email_campaign' || entityType === 'email_flow') return CAMPAIGN_STATUS[value] ?? value;
  if (entityType === 'gallery') return GALLERY_STATUS[value] ?? value;
  if (entityType === 'file_transfer') return TRANSFER_STATUS[value] ?? value;
  return FINANCE_STATUS[value] ?? value;
}

const DATE = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const TIME = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
const EURO = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v);

function minutesText(m: number): string {
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} u` : `${h} u ${rest} min`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} GB`;
}

/** Namen van dingen waar een veld naar verwijst; de app geeft wat hij mag zien. */
export interface AuditLookup {
  clients?: ReadonlyMap<string, string>;
  projects?: ReadonlyMap<string, string>;
  tasks?: ReadonlyMap<string, string>;
  members?: OrganizationMember[];
  currentUserId?: string | null;
}

function refName(key: string, id: string, lookup: AuditLookup): string | null {
  if (key === 'client_id' || key === 'set_client_id') return lookup.clients?.get(id) ?? null;
  if (key === 'project_id' || key === 'converted_to_project_id') return lookup.projects?.get(id) ?? null;
  if (key === 'task_id' || key === 'parent_task_id') return lookup.tasks?.get(id) ?? null;
  if (/(^|_)(user_id|by)$/.test(key) || key === 'member_user_id' || key === 'invited_by') {
    if (lookup.currentUserId && id === lookup.currentUserId) return 'jou';
    const email = lookup.members?.find(m => m.user_id === id)?.email;
    return email ? shortEmail(email) : null;
  }
  return null;
}

/** Een waarde uit het logboek als tekst: statussen, bedragen, datums, verwijzingen. */
export function formatValue(entityType: string, key: string, value: unknown, lookup: AuditLookup = {}): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(v => formatValue(entityType, key, v, lookup)).join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'ja' : 'nee';
  if (isObject(value)) {
    if (key === 'module_access') {
      const parts = Object.entries(value).filter(([, level]) => level !== 'write').map(([module, level]) => `${MODULE_LABEL[module] ?? module}: ${LEVEL[String(level)] ?? level}`);
      return parts.length ? parts.join(', ') : 'alles volledig';
    }
    return 'gewijzigd';
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && /(_cents|_amount|value_eur|minutes|seconds|bytes)$/.test(key))) {
    const n = Number(value);
    if (key.endsWith('_cents')) return EURO.format(n / 100);
    if (key.endsWith('_amount') || key === 'value_eur') return EURO.format(n);
    if (key === 'minutes' || key === 'estimated_minutes' || key === 'budgeted_minutes') return minutesText(n);
    if (key === 'duration_seconds') return minutesText(n / 60);
    if (key === 'size_bytes' || key === 'total_bytes') return bytes(n);
    if (key === 'planned_start_minute') return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    return n.toLocaleString('nl-NL');
  }
  const s = String(value);
  if (isUuid(s)) return refName(key, s, lookup) ?? (key === 'client_id' ? 'een andere klant' : key === 'project_id' ? 'een ander project' : 'iets anders');
  if (key === 'status' || key === 'payment_status' || key === 'internal_approval_status') return statusWord(entityType, s);
  if (key === 'priority') return PRIORITY[s] ?? s;
  if (key === 'role') return ROLE[s] ?? s;
  if (key === 'last_email_delivery_status') return EMAIL_STATUS[s] ?? s;
  if (VALUE_WORDS[key]?.[s]) return VALUE_WORDS[key][s];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return DATE.format(new Date(`${s}T12:00:00`));
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? s : DATE_TIME.format(d);
  }
  return s;
}

function changeValue(e: AuditEntry, key: string): unknown {
  const c = e.changes[key];
  if (!c) return undefined;
  return c.new ?? c.old;
}

/** Eén wijziging, klaar om te tonen. */
export interface AuditChangeLine {
  key: string;
  label: string;
  /** 'changed' = alleen dát het veranderde; de inhoud staat bewust niet in het logboek. */
  kind: 'value' | 'changed' | 'snapshot';
  from?: string;
  to?: string;
}

// Velden die al in de zin staan of alleen achtergrond zijn.
const HIDDEN_FIELDS = new Set(['title', 'name', 'number', 'label', 'internal_number', 'entry_number', 'template_key']);

/** De wijzigingen per veld. Bij aanmaken en verwijderen: de waarden van toen. */
export function changeLines(e: AuditEntry, lookup: AuditLookup = {}): AuditChangeLine[] {
  const out: AuditChangeLine[] = [];
  const snapshot = e.action === 'created' || e.action === 'deleted' || e.action === 'accepted' || e.action === 'invited';
  const seen = new Set<string>();
  for (const [key, c] of Object.entries(e.changes)) {
    seen.add(key);
    // De naam staat al in de zin; alleen bij hernoemen telt hij.
    if (HIDDEN_FIELDS.has(key) && (snapshot || !('old' in c))) continue;
    // Online bewerkt: dat zegt de zin al.
    if (key === 'last_edited_at' && e.metadata.online === true) continue;
    // Bij aanmaken: de klant en het project staan al als "waar" onder de regel.
    if (snapshot && (key === 'client_id' || key === 'project_id') && (key === 'client_id' ? e.clientId : e.projectId)) continue;
    if (c.changed && !('old' in c) && !('new' in c)) {
      out.push({ key, label: fieldLabel(key), kind: 'changed' });
      continue;
    }
    const from = c.old === undefined || c.old === null ? undefined : formatValue(e.entityType, key, c.old, lookup);
    const to = c.new === undefined || c.new === null ? undefined : formatValue(e.entityType, key, c.new, lookup);
    if (snapshot) out.push({ key, label: fieldLabel(key), kind: 'snapshot', to: to ?? from });
    else out.push({ key, label: fieldLabel(key), kind: 'value', from: from ?? '—', to: to ?? '—' });
  }
  // Regels van vóór het logboek: alleen de namen van de kolommen.
  for (const key of e.changedColumns) {
    if (seen.has(key) || key === 'updated_at') continue;
    out.push({ key, label: fieldLabel(key), kind: 'changed' });
  }
  return out;
}

/** Eén regel samengevat, voor onder de zin als hij dicht is. */
export function changeSummary(lines: AuditChangeLine[], max = 2): string {
  const parts = lines.slice(0, max).map(l => l.kind === 'changed' ? `${l.label} gewijzigd`
    : l.kind === 'snapshot' ? `${l.label}: ${l.to ?? '—'}`
    : `${l.label}: ${l.from ?? '—'} → ${l.to ?? '—'}`);
  if (lines.length > max) parts.push(`nog ${lines.length - max}`);
  return parts.join(' · ');
}

// ── De zin ──────────────────────────────────────────────────────────────────

/** Een stukje van de zin: gewone tekst, of de naam van het ding (vet). */
export type SentencePart = { text: string; strong?: boolean };

const NOUN: Record<string, string> = {
  task: 'taak', project: 'project', client: 'klant', client_contact: 'contactpersoon', client_call: 'gesprek', client_field: 'klantveld',
  ticket: 'ticket', ticket_note: 'notitie bij een ticket', note: 'notitie', document: 'document', attachment: 'bestand',
  content_folder: 'map', note_handwriting: 'handgeschreven notitie bij', drive_share: 'deling van', file_transfer: 'bestandsoverdracht',
  time_entry: 'uren', calendar_event: 'afspraak', calendar_event_link: 'koppeling met afspraak', calendar_source: 'agenda',
  calendar_connection: 'agendakoppeling', note_calendar_link: 'notitie bij afspraak', saved_report: 'rapportage',
  project_template: 'projectsjabloon', project_template_task: 'sjabloontaak', gallery: 'galerij', email_campaign: 'campagne',
  email_flow: 'e-mailstroom', email_template: 'e-mailtekst', invoice: 'factuur', quote: 'offerte', contract: 'contract',
  contract_note: 'interne notitie bij contract', contract_project: 'koppeling van contract', contract_template: 'contractsjabloon',
  credit_note: 'creditnota', purchase_invoice: 'inkoopfactuur', supplier: 'leverancier', journal_entry: 'boeking',
  ledger_account: 'grootboekrekening', bank_account: 'bankrekening', bank_rule: 'bankregel', bank_transaction: 'banktransactie',
  vat_return: 'btw-aangifte', fixed_asset: 'activum', fiscal_year: 'boekjaar', corporate_tax_return: 'vpb-aangifte',
  annual_account: 'jaarrekening', annual_account_filing: 'deponering', annual_account_signature: 'ondertekening van',
  dividend_distribution: 'dividenduitkering', result_appropriation: 'resultaatbestemming', share_transaction: 'aandelentransactie',
  shareholder: 'aandeelhouder', partnership_partner: 'vennoot', fiscal_year_size_input: 'grootte-gegevens',
  member: 'teamlid', invitation: 'uitnodiging voor', api_key: 'API-sleutel', webhook_endpoint: 'webhook',
  mollie_connection: 'Mollie-koppeling', subscription: 'abonnement', billing_profile: 'abonnement', payment: 'betaling',
  billing_event: 'abonnementsgebeurtenis', license_change: 'licentiewijziging', license_event: 'licentie',
};

const EMAIL_TEMPLATE_LABEL: Record<string, string> = {
  quote: 'offertemail', invoice: 'factuurmail', reminder: 'herinneringsmail', dunning: 'aanmaning', credit_note: 'creditnotamail',
  ticket_created: 'ticketmelding', ticket_reply: 'ticketreactie', ticket_resolved: 'ticket afgehandeld',
};

/** De naam van het ding zoals het logboek hem noemt. Geen id's in beeld. */
export function entityName(e: AuditEntry, lookup: AuditLookup = {}): string {
  const label = e.entityLabel?.trim() ?? '';
  if (e.entityType === 'company_settings') return 'de bedrijfsgegevens';
  if (e.entityType === 'email_template') return EMAIL_TEMPLATE_LABEL[label] ?? label.replace(/_/g, ' ');
  if (isUuid(label)) {
    // Oude regels: een teamlid of project als id.
    if (e.entityType === 'project_member' || e.entityType === 'task_assignee') {
      const project = e.projectId ? lookup.projects?.get(e.projectId) : undefined;
      return project ?? (e.entityType === 'project_member' ? 'een project' : 'een taak');
    }
    if (e.entityType === 'note_handwriting') return 'een notitie';
    if (e.entityType === 'contract_project') return 'een contract';
    return '(zonder naam)';
  }
  if (!label) return '(zonder naam)';
  return label;
}

const VERB: Record<string, string> = { created: 'maakte', updated: 'wijzigde', deleted: 'verwijderde' };

/**
 * De zin van een regel, zonder wie het deed (die zet de app er vet voor).
 * `subjectless` = de zin heeft geen persoon ("Factuur 2026-014 is betaald").
 */
export function sentence(e: AuditEntry, lookup: AuditLookup = {}): { parts: SentencePart[]; subjectless?: boolean } {
  const t = (text: string): SentencePart => ({ text });
  const b = (text: string): SentencePart => ({ text, strong: true });
  const name = entityName(e, lookup);
  const noun = NOUN[e.entityType] ?? e.entityType.replace(/_/g, ' ');
  const obj = (n = noun): SentencePart[] => [t(`${n} `), b(name)];
  const meta = e.metadata;
  const metaText = (key: string) => (typeof meta[key] === 'string' ? String(meta[key]) : '');
  const keys = Object.keys(e.changes).filter(k => !['updated_at'].includes(k));
  const only = (...wanted: string[]) => keys.length > 0 && keys.every(k => wanted.includes(k));
  const newOf = (key: string) => e.changes[key]?.new;
  const user = (key = 'user_id') => {
    const id = (newOf(key) ?? e.changes[key]?.old ?? (isUuid(e.entityLabel) ? e.entityLabel : null)) as string | null;
    return id ? (refName('user_id', id, lookup) ?? 'een teamlid') : 'een teamlid';
  };
  const statusTo = (key = 'status') => statusWord(e.entityType, String(newOf(key) ?? ''));

  switch (e.action) {
    // Facturen
    case 'invoice_sent_to_client': return { parts: [t('verstuurde '), ...obj(), t(' naar de klant')] };
    case 'invoice_reminder_sent': {
      const level = Number(meta.reminder_level ?? 0);
      return { parts: [t(level > 1 ? `stuurde herinnering ${level} voor ` : 'stuurde een herinnering voor '), ...obj()] };
    }
    case 'dunning_notice_sent': return { parts: [t('stuurde een aanmaning voor '), ...obj()] };
    case 'invoice_created_from_quote':
      return { parts: [t('maakte '), ...obj(), ...(metaText('quote_number') ? [t(' van offerte '), b(metaText('quote_number'))] : [t(' van een offerte')])] };
    case 'invoice_payment_link_created': return { parts: [t('maakte een betaallink voor '), ...obj()] };
    case 'invoice_paid': return { parts: [b(cap(noun)), t(' '), b(name), t(' is betaald')], subjectless: true };
    case 'invoice_refunded': return { parts: [t('betaalde '), ...obj(), t(' terug')] };
    case 'invoice_charged_back': return { parts: [b(cap(noun)), t(' '), b(name), t(' is gestorneerd')], subjectless: true };
    case 'chargeback_reversed': return { parts: [t('De storno van '), ...obj(), t(' is teruggedraaid')], subjectless: true };
    case 'invoice_email_send_failed': return { parts: [t('Het versturen van '), ...obj(), t(' mislukte')], subjectless: true };
    case 'invoice_payment_checkout_failed': return { parts: [t('De betaallink voor '), ...obj(), t(' kon niet worden gemaakt')], subjectless: true };
    case 'credit_note_issued': return { parts: [t('maakte '), ...obj()] };
    case 'credit_note_emailed': return { parts: [t('mailde '), ...obj(), t(' naar de klant')] };
    // Offertes
    case 'quote_submitted_for_approval': return { parts: [t('legde '), ...obj(), t(' ter goedkeuring voor')] };
    case 'quote_internal_approved': return { parts: [t('keurde '), ...obj(), t(' goed')] };
    case 'quote_internal_rejected': return { parts: [t('keurde '), ...obj(), t(' af')] };
    case 'quote_sent_to_client': return { parts: [t('verstuurde '), ...obj(), t(' naar de klant')] };
    case 'quote_client_accepted': return { parts: [t('accepteerde '), ...obj()] };
    case 'quote_client_rejected': return { parts: [t('wees '), ...obj(), t(' af')] };
    case 'quote_email_delivered': return { parts: [b(cap(noun)), t(' '), b(name), t(' is bij de klant afgeleverd')], subjectless: true };
    case 'quote_email_failed': return { parts: [b(cap(noun)), t(' '), b(name), t(' kon niet worden afgeleverd')], subjectless: true };
    case 'quote_version_created': return { parts: [t('legde een nieuwe versie vast van '), ...obj()] };
    case 'quote_pdf_attached': return { parts: [t('maakte de PDF van '), ...obj()] };
    case 'quote_cancelled': return { parts: [t('trok '), ...obj(), t(' in')] };
    // Team
    case 'invited': {
      const role = newOf('role');
      return { parts: [t('nodigde '), b(name), t(' uit'), ...(role ? [t(` als ${ROLE[String(role)] ?? role}`)] : [])] };
    }
    case 'accepted':
      if (e.entityType === 'member' && e.actorId && newOf('user_id') === e.actorId) return { parts: [t('kwam bij het team')] };
      return { parts: [t(e.entityType === 'invitation' ? 'accepteerde de uitnodiging voor ' : 'voegde '), b(name), ...(e.entityType === 'invitation' ? [] : [t(' toe aan het team')])] };
    case 'revoked':
      if (e.entityType === 'mollie_connection') return { parts: [t('ontkoppelde Mollie')] };
      return { parts: [t('trok de '), t(e.entityType === 'invitation' ? 'uitnodiging voor ' : `${noun} `), b(name), t(' in')] };
    case 'expired': return { parts: [t('De uitnodiging voor '), b(name), t(' is verlopen')], subjectless: true };
    case 'role_changed': return { parts: [t('gaf '), b(name), t(' de rol '), b(ROLE[String(newOf('role'))] ?? String(newOf('role') ?? '—'))] };
    case 'disabled': return { parts: [t('schakelde teamlid '), b(name), t(' uit')] };
    case 'invitation_blocked_insufficient_seats': return { parts: [t('kon '), b(name), t(' niet uitnodigen: er was geen licentie vrij')] };
    // Abonnement en modules
    case 'mollie_connected': return { parts: [t('koppelde Mollie')] };
    case 'plan_changed': return { parts: [t('zette het abonnement op '), b(String(metaText('new_plan_key') || name))] };
    case 'seat_purchased': return { parts: [t('kocht een extra gebruikerslicentie')] };
    case 'seat_downgrade_requested': return { parts: [t('vroeg minder gebruikerslicenties aan')] };
    case 'licensed_seats_changed': return { parts: [t('Het aantal gebruikerslicenties is aangepast')], subjectless: true };
    case 'payment_succeeded':
      if (e.entityType === 'invoice') return { parts: [t('De betaling van '), ...obj(), t(' is binnen')], subjectless: true };
      return { parts: [t('De betaling van het abonnement is binnen')], subjectless: true };
    case 'payment_failed': return { parts: [t('De betaling van het abonnement mislukte')], subjectless: true };
    case 'payment_expired': return { parts: [t('De betaling van het abonnement is verlopen')], subjectless: true };
    case 'subscription_cancelled': return { parts: [t('zegde het abonnement op')] };
    case 'billing_synced': return { parts: [t('Het abonnement is bijgewerkt')], subjectless: true };
    case 'storage_purchased': return { parts: [t('kocht extra opslag')] };
    case 'creative_module_enabled': return { parts: [t('zette de creatieve module aan')] };
    case 'creative_module_disabled': return { parts: [t('zette de creatieve module uit')] };
    case 'business_module_enabled': return { parts: [t('zette de zakelijke module aan')] };
    case 'business_module_disabled': return { parts: [t('zette de zakelijke module uit')] };
    case 'entity_created': return { parts: [t('maakte administratie '), b(name), t(' aan')] };
  }

  // Wat de tabel zelf zegt (aangemaakt, gewijzigd, verwijderd).
  const verb = VERB[e.action] ?? 'wijzigde';
  if (e.entityType === 'bank_transaction' && metaText('wat')) {
    return { parts: [t(`${verb} `), ...obj(), t(` (${metaText('wat')})`)] };
  }
  if (e.entityType === 'project_member') {
    return e.action === 'deleted'
      ? { parts: [t('haalde '), b(user()), t(' uit project '), b(name)] }
      : { parts: [t('voegde '), b(user()), t(' toe aan project '), b(name)] };
  }
  if (e.entityType === 'task_assignee') {
    return e.action === 'deleted'
      ? { parts: [t('haalde '), b(user()), t(' van taak '), b(name)] }
      : { parts: [t('wees taak '), b(name), t(' toe aan '), b(user())] };
  }
  if (e.entityType === 'ticket_note' && e.action === 'created') {
    if (changeValue(e, 'author_type') === 'client') return { parts: [t('reageerde op een ticket')] };
    return { parts: [t(changeValue(e, 'is_internal') === true ? 'schreef een interne notitie bij een ticket' : 'reageerde op een ticket')] };
  }
  if (e.entityType === 'time_entry' && e.action !== 'updated') {
    const minutes = Number(changeValue(e, 'minutes') ?? 0);
    const amount = minutes > 0 ? minutesText(minutes) : 'uren';
    const label = name === '(zonder naam)' ? [] : [t(': '), b(name)];
    return e.action === 'deleted'
      ? { parts: [t(`verwijderde ${amount} uit de urenregistratie`), ...label] }
      : { parts: [t(`schreef ${amount}`), ...label] };
  }
  if (e.entityType === 'attachment' && e.action === 'created') return { parts: [t('uploadde '), b(name)] };
  if (e.entityType === 'document' && e.metadata.online === true) return { parts: [t('bewerkte '), ...obj(), t(' online')] };
  if (e.entityType === 'attachment' && e.metadata.online === true) return { parts: [t('bewerkte '), b(name), t(' online')] };
  if (e.entityType === 'drive_share' && e.action === 'created') {
    const kind = String(changeValue(e, 'recipient_kind') ?? '');
    return { parts: [t('deelde '), b(name), ...(VALUE_WORDS.recipient_kind[kind] ? [t(` met ${VALUE_WORDS.recipient_kind[kind]}`)] : [])] };
  }
  if (e.entityType === 'organization' && e.action === 'created') return { parts: [t('maakte de organisatie '), b(name), t(' aan')] };
  if (e.entityType === 'company_settings') return { parts: [t(e.action === 'created' ? 'legde de bedrijfsgegevens vast' : 'wijzigde de bedrijfsgegevens')] };

  if (e.action === 'updated') {
    if (only('status') || only('status', 'resolved_at', 'sent_at', 'paid_at', 'published_at', 'signed_at', 'voided_at', 'finalized_at', 'filed_at', 'started_at', 'closed_at', 'reopened_at', 'posted_at')) {
      if (newOf('status') !== undefined) return { parts: [t('zette '), ...obj(), t(' op '), b(statusTo())] };
    }
    if (only('archived')) return newOf('archived') === true ? { parts: [t('archiveerde '), ...obj()] } : { parts: [t('haalde '), ...obj(), t(' uit het archief')] };
    if (only('is_archived')) return newOf('is_archived') === true ? { parts: [t('archiveerde '), ...obj()] } : { parts: [t('haalde '), ...obj(), t(' uit het archief')] };
    if (only('name') || only('title') || only('label')) {
      const key = keys[0];
      const from = e.changes[key]?.old;
      if (typeof from === 'string' && from) return { parts: [t(`hernoemde ${noun} `), b(from), t(' naar '), b(name)] };
    }
    if (only('folder_id') || only('parent_id')) return { parts: [t('verplaatste '), ...obj(), t(' naar een andere map')] };
    if (only('revoked_at') && newOf('revoked_at')) return { parts: [t('trok de '), ...obj(), t(' in')] };
    if (only('module_access') && e.entityType === 'member') return { parts: [t('wijzigde de modulerechten van '), b(name)] };
    // E-mail gevolgd door de server: geopend, afgeleverd.
    if (!e.actorId && keys.length > 0 && keys.every(k => k.startsWith('last_email_'))) {
      const status = newOf('last_email_delivery_status');
      const what = newOf('last_email_clicked_at') ? 'de link aangeklikt' : newOf('last_email_opened_at') ? 'geopend'
        : status ? (EMAIL_STATUS[String(status)] ?? String(status)).toLowerCase() : 'bijgewerkt';
      return { parts: [t('De mail van '), ...obj(), t(`: ${what}`)], subjectless: true };
    }
  }
  if (e.action === 'created' && e.entityType === 'content_folder') return { parts: [t('maakte map '), b(name), t(' aan')] };
  const tail = e.action === 'created' ? [t(' aan')] : [];
  return { parts: [t(`${verb} `), ...obj(), ...tail] };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** De zin als platte tekst (voor het dashboard en de tests). */
export function sentenceText(e: AuditEntry, lookup: AuditLookup = {}): string {
  const s = sentence(e, lookup);
  const body = s.parts.map(p => p.text).join('');
  return s.subjectless ? body : `${actorName(e, lookup.members, lookup.currentUserId)} ${body}`;
}

// ── Tijd en dagen ───────────────────────────────────────────────────────────

/** "10:41", of "10:02–10:41" bij een samengevoegde reeks. */
export function timeLabel(e: AuditEntry): string {
  const a = TIME.format(new Date(e.createdAt));
  const z = TIME.format(new Date(e.lastAt));
  return e.count > 1 && a !== z ? `${a}–${z}` : a;
}

/** De dag in de tijdzone van de browser, als jjjj-mm-dd. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DAY = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** "Vandaag", "Gisteren" of "dinsdag 3 november 2026". */
export function dayLabel(key: string, now = new Date()): string {
  if (key === dayKey(now.toISOString())) return 'Vandaag';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.toISOString())) return 'Gisteren';
  return DAY.format(new Date(`${key}T12:00:00`));
}

export function groupByDay(entries: AuditEntry[]): Array<{ key: string; entries: AuditEntry[] }> {
  const out: Array<{ key: string; entries: AuditEntry[] }> = [];
  for (const e of entries) {
    const key = dayKey(e.createdAt);
    const last = out[out.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else out.push({ key, entries: [e] });
  }
  return out;
}

/** "zojuist", "12 min geleden", "3 u geleden", anders de datum. */
export function relativeTime(iso: string, now = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'zojuist';
  if (minutes < 60) return `${minutes} min geleden`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 && dayKey(iso) === dayKey(now.toISOString())) return `${hours} u geleden`;
  if (dayLabel(dayKey(iso), now) === 'Gisteren') return `gisteren ${TIME.format(new Date(iso))}`;
  return DATE.format(new Date(iso));
}

// ── Filters ────────────────────────────────────────────────────────────────

export type AuditPeriod = 'vandaag' | '7d' | '30d' | '90d' | 'alles';

export const AUDIT_PERIODS: ReadonlyArray<{ value: AuditPeriod; label: string }> = [
  { value: 'vandaag', label: 'Vandaag' },
  { value: '7d', label: '7 dagen' },
  { value: '30d', label: '30 dagen' },
  { value: '90d', label: '90 dagen' },
  { value: 'alles', label: 'Alles' },
];

export interface AuditFilters {
  period: AuditPeriod;
  /** Een user-id, of 'systeem' voor regels zonder gebruiker. */
  actor?: string;
  clientId?: string;
  projectId?: string;
  category?: AuditCategory;
  q?: string;
}

/** Vanaf wanneer, bij deze periode (null = alles). */
export function periodStart(period: AuditPeriod, now = new Date()): Date | null {
  if (period === 'alles') return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === '7d') d.setDate(d.getDate() - 6);
  if (period === '30d') d.setDate(d.getDate() - 29);
  if (period === '90d') d.setDate(d.getDate() - 89);
  return d;
}

/** Zoektekst veilig voor een PostgREST-filter: geen tekens die het filter breken. */
export function cleanQuery(q?: string): string {
  return (q ?? '').replace(/[,()*%"\\:.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Past een regel bij de filters? Dezelfde regels als de query in de database. */
export function matchesFilters(e: AuditEntry, f: AuditFilters, now = new Date()): boolean {
  const from = periodStart(f.period, now);
  if (from && new Date(e.createdAt) < from) return false;
  if (f.actor && (f.actor === 'systeem' ? e.via !== 'systeem' : e.actorId !== f.actor)) return false;
  if (f.clientId && e.clientId !== f.clientId) return false;
  if (f.projectId && e.projectId !== f.projectId) return false;
  if (f.category && auditCategory(e.entityType) !== f.category) return false;
  const q = cleanQuery(f.q).toLowerCase();
  if (q && ![e.entityLabel, e.actorLabel].some(v => (v ?? '').toLowerCase().includes(q))) return false;
  return true;
}

/** Een regel die je kunt openen: waar hij heen gaat in de app. */
export type AuditTarget =
  | { kind: 'task'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'client'; id: string }
  | { kind: 'page'; page: 'invoices' | 'quotes' | 'contracts' | 'tickets' | 'documents' | 'notes' | 'content' | 'time' | 'marketing' | 'purchase-invoices' | 'suppliers' | 'ledger' | 'bank' | 'vat-returns' | 'calendar' | 'stats' | 'settings' };

export function auditTarget(e: AuditEntry): AuditTarget | null {
  if (e.action === 'deleted') {
    if (e.projectId) return { kind: 'project', id: e.projectId };
    if (e.clientId) return { kind: 'client', id: e.clientId };
    return null;
  }
  switch (e.entityType) {
    case 'task': return e.entityId ? { kind: 'task', id: e.entityId } : null;
    case 'project': case 'project_member': case 'gallery': return e.projectId ? { kind: 'project', id: e.projectId } : null;
    case 'client': case 'client_contact': case 'client_call': return e.clientId ? { kind: 'client', id: e.clientId } : null;
    case 'invoice': case 'credit_note': return { kind: 'page', page: 'invoices' };
    case 'quote': return { kind: 'page', page: 'quotes' };
    case 'contract': case 'contract_note': case 'contract_project': return { kind: 'page', page: 'contracts' };
    case 'ticket': case 'ticket_note': return { kind: 'page', page: 'tickets' };
    case 'document': return { kind: 'page', page: 'documents' };
    case 'note': case 'note_handwriting': return { kind: 'page', page: 'notes' };
    case 'attachment': case 'content_folder': case 'drive_share': case 'file_transfer': return { kind: 'page', page: 'content' };
    case 'time_entry': return { kind: 'page', page: 'time' };
    case 'email_campaign': case 'email_flow': return { kind: 'page', page: 'marketing' };
    case 'purchase_invoice': return { kind: 'page', page: 'purchase-invoices' };
    case 'supplier': return { kind: 'page', page: 'suppliers' };
    case 'journal_entry': case 'ledger_account': return { kind: 'page', page: 'ledger' };
    case 'bank_account': case 'bank_rule': case 'bank_transaction': return { kind: 'page', page: 'bank' };
    case 'vat_return': return { kind: 'page', page: 'vat-returns' };
    case 'calendar_event': case 'calendar_source': return { kind: 'page', page: 'calendar' };
    case 'saved_report': return { kind: 'page', page: 'stats' };
    default: return null;
  }
}
