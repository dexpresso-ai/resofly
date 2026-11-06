// De publieke API met echte sleutels, zoals een koppeling of een MCP-client
// hem gebruikt. Hier zaten de wijzigingen van de controle van 5 november:
// "betaald" mag niet meer de debiteurenstand scheef zetten, een ander
// e-factuuradres gaat altijd langs een mens, en de kaarten tonen het adres
// waar het echt heen gaat.
import { API_URL } from './omgeving.mjs';
import { roep, roepRequest } from './functies.mjs';
import { rest, sql, sqlRij, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';

async function api(sleutel, method, pad, body) {
  const res = await roepRequest('api', new Request(`${API_URL}/functions/v1/api${pad}`, {
    method,
    headers: { authorization: `Bearer ${sleutel}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

export default async function automatisering() {
  groep('Automatisering (API-sleutels)');
  const w = await stap('wereld maken', () => maakWereld('auto'));
  if (!w) return;

  const maakSleutel = async (access, moduleAccess) => {
    const res = await roep('api-admin', {
      token: w.eigenaar.token,
      body: { action: 'createKey', organizationId: w.orgId, name: uniek('Koppeling'), access, moduleAccess },
    });
    return gelukt(res, `sleutel ${access}`).secret;
  };
  const sleutels = await stap('sleutels aanmaken (execute_high, propose, zonder Financiën)', async () => ({
    hoog: await maakSleutel('execute_high'),
    voorstel: await maakSleutel('propose'),
    zonderFinancien: await maakSleutel('execute_high', { finance: 'none' }),
  }));
  if (!sleutels) return;

  const concept = async (nummer, datum = '2026-11-06') => {
    const res = await rest('invoices?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, number: nummer, date: datum, due_date: '2026-11-20', lines: REGELS, status: 'draft' },
    });
    return gelukt(res, `concept ${nummer}`)[0];
  };
  const verstuur = async (factuur) => gelukt(await roep('invoice-workflow', {
    token: w.medewerker.token, body: { action: 'sendInvoiceEmail', organizationId: w.orgId, invoiceId: factuur.id },
  }), `versturen ${factuur.number}`);

  await stap('"betaald" op een ongeboekt concept wordt geweigerd (zou omzet boeken zonder betaling)', async () => {
    const f = await concept(uniek('FAC-AUTO'));
    const res = await api(sleutels.hoog, 'POST', '/v1/actions/invoice.set_status', { invoice_id: f.id, status: 'paid' });
    geweigerd(res, 'set_status paid');
    verwacht(/betaling|Debiteuren/i.test(res.tekst), `melding noemt de betaling niet: ${res.tekst.slice(0, 300)}`);
    const na = sqlRij(`select status, journal_entry_id from public.invoices where id = '${f.id}'`);
    gelijk(na, { status: 'draft', journal_entry_id: null }, 'factuur ongewijzigd');
  });

  const geboekt = await stap('"betaald" op een geboekte factuur met geld open wordt geweigerd', async () => {
    const f = await concept(uniek('FAC-AUTO'));
    await verstuur(f);
    const voor = sqlRij(`select status, journal_entry_id is not null as geboekt from public.invoices where id = '${f.id}'`);
    gelijk(voor, { status: 'sent', geboekt: true }, 'verzonden en geboekt');
    const res = await api(sleutels.hoog, 'POST', '/v1/actions/invoice.set_status', { invoice_id: f.id, status: 'paid' });
    geweigerd(res, 'set_status paid op geboekte factuur');
    gelijk(sqlRij(`select status from public.invoices where id = '${f.id}'`).status, 'sent', 'status ongewijzigd');
    return f;
  });

  await stap('"betaald" voor een factuur uit de beginbalans mag wel, en boekt niets', async () => {
    const f = await concept(uniek('FAC-AUTO'), '2026-10-01');
    sql(`update public.company_settings set bookkeeping_start_date = '2026-11-01' where organization_id = '${w.orgId}'`);
    try {
      await verstuur(f);
      const res = await api(sleutels.hoog, 'POST', '/v1/actions/invoice.set_status', { invoice_id: f.id, status: 'paid' });
      gelukt(res, 'set_status paid uit de beginbalans');
      gelijk(sqlRij(`select status, journal_entry_id from public.invoices where id = '${f.id}'`), { status: 'paid', journal_entry_id: null }, 'betaald, niet geboekt');
    } finally {
      sql(`update public.company_settings set bookkeeping_start_date = null where organization_id = '${w.orgId}'`);
    }
  });

  await stap('een ander e-factuuradres via een handeling gaat altijd langs een mens (ook met execute_high)', async () => {
    const res = await api(sleutels.hoog, 'POST', '/v1/actions/client.update_details', { client_id: w.klantA.id, e_invoice_email: 'elders@aanvaller.test' });
    gelijk(res.status, 202, `in de wachtrij in plaats van uitgevoerd (${res.tekst.slice(0, 200)})`);
    verwacht(res.tekst.includes('elders@aanvaller.test'), 'het nieuwe adres staat niet op de kaart');
    gelijk(sqlRij(`select e_invoice_email from public.clients where id = '${w.klantA.id}'`).e_invoice_email, null, 'klant ongewijzigd');
  });

  await stap('een gewone klantwijziging via een handeling wordt meteen uitgevoerd', async () => {
    const res = await api(sleutels.hoog, 'POST', '/v1/actions/client.update_details', { client_id: w.klantA.id, city: 'Zwolle' });
    gelukt(res, 'plaats wijzigen');
    gelijk(sqlRij(`select city from public.clients where id = '${w.klantA.id}'`).city, 'Zwolle', 'plaats bijgewerkt');
  });

  await stap('REST: e-factuuradres zetten vraagt schrijfrecht in Financiën; de plaats niet', async () => {
    const weg = await api(sleutels.zonderFinancien, 'PATCH', `/v1/clients/${w.klantA.id}`, { e_invoice_email: 'elders@aanvaller.test' });
    geweigerd(weg, 'e-factuuradres zonder Financiën', [403]);
    verwacht(weg.tekst.includes('e_invoice_email'), 'de melding noemt het veld niet');
    const plaats = await api(sleutels.zonderFinancien, 'PATCH', `/v1/clients/${w.klantA.id}`, { city: 'Deventer' });
    gelukt(plaats, 'plaats zonder Financiën');
    const lezen = await api(sleutels.zonderFinancien, 'GET', `/v1/clients/${w.klantA.id}`);
    gelukt(lezen, 'klant lezen');
    verwacht('e_invoice_email' in (lezen.json?.data ?? lezen.json ?? {}), 'het e-factuurveld hoort leesbaar te blijven');
  });

  await stap('creditnota mailen: de kaart toont het e-factuuradres, net als de server kiest', async () => {
    verwacht(geboekt, 'geen geboekte factuur uit de vorige stap');
    gelukt(await roep('invoice-workflow', {
      token: w.medewerker.token, body: { action: 'creditInvoice', organizationId: w.orgId, invoiceId: geboekt.id, reason: 'Dubbel gefactureerd' },
    }), 'crediteren');
    const creditnota = sqlRij(`select id from public.credit_notes where invoice_id = '${geboekt.id}' order by created_at desc limit 1`);
    verwacht(creditnota, 'geen creditnota aangemaakt');
    sql(`update public.clients set e_invoicing_enabled = true, e_invoice_email = 'inkoop@klant-a.test' where id = '${w.klantA.id}'`);
    const res = await api(sleutels.voorstel, 'POST', '/v1/actions/credit_note.send', { credit_note_id: creditnota.id });
    gelijk(res.status, 202, `voorstel klaargezet (${res.tekst.slice(0, 200)})`);
    verwacht(res.tekst.includes('inkoop@klant-a.test'), `de kaart noemt het e-factuuradres niet: ${res.tekst.slice(0, 300)}`);
  });

  await stap('contract ter ondertekening naar een ander adres: adres in de titel en een waarschuwing', async () => {
    const res = await rest('contracts?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantB.id, title: 'Onderhoudscontract', body: '<p>Artikel 1</p><div>De prijs is € 100 per maand.</div>' },
    });
    const contract = gelukt(res, 'contract opslaan')[0];
    const voorstel = await api(sleutels.voorstel, 'POST', '/v1/actions/contract.send_for_signature', { contract_id: contract.id, recipient_email: 'ops@elders.test' });
    gelijk(voorstel.status, 202, `voorstel klaargezet (${voorstel.tekst.slice(0, 200)})`);
    verwacht(voorstel.tekst.includes('ops@elders.test'), 'het afwijkende adres staat niet op de kaart');
    verwacht(/niet het adres van/i.test(voorstel.tekst), `geen waarschuwing over het afwijkende adres: ${voorstel.tekst.slice(0, 400)}`);
  });
}
