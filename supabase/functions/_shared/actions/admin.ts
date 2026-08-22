import {
  ActionError, bool, choice, id, isoDate, joinShort, num, optChoice, optIsoDate,
  optNum, optStr, orgQuery, row,
  type ActionCtx, type ActionDef, type ActionPlan,
} from './types.ts';

/**
 * Handelingen rond BEHEER EN INSTELLINGEN: het team, de huisstijl, de gegevens die
 * op de factuur belanden, de boekhoudinstellingen, de e-mailteksten, de afzender en
 * het doorstuuradres voor klantmail.
 *
 * OVER DE MODULE-SLEUTEL. Er is geen module `admin`; de elf sleutels zijn de elf
 * modules waar een teamlid rechten op krijgt (zie src/lib/permissions.ts). Daarom:
 *   - alles wat over de organisatie zélf gaat (team, licenties, audit-log,
 *     meldingsvoorkeur) staat onder `stats`, het overzichtsvlak;
 *   - alles wat op de factuur of in het grootboek landt onder `finance`;
 *   - alles wat de klant te zien of te lezen krijgt (huisstijl, e-mailteksten,
 *     afzender, doorstuuradres) onder `clients`.
 * Komt er ooit een echte beheersmodule, dan is dit de plek om dat om te zetten.
 * De echte grens ligt hier trouwens niet: `company_settings`, de teamtabellen en de
 * inbound-RPC's laten alleen owners en admins schrijven, ongeacht wat hier staat.
 *
 * WAT HIER BEWUST NIET IN ZIT: een nieuwe organisatie of extra administratie
 * aanmaken, een uitnodiging voor jezelf accepteren, de Mollie-sleutel, verzend-
 * domeinen, abonnementen/seats/opslag/modules, het uploaden van een logo of
 * factuurtemplate, en het aan- of uitzetten van pushmeldingen op dit apparaat.
 */

// ── Spiegels van lijsten die in de app leven ────────────────────────────────
// Een edge function kan niets uit `src/` importeren, dus staan deze lijsten hier
// een tweede keer. Ze zijn alle drie klein en veranderen zelden; loopt er eentje
// uit de pas, dan is het gevolg hooguit een keuze die het model niet aanbiedt —
// de database (CHECK-constraints) en de app (terugval op de standaard) houden de
// waarde zelf tegen.

/** Spiegelt MODULE_KEYS in src/lib/permissions.ts. */
const MODULE_KEYS = [
  'clients', 'projects', 'time', 'calendar', 'tickets',
  'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie',
] as const;

const MODULE_LABELS: Record<string, string> = {
  clients: 'Klanten', projects: 'Projecten', time: 'Uren', calendar: 'Agenda',
  tickets: 'Tickets', content: 'Inhoud', stats: 'Statistieken', marketing: 'Marketing',
  finance: 'Financiën', chat: 'Teamchat', gerrie: 'Gerrie (AI)',
};

const MODULE_LEVELS = ['none', 'read', 'write'] as const;
const LEVEL_LABELS: Record<string, string> = { none: 'geen toegang', read: 'alleen lezen', write: 'volledig' };

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
/** Uitnodigen kan alleen op deze drie — de RPC weigert `owner`. */
const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;
const ROLE_LABELS: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

/** Spiegelt LegalForm + LEGAL_FORM_LABELS in src/types.ts. */
const LEGAL_FORMS = ['eenmanszaak', 'vof', 'maatschap', 'cv', 'bv', 'nv', 'cooperatie', 'stichting', 'vereniging'] as const;
const LEGAL_FORM_LABELS: Record<string, string> = {
  eenmanszaak: 'Eenmanszaak', vof: 'VOF', maatschap: 'Maatschap', cv: 'Commanditaire vennootschap',
  bv: 'BV', nv: 'NV', cooperatie: 'Coöperatie', stichting: 'Stichting', vereniging: 'Vereniging',
};
/** Vpb-plichtige rechtsvormen: de database weigert ze zonder de zakelijke module. */
const BUSINESS_LEGAL_FORMS = ['bv', 'nv', 'cooperatie'];

/** Spiegelt BRAND_FONTS in src/lib/branding.ts. `bebas` is alleen voor koppen. */
const BRAND_FONTS = ['system', 'inter', 'jost', 'space-grotesk', 'dm-sans', 'playfair', 'cormorant', 'lora', 'bebas'] as const;
const HEADING_ONLY_FONTS = ['bebas'];
const BRAND_FONT_LABELS: Record<string, string> = {
  system: 'Poppins (standaard)', inter: 'Inter', jost: 'Jost', 'space-grotesk': 'Space Grotesk',
  'dm-sans': 'DM Sans', playfair: 'Playfair Display', cormorant: 'Cormorant Garamond',
  lora: 'Lora', bebas: 'Bebas Neue',
};

/** Spiegelt EMAIL_TEMPLATES in src/lib/emailTemplateContent.ts: welke velden een mail kent. */
const EMAIL_TEMPLATES: Array<{ key: string; label: string; fields: string[] }> = [
  { key: 'quote.sent', label: 'Offerte versturen', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'invoice.sent', label: 'Factuur versturen', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'invoice.reminder.1', label: 'Herinnering niveau 1 (vriendelijk)', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'invoice.reminder.2', label: 'Herinnering niveau 2 (steviger)', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'invoice.reminder.3', label: 'Herinnering niveau 3 (aanmaning)', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'creditNote.sent', label: 'Creditfactuur versturen', fields: ['subject', 'intro', 'closing'] },
  { key: 'contract.sent', label: 'Contract ter ondertekening', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'contract.signed.client', label: 'Contract ondertekend — bevestiging', fields: ['subject', 'intro', 'closing', 'cta_label'] },
  { key: 'meetingBooking.linkSent', label: 'Boekingslink versturen', fields: ['subject', 'intro', 'cta_label'] },
  { key: 'meetingBooking.confirmed', label: 'Boeking bevestigd', fields: ['subject', 'intro', 'closing'] },
];
const EMAIL_TEMPLATE_KEYS = EMAIL_TEMPLATES.map((t) => t.key);
const EMAIL_FIELDS = ['subject', 'intro', 'closing', 'cta_label'] as const;

/** Spiegelt PUSH_EVENTS in src/lib/push-api.ts. */
const NOTIFICATION_EVENTS = [
  { type: 'ticket_new', label: 'Nieuw ticket' },
  { type: 'ticket_note_client', label: 'Reactie op ticket' },
  { type: 'chat_message', label: 'Teamchat-bericht' },
  { type: 'client_email_inbound', label: 'Inkomende klant-e-mail' },
  { type: 'booking_new', label: 'Nieuwe boeking' },
  { type: 'invoice_paid', label: 'Factuur betaald' },
] as const;
const NOTIFICATION_TYPES = NOTIFICATION_EVENTS.map((e) => e.type) as unknown as readonly string[];

/** Het domein waarop het doorstuuradres uitkomt (zie InboundForwardingCard). */
const INBOUND_DOMAIN = 'inbound.resofly.com';

const MONTH_NAMES = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Hulpjes ─────────────────────────────────────────────────────────────────

/** De enige rij met bedrijfsinstellingen van deze organisatie, of null. */
async function settingsRow(ctx: ActionCtx, select = '*'): Promise<Record<string, unknown> | null> {
  const { data, error } = await orgQuery(ctx, 'company_settings', select).maybeSingle();
  if (error) throw new ActionError(`Bedrijfsinstellingen ophalen mislukt: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

/** Optionele hexkleur, genormaliseerd naar hoofdletters zoals het scherm doet. */
function optHex(input: Record<string, unknown>, key: string): string | null {
  const value = optStr(input, key, 9);
  if (!value) return null;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new ActionError(`"${key}" moet een hexkleur zijn, bijvoorbeeld #FFD966.`);
  return value.toUpperCase();
}

/** Optioneel e-mailadres, in kleine letters. */
function optEmail(input: Record<string, unknown>, key: string): string | null {
  const value = optStr(input, key, 200);
  if (!value) return null;
  const clean = value.toLowerCase();
  if (!EMAIL_RE.test(clean)) throw new ActionError(`"${key}" is geen geldig e-mailadres.`);
  return clean;
}

/** Leest een modulerechten-object en controleert sleutels én niveaus. */
function readModuleAccess(input: Record<string, unknown>, key: string, role: string): Record<string, string> {
  const raw = input[key];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ActionError(`"${key}" moet een object zijn, bijvoorbeeld {"finance": "none", "time": "read"}.`);
  }
  const out: Record<string, string> = {};
  for (const [module, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MODULE_KEYS as readonly string[]).includes(module)) {
      throw new ActionError(`"${module}" is geen module. Kies uit: ${MODULE_KEYS.join(', ')}.`);
    }
    const level = String(value ?? '').trim();
    if (!(MODULE_LEVELS as readonly string[]).includes(level)) {
      throw new ActionError(`"${module}" moet none, read of write zijn.`);
    }
    if (role === 'viewer' && level === 'write') {
      throw new ActionError(`Een viewer kan nergens wijzigen; kies bij ${MODULE_LABELS[module]} tussen "read" en "none".`);
    }
    out[module] = level;
  }
  return out;
}

/** Leesbare samenvatting van modulerechten, zoals het scherm hem onder een lid zet. */
function accessSummary(access: Record<string, string> | null | undefined): string {
  const entries = Object.entries(access ?? {});
  const hidden = entries.filter(([, v]) => v === 'none').map(([k]) => MODULE_LABELS[k] ?? k);
  const readOnly = entries.filter(([, v]) => v === 'read').map(([k]) => MODULE_LABELS[k] ?? k);
  if (!hidden.length && !readOnly.length) return 'alle modules volledig';
  return joinShort([
    hidden.length ? `${hidden.join(', ')} verborgen` : null,
    readOnly.length ? `${readOnly.join(', ')} alleen lezen` : null,
  ], 120);
}

/** Eén actief teamlid, met de controles die het scherm ook doet. */
async function activeMember(ctx: ActionCtx, memberId: string) {
  const member = await row<{ id: string; user_id: string; email: string | null; role: string; status: string; module_access: Record<string, string> | null }>(
    ctx, 'organization_members', memberId, 'id, user_id, email, role, status, module_access', 'Teamlid');
  if (member.status !== 'active') throw new ActionError(`${member.email ?? 'Dit teamlid'} is geen actief lid van deze organisatie.`);
  return member;
}

/** Hoeveel actieve owners de organisatie heeft — voor de laatste-owner-grendel. */
async function ownerCount(ctx: ActionCtx): Promise<number> {
  const { count, error } = await ctx.db.from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId).eq('status', 'active').eq('role', 'owner');
  if (error) throw new ActionError(`Owners tellen mislukt: ${error.message}`);
  return count ?? 0;
}

/** Het actieve doorstuuradres, of null. */
async function activeAlias(ctx: ActionCtx) {
  const { data, error } = await orgQuery(ctx, 'organization_inbound_aliases',
    'id, local_part, forward_from_email, status, last_received_at, received_total, pending_confirmation_code, created_at')
    .eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ActionError(`Doorstuuradres ophalen mislukt: ${error.message}`);
  return (data ?? null) as { id: string; local_part: string; forward_from_email: string | null; last_received_at: string | null; received_total: number; pending_confirmation_code: string | null } | null;
}

/** De geverifieerde verzenddomeinen; een persoonlijk afzenderadres moet daarop eindigen. */
async function verifiedDomains(ctx: ActionCtx): Promise<string[]> {
  const { data, error } = await orgQuery(ctx, 'organization_email_domains', 'domain, status').eq('status', 'verified');
  if (error) throw new ActionError(`Verzenddomeinen ophalen mislukt: ${error.message}`);
  return (data ?? []).map((d: Record<string, unknown>) => String(d.domain ?? '').toLowerCase()).filter(Boolean);
}

/**
 * Bouwt het voorstel voor een wijziging aan `company_settings`. Vier kaarten in
 * Instellingen — huisstijl, bedrijfsgegevens, factuurstijl en boekhouding — slaan
 * dezelfde rij op, dus ze delen deze afronding: alleen de genoemde velden in de
 * patch, en een onderschrift dat opsomt wat er verandert.
 */
function settingsPlan(
  patch: Record<string, unknown>, described: string[], title: string,
  extra: Partial<ActionPlan> = {},
): ActionPlan {
  if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één instelling die moet veranderen.');
  return { title, sub: joinShort(described, 130), kind: 'work', payload: { patch }, ...extra };
}

export const ADMIN_ACTIONS: ActionDef[] = [
  // ── Team ──────────────────────────────────────────────────────────────────
  {
    id: 'team.list_access',
    label: 'Teamleden met hun rol en modulerechten bekijken',
    module: 'stats',
    kind: 'read',
    description:
      'Geeft de actieve teamleden met hun `member_id`, e-mailadres, rol en modulerechten. Gebruik dit vóór `team.set_role`, `team.set_module_access` of `team.disable` — die hebben het `member_id` uit deze lijst nodig, niet het `user_id` uit `list_team_members`. ' +
      'Een ontbrekende module in `module_access` betekent VOLLEDIGE toegang; owners en admins hebben altijd alles, ongeacht wat er staat.',
    keywords: ['team', 'teamleden', 'collega', 'medewerker', 'rol', 'rechten', 'modulerechten', 'toegang', 'wie mag wat'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'organization_members',
        'id, user_id, email, role, status, module_access, joined_at')
        .eq('status', 'active').order('created_at', { ascending: true });
      if (error) throw new ActionError(`Teamleden ophalen mislukt: ${error.message}`);
      const members: Array<Record<string, unknown>> = (data ?? []).map((m: Record<string, unknown>) => ({
        member_id: m.id,
        user_id: m.user_id,
        email: m.email,
        role: m.role,
        is_you: m.user_id === ctx.userId,
        module_access: m.module_access ?? {},
        access_summary: accessSummary(m.module_access as Record<string, string> | null),
        joined_at: m.joined_at,
      }));
      return { count: members.length, owners: members.filter((m) => m.role === 'owner').length, members };
    },
  },

  {
    id: 'team.list_invitations',
    label: 'Openstaande teamuitnodigingen bekijken',
    module: 'stats',
    kind: 'read',
    description:
      'Geeft de uitnodigingen die nog open staan: e-mailadres, rol, de modulerechten die het nieuwe lid krijgt, en wanneer de uitnodiging verloopt. Elke openstaande uitnodiging houdt één gebruikerslicentie bezet tot hij wordt geaccepteerd of ingetrokken.',
    keywords: ['uitnodiging', 'uitnodigingen', 'openstaand', 'pending', 'genodigde', 'verloopt'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'organization_invitations',
        'id, email, role, module_access, consumes_license, expires_at, created_at')
        .eq('status', 'pending').order('created_at', { ascending: false });
      if (error) throw new ActionError(`Uitnodigingen ophalen mislukt: ${error.message}`);
      return {
        count: data?.length ?? 0,
        invitations: (data ?? []).map((i: Record<string, unknown>) => ({
          invitation_id: i.id,
          email: i.email,
          role: i.role,
          module_access: i.module_access ?? {},
          access_summary: accessSummary(i.module_access as Record<string, string> | null),
          consumes_license: i.consumes_license,
          expires_at: i.expires_at,
        })),
      };
    },
  },

  {
    id: 'team.license_usage',
    label: 'Licentie- en seatoverzicht bekijken',
    module: 'stats',
    kind: 'read',
    description:
      'Geeft hoeveel gebruikerslicenties (seats) er zijn en hoeveel ervan bezet zijn: inbegrepen seats, actieve leden, openstaande uitnodigingen en het aantal vrije plekken. Kijk hier vóór je iemand uitnodigt — zonder vrije licentie weigert de uitnodiging. ' +
      'Bij `billing_exempt` is de organisatie intern/onbeperkt en gelden er geen seat-limieten.',
    keywords: ['licentie', 'licenties', 'seat', 'seats', 'gebruikers', 'plekken', 'vrij', 'hoeveel mensen'],
    input: {},
    async read(ctx) {
      const { data, error } = await ctx.db.rpc('organization_license_usage', { p_organization_id: ctx.organizationId });
      if (error) throw new ActionError(`Licentieoverzicht ophalen mislukt: ${error.message}`);
      const usage = Array.isArray(data) ? data[0] : data;
      if (!usage) throw new ActionError('Er is geen licentieoverzicht voor deze organisatie.');
      return usage;
    },
  },

  {
    id: 'audit.list',
    label: 'Audit-log met de laatste wijzigingen bekijken',
    module: 'stats',
    kind: 'read',
    description:
      'Geeft de server-side gelogde wijzigingen binnen deze organisatie: wat er is aangemaakt, bijgewerkt of verwijderd, wie er is uitgenodigd, welke rol is gewijzigd, en gebeurtenissen rond plan en betaling. De log is alleen-lezen en wordt door database-triggers gevuld — hij is de enige plek waar je terugziet wie wat wanneer deed.',
    keywords: ['audit', 'log', 'logboek', 'historie', 'geschiedenis', 'wie deed wat', 'wijzigingen', 'activiteit'],
    input: {
      entity_type: { type: 'string', description: 'Alleen dit soort rijen, bijvoorbeeld "invoice" of "organization_member".' },
      action: { type: 'string', description: 'Alleen deze soort gebeurtenis: created, updated, deleted, invited, accepted, revoked, role_changed, disabled.' },
      since: { type: 'string', description: 'Alleen vanaf deze datum (JJJJ-MM-DD).' },
      limit: { type: 'number', description: 'Maximaal aantal regels (standaard 25, hoogstens 100).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
      let query = orgQuery(ctx, 'audit_logs', 'id, actor_user_id, action, entity_type, entity_id, entity_label, metadata, created_at')
        .order('created_at', { ascending: false }).limit(limit);
      const entityType = optStr(input, 'entity_type', 60);
      if (entityType) query = query.eq('entity_type', entityType);
      const action = optStr(input, 'action', 60);
      if (action) query = query.eq('action', action);
      const since = optIsoDate(input, 'since');
      if (since) query = query.gte('created_at', `${since}T00:00:00Z`);
      const { data, error } = await query;
      if (error) throw new ActionError(`Audit-log ophalen mislukt: ${error.message}`);
      return { count: data?.length ?? 0, entries: data ?? [] };
    },
  },

  {
    id: 'team.invite',
    label: 'Teamlid uitnodigen met rol en modulerechten',
    module: 'stats',
    kind: 'write',
    risk: 'high',
    description:
      'Nodigt iemand per e-mail uit voor deze organisatie, met een rol (admin, member of viewer) en optioneel per module wat hij mag zien. Er gaat ECHTE POST naar buiten en er wordt één betaalde gebruikerslicentie gereserveerd tot hij accepteert of je de uitnodiging intrekt. ' +
      'Controleer eerst met `team.license_usage` of er een plek vrij is. Owner uitnodigen kan niet — die rol geef je pas na het accepteren met `team.set_role`. ' +
      'Staat er al een openstaande uitnodiging op dit adres, dan wordt die bijgewerkt in plaats van verdubbeld.',
    keywords: ['uitnodigen', 'teamlid', 'collega', 'medewerker', 'nieuwe gebruiker', 'aannemen', 'toevoegen aan team', 'seat'],
    input: {
      email: { type: 'string', description: 'Het e-mailadres van de nieuwe medewerker.' },
      role: { type: 'string', enum: [...INVITE_ROLES], description: 'admin = beheert alles behalve owners, member = werkt mee, viewer = kijkt alleen mee.' },
      module_access: {
        type: 'object',
        description: 'Per module none/read/write, bijvoorbeeld {"finance": "none"}. Een module die je weglaat staat volledig open. Bij rol admin heeft dit geen effect: een admin ziet altijd alles.',
        additionalProperties: true,
      },
    },
    required: ['email', 'role'],
    async plan(ctx, input) {
      const email = optEmail(input, 'email');
      if (!email) throw new ActionError('Vul een geldig e-mailadres in.');
      const role = choice(input, 'role', INVITE_ROLES);
      const access = readModuleAccess(input, 'module_access', role);

      const { data: existing, error: memberError } = await orgQuery(ctx, 'organization_members', 'id, email, role')
        .eq('email', email).eq('status', 'active').maybeSingle();
      if (memberError) throw new ActionError(`Teamleden nakijken mislukt: ${memberError.message}`);
      if (existing) throw new ActionError(`${email} is al actief teamlid (${ROLE_LABELS[String(existing.role)] ?? existing.role}).`);

      const { data: usageRows, error: usageError } = await ctx.db.rpc('organization_license_usage', { p_organization_id: ctx.organizationId });
      if (usageError) throw new ActionError(`Licentieoverzicht ophalen mislukt: ${usageError.message}`);
      const usage = (Array.isArray(usageRows) ? usageRows[0] : usageRows) as Record<string, unknown> | null;
      const exempt = usage?.billing_exempt === true;
      const free = Number(usage?.available_seats ?? 0);
      if (!exempt && free <= 0) {
        throw new ActionError('Er is geen vrije gebruikerslicentie. Trek eerst een openstaande uitnodiging in, schakel een teamlid uit, of laat de eigenaar een extra licentie bijkopen.');
      }

      const { data: pending } = await orgQuery(ctx, 'organization_invitations', 'id')
        .eq('email', email).eq('status', 'pending').maybeSingle();

      return {
        title: `Teamlid uitnodigen: ${email}`,
        sub: joinShort([
          `rol ${ROLE_LABELS[role]}`,
          role === 'admin' ? 'een admin ziet alle modules' : accessSummary(access),
          pending ? 'werkt de bestaande openstaande uitnodiging bij' : null,
          exempt ? 'geen seat-limiet (interne organisatie)' : `${free} licentie${free === 1 ? '' : 's'} vrij`,
        ], 140),
        warning: 'De uitnodigingsmail gaat echt de deur uit en er wordt één betaalde gebruikerslicentie gereserveerd totdat hij accepteert of je de uitnodiging intrekt.',
        kind: 'mail',
        payload: { email, role, module_access: role === 'admin' ? {} : access },
      };
    },
  },

  {
    id: 'team.revoke_invitation',
    label: 'Teamuitnodiging intrekken',
    module: 'stats',
    kind: 'write',
    risk: 'high',
    description:
      'Trekt een openstaande teamuitnodiging in. De uitnodigingslink werkt daarna niet meer en de gereserveerde gebruikerslicentie komt vrij. Zoek de uitnodiging eerst met `team.list_invitations`.',
    keywords: ['uitnodiging intrekken', 'annuleren', 'terugtrekken', 'genodigde', 'seat vrijmaken'],
    input: { invitation_id: { type: 'string', description: 'Id van de uitnodiging (uit team.list_invitations).' } },
    required: ['invitation_id'],
    async plan(ctx, input) {
      const invitationId = id(input, 'invitation_id');
      const invitation = await row<{ email: string; role: string; status: string; expires_at: string | null }>(
        ctx, 'organization_invitations', invitationId, 'email, role, status, expires_at', 'Uitnodiging');
      if (invitation.status !== 'pending') throw new ActionError(`Deze uitnodiging staat al op "${invitation.status}" en is niet meer in te trekken.`);
      return {
        title: `Uitnodiging intrekken: ${invitation.email}`,
        sub: joinShort([`rol ${ROLE_LABELS[invitation.role] ?? invitation.role}`, 'de gebruikerslicentie komt vrij']),
        warning: 'Onomkeerbaar: de link in de uitnodigingsmail werkt daarna niet meer. Wil je hem later alsnog toevoegen, dan moet je opnieuw uitnodigen.',
        kind: 'work',
        payload: { invitation_id: invitationId, email: invitation.email },
      };
    },
  },

  {
    id: 'team.set_role',
    label: 'Rol van een teamlid wijzigen',
    module: 'stats',
    kind: 'write',
    risk: 'high',
    description:
      'Zet een teamlid op owner, admin, member of viewer. Owner en admin beheren de organisatie zelf (teamleden, instellingen, abonnement); een member werkt mee binnen zijn modulerechten en een viewer kijkt alleen mee. ' +
      'Je eigen rol, die van een andere owner en die van de laatste owner zijn geblokkeerd — de database bewaakt dat ook. Zoek het `member_id` met `team.list_access`.',
    keywords: ['rol', 'owner', 'admin', 'member', 'viewer', 'promoveren', 'degraderen', 'beheerder maken'],
    input: {
      member_id: { type: 'string', description: 'Id van het teamlid (member_id uit team.list_access).' },
      role: { type: 'string', enum: [...ROLES] },
    },
    required: ['member_id', 'role'],
    async plan(ctx, input) {
      const memberId = id(input, 'member_id');
      const role = choice(input, 'role', ROLES);
      const member = await activeMember(ctx, memberId);
      const who = member.email ?? 'dit teamlid';
      if (member.user_id === ctx.userId) throw new ActionError('Je kunt je eigen rol niet wijzigen.');
      if (member.role === 'owner' && member.user_id !== ctx.userId) {
        throw new ActionError(`Owners zijn tegen elkaar beschermd: je kunt de rol van ${who} niet wijzigen.`);
      }
      if (member.role === role) throw new ActionError(`${who} heeft die rol al.`);
      if (member.role === 'owner' && await ownerCount(ctx) <= 1) {
        throw new ActionError(`${who} is de laatste owner; maak eerst iemand anders owner.`);
      }
      const gainsAdmin = role === 'owner' || role === 'admin';
      return {
        title: `Rol wijzigen: ${who}`,
        sub: joinShort([
          `${ROLE_LABELS[member.role] ?? member.role} → ${ROLE_LABELS[role]}`,
          gainsAdmin ? 'krijgt beheer over teamleden en instellingen' : 'verliest het beheer over teamleden en instellingen',
          gainsAdmin ? 'modulerechten tellen niet meer mee' : accessSummary(member.module_access),
        ], 140),
        warning: role === 'owner'
          ? 'Een owner kan alles: teamleden beheren, het abonnement wijzigen en andere owners toevoegen. Owners zijn daarna tegen elkaar beschermd, dus je kunt hem niet zomaar terugzetten.'
          : undefined,
        kind: 'work',
        payload: { member_id: memberId, email: who, role, previous_role: member.role },
      };
    },
  },

  {
    id: 'team.set_module_access',
    label: 'Modulerechten van een teamlid opslaan',
    module: 'stats',
    kind: 'write',
    description:
      'Zet per module wat een teamlid mag: "none" (de module verdwijnt volledig uit zijn menu en is ook via de database niet op te vragen), "read" (alleen lezen) of "write" (volledig). Een module die je weglaat staat volledig open — geef dus altijd de VOLLEDIGE gewenste set door, want deze handeling vervangt de bestaande instelling. ' +
      'Een leeg object zet alles weer open. Bij een viewer kan alleen none of read. Owners hebben altijd alles; bij een admin wordt de instelling wél bewaard maar gaat hij pas gelden zodra je hem naar member of viewer zet. Zoek het `member_id` met `team.list_access`.',
    keywords: ['rechten', 'modulerechten', 'toegang', 'afschermen', 'verbergen', 'alleen lezen', 'financiën dicht', 'permissies'],
    input: {
      member_id: { type: 'string', description: 'Id van het teamlid (member_id uit team.list_access).' },
      module_access: {
        type: 'object',
        description: `Per module none/read/write. Bekende modules: ${MODULE_KEYS.join(', ')}. Een leeg object {} zet alles open.`,
        additionalProperties: true,
      },
    },
    required: ['member_id', 'module_access'],
    async plan(ctx, input) {
      const memberId = id(input, 'member_id');
      const member = await activeMember(ctx, memberId);
      const who = member.email ?? 'dit teamlid';
      if (member.role === 'owner') throw new ActionError(`${who} is owner en heeft altijd toegang tot alles; modulerechten hebben geen effect.`);
      const access = readModuleAccess(input, 'module_access', member.role);
      return {
        title: `Modulerechten opslaan: ${who}`,
        sub: joinShort([
          accessSummary(access),
          member.role === 'admin' ? 'let op: geldt pas zodra deze admin member of viewer wordt' : null,
        ], 140),
        kind: 'work',
        payload: { member_id: memberId, email: who, module_access: access },
      };
    },
  },

  {
    id: 'team.disable',
    label: 'Teamlid uitschakelen',
    module: 'stats',
    kind: 'write',
    risk: 'high',
    description:
      'Schakelt een teamlid uit voor deze organisatie: zijn toegang vervalt per direct en de gebruikerslicentie komt vrij. Zijn werk (taken, uren, notities) blijft staan. Dit is de nette manier om iemand die weggaat eruit te halen — er wordt niets verwijderd. ' +
      'Jezelf, een andere owner en de laatste owner kun je niet uitschakelen. Zoek het `member_id` met `team.list_access`.',
    keywords: ['uitschakelen', 'deactiveren', 'toegang intrekken', 'uit dienst', 'verwijderen uit team', 'blokkeren'],
    input: { member_id: { type: 'string', description: 'Id van het teamlid (member_id uit team.list_access).' } },
    required: ['member_id'],
    async plan(ctx, input) {
      const memberId = id(input, 'member_id');
      const member = await activeMember(ctx, memberId);
      const who = member.email ?? 'dit teamlid';
      if (member.user_id === ctx.userId) throw new ActionError('Je kunt jezelf niet uitschakelen.');
      if (member.role === 'owner' && member.user_id !== ctx.userId) {
        throw new ActionError(`Owners zijn tegen elkaar beschermd: je kunt ${who} niet uitschakelen.`);
      }
      if (member.role === 'owner' && await ownerCount(ctx) <= 1) {
        throw new ActionError(`${who} is de laatste owner en kan niet worden uitgeschakeld.`);
      }
      return {
        title: `Teamlid uitschakelen: ${who}`,
        sub: joinShort([`rol ${ROLE_LABELS[member.role] ?? member.role}`, 'de gebruikerslicentie komt vrij']),
        warning: 'Hij verliest per direct alle toegang tot deze organisatie. Zijn taken, uren en notities blijven staan; terugzetten kan alleen door hem opnieuw uit te nodigen.',
        kind: 'work',
        payload: { member_id: memberId, email: who },
      };
    },
  },

  // ── Huisstijl ─────────────────────────────────────────────────────────────
  {
    id: 'branding.get',
    label: 'Huisstijl van de klantpagina\'s bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft de huidige huisstijl: merknaam, merkkleur, sfeer (licht of donker), galerij-achtergrond, de lettertypen voor koppen en tekst, de afsluittekst en of "Geleverd via ResoFly" verborgen is. Ook staat er in welke lettertypen je kunt kiezen.',
    keywords: ['huisstijl', 'merk', 'branding', 'logo', 'merkkleur', 'accentkleur', 'lettertype', 'font', 'sfeer', 'donker', 'licht'],
    input: {},
    async read(ctx) {
      const settings = await settingsRow(ctx,
        'trade_name, company_name, brand_accent_color, brand_client_theme, brand_gallery_bg, brand_heading_font, brand_body_font, brand_footer_text, brand_hide_powered_by, brand_logo_data_url');
      return {
        branding: settings
          ? {
            trade_name: settings.trade_name,
            company_name: settings.company_name,
            brand_accent_color: settings.brand_accent_color,
            brand_client_theme: settings.brand_client_theme,
            brand_gallery_bg: settings.brand_gallery_bg,
            brand_heading_font: settings.brand_heading_font,
            brand_body_font: settings.brand_body_font,
            brand_footer_text: settings.brand_footer_text,
            brand_hide_powered_by: settings.brand_hide_powered_by,
            has_logo: Boolean(settings.brand_logo_data_url),
          }
          : null,
        available_fonts: BRAND_FONTS.map((key) => ({ key, label: BRAND_FONT_LABELS[key], heading_only: HEADING_ONLY_FONTS.includes(key) })),
        note: settings ? undefined : 'Er zijn nog geen bedrijfsinstellingen; de standaardhuisstijl is actief.',
      };
    },
  },

  {
    id: 'branding.save',
    label: 'Huisstijl van de klantpagina\'s opslaan',
    module: 'clients',
    kind: 'write',
    description:
      'Slaat de huisstijl op die je klanten te zien krijgen: merknaam, merkkleur, sfeer (licht of donker), achtergrond van de galerij, lettertype voor koppen en voor lopende tekst, de afsluittekst onder de klantpagina\'s en of "Geleverd via ResoFly" verborgen wordt. ' +
      'De merkkleur werkt door in het klantportaal, de galerij, facturen, offertes, contracten en e-mails. Geef alleen wat verandert; wat je weglaat blijft staan. Een logo instellen kan hier niet — daar hoort een bestand bij.',
    keywords: ['huisstijl', 'merknaam', 'merkkleur', 'accentkleur', 'lettertype', 'font', 'sfeer', 'donker', 'licht', 'galerij achtergrond', 'afsluittekst', 'powered by'],
    input: {
      trade_name: { type: 'string', description: 'De naam waaronder je naar buiten treedt (je juridische naam staat bij de bedrijfsgegevens).' },
      brand_accent_color: { type: 'string', description: 'Merkkleur als hexcode, bijvoorbeeld #FFD966.' },
      brand_client_theme: { type: 'string', enum: ['dark', 'light'], description: 'Sfeer van portaal, galerij en de publieke offerte-, factuur- en contractpagina.' },
      brand_gallery_bg: { type: 'string', description: 'Achtergrondkleur van de galerij als hexcode, bijvoorbeeld #0B0B0B.' },
      brand_heading_font: { type: 'string', enum: [...BRAND_FONTS], description: 'Lettertype voor koppen.' },
      brand_body_font: { type: 'string', enum: [...BRAND_FONTS], description: 'Lettertype voor lopende tekst; "bebas" kan hier niet.' },
      brand_footer_text: { type: 'string', description: 'Afsluitzin onder de klantpagina\'s (hoogstens 160 tekens). Een lege waarde haalt hem weg.' },
      brand_hide_powered_by: { type: 'boolean', description: 'true verbergt "Geleverd via ResoFly" op de publieke galerijpagina.' },
    },
    async plan(ctx, input) {
      const patch: Record<string, unknown> = {};
      const described: string[] = [];

      const tradeName = optStr(input, 'trade_name', 120);
      if (tradeName) { patch.trade_name = tradeName; described.push(`merknaam "${tradeName}"`); }

      const accent = optHex(input, 'brand_accent_color');
      if (accent) {
        // De factuurkleur volgt de merkkleur; het scherm doet dit ook en de database
        // houdt het met een trigger na, zodat een factuur nooit uit de pas loopt.
        patch.brand_accent_color = accent;
        patch.invoice_accent_color = accent;
        described.push(`merkkleur ${accent}`);
      }
      const theme = optChoice(input, 'brand_client_theme', ['dark', 'light'] as const);
      if (theme) { patch.brand_client_theme = theme; described.push(`sfeer ${theme === 'dark' ? 'donker' : 'licht'}`); }

      const galleryBg = optHex(input, 'brand_gallery_bg');
      if (galleryBg) { patch.brand_gallery_bg = galleryBg; described.push(`galerij-achtergrond ${galleryBg}`); }

      const heading = optChoice(input, 'brand_heading_font', BRAND_FONTS);
      if (heading) { patch.brand_heading_font = heading; described.push(`koppen ${BRAND_FONT_LABELS[heading]}`); }

      const body = optChoice(input, 'brand_body_font', BRAND_FONTS);
      if (body) {
        if (HEADING_ONLY_FONTS.includes(body)) throw new ActionError(`${BRAND_FONT_LABELS[body]} is een displayletter en alleen geschikt voor koppen.`);
        patch.brand_body_font = body;
        described.push(`tekst ${BRAND_FONT_LABELS[body]}`);
      }
      if (input.brand_footer_text !== undefined) {
        const footer = optStr(input, 'brand_footer_text', 160);
        patch.brand_footer_text = footer;
        described.push(footer ? `afsluittekst "${footer}"` : 'afsluittekst weggehaald');
      }
      if (typeof input.brand_hide_powered_by === 'boolean') {
        patch.brand_hide_powered_by = input.brand_hide_powered_by;
        described.push(input.brand_hide_powered_by ? '"Geleverd via ResoFly" verborgen' : '"Geleverd via ResoFly" zichtbaar');
      }

      return settingsPlan(patch, described, 'Huisstijl opslaan', {
        warning: 'Dit staat meteen op alles wat je klanten zien: het klantportaal, de galerijen en de publieke offerte-, factuur- en contractpagina.',
      });
    },
  },

  // ── Bedrijfsgegevens, factuur en boekhouding ──────────────────────────────
  {
    id: 'settings.get_company',
    label: 'Bedrijfsgegevens, factuurstijl en boekhoudinstellingen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de bedrijfsgegevens die op elke factuur en offerte komen (naam, rechtsvorm, adres, KvK, btw-nummer, IBAN), de factuurstijl (tekstkleur, lettergrootte, betaalinstructies, footer) en de boekhoudinstellingen (KOR, btw-aangifteperiode, boekhoud-knipdatum, boekjaar-startmaand, resultaatrekening, standaard uurtarief). Lees dit vóór je iets wijzigt, zodat je weet wat er nu staat.',
    keywords: ['bedrijfsgegevens', 'factuurgegevens', 'kvk', 'btw-nummer', 'iban', 'rechtsvorm', 'boekhoudinstellingen', 'kor', 'aangifteperiode', 'uurtarief', 'boekjaar'],
    input: {},
    async read(ctx) {
      const settings = await settingsRow(ctx,
        'company_name, legal_form, trade_name, address_line1, address_line2, postal_code, city, country, email, phone, website, kvk_number, vat_number, iban, ' +
        'invoice_payment_terms, invoice_footer, invoice_template_kind, invoice_template_file_name, invoice_template_text_color, invoice_font_size, ' +
        'bookkeeping_start_date, kor_enabled, vat_return_period, fiscal_year_start_month, year_result_account_code, default_hourly_rate_cents');
      if (!settings) return { settings: null, note: 'Er zijn nog geen bedrijfsinstellingen opgeslagen voor deze organisatie.' };
      return {
        settings,
        default_hourly_rate_eur: settings.default_hourly_rate_cents != null ? Number(settings.default_hourly_rate_cents) / 100 : null,
        legal_form_label: LEGAL_FORM_LABELS[String(settings.legal_form)] ?? settings.legal_form,
      };
    },
  },

  {
    id: 'settings.save_company',
    label: 'Bedrijfsgegevens voor de factuur opslaan',
    module: 'finance',
    kind: 'write',
    description:
      'Slaat de bedrijfsgegevens op die op elke factuur, offerte en e-factuur komen: bedrijfsnaam, adres, postcode, plaats, land, e-mailadres, telefoon, website, KvK-nummer, btw-nummer en IBAN. Adres, land, KvK en btw-nummer zijn ook wat een geldige UBL/Peppol-e-factuur nodig heeft. ' +
      'Geef alleen wat verandert; wat je weglaat blijft staan. De merknaam hoort bij de huisstijl (`branding.save`), de rechtsvorm bij `settings.set_legal_form`.',
    keywords: ['bedrijfsgegevens', 'adres', 'postcode', 'plaats', 'kvk', 'btw-nummer', 'iban', 'telefoon', 'website', 'op de factuur'],
    input: {
      company_name: { type: 'string', description: 'Je juridische bedrijfsnaam.' },
      address_line1: { type: 'string', description: 'Straat en huisnummer.' },
      address_line2: { type: 'string' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string', description: 'Land voluit, bijvoorbeeld "Nederland".' },
      email: { type: 'string' },
      phone: { type: 'string' },
      website: { type: 'string' },
      kvk_number: { type: 'string' },
      vat_number: { type: 'string', description: 'Btw-identificatienummer, bijvoorbeeld NL001234567B01.' },
      iban: { type: 'string' },
    },
    async plan(ctx, input) {
      const patch: Record<string, unknown> = {};
      const described: string[] = [];
      const labels: Record<string, string> = {
        company_name: 'bedrijfsnaam', address_line1: 'adres', address_line2: 'adresregel 2', postal_code: 'postcode',
        city: 'plaats', country: 'land', email: 'e-mailadres', phone: 'telefoon', website: 'website',
        kvk_number: 'KvK-nummer', vat_number: 'btw-nummer', iban: 'IBAN',
      };
      for (const key of Object.keys(labels)) {
        if (input[key] === undefined) continue;
        const value = key === 'email' ? optEmail(input, key) : optStr(input, key, 200);
        patch[key] = key === 'company_name' ? (value ?? '') : value;
        described.push(`${labels[key]}: ${value ?? '—'}`);
      }
      return settingsPlan(patch, described, 'Bedrijfsgegevens op de factuur opslaan', {
        kind: 'money',
        warning: 'Deze gegevens staan op elke factuur, offerte en e-factuur die je hierna verstuurt. Al verstuurde PDF\'s veranderen niet.',
      });
    },
  },

  {
    id: 'settings.set_legal_form',
    label: 'Rechtsvorm van de administratie wijzigen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Zet de rechtsvorm van deze administratie. Die stuurt het rekeningschema, de resultaatbestemming bij de jaarafsluiting en welke fiscale schermen zichtbaar zijn (urencriterium bij een IB-ondernemer, vennootschapsbelasting en jaarrekening bij een BV). ' +
      'BV, NV en coöperatie horen bij de zakelijke module; zonder die module weigert de database de wijziging. Doe dit alleen als de gebruiker er uitdrukkelijk om vraagt.',
    keywords: ['rechtsvorm', 'eenmanszaak', 'bv', 'nv', 'vof', 'maatschap', 'stichting', 'vereniging', 'coöperatie', 'omzetten'],
    input: { legal_form: { type: 'string', enum: [...LEGAL_FORMS] } },
    required: ['legal_form'],
    async plan(ctx, input) {
      const legalForm = choice(input, 'legal_form', LEGAL_FORMS);
      const settings = await settingsRow(ctx, 'legal_form');
      const current = String(settings?.legal_form ?? 'eenmanszaak');
      if (current === legalForm) throw new ActionError(`De rechtsvorm staat al op ${LEGAL_FORM_LABELS[legalForm]}.`);
      return {
        title: `Rechtsvorm wijzigen naar ${LEGAL_FORM_LABELS[legalForm]}`,
        sub: joinShort([
          `${LEGAL_FORM_LABELS[current] ?? current} → ${LEGAL_FORM_LABELS[legalForm]}`,
          BUSINESS_LEGAL_FORMS.includes(legalForm) ? 'vereist de zakelijke module' : null,
        ]),
        warning: 'De rechtsvorm stuurt je rekeningschema, de resultaatbestemming bij de jaarafsluiting en welke fiscale schermen je ziet. Al geboekte mutaties blijven staan, maar de fiscale kant van je administratie verandert hiermee wezenlijk.',
        kind: 'money',
        payload: { patch: { legal_form: legalForm }, legal_form_label: LEGAL_FORM_LABELS[legalForm] },
      };
    },
  },

  {
    id: 'settings.save_invoice_layout',
    label: 'Factuurstijl, betaalinstructies en footertekst opslaan',
    module: 'finance',
    kind: 'write',
    description:
      'Stelt in hoe je factuur en offerte eruitzien en wat er onderaan staat: de tekstkleur van de PDF, de lettergrootte (8 tot 14 punt), de betaalinstructies en de footertekst. Geef alleen wat verandert. Een eigen achtergrondtemplate uploaden kan hier niet — daar hoort een bestand bij.',
    keywords: ['factuurstijl', 'lettergrootte', 'tekstkleur', 'betaalinstructies', 'betaaltekst', 'footer', 'voettekst', 'onderaan de factuur'],
    input: {
      invoice_template_text_color: { type: 'string', description: 'Tekstkleur van de factuur-PDF als hexcode, bijvoorbeeld #1A1A1A.' },
      invoice_font_size: { type: 'number', description: 'Lettergrootte in punten, 8 tot en met 14.' },
      invoice_payment_terms: { type: 'string', description: 'Betaalinstructies onder de factuur. Leeg haalt de tekst weg.' },
      invoice_footer: { type: 'string', description: 'Footertekst onder factuur en offerte. Leeg haalt de tekst weg.' },
    },
    async plan(ctx, input) {
      const patch: Record<string, unknown> = {};
      const described: string[] = [];

      const color = optHex(input, 'invoice_template_text_color');
      if (color) { patch.invoice_template_text_color = color; described.push(`tekstkleur ${color}`); }

      const size = optNum(input, 'invoice_font_size');
      if (size !== null) {
        if (size < 8 || size > 14) throw new ActionError('De lettergrootte moet tussen 8 en 14 punt liggen.');
        patch.invoice_font_size = Math.round(size);
        described.push(`lettergrootte ${Math.round(size)}pt`);
      }
      if (input.invoice_payment_terms !== undefined) {
        const terms = optStr(input, 'invoice_payment_terms', 2000);
        patch.invoice_payment_terms = terms;
        described.push(terms ? `betaaltekst: ${terms}` : 'betaaltekst weggehaald');
      }
      if (input.invoice_footer !== undefined) {
        const footer = optStr(input, 'invoice_footer', 2000);
        patch.invoice_footer = footer;
        described.push(footer ? `footer: ${footer}` : 'footer weggehaald');
      }
      return settingsPlan(patch, described, 'Factuurstijl en teksten opslaan', {
        kind: 'money',
        warning: 'De nieuwe stijl en teksten staan direct op elke factuur en offerte die je hierna maakt of opnieuw verstuurt.',
      });
    },
  },

  {
    id: 'settings.save_bookkeeping',
    label: 'Boekhoudinstellingen opslaan (KOR, btw-periode, knipdatum, boekjaar)',
    module: 'finance',
    kind: 'write',
    description:
      'Stelt de instellingen in die het grootboek en de btw-aangifte aansturen: de boekhoud-knipdatum (vanaf wanneer het grootboek leidend is), de kleineondernemersregeling (KOR), de btw-aangifteperiode (per kwartaal of maandelijks), de startmaand van het boekjaar (voor een gebroken boekjaar) en de rekening waarop het jaarresultaat bij de afsluiting wordt geboekt. ' +
      'Geef alleen wat verandert. Vraag door voordat je de KOR of de knipdatum aanraakt: dat verandert de btw op alle nieuwe facturen respectievelijk welke facturen nog in het grootboek belanden.',
    keywords: ['boekhouding', 'kor', 'kleineondernemersregeling', 'btw-aangifte', 'kwartaal', 'maandelijks', 'knipdatum', 'startdatum', 'boekjaar', 'gebroken boekjaar', 'jaarresultaat', 'grootboek'],
    input: {
      bookkeeping_start_date: { type: 'string', description: 'Boekhouding leidend vanaf deze datum (JJJJ-MM-DD). Kies bij voorkeur een kwartaal- of jaargrens.' },
      kor_enabled: { type: 'boolean', description: 'true zet de kleineondernemersregeling aan: geen btw op nieuwe facturen en voorbelasting niet aftrekbaar.' },
      vat_return_period: { type: 'string', enum: ['quarterly', 'monthly'] },
      fiscal_year_start_month: { type: 'number', description: 'Maand waarin het boekjaar begint, 1 (januari) tot en met 12.' },
      year_result_account_code: { type: 'string', enum: ['0510', '0500'], description: '0510 = onverdeeld resultaat, 0500 = eigen vermogen.' },
    },
    async plan(ctx, input) {
      const settings = await settingsRow(ctx, 'bookkeeping_start_date, kor_enabled, vat_return_period, fiscal_year_start_month, year_result_account_code') ?? {};
      const current = {
        bookkeeping_start_date: settings.bookkeeping_start_date == null ? null : String(settings.bookkeeping_start_date),
        kor_enabled: settings.kor_enabled === true,
        vat_return_period: settings.vat_return_period == null ? null : String(settings.vat_return_period),
        fiscal_year_start_month: settings.fiscal_year_start_month == null ? null : Number(settings.fiscal_year_start_month),
        year_result_account_code: settings.year_result_account_code == null ? null : String(settings.year_result_account_code),
      };
      const patch: Record<string, unknown> = {};
      const described: string[] = [];
      const warnings: string[] = [];

      const startDate = input.bookkeeping_start_date === undefined ? null : isoDate(input, 'bookkeeping_start_date');
      if (startDate && startDate !== current.bookkeeping_start_date) {
        patch.bookkeeping_start_date = startDate;
        described.push(`grootboek leidend vanaf ${startDate}`);
        warnings.push('Verkoopfacturen met een datum vóór de knipdatum worden niet meer naar het grootboek geboekt; die stand hoort in je beginbalans te zitten.');
      }
      if (typeof input.kor_enabled === 'boolean' && input.kor_enabled !== current.kor_enabled) {
        patch.kor_enabled = input.kor_enabled;
        described.push(input.kor_enabled ? 'KOR aan' : 'KOR uit');
        warnings.push(input.kor_enabled
          ? 'Met de KOR staat er geen btw meer op nieuwe facturen en is voorbelasting niet aftrekbaar.'
          : 'Zonder de KOR wordt er weer btw op nieuwe facturen berekend en is voorbelasting weer aftrekbaar.');
      }
      const period = optChoice(input, 'vat_return_period', ['quarterly', 'monthly'] as const);
      if (period && period !== current.vat_return_period) {
        patch.vat_return_period = period;
        described.push(`btw-aangifte ${period === 'quarterly' ? 'per kwartaal' : 'maandelijks'}`);
      }
      const startMonth = optNum(input, 'fiscal_year_start_month');
      if (startMonth !== null) {
        const month = Math.round(startMonth);
        if (month < 1 || month > 12) throw new ActionError('De startmaand van het boekjaar moet 1 tot en met 12 zijn.');
        if (month !== current.fiscal_year_start_month) {
          patch.fiscal_year_start_month = month;
          described.push(`boekjaar begint in ${MONTH_NAMES[month - 1]}`);
        }
      }
      const resultAccount = optChoice(input, 'year_result_account_code', ['0510', '0500'] as const);
      if (resultAccount && resultAccount !== current.year_result_account_code) {
        patch.year_result_account_code = resultAccount;
        described.push(`jaarresultaat op ${resultAccount}`);
      }

      if (Object.keys(patch).length === 0) throw new ActionError('Die boekhoudinstellingen staan al zo; er verandert niets.');
      return settingsPlan(patch, described, 'Boekhoudinstellingen opslaan', {
        kind: 'money',
        warning: warnings.length ? warnings.join(' ') : undefined,
        risk: warnings.length ? 'high' : 'normal',
      });
    },
  },

  {
    id: 'settings.set_default_hourly_rate',
    label: 'Standaard uurtarief van de organisatie instellen',
    module: 'finance',
    kind: 'write',
    description:
      'Zet het organisatiebrede uurtarief waarmee declarabele uren worden gewaardeerd wanneer een project geen eigen tarief heeft. Geef het bedrag in hele euro\'s (bijvoorbeeld 85 of 87.50); 0 haalt het tarief weg zodat uren zonder projecttarief geen waarde krijgen. ' +
      'Dit werkt vooruit: al gewaardeerde uren en al gemaakte facturen veranderen niet.',
    keywords: ['uurtarief', 'tarief', 'standaardtarief', 'declarabel', 'uren waarderen', 'per uur'],
    input: { hourly_rate_eur: { type: 'number', description: 'Uurtarief in euro. 0 = geen standaardtarief.' } },
    required: ['hourly_rate_eur'],
    async plan(ctx, input) {
      const rate = num(input, 'hourly_rate_eur');
      if (rate < 0) throw new ActionError('Een uurtarief kan niet negatief zijn.');
      const cents = rate === 0 ? null : Math.round(rate * 100);
      const settings = await settingsRow(ctx, 'default_hourly_rate_cents');
      const currentCents = settings?.default_hourly_rate_cents as number | null | undefined;
      if ((currentCents ?? null) === cents) throw new ActionError('Dat is al het huidige standaard uurtarief.');
      const money = (value: number | null) => (value == null ? 'geen tarief' : `€ ${(value / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      return {
        title: cents == null ? 'Standaard uurtarief weghalen' : `Standaard uurtarief op ${money(cents)} zetten`,
        sub: joinShort([`${money(currentCents ?? null)} → ${money(cents)}`, 'geldt alleen waar een project geen eigen tarief heeft']),
        kind: 'money',
        payload: { patch: { default_hourly_rate_cents: cents }, rate_label: money(cents) },
      };
    },
  },

  // ── E-mailteksten ─────────────────────────────────────────────────────────
  {
    id: 'email_template.list',
    label: 'E-mailteksten bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft per soort uitgaande mail (offerte, factuur, herinnering niveau 1 tot 3, creditfactuur, contract, boeking) of de tekst is aangepast en wat er dan staat. Een veld dat leeg is, valt terug op de ingebouwde standaardtekst. ' +
      'Ook staat er per mail welke velden hij kent — niet elke mail heeft een afsluiting of een knop.',
    keywords: ['e-mailtekst', 'mailtekst', 'sjabloon', 'template', 'onderwerp', 'aanhef', 'afsluiting', 'knoptekst'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'email_templates', 'template_key, enabled, subject, intro, closing, cta_label, updated_at');
      if (error) throw new ActionError(`E-mailteksten ophalen mislukt: ${error.message}`);
      const byKey = new Map<string, Record<string, unknown>>((data ?? []).map((r: Record<string, unknown>) => [String(r.template_key), r]));
      return {
        templates: EMAIL_TEMPLATES.map((t) => {
          const saved = byKey.get(t.key);
          return {
            template_key: t.key,
            label: t.label,
            fields: t.fields,
            customized: Boolean(saved),
            subject: saved?.subject ?? null,
            intro: saved?.intro ?? null,
            closing: saved?.closing ?? null,
            cta_label: saved?.cta_label ?? null,
          };
        }),
        placeholders_note: 'Plaatshouders zoals {{recipient_name}}, {{company_name}}, {{invoice_number}} en {{quote_number}} worden bij het versturen ingevuld.',
      };
    },
  },

  {
    id: 'email_template.save',
    label: 'Tekst van een uitgaande e-mail aanpassen',
    module: 'clients',
    kind: 'write',
    description:
      'Past het onderwerp, de aanhef, de afsluiting en/of de knoptekst van één soort uitgaande e-mail aan. Geef alleen de velden die veranderen; de rest blijft staan zoals hij was. Plaatshouders als {{recipient_name}} en {{invoice_number}} worden bij het versturen ingevuld — laat ze staan als je ze niet kwijt wilt. ' +
      'Kijk eerst met `email_template.list` welke soorten er zijn en welke velden zo\'n mail kent.',
    keywords: ['e-mailtekst', 'mailtekst aanpassen', 'sjabloon', 'template', 'onderwerp', 'aanhef', 'afsluiting', 'knoptekst', 'herinneringstekst'],
    input: {
      template_key: { type: 'string', enum: [...EMAIL_TEMPLATE_KEYS], description: 'Welke mail je aanpast.' },
      subject: { type: 'string', description: 'Onderwerpregel.' },
      intro: { type: 'string', description: 'Aanhef en openingstekst; regeleindes mogen.' },
      closing: { type: 'string', description: 'Afsluitende tekst.' },
      cta_label: { type: 'string', description: 'Tekst op de knop.' },
    },
    required: ['template_key'],
    async plan(ctx, input) {
      const key = choice(input, 'template_key', EMAIL_TEMPLATE_KEYS as unknown as readonly string[]);
      const meta = EMAIL_TEMPLATES.find((t) => t.key === key)!;

      const { data: saved, error } = await orgQuery(ctx, 'email_templates', 'template_key, subject, intro, closing, cta_label')
        .eq('template_key', key).maybeSingle();
      if (error) throw new ActionError(`E-mailtekst ophalen mislukt: ${error.message}`);

      // Wat de gebruiker niet noemt houdt zijn huidige waarde; een veld dat deze
      // mail niet kent gaat als null mee, precies zoals het scherm het opslaat.
      const values: Record<string, string | null> = {};
      const changed: string[] = [];
      const labels: Record<string, string> = { subject: 'onderwerp', intro: 'aanhef', closing: 'afsluiting', cta_label: 'knoptekst' };
      for (const field of EMAIL_FIELDS) {
        if (!meta.fields.includes(field)) {
          if (input[field] !== undefined) throw new ActionError(`De mail "${meta.label}" heeft geen ${labels[field]}.`);
          values[field] = null;
          continue;
        }
        if (input[field] === undefined) {
          values[field] = (saved?.[field] as string | null | undefined) ?? null;
          continue;
        }
        const value = optStr(input, field, field === 'cta_label' ? 60 : 4000);
        values[field] = value;
        changed.push(value ? `${labels[field]}: ${value}` : `${labels[field]} teruggezet op de standaardtekst`);
      }
      if (changed.length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      return {
        title: `E-mailtekst aanpassen: ${meta.label}`,
        sub: joinShort([saved ? 'was al aangepast' : 'stond nog op de standaardtekst', ...changed], 140),
        warning: 'Elke nieuwe mail van dit soort gebruikt deze tekst direct — hij gaat ongewijzigd naar je klanten.',
        kind: 'mail',
        payload: { template_key: key, label: meta.label, ...values },
      };
    },
  },

  {
    id: 'email_template.reset',
    label: 'E-mailtekst terugzetten naar de standaardtekst',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description:
      'Verwijdert de zelfgeschreven tekst van één soort uitgaande e-mail, zodat hij weer de ingebouwde standaardtekst gebruikt. Gebruik dit alleen als de gebruiker het eigen exemplaar echt kwijt wil.',
    keywords: ['terugzetten', 'standaardtekst', 'herstellen', 'reset', 'e-mailtekst', 'sjabloon'],
    input: { template_key: { type: 'string', enum: [...EMAIL_TEMPLATE_KEYS] } },
    required: ['template_key'],
    async plan(ctx, input) {
      const key = choice(input, 'template_key', EMAIL_TEMPLATE_KEYS as unknown as readonly string[]);
      const meta = EMAIL_TEMPLATES.find((t) => t.key === key)!;
      const { data: saved, error } = await orgQuery(ctx, 'email_templates', 'template_key, subject').eq('template_key', key).maybeSingle();
      if (error) throw new ActionError(`E-mailtekst ophalen mislukt: ${error.message}`);
      if (!saved) throw new ActionError(`"${meta.label}" gebruikt al de standaardtekst.`);
      return {
        title: `E-mailtekst terugzetten: ${meta.label}`,
        sub: 'de ingebouwde standaardtekst wordt weer gebruikt',
        warning: 'Onomkeerbaar: je eigen tekst voor deze mail wordt verwijderd en is niet terug te halen.',
        kind: 'mail',
        payload: { template_key: key, label: meta.label },
      };
    },
  },

  // ── Afzender en doorstuuradres ────────────────────────────────────────────
  {
    id: 'sender.get_mine',
    label: 'Je eigen afzender voor klantmail bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft de persoonlijke afzendernaam en het afzenderadres van de ingelogde gebruiker, plus de geverifieerde verzenddomeinen waarop zo\'n adres moet eindigen. Zonder persoonlijke afzender gaat mail onder de afzender van de organisatie de deur uit.',
    keywords: ['afzender', 'afzendernaam', 'from', 'namens wie', 'persoonlijke afzender', 'verzenddomein'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'user_sender_identities', 'from_name, from_email, updated_at')
        .eq('user_id', ctx.userId).maybeSingle();
      if (error) throw new ActionError(`Persoonlijke afzender ophalen mislukt: ${error.message}`);
      const domains = await verifiedDomains(ctx);
      return {
        sender: data ?? null,
        verified_domains: domains,
        note: domains.length === 0
          ? 'Er is nog geen geverifieerd verzenddomein; tot die tijd wordt een persoonlijke afzender niet toegepast.'
          : undefined,
      };
    },
  },

  {
    id: 'sender.set_mine',
    label: 'Je eigen afzender voor klantmail instellen',
    module: 'clients',
    kind: 'write',
    description:
      'Legt vast onder welke naam en welk adres de ingelogde gebruiker klantmail en campagnes verstuurt, bijvoorbeeld "Jan de Vries <jan@jouwdomein.nl>". Dit geldt alleen voor mail die hijzelf verstuurt; collega\'s stellen hun eigen afzender in. ' +
      'Een afzenderadres moet eindigen op een geverifieerd verzenddomein van de organisatie — is dat er niet, geef dan alleen een naam.',
    keywords: ['afzender', 'afzendernaam', 'afzenderadres', 'from', 'namens', 'onder mijn naam mailen'],
    input: {
      from_name: { type: 'string', description: 'Je afzendernaam, bijvoorbeeld "Jan de Vries".' },
      from_email: { type: 'string', description: 'Je afzenderadres; moet eindigen op een geverifieerd verzenddomein. Leeg laten mag.' },
    },
    async plan(ctx, input) {
      const fromName = optStr(input, 'from_name', 120);
      const fromEmail = optEmail(input, 'from_email');
      if (!fromName && !fromEmail) throw new ActionError('Geef minstens een afzendernaam of een afzenderadres.');
      if (fromEmail) {
        const domains = await verifiedDomains(ctx);
        if (domains.length === 0) {
          throw new ActionError('Er is nog geen geverifieerd verzenddomein. Laat het adres leeg (dan wordt alleen je naam gebruikt) of laat eerst een domein koppelen en verifiëren.');
        }
        const domain = fromEmail.slice(fromEmail.lastIndexOf('@') + 1);
        if (!domains.includes(domain)) {
          throw new ActionError(`Het adres moet eindigen op een geverifieerd domein: ${domains.map((d) => `@${d}`).join(', ')}.`);
        }
      }
      const preview = fromName && fromEmail ? `${fromName} <${fromEmail}>` : (fromEmail ?? fromName);
      return {
        title: 'Persoonlijke afzender instellen',
        sub: joinShort([`je mailt als ${preview}`, 'geldt alleen voor mail die jij zelf verstuurt']),
        warning: 'Klantmail en campagnes die jij verstuurt gaan hierna onder deze naam de deur uit.',
        kind: 'mail',
        payload: { from_name: fromName, from_email: fromEmail, preview },
      };
    },
  },

  {
    id: 'sender.clear_mine',
    label: 'Je eigen afzender wissen',
    module: 'clients',
    kind: 'write',
    description:
      'Wist de persoonlijke afzender van de ingelogde gebruiker; zijn mail gaat daarna weer onder de afzender van de organisatie de deur uit.',
    keywords: ['afzender wissen', 'afzender verwijderen', 'weer als organisatie mailen'],
    input: {},
    async plan(ctx) {
      const { data, error } = await orgQuery(ctx, 'user_sender_identities', 'from_name, from_email')
        .eq('user_id', ctx.userId).maybeSingle();
      if (error) throw new ActionError(`Persoonlijke afzender ophalen mislukt: ${error.message}`);
      if (!data) throw new ActionError('Je hebt geen persoonlijke afzender ingesteld; je mailt al onder de afzender van de organisatie.');
      const current = [data.from_name, data.from_email].filter(Boolean).join(' ');
      return {
        title: 'Persoonlijke afzender wissen',
        sub: joinShort([current || 'je huidige afzender', 'je mailt daarna weer als de organisatie']),
        kind: 'mail',
        payload: { previous: current },
      };
    },
  },

  {
    id: 'inbound_alias.get',
    label: 'Doorstuuradres voor klantmail bekijken',
    module: 'clients',
    kind: 'read',
    description:
      `Geeft het doorstuuradres van de organisatie op @${INBOUND_DOMAIN}: het adres zelf, welk eigen adres ernaartoe doorstuurt, wanneer er voor het laatst iets binnenkwam en hoeveel berichten er in totaal langskwamen. ` +
      'Komt er al ruim twee weken niets binnen, dan staat de doorstuurregel bij de mailprovider waarschijnlijk uit.',
    keywords: ['doorstuuradres', 'doorsturen', 'inbound', 'klantmail opvangen', 'forwarding', 'alias'],
    input: {},
    async read(ctx) {
      const alias = await activeAlias(ctx);
      if (!alias) return { alias: null, note: 'Er is nog geen doorstuuradres aangemaakt voor deze organisatie.' };
      return {
        alias: {
          alias_id: alias.id,
          address: `${alias.local_part}@${INBOUND_DOMAIN}`,
          forward_from_email: alias.forward_from_email,
          last_received_at: alias.last_received_at,
          received_total: alias.received_total,
          awaiting_confirmation: Boolean(alias.pending_confirmation_code),
        },
      };
    },
  },

  {
    id: 'inbound_alias.create',
    label: 'Doorstuuradres voor klantmail aanmaken',
    module: 'clients',
    kind: 'write',
    description:
      `Maakt het unieke @${INBOUND_DOMAIN}-adres van de organisatie aan. Zet je bij je eigen mailprovider een doorstuurregel naar dat adres, dan komt mail die klanten rechtstreeks naar je eigen adres sturen vanzelf bij de juiste klant te staan. Je blijft alles gewoon in je eigen postvak ontvangen. ` +
      'Bestaat er al een adres, gebruik dan `inbound_alias.get`; een nieuw adres maak je met `inbound_alias.rotate`.',
    keywords: ['doorstuuradres', 'aanmaken', 'inbound', 'klantmail opvangen', 'forwarding', 'alias'],
    input: {},
    async plan(ctx) {
      const alias = await activeAlias(ctx);
      if (alias) throw new ActionError(`Er is al een doorstuuradres: ${alias.local_part}@${INBOUND_DOMAIN}.`);
      return {
        title: 'Doorstuuradres voor klantmail aanmaken',
        sub: `je krijgt een uniek adres op @${INBOUND_DOMAIN}; de doorstuurregel bij je mailprovider zet je daarna zelf`,
        kind: 'mail',
        payload: {},
      };
    },
  },

  {
    id: 'inbound_alias.set_forward_from',
    label: 'Vastleggen vanaf welk eigen adres wordt doorgestuurd',
    module: 'clients',
    kind: 'write',
    description:
      'Legt vast vanaf welk eigen adres (bijvoorbeeld info@jouwdomein.nl) de doorstuurregel loopt. Daaraan herkent ResoFly dat een bericht via de doorstuurregel binnenkomt, en dat je eigen post niet als klantmail wordt aangezien. Er moet al een doorstuuradres zijn.',
    keywords: ['doorstuuradres', 'eigen adres', 'forward from', 'herkennen', 'inbound'],
    input: { email: { type: 'string', description: 'Je eigen adres waarvandaan wordt doorgestuurd, bijvoorbeeld info@jouwdomein.nl.' } },
    required: ['email'],
    async plan(ctx, input) {
      const email = optEmail(input, 'email');
      if (!email) throw new ActionError('Vul een geldig e-mailadres in.');
      const alias = await activeAlias(ctx);
      if (!alias) throw new ActionError('Er is nog geen doorstuuradres. Maak dat eerst aan met `inbound_alias.create`.');
      if (alias.forward_from_email === email) throw new ActionError(`Er staat al ${email} als doorstuuradres van herkomst.`);
      return {
        title: 'Vastleggen vanaf welk adres wordt doorgestuurd',
        sub: joinShort([`${alias.forward_from_email ?? 'nog niets'} → ${email}`, `naar ${alias.local_part}@${INBOUND_DOMAIN}`]),
        kind: 'mail',
        payload: { alias_id: alias.id, email },
      };
    },
  },

  {
    id: 'inbound_alias.rotate',
    label: 'Nieuw doorstuuradres aanmaken (het oude vervalt)',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description:
      'Vervangt het doorstuuradres door een nieuw adres. Het oude blijft nog 30 dagen mail aannemen, maar die berichten belanden in de opvangbak in plaats van direct bij de juiste klant. Doe dit alleen als het oude adres uitgelekt is of misbruikt wordt — en vertel erbij dat de doorstuurregel bij de mailprovider meteen moet worden aangepast.',
    keywords: ['doorstuuradres', 'nieuw adres', 'roteren', 'vervangen', 'uitgelekt', 'spam'],
    input: {},
    async plan(ctx) {
      const alias = await activeAlias(ctx);
      if (!alias) throw new ActionError('Er is nog geen doorstuuradres om te vervangen.');
      return {
        title: 'Nieuw doorstuuradres aanmaken',
        sub: joinShort([`het huidige adres is ${alias.local_part}@${INBOUND_DOMAIN}`, `${alias.received_total} berichten ontvangen`]),
        warning: 'Onomkeerbaar: het oude adres werkt nog 30 dagen maar levert alleen nog in de opvangbak. Pas de doorstuurregel bij je mailprovider meteen aan, anders komt klantmail niet meer bij de juiste klant terecht.',
        kind: 'mail',
        payload: { previous_address: `${alias.local_part}@${INBOUND_DOMAIN}` },
      };
    },
  },

  // ── Meldingen ─────────────────────────────────────────────────────────────
  {
    id: 'notification.list_preferences',
    label: 'Meldingsvoorkeuren per gebeurtenis bekijken',
    module: 'stats',
    kind: 'read',
    description:
      'Geeft per soort gebeurtenis (nieuw ticket, reactie op ticket, teamchat-bericht, inkomende klant-e-mail, nieuwe boeking, factuur betaald) of de ingelogde gebruiker daarvoor een melding wil. Niets ingesteld betekent: melding aan.',
    keywords: ['meldingen', 'notificaties', 'voorkeur', 'push', 'waarschuwing', 'melding aan', 'melding uit'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'notification_preferences', 'event_type, enabled').eq('user_id', ctx.userId);
      if (error) throw new ActionError(`Meldingsvoorkeuren ophalen mislukt: ${error.message}`);
      const stored = new Map<string, boolean>((data ?? []).map((r: Record<string, unknown>) => [String(r.event_type), r.enabled !== false]));
      return {
        preferences: NOTIFICATION_EVENTS.map((e) => ({ event_type: e.type, label: e.label, enabled: stored.get(e.type) ?? true })),
      };
    },
  },

  {
    id: 'notification.set_preference',
    label: 'Meldingsvoorkeur voor één gebeurtenis aan- of uitzetten',
    module: 'stats',
    kind: 'write',
    description:
      'Zet voor de ingelogde gebruiker aan of uit of hij binnen deze organisatie een melding krijgt bij een bepaald soort gebeurtenis. Dit geldt op al zijn apparaten; of er daadwerkelijk een pushmelding aankomt hangt er verder van af of hij meldingen op dat apparaat heeft aangezet.',
    keywords: ['meldingen', 'notificatie', 'aanzetten', 'uitzetten', 'stil', 'push', 'waarschuwing'],
    input: {
      event_type: { type: 'string', enum: [...NOTIFICATION_TYPES], description: 'Om welke gebeurtenis het gaat.' },
      enabled: { type: 'boolean', description: 'true = melding aan, false = melding uit.' },
    },
    required: ['event_type', 'enabled'],
    async plan(ctx, input) {
      const eventType = choice(input, 'event_type', NOTIFICATION_TYPES);
      const enabled = bool(input, 'enabled', true);
      const meta = NOTIFICATION_EVENTS.find((e) => e.type === eventType)!;
      const { data, error } = await orgQuery(ctx, 'notification_preferences', 'enabled')
        .eq('user_id', ctx.userId).eq('event_type', eventType).maybeSingle();
      if (error) throw new ActionError(`Meldingsvoorkeur ophalen mislukt: ${error.message}`);
      const current = data ? data.enabled !== false : true;
      if (current === enabled) throw new ActionError(`"${meta.label}" staat al ${enabled ? 'aan' : 'uit'}.`);
      return {
        title: `Melding ${enabled ? 'aanzetten' : 'uitzetten'}: ${meta.label}`,
        sub: enabled ? 'je krijgt hier voortaan een melding van' : 'je krijgt hier geen melding meer van',
        kind: 'work',
        payload: { event_type: eventType, enabled, label: meta.label },
      };
    },
  },
];
