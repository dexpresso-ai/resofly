import {
  ActionError, bool, id, ids, joinShort, optId, optNum, orgQuery, row,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond TICKETS: de meldingen die binnenkomen van de klant of van een
 * collega, en de tijdlijn eronder.
 *
 * Het aanmaken, wijzigen (titel, omschrijving, status, prioriteit) en beantwoorden
 * van een ticket zit al als eersteklas tool in gerrieCore — `propose_ticket`,
 * `propose_edit_ticket`, `propose_ticket_note` en `list_tickets`. Wat hier staat is
 * de rest van wat het ticketscherm kan en die tools níét: de klantkoppeling, de
 * omzetting naar een project, het omzetten van een notitie tussen intern en
 * zichtbaar-voor-de-klant, en de ongelezen-lijst die de badge voedt.
 *
 * Wat bewust ONTBREEKT: een ticket, een notitie of een bijlage weggooien. Dat is
 * definitief (het ticket sleept in de app zijn R2-bijlagen mee) en hoort niet bij
 * wat een agent mag. Een ticket dat niet doorgaat zet je op "geweigerd".
 */

/** De statussen waaruit `convert_ticket_to_project` een project maakt; de rest weigert de database. */
const CONVERTIBLE_STATUSES = ['new', 'review', 'approved'];

const STATUS_LABELS: Record<string, string> = {
  new: 'Nieuw', review: 'Review', approved: 'Goedgekeurd', rejected: 'Geweigerd', converted: 'Omgezet',
};
const PRIORITY_LABELS: Record<string, string> = { low: 'laag', med: 'normaal', high: 'hoog' };

/** Naam van een klant, of null als er geen (meer) is — bewust zacht, dit is versiering. */
async function clientNameOf(ctx: ActionCtx, clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const { data } = await orgQuery(ctx, 'clients', 'name').eq('id', clientId).maybeSingle();
  return data ? String((data as { name: string }).name) : null;
}

/** Knipt een notitie af tot iets wat op een goedkeurkaart past. */
function excerptOf(body: string, max = 160): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Tijdstempel als getal; leeg of onleesbaar telt als "lang geleden". Bewust niet op
 *  de tekst vergelijken: dat gaat mis zodra een tijdzone-offset ooit anders terugkomt. */
function ms(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const TICKETS_ACTIONS: ActionDef[] = [
  {
    id: 'ticket.set_client',
    label: 'Ticket aan een klant koppelen of losmaken',
    module: 'tickets',
    kind: 'write',
    description:
      'Hangt een ticket aan een klant, of maakt het juist los ("Geen klant"). `propose_edit_ticket` kan titel, omschrijving, status, prioriteit en de interne memo wijzigen maar NIET de klant — daarvoor is deze handeling. ' +
      'De koppeling bepaalt of de klant het ticket in zijn portaal terugziet, welke naam er in het overzicht staat, en welke klant het project krijgt als je het ticket later omzet. ' +
      'Laat `client_id` weg om het ticket los te maken. Zoek het ticket met `list_tickets` en de klant met `search_clients`.',
    keywords: ['klant', 'koppelen', 'ontkoppelen', 'losmaken', 'geen klant', 'toewijzen', 'ticket', 'melding', 'verhangen'],
    input: {
      ticket_id: { type: 'string', description: 'Id van het ticket (exact, uit list_tickets).' },
      client_id: { type: 'string', description: 'Id van de klant (exact, uit search_clients). Weglaten of leeg = het ticket losmaken van de klant.' },
    },
    required: ['ticket_id'],
    async plan(ctx, input) {
      const ticketId = id(input, 'ticket_id');
      const ticket = await row<{ title: string; client_id: string | null; status: string }>(
        ctx, 'tickets', ticketId, 'title, client_id, status', 'Ticket');
      const clientId = optId(input, 'client_id');
      if ((ticket.client_id ?? null) === clientId) {
        throw new ActionError(clientId
          ? `"${ticket.title}" hangt al aan deze klant.`
          : `"${ticket.title}" hangt al aan geen enkele klant.`);
      }

      // De nieuwe klant hard controleren (fout id = fout voorstel); de oude zacht,
      // want die hoeft alleen het onderschrift leesbaar te maken.
      let newName: string | null = null;
      if (clientId) {
        const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
        newName = client.name;
      }
      const oldName = await clientNameOf(ctx, ticket.client_id);

      return {
        title: clientId ? `Ticket koppelen aan ${newName}: ${ticket.title}` : `Ticket losmaken van de klant: ${ticket.title}`,
        sub: joinShort([
          `nu: ${oldName ?? 'geen klant'}`,
          `wordt: ${newName ?? 'geen klant'}`,
          STATUS_LABELS[ticket.status] ? `status ${STATUS_LABELS[ticket.status]}` : null,
          clientId ? 'de klant ziet dit ticket daarna in zijn portaal' : (oldName ? `${oldName} ziet het ticket daarna niet meer in het portaal` : null),
        ], 160),
        kind: 'work',
        payload: { ticket_id: ticketId, ticket_title: ticket.title, client_id: clientId, client_name: newName },
      };
    },
  },

  {
    id: 'ticket.convert_to_project',
    label: 'Ticket omzetten naar een project',
    module: 'tickets',
    kind: 'write',
    risk: 'high',
    description:
      'Maakt van een ticket een project: de titel, de omschrijving en de klant van het ticket worden het nieuwe project, en het ticket komt op status "omgezet" met een verwijzing naar dat project. Dat gebeurt in één databasetransactie, dus of allebei of geen van beide. ' +
      'Dit is ONOMKEERBAAR: het ticket kan daarna niet meer terug naar nieuw, review of goedgekeurd, en het project blijft bestaan (weggooien kan een agent niet). ' +
      'Kan alleen bij status nieuw, review of goedgekeurd en alleen als het ticket nog niet omgezet is. Zoek het ticket eerst met `list_tickets`.',
    keywords: ['project maken', 'omzetten', 'converteren', 'ticket naar project', 'goedgekeurd', 'opdracht'],
    input: { ticket_id: { type: 'string', description: 'Id van het ticket (exact, uit list_tickets).' } },
    required: ['ticket_id'],
    async plan(ctx, input) {
      const ticketId = id(input, 'ticket_id');
      const ticket = await row<{ title: string; status: string; priority: string; client_id: string | null; converted_to_project_id: string | null }>(
        ctx, 'tickets', ticketId, 'title, status, priority, client_id, converted_to_project_id', 'Ticket');
      if (ticket.converted_to_project_id || ticket.status === 'converted') {
        throw new ActionError(`"${ticket.title}" is al eerder omgezet naar een project.`);
      }
      if (!CONVERTIBLE_STATUSES.includes(ticket.status)) {
        throw new ActionError(`Een ticket met status "${STATUS_LABELS[ticket.status] ?? ticket.status}" kan niet worden omgezet. Alleen nieuw, review en goedgekeurd kunnen dat.`);
      }
      const clientName = await clientNameOf(ctx, ticket.client_id);

      return {
        title: `Project maken van ticket: ${ticket.title}`,
        sub: joinShort([
          clientName ? `voor ${clientName}` : 'zonder klant',
          `prioriteit ${PRIORITY_LABELS[ticket.priority] ?? ticket.priority}`,
        ], 170),
        warning: 'Het ticket komt op "omgezet" en kan daarna niet meer terug naar nieuw of review.',
        kind: 'work',
        payload: {
          ticket_id: ticketId,
          ticket_title: ticket.title,
          client_id: ticket.client_id,
          client_name: clientName,
        },
      };
    },
  },

  {
    id: 'ticket.mark_read',
    label: 'Tickets als gelezen markeren',
    module: 'tickets',
    kind: 'write',
    description:
      'Zet de leesmarkering op een of meer tickets, precies zoals het openen van een ticket in het scherm doet: ze verdwijnen uit de ongelezen-badge en uit het snelfilter "Ongelezen". ' +
      'De markering geldt ALLEEN voor de persoon die dit goedkeurt — je collega\'s houden hun eigen leesstatus — en geldt tot de klant iets nieuws achterlaat; dan duikt het ticket opnieuw op als ongelezen. ' +
      'Zoek de tickets eerst met `ticket.list_unread`. Let op: dit markeert alleen als gelezen, het beantwoordt niets — reageren doe je met `propose_ticket_note`.',
    keywords: ['gelezen', 'ongelezen', 'badge', 'wegwerken', 'leesmarkering', 'gezien', 'opgeruimd'],
    input: {
      ticket_ids: { type: 'array', items: { type: 'string' }, description: 'Id\'s van de tickets (exact, uit ticket.list_unread of list_tickets).' },
    },
    required: ['ticket_ids'],
    async plan(ctx, input) {
      const wanted = ids(input, 'ticket_ids', 100);
      const { data, error } = await orgQuery(ctx, 'tickets', 'id, title').in('id', wanted);
      if (error) throw new ActionError(`Tickets ophalen mislukt: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; title: string }>;
      if (rows.length !== wanted.length) {
        const found = new Set(rows.map((r) => String(r.id)));
        throw new ActionError(`Deze tickets bestaan niet in deze organisatie: ${wanted.filter((x) => !found.has(x)).join(', ')}.`);
      }
      const titles = rows.map((r) => String(r.title));

      return {
        title: rows.length === 1 ? `Ticket als gelezen markeren: ${titles[0]}` : `${rows.length} tickets als gelezen markeren`,
        sub: joinShort([...titles, 'alleen voor jou — je collega\'s houden hun eigen leesstatus'], 170),
        kind: 'work',
        payload: { ticket_ids: rows.map((r) => String(r.id)), titles },
      };
    },
  },

  {
    id: 'ticket_note.set_visibility',
    label: 'Ticketnotitie zichtbaar maken of verbergen voor de klant',
    module: 'tickets',
    kind: 'write',
    description:
      'Zet een bestaande notitie op de tickettijdlijn om van intern naar zichtbaar voor de klant, of andersom. ' +
      'Zichtbaar maken is NAAR BUITEN GERICHT: een tekst die als interne aantekening geschreven is, staat daarna woordelijk in het klantportaal. Lees hem daarom eerst met `ticket.list_notes` en zeg in je antwoord letterlijk wat er naar buiten gaat. Verbergen haalt hem weer uit het portaal. ' +
      'Een notitie die de KLANT zelf plaatste kun je niet verbergen; die blijft voor allebei zichtbaar.',
    keywords: ['notitie', 'intern', 'zichtbaar', 'verbergen', 'portaal', 'tijdlijn', 'reactie', 'klant', 'privé'],
    input: {
      note_id: { type: 'string', description: 'Id van de notitie (uit ticket.list_notes).' },
      is_internal: { type: 'boolean', description: 'true = verbergen voor de klant (intern), false = zichtbaar maken voor de klant.' },
    },
    required: ['note_id', 'is_internal'],
    async plan(ctx, input) {
      const noteId = id(input, 'note_id');
      const note = await row<{ ticket_id: string; body: string; is_internal: boolean; author_type: string; author_name: string | null }>(
        ctx, 'ticket_notes', noteId, 'ticket_id, body, is_internal, author_type, author_name', 'Ticketnotitie');
      if (note.author_type === 'client') {
        throw new ActionError('Dit is een bericht van de klant zelf; dat kun je niet voor hem verbergen.');
      }
      const internal = bool(input, 'is_internal', true);
      if (note.is_internal === internal) {
        throw new ActionError(`Deze notitie staat al ${internal ? 'op intern' : 'zichtbaar voor de klant'}.`);
      }
      const ticket = await row<{ title: string; client_id: string | null }>(ctx, 'tickets', note.ticket_id, 'title, client_id', 'Ticket');
      const clientName = await clientNameOf(ctx, ticket.client_id);
      const excerpt = excerptOf(note.body);

      return {
        title: internal
          ? `Notitie verbergen voor de klant: ${ticket.title}`
          : `Notitie zichtbaar maken voor de klant: ${ticket.title}`,
        sub: joinShort([
          internal
            ? `verdwijnt uit het portaal van ${clientName ?? 'de klant'}`
            : `${clientName ?? 'de klant'} leest deze tekst in het portaal`,
          `"${excerpt}"`,
        ], 220),
        kind: internal ? 'work' : 'mail',
        risk: internal ? 'normal' : 'high',
        warning: internal ? undefined : 'De klant kan deze tekst hierna lezen in het portaal.',
        payload: {
          note_id: noteId,
          ticket_id: note.ticket_id,
          ticket_title: ticket.title,
          is_internal: internal,
          excerpt,
        },
      };
    },
  },

  {
    id: 'ticket.list_notes',
    label: 'Tijdlijn van een ticket lezen',
    module: 'tickets',
    kind: 'read',
    description:
      'Geeft de notities op de tijdlijn van één ticket, oudste eerst: wie hem schreef (team of klant), de tekst, en of hij intern is of zichtbaar voor de klant. Zo lees je het gesprek terug voordat je reageert met `propose_ticket_note`. ' +
      'Hier haal je ook het `note_id` vandaan dat `ticket_note.set_visibility` nodig heeft. Zoek het ticket eerst met `list_tickets`.',
    keywords: ['tijdlijn', 'notities', 'reacties', 'gesprek', 'ticket', 'portaal', 'intern', 'geschiedenis'],
    input: {
      ticket_id: { type: 'string', description: 'Id van het ticket (exact, uit list_tickets).' },
      include_internal: { type: 'boolean', description: 'Ook de interne notities meesturen (standaard true). Op false zie je precies wat de klant in het portaal ziet.' },
    },
    required: ['ticket_id'],
    async read(ctx, input) {
      const ticketId = id(input, 'ticket_id');
      const ticket = await row<{ title: string; status: string; priority: string; client_id: string | null }>(
        ctx, 'tickets', ticketId, 'title, status, priority, client_id', 'Ticket');
      let query = orgQuery(ctx, 'ticket_notes', 'id, author_type, author_name, body, is_internal, created_at')
        .eq('ticket_id', ticketId).order('created_at', { ascending: true }).limit(200);
      if (!bool(input, 'include_internal', true)) query = query.eq('is_internal', false);
      const { data, error } = await query;
      if (error) throw new ActionError(`Tijdlijn ophalen mislukt: ${error.message}`);
      const notes = (data ?? []) as Array<Record<string, unknown>>;

      return {
        ticket: {
          id: ticketId,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          client_id: ticket.client_id,
          client_name: await clientNameOf(ctx, ticket.client_id),
        },
        count: notes.length,
        client_notes: notes.filter((n) => n.author_type === 'client').length,
        notes,
      };
    },
  },

  {
    id: 'ticket.list_unread',
    label: 'Ongelezen tickets met klantactiviteit opvragen',
    module: 'tickets',
    kind: 'read',
    description:
      'Geeft de tickets waar de KLANT iets achterliet: een ticket dat hij zelf via het portaal aanmaakte, of een reactie van hem op de tijdlijn. Dit is dezelfde lijst die de badge in de zijbalk en het snelfilter "Ongelezen" voeden — precies het werk dat nog een antwoord vraagt. ' +
      'Standaard alleen wat de gebruiker zelf nog niet opende (leesmarkering per ticket, per persoon); zet `only_unread` op false om álle tickets met klantactiviteit te zien, ook de al gelezen. ' +
      'Gaat dus NIET over tickets die het team zelf aanmaakte — die haal je met `list_tickets`.',
    keywords: ['ongelezen', 'badge', 'klantreactie', 'nieuw ticket', 'portaal', 'aandacht', 'nog reageren', 'openstaand'],
    input: {
      only_unread: { type: 'boolean', description: 'Standaard true. Op false: alle tickets met klantactiviteit, ook de al gelezen.' },
      limit: { type: 'number', description: 'Hoogste aantal tickets (standaard 50, max 200).' },
    },
    async read(ctx, input) {
      const onlyUnread = bool(input, 'only_unread', true);
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 50), 1), 200);

      /* De view `ticket_unread` draagt de subtiele regel "welk ticket maakte de klant
       * zélf aan" (de aanmaker is geen organisatielid). Die logica hoort daar te blijven,
       * dus die hergebruiken we. Wat de view hier NIET kan leveren is de leesstatus: hij
       * vergelijkt met `auth.uid()`, en dat is leeg zodra je hem met de service-role leest.
       * Gelezen-of-niet bepalen we daarom hier, tegen `ctx.userId` uit de geverifieerde
       * sessie — dezelfde persoon als wiens badge het scherm toont. */
      const { data: candidates, error } = await orgQuery(ctx, 'ticket_unread', 'id, title, client_id');
      if (error) throw new ActionError(`Tickets met klantactiviteit ophalen mislukt: ${error.message}`);
      const candidateRows = (candidates ?? []) as Array<{ id: string; title: string; client_id: string | null }>;
      if (candidateRows.length === 0) return { count: 0, only_unread: onlyUnread, tickets: [] };
      const ticketIds = candidateRows.map((r) => String(r.id));

      const [ticketRes, noteRes, readRes] = await Promise.all([
        orgQuery(ctx, 'tickets', 'id, created_at, status, priority').in('id', ticketIds),
        orgQuery(ctx, 'ticket_notes', 'ticket_id, created_at, author_name')
          .eq('author_type', 'client').in('ticket_id', ticketIds),
        orgQuery(ctx, 'ticket_reads', 'ticket_id, read_at').eq('user_id', ctx.userId).in('ticket_id', ticketIds),
      ]);
      if (ticketRes.error) throw new ActionError(`Tickets ophalen mislukt: ${ticketRes.error.message}`);
      if (noteRes.error) throw new ActionError(`Klantreacties ophalen mislukt: ${noteRes.error.message}`);
      if (readRes.error) throw new ActionError(`Leesstatus ophalen mislukt: ${readRes.error.message}`);

      const meta = new Map<string, { created_at: string; status: string; priority: string }>(
        ((ticketRes.data ?? []) as Array<Record<string, unknown>>).map((t) => [String(t.id), {
          created_at: String(t.created_at ?? ''), status: String(t.status ?? ''), priority: String(t.priority ?? ''),
        }]));
      // Laatste klantreactie per ticket. Staat er geen enkele, dan zit het ticket in de
      // view omdat de klant het zélf aanmaakte — dan is de aanmaakdatum de activiteit.
      const lastNote = new Map<string, { at: string; author: string | null }>();
      for (const n of (noteRes.data ?? []) as Array<Record<string, unknown>>) {
        const key = String(n.ticket_id);
        const at = String(n.created_at ?? '');
        const current = lastNote.get(key);
        if (!current || ms(at) > ms(current.at)) lastNote.set(key, { at, author: n.author_name ? String(n.author_name) : null });
      }
      const readAt = new Map<string, string>(
        ((readRes.data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.ticket_id), String(r.read_at ?? '')]));

      const clientIds = [...new Set(candidateRows.map((r) => r.client_id).filter((c): c is string => Boolean(c)))];
      const names = new Map<string, string>();
      if (clientIds.length) {
        const { data: clients } = await orgQuery(ctx, 'clients', 'id, name').in('id', clientIds);
        for (const c of (clients ?? []) as Array<Record<string, unknown>>) names.set(String(c.id), String(c.name));
      }

      const tickets = candidateRows.map((r) => {
        const key = String(r.id);
        const note = lastNote.get(key) ?? null;
        const info = meta.get(key);
        const activity = note?.at || info?.created_at || '';
        const seen = readAt.get(key) ?? '';
        return {
          id: key,
          title: r.title,
          status: info?.status ?? null,
          priority: info?.priority ?? null,
          client_id: r.client_id,
          client_name: r.client_id ? names.get(r.client_id) ?? null : null,
          last_client_activity: activity || null,
          last_client_author: note?.author ?? null,
          /** Wat het was: een reactie van de klant, of een ticket dat hij zelf aanmaakte. */
          activity_kind: note ? 'reactie van de klant' : 'ticket door de klant aangemaakt',
          read_at: seen || null,
          unread: ms(activity) > ms(seen),
        };
      })
        .filter((t) => (onlyUnread ? t.unread : true))
        .sort((a, b) => ms(b.last_client_activity) - ms(a.last_client_activity));

      return { count: tickets.length, only_unread: onlyUnread, tickets: tickets.slice(0, limit) };
    },
  },
];
