// De boekhouder die mag boeken.
//
// Waarom dit scenario: de boekhouder (het gratis gastaccount) kon alleen lezen.
// De controle van 22 november 2026 (bevinding 6) speelde het na: een memoriaal,
// de btw-aangifte afsluiten, een boekjaar heropenen en het IB-profiel gaven
// allemaal 403. Sinds 20261122133000 kan de eigenaar "mag boeken" aanzetten.
// Dan mag de boekhouder corrigeren en afsluiten, en verder niets: geen
// facturen, geen inkoop, geen bank, geen klanten, geen team, en niets
// rechtstreeks via REST.
//
// Alles met de eigen sessie van de boekhouder (RLS geldt), uitgenodigd zoals
// Instellingen → Boekhouder dat doet.
import { randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import {
  bankrekening, boekjaren, inkoopfactuur, klant, kwartaal, leverancier, maakActivum, maakEenmanszaak, nodig, q, rekening, saldo, verstuurdeFactuur,
} from './eenmanszaak.mjs';

export default async function boekhouder() {
  groep('Boekhouder — zonder "mag boeken" alleen lezen, zoals het was');
  const w = await stap('een eenmanszaak met een factuur uit 2025, een camera en een uitgenodigde boekhouder', async () => {
    const w0 = await maakEenmanszaak('boekh');
    const t = (w0.t = {});
    t.klant = await klant(w0, 'Bureau Noord BV', 'business');
    t.factuur = await verstuurdeFactuur(w0, t.klant, '2025-03-10', [{ description: 'Fotoshoot', quantity: 1, unit_price: 1000, vat_rate: 21 }]);
    t.lev = await leverancier(w0, 'Cameraland');
    t.activa = await rekening(w0, '0100');
    t.cameraFactuur = await inkoopfactuur(w0, t.lev, '2025-04-01', [{ description: 'Camera', amount_cents: 200000, vat_code: 'HOOG', vat_rate: 21, account_id: t.activa.id }]);
    t.camera = await maakActivum(w0, { name: 'Camera', acquisition_date: '2025-04-01', start_date: '2025-04-01', acquisition_cost_cents: 200000, source_purchase_invoice_id: t.cameraFactuur.id });
    gelukt(await rpc('book_asset_acquisition', { p_organization_id: w0.orgId, p_asset_id: t.camera.id, p_credit_account_id: null }, w0.eigenaar.token), 'camera koppelen');
    t.bank = await bankrekening(w0);
    w0.boekhouder = await maakGebruiker('boekh-boekhouder');
    const uitnodiging = gelukt(await rpc('invite_organization_member', { p_organization_id: w0.orgId, p_email: w0.boekhouder.email, p_role: 'accountant', p_module_access: {} }, w0.eigenaar.token), 'uitnodigen');
    gelukt(await rpc('accept_organization_invitation', { p_invitation_id: (Array.isArray(uitnodiging) ? uitnodiging[0] : uitnodiging).id }, w0.boekhouder.token), 'accepteren');
    t.lid = sqlRij(`select id, role, accountant_can_book from public.organization_members where organization_id = ${q(w0.orgId)} and user_id = ${q(w0.boekhouder.id)}`);
    gelijk([t.lid.role, t.lid.accountant_can_book], ['accountant', false], 'een boekhouder, standaard zonder boeken');
    t.j2025 = (await boekjaren(w0)).find((j) => j.label === '2025' || String(j.period_start).startsWith('2025'));
    return w0;
  });
  if (!w) return;
  const t = w.t;
  const B = w.boekhouder.token;
  const kosten = await rekening(w, '4500');
  const prive = await rekening(w, '0560').catch(() => null) ?? await rekening(w, '0550');

  const memoriaal = (token, omschrijving, cents = 50000, datum = '2025-12-31') => rpc('post_journal_entry', {
    p_organization_id: w.orgId, p_date: datum, p_description: omschrijving, p_source_type: 'manual', p_source_id: null,
    p_lines: [
      { account_id: prive.id, description: omschrijving, debit_cents: cents, credit_cents: 0 },
      { account_id: kosten.id, description: omschrijving, debit_cents: 0, credit_cents: cents },
    ],
  }, token);
  const sluitQ = (token, jaar, nr) => { const { van, tot } = kwartaal(jaar, nr); return rpc('finalize_vat_return', { p_organization_id: w.orgId, p_period_type: 'quarter', p_year: jaar, p_period_index: nr, p_from: van, p_to: tot }, token); };
  const profiel = (token) => rpc('save_income_tax_profile', {
    p_organization_id: w.orgId, p_year: 2025, p_partner_id: null, p_meets_hours_criterion: true, p_starter: true, p_aow_status: 'nee', p_aow_month: null,
    p_loss_carry_forward_cents: 0, p_other_entrepreneur_deduction_cents: 0, p_provisional_income_tax_cents: 100000, p_provisional_zvw_cents: 0,
  }, token);

  await stap('lezen kan, boeken en afsluiten niet', async () => {
    gelukt(await rpc('report_trial_balance', { p_organization_id: w.orgId, p_as_of: '2025-12-31' }, B), 'proefbalans lezen');
    geweigerd(await memoriaal(B, 'Correctie boekhouder'), 'memoriaal');
    geweigerd(await sluitQ(B, 2025, 1), 'btw-aangifte afsluiten');
    geweigerd(await profiel(B), 'IB-profiel');
    geweigerd(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: nodig(t.j2025, 'boekjaar 2025').id }, B), 'boekjaar afsluiten');
  });

  groep('Boekhouder — "mag boeken": wie zet het aan');
  await stap('de boekhouder zelf niet, een buitenstaander niet, en niet bij een gewoon teamlid', async () => {
    geweigerd(await rpc('set_accountant_booking', { p_member_id: t.lid.id, p_enabled: true }, B), 'de boekhouder zet het zelf aan');
    const vreemde = await maakEenmanszaak('boekh-ander');
    geweigerd(await rpc('set_accountant_booking', { p_member_id: t.lid.id, p_enabled: true }, vreemde.eigenaar.token), 'een eigenaar van een andere organisatie');
    await rest(`organization_members?id=eq.${t.lid.id}`, { method: 'PATCH', token: B, body: { accountant_can_book: true } });
    gelijk(sqlRij(`select accountant_can_book from public.organization_members where id = ${q(t.lid.id)}`).accountant_can_book, false, 'via REST lukt het de boekhouder ook niet');
    const eigen = sqlRij(`select id from public.organization_members where organization_id = ${q(w.orgId)} and user_id = ${q(w.eigenaar.id)}`);
    geweigerd(await rpc('set_accountant_booking', { p_member_id: eigen.id, p_enabled: true }, w.eigenaar.token), 'bij de eigenaar zelf');
    t.vreemde = vreemde;
  });
  await stap('de eigenaar zet het aan', async () => {
    const res = gelukt(await rpc('set_accountant_booking', { p_member_id: t.lid.id, p_enabled: true }, w.eigenaar.token), 'aanzetten');
    gelijk((Array.isArray(res) ? res[0] : res).accountant_can_book, true, 'mag boeken');
    gelijk(gelukt(await rpc('my_module_access', { p_organization_id: w.orgId }, B), 'my_module_access')?.finance ?? null, 'read', 'de vaste regel per module blijft: Financiën lezen');
  });

  groep('Boekhouder — wat hij nu wel kan: corrigeren en afsluiten');
  await stap('een memoriaal, en tegenboeken', async () => {
    const stuk = gelukt(await memoriaal(B, 'Privégebruik auto 2025'), 'memoriaal');
    const id = (Array.isArray(stuk) ? stuk[0] : stuk).id;
    const rij = sqlRij(`select created_by, status from public.journal_entries where id = ${q(id)}`);
    gelijk([rij.created_by, rij.status], [w.boekhouder.id, 'posted'], 'het boekstuk staat op naam van de boekhouder');
    const tegen = gelukt(await memoriaal(B, 'Vergissing'), 'tweede memoriaal');
    gelukt(await rpc('reverse_journal_entry', { p_entry_id: (Array.isArray(tegen) ? tegen[0] : tegen).id }, B), 'tegenboeken');
    gelijk(saldo(w, kosten.code ?? '4500', '2025-12-31'), -50000, 'alleen de correctie staat er nog');
  });
  await stap('een vergeten afschrijving boeken', async () => {
    gelukt(await rpc('post_asset_depreciation', { p_organization_id: w.orgId, p_asset_id: t.camera.id, p_through_date: '2025-12-31' }, B), 'afschrijven');
    verwacht(Number(sqlRij(`select count(*) as n from public.asset_depreciations where asset_id = ${q(t.camera.id)} and journal_entry_id is not null`).n) > 0, 'er is afgeschreven');
  });
  await stap('het IB-profiel en een correctie voor de aangifte', async () => {
    gelukt(await profiel(B), 'IB-profiel opslaan');
    gelijk(sqlRij(`select starter from public.income_tax_profiles where organization_id = ${q(w.orgId)} and year = 2025`)?.starter, true, 'het profiel is bewaard');
  });
  await stap('de btw-aangiften van 2025 afsluiten, op ingediend zetten, en het boekjaar afsluiten en heropenen', async () => {
    for (const nr of [1, 2, 3, 4]) gelukt(await sluitQ(B, 2025, nr), `Q${nr} 2025 afsluiten`);
    const q1 = sqlRij(`select id, status from public.vat_returns where organization_id = ${q(w.orgId)} and year = 2025 and period_index = 1`);
    gelijk(q1.status, 'finalized', 'Q1 is afgesloten');
    gelijk(gelukt(await rpc('set_vat_return_status', { p_organization_id: w.orgId, p_vat_return_id: q1.id, p_status: 'filed' }, B), 'ingediend').status, 'filed', 'Q1 staat op ingediend');
    geweigerd(await rpc('set_vat_return_status', { p_organization_id: w.orgId, p_vat_return_id: q1.id, p_status: 'finalized' }, B), 'terug naar afgesloten');
    gelukt(await rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: t.j2025.id }, B), '2025 afsluiten');
    gelijk((await boekjaren(w)).find((j) => j.id === t.j2025.id).status, 'closed', '2025 is dicht');
    gelukt(await rpc('reopen_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: t.j2025.id }, B), '2025 heropenen');
    gelijk((await boekjaren(w)).find((j) => j.id === t.j2025.id).status, 'open', '2025 is weer open');
  });

  groep('Boekhouder — wat dicht blijft, ook met "mag boeken"');
  await stap('niets rechtstreeks via REST: geen boekstuk, geen factuur, geen rekening, geen bankrekening', async () => {
    const tel = (tabel) => Number(sqlRij(`select count(*) as n from public.${tabel} where organization_id = ${q(w.orgId)}`).n);
    const voor = ['journal_entries', 'invoices', 'ledger_accounts', 'bank_accounts', 'vat_returns', 'clients'].map(tel);
    await rest('journal_entries', { method: 'POST', token: B, body: { organization_id: w.orgId, date: '2025-12-31', description: 'via REST', source_type: 'manual', status: 'posted' } });
    await rest('invoices', { method: 'POST', token: B, body: { organization_id: w.orgId, client_id: t.klant.id, number: 'F-BOEKH', date: '2026-01-05', due_date: '2026-01-19', status: 'draft', lines: [] } });
    await rest('ledger_accounts', { method: 'POST', token: B, body: { organization_id: w.orgId, code: '4999', name: 'Via REST', type: 'expense' } });
    await rest(`bank_accounts?id=eq.${t.bank.id}`, { method: 'DELETE', token: B });
    await rest(`invoices?id=eq.${t.factuur.id}`, { method: 'PATCH', token: B, body: { notes: 'aangepast' } });
    await rest(`vat_returns?organization_id=eq.${w.orgId}`, { method: 'DELETE', token: B });
    await rest(`journal_entries?organization_id=eq.${w.orgId}`, { method: 'PATCH', token: B, body: { description: 'aangepast' } });
    await rest('clients', { method: 'POST', token: B, body: { organization_id: w.orgId, name: 'Via REST' } });
    gelijk(['journal_entries', 'invoices', 'ledger_accounts', 'bank_accounts', 'vat_returns', 'clients'].map(tel), voor, 'er is niets bijgekomen of weggegaan');
    gelijk(sqlRij(`select notes from public.invoices where id = ${q(t.factuur.id)}`).notes, null, 'de factuur is ongewijzigd');
    gelijk(Number(sqlRij(`select count(*) as n from public.journal_entries where organization_id = ${q(w.orgId)} and description = 'aangepast'`).n), 0, 'geen boekstuk aangepast');
  });
  await stap('geen facturen, creditnota\'s, inkoop, bank of betalingen', async () => {
    const wf = (action, extra) => roep('invoice-workflow', { token: B, body: { action, organizationId: w.orgId, ...extra } });
    geweigerd(await wf('sendInvoiceEmail', { invoiceId: t.factuur.id, recipientEmail: 'iemand@elders.test' }), 'factuur versturen');
    geweigerd(await wf('creditInvoice', { invoiceId: t.factuur.id, reason: 'boekhouder' }), 'crediteren');
    geweigerd(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: t.cameraFactuur.id }, B), 'inkoopfactuur boeken');
    geweigerd(await rpc('create_manual_bank_transaction', { p_organization_id: w.orgId, p_bank_account_id: t.bank.id, p_booking_date: '2025-12-30', p_amount_cents: -1000, p_counterparty_name: 'x', p_counterparty_iban: null, p_description: 'x', p_allow_duplicate: true }, B), 'bankmutatie invoeren');
    geweigerd(await rpc('import_bank_transactions', { p_organization_id: w.orgId, p_bank_account_id: t.bank.id, p_statement: { format: 'csv' }, p_transactions: [{ booking_date: '2025-12-30', amount_cents: -100 }] }, B), 'afschrift inlezen');
    geweigerd(await rpc('post_sales_invoice_to_ledger', { p_organization_id: w.orgId, p_invoice_id: t.factuur.id }, B), 'verkoopfactuur boeken');
    geweigerd(await rpc('convert_accepted_quote_to_invoice', { p_quote_id: randomUUID() }, B), 'offerte omzetten');
    geweigerd(await rpc('ensure_default_ledger_accounts', { p_organization_id: w.orgId }, B), 'rekeningschema aanvullen');
  });
  await stap('geen team, geen bedrijfsgegevens, en niets in een andere organisatie', async () => {
    geweigerd(await rpc('invite_organization_member', { p_organization_id: w.orgId, p_email: 'nieuw@elders.test', p_role: 'member', p_module_access: {} }, B), 'iemand uitnodigen');
    await rest(`company_settings?organization_id=eq.${w.orgId}`, { method: 'PATCH', token: B, body: { iban: 'NL00BOEK0000000000' } });
    verwacht(sqlRij(`select iban from public.company_settings where organization_id = ${q(w.orgId)}`).iban !== 'NL00BOEK0000000000', 'het IBAN is ongewijzigd');
    const andereKosten = sqlRij(`select id from public.ledger_accounts where organization_id = ${q(t.vreemde.orgId)} and code = '4500'`);
    const andersPrive = sqlRij(`select id from public.ledger_accounts where organization_id = ${q(t.vreemde.orgId)} and code = ${q(prive.code ?? '0550')}`);
    geweigerd(await rpc('post_journal_entry', {
      p_organization_id: t.vreemde.orgId, p_date: '2025-12-31', p_description: 'in een andere organisatie', p_source_type: 'manual', p_source_id: null,
      p_lines: [{ account_id: andersPrive?.id ?? andereKosten.id, debit_cents: 100, credit_cents: 0 }, { account_id: andereKosten.id, debit_cents: 0, credit_cents: 100 }],
    }, B), 'memoriaal in een andere organisatie');
  });

  groep('Boekhouder — uitzetten en uitschakelen');
  await stap('zet de eigenaar het uit, dan is het weer alleen lezen', async () => {
    gelukt(await rpc('set_accountant_booking', { p_member_id: t.lid.id, p_enabled: false }, w.eigenaar.token), 'uitzetten');
    geweigerd(await memoriaal(B, 'Na het uitzetten'), 'memoriaal na het uitzetten');
    gelukt(await rpc('report_trial_balance', { p_organization_id: w.orgId, p_as_of: '2025-12-31' }, B), 'lezen kan nog');
  });
  await stap('een uitgeschakelde boekhouder met "mag boeken" kan niets', async () => {
    gelukt(await rpc('set_accountant_booking', { p_member_id: t.lid.id, p_enabled: true }, w.eigenaar.token), 'weer aanzetten');
    gelukt(await memoriaal(B, 'Nog één correctie', 1000), 'memoriaal zolang hij actief is');
    sql(`update public.organization_members set status = 'disabled' where id = ${q(t.lid.id)}`);
    geweigerd(await memoriaal(B, 'Na het uitschakelen'), 'memoriaal na het uitschakelen');
    // Uitschakelen zet "mag boeken" uit: wordt hij later weer uitgenodigd, dan
    // kiest de eigenaar opnieuw.
    verwacht(sqlRij(`select accountant_can_book from public.organization_members where id = ${q(t.lid.id)}`).accountant_can_book === false,
      'na het uitschakelen staat "mag boeken" uit');
  });
  await stap('opnieuw uitgenodigd als teamlid: het accepteren lukt, en "mag boeken" is weg', async () => {
    // accept_organization_invitation zet de rol om. Met "mag boeken" nog aan
    // weigerde de check (alleen een boekhouder mag boeken) en lukte dat niet.
    sql(`update public.organization_members set status = 'active', accountant_can_book = true where id = ${q(t.lid.id)}`);
    sql(`select set_config('resofly.accepting_invitation', 'on', false); update public.organization_members set role = 'member' where id = ${q(t.lid.id)}`);
    const rij = sqlRij(`select role, accountant_can_book from public.organization_members where id = ${q(t.lid.id)}`);
    verwacht(rij.role === 'member' && rij.accountant_can_book === false, `rol ${rij.role}, mag boeken ${rij.accountant_can_book}`);
    sql(`update public.organization_members set role = 'accountant', status = 'disabled' where id = ${q(t.lid.id)}`);
  });
  await stap('voor de eigenaar en een gewoon teamlid is er niets veranderd', async () => {
    gelukt(await memoriaal(w.eigenaar.token, 'Eigenaar boekt', 1000), 'de eigenaar boekt een memoriaal');
    void sqlRijen;
  });
}
