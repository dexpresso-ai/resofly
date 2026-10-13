import { discardTransfer, extendTransfer, prepareTransfer, revokeTransfer, sendTransfer, type TransferSource } from '../transfers-api';
import { optText, text, type ActionExecutor } from './types';

/**
 * Uitvoerders voor bestanden versturen. Ze gaan langs dezelfde edge function als
 * het verstuurvenster: klaarzetten (de bestanden worden gekopieerd), dan
 * versturen naar precies de ontvangers die op de kaart stonden — met hun adres
 * van dat moment, zodat een tussentijds gewijzigd adres niets ontvangt. Zie
 * `supabase/functions/_shared/actions/files.ts` voor wat de kaart belooft.
 */

function sourcesOf(payload: Record<string, unknown>): TransferSource[] {
  const raw = Array.isArray(payload.sources) ? payload.sources as Array<Record<string, unknown>> : [];
  const sources = raw
    .filter((entry) => entry && typeof entry.id === 'string' && ['attachment', 'note', 'document', 'folder'].includes(String(entry.type)))
    .map((entry) => ({ type: entry.type as TransferSource['type'], id: String(entry.id) }));
  if (sources.length === 0) throw new Error('Deze actie mist de bestanden.');
  return sources;
}

function recipientsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = Array.isArray(payload.recipients) ? payload.recipients as Array<Record<string, unknown>> : [];
  if (raw.length === 0) throw new Error('Deze actie mist de ontvangers.');
  return raw;
}

function expiryOf(payload: Record<string, unknown>): number | string {
  const value = payload.expires_at ?? payload.expires_in_days;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) return value;
  throw new Error('Deze actie mist de vervaldatum.');
}

export const FILES_EXECUTORS: Record<string, ActionExecutor> = {
  'files.send': async (payload, ctx) => {
    const sources = sourcesOf(payload);
    const recipients = recipientsOf(payload);
    const days = expiryOf(payload);
    const canDownload = payload.can_download !== false;
    const message = optText(payload, 'message');
    const { bundle, skipped } = await prepareTransfer(ctx.organizationId, {
      clientId: optText(payload, 'client_id'),
      origin: 'gerrie',
      sources,
      subject: optText(payload, 'subject') ?? undefined,
      expiresAt: days,
    });
    const transferId = bundle.transfer.id;
    if (bundle.items.length === 0) {
      await discardTransfer(ctx.organizationId, transferId).catch(() => undefined);
      const why = skipped.map((s) => `${s.name} (${s.reason})`).join('; ');
      throw new Error(`Er bleef niets over om te versturen${why ? `: ${why}` : ''}.`);
    }
    let results;
    try {
      ({ results } = await sendTransfer(ctx.organizationId, {
        transferId,
        subject: bundle.transfer.subject,
        message,
        expiresAt: days,
        canDownload,
        recipients,
      }));
    } catch (error) {
      // Niet verstuurd: dan ook geen half concept laten staan.
      await discardTransfer(ctx.organizationId, transferId).catch(() => undefined);
      throw error;
    }
    const reached = results.filter((r) => r.notified).map((r) => r.name || r.email).filter(Boolean);
    const failed = results.filter((r) => !r.notified);
    const parts = [
      `${bundle.items.length === 1 ? '1 bestand' : `${bundle.items.length} bestanden`} verstuurd${reached.length ? ` aan ${reached.join(', ')}` : ''}`,
    ];
    if (skipped.length) parts.push(`niet meegenomen: ${skipped.map((s) => s.name).join(', ')}`);
    if (failed.length) parts.push(`niet gelukt bij ${failed.map((r) => `${r.name || r.email || 'een ontvanger'} (${r.error || 'onbekende fout'})`).join(', ')}`);
    return parts.join('; ');
  },

  'files.extend_transfer': async (payload, ctx) => {
    await extendTransfer(ctx.organizationId, text(payload, 'transfer_id'), expiryOf(payload));
    return `Zending “${optText(payload, 'subject') ?? 'bestanden'}” loopt nu tot ${optText(payload, 'label') ?? 'de nieuwe datum'}`;
  },

  'files.revoke_transfer': async (payload, ctx) => {
    await revokeTransfer(ctx.organizationId, text(payload, 'transfer_id'));
    return `Zending “${optText(payload, 'subject') ?? 'bestanden'}” ingetrokken; de links werken niet meer en de bestanden zijn verwijderd`;
  },
};
