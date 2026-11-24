// Vof: wie halverwege het jaar in- of uittreedt, deelt alleen in de winst van
// zijn eigen periode; het kapitaal van een uittreder wordt een schuld aan hem;
// een commanditaire vennoot draagt niet meer verlies dan hij inbracht; en elke
// vennoot heeft een rekening-courant.
//
// Waarom dit scenario: na 20261122100000 hoorde de verdeling bij het boekjaar,
// maar in- of uittreden halverwege moest de gebruiker zelf uitrekenen en als
// "bedrag vooraf" vastleggen. Het kapitaal van een uittreder bleef eigen
// vermogen, een commanditaire vennoot droeg verlies tot ver onder nul, en een
// lening van een vennoot kon alleen op zijn privé (en verdween bij de
// jaarafsluiting in zijn kapitaal). Zie
// supabase/migrations/20261124120000_vof_tijdlijn_en_rekening_courant.sql en
// docs/changelog/CHANGELOG_VOF_TIJDLIJN_2026-11-24.md.
//
// Alles als de eigenaar, via REST en RPC met zijn eigen sessie (RLS geldt).
// De KOR staat aan, zodat de jaarafsluiting geen btw-aangiften vraagt; daar
// gaat dit niet over. De raming rekent met de code van de app
// (buildIncomeTaxOverview, splitYearResult); waar het om dezelfde centen gaat,
// vergelijkt het scenario die met de database.
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { bankmutatie, bankrekening, boekMutatie, invoeren, maakEenmanszaak, nodig, q } from './eenmanszaak.mjs';
import { buildIncomeTaxOverview, projectYearResult, splitYearResult } from '../../src/lib/inkomstenbelasting.ts';

const VANDAAG = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());

/** Een vof (of cv) met vennoten die er al vanaf 2025 waren. */
async function vof(naam, vennoten, { rechtsvorm = 'vof' } = {}) {
  const w = await maakEenmanszaak(naam, { rechtsvorm, resultaatrekening: '0510', start: '2025-01-01', kor: true });
  w.vennoten = {};
  for (const [wie, bp, soort = 'beherend'] of vennoten) {
    w.vennoten[wie] = gelukt(await rpc('save_partnership_partner', {
      p_organization_id: w.orgId, p_partner_id: null, p_name: wie, p_profit_share_basis_points: bp, p_kind: soort,
    }, w.eigenaar.token), `vennoot ${wie}`);
  }
  // Vastgelegd in 2025, zoals in het echt (dit scenario legt ze vandaag vast).
  sql(`do $$ begin
         alter table public.partnership_partners disable trigger partnership_partners_track_share_change;
         update public.partnership_partners set created_at = '2025-01-01T09:00:00+01', share_changed_at = '2025-01-01T09:00:00+01'
           where organization_id = ${q(w.orgId)};
         alter table public.partnership_partners enable trigger partnership_partners_track_share_change;
       end $$;`);
  return w;
}

function jaar(w, label) {
  return sqlRij(`select id, label, status from public.fiscal_years where organization_id = ${q(w.orgId)} and label = ${q(label)}`);
}

function memoriaal(w, datum, omschrijving, regels) {
  return rpc('post_journal_entry', {
    p_organization_id: w.orgId, p_date: datum, p_description: omschrijving, p_source_type: 'manual', p_source_id: null, p_lines: regels,
  }, w.eigenaar.token);
}

async function winst(w, datum, cent) {
  gelukt(await memoriaal(w, datum, cent >= 0 ? 'Omzet' : 'Kosten', cent >= 0
    ? [{ account_code: '1100', debit_cents: cent }, { account_code: '8000', credit_cents: cent }]
    : [{ account_code: '4500', debit_cents: -cent }, { account_code: '1100', credit_cents: -cent }]), 'resultaat boeken');
}

/** Saldo credit − debet (eigen vermogen en schulden positief). */
function saldo(w, code) {
  return -Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and je.status = 'posted' and la.code = ${q(code)}`));
}

async function overzicht(w, label) {
  return gelukt(await rpc('owners_equity_overview', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, label).id }, w.eigenaar.token), `Vennoten ${label}`);
}

const vennoot = (ov, naam) => ov.owners.find((o) => o.name === naam);

function wijzig(w, wie, bp, { actief = true, soort = 'beherend', per = null } = {}) {
  return rpc('save_partnership_partner', {
    p_organization_id: w.orgId, p_partner_id: w.vennoten[wie].id, p_name: wie, p_profit_share_basis_points: bp,
    p_kind: soort, p_is_active: actief, p_effective_date: per,
  }, w.eigenaar.token);
}

function afsluiten(w, label) {
  return rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, label).id }, w.eigenaar.token);
}

async function invoer(w, jaartal) {
  return gelukt(await rpc('get_income_tax_inputs', { p_organization_id: w.orgId, p_year: jaartal, p_hours: true }, w.eigenaar.token), `raming ${jaartal}`);
}

/** Wat de database per vennoot geeft voor een (eventueel geprojecteerd) resultaat. */
function databaseVerdeling(w, label, resultaat) {
  return Object.fromEntries(sqlRijen(`select name, share_cents from public.fiscal_year_result_shares(${q(w.orgId)}, ${q(jaar(w, label).id)}, ${resultaat})`)
    .map((r) => [r.name, Number(r.share_cents)]));
}

/** Gerrie zet een handeling klaar, zoals in de chat. */
let gerrieKern = null;
async function gerrie(w, actionId, input) {
  gerrieKern ??= await import(new URL('../../supabase/functions/_shared/gerrieCore.ts', import.meta.url).href);
  const ctx = await gerrieKern.buildContext(w.orgId, 'owner', { id: w.eigenaar.id, email: w.eigenaar.email });
  return gerrieKern.buildProposal(ctx, 'propose_action', { action_id: actionId, input });
}

// ── 1. Uittreden halverwege het jaar ─────────────────────────────────────

async function uittredenHalverwege() {
  groep('Vof — Bram treedt per 1 juli 2025 uit: hij deelt in de eerste helft, en zijn kapitaal wordt een schuld aan hem');
  const w = await stap('Anna en Bram 50/50; € 6.000 winst in maart, € 4.000 in september', async () => {
    const w0 = await vof('tluit', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w0, '2025-03-01', 600000);
    await winst(w0, '2025-09-01', 400000);
    return w0;
  });
  if (!w) return;

  await stap('Bram uitgetreden per 1 juli, Anna 100% per 1 juli: twee perioden, zonder iets vast te leggen', async () => {
    gelukt(await wijzig(w, 'Bram', 5000, { actief: false, per: '2025-07-01' }), 'Bram uit');
    gelukt(await wijzig(w, 'Anna', 10000, { per: '2025-07-01' }), 'Anna 100%');
    const ov = await overzicht(w, '2025');
    gelijk(ov.splitMode, 'automatisch', 'de verdeling volgt de tijdlijn');
    gelijk(ov.periods.map((p) => [p.periodStart, p.periodEnd, p.resultCents]), [['2025-01-01', '2025-06-30', 600000], ['2025-07-01', '2025-12-31', 400000]], 'de perioden met hun resultaat');
    gelijk([vennoot(ov, 'Anna').resultShareCents, vennoot(ov, 'Bram').resultShareCents], [700000, 300000], 'Anna € 7.000, Bram € 3.000');
    gelijk([vennoot(ov, 'Bram').leftOn, vennoot(ov, 'Bram').toCurrentAccountCents], ['2025-07-01', 300000], 'bij afsluiten gaat Brams € 3.000 naar zijn rekening-courant');
  });

  await stap('Gerrie: de afsluitkaart noemt de perioden en de rekening-courant', async () => {
    const kaart = await gerrie(w, 'fiscal_year.close', { fiscal_year_id: jaar(w, '2025').id });
    verwacht(kaart.ok === true, `kaart: ${kaart.error}`);
    const sub = kaart.proposal?.sub ?? '';
    verwacht(/2 perioden/.test(sub) && /Bram/.test(sub) && /rekening-courant/.test(sub), `kaart: ${sub}`);
  });

  await stap('afsluiten: Anna € 7.000 op 0501, Brams € 3.000 op zijn rekening-courant 1412 en niet meer op 0502', async () => {
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([saldo(w, '0501'), saldo(w, '0502'), saldo(w, '1412')], [700000, 0, 300000], 'kapitaal en rekening-courant');
    const ov = await overzicht(w, '2025');
    gelijk([vennoot(ov, 'Bram').resultShareCents, vennoot(ov, 'Bram').toCurrentAccountCents, vennoot(ov, 'Bram').endCents, vennoot(ov, 'Bram').currentAccountCents],
      [300000, 300000, 0, 300000], 'Vennoten 2025: aandeel, naar rekening-courant, eind nul, schuld aan Bram');
  });

  await stap('Bram uitbetalen via de bank op zijn rekening-courant: de schuld is weg, het eigen vermogen blijft', async () => {
    const bank = await bankrekening(w);
    const rc = sqlRij(`select id from public.ledger_accounts where organization_id = ${q(w.orgId)} and code = '1412'`);
    await bankmutatie(w, nodig(bank, 'bank'), '2026-02-01', -300000, 'Uitbetaling Bram', [{ kind: 'ledger', account_id: rc.id, amount_cents: 300000 }]);
    gelijk([saldo(w, '1412'), saldo(w, '0501')], [0, 700000], 'rekening-courant nul, Anna ongemoeid');
  });

  await stap('de raming van 2025 (afgesloten) neemt het geboekte bedrag: Anna € 7.000, Bram € 3.000', async () => {
    const inputs = await invoer(w, 2025);
    const raming = nodig(buildIncomeTaxOverview(inputs, { basis: 'geboekt', today: VANDAAG }), 'raming');
    gelijk(raming.persons.map((p) => [p.name, p.estimate.profitShareCents]), [['Anna', 700000], ['Bram', 300000]], 'winstaandelen');
  });
}

// ── 2. Toetreden halverwege, en dezelfde centen in database en app ───────

async function toetredenHalverwege() {
  groep('Vof — Chris treedt per 1 juli 2026 toe: de raming en de database verdelen hetzelfde, ook in de prognose');
  const w = await stap('Anna en Bram 50/50; per 1 juli Anna 40, Bram 30 en Chris 30; € 6.000 winst in maart, € 3.000 in augustus', async () => {
    const w0 = await vof('tltoe', [['Anna', 5000], ['Bram', 5000]]);
    w0.vennoten.Chris = gelukt(await rpc('save_partnership_partner', {
      p_organization_id: w0.orgId, p_partner_id: null, p_name: 'Chris', p_profit_share_basis_points: 3000, p_effective_date: '2026-07-01',
    }, w0.eigenaar.token), 'Chris');
    gelukt(await wijzig(w0, 'Anna', 4000, { per: '2026-07-01' }), 'Anna 40%');
    gelukt(await wijzig(w0, 'Bram', 3000, { per: '2026-07-01' }), 'Bram 30%');
    await winst(w0, '2026-03-01', 600000);
    await winst(w0, '2026-08-01', 300000);
    return w0;
  });
  if (!w) return;

  await stap('Vennoten 2026: Anna € 4.200, Bram € 3.900, Chris € 900', async () => {
    const ov = await overzicht(w, '2026');
    gelijk(['Anna', 'Bram', 'Chris'].map((n) => vennoot(ov, n).resultShareCents), [420000, 390000, 90000], 'winstaandelen');
    gelijk(vennoot(ov, 'Chris').joinedOn, '2026-07-01', 'Chris sinds 1 juli');
    gelijk(ov.shareTotalBasisPoints, 10000, 'elke periode komt op 100%');
  });

  await stap('de raming (geboekt) geeft dezelfde centen als de database', async () => {
    const inputs = await invoer(w, 2026);
    verwacht(inputs.partnerSplit && inputs.partnerSplit.periods.length === 2, `perioden: ${JSON.stringify(inputs.partnerSplit)}`);
    const raming = nodig(buildIncomeTaxOverview(inputs, { basis: 'geboekt', today: VANDAAG }), 'raming');
    gelijk(Object.fromEntries(raming.persons.map((p) => [p.name, p.estimate.profitShareCents])), databaseVerdeling(w, '2026', inputs.resultCents), 'raming = database');
  });

  await stap('de prognose: het verschil komt in de periode van vandaag, in de raming en in de database', async () => {
    const inputs = await invoer(w, 2026);
    const prognose = nodig(projectYearResult({ resultCents: inputs.resultCents, year: 2026, today: VANDAAG, startDate: inputs.bookkeepingStartDate }), 'prognose');
    const app = splitYearResult(inputs.partnerSplit, prognose.projectedCents);
    const db = databaseVerdeling(w, '2026', prognose.projectedCents);
    gelijk(Object.fromEntries([...app.shares].map(([id, c]) => [Object.entries(w.vennoten).find(([, v]) => v.id === id)[0], c])), db, `prognose ${prognose.projectedCents}: app = database`);
    verwacht(db.Anna + db.Bram + db.Chris === prognose.projectedCents, 'samen precies de prognose');
  });

  await stap('een correctie zonder datum verandert de stand van nu, een wijziging met een datum maakt een nieuwe stand', async () => {
    const voor = Number(sql(`select count(*) from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Bram.id)}`));
    gelukt(await wijzig(w, 'Bram', 3100), 'correctie zonder datum');
    gelijk(Number(sql(`select count(*) from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Bram.id)}`)), voor, 'geen nieuwe stand');
    gelijk(Number(sql(`select share_basis_points from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Bram.id)} order by valid_from desc limit 1`)), 3100, 'de laatste stand is gecorrigeerd');
    gelukt(await wijzig(w, 'Bram', 3000), 'terug');
    gelukt(await wijzig(w, 'Bram', 3000, { per: '2026-10-01' }), 'zelfde stand met datum: niets nieuws');
    gelijk(Number(sql(`select count(*) from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Bram.id)}`)), voor, 'een gelijke stand maakt geen periode');
  });

  await stap('een verkeerde stand weghalen kan, de eerste stand niet', async () => {
    const chrisEerste = sqlRij(`select id from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Chris.id)} order by valid_from limit 1`);
    geweigerd(await rpc('delete_partnership_partner_change', { p_organization_id: w.orgId, p_change_id: chrisEerste.id }, w.eigenaar.token), 'de eerste stand');
    gelukt(await wijzig(w, 'Anna', 3000, { per: '2026-10-01' }), 'Anna 30% per oktober (vergissing)');
    const fout = sqlRij(`select id from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Anna.id)} and valid_from = '2026-10-01'`);
    gelukt(await rpc('delete_partnership_partner_change', { p_organization_id: w.orgId, p_change_id: fout.id }, w.eigenaar.token), 'weghalen');
    const ov = await overzicht(w, '2026');
    gelijk(ov.periods.length, 2, 'weer twee perioden');
    gelijk(Number(sqlRij(`select profit_share_basis_points from public.partnership_partners where id = ${q(w.vennoten.Anna.id)}`).profit_share_basis_points), 4000, 'Anna staat weer op 40%');
  });
}

// ── 3. Een datum in een afgesloten jaar, en de oude weigering ─────────────

async function grenzen() {
  groep('Vof — een ingangsdatum in een afgesloten jaar, en wijzigingen van vóór de tijdlijn');
  await stap('een ingangsdatum in een afgesloten jaar wordt geweigerd', async () => {
    const w = await vof('tldicht', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w, '2025-03-01', 100000);
    gelukt(await afsluiten(w, '2025'), 'afsluiten 2025');
    const res = await wijzig(w, 'Bram', 5000, { actief: false, per: '2025-07-01' });
    geweigerd(res, 'uittreden in een afgesloten jaar');
    verwacht(/afgesloten/.test(res.tekst), `melding: ${res.tekst}`);
    gelukt(await wijzig(w, 'Bram', 5000, { actief: false, per: '2026-01-01' }), 'per 1 januari 2026 mag');
    // Ook een nieuwe vennoot: eerst kwam die met een datum in 2025 stil in het
    // afgesloten jaar, en verdeelde heropenen en opnieuw afsluiten 2025 anders.
    const nieuw = await rpc('save_partnership_partner', {
      p_organization_id: w.orgId, p_partner_id: null, p_name: 'Chris', p_profit_share_basis_points: 0, p_effective_date: '2025-07-01',
    }, w.eigenaar.token);
    geweigerd(nieuw, 'een nieuwe vennoot in een afgesloten jaar');
    verwacht(/afgesloten/.test(nieuw.tekst), `melding: ${nieuw.tekst}`);
    const chris = gelukt(await rpc('save_partnership_partner', {
      p_organization_id: w.orgId, p_partner_id: null, p_name: 'Chris', p_profit_share_basis_points: 5000, p_effective_date: '2026-01-01',
    }, w.eigenaar.token), 'Chris per 1 januari 2026');
    // Een wijziging na het afgesloten jaar weghalen kan gewoon.
    const brams = sqlRij(`select id from public.partnership_partner_timeline where partner_id = ${q(w.vennoten.Bram.id)} and valid_from = '2026-01-01'`);
    gelukt(await rpc('delete_partnership_partner_change', { p_organization_id: w.orgId, p_change_id: brams.id }, w.eigenaar.token), 'de uittreding per 2026 weghalen mag');
    gelijk(Number(sql(`select count(*) from public.partnership_partner_timeline where partner_id = ${q(chris.id)} and valid_from <= '2025-12-31'`)), 0, 'Chris niet in 2025');
  });

  await stap('een wijziging van vóór de tijdlijn, na het jaareinde: afsluiten weigert nog, tot de verdeling vastligt', async () => {
    const w = await vof('tloud', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w, '2025-03-01', 100000);
    // Zo stond een vennoot er vóór 20261124120000 bij: gewijzigd in november
    // 2026, zonder ingangsdatum, en de tijdlijn begon pas daarna.
    sql(`do $$ begin
           alter table public.partnership_partners disable trigger partnership_partners_track_share_change;
           update public.partnership_partners set share_changed_at = now() - interval '1 hour', timeline_since = now()
             where id = ${q(w.vennoten.Bram.id)};
           alter table public.partnership_partners enable trigger partnership_partners_track_share_change;
         end $$;`);
    const res = await afsluiten(w, '2025');
    geweigerd(res, 'een wijziging zonder datum');
    verwacht(/\(Bram\)/.test(res.tekst), `melding: ${res.tekst}`);
    gelukt(await rpc('set_fiscal_year_partner_shares', {
      p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, '2025').id,
      p_shares: [{ partner_id: w.vennoten.Anna.id, share_basis_points: 5000 }, { partner_id: w.vennoten.Bram.id, share_basis_points: 5000 }],
    }, w.eigenaar.token), 'verdeling vastleggen');
    gelukt(await afsluiten(w, '2025'), 'daarna afsluiten');
  });
}

// ── 4. De rekening-courant ───────────────────────────────────────────────

async function rekeningCourant() {
  groep('Vof — elke vennoot een rekening-courant: een lening is een schuld, geen privé');
  const w = await stap('Anna en Bram, met een bankrekening', async () => {
    const w0 = await vof('tlrc', [['Anna', 5000], ['Bram', 5000]]);
    w0.bank = await bankrekening(w0);
    return w0;
  });
  if (!w) return;

  await stap('1411 en 1412 bestaan, als kortlopende schuld, op naam van de vennoot', async () => {
    const rijen = sqlRijen(`select code, name, type, subtype, report_group from public.ledger_accounts
      where organization_id = ${q(w.orgId)} and subtype = 'partner_current_account' order by code`);
    gelijk(rijen.map((r) => [r.code, r.name, r.type, r.report_group]), [
      ['1411', 'Rekening-courant Anna', 'liability', 'kortlopende_schulden'],
      ['1412', 'Rekening-courant Bram', 'liability', 'kortlopende_schulden'],
    ], 'de rekeningen');
    geweigerd(await rest('ledger_accounts', { method: 'POST', token: w.eigenaar.token, body: {
      organization_id: w.orgId, code: '1413', name: 'Eigen rekening', type: 'liability',
    } }), '141n is gereserveerd');
  });

  await stap('Anna leent de vof € 5.000: op haar rekening-courant, niet op privé; met btw wordt geweigerd', async () => {
    const rc = sqlRij(`select id from public.ledger_accounts where organization_id = ${q(w.orgId)} and code = '1411'`);
    await bankmutatie(w, nodig(w.bank, 'bank'), '2026-03-01', 500000, 'Lening Anna', [{ kind: 'ledger', account_id: rc.id, amount_cents: 500000 }]);
    gelijk([saldo(w, '1411'), saldo(w, '0561')], [500000, 0], 'schuld aan Anna, geen privé-storting');
    const txn = await invoeren(w, nodig(w.bank, 'bank'), '2026-03-05', 12100, 'Met btw');
    const metBtw = await boekMutatie(w, txn, [{ kind: 'ledger', account_id: rc.id, vat_code: 'HOOG', amount_cents: 12100 }]);
    geweigerd(metBtw, 'btw op een rekening-courant');
  });

  await stap('de jaarafsluiting laat de rekening-courant staan', async () => {
    await winst(w, '2025-04-01', 200000);
    gelukt(await afsluiten(w, '2025'), 'afsluiten 2025');
    gelijk(saldo(w, '1411'), 500000, 'de lening staat er nog');
  });
}

// ── 5. De verliesgrens van de commanditaire vennoot ──────────────────────

async function verliesgrens() {
  groep('Cv — Kees (commanditair, € 1.000 ingebracht) draagt niet meer dan zijn inbreng');
  const w = await stap('Anna 50% en Bram 20% beherend, Kees 30% commanditair met € 1.000 inbreng; € 10.000,01 verlies in 2025', async () => {
    const w0 = await vof('tlcv', [['Anna', 5000], ['Bram', 2000], ['Kees', 3000, 'commanditair']], { rechtsvorm: 'cv' });
    gelukt(await memoriaal(w0, '2025-01-02', 'Inbreng Kees', [{ account_code: '1100', debit_cents: 100000 }, { account_code: '0563', credit_cents: 100000 }]), 'inbreng');
    await winst(w0, '2025-05-01', -1000001);
    return w0;
  });
  if (!w) return;

  await stap('de raming en de database: Kees − € 1.000, de rest naar Anna en Bram, samen het hele verlies', async () => {
    const inputs = await invoer(w, 2025);
    gelijk(inputs.partnerSplit?.lossCaps?.[w.vennoten.Kees.id], 100000, 'de grens van Kees: zijn inbreng');
    const db = databaseVerdeling(w, '2025', -1000001);
    gelijk(db, { Anna: -642858, Bram: -257143, Kees: -100000 }, 'database');
    const raming = nodig(buildIncomeTaxOverview(inputs, { basis: 'geboekt', today: VANDAAG }), 'raming');
    gelijk(Object.fromEntries(raming.persons.map((p) => [p.name, p.estimate.profitShareCents])), db, 'raming = database');
    verwacht(raming.persons.find((p) => p.name === 'Kees').notes.some((n) => /begrensd tot de inbreng/.test(n)), 'de raming zegt het bij Kees');
  });

  await stap('afsluiten: het kapitaal van Kees komt op nul, niet eronder', async () => {
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([saldo(w, '0503'), saldo(w, '0563'), saldo(w, '0501'), saldo(w, '0502')], [0, 0, -642858, -257143], 'kapitaal na afsluiten');
    const ov = await overzicht(w, '2025');
    gelijk([vennoot(ov, 'Kees').lossShiftCents, vennoot(ov, 'Anna').lossShiftCents + vennoot(ov, 'Bram').lossShiftCents], [200000, -200000], 'Vennoten: wat er verschoof');
  });
}

export default async function vofTijdlijn() {
  await uittredenHalverwege();
  await toetredenHalverwege();
  await grenzen();
  await rekeningCourant();
  await verliesgrens();
}
