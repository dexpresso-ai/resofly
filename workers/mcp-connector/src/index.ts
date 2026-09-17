// ResoFly MCP-connector (Cloudflare Worker) — het nette adres vóór de connector.
//
// Een klant plakt `https://connector.resofly.com` in zijn AI-app. Daarachter
// zitten twee Supabase edge functions: `mcp-oauth` (koppelen) en `mcp` (praten).
// Deze Worker is de voordeur die beide op één hostnaam zet.
//
// WAAROM DIT MEER IS DAN COSMETIEK. De discovery van OAuth hangt aan de vorm van
// de issuer-URL. Bij een issuer MÉT pad — zoals …/functions/v1/mcp-oauth — zoekt
// een client het metadata-document eerst op de root van het domein
// (/.well-known/oauth-authorization-server/functions/v1/mcp-oauth). Die root is
// op supabase.co niet van ons; Supabase antwoordt daar met een 401, en het
// koppelen strandde daar ooit op. Op een eigen hostnaam staat de issuer op de
// ROOT, en dan vindt elke client het document bij de eerste poging, precies
// zoals RFC 8414 het bedoelt. De omweg langs de OpenID-vorm blijft bestaan voor
// wie hem nodig heeft, maar niemand hoeft er nog langs.
//
// GEEN DOORGEEFLUIK. Deze Worker stuurt niet "alles door wat binnenkomt": hij
// kent een vaste lijst paden en geeft op al het andere een 404. Dat is met opzet.
// Een proxy die het binnenkomende pad achter een basis-URL plakt, is één `..`
// verwijderd van een open deur naar élke andere edge function van dit project —
// en die functies gaan over facturen en bankkoppelingen. Hier wordt nooit iets
// van buiten aan een URL geplakt; een bekend pad wijst een bekend doel aan.

export interface Env {
  /** Het Supabase-project waar de twee functies draaien, zonder slash aan het eind. */
  SUPABASE_URL: string;
}

/**
 * Welk pad naar welke functie gaat.
 *
 * De sleutel is het pad op ONZE hostnaam, de waarde het pad op Supabase. Beide
 * staan hier voluit: zo is in één oogopslag te zien wat er open staat, en er is
 * geen plek waar een pad van buiten in een URL terechtkomt.
 *
 * `/` is de MCP-server zelf (JSON-RPC over POST). De twee well-known-documenten
 * staan op dezelfde root maar op verschillende paden, dus issuer en resource
 * kunnen allebei `https://connector.resofly.com` zijn zonder elkaar in de weg te
 * zitten. De oauth-eindpunten zijn precies die uit het metadata-document.
 */
const ROUTES: Record<string, string> = {
  '/': '/functions/v1/mcp',
  '/.well-known/oauth-protected-resource': '/functions/v1/mcp/.well-known/oauth-protected-resource',

  '/.well-known/oauth-authorization-server': '/functions/v1/mcp-oauth/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration': '/functions/v1/mcp-oauth/.well-known/openid-configuration',
  '/authorize': '/functions/v1/mcp-oauth/authorize',
  '/token': '/functions/v1/mcp-oauth/token',
  '/register': '/functions/v1/mcp-oauth/register',
  '/revoke': '/functions/v1/mcp-oauth/revoke',
  '/jwks': '/functions/v1/mcp-oauth/jwks',
  '/consent': '/functions/v1/mcp-oauth/consent',
  '/approve': '/functions/v1/mcp-oauth/approve',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Eén slash aan het eind mag; `/token/` en `/token` zijn voor een client
    // hetzelfde adres en het scheelt een onnavolgbare 404.
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const target = ROUTES[path];
    if (!target) {
      return new Response(
        JSON.stringify({
          error: 'not_found',
          error_description: 'Dit pad bestaat niet op de ResoFly-connector.',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      );
    }

    const upstream = new URL(env.SUPABASE_URL.replace(/\/+$/, '') + target);
    upstream.search = url.search;

    // redirect: 'manual' is hier geen detail maar de kern van het koppelen.
    // /authorize antwoordt met een 302 naar het toestemmingsscherm in de app.
    // Zou deze Worker die redirect zelf volgen (de standaard), dan haalde hij
    // die pagina op en gaf hem terug als antwoord op connector.resofly.com — de
    // gebruiker blijft dan op het verkeerde adres staan, zonder sessie en zonder
    // koppelverzoek. De 302 hoort ongeopend bij de browser aan te komen.
    return fetch(new Request(upstream, req), { redirect: 'manual' });
  },
} satisfies ExportedHandler<Env>;
