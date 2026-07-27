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

/**
 * Client-voorkeuren die we vóór het laden aan de editor meegeven (zie patchUiDefaults).
 *
 * `smartZoom=false` → Writer-documenten openen op 100% i.p.v. "paginabreedte passend"
 * (Collabora's smart zoom, die op een breed scherm al snel op 150-180% uitkomt). Collabora
 * leest deze voorkeur als `window.prefs.get('smartZoom')`; staat die op "false", dan zet de
 * editor bij het laden de zoom op zijn standaardniveau — precies 100%. Zelf zoomen blijft
 * gewoon werken (Beeld > Paginabreedte / 100%), en een handmatig gekozen zoom blijft bij
 * verkleinen/vergroten van het venster staan.
 */
const UI_DEFAULT_OVERRIDES: Record<string, string> = {
  smartZoom: 'false',
};

/**
 * Zet UI_DEFAULT_OVERRIDES in de `data-ui-defaults` van cool.html.
 *
 * Waarom hier en niet via de `?ui_defaults=`-parameter op de editor-URL (media-api): coolwsd
 * filtert die parameter op een eigen allowlist (UIMode, TextRuler, TextSidebar, SavedUIState,
 * …). `smartZoom` zit daar niet in en wordt stilletjes weggegooid — geverifieerd tegen deze
 * versie (26.04): `?ui_defaults=smartZoom%3Dfalse` levert `data-ui-defaults="e30="` (= `{}`).
 * Deze Worker is de voordeur van de editor, dus zetten we de sleutel hier alsnog in dezelfde
 * base64-JSON die Collabora zelf uitleest.
 *
 * Bewust conservatief: bij een onbekend formaat (ander attribuut, geen geldige base64/JSON,
 * sleutel al gezet) laten we de HTML ongemoeid — de editor moet het altijd blijven doen.
 */
class UiDefaultsPatcher {
  element(el: Element): void {
    const raw = el.getAttribute('data-ui-defaults');
    if (raw === null) return;

    let parsed: Record<string, unknown>;
    try {
      const trimmed = raw.trim();
      parsed = trimmed ? (JSON.parse(atob(trimmed)) as Record<string, unknown>) : {};
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

    let changed = false;
    for (const [key, value] of Object.entries(UI_DEFAULT_OVERRIDES)) {
      // Een waarde die er al staat (bv. ooit wél via ui_defaults doorgelaten) wint: dan is het
      // een bewuste keuze van de aanroeper en niet onze vangnet-default.
      if (parsed[key] !== undefined) continue;
      parsed[key] = value;
      changed = true;
    }
    if (!changed) return;

    // atob/btoa werken hier byte-voor-byte, dus bestaande (UTF-8) waarden komen ongeschonden terug.
    el.setAttribute('data-ui-defaults', btoa(JSON.stringify(parsed)));
  }
}

export class CollaboraContainer extends Container<Env> {
  // coolwsd: HTTP + WebSocket op 9980.
  defaultPort = 9980;
  // Een koude start (placement + image + Collabora-boot) kost tientallen seconden tot ruim
  // een minuut — dé oorzaak van "openen is traag". Houd de container daarom een uur warm na
  // het laatste verzoek, zodat een pauze binnen de werkdag geen reboot forceert. De frontend
  // pingt bovendien /office/warmup zodra iemand een bestandenpagina opent, zodat de boot met
  // het navigeren overlapt. (Kostenknop: langer = minder koude starts, meer actieve uren.
  // Een actieve bewerksessie houdt 'm sowieso wakker via het WS-verkeer.)
  sleepAfter = '1h';
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

    // De editor-pagina krijgt onze client-voorkeuren mee (o.a. openen op 100%).
    if (response.ok && pathname.endsWith('/cool.html') && (headers.get('content-type') || '').includes('text/html')) {
      // De rewrite verandert de lengte van het antwoord; een meegekomen content-length zou liegen.
      headers.delete('content-length');
      return new HTMLRewriter()
        .on('#initial-variables', new UiDefaultsPatcher())
        .transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    }

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
