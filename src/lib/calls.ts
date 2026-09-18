import type { CallDirection, CallOutcome, Client, ClientCall, ClientContact, PhoneMatch, Supplier } from '../types';
import type { CallConversation } from './communication';

/**
 * Pure hulpfuncties rond telefoongesprekken: nummers normaliseren en tonen,
 * labels, gespreksduur, en hoe een gesprek een regel in de gesprekkenlijst van
 * Berichten wordt. Bewust zonder React, zonder Supabase en zonder
 * runtime-imports, zodat `npm test` (node --test) ze draait — hetzelfde
 * uitgangspunt als `communication.ts` en `tickets.ts`.
 *
 * De normalisatie hieronder is een spiegel van `normalize_phone_e164` in
 * migratie 20260918020000. Wijken ze af, dan volgt de database — die is de
 * waarheid; deze kant is er voor het herkennen tijdens het typen, zodat de app
 * niet bij elke toetsaanslag de server hoeft te vragen.
 */

export const CALL_DIRECTION_LABELS: Record<CallDirection, string> = {
  inbound: 'Inkomend',
  outbound: 'Uitgaand',
};

export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  answered: 'Gesproken',
  missed: 'Gemist',
  voicemail: 'Voicemail',
  busy: 'In gesprek',
  no_answer: 'Niet opgenomen',
  failed: 'Mislukt',
};

/** De keuzelijst bij het loggen, in de volgorde waarin je ze nodig hebt. */
export const CALL_OUTCOME_ORDER: CallOutcome[] = ['answered', 'voicemail', 'no_answer', 'missed', 'busy', 'failed'];

/** Er is alleen echt gesproken bij 'answered'; de rest heeft geen gespreksduur. */
export function callWasAnswered(outcome: CallOutcome | string): boolean {
  return outcome === 'answered';
}

export function callDirectionLabel(direction: CallDirection | string): string {
  return CALL_DIRECTION_LABELS[direction as CallDirection] ?? String(direction);
}

export function callOutcomeLabel(outcome: CallOutcome | string): string {
  return CALL_OUTCOME_LABELS[outcome as CallOutcome] ?? String(outcome);
}

/** Tekst die de centrale als "afgeschermd nummer" aanlevert — nooit een match op maken. */
const ANONYMOUS = new Set([
  'anonymous', 'unknown', 'private', 'restricted', 'unavailable', 'onbekend', 'anoniem', 'geheim',
]);

/**
 * Elke schrijfwijze naar één waarde: '+<land><abonnee>'. Zo vinden
 * '06-12345678', '+31 6 12345678' en '0031 6 12345678' elkaar.
 * Geeft null bij een afgeschermd, leeg of onbruikbaar nummer.
 *
 * Een kaal nummer zonder 0 en zonder + wordt als Nederlands abonneenummer
 * gelezen. In Nederland begint elk nationaal nummer met een 0, dus dat is
 * veilig — maar het is wél de reden dat een buitenlands nummer altijd met
 * + of 00 ingevoerd moet worden.
 */
export function normalizePhoneE164(value: string | null | undefined, defaultCountry = '31'): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (ANONYMOUS.has(raw.toLowerCase())) return null;

  const country = defaultCountry.replace(/[^0-9]+/g, '');
  let digits = raw.replace(/[^0-9]+/g, '');
  if (!digits) return null;

  if (raw.startsWith('+')) {
    // Al internationaal genoteerd: de cijfers zijn land + abonnee.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = country + digits.slice(1);
  } else if (country && !digits.startsWith(country)) {
    digits = country + digits;
  }

  // '+31 (0)20 123 45 67' — een veelgebruikte Nederlandse notatie waarin de
  // trunk-0 tussen haakjes blijft staan. Die 0 hoort niet in E.164 en wordt
  // hier weggehaald. Bewust alleen voor het eigen landnummer: er zijn landen
  // (Italië) waar de 0 juist wél bij het nummer hoort, en die regel kennen we
  // hier niet.
  if (country && digits.startsWith(`${country}0`)) {
    digits = country + digits.slice(country.length + 1);
  }

  // E.164 staat maximaal 15 cijfers toe; korter dan 8 is een doorkiesnummer
  // of een typefout, geen volledig telefoonnummer.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * De Nederlandse netnummers van twee cijfers. Al het overige vaste nummer
 * heeft er drie — daarom een vaste lijst en geen lengteregel.
 */
const TWO_DIGIT_AREA_CODES = new Set([
  '10', '13', '14', '15', '20', '23', '24', '26', '30', '33', '35', '36', '38',
  '40', '43', '45', '46', '50', '53', '55', '58',
  '70', '71', '72', '73', '74', '75', '76', '77', '78', '79',
]);

/**
 * Leesbaar nummer voor op het scherm. Nederlandse nummers krijgen hun
 * vertrouwde vorm terug (06 12 34 56 78 / 010 123 45 67); buitenlandse
 * nummers blijven staan zoals ze zijn — een verkeerde gok is daar erger dan
 * geen opmaak.
 */
export function formatPhone(value: string | null | undefined): string {
  const e164 = normalizePhoneE164(value);
  if (!e164) return String(value ?? '').trim();
  if (!e164.startsWith('+31')) return e164;

  const national = e164.slice(3);
  if (national.length !== 9) return e164;

  // Mobiel: 06 gevolgd door acht cijfers, in paren.
  if (national.startsWith('6')) {
    return `06 ${national.slice(1, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
  }
  // Servicenummers (085, 088, 087, 09xx): 085 123 4567.
  if (national.startsWith('8') || national.startsWith('9')) {
    return `0${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
  }
  // Vast met een netnummer van twee cijfers: 010 123 45 67.
  if (TWO_DIGIT_AREA_CODES.has(national.slice(0, 2))) {
    return `0${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
  }
  // Al het overige vast is een netnummer van drie cijfers: 0113 456 789.
  return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** Het nummer zoals een `tel:`-link het wil: zonder spaties, mét landnummer. */
export function telHref(value: string | null | undefined): string | null {
  const e164 = normalizePhoneE164(value);
  return e164 ? `tel:${e164}` : null;
}

/** "4 min 12 sec", "48 sec", "1 u 03 min". Null of 0 geeft een streepje. */
export function callDurationLabel(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '—';
  if (total < 60) return `${total} sec`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? `${minutes} min ${String(rest).padStart(2, '0')} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} u ${String(minutes % 60).padStart(2, '0')} min`;
}

function oneLine(value: string | null | undefined, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Met wie was het gesprek: de vastgelegde naam, anders het nummer, anders
 * "Onbekend nummer". Bewust de snapshot vóór de klantnaam — je sprak een
 * persoon, niet een dossier.
 */
export function callCounterpart(call: Pick<ClientCall, 'counterpart_name' | 'phone_raw' | 'phone_e164'>): string {
  const name = oneLine(call.counterpart_name, 80);
  if (name) return name;
  const phone = formatPhone(call.phone_e164 ?? call.phone_raw);
  return phone || 'Onbekend nummer';
}

/**
 * De titel van het gesprek in de lijst. Heeft de gebruiker zelf een onderwerp
 * getypt, dan wint dat; anders bouwen we er een van richting en afloop, zodat
 * een regel nooit leeg is.
 */
export function callSubject(call: Pick<ClientCall, 'subject' | 'direction' | 'outcome' | 'counterpart_name' | 'phone_raw' | 'phone_e164'>): string {
  const own = oneLine(call.subject, 200);
  if (own) return own;
  const who = callCounterpart(call);
  if (!callWasAnswered(call.outcome)) return `${callOutcomeLabel(call.outcome)} — ${who}`;
  return call.direction === 'inbound' ? `Gebeld door ${who}` : `Gebeld met ${who}`;
}

/**
 * De regel onder het onderwerp: de aantekening als die er is, anders een
 * feitelijke samenvatting ("Uitgaand · Gesproken · 4 min 12 sec").
 */
export function callPreview(call: Pick<ClientCall, 'notes' | 'direction' | 'outcome' | 'duration_seconds'>): string {
  const note = oneLine(call.notes);
  if (note) return note;
  const parts = [callDirectionLabel(call.direction), callOutcomeLabel(call.outcome)];
  if (callWasAnswered(call.outcome) && call.duration_seconds) parts.push(callDurationLabel(call.duration_seconds));
  return parts.join(' · ');
}

/**
 * Een gesprek als regel in de gesprekkenlijst van Berichten — dezelfde vorm
 * die `ticketConversation` voor een ticket maakt. Een gesprek kent geen
 * ongelezen-teller: je hebt het zelf gevoerd.
 */
export function callConversation(
  call: ClientCall,
  options: { clientName: string | null; transcript?: string | null; summary?: string | null },
): CallConversation {
  const clientName = options.clientName || 'Geen klant';
  const counterpart = callCounterpart(call);
  return {
    key: `call:${call.id}`,
    kind: 'call',
    id: call.id,
    clientId: call.client_id,
    clientName,
    subject: callSubject(call),
    preview: callPreview(call),
    // De lijst sorteert op wanneer het gesprek plaatsvond, niet op wanneer het
    // gelogd werd: een gesprek van gisteren dat je vanochtend invult, hoort op
    // zijn eigen moment te staan.
    lastAt: call.started_at,
    unread: 0,
    hasProblem: call.outcome === 'failed',
    searchText: [
      clientName, counterpart, call.subject, call.notes,
      call.phone_raw, call.phone_e164, formatPhone(call.phone_e164 ?? call.phone_raw),
      callDirectionLabel(call.direction), callOutcomeLabel(call.outcome),
      // Het transcript en de samenvatting van een opname horen doorzoekbaar te
      // zijn: daar staat wat er écht gezegd is.
      options.summary, options.transcript,
    ].filter(Boolean).join('\n'),
    call,
  };
}

/**
 * Wie hoort er bij dit nummer? Dezelfde vraag die `find_contacts_by_phone` in
 * de database beantwoordt, maar dan op de gegevens die de app al geladen
 * heeft — zodat het tijdens het typen meteen meeloopt, zonder netwerk.
 *
 * Geeft ALLE treffers terug, nooit alleen de eerste: één kantoornummer hoort
 * vaak bij de klant én bij meerdere contactpersonen. De app laat kiezen.
 */
export function matchPhoneLocally(
  phone: string | null | undefined,
  sources: {
    clients: readonly Client[];
    contacts: readonly ClientContact[];
    suppliers?: readonly Supplier[];
  },
): PhoneMatch[] {
  const target = normalizePhoneE164(phone);
  if (!target) return [];

  const clientNameById = new Map(sources.clients.map(c => [c.id, c.name]));
  const matches: PhoneMatch[] = [];

  for (const client of sources.clients) {
    if (normalizePhoneE164(client.phone) !== target) continue;
    matches.push({
      match_kind: 'client',
      client_id: client.id, contact_id: null, supplier_id: null,
      display_name: client.name, client_name: client.name,
      role: client.contact_name ?? null, phone: client.phone ?? null,
    });
  }

  for (const contact of sources.contacts) {
    if (!contact.is_active) continue;
    if (normalizePhoneE164(contact.phone) !== target) continue;
    matches.push({
      match_kind: 'client_contact',
      client_id: contact.client_id, contact_id: contact.id, supplier_id: null,
      display_name: contact.name, client_name: clientNameById.get(contact.client_id) ?? null,
      role: contact.role ?? null, phone: contact.phone ?? null,
    });
  }

  for (const supplier of sources.suppliers ?? []) {
    if (normalizePhoneE164(supplier.phone) !== target) continue;
    matches.push({
      match_kind: 'supplier',
      client_id: null, contact_id: null, supplier_id: supplier.id,
      display_name: supplier.name, client_name: null,
      role: supplier.contact_name ?? null, phone: supplier.phone ?? null,
    });
  }

  return matches;
}

/**
 * Hoe de app een lijst treffers samenvat in één regel. Eén treffer is een
 * mededeling, meer treffers zijn een keuze — en dat verschil moet je kunnen
 * lezen zonder de lijst open te klappen.
 */
export function describeMatches(matches: readonly PhoneMatch[]): string {
  if (matches.length === 0) return 'Geen bekend contact met dit nummer';
  if (matches.length === 1) {
    const only = matches[0];
    if (only.match_kind === 'client_contact' && only.client_name) return `${only.display_name} (${only.client_name})`;
    if (only.match_kind === 'supplier') return `${only.display_name} (leverancier)`;
    return only.display_name;
  }
  return `${matches.length} contacten met dit nummer — kies er één`;
}
