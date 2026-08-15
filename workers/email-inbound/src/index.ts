import PostalMime from 'postal-mime';
import type { Attachment, Email, RawEmail } from 'postal-mime';

export interface Env {
  /** URL van de Supabase mail-inbound Edge Function. */
  MAIL_INBOUND_ENDPOINT: string;
  /** Gedeeld secret (wrangler secret put MAIL_INBOUND_SECRET). */
  MAIL_INBOUND_SECRET: string;
  /** Inbound-domein, bijv. inbound.resofly.com (informatief/loggen). */
  INBOUND_DOMAIN: string;
}

// Cloudflare Email Worker. Vangt drie soorten post op het inbound-domein:
//   reply+<uuid>@      antwoord op een ResoFly-mail
//   organizer+<token>@ RSVP op een agenda-uitnodiging
//   <alias>@           doorgestuurde klantmail (het doorstuuradres van een org)
//
// De Worker VERZAMELT feiten uit de MIME en beslist niets: alle beleidsregels
// (drop/park/matching) staan in de edge function, want die is in seconden te
// herdeployen en deze Worker niet.

const MAX_FULL_PARSE_BYTES = 12 * 1024 * 1024; // daarboven: alleen de kop
const HEADER_ONLY_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 128 * 1024;

const ALIAS_LOCAL = /^[a-z0-9][a-z0-9-]{0,23}-[a-z2-7]{16}$/;

// postal-mime: opties horen in de CONSTRUCTOR. `new PostalMime().parse(raw, opts)`
// compileert niet — de instance-parse neemt alleen het bericht. Met
// attachmentEncoding 'arraybuffer' is attachment.content altijd een ArrayBuffer,
// zodat de geneste rfc822-parse hieronder niet hoeft te raden.
const PARSE_OPTIONS = { forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' } as const;

// Headers die we bewaren. Alles daarbuiten gooien we weg: een aanvaller kan
// onbeperkt eigen headers meesturen en die zouden anders de opslag opblazen.
const KEEP_HEADERS = [
  'auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'x-loop',
  'x-auto-response-suppress', 'list-id', 'list-unsubscribe', 'x-failed-recipients',
  'x-forwarded-for', 'x-forwarded-to', 'delivered-to', 'resent-from', 'resent-sender',
  'x-ms-exchange-inbox-rules-loop', 'x-ms-exchange-forwardingloop', 'x-resofly-loop',
  'content-type', 'return-path', 'reply-to', 'x-original-to', 'x-spam-flag',
  'x-cf-spamh-score', 'date', 'to', 'cc',
];

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = String(message.to ?? '').toLowerCase();
    const local = localPart(to);

    // Syntaxpoort: woordenboekspam op de catch-all komt Supabase niet binnen.
    if (!/^reply\+/.test(local) && !/^organizer\+/.test(local) && !ALIAS_LOCAL.test(stripTag(local))) {
      message.setReject('550 5.1.1 Unknown recipient');
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = await buildPayload(message, to, local);
    } catch (error) {
      // Parsefout mag nooit betekenen dat de mail verdwijnt: stuur een
      // minimale payload zodat er in elk geval een rij ontstaat.
      console.error('email-inbound: parse mislukt', errMsg(error));
      payload = {
        to,
        aliasLocalPart: stripTag(local),
        envelopeFrom: String(message.from ?? '').toLowerCase(),
        headerFrom: '',
        senderCandidates: [],
        rawSize: message.rawSize,
        parseError: errMsg(error).slice(0, 300),
        receivedAt: new Date().toISOString(),
      };
    }

    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmacHex(env.MAIL_INBOUND_SECRET, `${timestamp}.${body}`);

    const response = await fetch(env.MAIL_INBOUND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-inbound-secret': env.MAIL_INBOUND_SECRET,
        'x-inbound-timestamp': timestamp,
        'x-inbound-signature': signature,
      },
      body,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // ALLEEN bij 5xx gooien. Bij een 4xx slaagt een retry per definitie nooit
      // en bouncet Cloudflare uiteindelijk — waarna Gmail de doorstuurregel van
      // de gebruiker uitschakelt. Dat is erger dan één verloren bericht.
      if (response.status >= 500) {
        throw new Error(`mail-inbound gaf ${response.status}: ${detail.slice(0, 200)}`);
      }
      console.error(`email-inbound: mail-inbound gaf ${response.status}: ${detail.slice(0, 200)}`);
    }
  },
};

async function buildPayload(
  message: ForwardableEmailMessage,
  to: string,
  local: string,
): Promise<Record<string, unknown>> {
  const truncated = message.rawSize > MAX_FULL_PARSE_BYTES;
  const raw = await readRaw(message.raw, truncated ? HEADER_ONLY_BYTES : message.rawSize);
  const rawHash = await sha256Hex(raw);
  const parsed = await new PostalMime(PARSE_OPTIONS).parse(raw);

  const headers = pickHeaders(parsed);
  const nested = await parseNested(parsed);

  const envelopeFrom = String(message.from ?? '').toLowerCase();
  const headerFrom = String(parsed.from?.address ?? '').toLowerCase();
  const replyTo = String((parsed.replyTo ?? [])[0]?.address ?? '').toLowerCase();

  // Geordend op betrouwbaarheid. De edge function slaat eigen adressen over en
  // voegt het forward-blok en de SRS-decode op de juiste plek in.
  const candidates: Array<{ address: string; name: string; source: string; confidence: string }> = [];
  if (nested?.from) candidates.push({ address: nested.from, name: nested.fromName ?? '', source: 'rfc822_attachment', confidence: 'high' });
  if (headerFrom) candidates.push({ address: headerFrom, name: parsed.from?.name ?? '', source: 'header_from', confidence: 'high' });
  if (replyTo) candidates.push({ address: replyTo, name: '', source: 'reply_to', confidence: 'low' });
  if (envelopeFrom) candidates.push({ address: envelopeFrom, name: '', source: 'envelope', confidence: 'low' });

  const attachments = parsed.attachments ?? [];

  return {
    to,
    aliasLocalPart: stripTag(local),
    // toHeader/ccHeader: het reply+<uuid>-token staat OOK hierin. Zonder deze
    // twee wint bij reply-all de alias-route van de reply-route en belandt het
    // antwoord in de verkeerde thread.
    toHeader: headers['to'] ?? '',
    ccHeader: headers['cc'] ?? '',
    envelopeFrom,
    headerFrom,
    headerFromName: parsed.from?.name ?? '',
    replyTo,
    senderCandidates: candidates,
    nested,
    subject: (nested?.subject || parsed.subject || '').slice(0, 998),
    text: (parsed.text ?? '').slice(0, MAX_BODY_CHARS),
    html: (typeof parsed.html === 'string' ? parsed.html : '').slice(0, MAX_BODY_CHARS),
    calendar: extractCalendar(parsed),
    messageId: nested?.messageId || parsed.messageId || '',
    inReplyTo: parsed.inReplyTo || '',
    references: parseIds(parsed.references ?? ''),
    headers,
    receivedCount: countReceived(parsed),
    attachmentNames: attachments.map((a) => String(a.filename ?? '')).filter(Boolean).slice(0, 20),
    hasTnef: attachments.some((a) =>
      /ms-tnef/i.test(String(a.mimeType ?? '')) || /winmail\.dat$/i.test(String(a.filename ?? ''))),
    rawSize: message.rawSize,
    rawHash,
    truncated,
    parseError: null,
    receivedAt: new Date().toISOString(),
  };
}

// Genest origineel bij "Doorsturen als bijlage" — de betrouwbaarste bron die er
// is, want de originele headers zitten er ongeschonden in.
async function parseNested(parsed: Email) {
  for (const att of parsed.attachments ?? []) {
    const mime = String(att.mimeType ?? '').toLowerCase();
    const name = String(att.filename ?? '').toLowerCase();
    if (!mime.includes('message/rfc822') && !name.endsWith('.eml')) continue;
    try {
      // att.content is dankzij PARSE_OPTIONS een ArrayBuffer; RawEmail accepteert
      // die rechtstreeks. Nooit door String() halen — dat maakt er
      // "[object ArrayBuffer]" van en de parse levert dan stilletjes niets op.
      const inner = await new PostalMime().parse(att.content as RawEmail);
      return {
        from: String(inner.from?.address ?? '').toLowerCase(),
        fromName: inner.from?.name ?? '',
        subject: inner.subject ?? '',
        date: inner.date ?? '',
        messageId: inner.messageId ?? '',
      };
    } catch (error) {
      console.error('email-inbound: geneste rfc822-parse mislukt', errMsg(error));
    }
  }
  return null;
}

function pickHeaders(parsed: Email): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of parsed.headers ?? []) {
    const key = String(h.key ?? '').toLowerCase();
    if (!KEEP_HEADERS.includes(key)) continue;
    const value = String(h.value ?? '').slice(0, 1024);
    out[key] = out[key] ? `${out[key]}, ${value}`.slice(0, 1024) : value;
  }
  return out;
}

function countReceived(parsed: Email): number {
  return (parsed.headers ?? []).filter((h) => String(h.key ?? '').toLowerCase() === 'received').length;
}

function localPart(address: string): string {
  const at = address.lastIndexOf('@');
  return (at === -1 ? address : address.slice(0, at)).toLowerCase();
}

// Subadressering strippen: anders is de dedup met een enkele `+` uit te zetten.
function stripTag(local: string): string {
  if (/^reply\+/.test(local) || /^organizer\+/.test(local)) return local;
  const plus = local.indexOf('+');
  return plus === -1 ? local : local.slice(0, plus);
}

function parseIds(value: string): string[] {
  return (value.match(/<[^>]+>/g) ?? []).slice(0, 50);
}

async function readRaw(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const take = Math.min(value.length, limit - total);
    if (take > 0) { chunks.push(value.subarray(0, take)); total += take; }
    if (total >= limit) { await reader.cancel().catch(() => {}); break; }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractCalendar(parsed: Email): string {
  for (const att of parsed.attachments ?? []) {
    const mime = String(att.mimeType ?? '').toLowerCase();
    const name = String(att.filename ?? '').toLowerCase();
    if (mime.includes('text/calendar') || mime.includes('application/ics') || name.endsWith('.ics')) {
      return attachmentToString(att.content);
    }
  }
  return '';
}

function attachmentToString(content: Attachment['content']): string {
  if (typeof content === 'string') {
    if (content.includes('BEGIN:VCALENDAR')) return content;
    try {
      const decoded = atob(content);
      if (decoded.includes('BEGIN:VCALENDAR')) return decoded;
    } catch { /* niet base64 */ }
    return content;
  }
  if (content instanceof ArrayBuffer) return new TextDecoder().decode(content);
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return '';
}
