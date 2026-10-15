// Het voorbeeld van het klantportaal bij Instellingen → Huisstijl.
//
// De instellingenpagina zet het échte portaal in een iframe (/portal/voorbeeld)
// en stuurt het met postMessage de huisstijl die op dat moment in het formulier
// staat — ook als die nog niet is opgeslagen. Het portaal draait daar op een
// nagebootste backend met verzonnen gegevens (`demoPortalBackend`), zodat het
// voorbeeld nooit uit de pas loopt met het echte scherm en toch niets ophaalt,
// verstuurt of opslaat.
//
// Wat binnenkomt, wordt gekeurd alsof het van buiten komt: alleen hexkleuren,
// lettertypen uit de vaste lijst en ingesloten rasterlogo's
// (`sanitizeStoredBranding`), en tekst met een maximale lengte.

import { sanitizeStoredBranding, type BrandingPayload } from './branding';
import { addDays, formatISODate } from './dates';
import type { PortalAccount, PortalBackend, PortalInvoice, PortalMessage, PortalMessageThreadSummary, PortalTicket } from './portalApi';
import type { CompanySettingsInput } from '../types';

export const PORTAL_PREVIEW_PATH = '/portal/voorbeeld';
export const PORTAL_PREVIEW_MESSAGE = 'resofly:portal-preview';
export const PORTAL_PREVIEW_READY = 'resofly:portal-preview-ready';

export type PortalPreviewScreen = 'overview' | 'invoice' | 'login';

/** De gegevens van de leverancier die het portaal toont (contactkaart, betaalinfo). */
export type PortalPreviewCompany = {
  /** Merknaam, of anders de juridische naam. */
  name: string;
  legalName: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  iban: string | null;
};

export type PortalPreviewState = {
  branding: BrandingPayload;
  company: PortalPreviewCompany;
  screen: PortalPreviewScreen;
};

/** De voorbeeldleverancier als de pagina los wordt geopend (zonder instellingen). */
export function defaultPortalPreview(): PortalPreviewState {
  return {
    branding: sanitizeStoredBranding({ accentColor: '#FFD966', clientTheme: 'dark', companyName: 'Jouw bedrijf' })!,
    company: { name: 'Jouw bedrijf', legalName: 'Jouw bedrijf B.V.', email: 'info@jouwbedrijf.nl', phone: null, website: null, city: null, iban: null },
    screen: 'overview',
  };
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** Het bericht dat de instellingenpagina naar het voorbeeld stuurt. */
export function portalPreviewMessage(form: CompanySettingsInput, screen: PortalPreviewScreen) {
  const legalName = String(form.company_name ?? '').trim();
  const name = String(form.trade_name ?? '').trim() || legalName;
  const branding: BrandingPayload = {
    logoDataUrl: form.brand_logo_data_url ?? null,
    accentColor: form.brand_accent_color,
    footerText: form.brand_footer_text ?? null,
    hidePoweredBy: form.brand_hide_powered_by,
    companyName: name || null,
    headingFont: form.brand_heading_font,
    bodyFont: form.brand_body_font,
    clientTheme: form.brand_client_theme,
    headerColor: form.brand_header_color ?? null,
    logoDarkDataUrl: form.brand_logo_dark_data_url ?? null,
  };
  const company: PortalPreviewCompany = {
    name: name || 'Jouw bedrijf',
    legalName: legalName || name || 'Jouw bedrijf',
    email: form.email || null,
    phone: form.phone || null,
    website: form.website || null,
    city: form.city || null,
    iban: form.iban || null,
  };
  return { type: PORTAL_PREVIEW_MESSAGE, branding, company, screen };
}

/** Keurt een binnenkomend bericht; `null` als het er niet een van ons is. */
export function readPortalPreviewMessage(data: unknown): PortalPreviewState | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.type !== PORTAL_PREVIEW_MESSAGE) return null;
  const branding = sanitizeStoredBranding(message.branding);
  if (!branding) return null;
  const raw = (message.company && typeof message.company === 'object' ? message.company : {}) as Record<string, unknown>;
  const name = text(raw.name, 120) ?? branding.companyName ?? 'Jouw bedrijf';
  const company: PortalPreviewCompany = {
    name,
    legalName: text(raw.legalName, 120) ?? name,
    email: text(raw.email, 160),
    phone: text(raw.phone, 40),
    website: text(raw.website, 160),
    city: text(raw.city, 80),
    iban: text(raw.iban, 40),
  };
  const screen: PortalPreviewScreen = message.screen === 'invoice' || message.screen === 'login' ? message.screen : 'overview';
  return { branding, company, screen };
}

// ── De verzonnen klant ──────────────────────────────────────────────────────

const CLIENT = { id: 'voorbeeld-klant', name: 'Bakkerij De Korenaar', contact_name: 'Joost Vermeer', email: 'joost@dekorenaar.nl', phone: '0348-555 123' };

/** Een tijdstip vandaag (of `days` dagen ervandaan) op een vast uur. */
function at(today: Date, days: number, hour: number): string {
  const moment = addDays(today, days);
  moment.setHours(hour, 0, 0, 0);
  return moment.toISOString();
}

function demoInvoices(today: Date): PortalInvoice[] {
  const day = (n: number) => formatISODate(addDays(today, n));
  return [
    {
      id: 'voorbeeld-factuur-041', number: `${today.getFullYear()}-041`, date: day(-12), due_date: day(18), status: 'sent',
      lines: [
        { id: 'r1', description: 'Ontwerp flyer herfstactie', quantity: 12, unit_price: 85, vat: 21 },
        { id: 'r2', description: 'Drukwerk flyers, 2.500 stuks', quantity: 1, unit_price: 780, vat: 21 },
        { id: 'r3', description: 'Huisstijlhandboek', quantity: 1, unit_price: 600, vat: 21 },
      ],
      notes: null, sent_at: at(today, -12, 10), paid_at: null, project_id: 'voorbeeld-project',
    },
    {
      id: 'voorbeeld-factuur-033', number: `${today.getFullYear()}-033`, date: day(-46), due_date: day(-16), status: 'paid',
      lines: [{ id: 'r4', description: 'Logo-ontwerp', quantity: 1, unit_price: 1250, vat: 21 }],
      notes: null, sent_at: at(today, -46, 10), paid_at: at(today, -20, 9), project_id: 'voorbeeld-project',
    },
  ];
}

function demoTickets(today: Date, supplier: string): PortalTicket[] {
  return [
    {
      id: 'voorbeeld-ticket-1', title: 'Nieuwe flyer voor de herfstactie',
      description: 'Kunnen jullie een flyer maken voor de herfstactie? Formaat A5, oplage 2.500.',
      status: 'review', priority: 'medium', created_at: at(today, -5, 9), updated_at: at(today, 0, 11),
      last_activity_at: at(today, 0, 11), reply_count: 2, last_reply_from: 'team', last_reply_author: supplier,
      last_reply_preview: 'De eerste schetsen staan klaar; welke variant spreekt je het meest aan?', unread: true,
    },
    {
      id: 'voorbeeld-ticket-2', title: 'Openingstijden op de website aanpassen',
      description: 'Vanaf november zijn we op maandag gesloten.',
      status: 'approved', priority: 'low', created_at: at(today, -21, 14), updated_at: at(today, -19, 10),
      last_activity_at: at(today, -19, 10), reply_count: 1, last_reply_from: 'team', last_reply_author: supplier,
      last_reply_preview: 'Staat erop!', unread: false,
    },
  ];
}

export function demoPortalAccount(state: PortalPreviewState, today = new Date()): PortalAccount {
  const day = (n: number) => formatISODate(addDays(today, n));
  const { company } = state;
  return {
    id: 'voorbeeld',
    organizationId: 'voorbeeld',
    company: {
      company_name: company.legalName, trade_name: company.name, email: company.email, phone: company.phone,
      website: company.website, city: company.city, country: 'Nederland', iban: company.iban, vat_number: null, kvk_number: null,
    },
    branding: state.branding,
    client: CLIENT,
    actingContact: null,
    projects: [{
      id: 'voorbeeld-project', name: 'Nieuwe huisstijl De Korenaar', description: 'Logo, huisstijlhandboek en drukwerk',
      color: '#4F9D69', archived: false, start_date: day(-40), end_date: day(30), created_at: at(today, -40, 9),
    }],
    invoices: demoInvoices(today),
    quotes: [{
      id: 'voorbeeld-offerte-019', number: `${today.getFullYear()}-019`, date: day(-44), valid_until: day(-14), status: 'accepted',
      lines: [{ id: 'r5', description: 'Nieuwe huisstijl: logo, huisstijlhandboek en drukwerk', quantity: 1, unit_price: 5750, vat: 21 }],
      notes: null, sent_at: at(today, -44, 10), accepted_at: at(today, -41, 16), project_id: 'voorbeeld-project',
    }],
    contracts: [{
      id: 'voorbeeld-contract', number: `C-${today.getFullYear()}-003`, title: 'Samenwerkingsovereenkomst huisstijl',
      status: 'signed', date: day(-40), valid_until: null, signed_at: at(today, -38, 11),
    }],
    tickets: demoTickets(today, company.name),
    galleries: [],
    sharedFileCount: 0,
    transferCount: 0,
    messages: { threads: 2, unread: 1 },
  };
}

function demoThreads(today: Date, supplier: string): PortalMessageThreadSummary[] {
  return [
    {
      id: 'voorbeeld-gesprek-1', subject: 'Drukproef flyer herfstactie', messageCount: 3, lastMessageAt: at(today, 0, 9),
      lastFrom: 'team', lastFromName: supplier, lastPreview: 'Aangepast! Kijk je nog even naar de nieuwe versie?', unread: true,
    },
    {
      id: 'voorbeeld-gesprek-2', subject: 'Planning fotoshoot nieuwe broodlijn', messageCount: 2, lastMessageAt: at(today, -3, 14),
      lastFrom: 'me', lastFromName: CLIENT.contact_name, lastPreview: 'Dinsdag de 14e past ons goed, vanaf tien uur.', unread: false,
    },
  ];
}

function demoMessages(today: Date, supplier: string): PortalMessage[] {
  return [
    {
      id: 'm1', fromTeam: true, mine: false, authorName: supplier, viaPortal: false,
      bodyHtml: '<p>Hoi Joost,</p><p>De drukproef zit erbij. Kloppen de kleuren voor jullie?</p>',
      bodyText: 'Hoi Joost, de drukproef zit erbij. Kloppen de kleuren voor jullie?', at: at(today, -1, 10),
    },
    { id: 'm2', fromTeam: false, mine: true, authorName: CLIENT.contact_name, viaPortal: true, bodyHtml: null, bodyText: 'Mooi! Het oranje mag iets warmer.', at: at(today, -1, 12) },
    {
      id: 'm3', fromTeam: true, mine: false, authorName: supplier, viaPortal: false,
      bodyHtml: '<p>Aangepast! Kijk je nog even naar de nieuwe versie?</p>', bodyText: 'Aangepast! Kijk je nog even naar de nieuwe versie?', at: at(today, 0, 9),
    },
  ];
}

const NOTHING_HAPPENS = 'Dit is een voorbeeld: hier wordt niets verstuurd, betaald of gedownload.';

/**
 * Beantwoordt de aanroepen van het portaal met de verzonnen gegevens hierboven.
 * Alles wat iets zou veranderen of versturen, zegt dat het een voorbeeld is.
 */
export function demoPortalBackend(current: () => PortalPreviewState): PortalBackend {
  return async (name, body) => {
    const state = current();
    const today = new Date();
    const supplier = state.company.name;
    const ok = (data: Record<string, unknown>) => ({ data: { ok: true, ...data }, error: null });
    if (name !== 'client-portal') return { data: { ok: false, error: NOTHING_HAPPENS }, error: null };
    const account = demoPortalAccount(state, today);
    switch (body.action) {
      case 'getPortalData':
        return ok({ email: CLIENT.email, accounts: [account] });
      case 'getInvoicePaymentInfo': {
        const invoice = account.invoices.find(i => i.id === body.invoiceId) ?? account.invoices[0];
        const total = invoice.lines.reduce((sum, line) => sum + line.quantity * line.unit_price * (1 + line.vat / 100), 0);
        return ok({
          payment: {
            invoiceId: invoice.id, number: invoice.number, status: invoice.status,
            isPaid: invoice.status === 'paid', payable: invoice.status !== 'paid',
            amountCents: Math.round(total * 100), currency: 'EUR', mollieAvailable: true,
            iban: state.company.iban ?? 'NL00 BANK 0123 4567 89', companyName: state.company.legalName,
          },
        });
      }
      case 'getTicketThread': {
        const ticket = account.tickets.find(t => t.id === body.ticketId) ?? account.tickets[0];
        return ok({
          ticket,
          notes: [
            { id: 'n1', ticket_id: ticket.id, author_type: 'client', author_name: CLIENT.contact_name, body: ticket.description ?? '', created_at: ticket.created_at },
            { id: 'n2', ticket_id: ticket.id, author_type: 'user', author_name: supplier, body: ticket.last_reply_preview ?? '', created_at: ticket.last_activity_at ?? ticket.updated_at },
          ],
          events: [{ id: 'e1', kind: 'status', old_status: 'new', new_status: ticket.status, created_at: at(today, -4, 10) }],
        });
      }
      case 'getMessageThreads':
        return ok({ threads: demoThreads(today, supplier) });
      case 'getMessageThread': {
        const thread = demoThreads(today, supplier).find(t => t.id === body.threadId) ?? demoThreads(today, supplier)[0];
        return ok({ thread: { id: thread.id, clientId: CLIENT.id, subject: thread.subject }, messages: demoMessages(today, supplier) });
      }
      case 'getNotificationSettings': {
        const settings = { ticketCreated: true, ticketStatus: true, ticketReply: true, scope: 'all' };
        return ok({ email: CLIENT.email, isPrimary: true, otherPortalUsers: 1, orgEnabled: true, settings, defaults: settings });
      }
      case 'getProjectDetail':
        return ok({
          project: account.projects[0],
          tasks: [
            { id: 'k1', title: 'Moodboard en schetsen', status: 'done', start_date: null, end_date: null, planned_date: formatISODate(addDays(today, -30)) },
            { id: 'k2', title: 'Logo uitwerken', status: 'done', start_date: null, end_date: null, planned_date: formatISODate(addDays(today, -18)) },
            { id: 'k3', title: 'Huisstijlhandboek', status: 'doing', start_date: null, end_date: null, planned_date: formatISODate(addDays(today, 4)) },
            { id: 'k4', title: 'Drukwerk aanleveren', status: 'todo', start_date: null, end_date: null, planned_date: formatISODate(addDays(today, 16)) },
          ],
        });
      case 'getSharedFiles':
        return ok({ shares: [] });
      case 'getTransfers':
        return ok({ transfers: [] });
      default:
        return { data: { ok: false, error: NOTHING_HAPPENS }, error: null };
    }
  };
}
