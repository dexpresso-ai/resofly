// ============================================================
// Verzenddomeinen bij Resend: invoer, status en afzender.
//
// Puur, zonder imports, zodat `npm test` er rechtstreeks overheen draait
// (resendDomains.test.ts). De mail-functie (domein koppelen, verifiëren,
// afzender wijzigen), resend-webhook (domain.updated) en sendingDomain.ts
// (afzender kiezen bij het versturen) gebruiken dezelfde regels.
// ============================================================

/** De status zoals ResoFly die bewaart. Alleen `verified` mag versturen. */
export type SendingDomainStatus = 'pending' | 'verified' | 'failed' | 'temporary_failure';

type RecordLike = { record?: unknown; status?: unknown };

function recordKind(record: RecordLike): string {
  return String(record.record ?? '').trim().toLowerCase();
}

function recordStatus(record: RecordLike): string {
  return String(record.status ?? '').trim().toLowerCase();
}

/** De records waarmee Resend namens het domein verstuurt: SPF (return-path) en DKIM. */
function sendingRecords(records: unknown): RecordLike[] {
  if (!Array.isArray(records)) return [];
  return records.filter((record): record is RecordLike =>
    !!record && typeof record === 'object' && ['spf', 'dkim'].includes(recordKind(record as RecordLike)));
}

/**
 * Vertaalt de domeinstatus van Resend naar die van ResoFly.
 *
 * Resend kent naast pending/verified/failed sinds de ontvangstfunctie ook
 * `partially_verified` en `partially_failed`: een deel van de records klopt.
 * Die kwamen hier eerst als "pending" binnen, ook als het domein al kon
 * versturen. Wij zetten ontvangen uit, dus zijn SPF en DKIM allebei
 * geverifieerd, dan kan het domein versturen, wat er verder ook hapert.
 * `temporary_failure` is bij Resend inmiddels een status per record: een
 * record dat eerst klopte, wordt even niet gevonden. Dan versturen we tijdelijk
 * vanaf het standaardadres in plaats van met een DKIM-handtekening die niet
 * meer klopt.
 */
export function sendingDomainStatus(resendStatus: unknown, records: unknown): SendingDomainStatus {
  const status = String(resendStatus ?? '').trim().toLowerCase();
  if (status === 'verified') return 'verified';

  const sending = sendingRecords(records);
  const complete = sending.some((record) => recordKind(record) === 'dkim')
    && sending.some((record) => recordKind(record) === 'spf')
    && sending.every((record) => recordStatus(record) === 'verified');
  if ((status === 'partially_verified' || status === 'partially_failed') && complete) return 'verified';

  if (status === 'failed') return 'failed';
  if (status === 'temporary_failure' || sending.some((record) => recordStatus(record) === 'temporary_failure')) {
    return 'temporary_failure';
  }
  if (status === 'partially_failed') return 'failed';
  // not_started, pending, partially_verified zonder volledige SPF en DKIM, en
  // alles wat Resend later nog bedenkt: nog niet klaar om te versturen.
  return 'pending';
}

/**
 * Wat iemand in het veld "Domein" typt, als kale domeinnaam:
 * `https://www.Bücher.nl/contact` → `xn--bcher-kva.nl`, `info@voorbeeld.nl` →
 * `voorbeeld.nl`. Geeft '' terug als er geen domeinnaam van te maken is.
 */
export function normalizeSendingDomainInput(value: unknown): string {
  let text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  // Een e-mailadres in het domeinveld: het domein erachter is bedoeld.
  if (!text.includes('://') && text.includes('@')) text = text.slice(text.lastIndexOf('@') + 1);
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  text = text.replace(/\.+$/, '').replace(/^www\./, '');
  if (!text || /\s/.test(text)) return '';
  try {
    // De URL-parser zet een domein met accenten om naar de punycode die DNS en
    // Resend verwachten (bücher.nl → xn--bcher-kva.nl).
    return new URL(`http://${text}`).hostname.replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** Minstens twee labels, alleen letters, cijfers en koppeltekens, met een echte TLD. */
export function isValidSendingDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(value);
}

/**
 * Een kaal e-mailadres dat zonder aanhalingstekens in een From-header past
 * (RFC 5322 dot-atom). Geen spaties, komma's, hoekhaken of aanhalingstekens:
 * met zulke tekens kon een adres als `a>,"x" <ceo@ander.nl` een tweede afzender
 * in de header smokkelen, en alle organisaties delen één Resend-account waarin
 * ook de domeinen van anderen geverifieerd zijn.
 */
export function isPlainEmailAddress(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at > 64) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local)
    && isValidSendingDomain(domain.toLowerCase());
}

/**
 * Het afzenderadres voor een domein: kleine letters, kaal en precies op
 * `@domein`. Geeft de reden terug als het niet klopt, zodat de mail-functie de
 * melding kan tonen.
 */
export function checkSenderAddress(value: unknown, domain: string): { email: string } | { error: string } {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return { error: `Vul het afzenderadres in, bijvoorbeeld info@${domain}.` };
  if (!isPlainEmailAddress(email)) {
    return { error: 'Het afzenderadres is geen geldig e-mailadres. Gebruik alleen letters, cijfers en tekens als . - _ + vóór de @.' };
  }
  if (email.slice(email.lastIndexOf('@') + 1) !== domain) {
    return { error: `Het afzenderadres moet op @${domain} eindigen.` };
  }
  return { email };
}

/**
 * De naam boven het afzenderadres, veilig voor de From-header. Een beheerder of
 * teamlid typt hem zelf: zonder aanhalingstekens, hoekhaken, komma's,
 * regeleinden of onzichtbare tekens die de leesrichting omdraaien, zodat hij
 * nooit een tweede adres kan worden. Ook zonder @: een naam als
 * "support@bank.nl" boven een heel ander adres is een bekende phishingtruc.
 */
export function cleanSenderName(value: unknown, maxLength = 80): string | null {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(/["<>,@\\\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned || null;
}

/** `"Naam" <adres>`, of alleen het adres als er geen naam is. */
export function formatFromHeader(name: unknown, email: string): string {
  const safeName = cleanSenderName(name);
  return safeName ? `"${safeName}" <${email}>` : email;
}

/** Hoe lang een nooit geverifieerde koppeling een domein vasthoudt voor andere werkruimtes. */
export const UNVERIFIED_CLAIM_DAYS = 7;

export type DomainClaimRow = {
  organization_id: string;
  domain: string;
  status: string;
  verified_at: string | null;
  created_at: string;
};

export type DomainClaimVerdict =
  | { kind: 'free' }
  | { kind: 'own' }
  | { kind: 'taken' }
  | { kind: 'claimed_until'; until: string }
  | { kind: 'take_over' };

/**
 * Mag een organisatie dit domein koppelen, gezien de bestaande koppelingen die
 * erop lijken (hetzelfde domein, een bovenliggend domein of een subdomein)?
 *
 * Alle organisaties delen één Resend-account, dus een domein hoort bij hooguit
 * één organisatie. Tot nu toe hield elke koppeling een domein voor altijd vast,
 * ook als hij nooit geverifieerd werd. Wie het domein van een ander als eerste
 * invoerde, blokkeerde de echte eigenaar dus voorgoed. Nu geldt:
 *
 * - een koppeling die ooit geverifieerd is, hoort bij die organisatie (en
 *   blokkeert ook boven- en onderliggende domeinen, zie domainOverlap.ts);
 * - een koppeling die nooit geverifieerd is, houdt alleen hetzelfde domein vast,
 *   en dat UNVERIFIED_CLAIM_DAYS dagen. Daarna mag een andere organisatie het
 *   overnemen. Resend zelf stopt na 72 uur met controleren.
 *
 * `overlapping` bevat alleen rijen waarvan het domein gelijk is aan, of boven of
 * onder, `domain` ligt (de mail-functie zoekt ze zo op).
 */
export function judgeDomainClaim(
  organizationId: string,
  domain: string,
  overlapping: DomainClaimRow[],
  now: Date = new Date(),
): DomainClaimVerdict {
  const same = (row: DomainClaimRow) => String(row.domain).trim().toLowerCase().replace(/\.+$/, '') === domain;
  if (overlapping.some((row) => row.organization_id === organizationId && same(row))) return { kind: 'own' };

  const others = overlapping.filter((row) => row.organization_id !== organizationId);
  const proven = (row: DomainClaimRow) => row.status === 'verified' || !!row.verified_at;
  if (others.some(proven)) return { kind: 'taken' };

  const exact = others.find(same);
  if (!exact) return { kind: 'free' };
  const created = Date.parse(exact.created_at);
  const until = new Date((Number.isFinite(created) ? created : now.getTime()) + UNVERIFIED_CLAIM_DAYS * 86_400_000);
  if (until.getTime() > now.getTime()) return { kind: 'claimed_until', until: until.toISOString() };
  return { kind: 'take_over' };
}
