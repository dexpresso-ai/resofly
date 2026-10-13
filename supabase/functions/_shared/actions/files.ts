import {
  ActionError, bool, choice, id, joinShort, optChoice, optId, optIsoDate, optNum, optStr, orgQuery, row,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond BESTANDEN VERSTUREN: een zending met bestanden, notities of
 * documenten uit Inhoud naar de klant of een contactpersoon, met een
 * vervaldatum. Na die datum (of na intrekken) worden de kopieën verwijderd;
 * wie wat kreeg en wanneer blijft staan.
 *
 * De vaste regel geldt hier net zo hard als in het scherm: klantbestanden gaan
 * alleen naar het hoofdadres van díe klant of naar een actieve contactpersoon
 * van die klant. Een los e-mailadres kan alleen bij bestanden die bij geen
 * klant horen. De database bewaakt dat ook (triggers op file_transfer_recipients);
 * deze controle zorgt dat de kaart niets belooft wat daarna wordt geweigerd.
 */

const SOURCE_TYPES = ['attachment', 'note', 'document', 'folder'] as const;
type SourceType = typeof SOURCE_TYPES[number];
const SOURCE_LABEL: Record<SourceType, string> = { attachment: 'Bestand', note: 'Notitie', document: 'Document', folder: 'Map' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SOURCES = 50;
const MAX_RECIPIENTS = 25;
const MIGRATION_HINT = 'Bestanden versturen is in deze omgeving nog niet beschikbaar (migratie 20261013100000).';

type Source = { type: SourceType; id: string; name: string; clientId: string | null; clientName: string | null };

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '42P01' || /relation .* does not exist/i.test(error?.message ?? '');
}

/** Waar hoort dit item bij? Dezelfde afleiding als de database (drive_item_client). */
async function sourceContext(ctx: ActionCtx, type: SourceType, sourceId: string): Promise<Source> {
  if (type === 'attachment') {
    // Alleen bestanden uit Inhoud, net als het verstuurvenster: een bijlage van een
    // taak, ticket of project hoort bij een andere module.
    const attachment = await row<{ entity_type: string }>(ctx, 'attachments', sourceId, 'entity_type', 'Bestand');
    if (attachment.entity_type !== 'folder') {
      throw new ActionError(`Bestand ${sourceId} staat niet in Inhoud (het is een bijlage van een ${attachment.entity_type}). Alleen bestanden uit Inhoud kunnen mee; zoek ze met \`files.list\`.`);
    }
  }
  const { data, error } = await ctx.db.rpc('drive_item_client', {
    p_organization_id: ctx.organizationId,
    p_item_type: type,
    p_item_id: sourceId,
  });
  const found = (Array.isArray(data) ? data[0] : data) as { client_id?: string | null; client_name?: string | null; item_name?: string | null } | null;
  if (error || !found) throw new ActionError(`${SOURCE_LABEL[type]} ${sourceId} bestaat niet (meer) in deze organisatie.`);
  return { type, id: sourceId, name: found.item_name || SOURCE_LABEL[type], clientId: found.client_id ?? null, clientName: found.client_name ?? null };
}

function parseSources(input: Record<string, unknown>): Array<{ type: SourceType; id: string }> {
  const raw = Array.isArray(input.items) ? input.items as unknown[] : [];
  const out: Array<{ type: SourceType; id: string }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const type = choice(item, 'type', SOURCE_TYPES);
    const sourceId = id(item, 'id');
    if (seen.has(`${type}:${sourceId}`)) continue;
    seen.add(`${type}:${sourceId}`);
    out.push({ type, id: sourceId });
  }
  if (out.length === 0) throw new ActionError('"items" heeft minstens één bestand, notitie, document of map nodig. Zoek bestanden met `files.list`.');
  if (out.length > MAX_SOURCES) throw new ActionError(`Stuur hoogstens ${MAX_SOURCES} items tegelijk; kies liever een map.`);
  return out;
}

function stringList(input: Record<string, unknown>, key: string): string[] {
  const raw = Array.isArray(input[key]) ? input[key] as unknown[] : [];
  return [...new Set(raw.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function expiryDays(input: Record<string, unknown>): number {
  const days = optNum(input, 'expires_in_days') ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ActionError('"expires_in_days" moet een heel aantal dagen zijn, van 1 tot en met 365.');
  return days;
}

function dateNl(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export const FILES_ACTIONS: ActionDef[] = [
  {
    id: 'files.list',
    label: 'Bestanden in Inhoud zoeken',
    module: 'content',
    kind: 'read',
    description:
      'Zoekt geüploade bestanden in Inhoud (de mappen van de klantdossiers): id, naam, grootte, map en klant. Gebruik het id met `files.send` om ze te versturen. Notities en documenten vind je met `list_content`, mappen met `folder.list`.',
    keywords: ['bestanden', 'bestand', 'pdf', 'upload', 'inhoud', 'dossier', 'map', 'zoeken'],
    input: {
      client_id: { type: 'string', description: 'Alleen bestanden in de mappen van deze klant (optioneel).' },
      folder_id: { type: 'string', description: 'Alleen bestanden in deze map en de mappen eronder (optioneel).' },
      query: { type: 'string', description: 'Zoek in de bestandsnaam.' },
      limit: { type: 'integer', description: 'Hoeveel (standaard 50, hoogstens 200).' },
    },
    async read(ctx, input) {
      const clientId = optId(input, 'client_id');
      const folderId = optId(input, 'folder_id');
      const query = (optStr(input, 'query', 120) ?? '').toLowerCase();
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 50), 1), 200);

      const { data: folderRows, error: folderError } = await orgQuery(ctx, 'content_folders', 'id, name, parent_id, client_id').limit(5000);
      if (folderError) throw new ActionError(`Mappen ophalen mislukt: ${folderError.message}`);
      const folders = (folderRows ?? []) as Array<{ id: string; name: string; parent_id: string | null; client_id: string | null }>;
      const byId = new Map(folders.map((folder) => [folder.id, folder]));
      const path = (start: string | null) => {
        const names: string[] = [];
        let current = start ? byId.get(start) : undefined;
        for (let guard = 0; current && guard < 50; guard += 1) {
          names.unshift(current.name);
          current = current.parent_id ? byId.get(current.parent_id) : undefined;
        }
        return names.join(' / ');
      };
      const within = (start: string | null) => {
        if (!folderId) return true;
        let current = start ? byId.get(start) : undefined;
        for (let guard = 0; current && guard < 50; guard += 1) {
          if (current.id === folderId) return true;
          current = current.parent_id ? byId.get(current.parent_id) : undefined;
        }
        return false;
      };

      const { data, error } = await orgQuery(ctx, 'attachments', 'id, name, size_bytes, mime_type, entity_id, created_at')
        .eq('entity_type', 'folder')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw new ActionError(`Bestanden ophalen mislukt: ${error.message}`);
      const files = ((data ?? []) as Array<{ id: string; name: string; size_bytes: number | null; mime_type: string | null; entity_id: string; created_at: string }>)
        .filter((file) => byId.has(file.entity_id))
        .filter((file) => !clientId || byId.get(file.entity_id)?.client_id === clientId)
        .filter((file) => within(file.entity_id))
        .filter((file) => !query || file.name.toLowerCase().includes(query))
        .slice(0, limit)
        .map((file) => ({
          id: file.id,
          name: file.name,
          size_bytes: file.size_bytes,
          mime_type: file.mime_type,
          folder_id: file.entity_id,
          folder: path(file.entity_id),
          client_id: byId.get(file.entity_id)?.client_id ?? null,
          uploaded_at: file.created_at,
        }));
      return { files };
    },
  },

  {
    id: 'files.send',
    label: 'Bestanden veilig versturen naar een klant',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description:
      'Verstuurt bestanden, notities, documenten of hele mappen uit Inhoud als beveiligde zending: de ontvanger krijgt een mail met een persoonlijke link en opent de bestanden met een code die naar het eigen adres gaat. ' +
      'Ze blijven beschikbaar tot de vervaldatum (standaard 30 dagen, hoogstens 365) en worden daarna verwijderd. ' +
      'Bestanden van een klant gaan ALLEEN naar het hoofdadres van die klant (`send_to_client`) of naar contactpersonen van die klant (`contact_ids`, zoek ze met `list_client_contacts`). ' +
      'Een los e-mailadres (`emails`) kan alleen bij bestanden die bij geen klant horen. Alle items moeten bij dezelfde klant horen. Bestanden zoek je met `files.list`, notities en documenten met `list_content`.',
    keywords: ['versturen', 'sturen', 'verzenden', 'bestanden', 'bestand', 'delen', 'wetransfer', 'downloadlink', 'pdf', 'opleveren', 'klant', 'contactpersoon'],
    input: {
      items: {
        type: 'array',
        description: 'Wat er mee moet: { type, id } per item. type is attachment (bestand), note, document of folder (de hele map).',
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: [...SOURCE_TYPES] }, id: { type: 'string' } },
          required: ['type', 'id'],
        },
      },
      send_to_client: { type: 'boolean', description: 'Naar het hoofdadres van de klant van deze bestanden.' },
      contact_ids: { type: 'array', items: { type: 'string' }, description: 'Contactpersonen van díe klant.' },
      emails: { type: 'array', items: { type: 'string' }, description: 'Losse adressen; alleen bij bestanden die bij geen klant horen.' },
      subject: { type: 'string', description: 'Onderwerp van de mail (optioneel).' },
      message: { type: 'string', description: 'Kort bericht bij de bestanden (optioneel).' },
      expires_in_days: { type: 'integer', description: 'Hoeveel dagen beschikbaar (1–365, standaard 30).' },
      allow_download: { type: 'boolean', description: 'Downloaden toestaan (standaard ja). Uit = alleen teksten lezen.' },
    },
    required: ['items'],
    async plan(ctx, input) {
      const requested = parseSources(input);
      const sources: Source[] = [];
      for (const source of requested) sources.push(await sourceContext(ctx, source.type, source.id));

      const clients = new Set(sources.map((source) => source.clientId ?? ''));
      if (clients.size > 1) throw new ActionError('Deze items komen uit verschillende klantdossiers. Een zending hoort bij één klant: verstuur ze per klant.');
      const clientId = sources[0].clientId;

      const sendToClient = bool(input, 'send_to_client');
      const contactIds = stringList(input, 'contact_ids');
      const emails = stringList(input, 'emails').map((email) => email.toLowerCase());
      if (sendToClient && !clientId) {
        throw new ActionError('Deze items horen bij geen klant, dus er is geen hoofdadres. Geef de ontvangers op met `emails`.');
      }

      const recipients: Array<Record<string, unknown>> = [];
      const names: string[] = [];
      let clientName: string | null = null;

      if (clientId) {
        if (emails.length > 0) {
          throw new ActionError('Klantbestanden gaan alleen naar de klant zelf of een contactpersoon van die klant. Voeg de ontvanger eerst toe als contactpersoon, en gebruik dan `contact_ids`.');
        }
        const client = await row<{ name: string; email: string | null }>(ctx, 'clients', clientId, 'name, email', 'Klant');
        clientName = client.name;
        if (sendToClient) {
          const email = (client.email ?? '').trim().toLowerCase();
          if (!EMAIL_RE.test(email)) throw new ActionError(`${client.name} heeft geen geldig e-mailadres op de klantkaart. Kies een contactpersoon.`);
          recipients.push({ kind: 'client', expectedEmail: email });
          names.push(`${client.name} <${email}>`);
        }
        if (contactIds.length > 0) {
          for (const contactId of contactIds) id({ contact_id: contactId }, 'contact_id');
          const { data, error } = await orgQuery(ctx, 'client_contacts', 'id, name, email, client_id, is_active').in('id', contactIds);
          if (error) throw new ActionError(`Contactpersonen ophalen mislukt: ${error.message}`);
          const found = new Map(((data ?? []) as Array<{ id: string; name: string | null; email: string | null; client_id: string; is_active: boolean | null }>).map((contact) => [contact.id, contact]));
          for (const contactId of contactIds) {
            const contact = found.get(contactId);
            if (!contact) throw new ActionError(`Contactpersoon ${contactId} bestaat niet in deze organisatie.`);
            if (contact.client_id !== clientId) throw new ActionError(`${contact.name || 'Deze contactpersoon'} hoort bij een andere klant dan deze bestanden.`);
            if (contact.is_active === false) throw new ActionError(`${contact.name || 'Deze contactpersoon'} staat op inactief.`);
            const email = (contact.email ?? '').trim().toLowerCase();
            if (!EMAIL_RE.test(email)) throw new ActionError(`${contact.name || 'Deze contactpersoon'} heeft geen geldig e-mailadres.`);
            recipients.push({ kind: 'contact', clientContactId: contact.id, expectedEmail: email });
            names.push(`${contact.name || email} <${email}>`);
          }
        }
      } else {
        if (contactIds.length > 0) throw new ActionError('Deze items horen bij geen klant, dus contactpersonen kunnen niet. Geef de ontvangers op met `emails`.');
        for (const email of emails) {
          if (!EMAIL_RE.test(email) || email.length > 254) throw new ActionError(`"${email}" is geen geldig e-mailadres.`);
          recipients.push({ kind: 'email', email, name: null });
          names.push(email);
        }
      }
      if (recipients.length === 0) {
        throw new ActionError(clientId
          ? 'Kies minstens één ontvanger: `send_to_client` en/of `contact_ids`.'
          : 'Kies minstens één ontvanger met `emails`.');
      }
      if (recipients.length > MAX_RECIPIENTS) throw new ActionError(`Stuur naar hoogstens ${MAX_RECIPIENTS} mensen tegelijk.`);

      const days = expiryDays(input);
      const subject = optStr(input, 'subject', 200);
      const message = optStr(input, 'message', 5000);
      const canDownload = bool(input, 'allow_download', true);
      const until = dateNl(plusDays(days));
      const itemNames = sources.map((source) => source.type === 'folder' ? `map ${source.name}` : source.name);

      return {
        title: `Bestanden versturen${clientName ? ` aan ${clientName}` : ''}: ${subject ?? itemNames[0]}`,
        sub: joinShort([`aan ${names.join(', ')}`, itemNames.join(', '), `beschikbaar tot ${until}`], 160),
        kind: 'mail',
        warning: `De ontvangers krijgen meteen een mail met een persoonlijke link; tot ${until} kunnen ze de bestanden openen${canDownload ? ' en downloaden' : ''}.`,
        payload: {
          client_id: clientId,
          client_name: clientName,
          sources: sources.map((source) => ({ type: source.type, id: source.id, name: source.name })),
          recipients,
          recipient_names: names,
          subject,
          message,
          expires_in_days: days,
          can_download: canDownload,
        },
      };
    },
  },

  {
    id: 'files.list_transfers',
    label: 'Verstuurde bestanden bekijken',
    module: 'content',
    kind: 'read',
    description:
      'Laat zien welke bestanden er verstuurd zijn: per zending het onderwerp, de klant, tot wanneer hij loopt en per ontvanger of de mail aankwam en of de bestanden geopend of gedownload zijn.',
    keywords: ['verstuurd', 'zendingen', 'gedownload', 'geopend', 'bestanden', 'vervaldatum', 'verlopen'],
    input: {
      client_id: { type: 'string', description: 'Alleen zendingen voor deze klant (optioneel).' },
      status: { type: 'string', enum: ['active', 'all'], description: "active (standaard) = lopend; all = ook verlopen en ingetrokken." },
      limit: { type: 'integer', description: 'Hoeveel (standaard 20, hoogstens 100).' },
    },
    async read(ctx, input) {
      const clientId = optId(input, 'client_id');
      const status = optChoice(input, 'status', ['active', 'all'] as const) ?? 'active';
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 20), 1), 100);
      let query = orgQuery(ctx, 'file_transfers', 'id, subject, client_id, status, expires_at, sent_at, revoked_at, item_count, total_bytes, can_download, ticket_id, sender_name')
        .neq('status', 'draft')
        .order('sent_at', { ascending: false })
        .limit(limit);
      if (clientId) query = query.eq('client_id', clientId);
      if (status === 'active') query = query.eq('status', 'sent').gt('expires_at', new Date().toISOString());
      const { data, error } = await query;
      if (error) {
        if (isMissingRelation(error)) throw new ActionError(MIGRATION_HINT);
        throw new ActionError(`Zendingen ophalen mislukt: ${error.message}`);
      }
      const transfers = (data ?? []) as Array<Record<string, unknown> & { id: string }>;
      if (transfers.length === 0) return { transfers: [] };
      const { data: recipientRows, error: recipientError } = await orgQuery(ctx, 'file_transfer_recipients',
        'transfer_id, kind, email, name, delivery_status, notify_error, first_opened_at, first_downloaded_at, download_count, revoked_at')
        .in('transfer_id', transfers.map((transfer) => transfer.id));
      if (recipientError) throw new ActionError(`Ontvangers ophalen mislukt: ${recipientError.message}`);
      const byTransfer = new Map<string, unknown[]>();
      for (const recipient of (recipientRows ?? []) as Array<Record<string, unknown> & { transfer_id: string }>) {
        const { transfer_id: transferId, ...rest } = recipient;
        byTransfer.set(transferId, [...(byTransfer.get(transferId) ?? []), rest]);
      }
      return {
        transfers: transfers.map((transfer) => ({
          ...transfer,
          state: transfer.status === 'sent' && Date.parse(String(transfer.expires_at)) <= Date.now() ? 'expired' : transfer.status,
          recipients: byTransfer.get(transfer.id) ?? [],
        })),
      };
    },
  },

  {
    id: 'files.extend_transfer',
    label: 'Vervaldatum van verstuurde bestanden aanpassen',
    module: 'content',
    kind: 'write',
    description:
      'Verlengt (of verkort) hoe lang een lopende zending beschikbaar is. Geef `expires_in_days` (vanaf vandaag) of een datum `until` (JJJJ-MM-DD, tot en met die dag). Een verlopen of ingetrokken zending kan niet meer: de bestanden zijn dan al verwijderd.',
    keywords: ['verlengen', 'vervaldatum', 'langer', 'beschikbaar', 'zending', 'bestanden'],
    input: {
      transfer_id: { type: 'string', description: 'Zoek hem met `files.list_transfers`.' },
      expires_in_days: { type: 'integer', description: 'Dagen vanaf vandaag (1–365).' },
      until: { type: 'string', description: 'Of een datum, JJJJ-MM-DD.' },
    },
    required: ['transfer_id'],
    async plan(ctx, input) {
      const transferId = id(input, 'transfer_id');
      const transfer = await row<{ subject: string; status: string; expires_at: string }>(ctx, 'file_transfers', transferId, 'subject, status, expires_at', 'Zending');
      if (transfer.status !== 'sent' || Date.parse(transfer.expires_at) <= Date.now()) {
        throw new ActionError('Deze zending loopt niet meer (verlopen, ingetrokken of nog een concept). Verstuur de bestanden opnieuw.');
      }
      const until = optIsoDate(input, 'until');
      const days = until ? null : expiryDays(input);
      if (until) {
        const end = Date.parse(`${until}T23:59:59Z`);
        if (end <= Date.now()) throw new ActionError('Die datum ligt in het verleden.');
        if (end > Date.now() + 366 * 86_400_000) throw new ActionError('Een zending blijft hoogstens een jaar beschikbaar.');
      }
      const label = until ? dateNl(`${until}T12:00:00Z`) : dateNl(plusDays(days as number));
      return {
        title: `Zending verlengen: ${transfer.subject}`,
        sub: `was tot ${dateNl(transfer.expires_at)}, wordt tot ${label}`,
        kind: 'work',
        payload: { transfer_id: transferId, subject: transfer.subject, expires_at: until ?? days, label },
      };
    },
  },

  {
    id: 'files.revoke_transfer',
    label: 'Verstuurde bestanden intrekken',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description:
      'Trekt een lopende zending in: alle persoonlijke links werken meteen niet meer en de bestanden worden direct verwijderd. Wie wat kreeg en wanneer blijft zichtbaar. Zoek de zending met `files.list_transfers`.',
    keywords: ['intrekken', 'stoppen', 'link uitzetten', 'verkeerd verstuurd', 'zending', 'bestanden', 'verwijderen'],
    input: {
      transfer_id: { type: 'string' },
    },
    required: ['transfer_id'],
    async plan(ctx, input) {
      const transferId = id(input, 'transfer_id');
      const transfer = await row<{ subject: string; status: string; expires_at: string; item_count: number }>(
        ctx, 'file_transfers', transferId, 'subject, status, expires_at, item_count', 'Zending');
      if (transfer.status !== 'sent' || Date.parse(transfer.expires_at) <= Date.now()) {
        throw new ActionError('Deze zending loopt niet meer: hij is al verlopen, ingetrokken of nog niet verstuurd.');
      }
      return {
        title: `Zending intrekken: ${transfer.subject}`,
        sub: `${transfer.item_count === 1 ? '1 bestand' : `${transfer.item_count} bestanden`} · loopt nu tot ${dateNl(transfer.expires_at)}`,
        kind: 'work',
        warning: 'De links werken direct niet meer en de bestanden worden meteen verwijderd; dat kun je niet terugdraaien.',
        payload: { transfer_id: transferId, subject: transfer.subject },
      };
    },
  },
];
