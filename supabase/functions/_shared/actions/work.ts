import {
  ActionError, bool, euro, id, joinShort, optChoice, optId, optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * De rest van wat het scherm kan en Gerrie nog niet: telefoongesprekken
 * vastleggen, een offerte intrekken, een factuur crediteren, klantmail als
 * gelezen markeren, een afzender blokkeren, de planning bijstellen, een
 * boekingslink verlengen, een rapportage hernoemen, een collega een bericht
 * sturen, en twee instellingen.
 *
 * Elke handeling hier is een knop die al bestond. Ze stonden niet in de registry
 * omdat niemand ze er in had gezet, niet omdat ze gevaarlijk zijn — die laatste
 * staan in `removal.ts`.
 */

const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
const CALL_OUTCOMES = ['answered', 'missed', 'voicemail', 'busy', 'no_answer', 'failed'] as const;
const OUTCOME_LABELS: Record<string, string> = {
  answered: 'gesproken', missed: 'gemist', voicemail: 'voicemail', busy: 'in gesprek', no_answer: 'geen gehoor', failed: 'mislukt',
};

/** "2026-11-10" + "14:30" in Europe/Amsterdam → ISO-tijdstip in UTC. */
function amsterdamIso(date: string, time: string): string {
  const [h, m] = time.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  // Eerst als UTC, dan corrigeren met de afwijking van Amsterdam op dat moment
  // (winter +1, zomer +2). Zo klopt het ook rond de klokwissel.
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const local = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess - (local.getTime() - utc.getTime())).toISOString();
}

function hhmm(input: Record<string, unknown>, key: string): string | null {
  const value = optStr(input, key, 5);
  if (!value) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ActionError(`"${key}" moet een tijd zijn als UU:MM.`);
  return value;
}

/**
 * Een rapportage van Gerrie is van wie hem maakte (RLS: created_by = auth.uid()).
 * De handelingen draaien op de service-role, dus zoeken we hier zelf op de maker:
 * anders las een collega met het id de titel van een privérapport, en meldde een
 * hernoeming succes terwijl RLS hem bij het uitvoeren stil tegenhield.
 */
async function ownAiReport(ctx: ActionCtx, reportId: string): Promise<{ title: string }> {
  const { data, error } = await orgQuery(ctx, 'ai_reports', 'title').eq('id', reportId).eq('created_by', ctx.userId).maybeSingle();
  if (error) throw new ActionError(`Rapportage ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError('Rapportage niet gevonden onder jouw rapportages.');
  return data as { title: string };
}

/** Vind de contactpersoon bij de klant, of geef een leesbare fout. */
async function contactOfClient(ctx: ActionCtx, contactId: string, clientId: string | null) {
  const contact = await row<{ name: string; client_id: string; phone: string | null }>(ctx, 'client_contacts', contactId, 'name, client_id, phone', 'Contactpersoon');
  // Zonder de naam: een foutmelding gaat onafgebakend terug naar het model.
  if (clientId && contact.client_id !== clientId) throw new ActionError('Die contactpersoon hoort bij een andere klant.');
  return contact;
}

export const WORK_ACTIONS: ActionDef[] = [
  // ── Telefoongesprekken ────────────────────────────────────────────────────
  {
    id: 'client_call.list',
    label: 'Telefoongesprekken bekijken',
    module: 'clients',
    kind: 'read',
    description: 'Toont gelogde telefoongesprekken: met wie, wanneer, hoe lang, hoe het afliep (gesproken, gemist, voicemail…), waar het over ging en de aantekening. Filter op klant of periode.',
    keywords: ['gesprekken', 'telefoon', 'gebeld', 'bellen', 'belde', 'telefoongesprek', 'gemist', 'voicemail', 'belgeschiedenis'],
    input: {
      client_id: { type: 'string', description: 'Optioneel: alleen gesprekken met deze klant.' },
      from: { type: 'string', description: 'Vanaf datum (JJJJ-MM-DD).' },
      to: { type: 'string', description: 'Tot en met datum (JJJJ-MM-DD).' },
      limit: { type: 'number', description: 'Hoeveel hoogstens (standaard 25, hoogstens 100).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Math.floor(optNum(input, 'limit') ?? 25), 1), 100);
      let query = orgQuery(ctx, 'client_calls',
        'id, client_id, contact_id, counterpart_name, phone_raw, direction, outcome, started_at, duration_seconds, subject, notes')
        .order('started_at', { ascending: false }).limit(limit);
      const clientId = optId(input, 'client_id');
      if (clientId) query = query.eq('client_id', clientId);
      const from = optIsoDate(input, 'from');
      const to = optIsoDate(input, 'to');
      if (from) query = query.gte('started_at', `${from}T00:00:00Z`);
      if (to) query = query.lte('started_at', `${to}T23:59:59Z`);
      const { data, error } = await query;
      if (error) throw new ActionError(`Gesprekken ophalen mislukt: ${error.message}`);
      const calls = ((data ?? []) as Array<Record<string, unknown>>).map((c) => ({
        id: c.id, client_id: c.client_id, with: c.counterpart_name, phone: c.phone_raw,
        direction: c.direction === 'inbound' ? 'inkomend' : 'uitgaand', outcome: OUTCOME_LABELS[String(c.outcome)] ?? c.outcome,
        started_at: c.started_at, minutes: Math.round(Number(c.duration_seconds ?? 0) / 60), subject: c.subject, notes: c.notes,
      }));
      return { count: calls.length, calls };
    },
  },
  {
    id: 'client_call.log',
    label: 'Een telefoongesprek vastleggen',
    module: 'clients',
    kind: 'write',
    description:
      'Legt een telefoongesprek vast in het klantdossier, net als "Gesprek loggen": met wie (klant en eventueel contactpersoon), inkomend of uitgaand, wanneer, hoe lang, hoe het afliep, waar het over ging en een aantekening. ' +
      'Gebruik dit voor "ik heb net Jansen gebeld over…" of "zet in het dossier dat ik vanochtend gebeld ben door…".',
    keywords: ['gesprek', 'gebeld', 'bellen', 'telefoon', 'telefoongesprek', 'loggen', 'vastleggen', 'belnotitie', 'gespreksnotitie', 'teruggebeld'],
    input: {
      client_id: { type: 'string', description: 'Id van de klant (uit search_clients).' },
      contact_id: { type: 'string', description: 'Optioneel: de contactpersoon (uit list_client_contacts).' },
      counterpart_name: { type: 'string', description: 'Met wie je sprak, als dat geen bekende contactpersoon is.' },
      phone: { type: 'string', description: 'Het nummer (optioneel).' },
      direction: { type: 'string', enum: [...CALL_DIRECTIONS], description: 'inbound = je werd gebeld; outbound = jij belde (standaard).' },
      outcome: { type: 'string', enum: [...CALL_OUTCOMES], description: 'Hoe het afliep (standaard answered = gesproken).' },
      date: { type: 'string', description: 'Datum (JJJJ-MM-DD), standaard vandaag.' },
      time: { type: 'string', description: 'Begintijd UU:MM (Europe/Amsterdam). Standaard nu.' },
      minutes: { type: 'number', description: 'Hoe lang het gesprek duurde, in minuten.' },
      subject: { type: 'string', description: 'Waar ging het over, in één regel.' },
      notes: { type: 'string', description: 'Aantekening: wat er besproken en afgesproken is.' },
      project_id: { type: 'string', description: 'Optioneel: het project waar het over ging.' },
    },
    required: ['subject'],
    async plan(ctx, input) {
      const clientId = optId(input, 'client_id');
      const contactId = optId(input, 'contact_id');
      let who = optStr(input, 'counterpart_name', 120);
      let clientName: string | null = null;
      if (clientId) clientName = (await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant')).name;
      let contactPhone: string | null = null;
      if (contactId) {
        const contact = await contactOfClient(ctx, contactId, clientId);
        who = who ?? contact.name;
        contactPhone = contact.phone;
      }
      if (!clientId && !who) throw new ActionError('Met wie was het gesprek? Geef een klant (client_id) of een naam (counterpart_name).');
      const projectId = optId(input, 'project_id');
      if (projectId) await row(ctx, 'projects', projectId, 'id', 'Project');
      const direction = optChoice(input, 'direction', CALL_DIRECTIONS) ?? 'outbound';
      const outcome = optChoice(input, 'outcome', CALL_OUTCOMES) ?? 'answered';
      const date = optIsoDate(input, 'date') ?? ctx.today;
      const time = hhmm(input, 'time');
      const startedAt = time ? amsterdamIso(date, time) : (date === ctx.today ? new Date().toISOString() : amsterdamIso(date, '12:00'));
      const minutes = Math.max(0, Math.min(600, optNum(input, 'minutes') ?? 0));
      const subject = str(input, 'subject', 200);
      const notes = optStr(input, 'notes', 5000);
      return {
        title: `Gesprek vastleggen: ${subject}`,
        sub: joinShort([
          `${direction === 'inbound' ? 'gebeld door' : 'gebeld met'} ${who ?? clientName}`,
          clientName && who !== clientName ? clientName : null,
          `${date}${time ? ` ${time}` : ''}`,
          outcome === 'answered' ? (minutes ? `${Math.round(minutes)} min` : null) : OUTCOME_LABELS[outcome],
        ], 140),
        kind: 'work',
        payload: {
          values: {
            client_id: clientId, contact_id: contactId, project_id: projectId,
            counterpart_name: who ?? clientName, phone_raw: optStr(input, 'phone', 40) ?? contactPhone,
            direction, outcome, started_at: startedAt,
            duration_seconds: outcome === 'answered' ? Math.round(minutes * 60) : 0,
            subject, notes, source: 'manual',
          },
          subject,
        },
      };
    },
  },
  {
    id: 'client_call.update',
    label: 'Een gelogd telefoongesprek aanpassen',
    module: 'clients',
    kind: 'write',
    description: 'Past een gelogd gesprek aan: het onderwerp, de aantekening (vervangen of aanvullen), de duur of hoe het afliep. Zoek het gesprek met `client_call.list`.',
    keywords: ['gesprek', 'aanpassen', 'aantekening', 'gespreksnotitie', 'aanvullen', 'telefoon'],
    input: {
      call_id: { type: 'string', description: 'Id van het gesprek (uit client_call.list).' },
      subject: { type: 'string' },
      notes: { type: 'string', description: 'De aantekening.' },
      append_notes: { type: 'boolean', description: 'true = notes onder de bestaande aantekening zetten in plaats van vervangen.' },
      minutes: { type: 'number', description: 'Nieuwe duur in minuten.' },
      outcome: { type: 'string', enum: [...CALL_OUTCOMES] },
    },
    required: ['call_id'],
    async plan(ctx, input) {
      const callId = id(input, 'call_id');
      const call = await row<{ subject: string; notes: string | null; outcome: string }>(ctx, 'client_calls', callId, 'subject, notes, outcome', 'Gesprek');
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const subject = optStr(input, 'subject', 200);
      if (subject && subject !== call.subject) { patch.subject = subject; changes.push(`onderwerp → ${subject}`); }
      const notes = optStr(input, 'notes', 5000);
      // Aanvullen gebeurt bij het uitvoeren, op de tekst van dan (src/lib/actions/work.ts).
      const appendNotes = notes && bool(input, 'append_notes', false) ? notes : null;
      if (notes && !appendNotes) { patch.notes = notes; changes.push('aantekening vervangen'); }
      if (appendNotes) changes.push('aantekening aangevuld');
      const outcome = optChoice(input, 'outcome', CALL_OUTCOMES);
      if (outcome) { patch.outcome = outcome; changes.push(OUTCOME_LABELS[outcome]); }
      const minutes = optNum(input, 'minutes');
      if (minutes !== null) { patch.duration_seconds = Math.max(0, Math.round(minutes * 60)); changes.push(`${Math.round(minutes)} min`); }
      if (Object.keys(patch).length === 0 && !appendNotes) throw new ActionError('Geef minstens één ding dat verandert.');
      return {
        title: `Gesprek "${call.subject || 'zonder onderwerp'}" aanpassen`,
        sub: joinShort(changes, 140),
        kind: 'work',
        payload: { call_id: callId, patch, append_notes: appendNotes, subject: call.subject },
      };
    },
  },

  // ── Verkoop ───────────────────────────────────────────────────────────────
  {
    id: 'quote.withdraw',
    label: 'Een offerte intrekken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Trekt een verstuurde (of intern goedgekeurde) offerte in: de klant kan er daarna niet meer akkoord op geven en hij gaat op geannuleerd. ' +
      'De reden is intern; de klant ziet hem niet. Een geaccepteerde offerte trek je niet meer in. Zoek de offerte met `list_quotes`.',
    keywords: ['offerte', 'intrekken', 'terugtrekken', 'annuleren', 'vervallen', 'niet meer geldig', 'cancel'],
    input: {
      quote_id: { type: 'string', description: 'Id van de offerte (uit list_quotes).' },
      reason: { type: 'string', description: 'Interne reden (optioneel).' },
    },
    required: ['quote_id'],
    async plan(ctx, input) {
      const quoteId = id(input, 'quote_id');
      const quote = await row<{ number: string | null; status: string; client_id: string | null }>(
        ctx, 'quotes', quoteId, 'number, status, client_id', 'Offerte');
      if (!['sent', 'internally_approved', 'pending_internal_approval'].includes(quote.status)) {
        throw new ActionError(quote.status === 'accepted'
          ? 'Deze offerte is al geaccepteerd; intrekken kan dan niet meer. Spreek het met de klant af en maak zo nodig een creditnota op de factuur.'
          : `Een offerte met status "${quote.status}" kun je niet intrekken. Alleen verstuurde of intern goedgekeurde offertes.`);
      }
      const client = quote.client_id ? await row<{ name: string }>(ctx, 'clients', quote.client_id, 'name', 'Klant') : null;
      const reason = optStr(input, 'reason', 2000);
      return {
        title: `Offerte ${quote.number ?? ''} intrekken`.trim(),
        sub: joinShort([client?.name, reason ? `reden: ${reason}` : null], 140) || 'zonder klant',
        kind: 'money',
        warning: 'De klant kan daarna niet meer akkoord geven op deze offerte.',
        payload: { quote_id: quoteId, number: quote.number, reason },
      };
    },
  },
  {
    id: 'invoice.credit',
    label: 'Een factuur crediteren (creditnota voor het hele bedrag)',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Maakt een creditfactuur voor het VOLLEDIGE bedrag van een verstuurde, nog niet betaalde factuur, net als de knop "Crediteren": de creditnota gaat ook naar de klant, omzet en btw worden teruggeboekt en de factuur gaat op geannuleerd. ' +
      'Zo herstel je een verstuurde factuur; wissen kan wettelijk niet. Daarna kun je met `propose_invoice` een nieuwe, goede factuur klaarzetten. Zoek de factuur met `list_invoices`.',
    keywords: ['crediteren', 'creditnota', 'creditfactuur', 'factuur', 'tegenboeken', 'corrigeren', 'annuleren', 'terugdraaien', 'fout'],
    input: {
      invoice_id: { type: 'string', description: 'Id van de factuur (uit list_invoices).' },
      reason: { type: 'string', description: 'De reden; die komt op de creditfactuur (standaard "Factuur vervalt").' },
    },
    required: ['invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const invoice = await row<{ number: string | null; status: string; client_id: string | null; total_amount: number | null }>(
        ctx, 'invoices', invoiceId, 'number, status, client_id, total_amount', 'Factuur');
      if (!['sent', 'overdue'].includes(invoice.status)) {
        throw new ActionError(invoice.status === 'draft'
          ? 'Dit is nog een concept; dat pas je gewoon aan (propose_edit_invoice) in plaats van te crediteren.'
          : invoice.status === 'paid'
            ? 'Deze factuur is betaald. Een betaalde factuur crediteer je niet met deze knop; registreer een terugbetaling of maak een gedeeltelijke creditnota in het scherm.'
            : `Een factuur met status "${invoice.status}" kun je niet crediteren.`);
      }
      const client = invoice.client_id ? await row<{ name: string }>(ctx, 'clients', invoice.client_id, 'name', 'Klant') : null;
      const reason = optStr(input, 'reason', 500) ?? 'Factuur vervalt';
      return {
        title: `Factuur ${invoice.number ?? ''} crediteren`.replace(/\s+/g, ' '),
        sub: joinShort([client?.name, invoice.total_amount !== null ? euro(Number(invoice.total_amount)) : null, `reden: ${reason}`], 140),
        kind: 'money',
        warning: 'Er gaat een creditfactuur voor het hele bedrag naar de klant, omzet en btw worden teruggeboekt en de factuur gaat op geannuleerd. Dit kun je niet ongedaan maken.',
        payload: { invoice_id: invoiceId, number: invoice.number, reason },
      };
    },
  },

  // ── Klantmail en postvak ──────────────────────────────────────────────────
  {
    id: 'client_email.mark_read',
    label: 'Klantmail als gelezen markeren',
    module: 'clients',
    kind: 'write',
    description: 'Markeert binnengekomen mail van een klant als gelezen, zodat hij niet meer bij "ongelezen" staat. Zonder `email_ids` gaat alle ongelezen inkomende mail van die klant op gelezen. Zoek de mail met `client_email.list` of `client_email.recent_inbound`.',
    keywords: ['gelezen', 'markeren', 'ongelezen', 'mail', 'klantmail', 'afvinken', 'inbox'],
    input: {
      client_id: { type: 'string', description: 'Id van de klant.' },
      email_ids: { type: 'array', items: { type: 'string' }, description: 'Optioneel: alleen deze mails.' },
    },
    required: ['client_id'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const wanted = Array.isArray(input.email_ids) ? (input.email_ids as unknown[]).map(String) : [];
      let query = orgQuery(ctx, 'client_emails', 'id').eq('client_id', clientId).eq('direction', 'inbound').is('deleted_at', null).limit(500);
      if (wanted.length > 0) query = query.in('id', wanted.slice(0, 200));
      const { data, error } = await query;
      if (error) throw new ActionError(`Mail ophalen mislukt: ${error.message}`);
      const emailIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (emailIds.length === 0) throw new ActionError('Er is geen inkomende mail van deze klant om als gelezen te markeren.');
      return {
        title: `Mail van ${client.name} als gelezen markeren`,
        sub: `${emailIds.length} bericht${emailIds.length === 1 ? '' : 'en'}`,
        kind: 'mail',
        payload: { client_id: clientId, client_name: client.name, email_ids: emailIds },
      };
    },
  },
  {
    id: 'inbox.block_sender',
    label: 'Een afzender blokkeren in het postvak',
    module: 'clients',
    kind: 'write',
    description: 'Blokkeert een afzender (e-mailadres of domein) op het doorstuuradres van de organisatie: mail van die afzender komt niet meer in de opvangbak. Een adres van een klant kun je niet blokkeren. Gebruik dit bij spam of nieuwsbrieven in `inbox.list`.',
    keywords: ['blokkeren', 'spam', 'afzender', 'nieuwsbrief', 'postvak', 'opvangbak', 'tegenhouden', 'doorstuuradres'],
    input: {
      sender: { type: 'string', description: 'Het e-mailadres of het domein (bijv. nieuwsbrief.nl).' },
    },
    required: ['sender'],
    async plan(ctx, input) {
      const sender = str(input, 'sender', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender) && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(sender)) {
        throw new ActionError(`"${sender}" is geen e-mailadres of domein.`);
      }
      const { data, error } = await orgQuery(ctx, 'organization_inbound_aliases', 'id, local_part, status')
        .eq('status', 'active').limit(5);
      if (error) throw new ActionError(`Doorstuuradres ophalen mislukt: ${error.message}`);
      const alias = ((data ?? []) as Array<{ id: string; local_part: string }>)[0];
      if (!alias) throw new ActionError('Deze organisatie heeft geen actief doorstuuradres; er is dus niets te blokkeren.');
      return {
        title: `Afzender ${sender} blokkeren`,
        sub: 'mail van deze afzender komt niet meer in de opvangbak',
        kind: 'mail',
        payload: { alias_id: alias.id, sender },
      };
    },
  },

  // ── Planning ──────────────────────────────────────────────────────────────
  {
    id: 'planner.set_day_capacity',
    label: 'Mijn werkuren per dag in de weekplanner instellen',
    module: 'projects',
    kind: 'write',
    description: 'Stelt in hoeveel minuten per dag jij inplanbaar bent in de weekplanner (bijv. 6 uur = 360) en of het weekend meetelt. Geldt alleen voor jezelf.',
    keywords: ['capaciteit', 'werkuren', 'uren per dag', 'weekplanner', 'beschikbaar', 'planning', 'weekend', 'dagcapaciteit'],
    input: {
      hours: { type: 'number', description: 'Uren per dag (mag decimaal).' },
      include_weekend: { type: 'boolean', description: 'Telt het weekend mee? Standaard nee.' },
    },
    required: ['hours'],
    async plan(ctx, input) {
      // Voor wie het voorstel is, niet voor wie het goedkeurt: de rij is persoonlijk.
      const hours = optNum(input, 'hours') ?? 0;
      if (hours <= 0 || hours > 16) throw new ActionError('Geef een aantal uren tussen 0 en 16.');
      const includeWeekend = bool(input, 'include_weekend', false);
      return {
        title: `Weekplanner: ${hours.toLocaleString('nl-NL')} uur per dag`,
        sub: includeWeekend ? 'ook in het weekend' : 'alleen op werkdagen',
        kind: 'agenda',
        payload: { user_id: ctx.userId, minutes: Math.round(hours * 60), include_weekend: includeWeekend },
      };
    },
  },
  {
    id: 'project.shift_planning',
    label: 'De planning van een project een aantal dagen opschuiven',
    module: 'projects',
    kind: 'write',
    description: 'Schuift de ingeplande taken van een project in één keer op, bijvoorbeeld als de start een week later wordt: alle open taken met een plandatum gaan `days` dagen vooruit (of terug bij een negatief getal), en desgewenst ook hun deadlines. Afgeronde taken blijven staan.',
    keywords: ['opschuiven', 'verschuiven', 'planning', 'uitstellen', 'vertraging', 'later', 'eerder', 'deadlines', 'project'],
    input: {
      project_id: { type: 'string', description: 'Id van het project.' },
      days: { type: 'number', description: 'Aantal dagen; negatief = eerder.' },
      shift_deadlines: { type: 'boolean', description: 'Ook de deadlines meeschuiven? Standaard ja.' },
    },
    required: ['project_id', 'days'],
    async plan(ctx, input) {
      const projectId = id(input, 'project_id');
      const days = Math.round(optNum(input, 'days') ?? 0);
      if (days === 0 || Math.abs(days) > 365) throw new ActionError('Geef een aantal dagen tussen -365 en 365 (niet 0).');
      const project = await row<{ name: string }>(ctx, 'projects', projectId, 'name', 'Project');
      const { data, error } = await orgQuery(ctx, 'tasks', 'id, title').eq('project_id', projectId)
        .neq('status', 'done').not('planned_date', 'is', null).limit(500);
      if (error) throw new ActionError(`Taken ophalen mislukt: ${error.message}`);
      const tasks = (data ?? []) as Array<{ id: string; title: string }>;
      if (tasks.length === 0) throw new ActionError('Dit project heeft geen open taken met een plandatum; er valt niets op te schuiven.');
      const shiftDeadlines = bool(input, 'shift_deadlines', true);
      return {
        title: `Planning van "${project.name}" ${Math.abs(days)} dag${Math.abs(days) === 1 ? '' : 'en'} ${days > 0 ? 'later' : 'eerder'}`,
        sub: `${tasks.length} ingeplande ta${tasks.length === 1 ? 'ak' : 'ken'}${shiftDeadlines ? ', deadlines schuiven mee' : ''}`,
        kind: 'agenda',
        payload: { project_id: projectId, project_name: project.name, task_ids: tasks.map((t) => t.id), days, shift_deadlines: shiftDeadlines },
      };
    },
  },
  {
    id: 'booking_link.extend',
    label: 'Een boekingslink langer geldig maken',
    module: 'calendar',
    kind: 'write',
    description: 'Verlengt een boekingslink, zodat klanten er langer mee kunnen boeken (standaard 120 dagen vanaf nu). Zoek de link met `booking_link.list_slots` of `list_bookings`.',
    keywords: ['boekingslink', 'verlengen', 'langer', 'verlopen', 'geldig', 'afspraak plannen'],
    input: {
      link_id: { type: 'string', description: 'Id van de boekingslink.' },
      days: { type: 'number', description: 'Hoeveel dagen vanaf nu (standaard 120, hoogstens 365).' },
    },
    required: ['link_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await row<{ title: string; status: string }>(ctx, 'meeting_booking_links', linkId, 'title, status', 'Boekingslink');
      const days = Math.min(Math.max(Math.round(optNum(input, 'days') ?? 120), 1), 365);
      return {
        title: `Boekingslink "${link.title}" verlengen`,
        sub: `nog ${days} dagen geldig`,
        kind: 'agenda',
        payload: { link_id: linkId, title: link.title, days },
      };
    },
  },

  // ── Rapportages en team ───────────────────────────────────────────────────
  {
    id: 'ai_report.rename',
    label: 'Een rapportage (van Gerrie) hernoemen',
    module: 'stats',
    kind: 'write',
    description: 'Geeft een rapportage die Gerrie onder Rapportages maakte een andere naam.',
    keywords: ['rapportage', 'hernoemen', 'naam', 'rapport', 'dashboard'],
    input: {
      report_id: { type: 'string', description: 'Id van de rapportage.' },
      title: { type: 'string', description: 'De nieuwe naam.' },
    },
    required: ['report_id', 'title'],
    async plan(ctx, input) {
      const reportId = id(input, 'report_id');
      const report = await ownAiReport(ctx, reportId);
      const title = str(input, 'title', 120);
      return {
        title: `Rapportage hernoemen naar "${title}"`,
        sub: `was "${report.title}"`,
        kind: 'insight',
        payload: { report_id: reportId, title },
      };
    },
  },
  {
    id: 'teamchat.send_dm',
    label: 'Een collega een bericht sturen in de teamchat',
    module: 'chat',
    kind: 'write',
    description:
      'Stuurt een collega een direct bericht in de teamchat, namens jou. Zoek de collega met `list_team_members`. ' +
      'Gerrie leest de teamchat zelf niet; dit is alleen om een bericht te versturen, bijvoorbeeld "laat Piet weten dat de offerte eruit is".',
    keywords: ['teamchat', 'chat', 'bericht', 'collega', 'laten weten', 'sturen', 'appje', 'dm', 'doorgeven'],
    input: {
      user_id: { type: 'string', description: 'user_id van de collega (uit list_team_members).' },
      body: { type: 'string', description: 'De tekst van het bericht.' },
    },
    required: ['user_id', 'body'],
    async plan(ctx, input) {
      const userId = id(input, 'user_id');
      if (userId === ctx.userId) throw new ActionError('Dat ben je zelf; een bericht aan jezelf kan niet.');
      const { data, error } = await orgQuery(ctx, 'organization_members', 'user_id, email, status').eq('user_id', userId).maybeSingle();
      if (error) throw new ActionError(`Teamlid ophalen mislukt: ${error.message}`);
      const member = data as { email: string | null; status: string | null } | null;
      if (!member || (member.status && member.status !== 'active')) throw new ActionError('Die collega is geen actief teamlid van deze organisatie.');
      const body = str(input, 'body', 4000);
      return {
        title: `Bericht aan ${member.email ?? 'collega'} in de teamchat`,
        sub: body.length > 140 ? `${body.slice(0, 139)}…` : body,
        kind: 'mail',
        // Namens wie: een bericht in de teamchat draagt de naam van de afzender. Keurt
        // een owner het voorstel van de agent van een collega goed, dan zou het
        // anders namens die owner gaan; de uitvoerder weigert dat (src/lib/actions/work.ts).
        payload: { user_id: userId, recipient: member.email, body, sender_user_id: ctx.userId },
      };
    },
  },

  // ── Instellingen ──────────────────────────────────────────────────────────
  {
    id: 'settings.set_ticket_emails',
    label: 'Ticketmeldingen naar klanten aan- of uitzetten',
    module: 'tickets',
    kind: 'write',
    adminOnly: true,
    description: 'Zet aan of uit of klanten een e-mail krijgen bij een reactie op hun ticket (Instellingen → Klantportaal). Alleen voor owners en admins.',
    keywords: ['ticketmeldingen', 'portaal', 'klantportaal', 'meldingen', 'mail bij reactie', 'instelling', 'ticket'],
    input: { enabled: { type: 'boolean', description: 'true = klanten krijgen mail bij een reactie; false = niet.' } },
    required: ['enabled'],
    async plan(_ctx, input) {
      const enabled = bool(input, 'enabled', true);
      return {
        title: `Ticketmeldingen naar klanten ${enabled ? 'aanzetten' : 'uitzetten'}`,
        sub: enabled ? 'klanten krijgen mail bij een reactie op hun ticket' : 'klanten krijgen geen mail meer bij een reactie',
        kind: 'work',
        payload: { enabled },
      };
    },
  },
  {
    id: 'settings.save_jitsi_server',
    label: 'Eigen Jitsi-server instellen voor videovergaderingen',
    module: 'calendar',
    kind: 'write',
    adminOnly: true,
    description: 'Stelt het adres in van een eigen Jitsi-server voor videovergaderingen (bijv. https://meet.jouwbedrijf.nl), of zet hem terug op de openbare server met `reset: true`. Alleen voor owners en admins.',
    keywords: ['jitsi', 'videovergadering', 'server', 'vergaderlink', 'video', 'instelling'],
    input: {
      url: { type: 'string', description: 'Het https-adres van de Jitsi-server.' },
      reset: { type: 'boolean', description: 'true = terug naar de openbare server (meet.jit.si).' },
    },
    async plan(_ctx, input) {
      if (bool(input, 'reset', false)) {
        return { title: 'Videovergaderingen weer via meet.jit.si', sub: 'de eigen Jitsi-server wordt niet meer gebruikt', kind: 'agenda', payload: { url: null } };
      }
      const url = str(input, 'url', 200).replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/[\w./-]*)?$/i.test(url)) throw new ActionError('Geef een https-adres, bijvoorbeeld https://meet.jouwbedrijf.nl.');
      return { title: `Eigen Jitsi-server: ${url}`, sub: 'nieuwe videovergaderingen krijgen een link op deze server', kind: 'agenda', payload: { url } };
    },
  },
];
