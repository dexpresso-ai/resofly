// ============================================================
// Web Push — VAPID (RFC 8292) + payload-encryptie (RFC 8291 / aes128gcm, RFC 8188).
//
// Bewust met de hand op Web Crypto (crypto.subtle) i.p.v. `npm:web-push`: de hele
// functions/-boom gebruikt geen npm-specifiers en `web-push` leunt op Node-crypto.
// Alle gebruikte algoritmes (ECDSA-P256, ECDH-P256, HKDF-SHA256, AES-128-GCM) zijn
// standaard Web Crypto en werken in de Supabase Deno-edge-runtime. De base64url-
// helpers spiegelen die uit _shared/unsubscribe.ts.
// ============================================================

// Buffers die aan Web Crypto / fetch worden gegeven moeten door een echte
// ArrayBuffer (niet SharedArrayBuffer) worden geback't — vandaar de alias en de
// expliciete `new ArrayBuffer(...)`-allocaties overal.
type Bytes = Uint8Array<ArrayBuffer>;

// ── base64url ────────────────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Bytes {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function utf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

// ── VAPID ────────────────────────────────────────────────────────────────────

export interface VapidKeys {
  /** base64url van de 65-byte (0x04||X||Y) publieke sleutel. */
  publicKey: string;
  /** base64url van de 32-byte private scalar. */
  privateKey: string;
  /** mailto:… of https://… — de VAPID `sub`-claim. */
  subject: string;
}

/** ECDSA-P256 privésleutel (voor het ondertekenen van het VAPID-JWT). */
async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = base64UrlDecode(keys.publicKey);
  const priv = base64UrlDecode(keys.privateKey);
  // Publieke sleutel is 65 bytes (0x04||X(32)||Y(32)); sommige bronnen leveren 64
  // bytes zonder prefix.
  const body = pub.length === 65 && pub[0] === 0x04 ? pub.subarray(1) : pub;
  if (body.length !== 64) throw new Error('VAPID_PUBLIC_KEY heeft geen geldige P-256 vorm.');
  if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY heeft geen geldige P-256 vorm.');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(body.subarray(0, 32)),
    y: base64UrlEncode(body.subarray(32, 64)),
    d: base64UrlEncode(priv),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Onderteken een VAPID-JWT (ES256) voor de audience = origin van het endpoint. */
async function signVapidJwt(keys: VapidKeys, audience: string): Promise<string> {
  const header = base64UrlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(utf8(JSON.stringify({
    aud: audience,
    exp: now + 12 * 60 * 60, // < 24u zoals de spec vereist
    sub: keys.subject,
  })));
  const signingInput = `${header}.${payload}`;
  const signingKey = await importVapidSigningKey(keys);
  // Web Crypto levert de ECDSA-signatuur al als rauwe r||s (64 bytes) — precies wat JOSE ES256 verwacht.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, utf8(signingInput)));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

// ── Payload-encryptie (aes128gcm) ────────────────────────────────────────────

const RECORD_SIZE = 4096;

async function hkdf(ikm: BufferSource, salt: BufferSource, info: BufferSource, lengthBytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

/**
 * Versleutel `plaintext` voor één abonnement volgens RFC 8291/8188 (aes128gcm).
 * Retourneert het volledige body (header + versleuteld record) klaar om te POSTen.
 */
async function encryptPayload(plaintext: Bytes, clientP256dh: string, clientAuth: string): Promise<Bytes> {
  const clientPubBytes = base64UrlDecode(clientP256dh);
  const authSecret = base64UrlDecode(clientAuth);

  // 1. Verse ephemeral server-ECDH-sleutel per bericht.
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey)); // 65 bytes
  const clientPubKey = await crypto.subtle.importKey('raw', clientPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // 2. Gedeeld ECDH-geheim.
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPubKey }, serverKeys.privateKey, 256);
  const sharedSecret = new Uint8Array(sharedBits);

  // 3. RFC 8291: leid het invoer-keymateriaal (IKM) af uit het gedeelde geheim.
  const keyInfo = concatBytes(utf8('WebPush: info\0'), clientPubBytes, serverPub);
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  // 4. RFC 8188: CEK + nonce uit IKM + record-salt.
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const cekBytes = await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12);

  // 5. Record = plaintext + delimiter 0x02 (laatste record), daarna AES-128-GCM.
  const record = concatBytes(plaintext, new Uint8Array([0x02]));
  const cek = await crypto.subtle.importKey('raw', cekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, record));

  if (ciphertext.length > RECORD_SIZE) {
    throw new Error('Push-payload te groot voor één record.');
  }

  // 6. RFC 8188-header: salt(16) || rs(uint32 BE) || idlen(1) || keyid(serverPub, 65).
  const header = new Uint8Array(new ArrayBuffer(16 + 4 + 1 + serverPub.length));
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = serverPub.length;
  header.set(serverPub, 21);

  return concatBytes(header, ciphertext);
}

// ── Verzenden ────────────────────────────────────────────────────────────────

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult = 'delivered' | 'gone' | 'error';

export interface PushOutcome {
  result: PushResult;
  status: number;
  detail?: string;
}

/**
 * Verstuur één versleuteld pushbericht. `payload` wordt als JSON verstuurd (de
 * service worker leest title/body/url/tag).
 */
export async function sendWebPush(
  keys: VapidKeys,
  subscription: PushSubscriptionRecord,
  payload: Record<string, unknown>,
  options: { ttlSeconds?: number } = {},
): Promise<PushOutcome> {
  let audience: string;
  try {
    audience = new URL(subscription.endpoint).origin;
  } catch {
    return { result: 'gone', status: 0, detail: 'Ongeldig endpoint' };
  }

  // Deze functie mag NOOIT throwen: het ondertekenen/versleutelen kan gooien bij een
  // corrupt p256dh/auth (atob/importKey) of een ongeldige VAPID-sleutel. Eén slecht
  // abonnement mag de hele drain-batch niet laten klappen — vang alles en rapporteer
  // het als 'error' (de dispatcher telt de failure en ruimt uiteindelijk op).
  let response: Response;
  try {
    const jwt = await signVapidJwt(keys, audience);
    const body = await encryptPayload(utf8(JSON.stringify(payload)), subscription.p256dh, subscription.auth);
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(options.ttlSeconds ?? 86400),
        Urgency: 'normal',
      },
      body,
    });
  } catch (err) {
    return { result: 'error', status: 0, detail: err instanceof Error ? err.message : 'verzendfout' };
  }

  if (response.status >= 200 && response.status < 300) {
    return { result: 'delivered', status: response.status };
  }
  // 404 (weg) / 410 (verlopen) → abonnement opruimen.
  if (response.status === 404 || response.status === 410) {
    return { result: 'gone', status: response.status };
  }
  const detail = await response.text().catch(() => '');
  return { result: 'error', status: response.status, detail: detail.slice(0, 300) };
}
