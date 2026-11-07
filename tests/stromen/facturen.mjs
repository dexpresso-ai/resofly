// Factuur- en betaalstroom van begin tot eind, met de echte edge functions
// (invoice-workflow, invoice-public, client-portal) tegen een lokale stack:
// een concept dat een lid opslaat zoals de app dat doet, versturen met PDF, het
// grootboek, de publieke factuurpagina, Mollie (koppelen, betaallink, webhook),
// een deelbetaling via de bank, crediteren, terugbetalen, KOR, storingen bij
// Resend en Mollie, het klantportaal, en wie wat mag — ook vanuit een andere
// organisatie.
//
// Waarom zo uitgebreid: geld en bewaarplicht (CLAUDE.md, harde regel 6). Een
// verstuurde of geboekte factuur ligt vast, het grootboek moet na elke stap
// kloppen, en er mag nooit dubbel betaald of terugbetaald worden. Daarom kijkt
// elke stap niet alleen naar het antwoord van de functie, maar ook naar wat er
// in de database staat en wat er bij de nepdiensten (Resend, Mollie) gebeurde.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { mailsAan, mollieBetaal, mollieTerugbetalingKlaar, mollieWebhook, post } from './nepdiensten.mjs';
import { WEBHOOK_SECRET } from './omgeving.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS, TOTAAL_REGELS } from './wereld.mjs';

const TOTAAL_CENT = Math.round(TOTAAL_REGELS * 100);

// ── Hulpjes ─────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** Een datum in Amsterdam (jjjj-mm-dd), zoals de app de factuurdatum vult. */
function vandaag(plusDagen = 0) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(Date.now() + plusDagen * 86_400_000));
}

/** Stopt een stap met een duidelijke reden als een eerdere stap faalde. */
function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

function isPdf(bytes) {
  return Buffer.from(bytes ?? []).subarray(0, 5).toString('latin1') === '%PDF-';
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function vanBase64(b64) {
  return Buffer.from(String(b64 || ''), 'base64');
}

/**
 * De tekst van een PDF via pdftotext (poppler), om te zien wat de klant leest:
 * bedragen, factuurnummer, IBAN. Null als pdftotext er niet is; dan blijft
 * alleen de controle dat het een PDF is.
 */
function pdfTekst(bytes) {
  try {
    // -layout zet een label en zijn waarde met veel spaties uit elkaar; één
    // spatie overhouden maakt "Creditering van factuur FAC-…" weer één zin.
    return execFileSync('pdftotext', ['-layout', '-', '-'], { input: Buffer.from(bytes), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .replace(/\s+/g, ' ');
  } catch {
    return null;
  }
}

/** Een Mollie-testsleutel per organisatie: nep-Mollie toont een betaling alleen aan de sleutel die hem maakte. */
function mollieSleutel(naam) {
  return `test_${naam}${randomUUID().replace(/-/g, '')}`;
}

/** De regels zoals de app ze opslaat: elke regel met een eigen id. */
function regels(lijst = REGELS) {
  return lijst.map((regel) => ({ id: randomUUID(), ...regel }));
}

/** Het volgende nummer zoals de app het voorstelt (createNextFinanceNumber in src/main.tsx). */
async function volgendNummer(w, gebruiker) {
  const jaar = vandaag().slice(0, 4);
  const res = await rest(`invoices?select=number&organization_id=eq.${w.orgId}`, { token: gebruiker.token });
  gelukt(res, 'factuurnummers lezen');
  const patroon = new RegExp(`^FAC-${jaar}-(\\d+)$`, 'i');
  const hoogste = res.json.reduce((max, rij) => {
    const m = String(rij.number || '').match(patroon);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `FAC-${jaar}-${String(hoogste + 1).padStart(4, '0')}`;
}

/** Een concept opslaan zoals de app (insertRow in src/lib/repository.ts): via PostgREST, met RLS. */
async function nieuwConcept(w, { klant = w.klantA, lijst = REGELS, gebruiker = w.medewerker } = {}) {
  const res = await rest('invoices?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: gebruiker.id, client_id: klant.id, project_id: null,
      number: await volgendNummer(w, gebruiker), date: vandaag(), due_date: vandaag(14),
      status: 'draft', notes: null, lines: regels(lijst),
    },
  });
  gelukt(res, 'concept opslaan');
  return res.json[0];
}

/** Een actie van invoice-workflow, zoals supabase.functions.invoke vanuit de app. */
function wf(w, gebruiker, action, extra = {}) {
  return roep('invoice-workflow', { token: gebruiker?.token, body: { action, organizationId: w.orgId, ...extra } });
}

function verstuur(w, factuur, { gebruiker = w.medewerker, klant = w.klantA, betaallink = false } = {}) {
  return wf(w, gebruiker, 'sendInvoiceEmail', {
    invoiceId: factuur.id, recipientEmail: klant.email, recipientName: `Contact ${klant.name}`, includePaymentLink: betaallink,
  });
}

function publiek(body, opties = {}) {
  return roep('invoice-public', { body, ...opties });
}

function portaal(gebruiker, action, extra = {}) {
  return roep('client-portal', { token: gebruiker?.token, body: { action, ...extra } });
}

function factuurRij(id) {
  return sqlRij(`select * from public.invoices where id = ${q(id)}`);
}

/** Wat er volgens het grootboek openstaat; dezelfde berekening als de betaallink en het portaal. */
function openCent(w, id) {
  return Number(sql(`select public.invoice_open_receivable_cents(${q(w.orgId)}, ${q(id)})`));
}

/** De journaalregels van een boeking, met de grootboekcode erbij. */
function boekingsregels(entryId) {
  return sqlRijen(`select la.code, jl.debit_cents as debet, jl.credit_cents as credit,
      jl.vat_rate::float8 as tarief, jl.vat_amount_cents as btw
    from public.journal_lines jl join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = ${q(entryId)} order by jl.line_index`);
}

function som(regelsLijst, code, kant) {
  return regelsLijst.filter((r) => r.code === code).reduce((s, r) => s + Number(r[kant]), 0);
}

/**
 * De omzetboeking van REGELS: 1300 Debiteuren tegen omzet per tarief (8000 hoog,
 * 8010 laag) en 1510 btw. `richting` 'credit' is het spiegelbeeld (creditnota).
 */
function controleerOmzetboeking(regelsLijst, richting = 'factuur') {
  const vordering = richting === 'factuur' ? 'debet' : 'credit';
  const tegen = richting === 'factuur' ? 'credit' : 'debet';
  gelijk(som(regelsLijst, '1300', vordering), TOTAAL_CENT, `1300 Debiteuren (${vordering})`);
  gelijk(som(regelsLijst, '8000', tegen), 10250, `8000 omzet 21% (${tegen})`);
  gelijk(som(regelsLijst, '8010', tegen), 4550, `8010 omzet 9% (${tegen})`);
  gelijk(som(regelsLijst, '1510', tegen), 2563, `1510 af te dragen btw (${tegen})`);
  const hoog = regelsLijst.find((r) => r.code === '8000');
  const laag = regelsLijst.find((r) => r.code === '8010');
  gelijk([Number(hoog?.tarief), Math.abs(Number(hoog?.btw))], [21, 2153], 'btw-grondslag 21%: tarief en btw');
  gelijk([Number(laag?.tarief), Math.abs(Number(laag?.btw))], [9, 410], 'btw-grondslag 9%: tarief en btw');
  gelijk(regelsLijst.reduce((s, r) => s + Number(r.debet), 0), regelsLijst.reduce((s, r) => s + Number(r.credit), 0), 'debet en credit in evenwicht');
}

/** Betaal- en terugbetaalboekingen van een factuur via Mollie (bron 'payment', bron-id = factuur). */
function mollieBoekingen(factuurId) {
  return sqlRijen(`select id, description from public.journal_entries
    where source_type = 'payment' and source_id = ${q(factuurId)} and status = 'posted' order by created_at, entry_number`);
}

function betaalrijen(factuurId) {
  return sqlRijen(`select id, status, amount_cents, amount_refunded_cents, provider_payment_id, provider_checkout_url,
      journal_entry_id, metadata from public.invoice_payment_records where invoice_id = ${q(factuurId)} order by created_at`);
}

function terugbetalingen(factuurId) {
  return sqlRijen(`select id, kind, status, amount_cents, provider_refund_id, credit_note_id, journal_entry_id
    from public.invoice_refunds where invoice_id = ${q(factuurId)} order by created_at`);
}

function creditnotas(factuurId) {
  return sqlRijen(`select id, number, status, subtotal_amount::float8 as netto, vat_amount::float8 as btw,
      total_amount::float8 as totaal, lines, journal_entry_id, refund_id
    from public.credit_notes where invoice_id = ${q(factuurId)} order by created_at`);
}

function tokenUitMail(mail) {
  const m = `${mail?.html ?? ''} ${mail?.text ?? ''}`.match(/\/invoice\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}

function mollieVan(sleutel) {
  return [...post.mollie.betalingen.values()].filter((b) => b.sleutel === sleutel);
}

/** De Mollie-webhook zoals Mollie hem aanroept (form-encoded, zonder Origin), met of zonder secret. */
function webhook(id, { secret = WEBHOOK_SECRET } = {}) {
  const query = secret === null ? 'webhook=mollie' : `webhook=mollie&secret=${encodeURIComponent(secret)}`;
  return roep('invoice-workflow', {
    query, body: `id=${encodeURIComponent(id)}`, ruw: true, origin: '',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

/** Een Response van de nep-Mollie-webhook (mollieBetaal e.d.) leesbaar maken. */
async function antwoord(response) {
  const tekst = await response.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: response.status, json, tekst };
}

/**
 * Mollie zoals in het echt bij terugbetalingen. De nep-Mollie van de harnas
 * negeert de Idempotency-Key; echte Mollie geeft bij dezelfde sleutel dezelfde
 * terugbetaling terug, ook als twee verzoeken tegelijk komen. Zonder dat zou
 * "opnieuw proberen in hetzelfde venster" hier een dubbele terugbetaling tonen
 * die er in het echt niet is. Met `antwoordKwijt` maakt Mollie de terugbetaling
 * wél aan, maar komt het antwoord nooit aan (time-out, verbroken verbinding).
 */
async function metMollieTerugbetalingen(opties, fn) {
  const vorige = globalThis.fetch;
  const gezien = new Map();
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.mollie.com' || request.method !== 'POST' || !/\/refunds$/.test(url.pathname)) {
      return vorige(input, init);
    }
    const sleutel = request.headers.get('idempotency-key') || '';
    if (!sleutel || !gezien.has(sleutel)) {
      const bezig = vorige(request).then(async (res) => ({ status: res.status, body: await res.text() }));
      if (sleutel) gezien.set(sleutel, bezig);
      bezig.catch(() => gezien.delete(sleutel));
      const uitkomst = await bezig;
      if (uitkomst.status >= 400) gezien.delete(sleutel);
      if (opties.antwoordKwijt > 0) {
        opties.antwoordKwijt -= 1;
        throw new TypeError('fetch failed (het antwoord van Mollie kwam niet aan)');
      }
      return new Response(uitkomst.body, { status: uitkomst.status, headers: { 'content-type': 'application/json' } });
    }
    const eerder = await gezien.get(sleutel);
    return new Response(eerder.body, { status: eerder.status, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = vorige;
  }
}

/** Een verstuurde factuur die de klant via Mollie heeft betaald; geeft factuur en Mollie-id. */
async function betaaldViaMollie(w, sleutel, { klant = w.klantA } = {}) {
  const concept = await nieuwConcept(w, { klant });
  gelukt(await verstuur(w, concept, { klant }), 'versturen');
  const link = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: concept.id }), 'betaallink');
  verwacht(mollieVan(sleutel).some((b) => b.id === link.providerPaymentId), 'betaling niet bij Mollie van deze organisatie');
  const res = await antwoord(await mollieBetaal(link.providerPaymentId));
  gelukt(res, 'webhook na betalen');
  const rij = factuurRij(concept.id);
  gelijk(rij.status, 'paid', 'status na betalen');
  return { factuur: rij, betalingId: link.providerPaymentId };
}

// ── Het scenario ────────────────────────────────────────────────────────

export default async function facturen() {
  groep('Facturen en betalingen');

  const werelden = await stap('werelden maken: eigen organisatie, een tweede organisatie en een met KOR', async () => {
    const w = await maakWereld('facturen');
    const w2 = await maakWereld('facturen-ander');
    const wk = await maakWereld('facturen-kor', { kor: true });
    // Zonder bedrijfsgegevens zeggen de stappen hieronder niets (IBAN op de
    // factuur en de publieke pagina, de KOR-regel).
    const eigen = sqlRij(`select iban, kor_enabled from public.company_settings where organization_id = ${q(w.orgId)}`);
    const kor = sqlRij(`select kor_enabled from public.company_settings where organization_id = ${q(wk.orgId)}`);
    verwacht(eigen?.iban === 'NL91ABNA0417164300' && eigen.kor_enabled === false, 'bedrijfsgegevens van de eigen organisatie ontbreken');
    verwacht(kor?.kor_enabled === true, 'de KOR-organisatie heeft geen KOR-vlag');
    return { w, w2, wk };
  });
  if (!werelden) return;
  const { w, w2, wk } = werelden;
  const sleutel = { A: mollieSleutel('facturena'), B: mollieSleutel('facturenb'), K: mollieSleutel('facturenkor') };

  // ── 1. Concept opslaan en versturen ───────────────────────────────────

  // Wat latere stappen nodig hebben, bewaren we buiten de stap zodra het er
  // is: faalt daarna een controle, dan lopen de volgende stappen toch door en
  // zie je alle fouten in één ronde.
  let f1 = null;
  await stap('concept opslaan als lid, zoals de app (nummer FAC-jjjj-0001, status concept)', async () => {
    const rij = f1 = await nieuwConcept(w);
    gelijk(rij.status, 'draft', 'status');
    verwacht(new RegExp(`^FAC-${vandaag().slice(0, 4)}-0001$`).test(rij.number), `nummer ${rij.number}`);
    gelijk([Number(rij.subtotal_amount), Number(rij.vat_amount), Number(rij.total_amount)], [148, 25.63, TOTAAL_REGELS], 'netto, btw (per tarief) en totaal');
    gelijk([rij.journal_entry_id, rij.locked_at], [null, null], 'een concept is niet geboekt en niet vergrendeld');
  });

  await stap('factuurnummers zijn uniek per organisatie, ook met een spatie of kleine letters ervoor', async () => {
    const f = nodig(f1, 'concept');
    for (const nummer of [f.number, ` ${f.number.toLowerCase()}`]) {
      const res = await rest('invoices?select=id', {
        method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
        body: { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, number: nummer, date: vandaag(), status: 'draft', lines: regels() },
      });
      nietsVeranderd(res, `tweede factuur met nummer "${nummer}"`);
    }
  });

  await stap('een concept blijft bewerkbaar', async () => {
    const f = nodig(f1, 'concept');
    const res = await rest(`invoices?id=eq.${f.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { notes: 'Graag binnen 14 dagen.' },
    });
    gelijk(gelukt(res, 'notitie wijzigen').length, 1, 'gewijzigde rijen');
  });

  let verzending1 = null;
  await stap('versturen als lid: één mail aan de klant, met een geldige PDF en de factuurlink', async () => {
    const f = nodig(f1, 'concept');
    const voor = mailsAan(w.klantA.email).length;
    const uit = gelukt(await verstuur(w, f), 'versturen');
    const mails = mailsAan(w.klantA.email).slice(voor);
    gelijk(mails.length, 1, 'aantal mails aan de klant');
    verwacht(mails[0].subject.includes(f.number), `onderwerp noemt het factuurnummer niet: ${mails[0].subject}`);
    const pdf = mails[0].bijlagen.find((b) => b.naam.toLowerCase().endsWith('.pdf'));
    verwacht(pdf, 'geen PDF-bijlage');
    verwacht(isPdf(pdf.bytes), 'de bijlage is geen geldige PDF (begint niet met %PDF-)');
    gelijk(pdf.naam, `factuur-${f.number}.pdf`, 'bestandsnaam');
    const token = tokenUitMail(mails[0]);
    verwacht(token, 'geen factuurlink in de mail');
    verzending1 = { token, pdfSha: sha256(pdf.bytes) };
    const tekst = pdfTekst(pdf.bytes);
    if (tekst !== null) {
      for (const iets of [f.number, '€ 173,63', 'Btw 21% over € 102,50', 'Btw 9% over € 45,50', 'NL91ABNA0417164300', w.klantA.name, `/invoice/${token}`]) {
        verwacht(tekst.includes(iets), `de PDF noemt "${iets}" niet`);
      }
    }
    gelijk(uit.paymentLinkIncluded, false, 'zonder gekoppeld Mollie geen betaallink');
  });

  await stap('verstuurde factuur: status verzonden, vergrendeld en geboekt', async () => {
    const rij = factuurRij(nodig(f1, 'factuur').id);
    gelijk(rij.status, 'sent', 'status');
    verwacht(rij.locked_at && rij.sent_at, 'geen vergrendeling of verzenddatum');
    verwacht(rij.journal_entry_id, 'niet in het grootboek');
    gelijk(rij.last_email_delivery_status, 'sent', 'verzendstatus');
  });

  await stap('grootboek: 1300 debet 173,63, omzet en btw per tarief (21% en 9%)', async () => {
    const rij = factuurRij(nodig(f1, 'factuur').id);
    controleerOmzetboeking(boekingsregels(nodig(rij.journal_entry_id, 'boeking')), 'factuur');
  });

  await stap('openstaand 17363 cent, ook voor een lid via de app; niets voor wie Financiën niet ziet', async () => {
    const f = nodig(f1, 'factuur');
    gelijk(openCent(w, f.id), TOTAAL_CENT, 'invoice_open_receivable_cents');
    gelijk(gelukt(await rpc('invoice_open_receivable_checked', { p_invoice_id: f.id }, w.medewerker.token), 'als lid'), TOTAAL_CENT, 'als lid');
    gelijk(gelukt(await rpc('invoice_open_receivable_checked', { p_invoice_id: f.id }, w.zonderFinancien.token), 'zonder Financiën'), null, 'zonder Financiën');
  });

  await stap('de bewaarde PDF is precies de PDF uit de mail, en een lezer kan hem downloaden', async () => {
    const uit = gelukt(await wf(w, w.lezer, 'downloadInvoicePdf', { invoiceId: nodig(f1, 'factuur').id }), 'downloaden');
    const bytes = vanBase64(uit.pdf.base64);
    verwacht(isPdf(bytes), 'geen PDF');
    gelijk(sha256(bytes), nodig(verzending1, 'verzending').pdfSha, 'sha-256 van de bewaarde PDF');
  });

  await stap('verzonden factuur ligt vast: regels, klant, nummer, datums, notitie en verwijderen geweigerd (lid en eigenaar)', async () => {
    const f = nodig(f1, 'factuur');
    for (const gebruiker of [w.medewerker, w.eigenaar]) {
      const wijzigingen = [
        { lines: regels([{ description: 'Iets anders', quantity: 1, unit_price: 1, vat: 21 }]) },
        { client_id: w.klantB.id }, { number: `${f.number}-B` }, { date: '2026-01-02' }, { due_date: vandaag(60) },
        { notes: 'Achteraf gewijzigd' },
      ];
      for (const wijziging of wijzigingen) {
        const res = await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: wijziging });
        nietsVeranderd(res, `${Object.keys(wijziging)[0]} wijzigen`);
      }
      nietsVeranderd(await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'DELETE', token: gebruiker.token, prefer: 'return=representation' }), 'verwijderen');
    }
    const rij = factuurRij(f.id);
    gelijk([rij.number, rij.client_id, Number(rij.total_amount)], [f.number, w.klantA.id, TOTAAL_REGELS], 'nummer, klant en totaal');
  });

  await stap('verzonden factuur gaat niet terug naar concept, en annuleren of afboeken zonder creditnota kan niet', async () => {
    const f = nodig(f1, 'factuur');
    for (const status of ['draft', 'cancelled', 'void', 'written_off', 'refunded']) {
      const res = await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status } });
      nietsVeranderd(res, `status naar ${status}`);
    }
    gelijk(factuurRij(f.id).status, 'sent', 'status');
  });

  await stap('mock-betaling afronden kan niet zolang INVOICE_MOLLIE_ALLOW_MOCK uit staat', async () => {
    const f = nodig(f1, 'factuur');
    geweigerd(await wf(w, w.eigenaar, 'markMockInvoicePaymentPaid', { providerPaymentId: 'mock_invoice_payment_x' }), 'mock-actie', [403]);
    // De publieke pagina vangt de weigering op en toont gewoon de factuur.
    const pub = await publiek({ action: 'markMockInvoicePaymentPaid', token: nodig(verzending1, 'token').token, mockPaymentId: 'mock_invoice_payment_x' });
    verwacht(pub.status < 500, `publieke mock-actie gaf ${pub.status}`);
    gelijk(factuurRij(f.id).status, 'sent', 'status');
    gelijk(betaalrijen(f.id).length, 0, 'betaalrijen');
  });

  // ── 2. Publieke factuurpagina ─────────────────────────────────────────

  const fB = await stap('factuur aan klant B versturen (om te zien dat de pagina van A daar niets van toont)', async () => {
    const concept = await nieuwConcept(w, { klant: w.klantB, lijst: [{ description: 'Advies B', quantity: 2, unit_price: 80, vat: 21 }] });
    gelukt(await verstuur(w, concept, { klant: w.klantB }), 'versturen');
    return factuurRij(concept.id);
  });

  let paginaA = null;
  await stap('publieke pagina met de token uit de mail: nummer, bedrag en openstaand bedrag', async () => {
    const uit = paginaA = gelukt(await publiek({ action: 'getInvoice', token: nodig(verzending1, 'token').token }), 'bekijken');
    gelijk(uit.invoice.number, f1.number, 'nummer');
    gelijk(Number(uit.invoice.total_amount), TOTAAL_REGELS, 'totaal');
    gelijk(uit.invoice.open_amount_cents, TOTAAL_CENT, 'openstaand');
    gelijk(uit.client?.name, w.klantA.name, 'klant');
    gelijk(uit.company?.iban, 'NL91ABNA0417164300', 'IBAN om over te maken');
  });

  await stap('publieke pagina lekt niets: geen andere factuur of klant, geen interne id\'s', async () => {
    const tekst = JSON.stringify(nodig(paginaA, 'publieke pagina'));
    const verboden = [nodig(fB, 'factuur B').number, w.klantB.name, w.klantB.email, w.orgId, f1.id, w.medewerker.id, w.medewerker.email,
      'journal_entry_id', 'public_token_hash', 'organization_id', 'created_by', 'locked_reason'];
    for (const iets of verboden) verwacht(!tekst.includes(iets), `de publieke pagina bevat ${iets}`);
  });

  await stap('PDF via de publieke link', async () => {
    const uit = gelukt(await publiek({ action: 'getInvoicePdf', token: nodig(verzending1, 'token').token }), 'PDF');
    verwacht(isPdf(vanBase64(uit.pdf.base64)), 'geen PDF');
    gelijk(sha256(vanBase64(uit.pdf.base64)), verzending1.pdfSha, 'dezelfde PDF als in de mail');
  });

  await stap('publieke pagina: onbekende of lege token en een vreemde herkomst netjes geweigerd', async () => {
    geweigerd(await publiek({ action: 'getInvoice', token: 'x'.repeat(43) }), 'onbekende token', [404]);
    geweigerd(await publiek({ action: 'getInvoice', token: '' }), 'lege token', [400]);
    geweigerd(await publiek({ action: 'getInvoice', token: nodig(verzending1, 'token').token }, { origin: 'https://kwaadwillend.test' }), 'vreemde herkomst', [403]);
  });

  // ── 3. Mollie koppelen, betaallink, webhook ───────────────────────────

  await stap('Mollie koppelen: beheerder, lid, lezer, kijker, boekhouder en zonder Financiën geweigerd (alleen de eigenaar); anoniem 401', async () => {
    // Alleen de eigenaar koppelt (7 november 2026); ontkoppelen mag een beheerder wel.
    geweigerd(await wf(w, w.beheerder, 'saveInvoiceMollieKey', { apiKey: sleutel.A }), 'koppelen als beheerder', [403]);
    for (const [wie, gebruiker] of [['lid', w.medewerker], ['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['zonder Financiën', w.zonderFinancien]]) {
      geweigerd(await wf(w, gebruiker, 'saveInvoiceMollieKey', { apiKey: sleutel.A }), `koppelen als ${wie}`, [403]);
      geweigerd(await wf(w, gebruiker, 'deleteInvoiceMollieKey'), `ontkoppelen als ${wie}`, [403]);
    }
    geweigerd(await wf(w, null, 'saveInvoiceMollieKey', { apiKey: sleutel.A }), 'koppelen zonder inlog', [401]);
    geweigerd(await wf(w, w2.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.A }), 'koppelen door een andere organisatie', [403]);
    gelijk(sqlRij(`select count(*)::int as n from public.organization_invoice_mollie_settings where organization_id = ${q(w.orgId)}`).n, 0, 'koppelingen');
  });

  await stap('Mollie koppelen: een sleutel die niet met test_/live_ begint of die Mollie weigert, wordt niet opgeslagen', async () => {
    geweigerd(await wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: 'sk_geen_mollie_sleutel' }), 'vreemde sleutel', [422]);
    const ingetrokken = mollieSleutel('ingetrokken');
    post.mollie.geweigerdeSleutels.add(ingetrokken);
    geweigerd(await wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: ingetrokken }), 'geweigerde sleutel', [422]);
  });

  await stap('eigenaar koppelt een test_-sleutel: opgeslagen en versleuteld', async () => {
    const uit = gelukt(await wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.A }), 'koppelen');
    gelijk([uit.status.status, uit.status.mode, uit.status.key_suffix], ['connected', 'test', sleutel.A.slice(-4)], 'status');
    const rij = sqlRij(`select status, api_key_encrypted from public.organization_invoice_mollie_settings where organization_id = ${q(w.orgId)}`);
    verwacht(rij?.status === 'connected' && rij.api_key_encrypted, 'niet opgeslagen');
    verwacht(!rij.api_key_encrypted.includes(sleutel.A.slice(5)), 'de sleutel staat leesbaar in de database');
  });

  await stap('Mollie-status: een lezer ziet hem zonder sleutel, zonder Financiën niet, en PostgREST geeft de tabel aan niemand', async () => {
    const uit = gelukt(await wf(w, w.lezer, 'getInvoiceMollieStatus'), 'status als lezer');
    gelijk(uit.status.status, 'connected', 'status');
    verwacht(!JSON.stringify(uit).includes(sleutel.A.slice(5, 20)), 'de sleutel komt mee in het antwoord');
    geweigerd(await wf(w, w.zonderFinancien, 'getInvoiceMollieStatus'), 'status zonder Financiën', [403]);
    for (const gebruiker of [w.eigenaar, w.medewerker]) {
      const res = await rest(`organization_invoice_mollie_settings?select=*&organization_id=eq.${w.orgId}`, { token: gebruiker.token });
      verwacht(res.status >= 400 || (Array.isArray(res.json) && res.json.length === 0), `PostgREST gaf de Mollie-instellingen: ${res.status} ${res.tekst.slice(0, 200)}`);
    }
  });

  let link1 = null;
  await stap('betaallink als lid: Mollie vraagt het openstaande bedrag, met het webhook-secret alleen bij Mollie', async () => {
    const f = nodig(f1, 'factuur');
    const uit = link1 = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id }), 'betaallink');
    verwacht(/^https:\/\/www\.mollie\.com\//.test(uit.checkoutUrl), `checkout-URL ${uit.checkoutUrl}`);
    const betaling = mollieVan(sleutel.A).find((b) => b.id === uit.providerPaymentId);
    verwacht(betaling, 'geen betaling bij Mollie met de sleutel van deze organisatie');
    gelijk(betaling.amount, { currency: 'EUR', value: '173.63' }, 'bedrag bij Mollie');
    gelijk([betaling.metadata?.organizationId, betaling.metadata?.invoiceId], [w.orgId, f.id], 'metadata');
    verwacht(betaling.webhookUrl.includes(`secret=${WEBHOOK_SECRET}`), 'webhook zonder secret');
    const rijen = betaalrijen(f.id);
    gelijk(rijen.map((r) => [r.status, r.amount_cents]), [['open', TOTAAL_CENT]], 'betaalrijen');
    verwacht(!JSON.stringify(rijen[0].metadata).includes(WEBHOOK_SECRET), 'het webhook-secret staat in de metadata die leden kunnen lezen');
  });

  await stap('dezelfde betaallink nog eens: hergebruikt, geen tweede betaling bij Mollie', async () => {
    const eerste = nodig(link1, 'betaallink');
    const voor = mollieVan(sleutel.A).length;
    const uit = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f1.id }), 'nog eens');
    gelijk([uit.providerPaymentId, uit.reused], [eerste.providerPaymentId, true], 'zelfde betaling');
    gelijk(mollieVan(sleutel.A).length, voor, 'betalingen bij Mollie');
  });

  await stap('webhook met een verkeerd of zonder secret: geweigerd, en er verandert niets', async () => {
    const id = nodig(link1, 'betaallink').providerPaymentId;
    post.mollie.betalingen.get(id).status = 'paid';
    try {
      geweigerd(await webhook(id, { secret: 'verkeerd-geheim' }), 'verkeerd secret', [403]);
      geweigerd(await webhook(id, { secret: null }), 'geen secret', [403]);
    } finally {
      post.mollie.betalingen.get(id).status = 'open';
    }
    gelijk(factuurRij(f1.id).status, 'sent', 'factuurstatus');
    gelijk(betaalrijen(f1.id).map((r) => r.status), ['open'], 'betaalstatus');
  });

  await stap('webhook met een onbekend of leeg betaal-id: genegeerd zonder schade', async () => {
    const onbekend = await webhook('tr_onbekend0000000');
    gelijk([onbekend.status, onbekend.json?.ok, onbekend.json?.ignored], [200, true, true], 'onbekend id');
    geweigerd(await webhook(''), 'leeg id', [400]);
    gelijk(factuurRij(f1.id).status, 'sent', 'factuurstatus');
  });

  await stap('webhook voor een betaling waarvan de Mollie-metadata naar een andere organisatie wijst: genegeerd', async () => {
    const id = nodig(link1, 'betaallink').providerPaymentId;
    const betaling = post.mollie.betalingen.get(id);
    const echt = betaling.metadata;
    betaling.metadata = { ...echt, organizationId: w2.orgId };
    betaling.status = 'paid';
    try {
      const res = await webhook(id);
      gelijk([res.status, res.json?.ignored], [200, true], 'antwoord');
    } finally {
      betaling.metadata = echt;
      betaling.status = 'open';
      delete betaling.paidAt;
    }
    gelijk(factuurRij(f1.id).status, 'sent', 'factuurstatus');
    gelijk(betaalrijen(f1.id).map((r) => r.status), ['open'], 'betaalstatus');
  });

  await stap('klant betaalt via Mollie: webhook → betaald, geboekt op 1102/1300, niets meer open', async () => {
    const id = nodig(link1, 'betaallink').providerPaymentId;
    const res = await antwoord(await mollieBetaal(id));
    gelijk([res.status, res.json?.ok], [200, true], 'webhook');
    const rij = factuurRij(f1.id);
    gelijk(rij.status, 'paid', 'factuurstatus');
    verwacht(rij.paid_at, 'geen betaaldatum');
    const [betaling] = betaalrijen(f1.id);
    gelijk(betaling.status, 'paid', 'betaalstatus');
    const regelsLijst = boekingsregels(nodig(betaling.journal_entry_id, 'boeking van de betaling'));
    gelijk([som(regelsLijst, '1102', 'debet'), som(regelsLijst, '1300', 'credit')], [TOTAAL_CENT, TOTAAL_CENT], '1102 debet en 1300 credit');
    gelijk(openCent(w, f1.id), 0, 'openstaand');
  });

  await stap('Mollie herhaalt de webhook: niets dubbel geboekt', async () => {
    const res = await antwoord(await mollieWebhook(nodig(link1, 'betaallink').providerPaymentId));
    gelijk(res.status, 200, 'webhook');
    gelijk(mollieBoekingen(f1.id).length, 1, 'betaalboekingen');
    gelijk(openCent(w, f1.id), 0, 'openstaand');
  });

  await stap('betaalde factuur: geen nieuwe betaallink, herinnering, verzending of creditering', async () => {
    geweigerd(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f1.id }), 'betaallink', [409]);
    geweigerd(await wf(w, w.medewerker, 'sendInvoiceReminderEmail', { invoiceId: f1.id }), 'herinnering', [409]);
    geweigerd(await verstuur(w, f1), 'opnieuw versturen', [409]);
    geweigerd(await wf(w, w.medewerker, 'creditInvoice', { invoiceId: f1.id }), 'crediteren', [409]);
  });

  await stap('webhook met het betaal-id van een andere organisatie raakt deze organisatie niet', async () => {
    gelukt(await wf(w2, w2.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.B }), 'tweede organisatie koppelt Mollie');
    const concept = await nieuwConcept(w2);
    gelukt(await verstuur(w2, concept, { gebruiker: w2.medewerker, klant: w2.klantA }), 'versturen in de tweede organisatie');
    const link = gelukt(await wf(w2, w2.medewerker, 'createInvoicePaymentCheckout', { invoiceId: concept.id }), 'betaallink');
    verwacht(mollieVan(sleutel.B).some((b) => b.id === link.providerPaymentId), 'betaling niet bij de sleutel van de tweede organisatie');
    const voor = { status: factuurRij(f1.id).status, boekingen: mollieBoekingen(f1.id).length, open: openCent(w, f1.id) };
    const res = await webhook(link.providerPaymentId);
    gelijk([res.status, res.json?.ok], [200, true], 'webhook');
    gelijk(factuurRij(concept.id).status, 'sent', 'de open betaling van de tweede organisatie blijft open');
    gelijk({ status: factuurRij(f1.id).status, boekingen: mollieBoekingen(f1.id).length, open: openCent(w, f1.id) }, voor, 'eigen factuur');
  });

  await stap('betaling mislukt bij Mollie: factuur blijft open, en er kan een nieuwe betaallink komen', async () => {
    const f = nodig(fB, 'factuur B');
    const totaalB = 19360; // 2 × € 80 + 21% btw
    const link = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id }), 'betaallink');
    const res = await antwoord(await mollieBetaal(link.providerPaymentId, { status: 'failed' }));
    gelijk(res.status, 200, 'webhook');
    gelijk([factuurRij(f.id).status, openCent(w, f.id)], ['sent', totaalB], 'factuur blijft open');
    const nieuw = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id }), 'nieuwe betaallink');
    verwacht(nieuw.providerPaymentId !== link.providerPaymentId, 'de mislukte betaling werd hergebruikt');
    gelijk(betaalrijen(f.id).map((r) => r.status), ['failed', 'open'], 'betaalrijen');
    gelijk(mollieBoekingen(f.id).length, 0, 'boekingen');
  });

  // ── 4. Deelbetaling via de bank, daarna een betaallink ────────────────

  let f2 = null;
  await stap('tweede factuur versturen met betaallink (zoals de app doet als Mollie gekoppeld is)', async () => {
    const concept = await nieuwConcept(w);
    const uit = gelukt(await verstuur(w, concept, { betaallink: true }), 'versturen');
    const rijen = betaalrijen(concept.id);
    f2 = { ...factuurRij(concept.id), betalingId: rijen[0]?.provider_payment_id, token: tokenUitMail(mailsAan(w.klantA.email).at(-1)) };
    gelijk([uit.paymentLinkIncluded, uit.paymentLinkError], [true, null], 'betaallink in de mail');
    gelijk(rijen.map((r) => [r.status, r.amount_cents]), [['open', TOTAAL_CENT]], 'betaalrijen');
  });

  const bank = await stap('bankrekening aanmaken en een afschrift inlezen als lid (€ 50 onder vermelding van het factuurnummer)', async () => {
    const f = nodig(f2, 'factuur 2');
    const rek = await rest(`ledger_accounts?select=id&organization_id=eq.${w.orgId}&code=eq.1100`, { token: w.medewerker.token });
    const ledgerId = nodig(gelukt(rek, 'grootboekrekening 1100')[0]?.id, 'rekening 1100');
    const ba = await rest('bank_accounts?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, name: 'Zakelijke rekening', iban: 'NL91ABNA0417164300', currency: 'EUR', ledger_account_id: ledgerId, is_active: true, source: 'import' },
    });
    const rekening = gelukt(ba, 'bankrekening')[0];
    const imp = await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: rekening.id,
      p_statement: { format: 'csv', file_name: 'afschrift.csv' },
      p_transactions: [{ booking_date: vandaag(), amount_cents: 5000, currency: 'EUR', counterparty_name: w.klantA.name, counterparty_iban: 'NL02RABO0123456789', description: `Deelbetaling ${f.number}` }],
    }, w.medewerker.token);
    gelijk(gelukt(imp, 'afschrift inlezen').inserted, 1, 'ingelezen transacties');
    const txn = gelukt(await rest(`bank_transactions?select=id,status,matched_invoice_id&bank_account_id=eq.${rekening.id}`, { token: w.medewerker.token }), 'transacties')[0];
    gelijk([txn.status, txn.matched_invoice_id], ['suggested', f.id], 'voorstel: deze factuur');
    return { rekening, txn };
  });

  await stap('deelbetaling van € 50 afletteren op de factuur: openstaand € 123,63, status blijft verzonden', async () => {
    const f = nodig(f2, 'factuur 2');
    const { txn } = nodig(bank, 'banktransactie');
    gelukt(await rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: txn.id, p_matched_invoice_id: f.id }, w.medewerker.token), 'afletteren');
    gelijk(openCent(w, f.id), TOTAAL_CENT - 5000, 'openstaand');
    gelijk(factuurRij(f.id).status, 'sent', 'status');
  });

  await stap('meer afletteren dan er openstaat wordt geweigerd', async () => {
    const f = nodig(f2, 'factuur 2');
    const { rekening } = nodig(bank, 'bankrekening');
    gelukt(await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: rekening.id, p_statement: { format: 'csv', file_name: 'afschrift-2.csv' },
      p_transactions: [{ booking_date: vandaag(), amount_cents: 20000, currency: 'EUR', counterparty_name: 'Onbekend', counterparty_iban: 'NL02RABO0123456789', description: uniek('Overboeking') }],
    }, w.medewerker.token), 'tweede afschrift');
    const txn = gelukt(await rest(`bank_transactions?select=id&bank_account_id=eq.${rekening.id}&amount_cents=eq.20000`, { token: w.medewerker.token }), 'transactie')[0];
    const res = await rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: txn.id, p_matched_invoice_id: f.id }, w.medewerker.token);
    geweigerd(res, 'te veel afletteren');
    verwacht(/openstaande saldo/i.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelijk(openCent(w, f.id), TOTAAL_CENT - 5000, 'openstaand');
  });

  let link2 = null;
  await stap('nieuwe betaallink vraagt alleen het openstaande bedrag (€ 123,63); de oude link vervalt', async () => {
    const f = nodig(f2, 'factuur 2');
    const uit = link2 = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id }), 'betaallink');
    verwacht(uit.providerPaymentId !== f.betalingId, 'de oude link (voor het volle bedrag) is hergebruikt');
    gelijk(post.mollie.betalingen.get(uit.providerPaymentId)?.amount, { currency: 'EUR', value: '123.63' }, 'bedrag bij Mollie');
    const rijen = betaalrijen(f.id);
    gelijk(rijen.map((r) => [r.status, r.amount_cents]), [['expired', TOTAAL_CENT], ['open', TOTAAL_CENT - 5000]], 'betaalrijen');
  });

  await stap('portaal en publieke pagina tonen het openstaande bedrag', async () => {
    const f = nodig(f2, 'factuur 2');
    const info = gelukt(await portaal(w.portaalA, 'getInvoicePaymentInfo', { invoiceId: f.id }), 'portaal');
    gelijk([info.payment.amountCents, info.payment.payable, info.payment.mollieAvailable], [TOTAAL_CENT - 5000, true, true], 'portaal: bedrag, betaalbaar, Mollie');
    const pub = gelukt(await publiek({ action: 'getInvoice', token: nodig(f.token, 'token uit de mail') }), 'publieke pagina');
    gelijk(pub.invoice.open_amount_cents, TOTAAL_CENT - 5000, 'publieke pagina: openstaand');
  });

  await stap('klant betaalt het restant via Mollie: factuur betaald, niets meer open', async () => {
    const f = nodig(f2, 'factuur 2');
    const res = await antwoord(await mollieBetaal(nodig(link2, 'betaallink').providerPaymentId));
    gelijk([res.status, res.json?.ok], [200, true], 'webhook');
    gelijk(factuurRij(f.id).status, 'paid', 'status');
    gelijk(openCent(w, f.id), 0, 'openstaand');
    const betaald = betaalrijen(f.id).find((r) => r.provider_payment_id === link2.providerPaymentId);
    gelijk(som(boekingsregels(nodig(betaald?.journal_entry_id, 'boeking')), '1300', 'credit'), TOTAAL_CENT - 5000, '1300 credit');
  });

  // ── 4b. Terugboeking (chargeback) en opnieuw betalen ──────────────────

  let tb = null;
  await stap('terugboeking via Mollie (chargeback): factuur weer open, vordering terug op 1300, niets dubbel', async () => {
    tb = await betaaldViaMollie(w, sleutel.A);
    const betaling = post.mollie.betalingen.get(tb.betalingId);
    // Zoals Mollie hem in de betaling meestuurt (embed=chargebacks).
    betaling.chargebacks.push({
      resource: 'chargeback', id: `chb_${randomUUID().replace(/-/g, '').slice(0, 10)}`, paymentId: betaling.id,
      amount: { currency: 'EUR', value: '173.63' }, settlementAmount: { currency: 'EUR', value: '-173.63' },
      reason: { code: 'MD06', description: 'Terugboeking door de klant' }, reversedAt: null, createdAt: new Date().toISOString(),
    });
    gelijk((await antwoord(await mollieWebhook(tb.betalingId))).status, 200, 'webhook');
    const rij = factuurRij(tb.factuur.id);
    gelijk([rij.status, rij.paid_at, Number(rij.charged_back_amount)], ['sent', null, TOTAAL_REGELS], 'factuur weer open');
    gelijk(betaalrijen(tb.factuur.id).map((r) => r.status), ['charged_back'], 'betaalrij');
    gelijk(openCent(w, tb.factuur.id), TOTAAL_CENT, 'openstaand');
    gelijk((await antwoord(await mollieWebhook(tb.betalingId))).status, 200, 'herhaalde webhook');
    gelijk(mollieBoekingen(tb.factuur.id).length, 2, 'boekingen: de betaling en de terugboeking, niets dubbel');
  });

  await stap('na de terugboeking betaalt de klant opnieuw; een latere melding over de oude betaling zet de factuur niet terug op open', async () => {
    const t = nodig(tb, 'teruggeboekte factuur');
    const link = gelukt(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: t.factuur.id }), 'nieuwe betaallink');
    verwacht(link.providerPaymentId !== t.betalingId, 'de oude betaling werd hergebruikt');
    gelijk(post.mollie.betalingen.get(link.providerPaymentId)?.amount, { currency: 'EUR', value: '173.63' }, 'bedrag van de nieuwe link');
    gelijk((await antwoord(await mollieBetaal(link.providerPaymentId))).status, 200, 'webhook van de nieuwe betaling');
    gelijk([factuurRij(t.factuur.id).status, openCent(w, t.factuur.id)], ['paid', 0], 'na de tweede betaling');
    // Mollie mag een webhook vaker aanroepen (een nieuwe poging, of een
    // volgende statuswijziging van de oude betaling); dat hoort niets te veranderen.
    gelijk((await antwoord(await mollieWebhook(t.betalingId))).status, 200, 'webhook van de oude betaling');
    const rij = factuurRij(t.factuur.id);
    gelijk({ status: rij.status, betaald: Boolean(rij.paid_at), open: openCent(w, t.factuur.id) }, { status: 'paid', betaald: true, open: 0 },
      'na een latere melding over de oude, teruggeboekte betaling');
  });

  // ── 5. Crediteren van een verzonden, onbetaalde factuur ───────────────

  const f3 = await stap('derde factuur versturen met betaallink (de klant betaalt niet)', async () => {
    const concept = await nieuwConcept(w);
    gelukt(await verstuur(w, concept, { betaallink: true }), 'versturen');
    const rij = factuurRij(concept.id);
    return { ...rij, betalingId: betaalrijen(rij.id)[0]?.provider_payment_id, token: tokenUitMail(mailsAan(w.klantA.email).at(-1)) };
  });

  await stap('crediteren door lezer, kijker, boekhouder of zonder Financiën geweigerd; anoniem 401', async () => {
    const f = nodig(f3, 'factuur 3');
    for (const [wie, gebruiker] of [['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['zonder Financiën', w.zonderFinancien]]) {
      geweigerd(await wf(w, gebruiker, 'creditInvoice', { invoiceId: f.id }), `crediteren als ${wie}`, [403]);
    }
    geweigerd(await wf(w, null, 'creditInvoice', { invoiceId: f.id }), 'crediteren zonder inlog', [401]);
    gelijk(creditnotas(f.id).length, 0, 'creditnota\'s');
  });

  await stap('crediteren met een lopende betaallink: eerst geweigerd; na verlopen bij Mollie wel mogelijk', async () => {
    const f = nodig(f3, 'factuur 3');
    geweigerd(await wf(w, w.medewerker, 'creditInvoice', { invoiceId: f.id }), 'crediteren met open betaallink', [409]);
    const res = await antwoord(await mollieBetaal(nodig(f.betalingId, 'betaling'), { status: 'expired' }));
    gelijk(res.status, 200, 'webhook verlopen');
    gelijk(betaalrijen(f.id).map((r) => r.status), ['expired'], 'betaalstatus');
  });

  // Buiten de stap bewaard: latere stappen (mailen, rollen, andere organisatie)
  // hebben de creditnota nodig, ook als hier een controle faalt.
  let credit3 = null;
  await stap('crediteren als lid: creditnota (volledig bedrag), geboekt, factuur geannuleerd, niets open', async () => {
    const f = nodig(f3, 'factuur 3');
    const voor = mailsAan(w.klantA.email).length;
    const uit = gelukt(await wf(w, w.medewerker, 'creditInvoice', { invoiceId: f.id, reason: 'Opdracht vervallen' }), 'crediteren');
    const [cn] = creditnotas(f.id);
    verwacht(cn && cn.id === uit.creditNote?.id, 'creditnota niet opgeslagen');
    credit3 = cn;
    gelijk([cn.status, cn.netto, cn.btw, cn.totaal], ['issued', 148, 25.63, TOTAAL_REGELS], 'creditnota: status en bedragen');
    controleerOmzetboeking(boekingsregels(nodig(cn.journal_entry_id, 'boeking van de creditnota')), 'credit');
    gelijk(factuurRij(f.id).status, 'cancelled', 'factuurstatus');
    gelijk(openCent(w, f.id), 0, 'openstaand');
    const mails = mailsAan(w.klantA.email).slice(voor);
    gelijk(mails.length, 1, 'mail met de creditnota');
    const pdf = mails[0].bijlagen.find((b) => b.naam.toLowerCase().endsWith('.pdf'));
    verwacht(pdf && isPdf(pdf.bytes), 'geen geldige PDF van de creditnota');
    verwacht(pdf.naam.includes(cn.number), `bestandsnaam ${pdf.naam}`);
    // In de database staan de bedragen van een creditnota positief (wat er
    // gecrediteerd wordt); op het papier staan ze negatief.
    const tekst = pdfTekst(pdf.bytes);
    if (tekst !== null) {
      for (const iets of [cn.number, `Creditering van factuur ${f.number}`, '€ -173,63', '€ -148,00', 'Opdracht vervallen']) {
        verwacht(tekst.includes(iets), `de PDF van de creditnota noemt "${iets}" niet`);
      }
    }
  });

  await stap('een gecrediteerde factuur kan niet nog eens worden gecrediteerd of verstuurd', async () => {
    const f = nodig(f3, 'factuur 3');
    geweigerd(await wf(w, w.medewerker, 'creditInvoice', { invoiceId: f.id }), 'nogmaals crediteren', [409]);
    geweigerd(await verstuur(w, f), 'versturen', [409]);
    geweigerd(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id }), 'betaallink', [409]);
    gelijk(creditnotas(f.id).length, 1, 'creditnota\'s');
  });

  await stap('gecrediteerde factuur verandert niet meer via de status (lid en eigenaar)', async () => {
    const f = nodig(f3, 'factuur 3');
    for (const gebruiker of [w.medewerker, w.eigenaar]) {
      for (const status of ['sent', 'paid', 'draft', 'overdue']) {
        nietsVeranderd(await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: { status } }), `status naar ${status}`);
      }
    }
    gelijk(factuurRij(f.id).status, 'cancelled', 'status');
  });

  await stap('publieke link van een gecrediteerde factuur zegt netjes dat hij geannuleerd is', async () => {
    geweigerd(await publiek({ action: 'getInvoice', token: nodig(f3?.token, 'token') }), 'publieke pagina', [410]);
  });

  await stap('creditnota opnieuw mailen als lid lukt; als lezer niet', async () => {
    const cn = nodig(credit3, 'creditnota');
    geweigerd(await wf(w, w.lezer, 'sendCreditNoteEmail', { creditNoteId: cn.id }), 'als lezer', [403]);
    const voor = mailsAan(w.klantA.email).length;
    gelukt(await wf(w, w.medewerker, 'sendCreditNoteEmail', { creditNoteId: cn.id }), 'als lid');
    gelijk(mailsAan(w.klantA.email).length, voor + 1, 'mails');
    const pdf = gelukt(await wf(w, w.boekhouder, 'downloadCreditNotePdf', { creditNoteId: cn.id }), 'downloaden als boekhouder');
    verwacht(isPdf(vanBase64(pdf.pdf.base64)), 'geen PDF');
  });

  // ── 6. Terugbetalen via Mollie ────────────────────────────────────────

  await stap('terugbetalen: alleen eigenaar of beheerder (lid, lezer, kijker, boekhouder, zonder Financiën geweigerd)', async () => {
    for (const [wie, gebruiker] of [['lid', w.medewerker], ['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['zonder Financiën', w.zonderFinancien]]) {
      geweigerd(await wf(w, gebruiker, 'createInvoiceRefund', { invoiceId: f1.id, amountCents: 100, kind: 'mollie' }), `als ${wie}`, [403]);
    }
    geweigerd(await wf(w, null, 'createInvoiceRefund', { invoiceId: f1.id, amountCents: 100 }), 'zonder inlog', [401]);
    gelijk(terugbetalingen(f1.id).length, 0, 'terugbetalingen');
  });

  await stap('terugbetalen van een onbetaalde factuur, of meer dan het factuurbedrag, geweigerd', async () => {
    geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: nodig(fB, 'factuur B').id, amountCents: 100 }), 'onbetaalde factuur', [409]);
    geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f1.id, amountCents: TOTAAL_CENT + 1, kind: 'mollie' }), 'meer dan het factuurbedrag', [422]);
    geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f1.id, amountCents: 0 }), 'nul', [422]);
  });

  await metMollieTerugbetalingen({}, async () => {
    const terug1 = await stap('beheerder betaalt volledig terug via Mollie, met creditnota; een dubbelklik maakt er één', async () => {
      const id = nodig(link1, 'betaling').providerPaymentId;
      const sleutelActie = `refund-${randomUUID()}`;
      const body = { invoiceId: f1.id, amountCents: TOTAAL_CENT, kind: 'mollie', createCreditNote: true, reason: 'Retour', idempotencyKey: sleutelActie };
      const [a, b] = await Promise.all([wf(w, w.beheerder, 'createInvoiceRefund', body), wf(w, w.beheerder, 'createInvoiceRefund', body)]);
      const ua = gelukt(a, 'eerste klik');
      const ub = gelukt(b, 'tweede klik');
      gelijk(ub.refund.id, ua.refund.id, 'dezelfde terugbetaling');
      gelijk(post.mollie.betalingen.get(id).refunds.length, 1, 'terugbetalingen bij Mollie');
      gelijk(post.mollie.betalingen.get(id).refunds[0].amount, { currency: 'EUR', value: '173.63' }, 'bedrag bij Mollie');
      gelijk(terugbetalingen(f1.id).map((r) => [r.status, r.amount_cents]), [['pending', TOTAAL_CENT]], 'terugbetaling (wacht op Mollie)');
      gelijk(creditnotas(f1.id).length, 0, 'nog geen creditnota zolang Mollie niet klaar is');
      return ua.refund;
    });

    await stap('Mollie rondt af: factuur terugbetaald, creditnota en boekingen kloppen, niets meer open', async () => {
      nodig(terug1, 'terugbetaling');
      const voor = mailsAan(w.klantA.email).length;
      const res = await antwoord(await mollieTerugbetalingKlaar(link1.providerPaymentId));
      gelijk(res.status, 200, 'webhook');
      gelijk(terugbetalingen(f1.id).map((r) => r.status), ['refunded'], 'terugbetaling');
      const rij = factuurRij(f1.id);
      gelijk([rij.status, Number(rij.refunded_amount)], ['refunded', TOTAAL_REGELS], 'factuur');
      const cns = creditnotas(f1.id);
      gelijk(cns.map((c) => [c.status, c.totaal]), [['issued', TOTAAL_REGELS]], 'creditnota');
      controleerOmzetboeking(boekingsregels(nodig(cns[0].journal_entry_id, 'boeking creditnota')), 'credit');
      const [terug] = terugbetalingen(f1.id);
      const geld = boekingsregels(nodig(terug.journal_entry_id, 'boeking van het geld'));
      gelijk([som(geld, '1300', 'debet'), som(geld, '1102', 'credit')], [TOTAAL_CENT, TOTAAL_CENT], 'terugbetaling: 1300 debet, 1102 credit');
      gelijk(openCent(w, f1.id), 0, 'openstaand');
      gelijk(mailsAan(w.klantA.email).length, voor + 1, 'creditnota naar de klant gemaild');
      // Mollie herhaalt de webhook: geen tweede creditnota of boeking.
      await mollieWebhook(link1.providerPaymentId);
      gelijk([creditnotas(f1.id).length, mollieBoekingen(f1.id).length], [1, 2], 'creditnota\'s en Mollie-boekingen na een herhaalde webhook');
    });

    await stap('nog een terugbetaling op een volledig terugbetaalde factuur geweigerd', async () => {
      geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f1.id, amountCents: 1, kind: 'mollie' }), 'via Mollie', [409]);
      geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f1.id, amountCents: 1 }), 'handmatig', [409]);
      gelijk(terugbetalingen(f1.id).length, 1, 'terugbetalingen');
    });

    await stap('terugbetaalde factuur verandert niet meer via de status (lid en eigenaar)', async () => {
      for (const gebruiker of [w.medewerker, w.eigenaar]) {
        for (const status of ['paid', 'sent', 'cancelled']) {
          nietsVeranderd(await rest(`invoices?id=eq.${f1.id}&select=id`, { method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: { status } }), `status naar ${status}`);
        }
      }
      gelijk(factuurRij(f1.id).status, 'refunded', 'status');
    });

    // ── 7. Gemengd betaald (bank + Mollie): deels terug, en de grens ────

    await stap('deels terugbetalen via Mollie (€ 50, met creditnota per btw-tarief); factuur blijft betaald', async () => {
      const f = nodig(f2, 'factuur 2');
      const id = nodig(link2, 'betaling').providerPaymentId;
      gelukt(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f.id, amountCents: 5000, kind: 'mollie', reason: 'Korting', idempotencyKey: randomUUID() }), 'terugbetalen');
      gelijk((await antwoord(await mollieTerugbetalingKlaar(id))).status, 200, 'webhook');
      const rij = factuurRij(f.id);
      gelijk([rij.status, Number(rij.refunded_amount)], ['paid', 50], 'factuur');
      const [cn] = creditnotas(f.id);
      gelijk([cn?.totaal, Math.round((cn?.netto + cn?.btw) * 100)], [50, 5000], 'creditnota: totaal = netto + btw');
      gelijk(cn.lines.map((r) => Number(r.vat)).sort((a, b) => a - b), [9, 21], 'een creditregel per btw-tarief van de factuur');
      gelijk(openCent(w, f.id), 0, 'openstaand');
    });

    await stap('Mollie weigert een terugbetaling (422): niets geboekt en het bedrag komt weer vrij', async () => {
      const f = nodig(f2, 'factuur 2');
      Object.assign(post.mollie.storing, { pad: /\/refunds$/, soort: '422', aantal: 1 });
      try {
        const res = await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f.id, amountCents: 1000, kind: 'mollie', idempotencyKey: randomUUID() });
        verwacht(res.status === 502 && res.json?.ok === false && /weigerde/i.test(res.json?.error ?? ''), `verwacht een nette 502 (Mollie weigerde), kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
      } finally {
        post.mollie.storing.aantal = 0;
      }
      gelijk(terugbetalingen(f.id).map((r) => r.status), ['refunded', 'failed'], 'terugbetalingen');
      gelijk(creditnotas(f.id).length, 1, 'creditnota\'s');
    });

    await stap('via Mollie meer terugbetalen dan er via Mollie binnenkwam geweigerd', async () => {
      // € 123,63 via Mollie, waarvan € 50 al terug: € 73,63 kan nog via Mollie.
      geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: nodig(f2, 'factuur 2').id, amountCents: 7364, kind: 'mollie', idempotencyKey: randomUUID() }), 'via Mollie', [409]);
    });

    await stap('handmatig terugbetalen tot het betaalde bedrag; één cent te veel geweigerd; daarna terugbetaald', async () => {
      const f = nodig(f2, 'factuur 2');
      gelukt(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f.id, amountCents: 10000, reason: 'Bankdeel', idempotencyKey: randomUUID() }), 'handmatig € 100');
      geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f.id, amountCents: TOTAAL_CENT - 15000 + 1, idempotencyKey: randomUUID() }), 'één cent te veel', [409]);
      gelukt(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: f.id, amountCents: TOTAAL_CENT - 15000, idempotencyKey: randomUUID() }), 'het laatste deel');
      const rij = factuurRij(f.id);
      gelijk([rij.status, Number(rij.refunded_amount)], ['refunded', TOTAAL_REGELS], 'factuur');
      const cns = creditnotas(f.id);
      gelijk(Math.round(cns.reduce((s, c) => s + c.totaal, 0) * 100), TOTAAL_CENT, 'samen gecrediteerd');
      verwacht(cns.every((c) => c.journal_entry_id), 'een creditnota is niet geboekt');
    });
  });

  // ── 8. KOR ───────────────────────────────────────────────────────────

  const kor = await stap('KOR: factuur met btw versturen geeft een nette 4xx; geen mail, geen betaallink, blijft concept', async () => {
    gelukt(await wf(wk, wk.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.K }), 'Mollie koppelen');
    const concept = await nieuwConcept(wk);
    const res = await verstuur(wk, concept, { gebruiker: wk.medewerker, klant: wk.klantA, betaallink: true });
    geweigerd(res, 'versturen', [422]);
    verwacht(/KOR|kleineondernemersregeling/i.test(res.json?.error ?? ''), `melding: ${res.json?.error}`);
    gelijk(mailsAan(wk.klantA.email).length, 0, 'mails');
    gelijk(mollieVan(sleutel.K).length, 0, 'betalingen bij Mollie');
    const rij = factuurRij(concept.id);
    gelijk([rij.status, rij.journal_entry_id, rij.locked_at], ['draft', null, null], 'concept, niet geboekt en niet vergrendeld');
    gelijk(sqlRij(`select count(*)::int as n from public.invoice_email_deliveries where invoice_id = ${q(concept.id)}`).n, 0, 'verzendregels');
    return rij;
  });

  await stap('KOR: ook een losse betaallink voor een concept met btw wordt geweigerd', async () => {
    const f = nodig(kor, 'KOR-concept');
    const res = await wf(wk, wk.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id });
    if (res.status >= 200 && res.status < 300) {
      // Laat zien wat er dan misgaat: de klant betaalt € 173,63 inclusief btw,
      // maar de factuur kan met KOR niet op betaald (de database weigert btw).
      const betaal = await antwoord(await mollieBetaal(res.json.providerPaymentId));
      throw new Error(`er ging een Mollie-betaallink van € ${post.mollie.betalingen.get(res.json.providerPaymentId)?.amount?.value} de deur uit voor een KOR-concept met btw; `
        + `na betalen gaf de webhook ${betaal.status} (${String(betaal.json?.error ?? '').slice(0, 160)}), factuurstatus ${factuurRij(f.id).status}, `
        + `betaalstatus ${betaalrijen(f.id).map((r) => r.status).join(',')}`);
    }
    geweigerd(res, 'betaallink');
    gelijk(mollieVan(sleutel.K).length, 0, 'betalingen bij Mollie');
  });

  await stap('KOR: een factuur met btw rechtstreeks als verzonden opslaan weigert de database', async () => {
    const res = await rest('invoices?select=id', {
      method: 'POST', token: wk.medewerker.token, prefer: 'return=representation',
      body: { organization_id: wk.orgId, created_by: wk.medewerker.id, client_id: wk.klantA.id, number: uniek('FAC-KOR'), date: vandaag(), status: 'sent', lines: regels() },
    });
    nietsVeranderd(res, 'verzonden met btw');
  });

  await stap('KOR: een factuur met 0% (code KOR) versturen lukt, geboekt zonder btw', async () => {
    const concept = await nieuwConcept(wk, { lijst: REGELS.map((r) => ({ ...r, vat: 0, vat_code: 'KOR' })) });
    gelukt(await verstuur(wk, concept, { gebruiker: wk.medewerker, klant: wk.klantA }), 'versturen');
    gelijk(mailsAan(wk.klantA.email).length, 1, 'mails');
    const rij = factuurRij(concept.id);
    gelijk([rij.status, Number(rij.total_amount)], ['sent', 148], 'status en totaal');
    const r = boekingsregels(nodig(rij.journal_entry_id, 'boeking'));
    gelijk([som(r, '1300', 'debet'), som(r, '8020', 'credit'), som(r, '1510', 'credit')], [14800, 14800, 0], '1300, 8020 (omzet 0%) en 1510');
    gelijk(openCent(wk, concept.id), 14800, 'openstaand');
  });

  // ── 9. Storingen bij Resend en Mollie ─────────────────────────────────

  // Buiten de stap bewaard: faalt een controle in de stap, dan draait
  // "opnieuw versturen" hieronder toch.
  let fR = null;
  await stap('Resend-storing bij versturen: nette fout (502), concept blijft concept, onvergrendeld en bewerkbaar', async () => {
    fR = await nieuwConcept(w);
    const voor = mailsAan(w.klantA.email).length;
    Object.assign(post.resendStoring, { aantal: 1, soort: '500' });
    let res;
    try {
      res = await verstuur(w, fR);
    } finally {
      post.resendStoring.aantal = 0;
    }
    verwacht(res.status === 502 && res.json?.ok === false && /Resend/.test(res.json?.error ?? ''), `verwacht een nette 502 (Resend), kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
    gelijk(mailsAan(w.klantA.email).length, voor, 'mails');
    const rij = factuurRij(fR.id);
    gelijk([rij.status, rij.journal_entry_id, rij.locked_at], ['draft', null, null], 'concept na de storing: status, boeking, vergrendeling');
    const bewerk = await rest(`invoices?id=eq.${fR.id}&select=id`, { method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { lines: regels() } });
    gelijk(gelukt(bewerk, 'regels wijzigen').length, 1, 'bewerkbaar');
  });

  await stap('de mislukte verzending is vastgelegd: verzendregel en mailstatus "mislukt", melding in de tijdlijn', async () => {
    // fail_invoice_email_send hoort dit te doen. Zonder deze vastlegging blijft
    // de verzendregel op "queued" staan en ziet de gebruiker nergens dat de
    // klant niets kreeg.
    const f = nodig(fR, 'concept');
    const rij = factuurRij(f.id);
    gelijk({
      verzendregels: sqlRijen(`select status from public.invoice_email_deliveries where invoice_id = ${q(f.id)}`).map((r) => r.status),
      mailstatus: rij.last_email_delivery_status,
      tijdlijn: sqlRijen(`select 1 from public.invoice_workflow_events where invoice_id = ${q(f.id)} and event_type = 'email_failed'`).length,
    }, { verzendregels: ['failed'], mailstatus: 'failed', tijdlijn: 1 }, 'vastlegging van de mislukte verzending');
  });

  await stap('opnieuw versturen na de Resend-storing lukt (één mail, één boeking)', async () => {
    const f = nodig(fR, 'concept');
    const voor = mailsAan(w.klantA.email).length;
    gelukt(await verstuur(w, f), 'opnieuw versturen');
    gelijk(mailsAan(w.klantA.email).length, voor + 1, 'mails');
    const rij = factuurRij(f.id);
    gelijk([rij.status, rij.last_email_delivery_status], ['sent', 'sent'], 'status en mailstatus');
    gelijk(sqlRij(`select count(*)::int as n from public.journal_entries where source_type = 'sales_invoice' and source_id = ${q(f.id)}`).n, 1, 'boekingen');
  });

  const fR2 = await stap('netwerkfout bij Resend tijdens versturen mét betaallink: nette fout, blijft concept', async () => {
    const concept = await nieuwConcept(w);
    Object.assign(post.resendStoring, { aantal: 1, soort: 'netwerk' });
    let res;
    try {
      res = await verstuur(w, concept, { betaallink: true });
    } finally {
      post.resendStoring.aantal = 0;
    }
    verwacht(res.status === 502 && res.json?.ok === false, `verwacht een nette 502, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
    gelijk(factuurRij(concept.id).status, 'draft', 'status');
    return concept;
  });

  await stap('na een mislukte verzending mét betaallink is het concept nog bewerkbaar (open punt 4 van de controle van 5 nov.)', async () => {
    const f = nodig(fR2, 'concept');
    const bewerk = await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { lines: regels([{ description: 'Ontwerp (aangepast)', quantity: 1, unit_price: 102.5, vat: 21 }]) } });
    const rij = factuurRij(f.id);
    verwacht(bewerk.status < 300 && bewerk.json?.length === 1,
      `het concept is niet meer te bewerken (${bewerk.status} ${bewerk.tekst.slice(0, 160)}); locked_reason ${rij.locked_reason}, betaalrijen ${betaalrijen(f.id).map((r) => r.status).join(',')}`);
  });

  // Na de aanpassing vraagt de oude link het oude bedrag: die vervalt (sinds
  // 6 november), en opnieuw versturen maakt één nieuwe link voor het nieuwe
  // bedrag. Zonder aanpassing wordt de link hergebruikt (zie hieronder).
  await stap('opnieuw versturen na de netwerkfout en de aanpassing: lukt, met één betaallink voor het nieuwe bedrag', async () => {
    const f = nodig(fR2, 'concept');
    const voor = mollieVan(sleutel.A).length;
    const uit = gelukt(await verstuur(w, f, { betaallink: true }), 'opnieuw versturen');
    gelijk(uit.paymentLinkIncluded, true, 'betaallink in de mail');
    gelijk(factuurRij(f.id).status, 'sent', 'status');
    const actief = betaalrijen(f.id).filter((r) => ['open', 'creating'].includes(r.status));
    gelijk(actief.map((r) => Number(r.amount_cents)), [12403], 'actieve betaallinks (bedrag in centen)');
    gelijk(mollieVan(sleutel.A).length, voor + 1, 'één nieuwe betaling bij Mollie');
  });

  await stap('opnieuw versturen na een netwerkfout zonder aanpassing: de betaallink wordt hergebruikt (geen tweede betaling)', async () => {
    const concept = await nieuwConcept(w);
    Object.assign(post.resendStoring, { aantal: 1, soort: 'netwerk' });
    try {
      geweigerd(await verstuur(w, concept, { betaallink: true }), 'versturen met een netwerkfout', [502]);
    } finally {
      post.resendStoring.aantal = 0;
    }
    const voor = mollieVan(sleutel.A).length;
    const uit = gelukt(await verstuur(w, concept, { betaallink: true }), 'opnieuw versturen');
    gelijk(uit.paymentLinkIncluded, true, 'betaallink in de mail');
    gelijk(betaalrijen(concept.id).filter((r) => ['open', 'creating'].includes(r.status)).length, 1, 'actieve betaallinks');
    gelijk(mollieVan(sleutel.A).length, voor, 'geen nieuwe betaling bij Mollie');
  });

  let fM = null;
  await stap('Mollie-storing bij het maken van een betaallink: nette fout, en de mislukte poging is vastgelegd', async () => {
    fM = await nieuwConcept(w);
    gelukt(await verstuur(w, fM), 'versturen');
    Object.assign(post.mollie.storing, { pad: /^\/v2\/payments$/, soort: '500', aantal: 1 });
    let res;
    try {
      res = await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: fM.id });
    } finally {
      post.mollie.storing.aantal = 0;
    }
    verwacht(res.status === 502 && res.json?.ok === false && /Mollie/.test(res.json?.error ?? ''), `verwacht een nette 502 (Mollie), kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
    // fail_invoice_payment_checkout hoort de poging op "failed" te zetten, met
    // een melding in de tijdlijn; anders lijkt er nog een link "in voorbereiding".
    gelijk({
      betaalrijen: betaalrijen(fM.id).map((r) => r.status),
      tijdlijn: sqlRijen(`select 1 from public.invoice_workflow_events where invoice_id = ${q(fM.id)} and event_type = 'payment_failed'`).length,
    }, { betaalrijen: ['failed'], tijdlijn: 1 }, 'vastlegging van de mislukte poging');
  });

  await stap('na die storing kan de klant meteen betalen: nieuwe betaallink via het portaal en de app', async () => {
    const f = nodig(fM, 'factuur');
    const viaPortaal = await portaal(w.portaalA, 'createInvoicePayment', { invoiceId: f.id });
    const viaApp = await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: f.id });
    const kort = (res) => `${res.status} ${res.json?.ok === false ? res.json.error : 'ok'}`;
    gelijk({ portaal: kort(viaPortaal), app: kort(viaApp) }, { portaal: '200 ok', app: '200 ok' }, 'betaallink direct na de storing');
  });

  await stap('e-factuur via Mollie: een geweigerde uitgifte blokkeert opnieuw versturen en online betalen niet', async () => {
    const klantRes = await rest('clients?select=id,name,email', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: {
        organization_id: w.orgId, name: uniek('Klant Peppol'), email: `peppol.${uniek('f')}@klant.test`.toLowerCase(), contact_name: 'Contact Peppol',
        address_line1: 'Dorpsstraat 3', postal_code: '1234 AB', city: 'Utrecht', country: 'Nederland', client_kind: 'business',
        vat_number: 'NL009876543B01', kvk_number: '87654321', e_invoicing_enabled: true, e_invoice_channel: 'mollie',
      },
    });
    const klant = gelukt(klantRes, 'klant met e-facturatie via Mollie')[0];
    const concept = await nieuwConcept(w, { klant });
    // De nep-Mollie kent /v2/sales-invoices niet en antwoordt 404: voor de
    // functie is dat een weigering van Mollie, net als een echte afwijzing.
    const eerste = await verstuur(w, concept, { klant });
    verwacht(eerste.status >= 400 && eerste.json?.ok === false && /niets verstuurd/i.test(eerste.json?.error ?? ''), `eerste poging: ${eerste.status} ${eerste.tekst.slice(0, 200)}`);
    const poging = sqlRijen(`select status from public.invoice_email_deliveries where invoice_id = ${q(concept.id)}`).map((r) => r.status);
    const tweede = await verstuur(w, concept, { klant });
    const link = await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: concept.id });
    const blokkade = (res, patroon) => (res.status === 409 && patroon.test(res.json?.error ?? '') ? res.json.error : null);
    // Wat de melding aanraadt ("Ververs bij Mollie"), voor in het verslag.
    const ververs = await wf(w, w.medewerker, 'syncMollieSalesInvoice', { invoiceId: concept.id });
    // Wat een gebruiker dan doet: e-facturatie uit bij de klant en gewoon per
    // e-mail versturen (met betaallink, zoals de app); de klant betaalt in het portaal.
    gelukt(await rest(`clients?id=eq.${klant.id}&select=id`, { method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { e_invoicing_enabled: false } }), 'e-facturatie uitzetten');
    const perMail = gelukt(await verstuur(w, concept, { klant, betaallink: true }), 'per e-mail versturen');
    const betalen = await portaal(await maakGebruiker('portaal-peppol', klant.email), 'createInvoicePayment', { invoiceId: concept.id });
    gelijk({
      poging,
      opnieuwVersturen: blokkade(tweede, /wordt al via Mollie verstuurd|halverwege/i),
      betaallink: blokkade(link, /via Mollie als e-factuur uitgegeven/i),
      betaallinkInDeMail: perMail.paymentLinkIncluded,
      betalenInHetPortaal: betalen.status === 200 ? 'ok' : `${betalen.status} ${betalen.json?.error}`,
    }, { poging: ['failed'], opnieuwVersturen: null, betaallink: null, betaallinkInDeMail: true, betalenInHetPortaal: 'ok' },
    `na een geweigerde uitgifte via Mollie ("Ververs bij Mollie" gaf ${ververs.status}: ${String(ververs.json?.error ?? 'ok').slice(0, 80)})`);
  });

  await metMollieTerugbetalingen({}, async () => {
    const m1 = await stap('Mollie onbereikbaar bij terugbetalen: nette fout, bedrag blijft gereserveerd', async () => {
      const betaald = await betaaldViaMollie(w, sleutel.A);
      const actie = randomUUID();
      Object.assign(post.mollie.storing, { pad: /\/refunds$/, soort: 'netwerk', aantal: 1 });
      let res;
      try {
        res = await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: betaald.factuur.id, amountCents: TOTAAL_CENT, kind: 'mollie', idempotencyKey: actie });
      } finally {
        post.mollie.storing.aantal = 0;
      }
      verwacht(res.status === 502 && res.json?.ok === false && /geen antwoord/i.test(res.json?.error ?? ''), `verwacht een nette 502 (geen antwoord van Mollie), kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
      gelijk(terugbetalingen(betaald.factuur.id).map((r) => [r.status, r.amount_cents, r.provider_refund_id]), [['queued', TOTAAL_CENT, null]], 'gereserveerd');
      gelijk(post.mollie.betalingen.get(betaald.betalingId).refunds.length, 0, 'terugbetalingen bij Mollie');
      return { ...betaald, actie };
    });

    await stap('opnieuw in een nieuw venster: geweigerd (het bedrag is gereserveerd); in hetzelfde venster: precies één terugbetaling', async () => {
      const m = nodig(m1, 'betaalde factuur');
      geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: m.factuur.id, amountCents: TOTAAL_CENT, kind: 'mollie', idempotencyKey: randomUUID() }), 'nieuw venster', [409]);
      gelukt(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: m.factuur.id, amountCents: TOTAAL_CENT, kind: 'mollie', idempotencyKey: m.actie }), 'zelfde venster');
      gelijk(post.mollie.betalingen.get(m.betalingId).refunds.length, 1, 'terugbetalingen bij Mollie');
      gelijk((await antwoord(await mollieTerugbetalingKlaar(m.betalingId))).status, 200, 'webhook');
      gelijk(terugbetalingen(m.factuur.id).map((r) => r.status), ['refunded'], 'terugbetalingen');
      gelijk([factuurRij(m.factuur.id).status, creditnotas(m.factuur.id).length, openCent(w, m.factuur.id)], ['refunded', 1, 0], 'factuur, creditnota\'s en openstaand');
    });

    await stap('Mollie maakte de terugbetaling wél, maar het antwoord kwam niet aan: de webhook koppelt hem, niets dubbel', async () => {
      const m = await betaaldViaMollie(w, sleutel.A);
      const opties = { antwoordKwijt: 1 };
      const res = await metMollieTerugbetalingen(opties, () => wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: m.factuur.id, amountCents: TOTAAL_CENT, kind: 'mollie', idempotencyKey: randomUUID() }));
      verwacht(res.status === 502 && res.json?.ok === false, `verwacht een nette 502, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
      const [rij] = terugbetalingen(m.factuur.id);
      gelijk([rij?.status, rij?.provider_refund_id], ['queued', null], 'gereserveerd, nog zonder Mollie-id');
      gelijk(post.mollie.betalingen.get(m.betalingId).refunds.map((r) => r.metadata?.refundId), [rij.id], 'bij Mollie, met onze id in de metadata');
      geweigerd(await wf(w, w.beheerder, 'createInvoiceRefund', { invoiceId: m.factuur.id, amountCents: TOTAAL_CENT, kind: 'mollie', idempotencyKey: randomUUID() }), 'nog eens in een nieuw venster', [409]);
      gelijk((await antwoord(await mollieTerugbetalingKlaar(m.betalingId))).status, 200, 'webhook');
      gelijk(terugbetalingen(m.factuur.id).map((r) => [r.id, r.status]), [[rij.id, 'refunded']], 'één terugbetaling, gekoppeld en afgerond');
      gelijk([post.mollie.betalingen.get(m.betalingId).refunds.length, creditnotas(m.factuur.id).length, openCent(w, m.factuur.id)], [1, 1, 0], 'Mollie, creditnota\'s, openstaand');
    });
  });

  await stap('terugbetaling in het Mollie-dashboard: opgenomen met creditnota en boeking; een herhaalde webhook boekt niets dubbel', async () => {
    const m = await betaaldViaMollie(w, sleutel.A);
    const betaling = post.mollie.betalingen.get(m.betalingId);
    // Rechtstreeks bij Mollie gedaan: zonder onze metadata.
    betaling.refunds.push({
      resource: 'refund', id: `re_dash${randomUUID().replace(/-/g, '').slice(0, 12)}`, status: 'refunded', paymentId: betaling.id,
      amount: { currency: 'EUR', value: '173.63' }, description: 'Terugbetaald via het dashboard', metadata: null, createdAt: new Date().toISOString(),
    });
    betaling.amountRefunded = { currency: 'EUR', value: '173.63' };
    gelijk((await antwoord(await mollieWebhook(m.betalingId))).status, 200, 'webhook');
    gelijk(terugbetalingen(m.factuur.id).map((r) => [r.kind, r.status, r.amount_cents]), [['mollie', 'refunded', TOTAAL_CENT]], 'opgenomen terugbetaling');
    gelijk(creditnotas(m.factuur.id).map((c) => c.totaal), [TOTAAL_REGELS], 'creditnota');
    gelijk([factuurRij(m.factuur.id).status, openCent(w, m.factuur.id)], ['refunded', 0], 'factuur en openstaand');
    gelijk((await antwoord(await mollieWebhook(m.betalingId))).status, 200, 'herhaalde webhook');
    gelijk([terugbetalingen(m.factuur.id).length, creditnotas(m.factuur.id).length, mollieBoekingen(m.factuur.id).length], [1, 1, 2],
      'terugbetalingen, creditnota\'s en Mollie-boekingen');
  });

  // ── 10. Klantportaal ─────────────────────────────────────────────────

  let portaalStukken = null;
  await stap('klantportaal: A ziet zijn verstuurde facturen, geen concepten en niets van B', async () => {
    const concept = await nieuwConcept(w);
    const teBetalen = await nieuwConcept(w);
    gelukt(await verstuur(w, teBetalen), 'versturen');
    portaalStukken = { concept, teBetalen: factuurRij(teBetalen.id) };
    const uit = gelukt(await portaal(w.portaalA, 'getPortalData'), 'portaal A');
    gelijk(uit.accounts.length, 1, 'klantdossiers');
    const nummers = uit.accounts[0].invoices.map((f) => f.number);
    verwacht(nummers.includes(f1.number) && nummers.includes(teBetalen.number), `eigen facturen ontbreken: ${nummers.join(', ')}`);
    verwacht(!nummers.includes(concept.number), 'het portaal toont een concept');
    verwacht(!nummers.includes(nodig(fB, 'factuur B').number), 'het portaal van A toont de factuur van B');
    const tekst = JSON.stringify(uit);
    for (const iets of ['journal_entry_id', 'public_token_hash', 'locked_reason', w.klantB.email]) verwacht(!tekst.includes(iets), `het portaal bevat ${iets}`);
  });

  await stap('klantportaal: B ziet, betaalt en downloadt de factuur van A niet', async () => {
    const f = nodig(portaalStukken, 'portaalfacturen').teBetalen;
    geweigerd(await portaal(w.portaalB, 'getInvoicePaymentInfo', { invoiceId: f.id }), 'betaalinfo', [403]);
    geweigerd(await portaal(w.portaalB, 'createInvoicePayment', { invoiceId: f.id }), 'betalen', [403]);
    geweigerd(await portaal(w.portaalB, 'getInvoicePdf', { invoiceId: f.id }), 'PDF', [403]);
    const uit = gelukt(await portaal(w.portaalB, 'getPortalData'), 'portaal B');
    verwacht(!JSON.stringify(uit).includes(f.number), 'het portaal van B toont een factuur van A');
    geweigerd(await portaal(w2.portaalA, 'getInvoicePaymentInfo', { invoiceId: f.id }), 'portaalklant van een andere organisatie', [403]);
    geweigerd(await portaal(null, 'getPortalData'), 'zonder inlog', [401]);
    gelijk(betaalrijen(f.id).length, 0, 'betaalrijen');
  });

  await stap('klantportaal: een concept is niet te zien, te betalen of te downloaden', async () => {
    const { concept } = nodig(portaalStukken, 'portaalfacturen');
    for (const action of ['getInvoicePaymentInfo', 'createInvoicePayment', 'getInvoicePdf']) {
      geweigerd(await portaal(w.portaalA, action, { invoiceId: concept.id }), action, [404]);
    }
    gelijk(betaalrijen(concept.id).length, 0, 'betaalrijen');
  });

  await stap('klantportaal: A downloadt de PDF en betaalt het openstaande bedrag; betaald, geboekt, niets open', async () => {
    const f = nodig(portaalStukken, 'portaalfacturen').teBetalen;
    const pdf = gelukt(await portaal(w.portaalA, 'getInvoicePdf', { invoiceId: f.id }), 'PDF');
    verwacht(isPdf(vanBase64(pdf.pdf.base64)), 'geen PDF');
    const info = gelukt(await portaal(w.portaalA, 'getInvoicePaymentInfo', { invoiceId: f.id }), 'betaalinfo');
    gelijk([info.payment.amountCents, info.payment.payable, info.payment.iban], [TOTAAL_CENT, true, 'NL91ABNA0417164300'], 'bedrag, betaalbaar, IBAN');
    const link = gelukt(await portaal(w.portaalA, 'createInvoicePayment', { invoiceId: f.id }), 'betalen');
    const betaling = post.mollie.betalingen.get(link.checkoutUrl.split('/').pop());
    verwacht(betaling && betaling.sleutel === sleutel.A, 'betaling niet bij Mollie van deze organisatie');
    gelijk(betaling.amount, { currency: 'EUR', value: '173.63' }, 'bedrag bij Mollie');
    const res = await antwoord(await mollieBetaal(betaling.id));
    gelijk(res.status, 200, 'webhook');
    gelijk(factuurRij(f.id).status, 'paid', 'status');
    gelijk(openCent(w, f.id), 0, 'openstaand (de portaalbetaling is geboekt)');
    const na = gelukt(await portaal(w.portaalA, 'getInvoicePaymentInfo', { invoiceId: f.id }), 'betaalinfo na betalen');
    gelijk([na.payment.isPaid, na.payment.payable], [true, false], 'betaald, niet meer te betalen');
    geweigerd(await portaal(w.portaalA, 'createInvoicePayment', { invoiceId: f.id }), 'nog eens betalen', [409]);
  });

  // ── 11. Rollen: wie mag wat ───────────────────────────────────────────

  await stap('versturen, betaallink, herinnering en creditnota mailen: kijker, boekhouder, lezer, zonder Financiën geweigerd; anoniem 401', async () => {
    const concept = await nieuwConcept(w);
    const verstuurd = nodig(fB, 'factuur B');
    const cn = nodig(credit3, 'creditnota');
    const voor = { mails: post.mails.length, mollie: mollieVan(sleutel.A).length };
    for (const [wie, gebruiker] of [['kijker', w.kijker], ['boekhouder', w.boekhouder], ['lezer', w.lezer], ['zonder Financiën', w.zonderFinancien], ['anoniem', null]]) {
      const verwachtStatus = gebruiker ? [403] : [401];
      geweigerd(await verstuur(w, concept, { gebruiker }), `versturen als ${wie}`, verwachtStatus);
      geweigerd(await wf(w, gebruiker, 'createInvoicePaymentCheckout', { invoiceId: verstuurd.id }), `betaallink als ${wie}`, verwachtStatus);
      geweigerd(await wf(w, gebruiker, 'sendInvoiceReminderEmail', { invoiceId: verstuurd.id }), `herinnering als ${wie}`, verwachtStatus);
      geweigerd(await wf(w, gebruiker, 'sendCreditNoteEmail', { creditNoteId: cn.id }), `creditnota mailen als ${wie}`, verwachtStatus);
    }
    gelijk({ mails: post.mails.length, mollie: mollieVan(sleutel.A).length }, voor, 'er ging niets de deur uit');
    gelijk(factuurRij(concept.id).status, 'draft', 'concept');
  });

  await stap('PostgREST: zonder Financiën geen facturen; kijker, boekhouder en lezer wijzigen niets', async () => {
    const concept = nodig(portaalStukken, 'concept').concept;
    // Ook de tabellen eromheen: de verzendregels dragen de factuurlink (met
    // token), de betaalrijen de checkout-URL's.
    for (const tabel of ['invoices', 'invoice_email_deliveries', 'invoice_payment_records', 'credit_notes', 'invoice_refunds', 'journal_entries']) {
      const zonder = await rest(`${tabel}?select=id&organization_id=eq.${w.orgId}`, { token: w.zonderFinancien.token });
      gelijk(gelukt(zonder, `${tabel} lezen zonder Financiën`).length, 0, `${tabel} zichtbaar zonder Financiën`);
    }
    for (const [wie, gebruiker] of [['kijker', w.kijker], ['boekhouder', w.boekhouder], ['lezer', w.lezer], ['zonder Financiën', w.zonderFinancien]]) {
      nietsVeranderd(await rest(`invoices?id=eq.${concept.id}&select=id`, { method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: { notes: `door ${wie}` } }), `wijzigen als ${wie}`);
      nietsVeranderd(await rest(`invoices?id=eq.${concept.id}&select=id`, { method: 'DELETE', token: gebruiker.token, prefer: 'return=representation' }), `verwijderen als ${wie}`);
    }
    gelijk(factuurRij(concept.id).notes, null, 'notitie');
  });

  // ── 12. Een andere organisatie ────────────────────────────────────────

  await stap('andere organisatie: geen enkele factuuractie met het organisatie-id van de eerste', async () => {
    const acties = [
      ['sendInvoiceEmail', { invoiceId: nodig(fB, 'factuur B').id, recipientEmail: 'aanvaller@kwaad.test' }],
      ['createInvoicePaymentCheckout', { invoiceId: fB.id }], ['creditInvoice', { invoiceId: fB.id }],
      ['createInvoiceRefund', { invoiceId: nodig(portaalStukken, 'portaalfactuur').teBetalen.id, amountCents: 100 }],
      ['downloadInvoicePdf', { invoiceId: fB.id }], ['sendInvoiceReminderEmail', { invoiceId: fB.id }],
      ['downloadCreditNotePdf', { creditNoteId: nodig(credit3, 'creditnota').id }], ['sendCreditNoteEmail', { creditNoteId: credit3.id }],
      ['getInvoiceMollieStatus', {}], ['deleteInvoiceMollieKey', {}], ['proposeDunningNotice', { invoiceId: fB.id }],
    ];
    for (const gebruiker of [w2.eigenaar, w2.beheerder, w2.medewerker]) {
      for (const [action, extra] of acties) geweigerd(await wf(w, gebruiker, action, extra), `${action}`, [403]);
    }
  });

  await stap('andere organisatie: eigen organisatie-id met een factuur of creditnota van de eerste geeft 404', async () => {
    const pf = nodig(portaalStukken, 'portaalfactuur').teBetalen;
    const acties = [
      ['sendInvoiceEmail', { invoiceId: nodig(fB, 'factuur B').id, recipientEmail: 'aanvaller@kwaad.test' }],
      ['createInvoicePaymentCheckout', { invoiceId: fB.id }], ['creditInvoice', { invoiceId: fB.id }],
      ['createInvoiceRefund', { invoiceId: pf.id, amountCents: 100 }], ['downloadInvoicePdf', { invoiceId: fB.id }],
      ['downloadInvoiceUbl', { invoiceId: fB.id }], ['sendInvoiceReminderEmail', { invoiceId: fB.id }],
      ['proposeDunningNotice', { invoiceId: fB.id }], ['syncMollieSalesInvoice', { invoiceId: fB.id }],
      ['downloadMollieInvoicePdf', { invoiceId: fB.id }],
      ['downloadCreditNotePdf', { creditNoteId: nodig(credit3, 'creditnota').id }], ['sendCreditNoteEmail', { creditNoteId: credit3.id }],
      ['downloadCreditNoteUbl', { creditNoteId: credit3.id }],
    ];
    const voor = { mails: post.mails.length, mollie: post.mollie.betalingen.size, status: factuurRij(fB.id).status };
    for (const [action, extra] of acties) geweigerd(await wf(w2, w2.eigenaar, action, extra), action, [404]);
    gelijk({ mails: post.mails.length, mollie: post.mollie.betalingen.size, status: factuurRij(fB.id).status }, voor, 'er veranderde niets');
  });

  await stap('andere organisatie via PostgREST en RPC: niets te lezen, te wijzigen of te boeken', async () => {
    const f = nodig(fB, 'factuur B');
    const { txn } = nodig(bank, 'banktransactie');
    for (const pad of [`invoices?select=id&id=eq.${f.id}`, `credit_notes?select=id&invoice_id=eq.${f3?.id}`, `invoice_payment_records?select=id&invoice_id=eq.${f1.id}`,
      `invoice_email_deliveries?select=id&invoice_id=eq.${f.id}`, `journal_entries?select=id&organization_id=eq.${w.orgId}`]) {
      const res = await rest(pad, { token: w2.eigenaar.token });
      gelijk(gelukt(res, pad).length, 0, `${pad.split('?')[0]} zichtbaar voor een andere organisatie`);
    }
    nietsVeranderd(await rest(`invoices?id=eq.${f.id}&select=id`, { method: 'PATCH', token: w2.eigenaar.token, prefer: 'return=representation', body: { notes: 'gekaapt' } }), 'wijzigen');
    geweigerd(await rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: txn.id, p_matched_invoice_id: f.id }, w2.eigenaar.token), 'banktransactie boeken');
    geweigerd(await rpc('post_sales_invoice_to_ledger', { p_organization_id: w.orgId, p_invoice_id: f.id }, w2.eigenaar.token), 'factuur boeken');
    geweigerd(await rpc('book_all_unbooked_sales_invoices', { p_organization_id: w.orgId }, w2.eigenaar.token), 'alles boeken');
    gelijk(gelukt(await rpc('invoice_open_receivable_checked', { p_invoice_id: f.id }, w2.eigenaar.token), 'openstaand opvragen'), null, 'openstaand zichtbaar');
    gelijk(factuurRij(f.id).notes, null, 'notitie');
  });

  // ── 13. Randen die een concept of een betaalde factuur raken ──────────

  await stap('herinnering voor een concept: geweigerd, zonder betaallink en zonder het concept te vergrendelen', async () => {
    const concept = await nieuwConcept(w);
    const voor = mollieVan(sleutel.A).length;
    const res = await wf(w, w.medewerker, 'sendInvoiceReminderEmail', { invoiceId: concept.id });
    geweigerd(res, 'herinnering voor een concept');
    const rij = factuurRij(concept.id);
    const sporen = { betaalrijen: betaalrijen(concept.id).map((r) => r.status), mollie: mollieVan(sleutel.A).length - voor, vergrendeld: rij.locked_reason };
    gelijk(sporen, { betaalrijen: [], mollie: 0, vergrendeld: null }, `sporen van een geweigerde herinnering (${res.status} ${String(res.json?.error ?? '').slice(0, 80)})`);
  });

  await stap('betaalde, geboekte factuur: annuleren of afboeken via de status kan niet zonder creditnota', async () => {
    const { factuur } = await betaaldViaMollie(w, sleutel.A);
    for (const status of ['cancelled', 'written_off', 'void']) {
      const res = await rest(`invoices?id=eq.${factuur.id}&select=id,status`, { method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { status } });
      const na = factuurRij(factuur.id).status;
      if (na !== 'paid') {
        // Terugzetten lukt dan niet meer (zie enforce_invoice_terminal_status); meld wat er gebeurde.
        throw new Error(`een betaalde, geboekte factuur ging via PostgREST naar "${na}" (${res.status}) zonder creditnota; `
          + `omzet en btw blijven geboekt (open ${openCent(w, factuur.id)} cent, creditnota's ${creditnotas(factuur.id).length})`);
      }
      nietsVeranderd(res, `status naar ${status}`);
    }
  });
}
