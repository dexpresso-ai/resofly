// Seed-data voor de mock-backend: één organisatie met wat realistische inhoud,
// zodat elke pagina iets te tonen heeft in de screenshots.
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const USER2 = '33333333-3333-4333-8333-333333333333';
const NOW = new Date();
const iso = (d) => d.toISOString();
const day = (offset) => { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset); return d; };
const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monday = (() => { const d = day(0); const wd = (d.getDay() + 6) % 7; return day(-wd); })();
const mon = (o) => dkey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + o));
let n = 0;
const uid = (p = 'a') => `${p}${String(++n).padStart(7, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
const base = (extra = {}) => ({ organization_id: ORG, created_by: USER, created_at: iso(day(-30)), updated_at: iso(day(-1)), ...extra });

export const org = { id: ORG, name: 'Studio Lopik', slug: 'studio-lopik', parent_organization_id: null, created_by: USER, licensed_seats: 3, license_status: 'active', license_provider: null, license_external_customer_id: null, license_external_subscription_id: null, created_at: iso(day(-200)), updated_at: iso(day(-1)) };
export const user = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'gerjan@studiolopik.nl', email_confirmed_at: iso(day(-200)), phone: '', confirmed_at: iso(day(-200)), last_sign_in_at: iso(day(-1)), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: iso(day(-200)), updated_at: iso(day(-1)) };
export const members = [
  { id: uid('m'), organization_id: ORG, user_id: USER, role: 'owner', status: 'active', invited_by: null, joined_at: iso(day(-200)), created_at: iso(day(-200)), updated_at: iso(day(-200)), email: 'gerjan@studiolopik.nl', module_access: null },
  { id: uid('m'), organization_id: ORG, user_id: USER2, role: 'member', status: 'active', invited_by: USER, joined_at: iso(day(-100)), created_at: iso(day(-100)), updated_at: iso(day(-100)), email: 'sanne@studiolopik.nl', module_access: null },
];

const clientDefs = [
  ['Bakkerij De Korenaar', 'Joost Vermeer', '#FFD966', 'active', ['retail', 'huisstijl'], 18500],
  ['Fysio Centrum Zuid', 'Maria Jansen', '#34D399', 'active', ['zorg'], 9200],
  ['Van Dijk Installatietechniek', 'Peter van Dijk', '#60A5FA', 'active', ['b2b', 'website'], 24000],
  ['Kinderopvang Zonnetje', 'Els de Boer', '#F472B6', 'prospect', ['zorg', 'huisstijl'], 4000],
  ['Restaurant Bloem', 'Karim El Amrani', '#FF9F43', 'active', ['horeca', 'social'], 6600],
  ['Notariskantoor Hendriks', 'Willem Hendriks', '#A78BFA', 'inactive', ['zakelijk'], 12000],
];
export const clients = clientDefs.map(([name, contact, color, status, tags, value], i) => ({
  id: uid('c'), ...base(), name, client_code: `K-${String(1001 + i)}`, contact_name: contact, email: `${contact.split(' ')[0].toLowerCase()}@${name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}.nl`, phone: `06-1234 56${String(10 + i)}`, notes: null, color, status, client_kind: 'business', tags, follow_up: i === 3 ? mon(2) : null, value_eur: value, vat_number: 'NL001234567B01', kvk_number: `1234567${i}`, address_line1: `Dorpsstraat ${10 + i}`, address_line2: null, postal_code: `34${10 + i} AB`, city: 'Lopik', country: 'NL', custom_fields: {},
}));

const projectDefs = [
  ['Nieuwe huisstijl De Korenaar', 0, '#FFD966', 'Logo, kleuren en drukwerk voor drie vestigingen.', -20, 25],
  ['Website Fysio Centrum Zuid', 1, '#34D399', 'Nieuwe site met online afspraken.', -40, 10],
  ['Campagne winteractie Van Dijk', 2, '#60A5FA', 'Social + mailing rond de winteronderhoudsbeurt.', -5, 40],
  ['Menukaart & social Bloem', 4, '#FF9F43', 'Maandelijkse content en de nieuwe menukaart.', -60, 30],
  ['Onboarding Zonnetje', 3, '#F472B6', 'Kennismaking en voorstel.', 0, 14],
];
export const projects = projectDefs.map(([name, ci, color, description, s, e]) => ({
  id: uid('p'), ...base(), client_id: clients[ci].id, name, description, color, archived: false, start_date: dkey(day(s)), end_date: dkey(day(e)), contract_id: null, hourly_rate_cents: 8500, billing_type: 'hourly', budgeted_minutes: 60 * 40,
}));

const taskDefs = [
  // [title, project idx, status, prio, planned offset from monday (or null), start minute, est min, deadline offset]
  ['Logo-schetsen uitwerken', 0, 'doing', 'high', 0, 9 * 60, 120, 2],
  ['Kleurenpalet afstemmen met Joost', 0, 'todo', 'med', 0, 13 * 60, 60, 3],
  ['Drukproef briefpapier', 0, 'todo', 'med', 3, null, 45, 6],
  ['Wireframes afsprakenmodule', 1, 'review', 'high', 1, 10 * 60, 180, 1],
  ['Teksten homepage', 1, 'todo', 'low', 2, null, 90, 8],
  ['Fotoshoot plannen', 1, 'todo', 'med', 4, 14 * 60, 60, 12],
  ['Mailing winteractie schrijven', 2, 'todo', 'high', 1, 14 * 60, 120, 2],
  ['Social posts week 38', 2, 'todo', 'med', 2, 9 * 60 + 30, 90, 4],
  ['Advertentiebudget bespreken', 2, 'todo', 'low', null, null, 30, 9],
  ['Menukaart drukklaar maken', 3, 'doing', 'high', 0, 15 * 60, 90, 0],
  ['Instagram reels monteren', 3, 'todo', 'med', 3, 11 * 60, 120, 5],
  ['Reactie klant verwerken', 3, 'done', 'med', -3, null, 30, -2],
  ['Kennismakingsgesprek voorbereiden', 4, 'todo', 'med', 1, null, 45, 1],
  ['Offerte opstellen Zonnetje', 4, 'todo', 'high', 2, 16 * 60, 60, 3],
  ['Factuur Q3 nabellen', null, 'todo', 'low', 4, null, 15, 4],
  ['Portfolio bijwerken', null, 'todo', 'low', null, null, 60, null],
  ['Uren invoeren augustus', null, 'done', 'low', -6, null, 30, -8],
  ['Terugbellen Peter over planning', 2, 'todo', 'high', -1, null, 15, -1],
];
export const tasks = taskDefs.map(([title, pi, status, priority, po, startMin, est, dl]) => {
  const p = pi == null ? null : projects[pi];
  return {
    id: uid('t'), ...base(), project_id: p ? p.id : null, client_id: p ? p.client_id : null, title, description: null, status, priority, tags: [], start_date: null, end_date: dl == null ? null : mon(dl), planned_date: po == null ? null : mon(po), ticket_id: null, planned_end_date: null, planned_start_minute: startMin, planned_order: 0, estimated_minutes: est, subtasks: [], comments: [],
  };
});
export const taskAssignees = tasks.slice(0, 10).map(t => ({ id: uid('x'), ...base(), task_id: t.id, user_id: USER }));
export const projectMembers = projects.map(p => ({ id: uid('y'), ...base(), project_id: p.id, user_id: USER }));

export const tickets = [
  ['Website laadt traag op mobiel', 1, 'high', 'new'],
  ['Nieuwe flyer voor herfstactie', 0, 'med', 'review'],
  ['Logo in hogere resolutie', 2, 'low', 'approved'],
  ['Menukaart: prijswijziging', 4, 'med', 'new'],
  ['Vraag over factuur 2026-014', 3, 'low', 'rejected'],
].map(([title, ci, priority, status]) => ({ id: uid('k'), ...base(), client_id: clients[ci].id, title, description: 'Ingezonden via het klantportaal.', priority, status, notes: null, converted_to_project_id: null }));

export const notes = [
  ['Notulen kick-off huisstijl', 0, 'meeting', '<p>Besproken: kleuren, tone of voice. <strong>Actie:</strong> schetsen voor vrijdag.</p><ul><li>Joost stuurt oude logo\'s</li><li>Fotoshoot in oktober</li></ul>'],
  ['Idee: seizoenscampagne', 2, 'idea', '<p>Winteronderhoud koppelen aan een korting voor bestaande klanten.</p>'],
  ['Besluit: hosting bij TransIP', 1, 'decision', '<p>Klant kiest voor TransIP, wij regelen de DNS.</p>'],
  ['Todo lijst Bloem', 3, 'action', '<p>Menukaart, reels, stories.</p>'],
].map(([title, pi, note_type, content]) => ({ id: uid('n'), ...base(), client_id: projects[pi].client_id, project_id: projects[pi].id, folder_id: null, title, content, note_type, tags: [] }));

export const documents = [
  ['Briefing huisstijl De Korenaar', 0, 'general'],
  ['Onderhoudscontract website Fysio', 1, 'contract'],
  ['Werkwijze social content', 3, 'procedure'],
].map(([title, pi, document_type]) => ({ id: uid('d'), ...base(), client_id: projects[pi].client_id, project_id: projects[pi].id, folder_id: null, title, content: '<p>Documenttekst…</p>', document_type }));

export const folders = [
  { id: uid('f'), ...base(), client_id: clients[0].id, project_id: null, parent_id: null, name: 'Aangeleverd materiaal', position: 0 },
  { id: uid('f'), ...base(), client_id: clients[0].id, project_id: projects[0].id, parent_id: null, name: 'Concepten', position: 0 },
  { id: uid('f'), ...base(), client_id: clients[1].id, project_id: null, parent_id: null, name: 'Contracten', position: 0 },
];
export const attachments = [
  ['logo-oud.png', 'image/png', 180_000, 'client', 0],
  ['huisstijl-schets-v2.pdf', 'application/pdf', 1_240_000, 'project', 0],
  ['moodboard.jpg', 'image/jpeg', 2_400_000, 'project', 0],
  ['offerte-website.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 64_000, 'client', 1],
].map(([name, mime_type, size_bytes, entity_type, idx]) => ({ id: uid('b'), ...base(), entity_type, entity_id: entity_type === 'client' ? clients[idx].id : projects[idx].id, parent_task_id: null, name, mime_type, size_bytes, storage_key: `org/${ORG}/${name}`, public_url: null }));

const line = (description, quantity, unit_price) => ({ id: uid('l'), description, quantity, unit_price, vat: 21, vat_code: null });
const quoteBase = () => ({ sent_at: null, accepted_at: null, internal_approval_status: 'draft', internal_approval_requested_at: null, internal_approval_requested_by: null, internal_approved_at: null, internal_approved_by: null, internal_rejected_at: null, internal_rejected_by: null, internal_rejection_note: null, client_decision_at: null, client_decision_by_name: null, client_decision_by_email: null, client_decision_note: null, public_token_hash: null, public_token_created_at: null, public_token_expires_at: null, resend_last_email_id: null, last_email_delivery_status: null, last_email_delivery_at: null, last_email_opened_at: null, last_email_clicked_at: null, last_email_failed_at: null, latest_version_id: null, internal_approved_version_id: null, sent_version_id: null, accepted_version_id: null, accepted_sent_version_id: null, last_pdf_file_name: null, last_pdf_mime_type: null, last_pdf_size_bytes: null, last_pdf_sha256: null });
export const quotes = [
  ['2026-021', 4, 'draft', [line('Huisstijlpakket', 1, 3200), line('Drukwerk', 1, 480)]],
  ['2026-020', 2, 'sent', [line('Campagne winteractie', 1, 2750)]],
  ['2026-019', 0, 'accepted', [line('Huisstijl', 1, 4800), line('Fotoshoot', 1, 950)]],
  ['2026-018', 1, 'rejected', [line('Onderhoud per maand', 12, 95)]],
].map(([number, pi, status, lines]) => ({ id: uid('q'), ...base(), client_id: projects[pi].client_id, project_id: projects[pi].id, number, date: dkey(day(-10)), valid_until: dkey(day(20)), lines, status, notes: null, ...quoteBase(), sent_at: status === 'draft' ? null : iso(day(-9)), accepted_at: status === 'accepted' ? iso(day(-4)) : null }));

export const invoices = [
  ['2026-041', 0, 'sent', -12, 18, [line('Huisstijl fase 1', 1, 2400)]],
  ['2026-040', 3, 'overdue', -40, -10, [line('Content september', 1, 650)]],
  ['2026-039', 1, 'paid', -30, 0, [line('Website oplevering', 1, 5200)]],
  ['2026-038', 2, 'paid', -50, -20, [line('Advies', 6, 85)]],
  ['2026-037', 3, 'paid', -70, -40, [line('Content augustus', 1, 650)]],
  ['2026-042', 4, 'draft', 0, 30, [line('Onboarding', 1, 350)]],
].map(([number, pi, status, d, due, lines]) => {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  return { id: uid('i'), ...base(), client_id: projects[pi].client_id, project_id: projects[pi].id, quote_id: null, number, date: dkey(day(d)), due_date: dkey(day(due)), lines, status, notes: null, sent_at: status === 'draft' ? null : iso(day(d)), paid_at: status === 'paid' ? iso(day(due)) : null, subtotal_amount: subtotal, vat_amount: Math.round(subtotal * 0.21 * 100) / 100, total_amount: Math.round(subtotal * 1.21 * 100) / 100, currency: 'EUR', reminder_level: 0, reminders_paused: false };
});

export const timeEntries = [
  [0, 0, 0, 9 * 60, 120, 'Logo-schetsen'],
  [0, 1, 1, 13 * 60, 90, 'Wireframes'],
  [1, 2, 6, 9 * 60, 150, 'Mailing'],
  [1, 3, 9, 15 * 60, 60, 'Menukaart'],
  [2, 0, 1, 10 * 60, 60, 'Overleg Joost'],
  [-4, 1, 3, 11 * 60, 180, 'Wireframes'],
  [-5, 3, 10, 9 * 60, 120, 'Reels'],
].map(([dayOff, pi, ti, startMin, minutes, description]) => {
  const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOff, Math.floor(startMin / 60), startMin % 60);
  return { id: uid('h'), ...base(), user_id: USER, project_id: projects[pi].id, client_id: projects[pi].client_id, task_id: tasks[ti].id, source: 'manual', calendar_event_link_id: null, description, entry_date: dkey(d), started_at: iso(d), ended_at: iso(new Date(d.getTime() + minutes * 60000)), minutes, billable: true, entry_type: 'direct', indirect_category: null, hourly_rate_cents: 8500 };
});

export const plannerNotes = [
  { id: uid('w'), ...base(), user_id: USER, week_start: mon(0), text: 'Drukker bellen over levertijd', done: false, position: 0 },
  { id: uid('w'), ...base(), user_id: USER, week_start: mon(0), text: 'Portfolio-case Bloem online zetten', done: true, position: 1 },
];

export const companySettings = { id: uid('s'), ...base(), company_name: 'Studio Lopik B.V.', legal_form: 'bv', trade_name: 'Studio Lopik', address_line1: 'Kerkstraat 12', address_line2: null, postal_code: '3411 AB', city: 'Lopik', country: 'NL', email: 'info@studiolopik.nl', phone: '0348-123456', website: 'https://studiolopik.nl', kvk_number: '12345678', vat_number: 'NL123456789B01', iban: 'NL12ABNA0123456789', invoice_payment_terms: 'Betaling binnen 14 dagen.', invoice_footer: null, invoice_template_kind: 'none', invoice_template_file_name: null, invoice_template_mime_type: null, invoice_template_file_size: 0, invoice_template_data_url: null, invoice_template_text_color: '#111111', invoice_accent_color: '#FFD966', invoice_font_size: 10, invoice_template_updated_at: null, bookkeeping_start_date: '2026-01-01', kor_enabled: false, vat_return_period: 'quarter', fiscal_year_start_month: 1, year_result_account_code: '0510', default_hourly_rate_cents: 8500, brand_logo_data_url: null, brand_accent_color: '#FFD966', brand_footer_text: null, brand_hide_powered_by: false, brand_heading_font: 'poppins', brand_body_font: 'poppins', brand_gallery_bg: '#12110E', brand_client_theme: 'dark' };

export const calendarSource = { id: uid('v'), organization_id: ORG, user_id: USER, connection_id: null, provider: 'native', provider_calendar_id: 'native-main', name: 'Studio-agenda', description: null, color: '#FFD966', timezone: 'Europe/Amsterdam', is_primary: true, access_role: 'owner', sync_enabled: true, write_enabled: true, visibility: 'organization', created_at: iso(day(-200)), updated_at: iso(day(-1)) };
const ev = (dayOff, sh, sm, eh, em, title, location) => {
  const s = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOff, sh, sm);
  const e = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOff, eh, em);
  const id = uid('e');
  return { id, provider: 'native', source_id: calendarSource.id, source_name: calendarSource.name, provider_event_id: id, title, description: null, location, starts_at: iso(s), ends_at: iso(e), all_day: false, html_link: null, meeting_url: null, attendees: null, visibility: 'organization', native_event_id: id, rrule: null, recurs: false };
};
export const events = [
  ev(0, 10, 0, 11, 0, 'Overleg Joost — kleurenpalet', 'Bakkerij De Korenaar'),
  ev(0, 16, 0, 16, 30, 'Weekstart team', 'Studio'),
  ev(1, 9, 30, 10, 30, 'Belafspraak Peter van Dijk', null),
  ev(1, 13, 0, 15, 0, 'Werksessie wireframes', 'Studio'),
  ev(2, 11, 0, 12, 0, 'Kennismaking Zonnetje', 'Kinderopvang Zonnetje'),
  ev(3, 9, 0, 12, 0, 'Fotoshoot Bloem', 'Restaurant Bloem'),
  ev(4, 15, 0, 16, 0, 'Weekafsluiting', 'Studio'),
  ev(7, 10, 0, 11, 0, 'Drukproef bespreken', 'Drukkerij'),
  ev(-6, 10, 0, 11, 30, 'Presentatie concept', 'Studio'),
];

export const ids = { ORG, USER, USER2 };
export const tables = {
  clients, client_contacts: [
    { id: uid('o'), ...base(), client_id: clients[0].id, name: 'Joost Vermeer', email: 'joost@dekorenaar.nl', phone: '06-11223344', role: 'Eigenaar', gives_portal_access: true, is_active: true },
    { id: uid('o'), ...base(), client_id: clients[0].id, name: 'Anja Vermeer', email: 'anja@dekorenaar.nl', phone: null, role: 'Marketing', gives_portal_access: false, is_active: true },
  ],
  client_field_definitions: [], projects, tasks, tickets, ticket_notes: [
    { id: uid('z'), ...base(), ticket_id: tickets[0].id, author_type: 'client', author_user_id: null, author_name: 'Maria Jansen', body: 'Vooral op de pagina met afspraken duurt het lang.', is_internal: false },
    { id: uid('z'), ...base(), ticket_id: tickets[0].id, author_type: 'user', author_user_id: USER, author_name: 'Gerjan', body: 'We kijken naar de afbeeldingen, die zijn te groot.', is_internal: true },
  ],
  notes, documents, content_folders: folders, folders, note_calendar_links: [], calendar_event_links: [], time_entries: timeEntries, quotes, quote_approval_events: [], quote_email_deliveries: [], quote_versions: [], invoices, invoice_workflow_events: [], invoice_email_deliveries: [], invoice_payment_records: [], invoice_versions: [], invoice_refunds: [], credit_notes: [], invoice_chargebacks: [], dunning_notices: [], ledger_accounts: [], vat_codes: [], journal_entries: [], journal_lines: [], closed_periods: [], fiscal_years: [], suppliers: [], purchase_invoices: [], fixed_assets: [], asset_depreciations: [], vat_returns: [], bank_accounts: [], bank_statements: [], bank_transactions: [], bank_rules: [], bank_requisitions: [], attachments, drive_shares: [], galleries: [], saved_reports: [], planner_notes: plannerNotes, planner_day_capacity: [], company_settings: [companySettings], project_members: projectMembers, task_assignees: taskAssignees, project_templates: [], project_template_tasks: [], contract_projects: [], organization_invitations: [], audit_logs: [], contracts: [],
};
