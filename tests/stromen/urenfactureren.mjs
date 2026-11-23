// Uren factureren, van begin tot eind: geregistreerde uren worden een
// conceptfactuur, liggen daarna vast, komen nooit twee keer op een factuur en
// komen weer vrij als de factuur vervalt.
//
// Waarom dit scenario er is (controle "van werk naar geld", 22 november 2026,
// bevinding 1): er was geen weg van uren naar een factuur. Je typte het bedrag
// over, hield zelf bij wat al gefactureerd was, en Gerrie factureerde stil 25
// van de 110 registraties (€ 2.337,50 in plaats van € 10.285). Dezelfde maand
// oktober zit hier in: 110 registraties van 66 minuten à € 85.
//
// Alles gaat zoals de app het doet: de eigen sessie tegen REST en de RPC's
// (migratie 20261123110000), versturen en crediteren via invoice-workflow, en
// Gerrie/MCP via de openbare API. De uitkomst wordt nagekeken in de database.
import { randomUUID } from 'node:crypto';
import { API_URL } from './omgeving.mjs';
import { roep, roepRequest } from './functies.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const BASIS = `${API_URL}/functions/v1/api`;

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

function vandaag(plusDagen = 0) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(Date.now() + plusDagen * 86_400_000));
}

/** Een aanroep van de openbare API, zoals een koppeling (of de MCP-server) hem doet. */
async function api(pad, { sleutel, body }) {
  const res = await roepRequest('api', new Request(`${BASIS}${pad}`, {
    method: 'POST', headers: { authorization: `Bearer ${sleutel}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

async function maakSleutel(gebruiker, orgId, access) {
  const body = gelukt(await roep('api-admin', {
    token: gebruiker.token, body: { action: 'createKey', organizationId: orgId, name: `Uren ${access}`, access },
  }), `sleutel ${access}`);
  return body.secret;
}

async function project(w, klant, naam, tariefCent, soort = 'hourly') {
  return gelukt(await rest('projects?select=id,name', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, client_id: klant.id, name: naam, hourly_rate_cents: tariefCent, billing_type: soort },
  }), `project ${naam}`)[0];
}

/** Uren zoals createTimeEntry ze opslaat (src/lib/repository.ts). */
async function uren(w, rijen) {
  return gelukt(await rest('time_entries?select=id,minutes,entry_date', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: rijen.map((rij) => ({
      organization_id: w.orgId, created_by: w.eigenaar.id, user_id: w.eigenaar.id, source: 'manual',
      billable: true, entry_type: 'direct', description: null, ...rij,
    })),
  }), 'uren registreren');
}

function voorbeeld(w, args, token = w.eigenaar.token) {
  return rpc('time_invoice_preview', { p_organization_id: w.orgId, ...args }, token);
}

function factureer(w, args, token = w.eigenaar.token) {
  return rpc('create_invoice_from_time_entries', { p_organization_id: w.orgId, ...args }, token);
}

function gekoppeld(factuurId) {
  return sqlRij(`select count(*)::int as aantal, coalesce(sum(minutes), 0)::int as minuten
    from public.time_entry_invoices where invoice_id = ${q(factuurId)}`);
}

function factuurRij(id) {
  return sqlRij(`select id, number, status, client_id, project_id, date, due_date, lines, subtotal_amount, total_amount, journal_entry_id
    from public.invoices where id = ${q(id)}`);
}

function wf(w, action, extra = {}) {
  return roep('invoice-workflow', { token: w.eigenaar.token, body: { action, organizationId: w.orgId, ...extra } });
}

function verstuur(w, factuurId, klant) {
  return wf(w, 'sendInvoiceEmail', { invoiceId: factuurId, recipientEmail: klant.email, recipientName: klant.name, includePaymentLink: false });
}

export default async function urenfactureren() {
  groep('Uren factureren 1: het voorbeeld telt de hele periode');
  const w = await stap('wereld maken', () => maakWereld('uren'));
  const buren = await stap('de buren maken', () => maakWereld('urenburen'));
  if (!w || !buren) return;

  const opzet = await stap('twee projecten op urenbasis en een maand uren', async () => {
    const web = await project(w, w.klantA, 'Website', 8500);
    const advies = await project(w, w.klantA, 'Advies', 9500);
    const ander = await project(w, w.klantB, 'Huisstijl', 9000);
    // Oktober: 110 registraties van 66 minuten op Website (121 uur, € 10.285).
    const oktober = [];
    for (let i = 0; i < 110; i += 1) {
      oktober.push({ project_id: web.id, client_id: w.klantA.id, entry_date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, minutes: 66, hourly_rate_cents: 8500, description: `Bouwen ${i + 1}` });
    }
    const webUren = await uren(w, oktober);
    const adviesUren = await uren(w, [
      { project_id: advies.id, client_id: w.klantA.id, entry_date: '2026-10-05', minutes: 50, hourly_rate_cents: 9500, description: 'Strategiesessie' },
      { project_id: advies.id, client_id: w.klantA.id, entry_date: '2026-10-12', minutes: 100, hourly_rate_cents: 9500, description: 'Workshop' },
      { project_id: advies.id, client_id: w.klantA.id, entry_date: '2026-10-19', minutes: 20, hourly_rate_cents: 9500, description: 'Telefoon' },
    ]);
    const rest_ = await uren(w, [
      // Niet declarabel, zonder tarief, november, en een andere klant: geen van
      // alle hoort op de oktoberfactuur van Website.
      { project_id: web.id, client_id: w.klantA.id, entry_date: '2026-10-06', minutes: 120, hourly_rate_cents: 8500, billable: false, description: 'Intern overleg' },
      { project_id: web.id, client_id: w.klantA.id, entry_date: '2026-10-07', minutes: 90, hourly_rate_cents: null, description: 'Zonder tarief' },
      { project_id: web.id, client_id: w.klantA.id, entry_date: '2026-11-03', minutes: 60, hourly_rate_cents: 8500, description: 'November' },
      { project_id: ander.id, client_id: w.klantB.id, entry_date: '2026-10-08', minutes: 180, hourly_rate_cents: 9000, description: 'Logo' },
    ]);
    return { web, advies, ander, webUren, adviesUren, zonderTarief: rest_[1], november: rest_[2] };
  });
  if (!opzet) return;
  const { web, advies } = opzet;
  const OKT = { p_from: '2026-10-01', p_to: '2026-10-31' };

  await stap('oktober op Website: 110 registraties, 121 uur, € 10.285 in één regel', async () => {
    const v = gelukt(await voorbeeld(w, { p_project_id: web.id, ...OKT }), 'voorbeeld');
    gelijk({ aantal: v.entry_count, minuten: v.minutes, cent: v.subtotal_cents, regels: v.lines.length, zonderAantal: v.without_rate.entry_count, zonderMinuten: v.without_rate.minutes },
      { aantal: 110, minuten: 7260, cent: 1028500, regels: 1, zonderAantal: 1, zonderMinuten: 90 }, 'het voorbeeld');
    const [regel] = v.lines;
    gelijk({ aantal: regel.quantity, prijs: regel.unit_price, btw: regel.vat, code: regel.vat_code },
      { aantal: 121, prijs: 85, btw: 21, code: 'HOOG' }, 'de factuurregel');
    gelijk(regel.description, 'Uren Website (1-10-2026 t/m 28-10-2026)', 'de omschrijving');
    verwacht(!('entry_ids' in regel), 'het voorbeeld stuurt alle losse uren-id\'s mee');
    gelijk(v.client_id, w.klantA.id, 'de klant komt van het project');
  });

  await stap('de hele klant in oktober: twee regels, een per project en tarief', async () => {
    const v = gelukt(await voorbeeld(w, { p_client_id: w.klantA.id, ...OKT }), 'voorbeeld');
    gelijk(v.lines.map((l) => [l.description, l.quantity, l.unit_price]), [
      ['Uren Advies (5-10-2026 t/m 19-10-2026)', 2.83, 95],
      ['Uren Website (1-10-2026 t/m 28-10-2026)', 121, 85],
    ], 'de regels');
    gelijk(v.subtotal_cents, 1028500 + 26885, 'het totaal');
  });

  await stap('per registratie: elke regel met datum en omschrijving, en afronden op een kwartier naar boven', async () => {
    const v = gelukt(await voorbeeld(w, { p_project_id: advies.id, ...OKT, p_grouping: 'entry', p_rounding_minutes: 15 }), 'voorbeeld');
    gelijk(v.lines.map((l) => [l.description, l.quantity]), [
      ['5-10-2026 · Strategiesessie', 1], ['12-10-2026 · Workshop', 1.75], ['19-10-2026 · Telefoon', 0.5],
    ], 'de regels');
    gelijk({ minuten: v.minutes, gefactureerd: v.billed_minutes, cent: v.subtotal_cents }, { minuten: 170, gefactureerd: 195, cent: 30875 }, 'afgerond');
  });

  await stap('onzin wordt geweigerd: geen klant, een vreemde afronding, een omgekeerde periode', async () => {
    geweigerd(await voorbeeld(w, {}), 'zonder klant of project');
    geweigerd(await voorbeeld(w, { p_client_id: w.klantA.id, p_rounding_minutes: 7 }), 'afronden op 7 minuten');
    geweigerd(await voorbeeld(w, { p_client_id: w.klantA.id, p_from: '2026-11-01', p_to: '2026-10-01' }), 'omgekeerde periode');
    geweigerd(await voorbeeld(w, { p_client_id: w.klantA.id, p_grouping: 'week' }), 'onbekende indeling');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 2: wie wat mag');

  await stap('lezen: wel met Uren en Financiën, niet zonder Financiën, als boekhouder zonder Uren, van de buren of anoniem', async () => {
    gelukt(await voorbeeld(w, { p_project_id: web.id }, w.lezer.token), 'lezer (Financiën lezen)');
    geweigerd(await voorbeeld(w, { p_project_id: web.id }, w.zonderFinancien.token), 'zonder Financiën');
    geweigerd(await voorbeeld(w, { p_project_id: web.id }, buren.eigenaar.token), 'de eigenaar van de buren');
    geweigerd(await voorbeeld(w, { p_project_id: web.id }, null), 'anoniem');
    // De buren met hun eigen organisatie en ons project: het project bestaat daar niet.
    geweigerd(await rpc('time_invoice_preview', { p_organization_id: buren.orgId, p_project_id: web.id }, buren.eigenaar.token), 'ons project bij de buren', [400, 404, 406]);
  });

  await stap('factureren: niet met alleen leesrecht, niet zonder Financiën, niet als kijker, van de buren of anoniem', async () => {
    for (const [wie, gebruiker] of [['lezer', w.lezer], ['zonder Financiën', w.zonderFinancien], ['kijker', w.kijker], ['buren', buren.eigenaar]]) {
      geweigerd(await factureer(w, { p_project_id: web.id, ...OKT }, gebruiker.token), wie);
    }
    geweigerd(await factureer(w, { p_project_id: web.id, ...OKT }, null), 'anoniem');
    gelijk(sqlRij(`select count(*)::int as n from public.time_entry_invoices where organization_id = ${q(w.orgId)}`).n, 0, 'er is toch iets gekoppeld');
    gelijk(sqlRij(`select count(*)::int as n from public.invoices where organization_id = ${q(w.orgId)}`).n, 0, 'er is toch een factuur gemaakt');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 3: het concept, en nooit dubbel');

  const concept = await stap('de uren van oktober worden één conceptfactuur van € 10.285 excl. btw', async () => {
    const res = gelukt(await factureer(w, { p_project_id: web.id, ...OKT, p_expected_minutes: 7260 }), 'factureren');
    const rij = factuurRij(res.id);
    gelijk({ status: rij.status, klant: rij.client_id, project: rij.project_id, datum: rij.date, vervalt: rij.due_date, netto: Number(rij.subtotal_amount), totaal: Number(rij.total_amount) },
      { status: 'draft', klant: w.klantA.id, project: web.id, datum: vandaag(), vervalt: vandaag(14), netto: 10285, totaal: 12444.85 }, 'de factuur');
    verwacht(/^F?\S+/.test(rij.number) && rij.number.length > 3, `geen factuurnummer: ${rij.number}`);
    gelijk(rij.lines.length, 1, 'aantal regels');
    gelijk(Object.keys(rij.lines[0]).sort(), ['description', 'id', 'quantity', 'unit_price', 'vat', 'vat_code'], 'alleen factuurvelden op de regel');
    gelijk(gekoppeld(rij.id), { aantal: 110, minuten: 7260 }, 'de gekoppelde uren');
    gelijk(sqlRij(`select count(distinct line_id)::int as n from public.time_entry_invoices where invoice_id = ${q(rij.id)} and line_id = ${q(rij.lines[0].id)}`).n, 1, 'de uren wijzen naar de factuurregel');
    return rij;
  });

  await stap('nog een keer factureren geeft niets: de uren staan er al op', async () => {
    // Tot en met 6 oktober: daar zit geen uur zonder tarief tussen.
    const fout = geweigerd(await factureer(w, { p_project_id: web.id, p_from: '2026-10-01', p_to: '2026-10-06' }), 'tweede keer');
    verwacht(/geen declarabele uren/i.test(fout.message ?? ''), `onduidelijke melding: ${JSON.stringify(fout)}`);
    geweigerd(await factureer(w, { p_project_id: web.id, ...OKT }), 'tweede keer, de hele maand');
    const v = gelukt(await voorbeeld(w, { p_project_id: web.id, ...OKT }), 'voorbeeld');
    gelijk({ aantal: v.entry_count, regels: v.lines.length }, { aantal: 0, regels: 0 }, 'het voorbeeld na het factureren');
    gelijk(sqlRij(`select count(*)::int as n from public.invoices where organization_id = ${q(w.orgId)}`).n, 1, 'aantal facturen');
  });

  await stap('alleen uren zonder tarief over: een melding die zegt wat je moet doen', async () => {
    const fout = geweigerd(await factureer(w, { p_project_id: web.id, p_from: '2026-10-07', p_to: '2026-10-07' }), 'zonder tarief');
    verwacht(/geen uurtarief/i.test(fout.message ?? ''), `onduidelijke melding: ${JSON.stringify(fout)}`);
  });

  await stap('zijn de uren veranderd sinds het voorbeeld, dan weigert de database', async () => {
    const fout = geweigerd(await factureer(w, { p_project_id: advies.id, ...OKT, p_expected_minutes: 999 }), 'andere minuten');
    verwacht(/veranderd/i.test(fout.message ?? ''), `onduidelijke melding: ${JSON.stringify(fout)}`);
    gelijk(sqlRij(`select count(*)::int as n from public.invoices where organization_id = ${q(w.orgId)}`).n, 1, 'er is toch een factuur gemaakt');
  });

  await stap('niemand schrijft rechtstreeks in de koppeling: niet losmaken, niet verhangen, niet toevoegen', async () => {
    const id = opzet.webUren[0].id;
    nietsVeranderd(await rest(`time_entry_invoices?time_entry_id=eq.${id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'losmaken');
    nietsVeranderd(await rest(`time_entry_invoices?time_entry_id=eq.${id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { minutes: 1 } }), 'wijzigen');
    nietsVeranderd(await rest('time_entry_invoices', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { time_entry_id: opzet.november.id, organization_id: w.orgId, invoice_id: nodig(concept, 'het concept').id, minutes: 60, hourly_rate_cents: 8500 },
    }), 'toevoegen');
    gelijk(gekoppeld(concept.id), { aantal: 110, minuten: 7260 }, 'de koppeling');
  });

  await stap('wie de uren niet mag lezen, ziet de koppeling niet; de buren ook niet', async () => {
    const eigen = gelukt(await rest(`time_entry_invoices?select=time_entry_id&invoice_id=eq.${nodig(concept, 'het concept').id}&limit=5`, { token: w.eigenaar.token }), 'eigenaar');
    gelijk(eigen.length, 5, 'de eigenaar');
    const buur = await rest(`time_entry_invoices?select=time_entry_id&invoice_id=eq.${concept.id}`, { token: buren.eigenaar.token });
    gelijk(buur.json?.length ?? 0, 0, 'de buren');
    const boekhouder = await rest(`time_entry_invoices?select=time_entry_id&invoice_id=eq.${concept.id}`, { token: w.boekhouder.token });
    const urenBoekhouder = await rest(`time_entries?select=id&organization_id=eq.${w.orgId}&limit=1`, { token: w.boekhouder.token });
    // De boekhouder ziet de koppeling alleen als hij ook de uren ziet.
    gelijk((boekhouder.json?.length ?? 0) > 0, (urenBoekhouder.json?.length ?? 0) > 0, 'de boekhouder ziet de koppeling zonder de uren');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 4: gefactureerde uren liggen vast');

  await stap('minuten, tarief, datum, declarabel en omschrijving wijzigen wordt geweigerd, met het factuurnummer erbij', async () => {
    const id = opzet.webUren[0].id;
    for (const [wat, patch] of [['minuten', { minutes: 30 }], ['tarief', { hourly_rate_cents: 100 }], ['datum', { entry_date: '2026-12-01' }], ['declarabel', { billable: false }], ['omschrijving', { description: 'Anders' }], ['project', { project_id: advies.id }]]) {
      const res = await rest(`time_entries?id=eq.${id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: patch });
      const fout = geweigerd(res, `${wat} wijzigen`);
      verwacht((fout.message ?? '').includes(nodig(concept, 'het concept').number), `de melding noemt de factuur niet: ${JSON.stringify(fout)}`);
    }
    gelijk(sqlRij(`select minutes, hourly_rate_cents, billable from public.time_entries where id = ${q(id)}`), { minutes: 66, hourly_rate_cents: 8500, billable: true }, 'het uur');
  });

  await stap('verwijderen wordt geweigerd; het soort uur (direct/indirect) mag nog wel', async () => {
    const id = opzet.webUren[1].id;
    geweigerd(await rest(`time_entries?id=eq.${id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'verwijderen');
    gelijk(sqlRij(`select count(*)::int as n from public.time_entries where id = ${q(id)}`).n, 1, 'het uur is weg');
    gelukt(await rest(`time_entries?id=eq.${id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { entry_type: 'indirect', indirect_category: 'other' } }), 'soort wijzigen');
    gelukt(await rest(`time_entries?id=eq.${id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { entry_type: 'direct', indirect_category: null } }), 'soort terugzetten');
  });

  await stap('uren die niet gefactureerd zijn, blijven gewoon te wijzigen en te verwijderen', async () => {
    gelukt(await rest(`time_entries?id=eq.${opzet.november.id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { minutes: 75 } }), 'wijzigen');
    const [los] = await uren(w, [{ project_id: web.id, client_id: w.klantA.id, entry_date: '2026-11-04', minutes: 15, hourly_rate_cents: 8500 }]);
    const weg = gelukt(await rest(`time_entries?id=eq.${los.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'verwijderen');
    gelijk(weg.length, 1, 'verwijderd');
  });

  await stap('een verwijderd project maakt de gefactureerde uren los van het project, niet van de factuur', async () => {
    const tijdelijk = await project(w, w.klantA, 'Tijdelijk', 8000);
    const [uur] = await uren(w, [{ project_id: tijdelijk.id, client_id: w.klantA.id, entry_date: '2026-09-01', minutes: 60, hourly_rate_cents: 8000 }]);
    const f = gelukt(await factureer(w, { p_project_id: tijdelijk.id }), 'factureren');
    gelukt(await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { project_id: null } }), 'factuur losmaken van het project');
    gelukt(await rest(`projects?id=eq.${tijdelijk.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'project verwijderen');
    gelijk(sqlRij(`select project_id, client_id from public.time_entries where id = ${q(uur.id)}`), { project_id: null, client_id: w.klantA.id }, 'het uur');
    gelijk(gekoppeld(f.id), { aantal: 1, minuten: 60 }, 'de koppeling');
    // Opruimen: het concept weg, het uur weer vrij en dan weg.
    gelukt(await rest(`invoices?id=eq.${f.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'concept verwijderen');
    gelukt(await rest(`time_entries?id=eq.${uur.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'uur verwijderen');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 5: uren komen vrij als het concept verandert of verdwijnt');

  const specificatie = await stap('Advies per registratie: drie regels, drie uren vast', async () => {
    const res = gelukt(await factureer(w, { p_project_id: advies.id, ...OKT, p_grouping: 'entry' }), 'factureren');
    const rij = factuurRij(res.id);
    gelijk(rij.lines.map((l) => [l.description, l.quantity]), [['5-10-2026 · Strategiesessie', 0.83], ['12-10-2026 · Workshop', 1.67], ['19-10-2026 · Telefoon', 0.33]], 'de regels');
    gelijk(gekoppeld(rij.id), { aantal: 3, minuten: 170 }, 'de koppeling');
    return rij;
  });

  await stap('een regel uit het concept halen (zoals het factuurvenster opslaat) geeft precies dat uur vrij', async () => {
    const rij = nodig(specificatie, 'het concept');
    // Het venster stuurt de hele lijst regels terug; de middelste is weggehaald
    // en de prijs van de eerste is met de hand aangepast.
    const regels = [{ ...rij.lines[0], unit_price: 90 }, rij.lines[2]];
    gelukt(await rest(`invoices?id=eq.${rij.id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { lines: regels } }), 'concept opslaan');
    gelijk(gekoppeld(rij.id), { aantal: 2, minuten: 70 }, 'de koppeling');
    const v = gelukt(await voorbeeld(w, { p_project_id: advies.id, ...OKT }), 'voorbeeld');
    gelijk({ aantal: v.entry_count, minuten: v.minutes }, { aantal: 1, minuten: 100 }, 'de workshop is weer te factureren');
    gelukt(await rest(`time_entries?id=eq.${opzet.adviesUren[1].id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { minutes: 110 } }), 'het vrije uur wijzigen');
  });

  await stap('het concept verwijderen geeft alle uren vrij', async () => {
    const rij = nodig(specificatie, 'het concept');
    gelukt(await rest(`invoices?id=eq.${rij.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'concept verwijderen');
    gelijk(sqlRij(`select count(*)::int as n from public.time_entry_invoices where invoice_id = ${q(rij.id)}`).n, 0, 'de koppeling');
    const v = gelukt(await voorbeeld(w, { p_project_id: advies.id, ...OKT }), 'voorbeeld');
    gelijk({ aantal: v.entry_count, minuten: v.minutes }, { aantal: 3, minuten: 180 }, 'alles is weer te factureren');
  });

  await stap('een concept annuleren (status geannuleerd) geeft de uren ook vrij', async () => {
    const res = gelukt(await factureer(w, { p_project_id: advies.id, ...OKT }), 'factureren');
    gelijk(gekoppeld(res.id), { aantal: 3, minuten: 180 }, 'gekoppeld');
    gelukt(await rest(`invoices?id=eq.${res.id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'cancelled' } }), 'annuleren');
    gelijk(gekoppeld(res.id), { aantal: 0, minuten: 0 }, 'na het annuleren');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 6: versturen, crediteren en het grootboek');

  await stap('het concept van oktober versturen: geboekt, en de uren blijven vast', async () => {
    const rij = nodig(concept, 'het concept');
    gelukt(await verstuur(w, rij.id, w.klantA), 'versturen');
    const na = factuurRij(rij.id);
    gelijk(na.status, 'sent', 'status');
    verwacht(na.journal_entry_id, 'de factuur staat niet in het grootboek');
    gelijk(gekoppeld(rij.id), { aantal: 110, minuten: 7260 }, 'de koppeling');
    geweigerd(await rest(`time_entries?id=eq.${opzet.webUren[0].id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { minutes: 30 } }), 'uur wijzigen na versturen');
    // De regels van een verstuurde factuur liggen vast; een poging ze te
    // wijzigen mag de uren niet vrijgeven.
    await rest(`invoices?id=eq.${rij.id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { lines: [] } });
    gelijk(gekoppeld(rij.id), { aantal: 110, minuten: 7260 }, 'de koppeling na een poging de regels te wissen');
  });

  await stap('een deelcreditnota is een prijscorrectie: de uren blijven gefactureerd', async () => {
    const rij = nodig(concept, 'het concept');
    const res = gelukt(await wf(w, 'creditInvoice', { invoiceId: rij.id, amountCents: 100000, reason: 'Coulance' }), 'deels crediteren');
    verwacht(res.remainingCents > 0, `er staat niets meer open: ${JSON.stringify(res)}`);
    gelijk(gekoppeld(rij.id), { aantal: 110, minuten: 7260 }, 'de koppeling');
    const v = gelukt(await voorbeeld(w, { p_project_id: web.id, ...OKT }), 'voorbeeld');
    gelijk(v.entry_count, 0, 'de uren zijn weer te factureren');
  });

  await stap('de rest crediteren: de factuur vervalt en de uren komen weer vrij', async () => {
    const rij = nodig(concept, 'het concept');
    gelukt(await wf(w, 'creditInvoice', { invoiceId: rij.id, reason: 'Verkeerde klant' }), 'volledig crediteren');
    const na = factuurRij(rij.id);
    gelijk(na.status, 'cancelled', 'status van de factuur');
    gelijk(gekoppeld(rij.id), { aantal: 0, minuten: 0 }, 'de koppeling');
    const v = gelukt(await voorbeeld(w, { p_project_id: web.id, ...OKT }), 'voorbeeld');
    gelijk({ aantal: v.entry_count, cent: v.subtotal_cents }, { aantal: 110, cent: 1028500 }, 'weer te factureren');
    // En ze zijn weer te wijzigen.
    gelukt(await rest(`time_entries?id=eq.${opzet.webUren[0].id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { description: 'Bouwen 1 (gecorrigeerd)' } }), 'uur wijzigen');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 7: Gerrie en MCP zetten klaar, een mens keurt goed');

  const sleutels = await stap('een leessleutel en een sleutel die alleen mag klaarzetten', async () => ({
    lezen: await maakSleutel(w.beheerder, w.orgId, 'read'),
    klaarzetten: await maakSleutel(w.beheerder, w.orgId, 'propose'),
    buren: await maakSleutel(buren.beheerder, buren.orgId, 'read'),
  }));

  await stap('time.uninvoiced: het hele bedrag van oktober, niet de eerste 25 registraties', async () => {
    const res = await api('/v1/actions/time.uninvoiced', { sleutel: nodig(sleutels, 'de sleutels').lezen, body: { project_id: web.id, from: '2026-10-01', to: '2026-10-31' } });
    const uit = gelukt(res, 'time.uninvoiced');
    const data = uit.result ?? uit.data ?? uit;
    gelijk({ aantal: data.entry_count, uren: data.hours, bedrag: data.amount_excl_vat_eur, zonder: data.without_rate },
      { aantal: 110, uren: 121, bedrag: 10285, zonder: { entries: 1, hours: 1.5 } }, 'wat Gerrie ziet');
  });

  await stap('de buren zien onze uren niet via hun sleutel', async () => {
    const res = await api('/v1/actions/time.uninvoiced', { sleutel: nodig(sleutels, 'de sleutels').buren, body: { project_id: web.id } });
    verwacht(res.status >= 400 && res.status < 500, `verwacht een weigering, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
    verwacht(!res.tekst.includes('10285'), 'het bedrag lekt naar de buren');
  });

  const voorstel = await stap('invoice.from_time_entries zet klaar (202): een kaart met uren en bedrag, en er gebeurt nog niets', async () => {
    const voor = sqlRij(`select count(*)::int as n from public.invoices where organization_id = ${q(w.orgId)}`).n;
    geweigerd(await api('/v1/actions/invoice.from_time_entries', { sleutel: nodig(sleutels, 'de sleutels').lezen, body: { project_id: web.id } }), 'met een leessleutel', [403]);
    const res = await api('/v1/actions/invoice.from_time_entries', { sleutel: sleutels.klaarzetten, body: { project_id: web.id, from: '2026-10-01', to: '2026-10-31' } });
    gelijk(res.status, 202, `klaarzetten (${res.tekst.slice(0, 300)})`);
    const kaart = res.json.proposal;
    const rij = sqlRij(`select * from public.ai_action_audit where id = ${q(kaart.id)}`) ?? {};
    const tekst = JSON.stringify(rij);
    verwacht(/121 uur/.test(tekst) && /10\.285/.test(tekst), `de kaart noemt de uren en het bedrag niet: ${tekst.slice(0, 600)}`);
    verwacht(/1,5 uur zonder uurtarief/.test(tekst), `de kaart waarschuwt niet voor uren zonder tarief: ${tekst.slice(0, 600)}`);
    gelijk(sqlRij(`select count(*)::int as n from public.invoices where organization_id = ${q(w.orgId)}`).n, voor, 'er is al een factuur gemaakt');
    gelijk(sqlRij(`select count(*)::int as n from public.time_entry_invoices where organization_id = ${q(w.orgId)}`).n, 0, 'er zijn al uren gekoppeld');
    return rij;
  });

  await stap('na akkoord loopt het langs dezelfde functie als de knop, met de sessie van de mens', async () => {
    const payload = nodig(voorstel, 'het voorstel').params?.payload ?? {};
    gelijk({ klant: payload.client_id, project: payload.project_id, van: payload.from, tot: payload.to, minuten: payload.expected_minutes, centen: payload.expected_subtotal_cents },
      { klant: w.klantA.id, project: web.id, van: '2026-10-01', tot: '2026-10-31', minuten: 7260, centen: 1028500 }, 'wat de uitvoerder in de browser krijgt');
    // Intussen komt er een uur bij: de mens keurde 121 uur goed, niet 122.
    const [extra] = await uren(w, [{ project_id: web.id, client_id: w.klantA.id, entry_date: '2026-10-30', minutes: 60, hourly_rate_cents: 8500 }]);
    const args = { p_client_id: payload.client_id, p_project_id: payload.project_id, p_from: payload.from, p_to: payload.to, p_grouping: payload.grouping, p_rounding_minutes: payload.rounding_minutes, p_expected_minutes: payload.expected_minutes, p_expected_subtotal_cents: payload.expected_subtotal_cents };
    const fout = geweigerd(await factureer(w, args), 'uitvoeren na een wijziging');
    verwacht(/veranderd/i.test(fout.message ?? ''), `onduidelijke melding: ${JSON.stringify(fout)}`);
    gelukt(await rest(`time_entries?id=eq.${extra.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'het extra uur weghalen');
    // Evenveel minuten, maar één uur kreeg een ander tarief: de kaart zei
    // € 10.285, dus dan ook niet.
    const ander = opzet.webUren[0].id;
    gelukt(await rest(`time_entries?id=eq.${ander}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { hourly_rate_cents: 9500 } }), 'een ander tarief');
    const foutBedrag = geweigerd(await factureer(w, args), 'uitvoeren na een ander tarief');
    verwacht(/bedrag is veranderd/i.test(foutBedrag.message ?? '') && /€ 10\.285,00/.test(foutBedrag.message ?? ''), `onduidelijke melding: ${JSON.stringify(foutBedrag)}`);
    gelukt(await rest(`time_entries?id=eq.${ander}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { hourly_rate_cents: 8500 } }), 'het tarief terug');
    // Een lezer die goedkeurt, komt er niet door: de rechten van de mens gelden.
    geweigerd(await factureer(w, args, w.lezer.token), 'goedkeuren met alleen leesrecht');
    const res = gelukt(await factureer(w, args), 'uitvoeren');
    gelijk(gekoppeld(res.id), { aantal: 110, minuten: 7260 }, 'de koppeling');
    gelijk(Number(factuurRij(res.id).subtotal_amount), 10285, 'het bedrag');
  });

  // ─────────────────────────────────────────────────────────────────
  groep('Uren factureren 8: KOR en de agenda');

  await stap('met de KOR: 0% btw met code KOR op de urenregel', async () => {
    const kor = await maakWereld('urenkor', { kor: true });
    const p = await project(kor, kor.klantA, 'Tuinontwerp', 6000);
    await uren(kor, [{ project_id: p.id, client_id: kor.klantA.id, entry_date: '2026-10-02', minutes: 90, hourly_rate_cents: 6000 }]);
    const res = gelukt(await factureer(kor, { p_project_id: p.id }), 'factureren');
    const rij = factuurRij(res.id);
    gelijk({ btw: rij.lines[0].vat, code: rij.lines[0].vat_code, netto: Number(rij.subtotal_amount), totaal: Number(rij.total_amount) }, { btw: 0, code: 'KOR', netto: 90, totaal: 90 }, 'de regel');
  });

  await stap('een agenda-afspraak die verschuift, laat gefactureerde uren met rust; een nieuwe afspraak volgt gewoon', async () => {
    const bron = { id: sql(`insert into public.calendar_sources (organization_id, user_id, provider, provider_calendar_id, name)
      values (${q(w.orgId)}, ${q(w.eigenaar.id)}, 'native', ${q(randomUUID())}, 'Stromen uren') returning id`).split('\n')[0] };
    const start = '2026-10-20T09:00:00+02:00';
    const link = { id: sql(`insert into public.calendar_event_links (organization_id, created_by, provider, calendar_source_id, provider_event_id,
        event_starts_at, event_ends_at, event_title_snapshot, client_id, project_id, track_time)
      values (${q(w.orgId)}, ${q(w.eigenaar.id)}, 'native', ${q(bron.id)}, ${q(randomUUID())},
        ${q(start)}, ${q('2026-10-20T11:00:00+02:00')}, 'Kick-off', ${q(w.klantA.id)}, ${q(advies.id)}, true) returning id`).split('\n')[0] };
    const uur = sqlRij(`select id, minutes from public.time_entries where calendar_event_link_id = ${q(link.id)}`);
    gelijk(uur?.minutes, 120, 'het uur uit de afspraak');
    const res = gelukt(await factureer(w, { p_project_id: advies.id, p_from: '2026-10-20', p_to: '2026-10-20' }), 'factureren');
    gelijk(gekoppeld(res.id), { aantal: 1, minuten: 120 }, 'de koppeling');
    // De afspraak duurt nu drie uur: het gefactureerde uur blijft twee uur.
    sql(`update public.calendar_event_links set event_ends_at = ${q('2026-10-20T12:00:00+02:00')} where id = ${q(link.id)}`);
    gelijk(sqlRij(`select minutes from public.time_entries where id = ${q(uur.id)}`).minutes, 120, 'het gefactureerde uur');
    // De afspraak verdwijnt: het uur blijft staan, als handmatig uur.
    sql(`delete from public.calendar_event_links where id = ${q(link.id)}`);
    gelijk(sqlRij(`select minutes, source, calendar_event_link_id from public.time_entries where id = ${q(uur.id)}`), { minutes: 120, source: 'manual', calendar_event_link_id: null }, 'het uur na het verwijderen van de afspraak');
    gelijk(gekoppeld(res.id), { aantal: 1, minuten: 120 }, 'de koppeling daarna');
  });

  await stap('de database kent geen uur dat op twee facturen staat', async () => {
    const dubbel = sqlRijen(`select time_entry_id from public.time_entry_invoices group by time_entry_id having count(*) > 1`);
    gelijk(dubbel.length, 0, 'dubbel gefactureerde uren');
  });
}
