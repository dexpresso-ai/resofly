// ============================================================
// api-admin — beheer van de openbare API vanuit de app (Instellingen → API &
// webhooks).
//
// Twee kanten, net als bij de AI-koppelingen:
//  - AANMAKEN gaat hierlangs, omdat er een geheim bij hoort dat alleen de
//    server mag maken. De platte sleutel verlaat deze functie één keer, in het
//    antwoord aan de owner/admin die hem aanmaakt, en bestaat daarna nergens
//    meer in leesbare vorm.
//  - ZIEN en INTREKKEN gaat rechtstreeks via RLS (api_keys: owners/admins lezen
//    en trekken in, de guard bewaakt wat er mag veranderen). Zo kan de
//    intrek-knop niet stilvallen als deze functie het even niet doet.
//
// Alleen owners en admins: een API-sleutel is een deur naar de hele
// organisatie, en die geeft niet elk teamlid zomaar uit.
// ============================================================

import {
  createAdminClient, HttpError, makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type OrganizationRole,
} from '../_shared/edgeAuth.ts';
import {
  ACCESS_LEVELS, apiKeyHint, createApiKey, MODULE_KEYS, MODULE_LABEL, normalizeKeyModuleAccess, scopeForLevel,
  type AccessLevel,
} from '../_shared/publicApi.ts';

const admin = createAdminClient();

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('API_ADMIN_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('GERRIE_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('API_ADMIN_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

const PUBLIC_BASE = (Deno.env.get('API_PUBLIC_URL') || `${Deno.env.get('SUPABASE_URL') || ''}/functions/v1/api`).replace(/\/+$/, '');

/** Meer actieve sleutels dan dit is geen overzicht meer, maar een lek dat nog moet gebeuren. */
const MAX_ACTIVE_KEYS = 50;

/** Wat het scherm van een sleutel te zien krijgt. Nooit iets van het geheim. */
const KEY_COLUMNS = 'id, organization_id, user_id, name, key_hint, scope, module_access, expires_at, created_at, last_used_at, revoked_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });
  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Gebruik POST.', 400);

    const user = await requireUser(admin, req);
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError('De inhoud van dit verzoek is geen geldige JSON.', 400);
    }
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(admin, user.id, organizationId);

    switch (String(body.action || '')) {
      case 'catalog':
        return cors.json(req, catalog());
      case 'createKey':
        assertAdmin(role);
        return cors.json(req, await createKey(user.id, organizationId, body));
      default:
        throw new HttpError('Onbekende actie.', 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error('[api-admin]', error instanceof Error ? error.message : error);
    const message = error instanceof Error ? error.message : 'Er ging iets mis.';
    return cors.json(req, { error: status === 500 ? 'Er ging iets mis aan onze kant. Probeer het opnieuw.' : message }, status);
  }
});

function assertAdmin(role: OrganizationRole): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new HttpError('Alleen owners en admins kunnen API-sleutels en webhooks beheren.', 403);
  }
}

/** Wat het scherm nodig heeft om de keuzes op te bouwen — één bron, hier. */
function catalog(): Record<string, unknown> {
  return {
    apiBaseUrl: PUBLIC_BASE,
    openApiUrl: `${PUBLIC_BASE}/v1/openapi.json`,
    accessLevels: ACCESS_LEVELS,
    modules: MODULE_KEYS.map((key) => ({ key, label: MODULE_LABEL[key] })),
  };
}

/**
 * Maakt een sleutel aan namens de ingelogde owner/admin.
 *
 * Wat de sleutel mag, ligt hier vast: het toegangsniveau (een trede, zie
 * scopeForLevel), een eventuele modulebeperking en een eventuele vervaldatum.
 * Achteraf kan dat niet meer ruimer — de guard op api_keys laat vanuit de app
 * alleen hernoemen en intrekken toe.
 */
async function createKey(userId: string, organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw new HttpError('Geef de sleutel een naam, bijvoorbeeld "Webshop" of "Urenkoppeling".', 400);

  const access = String(body.access ?? 'read') as AccessLevel;
  if (!ACCESS_LEVELS.includes(access)) throw new HttpError(`Kies een toegangsniveau: ${ACCESS_LEVELS.join(', ')}.`, 400);

  let moduleAccess: Record<string, 'none' | 'read'>;
  try {
    moduleAccess = normalizeKeyModuleAccess(body.moduleAccess);
  } catch (error) {
    throw new HttpError(error instanceof Error ? error.message : 'De modulebeperking klopt niet.', 400);
  }

  const rawDays = body.expiresInDays;
  const days = rawDays === undefined || rawDays === null || rawDays === '' ? null : Number(rawDays);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 730)) {
    throw new HttpError('Een vervaltermijn ligt tussen 1 en 730 dagen, of laat hem leeg voor "verloopt niet".', 400);
  }

  const { count, error: countError } = await admin.from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId).is('revoked_at', null);
  if (countError) throw new HttpError(`Sleutels tellen mislukt: ${countError.message}`, 500);
  if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new HttpError(`Deze organisatie heeft al ${count} actieve sleutels. Trek eerst sleutels in die niet meer gebruikt worden.`, 409);
  }

  const token = await createApiKey();
  const { data: key, error } = await admin.from('api_keys').insert({
    organization_id: organizationId,
    user_id: userId,
    name,
    key_hint: apiKeyHint(token.selector),
    scope: scopeForLevel(access),
    module_access: moduleAccess,
    expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  }).select(KEY_COLUMNS).single();
  if (error || !key) throw new HttpError(`De sleutel kon niet worden aangemaakt: ${error?.message ?? 'onbekende fout'}`, 500);

  const { error: secretError } = await admin.from('api_key_secrets').insert({
    api_key_id: key.id,
    selector: token.selector,
    verifier_hash: token.hash,
    salt: token.salt,
  });
  if (secretError) {
    // Een sleutel zonder geheim kan nooit werken; liever helemaal niet dan een
    // regel in de lijst die niets doet.
    await admin.from('api_keys').delete().eq('id', key.id);
    throw new HttpError(`De sleutel kon niet worden aangemaakt: ${secretError.message}`, 500);
  }

  return { key, secret: token.plain };
}
