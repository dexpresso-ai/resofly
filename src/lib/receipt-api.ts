// ============================================================
// Een bon insturen: de foto klaarmaken in de browser en naar de edge
// function invoice-inbox sturen (action 'upload').
//
// De server legt de bon vast, zet de foto op R2 en laat Gerrie hem meteen
// lezen. Wie Financiën mag bewerken, krijgt het werklijst-item en het concept
// terug; een declarant alleen zijn eigen bon (zie declarationView in
// supabase/functions/_shared/invoiceInboxRules.ts).
// ============================================================

import { supabase } from './supabase';
import { ConnectionError, HttpStatusError, isConnectionError, withRetry } from './networkRetry';
import {
  RECEIPT_JPEG_QUALITY, RECEIPT_MAX_BYTES, RECEIPT_MAX_EDGE, fitWithin, isImageFile, isPdfFile, receiptFileName,
} from './receipts';
import type { DeclarationStatus, PurchaseInvoiceInboxItem, UUID } from '../types';

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface ReceiptInvoiceSummary {
  id: UUID;
  internal_number: string | null;
  date: string;
  total_cents: number;
  currency: string;
  supplier_id: UUID | null;
  supplier_name: string | null;
  status: string;
}

export interface DeclarationReceipt {
  id: UUID;
  status: DeclarationStatus;
  store_name: string | null;
  receipt_date: string | null;
  total_cents: number | null;
  currency: string;
  read: boolean;
}

export type ReceiptUploadResult =
  | { channel: 'receipt'; item: PurchaseInvoiceInboxItem; invoice: ReceiptInvoiceSummary | null }
  | { channel: 'declaration'; declaration: DeclarationReceipt };

/**
 * Maakt van een gekozen bestand iets wat de server kan lezen en wat snel over
 * 4G gaat. Een foto wordt rechtop gezet (EXIF), verkleind tot 2400 pixels aan
 * de lange kant en als JPEG opgeslagen; een pdf gaat zoals hij is.
 *
 * Een HEIC-foto van een iPhone komt meestal al als JPEG binnen (Safari zet hem
 * om). Lukt openen niet, dan zeggen we dat in gewone woorden.
 */
export async function prepareReceiptFile(file: File, now = new Date()): Promise<File> {
  if (isPdfFile(file)) {
    if (file.size > RECEIPT_MAX_BYTES) throw new Error('Deze pdf is groter dan 10 MB. Scan de bon opnieuw met een lagere kwaliteit.');
    return file.type === 'application/pdf' ? file : new File([file], file.name, { type: 'application/pdf' });
  }
  if (!isImageFile(file)) throw new Error('Kies een foto of een pdf van de bon.');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Deze foto kan je browser niet openen (bijvoorbeeld een HEIC-bestand). Maak de foto opnieuw in de app, of kies een JPG of pdf.');
    }
  }
  try {
    for (const [edge, quality] of [[RECEIPT_MAX_EDGE, RECEIPT_JPEG_QUALITY], [1800, 0.75], [1400, 0.7]] as const) {
      const size = fitWithin(bitmap.width, bitmap.height, edge);
      const blob = await drawToJpeg(bitmap, size.width, size.height, quality);
      if (blob.size <= RECEIPT_MAX_BYTES) return new File([blob], receiptFileName(now, 'jpg'), { type: 'image/jpeg' });
    }
  } finally {
    bitmap.close?.();
  }
  throw new Error('Deze foto is te groot om te versturen. Maak hem opnieuw.');
}

function drawToJpeg(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Deze browser kan de foto niet verkleinen.'));
  // Wit eronder: een PNG met doorzichtige delen wordt anders zwart in een JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('De foto kon niet worden omgezet.'))), 'image/jpeg', quality);
  });
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('De foto kon niet worden gelezen.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Stuurt één bon in. `clientRequestId` hoort bij deze ene foto: valt de
 * verbinding weg en probeert de app het opnieuw, dan herkent de server hem en
 * komt er geen tweede bon. Daarom mag withRetry hier gerust opnieuw proberen.
 */
export async function uploadReceipt(
  organizationId: UUID,
  file: File,
  clientRequestId: string,
  options: { onRetry?: (waiting: boolean) => void } = {},
): Promise<ReceiptUploadResult> {
  const dataBase64 = await fileToBase64(file);
  const body = JSON.stringify({
    organizationId, action: 'upload', clientRequestId,
    file: { name: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 },
  });

  return await withRetry(async () => {
    // Bij elke poging een vers token: een poging na een slapende telefoon
    // mag niet stranden op een verlopen sessie.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
    let res: Response;
    try {
      res = await fetch(`${FUNCTIONS_BASE}/invoice-inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
        body,
      });
    } catch (error) {
      throw isConnectionError(error) ? new ConnectionError() : error;
    }
    const payload = (await res.json().catch(() => null)) as ({ ok: true } & ReceiptUploadResult) | { ok: false; error: string } | null;
    if (!res.ok || !payload || payload.ok === false) {
      const message = payload && 'error' in payload && payload.error ? payload.error : `Insturen mislukt (${res.status}).`;
      // Alleen een storing onderweg of bij de server is het opnieuw proberen
      // waard. Een te groot bestand of de limiet per uur lossen zich niet op.
      if (res.status >= 500) throw new HttpStatusError(message, res.status);
      throw new Error(message);
    }
    return payload.channel === 'declaration'
      ? { channel: 'declaration', declaration: payload.declaration }
      : { channel: 'receipt', item: payload.item, invoice: payload.invoice ?? null };
  }, { attempts: 3, onRetry: info => options.onRetry?.(info.waiting) });
}

/** Een uuid per foto, ook in een browser zonder crypto.randomUUID. */
export function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
