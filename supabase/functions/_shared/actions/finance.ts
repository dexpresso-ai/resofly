import {
  ActionError, bool, choice, euro, euroCents, id, joinShort, num, optChoice, optId, optNum,
  optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen aan de VERKOOPKANT van het geld: offertes en facturen.
 *
 * Aanmaken, wijzigen, versturen en omzetten zit al als eersteklas tool in gerrieCore
 * — `propose_quote`, `propose_invoice`, `propose_edit_quote`, `propose_edit_invoice`,
 * `propose_send_quote`, `propose_send_invoice`, `propose_convert_quote`,
 * `propose_send_reminders`, `list_quotes`, `list_invoices` en `get_financial_summary`.
 * Wat hier staat is de rest van wat het Finance-scherm kan en die tools níét:
 *
 *  - de interne goedkeuringsronde van een offerte (indienen / goedkeuren / afwijzen);
 *  - de levenscyclus van een factuur: status, projectkoppeling, betaald melden;
 *  - de incasso-trap: herinneringen per factuur pauzeren, één gekozen factuur
 *    herinneren, en de formele WIK-aanmaning opstellen, versturen of annuleren;
 *  - terugbetaling met creditnota, en die creditnota mailen;
 *  - het grootboek: verkoopfactuur en creditnota boeken, en een binnenkomende
 *    banktransactie tegen een geboekte factuur afletteren;
 *  - de historie lezen (versies, verzendhistorie, betalingen, terugbetalingen);
 *  - de instellingen die de klantpost bepalen: herinneringstermijnen, de
 *    debiteurenautomaat, de e-mailteksten en de bedrijfsgegevens op de factuur.
 *
 * Wat bewust ONTBREEKT:
 *  - een offerte of factuur VERWIJDEREN. Dat wist ook de bijlagen, en op een
 *    verstuurde of geboekte factuur rust bewaarplicht. Annuleren of crediteren wel.
 *  - PDF's, UBL-bestanden en briefpapier DOWNLOADEN of UPLOADEN. Een agent heeft
 *    geen bestand in handen; de knop in het scherm blijft daarvoor de weg.
 *  - de MOLLIE-sleutel koppelen of ontkoppelen (een geheime sleutel), en een
 *    terugbetaling VIA MOLLIE (dat zet echt geld in beweging bij de provider).
 *    De offline terugbetaling — je maakt het zelf over en legt het hier vast —
 *    kan wel.
 */

/** Statussen van een verkoopfactuur zoals het factuurformulier ze aanbiedt. */
const INVOICE_STATUS = ['draft', 'sent', 'overdue', 'paid', 'cancelled', 'void', 'written_off'] as const;

const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Concept', sent: 'Verzonden', overdue: 'Te laat', paid: 'Betaald',
  cancelled: 'Geannuleerd', void: 'Ongeldig gemaakt', written_off: 'Afgeboekt',
  refunded: 'Terugbetaald', accepted: 'Geaccepteerd',
};

/** Eindstatussen: de factuur telt daarna niet meer mee als vordering. */
const INVOICE_CLOSED = ['paid', 'cancelled', 'void', 'written_off', 'refunded'];

/** Vanuit deze offertestatussen kan de interne goedkeuringsronde niets meer. */
const QUOTE_LOCKED_STATUS = ['sent', 'accepted', 'rejected', 'expired', 'cancelled'];

const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: 'Concept', pending_internal_approval: 'Wacht op interne goedkeuring',
  internally_approved: 'Intern goedgekeurd', sent: 'Verstuurd', accepted: 'Geaccepteerd',
  rejected: 'Afgewezen', expired: 'Verlopen', cancelled: 'Geannuleerd',
};

/** De statussen die `book_all_unbooked_sales_invoices` oppakt (migratie 20260724100000). */
const BOOKABLE_STATUS = ['sent', 'accepted', 'paid', 'overdue'];

/** De e-mailsjablonen van de verkoopkant; de andere sleutels horen bij contracten en boekingen. */
const SALES_TEMPLATE_KEYS = [
  'quote.sent', 'invoice.sent', 'invoice.reminder.1', 'invoice.reminder.2', 'invoice.reminder.3', 'creditNote.sent',
] as const;

const TEMPLATE_LABELS: Record<string, string> = {
  'quote.sent': 'Offerte verstuurd',
  'invoice.sent': 'Factuur verstuurd',
  'invoice.reminder.1': 'Betalingsherinnering niveau 1',
  'invoice.reminder.2': 'Betalingsherinnering niveau 2',
  'invoice.reminder.3': 'Betalingsherinnering niveau 3',
  'creditNote.sent': 'Creditnota verstuurd',
};

// ── Kleine rekenhulpjes ─────────────────────────────────────────────────────

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Totaal incl. btw uit de regels, cent-exact en per btw-tarief opgeteld — dezelfde
 * volgorde van afronden als `computeTotals` in de browser en `lineTotal` in
 * gerrieCore. Zou je hier gewoon `qty * prijs * (1 + btw)` doen, dan wijkt het
 * bedrag op de goedkeurkaart een cent af van het bedrag op de factuur.
 */
function linesTotalEur(lines: unknown): number {
  const list = Array.isArray(lines) ? lines as Array<Record<string, unknown>> : [];
  const baseByRate = new Map<number, number>();
  let subtotalCents = 0;
  for (const line of list) {
    const netCents = Math.round(toNumber(line.quantity) * toNumber(line.unit_price) * 100);
    subtotalCents += netCents;
    const rate = toNumber(line.vat);
    baseByRate.set(rate, (baseByRate.get(rate) ?? 0) + netCents);
  }
  let vatCents = 0;
  for (const [rate, base] of baseByRate.entries()) vatCents += Math.round((base / 100) * (rate / 100));
  return (subtotalCents + vatCents) / 100;
}

/** Het bedrag dat het scherm toont: de opgeslagen som als die er is, anders uit de regels. */
function docTotalEur(doc: { total_amount?: unknown; lines?: unknown }): number {
  const stored = toNumber(doc.total_amount);
  return stored > 0 ? Math.round(stored * 100) / 100 : linesTotalEur(doc.lines);
}

/** Datum als "3 mrt 2026"; leeg blijft leeg. */
function dateShort(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Hele dagen tussen twee JJJJ-MM-DD-datums; negatief betekent "nog niet zover". */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86400000);
}

/** Naam van een klant, of null — bewust zacht: dit is versiering op de kaart. */
async function clientNameOf(ctx: ActionCtx, clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const { data } = await orgQuery(ctx, 'clients', 'name').eq('id', clientId).maybeSingle();
  return data ? String((data as { name: string }).name) : null;
}

/** Naam én e-mailadres van de klant bij een document; gooit als er niets te mailen valt. */
async function clientRecipient(ctx: ActionCtx, clientId: string | null, what: string): Promise<{ name: string; email: string }> {
  if (!clientId) throw new ActionError(`${what} heeft geen klant gekoppeld; koppel eerst een klant.`);
  const client = await row<{ name: string; email: string | null }>(ctx, 'clients', clientId, 'name, email', 'Klant');
  if (!client.email) throw new ActionError(`${client.name} heeft geen e-mailadres; vul dat eerst in bij de klant.`);
  return { name: client.name, email: client.email };
}

/** Goedkeuren, afwijzen en terugbetalen zijn owner/admin-werk — net als in de app. */
function requireAdmin(ctx: ActionCtx, what: string): void {
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new ActionError(`Alleen owners en admins mogen ${what}. Vraag een beheerder om dit te doen.`);
  }
}

/** True zodra een factuur onbetaald is én over de vervaldatum — spiegelt de cron-logica. */
function isReminderEligible(invoice: { status: string; due_date: string | null }, today: string): boolean {
  if (INVOICE_CLOSED.includes(invoice.status)) return false;
  if (invoice.status === 'overdue') return true;
  return Boolean(invoice.due_date && invoice.due_date < today);
}

export const FINANCE_ACTIONS: ActionDef[] = [
  // ── Offerte: de interne goedkeuringsronde ────────────────────────────────
  {
    id: 'quote.submit_internal_approval',
    label: 'Offerte ter interne goedkeuring indienen',
    module: 'finance',
    kind: 'write',
    description:
      'Zet een concept-offerte in de interne goedkeuringsronde. De status wordt "wacht op interne goedkeuring" en de INHOUD GAAT OP SLOT: regels, bedragen en datums zijn niet meer te wijzigen tot een owner of admin goedkeurt (`quote.approve_internal`) of afwijst (`quote.reject_internal`). ' +
      'Pas na goedkeuring kan de offerte met `propose_send_quote` naar de klant. Een offerte zonder regels weigert de database. Zoek de offerte met `list_quotes`.',
    keywords: ['offerte', 'indienen', 'ter goedkeuring', 'goedkeuringsronde', 'intern', 'akkoord vragen', 'review'],
    input: { quote_id: { type: 'string', description: 'Id van de offerte (exact, uit list_quotes).' } },
    required: ['quote_id'],
    async plan(ctx, input) {
      const quoteId = id(input, 'quote_id');
      const quote = await row<{ number: string; status: string; client_id: string | null; lines: unknown; total_amount: number | null }>(
        ctx, 'quotes', quoteId, 'number, status, client_id, lines, total_amount', 'Offerte');
      if (QUOTE_LOCKED_STATUS.includes(quote.status)) {
        throw new ActionError(`Offerte ${quote.number} staat op "${QUOTE_STATUS_LABELS[quote.status] ?? quote.status}" en kan niet meer intern worden ingediend.`);
      }
      if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
        throw new ActionError(`Offerte ${quote.number} heeft geen regels; vul die eerst in met propose_edit_quote.`);
      }
      return {
        title: `Offerte ${quote.number} ter interne goedkeuring indienen`,
        sub: joinShort([await clientNameOf(ctx, quote.client_id), euro(docTotalEur(quote)), 'de inhoud gaat tot de beslissing op slot']),
        kind: 'money',
        payload: { quote_id: quoteId, number: quote.number },
      };
    },
  },

  {
    id: 'quote.approve_internal',
    label: 'Offerte intern goedkeuren',
    module: 'finance',
    kind: 'write',
    description:
      'Keurt een ingediende offerte intern goed. De status wordt "intern goedgekeurd" en pas dán mag de offerte met `propose_send_quote` naar de klant. Alleen owners en admins kunnen dit. ' +
      'Een eerdere afwijsnotitie wordt gewist. Zoek de offerte met `list_quotes`.',
    keywords: ['offerte', 'goedkeuren', 'akkoord', 'fiatteren', 'intern goedkeuren', 'vrijgeven'],
    input: { quote_id: { type: 'string', description: 'Id van de offerte (exact, uit list_quotes).' } },
    required: ['quote_id'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'een offerte intern goedkeuren');
      const quoteId = id(input, 'quote_id');
      const quote = await row<{ number: string; status: string; client_id: string | null; lines: unknown; total_amount: number | null }>(
        ctx, 'quotes', quoteId, 'number, status, client_id, lines, total_amount', 'Offerte');
      if (!['pending_internal_approval', 'internally_approved', 'draft'].includes(quote.status)) {
        throw new ActionError(`Offerte ${quote.number} staat op "${QUOTE_STATUS_LABELS[quote.status] ?? quote.status}" en kan niet intern worden goedgekeurd.`);
      }
      return {
        title: `Offerte ${quote.number} intern goedkeuren`,
        sub: joinShort([await clientNameOf(ctx, quote.client_id), euro(docTotalEur(quote)), 'daarna mag hij naar de klant']),
        kind: 'money',
        payload: { quote_id: quoteId, number: quote.number },
      };
    },
  },

  {
    id: 'quote.reject_internal',
    label: 'Offerte intern afwijzen met reden',
    module: 'finance',
    kind: 'write',
    description:
      'Wijst een ingediende offerte intern af en legt de reden vast. De offerte gaat terug naar concept, de inhoud komt weer vrij en de afwijsnotitie is zichtbaar voor wie hem indiende. Dit is INTERN — de klant ziet er niets van. Alleen owners en admins kunnen dit. ' +
      'Schrijf de reden zoals je hem aan een collega zou zeggen ("marge te laag, prijs per dag omhoog").',
    keywords: ['offerte', 'afwijzen', 'afkeuren', 'terugsturen', 'niet akkoord', 'reden'],
    input: {
      quote_id: { type: 'string', description: 'Id van de offerte (exact, uit list_quotes).' },
      note: { type: 'string', description: 'Waarom hij wordt afgewezen — dit leest degene die hem indiende.' },
    },
    required: ['quote_id', 'note'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'een offerte intern afwijzen');
      const quoteId = id(input, 'quote_id');
      const note = str(input, 'note', 1000);
      const quote = await row<{ number: string; status: string; client_id: string | null }>(
        ctx, 'quotes', quoteId, 'number, status, client_id', 'Offerte');
      if (QUOTE_LOCKED_STATUS.includes(quote.status)) {
        throw new ActionError(`Offerte ${quote.number} staat op "${QUOTE_STATUS_LABELS[quote.status] ?? quote.status}" en kan niet meer intern worden afgewezen.`);
      }
      return {
        title: `Offerte ${quote.number} intern afwijzen`,
        sub: joinShort([await clientNameOf(ctx, quote.client_id), `reden: ${note}`]),
        kind: 'money',
        payload: { quote_id: quoteId, number: quote.number, note },
      };
    },
  },

  // ── Offerte en factuur: koppeling aan een project ────────────────────────
  {
    id: 'finance.link_project',
    label: 'Offerte of factuur aan een project koppelen',
    module: 'finance',
    kind: 'write',
    description:
      'Hangt een offerte of factuur aan een project, of maakt hem juist los. De koppeling bepaalt of het bedrag meetelt in de projectrapportage en of het document op de projectpagina staat. ' +
      '`propose_edit_quote` en `propose_edit_invoice` kunnen dit niet — daarvoor is deze handeling. Laat `project_id` weg om los te maken. Zoek het document met `list_quotes`/`list_invoices` en het project met `list_projects`.',
    keywords: ['project', 'koppelen', 'losmaken', 'offerte', 'factuur', 'projectrapportage', 'toewijzen'],
    input: {
      document: { type: 'string', enum: ['quote', 'invoice'], description: 'quote = offerte, invoice = factuur.' },
      document_id: { type: 'string', description: 'Id van de offerte of factuur.' },
      project_id: { type: 'string', description: 'Id van het project; weglaten betekent losmaken.' },
    },
    required: ['document', 'document_id'],
    async plan(ctx, input) {
      const documentKind = choice(input, 'document', ['quote', 'invoice'] as const);
      const documentId = id(input, 'document_id');
      const projectId = optId(input, 'project_id');
      const table = documentKind === 'quote' ? 'quotes' : 'invoices';
      const label = documentKind === 'quote' ? 'Offerte' : 'Factuur';
      const doc = await row<{ number: string; client_id: string | null; project_id: string | null }>(
        ctx, table, documentId, 'number, client_id, project_id', label);
      if ((doc.project_id ?? null) === projectId) {
        throw new ActionError(projectId ? `${label} ${doc.number} hangt al aan dat project.` : `${label} ${doc.number} hangt al aan geen enkel project.`);
      }
      let projectName: string | null = null;
      if (projectId) {
        const project = await row<{ name: string; client_id: string | null }>(ctx, 'projects', projectId, 'name, client_id', 'Project');
        if (project.client_id && doc.client_id && project.client_id !== doc.client_id) {
          throw new ActionError(`Project "${project.name}" hoort bij een andere klant dan ${label.toLowerCase()} ${doc.number}.`);
        }
        projectName = project.name;
      }
      return {
        title: projectName
          ? `${label} ${doc.number} koppelen aan project ${projectName}`
          : `${label} ${doc.number} losmaken van het project`,
        sub: joinShort([await clientNameOf(ctx, doc.client_id), projectName ? 'telt daarna mee in de projectrapportage' : 'telt daarna nergens meer in mee']),
        kind: 'work',
        payload: { document: documentKind, document_id: documentId, project_id: projectId, number: doc.number, project_name: projectName },
      };
    },
  },

  // ── Factuur: status en betaling ──────────────────────────────────────────
  {
    id: 'invoice.set_status',
    label: 'Factuurstatus wijzigen (o.a. betaald melden)',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Zet de status van een factuur met de hand. Dit is ook de manier om een BETALING TE REGISTREREN die buiten Mollie om binnenkwam: zet hem op "paid" en de factuur verdwijnt uit de debiteurenstand en uit de herinneringsflow. ' +
      'draft = concept, sent = verzonden, overdue = te laat, paid = betaald, cancelled = geannuleerd, void = ongeldig gemaakt, written_off = afgeboekt (oninbaar). ' +
      'Let op: "void" en "written_off" zijn feitelijk eindstations, en de bedragen zelf verander je hiermee niet. Zoek de factuur met `list_invoices`.',
    keywords: ['status', 'betaald', 'betaling registreren', 'markeren', 'voldaan', 'geannuleerd', 'afboeken', 'oninbaar', 'storneren', 'debiteuren'],
    input: {
      invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' },
      status: { type: 'string', enum: [...INVOICE_STATUS], description: 'De nieuwe status.' },
    },
    required: ['invoice_id', 'status'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const status = choice(input, 'status', INVOICE_STATUS);
      const invoice = await row<{ number: string; status: string; client_id: string | null; due_date: string | null; lines: unknown; total_amount: number | null; journal_entry_id: string | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, due_date, lines, total_amount, journal_entry_id', 'Factuur');
      if (invoice.status === status) {
        throw new ActionError(`Factuur ${invoice.number} staat al op "${INVOICE_STATUS_LABELS[status] ?? status}".`);
      }
      const warnings: Record<string, string> = {
        paid: 'De factuur telt daarna niet meer mee als openstaande vordering en de automatische herinneringen stoppen. Boek je hem ten onrechte af, dan klopt je debiteurenstand niet meer.',
        void: 'Ongeldig gemaakt is een eindstation: de factuur verdwijnt uit de debiteurenstand en uit de herinneringsflow, en je kunt hem daarna niet meer versturen of innen.',
        written_off: 'Afgeboekt betekent dat je deze vordering als oninbaar beschouwt. De factuur verdwijnt uit de debiteurenstand en uit de herinneringsflow.',
        cancelled: 'Een geannuleerde factuur wordt niet meer verstuurd of geïnd, en valt nog steeds onder de bewaarplicht — verwijderen kan niet.',
      };
      return {
        title: `Factuur ${invoice.number}: status "${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}" → "${INVOICE_STATUS_LABELS[status] ?? status}"`,
        sub: joinShort([
          await clientNameOf(ctx, invoice.client_id),
          euro(docTotalEur(invoice)),
          invoice.due_date ? `vervalt ${dateShort(invoice.due_date)}` : null,
          invoice.journal_entry_id ? 'staat in het grootboek' : null,
        ]),
        kind: 'money',
        warning: warnings[status],
        payload: { invoice_id: invoiceId, number: invoice.number, status, was: invoice.status },
      };
    },
  },

  // ── Factuur: de herinneringstrap ─────────────────────────────────────────
  {
    id: 'invoice.set_reminders_paused',
    label: 'Automatische herinneringen van één factuur pauzeren of hervatten',
    module: 'finance',
    kind: 'write',
    description:
      'Zet de automatische betalingsherinneringen voor ÉÉN factuur stil, of weer aan. Gebruik dit bij een betaalregeling of een lopend gesprek: de dagelijkse cron slaat een gepauzeerde factuur over, zodat de klant geen herinnering krijgt terwijl jullie er samen uit zijn. ' +
      'De factuur blijft gewoon openstaan en telt mee in de debiteurenstand. Handmatig herinneren (`invoice.send_reminder`) kan nog steeds. Zoek de factuur met `list_invoices`.',
    keywords: ['herinnering', 'pauzeren', 'stilzetten', 'hervatten', 'betaalregeling', 'aanmaning uitzetten', 'rappel'],
    input: {
      invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' },
      paused: { type: 'boolean', description: 'true = pauzeren, false = hervatten.' },
    },
    required: ['invoice_id', 'paused'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const paused = bool(input, 'paused', true);
      const invoice = await row<{ number: string; status: string; client_id: string | null; due_date: string | null; reminders_paused: boolean | null; reminder_level: number | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, due_date, reminders_paused, reminder_level', 'Factuur');
      if (Boolean(invoice.reminders_paused) === paused) {
        throw new ActionError(`De automatische herinneringen van factuur ${invoice.number} staan al ${paused ? 'op pauze' : 'aan'}.`);
      }
      return {
        title: `Automatische herinneringen ${paused ? 'pauzeren' : 'hervatten'} voor factuur ${invoice.number}`,
        sub: joinShort([
          await clientNameOf(ctx, invoice.client_id),
          `nu op niveau ${invoice.reminder_level ?? 0}`,
          paused ? 'de cron slaat deze factuur over' : 'de cron pakt de trap weer op',
        ]),
        kind: 'money',
        payload: { invoice_id: invoiceId, number: invoice.number, paused },
      };
    },
  },

  {
    id: 'invoice.send_reminder',
    label: 'Betalingsherinnering sturen voor één factuur',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Stuurt de klant handmatig de eerstvolgende betalingsherinnering voor ÉÉN gekozen te late factuur, met de factuur-PDF en (als Mollie gekoppeld is) een betaallink. ' +
      'Dit is iets anders dan `propose_send_reminders`: dat doet de hele batch die vandaag volgens de instellingen aan de beurt is. Hier kies je zelf de factuur, ook als de cron hem nog niet zou pakken. ' +
      'Zonder `level` gaat hij naar het volgende niveau (reminder_level + 1, hoogstens 3). Niveau 3 is de laatste aanmaning vóór de formele WIK-brief (`invoice.propose_dunning`). Kan niet bij een betaalde, geannuleerde of afgeboekte factuur.',
    keywords: ['herinnering', 'rappel', 'aanmanen', 'betalingsherinnering', 'te laat', 'openstaand', 'niveau', 'nabellen'],
    input: {
      invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' },
      level: { type: 'integer', enum: [1, 2, 3], description: 'Optioneel: forceer een niveau. Standaard het eerstvolgende.' },
    },
    required: ['invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const invoice = await row<{ number: string; status: string; client_id: string | null; due_date: string | null; reminder_level: number | null; reminders_paused: boolean | null; lines: unknown; total_amount: number | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, due_date, reminder_level, reminders_paused, lines, total_amount', 'Factuur');
      if (INVOICE_CLOSED.includes(invoice.status)) {
        throw new ActionError(`Factuur ${invoice.number} staat op "${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}"; daarvoor stuur je geen herinnering.`);
      }
      if (!isReminderEligible(invoice, ctx.today)) {
        throw new ActionError(`Factuur ${invoice.number} is nog niet vervallen${invoice.due_date ? ` (vervaldatum ${dateShort(invoice.due_date)})` : ' en heeft geen vervaldatum'}.`);
      }
      const forced = optNum(input, 'level');
      const level = forced === null ? Math.min(3, (invoice.reminder_level ?? 0) + 1) : Math.round(forced);
      if (level < 1 || level > 3) throw new ActionError('"level" moet 1, 2 of 3 zijn.');
      const recipient = await clientRecipient(ctx, invoice.client_id, `Factuur ${invoice.number}`);
      const overdue = invoice.due_date ? daysBetween(invoice.due_date, ctx.today) : 0;
      return {
        title: `Betalingsherinnering niveau ${level} sturen voor factuur ${invoice.number}`,
        sub: joinShort([
          recipient.name, recipient.email, euro(docTotalEur(invoice)),
          overdue > 0 ? `${overdue} dagen over de vervaldatum` : null,
          invoice.reminders_paused ? 'automatische herinneringen staan op pauze' : null,
        ]),
        kind: 'mail',
        warning: `Deze herinnering gaat echt per e-mail naar ${recipient.email}. Verzonden post haal je niet terug.`,
        payload: { invoice_id: invoiceId, number: invoice.number, level, client_name: recipient.name, email: recipient.email },
      };
    },
  },

  // ── Factuur: de formele aanmaning (WIK) ──────────────────────────────────
  {
    id: 'invoice.propose_dunning',
    label: 'Formele aanmaning (WIK-14-dagenbrief) opstellen',
    module: 'finance',
    kind: 'write',
    description:
      'Laat de server een AANMANINGSVOORSTEL berekenen voor een te late factuur: de wettelijke rente (consument) of handelsrente (zakelijk) tot vandaag, plus de incassokosten volgens de WIK-staffel. Er gaat hier nog NIETS naar de klant — het voorstel blijft klaarstaan tot iemand het bevestigt met `dunning.send` of het annuleert met `dunning.cancel`. ' +
      'Per factuur kan er maar één aanmaning bestaan. De factuur moet een vervaldatum hebben, nog openstaan en een klant met e-mailadres hebben. Lees het resultaat daarna terug met `dunning.list`.',
    keywords: ['aanmaning', 'wik', '14-dagenbrief', 'incassokosten', 'wettelijke rente', 'handelsrente', 'ingebrekestelling', 'debiteurenautomaat'],
    input: { invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' } },
    required: ['invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const invoice = await row<{ number: string; status: string; client_id: string | null; due_date: string | null; lines: unknown; total_amount: number | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, due_date, lines, total_amount', 'Factuur');
      if (INVOICE_CLOSED.includes(invoice.status)) {
        throw new ActionError(`Voor factuur ${invoice.number} ("${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}") kan geen aanmaning worden gemaakt.`);
      }
      if (!invoice.due_date) throw new ActionError(`Factuur ${invoice.number} heeft geen vervaldatum; zonder vervaldatum is er geen rente te berekenen.`);
      const { data: existing } = await orgQuery(ctx, 'invoice_dunning_notices', 'id, status').eq('invoice_id', invoiceId).maybeSingle();
      if (existing) {
        const current = (existing as { status: string }).status;
        throw new ActionError(`Er bestaat al een aanmaning voor factuur ${invoice.number} (status: ${current}). Annuleer die eerst met dunning.cancel.`);
      }
      const recipient = await clientRecipient(ctx, invoice.client_id, `Factuur ${invoice.number}`);
      const overdue = daysBetween(invoice.due_date, ctx.today);
      return {
        title: `Formele aanmaning opstellen voor factuur ${invoice.number}`,
        sub: joinShort([
          recipient.name, euro(docTotalEur(invoice)),
          overdue > 0 ? `${overdue} dagen te laat` : null,
          'rente en incassokosten worden berekend — hij gaat nog niet de deur uit',
        ]),
        kind: 'money',
        payload: { invoice_id: invoiceId, number: invoice.number, client_name: recipient.name },
      };
    },
  },

  {
    id: 'dunning.send',
    label: 'Aanmaning bevestigen en versturen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Bevestigt een klaarstaand aanmaningsvoorstel en verstuurt de formele brief per e-mail naar de klant. De rente wordt op de verzenddatum opnieuw berekend (dat bedrag is leidend, niet het bedrag uit het voorstel) en de 14-dagenbrief gaat als PDF mee. ' +
      'Bij een consument is dit de WIK-14-dagenbrief: pas ná die termijn mag je incassokosten in rekening brengen. Zoek het voorstel met `dunning.list`.',
    keywords: ['aanmaning', 'aanmaning sturen', 'sturen', 'versturen', 'bevestigen', 'wik', '14-dagenbrief', 'ingebrekestelling', 'incasso', 'sommatie'],
    input: { notice_id: { type: 'string', description: 'Id van de aanmaning (exact, uit dunning.list).' } },
    required: ['notice_id'],
    async plan(ctx, input) {
      const noticeId = id(input, 'notice_id');
      const notice = await row<{
        invoice_id: string; status: string; client_kind: string; principal_cents: number; interest_cents: number;
        collection_costs_cents: number; collection_costs_vat_cents: number; total_claim_cents: number; deadline_date: string | null;
      }>(ctx, 'invoice_dunning_notices', noticeId,
        'invoice_id, status, client_kind, principal_cents, interest_cents, collection_costs_cents, collection_costs_vat_cents, total_claim_cents, deadline_date', 'Aanmaning');
      if (notice.status === 'sent') throw new ActionError('Deze aanmaning is al verstuurd.');
      if (notice.status === 'cancelled') throw new ActionError('Deze aanmaning is geannuleerd; stel met invoice.propose_dunning een nieuwe op.');
      if (notice.status === 'confirmed') throw new ActionError('Deze aanmaning wordt al verstuurd.');
      const invoice = await row<{ number: string; status: string; client_id: string | null }>(
        ctx, 'invoices', notice.invoice_id, 'number, status, client_id', 'Factuur');
      if (INVOICE_CLOSED.includes(invoice.status)) {
        throw new ActionError(`Factuur ${invoice.number} staat op "${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}"; daar hoort geen aanmaning meer bij.`);
      }
      const recipient = await clientRecipient(ctx, invoice.client_id, `Factuur ${invoice.number}`);
      const collection = (Number(notice.collection_costs_cents) || 0) + (Number(notice.collection_costs_vat_cents) || 0);
      return {
        title: `Aanmaning versturen voor factuur ${invoice.number} — ${euroCents(notice.total_claim_cents)}`,
        sub: joinShort([
          recipient.name,
          notice.client_kind === 'consumer' ? 'consument · WIK' : 'zakelijk · handelsrente',
          `hoofdsom ${euroCents(notice.principal_cents)}`,
          `rente ${euroCents(notice.interest_cents)}`,
          collection > 0 ? `incassokosten ${euroCents(collection)}` : null,
        ]),
        kind: 'mail',
        warning: `Dit is een juridische aanmaning met rente en incassokosten en gaat echt naar ${recipient.email}. Verzonden post haal je niet terug; de rente wordt op de verzenddatum opnieuw berekend, dus het eindbedrag kan iets hoger uitvallen.`,
        payload: { notice_id: noticeId, invoice_id: notice.invoice_id, invoice_number: invoice.number, client_name: recipient.name, email: recipient.email },
      };
    },
  },

  {
    id: 'dunning.cancel',
    label: 'Aanmaningsvoorstel annuleren',
    module: 'finance',
    kind: 'write',
    description:
      'Annuleert een aanmaning die nog niet de deur uit is — bijvoorbeeld omdat de klant net betaald heeft of er een betaalregeling loopt. Een al VERSTUURDE aanmaning kun je niet annuleren; die is de wereld in. ' +
      'Na annuleren kun je met `invoice.propose_dunning` een nieuw voorstel laten berekenen. Zoek het voorstel met `dunning.list`.',
    keywords: ['aanmaning', 'annuleren', 'intrekken', 'afblazen', 'voorstel weghalen'],
    input: { notice_id: { type: 'string', description: 'Id van de aanmaning (exact, uit dunning.list).' } },
    required: ['notice_id'],
    async plan(ctx, input) {
      const noticeId = id(input, 'notice_id');
      const notice = await row<{ invoice_id: string; status: string; total_claim_cents: number }>(
        ctx, 'invoice_dunning_notices', noticeId, 'invoice_id, status, total_claim_cents', 'Aanmaning');
      if (notice.status === 'sent') throw new ActionError('Deze aanmaning is al verstuurd en kan niet meer worden geannuleerd.');
      if (notice.status === 'cancelled') throw new ActionError('Deze aanmaning is al geannuleerd.');
      const invoice = await row<{ number: string; client_id: string | null }>(ctx, 'invoices', notice.invoice_id, 'number, client_id', 'Factuur');
      return {
        title: `Aanmaningsvoorstel annuleren voor factuur ${invoice.number}`,
        sub: joinShort([await clientNameOf(ctx, invoice.client_id), euroCents(notice.total_claim_cents), 'het voorstel gaat niet de deur uit']),
        kind: 'money',
        payload: { notice_id: noticeId, invoice_number: invoice.number },
      };
    },
  },

  {
    id: 'dunning.list',
    label: 'Aanmaningen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de formele aanmaningen van de organisatie met de opbouw van de vordering: hoofdsom, rente, incassokosten en het totaal (allemaal in CENTEN), de rekendatum, de betaaltermijn en de status (proposed = wacht op bevestiging, sent = verstuurd, cancelled = geannuleerd). ' +
      'Hier haal je het `notice_id` vandaan dat `dunning.send` en `dunning.cancel` nodig hebben. Filter op status "proposed" om te zien wat er op jouw bevestiging wacht.',
    keywords: ['aanmaningen', 'wik', 'incasso', 'openstaand', 'rente', 'voorstellen', 'te bevestigen', 'debiteurenautomaat'],
    input: {
      status: { type: 'string', enum: ['proposed', 'confirmed', 'sent', 'failed', 'cancelled'], description: 'Beperk tot één status (optioneel).' },
      invoice_id: { type: 'string', description: 'Beperk tot één factuur (optioneel).' },
      limit: { type: 'number', description: 'Hoogste aantal (standaard 25, max 100).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 25), 1), 100);
      let query = orgQuery(ctx, 'invoice_dunning_notices',
        'id, invoice_id, status, stage, client_kind, interest_kind, principal_cents, interest_cents, interest_days, ' +
        'collection_costs_cents, collection_costs_vat_cents, total_claim_cents, calculation_date, due_date, deadline_date, proposed_at, sent_at')
        .order('proposed_at', { ascending: false }).limit(limit);
      const status = optChoice(input, 'status', ['proposed', 'confirmed', 'sent', 'failed', 'cancelled'] as const);
      if (status) query = query.eq('status', status);
      const invoiceId = optId(input, 'invoice_id');
      if (invoiceId) query = query.eq('invoice_id', invoiceId);
      const { data, error } = await query;
      if (error) throw new ActionError(`Aanmaningen ophalen mislukt: ${error.message}`);
      const notices = (data ?? []) as Array<Record<string, unknown>>;
      if (notices.length === 0) return { count: 0, notices: [] };

      // Factuurnummer en klantnaam erbij: zonder die twee is een lijst id's onbruikbaar.
      const invoiceIds = [...new Set(notices.map((n) => String(n.invoice_id)))];
      const { data: invoices } = await orgQuery(ctx, 'invoices', 'id, number, client_id, status').in('id', invoiceIds);
      const invoiceById = new Map<string, { number: string; client_id: string | null; status: string }>(
        ((invoices ?? []) as Array<Record<string, unknown>>).map((i) => [String(i.id), {
          number: String(i.number ?? ''), client_id: i.client_id ? String(i.client_id) : null, status: String(i.status ?? ''),
        }]));
      const clientIds = [...new Set([...invoiceById.values()].map((i) => i.client_id).filter((c): c is string => Boolean(c)))];
      const nameById = new Map<string, string>();
      if (clientIds.length > 0) {
        const { data: clients } = await orgQuery(ctx, 'clients', 'id, name').in('id', clientIds);
        for (const c of ((clients ?? []) as Array<Record<string, unknown>>)) nameById.set(String(c.id), String(c.name ?? ''));
      }
      return {
        count: notices.length,
        notices: notices.map((n) => {
          const invoice = invoiceById.get(String(n.invoice_id));
          return {
            ...n,
            invoice_number: invoice?.number ?? null,
            invoice_status: invoice?.status ?? null,
            client_name: invoice?.client_id ? nameById.get(invoice.client_id) ?? null : null,
          };
        }),
      };
    },
  },

  // ── Terugbetaling en creditnota ──────────────────────────────────────────
  {
    id: 'invoice.register_refund',
    label: 'Terugbetaling vastleggen en creditnota uitgeven',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Legt vast dat je een (deel van een) betaalde factuur hebt TERUGBETAALD, en geeft er standaard een creditnota bij uit met een eigen nummer. Dit is de OFFLINE variant: je maakt het bedrag zelf over (bijvoorbeeld via je bank) en registreert het hier. ' +
      'Een terugbetaling via Mollie kan hier bewust NIET — dat zet echt geld in beweging bij de betaalprovider en doe je met de hand in het factuurscherm. ' +
      'Alleen bij een betaalde factuur, en hoogstens het bedrag dat nog niet is terugbetaald. Bij een volledige terugbetaling gaat de factuur naar "Terugbetaald". Alleen owners en admins.',
    keywords: ['terugbetaling', 'refund', 'creditnota', 'crediteren', 'terugstorten', 'geld terug', 'annulering', 'prijscorrectie'],
    input: {
      invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' },
      amount_eur: { type: 'number', description: "Terug te betalen bedrag in euro's, inclusief btw." },
      reason: { type: 'string', description: 'Waarom je terugbetaalt (komt op de creditnota).' },
      create_credit_note: { type: 'boolean', description: 'Creditnota uitgeven. Standaard true.' },
    },
    required: ['invoice_id', 'amount_eur'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'terugbetalingen registreren');
      const invoiceId = id(input, 'invoice_id');
      const invoice = await row<{ number: string; status: string; client_id: string | null; lines: unknown; total_amount: number | null; refunded_amount: number | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, lines, total_amount, refunded_amount', 'Factuur');
      if (!['paid', 'refunded'].includes(invoice.status)) {
        throw new ActionError(`Alleen een betaalde factuur kan worden terugbetaald; factuur ${invoice.number} staat op "${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}".`);
      }
      const totalCents = Math.round(docTotalEur(invoice) * 100);
      const alreadyCents = Math.round(toNumber(invoice.refunded_amount) * 100);
      const remainingCents = Math.max(totalCents - alreadyCents, 0);
      if (remainingCents <= 0) throw new ActionError(`Factuur ${invoice.number} is al volledig terugbetaald.`);
      const amountCents = Math.round(num(input, 'amount_eur') * 100);
      if (amountCents <= 0) throw new ActionError('Het terugbetaalbedrag moet groter dan nul zijn.');
      if (amountCents > remainingCents) {
        throw new ActionError(`Er staat nog ${euroCents(remainingCents)} open om terug te betalen op factuur ${invoice.number}; ${euroCents(amountCents)} is te veel.`);
      }
      const reason = optStr(input, 'reason', 500);
      const withCreditNote = bool(input, 'create_credit_note', true);
      const clientName = await clientNameOf(ctx, invoice.client_id);
      return {
        title: `Terugbetaling van ${euroCents(amountCents)} vastleggen op factuur ${invoice.number}`,
        sub: joinShort([
          clientName, reason,
          withCreditNote ? 'met creditnota' : 'zonder creditnota',
          amountCents === remainingCents ? 'volledige terugbetaling' : `nog ${euroCents(remainingCents - amountCents)} over`,
        ]),
        kind: 'money',
        warning: withCreditNote
          ? 'Er wordt een creditnota met een eigen, doorlopend nummer uitgegeven. Die trek je niet meer in — en het geld moet je zelf overmaken; dit legt alleen vast dát je dat doet.'
          : 'Dit legt vast dat je het bedrag hebt terugbetaald; het geld moet je zelf overmaken. De factuuraggregaten worden meteen bijgewerkt.',
        payload: {
          invoice_id: invoiceId, number: invoice.number, amount_cents: amountCents,
          reason, create_credit_note: withCreditNote,
          // Vaste sleutel per voorstel: een tweede keer op Uitvoeren drukken boekt
          // dan geen tweede terugbetaling.
          idempotency_key: `action-refund-${crypto.randomUUID()}`,
        },
      };
    },
  },

  {
    id: 'credit_note.send',
    label: 'Creditnota naar de klant mailen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Mailt een uitgegeven creditnota als PDF naar het e-mailadres van de klant bij de bijbehorende factuur. Zoek de creditnota met `credit_note.list`. ' +
      'De tekst van die mail stel je in met `finance.set_email_template` (sleutel creditNote.sent).',
    keywords: ['creditnota', 'creditfactuur', 'mailen', 'versturen', 'credit note'],
    input: { credit_note_id: { type: 'string', description: 'Id van de creditnota (exact, uit credit_note.list).' } },
    required: ['credit_note_id'],
    async plan(ctx, input) {
      const creditNoteId = id(input, 'credit_note_id');
      const creditNote = await row<{ number: string; invoice_id: string; total_amount: number; status: string; date: string | null; reason: string | null }>(
        ctx, 'credit_notes', creditNoteId, 'number, invoice_id, total_amount, status, date, reason', 'Creditnota');
      if (creditNote.status === 'void') throw new ActionError(`Creditnota ${creditNote.number} is ongeldig gemaakt en wordt niet verstuurd.`);
      const invoice = await row<{ number: string; client_id: string | null }>(ctx, 'invoices', creditNote.invoice_id, 'number, client_id', 'Factuur');
      const recipient = await clientRecipient(ctx, invoice.client_id, `Creditnota ${creditNote.number}`);
      return {
        title: `Creditnota ${creditNote.number} mailen naar ${recipient.name}`,
        sub: joinShort([euro(toNumber(creditNote.total_amount)), `bij factuur ${invoice.number}`, recipient.email, creditNote.reason]),
        kind: 'mail',
        warning: `De creditnota gaat als PDF echt naar ${recipient.email}. Verzonden post haal je niet terug.`,
        payload: { credit_note_id: creditNoteId, number: creditNote.number, invoice_number: invoice.number, client_name: recipient.name, email: recipient.email },
      };
    },
  },

  {
    id: 'credit_note.list',
    label: 'Creditnota\'s bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de uitgegeven creditnota\'s: nummer, datum, bedrag, reden, status en of hij al in het grootboek staat (`journal_entry_id`). ' +
      'Hier haal je het `credit_note_id` vandaan dat `credit_note.send` en `credit_note.post_to_ledger` nodig hebben. Met `only_unbooked` zie je precies wat er nog geboekt moet worden.',
    keywords: ['creditnota', 'creditfacturen', 'credit notes', 'gecrediteerd', 'terugbetaling', 'ongeboekt'],
    input: {
      invoice_id: { type: 'string', description: 'Beperk tot de creditnota\'s bij één factuur (optioneel).' },
      only_unbooked: { type: 'boolean', description: 'Alleen creditnota\'s die nog niet in het grootboek staan.' },
      limit: { type: 'number', description: 'Hoogste aantal (standaard 25, max 100).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 25), 1), 100);
      let query = orgQuery(ctx, 'credit_notes',
        'id, invoice_id, refund_id, number, date, reason, currency, subtotal_amount, vat_amount, total_amount, status, journal_entry_id, created_at')
        .order('created_at', { ascending: false }).limit(limit);
      const invoiceId = optId(input, 'invoice_id');
      if (invoiceId) query = query.eq('invoice_id', invoiceId);
      if (bool(input, 'only_unbooked', false)) query = query.is('journal_entry_id', null);
      const { data, error } = await query;
      if (error) throw new ActionError(`Creditnota's ophalen mislukt: ${error.message}`);
      const notes = (data ?? []) as Array<Record<string, unknown>>;
      if (notes.length === 0) return { count: 0, credit_notes: [] };

      const invoiceIds = [...new Set(notes.map((n) => String(n.invoice_id)))];
      const { data: invoices } = await orgQuery(ctx, 'invoices', 'id, number, client_id').in('id', invoiceIds);
      const invoiceById = new Map<string, { number: string; client_id: string | null }>(
        ((invoices ?? []) as Array<Record<string, unknown>>).map((i) => [String(i.id), {
          number: String(i.number ?? ''), client_id: i.client_id ? String(i.client_id) : null,
        }]));
      const clientIds = [...new Set([...invoiceById.values()].map((i) => i.client_id).filter((c): c is string => Boolean(c)))];
      const nameById = new Map<string, string>();
      if (clientIds.length > 0) {
        const { data: clients } = await orgQuery(ctx, 'clients', 'id, name').in('id', clientIds);
        for (const c of ((clients ?? []) as Array<Record<string, unknown>>)) nameById.set(String(c.id), String(c.name ?? ''));
      }
      return {
        count: notes.length,
        credit_notes: notes.map((n) => {
          const invoice = invoiceById.get(String(n.invoice_id));
          return {
            ...n,
            invoice_number: invoice?.number ?? null,
            client_name: invoice?.client_id ? nameById.get(invoice.client_id) ?? null : null,
          };
        }),
      };
    },
  },

  // ── Grootboek ────────────────────────────────────────────────────────────
  {
    id: 'invoice.post_to_ledger',
    label: 'Verkoopfactuur naar het grootboek boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt de omzet en de af te dragen btw van één verkoopfactuur in het grootboek (debiteuren 1300 tegen omzet en 1510). Normaal gebeurt dat automatisch bij het versturen; deze handeling is het vangnet voor facturen waar dat niet lukte — in het overzicht staan die met het label "niet geboekt". ' +
      'Kan zodra de factuur uitgegeven is (verzonden, te laat, betaald) en nog geen journaalpost heeft. Een concept-, geannuleerde of ongeldig gemaakte factuur boek je niet.',
    keywords: ['grootboek', 'boeken', 'journaalpost', 'omzet', 'btw', 'niet geboekt', 'boekhouding', 'debiteuren'],
    input: { invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' } },
    required: ['invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const invoice = await row<{ number: string; status: string; client_id: string | null; date: string | null; lines: unknown; total_amount: number | null; journal_entry_id: string | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, date, lines, total_amount, journal_entry_id', 'Factuur');
      if (invoice.journal_entry_id) throw new ActionError(`Factuur ${invoice.number} staat al in het grootboek.`);
      if (['draft', 'cancelled', 'void'].includes(invoice.status)) {
        throw new ActionError(`Factuur ${invoice.number} staat op "${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}" en hoort niet in het grootboek.`);
      }
      return {
        title: `Factuur ${invoice.number} naar het grootboek boeken`,
        sub: joinShort([await clientNameOf(ctx, invoice.client_id), euro(docTotalEur(invoice)), dateShort(invoice.date)]),
        kind: 'money',
        warning: 'Een journaalpost is definitief. Daarna zijn de regels, de datum, het nummer en de klant van deze factuur onveranderbaar, is de factuur niet meer te verwijderen, en corrigeer je alleen nog met een creditnota.',
        payload: { invoice_id: invoiceId, number: invoice.number },
      };
    },
  },

  {
    id: 'invoice.post_all_unbooked',
    label: 'Alle ongeboekte verkoopfacturen in één keer boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt in één keer ALLE uitgegeven verkoopfacturen die nog geen journaalpost hebben (status verzonden, geaccepteerd, te laat of betaald). Dat is de knop "Boek nu alsnog": het vangnet als het automatisch boeken bij het versturen eerder is misgegaan. ' +
      'Wil je er maar één, gebruik dan `invoice.post_to_ledger`. Kijk vooraf met `list_invoices` wat er openstaat.',
    keywords: ['grootboek', 'alles boeken', 'bulk', 'niet geboekt', 'boek nu alsnog', 'vangnet', 'journaalposten'],
    input: {},
    async plan(ctx) {
      const { data, error } = await orgQuery(ctx, 'invoices', 'id, number, status, lines, total_amount, date')
        .is('journal_entry_id', null).in('status', BOOKABLE_STATUS).order('date', { ascending: true }).limit(500);
      if (error) throw new ActionError(`Ongeboekte facturen ophalen mislukt: ${error.message}`);
      const invoices = (data ?? []) as Array<Record<string, unknown>>;
      if (invoices.length === 0) throw new ActionError('Er staan geen uitgegeven facturen open die nog geboekt moeten worden.');
      const sum = invoices.reduce((acc, i) => acc + docTotalEur(i), 0);
      return {
        title: `${invoices.length} nog niet geboekte verkoopfactu${invoices.length === 1 ? 'ur' : 'ren'} naar het grootboek boeken`,
        sub: joinShort([euro(sum), ...invoices.slice(0, 4).map((i) => String(i.number)), invoices.length > 4 ? `en ${invoices.length - 4} meer` : null]),
        kind: 'money',
        warning: `Elk van deze ${invoices.length} facturen krijgt een eigen journaalpost. Dat is definitief: de facturen zijn daarna onveranderbaar en corrigeren kan alleen nog met een creditnota.`,
        payload: { count: invoices.length, numbers: invoices.map((i) => String(i.number)) },
      };
    },
  },

  {
    id: 'credit_note.post_to_ledger',
    label: 'Creditnota naar het grootboek boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt een uitgegeven creditnota in het grootboek: de omzet en de af te dragen btw worden teruggenomen en de vordering op de klant wordt verlaagd. ' +
      'Kan alleen als de creditnota status "issued" heeft en de bijbehorende FACTUUR al geboekt is — zonder die oorspronkelijke debitering zou de debiteurenstand negatief worden. Boek in dat geval eerst de factuur met `invoice.post_to_ledger`. Zoek de creditnota met `credit_note.list`.',
    keywords: ['creditnota', 'grootboek', 'boeken', 'journaalpost', 'terugnemen', 'omzetcorrectie', 'btw terug'],
    input: { credit_note_id: { type: 'string', description: 'Id van de creditnota (exact, uit credit_note.list).' } },
    required: ['credit_note_id'],
    async plan(ctx, input) {
      const creditNoteId = id(input, 'credit_note_id');
      const creditNote = await row<{ number: string; invoice_id: string; total_amount: number; status: string; date: string | null; journal_entry_id: string | null }>(
        ctx, 'credit_notes', creditNoteId, 'number, invoice_id, total_amount, status, date, journal_entry_id', 'Creditnota');
      if (creditNote.journal_entry_id) throw new ActionError(`Creditnota ${creditNote.number} staat al in het grootboek.`);
      if (creditNote.status !== 'issued') throw new ActionError(`Alleen een uitgegeven creditnota kan worden geboekt; ${creditNote.number} staat op "${creditNote.status}".`);
      const invoice = await row<{ number: string; client_id: string | null; journal_entry_id: string | null }>(
        ctx, 'invoices', creditNote.invoice_id, 'number, client_id, journal_entry_id', 'Factuur');
      if (!invoice.journal_entry_id) {
        throw new ActionError(`Factuur ${invoice.number} staat nog niet in het grootboek. Boek eerst de factuur (invoice.post_to_ledger) en daarna de creditnota.`);
      }
      return {
        title: `Creditnota ${creditNote.number} naar het grootboek boeken`,
        sub: joinShort([await clientNameOf(ctx, invoice.client_id), euro(toNumber(creditNote.total_amount)), `correctie op factuur ${invoice.number}`]),
        kind: 'money',
        warning: 'Een journaalpost is definitief: omzet en btw worden teruggenomen en de vordering op de klant verlaagd. Terugdraaien kan alleen met een tegenboeking.',
        payload: { credit_note_id: creditNoteId, number: creditNote.number, invoice_number: invoice.number },
      };
    },
  },

  {
    id: 'invoice.reconcile_bank_transaction',
    label: 'Banktransactie afletteren tegen een verkoopfactuur',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Koppelt een BINNENGEKOMEN banktransactie aan een verkoopfactuur en registreert daarmee de betaling: er komt een journaalpost (bank tegen debiteuren) en de factuur gaat op betaald. ' +
      'De factuur moet al in het grootboek staan (`invoice.post_to_ledger`), anders zou de debiteurenstand negatief worden — de database weigert dat ook. Zoek de transactie met `list_bank_transactions` en de factuur met `list_invoices`; let op dat het bedrag klopt.',
    keywords: ['afletteren', 'bank', 'banktransactie', 'betaling', 'matchen', 'koppelen', 'bijschrijving', 'reconciliatie', 'betaald'],
    input: {
      transaction_id: { type: 'string', description: 'Id van de banktransactie (exact, uit list_bank_transactions).' },
      invoice_id: { type: 'string', description: 'Id van de verkoopfactuur (exact, uit list_invoices).' },
    },
    required: ['transaction_id', 'invoice_id'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const invoiceId = id(input, 'invoice_id');
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, description, status', 'Banktransactie');
      if (!['unmatched', 'suggested'].includes(txn.status)) {
        throw new ActionError(`Deze banktransactie staat op "${txn.status}" en is niet meer af te letteren.`);
      }
      if (Number(txn.amount_cents) <= 0) {
        throw new ActionError('Alleen een binnengekomen bedrag kun je tegen een verkoopfactuur afletteren; dit is een afschrijving.');
      }
      const invoice = await row<{ number: string; status: string; client_id: string | null; lines: unknown; total_amount: number | null; journal_entry_id: string | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, lines, total_amount, journal_entry_id', 'Factuur');
      if (!invoice.journal_entry_id) {
        throw new ActionError(`Factuur ${invoice.number} staat nog niet in het grootboek; boek hem eerst met invoice.post_to_ledger.`);
      }
      if (['cancelled', 'void'].includes(invoice.status)) {
        throw new ActionError(`Factuur ${invoice.number} staat op "${INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}" en is niet af te letteren.`);
      }
      const invoiceCents = Math.round(docTotalEur(invoice) * 100);
      const diff = Number(txn.amount_cents) - invoiceCents;
      return {
        title: `Bankbedrag ${euroCents(txn.amount_cents)} afletteren tegen factuur ${invoice.number}`,
        sub: joinShort([
          txn.counterparty_name ?? txn.description,
          dateShort(txn.booking_date),
          await clientNameOf(ctx, invoice.client_id),
          diff === 0 ? 'bedrag klopt exact' : `${diff > 0 ? 'te veel' : 'te weinig'}: ${euroCents(Math.abs(diff))}`,
        ]),
        kind: 'money',
        warning: 'Afletteren maakt een journaalpost en zet de factuur op betaald. Terugdraaien kan alleen met een tegenboeking op de Bankpagina.',
        payload: { transaction_id: transactionId, invoice_id: invoiceId, number: invoice.number, amount_cents: Number(txn.amount_cents) },
      };
    },
  },

  // ── Historie lezen ───────────────────────────────────────────────────────
  {
    id: 'quote.history',
    label: 'Offertehistorie lezen (versies, mailstatus, workflow)',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de volledige geschiedenis van één offerte: de vastgelegde versiesnapshots (met bedrag en reden), de verzendhistorie via Resend (naar wie, bezorgd, geopend, geklikt, mislukt) en alle workflow-events — indienen, intern goedkeuren of afwijzen met notitie, versturen, en de beslissing van de klant. ' +
      'Gebruik dit om te zien of een offerte al gezien is voordat je nabelt, of om te vertellen waaróm hij intern is afgewezen. Zoek de offerte met `list_quotes`.',
    keywords: ['offerte', 'historie', 'geschiedenis', 'versies', 'tijdlijn', 'geopend', 'mailstatus', 'workflow', 'afgewezen', 'nabellen'],
    input: { quote_id: { type: 'string', description: 'Id van de offerte (exact, uit list_quotes).' } },
    required: ['quote_id'],
    async read(ctx, input) {
      const quoteId = id(input, 'quote_id');
      const quote = await row<{
        number: string; status: string; internal_approval_status: string; internal_rejection_note: string | null;
        client_id: string | null; project_id: string | null; date: string | null; valid_until: string | null;
        lines: unknown; total_amount: number | null; sent_at: string | null; accepted_at: string | null;
        client_decision_at: string | null; client_decision_by_name: string | null; client_decision_note: string | null;
      }>(ctx, 'quotes', quoteId,
        'number, status, internal_approval_status, internal_rejection_note, client_id, project_id, date, valid_until, ' +
        'lines, total_amount, sent_at, accepted_at, client_decision_at, client_decision_by_name, client_decision_note', 'Offerte');

      const [versions, events, deliveries] = await Promise.all([
        orgQuery(ctx, 'quote_versions', 'id, version_number, snapshot_reason, status_at_snapshot, internal_approval_status_at_snapshot, subtotal_amount, vat_amount, total_amount, created_at')
          .eq('quote_id', quoteId).order('version_number', { ascending: false }).limit(50),
        orgQuery(ctx, 'quote_approval_events', 'id, event_type, title, description, created_at')
          .eq('quote_id', quoteId).order('created_at', { ascending: false }).limit(100),
        orgQuery(ctx, 'quote_email_deliveries', 'id, recipient_email, recipient_name, subject, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at, failed_at, error_message, created_at')
          .eq('quote_id', quoteId).order('created_at', { ascending: false }).limit(50),
      ]);
      if (versions.error) throw new ActionError(`Offerteversies ophalen mislukt: ${versions.error.message}`);
      if (events.error) throw new ActionError(`Offerte-events ophalen mislukt: ${events.error.message}`);
      if (deliveries.error) throw new ActionError(`Verzendhistorie ophalen mislukt: ${deliveries.error.message}`);

      return {
        quote: {
          id: quoteId, number: quote.number, status: quote.status,
          status_label: QUOTE_STATUS_LABELS[quote.status] ?? quote.status,
          internal_approval_status: quote.internal_approval_status,
          internal_rejection_note: quote.internal_rejection_note,
          client_id: quote.client_id, client_name: await clientNameOf(ctx, quote.client_id),
          project_id: quote.project_id, date: quote.date, valid_until: quote.valid_until,
          total_eur: docTotalEur(quote), sent_at: quote.sent_at, accepted_at: quote.accepted_at,
          client_decision_at: quote.client_decision_at,
          client_decision_by_name: quote.client_decision_by_name,
          client_decision_note: quote.client_decision_note,
        },
        versions: versions.data ?? [],
        events: events.data ?? [],
        email_deliveries: deliveries.data ?? [],
      };
    },
  },

  {
    id: 'invoice.history',
    label: 'Factuurhistorie lezen (verzending, betalingen, terugbetalingen)',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de volledige geschiedenis van één factuur: verzendpogingen via Resend (inclusief de herinneringen, met niveau), de betaalrecords van Mollie, de terugbetalingen, de creditnota\'s, eventuele chargebacks, de PDF-versiesnapshots en de audit-tijdlijn. Ook of hij in het grootboek staat en of de herinneringen op pauze staan. ' +
      'Gebruik dit om te zien of een klant de factuur wel geopend heeft, wat er al geïncasseerd is, of waarom een verzending misging. Zoek de factuur met `list_invoices`.',
    keywords: ['factuur', 'historie', 'geschiedenis', 'verzendhistorie', 'betalingen', 'terugbetalingen', 'chargeback', 'versies', 'geopend', 'mislukt', 'tijdlijn'],
    input: {
      invoice_id: { type: 'string', description: 'Id van de factuur (exact, uit list_invoices).' },
    },
    required: ['invoice_id'],
    async read(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const invoice = await row<{
        number: string; status: string; client_id: string | null; project_id: string | null; quote_id: string | null;
        date: string | null; due_date: string | null; lines: unknown; total_amount: number | null;
        sent_at: string | null; paid_at: string | null; reminder_level: number | null; last_reminder_at: string | null;
        reminders_paused: boolean | null; refunded_amount: number | null; charged_back_amount: number | null;
        journal_entry_id: string | null;
      }>(ctx, 'invoices', invoiceId,
        'number, status, client_id, project_id, quote_id, date, due_date, lines, total_amount, sent_at, paid_at, ' +
        'reminder_level, last_reminder_at, reminders_paused, refunded_amount, charged_back_amount, journal_entry_id', 'Factuur');

      const [deliveries, payments, refunds, creditNotes, chargebacks, versions, events, dunning] = await Promise.all([
        orgQuery(ctx, 'invoice_email_deliveries', 'id, delivery_kind, reminder_level, recipient_email, subject, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at, failed_at, error_message, created_at')
          .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(50),
        orgQuery(ctx, 'invoice_payment_records', 'id, provider, status, amount_cents, amount_refunded_cents, currency, paid_at, checkout_expires_at, created_at')
          .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(50),
        orgQuery(ctx, 'invoice_refunds', 'id, kind, provider, status, amount_cents, reason, credit_note_id, refunded_at, failed_at, error_message, created_at')
          .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(50),
        orgQuery(ctx, 'credit_notes', 'id, number, date, reason, total_amount, status, journal_entry_id, created_at')
          .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(50),
        orgQuery(ctx, 'invoice_chargebacks', 'id, provider, status, amount_cents, reason, charged_back_at, reversed_at')
          .eq('invoice_id', invoiceId).order('charged_back_at', { ascending: false }).limit(25),
        orgQuery(ctx, 'invoice_versions', 'id, version_number, snapshot_reason, status_at_snapshot, subtotal_amount, vat_amount, total_amount, created_at')
          .eq('invoice_id', invoiceId).order('version_number', { ascending: false }).limit(50),
        orgQuery(ctx, 'invoice_workflow_events', 'id, event_type, title, description, created_at')
          .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(100),
        orgQuery(ctx, 'invoice_dunning_notices', 'id, status, client_kind, principal_cents, interest_cents, collection_costs_cents, collection_costs_vat_cents, total_claim_cents, deadline_date, proposed_at, sent_at')
          .eq('invoice_id', invoiceId).maybeSingle(),
      ]);
      if (deliveries.error) throw new ActionError(`Verzendhistorie ophalen mislukt: ${deliveries.error.message}`);
      if (payments.error) throw new ActionError(`Betalingen ophalen mislukt: ${payments.error.message}`);
      if (refunds.error) throw new ActionError(`Terugbetalingen ophalen mislukt: ${refunds.error.message}`);
      if (versions.error) throw new ActionError(`Factuurversies ophalen mislukt: ${versions.error.message}`);
      if (events.error) throw new ActionError(`Factuur-events ophalen mislukt: ${events.error.message}`);

      return {
        invoice: {
          id: invoiceId, number: invoice.number, status: invoice.status,
          status_label: INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status,
          client_id: invoice.client_id, client_name: await clientNameOf(ctx, invoice.client_id),
          project_id: invoice.project_id, quote_id: invoice.quote_id,
          date: invoice.date, due_date: invoice.due_date, total_eur: docTotalEur(invoice),
          sent_at: invoice.sent_at, paid_at: invoice.paid_at,
          reminder_level: invoice.reminder_level ?? 0, last_reminder_at: invoice.last_reminder_at,
          reminders_paused: Boolean(invoice.reminders_paused),
          refunded_amount_eur: toNumber(invoice.refunded_amount),
          charged_back_amount_eur: toNumber(invoice.charged_back_amount),
          in_ledger: Boolean(invoice.journal_entry_id),
        },
        email_deliveries: deliveries.data ?? [],
        payments: payments.data ?? [],
        refunds: refunds.data ?? [],
        credit_notes: creditNotes.data ?? [],
        chargebacks: chargebacks.data ?? [],
        versions: versions.data ?? [],
        events: events.data ?? [],
        dunning_notice: dunning.data ?? null,
      };
    },
  },

  // ── Instellingen die de klantpost bepalen ────────────────────────────────
  {
    id: 'finance.reminder_settings',
    label: 'Instellingen voor herinneringen en aanmaningen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de instellingen van de herinneringstrap en de debiteurenautomaat: staan de automatische herinneringen aan, na hoeveel dagen na de vervaldatum niveau 1, 2 en 3 gaan, of er een betaallink meegaat, of er automatisch aanmaningsvoorstellen worden gemaakt, na hoeveel dagen, en of er btw over de incassokosten gaat. ' +
      'Lees dit voordat je iets aanpast met `finance.set_reminder_settings` of `finance.set_dunning_settings` — die vervangen alle genoemde waarden.',
    keywords: ['instellingen', 'herinneringen', 'automatisch', 'termijnen', 'dagen', 'debiteurenautomaat', 'aanmaning', 'betaallink'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'invoice_reminder_settings',
        'auto_reminders_enabled, level1_offset_days, level2_offset_days, level3_offset_days, include_payment_link, ' +
        'dunning_enabled, dunning_offset_days, dunning_collection_costs_vat, updated_at').maybeSingle();
      if (error) throw new ActionError(`Herinneringsinstellingen ophalen mislukt: ${error.message}`);
      // Geen rij = nog nooit ingesteld. Dezelfde standaardwaarden als het scherm toont.
      return {
        settings: data ?? {
          auto_reminders_enabled: false, level1_offset_days: 3, level2_offset_days: 10, level3_offset_days: 17,
          include_payment_link: true, dunning_enabled: false, dunning_offset_days: 30, dunning_collection_costs_vat: false,
        },
        configured: Boolean(data),
      };
    },
  },

  {
    id: 'finance.set_reminder_settings',
    label: 'Automatische betalingsherinneringen instellen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Stelt de automatische herinneringstrap in: aan of uit, na hoeveel dagen na de vervaldatum niveau 1, 2 en 3 vertrekken, en of er een Mollie-betaallink meegaat. Een dagelijkse cron stuurt daarna ZELF mail naar klanten met te late facturen — zonder dat er nog iemand op een knop drukt. ' +
      'De niveaus moeten oplopen (1 < 2 < 3). Alle vier de waarden worden vervangen; lees ze eerst met `finance.reminder_settings`. Eén factuur uitzonderen doe je met `invoice.set_reminders_paused`.',
    keywords: ['herinneringen', 'automatisch', 'instellen', 'termijnen', 'dagen na vervaldatum', 'betaallink', 'cron', 'aanzetten'],
    input: {
      auto_reminders_enabled: { type: 'boolean', description: 'De hele automaat aan of uit.' },
      level1_offset_days: { type: 'integer', description: 'Dagen na de vervaldatum voor herinnering 1.' },
      level2_offset_days: { type: 'integer', description: 'Dagen na de vervaldatum voor herinnering 2.' },
      level3_offset_days: { type: 'integer', description: 'Dagen na de vervaldatum voor herinnering 3.' },
      include_payment_link: { type: 'boolean', description: 'Een Mollie-betaallink meesturen (alleen als Mollie gekoppeld is).' },
    },
    required: ['auto_reminders_enabled', 'level1_offset_days', 'level2_offset_days', 'level3_offset_days', 'include_payment_link'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'de herinneringsinstellingen aanpassen');
      const enabled = bool(input, 'auto_reminders_enabled', false);
      const level1 = Math.round(num(input, 'level1_offset_days'));
      const level2 = Math.round(num(input, 'level2_offset_days'));
      const level3 = Math.round(num(input, 'level3_offset_days'));
      const link = bool(input, 'include_payment_link', true);
      for (const [label, value] of [['1', level1], ['2', level2], ['3', level3]] as const) {
        if (value < 0 || value > 365) throw new ActionError(`Het aantal dagen voor niveau ${label} moet tussen 0 en 365 liggen.`);
      }
      if (!(level1 < level2 && level2 < level3)) {
        throw new ActionError(`De niveaus moeten oplopen: nu ${level1}, ${level2} en ${level3} dagen.`);
      }
      return {
        title: enabled
          ? `Automatische betalingsherinneringen aanzetten (${level1}/${level2}/${level3} dagen)`
          : 'Automatische betalingsherinneringen uitzetten',
        sub: joinShort([
          enabled ? `niveau 1 na ${level1} dagen, 2 na ${level2}, 3 na ${level3}` : 'de cron stuurt niets meer uit zichzelf',
          enabled ? (link ? 'met betaallink' : 'zonder betaallink') : null,
        ]),
        kind: 'money',
        warning: enabled
          ? 'Vanaf nu stuurt de app zelf herinneringsmail naar klanten met te late facturen, zonder dat iemand er nog naar kijkt.'
          : undefined,
        payload: {
          auto_reminders_enabled: enabled, level1_offset_days: level1, level2_offset_days: level2,
          level3_offset_days: level3, include_payment_link: link,
        },
      };
    },
  },

  {
    id: 'finance.set_dunning_settings',
    label: 'Debiteurenautomaat (aanmaningen) instellen',
    module: 'finance',
    kind: 'write',
    description:
      'Stelt de debiteurenautomaat in: of er automatisch een AANMANINGSVOORSTEL wordt gemaakt voor facturen die te lang openstaan, na hoeveel dagen na de vervaldatum, en of er btw over de incassokosten gaat (dat mag alleen als je de btw niet kunt verrekenen). ' +
      'Let op: de automaat maakt alleen een VOORSTEL. Er gaat pas post naar de klant als iemand het bevestigt met `dunning.send`. Alle drie de waarden worden vervangen; lees ze eerst met `finance.reminder_settings`.',
    keywords: ['debiteurenautomaat', 'aanmaning', 'automatisch', 'instellen', 'wik', 'incassokosten', 'btw', 'dagen'],
    input: {
      dunning_enabled: { type: 'boolean', description: 'Automatisch aanmaningsvoorstellen maken.' },
      dunning_offset_days: { type: 'integer', description: 'Dagen na de vervaldatum voordat er een voorstel komt.' },
      dunning_collection_costs_vat: { type: 'boolean', description: 'Btw over de incassokosten rekenen.' },
    },
    required: ['dunning_enabled', 'dunning_offset_days', 'dunning_collection_costs_vat'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'de debiteurenautomaat instellen');
      const enabled = bool(input, 'dunning_enabled', false);
      const offset = Math.round(num(input, 'dunning_offset_days'));
      const vat = bool(input, 'dunning_collection_costs_vat', false);
      if (offset < 0 || offset > 365) throw new ActionError('Het aantal dagen moet tussen 0 en 365 liggen.');
      return {
        title: enabled
          ? `Debiteurenautomaat aanzetten: voorstel na ${offset} dagen te laat`
          : 'Debiteurenautomaat uitzetten',
        sub: joinShort([
          enabled ? 'voorstellen komen in de wachtrij; er gaat niets uit zonder bevestiging' : 'er worden geen voorstellen meer gemaakt',
          enabled ? (vat ? 'met btw over de incassokosten' : 'zonder btw over de incassokosten') : null,
        ]),
        kind: 'money',
        payload: { dunning_enabled: enabled, dunning_offset_days: offset, dunning_collection_costs_vat: vat },
      };
    },
  },

  {
    id: 'finance.list_email_templates',
    label: 'E-mailteksten van offertes en facturen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft per sjabloon (offerte verstuurd, factuur verstuurd, herinnering 1/2/3, creditnota verstuurd) de eigen tekst die deze organisatie heeft ingesteld: onderwerp, aanhef, afsluiting en knoptekst. Een sjabloon dat hier ontbreekt gebruikt de standaardtekst van de app. ' +
      'Lees dit voordat je iets herschrijft met `finance.set_email_template`.',
    keywords: ['e-mailtekst', 'sjabloon', 'template', 'onderwerp', 'aanhef', 'afsluiting', 'knoptekst', 'mailteksten'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'email_templates', 'template_key, enabled, subject, intro, closing, cta_label, updated_at')
        .in('template_key', [...SALES_TEMPLATE_KEYS]);
      if (error) throw new ActionError(`E-mailteksten ophalen mislukt: ${error.message}`);
      const byKey = new Map<string, Record<string, unknown>>(
        ((data ?? []) as Array<Record<string, unknown>>).map((t) => [String(t.template_key), t]));
      return {
        templates: SALES_TEMPLATE_KEYS.map((key) => ({
          template_key: key,
          label: TEMPLATE_LABELS[key],
          customized: byKey.has(key),
          ...(byKey.get(key) ?? { enabled: true, subject: null, intro: null, closing: null, cta_label: null }),
        })),
      };
    },
  },

  {
    id: 'finance.set_email_template',
    label: 'E-mailtekst van een offerte-, factuur- of herinneringsmail aanpassen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Herschrijft het onderwerp, de aanhef, de afsluiting en de knoptekst van één verkoopmail. Dit bepaalt de tekst van ÁLLE toekomstige mail van dat soort — ook de mail die de automatische herinneringstrap zelf verstuurt. ' +
      'Sleutels: quote.sent, invoice.sent, invoice.reminder.1/2/3, creditNote.sent. Een veld dat je leeg laat valt terug op de standaardtekst. Lees eerst `finance.list_email_templates` en houd de toon van niveau 1 vriendelijker dan die van niveau 3.',
    keywords: ['e-mailtekst', 'sjabloon', 'template', 'onderwerp', 'aanhef', 'afsluiting', 'knoptekst', 'herschrijven', 'toon'],
    input: {
      template_key: { type: 'string', enum: [...SALES_TEMPLATE_KEYS], description: 'Welke mail je herschrijft.' },
      subject: { type: 'string', description: 'Onderwerpregel. Leeg = standaardtekst.' },
      intro: { type: 'string', description: 'Aanhef/openingsalinea. Leeg = standaardtekst.' },
      closing: { type: 'string', description: 'Afsluiting. Leeg = standaardtekst.' },
      cta_label: { type: 'string', description: 'Tekst op de knop. Leeg = standaardtekst.' },
      enabled: { type: 'boolean', description: 'De eigen tekst gebruiken. Standaard true.' },
    },
    required: ['template_key'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'de e-mailteksten aanpassen');
      const key = choice(input, 'template_key', SALES_TEMPLATE_KEYS);
      const subject = optStr(input, 'subject', 200);
      const intro = optStr(input, 'intro', 2000);
      const closing = optStr(input, 'closing', 2000);
      const cta = optStr(input, 'cta_label', 60);
      const enabled = bool(input, 'enabled', true);
      if (!subject && !intro && !closing && !cta) {
        throw new ActionError('Geef minstens één tekst: onderwerp, aanhef, afsluiting of knoptekst. Terug naar de standaardtekst doe je met finance.reset_email_template.');
      }
      const changed = [subject ? 'onderwerp' : null, intro ? 'aanhef' : null, closing ? 'afsluiting' : null, cta ? 'knoptekst' : null];
      return {
        title: `E-mailtekst aanpassen: ${TEMPLATE_LABELS[key]}`,
        sub: joinShort([...changed, enabled ? null : 'eigen tekst staat uit', subject ?? intro]),
        kind: 'mail',
        warning: 'Dit bepaalt de tekst van alle toekomstige mail van dit soort naar je klanten, ook de mail die de automatische herinneringstrap zelf verstuurt.',
        payload: { template_key: key, subject, intro, closing, cta_label: cta, enabled, label: TEMPLATE_LABELS[key] },
      };
    },
  },

  {
    id: 'finance.reset_email_template',
    label: 'E-mailtekst terugzetten naar de standaardtekst',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Gooit de zelfgeschreven tekst van één verkoopmail weg, zodat die mail weer de standaardtekst van de app gebruikt. Gebruik dit als de eigen tekst niet meer klopt en je liever bij nul begint. ' +
      'Doe dit alleen als de gebruiker er expliciet om vraagt — de geschreven tekst is nergens anders bewaard.',
    keywords: ['e-mailtekst', 'sjabloon', 'template', 'standaard', 'terugzetten', 'resetten', 'eigen tekst weg'],
    input: { template_key: { type: 'string', enum: [...SALES_TEMPLATE_KEYS], description: 'Welke mail je terugzet.' } },
    required: ['template_key'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'de e-mailteksten terugzetten');
      const key = choice(input, 'template_key', SALES_TEMPLATE_KEYS);
      const { data } = await orgQuery(ctx, 'email_templates', 'subject, intro').eq('template_key', key).maybeSingle();
      if (!data) throw new ActionError(`Voor "${TEMPLATE_LABELS[key]}" is geen eigen tekst ingesteld; die mail gebruikt de standaardtekst al.`);
      const current = data as { subject: string | null; intro: string | null };
      return {
        title: `E-mailtekst terugzetten naar standaard: ${TEMPLATE_LABELS[key]}`,
        sub: joinShort(['de eigen tekst wordt verwijderd', current.subject ?? current.intro]),
        kind: 'mail',
        warning: 'Je eigen onderwerp, aanhef, afsluiting en knoptekst voor deze mail worden verwijderd. Dat kun je niet ongedaan maken; je zou ze opnieuw moeten schrijven.',
        payload: { template_key: key, label: TEMPLATE_LABELS[key] },
      };
    },
  },

  {
    id: 'finance.set_invoice_company_details',
    label: 'Bedrijfsgegevens op de factuur bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Werkt de bedrijfsgegevens bij die op elke nieuwe factuur- en offerte-PDF staan én in de UBL/Peppol-e-factuur worden meegestuurd: naam, handelsnaam, adres, postcode, plaats, land, e-mail, telefoon, website, KVK-nummer, btw-nummer, IBAN, de betaalvoorwaarden en de factuurfooter. ' +
      'Zonder KVK-nummer, btw-nummer en volledig adres weigert de e-factuur mee te gaan bij het versturen. Geef alleen de velden die veranderen — de rest blijft staan. Al bestaande, verstuurde PDF-snapshots veranderen hier niet van.',
    keywords: ['bedrijfsgegevens', 'factuurgegevens', 'kvk', 'btw-nummer', 'iban', 'adres', 'betaalvoorwaarden', 'factuurfooter', 'ubl', 'peppol', 'briefhoofd'],
    input: {
      company_name: { type: 'string', description: 'Statutaire bedrijfsnaam.' },
      trade_name: { type: 'string', description: 'Handelsnaam, als die afwijkt.' },
      address_line1: { type: 'string', description: 'Straat en huisnummer.' },
      address_line2: { type: 'string' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string', description: 'Land voluit, bijvoorbeeld "Nederland".' },
      email: { type: 'string' },
      phone: { type: 'string' },
      website: { type: 'string' },
      kvk_number: { type: 'string' },
      vat_number: { type: 'string', description: 'Btw-identificatienummer, bv. NL001234567B01.' },
      iban: { type: 'string' },
      invoice_payment_terms: { type: 'string', description: 'Betaalvoorwaarden onder aan de factuur.' },
      invoice_footer: { type: 'string', description: 'Afsluitende regel onder aan de factuur.' },
    },
    async plan(ctx, input) {
      requireAdmin(ctx, 'de bedrijfsgegevens aanpassen');
      const fields: Array<[string, string, number]> = [
        ['company_name', 'bedrijfsnaam', 200], ['trade_name', 'handelsnaam', 200],
        ['address_line1', 'adres', 200], ['address_line2', 'adresregel 2', 200],
        ['postal_code', 'postcode', 20], ['city', 'plaats', 120], ['country', 'land', 120],
        ['email', 'e-mailadres', 200], ['phone', 'telefoon', 60], ['website', 'website', 200],
        ['kvk_number', 'KVK-nummer', 40], ['vat_number', 'btw-nummer', 40], ['iban', 'IBAN', 40],
        ['invoice_payment_terms', 'betaalvoorwaarden', 1000], ['invoice_footer', 'factuurfooter', 1000],
      ];
      const patch: Record<string, unknown> = {};
      const changed: string[] = [];
      for (const [key, label, max] of fields) {
        if (input[key] === undefined) continue;
        const value = optStr(input, key, max);
        // Bewust ook een lege waarde doorlaten: "haal mijn website weg" is een
        // geldige wens. Alleen de bedrijfsnaam mag niet leeg — die staat op elke PDF.
        if (key === 'company_name' && !value) throw new ActionError('De bedrijfsnaam kan niet leeg zijn; die staat op elke factuur.');
        patch[key] = value;
        changed.push(label);
      }
      if (changed.length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');
      const { data } = await orgQuery(ctx, 'company_settings', 'company_name').maybeSingle();
      if (!data) {
        throw new ActionError('Er zijn nog geen bedrijfsgegevens vastgelegd. Vul ze eerst één keer in bij Instellingen → Bedrijf; daarna kan dit hier bijgewerkt worden.');
      }
      return {
        title: `Bedrijfsgegevens op de factuur bijwerken: ${(data as { company_name: string }).company_name}`,
        sub: joinShort(changed),
        kind: 'money',
        payload: { patch, changed },
      };
    },
  },
];
