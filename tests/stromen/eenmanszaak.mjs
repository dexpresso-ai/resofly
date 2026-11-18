// Eenmanszaak: een heel boekjaar, van inrichting tot kapitaalvergelijking.
//
// Waarom dit scenario: de losse onderdelen (facturen, bank, btw, activa,
// jaarafsluiting) hebben elk hun eigen toets, maar een zzp'er doet ze allemaal
// na elkaar, in één administratie, en verwacht aan het eind cijfers die op
// elkaar aansluiten: de btw-aangifte op het grootboek, de balans op nul, en
// het eigen vermogen dat hij in zijn aangifte inkomstenbelasting invult.
// Zie docs/changelog/CHANGELOG_EENMANSZAAK_CONTROLE_2026-11-18.md.
//
// Het jaar is 2025 (dat kan dicht), met 2026 als lopend jaar erachter.
// Alles gaat zoals in de app: als de eigenaar, via REST en RPC met zijn eigen
// sessie (RLS geldt), en facturen via invoice-workflow.
import { randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
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

/**
 * Een eenmanszaak zoals de inrichting hem achterlaat (OrganizationSetup):
 * bedrijfsgegevens, webadres, afronden. Het afronden zet sinds 18 november
 * ook het rekeningschema en de boekjaren klaar.
 */
async function maakEenmanszaak(naam, { resultaatrekening = '0500', start = '2025-01-01', kor = false, rechtsvorm = 'eenmanszaak' } = {}) {
  const eigenaar = await maakGebruiker(`${naam}-eigenaar`);
  const orgNaam = uniek(`Eenmanszaak ${naam}`);
  const org = gelukt(await rpc('create_organization', { p_name: orgNaam }, eigenaar.token), 'create_organization');
  const orgId = (Array.isArray(org) ? org[0] : org).id;
  const velden = {
    organization_id: orgId, created_by: eigenaar.id, legal_form: rechtsvorm,
    company_name: 'Fotografie Van Dijk', address_line1: 'Lange Nieuwstraat 12', postal_code: '3512 PH', city: 'Utrecht',
    country: 'Nederland', email: `info@${naam}.zzp.test`, kvk_number: '87654321', vat_number: 'NL004495445B01',
    iban: 'NL91 ABNA 0417 1643 00', invoice_payment_terms: 'Betaling binnen 14 dagen.', kor_enabled: kor,
    vat_return_period: 'quarterly', fiscal_year_start_month: 1, bookkeeping_start_date: start,
  };
  // Een administratie van vóór de inrichtingsstappen heeft de kolomstandaard
  // (0510); de stappen zetten bij een eenmanszaak 0500.
  if (resultaatrekening) velden.year_result_account_code = resultaatrekening;
  gelukt(await rest('company_settings?on_conflict=organization_id', {
    method: 'POST', token: eigenaar.token, prefer: 'resolution=merge-duplicates,return=representation', body: velden,
  }), 'bedrijfsgegevens');
  gelukt(await rpc('client_subdomain_claim', { p_organization_id: orgId, p_name: webadresNaam(naam) }, eigenaar.token), 'webadres');
  gelukt(await rpc('complete_organization_onboarding', { p_organization_id: orgId, p_display_name: orgNaam }, eigenaar.token), 'inrichting afronden');
  return { naam, orgId, eigenaar };
}

function wf(w, action, extra = {}) {
  return roep('invoice-workflow', { token: w.eigenaar.token, body: { action, organizationId: w.orgId, ...extra } });
}

async function rekening(w, code) {
  const rij = gelukt(await rest(`ledger_accounts?select=id,code,name,type,subtype,report_group&organization_id=eq.${w.orgId}&code=eq.${code}`, { token: w.eigenaar.token }), `rekening ${code}`)[0];
  return nodig(rij, `grootboekrekening ${code}`);
}

async function klant(w, naam, soort) {
  return gelukt(await rest('clients?select=id,name,email', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, name: naam, email: `${randomUUID().slice(0, 8)}@klant.test`, contact_name: naam,
      address_line1: 'Dorpsstraat 2', postal_code: '1234 AB', city: 'Utrecht', country: 'Nederland', client_kind: soort,
      vat_number: soort === 'business' ? 'NL009876543B01' : null,
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

/** Een factuur zoals het formulier hem opslaat, en versturen (boekt hem ook). */
async function verstuurdeFactuur(w, klantRij, datum, regels) {
  const concept = await conceptFactuur(w, klantRij, datum, regels);
  gelukt(await wf(w, 'sendInvoiceEmail', {
    invoiceId: concept.id, recipientEmail: klantRij.email, recipientName: klantRij.name, includePaymentLink: false,
  }), 'factuur versturen');
  const rij = sqlRij(`select id, number, status, journal_entry_id, total_amount, lines from public.invoices where id = ${q(concept.id)}`);
  verwacht(rij.journal_entry_id, 'de factuur staat niet in het grootboek');
  return rij;
}

async function leverancier(w, naam) {
  return gelukt(await rest('suppliers?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: w.eigenaar.id, name: naam, iban: 'NL44RABO0123456788' },
  }), 'leverancier')[0];
}

async function inkoopfactuur(w, lev, datum, regels) {
  const netto = regels.reduce((s, r) => s + r.amount_cents, 0);
  const btw = regels.reduce((s, r) => s + Math.round(r.amount_cents * (r.vat_rate ?? 0) / 100), 0);
  const pi = gelukt(await rest('purchase_invoices?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, supplier_id: lev.id, supplier_invoice_number: `INK-${randomUUID().slice(0, 6)}`,
      date: datum, due_date: datum, subtotal_cents: netto, vat_cents: btw, total_cents: netto + btw, currency: 'EUR', status: 'draft',
      lines: regels.map((r) => ({ id: randomUUID(), ...r })),
    },
  }), 'inkoopfactuur opslaan')[0];
  gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: pi.id }, w.eigenaar.token), 'inkoopfactuur boeken');
  return sqlRij(`select id, journal_entry_id, total_cents from public.purchase_invoices where id = ${q(pi.id)}`);
}

async function bankrekening(w) {
  const bankGb = await rekening(w, '1100');
  return gelukt(await rest('bank_accounts?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: w.eigenaar.id, name: 'Zakelijke rekening', iban: 'NL91ABNA0417164300', currency: 'EUR', ledger_account_id: bankGb.id, is_active: true, source: 'import' },
  }), 'bankrekening')[0];
}

/** Een mutatie invoeren; de verdeling gaat in de richting van het geld (bedragen positief). */
async function invoeren(w, bank, datum, bedrag, omschrijving) {
  const txn = gelukt(await rpc('create_manual_bank_transaction', {
    p_organization_id: w.orgId, p_bank_account_id: bank.id, p_booking_date: datum, p_amount_cents: bedrag,
    p_counterparty_name: omschrijving, p_counterparty_iban: null, p_description: omschrijving, p_allow_duplicate: true,
  }, w.eigenaar.token), `bankmutatie ${omschrijving}`);
  return (Array.isArray(txn) ? txn[0] : txn).id;
}

function boekMutatie(w, txnId, verdeling) {
  return rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: txnId, p_allocations: verdeling }, w.eigenaar.token);
}

async function bankmutatie(w, bank, datum, bedrag, omschrijving, verdeling) {
  const id = await invoeren(w, bank, datum, bedrag, omschrijving);
  const res = gelukt(await boekMutatie(w, id, verdeling), `boeken ${omschrijving}`);
  return { id, boeking: Array.isArray(res) ? res[0] : res };
}

function boekingsregels(entryId) {
  return sqlRijen(`select la.code, jl.debit_cents as debet, jl.credit_cents as credit, jl.vat_code, jl.vat_base_cents as grondslag, jl.vat_amount_cents as btw
    from public.journal_lines jl join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = ${q(entryId)} order by jl.line_index`);
}

function saldo(w, code, totEnMet) {
  return Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and je.status = 'posted' and la.code = ${q(code)} and je.date <= ${q(totEnMet)}`));
}

/** Het bedrag op een W&V-rekening over een periode, zonder de jaarafsluiting (zoals Winst & verlies het toont). */
function wv(w, code, van, tot) {
  const rij = sqlRijen(`select * from public.report_profit_and_loss(${q(w.orgId)}, ${q(van)}, ${q(tot)})`).find((r) => r.code === code);
  return Number(rij?.amount_cents ?? 0);
}

function balansTotalen(w, peildatum) {
  const rijen = sqlRijen(`select * from public.report_balance_sheet(${q(w.orgId)}, ${q(peildatum)})`);
  const activa = rijen.filter((r) => r.section === 'asset').reduce((s, r) => s + Number(r.amount_cents), 0);
  const passiva = rijen.filter((r) => r.section !== 'asset').reduce((s, r) => s + Number(r.amount_cents), 0);
  return { activa, passiva, rijen };
}

async function overzicht(w, jaar) {
  return gelukt(await rpc('owners_equity_overview', { p_organization_id: w.orgId, p_fiscal_year_id: jaar.id }, w.eigenaar.token), `eigen vermogen ${jaar.label}`);
}

async function kapitaal(w, jaar) {
  const res = await overzicht(w, jaar);
  const o = res.owners[0];
  return { begin: o.beginCents, resultaat: o.resultShareCents, stortingen: o.contributionsCents, opnamen: o.withdrawalsCents, overig: o.otherMovementsCents, eind: o.endCents, status: res.fiscalYear.status, open: res.openPriorResultCents, openJaren: res.openPriorYears };
}

function kwartaal(jaar, nummer) {
  const van = `${jaar}-${String((nummer - 1) * 3 + 1).padStart(2, '0')}-01`;
  const tot = new Date(Date.UTC(jaar, nummer * 3, 0)).toISOString().slice(0, 10);
  return { van, tot };
}

function sluitKwartaal(w, jaar, nummer) {
  const { van, tot } = kwartaal(jaar, nummer);
  return rpc('finalize_vat_return', {
    p_organization_id: w.orgId, p_period_type: 'quarter', p_year: jaar, p_period_index: nummer, p_from: van, p_to: tot,
  }, w.eigenaar.token);
}

async function btwAangifte(w, jaar, nummer) {
  const { van, tot } = kwartaal(jaar, nummer);
  const vakken = gelukt(await rpc('compute_vat_return', { p_organization_id: w.orgId, p_from: van, p_to: tot }, w.eigenaar.token), `btw Q${nummer} ${jaar} berekenen`);
  gelukt(await sluitKwartaal(w, jaar, nummer), `btw Q${nummer} ${jaar} afsluiten`);
  return Array.isArray(vakken) ? vakken[0] : vakken;
}

async function boekjaren(w) {
  return sqlRijen(`select id, label, period_start, period_end, status from public.fiscal_years where organization_id = ${q(w.orgId)} order by period_start`);
}

async function maakActivum(w, velden) {
  const afschrijving = await rekening(w, '4000');
  const cumulatief = await rekening(w, '0150');
  const activa = await rekening(w, '0100');
  const rij = gelukt(await rest('fixed_assets?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, category: 'inventaris', residual_value_cents: 0,
      useful_life_months: 60, method: 'straight_line', asset_account_id: activa.id, depreciation_account_id: afschrijving.id,
      accumulated_depreciation_account_id: cumulatief.id, ...velden,
    },
  }), 'activum')[0];
  gelukt(await rpc('generate_depreciation_schedule', { p_organization_id: w.orgId, p_asset_id: rij.id }, w.eigenaar.token), 'afschrijvingsschema');
  return rij;
}

// ── 1. Het jaar ─────────────────────────────────────────────────────────

async function hetJaar() {
  groep('Eenmanszaak — een heel boekjaar');
  const w = await stap('een eenmanszaak zoals de inrichting hem achterlaat (boekhouding vanaf 1 januari 2025)', () => maakEenmanszaak('zzp'));
  if (!w) return;
  const t = {};

  await stap('na de inrichting staat de boekhouding klaar: rekeningschema, en boekjaren 2025 en 2026', async () => {
    gelijk((await rekening(w, '0500')).name, 'Eigen vermogen', '0500');
    gelijk([(await rekening(w, '0550')).subtype, (await rekening(w, '0560')).subtype], ['private_withdrawals', 'private_contributions'], 'privérekeningen');
    const kosten = await rest(`ledger_accounts?select=code,subtype,report_group&organization_id=eq.${w.orgId}&type=eq.expense&order=code`, { token: w.eigenaar.token });
    const codes = kosten.json.map((r) => r.code);
    for (const code of ['4100', '4200', '4300', '4400', '4500', '4600', '4700', '7000']) verwacht(codes.includes(code), `kostenrekening ${code} ontbreekt: ${codes.join(', ')}`);
    gelijk(kosten.json.find((r) => r.code === '4600').subtype, 'mixed_costs', '4600 is beperkt aftrekbaar');
    gelijk(kosten.json.find((r) => r.code === '7000').report_group, 'inkoopwaarde', '7000 in de inkoopwaarde');
    gelijk((await rekening(w, '1000')).name, 'Kas', 'kasrekening');
    const jaren = await boekjaren(w);
    gelijk(jaren.map((j) => [j.label, j.period_start, j.period_end, j.status]), [['2025', '2025-01-01', '2025-12-31', 'open'], ['2026', '2026-01-01', '2026-12-31', 'open']], 'boekjaren');
    [t.j2025, t.j2026] = jaren;
    t.bankGb = await rekening(w, '1100');
    t.kosten = await rekening(w, '4500');
    t.activa = await rekening(w, '0100');
    t.opnamen = await rekening(w, '0550');
    t.stortingen = await rekening(w, '0560');
  });

  await stap('nog eens boekjaren openen via de knop doet niets: er zijn er al', async () => {
    const res = gelukt(await rpc('open_initial_fiscal_years', { p_organization_id: w.orgId }, w.eigenaar.token), 'boekjaren openen');
    gelijk(res, [], 'geen nieuwe boekjaren');
  });

  await stap('beginbalans 1 januari 2025: € 2.000 op de bank, het verschil op 0500 Eigen vermogen', async () => {
    const plug = sqlRij(`select code from public.opening_balance_plug_account(${q(w.orgId)})`);
    gelijk(plug?.code, '0500', 'sluitpost van de beginbalans');
    gelukt(await rpc('create_opening_balance', {
      p_organization_id: w.orgId, p_as_of_date: '2025-01-01',
      p_lines: [{ account_id: nodig(t.bankGb, 'bank').id, description: 'Beginbalans Bank', debit_cents: 200000, credit_cents: 0 }],
    }, w.eigenaar.token), 'beginbalans');
    gelijk(saldo(w, '0500', '2025-01-01'), -200000, '0500 na de beginbalans');
  });

  await stap('een bankrekening op 1100', async () => { t.bank = await bankrekening(w); });

  await stap('twee facturen: een bedrijf (€ 1.000 + 21%) en een particulier (€ 300 inclusief btw)', async () => {
    const zakelijk = await klant(w, 'Bureau Noord BV', 'business');
    const particulier = await klant(w, 'Familie Jansen', 'consumer');
    t.f1 = await verstuurdeFactuur(w, zakelijk, '2025-02-10', [{ description: 'Bedrijfsportretten', quantity: 1, unit_price: 1000, vat: 21 }]);
    t.f2 = await verstuurdeFactuur(w, particulier, '2025-05-20', [{ description: 'Familieshoot', quantity: 1, unit_price: 247.93, vat: 21 }]);
    gelijk([Number(t.f1.total_amount), Number(t.f2.total_amount)], [1210, 300], 'factuurtotalen');
  });

  await stap('inkoop: een abonnement op de kosten, met 21% voorbelasting', async () => {
    t.leverancier = await leverancier(w, 'Software BV');
    t.abonnement = await inkoopfactuur(w, t.leverancier, '2025-02-15', [{ description: 'Fotobewerking', amount_cents: 6000, vat_code: 'HOOG', vat_rate: 21, account_id: nodig(t.kosten, 'kosten').id }]);
    gelijk(Number(t.abonnement.total_cents), 7260, 'totaal inkoopfactuur');
  });

  await stap('een camera via een inkoopfactuur op 0100 Vaste activa (€ 2.000 + 21%)', async () => {
    t.cameraFactuur = await inkoopfactuur(w, nodig(t.leverancier, 'leverancier'), '2025-04-01', [{ description: 'Camera', amount_cents: 200000, vat_code: 'HOOG', vat_rate: 21, account_id: nodig(t.activa, 'activa').id }]);
    gelijk(saldo(w, '0100', '2025-04-01'), 200000, '0100 na de inkoopfactuur');
  });

  await stap('de camera in het register: zonder koppeling geen afschrijving', async () => {
    t.camera = await maakActivum(w, {
      name: 'Camera', acquisition_date: '2025-04-01', start_date: '2025-04-01', acquisition_cost_cents: 200000,
      source_purchase_invoice_id: nodig(t.cameraFactuur, 'camerafactuur').id,
    });
    const res = await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: t.camera.id, p_through_date: '2025-12-31' }, w.eigenaar.token);
    geweigerd(res, 'afschrijven zonder aanschaf');
  });

  await stap('koppelen aan de inkoopfactuur: geen tweede boeking, en daarna afschrijven', async () => {
    const camera = nodig(t.camera, 'camera');
    const boekstukkenVoor = Number(sql(`select count(*) from public.journal_entries where organization_id = ${q(w.orgId)}`));
    const res = gelukt(await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: camera.id, p_credit_account_id: null }, w.eigenaar.token), 'koppelen');
    const rij = Array.isArray(res) ? res[0] : res;
    gelijk(rij.acquisition_journal_entry_id, t.cameraFactuur.journal_entry_id, 'de aanschaf is het boekstuk van de inkoopfactuur');
    gelijk(Number(sql(`select count(*) from public.journal_entries where organization_id = ${q(w.orgId)}`)), boekstukkenVoor, 'geen nieuw boekstuk');
    gelijk(saldo(w, '0100', '2025-12-31'), 200000, '0100 staat er één keer');
    gelukt(await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: camera.id, p_through_date: '2025-12-31' }, w.eigenaar.token), 'afschrijven t/m 31-12-2025');
    // € 2.000 over 60 maanden: de 20 restcenten gaan naar de eerste maanden
    // (20 × € 33,34 en 40 × € 33,33), dus 9 × € 33,34 in 2025.
    gelijk(saldo(w, '4000', '2025-12-31'), 30006, 'afschrijving 2025 (9 maanden)');
  });

  await stap('bank: betalingen, en geld voor jezelf (0550) en uit eigen zak (0560)', async () => {
    const bank = nodig(t.bank, 'bankrekening');
    await bankmutatie(w, bank, '2025-03-01', 121000, 'Bureau Noord BV', [{ kind: 'sales_invoice', invoice_id: nodig(t.f1, 'factuur 1').id, amount_cents: 121000 }]);
    await bankmutatie(w, bank, '2025-03-02', -7260, 'Software BV', [{ kind: 'purchase_invoice', purchase_invoice_id: nodig(t.abonnement, 'abonnement').id, amount_cents: 7260 }]);
    await bankmutatie(w, bank, '2025-04-03', -242000, 'Camera', [{ kind: 'purchase_invoice', purchase_invoice_id: nodig(t.cameraFactuur, 'camera').id, amount_cents: 242000 }]);
    await bankmutatie(w, bank, '2025-03-31', -50000, 'Naar privérekening', [{ kind: 'ledger', account_id: nodig(t.opnamen, '0550').id, amount_cents: 50000 }]);
    await bankmutatie(w, bank, '2025-06-15', 30000, 'Familie Jansen', [{ kind: 'sales_invoice', invoice_id: nodig(t.f2, 'factuur 2').id, amount_cents: 30000 }]);
    await bankmutatie(w, bank, '2025-07-01', 300000, 'Van privé', [{ kind: 'ledger', account_id: nodig(t.stortingen, '0560').id, amount_cents: 300000 }]);
    gelijk(saldo(w, '1100', '2025-12-31'), 200000 + 121000 - 7260 - 242000 - 50000 + 30000 + 300000, 'bank eind 2025');
    gelijk([saldo(w, '1300', '2025-12-31'), saldo(w, '1600', '2025-12-31')], [0, 0, ], 'debiteuren en crediteuren');
  });

  await stap('privé met btw-code wordt geweigerd: geen voorbelasting op privé-uitgaven', async () => {
    const id = await invoeren(w, nodig(t.bank, 'bank'), '2025-08-01', -12100, 'Supermarkt');
    const res = await boekMutatie(w, id, [{ kind: 'ledger', account_id: nodig(t.opnamen, '0550').id, vat_code: 'HOOG', amount_cents: 12100 }]);
    geweigerd(res, 'privé met HOOG');
    verwacht(/eigen vermogen/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await boekMutatie(w, id, [{ kind: 'ledger', account_id: t.opnamen.id, amount_cents: 12100 }]), 'privé zonder btw');
  });

  await stap('btw-aangifte Q1: 1a € 1.000 / € 210, voorbelasting € 12,60, te betalen € 197', async () => {
    const r = await btwAangifte(w, 2025, 1);
    gelijk([r.form['1a'].base, r.form['1a'].vat, r.form['5b'], r.form['5c']], [1000, 210, 13, 197], 'rubrieken Q1 (hele euro\'s)');
  });

  await stap('btw-aangifte Q2 (camera: terug) t/m Q4', async () => {
    const r = await btwAangifte(w, 2025, 2);
    gelijk([r.form['1a'].base, r.form['1a'].vat, r.form['5b'], r.form['5c']], [248, 52, 420, -368], 'rubrieken Q2');
    await btwAangifte(w, 2025, 3);
    await btwAangifte(w, 2025, 4);
  });

  await stap('winst 2025: € 1.000 + € 247,93 − € 60 − € 300,06 afschrijving = € 887,87, plus de afronding van de aangiften', async () => {
    // De aangifte gaat in hele euro's. Het verschil met het grootboek komt
    // bij het afsluiten van elk kwartaal op 4900.
    t.afronding = -saldo(w, '4900', '2025-12-31');
    verwacht(t.afronding >= 0 && t.afronding <= 400, `afronding van vier aangiften: ${t.afronding} cent`);
    t.winst = 88787 + t.afronding;
    const rijen = sqlRijen(`select * from public.report_profit_and_loss(${q(w.orgId)}, '2025-01-01', '2025-12-31')`);
    const opbrengst = rijen.filter((r) => r.account_type === 'revenue').reduce((s, r) => s + Number(r.amount_cents), 0);
    const kosten = rijen.filter((r) => r.account_type === 'expense').reduce((s, r) => s + Number(r.amount_cents), 0);
    gelijk(opbrengst - kosten, t.winst, 'resultaat 2025');
  });

  await stap('balans 31-12-2025 sluit, met het lopende resultaat in het eigen vermogen', async () => {
    const b = balansTotalen(w, '2025-12-31');
    gelijk(b.activa, b.passiva, 'activa = passiva');
  });

  await stap('eigen vermogen 2025 vóór afsluiten: begin € 2.000 + winst + storting € 3.000 − opnamen € 621', async () => {
    const k = await kapitaal(w, nodig(t.j2025, 'boekjaar 2025'));
    const winst = nodig(t.winst, 'winst 2025');
    gelijk([k.begin, k.resultaat, k.stortingen, k.opnamen, k.eind], [200000, winst, 300000, 62100, 437900 + winst], 'kapitaalvergelijking 2025 (voorlopig)');
    gelijk([k.open, k.openJaren], [0, []], 'geen open vorig jaar');
  });

  await stap('eigen vermogen 2026 terwijl 2025 nog open is: het begin is het eind van 2025, met een melding', async () => {
    const k = await kapitaal(w, nodig(t.j2026, 'boekjaar 2026'));
    const winst = nodig(t.winst, 'winst 2025');
    gelijk(k.begin, 437900 + winst, 'beginvermogen 2026 met 2025 nog open');
    gelijk([k.open, k.openJaren], [winst, ['2025']], 'de winst van 2025 staat nog open');
    const b = balansTotalen(w, '2026-12-31');
    const eigenVermogen = b.rijen.filter((r) => r.report_group === 'eigen_vermogen').reduce((s, r) => s + Number(r.amount_cents), 0);
    gelijk(k.eind, eigenVermogen, 'eindvermogen = eigen vermogen op de balans');
  });

  await stap('jaarafsluiting 2025: winst en privé naar 0500', async () => {
    gelukt(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, w.eigenaar.token), 'afsluiten');
    gelijk([saldo(w, '0550', '2025-12-31'), saldo(w, '0560', '2025-12-31'), saldo(w, '0510', '2025-12-31')], [0, 0, 0], 'privé en 0510 na afsluiten');
    gelijk(saldo(w, '0500', '2025-12-31'), -(437900 + nodig(t.winst, 'winst 2025')), '0500 na afsluiten');
    const b = balansTotalen(w, '2025-12-31');
    gelijk(b.activa, b.passiva, 'balans na afsluiten');
  });

  await stap('eigen vermogen 2025 na afsluiten: dezelfde cijfers, nu definitief', async () => {
    const k = await kapitaal(w, nodig(t.j2025, 'boekjaar 2025'));
    const winst = nodig(t.winst, 'winst 2025');
    gelijk([k.begin, k.resultaat, k.stortingen, k.opnamen, k.eind, k.status], [200000, winst, 300000, 62100, 437900 + winst, 'closed'], 'kapitaalvergelijking 2025');
  });

  await stap('2026: een factuur en een opname; het begin is het eind van 2025, zonder melding', async () => {
    const zakelijk = await klant(w, 'Bureau Zuid BV', 'business');
    await verstuurdeFactuur(w, zakelijk, '2026-01-15', [{ description: 'Productfoto\'s', quantity: 1, unit_price: 500, vat: 21 }]);
    await bankmutatie(w, nodig(t.bank, 'bank'), '2026-02-01', -20000, 'Naar privérekening', [{ kind: 'ledger', account_id: nodig(t.opnamen, '0550').id, amount_cents: 20000 }]);
    const k = await kapitaal(w, nodig(t.j2026, 'boekjaar 2026'));
    const begin = 437900 + nodig(t.winst, 'winst 2025');
    gelijk([k.begin, k.resultaat, k.opnamen, k.eind, k.open], [begin, 50000, 20000, begin + 50000 - 20000, 0], 'kapitaalvergelijking 2026');
  });

}

// ── 2. De KOR ───────────────────────────────────────────────────────────

async function deKor() {
  groep('Eenmanszaak met de kleineondernemersregeling');
  const w = await stap('een eenmanszaak met de KOR', () => maakEenmanszaak('kor', { kor: true, start: '2026-01-01' }));
  if (!w) return;
  const t = {};

  await stap('een factuur met 0% zonder code krijgt de code KOR, en de omzet telt in geen rubriek', async () => {
    t.bank = await bankrekening(w);
    const particulier = await klant(w, 'Familie De Boer', 'consumer');
    const concept = await conceptFactuur(w, particulier, '2026-02-10', [{ description: 'Portretshoot', quantity: 1, unit_price: 450, vat: 0 }]);
    gelijk(concept.lines.map((l) => l.vat_code), ['KOR'], 'code in het concept');
    gelukt(await wf(w, 'sendInvoiceEmail', { invoiceId: concept.id, recipientEmail: particulier.email, recipientName: particulier.name, includePaymentLink: false }), 'versturen');
    const vakken = gelukt(await rpc('compute_vat_return', { p_organization_id: w.orgId, p_from: '2026-01-01', p_to: '2026-03-31' }, w.eigenaar.token), 'btw Q1');
    const r = Array.isArray(vakken) ? vakken[0] : vakken;
    gelijk([r.form['1a'].base, r.form['1e'].base], [0, 0], 'KOR-omzet niet in 1a of 1e');
  });

  await stap('een betaling van € 121 op 4500 met HOOG: met de KOR geen voorbelasting, € 121 kosten', async () => {
    const { boeking } = await bankmutatie(w, nodig(t.bank, 'bank'), '2026-02-12', -12100, 'Printer', [{ kind: 'ledger', account_id: (await rekening(w, '4500')).id, vat_code: 'HOOG', amount_cents: 12100 }]);
    const regels = boekingsregels(boeking.id);
    gelijk(regels.filter((r) => r.code !== '1100').map((r) => [r.code, Number(r.debet), Number(r.credit), r.vat_code, Number(r.btw)]), [['4500', 12100, 0, 'KOR', 0]], 'kostenregel');
  });

  await stap('een ontvangst op 8000 met HOOG: met de KOR geen af te dragen btw', async () => {
    const { boeking } = await bankmutatie(w, nodig(t.bank, 'bank'), '2026-02-13', 12100, 'Contante verkoop', [{ kind: 'ledger', account_id: (await rekening(w, '8000')).id, vat_code: 'HOOG', amount_cents: 12100 }]);
    const regels = boekingsregels(boeking.id);
    gelijk(regels.filter((r) => r.code !== '1100').map((r) => [r.code, Number(r.debet), Number(r.credit), r.vat_code]), [['8000', 0, 12100, 'KOR']], 'omzetregel');
  });

  await stap('Google Ads uit Ierland (€ 100, verlegd): met de KOR wel aangeven in 4b, niet aftrekken', async () => {
    const { boeking } = await bankmutatie(w, nodig(t.bank, 'bank'), '2026-02-14', -10000, 'Google Ireland', [{ kind: 'ledger', account_id: (await rekening(w, '4400')).id, vat_code: 'EU_VERW', amount_cents: 10000 }]);
    const regels = boekingsregels(boeking.id);
    const kosten = regels.find((r) => r.code === '4400');
    const verlegd = regels.find((r) => r.code === '1520');
    gelijk([Number(kosten?.debet), Number(kosten?.grondslag), Number(kosten?.btw), kosten?.vat_code], [12100, 10000, 2100, 'EU_VERW'], 'kosten inclusief de verlegde btw');
    gelijk(Number(verlegd?.credit), 2100, '1520 te betalen');
    verwacht(!regels.some((r) => r.code === '1500'), 'geen voorbelasting met de KOR');
    const vakken = gelukt(await rpc('compute_vat_return', { p_organization_id: w.orgId, p_from: '2026-01-01', p_to: '2026-03-31' }, w.eigenaar.token), 'btw Q1');
    const r = Array.isArray(vakken) ? vakken[0] : vakken;
    gelijk([r.form['4b'].base, r.form['4b'].vat, r.form['5b'], r.form['5c']], [100, 21, 0, 21], 'rubriek 4b en geen aftrek');
  });
}

// ── 3. Vangnetten ───────────────────────────────────────────────────────

async function vangnetten() {
  groep('Eenmanszaak — vangnetten');
  const w = await stap('een eenmanszaak met een beginbalans per 31-12-2024', () => maakEenmanszaak('vangnet', { start: '2025-01-01' }));
  if (!w) return;
  const t = {};

  await stap('de beginbalans per 31-12-2024 houdt het afsluiten van 2025 niet tegen', async () => {
    gelukt(await rpc('create_opening_balance', {
      p_organization_id: w.orgId, p_as_of_date: '2024-12-31',
      p_lines: [{ account_id: (await rekening(w, '1100')).id, description: 'Beginbalans Bank', debit_cents: 100000, credit_cents: 0 }],
    }, w.eigenaar.token), 'beginbalans');
    [t.j2025] = await boekjaren(w);
  });

  await stap('een btw-tijdvak dat nog loopt, sluit je niet af', async () => {
    const nu = vandaag();
    const jaar = Number(nu.slice(0, 4));
    const nummer = Math.floor((Number(nu.slice(5, 7)) - 1) / 3) + 1;
    const res = await sluitKwartaal(w, jaar, nummer);
    geweigerd(res, 'lopend kwartaal');
    verwacht(/loopt nog/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });

  await stap('per kwartaal ingesteld: een maand afsluiten wordt geweigerd', async () => {
    const res = await rpc('finalize_vat_return', {
      p_organization_id: w.orgId, p_period_type: 'month', p_year: 2025, p_period_index: 1, p_from: '2025-01-01', p_to: '2025-01-31',
    }, w.eigenaar.token);
    geweigerd(res, 'maand bij kwartaalaangifte');
    verwacht(/per kwartaal/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });

  await stap('een laptop over 5 jaar: afsluiten weigert zolang oktober t/m december niet is afgeschreven', async () => {
    t.laptop = await maakActivum(w, { name: 'Laptop', acquisition_date: '2025-07-01', start_date: '2025-07-01', acquisition_cost_cents: 300000 });
    gelukt(await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: t.laptop.id, p_credit_account_id: (await rekening(w, '0560')).id }, w.eigenaar.token), 'aanschaf (uit eigen zak)');
    gelukt(await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: t.laptop.id, p_through_date: '2025-09-30' }, w.eigenaar.token), 'afschrijven t/m september');
    for (const n of [1, 2, 3, 4]) gelukt(await sluitKwartaal(w, 2025, n), `btw Q${n} 2025`);
    const res = await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, w.eigenaar.token);
    geweigerd(res, 'afsluiten met geplande afschrijvingen');
    verwacht(/Laptop/.test(res.tekst) && /Activa/.test(res.tekst), `melding: ${res.tekst.slice(0, 250)}`);
  });

  await stap('na het afschrijven t/m december gaat het jaar dicht, met de afschrijving in 2025', async () => {
    gelukt(await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: nodig(t.laptop, 'laptop').id, p_through_date: '2025-12-31' }, w.eigenaar.token), 'afschrijven t/m december');
    gelukt(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: t.j2025.id }, w.eigenaar.token), 'afsluiten');
    gelijk(wv(w, '4000', '2025-01-01', '2025-12-31'), 30000, 'afschrijving 2025 (6 × € 50)');
  });

  await stap('verkopen in juni 2026: eerst de afschrijving t/m juni, dan het boekresultaat', async () => {
    const res = gelukt(await rpc('book_asset_disposal', {
      p_organization_id: w.orgId, p_asset_id: nodig(t.laptop, 'laptop').id, p_counter_account_id: (await rekening(w, '1100')).id,
      p_proceeds_cents: 200000, p_disposal_date: '2026-06-30', p_vat_code: 'HOOG',
    }, w.eigenaar.token), 'verkopen');
    gelijk((Array.isArray(res) ? res[0] : res).status, 'disposed', 'status');
    gelijk(wv(w, '4000', '2026-01-01', '2026-12-31'), 30000, 'afschrijving 2026 (januari t/m juni)');
    // Boekwaarde € 3.000 − € 600 = € 2.400; opbrengst € 2.000 → € 400 verlies.
    gelijk(wv(w, '4950', '2026-01-01', '2026-12-31'), 40000, 'boekverlies');
  });

  await stap('een monitor via een inkoopfactuur: koppelen, afschrijven, en tegenboeken pas na de afschrijvingen', async () => {
    const lev = await leverancier(w, 'Beeld BV');
    const factuur = await inkoopfactuur(w, lev, '2026-01-10', [{ description: 'Monitor', amount_cents: 60000, vat_code: 'HOOG', vat_rate: 21, account_id: (await rekening(w, '0100')).id }]);
    const monitor = await maakActivum(w, { name: 'Monitor', acquisition_date: '2026-01-10', start_date: '2026-01-10', acquisition_cost_cents: 60000, source_purchase_invoice_id: factuur.id });
    // Meer dan er op de activarekening staat, past niet.
    const te = await maakActivum(w, { name: 'Tweede monitor', acquisition_date: '2026-01-10', start_date: '2026-01-10', acquisition_cost_cents: 60000, source_purchase_invoice_id: factuur.id });
    gelukt(await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: monitor.id, p_credit_account_id: null }, w.eigenaar.token), 'koppelen');
    const dubbel = await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: te.id, p_credit_account_id: null }, w.eigenaar.token);
    geweigerd(dubbel, 'een tweede activum op dezelfde € 600');
    verwacht(/past daar niet in/.test(dubbel.tekst), `melding: ${dubbel.tekst.slice(0, 250)}`);
    gelukt(await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: monitor.id, p_through_date: '2026-03-31' }, w.eigenaar.token), 'afschrijven t/m maart');
    const res = await rpc('reverse_journal_entry', { p_entry_id: factuur.journal_entry_id }, w.eigenaar.token);
    geweigerd(res, 'tegenboeken met geboekte afschrijvingen');
    verwacht(/Monitor/.test(res.tekst) && /afschrijvingen/.test(res.tekst), `melding: ${res.tekst.slice(0, 250)}`);
    const afschrijvingen = sqlRijen(`select journal_entry_id from public.asset_depreciations where asset_id = ${q(monitor.id)} and status = 'posted' order by period_index desc`);
    for (const a of afschrijvingen) gelukt(await rpc('reverse_journal_entry', { p_entry_id: a.journal_entry_id }, w.eigenaar.token), 'afschrijving tegenboeken');
    gelukt(await rpc('reverse_journal_entry', { p_entry_id: factuur.journal_entry_id }, w.eigenaar.token), 'inkoopfactuur tegenboeken');
    gelijk(sqlRij(`select acquisition_journal_entry_id as a from public.fixed_assets where id = ${q(monitor.id)}`).a, null, 'het register gaat mee terug');
    gelijk(saldo(w, '0100', '2026-12-31'), 0, '0100 weer leeg');
  });

  await stap('rechtsvorm van vof naar eenmanszaak: de resultaatrekening gaat mee van 0510 naar 0500', async () => {
    const v = await maakEenmanszaak('wissel', { rechtsvorm: 'vof', resultaatrekening: '0510' });
    gelukt(await rest(`company_settings?organization_id=eq.${v.orgId}`, { method: 'PATCH', token: v.eigenaar.token, prefer: 'return=minimal', body: { legal_form: 'eenmanszaak' } }), 'rechtsvorm wijzigen');
    gelijk(sqlRij(`select year_result_account_code as c from public.company_settings where organization_id = ${q(v.orgId)}`).c, '0500', 'resultaatrekening');
    gelukt(await rest(`company_settings?organization_id=eq.${v.orgId}`, { method: 'PATCH', token: v.eigenaar.token, prefer: 'return=minimal', body: { year_result_account_code: '0510' } }), 'bewust 0510');
    gelukt(await rest(`company_settings?organization_id=eq.${v.orgId}`, { method: 'PATCH', token: v.eigenaar.token, prefer: 'return=minimal', body: { legal_form: 'vof' } }), 'terug naar vof');
    gelijk(sqlRij(`select year_result_account_code as c from public.company_settings where organization_id = ${q(v.orgId)}`).c, '0510', 'blijft 0510');
  });
}

// ── 4. Van kwartaal- naar maandaangifte ─────────────────────────────────
//
// De Belastingdienst zet je per 1 januari op maandaangifte (of je vraagt dat
// zelf aan). Je zet het bij Instellingen om en doet in januari nog de
// aangifte over Q4. Dat kon na 20261118090000 alleen door de instelling heen
// en weer te zetten, en het jaar ervoor kwam daarna niet meer dicht
// (20261118100000).

async function tijdvakWissel() {
  groep('Eenmanszaak — van kwartaal- naar maandaangifte');
  const w = await stap('een eenmanszaak die in 2025 per kwartaal aangifte deed', () => maakEenmanszaak('tijdvak', { start: '2025-01-01' }));
  if (!w) return;
  const t = {};

  await stap('Q1 t/m Q3 2025 per kwartaal, daarna bij Instellingen per maand', async () => {
    for (const n of [1, 2, 3]) gelukt(await sluitKwartaal(w, 2025, n), `btw Q${n} 2025`);
    gelukt(await rest(`company_settings?organization_id=eq.${w.orgId}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=minimal', body: { vat_return_period: 'monthly' } }), 'per maand');
    [t.j2025] = await boekjaren(w);
  });

  await stap('2025 gaat zonder Q4 niet dicht, en de melding noemt het kwartaal', async () => {
    const res = await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, w.eigenaar.token);
    geweigerd(res, 'afsluiten zonder Q4');
    verwacht(/01-10-2025 t\/m 31-12-2025/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });

  await stap('Q4 2025 gaat nog per kwartaal, en dan gaat 2025 dicht', async () => {
    gelukt(await sluitKwartaal(w, 2025, 4), 'btw Q4 2025');
    gelukt(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, w.eigenaar.token), 'afsluiten 2025');
  });

  await stap('2026 gaat per maand: januari mag, een kwartaal niet', async () => {
    gelukt(await rpc('finalize_vat_return', {
      p_organization_id: w.orgId, p_period_type: 'month', p_year: 2026, p_period_index: 1, p_from: '2026-01-01', p_to: '2026-01-31',
    }, w.eigenaar.token), 'januari 2026');
    const res = await sluitKwartaal(w, 2026, 2);
    geweigerd(res, 'een kwartaal in een maandjaar');
    verwacht(/per maand/.test(res.tekst) && /in 2026/.test(res.tekst), `melding: ${res.tekst.slice(0, 250)}`);
  });

  await stap('het dashboard krijgt de vier kwartalen en januari als aangegeven', async () => {
    const rijen = gelukt(await rpc('list_filed_vat_periods', { p_organization_id: w.orgId }, w.eigenaar.token), 'aangegeven tijdvakken');
    const sleutels = rijen.map((r) => `${r.period_type}:${r.year}:${r.period_index}`).sort();
    // De functie geeft dit jaar en de twee jaren ervoor.
    const vanaf = Number(vandaag().slice(0, 4)) - 2;
    const alle = ['month:2026:1', 'quarter:2025:1', 'quarter:2025:2', 'quarter:2025:3', 'quarter:2025:4'];
    gelijk(sleutels, alle.filter((s) => Number(s.split(':')[1]) >= vanaf), 'tijdvakken');
  });
}

export default async function eenmanszaak() {
  await hetJaar();
  await deKor();
  await vangnetten();
  await tijdvakWissel();
}
