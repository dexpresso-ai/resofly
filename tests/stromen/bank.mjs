// Bank: mutaties met de hand boeken, van begin tot eind tegen een lokale stack.
//
// Wat hier wordt nagelopen (CHANGELOG_BANK_HANDMATIG_BOEKEN_2026-11-07.md):
//   1. zelf een mutatie invoeren, bewerken en verwijderen, met een vraag bij
//      een vermoedelijke dubbele;
//   2. één transactie verdelen over meerdere grootboekrekeningen;
//   3. één betaling tegen meerdere facturen, en terugdraaien;
//   4. een terugbetaling koppelen aan een creditnota;
//   5. een eigen omschrijving van de boeking;
// en dat dit naast de bankkoppeling loopt: komt dezelfde mutatie later van de
// bank, dan voegt de matcher hem samen met de handmatige, ook als er een
// bankregel met "automatisch boeken" op past. Het geld staat er één keer.
//
// Geld en bewaarplicht (CLAUDE.md, regel 6): elke stap kijkt ook in de
// database — het journaal, wat er per factuur openstaat, de aansluiting — en
// niet alleen naar het antwoord van de functie.
import { randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS, TOTAAL_REGELS } from './wereld.mjs';

const FACTUUR = Math.round(TOTAAL_REGELS * 100); // € 173,63

// ── Hulpjes ─────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function vandaag(plusDagen = 0) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(Date.now() + plusDagen * 86_400_000));
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

function wf(w, gebruiker, action, extra = {}) {
  return roep('invoice-workflow', { token: gebruiker?.token, body: { action, organizationId: w.orgId, ...extra } });
}

/** Een verzonden en geboekte factuur van € 173,63, zoals de app hem verstuurt. */
async function verzondenFactuur(w, nummer) {
  const concept = gelukt(await rest('invoices?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, project_id: null,
      number: nummer, date: vandaag(-10), due_date: vandaag(4), status: 'draft', notes: null,
      lines: REGELS.map((regel) => ({ id: randomUUID(), ...regel })),
    },
  }), 'concept opslaan')[0];
  gelukt(await wf(w, w.medewerker, 'sendInvoiceEmail', {
    invoiceId: concept.id, recipientEmail: w.klantA.email, recipientName: `Contact ${w.klantA.name}`, includePaymentLink: false,
  }), `factuur ${nummer} versturen`);
  const rij = factuur(concept.id);
  verwacht(rij.journal_entry_id, `factuur ${nummer} staat niet in het grootboek`);
  return rij;
}

function factuur(id) {
  return sqlRij(`select id, number, status, journal_entry_id, paid_at from public.invoices where id = ${q(id)}`);
}

function openCent(w, id) {
  return Number(sql(`select public.invoice_open_receivable_cents(${q(w.orgId)}, ${q(id)})`));
}

function inkoopOpen(w, id) {
  return Number(sql(`select public.purchase_invoice_open_payable_cents(${q(w.orgId)}, ${q(id)})`));
}

function transactie(id) {
  return sqlRij(`select * from public.bank_transactions where id = ${q(id)}`);
}

function verdeling(txnId) {
  return sqlRijen(`select kind, invoice_id, credit_note_id, purchase_invoice_id, account_id, vat_code, amount_cents, description, journal_entry_id
    from public.bank_transaction_allocations where bank_transaction_id = ${q(txnId)} order by created_at, position`);
}

function boekingsregels(entryId) {
  return sqlRijen(`select la.code, jl.debit_cents as debet, jl.credit_cents as credit, jl.vat_code, jl.vat_amount_cents as btw,
      jl.client_id, jl.supplier_id, jl.description
    from public.journal_lines jl join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = ${q(entryId)} order by jl.line_index`);
}

function som(regels, code, kant) {
  return regels.filter((r) => r.code === code).reduce((s, r) => s + Number(r[kant]), 0);
}

function inBalans(regels) {
  gelijk(regels.reduce((s, r) => s + Number(r.debet), 0), regels.reduce((s, r) => s + Number(r.credit), 0), 'debet en credit in evenwicht');
}

/** Een bankmutatie met de hand invoeren, zoals het scherm (en Gerrie) het doen. */
function invoeren(w, gebruiker, rekeningId, bedrag, velden = {}) {
  return rpc('create_manual_bank_transaction', {
    p_organization_id: w.orgId, p_bank_account_id: rekeningId, p_booking_date: velden.datum ?? vandaag(),
    p_amount_cents: bedrag, p_counterparty_name: velden.naam ?? null, p_counterparty_iban: velden.iban ?? null,
    p_description: velden.omschrijving ?? null, p_allow_duplicate: velden.tochInvoeren ?? false,
  }, gebruiker.token);
}

function boeken(w, gebruiker, txnId, verdelingInvoer, omschrijving = null) {
  return rpc('book_bank_transaction', {
    p_organization_id: w.orgId, p_transaction_id: txnId, p_allocations: verdelingInvoer, p_description: omschrijving,
  }, gebruiker.token);
}

async function rekeningId(w, code) {
  const rij = gelukt(await rest(`ledger_accounts?select=id&organization_id=eq.${w.orgId}&code=eq.${code}`, { token: w.medewerker.token }), `rekening ${code}`)[0];
  return nodig(rij?.id, `grootboekrekening ${code}`);
}

async function bankrekening(w, naam, grootboekId, iban) {
  return gelukt(await rest('bank_accounts?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: w.medewerker.id, name: naam, iban, currency: 'EUR', ledger_account_id: grootboekId, is_active: true, source: 'import' },
  }), `bankrekening ${naam}`)[0];
}

function inlezen(w, gebruiker, rekening, regels, afschrift = { format: 'csv', file_name: `afschrift-${randomUUID()}.csv` }) {
  return rpc('import_bank_transactions', {
    p_organization_id: w.orgId, p_bank_account_id: rekening.id, p_statement: afschrift, p_transactions: regels,
  }, gebruiker.token);
}

function aansluiting(w, rekening) {
  const rijen = sqlRij(`select public.report_bank_reconciliation(${q(w.orgId)}) as r`).r;
  return rijen.find((r) => r.bank_account_id === rekening.id);
}

// ── Het scenario ────────────────────────────────────────────────────────

export default async function bank() {
  groep('Bank — mutaties met de hand boeken');

  const w = await maakWereld('bank');
  const ander = await maakWereld('bank-ander');

  const basis = await stap('rekeningschema, bankrekening en drie verzonden facturen', async () => {
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: w.orgId }, w.medewerker.token), 'rekeningschema');
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: ander.orgId }, ander.medewerker.token), 'rekeningschema andere organisatie');
    const bank1100 = await rekeningId(w, '1100');
    const rekening = await bankrekening(w, 'Zakelijke rekening', bank1100, 'NL91ABNA0417164300');
    const jaar = vandaag().slice(0, 4);
    const f1 = await verzondenFactuur(w, `FAC-${jaar}-0101`);
    const f2 = await verzondenFactuur(w, `FAC-${jaar}-0102`);
    const f3 = await verzondenFactuur(w, `FAC-${jaar}-0103`);
    for (const f of [f1, f2, f3]) gelijk([f.status, openCent(w, f.id)], ['sent', FACTUUR], `factuur ${f.number}`);
    return { rekening, f1, f2, f3, omzet: await rekeningId(w, '8000'), kosten: await rekeningId(w, '4500'), debiteuren: await rekeningId(w, '1300') };
  });

  // ── 1. Zelf een mutatie invoeren ────────────────────────────────────

  const verzamel = await stap('mutatie invoeren als lid: handmatig, open, met een voorstel uit de omschrijving', async () => {
    const { rekening, f1, f2 } = nodig(basis, 'basis');
    const res = await invoeren(w, w.medewerker, rekening.id, 2 * FACTUUR + 5000, {
      datum: vandaag(-2), naam: w.klantA.name, iban: 'nl02 rabo 0123 4567 89', omschrijving: `Betaling ${f1.number} en ${f2.number} plus extra werk`,
    });
    const rij = gelukt(res, 'invoeren');
    gelijk([rij.is_manual, rij.counterparty_iban, rij.dedup_key.startsWith('m:'), rij.created_by], [true, 'NL02RABO0123456789', true, w.medewerker.id], 'handmatige mutatie');
    // De omschrijving noemt twee facturen; het voorstel kiest er één (het
    // scherm vult de tweede zelf aan uit dezelfde tekst).
    verwacht(['unmatched', 'suggested'].includes(rij.status), `status ${rij.status}`);
    const log = sqlRij(`select action, entity_type from public.audit_logs where entity_id = ${q(rij.id)} order by created_at limit 1`);
    gelijk([log?.action, log?.entity_type], ['created', 'bank_transaction'], 'auditlog');
    return rij;
  });

  await stap('wie niet in Financiën mag schrijven, of van een andere organisatie is, voert niets in', async () => {
    const { rekening } = nodig(basis, 'basis');
    for (const [wie, gebruiker] of [['lezer', w.lezer], ['kijker', w.kijker], ['zonder financiën', w.zonderFinancien], ['andere organisatie', ander.eigenaar]]) {
      geweigerd(await invoeren(w, gebruiker, rekening.id, 1234, { naam: 'Poging' }), `invoeren als ${wie}`);
    }
    // De bankrekening van een andere organisatie, met het eigen organisatie-id: niet gevonden.
    const vreemd = await bankrekening(ander, 'Andere rekening', await rekeningId(ander, '1100'), 'NL20INGB0001234567');
    geweigerd(await rpc('create_manual_bank_transaction', {
      p_organization_id: w.orgId, p_bank_account_id: vreemd.id, p_booking_date: vandaag(), p_amount_cents: 100, p_counterparty_name: 'X',
    }, w.medewerker.token), 'invoeren op de rekening van een andere organisatie');
  });

  await stap('invoeren zonder bedrag, datum of omschrijving, of met een kapot IBAN, wordt geweigerd', async () => {
    const { rekening } = nodig(basis, 'basis');
    const proberen = [
      [0, { naam: 'X' }, /bedrag/i],
      [100, {}, /tegenpartij of een omschrijving/i],
      [100, { naam: 'X', iban: 'NL00' }, /IBAN/],
      [100, { naam: 'X', datum: vandaag(500) }, /tikfout/],
    ];
    for (const [bedrag, velden, melding] of proberen) {
      const res = await invoeren(w, w.medewerker, rekening.id, bedrag, velden);
      geweigerd(res, `invoeren ${JSON.stringify(velden)}`);
      verwacht(melding.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    }
  });

  await stap('dezelfde mutatie nog eens: eerst een vraag, met "toch invoeren" wel, en verwijderen kan zolang er niets geboekt is', async () => {
    const { rekening } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    const res = await invoeren(w, w.medewerker, rekening.id, v.amount_cents, { datum: vandaag(-1), naam: 'Nog een keer' });
    geweigerd(res, 'dubbel invoeren');
    gelijk(res.json?.hint, 'mogelijk_dubbel', 'hint voor de app');
    verwacht(/Lijkt dubbel/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    const toch = gelukt(await invoeren(w, w.medewerker, rekening.id, v.amount_cents, { datum: vandaag(-1), naam: 'Nog een keer', tochInvoeren: true }), 'toch invoeren');
    gelukt(await rpc('delete_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: toch.id }, w.medewerker.token), 'verwijderen');
    gelijk(transactie(toch.id), null, 'verwijderd');
    gelijk(sqlRij(`select action from public.audit_logs where entity_id = ${q(toch.id)} and action = 'deleted'`)?.action, 'deleted', 'verwijderen in het auditlog');
  });

  await stap('bewerken van de omschrijving; een mutatie van de bank bewerken of verwijderen kan niet', async () => {
    const { rekening, f1, f2 } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    const nieuw = gelukt(await rpc('update_manual_bank_transaction', {
      p_organization_id: w.orgId, p_transaction_id: v.id, p_booking_date: v.booking_date, p_amount_cents: v.amount_cents,
      p_counterparty_name: w.klantA.name, p_counterparty_iban: 'NL02RABO0123456789', p_description: `Facturen ${f1.number}, ${f2.number} en meerwerk`,
    }, w.medewerker.token), 'bewerken');
    gelijk(nieuw.description, `Facturen ${f1.number}, ${f2.number} en meerwerk`, 'omschrijving');
    const bankregel = gelukt(await inlezen(w, w.medewerker, rekening, [{ booking_date: vandaag(-30), amount_cents: 777, counterparty_name: 'Bakker', description: `Brood ${randomUUID()}` }]), 'afschrift');
    gelijk(bankregel.inserted, 1, 'ingelezen');
    const id = sqlRij(`select id from public.bank_transactions where bank_account_id = ${q(rekening.id)} and amount_cents = 777`).id;
    geweigerd(await rpc('update_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: id, p_booking_date: vandaag(), p_amount_cents: 1, p_counterparty_name: 'X' }, w.medewerker.token), 'bankregel bewerken');
    geweigerd(await rpc('delete_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: id }, w.medewerker.token), 'bankregel verwijderen');
  });

  // ── 2, 3 en 5. Verdelen: twee facturen en een omzetregel, eigen omschrijving ──

  await stap('verdeling die niet op het bedrag uitkomt, of meer dan openstaat, wordt geweigerd zonder iets te boeken', async () => {
    const { f1, f2, omzet } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    let res = await boeken(w, w.medewerker, v.id, [
      { kind: 'sales_invoice', invoice_id: f1.id, amount_cents: FACTUUR },
      { kind: 'sales_invoice', invoice_id: f2.id, amount_cents: FACTUUR },
    ]);
    geweigerd(res, 'te weinig verdeeld');
    verwacht(/tellen op tot/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    res = await boeken(w, w.medewerker, v.id, [
      { kind: 'sales_invoice', invoice_id: f1.id, amount_cents: FACTUUR + 5000 },
      { kind: 'sales_invoice', invoice_id: f2.id, amount_cents: FACTUUR },
    ]);
    geweigerd(res, 'meer dan openstaat');
    verwacht(/hoger dan het openstaande saldo/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    res = await boeken(w, w.medewerker, v.id, [
      { kind: 'sales_invoice', invoice_id: f1.id, amount_cents: FACTUUR },
      { kind: 'sales_invoice', invoice_id: f1.id, amount_cents: FACTUUR },
      { kind: 'ledger', account_id: omzet, vat_code: 'HOOG', amount_cents: 5000 },
    ]);
    geweigerd(res, 'twee keer dezelfde factuur');
    gelijk([transactie(v.id).status !== 'booked', verdeling(v.id).length], [true, 0], 'niets geboekt');
  });

  const geboekt = await stap('verzamelbetaling verdelen over twee facturen en omzet met btw, met een eigen omschrijving', async () => {
    const { f1, f2, omzet } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    const boeking = gelukt(await boeken(w, w.medewerker, v.id, [
      { kind: 'sales_invoice', invoice_id: f1.id, amount_cents: FACTUUR },
      { kind: 'sales_invoice', invoice_id: f2.id, amount_cents: FACTUUR },
      { kind: 'ledger', account_id: omzet, vat_code: 'HOOG', amount_cents: 5000, description: 'Meerwerk zonder factuur' },
    ], 'Verzamelbetaling klant A'), 'boeken');
    const regels = boekingsregels(boeking.id);
    inBalans(regels);
    gelijk(boeking.description, 'Verzamelbetaling klant A', 'eigen omschrijving van de boeking');
    gelijk(boeking.date, v.booking_date, 'boekdatum = datum van de mutatie');
    gelijk(som(regels, '1100', 'debet'), 2 * FACTUUR + 5000, '1100 bank');
    gelijk(som(regels, '1300', 'credit'), 2 * FACTUUR, '1300 debiteuren');
    gelijk(regels.filter((r) => r.code === '1300').map((r) => r.client_id), [w.klantA.id, w.klantA.id], 'klant op de debiteurenregels');
    gelijk([som(regels, '8000', 'credit'), som(regels, '1510', 'credit')], [4132, 868], 'omzet en btw van € 50 inclusief 21%');
    gelijk(regels.find((r) => r.code === '8000')?.description, 'Meerwerk zonder factuur', 'omschrijving van de regel');
    for (const f of [f1, f2]) gelijk([factuur(f.id).status, openCent(w, f.id)], ['paid', 0], `factuur ${f.number} betaald`);
    const rij = transactie(v.id);
    gelijk([rij.status, rij.journal_entry_id, rij.matched_invoice_id], ['booked', boeking.id, null], 'transactie (twee facturen: geen enkele matched_invoice_id)');
    gelijk(verdeling(v.id).map((a) => [a.kind, a.amount_cents]), [['sales_invoice', FACTUUR], ['sales_invoice', FACTUUR], ['ledger', 5000]], 'verdeling');
    // Openstaande posten: geen van beide facturen meer open.
    const posten = sqlRij(`select public.report_open_items(${q(w.orgId)}, current_date) as r`).r;
    verwacht(!posten.receivables.rows.some((r) => [f1.id, f2.id].includes(r.invoice_id)), 'facturen staan nog in de openstaande posten');
    return boeking;
  });

  await stap('terugdraaien zet beide facturen terug op verzonden; opnieuw boeken kan, en de oude verdeling telt niet meer', async () => {
    const { f1, f2, omzet } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    nodig(geboekt, 'boeking');
    gelukt(await rpc('unbook_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: v.id }, w.medewerker.token), 'terugdraaien');
    for (const f of [f1, f2]) gelijk([factuur(f.id).status, openCent(w, f.id)], ['sent', FACTUUR], `factuur ${f.number} weer open`);
    gelijk(transactie(v.id).status, 'unmatched', 'transactie weer open');
    // Verwijderen kan niet meer: er is een (teruggedraaide) boeking die ernaar verwijst.
    geweigerd(await rpc('delete_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: v.id }, w.medewerker.token), 'verwijderen na terugdraaien');
    const opnieuw = gelukt(await boeken(w, w.medewerker, v.id, [
      { kind: 'sales_invoice', invoice_id: f1.id, amount_cents: FACTUUR },
      { kind: 'sales_invoice', invoice_id: f2.id, amount_cents: FACTUUR },
      { kind: 'ledger', account_id: omzet, vat_code: 'HOOG', amount_cents: 5000 },
    ], 'Verzamelbetaling klant A'), 'opnieuw boeken');
    for (const f of [f1, f2]) gelijk([factuur(f.id).status, openCent(w, f.id)], ['paid', 0], `factuur ${f.number} weer betaald`);
    gelijk(verdeling(v.id).length, 6, 'de oude verdeling blijft bewaard naast de nieuwe');
    gelijk(transactie(v.id).journal_entry_id, opnieuw.id, 'nieuwe boeking');
  });

  // ── Naast de bankkoppeling: dezelfde mutatie komt later van de bank ──

  await stap('bank levert dezelfde mutatie: samengevoegd, en een bankregel met automatisch boeken boekt hem niet nog eens', async () => {
    const { rekening, omzet } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    const regel = gelukt(await rest('bank_rules?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, name: 'Alles van klant A', match_direction: 'in', match_counterparty_name_contains: 'Klant A', target_account_id: omzet, target_vat_code: 'HOOG', auto_book: true, is_active: true },
    }), 'bankregel')[0];
    const bankVoor = Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl where jl.account_id = ${q(rekening.ledger_account_id)}`));
    const res = gelukt(await inlezen(w, w.medewerker, rekening, [{
      booking_date: vandaag(), amount_cents: v.amount_cents, counterparty_name: w.klantA.name, counterparty_iban: 'NL02RABO0123456789',
      description: 'OVERBOEKING DIVERSE FACTUREN',
    }]), 'afschrift met dezelfde mutatie');
    gelijk(res.inserted, 1, 'ingelezen');
    const bankrij = sqlRij(`select * from public.bank_transactions where bank_account_id = ${q(rekening.id)} and not is_manual and amount_cents = ${v.amount_cents}`);
    gelijk([bankrij.status, bankrij.merged_into_id, bankrij.journal_entry_id], ['merged', v.id, null], 'bankregel samengevoegd');
    const bankNa = Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl where jl.account_id = ${q(rekening.ledger_account_id)}`));
    gelijk(bankNa, bankVoor, 'geen tweede boeking op 1100');
    gelijk(transactie(v.id).status, 'booked', 'de handmatige mutatie draagt de boeking');
    // Een samengevoegde bankregel boek of negeer je niet los.
    geweigerd(await boeken(w, w.medewerker, bankrij.id, [{ kind: 'ledger', account_id: omzet, amount_cents: v.amount_cents }]), 'samengevoegde bankregel boeken');
    geweigerd(await rpc('set_bank_transaction_status', { p_organization_id: w.orgId, p_transaction_id: bankrij.id, p_status: 'ignored' }, w.medewerker.token), 'samengevoegde bankregel negeren');
    gelukt(await rest(`bank_rules?id=eq.${regel.id}`, { method: 'DELETE', token: w.medewerker.token }), 'bankregel weg');
  });

  await stap('losmaken: de bankregel staat weer open en wordt niet vanzelf opnieuw samengevoegd; met de hand weer samenvoegen kan', async () => {
    const { rekening } = nodig(basis, 'basis');
    const v = nodig(verzamel, 'verzamelbetaling');
    const los = gelukt(await rpc('unmerge_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: v.id }, w.medewerker.token), 'losmaken');
    gelijk([los.status === 'unmatched' || los.status === 'suggested', los.merged_into_id, los.auto_merge_blocked], [true, null, true], 'bankregel los');
    gelukt(await rpc('match_bank_transactions', { p_organization_id: w.orgId, p_bank_account_id: rekening.id }, w.medewerker.token), 'opnieuw matchen');
    verwacht(transactie(los.id).merged_into_id === null, 'de matcher voegde hem toch weer samen');
    const samen = gelukt(await rpc('merge_bank_transactions', { p_organization_id: w.orgId, p_bank_transaction_id: los.id, p_manual_transaction_id: v.id }, w.medewerker.token), 'met de hand samenvoegen');
    gelijk(samen.id, v.id, 'geeft de handmatige mutatie terug');
    gelijk([transactie(los.id).status, transactie(los.id).merged_into_id], ['merged', v.id], 'weer samengevoegd');
    // Bevestigd door de bank: bewerken en negeren kunnen niet meer.
    geweigerd(await rpc('update_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: v.id, p_booking_date: vandaag(), p_amount_cents: 1, p_counterparty_name: 'X' }, w.medewerker.token), 'bevestigde mutatie bewerken');
  });

  await stap('samenvoegen met een ander bedrag, of twee bankregels, wordt geweigerd', async () => {
    const { rekening } = nodig(basis, 'basis');
    const m = gelukt(await invoeren(w, w.medewerker, rekening.id, -4321, { naam: 'Drukkerij', omschrijving: 'Flyers', datum: vandaag(-40) }), 'mutatie');
    const id777 = sqlRij(`select id from public.bank_transactions where bank_account_id = ${q(rekening.id)} and amount_cents = 777`).id;
    const res = await rpc('merge_bank_transactions', { p_organization_id: w.orgId, p_bank_transaction_id: id777, p_manual_transaction_id: m.id }, w.medewerker.token);
    geweigerd(res, 'ander bedrag');
    verwacht(/bedragen verschillen/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await rpc('delete_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: m.id }, w.medewerker.token), 'opruimen');
  });

  // ── 4. Een terugbetaling koppelen aan een creditnota ────────────────

  const terug = await stap('factuur 3 per bank betaald, daarna terugbetaling met creditnota geregistreerd: de klant heeft € 173,63 tegoed', async () => {
    const { rekening, f3 } = nodig(basis, 'basis');
    gelukt(await inlezen(w, w.medewerker, rekening, [{ booking_date: vandaag(-5), amount_cents: FACTUUR, counterparty_name: w.klantA.name, description: `Betaling ${f3.number}` }]), 'ontvangst inlezen');
    const ontvangst = sqlRij(`select * from public.bank_transactions where bank_account_id = ${q(rekening.id)} and amount_cents = ${FACTUUR} and not is_manual`);
    gelijk([ontvangst.status, ontvangst.matched_invoice_id], ['suggested', f3.id], 'voorstel');
    gelukt(await rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: ontvangst.id, p_matched_invoice_id: f3.id }, w.medewerker.token), 'afletteren zoals vroeger');
    gelijk([factuur(f3.id).status, openCent(w, f3.id)], ['paid', 0], 'betaald');
    const uit = gelukt(await wf(w, w.eigenaar, 'createInvoiceRefund', { invoiceId: f3.id, amountCents: FACTUUR, reason: 'Opdracht geannuleerd', kind: 'manual', createCreditNote: true }), 'terugbetaling registreren');
    const cn = nodig(uit.creditNote, 'creditnota');
    const cnRij = sqlRij(`select id, number, status, journal_entry_id from public.credit_notes where id = ${q(cn.id)}`);
    verwacht(cnRij.journal_entry_id, 'creditnota staat niet in het grootboek');
    gelijk(openCent(w, f3.id), -FACTUUR, 'tegoed van de klant op de factuur');
    const kandidaten = sqlRij(`select public.bank_allocation_candidates(${q(w.orgId)}) as k`).k;
    const kandidaat = kandidaten.credit_notes.find((c) => c.id === cnRij.id);
    gelijk([kandidaat?.open_cents, kandidaat?.invoice_id], [FACTUUR, f3.id], 'creditnota staat klaar om terug te betalen');
    return cnRij;
  });

  await stap('de terugbetaling via de bank koppelen aan de creditnota: debet debiteuren, tegoed weg', async () => {
    const { rekening, f3 } = nodig(basis, 'basis');
    const cn = nodig(terug, 'creditnota');
    const m = gelukt(await invoeren(w, w.medewerker, rekening.id, -FACTUUR, { naam: w.klantA.name, omschrijving: `Terugbetaling ${cn.number}` }), 'mutatie invoeren');
    // Een verkoopfactuur op een betaling: weigeren met uitleg.
    let res = await boeken(w, w.medewerker, m.id, [{ kind: 'sales_invoice', invoice_id: f3.id, amount_cents: FACTUUR }]);
    geweigerd(res, 'verkoopfactuur op een betaling');
    verwacht(/creditnota/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    const boeking = gelukt(await boeken(w, w.medewerker, m.id, [{ kind: 'sales_credit_note', credit_note_id: cn.id, amount_cents: FACTUUR }]), 'koppelen aan de creditnota');
    const regels = boekingsregels(boeking.id);
    inBalans(regels);
    gelijk([som(regels, '1300', 'debet'), som(regels, '1100', 'credit')], [FACTUUR, FACTUUR], 'debet 1300, credit 1100');
    gelijk(regels.find((r) => r.code === '1300')?.client_id, w.klantA.id, 'klant op de regel');
    gelijk(openCent(w, f3.id), 0, 'niets meer open of tegoed');
    gelijk(verdeling(m.id).map((a) => [a.kind, a.credit_note_id, a.invoice_id, Number(a.amount_cents)]), [['sales_credit_note', cn.id, f3.id, -FACTUUR]], 'verdeling');
    // Nog eens terugbetalen: er is geen tegoed meer.
    const m2 = gelukt(await invoeren(w, w.medewerker, rekening.id, -1000, { naam: w.klantA.name, omschrijving: 'Nog een terugbetaling', datum: vandaag(-20) }), 'tweede mutatie');
    res = await boeken(w, w.medewerker, m2.id, [{ kind: 'sales_credit_note', credit_note_id: cn.id, amount_cents: 1000 }]);
    geweigerd(res, 'meer terugbetalen dan er tegoed is');
    verwacht(/geen tegoed|hoger dan/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await rpc('delete_manual_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: m2.id }, w.medewerker.token), 'opruimen');
  });

  // ── Inkoop: verzamelbetaling min een creditnota van de leverancier ──

  await stap('één betaling over twee inkoopfacturen min een creditnota van de leverancier', async () => {
    const { rekening, kosten } = nodig(basis, 'basis');
    const leverancier = gelukt(await rest('suppliers?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, name: 'Papier BV', iban: 'NL44RABO0123456788' },
    }), 'leverancier')[0];
    const inkoop = async (nummer, netto) => {
      const btw = Math.round(netto * 0.21);
      const pi = gelukt(await rest('purchase_invoices?select=*', {
        method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
        body: {
          organization_id: w.orgId, created_by: w.medewerker.id, supplier_id: leverancier.id, supplier_invoice_number: nummer,
          date: vandaag(-15), due_date: vandaag(15), subtotal_cents: netto, vat_cents: btw, total_cents: netto + btw, currency: 'EUR', status: 'draft',
          lines: [{ id: randomUUID(), description: 'Papier', amount_cents: netto, vat_code: 'HOOG', vat_rate: 21, account_id: kosten }],
        },
      }), `inkoopfactuur ${nummer}`)[0];
      gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: pi.id }, w.medewerker.token), `${nummer} boeken`);
      return pi;
    };
    const p1 = await inkoop(`INK-${randomUUID().slice(0, 6)}`, 10000);
    const p2 = await inkoop(`INK-${randomUUID().slice(0, 6)}`, 5000);
    const pc = await inkoop(`CRED-${randomUUID().slice(0, 6)}`, -2000);
    gelijk([inkoopOpen(w, p1.id), inkoopOpen(w, p2.id), inkoopOpen(w, pc.id)], [12100, 6050, -2420], 'openstaand voor het betalen');
    const kandidaten = sqlRij(`select public.bank_allocation_candidates(${q(w.orgId)}) as k`).k;
    gelijk(kandidaten.purchase_invoices.filter((p) => [p1.id, p2.id, pc.id].includes(p.id)).map((p) => p.open_cents).sort((a, b) => a - b), [-2420, 6050, 12100], 'kandidaten');
    const m = gelukt(await invoeren(w, w.medewerker, rekening.id, -(12100 + 6050 - 2420), { naam: 'Papier BV', iban: 'NL44RABO0123456788', omschrijving: 'Facturen april min creditnota' }), 'betaling invoeren');
    // Bij een betaling: positief = betaald aan de leverancier, negatief = verrekend.
    const boeking = gelukt(await boeken(w, w.medewerker, m.id, [
      { kind: 'purchase_invoice', purchase_invoice_id: p1.id, amount_cents: 12100 },
      { kind: 'purchase_invoice', purchase_invoice_id: p2.id, amount_cents: 6050 },
      { kind: 'purchase_invoice', purchase_invoice_id: pc.id, amount_cents: -2420 },
    ]), 'boeken');
    const regels = boekingsregels(boeking.id);
    inBalans(regels);
    gelijk([som(regels, '1600', 'debet'), som(regels, '1600', 'credit'), som(regels, '1100', 'credit')], [18150, 2420, 15730], '1600 en 1100');
    gelijk([inkoopOpen(w, p1.id), inkoopOpen(w, p2.id), inkoopOpen(w, pc.id)], [0, 0, 0], 'niets meer open');
    const status = sqlRijen(`select id, payment_status from public.purchase_invoices where id in (${[p1, p2, pc].map((p) => q(p.id)).join(',')})`);
    gelijk(status.map((s) => s.payment_status), ['paid', 'paid', 'paid'], 'betaalstatus (ook de creditnota)');
    // Een betaalde inkoopfactuur boek je niet los tegen: eerst de betaling.
    const res = await rpc('reverse_journal_entry', { p_entry_id: sqlRij(`select journal_entry_id from public.purchase_invoices where id = ${q(p2.id)}`).journal_entry_id }, w.medewerker.token);
    geweigerd(res, 'betaalde inkoopfactuur tegenboeken');
    verwacht(/al een betaling afgeletterd/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    // Terugdraaien: alle drie weer open.
    gelukt(await rpc('unbook_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: m.id }, w.medewerker.token), 'terugdraaien');
    gelijk([inkoopOpen(w, p1.id), inkoopOpen(w, p2.id), inkoopOpen(w, pc.id)], [12100, 6050, -2420], 'weer open');
    const na = sqlRijen(`select payment_status from public.purchase_invoices where id in (${[p1, p2, pc].map((p) => q(p.id)).join(',')})`);
    gelijk(na.map((s) => s.payment_status), ['unpaid', 'unpaid', 'unpaid'], 'betaalstatus terug');
  });

  // ── 2. Verdelen over grootboekrekeningen, met een negatieve regel ───

  await stap('een uitbetaling verdelen: omzet min kosten (een negatieve regel), btw per regel', async () => {
    const { rekening, omzet, kosten } = nodig(basis, 'basis');
    const m = gelukt(await invoeren(w, w.medewerker, rekening.id, 9500, { naam: 'Betaalprovider', omschrijving: 'Uitbetaling week 12' }), 'uitbetaling invoeren');
    const boeking = gelukt(await boeken(w, w.medewerker, m.id, [
      { kind: 'ledger', account_id: omzet, vat_code: 'HOOG', amount_cents: 12100, description: 'Verkopen webshop' },
      { kind: 'ledger', account_id: kosten, vat_code: 'HOOG', amount_cents: -2600, description: 'Transactiekosten' },
    ]), 'boeken');
    const regels = boekingsregels(boeking.id);
    inBalans(regels);
    gelijk([som(regels, '1100', 'debet'), som(regels, '8000', 'credit'), som(regels, '1510', 'credit')], [9500, 10000, 2100], 'bank, omzet en btw');
    gelijk([som(regels, '4500', 'debet'), som(regels, '1500', 'debet')], [2149, 451], 'kosten en voorbelasting van de negatieve regel');
  });

  // ── Rechten ─────────────────────────────────────────────────────────

  await stap('rechten: lezer ziet de kandidaten en de verdeling, maar boekt niets; zonder Financiën ziet niemand iets; een andere organisatie komt er niet bij', async () => {
    const v = nodig(verzamel, 'verzamelbetaling');
    gelukt(await rpc('bank_allocation_candidates', { p_organization_id: w.orgId }, w.lezer.token), 'kandidaten als lezer');
    const zicht = gelukt(await rest(`bank_transaction_allocations?select=id&bank_transaction_id=eq.${v.id}`, { token: w.lezer.token }), 'verdeling als lezer');
    verwacht(zicht.length > 0, 'de lezer ziet de verdeling niet');
    geweigerd(await rpc('bank_allocation_candidates', { p_organization_id: w.orgId }, w.zonderFinancien.token), 'kandidaten zonder Financiën');
    const geen = gelukt(await rest(`bank_transaction_allocations?select=id&bank_transaction_id=eq.${v.id}`, { token: w.zonderFinancien.token }), 'verdeling zonder Financiën');
    gelijk(geen.length, 0, 'zonder Financiën: geen rijen');
    const vreemd = gelukt(await rest(`bank_transaction_allocations?select=id&bank_transaction_id=eq.${v.id}`, { token: ander.eigenaar.token }), 'verdeling van een andere organisatie');
    gelijk(vreemd.length, 0, 'andere organisatie: geen rijen');
    geweigerd(await rpc('bank_allocation_candidates', { p_organization_id: w.orgId }, ander.eigenaar.token), 'kandidaten van een andere organisatie');
    geweigerd(await rpc('unbook_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: v.id }, w.lezer.token), 'terugdraaien als lezer');
    geweigerd(await rpc('unbook_bank_transaction', { p_organization_id: ander.orgId, p_transaction_id: v.id }, ander.eigenaar.token), 'terugdraaien via de eigen organisatie van een ander');
    // Rechtstreeks in de verdeling schrijven kan niemand.
    const poging = await rest('bank_transaction_allocations', {
      method: 'POST', token: w.eigenaar.token,
      body: { organization_id: w.orgId, bank_transaction_id: v.id, journal_entry_id: transactie(v.id).journal_entry_id, kind: 'ledger', account_id: nodig(basis, 'basis').omzet, amount_cents: 1 },
    });
    verwacht(poging.status >= 400, `rechtstreeks schrijven in de verdeling lukte: ${poging.status}`);
  });

  // ── De aansluiting met een afschrift ────────────────────────────────

  await stap('aansluiting: een samengevoegd paar telt één keer, een onbevestigde handmatige boeking verklaart het verschil', async () => {
    const { omzet, kosten } = nodig(basis, 'basis');
    const grootboek = gelukt(await rest('ledger_accounts?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, code: '1105', name: 'Spaarrekening', type: 'asset', subtype: 'bank', report_group: 'liquide_middelen', is_active: true },
    }), 'grootboekrekening 1105')[0];
    const spaar = await bankrekening(w, 'Spaarrekening', grootboek.id, 'NL13INGB0009876543');
    const m1 = gelukt(await invoeren(w, w.medewerker, spaar.id, 10000, { naam: 'Inleg', datum: vandaag(-6) }), 'inleg invoeren');
    gelukt(await boeken(w, w.medewerker, m1.id, [{ kind: 'ledger', account_id: omzet, amount_cents: 10000 }]), 'inleg boeken');
    const afschrift = { format: 'camt053', file_name: `spaar-${randomUUID()}.xml`, period_start: vandaag(-10), period_end: vandaag(-1), opening_balance_cents: 0, closing_balance_cents: 10000 };
    gelukt(await inlezen(w, w.medewerker, spaar, [{ booking_date: vandaag(-4), amount_cents: 10000, counterparty_name: 'Inleg', description: 'Storting' }], afschrift), 'afschrift');
    gelijk(sqlRij(`select status from public.bank_transactions where bank_account_id = ${q(spaar.id)} and not is_manual`).status, 'merged', 'samengevoegd');
    let r = aansluiting(w, spaar);
    gelijk([r.difference_cents, r.unbooked_count, r.manual_unconfirmed_count, r.timing_count], [0, 0, 0, 0], 'sluit aan');
    gelijk(r.statement_issues.length, 0, 'het afschrift klopt met zichzelf');
    const m2 = gelukt(await invoeren(w, w.medewerker, spaar.id, -2000, { naam: 'Kosten', datum: vandaag(-3) }), 'kosten invoeren');
    // Een betaling van € 20: positief is mee met het geld, dus 2000 op de kostenrekening.
    gelukt(await boeken(w, w.medewerker, m2.id, [{ kind: 'ledger', account_id: kosten, amount_cents: 2000 }]), 'kosten boeken');
    r = aansluiting(w, spaar);
    gelijk([r.difference_cents, r.manual_unconfirmed_count, r.manual_unconfirmed_sum_cents], [2000, 1, -2000], 'onbevestigde handmatige boeking verklaart het verschil');
  });
}
