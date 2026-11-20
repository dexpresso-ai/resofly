// Factuurherstel: een verstuurde factuur rechtzetten, van begin tot eind.
//
// Waarom dit scenario: bij de controle van de financiële module (verkoop en
// debiteuren, 19 november) liepen drie wegen dood of gaven ze stil foute
// cijfers. Dit scenario speelt ze na zoals een zzp'er ze tegenkomt, met de
// bedragen in het grootboek erbij:
//
//  1. Een deels betaalde factuur: het restant crediteren. Dat kon niet
//     ("al deels betaald; verwerk het restant met een terugbetaling of een
//     memoriaalpost", terwijl Terugbetaling "alleen betaalde facturen" zei).
//  2. Terugbetalen: de verkoop gaat niet door (creditfactuur) of de klant
//     betaalde dubbel (alleen geld terug). Het was één vinkje dat in beide
//     standen fout uitpakte bij het verkeerde geval.
//  3. Versturen met een factuurdatum waarop niet geboekt wordt: afgesloten
//     tijdvak, toekomst, of vóór de startdatum van de boekhouding.
//
// En klein: een negatieve factuur, een btw-tarief dat niet bij de code hoort,
// twee keer tegelijk versturen, en een klant met verstuurde facturen wissen.
// Zie docs/changelog/CHANGELOG_FINANCIEN_HERSTELWEGEN_2026-11-19.md.
//
// Alles gaat zoals in de app: als de eigenaar, via REST en RPC met zijn eigen
// sessie (RLS geldt), en facturen via invoice-workflow.
import { randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { mailsAan, mollieBetaal, mollieTerugbetalingKlaar } from './nepdiensten.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { webadresNaam } from './wereld.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

/** De datum van vandaag in Nederland (JJJJ-MM-DD), plus `dagen`. */
function vandaag(dagen = 0) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(Date.now() + dagen * 86_400_000));
}

/** Een eenmanszaak zoals de inrichting hem achterlaat (zie eenmanszaak.mjs). */
async function maakEenmanszaak(naam, { start = '2025-01-01' } = {}) {
  const eigenaar = await maakGebruiker(`${naam}-eigenaar`);
  const orgNaam = uniek(`Herstel ${naam}`);
  const org = gelukt(await rpc('create_organization', { p_name: orgNaam }, eigenaar.token), 'create_organization');
  const orgId = (Array.isArray(org) ? org[0] : org).id;
  gelukt(await rest('company_settings?on_conflict=organization_id', {
    method: 'POST', token: eigenaar.token, prefer: 'resolution=merge-duplicates,return=representation',
    body: {
      organization_id: orgId, created_by: eigenaar.id, legal_form: 'eenmanszaak',
      company_name: 'Fotografie Van Dijk', address_line1: 'Lange Nieuwstraat 12', postal_code: '3512 PH', city: 'Utrecht',
      country: 'Nederland', email: `info@${naam}.zzp.test`, kvk_number: '87654321', vat_number: 'NL004495445B01',
      iban: 'NL91 ABNA 0417 1643 00', invoice_payment_terms: 'Betaling binnen 14 dagen.', kor_enabled: false,
      vat_return_period: 'quarterly', fiscal_year_start_month: 1, bookkeeping_start_date: start, year_result_account_code: '0500',
    },
  }), 'bedrijfsgegevens');
  gelukt(await rpc('client_subdomain_claim', { p_organization_id: orgId, p_name: webadresNaam(naam) }, eigenaar.token), 'webadres');
  gelukt(await rpc('complete_organization_onboarding', { p_organization_id: orgId, p_display_name: orgNaam }, eigenaar.token), 'inrichting afronden');
  return { naam, orgId, eigenaar };
}

function wf(w, action, extra = {}) {
  return roep('invoice-workflow', { token: w.eigenaar.token, body: { action, organizationId: w.orgId, ...extra } });
}

async function rekening(w, code) {
  const rij = gelukt(await rest(`ledger_accounts?select=id,code&organization_id=eq.${w.orgId}&code=eq.${code}`, { token: w.eigenaar.token }), `rekening ${code}`)[0];
  return nodig(rij, `grootboekrekening ${code}`);
}

async function klant(w, naam) {
  return gelukt(await rest('clients?select=id,name,email', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, name: naam, email: `${randomUUID().slice(0, 8)}@klant.test`, contact_name: naam,
      address_line1: 'Dorpsstraat 2', postal_code: '1234 AB', city: 'Utrecht', country: 'Nederland', client_kind: 'business',
      vat_number: 'NL009876543B01',
    },
  }), `klant ${naam}`)[0];
}

async function conceptFactuur(w, klantRij, datum, regels) {
  return gelukt(await rest('invoices?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, client_id: klantRij.id, project_id: null,
      number: `F${datum.slice(0, 4)}-${randomUUID().slice(0, 6)}`, date: datum, due_date: datum, status: 'draft', notes: null,
      lines: regels.map((regel) => ({ id: randomUUID(), ...regel })),
    },
  }), 'factuur opslaan')[0];
}

function verstuur(w, concept, klantRij, extra = {}) {
  return wf(w, 'sendInvoiceEmail', { invoiceId: concept.id, recipientEmail: klantRij.email, recipientName: klantRij.name, includePaymentLink: false, ...extra });
}

function factuur(id) {
  return sqlRij(`select id, number, status, date, journal_entry_id, total_amount, refunded_amount, paid_at from public.invoices where id = ${q(id)}`);
}

async function verstuurdeFactuur(w, klantRij, datum, regels) {
  const concept = await conceptFactuur(w, klantRij, datum, regels);
  gelukt(await verstuur(w, concept, klantRij), 'factuur versturen');
  const rij = factuur(concept.id);
  verwacht(rij.journal_entry_id, 'de factuur staat niet in het grootboek');
  return rij;
}

async function bankrekening(w) {
  const bankGb = await rekening(w, '1100');
  return gelukt(await rest('bank_accounts?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: w.eigenaar.id, name: 'Zakelijke rekening', iban: 'NL91ABNA0417164300', currency: 'EUR', ledger_account_id: bankGb.id, is_active: true, source: 'import' },
  }), 'bankrekening')[0];
}

/** Een bankmutatie invoeren en verdelen, zoals het scherm Bank dat doet. */
async function bankmutatie(w, bank, datum, bedrag, omschrijving, verdeling) {
  const txn = gelukt(await rpc('create_manual_bank_transaction', {
    p_organization_id: w.orgId, p_bank_account_id: bank.id, p_booking_date: datum, p_amount_cents: bedrag,
    p_counterparty_name: omschrijving, p_counterparty_iban: null, p_description: omschrijving, p_allow_duplicate: true,
  }, w.eigenaar.token), `bankmutatie ${omschrijving}`);
  const id = (Array.isArray(txn) ? txn[0] : txn).id;
  gelukt(await rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: id, p_allocations: verdeling }, w.eigenaar.token), `boeken ${omschrijving}`);
  return id;
}

/** Saldo van een grootboekrekening (debet min credit) over alle geboekte posten. */
function saldo(w, code) {
  return Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and je.status = 'posted' and la.code = ${q(code)}`));
}

/** De stand van de rekeningen waar een factuur doorheen loopt. */
function stand(w) {
  return { deb: saldo(w, '1300'), omzet: saldo(w, '8000'), btw: saldo(w, '1510'), bank: saldo(w, '1100') };
}

function open(w, invoiceId) {
  return Number(sql(`select public.invoice_open_receivable_cents(${q(w.orgId)}, ${q(invoiceId)})`));
}

function creditnotas(w, invoiceId) {
  return sqlRijen(`select id, number, date, status, subtotal_amount, vat_amount, total_amount, journal_entry_id, refund_id, lines
    from public.credit_notes where organization_id = ${q(w.orgId)} and invoice_id = ${q(invoiceId)} order by created_at`);
}

/** Rubriek 1a van de btw-aangifte over het vierde kwartaal van 2026, in centen. */
async function rubriek1a(w) {
  const vakken = gelukt(await rpc('compute_vat_return', { p_organization_id: w.orgId, p_from: '2026-10-01', p_to: '2026-12-31' }, w.eigenaar.token), 'btw-aangifte');
  const rij = (Array.isArray(vakken) ? vakken[0] : vakken);
  // De rubrieken in centen (boxes) als die er zijn; anders het formulier in hele euro's.
  return rij.form['1a'];
}

function sluitKwartaal(w, jaar, nummer) {
  const van = `${jaar}-${String((nummer - 1) * 3 + 1).padStart(2, '0')}-01`;
  const tot = new Date(Date.UTC(jaar, nummer * 3, 0)).toISOString().slice(0, 10);
  return rpc('finalize_vat_return', { p_organization_id: w.orgId, p_period_type: 'quarter', p_year: jaar, p_period_index: nummer, p_from: van, p_to: tot }, w.eigenaar.token);
}

function creditmails(klantRij) {
  return mailsAan(klantRij.email).filter((mail) => /creditfactuur/i.test(mail.subject));
}

const REGEL_1000 = [{ description: 'Reportage', quantity: 1, unit_price: 1000, vat: 21, vat_code: 'HOOG' }];
const REGEL_500 = [{ description: 'Portretten', quantity: 1, unit_price: 500, vat: 21, vat_code: 'HOOG' }];
const REGEL_200 = [{ description: 'Nabewerking', quantity: 1, unit_price: 200, vat: 21, vat_code: 'HOOG' }];

export default async function factuurherstel() {
  const w = await maakEenmanszaak('herstel');
  const bank = await bankrekening(w);
  const r1300 = await rekening(w, '1300');

  // ─────────────────────────────────────────────────────────────────────────
  groep('Factuurherstel 1: crediteren van wat openstaat');
  const kDeels = await klant(w, 'Bureau Noord BV');
  let deels;

  await stap('een factuur van € 1.210 waarop € 400 is betaald: € 810 open, status verzonden', async () => {
    deels = await verstuurdeFactuur(w, kDeels, '2026-10-06', REGEL_1000);
    await bankmutatie(w, bank, '2026-10-20', 40000, 'Deelbetaling Bureau Noord', [{ kind: 'sales_invoice', invoice_id: deels.id, amount_cents: 40000 }]);
    gelijk(factuur(deels.id).status, 'sent', 'status na de deelbetaling');
    gelijk(open(w, deels.id), 81000, 'openstaand na de deelbetaling');
    gelijk(stand(w), { deb: 81000, omzet: -100000, btw: -21000, bank: 40000 }, 'grootboek na de deelbetaling');
    gelijk(await rubriek1a(w), { vat: 210, base: 1000 }, 'rubriek 1a vóór het crediteren');
  });

  await stap('het venster Crediteren krijgt van de server wat er betaald is en wat openstaat', async () => {
    const info = gelukt(await wf(w, 'previewInvoiceCredit', { invoiceId: nodig(deels, 'de factuur').id }), 'previewInvoiceCredit').credit;
    gelijk({ totaal: info.totalCents, betaald: info.paidCents, open: info.openCents, gecrediteerd: info.creditedCents, geboekt: info.booked },
      { totaal: 121000, betaald: 40000, open: 81000, gecrediteerd: 0, geboekt: true }, 'de stand voor het venster');
  });

  await stap('meer crediteren dan er openstaat wordt geweigerd, met het bedrag en de weg die wel werkt', async () => {
    const res = await wf(w, 'creditInvoice', { invoiceId: nodig(deels, 'de factuur').id, amountCents: 90000 });
    const fout = geweigerd(res, 'te veel crediteren').error;
    verwacht(/810,00/.test(fout) && /400,00/.test(fout) && /Terugbetaling/.test(fout), `de melding noemt niet wat openstaat, wat betaald is en de weg: ${fout}`);
    gelijk(creditnotas(w, deels.id).length, 0, 'er is toch een creditnota gemaakt');
  });

  await stap('het restant crediteren: creditfactuur van € 810, de factuur is afgehandeld (betaald)', async () => {
    const res = gelukt(await wf(w, 'creditInvoice', { invoiceId: nodig(deels, 'de factuur').id, reason: 'Laatste dag vervalt' }), 'creditInvoice');
    gelijk({ status: res.status, gecrediteerd: res.creditedCents, rest: res.remainingCents, betaald: res.paidCents, naarKlant: res.sentToClient, meldingen: res.warnings },
      { status: 'paid', gecrediteerd: 81000, rest: 0, betaald: 40000, naarKlant: true, meldingen: [] }, 'het antwoord van crediteren');
    const [cn] = creditnotas(w, deels.id);
    // € 810 incl. 21% btw: € 669,42 + € 140,58.
    gelijk({ netto: Number(cn.subtotal_amount), btw: Number(cn.vat_amount), totaal: Number(cn.total_amount), geboekt: Boolean(cn.journal_entry_id) },
      { netto: 669.42, btw: 140.58, totaal: 810, geboekt: true }, 'de creditnota');
    verwacht(/Gedeeltelijke creditering/.test(cn.lines[0].description), `de regel heet geen creditering: ${cn.lines[0].description}`);
    gelijk(cn.lines[0].vat_code, 'HOOG', 'de btw-code van de creditregel');
    const na = factuur(deels.id);
    gelijk(na.status, 'paid', 'status van de factuur');
    verwacht(na.paid_at, 'paid_at is niet gezet');
    gelijk(open(w, deels.id), 0, 'openstaand na het crediteren');
    // 1300 sluit; omzet en btw dalen met het gecrediteerde deel.
    gelijk(stand(w), { deb: 0, omzet: -(100000 - 66942), btw: -(21000 - 14058), bank: 40000 }, 'grootboek na het crediteren');
    // Rubriek 1a (hele euro's): € 1.000 − € 669,42 = € 330,58 en € 210 − € 140,58 = € 69,42.
    gelijk(await rubriek1a(w), { vat: 69, base: 331 }, 'rubriek 1a na het crediteren');
    gelijk(creditmails(kDeels).length, 1, 'aantal creditfactuur-mails aan de klant');
  });

  await stap('daarna: nog eens crediteren kan niet, en terugbetalen hoogstens de € 400 die betaald is', async () => {
    const nogEens = geweigerd(await wf(w, 'creditInvoice', { invoiceId: nodig(deels, 'de factuur').id }), 'nog eens crediteren').error;
    verwacht(/Terugbetaling/.test(nogEens), `de melding wijst niet naar Terugbetaling: ${nogEens}`);
    const teVeel = geweigerd(await wf(w, 'createInvoiceRefund', { invoiceId: deels.id, amountCents: 81000, purpose: 'sale', kind: 'manual' }), 'meer terugbetalen dan betaald').error;
    verwacht(/400,00/.test(teVeel), `de melding noemt niet de € 400 die terug kan: ${teVeel}`);
    gelijk(sqlRijen(`select id from public.invoice_refunds where invoice_id = ${q(deels.id)}`).length, 0, 'er is toch een terugbetaling vastgelegd');
    // Met de hand annuleren mag niet: het betaalde deel is omzet.
    const patch = await rest(`invoices?id=eq.${deels.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'cancelled' } });
    verwacht(patch.status === 400 && /Terugbetaling/.test(patch.tekst), `annuleren via de status: ${patch.status} ${patch.tekst.slice(0, 200)}`);
  });

  await stap('een onbetaalde factuur deels crediteren: de rest blijft open; de rest crediteren sluit hem op de cent', async () => {
    const k = await klant(w, 'Studio Oost BV');
    const voor = stand(w);
    const f = await verstuurdeFactuur(w, k, '2026-10-08', REGEL_500);
    const deel = gelukt(await wf(w, 'creditInvoice', { invoiceId: f.id, amountCents: 12100, reason: 'Eén portret minder' }), 'deel crediteren');
    gelijk({ status: deel.status, rest: deel.remainingCents }, { status: 'sent', rest: 48400 }, 'na het deel');
    gelijk(open(w, f.id), 48400, 'openstaand na het deel');
    gelijk(factuur(f.id).status, 'sent', 'status na het deel');
    const rest = gelukt(await wf(w, 'creditInvoice', { invoiceId: f.id }), 'de rest crediteren');
    gelijk({ status: rest.status, gecrediteerd: rest.creditedCents }, { status: 'cancelled', gecrediteerd: 48400 }, 'na de rest');
    const cns = creditnotas(w, f.id);
    gelijk(cns.map((cn) => [Number(cn.subtotal_amount), Number(cn.vat_amount), Number(cn.total_amount)]), [[100, 21, 121], [400, 84, 484]], 'de twee creditnota\'s');
    gelijk(open(w, f.id), 0, 'openstaand na alles');
    gelijk(stand(w), voor, 'grootboek: alsof de factuur er nooit was');
    gelijk(creditmails(k).length, 2, 'aantal creditfactuur-mails');
  });

  await stap('afboeken als oninbaar: interne creditnota, omzet en btw terug, geen mail aan de klant', async () => {
    const k = await klant(w, 'Failliet BV');
    const voor = stand(w);
    const f = await verstuurdeFactuur(w, k, '2026-10-09', REGEL_200);
    const res = gelukt(await wf(w, 'creditInvoice', { invoiceId: f.id, sendToClient: false, reason: 'Klant failliet' }), 'afboeken');
    gelijk({ status: res.status, naarKlant: res.sentToClient }, { status: 'written_off', naarKlant: false }, 'het antwoord');
    gelijk(factuur(f.id).status, 'written_off', 'status van de factuur');
    gelijk(open(w, f.id), 0, 'openstaand');
    gelijk(stand(w), voor, 'grootboek na het afboeken');
    gelijk(creditmails(k).length, 0, 'de klant kreeg toch een creditfactuur');
    verwacht(creditnotas(w, f.id)[0].journal_entry_id, 'de interne creditnota is niet geboekt');
  });

  // ─────────────────────────────────────────────────────────────────────────
  groep('Factuurherstel 2: terugbetalen, met de reden erbij');

  await stap('de klant betaalde dubbel: alleen geld terug, geen creditfactuur, de factuur blijft betaald', async () => {
    const k = await klant(w, 'Dubbel BV');
    const f = await verstuurdeFactuur(w, k, '2026-10-12', REGEL_500);
    await bankmutatie(w, bank, '2026-10-20', 60500, 'Betaling Dubbel BV', [{ kind: 'sales_invoice', invoice_id: f.id, amount_cents: 60500 }]);
    // De tweede ontvangst kan niet meer op de factuur; hij staat los op 1300.
    await bankmutatie(w, bank, '2026-10-21', 60500, 'Betaling Dubbel BV (nog eens)', [{ kind: 'ledger', account_id: r1300.id, amount_cents: 60500 }]);
    const voor = stand(w);
    const res = gelukt(await wf(w, 'createInvoiceRefund', { invoiceId: f.id, amountCents: 60500, purpose: 'overpayment', reason: 'Twee keer overgemaakt', kind: 'manual' }), 'te veel betaald terugstorten');
    gelijk({ doel: res.purpose, creditnota: res.creditNote }, { doel: 'overpayment', creditnota: null }, 'het antwoord');
    verwacht(/1300 Debiteuren/.test(res.bookingHint), `de uitleg noemt 1300 Debiteuren niet: ${res.bookingHint}`);
    const na = factuur(f.id);
    gelijk({ status: na.status, terugbetaald: Number(na.refunded_amount) }, { status: 'paid', terugbetaald: 0 }, 'de factuur');
    gelijk(creditnotas(w, f.id).length, 0, 'er is toch een creditnota');
    gelijk(creditmails(k).length, 0, 'de klant kreeg toch een creditfactuur');
    gelijk(stand(w), voor, 'het vastleggen zelf boekt niets');
    // De uitgaande betaling op 1300, zoals het venster uitlegt: 1300 is weer nul.
    await bankmutatie(w, bank, '2026-10-23', -60500, 'Terug naar Dubbel BV', [{ kind: 'ledger', account_id: r1300.id, amount_cents: 60500 }]);
    const eind = stand(w);
    gelijk({ deb: eind.deb - voor.deb, omzet: eind.omzet - voor.omzet, btw: eind.btw - voor.btw, bank: eind.bank - voor.bank },
      { deb: 60500, omzet: 0, btw: 0, bank: -60500 }, 'na de uitgaande betaling');
    gelijk(open(w, f.id), 0, 'openstaand op de factuur');
    // De historie zegt wat het was.
    const gebeurtenis = sqlRij(`select title from public.invoice_workflow_events where invoice_id = ${q(f.id)} and event_type = 'payment_refunded' order by created_at desc limit 1`);
    gelijk(gebeurtenis.title, 'Te veel betaald teruggestort', 'de regel in de historie');
    // Wie daarna toch zegt dat de verkoop verviel, kan dat nog volledig doen:
    // het teruggestorte teveel telt niet mee in wat er al terugbetaald is.
    const info = sqlRij(`select coalesce(sum(amount_cents), 0) as cents from public.invoice_refunds where invoice_id = ${q(f.id)} and coalesce(metadata->>'purpose', '') <> 'overpayment'`);
    gelijk(Number(info.cents), 0, 'terugbetaald op de factuur zelf');
  });

  await stap('het oude vinkje "zonder creditfactuur" (Gerrie, de API) betekent nu: te veel betaald', async () => {
    const k = await klant(w, 'Oude Aanroep BV');
    const f = await verstuurdeFactuur(w, k, '2026-10-13', REGEL_200);
    await bankmutatie(w, bank, '2026-10-21', 24200, 'Betaling Oude Aanroep', [{ kind: 'sales_invoice', invoice_id: f.id, amount_cents: 24200 }]);
    const res = gelukt(await wf(w, 'createInvoiceRefund', { invoiceId: f.id, amountCents: 24200, createCreditNote: false, kind: 'manual' }), 'createCreditNote: false');
    gelijk(res.purpose, 'overpayment', 'het doel');
    gelijk(factuur(f.id).status, 'paid', 'de factuur gaat niet op Terugbetaald');
  });

  let vervallen;
  await stap('de verkoop gaat niet door: creditfactuur, omzet en btw terug, de factuur op Terugbetaald', async () => {
    const k = await klant(w, 'Geannuleerd BV');
    const voorFactuur = stand(w);
    vervallen = await verstuurdeFactuur(w, k, '2026-10-14', REGEL_500);
    await bankmutatie(w, bank, '2026-10-22', 60500, 'Betaling Geannuleerd BV', [{ kind: 'sales_invoice', invoice_id: vervallen.id, amount_cents: 60500 }]);
    const res = gelukt(await wf(w, 'createInvoiceRefund', { invoiceId: vervallen.id, amountCents: 60500, purpose: 'sale', reason: 'Opdracht geannuleerd', kind: 'manual' }), 'terugbetaling met creditfactuur');
    verwacht(res.creditNote?.number, 'er is geen creditfactuur');
    gelijk(res.purpose, 'sale', 'het doel');
    const na = factuur(vervallen.id);
    gelijk({ status: na.status, terugbetaald: Number(na.refunded_amount) }, { status: 'refunded', terugbetaald: 605 }, 'de factuur');
    gelijk(creditmails(k).length, 1, 'aantal creditfactuur-mails');
    // De uitgaande betaling op de creditfactuur: alles terug bij af.
    const [cn] = creditnotas(w, vervallen.id);
    await bankmutatie(w, bank, '2026-10-24', -60500, 'Terug naar Geannuleerd BV', [{ kind: 'sales_credit_note', credit_note_id: cn.id, amount_cents: 60500 }]);
    gelijk(stand(w), voorFactuur, 'grootboek: alsof de factuur er nooit was');
    gelijk(open(w, vervallen.id), 0, 'openstaand');
  });

  await stap('een terugbetaling van vroeger zonder creditfactuur krijgt die alsnog (en maar één keer)', async () => {
    const k = await klant(w, 'Vroeger BV');
    const f = await verstuurdeFactuur(w, k, '2026-10-15', REGEL_200);
    await bankmutatie(w, bank, '2026-10-22', 24200, 'Betaling Vroeger BV', [{ kind: 'sales_invoice', invoice_id: f.id, amount_cents: 24200 }]);
    // Zoals het tot 19 november ging: vastgelegd zonder creditfactuur en zonder
    // doel. De factuur staat op Terugbetaald, omzet en btw staan er nog.
    sql(`select public.begin_invoice_refund(${q(f.id)}, ${q(w.orgId)}, ${q(w.eigenaar.id)}, 24200, 'Opdracht vervallen', 'manual', null, ${q(`oud-${randomUUID()}`)}, '{"create_credit_note": false}'::jsonb)`);
    const refund = sqlRij(`select id, credit_note_id from public.invoice_refunds where invoice_id = ${q(f.id)}`);
    gelijk(factuur(f.id).status, 'refunded', 'status vóór');
    gelijk(creditnotas(w, f.id).length, 0, 'creditnota\'s vóór');
    const voor = stand(w);
    const res = gelukt(await wf(w, 'issueRefundCreditNote', { refundId: refund.id }), 'creditfactuur alsnog maken');
    gelijk(res.alreadyIssued, false, 'de eerste keer');
    verwacht(res.creditNote?.number, 'er is geen creditfactuur gemaakt');
    const na = stand(w);
    // € 242: € 200 omzet en € 42 btw terug, en de vordering (credit op 1300) voor de uitgaande betaling.
    gelijk({ deb: na.deb - voor.deb, omzet: na.omzet - voor.omzet, btw: na.btw - voor.btw }, { deb: -24200, omzet: 20000, btw: 4200 }, 'grootboek na de creditfactuur');
    gelijk(sqlRij(`select credit_note_id from public.invoice_refunds where id = ${q(refund.id)}`).credit_note_id, res.creditNote.id, 'de terugbetaling wijst naar de creditnota');
    gelijk(creditmails(k).length, 1, 'aantal creditfactuur-mails');
    const nogEens = gelukt(await wf(w, 'issueRefundCreditNote', { refundId: refund.id }), 'nog eens');
    gelijk({ al: nogEens.alreadyIssued, nummer: nogEens.creditNote.number }, { al: true, nummer: res.creditNote.number }, 'de tweede keer');
    gelijk(creditnotas(w, f.id).length, 1, 'aantal creditnota\'s');
    gelijk(creditmails(k).length, 1, 'geen tweede mail');
  });

  await stap('betaald via Mollie én per bank: het teveel via Mollie terug, zonder creditfactuur, en het grootboek sluit', async () => {
    const m = await maakEenmanszaak('herstel-mollie');
    const mBank = await bankrekening(m);
    const m1300 = await rekening(m, '1300');
    const k = await klant(m, 'Online BV');
    gelukt(await rest(`company_settings?organization_id=eq.${m.orgId}`, { method: 'PATCH', token: m.eigenaar.token, prefer: 'return=minimal', body: { invoice_send_method: 'mollie' } }), 'verzendwijze via Mollie');
    gelukt(await wf(m, 'saveInvoiceMollieKey', { apiKey: `test_herstel${randomUUID().replace(/-/g, '')}` }), 'Mollie koppelen');
    const concept = await conceptFactuur(m, k, vandaag(), REGEL_200);
    const verzonden = gelukt(await verstuur(m, concept, k, { includePaymentLink: true }), 'versturen met betaallink');
    verwacht(verzonden.paymentLinkIncluded, `geen betaallink: ${verzonden.paymentLinkError}`);
    const betaling = sqlRij(`select id, provider_payment_id from public.invoice_payment_records where invoice_id = ${q(concept.id)} order by created_at desc limit 1`);
    gelijk((await mollieBetaal(betaling.provider_payment_id)).status, 200, 'webhook betaald');
    gelijk(factuur(concept.id).status, 'paid', 'status na de Mollie-betaling');
    // De klant maakt het ook nog over: die ontvangst staat los op 1300.
    await bankmutatie(m, mBank, vandaag(), 24200, 'Online BV, ook per bank', [{ kind: 'ledger', account_id: m1300.id, amount_cents: 24200 }]);
    gelijk({ deb: saldo(m, '1300'), mollie: saldo(m, '1102'), omzet: saldo(m, '8000'), btw: saldo(m, '1510') }, { deb: -24200, mollie: 24200, omzet: -20000, btw: -4200 }, 'grootboek met de dubbele betaling');
    const res = gelukt(await wf(m, 'createInvoiceRefund', { invoiceId: concept.id, amountCents: 24200, purpose: 'overpayment', kind: 'mollie' }), 'het teveel via Mollie terug');
    verwacht(/Mollie-saldo/.test(res.bookingHint), `de uitleg noemt het Mollie-saldo niet: ${res.bookingHint}`);
    gelijk((await mollieTerugbetalingKlaar(betaling.provider_payment_id)).status, 200, 'webhook terugbetaald');
    const na = factuur(concept.id);
    gelijk({ status: na.status, terugbetaald: Number(na.refunded_amount) }, { status: 'paid', terugbetaald: 0 }, 'de factuur');
    gelijk(creditnotas(m, concept.id).length, 0, 'er is toch een creditnota');
    gelijk(creditmails(k).length, 0, 'de klant kreeg toch een creditfactuur');
    // Het geld is van het Mollie-saldo af; op 1300 valt het weg tegen de bankontvangst.
    gelijk({ deb: saldo(m, '1300'), mollie: saldo(m, '1102'), omzet: saldo(m, '8000'), btw: saldo(m, '1510') }, { deb: 0, mollie: 0, omzet: -20000, btw: -4200 }, 'grootboek na de terugbetaling');
    // Van die Mollie-betaling kan niets meer terug.
    geweigerd(await wf(m, 'createInvoiceRefund', { invoiceId: concept.id, amountCents: 100, purpose: 'overpayment', kind: 'mollie' }), 'nog eens via Mollie');
  });

  // ─────────────────────────────────────────────────────────────────────────
  groep('Factuurherstel 3: weten vóór je verstuurt waar de boeking komt');
  const kSend = await klant(w, 'Verzend BV');

  await stap('een gewone factuur: niets te melden', async () => {
    const c = await conceptFactuur(w, kSend, vandaag(), REGEL_200);
    gelijk(gelukt(await wf(w, 'previewInvoiceSend', { invoiceId: c.id }), 'previewInvoiceSend').bookingNotice, null, 'de melding vooraf');
    gelijk(gelukt(await verstuur(w, c, kSend), 'versturen').bookingNotice, null, 'de melding in het antwoord');
  });

  await stap('factuurdatum in de toekomst: de melding noemt de datum, versturen kan nog steeds', async () => {
    const datum = vandaag(30);
    const c = await conceptFactuur(w, kSend, datum, REGEL_200);
    const vooraf = gelukt(await wf(w, 'previewInvoiceSend', { invoiceId: c.id }), 'previewInvoiceSend').bookingNotice;
    gelijk({ soort: vooraf.kind, factuurdatum: vooraf.invoiceDate, boekdatum: vooraf.bookingDate }, { soort: 'future_date', factuurdatum: datum, boekdatum: datum }, 'de melding vooraf');
    verwacht(/na vandaag/.test(vooraf.message) && /op vandaag/.test(vooraf.advice), `tekst: ${vooraf.message} / ${vooraf.advice}`);
    gelijk(factuur(c.id).status, 'draft', 'de controle vooraf verstuurt niets');
    const antwoord = gelukt(await verstuur(w, c, kSend), 'versturen');
    gelijk(antwoord.bookingNotice?.kind, 'future_date', 'de melding in het antwoord (Gerrie, API)');
    gelijk(sqlRij(`select je.date from public.journal_entries je join public.invoices i on i.journal_entry_id = je.id where i.id = ${q(c.id)}`).date, datum, 'de boekdatum');
  });

  await stap('factuurdatum in een aangegeven kwartaal: de boeking komt op de eerste open dag, en dat staat er vooraf', async () => {
    const a = await maakEenmanszaak('herstel-dicht');
    const k = await klant(a, 'Nakomer BV');
    for (const n of [1, 2, 3, 4]) gelukt(await sluitKwartaal(a, 2025, n), `btw-aangifte 2025 Q${n}`);
    gelukt(await sluitKwartaal(a, 2026, 1), 'btw-aangifte 2026 Q1');
    gelukt(await sluitKwartaal(a, 2026, 2), 'btw-aangifte 2026 Q2');
    gelukt(await sluitKwartaal(a, 2026, 3), 'btw-aangifte 2026 Q3');
    // Zelfde jaar: 15 september, het derde kwartaal is dicht.
    const c = await conceptFactuur(a, k, '2026-09-15', REGEL_200);
    const vooraf = gelukt(await wf(a, 'previewInvoiceSend', { invoiceId: c.id }), 'previewInvoiceSend').bookingNotice;
    gelijk({ soort: vooraf.kind, boekdatum: vooraf.bookingDate }, { soort: 'closed_period', boekdatum: '2026-10-01' }, 'de melding vooraf');
    verwacht(/afgesloten/.test(vooraf.message) && !/ander boekjaar/.test(vooraf.message), `tekst: ${vooraf.message}`);
    const antwoord = gelukt(await verstuur(a, c, k), 'versturen');
    gelijk(antwoord.bookingNotice?.bookingDate, '2026-10-01', 'de melding in het antwoord');
    gelijk(sqlRij(`select je.date from public.journal_entries je join public.invoices i on i.journal_entry_id = je.id where i.id = ${q(c.id)}`).date, '2026-10-01', 'de boekdatum');
    // Een ander jaar: 20 december 2025. De melding zegt dat de omzet in 2026 telt.
    const d = await conceptFactuur(a, k, '2025-12-20', REGEL_200);
    const andersJaar = gelukt(await wf(a, 'previewInvoiceSend', { invoiceId: d.id }), 'previewInvoiceSend').bookingNotice;
    gelijk({ soort: andersJaar.kind, boekdatum: andersJaar.bookingDate }, { soort: 'closed_period', boekdatum: '2026-10-01' }, 'de melding voor december 2025');
    verwacht(/ander boekjaar/.test(andersJaar.message) && /2026 in plaats van 2025/.test(andersJaar.message) && /inkomstenbelasting/.test(andersJaar.message), `tekst: ${andersJaar.message}`);
  });

  await stap('factuurdatum vóór de startdatum: wel verstuurd, niet geboekt, en dat staat er vooraf met de weg voor de betaling', async () => {
    const b = await maakEenmanszaak('herstel-start', { start: '2026-11-01' });
    const k = await klant(b, 'Vroege BV');
    const c = await conceptFactuur(b, k, '2026-10-15', REGEL_200);
    const vooraf = gelukt(await wf(b, 'previewInvoiceSend', { invoiceId: c.id }), 'previewInvoiceSend').bookingNotice;
    gelijk({ soort: vooraf.kind, boekdatum: vooraf.bookingDate }, { soort: 'before_start', boekdatum: null }, 'de melding vooraf');
    verwacht(/niet in het grootboek/.test(vooraf.message) && /1300 Debiteuren/.test(vooraf.advice), `tekst: ${vooraf.message} / ${vooraf.advice}`);
    const antwoord = gelukt(await verstuur(b, c, k), 'versturen');
    gelijk(antwoord.bookingNotice?.kind, 'before_start', 'de melding in het antwoord');
    const na = factuur(c.id);
    gelijk({ status: na.status, geboekt: Boolean(na.journal_entry_id) }, { status: 'sent', geboekt: false }, 'de factuur');
    // Crediteren kan (de creditnota wordt dan ook niet geboekt), en het venster weet dat.
    const info = gelukt(await wf(b, 'previewInvoiceCredit', { invoiceId: c.id }), 'previewInvoiceCredit').credit;
    gelijk({ geboekt: info.booked, open: info.openCents }, { geboekt: false, open: 24200 }, 'de stand voor het venster Crediteren');
  });

  // ─────────────────────────────────────────────────────────────────────────
  groep('Factuurherstel 4: wat niet de deur uit mag, en klein');

  await stap('een factuur met een negatief totaal wordt niet verstuurd; de melding wijst naar Crediteren', async () => {
    const c = await conceptFactuur(w, kSend, vandaag(), [{ description: 'Twee uur te veel gerekend', quantity: -2, unit_price: 100, vat: 21, vat_code: 'HOOG' }]);
    const aantal = mailsAan(kSend.email).length;
    const fout = geweigerd(await verstuur(w, c, kSend), 'negatieve factuur versturen', [422]).error;
    verwacht(/negatief bedrag/.test(fout) && /Crediteren/.test(fout) && /Terugbetaling/.test(fout), `tekst: ${fout}`);
    gelijk(mailsAan(kSend.email).length, aantal, 'er ging toch een mail uit');
    gelijk(factuur(c.id).status, 'draft', 'de factuur is geen concept meer');
  });

  await stap('een btw-tarief dat niet bij de btw-code hoort: niet versturen en niet uitgeven', async () => {
    const c = await conceptFactuur(w, kSend, vandaag(), [{ description: 'Hoog met nul', quantity: 1, unit_price: 300, vat: 0, vat_code: 'HOOG' }]);
    const aantal = mailsAan(kSend.email).length;
    const fout = geweigerd(await verstuur(w, c, kSend), 'versturen', [422]).error;
    verwacht(/btw-code HOOG/.test(fout) && /21%/.test(fout), `tekst: ${fout}`);
    gelijk(mailsAan(kSend.email).length, aantal, 'er ging toch een mail uit');
    // Ook rechtstreeks via de status (Gerrie, de API) weigert de database.
    const patch = await rest(`invoices?id=eq.${c.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'sent' } });
    verwacht(patch.status === 400 && /btw-code HOOG/.test(patch.tekst), `uitgeven via de status: ${patch.status} ${patch.tekst.slice(0, 200)}`);
    // Een code met 0% en 21% op de regel (btw gerekend op een verlegde dienst) ook niet.
    const e = await conceptFactuur(w, kSend, vandaag(), [{ description: 'ICP met btw', quantity: 1, unit_price: 300, vat: 21, vat_code: 'ICP_DIENST' }]);
    geweigerd(await verstuur(w, e, kSend), 'ICP met 21%', [422]);
    // Een onbekende code heeft geen tarief om mee te vergelijken; een eigen code wel.
    const eigen = await conceptFactuur(w, kSend, vandaag(), [{ description: 'Onbekende code', quantity: 1, unit_price: 100, vat: 21, vat_code: 'BESTAATNIET' }]);
    gelukt(await verstuur(w, eigen, kSend), 'onbekende code versturen');
  });

  await stap('twee keer tegelijk versturen: één mail, de tweede poging wordt geweigerd', async () => {
    const k = await klant(w, 'Dubbelklik BV');
    const c = await conceptFactuur(w, k, vandaag(), REGEL_200);
    // De mailserver doet er, zoals de echte, even over. De nep-Resend antwoordt
    // meteen; dan kon de eerste verzending al helemaal klaar zijn voordat de
    // tweede begon, en dat is geen verzending die nog loopt maar een nieuwe.
    const directeFetch = globalThis.fetch;
    globalThis.fetch = async (invoer, init) => {
      const url = typeof invoer === 'string' ? invoer : (invoer?.url ?? String(invoer));
      if (url.startsWith('https://api.resend.com/emails')) await new Promise((klaar) => setTimeout(klaar, 1500));
      return directeFetch(invoer, init);
    };
    let een; let twee;
    try {
      [een, twee] = await Promise.all([verstuur(w, c, k), verstuur(w, c, k)]);
    } finally {
      globalThis.fetch = directeFetch;
    }
    const statussen = [een.status, twee.status].sort();
    gelijk(statussen, [200, 409], 'de twee antwoorden');
    const geweigerde = een.status === 409 ? een : twee;
    verwacht(/al verstuurd/.test(geweigerde.json.error), `tekst: ${geweigerde.json.error}`);
    gelijk(mailsAan(k.email).length, 1, 'aantal mails aan de klant');
    gelijk(sqlRijen(`select id from public.journal_entries where source_id = ${q(c.id)} and source_type = 'sales_invoice'`).length, 1, 'aantal boekingen');
    // Daarna bewust nog eens versturen kan gewoon.
    gelukt(await verstuur(w, c, k), 'later nog eens versturen');
    gelijk(mailsAan(k.email).length, 2, 'aantal mails na de bewuste herverzending');
  });

  await stap('een klant met verstuurde facturen verwijderen: een eigen melding; zonder facturen kan hij weg', async () => {
    const res = await rest(`clients?id=eq.${kDeels.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' });
    verwacht(res.status === 400 && /kan niet weg/.test(res.tekst) && /inactief/.test(res.tekst) && !/creditnota/.test(res.tekst), `klant verwijderen: ${res.status} ${res.tekst.slice(0, 300)}`);
    gelijk(sqlRijen(`select id from public.clients where id = ${q(kDeels.id)}`).length, 1, 'de klant is toch weg');
    // Op inactief zetten, zoals de melding zegt, kan.
    gelukt(await rest(`clients?id=eq.${kDeels.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'inactive' } }), 'op inactief zetten');
    // Alleen een concept: de klant kan weg, het concept blijft (zonder klant).
    const los = await klant(w, 'Alleen Concept BV');
    const concept = await conceptFactuur(w, los, vandaag(), REGEL_200);
    gelukt(await rest(`clients?id=eq.${los.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'klant met alleen een concept verwijderen');
    gelijk(sqlRij(`select client_id from public.invoices where id = ${q(concept.id)}`).client_id, null, 'het concept houdt geen klant');
  });

  await stap('een creditnota krijgt de Nederlandse dag als datum', async () => {
    // Tegen het moment van aanmaken, niet tegen "nu": dit scenario kan over
    // middernacht lopen. Tussen 00:00 en 01:00 (winter) is de UTC-dag nog gisteren.
    const rij = sqlRij(`select date::text as datum, (created_at at time zone 'Europe/Amsterdam')::date::text as nl_dag
      from public.credit_notes where invoice_id = ${q(nodig(deels, 'de factuur').id)} order by created_at limit 1`);
    gelijk(rij.datum, rij.nl_dag, 'de datum van de creditnota');
  });
}
