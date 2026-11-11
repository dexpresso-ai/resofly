// Vooruitbetaalde kosten, van begin tot eind tegen een lokale stack.
//
// Wat hier wordt nagelopen (CHANGELOG_VOORUITBETAALDE_KOSTEN_2026-11-11.md):
//   1. € 1.000 verzekering over 36 maanden: het schema (28 × € 27,78 en
//      8 × € 27,77), de rekening "Vooruitbetaalde kosten", de boeking naar de
//      balans en de termijn van deze maand naar de kosten;
//   2. een post die al op de balans stond (bank of beginbalans), en een
//      factuur die al als kosten was geboekt;
//   3. wie wat mag: lezen met leesrecht, niets voor wie geen Financiën heeft of
//      van een andere organisatie is, en niemand die rechtstreeks in de
//      tabellen schrijft;
//   4. vastliggen na boeken, tegenboeken in de goede volgorde (het register
//      gaat mee terug), beëindigen met een terugbetaling, en daarna weer alles
//      terug tot de post weg kan;
//   5. geen termijnen vóór de start van de boekhouding in ResoFly, en niet
//      verder vooruit boeken dan het einde van deze maand.
//
// Geld en bewaarplicht (CLAUDE.md, regel 6): elke stap kijkt in het journaal,
// niet alleen naar het antwoord van de functie.
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

// ── Hulpjes ─────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function vandaag() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

/** De laatste dag van de maand, `plus` maanden na de maand van `iso`. */
function maandEinde(iso, plus = 0) {
  const [j, m] = iso.split('-').map(Number);
  const index = m - 1 + plus;
  const jaar = j + Math.floor(index / 12);
  const maand = ((index % 12) + 12) % 12;
  const dag = new Date(Date.UTC(jaar, maand + 1, 0)).getUTCDate();
  return `${jaar}-${String(maand + 1).padStart(2, '0')}-${String(dag).padStart(2, '0')}`;
}

/** De eerste dag van de maand, `plus` maanden na de maand van `iso`. */
function maandBegin(iso, plus = 0) {
  return `${maandEinde(iso, plus).slice(0, 8)}01`;
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

async function rekeningId(w, code) {
  const rij = gelukt(await rest(`ledger_accounts?select=id&organization_id=eq.${w.orgId}&code=eq.${code}`, { token: w.medewerker.token }), `rekening ${code}`)[0];
  return nodig(rij?.id, `grootboekrekening ${code}`);
}

function opslaan(w, gebruiker, id, waarden) {
  return rpc('save_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: id, p_values: waarden }, gebruiker.token);
}

function naarBalans(w, gebruiker, id, tegenrekening = null, datum = null) {
  return rpc('book_prepaid_expense_start', { p_organization_id: w.orgId, p_prepaid_expense_id: id, p_counter_account_id: tegenrekening, p_date: datum }, gebruiker.token);
}

function termijnenBoeken(w, gebruiker, tm, id = null) {
  return rpc('post_prepaid_releases', { p_organization_id: w.orgId, p_through_date: tm, p_prepaid_expense_id: id }, gebruiker.token);
}

function tegenboeken(gebruiker, entryId) {
  return rpc('reverse_journal_entry', { p_entry_id: entryId, p_date: vandaag() }, gebruiker.token);
}

function post(id) {
  return sqlRij(`select * from public.prepaid_expenses where id = ${q(id)}`);
}

function schema(id) {
  return sqlRijen(`select period_index, date::text as date, amount_cents, remaining_after_cents, status, journal_entry_id
    from public.prepaid_expense_releases where prepaid_expense_id = ${q(id)} order by period_index`);
}

function boekingsregels(entryId) {
  return sqlRijen(`select la.code, jl.debit_cents as debet, jl.credit_cents as credit, jl.supplier_id
    from public.journal_lines jl join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = ${q(entryId)} order by jl.line_index`);
}

function boekstuk(entryId) {
  return sqlRij(`select id, date::text as date, source_type, source_id, status, reversed_by_entry_id, reverses_entry_id, created_by
    from public.journal_entries where id = ${q(entryId)}`);
}

/** Saldo (debet − credit) van een rekening over alle geboekte regels van de organisatie. */
function saldo(w, code) {
  return Number(sql(`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id and je.status = 'posted'
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = ${q(w.orgId)} and la.code = ${q(code)}`));
}

function inBalans(regels) {
  gelijk(regels.reduce((s, r) => s + Number(r.debet), 0), regels.reduce((s, r) => s + Number(r.credit), 0), 'debet en credit in evenwicht');
}

// ── Het scenario ────────────────────────────────────────────────────────

export default async function vooruitbetaald() {
  groep('Vooruitbetaalde kosten — één betaling over de maanden');

  const w = await maakWereld('vooruitbetaald');
  const ander = await maakWereld('vooruitbetaald-ander');
  const nu = vandaag();
  const eindeMaand = maandEinde(nu);

  const basis = await stap('rekeningschema', async () => {
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: w.orgId }, w.medewerker.token), 'rekeningschema');
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: ander.orgId }, ander.medewerker.token), 'rekeningschema andere organisatie');
    return {
      bank: await rekeningId(w, '1100'), kosten: await rekeningId(w, '4500'), crediteuren: await rekeningId(w, '1600'),
      omzet: await rekeningId(w, '8000'), btw: await rekeningId(w, '1500'), andereKosten: await rekeningId(ander, '4500'),
    };
  });

  // ── 1. € 1.000 over 36 maanden ──────────────────────────────────────

  const verzekering = await stap('€ 1.000 verzekering over 36 maanden vastleggen: schema en rekening Vooruitbetaalde kosten', async () => {
    const { bank, kosten } = nodig(basis, 'basis');
    const rij = gelukt(await opslaan(w, w.medewerker, null, {
      description: 'Bedrijfsaansprakelijkheidsverzekering', amount_cents: 100000, payment_date: nu,
      start_date: maandBegin(nu), months: 36, expense_account_id: kosten, start_mode: 'book', counter_account_id: bank,
    }), 'vastleggen');
    gelijk([rij.status, rij.start_mode, rij.start_journal_entry_id, rij.created_by], ['active', 'book', null, w.medewerker.id], 'nieuwe post');
    const rekening = sqlRij(`select code, name, type, subtype, report_group, is_system from public.ledger_accounts where id = ${q(rij.prepaid_account_id)}`);
    gelijk(rekening, { code: '1350', name: 'Vooruitbetaalde kosten', type: 'asset', subtype: 'prepaid_expenses', report_group: 'vorderingen', is_system: false }, 'de rekening Vooruitbetaalde kosten');
    const termijnen = schema(rij.id);
    gelijk(termijnen.length, 36, 'aantal termijnen');
    gelijk([termijnen.filter((t) => t.amount_cents === 2778).length, termijnen.filter((t) => t.amount_cents === 2777).length], [28, 8], '28 × € 27,78 en 8 × € 27,77');
    gelijk(termijnen.reduce((s, t) => s + Number(t.amount_cents), 0), 100000, 'samen precies € 1.000');
    gelijk([termijnen[0].date, termijnen[35].date, termijnen[35].remaining_after_cents], [eindeMaand, maandEinde(nu, 35), 0], 'eerste en laatste termijn');
    verwacht(termijnen.every((t) => t.status === 'scheduled'), 'alles nog gepland');
    gelijk(sql(`select count(*) from public.journal_entries where source_id = ${q(rij.id)}`), '0', 'vastleggen boekt nog niets');
    const log = sqlRij(`select action, entity_type, entity_label from public.audit_logs where entity_id = ${q(rij.id)} order by created_at limit 1`);
    gelijk([log?.action, log?.entity_type, log?.entity_label], ['created', 'prepaid_expense', 'Bedrijfsaansprakelijkheidsverzekering'], 'logboek');
    return rij;
  });

  await stap('een tweede post kiest dezelfde rekening Vooruitbetaalde kosten, geen nieuwe', async () => {
    const { kosten } = nodig(basis, 'basis');
    const eerste = nodig(verzekering, 'verzekering');
    const rij = gelukt(await opslaan(w, w.medewerker, null, {
      description: 'Proef', amount_cents: 1200, payment_date: nu, start_date: maandBegin(nu), months: 12, expense_account_id: kosten,
    }), 'tweede post');
    gelijk(rij.prepaid_account_id, eerste.prepaid_account_id, 'zelfde balansrekening');
    gelijk(sql(`select count(*) from public.ledger_accounts where organization_id = ${q(w.orgId)} and subtype = 'prepaid_expenses'`), '1', 'één rekening');
    gelukt(await rpc('delete_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id }, w.medewerker.token), 'weer weg');
    gelijk(post(rij.id), null, 'verwijderd, met schema');
    gelijk(sql(`select count(*) from public.prepaid_expense_releases where prepaid_expense_id = ${q(rij.id)}`), '0', 'schema mee weg');
  });

  const gestart = await stap('naar de balans: debet 1350 / credit 1100 Bank, € 1.000', async () => {
    const rij = nodig(verzekering, 'verzekering');
    geweigerd(await termijnenBoeken(w, w.medewerker, eindeMaand, rij.id), 'termijnen boeken vóór de boeking naar de balans');
    const na = gelukt(await naarBalans(w, w.medewerker, rij.id), 'naar de balans');
    verwacht(na.start_journal_entry_id, 'het boekstuk staat op de post');
    const stuk = boekstuk(na.start_journal_entry_id);
    gelijk([stuk.source_type, stuk.source_id, stuk.date, stuk.created_by], ['prepaid_start', rij.id, nu, w.medewerker.id], 'boekstuk');
    const regels = boekingsregels(stuk.id);
    gelijk(regels.map((r) => [r.code, Number(r.debet), Number(r.credit)]), [['1350', 100000, 0], ['1100', 0, 100000]], 'regels');
    geweigerd(await naarBalans(w, w.medewerker, rij.id), 'een tweede keer naar de balans');
    return na;
  });

  const eersteTermijn = await stap('de termijn van deze maand naar de kosten: debet 4500 / credit 1350, € 27,78', async () => {
    const rij = nodig(gestart, 'gestart');
    const uit = gelukt(await termijnenBoeken(w, w.medewerker, eindeMaand), 'termijnen t/m het einde van deze maand');
    gelijk([uit.posted_count, uit.posted_cents], [1, 2778], 'één termijn');
    const termijn = schema(rij.id)[0];
    gelijk([termijn.status, termijn.date], ['posted', eindeMaand], 'termijn 1 geboekt op het einde van de maand');
    const stuk = boekstuk(termijn.journal_entry_id);
    gelijk([stuk.source_type, stuk.source_id, stuk.date], ['prepaid_release', rij.id, eindeMaand], 'boekstuk van de termijn');
    gelijk(boekingsregels(stuk.id).map((r) => [r.code, Number(r.debet), Number(r.credit)]), [['4500', 2778, 0], ['1350', 0, 2778]], 'regels');
    gelijk(saldo(w, '1350'), 100000 - 2778, 'op de balans');
    const nogEens = gelukt(await termijnenBoeken(w, w.medewerker, eindeMaand), 'nog een keer');
    gelijk(nogEens.posted_count, 0, 'niets dubbel');
    return termijn;
  });

  await stap('niet verder vooruit dan het einde van deze maand', async () => {
    const res = await termijnenBoeken(w, w.medewerker, maandEinde(nu, 1));
    geweigerd(res, 'volgende maand al boeken');
    verwacht(/einde van deze maand/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
  });

  // ── 2. Al op de balans, of al als kosten geboekt ────────────────────

  const licentie = await stap('al op de balans (bank of beginbalans): geen boeking naar de balans, en de achterstand per maand', async () => {
    const { kosten, bank } = nodig(basis, 'basis');
    // Zo staat hij er in het echt op: de bankafschrijving van vijf maanden
    // geleden, direct op Vooruitbetaalde kosten geboekt.
    gelukt(await rpc('post_journal_entry', {
      p_organization_id: w.orgId, p_date: maandBegin(nu, -5), p_description: 'Bank: softwarelicentie een jaar vooruit',
      p_source_type: 'manual', p_source_id: null,
      p_lines: [
        { account_id: nodig(verzekering, 'verzekering').prepaid_account_id, description: 'Softwarelicentie', debit_cents: 60000, credit_cents: 0 },
        { account_id: bank, description: 'Softwarelicentie', debit_cents: 0, credit_cents: 60000 },
      ],
    }, w.medewerker.token), 'bankboeking op 1350');
    const rij = gelukt(await opslaan(w, w.medewerker, null, {
      description: 'Softwarelicentie', amount_cents: 60000, payment_date: maandBegin(nu, -5), start_date: maandBegin(nu, -5),
      months: 12, expense_account_id: kosten, start_mode: 'existing', counter_account_id: nodig(basis, 'basis').bank,
    }), 'vastleggen');
    gelijk([rij.start_mode, rij.counter_account_id], ['existing', null], 'geen tegenrekening nodig');
    geweigerd(await naarBalans(w, w.medewerker, rij.id, nodig(basis, 'basis').bank), 'naar de balans bij "staat al op de balans"');
    const uit = gelukt(await termijnenBoeken(w, w.medewerker, eindeMaand, rij.id), 'achterstand boeken');
    gelijk([uit.posted_count, uit.posted_cents], [6, 30000], 'zes maanden van € 50');
    const datums = schema(rij.id).filter((t) => t.status === 'posted').map((t) => boekstuk(t.journal_entry_id).date);
    gelijk(datums, [-5, -4, -3, -2, -1, 0].map((plus) => maandEinde(nu, plus)), 'elke termijn op zijn eigen maand');
    return rij;
  });

  await stap('al als kosten geboekt: de kostenrekening is de tegenrekening (debet 1350 / credit 4500)', async () => {
    const { kosten } = nodig(basis, 'basis');
    const rij = gelukt(await opslaan(w, w.medewerker, null, {
      description: 'Jaarabonnement boekhoudpakket', amount_cents: 12000, payment_date: nu, start_date: maandBegin(nu),
      months: 12, expense_account_id: kosten, start_mode: 'book', counter_account_id: kosten,
    }), 'vastleggen');
    const na = gelukt(await naarBalans(w, w.medewerker, rij.id), 'naar de balans');
    gelijk(boekingsregels(na.start_journal_entry_id).map((r) => [r.code, Number(r.debet), Number(r.credit)]), [['1350', 12000, 0], ['4500', 0, 12000]], 'uit de kosten, naar de balans');
  });

  await stap('rekeningen die niet kunnen: omzet of btw als tegenrekening, bank als balansrekening, een kostenrekening van een ander', async () => {
    const { bank, kosten, omzet, btw, andereKosten } = nodig(basis, 'basis');
    const basisWaarden = { description: 'X', amount_cents: 1000, payment_date: nu, start_date: maandBegin(nu), months: 2, expense_account_id: kosten };
    for (const [wat, extra, melding] of [
      ['omzet als tegenrekening', { counter_account_id: omzet }, /kan hier niet/],
      ['btw als tegenrekening', { counter_account_id: btw }, /kan hier niet/],
      ['de bank als balansrekening', { prepaid_account_id: bank }, /geen geschikte balansrekening/],
      ['omzet als kostenrekening', { expense_account_id: omzet }, /geen kostenrekening/],
      ['kostenrekening van een andere organisatie', { expense_account_id: andereKosten }, /hoort niet bij deze organisatie/],
      ['geen bedrag', { amount_cents: 0 }, /groter zijn dan nul/],
      ['601 maanden', { months: 601 }, /600 maanden/],
      ['geen omschrijving', { description: '  ' }, /omschrijving/],
      ['een datum die niet bestaat', { start_date: '2026-02-30' }, /niet goed ingevuld/],
    ]) {
      const res = await opslaan(w, w.medewerker, null, { ...basisWaarden, ...extra });
      geweigerd(res, wat);
      verwacht(melding.test(res.tekst), `${wat}: ${res.tekst.slice(0, 200)}`);
    }
  });

  // ── 3. Wie wat mag ──────────────────────────────────────────────────

  await stap('lezen: wie Financiën mag lezen ziet de post; zonder Financiën of van een ander: niets', async () => {
    const rij = nodig(verzekering, 'verzekering');
    for (const [wie, gebruiker, aantal] of [['lezer', w.lezer, 1], ['boekhouder', w.boekhouder, 1], ['zonder financiën', w.zonderFinancien, 0], ['andere organisatie', ander.eigenaar, 0]]) {
      const posten = gelukt(await rest(`prepaid_expenses?select=id&id=eq.${rij.id}`, { token: gebruiker.token }), `lezen als ${wie}`);
      const termijnen = gelukt(await rest(`prepaid_expense_releases?select=id&prepaid_expense_id=eq.${rij.id}`, { token: gebruiker.token }), `schema lezen als ${wie}`);
      gelijk([posten.length, termijnen.length > 0 ? 1 : 0], [aantal, aantal], `${wie} ziet`);
    }
  });

  await stap('schrijven: lezer, kijker, boekhouder, zonder financiën en een andere organisatie mogen niets', async () => {
    const rij = nodig(verzekering, 'verzekering');
    const { kosten } = nodig(basis, 'basis');
    for (const [wie, gebruiker] of [['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['zonder financiën', w.zonderFinancien], ['andere organisatie', ander.eigenaar]]) {
      geweigerd(await opslaan(w, gebruiker, null, { description: 'Poging', amount_cents: 1000, payment_date: nu, start_date: maandBegin(nu), months: 2, expense_account_id: kosten }), `vastleggen als ${wie}`);
      geweigerd(await opslaan(w, gebruiker, rij.id, { notes: 'Poging' }), `notitie als ${wie}`);
      geweigerd(await termijnenBoeken(w, gebruiker, eindeMaand), `termijnen boeken als ${wie}`);
      geweigerd(await rpc('end_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id, p_date: nu }, gebruiker.token), `beëindigen als ${wie}`);
      geweigerd(await rpc('delete_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id }, gebruiker.token), `verwijderen als ${wie}`);
    }
    // Met het eigen organisatie-id een post van een ander: niet gevonden.
    geweigerd(await rpc('post_prepaid_releases', { p_organization_id: ander.orgId, p_through_date: eindeMaand, p_prepaid_expense_id: rij.id }, ander.eigenaar.token), 'termijnen van een ander via de eigen organisatie');
  });

  await stap('niemand schrijft rechtstreeks in de tabellen, ook niet met volledige rechten', async () => {
    const rij = nodig(verzekering, 'verzekering');
    const { kosten } = nodig(basis, 'basis');
    geweigerd(await rest('prepaid_expenses', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, description: 'Rechtstreeks', amount_cents: 1000, payment_date: nu, start_date: nu, months: 1, prepaid_account_id: rij.prepaid_account_id, expense_account_id: kosten },
    }), 'rechtstreeks invoegen');
    nietsVeranderd(await rest(`prepaid_expenses?id=eq.${rij.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { amount_cents: 1 } }), 'rechtstreeks het bedrag wijzigen');
    nietsVeranderd(await rest(`prepaid_expense_releases?prepaid_expense_id=eq.${rij.id}`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { status: 'posted' } }), 'rechtstreeks termijnen op geboekt zetten');
    nietsVeranderd(await rest(`prepaid_expenses?id=eq.${rij.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'rechtstreeks verwijderen');
    gelijk([post(rij.id)?.amount_cents, schema(rij.id).filter((t) => t.status === 'posted').length], [100000, 1], 'alles nog zoals het was');
  });

  // ── 4. Vastliggen, tegenboeken, beëindigen ──────────────────────────

  await stap('na boeken liggen bedrag, datums en looptijd vast; omschrijving, notities en kostenrekening niet', async () => {
    const rij = nodig(verzekering, 'verzekering');
    for (const [wat, waarden] of [['bedrag', { amount_cents: 120000 }], ['looptijd', { months: 24 }], ['startdatum', { start_date: maandBegin(nu, 1) }], ['manier', { start_mode: 'existing' }]]) {
      const res = await opslaan(w, w.medewerker, rij.id, waarden);
      geweigerd(res, `${wat} wijzigen`);
      verwacht(/liggen vast/.test(res.tekst), `${wat}: ${res.tekst.slice(0, 200)}`);
    }
    const nieuweKosten = gelukt(await rest('ledger_accounts?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, code: '4310', name: 'Verzekeringen', type: 'expense', report_group: 'overige_bedrijfskosten' },
    }), 'rekening Verzekeringen')[0];
    const na = gelukt(await opslaan(w, w.medewerker, rij.id, { description: 'AVB-verzekering 2026–2029', notes: 'Polis 123', expense_account_id: nieuweKosten.id }), 'omschrijving, notitie en kostenrekening');
    gelijk([na.description, na.notes, na.expense_account_id, na.amount_cents], ['AVB-verzekering 2026–2029', 'Polis 123', nieuweKosten.id, 100000], 'bijgewerkt');
    gelijk(schema(rij.id).length, 36, 'het schema bleef staan');
    geweigerd(await rpc('delete_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id }, w.medewerker.token), 'verwijderen na boeken');
  });

  await stap('tegenboeken in de goede volgorde: eerst de termijn, dan pas de boeking naar de balans', async () => {
    const rij = nodig(gestart, 'gestart');
    const termijn = nodig(eersteTermijn, 'eerste termijn');
    const res = await tegenboeken(w.medewerker, rij.start_journal_entry_id);
    geweigerd(res, 'boeking naar de balans tegenboeken terwijl er een termijn geboekt is');
    verwacht(/Draai eerst/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await tegenboeken(w.medewerker, termijn.journal_entry_id), 'termijn tegenboeken');
    const terug = schema(rij.id)[0];
    gelijk([terug.status, terug.journal_entry_id], ['scheduled', null], 'de termijn staat weer gepland');
    gelijk(saldo(w, '1350') - 12000 - 30000, 100000, 'de verzekering staat weer helemaal op de balans');
    gelijk(boekstuk(termijn.journal_entry_id).reversed_by_entry_id !== null, true, 'het origineel blijft, met een tegenboeking');
    const opnieuw = gelukt(await termijnenBoeken(w, w.medewerker, eindeMaand, rij.id), 'opnieuw boeken');
    gelijk(opnieuw.posted_count, 1, 'de termijn gaat opnieuw');
    gelijk(boekingsregels(schema(rij.id)[0].journal_entry_id)[0].code, '4310', 'nu op de nieuwe kostenrekening');
  });

  await stap('beëindigen met een terugbetaling van € 100: de rest naar de kosten, het schema vervalt', async () => {
    const rij = nodig(gestart, 'gestart');
    const { bank } = nodig(basis, 'basis');
    const te = await rpc('end_prepaid_expense', {
      p_organization_id: w.orgId, p_prepaid_expense_id: rij.id, p_date: nu, p_refund_cents: 9_999_999, p_refund_account_id: bank,
    }, w.medewerker.token);
    geweigerd(te, 'meer terug dan er op de balans staat');
    const geboekt = schema(rij.id).filter((t) => t.status === 'posted');
    const over = 100000 - geboekt.reduce((s, t) => s + Number(t.amount_cents), 0);
    const na = gelukt(await rpc('end_prepaid_expense', {
      p_organization_id: w.orgId, p_prepaid_expense_id: rij.id, p_date: nu, p_refund_cents: 10000, p_refund_account_id: bank,
    }, w.medewerker.token), 'beëindigen');
    gelijk([na.status, na.end_date, na.end_amount_cents, na.end_refund_cents, na.end_refund_account_id], ['ended', nu, over, 10000, bank], 'beëindigd');
    const regels = boekingsregels(na.end_journal_entry_id);
    gelijk(regels.map((r) => [r.code, Number(r.debet), Number(r.credit)]), [['1100', 10000, 0], ['4310', over - 10000, 0], ['1350', 0, over]], 'terugbetaling, rest naar de kosten, eraf van de balans');
    inBalans(regels);
    gelijk(boekstuk(na.end_journal_entry_id).source_type, 'prepaid_end', 'soort boeking');
    gelijk(schema(rij.id).filter((t) => t.status === 'scheduled').length, 0, 'geen geplande termijnen meer');
    geweigerd(await termijnenBoeken(w, w.medewerker, eindeMaand, rij.id), 'termijnen na beëindigen');
  });

  await stap('na beëindigen: eerst de beëindiging terug, dan komen de termijnen terug', async () => {
    const rij = nodig(gestart, 'gestart');
    const huidig = post(rij.id);
    const geboekt = schema(rij.id).filter((t) => t.status === 'posted');
    const res = await tegenboeken(w.medewerker, geboekt[0].journal_entry_id);
    geweigerd(res, 'een termijn tegenboeken terwijl de post beëindigd is');
    verwacht(/beëindiging/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    gelukt(await tegenboeken(w.medewerker, huidig.end_journal_entry_id), 'beëindiging tegenboeken');
    const terug = post(rij.id);
    gelijk([terug.status, terug.end_date, terug.end_journal_entry_id], ['active', null, null], 'weer lopend');
    const termijnen = schema(rij.id);
    gelijk([termijnen.length, termijnen.filter((t) => t.status === 'posted').length], [36, geboekt.length], 'het schema is terug');
    gelijk(termijnen.reduce((s, t) => s + Number(t.amount_cents), 0), 100000, 'nog steeds precies € 1.000');
  });

  await stap('alles terug, en dan kan de post weg (de boekstukken blijven)', async () => {
    const rij = nodig(gestart, 'gestart');
    for (const termijn of schema(rij.id).filter((t) => t.status === 'posted')) {
      gelukt(await tegenboeken(w.medewerker, termijn.journal_entry_id), `termijn ${termijn.period_index} tegenboeken`);
    }
    gelukt(await tegenboeken(w.medewerker, post(rij.id).start_journal_entry_id), 'boeking naar de balans tegenboeken');
    gelijk(post(rij.id).start_journal_entry_id, null, 'niet meer op de balans');
    const wijzig = gelukt(await opslaan(w, w.medewerker, rij.id, { amount_cents: 90000 }), 'nu mag het bedrag weer');
    gelijk(wijzig.amount_cents, 90000, 'nieuw bedrag');
    gelijk(schema(rij.id).reduce((s, t) => s + Number(t.amount_cents), 0), 90000, 'schema opnieuw berekend');
    gelukt(await rpc('delete_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id }, w.medewerker.token), 'verwijderen');
    gelijk(post(rij.id), null, 'weg');
    verwacht(Number(sql(`select count(*) from public.journal_entries where source_id = ${q(rij.id)}`)) >= 6, 'de boekstukken blijven bewaard');
    gelijk(saldo(w, '1350'), 12000 + 30000, 'op de balans alleen de twee andere posten');
  });

  await stap('stoppen kan niet vóór de maand van de laatst geboekte termijn', async () => {
    const { kosten } = nodig(basis, 'basis');
    const rij = gelukt(await opslaan(w, w.medewerker, null, {
      description: 'Onderhoudscontract', amount_cents: 2400, payment_date: maandBegin(nu, -2), start_date: maandBegin(nu, -2),
      months: 12, expense_account_id: kosten, start_mode: 'existing',
    }), 'vastleggen');
    gelijk(gelukt(await termijnenBoeken(w, w.medewerker, eindeMaand, rij.id), 'drie maanden boeken').posted_count, 3, 'drie termijnen');
    const res = await rpc('end_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id, p_date: maandEinde(nu, -1) }, w.medewerker.token);
    geweigerd(res, 'stoppen per vorige maand terwijl deze maand al geboekt is');
    verwacht(/al geboekt/.test(res.tekst), `melding: ${res.tekst.slice(0, 200)}`);
    const na = gelukt(await rpc('end_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: rij.id, p_date: maandBegin(nu) }, w.medewerker.token), 'stoppen per de eerste van deze maand');
    gelijk([na.status, na.end_amount_cents], ['ended', 2400 - 3 * 200], 'de rest (negen maanden) in één keer');
    gelijk(boekingsregels(na.end_journal_entry_id).map((r) => [r.code, Number(r.debet), Number(r.credit)]), [['4500', 1800, 0], ['1350', 0, 1800]], 'zonder terugbetaling alles naar de kosten');
  });

  await stap('een termijn in een afgesloten boekjaar komt op de eerste open dag daarna', async () => {
    const { kosten } = nodig(basis, 'basis');
    const jaar = Number(nu.slice(0, 4));
    sql(`insert into public.closed_periods (organization_id, period_type, year, period_start, period_end, closed_by, closed_at)
         values (${q(w.orgId)}, 'year', ${jaar - 1}, '${jaar - 1}-01-01', '${jaar - 1}-12-31', ${q(w.eigenaar.id)}, now())`);
    try {
      const rij = gelukt(await opslaan(w, w.medewerker, null, {
        description: 'Huur opslag', amount_cents: 2400, payment_date: `${jaar - 1}-11-01`, start_date: `${jaar - 1}-11-01`,
        months: 24, expense_account_id: kosten, start_mode: 'existing',
      }), 'vastleggen');
      gelukt(await termijnenBoeken(w, w.medewerker, eindeMaand, rij.id), 'boeken');
      const datums = schema(rij.id).filter((t) => t.status === 'posted').slice(0, 3).map((t) => [t.date, boekstuk(t.journal_entry_id).date]);
      gelijk(datums, [[`${jaar - 1}-11-30`, `${jaar}-01-01`], [`${jaar - 1}-12-31`, `${jaar}-01-01`], [`${jaar}-01-31`, `${jaar}-01-31`]], 'november en december op 1 januari, januari op zijn eigen dag');
    } finally {
      sql(`delete from public.closed_periods where organization_id = ${q(w.orgId)} and period_type = 'year' and year = ${jaar - 1}`);
    }
  });

  // ── 5. Begin van de boekhouding ─────────────────────────────────────

  await stap('niets van vóór de start van de boekhouding in ResoFly', async () => {
    const { kosten, bank } = nodig(basis, 'basis');
    sql(`update public.company_settings set bookkeeping_start_date = ${q(maandBegin(nu))} where organization_id = ${q(w.orgId)}`);
    try {
      const eerder = await opslaan(w, w.medewerker, null, {
        description: 'Te vroeg', amount_cents: 1200, payment_date: nu, start_date: maandBegin(nu, -2), months: 12, expense_account_id: kosten, start_mode: 'existing',
      });
      geweigerd(eerder, 'periode die vóór de start begon');
      verwacht(/begint op/.test(eerder.tekst) && /Staat al op de balans/.test(eerder.tekst), `melding: ${eerder.tekst.slice(0, 240)}`);
      const betaald = await opslaan(w, w.medewerker, null, {
        description: 'Te vroeg betaald', amount_cents: 1200, payment_date: maandBegin(nu, -1), start_date: maandBegin(nu), months: 12,
        expense_account_id: kosten, start_mode: 'book', counter_account_id: bank,
      });
      geweigerd(betaald, 'betaling vóór de start, door ResoFly te boeken');
      const goed = gelukt(await opslaan(w, w.medewerker, null, {
        description: 'Rest uit de beginbalans', amount_cents: 1200, payment_date: maandBegin(nu, -1), start_date: maandBegin(nu), months: 12,
        expense_account_id: kosten, start_mode: 'existing',
      }), 'wel: wat er bij de start nog op de balans stond');
      gelukt(await rpc('delete_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: goed.id }, w.medewerker.token), 'opruimen');
      // Een post die vóór die dag begon (de startdatum kwam later), blijft
      // gewoon te beschrijven; alleen bedrag en datums liggen vast.
      const oud = nodig(licentie, 'licentie');
      gelijk(gelukt(await opslaan(w, w.medewerker, oud.id, { notes: 'Na het invullen van de startdatum' }), 'notitie bij een oudere post').notes, 'Na het invullen van de startdatum', 'notitie opgeslagen');
      const vroegStoppen = await rpc('end_prepaid_expense', { p_organization_id: w.orgId, p_prepaid_expense_id: oud.id, p_date: maandEinde(nu, -1) }, w.medewerker.token);
      geweigerd(vroegStoppen, 'beëindigen vóór de start van de boekhouding');
    } finally {
      sql(`update public.company_settings set bookkeeping_start_date = null where organization_id = ${q(w.orgId)}`);
    }
  });
}
