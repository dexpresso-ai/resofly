// ============================================================
// Vennootschapsbelasting — de brug tussen het grootboek en het rekenhart.
//
// Waarom een edge function en niet gewoon in SQL: het rekenwerk staat in
// _shared/vpb.ts, een puur en unit-getest bestand (npm test). Dezelfde opzet als
// de debiteurenautomaat, die _shared/dunning.ts op dezelfde manier gebruikt.
//
// Deze functie doet drie dingen en verder niets:
//   'inputs'    — haalt op wat er te rekenen valt en rekent het door, zonder op
//                 te slaan. Voor het scherm: de gebruiker ziet eerst wat eruit
//                 komt voordat hij iets vastlegt.
//   'save'      — legt de berekening vast als concept.
//   'finalize'  — legt hem vast én boekt de reservering (9900 / 1540).
//
// De autorisatie ligt NIET hier maar in de database: save_corporate_tax_return
// controleert de module, de rechtsvorm, de rechten én rekent de belasting zelf
// na tegen de tarieftabel. Deze functie kan er dus niets doorheen duwen dat de
// database niet zelf goedkeurt — dat is bewust, want de berekening komt uit
// TypeScript en die draait uiteindelijk op een machine van de klant.
// ============================================================

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import {
  HttpError,
  createAdminClient,
  makeCors,
  parseAllowedOrigins,
  requireOrganizationAccess,
  requireUser,
  assertWriteRole,
} from '../_shared/edgeAuth.ts';
import { computeVpb, type LossCarryForward, type VpbCorrection, type VpbInput, type VpbYearRules } from '../_shared/vpb.ts';

const admin = createAdminClient();
const cors = makeCors(
  parseAllowedOrigins([Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'), Deno.env.get('APP_ALLOWED_ORIGINS')]),
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '1') === '1',
);

/** Precies de vorm die get_corporate_tax_inputs teruggeeft. */
type Inputs = {
  fiscalYear: { id: string; label: string; periodStart: string; periodEnd: string; status: string };
  rules: VpbYearRules;
  commercialResultCents: number;
  prepaidCents: number;
  corrections: Array<VpbCorrection & { id: string }>;
  lossesCarriedForward: Array<LossCarryForward & { establishedByAssessment: boolean }>;
};

async function loadInputs(organizationId: string, fiscalYearId: string): Promise<Inputs> {
  const { data, error } = await admin.rpc('get_corporate_tax_inputs', {
    p_organization_id: organizationId,
    p_fiscal_year_id: fiscalYearId,
  });
  if (error) throw new HttpError(error.message, 400);
  if (!data) throw new HttpError('Geen gegevens gevonden voor dit boekjaar.', 404);
  return data as Inputs;
}

function compute(inputs: Inputs) {
  const payload: VpbInput = {
    rules: inputs.rules,
    commercialResultCents: inputs.commercialResultCents,
    corrections: inputs.corrections.map(c => ({ code: c.code, label: c.label, amountCents: c.amountCents })),
    lossesCarriedForward: inputs.lossesCarriedForward.map(l => ({ year: l.year, remainingCents: l.remainingCents })),
    prepaidCents: inputs.prepaidCents,
  };
  return computeVpb(payload);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const fiscalYearId = String(body.fiscalYearId || '');
    if (!organizationId || !fiscalYearId) throw new HttpError('organizationId en fiscalYearId zijn verplicht.', 400);

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);

    const inputs = await loadInputs(organizationId, fiscalYearId);
    const computation = compute(inputs);

    if (action === 'inputs') {
      // Alleen doorrekenen en tonen. Lezen mag iedereen die in de organisatie zit;
      // de RPC heeft de modulecontrole al gedaan.
      return cors.json(req, { ok: true, inputs, computation });
    }

    if (action !== 'save' && action !== 'finalize') {
      throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
    assertWriteRole(role);

    const { data, error } = await admin.rpc('save_corporate_tax_return', {
      p_organization_id: organizationId,
      p_fiscal_year_id: fiscalYearId,
      p_computation: computation,
      p_finalize: action === 'finalize',
      p_note: body.note ?? null,
      p_created_by: user.id,
    });
    if (error) throw new HttpError(error.message, 400);

    return cors.json(req, {
      ok: true,
      inputs,
      computation,
      taxReturn: Array.isArray(data) ? data[0] : data,
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    return cors.json(req, { ok: false, error: message }, status);
  }
});
