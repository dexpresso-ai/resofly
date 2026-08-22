import {
  ActionError, bool, choice, id, ids, joinShort, optChoice, optId,
  optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionDef,
} from './types.ts';

/**
 * Handelingen rond KLANTEN: het dossier zelf, de vrije velden, de contactpersonen
 * en de opvangbak met post die nog nergens bij hoort.
 *
 * De basis (klant aanmaken, wijzigen, mailen, contactpersoon toevoegen) zit al als
 * eersteklas tool in gerrieCore. Wat hier staat is de rest van wat het scherm kan:
 * de fiscale gegevens die een e-factuur nodig heeft, de eigen velden die je in een
 * mailing als variabele gebruikt, en de opvangbak.
 */

const CLIENT_STATUS = ['active', 'prospect', 'inactive'] as const;
const CLIENT_KIND = ['business', 'consumer'] as const;
const FIELD_TYPES = ['text', 'textarea', 'number', 'amount', 'date', 'select', 'multiselect', 'boolean', 'url', 'email', 'phone'] as const;

export const CLIENT_ACTIONS: ActionDef[] = [
  {
    id: 'client.update_details',
    label: 'Adres, btw-nummer, soort klant en labels bijwerken',
    module: 'clients',
    kind: 'write',
    description:
      'Werkt de gegevens van een klant bij die het gewone klantformulier wél kent maar `propose_edit_client` niet: postadres, postcode, plaats, land, btw-nummer, KVK-nummer, soort klant (zakelijk of consument), klantwaarde, labels en de kleur op de kaart. ' +
      'Het btw-nummer, KVK-nummer en adres zijn nodig voor een geldige UBL/Peppol-e-factuur; het soort klant bepaalt of een aanmaning de consumentenregels (WIK) volgt. ' +
      'Geef alleen de velden die veranderen — wat je weglaat blijft staan. Zoek de klant eerst met `search_clients`.',
    keywords: ['adres', 'postcode', 'plaats', 'land', 'btw', 'vat', 'kvk', 'zakelijk', 'consument', 'label', 'tag', 'kleur', 'klantwaarde', 'peppol', 'ubl'],
    input: {
      client_id: { type: 'string', description: 'Id van de klant (exact, uit search_clients).' },
      address_line1: { type: 'string', description: 'Straat en huisnummer.' },
      address_line2: { type: 'string', description: 'Tweede adresregel (optioneel).' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string', description: 'Land voluit, bijvoorbeeld "Nederland".' },
      vat_number: { type: 'string', description: 'Btw-identificatienummer, bv. NL001234567B01.' },
      kvk_number: { type: 'string' },
      client_kind: { type: 'string', enum: [...CLIENT_KIND], description: 'business = zakelijk, consumer = particulier.' },
      status: { type: 'string', enum: [...CLIENT_STATUS] },
      value_eur: { type: 'number', description: 'Geschatte klantwaarde in euro.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Vervangt de bestaande labels volledig.' },
      color: { type: 'string', description: 'Hex-kleur, bv. #FFD966.' },
      follow_up: { type: 'string', description: 'Datum voor opvolging (JJJJ-MM-DD).' },
    },
    required: ['client_id'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const patch: Record<string, unknown> = {};
      const put = (key: string, value: unknown) => { if (value !== null && value !== undefined) patch[key] = value; };

      put('address_line1', optStr(input, 'address_line1', 200));
      put('address_line2', optStr(input, 'address_line2', 200));
      put('postal_code', optStr(input, 'postal_code', 20));
      put('city', optStr(input, 'city', 120));
      put('country', optStr(input, 'country', 120));
      put('vat_number', optStr(input, 'vat_number', 40));
      put('kvk_number', optStr(input, 'kvk_number', 40));
      put('client_kind', optChoice(input, 'client_kind', CLIENT_KIND));
      put('status', optChoice(input, 'status', CLIENT_STATUS));
      put('value_eur', optNum(input, 'value_eur'));
      put('follow_up', optIsoDate(input, 'follow_up'));

      const color = optStr(input, 'color', 9);
      if (color) {
        if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ActionError('Geef de kleur als hexcode, bijvoorbeeld #FFD966.');
        patch.color = color;
      }
      if (Array.isArray(input.tags)) {
        patch.tags = (input.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      const labels: Record<string, string> = {
        address_line1: 'adres', address_line2: 'adresregel 2', postal_code: 'postcode', city: 'plaats',
        country: 'land', vat_number: 'btw-nummer', kvk_number: 'KVK-nummer', client_kind: 'soort klant',
        status: 'status', value_eur: 'klantwaarde', tags: 'labels', color: 'kleur', follow_up: 'opvolgdatum',
      };
      return {
        title: `Klantgegevens bijwerken: ${client.name}`,
        sub: joinShort(Object.keys(patch).map((k) => labels[k] ?? k)),
        kind: 'work',
        payload: { client_id: clientId, client_name: client.name, patch },
      };
    },
  },

  {
    id: 'client.set_custom_fields',
    label: 'Eigen klantvelden invullen bij een klant',
    module: 'clients',
    kind: 'write',
    description:
      'Vult de zelf verzonnen velden van een klant in (bijvoorbeeld "Pakket" of "Contractdatum"). Diezelfde waarden gebruik je in mailings als variabele {{veld.<sleutel>}}. ' +
      'Vraag eerst welke velden er zijn met `client_field.list`; gebruik exact die sleutels. Wat je niet noemt blijft staan.',
    keywords: ['vrij veld', 'eigen veld', 'custom field', 'variabele', 'merge', 'pakket'],
    input: {
      client_id: { type: 'string' },
      values: {
        type: 'object',
        description: 'Sleutel-waardeparen: {"pakket": "Premium", "contractdatum": "2026-01-01"}. Een lege waarde maakt het veld leeg.',
        additionalProperties: true,
      },
    },
    required: ['client_id', 'values'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const client = await row<{ name: string; custom_fields: Record<string, unknown> | null }>(
        ctx, 'clients', clientId, 'name, custom_fields', 'Klant');
      const raw = (input.values && typeof input.values === 'object') ? input.values as Record<string, unknown> : {};
      const keys = Object.keys(raw);
      if (keys.length === 0) throw new ActionError('Geef minstens één veld met een waarde.');

      const { data: defs, error } = await orgQuery(ctx, 'client_field_definitions', 'field_key, label, field_type, options, is_archived');
      if (error) throw new ActionError(`Klantvelden ophalen mislukt: ${error.message}`);
      const byKey = new Map<string, Record<string, unknown>>((defs ?? []).map((d: Record<string, unknown>) => [String(d.field_key), d]));

      const merged: Record<string, unknown> = { ...(client.custom_fields ?? {}) };
      const described: string[] = [];
      for (const key of keys) {
        const def = byKey.get(key);
        if (!def) throw new ActionError(`Het veld "${key}" bestaat niet. Bekende velden: ${[...byKey.keys()].join(', ') || 'geen'}.`);
        if (def.is_archived) throw new ActionError(`Het veld "${key}" is gearchiveerd en wordt niet meer ingevuld.`);
        const value = raw[key];
        const options = Array.isArray(def.options) ? (def.options as unknown[]).map(String) : [];
        if (def.field_type === 'select' && value !== null && value !== '' && !options.includes(String(value))) {
          throw new ActionError(`"${value}" is geen keuze bij "${def.label}". Kies uit: ${options.join(', ')}.`);
        }
        merged[key] = value === '' ? null : value;
        described.push(`${def.label}: ${value === '' || value === null ? '—' : String(value)}`);
      }
      return {
        title: `Klantvelden invullen bij ${client.name}`,
        sub: joinShort(described),
        kind: 'work',
        payload: { client_id: clientId, client_name: client.name, custom_fields: merged },
      };
    },
  },

  {
    id: 'client.send_portal_welcome',
    label: 'Welkomstmail met portaaltoegang naar de klant sturen',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description:
      'Stuurt de klant een uitnodiging voor het klantportaal, waar hij zijn offertes, facturen en tickets ziet. Dit is ECHTE POST naar buiten en geeft toegang — zeg in je antwoord naar welk adres hij gaat. ' +
      'De klant moet een e-mailadres hebben.',
    keywords: ['welkomstmail', 'portaal', 'uitnodiging', 'toegang', 'portal'],
    input: { client_id: { type: 'string' } },
    required: ['client_id'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const client = await row<{ name: string; email: string | null }>(ctx, 'clients', clientId, 'name, email', 'Klant');
      if (!client.email) throw new ActionError(`${client.name} heeft geen e-mailadres; vul dat eerst in.`);
      return {
        title: `Portaaluitnodiging sturen aan ${client.name}`,
        sub: `naar ${client.email}`,
        warning: 'De mail gaat echt de deur uit en geeft toegang tot al zijn offertes, facturen en tickets.',
        kind: 'mail',
        payload: { client_id: clientId, client_name: client.name, email: client.email },
      };
    },
  },

  {
    id: 'client_contact.set_active',
    label: 'Contactpersoon actief of inactief zetten',
    module: 'clients',
    kind: 'write',
    description:
      'Zet een contactpersoon van een klant op inactief (hij telt niet meer mee als ontvanger en verliest portaaltoegang) of weer op actief. Zoek hem eerst met `list_client_contacts`.',
    keywords: ['contactpersoon', 'deactiveren', 'inactief', 'uit dienst'],
    input: {
      contact_id: { type: 'string' },
      is_active: { type: 'boolean', description: 'true = weer actief, false = op inactief zetten.' },
    },
    required: ['contact_id', 'is_active'],
    async plan(ctx, input) {
      const contactId = id(input, 'contact_id');
      const contact = await row<{ name: string; client_id: string; is_active: boolean }>(
        ctx, 'client_contacts', contactId, 'name, client_id, is_active', 'Contactpersoon');
      const active = bool(input, 'is_active', true);
      if (contact.is_active === active) throw new ActionError(`${contact.name} staat al ${active ? 'actief' : 'inactief'}.`);
      const client = await row<{ name: string }>(ctx, 'clients', contact.client_id, 'name', 'Klant');
      return {
        title: `${contact.name} op ${active ? 'actief' : 'inactief'} zetten`,
        sub: `${client.name}${active ? '' : ' — hij krijgt geen post meer en verliest portaaltoegang'}`,
        kind: 'work',
        payload: { contact_id: contactId, client_id: contact.client_id, name: contact.name, is_active: active },
      };
    },
  },

  {
    id: 'client_field.list',
    label: 'Eigen klantvelden bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft de zelf gedefinieerde klantvelden: sleutel, label, soort, keuzes en of het veld gearchiveerd is. De sleutel is tegelijk de variabele in mailings: {{veld.<sleutel>}}.',
    keywords: ['vrije velden', 'eigen velden', 'variabelen', 'merge tokens'],
    input: { include_archived: { type: 'boolean', description: 'Ook gearchiveerde velden meesturen.' } },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'client_field_definitions',
        'id, field_key, label, field_type, options, help_text, default_fallback, position, show_in_list, is_archived')
        .order('position', { ascending: true });
      if (!bool(input, 'include_archived', false)) query = query.eq('is_archived', false);
      const { data, error } = await query;
      if (error) throw new ActionError(`Klantvelden ophalen mislukt: ${error.message}`);
      return { fields: data ?? [] };
    },
  },

  {
    id: 'client_field.create',
    label: 'Eigen klantveld toevoegen',
    module: 'clients',
    kind: 'write',
    description:
      'Maakt een nieuw vrij klantveld aan dat daarna bij elke klant in te vullen is en als variabele {{veld.<sleutel>}} in mailings bruikbaar is. ' +
      'De sleutel is blijvend: kies iets korts en zonder spaties (bv. "pakket"). Bij soort "select" of "multiselect" zijn de keuzes verplicht.',
    keywords: ['veld toevoegen', 'vrij veld', 'eigen veld', 'variabele'],
    input: {
      field_key: { type: 'string', description: 'Korte sleutel, kleine letters, cijfers en liggende streepjes.' },
      label: { type: 'string', description: 'Wat er boven het veld staat.' },
      field_type: { type: 'string', enum: [...FIELD_TYPES] },
      options: { type: 'array', items: { type: 'string' }, description: 'Keuzes bij select/multiselect.' },
      help_text: { type: 'string' },
      default_fallback: { type: 'string', description: 'Terugvaltekst in mailings als de klant het veld leeg heeft.' },
      show_in_list: { type: 'boolean', description: 'Als kolom tonen in het klantenoverzicht.' },
    },
    required: ['field_key', 'label', 'field_type'],
    async plan(ctx, input) {
      const key = str(input, 'field_key', 60).toLowerCase();
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new ActionError('De sleutel begint met een letter en bevat alleen kleine letters, cijfers en liggende streepjes.');
      const label = str(input, 'label', 120);
      const type = choice(input, 'field_type', FIELD_TYPES);
      const options = Array.isArray(input.options) ? (input.options as unknown[]).map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : [];
      if ((type === 'select' || type === 'multiselect') && options.length === 0) {
        throw new ActionError('Een keuzelijst heeft minstens één keuze nodig.');
      }
      const { data: existing } = await orgQuery(ctx, 'client_field_definitions', 'field_key').eq('field_key', key).maybeSingle();
      if (existing) throw new ActionError(`Er bestaat al een klantveld met de sleutel "${key}".`);
      const { count } = await ctx.db.from('client_field_definitions')
        .select('id', { count: 'exact', head: true }).eq('organization_id', ctx.organizationId);
      return {
        title: `Eigen klantveld toevoegen: ${label}`,
        sub: joinShort([`sleutel {{veld.${key}}}`, type, options.length ? `keuzes: ${options.join(', ')}` : null]),
        kind: 'work',
        payload: {
          field_key: key, label, field_type: type, options,
          help_text: optStr(input, 'help_text', 300),
          default_fallback: optStr(input, 'default_fallback', 200),
          show_in_list: bool(input, 'show_in_list', false),
          position: count ?? 0,
        },
      };
    },
  },

  {
    id: 'client_field.update',
    label: 'Eigen klantveld hernoemen of aanpassen',
    module: 'clients',
    kind: 'write',
    description:
      'Past label, hulptekst, terugvalwaarde, keuzes, volgorde of zichtbaarheid van een bestaand klantveld aan. De sleutel blijft ongewijzigd — die zit in mailings verwerkt. ' +
      'Let op bij het weghalen van keuzes: klanten die zo\'n keuze al hadden, houden die waarde.',
    keywords: ['veld hernoemen', 'veld aanpassen', 'keuzes wijzigen'],
    input: {
      field_id: { type: 'string' },
      label: { type: 'string' },
      help_text: { type: 'string' },
      default_fallback: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      show_in_list: { type: 'boolean' },
    },
    required: ['field_id'],
    async plan(ctx, input) {
      const fieldId = id(input, 'field_id');
      const field = await row<{ label: string; field_key: string; field_type: string }>(
        ctx, 'client_field_definitions', fieldId, 'label, field_key, field_type', 'Klantveld');
      const patch: Record<string, unknown> = {};
      const label = optStr(input, 'label', 120);
      if (label) patch.label = label;
      if (input.help_text !== undefined) patch.help_text = optStr(input, 'help_text', 300);
      if (input.default_fallback !== undefined) patch.default_fallback = optStr(input, 'default_fallback', 200);
      if (typeof input.show_in_list === 'boolean') patch.show_in_list = input.show_in_list;
      if (Array.isArray(input.options)) {
        const options = (input.options as unknown[]).map((o) => String(o).trim()).filter(Boolean).slice(0, 50);
        if ((field.field_type === 'select' || field.field_type === 'multiselect') && options.length === 0) {
          throw new ActionError('Een keuzelijst heeft minstens één keuze nodig.');
        }
        patch.options = options;
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');
      return {
        title: `Klantveld aanpassen: ${field.label}`,
        sub: joinShort([`{{veld.${field.field_key}}}`, ...Object.keys(patch)]),
        kind: 'work',
        payload: { field_id: fieldId, label: field.label, patch },
      };
    },
  },

  {
    id: 'client_field.archive',
    label: 'Eigen klantveld archiveren of terugzetten',
    module: 'clients',
    kind: 'write',
    description:
      'Archiveert een klantveld (het verdwijnt uit de formulieren maar de ingevulde waarden blijven bewaard) of haalt het weer terug. Dit is de zachte manier om een veld af te schaffen; echt verwijderen kan alleen handmatig.',
    keywords: ['veld archiveren', 'veld uitzetten', 'veld terugzetten'],
    input: {
      field_id: { type: 'string' },
      is_archived: { type: 'boolean', description: 'true = archiveren, false = terugzetten.' },
    },
    required: ['field_id', 'is_archived'],
    async plan(ctx, input) {
      const fieldId = id(input, 'field_id');
      const field = await row<{ label: string; is_archived: boolean }>(ctx, 'client_field_definitions', fieldId, 'label, is_archived', 'Klantveld');
      const archived = bool(input, 'is_archived', true);
      if (field.is_archived === archived) throw new ActionError(`"${field.label}" is al ${archived ? 'gearchiveerd' : 'actief'}.`);
      return {
        title: `Klantveld ${archived ? 'archiveren' : 'terugzetten'}: ${field.label}`,
        sub: archived ? 'de ingevulde waarden blijven bewaard' : 'het veld verschijnt weer op de klantkaart',
        kind: 'work',
        payload: { field_id: fieldId, label: field.label, is_archived: archived },
      };
    },
  },

  {
    id: 'inbox.list',
    label: 'Opvangbak met niet-gekoppelde post bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Toont binnengekomen e-mail die niet automatisch bij een klant te plaatsen was: afzender, onderwerp, ontvangstmoment en de klanten waar hij op zou kunnen slaan. ' +
      'Categorie "human" is echte post van mensen, "automated" zijn notificaties en nieuwsbrieven.',
    keywords: ['opvangbak', 'inbox', 'ongekoppelde mail', 'binnengekomen post'],
    input: {
      category: { type: 'string', enum: ['human', 'automated'], description: 'Standaard "human".' },
      limit: { type: 'number', description: 'Maximaal aantal berichten (standaard 25).' },
    },
    async read(ctx, input) {
      const category = optChoice(input, 'category', ['human', 'automated'] as const) ?? 'human';
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
      const { data, error } = await orgQuery(ctx, 'inbound_messages',
        'id, sender_email, sender_name, subject, received_at, status, candidates, alias_id')
        .eq('category', category).in('status', ['unmatched', 'conflict'])
        .order('received_at', { ascending: false }).limit(limit);
      if (error) throw new ActionError(`Opvangbak ophalen mislukt: ${error.message}`);
      return { category, messages: data ?? [] };
    },
  },

  {
    id: 'inbox.link',
    label: 'Binnengekomen bericht aan een klant koppelen',
    module: 'clients',
    kind: 'write',
    description:
      'Zet een bericht uit de opvangbak alsnog in het dossier van een klant. Zoek het bericht met `inbox.list` en de klant met `search_clients`. ' +
      '`remember_sender` maakt van de afzender een contactpersoon zodat volgende post vanzelf goed terechtkomt — dat is een BLIJVENDE route, dus alleen als de gebruiker daarom vraagt.',
    keywords: ['koppelen', 'opvangbak', 'aan klant hangen'],
    input: {
      message_id: { type: 'string' },
      client_id: { type: 'string' },
      remember_sender: { type: 'boolean', description: 'Afzender als contactpersoon bewaren. Standaard uit.' },
    },
    required: ['message_id', 'client_id'],
    async plan(ctx, input) {
      const messageId = id(input, 'message_id');
      const clientId = id(input, 'client_id');
      const message = await row<{ subject: string; sender_email: string | null }>(
        ctx, 'inbound_messages', messageId, 'subject, sender_email', 'Bericht');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const remember = bool(input, 'remember_sender', false);
      return {
        title: `Bericht koppelen aan ${client.name}`,
        sub: joinShort([message.subject || '(geen onderwerp)', message.sender_email, remember ? 'afzender wordt contactpersoon' : null]),
        kind: 'mail',
        payload: { message_id: messageId, client_id: clientId, client_name: client.name, remember_sender: remember },
      };
    },
  },

  {
    id: 'inbox.ignore',
    label: 'Binnengekomen bericht negeren',
    module: 'clients',
    kind: 'write',
    description:
      'Haalt een bericht uit de opvangbak zonder het aan een klant te koppelen (status "dropped"), of zet een genegeerd bericht juist terug op de lijst.',
    keywords: ['negeren', 'wegzetten', 'terugzetten', 'opvangbak'],
    input: {
      message_id: { type: 'string' },
      status: { type: 'string', enum: ['dropped', 'unmatched'], description: 'dropped = negeren, unmatched = terugzetten.' },
    },
    required: ['message_id', 'status'],
    async plan(ctx, input) {
      const messageId = id(input, 'message_id');
      const status = choice(input, 'status', ['dropped', 'unmatched'] as const);
      const message = await row<{ subject: string; sender_email: string | null }>(
        ctx, 'inbound_messages', messageId, 'subject, sender_email', 'Bericht');
      return {
        title: status === 'dropped' ? 'Bericht negeren' : 'Bericht terugzetten in de opvangbak',
        sub: joinShort([message.subject || '(geen onderwerp)', message.sender_email]),
        kind: 'mail',
        payload: { message_id: messageId, status },
      };
    },
  },

  {
    id: 'client_email.list',
    label: 'E-mailgeschiedenis met een klant bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft de in- en uitgaande berichten in het dossier van één klant: richting, onderwerp, afzender/ontvanger en datum. Handig om te zien wanneer je iemand voor het laatst schreef of wat er nog openstaat.',
    keywords: ['mailgeschiedenis', 'correspondentie', 'berichten', 'thread'],
    input: {
      client_id: { type: 'string' },
      limit: { type: 'number', description: 'Maximaal aantal berichten (standaard 20).' },
    },
    required: ['client_id'],
    async read(ctx, input) {
      const clientId = id(input, 'client_id');
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
      // Verwijderde berichten horen hier niet bij. De app leunt daarvoor op RLS, maar
      // dit draait met de service-role en die slaat RLS over — dus zelf filteren.
      const { data, error } = await orgQuery(ctx, 'client_emails',
        'id, direction, subject, from_email, to_email, created_at, status')
        .eq('client_id', clientId).is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(limit);
      if (error) throw new ActionError(`Berichten ophalen mislukt: ${error.message}`);
      return { client_id: clientId, emails: data ?? [] };
    },
  },

  {
    id: 'folder.create',
    label: 'Map aanmaken in het klantdossier',
    module: 'content',
    kind: 'write',
    description:
      'Maakt een map aan onder een klant (en optioneel binnen een projectmap of een bestaande map). Mappen zijn de indeling van het klantdossier en van de Inhoud-verkenner; notities, documenten en bestanden gaan erin.',
    keywords: ['map', 'folder', 'dossier', 'indeling'],
    input: {
      client_id: { type: 'string', description: 'Klant waar de map onder valt.' },
      name: { type: 'string' },
      parent_id: { type: 'string', description: 'Id van de bovenliggende map (optioneel).' },
      project_id: { type: 'string', description: 'Alleen als de map binnen een projectmap hoort.' },
    },
    required: ['client_id', 'name'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const name = str(input, 'name', 120);
      const parentId = optId(input, 'parent_id');
      const projectId = optId(input, 'project_id');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      let parentName: string | null = null;
      if (parentId) {
        const parent = await row<{ name: string; client_id: string | null }>(ctx, 'content_folders', parentId, 'name, client_id', 'Bovenliggende map');
        if (parent.client_id && parent.client_id !== clientId) throw new ActionError('De bovenliggende map hoort bij een andere klant.');
        parentName = parent.name;
      }
      if (projectId) {
        const project = await row<{ client_id: string | null }>(ctx, 'projects', projectId, 'client_id', 'Project');
        if (project.client_id && project.client_id !== clientId) throw new ActionError('Dat project hoort bij een andere klant.');
      }
      return {
        title: `Map aanmaken: ${name}`,
        sub: joinShort([client.name, parentName ? `in ${parentName}` : null]),
        kind: 'work',
        payload: { client_id: clientId, name, parent_id: parentId, project_id: projectId },
      };
    },
  },

  {
    id: 'folder.rename',
    label: 'Map hernoemen',
    module: 'content',
    kind: 'write',
    description: 'Geeft een bestaande map in het klantdossier een andere naam. De inhoud blijft ongemoeid.',
    keywords: ['map hernoemen', 'folder'],
    input: { folder_id: { type: 'string' }, name: { type: 'string' } },
    required: ['folder_id', 'name'],
    async plan(ctx, input) {
      const folderId = id(input, 'folder_id');
      const name = str(input, 'name', 120);
      const folder = await row<{ name: string }>(ctx, 'content_folders', folderId, 'name', 'Map');
      if (folder.name === name) throw new ActionError('De map heet al zo.');
      return {
        title: `Map hernoemen: ${folder.name}`,
        sub: `wordt "${name}"`,
        kind: 'work',
        payload: { folder_id: folderId, name, was: folder.name },
      };
    },
  },

  {
    id: 'content.move',
    label: 'Notitie of document naar een andere map verplaatsen',
    module: 'content',
    kind: 'write',
    description:
      'Zet een bestaande notitie of een intern document in een andere map van het klantdossier, of haalt hem juist uit een map (laat `folder_id` dan weg). Zoek het item met `list_content` en de map met `folder.list`.',
    keywords: ['verplaatsen', 'map', 'opruimen', 'archiveren'],
    input: {
      kind: { type: 'string', enum: ['note', 'document'] },
      item_id: { type: 'string' },
      folder_id: { type: 'string', description: 'Doelmap; weglaten betekent uit de map halen.' },
    },
    required: ['kind', 'item_id'],
    async plan(ctx, input) {
      const kind = choice(input, 'kind', ['note', 'document'] as const);
      const itemId = id(input, 'item_id');
      const folderId = optId(input, 'folder_id');
      const table = kind === 'note' ? 'notes' : 'documents';
      const item = await row<{ title: string; client_id: string | null }>(ctx, table, itemId, 'title, client_id', kind === 'note' ? 'Notitie' : 'Document');
      let folderName = 'geen map';
      if (folderId) {
        const folder = await row<{ name: string; client_id: string | null }>(ctx, 'content_folders', folderId, 'name, client_id', 'Map');
        if (folder.client_id && item.client_id && folder.client_id !== item.client_id) {
          throw new ActionError('Die map hoort bij een andere klant dan dit item.');
        }
        folderName = folder.name;
      }
      return {
        title: `${kind === 'note' ? 'Notitie' : 'Document'} verplaatsen: ${item.title}`,
        sub: `naar ${folderName}`,
        kind: 'work',
        payload: { kind, item_id: itemId, folder_id: folderId, title: item.title, folder_name: folderName },
      };
    },
  },

  {
    id: 'folder.list',
    label: 'Mappen van een klantdossier bekijken',
    module: 'content',
    kind: 'read',
    description: 'Geeft de mappenstructuur van een klant (of van de hele organisatie), met id, naam, bovenliggende map en eventuele projectkoppeling.',
    keywords: ['mappen', 'folders', 'dossierstructuur'],
    input: {
      client_id: { type: 'string', description: 'Beperk tot één klant (optioneel).' },
    },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'content_folders', 'id, name, parent_id, client_id, project_id, position')
        .order('position', { ascending: true }).limit(500);
      const clientId = optId(input, 'client_id');
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query;
      if (error) throw new ActionError(`Mappen ophalen mislukt: ${error.message}`);
      return { folders: data ?? [] };
    },
  },

  {
    id: 'client_contact.set_portal_access',
    label: 'Portaaltoegang van contactpersonen aan- of uitzetten',
    module: 'clients',
    kind: 'write',
    description:
      'Geeft één of meer contactpersonen toegang tot het klantportaal, of neemt die toegang weer af. Met toegang kan die persoon inloggen op /portal en de offertes, facturen en tickets van zijn bedrijf zien.',
    keywords: ['portaal', 'toegang', 'portal', 'inloggen', 'contactpersoon'],
    input: {
      contact_ids: { type: 'array', items: { type: 'string' }, description: 'Id\'s van contactpersonen.' },
      gives_portal_access: { type: 'boolean' },
    },
    required: ['contact_ids', 'gives_portal_access'],
    async plan(ctx, input) {
      const contactIds = ids(input, 'contact_ids', 25);
      const grant = bool(input, 'gives_portal_access', true);
      const { data, error } = await orgQuery(ctx, 'client_contacts', 'id, name, email, gives_portal_access').in('id', contactIds);
      if (error) throw new ActionError(`Contactpersonen ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];
      if (rows.length === 0) throw new ActionError('Geen van deze contactpersonen bestaat in deze organisatie.');
      const changing = rows.filter((r) => Boolean(r.gives_portal_access) !== grant);
      if (changing.length === 0) throw new ActionError(`Die contactpersonen hebben al ${grant ? 'wel' : 'geen'} portaaltoegang.`);
      return {
        title: `Portaaltoegang ${grant ? 'geven' : 'intrekken'} voor ${changing.length} contactperso${changing.length === 1 ? 'on' : 'nen'}`,
        sub: joinShort(changing.map((r) => String(r.name))),
        kind: 'work',
        payload: { contact_ids: changing.map((r) => String(r.id)), names: changing.map((r) => String(r.name)), gives_portal_access: grant },
      };
    },
  },
];
