import { supabasePortal } from './supabasePortal';
import type { BrandingPayload } from './branding';
import type { FinanceLine, InvoiceStatus, Priority, FinanceStatus } from '../types';

// Dunne wrappers rond de `client-portal` edge function, in de stijl van
// src/lib/repository.ts. De portaal-client hangt automatisch het sessietoken van
// de ingelogde klant aan elke invoke, dat de function via requireUser() verifieert.

export interface PortalClient {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
}

export interface PortalCompany {
  company_name: string | null;
  trade_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  country: string | null;
  iban: string | null;
  vat_number: string | null;
  kvk_number: string | null;
}

export interface PortalProject {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archived: boolean;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export interface PortalInvoice {
  id: string;
  number: string;
  date: string;
  due_date: string | null;
  status: InvoiceStatus | string;
  lines: FinanceLine[];
  notes: string | null;
  sent_at: string | null;
  paid_at: string | null;
  project_id: string | null;
}

export interface PortalQuote {
  id: string;
  number: string;
  date: string;
  valid_until: string | null;
  status: FinanceStatus | string;
  lines: FinanceLine[];
  notes: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  project_id: string | null;
  client_decision_at?: string | null;
  client_decision_by_name?: string | null;
  client_decision_note?: string | null;
}

export interface PortalInvoicePaymentInfo {
  invoiceId: string;
  number: string;
  status: string;
  isPaid: boolean;
  payable: boolean;
  amountCents: number;
  currency: string;
  mollieAvailable: boolean;
  iban: string | null;
  companyName: string | null;
}

export interface PortalContract {
  id: string;
  number: string;
  title: string;
  status: string;
  date: string;
  valid_until: string | null;
  signed_at: string | null;
}

export interface PortalTicket {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: Priority | string;
  created_at: string;
  updated_at: string;
}

export interface PortalTicketNote {
  id: string;
  ticket_id: string;
  author_type: 'user' | 'client';
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface PortalTask {
  id: string;
  title: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  planned_date: string | null;
}

export interface PortalProjectDetail {
  project: PortalProject;
  tasks: PortalTask[];
}

export interface PortalTicketThread {
  ticket: PortalTicket;
  notes: PortalTicketNote[];
}

export interface PortalActingContact {
  name: string;
  email: string;
}

export interface PortalAccount {
  id: string;
  organizationId: string;
  company: PortalCompany | null;
  /** Huisstijl van de leverancier; stuurt de hele schil van het portaal. */
  branding: BrandingPayload | null;
  client: PortalClient | null;
  /** Gezet als de ingelogde gebruiker een geregistreerde contactpersoon is
   *  (i.p.v. het hoofd-e-mailadres van de klant zelf) — voor een persoonlijke
   *  begroeting in het portaal. */
  actingContact: PortalActingContact | null;
  projects: PortalProject[];
  invoices: PortalInvoice[];
  quotes: PortalQuote[];
  contracts: PortalContract[];
  tickets: PortalTicket[];
  galleries: PortalGallery[];
}

export interface PortalGallery {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  /** 'photo' | 'video' | 'hybrid' — bepaalt de weergave bij de klant. */
  format: string;
  /** De opening van de galerij; zie GalleryHeroTemplate in src/types.ts. */
  hero_template: string;
  published_at: string | null;
  allow_downloads: boolean;
  download_quality: string;
  cover_item_id: string | null;
  /** Eigen coverbeeld dat niet in de galerij zit; wint van `cover_item_id`. */
  cover_preview_key: string | null;
  /** Focuspunt van de uitsnede in procenten (0–100). */
  cover_focus_x: number;
  cover_focus_y: number;
  expires_at: string | null;
}

export interface PortalGalleryCategory {
  id: string;
  name: string;
}

export interface PortalGalleryItem {
  id: string;
  media_type: 'photo' | 'video';
  file_name: string;
  category_id: string | null;
  storage_key: string | null;
  preview_key: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  stream_uid: string | null;
  stream_status: string | null;
  stream_playback_base: string | null;
}

export interface PortalGalleryTokens {
  mediaToken: string;
  streamTokens: Record<string, string>;
  exp: number;
}

export interface PortalGalleryDetail {
  gallery: PortalGallery;
  items: PortalGalleryItem[];
  categories: PortalGalleryCategory[];
  /** Huisstijl van de beeldmaker; afwezig = de standaard ResoFly-stijl. */
  branding?: BrandingPayload;
  tokens: PortalGalleryTokens;
  /** Eigen selectie (privé) en eigen likes; likeCounts is voor iedereen zichtbaar. */
  myFavoriteIds: string[];
  myLikeIds: string[];
  likeCounts: Record<string, number>;
}

export interface PortalData {
  email: string;
  accounts: PortalAccount[];
}

export interface CreatePortalTicketInput {
  clientId: string;
  title: string;
  description: string;
  priority: Priority;
}

/**
 * Bereidt de login voor: maakt server-side een account aan voor bekende klanten
 * (clients.email) zodat de magische link werkt ook al staat zelf-registratie uit.
 * Geeft `known: false` als het e-mailadres niet als klant bekend is.
 */
export async function requestPortalLogin(email: string): Promise<{ known: boolean }> {
  const { data, error } = await supabasePortal.functions.invoke('portal-login', {
    body: { action: 'requestLogin', email },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Inloggen voorbereiden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Inloggen voorbereiden mislukt');
  return { known: Boolean(data.known) };
}

export async function fetchPortalData(): Promise<PortalData> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getPortalData' },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Portaalgegevens laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Portaalgegevens laden mislukt');
  return { email: String(data.email || ''), accounts: Array.isArray(data.accounts) ? data.accounts : [] };
}

export async function createPortalTicket(input: CreatePortalTicketInput): Promise<PortalTicket> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: {
      action: 'createTicket',
      clientId: input.clientId,
      title: input.title,
      description: input.description,
      priority: input.priority,
    },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Ticket aanmaken mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Ticket aanmaken mislukt');
  return data.ticket as PortalTicket;
}

export async function fetchPortalTicketThread(ticketId: string): Promise<PortalTicketThread> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getTicketThread', ticketId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Ticket laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Ticket laden mislukt');
  return { ticket: data.ticket as PortalTicket, notes: Array.isArray(data.notes) ? data.notes : [] };
}

export async function addPortalTicketNote(ticketId: string, body: string): Promise<PortalTicketNote> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'addTicketNote', ticketId, body },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Notitie plaatsen mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Notitie plaatsen mislukt');
  return data.note as PortalTicketNote;
}

export async function fetchPortalProjectDetail(projectId: string): Promise<PortalProjectDetail> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getProjectDetail', projectId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Project laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Project laden mislukt');
  return { project: data.project as PortalProject, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
}

/** Galerij-detail: items + kijk-/downloadtokens + eigen favorieten. */
export async function fetchPortalGalleryDetail(galleryId: string): Promise<PortalGalleryDetail> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getGalleryDetail', galleryId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Galerij laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Galerij laden mislukt');
  return {
    gallery: data.gallery as PortalGallery,
    items: Array.isArray(data.items) ? data.items : [],
    categories: Array.isArray(data.categories) ? data.categories : [],
    branding: (data.branding ?? undefined) as BrandingPayload | undefined,
    tokens: data.tokens as PortalGalleryTokens,
    myFavoriteIds: Array.isArray(data.myFavoriteIds) ? data.myFavoriteIds.map(String) : [],
    myLikeIds: Array.isArray(data.myLikeIds) ? data.myLikeIds.map(String) : [],
    likeCounts: (data.likeCounts ?? {}) as Record<string, number>,
  };
}

/** Favoriet of like aan/uit (attributie via de ingelogde contactpersoon). */
export async function togglePortalGalleryFavorite(
  galleryId: string,
  itemId: string,
  on: boolean,
  reaction: 'favorite' | 'like' = 'favorite',
): Promise<void> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'toggleGalleryFavorite', galleryId, itemId, on, reaction },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Favoriet bijwerken mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Favoriet bijwerken mislukt');
}

/**
 * Laat de ingelogde klant een naar hem verstuurde offerte accepteren of weigeren,
 * rechtstreeks vanuit het portaal. Geeft de bijgewerkte offerte terug.
 */
export async function decidePortalQuote(quoteId: string, kind: 'accept' | 'reject', note?: string): Promise<PortalQuote> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'decideQuote', quoteId, kind, note: note ?? '' },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Offertebeslissing verwerken mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Offertebeslissing verwerken mislukt');
  return data.quote as PortalQuote;
}

/** Betaalinfo van één factuur (bedrag, betaalbaarheid, Mollie-beschikbaarheid, IBAN). */
export async function fetchPortalInvoicePaymentInfo(invoiceId: string): Promise<PortalInvoicePaymentInfo> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getInvoicePaymentInfo', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Betaalinfo laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Betaalinfo laden mislukt');
  return data.payment as PortalInvoicePaymentInfo;
}

/** Maakt (of hergebruikt) een Mollie-betaallink voor een factuur en geeft de checkout-URL terug. */
export async function createPortalInvoicePayment(invoiceId: string): Promise<{ checkoutUrl: string; mock: boolean; reused: boolean }> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'createInvoicePayment', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Betaallink aanmaken mislukt'));
  if (!data?.ok || !data.checkoutUrl) throw new Error(data?.error || 'Betaallink aanmaken mislukt');
  return { checkoutUrl: data.checkoutUrl as string, mock: Boolean(data.mock), reused: Boolean(data.reused) };
}

export async function downloadPortalInvoicePdf(invoiceId: string): Promise<{ fileName: string; mimeType: string; base64: string }> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getInvoicePdf', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Factuur-PDF downloaden mislukt'));
  if (!data?.ok || !data.pdf?.base64) throw new Error(data?.error || 'Factuur-PDF downloaden mislukt');
  return { fileName: data.pdf.fileName || `factuur-${invoiceId}.pdf`, mimeType: data.pdf.mimeType || 'application/pdf', base64: data.pdf.base64 };
}

export async function downloadPortalContractPdf(contractId: string): Promise<{ fileName: string; mimeType: string; base64: string }> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getContractPdf', contractId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Contract-PDF downloaden mislukt'));
  if (!data?.ok || !data.pdf?.base64) throw new Error(data?.error || 'Contract-PDF downloaden mislukt');
  return { fileName: data.pdf.fileName || `contract-${contractId}.pdf`, mimeType: data.pdf.mimeType || 'application/pdf', base64: data.pdf.base64 };
}

// Supabase functions.invoke geeft een non-2xx terug als FunctionsHttpError, waarvan
// .message generiek is ("Edge Function returned a non-2xx status code"). De echte
// reden zit in de response-body (error.context); deze helper haalt die eruit.
async function extractFunctionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json().catch(() => null) as { error?: string } | null;
      if (payload?.error) return payload.error;
      const text = await context.text().catch(() => '');
      if (text) return text;
    } catch {
      // val terug op message hieronder
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
