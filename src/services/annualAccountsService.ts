import { supabase, supabaseAuth } from '../lib/supabase';
import type { AnnualAccountStatus, UUID } from '../types';

/**
 * De jaarrekening-PDF en het publicatiestuk.
 *
 * Beide worden SERVER-SIDE gemaakt, in de edge function `annual-accounts`. Dat
 * is geen implementatiedetail maar de kern van het stuk: wat de algemene
 * vergadering vaststelt en wat bij het handelsregister ligt, moet over vijf jaar
 * nog letterlijk hetzelfde zijn. Vandaar één renderer, bytes met een sha256
 * ernaast, en een gearchiveerd exemplaar in private opslag dat bij het
 * downloaden LETTERLIJK wordt teruggegeven in plaats van opnieuw opgebouwd.
 *
 * Een voorbeeld (`previewPdf`) loopt door dezelfde renderer: één generator, geen
 * drift tussen concept en definitief. Het verschil zit alleen in `source`.
 */

type FunctionResponse<T> = { ok?: boolean; error?: string } & T;

/** Het volledige stuk, of de beperktere set die wordt gedeponeerd. */
export type AnnualAccountsVariant = 'annual' | 'publication';

export type AnnualAccountsPdfResult = {
  variant: AnnualAccountsVariant;
  /**
   * 'generated'   — vers gemaakt (voorbeeld of archiveerronde)
   * 'archived'    — letterlijk het opgeslagen exemplaar; dit is het stuk zelf
   * 'regenerated' — er was geen archief; opnieuw opgebouwd uit dezelfde
   *                 bevroren cijfers. Het scherm benoemt dat verschil.
   */
  source: 'generated' | 'archived' | 'regenerated';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  snapshotHash: string | null;
  /** De bevroren cijfers passen niet meer bij de administratie. */
  snapshotStale: boolean;
  status: AnnualAccountStatus | null;
  base64: string;
  note?: string;
  archive?: { stored: boolean; provider: string; key?: string; attachmentId?: string; reason?: string };
};

type AnnualAccountsAction =
  | 'previewPdf' | 'renderPdf' | 'renderPublication' | 'downloadPdf' | 'downloadPublication';

async function invokeAnnualAccounts(
  action: AnnualAccountsAction,
  organizationId: UUID,
  annualAccountId: UUID,
  variant?: AnnualAccountsVariant,
): Promise<AnnualAccountsPdfResult> {
  const { data: sessionData, error: sessionError } = await supabaseAuth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.access_token) throw new Error('Je bent niet ingelogd.');

  const { data, error } = await supabase.functions.invoke<FunctionResponse<AnnualAccountsPdfResult>>('annual-accounts', {
    body: { action, organizationId, annualAccountId, variant: variant ?? null },
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  });
  if (error) {
    // Bij een non-2xx geeft supabase-js een generieke fout; de Nederlandstalige
    // servermelding (bijvoorbeeld een weigering uit de database) zit in de body.
    const body = await extractErrorMessage(error);
    throw new Error(body || (error instanceof Error ? error.message : 'De jaarrekening-PDF maken is mislukt.'));
  }
  if (!data) throw new Error('Geen antwoord van de jaarrekeningfunctie ontvangen.');
  if (data.error) throw new Error(data.error);
  if (!data.base64) throw new Error('Er kwam geen PDF terug van de server.');
  return data;
}

async function extractErrorMessage(error: unknown): Promise<string | null> {
  const response = (error as { context?: Response } | null)?.context;
  if (!response || typeof response.text !== 'function') return null;
  try {
    const parsed = JSON.parse(await response.clone().text());
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/** Base64 -> Blob; gedeeld door het voorbeeld (object-URL) en de download. */
export function pdfBlob(result: AnnualAccountsPdfResult): Blob {
  const binary = atob(result.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: result.mimeType || 'application/pdf' });
}

function saveToDisk(result: AnnualAccountsPdfResult): void {
  const url = URL.createObjectURL(pdfBlob(result));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName || 'jaarrekening.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/**
 * Voorbeeld: exact dezelfde bytes als het definitieve stuk, alleen niet
 * opgeslagen. Het scherm toont ze in een object-URL.
 */
export const previewAnnualAccountsPdf = (
  organizationId: UUID,
  annualAccountId: UUID,
  variant: AnnualAccountsVariant = 'annual',
) => invokeAnnualAccounts('previewPdf', organizationId, annualAccountId, variant);

/** Genereert de jaarrekening-PDF én archiveert haar (schrijfrecht vereist). */
export const renderAnnualAccountsPdf = (organizationId: UUID, annualAccountId: UUID) =>
  invokeAnnualAccounts('renderPdf', organizationId, annualAccountId);

/** Genereert het publicatiestuk én archiveert het (schrijfrecht vereist). */
export const renderAnnualAccountsPublication = (organizationId: UUID, annualAccountId: UUID) =>
  invokeAnnualAccounts('renderPublication', organizationId, annualAccountId);

/** Haalt het gearchiveerde exemplaar op en zet het op schijf. */
export async function downloadAnnualAccountsPdf(
  organizationId: UUID,
  annualAccountId: UUID,
): Promise<AnnualAccountsPdfResult> {
  const result = await invokeAnnualAccounts('downloadPdf', organizationId, annualAccountId);
  saveToDisk(result);
  return result;
}

export async function downloadAnnualAccountsPublication(
  organizationId: UUID,
  annualAccountId: UUID,
): Promise<AnnualAccountsPdfResult> {
  const result = await invokeAnnualAccounts('downloadPublication', organizationId, annualAccountId);
  saveToDisk(result);
  return result;
}
