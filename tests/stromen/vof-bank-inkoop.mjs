// Vof: privé bij de bank en de inkoop. Wat privé is, mag niet via een andere
// weg toch als kosten of als voorbelasting in de boeken komen.
//
// Waarom dit scenario: de controle van 22 november 2026 speelde drie gaten na
// bij een vof met twee vennoten, die de bestaande scenario's niet zagen omdat
// ze óf een eenmanszaak zijn, óf privé alleen via de bank boeken:
//   1. Een inkoopregel "Privédeel Bram" van € 50 op 0552 met 21% gaf € 10,50
//      voorbelasting (rubriek 5b). De bank weigerde btw op privé al; de inkoop
//      niet, en Gerrie (purchase_invoice.update, supplier.update) ook niet.
//   2. Een factuur die Anna privé betaalde, werd via de incasso van de zaak
//      nog eens als kosten geboekt: de bankregel "Drukkerij → 4500, 21%,
//      vanzelf" verdubbelde oktober (€ 1.600 kosten, € 336 voorbelasting).
//   3. Een betaling aan de Belastingdienst wees naar 0550, en die staat bij
//      een vof op geen enkele vennoot.
// Zie supabase/migrations/20261122110000_vof_bank_inkoop_prive.sql.
//
// Alles gaat zoals in de app: als de eigenaar, via REST en RPC met zijn eigen
// sessie (RLS geldt). Gerrie zoals in de chat (buildProposal in gerrieCore.ts),
// zonder taalmodel ertussen.
import { randomUUID } from 'node:crypto';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { bankrekening, inkoopfactuur, maakEenmanszaak, nodig, q, rekening } from './eenmanszaak.mjs';

/** Wat er in een periode op een rekening is geboekt (debet − credit), in centen. */
function mutatie(w, code, van = '2000-01-01', tot = '2100-12-31') {
  return Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and je.status = 'posted' and je.source_type <> 'year_close'
      and la.code = ${q(code)} and je.date between ${q(van)} and ${q(tot)}`));
}

async function rubrieken(w, van, tot) {
  const vakken = gelukt(await rpc('compute_vat_return', { p_organization_id: w.orgId, p_from: van, p_to: tot }, w.eigenaar.token), 'btw berekenen');
  return (Array.isArray(vakken) ? vakken[0] : vakken).form;
}

/** Een vof zoals de inrichting hem achterlaat, met (of zonder) Anna en Bram als vennoten. */
async function vof(naam, { vennoten = true } = {}) {
  const w = await maakEenmanszaak(naam, { rechtsvorm: 'vof', resultaatrekening: '0510' });
  if (vennoten) {
    w.anna = gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: null, p_name: 'Anna', p_profit_share_basis_points: 6000 }, w.eigenaar.token), 'vennoot Anna');
    w.bram = gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: null, p_name: 'Bram', p_profit_share_basis_points: 4000 }, w.eigenaar.token), 'vennoot Bram');
  }
  return w;
}

async function maakLeverancier(w, naam, iban, extra = {}) {
  return gelukt(await rest('suppliers?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: w.eigenaar.id, name: naam, iban, ...extra },
  }), `leverancier ${naam}`)[0];
}

function conceptInkoop(w, lev, datum, regels) {
  const netto = regels.reduce((s, r) => s + r.amount_cents, 0);
  const btw = regels.reduce((s, r) => s + Math.round(r.amount_cents * (r.vat_rate ?? 0) / 100), 0);
  return rest('purchase_invoices?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, supplier_id: lev.id, supplier_invoice_number: `INK-${randomUUID().slice(0, 6)}`,
      date: datum, due_date: datum, subtotal_cents: netto, vat_cents: btw, total_cents: netto + btw, currency: 'EUR', status: 'draft',
      lines: regels.map((r) => ({ id: randomUUID(), ...r })),
    },
  });
}

function boekInkoop(w, id) {
  return rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: id }, w.eigenaar.token);
}

/** Gerrie zet een handeling klaar, zoals in de chat: als de eigenaar, met dezelfde plan-code. */
let gerrieKern = null;
async function gerrie(w, actionId, input) {
  gerrieKern ??= await import(new URL('../../supabase/functions/_shared/gerrieCore.ts', import.meta.url).href);
  const ctx = await gerrieKern.buildContext(w.orgId, 'owner', { id: w.eigenaar.id, email: w.eigenaar.email });
  return gerrieKern.buildProposal(ctx, 'propose_action', { action_id: actionId, input });
}

// ── 1. Geen btw op privé via de inkoop ──────────────────────────────────

async function inkoopPrive() {
  groep('Vof — geen voorbelasting op privé via een inkoopfactuur');
  const w = await stap('een vof met Anna en Bram, en een drukkerij als leverancier', async () => {
    const w0 = await vof('vofinkoop');
    w0.t = {
      kosten: await rekening(w0, '4500'),
      prive: await rekening(w0, '0552'),
      lev: await maakLeverancier(w0, 'Drukkerij Noord', 'NL55DRUK0123456789'),
    };
    gelijk(w0.t.prive.type, 'equity', '0552 is eigen vermogen (privé van een vennoot)');
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('opslaan: een regel "Privédeel Bram" van € 50 op 0552 met 21% wordt geweigerd', async () => {
    const res = await conceptInkoop(w, t.lev, '2026-10-05', [
      { description: 'Visitekaartjes', amount_cents: 80000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id },
      { description: 'Privédeel Bram', amount_cents: 5000, vat_code: 'HOOG', vat_rate: 21, account_id: t.prive.id },
    ]);
    geweigerd(res, 'btw op 0552');
    verwacht(/Privédeel Bram/.test(res.tekst) && /0552/.test(res.tekst) && /eigen vermogen/.test(res.tekst) && /voorbelasting/.test(res.tekst),
      `melding: ${res.tekst.slice(0, 300)}`);
  });

  await stap('zo hoort het: het privédeel inclusief btw op 0552, met 0%; alleen de zakelijke btw is voorbelasting', async () => {
    const pi = gelukt(await conceptInkoop(w, t.lev, '2026-10-05', [
      { description: 'Visitekaartjes', amount_cents: 80000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id },
      { description: 'Privédeel Bram', amount_cents: 6050, vat_code: 'NUL', vat_rate: 0, account_id: t.prive.id },
    ]), 'opslaan met 0% op 0552')[0];
    gelukt(await boekInkoop(w, pi.id), 'boeken');
    gelijk([mutatie(w, '4500'), mutatie(w, '0552'), mutatie(w, '1500')], [80000, 6050, 16800], '4500, 0552 en 1500');
    const r = await rubrieken(w, '2026-10-01', '2026-12-31');
    gelijk(r['5b'], 168, 'rubriek 5b: alleen de btw van de visitekaartjes');
  });

  await stap('een concept van vóór deze regel (btw op 0552) boeken wordt geweigerd; 1500 en 5b blijven gelijk', async () => {
    const pi = gelukt(await conceptInkoop(w, t.lev, '2026-10-07', [
      { description: 'Flyers', amount_cents: 10000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id },
    ]), 'concept')[0];
    // Zoals een concept dat vóór de controle bij het opslaan is opgeslagen:
    // de triggers staan even uit, zodat alleen het boeken hem nog kan tegenhouden.
    const regels = [
      { id: randomUUID(), description: 'Flyers', amount_cents: 10000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id },
      { id: randomUUID(), description: 'Privédeel Bram', amount_cents: 5000, vat_code: 'HOOG', vat_rate: 21, account_id: t.prive.id },
    ];
    sql(`set session_replication_role = replica;
         update public.purchase_invoices set lines = ${q(JSON.stringify(regels))}::jsonb, subtotal_cents = 15000, vat_cents = 3150, total_cents = 18150
         where id = ${q(pi.id)};`);
    const res = await boekInkoop(w, pi.id);
    geweigerd(res, 'boeken met btw op 0552');
    verwacht(/Privédeel Bram/.test(res.tekst) && /eigen vermogen/.test(res.tekst), `melding: ${res.tekst.slice(0, 300)}`);
    gelijk(sqlRij(`select status from public.purchase_invoices where id = ${q(pi.id)}`).status, 'draft', 'het blijft een concept');
    gelijk(mutatie(w, '1500'), 16800, '1500 onveranderd');
    gelijk((await rubrieken(w, '2026-10-01', '2026-12-31'))['5b'], 168, 'rubriek 5b onveranderd');
  });

  await stap('Gerrie: purchase_invoice.update met 21% op 0552 weigert vooraf; met 0% kan het', async () => {
    const pi = gelukt(await conceptInkoop(w, t.lev, '2026-10-08', [
      { description: 'Enveloppen', amount_cents: 2000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id },
    ]), 'concept')[0];
    const fout = await gerrie(w, 'purchase_invoice.update', { purchase_invoice_id: pi.id, lines: [
      { description: 'Enveloppen', amount_eur: 20, vat_code: 'HOOG', account_id: t.kosten.id },
      { description: 'Privédeel Bram', amount_eur: 50, vat_code: 'HOOG', account_id: t.prive.id },
    ] });
    gelijk(fout.ok, false, 'geen kaart');
    verwacht(/Privédeel Bram/.test(fout.error) && /eigen vermogen/.test(fout.error), `melding: ${fout.error}`);
    const goed = await gerrie(w, 'purchase_invoice.update', { purchase_invoice_id: pi.id, lines: [
      { description: 'Enveloppen', amount_eur: 20, vat_code: 'HOOG', account_id: t.kosten.id },
      { description: 'Privédeel Bram', amount_eur: 60.5, vat_code: 'NUL', account_id: t.prive.id },
    ] });
    verwacht(goed.ok === true, `met 0%: ${goed.error}`);
  });

  await stap('Gerrie: supplier.update met 0552 als standaardrekening en een btw-code weigert vooraf', async () => {
    gelukt(await rest(`suppliers?id=eq.${t.lev.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=minimal',
      body: { default_expense_account_id: t.kosten.id, default_vat_code: 'HOOG' } }), 'standaard 4500 met 21%');
    const beide = await gerrie(w, 'supplier.update', { supplier_id: t.lev.id, default_expense_account_id: t.prive.id, default_vat_code: 'HOOG' });
    gelijk(beide.ok, false, '0552 met HOOG: geen kaart');
    verwacht(/0552/.test(beide.error) && /btw-code/.test(beide.error), `melding: ${beide.error}`);
    // Alleen de rekening: de btw-code die er al stond (HOOG) blijft anders staan.
    const rekeningAlleen = await gerrie(w, 'supplier.update', { supplier_id: t.lev.id, default_expense_account_id: t.prive.id });
    gelijk(rekeningAlleen.ok, false, 'alleen 0552, met HOOG van eerder: geen kaart');
    const zonder = await gerrie(w, 'supplier.update', { supplier_id: t.lev.id, default_expense_account_id: t.prive.id, default_vat_code: null });
    verwacht(zonder.ok === true, `0552 zonder btw-code: ${zonder.error}`);
  });

  await stap('de leverancier zelf: 0552 als standaard mét btw-code weigert de database, zonder mag het', async () => {
    const res = await rest(`suppliers?id=eq.${t.lev.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=minimal',
      body: { default_expense_account_id: t.prive.id, default_vat_code: 'HOOG' } });
    geweigerd(res, '0552 met HOOG als standaard');
    verwacht(/0552/.test(res.tekst) && /btw-code/.test(res.tekst), `melding: ${res.tekst.slice(0, 300)}`);
    gelukt(await rest(`suppliers?id=eq.${t.lev.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=minimal',
      body: { default_expense_account_id: t.prive.id, default_vat_code: null } }), '0552 zonder btw-code');
    const rij = sqlRij(`select default_expense_account_id, default_vat_code from public.suppliers where id = ${q(t.lev.id)}`);
    gelijk([rij.default_expense_account_id, rij.default_vat_code], [t.prive.id, null], 'zo staat hij');
  });
}

// ── 2. Een privé betaalde factuur niet nog eens via de bank ─────────────

async function priveBetaald() {
  groep('Vof — een privé betaalde factuur wordt niet nog eens als kosten geboekt');
  const IBAN = 'NL55DRUK0123456789';
  const w = await stap('een vof met een drukkerij (standaard 4500, 21%) en een bankregel "Drukkerij → 4500, 21%, vanzelf" die nog uit staat', async () => {
    const w0 = await vof('vofbank');
    w0.t = { bank: await bankrekening(w0), kosten: await rekening(w0, '4500') };
    w0.t.lev = await maakLeverancier(w0, 'Drukkerij Noord', IBAN, { default_expense_account_id: w0.t.kosten.id, default_vat_code: 'HOOG' });
    w0.t.regel = gelukt(await rest('bank_rules?select=*', { method: 'POST', token: w0.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: w0.orgId, created_by: w0.eigenaar.id, name: 'Drukkerij', match_direction: 'out', match_counterparty_name_contains: 'Drukkerij',
      target_account_id: w0.t.kosten.id, target_vat_code: 'HOOG', auto_book: true, is_active: false, priority: 1,
    } }), 'bankregel')[0];
    return w0;
  });
  if (!w) return;
  const t = w.t;
  const lees = (regels) => rpc('import_bank_transactions', {
    p_organization_id: w.orgId, p_bank_account_id: t.bank.id, p_statement: { format: 'csv', file_name: `v-${randomUUID()}.csv` }, p_transactions: regels,
  }, w.eigenaar.token);
  const rijen = (bedrag) => sqlRijen(`select id, status, auto_booked, match_reason, suggested_account_id, suggested_vat_code, matched_purchase_invoice_id
    from public.bank_transactions where bank_account_id = ${q(t.bank.id)} and amount_cents = ${bedrag} order by created_at`);
  const matchen = async () => gelukt(await rpc('match_bank_transactions', { p_organization_id: w.orgId, p_bank_account_id: t.bank.id }, w.eigenaar.token), 'opnieuw matchen');
  const oktober = () => [mutatie(w, '4500', '2026-10-01', '2026-10-31'), mutatie(w, '1500', '2026-10-01', '2026-10-31')];
  const reden = /Deze factuur \(.+\) staat als privé betaald door Anna op 06-10-2026\. Betaalde de zaak hem, draai dan eerst de privébetaling terug \(Grootboek → Journaal: tegenboeken\) en boek deze betaling op de factuur\./;

  await stap('drukwerk van € 968 (€ 800 + 21%), geboekt en privé betaald door Anna', async () => {
    t.pi = await inkoopfactuur(w, t.lev, '2026-10-05', [{ description: 'Drukwerk', amount_cents: 80000, vat_code: 'HOOG', vat_rate: 21, account_id: t.kosten.id }]);
    const res = gelukt(await rpc('pay_purchase_invoice_privately', {
      p_organization_id: w.orgId, p_purchase_invoice_id: t.pi.id, p_partner_id: w.anna.id, p_date: '2026-10-06',
    }, w.eigenaar.token), 'privé betaald door Anna');
    t.prive = (Array.isArray(res) ? res[0] : res).id;
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(t.pi.id)}`).payment_status, 'paid', 'de factuur is betaald');
    gelijk(oktober(), [80000, 16800], 'oktober: € 800 kosten en € 168 voorbelasting');
  });

  await stap('zonder bankregel: de incasso van € 968 krijgt geen voorstel 4500 met 21%, wel de reden', async () => {
    gelukt(await lees([{ booking_date: '2026-10-20', amount_cents: -96800, counterparty_name: 'Drukkerij Noord', counterparty_iban: IBAN, description: 'Incasso drukwerk' }]), 'de incasso');
    const rij = rijen(-96800)[0];
    gelijk([rij.status, rij.suggested_account_id, rij.suggested_vat_code, rij.matched_purchase_invoice_id], ['unmatched', null, null, null], 'geen voorstel');
    verwacht(reden.test(rij.match_reason ?? ''), `reden: ${rij.match_reason}`);
  });

  await stap('met de bankregel aan: niet vanzelf geboekt, en oktober blijft € 800 kosten en € 168 voorbelasting', async () => {
    gelukt(await rest(`bank_rules?id=eq.${t.regel.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=minimal', body: { is_active: true } }), 'bankregel aan');
    await matchen();
    const rij = rijen(-96800)[0];
    gelijk([rij.status, rij.auto_booked], ['unmatched', false], 'niet geboekt');
    verwacht(reden.test(rij.match_reason ?? ''), `reden: ${rij.match_reason}`);
    gelijk(oktober(), [80000, 16800], 'oktober');
  });

  await stap('een ander bedrag van de drukkerij boekt de bankregel gewoon', async () => {
    gelukt(await lees([{ booking_date: '2026-11-03', amount_cents: -12100, counterparty_name: 'Drukkerij Noord', counterparty_iban: IBAN, description: 'Pasbetaling' }]), 'pasbetaling');
    const rij = rijen(-12100)[0];
    gelijk([rij.status, rij.auto_booked], ['booked', true], 'vanzelf geboekt door de bankregel');
  });

  await stap('de weg uit de reden: de privébetaling tegenboeken en opnieuw matchen; de incasso betaalt dan de factuur', async () => {
    gelukt(await rpc('reverse_journal_entry', { p_entry_id: nodig(t.prive, 'privébetaling') }, w.eigenaar.token), 'privébetaling tegenboeken');
    await matchen();
    const rij = rijen(-96800)[0];
    gelijk(rij.status, 'booked', 'de incasso is geboekt');
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(t.pi.id)}`).payment_status, 'paid', 'betaald via de bank');
    gelijk(oktober(), [80000, 16800], 'oktober: nog steeds één keer');
    const anna = sqlRij(`select la.code from public.partnership_partners pp join public.ledger_accounts la on la.id = pp.contributions_account_id where pp.id = ${q(w.anna.id)}`);
    gelijk([mutatie(w, '1600'), mutatie(w, anna.code)], [0, 0], '1600 en de privé-stortingen van Anna op nul');
  });
}

// ── 3. Inkomstenbelasting van een vennoot ───────────────────────────────

async function belastingdienst() {
  groep('Vof — inkomstenbelasting via de bank hoort bij een vennoot, niet op 0550');
  const lees = (w, bank, regels) => rpc('import_bank_transactions', {
    p_organization_id: w.orgId, p_bank_account_id: bank.id, p_statement: { format: 'csv', file_name: `b-${randomUUID()}.csv` }, p_transactions: regels,
  }, w.eigenaar.token);
  const aanslag = { booking_date: '2026-11-04', amount_cents: -250000, counterparty_name: 'Belastingdienst', counterparty_iban: 'NL86INGB0002445588', description: 'Betalingskenmerk 1234 5678 9012 3456' };
  const reden = (bank) => sqlRij(`select status, match_reason from public.bank_transactions where bank_account_id = ${q(bank.id)} and amount_cents = -250000`);

  await stap('een vof met vennoten: de reden noemt de privé-opnamen van de vennoot wiens aanslag het is', async () => {
    const w = await vof('vofib');
    const bank = await bankrekening(w);
    gelukt(await lees(w, bank, [aanslag]), 'betaling aan de Belastingdienst');
    const codes = sqlRijen(`select la.code || ' ' || pp.name as label from public.partnership_partners pp
      join public.ledger_accounts la on la.id = pp.withdrawals_account_id where pp.organization_id = ${q(w.orgId)} order by la.code`).map((r) => r.label);
    gelijk(codes, ['0551 Anna', '0552 Bram'], 'de privé-opnamen van Anna en Bram');
    const rij = reden(bank);
    gelijk(rij.status, 'unmatched', 'geen voorstel');
    verwacht(rij.match_reason.includes('boek op de privé-opnamen van de vennoot wiens aanslag het is (0551 Anna, 0552 Bram)'), `reden: ${rij.match_reason}`);
    verwacht(!/boek op 0550/.test(rij.match_reason) && /1530 Te betalen omzetbelasting/.test(rij.match_reason), `reden: ${rij.match_reason}`);
  });

  await stap('een vof zonder vennoten: nog steeds 0550', async () => {
    const w = await vof('vofzonder', { vennoten: false });
    const bank = await bankrekening(w);
    gelukt(await lees(w, bank, [aanslag]), 'betaling aan de Belastingdienst');
    const rij = reden(bank);
    verwacht(/boek op 0550 Privé-opnamen/.test(rij.match_reason), `reden: ${rij.match_reason}`);
  });
}

export default async function vofBankInkoop() {
  await inkoopPrive();
  await priveBetaald();
  await belastingdienst();
}
