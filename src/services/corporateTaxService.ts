import { supabase, supabaseAuth } from '../lib/supabase';
import type { CorporateTaxComputation, CorporateTaxInputs, CorporateTaxReturn, UUID } from '../types';

type FunctionResponse<T> = { ok?: boolean; error?: string } & T;

type CorporateTaxResult = {
  inputs: CorporateTaxInputs;
  computation: CorporateTaxComputation;
  taxReturn?: CorporateTaxReturn;
};

/**
 * De Vpb-berekening loopt via een edge function, want het rekenhart
 * (_shared/vpb.ts) draait daar. De database rekent de uitkomst daarna zelf na
 * tegen de tarieftabel voordat er iets in het grootboek belandt.
 */
async function invokeCorporateTax(
  action: 'inputs' | 'save' | 'finalize',
  organizationId: UUID,
  fiscalYearId: UUID,
  note?: string | null,
): Promise<CorporateTaxResult> {
  const { data: sessionData, error: sessionError } = await supabaseAuth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.access_token) throw new Error('Je bent niet ingelogd.');

  const { data, error } = await supabase.functions.invoke<FunctionResponse<CorporateTaxResult>>('corporate-tax', {
    body: { action, organizationId, fiscalYearId, note: note ?? null },
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  });
  if (error) {
    // Bij een non-2xx geeft supabase-js een generieke fout; de Nederlandstalige
    // servermelding (bijvoorbeeld de tariefcontrole) zit in de response-body.
    const body = await extractErrorMessage(error);
    throw new Error(body || (error instanceof Error ? error.message : 'Vpb-berekening mislukt.'));
  }
  if (!data) throw new Error('Geen antwoord van de Vpb-functie ontvangen.');
  if (data.error) throw new Error(data.error);
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

/** Doorrekenen zonder op te slaan — het scherm toont eerst wat eruit komt. */
export const previewCorporateTax = (organizationId: UUID, fiscalYearId: UUID) =>
  invokeCorporateTax('inputs', organizationId, fiscalYearId);

/** Als concept vastleggen; er wordt nog niets geboekt. */
export const saveCorporateTax = (organizationId: UUID, fiscalYearId: UUID, note?: string | null) =>
  invokeCorporateTax('save', organizationId, fiscalYearId, note);

/** Vaststellen: legt vast én boekt de reservering op 9900 / 1540. */
export const finalizeCorporateTax = (organizationId: UUID, fiscalYearId: UUID, note?: string | null) =>
  invokeCorporateTax('finalize', organizationId, fiscalYearId, note);
