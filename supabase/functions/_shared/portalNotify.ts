// ============================================================
// Klantportaal — wie krijgt welke e-mailmelding over een ticket?
//
// Pure regels, zonder database en zonder Deno-API's, zodat `npm test`
// (node --test) ze controleert. De edge function `portal-notify` laadt de
// gegevens en claimt de activiteit (portal_ticket_activity); dit bestand
// beslist wie een mail krijgt en wat erin staat.
//
// De regels in het kort:
//  - Portaalgebruikers van een klant zijn het hoofdadres (clients.email) en de
//    actieve contactpersonen met portaaltoegang — precies wie er ook kan
//    inloggen (portal_clients_for_email).
//  - Ieder kiest zelf per soort melding aan/uit (nieuw ticket, status,
//    antwoord) en waarover: alle tickets van de klant, of alleen de tickets die
//    zelf ingediend zijn. Geen keuze opgeslagen = alles aan; het hoofdadres over
//    alle tickets, een contactpersoon alleen over de eigen tickets. Zo krijgt
//    de boekhouder die alleen facturen komt betalen geen ticketmail, en de
//    eigenaar van het dossier wel.
//  - Wie iets zelf deed, krijgt er geen mail over. Uitzondering: wie een
//    ticket indient, krijgt een ontvangstbevestiging.
//  - Gebeurt er binnen een paar tellen meer op één ticket (een antwoord én een
//    statuswijziging), dan komt dat in één mail.
// ============================================================

export type PortalActivityKind = 'created' | 'status' | 'reply';
export type PortalActorType = 'staff' | 'client' | 'system';
export type PortalNotifyScope = 'all' | 'own';

/** Eén rij uit portal_ticket_activity, voor zover de regels hem nodig hebben. */
export interface PortalActivity {
  id: string;
  ticket_id: string;
  client_id: string | null;
  kind: PortalActivityKind;
  note_id: string | null;
  old_status: string | null;
  new_status: string | null;
  actor_type: PortalActorType;
  actor_contact_id: string | null;
  actor_email: string | null;
  /** Adressen die deze gebeurtenis al in een eerdere mail kregen. */
  notified_emails?: string[] | null;
  created_at: string;
}

/** Iemand die op het portaal van deze klant kan inloggen. */
export interface PortalPerson {
  /** Genormaliseerd e-mailadres: de sleutel van een portaalgebruiker. */
  email: string;
  name: string;
  /** De contactpersoon-rij, of null voor het hoofdadres van de klant. */
  contactId: string | null;
  /** Dit is het hoofdadres van de klant (clients.email). */
  isPrimary: boolean;
}

export interface PortalNotifyPrefs {
  ticketCreated: boolean;
  ticketStatus: boolean;
  ticketReply: boolean;
  scope: PortalNotifyScope;
}

/** Een rij uit portal_contact_settings. */
export interface PortalSettingsRow {
  email: string;
  notify_ticket_created?: boolean | null;
  notify_ticket_status?: boolean | null;
  notify_ticket_reply?: boolean | null;
  notify_scope?: string | null;
}

export interface PortalTicketRef {
  id: string;
  client_id: string | null;
  status: string;
  created_by_contact_id?: string | null;
  created_by_email?: string | null;
}

/**
 * De statuslabels zoals de klant ze in het portaal ziet. Dezelfde woorden als
 * `ticketStatusLabels` in src/features/portal/ClientPortal.tsx — de klant
 * leest "In behandeling", niet het interne "Review".
 */
export const PORTAL_TICKET_STATUS_LABELS: Record<string, string> = {
  new: 'Nieuw',
  review: 'In behandeling',
  approved: 'Goedgekeurd',
  rejected: 'Afgewezen',
  converted: 'Omgezet naar project',
};

export function portalTicketStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? '');
  return Object.prototype.hasOwnProperty.call(PORTAL_TICKET_STATUS_LABELS, key)
    ? PORTAL_TICKET_STATUS_LABELS[key]
    : key || 'Onbekend';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Zelfde normalisatie als normalize_client_lookup_value in de database (lower +
 * trim + witruimte samenvouwen), plus een vormcontrole: hier gaat straks een
 * mail naartoe.
 */
export function normalizeEmail(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized && EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function clean(value: unknown, max = 120): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * De portaalgebruikers van één klant: eerst het hoofdadres, dan de
 * contactpersonen. Staat het hoofdadres óók als contactpersoon, dan is dat
 * één mens — met de contactpersoon-id, want zo legt het portaal de
 * reacties van die persoon vast.
 */
export function portalPeople(
  client: { email?: string | null; contact_name?: string | null; name?: string | null },
  contacts: ReadonlyArray<{ id: string; name?: string | null; email?: string | null }>,
): PortalPerson[] {
  const people: PortalPerson[] = [];
  const byEmail = new Map<string, PortalPerson>();

  const primaryEmail = normalizeEmail(client.email);
  if (primaryEmail) {
    const person: PortalPerson = {
      email: primaryEmail,
      name: clean(client.contact_name) || clean(client.name) || primaryEmail,
      contactId: null,
      isPrimary: true,
    };
    people.push(person);
    byEmail.set(primaryEmail, person);
  }

  for (const contact of contacts) {
    const email = normalizeEmail(contact.email);
    if (!email) continue;
    const existing = byEmail.get(email);
    if (existing) {
      if (!existing.contactId) {
        existing.contactId = contact.id;
        existing.name = clean(contact.name) || existing.name;
      }
      continue;
    }
    const person: PortalPerson = { email, name: clean(contact.name) || email, contactId: contact.id, isPrimary: false };
    people.push(person);
    byEmail.set(email, person);
  }
  return people;
}

/** Zonder opgeslagen keuze: alles aan; het hoofdadres over alle tickets, een contactpersoon over de eigen. */
export function defaultPortalPrefs(person: Pick<PortalPerson, 'isPrimary'>): PortalNotifyPrefs {
  return { ticketCreated: true, ticketStatus: true, ticketReply: true, scope: person.isPrimary ? 'all' : 'own' };
}

/** De keuzes van één persoon: de opgeslagen rij, anders de standaard. */
export function portalPrefsFor(person: PortalPerson, rows: ReadonlyArray<PortalSettingsRow>): PortalNotifyPrefs {
  const fallback = defaultPortalPrefs(person);
  const row = rows.find((candidate) => normalizeEmail(candidate.email) === person.email);
  if (!row) return fallback;
  return {
    ticketCreated: typeof row.notify_ticket_created === 'boolean' ? row.notify_ticket_created : fallback.ticketCreated,
    ticketStatus: typeof row.notify_ticket_status === 'boolean' ? row.notify_ticket_status : fallback.ticketStatus,
    ticketReply: typeof row.notify_ticket_reply === 'boolean' ? row.notify_ticket_reply : fallback.ticketReply,
    scope: row.notify_scope === 'own' || row.notify_scope === 'all' ? row.notify_scope : fallback.scope,
  };
}

/** Diende deze persoon het ticket zelf in? */
export function isTicketRequester(person: PortalPerson, ticket: Pick<PortalTicketRef, 'created_by_contact_id' | 'created_by_email'>): boolean {
  if (ticket.created_by_contact_id && person.contactId === ticket.created_by_contact_id) return true;
  const email = normalizeEmail(ticket.created_by_email);
  return Boolean(email && email === person.email);
}

/**
 * Deed deze persoon het zelf? Alleen een klant kan "zelf" iets doen. Een
 * reactie uit het portaal zonder contactpersoon komt van het hoofdadres: zo
 * legt client-portal hem vast (resolveActingContact vindt dan niemand).
 */
export function isPortalActor(person: PortalPerson, activity: Pick<PortalActivity, 'actor_type' | 'actor_contact_id' | 'actor_email'>): boolean {
  if (activity.actor_type !== 'client') return false;
  if (activity.actor_contact_id) return person.contactId === activity.actor_contact_id;
  const email = normalizeEmail(activity.actor_email);
  if (email) return person.email === email;
  return person.isPrimary;
}

export interface PlannedPortalMail {
  person: PortalPerson;
  /** Zelf ingediend? Dan heet het "je ticket". */
  ownTicket: boolean;
  /** Ontvangstbevestiging van een ticket dat de ontvanger zelf net indiende. */
  confirmation: boolean;
  /** Een nieuw ticket dat iemand anders (het team of een collega) aanmaakte. */
  created: PortalActivity | null;
  /** Netto statuswijziging in deze bundel. */
  status: { from: string | null; to: string } | null;
  /** Antwoorden van anderen, oudste eerst. */
  replies: PortalActivity[];
  /** Alle gebeurtenissen die in deze mail zitten. */
  activityIds: string[];
}

export interface PortalTicketPlan {
  mails: PlannedPortalMail[];
  /** Gebeurtenissen die niemand meer hoeft te krijgen, met de reden. */
  skipped: Array<{ id: string; reason: string }>;
}

export interface PortalTicketPlanInput {
  ticket: PortalTicketRef;
  /** De geclaimde activiteit van dit ticket. */
  activity: ReadonlyArray<PortalActivity>;
  people: ReadonlyArray<PortalPerson>;
  settings: ReadonlyArray<PortalSettingsRow>;
  /** Notities die NU nog bestaan én zichtbaar zijn voor de klant. */
  visibleNoteIds: ReadonlySet<string>;
  /** Adressen die nooit gemaild worden (bounce of spamklacht). */
  suppressed?: ReadonlySet<string>;
}

/** Wie krijgt welke mail over dit ticket, en welke gebeurtenissen vervallen. */
export function planTicketNotifications(input: PortalTicketPlanInput): PortalTicketPlan {
  const skipped: Array<{ id: string; reason: string }> = [];
  const ordered = [...input.activity].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const live: PortalActivity[] = [];
  for (const activity of ordered) {
    if (!input.ticket.client_id || activity.client_id !== input.ticket.client_id) {
      skipped.push({ id: activity.id, reason: 'Het ticket hoort niet (meer) bij deze klant.' });
      continue;
    }
    if (activity.kind === 'reply' && (!activity.note_id || !input.visibleNoteIds.has(activity.note_id))) {
      skipped.push({ id: activity.id, reason: 'Het antwoord is verwijderd of weer intern gemaakt.' });
      continue;
    }
    live.push(activity);
  }

  // Statussen netto: van de oude status vóór de eerste wijziging naar de nieuwe
  // status ná de laatste. Terug naar af (nieuw → in behandeling → nieuw) is
  // geen nieuws.
  const statusEvents = live.filter((a) => a.kind === 'status');
  let status: { from: string | null; to: string } | null = null;
  if (statusEvents.length > 0) {
    const from = statusEvents[0].old_status;
    const to = statusEvents[statusEvents.length - 1].new_status;
    if (!to || to === from) {
      for (const event of statusEvents) skipped.push({ id: event.id, reason: 'De status is per saldo niet veranderd.' });
    } else {
      status = { from, to };
    }
  }
  const statusIds = status ? statusEvents.map((a) => a.id) : [];
  const created = live.find((a) => a.kind === 'created') ?? null;
  const replies = live.filter((a) => a.kind === 'reply');

  const mails: PlannedPortalMail[] = [];
  for (const person of input.people) {
    if (input.suppressed?.has(person.email)) continue;
    const prefs = portalPrefsFor(person, input.settings);
    const ownTicket = isTicketRequester(person, input.ticket);
    const interested = prefs.scope === 'all' || ownTicket;
    const notYet = (activity: PortalActivity) => !(activity.notified_emails ?? []).includes(person.email);

    let confirmation = false;
    let createdForPerson: PortalActivity | null = null;
    if (created && notYet(created) && prefs.ticketCreated) {
      if (isPortalActor(person, created)) confirmation = true;
      else if (interested) createdForPerson = created;
    }

    // Wie in deze mail het nieuwe ticket al te zien krijgt, ziet daar ook de
    // huidige status; een losse statusregel ernaast zou dubbel zijn.
    const coveredByCreated = confirmation || createdForPerson !== null;
    const statusForPerson = status && !coveredByCreated && interested && prefs.ticketStatus
      && statusEvents.some(notYet)
      ? status
      : null;

    const repliesForPerson = replies.filter((reply) =>
      notYet(reply) && interested && prefs.ticketReply && !isPortalActor(person, reply));

    if (!confirmation && !createdForPerson && !statusForPerson && repliesForPerson.length === 0) continue;

    const activityIds = [
      ...(confirmation || createdForPerson ? [created!.id] : []),
      // Gebundeld in "nieuw ticket": de statuswijzigingen zijn dan ook bezorgd.
      ...(statusForPerson || coveredByCreated ? statusIds : []),
      ...repliesForPerson.map((reply) => reply.id),
    ];

    mails.push({
      person,
      ownTicket,
      confirmation,
      created: createdForPerson,
      status: statusForPerson,
      replies: repliesForPerson,
      activityIds: [...new Set(activityIds)],
    });
  }

  return { mails, skipped };
}

/** "Ticket in behandeling genomen" — hoe een statuswijziging in een onderwerpregel leest. */
export function portalStatusSentence(status: string): string {
  switch (status) {
    case 'review': return 'in behandeling genomen';
    case 'approved': return 'goedgekeurd';
    case 'rejected': return 'afgewezen';
    case 'converted': return 'omgezet naar een project';
    case 'new': return 'weer op nieuw gezet';
    default: return `nu ‘${portalTicketStatusLabel(status)}’`;
  }
}

/** Deeplinks in de mail: het portaal opent het juiste dossier en ticket. */
export function portalTicketUrl(baseUrl: string, clientId: string, ticketId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/portal?dossier=${encodeURIComponent(clientId)}&ticket=${encodeURIComponent(ticketId)}`;
}

export function portalSettingsUrl(baseUrl: string, clientId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/portal?dossier=${encodeURIComponent(clientId)}&view=instellingen`;
}
