// Herinneringen en aanmaningen, end-to-end door de echte invoice-workflow.
//
// Wat hier vastligt, en waarom:
// - Een betalingsherinnering hoort alleen bij een verstuurde factuur die over de
//   vervaldatum is. Ze vraagt wat er OPENSTAAT (na een deelbetaling is dat niet
//   het factuurtotaal), gaat naar de klant van de factuur, met de PDF die hij
//   eerder kreeg en, als de organisatie Mollie koppelde, een betaallink voor dat
//   openstaande bedrag via haar EIGEN Mollie-account.
// - De dagelijkse cron stuurt alleen voor organisaties die dat aanzetten, volgens
//   hun eigen termijnen, één niveau tegelijk, en raakt nooit de facturen of
//   klanten van een andere organisatie.
// - Een formele aanmaning (WIK) is juridisch geladen: rente en incassokosten
//   volgen de wet, de cron stelt hem alleen VOOR en een mens verstuurt hem.
// - Een storing bij Resend of een vol mailquotum laat niets half achter.
// - Wie geen schrijfrecht op Financiën heeft, of bij een andere organisatie
//   hoort, kan niets sturen, voorstellen of annuleren.
//
// De tijd: de klok van de database en de edge functions verzetten we niet. Wat
// de tijd met een factuur doet, is dat haar datums verder in het verleden komen
// te liggen; dat doet `tijdVerstrijkt`.
//
// De cron raakt ALLE organisaties, ook die van scenario's die tegelijk draaien.
// Daarom staan de automatische herinneringen en aanmaningen van onze werelden
// alleen aan rond onze eigen cron-aanroepen, en toetsen we alleen het effect op
// onze eigen facturen (in de database en in de mails van dit proces).
import { PDFDocument } from 'pdf-lib';
import { roep } from './functies.mjs';
import { mailsAan, mollieBetaal, post } from './nepdiensten.mjs';
import { ANON_KEY, CRON_SECRET } from './omgeving.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS, TOTAAL_REGELS } from './wereld.mjs';

const TOTAAL_CENTEN = Math.round(TOTAAL_REGELS * 100);
const DEELBETALING = 5000;

// ── Kleine hulpjes ─────────────────────────────────────────────────────────

/** Vandaag zoals de edge function rekent (todayIsoDate: de UTC-datum). */
function vandaag() {
  return new Date().toISOString().slice(0, 10);
}

/** Vandaag zoals de database een aanmaning toetst (begin_dunning_notice: Europe/Amsterdam). */
function vandaagInAmsterdam() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function plusDagen(iso, dagen) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dagen);
  return d.toISOString().slice(0, 10);
}

// Dezelfde opmaak als de mailsjablonen (Intl nl-NL), zodat we letterlijk
// kunnen vergelijken wat de klant leest.
const EURO = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
function euro(centen) {
  return EURO.format(centen / 100);
}
function datumNl(iso) {
  return new Date(iso).toLocaleDateString('nl-NL');
}

function regelMet(tekst, begin) {
  return String(tekst ?? '').split('\n').find((regel) => regel.startsWith(begin)) ?? '(geen)';
}

function tag(mail, naam) {
  return mail.tags.find((t) => t.name === naam)?.value ?? null;
}

// De invoice-workflow labelt elke mail met factuur en sjabloon (Resend-tags);
// zo tellen we precies de mails van één factuur, ook als er voor dezelfde
// klant meer facturen lopen.
function mailsVan(factuurId, sjabloon) {
  return post.mails.filter((m) => tag(m, 'invoice_id') === factuurId && tag(m, 'template_key') === sjabloon);
}
const factuurMails = (id) => mailsVan(id, 'invoice_sent');
const herinneringsMails = (id) => mailsVan(id, 'invoice_reminder');
const aanmaningsMails = (id) => mailsVan(id, 'invoice_dunning_wik14');

function molliebetalingen(factuurId) {
  return [...post.mollie.betalingen.values()].filter((b) => b.metadata?.invoiceId === factuurId);
}

function stand(factuurId) {
  return sqlRij(`select status, reminder_level, reminders_paused from public.invoices where id = '${factuurId}'`);
}

function leveringen(factuurId, soort) {
  return sqlRijen(`select delivery_kind, status, reminder_level, recipient_email, error_message
                     from public.invoice_email_deliveries
                    where invoice_id = '${factuurId}' ${soort ? `and delivery_kind = '${soort}'` : ''}
                    order by created_at`);
}

function aanmaningen(factuurId) {
  return sqlRijen(`select id, organization_id, status, client_kind, interest_kind, principal_cents, interest_cents,
                          interest_days, collection_costs_cents, collection_costs_vat_cents, total_claim_cents,
                          calculation_date, due_date, deadline_date, created_by, delivery_id, sent_at
                     from public.invoice_dunning_notices where invoice_id = '${factuurId}' order by created_at`);
}

function openstaand(w, factuurId) {
  return Number(sql(`select public.invoice_open_receivable_cents('${w.orgId}', '${factuurId}')`));
}

async function isPdf(bytes, wat) {
  verwacht(Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-', `${wat} is geen PDF`);
  const doc = await PDFDocument.load(bytes);
  verwacht(doc.getPageCount() >= 1, `${wat} heeft geen pagina's`);
}

function factuurToken(tekst) {
  return String(tekst ?? '').match(/\/invoice\/([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
}

// ── De wet, zelf uitgerekend ───────────────────────────────────────────────
// Bewust niet met _shared/dunning.ts: dan zou de test de eigen rekenfouten van
// het product goedkeuren. De tarieven komen wel uit de database (die tabel is
// gegevens, geen logica).

// Wettelijke (handels)rente: enkelvoudig, per dag het tarief dat die dag gold,
// vanaf de dag NA de vervaldatum tot en met de rekendatum, gedeeld door 365.
function verwachteRente(hoofdsomCenten, vervaldatum, rekendatum, soort) {
  const tarieven = sqlRijen(`select rate_basis_points, valid_from from public.statutory_interest_rates
                              where kind = '${soort}' order by valid_from`);
  const perTarief = new Map();
  let dagen = 0;
  for (let dag = plusDagen(vervaldatum, 1); dag <= rekendatum; dag = plusDagen(dag, 1)) {
    const tarief = tarieven.filter((t) => t.valid_from <= dag).at(-1);
    if (!tarief) continue;
    const vorige = perTarief.get(tarief.valid_from);
    perTarief.set(tarief.valid_from, { bp: tarief.rate_basis_points, dagen: (vorige?.dagen ?? 0) + 1 });
    dagen += 1;
  }
  let rente = 0;
  for (const deel of perTarief.values()) rente += (hoofdsomCenten * deel.dagen * (deel.bp / 10000)) / 365;
  return { centen: Math.round(rente), dagen };
}

// Besluit vergoeding voor buitengerechtelijke incassokosten: 15% over de eerste
// € 2.500, 10% over de volgende € 2.500, 5% over de volgende € 5.000, 1% over de
// volgende € 190.000 en 0,5% daarboven; minimaal € 40, maximaal € 6.775.
function verwachteWik(hoofdsomCenten) {
  const schijven = [[250000, 15], [250000, 10], [500000, 5], [19000000, 1], [Infinity, 0.5]];
  let rest = hoofdsomCenten;
  let kosten = 0;
  for (const [breedte, procent] of schijven) {
    const deel = Math.min(rest, breedte);
    kosten += (deel * procent) / 100;
    rest -= deel;
    if (rest <= 0) break;
  }
  return Math.min(Math.max(Math.round(kosten), 4000), 677500);
}

// ── Wat een gebruiker doet ─────────────────────────────────────────────────

function wf(token, body) {
  return roep('invoice-workflow', { token, body });
}
const herinner = (gebruiker, w, f, extra = {}) =>
  wf(gebruiker?.token, { action: 'sendInvoiceReminderEmail', organizationId: w.orgId, invoiceId: f.id, ...extra });
const stelVoor = (gebruiker, w, f) =>
  wf(gebruiker?.token, { action: 'proposeDunningNotice', organizationId: w.orgId, invoiceId: f.id });
const stuur = (gebruiker, w, noticeId) =>
  wf(gebruiker?.token, { action: 'sendDunningNotice', organizationId: w.orgId, noticeId });
const annuleer = (gebruiker, w, noticeId) =>
  wf(gebruiker?.token, { action: 'cancelDunningNotice', organizationId: w.orgId, noticeId });

/** De cron zoals pg_cron/pg_net hem aanroept: POST, geen origin, het geheim in de header. */
function cron(soort, { geheim = CRON_SECRET, token, query } = {}) {
  return roep('invoice-workflow', {
    query: query ?? `cron=${soort}`, body: {}, token, origin: '',
    headers: geheim === null ? {} : { 'x-cron-secret': geheim },
  });
}

// Elke organisatie koppelt haar EIGEN Mollie-account; de nep-Mollie onthoudt
// per betaling met welke sleutel hij is aangemaakt, zodat we zien in wiens
// account het geld van de klant zou landen.
async function koppelMollie(w) {
  const sleutel = `test_${uniek(w.naam).replace(/[^a-zA-Z0-9]/g, '')}`;
  gelukt(await wf(w.eigenaar.token, { action: 'saveInvoiceMollieKey', organizationId: w.orgId, apiKey: sleutel }), `Mollie koppelen (${w.naam})`);
  w.mollieSleutel = sleutel;
}

/** Zoals Instellingen → Online betalen het opslaat: een upsert op organization_id. */
function zetInstellingen(w, waarden, token = w.eigenaar.token) {
  return rest('invoice_reminder_settings?on_conflict=organization_id', {
    method: 'POST', token, prefer: 'resolution=merge-duplicates,return=representation',
    body: { organization_id: w.orgId, ...waarden },
  });
}
function instellingenVan(w) {
  return sqlRij(`select * from public.invoice_reminder_settings where organization_id = '${w.orgId}'`);
}

/** Factuurdatum vandaag, betaaltermijn 14 dagen, opgeslagen en verstuurd zoals in de app. */
async function nieuweFactuur(w, { klant = w.klantA, regels = REGELS, verstuur = true, dagenTeLaat = null } = {}) {
  const nummer = uniek('FAC-HER');
  const res = await rest('invoices?select=id,number', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, client_id: klant.id, number: nummer, date: vandaag(), due_date: plusDagen(vandaag(), 14), lines: regels, status: 'draft' },
  });
  const factuur = gelukt(res, `factuur ${nummer} opslaan`)[0];
  if (verstuur) {
    gelukt(await wf(w.medewerker.token, { action: 'sendInvoiceEmail', organizationId: w.orgId, invoiceId: factuur.id }), `factuur ${nummer} versturen`);
  }
  // `dagenTeLaat` dagen na de vervaldatum = 14 + dagenTeLaat dagen na de factuurdatum.
  if (dagenTeLaat !== null) tijdVerstrijkt(factuur.id, 14 + dagenTeLaat);
  return { ...factuur, klant, ...sqlRij(`select status, date, due_date from public.invoices where id = '${factuur.id}'`) };
}

// De tijd laten verstrijken: de datums van de factuur schuiven terug. De
// vergrendeling (enforce_invoice_immutability) weigert terecht elke wijziging
// van de vervaldatum van een verstuurde factuur — door een gebruiker. Dit is
// geen gebruiker maar de kalender; daarom alleen voor deze ene update zonder
// triggers (session_replication_role geldt alleen binnen deze transactie).
function tijdVerstrijkt(factuurId, dagen) {
  sql(`begin; set local session_replication_role = replica;
       update public.invoices
          set date = date - ${dagen}, due_date = due_date - ${dagen},
              sent_at = sent_at - make_interval(days => ${dagen})
        where id = '${factuurId}';
       commit;`);
}

// Een Mollie-betaallink verloopt na 30 minuten (CHECKOUT_TTL_MINUTES); ook dat
// is de tijd, dus op dezelfde manier als tijdVerstrijkt.
function betaallinkenVerlopen(factuurId, minuten = 31) {
  sql(`begin; set local session_replication_role = replica;
       update public.invoice_payment_records
          set created_at = created_at - make_interval(mins => ${minuten}),
              checkout_expires_at = checkout_expires_at - make_interval(mins => ${minuten})
        where invoice_id = '${factuurId}';
       commit;`);
}

/** Een betaling van de klant op de bank, afgeletterd op de factuur zoals op de Bankpagina. */
async function bankBetaling(w, factuur, centen) {
  if (!w.bankrekening) {
    // De grootboekrekening Bank bestaat zodra de eerste factuur is geboekt.
    const grootboek = sqlRij(`select id from public.ledger_accounts where organization_id = '${w.orgId}' and subtype = 'bank' order by code limit 1`);
    verwacht(grootboek, 'geen grootboekrekening Bank');
    const res = await rest('bank_accounts?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, name: 'Zakelijke rekening', iban: 'NL91ABNA0417164300', ledger_account_id: grootboek.id, created_by: w.medewerker.id },
    });
    w.bankrekening = gelukt(res, 'bankrekening aanmaken')[0].id;
  }
  // Een neutrale omschrijving: met het factuurnummer erin kan het inlezen de
  // transactie al zelf koppelen, en dan toetsen we iets anders.
  const omschrijving = uniek('Overboeking');
  gelukt(await rpc('import_bank_transactions', {
    p_organization_id: w.orgId, p_bank_account_id: w.bankrekening, p_statement: null,
    p_transactions: [{ booking_date: vandaag(), amount_cents: centen, counterparty_name: factuur.klant.name, description: omschrijving }],
  }, w.medewerker.token), 'afschrift inlezen');
  const transactie = sqlRij(`select id from public.bank_transactions where bank_account_id = '${w.bankrekening}' and description = '${omschrijving}'`);
  gelukt(await rpc('book_bank_transaction', { p_organization_id: w.orgId, p_transaction_id: transactie.id, p_matched_invoice_id: factuur.id }, w.medewerker.token), 'betaling afletteren');
}

async function nieuweConsument(w) {
  const res = await rest('clients?select=id,name,email', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, name: uniek('Piet Particulier'), email: `${uniek('particulier')}@klant.test`.toLowerCase(),
      contact_name: 'Piet de Vries', client_kind: 'consumer', address_line1: 'Lindelaan 3', postal_code: '3511 AB', city: 'Utrecht', country: 'Nederland',
    },
  });
  return gelukt(res, 'consument aanmaken')[0];
}

/** Het mailquotum van een organisatie, zoals ResoFly het per organisatie instelt (null = standaard). */
function zetQuotum(w, perUur) {
  if (perUur === null) {
    sql(`delete from public.organization_email_limits where organization_id = '${w.orgId}'`);
  } else {
    sql(`insert into public.organization_email_limits (organization_id, hourly_limit, daily_limit, note)
         values ('${w.orgId}', ${perUur}, ${perUur}, 'tests/stromen: quotum op')
         on conflict (organization_id) do update set hourly_limit = excluded.hourly_limit, daily_limit = excluded.daily_limit`);
  }
}

function overgeslagen(naam, reden) {
  console.log(`  --    ${naam} (overgeslagen: ${reden})`);
}

// ── Het scenario ───────────────────────────────────────────────────────────

export default async function herinneringen() {
  groep('Herinneringen en aanmaningen');
  const werelden = await stap('werelden: met Mollie, zonder Mollie, twee met automatische herinneringen, één met alles uit', async () => {
    const a = await maakWereld('herinneringen');
    await koppelMollie(a);
    const z = await maakWereld('herinneringen-zonder-mollie');
    const noord = await maakWereld('cron-noord');
    await koppelMollie(noord);
    const zuid = await maakWereld('cron-zuid');
    await koppelMollie(zuid);
    const uit = await maakWereld('herinneringen-uit');
    return { a, z, noord, zuid, uit };
  });
  if (!werelden) return;
  const { a, z, noord, zuid, uit } = werelden;

  await handmatig(a);
  await zonderMollie(z);
  await instellingen(a, uit);
  const cronFacturen = await automatisch(noord, zuid, uit, z);
  await aanmaning(a);
  if (cronFacturen) await aanmaningscron(noord, uit, cronFacturen);
  else overgeslagen('aanmaningscron', 'de herinneringscron is niet klaargezet');
  await robuustheid(a);
  await beveiliging(a, uit);
}

// ── 1. Handmatig ───────────────────────────────────────────────────────────

async function handmatig(a) {
  groep('Herinneringen — handmatig');

  await stap('geen herinnering voor een concept, ook niet met een verlopen vervaldatum', async () => {
    const f = await nieuweFactuur(a, { verstuur: false, dagenTeLaat: 20 });
    geweigerd(await herinner(a.medewerker, a, f), 'herinnering voor een concept');
    gelijk(herinneringsMails(f.id).length, 0, 'mails voor het concept');
    gelijk(leveringen(f.id, 'reminder').length, 0, 'verzendregels voor het concept');
    gelijk(stand(f.id).status, 'draft', 'status');
  });

  // De app biedt de knop pas na de vervaldatum aan (invoiceIsReminderEligible),
  // Gerrie ook (isReminderEligible). De server is de laatste grens: een
  // herinnering vóór de vervaldatum zegt de klant dat hij te laat is terwijl
  // dat niet zo is.
  await stap('geen herinnering voor een verstuurde factuur die nog niet vervallen is', async () => {
    const f = await nieuweFactuur(a); // vervalt over 14 dagen
    const res = await herinner(a.medewerker, a, f);
    const mail = herinneringsMails(f.id)[0];
    verwacht(!mail, `de klant kreeg een herinnering voor een factuur die pas op ${datumNl(f.due_date)} vervalt (antwoord ${res.status}): `
      + `"${mail?.subject}" — "${regelMet(mail?.text, 'Vervaldatum')}"`);
    geweigerd(res, 'herinnering vóór de vervaldatum');
  });

  const deels = await stap('na een deelbetaling: juiste adres, openstaand bedrag, de PDF van de factuur en een betaallink', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    await bankBetaling(a, f, DEELBETALING);
    const open = TOTAAL_CENTEN - DEELBETALING;
    gelijk(openstaand(a, f.id), open, 'openstaand na de deelbetaling');

    const json = gelukt(await herinner(a.medewerker, a, f), 'herinnering');
    gelijk(json.level, 1, 'niveau');
    const mails = herinneringsMails(f.id);
    gelijk(mails.length, 1, 'aantal herinneringen');
    const mail = mails[0];
    gelijk(mail.to, [a.klantA.email], 'ontvanger');
    gelijk(mail.subject, `Herinnering: factuur ${f.number} staat nog open`, 'onderwerp');
    verwacht(mail.text.includes(`Openstaand bedrag: ${euro(open)}`), `"Openstaand bedrag: ${euro(open)}" ontbreekt:\n${mail.text}`);
    verwacht(mail.text.includes(`Factuurbedrag: ${euro(TOTAAL_CENTEN)}`), 'het factuurbedrag (deels betaald) ontbreekt');
    verwacht(mail.text.includes(`Vervaldatum: ${datumNl(f.due_date)} (20 dagen verstreken)`), `vervaldatum: ${regelMet(mail.text, 'Vervaldatum')}`);

    // De PDF is precies het document dat de klant bij de factuur kreeg.
    gelijk(mail.bijlagen.map((b) => b.naam), [`factuur-${f.number}.pdf`], 'bijlagen');
    const origineel = factuurMails(f.id)[0]?.bijlagen.find((b) => b.naam.endsWith('.pdf'));
    verwacht(origineel && Buffer.compare(mail.bijlagen[0].bytes, origineel.bytes) === 0, 'de bijlage is niet de PDF die de klant bij de factuur kreeg');
    await isPdf(mail.bijlagen[0].bytes, 'de bijlage');

    // De betaallink: Mollie van DEZE organisatie, voor het openstaande bedrag.
    verwacht(json.paymentLinkIncluded === true, `geen betaallink: ${json.paymentLinkError}`);
    const betalingen = molliebetalingen(f.id);
    gelijk(betalingen.length, 1, 'Mollie-betalingen');
    const betaling = betalingen[0];
    gelijk(betaling.amount, { currency: 'EUR', value: (open / 100).toFixed(2) }, 'bedrag van de betaallink');
    gelijk(betaling.sleutel, a.mollieSleutel, 'Mollie-sleutel (eigen account)');
    gelijk([betaling.metadata.organizationId, betaling.metadata.invoiceId], [a.orgId, f.id], 'organisatie en factuur in de betaling');
    const link = `https://www.mollie.com/checkout/select-method/${betaling.id}`;
    verwacht(mail.text.includes(link) && mail.html.includes(link), 'de betaallink staat niet in de mail');
    return { f, betaling, open };
  });

  if (deels) {
    await stap('het niveau loopt op: 1 → 2 → 3, elk met de eigen toon', async () => {
      const { f } = deels;
      const onderwerpen = {
        2: `Tweede herinnering: factuur ${f.number} nog niet voldaan`,
        3: `Aanmaning: laatste betalingsherinnering factuur ${f.number}`,
      };
      for (const niveau of [2, 3]) {
        const json = gelukt(await herinner(a.medewerker, a, f), `herinnering niveau ${niveau}`);
        gelijk(json.level, niveau, 'niveau');
        gelijk(herinneringsMails(f.id).at(-1).subject, onderwerpen[niveau], `onderwerp niveau ${niveau}`);
        gelijk(stand(f.id).reminder_level, niveau, 'reminder_level');
      }
      gelijk(leveringen(f.id, 'reminder').map((l) => [l.reminder_level, l.status]), [[1, 'sent'], [2, 'sent'], [3, 'sent']], 'verzendregels');
      // Elke herinnering hield dezelfde (nog open) link, voor het openstaande bedrag.
      for (const mail of herinneringsMails(f.id)) verwacht(mail.text.includes(deels.betaling.id), `${mail.subject}: andere of geen betaallink`);
    });

    // Elke verzending maakt een nieuwe link; de PDF draagt nog de link van de
    // eerste verzending. Die moet blijven werken, anders stuurt de herinnering
    // een document mee met een dode link.
    await stap('de factuurlink uit de eerste mail (en de PDF) werkt nog na de herinneringen', async () => {
      const token = factuurToken(factuurMails(deels.f.id)[0]?.text);
      verwacht(token, 'geen factuurlink in de factuurmail');
      gelukt(await roep('invoice-public', { body: { action: 'getInvoice', token } }), 'de oude factuurlink openen');
    });

    await stap('de betaallink werkt: betalen bij Mollie zet de factuur op betaald', async () => {
      const res = await mollieBetaal(deels.betaling.id);
      gelijk(res.status, 200, 'webhook');
      gelijk(stand(deels.f.id).status, 'paid', 'status na betalen');
      gelijk(openstaand(a, deels.f.id), 0, 'openstaand na betalen');
    });
  } else {
    overgeslagen('niveaus, oude link en betalen', 'de eerste herinnering mislukte');
  }

  // Na de eerste herinnering betaalt de klant een deel. De volgende herinnering
  // vraagt het nieuwe openstaande bedrag, met een nieuwe link; de oude link (voor
  // het hele bedrag) telt niet meer als lopende betaling.
  await stap('een deelbetaling na de eerste herinnering: de volgende vraagt het nieuwe openstaande bedrag, met een nieuwe link', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    gelukt(await herinner(a.medewerker, a, f), 'eerste herinnering');
    const eerste = molliebetalingen(f.id);
    gelijk(eerste.map((b) => b.amount.value), [(TOTAAL_CENTEN / 100).toFixed(2)], 'eerste betaallink');
    await bankBetaling(a, f, DEELBETALING);
    gelijk(gelukt(await herinner(a.medewerker, a, f), 'tweede herinnering').level, 2, 'niveau');
    const open = TOTAAL_CENTEN - DEELBETALING;
    const mail = herinneringsMails(f.id).at(-1);
    verwacht(mail.text.includes(`Openstaand bedrag: ${euro(open)}`), `openstaand bedrag: ${regelMet(mail.text, 'Openstaand')}`);
    const nieuw = molliebetalingen(f.id).find((b) => mail.text.includes(b.id));
    verwacht(nieuw && nieuw.id !== eerste[0].id, 'de tweede herinnering gebruikt de link voor het oude bedrag');
    gelijk(nieuw.amount.value, (open / 100).toFixed(2), 'bedrag van de nieuwe link');
    gelijk(sqlRij(`select status from public.invoice_payment_records where provider_payment_id = '${eerste[0].id}'`)?.status, 'expired', 'de oude link');
  });

  // Een goedgekeurd voorstel (Gerrie, de batch) geeft het goedgekeurde adres mee.
  // Is het adres van de klant intussen veranderd, dan gaat er niets uit.
  await stap('een goedgekeurde herinnering gaat niet naar een ander adres dan op de goedkeurkaart stond', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    geweigerd(await herinner(a.medewerker, a, f, { expectedRecipientEmail: 'oud-adres@klant.test' }), 'herinnering met een ander goedgekeurd adres', [409]);
    gelijk(herinneringsMails(f.id).length, 0, 'mails');
    gelijk(leveringen(f.id, 'reminder'), [], 'verzendregels');
  });

  await stap('geen herinnering voor een betaalde factuur', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    await bankBetaling(a, f, TOTAAL_CENTEN);
    gelijk(stand(f.id).status, 'paid', 'status na de bankbetaling');
    geweigerd(await herinner(a.medewerker, a, f), 'herinnering voor een betaalde factuur', [409]);
    gelijk(herinneringsMails(f.id).length, 0, 'mails');
  });

  await stap('geen herinnering voor een geannuleerde (gecrediteerde) factuur', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    gelukt(await wf(a.medewerker.token, { action: 'creditInvoice', organizationId: a.orgId, invoiceId: f.id, reason: 'Dubbel gefactureerd' }), 'crediteren');
    gelijk(stand(f.id).status, 'cancelled', 'status na crediteren');
    geweigerd(await herinner(a.medewerker, a, f), 'herinnering voor een geannuleerde factuur', [409]);
    gelijk(herinneringsMails(f.id).length, 0, 'mails');
  });

  await stap('geen herinnering voor een terugbetaalde factuur', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    await bankBetaling(a, f, TOTAAL_CENTEN);
    gelukt(await wf(a.beheerder.token, { action: 'createInvoiceRefund', organizationId: a.orgId, invoiceId: f.id, amountCents: TOTAAL_CENTEN, reason: 'Retour', kind: 'manual' }), 'terugbetalen');
    gelijk(stand(f.id).status, 'refunded', 'status na terugbetalen');
    geweigerd(await herinner(a.medewerker, a, f), 'herinnering voor een terugbetaalde factuur', [409]);
    gelijk(herinneringsMails(f.id).length, 0, 'mails');
  });

  // Twee collega's (of een collega en een goedgekeurde Gerrie-batch) op hetzelfde
  // moment: de klant hoort niveau 1 maar één keer te krijgen. De factuurverzending
  // zelf heeft zo'n grens (begin_invoice_email_send); de herinnering niet.
  await stap('twee collega\'s tegelijk: de klant krijgt de herinnering maar één keer', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    const body = { action: 'sendInvoiceReminderEmail', organizationId: a.orgId, invoiceId: f.id, includePaymentLink: false };
    const antwoorden = await Promise.all([wf(a.medewerker.token, body), wf(a.beheerder.token, body)]);
    const niveaus = herinneringsMails(f.id).map((m) => tag(m, 'reminder_level'));
    verwacht(niveaus.length === 1, `de klant kreeg ${niveaus.length} herinneringen (${niveaus.join(' + ')}); antwoorden ${antwoorden.map((r) => r.status).join(' en ')}`);
    verwacht(antwoorden.every((r) => r.status < 500), `een 5xx: ${antwoorden.map((r) => `${r.status} ${r.json?.error ?? ''}`).join(' | ')}`);
  });
}

// ── 2. Zonder Mollie ───────────────────────────────────────────────────────

async function zonderMollie(z) {
  groep('Herinneringen — zonder Mollie');

  // Standaard staat "betaallink meesturen" aan, ook als er (nog) geen Mollie
  // gekoppeld is. Dan moet de herinnering gewoon uitgaan, met de factuurlink.
  const f = await stap('zonder Mollie gaat de herinnering uit met de factuurlink, zonder betaallink', async () => {
    const f = await nieuweFactuur(z, { dagenTeLaat: 20 });
    const json = gelukt(await herinner(z.medewerker, z, f), 'herinnering');
    gelijk(json.paymentLinkIncluded, false, 'betaallink');
    const mail = herinneringsMails(f.id)[0];
    verwacht(mail, 'geen herinneringsmail');
    gelijk(mail.to, [z.klantA.email], 'ontvanger');
    const token = factuurToken(mail.text);
    verwacht(token, 'geen factuurlink in de herinnering');
    gelukt(await roep('invoice-public', { body: { action: 'getInvoice', token } }), 'de factuurlink uit de herinnering openen');
    gelijk(molliebetalingen(f.id).length, 0, 'betalingen bij Mollie');
    return f;
  });
  if (!f) return;

  // Lukt de betaallink niet, dan hoort de betaalrij op 'failed' te gaan
  // (fail_invoice_payment_checkout). Blijft hij op 'creating', dan telt hij
  // overal als lopende Mollie-betaling.
  await stap('de mislukte betaallink laat geen betaling op "creating" achter', async () => {
    const hangend = sqlRijen(`select status, checkout_expires_at from public.invoice_payment_records
                               where invoice_id = '${f.id}' and status in ('creating', 'open', 'pending', 'authorized')`);
    verwacht(hangend.length === 0, `${hangend.length} betaalrij(en) blijven staan als lopende betaling: ${hangend.map((r) => r.status).join(', ')}`);
    const gebeurtenis = sqlRij(`select count(*)::int as n from public.invoice_workflow_events where invoice_id = '${f.id}' and event_type = 'payment_failed'`);
    verwacht(gebeurtenis?.n > 0, 'de mislukte betaallink staat niet in de tijdlijn van de factuur');
  });

  // Een onbetaalde, verstuurde factuur annuleer je met een creditnota. Een
  // herinnering mag dat niet blokkeren. Weigert de server, dan kijken we ook of
  // zijn eigen advies ("laat hem verlopen") helpt: een link verloopt na 30 minuten.
  await stap('de factuur is na de herinnering nog te crediteren', async () => {
    const crediteer = () => wf(z.medewerker.token, { action: 'creditInvoice', organizationId: z.orgId, invoiceId: f.id, reason: 'Klant is failliet' });
    const direct = await crediteer();
    if (direct.status !== 200) {
      betaallinkenVerlopen(f.id);
      const later = await crediteer();
      throw new Error(`crediteren direct na de herinnering: ${direct.status} ${direct.json?.error}; `
        + `31 minuten later: ${later.status} ${later.json?.error ?? '(gelukt)'}`);
    }
    gelijk(stand(f.id).status, 'cancelled', 'status na crediteren');
  });
}

// ── 3. Instellingen ────────────────────────────────────────────────────────

async function instellingen(a, uit) {
  groep('Herinneringen — instellingen');
  const pad = `invoice_reminder_settings?organization_id=eq.${a.orgId}`;
  const aanzetten = { auto_reminders_enabled: true, dunning_enabled: true, dunning_offset_days: 0 };

  await stap('een lid mag de instellingen niet aanmaken', async () => {
    geweigerd(await zetInstellingen(a, aanzetten, a.medewerker.token), 'aanmaken als lid');
    gelijk(instellingenVan(a), null, 'instellingen na de poging');
  });

  await stap('de eigenaar mag ze aanmaken', async () => {
    gelukt(await zetInstellingen(a, {
      auto_reminders_enabled: false, level1_offset_days: 3, level2_offset_days: 10, level3_offset_days: 17,
      include_payment_link: true, dunning_enabled: false, dunning_offset_days: 30,
    }), 'aanmaken als eigenaar');
    gelijk(instellingenVan(a)?.auto_reminders_enabled, false, 'opgeslagen');
  });

  await stap('lid, lezer, kijker, boekhouder en zonder Financiën mogen ze niet wijzigen', async () => {
    for (const [wie, g] of [['lid', a.medewerker], ['lezer', a.lezer], ['kijker', a.kijker], ['boekhouder', a.boekhouder], ['zonder Financiën', a.zonderFinancien]]) {
      nietsVeranderd(await rest(pad, { method: 'PATCH', token: g.token, prefer: 'return=representation', body: aanzetten }), `wijzigen als ${wie}`);
      geweigerd(await zetInstellingen(a, aanzetten, g.token), `upsert als ${wie}`);
    }
    const nu = instellingenVan(a);
    gelijk([nu.auto_reminders_enabled, nu.dunning_enabled, nu.dunning_offset_days], [false, false, 30], 'instellingen na de pogingen');
  });

  await stap('de beheerder (admin) mag ze wijzigen', async () => {
    const res = await rest(pad, { method: 'PATCH', token: a.beheerder.token, prefer: 'return=representation', body: { level1_offset_days: 4 } });
    gelijk(gelukt(res, 'wijzigen als beheerder').length, 1, 'gewijzigde rijen');
    gelijk(instellingenVan(a).level1_offset_days, 4, 'level1_offset_days');
  });

  await stap('een andere organisatie kan ze niet lezen of wijzigen', async () => {
    gelijk((await rest(pad, { token: uit.eigenaar.token })).json, [], 'lezen door de andere organisatie');
    nietsVeranderd(await rest(pad, { method: 'PATCH', token: uit.eigenaar.token, prefer: 'return=representation', body: aanzetten }), 'wijzigen door de andere organisatie');
    geweigerd(await zetInstellingen(a, aanzetten, uit.eigenaar.token), 'upsert door de andere organisatie');
    gelijk(instellingenVan(a).auto_reminders_enabled, false, 'automatische herinneringen na de pogingen');
  });

  await stap('termijnen in de verkeerde volgorde worden geweigerd', async () => {
    geweigerd(await rest(pad, { method: 'PATCH', token: a.eigenaar.token, prefer: 'return=representation', body: { level1_offset_days: 20, level2_offset_days: 5 } }), 'termijnen 20 en 5');
    gelijk(instellingenVan(a).level2_offset_days, 10, 'level2_offset_days');
  });

  // "Betaallink meesturen" uit: ook met Mollie gekoppeld geen betaling bij Mollie,
  // wel de factuurlink. (Daarna weer aan; de rest van het scenario rekent erop.)
  await stap('met "betaallink meesturen" uit gaat de herinnering zonder betaallink', async () => {
    gelukt(await rest(pad, { method: 'PATCH', token: a.eigenaar.token, prefer: 'return=representation', body: { include_payment_link: false } }), 'betaallink uit');
    try {
      const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
      const json = gelukt(await herinner(a.medewerker, a, f), 'herinnering');
      gelijk(json.paymentLinkIncluded, false, 'betaallink');
      gelijk(molliebetalingen(f.id).length, 0, 'betalingen bij Mollie');
      verwacht(factuurToken(herinneringsMails(f.id)[0]?.text), 'geen factuurlink in de herinnering');
    } finally {
      gelukt(await rest(pad, { method: 'PATCH', token: a.eigenaar.token, prefer: 'return=representation', body: { include_payment_link: true } }), 'betaallink weer aan');
    }
  });
}

// ── 4. Automatisch (cron) ──────────────────────────────────────────────────

async function automatisch(noord, zuid, uit, zonderInstellingen) {
  groep('Herinneringen — automatisch (cron)');
  const termijnen = { level1_offset_days: 5, level2_offset_days: 12, level3_offset_days: 20, include_payment_link: true };

  const f = await stap('klaarzetten: facturen in elke stand, automatische herinneringen nog uit', async () => {
    gelukt(await zetInstellingen(noord, { auto_reminders_enabled: false, ...termijnen }), 'instellingen noord');
    gelukt(await zetInstellingen(zuid, { auto_reminders_enabled: false, ...termijnen }), 'instellingen zuid');
    gelukt(await zetInstellingen(uit, { auto_reminders_enabled: false, dunning_enabled: false }), 'instellingen uit');
    const f = {
      teVroeg: await nieuweFactuur(noord, { dagenTeLaat: 4 }),
      opTermijn: await nieuweFactuur(noord, { dagenTeLaat: 5 }),
      achter: await nieuweFactuur(noord, { dagenTeLaat: 13 }),
      vanochtend: await nieuweFactuur(noord, { dagenTeLaat: 13 }),
      concept: await nieuweFactuur(noord, { verstuur: false, dagenTeLaat: 30 }),
      gepauzeerd: await nieuweFactuur(noord, { dagenTeLaat: 30 }),
      betaald: await nieuweFactuur(noord, { dagenTeLaat: 30 }),
      deels: await nieuweFactuur(noord, { dagenTeLaat: 30, klant: noord.klantB }),
      zuid: await nieuweFactuur(zuid, { dagenTeLaat: 6 }),
      uit: await nieuweFactuur(uit, { dagenTeLaat: 30 }),
      geenInstellingen: await nieuweFactuur(zonderInstellingen, { dagenTeLaat: 30 }),
    };
    // Pauzeren zoals de app (setInvoiceRemindersPaused): een lid, via PostgREST.
    gelukt(await rest(`invoices?id=eq.${f.gepauzeerd.id}`, { method: 'PATCH', token: noord.medewerker.token, prefer: 'return=representation', body: { reminders_paused: true } }), 'pauzeren');
    await bankBetaling(noord, f.betaald, TOTAAL_CENTEN);
    await bankBetaling(noord, f.deels, DEELBETALING);
    gelijk(stand(f.betaald.id).status, 'paid', 'de betaalde factuur');
    // Vanochtend al met de hand herinnerd (niveau 1).
    gelijk(gelukt(await herinner(noord.medewerker, noord, f.vanochtend, { includePaymentLink: false }), 'handmatige herinnering').level, 1, 'niveau');
    return f;
  });
  if (!f) return null;
  const mijnFacturen = Object.values(f);

  await stap('cron zonder geheim, met een verkeerd geheim, met het geheim in de URL of met een sessie: 401', async () => {
    const voor = post.mails.length;
    for (const soort of ['reminders', 'dunning']) {
      geweigerd(await cron(soort, { geheim: null }), `${soort} zonder geheim`, [401]);
      geweigerd(await cron(soort, { geheim: 'geraden' }), `${soort} met een verkeerd geheim`, [401]);
      geweigerd(await cron(soort, { geheim: `${CRON_SECRET}x` }), `${soort} met een te lang geheim`, [401]);
      geweigerd(await cron(soort, { geheim: null, query: `cron=${soort}&secret=${encodeURIComponent(CRON_SECRET)}&x-cron-secret=${encodeURIComponent(CRON_SECRET)}` }), `${soort} met het geheim in de URL`, [401]);
      geweigerd(await cron(soort, { geheim: null, token: noord.eigenaar.token }), `${soort} met de sessie van de eigenaar`, [401]);
    }
    gelijk(post.mails.length, voor, 'mails na de geweigerde aanroepen');
  });

  // Pas nu aan, vlak voor onze run, en direct daarna weer uit (zie de kop).
  const run = await stap('cron met geheim draait', async () => {
    gelukt(await zetInstellingen(noord, { auto_reminders_enabled: true }), 'noord aan');
    gelukt(await zetInstellingen(zuid, { auto_reminders_enabled: true }), 'zuid aan');
    const json = gelukt(await cron('reminders'), 'cron');
    // De run gaat over alle organisaties; alleen fouten bij onze facturen tellen hier.
    gelijk((json.errors ?? []).filter((e) => mijnFacturen.some((x) => x.id === e.invoiceId)), [], 'fouten bij onze facturen');
    return json;
  });

  if (run) {
    await stap('een vervallen factuur krijgt niveau 1 zodra de ingestelde termijn bereikt is, niet eerder', async () => {
      const mails = herinneringsMails(f.opTermijn.id);
      gelijk(mails.length, 1, 'herinneringen bij 5 dagen te laat (termijn 5)');
      gelijk(mails[0].to, [noord.klantA.email], 'ontvanger');
      gelijk(mails[0].subject, `Herinnering: factuur ${f.opTermijn.number} staat nog open`, 'onderwerp');
      gelijk(stand(f.opTermijn.id).reminder_level, 1, 'reminder_level');
      gelijk(herinneringsMails(f.teVroeg.id).length, 0, 'herinneringen bij 4 dagen te laat (termijn 5)');
      gelijk(stand(f.teVroeg.id), { status: 'overdue', reminder_level: 0, reminders_paused: false }, 'de factuur van 4 dagen');
    });

    await stap('één niveau per run: een factuur die achterloopt krijgt eerst niveau 1', async () => {
      gelijk(herinneringsMails(f.achter.id).map((m) => tag(m, 'reminder_level')), ['L1'], 'niveaus (13 dagen te laat)');
    });

    await stap('geen herinnering voor een concept, een gepauzeerde of een betaalde factuur', async () => {
      for (const [wat, x] of [['concept', f.concept], ['gepauzeerd', f.gepauzeerd], ['betaald', f.betaald]]) {
        gelijk(herinneringsMails(x.id).length, 0, `mails (${wat})`);
        gelijk(leveringen(x.id, 'reminder').length, 0, `verzendregels (${wat})`);
      }
      gelijk(stand(f.concept.id).status, 'draft', 'het concept bleef een concept');
      gelijk(stand(f.gepauzeerd.id).reminder_level, 0, 'reminder_level (gepauzeerd)');
    });

    await stap('geen herinnering bij een organisatie met automatische herinneringen uit, of zonder instellingen', async () => {
      for (const [wat, x] of [['uit', f.uit], ['zonder instellingen', f.geenInstellingen]]) {
        gelijk(herinneringsMails(x.id).length, 0, `mails (${wat})`);
        gelijk(stand(x.id).reminder_level, 0, `reminder_level (${wat})`);
      }
    });

    await stap('na een deelbetaling: het openstaande bedrag en een betaallink van de eigen Mollie, naar de klant van de factuur', async () => {
      const mails = herinneringsMails(f.deels.id);
      gelijk(mails.length, 1, 'herinneringen');
      gelijk(mails[0].to, [noord.klantB.email], 'ontvanger (klant B)');
      const open = TOTAAL_CENTEN - DEELBETALING;
      verwacht(mails[0].text.includes(`Openstaand bedrag: ${euro(open)}`), `openstaand bedrag: ${regelMet(mails[0].text, 'Openstaand')}`);
      const betaling = molliebetalingen(f.deels.id).find((b) => mails[0].text.includes(b.id));
      verwacht(betaling, 'geen Mollie-betaallink in de herinnering');
      gelijk(betaling.amount.value, (open / 100).toFixed(2), 'bedrag van de betaallink');
      gelijk(betaling.sleutel, noord.mollieSleutel, 'Mollie-sleutel (eigen account)');
    });

    await stap('elke organisatie alleen haar eigen facturen en klanten', async () => {
      const mails = herinneringsMails(f.zuid.id);
      gelijk(mails.length, 1, 'herinneringen zuid');
      const m = mails[0];
      gelijk(m.to, [zuid.klantA.email], 'ontvanger zuid');
      gelijk(tag(m, 'organization_id'), zuid.orgId, 'organisatie in de mail');
      verwacht(m.text.startsWith(`${zuid.naam} Studio B.V.`), `afzender in de mail: ${m.text.split('\n')[0]}`);
      const betaling = molliebetalingen(f.zuid.id).find((b) => m.text.includes(b.id));
      verwacht(betaling, 'geen Mollie-betaallink in de herinnering van zuid');
      gelijk([betaling.sleutel, betaling.metadata.organizationId], [zuid.mollieSleutel, zuid.orgId], 'Mollie-account van zuid');
      // Geen mail van noord aan een klant van zuid, en andersom; geen naam van de ander erin.
      const paren = [[noord, zuid], [zuid, noord]];
      for (const mail of post.mails.filter((x) => tag(x, 'template_key') === 'invoice_reminder')) {
        for (const [eigen, ander] of paren) {
          if (tag(mail, 'organization_id') !== eigen.orgId) continue;
          verwacht(mail.to.every((adres) => [eigen.klantA.email, eigen.klantB.email].includes(adres)), `mail van ${eigen.naam} naar ${mail.to.join(', ')}`);
          verwacht(!mail.text.includes(ander.naam) && !mail.html.includes(ander.naam), `mail van ${eigen.naam} noemt ${ander.naam}`);
        }
      }
      const scheef = sqlRijen(`select d.id from public.invoice_email_deliveries d join public.invoices i on i.id = d.invoice_id
                                where i.organization_id in ('${noord.orgId}', '${zuid.orgId}') and d.organization_id <> i.organization_id`);
      gelijk(scheef, [], 'verzendregels bij een andere organisatie dan hun factuur');
    });

    // De cron rekent in dagen na de vervaldatum, niet in tijd sinds de vorige
    // herinnering. Wie vanochtend met de hand niveau 1 stuurde, mag niet een
    // uur later van de cron niveau 2 krijgen.
    await stap('een factuur die vandaag al met de hand herinnerd is, krijgt van de cron niet nog één', async () => {
      const niveaus = herinneringsMails(f.vanochtend.id).map((m) => tag(m, 'reminder_level'));
      verwacht(niveaus.length === 1, `de klant kreeg vandaag ${niveaus.length} herinneringen (${niveaus.join(' + ')}) voor ${f.vanochtend.number}`);
    });

    // De docs ("Handmatig testen") raden zelf een cron-aanroep met curl aan; op
    // een dag dat de cron al liep, mag dat de klanten niet nog eens mailen.
    await stap('een tweede run op dezelfde dag stuurt niemand nog een herinnering', async () => {
      const voor = new Map(mijnFacturen.map((x) => [x.id, herinneringsMails(x.id).length]));
      gelukt(await cron('reminders'), 'tweede run');
      const extra = mijnFacturen.filter((x) => herinneringsMails(x.id).length > voor.get(x.id))
        .map((x) => `${x.number} (${herinneringsMails(x.id).map((m) => tag(m, 'reminder_level')).join(' + ')})`);
      verwacht(extra.length === 0, `dezelfde dag nog een herinnering voor: ${extra.join(', ')}`);
    });

    await stap('nooit twee keer hetzelfde niveau voor dezelfde factuur', async () => {
      for (const x of mijnFacturen) {
        const niveaus = leveringen(x.id, 'reminder').filter((l) => l.status === 'sent').map((l) => l.reminder_level);
        verwacht(new Set(niveaus).size === niveaus.length, `${x.number}: niveaus ${niveaus.join(', ')}`);
      }
    });
  } else {
    overgeslagen('de controles na de cron', 'de cron-run mislukte');
  }

  await stap('automatische herinneringen weer uit (de cron van andere scenario\'s laat deze werelden met rust)', async () => {
    gelukt(await zetInstellingen(noord, { auto_reminders_enabled: false }), 'noord uit');
    gelukt(await zetInstellingen(zuid, { auto_reminders_enabled: false }), 'zuid uit');
  });
  return run ? f : null;
}

// ── 5. Formele aanmaning (WIK), handmatig ──────────────────────────────────

async function aanmaning(a) {
  groep('Aanmaningen — handmatig (WIK)');

  await stap('geen aanmaning voor een concept', async () => {
    const f = await nieuweFactuur(a, { verstuur: false, dagenTeLaat: 30 });
    geweigerd(await stelVoor(a.medewerker, a, f), 'aanmaning voor een concept');
    gelijk(aanmaningen(f.id).length, 0, 'aanmaningen');
  });

  await stap('geen aanmaning vóór of op de vervaldatum', async () => {
    const gevallen = [['nog niet vervallen', await nieuweFactuur(a)]];
    // Rond middernacht (UTC) is het in Amsterdam al morgen; dan is "vandaag
    // vervallen" voor de database terecht al gisteren vervallen.
    if (vandaag() === vandaagInAmsterdam()) gevallen.push(['vervalt vandaag', await nieuweFactuur(a, { dagenTeLaat: 0 })]);
    for (const [wat, f] of gevallen) {
      geweigerd(await stelVoor(a.medewerker, a, f), `aanmaning (${wat})`);
      gelijk(aanmaningen(f.id).length, 0, `aanmaningen (${wat})`);
    }
  });

  const zakelijk = await stap('voorstel zakelijk na een deelbetaling: hoofdsom = openstaand, € 40 minimum, handelsrente; er gaat nog niets uit', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 46 });
    await bankBetaling(a, f, DEELBETALING);
    const voor = mailsAan(a.klantA.email).length;
    const json = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    const hoofdsom = TOTAAL_CENTEN - DEELBETALING;
    const rente = verwachteRente(hoofdsom, f.due_date, vandaag(), 'commercial');
    const wik = verwachteWik(hoofdsom);
    gelijk(wik, 4000, 'eigen staffelberekening (minimum)');
    const [n] = aanmaningen(f.id);
    gelijk(
      [n.status, n.client_kind, n.interest_kind, n.principal_cents, n.interest_days, n.interest_cents, n.collection_costs_cents, n.collection_costs_vat_cents, n.total_claim_cents, n.calculation_date, n.due_date],
      ['proposed', 'business', 'commercial', hoofdsom, rente.dagen, rente.centen, wik, 0, hoofdsom + rente.centen + wik, vandaag(), f.due_date],
      'voorstel (status, soort, hoofdsom, dagen, rente, kosten, btw, totaal, rekendatum, vervaldatum)',
    );
    gelijk(n.id, json.noticeId, 'id in het antwoord');
    gelijk(mailsAan(a.klantA.email).length, voor, 'mails na het voorstel');
    gelijk(leveringen(f.id, 'dunning').length, 0, 'verzendregels na het voorstel');
    return { f, noticeId: json.noticeId, hoofdsom, wik };
  });

  if (zakelijk) {
    await stap('een tweede aanmaning voor dezelfde factuur kan niet', async () => {
      geweigerd(await stelVoor(a.beheerder, a, zakelijk.f), 'tweede voorstel', [409]);
      gelijk(aanmaningen(zakelijk.f.id).length, 1, 'aanmaningen');
    });

    await stap('versturen na bevestiging: de juiste mail en brief, bedragen op de verzenddatum', async () => {
      const { f, noticeId, hoofdsom, wik } = zakelijk;
      const json = gelukt(await stuur(a.medewerker, a, noticeId), 'versturen');
      const dag = vandaag();
      const termijn = plusDagen(dag, 14);
      const rente = verwachteRente(hoofdsom, f.due_date, dag, 'commercial');
      const totaal = hoofdsom + rente.centen + wik;
      const mails = aanmaningsMails(f.id);
      gelijk(mails.length, 1, 'aanmaningsmails');
      const m = mails[0];
      gelijk(m.to, [a.klantA.email], 'ontvanger');
      gelijk(m.subject, `Aanmaning factuur ${f.number} — reageer vóór ${datumNl(termijn)}`, 'onderwerp');
      for (const regel of [`Hoofdsom: ${euro(hoofdsom)}`, `Wettelijke handelsrente: ${euro(rente.centen)}`, `Incassokosten: ${euro(wik)}`,
        `Totaal te voldoen: ${euro(totaal)}`, `Uiterste betaaldatum: ${datumNl(termijn)}`, 'van rechtswege in verzuim']) {
        verwacht(m.text.includes(regel), `"${regel}" ontbreekt in de aanmaning:\n${m.text}`);
      }
      gelijk(m.bijlagen.map((b) => b.naam), [`aanmaning-${f.number}.pdf`], 'bijlagen');
      await isPdf(m.bijlagen[0].bytes, 'de aanmaningsbrief');
      gelijk(json.totalClaimCents, totaal, 'totaal in het antwoord');
      const [n] = aanmaningen(f.id);
      gelijk([n.status, n.deadline_date, n.total_claim_cents, n.interest_cents], ['sent', termijn, totaal, rente.centen], 'aanmaning na versturen');
      gelijk(leveringen(f.id, 'dunning').map((r) => [r.status, r.recipient_email]), [['sent', a.klantA.email]], 'verzendregel');
    });

    // Vastgelegd zoals het nu werkt: de knop in de aanmaning betaalt de factuur,
    // dus het openstaande bedrag — niet het factuurtotaal (na een deelbetaling)
    // en niet de rente en incassokosten (die staan niet op de factuur).
    await stap('de betaallink in de aanmaning vraagt het openstaande bedrag van de factuur', async () => {
      const m = aanmaningsMails(zakelijk.f.id)[0];
      verwacht(m, 'geen aanmaningsmail');
      const betaling = molliebetalingen(zakelijk.f.id).find((b) => m.text.includes(b.id));
      verwacht(betaling, 'geen Mollie-betaallink in de aanmaning');
      gelijk(betaling.amount.value, (zakelijk.hoofdsom / 100).toFixed(2), 'bedrag van de betaallink');
      gelijk(betaling.sleutel, a.mollieSleutel, 'Mollie-sleutel');
    });

    await stap('een verstuurde aanmaning gaat niet nog eens uit en is niet meer te annuleren', async () => {
      geweigerd(await stuur(a.medewerker, a, zakelijk.noticeId), 'opnieuw versturen', [409]);
      geweigerd(await annuleer(a.medewerker, a, zakelijk.noticeId), 'annuleren na versturen', [409]);
      gelijk(aanmaningsMails(zakelijk.f.id).length, 1, 'aanmaningsmails');
      gelijk(aanmaningen(zakelijk.f.id).map((n) => n.status), ['sent'], 'status');
      geweigerd(await stelVoor(a.medewerker, a, zakelijk.f), 'nieuw voorstel na een verstuurde aanmaning', [409]);
    });
  } else {
    overgeslagen('versturen, tweede aanmaning en annuleren na versturen', 'het voorstel mislukte');
  }

  // Het voorstel (vaak van de cron) en de bevestiging liggen soms dagen uit
  // elkaar. Betaalt de klant intussen een deel, dan rekent het versturen met
  // het nieuwe openstaande bedrag; wat we vastleggen van de verstuurde brief
  // hoort daarmee te kloppen (de app toont hoofdsom en totaal uit die rij).
  await stap('een deelbetaling tussen voorstel en versturen: brief én vastgelegde aanmaning met het nieuwe openstaande bedrag', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    gelijk(aanmaningen(f.id)[0].principal_cents, TOTAAL_CENTEN, 'hoofdsom in het voorstel');
    await bankBetaling(a, f, DEELBETALING);
    gelukt(await stuur(a.medewerker, a, noticeId), 'versturen');
    const open = TOTAAL_CENTEN - DEELBETALING;
    const rente = verwachteRente(open, f.due_date, vandaag(), 'commercial');
    const wik = verwachteWik(open);
    const totaal = open + rente.centen + wik;
    const m = aanmaningsMails(f.id)[0];
    verwacht(m, 'geen aanmaningsmail');
    for (const regel of [`Hoofdsom: ${euro(open)}`, `Totaal te voldoen: ${euro(totaal)}`]) {
      verwacht(m.text.includes(regel), `"${regel}" ontbreekt in de aanmaning:\n${m.text}`);
    }
    const [n] = aanmaningen(f.id);
    gelijk(
      [n.status, n.principal_cents, n.interest_cents, n.collection_costs_cents, n.total_claim_cents],
      ['sent', open, rente.centen, wik, totaal],
      'vastgelegde aanmaning (status, hoofdsom, rente, kosten, totaal) — de brief zei hoofdsom ' + euro(open),
    );
  });

  // Een formele aanmaning met incassokosten voor een betaalde factuur is precies
  // wat niet mag gebeuren.
  await stap('na een volledige betaling gaat een voorgestelde aanmaning niet meer de deur uit', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    await bankBetaling(a, f, TOTAAL_CENTEN);
    gelijk(stand(f.id).status, 'paid', 'status na de betaling');
    geweigerd(await stuur(a.medewerker, a, noticeId), 'versturen na betaling', [409]);
    gelijk(aanmaningsMails(f.id).length, 0, 'mails');
    gelijk(leveringen(f.id, 'dunning'), [], 'verzendregels');
  });

  await stap('een goedgekeurde aanmaning gaat niet naar een ander adres dan op de goedkeurkaart stond', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    geweigerd(await wf(a.medewerker.token, { action: 'sendDunningNotice', organizationId: a.orgId, noticeId, expectedRecipientEmail: 'oud-adres@klant.test' }), 'aanmaning met een ander goedgekeurd adres', [409]);
    gelijk(aanmaningsMails(f.id).length, 0, 'mails');
    gelijk(aanmaningen(f.id).map((n) => n.status), ['proposed'], 'status');
  });

  // De instelling "btw over incassokosten" (voor wie de btw niet kan verrekenen):
  // 21% over de WIK-kosten, apart in de mail.
  await stap('btw over de incassokosten als de organisatie dat instelt', async () => {
    const pad = `invoice_reminder_settings?organization_id=eq.${a.orgId}`;
    gelukt(await rest(pad, { method: 'PATCH', token: a.eigenaar.token, prefer: 'return=representation', body: { dunning_collection_costs_vat: true } }), 'btw over kosten aan');
    try {
      const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
      const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
      const btw = Math.round(4000 * 0.21);
      const rente = verwachteRente(TOTAAL_CENTEN, f.due_date, vandaag(), 'commercial');
      const [n] = aanmaningen(f.id);
      gelijk([n.collection_costs_cents, n.collection_costs_vat_cents, n.total_claim_cents], [4000, btw, TOTAAL_CENTEN + rente.centen + 4000 + btw], 'kosten, btw en totaal');
      gelukt(await stuur(a.medewerker, a, noticeId), 'versturen');
      const m = aanmaningsMails(f.id)[0];
      verwacht(m?.text.includes(`Incassokosten: ${euro(4000)} + ${euro(btw)} btw`), `incassokosten: ${regelMet(m?.text, 'Incassokosten')}`);
    } finally {
      gelukt(await rest(pad, { method: 'PATCH', token: a.eigenaar.token, prefer: 'return=representation', body: { dunning_collection_costs_vat: false } }), 'btw over kosten weer uit');
    }
  });

  await stap('annuleren werkt, en daarna kan er een nieuw voorstel komen', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 35 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    gelukt(await annuleer(a.medewerker, a, noticeId), 'annuleren');
    gelijk(aanmaningen(f.id).map((n) => n.status), ['cancelled'], 'status na annuleren');
    geweigerd(await stuur(a.medewerker, a, noticeId), 'versturen na annuleren', [409]);
    gelijk(aanmaningsMails(f.id).length, 0, 'mails');
    gelukt(await stelVoor(a.medewerker, a, f), 'nieuw voorstel na annuleren');
    gelijk(aanmaningen(f.id).map((n) => n.status), ['cancelled', 'proposed'], 'aanmaningen');
  });

  // De unieke index (één open aanmaning per factuur) houdt de andere tegen; de
  // gebruiker hoort dan "er bestaat al een aanmaning" (409), geen serverfout.
  // Drie tegelijk: met twee zag de tweede het eerste voorstel soms al (dan 409
  // via de gewone controle) en toetste deze stap de botsing niet.
  await stap('drie collega\'s tegelijk een aanmaning voorstellen: één aanmaning, de rest een nette weigering', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
    const antwoorden = await Promise.all([a.medewerker, a.beheerder, a.eigenaar].map((g) => stelVoor(g, a, f)));
    gelijk(aanmaningen(f.id).length, 1, 'aanmaningen');
    gelijk(antwoorden.map((r) => r.status).sort(), [200, 409, 409], `antwoorden (${antwoorden.map((r) => `${r.status} ${r.json?.error ?? ''}`).join(' | ')})`);
  });

  await stap('twee keer tegelijk "Bevestig & verstuur": één aanmaning de deur uit', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    const antwoorden = await Promise.all([stuur(a.medewerker, a, noticeId), stuur(a.beheerder, a, noticeId)]);
    gelijk(aanmaningsMails(f.id).length, 1, 'aanmaningsmails');
    gelijk(antwoorden.map((r) => r.status).sort(), [200, 409], `antwoorden (${antwoorden.map((r) => `${r.status} ${r.json?.error ?? ''}`).join(' | ')})`);
    gelijk(aanmaningen(f.id).map((n) => n.status), ['sent'], 'status');
  });

  await stap('consument: wettelijke rente, de WIK-staffel en de 14-dagenbrief', async () => {
    const consument = await nieuweConsument(a);
    const f = await nieuweFactuur(a, { klant: consument, regels: [{ description: 'Verbouwing badkamer', quantity: 1, unit_price: 10000, vat: 21 }], dagenTeLaat: 46 });
    const hoofdsom = 1210000;
    const wik = verwachteWik(hoofdsom);
    gelijk(wik, 89600, 'eigen staffelberekening (€ 375 + € 250 + € 250 + € 21)');
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    const rente = verwachteRente(hoofdsom, f.due_date, vandaag(), 'consumer');
    const [n] = aanmaningen(f.id);
    gelijk(
      [n.client_kind, n.interest_kind, n.principal_cents, n.interest_cents, n.collection_costs_cents, n.total_claim_cents],
      ['consumer', 'consumer', hoofdsom, rente.centen, wik, hoofdsom + rente.centen + wik],
      'voorstel (soort, rente, hoofdsom, rente, kosten, totaal)',
    );
    gelukt(await stuur(a.medewerker, a, noticeId), 'versturen');
    const m = aanmaningsMails(f.id)[0];
    verwacht(m, 'geen aanmaningsmail');
    gelijk(m.to, [consument.email], 'ontvanger');
    // Bij een consument zijn de incassokosten pas verschuldigd na de termijn van
    // veertien dagen; "nu te voldoen" is hoofdsom plus rente.
    for (const regel of [`Hoofdsom: ${euro(hoofdsom)}`, `Wettelijke rente: ${euro(rente.centen)}`, `Incassokosten bij uitblijven betaling: ${euro(wik)}`,
      `Nu te voldoen (hoofdsom + rente): ${euro(hoofdsom + rente.centen)}`, 'veertien dagen vanaf de dag nadat deze brief bij u is bezorgd']) {
      verwacht(m.text.includes(regel), `"${regel}" ontbreekt in de aanmaning:\n${m.text}`);
    }
    verwacht(!m.text.includes('van rechtswege in verzuim'), 'de zakelijke sommatie staat in de brief aan een consument');
    gelijk(m.bijlagen.map((b) => b.naam), [`aanmaning-${f.number}.pdf`], 'bijlagen');
    await isPdf(m.bijlagen[0].bytes, 'de aanmaningsbrief');
  });
}

// ── 6. Aanmaningscron ──────────────────────────────────────────────────────

async function aanmaningscron(noord, uit, f) {
  groep('Aanmaningen — cron');

  const run = await stap('de aanmaningscron stelt voor en verstuurt niets', async () => {
    gelukt(await zetInstellingen(noord, { dunning_enabled: true, dunning_offset_days: 25 }), 'aanmaningen aan (noord)');
    const mailsVoor = post.mails.length;
    const logVoor = post.log.length;
    const json = gelukt(await cron('dunning'), 'aanmaningscron');
    gelijk(post.mails.length, mailsVoor, 'mails tijdens de aanmaningscron');
    gelijk(post.log.slice(logVoor).filter((r) => /^(resend|mollie)/.test(r)), [], 'aanroepen naar Resend of Mollie tijdens de aanmaningscron');
    const notices = aanmaningen(f.deels.id);
    gelijk(notices.length, 1, 'voorstellen voor de factuur van 30 dagen te laat (termijn 25)');
    const [n] = notices;
    gelijk([n.status, n.organization_id, n.principal_cents, n.created_by], ['proposed', noord.orgId, TOTAAL_CENTEN - DEELBETALING, null], 'voorstel (status, organisatie, hoofdsom = openstaand, door de cron)');
    gelijk(leveringen(f.deels.id, 'dunning').length, 0, 'verzendregels');
    return json;
  });

  if (run) {
    await stap('geen voorstel voor een concept, gepauzeerde, betaalde of te recente factuur, en niet als het uit staat', async () => {
      for (const [wat, x] of [['concept', f.concept], ['gepauzeerd', f.gepauzeerd], ['betaald', f.betaald], ['13 dagen te laat', f.achter],
        ['aanmaningen uit', f.uit], ['zonder instellingen', f.geenInstellingen], ['andere organisatie', f.zuid]]) {
        gelijk(aanmaningen(x.id).length, 0, `voorstellen (${wat})`);
      }
    });

    await stap('een tweede run maakt geen tweede voorstel', async () => {
      gelukt(await cron('dunning'), 'tweede run');
      gelijk(aanmaningen(f.deels.id).map((n) => n.status), ['proposed'], 'voorstellen');
    });
  } else {
    overgeslagen('controles na de aanmaningscron', 'de run mislukte');
  }

  await stap('aanmaningen weer uit', async () => {
    gelukt(await zetInstellingen(noord, { dunning_enabled: false }), 'noord uit');
  });
}

// ── 7. Robuustheid ─────────────────────────────────────────────────────────

async function robuustheid(a) {
  groep('Herinneringen en aanmaningen — robuustheid');

  const f = await stap('Resend-storing bij een herinnering: nette fout, de verzendregel op mislukt, het niveau blijft', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    post.resendStoring.aantal = 1;
    post.resendStoring.soort = '500';
    let res;
    try {
      res = await herinner(a.medewerker, a, f, { includePaymentLink: false });
    } finally {
      post.resendStoring.aantal = 0;
    }
    gelijk(res.status, 502, `status (${res.tekst.slice(0, 200)})`);
    verwacht(res.json?.ok === false && /Resend/.test(res.json.error), `melding: ${res.json?.error}`);
    gelijk(leveringen(f.id, 'reminder').map((l) => l.status), ['failed'], 'verzendregel na de storing');
    gelijk(stand(f.id).reminder_level, 0, 'reminder_level');
    gelijk(herinneringsMails(f.id).length, 0, 'mails');
    return f;
  });

  if (f) {
    await stap('opnieuw proberen lukt: de mislukte regel houdt niets tegen', async () => {
      const json = gelukt(await herinner(a.medewerker, a, f, { includePaymentLink: false }), 'tweede poging');
      gelijk(json.level, 1, 'niveau');
      gelijk(leveringen(f.id, 'reminder').map((l) => l.status), ['failed', 'sent'], 'verzendregels');
      gelijk(herinneringsMails(f.id).length, 1, 'mails');
    });

    await stap('netwerkfout naar Resend: ook netjes, en daarna lukt niveau 2', async () => {
      post.resendStoring.aantal = 1;
      post.resendStoring.soort = 'netwerk';
      let res;
      try {
        res = await herinner(a.medewerker, a, f, { includePaymentLink: false });
      } finally {
        post.resendStoring.aantal = 0;
        post.resendStoring.soort = '500';
      }
      gelijk(res.status, 502, `status (${res.tekst.slice(0, 200)})`);
      gelijk(stand(f.id).reminder_level, 1, 'reminder_level na de netwerkfout');
      gelijk(gelukt(await herinner(a.medewerker, a, f, { includePaymentLink: false }), 'na de netwerkfout').level, 2, 'niveau');
      gelijk(leveringen(f.id, 'reminder').map((l) => [l.reminder_level, l.status]), [[1, 'failed'], [1, 'sent'], [2, 'failed'], [2, 'sent']], 'verzendregels');
    });
  } else {
    overgeslagen('opnieuw proberen', 'de storingsstap mislukte');
  }

  await stap('mailquotum op: herinnering en aanmaning geweigerd vóór de verzendregel, daarna gaat het gewoon', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 20 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'aanmaning voorstellen');
    let herinnering;
    let brief;
    zetQuotum(a, 0);
    try {
      herinnering = await herinner(a.medewerker, a, f, { includePaymentLink: false });
      brief = await stuur(a.medewerker, a, noticeId);
    } finally {
      zetQuotum(a, null);
    }
    geweigerd(herinnering, 'herinnering bij een vol quotum', [429]);
    geweigerd(brief, 'aanmaning bij een vol quotum', [429]);
    verwacht(/grens voor e-mail/.test(herinnering.json?.error ?? ''), `melding: ${herinnering.json?.error}`);
    gelijk(leveringen(f.id).filter((l) => l.delivery_kind !== 'invoice'), [], 'verzendregels na de weigering');
    gelijk(aanmaningen(f.id).map((n) => n.status), ['proposed'], 'de aanmaning bleef een voorstel');
    gelijk(stand(f.id).reminder_level, 0, 'reminder_level');
    gelijk(herinneringsMails(f.id).length + aanmaningsMails(f.id).length, 0, 'mails');
    gelijk(gelukt(await herinner(a.medewerker, a, f, { includePaymentLink: false }), 'herinnering na het quotum').level, 1, 'niveau');
    gelukt(await stuur(a.medewerker, a, noticeId), 'aanmaning na het quotum');
    gelijk(aanmaningen(f.id).map((n) => n.status), ['sent'], 'aanmaning na het quotum');
  });

  await stap('Resend-storing bij een aanmaning: de aanmaning op mislukt, opnieuw versturen lukt', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 40 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstellen');
    post.resendStoring.aantal = 1;
    post.resendStoring.soort = '500';
    let res;
    try {
      res = await stuur(a.medewerker, a, noticeId);
    } finally {
      post.resendStoring.aantal = 0;
    }
    gelijk(res.status, 502, `status (${res.tekst.slice(0, 200)})`);
    gelijk(aanmaningen(f.id).map((n) => n.status), ['failed'], 'status na de storing (niet "confirmed")');
    gelijk(leveringen(f.id, 'dunning').map((l) => l.status), ['failed'], 'verzendregel na de storing');
    gelukt(await stuur(a.medewerker, a, noticeId), 'opnieuw versturen');
    gelijk(aanmaningen(f.id).map((n) => n.status), ['sent'], 'status na opnieuw versturen');
    gelijk(aanmaningsMails(f.id).length, 1, 'aanmaningsmails');
  });
}

// ── 8. Beveiliging ─────────────────────────────────────────────────────────

async function beveiliging(a, ander) {
  groep('Herinneringen en aanmaningen — beveiliging');

  const doel = await stap('klaarzetten: een te late factuur met een aanmaningsvoorstel', async () => {
    const f = await nieuweFactuur(a, { dagenTeLaat: 30 });
    const { noticeId } = gelukt(await stelVoor(a.medewerker, a, f), 'voorstel');
    return { f, noticeId };
  });
  if (!doel) return;

  const handelingen = (organizationId) => [
    ['herinnering', { action: 'sendInvoiceReminderEmail', organizationId, invoiceId: doel.f.id }],
    ['aanmaning voorstellen', { action: 'proposeDunningNotice', organizationId, invoiceId: doel.f.id }],
    ['aanmaning versturen', { action: 'sendDunningNotice', organizationId, noticeId: doel.noticeId }],
    ['aanmaning annuleren', { action: 'cancelDunningNotice', organizationId, noticeId: doel.noticeId }],
  ];
  const ongemoeid = (wanneer) => {
    gelijk(herinneringsMails(doel.f.id).length + aanmaningsMails(doel.f.id).length, 0, `mails (${wanneer})`);
    gelijk(stand(doel.f.id).reminder_level, 0, `reminder_level (${wanneer})`);
    gelijk(aanmaningen(doel.f.id).map((n) => n.status), ['proposed'], `aanmaning (${wanneer})`);
    gelijk(leveringen(doel.f.id).filter((l) => l.delivery_kind !== 'invoice'), [], `verzendregels (${wanneer})`);
  };

  await stap('kijker, boekhouder, lezer en zonder Financiën kunnen niets sturen, voorstellen of annuleren', async () => {
    for (const [wie, g] of [['kijker', a.kijker], ['boekhouder', a.boekhouder], ['lezer', a.lezer], ['zonder Financiën', a.zonderFinancien]]) {
      for (const [wat, body] of handelingen(a.orgId)) geweigerd(await wf(g.token, body), `${wat} als ${wie}`, [403]);
    }
    ongemoeid('na de rollen');
  });

  // De organisatie komt uit de sessie; wie zijn eigen organisatie meestuurt met
  // ons factuur- of aanmanings-id, mag niets vinden.
  await stap('een andere organisatie, met haar eigen organizationId en jouw factuur of aanmaning', async () => {
    for (const g of [ander.eigenaar, ander.medewerker]) {
      for (const [wat, body] of handelingen(ander.orgId)) geweigerd(await wf(g.token, body), `${wat} via de eigen organisatie`, [404]);
    }
    ongemoeid('na de andere organisatie');
  });

  await stap('een andere organisatie, met jouw organizationId', async () => {
    for (const [wat, body] of handelingen(a.orgId)) geweigerd(await wf(ander.eigenaar.token, body), wat, [403]);
    ongemoeid('na de vreemde organizationId');
  });

  await stap('anoniem: niets', async () => {
    for (const [wat, body] of handelingen(a.orgId)) {
      geweigerd(await wf(undefined, body), `${wat} zonder sessie`, [401]);
      geweigerd(await wf(ANON_KEY, body), `${wat} met alleen de anon-sleutel`, [401]);
    }
    ongemoeid('anoniem');
  });

  // Alles wat een herinnering of aanmaning vastlegt, zet de server. Een lid met
  // schrijfrecht mag dat niet buiten de edge function om (geen mail, geen
  // quotum, geen controle): ook niet via PostgREST of de RPC's zelf.
  await stap('rechtstreeks in de database: geen omweg langs de server', async () => {
    const lid = a.medewerker.token;
    geweigerd(await rest(`invoices?id=eq.${doel.f.id}`, { method: 'PATCH', token: lid, prefer: 'return=representation', body: { reminder_level: 3, last_reminder_at: new Date().toISOString() } }), 'reminder_level zetten');
    nietsVeranderd(await rest(`invoice_dunning_notices?id=eq.${doel.noticeId}`, { method: 'PATCH', token: lid, prefer: 'return=representation', body: { status: 'sent', total_claim_cents: 1 } }), 'aanmaning wijzigen');
    geweigerd(await rest('invoice_dunning_notices', { method: 'POST', token: lid, prefer: 'return=representation', body: { organization_id: a.orgId, invoice_id: doel.f.id, client_kind: 'business', interest_kind: 'commercial', principal_cents: 1, total_claim_cents: 1, calculation_date: vandaag(), status: 'sent' } }), 'aanmaning invoegen');
    geweigerd(await rest('invoice_email_deliveries', { method: 'POST', token: lid, prefer: 'return=representation', body: { organization_id: a.orgId, invoice_id: doel.f.id, recipient_email: a.klantA.email, subject: 'nep', status: 'sent', delivery_kind: 'reminder', reminder_level: 3 } }), 'verzendregel invoegen');
    const nul = '00000000-0000-4000-8000-000000000000';
    const rpcs = [
      ['begin_invoice_reminder_send', { p_invoice_id: doel.f.id, p_organization_id: a.orgId, p_actor_user_id: a.medewerker.id, p_level: 1, p_token_hash: 'x', p_token_expires_at: new Date().toISOString(), p_recipient_email: 'iemand@elders.test', p_recipient_name: 'x', p_subject: 'x', p_public_url: 'x' }],
      ['complete_invoice_reminder_send', { p_delivery_id: nul, p_organization_id: a.orgId, p_actor_user_id: a.medewerker.id, p_provider_email_id: 'x', p_level: 3 }],
      ['begin_dunning_notice', { p_organization_id: a.orgId, p_invoice_id: doel.f.id, p_actor_user_id: a.medewerker.id, p_client_kind: 'business', p_interest_kind: 'commercial', p_principal_cents: 1, p_interest_cents: 0, p_interest_days: 0, p_daily_interest_cents: 0, p_collection_costs_cents: 0, p_collection_costs_vat_cents: 0, p_total_claim_cents: 1, p_calculation_date: vandaag(), p_due_date: doel.f.due_date }],
      ['cancel_dunning_notice', { p_notice_id: doel.noticeId, p_organization_id: a.orgId, p_actor_user_id: a.medewerker.id }],
      ['find_due_invoice_reminders', { p_limit: 10 }],
      ['find_due_dunning_candidates', { p_limit: 10 }],
      ['mark_invoices_overdue', { p_organization_id: a.orgId }],
    ];
    for (const [naam, args] of rpcs) {
      const res = await rpc(naam, args, lid);
      // Met de juiste parameters: dan gaat een weigering echt over rechten
      // (42501), niet over een functie die PostgREST niet vond (PGRST202).
      verwacht([401, 403].includes(res.status) && res.json?.code === '42501', `${naam} als lid: verwacht 42501, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
    }
    gelijk((await rest(`invoice_dunning_notices?invoice_id=eq.${doel.f.id}`, { token: ander.eigenaar.token })).json, [], 'aanmaningen lezen door de andere organisatie');
    gelijk((await rest(`invoice_email_deliveries?invoice_id=eq.${doel.f.id}`, { token: ander.eigenaar.token })).json, [], 'verzendregels lezen door de andere organisatie');
    ongemoeid('na de pogingen in de database');
  });
}
