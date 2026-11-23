import { useCallback, useMemo } from 'react';
import { appendToContent } from './contentAppend';
import { contentTargetsFrom, type ContentTarget } from './notulen';
import type { AppData } from '../types';

/**
 * De twee props voor <MeetingRecorder> waarmee de notulen aan een bestaande
 * notitie of document kunnen worden toegevoegd. Eén plek voor de agenda en de
 * gesprekken, zodat ze niet uit elkaar lopen.
 *
 * Zonder schrijfrecht op de module Inhoud geeft dit niets terug, en dan toont
 * de recorder de knop niet. Dezelfde regel als in de rest van de app: wie een
 * module niet mag wijzigen, krijgt er ook geen knop voor.
 */
export function useContentAppend({ data, organizationId, canWriteContent, onChanged }: {
  data: Pick<AppData, 'notes' | 'documents' | 'clients'>;
  organizationId: string;
  canWriteContent: boolean;
  /** Ververst de werkruimte, zodat de lijst de nieuwe tekst ook toont. */
  onChanged?: () => void | Promise<void>;
}): { contentTargets?: ContentTarget[]; onAppendToContent?: (target: ContentTarget, html: string) => Promise<void> } {
  const contentTargets = useMemo(() => {
    if (!canWriteContent) return [];
    const clientNames = new Map(data.clients.map(client => [client.id, client.name]));
    return contentTargetsFrom(data.notes, data.documents, id => clientNames.get(id) ?? null);
  }, [canWriteContent, data.notes, data.documents, data.clients]);

  const onAppendToContent = useCallback(async (target: ContentTarget, html: string) => {
    await appendToContent(target, organizationId, html);
    await onChanged?.();
  }, [organizationId, onChanged]);

  return canWriteContent ? { contentTargets, onAppendToContent } : {};
}
