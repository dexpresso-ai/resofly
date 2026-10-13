import type {
  AppData, ClientContact, DriveShareItemType, FileTransfer, FileTransferBundle, FileTransferRecipient, UUID,
} from '../types';

/**
 * Bestanden versturen (zendingen) — de pure regels van de frontend. Zonder
 * React en zonder Supabase, zodat `npm test` ze draait (transfers.test.ts).
 *
 * De grens zelf (welke klant, welke ontvanger) bewaakt de database
 * (20261013100000_file_transfers.sql). Wat hier staat is de spiegel daarvan:
 * het venster toont alleen ontvangers die mogen, en weigert een bestand al
 * voordat het geüpload is.
 */

/** Hoogstens 1 GB per bestand. Moet gelijk blijven aan supabase/functions/_shared/fileTransfer.ts. */
export const TRANSFER_MAX_FILE_BYTES = 1024 * 1024 * 1024;

/** Boven deze grootte gaat een upload in delen (een Worker neemt ~100 MB per request aan). */
export const TRANSFER_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Hoeveel bestanden in één zending passen. */
export const TRANSFER_MAX_ITEMS = 500;

/**
 * Programma's en scripts gaan nooit mee. Moet gelijk blijven aan
 * TRANSFER_BLOCKED_EXTENSIONS in supabase/functions/_shared/fileTransfer.ts
 * (fileTransfer.test.ts legt ze naast elkaar).
 */
export const TRANSFER_BLOCKED_EXTENSIONS = [
  'exe', 'msi', 'msp', 'msix', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'lnk', 'jar', 'hta',
  'reg', 'dll', 'iso', 'img', 'vhd', 'vhdx', 'application', 'gadget', 'msc',
];
const BLOCKED = new Set(TRANSFER_BLOCKED_EXTENSIONS);

export function blockedExtension(fileName: string): string | null {
  const name = String(fileName ?? '').trim().toLowerCase().replace(/[\s.]+$/, '');
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return BLOCKED.has(ext) ? ext : null;
}

/** Waarom dit bestand niet mee kan, of null. */
export function fileRefusal(file: { name: string; size: number }): string | null {
  const ext = blockedExtension(file.name);
  if (ext) return `“${file.name}” is een .${ext}-bestand. Programma’s en scripts kun je niet versturen; pak het in een .zip als het echt nodig is.`;
  if (file.size > TRANSFER_MAX_FILE_BYTES) return `“${file.name}” is groter dan 1 GB. Per bestand kun je hoogstens 1 GB versturen.`;
  if (file.size <= 0) return `“${file.name}” is leeg.`;
  return null;
}

// ── Vervaldatum ──────────────────────────────────────────────────────────────

export const TRANSFER_EXPIRY_OPTIONS: Array<{ value: string; label: string; days: number | null }> = [
  { value: '1', label: '1 dag', days: 1 },
  { value: '3', label: '3 dagen', days: 3 },
  { value: '7', label: '1 week', days: 7 },
  { value: '14', label: '2 weken', days: 14 },
  { value: '30', label: '30 dagen', days: 30 },
  { value: '90', label: '90 dagen', days: 90 },
  { value: '365', label: '1 jaar', days: 365 },
  { value: 'custom', label: 'Kies een datum…', days: null },
];

export const TRANSFER_DEFAULT_EXPIRY = '30';

/** Wat de server krijgt: een aantal dagen, of de gekozen dag (JJJJ-MM-DD, einde van die dag). */
export function expiryForServer(option: string, customDate: string): number | string | null {
  const found = TRANSFER_EXPIRY_OPTIONS.find((o) => o.value === option);
  if (found?.days) return found.days;
  if (option === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) return customDate;
  return null;
}

/** De verste dag die je in de datumkiezer mag kiezen (vandaag + 365). */
export function maxExpiryDate(now: Date = new Date()): string {
  const date = new Date(now.getTime() + 365 * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function minExpiryDate(now: Date = new Date()): string {
  const date = new Date(now.getTime() + 86_400_000);
  return date.toISOString().slice(0, 10);
}

// ── Status ───────────────────────────────────────────────────────────────────

export type TransferState = 'draft' | 'active' | 'expired' | 'revoked';

export function transferState(transfer: Pick<FileTransfer, 'status' | 'expires_at' | 'purged_at'>, now: number = Date.now()): TransferState {
  if (transfer.status === 'draft') return 'draft';
  if (transfer.status === 'revoked') return 'revoked';
  if (transfer.status === 'expired' || transfer.purged_at) return 'expired';
  const expires = Date.parse(transfer.expires_at);
  if (Number.isFinite(expires) && expires <= now) return 'expired';
  return 'active';
}

export const TRANSFER_STATE_LABEL: Record<TransferState, string> = {
  draft: 'Concept',
  active: 'Beschikbaar',
  expired: 'Verlopen',
  revoked: 'Ingetrokken',
};

export type RecipientStatus = { label: string; tone: 'ok' | 'muted' | 'warn' | 'danger' };

/** De stand van één ontvanger: van "verstuurd" tot "gedownload", of wat er misging. */
export function recipientStatus(recipient: FileTransferRecipient): RecipientStatus {
  if (recipient.revoked_at) return { label: 'Ingetrokken', tone: 'muted' };
  // Te vaak een foute code; opnieuw versturen zet de link weer open.
  if (recipient.code_blocked_at) return { label: 'Link dicht — stuur opnieuw', tone: 'danger' };
  if (recipient.first_downloaded_at) {
    return { label: recipient.download_count > 1 ? `Gedownload (${recipient.download_count}×)` : 'Gedownload', tone: 'ok' };
  }
  if (recipient.first_opened_at) return { label: 'Geopend', tone: 'ok' };
  if (recipient.delivery_status === 'bounced' || recipient.delivery_status === 'complained' || recipient.delivery_status === 'failed') {
    return { label: 'Mail kwam niet aan', tone: 'danger' };
  }
  if (recipient.notify_error) return { label: 'Mail niet verstuurd', tone: 'danger' };
  if (recipient.delivery_status === 'delivered') return { label: 'Afgeleverd', tone: 'muted' };
  if (recipient.notified_at) return { label: 'Verstuurd', tone: 'muted' };
  return { label: 'Nog niet gemaild', tone: 'warn' };
}

export function recipientLabel(recipient: Pick<FileTransferRecipient, 'name' | 'email'>): string {
  const name = recipient.name?.trim();
  return name && name.toLowerCase() !== recipient.email.toLowerCase() ? `${name} · ${recipient.email}` : recipient.email;
}

/** Hoeveel ontvangers de bestanden hebben opgehaald. */
export function downloadedCount(bundle: FileTransferBundle): number {
  return bundle.recipients.filter((r) => !r.revoked_at && r.first_downloaded_at).length;
}

// ── Ontvangers kiezen ────────────────────────────────────────────────────────

export type TransferRecipientOption = {
  /** 'client' of `contact:<id>` */
  key: string;
  kind: 'client' | 'contact';
  contactId: UUID | null;
  name: string;
  email: string;
  role: string | null;
  /** Kan ook op het klantportaal (dan noemt de mail dat). */
  portal: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Wie een zending voor deze klant mag krijgen: het hoofdadres (als dat een
 * geldig adres is) en de actieve contactpersonen. Een contactpersoon met
 * hetzelfde adres als het hoofdadres staat er één keer in — de database zou
 * de tweede toch weigeren.
 */
export function transferRecipientOptions(data: Pick<AppData, 'clients' | 'clientContacts'>, clientId: UUID | null): TransferRecipientOption[] {
  if (!clientId) return [];
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) return [];
  const out: TransferRecipientOption[] = [];
  const seen = new Set<string>();
  const main = String(client.email ?? '').trim().toLowerCase();
  if (EMAIL_RE.test(main)) {
    out.push({
      key: 'client',
      kind: 'client',
      contactId: null,
      name: client.contact_name?.trim() || client.name,
      email: main,
      role: 'Hoofdadres',
      portal: true,
    });
    seen.add(main);
  }
  const contacts = data.clientContacts
    .filter((c: ClientContact) => c.client_id === clientId && c.is_active)
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  for (const contact of contacts) {
    const email = String(contact.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({
      key: `contact:${contact.id}`,
      kind: 'contact',
      contactId: contact.id,
      name: contact.name,
      email,
      role: contact.role ?? null,
      portal: Boolean(contact.gives_portal_access),
    });
  }
  return out;
}

/** Wat de server krijgt voor de gekozen opties (met het adres dat in beeld stond). */
export function recipientInputs(options: TransferRecipientOption[]): Array<Record<string, unknown>> {
  return options.map((option) => option.kind === 'client'
    ? { kind: 'client', expectedEmail: option.email }
    : { kind: 'contact', clientContactId: option.contactId, expectedEmail: option.email });
}

/** Losse adressen (alleen bij een zending zonder klant) uit een invoerveld met komma's of regels. */
export function parseLooseEmails(text: string): { emails: string[]; invalid: string[] } {
  const parts = String(text ?? '').split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (!EMAIL_RE.test(part)) invalid.push(part);
    else if (!emails.includes(part)) emails.push(part);
  }
  return { emails, invalid };
}

// ── Een selectie uit Inhoud ──────────────────────────────────────────────────

export type SelectionSource = { type: DriveShareItemType; id: UUID };

/**
 * Bij welke klant hoort een selectie? Dezelfde afleiding als de database
 * (drive_item_client); de aanroeper geeft die mee als `resolve` — in de app is
 * dat `resolveShareContext` uit shares.ts. `mixed` = twee dossiers door
 * elkaar; dat wordt geen zending.
 */
export function selectionClient(
  sources: SelectionSource[],
  resolve: (type: DriveShareItemType, id: UUID) => { clientId: UUID | null; clientName: string | null },
): { clientId: UUID | null; clientName: string | null; mixed: boolean } {
  const seen = new Map<string, string | null>();
  for (const source of sources) {
    const context = resolve(source.type, source.id);
    seen.set(context.clientId ?? '', context.clientName);
  }
  if (seen.size > 1) return { clientId: null, clientName: null, mixed: true };
  const [entry] = [...seen.entries()];
  if (!entry) return { clientId: null, clientName: null, mixed: false };
  return { clientId: entry[0] || null, clientName: entry[1], mixed: false };
}

// ── Teksten ──────────────────────────────────────────────────────────────────

export function fileCountLabel(count: number): string {
  return count === 1 ? '1 bestand' : `${count} bestanden`;
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

export function transferSummary(transfer: Pick<FileTransfer, 'item_count' | 'total_bytes'>): string {
  return `${fileCountLabel(transfer.item_count)} · ${formatBytes(transfer.total_bytes)}`;
}

/** "nog 12 dagen", "nog 5 uur", "verlopen". */
export function remainingLabel(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'verlopen';
  const hours = ms / 3_600_000;
  if (hours < 24) return `nog ${Math.max(1, Math.round(hours))} uur`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'nog 1 dag' : `nog ${days} dagen`;
}

/** Het onderwerp dat het venster voorstelt. */
export function defaultSubject(input: { firstName: string | null; count: number; clientName: string | null }): string {
  if (input.count === 1 && input.firstName) return input.firstName.slice(0, 200);
  return input.clientName ? `Bestanden voor ${input.clientName}`.slice(0, 200) : 'Bestanden';
}
