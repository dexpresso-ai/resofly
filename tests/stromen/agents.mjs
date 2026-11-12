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
import { CRON_SECRET } from './omgeving.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { GERRIE_AKKOORD, maakWereld, zetGerrieAan, zetGerrieUit } from './wereld.mjs';

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

  // Gerrie aanzetten (20261112160000): zonder akkoord geen Gerrie, en ook geen
  // agent die namens jou je gegevens leest.
  groep('Agents: Gerrie uitzetten');
  await stap('uitzetten pauzeert je agents, en het logboek zegt het', async () => {
    const aan = await roep('gerrie-agent-runner', { token: w.medewerker.token, body: { action: 'set_status', organizationId: w.orgId, id: agentId, status: 'active' } });
    gelijk(aan.status, 200, `agent aanzetten: ${aan.tekst?.slice(0, 200)}`);
    const uit = await zetGerrieUit(w.orgId, w.medewerker);
    gelijk(uit.status, 200, `uitzetten: ${uit.tekst?.slice(0, 200)}`);
    gelijk(sqlRij(`select status from public.ai_agents where id = ${q(agentId)}`).status, 'paused', 'de agent staat op pauze');
    const regel = sqlRij(`select actor_user_id, metadata from public.audit_logs where organization_id = ${q(w.orgId)} and action = 'ai_disabled' order by created_at desc limit 1`);
    verwacht(regel, 'geen regel in het logboek');
    gelijk(regel.actor_user_id, w.medewerker.id, 'wie het deed');
    gelijk(Number(regel.metadata?.agents_gepauzeerd), 1, 'één agent op pauze');
  });
  await stap('zonder akkoord weigeren de chat en de agents, ook zonder model', async () => {
    for (const body of [{ action: 'budget' }, { action: 'usage' }, { action: 'design_agent', messages: [{ role: 'user', content: 'Elke maandag de facturen' }] }, { message: 'Welke facturen staan open?' }]) {
      const res = await roep('gerrie-agent', { token: w.medewerker.token, body: { organizationId: w.orgId, ...body } });
      geweigerd(res, `gerrie-agent ${body.action ?? 'chat'}`, [403]);
      verwacht(/Instellingen → AI/.test(res.json?.error ?? ''), `de weigering zegt niet waar je Gerrie aanzet: ${res.tekst?.slice(0, 200)}`);
    }
    for (const action of ['tools', 'run_now']) {
      geweigerd(await roep('gerrie-agent-runner', { token: w.medewerker.token, body: { action, organizationId: w.orgId, id: agentId } }), `runner ${action}`, [403]);
    }
    // Een collega die Gerrie wel aan heeft, merkt er niets van.
    const collega = await roep('gerrie-agent', { token: w.eigenaar.token, body: { action: 'budget', organizationId: w.orgId } });
    gelijk(collega.status, 200, `de eigenaar: ${collega.tekst?.slice(0, 200)}`);
  });
  await stap('een run die toch nog geclaimd werd, breekt af zonder het model', async () => {
    // Zoals een tik die de agent claimde vlak voordat hij op pauze ging.
    sql(`update public.ai_agents set status = 'active', next_run_at = now() - interval '1 minute', lease_until = null where id = ${q(agentId)}`);
    const voor = ai.claude.length;
    const tik = await roep('gerrie-agent-runner', { query: 'cron=tick', origin: null, body: {}, headers: { 'x-cron-secret': CRON_SECRET } });
    gelijk(tik.status, 200, `tik: ${tik.tekst?.slice(0, 200)}`);
    const [run] = sqlRijen(`select status, error from public.ai_agent_runs where agent_id = ${q(agentId)} order by created_at desc limit 1`);
    gelijk(run?.status, 'cancelled', `de run: ${JSON.stringify(run)}`);
    verwacht(/Gerrie staat uit/.test(run?.error ?? ''), `de reden: ${run?.error}`);
    gelijk(sqlRij(`select status from public.ai_agents where id = ${q(agentId)}`).status, 'paused', 'weer op pauze');
    const vanDezeAgent = ai.claude.slice(voor).filter((c) => JSON.stringify(c).includes('Welke facturen staan langer dan 30 dagen open'));
    gelijk(vanDezeAgent.length, 0, 'het model kreeg niets van deze agent');
  });
  await stap('weer aanzetten kan alleen met alle drie de vinkjes en de huidige uitleg', async () => {
    const versie = sqlRij('select public.ai_terms_version() as versie').versie;
    geweigerd(await rpc('set_ai_consent', { p_organization_id: w.orgId, p_enabled: true, p_terms_version: versie, p_acknowledged: GERRIE_AKKOORD.slice(0, 2) }, w.medewerker.token), 'twee vinkjes', [400]);
    geweigerd(await rpc('set_ai_consent', { p_organization_id: w.orgId, p_enabled: true, p_terms_version: '2000-01-01', p_acknowledged: GERRIE_AKKOORD }, w.medewerker.token), 'een oude uitleg', [400]);
    // De boekhouder heeft de module Gerrie niet, en zet hem dus ook niet aan.
    geweigerd(await rpc('set_ai_consent', { p_organization_id: w.orgId, p_enabled: true, p_terms_version: versie, p_acknowledged: GERRIE_AKKOORD }, w.boekhouder.token), 'de boekhouder', [401, 403]);
    await zetGerrieAan(w.orgId, w.medewerker);
    const res = await roep('gerrie-agent', { token: w.medewerker.token, body: { action: 'budget', organizationId: w.orgId } });
    gelijk(res.status, 200, `weer aan: ${res.tekst?.slice(0, 200)}`);
    // De agent blijft op pauze tot je hem zelf weer aanzet.
    gelijk(sqlRij(`select status from public.ai_agents where id = ${q(agentId)}`).status, 'paused', 'de agent blijft op pauze');
  });
  await stap('je akkoord is van jou: een collega leest het niet, beheer wel', async () => {
    const eigen = await rest(`ai_consents?organization_id=eq.${w.orgId}&select=user_id`, { token: w.lezer.token });
    gelijk(eigen.status, 200, eigen.tekst);
    gelijk(eigen.json.map((r) => r.user_id), [w.lezer.id], 'een teamlid ziet alleen zijn eigen rij');
    const beheer = await rest(`ai_consents?organization_id=eq.${w.orgId}&select=user_id`, { token: w.beheerder.token });
    gelijk(beheer.json.length, 6, 'de beheerder ziet het hele team (zonder de boekhouder)');
    const boekhouder = await rest(`ai_consents?organization_id=eq.${w.orgId}&select=user_id`, { token: w.boekhouder.token });
    gelijk(boekhouder.json?.length ?? 0, 0, 'de boekhouder ziet niets');
    // Zelf schrijven kan niemand: alleen via set_ai_consent.
    const zelf = await rest('ai_consents', { method: 'POST', token: w.lezer.token, body: { organization_id: w.orgId, user_id: w.lezer.id, enabled: true, terms_version: 'x', accepted_at: new Date().toISOString() } });
    verwacht(zelf.status >= 400, `zelf een akkoord schrijven gaf ${zelf.status}`);
  });

  if (oudeBudget.gebruiker !== undefined) process.env.GERRIE_MONTHLY_USER_COST_EUR = oudeBudget.gebruiker;
  if (oudeBudget.organisatie !== undefined) process.env.GERRIE_MONTHLY_ORG_COST_EUR = oudeBudget.organisatie;
}
