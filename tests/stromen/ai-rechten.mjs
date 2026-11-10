// AI-rechten: twee regels die de database en de functies samen afdwingen, met
// echte gebruikers tegen de lokale stack.
//
//  1. Een gekoppelde AI (MCP) laat alleen een owner of admin rechtstreeks
//     uitvoeren (20261110110000). Een teamlid kan het recht niet aanzetten, en
//     een koppeling die het nog draagt, krijgt het bij een aanroep niet.
//  2. Een kaart van de beslislijst volgt de rechten van ALLE modules waarvan hij
//     gegevens toont (20261110110100). Een kaart over een klantmail met open
//     facturen is er niet voor een teamlid zonder Financiën: niet zien, niet
//     afhandelen, niet beslissen.
//
//   npm run test:stromen -- ai-rechten
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { rest, rpc, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** Een koppeling zoals mcp-oauth hem uitgeeft, met een geldig toegangstoken. */
function maakKoppeling(w, gebruiker, scope) {
  const clientId = `stromen-${randomUUID()}`;
  sql(`insert into public.mcp_clients (client_id, client_name, redirect_uris) values (${q(clientId)}, 'Stromen-AI', array['https://stromen.test/cb'])`);
  // Het plafond: wat de AI-client bij het koppelen vroeg (hier: alles).
  const grantId = sql(`insert into public.mcp_grants (organization_id, user_id, client_id, scope, scope_ceiling, label)
    values (${q(w.orgId)}, ${q(gebruiker.id)}, ${q(clientId)}, ${q(scope)}, 'read propose execute execute_high', 'stromen') returning id`);
  const selector = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(`${salt}:${verifier}`).digest('hex');
  sql(`insert into public.mcp_tokens (grant_id, kind, selector, verifier_hash, salt, expires_at)
       values (${q(grantId)}, 'access', ${q(selector)}, ${q(hash)}, ${q(salt)}, now() + interval '1 hour')`);
  return { grantId, token: `rsfmcp.${selector}.${verifier}` };
}

/** De tools die de MCP-server deze koppeling aanbiedt. */
async function toolsVan(koppeling) {
  const res = await roep('mcp', { token: koppeling.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  return (res.json?.result?.tools ?? []).map((t) => t.name);
}

/** Een kaart zoals gerrie-signals hem wegschrijft: signaal, voorstel in de wachtrij en de kaart. */
function maakKaart(w, { titel, vereist }) {
  const signaal = sql(`insert into public.ai_signals (organization_id, kind, signal_key, status)
    values (${q(w.orgId)}, 'inbound_mail', ${q(`stromen:${randomUUID()}`)}, 'decided') returning id`);
  const audit = sql(`insert into public.ai_action_audit (organization_id, user_id, action, params, status, signal_id)
    values (${q(w.orgId)}, ${q(w.eigenaar.id)}, 'propose_ticket', ${q(JSON.stringify({ type: 'ticket', title: titel, description: null, client_id: null, client_name: null, priority: 'med', status: 'new' }))}::jsonb, 'proposed', ${q(signaal)}) returning id`);
  const kaart = sql(`insert into public.ai_decisions (organization_id, signal_id, kind, module, origin, title, evidence, proposal, audit_id, required_modules)
    values (${q(w.orgId)}, ${q(signaal)}, 'inbound_mail', 'clients', 'gerrie', ${q(titel)},
            ${q(JSON.stringify(vereist.includes('finance') ? ['Open facturen: 2026-014'] : ['Geen open facturen bij deze klant']))}::jsonb,
            ${q(JSON.stringify({ type: 'ticket', title: titel }))}::jsonb, ${q(audit)},
            ${q(`{${vereist.join(',')}}`)}::text[]) returning id`);
  return { kaart, audit };
}

export default async function aiRechten() {
  groep('AI-rechten: klaarzetten');
  const w = await stap('wereld', () => maakWereld('ai-rechten'));
  if (!w) return;

  groep('AI-koppelingen: rechtstreeks uitvoeren alleen voor owners en admins');
  const vanLid = maakKoppeling(w, w.medewerker, 'read propose');
  const vanBeheerder = maakKoppeling(w, w.beheerder, 'read propose');

  await stap('een teamlid kan rechtstreeks uitvoeren niet aanzetten', async () => {
    for (const scope of ['read propose execute', 'read propose execute execute_high']) {
      const res = await rest(`mcp_grants?id=eq.${vanLid.grantId}`, { method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { scope } });
      geweigerd(res, `scope "${scope}" door een teamlid`, [403]);
      verwacht(/owner of admin/.test(res.tekst), `geen uitleg in de weigering: ${res.tekst.slice(0, 200)}`);
    }
    gelijk(sqlRij(`select scope from public.mcp_grants where id = ${q(vanLid.grantId)}`).scope, 'read propose', 'de koppeling bleef zoals hij was');
  });

  await stap('een admin kan het voor zijn eigen koppeling wel aanzetten', async () => {
    gelukt(await rest(`mcp_grants?id=eq.${vanBeheerder.grantId}`, { method: 'PATCH', token: w.beheerder.token, prefer: 'return=representation', body: { scope: 'read propose execute' } }), 'execute door de admin');
    gelijk(sqlRij(`select scope from public.mcp_grants where id = ${q(vanBeheerder.grantId)}`).scope, 'read propose execute', 'scope');
    const tools = await toolsVan(vanBeheerder);
    verwacht(tools.includes('execute_action'), `execute_action ontbreekt voor de admin: ${tools.join(', ')}`);
  });

  await stap('een koppeling die het recht nog draagt, voert voor een teamlid niets rechtstreeks uit', async () => {
    // Zoals een koppeling van vóór de migratie, of van een admin die teamlid werd:
    // de server zet het recht erin, langs de trigger heen.
    sql(`update public.mcp_grants set scope = 'read propose execute execute_high' where id = ${q(vanLid.grantId)}`);
    const tools = await toolsVan(vanLid);
    verwacht(tools.includes('propose_action') && !tools.includes('execute_action'), `tools voor het teamlid: ${tools.join(', ')}`);
    const res = await roep('mcp', { token: vanLid.token, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_action', arguments: { action_id: 'client.update', input: {} } } } });
    verwacht(res.json?.result?.isError === true || res.json?.error, `execute_action werd toch uitgevoerd: ${res.tekst.slice(0, 200)}`);
  });

  await stap('wordt de admin teamlid, dan stopt het rechtstreeks uitvoeren bij de volgende aanroep', async () => {
    sql(`update public.organization_members set role = 'member' where organization_id = ${q(w.orgId)} and user_id = ${q(w.beheerder.id)}`);
    try {
      const tools = await toolsVan(vanBeheerder);
      verwacht(!tools.includes('execute_action'), `execute_action nog aangeboden na het terugzetten: ${tools.join(', ')}`);
    } finally {
      sql(`update public.organization_members set role = 'admin' where organization_id = ${q(w.orgId)} and user_id = ${q(w.beheerder.id)}`);
    }
  });

  groep('Beslislijst: een kaart volgt alle modulerechten');
  const metFinancien = maakKaart(w, { titel: 'Klant mailt over factuur 2026-014', vereist: ['finance'] });
  const zonderExtra = maakKaart(w, { titel: 'Klant vraagt om een belafspraak', vereist: [] });
  const beide = `ai_decisions?select=id,title&id=in.(${metFinancien.kaart},${zonderExtra.kaart})&order=title`;

  await stap('een teamlid zonder Financiën ziet de kaart met open facturen niet, de andere wel', async () => {
    const res = gelukt(await rest(beide, { token: w.zonderFinancien.token }), 'kaarten lezen');
    gelijk(res.map((r) => r.id), [zonderExtra.kaart], 'zichtbare kaarten');
  });

  await stap('een teamlid met Financiën en de eigenaar zien ze allebei', async () => {
    for (const [naam, gebruiker] of [['lid', w.medewerker], ['eigenaar', w.eigenaar]]) {
      const res = gelukt(await rest(beide, { token: gebruiker.token }), `kaarten lezen (${naam})`);
      gelijk(res.length, 2, `zichtbare kaarten (${naam})`);
    }
  });

  await stap('een teamlid zonder Financiën kan de kaart niet afhandelen of dempen', async () => {
    geweigerd(await rpc('ai_decision_resolve', { p_id: metFinancien.kaart, p_status: 'dismissed' }, w.zonderFinancien.token), 'afhandelen', [403]);
    geweigerd(await rpc('ai_decision_mute', { p_decision_id: metFinancien.kaart, p_scope: 'entity' }, w.zonderFinancien.token), 'dempen', [403]);
    gelijk(sqlRij(`select status from public.ai_decisions where id = ${q(metFinancien.kaart)}`).status, 'open', 'de kaart staat nog open');
  });

  await stap('…en niet beslissen over het voorstel erachter', async () => {
    const res = await roep('gerrie-agent', { token: w.zonderFinancien.token, body: { action: 'confirm', organizationId: w.orgId, auditId: metFinancien.audit, outcome: 'claim' } });
    geweigerd(res, 'claim door een teamlid zonder Financiën', [403]);
    gelijk(sqlRij(`select status, result from public.ai_action_audit where id = ${q(metFinancien.audit)}`).result, null, 'niets vastgezet');
  });

  await stap('een teamlid met alle rechten kan het wel', async () => {
    gelukt(await roep('gerrie-agent', { token: w.medewerker.token, body: { action: 'confirm', organizationId: w.orgId, auditId: metFinancien.audit, outcome: 'claim' } }), 'claim door het lid');
    gelukt(await rpc('ai_decision_resolve', { p_id: metFinancien.kaart, p_status: 'dismissed' }, w.medewerker.token), 'afhandelen door het lid');
    gelijk(sqlRij(`select status from public.ai_decisions where id = ${q(metFinancien.kaart)}`).status, 'dismissed', 'status');
  });
}
