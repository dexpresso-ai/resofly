/**
 * Welke documenten (offertes, facturen) een klant in het portaal ziet.
 *
 * Een document met een eigen klant hoort alleen bij die klant. Eerder telde
 * het project ook mee als het document voor een ándere klant was: werd een
 * project van klant A naar klant B verplaatst (een gewone projectwijziging, ook
 * zonder rechten op Financiën), dan zag B de offertes en facturen van A, kon hij
 * die betalen en de offerte van A accepteren. Het project telt alleen nog voor
 * een document zonder klant.
 *
 * Puur: geen database, geen Deno. Getest in portalAccess.test.ts.
 */

export type PortalDocumentDecision = 'allow' | 'deny' | 'check_project';

export function portalDocumentDecision(
  entity: { client_id: string | null | undefined; project_id: string | null | undefined },
  clientIds: ReadonlySet<string>,
): PortalDocumentDecision {
  if (entity.client_id) return clientIds.has(entity.client_id) ? 'allow' : 'deny';
  return entity.project_id ? 'check_project' : 'deny';
}

/**
 * PostgREST-filter voor de lijsten in het portaal: de eigen documenten, plus
 * documenten zónder klant op een project van deze klant. UUID's bevatten geen
 * tekens die de or-filter breken; iets anders weigeren we.
 */
export function portalDocumentScopeFilter(clientId: string, projectIds: ReadonlyArray<string>): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(clientId)) throw new Error('Ongeldige klant.');
  const ids = projectIds.filter((id) => uuid.test(id));
  if (ids.length === 0) return null;
  return `client_id.eq.${clientId},and(client_id.is.null,project_id.in.(${ids.join(',')}))`;
}
