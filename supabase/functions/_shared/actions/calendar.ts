import {
  ActionError, bool, id, isoDate, joinShort, optChoice, optId, optNum, optStr,
  orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond de AGENDA: de agenda's zelf, de koppeling van een afspraak aan
 * een klant of project, de boekingslinks waarmee een klant zelf een moment kiest,
 * en de opnames met notulen.
 *
 * Het dagelijkse werk zit al als eersteklas tool in gerrieCore: `list_calendars`,
 * `list_calendar_events`, `suggest_meeting_slots`, `propose_calendar_event`,
 * `propose_edit_calendar_event`, `propose_cancel_calendar_event` en `list_bookings`.
 * Wat hier staat is de rest van wat de agendaschermen kunnen — de agendabronnen
 * beheren, de klant/project-koppeling met de urenregistratie eraan, de boekingstool
 * en de notulen.
 *
 * TWEE DINGEN OM IN DE GATEN TE HOUDEN
 *  1. Alleen ResoFly-agenda's (provider 'native') staan in ONZE database. Een
 *     Google- of Microsoft-afspraak zit bij de provider; die kan `plan()` hier niet
 *     opzoeken. Handelingen die de inhoud van een afspraak aanraken zijn daarom
 *     bewust beperkt tot native items, en dat staat ook in hun omschrijving.
 *  2. Een native afspraak bijwerken stuurt de genodigden opnieuw een uitnodiging
 *     (iMIP), en genodigden die je weglaat krijgen een afzegging. Elke handeling die
 *     zo'n item aanraakt neemt de bestaande genodigdenlijst dus mee en zegt op de
 *     kaart hoeveel post er de deur uit gaat.
 */

const VISIBILITY = ['private', 'organization'] as const;
const LINK_STATUS = ['active', 'closed'] as const;
const ENTRY_TYPE = ['direct', 'indirect'] as const;
const INDIRECT_CATEGORY = ['admin', 'acquisition', 'travel', 'education', 'other'] as const;

const INDIRECT_LABEL: Record<string, string> = {
  admin: 'administratie', acquisition: 'acquisitie', travel: 'reistijd',
  education: 'scholing', other: 'overig',
};

// ── Tijd in Europe/Amsterdam ────────────────────────────────────────────────
// De gebruiker denkt in wandkloktijd, de database bewaart UTC. Deze twee helpers
// zijn de enige plek waar dat verschil zit.

const AMS = 'Europe/Amsterdam';

/** Hoeveel Amsterdam op dit moment vóórloopt op UTC (zomer-/wintertijd-bewust). */
function amsOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AMS, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at.getTime();
}

/**
 * Amsterdamse wandkloktijd (JJJJ-MM-DD + UU:MM) naar een UTC-tijdstempel.
 * Twee slagen, omdat de offset zelf van het moment afhangt: rond de overgang naar
 * zomertijd geeft één slag er een uur naast.
 */
function amsWallToUtcIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ms = naive - amsOffsetMs(new Date(naive));
  ms = naive - amsOffsetMs(new Date(ms));
  return new Date(ms).toISOString();
}

/** Leesbaar moment op de goedkeurkaart: "ma 3 sep 14:00". */
function nlMoment(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('nl-NL', {
    timeZone: AMS, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Verplichte tijd als UU:MM. */
function hhmm(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ActionError(`"${key}" moet een tijd zijn als UU:MM (24-uurs).`);
  return value;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ── Gedeelde opzoekers ──────────────────────────────────────────────────────

interface SourceRow {
  id: string; name: string; provider: string; user_id: string;
  sync_enabled: boolean; write_enabled: boolean; visibility: string;
  connection_id: string | null; feed_url: string | null;
}

const SOURCE_FIELDS = 'id, name, provider, user_id, sync_enabled, write_enabled, visibility, connection_id, feed_url';

async function source(ctx: ActionCtx, sourceId: string): Promise<SourceRow> {
  return await row<SourceRow>(ctx, 'calendar_sources', sourceId, SOURCE_FIELDS, 'Agenda');
}

/**
 * De agenda-edge-functions laten naam, kleur, delen en verversen alleen toe aan
 * degene die de agenda heeft aangemaakt of gekoppeld. Dat hier al afvangen scheelt
 * een voorstel dat bij het akkoord alsnog stukloopt.
 */
function assertOwner(ctx: ActionCtx, src: SourceRow): void {
  if (src.user_id !== ctx.userId) {
    throw new ActionError(`"${src.name}" is door iemand anders gekoppeld; alleen die persoon kan deze agenda aanpassen.`);
  }
}

interface NativeEventRow {
  id: string; source_id: string; uid: string; title: string;
  description: string | null; location: string | null; meeting_url: string | null;
  starts_at: string; ends_at: string; all_day: boolean; recurs: boolean; deleted_at: string | null;
}

const NATIVE_EVENT_FIELDS =
  'id, source_id, uid, title, description, location, meeting_url, starts_at, ends_at, all_day, recurs, deleted_at';

/**
 * Haalt een ResoFly-afspraak op en controleert dat hij ook echt bij te werken is.
 * Google- en Microsoft-items staan niet in onze database; die vallen hier af met een
 * uitleg in plaats van een lege rij.
 */
async function nativeEvent(ctx: ActionCtx, eventId: string): Promise<{ event: NativeEventRow; src: SourceRow }> {
  const event = await row<NativeEventRow>(ctx, 'calendar_events', eventId, NATIVE_EVENT_FIELDS, 'Afspraak');
  if (event.deleted_at) throw new ActionError('Die afspraak is al afgezegd.');
  const src = await source(ctx, event.source_id);
  if (src.provider !== 'native') {
    throw new ActionError(`"${src.name}" is een ${src.provider === 'ics' ? 'alleen-lezen agenda via een link' : 'externe agenda'}; items daarin zijn hier niet te bewerken.`);
  }
  if (src.user_id !== ctx.userId && src.visibility !== 'organization') {
    throw new ActionError(`"${src.name}" is een privé-agenda van iemand anders.`);
  }
  return { event, src };
}

/** Genodigden van een ResoFly-afspraak, zodat een bewerking ze niet per ongeluk wist. */
async function attendeesOf(ctx: ActionCtx, eventId: string): Promise<Array<{ email: string; name: string | null; role: string; status: string }>> {
  const { data, error } = await orgQuery(ctx, 'calendar_event_attendees', 'email, display_name, role, status')
    .eq('event_id', eventId).order('email', { ascending: true });
  if (error) throw new ActionError(`Genodigden ophalen mislukt: ${error.message}`);
  return (data ?? []).map((a: Record<string, unknown>) => ({
    email: String(a.email), name: a.display_name ? String(a.display_name) : null,
    role: String(a.role ?? 'req'), status: String(a.status ?? 'needs-action'),
  }));
}

interface BookingLinkRow {
  id: string; title: string; status: string; client_id: string | null; source_id: string | null;
  max_total_bookings: number; max_per_week: number; auto_conference: boolean;
  meeting_url: string | null; public_token_hash: string | null;
}

const BOOKING_LINK_FIELDS =
  'id, title, status, client_id, source_id, max_total_bookings, max_per_week, auto_conference, meeting_url, public_token_hash';

async function bookingLink(ctx: ActionCtx, linkId: string): Promise<BookingLinkRow> {
  return await row<BookingLinkRow>(ctx, 'meeting_booking_links', linkId, BOOKING_LINK_FIELDS, 'Boekingslink');
}

interface RecordingRow {
  id: string; event_title_snapshot: string | null; status: string;
  transcript_text: string | null; summary_text: string | null;
  provider: string | null; event_ref: string | null;
  summary_recipients: Array<{ email: string; name: string | null }> | null;
  summary_sent_at: string | null; created_at: string;
}

const RECORDING_FIELDS =
  'id, event_title_snapshot, status, transcript_text, summary_text, provider, event_ref, summary_recipients, summary_sent_at, created_at';

export const CALENDAR_ACTIONS: ActionDef[] = [
  // ── Agendabronnen ─────────────────────────────────────────────────────────
  {
    id: 'calendar_source.list',
    label: "Agenda's met hun deel-, schrijf- en verversinstellingen bekijken",
    module: 'calendar',
    kind: 'read',
    description:
      "Geeft ALLE agenda's van de organisatie met de instellingen die `list_calendars` niet toont: staat de agenda aan (sync_enabled), is hij privé of gedeeld met het team (visibility), mag erin geschreven worden, van wie hij is, en bij een agenda-via-link wanneer de feed voor het laatst is opgehaald en of dat foutliep. " +
      "Gebruik dit vóór `calendar_source.set_sharing`, `calendar_source.update_native` of `calendar_source.refresh_ics`. Voor het simpelweg kiezen van een agenda om iets in te plannen is `list_calendars` genoeg.",
    keywords: ['agenda', "agenda's", 'kalender', 'bron', 'delen', 'privé', 'zichtbaar', 'sync', 'ics', 'ical', 'abonnement', 'feed', 'google', 'outlook', 'microsoft'],
    input: {
      provider: { type: 'string', enum: ['native', 'google', 'microsoft', 'ics'], description: "Beperk tot één soort agenda. 'native' = eigen ResoFly-agenda, 'ics' = agenda via een link." },
      mine_only: { type: 'boolean', description: "Alleen de agenda's van de ingelogde gebruiker. Standaard uit." },
    },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'calendar_sources',
        'id, name, provider, user_id, color, timezone, is_primary, sync_enabled, write_enabled, visibility, connection_id, feed_url, feed_last_synced_at, feed_last_error')
        .order('provider', { ascending: true }).order('name', { ascending: true }).limit(200);
      const provider = optChoice(input, 'provider', ['native', 'google', 'microsoft', 'ics'] as const);
      if (provider) query = query.eq('provider', provider);
      if (bool(input, 'mine_only', false)) query = query.eq('user_id', ctx.userId);
      const { data, error } = await query;
      if (error) throw new ActionError(`Agenda's ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];

      const { data: connections } = await orgQuery(ctx, 'calendar_connections', 'id, provider, provider_account_email, status, last_error');
      const byConnection = new Map<string, Record<string, unknown>>(
        (connections ?? []).map((c: Record<string, unknown>) => [String(c.id), c]));

      return {
        calendars: rows.map((s) => {
          const connection = s.connection_id ? byConnection.get(String(s.connection_id)) : null;
          return {
            source_id: s.id,
            name: s.name,
            provider: s.provider,
            is_mine: String(s.user_id) === ctx.userId,
            shown_in_agenda: s.sync_enabled,
            shared_with_team: s.visibility === 'organization',
            can_write: s.write_enabled,
            is_primary: s.is_primary,
            timezone: s.timezone,
            // Alleen bij een agenda via een iCal/ICS-link.
            feed_url: s.feed_url ?? null,
            feed_last_synced_at: s.feed_last_synced_at ?? null,
            feed_last_error: s.feed_last_error ?? null,
            // Bij Google/Microsoft: het gekoppelde account en of de koppeling nog leeft.
            connection_id: s.connection_id ?? null,
            account_email: connection ? connection.provider_account_email : null,
            connection_status: connection ? connection.status : null,
            connection_error: connection ? connection.last_error : null,
          };
        }),
      };
    },
  },

  {
    id: 'calendar_source.create_native',
    label: 'Eigen ResoFly-agenda aanmaken',
    module: 'calendar',
    kind: 'write',
    description:
      "Maakt een nieuwe agenda in ResoFly zelf aan — zonder Google of Microsoft. Daarin kun je meteen afspraken plannen, en hij is via CalDAV op de telefoon te zetten. " +
      "Standaard privé: alleen jij ziet de items. Zet `visibility` op 'organization' om hem met het hele team te delen.",
    keywords: ['agenda aanmaken', 'nieuwe agenda', 'eigen agenda', 'resofly-agenda', 'kalender toevoegen'],
    input: {
      name: { type: 'string', description: 'Naam van de agenda, bijvoorbeeld "Shoots" of "Privé".' },
      color: { type: 'string', description: 'Hexkleur voor de blokjes in de agenda, bv. #FFD966.' },
      visibility: { type: 'string', enum: [...VISIBILITY], description: "private = alleen jij, organization = gedeeld met het team. Standaard private." },
    },
    required: ['name'],
    async plan(ctx, input) {
      const name = str(input, 'name', 120);
      const visibility = optChoice(input, 'visibility', VISIBILITY) ?? 'private';
      const color = optStr(input, 'color', 9);
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new ActionError('Geef de kleur als hexcode, bijvoorbeeld #FFD966.');
      const { data: existing } = await orgQuery(ctx, 'calendar_sources', 'id')
        .eq('user_id', ctx.userId).eq('provider', 'native').eq('name', name).maybeSingle();
      if (existing) throw new ActionError(`Je hebt al een ResoFly-agenda die "${name}" heet.`);
      return {
        title: `ResoFly-agenda aanmaken: ${name}`,
        sub: joinShort([visibility === 'organization' ? 'gedeeld met het team' : 'privé', color ?? null]),
        kind: 'agenda',
        payload: { name, color, visibility },
      };
    },
  },

  {
    id: 'calendar_source.update_native',
    label: 'Eigen ResoFly-agenda hernoemen of van kleur wisselen',
    module: 'calendar',
    kind: 'write',
    description:
      "Past de naam, de kleur of de zichtbaarheid van een eigen ResoFly-agenda aan. Werkt alleen op agenda's met provider 'native' en alleen als jij ze hebt aangemaakt — zoek ze op met `calendar_source.list`. " +
      "Let op: `visibility` op 'organization' maakt ALLE afspraken in die agenda zichtbaar voor het hele team.",
    keywords: ['agenda hernoemen', 'agenda kleur', 'agenda naam', 'agenda delen'],
    input: {
      source_id: { type: 'string', description: 'Id van de agenda (uit calendar_source.list).' },
      name: { type: 'string' },
      color: { type: 'string', description: 'Hexkleur, bv. #FFD966.' },
      visibility: { type: 'string', enum: [...VISIBILITY] },
      sync_enabled: { type: 'boolean', description: 'Agenda tonen in de agendaweergave.' },
    },
    required: ['source_id'],
    async plan(ctx, input) {
      const sourceId = id(input, 'source_id');
      const src = await source(ctx, sourceId);
      if (src.provider !== 'native') throw new ActionError(`"${src.name}" is geen eigen ResoFly-agenda; gebruik hiervoor \`calendar_source.set_sharing\`.`);
      assertOwner(ctx, src);

      const patch: Record<string, unknown> = {};
      const name = optStr(input, 'name', 120);
      if (name && name !== src.name) patch.name = name;
      const color = optStr(input, 'color', 9);
      if (color) {
        if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ActionError('Geef de kleur als hexcode, bijvoorbeeld #FFD966.');
        patch.color = color;
      }
      const visibility = optChoice(input, 'visibility', VISIBILITY);
      if (visibility && visibility !== src.visibility) patch.visibility = visibility;
      if (typeof input.sync_enabled === 'boolean' && input.sync_enabled !== src.sync_enabled) patch.sync_enabled = input.sync_enabled;
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');

      const opening = patch.visibility === 'organization';
      return {
        title: `Agenda aanpassen: ${src.name}`,
        sub: joinShort([
          patch.name ? `nieuwe naam "${patch.name}"` : null,
          patch.color ? `kleur ${patch.color}` : null,
          patch.visibility ? (opening ? 'wordt gedeeld met het team' : 'wordt weer privé') : null,
          patch.sync_enabled === true ? 'wordt getoond' : patch.sync_enabled === false ? 'wordt verborgen' : null,
        ]),
        warning: opening ? 'Alle afspraken in deze agenda worden hierna zichtbaar voor iedereen in de organisatie, ook de bestaande.' : undefined,
        risk: opening ? 'high' : 'normal',
        kind: 'agenda',
        payload: { source_id: sourceId, name: src.name, patch },
      };
    },
  },

  {
    id: 'calendar_source.set_sharing',
    label: 'Agenda tonen, delen met het team of schrijven aanzetten',
    module: 'calendar',
    kind: 'write',
    description:
      "Zet per agenda de drie schakelaars om: `sync_enabled` (staat hij in de agendaweergave), `visibility` (privé of gedeeld met de organisatie) en `write_enabled` (mag ResoFly erin schrijven). " +
      "Werkt op elke soort agenda — ResoFly, Google, Microsoft en agenda's via een link — maar alleen op de agenda's die jij zelf gekoppeld hebt. " +
      "Delen is de zwaarste: daarmee ziet het hele team de titels en tijden van alles in die agenda. Een agenda uitzetten met `sync_enabled: false` is de zachte manier om hem uit beeld te halen zonder iets te verliezen.",
    keywords: ['agenda delen', 'agenda tonen', 'agenda verbergen', 'privé', 'zichtbaar', 'schrijven', 'sync', 'uitzetten'],
    input: {
      source_id: { type: 'string', description: 'Id van de agenda (uit calendar_source.list).' },
      sync_enabled: { type: 'boolean', description: 'Tonen in de agendaweergave.' },
      visibility: { type: 'string', enum: [...VISIBILITY], description: "private = alleen jij, organization = het hele team ziet de items." },
      write_enabled: { type: 'boolean', description: 'Mag ResoFly afspraken in deze agenda aanmaken en wijzigen?' },
    },
    required: ['source_id'],
    async plan(ctx, input) {
      const sourceId = id(input, 'source_id');
      const src = await source(ctx, sourceId);
      assertOwner(ctx, src);

      const patch: Record<string, unknown> = {};
      if (typeof input.sync_enabled === 'boolean' && input.sync_enabled !== src.sync_enabled) patch.sync_enabled = input.sync_enabled;
      if (typeof input.write_enabled === 'boolean' && input.write_enabled !== src.write_enabled) patch.write_enabled = input.write_enabled;
      const visibility = optChoice(input, 'visibility', VISIBILITY);
      if (visibility && visibility !== src.visibility) patch.visibility = visibility;
      if (Object.keys(patch).length === 0) throw new ActionError(`Bij "${src.name}" staat alles al zo.`);
      if (patch.write_enabled === true && src.provider === 'ics') {
        throw new ActionError(`"${src.name}" is een agenda via een link en is altijd alleen-lezen.`);
      }

      const opening = patch.visibility === 'organization';
      return {
        title: `Agenda-instelling wijzigen: ${src.name}`,
        sub: joinShort([
          patch.sync_enabled === true ? 'wordt getoond' : patch.sync_enabled === false ? 'wordt verborgen' : null,
          patch.visibility ? (opening ? 'wordt gedeeld met het team' : 'wordt weer privé') : null,
          patch.write_enabled === true ? 'schrijven aan' : patch.write_enabled === false ? 'schrijven uit' : null,
        ]),
        warning: opening ? 'Iedereen in de organisatie ziet hierna de afspraken in deze agenda — ook de afspraken die er al in staan.' : undefined,
        risk: opening ? 'high' : 'normal',
        kind: 'agenda',
        payload: { source_id: sourceId, name: src.name, patch },
      };
    },
  },

  {
    id: 'calendar_source.refresh_provider',
    label: "Agenda's opnieuw ophalen bij Google of Microsoft",
    module: 'calendar',
    kind: 'write',
    description:
      "Vraagt bij een gekoppeld Google- of Microsoft-account opnieuw op wélke agenda's er zijn. Gebruik dit als er bij de provider een agenda is bijgekomen of hernoemd en die hier nog niet in de lijst staat. " +
      "Dit haalt geen afspraken op (die worden altijd live opgehaald) en verandert niets aan je instellingen. Zoek het `connection_id` met `calendar_source.list`.",
    keywords: ["agenda's vernieuwen", 'opnieuw ophalen', 'synchroniseren', 'google', 'microsoft', 'outlook', 'koppeling'],
    input: { connection_id: { type: 'string', description: 'Id van de accountkoppeling (uit calendar_source.list).' } },
    required: ['connection_id'],
    async plan(ctx, input) {
      const connectionId = id(input, 'connection_id');
      const connection = await row<{ provider: string; provider_account_email: string | null; user_id: string; status: string }>(
        ctx, 'calendar_connections', connectionId, 'provider, provider_account_email, user_id, status', 'Agendakoppeling');
      if (connection.user_id !== ctx.userId) throw new ActionError('Alleen degene die dit account gekoppeld heeft, kan het verversen.');
      if (connection.status !== 'active') {
        throw new ActionError(`Deze koppeling staat op "${connection.status}". Koppel het account eerst opnieuw in het agendascherm.`);
      }
      return {
        title: `Agenda's opnieuw ophalen bij ${connection.provider === 'google' ? 'Google' : 'Microsoft'}`,
        sub: joinShort([connection.provider_account_email, 'alleen de agendalijst, niet de afspraken']),
        kind: 'agenda',
        payload: { connection_id: connectionId, account: connection.provider_account_email },
      };
    },
  },

  {
    id: 'calendar_source.subscribe_ics',
    label: 'Agenda via een iCal/ICS-link toevoegen',
    module: 'calendar',
    kind: 'write',
    description:
      "Abonneert op een externe agenda via een openbare .ics-link (iCal/webcal) — bijvoorbeeld een feestdagenagenda, een verenigingsagenda of de agenda van een opdrachtgever. De feed wordt meteen opgehaald en daarna periodiek ververst. " +
      "Zo'n agenda is ALTIJD alleen-lezen: je kunt er niets in plannen. Alleen https-links op de standaardpoort worden geaccepteerd; interne adressen worden geweigerd.",
    keywords: ['ics', 'ical', 'webcal', 'agenda via link', 'abonneren', 'externe agenda', 'feed', 'feestdagen'],
    input: {
      url: { type: 'string', description: 'De https-link naar het .ics-bestand (een webcal://-link mag ook).' },
      name: { type: 'string', description: 'Hoe de agenda in de lijst komt te heten.' },
      color: { type: 'string', description: 'Hexkleur, bv. #0891b2.' },
      visibility: { type: 'string', enum: [...VISIBILITY], description: 'Standaard private.' },
    },
    required: ['url', 'name'],
    async plan(ctx, input) {
      const raw = str(input, 'url', 2000);
      const normalized = raw.replace(/^webcal:\/\//i, 'https://');
      let parsed: URL;
      try { parsed = new URL(normalized); } catch { throw new ActionError('Dat is geen geldige link.'); }
      if (parsed.protocol !== 'https:') throw new ActionError('Alleen https-agendalinks worden geaccepteerd (webcal:// mag, die wordt https).');
      const name = str(input, 'name', 120);
      const color = optStr(input, 'color', 9);
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new ActionError('Geef de kleur als hexcode, bijvoorbeeld #0891b2.');
      const visibility = optChoice(input, 'visibility', VISIBILITY) ?? 'private';

      const { data: existing } = await orgQuery(ctx, 'calendar_sources', 'id, name')
        .eq('provider', 'ics').eq('feed_url', normalized).maybeSingle();
      if (existing) throw new ActionError(`Deze link staat al in de lijst als "${existing.name}".`);

      return {
        title: `Agenda via link toevoegen: ${name}`,
        sub: joinShort([parsed.hostname, 'alleen-lezen', visibility === 'organization' ? 'gedeeld met het team' : 'privé']),
        warning: `De feed wordt bij ${parsed.hostname} opgehaald en daarna periodiek opnieuw bevraagd.`,
        kind: 'agenda',
        payload: { url: normalized, name, color, visibility, host: parsed.hostname },
      };
    },
  },

  {
    id: 'calendar_source.refresh_ics',
    label: 'Agenda via een link nu opnieuw ophalen',
    module: 'calendar',
    kind: 'write',
    description:
      "Haalt de .ics-feed van een agenda-via-link direct opnieuw op, zonder te wachten op de periodieke verversing. Gebruik dit als er bij de bron iets is gewijzigd dat hier nog niet zichtbaar is, of nadat een eerdere ophaalpoging misging (zie `feed_last_error` in `calendar_source.list`).",
    keywords: ['ververs', 'ics', 'ical', 'opnieuw ophalen', 'feed', 'bijwerken'],
    input: { source_id: { type: 'string', description: 'Id van de agenda-via-link (uit calendar_source.list).' } },
    required: ['source_id'],
    async plan(ctx, input) {
      const sourceId = id(input, 'source_id');
      const src = await source(ctx, sourceId);
      if (src.provider !== 'ics') throw new ActionError(`"${src.name}" is geen agenda via een link.`);
      assertOwner(ctx, src);
      let host: string | null = null;
      try { host = src.feed_url ? new URL(src.feed_url).hostname : null; } catch { host = null; }
      return {
        title: `Agenda opnieuw ophalen: ${src.name}`,
        sub: joinShort([host, 'de items uit deze feed worden vervangen door wat er nu bij de bron staat']),
        kind: 'agenda',
        payload: { source_id: sourceId, name: src.name },
      };
    },
  },

  // ── Afspraak: koppeling, videocall en genodigden ──────────────────────────
  {
    id: 'calendar_link.list',
    label: 'Aan klant of project gekoppelde afspraken bekijken',
    module: 'calendar',
    kind: 'read',
    description:
      'Geeft de agenda-items die aan een klant en/of project gekoppeld zijn, met per koppeling of hij meetelt voor de urenregistratie en hoeveel minuten daar dan uit voortkomen. ' +
      'Gebruik dit om het `link_id` te vinden dat `calendar_event.set_link` nodig heeft, of om te zien welke afspraken nog niet op een project geboekt staan.',
    keywords: ['koppeling', 'gekoppeld', 'klant', 'project', 'urenregistratie', 'agenda-item', 'afspraak'],
    input: {
      client_id: { type: 'string', description: 'Alleen koppelingen van deze klant.' },
      project_id: { type: 'string', description: 'Alleen koppelingen van dit project.' },
      from: { type: 'string', description: 'Vanaf welke datum de afspraak begint (JJJJ-MM-DD).' },
      to: { type: 'string', description: 'Tot en met welke datum (JJJJ-MM-DD).' },
      limit: { type: 'number', description: 'Maximaal aantal koppelingen (standaard 25).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
      let query = orgQuery(ctx, 'calendar_event_links',
        'id, provider, calendar_source_id, provider_event_id, event_starts_at, event_ends_at, event_all_day, event_title_snapshot, client_id, project_id, track_time')
        .order('event_starts_at', { ascending: false }).limit(limit);
      const clientId = optId(input, 'client_id');
      if (clientId) query = query.eq('client_id', clientId);
      const projectId = optId(input, 'project_id');
      if (projectId) query = query.eq('project_id', projectId);
      const from = input.from ? isoDate(input, 'from') : null;
      if (from) query = query.gte('event_starts_at', `${from}T00:00:00Z`);
      const to = input.to ? isoDate(input, 'to') : null;
      if (to) query = query.lte('event_starts_at', `${to}T23:59:59Z`);
      const { data, error } = await query;
      if (error) throw new ActionError(`Koppelingen ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];
      if (rows.length === 0) return { count: 0, links: [] };

      // De afgeleide urenpost hangt aan de koppeling; die erbij zetten scheelt een
      // tweede vraag als iemand wil weten of het loggen ook echt gebeurd is.
      const { data: entries } = await orgQuery(ctx, 'time_entries', 'calendar_event_link_id, minutes, billable')
        .in('calendar_event_link_id', rows.map((r) => String(r.id)));
      const byLink = new Map<string, Record<string, unknown>>(
        (entries ?? []).map((e: Record<string, unknown>) => [String(e.calendar_event_link_id), e]));

      return {
        count: rows.length,
        links: rows.map((r) => {
          const entry = byLink.get(String(r.id));
          return {
            link_id: r.id,
            title: r.event_title_snapshot ?? '(titel niet bewaard — privé-agenda)',
            provider: r.provider,
            source_id: r.calendar_source_id,
            starts_at: r.event_starts_at,
            ends_at: r.event_ends_at,
            all_day: r.event_all_day,
            client_id: r.client_id,
            project_id: r.project_id,
            track_time: r.track_time,
            logged_minutes: entry ? entry.minutes : null,
            logged_billable: entry ? entry.billable : null,
          };
        }),
      };
    },
  },

  {
    id: 'calendar_event.set_link',
    label: 'Afspraak aan een klant of project koppelen (en uren laten meetellen)',
    module: 'calendar',
    kind: 'write',
    description:
      'Hangt een agenda-item aan een klant en/of een project, zodat je er notities en documenten bij kunt maken en de tijd automatisch als uren geboekt wordt. ' +
      'Geef `link_id` als er al een koppeling is (uit `calendar_link.list`) — wat je dan weglaat blijft staan, dus zo kun je ook alleen `track_time` omzetten. ' +
      'Is er nog geen koppeling, geef dan `native_event_id` (het veld `event_id` uit `list_calendar_events`); dat kan alleen bij een ResoFly-afspraak, want een Google- of Microsoft-item staat niet in onze database. ' +
      'Met `track_time` aan maakt de database van de duur van de afspraak automatisch een urenpost — dat werkt niet bij een hele-dag-afspraak. Minstens één van klant of project moet ingevuld blijven.',
    keywords: ['koppelen', 'klant', 'project', 'afspraak', 'agenda-item', 'uren', 'urenregistratie', 'track time', 'declarabel'],
    input: {
      link_id: { type: 'string', description: 'Id van een bestaande koppeling (uit calendar_link.list).' },
      native_event_id: { type: 'string', description: 'Id van een ResoFly-afspraak (het veld event_id uit list_calendar_events). Alleen nodig als er nog geen koppeling is.' },
      client_id: { type: 'string', description: 'Klant om aan te koppelen.' },
      project_id: { type: 'string', description: 'Project om aan te koppelen; de klant wordt daar niet automatisch uit afgeleid, geef hem er zo nodig bij.' },
      track_time: { type: 'boolean', description: 'Telt deze afspraak mee voor de urenregistratie? Standaard blijft de huidige stand staan (nieuw: aan).' },
    },
    async plan(ctx, input) {
      const linkId = optId(input, 'link_id');
      const eventId = optId(input, 'native_event_id');
      if (!linkId && !eventId) throw new ActionError('Geef `link_id` van een bestaande koppeling, of `native_event_id` van een ResoFly-afspraak.');

      let base: {
        provider: string; calendar_source_id: string; provider_event_id: string;
        event_starts_at: string; event_ends_at: string | null; event_all_day: boolean;
        event_title_snapshot: string | null; client_id: string | null; project_id: string | null; track_time: boolean;
      };
      let title: string;

      if (linkId) {
        const link = await row<typeof base & { id: string }>(ctx, 'calendar_event_links', linkId,
          'provider, calendar_source_id, provider_event_id, event_starts_at, event_ends_at, event_all_day, event_title_snapshot, client_id, project_id, track_time',
          'Koppeling');
        base = link;
        title = link.event_title_snapshot ?? 'de afspraak';
      } else {
        const { event, src } = await nativeEvent(ctx, eventId as string);
        base = {
          provider: 'native', calendar_source_id: src.id, provider_event_id: event.uid,
          event_starts_at: event.starts_at, event_ends_at: event.ends_at, event_all_day: event.all_day,
          // De koppeltabel is org-breed leesbaar; van een privé-agenda bewaren we de titel niet.
          event_title_snapshot: src.visibility === 'organization' ? event.title : null,
          client_id: null, project_id: null, track_time: true,
        };
        title = event.title || 'de afspraak';
      }

      const clientId = input.client_id !== undefined ? optId(input, 'client_id') : base.client_id;
      const projectId = input.project_id !== undefined ? optId(input, 'project_id') : base.project_id;
      if (!clientId && !projectId) {
        throw new ActionError('Een koppeling heeft minstens een klant of een project nodig. Ontkoppelen doe je in het agendascherm.');
      }
      const trackTime = typeof input.track_time === 'boolean' ? input.track_time : base.track_time;

      let clientName: string | null = null;
      if (clientId) clientName = (await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant')).name;
      let projectName: string | null = null;
      if (projectId) {
        const project = await row<{ name: string; client_id: string | null }>(ctx, 'projects', projectId, 'name, client_id', 'Project');
        if (clientId && project.client_id && project.client_id !== clientId) {
          throw new ActionError(`Project "${project.name}" hoort bij een andere klant.`);
        }
        projectName = project.name;
      }

      const unchanged = clientId === base.client_id && projectId === base.project_id && trackTime === base.track_time;
      if (linkId && unchanged) throw new ActionError('Die koppeling staat al precies zo.');

      // De DB-trigger maakt alleen een urenpost van een afspraak met een eindtijd die
      // niet de hele dag beslaat; dat hier zeggen scheelt een uitblijvende urenpost.
      const minutes = base.event_ends_at && !base.event_all_day
        ? Math.max(0, Math.round((new Date(base.event_ends_at).getTime() - new Date(base.event_starts_at).getTime()) / 60000))
        : 0;
      const hoursNote = !trackTime
        ? 'telt niet mee voor de uren'
        : base.event_all_day
          ? 'hele dag — hier komt geen urenpost uit'
          : minutes > 0 ? `${minutes} min wordt als uren geboekt` : 'geen duur bekend';

      return {
        title: `Afspraak koppelen: ${title}`,
        sub: joinShort([nlMoment(base.event_starts_at), clientName, projectName ? `project ${projectName}` : null, hoursNote]),
        kind: 'agenda',
        payload: {
          event_title: title,
          client_name: clientName,
          link: {
            provider: base.provider,
            calendar_source_id: base.calendar_source_id,
            provider_event_id: base.provider_event_id,
            event_starts_at: base.event_starts_at,
            event_ends_at: base.event_ends_at,
            event_all_day: base.event_all_day,
            event_title_snapshot: base.event_title_snapshot,
            client_id: clientId,
            project_id: projectId,
            track_time: trackTime,
          },
        },
      };
    },
  },

  {
    id: 'calendar_event.set_meeting_url',
    label: 'Eigen videocall-link op een afspraak zetten',
    module: 'calendar',
    kind: 'write',
    description:
      'Zet een zelf gekozen videocall-link (Google Meet, Teams, Zoom of iets anders) op een ResoFly-afspraak, of haalt hem er weer af door `meeting_url` leeg te laten. Alleen http(s)-links worden geaccepteerd. ' +
      'Werkt op afspraken in een ResoFly-agenda (het veld `event_id` uit `list_calendar_events`); voor een Google- of Microsoft-item zet je de link in het agendascherm zelf. ' +
      'Staan er genodigden op de afspraak, dan krijgen die opnieuw een uitnodiging met de bijgewerkte gegevens.',
    keywords: ['videocall', 'meet', 'teams', 'zoom', 'videovergadering', 'belafspraak', 'link', 'online'],
    input: {
      native_event_id: { type: 'string', description: 'Id van de ResoFly-afspraak (het veld event_id uit list_calendar_events).' },
      meeting_url: { type: 'string', description: 'De http(s)-link naar de videocall. Leeg laten haalt de link eraf.' },
    },
    required: ['native_event_id'],
    async plan(ctx, input) {
      const eventId = id(input, 'native_event_id');
      const { event, src } = await nativeEvent(ctx, eventId);
      if (event.recurs) {
        throw new ActionError(`"${event.title}" is een herhalende afspraak; die pas je aan in het agendascherm, anders gaat de herhaling verloren.`);
      }
      const url = optStr(input, 'meeting_url', 2048);
      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
        } catch { throw new ActionError('Geef een geldige http(s)-link naar de videocall.'); }
      }
      if ((event.meeting_url ?? null) === (url ?? null)) throw new ActionError('Die link staat er al op.');
      const attendees = await attendeesOf(ctx, event.id);

      return {
        title: url ? `Videocall-link op "${event.title}" zetten` : `Videocall-link van "${event.title}" weghalen`,
        sub: joinShort([nlMoment(event.starts_at), src.name, url ? new URL(url).hostname : 'geen link meer']),
        warning: attendees.length
          ? `De ${attendees.length} genodigde${attendees.length === 1 ? '' : 'n'} krijgen een bijgewerkte uitnodiging per e-mail.`
          : undefined,
        risk: attendees.length ? 'high' : 'normal',
        kind: 'agenda',
        payload: {
          native_event_id: event.id,
          source_id: src.id,
          event_title: event.title,
          event: {
            sourceId: src.id,
            title: event.title,
            description: event.description,
            location: event.location,
            startsAt: event.starts_at,
            endsAt: event.ends_at,
            allDay: event.all_day,
            meetingUrl: url,
            // Bestaande genodigden meegeven: laat je ze weg, dan worden ze verwijderd
            // en krijgen ze een afzegging.
            attendees: attendees.map((a) => ({ email: a.email, name: a.name, role: a.role })),
          },
        },
      };
    },
  },

  {
    id: 'calendar_event.list_attendees',
    label: 'Zien wie een afspraak heeft geaccepteerd of afgezegd',
    module: 'calendar',
    kind: 'read',
    description:
      'Geeft de genodigden van een ResoFly-afspraak met hun RSVP-status: geaccepteerd, geweigerd, onder voorbehoud of nog geen antwoord, plus wanneer ze zijn uitgenodigd en wanneer ze reageerden. ' +
      'Zoek de afspraak eerst met `list_calendar_events` en gebruik het veld `event_id`.',
    keywords: ['genodigden', 'rsvp', 'aanwezig', 'geaccepteerd', 'afgezegd', 'antwoord', 'deelnemers', 'uitnodiging'],
    input: { native_event_id: { type: 'string', description: 'Id van de ResoFly-afspraak (het veld event_id uit list_calendar_events).' } },
    required: ['native_event_id'],
    async read(ctx, input) {
      const eventId = id(input, 'native_event_id');
      const { event } = await nativeEvent(ctx, eventId);
      const { data, error } = await orgQuery(ctx, 'calendar_event_attendees',
        'email, display_name, role, is_organizer, status, invited_at, responded_at')
        .eq('event_id', event.id).order('email', { ascending: true });
      if (error) throw new ActionError(`Genodigden ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];
      const count = (status: string) => rows.filter((r) => r.status === status).length;
      return {
        event: { title: event.title, starts_at: event.starts_at, ends_at: event.ends_at },
        totals: {
          accepted: count('accepted'), declined: count('declined'),
          tentative: count('tentative'), no_answer: count('needs-action'),
        },
        attendees: rows,
      };
    },
  },

  {
    id: 'calendar_event.set_attendees',
    label: 'Genodigden op een afspraak zetten (verstuurt uitnodigingen)',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description:
      'Vervangt de genodigdenlijst van een ResoFly-afspraak door precies de adressen die je opgeeft. Iedereen op de lijst krijgt een uitnodiging per e-mail (met .ics-bijlage), en wie er ÁF gaat krijgt een afzegging. ' +
      'Wil je iemand toevoegen, geef dan de bestaande genodigden er ook bij — vraag ze eerst op met `calendar_event.list_attendees`. Een lege lijst zegt iedereen af. ' +
      'Werkt alleen op afspraken in een ResoFly-agenda; genodigden op een Google- of Microsoft-item beheer je bij die provider.',
    keywords: ['genodigden', 'uitnodigen', 'deelnemers', 'uitnodiging', 'invite', 'aanwezigen', 'afzeggen'],
    input: {
      native_event_id: { type: 'string', description: 'Id van de ResoFly-afspraak (het veld event_id uit list_calendar_events).' },
      attendees: {
        type: 'array',
        description: 'De VOLLEDIGE lijst genodigden na deze wijziging.',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string', enum: ['req', 'opt'], description: 'req = verwacht, opt = optioneel. Standaard req.' },
          },
          required: ['email'],
        },
      },
    },
    required: ['native_event_id', 'attendees'],
    async plan(ctx, input) {
      const eventId = id(input, 'native_event_id');
      const { event, src } = await nativeEvent(ctx, eventId);
      if (event.recurs) {
        throw new ActionError(`"${event.title}" is een herhalende afspraak; genodigden daarvan beheer je in het agendascherm.`);
      }
      const raw = Array.isArray(input.attendees) ? input.attendees as unknown[] : [];
      const seen = new Set<string>();
      const wanted: Array<{ email: string; name: string | null; role: string }> = [];
      for (const item of raw.slice(0, 100)) {
        const record = (item && typeof item === 'object') ? item as Record<string, unknown> : { email: item };
        const email = String(record.email ?? '').trim().toLowerCase();
        if (!isEmail(email)) throw new ActionError(`"${email || item}" is geen geldig e-mailadres.`);
        if (seen.has(email)) continue;
        seen.add(email);
        wanted.push({ email, name: record.name ? String(record.name).trim().slice(0, 120) : null, role: record.role === 'opt' ? 'opt' : 'req' });
      }

      const current = await attendeesOf(ctx, event.id);
      const currentEmails = new Set(current.map((a) => a.email.toLowerCase()));
      const added = wanted.filter((a) => !currentEmails.has(a.email));
      const removed = current.filter((a) => !seen.has(a.email.toLowerCase()));
      if (added.length === 0 && removed.length === 0) throw new ActionError('Die genodigden staan er al precies zo op.');

      return {
        title: `Genodigden van "${event.title}" bijwerken`,
        sub: joinShort([
          nlMoment(event.starts_at),
          src.name,
          added.length ? `+${added.length}: ${added.map((a) => a.email).join(', ')}` : null,
          removed.length ? `−${removed.length}: ${removed.map((a) => a.email).join(', ')}` : null,
        ], 140),
        warning: `Alle ${wanted.length} genodigde${wanted.length === 1 ? '' : 'n'} krijgen een uitnodiging per e-mail${removed.length ? `, en ${removed.length} afgevoerde genodigde${removed.length === 1 ? '' : 'n'} een afzegging` : ''}. Dat is post die echt de deur uit gaat.`,
        kind: 'mail',
        payload: {
          native_event_id: event.id,
          event_title: event.title,
          added: added.map((a) => a.email),
          removed: removed.map((a) => a.email),
          event: {
            sourceId: src.id,
            title: event.title,
            description: event.description,
            location: event.location,
            startsAt: event.starts_at,
            endsAt: event.ends_at,
            allDay: event.all_day,
            meetingUrl: event.meeting_url,
            attendees: wanted.map((a) => ({ email: a.email, name: a.name, role: a.role })),
          },
        },
      };
    },
  },

  // ── Notities bij een afspraak ─────────────────────────────────────────────
  {
    id: 'note.link_to_event',
    label: 'Bestaande notitie aan een afspraak hangen',
    module: 'content',
    kind: 'write',
    description:
      'Koppelt een notitie die al bestaat aan een ResoFly-afspraak, zodat hij in het detailpaneel van die afspraak staat. De notitie zelf verandert niet. Voor een nieuwe notitie gebruik je `propose_note`. ' +
      'Kan alleen bij een afspraak in een agenda die met de organisatie gedeeld is — anders zou de notitie naar een agenda-item verwijzen dat je collega\'s niet mogen zien.',
    keywords: ['notitie koppelen', 'notitie', 'afspraak', 'agenda-item', 'vastleggen', 'verslag'],
    input: {
      note_id: { type: 'string', description: 'Id van de notitie (uit list_content).' },
      native_event_id: { type: 'string', description: 'Id van de ResoFly-afspraak (het veld event_id uit list_calendar_events).' },
    },
    required: ['note_id', 'native_event_id'],
    async plan(ctx, input) {
      const noteId = id(input, 'note_id');
      const eventId = id(input, 'native_event_id');
      const note = await row<{ title: string }>(ctx, 'notes', noteId, 'title', 'Notitie');
      const { event, src } = await nativeEvent(ctx, eventId);
      if (src.visibility !== 'organization') {
        throw new ActionError(`"${src.name}" is een privé-agenda. Deel de agenda met de organisatie voordat je er notities aan hangt.`);
      }
      const { data: existing } = await orgQuery(ctx, 'note_calendar_links', 'id')
        .eq('note_id', noteId).eq('calendar_source_id', src.id)
        .eq('provider_event_id', event.uid).eq('event_starts_at', event.starts_at).maybeSingle();
      if (existing) throw new ActionError(`"${note.title}" hangt al aan deze afspraak.`);

      return {
        title: `Notitie koppelen aan "${event.title}"`,
        sub: joinShort([note.title, nlMoment(event.starts_at), src.name]),
        kind: 'work',
        payload: {
          note_id: noteId,
          note_title: note.title,
          event_title: event.title,
          link: {
            provider: 'native',
            calendar_source_id: src.id,
            provider_event_id: event.uid,
            event_starts_at: event.starts_at,
            event_ends_at: event.ends_at,
            event_title_snapshot: event.title,
            event_location_snapshot: event.location,
            event_html_link: null,
            visibility_snapshot: 'organization',
            is_private_masked_snapshot: false,
          },
        },
      };
    },
  },

  {
    id: 'note.unlink_from_event',
    label: 'Notitie loskoppelen van een afspraak',
    module: 'content',
    kind: 'write',
    description:
      'Haalt de koppeling tussen een notitie en een agenda-item weg. De notitie zelf blijft gewoon bestaan in het dossier — alleen het verband met de afspraak verdwijnt, en dat kun je later weer leggen met `note.link_to_event`. ' +
      'Zoek de koppeling met `note.list_event_links`.',
    keywords: ['loskoppelen', 'ontkoppelen', 'notitie', 'afspraak', 'verband weghalen'],
    input: { link_id: { type: 'string', description: 'Id van de koppeling (uit note.list_event_links).' } },
    required: ['link_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await row<{ note_id: string; event_title_snapshot: string | null; event_starts_at: string }>(
        ctx, 'note_calendar_links', linkId, 'note_id, event_title_snapshot, event_starts_at', 'Koppeling');
      const note = await row<{ title: string }>(ctx, 'notes', link.note_id, 'title', 'Notitie');
      return {
        title: `Notitie loskoppelen: ${note.title}`,
        sub: joinShort([`van "${link.event_title_snapshot ?? 'de afspraak'}"`, nlMoment(link.event_starts_at), 'de notitie zelf blijft bestaan']),
        kind: 'work',
        payload: { link_id: linkId, note_title: note.title },
      };
    },
  },

  {
    id: 'note.list_event_links',
    label: 'Notities bekijken die aan een afspraak hangen',
    module: 'content',
    kind: 'read',
    description:
      'Geeft de koppelingen tussen notities en agenda-items, met het `link_id` dat `note.unlink_from_event` nodig heeft. Filter op één notitie of op één ResoFly-afspraak.',
    keywords: ['gekoppelde notities', 'notitie', 'afspraak', 'verslag', 'koppeling'],
    input: {
      note_id: { type: 'string', description: 'Alleen koppelingen van deze notitie.' },
      native_event_id: { type: 'string', description: 'Alleen koppelingen van deze ResoFly-afspraak.' },
      limit: { type: 'number', description: 'Maximaal aantal (standaard 25).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
      let query = orgQuery(ctx, 'note_calendar_links',
        'id, note_id, provider, calendar_source_id, provider_event_id, event_starts_at, event_title_snapshot')
        .order('event_starts_at', { ascending: false }).limit(limit);
      const noteId = optId(input, 'note_id');
      if (noteId) query = query.eq('note_id', noteId);
      const eventId = optId(input, 'native_event_id');
      if (eventId) {
        const { event, src } = await nativeEvent(ctx, eventId);
        query = query.eq('calendar_source_id', src.id).eq('provider_event_id', event.uid).eq('event_starts_at', event.starts_at);
      }
      const { data, error } = await query;
      if (error) throw new ActionError(`Koppelingen ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];
      if (rows.length === 0) return { count: 0, links: [] };
      const { data: notes } = await orgQuery(ctx, 'notes', 'id, title').in('id', rows.map((r) => String(r.note_id)));
      const titles = new Map((notes ?? []).map((n: Record<string, unknown>) => [String(n.id), String(n.title)]));
      return {
        count: rows.length,
        links: rows.map((r) => ({
          link_id: r.id,
          note_id: r.note_id,
          note_title: titles.get(String(r.note_id)) ?? null,
          event_title: r.event_title_snapshot,
          event_starts_at: r.event_starts_at,
        })),
      };
    },
  },

  // ── Boekingslinks ─────────────────────────────────────────────────────────
  {
    id: 'booking_link.list_slots',
    label: 'Aangeboden tijdblokken en boekingen van een boekingslink bekijken',
    module: 'calendar',
    kind: 'read',
    description:
      'Geeft van één boekingslink de aangeboden tijdblokken (met hun status: open, bijna geboekt, geboekt of geannuleerd) en de boekingen die klanten er al mee gemaakt hebben. ' +
      'Gebruik dit om het `slot_id` te vinden voor `booking_slot.remove` of het `booking_id` voor `booking.cancel`. Voor het overzicht van álle boekingslinks gebruik je `list_bookings`.',
    keywords: ['boekingslink', 'tijdblok', 'slot', 'beschikbaar', 'geboekt', 'boeking', 'calendly'],
    input: {
      link_id: { type: 'string', description: 'Id van de boekingslink (uit list_bookings).' },
      include_past: { type: 'boolean', description: 'Ook blokken die al voorbij zijn. Standaard uit.' },
    },
    required: ['link_id'],
    async read(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await bookingLink(ctx, linkId);
      let slotQuery = orgQuery(ctx, 'meeting_booking_slots', 'id, starts_at, ends_at, status')
        .eq('booking_link_id', linkId).order('starts_at', { ascending: true }).limit(300);
      if (!bool(input, 'include_past', false)) slotQuery = slotQuery.gte('ends_at', new Date().toISOString());
      const { data: slots, error } = await slotQuery;
      if (error) throw new ActionError(`Tijdblokken ophalen mislukt: ${error.message}`);

      const { data: bookings } = await orgQuery(ctx, 'meeting_bookings',
        'id, slot_id, booked_name, booked_email, status, created_at, confirmed_at, cancelled_at')
        .eq('booking_link_id', linkId).order('created_at', { ascending: false }).limit(100);

      return {
        link: {
          link_id: link.id, title: link.title, status: link.status,
          max_total_bookings: link.max_total_bookings, max_per_week: link.max_per_week,
          has_token: Boolean(link.public_token_hash),
        },
        slots: (slots ?? []).map((s: Record<string, unknown>) => ({ slot_id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status })),
        bookings: (bookings ?? []).map((b: Record<string, unknown>) => ({
          booking_id: b.id, slot_id: b.slot_id, name: b.booked_name, email: b.booked_email,
          status: b.status, created_at: b.created_at, confirmed_at: b.confirmed_at, cancelled_at: b.cancelled_at,
        })),
      };
    },
  },

  {
    id: 'booking_link.create',
    label: 'Boekingslink maken zodat een klant zelf een moment kiest',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description:
      'Maakt een boekingslink (zoals Calendly): een openbare pagina waarop een klant uit jouw tijdblokken een moment kiest, waarna de afspraak in de gekozen agenda landt. ' +
      'De link zelf is een geheime token-URL — iedereen die hem heeft kan boeken, tot aan de limieten die je hier zet. Tijdblokken voeg je daarna toe met `booking_slot.add`, versturen doe je met `booking_link.send_mail`. ' +
      'Kies een agenda waarin geschreven mag worden (uit `calendar_source.list`).',
    keywords: ['boekingslink', 'afspraak inplannen', 'calendly', 'zelf plannen', 'boeken', 'tijd kiezen', 'planlink'],
    input: {
      source_id: { type: 'string', description: 'Agenda waarin de geboekte afspraken landen.' },
      title: { type: 'string', description: 'Wat de klant boven de pagina ziet. Standaard "Afspraak inplannen".' },
      client_id: { type: 'string', description: 'Klant waar deze link bij hoort (optioneel, maar nodig om hem later te kunnen mailen zonder adres).' },
      intro_text: { type: 'string', description: 'Tekst boven de tijdblokken op de boekingspagina.' },
      invite_message: { type: 'string', description: 'Tekst in de bevestigingsmail en de agenda-uitnodiging.' },
      meeting_url: { type: 'string', description: 'Vaste videocall-link voor elke boeking (http(s)).' },
      max_total_bookings: { type: 'number', description: 'Hoeveel keer er in totaal via deze link geboekt mag worden. Standaard 1.' },
      max_per_week: { type: 'number', description: 'Maximaal aantal boekingen per week. Standaard 1.' },
      auto_conference: { type: 'boolean', description: 'Laat Google/Microsoft zelf een videovergadering aanmaken bij de boeking. Standaard aan.' },
    },
    required: ['source_id'],
    async plan(ctx, input) {
      const sourceId = id(input, 'source_id');
      const src = await source(ctx, sourceId);
      if (src.provider === 'ics') throw new ActionError(`"${src.name}" is een alleen-lezen agenda via een link; daar kan niet in geboekt worden.`);
      if (src.provider !== 'native' && !src.write_enabled) {
        throw new ActionError(`In "${src.name}" mag ResoFly niet schrijven. Zet dat eerst aan met \`calendar_source.set_sharing\`.`);
      }
      if (src.user_id !== ctx.userId && src.visibility !== 'organization') {
        throw new ActionError(`"${src.name}" is een privé-agenda van iemand anders.`);
      }

      const title = optStr(input, 'title', 160) ?? 'Afspraak inplannen';
      const maxTotal = Math.round(optNum(input, 'max_total_bookings') ?? 1);
      const maxPerWeek = Math.round(optNum(input, 'max_per_week') ?? 1);
      if (maxTotal < 1) throw new ActionError('Het totaal aantal boekingen moet minstens 1 zijn.');
      if (maxPerWeek < 1) throw new ActionError('Het aantal boekingen per week moet minstens 1 zijn.');
      const meetingUrl = optStr(input, 'meeting_url', 2048);
      if (meetingUrl) {
        try {
          const parsed = new URL(meetingUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
        } catch { throw new ActionError('Geef een geldige http(s)-link voor de videocall.'); }
      }
      const clientId = optId(input, 'client_id');
      let clientName: string | null = null;
      if (clientId) clientName = (await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant')).name;

      return {
        title: `Boekingslink maken: ${title}`,
        sub: joinShort([src.name, clientName, `max ${maxTotal} boeking${maxTotal === 1 ? '' : 'en'}`, `max ${maxPerWeek}/week`]),
        warning: 'Er wordt een openbare token-link aangemaakt: iedereen die hem heeft kan zonder inloggen een moment in deze agenda boeken.',
        kind: 'agenda',
        payload: {
          sourceId,
          source_name: src.name,
          clientId,
          client_name: clientName,
          title,
          introText: optStr(input, 'intro_text', 2000),
          inviteMessage: optStr(input, 'invite_message', 2000),
          meetingUrl,
          maxTotalBookings: maxTotal,
          maxPerWeek,
          autoConference: bool(input, 'auto_conference', true),
        },
      };
    },
  },

  {
    id: 'booking_link.update',
    label: 'Boekingslink aanpassen of sluiten',
    module: 'calendar',
    kind: 'write',
    description:
      "Past titel, teksten, videocall-link, limieten, agenda of klant van een bestaande boekingslink aan, of zet hem op 'closed' zodat er niets meer geboekt kan worden (de bestaande boekingen blijven staan). " +
      "Op 'active' zetten stelt hem weer open. Zoek de link met `list_bookings`. Geef alleen wat er verandert.",
    keywords: ['boekingslink aanpassen', 'sluiten', 'dichtzetten', 'heropenen', 'limiet', 'boeking'],
    input: {
      link_id: { type: 'string', description: 'Id van de boekingslink (uit list_bookings).' },
      title: { type: 'string' },
      intro_text: { type: 'string' },
      invite_message: { type: 'string' },
      meeting_url: { type: 'string', description: 'Vaste videocall-link (http(s)).' },
      max_total_bookings: { type: 'number' },
      max_per_week: { type: 'number' },
      auto_conference: { type: 'boolean' },
      status: { type: 'string', enum: [...LINK_STATUS], description: "closed = er kan niet meer geboekt worden, active = weer open." },
      source_id: { type: 'string', description: 'Andere agenda waarin de boekingen moeten landen.' },
      client_id: { type: 'string', description: 'Andere klant koppelen.' },
    },
    required: ['link_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await bookingLink(ctx, linkId);
      const patch: Record<string, unknown> = {};
      const described: string[] = [];

      const title = optStr(input, 'title', 160);
      if (title && title !== link.title) { patch.title = title; described.push(`titel "${title}"`); }
      if (input.intro_text !== undefined) { patch.introText = optStr(input, 'intro_text', 2000); described.push('introtekst'); }
      if (input.invite_message !== undefined) { patch.inviteMessage = optStr(input, 'invite_message', 2000); described.push('uitnodigingstekst'); }
      if (input.meeting_url !== undefined) {
        const meetingUrl = optStr(input, 'meeting_url', 2048);
        if (meetingUrl) {
          try {
            const parsed = new URL(meetingUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
          } catch { throw new ActionError('Geef een geldige http(s)-link voor de videocall.'); }
        }
        patch.meetingUrl = meetingUrl;
        described.push(meetingUrl ? 'videocall-link' : 'videocall-link weg');
      }
      const maxTotal = optNum(input, 'max_total_bookings');
      if (maxTotal !== null) {
        if (Math.round(maxTotal) < 1) throw new ActionError('Het totaal aantal boekingen moet minstens 1 zijn.');
        patch.maxTotalBookings = Math.round(maxTotal);
        described.push(`max ${Math.round(maxTotal)} boekingen`);
      }
      const maxPerWeek = optNum(input, 'max_per_week');
      if (maxPerWeek !== null) {
        if (Math.round(maxPerWeek) < 1) throw new ActionError('Het aantal boekingen per week moet minstens 1 zijn.');
        patch.maxPerWeek = Math.round(maxPerWeek);
        described.push(`max ${Math.round(maxPerWeek)}/week`);
      }
      if (typeof input.auto_conference === 'boolean' && input.auto_conference !== link.auto_conference) {
        patch.autoConference = input.auto_conference;
        described.push(input.auto_conference ? 'videovergadering automatisch' : 'geen automatische videovergadering');
      }
      const status = optChoice(input, 'status', LINK_STATUS);
      if (status && status !== link.status) {
        patch.status = status;
        described.push(status === 'closed' ? 'wordt gesloten' : 'wordt weer opengesteld');
      }
      const sourceId = optId(input, 'source_id');
      if (sourceId && sourceId !== link.source_id) {
        const src = await source(ctx, sourceId);
        if (src.provider === 'ics') throw new ActionError(`"${src.name}" is alleen-lezen; daar kan niet in geboekt worden.`);
        if (src.provider !== 'native' && !src.write_enabled) throw new ActionError(`In "${src.name}" mag ResoFly niet schrijven.`);
        patch.sourceId = sourceId;
        described.push(`agenda ${src.name}`);
      }
      const clientId = optId(input, 'client_id');
      if (clientId && clientId !== link.client_id) {
        const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
        patch.clientId = clientId;
        described.push(`klant ${client.name}`);
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');

      return {
        title: status === 'closed' ? `Boekingslink sluiten: ${link.title}` : `Boekingslink aanpassen: ${link.title}`,
        sub: joinShort(described),
        kind: 'agenda',
        payload: { link_id: linkId, link_title: patch.title ?? link.title, patch },
      };
    },
  },

  {
    id: 'booking_link.regenerate_token',
    label: 'Nieuwe boekings-URL genereren (oude wordt ongeldig)',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description:
      'Geeft een boekingslink een verse geheime URL. Gebruik dit als de oude link bij de verkeerde persoon terecht is gekomen of verlopen is. ' +
      'De eerder gedeelde link werkt daarna NIET meer — wie hem nog had, krijgt een foutmelding. Bestaande boekingen blijven gewoon staan.',
    keywords: ['nieuwe link', 'token', 'vernieuwen', 'ongeldig maken', 'boekingslink', 'verlopen'],
    input: { link_id: { type: 'string', description: 'Id van de boekingslink (uit list_bookings).' } },
    required: ['link_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await bookingLink(ctx, linkId);
      return {
        title: `Nieuwe boekings-URL voor "${link.title}"`,
        sub: link.public_token_hash ? 'de eerder gedeelde link werkt hierna niet meer' : 'deze link had nog geen URL',
        warning: link.public_token_hash
          ? 'De link die je eerder hebt gedeeld wordt hiermee ongeldig. Heeft een klant hem nog openstaan, dan kan hij niet meer boeken.'
          : undefined,
        kind: 'agenda',
        payload: { link_id: linkId, link_title: link.title },
      };
    },
  },

  {
    id: 'booking_link.send_mail',
    label: 'Boekingslink per e-mail naar de klant sturen',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description:
      'Mailt de boekingslink naar de klant, zodat hij zelf een moment kan kiezen. Zonder `email` gaat hij naar het adres van de gekoppelde klant. ' +
      'LET OP: de geheime URL is nergens leesbaar opgeslagen (alleen een hash), dus er wordt eerst een VERSE URL gegenereerd en die wordt verstuurd. Een eerder gedeelde link werkt daarna niet meer. ' +
      'Zorg dat er tijdblokken zijn (`booking_slot.add`) voordat je dit doet — anders staat de klant voor een lege pagina.',
    keywords: ['boekingsmail', 'link mailen', 'versturen', 'klant', 'uitnodiging', 'inplannen'],
    input: {
      link_id: { type: 'string', description: 'Id van de boekingslink (uit list_bookings).' },
      email: { type: 'string', description: 'Ontvanger; weglaten om het e-mailadres van de gekoppelde klant te gebruiken.' },
      name: { type: 'string', description: 'Naam van de ontvanger in de aanhef.' },
    },
    required: ['link_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await bookingLink(ctx, linkId);
      if (link.status !== 'active') throw new ActionError(`"${link.title}" staat op gesloten; zet hem eerst weer open met \`booking_link.update\`.`);

      let email = optStr(input, 'email', 200);
      let name = optStr(input, 'name', 120);
      if (!email && link.client_id) {
        const client = await row<{ name: string; contact_name: string | null; email: string | null }>(
          ctx, 'clients', link.client_id, 'name, contact_name, email', 'Klant');
        email = client.email;
        name = name ?? client.contact_name ?? client.name;
      }
      if (!email || !isEmail(email)) {
        throw new ActionError('Geef een e-mailadres, of koppel eerst een klant met een e-mailadres aan de boekingslink.');
      }

      const { count: openSlots } = await ctx.db.from('meeting_booking_slots')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('booking_link_id', linkId).eq('status', 'open')
        .gte('ends_at', new Date().toISOString());
      if (!openSlots) throw new ActionError(`"${link.title}" heeft geen open tijdblokken meer. Voeg er eerst een paar toe met \`booking_slot.add\`.`);

      return {
        title: `Boekingslink mailen aan ${name ?? email}`,
        sub: joinShort([link.title, `naar ${email}`, `${openSlots} vrije tijdblok${openSlots === 1 ? '' : 'ken'}`]),
        warning: 'De mail gaat echt de deur uit. Er wordt bovendien een verse boekings-URL gemaakt, dus een eerder gedeelde link werkt hierna niet meer.',
        kind: 'mail',
        payload: { link_id: linkId, link_title: link.title, email, name },
      };
    },
  },

  {
    id: 'booking_slot.add',
    label: 'Tijdblokken aan een boekingslink toevoegen',
    module: 'calendar',
    kind: 'write',
    description:
      'Zet één of meer tijdvakken op een boekingslink waaruit de klant kan kiezen. Tijden zijn lokaal (Europe/Amsterdam). ' +
      'De server kijkt bij het opslaan of een blok botst met een bestaande afspraak in dezelfde agenda en waarschuwt daarvoor; hij blokkeert het niet. ' +
      'Reken relatieve datums ("volgende week dinsdag") eerst om naar JJJJ-MM-DD op basis van de datum van vandaag.',
    keywords: ['tijdblok', 'slot', 'beschikbaarheid', 'tijdvak', 'aanbieden', 'boekingslink', 'moment'],
    input: {
      link_id: { type: 'string', description: 'Id van de boekingslink (uit list_bookings).' },
      slots: {
        type: 'array',
        description: 'De aan te bieden tijdvakken.',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'JJJJ-MM-DD (lokale datum).' },
            start_time: { type: 'string', description: 'UU:MM (24-uurs, lokale tijd).' },
            end_time: { type: 'string', description: 'UU:MM.' },
          },
          required: ['date', 'start_time', 'end_time'],
        },
      },
    },
    required: ['link_id', 'slots'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await bookingLink(ctx, linkId);
      const raw = Array.isArray(input.slots) ? input.slots as unknown[] : [];
      if (raw.length === 0) throw new ActionError('Geef minstens één tijdvak.');
      if (raw.length > 100) throw new ActionError('Maximaal 100 tijdvakken tegelijk.');

      const slots: Array<{ startsAt: string; endsAt: string }> = [];
      for (const item of raw) {
        const record = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
        const date = isoDate(record, 'date');
        const startsAt = amsWallToUtcIso(date, hhmm(record, 'start_time'));
        const endsAt = amsWallToUtcIso(date, hhmm(record, 'end_time'));
        if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
          throw new ActionError(`Op ${date} ligt de eindtijd niet na de begintijd.`);
        }
        slots.push({ startsAt, endsAt });
      }
      slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

      // Dubbele blokken op dezelfde link vangen we hier af: de server slaat ze
      // gewoon allebei op en de klant ziet dan twee keer hetzelfde moment.
      const { data: existing } = await orgQuery(ctx, 'meeting_booking_slots', 'starts_at')
        .eq('booking_link_id', linkId).in('status', ['open', 'pending', 'booked']);
      const taken = new Set((existing ?? []).map((s: Record<string, unknown>) => String(s.starts_at)));
      const duplicate = slots.find((s) => taken.has(s.startsAt));
      if (duplicate) throw new ActionError(`Er staat al een tijdblok op ${nlMoment(duplicate.startsAt)}.`);

      return {
        title: `${slots.length} tijdblok${slots.length === 1 ? '' : 'ken'} toevoegen aan "${link.title}"`,
        sub: joinShort(slots.slice(0, 4).map((s) => `${nlMoment(s.startsAt)}–${new Date(s.endsAt).toLocaleTimeString('nl-NL', { timeZone: AMS, hour: '2-digit', minute: '2-digit' })}`).concat(slots.length > 4 ? [`+${slots.length - 4} meer`] : []), 140),
        kind: 'agenda',
        payload: { link_id: linkId, link_title: link.title, slots },
      };
    },
  },

  {
    id: 'booking_slot.remove',
    label: 'Aangeboden tijdblok van een boekingslink halen',
    module: 'calendar',
    kind: 'write',
    description:
      'Haalt één aangeboden tijdvak weg zodat de klant het niet meer kan kiezen. Een blok dat al geboekt is (of waar iemand op dat moment mee bezig is) gaat er niet af — annuleer dan eerst de boeking met `booking.cancel`. ' +
      'Zoek het `slot_id` met `booking_link.list_slots`. Het blok verdwijnt definitief; opnieuw aanbieden doe je met `booking_slot.add`.',
    keywords: ['tijdblok weghalen', 'slot verwijderen', 'niet meer beschikbaar', 'boekingslink', 'intrekken'],
    input: {
      link_id: { type: 'string', description: 'Id van de boekingslink.' },
      slot_id: { type: 'string', description: 'Id van het tijdblok (uit booking_link.list_slots).' },
    },
    required: ['link_id', 'slot_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const slotId = id(input, 'slot_id');
      const link = await bookingLink(ctx, linkId);
      const slot = await row<{ booking_link_id: string; starts_at: string; ends_at: string; status: string }>(
        ctx, 'meeting_booking_slots', slotId, 'booking_link_id, starts_at, ends_at, status', 'Tijdblok');
      if (slot.booking_link_id !== linkId) throw new ActionError('Dat tijdblok hoort bij een andere boekingslink.');
      if (slot.status === 'booked' || slot.status === 'pending') {
        throw new ActionError(`Dat blok is ${slot.status === 'booked' ? 'geboekt' : 'bijna geboekt'}. Annuleer eerst de boeking met \`booking.cancel\`.`);
      }
      return {
        title: `Tijdblok weghalen: ${nlMoment(slot.starts_at)}`,
        sub: joinShort([link.title, 'de klant kan dit moment niet meer kiezen']),
        warning: 'Het tijdblok wordt verwijderd; wil je het later toch weer aanbieden, dan voeg je het opnieuw toe.',
        kind: 'agenda',
        payload: { link_id: linkId, slot_id: slotId, link_title: link.title, starts_at: slot.starts_at },
      };
    },
  },

  {
    id: 'booking.cancel',
    label: 'Boeking van een klant annuleren',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description:
      'Annuleert een afspraak die een klant zelf via een boekingslink heeft gemaakt. Het tijdblok komt weer open te staan en de bijbehorende afspraak wordt uit de agenda gehaald. ' +
      'Dit raakt een afspraak waar de klant op rekent — zeg in je antwoord dat hij daar zelf nog over bericht moet krijgen. Zoek het `booking_id` met `booking_link.list_slots`.',
    keywords: ['boeking annuleren', 'afzeggen', 'afspraak annuleren', 'klant', 'boekingslink'],
    input: { booking_id: { type: 'string', description: 'Id van de boeking (uit booking_link.list_slots).' } },
    required: ['booking_id'],
    async plan(ctx, input) {
      const bookingId = id(input, 'booking_id');
      const booking = await row<{ booking_link_id: string; slot_id: string; booked_name: string | null; booked_email: string; status: string }>(
        ctx, 'meeting_bookings', bookingId, 'booking_link_id, slot_id, booked_name, booked_email, status', 'Boeking');
      if (booking.status === 'cancelled') throw new ActionError('Die boeking is al geannuleerd.');
      const link = await bookingLink(ctx, booking.booking_link_id);
      const slot = await row<{ starts_at: string }>(ctx, 'meeting_booking_slots', booking.slot_id, 'starts_at', 'Tijdblok');
      return {
        title: `Boeking annuleren van ${booking.booked_name || booking.booked_email}`,
        sub: joinShort([link.title, nlMoment(slot.starts_at), 'het tijdblok komt weer vrij']),
        warning: 'De afspraak wordt uit de agenda gehaald. De klant die geboekt heeft, krijgt hier vanuit ResoFly geen bericht over — laat het hem zelf weten.',
        kind: 'agenda',
        payload: { booking_id: bookingId, who: booking.booked_name || booking.booked_email, starts_at: slot.starts_at },
      };
    },
  },

  // ── Opnames en notulen ────────────────────────────────────────────────────
  {
    id: 'meeting_recording.list',
    label: 'Opnames en notulen van vergaderingen bekijken',
    module: 'calendar',
    kind: 'read',
    description:
      'Geeft de opnames die bij afspraken gemaakt zijn: status van de verwerking, of er een transcript en notulen zijn, hoe lang ze zijn, en of de notulen al gemaild zijn en naar wie. ' +
      'Gebruik dit om het `recording_id` te vinden voor `meeting_recording.regenerate_summary`, `meeting_recording.update_transcript` of `meeting_recording.send_summary`. De volledige teksten staan er bewust niet in — die zijn te lang; vraag ze op met `include_text`.',
    keywords: ['opname', 'notulen', 'transcript', 'vergadering', 'samenvatting', 'gesprek', 'meeting'],
    input: {
      client_id: { type: 'string', description: 'Alleen opnames bij deze klant.' },
      project_id: { type: 'string', description: 'Alleen opnames bij dit project.' },
      status: { type: 'string', enum: ['uploaded', 'transcribing', 'transcribed', 'summarizing', 'done', 'error'] },
      include_text: { type: 'boolean', description: 'Ook de notulentekst meesturen (kan lang zijn). Standaard uit.' },
      limit: { type: 'number', description: 'Maximaal aantal opnames (standaard 10).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);
      let query = orgQuery(ctx, 'meeting_recordings',
        'id, event_title_snapshot, client_id, project_id, status, error_message, duration_seconds, language, transcript_text, summary_text, summary_sent_at, summary_recipients, created_at')
        .order('created_at', { ascending: false }).limit(limit);
      const clientId = optId(input, 'client_id');
      if (clientId) query = query.eq('client_id', clientId);
      const projectId = optId(input, 'project_id');
      if (projectId) query = query.eq('project_id', projectId);
      const status = optChoice(input, 'status', ['uploaded', 'transcribing', 'transcribed', 'summarizing', 'done', 'error'] as const);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw new ActionError(`Opnames ophalen mislukt: ${error.message}`);
      const withText = bool(input, 'include_text', false);
      return {
        recordings: (data ?? []).map((r: Record<string, unknown>) => ({
          recording_id: r.id,
          event_title: r.event_title_snapshot,
          client_id: r.client_id,
          project_id: r.project_id,
          status: r.status,
          error_message: r.error_message,
          duration_seconds: r.duration_seconds,
          language: r.language,
          has_transcript: Boolean(r.transcript_text),
          transcript_chars: r.transcript_text ? String(r.transcript_text).length : 0,
          has_summary: Boolean(r.summary_text),
          summary_sent_at: r.summary_sent_at,
          summary_recipients: r.summary_recipients,
          created_at: r.created_at,
          summary_text: withText ? r.summary_text : undefined,
        })),
      };
    },
  },

  {
    id: 'meeting_recording.regenerate_summary',
    label: 'Notulen opnieuw laten schrijven uit het transcript',
    module: 'calendar',
    kind: 'write',
    description:
      'Laat de AI uit het opgeslagen transcript opnieuw notulen maken — samenvatting, besproken punten, besluiten, actiepunten en vervolgafspraken. Gebruik dit als de eerste poging mislukte of nadat je het transcript hebt gecorrigeerd. ' +
      'De vorige notulen worden overschreven. Dit verbruikt AI-tegoed van de organisatie.',
    keywords: ['notulen', 'samenvatting', 'opnieuw', 'hergenereren', 'transcript', 'vergadering'],
    input: { recording_id: { type: 'string', description: 'Id van de opname (uit meeting_recording.list).' } },
    required: ['recording_id'],
    async plan(ctx, input) {
      const recordingId = id(input, 'recording_id');
      const recording = await row<RecordingRow>(ctx, 'meeting_recordings', recordingId, RECORDING_FIELDS, 'Opname');
      if (!recording.transcript_text) {
        throw new ActionError('Deze opname heeft nog geen transcript; er valt niets samen te vatten.');
      }
      return {
        title: `Notulen opnieuw laten schrijven: ${recording.event_title_snapshot ?? 'opname'}`,
        sub: joinShort([
          `${Math.round(recording.transcript_text.length / 1000)} duizend tekens transcript`,
          recording.summary_text ? 'de bestaande notulen worden overschreven' : 'er zijn nog geen notulen',
          'kost AI-tegoed',
        ]),
        kind: 'work',
        payload: { recording_id: recordingId, title: recording.event_title_snapshot },
      };
    },
  },

  {
    id: 'meeting_recording.update_transcript',
    label: 'Uitgeschreven tekst van een opname corrigeren',
    module: 'calendar',
    kind: 'write',
    description:
      'Vervangt de uitgeschreven tekst van een opname door een gecorrigeerde versie — bijvoorbeeld om verkeerd verstane namen of vaktermen recht te zetten. ' +
      'Geef de VOLLEDIGE tekst; wat je stuurt komt in de plaats van wat er stond. Laat daarna de notulen opnieuw schrijven met `meeting_recording.regenerate_summary`.',
    keywords: ['transcript', 'corrigeren', 'uitgeschreven', 'tekst', 'opname', 'verbeteren'],
    input: {
      recording_id: { type: 'string', description: 'Id van de opname (uit meeting_recording.list).' },
      transcript_text: { type: 'string', description: 'De volledige gecorrigeerde tekst.' },
    },
    required: ['recording_id', 'transcript_text'],
    async plan(ctx, input) {
      const recordingId = id(input, 'recording_id');
      const recording = await row<RecordingRow>(ctx, 'meeting_recordings', recordingId, RECORDING_FIELDS, 'Opname');
      const text = str(input, 'transcript_text', 200000);
      const was = recording.transcript_text?.length ?? 0;
      if (recording.transcript_text === text) throw new ActionError('Die tekst staat er al zo in.');
      return {
        title: `Transcript bijwerken: ${recording.event_title_snapshot ?? 'opname'}`,
        sub: joinShort([`${was} → ${text.length} tekens`, 'de oude tekst wordt vervangen']),
        kind: 'work',
        payload: { recording_id: recordingId, title: recording.event_title_snapshot, transcript_text: text },
      };
    },
  },

  {
    id: 'meeting_recording.send_summary',
    label: 'Notulen mailen naar de genodigden',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description:
      'Mailt de notulen van een opname naar de opgegeven adressen, optioneel met het volledige transcript erbij. Geef je geen `recipients`, dan worden de genodigden van de bijbehorende afspraak gebruikt (of de ontvangers van de vorige keer). ' +
      'Dit is echte post naar buiten met de INHOUD van een vergadering — noem in je antwoord naar welke adressen hij gaat. Laat `body_text` weg om de opgeslagen notulen als tekst te gebruiken.',
    keywords: ['notulen mailen', 'versturen', 'verslag', 'samenvatting', 'genodigden', 'transcript'],
    input: {
      recording_id: { type: 'string', description: 'Id van de opname (uit meeting_recording.list).' },
      recipients: { type: 'array', items: { type: 'string' }, description: 'E-mailadressen van de ontvangers.' },
      subject: { type: 'string', description: 'Onderwerp; standaard "Notulen — <titel van de afspraak>".' },
      body_text: { type: 'string', description: 'Eigen begeleidende tekst; weglaten gebruikt de opgeslagen notulen.' },
      include_transcript: { type: 'boolean', description: 'Het volledige transcript meesturen. Standaard uit.' },
    },
    required: ['recording_id'],
    async plan(ctx, input) {
      const recordingId = id(input, 'recording_id');
      const recording = await row<RecordingRow>(ctx, 'meeting_recordings', recordingId, RECORDING_FIELDS, 'Opname');
      if (!recording.summary_text) throw new ActionError('Deze opname heeft nog geen notulen. Maak ze eerst met `meeting_recording.regenerate_summary`.');

      const wanted = Array.isArray(input.recipients)
        ? (input.recipients as unknown[]).map((r) => String(r).trim().toLowerCase()).filter(Boolean)
        : [];
      let recipients: string[] = [];
      if (wanted.length) {
        for (const email of wanted) if (!isEmail(email)) throw new ActionError(`"${email}" is geen geldig e-mailadres.`);
        recipients = [...new Set(wanted)];
      } else if (recording.provider === 'native' && recording.event_ref) {
        // Native opnames dragen de iCalendar-UID van de afspraak; daarmee vinden we
        // de genodigden terug zonder dat het model ze hoeft over te typen.
        const { data: events } = await orgQuery(ctx, 'calendar_events', 'id').eq('uid', recording.event_ref).limit(1);
        const eventId = events && events.length ? String(events[0].id) : null;
        if (eventId) recipients = (await attendeesOf(ctx, eventId)).map((a) => a.email);
      }
      if (recipients.length === 0 && Array.isArray(recording.summary_recipients)) {
        recipients = [...new Set(recording.summary_recipients.map((r) => String(r.email).toLowerCase()).filter(isEmail))];
      }
      if (recipients.length === 0) {
        throw new ActionError('Er zijn geen ontvangers te vinden bij deze afspraak. Geef de e-mailadressen mee in `recipients`.');
      }
      if (recipients.length > 50) throw new ActionError('Maximaal 50 ontvangers per keer.');

      const subject = optStr(input, 'subject', 200) ?? `Notulen — ${recording.event_title_snapshot ?? 'onze afspraak'}`;
      const includeTranscript = bool(input, 'include_transcript', false);
      if (includeTranscript && !recording.transcript_text) {
        throw new ActionError('Er is geen transcript om mee te sturen.');
      }

      return {
        title: `Notulen mailen naar ${recipients.length} ontvanger${recipients.length === 1 ? '' : 's'}`,
        sub: joinShort([recording.event_title_snapshot, recipients.join(', '), includeTranscript ? 'met volledig transcript' : null], 140),
        warning: `De volledige inhoud van deze vergadering gaat per e-mail naar ${recipients.join(', ')}${includeTranscript ? ', inclusief het woordelijke transcript' : ''}.`,
        kind: 'mail',
        payload: {
          recording_id: recordingId,
          title: recording.event_title_snapshot,
          recipients,
          subject,
          body_text: optStr(input, 'body_text', 50000),
          include_transcript: includeTranscript,
        },
      };
    },
  },

  // ── Urenregistratie ───────────────────────────────────────────────────────
  {
    id: 'time.hour_criterion',
    label: 'Urencriterium van 1225 uur raadplegen',
    module: 'time',
    kind: 'read',
    description:
      'Geeft de stand van het urencriterium over een kalenderjaar: alle geregistreerde uren van één persoon, opgesplitst in direct klantwerk en indirecte uren (administratie, acquisitie, reistijd, scholing, overig), met een prognose voor het lopende jaar. ' +
      'Alles telt mee voor de 1225 uur, ook de indirecte uren. Dit is een indicatieve teller, geen fiscaal advies. Zonder `year` het lopende jaar; zonder `user_id` de ingelogde gebruiker.',
    keywords: ['urencriterium', '1225', 'zelfstandigenaftrek', 'uren', 'prognose', 'direct', 'indirect', 'kalenderjaar'],
    input: {
      year: { type: 'number', description: 'Kalenderjaar, bv. 2026. Standaard het lopende jaar.' },
      user_id: { type: 'string', description: 'Van wie de uren zijn. Standaard de ingelogde gebruiker.' },
    },
    async read(ctx, input) {
      const year = Math.round(optNum(input, 'year') ?? Number(ctx.today.slice(0, 4)));
      if (year < 2000 || year > 2100) throw new ActionError('Geef een jaartal tussen 2000 en 2100.');
      const userId = optId(input, 'user_id') ?? ctx.userId;
      const { data, error } = await orgQuery(ctx, 'time_entries', 'minutes, entry_type, indirect_category')
        .eq('user_id', userId)
        .gte('entry_date', `${year}-01-01`).lte('entry_date', `${year}-12-31`)
        .limit(20000);
      if (error) throw new ActionError(`Uren ophalen mislukt: ${error.message}`);

      let direct = 0;
      let indirect = 0;
      const perCategory: Record<string, number> = {};
      for (const entry of (data ?? []) as Array<Record<string, unknown>>) {
        const minutes = Number(entry.minutes) || 0;
        if (entry.entry_type === 'indirect') {
          indirect += minutes;
          const category = entry.indirect_category ? String(entry.indirect_category) : 'other';
          perCategory[category] = (perCategory[category] ?? 0) + minutes;
        } else {
          direct += minutes;
        }
      }
      const total = direct + indirect;
      const target = 1225 * 60;

      // Prognose alleen voor het lopende jaar: het tempo tot nu toe doortrekken.
      const currentYear = Number(ctx.today.slice(0, 4));
      let projectedHours: number | null = null;
      let neededPerWeekHours: number | null = null;
      if (year === currentYear) {
        const yearStart = Date.UTC(year, 0, 1);
        const daysInYear = Math.round((Date.UTC(year + 1, 0, 1) - yearStart) / 86400000);
        const [, month, day] = ctx.today.split('-').map(Number);
        const dayOfYear = Math.max(1, Math.round((Date.UTC(year, month - 1, day) - yearStart) / 86400000) + 1);
        projectedHours = Math.round((total * (daysInYear / dayOfYear)) / 60);
        const weeksLeft = Math.max(1, (daysInYear - dayOfYear) / 7);
        neededPerWeekHours = Math.round((Math.max(0, target - total) / weeksLeft) / 60 * 10) / 10;
      }

      return {
        year,
        user_id: userId,
        target_hours: 1225,
        total_hours: Math.round(total / 60 * 10) / 10,
        direct_hours: Math.round(direct / 60 * 10) / 10,
        indirect_hours: Math.round(indirect / 60 * 10) / 10,
        indirect_per_category: Object.fromEntries(
          Object.entries(perCategory).map(([key, minutes]) => [INDIRECT_LABEL[key] ?? key, Math.round(minutes / 60 * 10) / 10]),
        ),
        reached: total >= target,
        remaining_hours: Math.round(Math.max(0, target - total) / 60 * 10) / 10,
        projected_hours: projectedHours,
        needed_per_week_hours: neededPerWeekHours,
        note: 'Indicatieve teller op basis van de geregistreerde uren — geen fiscaal advies.',
      };
    },
  },

  {
    id: 'time_entry.update_details',
    label: 'Urenpost herclassificeren: direct/indirect, categorie, tarief, project',
    module: 'time',
    kind: 'write',
    description:
      'Werkt de velden van een urenregistratie bij die `propose_edit_time_entry` niet kent: het soort uren (direct klantwerk of indirect), de categorie bij indirecte uren (administratie, acquisitie, reistijd, scholing, overig), het uurtarief en op welk project of welke klant de uren staan. ' +
      'Het soort uren bepaalt de uitsplitsing van het urencriterium; beide soorten tellen mee voor de 1225 uur. Geef alleen de velden die veranderen. ' +
      'Uren die uit een agenda-afspraak zijn afgeleid (source "calendar") kun je hier niet aanpassen — die volgen de agendakoppeling; gebruik daarvoor `calendar_event.set_link`.',
    keywords: ['uren', 'urenpost', 'direct', 'indirect', 'categorie', 'administratie', 'acquisitie', 'reistijd', 'scholing', 'uurtarief', 'urencriterium'],
    input: {
      time_entry_id: { type: 'string', description: 'Id van de urenregistratie (uit list_time_entries).' },
      entry_type: { type: 'string', enum: [...ENTRY_TYPE], description: 'direct = klantwerk, indirect = geen klantwerk.' },
      indirect_category: { type: 'string', enum: [...INDIRECT_CATEGORY], description: 'Verplicht bij indirect: admin, acquisition, travel, education of other.' },
      hourly_rate_eur: { type: 'number', description: 'Uurtarief in hele euro\'s (mag decimaal). 0 = geen tarief.' },
      project_id: { type: 'string', description: 'Ander project.' },
      client_id: { type: 'string', description: 'Andere klant.' },
    },
    required: ['time_entry_id'],
    async plan(ctx, input) {
      const entryId = id(input, 'time_entry_id');
      const entry = await row<{
        source: string; description: string | null; entry_date: string; minutes: number;
        entry_type: string; indirect_category: string | null; hourly_rate_cents: number | null;
        project_id: string | null; client_id: string | null;
      }>(ctx, 'time_entries', entryId,
        'source, description, entry_date, minutes, entry_type, indirect_category, hourly_rate_cents, project_id, client_id', 'Urenregistratie');
      if (entry.source === 'calendar') {
        throw new ActionError('Deze urenpost komt uit een agenda-afspraak en wordt automatisch bijgehouden. Pas de agendakoppeling aan met `calendar_event.set_link`.');
      }

      const patch: Record<string, unknown> = {};
      const described: string[] = [];
      const entryType = optChoice(input, 'entry_type', ENTRY_TYPE);
      const category = optChoice(input, 'indirect_category', INDIRECT_CATEGORY);
      const effectiveType = entryType ?? entry.entry_type;
      if (entryType && entryType !== entry.entry_type) {
        patch.entry_type = entryType;
        described.push(entryType === 'direct' ? 'wordt direct klantwerk' : 'wordt indirect');
      }
      if (effectiveType === 'indirect') {
        const effectiveCategory = category ?? entry.indirect_category;
        if (!effectiveCategory) throw new ActionError('Indirecte uren hebben een categorie nodig: admin, acquisition, travel, education of other.');
        if (effectiveCategory !== entry.indirect_category) {
          patch.indirect_category = effectiveCategory;
          described.push(`categorie ${INDIRECT_LABEL[effectiveCategory] ?? effectiveCategory}`);
        }
      } else if (entryType === 'direct' && entry.indirect_category) {
        // De DB-check laat een categorie alleen toe bij indirecte uren.
        patch.indirect_category = null;
      }

      const rate = optNum(input, 'hourly_rate_eur');
      if (rate !== null) {
        if (rate < 0) throw new ActionError('Een uurtarief kan niet negatief zijn.');
        const cents = Math.round(rate * 100);
        if (cents !== (entry.hourly_rate_cents ?? 0)) {
          patch.hourly_rate_cents = cents === 0 ? null : cents;
          described.push(cents === 0 ? 'geen uurtarief' : `€ ${rate.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per uur`);
        }
      }

      const projectId = optId(input, 'project_id');
      if (projectId && projectId !== entry.project_id) {
        const project = await row<{ name: string; client_id: string | null }>(ctx, 'projects', projectId, 'name, client_id', 'Project');
        patch.project_id = projectId;
        described.push(`project ${project.name}`);
        // De klant meeverhuizen als hij nog niet expliciet is meegegeven, anders
        // staan de uren op een project van klant A en een klant B.
        if (!input.client_id && project.client_id && project.client_id !== entry.client_id) patch.client_id = project.client_id;
      }
      const clientId = optId(input, 'client_id');
      if (clientId && clientId !== entry.client_id) {
        const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
        patch.client_id = clientId;
        described.push(`klant ${client.name}`);
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');

      const hours = Math.round(entry.minutes / 60 * 10) / 10;
      return {
        title: `Urenpost bijwerken: ${entry.description || `${hours} uur op ${entry.entry_date}`}`,
        sub: joinShort([entry.entry_date, `${hours} u`, ...described]),
        kind: 'work',
        payload: { time_entry_id: entryId, description: entry.description, entry_date: entry.entry_date, patch },
      };
    },
  },
];
