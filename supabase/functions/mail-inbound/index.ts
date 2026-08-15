import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// Inkomende e-mail. Drie soorten post komen op het inbound-domein binnen:
//
//   reply+<uuid>@       antwoord op een ResoFly-mail (thread al bekend)
//   organizer+<token>@  RSVP op een agenda-uitnodiging
//   <alias>@            doorgestuurde klantmail — het doorstuuradres van een
//                       organisatie (info@fotograaf.nl -> <alias>@inbound...)
//
// KERNREGEL: de organization_id komt UITSLUITEND uit het ontvangeradres, nooit
// uit de afzender. De oude resolveBySender() zocht over álle organisaties heen
// en was daarmee een cross-tenant-lek.
//
// TWEEDE KERNREGEL: niets verdwijnt stil. Elke mail wordt eerst onvoorwaardelijk
// vastgelegd in inbound_messages; "weggegooid" is een status op een bewaarde rij
// en "niet herkend" is de opvangbak (status='unmatched'), niet /dev/null.
//
// DERDE KERNREGEL: we geven NOOIT 4xx op een inhoudsprobleem. Een 4xx laat de
// Worker bouncen, en Gmail schakelt een doorstuuradres uit na herhaalde
// afleverfouten — één rotbericht zou dan de doorstuurregel stilzetten.

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const MAIL_INBOUND_WEBHOOK_SECRET = Deno.env.get('MAIL_INBOUND_WEBHOOK_SECRET') || '';
const MAIL_INBOUND_ALLOW_UNSIGNED =
  (Deno.env.get('MAIL_INBOUND_ALLOW_UNSIGNED') || 'false').toLowerCase() === 'true';
// Tijdens de uitrol accepteren we ook nog de oude Worker zonder handtekening.
// Zet op true zodra de nieuwe Worker overal draait.
const REQUIRE_SIGNATURE =
  (Deno.env.get('MAIL_INBOUND_REQUIRE_SIGNATURE') || 'false').toLowerCase() === 'true';
// Beoordeeld op de SERVER-omgeving, niet op de Host-header: die komt van de
// afzender en is dus geen controle maar een afgevinkte checklist.
const IS_LOCAL_ENV = /(?:localhost|127\.0\.0\.1|kong)/i.test(SUPABASE_URL);

const MAX_BODY_CHARS = 128 * 1024;

const ALIAS_LOCAL_RE = /^[a-z0-9][a-z0-9-]{0,23}-[a-z2-7]{16}$/;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class InboundError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'InboundError';
    this.status = status;
  }
}

type SenderCandidate = { address: string; name: string; source: string; confidence: string };

type AliasRow = {
  alias_id: string;
  organization_id: string;
  alias_status: string;
  forward_from_email: string | null;
  blocked_senders: string[] | null;
};

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed.' }, 405);
  }
  let rawBody = '';
  try {
    rawBody = await req.text();
    await assertSecret(req, rawBody);
  } catch (error) {
    const status = error instanceof InboundError ? error.status : 500;
    if (status >= 500) console.error('mail-inbound transportfout', errMsg(error));
    return json({ ok: false, error: status === 401 ? 'Niet geautoriseerd.' : 'Inbound niet beschikbaar.' }, status);
  }

  try {
    const body = (JSON.parse(rawBody || '{}')) as Record<string, unknown>;
    const result = await handleInbound(body);
    // Best effort opruimen, ~1 op de 50 verzoeken.
    if (Math.random() < 0.02) {
      supabaseAdmin.rpc('purge_inbound_messages').then(
        () => {},
        (err: unknown) => console.error('mail-inbound: opruimen mislukt', errMsg(err)),
      );
    }
    return json({ ok: true, ...result });
  } catch (error) {
    // Bewust 500 (niet 4xx): de Worker mag hierop opnieuw proberen. Een 4xx zou
    // Cloudflare laten bouncen en de doorstuurregel van de gebruiker slopen.
    console.error('mail-inbound verwerkingsfout', errMsg(error));
    return json({ ok: false, error: 'Inbound verwerking mislukt door een serverfout.' }, 500);
  }
});

async function handleInbound(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const to = String(body.to || '').toLowerCase();
  const aliasLocalPart = String(body.aliasLocalPart || '').toLowerCase();
  const headers = (body.headers && typeof body.headers === 'object')
    ? (body.headers as Record<string, string>)
    : {};

  // 3a. RSVP eerst: die mail is vaak auto-submitted en zou anders sneuvelen op
  // de dropfilter.
  const organizerToken = extractOrganizerToken(to);
  if (organizerToken) {
    const rsvp = await handleRsvp(organizerToken, body);
    if (rsvp) return rsvp;
  }

  // 3b/3c. Route bepalen. Het token komt NOOIT uit body.token: een directe POST
  // met een vreemd token zou anders naar een andere organisatie routeren.
  const replyToken = extractReplyToken(body);
  const origin = replyToken ? await loadOutboundByToken(replyToken) : null;
  const alias = ALIAS_LOCAL_RE.test(aliasLocalPart) ? await resolveAlias(aliasLocalPart) : null;

  if (!origin && !alias) {
    // Geen rij aanmaken: anders schrijft een woordenboekaanval de tabel vol.
    console.log('mail-inbound: onbekende ontvanger', to.slice(0, 120));
    return { skipped: 'unknown_alias' };
  }

  const route: 'alias' | 'reply_token' = origin ? 'reply_token' : 'alias';
  const organizationId = origin ? origin.organization_id : alias!.organization_id;

  // 4. Wijzen token en alias naar verschillende organisaties, dan is er iets
  // grondig mis. Nooit routeren — parkeren.
  let parkReason: string | null = null;
  if (origin && alias && alias.organization_id !== origin.organization_id) {
    parkReason = 'token_org_mismatch';
  }

  // `body.from` is de payload van de VORIGE Worker-versie. Tijdens een uitrol
  // draait die nog even door, en zonder deze terugval zou elk antwoord in die
  // periode als bounce worden weggegooid. Ook daarna blijft dit de juiste
  // verdediging tegen payload-drift.
  const legacyFrom = String(body.from || '').toLowerCase();
  const envelopeFrom = String(body.envelopeFrom || legacyFrom || '').toLowerCase();
  const headerFrom = String(body.headerFrom || legacyFrom || '').toLowerCase();
  const subject = String(body.subject || '').trim();
  const text = typeof body.text === 'string' ? body.text : '';

  // 5. Doorstuurbevestiging van Google/Microsoft. MOET vóór de dropfilter, want
  // die mail komt van een no-reply-adres — anders loopt de gebruiker vast in
  // zijn eigen setup. We bewaren ALLEEN de code, nooit de URL: een klikbare
  // link uit inbound mail in het instellingenscherm is de ideale phishingplek.
  if (alias) {
    const code = extractForwardingConfirmation(headerFrom || envelopeFrom, subject, text);
    if (code) {
      await supabaseAdmin
        .from('organization_inbound_aliases')
        .update({ pending_confirmation_code: code, pending_confirmation_at: new Date().toISOString() })
        .eq('id', alias.alias_id);
      return { skipped: 'forwarding_confirmation' };
    }
  }

  // 6. Kandidatenlijst: de Worker levert de basis, wij vullen aan met het
  // forward-blok, de SRS-decode en de +tag-gestripte varianten.
  const candidates = buildCandidates(body, text, subject, headerFrom);

  // 7. Drop-/parkregels.
  const verdict = classifyInbound(body, headers, route);
  const dropReason = verdict.dropReason ?? null;
  if (!parkReason && verdict.parkReason) parkReason = verdict.parkReason;

  // 8. Reply-token-route: het token is een permanente, overdraagbare
  // schrijfsleutel voor iedereen aan wie de mail ooit is doorgestuurd. Hoort de
  // afzender niet bij deze klant, dan parkeren we.
  if (!dropReason && !parkReason && origin) {
    const belongs = await senderBelongsToClient(origin.organization_id, origin.client_id, candidates);
    if (!belongs) parkReason = 'token_sender_mismatch';
  }

  // 9. Aliasroute: blokkering, rotatie en doorstuurbewijs.
  let forwardingEvidenceValue: string | null = null;
  if (!dropReason && alias && route === 'alias') {
    forwardingEvidenceValue = forwardingEvidence(body, headers, aliasLocalPart, alias);
    const blocked = (alias.blocked_senders ?? []).map((v) => v.toLowerCase());
    const hit = candidates.find((c) => blocked.includes(c.address) || blocked.includes(domainOf(c.address)));
    if (!parkReason && hit) parkReason = 'blocked';
    if (!parkReason && alias.alias_status === 'retiring') parkReason = 'alias_retiring';
    if (!parkReason && !forwardingEvidenceValue) parkReason = 'no_forwarding_evidence';
  }

  // 10/11. Afkappen + dedupsleutel.
  const html = typeof body.html === 'string' && body.html.trim() ? body.html.slice(0, MAX_BODY_CHARS) : null;
  const bodyText = text ? text.slice(0, MAX_BODY_CHARS) : (html ? htmlToText(html) : '');
  const messageId = String(body.messageId || '').trim();
  const rawHash = String(body.rawHash || '').trim();
  const recipient = origin ? `reply+${replyToken}@` : to;
  const dedupKey = buildDedupKey(recipient || to || aliasLocalPart, messageId, rawHash);

  const best = candidates[0] ?? null;

  // 12. Vastleggen + dedupliceren + matchen in één transactie.
  const { data, error } = await supabaseAdmin.rpc('register_inbound_message', {
    p_payload: {
      organization_id: organizationId,
      alias_id: alias?.alias_id ?? null,
      origin_client_email_id: origin?.id ?? null,
      route,
      dedup_key: dedupKey,
      recipient: recipient || to,
      to_display: origin ? origin.from_email : to,
      envelope_from: envelopeFrom || null,
      header_from: headerFrom || null,
      sender_email: best?.address ?? null,
      sender_name: best?.name || String(body.headerFromName || '') || null,
      sender_source: best?.source ?? null,
      sender_confidence: best?.confidence ?? 'low',
      sender_candidates: candidates.map((c) => c.address),
      forwarding_evidence: forwardingEvidenceValue,
      subject,
      body_text: bodyText,
      body_html: html,
      rfc_message_id: messageId || null,
      in_reply_to: String(body.inReplyTo || '') || null,
      reference_ids: Array.isArray(body.references) ? body.references.map(String).slice(0, 50) : [],
      headers,
      attachment_names: Array.isArray(body.attachmentNames) ? body.attachmentNames.map(String).slice(0, 20) : [],
      raw_hash: rawHash || null,
      raw_size: Number(body.rawSize) || null,
      truncated: Boolean(body.truncated),
      received_at: parseDate(body.receivedAt) || new Date().toISOString(),
      drop_reason: dropReason,
      park_reason: parkReason,
      category: verdict.category,
    },
  });
  if (error) throw error;

  // 13. Altijd 200, ook bij parked/dropped/duplicate.
  return (data && typeof data === 'object') ? (data as Record<string, unknown>) : { outcome: 'unknown' };
}

// ── Transport ──────────────────────────────────────────────────────────────

async function assertSecret(req: Request, rawBody: string): Promise<void> {
  if (!MAIL_INBOUND_WEBHOOK_SECRET) {
    if (MAIL_INBOUND_ALLOW_UNSIGNED && IS_LOCAL_ENV) return;
    console.error('mail-inbound: MAIL_INBOUND_WEBHOOK_SECRET ontbreekt.');
    throw new InboundError('Inbound niet beschikbaar.', 503); // geen configuratielek
  }

  const provided = req.headers.get('x-inbound-secret') || '';
  if (!(await timingSafeEqualHashed(provided, MAIL_INBOUND_WEBHOOK_SECRET))) {
    throw new InboundError('Ongeldig of ontbrekend inbound-secret.', 401);
  }

  const ts = req.headers.get('x-inbound-timestamp') || '';
  const sig = req.headers.get('x-inbound-signature') || '';
  if (!ts || !sig) {
    if (REQUIRE_SIGNATURE) throw new InboundError('Ondertekening ontbreekt.', 401);
    return; // overgangsperiode: oude Worker zonder handtekening
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(skew) || skew > 300) throw new InboundError('Verlopen verzoek.', 401);
  const expected = await hmacHex(MAIL_INBOUND_WEBHOOK_SECRET, `${ts}.${rawBody}`);
  if (!(await timingSafeEqualHashed(sig, expected))) {
    throw new InboundError('Ongeldige ondertekening.', 401);
  }
}

// Lengte-orakel vermijden: beide zijden eerst hashen (vaste lengte).
async function timingSafeEqualHashed(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let result = 0;
  for (let i = 0; i < ha.length; i += 1) result |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return result === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Routebepaling ──────────────────────────────────────────────────────────

// Het reply-token staat OOK in de To:/Cc:-headers. Bij reply-all komen twee
// afleveringen binnen met dezelfde Message-ID; alleen op de envelope routeren
// laat de betrouwbaarste route (thread bekend) verliezen van de alias-route.
function extractReplyToken(body: Record<string, unknown>): string | null {
  const haystack = [body.to, body.toHeader, body.ccHeader].map((v) => String(v || '')).join(' ');
  for (const m of haystack.matchAll(/reply\+([0-9a-fA-F-]{36})@/g)) {
    if (isUuid(m[1])) return m[1].toLowerCase();
  }
  return null;
}

function extractOrganizerToken(toField: unknown): string | null {
  const match = String(toField || '').match(/organizer\+([a-z0-9]+)@/i);
  return match ? match[1] : null;
}

async function resolveAlias(localPart: string): Promise<AliasRow | null> {
  const { data, error } = await supabaseAdmin.rpc('resolve_inbound_alias', { p_local_part: localPart });
  if (error) throw error;
  return (Array.isArray(data) && data[0]) ? (data[0] as AliasRow) : null;
}

async function loadOutboundByToken(token: string): Promise<
  { id: string; organization_id: string; client_id: string; thread_id: string; from_email: string } | null
> {
  const { data, error } = await supabaseAdmin
    .from('client_emails')
    .select('id,organization_id,client_id,thread_id,from_email')
    .eq('id', token)
    .eq('direction', 'outbound')
    .maybeSingle();
  if (error) {
    if (/invalid input syntax for type uuid/i.test(`${error.message ?? ''}`)) return null;
    throw error;
  }
  return data ?? null;
}

// Hoort de afzender bij déze klant? Zonder deze check is het reply-token een
// overdraagbare schrijfsleutel: wie de mail doorgestuurd kreeg, kan erop
// antwoorden en schrijft dan in het dossier van een vreemde klant.
async function senderBelongsToClient(
  organizationId: string,
  clientId: string,
  candidates: SenderCandidate[],
): Promise<boolean> {
  const addresses = candidates.map((c) => c.address).filter(Boolean);
  if (addresses.length === 0) return false;

  const { data: client } = await supabaseAdmin
    .from('clients').select('email').eq('id', clientId).eq('organization_id', organizationId).maybeSingle();
  if (client?.email && addresses.includes(String(client.email).toLowerCase())) return true;

  const { data: contacts } = await supabaseAdmin
    .from('client_contacts').select('email')
    .eq('organization_id', organizationId).eq('client_id', clientId).eq('is_active', true);
  const contactEmails = (contacts ?? []).map((c) => String(c.email).toLowerCase());
  return addresses.some((a) => contactEmails.includes(a));
}

// ── Afzenderbepaling ───────────────────────────────────────────────────────

function buildCandidates(
  body: Record<string, unknown>,
  text: string,
  subject: string,
  fallbackFrom: string,
): SenderCandidate[] {
  const raw: SenderCandidate[] = Array.isArray(body.senderCandidates)
    ? (body.senderCandidates as SenderCandidate[]).map((c) => ({
        address: String(c?.address ?? '').toLowerCase(),
        name: String(c?.name ?? ''),
        source: String(c?.source ?? 'header_from'),
        confidence: String(c?.confidence ?? 'low'),
      })).filter((c) => isEmail(c.address))
    : [];

  const out: SenderCandidate[] = [];
  // rfc822-bijlage en header-from behouden hun kop-positie.
  for (const c of raw) {
    if (c.source === 'rfc822_attachment' || c.source === 'header_from') out.push(c);
  }
  // Oude Worker-payload kent senderCandidates niet; dan is het afzenderadres
  // uit `from` het enige dat we hebben.
  if (out.length === 0 && isEmail(fallbackFrom)) {
    out.push({ address: fallbackFrom, name: String(body.fromName ?? ''), source: 'header_from', confidence: 'high' });
  }

  // Handmatig doorgestuurd: het "---------- Doorgestuurd bericht ----------"
  // blok bevat de échte afzender. Alleen relevant als de mail eruitziet als een
  // forward, anders citeert elk gewoon antwoord de vorige afzender.
  if (/^\s*(fwd|fw|wg|doorst)/i.test(subject) || out.length === 0) {
    const fromBlock = extractForwardBlockSender(text);
    if (fromBlock && !out.some((c) => c.address === fromBlock.address)) {
      out.push({ ...fromBlock, source: 'forward_block', confidence: 'medium' });
    }
  }

  // SRS: de envelope is herschreven door de doorsturende server; het originele
  // adres zit erin verpakt.
  const srs = decodeSrs(String(body.envelopeFrom || ''));
  if (srs && !out.some((c) => c.address === srs)) {
    out.push({ address: srs, name: '', source: 'srs_envelope', confidence: 'medium' });
  }

  for (const c of raw) {
    if (c.source !== 'rfc822_attachment' && c.source !== 'header_from'
        && !out.some((o) => o.address === c.address)) out.push(c);
  }

  // +tag-varianten: jan+resofly@bakker.nl matcht anders nooit jan@bakker.nl.
  for (const c of [...out]) {
    const stripped = stripPlusTag(c.address);
    if (stripped !== c.address && !out.some((o) => o.address === stripped)) {
      out.push({ ...c, address: stripped, confidence: 'low' });
    }
  }

  return out.slice(0, 12);
}

// Herkent de forward-koptekst van Gmail, Outlook (web + desktop) en Apple Mail
// in het Nederlands, Engels en Duits.
function extractForwardBlockSender(text: string): { address: string; name: string } | null {
  if (!text) return null;
  const marker = text.search(
    /(-{2,}\s*(forwarded message|doorgestuurd bericht|weitergeleitete nachricht)|begin forwarded message|oorspronkelijk bericht|original message|urspr(ü|u)ngliche nachricht)/i,
  );
  const scope = marker === -1 ? text.slice(0, 2000) : text.slice(marker, marker + 2000);
  const line = scope.match(/^[ \t>]*(?:from|van|von|de)\s*:\s*(.+)$/im);
  if (!line) return null;
  const value = line[1];
  const angle = value.match(/<([^>@\s]+@[^>\s]+)>/);
  const address = (angle?.[1] ?? value.match(/[^\s<>",]+@[^\s<>",]+\.[^\s<>",]+/)?.[0] ?? '').toLowerCase();
  if (!isEmail(address)) return null;
  const name = value.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return { address, name };
}

// SRS0=hash=tt=origineel-domein=origineel-local@doorstuurdomein
// SRS1=hash=eerste-hop==...=origineel-domein=origineel-local@...
function decodeSrs(envelope: string): string | null {
  const value = envelope.toLowerCase();
  const at = value.lastIndexOf('@');
  if (at === -1) return null;
  const local = value.slice(0, at);
  if (!/^srs[01][=+-]/.test(local)) return null;
  const parts = local.split(/[=+-]/).filter(Boolean);
  // De laatste twee onderdelen zijn altijd domein en lokaaldeel.
  if (parts.length < 4) return null;
  const domain = parts[parts.length - 2];
  const user = parts[parts.length - 1];
  const address = `${user}@${domain}`;
  return isEmail(address) ? address : null;
}

function stripPlusTag(address: string): string {
  const at = address.lastIndexOf('@');
  if (at === -1) return address;
  const local = address.slice(0, at);
  const plus = local.indexOf('+');
  return plus === -1 ? address : local.slice(0, plus) + address.slice(at);
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

// ── Drop- en parkregels ────────────────────────────────────────────────────
// `auto-forwarded` staat hier bewust NIET tussen: die waarde betekent "echte
// mail, doorgestuurd". Idem voor X-Auto-Response-Suppress, X-Forwarded-*,
// Resent-From en X-MS-Exchange-*Loop — dat zijn juist de bewijzen dat het
// doorstuuradres wérkt.
function classifyInbound(
  body: Record<string, unknown>,
  h: Record<string, string>,
  route: 'alias' | 'reply_token',
): { dropReason?: string; parkReason?: string; category: 'human' | 'automated' } {
  const auto = (h['auto-submitted'] || '').trim().toLowerCase();
  const envelopeFrom = String(body.envelopeFrom || '').toLowerCase();
  const headerFrom = String(body.headerFrom || '').toLowerCase();
  const fromLocal = (headerFrom || envelopeFrom).split('@')[0].toLowerCase();
  const contentType = (h['content-type'] || '').toLowerCase();

  // DROP
  if (auto === 'auto-replied' || auto === 'auto-notified') return { dropReason: 'auto_replied', category: 'automated' };
  // Een lege envelope is alleen een bounce als er óók geen From-header is.
  // Anders zou een payload zonder envelope-veld elk bericht weggooien.
  if (envelopeFrom === '<>' || (!envelopeFrom && !headerFrom)) return { dropReason: 'bounce_null_sender', category: 'automated' };
  if (contentType.includes('multipart/report')
      && /(delivery-status|disposition-notification)/.test(contentType)) return { dropReason: 'dsn', category: 'automated' };
  if (/^(mailer-daemon|postmaster|mail-delivery-subsystem)$/.test(fromLocal)) return { dropReason: 'mailer_daemon', category: 'automated' };
  if (h['x-failed-recipients']) return { dropReason: 'failed_recipients', category: 'automated' };
  if (h['x-resofly-loop']) return { dropReason: 'own_loop', category: 'automated' };
  if (Number(body.receivedCount ?? 0) > 25) return { dropReason: 'hop_limit', category: 'automated' };

  // Op de reply-route is de thread expliciet bekend; een out-of-office of
  // bulkbericht in een lopend gesprek hoort gewoon in het dossier.
  if (route === 'reply_token') return { category: 'human' };

  // PARK
  const precedence = (h['precedence'] || '').trim().toLowerCase();
  if (auto === 'auto-generated') return { parkReason: 'auto_generated', category: 'automated' };
  if (h['x-autoreply'] || h['x-autorespond'] || precedence === 'auto_reply') return { parkReason: 'autoresponder', category: 'automated' };
  if (h['list-id'] || h['list-unsubscribe'] || ['bulk', 'list', 'junk'].includes(precedence)) return { parkReason: 'bulk', category: 'automated' };
  if (/(no-?reply|do-?not-?reply)/.test(fromLocal)) return { parkReason: 'noreply_sender', category: 'automated' };
  if (body.hasTnef) return { parkReason: 'tnef', category: 'human' };
  if (body.truncated) return { parkReason: 'oversized', category: 'human' };
  if (body.parseError) return { parkReason: 'parse_error', category: 'human' };
  return { category: 'human' };
}

// Goedkope drempel tegen ONGERICHTE injectie. Nadrukkelijk GEEN beveiliging:
// al deze headers zijn vrij door de afzender te zetten. Een gerichte aanvaller
// wordt tegengehouden door de gevolgbeperking (geen push, geen campagnetrigger,
// verwijderknop, herkomstlabel), niet hierdoor.
function forwardingEvidence(
  body: Record<string, unknown>,
  h: Record<string, string>,
  aliasLocalPart: string,
  alias: AliasRow,
): string | null {
  const alias0 = `${aliasLocalPart}@`;
  const src = (alias.forward_from_email || '').toLowerCase();
  if ((h['x-forwarded-to'] || '').toLowerCase().includes(alias0)) return 'x_forwarded_to';
  if ((h['delivered-to'] || '').toLowerCase().includes(alias0)) return 'delivered_to';
  if (src && (h['x-forwarded-for'] || '').toLowerCase().includes(src)) return 'x_forwarded_for';
  if (src && (h['x-original-to'] || '').toLowerCase().includes(src)) return 'x_original_to';
  if (/(\+SRS=|^SRS[01][=+-])/i.test(String(body.envelopeFrom || ''))) return 'srs_envelope';
  if (h['resent-from'] || h['resent-sender']) return 'resent_from';
  if (h['x-ms-exchange-forwardingloop'] || h['x-ms-exchange-inbox-rules-loop']) return 'ms_exchange_forward';
  return null;
}

// ── Doorstuurbevestiging ───────────────────────────────────────────────────
// Google en Microsoft sturen een bevestiging naar het doorstuuradres voordat
// doorsturen actief wordt. Zonder deze herkenning parkeert die mail als
// 'noreply_sender' en komt de gebruiker nooit door zijn eigen setup heen.
// We halen ALLEEN de code eruit — nooit de bevestigings-URL.
function extractForwardingConfirmation(from: string, subject: string, text: string): string | null {
  const isGoogle = /@google\.com$/.test(from) || /forwarding-noreply@google\.com/.test(from);
  const looksLikeConfirmation =
    /(forwarding confirmation|doorschakelingsbevestiging|bevestiging.*doorsturen|verification code|bevestigingscode)/i.test(subject);
  if (!isGoogle && !looksLikeConfirmation) return null;
  const code = text.match(/\b(\d{6,12})\b/);
  return code ? code[1] : null;
}

// ── Dedup-sleutel ──────────────────────────────────────────────────────────
// De inhoudshash zit er bewust in: mail zónder Message-ID dedupt daardoor
// alsnog, en een aanvaller die de Message-ID van een echt bericht hergebruikt
// verdringt dat bericht niet — dat wordt een detecteerbaar conflict.
function buildDedupKey(recipient: string, messageId: string, rawHash: string): string {
  const at = recipient.lastIndexOf('@');
  let local = at === -1 ? recipient : recipient.slice(0, at);
  const domain = at === -1 ? '' : recipient.slice(at);
  if (!/^reply\+/.test(local) && !/^organizer\+/.test(local)) {
    const plus = local.indexOf('+');
    if (plus !== -1) local = local.slice(0, plus);
  }
  return `${(local + domain).toLowerCase()}|${(messageId || '').trim()}|${rawHash || '-'}`;
}

// ── RSVP op agenda-uitnodigingen (iMIP REPLY) ──────────────────────────────

async function handleRsvp(organizerToken: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const calendar = String(body.calendar || '');
  if (!calendar || !/METHOD:REPLY/i.test(calendar)) return null;

  const { data: event, error: eventError } = await supabaseAdmin
    .from('calendar_events')
    .select('id,organization_id')
    .eq('organizer_token', organizerToken)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) return { skipped: 'rsvp_no_event' };

  const reply = parseIcsReply(calendar);
  if (!reply) return { skipped: 'rsvp_unparsable' };

  // Genodigde matchen: bij voorkeur op het ATTENDEE-adres uit de REPLY, anders
  // op de afzender van de mail.
  const candidateEmail = reply.email || normalizeEmail(body.headerFrom || body.envelopeFrom);
  if (!isEmail(candidateEmail)) return { skipped: 'rsvp_no_attendee' };

  const { data: attendee, error: attendeeError } = await supabaseAdmin
    .from('calendar_event_attendees')
    .select('id')
    .eq('event_id', event.id)
    .ilike('email', candidateEmail)
    .maybeSingle();
  if (attendeeError) throw attendeeError;
  if (!attendee) return { skipped: 'rsvp_unknown_attendee' };

  const status = partstatToStatus(reply.partstat);
  await supabaseAdmin
    .from('calendar_event_attendees')
    .update({ status, responded_at: new Date().toISOString() })
    .eq('id', attendee.id);

  return { rsvp: status, eventId: event.id, attendeeId: attendee.id };
}

function parseIcsReply(ics: string): { email: string; partstat: string } | null {
  // Line-unfolding (RFC 5545: vervolgregel begint met spatie of tab).
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    if (/^ATTENDEE/i.test(line)) {
      const emailMatch = line.match(/mailto:([^;:>\s]+)/i);
      const partstatMatch = line.match(/PARTSTAT=([A-Za-z-]+)/i);
      if (emailMatch) {
        return { email: emailMatch[1].trim().toLowerCase(), partstat: (partstatMatch?.[1] || 'NEEDS-ACTION').toUpperCase() };
      }
    }
  }
  return null;
}

function partstatToStatus(partstat: string): 'accepted' | 'declined' | 'tentative' | 'needs-action' {
  switch (partstat.toUpperCase()) {
    case 'ACCEPTED': return 'accepted';
    case 'DECLINED': return 'declined';
    case 'TENTATIVE': return 'tentative';
    default: return 'needs-action';
  }
}

// ── Hulpjes ────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseDate(value: unknown): string | null {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
