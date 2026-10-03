/**
 * Gewone taal voor het logboek en de agentkaart van Gerrie.
 *
 * Achter elke stap van een agent zit een technische naam (`propose_send_reminders`,
 * `action:inbox.list`) en een invoer vol veldnamen (`client_id`, `overdue_only`).
 * Die horen niet op het scherm: een gebruiker leest "alleen te laat", niet
 * "overdue_only: true". Wat hier niet te vertalen valt, laten we weg in plaats van
 * het rauw te tonen.
 *
 * Bewust zonder imports, zodat de tests het los kunnen laden.
 */

/**
 * Een label voor een tool of handeling die de catalogus niet kent (offline, oude
 * functie-versie). Liever algemeen dan een technische naam.
 */
export function fallbackToolLabel(name: string): string {
  if (name.startsWith('action:')) return 'Overige handeling';
  if (name.startsWith('propose_')) return 'Iets klaarzetten';
  return 'Gegevens bekijken';
}

/** Hoe een voorstel van een agent is afgelopen, in gewone taal. */
export function decisionStatusLabel(status: string): string {
  switch (status) {
    case 'executed':
    case 'auto_executed': return 'uitgevoerd';
    case 'cancelled': return 'geannuleerd';
    case 'failed': return 'afgewezen of mislukt';
    case 'proposed': return 'wacht op akkoord';
    case 'confirmed': return 'goedgekeurd';
    default: return 'in behandeling';
  }
}

/** Statussen en keuzes zoals ze in de invoer van een tool staan, vertaald. */
const VALUE_WORDS: Record<string, string> = {
  draft: 'concept', sent: 'verstuurd', overdue: 'te laat', paid: 'betaald', cancelled: 'geannuleerd',
  void: 'ongeldig', written_off: 'afgeboekt', refunded: 'terugbetaald', accepted: 'geaccepteerd',
  rejected: 'afgewezen', expired: 'verlopen', pending_internal_approval: 'wacht op interne goedkeuring',
  internally_approved: 'intern goedgekeurd', new: 'nieuw', review: 'ter beoordeling', approved: 'goedgekeurd',
  converted: 'omgezet', todo: 'te doen', doing: 'bezig', done: 'klaar', active: 'actief',
  prospect: 'prospect', inactive: 'inactief', low: 'laag', med: 'normaal', high: 'hoog',
  this_month: 'deze maand', last_month: 'vorige maand', this_quarter: 'dit kwartaal',
  this_year: 'dit jaar', last_12m: 'afgelopen 12 maanden', all: 'alles',
  business: 'zakelijk', consumer: 'particulier',
};

/** Velden met een waarde die we tonen: veld → hoe het heet. */
const FIELD_LABELS: Record<string, string> = {
  status: 'status', date_preset: 'periode', priority: 'prioriteit', client_kind: 'soort klant',
  from: 'vanaf', from_date: 'vanaf', emailed_since: 'gemaild sinds', to: 'tot en met',
  date: 'datum', due_date: 'vervaldatum', valid_until: 'geldig tot', planned_date: 'gepland op',
  city: 'plaats', name: 'naam', title: 'titel', subject: 'onderwerp',
};

/** Ja/nee-velden: wat er staat als ze aan staan. */
const FLAG_LABELS: Record<string, string> = {
  overdue_only: 'alleen te laat', unpaid_only: 'alleen onbetaald', unreconciled_only: 'alleen niet afgeletterd',
  unanswered_only: 'alleen onbeantwoord', planned_only: 'alleen ingepland', expired_only: 'alleen verlopen',
  awaiting_signature_only: 'wacht op handtekening', awaiting_response_only: 'wacht op reactie',
  billable_only: 'alleen declarabel', include_archived: 'ook gearchiveerd', include_weekend: 'ook in het weekend',
  has_email: 'met e-mailadres', physical: 'afspraak op locatie',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Een waarde die er technisch uitziet: `snake_case` of `iets.anders`. */
const TECHNICAL = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;

function euro(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) ? `€ ${n.toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : null;
}

/** Eén waarde zoals een gebruiker hem leest, of null als hij niet te tonen is. */
function plainValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value.toLocaleString('nl-NL');
  const text = String(value);
  if (VALUE_WORDS[text]) return VALUE_WORDS[text];
  if (UUID.test(text) || TECHNICAL.test(text)) return null;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * De invoer van een logboekstap in gewone taal: hoogstens drie korte delen.
 *
 * Id's (`client_id`, `action_id`) en velden zonder vertaling vallen weg. Voor een
 * handeling uit de registry geeft `labelForAction` zijn label, als dat bekend is.
 */
export function stepInputSummary(
  input: Record<string, unknown>,
  labelForAction?: (actionId: string) => string | null,
): string[] {
  const parts: string[] = [];
  const add = (part: string | null) => { if (part && parts.length < 3) parts.push(part); };

  if (typeof input.action_id === 'string' && labelForAction) add(labelForAction(input.action_id));
  for (const [key, value] of Object.entries(input)) {
    if (key === 'query' && typeof value === 'string' && value.trim()) add(`zoekterm "${value.trim().slice(0, 40)}"`);
    else if (FLAG_LABELS[key]) { if (value === true) add(FLAG_LABELS[key]); }
    else if (key === 'sent' && typeof value === 'boolean') add(value ? 'verstuurd' : 'niet verstuurd');
    else if (key === 'is_internal' && typeof value === 'boolean') add(value ? 'intern' : 'zichtbaar voor de klant');
    else if (key === 'min_amount_eur') add(euro(value) && `vanaf ${euro(value)}`);
    else if (key === 'max_amount_eur') add(euro(value) && `tot ${euro(value)}`);
    else if (key === 'amount_eur') add(euro(value) && `bedrag ${euro(value)}`);
    else if (key === 'days') add(plainValue(value) && `${plainValue(value)} dagen`);
    else if (key === 'hours') add(plainValue(value) && `${plainValue(value)} uur`);
    else if (key === 'minutes') add(plainValue(value) && `${plainValue(value)} minuten`);
    else if (key === 'lines' || key === 'items') {
      // Het logboek kort lange lijsten in tot "15 stuks" (trimForLog in gerrieCore).
      const n = Array.isArray(value) ? value.length : parseInt(String(value), 10);
      if (Number.isFinite(n) && n > 0) add(`${n} ${key === 'lines' ? (n === 1 ? 'regel' : 'regels') : (n === 1 ? 'stuk' : 'stuks')}`);
    } else if (FIELD_LABELS[key]) {
      const plain = plainValue(value);
      if (plain) add(`${FIELD_LABELS[key]}: ${plain}`);
    }
  }
  return parts;
}
