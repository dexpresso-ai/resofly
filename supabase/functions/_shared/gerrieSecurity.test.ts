import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Bewaakt de beveiliging van Gerrie in de code die het model aanroept.
 *
 * gerrieCore.ts en de functies eromheen lezen Deno-omgevingsvariabelen bij het
 * laden en zijn niet in node te draaien; dus lezen we ze als TEKST, net als
 * actionTenancy.test.ts en toolCatalog.test.ts. Grof, maar het vangt precies
 * de fout die we willen voorkomen: een nieuwe ingang naar het model zonder
 * poortwachter, een toolresultaat zonder datagrens, of een query die over
 * organisaties heen kijkt.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const core = read('./gerrieCore.ts');
const reports = read('./gerrieReports.ts');
const records = read('./reportRecords.ts');
const chat = read('../gerrie-agent/index.ts');
const runner = read('../gerrie-agent-runner/index.ts');
const signals = read('../gerrie-signals/index.ts');

/** Alle query's en RPC's in een bestand, als hele opdracht (tot de puntkomma). */
function statements(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /\b(supabaseAdmin|db)\s*\.\s*(from|rpc)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const end = source.indexOf(';', match.index);
    out.push({
      line: source.slice(0, match.index).split('\n').length,
      text: source.slice(match.index, end === -1 ? match.index + 800 : end).replace(/\s+/g, ' '),
    });
  }
  return out;
}

/**
 * Query's zonder organization_id die toch binnen de organisatie blijven. Een
 * korte lijst met redenen, geen patroon: elke uitzondering is een plek waar de
 * grens niet geldt, en dat hoort iemand bewust op te schrijven.
 */
const ORG_FREE: Record<string, string> = {
  "from('organizations')": 'De organisatie zelf, op haar eigen id uit de sessie.',
};

test('elke query in de code van het model blijft binnen de organisatie', () => {
  const problems: string[] = [];
  for (const [name, source] of [['gerrieCore.ts', core], ['gerrieReports.ts', reports], ['reportRecords.ts', records], ['gerrie-agent/index.ts', chat]] as const) {
    for (const { line, text } of statements(source)) {
      if (/organization_id|orgTable\(|p_organization_id/.test(text)) continue;
      if (Object.keys(ORG_FREE).some((key) => text.includes(key))) continue;
      problems.push(`${name}:${line} — ${text.slice(0, 140)}`);
    }
  }
  assert.deepEqual(problems, [],
    'Deze query\'s draaien op de service-role zonder org-filter en zien dus ook rijen van andere klanten. ' +
    'Filter met .eq(\'organization_id\', …) uit de sessie, of zet hem met een reden in ORG_FREE.');
});

test('de organisatie komt nooit uit de invoer van het model', () => {
  for (const [name, source] of [['gerrieCore.ts', core], ['gerrieReports.ts', reports]] as const) {
    assert.doesNotMatch(source, /\binput\s*\.\s*organization_id\b|\binput\s*\[\s*['"]organization_id['"]\s*\]|\(\s*input\s*,\s*['"]organization_id['"]/, name);
  }
});

test('elk toolresultaat gaat afgebakend als gegevens naar het model', () => {
  // Een geslaagd toolresultaat (geen is_error) hoort door wrapToolData te gaan.
  for (const [name, source] of [['gerrieCore.ts', core], ['gerrieReports.ts', reports]] as const) {
    const pushes = source.split('\n').filter((l) => /type:\s*'tool_result'/.test(l) && !/is_error:\s*true/.test(l));
    assert.ok(pushes.length > 0, `${name}: geen toolresultaten gevonden; is de lus verplaatst?`);
    for (const line of pushes) assert.match(line, /wrapToolData\(/, `${name}: ${line.trim()}`);
  }
});

test('elke systeemprompt van Gerrie begint met de veiligheidsregels en eindigt met de herinnering', () => {
  const corePrompt = core.slice(core.indexOf('function buildSystemPrompt'), core.indexOf('// ── Commandocentrum'));
  assert.match(corePrompt, /securityRules\(ctx\.orgName\)/);
  assert.match(corePrompt, /SECURITY_REMINDER/);
  assert.match(corePrompt, /promptValue\(ctx\.orgName\)/, 'de organisatienaam gaat door promptValue');
  const reportPrompt = reports.slice(reports.indexOf('function buildReportSystemPrompt'), reports.indexOf('// ── De lus'));
  assert.match(reportPrompt, /securityRules\(ctx\.orgName\)/);
  assert.match(reportPrompt, /SECURITY_REMINDER/);
  // De planner en de agent-bouwer bouwen op buildSystemPrompt.
  assert.equal((core.match(/buildSystemPrompt\(ctx\),/g) ?? []).length >= 2, true);
});

test('elke ingang naar het model gaat eerst langs de poortwachter', () => {
  assert.match(chat, /screenGerrieMessage\(message, 'chat'\)/, 'de chat');
  assert.match(core, /screenGerrieMessage\(goal, 'missie'\)/, 'de missieplanner');
  assert.match(core, /screenGerrieMessage\(lastUserMessage, 'agentbouwer'\)/, 'de agent-bouwer');
  assert.match(reports, /screenGerrieMessage\(message, 'rapportage'\)/, 'de rapportages');
  assert.equal((runner.match(/screenGerrieMessage\(instruction, 'agent'\)/g) ?? []).length, 2, 'de geplande run en de proefrun');
  assert.match(runner, /screenGerrieMessage\(message, 'chat'\)/, 'antwoorden op een run');
  // En de poortwachter staat vóór het model: in elk bestand komt hij eerder dan de eerste runAgent.
  for (const [name, source] of [['gerrie-agent', chat], ['runner', runner]] as const) {
    const guard = source.indexOf('screenGerrieMessage(');
    const agent = source.indexOf('await runAgent(');
    assert.ok(guard > 0 && guard < agent, `${name}: de poortwachter hoort vóór runAgent te staan`);
  }
});

test('elk antwoord gaat door het uitvoerfilter', () => {
  // runAgent filtert elk antwoord (chat, agents, de kaarten van de beslislijst);
  // de rapportage-chat heeft zijn eigen lus en filtert zelf.
  assert.match(core, /text: safeAnswer\(text, knownUrls\)/, 'runAgent filtert zijn antwoord');
  assert.match(reports, /text: safeAnswer\(outcome\.text\)/, 'de rapportage-chat filtert zijn antwoord');
  assert.match(signals, /await runAgent\(/, 'een Gerrie-kaart krijgt zijn tekst uit runAgent');
});

test('een Gerrie-kaart controleert de ontvanger in code, niet alleen in de opdracht', () => {
  const check = signals.indexOf('checkGerrieProposal(');
  const insert = signals.indexOf("origin: 'gerrie', actorId: actor.id");
  assert.ok(check > 0 && check < insert, 'checkGerrieProposal hoort vóór het wegschrijven van de kaart te staan');
});

test('alleen eigen tools: elke aanroep van het model controleert zijn toollijst', () => {
  assert.equal((core.match(/assertClientToolsOnly\(tools\)/g) ?? []).length, 2, 'callAnthropicStream en callAnthropicOnce');
});
