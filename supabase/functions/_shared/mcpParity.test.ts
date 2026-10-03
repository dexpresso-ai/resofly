import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { searchActions } from './actions/registry.ts';

/**
 * Bewaakt de belofte "wat Gerrie kan, kan een gekoppelde AI ook".
 *
 * De app heeft twee lijsten met dingen die hij kan: de HANDELINGENREGISTRY
 * (_shared/actions/, de lange staart) en Gerrie's KERNTOOLS (TOOL_DEFINITIONS in
 * gerrieCore.ts, de kop — een factuur opstellen, reageren op een ticket, een mail
 * aan een klant). In de chat heeft Gerrie allebei.
 *
 * De MCP-connector kreeg aanvankelijk alleen de registry. Dat was een stille fout,
 * en je zag hem terug in de registry zelf: bij `ticket.mark_read` staat "reageren
 * doe je met `propose_ticket_note`", en dat was aan de MCP-kant een verwijzing naar
 * niets. Het model zoekt er dan naar, vindt niets, en zegt tegen de gebruiker dat
 * het niet kan — terwijl het gewoon kan.
 *
 * Deze test leest gerrieCore.ts als TEKST, net als toolCatalog.test.ts. Dat is
 * bewust: dat bestand leest bij import Deno-omgevingsvariabelen uit en is niet in
 * node te laden. Grof, maar het vangt exact de fout die we willen voorkomen.
 */

const here = dirname(fileURLToPath(import.meta.url));
const core = readFileSync(join(here, 'gerrieCore.ts'), 'utf8');
const serverDir = join(here, 'actions');

function section(startMarker: string): string {
  const start = core.indexOf(startMarker);
  assert.ok(start >= 0, `kon "${startMarker}" niet vinden in gerrieCore.ts`);
  const end = core.slice(start).search(/\n[}\]];/);
  assert.ok(end > 0, `kon het einde van "${startMarker}" niet vinden`);
  return core.slice(start, start + end);
}

function toolDefinitionNames(): string[] {
  return [...section('const TOOL_DEFINITIONS').matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
}

function toolLabels(): Map<string, string> {
  // Ook dubbele aanhalingstekens: "Agenda's bekijken" staat er zo, en zou anders
  // hier stil terugvallen op de tool-naam.
  const rows = [...section('const TOOL_LABELS').matchAll(/^\s{2}([a-z_]+): (['"])(.+)\2,$/gm)];
  return new Map(rows.map((m) => [m[1], m[3].replace(/\\'/g, "'")]));
}

/** De zoekwoorden per kerntool, uit TOOL_KEYWORDS; elke regel is één tool. */
function toolKeywords(): Map<string, string[]> {
  const block = section('const TOOL_KEYWORDS');
  const rows = [...block.matchAll(/^\s{2}([a-z_]+): \[(.*)\],$/gm)];
  // Een tool die over meer regels staat, leest deze regex niet. Dan liever hier
  // hard stuk dan verderop een "geen trefwoorden" die niet klopt.
  const keys = [...block.matchAll(/^\s{2}([a-z_]+):/gm)].length;
  assert.equal(rows.length, keys, 'zet in TOOL_KEYWORDS elke tool op één regel, anders kan deze test hem niet lezen');
  return new Map(rows.map((m) => [m[1], [...m[2].matchAll(/(['"])(.*?)\1/g)].map((k) => k[2])]));
}

/**
 * De omschrijving per tool, zoals `GERRIE_CORE_ACTIONS` hem meegeeft.
 *
 * Die telt mee in de zoekuitslag (lichter dan het label, zie registry.ts), dus een
 * test die hem weglaat is strenger dan de werkelijkheid en laat je labels bijvijlen
 * voor een probleem dat er niet is. Letterlijke trouw is niet nodig — het gaat om de
 * WOORDEN — dus quotes en het plusteken van samengestelde teksten gaan er gewoon uit.
 */
function toolDescriptions(): Map<string, string> {
  const block = section('const TOOL_DEFINITIONS');
  const out = new Map<string, string>();
  for (const part of block.split(/^ {4}name: '/m).slice(1)) {
    const name = part.slice(0, part.indexOf("'"));
    const start = part.indexOf('description:');
    const end = part.indexOf('    input_schema:');
    if (start < 0 || end < start) continue;
    out.set(name, part.slice(start + 'description:'.length, end).replace(/['"+\\]/g, ' '));
  }
  return out;
}

function toolModules(): Map<string, string> {
  const rows = [...section('const TOOL_MODULE').matchAll(/^\s{2}([a-z_]+): '([a-z]+)',$/gm)];
  return new Map(rows.map((m) => [m[1], m[2]]));
}

/**
 * De namen die uit `MCP_HIDDEN_TOOLS` volgen — uit de bron gelezen en niet hier
 * overgeschreven, want een lijst die je op twee plekken bijhoudt loopt uiteen.
 */
function hiddenToolNames(): Set<string> {
  const line = core.match(/^const MCP_HIDDEN_TOOLS = \[(.+)\];$/m);
  assert.ok(line, 'kon MCP_HIDDEN_TOOLS niet vinden in gerrieCore.ts');
  const names = [...line[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  // De twee constanten die er met een spread in gaan.
  for (const marker of ['const ACTION_TOOL_NAMES = [', 'const AGENT_FORBIDDEN_TOOLS = [']) {
    if (!line[1].includes(marker.slice('const '.length, marker.indexOf(' ='))))  continue;
    const block = core.match(new RegExp(`^${marker.replace(/[[\]]/g, '\\$&')}(.+)\\];$`, 'm'));
    assert.ok(block, `kon ${marker} niet vinden in gerrieCore.ts`);
    names.push(...[...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  }
  return new Set(names);
}

/** De kerntools zoals de MCP ze aanbiedt: alles uit TOOL_DEFINITIONS, min het verborgene. */
function visibleCoreTools(): string[] {
  const hidden = hiddenToolNames();
  return toolDefinitionNames().filter((name) => !hidden.has(name));
}

/** Wat de MCP als `extra` meegeeft aan searchActions (GERRIE_CORE_ACTIONS); hier uit de bron opgebouwd. */
function coreToolsAsActions() {
  const labels = toolLabels();
  const modules = toolModules();
  const descriptions = toolDescriptions();
  const keywords = toolKeywords();
  return visibleCoreTools().map((name) => ({
    id: name,
    label: labels.get(name) ?? name,
    module: modules.get(name) ?? 'stats',
    kind: name.startsWith('propose_') ? 'write' as const : 'read' as const,
    description: descriptions.get(name) ?? '',
    keywords: keywords.get(name),
    input: {},
    required: [],
  }));
}

function registrySource(): string {
  return readdirSync(serverDir)
    .filter((f) => f.endsWith('.ts') && !['types.ts', 'index.ts', 'registry.ts'].includes(f))
    .map((f) => readFileSync(join(serverDir, f), 'utf8'))
    .join('\n');
}

function registryIds(source: string): string[] {
  return [...source.matchAll(/^\s{4}id: '([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)',$/gm)].map((m) => m[1]);
}

/**
 * Elke verwijzing naar een handeling of tool in de omschrijvingen, tussen backticks.
 *
 * Twee vormen, en alleen die twee: een handeling heet `domein.werkwoord` en heeft
 * altijd een punt, een kerntool begint met een werkwoord (`list_`, `propose_`, …).
 * Veldnamen in dezelfde omschrijvingen (`client_id`, `is_internal`, `recipients`)
 * vallen daar vanzelf buiten — die hoeven ook niet te bestaan als tool.
 */
function toolReferences(source: string): string[] {
  const pattern = /`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]+)+|(?:propose|list|search|suggest|get|find|run)_[a-z0-9_]+)`/g;
  const found = [...source.matchAll(pattern)].map((m) => m[1]);
  // Een verwijzing naar een BESTAND ("zie insight.ts") is geen handeling.
  return [...new Set(found)].filter((ref) => !ref.endsWith('.ts')).sort();
}

test('elke tool waar een handeling naar verwijst, is ook voor een gekoppelde AI te bereiken', () => {
  const source = registrySource();
  const reachable = new Set([...registryIds(source), ...visibleCoreTools()]);
  const dangling = toolReferences(source).filter((ref) => !reachable.has(ref));

  assert.deepEqual(
    dangling, [],
    'deze omschrijvingen sturen het model naar iets dat via de MCP niet bestaat — ' +
    `het zoekt, vindt niets en zegt dat het niet kan: ${dangling.join(', ')}`,
  );
});

test('de MCP biedt de kerntools aan die Gerrie in de chat ook heeft', () => {
  const visible = visibleCoreTools();
  assert.ok(visible.length > 50, `verwacht een gevulde lijst kerntools, kreeg er ${visible.length}`);

  // De kop van wat de gebruiker mist als deze koppeling ontbreekt: reageren op een
  // ticket en een vrije mail aan een klant. Allebei stonden ze vóór deze koppeling
  // alleen in de chat.
  for (const name of ['propose_ticket_note', 'propose_send_client_email', 'list_tickets', 'search_clients']) {
    assert.ok(visible.includes(name), `${name} hoort via de MCP bereikbaar te zijn`);
  }
});

/**
 * Wat een GEPLANDE agent niet mag, mag een koppeling van buiten al helemaal niet.
 *
 * `propose_create_agent` bouwt een agent die daarna vanzelf draait en zelf dingen
 * mag klaarzetten. Een agent mag dat niet van zichzelf (AGENT_FORBIDDEN_TOOLS), en
 * een AI aan de andere kant van een JSON-RPC-verbinding hoort niet ruimer te zijn.
 * De chat-tools (`ask_user`, `emit_plan`, `emit_agent`) horen bij de stroom op het
 * scherm en betekenen daarbuiten niets.
 */
test('de MCP krijgt niet wat een geplande agent ook niet krijgt', () => {
  const visible = new Set(visibleCoreTools());
  for (const name of ['propose_create_agent', 'ask_user', 'emit_plan', 'emit_agent']) {
    assert.ok(!visible.has(name), `${name} hoort NIET aan een gekoppelde AI aangeboden te worden`);
  }
  // De drie meta-tools zijn de MCP-tools zelf; als handeling aanbieden zou het model
  // zichzelf laten aanroepen.
  for (const name of ['find_actions', 'run_action', 'propose_action']) {
    assert.ok(!visible.has(name), `${name} is een MCP-tool, geen handeling`);
  }
});

test('elke kerntool die de MCP aanbiedt, hangt aan een module die rechten kan afschermen', () => {
  const modules = toolModules();
  // Zonder module valt een tool terug op TOOL_MODULE_FALLBACK. Dat is een bewuste
  // terugval voor de enkele tool die nergens bij hoort, geen vrijbrief: wie er meer
  // dan een handvol laat ontstaan, schermt ze feitelijk niet meer af.
  const unmapped = visibleCoreTools().filter((name) => !modules.has(name));
  assert.ok(
    unmapped.length <= 1,
    `deze kerntools hangen aan geen enkele module en vallen dus allemaal op dezelfde terugval: ${unmapped.join(', ')}`,
  );
});

/**
 * Een gekoppelde AI vindt een kerntool alleen via woorden, en het label alleen is
 * daar te smal voor (zie TOOL_KEYWORDS). Een tool zonder trefwoorden valt hier dus
 * op, zoals een tool zonder label dat doet in toolCatalog.test.ts. Andersom zijn
 * trefwoorden voor een tool die de MCP niet aanbiedt werk dat nergens landt.
 */
test('elke kerntool die de MCP aanbiedt, heeft trefwoorden', () => {
  const keywords = toolKeywords();
  const visible = visibleCoreTools();
  const missing = visible.filter((name) => !keywords.get(name)?.length);
  assert.deepEqual(
    missing, [],
    `deze kerntools hebben niets in TOOL_KEYWORDS en zijn dus alleen te vinden op de woorden van hun label: ${missing.join(', ')}`,
  );

  const offered = new Set(visible);
  const stray = [...keywords.keys()].filter((name) => !offered.has(name));
  assert.deepEqual(stray, [], `deze trefwoorden horen bij een tool die de MCP niet (meer) aanbiedt: ${stray.join(', ')}`);
});

/**
 * `find_actions` moet ze ook echt VINDEN.
 *
 * Bereikbaar zijn is niet genoeg: de MCP kent geen vaste toollijst, dus een tool die
 * je met de woorden van een gebruiker niet terugvindt bestaat voor het model niet.
 * De vragen hieronder staan zoals iemand ze stelt. Faalt er een, voeg dan een
 * trefwoord toe in TOOL_KEYWORDS; verlaag de lat hier niet. De lat is twaalf: zoveel
 * geeft `find_actions` standaard terug.
 */
const SEARCH_CASES: Array<[string, string]> = [
  ['reageren op een ticket', 'propose_ticket_note'],
  ['mailtje sturen naar een klant', 'propose_send_client_email'],
  ['welke tickets staan er open', 'list_tickets'],
  ['klant opzoeken', 'search_clients'],
  // Bewust "schrijven op een project" en niet "urenregistratie klaarzetten":
  // "klaarzetten" is ONS woord (elk propose-label eindigt erop) en zegt dus niets,
  // en dan verdringt de veelgebruikte helft van het woordenpaar de juiste tool.
  ['uren schrijven op een project', 'propose_time_entry'],
  // Hier stond eerst "conceptfactuur klaarzetten", de woorden van het label zelf.
  // Die vond hem wel, en zo viel niet op dat "factuur maken" niets opleverde.
  ['factuur maken', 'propose_invoice'],
  ['factuur opstellen', 'propose_invoice'],
  ['nieuwe factuur voor een klant', 'propose_invoice'],
  ['uren factureren', 'propose_invoice'],
  ['offerte maken', 'propose_quote'],
  ['offerte opstellen', 'propose_quote'],
  ['prijsopgave maken', 'propose_quote'],
  ['factuur aanpassen', 'propose_edit_invoice'],
  ['offerte aanpassen', 'propose_edit_quote'],
  ['factuur sturen', 'propose_send_invoice'],
  ['offerte sturen', 'propose_send_quote'],
  ['herinneringen sturen voor openstaande facturen', 'propose_send_reminders'],
  ['omzet deze maand', 'get_financial_summary'],
  ['klant toevoegen', 'propose_client'],
  ['klant bijwerken', 'propose_edit_client'],
  ['uren corrigeren', 'propose_edit_time_entry'],
  ['hoeveel uur heb ik gewerkt', 'list_time_entries'],
  ['mijn takenlijst', 'list_tasks'],
  ['projectstatus aanpassen', 'propose_edit_project'],
  ['collega aan een project toevoegen', 'propose_project_team'],
  ['afspraak inplannen', 'propose_calendar_event'],
  ['meeting plannen', 'propose_calendar_event'],
  ['afspraak verzetten', 'propose_edit_calendar_event'],
  ['afspraak annuleren', 'propose_cancel_calendar_event'],
  ['wanneer heb ik tijd', 'suggest_meeting_slots'],
  ['afspraken deze week', 'list_calendar_events'],
  ['supportvraag vastleggen', 'propose_ticket'],
  ['notitie toevoegen bij een klant', 'propose_note'],
  ['bonnetje invoeren', 'propose_purchase_invoice'],
  ['crediteur aanmaken', 'propose_supplier'],
  ['contract opstellen', 'propose_contract'],
  ['nieuwsbrief maken', 'propose_campaign'],
  ['bankmutaties bekijken', 'list_bank_transactions'],
];

test('de kerntools zijn te vinden met de woorden van de gebruiker', () => {
  const extra = coreToolsAsActions();
  assert.ok(
    extra.every((a) => a.description.length > 0),
    'elke kerntool hoort een omschrijving te hebben; zonder die tekst zoekt het model alleen op label en trefwoorden',
  );

  const missed: string[] = [];
  for (const [query, expected] of SEARCH_CASES) {
    const found = searchActions(query, { extra, limit: 12 }).map((a) => a.id);
    if (!found.includes(expected)) missed.push(`"${query}" → ${expected} (kreeg: ${found.slice(0, 5).join(', ') || 'niets'})`);
  }
  assert.deepEqual(missed, [], `deze vragen vinden hun tool niet:\n  ${missed.join('\n  ')}`);
});

/** De vragen uit actionSearch.test.ts, als tekst gelezen zodat er één lijst blijft. */
function registrySearchCases(): Array<[string, string]> {
  const source = readFileSync(join(here, 'actionSearch.test.ts'), 'utf8');
  const start = source.indexOf('const CASES');
  assert.ok(start >= 0, 'kon CASES niet vinden in actionSearch.test.ts');
  const block = source.slice(start, source.indexOf('\n];', start));
  return [...block.matchAll(/^\s{2}\['([^']+)', '([^']+)'\],$/gm)].map((m) => [m[1], m[2]]);
}

/**
 * En andersom: de kerntools mogen de registry niet verdringen.
 *
 * In de MCP zoeken beide lijsten samen, en een trefwoord weegt net zo zwaar als een
 * label. Een kerntool met te ruime trefwoorden schuift zich zo voor een handeling die
 * beter bij de vraag past. Elke vraag uit actionSearch.test.ts hoort daarom ook mét
 * de kerntools erbij binnen de twaalf te blijven die `find_actions` teruggeeft.
 */
test('met de kerntools erbij vindt elke registry-vraag nog zijn handeling', () => {
  const cases = registrySearchCases();
  assert.ok(cases.length > 20, `verwacht de vragen uit actionSearch.test.ts, kreeg er ${cases.length}`);
  const extra = coreToolsAsActions();

  const missed: string[] = [];
  for (const [query, expected] of cases) {
    const found = searchActions(query, { extra, limit: 12 }).map((a) => a.id);
    if (!found.includes(expected)) missed.push(`"${query}" → ${expected} (kreeg: ${found.slice(0, 5).join(', ')})`);
  }
  assert.deepEqual(missed, [], `met de kerntools erbij vinden deze vragen hun handeling niet meer:\n  ${missed.join('\n  ')}`);
});

test('zonder `extra` blijft find_actions precies de registry doorzoeken', () => {
  // Gerrie's eigen find_actions geeft geen `extra` mee: daar zijn de kerntools al
  // gewone tools, en ze dubbel aanbieden zou het model tussen twee wegen naar
  // hetzelfde laten kiezen.
  const found = searchActions('reageren op een ticket', { limit: 12 }).map((a) => a.id);
  assert.ok(
    !found.some((id) => !id.includes('.')),
    `zonder extra horen er alleen handelingen uit de registry terug te komen, kreeg: ${found.join(', ')}`,
  );
});
