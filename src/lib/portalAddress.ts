// Het eigen inlogadres van het klantportaal (/portal/<sleutel>), zoals de app
// het toont: bij Instellingen → Huisstijl en bij een klant. Op dat adres staat
// het inlogscherm meteen in de huisstijl van de organisatie; zie
// supabase/functions/_shared/portalAddress.ts voor de mails.

import { useEffect, useState } from 'react';
import { fetchPortalLoginKey } from './repository';
import { portalLoginPath } from './portalLoginKey';

export { portalLoginPath };

/** Per organisatie één keer opgehaald; een sleutel verandert niet. */
const known = new Map<string, string>();

export function portalLoginUrl(key: string | null | undefined): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}${portalLoginPath(key)}`;
}

/**
 * De sleutel van het inlogadres. `ready` is false zolang hij onderweg is; is
 * hij er daarna niet (geen rechten op Klanten, of de migratie moet nog), dan
 * `key: null` en toont de app het algemene adres /portal. Alleen een gevonden
 * sleutel wordt onthouden, zodat een later bezoek het opnieuw probeert.
 */
export function usePortalLoginKey(organizationId: string | null | undefined): { key: string | null; ready: boolean } {
  const cached = organizationId ? known.get(organizationId) ?? null : null;
  const [state, setState] = useState<{ org: string | null; key: string | null; ready: boolean }>(() => ({
    org: organizationId ?? null,
    key: cached,
    ready: !organizationId || cached !== null,
  }));
  useEffect(() => {
    if (!organizationId) { setState({ org: null, key: null, ready: true }); return; }
    const hit = known.get(organizationId);
    if (hit) { setState({ org: organizationId, key: hit, ready: true }); return; }
    let alive = true;
    setState({ org: organizationId, key: null, ready: false });
    fetchPortalLoginKey(organizationId)
      .catch(() => null)
      .then(key => {
        if (key) known.set(organizationId, key);
        if (alive) setState({ org: organizationId, key, ready: true });
      });
    return () => { alive = false; };
  }, [organizationId]);
  // Net van organisatie gewisseld: niet heel even het adres van de vorige tonen.
  if (state.org !== (organizationId ?? null)) return { key: cached, ready: !organizationId || cached !== null };
  return { key: state.key, ready: state.ready };
}
