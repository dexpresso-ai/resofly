// Antwoorden voor de publieke klantpagina's en het klantportaal.
import * as seed from './seed.mjs';
const iso = (d) => d.toISOString();
const day = (o, h = 10) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + o, h, 0); };
const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const company = { company_name: 'Studio Lopik B.V.', trade_name: 'Studio Lopik', email: 'info@studiolopik.nl', phone: '0348-123456', website: 'https://studiolopik.nl', city: 'Lopik', country: 'NL', iban: 'NL12ABNA0123456789', vat_number: 'NL123456789B01', kvk_number: '12345678', invoice_accent_color: '#FFD966' };
const client = { name: seed.clients[0].name, contact_name: seed.clients[0].contact_name, email: seed.clients[0].email, phone: seed.clients[0].phone };
const project = { name: seed.projects[0].name, description: seed.projects[0].description, start_date: seed.projects[0].start_date, end_date: seed.projects[0].end_date };
const branding = { logoDataUrl: null, accentColor: '#FFD966', footerText: 'Studio Lopik · Kerkstraat 12, Lopik', hidePoweredBy: false, companyName: 'Studio Lopik', headingFont: null, bodyFont: null, galleryBg: '#0B0B0B', clientTheme: 'dark' };
// Het inlogscherm op het eigen adres van de leverancier (/portal/<sleutel>):
// eigen achtergrond, een witte kaart op een donker werkvlak en een eigen knop,
// zodat de kleurregel van het inlogscherm (loginTheme) ook hier meetelt.
export const PORTAL_LOGIN_KEY = 'studio-lopik-k7x2m6qp4r';
export const portalLoginBranding = { ok: true, branding: { ...branding, loginBackground: '#0F2A4A', loginCard: '#FFFFFF', loginButton: '#E4572E', loginPlain: false } };
const events = [
  { id: 'e1', event_type: 'sent_to_client', title: 'Verstuurd naar klant', description: 'Per e-mail aan joost@dekorenaar.nl', created_at: iso(day(-3)) },
  { id: 'e2', event_type: 'client_viewed', title: 'Bekeken door klant', description: null, created_at: iso(day(-2)) },
];
const q = seed.quotes[1];
export const quotePublic = { ok: true, quote: { id: q.id, number: q.number, date: q.date, valid_until: q.valid_until, lines: q.lines, status: 'sent', notes: 'Prijzen exclusief drukwerk; levering binnen drie weken na akkoord.', public_token_expires_at: iso(day(20)), accepted_at: null, client_decision_at: null, client_decision_by_name: null, client_decision_by_email: null, client_decision_note: null }, client, project, company, branding, events };
const inv = seed.invoices[0];
export const invoicePublic = { ok: true, invoice: { number: inv.number, date: inv.date, due_date: inv.due_date, lines: inv.lines, status: 'sent', notes: null, sent_at: inv.sent_at, paid_at: null, public_token_expires_at: iso(day(30)) }, client, project, quote: { id: q.id, number: '2026-019', status: 'accepted', date: q.date, total_amount: 6957.5 }, company, branding, events, payments: [], versions: [{ version_number: 1, snapshot_reason: 'sent_to_client', pdf_file_name: 'factuur-2026-041.pdf', created_at: iso(day(-3)) }] };
export const contractPublic = { ok: true, contract: { id: 'c1', number: 'C-2026-007', title: 'Onderhoudscontract website', body: '<h2>1. Opdracht</h2><p>Studio Lopik verzorgt het technisch onderhoud van de website van Fysio Centrum Zuid: updates, back-ups en beveiliging.</p><h2>2. Looptijd</h2><p>Dit contract gaat in op 1 oktober 2026 en loopt twaalf maanden, met stilzwijgende verlenging.</p><h2>3. Vergoeding</h2><p>€ 95,00 per maand exclusief btw, maandelijks vooraf gefactureerd.</p><h2>4. Opzegging</h2><p>Opzeggen kan schriftelijk met een opzegtermijn van één maand.</p>', content_kind: 'html', date: dkey(day(-2)), valid_until: dkey(day(28)), status: 'sent', signed_at: null, public_token_expires_at: iso(day(28)) }, client: { name: 'Fysio Centrum Zuid', contact_name: 'Maria Jansen', email: 'maria@fysio.nl' }, company, branding, signer: { name: 'Maria Jansen', email: 'maria@fysio.nl', status: 'pending', signed_at: null, signature_method: null }, events };
const slots = []; let sid = 0;
for (const d of [1, 2, 3, 4]) for (const h of [9, 10, 11, 14, 15]) { const s = day(d, h); const e = day(d, h); e.setMinutes(30); slots.push({ id: `s${++sid}`, starts_at: iso(s), ends_at: iso(e) }); }
// Sinds november 2026 een klantpagina in de huisstijl (stand, kop met
// bedrijfsnaam, contact) zoals meeting-booking-public hem teruggeeft.
export const bookingPublic = { ok: true, state: 'open', link: { title: 'Kennismakingsgesprek', intro_text: 'Kies een moment dat jou uitkomt; je krijgt direct een bevestiging met videolink.', max_total_bookings: 1, max_per_week: 1, expires_at: iso(day(60)), video: 'Videogesprek via Microsoft Teams', video_service: 'teams' }, slots, taken_slot_starts: [], booked: [], prefill: { name: 'Els de Boer', email: 'els@zonnetje.nl' }, branding, company: { name: company.trade_name, email: company.email, phone: company.phone, website: company.website } };
/** Het antwoord op bookSlots: de gekozen momenten staan vast, met een Teams-link. */
export function bookingBooked(slotIds) {
  const chosen = slots.filter(s => slotIds.includes(s.id));
  const url = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo';
  return { ok: true, confirmed: chosen.map(s => ({ slot_id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, meeting_url: url })), failed: [], meeting_url: chosen.length === 1 ? url : null, video_service: 'teams', invite_message: 'Fijn dat we elkaar spreken. Tot dan!', title: 'Kennismakingsgesprek' };
}
export const sharePublic = { ok: true, share: { itemType: 'folder', itemName: 'Concepten huisstijl', recipientName: 'Joost Vermeer', message: 'Hierbij de eerste concepten. Kijk vooral naar variant 2 — daar zijn we zelf het meest enthousiast over.', canDownload: true, expiresAt: iso(day(14)) }, items: [
  { itemType: 'attachment', itemId: 'a1', name: 'huisstijl-schets-v2.pdf', mimeType: 'application/pdf', sizeBytes: 1240000, modified: iso(day(-1)), path: 'Concepten', downloadable: true, readable: false },
  { itemType: 'attachment', itemId: 'a2', name: 'moodboard.jpg', mimeType: 'image/jpeg', sizeBytes: 2400000, modified: iso(day(-1)), path: 'Concepten', downloadable: true, readable: false },
  { itemType: 'note', itemId: 'n1', name: 'Toelichting bij de concepten', mimeType: null, sizeBytes: null, modified: iso(day(-1)), path: 'Concepten', downloadable: false, readable: true },
], company: { company_name: company.company_name, trade_name: company.trade_name }, branding };
const items = Array.from({ length: 8 }, (_, i) => ({ id: `g${i + 1}`, media_type: 'photo', file_name: `foto-${i + 1}.jpg`, content_type: 'image/jpeg', size_bytes: 6 * 1024 * 1024, category_id: i < 4 ? 'cat1' : 'cat2', storage_key: `gal/orig/${i + 1}.jpg`, preview_key: `gal/prev/${i + 1}.jpg`, thumb_key: `gal/thumb/${i + 1}.jpg`, width: i % 3 === 0 ? 1200 : 1800, height: i % 3 === 0 ? 1800 : 1200, duration_seconds: null, stream_uid: null, stream_status: null, stream_playback_base: null }));
// Eén video als master in R2 zonder kijkkopie bij Stream: de kaart met
// afspeelknop, en het downloadmenu met de keuze foto's/video's/alles.
items.push({ id: 'g9', media_type: 'video', file_name: 'aftermovie.mp4', content_type: 'video/mp4', size_bytes: 734003200, category_id: 'cat2', storage_key: 'gal/video/master-9-aftermovie.mp4', preview_key: null, thumb_key: 'gal/thumb/9.jpg', width: 1920, height: 1080, duration_seconds: 94, stream_uid: null, stream_status: null, stream_playback_base: null });
export const galleryPublic = { ok: true, gallery: { id: 'gal1', title: 'Fotoshoot Bloem · september', description: 'De selectie van de shoot in het restaurant.', format: 'photo', hero_template: 'classic', published_at: iso(day(-1)), allow_downloads: true, download_quality: 'web', cover_item_id: 'g2', cover_preview_key: null, cover_focus_x: 0.5, cover_focus_y: 0.4, expires_at: null }, items, categories: [{ id: 'cat1', name: 'Gerechten' }, { id: 'cat2', name: 'Sfeer' }], branding, tokens: { mediaToken: 'media-token', streamTokens: {}, exp: Math.floor(Date.now() / 1000) + 3600 }, myFavoriteIds: [], myLikeIds: [], likeCounts: {} };
const c0 = seed.clients[0];
const portalTickets = seed.tickets.filter(t => t.client_id === c0.id).map((t, i) => ({
  id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, created_at: t.created_at, updated_at: t.updated_at,
  last_activity_at: iso(day(0, 9)), reply_count: 2, last_reply_from: 'team', last_reply_author: null,
  last_reply_preview: 'De eerste schetsen staan klaar; welke variant spreekt je het meest aan?', unread: i === 0,
  // Behandelaar (2026-11-11): met naam, zonder naam (dan de leverancier) en niemand.
  assigned: i % 3 !== 2, assignee_name: i % 3 === 0 ? 'Sanne de Wit' : null,
}));
export const portalData = { ok: true, email: c0.email, accounts: [{
  id: 'acc1', organizationId: seed.ids.ORG, company, branding, client: { id: c0.id, name: c0.name, contact_name: c0.contact_name, email: c0.email, phone: c0.phone }, actingContact: { name: 'Joost Vermeer', email: c0.email },
  // De accountlead met zijn naam voor klanten (2026-11-11): de contactkaart.
  accountLead: { name: 'Gerjan van Lopik' },
  projects: seed.projects.filter(p => p.client_id === c0.id).map(p => ({ id: p.id, name: p.name, description: p.description, color: p.color, archived: false, start_date: p.start_date, end_date: p.end_date, created_at: p.created_at })),
  invoices: seed.invoices.filter(i => i.client_id === c0.id).map(i => ({ id: i.id, number: i.number, date: i.date, due_date: i.due_date, status: i.status, lines: i.lines, notes: null, sent_at: i.sent_at, paid_at: i.paid_at, project_id: i.project_id })),
  quotes: seed.quotes.filter(x => x.client_id === c0.id).map(x => ({ id: x.id, number: x.number, date: x.date, valid_until: x.valid_until, status: x.status, lines: x.lines, notes: null, sent_at: x.sent_at, accepted_at: x.accepted_at, project_id: x.project_id })),
  contracts: [{ id: 'c1', number: 'C-2026-003', title: 'Samenwerkingsovereenkomst huisstijl', status: 'signed', date: dkey(day(-40)), valid_until: null, signed_at: iso(day(-38)) }],
  // Eén ticket met een nieuw antwoord van de leverancier: de stip, de kaart
  // "Nieuw voor jou" en het accenttelletje op de tabs worden zo ook gemeten.
  tickets: portalTickets,
  galleries: [], sharedFileCount: 3,
  messages: { threads: 2, unread: 1 },
  // Afspraken via een boekingslink (2026-11-11): een komende met Teams, een die
  // niet doorgaat, en een die geweest is.
  appointments: [
    { id: 'ap0', title: 'Kennismakingsgesprek', starts_at: iso(day(-12, 10)), ends_at: iso(new Date(day(-12, 10).getTime() + 30 * 60000)), status: 'confirmed', video_service: 'jitsi', meeting_url: null, booked_by: 'Joost Vermeer' },
    { id: 'ap1', title: 'Bespreking drukproef herfstactie', starts_at: iso(day(2, 14)), ends_at: iso(new Date(day(2, 14).getTime() + 45 * 60000)), status: 'confirmed', video_service: 'teams', meeting_url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo', booked_by: 'Joost Vermeer' },
    { id: 'ap2', title: 'Opvolging offerte', starts_at: iso(day(5, 9)), ends_at: iso(new Date(day(5, 9).getTime() + 30 * 60000)), status: 'cancelled', video_service: 'google_meet', meeting_url: null, booked_by: 'Joost Vermeer' },
  ],
}] };

// Klantportaal: Berichten, het ticketgesprek en de meldingsinstellingen.
export const portalThreads = { ok: true, threads: [
  { id: 'th1', subject: 'Drukproef flyer herfstactie', messageCount: 3, lastMessageAt: iso(day(0, 9)), lastFrom: 'team', lastFromName: 'Gerjan van Lopik', lastPreview: 'De drukproef zit erbij. Kloppen de kleuren voor jullie?', unread: true },
  { id: 'th2', subject: 'Planning fotoshoot oktober', messageCount: 2, lastMessageAt: iso(day(-3, 14)), lastFrom: 'me', lastFromName: 'Joost Vermeer', lastPreview: 'Dinsdag de 14e past ons goed, vanaf tien uur.', unread: false },
] };
export const portalThread = { ok: true, thread: { id: 'th1', clientId: c0.id, subject: 'Drukproef flyer herfstactie' }, messages: [
  { id: 'm1', fromTeam: true, mine: false, authorName: 'Gerjan van Lopik', viaPortal: false, bodyHtml: '<p>Hoi Joost,</p><p>De drukproef zit erbij. Kloppen de kleuren voor jullie?</p>', bodyText: 'Hoi Joost, de drukproef zit erbij.', at: iso(day(-1, 10)) },
  { id: 'm2', fromTeam: false, mine: true, authorName: 'Joost Vermeer', viaPortal: true, bodyHtml: null, bodyText: 'Het oranje mag iets warmer.\n\nOp ma 5 okt 2026 om 10:00 schreef Gerjan van Lopik <gerjan@studiolopik.nl>:\n> De drukproef zit erbij.', at: iso(day(-1, 12)) },
  { id: 'm3', fromTeam: true, mine: false, authorName: 'Gerjan van Lopik', viaPortal: false, bodyHtml: '<p>Aangepast! Zie de nieuwe versie.</p>', bodyText: 'Aangepast!', at: iso(day(0, 9)) },
] };
const t0 = portalTickets[0];
export const portalTicketThread = { ok: true, ticket: t0, notes: [
  { id: 'n1', ticket_id: t0.id, author_type: 'client', author_name: 'Joost Vermeer', body: 'Graag twee varianten: één rustig, één opvallend.', created_at: iso(day(-2, 11)) },
  { id: 'n2', ticket_id: t0.id, author_type: 'user', author_name: null, body: 'De eerste schetsen staan klaar; welke variant spreekt je het meest aan?', created_at: iso(day(0, 9)) },
], events: [
  { id: 'e1', kind: 'status', old_status: 'new', new_status: 'review', created_at: iso(day(-1, 16)) },
] };
export const portalSettings = { ok: true, email: c0.email, isPrimary: true, otherPortalUsers: 1, orgEnabled: true,
  settings: { ticketCreated: true, ticketStatus: true, ticketReply: true, scope: 'all' },
  defaults: { ticketCreated: true, ticketStatus: true, ticketReply: true, scope: 'all' } };

// 2026-11-10 — een klant op inactief: geen tickets meer in het portaal
// (_shared/portalAccess.ts). Geen tab Tickets, Berichten op de plek van
// "Open tickets", en bij Instellingen alleen de uitleg.
export const portalDataInactive = { ...portalData, accounts: portalData.accounts.map(account => ({ ...account, ticketsOpen: false, tickets: [] })) };
export const portalSettingsInactive = { ...portalSettings, ticketsOpen: false };

// Het portaal mét logo (2026-11-12): een woordmerk zoals de meeste leveranciers
// er een hebben, donkere letters naast een gekleurd beeldmerk op transparant.
// Gemiddeld is het middelgrijs, maar op de donkere kop valt de naam weg; dan
// hoort het op een licht plaatje (logoPlate in src/lib/branding.ts). Zie
// portal-logo en portal-login-logo in run.mjs.
export const LOGO_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQkAAAA2CAMAAADj7ZyaAAAASFBMVEUXMiYeOiwdOSseOiwtilYsilYkjFMwjFlSn3RurovR5dqbx64AgIAMQAwA/wCz1cKDupsAAAAeOiwui1ceOiwcOSr9/v0dOSx6Wlq6AAAAGHRSTlMQ0UqQoVsO3P////8CBQH//wD9/rEu/2tC9UgGAAAE5klEQVR42u2a2XqrIBCAB4jGJF1OKpT3f9MDzAK4Rdv0LJ/ORVMThOFnNlC4H4ICB4KDxEHiIHGQ+B6JtmlOQZqm3TOJtjn1hZx2QgPGHPqRNC87JNGc+wk5N3sj8XbqZ+T0tisS7SyIgKLdEYn23C/Iud0NiSWL2IGDFCQegAgodkKi6R9KswsSL5NBorvcfl06CRVbe3c2is5f6PTFyhIfDN/qjNHLbf2WjpdJTJjE5faJcr11E0aBs0IxflIJ8B9BfIEmfeHW6aZCUwQQb8oDmGJco4FY1W2+TqIdc/gs5b0b5Q9t7EchBuZm48vxNpAQiummbBTeqHJg7N49i8TQJLrrZy2XqUgRR7e80gqeTMJKUzWYpUMCgJZgn0pikDg69ov394Tkdp5MH6KHr1ftOSTAc5wAY6p7nNiCZQDPItFOekYMD9dsEFHaaRJJD/NkEguRWEjIEjyLRDMB4j3awa0GMXCPHyMBDr5DApxb171zrwMSpzGIi3jJbba6EhJavMNhHFXGVSRSvPcFiRT6Hd6hQnMt2UgHZwg3SQamHOUmSZgJ7/ApoEpK1VaROkkJc9cKf3a29OkJEhgjMG9Gk7j2j0kY/icwCbMyMgSTCKMq7woSQR2bUm9sG5OBiYEhNXfpr2Rg5+3QkITEq9ickIDQWiUNkgLp0lBPuEiU6wzlHpglcc0g+uLfWRJaJ1XNK5EAMlpVkaDUkknQoul07dhSCEu6KXvWJAkTBlbjLOqxraVLkz49XqHpOkgQvANdlDtE4jzwjS7/f613pCMSnNWBq4xKL1IVeCZMQnPSjQ3wa8upIMzRrSCBori0ohHTAATES8carzQtUPbRHN7GJMrIEM3j1wMSynsMDaUny1A4G1A8EfqBTSRNQGFPijRLtuL1QxKWBzZlnODJ0qfHqer8obhDza454x1VZIhUzv2KOAGlK4PTuiIRvRlKEo6jCuqmsX29Rg9JYHhQVNMxCU8qUY+G/DebxloS5zJrdiPnmCOBM0wa5BJcSJQ2mH7IOwpfOBh8gcSdXZ1JcOym62JDoFaRaCZN4jZIofP1BKodRnbs5wUJ9ZFnAhK90T082USUr9iELMECCYvdu20krmWyuA0zxwIJm0c2gzihnKQSUhxkxqJb7mUbiTst94J35IpvBYm2yBzXfvJisdomm5AhhhGz3lZi1ky/OwoQXyYxtImJiGm3kMiBorsUIfLcLR/gjeME6TwggeEAiqRiy4LDfYPEME4AdVxk0bwdWUNixdnd/K6cq15X1g8VifRpCxIyF13t5zeTgGHuoFKqqqzMFhLtOhJttY3xVE/g0UmqJ7BExso/1DwpSxjgnRJFVE2aSnHzYY1VlsphS9sjuXdIArCat3FgrideMW8DssF6v0AV+/d0hCbrAJj8aYMC9y1GUZlEmQCV5RoTq3ncKhiqBS1Xo9bzMZPL501aUbEoPSox+2IJaxeScenckL4zd969SKFHl/GaGjnHjWkLUpNYfuxDYWPNk+JQV20+fwi3wKNzvC2dDjb1q1T6L0754bunMNued7z9o09+3CjV/vzTwAf+8ZcejAa38DMHYjt7QhyK5bmD8529NbDwMOXnSNxfTv/e6xPae/0n3hA83i6aI3F/Od44y9HieAuxgkGyn1dTj7eVDxIHiYPEQeIgsVV+A+3XqGD4tcI2AAAAAElFTkSuQmCC';
const withLogo = (b) => ({ ...b, logoDataUrl: LOGO_DATA_URL });
export const portalDataLogo = { ...portalData, accounts: portalData.accounts.map(account => ({ ...account, branding: withLogo(account.branding) })) };
export const portalLoginBrandingLogo = { ...portalLoginBranding, branding: withLogo(portalLoginBranding.branding) };

// Agenda → Boekingslinks en de kaart Afspraken op de klantpagina (november
// 2026): een open link met een geboekte afspraak en vrije momenten, en een
// verlopen link. Zo meet de test de standen, de knoppen en de rijen, niet
// alleen een lege lijst.
const atBooking = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return iso(d); };
const bookingLinkOpen = {
  id: 'b1000000-0000-4000-8000-000000000001', organization_id: seed.ids.ORG, user_id: seed.ids.USER, client_id: seed.clients[0].id, source_id: seed.calendarSource.id,
  title: 'Kennismakingsgesprek', intro_text: 'Kies een moment dat jou uitkomt.', invite_message: 'Fijn dat we elkaar spreken. Tot dan!', meeting_url: null,
  max_total_bookings: 2, max_per_week: 1, auto_conference: true, conference_provider: 'jitsi', status: 'active', has_token: true,
  public_token_expires_at: atBooking(9, 12), created_at: atBooking(-5, 9), updated_at: atBooking(-1, 9),
};
const bookingLinkExpired = {
  ...bookingLinkOpen, id: 'b1000000-0000-4000-8000-000000000002', title: 'Opvolging van de offerte voor de nieuwe huisstijl', max_total_bookings: 1,
  public_token_expires_at: atBooking(-3, 12), created_at: atBooking(-130, 9),
};
const bookingSlots = [
  { id: 'b2000000-0000-4000-8000-000000000001', booking_link_id: bookingLinkOpen.id, organization_id: seed.ids.ORG, starts_at: atBooking(2, 10), ends_at: atBooking(2, 10, 30), status: 'booked', pending_at: null, created_at: atBooking(-5, 9) },
  { id: 'b2000000-0000-4000-8000-000000000002', booking_link_id: bookingLinkOpen.id, organization_id: seed.ids.ORG, starts_at: atBooking(9, 10), ends_at: atBooking(9, 10, 30), status: 'open', pending_at: null, created_at: atBooking(-5, 9) },
  { id: 'b2000000-0000-4000-8000-000000000003', booking_link_id: bookingLinkOpen.id, organization_id: seed.ids.ORG, starts_at: atBooking(9, 14), ends_at: atBooking(9, 14, 30), status: 'open', pending_at: null, created_at: atBooking(-5, 9) },
  { id: 'b2000000-0000-4000-8000-000000000004', booking_link_id: bookingLinkOpen.id, organization_id: seed.ids.ORG, starts_at: atBooking(-2, 11), ends_at: atBooking(-2, 11, 30), status: 'open', pending_at: null, created_at: atBooking(-5, 9) },
];
const bookingRows = [
  { id: 'b3000000-0000-4000-8000-000000000001', booking_link_id: bookingLinkOpen.id, slot_id: bookingSlots[0].id, organization_id: seed.ids.ORG, client_id: seed.clients[0].id, booked_name: 'Els de Boer', booked_email: 'els@zonnetje.nl', native_event_id: null, external_event_id: null, external_provider: null, status: 'confirmed', created_at: atBooking(-1, 15), confirmed_at: atBooking(-1, 15), cancelled_at: null },
];
export const bookingAdminLinks = [
  { ...bookingLinkOpen, client_name: seed.clients[0].name, source_name: seed.calendarSource.name, source_provider: 'native', booking_count: 1, needs_reconnect: false, state: 'open', open_slot_count: 2, next_open_slot_at: bookingSlots[1].starts_at, owner_can_book: true,
    upcoming_bookings: [{ id: bookingRows[0].id, name: 'Els de Boer', email: 'els@zonnetje.nl', starts_at: bookingSlots[0].starts_at, ends_at: bookingSlots[0].ends_at }] },
  { ...bookingLinkExpired, client_name: seed.clients[0].name, source_name: seed.calendarSource.name, source_provider: 'native', booking_count: 0, needs_reconnect: false, state: 'expired', open_slot_count: 0, next_open_slot_at: null, owner_can_book: true, upcoming_bookings: [] },
];
export function bookingAdminDetail(linkId) {
  const expired = linkId === bookingLinkExpired.id;
  return {
    ok: true, link: expired ? bookingLinkExpired : bookingLinkOpen, slots: expired ? [] : bookingSlots, bookings: expired ? [] : bookingRows,
    source_name: seed.calendarSource.name, source_provider: 'native', needs_reconnect: false, owner_can_book: true,
    open_slot_count: expired ? 0 : 2, state: expired ? 'expired' : 'open',
  };
}

// Afmelden voor marketingmail (2026-11-10): een lange naam en een lang adres, de zwaarste stand voor de opmaak.
export const unsubscribeInfo = { brandName: 'Studio Lopik Creatieve Communicatie & Merkstrategie', email: 'joost.vermeer-van-den-berg@de-korenaar-bakkerijen.nl', unsubscribed: false };
