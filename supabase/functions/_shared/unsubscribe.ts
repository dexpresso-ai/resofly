// Gedeelde, stateless afmeld-token helper (HMAC-SHA256).
//
// Een token codeert "<organizationId>:<email>" plus een HMAC-signatuur met een
// server-secret (UNSUBSCRIBE_SECRET). Geen opslag nodig: de email-unsubscribe
// functie herrekent de signatuur en vertrouwt het token alleen bij een match.
// Zo kan elke marketingmail een afmeldlink dragen zonder per-mail token-tabel.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a[i] ^ b[i];
  return result === 0;
}

export async function makeUnsubscribeToken(
  secret: string,
  organizationId: string,
  email: string,
): Promise<string> {
  const payload = `${organizationId}:${email.trim().toLowerCase()}`;
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const sig = base64UrlEncode(await hmac(secret, payload));
  return `${payloadB64}.${sig}`;
}

export async function verifyUnsubscribeToken(
  secret: string,
  token: string,
): Promise<{ organizationId: string; email: string } | null> {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  let payload: string;
  try {
    payload = new TextDecoder().decode(base64UrlDecodeToBytes(payloadB64));
  } catch {
    return null;
  }

  const expected = base64UrlEncode(await hmac(secret, payload));
  if (!timingSafeEqual(new TextEncoder().encode(sig), new TextEncoder().encode(expected))) {
    return null;
  }

  const idx = payload.indexOf(':');
  if (idx <= 0) return null;
  const organizationId = payload.slice(0, idx);
  const email = payload.slice(idx + 1).trim().toLowerCase();
  if (!organizationId || !email) return null;
  return { organizationId, email };
}
