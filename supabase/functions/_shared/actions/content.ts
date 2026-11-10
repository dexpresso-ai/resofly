import {
  ActionError, bool, choice, id, joinShort, likeSafe, optChoice, optId, optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';
import { activeFolderShare } from './clients.ts';

/**
 * Handelingen rond INHOUD: notities, documenten, mappen en bestanden — zoeken,
 * lezen, bijwerken en delen.
 *
 * WAAROM DIT ER BIJ KWAM
 * Gerrie kon notities en documenten aanmaken (`propose_note`, `propose_document`),
 * maar daarna niets meer: `list_content` zocht alleen in de titel, de tekst zelf
 * kon hij niet lezen, en een bestaand document bijwerken kon niet. "Zoek het
 * verslag waarin we de prijsafspraak met Jansen maakten en zet de nieuwe prijs
 * erin" liep zo op drie plekken stuk. Dezelfde vraag aan een collega had gewoon
 * gekund: die zoekt, leest en past aan.
 *
 * WAT HIER BEWUST NIET STAAT
 * Verwijderen staat in `removal.ts`, samen met al het andere dat iets weggooit:
 * dan staat op één plek wat er onherroepelijk kan, en hoe dat bewaakt wordt.
 */

const NOTE_TYPES = ['general', 'meeting', 'action', 'decision', 'idea', 'support'] as const;
const DOCUMENT_TYPES = ['general', 'contract', 'policy', 'procedure', 'other'] as const;
const CONTENT_KINDS = ['note', 'document'] as const;
const SEARCH_KINDS = ['all', 'notes', 'documents', 'files', 'folders'] as const;
const CONTENT_MODES = ['replace', 'append'] as const;

/** Bij welke module hoort een bijlage, naar waar hij aan hangt. */
const ATTACHMENT_MODULE: Record<string, string> = {
  folder: 'content', note: 'content', document: 'content',
  client: 'clients',
  project: 'projects', task: 'projects', subtask: 'projects',
  ticket: 'tickets',
  quote: 'finance', invoice: 'finance', supplier: 'finance', purchase_invoice: 'finance', fixed_asset: 'finance',
  meeting_recording: 'calendar',
  chat_message: 'chat',
};

/**
 * Mag de aanroeper de bijlagen van deze soort zien? Een bestand aan een factuur
 * hoort bij Financiën, ook al zoek je het op via Inhoud: wie Financiën niet mag
 * lezen, krijgt het niet te zien. Chatbijlagen nooit: de teamchat blijft buiten
 * Gerrie, ook als losse bestanden.
 */
function attachmentVisible(ctx: ActionCtx, entityType: string): boolean {
  const module = ATTACHMENT_MODULE[entityType];
  if (!module || module === 'chat') return false;
  return ctx.canRead?.(module) !== false;
}

/**
 * HTML uit de editor naar leesbare tekst. Bewust simpel: het model hoeft de
 * opmaak niet te zien, alleen de woorden en de alinea's.
 */
export function plainText(html: unknown): string {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** De woorden waarop gezocht wordt: minstens drie tekens, hoogstens zes. */
function searchTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  return [...new Set(words)].slice(0, 6);
}

/** Een stukje tekst rond de eerste treffer, zodat je ziet waaróm iets gevonden is. */
function snippetAround(text: string, terms: string[], width = 120): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (at === -1) return flat(text.slice(0, width * 2));
  const start = Math.max(0, at - width);
  const end = Math.min(text.length, at + width);
  return `${start > 0 ? '…' : ''}${flat(text.slice(start, end))}${end < text.length ? '…' : ''}`;
}

/** Hoeveel van de zoekwoorden komen erin voor? Titeltreffers wegen dubbel. */
function scoreOf(title: string, body: string, terms: string[]): number {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (t.includes(term)) score += 2;
    else if (b.includes(term)) score += 1;
  }
  return score;
}

/** Namen van klanten, projecten en mappen bij een lijst rijen, in drie queries. */
async function namesFor(ctx: ActionCtx, rows: Array<Record<string, unknown>>) {
  const pick = (key: string) => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const lookup = async (table: string, column: string, list: string[]) => {
    const map = new Map<string, string>();
    if (list.length === 0) return map;
    const { data, error } = await orgQuery(ctx, table, `id, ${column}`).in('id', list.slice(0, 200));
    if (error) throw new ActionError(`Namen ophalen mislukt: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) map.set(String(r.id), String(r[column] ?? ''));
    return map;
  };
  const [clients, projects, folders] = await Promise.all([
    ctx.canRead?.('clients') === false ? Promise.resolve(new Map<string, string>()) : lookup('clients', 'name', pick('client_id')),
    ctx.canRead?.('projects') === false ? Promise.resolve(new Map<string, string>()) : lookup('projects', 'name', pick('project_id')),
    lookup('content_folders', 'name', pick('folder_id')),
  ]);
  return { clients, projects, folders };
}

interface ContentRow {
  id: string; title: string | null; content: string | null; client_id: string | null; project_id: string | null;
  folder_id: string | null; updated_at: string | null; note_type?: string | null; document_type?: string | null;
  storage_key?: string | null;
}

/**
 * Notities of documenten waarvan de titel of de tekst een zoekwoord bevat.
 *
 * De database zoekt op het ZELDZAAMSTE woord (het langste is een goede gok), in
 * titel én tekst; daarna weegt deze functie alle woorden. Eén zin als
 * "prijsafspraak met Jansen" vond anders alleen iets als die precies zo in de
 * tekst stond.
 */
async function searchTable(
  ctx: ActionCtx, table: 'notes' | 'documents', terms: string[], filters: { clientId: string | null; projectId: string | null },
): Promise<ContentRow[]> {
  const select = table === 'notes'
    ? 'id, title, content, client_id, project_id, folder_id, updated_at, note_type'
    : 'id, title, content, client_id, project_id, folder_id, updated_at, document_type, storage_key';
  const anchor = [...terms].sort((a, b) => b.length - a.length)[0];
  const found = new Map<string, ContentRow>();
  for (const column of ['title', 'content']) {
    let query = orgQuery(ctx, table, select).ilike(column, `%${likeSafe(anchor)}%`)
      .order('updated_at', { ascending: false }).limit(150);
    if (filters.clientId) query = query.eq('client_id', filters.clientId);
    if (filters.projectId) query = query.eq('project_id', filters.projectId);
    const { data, error } = await query;
    if (error) throw new ActionError(`Zoeken in ${table === 'notes' ? 'notities' : 'documenten'} mislukt: ${error.message}`);
    for (const r of (data ?? []) as ContentRow[]) found.set(r.id, r);
  }
  return [...found.values()];
}

export const CONTENT_ACTIONS: ActionDef[] = [
  {
    id: 'content.search',
    label: 'Zoeken in notities, documenten en bestanden (ook in de tekst)',
    module: 'content',
    kind: 'read',
    description:
      'Zoekt in de hele bibliotheek: notities en documenten op titel ÉN inhoud, bestanden op naam en mappen op naam. ' +
      'Geeft per treffer de soort, het id, de titel, een stukje tekst rond de treffer en bij welke klant of welk project hij hoort. ' +
      'Gebruik dit voor "zoek het document over…", "in welke notitie stond…" of "waar hebben we de prijsafspraak vastgelegd?". ' +
      'Wil je de volledige tekst, lees hem dan met `content.get`. Een Word-document wordt alleen op titel gevonden: de tekst staat in het bestand zelf.',
    keywords: ['zoeken', 'vinden', 'opzoeken', 'document', 'documenten', 'notitie', 'notities', 'verslag', 'tekst', 'inhoud', 'bestand', 'bestanden', 'map', 'mappen', 'bibliotheek', 'dossier', 'stond', 'zoek'],
    input: {
      query: { type: 'string', description: 'Waar je naar zoekt, in gewone woorden. Woorden van minstens drie letters tellen.' },
      kind: { type: 'string', enum: [...SEARCH_KINDS], description: "Waarin: all (standaard), notes, documents, files (bestanden) of folders (mappen)." },
      client_id: { type: 'string', description: 'Optioneel: alleen bij deze klant.' },
      project_id: { type: 'string', description: 'Optioneel: alleen bij dit project.' },
      limit: { type: 'number', description: 'Hoeveel treffers hoogstens (standaard 15, hoogstens 50).' },
    },
    required: ['query'],
    async read(ctx, input) {
      const query = str(input, 'query', 200);
      const terms = searchTerms(query);
      if (terms.length === 0) throw new ActionError('Geef minstens één zoekwoord van drie letters of meer.');
      const kind = optChoice(input, 'kind', SEARCH_KINDS) ?? 'all';
      const clientId = optId(input, 'client_id');
      const projectId = optId(input, 'project_id');
      const limit = Math.min(Math.max(Math.floor(optNum(input, 'limit') ?? 15), 1), 50);
      const anchor = [...terms].sort((a, b) => b.length - a.length)[0];

      const results: Array<Record<string, unknown> & { score: number; updated: string }> = [];

      const contentRows: Array<{ row: ContentRow; kind: 'note' | 'document' }> = [];
      if (kind === 'all' || kind === 'notes') {
        for (const r of await searchTable(ctx, 'notes', terms, { clientId, projectId })) contentRows.push({ row: r, kind: 'note' });
      }
      if (kind === 'all' || kind === 'documents') {
        for (const r of await searchTable(ctx, 'documents', terms, { clientId, projectId })) contentRows.push({ row: r, kind: 'document' });
      }
      const names = await namesFor(ctx, contentRows.map((c) => c.row as unknown as Record<string, unknown>));
      for (const { row: r, kind: itemKind } of contentRows) {
        const text = plainText(r.content);
        const title = String(r.title ?? '');
        const score = scoreOf(title, text, terms);
        if (score === 0) continue;
        results.push({
          kind: itemKind,
          id: r.id,
          title,
          type: itemKind === 'note' ? r.note_type ?? null : r.document_type ?? null,
          format: itemKind === 'document' && r.storage_key ? 'word' : 'tekst',
          snippet: snippetAround(text, terms),
          client_name: r.client_id ? names.clients.get(r.client_id) ?? null : null,
          project_name: r.project_id ? names.projects.get(r.project_id) ?? null : null,
          folder_name: r.folder_id ? names.folders.get(r.folder_id) ?? null : null,
          updated_at: r.updated_at,
          score,
          updated: String(r.updated_at ?? ''),
        });
      }

      if (kind === 'all' || kind === 'files') {
        const { data, error } = await orgQuery(ctx, 'attachments', 'id, name, entity_type, entity_id, mime_type, size_bytes, created_at')
          .ilike('name', `%${likeSafe(anchor)}%`).order('created_at', { ascending: false }).limit(150);
        if (error) throw new ActionError(`Zoeken in bestanden mislukt: ${error.message}`);
        for (const a of (data ?? []) as Array<Record<string, unknown>>) {
          if (!attachmentVisible(ctx, String(a.entity_type))) continue;
          const name = String(a.name ?? '');
          const score = scoreOf(name, '', terms);
          if (score === 0) continue;
          results.push({
            kind: 'file', id: a.id, title: name, attached_to: a.entity_type, attached_to_id: a.entity_id,
            mime_type: a.mime_type, size_kb: Math.round(Number(a.size_bytes ?? 0) / 1024), updated_at: a.created_at,
            score, updated: String(a.created_at ?? ''),
          });
        }
      }

      if (kind === 'all' || kind === 'folders') {
        let folderQuery = orgQuery(ctx, 'content_folders', 'id, name, client_id, project_id, parent_id, updated_at')
          .ilike('name', `%${likeSafe(anchor)}%`).limit(100);
        if (clientId) folderQuery = folderQuery.eq('client_id', clientId);
        if (projectId) folderQuery = folderQuery.eq('project_id', projectId);
        const { data, error } = await folderQuery;
        if (error) throw new ActionError(`Zoeken in mappen mislukt: ${error.message}`);
        for (const f of (data ?? []) as Array<Record<string, unknown>>) {
          const name = String(f.name ?? '');
          const score = scoreOf(name, '', terms);
          if (score === 0) continue;
          results.push({ kind: 'folder', id: f.id, title: name, client_id: f.client_id, project_id: f.project_id, updated_at: f.updated_at, score, updated: String(f.updated_at ?? '') });
        }
      }

      results.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated));
      const top = results.slice(0, limit).map(({ score: _s, updated: _u, ...rest }) => rest);
      return {
        query,
        found: results.length,
        results: top,
        hint: top.length === 0
          ? 'Niets gevonden. Probeer andere of minder woorden, of zoek met list_content op titel.'
          : 'Lees een notitie of document helemaal met content.get (kind + id).',
      };
    },
  },
  {
    id: 'content.get',
    label: 'Een notitie of document helemaal lezen',
    module: 'content',
    kind: 'read',
    description:
      'Geeft de volledige tekst van één notitie of één document, met titel, soort, klant, project, map en wanneer hij voor het laatst is bijgewerkt. ' +
      'Gebruik dit vóórdat je een notitie of document samenvat, beantwoordt of bijwerkt (`note.update`, `document.update`): dan weet je wat er nu staat. ' +
      'Van een Word-document staat de tekst in het bestand zelf; dan krijg je alleen de gegevens eromheen.',
    keywords: ['lezen', 'openen', 'inhoud', 'tekst', 'bekijken', 'samenvatten', 'document', 'notitie', 'verslag', 'notulen'],
    input: {
      kind: { type: 'string', enum: [...CONTENT_KINDS], description: 'note of document.' },
      id: { type: 'string', description: 'Het id (uit content.search of list_content).' },
    },
    required: ['kind', 'id'],
    async read(ctx, input) {
      const kind = choice(input, 'kind', CONTENT_KINDS);
      const itemId = id(input, 'id');
      const table = kind === 'note' ? 'notes' : 'documents';
      const select = kind === 'note'
        ? 'id, title, content, client_id, project_id, folder_id, note_type, tags, created_at, updated_at'
        : 'id, title, content, client_id, project_id, folder_id, document_type, storage_key, mime_type, created_at, updated_at';
      const item = await row<Record<string, unknown>>(ctx, table, itemId, select, kind === 'note' ? 'Notitie' : 'Document');
      const names = await namesFor(ctx, [item]);
      const word = kind === 'document' && Boolean(item.storage_key);
      const text = word ? '' : plainText(item.content);
      const MAX = 20000;
      return {
        kind,
        id: item.id,
        title: item.title,
        type: kind === 'note' ? item.note_type : item.document_type,
        format: word ? 'word' : 'tekst',
        client_id: item.client_id ?? null,
        client_name: item.client_id ? names.clients.get(String(item.client_id)) ?? null : null,
        project_id: item.project_id ?? null,
        project_name: item.project_id ? names.projects.get(String(item.project_id)) ?? null : null,
        folder_name: item.folder_id ? names.folders.get(String(item.folder_id)) ?? null : null,
        tags: kind === 'note' ? item.tags ?? [] : undefined,
        created_at: item.created_at,
        updated_at: item.updated_at,
        text: word ? null : text.slice(0, MAX),
        truncated: !word && text.length > MAX,
        note: word ? 'Dit is een Word-/Office-bestand. De tekst staat in het bestand zelf en is hier niet te lezen; openen en bewerken gaat in de Word-editor in ResoFly.' : undefined,
      };
    },
  },
  {
    id: 'note.update',
    label: 'Een notitie bijwerken (tekst, titel, klant of project)',
    module: 'content',
    kind: 'write',
    description:
      'Werkt een bestaande notitie bij: de titel, de tekst (vervangen of iets toevoegen onderaan), de soort, de labels, of aan welke klant of welk project hij hangt. ' +
      'Lees hem eerst met `content.get`, zodat je weet wat er nu staat. Met `content_mode: "append"` zet je tekst ONDER de bestaande tekst (veilig voor aanvullingen en actiepunten); ' +
      'met "replace" (standaard) vervang je de hele tekst — geef dan de volledige nieuwe tekst mee, niet alleen het gewijzigde stuk. ' +
      'De tekst mag platte tekst zijn (witregel = nieuwe alinea) of eenvoudige HTML (koppen, lijsten, vet).',
    keywords: ['notitie', 'bijwerken', 'aanpassen', 'wijzigen', 'bewerken', 'aanvullen', 'toevoegen', 'herschrijven', 'tekst', 'verslag', 'notulen', 'titel'],
    input: {
      note_id: { type: 'string', description: 'Id van de notitie (uit content.search of list_content).' },
      title: { type: 'string', description: 'Nieuwe titel.' },
      content: { type: 'string', description: 'De nieuwe tekst (bij replace de volledige tekst; bij append alleen wat erbij komt).' },
      content_mode: { type: 'string', enum: [...CONTENT_MODES], description: 'replace (standaard) of append.' },
      note_type: { type: 'string', enum: [...NOTE_TYPES], description: 'Soort notitie.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Vervangt de labels.' },
      client_id: { type: 'string', description: 'Koppel aan deze klant.' },
      project_id: { type: 'string', description: 'Koppel aan dit project.' },
      unlink_client: { type: 'boolean', description: 'true = los van de klant.' },
      unlink_project: { type: 'boolean', description: 'true = los van het project.' },
    },
    required: ['note_id'],
    plan: (ctx, input) => planContentUpdate(ctx, input, 'note'),
  },
  {
    id: 'document.update',
    label: 'Een document bijwerken (tekst, titel, soort, klant of project)',
    module: 'content',
    kind: 'write',
    description:
      'Werkt een bestaand intern document bij: de titel, de tekst (vervangen of iets toevoegen onderaan), de soort (algemeen, contract, beleid, procedure, overig), of aan welke klant of welk project het hangt. ' +
      'Lees het eerst met `content.get`. Met `content_mode: "append"` voeg je tekst onderaan toe; met "replace" (standaard) vervang je de hele tekst — geef dan de volledige nieuwe tekst. ' +
      'Een Word-document (format "word") bewerk je niet hier maar in de Word-editor; titel, soort, klant en project kunnen wel.',
    keywords: ['document', 'bijwerken', 'aanpassen', 'wijzigen', 'bewerken', 'aanvullen', 'herschrijven', 'tekst', 'procedure', 'beleid', 'titel'],
    input: {
      document_id: { type: 'string', description: 'Id van het document (uit content.search of list_content).' },
      title: { type: 'string', description: 'Nieuwe titel.' },
      content: { type: 'string', description: 'De nieuwe tekst (bij replace de volledige tekst; bij append alleen wat erbij komt).' },
      content_mode: { type: 'string', enum: [...CONTENT_MODES], description: 'replace (standaard) of append.' },
      document_type: { type: 'string', enum: [...DOCUMENT_TYPES], description: 'Soort document.' },
      client_id: { type: 'string', description: 'Koppel aan deze klant.' },
      project_id: { type: 'string', description: 'Koppel aan dit project.' },
      unlink_client: { type: 'boolean', description: 'true = los van de klant.' },
      unlink_project: { type: 'boolean', description: 'true = los van het project.' },
    },
    required: ['document_id'],
    plan: (ctx, input) => planContentUpdate(ctx, input, 'document'),
  },
  {
    id: 'attachment.list',
    label: 'Bestanden bekijken (per klant, project, map of taak)',
    module: 'content',
    kind: 'read',
    description:
      'Toont de geüploade bestanden (bijlagen) die ergens aan hangen: aan een map, een klant, een project, een taak, een ticket, een notitie of document, een offerte of factuur. ' +
      'Geef `attached_to` en `attached_to_id` om de bestanden van één ding te zien, of `name` om op naam te zoeken. ' +
      'Je ziet alleen bestanden uit modules die je mag lezen.',
    keywords: ['bestanden', 'bijlagen', 'bijlage', 'upload', 'geüpload', 'pdf', 'foto', 'map', 'drive', 'bestand'],
    input: {
      attached_to: { type: 'string', enum: Object.keys(ATTACHMENT_MODULE).filter((k) => k !== 'chat_message'), description: 'Waar hangen de bestanden aan.' },
      attached_to_id: { type: 'string', description: 'Het id daarvan.' },
      name: { type: 'string', description: 'Zoek op (een deel van) de bestandsnaam.' },
      limit: { type: 'number', description: 'Hoeveel hoogstens (standaard 30, hoogstens 100).' },
    },
    async read(ctx, input) {
      const attachedTo = optStr(input, 'attached_to', 40);
      if (attachedTo && !(attachedTo in ATTACHMENT_MODULE)) throw new ActionError(`"${attachedTo}" kent ResoFly niet als plek voor bestanden.`);
      if (attachedTo && !attachmentVisible(ctx, attachedTo)) throw new ActionError('Die bestanden horen bij een module die je niet mag lezen.');
      const attachedToId = optId(input, 'attached_to_id');
      const name = optStr(input, 'name', 120);
      const limit = Math.min(Math.max(Math.floor(optNum(input, 'limit') ?? 30), 1), 100);
      let query = orgQuery(ctx, 'attachments', 'id, name, entity_type, entity_id, mime_type, size_bytes, created_at')
        .order('created_at', { ascending: false }).limit(Math.min(limit * 3, 300));
      if (attachedTo) query = query.eq('entity_type', attachedTo);
      if (attachedToId) query = query.eq('entity_id', attachedToId);
      if (name) query = query.ilike('name', `%${likeSafe(name)}%`);
      const { data, error } = await query;
      if (error) throw new ActionError(`Bestanden ophalen mislukt: ${error.message}`);
      const files = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((a) => attachmentVisible(ctx, String(a.entity_type)))
        .slice(0, limit)
        .map((a) => ({
          id: a.id, name: a.name, attached_to: a.entity_type, attached_to_id: a.entity_id,
          mime_type: a.mime_type, size_kb: Math.round(Number(a.size_bytes ?? 0) / 1024), uploaded_at: a.created_at,
        }));
      return { count: files.length, files };
    },
  },
  {
    id: 'attachment.rename',
    label: 'Een bestand hernoemen',
    module: 'content',
    kind: 'write',
    description: 'Geeft een geüpload bestand een andere naam. Zoek het eerst met `attachment.list` of `content.search`. De extensie (.pdf, .docx) blijft staan als je hem weglaat.',
    keywords: ['hernoemen', 'naam', 'bestand', 'bijlage', 'wijzigen', 'omdopen'],
    input: {
      attachment_id: { type: 'string', description: 'Id van het bestand.' },
      name: { type: 'string', description: 'De nieuwe naam.' },
    },
    required: ['attachment_id', 'name'],
    async plan(ctx, input) {
      const attachmentId = id(input, 'attachment_id');
      const file = await row<{ name: string; entity_type: string; entity_id: string }>(ctx, 'attachments', attachmentId, 'name, entity_type, entity_id', 'Bestand');
      assertAttachmentWritable(ctx, file.entity_type);
      await assertAttachmentParentOpen(ctx, file.entity_type, file.entity_id);
      let name = str(input, 'name', 200).replace(/[\\/]/g, '-');
      const oldExt = /\.[a-z0-9]{1,8}$/i.exec(file.name)?.[0] ?? '';
      if (oldExt && !/\.[a-z0-9]{1,8}$/i.test(name)) name = `${name}${oldExt}`;
      if (name === file.name) throw new ActionError('Het bestand heet al zo.');
      return {
        title: `Bestand hernoemen naar "${name}"`,
        sub: `was "${file.name}"`,
        kind: 'work',
        payload: { attachment_id: attachmentId, name, old_name: file.name },
      };
    },
  },
  {
    id: 'attachment.move',
    label: 'Een bestand naar een map verplaatsen',
    module: 'content',
    kind: 'write',
    description: 'Verplaatst een geüpload bestand naar een map in de bibliotheek. Zoek de map met `content.search` (kind folders) of `folder.list`. Let op: staat de doelmap gedeeld, dan ziet de ontvanger het bestand daarna ook.',
    keywords: ['verplaatsen', 'map', 'bestand', 'bijlage', 'opbergen', 'ordenen'],
    input: {
      attachment_id: { type: 'string', description: 'Id van het bestand.' },
      folder_id: { type: 'string', description: 'Id van de doelmap.' },
    },
    required: ['attachment_id', 'folder_id'],
    async plan(ctx, input) {
      const attachmentId = id(input, 'attachment_id');
      const folderId = id(input, 'folder_id');
      const file = await row<{ name: string; entity_type: string; entity_id: string }>(ctx, 'attachments', attachmentId, 'name, entity_type, entity_id', 'Bestand');
      assertAttachmentWritable(ctx, file.entity_type);
      // Net als slepen in de bibliotheek: alleen een bestand dat in een map staat.
      // Een bijlage van een taak of factuur losmaken hoort bij die taak of factuur.
      if (file.entity_type !== 'folder') throw new ActionError(`Dit bestand hangt aan een ${entityLabel(file.entity_type)}, niet in een map van de bibliotheek. Verplaatsen kan alleen tussen mappen.`);
      if (file.entity_id === folderId) throw new ActionError('Dit bestand staat al in die map.');
      const from = await row<{ name: string; client_id: string | null }>(ctx, 'content_folders', file.entity_id, 'name, client_id', 'Map');
      const folder = await row<{ name: string; client_id: string | null }>(ctx, 'content_folders', folderId, 'name, client_id', 'Map');
      // Staat de doelmap gedeeld, dan ziet de ontvanger het bestand meteen. Dat hoort
      // op de kaart, zeker als het naar het dossier van een andere klant gaat.
      const share = await activeFolderShare(ctx, folderId);
      const otherClient = from.client_id !== folder.client_id;
      return {
        title: `"${file.name}" verplaatsen naar map ${folder.name}`,
        sub: `uit map ${from.name}${otherClient ? ' · naar het dossier van een andere klant' : ''}`,
        kind: 'work',
        ...(share ? { risk: 'high' as const, warning: `Map ${folder.name} is gedeeld met ${share.recipient}: die ziet dit bestand daarna ook.` } : {}),
        payload: { attachment_id: attachmentId, folder_id: folderId, name: file.name, folder_name: folder.name },
      };
    },
  },
  {
    id: 'drive.list_shares',
    label: 'Bekijken wat er gedeeld is (en met wie)',
    module: 'content',
    kind: 'read',
    description: 'Toont de lopende delingen van mappen, notities, documenten en bestanden: wat, met wie, tot wanneer, of downloaden mag en hoe vaak het bekeken is. Ingetrokken delingen alleen met `include_revoked`.',
    keywords: ['gedeeld', 'delen', 'deling', 'portaal', 'deellink', 'wie kan', 'toegang', 'bekeken'],
    input: {
      item_id: { type: 'string', description: 'Optioneel: alleen de delingen van dit ene item.' },
      client_id: { type: 'string', description: 'Optioneel: alleen delingen bij deze klant.' },
      include_revoked: { type: 'boolean', description: 'Ook ingetrokken delingen tonen.' },
    },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'drive_shares',
        'id, item_type, item_id, item_name, client_id, recipient_kind, recipient_name, recipient_email, can_download, expires_at, revoked_at, last_viewed_at, view_count, created_at')
        .order('created_at', { ascending: false }).limit(100);
      const itemId = optId(input, 'item_id');
      const clientId = optId(input, 'client_id');
      if (itemId) query = query.eq('item_id', itemId);
      if (clientId) query = query.eq('client_id', clientId);
      if (!bool(input, 'include_revoked', false)) query = query.is('revoked_at', null);
      const { data, error } = await query;
      if (error) throw new ActionError(`Delingen ophalen mislukt: ${error.message}`);
      const now = new Date().toISOString();
      const shares = ((data ?? []) as Array<Record<string, unknown>>).map((s) => ({
        id: s.id, what: s.item_type, item_id: s.item_id, name: s.item_name,
        with: s.recipient_name || s.recipient_email || (s.recipient_kind === 'client' ? 'alle portaalgebruikers van de klant' : null),
        recipient_kind: s.recipient_kind, can_download: s.can_download, expires_at: s.expires_at,
        status: s.revoked_at ? 'ingetrokken' : (s.expires_at && String(s.expires_at) < now ? 'verlopen' : 'actief'),
        views: s.view_count ?? 0, last_viewed_at: s.last_viewed_at,
      }));
      return { count: shares.length, shares };
    },
  },
  {
    id: 'drive.share',
    label: 'Een document, notitie, bestand of map delen',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description:
      'Deelt een map, notitie, document of bestand. Met wie: `contact_ids` (contactpersonen van de klant; zij zien het in het klantportaal), `client_portal: true` (iedereen met portaaltoegang bij de klant), ' +
      '`member_user_ids` (collega\'s; zij krijgen een melding met een link) of `emails` (een los e-mailadres met een geheime deellink — dat kan alleen voor iets dat NIET bij een klantdossier hoort). ' +
      'Optioneel een bericht, een vervaldatum en of downloaden mag. De ontvanger krijgt een melding per e-mail. Zoek het item met `content.search` en de contactpersonen met `list_client_contacts`.',
    keywords: ['delen', 'deel', 'portaal', 'klantportaal', 'deellink', 'toegang', 'sturen', 'beschikbaar', 'collega', 'map delen', 'document delen'],
    input: {
      item_type: { type: 'string', enum: ['folder', 'attachment', 'note', 'document'], description: 'Wat je deelt.' },
      item_id: { type: 'string', description: 'Het id ervan.' },
      contact_ids: { type: 'array', items: { type: 'string' }, description: 'Contactpersonen van de klant (uit list_client_contacts).' },
      client_portal: { type: 'boolean', description: 'true = iedereen met portaaltoegang bij de klant van dit item.' },
      member_user_ids: { type: 'array', items: { type: 'string' }, description: "Collega's (uit list_team_members)." },
      emails: { type: 'array', items: { type: 'string' }, description: 'Losse e-mailadressen (alleen voor iets buiten een klantdossier).' },
      message: { type: 'string', description: 'Kort bericht bij de melding.' },
      expires_at: { type: 'string', description: 'Optioneel: tot en met deze datum (JJJJ-MM-DD).' },
      can_download: { type: 'boolean', description: 'Mag de ontvanger downloaden? Standaard ja.' },
    },
    required: ['item_type', 'item_id'],
    async plan(ctx, input) {
      const itemType = choice(input, 'item_type', ['folder', 'attachment', 'note', 'document'] as const);
      const itemId = id(input, 'item_id');
      const item = await shareableItem(ctx, itemType, itemId);
      const recipients: Array<Record<string, unknown>> = [];
      const labels: string[] = [];

      const contactIds = idList(input, 'contact_ids');
      if (contactIds.length > 0) {
        if (!item.clientId) throw new ActionError('Dit item hoort niet bij een klant; deel met een contactpersoon kan dan niet. Gebruik een e-mailadres of een collega.');
        const { data, error } = await orgQuery(ctx, 'client_contacts', 'id, name, email, client_id, is_active').in('id', contactIds);
        if (error) throw new ActionError(`Contactpersonen ophalen mislukt: ${error.message}`);
        const found = (data ?? []) as Array<{ id: string; name: string; email: string | null; client_id: string; is_active: boolean | null }>;
        for (const contactId of contactIds) {
          const contact = found.find((c) => c.id === contactId);
          if (!contact) throw new ActionError('Een van de contactpersonen is niet gevonden in deze organisatie.');
          // Foutmeldingen zonder namen uit de database: die gaan onafgebakend terug naar
          // het model, en een naam kan van buiten komen (een afzender in het postvak).
          if (contact.client_id !== item.clientId) throw new ActionError('Een van de contactpersonen hoort bij een andere klant dan dit item. Delen kan alleen binnen het eigen klantdossier.');
          if (contact.is_active === false) throw new ActionError('Een van de contactpersonen staat op inactief.');
          recipients.push({ kind: 'contact', clientContactId: contact.id });
          labels.push(`${contact.name}${contact.email ? ` (${contact.email})` : ''}`);
        }
      }
      if (bool(input, 'client_portal', false)) {
        if (!item.clientId) throw new ActionError('Dit item hoort niet bij een klant, dus er is geen klantportaal om het in te zetten.');
        recipients.push({ kind: 'client' });
        labels.push('het klantportaal');
      }
      const memberIds = idList(input, 'member_user_ids');
      if (memberIds.length > 0) {
        const { data, error } = await orgQuery(ctx, 'organization_members', 'user_id, status').in('user_id', memberIds);
        if (error) throw new ActionError(`Teamleden ophalen mislukt: ${error.message}`);
        const active = new Set(((data ?? []) as Array<{ user_id: string; status: string | null }>)
          .filter((m) => !m.status || m.status === 'active').map((m) => m.user_id));
        for (const userId of memberIds) {
          if (!active.has(userId)) throw new ActionError('Een van de collega\'s is geen actief teamlid van deze organisatie.');
          recipients.push({ kind: 'member', memberUserId: userId });
        }
        labels.push(`${memberIds.length} collega${memberIds.length === 1 ? '' : "'s"}`);
      }
      const emails = (Array.isArray(input.emails) ? input.emails as unknown[] : [])
        .map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean).slice(0, 10);
      if (emails.length > 0) {
        if (item.clientId) throw new ActionError('Dit item hoort bij een klantdossier. Dat deel je alleen met contactpersonen van die klant (contact_ids of client_portal), niet met een los e-mailadres.');
        for (const email of emails) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ActionError(`"${email}" is geen geldig e-mailadres.`);
          recipients.push({ kind: 'link', email });
          labels.push(email);
        }
      }
      if (recipients.length === 0) throw new ActionError('Met wie deel je het? Geef contact_ids, client_portal, member_user_ids of emails.');
      const expires = optIsoDate(input, 'expires_at');
      if (expires && expires < ctx.today) throw new ActionError('De vervaldatum ligt in het verleden.');
      const canDownload = bool(input, 'can_download', true);
      const message = optStr(input, 'message', 1000);
      return {
        title: `${item.label} "${item.name}" delen`,
        sub: joinShort([`met ${labels.join(', ')}`, expires ? `tot ${expires}` : 'zonder einddatum', canDownload ? 'downloaden mag' : 'alleen bekijken'], 160),
        kind: 'mail',
        warning: `${labels.length === 1 ? 'De ontvanger ziet' : 'De ontvangers zien'} ${item.label.toLowerCase() === 'map' ? 'deze map en alles wat erin komt' : 'dit'} vanaf nu en krijgt een melding per e-mail.`,
        payload: {
          item_type: itemType, item_id: itemId, item_name: item.name, recipients, recipient_labels: labels,
          // Een dag; de browser maakt er het eind van die dag van, in de eigen tijdzone —
          // net als de vervaldatum van een galerij.
          can_download: canDownload, expires_date: expires, message,
        },
      };
    },
  },
  {
    id: 'drive.revoke_share',
    label: 'Een deling intrekken',
    module: 'content',
    kind: 'write',
    description: 'Trekt een deling in: de ontvanger ziet het item niet meer in het portaal en een deellink werkt niet meer. Zoek de deling met `drive.list_shares`.',
    keywords: ['intrekken', 'deling', 'stoppen met delen', 'toegang', 'deellink', 'portaal', 'niet meer delen'],
    input: { share_id: { type: 'string', description: 'Id van de deling (uit drive.list_shares).' } },
    required: ['share_id'],
    async plan(ctx, input) {
      const shareId = id(input, 'share_id');
      const share = await row<{ item_name: string | null; item_type: string; recipient_name: string | null; recipient_email: string | null; recipient_kind: string; revoked_at: string | null }>(
        ctx, 'drive_shares', shareId, 'item_name, item_type, recipient_name, recipient_email, recipient_kind, revoked_at', 'Deling');
      if (share.revoked_at) throw new ActionError('Deze deling is al ingetrokken.');
      const who = share.recipient_name || share.recipient_email || (share.recipient_kind === 'client' ? 'het klantportaal' : 'de ontvanger');
      return {
        title: `Deling van "${share.item_name ?? 'het item'}" intrekken`,
        sub: `met ${who}`,
        kind: 'work',
        payload: { share_id: shareId, item_name: share.item_name, recipient: who },
      };
    },
  },
];

// ── Hulpjes ──────────────────────────────────────────────────────────────────

function entityLabel(entityType: string): string {
  const labels: Record<string, string> = {
    client: 'klant', project: 'project', task: 'taak', subtask: 'subtaak', ticket: 'ticket', note: 'notitie',
    document: 'document', quote: 'offerte', invoice: 'factuur', folder: 'map', supplier: 'leverancier',
    purchase_invoice: 'inkoopfactuur', fixed_asset: 'activum', meeting_recording: 'opname',
  };
  return labels[entityType] ?? entityType;
}

/** Een bestand wijzigen mag alleen wie de module mag wijzigen waar het aan hangt. */
function assertAttachmentWritable(ctx: ActionCtx, entityType: string): void {
  const module = ATTACHMENT_MODULE[entityType];
  if (!module || module === 'chat') throw new ActionError('Dit bestand hoort bij de teamchat; dat beheer je in de chat zelf.');
  if (ctx.canWrite?.(module) === false) throw new ActionError(`Dit bestand hangt aan een ${entityLabel(entityType)}, en daar mag je niet wijzigen.`);
}

/**
 * Het bewijsstuk bij een offerte, factuur of inkoopfactuur ligt vast zodra dat
 * document geen concept meer is — dezelfde regel als het scherm (daar verdwijnt
 * de knop Verwijderen). De database bewaakt bijlagen zelf niet, dus deze regel
 * is de grens. Zonder hem verdween de PDF van een geboekte inkoopfactuur na één
 * goedgekeurde kaart (bewaarplicht, harde regel 6).
 */
export async function assertAttachmentParentOpen(ctx: ActionCtx, entityType: string, entityId: string): Promise<void> {
  if (entityType === 'quote') {
    const quote = await row<{ status: string; sent_at: string | null }>(ctx, 'quotes', entityId, 'status, sent_at', 'Offerte');
    if (quote.status !== 'draft' || quote.sent_at) throw new ActionError('Dit bestand hoort bij een offerte die geen concept meer is; het ligt vast (bewaarplicht).');
  } else if (entityType === 'invoice') {
    const invoice = await row<{ status: string; sent_at: string | null; journal_entry_id: string | null }>(ctx, 'invoices', entityId, 'status, sent_at, journal_entry_id', 'Factuur');
    if (invoice.status !== 'draft' || invoice.sent_at || invoice.journal_entry_id) throw new ActionError('Dit bestand hoort bij een factuur die verstuurd of geboekt is; het ligt vast (bewaarplicht).');
  } else if (entityType === 'purchase_invoice') {
    const purchase = await row<{ status: string }>(ctx, 'purchase_invoices', entityId, 'status', 'Inkoopfactuur');
    if (purchase.status !== 'draft') throw new ActionError('Dit bestand is het bewijsstuk van een geboekte inkoopfactuur; het ligt vast (bewaarplicht).');
  }
}

function idList(input: Record<string, unknown>, key: string): string[] {
  const raw = Array.isArray(input[key]) ? input[key] as unknown[] : [];
  const out: string[] = [];
  for (const value of raw) {
    const text = String(value ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
      throw new ActionError(`"${key}" bevat een ongeldig id. Zoek het eerst op en gebruik het exacte id.`);
    }
    if (!out.includes(text)) out.push(text);
  }
  return out.slice(0, 25);
}

/** Wat er gedeeld wordt: naam, soort en (via de map, notitie of het bestand) bij welke klant het hoort. */
async function shareableItem(ctx: ActionCtx, itemType: 'folder' | 'attachment' | 'note' | 'document', itemId: string): Promise<{ name: string; label: string; clientId: string | null }> {
  if (itemType === 'folder') {
    const folder = await row<{ name: string; client_id: string | null }>(ctx, 'content_folders', itemId, 'name, client_id', 'Map');
    return { name: folder.name, label: 'Map', clientId: folder.client_id };
  }
  if (itemType === 'note' || itemType === 'document') {
    const table = itemType === 'note' ? 'notes' : 'documents';
    const item = await row<{ title: string | null; client_id: string | null }>(ctx, table, itemId, 'title, client_id', itemType === 'note' ? 'Notitie' : 'Document');
    return { name: item.title || (itemType === 'note' ? 'Notitie' : 'Document'), label: itemType === 'note' ? 'Notitie' : 'Document', clientId: item.client_id };
  }
  const file = await row<{ name: string; entity_type: string; entity_id: string }>(ctx, 'attachments', itemId, 'name, entity_type, entity_id', 'Bestand');
  if (file.entity_type !== 'folder') throw new ActionError('Alleen bestanden die in een map van de bibliotheek staan, kun je delen. Verplaats het bestand eerst naar een map (attachment.move).');
  const folder = await row<{ client_id: string | null }>(ctx, 'content_folders', file.entity_id, 'client_id', 'Map');
  return { name: file.name, label: 'Bestand', clientId: folder.client_id };
}

/** Gedeeld door note.update en document.update: zelfde regels, andere tabel. */
async function planContentUpdate(ctx: ActionCtx, input: Record<string, unknown>, kind: 'note' | 'document') {
  const isNote = kind === 'note';
  const itemId = id(input, isNote ? 'note_id' : 'document_id');
  const table = isNote ? 'notes' : 'documents';
  const label = isNote ? 'Notitie' : 'Document';
  const current = await row<{ title: string | null; content: string | null; client_id: string | null; project_id: string | null; storage_key?: string | null }>(
    ctx, table, itemId, isNote ? 'title, content, client_id, project_id' : 'title, content, client_id, project_id, storage_key', label);

  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  const title = optStr(input, 'title', 200);
  if (title && title !== current.title) { patch.title = title; changes.push(`titel → "${title}"`); }

  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const mode = optChoice(input, 'content_mode', CONTENT_MODES) ?? 'replace';
  let replaces = false;
  if (content) {
    if (!isNote && current.storage_key) {
      throw new ActionError('Dit is een Word-document: de tekst staat in het bestand zelf. Die bewerk je in de Word-editor in ResoFly; titel, soort, klant en project kan ik wel aanpassen.');
    }
    if (content.length > 100000) throw new ActionError('Die tekst is te lang (meer dan 100.000 tekens).');
    patch.content = content;
    replaces = mode === 'replace' && plainText(current.content).length > 0;
    const preview = plainText(content).replace(/\s+/g, ' ').slice(0, 70);
    changes.push(mode === 'append' ? `tekst aanvullen: "${preview}${preview.length >= 70 ? '…' : ''}"` : `tekst vervangen (${plainText(content).length} tekens)`);
  }

  if (isNote) {
    const noteType = optChoice(input, 'note_type', NOTE_TYPES);
    if (noteType) { patch.note_type = noteType; changes.push(`soort → ${noteType}`); }
    if (Array.isArray(input.tags)) {
      patch.tags = (input.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
      changes.push('labels');
    }
  } else {
    const documentType = optChoice(input, 'document_type', DOCUMENT_TYPES);
    if (documentType) { patch.document_type = documentType; changes.push(`soort → ${documentType}`); }
  }

  let clientName: string | null = null;
  let projectName: string | null = null;
  const clientId = optId(input, 'client_id');
  if (clientId) {
    if (ctx.canRead?.('clients') === false) throw new ActionError('Een klant koppelen kan alleen als je Klanten mag lezen.');
    const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
    patch.client_id = clientId; clientName = client.name; changes.push(`klant → ${client.name}`);
  } else if (bool(input, 'unlink_client', false) && current.client_id) {
    patch.client_id = null; changes.push('los van de klant');
  }
  const projectId = optId(input, 'project_id');
  if (projectId) {
    if (ctx.canRead?.('projects') === false) throw new ActionError('Een project koppelen kan alleen als je Projecten mag lezen.');
    const project = await row<{ name: string }>(ctx, 'projects', projectId, 'name', 'Project');
    patch.project_id = projectId; projectName = project.name; changes.push(`project → ${project.name}`);
  } else if (bool(input, 'unlink_project', false) && current.project_id) {
    patch.project_id = null; changes.push('los van het project');
  }

  if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen (titel, tekst, soort, klant of project).');
  const name = current.title || label;
  return {
    title: `${label} "${name}" bijwerken`,
    sub: joinShort(changes, 160),
    kind: 'work' as const,
    // Vervangen gooit de oude tekst weg; er is geen vorige versie om naar terug te gaan.
    ...(replaces ? { risk: 'high' as const, warning: 'De huidige tekst wordt vervangen. Er blijft geen vorige versie bewaard.' } : {}),
    payload: {
      kind, item_id: itemId, title: name, patch, content_mode: content ? mode : null,
      client_name: clientName, project_name: projectName,
    },
  };
}
