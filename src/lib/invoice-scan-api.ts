// ============================================================
// Frontend-koppeling met de AI-inkoopfactuurscan (`invoice-extract` Edge Function).
//
// Stuurt het factuurbestand (base64) naar de edge-functie en krijgt een VOORSTEL
// terug: leverancier (gematcht of nieuw), factuurnummer, datums, regels (excl. +
// BTW) met per regel een voorgestelde grootboekrekening, plus totalen. De UI vult
// hiermee het bestaande concept-inkoopfactuurformulier voor. Er wordt niets
// automatisch geboekt.
// ============================================================

import { supabase } from './supabase';
import type { UUID } from '../types';

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/** 10 MB — gelijk aan de limiet in de edge-functie (direct-naar-edge base64). */
export const SCAN_MAX_BYTES = 10 * 1024 * 1024;
export const SCAN_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,image/gif,.pdf';
const SUPPORTED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export type ScanConfidence = 'high' | 'medium' | 'low';

export interface ScanProposalLine {
  description: string;
  /** Bedrag EXCL btw in centen. */
  amount_cents: number;
  vat_code: string;
  vat_rate: number;
  /** Gevalideerde grootboekrekening-id (of null -> vangnet bij boeken). */
  account_id: UUID | null;
  account_code: string | null;
}

export interface ScanSupplierProposal {
  /** Gevonden bestaande leverancier (op BTW-nr/IBAN/naam), anders null. */
  matchedId: UUID | null;
  matchedBy: 'vat' | 'iban' | 'name' | null;
  name: string;
  vat_number: string | null;
  kvk_number: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  default_expense_account_id: UUID | null;
  default_vat_code: string | null;
}

export interface ScanProposal {
  supplier: ScanSupplierProposal;
  supplier_invoice_number: string | null;
  date: string | null;
  due_date: string | null;
  currency: string;
  notes: string | null;
  confidence: ScanConfidence;
  warnings: string[];
  lines: ScanProposalLine[];
  totals: { subtotal_cents: number; vat_cents: number; total_cents: number };
  extracted_totals: { subtotal_cents: number | null; vat_cents: number | null; total_cents: number | null } | null;
}

export interface ScanResult {
  proposal: ScanProposal;
  extraction_meta: Record<string, unknown>;
}

type ScanResponse = ({ ok: true } & ScanResult) | { ok: false; error: string };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Bestand kon niet worden gelezen.'));
    reader.readAsDataURL(file);
  });
}

/** Leest één inkoopfactuur (PDF/afbeelding) uit tot een voorstel. */
export async function scanInvoice(organizationId: UUID, file: File): Promise<ScanResult> {
  if (file.size > SCAN_MAX_BYTES) {
    throw new Error(`Bestand is te groot (max ${Math.round(SCAN_MAX_BYTES / 1024 / 1024)} MB). Comprimeer het en probeer opnieuw.`);
  }
  const mimeType = (file.type || '').toLowerCase();
  if (!SUPPORTED_MIME.includes(mimeType)) {
    throw new Error('Alleen PDF, JPG, PNG, WEBP of GIF worden ondersteund.');
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');

  const dataBase64 = await fileToBase64(file);

  const res = await fetch(`${FUNCTIONS_BASE}/invoice-extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ organizationId, file: { name: file.name, mimeType, dataBase64 } }),
  });

  const payload = (await res.json().catch(() => null)) as ScanResponse | null;
  if (!res.ok || !payload || payload.ok === false) {
    const msg = payload && 'error' in payload && payload.error ? payload.error : `Uitlezen mislukt (${res.status}).`;
    throw new Error(msg);
  }
  return { proposal: payload.proposal, extraction_meta: payload.extraction_meta };
}
