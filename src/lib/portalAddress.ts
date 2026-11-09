// Het eigen inlogadres van het klantportaal (/portal/<sleutel>), zoals de app
// het toont: bij Instellingen → Huisstijl en bij een klant. Op dat adres staat
// het inlogscherm meteen in de huisstijl van de organisatie; zie
// supabase/functions/_shared/portalAddress.ts voor de mails.

import { useEffect, useState } from 'react';
import { fetchPortalLoginKey, type PortalLoginKeyResult } from './repository';
import { portalLoginPath } from './portalLoginKey';

export { portalLoginPath };

/** Per organisatie één keer opgehaald; een sleutel verandert niet. */
const known = new Map<string, string>();

/**
 * Op het klantadres (https://jansen.resofly.com/portal) is de sleutel
 * overbodig: het adres zegt al van wie het portaal is. Dezelfde regel als in
 * de mails (portalLinkBase in supabase/functions/_shared/clientLinks.ts).
 */
export function portalLoginUrl(key: string | null | undefined, address?: { baseUrl: string; onClientHost: boolean } | null): string {
  if (address?.onClientHost && address.baseUrl) return `${address.baseUrl}/portal`;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}${portalLoginPath(key)}`;
}

/**
 * De sleutel van het inlogadres. `ready` is false zolang hij onderweg is; is
 * hij er daarna niet, dan `key: null` met de reden in `unavailable` (geen
 * rechten op Klanten, de migratie moet nog, of iets anders), en toont de app
 * het algemene adres /portal. Alleen een gevonden sleutel wordt onthouden,
 * zodat een later bezoek het opnieuw probeert.
 */
export function usePortalLoginKey(organizationId: string | null | undefined): PortalLoginKeyResult & { ready: boolean } {
  const cached = organizationId ? known.get(organizationId) ?? null : null;
  const [state, setState] = useState<{ org: string | null; ready: boolean } & PortalLoginKeyResult>(() => ({
    org: organizationId ?? null,
    key: cached,
    unavailable: null,
    ready: !organizationId || cached !== null,
  }));
  useEffect(() => {
    if (!organizationId) { setState({ org: null, key: null, unavailable: null, ready: true }); return; }
    const hit = known.get(organizationId);
    if (hit) { setState({ org: organizationId, key: hit, unavailable: null, ready: true }); return; }
    let alive = true;
    setState({ org: organizationId, key: null, unavailable: null, ready: false });
    fetchPortalLoginKey(organizationId)
      .catch((): PortalLoginKeyResult => ({ key: null, unavailable: 'fout' }))
      .then(result => {
        if (result.key) known.set(organizationId, result.key);
        if (alive) setState({ org: organizationId, ...result, ready: true });
      });
    return () => { alive = false; };
  }, [organizationId]);
  // Net van organisatie gewisseld: niet heel even het adres van de vorige tonen.
  if (state.org !== (organizationId ?? null)) return { key: cached, unavailable: null, ready: !organizationId || cached !== null };
  return { key: state.key, unavailable: state.unavailable, ready: state.ready };
}
