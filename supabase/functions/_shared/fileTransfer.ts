// ============================================================
// Bestanden versturen (zendingen) — de pure regels.
//
// Geen Deno, geen database: node --test draait de test ernaast
// (fileTransfer.test.ts), en de frontend (src/lib/transfers.ts) en de
// media-worker spiegelen een paar van deze waarden — met een test die ze
// naast elkaar legt.
//
// De echte grens ligt in de database (20261013100000_file_transfers.sql):
// welke klant, welke ontvanger, wanneer iets vastligt. Wat hier staat is wat
// de edge functions vóór de database controleren, zodat een gebruiker een
// leesbare zin krijgt in plaats van een databasefout.
// ============================================================

/** Hoogstens 1 GB per bestand (zie ook de CHECK op file_transfer_items). */
export const TRANSFER_MAX_FILE_BYTES = 1024 * 1024 * 1024;

/** Hoeveel bestanden er hoogstens in één zending passen (een uitgeklapte map telt per bestand). */
export const TRANSFER_MAX_ITEMS = 500;

/** Hoeveel ontvangers één zending hoogstens heeft. */
export const TRANSFER_MAX_RECIPIENTS = 25;

/** Een notitie of tekstdocument gaat als HTML mee; groter dan dit past niet. */
export const TRANSFER_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Een zending is hoogstens een jaar beschikbaar (de database staat 366 dagen toe, voor de marge). */
export const TRANSFER_MAX_DAYS = 365;

/** Standaard vervaltermijn als de afzender niets kiest. */
export const TRANSFER_DEFAULT_DAYS = 30;

/** Een e-mailcode is tien minuten geldig. */
export const TRANSFER_CODE_TTL_SECONDS = 600;

/** Een geopende zending (na de code) blijft een uur open in dit tabblad. */
export const TRANSFER_SESSION_TTL_SECONDS = 3600;

/** Hoe lang een download-URL van de media-worker werkt. */
export const TRANSFER_DOWNLOAD_TTL_SECONDS = 900;

/**
 * Bestandstypen die nooit mee mogen. Wie het verzendaccount van een teamlid
 * overneemt, kan anders onder jullie naam en vanaf jullie domein een
 * programma naar klanten sturen. Een .zip met iets erin houdt dit niet tegen —
 * het gaat om het directe, klikbare risico. Moet gelijk blijven aan
 * TRANSFER_BLOCKED_EXTENSIONS in workers/media-api/src/index.ts en
 * src/lib/transfers.ts (fileTransfer.test.ts legt ze naast elkaar).
 */
export const TRANSFER_BLOCKED_EXTENSIONS = [
  'exe', 'msi', 'msp', 'msix', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'lnk', 'jar', 'hta',
  'reg', 'dll', 'iso', 'img', 'vhd', 'vhdx', 'application', 'gadget', 'msc',
] as const;

const BLOCKED = new Set<string>(TRANSFER_BLOCKED_EXTENSIONS);

/** De extensie die het bestand gevaarlijk maakt, of null. "factuur.pdf.exe" telt als exe. */
export function blockedExtension(fileName: string): string | null {
  const name = String(fileName ?? '').trim().toLowerCase().replace(/[\s.]+$/, '');
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return BLOCKED.has(ext) ? ext : null;
}

/** Leesbare weigering voor een geblokkeerd bestand. */
export function blockedExtensionMessage(fileName: string, ext: string): string {
  return `“${fileName}” is een .${ext}-bestand. Programma’s en scripts kun je niet versturen; pak het in een .zip als de ontvanger het echt nodig heeft.`;
}

/**
 * Een bestandsnaam zoals hij in de lijst en in de download staat: geen paden,
 * geen stuurtekens, niet leeg, hoogstens 300 tekens.
 */
export function cleanFileName(name: unknown, fallback = 'bestand'): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]+/g, '').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 300);
}

// ── Vervaldatum ──────────────────────────────────────────────────────────────

export type ExpiryResult = { ok: true; iso: string } | { ok: false; error: string };

/**
 * Leest de gekozen vervaldatum: een aantal dagen (1–365) of een ISO-datum/tijd.
 * Een datum zonder tijd ("2026-11-12") betekent het einde van die dag.
 */
export function parseTransferExpiry(raw: unknown, now: Date = new Date()): ExpiryResult {
  const max = now.getTime() + TRANSFER_MAX_DAYS * 86_400_000;
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, iso: new Date(now.getTime() + TRANSFER_DEFAULT_DAYS * 86_400_000).toISOString() };
  }
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d{1,3}$/.test(raw.trim()))) {
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > TRANSFER_MAX_DAYS) {
      return { ok: false, error: `Kies een termijn van 1 tot ${TRANSFER_MAX_DAYS} dagen.` };
    }
    return { ok: true, iso: new Date(now.getTime() + days * 86_400_000).toISOString() };
  }
  const value = String(raw).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? endOfDayAmsterdam(value) : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return { ok: false, error: 'De vervaldatum is ongeldig.' };
  if (date.getTime() <= now.getTime() + 60_000) return { ok: false, error: 'De vervaldatum ligt in het verleden.' };
  if (date.getTime() > max) return { ok: false, error: `Een zending blijft hoogstens ${TRANSFER_MAX_DAYS} dagen beschikbaar.` };
  return { ok: true, iso: date.toISOString() };
}

/** 23:59:59 Nederlandse tijd op de gegeven kalenderdag. */
function endOfDayAmsterdam(day: string): Date | null {
  const [y, m, d] = day.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  // Zomertijd (+02:00) of wintertijd (+01:00): kijk wat Amsterdam op die dag doet.
  const offsetHours = amsterdamOffsetHours(probe);
  return new Date(Date.UTC(y, m - 1, d, 23 - offsetHours, 59, 59));
}

function amsterdamOffsetHours(date: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false })
      .formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '13');
    return ((hour - date.getUTCHours()) + 24) % 24;
  } catch {
    return 1;
  }
}

// ── Tokens en codes ──────────────────────────────────────────────────────────

/** 32 willekeurige bytes als base64url (43 tekens): de persoonlijke link-token. */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Vormcontrole vóór de databaseronde. */
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 20 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Zes cijfers, gelijkmatig verdeeld (geen modulo-scheefheid). */
export function generateCode(): string {
  const limit = 4_294_000_000; // grootste veelvoud van 1.000.000 onder 2^32
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 1_000_000).padStart(6, '0');
  }
}

/** Wat de gebruiker intypt: spaties en streepjes mogen ("123 456"). */
export function normalizeCode(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** De code gaat gehasht de database in, gebonden aan de ontvanger. */
export function codeHash(recipientId: string, code: string): Promise<string> {
  return sha256Hex(`file-transfer-code:${recipientId}:${code}`);
}

/** "j•••@bakker.nl" — genoeg om je eigen adres te herkennen, niet om het te lezen. */
export function maskEmail(email: string): string {
  const value = String(email ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.slice(0, 1)}•••@${domain}`;
}

// ── Ontvangers ───────────────────────────────────────────────────────────────

export type TransferRecipientInput =
  | { kind: 'client' }
  | { kind: 'contact'; clientContactId: string }
  | { kind: 'email'; email: string; name: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RecipientParse = { ok: true; recipients: TransferRecipientInput[] } | { ok: false; error: string };

/**
 * Leest en ontdubbelt de ontvangers uit een verzoek. Of een ontvanger bij de
 * klant mag, beslist de database; hier gaat het om de vorm.
 * `clientRelated` = de zending hoort bij een klant: dan geen losse adressen.
 */
export function parseTransferRecipients(raw: unknown, clientRelated: boolean): RecipientParse {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Kies minstens één ontvanger.' };
  if (raw.length > TRANSFER_MAX_RECIPIENTS) {
    return { ok: false, error: `Stuur naar hoogstens ${TRANSFER_MAX_RECIPIENTS} mensen tegelijk.` };
  }
  const out: TransferRecipientInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const kind = String(item.kind ?? '');
    if (kind === 'client') {
      if (!clientRelated) return { ok: false, error: 'Deze zending hoort bij geen klant, dus er is geen hoofdadres om naar te sturen.' };
      if (seen.has('client')) continue;
      seen.add('client');
      out.push({ kind: 'client' });
    } else if (kind === 'contact') {
      if (!clientRelated) return { ok: false, error: 'Deze zending hoort bij geen klant, dus er is geen contactpersoon om naar te sturen.' };
      const id = String(item.clientContactId ?? '');
      if (!UUID_RE.test(id)) return { ok: false, error: 'Ongeldige contactpersoon.' };
      if (seen.has(`c:${id}`)) continue;
      seen.add(`c:${id}`);
      out.push({ kind: 'contact', clientContactId: id });
    } else if (kind === 'email') {
      if (clientRelated) {
        return {
          ok: false,
          error: 'Klantbestanden gaan alleen naar de klant zelf of een contactpersoon van die klant. Voeg de ontvanger eerst toe als contactpersoon.',
        };
      }
      const email = String(item.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: `“${String(item.email ?? '')}” is geen geldig e-mailadres.` };
      if (seen.has(`e:${email}`)) continue;
      seen.add(`e:${email}`);
      const name = String(item.name ?? '').trim().slice(0, 200) || null;
      out.push({ kind: 'email', email, name });
    } else {
      return { ok: false, error: `Onbekende ontvanger: ${kind || '(leeg)'}` };
    }
  }
  if (out.length === 0) return { ok: false, error: 'Kies minstens één ontvanger.' };
  return { ok: true, recipients: out };
}

// ── Teksten ──────────────────────────────────────────────────────────────────

export function fileCountSentence(count: number): string {
  return count === 1 ? '1 bestand' : `${count} bestanden`;
}

export function formatBytesNl(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = value < 10 && i > 0 ? 1 : 0;
  return `${value.toFixed(digits).replace('.', ',')} ${units[i]}`;
}

/** "12 november 2026" in Nederlandse tijd. */
export function formatDateLongNl(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Naam van de zip: het onderwerp, zonder tekens die een bestandssysteem niet lust. */
export function transferZipName(subject: string): string {
  const stem = String(subject ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${stem || 'bestanden'}.zip`;
}

/** Wat een bezoeker leest als de link niet (meer) werkt. */
export function transferStateMessage(state: string): string {
  switch (state) {
    case 'revoked': return 'De afzender heeft deze bestanden ingetrokken.';
    case 'expired': return 'Deze bestanden zijn niet meer beschikbaar: de termijn is verlopen en ze zijn verwijderd.';
    case 'invalid': return 'Deze link werkt niet meer. Vraag de afzender om de bestanden opnieuw te sturen.';
    default: return 'Deze link bestaat niet (meer).';
  }
}

/** Het pad binnen een meegestuurde map als zip-pad: "Ontwerpen / Definitief" → "Ontwerpen/Definitief". */
export function zipPath(path: string | null | undefined, name: string): string {
  const parts = String(path ?? '')
    .split(' / ')
    .map((part) => cleanZipSegment(part))
    .filter(Boolean);
  parts.push(cleanZipSegment(name) || 'bestand');
  return parts.join('/');
}

function cleanZipSegment(value: string): string {
  // Eerst trimmen, dán punten en spaties aan beide kanten weg: anders wordt
  // " .. " alsnog "..". Moet gelijk blijven aan transferZipPath() in de worker.
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200)
    .trim();
}
