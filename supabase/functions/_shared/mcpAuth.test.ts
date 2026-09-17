import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationServerMetadata, createAuthCode, createToken, grantableScopes, isAcceptableRedirectUri, isJsonRpcRequest,
  isNotification, isValidCodeVerifier, parseToken, protectedResourceMetadata, redirectUriAllowed, scopeAllows,
  sha256Hex, verifyPkce, verifyToken, base64Url, randomBytes,
  signAuthRequest, verifyAuthRequest, AUTH_REQUEST_TTL_SECONDS, ISSUABLE_SCOPES, narrowScopes, type AuthRequest,
  openCorsHeaders,
} from './mcpAuth.ts';

/**
 * Bewaakt de rekensommen waar de MCP-koppeling op rust.
 *
 * Dit is het stuk waar een fout niet opvalt: een token dat óók zonder de juiste
 * verifier geaccepteerd wordt, een redirect-URI die "ongeveer" matcht, een PKCE-
 * controle die altijd true zegt — het werkt allemaal precies zo goed in het
 * dagelijks gebruik, en het verschil merk je pas als iemand het misbruikt.
 * Vandaar dat elke controle hier óók van de verkeerde kant wordt getest.
 */

// ── Tokens ───────────────────────────────────────────────────────────────────

test('een uitgegeven token is te splitsen en te verifiëren', async () => {
  const token = await createToken();
  const parsed = parseToken(token.plain);
  assert.ok(parsed, 'een net uitgegeven token hoort te splitsen');
  assert.equal(parsed.selector, token.selector);
  assert.equal(await verifyToken(parsed.verifier, token.salt, token.hash), true);
});

test('een token met de verkeerde verifier wordt geweigerd', async () => {
  const token = await createToken();
  const other = await createToken();
  assert.equal(await verifyToken(other.verifier, token.salt, token.hash), false);
});

test('dezelfde verifier onder een andere salt past niet', async () => {
  const token = await createToken();
  const otherSalt = base64Url(randomBytes(16));
  assert.equal(await verifyToken(token.verifier, otherSalt, token.hash), false);
});

test('twee tokens zijn nooit gelijk', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add((await createToken()).plain);
  assert.equal(seen.size, 50);
});

test('een misvormd token levert niets op', () => {
  for (const bad of ['', 'rsfmcp', 'rsfmcp.alleen-selector', 'anders.a.b', 'rsfmcp.a.b.c', 'rsfmcp..b', 'rsfmcp.a.', 'rsfmcp.a b.c', 'rsfmcp.a+b.c']) {
    assert.equal(parseToken(bad), null, `"${bad}" hoort geweigerd te worden`);
  }
});

test('een autorisatiecode heeft genoeg entropie en is uniek', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const code = createAuthCode();
    assert.ok(code.length >= 43, 'een code van 32 bytes hoort minstens 43 tekens te zijn');
    codes.add(code);
  }
  assert.equal(codes.size, 50);
});

test('dezelfde tekst geeft dezelfde hash, andere tekst niet', async () => {
  assert.equal(await sha256Hex('resofly'), await sha256Hex('resofly'));
  assert.notEqual(await sha256Hex('resofly'), await sha256Hex('resoflY'));
});

// ── PKCE ─────────────────────────────────────────────────────────────────────

/** Bouwt een geldig paar zoals een client dat doet: verifier → S256 → challenge. */
async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(randomBytes(32)); // 43 tekens, binnen het toegestane alfabet
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

test('een kloppend PKCE-paar wordt geaccepteerd', async () => {
  const { verifier, challenge } = await pkcePair();
  assert.equal(await verifyPkce(verifier, challenge), true);
});

test('een verifier die niet bij de challenge hoort wordt geweigerd', async () => {
  const a = await pkcePair();
  const b = await pkcePair();
  assert.equal(await verifyPkce(a.verifier, b.challenge), false);
});

test('de challenge onversleuteld meesturen werkt niet (geen plain-methode)', async () => {
  const { verifier } = await pkcePair();
  assert.equal(await verifyPkce(verifier, verifier), false);
});

test('een te korte verifier wordt geweigerd', async () => {
  const { challenge } = await pkcePair();
  assert.equal(isValidCodeVerifier('kort'), false);
  assert.equal(await verifyPkce('kort', challenge), false);
});

test('een verifier met tekens buiten het alfabet wordt geweigerd', () => {
  assert.equal(isValidCodeVerifier(`${'a'.repeat(42)}/`), false);
  assert.equal(isValidCodeVerifier('a'.repeat(43)), true);
  assert.equal(isValidCodeVerifier('a'.repeat(129)), false);
});

// ── Redirect-URI's ───────────────────────────────────────────────────────────

test('een redirect-URI moet exact overeenkomen', () => {
  const registered = ['https://claude.ai/api/mcp/auth_callback'];
  assert.equal(redirectUriAllowed(registered, 'https://claude.ai/api/mcp/auth_callback'), true);
  // Precies de trucs waar voorvoegsel-vergelijking op stukloopt:
  assert.equal(redirectUriAllowed(registered, 'https://claude.ai/api/mcp/auth_callback/../../evil'), false);
  assert.equal(redirectUriAllowed(registered, 'https://claude.ai/api/mcp/auth_callback?next=evil'), false);
  assert.equal(redirectUriAllowed(registered, 'https://claude.ai.evil.com/api/mcp/auth_callback'), false);
  assert.equal(redirectUriAllowed(registered, 'https://claude.ai/api/mcp/auth_callbackX'), false);
  assert.equal(redirectUriAllowed([], 'https://claude.ai/api/mcp/auth_callback'), false);
  assert.equal(redirectUriAllowed(registered, ''), false);
});

test('bij een loopback-adres mag alleen de poort verschillen', () => {
  // Claude Code en desktop-apps kiezen per koppeling een nieuwe vrije poort
  // (RFC 8252 §7.3). Registreerde hij gisteren 33418, dan moet vandaag 51234
  // ook kunnen — anders strandt hij op "ongeldig terugkeeradres".
  const registered = ['http://127.0.0.1:33418/callback'];
  assert.equal(redirectUriAllowed(registered, 'http://127.0.0.1:51234/callback'), true);
  assert.equal(redirectUriAllowed(['http://localhost/callback'], 'http://localhost:3118/callback'), true);
  assert.equal(redirectUriAllowed(['http://[::1]:1/callback'], 'http://[::1]:2/callback'), true);
  // Verder blijft het letterlijk: pad, query en host.
  assert.equal(redirectUriAllowed(registered, 'http://127.0.0.1:51234/callback/../evil'), false);
  assert.equal(redirectUriAllowed(registered, 'http://127.0.0.1:51234/callback?next=evil'), false);
  assert.equal(redirectUriAllowed(registered, 'http://localhost:51234/callback'), false);
  // Wat na de poort een ander domein van het adres maakt:
  assert.equal(redirectUriAllowed(registered, 'http://127.0.0.1:51234@evil.com/callback'), false);
  assert.equal(redirectUriAllowed(['http://localhost:1/callback'], 'http://localhost.evil.com:2/callback'), false);
  assert.equal(redirectUriAllowed(registered, 'http://127.0.0.1:99999/callback'), false);
  // En het geldt alleen voor loopback: elk ander adres houdt zijn poort.
  assert.equal(redirectUriAllowed(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai:8443/api/mcp/auth_callback'), false);
  assert.equal(redirectUriAllowed(['http://voorbeeld.nl:1/cb'], 'http://voorbeeld.nl:2/cb'), false);
});

test('alleen veilige redirect-URI-vormen mogen geregistreerd worden', () => {
  assert.equal(isAcceptableRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(isAcceptableRedirectUri('http://localhost:33418/callback'), true);
  assert.equal(isAcceptableRedirectUri('http://127.0.0.1:8080/cb'), true);
  assert.equal(isAcceptableRedirectUri('claude://oauth/callback'), true);
  // Onversleuteld naar buiten: dan reist de autorisatiecode open over het net.
  assert.equal(isAcceptableRedirectUri('http://voorbeeld.nl/callback'), false);
  assert.equal(isAcceptableRedirectUri('javascript:alert(1)'), false);
  assert.equal(isAcceptableRedirectUri('data:text/html,<script>'), false);
  assert.equal(isAcceptableRedirectUri('https://claude.ai/cb#fragment'), false);
  assert.equal(isAcceptableRedirectUri('geen-url'), false);
  assert.equal(isAcceptableRedirectUri(''), false);
});

// ── Scopes ───────────────────────────────────────────────────────────────────

test('vraagt de client niets, dan mag de gebruiker alles kiezen', () => {
  // Het normale geval: een AI-client kent onze scopes niet en vraagt er geen.
  // Dan is het plafond alles wat we kunnen uitgeven, en kiest de gebruiker.
  assert.deepEqual(grantableScopes(''), ['read', 'propose']);
  assert.deepEqual(grantableScopes(undefined), ['read', 'propose']);
});

test('noemt de client wél scopes, dan is dat het plafond', () => {
  assert.deepEqual(grantableScopes('read'), ['read']);
  assert.deepEqual(grantableScopes('read propose'), ['read', 'propose']);
  // Onzin valt weg; wat overblijft is het plafond.
  assert.deepEqual(grantableScopes('read verzonnen'), ['read']);
  // Alleen onzin = de client vroeg niets bruikbaars, dus het volle aanbod.
  assert.deepEqual(grantableScopes('admin alles'), ['read', 'propose']);
});

test('de keuze van de gebruiker kan nooit ruimer dan het aanbod', () => {
  // Dit is wat een aangepast formulier tegenhoudt: vroeg de client alleen
  // meelezen, dan levert "ik wil ook propose" nog steeds alleen meelezen op.
  assert.deepEqual(narrowScopes('read', 'read propose'), ['read']);
  assert.deepEqual(narrowScopes('read', 'propose'), ['read']);
  // Binnen het aanbod mag de gebruiker wel kiezen.
  assert.deepEqual(narrowScopes('read propose', 'read'), ['read']);
  assert.deepEqual(narrowScopes('read propose', 'read propose'), ['read', 'propose']);
});

test('een koppeling houdt altijd minstens leesrecht', () => {
  // Een koppeling zonder read is zinloos: de AI kan dan niets opzoeken en dus
  // ook niets zinnigs klaarzetten.
  assert.deepEqual(narrowScopes('read propose', ''), ['read']);
  assert.deepEqual(narrowScopes('read propose', 'propose'), ['read', 'propose']);
});

test('een grant laat alleen toe wat erin staat', () => {
  assert.equal(scopeAllows('read', 'read'), true);
  assert.equal(scopeAllows('read', 'propose'), false);
  assert.equal(scopeAllows('read propose', 'propose'), true);
  assert.equal(scopeAllows('', 'read'), false);
});

// ── Discovery ────────────────────────────────────────────────────────────────

const URLS = {
  issuer: 'https://voorbeeld.supabase.co/functions/v1/mcp-oauth',
  resource: 'https://voorbeeld.supabase.co/functions/v1/mcp',
};

test('de bron biedt klaarzetten aan, anders vraagt geen client erom', () => {
  // Claude vraagt precies de scopes_supported uit dit document als de 401 geen
  // scope noemt. Stond hier alleen `read`, dan kon niemand via zijn AI iets
  // klaarzetten, hoe het toestemmingsscherm ook stond.
  const prm = protectedResourceMetadata(URLS);
  assert.deepEqual(prm.scopes_supported, [...ISSUABLE_SCOPES]);
  assert.deepEqual(grantableScopes((prm.scopes_supported as string[]).join(' ')), ['read', 'propose']);
  // Claude vergelijkt `resource` letterlijk met de URL die de klant plakte.
  assert.equal(prm.resource, URLS.resource);
  assert.deepEqual(prm.authorization_servers, [URLS.issuer]);
});

test('offline_access staat in het aanbod maar wordt nooit een recht', () => {
  const meta = authorizationServerMetadata(URLS);
  assert.ok((meta.scopes_supported as string[]).includes('offline_access'));
  assert.deepEqual(grantableScopes('read propose offline_access'), ['read', 'propose']);
  assert.deepEqual(grantableScopes('read offline_access'), ['read']);
});

test('de OpenID-vorm heeft de velden zonder welke de MCP-SDK hem afkeurt', () => {
  // Op supabase.co is …/mcp-oauth/.well-known/openid-configuration het enige
  // discovery-adres dat een client bereikt. De officiële SDK leest dat als
  // OpenID-document en stopt het koppelen als deze velden ontbreken.
  const oidc = authorizationServerMetadata(URLS, { openIdVariant: true });
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    assert.equal(typeof oidc[field], 'string', `${field} hoort er te staan`);
  }
  for (const field of ['response_types_supported', 'subject_types_supported', 'id_token_signing_alg_values_supported']) {
    assert.ok(Array.isArray(oidc[field]), `${field} hoort een lijst te zijn`);
  }
  assert.equal(oidc.registration_endpoint, `${URLS.issuer}/register`);
  assert.deepEqual(oidc.code_challenge_methods_supported, ['S256']);
  // Geen ID-tokens: niemand kan erom vragen.
  assert.equal((oidc.scopes_supported as string[]).includes('openid'), false);
});

test('de RFC 8414-vorm belooft geen OpenID', () => {
  const meta = authorizationServerMetadata(URLS);
  assert.equal(meta.jwks_uri, undefined);
  assert.equal(meta.id_token_signing_alg_values_supported, undefined);
  assert.equal(meta.token_endpoint, `${URLS.issuer}/token`);
  assert.equal(meta.service_documentation, undefined);
});

// ── Het autorisatieverzoek onderweg ──────────────────────────────────────────

const SECRET = 'test-geheim-voor-de-handtekening';

function freshRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  const now = Math.floor(Date.now() / 1000);
  return {
    clientId: 'mcp_abc123',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: 'a'.repeat(43),
    scope: 'read',
    state: 'client-state-xyz',
    resource: 'https://proj.supabase.co/functions/v1/mcp',
    iat: now,
    exp: now + AUTH_REQUEST_TTL_SECONDS,
    ...overrides,
  };
}

test('een ondertekend autorisatieverzoek komt er ongeschonden uit', async () => {
  const request = freshRequest();
  const signed = await signAuthRequest(request, SECRET);
  assert.deepEqual(await verifyAuthRequest(signed, SECRET), request);
});

test('een ander geheim maakt het verzoek ongeldig', async () => {
  const signed = await signAuthRequest(freshRequest(), SECRET);
  await assert.rejects(() => verifyAuthRequest(signed, 'een-ander-geheim'), /handtekening/i);
});

test('de inhoud aanpassen breekt de handtekening', async () => {
  // Precies de aanval waar dit tegen beschermt: de gebruiker draait onderweg de
  // redirect-URI om naar een adres van hemzelf en vangt zo de code op.
  const signed = await signAuthRequest(freshRequest(), SECRET);
  const [, signature] = signed.split('.');
  const gesjoemeld = { ...freshRequest(), redirectUri: 'https://kwaadaardig.nl/cb' };
  const payload = Buffer.from(JSON.stringify(gesjoemeld)).toString('base64url');
  await assert.rejects(() => verifyAuthRequest(`${payload}.${signature}`, SECRET), /handtekening/i);
});

test('een verlopen verzoek wordt geweigerd', async () => {
  const now = Math.floor(Date.now() / 1000);
  const signed = await signAuthRequest(freshRequest({ iat: now - 3600, exp: now - 60 }), SECRET);
  await assert.rejects(() => verifyAuthRequest(signed, SECRET), /verlopen/i);
});

test('een verzoek dat te lang geldig is wordt geweigerd', async () => {
  const now = Math.floor(Date.now() / 1000);
  const signed = await signAuthRequest(freshRequest({ iat: now, exp: now + 365 * 24 * 3600 }), SECRET);
  await assert.rejects(() => verifyAuthRequest(signed, SECRET), /te lang geldig/i);
});

test('een misvormd verzoek wordt geweigerd', async () => {
  for (const bad of ['', 'geen-punt', 'a.b.c', `${'x'.repeat(5000)}.y`]) {
    await assert.rejects(() => verifyAuthRequest(bad, SECRET));
  }
});

test('een verzoek zonder client of redirect-URI wordt geweigerd', async () => {
  const zonderClient = await signAuthRequest(freshRequest({ clientId: '' }), SECRET);
  await assert.rejects(() => verifyAuthRequest(zonderClient, SECRET), /client/i);
  const zonderRedirect = await signAuthRequest(freshRequest({ redirectUri: '' }), SECRET);
  await assert.rejects(() => verifyAuthRequest(zonderRedirect, SECRET), /redirect/i);
});

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

test('alleen een geldig JSON-RPC-verzoek komt erdoor', () => {
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'tools/list' }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1 }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: '' }), false);
  assert.equal(isJsonRpcRequest(null), false);
  assert.equal(isJsonRpcRequest('tools/list'), false);
});

test('een bericht zonder id is een notificatie en krijgt geen antwoord', () => {
  assert.equal(isNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }), true);
  assert.equal(isNotification({ jsonrpc: '2.0', id: null, method: 'x' }), true);
  assert.equal(isNotification({ jsonrpc: '2.0', id: 0, method: 'x' }), false);
  assert.equal(isNotification({ jsonrpc: '2.0', id: 'abc', method: 'x' }), false);
});

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// Dit is de controle die we niet hadden toen het misging. Een ontbrekende header
// in dit lijstje ziet er in de code onschuldig uit en is in een curl niet te
// merken — curl kent geen preflight. In een browser is het het verschil tussen
// een werkend toestemmingsscherm en "Failed to fetch": bij een niet-toegestane
// header verstuurt de browser het echte verzoek nooit, dus er komt geen status
// en geen foutmelding terug waar het scherm iets mee kan.

/** Zoals een browser het leest: kleine letters, gesplitst op komma's. */
function allowedHeaders(headers: Record<string, string>): string[] {
  return headers['Access-Control-Allow-Headers'].split(',').map(h => h.trim().toLowerCase());
}

test('de open paden staan alle headers toe die de app en een AI-client meesturen', () => {
  const allowed = allowedHeaders(openCorsHeaders());
  // apikey en x-client-info stuurt supabase-js ongevraagd mee; zonder die twee
  // is elk pad hier voor de browser dicht. Dit is de regressie zelf.
  for (const header of ['authorization', 'x-client-info', 'apikey', 'content-type', 'mcp-protocol-version']) {
    assert.ok(allowed.includes(header), `${header} hoort toegestaan te zijn op de open paden`);
  }
});

test('de open paden laten een browser er met GET, POST en OPTIONS langs', () => {
  const headers = openCorsHeaders();
  const methods = headers['Access-Control-Allow-Methods'].split(',').map(m => m.trim().toUpperCase());
  // /consent is een GET, /token en /register zijn POST, en de preflight zelf
  // is OPTIONS. Valt er één weg, dan valt precies dat pad stil.
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    assert.ok(methods.includes(method), `${method} hoort toegestaan te zijn`);
  }
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
});

test('de MCP-server mag zijn eigen headers erbij zetten zonder de rest kwijt te raken', () => {
  const headers = openCorsHeaders('mcp-session-id', 'WWW-Authenticate, mcp-session-id');
  const allowed = allowedHeaders(headers);
  assert.ok(allowed.includes('mcp-session-id'), 'de eigen header hoort erbij te komen');
  assert.ok(allowed.includes('apikey'), 'en de gedeelde lijst blijft staan');
  assert.ok(allowed.includes('authorization'));
  // Zonder WWW-Authenticate kan een MCP-client uit een 401 niet opmaken wélke
  // autorisatieserver hij moet hebben, en begint het koppelen niet eens.
  assert.equal(headers['Access-Control-Expose-Headers'], 'WWW-Authenticate, mcp-session-id');
});

test('zonder extra headers blijft Expose-Headers weg', () => {
  assert.equal('Access-Control-Expose-Headers' in openCorsHeaders(), false);
});
