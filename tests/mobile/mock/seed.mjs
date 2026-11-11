// Seed-data voor de mock-backend: één organisatie met wat realistische inhoud,
// zodat elke pagina iets te tonen heeft in de screenshots.
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const USER2 = '33333333-3333-4333-8333-333333333333';
const USER3 = '44444444-4444-4444-8444-444444444444';
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
  { id: uid('m'), organization_id: ORG, user_id: USER3, role: 'member', status: 'active', invited_by: USER, joined_at: iso(day(-60)), created_at: iso(day(-60)), updated_at: iso(day(-60)), email: 'daan.bakker@studiolopik.nl', module_access: null },
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
  // Accountlead (2026-11-11): afwisselend jij, Sanne en niemand, zodat de kaart, de tabel en het filter alle drie gemeten worden.
  account_lead_user_id: [USER, USER2, null][i % 3],
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
  // Afgehandeld (2026-11-05): staan in het archief, niet op de werklijst. De
  // eerste hoort bij clients[0], zodat het archief in het klantdossier ook
  // gemeten wordt (pagina client-tickets).
  ['Contactformulier stuurde geen mail', 0, 'med', 'resolved'],
  ['Openingstijden aangepast op de site', 2, 'low', 'resolved'],
].map(([title, ci, priority, status], i) => ({ id: uid('k'), ...base(), client_id: clients[ci].id, title, description: 'Ingezonden via het klantportaal.', priority, status, notes: null, converted_to_project_id: null, resolved_at: status === 'resolved' ? iso(day(-2 - i)) : null,
  // Toegewezen (2026-11-11): jij, Sanne, Daan of niemand.
  assignee_user_id: [USER, USER2, null, USER3][i % 4] }));

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
// Instellingen → Agenda: een werkende Google-koppeling en een verlopen
// Microsoft-koppeling (met uitleg en de knop "Opnieuw koppelen"), zodat die
// kaart op de telefoon gemeten wordt.
const googleConnectionId = uid('k');
export const calendarConnections = [
  { id: googleConnectionId, organization_id: ORG, user_id: USER, provider: 'google', provider_account_id: 'g-1', provider_account_email: 'gerjan.studiolopik@gmail.com', display_name: 'Gerjan van Lopik', status: 'active', scopes: [], last_error: null, created_at: iso(day(-40)), updated_at: iso(day(-1)) },
  { id: uid('k'), organization_id: ORG, user_id: USER, provider: 'microsoft', provider_account_id: 'm-1', provider_account_email: 'gerjan@studiolopik.onmicrosoft.com', display_name: 'Gerjan (werk)', status: 'expired', scopes: [], last_error: 'Microsoft geeft ResoFly geen toegang meer tot deze agenda (ingetrokken of verlopen). Koppel het account opnieuw.', created_at: iso(day(-90)), updated_at: iso(day(-3)) },
];
export const googleCalendarSource = { id: uid('v'), organization_id: ORG, user_id: USER, connection_id: googleConnectionId, provider: 'google', provider_calendar_id: 'primary', name: 'Gerjan van Lopik', description: null, color: '#9fe1e7', timezone: 'Europe/Amsterdam', is_primary: true, access_role: 'owner', sync_enabled: false, write_enabled: false, visibility: 'private', conference_types: ['hangoutsMeet'], created_at: iso(day(-40)), updated_at: iso(day(-1)) };
// Google Meet en Teams buiten de agenda (calendar-integrations: videoServices):
// Meet nog aan te zetten, de Microsoft-koppeling verlopen. Zo staan in
// Instellingen → Agenda de knoppen "Google Meet aanzetten" en "Teams
// aanzetten" in beeld, de langste stand van die kaarten.
export const videoServices = {
  google_meet: { state: 'toestemming', account: 'gerjan.studiolopik@gmail.com', connectionId: googleConnectionId },
  teams: { state: 'verlopen', account: 'gerjan@studiolopik.onmicrosoft.com', connectionId: null },
};
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

// ── Teamchat ───────────────────────────────────────────────────────────────
// Zoals in Teams: een 1-op-1-chat, een groepschat (vastgemaakt, met een
// vermelding en iets dringends), en twee kanalen met posts en draadjes. Plus
// reacties, een citaat, een vergadering, statussen en wat activiteit — genoeg
// om de chat op elk formaat echt te laten renderen.
const CHAT_CHANNEL = uid('h');
const CHAT_DM = uid('h');
const CHAT_GROUP = uid('h');
const CHAT_MARKETING = uid('h');
const at = (dayOff, h, m) => iso(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOff, h, m));
const conv = (id, kind, title, description, visibility, lastAt, createdOff) => ({
  id, organization_id: ORG, kind, title, description, dm_key: kind === 'dm' ? [USER, USER2].sort().join(':') : null,
  visibility, is_archived: false, last_message_at: lastAt, created_by: USER, created_at: iso(day(createdOff)), updated_at: lastAt,
});
export const chatConversations = [
  conv(CHAT_GROUP, 'group', 'Lancering Korenaar', null, 'private', at(0, 10, 2), -12),
  conv(CHAT_DM, 'dm', null, null, 'private', at(0, 9, 41), -40),
  conv(CHAT_CHANNEL, 'channel', 'Studio algemeen', 'Alles wat het hele team aangaat', 'public', at(0, 9, 20), -60),
  conv(CHAT_MARKETING, 'channel', 'Marketing', 'Campagnes, social en de nieuwsbrief', 'private', at(-1, 15, 5), -30),
];
const part = (conversation_id, user_id, role, lastRead, joinedOff) => ({ conversation_id, organization_id: ORG, user_id, role, last_read_at: lastRead, joined_at: iso(day(joinedOff)) });
export const chatParticipants = [
  part(CHAT_GROUP, USER, 'admin', at(0, 9, 0), -12), part(CHAT_GROUP, USER2, 'member', at(0, 10, 2), -12), part(CHAT_GROUP, USER3, 'member', at(0, 9, 58), -12),
  part(CHAT_DM, USER, 'member', at(0, 9, 45), -40), part(CHAT_DM, USER2, 'member', at(0, 9, 44), -40),
  part(CHAT_CHANNEL, USER, 'admin', at(0, 9, 0), -60), part(CHAT_CHANNEL, USER2, 'member', at(0, 9, 30), -60), part(CHAT_CHANNEL, USER3, 'member', at(0, 9, 30), -50),
  part(CHAT_MARKETING, USER, 'admin', at(-1, 16, 0), -30), part(CHAT_MARKETING, USER2, 'member', at(-1, 16, 0), -30),
];
const chatMsg = (conversation_id, sender_id, body, created_at, extra = {}) => ({
  id: uid('g'), organization_id: ORG, conversation_id, sender_id, body, mentions: [], attachment_count: 0,
  edited_at: null, deleted_at: null, created_at, updated_at: created_at,
  kind: 'text', reply_to_id: null, parent_id: null, subject: null, importance: 'normal', meta: {}, pinned_at: null, pinned_by: null,
  ...extra,
});
const dm1 = chatMsg(CHAT_DM, USER2, 'We moeten even naar het logo van de Korenaar kijken. De klant twijfelt over het korenaartje.', at(-1, 16, 12));
const dm2 = chatMsg(CHAT_DM, USER, 'Ja tuurlijk, geen enkel probleem! Laten we dat samen doen.', at(-1, 16, 20));
const dm3 = chatMsg(CHAT_DM, USER2, 'Ik heb drie varianten gemaakt:\n- **A**: het bestaande, iets strakker\n- **B**: zonder aar, alleen de letters\n- **C**: aar als accent op de _K_', at(0, 9, 31));
const dm4 = chatMsg(CHAT_DM, USER, 'Mooi! Ik neig naar C. Zullen we het even bespreken?', at(0, 9, 36), { reply_to_id: dm3.id });
const dm5 = chatMsg(CHAT_DM, USER2, 'Vergadering', at(0, 9, 41), { kind: 'meeting', meta: { url: 'https://meet.jit.si/ResoFly-demo-korenaar', provider: 'jitsi', audio_only: false } });
const g1 = chatMsg(CHAT_GROUP, USER, 'Goedemorgen allebei! Vrijdag gaat de nieuwe huisstijl live. Wat staat er nog open?', at(0, 8, 50));
const g2 = chatMsg(CHAT_GROUP, USER3, 'De menukaarten zijn bij de drukker. Levering donderdag.', at(0, 9, 5));
const g3 = chatMsg(CHAT_GROUP, USER3, 'Ik zet de social posts klaar in de planning 📅', at(0, 9, 6));
const g4 = chatMsg(CHAT_GROUP, USER2, '@Gerjan kun jij de definitieve bestanden vandaag nog naar de klant sturen? Ze willen het voor de lunch zien.', at(0, 9, 58), { mentions: [USER], importance: 'urgent' });
const g5 = chatMsg(CHAT_GROUP, USER2, '👍', at(0, 10, 2));
const c1 = chatMsg(CHAT_CHANNEL, USER2, 'Goedemorgen! De drukproef van de Korenaar ligt op je bureau. Graag vóór 12:00 akkoord, dan kan hij vandaag nog de pers in.', at(-1, 16, 40), { subject: 'Drukproef De Korenaar', importance: 'important', pinned_at: at(-1, 16, 45), pinned_by: USER });
const c1r1 = chatMsg(CHAT_CHANNEL, USER, 'Top, ik kijk er vanochtend naar.', at(0, 8, 55), { parent_id: c1.id });
const c1r2 = chatMsg(CHAT_CHANNEL, USER3, 'Let op de afloop rechtsonder, die was vorige keer te krap.', at(0, 9, 2), { parent_id: c1.id });
const c1r3 = chatMsg(CHAT_CHANNEL, USER2, 'Goed punt, staat genoteerd.', at(0, 9, 4), { parent_id: c1.id });
const c2 = chatMsg(CHAT_CHANNEL, USER2, 'De fotoshoot van donderdag staat rond — Karim heeft bevestigd. We beginnen om 9:00 bij Restaurant Bloem.', at(0, 9, 12), { subject: 'Fotoshoot Bloem' });
const c2r1 = chatMsg(CHAT_CHANNEL, USER3, 'Ik neem de reflectieschermen mee.', at(0, 9, 20), { parent_id: c2.id });
const m1 = chatMsg(CHAT_MARKETING, USER, 'Nieuwsbrief van november: wie levert de tekst over de winteractie aan?', at(-1, 15, 0), { subject: 'Nieuwsbrief november' });
const m1r1 = chatMsg(CHAT_MARKETING, USER2, 'Doe ik! Morgen in je mail.', at(-1, 15, 5), { parent_id: m1.id });
export const chatMessages = [dm1, dm2, dm3, dm4, dm5, g1, g2, g3, g4, g5, c1, c1r1, c1r2, c1r3, c2, c2r1, m1, m1r1];
const react = (message, user_id, emoji) => ({ message_id: message.id, conversation_id: message.conversation_id, organization_id: ORG, user_id, emoji, created_at: message.created_at });
export const chatReactions = [
  react(dm3, USER, '❤️'), react(g1, USER2, '👍'), react(g1, USER3, '👍'), react(g3, USER, '🎉'),
  react(c1, USER, '👍'), react(c1, USER3, '👍'), react(c2, USER, '😆'), react(c1r2, USER2, '❤️'),
];
export const chatPrefs = [
  { conversation_id: CHAT_GROUP, user_id: USER, organization_id: ORG, is_pinned: true, is_muted: false, hidden_at: null, marked_unread: false, updated_at: iso(day(-2)) },
];
export const chatStatuses = [
  { organization_id: ORG, user_id: USER2, availability: 'busy', status_message: 'Op locatie bij Restaurant Bloem tot 14:00', message_expires_at: null, updated_at: iso(day(0)) },
  { organization_id: ORG, user_id: USER3, availability: 'auto', status_message: null, message_expires_at: null, updated_at: iso(day(-1)) },
];
export const chatUnread = [
  { conversation_id: CHAT_GROUP, unread_count: 3 },
  { conversation_id: CHAT_CHANNEL, unread_count: 2 },
];
export const chatActivity = [
  { activity_type: 'mention', message_id: g4.id, conversation_id: CHAT_GROUP, actor_id: USER2, emoji: null, body: g4.body, created_at: g4.created_at },
  { activity_type: 'reply', message_id: c1r2.id, conversation_id: CHAT_CHANNEL, actor_id: USER3, emoji: null, body: c1r2.body, created_at: c1r2.created_at },
  { activity_type: 'reaction', message_id: g1.id, conversation_id: CHAT_GROUP, actor_id: USER3, emoji: '👍', body: g1.body, created_at: g1.created_at },
];
export const chatPublicChannels = [
  { id: uid('h'), title: 'Klantenservice', description: 'Vragen van klanten die even moeten landen', member_count: 2, last_message_at: at(-2, 11, 0), created_at: iso(day(-20)) },
];

// ── Klantmail ──────────────────────────────────────────────────────────────
// Drie gesprekken (één met een ongelezen antwoord) en twee niet-gekoppelde
// berichten in de opvangbak, zodat de pagina Berichten op elk formaat echt
// iets te tonen heeft: gesprekkenlijst, gesprek en het tabblad Niet gekoppeld.
// Dezelfde rijen voeden het tabblad Communicatie in het klantdossier.
const mailThread = (ci, subject, lastDir, lastAt) => ({ id: uid('r'), ...base(), client_id: clients[ci].id, subject, last_direction: lastDir, last_message_at: lastAt, updated_at: lastAt });
export const clientEmailThreads = [
  mailThread(0, 'Re: offerte huisstijl', 'inbound', at(0, 9, 12)),
  mailThread(1, 'Planning fotoshoot', 'outbound', at(-1, 16, 40)),
  mailThread(4, 'Menukaart: laatste versie', 'inbound', at(-3, 11, 5)),
];
const mail = (thread, direction, from_name, from_email, to_email, body_text, created_at) => ({
  id: uid('e'), ...base(), thread_id: thread.id, client_id: thread.client_id, direction, provider: direction === 'inbound' ? 'inbound' : 'resend', provider_email_id: null,
  from_email, from_name, to_email, subject: thread.subject, body_html: null, body_text,
  status: direction === 'inbound' ? 'received' : 'delivered', sent_at: direction === 'outbound' ? created_at : null, delivered_at: direction === 'outbound' ? created_at : null,
  opened_at: null, clicked_at: null, bounced_at: null, failed_at: null, complained_at: null, received_at: direction === 'inbound' ? created_at : null, last_event_at: created_at,
  error_message: null, link_source: direction === 'inbound' ? 'reply_token' : null, link_confidence: null, rfc_message_id: null, metadata: {}, created_at, updated_at: created_at,
});
export const clientEmails = [
  mail(clientEmailThreads[0], 'outbound', 'Studio Lopik', 'info@studiolopik.nl', clients[0].email, 'Beste Joost, hierbij de offerte voor de nieuwe huisstijl. Laat je weten wat je ervan vindt?', at(-2, 10, 0)),
  mail(clientEmailThreads[0], 'inbound', 'Joost Vermeer', clients[0].email, 'info@studiolopik.nl', 'Dank voor de offerte, we gaan akkoord. Wanneer kunnen we starten?', at(0, 9, 12)),
  mail(clientEmailThreads[1], 'outbound', 'Studio Lopik', 'info@studiolopik.nl', clients[1].email, 'Zullen we de fotoshoot donderdag om 9 uur doen?', at(-1, 16, 40)),
  mail(clientEmailThreads[2], 'inbound', 'Karim El Amrani', clients[4].email, 'info@studiolopik.nl', 'Hierbij de laatste versie van de menukaart, met de nieuwe prijzen.', at(-3, 11, 5)),
];
// Gelezen: alles behalve het antwoord van Joost van vanochtend.
export const clientEmailReads = [
  { organization_id: ORG, client_id: clients[4].id, client_email_id: clientEmails[3].id, user_id: USER, read_at: at(-3, 12, 0) },
];
const readIds = new Set(clientEmailReads.map(r => r.client_email_id));
export const clientEmailUnread = clientEmails
  .filter(m => m.direction === 'inbound' && !readIds.has(m.id))
  .map(m => ({ id: m.id, organization_id: ORG, client_id: m.client_id, thread_id: m.thread_id, subject: m.subject, from_email: m.from_email, from_name: m.from_name, received_at: m.received_at, created_at: m.created_at }));
// De view client_email_thread_overview, nagebouwd uit de rijen hierboven.
export const clientEmailThreadOverview = clientEmailThreads.map(t => {
  const msgs = clientEmails.filter(m => m.thread_id === t.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const last = msgs[0];
  const client = clients.find(c => c.id === t.client_id);
  return {
    ...t, client_name: client.name, client_email: client.email, message_count: msgs.length,
    unread_count: msgs.filter(m => m.direction === 'inbound' && !readIds.has(m.id)).length, has_delivery_problem: false,
    last_email_id: last.id, last_email_direction: last.direction, last_from_name: last.from_name, last_from_email: last.from_email,
    last_status: last.status, last_email_at: last.created_at, last_preview: last.body_text.slice(0, 200),
  };
});
// Instellingen → E-mail → Eigen verzenddomein: één geverifieerd domein met
// afzender, en één dat nog wacht, met de lange DKIM-waarde en een status per
// record. Die waarde moet op een telefoon binnen de kaart blijven.
export const sendingDomains = [
  { id: uid('d'), ...base(), domain: 'studiolopik.nl', provider: 'resend', resend_domain_id: 'b9c1d2e3-0000-4000-8000-000000000001', region: 'eu-west-1', from_email: 'info@studiolopik.nl', from_name: 'Studio Lopik', status: 'verified', dns_records: [], is_default: true, last_checked_at: iso(day(-2)), verified_at: iso(day(-20)) },
  { id: uid('d'), ...base(), domain: 'nieuwsbrief-studiolopik.nl', provider: 'resend', resend_domain_id: 'b9c1d2e3-0000-4000-8000-000000000002', region: 'eu-west-1', from_email: 'nieuws@nieuwsbrief-studiolopik.nl', from_name: null, status: 'pending', is_default: false, last_checked_at: iso(day(0)), verified_at: null, dns_records: [
    { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8bxM4dWpRJl0/yOUAqu3pXut87WdZObaU1BiIEJOYzILHjL+7vbR7zxeIoFczeZapJ7vfTBiBvXstLcmIL7XZorU4CZnlLAj4df63gbqTo6VIXUtqhxV3eQp0fX+CSMXAwZsHaw0k/vBYIfxLjaVD5xZPNbynctBFRqZrd/fP7QIDAQAB' },
    { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'pending', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
    { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'failed', value: 'v=spf1 include:amazonses.com ~all' },
  ] },
];
export const inboundAlias = { id: uid('a'), ...base(), local_part: 'studio-lopik-abcdefghijklmnop', label: 'Doorstuuradres', forward_from_email: 'info@studiolopik.nl', status: 'active', retires_at: null, blocked_senders: [], last_received_at: at(0, 8, 2), received_total: 14, rate_window_started_at: null, rate_window_count: 0, pending_confirmation_code: null, pending_confirmation_at: null };
const inbound = (sender_name, sender_email, subject, body_text, received_at, reason, candidates = [], suggested = null) => ({
  id: uid('u'), ...base(), alias_id: inboundAlias.id, origin_client_email_id: null, route: 'alias', dedup_key: uid('k'), recipient: `${inboundAlias.local_part}@inbound.resofly.com`,
  envelope_from: sender_email, header_from: sender_email, sender_email, sender_name, sender_source: 'header_from', sender_confidence: 'high', sender_candidates: [sender_email],
  forwarding_evidence: 'x-forwarded-for', subject, body_text, body_html: null, rfc_message_id: `<${uid('i')}@example.test>`, in_reply_to: null, reference_ids: [], headers: {},
  attachment_names: [], raw_hash: null, raw_size: 2048, truncated: false, received_at, status: 'unmatched', reason, category: 'human', candidates, suggested_client_id: suggested,
  linked_client_id: null, linked_thread_id: null, client_email_id: null, duplicate_of_client_email_id: null, link_source: null, link_confidence: null, handled_by: null, handled_at: null,
  purge_after: iso(day(80)), created_at: received_at, updated_at: received_at,
});
export const inboundMessages = [
  inbound('Sanne Bakker', 'sanne@dekorenaar.nl', 'Foto\'s voor de website', 'Hoi, hierbij de foto\'s van de nieuwe winkel. Kunnen die op de site?', at(0, 8, 2), 'no_match', [{ client_id: clients[0].id, label: clients[0].name, matched_on: 'domain' }], clients[0].id),
  inbound('Peter de Vries', 'peter@nieuwbedrijf.nl', 'Offerte aanvragen', 'Goedemiddag, wij zoeken een bureau voor een nieuwe huisstijl. Kunnen jullie een offerte maken?', at(-1, 14, 30), 'no_match'),
];

// ── Leveranciers ───────────────────────────────────────────────────────────
// Twee crediteuren: één met een volledig ingevulde kaart, één waar bijna alles
// leeg is. Zo meet de test zowel de volle regel als de "—"-variant.
export const suppliers = [
  { id: uid('s'), ...base(), name: 'Drukkerij Van Wijk', supplier_code: 'L-001', contact_name: 'Bert van Wijk', email: 'bert@drukkerijvanwijk.nl', phone: '030-1234567', vat_number: 'NL812345678B01', iban: 'NL91ABNA0417164300', address_line1: 'Industrieweg 12', postal_code: '3401 MC', city: 'IJsselstein', country: 'NL', default_ledger_account_id: null, notes: null },
  { id: uid('s'), ...base(), name: 'Amazon.nl', supplier_code: null, contact_name: null, email: null, phone: null, vat_number: null, iban: 'NL35INGB0654321098', address_line1: null, postal_code: null, city: null, country: 'NL', default_ledger_account_id: null, notes: null },
];

// ── Campagnes ──────────────────────────────────────────────────────────────
// Eén verzonden campagne met cijfers en één concept zonder. Zo meet de test
// zowel de kaart mét resultaatchips als de variant waar die regel wegvalt.
const CAMPAIGN_SENT = uid('k');
const CAMPAIGN_DRAFT = uid('k');
export const emailCampaigns = [
  { id: CAMPAIGN_SENT, ...base(), name: 'Winteractie Van Dijk', subject: 'Klaar voor de winter? Plan je onderhoudsbeurt', preheader: 'Nog tot 1 december', body_html: '<p>Beste klant,</p>', body_text: null, accent_color: null, audience: { kind: 'all' }, status: 'sent', scheduled_at: null, started_at: iso(day(-6)), sent_at: iso(day(-6)) },
  { id: CAMPAIGN_DRAFT, ...base(), name: 'Nieuwsbrief december', subject: '', preheader: null, body_html: '', body_text: null, accent_color: null, audience: { kind: 'all' }, status: 'draft', scheduled_at: null, started_at: null, sent_at: null },
];
export const emailCampaignStats = [
  { organization_id: ORG, campaign_id: CAMPAIGN_SENT, total: 120, sent: 120, delivered: 118, opened: 42, clicked: 11, replied: 3, bounced: 2, failed: 0, unsubscribed: 1, pending: 0 },
];

// Het logboek (Instellingen → Logboek en het blok op het dashboard): een
// dag of drie aan regels, van factuur versturen tot een reeks taakwijzigingen.
const audit = (minutesAgo, action, entity_type, entity, label, actor, extra = {}) => {
  const created = new Date(NOW.getTime() - minutesAgo * 60000);
  return {
    id: uid('u'), organization_id: ORG, actor_user_id: actor, actor_label: actor === USER ? 'gerjan@studiolopik.nl' : actor === USER2 ? 'sanne@studiolopik.nl' : actor === USER3 ? 'daan.bakker@studiolopik.nl' : null,
    via: actor ? 'app' : 'systeem', action, entity_type, entity_id: entity?.id ?? null, entity_label: label,
    client_id: entity?.client_id ?? null, project_id: entity?.project_id ?? null, event_count: 1,
    created_at: iso(created), last_at: iso(created), metadata: {}, ...extra,
  };
};
export const auditLogs = [
  audit(4, 'invoice_sent_to_client', 'invoice', invoices[0], invoices[0].number, USER2),
  audit(18, 'updated', 'task', tasks[0], tasks[0].title, USER, { event_count: 4, last_at: iso(new Date(NOW.getTime() - 6 * 60000)),
    metadata: { changes: { status: { old: 'todo', new: 'doing' }, description: { changed: true }, planned_date: { old: null, new: dkey(day(1)) } } } }),
  audit(42, 'updated', 'document', { ...documents[0], client_id: documents[0].client_id ?? null, project_id: documents[0].project_id ?? null }, documents[0].title, USER3,
    { metadata: { online: true, changes: { last_edited_at: { changed: true }, size_bytes: { old: 18233, new: 19410 } } } }),
  audit(65, 'updated', 'task', tasks[1], tasks[1].title, USER, { via: 'koppeling', metadata: { changes: { priority: { old: 'med', new: 'high' } } } }),
  audit(120, 'invoice_paid', 'invoice', invoices[2], invoices[2].number, null),
  audit(60 * 26, 'quote_client_accepted', 'quote', quotes[2], quotes[2].number, null),
  audit(60 * 27, 'created', 'client', { id: clients[1].id, client_id: clients[1].id }, clients[1].name, USER2,
    { metadata: { changes: { name: { old: null, new: clients[1].name }, status: { old: null, new: 'prospect' } } } }),
  audit(60 * 28, 'role_changed', 'member', { id: members[2].id }, 'daan.bakker@studiolopik.nl', USER, { metadata: { changes: { role: { old: 'viewer', new: 'member' } } } }),
  audit(60 * 50, 'updated', 'client', { id: clients[0].id, client_id: clients[0].id }, clients[0].name, USER2,
    { metadata: { changes: { email: { changed: true }, status: { old: 'prospect', new: 'active' } } } }),
  audit(60 * 51, 'created', 'attachment', { id: attachments[0].id }, 'moodboard-winter-2026-definitief-versie-3-met-opmerkingen.pdf', USER3),
];

export const ids = { ORG, USER, USER2 };
// Rapportages met Gerrie (2026-11-09): één rapportage met inhoud, zoals Gerrie
// hem oplevert (HTML met de RF-bouwstenen en twee datasets), plus een kort
// gesprek en drie versies. Het kader zelf (public/rapport-weergave.html) draait
// in de test gewoon mee; alleen de gegevens komen van de nep-backend.
const aiReportHtml = `<div class="rf-page">
  <header class="rf-head"><h1>Omzet per maand</h1><p>Verstuurde en betaalde facturen, excl. btw, naast vorig jaar.</p></header>
  <div id="kpis"></div>
  <div class="rf-grid rf-grid-2">
    <section class="rf-card rf-span-2"><div class="rf-card-head"><h3>Per maand</h3><span class="rf-card-sub">Dit jaar tegen vorig jaar</span></div><div id="trend"></div></section>
    <section class="rf-card"><div class="rf-card-head"><h3>Top klanten</h3></div><div id="klanten"></div></section>
    <section class="rf-card"><div class="rf-card-head"><h3>Details</h3></div><div id="tabel"></div></section>
  </div>
</div>
<script>
const nu = RF.rows('omzet_nu');
const totaal = RF.totals('omzet_nu').omzet;
RF.kpis('#kpis', [{ label: 'Omzet dit jaar', value: totaal, format: 'euro', delta: RF.change(totaal, RF.totals('omzet_toen').omzet), deltaLabel: 'tegen vorig jaar' }, { label: 'Facturen', value: RF.totals('omzet_nu').aantal, format: 'num' }]);
RF.line('#trend', { labels: nu.map(m => m.date_month_label), series: [{ name: 'Dit jaar', values: nu.map(m => m.omzet) }, { name: 'Vorig jaar', values: RF.rows('omzet_toen').map(m => m.omzet) }], format: 'euro0', area: true });
RF.bar('#klanten', { data: RF.rows('klanten').map(r => ({ label: r.client_name, value: r.omzet })), format: 'euro0' });
RF.table('#tabel', { rows: RF.rows('klanten'), limit: 4, total: true, columns: [{ key: 'client_name', label: 'Klant' }, { key: 'omzet', label: 'Omzet', format: 'euro' }] });
</script>`;
const aiReportDatasets = [
  { key: 'omzet_nu', label: 'Omzet per maand', tool: 'query_records', input: { source: 'invoices', from: '{{begin_jaar}}', to: '{{eind_jaar}}', group_by: [{ field: 'date', period: 'month' }], measures: [{ agg: 'sum', field: 'subtotal_eur', as: 'omzet' }, { agg: 'count', as: 'aantal' }] } },
  { key: 'omzet_toen', label: 'Omzet vorig jaar', tool: 'query_records', input: { source: 'invoices', from: '{{begin_vorig_jaar}}', to: '{{eind_vorig_jaar}}', group_by: [{ field: 'date', period: 'month' }], measures: [{ agg: 'sum', field: 'subtotal_eur', as: 'omzet' }] } },
  { key: 'klanten', label: 'Omzet per klant', tool: 'query_records', input: { source: 'invoices', from: '{{begin_jaar}}', to: '{{eind_jaar}}', group_by: ['client_name'], measures: [{ agg: 'sum', field: 'subtotal_eur', as: 'omzet' }] } },
];
export const aiReports = [{
  id: uid('r'), ...base(), title: 'Omzet per maand, naast vorig jaar', summary: 'Omzet per maand dit jaar tegen vorig jaar, met de grootste klanten.',
  html: aiReportHtml, datasets: aiReportDatasets, version: 3, last_request: 'Zet er de grootste klanten bij', created_at: iso(day(-6)), updated_at: iso(day(-1)),
}];
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const year = NOW.getFullYear();
const nuMaanden = MONTHS.slice(0, NOW.getMonth() + 1).map((m, i) => ({ date_month: `${year}-${String(i + 1).padStart(2, '0')}`, date_month_label: `${m} ${year}`, omzet: 14000 + ((i * 3779) % 9000), aantal: 4 + (i % 5) }));
const toenMaanden = MONTHS.map((m, i) => ({ date_month: `${year - 1}-${String(i + 1).padStart(2, '0')}`, date_month_label: `${m} ${year - 1}`, omzet: 12000 + ((i * 2531) % 8000) }));
const sumOf = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
export const aiReportData = {
  reportId: aiReports[0].id, version: 3, fetchedAt: iso(NOW), today: dkey(NOW),
  datasets: [
    { key: 'omzet_nu', label: 'Omzet per maand', tool: 'query_records', ok: true, rows: nuMaanden.length, truncated: false, data: { source: 'invoices', groups: nuMaanden, totals: { omzet: sumOf(nuMaanden, 'omzet'), aantal: sumOf(nuMaanden, 'aantal') } } },
    { key: 'omzet_toen', label: 'Omzet vorig jaar', tool: 'query_records', ok: true, rows: toenMaanden.length, truncated: false, data: { source: 'invoices', groups: toenMaanden, totals: { omzet: sumOf(toenMaanden, 'omzet') } } },
    { key: 'klanten', label: 'Omzet per klant', tool: 'query_records', ok: true, rows: 5, truncated: false, data: { source: 'invoices', groups: [
      { client_name: 'Bakkerij De Gouden Korst', omzet: 48210.5 }, { client_name: 'Jansen Installatietechniek B.V.', omzet: 39120 },
      { client_name: 'Studio Noord', omzet: 22800 }, { client_name: 'Gemeente Utrecht', omzet: 15400.25 }, { client_name: 'De Vries & Zn', omzet: 9800 },
    ] } },
  ],
};
export const aiReportMessages = [
  { id: uid('m'), report_id: aiReports[0].id, ...base(), role: 'user', content: 'Omzet per maand dit jaar, naast vorig jaar', version: null, usage_fraction: null, created_at: iso(day(-6)) },
  { id: uid('m'), report_id: aiReports[0].id, ...base(), role: 'assistant', content: 'Ik heb een pagina gemaakt met de omzet per maand en vorig jaar als vergelijking.', version: 1, usage_fraction: 0.0061, created_at: iso(day(-6)) },
  { id: uid('m'), report_id: aiReports[0].id, ...base(), role: 'user', content: 'Zet er de grootste klanten bij', version: null, usage_fraction: null, created_at: iso(day(-1)) },
  { id: uid('m'), report_id: aiReports[0].id, ...base(), role: 'assistant', content: 'De vijf grootste klanten staan er nu onder, als staafdiagram en als tabel.', version: 3, usage_fraction: 0.0028, created_at: iso(day(-1)) },
];
export const aiReportVersions = [1, 2, 3].map((version) => ({ id: uid('w'), report_id: aiReports[0].id, ...base(), version, title: aiReports[0].title, summary: aiReports[0].summary, html: aiReportHtml, datasets: aiReportDatasets, request: version === 1 ? 'Omzet per maand dit jaar, naast vorig jaar' : version === 2 ? 'Maak er een lijngrafiek van' : 'Zet er de grootste klanten bij', created_at: iso(day(-7 + version * 2)) }));

// Agents van Gerrie (2026-11-11): een gevulde galerij, zodat de test de pagina
// meet zoals een gebruiker hem ziet, niet alleen de lege startpunten. Eén agent
// draait op dit moment (een run op "running", 40 seconden oud, met de eerste
// stappen in het logboek): daar hoort de werkanimatie bij. Eén agent is van een
// collega (toezicht) en één is gearchiveerd. Geen openstaande voorstellen: die
// staan ook op het dashboard en zouden de meting daar verschuiven.
const agentBase = (extra) => ({
  ...base(), run_as_user_id: USER, visibility: 'private', copied_from: null, description: null, icon: null, hue: null,
  email_mode: 'compose', email_subject: null, email_body: null, max_emails_per_run: 5, model_kind: 'strong', minute: 0,
  end_hour: null, day_of_week: null, day_of_month: null, timezone: 'Europe/Amsterdam', trigger_events: [], max_event_runs_per_day: 24,
  max_proposals_per_run: 3, archived_at: null, next_run_at: iso(day(1)), last_run_at: iso(day(-1)), consecutive_failures: 0,
  delivery: { channels: ['inapp', 'push'], recipient_user_ids: [] }, lease_until: null, ...extra,
});
export const aiAgents = [
  agentBase({ id: uid('g'), name: 'Te late facturen', icon: 'receipt', status: 'active', mode: 'report', schedule_kind: 'weekly', day_of_week: 1, hour: 8,
    instruction: 'Geef een overzicht van alle openstaande facturen ouder dan 30 dagen: klantnaam, bedrag en aantal dagen te laat. Sluit af met het totaalbedrag.',
    enabled_tools: ['list_invoices', 'list_due_reminders', 'search_clients'] }),
  agentBase({ id: uid('g'), name: 'Ticketwacht', icon: 'lifebuoy', status: 'active', mode: 'report', schedule_kind: 'hourly', hour: 9, minute: 5, end_hour: 17, model_kind: 'cheap',
    instruction: 'Welke tickets zijn het afgelopen uur binnengekomen of hebben een nieuwe reactie van de klant die nog niet beantwoord is?',
    enabled_tools: ['list_tickets', 'search_clients'], delivery: { channels: ['inapp', 'push'], recipient_user_ids: [], quiet: true } }),
  agentBase({ id: uid('g'), name: 'Klantmail beantwoorden', icon: 'mail', status: 'active', mode: 'propose', schedule_kind: 'event', trigger_events: ['client_email.received'], next_run_at: null,
    instruction: 'Er is een mail van een klant binnengekomen. Zet een kort, vriendelijk antwoord klaar dat op de vraag ingaat.',
    enabled_tools: ['search_clients', 'list_invoices', 'list_tickets', 'propose_send_client_email'] }),
  agentBase({ id: uid('g'), name: 'Betalingsherinneringen', icon: 'bell', status: 'paused', mode: 'propose', schedule_kind: 'weekly', day_of_week: 1, hour: 9, next_run_at: null,
    instruction: 'Bekijk welke betalingsherinneringen vandaag aan de beurt zijn en zet ze klaar om te versturen.',
    enabled_tools: ['list_due_reminders', 'propose_send_reminders'] }),
  agentBase({ id: uid('g'), name: 'Omzet van de maand', icon: 'trending', status: 'draft', mode: 'report', schedule_kind: 'monthly', day_of_month: 1, hour: 8, next_run_at: null, last_run_at: null,
    instruction: 'Vat de omzet van de afgelopen maand samen: totaalomzet, grootste klanten en het totaal openstaande bedrag.',
    enabled_tools: ['get_financial_summary', 'list_invoices'] }),
  agentBase({ id: uid('g'), name: 'Urencheck op vrijdag', icon: 'clock', status: 'active', mode: 'report', schedule_kind: 'weekly', day_of_week: 5, hour: 15, minute: 30,
    created_by: USER2, run_as_user_id: USER2, instruction: 'Hoeveel uur heb ik deze week geschreven, per project?', enabled_tools: ['list_time_entries', 'list_projects'] }),
  agentBase({ id: uid('g'), name: 'Offertes die stilliggen', icon: 'rocket', status: 'archived', archived_at: iso(day(-12)), mode: 'report', schedule_kind: 'weekly', day_of_week: 4, hour: 8, next_run_at: null,
    instruction: 'Welke offertes staan al langer dan twee weken op verstuurd zonder reactie?', enabled_tools: ['list_quotes'] }),
];
const [agentInvoices, agentTickets] = aiAgents;
const runAt = (offsetSec) => iso(new Date(NOW.getTime() + offsetSec * 1000));
export const aiAgentRuns = [
  // Ticketwacht draait nu.
  { id: uid('u'), organization_id: ORG, agent_id: agentTickets.id, conversation_id: null, triggered_by: 'schedule', status: 'running', scheduled_for: runAt(-45), started_at: runAt(-40), finished_at: null, summary: null, cost_usd: 0, proposals_created: 0, error: null, result: null, created_at: runAt(-40) },
  { id: uid('u'), organization_id: ORG, agent_id: agentTickets.id, conversation_id: null, triggered_by: 'schedule', status: 'succeeded', scheduled_for: runAt(-3600), started_at: runAt(-3600), finished_at: runAt(-3570), summary: 'Niets te melden.', cost_usd: 0.002, proposals_created: 0, error: null, result: { quiet: true }, created_at: runAt(-3600) },
  { id: uid('u'), organization_id: ORG, agent_id: agentInvoices.id, conversation_id: null, triggered_by: 'schedule', status: 'succeeded', scheduled_for: iso(day(-1)), started_at: iso(day(-1)), finished_at: iso(day(-1)), summary: 'Vier facturen staan langer dan 30 dagen open, samen € 7.420,50. De oudste is van Studio Noord (52 dagen).', cost_usd: 0.011, proposals_created: 0, error: null, result: {}, created_at: iso(day(-1)) },
  { id: uid('u'), organization_id: ORG, agent_id: agentInvoices.id, conversation_id: null, triggered_by: 'manual', status: 'failed', scheduled_for: null, started_at: iso(day(-8)), finished_at: iso(day(-8)), summary: null, cost_usd: 0.001, proposals_created: 0, error: 'Claude was even niet bereikbaar.', result: null, created_at: iso(day(-8)) },
];
const runningRun = aiAgentRuns[0];
export const aiAgentRunEvents = [
  { id: uid('e'), organization_id: ORG, agent_id: agentTickets.id, run_id: runningRun.id, seq: 0, kind: 'start', label: 'Gestart volgens schema', detail: { mode: 'report', tools: ['list_tickets', 'search_clients'] }, created_at: runAt(-40) },
  { id: uid('e'), organization_id: ORG, agent_id: agentTickets.id, run_id: runningRun.id, seq: 1, kind: 'tool', label: 'Tickets bekijken — 6 gevonden', detail: { tool: 'list_tickets', ok: true, found: 6 }, created_at: runAt(-30) },
];

export const tables = {
  ai_agents: aiAgents, ai_agent_runs: aiAgentRuns, ai_agent_run_events: aiAgentRunEvents,
  clients, client_contacts: [
    { id: uid('o'), ...base(), client_id: clients[0].id, name: 'Joost Vermeer', email: 'joost@dekorenaar.nl', phone: '06-11223344', role: 'Eigenaar', gives_portal_access: true, is_active: true },
    { id: uid('o'), ...base(), client_id: clients[0].id, name: 'Anja Vermeer', email: 'anja@dekorenaar.nl', phone: null, role: 'Marketing', gives_portal_access: false, is_active: true },
  ],
  client_calls: [
    {
      id: uid('q'), ...base(), client_id: clients[0].id, contact_id: null, supplier_id: null,
      project_id: null, ticket_id: null, counterpart_name: 'Joost Vermeer',
      phone_raw: '06-11223344', phone_e164: '+31611223344',
      direction: 'outbound', outcome: 'answered',
      started_at: iso(day(-1)), ended_at: iso(day(-1)), duration_seconds: 252,
      subject: 'Offerte doorgenomen', notes: 'Wil de levering een week opschuiven; nieuwe offerte volgt.',
      source: 'manual', provider: null, provider_call_id: null, dedup_key: null,
      follow_up_task_id: null, metadata: {},
    },
    {
      id: uid('q'), ...base(), client_id: null, contact_id: null, supplier_id: null,
      project_id: null, ticket_id: null, counterpart_name: null,
      phone_raw: '+31201234567', phone_e164: '+31201234567',
      direction: 'inbound', outcome: 'missed',
      started_at: iso(day(0)), ended_at: null, duration_seconds: 0,
      subject: '', notes: null,
      source: 'manual', provider: null, provider_call_id: null, dedup_key: null,
      follow_up_task_id: null, metadata: {},
    },
  ],
  client_field_definitions: [], projects, tasks, tickets, ticket_notes: [
    { id: uid('z'), ...base(), ticket_id: tickets[0].id, author_type: 'client', author_user_id: null, author_name: 'Maria Jansen', body: 'Vooral op de pagina met afspraken duurt het lang.', is_internal: false },
    { id: uid('z'), ...base(), ticket_id: tickets[0].id, author_type: 'user', author_user_id: USER, author_name: 'Gerjan', body: 'We kijken naar de afbeeldingen, die zijn te groot.', is_internal: true },
  ],
  notes, documents, content_folders: folders, folders, note_calendar_links: [], calendar_event_links: [], time_entries: timeEntries, quotes, quote_approval_events: [], quote_email_deliveries: [], quote_versions: [], invoices, invoice_workflow_events: [], invoice_email_deliveries: [], invoice_payment_records: [], invoice_versions: [], invoice_refunds: [], credit_notes: [], invoice_chargebacks: [], dunning_notices: [], ledger_accounts: [], vat_codes: [], journal_entries: [], journal_lines: [], closed_periods: [], fiscal_years: [], suppliers, purchase_invoices: [], fixed_assets: [], asset_depreciations: [], vat_returns: [], bank_accounts: [], bank_statements: [], bank_transactions: [], bank_rules: [], bank_requisitions: [], attachments, drive_shares: [], galleries: [], saved_reports: [], ai_reports: aiReports, ai_report_messages: aiReportMessages, ai_report_versions: aiReportVersions, planner_notes: plannerNotes, planner_day_capacity: [], company_settings: [companySettings], chat_conversations: chatConversations, chat_participants: chatParticipants, chat_messages: chatMessages, chat_message_reactions: chatReactions, chat_conversation_prefs: chatPrefs, chat_member_status: chatStatuses, chat_saved_messages: [], project_members: projectMembers, task_assignees: taskAssignees, project_templates: [], project_template_tasks: [], contract_projects: [], email_campaigns: emailCampaigns, email_campaign_stats: emailCampaignStats, email_campaign_recipients: [], email_flows: [], email_suppressions: [], organization_invitations: [], audit_logs: auditLogs, contracts: [],
  client_email_threads: clientEmailThreads, client_emails: clientEmails, client_email_reads: clientEmailReads, client_email_unread: clientEmailUnread, client_email_thread_overview: clientEmailThreadOverview,
  inbound_messages: inboundMessages, organization_inbound_aliases: [inboundAlias], organization_email_domains: sendingDomains,
  // Het eerste ticket heeft een klantreactie die nog niet gelezen is (view
  // ticket_unread): zo meet de test de "Nieuw"-markering in Berichten en op
  // het tabblad Tickets van het klantdossier.
  ticket_unread: [{ id: tickets[0].id, organization_id: ORG, client_id: tickets[0].client_id, title: tickets[0].title }],
};
