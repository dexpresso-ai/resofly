import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bewaakt DE grens: een handeling komt nooit buiten zijn eigen organisatie.
 *
 * WAAROM DIT GEEN GEWONE TEST IS
 * De handelingen draaien op de SERVICE-ROLE. Die slaat RLS over — alle
 * beveiliging die de rest van de app van de database krijgt, geldt hier niet.
 * Het enige wat een handeling binnen zijn organisatie houdt is dat hij zélf op
 * `organization_id` filtert. Vergeet één van de 264 handelingen dat, dan is dat
 * geen zichtbare bug: de handeling wérkt, hij geeft alleen ook rijen van een
 * andere klant terug. Niemand die het merkt, tot iemand het merkt.
 *
 * Sinds de MCP-connector weegt dat zwaarder. Gerrie draait op ons eigen model
 * binnen onze eigen app; een gekoppelde AI is een programma van een klant dat
 * vragen stelt die wij niet zien aankomen. Dan moet de grens niet "zo bedoeld"
 * zijn maar afgedwongen.
 *
 * We lezen de bestanden als TEKST, net als toolCatalog.test.ts en
 * actionRegistry.test.ts: de serverkant leunt op Deno-imports en is niet in node
 * te laden. Grof, maar het vangt precies de fout die we willen voorkomen — en
 * het vangt hem bij het toevoegen van een handeling, niet in productie.
 */

const here = dirname(fileURLToPath(import.meta.url));
const actionsDir = join(here, 'actions');

/** Binnen hoeveel regels na een query het org-filter moet staan. */
const WINDOW = 8;

/**
 * RPC's die geen klantgegevens raken en dus geen organisatie kennen.
 *
 * Bewust een korte, met redenen benoemde lijst en geen patroon: elke uitzondering
 * hier is een plek waar de grens niet geldt, en dat hoort iemand bewust op te
 * schrijven in plaats van er per ongeluk in te vallen.
 */
const ORG_FREE_RPCS: Record<string, string> = {
  dividend_tax_rate_on: 'Landelijk belastingtarief op een datum — wetgeving, geen klantgegeven.',
};

interface SourceFile { name: string; lines: string[] }

function actionSources(): SourceFile[] {
  return readdirSync(actionsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !['index.ts', 'registry.ts'].includes(f))
    .map((name) => ({ name, lines: readFileSync(join(actionsDir, name), 'utf8').split('\n') }));
}

/**
 * Enkele of dubbele aanhalingstekens mogen nooit het verschil maken.
 * De huisstijl is enkel, maar een controle die daarop leunt mist juist de regel
 * die ervan afwijkt — en dat is de regel waar je hem voor schreef.
 */
const ORG_FILTER = /\.eq\(\s*['"]organization_id['"]\s*,\s*ctx\.organizationId\s*\)/;
/**
 * Een INSERT kan niet filteren — die moet de organisatie ZETTEN. Sinds
 * `apply.ts` (rechtstreeks uitvoeren) schrijft de registry ook echt weg, en dan
 * is dit de vorm waarin de grens er staat. Zonder deze tweede vorm zou de test
 * hieronder elke insert als fout aanwijzen, en dat is de snelste manier om een
 * controle uit te zetten die je juist wilt houden.
 */
const ORG_STAMP = /organization_id:\s*ctx\.organizationId\b/;
const RPC_CALL = /\bdb\.rpc\(\s*['"]([a-z0-9_]+)['"]/;

/** De regels vanaf `index`, samengeplakt, waarin het filter mag staan. */
function window(lines: string[], index: number): string {
  return lines.slice(index, index + WINDOW).join('\n');
}

// ── 1. Elke query filtert op de organisatie uit de sessie ───────────────────

test('elke rechtstreekse tabelquery filtert op de organisatie', () => {
  const problems: string[] = [];

  for (const { name, lines } of actionSources()) {
    lines.forEach((line, index) => {
      if (!/\bdb\.from\(/.test(line)) return;
      // types.ts bevat `row()` en `orgQuery()` zelf; die worden apart getest.
      if (name === 'types.ts') return;
      const scope = window(lines, index);
      if (!ORG_FILTER.test(scope) && !ORG_STAMP.test(scope)) {
        problems.push(`${name}:${index + 1} — ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(problems, [],
    'Deze query\'s draaien op de service-role zonder org-filter en zien dus ook rijen van andere klanten. ' +
    'Gebruik orgQuery(ctx, …) of row(ctx, …), of filter zelf met .eq(\'organization_id\', ctx.organizationId); ' +
    'een insert zet organization_id: ctx.organizationId.');
});

/**
 * Wegschrijven is het spiegelbeeld van lezen, en gevaarlijker.
 *
 * Een leesquery zonder org-filter lekt gegevens van een andere klant; een insert
 * zonder organisatie zet een rij in het niemandsland — of, als er ergens een
 * standaardwaarde vandaan komt, in de administratie van iemand anders. Sinds
 * `apply.ts` schrijft de registry echt weg, dus staat die kant hier apart.
 */
test('elke insert zet de organisatie uit de sessie', () => {
  const problems: string[] = [];

  for (const { name, lines } of actionSources()) {
    lines.forEach((line, index) => {
      if (!/\.insert\(/.test(line)) return;
      if (!ORG_STAMP.test(window(lines, index))) {
        problems.push(`${name}:${index + 1} — ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(problems, [],
    'Een insert die de organisatie niet zelf zet, zet hem nergens: de service-role heeft geen auth.uid() ' +
    'en dus ook geen standaardwaarde. Zet organization_id: ctx.organizationId mee.');
});

/**
 * De patch van een update mag de organisatie niet kunnen verzetten.
 *
 * `plan()` bouwt die patch, maar hij komt uit velden die het model aanlevert.
 * Zou daar `organization_id` in kunnen staan, dan is de grens niet een filter
 * maar een suggestie: de rij wordt gevonden binnen de eigen organisatie en
 * daarna naar een andere geschreven.
 */
test('een update kan een rij niet naar een andere organisatie schrijven', () => {
  const apply = join(actionsDir, 'apply.ts');
  const source = readFileSync(apply, 'utf8');

  assert.match(source, /const PROTECTED_FIELDS = new Set\(\[[^\]]*'organization_id'/,
    'apply.ts hoort organization_id uit elke patch te strippen, net als sanitizeMutationValues in de browser.');
  assert.match(source, /function clean\(/, 'de strip-functie hoort te bestaan…');
  // …en gebruikt te worden: één update die eromheen gaat is genoeg.
  const updates = (source.match(/\.update\(/g) ?? []).length;
  const cleaned = (source.match(/\.update\(\{ \.\.\.clean\(/g) ?? []).length;
  assert.equal(cleaned, updates, 'elke .update() in apply.ts hoort door clean() te gaan.');
});

test('de twee hulpfuncties die alle handelingen delen leggen de grens zelf op', () => {
  const types = readFileSync(join(actionsDir, 'types.ts'), 'utf8');

  // row(): haalt één rij op binnen de organisatie.
  const rowBody = types.slice(types.indexOf('export async function row'));
  assert.match(rowBody.slice(0, 600), ORG_FILTER,
    'row() is de plek waar élke handeling zijn rijen ophaalt; zonder org-filter valt de hele grens weg.');

  // orgQuery(): de lijstvariant.
  const queryBody = types.slice(types.indexOf('export function orgQuery'));
  assert.match(queryBody.slice(0, 400), ORG_FILTER,
    'orgQuery() hoort per definitie org-scoped te zijn.');
});

// ── 2. Elke RPC krijgt de organisatie uit de sessie mee ─────────────────────

test('elke RPC krijgt de organisatie uit de sessie mee', () => {
  const problems: string[] = [];

  for (const { name, lines } of actionSources()) {
    lines.forEach((line, index) => {
      const match = RPC_CALL.exec(line);
      if (!match) return;
      const rpc = match[1];
      if (rpc in ORG_FREE_RPCS) return;
      const scope = window(lines, index);
      if (!scope.includes('p_organization_id: ctx.organizationId')) {
        problems.push(`${name}:${index + 1} — rpc('${rpc}')`);
      }
    });
  }

  assert.deepEqual(problems, [],
    'Een RPC draait als security definer en kan dus over organisaties heen kijken. ' +
    `Geef p_organization_id: ctx.organizationId mee, of zet hem met een reden in ORG_FREE_RPCS (nu: ${Object.keys(ORG_FREE_RPCS).join(', ')}).`);
});

// ── 3. De organisatie komt nooit uit het model ──────────────────────────────

test('geen enkele handeling leest een organisatie-id uit zijn invoer', () => {
  const problems: string[] = [];

  for (const { name, lines } of actionSources()) {
    lines.forEach((line, index) => {
      // `id(input, 'organization_id')`, `input.organization_id`, `input['organization_id']`
      // — alle drie de manieren waarop een organisatie alsnog uit het model zou komen.
      if (/\binput\s*\.\s*organization_id\b/.test(line)
        || /\binput\s*\[\s*['"]organization_id['"]\s*\]/.test(line)
        || /\(\s*input\s*,\s*['"]organization_id['"]/.test(line)) {
        problems.push(`${name}:${index + 1} — ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(problems, [],
    'organization_id hoort ALTIJD uit de geverifieerde sessie te komen (ctx.organizationId), nooit uit wat het model meestuurt. ' +
    'Anders vraagt het model gewoon om de gegevens van een andere klant.');
});

test('p_organization_id krijgt nooit een waarde uit de invoer', () => {
  const problems: string[] = [];

  for (const { name, lines } of actionSources()) {
    lines.forEach((line, index) => {
      const match = /p_organization_id:\s*([^,}\s]+)/.exec(line);
      if (match && match[1] !== 'ctx.organizationId') {
        problems.push(`${name}:${index + 1} — p_organization_id: ${match[1]}`);
      }
    });
  }

  assert.deepEqual(problems, [], 'p_organization_id hoort altijd ctx.organizationId te zijn.');
});

// ── 4. De registry is niet leeg (anders slaagt al het bovenstaande gratis) ──

test('er wordt daadwerkelijk iets nagekeken', () => {
  const sources = actionSources();
  assert.ok(sources.length >= 8, `verwacht minstens acht domeinbestanden, gevonden: ${sources.length}`);

  const all = sources.map((s) => s.lines.join('\n')).join('\n');
  const queries = (all.match(/\bdb\.from\(/g) ?? []).length;
  const helpers = (all.match(/\borgQuery\(/g) ?? []).length + (all.match(/\brow[<(]/g) ?? []).length;

  // Zou iemand de registry ooit anders opbouwen, dan controleren de tests
  // hierboven stilletjes niets meer. Dit is de dodemansknop daaronder.
  assert.ok(queries + helpers > 200,
    `verwacht honderden org-scoped toegangen in de registry, gevonden: ${queries + helpers}. ` +
    'Is de registry verbouwd? Dan moeten de controles hierboven daarop worden aangepast.');
});
