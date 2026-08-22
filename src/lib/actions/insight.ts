import { updateSavedReport } from '../repository';
import { flag, patchOf, text, type ActionExecutor } from './types';
import type { ReportDefinition } from '../reporting';

/**
 * Uitvoerders voor de inzicht-handelingen.
 *
 * De rapportages zelf (winst en verlies, balans, proefbalans, grootboekkaart,
 * openstaande posten) zijn LEES-handelingen: die draaien op de server en komen hier
 * dus nooit langs. Wat overblijft is het beheer van een opgeslagen rapportage.
 */
export const INSIGHT_EXECUTORS: Record<string, ActionExecutor> = {
  'saved_report.update': async (payload, ctx) => {
    const reportId = text(payload, 'report_id');
    const patch = patchOf(payload) as Partial<{ name: string; definition: ReportDefinition }>;
    const saved = await updateSavedReport(ctx.organizationId, reportId, patch);
    return `Rapportage "${saved.name}" bijgewerkt`;
  },

  'saved_report.set_pinned': async (payload, ctx) => {
    const reportId = text(payload, 'report_id');
    const pinned = flag(payload, 'is_pinned');
    const saved = await updateSavedReport(ctx.organizationId, reportId, { is_pinned: pinned });
    return `Rapportage "${saved.name}" ${pinned ? 'staat nu op het startscherm' : 'staat niet meer op het startscherm'}`;
  },
};
