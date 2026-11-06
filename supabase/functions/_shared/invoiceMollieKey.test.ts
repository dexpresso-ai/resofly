import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * De Mollie-key van een organisatie ophalen (invoiceMollieKey.ts): altijd per
 * organisatie, en een key die nog met de oude ingebouwde sleutel was opgeslagen
 * (staging, waar MOLLIE_TOKEN_ENCRYPTION_KEY ontbrak) wordt meteen opnieuw versleuteld, zonder een key
 * te overschrijven die een beheerder intussen verving.
 */

const env = new Map<string, string>();
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (name: string) => env.get(name) } };

const { decryptSecretWithInfo, encryptSecret } = await import('./mollieSecrets.ts');
const { loadInvoiceMollieKey } = await import('./invoiceMollieKey.ts');

const ORG = '0000000a-0000-0000-0000-000000000001';
const ANDERE_ORG = '0000000b-0000-0000-0000-000000000002';
const ECHTE_SLEUTEL = 'een-lange-willekeurige-sleutel-voor-de-test-0123456789';
const KEY = 'live_abcdefghijklmnopqrstuvwxyz0123';

function zetOmgeving(waarden: Record<string, string>) {
  env.clear();
  for (const [naam, waarde] of Object.entries(waarden)) env.set(naam, waarde);
}

type Rij = { organization_id: string; status: string; api_key_encrypted: string | null; mode: string | null };
type Filter = [string, unknown];

/** Een nep-Supabase met één tabel: organization_invoice_mollie_settings. */
function nepDb(rijen: Rij[], opties: { leesFout?: { message: string }; schrijfFout?: { message: string }; naLezen?: () => void } = {}) {
  const lezingen: Filter[][] = [];
  const updates: Array<{ waarden: Record<string, unknown>; filters: Filter[] }> = [];
  const past = (rij: Rij, filters: Filter[]) => filters.every(([kolom, waarde]) => (rij as Record<string, unknown>)[kolom] === waarde);
  const db = {
    from(tabel: string) {
      assert.equal(tabel, 'organization_invoice_mollie_settings');
      return {
        select(_kolommen: string) {
          const filters: Filter[] = [];
          const query = {
            eq(kolom: string, waarde: unknown) { filters.push([kolom, waarde]); return query; },
            async maybeSingle() {
              lezingen.push(filters);
              if (opties.leesFout) return { data: null, error: opties.leesFout };
              const gevonden = rijen.find((rij) => past(rij, filters)) ?? null;
              const kopie = gevonden ? { ...gevonden } : null;
              opties.naLezen?.();
              return { data: kopie, error: null };
            },
          };
          return query;
        },
        update(waarden: Record<string, unknown>) {
          const filters: Filter[] = [];
          const query = {
            eq(kolom: string, waarde: unknown) { filters.push([kolom, waarde]); return query; },
            then(resolve: (value: unknown) => unknown) {
              updates.push({ waarden, filters });
              if (!opties.schrijfFout) for (const rij of rijen) if (past(rij, filters)) Object.assign(rij, waarden);
              return Promise.resolve(resolve({ error: opties.schrijfFout ?? null }));
            },
          };
          return query;
        },
      };
    },
  };
  return { db, lezingen, updates };
}

async function opslagMet(sleutel: string, plain = KEY): Promise<string> {
  const vorige = new Map(env);
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: sleutel });
  const opslag = await encryptSecret(plain);
  env.clear();
  for (const [naam, waarde] of vorige) env.set(naam, waarde);
  return opslag;
}

test('niet gekoppeld of ingetrokken: geen key, en geen fout', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  for (const rijen of [[], [{ organization_id: ORG, status: 'revoked', api_key_encrypted: null, mode: null }]]) {
    const { db } = nepDb(rijen);
    assert.deepEqual(await loadInvoiceMollieKey(db, ORG), { key: null, connected: false, reason: 'geen gekoppelde Mollie-sleutel (meer)' });
  }
});

test('altijd de rij van de eigen organisatie, nooit die van een ander', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  const rijAnder: Rij = { organization_id: ANDERE_ORG, status: 'connected', api_key_encrypted: await opslagMet(ECHTE_SLEUTEL, 'live_vanEenAndereOrganisatie000000'), mode: 'live' };
  const { db, lezingen } = nepDb([rijAnder]);
  const uit = await loadInvoiceMollieKey(db, ORG);
  assert.equal(uit.key, null);
  assert.deepEqual(lezingen, [[['organization_id', ORG]]]);
});

test('gekoppeld met de echte sleutel: de key, en niets opnieuw opgeslagen', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL, MOLLIE_ALLOW_MOCK: 'true' });
  const opslag = await opslagMet(ECHTE_SLEUTEL);
  const { db, updates } = nepDb([{ organization_id: ORG, status: 'connected', api_key_encrypted: opslag, mode: 'live' }]);
  assert.deepEqual(await loadInvoiceMollieKey(db, ORG), { key: { apiKey: KEY, mode: 'live' }, connected: true, reason: null });
  assert.equal(updates.length, 0);
});

test('oude opslag (ingebouwde sleutel) op staging: de key werkt en staat daarna met de echte sleutel in de database', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL, MOLLIE_ALLOW_MOCK: 'true' });
  const oud = await opslagMet('dev-only-token-key');
  const rij: Rij = { organization_id: ORG, status: 'connected', api_key_encrypted: oud, mode: 'test' };
  const { db, updates } = nepDb([rij]);
  assert.deepEqual((await loadInvoiceMollieKey(db, ORG)).key, { apiKey: KEY, mode: 'test' });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filters, [['organization_id', ORG], ['api_key_encrypted', oud]], 'alleen als de rij nog de oude waarde heeft');
  assert.deepEqual(Object.keys(updates[0].waarden), ['api_key_encrypted']);
  assert.notEqual(rij.api_key_encrypted, oud);
  assert.deepEqual(await decryptSecretWithInfo(String(rij.api_key_encrypted)), { plain: KEY, legacyKey: false });
  // Een tweede keer: niets meer te doen.
  await loadInvoiceMollieKey(db, ORG);
  assert.equal(updates.length, 1);
});

test('vervangt een beheerder op hetzelfde moment de key, dan blijft zijn nieuwe key staan', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL, MOLLIE_ALLOW_MOCK: 'true' });
  const oud = await opslagMet('dev-only-token-key');
  const nieuw = await opslagMet(ECHTE_SLEUTEL, 'live_deNieuweKeyVanDeBeheerder00000');
  const rij: Rij = { organization_id: ORG, status: 'connected', api_key_encrypted: oud, mode: 'live' };
  const { db } = nepDb([rij], { naLezen: () => { rij.api_key_encrypted = nieuw; } });
  await loadInvoiceMollieKey(db, ORG);
  assert.equal(rij.api_key_encrypted, nieuw);
});

test('oude opslag zonder echte sleutel: leesbaar (staging vóór de fix), maar er valt niets opnieuw te versleutelen', async () => {
  zetOmgeving({ MOLLIE_ALLOW_MOCK: 'true' });
  const oud = await opslagMet('dev-only-token-key');
  const { db, updates } = nepDb([{ organization_id: ORG, status: 'connected', api_key_encrypted: oud, mode: 'test' }]);
  assert.equal((await loadInvoiceMollieKey(db, ORG)).key?.apiKey, KEY);
  assert.equal(updates.length, 0);
});

test('opnieuw opslaan mislukt: de betaling gaat gewoon door met de key', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL, MOLLIE_ALLOW_MOCK: 'true' });
  const oud = await opslagMet('dev-only-token-key');
  const { db } = nepDb([{ organization_id: ORG, status: 'connected', api_key_encrypted: oud, mode: 'live' }], { schrijfFout: { message: 'storing' } });
  assert.equal((await loadInvoiceMollieKey(db, ORG)).key?.apiKey, KEY);
});

test('storing of onleesbare opslag: geen key, wel de reden, en geteld als gekoppeld (de webhook geeft dan 503)', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  const storing = await loadInvoiceMollieKey(nepDb([], { leesFout: { message: 'verbinding weg' } }).db, ORG);
  assert.deepEqual(storing, { key: null, connected: true, reason: 'instellingen niet te laden: verbinding weg' });

  const kapot = await loadInvoiceMollieKey(nepDb([{ organization_id: ORG, status: 'connected', api_key_encrypted: 'v1.abc.def', mode: 'live' }]).db, ORG);
  assert.equal(kapot.key, null);
  assert.equal(kapot.connected, true);
  assert.match(String(kapot.reason), /^ontsleutelen mislukt/);

  // Productie: de ingebouwde sleutel telt niet, dus oude opslag is daar onleesbaar.
  const oud = await opslagMet('dev-only-token-key');
  const productie = await loadInvoiceMollieKey(nepDb([{ organization_id: ORG, status: 'connected', api_key_encrypted: oud, mode: 'live' }]).db, ORG);
  assert.equal(productie.key, null);
  assert.match(String(productie.reason), /^ontsleutelen mislukt/);
});
