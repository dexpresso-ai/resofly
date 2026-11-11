/**
 * Een nieuwe klant uit een binnengekomen mail.
 *
 * In de opvangbak lag post van iemand die nog geen klant was. Je kon die mail
 * alleen aan een BESTAANDE klant koppelen; voor een nieuwe klant ging je naar
 * Klanten, typte je naam, adres en telefoon over uit de handtekening en kwam je
 * terug om te koppelen. Deze functie doet het overtypen: ze leest wat er in de
 * mail staat en geeft beginwaarden voor het klantformulier.
 *
 * Bewust zonder AI. Het is direct, kost niets, gaat niet buiten de deur en doet
 * elke keer hetzelfde. Wat ze niet zeker weet, laat ze leeg; de gebruiker ziet
 * alles in het formulier en slaat zelf op. Een mail kan dus nooit zelf een klant
 * aanmaken, ook niet met tekst die zich als opdracht voordoet.
 *
 * Drie soorten mail komen hier langs:
 *  - een gewone mail met een handtekening ("Jan de Vries · Bakker Fotografie B.V.
 *    · 06-12345678 · Dorpsstraat 1, 1234 AB Utrecht · KvK 12345678");
 *  - een contactformulier van een website ("Naam: …", "E-mail: …", "Telefoon: …"),
 *    vaak van een no-reply-adres: de afzender is dan de website, niet de klant;
 *  - een doorgestuurde mail ("Fwd: …"), waarin het eigen bericht van de
 *    doorsturende collega en zijn eigen handtekening bóven het origineel staan.
 *
 * Wat NIET mag gebeuren: de gegevens van de eigen organisatie overnemen. Onder
 * een antwoord staat de eerdere mail van de organisatie geciteerd, mét haar eigen
 * handtekening; toen een eerste versie daar niet op lette, kreeg een nieuwe klant
 * het KvK-nummer en telefoonnummer van het bureau zelf. Daarom: geciteerde tekst
 * eraf, en alles wat gelijk is aan de eigen gegevens (`OwnDetails`) telt niet.
 *
 * Puur (alleen types), zodat `node --test` er rechtstreeks overheen draait
 * (clientFromEmail.test.ts).
 */
import type { ClientKind } from '../types.ts';

export interface ClientEmailSource {
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  bodyText: string | null;
  receivedAt?: string | null;
}

/** De eigen organisatie. Wat hierop lijkt, hoort niet bij de nieuwe klant. */
export interface OwnDetails {
  emails?: Array<string | null | undefined>;
  /** Websites of domeinen (`www.studio.nl`, `https://studio.nl/contact`, `studio.nl`). */
  websites?: Array<string | null | undefined>;
  phones?: Array<string | null | undefined>;
  kvkNumbers?: Array<string | null | undefined>;
  vatNumbers?: Array<string | null | undefined>;
  postalCodes?: Array<string | null | undefined>;
  names?: Array<string | null | undefined>;
}

/** Wat er uit de tekst van de mail kwam, voor de melding boven het formulier. */
export type ClientDraftField =
  | 'company' | 'contact_name' | 'email' | 'phone' | 'address' | 'kvk_number' | 'vat_number' | 'website';

export const CLIENT_DRAFT_FIELD_LABELS: Record<ClientDraftField, string> = {
  company: 'bedrijfsnaam',
  contact_name: 'contactpersoon',
  email: 'e-mailadres',
  phone: 'telefoon',
  address: 'adres',
  kvk_number: 'KvK-nummer',
  vat_number: 'btw-nummer',
  website: 'website',
};

export interface ClientDraftValues {
  name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  status: 'prospect';
  client_kind: ClientKind;
  address_line1?: string;
  postal_code?: string;
  city?: string;
  country?: string;
  kvk_number?: string;
  vat_number?: string;
  notes: string;
}

export interface ClientDraft {
  values: ClientDraftValues;
  /** Velden die uit de tekst van de mail kwamen (niet alleen uit de afzender). */
  found: ClientDraftField[];
  /**
   * Is het opgeslagen afzenderadres van de klant zelf? Nee bij een
   * contactformulier (dan mailt de website), een no-reply-adres of een mail die
   * een collega doorstuurde. Alleen dan mag "onthoud dit adres" het afzenderadres
   * aan de klant hangen; anders kwam elk volgend formulier van die website, of
   * elke doorgestuurde mail van die collega, bij deze ene klant terecht.
   */
  senderIsContact: boolean;
}

// ── Vaste lijsten ──────────────────────────────────────────────────────────

/** Gelijk aan public.is_freemail_domain in de database. */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.be', 'outlook.de',
  'hotmail.com', 'hotmail.nl', 'hotmail.be', 'hotmail.co.uk', 'live.nl', 'live.com', 'live.be',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr',
  'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'casema.nl', 'home.nl', 'xs4all.nl', 'telfort.nl',
  'chello.nl', 'upcmail.nl', 'hetnet.nl', 'online.nl', 'quicknet.nl', 'zeelandnet.nl',
  'telenet.be', 'skynet.be', 'proximus.be', 'gmx.net', 'gmx.com', 'gmx.de', 'web.de',
  't-online.de', 'mail.com', 'zoho.com', 'protonmail.com', 'proton.me', 'aol.com',
]);

/** Postvakken die geen persoon zijn: daar maak je geen naam van. */
const GENERIC_LOCAL_PARTS = new Set([
  'info', 'contact', 'hallo', 'hello', 'hi', 'mail', 'post', 'office', 'kantoor', 'admin', 'administratie',
  'boekhouding', 'finance', 'factuur', 'facturen', 'invoice', 'invoices', 'sales', 'verkoop', 'support',
  'service', 'klantenservice', 'team', 'studio', 'receptie', 'secretariaat', 'inkoop', 'marketing', 'hr',
  'vacatures', 'jobs', 'webmaster', 'website', 'wordpress', 'formulier', 'forms', 'noreply', 'no-reply',
  'donotreply', 'do-not-reply', 'mailer', 'notifications', 'notification', 'bounce', 'postmaster',
]);

const NO_REPLY_RE = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?|wordpress|formulier|forms?)([._+-]|$)/i;

/** Rechtsvormen aan het eind van een regel: "Bakker Fotografie B.V.". */
const LEGAL_FORM_END_RE = /\s(b\.?\s?v\.?|v\.?o\.?f\.?|n\.?v\.?|holding|gmbh|ltd\.?|limited|bvba|bv\s?ba|srl|sarl|inc\.?|llc|ug)\s*$/i;
const LEGAL_FORM_START_RE = /^(stichting|vereniging|coöperatie|cooperatie|maatschap)\s+\S/i;

const NAME_PARTICLES = new Set(['van', 'de', 'der', 'den', 'het', 'ten', 'ter', 'te', 'in', "'t", 'op', 'von', 'du', 'la', 'le']);

// ── Ingang ─────────────────────────────────────────────────────────────────

export function clientDraftFromEmail(source: ClientEmailSource, own: OwnDetails = {}): ClientDraft {
  const ownSet = normalizeOwn(own);
  const message = readMailBody(source.bodyText ?? '', source.subject ?? '');
  const body = message.text;
  const lines = body.split('\n').map(line => line.trim());

  // Een collega die een mail doorstuurt, is de afzender van de doorgestuurde
  // mail; de klant staat in het kopblok ("Van: Jan <jan@x.nl>"). Zonder deze
  // stap werd de collega de contactpersoon van de nieuwe klant.
  const storedSender = cleanEmail(source.senderEmail);
  let senderEmail = storedSender;
  let rawSenderName = source.senderName;
  const original = message.forwardedFrom;
  if (original && original.email !== senderEmail && !isOwnEmail(original.email, ownSet) && !looksAutomated(original.email)) {
    senderEmail = original.email;
    rawSenderName = original.name ?? null;
  }
  const senderName = cleanDisplayName(rawSenderName, senderEmail);
  const labeled = readLabeledFields(lines);
  const found = new Set<ClientDraftField>();

  const senderUsable = Boolean(senderEmail) && !looksAutomated(senderEmail!) && !isOwnEmail(senderEmail!, ownSet);

  // E-mail: een ingevuld formulierveld wint; dan de afzender; dan een adres in de tekst.
  let email: string | undefined;
  let senderIsContact = false;
  const labeledEmail = labeled.email.map(cleanEmail).find((value): value is string =>
    Boolean(value) && !looksAutomated(value!) && !isOwnEmail(value!, ownSet));
  if (labeledEmail) {
    email = labeledEmail;
    senderIsContact = labeledEmail === storedSender;
    if (labeledEmail !== senderEmail) found.add('email');
  } else if (senderUsable) {
    email = senderEmail!;
    // Bij een doorgestuurde mail is het opgeslagen afzenderadres dat van de collega.
    senderIsContact = senderEmail === storedSender;
  } else {
    const inText = findEmails(body).find(value => !looksAutomated(value) && !isOwnEmail(value, ownSet) && value !== senderEmail);
    if (inText) { email = inText; found.add('email'); }
  }

  const phone = firstValid([...labeled.phone, ...findPhones(lines)], value => normalizePhone(value), ownSet.phones);
  if (phone) found.add('phone');

  const kvk = concat(labeled.kvk.map(normalizeKvk), findKvk(body)).find(value => value && !ownSet.kvk.has(value));
  if (kvk) found.add('kvk_number');

  const vat = concat(labeled.vat.map(normalizeVat), findVat(body)).find(value => value && !ownSet.vat.has(value.replace(/^(NL|BE)/, '')));
  if (vat) found.add('vat_number');

  const address = readAddress(lines, labeled, ownSet);
  if (address.address_line1 || address.postal_code || address.city) found.add('address');

  const website = concat(labeled.website.map(normalizeWebsite), findWebsites(body))
    .find(value => value && !ownSet.domains.has(domainOf(value)));
  if (website) found.add('website');

  // Bedrijf: een formulierveld, dan een regel met een rechtsvorm, dan de weergavenaam als die een rechtsvorm heeft.
  let company = labeled.company.map(cleanCompany).find(value => value && !ownSet.names.has(value.toLowerCase()));
  if (!company) {
    company = lines.map(cleanCompany).find(line => line && isCompanyLine(line) && !ownSet.names.has(line.toLowerCase()));
  }
  if (company) found.add('company');
  let contactFromSender = senderUsable ? senderName : undefined;
  if (!company && contactFromSender && isCompanyLine(contactFromSender)) {
    company = contactFromSender;
    contactFromSender = undefined;
  }

  // Contactpersoon: een formulierveld, dan de weergavenaam van de afzender, dan het adres zelf ("jan.de.vries@").
  let contact = labeledName(labeled);
  if (contact) found.add('contact_name');
  if (!contact && contactFromSender && !ownSet.names.has(contactFromSender.toLowerCase())) contact = contactFromSender;
  if (!contact && email) contact = nameFromLocalPart(email);
  if (contact && company && contact.toLowerCase() === company.toLowerCase()) contact = undefined;

  const emailDomain = email ? domainOf(email) : '';
  const businessDomain = emailDomain && !FREEMAIL_DOMAINS.has(emailDomain) && !ownSet.domains.has(emailDomain) ? emailDomain : '';
  const kind: ClientKind = company || kvk || vat || businessDomain ? 'business' : 'consumer';
  const name = company
    || (businessDomain ? nameFromDomain(businessDomain) : '')
    || contact
    || email
    || 'Nieuwe klant';

  return {
    values: {
      name: name.slice(0, 300),
      ...(contact ? { contact_name: contact.slice(0, 300) } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      status: 'prospect',
      client_kind: kind,
      ...address,
      ...(kvk ? { kvk_number: kvk } : {}),
      ...(vat ? { vat_number: vat } : {}),
      notes: draftNotes(source, website),
    },
    found: [...found],
    senderIsContact,
  };
}

/** "bedrijfsnaam, telefoon en adres" — voor de melding boven het formulier. */
export function describeFoundFields(found: readonly ClientDraftField[]): string {
  const order: ClientDraftField[] = ['company', 'contact_name', 'email', 'phone', 'address', 'kvk_number', 'vat_number', 'website'];
  const labels = order.filter(field => found.includes(field)).map(field => CLIENT_DRAFT_FIELD_LABELS[field]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} en ${labels[labels.length - 1]}`;
}

// ── De tekst die telt ──────────────────────────────────────────────────────

const FORWARD_MARKER_RE = /(-{2,}\s*(forwarded message|doorgestuurd bericht|weitergeleitete nachricht)\s*-{0,}|begin forwarded message:?|-{2,}\s*(oorspronkelijk bericht|original message|urspr(ü|u)ngliche nachricht)\s*-{2,})/i;
const FORWARD_SUBJECT_RE = /^\s*(fwd?|wg|doorst|tr)\s*:/i;
const HEADER_LINE_RE = /^\s*(van|from|von|de|datum|date|verzonden|sent|gesendet|aan|to|an|à|cc|bcc|onderwerp|subject|betreff|objet|reply-to)\s*:/i;

export interface MailBody {
  /** Het bericht zelf: zonder geciteerde eerdere mail, bij een doorgestuurde mail het origineel. */
  text: string;
  /** De afzender uit het kopblok van een doorgestuurde mail. */
  forwardedFrom: { email: string; name?: string } | null;
}

/**
 * Alleen het bericht zelf: bij een doorgestuurde mail het origineel (onder het
 * kopje), en daarvan alles vóór geciteerde eerdere mail.
 *
 * Een mail is doorgestuurd als het onderwerp dat zegt ("Fwd:", "WG:"), of als
 * er boven het doorstuurkopje bijna niets staat: wie het onderwerp aanpast,
 * stuurt het nog steeds door.
 */
export function readMailBody(raw: string, subject: string): MailBody {
  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ');
  let forwardedFrom: MailBody['forwardedFrom'] = null;

  const match = FORWARD_MARKER_RE.exec(text);
  const isForwardMarker = Boolean(match && /forward|doorgestuurd|weitergeleitet/i.test(match[0]));
  if (match && (FORWARD_SUBJECT_RE.test(subject) || (isForwardMarker && text.slice(0, match.index).trim().length < 300))) {
    const after = text.slice(match.index + match[0].length).split('\n');
    // De kopregels van het origineel (Van:, Datum:, Onderwerp:, Aan:) overslaan,
    // en de afzender eruit halen.
    let start = 0;
    while (start < after.length && (after[start].trim() === '' || HEADER_LINE_RE.test(after[start]))) {
      const from = /^\s*(?:van|from|von|de)\s*:\s*(.+)$/i.exec(after[start]);
      if (from && !forwardedFrom) forwardedFrom = parseAddressLine(from[1]);
      start += 1;
    }
    const rest = after.slice(start).join('\n');
    if (rest.trim()) text = rest;
  }

  const cut = firstQuoteIndex(text);
  if (cut > 0) {
    const before = text.slice(0, cut);
    if (before.trim()) text = before;
  }
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), forwardedFrom };
}

/** "Jan Jansen <jan@x.nl>", "Jan Jansen [mailto:jan@x.nl]", "jan@x.nl". */
function parseAddressLine(value: string): { email: string; name?: string } | null {
  const bracket = /<([^>\s]+@[^>\s]+)>|\[mailto:([^\]\s]+)\]/i.exec(value);
  const email = cleanEmail(bracket ? (bracket[1] ?? bracket[2]) : (/[^\s<>"\[\],;]+@[^\s<>"\[\],;]+\.[a-z]{2,}/i.exec(value)?.[0] ?? ''));
  if (!email) return null;
  const name = value.replace(/<[^>]*>|\[mailto:[^\]]*\]/gi, '').replace(/["'“”]/g, '').replace(/\s+/g, ' ').trim();
  return name && !name.includes('@') ? { email, name } : { email };
}

function firstQuoteIndex(text: string): number {
  const patterns = [
    // Gmail en Apple Mail: "Op ma 3 nov. 2026 om 10:00 schreef Jan <jan@x.nl>:" (soms over twee regels).
    /^(?:op|on|am|le)\s[^\n]*\d[^\n]*(?:\n[^\n]*)?\b(?:schreef|wrote|schrieb|a écrit)\b[^\n]*:\s*$/im,
    // Outlook: een kopblok "Van: … / Verzonden: …".
    /^(?:van|from|von)\s*:[^\n]*\n(?:[^\n]*\n)?(?:verzonden|sent|gesendet|datum|date)\s*:/im,
    /^-{2,}\s*(?:oorspronkelijk bericht|original message|urspr(?:ü|u)ngliche nachricht)\s*-{2,}/im,
    FORWARD_MARKER_RE,
    /^_{10,}\s*$/m,
    /^>/m,
  ];
  let best = -1;
  for (const re of patterns) {
    const match = re.exec(text);
    if (match && (best === -1 || match.index < best)) best = match.index;
  }
  return best;
}

// ── Formuliervelden: "Naam: …", "T: 06 …" ─────────────────────────────────

type LabeledKey = 'company' | 'name' | 'first' | 'middle' | 'last' | 'email' | 'phone' | 'street' | 'number'
  | 'postal' | 'city' | 'country' | 'kvk' | 'vat' | 'website';

type Labeled = Record<LabeledKey, string[]>;

const LABELS: Record<string, LabeledKey> = {};
function label(key: LabeledKey, ...names: string[]) { for (const name of names) LABELS[name] = key; }
label('company', 'bedrijf', 'bedrijfsnaam', 'organisatie', 'organisatienaam', 'company', 'company name', 'firma',
  'onderneming', 'naam bedrijf', 'naam organisatie', 'naam van het bedrijf', 'organization', 'organisation');
label('name', 'naam', 'volledige naam', 'name', 'full name', 'contactpersoon', 'voor- en achternaam',
  'voor en achternaam', 'voornaam en achternaam', 'aanvrager', 'your name');
label('first', 'voornaam', 'first name', 'firstname', 'roepnaam');
label('middle', 'tussenvoegsel', 'tussenvoegsels');
label('last', 'achternaam', 'last name', 'lastname', 'surname', 'familienaam');
label('email', 'e-mail', 'email', 'e-mailadres', 'emailadres', 'e-mail adres', 'email adres', 'email address',
  'e-mail address', 'mail', 'mailadres', 'e');
label('phone', 'telefoon', 'telefoonnummer', 'telefoon nummer', 'tel', 'tel.', 'mobiel', 'mobiel nummer',
  'mobielnummer', 'mobile', 'phone', 'phone number', 'telephone', 'gsm', 't', 'm', 'mob', 'mob.', 'telefonisch');
label('street', 'adres', 'straat', 'straatnaam', 'straat en huisnummer', 'straat + huisnummer', 'address', 'street',
  'bezoekadres', 'vestigingsadres', 'factuuradres', 'postadres', 'a');
label('number', 'huisnummer', 'nr', 'nummer', 'house number');
label('postal', 'postcode', 'zip', 'zipcode', 'zip code', 'postal code', 'postcode en plaats');
label('city', 'plaats', 'woonplaats', 'stad', 'city', 'vestigingsplaats', 'town');
label('country', 'land', 'country');
label('kvk', 'kvk', 'kvk-nummer', 'kvk nummer', 'kvknummer', 'kvk nr', 'kvk-nr', 'kamer van koophandel', 'coc',
  'coc number', 'chamber of commerce', 'handelsregister');
label('vat', 'btw', 'btw-nummer', 'btw nummer', 'btwnummer', 'btw-id', 'btw id', 'btw-identificatienummer',
  'vat', 'vat number', 'vat-number', 'vat id', 'omzetbelastingnummer');
label('website', 'website', 'site', 'url', 'webadres', 'internetadres', 'web', 'www', 'w', 'homepage');

const LABELED_LINE_RE = /^(?:[-*•·]\s*)?([\p{L}][\p{L}\s.+\-/()]{0,40}?)\s*[:：]\s*(.+?)\s*$/u;

function readLabeledFields(lines: string[]): Labeled {
  const out: Labeled = {
    company: [], name: [], first: [], middle: [], last: [], email: [], phone: [], street: [], number: [],
    postal: [], city: [], country: [], kvk: [], vat: [], website: [],
  };
  for (const line of lines) {
    if (HEADER_LINE_RE.test(line) && !/^\s*(e-?mail|tel)/i.test(line)) continue;
    // Een handtekening zet soms meer velden op één regel: "T: 06 1234 5678 | E: jan@x.nl".
    for (const part of line.split(/\s+[|·•]\s+|\s{3,}/)) {
      const match = LABELED_LINE_RE.exec(part.trim());
      if (!match) continue;
      const key = LABELS[normalizeLabel(match[1])];
      const value = match[2].replace(/^["'“”]+|["'“”]+$/g, '').trim();
      if (key && value && value.length <= 200) out[key].push(value);
    }
  }
  return out;
}

function normalizeLabel(raw: string): string {
  return raw.toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\*/g, '')
    .replace(/^(uw|je|jouw|your)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function labeledName(labeled: Labeled): string | undefined {
  const full = labeled.name.map(value => cleanPersonName(value)).find(Boolean);
  if (full) return full;
  const first = labeled.first.map(value => cleanPersonName(value)).find(Boolean);
  const last = labeled.last.map(value => cleanPersonName(value)).find(Boolean);
  if (!first && !last) return undefined;
  const middle = (labeled.middle[0] ?? '').trim().toLowerCase();
  return [first, middle, last].filter(Boolean).join(' ');
}

// ── Losse gegevens in de tekst ─────────────────────────────────────────────

function findEmails(text: string): string[] {
  return [...text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map(match => match[0].toLowerCase());
}

const PHONE_RE = /(?:\+|00)\d[\d\s().\-]{7,18}\d|(?<![\w+])0\d[\d\s().\-]{7,14}\d/g;

function findPhones(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // Een IBAN, datum of factuurnummer is geen telefoonnummer; een regel met
    // "IBAN" of "rek" sla je in zijn geheel over.
    if (/\b(iban|bic|rek(ening)?(nummer|nr)?|kvk|btw|vat|coc|factuur|order)\b/i.test(line)) continue;
    for (const match of line.matchAll(PHONE_RE)) {
      // "01-11-2026 10" heeft tien cijfers en begint met een 0.
      if (/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/.test(match[0])) continue;
      out.push(match[0]);
    }
  }
  return out;
}

/**
 * "06-12345678", "+31 (0)6 1234 5678", "020 123 45 67" → zoals geschreven, opgeschoond.
 * Null als het geen telefoonnummer kan zijn: een Nederlands nummer heeft tien
 * cijfers, een internationaal nummer negen tot vijftien.
 */
export function normalizePhone(raw: string): string | null {
  const value = raw.replace(/[^\d+()\s.\-]/g, '').replace(/\s+/g, ' ').trim();
  const digits = phoneDigits(value);
  if (!digits) return null;
  if (digits.startsWith('0') && !digits.startsWith('00')) return digits.length === 10 ? value : null;
  const international = digits.replace(/^00/, '');
  if (international.length < 9 || international.length > 15) return null;
  return value;
}

/** Cijfers om nummers mee te vergelijken: +31 (0)6 / 0031 6 / 06 worden alle drie "06…". */
function phoneDigits(value: string): string {
  let digits = value.replace(/\(0\)/g, '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = `00${digits.slice(1)}`;
  if (digits.startsWith('0031')) digits = `0${digits.slice(4)}`;
  return digits.replace(/\+/g, '');
}

function findKvk(text: string): string[] {
  return [...text.matchAll(/\b(?:kvk|k\.v\.k\.?|kamer van koophandel|coc)(?:[\s-]*(?:nr|nummer|no|number|n°))?\.?\s*[:.#]?\s*(\d[\d ]{6,9}\d)\b/gi)]
    .map(match => normalizeKvk(match[1]))
    .filter((value): value is string => Boolean(value));
}

function normalizeKvk(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

function findVat(text: string): string[] {
  return [...text.matchAll(/\b(NL\s?\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?B[\s.]?\d{2}|BE\s?0?\d{3}[\s.]?\d{3}[\s.]?\d{3})\b/gi)]
    .map(match => normalizeVat(match[1]))
    .filter((value): value is string => Boolean(value));
}

function normalizeVat(raw: string): string | null {
  const value = raw.toUpperCase().replace(/[\s.]/g, '');
  if (/^NL\d{9}B\d{2}$/.test(value)) return value;
  if (/^BE0?\d{9}$/.test(value)) return value.length === 11 ? `BE0${value.slice(2)}` : value;
  return null;
}

function findWebsites(text: string): string[] {
  return [...text.matchAll(/\b(?:https?:\/\/)?www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi)]
    .map(match => normalizeWebsite(match[0]))
    .filter((value): value is string => Boolean(value));
}

function normalizeWebsite(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#\s]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host.startsWith('www.') ? host : `www.${host}`;
}

// ── Adres ──────────────────────────────────────────────────────────────────

const POSTCODE_CITY_RE = /^(?:(.+?),\s*)?(\d{4})\s?([a-z]{2})\s+([\p{L}'’.\- ]{2,40}?)(?:,\s*(nederland|the netherlands|netherlands|nl))?\s*$/iu;
const STREET_RE = /^[\p{L}'’.\- ]{2,60}\s\d{1,5}(?:\s?[a-z]{1,3})?(?:[-/ ]\d{1,4}[a-z]?)?$/iu;

function readAddress(lines: string[], labeled: Labeled, own: OwnSet): Pick<ClientDraftValues, 'address_line1' | 'postal_code' | 'city' | 'country'> {
  // Een ingevuld formulier: straat (+ huisnummer), postcode, plaats.
  const postal = labeled.postal.map(normalizePostcode).find(Boolean);
  if (postal && !own.postalCodes.has(postal)) {
    const streetValue = labeled.street[0] ? [labeled.street[0], labeled.number[0]].filter(Boolean).join(' ') : '';
    const city = labeled.city[0] ? cleanCity(labeled.city[0]) : postcodeCity(labeled.postal[0] ?? '');
    return {
      ...(streetValue ? { address_line1: streetValue.slice(0, 200) } : {}),
      postal_code: postal,
      ...(city ? { city } : {}),
      country: cleanCountry(labeled.country[0]) ?? 'Nederland',
    };
  }

  // Een handtekening: "1234 AB Utrecht", met de straat ervoor op dezelfde of de vorige regel.
  for (let i = 0; i < lines.length; i += 1) {
    const match = POSTCODE_CITY_RE.exec(lines[i]);
    if (!match) continue;
    // "1500 of meer" is geen adres; "1234 AB Utrecht" en "1234ab Utrecht" wel.
    if (match[3] !== match[3].toUpperCase() && !/^\p{Lu}/u.test(match[4])) continue;
    const code = normalizePostcode(`${match[2]}${match[3]}`);
    if (!code || own.postalCodes.has(code)) continue;
    const city = cleanCity(match[4]);
    if (!city) continue;
    let street = match[1] ? stripLabel(match[1]) : '';
    if (!street && i > 0 && STREET_RE.test(stripLabel(lines[i - 1]))) street = stripLabel(lines[i - 1]);
    if (street && !STREET_RE.test(street)) street = '';
    return { ...(street ? { address_line1: street } : {}), postal_code: code, city, country: 'Nederland' };
  }

  // Alleen een labeled adres zonder postcode ("Adres: Dorpsstraat 1, 1234 AB Utrecht").
  for (const value of labeled.street) {
    const match = POSTCODE_CITY_RE.exec(value);
    if (!match) continue;
    const code = normalizePostcode(`${match[2]}${match[3]}`);
    const city = cleanCity(match[4]);
    if (!code || !city || own.postalCodes.has(code)) continue;
    return { ...(match[1] ? { address_line1: match[1].trim() } : {}), postal_code: code, city, country: 'Nederland' };
  }
  return {};
}

function normalizePostcode(raw: string): string | null {
  const match = /^\s*(\d{4})\s?([a-z]{2})\b/i.exec(raw);
  if (!match || match[1].startsWith('0')) return null;
  const letters = match[2].toUpperCase();
  // SA, SD en SS geeft PostNL niet uit; "1234 SS" is dus eerder tekst dan een postcode.
  if (['SA', 'SD', 'SS'].includes(letters)) return null;
  return `${match[1]} ${letters}`;
}

function postcodeCity(raw: string): string | undefined {
  const match = /^\s*\d{4}\s?[a-z]{2}\s+(.+)$/i.exec(raw);
  return match ? cleanCity(match[1]) : undefined;
}

function cleanCity(raw: string): string | undefined {
  const value = raw.trim().replace(/[.,]+$/, '');
  if (!value || /\d/.test(value) || value.length > 40) return undefined;
  // "UTRECHT" of "utrecht" → "Utrecht"; "'s-Hertogenbosch" en "Den Haag" blijven zoals ze zijn.
  if (value === value.toUpperCase() || value === value.toLowerCase()) {
    return value.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return value;
}

function cleanCountry(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (/^(nl|nederland|the netherlands|netherlands|holland)$/i.test(value)) return 'Nederland';
  if (/^(be|belgië|belgie|belgium)$/i.test(value)) return 'België';
  if (/^(de|duitsland|germany|deutschland)$/i.test(value)) return 'Duitsland';
  return value.length <= 60 ? value : undefined;
}

function stripLabel(line: string): string {
  return line.replace(/^\s*(?:[-*•·]\s*)?(?:adres|address|bezoekadres|postadres|a)\s*[:：]\s*/i, '').trim();
}

// ── Namen ──────────────────────────────────────────────────────────────────

function isCompanyLine(line: string): boolean {
  if (line.length > 60 || line.includes('@') || /https?:|www\.|[?!]$/i.test(line)) return false;
  const words = line.split(/\s+/);
  if (words.length > 7) return false;
  const end = LEGAL_FORM_END_RE.exec(` ${line}`);
  const start = LEGAL_FORM_START_RE.test(line);
  if (!end && !start) return false;
  // Een bedrijfsnaam schrijf je met hoofdletters; een zin niet. Zonder deze
  // regel werd "Wij zijn een bv" een klantnaam.
  const nameWords = (end ? line.slice(0, Math.max(0, end.index - 1)) : line).split(/\s+/).slice(start ? 1 : 0);
  return nameWords.length > 0 && nameWords.every(word =>
    word.length < 3 || NAME_PARTICLES.has(word.toLowerCase()) || ['en', 'and', 'und', '&'].includes(word.toLowerCase()) || /^[\p{Lu}\d&'"(]/u.test(word));
}

function cleanCompany(raw: string): string {
  return raw.replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function cleanDisplayName(raw: string | null, email: string | null): string | undefined {
  let value = (raw ?? '').replace(/["'“”<>]/g, '').replace(/\s+/g, ' ').trim();
  // "Jan Jansen via Contactformulier", "Jan (Bakker BV)".
  value = value.replace(/\s+via\s+.+$/i, '').trim();
  if (!value || value.includes('@')) return undefined;
  // Zonder ingestelde naam zet een mailprogramma het adres ervoor neer ("kees");
  // dat is geen naam. "Kees" met een hoofdletter heeft iemand zelf ingevuld.
  if (email && value === email.split('@')[0]) return undefined;
  if (GENERIC_LOCAL_PARTS.has(value.toLowerCase())) return undefined;
  // "Jansen, Jan" → "Jan Jansen".
  const comma = /^([\p{L}'’\- ]+),\s*([\p{L}'’\- ]+)$/u.exec(value);
  if (comma && !LEGAL_FORM_END_RE.test(` ${value}`)) value = `${comma[2]} ${comma[1]}`;
  return value.slice(0, 120);
}

function cleanPersonName(raw: string): string | undefined {
  const value = raw.replace(/["'“”<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!value || value.length > 80 || value.includes('@') || /\d/.test(value)) return undefined;
  return value;
}

/** "jan.de.vries@" → "Jan de Vries". Niet voor info@, sales@ en dergelijke. */
function nameFromLocalPart(email: string): string | undefined {
  const local = email.split('@')[0].replace(/\+.*$/, '');
  if (GENERIC_LOCAL_PARTS.has(local) || looksAutomated(email)) return undefined;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.some(part => /\d/.test(part))) return undefined;
  return parts.map((part, index) => (index > 0 && NAME_PARTICLES.has(part) ? part : capitalize(part))).join(' ');
}

/** "bakker-fotografie.nl" → "Bakker Fotografie". Een voorstel; de gebruiker ziet het in het formulier. */
function nameFromDomain(domain: string): string {
  const labels = domain.split('.');
  let base = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (labels.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(base)) base = labels[labels.length - 3];
  return base.split('-').filter(Boolean).map(capitalize).join(' ');
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

// ── Notitie ────────────────────────────────────────────────────────────────

function draftNotes(source: ClientEmailSource, website: string | null | undefined): string {
  const subject = (source.subject ?? '').trim();
  const when = formatDate(source.receivedAt);
  const lines = [`Eerste contact per mail${when ? ` op ${when}` : ''}${subject ? `: "${subject.slice(0, 200)}"` : ''}.`];
  if (website) lines.push(`Website: ${website}`);
  return lines.join('\n');
}

function formatDate(value: string | null | undefined): string {
  const time = Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }).format(new Date(time));
}

// ── Eigen gegevens ─────────────────────────────────────────────────────────

interface OwnSet {
  emails: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
  kvk: Set<string>;
  vat: Set<string>;
  postalCodes: Set<string>;
  names: Set<string>;
}

function normalizeOwn(own: OwnDetails): OwnSet {
  const list = (values: Array<string | null | undefined> | undefined) => (values ?? []).map(value => String(value ?? '').trim()).filter(Boolean);
  const emails = new Set(list(own.emails).map(value => value.toLowerCase()));
  const domains = new Set<string>();
  // Een freemail-domein is nooit "van ons": een bureau met een Gmail-adres
  // zou anders elke klant met een Gmail-adres als eigen post wegfilteren.
  for (const email of emails) { const domain = domainOf(email); if (domain && !FREEMAIL_DOMAINS.has(domain)) domains.add(domain); }
  for (const site of list(own.websites)) {
    const host = normalizeWebsite(site.includes('.') ? site : '');
    const domain = host ? host.replace(/^www\./, '') : '';
    if (domain && !FREEMAIL_DOMAINS.has(domain)) domains.add(domain);
  }
  return {
    emails,
    domains,
    phones: new Set(list(own.phones).map(phoneDigits).filter(Boolean)),
    kvk: new Set(list(own.kvkNumbers).map(normalizeKvk).filter((value): value is string => Boolean(value))),
    vat: new Set(list(own.vatNumbers).map(value => value.toUpperCase().replace(/[\s.]/g, '').replace(/^(NL|BE)/, ''))),
    postalCodes: new Set(list(own.postalCodes).map(normalizePostcode).filter((value): value is string => Boolean(value))),
    names: new Set(list(own.names).map(value => value.toLowerCase())),
  };
}

function isOwnEmail(email: string, own: OwnSet): boolean {
  return own.emails.has(email) || own.domains.has(domainOf(email));
}

// ── Hulpjes ────────────────────────────────────────────────────────────────

function cleanEmail(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim().replace(/^mailto:/i, '').replace(/[<>]/g, '').toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function looksAutomated(email: string): boolean {
  return NO_REPLY_RE.test(email.split('@')[0]);
}

function domainOf(value: string): string {
  const at = value.lastIndexOf('@');
  const host = at === -1 ? value : value.slice(at + 1);
  return host.toLowerCase().replace(/^www\./, '');
}

function concat<T>(...lists: T[][]): T[] {
  return lists.flat();
}

function firstValid(values: string[], normalize: (value: string) => string | null, ownPhones: Set<string>): string | undefined {
  for (const raw of values) {
    const value = normalize(raw);
    if (value && !ownPhones.has(phoneDigits(value))) return value;
  }
  return undefined;
}
