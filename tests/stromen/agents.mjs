// Agents van Gerrie (2026-11-11): de echte gerrie-agent-runner en de agentbouwer
// in gerrie-agent, met een nep-Claude.
//
// Wat hier misgaat, zie je in de app:
//  - een agent aan het werk leek een minuut lang niets te doen: de runner schreef
//    zijn stappen pas na afloop weg. Nu gaan ze tijdens de run het logboek in,
//    en daar leest de werkbank ze terug. Dubbel of door elkaar mag dat niet;
//  - aanpassen via de chat: de bouwer krijgt de huidige agent mee, als gegevens
//    en niet als opdracht. Zonder die agent wist Gerrie bij "maak hem
//    maandelijks" niet over welke agent het ging.
//
//   npm run test:stromen -- agents
import { roep } from './functies.mjs';
import { ai } from './nep-ai.mjs';
import { claude, installeerClaude } from './rapportages.mjs';
import { sqlRijen } from './supabase.mjs';
import { gelijk, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const q = (waarde) => `'${String(waarde).replace(/'/g, "''")}'`;

export default async function agents() {
  installeerClaude();
  const oudeBudget = { gebruiker: process.env.GERRIE_MONTHLY_USER_COST_EUR, organisatie: process.env.GERRIE_MONTHLY_ORG_COST_EUR };
  delete process.env.GERRIE_MONTHLY_USER_COST_EUR;
  delete process.env.GERRIE_MONTHLY_ORG_COST_EUR;

  groep('Agents: klaarzetten');
  const w = await maakWereld('agents');
  let agentId = null;
  await stap('een agent aanmaken', async () => {
    const res = await roep('gerrie-agent-runner', { token: w.medewerker.token, body: {
      action: 'create', organizationId: w.orgId,
      name: 'Te late facturen', instruction: 'Welke facturen staan langer dan 30 dagen open? Noem klant en bedrag.',
      mode: 'report', model_kind: 'strong', enabled_tools: ['list_invoices'],
      schedule_kind: 'weekly', day_of_week: 1, hour: 8, minute: 0, timezone: 'Europe/Amsterdam',
      delivery: { channels: ['inapp'], quiet: false },
    } });
    gelijk(res.status, 200, `aanmaken: ${res.tekst?.slice(0, 200)}`);
    agentId = res.json?.id ?? res.json?.agent?.id ?? null;
    verwacht(agentId, `geen id terug: ${res.tekst?.slice(0, 200)}`);
  });

  groep('Agents: aan het werk, live in het logboek');
  await stap('elke stap staat tijdens de run in het logboek, op volgorde en één keer', async () => {
    claude.aanvragen.length = 0;
    claude.beurten.push(
      { text: 'Ik kijk eerst naar de facturen.', tools: [{ name: 'list_invoices', input: { status: 'overdue' } }] },
      { text: 'Er staan geen facturen langer dan 30 dagen open.' },
    );
    const res = await roep('gerrie-agent-runner', { token: w.medewerker.token, body: { action: 'run_now', organizationId: w.orgId, id: agentId } });
    gelijk(res.status, 200, `nu draaien: ${res.tekst?.slice(0, 300)}`);
    const [run] = sqlRijen(`select id, status from public.ai_agent_runs where agent_id = ${q(agentId)} order by created_at desc limit 1`);
    verwacht(run, 'geen run gevonden');
    gelijk(run.status, 'succeeded', 'de run is gelukt');
    const events = sqlRijen(`select seq, kind, label, created_at from public.ai_agent_run_events where run_id = ${q(run.id)} order by seq`);
    // Volgnummers zonder gaten en zonder dubbele.
    gelijk(events.map((e) => e.seq), events.map((_, i) => i), 'volgnummers 0, 1, 2, …');
    const kinds = events.map((e) => e.kind);
    gelijk(kinds.filter((k) => k === 'tool').length, 1, `één toolstap, niet dubbel: ${kinds.join(', ')}`);
    verwacht(kinds.indexOf('start') === 0 && kinds.indexOf('tool') < kinds.indexOf('answer') && kinds.at(-1) === 'finish', `volgorde: ${kinds.join(', ')}`);
    // Live: de toolstap is weggeschreven vóór het antwoord er was. Na afloop in
    // één keer wegschrijven gaf ze dezelfde tijd (één insert, één now()).
    const tool = events.find((e) => e.kind === 'tool');
    const answer = events.find((e) => e.kind === 'answer');
    verwacht(Date.parse(tool.created_at) < Date.parse(answer.created_at), `de toolstap (${tool.created_at}) kwam niet vóór het antwoord (${answer.created_at})`);
  });

  groep('Agents: aanpassen via de chat');
  await stap('de bouwer krijgt de huidige agent mee, als gegevens', async () => {
    const voor = ai.claude.length;
    const res = await roep('gerrie-agent', { token: w.medewerker.token, body: {
      action: 'design_agent', organizationId: w.orgId,
      messages: [{ role: 'user', content: 'Laat hem elke maand draaien in plaats van elke week' }],
      current: { name: 'Te late facturen', instruction: 'Welke facturen staan langer dan 30 dagen open?', mode: 'report', enabled_tools: ['list_invoices'], schedule_kind: 'weekly', day_of_week: 1, hour: 8, status: 'active', run_as_user_id: w.eigenaar.id },
    } });
    gelijk(res.status, 200, `bouwer: ${res.tekst?.slice(0, 200)}`);
    const bouwer = ai.claude.slice(voor).map((c) => (Array.isArray(c.system) ? c.system.map((b) => b.text).join('\n') : String(c.system ?? ''))).find((sys) => sys.includes('JE BENT NU DE AGENT-BOUWER'));
    verwacht(bouwer, 'de bouwer is niet aangeroepen');
    verwacht(bouwer.includes('JE PAST NU EEN BESTAANDE AGENT AAN'), 'de bouwer weet niet dat hij een agent aanpast');
    verwacht(/<gegevens bron="huidige_agent">\n\{[^\n]*"name":"Te late facturen"/.test(bouwer), 'de huidige agent staat niet als gegevens in de opdracht');
    // Eigenaar en status horen niet in het gesprek.
    verwacht(!bouwer.includes(w.eigenaar.id), 'de eigenaar van de agent ging mee het gesprek in');
  });
  await stap('een nieuwe agent bouwen gaat zonder huidige agent', async () => {
    const voor = ai.claude.length;
    const res = await roep('gerrie-agent', { token: w.medewerker.token, body: {
      action: 'design_agent', organizationId: w.orgId,
      messages: [{ role: 'user', content: 'Elke maandag de facturen die te laat zijn' }],
    } });
    gelijk(res.status, 200, `bouwer: ${res.tekst?.slice(0, 200)}`);
    const bouwer = ai.claude.slice(voor).map((c) => (Array.isArray(c.system) ? c.system.map((b) => b.text).join('\n') : String(c.system ?? ''))).find((sys) => sys.includes('JE BENT NU DE AGENT-BOUWER'));
    verwacht(bouwer && !bouwer.includes('JE PAST NU EEN BESTAANDE AGENT AAN'), 'een nieuwe agent kreeg toch een huidige agent mee');
  });

  if (oudeBudget.gebruiker !== undefined) process.env.GERRIE_MONTHLY_USER_COST_EUR = oudeBudget.gebruiker;
  if (oudeBudget.organisatie !== undefined) process.env.GERRIE_MONTHLY_ORG_COST_EUR = oudeBudget.organisatie;
}
