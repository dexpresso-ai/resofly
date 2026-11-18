// De raming van de inkomstenbelasting, van begin tot eind tegen een lokale stack.
//
// Wat hier wordt nagelopen (CHANGELOG_INKOMSTENBELASTING_RAMING_2026-11-18.md):
//   1. eenmanszaak: de winst van het KALENDERJAAR uit het journaal (een ander
//      jaar en de jaarafsluiting tellen niet mee), de eigen uren en die van de
//      eigenaar (de standaard voor het urencriterium, zoals Eigen vermogen),
//      opslaan en bijwerken van de gegevens, en een raming die tot op de cent
//      klopt met de los nagerekende som (€ 50.000 winst in 2026: € 9.674,05);
//   2. wie wat mag: lezen met leesrecht op Financiën, schrijven alleen met
//      schrijfrecht, niets zonder Financiën of van buiten, en niemand die
//      rechtstreeks in de tabellen schrijft;
//   3. de invoer: AOW-maand, bedragen, jaar, soort en richting van een
//      correctie;
//   4. correcties en KIA: toevoegen, een activum uitsluiten, verwijderen, en
//      nooit een activum of vennoot van een andere organisatie — ook niet als
//      iemand de functies omzeilt (de samengestelde sleutel); eten, drinken en
//      representatie op 4600 tellen vanzelf mee;
//   5. vof en cv: per vennoot, met dezelfde verdeling als de jaarafsluiting
//      (partnership_result_shares), en een commanditaire vennoot die geen
//      ondernemer is;
//   6. een stichting krijgt geen raming; het logboek zet alles onder Financiën.
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';
import { buildIncomeTaxOverview } from '../../src/lib/inkomstenbelasting.ts';

const JAAR = 2026;
const VANDAAG = '2026-11-18';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

async function rekeningId(w, code) {
  const rij = gelukt(await rest(`ledger_accounts?select=id&organization_id=eq.${w.orgId}&code=eq.${code}`, { token: w.medewerker.token }), `rekening ${code}`)[0];
  return nodig(rij?.id, `grootboekrekening ${code}`);
}

function invoer(w, gebruiker, jaar = JAAR, orgId = w.orgId, extra = {}) {
  return rpc('get_income_tax_inputs', { p_organization_id: orgId, p_year: jaar, ...extra }, gebruiker.token);
}

function profiel(w, gebruiker, waarden, orgId = w.orgId) {
  return rpc('save_income_tax_profile', {
    p_organization_id: orgId, p_year: JAAR, p_partner_id: null, p_meets_hours_criterion: null, p_starter: false,
    p_aow_status: 'nee', p_aow_month: null, p_loss_carry_forward_cents: 0, p_other_entrepreneur_deduction_cents: 0,
    p_provisional_income_tax_cents: 0, p_provisional_zvw_cents: 0, ...waarden,
  }, gebruiker.token);
}

function correctie(w, gebruiker, waarden, orgId = w.orgId) {
  return rpc('add_income_tax_correction', {
    p_organization_id: orgId, p_year: JAAR, p_partner_id: null, p_code: 'overig', p_label: 'Correctie', p_amount_cents: 10000, ...waarden,
  }, gebruiker.token);
}

async function boek(w, datum, omschrijving, regels) {
  return gelukt(await rpc('post_journal_entry', {
    p_organization_id: w.orgId, p_date: datum, p_description: omschrijving, p_source_type: 'manual', p_source_id: null, p_lines: regels,
  }, w.medewerker.token), `boeking ${omschrijving}`);
}

async function activum(w, rekeningen, naam, datum, kostenCents) {
  const rij = gelukt(await rest('fixed_assets?select=id,name', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.medewerker.id, name: naam, acquisition_date: datum, start_date: datum,
      acquisition_cost_cents: kostenCents, residual_value_cents: 0, useful_life_months: 60,
      asset_account_id: rekeningen.activa, depreciation_account_id: rekeningen.afschrijving, accumulated_depreciation_account_id: rekeningen.cumulatief,
    },
  }), `activum ${naam}`)[0];
  return nodig(rij?.id, `activum ${naam}`);
}

function rechtsvorm(w, vorm) {
  return rest(`company_settings?organization_id=eq.${w.orgId}&select=legal_form`, {
    method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { legal_form: vorm },
  });
}

function raming(inputs, basis = 'geboekt') {
  return nodig(buildIncomeTaxOverview(inputs, { basis, today: VANDAAG }), 'raming');
}

// ── Het scenario ────────────────────────────────────────────────────────

export default async function inkomstenbelasting() {
  groep('Inkomstenbelasting — een raming per ondernemer en per vennoot');

  const w = await maakWereld('ib');
  const ander = await maakWereld('ib-ander');

  const basis = await stap('eenmanszaak: de winst van het kalenderjaar, zonder ander jaar en zonder jaarafsluiting', async () => {
    gelukt(await rechtsvorm(w, 'eenmanszaak'), 'rechtsvorm eenmanszaak');
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: w.orgId }, w.medewerker.token), 'rekeningschema');
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: ander.orgId }, ander.medewerker.token), 'rekeningschema andere organisatie');
    const r = {
      bank: await rekeningId(w, '1100'), omzet: await rekeningId(w, '8000'), kosten: await rekeningId(w, '4500'),
      activa: await rekeningId(w, '0100'), afschrijving: await rekeningId(w, '4000'), cumulatief: await rekeningId(w, '0150'),
    };
    await boek(w, `${JAAR}-03-01`, 'Omzet maart', [
      { account_id: r.bank, description: 'Omzet', debit_cents: 6_000_000, credit_cents: 0 },
      { account_id: r.omzet, description: 'Omzet', debit_cents: 0, credit_cents: 6_000_000 },
    ]);
    await boek(w, `${JAAR}-04-01`, 'Kosten april', [
      { account_id: r.kosten, description: 'Kosten', debit_cents: 1_000_000, credit_cents: 0 },
      { account_id: r.bank, description: 'Kosten', debit_cents: 0, credit_cents: 1_000_000 },
    ]);
    // Het jaar ervoor telt niet mee voor 2026.
    await boek(w, `${JAAR - 1}-12-31`, 'Omzet vorig jaar', [
      { account_id: r.bank, description: 'Omzet', debit_cents: 500_000, credit_cents: 0 },
      { account_id: r.omzet, description: 'Omzet', debit_cents: 0, credit_cents: 500_000 },
    ]);
    // Eigen uren als hint bij het urencriterium; die van een collega niet.
    sql(`insert into public.time_entries (organization_id, user_id, entry_date, minutes)
         values (${q(w.orgId)}, ${q(w.medewerker.id)}, '${JAAR}-02-02', 600),
                (${q(w.orgId)}, ${q(w.medewerker.id)}, '${JAAR - 1}-02-02', 6000),
                (${q(w.orgId)}, ${q(w.beheerder.id)}, '${JAAR}-02-02', 900)`);

    let inputs = gelukt(await invoer(w, w.medewerker), 'invoer ophalen');
    gelijk([inputs.year, inputs.legalForm, inputs.isPartnershipForm, inputs.resultCents, inputs.mixedCostsCents], [JAAR, 'eenmanszaak', false, 5_000_000, 0], 'jaar, rechtsvorm en winst');
    gelijk([inputs.partners, inputs.profiles, inputs.corrections, inputs.investments], [[], [], [], []], 'nog niets vastgelegd');
    gelijk([inputs.myMinutes, inputs.ownerMinutes], [600, 0], 'je eigen uren en die van de eigenaar (nog geen)');
    gelijk(gelukt(await invoer(w, w.medewerker, JAAR - 1), 'vorig jaar').resultCents, 500_000, 'de winst van het jaar ervoor');
    // Zonder gegevens volgt het urencriterium de uren van de eigenaar: 0 uur, dus niet.
    const zonder = raming(inputs);
    gelijk([zonder.persons[0].hoursFromTimeTracking, zonder.persons[0].estimate.zelfstandigenaftrekCents], [true, 0], 'geen zelfstandigenaftrek zonder uren');
    verwacht(zonder.persons[0].notes.some((n) => /volgens Uren: de eigenaar heeft 0 uur/.test(n)), 'de raming zegt waar het urencriterium vandaan komt');
    // De eigenaar schrijft 1.230 uur: dan wel, zonder iets op te slaan.
    sql(`insert into public.time_entries (organization_id, user_id, entry_date, minutes)
         values (${q(w.orgId)}, ${q(w.eigenaar.id)}, '${JAAR}-03-03', ${1230 * 60})`);
    inputs = gelukt(await invoer(w, w.medewerker), 'invoer met uren van de eigenaar');
    gelijk(inputs.ownerMinutes, 1230 * 60, 'de uren van de eigenaar');
    gelijk(raming(inputs).persons[0].estimate.zelfstandigenaftrekCents, 120_000, 'zelfstandigenaftrek volgens Uren');
    // Wie Uren niet mag lezen, of Gerrie die het niet vraagt: geen uren.
    gelijk(gelukt(await invoer(w, w.boekhouder), 'boekhouder').ownerMinutes, null, 'de boekhouder (geen Uren) ziet geen uren');
    gelijk(gelukt(await invoer(w, w.lezer), 'lezer').ownerMinutes, 1230 * 60, 'de lezer mag Uren wel lezen');
    gelijk(gelukt(await invoer(w, w.medewerker, JAAR, w.orgId, { p_hours: false }), 'zonder uren').ownerMinutes, null, 'zonder p_hours geen uren');
    return r;
  });

  await stap('opslaan en bijwerken: de raming klopt tot op de cent', async () => {
    nodig(basis, 'basis');
    const rij = gelukt(await profiel(w, w.medewerker, { p_meets_hours_criterion: true, p_provisional_income_tax_cents: 800_000, p_provisional_zvw_cents: 200_000 }), 'opslaan');
    gelijk([rij.meets_hours_criterion, rij.provisional_income_tax_cents, rij.partner_id, rij.year], [true, 800_000, null, JAAR], 'het opgeslagen profiel');
    // Nog een keer: bijwerken, geen tweede rij.
    gelukt(await profiel(w, w.medewerker, { p_meets_hours_criterion: true, p_provisional_income_tax_cents: 800_000, p_provisional_zvw_cents: 200_000, p_aow_status: 'nee' }), 'opnieuw opslaan');
    gelijk(sql(`select count(*) from public.income_tax_profiles where organization_id = ${q(w.orgId)}`), '1', 'één rij per persoon per jaar');

    const inputs = gelukt(await invoer(w, w.medewerker), 'invoer');
    gelijk(inputs.profiles.length, 1, 'het profiel komt mee');
    const e = raming(inputs).persons[0].estimate;
    // Los nagerekend (src/lib/inkomstenbelasting.test.ts): € 50.000 winst in 2026
    // met het urencriterium: IB € 7.607,83 + Zvw € 2.066,22.
    gelijk([e.zelfstandigenaftrekCents, e.mkbExemptionCents, e.taxableIncomeCents], [120_000, 619_760, 4_260_240], 'aftrek en grondslag');
    gelijk([e.incomeTaxCents, e.zvwCents, e.totalCents], [760_783, 206_622, 967_405], 'inkomstenbelasting en Zvw');
    gelijk(e.balanceCents, 967_405 - 1_000_000, 'na de voorlopige aanslagen: terug');
  });

  await stap('rechten: lezen met leesrecht, schrijven met schrijfrecht, niets zonder Financiën of van buiten', async () => {
    gelukt(await invoer(w, w.lezer), 'lezer leest');
    geweigerd(await profiel(w, w.lezer, { p_meets_hours_criterion: false }), 'lezer schrijft niet');
    geweigerd(await correctie(w, w.lezer, {}), 'lezer voegt geen correctie toe');
    geweigerd(await invoer(w, w.zonderFinancien), 'zonder Financiën niets');
    geweigerd(await profiel(w, w.zonderFinancien, {}), 'zonder Financiën geen opslaan');
    geweigerd(await invoer(w, ander.eigenaar), 'een andere organisatie leest niet');
    geweigerd(await profiel(w, ander.eigenaar, {}), 'een andere organisatie schrijft niet');
    geweigerd(await rpc('get_income_tax_inputs', { p_organization_id: w.orgId, p_year: JAAR }), 'anoniem niets');
    // Rechtstreeks in de tabellen: lezen gaat met de modulepoort, schrijven nooit.
    gelijk(gelukt(await rest(`income_tax_profiles?select=id&organization_id=eq.${w.orgId}`, { token: w.lezer.token }), 'lezer leest de tabel').length, 1, 'de lezer ziet de rij');
    gelijk(gelukt(await rest(`income_tax_profiles?select=id&organization_id=eq.${w.orgId}`, { token: w.zonderFinancien.token }), 'zonder Financiën').length, 0, 'zonder Financiën geen rij');
    gelijk(gelukt(await rest(`income_tax_profiles?select=id&organization_id=eq.${w.orgId}`, { token: ander.eigenaar.token }), 'andere organisatie').length, 0, 'van buiten geen rij');
    geweigerd(await rest('income_tax_profiles', {
      method: 'POST', token: w.eigenaar.token, body: { organization_id: w.orgId, year: JAAR - 1, meets_hours_criterion: true },
    }), 'rechtstreeks een profiel schrijven');
    nietsVeranderd(await rest(`income_tax_profiles?organization_id=eq.${w.orgId}`, {
      method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { provisional_income_tax_cents: 1 },
    }), 'rechtstreeks een profiel aanpassen');
    geweigerd(await rest('income_tax_corrections', {
      method: 'POST', token: w.eigenaar.token, body: { organization_id: w.orgId, year: JAAR, code: 'overig', label: 'x', amount_cents: 1 },
    }), 'rechtstreeks een correctie schrijven');
    gelijk(sqlRij(`select provisional_income_tax_cents from public.income_tax_profiles where organization_id = ${q(w.orgId)}`)?.provisional_income_tax_cents, 800_000, 'onveranderd');
  });

  await stap('de invoer wordt gecontroleerd', async () => {
    geweigerd(await profiel(w, w.medewerker, { p_aow_status: 'in_jaar' }), 'AOW in de loop van het jaar zonder maand');
    geweigerd(await profiel(w, w.medewerker, { p_aow_status: 'in_jaar', p_aow_month: 13 }), 'maand 13');
    geweigerd(await profiel(w, w.medewerker, { p_aow_status: 'misschien' }), 'onbekende AOW-stand');
    geweigerd(await profiel(w, w.medewerker, { p_loss_carry_forward_cents: -1 }), 'negatief verlies');
    geweigerd(await profiel(w, w.medewerker, { p_provisional_zvw_cents: 100_000_000_001 }), 'meer dan een miljard');
    geweigerd(await rpc('save_income_tax_profile', {
      p_organization_id: w.orgId, p_year: 1999, p_partner_id: null, p_meets_hours_criterion: true, p_starter: false, p_aow_status: 'nee',
      p_aow_month: null, p_loss_carry_forward_cents: 0, p_other_entrepreneur_deduction_cents: 0, p_provisional_income_tax_cents: 0, p_provisional_zvw_cents: 0,
    }, w.medewerker.token), 'jaar 1999');
    geweigerd(await invoer(w, w.medewerker, 2101), 'jaar 2101');
    // AOW in juli: de maand wordt bewaard, en weer weggehaald bij "nee".
    gelijk(gelukt(await profiel(w, w.medewerker, { p_meets_hours_criterion: true, p_aow_status: 'in_jaar', p_aow_month: 7, p_provisional_income_tax_cents: 800_000, p_provisional_zvw_cents: 200_000 }), 'AOW in juli').aow_month, 7, 'de maand');
    gelijk(gelukt(await profiel(w, w.medewerker, { p_meets_hours_criterion: true, p_aow_status: 'nee', p_aow_month: 7, p_provisional_income_tax_cents: 800_000, p_provisional_zvw_cents: 200_000 }), 'AOW weer nee').aow_month, null, 'geen maand zonder "in de loop van het jaar"');

    geweigerd(await correctie(w, w.medewerker, { p_code: 'boete' }), 'onbekende soort');
    geweigerd(await correctie(w, w.medewerker, { p_label: '   ' }), 'lege omschrijving');
    geweigerd(await correctie(w, w.medewerker, { p_amount_cents: 0 }), 'nul');
    geweigerd(await correctie(w, w.medewerker, { p_code: 'investeringsaftrek', p_amount_cents: 50_000 }), 'investeringsaftrek positief');
    geweigerd(await correctie(w, w.medewerker, { p_code: 'privegebruik_auto', p_amount_cents: -50_000 }), 'bijtelling negatief');
    geweigerd(await correctie(w, w.medewerker, { p_label: 'x'.repeat(201) }), 'omschrijving te lang');
    gelijk(sql(`select count(*) from public.income_tax_corrections where organization_id = ${q(w.orgId)}`), '0', 'niets opgeslagen');
  });

  const assets = await stap('correcties en KIA: toevoegen, uitsluiten, verwijderen; nooit van een ander', async () => {
    const r = nodig(basis, 'basis');
    const auto = gelukt(await correctie(w, w.medewerker, { p_code: 'privegebruik_auto', p_label: 'Bijtelling auto', p_amount_cents: 300_000 }), 'bijtelling');
    gelukt(await correctie(w, w.medewerker, { p_code: 'investeringsaftrek', p_label: 'EIA warmtepomp', p_amount_cents: -100_000 }), 'EIA');
    gelukt(await correctie(w, w.medewerker, { p_code: 'overig', p_label: 'Overige', p_amount_cents: -50_000 }), 'overig negatief');

    // Eten, drinken en representatie: € 1.000 op 4600. Het niet-aftrekbare deel
    // (20%) telt vanzelf mee, net als op Eigen vermogen.
    const representatie = await rekeningId(w, '4600');
    await boek(w, `${JAAR}-05-05`, 'Lunch met een klant', [
      { account_id: representatie, description: 'Lunch', debit_cents: 100_000, credit_cents: 0 },
      { account_id: r.bank, description: 'Lunch', debit_cents: 0, credit_cents: 100_000 },
    ]);

    const laptop = await activum(w, r, 'Laptop', `${JAAR}-03-01`, 350_000);
    const bus = await activum(w, r, 'Personenauto', `${JAAR}-05-01`, 4_000_000);
    await activum(w, r, 'Oud bureau', `${JAAR - 1}-06-01`, 120_000);
    const ra = {
      activa: await rekeningId(ander, '0100'), afschrijving: await rekeningId(ander, '4000'), cumulatief: await rekeningId(ander, '0150'),
    };
    const vreemd = await activum(ander, ra, 'Van een ander', `${JAAR}-03-01`, 500_000);

    let inputs = gelukt(await invoer(w, w.medewerker), 'invoer');
    gelijk(inputs.investments.map((i) => [i.name, i.costCents, i.excluded]), [['Laptop', 350_000, false], ['Personenauto', 4_000_000, false]], 'alleen de activa van dit jaar');
    gelukt(await rpc('set_income_tax_kia_exclusion', { p_organization_id: w.orgId, p_asset_id: bus, p_excluded: true }, w.medewerker.token), 'auto uitsluiten');
    gelukt(await rpc('set_income_tax_kia_exclusion', { p_organization_id: w.orgId, p_asset_id: bus, p_excluded: true }, w.medewerker.token), 'nog eens: geen fout');
    inputs = gelukt(await invoer(w, w.medewerker), 'invoer');
    gelijk(inputs.investments.map((i) => i.excluded), [false, true], 'de auto telt niet mee');
    const o = raming(inputs);
    gelijk([inputs.resultCents, inputs.mixedCostsCents], [4_900_000, 100_000], 'de lunch gaat van de winst af en staat op 4600');
    gelijk([o.mixedCosts?.addBackCents, o.mixedCosts?.method], [20_000, 'percentage'], '20% niet aftrekbaar');
    gelijk([o.investmentTotalCents, o.kiaCents], [350_000, 98_000], 'KIA 28% over de laptop');
    gelijk(o.persons[0].estimate.correctionsCents, 20_000 + 300_000 - 100_000 - 50_000, 'de correcties tellen mee, met 4600 vanzelf');
    gelijk(o.persons[0].estimate.profitCents, 4_900_000 + 170_000 - 98_000, 'winst uit onderneming');

    // Een activum van een ander: niet via de eigen organisatie, niet via die van de ander.
    geweigerd(await rpc('set_income_tax_kia_exclusion', { p_organization_id: w.orgId, p_asset_id: vreemd, p_excluded: true }, w.medewerker.token), 'activum van een ander');
    geweigerd(await rpc('set_income_tax_kia_exclusion', { p_organization_id: ander.orgId, p_asset_id: bus, p_excluded: true }, w.medewerker.token), 'via de andere organisatie');
    geweigerd(await rpc('set_income_tax_kia_exclusion', { p_organization_id: w.orgId, p_asset_id: laptop, p_excluded: true }, w.lezer.token), 'lezer sluit niets uit');
    // Ook wie de functies omzeilt, kan geen rij naar een ander laten wijzen.
    let fout = null;
    try { sql(`insert into public.income_tax_kia_exclusions (organization_id, asset_id) values (${q(w.orgId)}, ${q(vreemd)})`); } catch (e) { fout = String(e?.stderr ?? e); }
    verwacht(fout && /income_tax_kia_exclusions_asset_fkey/.test(fout), `de samengestelde sleutel houdt een activum van een ander tegen (${fout})`);

    gelukt(await rpc('set_income_tax_kia_exclusion', { p_organization_id: w.orgId, p_asset_id: bus, p_excluded: false }, w.medewerker.token), 'auto weer meetellen');
    gelijk(gelukt(await invoer(w, w.medewerker), 'invoer').investments.map((i) => i.excluded), [false, false], 'de auto telt weer mee');
    gelukt(await rpc('set_income_tax_kia_exclusion', { p_organization_id: w.orgId, p_asset_id: bus, p_excluded: true }, w.medewerker.token), 'auto weer uitsluiten');

    geweigerd(await rpc('delete_income_tax_correction', { p_organization_id: w.orgId, p_correction_id: auto.id }, w.lezer.token), 'lezer verwijdert niets');
    geweigerd(await rpc('delete_income_tax_correction', { p_organization_id: ander.orgId, p_correction_id: auto.id }, ander.eigenaar.token), 'via een andere organisatie');
    gelukt(await rpc('delete_income_tax_correction', { p_organization_id: w.orgId, p_correction_id: auto.id }, w.medewerker.token), 'verwijderen');
    geweigerd(await rpc('delete_income_tax_correction', { p_organization_id: w.orgId, p_correction_id: auto.id }, w.medewerker.token), 'nog eens verwijderen');
    gelijk(sql(`select count(*) from public.income_tax_corrections where organization_id = ${q(w.orgId)}`), '2', 'twee correcties over');
    return { laptop, bus };
  });

  await stap('vof: per vennoot, met dezelfde verdeling als de jaarafsluiting', async () => {
    nodig(assets, 'activa');
    gelukt(await rechtsvorm(w, 'vof'), 'rechtsvorm vof');
    const anna = gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: null, p_name: 'Anna', p_profit_share_basis_points: 6000 }, w.medewerker.token), 'vennoot Anna');
    const bram = gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: null, p_name: 'Bram', p_profit_share_basis_points: 4000 }, w.medewerker.token), 'vennoot Bram');
    gelukt(await rechtsvorm(ander, 'vof'), 'de andere organisatie wordt een vof');
    const anderVennoot = gelukt(await rpc('save_partnership_partner', { p_organization_id: ander.orgId, p_partner_id: null, p_name: 'Vreemd', p_profit_share_basis_points: 10000 }, ander.medewerker.token), 'vennoot andere organisatie');

    // Bram hangt aan een teamlid met 1.300 uur: zonder opgeslagen keuze vult de
    // raming zijn urencriterium daarmee in, zoals Vennoten de uren toont.
    gelukt(await rpc('set_partnership_partner_member', { p_organization_id: w.orgId, p_partner_id: bram.id, p_user_id: w.beheerder.id }, w.medewerker.token), 'Bram aan een teamlid');
    sql(`insert into public.time_entries (organization_id, user_id, entry_date, minutes)
         values (${q(w.orgId)}, ${q(w.beheerder.id)}, '${JAAR}-04-04', ${1300 * 60})`);
    const metUren = gelukt(await invoer(w, w.medewerker), 'invoer met uren per vennoot');
    gelijk([metUren.ownerMinutes, metUren.partnerMinutes], [null, { [bram.id]: 1300 * 60 + 900 }], 'alleen de uren van de gekoppelde vennoot (plus zijn 15 minuten van eerder)');
    const bramVooraf = raming(metUren).persons.find((p) => p.partnerId === bram.id);
    gelijk([bramVooraf?.hoursFromTimeTracking, bramVooraf?.estimate.zelfstandigenaftrekCents], [true, 120_000], 'Bram volgens Uren');
    gelijk(gelukt(await invoer(w, w.boekhouder), 'boekhouder').partnerMinutes, null, 'de boekhouder ziet geen uren');

    gelukt(await profiel(w, w.medewerker, { p_partner_id: anna.id, p_meets_hours_criterion: true, p_starter: true }), 'Anna: urencriterium en starter');
    gelukt(await profiel(w, w.medewerker, { p_partner_id: bram.id, p_meets_hours_criterion: false }), 'Bram: geen urencriterium');
    gelukt(await correctie(w, w.medewerker, { p_partner_id: bram.id, p_code: 'privegebruik_auto', p_label: 'Auto Bram', p_amount_cents: 200_000 }), 'correctie voor Bram');
    geweigerd(await correctie(w, w.medewerker, { p_partner_id: anderVennoot.id }), 'correctie op een vennoot van een ander');
    geweigerd(await profiel(w, w.medewerker, { p_partner_id: anderVennoot.id }), 'profiel van een vennoot van een ander');
    let fout = null;
    try { sql(`insert into public.income_tax_profiles (organization_id, year, partner_id) values (${q(w.orgId)}, ${JAAR}, ${q(anderVennoot.id)})`); } catch (e) { fout = String(e?.stderr ?? e); }
    verwacht(fout && /income_tax_profiles_partner_fkey/.test(fout), `de samengestelde sleutel houdt een vennoot van een ander tegen (${fout})`);

    const inputs = gelukt(await invoer(w, w.medewerker), 'invoer vof');
    gelijk([inputs.isPartnershipForm, inputs.partners.map((p) => [p.name, p.shareBasisPoints, p.kind])], [true, [['Anna', 6000, 'beherend'], ['Bram', 4000, 'beherend']]], 'de vennoten');
    const o = raming(inputs);
    gelijk(o.persons.map((p) => p.name), ['Anna', 'Bram'], 'een raming per vennoot');
    // Dezelfde verdeling als de jaarafsluiting boekt.
    const db = sqlRijen(`select name, share_cents from public.partnership_result_shares(${q(w.orgId)}, ${inputs.resultCents}) order by partner_number`);
    gelijk(o.persons.map((p) => p.estimate.profitShareCents), db.map((r) => Number(r.share_cents)), 'winstaandelen zoals partnership_result_shares');
    const [a, b] = o.persons;
    gelijk(a.estimate.kiaCents + b.estimate.kiaCents, o.kiaCents, 'de KIA helemaal verdeeld');
    gelijk([a.estimate.startersaftrekCents, b.estimate.zelfstandigenaftrekCents], [212_300, 0], 'starter Anna, geen aftrek voor Bram');
    verwacht(b.corrections.some((c) => c.label === 'Auto Bram' && !c.shared) && !a.corrections.some((c) => c.label === 'Auto Bram'), 'de bijtelling alleen bij Bram');
    gelijk(o.totals.totalCents, a.estimate.totalCents + b.estimate.totalCents, 'het totaal is de som van de vennoten');
    // Het profiel van de eenmanszaak (zonder vennoot) telt bij een vof met vennoten niet mee.
    verwacht(o.persons.every((p) => p.partnerId !== null), 'geen ondernemer zonder vennoot');
  });

  await stap('cv: een commanditaire vennoot is geen ondernemer', async () => {
    gelukt(await rechtsvorm(w, 'cv'), 'rechtsvorm cv');
    const stil = gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: null, p_name: 'Stil', p_profit_share_basis_points: 0, p_kind: 'commanditair' }, w.medewerker.token), 'stille vennoot');
    const rij = gelukt(await profiel(w, w.medewerker, { p_partner_id: stil.id, p_meets_hours_criterion: true, p_starter: true, p_other_entrepreneur_deduction_cents: 5_000_000, p_provisional_income_tax_cents: 10_000 }), 'profiel stille vennoot');
    gelijk([rij.meets_hours_criterion, rij.starter, rij.other_entrepreneur_deduction_cents, rij.provisional_income_tax_cents], [null, false, 0, 10_000], 'geen ondernemersgegevens, wel de voorlopige aanslag');
    const o = raming(gelukt(await invoer(w, w.medewerker), 'invoer cv'));
    const p = o.persons.find((x) => x.name === 'Stil');
    gelijk([p?.kind, p?.estimate.entrepreneurDeductionCents, p?.estimate.mkbExemptionCents, p?.estimate.labourCreditCents], ['commanditair', 0, 0, 0], 'geen aftrek, vrijstelling of arbeidskorting');
  });

  await stap('stichting: geen raming; het logboek zet alles onder Financiën', async () => {
    gelukt(await rechtsvorm(w, 'stichting'), 'rechtsvorm stichting');
    geweigerd(await invoer(w, w.medewerker), 'geen invoer bij een stichting');
    geweigerd(await profiel(w, w.medewerker, {}), 'geen opslaan bij een stichting');
    gelukt(await rechtsvorm(w, 'eenmanszaak'), 'terug naar eenmanszaak');

    const soorten = sqlRijen(`select entity_type, count(*)::int as n from public.audit_logs
      where organization_id = ${q(w.orgId)} and entity_type in ('income_tax_profile', 'income_tax_correction') group by entity_type order by entity_type`);
    verwacht(soorten.length === 2 && soorten.every((s) => s.n > 0), `profielen en correcties in het logboek (${JSON.stringify(soorten)})`);
    gelijk(sql(`select public.audit_entity_module('income_tax_profile') || ',' || public.audit_entity_module('income_tax_correction')`), 'finance,finance', 'onder Financiën');
    // De bedragen staan er niet met hun waarde in: alleen "gewijzigd".
    const wijzigingen = sqlRijen(`select metadata from public.audit_logs where organization_id = ${q(w.orgId)} and entity_type = 'income_tax_profile' and action = 'updated'`);
    verwacht(wijzigingen.length > 0, 'een bijgewerkt profiel staat in het logboek');
    verwacht(wijzigingen.every((r) => !JSON.stringify(r.metadata ?? {}).includes('800000')), 'geen bedragen in het logboek');
  });
}
