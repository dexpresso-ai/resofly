// Shared helpers for handling each organization's own Mollie API key.
//
// The encryption scheme (AES-GCM, key derived from MOLLIE_TOKEN_ENCRYPTION_KEY
// via SHA-256) is intentionally identical to the one the billing function uses
// for Mollie Connect tokens, so a single server secret protects both stores.
//
// Used by invoice-workflow to store/read the per-organization invoice Mollie key.

const ENCRYPTION_KEY_ENV = 'MOLLIE_TOKEN_ENCRYPTION_KEY';

function allowDevFallback(): boolean {
  return (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
}

async function encryptionKey(): Promise<CryptoKey> {
  const secret = Deno.env.get(ENCRYPTION_KEY_ENV) || '';
  if (!secret && !allowDevFallback()) throw new Error(`${ENCRYPTION_KEY_ENV} ontbreekt in de Edge Function secrets.`);
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret || 'dev-only-token-key'));
  return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plainText: string): Promise<string> {
  if (!plainText) throw new Error('Lege Mollie-sleutel kan niet worden opgeslagen.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainText));
  return `v1.${btoaUrlBytes(iv)}.${btoaUrlBytes(new Uint8Array(cipher))}`;
}

export async function decryptSecret(value: string): Promise<string> {
  const [version, ivRaw, cipherRaw] = value.split('.');
  if (version !== 'v1' || !ivRaw || !cipherRaw) throw new Error('Mollie-sleutelopslag heeft een ongeldig formaat.');
  const key = await encryptionKey();
  const iv = atobUrlBytes(ivRaw);
  const cipher = atobUrlBytes(cipherRaw);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

export type MollieKeyMode = 'test' | 'live';

// Mollie API keys are always prefixed with test_ or live_.
export function detectMollieKeyMode(apiKey: string): MollieKeyMode | null {
  if (/^test_/.test(apiKey)) return 'test';
  if (/^live_/.test(apiKey)) return 'live';
  return null;
}

export function mollieKeySuffix(apiKey: string): string {
  return apiKey.slice(-4);
}

// Validate a freshly entered key by doing one cheap authenticated call. This
// catches typos / revoked keys at save time instead of at the first invoice.
export async function validateMollieApiKey(apiKey: string): Promise<{ valid: boolean; mode: MollieKeyMode | null; error?: string }> {
  const mode = detectMollieKeyMode(apiKey);
  if (!mode) return { valid: false, mode: null, error: 'Een Mollie API-key begint met test_ of live_.' };
  try {
    const response = await fetch('https://api.mollie.com/v2/methods', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { valid: false, mode, error: 'Mollie weigerde deze API-key (ongeldig of ingetrokken).' };
    }
    if (!response.ok) {
      return { valid: false, mode, error: `Mollie gaf een onverwachte status (${response.status}) terug bij het valideren van de key.` };
    }
    return { valid: true, mode };
  } catch (error) {
    return { valid: false, mode, error: error instanceof Error ? error.message : 'Mollie kon niet worden bereikt om de key te valideren.' };
  }
}

function btoaUrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function atobUrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
