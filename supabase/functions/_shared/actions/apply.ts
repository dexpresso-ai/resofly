import { ActionCtx, ActionError } from './types.ts';

/**
 * RECHTSTREEKS UITVOEREN — de serverkant van de handelingenregistry.
 *
 * WAAROM DIT BESTAAT
 * Een schrijf-handeling kent tot nu toe één weg: `plan()` op de server bouwt een
 * VOORSTEL, en de browser voert het uit zodra een mens op Uitvoeren klikt. Dat
 * werkt zolang er een mens met een open scherm is. Een gekoppelde AI heeft dat
 * niet: die zit in de app van de klant, headless, en "ik heb het klaargezet, keur
 * het goed in ResoFly" is precies het antwoord dat iemand niet wil horen als hij
 * "zet die factuur op betaald" vraagt.
 *
 * Dus een tweede weg, alleen voor koppelingen waarvan de eigenaar dat zelf heeft
 * aangezet onder Instellingen → AI: `plan()` bouwt hetzelfde voorstel, en de
 * uitvoerder hieronder schrijft het meteen weg.
 *
 * WAAROM DIT GEEN 188 UITVOERDERS ZIJN
 * De browser heeft er wél 188 (`src/lib/actions/`), en die zijn met opzet een
 * doorgeefluik naar `repository.ts`: dezelfde normalisatie, dezelfde triggers en
 * dezelfde foutafhandeling als de knop in het scherm. Dat allemaal naar Deno
 * kopiëren levert een tweede implementatie op die stil uit de pas gaat lopen —
 * en juist bij de handelingen waar dat het duurst is (een mail versturen, een
 * PDF renderen, een aangifte indienen) zit de logica niet in de query maar in
 * alles eromheen.
 *
 * Daarom staan hier alleen de handelingen waarvan de uitvoerder AANTOONBAAR
 * dezelfde is: één org-scoped insert of update, zonder mail, zonder PDF, zonder
 * bestandsopslag, zonder afgeleide rijen. Voor die handelingen is de serverkant
 * geen kopie maar dezelfde query; voor de rest valt de connector netjes terug op
 * een voorstel in de goedkeurwachtrij, en hoort het model dat ook zo te zeggen.
 *
 * `mcpExecute.test.ts` legt beide kanten naast elkaar: elke id hieronder moet in
 * de registry bestaan, `kind: 'write'` zijn en een uitvoerder in de browser
 * hebben. Een handeling die hier wél staat en daar niet, is een handeling die
 * een gekoppelde AI rechtstreeks kan doen maar een mens niet kan goedkeuren.
 *
 * WAT HIER NIET VERANDERT
 *  • De organisatie komt uit de koppeling (`ctx.organizationId`), nooit uit wat
 *    het model meestuurt. `actionTenancy.test.ts` leest dit bestand mee.
 *  • De payload komt uit ONS `plan()`, niet uit het model. Het model levert de
 *    invoer; plan() zoekt de rijen op, controleert ze binnen de organisatie en
 *    bepaalt wat er precies gebeurt.
 *  • Wat `risk: 'high'` heet, gaat hier niet zomaar langs: dat vraagt een tweede,
 *    aparte schakelaar (scope `execute_high`). Die grens ligt in de MCP-server,
 *    zodat één plek beslist wat er mag en deze tabel alleen zegt wat er kán.
 */

export type DirectApplier = (ctx: ActionCtx, payload: Record<string, unknown>) => Promise<string>;

// ── De payload uitpakken ─────────────────────────────────────────────────────
//
// Spiegel van `src/lib/actions/types.ts`. De payload is al door `plan()` heen,
// dus dit is geen validatie maar een vangnet: liever een leesbare fout dan een
// stille `undefined` in een update.

function pText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new ActionError(`Deze handeling mist "${key}".`);
  return value;
}

function pOptText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value ? value : null;
}

function pFlag(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function pList(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new ActionError(`Deze handeling mist "${key}".`);
  return value.map(String);
}

function pStrings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.map(String) : [];
}

function pPatch(payload: Record<string, unknown>, key = 'patch'): Record<string, unknown> {
  const value = payload[key];
  if (!value || typeof value !== 'object') throw new ActionError(`Deze handeling mist "${key}".`);
  return value as Record<string, unknown>;
}

/**
 * Kolommen die een patch nooit mag aanraken — dezelfde lijst als
 * `sanitizeMutationValues` in de browser. `organization_id` staat er niet voor
 * de sier: het is de reden dat een patch de organisatiegrens niet kan verzetten.
 */
const PROTECTED_FIELDS = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

function clean(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !PROTECTED_FIELDS.has(key)));
}

// ── De twee schrijfbewegingen ────────────────────────────────────────────────

/**
 * Eén rij bijwerken binnen de organisatie — de serverkant van `updateRow`.
 *
 * `maybeSingle()` en niet `single()`: raakt de update geen rij (een id uit een
 * andere organisatie, of een rij die er intussen niet meer is), dan hoort daar
 * een zin te staan die het model begrijpt, geen PostgREST-code.
 */
async function updateOne<T = Record<string, unknown>>(
  ctx: ActionCtx, table: string, rowId: string, values: Record<string, unknown>, select = '*', label = 'Rij',
): Promise<T> {
  const { data, error } = await ctx.db.from(table)
    .update({ ...clean(values), updated_at: new Date().toISOString() })
    .eq('organization_id', ctx.organizationId).eq('id', rowId)
    .select(select).maybeSingle();
  if (error) throw new ActionError(`${label} bijwerken mislukt: ${error.message}`);
  if (!data) throw new ActionError(`${label} niet gevonden in deze organisatie.`);
  return data as T;
}

/**
 * Eén rij bijwerken die van DEZE GEBRUIKER is, binnen de organisatie.
 *
 * Voor bijna alles in ResoFly is de organisatie de grens: collega's zien en
 * bewerken elkaars klanten, projecten en facturen, en dat is het hele punt van
 * een gedeelde administratie. Een paar tabellen zijn persoonlijk, en die hebben
 * in de database een RLS-regel met `user_id = auth.uid()` — de weekplanner-
 * actiepunten zijn er zo een.
 *
 * Die regel deed vroeger zijn werk vanzelf: uitvoeren gebeurde in de browser,
 * onder de sessie van het teamlid. Hier niet. Dit draait op de service-role, die
 * RLS overslaat, dus is dit filter de enige plek waar "van jou" nog iets
 * betekent. `plan()` controleert het ook, en dat is geen reden om het hier over
 * te slaan: een uitvoerder die op zijn aanroeper vertrouwt, is een uitvoerder
 * die stilvalt zodra iemand hem ergens anders vandaan aanroept.
 */
async function updateOwn<T = Record<string, unknown>>(
  ctx: ActionCtx, table: string, rowId: string, values: Record<string, unknown>, select = '*', label = 'Rij',
): Promise<T> {
  const { data, error } = await ctx.db.from(table)
    .update({ ...clean(values), updated_at: new Date().toISOString() })
    .eq('organization_id', ctx.organizationId).eq('id', rowId).eq('user_id', ctx.userId)
    .select(select).maybeSingle();
  if (error) throw new ActionError(`${label} bijwerken mislukt: ${error.message}`);
  if (!data) throw new ActionError(`${label} niet gevonden op jouw lijst.`);
  return data as T;
}

/** Eén rij aanmaken binnen de organisatie — de serverkant van `insertRow`. */
async function insertOne<T = Record<string, unknown>>(
  ctx: ActionCtx, table: string, values: Record<string, unknown>, select = '*', label = 'Rij',
): Promise<T> {
  const { data, error } = await ctx.db.from(table)
    .insert({ ...clean(values), organization_id: ctx.organizationId, created_by: ctx.userId })
    .select(select).single();
  if (error) throw new ActionError(`${label} aanmaken mislukt: ${error.message}`);
  return data as T;
}

/** "Leverancier  bijgewerkt" leest als een fout; dubbele spaties eruit. */
function tidy(sentence: string): string {
  return sentence.replace(/\s{2,}/g, ' ').trim();
}

// ── De uitvoerders ───────────────────────────────────────────────────────────
//
// Op id, in dezelfde volgorde als de domeinen in de registry. Elke functie geeft
// de zin terug die de gebruiker te lezen krijgt — dezelfde zin als in de browser,
// zodat het niet uitmaakt langs welke weg de handeling liep.

export const DIRECT_APPLIERS: Record<string, DirectApplier> = {
  // ── Klanten ───────────────────────────────────────────────────────────────
  'client.update_details': async (ctx, payload) => {
    await updateOne(ctx, 'clients', pText(payload, 'client_id'), pPatch(payload), 'id', 'Klant');
    return `Klantgegevens van ${pOptText(payload, 'client_name') ?? 'de klant'} bijgewerkt`;
  },

  'client.set_custom_fields': async (ctx, payload) => {
    await updateOne(ctx, 'clients', pText(payload, 'client_id'),
      { custom_fields: pPatch(payload, 'custom_fields') }, 'id', 'Klant');
    return `Klantvelden van ${pOptText(payload, 'client_name') ?? 'de klant'} ingevuld`;
  },

  'client_contact.set_active': async (ctx, payload) => {
    const active = pFlag(payload, 'is_active');
    await updateOne(ctx, 'client_contacts', pText(payload, 'contact_id'), { is_active: active }, 'id', 'Contactpersoon');
    return `${pOptText(payload, 'name') ?? 'Contactpersoon'} staat nu ${active ? 'actief' : 'inactief'}`;
  },

  'client_contact.set_portal_access': async (ctx, payload) => {
    const contactIds = pList(payload, 'contact_ids');
    const grant = pFlag(payload, 'gives_portal_access');
    const names = pStrings(payload, 'names');
    // Per contactpersoon, zodat een mislukte rij de rest niet meesleept — net als
    // in de browser, en met dezelfde melding erover.
    const failed: string[] = [];
    for (let i = 0; i < contactIds.length; i += 1) {
      try {
        await updateOne(ctx, 'client_contacts', contactIds[i], { gives_portal_access: grant }, 'id', 'Contactpersoon');
      } catch { failed.push(names[i] ?? contactIds[i]); }
    }
    if (failed.length) throw new ActionError(`${contactIds.length - failed.length} bijgewerkt, ${failed.length} mislukt (${failed.join(', ')}).`);
    return `${contactIds.length} contactperso${contactIds.length === 1 ? 'on' : 'nen'} ${grant ? 'heeft' : 'heeft geen'} portaaltoegang`;
  },

  'client_field.create': async (ctx, payload) => {
    const created = await insertOne<{ label: string; field_key: string }>(ctx, 'client_field_definitions', {
      field_key: pText(payload, 'field_key'),
      label: pText(payload, 'label'),
      field_type: pText(payload, 'field_type'),
      options: Array.isArray(payload.options) ? payload.options : [],
      help_text: pOptText(payload, 'help_text'),
      default_fallback: pOptText(payload, 'default_fallback'),
      show_in_list: pFlag(payload, 'show_in_list'),
      position: typeof payload.position === 'number' ? payload.position : 0,
      is_archived: false,
    }, 'label, field_key', 'Klantveld');
    return `Klantveld "${created.label}" aangemaakt — te gebruiken als {{veld.${created.field_key}}}`;
  },

  'client_field.update': async (ctx, payload) => {
    await updateOne(ctx, 'client_field_definitions', pText(payload, 'field_id'), pPatch(payload), 'id', 'Klantveld');
    return tidy(`Klantveld "${pOptText(payload, 'label') ?? ''}" bijgewerkt`);
  },

  'client_field.archive': async (ctx, payload) => {
    const archived = pFlag(payload, 'is_archived');
    await updateOne(ctx, 'client_field_definitions', pText(payload, 'field_id'), { is_archived: archived }, 'id', 'Klantveld');
    return tidy(`Klantveld "${pOptText(payload, 'label') ?? ''}" ${archived ? 'gearchiveerd' : 'teruggezet'}`);
  },

  // ── Postvak ───────────────────────────────────────────────────────────────
  'inbox.link': async (ctx, payload) => {
    const { error } = await ctx.db.rpc('link_inbound_message', {
      p_organization_id: ctx.organizationId,
      p_inbound_message_id: pText(payload, 'message_id'),
      p_client_id: pText(payload, 'client_id'),
      p_remember_sender: pFlag(payload, 'remember_sender'),
    });
    if (error) throw new ActionError(`Het bericht koppelen mislukte: ${error.message}`);
    return `Bericht staat nu in het dossier van ${pOptText(payload, 'client_name') ?? 'de klant'}`;
  },

  'inbox.ignore': async (ctx, payload) => {
    const status = pText(payload, 'status');
    const { error } = await ctx.db.rpc('set_inbound_message_status', {
      p_organization_id: ctx.organizationId,
      p_inbound_message_id: pText(payload, 'message_id'),
      p_status: status,
    });
    if (error) throw new ActionError(`De status van het bericht wijzigen mislukte: ${error.message}`);
    return status === 'dropped' ? 'Bericht genegeerd' : 'Bericht staat weer in de opvangbak';
  },

  // ── Inhoud ────────────────────────────────────────────────────────────────
  'folder.create': async (ctx, payload) => {
    const parentId = pOptText(payload, 'parent_id');
    const projectId = pOptText(payload, 'project_id');
    const clientId = pText(payload, 'client_id');
    // Positie achteraan binnen dezelfde ouder. De browser telt hiervoor de
    // werkruimte die hij toch al geladen heeft; headless is er niets geladen,
    // dus tellen we de buren zelf — binnen de organisatie, en op precies dezelfde
    // drie kenmerken als het scherm: dezelfde klant, hetzelfde project, dezelfde
    // bovenliggende map.
    let siblings = ctx.db.from('content_folders').select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .eq('client_id', clientId);
    siblings = projectId ? siblings.eq('project_id', projectId) : siblings.is('project_id', null);
    siblings = parentId ? siblings.eq('parent_id', parentId) : siblings.is('parent_id', null);
    const { count, error } = await siblings;
    if (error) throw new ActionError(`De mappen tellen mislukte: ${error.message}`);
    const created = await insertOne<{ name: string }>(ctx, 'content_folders', {
      client_id: clientId, project_id: projectId, parent_id: parentId,
      name: pText(payload, 'name'), position: count ?? 0,
    }, 'name', 'Map');
    return `Map "${created.name}" aangemaakt`;
  },

  'folder.rename': async (ctx, payload) => {
    const name = pText(payload, 'name');
    await updateOne(ctx, 'content_folders', pText(payload, 'folder_id'), { name }, 'id', 'Map');
    return `Map heet nu "${name}"`;
  },

  'content.move': async (ctx, payload) => {
    const kind = pText(payload, 'kind');
    const table = kind === 'note' ? 'notes' : 'documents';
    await updateOne(ctx, table, pText(payload, 'item_id'),
      { folder_id: pOptText(payload, 'folder_id') }, 'id', kind === 'note' ? 'Notitie' : 'Document');
    return tidy(`${kind === 'note' ? 'Notitie' : 'Document'} "${pOptText(payload, 'title') ?? ''}" staat nu in ${pOptText(payload, 'folder_name') ?? 'geen map'}`);
  },

  // ── Tickets ───────────────────────────────────────────────────────────────
  'ticket.set_client': async (ctx, payload) => {
    await updateOne(ctx, 'tickets', pText(payload, 'ticket_id'),
      { client_id: pOptText(payload, 'client_id') }, 'id', 'Ticket');
    const title = pOptText(payload, 'ticket_title') ?? 'Ticket';
    const clientName = pOptText(payload, 'client_name');
    return clientName
      ? `Ticket "${title}" gekoppeld aan ${clientName}`
      : `Ticket "${title}" losgemaakt van de klant`;
  },

  'ticket_note.set_visibility': async (ctx, payload) => {
    const internal = pFlag(payload, 'is_internal');
    await updateOne(ctx, 'ticket_notes', pText(payload, 'note_id'), { is_internal: internal }, 'id', 'Notitie');
    const title = pOptText(payload, 'ticket_title') ?? 'het ticket';
    return internal
      ? `Notitie bij "${title}" is weer intern — de klant ziet hem niet meer in het portaal`
      : `Notitie bij "${title}" staat nu zichtbaar voor de klant in het portaal`;
  },

  // ── Projecten en planning ─────────────────────────────────────────────────
  'project.update_billing': async (ctx, payload) => {
    await updateOne(ctx, 'projects', pText(payload, 'project_id'), pPatch(payload), 'id', 'Project');
    return `Projectinstellingen van "${pOptText(payload, 'project_name') ?? 'het project'}" bijgewerkt`;
  },

  'week_action.set_done': async (ctx, payload) => {
    const noteIds = pList(payload, 'note_ids');
    const done = pFlag(payload, 'done');
    const texts = pStrings(payload, 'texts');
    const failed: string[] = [];
    for (let i = 0; i < noteIds.length; i += 1) {
      // `updateOwn`: actiepunten zijn persoonlijk. Zie de toelichting bij die functie.
      try { await updateOwn(ctx, 'planner_notes', noteIds[i], { done }, 'id', 'Actiepunt'); }
      catch { failed.push(texts[i] ?? noteIds[i]); }
    }
    if (failed.length) throw new ActionError(`${noteIds.length - failed.length} bijgewerkt, ${failed.length} mislukt (${failed.join(', ')}).`);
    if (noteIds.length === 1) {
      return texts[0]
        ? `Actiepunt "${texts[0]}" ${done ? 'afgevinkt' : 'weer opengezet'}`
        : `Actiepunt ${done ? 'afgevinkt' : 'weer opengezet'}`;
    }
    return `${noteIds.length} actiepunten ${done ? 'afgevinkt' : 'weer opengezet'}`;
  },

  // ── Uren ──────────────────────────────────────────────────────────────────
  'time_entry.update_details': async (ctx, payload) => {
    await updateOne(ctx, 'time_entries', pText(payload, 'time_entry_id'), pPatch(payload), 'id', 'Urenpost');
    const label = pOptText(payload, 'description') ?? `de urenpost van ${pOptText(payload, 'entry_date') ?? 'die dag'}`;
    return `Urenpost "${label}" bijgewerkt`;
  },

  // ── Financieel: documenten ────────────────────────────────────────────────
  'finance.link_project': async (ctx, payload) => {
    const documentKind = pText(payload, 'document');
    const table = documentKind === 'quote' ? 'quotes' : 'invoices';
    const label = documentKind === 'quote' ? 'Offerte' : 'Factuur';
    await updateOne(ctx, table, pText(payload, 'document_id'),
      { project_id: pOptText(payload, 'project_id') }, 'id', label);
    const number = pOptText(payload, 'number') ?? '';
    const projectName = pOptText(payload, 'project_name');
    return tidy(projectName
      ? `${label} ${number} gekoppeld aan project ${projectName}`
      : `${label} ${number} losgemaakt van het project`);
  },

  'invoice.set_status': async (ctx, payload) => {
    const status = pText(payload, 'status');
    await updateOne(ctx, 'invoices', pText(payload, 'invoice_id'), { status }, 'id', 'Factuur');
    const labels: Record<string, string> = {
      draft: 'staat weer op concept', sent: 'staat op verzonden', overdue: 'staat op te laat',
      paid: 'is als betaald geboekt', cancelled: 'is geannuleerd', void: 'is ongeldig gemaakt',
      written_off: 'is afgeboekt als oninbaar',
    };
    return tidy(`Factuur ${pOptText(payload, 'number') ?? ''} ${labels[status] ?? `staat op ${status}`}`);
  },

  // ── Boekhouding: stamgegevens ─────────────────────────────────────────────
  'ledger_account.create': async (ctx, payload) => {
    const created = await insertOne<{ code: string; name: string }>(ctx, 'ledger_accounts', {
      code: pText(payload, 'code'),
      name: pText(payload, 'name'),
      type: pText(payload, 'type'),
      report_group: pOptText(payload, 'report_group'),
      subtype: null,
      default_vat_code: pOptText(payload, 'default_vat_code'),
      is_restricted_reserve: pFlag(payload, 'is_restricted_reserve'),
      is_active: payload.is_active !== false,
    }, 'code, name', 'Grootboekrekening');
    return `Grootboekrekening ${created.code} · ${created.name} aangemaakt`;
  },

  'ledger_account.update': async (ctx, payload) => {
    const updated = await updateOne<{ code: string; name: string }>(
      ctx, 'ledger_accounts', pText(payload, 'account_id'), pPatch(payload), 'code, name', 'Grootboekrekening');
    return `Grootboekrekening ${updated.code} · ${updated.name} bijgewerkt`;
  },

  'supplier.update': async (ctx, payload) => {
    await updateOne(ctx, 'suppliers', pText(payload, 'supplier_id'), pPatch(payload), 'id', 'Leverancier');
    return tidy(`Leverancier ${pOptText(payload, 'name') ?? ''} bijgewerkt`);
  },

  'bank_account.create': async (ctx, payload) => {
    const created = await insertOne<{ name: string }>(ctx, 'bank_accounts', {
      name: pText(payload, 'name'),
      iban: pOptText(payload, 'iban'),
      currency: pOptText(payload, 'currency') ?? 'EUR',
      ledger_account_id: pText(payload, 'ledger_account_id'),
      is_active: true,
      source: 'import',
    }, 'name', 'Bankrekening');
    return `Bankrekening "${created.name}" aangemaakt`;
  },

  'bank_account.update': async (ctx, payload) => {
    const updated = await updateOne<{ name: string }>(
      ctx, 'bank_accounts', pText(payload, 'bank_account_id'), pPatch(payload), 'name', 'Bankrekening');
    return `Bankrekening "${updated.name}" bijgewerkt`;
  },

  'bank_rule.update': async (ctx, payload) => {
    const updated = await updateOne<{ name: string }>(
      ctx, 'bank_rules', pText(payload, 'rule_id'), pPatch(payload), 'name', 'Bankregel');
    return `Bankregel "${updated.name}" bijgewerkt`;
  },

  'vat_return.set_status': async (ctx, payload) => {
    const status = pText(payload, 'status');
    await updateOne(ctx, 'vat_returns', pText(payload, 'vat_return_id'), { status }, 'id', 'Btw-aangifte');
    return tidy(`Btw-aangifte ${pOptText(payload, 'label') ?? ''} staat nu op ${status === 'filed' ? 'ingediend' : 'betaald'}`);
  },

  'asset.update': async (ctx, payload) => {
    const updated = await updateOne<{ name: string }>(
      ctx, 'fixed_assets', pText(payload, 'asset_id'), pPatch(payload), 'name', 'Activum');
    return `Activum "${updated.name}" bijgewerkt`;
  },

  // ── Rapportages ───────────────────────────────────────────────────────────
  'saved_report.update': async (ctx, payload) => {
    const saved = await updateOne<{ name: string }>(
      ctx, 'saved_reports', pText(payload, 'report_id'), pPatch(payload), 'name', 'Rapportage');
    return `Rapportage "${saved.name}" bijgewerkt`;
  },

  'saved_report.set_pinned': async (ctx, payload) => {
    const pinned = pFlag(payload, 'is_pinned');
    const saved = await updateOne<{ name: string }>(
      ctx, 'saved_reports', pText(payload, 'report_id'), { is_pinned: pinned }, 'name', 'Rapportage');
    return `Rapportage "${saved.name}" ${pinned ? 'staat nu op het startscherm' : 'staat niet meer op het startscherm'}`;
  },

  // ── Galerijen ─────────────────────────────────────────────────────────────
  'gallery.create': async (ctx, payload) => {
    const created = await insertOne<{ title: string }>(ctx, 'galleries', {
      project_id: pText(payload, 'project_id'),
      title: pText(payload, 'title'),
      format: pText(payload, 'format'),
      hero_template: pText(payload, 'hero_template'),
    }, 'title', 'Galerij');
    return `Galerij "${created.title}" aangemaakt bij ${pOptText(payload, 'project_name') ?? 'het project'} — nog een concept`;
  },

  'gallery.update_settings': async (ctx, payload) => {
    const patch = { ...pPatch(payload) };
    // `expires_date` is een dag; de galerij vervalt aan het EIND van die dag —
    // precies zoals het instellingenscherm het opslaat.
    if ('expires_date' in patch) {
      const day = patch.expires_date;
      delete patch.expires_date;
      patch.expires_at = typeof day === 'string' && day ? new Date(`${day}T23:59:59`).toISOString() : null;
    }
    const updated = await updateOne<{ title: string }>(
      ctx, 'galleries', pText(payload, 'gallery_id'), patch, 'title', 'Galerij');
    return `Instellingen van galerij "${updated.title}" opgeslagen`;
  },

  'gallery.publish': async (ctx, payload) => {
    const updated = await updateOne<{ title: string }>(
      ctx, 'galleries', pText(payload, 'gallery_id'), { status: 'published' }, 'title', 'Galerij');
    return `Galerij "${updated.title}" gepubliceerd — de klant ziet hem nu in het portaal`;
  },

  'gallery.unpublish': async (ctx, payload) => {
    const updated = await updateOne<{ title: string }>(
      ctx, 'galleries', pText(payload, 'gallery_id'), { status: 'draft' }, 'title', 'Galerij');
    return `Galerij "${updated.title}" staat weer op concept — de klant ziet hem niet meer`;
  },

  'gallery.revoke_share_link': async (ctx, payload) => {
    const updated = await updateOne<{ title: string }>(ctx, 'galleries', pText(payload, 'gallery_id'), {
      share_enabled: false, share_token: null, share_token_hash: null, share_pin_hash: null,
    }, 'title', 'Galerij');
    return `Deellink van "${updated.title}" ingetrokken — uitgedeelde links werken niet meer`;
  },

  'gallery_category.set_order': async (ctx, payload) => {
    const categoryIds = pList(payload, 'category_ids');
    // Eén rij per positie, net als het scherm bij het verschuiven van een categorie.
    for (let i = 0; i < categoryIds.length; i += 1) {
      await updateOne(ctx, 'gallery_categories', categoryIds[i], { position: i }, 'id', 'Categorie');
    }
    return `Volgorde van ${categoryIds.length} categorie${categoryIds.length === 1 ? '' : 'ën'} in "${pOptText(payload, 'gallery_title') ?? 'de galerij'}" opgeslagen`;
  },

  'gallery_category.apply_presets': async (ctx, payload) => {
    const galleryId = pText(payload, 'gallery_id');
    const rows = Array.isArray(payload.categories) ? payload.categories as Array<Record<string, unknown>> : [];
    if (rows.length === 0) throw new ActionError('Deze handeling mist "categories".');
    const added: string[] = [];
    for (const row of rows) {
      const created = await insertOne<{ name: string }>(ctx, 'gallery_categories', {
        gallery_id: galleryId, name: String(row.name ?? ''), position: Number(row.position ?? 0),
      }, 'name', 'Categorie');
      added.push(created.name);
    }
    return `${added.length} standaardcategorie${added.length === 1 ? '' : 'ën'} toegevoegd aan "${pOptText(payload, 'gallery_title') ?? 'de galerij'}": ${added.join(', ')}`;
  },
};

/** Kan deze handeling zonder menselijke klik worden uitgevoerd? */
export function directApplier(actionId: string): DirectApplier | undefined {
  return DIRECT_APPLIERS[actionId];
}
