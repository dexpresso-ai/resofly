import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeScopes } from './mcpAuth.ts';

/**
 * Bewaakt de derde stand van de MCP-connector: RECHTSTREEKS UITVOEREN.
 *
 * Wat hier misgaat, gaat stil mis. Een gekoppelde AI die iets uitvoert wat de
 * gebruiker nooit heeft aangezet, meldt dat gewoon als gelukt; een handeling die
 * per ongeluk als "rechtstreeks" geldt terwijl er geen uitvoerder is, zegt dat
 * hij klaargezet is en verdwijnt in een wachtrij. Beide keren leest niemand een
 * foutmelding — dus staat de controle hier.
 *
 * Vier grenzen, en het is de moeite ze uit elkaar te houden:
 *
 *   WAT KAN      — `apply.ts`: alleen handelingen met een server-uitvoerder.
 *   WAT MAG      — de scopes: `execute`, en voor het onomkeerbare `execute_high`.
 *   WIE BESLIST  — de eigenaar van de koppeling, via de trigger op `mcp_grants`.
 *   WAT DE APP   — dezelfde handeling moet ook in de browser uitvoerbaar zijn,
 *                  anders kan een mens niet goedkeuren wat een AI zelf wél doet.
 *
 * Net als de andere registry-tests lezen we de bestanden als TEKST: de serverkant
 * leunt op Deno-imports en is niet in node te laden. Grof, maar het vangt precies
 * de fout die we willen voorkomen, en het vangt hem bij het toevoegen.
 */

const here = dirname(fileURLToPath(import.meta.url));
const actionsDir = join(here, 'actions');
const clientDir = join(here, '..', '..', '..', 'src', 'lib', 'actions');

const applySource = readFileSync(join(actionsDir, 'apply.ts'), 'utf8');
const mcpSource = readFileSync(join(here, '..', 'mcp', 'index.ts'), 'utf8');
const oauthSource = readFileSync(join(here, '..', 'mcp-oauth', 'index.ts'), 'utf8');
const migration = readFileSync(
  join(here, '..', '..', 'migrations', '20260917050000_mcp_execute.sql'), 'utf8');
const clientApi = readFileSync(join(here, '..', '..', '..', 'src', 'lib', 'mcp-api.ts'), 'utf8');

/** De id's in DIRECT_APPLIERS: `'client.update_details': async (ctx, payload) => {`. */
function directIds(): string[] {
  const table = applySource.slice(applySource.indexOf('export const DIRECT_APPLIERS'));
  return [...table.matchAll(/^ {2}'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)':/gm)].map((m) => m[1]);
}

function readAll(dir: string, skip: string[]): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !skip.includes(f))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/** Per handeling-id uit de serverregistry: is het een schrijf-handeling? */
function serverActions(): Map<string, { kind: string; risk: string }> {
  const source = readAll(actionsDir, ['types.ts', 'index.ts', 'registry.ts', 'apply.ts']);
  const found = new Map<string, { kind: string; risk: string }>();
  // Per blok tussen twee `id:`-regels: alles tot de volgende handeling hoort
  // bij deze. Zelfde aanpak als actionRegistry.test.ts.
  const blocks = source.split(/^ {4}id: '/m).slice(1);
  for (const block of blocks) {
    const id = block.slice(0, block.indexOf("'"));
    const head = block.slice(0, 900);
    found.set(id, {
      kind: /^ {4}kind: 'write',$/m.test(head) ? 'write' : 'read',
      risk: /^ {4}risk: 'high',$/m.test(head) ? 'high' : 'normal',
    });
  }
  return found;
}

function clientExecutorIds(): Set<string> {
  const source = readAll(clientDir, ['types.ts', 'index.ts', 'registry.ts']);
  return new Set([...source.matchAll(/^ {2}'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)':/gm)].map((m) => m[1]));
}

// ── 1. Wat kan: de uitvoerderstabel ─────────────────────────────────────────

test('er staan daadwerkelijk uitvoerders in de tabel', () => {
  // De dodemansknop onder alles hieronder: een lege tabel laat elke controle
  // gratis slagen, en dan is "rechtstreeks uitvoeren" een knop die niets doet.
  assert.ok(directIds().length >= 25,
    `verwacht minstens 25 rechtstreekse uitvoerders, gevonden: ${directIds().length}`);
});

test('elke rechtstreekse uitvoerder hoort bij een bestaande SCHRIJF-handeling', () => {
  const actions = serverActions();
  const problems = directIds().filter((id) => actions.get(id)?.kind !== 'write');
  assert.deepEqual(problems, [],
    `deze id's in apply.ts bestaan niet als schrijf-handeling in de registry: ${problems.join(', ')}. ` +
    'Een uitvoerder zonder handeling is dode code; een die bij een leeshandeling hoort, kan nooit aangeroepen worden.');
});

test('wat een AI rechtstreeks kan, kan een mens ook goedkeuren', () => {
  // Andersom mag wél: verreweg de meeste schrijf-handelingen hebben alleen een
  // uitvoerder in de browser, en vallen dus terug op de goedkeurwachtrij. Maar
  // een handeling die alleen op de server kan, zou in die wachtrij blijven
  // hangen zodra de gebruiker "rechtstreeks uitvoeren" weer uitzet.
  const inBrowser = clientExecutorIds();
  const missing = directIds().filter((id) => !inBrowser.has(id));
  assert.deepEqual(missing, [],
    `deze handelingen kan een gekoppelde AI rechtstreeks uitvoeren, maar de app zelf niet: ${missing.join(', ')}. ` +
    'Voeg een uitvoerder toe in src/lib/actions/.');
});

test('de uitvoerders SCHRIJVEN alleen langs de twee org-scoped hulpjes', () => {
  // `updateOne` en `insertOne` zijn de enige plekken in dit bestand waar de
  // organisatie bij een wijziging wordt afgedwongen. Een uitvoerder die
  // daaromheen zijn eigen update schrijft, is precies de regel waar dat een keer
  // vergeten wordt.
  //
  // Zelf LEZEN mag wel: `folder.create` telt de buurmappen om de nieuwe map
  // achteraan te zetten, net als het scherm. Dat filter bewaakt
  // actionTenancy.test.ts, dat dit bestand net zo goed naleest.
  const table = applySource.slice(applySource.indexOf('export const DIRECT_APPLIERS'));
  const lines = table.split('\n');
  const strays: string[] = [];
  lines.forEach((line, index) => {
    if (!/\bctx\.db\.from\(/.test(line)) return;
    const scope = lines.slice(index, index + 4).join('\n');
    if (/\.(update|insert|upsert|delete)\(/.test(scope)) strays.push(line.trim());
  });
  assert.deepEqual(strays, [],
    `deze uitvoerders schrijven rechtstreeks naar de database in plaats van via updateOne()/insertOne(): ${strays.join(' | ')}`);
});

/**
 * Tabellen waar de organisatie NIET de grens is, maar de gebruiker.
 *
 * In ResoFly is bijna alles van het team: collega's bewerken elkaars klanten,
 * projecten en facturen, en dat is het punt van een gedeelde administratie. Een
 * handvol tabellen is persoonlijk, te herkennen aan een RLS-regel met
 * `user_id = auth.uid()`. Die regel deed zijn werk vanzelf zolang uitvoeren in de
 * browser gebeurde, onder de sessie van het teamlid — een uitvoerder op de
 * service-role slaat RLS over en moet het dus zelf doen.
 *
 * Bewust een korte, met redenen benoemde lijst en geen patroon, net als
 * ORG_FREE_RPCS in actionTenancy.test.ts: elke regel hier is een plek waar het
 * mis kan gaan zonder dat iemand een foutmelding ziet.
 */
const OWNER_SCOPED_TABLES: Record<string, string> = {
  planner_notes: 'Actiepunten van de weekplanner zijn persoonlijk (RLS: user_id = auth.uid()).',
};

test('een uitvoerder op een persoonlijke tabel filtert ook op de gebruiker', () => {
  const table = applySource.slice(applySource.indexOf('export const DIRECT_APPLIERS'));
  const lines = table.split('\n');
  const problems: string[] = [];

  lines.forEach((line, index) => {
    for (const name of Object.keys(OWNER_SCOPED_TABLES)) {
      if (!new RegExp(`['"]${name}['"]`).test(line)) continue;
      // updateOwn() legt het filter op; updateOne() kent alleen de organisatie.
      if (!/\bupdateOwn\(/.test(line)) problems.push(`regel ${index + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(problems, [],
    'Deze uitvoerders schrijven naar een persoonlijke tabel zonder op de gebruiker te filteren, ' +
    `en draaien op de service-role die RLS overslaat. Gebruik updateOwn(). Persoonlijke tabellen: ${
      Object.entries(OWNER_SCOPED_TABLES).map(([t, why]) => `${t} — ${why}`).join(' ')}`);
});

test('updateOwn filtert daadwerkelijk op de gebruiker uit de sessie', () => {
  // Zonder deze regel is de test hierboven een controle op een naam.
  const fn = applySource.slice(applySource.indexOf('async function updateOwn'));
  assert.match(fn.slice(0, 600), /\.eq\('organization_id', ctx\.organizationId\)\.eq\('id', rowId\)\.eq\('user_id', ctx\.userId\)/,
    'updateOwn hoort op organisatie, rij én gebruiker te filteren.');
});

// ── 2. Wat mag: de twee schakelaars ─────────────────────────────────────────

test('execute_action bestaat alleen voor een koppeling die mag uitvoeren', () => {
  assert.match(mcpSource, /if \(tool\.name === 'execute_action'\) return mayExecute\(session\);/,
    'een tool die er niet is, kan een model ook niet proberen — dat is de goedkoopste grens die er is.');
  assert.match(mcpSource, /async function executeAction[\s\S]{0,400}if \(!mayExecute\(session\)\)/,
    'de tool zelf hoort óók te weigeren: de toollijst is een gemak, geen slot.');
});

test('rechtstreeks uitvoeren vraagt een uitvoerder én het juiste risiconiveau', () => {
  const fn = mcpSource.slice(mcpSource.indexOf('function directlyExecutable('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!mayExecute\(session\)\) return false;/);
  assert.match(body, /if \(!directApplier\(actionId\)\) return false;/);
  assert.match(body, /risk !== 'high' \|\| mayExecuteHigh\(session\)/,
    'zonder deze regel voert één schakelaar ook de onomkeerbare handelingen uit.');
});

test('het risico van dit ene geval telt, niet dat van de handeling in het algemeen', () => {
  // Een plan() mag het risico per aanroep omhoog zetten (een ticketnotitie
  // verbergen is ongevaarlijk, hem zichtbaar maken voor de klant niet). Werd
  // hier het risico van de handeling gebruikt, dan glipte dat geval erdoor.
  assert.match(mcpSource, /directlyExecutable\(session, action\.id, proposal\.risk\)/,
    'executeAction hoort te toetsen op het risico van het gebouwde plan.');
});

test('wat niet rechtstreeks kan, valt terug op de goedkeurwachtrij', () => {
  assert.match(mcpSource, /if \(!directApplier\(action\.id\)\) \{\s*\n\s*return await fallbackToProposal\(/,
    'zonder server-uitvoerder hoort het een voorstel te worden, geen weigering.');
  assert.match(mcpSource, /status: 'klaargezet_voor_goedkeuring'/,
    'de terugval hoort herkenbaar te zijn aan de status, niet aan de toon van een zin.');
  assert.match(mcpSource, /status: 'uitgevoerd'/,
    'en een echte uitvoering net zo goed — daar hangt vanaf wat het model tegen de gebruiker zegt.');
});

test('een rechtstreekse uitvoering komt in het auditlog, ook als hij mislukt', () => {
  const fn = mcpSource.slice(mcpSource.indexOf('async function recordExecution('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /status: 'auto_executed' \| 'failed'/);
  assert.match(body, /mcp_grant_id: session\.grantId/,
    'zonder de koppeling is niet te herleiden welke AI van welk teamlid dit deed.');
  assert.match(body, /action: `mcp:execute:\$\{proposal\.action_id\}`/);
});

// ── 3. Wie beslist: de schakelaar staat bij de eigenaar ─────────────────────

test('het toestemmingsscherm kan geen uitvoerrecht uitdelen', () => {
  // De hele afspraak met de gebruiker: rechtstreeks uitvoeren zet je aan onder
  // Instellingen → AI. Zou /approve de keuze niet terugknippen op CONSENT_SCOPES,
  // dan zou een aangepast formulier het alsnog in één klik kunnen regelen.
  assert.match(oauthSource, /parseScopes\(body\.scope \?\? SCOPE_READ\)\.filter\(\(s\) => \(CONSENT_SCOPES as readonly string\[\]\)\.includes\(s\)\)/,
    'mcp-oauth hoort de keuze van het toestemmingsscherm eerst op CONSENT_SCOPES te knippen.');
});

test('het plafond van de client reist mee naar de koppeling', () => {
  // Zonder dat plafond in de database valt na het koppelen niet meer te toetsen
  // wat deze client ooit vroeg — en dan kan de schakelaar meer geven dan mocht.
  assert.match(oauthSource, /scope_ceiling: ceiling/);
  assert.match(migration, /add column if not exists scope_ceiling text not null/);
});

test('alleen de eigenaar verruimt zijn eigen koppeling; een admin stopt hem', () => {
  assert.match(migration, /if auth\.uid\(\) is distinct from old\.user_id then/,
    'een owner ziet en stopt de koppelingen van zijn team — verruimen is geen toezicht.');
  assert.match(migration, /where not \(s = any\(v_ceiling\)\)/,
    'de scope hoort binnen het plafond van de AI-client te blijven.');
  assert.match(migration, /or new\.scope_ceiling is distinct from old\.scope_ceiling/,
    'het plafond zelf hoort vanuit de app onaantastbaar te zijn — anders verzet je eerst het plafond.');
});

test('de database laat geen losse treden toe', () => {
  for (const rule of [
    /not \('read' = any\(v_scopes\)\)/,
    /'execute_high' = any\(v_scopes\) and not \('execute' = any\(v_scopes\)\)/,
    /'execute' = any\(v_scopes\) and not \('propose' = any\(v_scopes\)\)/,
  ]) {
    assert.match(migration, rule, 'een stand die de edge function niet kent, hoort niet te kunnen ontstaan.');
  }
  // En geen enkel recht buiten de vier die de connector kent.
  assert.match(migration, /where s not in \('read', 'propose', 'execute', 'execute_high'\)/);
});

test('de trap in de browser is dezelfde trap als op de server', () => {
  // `buildScope` (browser) en `normalizeScopes` (server) zeggen allebei wat er
  // bij elkaar hoort. Lopen ze uit de pas, dan weigert de database een stand die
  // het scherm net heeft aangeboden — en de gebruiker leest een fout waar hij
  // niets aan kan doen.
  assert.deepEqual(normalizeScopes(['execute']), ['read', 'propose', 'execute']);
  assert.deepEqual(normalizeScopes(['execute_high']), ['read', 'propose', 'execute', 'execute_high']);

  const fn = clientApi.slice(clientApi.indexOf('export function buildScope('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const scopes = \['read'\];/, 'lezen hoort er altijd bij');
  assert.match(body, /if \(propose \|\| execute\) scopes\.push\('propose'\);/, 'uitvoeren valt terug op klaarzetten');
  assert.match(body, /if \(execute && executeHigh\) scopes\.push\('execute_high'\);/,
    'het onomkeerbare bestaat niet zonder het omkeerbare');
});

// ── 4. De melding ───────────────────────────────────────────────────────────

test('de eigenaar krijgt ook bericht als er niets meer te keuren valt', () => {
  // Bij een voorstel is de melding een verzoek; bij een uitvoering is het het
  // enige spoor dat de gebruiker op dat moment ziet. Juist dan hoort hij te
  // komen — anders wijzigt zijn AI iets terwijl hij in een ander gesprek zit.
  assert.match(migration, /new\.status not in \('proposed', 'auto_executed'\)/);
  assert.match(migration, /heeft iets uitgevoerd/);
  // De titel van een kerntool-voorstel staat in `result`, niet in `params`
  // (20260917040000). Deze migratie vervangt dezelfde functie en liet die regel
  // eerst vallen — dan zei de melding bij een mail aan een klant weer alleen
  // "Een voorstel wacht op je akkoord".
  assert.match(migration, /nullif\(btrim\(new\.result->>'title'\), ''\)/,
    'de melding hoort ook bij een kerntool-voorstel te zeggen wat er klaarstaat.');
  // Geen nieuw push-type: wie het belletje van zijn AI uit zette, heeft het voor
  // allebei uit staan. Zou hier een nieuw type staan, dan moesten de twee CHECKs
  // en push-api.ts mee — en dan weigert de database stil elke melding.
  assert.match(migration, /'mcp_proposal'/);
  assert.ok(!/notification_outbox_event_type_check/.test(migration),
    'dit push-type bestaat al; de CHECKs hoeven niet opnieuw geschreven te worden.');
});
