// Shared helpers for handling each organization's own Mollie API key.
//
// The encryption scheme (AES-GCM, key derived from MOLLIE_TOKEN_ENCRYPTION_KEY
// via SHA-256) is intentionally identical to the one the billing function uses
// for Mollie Connect tokens, so a single server secret protects both stores.
//
// Used by invoice-workflow to store/read the per-organization invoice Mollie key.
// Ophalen voor gebruik gaat via invoiceMollieKey.ts (met het herstel van oude opslag).

const ENCRYPTION_KEY_ENV = 'MOLLIE_TOKEN_ENCRYPTION_KEY';
const MOLLIE_API = 'https://api.mollie.com/v2';

function allowDevFallback(): boolean {
  return (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true'
    || (Deno.env.get('INVOICE_MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
}

const DEV_FALLBACK_KEY = 'dev-only-token-key';

async function keyFrom(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Staat de sleutel om Mollie-keys mee te versleutelen in de secrets? Zonder kan
 * er niets worden opgeslagen. Op staging ontbrak hij (gezien op 6 november 2026):
 * Mollie keurde de key dan goed, en daarna liep opslaan stuk op een algemene
 * serverfout.
 */
export function encryptionKeyConfigured(): boolean {
  return Boolean(Deno.env.get(ENCRYPTION_KEY_ENV));
}

/**
 * Versleutelen gebeurt altijd met de echte sleutel. Eerder viel dit zonder
 * MOLLIE_TOKEN_ENCRYPTION_KEY terug op een vaste sleutel uit deze code zodra
 * MOLLIE_ALLOW_MOCK aan stond — en die vlag staat op staging aan voor de
 * abonnementen. De Mollie-sleutels van organisaties waren dan in feite
 * onversleuteld. Nu weigert opslaan met een duidelijke melding.
 */
async function encryptionKey(): Promise<CryptoKey> {
  const secret = Deno.env.get(ENCRYPTION_KEY_ENV) || '';
  if (!secret) throw new Error(`${ENCRYPTION_KEY_ENV} ontbreekt in de Edge Function secrets. Zet die eerst; daarna kan de Mollie-sleutel worden opgeslagen.`);
  return await keyFrom(secret);
}

export async function encryptSecret(plainText: string): Promise<string> {
  if (!plainText) throw new Error('Lege Mollie-sleutel kan niet worden opgeslagen.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainText));
  return `v1.${btoaUrlBytes(iv)}.${btoaUrlBytes(new Uint8Array(cipher))}`;
}

/**
 * De ontsleutelde waarde, en of daar de oude ingebouwde sleutel voor nodig was.
 * Zo'n waarde stond in feite onversleuteld in de database (die sleutel staat in
 * deze code); invoiceMollieKey.ts slaat hem dan opnieuw op met de echte sleutel.
 */
export async function decryptSecretWithInfo(value: string): Promise<{ plain: string; legacyKey: boolean }> {
  const [version, ivRaw, cipherRaw] = value.split('.');
  if (version !== 'v1' || !ivRaw || !cipherRaw) throw new Error('Mollie-sleutelopslag heeft een ongeldig formaat.');
  const iv = atobUrlBytes(ivRaw);
  const cipher = atobUrlBytes(cipherRaw);
  const secret = Deno.env.get(ENCRYPTION_KEY_ENV) || '';
  if (secret) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await keyFrom(secret), cipher);
      return { plain: new TextDecoder().decode(plain), legacyKey: false };
    } catch (error) {
      if (!allowDevFallback()) throw error;
    }
  } else if (!allowDevFallback()) {
    throw new Error(`${ENCRYPTION_KEY_ENV} ontbreekt in de Edge Function secrets.`);
  }
  // Alleen om een sleutel te lezen die eerder met de oude terugval is opgeslagen
  // (staging zonder geheim). invoiceMollieKey.ts versleutelt hem daarna opnieuw.
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await keyFrom(DEV_FALLBACK_KEY), cipher);
  return { plain: new TextDecoder().decode(plain), legacyKey: true };
}

export async function decryptSecret(value: string): Promise<string> {
  return (await decryptSecretWithInfo(value)).plain;
}

export type MollieKeyMode = 'test' | 'live';

// Mollie API keys are always prefixed with test_ or live_.
export function detectMollieKeyMode(apiKey: string): MollieKeyMode | null {
  if (/^test_/.test(apiKey)) return 'test';
  if (/^live_/.test(apiKey)) return 'live';
  return null;
}

/**
 * Een Mollie API-key: test_ of live_, en dan alleen letters en cijfers (bij
 * Mollie 30 tekens; 16 tot 128 laat ruimte voor een andere lengte). Waarom zo
 * streng: de key gaat in een header naar Mollie. Met een regeleinde erin (een
 * key overgenomen uit een afgebroken mail of pdf) gooide fetch een fout met de
 * hele header erin, de key dus. Die melding ging naar het scherm én naar de logs
 * van de edge function.
 */
const MOLLIE_KEY_PATTERN = /^(test|live)_[A-Za-z0-9]{16,128}$/;

export function mollieKeySuffix(apiKey: string): string {
  return apiKey.slice(-4);
}

/** Het Mollie-profiel (de website) waar een key bij hoort. Geen geheim. */
export type MollieProfile = { id: string; name: string | null; website: string | null; status: string | null };

export type MollieKeyValidation =
  | { valid: true; mode: MollieKeyMode; profile: MollieProfile | null }
  | { valid: false; mode: MollieKeyMode | null; error: string };

const KEY_REFUSED = 'Mollie weigerde deze API-key (ongeldig of ingetrokken).';

/**
 * Validate a freshly entered key by doing one cheap authenticated call. This
 * catches typos / revoked keys at save time instead of at the first invoice.
 *
 * Eerst /profiles/me: Mollie zegt dan ook bij welk profiel de key hoort, zodat
 * de instellingen laten zien naar welk Mollie-account de betalingen gaan. Geeft
 * dat adres iets anders dan "goed" of "geweigerd", dan de controle van vroeger
 * (/methods): koppelen mag niet stuklopen op die extra informatie.
 */
export async function validateMollieApiKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<MollieKeyValidation> {
  const mode = detectMollieKeyMode(apiKey);
  if (!mode) return { valid: false, mode: null, error: 'Een Mollie API-key begint met test_ of live_.' };
  if (!MOLLIE_KEY_PATTERN.test(apiKey)) {
    return { valid: false, mode, error: 'Dit lijkt geen Mollie API-key: na test_ of live_ volgen alleen letters en cijfers. Kopieer de key opnieuw uit je Mollie-dashboard (Developers → API-keys).' };
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    const profileResponse = await fetchImpl(`${MOLLIE_API}/profiles/me`, { headers });
    if (profileResponse.status === 401 || profileResponse.status === 403) {
      await discardBody(profileResponse);
      return { valid: false, mode, error: KEY_REFUSED };
    }
    if (profileResponse.ok) {
      const profile = readMollieProfile(await profileResponse.json().catch(() => null));
      return { valid: true, mode, profile };
    }
    await discardBody(profileResponse);
    const methodsResponse = await fetchImpl(`${MOLLIE_API}/methods`, { headers });
    await discardBody(methodsResponse);
    if (methodsResponse.status === 401 || methodsResponse.status === 403) return { valid: false, mode, error: KEY_REFUSED };
    if (!methodsResponse.ok) {
      return { valid: false, mode, error: `Mollie gaf een onverwacht antwoord (${methodsResponse.status}) bij het controleren van de key. Probeer het later opnieuw.` };
    }
    return { valid: true, mode, profile: null };
  } catch {
    // Niet de melding van fetch doorgeven: daar kan de header in staan, met de key.
    return { valid: false, mode, error: 'Mollie is nu niet bereikbaar om de key te controleren. Probeer het over een paar minuten opnieuw.' };
  }
}

/** Het profiel uit het antwoord van Mollie, ingekort; null als het er niet uitziet als een profiel. */
export function readMollieProfile(payload: unknown): MollieProfile | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const id = shortText(record.id, 64);
  if (!id || !/^pfl_[A-Za-z0-9]+$/.test(id)) return null;
  return { id, name: shortText(record.name, 120), website: shortText(record.website, 200), status: shortText(record.status, 32) };
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return text || null;
}

async function discardBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* al gelezen of geen body */ }
}

function btoaUrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Uint8Array<ArrayBuffer>: crypto.subtle wil geen buffer die ook gedeeld kan zijn (deno check).
function atobUrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
