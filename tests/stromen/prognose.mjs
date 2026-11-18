// De prognose (Financiën → Prognose), van begin tot eind tegen een lokale stack.
//
// Wat hier wordt nagelopen (CHANGELOG_PROGNOSE_2026-11-18.md):
//   1. forecast_history: per maand de nieuwe projecten, de gefactureerde omzet
//      met en zonder project (min een creditnota), de inkoop en de offertes.
//      Concepten, geannuleerde facturen en een andere organisatie tellen niet;
//      wie Projecten niet mag lezen, krijgt geen aantal;
//   2. prognoses bewaren zoals het scherm doet (repository.ts): aanmaken,
//      wijzigen met de versie als controle, de geschiedenis die de database
//      zelf bijhoudt, en wie dat allemaal niet mag;
//   3. de AI: via de openbare API (dezelfde registry als Gerrie, de agents en
//      de MCP) de prognose lezen, een wijziging klaarzetten, en die na het
//      goedkeuren zien uitkomen op precies de winst die de kaart noemde;
//   4. een voorstel op een oude versie verandert niets, onzin wordt geweigerd
//      met een reden, en een prognose van een andere organisatie bestaat niet.
//
// De AI voert niets zelf uit (CLAUDE.md, regel 2): een voorstel komt in de
// goedkeurwachtrij, en de uitvoerder in de browser (src/lib/actions/forecast.ts)
// schrijft het weg met de rechten van wie goedkeurt. Die stap doet dit scenario
// na met dezelfde PATCH als updateForecast().
import { API_URL } from './omgeving.mjs';
import { roep, roepRequest } from './functies.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';
import {
  addMonths, computeCashflow, computeForecast, historyRange, monthOfDate, normalizeAssumptions, parseCashPosition,
  parseForecastInputs, wholeEuroText,
} from '../../supabase/functions/_shared/forecast.ts';

const BASIS = `${API_URL}/functions/v1/api`;

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function vandaag() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

/** Een aanroep van de openbare API, zoals een koppeling hem doet. */
async function api(pad, { sleutel, method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${sleutel}` };
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await roepRequest('api', new Request(`${BASIS}${pad}`, init));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

/** Een sleutel zoals Instellingen → API & webhooks hem maakt (api-admin). */
async function maakSleutel(gebruiker, orgId, { naam, access, moduleAccess } = {}) {
  const body = gelukt(await roep('api-admin', {
    token: gebruiker.token,
    body: { action: 'createKey', organizationId: orgId, name: naam, access, moduleAccess },
  }), `sleutel ${naam}`);
  return { id: body.key.id, geheim: body.secret };
}

/** Wat het scherm doet: de cijfers ophalen met het token van de gebruiker, en uitrekenen. */
async function scherm(w, gebruiker, assumptions) {
  const today = vandaag();
  const range = historyRange(today, [normalizeAssumptions(assumptions).start_month]);
  const raw = gelukt(await rpc('forecast_history', {
    p_organization_id: w.orgId, p_from: `${range.from}-01`, p_to: `${range.to}-01`,
  }, gebruiker.token), 'forecast_history');
  return computeForecast(assumptions, parseForecastInputs(raw, today), today);
}

/** Wat het scherm in de weergave Cashflow doet: ook de cashpositie ophalen, en de cashflow uitrekenen. */
async function schermCash(w, gebruiker, assumptions) {
  const today = vandaag();
  const range = historyRange(today, [normalizeAssumptions(assumptions).start_month]);
  const raw = gelukt(await rpc('forecast_history', {
    p_organization_id: w.orgId, p_from: `${range.from}-01`, p_to: `${range.to}-01`,
  }, gebruiker.token), 'forecast_history');
  const positie = gelukt(await rpc('forecast_cash_position', { p_organization_id: w.orgId }, gebruiker.token), 'forecast_cash_position');
  const inputs = parseForecastInputs(raw, today);
  const uitkomst = computeForecast(assumptions, inputs, today);
  return { uitkomst, flow: computeCashflow(uitkomst, inputs, parseCashPosition(positie, today), today) };
}

/** Wat repository.createForecast() verstuurt. */
function maakPrognose(w, gebruiker, naam, assumptions = {}) {
  return rest('forecasts?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: gebruiker.id, name: naam, notes: null, assumptions, change_note: 'Nieuwe prognose' },
  });
}

/** Wat repository.updateForecast() verstuurt: alleen als de prognose nog op die versie staat. */
function wijzigPrognose(w, gebruiker, id, patch, versie) {
  const voorwaarde = versie === undefined ? '' : `&version=eq.${versie}`;
  return rest(`forecasts?id=eq.${id}&organization_id=eq.${w.orgId}${voorwaarde}&select=*`, {
    method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: patch,
  });
}

function versies(id) {
  return sqlRijen(`select version, change_note, created_by, assumptions from public.forecast_versions where forecast_id = ${q(id)} order by version`);
}

/** De gegevens van organisatie A: drie maanden met projecten, facturen, inkoop en offertes. */
function vulAdministratie(w, maanden) {
  const { m1, m2, m3, volgende } = maanden;
  const org = q(w.orgId);
  const wie = q(w.eigenaar.id);
  const project = (naam) => `(select id from public.projects where organization_id = ${org} and name = ${q(naam)})`;
  const regels = (aantal, prijs) => q(JSON.stringify([{ id: 'r1', description: 'Werk', quantity: aantal, unit_price: prijs, vat: 21 }]));
  sql(`
    insert into public.projects (organization_id, created_by, name, start_date) values
      (${org}, ${wie}, 'Website Jansen', '${m3}-03'),
      (${org}, ${wie}, 'Huisstijl Pietersen', '${m3}-20'),
      (${org}, ${wie}, 'Campagne De Vries', '${m2}-05');
    insert into public.invoices (organization_id, created_by, project_id, number, date, status, lines) values
      (${org}, ${wie}, ${project('Website Jansen')}, 'PRG-001', '${m3}-25', 'paid', ${regels(1, 4000)}),
      (${org}, ${wie}, ${project('Huisstijl Pietersen')}, 'PRG-002', '${m3}-28', 'sent', ${regels(2, 1000)}),
      (${org}, ${wie}, null, 'PRG-003', '${m2}-12', 'paid', ${regels(1, 500)}),
      (${org}, ${wie}, null, 'PRG-004', '${m2}-14', 'draft', ${regels(1, 9999)}),
      (${org}, ${wie}, null, 'PRG-005', '${m2}-15', 'cancelled', ${regels(1, 7777)});
    insert into public.credit_notes (organization_id, invoice_id, number, date, subtotal_amount, vat_amount, total_amount, status, lines)
      select ${org}, id, 'PRG-C001', '${m1}-03', 100, 21, 121, 'issued', '[]'::jsonb
        from public.invoices where organization_id = ${org} and number = 'PRG-003';
    insert into public.purchase_invoices (organization_id, created_by, date, status, subtotal_cents, vat_cents, total_cents, lines) values
      (${org}, ${wie}, '${m3}-10', 'booked', 150000, 31500, 181500, '[]'),
      (${org}, ${wie}, '${m2}-10', 'draft', 99900, 0, 99900, '[]');
    insert into public.quotes (organization_id, created_by, number, date, valid_until, status, lines) values
      (${org}, ${wie}, 'PRG-O01', '${m1}-20', '${volgende}-28', 'sent', ${q(JSON.stringify([{ id: 'r1', description: 'Nieuwe site', quantity: '1', unit_price: '6000', vat: 21 }]))}),
      (${org}, ${wie}, 'PRG-O02', '${m1}-22', null, 'accepted', ${regels(2, 750)});
  `);
}

export default async function prognose() {
  const today = vandaag();
  const M = monthOfDate(today);
  const maanden = { m3: addMonths(M, -3), m2: addMonths(M, -2), m1: addMonths(M, -1), volgende: addMonths(M, 1) };

  const a = await maakWereld('prognose');
  const b = await maakWereld('prognose-b');

  groep('Prognose: de cijfers waar hij op rust (forecast_history)');
  await stap('de administratie van A, en een factuur van B die nergens mag meetellen', async () => {
    vulAdministratie(a, maanden);
    sql(`insert into public.invoices (organization_id, created_by, number, date, status, lines) values
      (${q(b.orgId)}, ${q(b.eigenaar.id)}, 'B-001', '${maanden.m2}-12', 'paid', ${q(JSON.stringify([{ id: 'r1', description: 'Van B', quantity: 1, unit_price: 123456, vat: 21 }]))})`);
  });

  await stap('per maand: projecten, omzet met en zonder project, de creditnota en de inkoop', async () => {
    const raw = gelukt(await rpc('forecast_history', { p_organization_id: a.orgId, p_from: `${maanden.m3}-01`, p_to: `${maanden.m1}-01` }, a.eigenaar.token), 'forecast_history');
    gelijk(raw.projects_visible, true, 'projecten zichtbaar voor de eigenaar');
    const per = Object.fromEntries(raw.months.map((maand) => [maand.month, maand]));
    gelijk([per[maanden.m3].projects, per[maanden.m2].projects, per[maanden.m1].projects], [2, 1, 0], 'nieuwe projecten');
    gelijk(per[maanden.m3].revenue_project_cents, 600000, 'omzet met project (€ 4.000 + € 2.000, exclusief btw)');
    gelijk(per[maanden.m2].revenue_other_cents, 50000, 'omzet zonder project: alleen de betaalde, geen concept of geannuleerde');
    gelijk(per[maanden.m1].revenue_other_cents, -10000, 'de creditnota in de maand van de creditnota');
    gelijk(per[maanden.m3].purchase_cents, 150000, 'inkoop: geboekt telt, een concept niet');
    gelijk(per[maanden.m2].purchase_cents, 0, 'conceptinkoop');
    gelijk(raw.pipeline.open_count, 1, 'verstuurde offerte');
    gelijk(raw.pipeline.open_cents, 600000, 'bedrag verstuurde offerte (de regels als tekst)');
    gelijk(raw.pipeline.accepted_count, 1, 'geaccepteerd zonder factuur');
    gelijk(raw.pipeline.accepted_cents, 150000, 'bedrag geaccepteerd');
  });

  await stap('de boekhouder leest de cijfers, maar zonder aantallen projecten', async () => {
    const raw = gelukt(await rpc('forecast_history', { p_organization_id: a.orgId, p_from: `${maanden.m3}-01`, p_to: `${maanden.m1}-01` }, a.boekhouder.token), 'boekhouder');
    gelijk(raw.projects_visible, false, 'projects_visible');
    verwacht(raw.months.every((maand) => maand.projects === null), 'de boekhouder kreeg aantallen projecten');
    gelijk(raw.months.find((maand) => maand.month === maanden.m3)?.revenue_project_cents, 600000, 'omzet wel');
  });

  await stap('zonder Financiën, van een andere organisatie of te lang: geweigerd', async () => {
    geweigerd(await rpc('forecast_history', { p_organization_id: a.orgId, p_from: `${maanden.m3}-01`, p_to: `${maanden.m1}-01` }, a.zonderFinancien.token), 'zonder Financiën', [401, 403]);
    geweigerd(await rpc('forecast_history', { p_organization_id: a.orgId, p_from: `${maanden.m3}-01`, p_to: `${maanden.m1}-01` }, b.eigenaar.token), 'andere organisatie', [401, 403]);
    geweigerd(await rpc('forecast_history', { p_organization_id: a.orgId, p_from: '2015-01-01', p_to: `${maanden.m1}-01` }, a.eigenaar.token), 'tien jaar', [400]);
  });

  await stap('het leerjaar: het gemiddelde vanaf de eerste maand met iets erin', async () => {
    const uitkomst = await scherm(a, a.eigenaar, {});
    const basis = uitkomst.baseline;
    gelijk(basis.from, maanden.m3, 'begin van het leerjaar');
    gelijk(basis.months, 3, 'maanden');
    gelijk(basis.projects_per_month, 1, 'projecten per maand');
    gelijk(basis.revenue_per_project_cents, 200000, 'omzet per project');
    gelijk(basis.other_revenue_cents, 13333, 'overige omzet per maand ((€ 500 − € 100) / 3)');
    verwacht(basis.fixed_costs_cents >= 50000, `kosten per maand ${basis.fixed_costs_cents}`);
  });

  groep('Prognose: bewaren zoals het scherm');
  const basis = await stap('de eigenaar bewaart een prognose; versie 1 staat in de geschiedenis', async () => {
    const res = await maakPrognose(a, a.eigenaar, 'Basis');
    const rij = gelukt(res, 'aanmaken')[0];
    gelijk(rij.version, 1, 'versie');
    gelijk(versies(rij.id).map((v) => v.version), [1], 'geschiedenis');
    gelijk(versies(rij.id)[0].created_by, a.eigenaar.id, 'door wie');
    return rij;
  });

  await stap('wijzigen met de versie als controle; met een oude versie verandert er niets', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const rij = gelukt(await wijzigPrognose(a, a.eigenaar, id, { assumptions: { growth_pct: 5 }, change_note: 'Groei per jaar: 0% → 5%' }, 1), 'wijzigen')[0];
    gelijk(rij.version, 2, 'versie na wijzigen');
    nietsVeranderd(await wijzigPrognose(a, a.medewerker, id, { assumptions: { growth_pct: 50 } }, 1), 'wijzigen op versie 1');
    gelijk(sqlRij(`select (assumptions->>'growth_pct')::numeric as groei from public.forecasts where id = ${q(id)}`)?.groei, 5, 'groei overschreven');
    gelijk(versies(id).map((v) => [v.version, v.change_note]), [[1, 'Nieuwe prognose'], [2, 'Groei per jaar: 0% → 5%']], 'geschiedenis');
  });

  await stap('een naam komt één keer voor, en de aannames zijn een object', async () => {
    geweigerd(await maakPrognose(a, a.eigenaar, 'basis'), 'dubbele naam', [409]);
    geweigerd(await maakPrognose(a, a.eigenaar, 'Lijst', [1, 2]), 'aannames als lijst', [400]);
  });

  await stap('lezen met leesrecht, wijzigen niet: lezer, kijker en boekhouder', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    for (const [wie, gebruiker] of [['lezer', a.lezer], ['kijker', a.kijker], ['boekhouder', a.boekhouder]]) {
      const lijst = gelukt(await rest(`forecasts?organization_id=eq.${a.orgId}&select=id`, { token: gebruiker.token }), `${wie} leest`);
      verwacht(lijst.some((rij) => rij.id === id), `${wie} ziet de prognose niet`);
      nietsVeranderd(await wijzigPrognose(a, gebruiker, id, { assumptions: { growth_pct: 99 } }), `${wie} wijzigt`);
      const nieuw = await maakPrognose(a, gebruiker, `Van ${wie}`);
      verwacht(nieuw.status >= 400, `${wie} maakte een prognose (${nieuw.status})`);
    }
    gelijk(Number(sql(`select count(*) from public.forecasts where organization_id = ${q(a.orgId)}`)), 1, 'aantal prognoses');
  });

  await stap('zonder Financiën en van een andere organisatie: niets te zien', async () => {
    gelijk(gelukt(await rest(`forecasts?organization_id=eq.${a.orgId}&select=id`, { token: a.zonderFinancien.token }), 'zonder Financiën'), [], 'zonder Financiën');
    gelijk(gelukt(await rest(`forecasts?organization_id=eq.${a.orgId}&select=id`, { token: b.eigenaar.token }), 'andere organisatie'), [], 'andere organisatie');
    gelijk(gelukt(await rest(`forecast_versions?organization_id=eq.${a.orgId}&select=id`, { token: b.eigenaar.token }), 'versies van A'), [], 'versies van A');
  });

  await stap('de geschiedenis schrijf je niet zelf', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const res = await rest('forecast_versions', {
      method: 'POST', token: a.eigenaar.token,
      body: { organization_id: a.orgId, forecast_id: id, version: 99, name: 'Vals', assumptions: {} },
    });
    verwacht(res.status >= 400, `een versie zelf geschreven (${res.status})`);
    nietsVeranderd(await rest(`forecast_versions?forecast_id=eq.${id}`, { method: 'DELETE', token: a.eigenaar.token, prefer: 'return=representation' }), 'versies weggooien');
    gelijk(versies(id).length, 2, 'aantal versies');
  });

  groep('Prognose: de AI past hem aan, een mens keurt goed');
  const sleutels = await stap('sleutels zoals Instellingen → API: lezen, klaarzetten, en een zonder Financiën', async () => ({
    lezen: await maakSleutel(a.beheerder, a.orgId, { naam: 'Prognose lezen', access: 'read' }),
    klaarzetten: await maakSleutel(a.beheerder, a.orgId, { naam: 'Prognose voorstellen', access: 'propose' }),
    zonderFinancien: await maakSleutel(a.beheerder, a.orgId, { naam: 'Zonder geld', access: 'read', moduleAccess: { finance: 'none' } }),
  }));

  await stap('forecast.list: dezelfde winst als het scherm, met de offertes erbij', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const res = await api('/v1/actions/forecast.list', { sleutel: nodig(sleutels?.lezen, 'leessleutel').geheim, method: 'POST', body: {} });
    gelijk(res.status, 200, `forecast.list ${res.tekst.slice(0, 200)}`);
    const tekst = JSON.stringify(res.json);
    verwacht(tekst.includes(id), 'de prognose ontbreekt');
    const uitkomst = await scherm(a, a.eigenaar, { growth_pct: 5 });
    verwacht(tekst.includes(`"profit":${uitkomst.totals.profit_cents / 100}`), `winst ${uitkomst.totals.profit_cents / 100} niet gevonden in ${tekst.slice(0, 400)}`);
    verwacht(tekst.includes('"open_quotes":1') && tekst.includes('"accepted_not_invoiced_amount":1500'), 'offertes ontbreken');
  });

  const voorstel = await stap('forecast.update klaarzetten: de kaart noemt de wijziging en de winst ervoor en erna', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const res = await api('/v1/actions/forecast.update', {
      sleutel: nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim, method: 'POST',
      body: { forecast_id: id, growth_pct: 10, add_items: [{ label: 'Nieuwe medewerker', kind: 'cost', amount: 3000, from: maanden.volgende }] },
    });
    gelijk(res.status, 202, `klaarzetten ${res.tekst.slice(0, 300)}`);
    const kaart = res.json.proposal;
    gelijk(kaart.title, 'Prognose aanpassen: Basis', 'titel');
    verwacht(kaart.details.includes('Groei per jaar: 5% → 10%'), `de kaart noemt de groei niet: ${kaart.details}`);
    verwacht(kaart.details.includes('Post erbij: Nieuwe medewerker'), `de kaart noemt de post niet: ${kaart.details}`);
    verwacht(/verwachte winst € -?[\d.]+ → € -?[\d.]+ over/.test(kaart.details), `geen winst ervoor en erna, in hele euro's: ${kaart.details}`);
    gelijk(sqlRij(`select version from public.forecasts where id = ${q(id)}`)?.version, 2, 'al uitgevoerd terwijl hij alleen klaar mocht zetten');
    return kaart;
  });

  await stap('goedkeuren: de app schrijft het plan weg, en het scherm komt op de winst van de kaart', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const kaart = nodig(voorstel, 'voorstel');
    const audit = sqlRij(`select params from public.ai_action_audit where id = ${q(kaart.id)}`);
    const payload = nodig(audit?.params?.payload, 'payload van het voorstel');
    gelijk(payload.expected_version, 2, 'het voorstel hoort bij versie 2');
    // De uitvoerder in de browser (src/lib/actions/forecast.ts) doet precies dit.
    const rij = gelukt(await wijzigPrognose(a, a.eigenaar, id, { ...payload.patch, change_note: payload.change_note }, payload.expected_version), 'uitvoeren')[0];
    gelijk(rij.version, 3, 'versie na goedkeuren');
    const nu = await scherm(a, a.eigenaar, rij.assumptions);
    const beloofd = kaart.details.match(/→ (€ -?[\d.]+) over/)?.[1];
    gelijk(wholeEuroText(nu.totals.profit_cents), beloofd, 'de winst op het scherm na goedkeuren');
    const laatste = versies(id).at(-1);
    verwacht(laatste.change_note.startsWith('AI-voorstel: '), `de geschiedenis zegt niet dat het een voorstel was: ${laatste.change_note}`);
    gelijk(laatste.created_by, a.eigenaar.id, 'goedgekeurd door');
  });

  await stap('hetzelfde voorstel nog eens: de prognose staat al verder, er verandert niets', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const payload = nodig(sqlRij(`select params from public.ai_action_audit where id = ${q(nodig(voorstel, 'voorstel').id)}`)?.params?.payload, 'payload');
    nietsVeranderd(await wijzigPrognose(a, a.eigenaar, id, { ...payload.patch, change_note: payload.change_note }, payload.expected_version), 'oud voorstel');
    gelijk(sqlRij(`select version from public.forecasts where id = ${q(id)}`)?.version, 3, 'versie');
  });

  await stap('onzin wordt geweigerd met een reden, en een post die niet bestaat ook', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const sleutel = nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim;
    const groei = await api('/v1/actions/forecast.update', { sleutel, method: 'POST', body: { forecast_id: id, growth_pct: 500 } });
    geweigerd(groei, 'groei 500%', [400, 422]);
    verwacht(groei.tekst.includes('Groei per jaar'), `geen reden: ${groei.tekst}`);
    const post = await api('/v1/actions/forecast.update', { sleutel, method: 'POST', body: { forecast_id: id, remove_item_ids: ['post-99'] } });
    geweigerd(post, 'post die niet bestaat', [400, 422]);
    const niets = await api('/v1/actions/forecast.update', { sleutel, method: 'POST', body: { forecast_id: id, growth_pct: 10 } });
    geweigerd(niets, 'een wijziging die niets wijzigt', [400, 422]);
  });

  await stap('een prognose van een andere organisatie bestaat voor de AI niet', async () => {
    const vanB = gelukt(await maakPrognose(b, b.eigenaar, 'Van B'), 'prognose van B')[0];
    const res = await api('/v1/actions/forecast.update', { sleutel: nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim, method: 'POST', body: { forecast_id: vanB.id, growth_pct: 20 } });
    geweigerd(res, 'prognose van B', [404, 422]);
    const lijst = await api('/v1/actions/forecast.list', { sleutel: nodig(sleutels?.lezen, 'leessleutel').geheim, method: 'POST', body: {} });
    verwacht(!JSON.stringify(lijst.json).includes(vanB.id), 'de prognose van B staat in de lijst van A');
  });

  await stap('een sleutel zonder Financiën vindt de prognose niet', async () => {
    const res = await api('/v1/actions/forecast.list', { sleutel: nodig(sleutels?.zonderFinancien, 'sleutel zonder Financiën').geheim, method: 'POST', body: {} });
    geweigerd(res, 'forecast.list zonder Financiën', [403]);
  });

  await stap('een nieuw scenario klaarzetten, en verwijderen is definitief', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const sleutel = nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim;
    const nieuw = await api('/v1/actions/forecast.create', { sleutel, method: 'POST', body: { name: 'Voorzichtig', copy_from_id: id, projects_per_month: 0.5 } });
    gelijk(nieuw.status, 202, `forecast.create ${nieuw.tekst.slice(0, 200)}`);
    verwacht(nieuw.json.proposal.details.includes('kopie van Basis'), `geen kopie: ${nieuw.json.proposal.details}`);
    const dubbel = await api('/v1/actions/forecast.create', { sleutel, method: 'POST', body: { name: 'basis' } });
    geweigerd(dubbel, 'dubbele naam', [400, 422]);
    const weg = await api('/v1/actions/forecast.delete', { sleutel, method: 'POST', body: { forecast_id: id } });
    gelijk(weg.status, 202, 'forecast.delete');
    gelijk(weg.json.proposal.irreversible, true, 'verwijderen is onomkeerbaar');
    gelijk(Number(sql(`select count(*) from public.forecasts where organization_id = ${q(a.orgId)}`)), 1, 'al aangemaakt of verwijderd zonder akkoord');
  });

  // ── Seizoen en cashflow (20261118171500) ──────────────────────────────────
  groep('Prognose: seizoen en cashflow');
  await stap('een bankrekening met een afschrift, en klanten die binnen 30 dagen betalen', async () => {
    const org = q(a.orgId);
    sql(`
      update public.company_settings set invoice_payment_terms = 'Betaling binnen 30 dagen.' where organization_id = ${org};
      insert into public.bank_accounts (organization_id, created_by, name, iban, currency, ledger_account_id, is_active, source)
        select ${org}, ${q(a.eigenaar.id)}, 'Zakelijk', 'NL91ABNA0417164300', 'EUR', id, true, 'import'
          from public.ledger_accounts where organization_id = ${org} and code = '1100';
      insert into public.bank_statements (organization_id, bank_account_id, format, period_start, period_end, opening_balance_cents, closing_balance_cents)
        select ${org}, id, 'camt053', (now() at time zone 'Europe/Amsterdam')::date - 40, (now() at time zone 'Europe/Amsterdam')::date - 10, 1000000, 1500000
          from public.bank_accounts where organization_id = ${org} and name = 'Zakelijk';
      insert into public.bank_transactions (organization_id, bank_account_id, dedup_key, booking_date, amount_cents, counterparty_name, status)
        select ${org}, id, 'prg-na-afschrift', (now() at time zone 'Europe/Amsterdam')::date - 3, 250000, 'Klant', 'unmatched'
          from public.bank_accounts where organization_id = ${org} and name = 'Zakelijk';
    `);
  });

  await stap('forecast_cash_position: saldo, openstaande posten en de betaaltermijn; wie het niet mag, krijgt niets', async () => {
    const positie = gelukt(await rpc('forecast_cash_position', { p_organization_id: a.orgId }, a.eigenaar.token), 'forecast_cash_position');
    gelijk(positie.bank.map((rekening) => [rekening.name, rekening.balance_cents, rekening.method]), [['Zakelijk', 1750000, 'statement']],
      'het afschrift (€ 15.000) plus wat er daarna binnenkwam (€ 2.500)');
    gelijk(positie.receivables.reduce((som, rij) => som + rij.cents, 0), 242000, 'openstaand: PRG-002 (€ 2.000 + 21%); betaald, concept en geannuleerd niet');
    gelijk(positie.payables.reduce((som, rij) => som + rij.cents, 0), 181500, 'te betalen: de geboekte inkoop (€ 1.500 + € 315), het concept niet');
    gelijk(positie.payment_terms_days, 30, 'betaaltermijn uit de bedrijfsgegevens');
    gelijk(positie.vat_frequency, 'quarterly', 'btw per kwartaal');
    const boekhouder = gelukt(await rpc('forecast_cash_position', { p_organization_id: a.orgId }, a.boekhouder.token), 'boekhouder');
    gelijk(boekhouder.bank[0]?.balance_cents, 1750000, 'de boekhouder ziet het saldo (leesrecht op Financiën)');
    geweigerd(await rpc('forecast_cash_position', { p_organization_id: a.orgId }, a.zonderFinancien.token), 'zonder Financiën', [401, 403]);
    geweigerd(await rpc('forecast_cash_position', { p_organization_id: a.orgId }, b.eigenaar.token), 'andere organisatie', [401, 403]);
  });

  await stap('forecast.list: de cashflow begint bij hetzelfde saldo als het scherm, en het seizoen zegt waarom het er nog niet is', async () => {
    const res = await api('/v1/actions/forecast.list', { sleutel: nodig(sleutels?.lezen, 'leessleutel').geheim, method: 'POST', body: {} });
    gelijk(res.status, 200, `forecast.list ${res.tekst.slice(0, 200)}`);
    const prognose = res.json.result?.forecasts?.[0] ?? res.json.forecasts?.[0] ?? res.json.data?.forecasts?.[0];
    nodig(prognose, `de prognose in ${res.tekst.slice(0, 300)}`);
    gelijk(prognose.cashflow.available, true, `cashflow: ${prognose.cashflow.reason}`);
    gelijk(prognose.cashflow.start.balance, 17500, 'banksaldo nu in euro\'s');
    const { flow } = await schermCash(a, a.eigenaar, prognose.assumptions);
    gelijk(prognose.cashflow.end_balance, flow.end_cents / 100, 'het saldo aan het eind: dezelfde som als het scherm');
    gelijk(prognose.seasonality.available, false, 'seizoen met drie maanden omzet');
    verwacht(/minstens twee hele jaren/.test(prognose.seasonality.reason), `reden: ${prognose.seasonality.reason}`);
  });

  const busVoorstel = await stap('een investering (geld eraf) klaarzetten: de winst blijft, het laagste saldo staat op de kaart', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const res = await api('/v1/actions/forecast.update', {
      sleutel: nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim, method: 'POST',
      body: { forecast_id: id, add_items: [{ label: 'Nieuwe bus', kind: 'cash_out', amount: 25000, from: maanden.volgende, to: maanden.volgende }] },
    });
    gelijk(res.status, 202, `klaarzetten ${res.tekst.slice(0, 300)}`);
    const kaart = res.json.proposal;
    verwacht(kaart.details.includes('Post erbij: Nieuwe bus: geld eraf € 25.000 per maand'), `de kaart noemt de bus niet: ${kaart.details}`);
    verwacht(/verwachte winst € -?[\d.]+ over/.test(kaart.details) && !/verwachte winst € -?[\d.]+ →/.test(kaart.details), `de winst veranderde: ${kaart.details}`);
    verwacht(/laagste saldo € -?[\d.]+ → € -?[\d.]+ \(/.test(kaart.details), `geen laagste saldo ervoor en erna: ${kaart.details}`);
    return kaart;
  });

  await stap('goedkeuren: het scherm komt op het laagste saldo van de kaart', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const kaart = nodig(busVoorstel, 'voorstel met de bus');
    const payload = nodig(sqlRij(`select params from public.ai_action_audit where id = ${q(kaart.id)}`)?.params?.payload, 'payload');
    const rij = gelukt(await wijzigPrognose(a, a.eigenaar, id, { ...payload.patch, change_note: payload.change_note }, payload.expected_version), 'uitvoeren')[0];
    const { flow } = await schermCash(a, a.eigenaar, rij.assumptions);
    const beloofd = kaart.details.match(/laagste saldo € -?[\d.]+ → (€ -?[\d.]+) \(/)?.[1];
    gelijk(wholeEuroText(flow.lowest.cents), beloofd, 'het laagste saldo op het scherm na goedkeuren');
    gelijk(flow.months.find((maand) => maand.month === maanden.volgende)?.other_cents, -2500000, 'de bus in zijn maand');
  });

  await stap('het seizoenspatroon aanzetten: de kaart zegt het, en zonder patroon blijft de winst gelijk', async () => {
    const id = nodig(basis?.id, 'prognose Basis');
    const res = await api('/v1/actions/forecast.update', {
      sleutel: nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim, method: 'POST',
      body: { forecast_id: id, seasonality_pct: 100, collection_days: 45, cash_buffer: 5000 },
    });
    gelijk(res.status, 202, `klaarzetten ${res.tekst.slice(0, 300)}`);
    const details = res.json.proposal.details;
    for (const verwachtTekst of ['Seizoenspatroon: uit → 100%', 'Klanten betalen na: automatisch → 45 dagen', 'Ondergrens saldo: € 0 → € 5.000']) {
      verwacht(details.includes(verwachtTekst), `de kaart noemt "${verwachtTekst}" niet: ${details}`);
    }
    verwacht(!/verwachte winst € -?[\d.]+ →/.test(details), `zonder patroon veranderde de winst: ${details}`);
    const onzin = await api('/v1/actions/forecast.update', { sleutel: nodig(sleutels?.klaarzetten, 'voorstelsleutel').geheim, method: 'POST', body: { forecast_id: id, seasonality_pct: 150 } });
    geweigerd(onzin, 'seizoen 150%', [400, 422]);
    verwacht(onzin.tekst.includes('Seizoenspatroon'), `geen reden: ${onzin.tekst}`);
  });
}
