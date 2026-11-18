import { createForecast, deleteForecast, updateForecast } from '../repository';
import { optText, patchOf, text, type ActionExecutor } from './types';

/**
 * Uitvoerders voor de prognose (zie `supabase/functions/_shared/actions/forecast.ts`
 * voor wat de kaart belooft). Dezelfde repository-functies als de knoppen op de
 * pagina Prognose; de database schrijft er een versie bij, zodat je een
 * goedgekeurde wijziging terug kunt zetten.
 */

/** Alleen wat een prognose aan velden heeft; de rest van een payload schrijft hier niets. */
const UPDATABLE = ['name', 'notes', 'assumptions'] as const;

export const FORECAST_EXECUTORS: Record<string, ActionExecutor> = {
  'forecast.create': async (payload, ctx) => {
    const created = await createForecast(ctx.organizationId, {
      name: text(payload, 'name'),
      notes: optText(payload, 'notes'),
      assumptions: patchOf(payload, 'assumptions'),
      change_note: optText(payload, 'change_note'),
    });
    return `Prognose "${created.name}" aangemaakt`;
  },

  'forecast.update': async (payload, ctx) => {
    const raw = patchOf(payload);
    const patch: { name?: string; notes?: string | null; assumptions?: unknown; change_note?: string | null } = {};
    for (const key of UPDATABLE) if (key in raw) (patch as Record<string, unknown>)[key] = raw[key];
    patch.change_note = optText(payload, 'change_note');
    // De kaart beschrijft de stap vanaf deze versie; is de prognose intussen
    // gewijzigd, dan weigert de repository in plaats van die wijziging te overschrijven.
    const expected = typeof payload.expected_version === 'number' ? payload.expected_version : undefined;
    const saved = await updateForecast(ctx.organizationId, text(payload, 'forecast_id'), patch, expected);
    return `Prognose "${saved.name}" bijgewerkt`;
  },

  'forecast.delete': async (payload, ctx) => {
    await deleteForecast(ctx.organizationId, text(payload, 'forecast_id'));
    const name = optText(payload, 'forecast_name');
    return name ? `Prognose "${name}" verwijderd` : 'Prognose verwijderd';
  },
};
