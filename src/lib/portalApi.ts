import type { GalleryLayout } from './galleryLayout';
import { supabasePortal } from './supabasePortal';
import { PORTAL_TOKEN_HEADER, portalTokenMode, storedPortalToken } from './portalToken';
import { sanitizeStoredBranding, type BrandingPayload } from './branding';
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
  /** De naam op de rekening (juridische naam); ontbreekt bij een oudere client-portal. */
  accountHolder?: string | null;
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
  // Sinds 2026-10-04 in de payload; een oudere edge function laat ze weg.
  /** Laatste activiteit: het ticket zelf of de laatste zichtbare reactie. */
  last_activity_at?: string;
  /** Aantal zichtbare reacties op de tijdlijn. */
  reply_count?: number;
  last_reply_from?: 'team' | 'client' | null;
  /** Naam bij een reactie van de klantkant (jij of een collega). */
  last_reply_author?: string | null;
  last_reply_preview?: string | null;
  /** Er is een antwoord van de leverancier dat je hier nog niet geopend hebt. */
  unread?: boolean;
}

/** Een statuswijziging, als regel in het gesprek van een ticket. */
export interface PortalTicketEvent {
  id: string;
  kind: 'status';
  old_status: string | null;
  new_status: string | null;
  created_at: string;
}

export interface PortalTicketNote {
  id: string;
  ticket_id: string;
  author_type: 'user' | 'client';
  author_name: string | null;
  body: string;
  created_at: string;
  /** Bestanden die de leverancier bij dit antwoord meestuurde (sinds 2026-10-13). */
  files?: PortalTransfer | null;
}

/** Eén bestand in een zending, zoals de klant het ziet. */
export interface PortalTransferItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path: string | null;
  kind: 'file' | 'text';
  downloadable: boolean;
  readable: boolean;
}

/** Bestanden die de leverancier stuurde (een zending): met bericht en vervaldatum. */
export interface PortalTransfer {
  id: string;
  clientId: string | null;
  subject: string;
  message: string | null;
  senderName: string | null;
  sentAt: string | null;
  expiresAt: string;
  canDownload: boolean;
  /** Nog te openen? Na de vervaldatum of na intrekken: nee, en dan zonder bestanden. */
  available: boolean;
  items: PortalTransferItem[];
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
  events: PortalTicketEvent[];
}

export type PortalNotifyScope = 'all' | 'own';

/** Welke e-mailmeldingen deze portaalgebruiker voor dit dossier wil krijgen. */
export interface PortalNotificationSettings {
  ticketCreated: boolean;
  ticketStatus: boolean;
  ticketReply: boolean;
  /** 'all' = alle tickets van het dossier; 'own' = alleen die je zelf indiende. */
  scope: PortalNotifyScope;
}

export interface PortalNotificationState {
  email: string;
  /** Hoofdadres van het dossier (en geen extra contactpersoon). */
  isPrimary: boolean;
  /** Hoeveel anderen er nog op het portaal van dit dossier kunnen. */
  otherPortalUsers: number;
  /** Verstuurt de leverancier überhaupt meldingen? */
  orgEnabled: boolean;
  /** false = de klant staat op inactief: geen tickets, dus niets in te stellen. Ontbreekt bij een oudere server. */
  ticketsOpen?: boolean;
  settings: PortalNotificationSettings;
  defaults: PortalNotificationSettings;
}

/** Eén mailgesprek met de leverancier, voor de lijst onder Berichten. */
export interface PortalMessageThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
  lastMessageAt: string;
  /** Wie schreef het laatste bericht: de leverancier, jij of een collega. */
  lastFrom: 'team' | 'me' | 'colleague';
  lastFromName: string | null;
  lastPreview: string;
  unread: boolean;
}

export interface PortalMessage {
  id: string;
  fromTeam: boolean;
  /** Door jou geschreven. */
  mine: boolean;
  authorName: string;
  /** Geschreven in het portaal (en dus niet per e-mail). */
  viaPortal: boolean;
  /** Alleen bij berichten van de leverancier; altijd nog saneren vóór weergave. */
  bodyHtml: string | null;
  bodyText: string;
  at: string;
  /** Bestanden die met dit bericht meegingen (sinds 2026-10-13). */
  transfer?: PortalTransfer | null;
}

export interface PortalMessageThread {
  thread: { id: string; clientId: string; subject: string };
  messages: PortalMessage[];
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
  /** Het eigen inlogadres van deze leverancier (/portal/<sleutel>); ontbreekt
   *  bij een oudere server of als het (nog) niet bestaat. */
  portalLoginKey?: string | null;
  client: PortalClient | null;
  /** Gezet als de ingelogde gebruiker een geregistreerde contactpersoon is
   *  (i.p.v. het hoofd-e-mailadres van de klant zelf) — voor een persoonlijke
   *  begroeting in het portaal. */
  actingContact: PortalActingContact | null;
  projects: PortalProject[];
  invoices: PortalInvoice[];
  quotes: PortalQuote[];
  contracts: PortalContract[];
  /**
   * false = de klant staat op inactief: geen tickets in het portaal (de lijst
   * is dan leeg), geen indienen, geen meldingen. Ontbreekt bij een oudere
   * server; dan geldt open.
   */
  ticketsOpen?: boolean;
  tickets: PortalTicket[];
  galleries: PortalGallery[];
  /** Aantal met deze contactpersoon gedeelde mappen/bestanden — voedt het tabbladtelletje. */
  sharedFileCount?: number;
  /** Aantal zendingen (bestanden versturen) dat nu voor deze persoon klaarstaat. */
  transferCount?: number;
  /** Mailgesprekken met de leverancier: hoeveel, en hoeveel met nieuws (sinds 2026-10-04). */
  messages?: { threads: number; unread: number };
}

/** Eén ding binnen een deling: een bestand, notitie of document. */
export interface PortalSharedItem {
  itemType: 'attachment' | 'note' | 'document';
  itemId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  modified: string | null;
  /** Pad binnen de gedeelde map, bv. "Contracten / 2026". Leeg bij een los bestand. */
  path: string | null;
  downloadable: boolean;
  /** Notities en tekstdocumenten lees je op de pagina zelf. */
  readable: boolean;
}

/** Eén deling: wat er is gedeeld, met welk bericht erbij, en wat erin zit. */
export interface PortalShare {
  id: string;
  clientId: string | null;
  itemType: 'folder' | 'attachment' | 'note' | 'document';
  itemName: string | null;
  message: string | null;
  canDownload: boolean;
  expiresAt: string | null;
  sharedAt: string;
  items: PortalSharedItem[];
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
  /** Weergave van het album (indeling, witruimte, kolommen, speelsheid); ontbreekt bij een oudere edge function. */
  layout?: Partial<GalleryLayout> | null;
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
  /** Sinds 2026-09-19 in de payload; een oudere edge function laat ze weg. */
  content_type?: string | null;
  size_bytes?: number | null;
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
  /** Groot tonen; ontbreekt bij een oudere edge function. */
  featured?: boolean;
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
 * Vraagt de inlogmail aan. De server zet (alleen voor bekende klantadressen)
 * het account klaar en verstuurt de mail met link en code; het antwoord zegt
 * bewust niet óf een adres bekend is. `verifierHash` is de hash van het geheim
 * van deze browser (src/lib/portalLoginFlow.ts): zonder werkt de link niet.
 */
export async function requestPortalLogin(
  email: string,
  options: { verifierHash: string; key?: string | null },
): Promise<void> {
  const { data, error } = await portalInvoke('portal-login', {
    body: { action: 'requestLogin', email, verifierHash: options.verifierHash, ...(options.key ? { key: options.key } : {}) },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Inloggen voorbereiden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Inloggen voorbereiden mislukt');
}

/**
 * De link uit de inlogmail inwisselen: het aanvraagnummer en de geheimen van
 * deze browser. Geeft het inlogtoken, dat de app zelf bij Supabase inwisselt,
 * of op een eigen domein de sleutel van het portaal (src/lib/portalToken.ts).
 */
export async function redeemPortalLogin(request: string, verifiers: string[]): Promise<{
  tokenHash: string | null; portalToken: string | null; email: string; portalKey: string | null;
}> {
  const { data, error } = await portalInvoke('portal-login', { body: { action: 'redeemLogin', request, verifiers } });
  if (error) throw new Error(await extractFunctionError(error, 'Inloggen is niet gelukt'));
  const tokenHash = typeof data?.tokenHash === 'string' ? data.tokenHash : null;
  const portalToken = typeof data?.portalToken === 'string' ? data.portalToken : null;
  if (!data?.ok || (!tokenHash && !portalToken)) throw new Error(data?.error || 'Inloggen is niet gelukt');
  return { tokenHash, portalToken, email: String(data.email ?? ''), portalKey: typeof data.portalKey === 'string' ? data.portalKey : null };
}

/**
 * De code uit de mail, op een eigen domein: geeft de sleutel van het portaal.
 * Daar maakt Supabase Auth geen inlog (src/lib/portalToken.ts).
 */
export async function redeemPortalCode(email: string, code: string): Promise<{ portalToken: string; portalKey: string | null }> {
  const { data, error } = await portalInvoke('portal-login', { body: { action: 'redeemCode', email, code } });
  if (error) throw new Error(await extractFunctionError(error, 'Inloggen is niet gelukt'));
  if (!data?.ok || typeof data.portalToken !== 'string') throw new Error(data?.error || 'Inloggen is niet gelukt');
  return { portalToken: data.portalToken, portalKey: typeof data.portalKey === 'string' ? data.portalKey : null };
}

/** Uitloggen op een eigen domein: de server gooit de sleutel weg. Lukt dat niet, dan is hij in deze browser toch al weg. */
export async function endPortalToken(token: string): Promise<void> {
  try {
    await portalInvoke('portal-login', { body: { action: 'endPortalToken' }, headers: { [PORTAL_TOKEN_HEADER]: token } });
  } catch {
    // Niets aan te doen: hij verloopt vanzelf.
  }
}

/**
 * Een verse inlog vastleggen (portal-login, bindSession; migraties
 * 20261109020000 en 20261109150000). Pas daarna slaat de app hem op:
 * client-portal weigert een inlog die nergens vastligt. Met het nieuwe token,
 * de geheimen van deze browser en het aanvraagnummer uit de link (zonder kan
 * het niet meer: een code van Supabase staat niet meer in de mail). Lukt het
 * niet, dan maakt de server de inlog ook ongeldig; de melding is voor de klant.
 */
export async function bindPortalSession(accessToken: string, options: { request: string; verifiers: string[] }): Promise<void> {
  const { data, error } = await portalInvoke('portal-login', {
    body: { action: 'bindSession', verifiers: options.verifiers, request: options.request },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Inloggen is niet gelukt'));
  if (!data?.ok) throw new Error(data?.error || 'Inloggen is niet gelukt');
}

/**
 * De huisstijl van het inlogscherm bij de sleutel uit het adres
 * (/portal/<sleutel>), vóór het inloggen. Null bij een onbekende sleutel of
 * een storing: dan is het inlogscherm neutraal, net als op /portal. Wat
 * binnenkomt keuren we opnieuw (`sanitizeStoredBranding`), zoals alles wat de
 * schil van het portaal kleurt.
 */
export async function fetchPortalLoginBranding(key: string | null): Promise<BrandingPayload | null> {
  try {
    // Op een klantadres zegt het adres zelf van wie het portaal is; de sleutel mag dan ontbreken.
    const { data, error } = await portalInvoke('portal-login', { body: { action: 'getBranding', ...(key ? { key } : {}) } });
    if (error || !data?.ok || !data.branding) return null;
    return sanitizeStoredBranding(data.branding);
  } catch {
    return null;
  }
}

export async function fetchPortalData(): Promise<PortalData> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getPortalData' },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Portaalgegevens laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Portaalgegevens laden mislukt');
  return { email: String(data.email || ''), accounts: Array.isArray(data.accounts) ? data.accounts : [] };
}

export async function createPortalTicket(input: CreatePortalTicketInput): Promise<PortalTicket> {
  const { data, error } = await portalInvoke('client-portal', {
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
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getTicketThread', ticketId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Ticket laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Ticket laden mislukt');
  return {
    ticket: data.ticket as PortalTicket,
    notes: Array.isArray(data.notes) ? data.notes : [],
    events: Array.isArray(data.events) ? data.events : [],
  };
}

export async function addPortalTicketNote(ticketId: string, body: string): Promise<PortalTicketNote> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'addTicketNote', ticketId, body },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Notitie plaatsen mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Notitie plaatsen mislukt');
  return data.note as PortalTicketNote;
}

export async function fetchPortalProjectDetail(projectId: string): Promise<PortalProjectDetail> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getProjectDetail', projectId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Project laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Project laden mislukt');
  return { project: data.project as PortalProject, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
}

/** Galerij-detail: items + kijk-/downloadtokens + eigen favorieten. */
export async function fetchPortalGalleryDetail(galleryId: string): Promise<PortalGalleryDetail> {
  const { data, error } = await portalInvoke('client-portal', {
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
  const { data, error } = await portalInvoke('client-portal', {
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
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'decideQuote', quoteId, kind, note: note ?? '' },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Offertebeslissing verwerken mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Offertebeslissing verwerken mislukt');
  return data.quote as PortalQuote;
}

/** Betaalinfo van één factuur (bedrag, betaalbaarheid, Mollie-beschikbaarheid, IBAN). */
export async function fetchPortalInvoicePaymentInfo(invoiceId: string): Promise<PortalInvoicePaymentInfo> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getInvoicePaymentInfo', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Betaalinfo laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Betaalinfo laden mislukt');
  return data.payment as PortalInvoicePaymentInfo;
}

/** Maakt (of hergebruikt) een Mollie-betaallink voor een factuur en geeft de checkout-URL terug. */
export async function createPortalInvoicePayment(invoiceId: string): Promise<{ checkoutUrl: string; mock: boolean; reused: boolean }> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'createInvoicePayment', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Betaallink aanmaken mislukt'));
  if (!data?.ok || !data.checkoutUrl) throw new Error(data?.error || 'Betaallink aanmaken mislukt');
  return { checkoutUrl: data.checkoutUrl as string, mock: Boolean(data.mock), reused: Boolean(data.reused) };
}

export async function downloadPortalInvoicePdf(invoiceId: string): Promise<{ fileName: string; mimeType: string; base64: string }> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getInvoicePdf', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Factuur-PDF downloaden mislukt'));
  if (!data?.ok || !data.pdf?.base64) throw new Error(data?.error || 'Factuur-PDF downloaden mislukt');
  return { fileName: data.pdf.fileName || `factuur-${invoiceId}.pdf`, mimeType: data.pdf.mimeType || 'application/pdf', base64: data.pdf.base64 };
}

export async function downloadPortalContractPdf(contractId: string): Promise<{ fileName: string; mimeType: string; base64: string }> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getContractPdf', contractId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Contract-PDF downloaden mislukt'));
  if (!data?.ok || !data.pdf?.base64) throw new Error(data?.error || 'Contract-PDF downloaden mislukt');
  return { fileName: data.pdf.fileName || `contract-${contractId}.pdf`, mimeType: data.pdf.mimeType || 'application/pdf', base64: data.pdf.base64 };
}

/** De mappen/bestanden die met deze contactpersoon zijn gedeeld. */
export async function fetchPortalSharedFiles(clientId?: string): Promise<PortalShare[]> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getSharedFiles', clientId: clientId ?? null },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Gedeelde bestanden ophalen mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Gedeelde bestanden ophalen mislukt');
  return (data.shares ?? []) as PortalShare[];
}

export type PortalSharedDownload =
  | { kind: 'file'; fileName: string; mimeType: string; base64: string }
  | { kind: 'url'; fileName: string; url: string }
  | { kind: 'text'; title: string; html: string };

/** Haalt één gedeeld item op: bestandsbytes (base64) of de tekst van een notitie/document. */
export async function downloadPortalSharedItem(
  shareId: string,
  itemType: string,
  itemId: string,
): Promise<PortalSharedDownload> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'downloadSharedFile', shareId, itemType, itemId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Downloaden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Downloaden mislukt');
  if (data.text) return { kind: 'text', title: data.text.title || '', html: data.text.html || '' };
  // Sinds 2026-10-13: een kortlevende downloadlink van de media-worker (geen base64).
  if (typeof data.file?.url === 'string' && data.file.url) {
    return { kind: 'url', fileName: data.file.fileName || 'bestand', url: data.file.url as string };
  }
  if (data.file?.base64) {
    return {
      kind: 'file',
      fileName: data.file.fileName || 'bestand',
      mimeType: data.file.mimeType || 'application/octet-stream',
      base64: data.file.base64 as string,
    };
  }
  throw new Error('Downloaden mislukt');
}

/** Je eigen meldingskeuzes voor één dossier, plus of de leverancier meldingen verstuurt. */
export async function fetchPortalNotificationSettings(clientId: string): Promise<PortalNotificationState> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getNotificationSettings', clientId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Instellingen laden mislukt'));
  if (!data?.ok || !data.settings) throw new Error(data?.error || 'Instellingen laden mislukt');
  return {
    email: String(data.email || ''),
    isPrimary: data.isPrimary === true,
    otherPortalUsers: Number(data.otherPortalUsers) || 0,
    orgEnabled: data.orgEnabled !== false,
    settings: data.settings as PortalNotificationSettings,
    defaults: (data.defaults ?? data.settings) as PortalNotificationSettings,
  };
}

/** Sla (een deel van) je meldingskeuzes op; geeft de opgeslagen stand terug. */
export async function updatePortalNotificationSettings(
  clientId: string,
  settings: Partial<PortalNotificationSettings>,
): Promise<PortalNotificationSettings> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'updateNotificationSettings', clientId, settings },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Instellingen opslaan mislukt'));
  if (!data?.ok || !data.settings) throw new Error(data?.error || 'Instellingen opslaan mislukt');
  return data.settings as PortalNotificationSettings;
}

/** De mailgesprekken met de leverancier, nieuwste eerst. */
export async function fetchPortalMessageThreads(clientId: string): Promise<PortalMessageThreadSummary[]> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getMessageThreads', clientId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Berichten laden mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Berichten laden mislukt');
  return Array.isArray(data.threads) ? data.threads as PortalMessageThreadSummary[] : [];
}

/** Eén gesprek met alle berichten. Openen telt als gelezen. */
export async function fetchPortalMessageThread(threadId: string): Promise<PortalMessageThread> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getMessageThread', threadId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Gesprek laden mislukt'));
  if (!data?.ok || !data.thread) throw new Error(data?.error || 'Gesprek laden mislukt');
  return { thread: data.thread, messages: Array.isArray(data.messages) ? data.messages : [] };
}

/** Antwoord in een gesprek (threadId) of begin een nieuw gesprek (subject). */
export async function sendPortalMessage(input: { clientId: string; threadId?: string | null; subject?: string; body: string }): Promise<{
  threadId: string;
  subject: string;
  message: PortalMessage;
}> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'sendMessage', clientId: input.clientId, threadId: input.threadId ?? null, subject: input.subject ?? '', body: input.body },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Bericht versturen mislukt'));
  if (!data?.ok || !data.message) throw new Error(data?.error || 'Bericht versturen mislukt');
  return { threadId: String(data.threadId), subject: String(data.subject || ''), message: data.message as PortalMessage };
}

/** De zendingen die nu voor jou klaarstaan in dit dossier. */
export async function fetchPortalTransfers(clientId: string): Promise<PortalTransfer[]> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'getTransfers', clientId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Bestanden ophalen mislukt'));
  if (!data?.ok) throw new Error(data?.error || 'Bestanden ophalen mislukt');
  return Array.isArray(data.transfers) ? data.transfers as PortalTransfer[] : [];
}

/** Een kortlevende downloadlink voor één bestand uit een zending. */
export async function portalTransferDownload(transferId: string, itemId: string): Promise<{ url: string; fileName: string }> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'transferDownload', transferId, itemId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Downloaden mislukt'));
  if (!data?.ok || !data.url) throw new Error(data?.error || 'Downloaden mislukt');
  return { url: String(data.url), fileName: String(data.fileName || 'bestand') };
}

/** De tekst van een notitie of document uit een zending. */
export async function portalTransferRead(transferId: string, itemId: string): Promise<{ title: string; html: string }> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'transferRead', transferId, itemId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Openen mislukt'));
  if (!data?.ok || !data.text) throw new Error(data?.error || 'Openen mislukt');
  return { title: String(data.text.title || ''), html: String(data.text.html || '') };
}

/** Een downloadlink voor de hele zending als zip. */
export async function portalTransferZip(transferId: string): Promise<string> {
  const { data, error } = await portalInvoke('client-portal', {
    body: { action: 'transferZip', transferId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Downloaden mislukt'));
  if (!data?.ok || !data.url) throw new Error(data?.error || 'Downloaden mislukt');
  return String(data.url);
}

/**
 * Wie de aanroepen beantwoordt. Normaal de edge functions; in het voorbeeld van
 * het portaal (Instellingen → Huisstijl, /portal/voorbeeld) een nagebootste
 * backend met verzonnen gegevens, zodat het voorbeeld precies dezelfde
 * componenten draait als het echte portaal en toch niets ophaalt of verstuurt.
 */
export type PortalBackend = (name: string, body: Record<string, unknown>) => Promise<{ data: any; error: unknown }>; // eslint-disable-line @typescript-eslint/no-explicit-any

let portalBackend: PortalBackend | null = null;

export function setPortalBackend(backend: PortalBackend | null): void {
  portalBackend = backend;
}

let sessionLost: (() => void) | null = null;

/**
 * Wat er gebeurt als client-portal de inlog niet (meer) kent: de app logt uit
 * en vraagt opnieuw in te loggen. Bijvoorbeeld een inlog van vóór migratie
 * 20261109020000, of een eigen domein waar het portaal net is uitgezet.
 */
export function onPortalSessionLost(handler: (() => void) | null): void {
  sessionLost = handler;
}

async function portalInvoke(name: string, options: { body: Record<string, unknown>; headers?: Record<string, string> }) {
  if (portalBackend) return portalBackend(name, options.body);
  // Op een eigen domein gaat de sleutel van het portaal mee (er is daar geen inlog bij Supabase).
  const token = portalTokenMode() ? storedPortalToken() : null;
  const headers = { ...(token ? { [PORTAL_TOKEN_HEADER]: token } : {}), ...(options.headers ?? {}) };
  const result = await supabasePortal.functions.invoke(name, { body: options.body, ...(Object.keys(headers).length ? { headers } : {}) });
  if (name === 'client-portal' && result.error && sessionLost && (await isSessionUnbound(result.error))) sessionLost();
  return result;
}

/** Een 401 met code session_unbound (client-portal, _shared/portalSession.ts). */
async function isSessionUnbound(error: unknown): Promise<boolean> {
  const context = (error as { context?: unknown })?.context;
  if (!(context instanceof Response) || context.status !== 401) return false;
  try {
    const payload = await context.clone().json() as { code?: unknown } | null;
    return payload?.code === 'session_unbound';
  } catch {
    return false;
  }
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
