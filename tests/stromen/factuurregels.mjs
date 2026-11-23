// Factuurregels: wat er op een factuur staat, en langs welke weg hij uitgaat.
//
// Waarom dit scenario: de controle "van werk naar geld" van 22 november 2026
// vond vier gaten tussen offerte en factuur. Dit scenario speelt ze na zoals
// een zzp'er ze tegenkomt:
//
//  1. Een concept op "Verzonden" zetten (statusveld, Gerrie, de API) sloeg de
//     controles van het versturen over: een ICP-factuur aan een Belgische klant
//     zonder btw-nummer werd geboekt, kwam in de ICP-opgaaf met een leeg
//     nummer, en er was geen pdf vastgelegd. Nu weigert de database dat, en
//     is er "Uitgeven zonder mail" met dezelfde controles en een bewaarde pdf.
//  2. 0% zonder btw-code, of met NUL aan een klant in een ander EU-land: geen
//     vermelding, geen controle op het btw-nummer, rubriek 1e in plaats van
//     3b. Nu weigert versturen (en uitgeven zonder mail) het met de reden.
//  3. Een factuur uit een offerte kreeg altijd 14 dagen, ook bij "Betaling
//     binnen 30 dagen.".
//
// De korting over meer tarieven (bevinding 15) is een knop in het formulier;
// die staat in src/lib/invoiceDiscount.test.ts.
//
// Alles gaat zoals in de app: als de eigenaar, via REST en RPC met zijn eigen
// sessie (RLS geldt), en facturen via invoice-workflow.
import { createHash, randomUUID } from 'node:crypto';
import { API_URL } from './omgeving.mjs';
import { roep, roepRequest } from './functies.mjs';
import { mailsAan } from './nepdiensten.mjs';
import { rest, rpc, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { conceptFactuur, maakEenmanszaak, nodig, q, vandaag, wf } from './eenmanszaak.mjs';

async function klantIn(w, naam, land, btwNummer) {
  return gelukt(await rest('clients?select=id,name,email,country,vat_number', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, name: naam, email: `${randomUUID().slice(0, 8)}@klant.test`, contact_name: naam,
      address_line1: 'Veldstraat 1', postal_code: '9000', city: 'Gent', country: land, client_kind: 'business',
      vat_number: btwNummer,
    },
  }), `klant ${naam}`)[0];
}

function factuur(id) {
  return sqlRij(`select id, number, status, date, due_date, journal_entry_id, sent_version_id from public.invoices where id = ${q(id)}`);
}

function verstuur(w, concept, klant) {
  return wf(w, 'sendInvoiceEmail', { invoiceId: concept.id, recipientEmail: klant.email, recipientName: klant.name, includePaymentLink: false });
}

/** De openbare API met een sleutel die alleen mag klaarzetten (zoals Gerrie en MCP). */
async function api(pad, sleutel, body) {
  const res = await roepRequest('api', new Request(`${API_URL}/functions/v1/api${pad}`, {
    method: 'POST', headers: { authorization: `Bearer ${sleutel}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

const ICP_500 = [{ description: 'Fotoreportage beurs Gent', quantity: 1, unit_price: 500, vat: 0, vat_code: 'ICP_DIENST' }];

export default async function factuurregels() {
  groep('Factuurregels: uitgeven via de server, 0% met een reden, betaaltermijn uit de offerte');
  const w = await stap('een eenmanszaak (start 1-1-2025) met "Betaling binnen 30 dagen."', async () => {
    const zaak = await maakEenmanszaak('regels');
    gelukt(await rest(`company_settings?organization_id=eq.${zaak.orgId}`, {
      method: 'PATCH', token: zaak.eigenaar.token, prefer: 'return=representation', body: { invoice_payment_terms: 'Betaling binnen 30 dagen.' },
    }), 'betaaltermijn');
    return zaak;
  });
  if (!w) return;
  const gent = await stap('een klant in België zonder btw-nummer, en een in Nederland', async () => ({
    be: await klantIn(w, 'Studio Gent', 'België', null),
    nl: await klantIn(w, 'Bakkerij Aalbers', 'Nederland', 'NL009876543B01'),
  }));
  if (!gent) return;

  // ── 1. Uitgeven alleen via de server ──────────────────────────────────────
  const icp = await stap('een ICP-concept aan Studio Gent zonder btw-nummer: versturen weigert (zoals het was)', async () => {
    const c = await conceptFactuur(w, gent.be, vandaag(), ICP_500);
    const fout = geweigerd(await verstuur(w, c, gent.be), 'versturen');
    verwacht(/btw-nummer/.test(fout?.error ?? ''), `melding: ${fout?.error}`);
    return c;
  });

  await stap('het statusveld op "Verzonden": de database weigert, het concept blijft ongeboekt', async () => {
    const c = nodig(icp, 'het ICP-concept');
    const res = await rest(`invoices?id=eq.${c.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'sent' } });
    verwacht(res.status >= 400 && /Uitgeven zonder mail/.test(res.tekst), `rechtstreeks op verzonden: ${res.status} ${res.tekst.slice(0, 200)}`);
    for (const status of ['overdue', 'paid']) {
      const ander = await rest(`invoices?id=eq.${c.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status } });
      verwacht(ander.status >= 400, `rechtstreeks op ${status}: ${ander.status}`);
    }
    gelijk({ status: factuur(c.id).status, geboekt: Boolean(factuur(c.id).journal_entry_id) }, { status: 'draft', geboekt: false }, 'de factuur');
    // Ook een nieuwe factuur meteen als verzonden opslaan kan niet.
    const nieuw = await rest('invoices?select=id', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.eigenaar.id, client_id: gent.be.id, number: `F-DIRECT-${randomUUID().slice(0, 6)}`, date: vandaag(), status: 'sent', lines: ICP_500 },
    });
    verwacht(nieuw.status >= 400, `nieuw als verzonden: ${nieuw.status} ${nieuw.tekst.slice(0, 160)}`);
  });

  await stap('Gerrie en de API: "op verzonden zetten" voor een concept wordt niet eens klaargezet', async () => {
    const c = nodig(icp, 'het ICP-concept');
    const sleutel = gelukt(await roep('api-admin', {
      token: w.eigenaar.token, body: { action: 'createKey', organizationId: w.orgId, name: 'Klaarzetten', access: 'propose' },
    }), 'voorstelsleutel');
    const geheim = nodig(sleutel.secret, 'het geheim van de sleutel');
    const res = await api('/v1/actions/invoice.set_status', geheim, { invoice_id: c.id, status: 'sent' });
    verwacht(res.status >= 400 && res.status < 500, `klaarzetten: ${res.status} ${res.tekst.slice(0, 200)}`);
    verwacht(/Uitgeven zonder mail/.test(res.tekst), `melding: ${res.tekst.slice(0, 300)}`);
  });

  await stap('uitgeven zonder mail weigert hetzelfde als versturen: eerst het btw-nummer', async () => {
    const c = nodig(icp, 'het ICP-concept');
    const fout = geweigerd(await wf(w, 'issueInvoiceWithoutEmail', { invoiceId: c.id }), 'uitgeven zonder mail');
    verwacht(/btw-nummer/.test(fout?.error ?? ''), `melding: ${fout?.error}`);
    gelijk(factuur(c.id).status, 'draft', 'de factuur');
  });

  await stap('met het btw-nummer: uitgegeven, geboekt, de pdf bewaard, en geen mail aan de klant', async () => {
    const c = nodig(icp, 'het ICP-concept');
    gelukt(await rest(`clients?id=eq.${gent.be.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { vat_number: 'BE0123456749' } }), 'btw-nummer invullen');
    const antwoord = gelukt(await wf(w, 'issueInvoiceWithoutEmail', { invoiceId: c.id }), 'uitgeven zonder mail');
    const na = factuur(c.id);
    gelijk(na.status, 'sent', 'status');
    verwacht(na.journal_entry_id, 'de factuur staat niet in het grootboek');
    gelijk(mailsAan(gent.be.email).length, 0, 'mails aan de klant');
    const versie = sqlRij(`select id, snapshot_reason, pdf_sha256, pdf_storage_provider, (pdf_data_base64 is not null or pdf_storage_key is not null) as heeft_pdf from public.invoice_versions where invoice_id = ${q(c.id)} order by version_number desc limit 1`);
    gelijk({ reden: versie.snapshot_reason, pdf: versie.heeft_pdf, id: na.sent_version_id }, { reden: 'sent_to_client', pdf: true, id: versie.id }, 'de verzonden versie');
    gelijk(versie.pdf_sha256, antwoord.pdf?.sha256, 'de pdf in het antwoord is de bewaarde');
    const download = gelukt(await wf(w, 'downloadInvoicePdf', { invoiceId: c.id }), 'verzonden pdf downloaden');
    gelijk(createHash('sha256').update(Buffer.from(download.pdf.base64, 'base64')).digest('hex'), versie.pdf_sha256, 'de download is dezelfde pdf');
    const event = sqlRij(`select title from public.invoice_workflow_events where invoice_id = ${q(c.id)} and event_type = 'sent_to_client'`);
    gelijk(event?.title, 'Factuur uitgegeven zonder mail', 'tijdlijn');
    // Twee keer uitgeven kan niet.
    geweigerd(await wf(w, 'issueInvoiceWithoutEmail', { invoiceId: c.id }), 'nog eens uitgeven', [409]);
  });

  await stap('een factuur van vóór de startdatum (overstap) zet je nog wel zelf op verzonden en betaald; niet geboekt', async () => {
    const c = await conceptFactuur(w, gent.nl, '2024-11-15', [{ description: 'Oude opdracht', quantity: 1, unit_price: 400, vat: 21, vat_code: 'HOOG' }]);
    gelukt(await rest(`invoices?id=eq.${c.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'sent' } }), 'op verzonden');
    gelukt(await rest(`invoices?id=eq.${c.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'paid' } }), 'op betaald');
    gelijk({ status: factuur(c.id).status, geboekt: Boolean(factuur(c.id).journal_entry_id) }, { status: 'paid', geboekt: false }, 'de factuur');
  });

  // ── 2. 0% met een reden die bij de klant past ─────────────────────────────
  await stap('0% zonder btw-code aan Studio Gent: versturen en uitgeven weigeren, met de reden; geen mail', async () => {
    const c = await conceptFactuur(w, gent.be, vandaag(), [{ description: 'Workshop Gent', quantity: 1, unit_price: 500, vat: 0 }]);
    const fout = geweigerd(await verstuur(w, c, gent.be), 'versturen');
    verwacht(/0% btw, maar niet waarom/.test(fout?.error ?? ''), `melding: ${fout?.error}`);
    geweigerd(await wf(w, 'issueInvoiceWithoutEmail', { invoiceId: c.id }), 'uitgeven zonder mail');
    gelijk(mailsAan(gent.be.email).length, 0, 'mails aan de klant');
    gelijk(factuur(c.id).status, 'draft', 'de factuur');
  });

  await stap('NUL (het Nederlandse 0%-tarief) aan Studio Gent: geweigerd, de melding wijst naar ICP', async () => {
    const c = await conceptFactuur(w, gent.be, vandaag(), [{ description: 'Workshop Gent', quantity: 1, unit_price: 500, vat: 0, vat_code: 'NUL' }]);
    const fout = geweigerd(await verstuur(w, c, gent.be), 'versturen');
    verwacht(/Nederlandse 0%-tarief/.test(fout?.error ?? '') && /ICP diensten/.test(fout?.error ?? ''), `melding: ${fout?.error}`);
  });

  await stap('NUL aan een klant in Nederland en ICP aan Studio Gent (met btw-nummer): gewoon verstuurd', async () => {
    const nul = await conceptFactuur(w, gent.nl, vandaag(), [{ description: 'Zonnepanelen leggen', quantity: 1, unit_price: 300, vat: 0, vat_code: 'NUL' }]);
    gelukt(await verstuur(w, nul, gent.nl), 'NUL in Nederland');
    const ok = await conceptFactuur(w, gent.be, vandaag(), ICP_500);
    gelukt(await verstuur(w, ok, gent.be), 'ICP met btw-nummer');
    gelijk([factuur(nul.id).status, factuur(ok.id).status], ['sent', 'sent'], 'beide verstuurd');
  });

  // ── 3. Offerte → factuur: de betaaltermijn ────────────────────────────────
  await stap('een geaccepteerde offerte wordt een factuur met 30 dagen, zoals de bedrijfsgegevens zeggen', async () => {
    const offerte = gelukt(await rest('quotes?select=*', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.eigenaar.id, client_id: gent.nl.id, number: `OFF-REGELS-${randomUUID().slice(0, 6)}`, date: vandaag(), valid_until: vandaag(30), status: 'draft', lines: [{ id: randomUUID(), description: 'Bruiloftsreportage', quantity: 1, unit_price: 1200, vat: 21, vat_code: 'HOOG' }] },
    }), 'offerte')[0];
    gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.eigenaar.token), 'indienen');
    gelukt(await rpc('approve_quote_internal', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.eigenaar.token), 'goedkeuren');
    gelukt(await roep('quote-workflow', { token: w.eigenaar.token, body: { action: 'sendQuoteEmail', organizationId: w.orgId, quoteId: offerte.id } }), 'offerte versturen');
    const mail = mailsAan(gent.nl.email).find((m) => /\/quote\//.test(`${m.html} ${m.text}`));
    const token = nodig(`${mail?.html} ${mail?.text}`.match(/\/quote\/([A-Za-z0-9_-]{20,})/)?.[1], 'de offertelink');
    gelukt(await roep('quote-public', { body: { action: 'acceptQuote', token, name: 'Anna Aalbers', email: gent.nl.email, note: 'Akkoord' } }), 'akkoord');
    const res = gelukt(await rpc('convert_accepted_quote_to_invoice', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.eigenaar.token), 'omzetten');
    const rij = Array.isArray(res) ? res[0] : res;
    gelijk([rij.date, rij.due_date], [vandaag(), vandaag(30)], 'factuurdatum en vervaldatum');
  });

  await stap('de betaaltermijn in de database rekent als het formulier (paymentTermDays)', async () => {
    const rijen = sql(`select string_agg(public.payment_term_days(t)::text, ',' order by n) as d from (values (1, 'Betaling binnen 30 dagen.'), (2, null), (3, 'binnen 1 dag'), (4, 'Net 45 days'), (5, 'binnen 365 dagen'), (6, 'binnen 0 dagen'), (7, 'Graag snel')) v(n, t)`);
    gelijk(String(rijen).trim(), '30,14,1,45,120,1,14', 'termijnen');
  });
}
