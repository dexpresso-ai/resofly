import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthCode, createToken, grantableScopes, isAcceptableRedirectUri, isJsonRpcRequest,
  isNotification, isValidCodeVerifier, parseToken, redirectUriAllowed, scopeAllows,
  sha256Hex, verifyPkce, verifyToken, base64Url, randomBytes,
  signAuthRequest, verifyAuthRequest, AUTH_REQUEST_TTL_SECONDS, narrowScopes, type AuthRequest,
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
