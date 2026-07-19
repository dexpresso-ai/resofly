import { Container, getContainer } from '@cloudflare/containers';

/**
 * ResoFly Office-server — host Collabora Online (CODE) in een Cloudflare Container en
 * proxy ál het browser- én WOPI-verkeer (inclusief de bewerk-WebSocket) ernaartoe.
 *
 * De canonieke documenten leven op Cloudflare R2; de media-api Worker is de WOPI-host.
 * Deze Worker is puur de voordeur van de render-engine.
 */

// ── Deployment-specifieke config — PAS DEZE AAN voor jouw omgeving ───────────
// De WOPI-host(s) die Collabora mag benaderen: de media-api Worker(s). Moeten exact matchen
// met de host in de WOPISrc die media-api genereert (MEDIA_PUBLIC_URL). We staan zowel
// productie als staging toe — elk als eigen aliasgroup.
const WOPI_HOST_PROD = 'https://resofly-media-api.gerjan.workers.dev';
const WOPI_HOST_STAGING = 'https://resofly-media-api-staging.gerjan.workers.dev';
// Welke origins de editor in een <iframe> mogen inbedden (de ResoFly-app).
const FRAME_ANCESTORS = 'https://app.resofly.nl https://staging.resofly.nl https://staging.resofly.com http://localhost:5173';

export class CollaboraContainer extends Container<Env> {
  // coolwsd: HTTP + WebSocket op 9980.
  defaultPort = 9980;
  // Collabora start in seconden op, maar een koude start is merkbaar. Houd de container
  // nog even warm na het laatste verzoek zodat een pauze tussen bewerkingen geen reboot
  // forceert. (Een actieve bewerksessie houdt 'm sowieso wakker via het WS-verkeer.)
  sleepAfter = '30m';
  // LET OP — jail/capabilities is de #1 deploy-onzekerheid (zie OFFICE_EDITING_SETUP.md §7.1).
  // CF Containers geven GEEN Linux-capabilities. `--o:mount_namespaces=false` is een POGING
  // om zonder namespaces te draaien; of stock Collabora capability-loos boot op CF is ONBEWEZEN.
  // Faalt de boot op de jail → probeer zónder deze flag (default-modus), of wijk uit naar Fly.io
  // (persistent volume + caps). Dit is exact wat op de eerste deploy getest moet worden.
  envVars = {
    aliasgroup1: WOPI_HOST_PROD,
    aliasgroup2: WOPI_HOST_STAGING,
    extra_params:
      '--o:ssl.enable=false --o:ssl.termination=true --o:mount_namespaces=false ' +
      `--o:net.frame_ancestors=${FRAME_ANCESTORS}`,
  };

  override onStart() {
    console.log('[office-server] Collabora container gestart');
  }
  override onError(error: unknown) {
    console.error('[office-server] container-fout', error);
  }
}

export interface Env {
  COLLABORA: DurableObjectNamespace<CollaboraContainer>;
}

// Route élk verzoek naar ÉÉN vaste instance. Een geopend document is in-memory vastgepind
// aan één coolwsd-proces, en de bijbehorende co-editing-WebSocket moet op diezelfde instance
// blijven — dus we load-balancen bewust NIET. (Later opschalen naar meerdere instances =
// routeren op document-id in plaats van een constante.)
const INSTANCE_ID = 'collabora-1';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Hardening: proxy Collabora's admin-console niet naar het internet — alleen editor-/WOPI-
    // verkeer. (We zetten geen admin-credentials, maar sluit het oppervlak expliciet af.)
    if (pathname.endsWith('/admin.html') || pathname.includes('adminws') || pathname.includes('/dist/admin')) {
      return new Response('Not found', { status: 404 });
    }

    const response = await getContainer(env.COLLABORA, INSTANCE_ID).fetch(request);

    // WebSocket-upgrades ongemoeid doorlaten (co-editing rijdt hierop).
    if (response.status === 101) return response;

    // Collabora's eigen frame-ancestors-parameter is onbetrouwbaar bij meerdere origins
    // (extra_params splitst op spaties, dus alleen de eerste origin overleeft). Deze Worker
    // is de voordeur, dus wíj zetten hier de definitieve inbed-policy.
    const headers = new Headers(response.headers);
    headers.delete('X-Frame-Options');
    const csp = headers.get('Content-Security-Policy');
    if (csp && /frame-ancestors/i.test(csp)) {
      headers.set('Content-Security-Policy', csp.replace(/frame-ancestors[^;]*/i, `frame-ancestors ${FRAME_ANCESTORS}`));
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
