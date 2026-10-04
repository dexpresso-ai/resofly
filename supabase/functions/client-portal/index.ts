import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { BRANDING_COLUMNS, sanitizeBranding } from '../_shared/branding.ts';
import { createPortalInvoiceCheckout, calculateTotalCents, orgHasInvoiceMollie } from '../_shared/invoiceCheckout.ts';
import {
  defaultPortalPrefs,
  normalizeEmail,
  portalPeople,
  portalPrefsFor,
  type PortalNotifyPrefs,
  type PortalPerson,
  type PortalSettingsRow,
} from '../_shared/portalNotify.ts';
import {
  htmlToPlainText,
  isUnreadSince,
  portalThreadsFor,
  previewText,
  replySubject,
  type PortalMessageRow,
  type PortalThreadSummary,
} from '../_shared/portalMessages.ts';

// ============================================================
// ResoFly — Klantportaal (client portal) edge function
//
// Geauthenticeerd eindpunt voor het klantportaal op /portal. De ingelogde klant
// (magische e-maillink via Supabase Auth) krijgt inzage in zijn eigen facturen,
// offertes, tickets en projecten en kan support-tickets aanmaken.
//
// Beveiliging:
// - Authenticatie: Bearer-JWT van de portaalsessie wordt geverifieerd
//   (supabaseAdmin.auth.getUser). De function draait ook met verify_jwt = true.
// - Autorisatie: de toegestane klantdossiers worden UITSLUITEND afgeleid uit het
//   geverifieerde e-mailadres (RPC portal_clients_for_email, service-role only).
//   Een client_id uit de request wordt altijd opnieuw tegen die set gevalideerd.
// - Saneren: alleen klantveilige velden gaan terug (geen interne notities,
//   geen interne offerte-goedkeuringsvelden, geen andere klanten).
// ============================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

// Falt terug op de gedeelde invoice/quote-opslagconfig zodat één Worker + secret
// de factuur-PDF-download voedt (parity met invoice-public).
const INVOICE_PDF_STORAGE_WORKER_URL = (
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const INVOICE_PDF_STORAGE_SECRET =
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  '';

// Galerij-weergave: de media-api worker munt kijk-/downloadtokens voor het
// portaal via /internal/gallery/tokens (zelfde secret-keten als meeting-transcribe).
const MEDIA_WORKER_URL = (Deno.env.get('MEDIA_WORKER_URL') || '').replace(/\/$/, '');
const MEDIA_INTERNAL_SECRET =
  Deno.env.get('INTERNAL_UPLOAD_SECRET') ||
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  '';

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Vanaf dit moment houdt het portaal bij wat een klant al gezien heeft
// (portal_reads). Van wat daarvóór gebeurde weten we dat niet; dat telt dus
// niet als "nieuw", anders staat bij de invoering elk oud ticket op ongelezen.
const PORTAL_READS_SINCE = '2026-10-04T00:00:00Z';

// Een klant die berichten stuurt, laat bij het team een melding afgaan. Meer
// dan dit per tien minuten is geen gesprek meer. Een ticket of een reactie
// erop gaat bovendien (in de huisstijl van de leverancier) per mail naar de
// andere portaalgebruikers van de klant; daar geldt dus ook een rem.
const MESSAGE_RATE_LIMIT = 20;
const TICKET_RATE_LIMIT = 10;
const TICKET_NOTE_RATE_LIMIT = 30;
const MESSAGE_RATE_WINDOW_MINUTES = 10;

class PortalError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type ClientRow = {
  id: string;
  organization_id: string;
  name: string;
  client_code: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
};

type ActingContact = { id: string; name: string; email: string };

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'getPortalData');

    switch (action) {
      case 'getPortalData':
        return json(req, { ok: true, ...(await getPortalData(user)) });
      case 'createTicket':
        return json(req, { ok: true, ...(await createTicket(user, body)) });
      case 'getTicketThread':
        return json(req, { ok: true, ...(await getTicketThread(user, body)) });
      case 'addTicketNote':
        return json(req, { ok: true, ...(await addTicketNote(user, body)) });
      case 'getProjectDetail':
        return json(req, { ok: true, ...(await getProjectDetail(user, body)) });
      case 'decideQuote':
        return json(req, { ok: true, ...(await decideQuote(user, body)) });
      case 'getInvoicePaymentInfo':
        return json(req, { ok: true, ...(await getInvoicePaymentInfo(user, body)) });
      case 'createInvoicePayment':
        return json(req, { ok: true, ...(await createInvoicePayment(user, body, req)) });
      case 'getInvoicePdf':
        return json(req, { ok: true, ...(await getInvoicePdf(user, body)) });
      case 'getContractPdf':
        return json(req, { ok: true, ...(await getContractPdf(user, body)) });
      case 'getSharedFiles':
        return json(req, { ok: true, ...(await getSharedFiles(user, body)) });
      case 'downloadSharedFile':
        return json(req, { ok: true, ...(await downloadSharedFile(user, body)) });
      case 'getGalleryDetail':
        return json(req, { ok: true, ...(await getGalleryDetail(user, body)) });
      case 'toggleGalleryFavorite':
        return json(req, { ok: true, ...(await toggleGalleryFavorite(user, body)) });
      case 'getNotificationSettings':
        return json(req, { ok: true, ...(await getNotificationSettings(user, body)) });
      case 'updateNotificationSettings':
        return json(req, { ok: true, ...(await updateNotificationSettings(user, body)) });
      case 'getMessageThreads':
        return json(req, { ok: true, ...(await getMessageThreads(user, body)) });
      case 'getMessageThread':
        return json(req, { ok: true, ...(await getMessageThread(user, body)) });
      case 'sendMessage':
        return json(req, { ok: true, ...(await sendMessage(user, body)) });
      default:
        throw new PortalError(`Onbekende actie: ${action}`, 400);
    }
  } catch (error) {
    const status = error instanceof PortalError ? error.status : 500;
    const message = error instanceof PortalError
      ? error.message
      : `Klantportaal kon de aanvraag niet verwerken: ${describeError(error)}`.slice(0, 500);
    if (status >= 500) {
      console.error('client-portal error', describeError(error), error instanceof Error ? error.stack : undefined);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ────────────────────────────────────────────────────────────

async function getPortalData(user: { id: string; email: string }) {
  const clients = await resolveAccountsForEmail(user.email);
  // Eén keer ophalen en per klant tellen: het aantal met jou gedeelde bestanden
  // voedt alleen het tabblad-badgetje, de inhoud komt pas als je erop klikt.
  const shares = await loadSharesForUser(user.email);
  const accounts = [];
  for (const client of clients) {
    const sharedFileCount = shares.filter((share) => share.client_id === client.id).length;
    accounts.push({ ...(await buildAccount(client, user.email)), sharedFileCount });
  }
  return { email: user.email, accounts };
}

async function createTicket(user: { id: string; email: string }, body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim();
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const priority = normalizePriority(body.priority);

  if (!isUuid(clientId)) throw new PortalError('Ongeldige klant.', 400);
  if (!title) throw new PortalError('Geef een korte titel voor je ticket op.', 400);
  if (title.length > 200) throw new PortalError('De titel mag maximaal 200 tekens zijn.', 400);
  if (description.length > 5000) throw new PortalError('De omschrijving mag maximaal 5000 tekens zijn.', 400);

  // Het client_id NOOIT blind vertrouwen: opnieuw afleiden uit het geverifieerde
  // e-mailadres en controleren dat de klant in die set zit.
  const clients = await resolveAccountsForEmail(user.email);
  const client = clients.find((row) => row.id === clientId);
  if (!client) throw new PortalError('Geen toegang tot deze klant.', 403);

  const contact = await resolveActingContact(client, user.email);
  await assertPortalWriteRate('tickets', client.organization_id, user.id, TICKET_RATE_LIMIT, 'tickets aangemaakt');

  const { data, error } = await supabaseAdmin
    .from('tickets')
    .insert({
      organization_id: client.organization_id,
      client_id: client.id,
      title,
      description: description || null,
      priority,
      status: 'new',
      created_by: user.id,
      created_by_contact_id: contact?.id ?? null,
      created_by_name: contact?.name || client.contact_name || client.name || user.email,
      created_by_email: contact?.email || user.email,
    })
    .select('*')
    .single();

  if (error) throw error;
  return { ticket: sanitizeTicket(data) };
}

/**
 * Haalt één ticket op met zijn klantzichtbare tijdlijn. Interne notities
 * (is_internal = true) worden hier NOOIT teruggegeven: ze verlaten de server niet.
 */
async function getTicketThread(user: { id: string; email: string }, body: Record<string, unknown>) {
  const ticketId = String(body.ticketId || '').trim();
  if (!isUuid(ticketId)) throw new PortalError('Ongeldig ticket.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: ticket, error } = await supabaseAdmin
    .from('tickets')
    .select('id,organization_id,client_id,title,description,status,priority,created_at,updated_at,converted_to_project_id')
    .eq('id', ticketId)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) throw new PortalError('Ticket niet gevonden.', 404);
  await assertEntityBelongsToClients({ client_id: ticket.client_id, project_id: null, organization_id: ticket.organization_id }, clients);

  const { data: notes, error: notesError } = await supabaseAdmin
    .from('ticket_notes')
    .select('id,ticket_id,author_type,author_name,body,created_at')
    .eq('organization_id', ticket.organization_id)
    .eq('ticket_id', ticket.id)
    .eq('is_internal', false)
    .order('created_at', { ascending: true });
  if (notesError) throw notesError;

  // Statuswijzigingen als regels in het gesprek ("Status: In behandeling").
  // Alleen van de huidige klant: hing het ticket eerder aan een ander dossier,
  // dan is die geschiedenis niet van deze klant.
  // Optioneel: zonder de migratie van 2026-10-04 blijft de tijdlijn zoals hij was.
  const statusRows = ticket.client_id
    ? await optionalRows(supabaseAdmin
      .from('portal_ticket_activity')
      .select('id,old_status,new_status,created_at')
      .eq('organization_id', ticket.organization_id)
      .eq('ticket_id', ticket.id)
      .eq('client_id', ticket.client_id)
      .eq('kind', 'status')
      .order('created_at', { ascending: true }), 'portal_ticket_activity')
    : [];

  // Openen = lezen: de stip "nieuw antwoord" gaat weg.
  if (ticket.client_id) await markPortalRead(user.email, ticket.client_id, ticket.organization_id, 'ticket', ticket.id);

  return {
    ticket: sanitizeTicket(ticket),
    notes: (notes || []).map(sanitizeTicketNote),
    events: statusRows.map((row) => ({
      id: row.id,
      kind: 'status',
      old_status: row.old_status ?? null,
      new_status: row.new_status ?? null,
      created_at: row.created_at,
    })),
  };
}

/**
 * Laat de ingelogde klant een notitie aan de tickettijdlijn toevoegen. Altijd
 * zichtbaar (is_internal = false) en gemarkeerd als afkomstig van de klant.
 */
async function addTicketNote(user: { id: string; email: string }, body: Record<string, unknown>) {
  const ticketId = String(body.ticketId || '').trim();
  const noteBody = String(body.body || '').trim();
  if (!isUuid(ticketId)) throw new PortalError('Ongeldig ticket.', 400);
  if (!noteBody) throw new PortalError('Een notitie mag niet leeg zijn.', 400);
  if (noteBody.length > 5000) throw new PortalError('De notitie mag maximaal 5000 tekens zijn.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  const { data: ticket, error } = await supabaseAdmin
    .from('tickets')
    .select('id,organization_id,client_id')
    .eq('id', ticketId)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) throw new PortalError('Ticket niet gevonden.', 404);
  await assertEntityBelongsToClients({ client_id: ticket.client_id, project_id: null, organization_id: ticket.organization_id }, clients);

  // NOOIT terugvallen op clients[0]: dat kan een ander, ongerelateerd klantdossier
  // zijn (bv. als dezelfde contactpersoon ook actief is bij een andere klant) en
  // zou diens naam ten onrechte aan déze klant se ticket koppelen.
  const client = clients.find((row) => row.id === ticket.client_id) || null;
  const contact = client ? await resolveActingContact(client, user.email) : null;
  const authorName = contact?.name || client?.contact_name || client?.name || user.email;
  await assertPortalWriteRate('ticket_notes', ticket.organization_id, user.id, TICKET_NOTE_RATE_LIMIT, 'reacties geplaatst');

  const { data, error: insertError } = await supabaseAdmin
    .from('ticket_notes')
    .insert({
      organization_id: ticket.organization_id,
      ticket_id: ticket.id,
      created_by: user.id,
      author_type: 'client',
      author_user_id: null,
      author_client_contact_id: contact?.id ?? null,
      author_name: authorName,
      body: noteBody,
      is_internal: false,
    })
    .select('id,ticket_id,author_type,author_name,body,created_at')
    .single();
  if (insertError) throw insertError;

  if (ticket.client_id) await markPortalRead(user.email, ticket.client_id, ticket.organization_id, 'ticket', ticket.id);

  return { note: sanitizeTicketNote(data) };
}

/**
 * Een rem op stortvloeden vanuit één portaallogin (created_by = de
 * portaalgebruiker): elk ticket en elke reactie laat bij het team een melding
 * afgaan en gaat per mail naar de andere portaalgebruikers van de klant.
 */
async function assertPortalWriteRate(
  table: 'tickets' | 'ticket_notes',
  organizationId: string,
  userId: string,
  limit: number,
  what: string,
): Promise<void> {
  const since = new Date(Date.now() - MESSAGE_RATE_WINDOW_MINUTES * 60_000).toISOString();
  let query = supabaseAdmin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('created_by', userId)
    .gte('created_at', since);
  if (table === 'ticket_notes') query = query.eq('author_type', 'client');
  const { count, error } = await query;
  if (error) throw error;
  if ((count ?? 0) >= limit) {
    throw new PortalError(`Je hebt de afgelopen ${MESSAGE_RATE_WINDOW_MINUTES} minuten al veel ${what}. Probeer het zo nog eens.`, 429);
  }
}

/**
 * Geeft een project met zijn live taakstatussen terug zodat de klant "live kan
 * meekijken". Alleen klantveilige taakvelden (titel, status, planning) gaan mee —
 * geen interne omschrijvingen, schattingen, tags of comments.
 */
async function getProjectDetail(user: { id: string; email: string }, body: Record<string, unknown>) {
  const projectId = String(body.projectId || '').trim();
  if (!isUuid(projectId)) throw new PortalError('Ongeldig project.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw error;
  if (!project) throw new PortalError('Project niet gevonden.', 404);

  const clientIds = new Set(clients.map((c) => c.id));
  if (!project.client_id || !clientIds.has(project.client_id)) throw new PortalError('Geen toegang tot dit project.', 403);

  const { data: tasks, error: tasksError } = await supabaseAdmin
    .from('tasks')
    .select('id,title,status,start_date,end_date,planned_date,created_at,updated_at')
    .eq('organization_id', project.organization_id)
    .eq('project_id', project.id)
    .order('created_at', { ascending: true });
  if (tasksError) throw tasksError;

  return { project: sanitizeProject(project), tasks: (tasks || []).map(sanitizeTask) };
}

/**
 * Laat de ingelogde klant een naar hem verstuurde offerte in het portaal zelf
 * accepteren of weigeren. De identiteit komt uit de geverifieerde sessie (naam uit
 * het klantdossier, e-mail uit de login) — de klant hoeft niets opnieuw in te
 * vullen. De state-overgang + events/audit lopen via decide_quote_portal, dat exact
 * de publieke accept/reject-RPC's spiegelt.
 */
async function decideQuote(user: { id: string; email: string }, body: Record<string, unknown>) {
  const quoteId = String(body.quoteId || '').trim();
  const kind = String(body.kind || '').trim().toLowerCase();
  const note = String(body.note || '').trim();
  if (!isUuid(quoteId)) throw new PortalError('Ongeldige offerte.', 400);
  if (kind !== 'accept' && kind !== 'reject') throw new PortalError('Ongeldige beslissing.', 400);
  if (note.length > 2000) throw new PortalError('De opmerking mag maximaal 2000 tekens zijn.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: quote, error } = await supabaseAdmin
    .from('quotes')
    .select('id,organization_id,client_id,project_id,status,sent_at')
    .eq('id', quoteId)
    .maybeSingle();
  if (error) throw error;
  if (!quote || !quote.sent_at) throw new PortalError('Offerte niet gevonden.', 404);
  await assertEntityBelongsToClients(quote, clients);
  if (quote.status !== 'sent') throw new PortalError('Deze offerte is al beoordeeld en kan niet meer worden gewijzigd.', 409);

  // NOOIT terugvallen op clients[0]: assertEntityBelongsToClients hierboven kan
  // deze offerte ook via het GEKOPPELDE PROJECT autoriseren (quote.client_id zelf
  // hoeft dan niet in `clients` te zitten). Zonder deze || null-guard zou de
  // contactnaam van een ander, ongerelateerd klantdossier (bv. dezelfde persoon
  // is ook actief contact bij een andere klant) permanent in de beslissingshistorie
  // van déze offerte terechtkomen.
  const client = clients.find((row) => row.id === quote.client_id) || null;
  const contact = client ? await resolveActingContact(client, user.email) : null;
  const name = contact?.name || client?.contact_name || client?.name || user.email;

  const { data, error: rpcError } = await supabaseAdmin.rpc('decide_quote_portal', {
    p_quote_id: quote.id,
    p_organization_id: quote.organization_id,
    p_kind: kind,
    p_name: name,
    p_email: user.email,
    p_note: note || null,
    p_contact_id: contact?.id ?? null,
  });
  if (rpcError) {
    if (/kan niet meer|niet gevonden|verlopen|beslist/i.test(rpcError.message)) throw new PortalError(rpcError.message, 409);
    throw rpcError;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { quote: sanitizeQuote(row as Record<string, unknown>) };
}

/**
 * Betaalinfo voor één factuur: bedrag (server-side berekend), of hij betaalbaar is,
 * of online betalen via Mollie beschikbaar is, en de overschrijvingsgegevens (IBAN).
 * Voedt de betaalknop/-fallback in het portaal.
 */
async function getInvoicePaymentInfo(user: { id: string; email: string }, body: Record<string, unknown>) {
  const invoiceId = String(body.invoiceId || '').trim();
  if (!isUuid(invoiceId)) throw new PortalError('Ongeldige factuur.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: invoice, error } = await supabaseAdmin
    .from('invoices')
    .select('id,organization_id,client_id,project_id,number,status,lines,paid_at')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  if (!invoice || invoice.status === 'draft') throw new PortalError('Factuur niet gevonden.', 404);
  await assertEntityBelongsToClients(invoice, clients);

  const amountCents = calculateTotalCents(Array.isArray(invoice.lines) ? invoice.lines : []);
  const isPaid = invoice.status === 'paid' || Boolean(invoice.paid_at);
  const payable = !isPaid && !['cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status);

  const [company, mollieAvailable] = await Promise.all([
    optionalCompany(invoice.organization_id),
    orgHasInvoiceMollie(supabaseAdmin, invoice.organization_id),
  ]);

  return {
    payment: {
      invoiceId: invoice.id,
      number: invoice.number,
      status: invoice.status,
      isPaid,
      payable,
      amountCents,
      currency: 'EUR',
      mollieAvailable: payable ? mollieAvailable : false,
      iban: (company?.iban as string | null) ?? null,
      companyName: (company?.trade_name as string | null) || (company?.company_name as string | null) || null,
    },
  };
}

/**
 * Maakt (of hergebruikt) een Mollie-betaallink voor een factuur die de klant
 * geverifieerd bezit en opent die daarna in het portaal. Eigendom wordt hier
 * opnieuw afgeleid uit het geverifieerde e-mailadres; daarna doet de gedeelde
 * checkout-helper de rest via dezelfde service-role betaal-RPC's.
 */
async function createInvoicePayment(user: { id: string; email: string }, body: Record<string, unknown>, req: Request) {
  const invoiceId = String(body.invoiceId || '').trim();
  if (!isUuid(invoiceId)) throw new PortalError('Ongeldige factuur.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: invoice, error } = await supabaseAdmin
    .from('invoices')
    .select('id,organization_id,client_id,project_id,status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  if (!invoice || invoice.status === 'draft') throw new PortalError('Factuur niet gevonden.', 404);
  await assertEntityBelongsToClients(invoice, clients);

  const invoiceClient = clients.find((row) => row.id === invoice.client_id) || null;
  const contact = invoiceClient ? await resolveActingContact(invoiceClient, user.email) : null;

  const result = await createPortalInvoiceCheckout(supabaseAdmin, {
    organizationId: invoice.organization_id,
    invoiceId: invoice.id,
    actorUserId: user.id,
    redirectUrl: `${resolvePortalBaseUrl(req)}/portal`,
    actorContact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
  });
  if (!result.ok) throw new PortalError(result.error, result.status as number);
  return { checkoutUrl: result.checkoutUrl, mock: result.mock, reused: result.reused };
}

/**
 * Basis-URL waar Mollie de klant na betalen naar terugstuurt. Bij voorkeur de
 * geconfigureerde publieke app-URL; anders de (al gevalideerde) request-origin.
 */
function resolvePortalBaseUrl(req: Request): string {
  const envBase = (Deno.env.get('APP_PUBLIC_URL') || Deno.env.get('INVOICE_PUBLIC_BASE_URL') || '').replace(/\/$/, '');
  if (envBase) return envBase;
  return (req.headers.get('origin') || '').replace(/\/$/, '');
}

async function getInvoicePdf(user: { id: string; email: string }, body: Record<string, unknown>) {
  const invoiceId = String(body.invoiceId || '').trim();
  if (!isUuid(invoiceId)) throw new PortalError('Ongeldige factuur.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: invoice, error } = await supabaseAdmin
    .from('invoices')
    .select('id,organization_id,client_id,project_id,number,status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  if (!invoice || invoice.status === 'draft') throw new PortalError('Factuur niet gevonden.', 404);

  await assertEntityBelongsToClients(invoice, clients);

  const { data: versions, error: versionError } = await supabaseAdmin
    .from('invoice_versions')
    .select('snapshot_reason,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_data_base64,pdf_storage_provider,pdf_storage_key,version_number')
    .eq('organization_id', invoice.organization_id)
    .eq('invoice_id', invoice.id)
    .not('pdf_file_name', 'is', null)
    .order('version_number', { ascending: false })
    .limit(20);
  if (versionError) throw versionError;

  const usable = (versions || []).filter((candidate: Record<string, unknown>) => {
    const hasDbPdf = Boolean(String(candidate.pdf_data_base64 || '').trim());
    const hasStoragePdf = candidate.pdf_storage_provider === 'r2' && Boolean(candidate.pdf_storage_key);
    return hasDbPdf || hasStoragePdf;
  });
  const version = usable.find((candidate: Record<string, unknown>) => candidate.snapshot_reason === 'sent_to_client') || usable[0];
  if (!version) throw new PortalError('Er is nog geen beschikbare PDF voor deze factuur.', 404);

  let base64 = String(version.pdf_data_base64 || '').trim();
  if (!base64 && version.pdf_storage_provider === 'r2' && version.pdf_storage_key) {
    if (!INVOICE_PDF_STORAGE_WORKER_URL || !INVOICE_PDF_STORAGE_SECRET) {
      throw new PortalError('PDF is opgeslagen in private storage, maar de storage-koppeling ontbreekt.', 500);
    }
    const response = await fetch(`${INVOICE_PDF_STORAGE_WORKER_URL}/internal/invoice-snapshot/${encodeURIComponent(String(version.pdf_storage_key))}`, {
      headers: { Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}` },
    });
    if (!response.ok) throw new PortalError('PDF kon niet uit private storage worden opgehaald.', 502);
    base64 = arrayBufferToBase64(await response.arrayBuffer());
  }
  if (!base64) throw new PortalError('PDF ontbreekt of is niet beschikbaar.', 404);

  return {
    pdf: {
      fileName: version.pdf_file_name || `factuur-${invoice.number}.pdf`,
      mimeType: version.pdf_mime_type || 'application/pdf',
      sizeBytes: version.pdf_size_bytes || null,
      sha256: version.pdf_sha256 || null,
      base64,
    },
  };
}

async function getContractPdf(user: { id: string; email: string }, body: Record<string, unknown>) {
  const contractId = String(body.contractId || '').trim();
  if (!isUuid(contractId)) throw new PortalError('Ongeldig contract.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: contract, error } = await supabaseAdmin
    .from('contracts')
    .select('id,organization_id,client_id,number,status,signed_pdf_data_base64,signed_storage_provider,signed_storage_key,signed_pdf_file_name')
    .eq('id', contractId)
    .maybeSingle();
  if (error) throw error;
  if (!contract || contract.status !== 'signed') throw new PortalError('Getekend contract niet gevonden.', 404);

  await assertEntityBelongsToClients({ client_id: contract.client_id, project_id: null, organization_id: contract.organization_id }, clients);

  let base64 = String(contract.signed_pdf_data_base64 || '').trim();
  if (!base64 && contract.signed_storage_provider === 'r2' && contract.signed_storage_key) {
    if (!INVOICE_PDF_STORAGE_WORKER_URL || !INVOICE_PDF_STORAGE_SECRET) {
      throw new PortalError('PDF is opgeslagen in private storage, maar de storage-koppeling ontbreekt.', 500);
    }
    const response = await fetch(`${INVOICE_PDF_STORAGE_WORKER_URL}/internal/contract-snapshot/${encodeURIComponent(String(contract.signed_storage_key))}`, {
      headers: { Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}` },
    });
    if (!response.ok) throw new PortalError('PDF kon niet uit private storage worden opgehaald.', 502);
    base64 = arrayBufferToBase64(await response.arrayBuffer());
  }
  if (!base64) throw new PortalError('PDF ontbreekt of is niet beschikbaar.', 404);

  return {
    pdf: {
      fileName: contract.signed_pdf_file_name || `contract-${contract.number}.pdf`,
      mimeType: 'application/pdf',
      base64,
    },
  };
}

// ── Gedeelde bestanden ────────────────────────────────────────────────
//
// Een medewerker deelt een map, bestand, notitie of document met een
// geregistreerde contactpersoon (drive_shares, recipient_kind = 'contact').
// Hier komt die deling terug bij de ingelogde contactpersoon zelf. De toegang
// wordt UITSLUITEND afgeleid uit het geverifieerde e-mailadres: de RPC
// portal_drive_shares_for_email geeft alleen lopende delingen terug van actieve,
// portaal-gemachtigde contactpersonen met precies dit adres.

type SharedShareRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  item_type: string;
  item_name: string | null;
  can_download: boolean;
  message: string | null;
  expires_at: string | null;
  created_at: string;
};

type SharedItemRow = {
  item_type: string;
  item_id: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_key: string | null;
  modified: string | null;
  path: string | null;
};

async function loadSharesForUser(email: string): Promise<SharedShareRow[]> {
  const { data, error } = await supabaseAdmin.rpc('portal_drive_shares_for_email', { p_email: email });
  if (error) {
    // Het portaal mag nooit omvallen op een module die nog niet is uitgerold.
    if (/does not exist|schema cache/i.test(`${error.message} ${error.details ?? ''}`)) {
      console.warn('client-portal drive_shares nog niet beschikbaar', error.message);
      return [];
    }
    throw error;
  }
  return (data || []) as SharedShareRow[];
}

async function loadShareItems(shareId: string): Promise<SharedItemRow[]> {
  const { data, error } = await supabaseAdmin.rpc('drive_share_items', { p_share_id: shareId });
  if (error) throw error;
  return ((data || []) as SharedItemRow[]).sort((a, b) =>
    (a.path || '').localeCompare(b.path || '', 'nl')
    || a.name.localeCompare(b.name, 'nl', { numeric: true }));
}

async function getSharedFiles(user: { id: string; email: string }, body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim();
  const shares = await loadSharesForUser(user.email);
  const scoped = isUuid(clientId) ? shares.filter((s) => s.client_id === clientId) : shares;

  const out = [];
  for (const share of scoped) {
    const items = await loadShareItems(share.id);
    out.push({
      id: share.id,
      clientId: share.client_id,
      itemType: share.item_type,
      itemName: share.item_name,
      message: share.message,
      canDownload: share.can_download === true,
      expiresAt: share.expires_at,
      sharedAt: share.created_at,
      items: items.map((item) => ({
        itemType: item.item_type,
        itemId: item.item_id,
        name: item.name,
        mimeType: item.mime_type,
        sizeBytes: item.size_bytes,
        modified: item.modified,
        path: item.path || null,
        downloadable: share.can_download === true && Boolean(item.storage_key),
        readable: item.item_type === 'note' || (item.item_type === 'document' && !item.storage_key),
      })),
    });
  }
  return { shares: out };
}

async function downloadSharedFile(user: { id: string; email: string }, body: Record<string, unknown>) {
  const shareId = String(body.shareId || '').trim();
  const itemId = String(body.itemId || '').trim();
  const itemType = String(body.itemType || '').trim();
  if (!isUuid(shareId) || !isUuid(itemId)) throw new PortalError('Ongeldig bestand.', 400);

  // Opnieuw afleiden uit het geverifieerde e-mailadres: een shareId uit de
  // request wordt nooit blind vertrouwd.
  const shares = await loadSharesForUser(user.email);
  const share = shares.find((candidate) => candidate.id === shareId);
  if (!share) throw new PortalError('Deze deling is niet (meer) met je gedeeld.', 403);

  const items = await loadShareItems(share.id);
  const item = items.find((candidate) => candidate.item_id === itemId && candidate.item_type === itemType);
  if (!item) throw new PortalError('Dit bestand hoort niet bij deze deling.', 403);

  // Bijhouden dat er gekeken is mag nooit de download zelf laten sneuvelen.
  // (De query-builder van supabase-js heeft geen .catch(); alleen await erop
  //  levert een promise, dus dit moet met try/catch.)
  try {
    await supabaseAdmin.rpc('touch_drive_share', { p_share_id: share.id });
  } catch (error) {
    console.warn('client-portal touch_drive_share overgeslagen', error instanceof Error ? error.message : error);
  }

  // Lezen is kijken, geen downloaden: een notitie of tekstdocument blijft dus ook
  // leesbaar als de afzender downloaden heeft uitgezet.
  if (item.item_type === 'note' || (!item.storage_key && item.item_type === 'document')) {
    const table = item.item_type === 'note' ? 'notes' : 'documents';
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('title,content')
      .eq('id', item.item_id)
      .eq('organization_id', share.organization_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new PortalError('Dit item bestaat niet meer.', 404);
    const row = data as { title: string; content: string | null };
    return { text: { title: row.title, html: row.content || '' } };
  }

  if (share.can_download !== true) throw new PortalError('De afzender heeft downloaden voor deze deling uitgezet.', 403);
  if (!item.storage_key) throw new PortalError('Voor dit item is geen bestand om te downloaden.', 404);
  if (!MEDIA_WORKER_URL || !MEDIA_INTERNAL_SECRET) {
    throw new PortalError('Het bestand staat in private opslag, maar de storage-koppeling ontbreekt.', 500);
  }

  // De sleutel komt uit een rij die een teamlid zelf schrijft: hij moet onder de
  // map van déze organisatie liggen, anders haalt de service-role andermans object op.
  if (!item.storage_key.startsWith(`${share.organization_id}/`) || item.storage_key.includes('..')) {
    throw new PortalError('Dit bestand hoort niet bij deze deling.', 403);
  }
  const response = await fetch(`${MEDIA_WORKER_URL}/internal/media/${encodeURIComponent(item.storage_key)}`, {
    headers: { Authorization: `Bearer ${MEDIA_INTERNAL_SECRET}`, 'x-organization-id': String(share.organization_id) },
  });
  if (!response.ok) {
    if (response.status === 404) throw new PortalError('Dit bestand is niet meer beschikbaar.', 404);
    throw new PortalError('Het bestand kon niet uit de opslag worden opgehaald.', 502);
  }

  return {
    file: {
      fileName: item.name,
      mimeType: item.mime_type || 'application/octet-stream',
      sizeBytes: item.size_bytes,
      base64: arrayBufferToBase64(await response.arrayBuffer()),
    },
  };
}

// ── Galerijen (foto/video-oplevering) ─────────────────────────────────

type GalleryRow = {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  published_at: string | null;
  cover_item_id: string | null;
  allow_downloads: boolean;
  download_quality: string;
  expires_at: string | null;
};

/** Haal de galerij op en dwing publicatie + geldigheid + klant-eigendom af. */
async function requireAccessibleGallery(user: { email: string }, galleryId: string): Promise<{ gallery: GalleryRow; client: ClientRow; clients: ClientRow[] }> {
  if (!isUuid(galleryId)) throw new PortalError('Ongeldige galerij.', 400);
  const clients = await resolveAccountsForEmail(user.email);

  const { data, error } = await supabaseAdmin.from('galleries').select('*').eq('id', galleryId).maybeSingle();
  if (error) throw error;
  const gallery = data as GalleryRow | null;
  if (!gallery) throw new PortalError('Galerij niet gevonden.', 404);
  if (gallery.status !== 'published') throw new PortalError('Deze galerij is niet (meer) gepubliceerd.', 403);
  if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) {
    throw new PortalError('De toegang tot deze galerij is verlopen.', 403);
  }
  await assertCreativeAccess(gallery.organization_id);

  // Eigendom via het project van de klant (galerijen hangen niet direct aan client_id).
  const { data: project, error: projectError } = await supabaseAdmin
    .from('projects')
    .select('client_id')
    .eq('id', gallery.project_id)
    .eq('organization_id', gallery.organization_id)
    .maybeSingle();
  if (projectError) throw projectError;
  const client = clients.find((row) => row.id === project?.client_id) || null;
  if (!client) throw new PortalError('Geen toegang tot deze galerij.', 403);

  return { gallery, client, clients };
}

/**
 * Galerijen horen bij de creatieve module. Gaat die uit, dan bevriezen we: het
 * portaal blijft de galerij nog de respijtperiode lang tonen en sluit daarna.
 * Fail-open bij een storing in de RPC — een kapotte teller mag de galerij van
 * een betalende klant niet offline halen.
 */
async function assertCreativeAccess(organizationId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('organization_creative_status', {
    p_organization_id: organizationId,
  });
  if (error) return;
  const row = (Array.isArray(data) ? data[0] : data) as { active?: boolean; in_grace?: boolean } | null;
  if (!row || typeof row.active !== 'boolean') return;
  if (row.active || row.in_grace) return;
  throw new PortalError('Deze galerij is niet meer beschikbaar. Neem contact op met je fotograaf.', 403);
}

/** Tokenbundel (R2 + Stream) via de media-api worker; het portaal serveert nooit zelf bytes. */
async function fetchGalleryTokens(organizationId: string, galleryId: string, allowDownload: boolean) {
  if (!MEDIA_WORKER_URL || !MEDIA_INTERNAL_SECRET) {
    throw new PortalError('Galerij-weergave is niet geconfigureerd (MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET).', 500);
  }
  const res = await fetch(`${MEDIA_WORKER_URL}/internal/gallery/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MEDIA_INTERNAL_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId, galleryId, allowDownload, ttlSeconds: 21600 }),
  });
  if (!res.ok) throw new PortalError('Kon galerij-tokens niet ophalen.', 502);
  return (await res.json()) as { mediaToken: string; streamTokens: Record<string, string>; exp: number };
}

async function getGalleryDetail(user: { id: string; email: string }, body: Record<string, unknown>) {
  const galleryId = String(body.galleryId || '').trim();
  const { gallery, client } = await requireAccessibleGallery(user, galleryId);

  const [items, favorites, tokens, contact, categories] = await Promise.all([
    selectRows('gallery_items', (q) => q.eq('gallery_id', gallery.id).eq('organization_id', gallery.organization_id).order('sort_order', { ascending: true }).order('created_at', { ascending: true })),
    selectRows('gallery_favorites', (q) => q.eq('gallery_id', gallery.id).eq('organization_id', gallery.organization_id)),
    fetchGalleryTokens(gallery.organization_id, gallery.id, gallery.allow_downloads),
    resolveActingContact(client, user.email),
    selectRows('gallery_categories', (q) => q.eq('gallery_id', gallery.id).eq('organization_id', gallery.organization_id).order('position', { ascending: true }).order('created_at', { ascending: true }))
      .catch(() => [] as Record<string, unknown>[]),
  ]);

  const sessionKey = `portal:${user.id}`;
  const isMine = (row: Record<string, unknown>) =>
    contact ? row.contact_id === contact.id : row.session_key === sessionKey;
  const reactionOf = (row: Record<string, unknown>) => String(row.reaction ?? 'favorite');

  // Favorieten zijn persoonlijk; de like-teller is juist wat iederéén ziet.
  const likeCounts: Record<string, number> = {};
  for (const row of favorites) {
    if (reactionOf(row) !== 'like') continue;
    const id = String(row.item_id);
    likeCounts[id] = (likeCounts[id] ?? 0) + 1;
  }

  return {
    gallery: sanitizeGallery(gallery),
    items: items.map(sanitizeGalleryItem),
    categories: categories.map((row) => ({ id: row.id, name: row.name })),
    branding: sanitizeBranding(await optionalCompany(gallery.organization_id)),
    tokens,
    myFavoriteIds: favorites.filter((f) => reactionOf(f) === 'favorite' && isMine(f)).map((f) => String(f.item_id)),
    myLikeIds: favorites.filter((f) => reactionOf(f) === 'like' && isMine(f)).map((f) => String(f.item_id)),
    likeCounts,
  };
}

async function toggleGalleryFavorite(user: { id: string; email: string }, body: Record<string, unknown>) {
  const galleryId = String(body.galleryId || '').trim();
  const itemId = String(body.itemId || '').trim();
  const on = body.on === true;
  const reaction = String(body.reaction || 'favorite') === 'like' ? 'like' : 'favorite';
  if (!isUuid(itemId)) throw new PortalError('Ongeldig galerij-item.', 400);
  const { gallery, client } = await requireAccessibleGallery(user, galleryId);

  const { data: item, error: itemError } = await supabaseAdmin
    .from('gallery_items')
    .select('id')
    .eq('id', itemId)
    .eq('gallery_id', gallery.id)
    .eq('organization_id', gallery.organization_id)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item) throw new PortalError('Galerij-item niet gevonden.', 404);

  const contact = await resolveActingContact(client, user.email);
  const sessionKey = `portal:${user.id}`;

  if (on) {
    const insert = contact
      ? { actor_kind: 'portal_contact', contact_id: contact.id, actor_label: contact.name || contact.email }
      : { actor_kind: 'share_link', session_key: sessionKey, actor_label: client.contact_name || client.name || user.email };
    const { error } = await supabaseAdmin.from('gallery_favorites').insert({
      organization_id: gallery.organization_id,
      gallery_id: gallery.id,
      item_id: itemId,
      reaction,
      ...insert,
    });
    // Dubbel klikken → unieke index botst; dat is geen fout voor de klant.
    if (error && error.code !== '23505') throw error;
  } else {
    let query = supabaseAdmin.from('gallery_favorites').delete()
      .eq('item_id', itemId).eq('gallery_id', gallery.id).eq('reaction', reaction);
    query = contact ? query.eq('contact_id', contact.id) : query.eq('session_key', sessionKey);
    const { error } = await query;
    if (error) throw error;
  }
  return { itemId, on, reaction };
}

function sanitizeGallery(row: Record<string, unknown>) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? null,
    format: row.format ?? 'hybrid',
    hero_template: row.hero_template ?? 'full',
    published_at: row.published_at ?? null,
    allow_downloads: Boolean(row.allow_downloads),
    download_quality: row.download_quality ?? 'original',
    cover_item_id: row.cover_item_id ?? null,
    // Een eigen coverbeeld ligt onder de galerij-prefix in R2, dus het kijk-token
    // van de galerij dekt hem al; alleen de weergavevariant gaat mee naar buiten.
    cover_preview_key: row.cover_preview_key ?? null,
    cover_focus_x: clampFocus(row.cover_focus_x),
    cover_focus_y: clampFocus(row.cover_focus_y),
    expires_at: row.expires_at ?? null,
  };
}

/** Het focuspunt gaat rechtstreeks een CSS-waarde in; hou het binnen 0–100. */
function clampFocus(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(100, Math.max(0, value)))
    : 50;
}

function sanitizeGalleryItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    media_type: row.media_type,
    file_name: row.file_name,
    // Voor de viewer: kan de browser dit videobestand rechtstreeks afspelen,
    // en hoe groot wordt de zip? Beide zijn geen geheim — de bytes zelf
    // blijven achter het media-token.
    content_type: row.content_type ?? null,
    size_bytes: typeof row.size_bytes === 'number' ? row.size_bytes : Number(row.size_bytes) || 0,
    category_id: row.category_id ?? null,
    storage_key: row.storage_key ?? null,
    preview_key: row.preview_key ?? null,
    thumb_key: row.thumb_key ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    stream_uid: row.stream_uid ?? null,
    stream_status: row.stream_status ?? null,
    stream_playback_base: row.stream_playback_base ?? null,
  };
}

// ── Meldingen: eigen instellingen ─────────────────────────────────────
//
// Elke portaalgebruiker (hoofdadres of contactpersoon) kiest per klantdossier
// zelf welke e-mailmeldingen er komen. De keuze hangt aan het geverifieerde
// e-mailadres; een clientId uit de browser wordt opnieuw tegen de eigen
// dossiers gecontroleerd. Wat er met de keuze gebeurt: _shared/portalNotify.ts.

type PortalContext = {
  client: ClientRow;
  person: PortalPerson;
  people: PortalPerson[];
};

/** Het dossier + wie de ingelogde gebruiker daarin is. Nooit een id uit de browser blind vertrouwen. */
async function requirePortalPerson(user: { email: string }, clientIdRaw: unknown): Promise<PortalContext> {
  const clientId = String(clientIdRaw || '').trim();
  if (!isUuid(clientId)) throw new PortalError('Ongeldige klant.', 400);
  const clients = await resolveAccountsForEmail(user.email);
  const client = clients.find((row) => row.id === clientId);
  if (!client) throw new PortalError('Geen toegang tot deze klant.', 403);

  const people = portalPeople(client, await loadPortalContacts(client));
  const me = normalizeEmail(user.email);
  const person = people.find((candidate) => candidate.email === me);
  if (!person) throw new PortalError('Geen toegang tot deze klant.', 403);
  return { client, person, people };
}

/** Actieve contactpersonen met portaaltoegang: precies wie er naast het hoofdadres kan inloggen. */
async function loadPortalContacts(client: ClientRow): Promise<Array<{ id: string; name: string; email: string }>> {
  const { data, error } = await supabaseAdmin
    .from('client_contacts')
    .select('id,name,email')
    .eq('client_id', client.id)
    .eq('organization_id', client.organization_id)
    .eq('gives_portal_access', true)
    .eq('is_active', true);
  if (error) throw error;
  return (data || []) as Array<{ id: string; name: string; email: string }>;
}

async function getNotificationSettings(user: { id: string; email: string }, body: Record<string, unknown>) {
  const { client, person, people } = await requirePortalPerson(user, body.clientId);
  const [saved, orgEnabled] = await Promise.all([
    loadSavedPrefs(client.id, person.email),
    organizationSendsTicketEmails(client.organization_id),
  ]);
  return {
    email: person.email,
    isPrimary: person.isPrimary,
    // Alleen met meer mensen op het portaal betekent "alle tickets" iets anders
    // dan "mijn tickets" — en dan alleen voor tickets die het team aanmaakt.
    otherPortalUsers: people.length - 1,
    orgEnabled,
    settings: portalPrefsFor(person, saved ? [saved] : []),
    defaults: defaultPortalPrefs(person),
  };
}

async function updateNotificationSettings(user: { id: string; email: string }, body: Record<string, unknown>) {
  const { client, person } = await requirePortalPerson(user, body.clientId);
  const input = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as Record<string, unknown>;
  const current = portalPrefsFor(person, (await loadSavedPrefs(client.id, person.email).then((row) => (row ? [row] : []))));
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const next: PortalNotifyPrefs = {
    ticketCreated: flag(input.ticketCreated, current.ticketCreated),
    ticketStatus: flag(input.ticketStatus, current.ticketStatus),
    ticketReply: flag(input.ticketReply, current.ticketReply),
    scope: input.scope === 'all' || input.scope === 'own' ? input.scope : current.scope,
  };

  const { error } = await supabaseAdmin
    .from('portal_contact_settings')
    .upsert({
      client_id: client.id,
      email: person.email,
      organization_id: client.organization_id,
      notify_ticket_created: next.ticketCreated,
      notify_ticket_status: next.ticketStatus,
      notify_ticket_reply: next.ticketReply,
      notify_scope: next.scope,
    }, { onConflict: 'client_id,email' });
  if (error) {
    if (isMissingRelationError(error)) throw new PortalError('Meldingen instellen is hier nog niet beschikbaar. Probeer het later opnieuw.', 503);
    throw error;
  }
  return { settings: next };
}

async function loadSavedPrefs(clientId: string, email: string): Promise<PortalSettingsRow | null> {
  const { data, error } = await supabaseAdmin
    .from('portal_contact_settings')
    .select('email,notify_ticket_created,notify_ticket_status,notify_ticket_reply,notify_scope')
    .eq('client_id', clientId)
    .eq('email', email)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  return (data as PortalSettingsRow | null) ?? null;
}

/** De schakelaar van de leverancier. Geen rij = aan. */
async function organizationSendsTicketEmails(organizationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('organization_portal_settings')
    .select('ticket_emails_enabled')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return false;
    throw error;
  }
  return (data as { ticket_emails_enabled?: boolean } | null)?.ticket_emails_enabled !== false;
}

// ── Leesstatus ────────────────────────────────────────────────────────

type ReadRow = { item_kind: string; item_id: string; read_at: string };

/** Openen = lezen. Mag de aanvraag zelf nooit laten mislukken. */
async function markPortalRead(email: string, clientId: string, organizationId: string, kind: 'ticket' | 'thread', itemId: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  try {
    const { error } = await supabaseAdmin
      .from('portal_reads')
      .upsert({
        item_kind: kind,
        item_id: itemId,
        email: normalized,
        client_id: clientId,
        organization_id: organizationId,
        read_at: new Date().toISOString(),
      }, { onConflict: 'item_kind,item_id,email' });
    if (error && !isMissingRelationError(error)) console.warn('client-portal portal_reads overgeslagen', error.message);
  } catch (error) {
    console.warn('client-portal portal_reads crashte', error instanceof Error ? error.message : error);
  }
}

async function loadPortalReads(clientId: string, email: string): Promise<Map<string, string>> {
  const normalized = normalizeEmail(email);
  if (!normalized) return new Map();
  const rows = await optionalRows(supabaseAdmin
    .from('portal_reads')
    .select('item_kind,item_id,read_at')
    .eq('client_id', clientId)
    .eq('email', normalized), 'portal_reads') as ReadRow[];
  return new Map(rows.map((row) => [`${row.item_kind}:${row.item_id}`, row.read_at]));
}

// ── Berichten: de mailgesprekken met de leverancier ───────────────────
//
// Ieder ziet alleen het eigen gesprek met het team: wat die persoon zelf
// stuurde, wat het team die persoon stuurde, en de antwoorden van het team in
// een gesprek waar die persoon aan meedeed. Nooit de mail van een collega op
// hetzelfde portaal, nooit marketing, post van derden of doorgestuurde mail —
// zie _shared/portalMessages.ts. Antwoorden en een nieuw gesprek beginnen kan
// ook: dat wordt een inkomend bericht in het dossier, precies alsof er gemaild
// was, met de melding voor het team die daarbij hoort.

async function loadMessageRows(client: ClientRow, people: PortalPerson[]): Promise<PortalMessageRow[]> {
  const emails = [...new Set(people.map((person) => person.email))];
  if (!emails.length) return [];
  const { data, error } = await supabaseAdmin.rpc('portal_client_message_overview', {
    p_organization_id: client.organization_id,
    p_client_id: client.id,
    p_emails: emails,
  });
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  return (data || []) as PortalMessageRow[];
}

function threadsFor(rows: PortalMessageRow[], me: PortalPerson, people: PortalPerson[]): PortalThreadSummary[] {
  return portalThreadsFor(rows, me.email, new Set(people.map((person) => person.email)));
}

function threadForPortal(thread: PortalThreadSummary, reads: Map<string, string>) {
  return {
    id: thread.id,
    subject: thread.subject,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt,
    // Inkomend is altijd van deze persoon zelf: post van collega's ziet niemand anders.
    lastFrom: thread.lastDirection === 'outbound' ? 'team' : 'me',
    lastFromName: thread.lastFromName,
    lastPreview: thread.lastPreview,
    unread: isUnreadSince(thread.lastTeamMessageAt, reads.get(`thread:${thread.id}`), PORTAL_READS_SINCE),
  };
}

async function getMessageThreads(user: { id: string; email: string }, body: Record<string, unknown>) {
  const { client, person, people } = await requirePortalPerson(user, body.clientId);
  const [rows, reads] = await Promise.all([loadMessageRows(client, people), loadPortalReads(client.id, person.email)]);
  return { threads: threadsFor(rows, person, people).map((thread) => threadForPortal(thread, reads)) };
}

type EmailBodyRow = {
  id: string;
  direction: string;
  from_email: string | null;
  from_name: string | null;
  body_html: string | null;
  body_text: string | null;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
  link_source: string | null;
};

async function getMessageThread(user: { id: string; email: string }, body: Record<string, unknown>) {
  const threadId = String(body.threadId || '').trim();
  if (!isUuid(threadId)) throw new PortalError('Ongeldig gesprek.', 400);

  const { data: thread, error } = await supabaseAdmin
    .from('client_email_threads')
    .select('id,organization_id,client_id,subject')
    .eq('id', threadId)
    .maybeSingle();
  if (error) throw error;
  if (!thread) throw new PortalError('Gesprek niet gevonden.', 404);

  // Het dossier van het gesprek moet één van de eigen dossiers zijn (gooit 403).
  const { client, person, people } = await requirePortalPerson(user, thread.client_id);
  if (client.organization_id !== thread.organization_id) throw new PortalError('Geen toegang tot dit gesprek.', 403);

  const summary = threadsFor(await loadMessageRows(client, people), person, people).find((candidate) => candidate.id === thread.id);
  if (!summary) throw new PortalError('Dit gesprek is niet (meer) beschikbaar in het portaal.', 404);

  // Het hele gesprek ophalen en hier filteren, niet met .in(id, …): een lang
  // gesprek zou de URL naar PostgREST anders onbeperkt laten groeien. Wat de
  // klant niet mag zien (post van derden in hetzelfde gesprek) gaat nooit mee.
  const visibleIds = new Set(summary.messageIds);
  const { data: messages, error: messagesError } = await supabaseAdmin
    .from('client_emails')
    .select('id,direction,from_email,from_name,body_html,body_text,created_at,sent_at,received_at,link_source')
    .eq('organization_id', client.organization_id)
    .eq('client_id', client.id)
    .eq('thread_id', thread.id)
    .is('deleted_at', null);
  if (messagesError) throw messagesError;

  const company = await optionalCompany(client.organization_id);
  const supplierName = (company?.trade_name as string | null) || (company?.company_name as string | null) || 'Je leverancier';
  const ordered = ((messages || []) as EmailBodyRow[])
    .filter((message) => visibleIds.has(String(message.id)))
    .sort((a, b) => Date.parse(messageMoment(a)) - Date.parse(messageMoment(b)));

  await markPortalRead(user.email, client.id, client.organization_id, 'thread', thread.id);

  return {
    thread: { id: thread.id, clientId: client.id, subject: summary.subject },
    messages: ordered.map((message) => sanitizePortalMessage(message, person, people, supplierName)),
  };
}

async function sendMessage(user: { id: string; email: string }, body: Record<string, unknown>) {
  const text = String(body.body || '').trim();
  if (!text) throw new PortalError('Een bericht mag niet leeg zijn.', 400);
  if (text.length > 5000) throw new PortalError('Een bericht mag maximaal 5000 tekens zijn.', 400);

  const { client, person, people } = await requirePortalPerson(user, body.clientId);
  const organizationId = client.organization_id;

  // Een rem op stortvloeden: elk bericht laat bij het team een melding afgaan.
  const since = new Date(Date.now() - MESSAGE_RATE_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from('client_emails')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('client_id', client.id)
    .eq('direction', 'inbound')
    .eq('link_source', 'portal')
    .eq('from_email', person.email)
    .gte('created_at', since);
  if (countError) throw countError;
  if ((count ?? 0) >= MESSAGE_RATE_LIMIT) {
    throw new PortalError(`Je hebt de afgelopen ${MESSAGE_RATE_WINDOW_MINUTES} minuten al veel berichten gestuurd. Probeer het zo nog eens.`, 429);
  }

  const rows = await loadMessageRows(client, people);
  const requestedThreadId = String(body.threadId || '').trim();
  let threadId: string;
  let subject: string;
  let threadSubject: string;
  let isNewThread = false;

  if (requestedThreadId) {
    if (!isUuid(requestedThreadId)) throw new PortalError('Ongeldig gesprek.', 400);
    const { data: thread, error } = await supabaseAdmin
      .from('client_email_threads')
      .select('id,subject')
      .eq('id', requestedThreadId)
      .eq('organization_id', organizationId)
      .eq('client_id', client.id)
      .maybeSingle();
    if (error) throw error;
    // Alleen in een eigen gesprek; het onderwerp zoals déze persoon het ziet
    // (het gesprek kan met post van een ander begonnen zijn).
    const mine = thread ? threadsFor(rows, person, people).find((candidate) => candidate.id === thread.id) : undefined;
    if (!thread || !mine) {
      throw new PortalError('Dit gesprek is niet (meer) beschikbaar in het portaal.', 404);
    }
    threadId = String(thread.id);
    threadSubject = mine.subject;
    subject = replySubject(mine.subject);
  } else {
    subject = String(body.subject || '').replace(/\s+/g, ' ').trim();
    if (!subject) throw new PortalError('Geef je bericht een onderwerp.', 400);
    if (subject.length > 200) throw new PortalError('Het onderwerp mag maximaal 200 tekens zijn.', 400);
    const { data: thread, error } = await supabaseAdmin
      .from('client_email_threads')
      .insert({
        organization_id: organizationId,
        client_id: client.id,
        created_by: null,
        subject,
        last_direction: 'inbound',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) throw error;
    threadId = String(thread.id);
    threadSubject = subject;
    isNewThread = true;
  }

  // "Aan": het adres van het bedrijf, anders wie in dit gesprek het laatst
  // namens het team schreef. Puur ter informatie; dit bericht gaat niet per mail.
  const company = await optionalCompany(organizationId);
  const lastTeamSender = rows
    .filter((row) => row.thread_id === threadId && row.direction === 'outbound')
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0]?.from_email;
  const toEmail = normalizeEmail(company?.email) || normalizeEmail(lastTeamSender) || 'klantportaal';
  const now = new Date().toISOString();

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('client_emails')
    .insert({
      organization_id: organizationId,
      thread_id: threadId,
      client_id: client.id,
      created_by: null,
      direction: 'inbound',
      provider: 'portal',
      from_email: person.email,
      from_name: person.name !== person.email ? person.name : null,
      to_email: toEmail,
      subject,
      body_text: text,
      body_html: null,
      status: 'received',
      received_at: now,
      last_event_at: now,
      link_source: 'portal',
      // Zelfde schaal als de doorstuurbak (high/medium/low): een ingelogde
      // portaalgebruiker is de hoogste zekerheid die er is.
      link_confidence: 'high',
      metadata: { source: 'client_portal', portal_user_id: user.id, client_contact_id: person.contactId },
    })
    .select('id,direction,from_email,from_name,body_html,body_text,created_at,sent_at,received_at,link_source')
    .single();
  if (insertError) {
    // Een nieuw, leeg gesprek laten we niet achter.
    if (isNewThread) await supabaseAdmin.from('client_email_threads').delete().eq('id', threadId);
    throw insertError;
  }

  if (!isNewThread) {
    await supabaseAdmin
      .from('client_email_threads')
      .update({ last_message_at: now, last_direction: 'inbound' })
      .eq('id', threadId)
      .eq('organization_id', organizationId);
  }
  await markPortalRead(user.email, client.id, organizationId, 'thread', threadId);

  const supplierName = (company?.trade_name as string | null) || (company?.company_name as string | null) || 'Je leverancier';
  return {
    threadId,
    subject: threadSubject,
    message: sanitizePortalMessage(inserted as EmailBodyRow, person, people, supplierName),
  };
}

function messageMoment(row: Pick<EmailBodyRow, 'received_at' | 'sent_at' | 'created_at'>): string {
  return row.received_at || row.sent_at || row.created_at;
}

/**
 * Een mailbericht zoals de klant het in het portaal ziet. Van het team: de
 * HTML zoals verstuurd (de browser saneert hem nogmaals). Van de klantkant:
 * alleen platte tekst — die HTML komt van buiten en hoort niet op deze pagina.
 */
function sanitizePortalMessage(row: EmailBodyRow, me: PortalPerson, people: PortalPerson[], supplierName: string) {
  const fromTeam = row.direction === 'outbound';
  const fromEmail = normalizeEmail(row.from_email);
  const author = people.find((candidate) => candidate.email === fromEmail);
  return {
    id: row.id,
    fromTeam,
    mine: !fromTeam && fromEmail === me.email,
    authorName: fromTeam
      ? (String(row.from_name ?? '').trim().slice(0, 80) || supplierName)
      : (author?.name || String(row.from_name ?? '').trim().slice(0, 80) || 'Klant'),
    viaPortal: row.link_source === 'portal',
    bodyHtml: fromTeam ? (row.body_html || null) : null,
    bodyText: String(row.body_text ?? '').trim() || htmlToPlainText(row.body_html),
    at: messageMoment(row),
  };
}

// ── Dataopbouw ────────────────────────────────────────────────────────

async function resolveAccountsForEmail(email: string): Promise<ClientRow[]> {
  const { data, error } = await supabaseAdmin.rpc('portal_clients_for_email', { p_email: email });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as ClientRow[];
}

async function buildAccount(client: ClientRow, email: string) {
  const orgId = client.organization_id;
  const actingContact = await resolveActingContact(client, email);

  const [company, projects] = await Promise.all([
    optionalCompany(orgId),
    selectRows('projects', (q) => q.eq('organization_id', orgId).eq('client_id', client.id).order('created_at', { ascending: false })),
  ]);
  const projectIds = projects.map((p: Record<string, unknown>) => String(p.id));

  // Facturen: alleen uitgegeven (geen concepten). Offertes: alleen die echt naar de
  // klant zijn verstuurd (sent_at gezet). Beide ook gekoppeld via projecten van de klant.
  const [invoices, quotes, tickets, contracts, galleries] = await Promise.all([
    selectRows('invoices', (q) => scopeToClient(q.eq('organization_id', orgId).neq('status', 'draft'), client.id, projectIds).order('date', { ascending: false })),
    selectRows('quotes', (q) => scopeToClient(q.eq('organization_id', orgId).not('sent_at', 'is', null), client.id, projectIds).order('date', { ascending: false })),
    selectRows('tickets', (q) => q.eq('organization_id', orgId).eq('client_id', client.id).order('created_at', { ascending: false })),
    // Contracten zijn alleen op client_id gekoppeld; toon enkel verstuurde/getekende/geweigerde.
    selectRows('contracts', (q) => q.eq('organization_id', orgId).eq('client_id', client.id).in('status', ['sent', 'signed', 'declined']).order('created_at', { ascending: false })),
    // Galerijen hangen aan projecten van de klant; alleen gepubliceerd en niet
    // verlopen. Stil degraderen als de galerij-migratie nog niet is toegepast:
    // het portaal mag nooit omvallen op een module die nog niet bestaat.
    projectIds.length > 0
      ? selectRows('galleries', (q) => q.eq('organization_id', orgId).eq('status', 'published').in('project_id', projectIds).order('published_at', { ascending: false }))
        .catch((error) => {
          console.warn('client-portal galleries lookup overgeslagen', error instanceof Error ? error.message : error);
          return [] as Record<string, unknown>[];
        })
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const activeGalleries = galleries.filter((g) => !g.expires_at || new Date(String(g.expires_at)) > new Date());

  // Wat er nieuw is sinds deze persoon het laatst keek: antwoorden van het team
  // op tickets, en mail van het team in de gesprekken. Alles optioneel — zonder
  // de migratie van 2026-10-04 is er gewoon niets "nieuw".
  const peoplePromise = loadPortalContacts(client).then((contacts) => portalPeople(client, contacts));
  const [overview, reads, people, messageRows] = await Promise.all([
    optionalRpc('portal_ticket_overview', { p_organization_id: orgId, p_client_id: client.id }),
    loadPortalReads(client.id, email),
    peoplePromise,
    peoplePromise.then((portalUsers) => loadMessageRows(client, portalUsers)).catch((error) => {
      console.warn('client-portal berichtenoverzicht overgeslagen', error instanceof Error ? error.message : error);
      return [] as PortalMessageRow[];
    }),
  ]);
  const overviewByTicket = new Map(overview.map((row) => [String(row.ticket_id), row]));
  const me = people.find((person) => person.email === normalizeEmail(email)) ?? null;
  const threads = me ? threadsFor(messageRows, me, people).map((thread) => threadForPortal(thread, reads)) : [];

  return {
    id: client.id,
    organizationId: orgId,
    company: sanitizeCompany(company),
    // Nul extra queries: de huisstijlkolommen zitten al in de rij die we
    // hierboven voor sanitizeCompany hebben opgehaald.
    branding: sanitizeBranding(company),
    client: sanitizeClient(client),
    actingContact: actingContact ? { name: actingContact.name, email: actingContact.email } : null,
    projects: projects.map(sanitizeProject),
    invoices: invoices.map(sanitizeInvoice),
    quotes: quotes.map(sanitizeQuote),
    tickets: tickets.map((ticket) => ({
      ...sanitizeTicket(ticket),
      ...ticketActivityForPortal(ticket, overviewByTicket.get(String(ticket.id)), reads),
    })),
    contracts: contracts.map(sanitizeContract),
    galleries: activeGalleries.map(sanitizeGallery),
    messages: { threads: threads.length, unread: threads.filter((thread) => thread.unread).length },
  };
}

/**
 * Laatste activiteit per ticket, voor de lijst en de stip "nieuw antwoord".
 * Nieuw = een antwoord van het team, of een ticket dat het team voor de klant
 * aanmaakte, dat nog niet geopend is. Reacties van de klant zelf (of
 * een collega) maken een ticket niet "nieuw".
 */
function ticketActivityForPortal(ticket: Record<string, unknown>, overview: Record<string, unknown> | undefined, reads: Map<string, string>) {
  const createdAt = String(ticket.created_at ?? '');
  const lastNoteAt = overview?.last_note_at ? String(overview.last_note_at) : null;
  const createdByTeam = !ticket.created_by_email && !ticket.created_by_contact_id;
  const teamMoments = [overview?.last_team_note_at ? String(overview.last_team_note_at) : null, createdByTeam ? createdAt : null]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  const lastAuthorType = overview?.last_note_author_type ? String(overview.last_note_author_type) : null;
  return {
    last_activity_at: lastNoteAt && Date.parse(lastNoteAt) > Date.parse(createdAt) ? lastNoteAt : createdAt,
    reply_count: Number(overview?.note_count ?? 0) || 0,
    last_reply_from: lastAuthorType ? (lastAuthorType === 'client' ? 'client' : 'team') : null,
    last_reply_author: lastAuthorType === 'client' ? (String(overview?.last_note_author_name ?? '').trim().slice(0, 80) || null) : null,
    last_reply_preview: overview?.last_note_preview ? previewText(overview.last_note_preview, 140) : null,
    unread: isUnreadSince(teamMoments[0] ?? null, reads.get(`ticket:${String(ticket.id)}`), PORTAL_READS_SINCE),
  };
}

/**
 * Zoekt de specifieke, portaal-gemachtigde contactpersoon die bij dit
 * geverifieerde e-mailadres hoort (indien dit e-mailadres niet het
 * hoofd-e-mailadres van de klant zelf is). Vergelijkt in JS met dezelfde
 * normalisatie als normalize_client_lookup_value (lower + trim + witruimte
 * samenvouwen) i.p.v. een SQL ilike-filter: e-mailadressen mogen een
 * underscore bevatten, wat in LIKE/ILIKE een jokerteken is en dus tot een
 * verkeerde match zou kunnen leiden.
 */
async function resolveActingContact(client: ClientRow, email: string): Promise<ActingContact | null> {
  const target = normalizeLookup(email);
  if (!target) return null;

  const { data, error } = await supabaseAdmin
    .from('client_contacts')
    .select('id,name,email')
    .eq('client_id', client.id)
    .eq('gives_portal_access', true)
    .eq('is_active', true);
  if (error) throw error;

  const rows = (data || []) as Array<{ id: string; name: string; email: string }>;
  const match = rows.find((row) => normalizeLookup(row.email) === target);
  return match ? { id: match.id, name: match.name, email: match.email } : null;
}

function normalizeLookup(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

async function assertEntityBelongsToClients(entity: { client_id: string | null; project_id: string | null; organization_id: string }, clients: ClientRow[]) {
  const clientIds = new Set(clients.map((c) => c.id));
  if (entity.client_id && clientIds.has(entity.client_id)) return;
  if (entity.project_id) {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('client_id')
      .eq('id', entity.project_id)
      .eq('organization_id', entity.organization_id)
      .maybeSingle();
    if (error) throw error;
    if (data?.client_id && clientIds.has(data.client_id)) return;
  }
  throw new PortalError('Geen toegang tot dit document.', 403);
}

// ── Query-helpers ─────────────────────────────────────────────────────

// Losse typering (any) net als de andere edge functions in deze repo: de
// PostgREST-builderketen is lastig exact te typen en wordt door Deno gedeployd,
// niet door de frontend-tsc.
// deno-lint-ignore no-explicit-any
type QueryBuilder = any;

function scopeToClient(query: QueryBuilder, clientId: string, projectIds: string[]): QueryBuilder {
  // PostgREST: client_id OF (project_id in projecten van de klant). Zonder projecten
  // alleen op client_id filteren. UUID's bevatten geen tekens die de or-filter breken.
  if (projectIds.length > 0) {
    return query.or(`client_id.eq.${clientId},project_id.in.(${projectIds.join(',')})`);
  }
  return query.eq('client_id', clientId);
}

async function selectRows(table: string, build: (q: QueryBuilder) => QueryBuilder): Promise<Record<string, unknown>[]> {
  const { data, error } = await build(supabaseAdmin.from(table).select('*'));
  if (error) throw error;
  return (data || []) as Record<string, unknown>[];
}

/**
 * Een tabel of functie die er nog niet is (migratie nog niet gedraaid,
 * terwijl de functie al wel is uitgerold). Bewust niet het losse "does not
 * exist": dat zegt Postgres ook bij een ontbrekende kolom, en een kapotte
 * deploy hoort niet stil te verdwijnen achter "nog niet beschikbaar" (zie
 * src/lib/postgrestErrors.ts).
 */
function isMissingRelationError(error: { message?: string; details?: string | null; code?: string } | null | undefined): boolean {
  if (!error) return false;
  // 42P01 = onbekende tabel; PGRST202/205 = onbekende functie/tabel in de schema-cache.
  if (error.code === '42P01' || error.code === 'PGRST202' || error.code === 'PGRST205') return true;
  return /relation\s+\S+\s+does not exist|schema cache|could not find the (table|function)/i.test(`${error.message ?? ''} ${error.details ?? ''}`);
}

/** Rijen uit een tabel die er misschien nog niet is: dan leeg, met een waarschuwing in de log. */
async function optionalRows(query: QueryBuilder, label: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(`client-portal ${label} nog niet beschikbaar`, error.message);
      return [];
    }
    throw error;
  }
  return (data || []) as Record<string, unknown>[];
}

async function optionalRpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(`client-portal ${name} nog niet beschikbaar`, error.message);
      return [];
    }
    throw error;
  }
  return (Array.isArray(data) ? data : []) as Record<string, unknown>[];
}

// Alleen de kolommen die het portaal ook echt naar buiten stuurt. Bewust geen
// select('*') meer: dat sleepte invoice_template_data_url mee — het rauwe
// briefpapier, ongelimiteerd in grootte — bij elke portaalopvraag, per account.
// De huisstijlkolommen komen uit _shared/branding.ts, zodat een nieuwe
// huisstijlinstelling maar op één plek hoeft te worden bijgeschreven.
const COMPANY_COLUMNS = [
  'email', 'phone', 'website', 'city', 'country', 'iban', 'vat_number', 'kvk_number',
  BRANDING_COLUMNS,
].join(',');

// Dezelfde lijst zonder de kolommen die de nieuwste migratie toevoegt. Draait de
// functie al terwijl `db push` nog moet, dan faalt de brede lijst en levert deze
// terugval nog altijd alles behalve de sfeerkeuze — beter dan terugvallen op
// `select('*')`, want dan komt het rauwe briefpapier alsnog mee.
const COMPANY_COLUMNS_LEGACY = COMPANY_COLUMNS
  .split(',')
  .filter((column) => column !== 'brand_client_theme')
  .join(',');

async function optionalCompany(organizationId: string) {
  const row = (columns: string) => supabaseAdmin
    .from('company_settings')
    .select(columns)
    .eq('organization_id', organizationId)
    .maybeSingle();
  try {
    let { data, error } = await row(COMPANY_COLUMNS);
    if (error) {
      // Draait deze versie al terwijl de migratie nog niet is toegepast, dan
      // bestaat de nieuwste kolom nog niet en faalt de hele opvraag. Liever de
      // sfeerkeuze missen dan een portaal zonder bedrijfsgegevens.
      console.warn('client-portal company lookup mislukt, opnieuw zonder de nieuwste kolom', error.message);
      ({ data, error } = await row(COMPANY_COLUMNS_LEGACY));
    }
    if (error) {
      console.warn('client-portal company lookup failed', error.message);
      return null;
    }
    return (data as Record<string, unknown> | null) || null;
  } catch (error) {
    console.warn('client-portal company lookup crashed', error instanceof Error ? error.message : error);
    return null;
  }
}

// ── Saneren (alleen klantveilige velden) ──────────────────────────────

function sanitizeClient(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contact_name: row.contact_name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
  };
}

function sanitizeCompany(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    company_name: row.company_name ?? null,
    trade_name: row.trade_name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    iban: row.iban ?? null,
    vat_number: row.vat_number ?? null,
    kvk_number: row.kvk_number ?? null,
  };
}

function sanitizeProject(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    color: row.color ?? null,
    archived: Boolean(row.archived),
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    created_at: row.created_at,
  };
}

function sanitizeInvoice(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    due_date: row.due_date ?? null,
    status: row.status,
    lines: Array.isArray(row.lines) ? row.lines : [],
    notes: row.notes ?? null,
    sent_at: row.sent_at ?? null,
    paid_at: row.paid_at ?? null,
    project_id: row.project_id ?? null,
  };
}

function sanitizeQuote(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    valid_until: row.valid_until ?? null,
    status: row.status,
    lines: Array.isArray(row.lines) ? row.lines : [],
    notes: row.notes ?? null,
    sent_at: row.sent_at ?? null,
    accepted_at: row.accepted_at ?? null,
    project_id: row.project_id ?? null,
    client_decision_at: row.client_decision_at ?? null,
    client_decision_by_name: row.client_decision_by_name ?? null,
    client_decision_note: row.client_decision_note ?? null,
  };
}

function sanitizeContract(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    title: row.title ?? '',
    status: row.status,
    date: row.date,
    valid_until: row.valid_until ?? null,
    signed_at: row.signed_at ?? null,
  };
}

function sanitizeTicket(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sanitizeTicketNote(row: Record<string, unknown>) {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    author_type: row.author_type === 'client' ? 'client' : 'user',
    author_name: row.author_name ?? null,
    body: row.body,
    created_at: row.created_at,
  };
}

function sanitizeTask(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    planned_date: row.planned_date ?? null,
  };
}

// ── Generieke helpers ─────────────────────────────────────────────────

async function requireUser(req: Request): Promise<{ id: string; email: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new PortalError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new PortalError('Niet ingelogd of ongeldige sessie.', 401);
  const email = (data.user.email || '').trim();
  if (!email) throw new PortalError('Aan deze login is geen e-mailadres gekoppeld.', 403);
  return { id: data.user.id, email };
}

function normalizePriority(value: unknown): 'low' | 'med' | 'high' {
  const v = String(value || '').toLowerCase();
  return v === 'low' || v === 'high' ? v : 'med';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.code === 'string' && obj.code) parts.push(`(code ${obj.code})`);
    if (typeof obj.details === 'string' && obj.details) parts.push(`details: ${obj.details}`);
    if (typeof obj.hint === 'string' && obj.hint) parts.push(`hint: ${obj.hint}`);
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(obj); } catch { /* val terug op String() */ }
  }
  return String(error);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;
      try { origins.add(new URL(part).origin); } catch { origins.add(part); }
    }
  }
  return Array.from(origins);
}

function assertAllowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';
  // Een pagina zonder herkomst (sandbox-iframe, data:, file:) is nooit de app.
  if (origin === 'null') throw new PortalError('Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.', 403);
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PortalError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : '';
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
