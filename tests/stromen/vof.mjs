// Vof: de winst van een jaar gaat naar wie in dát jaar vennoot was, met de
// verdeling en de rechtsvorm van dat jaar.
//
// Waarom dit scenario: de controle van 22 november 2026 speelde na dat de
// jaarafsluiting, de kapitaalvergelijking (Vennoten) en de raming
// inkomstenbelasting alle drie de vennoten, hun percentages en de rechtsvorm
// van VANDAAG lazen:
//   - Bram treedt in februari 2026 uit en 2025 wordt in april afgesloten: de
//     melding stuurde naar "pas de verdeling aan", en wie dat deed gaf Anna de
//     hele winst van 2025 en Bram niets;
//   - Chris treedt in januari toe: hij kreeg winst over 2025;
//   - 2025 netjes afgesloten op 60/40, per 2026 50/30/20: het overzicht van
//     2025 toonde daarna de nieuwe verdeling, het eind van 2025 was niet meer
//     het begin van 2026, en heropenen en opnieuw afsluiten boekte de nieuwe;
//   - na de overstap naar een eenmanszaak sloot het vof-jaar 2025 af als
//     eenmanszaak (alles naar 0500, Bram niets);
//   - een arbeidsbeloning vóór de verdeling kon alleen als memoriaal, en kwam
//     nergens in het winstaandeel dat elke vennoot aangeeft;
//   - een creditnota die op de rekening van een vennoot terugkwam, bleef
//     voorgoed open.
// Zie docs/changelog/CHANGELOG_VOF_HERSTELWEGEN_2026-11-22.md en
// supabase/migrations/20261122100000_vof_verdeling_per_boekjaar.sql.
//
// Sinds 24 november 2026 heeft elke vennoot een tijdlijn met ingangsdatums
// (20261124120000_vof_tijdlijn_en_rekening_courant.sql). Een uittreden of
// toetreden ná het jaar weigert de afsluiting dus niet meer: 2025 rekent
// vanzelf met wie er in 2025 meedeed. Het halverwege splitsen, de
// rekening-courant en de verliesgrens staan in vof-tijdlijn.mjs.
//
// Alles gaat zoals in de app: als de eigenaar, via REST en RPC met zijn eigen
// sessie (RLS geldt). Gerrie zoals in de chat (buildProposal in gerrieCore.ts).
// Vandaag is in november 2026: 2025 kan dicht. De boekhouding heeft de KOR,
// zodat de jaarafsluiting geen btw-aangiften vraagt; daar gaat dit niet over.
import { randomUUID } from 'node:crypto';
import { maakGebruiker, rest, rpc, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { inkoopfactuur, maakEenmanszaak, nodig, q } from './eenmanszaak.mjs';
import { buildIncomeTaxOverview } from '../../src/lib/inkomstenbelasting.ts';

const VANDAAG = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());

/**
 * Een vof met vennoten die er al in 2025 waren (created_at in 2025, zoals in
 * het echt). Met `sinds` een andere dag van vastleggen; `null` laat vandaag.
 */
async function vof(naam, vennoten, { sinds = '2025-01-01T09:00:00+01' } = {}) {
  const w = await maakEenmanszaak(naam, { rechtsvorm: 'vof', resultaatrekening: '0510', start: '2025-01-01', kor: true });
  w.vennoten = {};
  for (const [wie, bp] of vennoten) {
    w.vennoten[wie] = gelukt(await rpc('save_partnership_partner', {
      p_organization_id: w.orgId, p_partner_id: null, p_name: wie, p_profit_share_basis_points: bp,
    }, w.eigenaar.token), `vennoot ${wie}`);
  }
  // De vennoten bestonden al in 2025; in deze test leggen we ze vandaag vast.
  // De trigger laat share_changed_at alleen meelopen met een echte wijziging
  // (een directe update zou het slot ontwijken); hier zetten we hem even uit.
  if (sinds) {
    // Zonder de trigger (een database van vóór 20261122100000) alleen created_at:
    // zo faalt dit scenario daar op de cijfers, niet op de opzet.
    sql(`do $$
         declare v_trigger boolean := exists (select 1 from pg_trigger where tgname = 'partnership_partners_track_share_change');
                 v_column boolean := exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'partnership_partners' and column_name = 'share_changed_at');
         begin
           if v_trigger then execute 'alter table public.partnership_partners disable trigger partnership_partners_track_share_change'; end if;
           update public.partnership_partners set created_at = ${q(sinds)} where organization_id = ${q(w.orgId)};
           if v_column then
             execute format('update public.partnership_partners set share_changed_at = %L where organization_id = %L', ${q(sinds)}, ${q(w.orgId)});
           end if;
           if v_trigger then execute 'alter table public.partnership_partners enable trigger partnership_partners_track_share_change'; end if;
         end $$;`);
  }
  // Genoeg licenties voor een extra teamlid, zoals de billing-koppeling (wereld.mjs).
  sql(`begin; set local brandcore.license_sync = 'true';
       update public.organizations set licensed_seats = 10 where id = ${q(w.orgId)}; commit;`);
  return w;
}

function jaar(w, label) {
  // Via to_jsonb: ook op een database van vóór de kolom legal_form.
  return sqlRij(`select f.id, f.label, f.status, to_jsonb(f) ->> 'legal_form' as legal_form, f.result_account_code
    from public.fiscal_years f where f.organization_id = ${q(w.orgId)} and f.label = ${q(label)}`);
}

/** Omzet of kosten met een memoriaal (de KOR: zonder btw). */
function memoriaal(w, datum, omschrijving, regels) {
  return rpc('post_journal_entry', {
    p_organization_id: w.orgId, p_date: datum, p_description: omschrijving, p_source_type: 'manual', p_source_id: null, p_lines: regels,
  }, w.eigenaar.token);
}

async function winst(w, datum, euroCent) {
  gelukt(await memoriaal(w, datum, 'Omzet', [
    { account_code: '1100', debit_cents: euroCent }, { account_code: '8000', credit_cents: euroCent },
  ]), 'omzet boeken');
}

/** Saldo credit − debet (eigen vermogen positief). */
function kapitaal(w, code, totEnMet = '2100-12-31') {
  return -Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and je.status = 'posted' and la.code = ${q(code)} and je.date <= ${q(totEnMet)}`));
}

async function overzicht(w, label, token = w.eigenaar.token) {
  return gelukt(await rpc('owners_equity_overview', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, label).id }, token), `Vennoten ${label}`);
}

function vennoot(ov, naam) {
  return ov.owners.find((o) => o.name === naam);
}

async function verdeling(w, label, regels, token = w.eigenaar.token) {
  return rpc('set_fiscal_year_partner_shares', {
    p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, label).id,
    p_shares: regels.map(([wie, bp, vooraf = 0]) => ({ partner_id: w.vennoten[wie].id, share_basis_points: bp, prior_share_cents: vooraf })),
  }, token);
}

function afsluiten(w, label) {
  return rpc('close_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, label).id }, w.eigenaar.token);
}

function heropenen(w, label) {
  return rpc('reopen_fiscal_year', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, label).id }, w.eigenaar.token);
}

async function raming(w, jaartal) {
  const inputs = gelukt(await rpc('get_income_tax_inputs', { p_organization_id: w.orgId, p_year: jaartal, p_hours: true }, w.eigenaar.token), `raming ${jaartal}`);
  return { inputs, overview: nodig(buildIncomeTaxOverview(inputs, { basis: 'geboekt', today: VANDAAG }), 'raming') };
}

/** Gerrie zet een handeling klaar, zoals in de chat: als de eigenaar, met dezelfde plan-code. */
let gerrieKern = null;
async function gerrie(w, actionId, input) {
  gerrieKern ??= await import(new URL('../../supabase/functions/_shared/gerrieCore.ts', import.meta.url).href);
  const ctx = await gerrieKern.buildContext(w.orgId, 'owner', { id: w.eigenaar.id, email: w.eigenaar.email });
  return gerrieKern.buildProposal(ctx, 'propose_action', { action_id: actionId, input });
}

// ── 1. Een vennoot treedt uit vóór de jaarafsluiting ─────────────────────

async function uittreden() {
  groep('Vof — Bram treedt uit vóór 2025 dicht is: hij houdt zijn deel van 2025');
  const w = await stap('een vof met Anna en Bram (50/50) sinds 2025, met € 8.000 winst in 2025', async () => {
    const w0 = await vof('vofuit', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w0, '2025-06-01', 800000);
    return w0;
  });
  if (!w) return;

  // Eerst weigerde het afsluiten hier ("na 31-12-2025 gewijzigd (Bram)") en
  // moest je de verdeling van 2025 zelf vastleggen. Met de tijdlijn treedt Bram
  // per vandaag uit, en deed hij in heel 2025 gewoon mee.
  await stap('Bram treedt per vandaag uit: Vennoten 2025 telt hem nog mee, zonder iets vast te leggen', async () => {
    gelukt(await rpc('save_partnership_partner', {
      p_organization_id: w.orgId, p_partner_id: w.vennoten.Bram.id, p_name: 'Bram', p_profit_share_basis_points: 5000, p_kind: 'beherend', p_is_active: false,
    }, w.eigenaar.token), 'Bram uitgetreden');
    const ov = await overzicht(w, '2025');
    const bram = nodig(vennoot(ov, 'Bram'), 'Bram in 2025');
    gelijk([bram.inSplit, bram.shareBasisPoints, bram.resultShareCents, bram.leftOn], [true, 5000, 400000, null], 'Bram: 50% van 2025, eind 2025 nog vennoot');
    gelijk([ov.splitChangedAfterYearEnd, ov.splitFixed], [[], false], 'niets te herstellen, niets vastgelegd');
    gelijk(nodig(vennoot(await overzicht(w, '2026'), 'Bram'), 'Bram in 2026').leftOn, VANDAAG, 'in 2026: uitgetreden per vandaag');
  });

  await stap('Gerrie: de afsluitkaart verdeelt over Anna en Bram', async () => {
    const kaart = await gerrie(w, 'fiscal_year.close', { fiscal_year_id: jaar(w, '2025').id });
    const tekst = `${kaart.proposal?.title ?? ''} — ${kaart.proposal?.sub ?? ''}`;
    verwacht(kaart.ok === true && /Anna € 4\.000,00; Bram € 4\.000,00/.test(tekst), `kaart: ${JSON.stringify(kaart.proposal ?? kaart.error)}`);
  });

  await stap('afsluiten zonder vast te leggen: € 4.000 en € 4.000', async () => {
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502'), kapitaal(w, '0510')], [400000, 400000, 0], 'Anna en Bram elk € 4.000, niets op 0510');
    gelijk(jaar(w, '2025').result_account_code, 'vennoten', 'de winst ging naar de vennoten');
  });

  await stap('Vennoten 2025 toont wat geboekt is, ook voor Bram; het eind van 2025 is het begin van 2026', async () => {
    const ov = await overzicht(w, '2025');
    const bram = nodig(vennoot(ov, 'Bram'), 'Bram in 2025');
    gelijk([bram.inSplit, bram.shareBasisPoints, bram.resultShareCents, bram.isActive], [true, 5000, 400000, false], 'Bram: 50%, € 4.000, uitgetreden');
    gelijk(vennoot(ov, 'Anna').endCents, kapitaal(w, '0501', '2025-12-31'), 'eind Anna = grootboek');
    const ov26 = await overzicht(w, '2026');
    gelijk([vennoot(ov26, 'Anna').beginCents, vennoot(ov26, 'Bram').beginCents], [400000, 400000], 'begin 2026 = eind 2025');
  });

  await stap('de raming 2025 rekent met Anna én Bram (€ 4.000 elk)', async () => {
    const { inputs, overview } = await raming(w, 2025);
    gelijk([inputs.legalForm, inputs.splitFixed, inputs.fiscalYearClosed], ['vof', true, true], 'de verdeling van het afgesloten jaar');
    gelijk(overview.persons.map((p) => [p.name, p.estimate.profitShareCents]), [['Anna', 400000], ['Bram', 400000]], 'winstaandelen');
  });

  await stap('heropenen en opnieuw afsluiten gebruikt dezelfde verdeling', async () => {
    gelukt(await heropenen(w, '2025'), 'heropenen');
    gelukt(await afsluiten(w, '2025'), 'opnieuw afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502')], [400000, 400000], 'weer € 4.000 en € 4.000');
  });

  await stap('een afgesloten jaar krijgt geen andere verdeling; eerst heropenen', async () => {
    const res = await verdeling(w, '2025', [['Anna', 10000], ['Bram', 0]]);
    geweigerd(res, 'verdeling van een afgesloten jaar');
    verwacht(/afgesloten/.test(res.tekst) && /heropen/.test(res.tekst), `melding: ${res.tekst}`);
  });
}

// ── 2. Een nieuwe vennoot, en percentages die per 1 januari veranderen ───

async function toetredenEnPercentages() {
  groep('Vof — Chris treedt toe en de verdeling wordt 50/30/20: 2025 blijft 60/40');
  const w = await stap('een vof met Anna en Bram (60/40), 2025 afgesloten met € 10.000 winst', async () => {
    const w0 = await vof('vofnieuw', [['Anna', 6000], ['Bram', 4000]]);
    await winst(w0, '2025-05-01', 1000000);
    gelukt(await afsluiten(w0, '2025'), 'afsluiten 2025');
    return w0;
  });
  if (!w) return;

  // Chris met ingangsdatum 1 januari; Anna en Bram als correctie zonder datum,
  // zoals je dat in het scherm doet. Zo'n correctie raakt het afgesloten 2025
  // niet: hij geldt vanaf 1 januari 2026. Eerst paste hij de stand van 2025
  // aan, en gaf heropenen en opnieuw afsluiten 2025 de nieuwe percentages.
  await stap('Chris (20%) per 1 januari erbij, Anna 50% en Bram 30%: Vennoten 2025 blijft € 6.000 / € 4.000, Chris staat er niet in', async () => {
    w.vennoten.Chris = gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: null, p_name: 'Chris', p_profit_share_basis_points: 2000, p_effective_date: '2026-01-01' }, w.eigenaar.token), 'Chris');
    gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten.Anna.id, p_name: 'Anna', p_profit_share_basis_points: 5000 }, w.eigenaar.token), 'Anna 50%');
    gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten.Bram.id, p_name: 'Bram', p_profit_share_basis_points: 3000 }, w.eigenaar.token), 'Bram 30%');
    const ov = await overzicht(w, '2025');
    gelijk([vennoot(ov, 'Anna').resultShareCents, vennoot(ov, 'Bram').resultShareCents], [600000, 400000], 'de geboekte winstaandelen');
    gelijk([vennoot(ov, 'Anna').shareBasisPoints, vennoot(ov, 'Bram').shareBasisPoints], [6000, 4000], 'de percentages van 2025');
    gelijk(vennoot(ov, 'Chris'), undefined, 'Chris deed in 2025 niet mee');
    gelijk(vennoot(ov, 'Anna').endCents, kapitaal(w, '0501', '2025-12-31'), 'eind Anna = grootboek');
    const ov26 = await overzicht(w, '2026');
    gelijk([vennoot(ov26, 'Anna').beginCents, vennoot(ov26, 'Bram').beginCents], [vennoot(ov, 'Anna').endCents, vennoot(ov, 'Bram').endCents], 'begin 2026 = eind 2025');
    gelijk(['Anna', 'Bram', 'Chris'].map((n) => vennoot(ov26, n).shareBasisPoints), [5000, 3000, 2000], '2026: 50/30/20');
    gelijk(sql(`select string_agg(t.valid_from::text, ',' order by t.valid_from) from public.partnership_partner_timeline t
      where t.partner_id = ${q(w.vennoten.Anna.id)}`), '2025-01-01,2026-01-01', 'de correctie van Anna geldt vanaf 1 januari 2026');
  });

  await stap('2025 heropenen voor een vergeten € 1.000 en opnieuw afsluiten: 60/40 van € 11.000, Chris niets', async () => {
    gelukt(await heropenen(w, '2025'), 'heropenen');
    await winst(w, '2025-12-15', 100000);
    gelukt(await afsluiten(w, '2025'), 'opnieuw afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502'), kapitaal(w, '0503')], [660000, 440000, 0], '€ 6.600 / € 4.400 / € 0');
  });

  await stap('de raming 2025 rekent met 60/40, die van 2026 met de vennoten van nu', async () => {
    const { overview } = await raming(w, 2025);
    gelijk(overview.persons.map((p) => [p.name, p.shareBasisPoints]), [['Anna', 6000], ['Bram', 4000]], '2025');
    const nu = await raming(w, 2026);
    gelijk(nu.overview.persons.map((p) => [p.name, p.shareBasisPoints]), [['Anna', 5000], ['Bram', 3000], ['Chris', 2000]], '2026');
  });
}

// ── 3. Een arbeidsbeloning vóór de verdeling ─────────────────────────────

async function voorafgaand() {
  groep('Vof — Bram krijgt eerst € 6.000 arbeidsbeloning, de rest 60/40');
  const w = await stap('een vof met Anna en Bram (60/40) en € 9.500 winst in 2025', async () => {
    const w0 = await vof('vofvooraf', [['Anna', 6000], ['Bram', 4000]]);
    await winst(w0, '2025-03-01', 950000);
    return w0;
  });
  if (!w) return;

  await stap('Gerrie zet de verdeling klaar, met het bedrag vooraf op de kaart', async () => {
    const kaart = await gerrie(w, 'fiscal_year.set_partner_shares', { fiscal_year_id: jaar(w, '2025').id, shares: [
      { partner_id: w.vennoten.Anna.id, percentage: 60 },
      { partner_id: w.vennoten.Bram.id, percentage: 40, prior_eur: 6000 },
    ] });
    verwacht(kaart.ok === true, `kaart: ${kaart.error}`);
    verwacht(/Bram 40% \(eerst €\s6\.000,00\)/.test(kaart.proposal?.sub ?? JSON.stringify(kaart)), `kaart: ${JSON.stringify(kaart.proposal ?? kaart)}`);
    const vreemd = await gerrie(w, 'fiscal_year.set_partner_shares', { fiscal_year_id: jaar(w, '2025').id, shares: [
      { partner_id: randomUUID(), percentage: 100 },
    ] });
    gelijk(vreemd.ok, false, 'een onbekende vennoot geeft geen kaart');
  });

  await stap('vastleggen en afsluiten: Anna € 2.100, Bram € 7.400 (waarvan € 6.000 vooraf)', async () => {
    gelukt(await verdeling(w, '2025', [['Anna', 6000], ['Bram', 4000, 600000]]), 'verdeling');
    const open = await overzicht(w, '2025');
    gelijk([vennoot(open, 'Anna').resultShareCents, vennoot(open, 'Bram').resultShareCents, vennoot(open, 'Bram').priorShareCents], [210000, 740000, 600000], 'Vennoten vóór het afsluiten');
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502')], [210000, 740000], 'geboekt op het kapitaal');
    const ov = await overzicht(w, '2025');
    gelijk([vennoot(ov, 'Bram').resultShareCents, vennoot(ov, 'Bram').otherMovementsCents], [740000, 0], 'in het winstaandeel, niet onder overig');
  });

  await stap('de raming rekent met hetzelfde winstaandeel', async () => {
    const { overview } = await raming(w, 2025);
    gelijk(overview.persons.map((p) => [p.name, p.estimate.profitShareCents]), [['Anna', 210000], ['Bram', 740000]], 'winstaandelen in de raming');
  });

  await stap('wie wat mag: een lezer legt geen verdeling vast, en een verdeling moet op 100% uitkomen', async () => {
    const lezer = await maakGebruiker('vofvooraf-lezer');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
         values (${q(w.orgId)}, ${q(lezer.id)}, ${q(lezer.email)}, 'member', 'active', '{"finance":"read"}'::jsonb)`);
    geweigerd(await verdeling(w, '2026', [['Anna', 6000], ['Bram', 4000]], lezer.token), 'een lezer');
    const ov = await overzicht(w, '2025', lezer.token);
    gelijk(vennoot(ov, 'Bram').priorShareCents, 600000, 'maar hij ziet de verdeling wel');
    const scheef = await verdeling(w, '2026', [['Anna', 6000], ['Bram', 3000]]);
    geweigerd(scheef, '90%');
    verwacht(/90 procent/.test(scheef.tekst), `melding: ${scheef.tekst}`);
    geweigerd(await rest(`fiscal_year_partner_shares?organization_id=eq.${w.orgId}`, {
      method: 'POST', token: w.eigenaar.token, body: { organization_id: w.orgId, fiscal_year_id: jaar(w, '2026').id, partner_id: w.vennoten.Anna.id, share_basis_points: 10000 },
    }), 'niemand schrijft rechtstreeks in de tabel');
  });
}

// ── 4. De overstap naar een eenmanszaak terwijl 2025 nog open is ─────────

async function overstap() {
  groep('Vof — per 2026 alleen verder als eenmanszaak: 2025 sluit nog af als vof');
  const w = await stap('een vof met Anna en Bram (50/50) en € 8.000 winst in 2025', async () => {
    const w0 = await vof('vofoverstap', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w0, '2025-09-01', 800000);
    return w0;
  });
  if (!w) return;

  await stap('Bram treedt uit en de rechtsvorm wordt eenmanszaak: 2025 blijft een vof, 2026 wordt eenmanszaak', async () => {
    gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten.Bram.id, p_name: 'Bram', p_profit_share_basis_points: 5000, p_kind: 'beherend', p_is_active: false }, w.eigenaar.token), 'Bram uit');
    gelukt(await rest(`company_settings?organization_id=eq.${w.orgId}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=minimal', body: { legal_form: 'eenmanszaak' } }), 'eenmanszaak');
    gelijk([jaar(w, '2025').legal_form, jaar(w, '2026').legal_form], ['vof', 'eenmanszaak'], 'de rechtsvorm per boekjaar');
  });

  await stap('2025 afsluiten met de verdeling van 2025: Anna en Bram elk € 4.000, niets naar 0500', async () => {
    gelukt(await verdeling(w, '2025', [['Anna', 5000], ['Bram', 5000]]), 'verdeling 2025');
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502'), kapitaal(w, '0500')], [400000, 400000, 0], '€ 4.000 / € 4.000 / € 0');
  });

  await stap('Vennoten en de raming van 2025 zijn die van een vof; 2026 is een eenmanszaak', async () => {
    const ov = await overzicht(w, '2025');
    gelijk([ov.legalForm, ov.currentLegalForm, ov.isPartnership], ['vof', 'eenmanszaak', true], 'het overzicht van 2025');
    const { inputs, overview } = await raming(w, 2025);
    gelijk(inputs.isPartnershipForm, true, 'de raming van 2025 is per vennoot');
    gelijk(overview.persons.map((p) => p.name), ['Anna', 'Bram'], 'Anna en Bram');
    const ov26 = await overzicht(w, '2026');
    gelijk(ov26.legalForm, 'eenmanszaak', '2026 is een eenmanszaak');
  });

  await stap('de rechtsvorm van een open boekjaar zelf zetten kan; van een afgesloten jaar niet', async () => {
    geweigerd(await rpc('set_fiscal_year_legal_form', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, '2025').id, p_legal_form: 'eenmanszaak' }, w.eigenaar.token), 'afgesloten 2025');
    gelukt(await rpc('set_fiscal_year_legal_form', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, '2026').id, p_legal_form: 'vof' }, w.eigenaar.token), '2026 toch als vof');
    gelijk(jaar(w, '2026').legal_form, 'vof', '2026 is weer een vof');
    geweigerd(await rpc('set_fiscal_year_legal_form', { p_organization_id: w.orgId, p_fiscal_year_id: jaar(w, '2026').id, p_legal_form: 'bv' }, w.eigenaar.token), 'een BV per boekjaar');
  });
}

// ── 5. Het vorige jaar staat nog open ────────────────────────────────────

async function vorigJaarOpen() {
  groep('Vof — de winst van 2025 (nog open) staat in 2026 apart, niet in het beginvermogen');
  const w = await stap('een vof met Anna en Bram en € 5.000 winst in het open 2025', async () => {
    const w0 = await vof('vofopen', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w0, '2025-04-01', 500000);
    return w0;
  });
  if (!w) return;

  await stap('Vennoten 2026: "nog niet toegewezen" heeft de winst van 2025 apart', async () => {
    const ov = await overzicht(w, '2026');
    gelijk([ov.unassigned?.openPriorResultCents, ov.unassigned?.beginCents, ov.unassigned?.endCents], [500000, 0, 500000], 'apart, en wel in het eind');
    gelijk(ov.openPriorYears, ['2025'], 'met het jaar erbij');
  });
}

// ── 6. Privé ontvangen ───────────────────────────────────────────────────

async function priveOntvangen() {
  groep('Vof — een creditnota die op de rekening van Bram terugkomt');
  const w = await stap('een vof met Anna en Bram, en een factuur van € 363 die Bram privé betaalde', async () => {
    const w0 = await vof('vofcredit', [['Anna', 5000], ['Bram', 5000]]);
    w0.lev = gelukt(await rest('suppliers?select=*', { method: 'POST', token: w0.eigenaar.token, prefer: 'return=representation', body: { organization_id: w0.orgId, created_by: w0.eigenaar.id, name: 'Kantoorhandel' } }), 'leverancier')[0];
    w0.kosten = sqlRij(`select id from public.ledger_accounts where organization_id = ${q(w0.orgId)} and code = '4300'`);
    w0.factuur = await inkoopfactuur(w0, w0.lev, '2026-10-01', [{ description: 'Stoel', amount_cents: 36300, account_id: w0.kosten.id }]);
    gelukt(await rpc('pay_purchase_invoice_privately', { p_organization_id: w0.orgId, p_purchase_invoice_id: w0.factuur.id, p_partner_id: w0.vennoten.Bram.id, p_date: '2026-10-02' }, w0.eigenaar.token), 'privé betaald door Bram');
    return w0;
  });
  if (!w) return;

  await stap('de creditnota terug op Brams pas: "privé ontvangen" op zijn privé-opnamen, en de creditnota staat op betaald', async () => {
    const credit = await inkoopfactuur(w, w.lev, '2026-10-20', [{ description: 'Stoel retour', amount_cents: -36300, account_id: w.kosten.id }]);
    const kaart = await gerrie(w, 'purchase_invoice.pay_privately', { purchase_invoice_id: credit.id, partner_id: w.vennoten.Bram.id, date: '2026-10-21' });
    verwacht(kaart.ok === true && /terugontvangen door Bram/.test(kaart.proposal?.sub ?? ''), `kaart: ${JSON.stringify(kaart.proposal ?? kaart.error)}`);
    gelukt(await rpc('pay_purchase_invoice_privately', { p_organization_id: w.orgId, p_purchase_invoice_id: credit.id, p_partner_id: w.vennoten.Bram.id, p_date: '2026-10-21' }, w.eigenaar.token), 'privé ontvangen');
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(credit.id)}`).payment_status, 'paid', 'de creditnota staat op betaald');
    gelijk(kapitaal(w, '1600'), 0, 'niets meer op Crediteuren');
    gelijk([-kapitaal(w, '0552'), kapitaal(w, '0562')], [36300, 36300], 'Bram: € 363 opname en € 363 storting');
    const posten = sqlRij(`select public.report_open_items(${q(w.orgId)}, current_date) as r`).r;
    gelijk([posten.payables.rows.length, posten.payables.unmatched_cents, posten.payables.gl_balance_cents], [0, 0, 0], 'Openstaand → Crediteuren is leeg en sluit aan');
  });
}

// ── 7. Een vennoot verwijderen ───────────────────────────────────────────

async function verwijderen() {
  groep('Vof — een per ongeluk vastgelegde vennoot kan weg, een vennoot met boekingen niet');
  const w = await stap('een vof met Anna en Bram, en per ongeluk nog een "Anna"', async () => {
    const w0 = await vof('vofweg', [['Anna', 5000], ['Bram', 5000]]);
    w0.vennoten.Dubbel = gelukt(await rpc('save_partnership_partner', { p_organization_id: w0.orgId, p_partner_id: null, p_name: 'Anna', p_profit_share_basis_points: 0 }, w0.eigenaar.token), 'dubbele Anna');
    return w0;
  });
  if (!w) return;

  await stap('de dubbele Anna verwijderen: weg, met haar rekeningen (0503, 0553, 0563)', async () => {
    gelukt(await rpc('delete_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten.Dubbel.id }, w.eigenaar.token), 'verwijderen');
    gelijk(Number(sql(`select count(*) from public.partnership_partners where organization_id = ${q(w.orgId)}`)), 2, 'nog twee vennoten');
    gelijk(Number(sql(`select count(*) from public.ledger_accounts where organization_id = ${q(w.orgId)} and code in ('0503', '0553', '0563')`)), 0, 'de rekeningen zijn weg');
  });

  await stap('Bram met een privé-opname verwijderen wordt geweigerd: zet hem op uitgetreden', async () => {
    gelukt(await memoriaal(w, '2026-02-01', 'Opname Bram', [{ account_code: '0552', debit_cents: 10000 }, { account_code: '1100', credit_cents: 10000 }]), 'opname');
    const res = await rpc('delete_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten.Bram.id }, w.eigenaar.token);
    geweigerd(res, 'een vennoot met boekingen');
    verwacht(/uitgetreden/.test(res.tekst), `melding: ${res.tekst}`);
  });
}

// ── 8. De randen van de weigering, en een resultaat van € 0 ──────────────

async function randen() {
  groep('Vof — iedereen uitgetreden, een latere wijziging na de overstap, en € 0 resultaat met een bedrag vooraf');

  // Eerst weigerde het afsluiten als iedereen op uitgetreden stond, en moest
  // de verdeling van 2025 met de hand. Nu treden ze per 1 januari 2026 uit:
  // 2025 verdeelt vanzelf, en wie per 1 januari 2025 al weg was, deed niet mee.
  await stap('de vof stopt per 31-12-2025, Anna en Bram treden per 1 januari 2026 uit: 2025 gaat naar hen, niet naar 0510', async () => {
    const w = await vof('vofstop', [['Anna', 5000], ['Bram', 5000]]);
    await winst(w, '2025-06-01', 1000000);
    for (const wie of ['Anna', 'Bram']) {
      gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten[wie].id, p_name: wie, p_profit_share_basis_points: 5000, p_kind: 'beherend', p_is_active: false, p_effective_date: '2026-01-01' }, w.eigenaar.token), `${wie} uit`);
    }
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502'), kapitaal(w, '0510')], [500000, 500000, 0], '€ 5.000 / € 5.000 / € 0');
  });

  // Wie de uittreding bewust per 1 januari 2025 zet, zegt dat in 2025 niemand
  // meer meedeed. Dan blijft het resultaat onverdeeld op 0510, en de kaart
  // zegt dat, met de omzetting van hun kapitaal naar de rekening-courant.
  await stap('treedt iedereen per 1 januari 2025 uit: 2025 blijft onverdeeld op 0510, en de kaart zegt het', async () => {
    const w = await vof('vofleeg', [['Anna', 5000], ['Bram', 5000]]);
    gelukt(await memoriaal(w, '2025-01-01', 'Inbreng Anna', [{ account_code: '1100', debit_cents: 200000 }, { account_code: '0501', credit_cents: 200000 }]), 'inbreng Anna');
    await winst(w, '2025-06-01', 1000000);
    for (const wie of ['Anna', 'Bram']) {
      gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten[wie].id, p_name: wie, p_profit_share_basis_points: 5000, p_kind: 'beherend', p_is_active: false, p_effective_date: '2025-01-01' }, w.eigenaar.token), `${wie} uit`);
    }
    const kaart = await gerrie(w, 'fiscal_year.close', { fiscal_year_id: jaar(w, '2025').id });
    const tekst = kaart.proposal?.sub ?? '';
    verwacht(kaart.ok === true && /niet verdeeld/.test(tekst) && /Anna is uitgetreden per 2025-01-01: zijn kapitaal \(€ 2\.000,00\) gaat naar zijn rekening-courant/.test(tekst),
      `kaart: ${JSON.stringify(kaart.proposal ?? kaart.error)}`);
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0510'), kapitaal(w, '0501'), kapitaal(w, '1411')], [1000000, 0, 200000], '€ 10.000 op 0510; Annas € 2.000 een schuld aan haar');
  });

  // Eerst weigerde dit: alles was op één dag in januari vastgelegd, en een
  // wijziging in maart leek dan een wijziging na het jaareinde.
  await stap('overgestapt in januari 2026 (alles op één dag vastgelegd), Bram treedt per 1 maart uit: 2025 sluit af met Anna en Bram', async () => {
    const w = await vof('vofoverstapdag', [['Anna', 5000], ['Bram', 5000]], { sinds: '2026-01-15T10:00:00+01' });
    await winst(w, '2025-06-01', 1000000);
    gelukt(await rpc('save_partnership_partner', { p_organization_id: w.orgId, p_partner_id: w.vennoten.Bram.id, p_name: 'Bram', p_profit_share_basis_points: 5000, p_kind: 'beherend', p_is_active: false, p_effective_date: '2026-03-01' }, w.eigenaar.token), 'Bram uit');
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502')], [500000, 500000], '€ 5.000 / € 5.000');
  });

  await stap('vandaag overgestapt en ingericht: 2025 sluit gewoon af met de vennoten van nu', async () => {
    const w = await vof('vofvandaag', [['Anna', 6000], ['Bram', 4000]], { sinds: null });
    await winst(w, '2025-06-01', 1000000);
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502')], [600000, 400000], '€ 6.000 / € 4.000');
  });

  await stap('resultaat € 0 met € 10.000 vooraf voor Anna: het verschuift ook in het grootboek', async () => {
    const w = await vof('vofnul', [['Anna', 5000], ['Bram', 5000]]);
    gelukt(await verdeling(w, '2025', [['Anna', 5000, 1000000], ['Bram', 5000]]), 'verdeling');
    gelukt(await afsluiten(w, '2025'), 'afsluiten');
    gelijk([kapitaal(w, '0501'), kapitaal(w, '0502')], [500000, -500000], 'Anna +€ 5.000, Bram −€ 5.000');
    const ov = await overzicht(w, '2025');
    gelijk([vennoot(ov, 'Anna').endCents, vennoot(ov, 'Bram').endCents], [500000, -500000], 'de kapitaalvergelijking sluit op het grootboek');
  });
}

export default async function vofScenario() {
  await uittreden();
  await toetredenEnPercentages();
  await voorafgaand();
  await overstap();
  await vorigJaarOpen();
  await priveOntvangen();
  await verwijderen();
  await randen();
}
