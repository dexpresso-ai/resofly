import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { createPortalInvoiceCheckout, calculateTotalCents, orgHasInvoiceMollie } from '../_shared/invoiceCheckout.ts';

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
      case 'getGalleryDetail':
        return json(req, { ok: true, ...(await getGalleryDetail(user, body)) });
      case 'toggleGalleryFavorite':
        return json(req, { ok: true, ...(await toggleGalleryFavorite(user, body)) });
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
  const accounts = [];
  for (const client of clients) {
    accounts.push(await buildAccount(client, user.email));
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

  return { ticket: sanitizeTicket(ticket), notes: (notes || []).map(sanitizeTicketNote) };
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

  return { note: sanitizeTicketNote(data) };
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
  const myFavoriteIds = favorites
    .filter((f) => (contact ? f.contact_id === contact.id : f.session_key === sessionKey))
    .map((f) => String(f.item_id));

  return {
    gallery: sanitizeGallery(gallery),
    items: items.map(sanitizeGalleryItem),
    categories: categories.map((row) => ({ id: row.id, name: row.name })),
    tokens,
    myFavoriteIds,
  };
}

async function toggleGalleryFavorite(user: { id: string; email: string }, body: Record<string, unknown>) {
  const galleryId = String(body.galleryId || '').trim();
  const itemId = String(body.itemId || '').trim();
  const on = body.on === true;
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
      ...insert,
    });
    // Dubbel klikken → unieke index botst; dat is geen fout voor de klant.
    if (error && error.code !== '23505') throw error;
  } else {
    let query = supabaseAdmin.from('gallery_favorites').delete().eq('item_id', itemId).eq('gallery_id', gallery.id);
    query = contact ? query.eq('contact_id', contact.id) : query.eq('session_key', sessionKey);
    const { error } = await query;
    if (error) throw error;
  }
  return { itemId, on };
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
    expires_at: row.expires_at ?? null,
  };
}

function sanitizeGalleryItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    media_type: row.media_type,
    file_name: row.file_name,
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

  return {
    id: client.id,
    organizationId: orgId,
    company: sanitizeCompany(company),
    client: sanitizeClient(client),
    actingContact: actingContact ? { name: actingContact.name, email: actingContact.email } : null,
    projects: projects.map(sanitizeProject),
    invoices: invoices.map(sanitizeInvoice),
    quotes: quotes.map(sanitizeQuote),
    tickets: tickets.map(sanitizeTicket),
    contracts: contracts.map(sanitizeContract),
    galleries: activeGalleries.map(sanitizeGallery),
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

async function optionalCompany(organizationId: string) {
  try {
    const { data, error } = await supabaseAdmin.from('company_settings').select('*').eq('organization_id', organizationId).maybeSingle();
    if (error) {
      console.warn('client-portal company lookup failed', error.message);
      return null;
    }
    return data || null;
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
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PortalError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
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
