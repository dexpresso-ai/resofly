import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { loadBranding, type Branding } from '../_shared/branding.ts';
import { isPortalLoginKey } from '../_shared/portalAddress.ts';
import { portalOriginOf, rememberClientOrigin } from '../_shared/clientLinks.ts';
import {
  PORTAL_TOKEN_DAYS, PORTAL_TOKEN_HEADER, bindFailureEndsSession, bindFailureMessage, bindFailureStatus, bindPortalSession,
  isPortalSecret, randomPortalCode, sessionIdFromToken,
} from '../_shared/portalSession.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { loadEmailBrand, NO_EMAIL_BRAND, withEmailBrand } from '../_shared/emailBrand.ts';
import { takeEmailQuota } from '../_shared/emailQuota.ts';
import { sanitizeTagValue, sendViaResend } from '../_shared/resend.ts';
import { renderPortalLoginEmail } from '../_shared/emailTemplates/portalLogin.ts';

// ============================================================
// ResoFly — Klantportaal login-provisioning (portal-login)
//
// Publiek eindpunt (verify_jwt = false): wordt aangeroepen VOORDAT de klant is
// ingelogd. Dit project heeft zelf-registratie uitgezet, dus een magische link
// voor een nog onbekend e-mailadres zou falen met "Signups not allowed".
//
// Deze function maakt daarom server-side (service-role) een auth-account aan,
// maar UITSLUITEND voor e-mailadressen die als klant bekend zijn (clients.email).
// Willekeurige e-mailadressen krijgen geen account en geen link.
//
// Sinds migratie 20261108230000 verstuurt deze functie de inlogmail zelf
// (requestLogin met een verifierHash): vanaf het verzenddomein van de
// leverancier, in het Nederlands. Eerst stuurde Supabase hem, met "Your Magic
// Link" en een link die alleen op het adres van ResoFly werkte. De mail bevat
// alleen een aanvraagnummer; het inlogtoken geeft redeemLogin pas aan de
// browser die met zijn eigen geheim bewijst dat hij de aanvraag deed. Zo werkt
// de link, net als met PKCE, alleen in die browser. De code in dezelfde mail
// is voor wie op een ander apparaat leest.
//
// Sinds migratie 20261109020000 kan het portaal op het eigen domein van een
// leverancier staan, en geldt een inlog op zijn adres alleen voor hem. De DNS
// van een eigen domein beheert de leverancier zelf: wat daar in de browser
// staat, kan hij uitlezen. Daarom:
//   - legt requestLogin het bereik vast: het adres waar de aanvraag vandaan
//     kwam, opgezocht in de database (een adres van die leverancier, met het
//     portaal aan), nooit tekst uit het verzoek zelf;
//   - gaat de link terug naar dat adres: daar staat het geheim van de
//     browser. Eerst ging de link naar het adres van de organisatie, ook als
//     de klant op het algemene portaal aanvroeg; dan werkte hij niet;
//   - op een eigen domein maakt Supabase Auth geen inlog. Een inlog bij
//     Supabase geldt voor het hele account; is de klant ook teamlid bij een
//     andere leverancier, dan opent hij diens werkruimte. Daar mailt deze
//     functie een code van ResoFly zelf, en geven redeemLogin en redeemCode
//     een sleutel die alleen het portaal van die leverancier opent, alleen op
//     dat domein (portal_tokens, kop x-portal-token);
//   - op de naam bij ResoFly en het algemene portaal legt bindSession de
//     verse inlog bij Supabase vast in portal_sessions. client-portal weigert
//     een inlog die daar niet staat (_shared/portalSession.ts).
// Een oude app zonder verifierHash kan niet meer inloggen: zijn inlog (via de
// link van Supabase) zou nergens vastliggen.
//
// Daarnaast `getBranding`: de huisstijl van het inlogscherm, voor wie het
// portaal opent via het eigen adres van een leverancier (/portal/<sleutel>,
// migratie 20261106080000). Alleen de huisstijl; nooit de organisatie zelf.
// ============================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
/** Het algemene adres van het portaal, voor wie (nog) geen klantadres heeft. */
const PORTAL_BASE_URL = (Deno.env.get('CLIENT_PORTAL_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/+$/, '');
/** Zo lang werkt een inlogmail. */
const LOGIN_REQUEST_MINUTES = 15;
/** Na zoveel verkeerde browsers is de link op. */
const LOGIN_REQUEST_MAX_ATTEMPTS = 5;

class PortalLoginError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

serve(async (req) => {
  // Van een klantadres (jansen.resofly.com, portaal.jansen.nl)? Eén keer
  // opzoeken; CORS en de controle of de link bij dat adres hoort, lezen het
  // daarna (_shared/clientLinks.ts).
  await rememberClientOrigin(supabaseAdmin, req);
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'requestLogin');
    if (action === 'getBranding') return json(req, { ok: true, branding: await brandingFor(req, body.key) });
    if (action === 'redeemLogin') return json(req, { ok: true, ...(await redeemLogin(req, body)) });
    if (action === 'bindSession') return json(req, { ok: true, ...(await bindSession(req, body)) });
    if (action === 'redeemCode') return json(req, { ok: true, ...(await redeemCode(req, body)) });
    if (action === 'endPortalToken') return json(req, { ok: true, ...(await endPortalToken(req)) });
    if (action !== 'requestLogin') throw new PortalLoginError(`Onbekende actie: ${action}`, 400);

    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new PortalLoginError('Vul een geldig e-mailadres in.', 400);
    // De hash van het geheim van deze browser (src/lib/portalLoginFlow.ts).
    // Zonder kan de inlog straks nergens vastliggen; een oude app laadt na
    // vernieuwen de nieuwe.
    const verifierHash = String(body.verifierHash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(verifierHash)) {
      throw new PortalLoginError('Vernieuw de pagina en probeer het opnieuw.', 400);
    }

    // Een rem (migratie 20261101080000): per afzender en per e-mailadres. Boven
    // de grens hetzelfde antwoord als altijd, maar zonder opzoeken en zonder
    // account: anders is dit een gratis accountfabriek, een mailbom en een
    // opzoekdienst voor "is dit iemands klant?".
    if (await portalLoginThrottled(req, email)) return json(req, { ok: true, known: true, flow: 'mail' });

    // Toegang is afgeleid uit clients.email: alleen bekende klanten krijgen een
    // account. Onbekende adressen worden NIET aangemaakt (geen open registratie,
    // geen enumeratie van geldige adressen via side effects).
    const { data: clients, error: lookupError } = await supabaseAdmin.rpc('portal_clients_for_email', { p_email: email });
    if (lookupError) throw lookupError;
    const organizations = [...new Set(((Array.isArray(clients) ? clients : []) as Array<{ organization_id?: string }>)
      .map((row) => String(row.organization_id ?? '')).filter(Boolean))];

    // Op het adres van een leverancier (zijn naam bij ResoFly, of zijn eigen
    // domein met het portaal aan) geldt de inlog alleen voor hem: dat is het
    // bereik. Op het algemene adres alles, ook met de sleutel van een
    // leverancier in het adres (/portal/<sleutel>): die kiest alleen bij wie
    // de klant bekend moet zijn, net als voorheen.
    const portalOrigin = portalOriginOf(req);
    const scope = portalOrigin?.organizationId ?? null;
    const filter = scope ?? (await keyOrganization(body.key));
    const known = filter ? organizations.includes(filter) : organizations.length > 0;

    if (known) {
      // De naam en de afzender in de mail: van het adres, of van de enige
      // leverancier van deze klant. Niet die van de sleutel als de klant er
      // meer heeft: dan geeft de inlog toegang tot allemaal, en hoort de mail
      // niet in de huisstijl van één van hen te staan. Zo'n mail zou een
      // leverancier ook kunnen laten versturen om een klant op zijn eigen
      // pagina een code te laten invullen voor het algemene portaal.
      const organizationId = scope ?? (organizations.length === 1 ? organizations[0] : null);
      // Op een eigen domein een code van ResoFly, geen token van Supabase.
      const login: LoginTarget = portalOrigin
        ? { scope, host: portalOrigin.host, base: `https://${portalOrigin.host}`, ownCode: portalOrigin.kind === 'custom' }
        : { scope: null, host: generalHost(req), base: PORTAL_BASE_URL, ownCode: false };
      // Na het antwoord: anders duurde het antwoord voor een bekend adres
      // merkbaar langer (account, inlogtoken, mail), en las je aan de tijd af
      // of iemand klant is. Een fout komt in de log, nooit in het antwoord.
      await afterResponse((async () => {
        await ensureAuthUser(email);
        await sendLoginMail(email, organizationId, login, verifierHash);
      })().catch((error) => console.error('portal-login: inlogmail versturen mislukt', describeError(error))));
    }
    // Het antwoord is voor elk adres hetzelfde: anders is deze functie een
    // opzoekdienst voor "is dit iemands klant?". Een onbekend adres krijgt
    // gewoon geen inloglink. `known: true` blijft staan voor oudere frontends.
    return json(req, { ok: true, known: true, flow: 'mail' });
  } catch (error) {
    const status = error instanceof PortalLoginError ? error.status : 500;
    // Details alleen in de log; een bezoeker zonder account krijgt geen interne foutteksten.
    const message = error instanceof PortalLoginError
      ? error.message
      : 'Inloggen kon niet worden voorbereid. Probeer het later opnieuw.';
    if (status >= 500) {
      console.error('portal-login error', describeError(error), error instanceof Error ? error.stack : undefined);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

/** Waar de inlog uit deze aanvraag voor geldt, en waar de link heen gaat. */
type LoginTarget = {
  /** Alleen deze organisatie, of alles (null: het algemene portaal). */
  scope: string | null;
  /** Het adres waar de klant aanvroeg (voor wie later wil nagaan wat er gebeurde). */
  host: string | null;
  /** Waar de link heen gaat: hetzelfde adres, want daar staat het geheim van de browser. */
  base: string;
  /** Een eigen domein: een code van ResoFly en straks een sleutel, geen inlog bij Supabase. */
  ownCode: boolean;
};

/**
 * Het algemene adres waar deze aanvraag vandaan kwam, als het een van de
 * toegestane adressen is (assertAllowedOrigin keurde het al). Alleen voor de
 * administratie: de link gaat naar PORTAL_BASE_URL.
 */
function generalHost(req: Request): string | null {
  const origin = req.headers.get('origin') || '';
  if (!origin || !allowedOrigins.includes(origin)) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/** De leverancier bij de sleutel van het eigen inlogadres (/portal/<sleutel>), of null. */
async function keyOrganization(rawKey: unknown): Promise<string | null> {
  if (!isPortalLoginKey(rawKey)) return null;
  const { data, error } = await supabaseAdmin.from('portal_login_addresses').select('organization_id').eq('key', rawKey).maybeSingle();
  if (error) return null;
  const organizationId = (data as { organization_id?: unknown } | null)?.organization_id;
  return typeof organizationId === 'string' && organizationId ? organizationId : null;
}

/**
 * Maakt een inlogtoken (Supabase verstuurt daarbij niets), bewaart het bij een
 * willekeurig aanvraagnummer, en mailt de link met dat nummer en de code.
 * `organizationId` kiest de naam en de afzender van de mail, `login` het bereik
 * en het adres van de link.
 */
async function sendLoginMail(email: string, organizationId: string | null, login: LoginTarget, verifierHash: string): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) throw new Error('RESEND_API_KEY of RESEND_FROM_EMAIL ontbreekt.');
  const base = login.base.replace(/\/+$/, '');
  if (!base) throw new Error('APP_PUBLIC_URL (of CLIENT_PORTAL_BASE_URL) ontbreekt: zonder kan de mail niet naar het portaal linken.');
  if (organizationId) {
    await takeEmailQuota(supabaseAdmin, organizationId, 1, (message, status) => new PortalLoginError(message, status));
  }

  const requestId = randomToken();
  const requestHash = await sha256Hex(requestId);
  let tokenHash: string | null = null;
  let codeHash: string | null = null;
  let code: string | null;
  if (login.ownCode) {
    // Een eigen domein: Supabase Auth maakt geen token (en dus nooit een inlog
    // die de beheerder van dat domein kan uitlezen). De code is van ons.
    code = randomPortalCode();
    codeHash = await sha256Hex(`${requestHash}:${code}`);
  } else {
    const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
    if (linkError) throw linkError;
    tokenHash = String(link?.properties?.hashed_token ?? '') || null;
    code = String(link?.properties?.email_otp ?? '') || null;
    if (!tokenHash) throw new Error('Supabase gaf geen inlogtoken terug.');
    // Ook teamlid ergens (of uitgenodigd)? Dan alleen de link, zonder code:
    // die werkt alleen in de browser die hem aanvroeg. Een code kan elke
    // website vragen, en een inlog bij Supabase opent voor hem ook de
    // werkruimte. Lukt de vraag niet, dan ook geen code.
    const { data: hasWorkspace, error: workspaceError } = await supabaseAdmin.rpc('portal_email_has_workspace', { p_email: email });
    if (workspaceError || hasWorkspace !== false) code = null;
  }

  // token_sent_at vult de database zelf (migratie 20261109020000).
  const { error: insertError } = await supabaseAdmin.from('portal_login_requests').insert({
    request_hash: requestHash,
    organization_id: organizationId,
    scope_organization_id: login.scope,
    host: login.host,
    email,
    token_hash: tokenHash,
    code_hash: codeHash,
    verifier_hash: verifierHash,
    expires_at: new Date(Date.now() + LOGIN_REQUEST_MINUTES * 60_000).toISOString(),
  });
  if (insertError) throw insertError;

  const loginUrl = `${base}/portal/inloggen?aanvraag=${encodeURIComponent(requestId)}`;
  const branding = organizationId ? await loadBranding(supabaseAdmin, organizationId) : null;
  const sender = organizationId
    ? await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO)
    : { from: RESEND_FROM_EMAIL, replyTo: RESEND_REPLY_TO || undefined };
  const brand = organizationId ? await loadEmailBrand(supabaseAdmin, organizationId) : NO_EMAIL_BRAND;
  const mail = renderPortalLoginEmail({
    supplierName: branding?.companyName ?? null,
    accentColor: branding?.accentColor ?? null,
    loginUrl,
    code,
    minutes: LOGIN_REQUEST_MINUTES,
  });
  await sendViaResend(RESEND_API_KEY, withEmailBrand({
    from: sender.from,
    to: [email],
    ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    tags: [
      { name: 'type', value: 'portal_login' },
      ...(organizationId ? [{ name: 'organization_id', value: sanitizeTagValue(organizationId) }] : []),
    ],
  }, brand), `portal-login-${requestHash.slice(0, 40)}`);
}

/**
 * De link uit de inlogmail inwisselen. De browser stuurt het aanvraagnummer
 * en zijn eigen geheimen mee (hooguit vijf: wie twee keer aanvroeg, heeft er
 * twee); past er één bij de aanvraag, dan krijgt hij het inlogtoken en wisselt
 * hij dat zelf in bij Supabase. Op een eigen domein krijgt hij in plaats
 * daarvan de sleutel van het portaal. Eén keer te gebruiken, een kwartier
 * geldig.
 */
async function redeemLogin(req: Request, body: Record<string, unknown>) {
  const requestId = String(body.request ?? '');
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(requestId)) throw new PortalLoginError('Deze inloglink is ongeldig. Vraag een nieuwe aan.', 400);
  const verifiers = (Array.isArray(body.verifiers) ? body.verifiers : [])
    .filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(value))
    .slice(0, 5);

  // Een rem per afzender: het aanvraagnummer is niet te raden (32 bytes), maar
  // dit is geen plek om eindeloos te proberen.
  if (await throttleHit(await sha256Hex(`portal-redeem:ip:${senderAddress(req)}`), 600, 30, 900) > 0) {
    throw new PortalLoginError('Te veel pogingen. Wacht een kwartier en probeer het opnieuw.', 429);
  }

  const { data, error } = await supabaseAdmin.from('portal_login_requests')
    .select('id,organization_id,scope_organization_id,host,email,token_hash,verifier_hash,attempts,expires_at,used_at')
    .eq('request_hash', await sha256Hex(requestId))
    .maybeSingle();
  if (error) throw error;
  const row = data as LoginRequestRow | null;
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new PortalLoginError('Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.', 410);
  }
  // Aangevraagd op een ander adres (een andere leverancier, of het algemene
  // portaal): alsof hij niet bestaat. De link gaat altijd naar het adres van
  // de aanvraag, dus een gewone klik komt hier niet. Een token van Supabase
  // nooit op een eigen domein, een sleutel alleen op het domein van de aanvraag.
  const origin = portalOriginOf(req);
  const onCustomDomain = origin?.kind === 'custom';
  if ((row.scope_organization_id ?? null) !== (origin?.organizationId ?? null)
    || (row.token_hash ? onCustomDomain : !onCustomDomain || origin?.host !== row.host)) {
    throw new PortalLoginError('Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.', 410);
  }

  const hashes = await Promise.all(verifiers.map((value) => sha256Hex(value)));
  if (!hashes.some((hash) => timingSafeEqual(hash, row.verifier_hash))) {
    const attempts = (row.attempts ?? 0) + 1;
    await supabaseAdmin.from('portal_login_requests')
      .update({ attempts, ...(attempts >= LOGIN_REQUEST_MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) })
      .eq('id', row.id);
    throw new PortalLoginError('Deze inloglink hoort bij een andere browser. Open hem in de browser waarin je de link aanvroeg, of vul daar de code uit de mail in.', 403);
  }

  // Eén keer: wie tegelijk twee keer klikt, krijgt het token maar één keer.
  const { data: claimed, error: claimError } = await supabaseAdmin.from('portal_login_requests')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id).is('used_at', null)
    .select('id');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) throw new PortalLoginError('Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.', 410);

  const portalKey = row.organization_id ? await portalKeyFor(row.organization_id) : null;
  if (!row.token_hash) return { portalToken: await issuePortalToken(row), email: row.email, portalKey };
  return { tokenHash: row.token_hash, email: row.email, portalKey };
}

type LoginRequestRow = {
  id: string; organization_id: string | null; scope_organization_id: string | null; host: string | null; email: string;
  token_hash: string | null; verifier_hash: string; attempts: number; expires_at: string; used_at: string | null;
};

/**
 * De sleutel van het portaal op een eigen domein, na de link of de code uit de
 * mail. Alleen voor de organisatie en het domein van de aanvraag. De sleutel
 * zelf gaat één keer naar de browser; hier staat alleen de sha256.
 */
async function issuePortalToken(row: Pick<LoginRequestRow, 'email' | 'scope_organization_id' | 'host'>): Promise<string> {
  if (!row.scope_organization_id || !row.host) throw new Error('Een aanvraag met een code hoort bij een eigen domein.');
  const { data: userId, error: userError } = await supabaseAdmin.rpc('portal_user_id', { p_email: row.email });
  if (userError) throw userError;
  if (typeof userId !== 'string' || !userId) throw new Error('Geen account bij dit e-mailadres.');
  const token = randomToken();
  const { error } = await supabaseAdmin.from('portal_tokens').insert({
    token_hash: await sha256Hex(token),
    user_id: userId,
    organization_id: row.scope_organization_id,
    host: row.host,
    expires_at: new Date(Date.now() + PORTAL_TOKEN_DAYS * 86_400_000).toISOString(),
  });
  if (error) throw error;
  return token;
}

/**
 * De code uit de mail, op een eigen domein: voor wie de mail op een ander
 * apparaat leest. Alleen de nieuwste aanvraag met een code voor dit adres op
 * dit domein telt (zoals bij Supabase: een nieuwe aanvraag maakt de vorige
 * code ongeldig). Vijf keer mis en de aanvraag is op; elk antwoord op een
 * foute, verlopen of onbekende code is hetzelfde.
 */
async function redeemCode(req: Request, body: Record<string, unknown>) {
  const origin = portalOriginOf(req);
  if (origin?.kind !== 'custom') throw new PortalLoginError('Vul de code in op het adres waar je hem aanvroeg.', 400);
  if (await throttleHit(await sha256Hex(`portal-code:ip:${senderAddress(req)}`), 600, 30, 900) > 0) {
    throw new PortalLoginError('Te veel pogingen. Wacht een kwartier en probeer het opnieuw.', 429);
  }
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code ?? '').replace(/\D/g, '');
  const wrong = new PortalLoginError('Deze code klopt niet of is verlopen. Controleer de cijfers, of vraag een nieuwe inloglink aan.', 403);
  if (!isEmail(email) || !/^\d{8}$/.test(code)) throw wrong;

  // In één keer in de database, met de aanvraag vergrendeld: zo telt elke
  // poging, ook als er veel tegelijk komen (portal_code_redeem).
  const { data, error } = await supabaseAdmin.rpc('portal_code_redeem', {
    p_email: email, p_organization_id: origin.organizationId, p_host: origin.host, p_code: code,
  });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: unknown; email?: unknown; organizationId?: unknown; host?: unknown; brandOrganizationId?: unknown };
  if (result.ok !== true || typeof result.organizationId !== 'string' || typeof result.host !== 'string') throw wrong;
  const brand = typeof result.brandOrganizationId === 'string' ? result.brandOrganizationId : null;
  const portalToken = await issuePortalToken({
    email: String(result.email ?? email), scope_organization_id: result.organizationId, host: result.host,
  });
  return { portalToken, portalKey: brand ? await portalKeyFor(brand) : null };
}

/** Uitloggen op een eigen domein: de sleutel weg. Wie hem kent, mag dat. */
async function endPortalToken(req: Request) {
  const token = req.headers.get(PORTAL_TOKEN_HEADER) || '';
  if (isPortalSecret(token)) {
    const { error } = await supabaseAdmin.from('portal_tokens').delete().eq('token_hash', await sha256Hex(token));
    if (error) throw error;
  }
  return { ended: true };
}

/**
 * Een verse inlog vastleggen (migratie 20261109020000, portal_session_bind).
 * De browser wisselde de link of de code zelf in bij Supabase en stuurt het
 * nieuwe token (Authorization), zijn geheimen en, bij de link, het
 * aanvraagnummer. Pas daarna slaat de app de inlog op: tot dan staat hij
 * nergens, en laat client-portal hem niet toe.
 *
 * Lukt het niet, dan maken we de verse inlog ook bij Supabase ongeldig: hij
 * kan nergens meer voor dienen.
 */
async function bindSession(req: Request, body: Record<string, unknown>) {
  if (await throttleHit(await sha256Hex(`portal-bind:ip:${senderAddress(req)}`), 600, 30, 900) > 0) {
    throw new PortalLoginError('Te veel pogingen. Wacht een kwartier en probeer het opnieuw.', 429);
  }
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = token ? await supabaseAdmin.auth.getUser(token) : { data: { user: null }, error: null };
  const user = data?.user ?? null;
  const sessionId = user && !error ? sessionIdFromToken(token) : null;
  if (!user || !sessionId) throw new PortalLoginError('Inloggen is niet gelukt. Vraag een nieuwe code aan.', 401);

  // Een inlog bij Supabase hoort nooit op een eigen domein: daar is hij voor de
  // beheerder van dat domein uit te lezen. Komt er toch een, dan weg ermee.
  if (portalOriginOf(req)?.kind === 'custom') {
    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(token, 'local');
    if (signOutError) console.warn('portal-login: inlog op een eigen domein ongeldig maken mislukt', signOutError.message);
    throw new PortalLoginError('Op dit adres log je in met de code uit de mail.', 400);
  }

  const rawRequest = body.request;
  if (rawRequest !== undefined && rawRequest !== null && (typeof rawRequest !== 'string' || !/^[A-Za-z0-9_-]{30,100}$/.test(rawRequest))) {
    throw new PortalLoginError('Deze inloglink is ongeldig. Vraag een nieuwe aan.', 400);
  }
  const verifiers = (Array.isArray(body.verifiers) ? body.verifiers : [])
    .filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(value))
    .slice(0, 5);

  const result = await bindPortalSession(supabaseAdmin, {
    sessionId,
    userId: user.id,
    requestHash: typeof rawRequest === 'string' ? await sha256Hex(rawRequest) : null,
    verifierHashes: await Promise.all(verifiers.map((value) => sha256Hex(value))),
    originOrganizationId: portalOriginOf(req)?.organizationId ?? null,
  });
  if (result.ok) return { bound: true };
  if (bindFailureEndsSession(result.reason)) {
    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(token, 'local');
    if (signOutError) console.warn('portal-login: verse inlog ongeldig maken mislukt', signOutError.message);
  }
  throw new PortalLoginError(bindFailureMessage(result.reason), bindFailureStatus(result.reason));
}

async function portalKeyFor(organizationId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('portal_login_addresses').select('key').eq('organization_id', organizationId).maybeSingle();
  const key = (data as { key?: unknown } | null)?.key;
  return isPortalLoginKey(key) ? key : null;
}

/** De huisstijl van het inlogscherm: van het klantadres, of bij de sleutel uit het adres. */
async function brandingFor(req: Request, rawKey: unknown): Promise<Branding | null> {
  const client = portalOriginOf(req);
  if (!client) return brandingForKey(req, rawKey);
  if (await throttleHit(await sha256Hex(`portal-brand:ip:${senderAddress(req)}`), 600, 120, 600) > 0) return null;
  return loadBranding(supabaseAdmin, client.organizationId);
}

/**
 * Werk dat na het antwoord doorloopt (EdgeRuntime.waitUntil). Zonder die
 * runtime (de stromentest in Node) wachten we er gewoon op.
 */
async function afterResponse(task: Promise<unknown>): Promise<void> {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') {
    runtime.waitUntil(task);
    return;
  }
  await task;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function senderAddress(req: Request): string {
  return (req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || 'onbekend')
    .trim().slice(0, 64);
}

/** Telt één aanvraag op deze sleutel; geeft het aantal seconden wachten (0 = door). */
async function throttleHit(key: string, windowSeconds: number, max: number, blockSeconds: number): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('portal_login_hit', {
    p_key: key, p_window_seconds: windowSeconds, p_max_attempts: max, p_block_seconds: blockSeconds,
  });
  // Een kapotte teller (migratie nog niet gedraaid) mag het inloggen niet blokkeren.
  if (error) { console.warn('portal_login_hit mislukt', error.message); return 0; }
  return Number(data) || 0;
}

/** Telt deze aanvraag; true als de afzender of het adres even moet wachten. */
async function portalLoginThrottled(req: Request, email: string): Promise<boolean> {
  const [ipKey, emailKey] = await Promise.all([
    sha256Hex(`portal-login:ip:${senderAddress(req)}`),
    sha256Hex(`portal-login:email:${email}`),
  ]);
  // 20 per 10 minuten per afzender; 5 per uur per e-mailadres.
  const [ipWait, emailWait] = await Promise.all([throttleHit(ipKey, 600, 20, 900), throttleHit(emailKey, 3600, 5, 3600)]);
  return ipWait > 0 || emailWait > 0;
}

/**
 * De huisstijl van het inlogscherm bij een sleutel uit het adres. Alleen wat
 * `loadBranding` naar buiten laat (logo, naam, kleuren, letters, afsluiting),
 * nooit het id of de gegevens van de organisatie. Een onbekende of ongeldige
 * sleutel geeft null: dan is het inlogscherm neutraal, net als op /portal.
 *
 * Met een eigen rem per afzender: de sleutel is niet te raden (tien
 * willekeurige tekens), maar een antwoord met twee logo's is een paar honderd
 * kB, en dat hoort niemand eindeloos te kunnen opvragen.
 */
async function brandingForKey(req: Request, raw: unknown): Promise<Branding | null> {
  if (!isPortalLoginKey(raw)) return null;
  // 120 per 10 minuten per afzender: ruim voor een kantoor achter één adres.
  if (await throttleHit(await sha256Hex(`portal-brand:ip:${senderAddress(req)}`), 600, 120, 600) > 0) return null;
  const { data, error } = await supabaseAdmin
    .from('portal_login_addresses')
    .select('organization_id')
    .eq('key', raw)
    .maybeSingle();
  if (error) {
    // Ook: de migratie met de tabel staat er nog niet. Dan neutraal.
    console.warn('portal-login inlogadres opzoeken mislukt', error.message);
    return null;
  }
  const organizationId = (data as { organization_id?: unknown } | null)?.organization_id;
  if (typeof organizationId !== 'string' || !organizationId) return null;
  return loadBranding(supabaseAdmin, organizationId);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Maakt het auth-account aan als het nog niet bestaat. Idempotent: een al
 *  bestaand account is geen fout. email_confirm = true zodat de magische link
 *  direct werkt zonder aparte bevestigingsstap.
 *
 *  app_metadata.resofly_portal markeert het als klantaccount: zo'n account
 *  krijgt in de werkruimte geen eigen organisatie (is_portal_only_account,
 *  migratie 20261101010000). app_metadata kan alleen de server zetten, de
 *  gebruiker zelf niet. Een bestaand account (bijvoorbeeld een teamlid dat ook
 *  klant is) wordt niet aangeraakt. */
async function ensureAuthUser(email: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { resofly_portal: true },
  });
  if (!error) return;
  // Bestaat al → prima, dit is het gewenste eindresultaat.
  const message = (error.message || '').toLowerCase();
  if (message.includes('already') || message.includes('registered') || message.includes('exists')) return;
  throw error;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.code === 'string' && obj.code) parts.push(`(code ${obj.code})`);
    if (typeof obj.details === 'string' && obj.details) parts.push(`details: ${obj.details}`);
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(obj); } catch { /* val terug op String() */ }
  }
  return String(error);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;
      try { origins.add(new URL(part).origin); } catch { origins.add(part); }
    }
  }
  return Array.from(origins);
}

function assertAllowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';
  // Een pagina zonder herkomst (sandbox-iframe, data:, file:) is nooit de app.
  if (origin === 'null') throw new PortalLoginError('Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.', 403);
  if (!origin) return;
  if (portalOriginOf(req)) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PortalLoginError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = portalOriginOf(req) || allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : '';
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': `authorization, x-client-info, apikey, content-type, ${PORTAL_TOKEN_HEADER}`,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
