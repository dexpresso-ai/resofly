import {
  ActionError, bool, id, ids, joinShort, likeSafe, optId, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond de MAPPEN VAN KLANTMAIL (Berichten → mappen per klant,
 * migratie 20261111210000).
 *
 * Zo kan Gerrie, een agent of een gekoppelde AI een map maken, hernoemen,
 * verplaatsen of verwijderen, en mailgesprekken van map naar map zetten. Alles
 * als VOORSTEL: de gebruiker keurt goed, en dan loopt het in de browser langs
 * dezelfde rpc's als de knoppen op Berichten, met de rechten van die gebruiker
 * (`src/lib/actions/mailFolders.ts`).
 *
 * Niet te verwarren met `folder.*` in clients.ts: dat zijn de mappen van het
 * klantdossier voor notities, documenten en bestanden. Een andere tabel, een
 * andere module (Inhoud). De omschrijvingen hieronder zeggen dat ook tegen het
 * model, anders zette het een mailmap klaar in de verkenner van Inhoud.
 *
 * De regels (vijf lagen, één naam per plek, alles binnen één klant) bewaakt de
 * database zelf ook. Ze staan hier nóg een keer zodat een voorstel dat toch zou
 * mislukken niet eerst als kaart bij de gebruiker belandt: liever een fout naar
 * het model, dat het dan zelf rechtzet.
 */

/** Gelijk aan de database (client_email_folders_guard en de naamcheck). */
const MAX_DEPTH = 5;
const MAX_NAME = 80;

interface FolderRow { id: string; client_id: string; parent_id: string | null; name: string }

const NOT_HERE = 'Mappen voor klantmail staan in deze omgeving nog niet aan.';

function missingTable(error: { code?: string; message?: string }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205' || /schema cache|does not exist/i.test(String(error.message ?? ''));
}

/** Alle mailmappen van één klant. */
async function foldersOf(ctx: ActionCtx, clientId: string): Promise<FolderRow[]> {
  const { data, error } = await orgQuery(ctx, 'client_email_folders', 'id, client_id, parent_id, name')
    .eq('client_id', clientId).limit(2000);
  if (error) throw new ActionError(missingTable(error) ? NOT_HERE : `Mappen ophalen mislukt: ${error.message}`);
  return (data ?? []) as FolderRow[];
}

/** Eén mailmap binnen de organisatie, of een leesbare fout. */
async function folderRow(ctx: ActionCtx, folderId: string, label = 'Map'): Promise<FolderRow> {
  const { data, error } = await orgQuery(ctx, 'client_email_folders', 'id, client_id, parent_id, name')
    .eq('id', folderId).maybeSingle();
  if (error) throw new ActionError(missingTable(error) ? NOT_HERE : `${label} ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError(`${label} niet gevonden. Zoek hem op met mail_folder.list en gebruik het exacte folder_id.`);
  return data as FolderRow;
}

/** Witruimte samen en aan de randen weg, net als de database; daarna de grenzen. */
function folderName(input: Record<string, unknown>, key: string): string {
  const name = str(input, key, 400).replace(/\s+/g, ' ').trim();
  if (name.length > MAX_NAME) throw new ActionError(`Een mapnaam is hooguit ${MAX_NAME} tekens.`);
  return name;
}

/** "Project website / Feedback": het pad van boven naar de map zelf. */
function pathOf(folders: FolderRow[], folderId: string | null): string {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const names: string[] = [];
  let cursor = folderId;
  for (let guard = 0; cursor && guard < 50; guard += 1) {
    const folder = byId.get(cursor);
    if (!folder) break;
    names.unshift(folder.name);
    cursor = folder.parent_id;
  }
  return names.join(' / ');
}

/** Op welke laag een map staat: bovenaan = 1. */
function depthOf(folders: FolderRow[], folderId: string): number {
  return pathOf(folders, folderId).split(' / ').filter(Boolean).length;
}

/** Hoeveel lagen een map meeneemt als hij verhuist: zonder submappen 1. */
function heightOf(folders: FolderRow[], folderId: string, guard = 0): number {
  if (guard > 50) return 1;
  let deepest = 0;
  for (const child of folders) if (child.parent_id === folderId) deepest = Math.max(deepest, heightOf(folders, child.id, guard + 1));
  return 1 + deepest;
}

function isInside(folders: FolderRow[], folderId: string, maybeAncestor: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  let cursor = byId.get(folderId)?.parent_id ?? null;
  for (let guard = 0; cursor && guard < 50; guard += 1) {
    if (cursor === maybeAncestor) return true;
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}

/** Staat er op deze plek al een map met deze naam (zonder op hoofdletters te letten)? */
function sameNameAt(folders: FolderRow[], parentId: string | null, name: string, exceptId: string | null = null): FolderRow | null {
  const lower = name.toLocaleLowerCase('nl');
  return folders.find((f) => f.id !== exceptId && (f.parent_id ?? null) === parentId && f.name.toLocaleLowerCase('nl') === lower) ?? null;
}

const placeLabel = (folders: FolderRow[], parentId: string | null) => (parentId ? `in "${pathOf(folders, parentId)}"` : 'bovenaan');

export const MAIL_FOLDER_ACTIONS: ActionDef[] = [
  {
    id: 'mail_folder.list',
    label: 'Mailmappen van een klant bekijken',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft de mappen waarin de MAIL van één klant geordend is (Berichten → mappen per klant): id, naam, het volledige pad, de laag en hoeveel gesprekken er direct in staan, plus hoeveel gesprekken nog in geen map staan. ' +
      'Gebruik dit vóór je een mailmap maakt of mail verplaatst, zodat je bestaande mappen hergebruikt en het exacte folder_id hebt. Niet voor mappen met notities en documenten; dat is folder.list.',
    keywords: ['mailmap', 'mailmappen', 'mappen mail', 'berichten mappen', 'postvak', 'ordenen', 'mappenstructuur mail'],
    input: { client_id: { type: 'string', description: 'De klant.' } },
    required: ['client_id'],
    async read(ctx, input) {
      const clientId = id(input, 'client_id');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const folders = await foldersOf(ctx, clientId);
      const { data, error } = await orgQuery(ctx, 'client_email_threads', 'id, folder_id')
        .eq('client_id', clientId).limit(5000);
      if (error) throw new ActionError(`Gesprekken ophalen mislukt: ${error.message}`);
      const perFolder = new Map<string, number>();
      let unfiled = 0;
      const known = new Set(folders.map((f) => f.id));
      for (const t of (data ?? []) as Array<{ folder_id: string | null }>) {
        if (t.folder_id && known.has(t.folder_id)) perFolder.set(t.folder_id, (perFolder.get(t.folder_id) ?? 0) + 1);
        else unfiled += 1;
      }
      return {
        client_id: clientId,
        client_name: client.name,
        max_depth: MAX_DEPTH,
        folders: folders
          .map((f) => ({ folder_id: f.id, name: f.name, path: pathOf(folders, f.id), parent_id: f.parent_id, depth: depthOf(folders, f.id), threads: perFolder.get(f.id) ?? 0 }))
          .sort((a, b) => a.path.localeCompare(b.path, 'nl', { numeric: true })),
        unfiled_threads: unfiled,
      };
    },
  },

  {
    id: 'mail_thread.list',
    label: 'Mailgesprekken van een klant bekijken, met hun map',
    module: 'clients',
    kind: 'read',
    description:
      'Geeft de mailgesprekken (threads) van één klant, nieuwste eerst: thread_id, onderwerp, laatste bericht, aantal berichten, het begin van het laatste bericht en in welke map het gesprek staat. ' +
      'Dit zijn de thread_id\'s die mail_thread.move nodig heeft. Filter op een map (folder_id), op alleen gesprekken zonder map (unfiled_only), of op een woord in het onderwerp (query).',
    keywords: ['mailgesprekken', 'threads', 'gesprekken', 'mail per map', 'zonder map', 'onderwerp', 'welke mail staat waar'],
    input: {
      client_id: { type: 'string' },
      folder_id: { type: 'string', description: 'Alleen gesprekken direct in deze map (optioneel).' },
      unfiled_only: { type: 'boolean', description: 'Alleen gesprekken die nog in geen map staan.' },
      query: { type: 'string', description: 'Woord(en) in het onderwerp (optioneel).' },
      limit: { type: 'number', description: 'Maximaal aantal gesprekken (standaard 30, hooguit 200).' },
    },
    required: ['client_id'],
    async read(ctx, input) {
      const clientId = id(input, 'client_id');
      const folderId = optId(input, 'folder_id');
      const unfiledOnly = bool(input, 'unfiled_only', false);
      if (folderId && unfiledOnly) throw new ActionError('Kies óf een map (folder_id), óf alleen gesprekken zonder map (unfiled_only).');
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200);
      const queryText = optStr(input, 'query', 120);
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const folders = await foldersOf(ctx, clientId);
      // De view rekent het aantal berichten en het laatste bericht al uit, en
      // laat verwijderde berichten weg (ook voor de service-role, die RLS overslaat).
      let query = orgQuery(ctx, 'client_email_thread_overview',
        'id, subject, last_message_at, message_count, last_email_direction, last_from_name, last_preview, folder_id')
        .eq('client_id', clientId)
        .order('last_message_at', { ascending: false }).limit(limit);
      if (folderId) query = query.eq('folder_id', folderId);
      if (unfiledOnly) query = query.is('folder_id', null);
      if (queryText) query = query.ilike('subject', `%${likeSafe(queryText)}%`);
      const { data, error } = await query;
      if (error) throw new ActionError(`Gesprekken ophalen mislukt: ${error.message}`);
      return {
        client_id: clientId,
        client_name: client.name,
        threads: ((data ?? []) as Array<Record<string, unknown>>).map((t) => ({
          thread_id: t.id,
          subject: t.subject || '(geen onderwerp)',
          last_message_at: t.last_message_at,
          messages: t.message_count,
          last_from: t.last_email_direction === 'outbound' ? 'jullie' : t.last_from_name,
          preview: String(t.last_preview ?? '').slice(0, 160),
          folder_id: t.folder_id ?? null,
          folder: t.folder_id ? pathOf(folders, String(t.folder_id)) || null : null,
        })),
      };
    },
  },

  {
    id: 'mail_folder.create',
    label: 'Mailmap maken bij een klant',
    module: 'clients',
    kind: 'write',
    description:
      'Maakt een map voor de MAIL van een klant (Berichten → mappen per klant), bovenaan of in een bestaande mailmap. Hooguit vijf lagen diep, en per plek één map met dezelfde naam. ' +
      'Wil je meteen gesprekken in een nieuwe map zetten, gebruik dan mail_thread.move met new_folder_name: dat is één kaart in plaats van twee. Voor mappen met notities en documenten gebruik je folder.create.',
    keywords: ['mailmap', 'map voor mail', 'map maken berichten', 'mail ordenen', 'nieuwe map mail', 'map klantmail'],
    input: {
      client_id: { type: 'string', description: 'De klant waar de map bij hoort.' },
      name: { type: 'string', description: 'Naam van de map, hooguit 80 tekens.' },
      parent_id: { type: 'string', description: 'Id van de mailmap waarin hij komt (uit mail_folder.list). Weglaten = bovenaan.' },
    },
    required: ['client_id', 'name'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const name = folderName(input, 'name');
      const parentId = optId(input, 'parent_id');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const folders = await foldersOf(ctx, clientId);
      if (parentId) {
        const parent = folders.find((f) => f.id === parentId);
        if (!parent) throw new ActionError('Die bovenliggende map hoort niet bij deze klant. Zoek hem op met mail_folder.list.');
        if (depthOf(folders, parentId) >= MAX_DEPTH) throw new ActionError(`Mappen gaan hooguit ${MAX_DEPTH} lagen diep; in "${pathOf(folders, parentId)}" kan geen map meer bij.`);
      }
      const clash = sameNameAt(folders, parentId, name);
      if (clash) throw new ActionError(`Er staat al een map "${clash.name}" ${placeLabel(folders, parentId)} (folder_id ${clash.id}). Gebruik die.`);
      return {
        title: `Mailmap maken: ${name}`,
        sub: joinShort([client.name, placeLabel(folders, parentId)]),
        kind: 'work',
        payload: { client_id: clientId, client_name: client.name, name, parent_id: parentId },
      };
    },
  },

  {
    id: 'mail_folder.rename',
    label: 'Mailmap hernoemen',
    module: 'clients',
    kind: 'write',
    description: 'Geeft een mailmap van een klant een andere naam. De gesprekken en submappen erin blijven waar ze zijn.',
    keywords: ['mailmap hernoemen', 'naam map mail', 'map andere naam berichten'],
    input: {
      folder_id: { type: 'string', description: 'De mailmap (uit mail_folder.list).' },
      name: { type: 'string', description: 'De nieuwe naam, hooguit 80 tekens.' },
    },
    required: ['folder_id', 'name'],
    async plan(ctx, input) {
      const folderId = id(input, 'folder_id');
      const name = folderName(input, 'name');
      const folder = await folderRow(ctx, folderId);
      if (folder.name === name) throw new ActionError('De map heet al zo.');
      const folders = await foldersOf(ctx, folder.client_id);
      const clash = sameNameAt(folders, folder.parent_id, name, folder.id);
      if (clash) throw new ActionError(`Er staat al een map "${clash.name}" ${placeLabel(folders, folder.parent_id)}.`);
      const client = await row<{ name: string }>(ctx, 'clients', folder.client_id, 'name', 'Klant');
      return {
        title: `Mailmap hernoemen: ${pathOf(folders, folder.id)}`,
        sub: joinShort([client.name, `wordt "${name}"`]),
        kind: 'work',
        payload: { folder_id: folder.id, name, was: folder.name, client_name: client.name },
      };
    },
  },

  {
    id: 'mail_folder.move',
    label: 'Mailmap verplaatsen (met alles erin)',
    module: 'clients',
    kind: 'write',
    description:
      'Zet een mailmap, met al zijn submappen en gesprekken, in een andere mailmap van dezelfde klant, of bovenaan (laat parent_id weg). ' +
      'Kan niet in zichzelf of in een eigen submap, en niet dieper dan vijf lagen.',
    keywords: ['mailmap verplaatsen', 'map in map', 'map naar boven', 'mappenstructuur aanpassen'],
    input: {
      folder_id: { type: 'string', description: 'De mailmap die verhuist.' },
      parent_id: { type: 'string', description: 'De mailmap waar hij in komt. Weglaten = bovenaan bij de klant.' },
    },
    required: ['folder_id'],
    async plan(ctx, input) {
      const folderId = id(input, 'folder_id');
      const parentId = optId(input, 'parent_id');
      const folder = await folderRow(ctx, folderId);
      const folders = await foldersOf(ctx, folder.client_id);
      if ((folder.parent_id ?? null) === parentId) throw new ActionError(`De map staat al ${placeLabel(folders, parentId)}.`);
      if (parentId === folder.id) throw new ActionError('Een map kan niet in zichzelf.');
      if (parentId) {
        if (!folders.some((f) => f.id === parentId)) throw new ActionError('Een mailmap blijft bij dezelfde klant; die doelmap hoort bij een ander. Zoek hem op met mail_folder.list.');
        if (isInside(folders, parentId, folder.id)) throw new ActionError('Een map kan niet in een van zijn eigen submappen.');
        if (depthOf(folders, parentId) + heightOf(folders, folder.id) > MAX_DEPTH) throw new ActionError(`Dan wordt het dieper dan ${MAX_DEPTH} lagen.`);
      }
      const clash = sameNameAt(folders, parentId, folder.name, folder.id);
      if (clash) throw new ActionError(`Daar staat al een map "${clash.name}". Geef een van beide eerst een andere naam.`);
      const client = await row<{ name: string }>(ctx, 'clients', folder.client_id, 'name', 'Klant');
      const target = parentId ? pathOf(folders, parentId) : null;
      return {
        title: `Mailmap verplaatsen: ${pathOf(folders, folder.id)}`,
        sub: joinShort([client.name, target ? `naar "${target}"` : 'naar bovenaan']),
        kind: 'work',
        payload: { folder_id: folder.id, parent_id: parentId, folder_name: folder.name, target: target ?? 'bovenaan', client_name: client.name },
      };
    },
  },

  {
    id: 'mail_folder.delete',
    label: 'Mailmap verwijderen (de mail blijft)',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description:
      'Verwijdert een mailmap. Er gaat GEEN mail verloren: de gesprekken en submappen die erin staan, schuiven één laag omhoog (naar de bovenliggende map, of naar "Zonder map"). ' +
      'Alleen als de gebruiker de map echt kwijt wil; wil hij hem anders noemen of ergens anders hebben, gebruik dan mail_folder.rename of mail_folder.move.',
    keywords: ['mailmap verwijderen', 'map weg', 'map opruimen berichten'],
    input: { folder_id: { type: 'string', description: 'De mailmap (uit mail_folder.list).' } },
    required: ['folder_id'],
    async plan(ctx, input) {
      const folderId = id(input, 'folder_id');
      const folder = await folderRow(ctx, folderId);
      const folders = await foldersOf(ctx, folder.client_id);
      const { data, error } = await orgQuery(ctx, 'client_email_threads', 'id')
        .eq('folder_id', folder.id).limit(5000);
      if (error) throw new ActionError(`Gesprekken ophalen mislukt: ${error.message}`);
      const threads = (data ?? []).length;
      const subfolders = folders.filter((f) => f.parent_id === folder.id).length;
      const client = await row<{ name: string }>(ctx, 'clients', folder.client_id, 'name', 'Klant');
      const destination = folder.parent_id ? `"${pathOf(folders, folder.parent_id)}"` : '"Zonder map"';
      const parts = [
        threads > 0 ? `${threads} gesprek${threads === 1 ? '' : 'ken'}` : null,
        subfolders > 0 ? `${subfolders} submap${subfolders === 1 ? '' : 'pen'}` : null,
      ].filter(Boolean).join(' en ');
      return {
        title: `Mailmap verwijderen: ${pathOf(folders, folder.id)}`,
        sub: joinShort([client.name, parts ? `${parts} naar ${destination}` : 'de map is leeg']),
        kind: 'work',
        // Verwijderen gaat altijd langs een mens, ook als er ooit rechtstreeks
        // uitvoeren bij komt: de mail blijft, maar de ordening is weg.
        humanOnly: true,
        warning: parts
          ? `De map verdwijnt. ${parts.charAt(0).toUpperCase()}${parts.slice(1)} ${threads + subfolders === 1 ? 'gaat' : 'gaan'} naar ${destination}; er gaat geen mail verloren.`
          : 'De map verdwijnt; hij is leeg.',
        payload: { folder_id: folder.id, folder_name: folder.name, client_name: client.name, destination },
      };
    },
  },

  {
    id: 'mail_thread.move',
    label: 'Mailgesprekken naar een map verplaatsen',
    module: 'clients',
    kind: 'write',
    description:
      'Zet een of meer mailgesprekken van één klant in een mailmap. Geef de gesprekken als thread_ids (uit mail_thread.list) en kies het doel op één manier: ' +
      'folder_id (een bestaande mailmap), new_folder_name (maakt die map eerst, optioneel in new_folder_parent_id; bestaat hij op die plek al, dan gaan ze daarin), ' +
      'of geen van beide om ze terug te zetten naar "Zonder map". Een nieuw antwoord in een gesprek blijft daarna vanzelf in dezelfde map.',
    keywords: ['mail verplaatsen', 'mail in map', 'gesprek verplaatsen', 'mail ordenen', 'mail sorteren', 'opruimen', 'archiveren mail', 'naar map', 'mail opbergen'],
    input: {
      thread_ids: { type: 'array', items: { type: 'string' }, description: 'De gesprekken (thread_id uit mail_thread.list), allemaal van dezelfde klant. Hooguit 200.' },
      folder_id: { type: 'string', description: 'Bestaande mailmap als doel.' },
      new_folder_name: { type: 'string', description: 'Of: de naam van een nieuwe mailmap die eerst gemaakt wordt.' },
      new_folder_parent_id: { type: 'string', description: 'Bij new_folder_name: de mailmap waarin de nieuwe map komt. Weglaten = bovenaan.' },
    },
    required: ['thread_ids'],
    async plan(ctx, input) {
      const threadIds = ids(input, 'thread_ids', 200);
      const folderId = optId(input, 'folder_id');
      const newName = input.new_folder_name === undefined || input.new_folder_name === null || String(input.new_folder_name).trim() === ''
        ? null : folderName(input, 'new_folder_name');
      const newParentId = optId(input, 'new_folder_parent_id');
      if (folderId && newName) throw new ActionError('Kies óf een bestaande map (folder_id), óf een nieuwe (new_folder_name), niet allebei.');
      if (newParentId && !newName) throw new ActionError('new_folder_parent_id hoort bij new_folder_name. Voor een bestaande map gebruik je folder_id.');

      const { data, error } = await orgQuery(ctx, 'client_email_threads', 'id, client_id, subject, folder_id')
        .in('id', threadIds);
      if (error) throw new ActionError(`Gesprekken ophalen mislukt: ${error.message}`);
      // In de volgorde van de vraag: dan staan de onderwerpen op de kaart zoals
      // de gebruiker ze noemde, en niet in de volgorde die de database koos.
      const threads = ((data ?? []) as Array<{ id: string; client_id: string; subject: string; folder_id: string | null }>)
        .sort((a, b) => threadIds.indexOf(a.id) - threadIds.indexOf(b.id));
      if (threads.length !== threadIds.length) {
        const missing = threadIds.length - threads.length;
        throw new ActionError(`${missing === 1 ? 'Eén gesprek bestaat' : `${missing} gesprekken bestaan`} niet in deze organisatie. Gebruik de thread_id's uit mail_thread.list.`);
      }
      const clientIds = [...new Set(threads.map((t) => t.client_id))];
      if (clientIds.length > 1) throw new ActionError('Deze gesprekken horen bij verschillende klanten, en een map hoort bij één klant. Zet per klant een eigen voorstel klaar.');
      const clientId = clientIds[0];
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const folders = await foldersOf(ctx, clientId);

      // Het doel bepalen. Een nieuwe map die er op die plek al is: dan die, in
      // plaats van een fout — "zet ze in Offertes" moet werken, ook als die er al is.
      let targetId: string | null = null;
      let createName: string | null = null;
      let targetLabel = 'Zonder map';
      if (folderId) {
        if (!folders.some((f) => f.id === folderId)) throw new ActionError('Die mailmap hoort niet bij de klant van deze gesprekken. Zoek hem op met mail_folder.list.');
        targetId = folderId;
        targetLabel = pathOf(folders, folderId);
      } else if (newName) {
        if (newParentId) {
          if (!folders.some((f) => f.id === newParentId)) throw new ActionError('Die bovenliggende map hoort niet bij deze klant. Zoek hem op met mail_folder.list.');
          if (depthOf(folders, newParentId) >= MAX_DEPTH) throw new ActionError(`Mappen gaan hooguit ${MAX_DEPTH} lagen diep; in "${pathOf(folders, newParentId)}" kan geen map meer bij.`);
        }
        const existing = sameNameAt(folders, newParentId, newName);
        if (existing) {
          targetId = existing.id;
          targetLabel = pathOf(folders, existing.id);
        } else {
          createName = newName;
          targetLabel = newParentId ? `${pathOf(folders, newParentId)} / ${newName}` : newName;
        }
      }

      const moving = threads.filter((t) => (t.folder_id ?? null) !== targetId || createName !== null);
      if (moving.length === 0) throw new ActionError(`${threads.length === 1 ? 'Dat gesprek staat' : 'Die gesprekken staan'} al in "${targetLabel}".`);
      const subjects = moving.map((t) => t.subject || '(geen onderwerp)');
      return {
        title: moving.length === 1
          ? `Gesprek verplaatsen: ${subjects[0]}`
          : `${moving.length} mailgesprekken verplaatsen`,
        sub: joinShort([
          client.name,
          createName ? `naar nieuwe map "${targetLabel}"` : `naar "${targetLabel}"`,
          ...(moving.length > 1 ? subjects.slice(0, 4) : []),
        ], 170),
        kind: 'work',
        payload: {
          client_id: clientId,
          client_name: client.name,
          thread_ids: moving.map((t) => t.id),
          folder_id: targetId,
          new_folder_name: createName,
          new_folder_parent_id: createName ? newParentId : null,
          target: targetLabel,
          subjects: subjects.slice(0, 20),
        },
      };
    },
  },
];
