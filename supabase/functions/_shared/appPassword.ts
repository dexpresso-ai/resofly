// Gedeelde helpers voor CalDAV app-wachtwoorden.
//
// Een app-wachtwoord is een willekeurig token met hoge entropie dat de gebruiker
// éénmalig te zien krijgt. Wij bewaren alleen een gesalte SHA-256-hash (hex),
// nooit de plain tekst. Omdat het token willekeurig en lang is, volstaat één
// SHA-256 — een trage KDF (PBKDF2/bcrypt) is hier onnodig en zou de CalDAV-Worker
// onnodig belasten (die verifieert bij elke request).

// Alfabet zonder makkelijk te verwarren tekens (geen l/o/0/1), prettig om op een
// telefoon over te typen.
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Genereert een token als 4 blokjes van 5 tekens, bijv. "ab3cd-ef7gh-jk9mn-pq2rs". */
export function generateAppPasswordToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return (out.match(/.{1,5}/g) || [out]).join('-');
}

/** Willekeurige salt (base64url, zonder padding). */
export function generateSalt(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Gesalte SHA-256 van het token, als hex-string. Salt en token zijn beide nodig. */
export async function hashAppPassword(token: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${normalizeToken(token)}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(new Uint8Array(digest));
}

/** Vergelijking in constante tijd, voor het verifiëren van een hash. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Streep evt. spaties/streepjes en hoofdletters weg, zodat invoer tolerant is. */
export function normalizeToken(token: string): string {
  return token.replace(/[\s-]/g, '').toLowerCase();
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
