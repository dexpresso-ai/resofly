// ============================================================
// De zeven resources achter de vaste adressen van de API, veld voor veld.
//
// Elke resource zegt welke kolommen er naar buiten gaan, welke je mag zetten,
// met welk type en welke toegestane waarden — gelijk aan de CHECK-constraints
// in de database (apiResourceSpecs.test.ts legt ze naast de migraties). Een
// kolom die hier niet staat, bestaat voor de API niet: niet in het antwoord,
// niet als invoer. Zo komt er nooit per ongeluk een interne of geheime kolom
// naar buiten omdat iemand hem aan een tabel toevoegde.
//
// BEWUST NIET TE ZETTEN
//  - organization_id, created_by, tijden: uit de sleutel en de database.
//  - Klantnummer (client_code): kent de app toe, net als bij aanmaken in het
//    scherm (create_client_with_next_code).
//  - Portaaltoegang van een contactpersoon: een deur naar het klantportaal
//    geef je in de app, niet vanuit een koppeling.
//  - Wiens uren (time_entries.user_id): van het teamlid achter de sleutel.
//  - De schrijver van een reactie: het teamlid achter de sleutel.
// ============================================================

import { matchRoute } from './publicApi.ts';
import { ResourceInputError, type ResourceName, type ResourceSpec } from './apiResources.ts';

const ID = { type: 'uuid', description: 'Het id.', readOnly: true } as const;
const CREATED_AT = { type: 'datetime', description: 'Wanneer aangemaakt.', readOnly: true } as const;
const UPDATED_AT = { type: 'datetime', description: 'Wanneer voor het laatst gewijzigd.', readOnly: true } as const;
const CREATED_BY = { type: 'uuid', description: 'Het teamlid dat dit aanmaakte.', readOnly: true, nullable: true } as const;

/** De standaard-sortering: nieuwste eerst, of op de laatste wijziging voor wie bijhoudt wat er veranderde. */
const TIME_SORTS = ['-created_at', 'created_at', '-updated_at', 'updated_at'] as const;

export const CLIENT_STATUSES = ['active', 'prospect', 'inactive'] as const;
export const CLIENT_KINDS = ['business', 'consumer'] as const;
export const PROJECT_BILLING_TYPES = ['hourly', 'fixed_price'] as const;
export const TASK_STATUSES = ['todo', 'doing', 'review', 'done'] as const;
export const PRIORITIES = ['low', 'med', 'high'] as const;
export const TICKET_STATUSES = ['new', 'review', 'approved', 'rejected', 'converted'] as const;
export const TIME_ENTRY_TYPES = ['direct', 'indirect'] as const;
export const INDIRECT_CATEGORIES = ['admin', 'acquisition', 'travel', 'education', 'other'] as const;

export const RESOURCES: Record<ResourceName, ResourceSpec> = {
  clients: {
    name: 'clients',
    path: 'clients',
    table: 'clients',
    module: 'clients',
    schemaName: 'Client',
    label: 'Klant',
    labelPlural: 'Klanten',
    event: 'client',
    fields: {
      id: ID,
      name: { type: 'text', description: 'Naam van de klant of het bedrijf.', required: true, maxLength: 200 },
      client_code: { type: 'text', description: 'Klantnummer; kent ResoFly toe bij het aanmaken.', readOnly: true, nullable: true },
      client_kind: { type: 'enum', description: 'Zakelijk of particulier.', values: CLIENT_KINDS, default: 'business' },
      status: { type: 'enum', description: 'Actief, prospect of inactief.', values: CLIENT_STATUSES, default: 'active' },
      contact_name: { type: 'text', description: 'Naam van de vaste contactpersoon.', nullable: true, maxLength: 200 },
      email: { type: 'email', description: 'Algemeen e-mailadres.', nullable: true },
      phone: { type: 'text', description: 'Telefoonnummer.', nullable: true, maxLength: 50 },
      vat_number: { type: 'text', description: 'Btw-nummer.', nullable: true, maxLength: 40 },
      kvk_number: { type: 'text', description: 'KvK-nummer.', nullable: true, maxLength: 20 },
      address_line1: { type: 'text', description: 'Adres, eerste regel.', nullable: true, maxLength: 200 },
      address_line2: { type: 'text', description: 'Adres, tweede regel.', nullable: true, maxLength: 200 },
      postal_code: { type: 'text', description: 'Postcode.', nullable: true, maxLength: 20 },
      city: { type: 'text', description: 'Plaats.', nullable: true, maxLength: 100 },
      country: { type: 'text', description: 'Land.', nullable: true, maxLength: 100 },
      notes: { type: 'text', description: 'Notities.', nullable: true, maxLength: 10_000 },
      tags: { type: 'text_array', description: 'Labels (hooguit 30).', maxLength: 60, maxItems: 30 },
      color: { type: 'color', description: 'Kleur in de app, als #RRGGBB.', default: '#FFD966' },
      value_eur: { type: 'number', description: 'Geschatte waarde in euro. Zonder leesrecht in Financiën: null.', minimum: 0, module: 'finance' },
      follow_up: { type: 'date', description: 'Datum om op terug te komen.', nullable: true },
      custom_fields: { type: 'object', description: 'Eigen velden, zoals ingesteld onder Instellingen → Klanten.' },
      created_by: CREATED_BY,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      status: { column: 'status', op: 'eq', type: 'enum', values: CLIENT_STATUSES, description: 'Alleen klanten met deze status.' },
      client_kind: { column: 'client_kind', op: 'eq', type: 'enum', values: CLIENT_KINDS, description: 'Zakelijk of particulier.' },
      email: { column: 'email', op: 'eq', type: 'text', description: 'Precies dit e-mailadres (hoofdletters maken niet uit).', lowercase: true },
    },
    search: ['name', 'contact_name', 'email', 'client_code'],
    sort: ['-created_at', 'created_at', 'name', '-name', '-updated_at', 'updated_at'],
    create: true,
    update: true,
  },

  contacts: {
    name: 'contacts',
    path: 'contacts',
    table: 'client_contacts',
    module: 'clients',
    schemaName: 'Contact',
    label: 'Contactpersoon',
    labelPlural: 'Contactpersonen',
    event: 'contact',
    fields: {
      id: ID,
      client_id: { type: 'uuid', description: 'De klant waar deze contactpersoon bij hoort.', required: true, createOnly: true, references: 'clients' },
      name: { type: 'text', description: 'Naam.', required: true, maxLength: 200 },
      email: { type: 'email', description: 'E-mailadres.', required: true },
      phone: { type: 'text', description: 'Telefoonnummer.', nullable: true, maxLength: 50 },
      role: { type: 'text', description: 'Functie of rol bij de klant.', nullable: true, maxLength: 100 },
      is_active: { type: 'boolean', description: 'Actief; een inactieve contactpersoon blijft bewaard maar krijgt niets meer.', default: true },
      gives_portal_access: { type: 'boolean', description: 'Heeft toegang tot het klantportaal. Geef je in de app.', readOnly: true },
      origin: { type: 'text', description: 'Hoe de contactpersoon erin kwam: handmatig of automatisch uit een mail.', readOnly: true },
      created_by: CREATED_BY,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      client_id: { column: 'client_id', op: 'eq', type: 'uuid', description: 'Alleen contactpersonen van deze klant.' },
      is_active: { column: 'is_active', op: 'eq_bool', type: 'boolean', description: 'Alleen actieve (true) of inactieve (false).' },
      email: { column: 'email', op: 'eq', type: 'text', description: 'Precies dit e-mailadres (hoofdletters maken niet uit).', lowercase: true },
    },
    search: ['name', 'email'],
    sort: ['-created_at', 'created_at', 'name', '-name', '-updated_at', 'updated_at'],
    create: true,
    update: true,
  },

  projects: {
    name: 'projects',
    path: 'projects',
    table: 'projects',
    module: 'projects',
    schemaName: 'Project',
    label: 'Project',
    labelPlural: 'Projecten',
    event: 'project',
    fields: {
      id: ID,
      name: { type: 'text', description: 'Naam van het project.', required: true, maxLength: 200 },
      client_id: { type: 'uuid', description: 'De klant van dit project.', nullable: true, references: 'clients' },
      description: { type: 'text', description: 'Omschrijving.', nullable: true, maxLength: 10_000 },
      archived: { type: 'boolean', description: 'Gearchiveerd.', default: false },
      start_date: { type: 'date', description: 'Startdatum.', nullable: true },
      end_date: { type: 'date', description: 'Einddatum.', nullable: true },
      billing_type: { type: 'enum', description: 'Per uur of vaste prijs.', values: PROJECT_BILLING_TYPES, default: 'hourly' },
      hourly_rate_cents: {
        type: 'integer', description: 'Uurtarief in centen (8750 = € 87,50). Zonder leesrecht in Financiën: null.',
        nullable: true, minimum: 0, module: 'finance',
      },
      budgeted_minutes: { type: 'integer', description: 'Begroot aantal minuten.', nullable: true, minimum: 0 },
      color: { type: 'color', description: 'Kleur in de app, als #RRGGBB.', default: '#FFD966' },
      contract_id: { type: 'uuid', description: 'Het contract waar dit project onder valt; koppel je in de app.', readOnly: true, nullable: true },
      created_by: CREATED_BY,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      client_id: { column: 'client_id', op: 'eq', type: 'uuid', description: 'Alleen projecten van deze klant.' },
      archived: { column: 'archived', op: 'eq_bool', type: 'boolean', description: 'Gearchiveerd (true) of lopend (false).' },
    },
    search: ['name'],
    sort: ['-created_at', 'created_at', 'name', '-name', '-updated_at', 'updated_at', 'start_date', '-start_date'],
    create: true,
    update: true,
  },

  tasks: {
    name: 'tasks',
    path: 'tasks',
    table: 'tasks',
    module: 'projects',
    schemaName: 'Task',
    label: 'Taak',
    labelPlural: 'Taken',
    event: 'task',
    fields: {
      id: ID,
      title: { type: 'text', description: 'Titel.', required: true, maxLength: 500 },
      description: { type: 'text', description: 'Omschrijving.', nullable: true, maxLength: 10_000 },
      status: { type: 'enum', description: 'Te doen, bezig, review of klaar.', values: TASK_STATUSES, default: 'todo' },
      priority: { type: 'enum', description: 'Prioriteit.', values: PRIORITIES, default: 'med' },
      project_id: { type: 'uuid', description: 'Het project.', nullable: true, references: 'projects' },
      client_id: { type: 'uuid', description: 'De klant.', nullable: true, references: 'clients' },
      ticket_id: { type: 'uuid', description: 'Het ticket waar deze taak uit voortkwam.', readOnly: true, nullable: true },
      tags: { type: 'text_array', description: 'Labels (hooguit 20).', maxLength: 60, maxItems: 20 },
      start_date: { type: 'date', description: 'Startdatum.', nullable: true },
      end_date: { type: 'date', description: 'Deadline.', nullable: true },
      planned_date: { type: 'date', description: 'Ingepland op deze dag.', nullable: true },
      planned_end_date: { type: 'date', description: 'Ingepland tot en met deze dag (alleen samen met planned_date).', nullable: true },
      planned_start_minute: { type: 'integer', description: 'Begintijd op de geplande dag, in minuten na middernacht (540 = 09:00).', nullable: true, minimum: 0, maximum: 1439 },
      estimated_minutes: { type: 'integer', description: 'Geschatte duur in minuten.', nullable: true, minimum: 0, maximum: 1440 },
      created_by: CREATED_BY,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      project_id: { column: 'project_id', op: 'eq', type: 'uuid', description: 'Alleen taken van dit project.' },
      client_id: { column: 'client_id', op: 'eq', type: 'uuid', description: 'Alleen taken van deze klant.' },
      status: { column: 'status', op: 'eq', type: 'enum', values: TASK_STATUSES, description: 'Alleen taken met deze status.' },
      priority: { column: 'priority', op: 'eq', type: 'enum', values: PRIORITIES, description: 'Alleen taken met deze prioriteit.' },
      planned_from: { column: 'planned_date', op: 'gte', type: 'date', description: 'Ingepland vanaf deze dag.' },
      planned_to: { column: 'planned_date', op: 'lte', type: 'date', description: 'Ingepland tot en met deze dag.' },
    },
    search: ['title', 'description'],
    sort: ['-created_at', 'created_at', '-updated_at', 'updated_at', 'planned_date', '-planned_date', 'end_date', 'title'],
    create: true,
    update: true,
    refine: refineTaskPlanning,
  },

  tickets: {
    name: 'tickets',
    path: 'tickets',
    table: 'tickets',
    module: 'tickets',
    schemaName: 'Ticket',
    label: 'Ticket',
    labelPlural: 'Tickets',
    event: 'ticket',
    fields: {
      id: ID,
      title: { type: 'text', description: 'Onderwerp.', required: true, maxLength: 300 },
      description: { type: 'text', description: 'De vraag of melding.', nullable: true, maxLength: 20_000 },
      status: {
        type: 'enum', description: 'Nieuw, in review, goedgekeurd, afgewezen of omgezet naar een project (dat laatste gebeurt in de app).',
        values: TICKET_STATUSES, inputValues: ['new', 'review', 'approved', 'rejected'], default: 'new',
      },
      priority: { type: 'enum', description: 'Prioriteit.', values: PRIORITIES, default: 'med' },
      client_id: { type: 'uuid', description: 'De klant.', nullable: true, references: 'clients' },
      notes: { type: 'text', description: 'Interne notities bij het ticket.', nullable: true, maxLength: 20_000 },
      converted_to_project_id: { type: 'uuid', description: 'Het project waar dit ticket in is omgezet.', readOnly: true, nullable: true },
      created_by_name: { type: 'text', description: 'Naam van de indiener (bij een ticket uit het portaal).', readOnly: true, nullable: true },
      created_by_email: { type: 'email', description: 'E-mailadres van de indiener (bij een ticket uit het portaal).', readOnly: true, nullable: true },
      created_by: CREATED_BY,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      client_id: { column: 'client_id', op: 'eq', type: 'uuid', description: 'Alleen tickets van deze klant.' },
      status: { column: 'status', op: 'eq', type: 'enum', values: TICKET_STATUSES, description: 'Alleen tickets met deze status.' },
      priority: { column: 'priority', op: 'eq', type: 'enum', values: PRIORITIES, description: 'Alleen tickets met deze prioriteit.' },
    },
    search: ['title', 'description'],
    sort: ['-created_at', 'created_at', '-updated_at', 'updated_at', 'title'],
    create: true,
    update: true,
  },

  ticket_notes: {
    name: 'ticket_notes',
    path: 'tickets/{ticket_id}/notes',
    table: 'ticket_notes',
    module: 'tickets',
    schemaName: 'TicketNote',
    label: 'Reactie',
    labelPlural: 'Reacties',
    event: 'ticket_note',
    parent: { resource: 'tickets', column: 'ticket_id', param: 'ticket_id' },
    fields: {
      id: ID,
      ticket_id: { type: 'uuid', description: 'Het ticket; staat in het adres.', readOnly: true },
      body: { type: 'text', description: 'De tekst.', required: true, maxLength: 8000 },
      is_internal: {
        type: 'boolean',
        description: 'Intern (true) of zichtbaar voor de klant in het portaal (false). Via de API standaard intern.',
      },
      author_type: { type: 'enum', description: 'Van een teamlid (user) of van de klant (client).', values: ['user', 'client'], readOnly: true },
      author_user_id: { type: 'uuid', description: 'Het teamlid dat de reactie schreef.', readOnly: true, nullable: true },
      author_name: { type: 'text', description: 'Naam of e-mailadres van de schrijver, zoals het op dat moment was.', readOnly: true, nullable: true },
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      is_internal: { column: 'is_internal', op: 'eq_bool', type: 'boolean', description: 'Alleen interne (true) of zichtbare (false) reacties.' },
    },
    search: ['body'],
    sort: ['created_at', '-created_at'],
    create: true,
    update: false,
    // Een reactie die de klant ziet, is een bericht naar buiten. Wie dat wil,
    // zegt het: zonder is_internal blijft hij intern.
    createDefaults: { is_internal: true },
  },

  time_entries: {
    name: 'time_entries',
    path: 'time_entries',
    table: 'time_entries',
    module: 'time',
    schemaName: 'TimeEntry',
    label: 'Urenpost',
    labelPlural: 'Uren',
    event: 'time_entry',
    fields: {
      id: ID,
      user_id: { type: 'uuid', description: 'Wiens uren: het teamlid achter de sleutel.', readOnly: true },
      entry_date: { type: 'date', description: 'De dag; standaard vandaag (Nederlandse tijd).' },
      minutes: { type: 'integer', description: 'Aantal minuten.', required: true, minimum: 1, maximum: 1440 },
      started_at: { type: 'datetime', description: 'Begintijd (optioneel).', nullable: true },
      ended_at: { type: 'datetime', description: 'Eindtijd (optioneel).', nullable: true },
      description: { type: 'text', description: 'Waaraan gewerkt.', nullable: true, maxLength: 2000 },
      project_id: { type: 'uuid', description: 'Het project.', nullable: true, references: 'projects' },
      client_id: { type: 'uuid', description: 'De klant.', nullable: true, references: 'clients' },
      task_id: { type: 'uuid', description: 'De taak.', nullable: true, references: 'tasks' },
      billable: {
        type: 'boolean',
        description: 'Declarabel. Weggelaten: zoals de app het kiest — niet bij een project met een vaste prijs of bij indirecte uren, anders wel.',
      },
      hourly_rate_cents: {
        type: 'integer',
        description: 'Uurtarief in centen. Weggelaten: het tarief van het project, anders het standaardtarief van de organisatie. Zonder leesrecht in Financiën: null.',
        nullable: true, minimum: 0, module: 'finance',
      },
      entry_type: { type: 'enum', description: 'Direct (voor een klant of project) of indirect (eigen organisatie).', values: TIME_ENTRY_TYPES, default: 'direct' },
      indirect_category: { type: 'enum', description: 'Bij indirecte uren: waaraan.', values: INDIRECT_CATEGORIES, nullable: true },
      source: { type: 'text', description: 'Hoe de uren erin kwamen.', readOnly: true },
      created_by: CREATED_BY,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    filters: {
      user_id: { column: 'user_id', op: 'eq', type: 'uuid', description: 'Alleen de uren van dit teamlid.' },
      project_id: { column: 'project_id', op: 'eq', type: 'uuid', description: 'Alleen uren op dit project.' },
      client_id: { column: 'client_id', op: 'eq', type: 'uuid', description: 'Alleen uren voor deze klant.' },
      task_id: { column: 'task_id', op: 'eq', type: 'uuid', description: 'Alleen uren op deze taak.' },
      billable: { column: 'billable', op: 'eq_bool', type: 'boolean', description: 'Declarabel (true) of niet (false).' },
      entry_type: { column: 'entry_type', op: 'eq', type: 'enum', values: TIME_ENTRY_TYPES, description: 'Direct of indirect.' },
      from: { column: 'entry_date', op: 'gte', type: 'date', description: 'Vanaf deze dag.' },
      to: { column: 'entry_date', op: 'lte', type: 'date', description: 'Tot en met deze dag.' },
    },
    search: ['description'],
    sort: ['-entry_date', 'entry_date', ...TIME_SORTS],
    create: true,
    update: true,
    refine: refineTimeEntry,
  },
};

export const RESOURCE_LIST: ResourceSpec[] = Object.values(RESOURCES);

// ── Regels over meer velden ──────────────────────────────────────────────────
//
// Wat in één verzoek al te zien is, zeggen we meteen en in gewone taal. Wat van
// de bestaande rij afhangt (een PATCH die alleen planned_end_date stuurt),
// bewaakt de database met dezelfde CHECK-constraints als in de app.

/** Een taak op één dag (met begintijd) of over meer dagen (zonder) — zoals de weekplanner. */
export function refineTaskPlanning(values: Record<string, unknown>, mode: 'create' | 'update'): void {
  const start = values.planned_date;
  const end = values.planned_end_date;
  if (end !== undefined && end !== null) {
    if (mode === 'create' && (start === undefined || start === null)) {
      throw new ResourceInputError('"planned_end_date" kan alleen samen met "planned_date".', 'planned_end_date');
    }
    if (typeof start === 'string' && String(end) < start) {
      throw new ResourceInputError('"planned_end_date" ligt op of na "planned_date".', 'planned_end_date');
    }
  }
  const minute = values.planned_start_minute;
  if (minute !== undefined && minute !== null) {
    if (mode === 'create' && (start === undefined || start === null)) {
      throw new ResourceInputError('"planned_start_minute" kan alleen bij een ingeplande dag ("planned_date").', 'planned_start_minute');
    }
    if (end !== undefined && end !== null) {
      throw new ResourceInputError('Een begintijd kan alleen bij een taak op één dag, niet samen met "planned_end_date".', 'planned_start_minute');
    }
  }
}

/** De regels voor uren: het type (hieronder) en een eindtijd die niet vóór de begintijd ligt. */
export function refineTimeEntry(values: Record<string, unknown>, mode: 'create' | 'update'): void {
  refineTimeEntryType(values, mode);
  const start = values.started_at;
  const end = values.ended_at;
  if (typeof start === 'string' && typeof end === 'string' && Date.parse(end) < Date.parse(start)) {
    throw new ResourceInputError('"ended_at" ligt op of na "started_at".', 'ended_at');
  }
}

/** Een categorie hoort alleen bij indirecte uren; wie naar direct wisselt, verliest hem — net als in de app. */
export function refineTimeEntryType(values: Record<string, unknown>, mode: 'create' | 'update'): void {
  const type = values.entry_type ?? (mode === 'create' ? 'direct' : undefined);
  const category = values.indirect_category;
  if (type === 'direct') {
    if (category !== undefined && category !== null) {
      throw new ResourceInputError('"indirect_category" hoort alleen bij "entry_type": "indirect".', 'indirect_category');
    }
    if (values.entry_type === 'direct') values.indirect_category = null;
  }
}

/**
 * Welke resource hoort bij dit pad? `/v1/clients` (lijst), `/v1/clients/{id}`
 * (één), `/v1/tickets/{ticket_id}/notes[/{id}]` (reacties). Anders null.
 */
export function matchResource(route: string): { spec: ResourceSpec; id: string | null; parentId: string | null } | null {
  for (const spec of RESOURCE_LIST) {
    const base = `/v1/${spec.path.replace(/\{(\w+)\}/g, ':$1')}`;
    const parentParam = spec.parent?.param;
    const list = matchRoute(route, base);
    if (list) return { spec, id: null, parentId: parentParam ? list[parentParam] ?? null : null };
    const one = matchRoute(route, `${base}/:id`);
    if (one) return { spec, id: one.id, parentId: parentParam ? one[parentParam] ?? null : null };
  }
  return null;
}
