// Herstelwegen: wat een zzp'er fout doet, moet hij zelf kunnen rechtzetten, en
// de cijfers moeten daarna nog kloppen.
//
// Waarom dit scenario: de gewone stromen (factureren, inkopen, de bank, de
// aangifte) hadden elk hun toets en klopten. De controle van 19 november 2026
// vond de gebreken in het herstel en in de randen: tegenboeken op de datum van
// vandaag, de bank die als enige niet doorschoof bij een dicht tijdvak,
// boekingen van vóór de start, een activum uit het oude pakket, en omzet die
// na het afsluiten van Q4 niet meer in het goede jaar te krijgen was.
// Zie docs/changelog/CHANGELOG_FINANCIEN_HERSTELWEGEN_2026-11-19.md en
// supabase/migrations/20261119180000_financien_herstelwegen.sql.
//
// Alles gaat zoals in de app: als de eigenaar, via REST en RPC met zijn eigen
// sessie (RLS geldt). Vandaag is in november 2026: 2025 kan dicht, Q1 t/m Q3
// van 2026 ook.
import { randomUUID } from 'node:crypto';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import {
  bankmutatie, bankrekening, boekMutatie, boekjaren, btwAangifte, inkoopfactuur, invoeren, klant, leverancier,
  maakActivum, maakEenmanszaak, nodig, q, rekening, saldo, sluitKwartaal, verstuurdeFactuur, wf,
} from './eenmanszaak.mjs';

/** Wat er in een periode op een rekening is geboekt (debet − credit), in centen. */
function mutatie(w, code, van, tot) {
  return Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and je.status = 'posted' and je.source_type <> 'year_close'
      and la.code = ${q(code)} and je.date between ${q(van)} and ${q(tot)}`));
}

/** Het saldo van een rekening over alle datums (debet − credit). */
function mutatieOp(w, code) {
  return mutatie(w, code, '2000-01-01', '2100-12-31');
}

function boekstuk(id) {
  return sqlRij(`select id, entry_number, date, description, source_type, reverses_entry_id, reversed_by_entry_id from public.journal_entries where id = ${q(id)}`);
}

function bankrij(id) {
  return sqlRij(`select id, status, booking_date, journal_entry_id, match_reason, matched_invoice_id from public.bank_transactions where id = ${q(id)}`);
}

async function terugdraaien(w, id) {
  gelukt(await rpc('unbook_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: id }, w.eigenaar.token), 'boeking ongedaan maken');
}

async function tegenboeken(w, entryId, datum) {
  const res = gelukt(await rpc('reverse_journal_entry', datum ? { p_entry_id: entryId, p_date: datum } : { p_entry_id: entryId }, w.eigenaar.token), 'tegenboeken');
  return Array.isArray(res) ? res[0] : res;
}

function memoriaal(w, datum, omschrijving, regels) {
  return rpc('post_journal_entry', {
    p_organization_id: w.orgId, p_date: datum, p_description: omschrijving, p_source_type: 'manual', p_source_id: null, p_lines: regels,
  }, w.eigenaar.token);
}

async function rubrieken(w, van, tot) {
  const vakken = gelukt(await rpc('compute_vat_return', { p_organization_id: w.orgId, p_from: van, p_to: tot }, w.eigenaar.token), 'btw berekenen');
  return (Array.isArray(vakken) ? vakken[0] : vakken).form;
}

async function conceptInkoop(w, lev, datum, regels) {
  const netto = regels.reduce((s, r) => s + r.amount_cents, 0);
  const btw = regels.reduce((s, r) => s + (r.vat_cents ?? Math.round(r.amount_cents * (r.vat_rate ?? 0) / 100)), 0);
  return gelukt(await rest('purchase_invoices?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, supplier_id: lev.id, supplier_invoice_number: `INK-${randomUUID().slice(0, 6)}`,
      date: datum, due_date: datum, subtotal_cents: netto, vat_cents: btw, total_cents: netto + btw, currency: 'EUR', status: 'draft',
      lines: regels.map((r) => ({ id: randomUUID(), ...r })),
    },
  }), 'inkoopfactuur opslaan')[0];
}

function boekInkoop(w, id) {
  return rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: id }, w.eigenaar.token);
}

// ── 1. Tegenboeken en opnieuw boeken ────────────────────────────────────

async function tegenboekenEnOpnieuw() {
  groep('Herstelwegen — terugdraaien en opnieuw boeken blijft in dezelfde periode');
  const w = await stap('een eenmanszaak met een bankrekening', () => maakEenmanszaak('herstel'));
  if (!w) return;
  const t = {};
  await stap('rekeningen, bank en een leverancier', async () => {
    t.bank = await bankrekening(w);
    t.algemeen = await rekening(w, '4500');
    t.kantoor = await rekening(w, '4300');
    t.bankkosten = await rekening(w, '4750');
    gelijk([t.bankkosten.name, t.bankkosten.type], ['Bankkosten en verzekeringen (geen btw)', 'expense'], 'de rekening voor bankkosten');
    t.lev = await leverancier(w, 'Kantoorhandel BV');
  });

  await stap('een pinbetaling van 5 augustus (€ 121 met 21%) op de verkeerde rekening: ongedaan maken en opnieuw boeken raakt Q4 niet', async () => {
    const m = await bankmutatie(w, nodig(t.bank, 'bank'), '2026-08-05', -12100, 'Laptopstandaard', [{ kind: 'ledger', account_id: t.algemeen.id, vat_code: 'HOOG', amount_cents: 12100 }]);
    t.pin = m.id;
    const eerste = bankrij(m.id).journal_entry_id;
    await terugdraaien(w, m.id);
    const tegen = boekstuk(boekstuk(eerste).reversed_by_entry_id);
    gelijk(tegen.date, '2026-08-05', 'de tegenboeking staat op de datum van het boekstuk zelf, niet op vandaag');
    gelukt(await boekMutatie(w, m.id, [{ kind: 'ledger', account_id: t.kantoor.id, vat_code: 'HOOG', amount_cents: 12100 }]), 'opnieuw boeken');
    gelijk([mutatie(w, '4500', '2026-07-01', '2026-09-30'), mutatie(w, '4300', '2026-07-01', '2026-09-30'), mutatie(w, '1500', '2026-07-01', '2026-09-30')],
      [0, 10000, 2100], 'Q3: € 100 kosten op 4300 en € 21 voorbelasting, één keer');
    gelijk([mutatie(w, '4500', '2026-10-01', '2026-12-31'), mutatie(w, '4300', '2026-10-01', '2026-12-31'), mutatie(w, '1500', '2026-10-01', '2026-12-31')],
      [0, 0, 0], 'Q4: niets');
    gelijk(saldo(w, '1100', '2026-09-30'), -12100, 'de bank per 30 september');
  });

  await stap('een inkoopfactuur van 20 september tegenboeken, verbeteren en opnieuw boeken: Q3 heeft het goede bedrag', async () => {
    const pi = await inkoopfactuur(w, nodig(t.lev, 'leverancier'), '2026-09-20', [{ description: 'Papier', amount_cents: 10000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kantoor.id }]);
    const tegen = await tegenboeken(w, pi.journal_entry_id);
    gelijk(tegen.date, '2026-09-20', 'de tegenboeking op de factuurdatum');
    gelijk(sqlRij(`select status from public.purchase_invoices where id = ${q(pi.id)}`).status, 'draft', 'de factuur is weer een concept');
    const regels = sqlRij(`select lines from public.purchase_invoices where id = ${q(pi.id)}`).lines.map((r) => ({ ...r, amount_cents: 8000 }));
    gelukt(await rest(`purchase_invoices?id=eq.${pi.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { lines: regels, subtotal_cents: 8000, vat_cents: 1680, total_cents: 9680 } }), 'verbeteren');
    gelukt(await boekInkoop(w, pi.id), 'opnieuw boeken');
    gelijk([mutatie(w, '4300', '2026-07-01', '2026-09-30'), mutatie(w, '1500', '2026-07-01', '2026-09-30'), mutatie(w, '4300', '2026-10-01', '2026-12-31')],
      [10000 + 8000, 2100 + 1680, 0], 'Q3: € 80 van de factuur (plus de pinbetaling), Q4: niets');
    t.papier = pi.id;
  });

  await stap('het venster mag nog steeds zelf een datum kiezen', async () => {
    const res = gelukt(await memoriaal(w, '2026-08-10', 'Correctie', [
      { account_id: t.kantoor.id, description: 'Correctie', debit_cents: 500, credit_cents: 0 },
      { account_id: t.algemeen.id, description: 'Correctie', debit_cents: 0, credit_cents: 500 },
    ]), 'memoriaal');
    const tegen = await tegenboeken(w, (Array.isArray(res) ? res[0] : res).id, '2026-08-31');
    gelijk(tegen.date, '2026-08-31', 'de gekozen datum');
  });

  // ── De bank in een afgesloten btw-tijdvak ──
  await stap('Q1 t/m Q3 2026 afsluiten; daarna ligt er nog een pinbetaling van 25 september', async () => {
    for (const n of [1, 2, 3]) await btwAangifte(w, 2026, n);
    t.nagekomen = await invoeren(w, nodig(t.bank, 'bank'), '2026-09-25', -6050, 'Kantoorartikelen');
  });

  await stap('met btw boeken in het dichte Q3: de boeking komt op 1 oktober, de datum van de bank blijft staan', async () => {
    gelukt(await boekMutatie(w, nodig(t.nagekomen, 'mutatie'), [{ kind: 'ledger', account_id: t.kantoor.id, vat_code: 'HOOG', amount_cents: 6050 }]), 'boeken met btw');
    const rij = bankrij(t.nagekomen);
    const stuk = boekstuk(rij.journal_entry_id);
    gelijk([rij.status, rij.booking_date, stuk.date], ['booked', '2026-09-25', '2026-10-01'], 'bankdatum en boekdatum');
    verwacht(/bankdatum 25-09-2026, geboekt in eerstvolgende open periode/.test(stuk.description), `omschrijving: ${stuk.description}`);
    gelijk([mutatie(w, '1500', '2026-10-01', '2026-12-31'), mutatie(w, '4300', '2026-10-01', '2026-12-31')], [1050, 5000], 'de voorbelasting en de kosten in Q4');
  });

  await stap('die boeking ongedaan maken en zonder btw opnieuw boeken: weer op de datum van de bank', async () => {
    await terugdraaien(w, t.nagekomen);
    gelijk([mutatie(w, '1500', '2026-10-01', '2026-12-31'), mutatie(w, '4300', '2026-10-01', '2026-12-31')], [0, 0], 'Q4 is weer leeg: de tegenboeking viel ook op 1 oktober');
    gelukt(await boekMutatie(w, t.nagekomen, [{ kind: 'ledger', account_id: t.bankkosten.id, amount_cents: 6050 }]), 'boeken zonder btw');
    gelijk(boekstuk(bankrij(t.nagekomen).journal_entry_id).date, '2026-09-25', 'zonder btw raakt de boeking de aangifte niet en blijft hij op zijn eigen datum');
  });

  await stap('een boeking uit het dichte Q3 ongedaan maken: de correctie valt in Q4, en opnieuw boeken kan gewoon', async () => {
    await terugdraaien(w, nodig(t.pin, 'pinbetaling'));
    gelukt(await boekMutatie(w, t.pin, [{ kind: 'ledger', account_id: t.kantoor.id, vat_code: 'HOOG', amount_cents: 12100 }]), 'opnieuw boeken');
    gelijk([bankrij(t.pin).booking_date, boekstuk(bankrij(t.pin).journal_entry_id).date], ['2026-08-05', '2026-10-01'], 'bankdatum blijft, boekdatum is de eerste open dag');
    gelijk([mutatie(w, '4300', '2026-10-01', '2026-12-31'), mutatie(w, '1500', '2026-10-01', '2026-12-31')], [0, 0], 'Q4: tegenboeking en nieuwe boeking vallen tegen elkaar weg');
    gelijk(mutatie(w, '4300', '2026-07-01', '2026-09-30'), 10000 + 8000, 'de kosten van Q3 staan zoals ze zijn aangegeven');
  });

  // ── Btw op de verkeerde plek ──
  await stap('rechtstreeks op een btw-rekening boeken wordt geweigerd, met de weg naar 1530', async () => {
    const id = await invoeren(w, nodig(t.bank, 'bank'), '2026-10-20', 31500, 'Belastingdienst teruggave');
    const voorbelasting = await rekening(w, '1500');
    const res = await boekMutatie(w, id, [{ kind: 'ledger', account_id: voorbelasting.id, amount_cents: 31500 }]);
    geweigerd(res, 'een teruggave op 1500');
    verwacht(/1530 Te betalen omzetbelasting/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    const af = await boekMutatie(w, id, [{ kind: 'ledger', account_id: (await rekening(w, '1510')).id, amount_cents: 31500 }]);
    geweigerd(af, 'op 1510');
    gelukt(await boekMutatie(w, id, [{ kind: 'ledger', account_id: (await rekening(w, '1530')).id, amount_cents: 31500 }]), 'op 1530');
  });

  await stap('geen btw op kas of debiteuren, en geen verkoopcode op kosten', async () => {
    const kas = await rekening(w, '1000');
    const debiteuren = await rekening(w, '1300');
    const opname = await invoeren(w, nodig(t.bank, 'bank'), '2026-10-21', -50000, 'Kasopname');
    const metBtw = await boekMutatie(w, opname, [{ kind: 'ledger', account_id: kas.id, vat_code: 'HOOG', amount_cents: 50000 }]);
    geweigerd(metBtw, 'kasopname met 21%');
    verwacht(/hoort geen btw/.test(metBtw.tekst), `melding: ${metBtw.tekst.slice(0, 200)}`);
    gelukt(await boekMutatie(w, opname, [{ kind: 'ledger', account_id: kas.id, amount_cents: 50000 }]), 'kasopname zonder btw');
    const oud = await invoeren(w, t.bank, '2026-10-22', 12100, 'Oude debiteur');
    geweigerd(await boekMutatie(w, oud, [{ kind: 'ledger', account_id: debiteuren.id, vat_code: 'HOOG', amount_cents: 12100 }]), 'oude debiteur met 21%');
    gelukt(await boekMutatie(w, oud, [{ kind: 'ledger', account_id: debiteuren.id, amount_cents: 12100 }]), 'oude debiteur zonder btw');
    const ads = await invoeren(w, t.bank, '2026-10-23', -50000, 'Google Ads Ireland');
    const icp = await boekMutatie(w, ads, [{ kind: 'ledger', account_id: t.kantoor.id, vat_code: 'ICP_DIENST', amount_cents: 50000 }]);
    geweigerd(icp, 'kosten met ICP diensten');
    verwacht(/Verwerving EU/.test(icp.tekst), `melding: ${icp.tekst.slice(0, 200)}`);
    gelukt(await boekMutatie(w, ads, [{ kind: 'ledger', account_id: t.kantoor.id, vat_code: 'EU_VERW', amount_cents: 50000 }]), 'met Verwerving EU');
    const r = await rubrieken(w, '2026-10-01', '2026-12-31');
    gelijk([r['4b'].base, r['4b'].vat], [500, 105], 'rubriek 4b');
    const pi = await conceptInkoop(w, nodig(t.lev, 'leverancier'), '2026-10-24', [{ description: 'Ads', amount_cents: 100000, vat_code: 'ICP_DIENST', vat_rate: 0, account_id: t.kantoor.id }]);
    const geboekt = await boekInkoop(w, pi.id);
    geweigerd(geboekt, 'inkoopfactuur met ICP diensten');
    verwacht(/is voor verkoop/.test(geboekt.tekst), `melding: ${geboekt.tekst.slice(0, 200)}`);
  });

  await stap('het btw-bedrag van de leverancier telt: € 20,48 + € 4,31 is € 24,79 op crediteuren, niet € 24,78', async () => {
    const pi = await conceptInkoop(w, nodig(t.lev, 'leverancier'), '2026-10-26', [{ description: 'Toner', amount_cents: 2048, vat_code: 'HOOG', vat_rate: 21, vat_cents: 431, account_id: t.kantoor.id }]);
    gelukt(await boekInkoop(w, pi.id), 'boeken');
    const stuk = sqlRij(`select journal_entry_id from public.purchase_invoices where id = ${q(pi.id)}`).journal_entry_id;
    const regels = sqlRijen(`select la.code, jl.debit_cents as d, jl.credit_cents as c from public.journal_lines jl join public.ledger_accounts la on la.id = jl.account_id where jl.entry_id = ${q(stuk)} order by la.code`);
    gelijk(regels.map((r) => [r.code, Number(r.d), Number(r.c)]), [['1500', 431, 0], ['1600', 0, 2479], ['4300', 2048, 0]], 'de boeking');
    gelijk(Number(sql(`select public.purchase_invoice_open_payable_cents(${q(w.orgId)}, ${q(pi.id)})`)), 2479, 'openstaand');
    const betaling = await invoeren(w, nodig(t.bank, 'bank'), '2026-10-28', -2479, 'Kantoorhandel BV');
    gelukt(await boekMutatie(w, betaling, [{ kind: 'purchase_invoice', purchase_invoice_id: pi.id, amount_cents: 2479 }]), 'de betaling van € 24,79 past precies');
    const nul = await conceptInkoop(w, t.lev, '2026-10-26', [{ description: 'Verzekering', amount_cents: 5000, vat_code: 'VRIJ', vat_rate: 0, vat_cents: 100, account_id: t.bankkosten.id }]);
    geweigerd(await boekInkoop(w, nul.id), 'een btw-bedrag op een regel zonder btw');
  });

  await stap('een factuurdatum in 2062 wordt niet geboekt', async () => {
    const pi = await conceptInkoop(w, nodig(t.lev, 'leverancier'), '2062-11-16', [{ description: 'Bon', amount_cents: 1000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kantoor.id }]);
    const res = await boekInkoop(w, pi.id);
    geweigerd(res, 'factuurdatum 2062');
    verwacht(/meer dan een jaar in de toekomst/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });

  await stap('een ontvangst met de naam van de klant en precies het open bedrag krijgt de factuur als voorstel, en wordt niet vanzelf als omzet geboekt', async () => {
    const jansen = await klant(w, 'Bakkerij Jansen', 'business');
    const factuur = await verstuurdeFactuur(w, jansen, '2026-11-02', [{ description: 'Websiteteksten', quantity: 1, unit_price: 1000, vat: 21 }]);
    const omzet = await rekening(w, '8000');
    gelukt(await rest('bank_rules', { method: 'POST', token: w.eigenaar.token, body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, name: 'Jansen', match_direction: 'in', match_counterparty_name_contains: 'Jansen',
      target_account_id: omzet.id, target_vat_code: 'HOOG', auto_book: true, is_active: true, priority: 1,
    } }), 'bankregel "Jansen → 8000, automatisch"');
    const res = gelukt(await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: nodig(t.bank, 'bank').id, p_statement: { format: 'csv', file_name: `jansen-${randomUUID()}.csv` },
      p_transactions: [{ booking_date: '2026-11-10', amount_cents: 121000, counterparty_name: 'BAKKERIJ JANSEN', description: 'Betaling november' }],
    }, w.eigenaar.token), 'afschrift');
    gelijk(res.inserted, 1, 'ingelezen');
    const rij = sqlRij(`select status, matched_invoice_id, match_reason, auto_booked from public.bank_transactions where bank_account_id = ${q(t.bank.id)} and amount_cents = 121000 and not is_manual`);
    gelijk([rij.status, rij.matched_invoice_id, rij.auto_booked], ['suggested', factuur.id, false], 'een voorstel met de factuur');
    verwacht(/precies het openstaande bedrag van factuur/.test(rij.match_reason), `reden: ${rij.match_reason}`);
    gelijk(sqlRij(`select status from public.invoices where id = ${q(factuur.id)}`).status, 'sent', 'de factuur staat nog open tot hij boekt');
  });

  await stap('een btw-code waarop geboekt is, verwijder je niet; de grootboekrekening van de bank ligt vast', async () => {
    const eigen = gelukt(await rest('vat_codes?select=id,code', { method: 'POST', token: w.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: w.orgId, code: 'EIGEN0', label: 'Eigen 0%', rate: 0, kind: 'zero', sales_box: '1e',
    } }), 'eigen btw-code')[0];
    const leeg = await rest(`vat_codes?id=eq.${eigen.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' });
    gelijk(leeg.json?.length, 1, 'een code zonder boekingen mag weg');
    const hoog = await rest(`vat_codes?organization_id=eq.${w.orgId}&code=eq.HOOG`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' });
    verwacht(hoog.status >= 400 || hoog.json?.length === 0, `HOOG verwijderen: ${hoog.status} ${hoog.tekst.slice(0, 120)}`);
    const kas = await rekening(w, '1000');
    const wissel = await rest(`bank_accounts?id=eq.${nodig(t.bank, 'bank').id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { ledger_account_id: kas.id } });
    geweigerd(wissel, 'de grootboekrekening van de bank wijzigen');
    verwacht(/al geboekt/.test(wissel.tekst), `melding: ${wissel.tekst.slice(0, 200)}`);
  });
}

// ── 2. Een afgesloten boekjaar ──────────────────────────────────────────

async function afgeslotenJaar() {
  groep('Herstelwegen — een afgesloten boekjaar, en omzet in het goede jaar');
  const w = await stap('een eenmanszaak met een inkoopfactuur en de betaling in mei 2025', async () => {
    const w0 = await maakEenmanszaak('dicht');
    w0.t = {};
    w0.t.bank = await bankrekening(w0);
    w0.t.kosten = await rekening(w0, '4500');
    w0.t.lev = await leverancier(w0, 'Drukkerij BV');
    w0.t.pi = await inkoopfactuur(w0, w0.t.lev, '2025-05-10', [{ description: 'Drukwerk', amount_cents: 10000, vat_code: 'HOOG', vat_rate: 21, account_id: w0.t.kosten.id }]);
    w0.t.betaling = (await bankmutatie(w0, w0.t.bank, '2025-05-20', -12100, 'Drukkerij BV', [{ kind: 'purchase_invoice', purchase_invoice_id: w0.t.pi.id, amount_cents: 12100 }])).id;
    [w0.t.j2025] = await boekjaren(w0);
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('Q4 2025 is aangegeven; een afgrenzing op 31 december (nog te factureren € 5.000) kan nog, en komt niet in rubriek 1e', async () => {
    for (const n of [1, 2, 3, 4]) await btwAangifte(w, 2025, n);
    const debiteuren = await rekening(w, '1300');
    const omzet = await rekening(w, '8000');
    gelukt(await memoriaal(w, '2025-12-31', 'Nog te factureren: decemberwerk', [
      { account_id: debiteuren.id, description: 'Nog te factureren', debit_cents: 500000, credit_cents: 0 },
      { account_id: omzet.id, description: 'Nog te factureren', debit_cents: 0, credit_cents: 500000 },
    ]), 'afgrenzing in het dichte Q4');
    gelijk(mutatie(w, '8000', '2025-01-01', '2025-12-31'), -500000, 'de omzet staat in 2025');
    // Omzet mét btw in een dicht tijdvak blijft geweigerd: die raakt de aangifte.
    geweigerd(await memoriaal(w, '2025-12-31', 'Omzet met btw', [
      { account_id: debiteuren.id, description: 'x', debit_cents: 12100, credit_cents: 0 },
      { account_id: omzet.id, description: 'x', debit_cents: 0, credit_cents: 10000, vat_code: 'HOOG', vat_rate: 21, vat_base_cents: 10000, vat_amount_cents: 2100 },
      { account_id: (await rekening(w, '1510')).id, description: 'x', debit_cents: 0, credit_cents: 2100 },
    ]), 'omzet met btw in het dichte Q4');
    // In een open tijdvak: zonder code geen 1e, met een 0%-code wel.
    gelukt(await memoriaal(w, '2026-10-05', 'Terugname afgrenzing', [
      { account_id: omzet.id, description: 'Terugname', debit_cents: 500000, credit_cents: 0 },
      { account_id: debiteuren.id, description: 'Terugname', debit_cents: 0, credit_cents: 500000 },
    ]), 'terugname in 2026');
    const r = await rubrieken(w, '2026-10-01', '2026-12-31');
    gelijk([r['1e'].base, r['1a'].base], [0, 0], 'rubriek 1e en 1a in Q4 2026');
  });

  await stap('afsluiten met een bankmutatie uit 2025 die nog niet geboekt is: geweigerd, met het aantal', async () => {
    t.los = await invoeren(w, nodig(t.bank, 'bank'), '2025-12-20', -4840, 'Nog niet geboekt');
    const res = await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, w.eigenaar.token);
    geweigerd(res, 'afsluiten met een open bankmutatie');
    verwacht(/1 bankmutatie\(s\) uit dit boekjaar/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await boekMutatie(w, t.los, [{ kind: 'ledger', account_id: (await rekening(w, '4750')).id, amount_cents: 4840 }]), 'boeken');
    gelukt(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: t.j2025.id }, w.eigenaar.token), '2025 afsluiten');
  });

  await stap('de betaling uit mei 2025 ongedaan maken in een dicht jaar: tegenboeking en nieuwe boeking komen op 1 januari 2026, niets loopt dood', async () => {
    const bankVoor = saldo(w, '1100', '2025-12-31');
    await terugdraaien(w, nodig(t.betaling, 'betaling'));
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(t.pi.id)}`).payment_status, 'unpaid', 'de factuur staat weer open');
    gelukt(await boekMutatie(w, t.betaling, [{ kind: 'purchase_invoice', purchase_invoice_id: t.pi.id, amount_cents: 12100 }]), 'opnieuw afletteren');
    const rij = bankrij(t.betaling);
    gelijk([rij.status, rij.booking_date, boekstuk(rij.journal_entry_id).date], ['booked', '2025-05-20', '2026-01-01'], 'bankdatum en boekdatum');
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(t.pi.id)}`).payment_status, 'paid', 'de factuur is weer betaald');
    gelijk([saldo(w, '1100', '2025-12-31'), saldo(w, '1100', '2026-01-01'), saldo(w, '1600', '2026-01-01')], [bankVoor, bankVoor, 0], 'de bank per 31 december blijft zoals afgesloten, en crediteuren staat op nul');
  });
}

// ── 3. Vóór de start van de boekhouding ─────────────────────────────────

async function voorDeStart() {
  groep('Herstelwegen — niets vóór de start van de boekhouding');
  const w = await stap('een eenmanszaak die op 1 oktober 2026 in ResoFly begint, met € 5.000 op de bank', async () => {
    const w0 = await maakEenmanszaak('start', { start: '2026-10-01' });
    w0.t = {};
    w0.t.bankGb = await rekening(w0, '1100');
    gelukt(await rpc('create_opening_balance', { p_organization_id: w0.orgId, p_as_of_date: '2026-10-01',
      p_lines: [{ account_id: w0.t.bankGb.id, description: 'Beginbalans Bank', debit_cents: 500000, credit_cents: 0 }] }, w0.eigenaar.token), 'beginbalans');
    w0.t.bank = await bankrekening(w0);
    w0.t.lev = await leverancier(w0, 'KPN');
    w0.t.kosten = await rekening(w0, '4300');
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('een afschrift dat in september begint: wat vóór de start ligt gaat op genegeerd met de reden erbij, en is niet te boeken', async () => {
    gelukt(await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: t.bank.id, p_statement: { format: 'csv', file_name: `start-${randomUUID()}.csv` },
      p_transactions: [
        { booking_date: '2026-09-10', amount_cents: -100000, counterparty_name: 'Naar privé', description: 'Opname' },
        { booking_date: '2026-10-05', amount_cents: -5000, counterparty_name: 'Bank', description: 'Kosten betaalpakket' },
      ],
    }, w.eigenaar.token), 'afschrift');
    const oud = sqlRij(`select id, status, match_reason from public.bank_transactions where bank_account_id = ${q(t.bank.id)} and booking_date = '2026-09-10'`);
    gelijk(oud.status, 'ignored', 'de mutatie van 10 september');
    verwacht(/Van vóór de start van je boekhouding in ResoFly \(01-10-2026\)/.test(oud.match_reason), `reden: ${oud.match_reason}`);
    gelukt(await rpc('set_bank_transaction_status', { p_organization_id: w.orgId, p_transaction_id: oud.id, p_status: 'unmatched' }, w.eigenaar.token), 'terugzetten');
    const res = await boekMutatie(w, oud.id, [{ kind: 'ledger', account_id: (await rekening(w, '0550')).id, amount_cents: 100000 }]);
    geweigerd(res, 'boeken vóór de start');
    verwacht(/zit al in het banksaldo van je beginbalans/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    const na = sqlRij(`select id, status from public.bank_transactions where bank_account_id = ${q(t.bank.id)} and booking_date = '2026-10-05'`);
    verwacht(['unmatched', 'suggested'].includes(na.status), `de mutatie van 5 oktober staat gewoon klaar: ${na.status}`);
    gelukt(await rpc('match_bank_transactions', { p_organization_id: w.orgId, p_bank_account_id: t.bank.id }, w.eigenaar.token), 'opnieuw matchen');
    gelijk(sqlRij(`select status from public.bank_transactions where id = ${q(oud.id)}`).status, 'ignored', 'na opnieuw matchen weer genegeerd');
    const aansluiting = sqlRij(`select public.report_bank_reconciliation(${q(w.orgId)}) as r`).r.find((r) => r.bank_account_id === t.bank.id);
    gelijk([aansluiting.ignored_count, aansluiting.ignored_sum_cents], [0, 0], 'de genegeerde mutatie van vóór de start telt niet in de aansluiting');
    gelijk(saldo(w, '1100', '2026-10-31'), 500000, 'de bank staat op de beginbalans');
  });

  await stap('een inkoopfactuur van 28 september boekt op de startdatum, met de factuurdatum erbij', async () => {
    const pi = await inkoopfactuur(w, t.lev, '2026-09-28', [{ description: 'Abonnement', amount_cents: 3000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id }]);
    const stuk = boekstuk(pi.journal_entry_id);
    gelijk(stuk.date, '2026-10-01', 'de boekdatum');
    verwacht(/factuurdatum 28-09-2026/.test(stuk.description), `omschrijving: ${stuk.description}`);
    gelijk(Number(sql(`select count(*) from public.journal_entries where organization_id = ${q(w.orgId)} and date < '2026-10-01'`)), 0, 'geen enkel boekstuk vóór de start');
  });

  await stap('de aansluiting klopt ook als een mutatie van het afschrift in het volgende tijdvak is geboekt', async () => {
    // Een eigen administratie: alleen deze ene mutatie, zodat het afschrift
    // en het grootboek precies te volgen zijn.
    const a0 = await maakEenmanszaak('aansluiting');
    const bank = await bankrekening(a0);
    const res = gelukt(await rpc('import_bank_transactions', {
      p_organization_id: a0.orgId, p_bank_account_id: bank.id,
      p_statement: { format: 'camt053', file_name: `sept-${randomUUID()}.xml`, period_start: '2026-09-01', period_end: '2026-09-30', opening_balance_cents: 0, closing_balance_cents: -1000 },
      p_transactions: [{ booking_date: '2026-09-28', amount_cents: -1000, counterparty_name: 'Postzegels', description: 'PostNL' }],
    }, a0.eigenaar.token), 'afschrift september');
    gelijk(res.inserted, 1, 'ingelezen');
    for (const n of [1, 2, 3]) gelukt(await sluitKwartaal(a0, 2026, n), `btw Q${n} 2026`);
    const id = sqlRij(`select id from public.bank_transactions where bank_account_id = ${q(bank.id)} and amount_cents = -1000`).id;
    gelukt(await boekMutatie(a0, id, [{ kind: 'ledger', account_id: (await rekening(a0, '4300')).id, vat_code: 'HOOG', amount_cents: 1000 }]), 'boeken met btw in het dichte Q3');
    gelijk(boekstuk(bankrij(id).journal_entry_id).date, '2026-10-01', 'geboekt op 1 oktober');
    const a = sqlRij(`select public.report_bank_reconciliation(${q(a0.orgId)}) as r`).r.find((r) => r.bank_account_id === bank.id);
    gelijk([a.as_of, a.ledger_balance_cents, a.timing_count, a.timing_sum_cents, a.difference_cents], ['2026-09-30', 0, 1, -1000, 0],
      'peildatum 30 september: het grootboek heeft hem nog niet, één tijdsverschil van € 10, geen verschil');
  });

  await stap('een beginbalans in de toekomst wordt geweigerd', async () => {
    const ander = await maakEenmanszaak('toekomst');
    const res = await rpc('create_opening_balance', { p_organization_id: ander.orgId, p_as_of_date: '2052-01-01',
      p_lines: [{ account_id: (await rekening(ander, '1100')).id, description: 'Bank', debit_cents: 100, credit_cents: 0 }] }, ander.eigenaar.token);
    geweigerd(res, 'beginbalans per 2052');
    verwacht(/ligt in de toekomst/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });
}

// ── 4. Een activum uit het oude pakket, en de beginbalans corrigeren ────

async function activumEnBeginbalans() {
  groep('Herstelwegen — een activum van vóór de start en de beginbalans corrigeren');
  const w = await stap('een eenmanszaak die per 1 januari 2025 overstapt, met een laptop uit juli 2023 in de beginbalans (€ 1.500, € 450 afgeschreven)', async () => {
    const w0 = await maakEenmanszaak('activum');
    w0.t = {};
    const [bank, activa, cumulatief] = [await rekening(w0, '1100'), await rekening(w0, '0100'), await rekening(w0, '0150')];
    w0.t.regels = [
      { account_id: bank.id, description: 'Bank', debit_cents: 500000, credit_cents: 0 },
      { account_id: activa.id, description: 'Laptop', debit_cents: 150000, credit_cents: 0 },
      { account_id: cumulatief.id, description: 'Afgeschreven', debit_cents: 0, credit_cents: 45000 },
    ];
    const res = gelukt(await rpc('create_opening_balance', { p_organization_id: w0.orgId, p_as_of_date: '2025-01-01', p_lines: w0.t.regels }, w0.eigenaar.token), 'beginbalans');
    w0.t.beginbalans = (Array.isArray(res) ? res[0] : res).id;
    [w0.t.j2025] = await boekjaren(w0);
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('de laptop in het register met de echte gegevens: "Boek aanschaf" koppelt hem aan de beginbalans, zonder boeking', async () => {
    t.laptop = await maakActivum(w, { name: 'Laptop', acquisition_date: '2023-07-01', start_date: '2023-07-01', acquisition_cost_cents: 150000 });
    const stukkenVoor = Number(sql(`select count(*) from public.journal_entries where organization_id = ${q(w.orgId)}`));
    const res = gelukt(await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: t.laptop.id, p_credit_account_id: (await rekening(w, '0500')).id }, w.eigenaar.token), 'aanschaf');
    gelijk((Array.isArray(res) ? res[0] : res).acquisition_journal_entry_id, t.beginbalans, 'de aanschaf is het boekstuk van de beginbalans');
    gelijk(Number(sql(`select count(*) from public.journal_entries where organization_id = ${q(w.orgId)}`)), stukkenVoor, 'geen nieuw boekstuk');
    const termijnen = sqlRij(`select count(*) filter (where status = 'posted') as geboekt, coalesce(sum(amount_cents) filter (where status = 'posted'), 0) as bedrag,
      count(*) filter (where status = 'posted' and journal_entry_id is not null) as met_boekstuk from public.asset_depreciations where asset_id = ${q(t.laptop.id)}`);
    gelijk([Number(termijnen.geboekt), Number(termijnen.bedrag), Number(termijnen.met_boekstuk)], [18, 45000, 0], 'achttien termijnen van vóór de start tellen als afgeschreven, zonder boeking');
    gelijk(saldo(w, '0100', '2025-12-31'), 150000, '0100 staat er één keer');
  });

  await stap('een tweede activum past niet meer in wat er op de beginbalans staat', async () => {
    const tweede = await maakActivum(w, { name: 'Printer', acquisition_date: '2024-02-01', start_date: '2024-02-01', acquisition_cost_cents: 30000 });
    const res = await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: tweede.id, p_credit_account_id: null }, w.eigenaar.token);
    geweigerd(res, 'printer koppelen');
    verwacht(/past daar niet in/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await rest(`fixed_assets?id=eq.${tweede.id}`, { method: 'DELETE', token: w.eigenaar.token }), 'printer weg');
  });

  await stap('een tikfout in de aanschafwaarde: de koppeling losmaken, verbeteren en opnieuw koppelen', async () => {
    const vast = await rest(`fixed_assets?id=eq.${t.laptop.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { useful_life_months: 48 } });
    geweigerd(vast, 'wijzigen terwijl hij gekoppeld is');
    gelukt(await rpc('unlink_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: t.laptop.id }, w.eigenaar.token), 'losmaken');
    gelijk(Number(sql(`select count(*) from public.asset_depreciations where asset_id = ${q(t.laptop.id)} and status = 'posted'`)), 0, 'de termijnen staan weer gepland');
    const los = await rest(`fixed_assets?id=eq.${t.laptop.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { notes: 'Verbeterd' } });
    gelijk(los.json?.length, 1, 'het activum is weer te wijzigen');
    gelukt(await rpc('book_asset_acquisition', { p_organization_id: w.orgId, p_asset_id: t.laptop.id, p_credit_account_id: null }, w.eigenaar.token), 'opnieuw koppelen');
  });

  await stap('afschrijven: alleen 2025 krijgt boekingen (12 × € 25), en jaren vooruit boeken wordt geweigerd', async () => {
    const tikfout = await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: t.laptop.id, p_through_date: '2062-10-31' }, w.eigenaar.token);
    geweigerd(tikfout, 'afschrijven t/m 2062');
    verwacht(/tot en met het einde van dit jaar/.test(tikfout.tekst), `melding: ${tikfout.tekst.slice(0, 200)}`);
    gelukt(await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: t.laptop.id, p_through_date: '2025-12-31' }, w.eigenaar.token), 'afschrijven t/m 31-12-2025');
    gelijk([mutatie(w, '4000', '2025-01-01', '2025-12-31'), saldo(w, '0150', '2025-12-31')], [30000, -75000], 'afschrijving 2025 en de cumulatieve afschrijving');
    gelijk(Number(sql(`select count(*) from public.journal_entries where organization_id = ${q(w.orgId)} and date < '2025-01-01'`)), 0, 'geen boekstuk vóór de start');
  });

  await stap('de beginbalans corrigeren terwijl er al is afgeschreven: eerst de afschrijvingen, dat zegt de melding', async () => {
    const res = await rpc('reverse_journal_entry', { p_entry_id: t.beginbalans }, w.eigenaar.token);
    geweigerd(res, 'beginbalans tegenboeken met een afgeschreven activum eraan');
    verwacht(/Draai eerst de desinvestering en de geboekte afschrijvingen terug/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });

  await stap('2025 gaat dicht: er staat niets vóór het eerste boekjaar', async () => {
    for (const n of [1, 2, 3, 4]) gelukt(await sluitKwartaal(w, 2025, n), `btw Q${n} 2025`);
    gelukt(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, w.eigenaar.token), '2025 afsluiten');
  });

  // ── De beginbalans corrigeren ──
  const b = await stap('een andere eenmanszaak: de bank had € 4.000 moeten zijn, niet € 5.000', async () => {
    const w1 = await maakEenmanszaak('beginbalans');
    w1.bankGb = await rekening(w1, '1100');
    const res = gelukt(await rpc('create_opening_balance', { p_organization_id: w1.orgId, p_as_of_date: '2025-01-01',
      p_lines: [{ account_id: w1.bankGb.id, description: 'Bank', debit_cents: 500000, credit_cents: 0 }] }, w1.eigenaar.token), 'beginbalans');
    w1.beginbalans = (Array.isArray(res) ? res[0] : res).id;
    return w1;
  });
  if (!b) return;

  await stap('tegenboeken zonder datum: op 1 januari 2025 zelf, zodat er niets dubbel staat; daarna de goede beginbalans', async () => {
    const tegen = await tegenboeken(b, b.beginbalans);
    gelijk(tegen.date, '2025-01-01', 'de tegenboeking op de datum van de beginbalans');
    gelijk(saldo(b, '1100', '2025-12-31'), 0, 'de bank staat op nul');
    gelukt(await rpc('create_opening_balance', { p_organization_id: b.orgId, p_as_of_date: '2025-01-01',
      p_lines: [{ account_id: b.bankGb.id, description: 'Bank', debit_cents: 400000, credit_cents: 0 }] }, b.eigenaar.token), 'nieuwe beginbalans');
    gelijk([saldo(b, '1100', '2025-01-01'), saldo(b, '1100', '2026-11-30'), saldo(b, '0500', '2026-11-30')], [400000, 400000, -400000], 'bank en eigen vermogen op elke peildatum');
  });

  await stap('een boekjaar met een tikfout in de datum kan weer weg, een boekjaar met boekingen niet', async () => {
    const jaren = await boekjaren(b);
    const fout = gelukt(await rpc('open_fiscal_year', { p_organization_id: b.orgId, p_period_start: '2027-01-01', p_period_end: '2027-06-30', p_label: '2027' }, b.eigenaar.token), 'boekjaar 2027 met een verkeerde einddatum');
    const id = (Array.isArray(fout) ? fout[0] : fout).id;
    gelukt(await rpc('delete_open_fiscal_year', { p_organization_id: b.orgId, p_fiscal_year_id: id }, b.eigenaar.token), 'verwijderen');
    gelijk((await boekjaren(b)).length, jaren.length, 'het boekjaar is weg');
    const metBoekingen = await rpc('delete_open_fiscal_year', { p_organization_id: b.orgId, p_fiscal_year_id: jaren[0].id }, b.eigenaar.token);
    geweigerd(metBoekingen, 'een boekjaar met boekingen verwijderen');
  });
}

// ── 5. De KOR ───────────────────────────────────────────────────────────

async function kor() {
  groep('Herstelwegen — de kleineondernemersregeling');
  const w = await stap('een eenmanszaak met de KOR en een concept uit die tijd', async () => {
    const w0 = await maakEenmanszaak('koruit', { kor: true });
    w0.t = {};
    w0.t.klant = await klant(w0, 'Familie De Boer', 'consumer');
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('de KOR gaat uit: een factuur met een regel op code KOR gaat niet meer zonder btw de deur uit', async () => {
    const concept = gelukt(await rest('invoices?select=*', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: {
        organization_id: w.orgId, created_by: w.eigenaar.id, client_id: t.klant.id, project_id: null, number: `F2026-${randomUUID().slice(0, 6)}`,
        date: '2026-11-10', due_date: '2026-11-24', status: 'draft', notes: null,
        lines: [{ id: randomUUID(), description: 'Fotoshoot', quantity: 1, unit_price: 400, vat: 0 }],
      },
    }), 'concept met de KOR')[0];
    gelijk(sqlRij(`select lines from public.invoices where id = ${q(concept.id)}`).lines[0].vat_code, 'KOR', 'het concept kreeg de code KOR');
    gelukt(await rest(`company_settings?organization_id=eq.${w.orgId}`, { method: 'PATCH', token: w.eigenaar.token, body: { kor_enabled: false } }), 'KOR uit');
    const res = await wf(w, 'sendInvoiceEmail', { invoiceId: concept.id, recipientEmail: t.klant.email, recipientName: t.klant.name, includePaymentLink: false });
    verwacht(res.status >= 400 || res.json?.ok === false, `versturen had geweigerd moeten worden: ${res.status} ${String(res.tekst).slice(0, 200)}`);
    verwacht(/kleineondernemersregeling staat uit/.test(res.tekst), `melding: ${String(res.tekst).slice(0, 300)}`);
    gelijk(sqlRij(`select status from public.invoices where id = ${q(concept.id)}`).status, 'draft', 'de factuur is nog een concept');
  });

  const v = await stap('een andere eenmanszaak met de KOR en een dienst uit Ierland (verlegde btw € 21)', async () => {
    const w1 = await maakEenmanszaak('korverlegd', { kor: true });
    const lev = await leverancier(w1, 'Google Ireland');
    await inkoopfactuur(w1, lev, '2025-05-12', [{ description: 'Ads', amount_cents: 10000, vat_code: 'EU_VERW', vat_rate: 21, account_id: (await rekening(w1, '4400')).id }]);
    gelijk(saldo(w1, '1520', '2025-12-31'), -2100, 'de verlegde btw staat op 1520');
    [w1.j2025] = await boekjaren(w1);
    return w1;
  });
  if (!v) return;

  await stap('het jaar gaat niet dicht zolang die btw niet is aangegeven; na het tijdvak afsluiten wel', async () => {
    const res = await rpc('close_fiscal_year', { p_organization_id: v.orgId, p_fiscal_year_id: v.j2025.id }, v.eigenaar.token);
    geweigerd(res, 'afsluiten met verlegde btw op 1520');
    verwacht(/verlegde btw geef je ook met de KOR aan/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await sluitKwartaal(v, 2025, 2), 'Q2 2025 afsluiten');
    gelukt(await rpc('close_fiscal_year', { p_organization_id: v.orgId, p_fiscal_year_id: v.j2025.id }, v.eigenaar.token), '2025 afsluiten');
  });
}

// ── 6. Wat ResoFly vanzelf boekt ────────────────────────────────────────

async function vanzelfBoeken() {
  groep('Herstelwegen — vanzelf boeken alleen als het zeker is');
  const w = await stap('een eenmanszaak met een bankregel "Shell → 4200, automatisch" en een leverancier met rekeningnummer', async () => {
    const w0 = await maakEenmanszaak('vanzelf');
    w0.t = {};
    w0.t.bank = await bankrekening(w0);
    w0.t.auto = await rekening(w0, '4200');
    gelukt(await rest('bank_rules', { method: 'POST', token: w0.eigenaar.token, body: {
      organization_id: w0.orgId, created_by: w0.eigenaar.id, name: 'Shell', match_direction: 'out', match_counterparty_name_contains: 'Shell',
      target_account_id: w0.t.auto.id, target_vat_code: null, auto_book: true, is_active: true, priority: 1,
    } }), 'bankregel');
    w0.t.kpn = gelukt(await rest('suppliers?select=*', { method: 'POST', token: w0.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w0.orgId, created_by: w0.eigenaar.id, name: 'KPN B.V.', iban: 'NL02KPNB0123456789' } }), 'leverancier')[0];
    return w0;
  });
  if (!w) return;
  const t = w.t;
  const lees = (regels) => rpc('import_bank_transactions', {
    p_organization_id: w.orgId, p_bank_account_id: t.bank.id, p_statement: { format: 'csv', file_name: `v-${randomUUID()}.csv` }, p_transactions: regels,
  }, w.eigenaar.token);
  const rijen = (bedrag) => sqlRijen(`select id, status, auto_booked, match_reason from public.bank_transactions where bank_account_id = ${q(t.bank.id)} and amount_cents = ${bedrag} order by created_at`);

  await stap('dezelfde tankbeurt twee keer ingelezen met een andere omschrijving: de tweede wordt niet nog eens als kosten geboekt', async () => {
    gelukt(await lees([{ booking_date: '2026-10-12', amount_cents: -5000, counterparty_name: 'SHELL UTRECHT', description: 'Pasbetaling 12-10 SHELL UTRECHT pas 001' }]), 'eerst het afschrift');
    gelijk(rijen(-5000).map((r) => [r.status, r.auto_booked]), [['booked', true]], 'de eerste: vanzelf geboekt door de bankregel');
    gelukt(await lees([{ booking_date: '2026-10-12', amount_cents: -5000, counterparty_name: 'SHELL UTRECHT', description: 'SHELL UTRECHT' }]), 'later de bankkoppeling');
    const twee = rijen(-5000);
    gelijk(twee.map((r) => r.status), ['booked', 'suggested'], 'de tweede is een voorstel');
    verwacht(/dubbel ingelezen/.test(twee[1].match_reason), `reden: ${twee[1].match_reason}`);
    gelijk(mutatieOp(w, '4200'), 5000, 'de kosten staan er één keer');
    t.dubbel = twee[1].id;
  });

  await stap('de dubbele mutatie kan weg; een mutatie die echt op het afschrift staat niet', async () => {
    gelukt(await rpc('delete_duplicate_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: nodig(t.dubbel, 'dubbele mutatie') }, w.eigenaar.token), 'dubbele verwijderen');
    gelijk(rijen(-5000).length, 1, 'er staat er nog één');
    gelukt(await lees([{ booking_date: '2026-10-14', amount_cents: -1999, counterparty_name: 'Bol', description: 'Bestelling' }]), 'een gewone mutatie');
    const res = await rpc('delete_duplicate_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: rijen(-1999)[0].id }, w.eigenaar.token);
    geweigerd(res, 'een mutatie zonder dubbele verwijderen');
    verwacht(/dit is geen dubbele/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    geweigerd(await rpc('delete_duplicate_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: rijen(-5000)[0].id }, w.eigenaar.token), 'een geboekte mutatie verwijderen');
  });

  await stap('een incasso van zes weken vóór de factuurdatum wordt een voorstel; een incasso erna boekt vanzelf', async () => {
    gelukt(await lees([{ booking_date: '2026-09-25', amount_cents: -3630, counterparty_name: 'KPN B.V.', counterparty_iban: 'NL02KPNB0123456789', description: 'Incasso september' }]), 'de incasso van september');
    await inkoopfactuur(w, t.kpn, '2026-11-05', [{ description: 'Abonnement november', amount_cents: 3000, vat_code: 'HOOG', vat_rate: 21, account_id: (await rekening(w, '4300')).id }]);
    gelukt(await rpc('match_bank_transactions', { p_organization_id: w.orgId, p_bank_account_id: t.bank.id }, w.eigenaar.token), 'matchen');
    const vroeg = rijen(-3630)[0];
    gelijk([vroeg.status, vroeg.auto_booked], ['suggested', false], 'de incasso van september: een voorstel');
    verwacht(/van vóór de factuurdatum \(05-11-2026\)/.test(vroeg.match_reason), `reden: ${vroeg.match_reason}`);
    gelukt(await lees([{ booking_date: '2026-11-18', amount_cents: -3630, counterparty_name: 'KPN B.V.', counterparty_iban: 'NL02KPNB0123456789', description: 'Incasso november' }]), 'de incasso van november');
    const laat = rijen(-3630).find((r) => r.id !== vroeg.id);
    gelijk([laat.status, laat.auto_booked], ['booked', true], 'de incasso van november: vanzelf afgeletterd');
  });

  await stap('een omschrijving met een factuurnummer dat ResoFly niet kent: een voorstel, niet vanzelf geboekt op een andere factuur', async () => {
    const hn = gelukt(await rest('suppliers?select=*', { method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.eigenaar.id, name: 'Hosting Noord', iban: 'NL44HNRD0000000044' } }), 'leverancier')[0];
    await inkoopfactuur(w, hn, '2026-10-01', [{ description: 'Hosting oktober', amount_cents: 2500, vat_code: 'HOOG', vat_rate: 21, account_id: (await rekening(w, '4300')).id }]);
    gelukt(await lees([{ booking_date: '2026-11-03', amount_cents: -3025, counterparty_name: 'Hosting Noord', counterparty_iban: 'NL44HNRD0000000044', description: 'Factuur HN-2026-11' }]), 'betaling met een ander factuurnummer');
    const rij = rijen(-3025)[0];
    gelijk([rij.status, rij.auto_booked], ['suggested', false], 'een voorstel');
    verwacht(/noemt een factuurnummer dat hier niet bij een openstaande factuur staat/.test(rij.match_reason), `reden: ${rij.match_reason}`);
  });
}

export default async function herstelwegen() {
  await tegenboekenEnOpnieuw();
  await afgeslotenJaar();
  await voorDeStart();
  await activumEnBeginbalans();
  await kor();
  await vanzelfBoeken();
}
