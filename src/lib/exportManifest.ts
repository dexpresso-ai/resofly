/**
 * Wat er meegaat als een organisatie al haar gegevens exporteert, en waarom de
 * rest niet.
 *
 * Elke tabel in de database staat hier, met een soort. `export` gaat mee in de
 * zip; bij elke andere soort staat waarom niet. exportManifest.test.ts leest
 * de migraties en faalt op een tabel die hier ontbreekt, op een tabel die niet
 * meer bestaat, en op een kolom die als sleutel werkt (token, hash, wachtwoord)
 * maar niet uitdrukkelijk is weggelaten of toegestaan.
 *
 * Waarom zo streng: de Data Act vraagt vooraf een uitputtende lijst van wat
 * meekomt en wat niet. En het wissen aan het eind van een abonnement heeft
 * dezelfde lijst nodig. In november 2026 liep het opruimen van bestanden vast
 * omdat niemand wist welke tabellen naar bestanden verwijzen
 * (ACTIEPUNTEN_BEVEILIGING_SAAS, actie 19). Hier staat het per kolom.
 *
 * De export leest met de rechten van wie hem maakt (Supabase, RLS): de
 * eigenaar of een beheerder. Wat die in ResoFly niet kan zien, zoals de
 * privé-agenda van een collega, komt er dus ook niet in. Zie docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md.
 *
 * Puur (geen Supabase, geen React), zodat `npm test` het kan nalopen.
 */

/** Versie van het exportformaat. Ophogen als de opbouw van de zip verandert. */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * De laatste migratie waarmee dit manifest is bijgewerkt. Staat in manifest.json
 * van elke export, zodat wie hem inleest weet welke kolommen hij kan verwachten.
 * De test faalt zodra er een nieuwere migratie is: kijk dan of er tabellen of
 * kolommen bij kwamen, en zet het nummer hier op de nieuwste.
 */
// 20261111140000 (het logboek alleen voor owners en admins) zet alleen een
// leesregel en een tabelcommentaar: geen tabellen of kolommen erbij.
export const EXPORT_SCHEMA_VERSION = '20261111140000';

export type TableKind =
  | 'export'
  | 'galerij'
  | 'geheim'
  | 'intern'
  | 'prive'
  | 'abonnement'
  | 'platform';

export const TABLE_KIND_LABEL: Readonly<Record<TableKind, string>> = {
  export: 'Gaat mee',
  galerij: 'Galerijen',
  geheim: 'Sleutels en wachtwoorden',
  intern: 'Werking van ResoFly',
  prive: 'Van één teamlid',
  abonnement: 'Je abonnement bij ResoFly',
  platform: 'Gedeeld door alle organisaties',
};

export interface ExportTableRule {
  kind: 'export';
  /** Kolom waarmee de rijen van de organisatie te vinden zijn. Standaard organization_id. */
  orgColumn?: string;
  /** Volgorde om stabiel te bladeren. Standaard id; verplicht als de tabel geen id heeft. */
  orderBy?: readonly string[];
  /**
   * Alleen waar `select *` niet mag omdat de app een kolom niet kan lezen. De
   * test eist dat select en omit samen precies alle kolommen zijn, zodat een
   * nieuwe kolom niet stilletjes ontbreekt.
   */
  select?: readonly string[];
  /** Kolommen die niet meegaan, met de reden. */
  omit?: Readonly<Record<string, string>>;
  /** Kolommen waarvan de naam op een sleutel lijkt, maar die het niet zijn (een telling, een controlegetal). */
  keep?: readonly string[];
  /** Kolommen met een opslagsleutel in R2: het bestand gaat mee. */
  files?: readonly string[];
  /** JSON-kolommen met een lijst objecten die elk een opslagsleutel hebben: kolom → veld. */
  fileLists?: Readonly<Record<string, string>>;
  /** Opslagsleutels waarvan het bestand bewust niet meegaat, met de reden. */
  skipFiles?: Readonly<Record<string, string>>;
  /** Een leesbare lijst in lijsten/<naam>.csv, voor Excel. */
  list?: string;
}

export interface SkippedTableRule {
  kind: Exclude<TableKind, 'export'>;
  reason: string;
}

export type TableRule = ExportTableRule | SkippedTableRule;

const GALERIJ = 'Galerijen gaan niet mee in deze export (keuze van 11 november 2026). Download een galerij als zip bij het project. Bij het wissen van de organisatie gaan ze wel weg.';
const GEHEIM = 'Werkt als sleutel: een token, wachtwoord of versleutelde toegang tot een andere dienst. Buiten ResoFly heb je er niets aan en in een zip is het gevaarlijk. Welke koppelingen er waren, staat in de tabel van de koppeling zelf.';
const LEESSTATUS = 'Wie wat gelezen heeft: alleen voor de weergave in ResoFly.';
const WACHTRIJ = 'Een wachtrij, teller of logboek van de techniek van ResoFly zelf, niet van je administratie.';
const ABONNEMENT = 'Je abonnement bij ResoFly zelf, niet je eigen administratie. De facturen van ResoFly krijg je per mail.';
const PLATFORM = 'Gedeeld door alle organisaties (tarieven, normen, plannen). Geen gegevens van jou.';
const PRIVE = 'Van één teamlid, niet van de organisatie. Een export per teamlid volgt (bouwplan, fase 3).';

const PUBLIC_TOKEN_OMIT = {
  public_token_hash: 'Werkt als sleutel van de openbare link; na de overstap waardeloos.',
  public_token_created_at: 'Hoort bij de openbare link.',
  public_token_expires_at: 'Hoort bij de openbare link.',
} as const;

const TOKEN_HASH_OMIT = { token_hash: 'Werkt als sleutel van de link.' } as const;

export const EXPORT_MANIFEST: Readonly<Record<string, TableRule>> = {
  // ── De organisatie zelf ──────────────────────────────────────────────────
  organizations: { kind: 'export', orgColumn: 'id' },
  organization_members: { kind: 'export' },
  organization_invitations: { kind: 'export' },
  company_settings: { kind: 'export' },

  // ── Klanten en contact ───────────────────────────────────────────────────
  clients: { kind: 'export', list: 'klanten' },
  client_contacts: { kind: 'export', list: 'contactpersonen' },
  client_field_definitions: { kind: 'export' },
  client_calls: { kind: 'export' },
  client_email_threads: { kind: 'export' },
  client_emails: { kind: 'export' },
  client_email_events: { kind: 'export' },
  client_email_reads: { kind: 'intern', reason: LEESSTATUS },
  inbound_messages: { kind: 'export', keep: ['raw_hash'] },
  organization_inbound_aliases: {
    kind: 'export',
    omit: { pending_confirmation_code: 'Een bevestigingscode die even geldig is.' },
  },
  user_sender_identities: { kind: 'export', orderBy: ['user_id'] },
  organization_email_domains: { kind: 'export' },
  client_domains: { kind: 'export' },
  client_subdomains: { kind: 'export' },

  // ── Projecten, taken, tickets, uren ──────────────────────────────────────
  projects: { kind: 'export', list: 'projecten' },
  project_members: { kind: 'export' },
  project_templates: { kind: 'export' },
  project_template_tasks: { kind: 'export' },
  tasks: { kind: 'export', list: 'taken' },
  task_assignees: { kind: 'export' },
  tickets: { kind: 'export', list: 'tickets' },
  ticket_notes: { kind: 'export' },
  ticket_reads: { kind: 'intern', reason: LEESSTATUS },
  time_entries: { kind: 'export', list: 'uren' },
  planner_day_capacity: { kind: 'export' },
  planner_notes: { kind: 'export' },

  // ── Documenten, notities en bestanden ────────────────────────────────────
  attachments: { kind: 'export', files: ['storage_key'] },
  documents: { kind: 'export', files: ['storage_key'] },
  content_folders: { kind: 'export' },
  notes: { kind: 'export' },
  note_handwriting: { kind: 'export' },
  note_calendar_links: { kind: 'export' },
  drive_shares: { kind: 'export', omit: TOKEN_HASH_OMIT },
  file_transfers: { kind: 'export' },
  file_transfer_items: {
    kind: 'export',
    skipFiles: { storage_key: 'Een zending verloopt en wordt daarna opgeruimd. Het overzicht gaat mee, de bestanden niet: die staan bij het origineel.' },
  },
  file_transfer_recipients: { kind: 'export', omit: TOKEN_HASH_OMIT },
  file_transfer_events: { kind: 'export' },
  file_transfer_codes: { kind: 'geheim', reason: GEHEIM },
  file_transfer_sessions: { kind: 'geheim', reason: GEHEIM },

  // ── Agenda en afspraken ──────────────────────────────────────────────────
  calendar_connections: { kind: 'export' },
  calendar_connection_tokens: { kind: 'geheim', reason: GEHEIM },
  calendar_app_passwords: { kind: 'geheim', reason: GEHEIM },
  calendar_sources: {
    kind: 'export',
    // De app mag feed_url en feed_etag niet lezen (kolomrechten), dus geen `*`.
    select: [
      'id', 'organization_id', 'user_id', 'connection_id', 'provider', 'provider_calendar_id', 'name', 'description',
      'color', 'timezone', 'is_primary', 'access_role', 'sync_enabled', 'write_enabled', 'visibility', 'created_at',
      'updated_at', 'change_seq', 'feed_content_hash', 'feed_last_synced_at', 'feed_last_error', 'conference_types',
    ],
    omit: {
      feed_url: 'De link van een agenda-abonnement werkt als sleutel tot die agenda.',
      feed_etag: 'Een controlewaarde voor het ophalen van de feed.',
    },
    keep: ['feed_content_hash'],
  },
  calendar_events: { kind: 'export', omit: { organizer_token: 'Werkt als sleutel voor antwoorden op een uitnodiging.' } },
  calendar_event_attendees: { kind: 'export' },
  calendar_event_links: { kind: 'export' },
  meeting_booking_links: { kind: 'export', omit: PUBLIC_TOKEN_OMIT },
  meeting_booking_slots: { kind: 'export' },
  meeting_bookings: { kind: 'export' },
  meeting_recordings: { kind: 'export', files: ['storage_key'] },

  // ── Chat ─────────────────────────────────────────────────────────────────
  chat_conversations: { kind: 'export' },
  chat_participants: { kind: 'export', orderBy: ['conversation_id', 'user_id'] },
  chat_messages: { kind: 'export' },
  chat_message_reactions: { kind: 'export', orderBy: ['message_id', 'user_id', 'emoji'] },
  chat_conversation_prefs: { kind: 'prive', reason: PRIVE },
  chat_saved_messages: { kind: 'prive', reason: PRIVE },
  chat_member_status: { kind: 'intern', reason: 'De beschikbaarheid die een teamlid nu toont; verloopt vanzelf.' },

  // ── Offertes, contracten, facturen ───────────────────────────────────────
  quotes: { kind: 'export', omit: PUBLIC_TOKEN_OMIT, list: 'offertes' },
  quote_versions: { kind: 'export', files: ['pdf_storage_key'] },
  quote_version_items: { kind: 'export' },
  quote_approval_events: { kind: 'export' },
  quote_email_deliveries: { kind: 'export' },
  quote_email_events: { kind: 'export' },
  contracts: { kind: 'export', omit: PUBLIC_TOKEN_OMIT, files: ['signed_storage_key', 'body_storage_key'] },
  contract_versions: { kind: 'export', files: ['pdf_storage_key'] },
  contract_signers: { kind: 'export' },
  contract_events: { kind: 'export' },
  contract_internal_notes: { kind: 'export' },
  contract_projects: { kind: 'export' },
  contract_templates: { kind: 'export' },
  contract_email_deliveries: { kind: 'export' },
  contract_email_events: { kind: 'export' },
  invoices: { kind: 'export', omit: PUBLIC_TOKEN_OMIT, list: 'facturen' },
  invoice_versions: { kind: 'export', files: ['pdf_storage_key'] },
  invoice_version_items: { kind: 'export' },
  invoice_workflow_events: { kind: 'export' },
  invoice_email_deliveries: { kind: 'export' },
  invoice_email_events: { kind: 'export' },
  invoice_payment_records: { kind: 'export' },
  invoice_public_links: { kind: 'export', omit: TOKEN_HASH_OMIT },
  invoice_refunds: { kind: 'export' },
  invoice_chargebacks: { kind: 'export' },
  invoice_dunning_notices: { kind: 'export' },
  invoice_reminder_settings: { kind: 'export', orderBy: ['organization_id'] },
  credit_notes: { kind: 'export', files: ['pdf_storage_key'], list: 'creditnotas' },
  organization_invoice_number_sequences: { kind: 'export', orderBy: ['invoice_year'] },
  organization_credit_note_number_sequences: { kind: 'export', orderBy: ['credit_note_year'] },
  organization_client_number_sequences: { kind: 'export', orderBy: ['organization_id'] },
  organization_contract_number_sequences: { kind: 'export', orderBy: ['organization_id'] },
  organization_purchase_invoice_number_sequences: { kind: 'export', orderBy: ['year'] },
  organization_invoice_mollie_settings: { kind: 'geheim', reason: GEHEIM },
  organization_mollie_connections: { kind: 'geheim', reason: GEHEIM },
  finance_provider_jobs: { kind: 'intern', reason: WACHTRIJ },

  // ── Inkoop ───────────────────────────────────────────────────────────────
  suppliers: { kind: 'export', list: 'leveranciers' },
  purchase_invoices: { kind: 'export', list: 'inkoopfacturen' },
  purchase_invoice_inbox: { kind: 'export', fileLists: { attachments: 'storage_key' } },
  purchase_invoice_inbox_settings: { kind: 'export', orderBy: ['organization_id'] },

  // ── Boekhouding ──────────────────────────────────────────────────────────
  ledger_accounts: { kind: 'export', list: 'grootboekrekeningen' },
  vat_codes: { kind: 'export' },
  journal_entries: { kind: 'export' },
  journal_lines: { kind: 'export' },
  closed_periods: { kind: 'export' },
  fiscal_years: { kind: 'export' },
  fiscal_year_size_inputs: { kind: 'export' },
  fixed_assets: { kind: 'export', list: 'vaste-activa' },
  asset_depreciations: { kind: 'export' },
  vat_returns: { kind: 'export' },
  vat_supplement_entries: { kind: 'export' },
  bank_accounts: { kind: 'export' },
  bank_statements: { kind: 'export', keep: ['file_hash'] },
  bank_transactions: { kind: 'export', list: 'banktransacties' },
  bank_transaction_allocations: { kind: 'export' },
  bank_rules: { kind: 'export' },
  bank_requisitions: {
    kind: 'export',
    omit: { link: 'De inloglink bij de bank; verloopt en hoort bij ResoFly.' },
  },

  // ── BV: jaarrekening, belasting, aandeelhouders ──────────────────────────
  annual_accounts: { kind: 'export', keep: ['snapshot_hash'] },
  annual_account_filings: { kind: 'export' },
  annual_account_signatures: { kind: 'export' },
  corporate_tax_returns: { kind: 'export' },
  corporate_tax_corrections: { kind: 'export' },
  corporate_tax_losses: { kind: 'export' },
  dga_interest_postings: { kind: 'export' },
  dga_interest_rates: { kind: 'export' },
  dividend_distributions: { kind: 'export' },
  dividend_distribution_lines: { kind: 'export' },
  result_appropriations: { kind: 'export' },
  shareholders: { kind: 'export' },
  share_transactions: { kind: 'export' },
  share_encumbrances: { kind: 'export' },
  partnership_partners: { kind: 'export' },

  // ── Marketing ────────────────────────────────────────────────────────────
  email_campaigns: { kind: 'export' },
  email_campaign_recipients: { kind: 'export' },
  email_flows: { kind: 'export' },
  email_flow_steps: { kind: 'export' },
  email_flow_enrollments: { kind: 'export' },
  email_flow_sends: { kind: 'export' },
  // Wie zich afmeldde, moet dat in het volgende pakket ook blijven.
  email_suppressions: { kind: 'export', orderBy: ['email'] },
  email_templates: { kind: 'export' },
  email_send_counters: { kind: 'intern', reason: WACHTRIJ },
  organization_email_limits: { kind: 'intern', reason: WACHTRIJ },

  // ── Rapportages en Gerrie ────────────────────────────────────────────────
  saved_reports: { kind: 'export' },
  ai_reports: { kind: 'export' },
  ai_report_versions: { kind: 'export' },
  ai_report_messages: { kind: 'export' },
  ai_agents: { kind: 'export' },
  ai_agent_runs: { kind: 'export' },
  ai_agent_run_events: { kind: 'export' },
  ai_decisions: { kind: 'export' },
  ai_decision_mutes: { kind: 'export' },
  ai_signal_settings: { kind: 'export', orderBy: ['organization_id'] },
  ai_action_audit: { kind: 'export' },
  ai_usage: { kind: 'export' },
  ai_conversations: { kind: 'prive', reason: PRIVE },
  ai_messages: { kind: 'prive', reason: PRIVE },
  ai_signals: { kind: 'intern', reason: WACHTRIJ },
  ai_agent_events: { kind: 'intern', reason: WACHTRIJ },

  // ── Logboek en koppelingen ───────────────────────────────────────────────
  audit_logs: { kind: 'export' },
  api_keys: { kind: 'export' },
  webhook_endpoints: { kind: 'export' },
  mcp_grants: { kind: 'export' },
  api_request_log: { kind: 'intern', reason: WACHTRIJ },
  webhook_events: { kind: 'intern', reason: WACHTRIJ },
  webhook_deliveries: { kind: 'intern', reason: WACHTRIJ },
  notification_outbox: { kind: 'intern', reason: WACHTRIJ },
  storage_purge_queue: { kind: 'intern', reason: WACHTRIJ },
  notification_preferences: { kind: 'prive', reason: PRIVE },
  push_subscriptions: { kind: 'geheim', reason: GEHEIM },

  // ── Klantportaal ─────────────────────────────────────────────────────────
  organization_portal_settings: { kind: 'export', orderBy: ['organization_id'] },
  portal_contact_settings: { kind: 'intern', reason: 'Meldingsinstellingen van het klantportaal; alleen de server van ResoFly leest ze.' },
  portal_ticket_activity: { kind: 'intern', reason: WACHTRIJ },
  portal_reads: { kind: 'intern', reason: LEESSTATUS },
  portal_login_addresses: { kind: 'geheim', reason: GEHEIM },
  portal_login_requests: { kind: 'geheim', reason: GEHEIM },
  portal_sessions: { kind: 'geheim', reason: GEHEIM },
  portal_tokens: { kind: 'geheim', reason: GEHEIM },

  // ── Galerijen ────────────────────────────────────────────────────────────
  galleries: { kind: 'galerij', reason: GALERIJ },
  gallery_items: { kind: 'galerij', reason: GALERIJ },
  gallery_categories: { kind: 'galerij', reason: GALERIJ },
  gallery_category_presets: { kind: 'galerij', reason: GALERIJ },
  gallery_favorites: { kind: 'galerij', reason: GALERIJ },

  // ── Abonnement bij ResoFly ───────────────────────────────────────────────
  organization_billing_profiles: { kind: 'abonnement', reason: ABONNEMENT },
  organization_billing_events: { kind: 'abonnement', reason: ABONNEMENT },
  organization_subscriptions: { kind: 'abonnement', reason: ABONNEMENT },
  organization_payment_records: { kind: 'abonnement', reason: ABONNEMENT },
  organization_license_changes: { kind: 'abonnement', reason: ABONNEMENT },
  organization_license_events: { kind: 'abonnement', reason: ABONNEMENT },

  // ── Zonder organization_id: van het platform ─────────────────────────────
  billing_plans: { kind: 'platform', reason: PLATFORM },
  company_size_thresholds: { kind: 'platform', reason: PLATFORM },
  corporate_tax_rates: { kind: 'platform', reason: PLATFORM },
  dga_current_account_limits: { kind: 'platform', reason: PLATFORM },
  dga_norms: { kind: 'platform', reason: PLATFORM },
  dividend_tax_rates: { kind: 'platform', reason: PLATFORM },
  statutory_interest_rates: { kind: 'platform', reason: PLATFORM },
  mcp_clients: { kind: 'platform', reason: 'De AI-apps die zich bij ResoFly aanmeldden; welke jij koppelde, staat in mcp_grants.' },
  api_key_secrets: { kind: 'geheim', reason: GEHEIM },
  webhook_endpoint_secrets: { kind: 'geheim', reason: GEHEIM },
  mcp_auth_codes: { kind: 'geheim', reason: GEHEIM },
  mcp_tokens: { kind: 'geheim', reason: GEHEIM },
  api_auth_failures: { kind: 'intern', reason: WACHTRIJ },
  api_idempotency_keys: { kind: 'intern', reason: WACHTRIJ },
  portal_login_attempts: { kind: 'intern', reason: WACHTRIJ },
  gallery_pin_attempts: { kind: 'galerij', reason: GALERIJ },
};

/**
 * Woorden in een kolomnaam die op een sleutel wijzen. Per woord, niet als
 * stukje tekst: `auditor_opinion_received` bevat "pin", `input_tokens` is een
 * telling en `is_pinned` een vlag. Die mogen gewoon mee.
 */
export const SECRET_WORDS: readonly string[] = [
  'token', 'secret', 'password', 'passwd', 'hash', 'pin', 'salt', 'verifier', 'otp', 'nonce', 'cookie', 'encrypted', 'credential', 'credentials', 'apikey',
];

export function looksSecret(column: string): boolean {
  return column.toLowerCase().split('_').some(word => SECRET_WORDS.includes(word));
}

export interface ExportTable extends ExportTableRule {
  table: string;
  orgColumn: string;
  orderBy: readonly string[];
}

/** De tabellen die meegaan, met hun standaarden ingevuld, in een vaste volgorde. */
export function exportTables(): ExportTable[] {
  return Object.entries(EXPORT_MANIFEST)
    .filter((entry): entry is [string, ExportTableRule] => entry[1].kind === 'export')
    .map(([table, rule]) => ({
      ...rule,
      table,
      orgColumn: rule.orgColumn ?? 'organization_id',
      orderBy: rule.orderBy ?? ['id'],
    }));
}

/** De tabellen die niet meegaan, met hun reden: zo komt het ook in manifest.json en LEESMIJ.txt. */
export function skippedTables(): Array<{ table: string; kind: Exclude<TableKind, 'export'>; reason: string }> {
  return Object.entries(EXPORT_MANIFEST)
    .filter((entry): entry is [string, SkippedTableRule] => entry[1].kind !== 'export')
    .map(([table, rule]) => ({ table, kind: rule.kind, reason: rule.reason }));
}

/**
 * Een rij zoals hij de zip in gaat: zonder de weggelaten kolommen, en zonder
 * elke kolom die op een sleutel lijkt en niet uitdrukkelijk mag. Dat tweede is
 * een vangnet voor een kolom die na dit manifest bijkwam; de test vangt hem
 * normaal al eerder.
 */
export function cleanRow(rule: ExportTableRule, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (rule.omit && column in rule.omit) continue;
    if (looksSecret(column) && !rule.keep?.includes(column)) continue;
    out[column] = value;
  }
  return out;
}

/** De opslagsleutels in een rij die mee moeten, volgens files en fileLists. */
export function fileKeysOf(rule: ExportTableRule, row: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const column of rule.files ?? []) {
    const value = row[column];
    if (typeof value === 'string' && value.trim()) keys.push(value.trim());
  }
  for (const [column, field] of Object.entries(rule.fileLists ?? {})) {
    const list = row[column];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const value = item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : null;
      if (typeof value === 'string' && value.trim()) keys.push(value.trim());
    }
  }
  return keys;
}

/** Map in bestanden/ per tweede segment van de opslagsleutel (<org>/<segment>/…). */
const FILE_FOLDERS: Readonly<Record<string, string>> = {
  client: 'klanten',
  project: 'projecten',
  task: 'taken',
  subtask: 'taken',
  ticket: 'tickets',
  note: 'notities',
  document: 'documenten',
  folder: 'documenten',
  quote: 'offertes',
  'quote-pdfs': 'offertes-pdf',
  invoice: 'facturen',
  'invoice-pdfs': 'facturen-pdf',
  contract: 'contracten',
  'contract-pdfs': 'contracten-pdf',
  annual_account: 'jaarrekeningen',
  'annual-account-pdfs': 'jaarrekeningen',
  supplier: 'leveranciers',
  purchase_invoice: 'inkoopfacturen',
  purchase_invoice_inbox: 'inkoopfacturen-inbox',
  fixed_asset: 'vaste-activa',
  meeting_recording: 'opnames',
  chat_message: 'chat',
};

/** Segmenten die nooit in de export horen, ook niet als een rij ernaar wijst. */
export const EXCLUDED_FILE_SEGMENTS: ReadonlySet<string> = new Set(['gallery', 'transfer']);

/**
 * Het pad in de zip voor een opslagsleutel van deze organisatie, of null als
 * het bestand er niet in hoort (galerij, zending, of een sleutel van een
 * andere organisatie: die vraagt de export nooit op).
 */
export function zipPathForKey(storageKey: string, organizationId: string): string | null {
  const parts = storageKey.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== organizationId) return null;
  if (parts.some(part => part === '..' || part === '.')) return null;
  const segment = parts[1];
  if (EXCLUDED_FILE_SEGMENTS.has(segment)) return null;
  const folder = FILE_FOLDERS[segment] ?? 'overig';
  return ['bestanden', folder, ...parts.slice(2)].join('/');
}
