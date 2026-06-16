import { supabasePortal } from './supabasePortal';
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

export interface PortalAccount {
  id: string;
  organizationId: string;
  company: PortalCompany | null;
  client: PortalClient | null;
  projects: PortalProject[];
  invoices: PortalInvoice[];
  quotes: PortalQuote[];
  tickets: PortalTicket[];
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

export async function downloadPortalInvoicePdf(invoiceId: string): Promise<{ fileName: string; mimeType: string; base64: string }> {
  const { data, error } = await supabasePortal.functions.invoke('client-portal', {
    body: { action: 'getInvoicePdf', invoiceId },
  });
  if (error) throw new Error(await extractFunctionError(error, 'Factuur-PDF downloaden mislukt'));
  if (!data?.ok || !data.pdf?.base64) throw new Error(data?.error || 'Factuur-PDF downloaden mislukt');
  return { fileName: data.pdf.fileName || `factuur-${invoiceId}.pdf`, mimeType: data.pdf.mimeType || 'application/pdf', base64: data.pdf.base64 };
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
