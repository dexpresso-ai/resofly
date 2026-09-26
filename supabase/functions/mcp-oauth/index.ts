// ============================================================
// mcp-oauth — de autorisatieserver voor de MCP-connector.
//
// Wat hier gebeurt: een klant koppelt zijn eigen AI (Claude, ChatGPT) aan zijn
// ResoFly-werkruimte. Die AI is een programma van buiten; hij krijgt geen
// Supabase-sessie maar een eigen token, dat hangt aan één goedgekeurde
// koppeling — één gebruiker, in één organisatie.
//
// De route die een koppeling aflegt:
//
//   1. /register    De AI-client meldt zich aan en krijgt een client_id.
//   2. /authorize   Hij stuurt de gebruiker naar ons; wij controleren zijn
//                   gegevens en sturen de browser door naar het
//                   toestemmingsscherm in de app.
//   3. /consent     Dat scherm vraagt hier op wie er eigenlijk toestemming
//                   vraagt, zodat de gebruiker weet waar hij ja tegen zegt.
//   4. /approve     De gebruiker geeft akkoord (ingelogd, met een gekozen
//                   organisatie). Wij maken de koppeling en een code.
//   5. /token       De client ruilt die code in voor tokens — en bewijst met
//                   PKCE dat hij dezelfde is die stap 2 begon.
//   6. /revoke      Een token inleveren.
//
// WAT DEZE SERVER NIET DOET: rechten uitdelen. Het token verwijst naar een
// gebruiker en een organisatie, en bij elke aanroep gelden de rol en de
// modulerechten van dát teamlid. De connector is een tweede deur naar wat
// iemand toch al mocht, nooit een deur naar meer.
//
// Waarom verify_jwt = false: /register, /authorize en /token worden aangeroepen
// door de AI-client, die geen Supabase-token heeft. Elk van die paden heeft zijn
// eigen bewijs (een geregistreerde client, een ondertekend verzoek, PKCE).
// /approve is de uitzondering: dat is het enige pad dat iets vastlegt namens een
// mens, en dat eist wél een geldige sessie én een toegestane origin.
// ============================================================

import {
  createAdminClient, HttpError, makeCors, parseAllowedOrigins, requiredEnv,
  requireOrganizationAccess, requireUser, getModuleLevel, isUuid,
} from '../_shared/edgeAuth.ts';
import {
  AUTH_REQUEST_TTL_SECONDS, authorizationServerMetadata, createAuthCode, createToken, grantableScopes, narrowScopes,
  isAcceptableRedirectUri, isValidCodeChallenge, parseToken, protectedResourceMetadata, redirectUriAllowed,
  sha256Hex, signAuthRequest, verifyAuthRequest, verifyPkce, verifyToken,
  base64Url, randomBytes, openCorsHeaders, parseScopes, CONSENT_SCOPES, SCOPE_EXECUTE, SCOPE_READ,
  describeRedirectTarget, isKnownAiRedirect,
  type AuthRequest, type McpDiscoveryUrls,
} from '../_shared/mcpAuth.ts';

const admin = createAdminClient();
const STATE_SECRET = requiredEnv('MCP_STATE_SECRET');
const APP_PUBLIC_URL = (Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/$/, '');

/**
 * Waar deze autorisatieserver publiek te bereiken is. Standaard de functie zelf;
 * met MCP_PUBLIC_BASE_URL te verleggen naar een eigen domein zonder codewijziging
 * (zie MCP_CONNECTOR_SETUP.md — dat maakt de discovery-URL's netter).
 */
const ISSUER = (Deno.env.get('MCP_PUBLIC_BASE_URL') || `${requiredEnv('SUPABASE_URL')}/functions/v1/mcp-oauth`).replace(/\/$/, '');
const RESOURCE_URL = (Deno.env.get('MCP_RESOURCE_URL') || `${requiredEnv('SUPABASE_URL')}/functions/v1/mcp`).replace(/\/$/, '');
const DISCOVERY: McpDiscoveryUrls = {
  issuer: ISSUER,
  resource: RESOURCE_URL,
  documentation: APP_PUBLIC_URL ? `${APP_PUBLIC_URL}/mcp` : undefined,
};

// Kort genoeg dat een gelekt token snel waardeloos is, lang genoeg dat een
// gesprek met de AI niet halverwege omvalt.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 10 * 60;
/** Hoeveel koppelingen één gebruiker tegelijk open mag hebben staan. */
const MAX_ACTIVE_GRANTS_PER_USER = 20;

// /approve komt uit ONZE app en hoort dus de gewone origin-controle te volgen.
const cors = makeCors(
  parseAllowedOrigins([Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'), Deno.env.get('INVOICE_ALLOWED_ORIGINS')]),
  (Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true',
);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = subPath(url.pathname);

  try {
    // De client-gerichte paden staan open voor elke origin: ze worden door een
    // AI-client aangeroepen, niet door een webpagina van ons, en ze beschermen
    // zichzelf met PKCE en een geregistreerde redirect-URI.
    if (req.method === 'OPTIONS') {
      return at(path, 'approve')
        ? new Response('ok', { headers: cors.headers(req) })
        : new Response('ok', { headers: openCorsHeaders() });
    }

    // Discovery: hiermee vindt een AI-client zelf uit hoe hij moet koppelen. Het
    // waarom van de twee vormen staat bij authorizationServerMetadata.
    if (req.method === 'GET' && at(path, '.well-known/oauth-authorization-server')) {
      return openJson(authorizationServerMetadata(DISCOVERY));
    }
    if (req.method === 'GET' && at(path, '.well-known/openid-configuration')) {
      return openJson(authorizationServerMetadata(DISCOVERY, { openIdVariant: true }));
    }
    if (req.method === 'GET' && at(path, '.well-known/oauth-protected-resource')) {
      return openJson(protectedResourceMetadata(DISCOVERY));
    }
    // Hoort bij de OpenID-vorm: een lege sleutelset, want we ondertekenen niets.
    if (req.method === 'GET' && at(path, 'jwks')) return openJson({ keys: [] });
    if (req.method === 'POST' && at(path, 'register')) return await handleRegister(req);
    if (req.method === 'GET' && at(path, 'authorize')) return await handleAuthorize(url);
    if (req.method === 'GET' && at(path, 'consent')) return await handleConsent(url);
    if (req.method === 'POST' && at(path, 'approve')) return await handleApprove(req);
    if (req.method === 'POST' && at(path, 'token')) return await handleToken(req);
    if (req.method === 'POST' && at(path, 'revoke')) return await handleRevoke(req);

    return openJson({ error: 'not_found', error_description: 'Dit pad bestaat niet op de autorisatieserver.' }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Onbekende fout.';
    // OAuth-fouten hebben een vaste vorm; de app-paden krijgen onze eigen.
    if (at(path, 'approve')) return cors.json(req, { error: message }, status);
    return openJson({ error: status === 500 ? 'server_error' : 'invalid_request', error_description: message }, status);
  }
});

// ── 1. Registratie van een AI-client (RFC 7591) ──────────────────────────────
//
// Dit staat open, en dat moet ook: Claude.ai en ChatGPT registreren zichzelf op
// het moment dat een klant de connector toevoegt, zonder dat wij hen kennen.
// Een registratie is geen toegang — het is een naamplaatje. Toegang ontstaat pas
// als een ingelogd mens op /approve akkoord geeft.
async function handleRegister(req: Request): Promise<Response> {
  const body = await readJson(req);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map((u: unknown) => String(u)) : [];

  if (redirectUris.length === 0) {
    return openJson({ error: 'invalid_redirect_uri', error_description: 'Geef minstens één redirect_uri op.' }, 400);
  }
  if (redirectUris.length > 10) {
    return openJson({ error: 'invalid_redirect_uri', error_description: 'Maximaal tien redirect-URIs per client.' }, 400);
  }
  for (const uri of redirectUris) {
    if (!isAcceptableRedirectUri(uri)) {
      return openJson({
        error: 'invalid_redirect_uri',
        error_description: `"${uri}" kan niet: gebruik https, een lokale poort (http://localhost) of een eigen app-schema.`,
      }, 400);
    }
  }
  // Wij geven geen client_secret uit. Een AI-client draait bij de klant op de
  // computer of in een browser; een geheim dat daar staat is geen geheim. PKCE
  // doet het werk dat een secret hier niet kan doen.
  const method = String(body.token_endpoint_auth_method || 'none');
  if (method !== 'none') {
    return openJson({
      error: 'invalid_client_metadata',
      error_description: 'Deze server werkt alleen met publieke clients (token_endpoint_auth_method: "none") en verplicht PKCE.',
    }, 400);
  }

  const clientId = `mcp_${base64Url(randomBytes(18))}`;
  const { error } = await admin.from('mcp_clients').insert({
    client_id: clientId,
    client_name: String(body.client_name || 'Onbekende AI-client').slice(0, 200),
    redirect_uris: redirectUris,
    logo_uri: optionalUrl(body.logo_uri),
    client_uri: optionalUrl(body.client_uri),
    software_id: body.software_id ? String(body.software_id).slice(0, 200) : null,
  });
  if (error) throw new HttpError(`Registreren mislukt: ${error.message}`, 500);

  return openJson({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201);
}

// ── 2. De gebruiker komt langs ───────────────────────────────────────────────
//
// Hier geldt één regel boven alle andere: pas als client_id én redirect_uri
// allebei kloppen, mogen we ergens naartoe sturen. Klopt er iets niet aan dat
// paar, dan tonen we de fout hier en volgen we de redirect NIET — anders is deze
// server een doorgeefluik naar elke plek die iemand in de URL zet.
/**
 * Maximale lengte van `state`. Het ondertekende autorisatieverzoek mag 4096
 * tekens zijn; hier blijft ruimte over voor de client-id, de redirect-uri, de
 * scopes en de resource, plus de base64-opslag daarvan.
 */
const MAX_STATE_LENGTH = 2048;

async function handleAuthorize(url: URL): Promise<Response> {
  const clientId = url.searchParams.get('client_id') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || '';

  const client = clientId ? await loadClient(clientId) : null;
  if (!client) return errorPage('Onbekende AI-client', 'Deze client is niet bij ResoFly geregistreerd. Voeg de connector opnieuw toe in je AI-app.');
  if (!redirectUriAllowed(client.redirect_uris, redirectUri)) {
    return errorPage('Ongeldig terugkeeradres', 'Het adres waar deze AI-client naartoe wil, staat niet in zijn registratie. Om je gegevens te beschermen sturen we je daar niet heen.');
  }

  // Vanaf hier is de redirect-URI vertrouwd, dus mogen fouten mee terug — dat is
  // wat de client verwacht en waar hij een nette melding van kan maken.
  const state = url.searchParams.get('state') || '';
  const fail = (code: string, description: string) => redirectBack(redirectUri, { error: code, error_description: description, state });

  // Het ondertekende verzoek mag bij het terugkomen hooguit 4096 tekens zijn
  // (AUTH_REQUEST_MAX_LENGTH in mcpAuth.ts). `state` gaat er ongewijzigd in, en
  // sommige zakelijke OAuth-clients stoppen daar kilobytes in. Zonder deze
  // grens kwam zo'n client pas vast te zitten op het toestemmingsscherm, met
  // "Het autorisatieverzoek heeft een ongeldige lengte" — een doodlopende weg
  // met een melding die naar niets wijst dat de gebruiker kan oplossen.
  // Nu weigeren we het meteen, langs de weg waarop de client zijn eigen fout
  // ziet. De `state` gaat mee terug, ook al is hij te lang: de client heeft hem
  // nodig om dit antwoord aan zijn verzoek te koppelen.
  if (state.length > MAX_STATE_LENGTH) {
    return fail('invalid_request', `De state-waarde is te lang (maximaal ${MAX_STATE_LENGTH} tekens).`);
  }

  if ((url.searchParams.get('response_type') || '') !== 'code') {
    return fail('unsupported_response_type', 'Alleen response_type=code wordt ondersteund.');
  }
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const method = url.searchParams.get('code_challenge_method') || '';
  if (!codeChallenge) return fail('invalid_request', 'PKCE is verplicht: stuur een code_challenge mee.');
  if (method !== 'S256') return fail('invalid_request', 'Alleen code_challenge_method=S256 wordt ondersteund.');
  if (!isValidCodeChallenge(codeChallenge)) return fail('invalid_request', 'De code_challenge heeft niet de juiste vorm.');

  if (!APP_PUBLIC_URL) throw new HttpError('APP_PUBLIC_URL ontbreekt in de Edge Function secrets.', 500);

  const now = Math.floor(Date.now() / 1000);
  const request: AuthRequest = {
    clientId,
    redirectUri,
    codeChallenge,
    scope: grantableScopes(url.searchParams.get('scope')).join(' '),
    state,
    resource: url.searchParams.get('resource') || '',
    iat: now,
    exp: now + AUTH_REQUEST_TTL_SECONDS,
  };
  const signed = await signAuthRequest(request, STATE_SECRET);

  // Door naar het toestemmingsscherm in de app. Daar logt de gebruiker zo nodig
  // in, kiest hij de organisatie, en ziet hij wat hij weggeeft.
  return Response.redirect(`${APP_PUBLIC_URL}/mcp/authorize?request=${encodeURIComponent(signed)}`, 302);
}

// ── 3. Wie vraagt hier toestemming? ──────────────────────────────────────────
//
// Het toestemmingsscherm moet de naam van de AI-client kunnen tonen. Die staat
// in ons pakketje, maar dat is ondertekend en niet leesbaar voor de browser —
// dus vraagt het scherm hem hier op. Er komt niets uit dat niet toch al in de
// URL van de gebruiker stond.
async function handleConsent(url: URL): Promise<Response> {
  const request = await verifyAuthRequest(url.searchParams.get('request') || '', STATE_SECRET)
    .catch((error) => { throw new HttpError(error instanceof Error ? error.message : 'Ongeldig verzoek.', 400); });
  const client = await loadClient(request.clientId);
  if (!client) throw new HttpError('Deze AI-client is niet meer geregistreerd.', 404);

  return openJson({
    client_name: client.client_name,
    client_uri: client.client_uri,
    logo_uri: client.logo_uri,
    // De naam hierboven kiest de client zelf; dit is waar de code na "Koppelen"
    // écht heen gaat. Het scherm toont het, en waarschuwt bij een onbekende dienst.
    redirect_host: describeRedirectTarget(request.redirectUri),
    verified: isKnownAiRedirect(request.redirectUri),
    // Wat deze client ten HOOGSTE kan krijgen. Het scherm laat de gebruiker
    // daarbinnen kiezen; ruimer wordt het bij /approve alsnog teruggeknipt.
    scope: request.scope,
    may_propose: request.scope.includes('propose'),
    // Niet om hier te kiezen — rechtstreeks uitvoeren staat alleen onder
    // Instellingen → AI — maar zodat het scherm weet of het die zin mag tonen.
    // Een client die uitdrukkelijk alleen `read` vroeg, krijgt hem nooit.
    may_enable_execute: request.scope.includes(SCOPE_EXECUTE),
    expires_at: new Date(request.exp * 1000).toISOString(),
  });
}

// ── 4. Akkoord ───────────────────────────────────────────────────────────────
//
// Het enige pad dat namens een mens iets vastlegt, en dus het enige met een
// echte sessiecontrole. Drie dingen moeten kloppen voordat er een koppeling
// ontstaat: de gebruiker is ingelogd, hij is actief lid van de organisatie die
// hij koos, en hij mag de module Gerrie. Dat laatste is de plek waar een
// organisatie de connector voor een teamlid dicht kan houden.
async function handleApprove(req: Request): Promise<Response> {
  cors.assert(req);
  const body = await readJson(req);

  const request = await verifyAuthRequest(String(body.request || ''), STATE_SECRET)
    .catch((error) => { throw new HttpError(error instanceof Error ? error.message : 'Ongeldig verzoek.', 400); });

  const user = await requireUser(admin, req);
  const organizationId = String(body.organizationId || '');
  if (!isUuid(organizationId)) throw new HttpError('Kies een organisatie.', 400);
  await requireOrganizationAccess(admin, user.id, organizationId);

  // Wie Gerrie niet mag, koppelt ook zijn eigen AI niet: dat zou dezelfde
  // gegevens langs een andere deur alsnog naar buiten brengen.
  if (await getModuleLevel(admin, user.id, organizationId, 'gerrie') === 'none') {
    throw new HttpError('Je hebt in deze organisatie geen toegang tot Gerrie, dus je kunt hier ook geen AI aan koppelen.', 403);
  }

  const client = await loadClient(request.clientId);
  if (!client) throw new HttpError('Deze AI-client is niet meer geregistreerd.', 404);
  // Dubbele controle: het pakketje is ondertekend, maar de registratie kan sinds
  // stap 2 zijn veranderd. De redirect-URI van zo meteen moet nú geldig zijn.
  if (!redirectUriAllowed(client.redirect_uris, request.redirectUri)) {
    throw new HttpError('Het terugkeeradres van deze client klopt niet meer.', 400);
  }

  // Weigeren mag ook — dan gaat de client netjes met een foutmelding terug in
  // plaats van te blijven wachten op iets wat nooit komt.
  if (body.decision === 'deny') {
    return cors.json(req, { redirect: redirectUrl(request.redirectUri, { error: 'access_denied', error_description: 'De gebruiker heeft de koppeling geweigerd.', state: request.state }) });
  }

  // De gebruiker kiest binnen wat de client vroeg. narrowScopes knipt terug op
  // het ONDERTEKENDE aanbod, dus een aangepast formulier levert nooit meer op
  // dan er in stap 2 is vastgelegd.
  //
  // Ontbreekt het veld, dan wordt het alleen meelezen. Dat is de veilige kant om
  // op te vallen: een koppeling die per ongeluk te weinig mag, merkt de
  // gebruiker meteen en lost hij op door opnieuw te koppelen — een koppeling die
  // per ongeluk te veel mag, merkt niemand.
  //
  // En wat het formulier ook meestuurt, hier valt alleen te kiezen tussen
  // meelezen en klaarzetten. `execute` hoort bij een knop in de instellingen van
  // de gebruiker, niet bij een scherm dat hij bereikt door in zijn AI-app op
  // Connect te klikken — dus wordt het er hier eerst uitgeknipt, vóór het
  // plafond. Koppelt iemand opnieuw, dan begint die keuze dus weer bij uit.
  const chosen = parseScopes(body.scope ?? SCOPE_READ).filter((s) => (CONSENT_SCOPES as readonly string[]).includes(s));
  const scope = narrowScopes(request.scope, chosen).join(' ');
  const grantId = await upsertGrant(user.id, organizationId, { ...request, scope }, String(body.label || client.client_name), request.scope);

  const code = createAuthCode();
  const { error } = await admin.from('mcp_auth_codes').insert({
    code_hash: await sha256Hex(code),
    grant_id: grantId,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: request.redirectUri,
    resource: request.resource || null,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw new HttpError(`Autorisatiecode opslaan mislukt: ${error.message}`, 500);

  return cors.json(req, { redirect: redirectUrl(request.redirectUri, { code, state: request.state }) });
}

/**
 * Koppelt dezelfde gebruiker dezelfde AI nog eens aan dezelfde organisatie, dan
 * hergebruiken we de bestaande rij. Anders staat er na drie keer opnieuw
 * koppelen een lijstje van drie identieke regels waarvan hij er twee niet meer
 * herkent — en dat is precies de lijst waarin hij later iets moet intrekken.
 */
async function upsertGrant(
  userId: string, organizationId: string, request: AuthRequest, label: string, ceiling: string,
): Promise<string> {
  const { data: existing, error: findError } = await admin.from('mcp_grants')
    .select('id').eq('user_id', userId).eq('organization_id', organizationId)
    .eq('client_id', request.clientId).is('revoked_at', null).limit(1);
  if (findError) throw new HttpError(`Koppeling opzoeken mislukt: ${findError.message}`, 500);

  if (existing?.[0]?.id) {
    const id = String(existing[0].id);
    // Het plafond gaat mee: de gebruiker kan straks onder Instellingen → AI
    // alleen aanzetten wat deze client bij dit verzoek ook aanbood.
    await admin.from('mcp_grants')
      .update({ scope: request.scope, scope_ceiling: ceiling, label: label.slice(0, 120) }).eq('id', id);
    return id;
  }

  const { count, error: countError } = await admin.from('mcp_grants')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).is('revoked_at', null);
  if (countError) throw new HttpError(`Koppelingen tellen mislukt: ${countError.message}`, 500);
  if ((count ?? 0) >= MAX_ACTIVE_GRANTS_PER_USER) {
    throw new HttpError(`Je hebt al ${MAX_ACTIVE_GRANTS_PER_USER} AI-koppelingen openstaan. Trek er eerst een in.`, 429);
  }

  const { data, error } = await admin.from('mcp_grants').insert({
    organization_id: organizationId,
    user_id: userId,
    client_id: request.clientId,
    scope: request.scope,
    scope_ceiling: ceiling,
    label: label.slice(0, 120),
  }).select('id').single();
  if (error) throw new HttpError(`Koppeling vastleggen mislukt: ${error.message}`, 500);
  return String(data.id);
}

// ── 5. Code inruilen voor tokens ─────────────────────────────────────────────
async function handleToken(req: Request): Promise<Response> {
  const form = await readForm(req);
  const grantType = String(form.get('grant_type') || '');
  if (grantType === 'authorization_code') return await exchangeCode(form);
  if (grantType === 'refresh_token') return await refresh(form);
  return openJson({ error: 'unsupported_grant_type', error_description: 'Gebruik authorization_code of refresh_token.' }, 400);
}

async function exchangeCode(form: URLSearchParams): Promise<Response> {
  const code = String(form.get('code') || '');
  const codeVerifier = String(form.get('code_verifier') || '');
  const redirectUri = String(form.get('redirect_uri') || '');
  const clientId = String(form.get('client_id') || '');
  if (!code || !codeVerifier) return oauthError('invalid_request', 'code en code_verifier zijn allebei verplicht.');

  const { data, error } = await admin.from('mcp_auth_codes')
    .select('id, grant_id, code_challenge, redirect_uri, resource, expires_at, used_at')
    .eq('code_hash', await sha256Hex(code)).limit(1);
  if (error) throw new HttpError(`Code opzoeken mislukt: ${error.message}`, 500);
  const row = data?.[0];
  if (!row) return oauthError('invalid_grant', 'Deze autorisatiecode bestaat niet.');

  // Een code die al gebruikt is, betekent óf een herhaalde poging óf dat iemand
  // hem onderweg heeft opgevangen. We kunnen die twee niet onderscheiden, dus
  // gaan we uit van het ergste: alles wat uit deze code voortkwam gaat eruit.
  if (row.used_at) {
    await admin.from('mcp_tokens').update({ revoked_at: new Date().toISOString() })
      .eq('grant_id', row.grant_id).is('revoked_at', null);
    return oauthError('invalid_grant', 'Deze autorisatiecode is al gebruikt. Uit voorzorg zijn de tokens van deze koppeling ingetrokken; koppel opnieuw.');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) return oauthError('invalid_grant', 'Deze autorisatiecode is verlopen.');
  // De redirect-URI moet dezelfde zijn als bij /authorize (RFC 6749 §4.1.3).
  if (redirectUri && redirectUri !== row.redirect_uri) return oauthError('invalid_grant', 'De redirect_uri komt niet overeen met die van de autorisatie.');
  if (!await verifyPkce(codeVerifier, String(row.code_challenge))) return oauthError('invalid_grant', 'De PKCE-controle is mislukt.');

  const grant = await loadGrant(String(row.grant_id));
  if (!grant) return oauthError('invalid_grant', 'De koppeling bestaat niet meer.');
  // client_id is verplicht, ook voor een publieke client (OAuth 2.1 §4.1.3).
  // Stond deze controle op "alleen als hij hem meestuurt", dan sloeg een
  // verzoek dat het veld simpelweg wegliet de hele controle over.
  if (!clientId) return oauthError('invalid_client', 'client_id ontbreekt in dit tokenverzoek.');
  if (clientId !== grant.client_id) return oauthError('invalid_grant', 'Deze code hoort bij een andere client.');

  // RFC 8707: vraagt de client een resource, dan moet dat dezelfde zijn als bij
  // /authorize. De kolom werd tot nu toe alleen gevuld en nooit gelezen, terwijl
  // de migratie belooft dat een token voor server A niet bij server B werkt.
  const requestedResource = String(form.get('resource') || '');
  if (requestedResource && String(row.resource || '') && requestedResource !== String(row.resource)) {
    return oauthError('invalid_target', 'De gevraagde resource komt niet overeen met die van de autorisatie.');
  }

  // Eerst de code afstempelen, dan pas tokens uitgeven: valt er daarna iets om,
  // dan is het ergste dat de client opnieuw moet koppelen — niet dat er een code
  // blijft liggen die nog een tweede keer werkt.
  //
  // De `.select()` is hier het slot. Zonder die uitkomst te lezen was de
  // controle hierboven een check-dan-doe: twee gelijktijdige /token-verzoeken
  // met dezelfde code lazen allebei `used_at === null`, kwamen allebei hier, en
  // de UPDATE raakte er één — maar PostgREST geeft geen fout bij nul geraakte
  // rijen, dus kregen ze allebéí een geldig tokenpaar. Precies het geval waar
  // het afstempelen voor bedoeld was (een onderschepte code die geracet wordt)
  // glipte er zo doorheen.
  const { data: stamped, error: useError } = await admin.from('mcp_auth_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id).is('used_at', null)
    .select('id');
  if (useError) throw new HttpError(`Code afstempelen mislukt: ${useError.message}`, 500);
  if (!stamped || stamped.length === 0) {
    // Iemand anders was ons net voor met dezelfde code. Zelfde behandeling als
    // een al gebruikte code hierboven: uit voorzorg alles intrekken.
    await admin.from('mcp_tokens').update({ revoked_at: new Date().toISOString() })
      .eq('grant_id', row.grant_id).is('revoked_at', null);
    return oauthError('invalid_grant', 'Deze autorisatiecode is al gebruikt. Uit voorzorg zijn de tokens van deze koppeling ingetrokken; koppel opnieuw.');
  }

  return openJson({ ...await issueTokens(String(row.grant_id), grant.scope), resource: String(row.resource || RESOURCE_URL) });
}

async function refresh(form: URLSearchParams): Promise<Response> {
  const presented = String(form.get('refresh_token') || '');
  const parsed = parseToken(presented);
  if (!parsed) return oauthError('invalid_grant', 'Dit refresh token heeft niet de juiste vorm.');
  // Ook hier moet de client zeggen wie hij is. Zonder deze controle was een
  // refresh token dat uit de opslag van één AI-app lekte door iedereen in te
  // wisselen — en omdat verversen roteert, hield de vinder daarmee een sessie
  // eindeloos in leven zonder dat er in mcp_grants iets van te zien was.
  const clientId = String(form.get('client_id') || '');
  if (!clientId) return oauthError('invalid_client', 'client_id ontbreekt in dit tokenverzoek.');

  const { data, error } = await admin.from('mcp_tokens')
    .select('id, grant_id, kind, verifier_hash, salt, expires_at, revoked_at')
    .eq('selector', parsed.selector).limit(1);
  if (error) throw new HttpError(`Token opzoeken mislukt: ${error.message}`, 500);
  const row = data?.[0];
  if (!row || row.kind !== 'refresh') return oauthError('invalid_grant', 'Dit refresh token is niet bekend.');
  if (!await verifyToken(parsed.verifier, String(row.salt), String(row.verifier_hash))) {
    return oauthError('invalid_grant', 'Dit refresh token klopt niet.');
  }
  if (row.revoked_at) {
    // Een al gebruikt (geroteerd) refresh token dat later terugkomt, is het
    // klassieke teken van een gelekt token: iemand ververst met een kopie. Dan
    // gaat de hele koppeling op slot (alle tokens van deze grant), zodat ook de
    // tokens die inmiddels uit die kopie zijn gemaakt vervallen. Binnen een
    // minuut na roteren is het vrijwel altijd de client zelf die na een time-out
    // opnieuw probeert; dan alleen weigeren.
    const sinceRevokedMs = Date.now() - new Date(row.revoked_at).getTime();
    if (sinceRevokedMs > 60_000) {
      await admin.from('mcp_tokens').update({ revoked_at: new Date().toISOString() })
        .eq('grant_id', row.grant_id).is('revoked_at', null);
    }
    return oauthError('invalid_grant', 'Dit refresh token is al gebruikt of ingetrokken.');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) return oauthError('invalid_grant', 'Dit refresh token is verlopen.');

  const grant = await loadGrant(String(row.grant_id));
  if (!grant) return oauthError('invalid_grant', 'De koppeling bestaat niet meer.');
  if (clientId !== grant.client_id) return oauthError('invalid_grant', 'Dit refresh token hoort bij een andere client.');

  // Rotatie: het gebruikte refresh token gaat eruit en er komt een nieuw paar.
  // Zo is een token dat iemand ooit onderschepte na één keer verversen dood.
  // Voorwaardelijk op "nog niet ingetrokken": bij twee gelijktijdige verversingen
  // met hetzelfde token krijgt er maar één een nieuw paar.
  const { data: claimed, error: claimError } = await admin.from('mcp_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', row.id).is('revoked_at', null).select('id');
  if (claimError) throw new HttpError(`Token roteren mislukt: ${claimError.message}`, 500);
  if (!claimed?.length) return oauthError('invalid_grant', 'Dit refresh token is net al gebruikt.');
  return openJson(await issueTokens(String(row.grant_id), grant.scope));
}

async function issueTokens(grantId: string, scope: string): Promise<Record<string, unknown>> {
  const access = await createToken();
  const refreshToken = await createToken();
  const now = Date.now();

  const { error } = await admin.from('mcp_tokens').insert([
    {
      grant_id: grantId, kind: 'access', selector: access.selector, verifier_hash: access.hash,
      salt: access.salt, expires_at: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    },
    {
      grant_id: grantId, kind: 'refresh', selector: refreshToken.selector, verifier_hash: refreshToken.hash,
      salt: refreshToken.salt, expires_at: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    },
  ]);
  if (error) throw new HttpError(`Tokens uitgeven mislukt: ${error.message}`, 500);

  return {
    access_token: access.plain,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken.plain,
    scope,
  };
}

// ── 6. Token inleveren (RFC 7009) ────────────────────────────────────────────
//
// Geeft altijd 200, ook bij een token dat we niet kennen. Dat schrijft de
// standaard voor en het is verstandig: anders is dit endpoint een manier om te
// achterhalen welke tokens bestaan.
async function handleRevoke(req: Request): Promise<Response> {
  const form = await readForm(req);
  const parsed = parseToken(String(form.get('token') || ''));
  if (!parsed) return openJson({});

  const { data } = await admin.from('mcp_tokens')
    .select('id, grant_id, verifier_hash, salt').eq('selector', parsed.selector).limit(1);
  const row = data?.[0];
  if (row && await verifyToken(parsed.verifier, String(row.salt), String(row.verifier_hash))) {
    // Alles van deze koppeling, niet alleen het aangeboden token. Trok de
    // AI-app zijn refresh token in — wat ze doen als de gebruiker de connector
    // verwijdert — dan bleef het bijbehorende access token tot een uur lang
    // gewoon werken. De gebruiker dacht losgekoppeld te zijn en was dat niet.
    // RFC 7009 §2.1 vraagt hier ook om, en de intrekknop in de app doet het al
    // zo (mcp_revoke_grant_tokens).
    await admin.from('mcp_tokens').update({ revoked_at: new Date().toISOString() })
      .eq('grant_id', row.grant_id).is('revoked_at', null);
  }
  return openJson({});
}

// ── Gedeelde hulpjes ─────────────────────────────────────────────────────────

interface ClientRow { client_id: string; client_name: string; redirect_uris: string[]; logo_uri: string | null; client_uri: string | null }

async function loadClient(clientId: string): Promise<ClientRow | null> {
  const { data, error } = await admin.from('mcp_clients')
    .select('client_id, client_name, redirect_uris, logo_uri, client_uri').eq('client_id', clientId).limit(1);
  if (error) throw new HttpError(`Client opzoeken mislukt: ${error.message}`, 500);
  return (data?.[0] as ClientRow | undefined) ?? null;
}

async function loadGrant(grantId: string): Promise<{ client_id: string; scope: string } | null> {
  const { data, error } = await admin.from('mcp_grants')
    .select('client_id, scope, revoked_at').eq('id', grantId).limit(1);
  if (error) throw new HttpError(`Koppeling opzoeken mislukt: ${error.message}`, 500);
  const row = data?.[0] as { client_id: string; scope: string; revoked_at: string | null } | undefined;
  if (!row || row.revoked_at) return null;
  return { client_id: row.client_id, scope: row.scope };
}

/**
 * Welk eindpunt wordt hier aangeroepen?
 *
 * Rechtstreeks op Supabase komt een verzoek binnen als
 * `/functions/v1/mcp-oauth/token`. Zet iemand er een eigen domein voor
 * (MCP_PUBLIC_BASE_URL), dan is het `/oauth/token` of alleen `/token` — dat
 * hangt van zijn proxy af. Daarom knippen we het functievoorvoegsel eraf als
 * het er staat, en vergelijken we verderop op de staart van het pad. Zo werkt
 * dezelfde code in beide opstellingen.
 */
function subPath(pathname: string): string {
  const marker = '/mcp-oauth';
  const start = pathname.indexOf(marker);
  const rest = start === -1 ? pathname : pathname.slice(start + marker.length);
  return rest.replace(/\/+$/, '') || '/';
}

/** Eindigt het pad op dit eindpunt? Zie subPath voor het waarom. */
function at(path: string, endpoint: string): boolean {
  return path === `/${endpoint}` || path.endsWith(`/${endpoint}`);
}

function redirectUrl(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function redirectBack(redirectUri: string, params: Record<string, string>): Response {
  return Response.redirect(redirectUrl(redirectUri, params), 302);
}

function optionalUrl(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? text.slice(0, 500) : null;
  } catch {
    return null;
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Tokenverzoeken komen als formulier binnen (zo schrijft OAuth het voor), maar
 * niet elke client houdt zich daaraan. JSON accepteren we er stilletjes bij —
 * het kost drie regels en scheelt een klant een onverklaarbare foutmelding.
 */
async function readForm(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const body = await readJson(req);
    return new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v ?? '')]));
  }
  return new URLSearchParams(await req.text());
}

function openJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...openCorsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function oauthError(code: string, description: string): Response {
  return openJson({ error: code, error_description: description }, 400);
}

/**
 * Een fout die de gebruiker in zijn browser te zien krijgt, omdat we hem bewust
 * niet terugsturen naar de client. Simpele HTML: dit scherm is de uitzondering,
 * niet de regel, en het hoort ook te werken als de app plat ligt.
 */
function errorPage(title: string, message: string): Response {
  const escape = (text: string) => text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
  return new Response(
    `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escape(title)} — ResoFly</title></head>` +
    `<body style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2937">` +
    `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${escape(title)}</h1><p style="margin:0;color:#4b5563">${escape(message)}</p></body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}
