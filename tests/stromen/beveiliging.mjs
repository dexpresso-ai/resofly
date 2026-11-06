// Beveiligingsscenario: offertes, facturen, herinneringen en contracten, bekeken
// door de ogen van een aanvaller.
//
// Organisatie A is het slachtoffer: daar staan echte documenten, klaargezet
// langs de gewone weg (offerte verstuurd en geaccepteerd, factuur verstuurd en
// betaald via Mollie, contract verstuurd en getekend). Organisatie B is de
// aanvaller. Daarnaast proberen de rollen binnen A met te weinig rechten, een
// bezoeker zonder login, een klant in het portaal en "Mollie" zelf dingen die
// niet mogen.
//
// Waarom zo'n scenario: de unittests toetsen één regel tegelijk. Een lek zit
// meestal in de naad ertussen — een edge function die op de service-role draait
// en zelf moet filteren, een trigger die één kolom vergeet, een antwoord dat
// meer teruggeeft dan het scherm nodig heeft. Hier lopen de echte functies,
// de echte RLS en de echte triggers samen.
//
// Elke aanval moet een nette weigering opleveren (4xx, of 0 rijen bij PostgREST)
// en mag niets veranderen. Na de aanvallen vergelijken we de stand van A met
// een foto van ervoor; pas daarna volgen de stappen die A bewust wél
// veranderen (intrekken, terug naar concept) en de zijdeur via het portaal.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { ANON_KEY, CRON_SECRET, R2_GEHEIM, SERVICE_KEY, WEBHOOK_SECRET } from './omgeving.mjs';
import { mollieBetaal, post } from './nepdiensten.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';

/**
 * Een datum (JJJJ-MM-DD) in Nederland, `dagen` vanaf vandaag. Niet vast op
 * één dag: een offerte die "geldig tot" in het verleden heeft, gaat niet door
 * de goedkeuring, en dan zou dit scenario na een paar weken niets meer toetsen.
 */
function datum(dagen = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(Date.now() + dagen * 86_400_000));
}
const VANDAAG = datum(0);
const GELDIG_TOT = datum(45);
const AKKOORDTEKST = 'Ik heb dit contract gelezen en ga ermee akkoord. Ik onderteken dit document rechtsgeldig met een elektronische handtekening.';
const BUIT = 'buit@aanvaller.test';
const WEBHOOK = '?webhook=mollie';

// ── Hulpjes ─────────────────────────────────────────────────────────────────

/** Elk antwoord van een edge function, voor de lekcontrole aan het eind. */
const antwoorden = [];

async function fn(naam, opties, label) {
  const res = await roep(naam, opties);
  antwoorden.push({ label: label ?? `${naam} ${opties?.body?.action ?? ''}`.trim(), status: res.status, tekst: res.tekst });
  return res;
}

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function sha256(tekst) {
  return createHash('sha256').update(tekst).digest('hex');
}

function kort(res) {
  return `${res.status} ${String(res.tekst ?? '').slice(0, 300)}`;
}

/**
 * Meerdere controles in één stap: alles proberen, daarna alle mislukte samen
 * melden. Zo zie je in één ronde welke velden of rollen lekken, niet alleen de
 * eerste.
 */
async function allemaal(controles) {
  const fouten = [];
  for (const [omschrijving, controle] of controles) {
    try {
      await controle();
    } catch (error) {
      fouten.push(`${omschrijving}: ${error?.message ?? error}`);
    }
  }
  // Op één regel: toets.mjs toont alleen de eerste vijf regels van een fout.
  if (fouten.length) throw new Error(`${fouten.length} van ${controles.length} mislukt: ${fouten.join(' | ')}`);
}

/** De mails die tijdens `actie` de deur uit gingen. */
async function metMails(actie) {
  const voor = post.mails.length;
  const uitkomst = await actie();
  return { uitkomst, mails: post.mails.slice(voor) };
}

function tokenUit(mails, soort) {
  for (const mail of mails) {
    const m = `${mail.html} ${mail.text}`.match(new RegExp(`/${soort}/([A-Za-z0-9_-]{20,})`));
    if (m) return m[1];
  }
  return null;
}

/** Een PostgREST-lezing die niets oplevert: een nette fout of een lege lijst. */
function leeg(res, melding) {
  if (res.status >= 500) throw new Error(`${melding}: serverfout ${kort(res)}`);
  if (res.status >= 200 && res.status < 300) {
    verwacht(Array.isArray(res.json) ? res.json.length === 0 : res.json === null, `${melding}: kreeg gegevens ${kort(res)}`);
  }
}

/**
 * Een PostgREST-schrijfpoging die niets mag doen: een nette fout (4xx) of 0
 * rijen geraakt. Strenger dan nietsVeranderd uit toets.mjs: een 5xx telt hier
 * als fout, want een crash is geen weigering.
 */
function geenWijziging(res, melding) {
  if (res.status >= 500) throw new Error(`${melding}: serverfout ${kort(res)}`);
  if (res.status >= 200 && res.status < 300) {
    verwacht(Array.isArray(res.json) && res.json.length === 0, `${melding}: verwacht geen wijziging, kreeg ${kort(res)}`);
  }
}

/** Een weigering op rechten: 401/403 met Postgres-code 42501 (geen "functie bestaat niet"). */
function geenRecht(res, melding) {
  if (![401, 403].includes(res.status) || (res.json?.code && res.json.code !== '42501')) {
    throw new Error(`${melding}: verwacht een weigering op rechten (42501), kreeg ${kort(res)}`);
  }
}

/** Een RPC-aanroep die niets mag doen: 4xx (geen 5xx, geen crash). */
function rpcGeweigerd(res, melding) {
  if (res.status < 400 || res.status >= 500) throw new Error(`${melding}: verwacht een weigering, kreeg ${kort(res)}`);
}

// ── Klaarzetten langs de gewone weg ─────────────────────────────────────────

async function conceptOfferte(w, extra = {}) {
  const res = await rest('quotes?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, client_id: w.klantA.id, number: uniek('BEV-OFF'), date: VANDAAG,
      valid_until: GELDIG_TOT, lines: REGELS, status: 'draft', ...extra,
    },
  });
  return gelukt(res, 'concept-offerte opslaan')[0];
}

async function offerteGoedgekeurd(w, extra) {
  const offerte = await conceptOfferte(w, extra);
  gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.medewerker.token), 'indienen');
  gelukt(await rpc('approve_quote_internal', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.beheerder.token), 'goedkeuren');
  return offerte;
}

async function offerteVerstuurd(w, extra) {
  const offerte = await offerteGoedgekeurd(w, extra);
  const { mails } = await metMails(async () => gelukt(await fn('quote-workflow', {
    token: w.medewerker.token, body: { action: 'sendQuoteEmail', organizationId: w.orgId, quoteId: offerte.id },
  }), 'offerte versturen'));
  const token = tokenUit(mails, 'quote');
  verwacht(token, 'geen offertelink in de mail');
  return { ...offerte, token };
}

async function conceptFactuur(w, extra = {}) {
  const res = await rest('invoices?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, client_id: w.klantA.id, number: uniek('BEV-FAC'), date: VANDAAG,
      due_date: datum(14), lines: REGELS, status: 'draft', ...extra,
    },
  });
  return gelukt(res, 'concept-factuur opslaan')[0];
}

async function factuurVerstuurd(w, extra, { betaallink = false } = {}) {
  const factuur = await conceptFactuur(w, extra);
  const { mails } = await metMails(async () => gelukt(await fn('invoice-workflow', {
    token: w.medewerker.token,
    body: { action: 'sendInvoiceEmail', organizationId: w.orgId, invoiceId: factuur.id, includePaymentLink: betaallink },
  }), 'factuur versturen'));
  const token = tokenUit(mails, 'invoice');
  verwacht(token, 'geen factuurlink in de mail');
  return { ...factuur, token };
}

async function conceptContract(w, extra = {}) {
  const res = await rest('contracts?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, client_id: w.klantA.id, title: uniek('Onderhoudscontract'),
      body: '<p>Artikel 1. De prijs is € 100 per maand.</p>', valid_until: GELDIG_TOT, ...extra,
    },
  });
  return gelukt(res, 'concept-contract opslaan')[0];
}

async function contractVerstuurd(w, extra) {
  const contract = await conceptContract(w, extra);
  const { mails } = await metMails(async () => gelukt(await fn('contract-workflow', {
    token: w.medewerker.token, body: { action: 'sendContractForSignature', organizationId: w.orgId, contractId: contract.id },
  }), 'contract versturen'));
  const token = tokenUit(mails, 'contract');
  verwacht(token, 'geen ondertekenlink in de mail');
  return { ...contract, token };
}

async function tekenen(token, naam, email) {
  const pagina = gelukt(await fn('contract-public', { body: { action: 'getContract', token } }), 'contract openen');
  return fn('contract-public', {
    body: {
      action: 'signContract', token, signerName: naam, signerEmail: email, signatureMethod: 'typed',
      consentText: AKKOORDTEKST, versionId: pagina.contract.version_id,
    },
  });
}

/** De nieuwste Mollie-betaling die bij deze factuur hoort (nep-Mollie). */
function mollieBetalingVan(factuurId) {
  return [...post.mollie.betalingen.values()].filter((b) => b.metadata?.invoiceId === factuurId).pop() ?? null;
}

async function klaarzetten(A, B) {
  const d = {
    mollieSleutelA: `test_bevA${randomBytes(12).toString('hex')}`,
    mollieSleutelB: `test_bevB${randomBytes(12).toString('hex')}`,
  };

  await stap('A en B koppelen elk hun eigen Mollie-account', async () => {
    gelukt(await fn('invoice-workflow', { token: A.eigenaar.token, body: { action: 'saveInvoiceMollieKey', organizationId: A.orgId, apiKey: d.mollieSleutelA } }), 'sleutel A');
    gelukt(await fn('invoice-workflow', { token: B.eigenaar.token, body: { action: 'saveInvoiceMollieKey', organizationId: B.orgId, apiKey: d.mollieSleutelB } }), 'sleutel B');
  });

  d.project = await stap('A: project van klant A', async () => {
    const res = await rest('projects?select=id,client_id,name', {
      method: 'POST', token: A.medewerker.token, prefer: 'return=representation',
      body: { organization_id: A.orgId, client_id: A.klantA.id, name: uniek('Project Alfa') },
    });
    return gelukt(res, 'project opslaan')[0];
  });

  // Offertes in elke stand die een aanvaller wil raken.
  d.qGeaccepteerd = await stap('A: offerte verstuurd en door de klant geaccepteerd', async () => {
    const offerte = await offerteVerstuurd(A, { project_id: d.project.id });
    gelukt(await fn('quote-public', { body: { action: 'acceptQuote', token: offerte.token, name: 'Anna Klant', email: A.klantA.email, note: 'Akkoord' } }), 'akkoord');
    return offerte;
  });
  d.qVerstuurd = await stap('A: offerte verstuurd, nog niet beslist', () => offerteVerstuurd(A, { project_id: d.project.id }));
  d.qZijdeur = await stap('A: tweede verstuurde offerte (voor de zijdeur via het portaal)', () => offerteVerstuurd(A));
  d.qGoedgekeurd = await stap('A: offerte intern goedgekeurd, nog niet verstuurd', () => offerteGoedgekeurd(A));
  d.qConcept = await stap('A: offerte in concept', () => conceptOfferte(A));
  d.qTerGoedkeuring = await stap('A: offerte ter interne goedkeuring', async () => {
    const offerte = await conceptOfferte(A);
    gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: offerte.id, p_organization_id: A.orgId }, A.medewerker.token), 'indienen');
    return offerte;
  });

  // Facturen: betaald via Mollie, open (te laat, met herinnering, aanmaning en
  // een open betaallink), gecrediteerd en concept.
  d.fBetaald = await stap('A: factuur verstuurd met betaallink en betaald via Mollie', async () => {
    const factuur = await factuurVerstuurd(A, { project_id: d.project.id }, { betaallink: true });
    const betaling = mollieBetalingVan(factuur.id);
    verwacht(betaling, 'geen Mollie-betaling aangemaakt');
    const webhook = await mollieBetaal(betaling.id);
    verwacht(webhook.ok, `webhook na betalen: ${webhook.status}`);
    gelijk(sqlRij(`select status from public.invoices where id = ${q(factuur.id)}`).status, 'paid', 'factuurstatus na betalen');
    const rij = sqlRij(`select id from public.invoice_payment_records where invoice_id = ${q(factuur.id)} and status = 'paid'`);
    return { ...factuur, mollieId: betaling.id, betaalrijId: rij.id };
  });
  d.fOpen = await stap('A: factuur verstuurd, te laat en open: herinnering, aanmaningsvoorstel en betaallink', async () => {
    const factuur = await factuurVerstuurd(A, { date: datum(-60), due_date: datum(-45), project_id: d.project.id });
    gelukt(await fn('invoice-workflow', {
      token: A.medewerker.token, body: { action: 'sendInvoiceReminderEmail', organizationId: A.orgId, invoiceId: factuur.id, includePaymentLink: false },
    }), 'herinnering versturen');
    const voorstel = gelukt(await fn('invoice-workflow', {
      token: A.eigenaar.token, body: { action: 'proposeDunningNotice', organizationId: A.orgId, invoiceId: factuur.id },
    }), 'aanmaning voorstellen');
    verwacht(voorstel.noticeId, 'geen aanmaning-id');
    gelukt(await fn('invoice-workflow', {
      token: A.medewerker.token, body: { action: 'createInvoicePaymentCheckout', organizationId: A.orgId, invoiceId: factuur.id },
    }), 'betaallink maken');
    const betaling = mollieBetalingVan(factuur.id);
    verwacht(betaling, 'geen Mollie-betaling voor de open factuur');
    return { ...factuur, aanmaningId: voorstel.noticeId, mollieId: betaling.id };
  });
  d.fGecrediteerd = await stap('A: factuur verstuurd en daarna gecrediteerd (creditnota)', async () => {
    const factuur = await factuurVerstuurd(A);
    const res = gelukt(await fn('invoice-workflow', {
      token: A.eigenaar.token, body: { action: 'creditInvoice', organizationId: A.orgId, invoiceId: factuur.id, reason: 'Dubbel gefactureerd' },
    }), 'crediteren');
    verwacht(res.creditNote?.id, 'geen creditnota');
    return { ...factuur, creditnotaId: res.creditNote.id };
  });
  d.fConcept = await stap('A: factuur in concept', () => conceptFactuur(A));

  // Contracten: getekend, verstuurd (twee: één gaat later terug naar concept,
  // één wordt ingetrokken) en concept.
  d.cGetekend = await stap('A: contract verstuurd en door de klant getekend', async () => {
    const contract = await contractVerstuurd(A);
    gelukt(await tekenen(contract.token, 'Anna Klant', A.klantA.email), 'tekenen');
    const ondertekenaar = sqlRij(`select id from public.contract_signers where contract_id = ${q(contract.id)} and role = 'client'`);
    return { ...contract, ondertekenaarId: ondertekenaar?.id };
  });
  d.cVerstuurd = await stap('A: contract verstuurd, nog niet getekend', () => contractVerstuurd(A));
  d.cIntrekken = await stap('A: tweede verstuurd contract (wordt later ingetrokken)', () => contractVerstuurd(A));
  d.cConcept = await stap('A: contract in concept', () => conceptContract(A));

  // B heeft ook eigen documenten: "eigen organisatie + id's van A" is dan een
  // echte, werkende sessie in B, en B's tokens bestaan echt.
  d.bOfferte = await stap('B: eigen offerte verstuurd', () => offerteVerstuurd(B));
  d.bFactuur = await stap('B: eigen factuur verstuurd', () => factuurVerstuurd(B));
  d.bContract = await stap('B: eigen contract verstuurd', () => contractVerstuurd(B));
  return d;
}

// ── De foto van A: alles wat een aanval niet mag veranderen ──────────────────

function fotoVanA(A) {
  const org = q(A.orgId);
  return {
    offertes: sqlRijen(`select id, status, internal_approval_status, public_token_hash, public_token_expires_at, sent_at, accepted_at,
      client_decision_at, client_decision_by_name, client_decision_by_email, client_decision_note, lines, notes, valid_until
      from public.quotes where organization_id = ${org} order by id`),
    // "sent" en "overdue" tellen als dezelfde stand: de dagelijkse cron
    // (mark_invoices_overdue) zet open facturen van álle organisaties op te
    // laat, en een ander scenario op dezelfde stack kan die net tijdens de
    // aanvallen draaien. Dat is geen aanval; een andere statuswijziging wel.
    facturen: sqlRijen(`select id, case when status = 'overdue' then 'sent' else status end as status, number, lines, notes, total_amount,
      public_token_hash, journal_entry_id, locked_at, locked_reason, refunded_amount, paid_at, sent_at, reminder_level, client_id, project_id, due_date
      from public.invoices where organization_id = ${org} order by id`),
    contracten: sqlRijen(`select id, status, title, body, public_token_hash, public_token_expires_at, signed_at, signed_document_sha256,
      signed_storage_key, sent_at, voided_at, client_id
      from public.contracts where organization_id = ${org} order by id`),
    ondertekenaars: sqlRijen(`select id, contract_id, status, name, email, signed_at, signature_method, signed_ip, consent_text,
      md5(coalesce(signature_image, '')) as handtekening from public.contract_signers where organization_id = ${org} order by id`),
    creditnotas: sqlRijen(`select id, status, number, total_amount, lines, reason from public.credit_notes where organization_id = ${org} order by id`),
    betalingen: sqlRijen(`select id, status, amount_cents, provider_payment_id, amount_refunded_cents from public.invoice_payment_records
      where organization_id = ${org} order by id`),
    terugbetalingen: sqlRijen(`select id, status, amount_cents from public.invoice_refunds where organization_id = ${org} order by id`),
    aanmaningen: sqlRijen(`select id, status, total_claim_cents from public.invoice_dunning_notices where organization_id = ${org} order by id`),
    klanten: sqlRijen(`select id, name, email from public.clients where organization_id = ${org} order by id`),
    contactpersonen: sqlRijen(`select id, client_id, email, gives_portal_access from public.client_contacts where organization_id = ${org} order by id`),
    bedrijf: sqlRij(`select company_name, iban, email, kvk_number from public.company_settings where organization_id = ${org}`),
    mollie: sqlRij(`select status, key_suffix, md5(coalesce(api_key_encrypted, '')) as sleutel from public.organization_invoice_mollie_settings where organization_id = ${org}`),
    aantallen: sqlRij(`select
      (select count(*) from public.journal_entries where organization_id = ${org})::int as journaalposten,
      (select count(*) from public.quote_versions where organization_id = ${org})::int as offerteversies,
      (select count(*) from public.invoice_versions where organization_id = ${org})::int as factuurversies,
      (select count(*) from public.contract_versions where organization_id = ${org})::int as contractversies,
      (select count(*) from public.invoice_public_links where organization_id = ${org})::int as factuurlinks,
      (select count(*) from public.quote_email_deliveries where organization_id = ${org})::int as offertemails,
      (select count(*) from public.invoice_email_deliveries where organization_id = ${org})::int as factuurmails,
      (select count(*) from public.contract_email_deliveries where organization_id = ${org})::int as contractmails`),
  };
}

function verschillen(voor, na, pad = '') {
  const uit = [];
  if (JSON.stringify(voor) === JSON.stringify(na)) return uit;
  if (voor && na && typeof voor === 'object' && typeof na === 'object' && !Array.isArray(voor)) {
    for (const sleutel of new Set([...Object.keys(voor), ...Object.keys(na)])) {
      uit.push(...verschillen(voor[sleutel], na[sleutel], `${pad}.${sleutel}`));
    }
    return uit;
  }
  if (Array.isArray(voor) && Array.isArray(na) && voor.length === na.length) {
    voor.forEach((rij, i) => uit.push(...verschillen(rij, na[i], `${pad}[${rij?.id ?? i}]`)));
    return uit;
  }
  uit.push(`${pad}: ${JSON.stringify(voor)?.slice(0, 160)} → ${JSON.stringify(na)?.slice(0, 160)}`);
  return uit;
}

// ── 1. Andere organisatie: B valt A aan ─────────────────────────────────────

/** De acties van de workflow-functies, met id's van documenten van A. */
function workflowActies(d) {
  return [
    // [functie, actie, velden, zonder document-id (alleen zinvol met de organisatie van A)]
    ['quote-workflow', 'sendQuoteEmail', { quoteId: d.qGoedgekeurd.id, recipientEmail: BUIT }],
    ['quote-workflow', 'downloadQuotePdf', { quoteId: d.qGeaccepteerd.id }],
    ['invoice-workflow', 'downloadInvoicePdf', { invoiceId: d.fBetaald.id }],
    ['invoice-workflow', 'downloadCreditNotePdf', { creditNoteId: d.fGecrediteerd.creditnotaId }],
    ['invoice-workflow', 'downloadInvoiceUbl', { invoiceId: d.fOpen.id }],
    ['invoice-workflow', 'downloadCreditNoteUbl', { creditNoteId: d.fGecrediteerd.creditnotaId }],
    ['invoice-workflow', 'syncMollieSalesInvoice', { invoiceId: d.fOpen.id }],
    ['invoice-workflow', 'downloadMollieInvoicePdf', { invoiceId: d.fBetaald.id }],
    ['invoice-workflow', 'getInvoiceMollieStatus', {}, true],
    ['invoice-workflow', 'sendInvoiceEmail', { invoiceId: d.fConcept.id, recipientEmail: BUIT }],
    ['invoice-workflow', 'sendInvoiceReminderEmail', { invoiceId: d.fOpen.id, recipientEmail: BUIT }],
    ['invoice-workflow', 'proposeDunningNotice', { invoiceId: d.fOpen.id }],
    ['invoice-workflow', 'sendDunningNotice', { noticeId: d.fOpen.aanmaningId, recipientEmail: BUIT }],
    ['invoice-workflow', 'cancelDunningNotice', { noticeId: d.fOpen.aanmaningId }],
    ['invoice-workflow', 'createInvoicePaymentCheckout', { invoiceId: d.fOpen.id }],
    ['invoice-workflow', 'createInvoiceRefund', { invoiceId: d.fBetaald.id, amountCents: 1000, reason: 'aanval' }],
    ['invoice-workflow', 'creditInvoice', { invoiceId: d.fOpen.id, reason: 'aanval' }],
    ['invoice-workflow', 'sendCreditNoteEmail', { creditNoteId: d.fGecrediteerd.creditnotaId, recipientEmail: BUIT }],
    ['invoice-workflow', 'markMockInvoicePaymentPaid', { providerPaymentId: d.fOpen.mollieId }],
    ['invoice-workflow', 'saveInvoiceMollieKey', { apiKey: d.mollieSleutelB }, true],
    ['invoice-workflow', 'deleteInvoiceMollieKey', {}, true],
    ['contract-workflow', 'sendContractForSignature', { contractId: d.cConcept.id, recipientEmail: BUIT }],
    ['contract-workflow', 'downloadContractPdf', { contractId: d.cGetekend.id }],
    ['contract-workflow', 'previewContractPdf', { contractId: d.cConcept.id }],
  ];
}

/** Alle tabellen met gegevens van offertes, facturen en contracten (plus wat daar direct aan hangt). */
const FINANCIEN_TABELLEN = [
  'quotes', 'quote_versions', 'quote_email_deliveries', 'quote_approval_events',
  'invoices', 'invoice_versions', 'invoice_email_deliveries', 'invoice_public_links', 'invoice_payment_records',
  'invoice_refunds', 'invoice_dunning_notices', 'invoice_reminder_settings', 'invoice_workflow_events', 'credit_notes',
  'contracts', 'contract_versions', 'contract_signers', 'contract_email_deliveries', 'contract_events',
  'journal_entries', 'journal_lines', 'organization_invoice_mollie_settings',
];

async function andereOrganisatie(A, B, d) {
  groep('Beveiliging: organisatie B valt organisatie A aan');
  const aanvallers = [['eigenaar', B.eigenaar], ['lid', B.medewerker], ['boekhouder', B.boekhouder]];

  for (const [functie, actie, velden, zonderId] of workflowActies(d)) {
    const titel = zonderId
      ? `${functie} ${actie}: B met de organisatie van A → 403`
      : `${functie} ${actie}: B met de organisatie van A → 403; met de eigen organisatie bestaat het document niet`;
    await stap(titel, () => allemaal([
      ...aanvallers.map(([wie, g]) => [`${wie} van B, organisatie A`, async () => {
        geweigerd(await fn(functie, { token: g.token, body: { action: actie, organizationId: A.orgId, ...velden } }), 'weigering', [403]);
      }]),
      ...(zonderId ? [] : [['eigenaar van B, eigen organisatie + id van A', async () => {
        geweigerd(await fn(functie, { token: B.eigenaar.token, body: { action: actie, organizationId: B.orgId, ...velden } }), 'weigering', [403, 404]);
      }]]),
    ]));
  }

  await stap('PostgREST: B (eigenaar, lid, boekhouder) leest niets van A', () => allemaal([
    ...[...FINANCIEN_TABELLEN, 'company_settings', 'clients', 'client_contacts', 'projects', 'audit_logs'].flatMap((tabel) => aanvallers.map(([wie, g]) => [
      `${wie} leest ${tabel}`, async () => leeg(await rest(`${tabel}?organization_id=eq.${A.orgId}&select=*`, { token: g.token }), tabel),
    ])),
    ...[['quotes', d.qGeaccepteerd.id], ['invoices', d.fBetaald.id], ['contracts', d.cGetekend.id], ['credit_notes', d.fGecrediteerd.creditnotaId]]
      .map(([tabel, id]) => [`eigenaar leest ${tabel} op id`, async () => leeg(await rest(`${tabel}?id=eq.${id}&select=*`, { token: B.eigenaar.token }), tabel)]),
  ]));

  await stap('PostgREST: B wijzigt en verwijdert niets bij A', () => {
    const doelen = [
      ['quotes', `id=eq.${d.qConcept.id}`, { notes: 'gehackt' }],
      ['quotes', `id=eq.${d.qVerstuurd.id}`, { notes: 'gehackt' }],
      ['invoices', `id=eq.${d.fConcept.id}`, { notes: 'gehackt' }],
      ['invoices', `id=eq.${d.fOpen.id}`, { notes: 'gehackt' }],
      ['contracts', `id=eq.${d.cConcept.id}`, { title: 'gehackt' }],
      ['contracts', `id=eq.${d.cGetekend.id}`, { public_token_hash: null }],
      ['credit_notes', `id=eq.${d.fGecrediteerd.creditnotaId}`, { reason: 'gehackt' }],
      ['contract_signers', `id=eq.${d.cGetekend.ondertekenaarId}`, { email: BUIT }],
      ['invoice_payment_records', `id=eq.${d.fBetaald.betaalrijId}`, { amount_cents: 1 }],
      ['company_settings', `organization_id=eq.${A.orgId}`, { iban: 'NL02RABO0123456789' }],
      ['organization_invoice_mollie_settings', `organization_id=eq.${A.orgId}`, { status: 'revoked' }],
      // Met het adres van klant A in B's eigen portaal: dan ziet B's portaalgebruiker A's stukken.
      ['clients', `id=eq.${A.klantA.id}`, { email: B.portaalA.email }],
      ['journal_entries', `organization_id=eq.${A.orgId}`, { description: 'gehackt' }],
    ];
    return allemaal([
      ...doelen.map(([tabel, filter, body]) => [`wijzig ${tabel}`, async () => geenWijziging(
        await rest(`${tabel}?${filter}&select=*`, { method: 'PATCH', token: B.eigenaar.token, prefer: 'return=representation', body }), tabel)]),
      ...doelen.map(([tabel, filter]) => [`verwijder ${tabel}`, async () => geenWijziging(
        await rest(`${tabel}?${filter}&select=*`, { method: 'DELETE', token: B.eigenaar.token, prefer: 'return=representation' }), tabel)]),
    ]);
  });

  await stap('PostgREST: B maakt niets aan in A (ook geen portaalcontact bij een klant van A)', () => allemaal([
    ['offerte in A', async () => geweigerd(await rest('quotes', { method: 'POST', token: B.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: A.orgId, client_id: A.klantA.id, number: uniek('AANVAL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'offerte')],
    ['factuur in A', async () => geweigerd(await rest('invoices', { method: 'POST', token: B.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: A.orgId, client_id: A.klantA.id, number: uniek('AANVAL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'factuur')],
    ['contract in A', async () => geweigerd(await rest('contracts', { method: 'POST', token: B.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: A.orgId, client_id: A.klantA.id, title: 'Aanval', body: '<p>x</p>' } }), 'contract')],
    ['portaalcontact bij klant A', async () => geweigerd(await rest('client_contacts', { method: 'POST', token: B.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: A.orgId, client_id: A.klantA.id, name: 'Aanvaller', email: B.portaalA.email, gives_portal_access: true, is_active: true } }), 'contact')],
    ['bedrijfsgegevens van A', async () => geweigerd(await rest('company_settings', { method: 'POST', token: B.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: A.orgId, company_name: 'Overgenomen B.V.', created_by: B.eigenaar.id } }), 'bedrijf')],
    ['Mollie-instelling van A', async () => geweigerd(await rest('organization_invoice_mollie_settings', { method: 'POST', token: B.eigenaar.token, body: {
      organization_id: A.orgId, status: 'connected' } }), 'mollie')],
  ]));

  await stap('PostgREST: B koppelt eigen documenten niet aan een klant of project van A', () => allemaal([
    ['offerte in B voor klant A', async () => geweigerd(await rest('quotes', { method: 'POST', token: B.medewerker.token, prefer: 'return=representation', body: {
      organization_id: B.orgId, client_id: A.klantA.id, number: uniek('AANVAL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'offerte')],
    ['factuur in B voor klant A', async () => geweigerd(await rest('invoices', { method: 'POST', token: B.medewerker.token, prefer: 'return=representation', body: {
      organization_id: B.orgId, client_id: A.klantA.id, number: uniek('AANVAL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'factuur')],
    ['contract in B voor klant A', async () => geweigerd(await rest('contracts', { method: 'POST', token: B.medewerker.token, prefer: 'return=representation', body: {
      organization_id: B.orgId, client_id: A.klantA.id, title: 'Aanval', body: '<p>x</p>' } }), 'contract')],
    ['offerte in B op project van A', async () => geweigerd(await rest('quotes', { method: 'POST', token: B.medewerker.token, prefer: 'return=representation', body: {
      organization_id: B.orgId, client_id: B.klantA.id, project_id: d.project.id, number: uniek('AANVAL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'offerte')],
    ['contactpersoon in B bij klant A', async () => geweigerd(await rest('client_contacts', { method: 'POST', token: B.medewerker.token, prefer: 'return=representation', body: {
      organization_id: B.orgId, client_id: A.klantA.id, name: 'Aanvaller', email: B.portaalA.email, gives_portal_access: true, is_active: true } }), 'contact')],
  ]));

  // De RPC's die een gebruiker zelf aanroept, met de organisatie van A (geen
  // lid) en met de eigen organisatie plus een document van A.
  const rpcs = [
    ['withdraw_quote', { p_quote_id: d.qVerstuurd.id, p_reason: 'aanval' }],
    ['submit_quote_for_internal_approval', { p_quote_id: d.qConcept.id }],
    ['approve_quote_internal', { p_quote_id: d.qTerGoedkeuring.id }],
    ['reject_quote_internal', { p_quote_id: d.qTerGoedkeuring.id, p_note: 'aanval' }],
    ['convert_accepted_quote_to_invoice', { p_quote_id: d.qGeaccepteerd.id }],
    ['reopen_contract', { p_contract_id: d.cVerstuurd.id }],
    ['void_contract', { p_contract_id: d.cVerstuurd.id, p_reason: 'aanval' }],
    ['post_sales_invoice_to_ledger', { p_invoice_id: d.fConcept.id, p_created_by: B.eigenaar.id }],
    ['post_credit_note_to_ledger', { p_credit_note_id: d.fGecrediteerd.creditnotaId, p_created_by: B.eigenaar.id }],
    ['book_all_unbooked_sales_invoices', { p_created_by: B.eigenaar.id }, true],
    ['preview_next_invoice_number', { p_invoice_date: VANDAAG }, true],
    ['report_open_items', { p_as_of: VANDAAG }, true],
  ];
  for (const [naam, args, zonderId] of rpcs) {
    await stap(`RPC ${naam}: B met de organisatie van A → geweigerd${zonderId ? '' : '; met de eigen organisatie → niet gevonden'}`, () => allemaal([
      ['organisatie A', async () => geenRecht(await rpc(naam, { ...args, p_organization_id: A.orgId }, B.eigenaar.token), naam)],
      ...(zonderId ? [] : [['eigen organisatie', async () => rpcGeweigerd(await rpc(naam, { ...args, p_organization_id: B.orgId }, B.eigenaar.token), naam)]]),
    ]));
  }
  await stap('RPC finance_client_directory en invoice_open_receivable_checked geven B niets van A', () => allemaal([
    ['finance_client_directory', async () => leeg(await rpc('finance_client_directory', { p_organization_id: A.orgId }, B.eigenaar.token), 'klantenlijst')],
    ['invoice_open_receivable_checked', async () => {
      const res = await rpc('invoice_open_receivable_checked', { p_invoice_id: d.fOpen.id }, B.eigenaar.token);
      verwacht(res.status >= 400 && res.status < 500 ? true : res.status === 200 && res.json === null, `openstaand bedrag van A: ${kort(res)}`);
    }],
  ]));
}

// ── 2. Rollen binnen A met te weinig rechten ────────────────────────────────

async function rollenBinnenA(A, d) {
  groep('Beveiliging: rollen binnen A met te weinig rechten');
  const zwak = [['kijker', A.kijker], ['boekhouder', A.boekhouder], ['lezer (Financiën lezen)', A.lezer], ['zonder Financiën', A.zonderFinancien]];
  const leesActies = new Set(['downloadQuotePdf', 'downloadInvoicePdf', 'downloadCreditNotePdf', 'downloadInvoiceUbl', 'downloadCreditNoteUbl',
    'syncMollieSalesInvoice', 'downloadMollieInvoicePdf', 'getInvoiceMollieStatus', 'downloadContractPdf', 'previewContractPdf']);
  // Alleen een eigenaar of beheerder: terugbetalen en de Mollie-koppeling.
  const alleenBeheer = new Set(['createInvoiceRefund', 'saveInvoiceMollieKey', 'deleteInvoiceMollieKey']);

  for (const [functie, actie, velden] of workflowActies(d)) {
    if (leesActies.has(actie)) continue;
    const body = { action: actie, organizationId: A.orgId, ...velden, ...(actie === 'saveInvoiceMollieKey' ? { apiKey: 'test_vanbinnenuit1234567890' } : {}) };
    const wie = alleenBeheer.has(actie) ? [...zwak, ['lid (volledig schrijfrecht)', A.medewerker]] : zwak;
    await stap(`${functie} ${actie}: ${wie.map(([naam]) => naam).join(', ')} → 403`, () => allemaal(
      wie.map(([naam, g]) => [naam, async () => geweigerd(await fn(functie, { token: g.token, body }), 'weigering', [403])]),
    ));
  }

  const rpcs = [
    ['submit_quote_for_internal_approval', { p_quote_id: d.qConcept.id }],
    ['approve_quote_internal', { p_quote_id: d.qTerGoedkeuring.id }, true],
    ['reject_quote_internal', { p_quote_id: d.qTerGoedkeuring.id, p_note: 'nee' }, true],
    ['withdraw_quote', { p_quote_id: d.qVerstuurd.id, p_reason: 'weg' }],
    ['convert_accepted_quote_to_invoice', { p_quote_id: d.qGeaccepteerd.id }],
    ['reopen_contract', { p_contract_id: d.cVerstuurd.id }],
    ['void_contract', { p_contract_id: d.cVerstuurd.id, p_reason: 'weg' }],
    ['book_all_unbooked_sales_invoices', { p_created_by: A.kijker.id }],
  ];
  for (const [naam, args, alleenBeheerder] of rpcs) {
    const wie = alleenBeheerder ? [...zwak, ['lid (volledig schrijfrecht)', A.medewerker]] : zwak;
    await stap(`RPC ${naam}: ${wie.map(([n]) => n).join(', ')} → geweigerd`, () => allemaal(
      wie.map(([n, g]) => [n, async () => geenRecht(await rpc(naam, { ...args, p_organization_id: A.orgId }, g.token), naam)]),
    ));
  }

  await stap('PostgREST: rollen zonder schrijfrecht wijzigen, maken en verwijderen geen offerte, factuur of contract', () => allemaal(zwak.flatMap(([n, g]) => [
    [`${n} wijzigt offerte`, async () => geenWijziging(await rest(`quotes?id=eq.${d.qConcept.id}&select=id`, { method: 'PATCH', token: g.token, prefer: 'return=representation', body: { notes: 'x' } }), 'offerte')],
    [`${n} wijzigt factuur`, async () => geenWijziging(await rest(`invoices?id=eq.${d.fConcept.id}&select=id`, { method: 'PATCH', token: g.token, prefer: 'return=representation', body: { notes: 'x' } }), 'factuur')],
    [`${n} wijzigt contract`, async () => geenWijziging(await rest(`contracts?id=eq.${d.cConcept.id}&select=id`, { method: 'PATCH', token: g.token, prefer: 'return=representation', body: { title: 'x' } }), 'contract')],
    [`${n} verwijdert offerte`, async () => geenWijziging(await rest(`quotes?id=eq.${d.qConcept.id}&select=id`, { method: 'DELETE', token: g.token, prefer: 'return=representation' }), 'offerte')],
    [`${n} verwijdert factuur`, async () => geenWijziging(await rest(`invoices?id=eq.${d.fConcept.id}&select=id`, { method: 'DELETE', token: g.token, prefer: 'return=representation' }), 'factuur')],
    [`${n} verwijdert contract`, async () => geenWijziging(await rest(`contracts?id=eq.${d.cConcept.id}&select=id`, { method: 'DELETE', token: g.token, prefer: 'return=representation' }), 'contract')],
    [`${n} maakt offerte`, async () => geweigerd(await rest('quotes', { method: 'POST', token: g.token, body: { organization_id: A.orgId, client_id: A.klantA.id, number: uniek('ROL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'offerte')],
    [`${n} maakt factuur`, async () => geweigerd(await rest('invoices', { method: 'POST', token: g.token, body: { organization_id: A.orgId, client_id: A.klantA.id, number: uniek('ROL'), date: VANDAAG, lines: REGELS, status: 'draft' } }), 'factuur')],
    [`${n} maakt contract`, async () => geweigerd(await rest('contracts', { method: 'POST', token: g.token, body: { organization_id: A.orgId, client_id: A.klantA.id, title: 'Rol', body: '<p>x</p>' } }), 'contract')],
  ])));

  await stap('zonder Financiën: PostgREST geeft 0 rijen uit elke tabel van Financiën, ook niet uit de audit-log', () => allemaal([
    ...FINANCIEN_TABELLEN.map((tabel) => [tabel, async () => leeg(await rest(`${tabel}?organization_id=eq.${A.orgId}&select=*`, { token: A.zonderFinancien.token }), tabel)]),
    // De audit-log noemt factuurnummers, bedragen en ontvangers; de regels over
    // offertes, facturen en contracten horen bij de module Financiën.
    ['audit_logs (Financiën)', async () => leeg(await rest(`audit_logs?organization_id=eq.${A.orgId}&entity_type=in.(quote,invoice,contract,credit_note,journal_entry)&select=*`,
      { token: A.zonderFinancien.token }), 'audit-log')],
  ]));

  await stap('zonder Financiën: geen download, voorbeeld of Mollie-stand via de functies (403)', () => allemaal(
    workflowActies(d).filter(([, actie]) => leesActies.has(actie)).map(([functie, actie, velden]) => [actie, async () => geweigerd(
      await fn(functie, { token: A.zonderFinancien.token, body: { action: actie, organizationId: A.orgId, ...velden } }), 'weigering', [403])]),
  ));

  await stap('zonder Financiën: geen openstaande posten, factuurnummer of openstaand bedrag via RPC', () => allemaal([
    ['report_open_items', async () => geenRecht(await rpc('report_open_items', { p_organization_id: A.orgId, p_as_of: VANDAAG }, A.zonderFinancien.token), 'openstaande posten')],
    ['preview_next_invoice_number', async () => geenRecht(await rpc('preview_next_invoice_number', { p_organization_id: A.orgId, p_invoice_date: VANDAAG }, A.zonderFinancien.token), 'nummer')],
    ['finance_client_directory', async () => leeg(await rpc('finance_client_directory', { p_organization_id: A.orgId }, A.zonderFinancien.token), 'klantenlijst')],
    ['invoice_open_receivable_checked', async () => {
      const res = await rpc('invoice_open_receivable_checked', { p_invoice_id: d.fOpen.id }, A.zonderFinancien.token);
      verwacht(res.status >= 400 && res.status < 500 ? true : res.status === 200 && res.json === null, `openstaand bedrag: ${kort(res)}`);
    }],
  ]));

  // Tegenproef: lezen mag wél voor wie Financiën mag lezen. Zonder deze stap
  // kan een 403 hierboven ook een kapotte opzet zijn.
  await stap('tegenproef: boekhouder, kijker en lezer mogen PDF\'s van A downloaden', () => allemaal([
    ['boekhouder factuur-PDF', async () => gelukt(await fn('invoice-workflow', { token: A.boekhouder.token, body: { action: 'downloadInvoicePdf', organizationId: A.orgId, invoiceId: d.fBetaald.id } }), 'download')],
    ['kijker offerte-PDF', async () => gelukt(await fn('quote-workflow', { token: A.kijker.token, body: { action: 'downloadQuotePdf', organizationId: A.orgId, quoteId: d.qGeaccepteerd.id } }), 'download')],
    ['lezer contract-PDF', async () => gelukt(await fn('contract-workflow', { token: A.lezer.token, body: { action: 'downloadContractPdf', organizationId: A.orgId, contractId: d.cGetekend.id } }), 'download')],
  ]));

  await stap('de Mollie-sleutel van A is voor niemand via PostgREST of de statusactie te lezen', () => allemaal([
    ...[['eigenaar', A.eigenaar], ...zwak].map(([n, g]) => [`${n} leest de instelling`, async () =>
      leeg(await rest(`organization_invoice_mollie_settings?organization_id=eq.${A.orgId}&select=*`, { token: g.token }), 'Mollie-instelling')]),
    ['kijker vraagt de status', async () => {
      const res = gelukt(await fn('invoice-workflow', { token: A.kijker.token, body: { action: 'getInvoiceMollieStatus', organizationId: A.orgId } }), 'status');
      verwacht(!JSON.stringify(res).includes(d.mollieSleutelA.slice(5, 20)), 'de sleutel staat in het antwoord');
      verwacht(!/api_key|encrypted/i.test(JSON.stringify(res)), 'versleutelde sleutel in het antwoord');
    }],
  ]));

  // Wie de organisatie verlaat, wordt uitgeschakeld (Instellingen → Team, zie
  // disableOrganizationMember). Zijn sessietoken blijft geldig tot het
  // verloopt; de rechten moeten meteen weg zijn, ook in de edge functions.
  const oudLid = await stap('eigenaar schakelt een lid uit (zoals Instellingen → Team)', async () => {
    const gebruiker = await maakGebruiker('bev-a-oudlid');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status)
         values (${q(A.orgId)}, ${q(gebruiker.id)}, ${q(gebruiker.email)}, 'member', 'active')`);
    // Tegenproef: zolang hij actief is, mag hij de factuur-PDF downloaden.
    gelukt(await fn('invoice-workflow', { token: gebruiker.token, body: { action: 'downloadInvoicePdf', organizationId: A.orgId, invoiceId: d.fBetaald.id } }), 'download als actief lid');
    const lid = sqlRij(`select id from public.organization_members where organization_id = ${q(A.orgId)} and user_id = ${q(gebruiker.id)}`);
    const res = await rest(`organization_members?id=eq.${lid.id}&organization_id=eq.${A.orgId}&select=id,status`, {
      method: 'PATCH', token: A.eigenaar.token, prefer: 'return=representation', body: { status: 'disabled' },
    });
    gelijk(gelukt(res, 'uitschakelen')[0]?.status, 'disabled', 'status na uitschakelen');
    return gebruiker;
  });
  if (oudLid) {
    await stap('een uitgeschakeld lid (sessie nog geldig) leest en doet niets meer in A', () => allemaal([
      ['factuur-PDF', async () => geweigerd(await fn('invoice-workflow', { token: oudLid.token, body: { action: 'downloadInvoicePdf', organizationId: A.orgId, invoiceId: d.fBetaald.id } }), 'weigering', [403])],
      ['offerte-PDF', async () => geweigerd(await fn('quote-workflow', { token: oudLid.token, body: { action: 'downloadQuotePdf', organizationId: A.orgId, quoteId: d.qGeaccepteerd.id } }), 'weigering', [403])],
      ['contract-PDF', async () => geweigerd(await fn('contract-workflow', { token: oudLid.token, body: { action: 'downloadContractPdf', organizationId: A.orgId, contractId: d.cGetekend.id } }), 'weigering', [403])],
      ['herinnering versturen', async () => geweigerd(await fn('invoice-workflow', { token: oudLid.token, body: { action: 'sendInvoiceReminderEmail', organizationId: A.orgId, invoiceId: d.fOpen.id, recipientEmail: BUIT } }), 'weigering', [403])],
      ['PostgREST facturen', async () => leeg(await rest(`invoices?organization_id=eq.${A.orgId}&select=*`, { token: oudLid.token }), 'facturen')],
      ['PostgREST contracten', async () => leeg(await rest(`contracts?organization_id=eq.${A.orgId}&select=*`, { token: oudLid.token }), 'contracten')],
      ['RPC withdraw_quote', async () => geenRecht(await rpc('withdraw_quote', { p_quote_id: d.qVerstuurd.id, p_organization_id: A.orgId, p_reason: 'weg' }, oudLid.token), 'intrekken')],
    ]));
  }

}

// ── 3. Velden die alleen de server zet (eigenaar van A via PostgREST) ────────

/**
 * Probeert per veld een PATCH als eigenaar; elk veld moet geweigerd worden en
 * de waarde in de database blijft gelijk. `afgeleid`: velden die de database
 * zelf herberekent (totalen) mogen ook "geslaagd" zijn, als de waarde maar niet
 * verandert.
 */
function veldenVast(tabel, id, velden, token, { afgeleid = [] } = {}) {
  return allemaal(Object.entries(velden).map(([veld, waarde]) => [veld, async () => {
    const lees = () => sqlRij(`select to_jsonb(t) -> ${q(veld)} as w from public.${tabel} t where id = ${q(id)}`)?.w ?? null;
    const voor = lees();
    const res = await rest(`${tabel}?id=eq.${id}&select=id`, { method: 'PATCH', token, prefer: 'return=representation', body: { [veld]: waarde } });
    if (!afgeleid.includes(veld) || res.status >= 300) geweigerd(res, 'wijziging');
    gelijk(lees(), voor, 'waarde in de database');
  }]));
}

async function serverVelden(A, d) {
  groep('Beveiliging: velden die alleen de server zet (eigenaar van A, via PostgREST)');
  const eig = A.eigenaar.token;
  const toekomst = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const nepHash = sha256('zelfgemaakte-token-van-de-eigenaar-1234567890');

  await stap('geaccepteerde offerte: status, link, verzending, akkoord en goedkeuring liggen vast', () => veldenVast('quotes', d.qGeaccepteerd.id, {
    status: 'sent', public_token_hash: nepHash, public_token_expires_at: toekomst, sent_at: '2026-01-01T00:00:00Z', accepted_at: null,
    client_decision_at: null, client_decision_by_name: 'Iemand anders', client_decision_by_email: BUIT, client_decision_note: 'Toch niet',
    internal_approval_status: 'draft', internal_approved_by: A.medewerker.id, accepted_sent_version_id: null, client_decision_by_contact_id: randomUUID(),
    accepted_version_id: null, sent_version_id: null, lines: [], valid_until: '2027-12-31',
  }, eig));
  await stap('verstuurde offerte: zelf op geaccepteerd zetten of de regels wijzigen kan niet', () => veldenVast('quotes', d.qVerstuurd.id, {
    status: 'accepted', accepted_at: '2026-11-06T12:00:00Z', lines: [{ description: 'Gratis', quantity: 1, unit_price: 0, vat: 21 }], client_id: A.klantB.id,
  }, eig));
  await stap('concept-offerte: zelf een publieke link (token-hash) of verzending zetten kan niet', () => veldenVast('quotes', d.qConcept.id, {
    public_token_hash: nepHash, public_token_expires_at: toekomst, status: 'sent', sent_at: '2026-11-06T12:00:00Z', internal_approval_status: 'approved',
  }, eig));
  await stap('een offerte met workflowvelden aanmaken kan niet', () => allemaal(Object.entries({
    status: 'accepted', public_token_hash: nepHash, sent_at: '2026-11-06T12:00:00Z', client_decision_by_name: 'Klant', accepted_sent_version_id: randomUUID(),
  }).map(([veld, waarde]) => [veld, async () => geweigerd(await rest('quotes', { method: 'POST', token: eig, body: {
    organization_id: A.orgId, client_id: A.klantA.id, number: uniek('VELD'), date: VANDAAG, lines: REGELS, [veld]: waarde } }), 'aanmaken')])));

  await stap('betaalde, geboekte factuur: regels, totalen, link, boeking, vergrendeling en terugbetaling liggen vast', () => veldenVast('invoices', d.fBetaald.id, {
    lines: [{ description: 'Korting', quantity: 1, unit_price: 1, vat: 21 }], total_amount: 1, subtotal_amount: 1, vat_amount: 0,
    public_token_hash: nepHash, public_token_expires_at: toekomst, journal_entry_id: null, locked_at: null, locked_reason: 'niets',
    refunded_amount: 173.63, refunded_at: '2026-11-06T12:00:00Z', reminder_level: 3, status: 'refunded', number: 'ANDER-NUMMER',
    date: '2026-01-01', client_id: A.klantB.id,
  }, eig, { afgeleid: ['total_amount', 'subtotal_amount', 'vat_amount'] }));
  await stap('verstuurde, geboekte factuur: terug naar concept, annuleren zonder creditnota of de regels wijzigen kan niet', () => veldenVast('invoices', d.fOpen.id, {
    status: 'draft', lines: [], due_date: '2027-01-01', public_token_hash: nepHash, journal_entry_id: null,
  }, eig));
  await stap('verstuurde, geboekte factuur: annuleren zonder creditnota kan niet', () => veldenVast('invoices', d.fOpen.id, { status: 'cancelled' }, eig));
  await stap('gecrediteerde factuur: weer openzetten kan niet', () => veldenVast('invoices', d.fGecrediteerd.id, { status: 'sent' }, eig));
  await stap('een factuur met server-velden aanmaken kan niet', () => allemaal(Object.entries({
    public_token_hash: nepHash, journal_entry_id: randomUUID(), locked_at: '2026-11-06T12:00:00Z', refunded_amount: 10, status: 'refunded', reminder_level: 2,
  }).map(([veld, waarde]) => [veld, async () => geweigerd(await rest('invoices', { method: 'POST', token: eig, body: {
    organization_id: A.orgId, client_id: A.klantA.id, number: uniek('VELD'), date: VANDAAG, lines: REGELS, [veld]: waarde } }), 'aanmaken')])));

  await stap('getekend contract: status, ondertekenbewijs, inhoud, klant en verzending liggen vast', () => veldenVast('contracts', d.cGetekend.id, {
    status: 'draft', signed_at: null, signed_document_sha256: 'vervalst', signed_pdf_data_base64: 'JVBERi0xLjQ=', signed_storage_key: null,
    signed_storage_provider: 'database', title: 'Andere titel', body: '<p>Andere afspraak</p>', amount_cents: 1, client_id: A.klantB.id,
    sent_at: null, internal_approval_status: 'approved', voided_at: '2026-11-06T12:00:00Z', public_token_hash: nepHash, number: 'ANDER-NUMMER',
  }, eig));
  await stap('verstuurd contract: zelf op getekend of ingetrokken zetten of de inhoud wijzigen kan niet', () => veldenVast('contracts', d.cVerstuurd.id, {
    status: 'signed', signed_at: '2026-11-06T12:00:00Z', body: '<p>Andere afspraak</p>', voided_at: '2026-11-06T12:00:00Z',
  }, eig));
  await stap('concept-contract: zelf een ondertekenlink of verzending zetten kan niet', () => veldenVast('contracts', d.cConcept.id, {
    public_token_hash: nepHash, public_token_expires_at: toekomst, status: 'sent', sent_at: '2026-11-06T12:00:00Z',
  }, eig));
  await stap('een contract met server-velden aanmaken kan niet', () => allemaal(Object.entries({
    status: 'signed', public_token_hash: nepHash, signed_at: '2026-11-06T12:00:00Z', sent_at: '2026-11-06T12:00:00Z', voided_at: '2026-11-06T12:00:00Z',
  }).map(([veld, waarde]) => [veld, async () => geweigerd(await rest('contracts', { method: 'POST', token: eig, body: {
    organization_id: A.orgId, client_id: A.klantA.id, title: 'Veld', body: '<p>x</p>', [veld]: waarde } }), 'aanmaken')])));

  await stap('ondertekenbewijs, creditnota, betaling, versies en journaal zijn voor de eigenaar niet te wijzigen of te verwijderen', () => {
    const doelen = [
      ['contract_signers', d.cGetekend.ondertekenaarId, { signature_image: 'data:image/png;base64,AAAA', signed_ip: '10.0.0.1', email: BUIT, consent_text: 'Niets', status: 'pending' }],
      ['credit_notes', d.fGecrediteerd.creditnotaId, { total_amount: 0, status: 'void', lines: [] }],
      ['invoice_payment_records', d.fBetaald.betaalrijId, { status: 'refunded', amount_cents: 1, provider_payment_id: 'tr_ander' }],
    ];
    const versies = [
      ['quote_versions', `quote_id=eq.${d.qGeaccepteerd.id}`],
      ['invoice_versions', `invoice_id=eq.${d.fBetaald.id}`],
      ['contract_versions', `contract_id=eq.${d.cGetekend.id}`],
      ['journal_entries', `organization_id=eq.${A.orgId}`],
      ['journal_lines', `organization_id=eq.${A.orgId}`],
      ['invoice_public_links', `invoice_id=eq.${d.fOpen.id}`],
    ];
    return allemaal([
      ...doelen.flatMap(([tabel, id, velden]) => Object.entries(velden).map(([veld, waarde]) => [`${tabel}.${veld}`, async () => geenWijziging(
        await rest(`${tabel}?id=eq.${id}&select=id`, { method: 'PATCH', token: eig, prefer: 'return=representation', body: { [veld]: waarde } }), veld)])),
      ...doelen.map(([tabel, id]) => [`verwijder ${tabel}`, async () => geenWijziging(
        await rest(`${tabel}?id=eq.${id}&select=id`, { method: 'DELETE', token: eig, prefer: 'return=representation' }), tabel)]),
      ...versies.map(([tabel, filter]) => [`wijzig ${tabel}`, async () => geenWijziging(
        await rest(`${tabel}?${filter}&select=id`, { method: 'PATCH', token: eig, prefer: 'return=representation', body: { created_at: '2020-01-01T00:00:00Z' } }), tabel)]),
      ...versies.map(([tabel, filter]) => [`verwijder ${tabel}`, async () => geenWijziging(
        await rest(`${tabel}?${filter}&select=id`, { method: 'DELETE', token: eig, prefer: 'return=representation' }), tabel)]),
    ]);
  });

  await stap('zelf een ondertekenaar, publieke factuurlink, betaling, creditnota of terugbetaling invoegen kan niet', () => allemaal([
    ['contract_signers', async () => geweigerd(await rest('contract_signers', { method: 'POST', token: eig, body: {
      organization_id: A.orgId, contract_id: d.cVerstuurd.id, name: 'Nep', email: BUIT, role: 'client', status: 'signed', signed_at: '2026-11-06T12:00:00Z' } }), 'ondertekenaar')],
    ['invoice_public_links', async () => geweigerd(await rest('invoice_public_links', { method: 'POST', token: eig, body: {
      organization_id: A.orgId, invoice_id: d.fOpen.id, token_hash: nepHash, purpose: 'invoice_view', status: 'active', expires_at: toekomst } }), 'link')],
    ['invoice_payment_records', async () => geweigerd(await rest('invoice_payment_records', { method: 'POST', token: eig, body: {
      organization_id: A.orgId, invoice_id: d.fOpen.id, provider: 'mollie', provider_payment_id: 'tr_nep', status: 'paid', amount_cents: 17363, currency: 'EUR' } }), 'betaling')],
    ['credit_notes', async () => geweigerd(await rest('credit_notes', { method: 'POST', token: eig, body: {
      organization_id: A.orgId, invoice_id: d.fOpen.id, number: uniek('CN'), date: VANDAAG, total_amount: 1, subtotal_amount: 1, vat_amount: 0, lines: [] } }), 'creditnota')],
    ['invoice_refunds', async () => geweigerd(await rest('invoice_refunds', { method: 'POST', token: eig, body: {
      organization_id: A.orgId, invoice_id: d.fBetaald.id, kind: 'manual', status: 'refunded', amount_cents: 100, currency: 'EUR' } }), 'terugbetaling')],
    ['journal_entries', async () => geweigerd(await rest('journal_entries', { method: 'POST', token: eig, body: {
      organization_id: A.orgId, date: VANDAAG, description: 'Nep', status: 'posted' } }), 'journaalpost')],
  ]));

  // Offertes en facturen weigert een trigger (de eigenaar mag ze via RLS wel
  // verwijderen, dus de trigger moet het tegenhouden). Bij contracten laat de
  // RLS alleen een concept toe: dan raakt het verzoek 0 rijen. Beide zijn een
  // weigering; waar het om gaat is dat de rij blijft bestaan.
  await stap('verstuurde of beslist documenten verwijderen kan niet (bewaarplicht)', () => allemaal([
    ['verstuurde offerte', d.qVerstuurd.id, 'quotes'], ['geaccepteerde offerte', d.qGeaccepteerd.id, 'quotes'],
    ['betaalde factuur', d.fBetaald.id, 'invoices'], ['open factuur', d.fOpen.id, 'invoices'], ['gecrediteerde factuur', d.fGecrediteerd.id, 'invoices'],
    ['getekend contract', d.cGetekend.id, 'contracts'], ['verstuurd contract', d.cVerstuurd.id, 'contracts'],
  ].map(([naam, id, tabel]) => [naam, async () => {
    const res = await rest(`${tabel}?id=eq.${id}&select=id`, { method: 'DELETE', token: eig, prefer: 'return=representation' });
    if (tabel !== 'contracts') geweigerd(res, 'verwijderen');
    else geenWijziging(res, 'verwijderen');
    verwacht(sqlRij(`select id from public.${tabel} where id = ${q(id)}`), 'de rij is weg');
  }])));
}

// ── 4. RPC's die alleen de server mag aanroepen ─────────────────────────────

const SERVER_RPCS = [
  'accept_quote_public', 'reject_quote_public', 'decide_quote_portal', 'begin_quote_email_send', 'complete_quote_email_send', 'fail_quote_email_send',
  'create_quote_version_snapshot', 'insert_quote_workflow_event', 'insert_quote_audit_event',
  'sign_contract_public', 'decline_contract_public', 'ask_contract_question_public', 'attach_signed_contract_pdf', 'begin_contract_signature_send',
  'complete_contract_signature_send', 'fail_contract_signature_send', 'snapshot_contract_version', 'insert_contract_event', 'allocate_next_contract_number',
  'begin_invoice_email_send', 'complete_invoice_email_send', 'fail_invoice_email_send', 'begin_invoice_payment_checkout', 'complete_invoice_payment_checkout',
  'fail_invoice_payment_checkout', 'update_invoice_payment_status', 'book_invoice_payment', 'begin_invoice_refund', 'complete_invoice_refund', 'fail_invoice_refund',
  'ingest_external_refund', 'record_invoice_chargeback', 'recompute_invoice_refund_state', 'recompute_invoice_chargeback_state', 'issue_credit_note',
  'create_invoice_public_link', 'resolve_invoice_public_link', 'create_invoice_version_snapshot', 'insert_invoice_workflow_event', 'invoice_open_receivable_cents',
  'ensure_sales_invoice_booked', 'allocate_next_invoice_number', 'allocate_next_credit_note_number', 'reconcile_invoice_number_sequence',
  'reconcile_credit_note_number_sequence', 'begin_invoice_reminder_send', 'complete_invoice_reminder_send', 'fail_invoice_reminder_send',
  'mark_invoices_overdue', 'find_due_invoice_reminders', 'begin_dunning_notice', 'begin_dunning_send', 'complete_dunning_send', 'fail_dunning_send',
  'cancel_dunning_notice', 'find_due_dunning_candidates', 'portal_clients_for_email',
];

/** Argumenten voor een RPC: de echte parameternamen uit de catalogus, gevuld met echte waarden van A waar dat kan. */
function rpcArgumenten(naam, waarden) {
  const rij = sqlRij(`select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = ${q(naam)} limit 1`);
  if (!rij) throw new Error(`functie ${naam} bestaat niet (meer)`);
  const args = {};
  for (const deel of rij.args.split(', ').filter(Boolean)) {
    const spatie = deel.indexOf(' ');
    const param = deel.slice(0, spatie);
    const type = deel.slice(spatie + 1);
    if (param in waarden) args[param] = waarden[param];
    else if (type === 'uuid') args[param] = randomUUID();
    else if (type.endsWith('[]')) args[param] = [];
    else if (/^(integer|bigint|smallint|numeric)$/.test(type)) args[param] = 1;
    else if (type === 'boolean') args[param] = false;
    else if (type === 'jsonb' || type === 'json') args[param] = {};
    else if (type === 'date') args[param] = VANDAAG;
    else if (type.startsWith('timestamp')) args[param] = '2030-01-01T00:00:00Z';
    else args[param] = 'x';
  }
  return args;
}

async function serverRpcs(A, B, d) {
  groep('Beveiliging: RPC\'s die alleen de server mag aanroepen');
  // Echte waarden van A: dan weigert de database op rechten, niet op een
  // ongeldig argument. De offerte- en contractfuncties krijgen de hash van een
  // geldige, nog open link.
  const waarden = (gebruiker) => ({
    p_organization_id: A.orgId, p_quote_id: d.qVerstuurd.id, p_invoice_id: d.fOpen.id, p_contract_id: d.cVerstuurd.id,
    p_actor_user_id: gebruiker.id, p_created_by: gebruiker.id, p_notice_id: d.fOpen.aanmaningId, p_payment_record_id: d.fBetaald.betaalrijId,
    p_provider_payment_id: d.fOpen.mollieId, p_status: 'paid', p_paid_at: '2026-11-06T12:00:00Z', p_email: A.klantA.email, p_name: 'Anna Klant',
    p_signer_name: 'Anna Klant', p_signer_email: A.klantA.email, p_signature_method: 'typed', p_consent_text: AKKOORDTEKST, p_version_id: null,
    p_kind: 'accept', p_token: d.fOpen.token, p_touch: false, p_limit: 50, p_now: new Date().toISOString(), p_amount_cents: 100,
    p_event_type: 'client_accepted', p_title: 'Klant heeft de offerte geaccepteerd', p_level: 1, p_reason: 'aanval', p_message: 'Hallo',
  });
  const hashVoor = (naam) => (/contract/.test(naam) ? sha256(d.cVerstuurd.token) : sha256(d.qVerstuurd.token));

  for (const [wie, gebruiker] of [['eigenaar van A', A.eigenaar], ['portaalklant van A', A.portaalA], ['eigenaar van B', B.eigenaar]]) {
    await stap(`${SERVER_RPCS.length} server-RPC's als ${wie} → geweigerd op rechten`, () => allemaal(SERVER_RPCS.map((naam) => [naam, async () => {
      const args = rpcArgumenten(naam, { ...waarden(gebruiker), p_token_hash: hashVoor(naam) });
      geenRecht(await rpc(naam, args, gebruiker.token), naam);
    }])));
  }
}

// ── 5. Anoniem ──────────────────────────────────────────────────────────────

async function anoniem(A, d) {
  groep('Beveiliging: anoniem (alleen de publieke sleutel)');

  await stap('PostgREST: anon leest geen tabel van het schema public', () => allemaal(
    [...FINANCIEN_TABELLEN, 'company_settings', 'clients', 'client_contacts', 'projects', 'organizations', 'organization_members'].map((tabel) => [tabel, async () => {
      const res = await rest(`${tabel}?select=*&limit=5`);
      leeg(res, tabel);
    }]),
  ));
  await stap('PostgREST: anon schrijft niets', () => allemaal([
    ['offerte wijzigen', async () => geenWijziging(await rest(`quotes?id=eq.${d.qVerstuurd.id}`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'accepted' } }), 'offerte')],
    ['factuur verwijderen', async () => geenWijziging(await rest(`invoices?id=eq.${d.fConcept.id}`, { method: 'DELETE', prefer: 'return=representation' }), 'factuur')],
    ['contract aanmaken', async () => geweigerd(await rest('contracts', { method: 'POST', body: { organization_id: A.orgId, title: 'x' } }), 'contract')],
  ]));
  await stap('RPC: anon roept geen publieke of gebruikersfunctie aan', () => allemaal([
    ...['accept_quote_public', 'reject_quote_public', 'sign_contract_public', 'decline_contract_public', 'resolve_invoice_public_link',
      'portal_clients_for_email', 'update_invoice_payment_status', 'decide_quote_portal'].map((naam) => [naam, async () => {
      const args = rpcArgumenten(naam, { p_token_hash: sha256(d.qVerstuurd.token), p_token: d.fOpen.token, p_email: A.klantA.email, p_quote_id: d.qVerstuurd.id, p_organization_id: A.orgId });
      geenRecht(await rpc(naam, args), naam);
    }]),
    ...[['withdraw_quote', { p_quote_id: d.qVerstuurd.id, p_organization_id: A.orgId, p_reason: null }],
      ['convert_accepted_quote_to_invoice', { p_quote_id: d.qGeaccepteerd.id, p_organization_id: A.orgId }],
      ['void_contract', { p_contract_id: d.cVerstuurd.id, p_organization_id: A.orgId, p_reason: null }],
      ['invoice_open_receivable_checked', { p_invoice_id: d.fOpen.id }]].map(([naam, args]) => [naam, async () => geenRecht(await rpc(naam, args), naam)]),
  ]));

  const ingelogd = [
    ['quote-workflow', { action: 'downloadQuotePdf', organizationId: A.orgId, quoteId: d.qGeaccepteerd.id }],
    ['quote-workflow', { action: 'sendQuoteEmail', organizationId: A.orgId, quoteId: d.qGoedgekeurd.id }],
    ['invoice-workflow', { action: 'downloadInvoicePdf', organizationId: A.orgId, invoiceId: d.fBetaald.id }],
    ['invoice-workflow', { action: 'createInvoiceRefund', organizationId: A.orgId, invoiceId: d.fBetaald.id, amountCents: 100 }],
    ['invoice-workflow', { action: 'getInvoiceMollieStatus', organizationId: A.orgId }],
    ['contract-workflow', { action: 'downloadContractPdf', organizationId: A.orgId, contractId: d.cGetekend.id }],
    ['client-portal', { action: 'getPortalData' }],
  ];
  // Een vervalste sessie: een JWT met een verkeerde handtekening, en de
  // publieke anon-sleutel (een JWT zonder gebruiker) als sessietoken.
  const nepJwt = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A.eigenaar.id, role: 'authenticated', exp: 4102444800 })).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
  await stap('workflow-functies en portaal: zonder sessie, met een vervalste sessie of met de anon-sleutel → 401', () => allemaal(
    ingelogd.flatMap(([functie, body]) => [[undefined, 'zonder sessie'], [nepJwt, 'vervalste JWT'], [ANON_KEY, 'anon-sleutel']].map(([token, wat]) => [
      `${functie} ${body.action} ${wat}`, async () => geweigerd(await fn(functie, { token, body }), 'weigering', [401]),
    ])),
  ));

  await stap('publieke functies: zonder token of met een te korte token → 400', () => allemaal([
    ['quote-public', 'getQuote'], ['contract-public', 'getContract'], ['invoice-public', 'getInvoice'],
  ].flatMap(([functie, actie]) => [['', 'zonder'], ['kort', 'te kort']].map(([token, wat]) => [`${functie} ${wat}`, async () => {
    const res = await fn(functie, { body: { action: actie, token } });
    // invoice-public kent geen minimumlengte; een korte token bestaat gewoon niet (404).
    geweigerd(res, 'weigering', functie === 'invoice-public' && token ? [404] : [400]);
  }]))));

  await stap('publieke functies en portaal: Origin "null" of een vreemde site wordt geweigerd, ook met een geldige token', () => allemaal([
    ['quote-public', { action: 'getQuote', token: d.qGeaccepteerd.token }],
    ['contract-public', { action: 'getContract', token: d.cGetekend.token }],
    ['invoice-public', { action: 'getInvoice', token: d.fBetaald.token }],
    ['quote-workflow', { action: 'downloadQuotePdf', organizationId: A.orgId, quoteId: d.qGeaccepteerd.id }, A.eigenaar.token],
    ['invoice-workflow', { action: 'downloadInvoicePdf', organizationId: A.orgId, invoiceId: d.fBetaald.id }, A.eigenaar.token],
    ['contract-workflow', { action: 'downloadContractPdf', organizationId: A.orgId, contractId: d.cGetekend.id }, A.eigenaar.token],
    ['client-portal', { action: 'getPortalData' }, A.portaalA.token],
  ].flatMap(([functie, body, token]) => ['null', 'https://evil.example'].map((origin) => [`${functie} origin ${origin}`, async () => {
    const res = await fn(functie, { body, token, origin });
    geweigerd(res, 'weigering', [403]);
    verwacht(res.headers.get('access-control-allow-origin') !== origin, 'de vreemde origin krijgt toch een CORS-header');
  }]))));
}

// ── 6. Publieke tokens ──────────────────────────────────────────────────────

/** Velden die nooit op een publieke pagina horen. */
const INTERN = /public_token_hash|organization_id|created_by|internal_approval|internal_rejection|journal_entry_id|pdf_data_base64|signed_pdf_data_base64|api_key|provider_payment_id|signature_image|signed_ip|body_storage_key|"metadata"/;

async function publiekeTokens(A, B, d) {
  groep('Beveiliging: publieke tokens (offerte, factuur, contract)');
  const geknipt = (token) => token.slice(0, 30);
  const vreemd = randomBytes(32).toString('base64url');

  await stap('een willekeurige, geknipte, verlengde of anders gespelde token opent niets', () => allemaal([
    ['quote-public', 'getQuote', d.qGeaccepteerd.token], ['contract-public', 'getContract', d.cGetekend.token], ['invoice-public', 'getInvoice', d.fBetaald.token],
  ].flatMap(([functie, actie, echt]) => [
    ['willekeurig', vreemd], ['geknipt', geknipt(echt)], ['verlengd', `${echt}x`], ['hoofdletters', echt.toUpperCase() === echt ? echt.toLowerCase() : echt.toUpperCase()],
  ].map(([wat, token]) => [`${functie} ${wat}`, async () => geweigerd(await fn(functie, { body: { action: actie, token } }), 'weigering', [404])]))));

  await stap('een token werkt alleen bij zijn eigen soort document', () => allemaal([
    ['offertetoken bij contract-public', 'contract-public', 'getContract', d.qGeaccepteerd.token],
    ['offertetoken bij invoice-public', 'invoice-public', 'getInvoice', d.qGeaccepteerd.token],
    ['factuurtoken bij quote-public', 'quote-public', 'getQuote', d.fBetaald.token],
    ['contracttoken bij quote-public', 'quote-public', 'getQuote', d.cGetekend.token],
    ['contracttoken bij invoice-public', 'invoice-public', 'getInvoice', d.cGetekend.token],
  ].map(([naam, functie, actie, token]) => [naam, async () => geweigerd(await fn(functie, { body: { action: actie, token } }), 'weigering', [404])])));

  // De publieke functies kennen geen document-id; een meegestuurd id van B mag
  // niets uitmaken. Het antwoord gaat over het document van de token, en bevat
  // niets van B of van andere documenten van A.
  await stap('een token van A met id\'s van B erbij: alleen het document van de token, niets van B of andere stukken', () => allemaal([
    ['quote-public', { action: 'getQuote', token: d.qGeaccepteerd.token, quoteId: d.bOfferte.id, id: d.bOfferte.id, organizationId: B.orgId }, d.qGeaccepteerd.number],
    ['invoice-public', { action: 'getInvoice', token: d.fBetaald.token, invoiceId: d.bFactuur.id, id: d.bFactuur.id, organizationId: B.orgId }, d.fBetaald.number],
    ['invoice-public', { action: 'getInvoicePdf', token: d.fBetaald.token, invoiceId: d.bFactuur.id }, null],
    ['contract-public', { action: 'getContract', token: d.cGetekend.token, contractId: d.bContract.id, id: d.bContract.id, organizationId: B.orgId }, d.cGetekend.number],
  ].map(([functie, body, nummer]) => [`${functie} ${body.action}`, async () => {
    const res = gelukt(await fn(functie, { body }), 'openen');
    const tekst = JSON.stringify(res);
    if (nummer) verwacht(tekst.includes(nummer), `het eigen nummer ${nummer} staat er niet in`);
    for (const vreemdId of [d.bOfferte.id, d.bFactuur.id, d.bContract.id, B.orgId, B.orgNaam, d.qVerstuurd.number, d.fOpen.number, d.cVerstuurd.number]) {
      verwacht(!tekst.includes(vreemdId), `bevat ${vreemdId}`);
    }
    const intern = tekst.match(INTERN);
    verwacht(!intern, `intern veld op de publieke pagina: ${intern?.[0]}`);
  }])));

  await stap('een geaccepteerde offerte opnieuw accepteren of afwijzen kan niet, en verandert niets', async () => {
    const voor = sqlRij(`select status, client_decision_by_name, client_decision_by_email, client_decision_note from public.quotes where id = ${q(d.qGeaccepteerd.id)}`);
    await allemaal([
      ['opnieuw accepteren', async () => geweigerd(await fn('quote-public', { body: { action: 'acceptQuote', token: d.qGeaccepteerd.token, name: 'Iemand anders', email: BUIT } }), 'weigering', [409])],
      ['afwijzen', async () => geweigerd(await fn('quote-public', { body: { action: 'rejectQuote', token: d.qGeaccepteerd.token, name: 'Iemand anders', email: BUIT, note: 'Toch niet' } }), 'weigering', [409])],
    ]);
    gelijk(sqlRij(`select status, client_decision_by_name, client_decision_by_email, client_decision_note from public.quotes where id = ${q(d.qGeaccepteerd.id)}`), voor, 'beslissing');
  });

  await stap('een getekend contract opnieuw tekenen of weigeren kan niet, en verandert niets', async () => {
    const voor = sqlRij(`select c.status, c.signed_at, s.name, s.email, s.signed_ip from public.contracts c join public.contract_signers s on s.contract_id = c.id where c.id = ${q(d.cGetekend.id)}`);
    await allemaal([
      ['opnieuw tekenen', async () => geweigerd(await tekenen(d.cGetekend.token, 'Iemand anders', BUIT), 'weigering', [409])],
      ['weigeren', async () => geweigerd(await fn('contract-public', { body: { action: 'declineContract', token: d.cGetekend.token, name: 'Iemand anders', email: BUIT, reason: 'Toch niet' } }), 'weigering', [409])],
    ]);
    gelijk(sqlRij(`select c.status, c.signed_at, s.name, s.email, s.signed_ip from public.contracts c join public.contract_signers s on s.contract_id = c.id where c.id = ${q(d.cGetekend.id)}`), voor, 'handtekening');
  });

  await stap('een betaalde factuur blijft betaald; de mock-betaalroute zet niets op betaald', async () => {
    const res = gelukt(await fn('invoice-public', { body: { action: 'getInvoice', token: d.fBetaald.token } }), 'openen');
    gelijk(res.invoice.status, 'paid', 'status op de publieke pagina');
    const voor = sqlRij(`select status from public.invoices where id = ${q(d.fOpen.id)}`);
    const mock = await fn('invoice-public', { body: { action: 'markMockInvoicePaymentPaid', token: d.fOpen.token, mockPaymentId: `mock_invoice_payment_${randomUUID()}` } });
    verwacht(mock.status < 500, `mock-route crasht: ${kort(mock)}`);
    gelijk(sqlRij(`select status from public.invoices where id = ${q(d.fOpen.id)}`), voor, 'status open factuur');
  });

  await stap('een gecrediteerde factuur is via de link niet meer te openen of te downloaden (410)', () => allemaal([
    ['getInvoice', async () => geweigerd(await fn('invoice-public', { body: { action: 'getInvoice', token: d.fGecrediteerd.token } }), 'weigering', [410])],
    ['getInvoicePdf', async () => geweigerd(await fn('invoice-public', { body: { action: 'getInvoicePdf', token: d.fGecrediteerd.token } }), 'weigering', [410])],
  ]));
}

/** Deze stappen veranderen A bewust: intrekken en terug naar concept. Daarna mag de oude link niets meer. */
async function tokensNaIntrekken(A, d) {
  groep('Beveiliging: links na intrekken en "terug naar concept"');

  await stap('ingetrokken offerte: de link geeft geen akkoord meer', async () => {
    gelukt(await rpc('withdraw_quote', { p_quote_id: d.qVerstuurd.id, p_organization_id: A.orgId, p_reason: 'Vervangen door een nieuwe offerte' }, A.eigenaar.token), 'intrekken');
    geweigerd(await fn('quote-public', { body: { action: 'acceptQuote', token: d.qVerstuurd.token, name: 'Anna Klant', email: A.klantA.email } }), 'akkoord na intrekken', [409]);
    gelijk(sqlRij(`select status from public.quotes where id = ${q(d.qVerstuurd.id)}`).status, 'cancelled', 'status');
  });

  await stap('contract terug naar concept: de oude ondertekenlink werkt niet meer', async () => {
    gelukt(await rpc('reopen_contract', { p_contract_id: d.cVerstuurd.id, p_organization_id: A.orgId }, A.medewerker.token), 'terug naar concept');
    await allemaal([
      ['openen', async () => geweigerd(await fn('contract-public', { body: { action: 'getContract', token: d.cVerstuurd.token } }), 'weigering', [404])],
      ['tekenen', async () => geweigerd(await fn('contract-public', { body: {
        action: 'signContract', token: d.cVerstuurd.token, signerName: 'Anna Klant', signerEmail: A.klantA.email, signatureMethod: 'typed', consentText: AKKOORDTEKST } }), 'weigering', [409])],
      ['vraag stellen', async () => geweigerd(await fn('contract-public', { body: { action: 'askQuestion', token: d.cVerstuurd.token, name: 'x', email: BUIT, message: 'Hallo?' } }), 'weigering', [409])],
    ]);
    gelijk(sqlRij(`select status from public.contracts where id = ${q(d.cVerstuurd.id)}`).status, 'draft', 'status');
  });

  await stap('ingetrokken contract: de ondertekenlink werkt niet meer', async () => {
    gelukt(await rpc('void_contract', { p_contract_id: d.cIntrekken.id, p_organization_id: A.orgId, p_reason: 'Niet meer nodig' }, A.medewerker.token), 'intrekken');
    await allemaal([
      ['openen', async () => geweigerd(await fn('contract-public', { body: { action: 'getContract', token: d.cIntrekken.token } }), 'weigering', [404])],
      ['tekenen', async () => geweigerd(await fn('contract-public', { body: {
        action: 'signContract', token: d.cIntrekken.token, signerName: 'Anna Klant', signerEmail: A.klantA.email, signatureMethod: 'typed', consentText: AKKOORDTEKST } }), 'weigering', [409])],
    ]);
    gelijk(sqlRij(`select status from public.contracts where id = ${q(d.cIntrekken.id)}`).status, 'voided', 'status');
  });
}

// ── 7. Klantportaal ─────────────────────────────────────────────────────────

async function klantportaal(A, B, d) {
  groep('Beveiliging: klantportaal');
  // Id's en de (unieke) nummers van offerte en factuur. Geen contractnummer:
  // dat telt per organisatie vanaf CON-<jaar>-0001, dus B heeft hetzelfde nummer.
  const idsVanKlantA = [d.qGeaccepteerd.id, d.qVerstuurd.id, d.fBetaald.id, d.fOpen.id, d.cGetekend.id, d.qGeaccepteerd.number, d.fBetaald.number];

  const aanvallen = (portaal) => [
    ['getPortalData toont niets van klant A', async () => {
      const res = gelukt(await fn('client-portal', { token: portaal.token, body: { action: 'getPortalData' } }), 'portaal');
      const tekst = JSON.stringify(res);
      for (const id of idsVanKlantA) verwacht(!tekst.includes(id), `bevat ${id}`);
    }],
    ['getInvoicePdf', async () => geweigerd(await fn('client-portal', { token: portaal.token, body: { action: 'getInvoicePdf', invoiceId: d.fBetaald.id } }), 'weigering', [403, 404])],
    ['getInvoicePaymentInfo', async () => geweigerd(await fn('client-portal', { token: portaal.token, body: { action: 'getInvoicePaymentInfo', invoiceId: d.fOpen.id } }), 'weigering', [403, 404])],
    ['createInvoicePayment', async () => {
      const voor = post.mollie.betalingen.size;
      geweigerd(await fn('client-portal', { token: portaal.token, body: { action: 'createInvoicePayment', invoiceId: d.fOpen.id } }), 'weigering', [403, 404]);
      gelijk(post.mollie.betalingen.size, voor, 'aantal Mollie-betalingen');
    }],
    ['getContractPdf', async () => geweigerd(await fn('client-portal', { token: portaal.token, body: { action: 'getContractPdf', contractId: d.cGetekend.id } }), 'weigering', [403, 404])],
    ['decideQuote accept', async () => {
      geweigerd(await fn('client-portal', { token: portaal.token, body: { action: 'decideQuote', quoteId: d.qVerstuurd.id, kind: 'accept', note: 'Akkoord' } }), 'weigering', [403, 404]);
      gelijk(sqlRij(`select status from public.quotes where id = ${q(d.qVerstuurd.id)}`).status, 'sent', 'status offerte');
    }],
    ['decideQuote reject', async () => {
      geweigerd(await fn('client-portal', { token: portaal.token, body: { action: 'decideQuote', quoteId: d.qVerstuurd.id, kind: 'reject', note: 'Nee' } }), 'weigering', [403, 404]);
      gelijk(sqlRij(`select status from public.quotes where id = ${q(d.qVerstuurd.id)}`).status, 'sent', 'status offerte');
    }],
  ];

  // Tegenproef: klant A ziet zijn eigen stukken wél, en geen concepten.
  await stap('tegenproef: klant A ziet zijn eigen offerte, factuur en contract, maar geen concepten', async () => {
    const res = gelukt(await fn('client-portal', { token: A.portaalA.token, body: { action: 'getPortalData' } }), 'portaal');
    const tekst = JSON.stringify(res);
    for (const id of [d.qGeaccepteerd.id, d.fBetaald.id, d.cGetekend.id]) verwacht(tekst.includes(id), `eigen document ${id} ontbreekt`);
    for (const id of [d.qConcept.id, d.qGoedgekeurd.id, d.qTerGoedkeuring.id, d.fConcept.id, d.cConcept.id]) verwacht(!tekst.includes(id), `concept ${id} staat in het portaal`);
    verwacht(!INTERN.test(tekst.replace(/"organizationId"/g, '')), `intern veld in het portaal: ${tekst.match(INTERN)?.[0]}`);
    gelukt(await fn('client-portal', { token: A.portaalA.token, body: { action: 'getInvoicePdf', invoiceId: d.fBetaald.id } }), 'eigen factuur-PDF');
    gelukt(await fn('client-portal', { token: A.portaalA.token, body: { action: 'getContractPdf', contractId: d.cGetekend.id } }), 'eigen contract-PDF');
  });

  await stap('klant B (zelfde organisatie) ziet en doet niets met de stukken van klant A', () => allemaal(aanvallen(A.portaalB)));
  await stap('een portaalklant van organisatie B ziet en doet niets met de stukken van A', () => allemaal(aanvallen(B.portaalA)));
  await stap('klant B ziet het project van klant A niet', async () => {
    geweigerd(await fn('client-portal', { token: A.portaalB.token, body: { action: 'getProjectDetail', projectId: d.project.id } }), 'weigering', [403, 404]);
  });

  // Een project verhuist van klant A naar klant B (een gewone projectwijziging,
  // ook zonder rechten op Financiën). De offertes en facturen op dat project
  // blijven van klant A.
  await stap('project van klant A verhuist naar klant B', async () => {
    const res = await rest(`projects?id=eq.${d.project.id}&select=id,client_id`, { method: 'PATCH', token: A.medewerker.token, prefer: 'return=representation', body: { client_id: A.klantB.id } });
    gelijk(gelukt(res, 'project verplaatsen')[0]?.client_id, A.klantB.id, 'klant van het project');
  });
  await stap('na de verhuizing ziet en doet klant B nog steeds niets met de stukken van klant A', () => allemaal(aanvallen(A.portaalB)));
  await stap('na de verhuizing ziet klant A zijn eigen stukken nog', async () => {
    const tekst = JSON.stringify(gelukt(await fn('client-portal', { token: A.portaalA.token, body: { action: 'getPortalData' } }), 'portaal'));
    for (const id of [d.qGeaccepteerd.id, d.fBetaald.id]) verwacht(tekst.includes(id), `eigen document ${id} ontbreekt`);
  });

  await stap('een portaalgebruiker leest via PostgREST niets van de organisatie', () => allemaal(
    [...FINANCIEN_TABELLEN, 'company_settings', 'clients', 'client_contacts', 'projects'].map((tabel) => [tabel, async () => {
      leeg(await rest(`${tabel}?organization_id=eq.${A.orgId}&select=*`, { token: A.portaalA.token }), tabel);
    }]),
  ));
  await stap('een portaalgebruiker wijzigt via PostgREST niets', () => allemaal([
    ['eigen offerte accepteren', async () => geenWijziging(await rest(`quotes?id=eq.${d.qVerstuurd.id}&select=id`, { method: 'PATCH', token: A.portaalA.token, prefer: 'return=representation', body: { status: 'accepted' } }), 'offerte')],
    ['eigen factuur op betaald', async () => geenWijziging(await rest(`invoices?id=eq.${d.fOpen.id}&select=id`, { method: 'PATCH', token: A.portaalA.token, prefer: 'return=representation', body: { status: 'paid' } }), 'factuur')],
    ['eigen klantgegevens', async () => geenWijziging(await rest(`clients?id=eq.${A.klantA.id}&select=id`, { method: 'PATCH', token: A.portaalA.token, prefer: 'return=representation', body: { email: BUIT } }), 'klant')],
  ]));
}

// ── 8. Mollie-webhook en cron ───────────────────────────────────────────────

async function webhookEnCron(A, d) {
  groep('Beveiliging: Mollie-webhook en cron');
  const webhook = (query, id, headers = {}) => fn('invoice-workflow', {
    query: `${WEBHOOK}${query}`, origin: null, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, ruw: true, body: `id=${encodeURIComponent(id)}`,
  }, `webhook ${query || '(zonder secret)'}`);
  const statusOpen = () => sqlRij(`select i.status, p.status as betaling from public.invoices i join public.invoice_payment_records p on p.invoice_id = i.id
    where i.id = ${q(d.fOpen.id)} and p.provider_payment_id = ${q(d.fOpen.mollieId)}`);

  await stap('webhook zonder, met een verkeerd of een half secret → 403, en de factuur blijft open', async () => {
    const betaling = post.mollie.betalingen.get(d.fOpen.mollieId);
    betaling.status = 'paid';
    try {
      const voor = statusOpen();
      await allemaal([
        ['zonder secret', async () => geweigerd(await webhook('', d.fOpen.mollieId), 'weigering', [403])],
        ['verkeerd secret', async () => geweigerd(await webhook('&secret=raden', d.fOpen.mollieId), 'weigering', [403])],
        ['half secret', async () => geweigerd(await webhook(`&secret=${WEBHOOK_SECRET.slice(0, 8)}`, d.fOpen.mollieId), 'weigering', [403])],
        ['secret in een header', async () => geweigerd(await webhook('', d.fOpen.mollieId, { 'x-webhook-secret': WEBHOOK_SECRET }), 'weigering', [403])],
      ]);
      gelijk(statusOpen(), voor, 'factuur en betaling');
    } finally {
      betaling.status = 'open';
    }
  });

  await stap('webhook met het goede secret maar een onbekend id of zonder id: niets gebeurt', () => allemaal([
    ['onbekend tr_-id', async () => gelijk((await webhook(`&secret=${WEBHOOK_SECRET}`, 'tr_bestaatniet123')).json, { ok: true, ignored: true }, 'antwoord')],
    ['onbekend re_-id', async () => gelijk((await webhook(`&secret=${WEBHOOK_SECRET}`, 're_bestaatniet123')).json, { ok: true, ignored: true }, 'antwoord')],
    ['zonder id', async () => geweigerd(await webhook(`&secret=${WEBHOOK_SECRET}`, ''), 'weigering', [400])],
  ]));

  // "Mollie" meldt een betaling van A, maar bij Mollie hoort die betaling bij
  // een andere sleutel (een ander Mollie-account). De webhook vraagt de stand
  // op met de sleutel van A en krijgt 404: de factuur mag niet op betaald.
  // Een 502 is hier bewust: dan probeert Mollie het later opnieuw (zie
  // handleMollieWebhook); het is geen crash.
  await stap('webhook voor een betaling die bij Mollie onder een andere sleutel staat: factuur blijft open', async () => {
    const betaling = post.mollie.betalingen.get(d.fOpen.mollieId);
    const echteSleutel = betaling.sleutel;
    betaling.sleutel = d.mollieSleutelB;
    betaling.status = 'paid';
    try {
      const voor = statusOpen();
      const res = await webhook(`&secret=${WEBHOOK_SECRET}`, d.fOpen.mollieId);
      verwacht(res.json?.ok !== true || res.json?.ignored === true, `webhook nam de betaling aan: ${kort(res)}`);
      verwacht([200, 502].includes(res.status), `onverwachte status: ${kort(res)}`);
      gelijk(statusOpen(), voor, 'factuur en betaling');
    } finally {
      betaling.sleutel = echteSleutel;
      betaling.status = 'open';
    }
  });

  await stap('webhook voor een betaling waarvan de Mollie-metadata naar een andere organisatie wijst: genegeerd', async () => {
    const betaling = post.mollie.betalingen.get(d.fOpen.mollieId);
    const echteMeta = betaling.metadata;
    betaling.metadata = { ...echteMeta, organizationId: randomUUID(), invoiceId: randomUUID() };
    betaling.status = 'paid';
    try {
      const voor = statusOpen();
      const res = await webhook(`&secret=${WEBHOOK_SECRET}`, d.fOpen.mollieId);
      gelijk(res.json, { ok: true, ignored: true }, 'antwoord');
      gelijk(statusOpen(), voor, 'factuur en betaling');
    } finally {
      betaling.metadata = echteMeta;
      betaling.status = 'open';
    }
  });

  await stap('cron (herinneringen, aanmaningen, Mollie-facturen) zonder of met een verkeerd secret → 401, geen mail', async () => {
    const mailsVoor = post.mails.length;
    await allemaal(['reminders', 'dunning', 'mollie-sales-invoices'].flatMap((soort) => [
      ['zonder secret', {}], ['verkeerd secret', { 'x-cron-secret': 'raden' }], ['half secret', { 'x-cron-secret': CRON_SECRET.slice(0, 6) }],
      ['secret als Bearer', { authorization: `Bearer ${CRON_SECRET}` }],
    ].map(([wat, headers]) => [`${soort} ${wat}`, async () => geweigerd(await fn('invoice-workflow', { query: `?cron=${soort}`, origin: null, headers, body: {} }, `cron ${soort}`), 'weigering', [401])]).concat([
      [`${soort} secret in de URL`, async () => geweigerd(await fn('invoice-workflow', { query: `?cron=${soort}&secret=${CRON_SECRET}`, origin: null, body: {} }, `cron ${soort}`), 'weigering', [401])],
    ])));
    gelijk(post.mails.length, mailsVoor, 'aantal verstuurde mails');
  });
}

// ── 9. De zijdeur: een teamlid als "klant" in het portaal ───────────────────

/**
 * Een teamlid zonder rechten op Financiën (wel op Klanten) zet zijn eigen
 * inlogadres als portaalcontact bij klant A. Het portaal leidt de toegang af
 * uit dat adres. Mag hij dan via het portaal de facturen, offertes en
 * contracten van klant A lezen, en een offerte "als klant" accepteren?
 * Volgens de harde regel over modulerechten niet: wat het scherm en de
 * database hem weigeren, hoort ook het portaal hem te weigeren.
 */
async function zijdeurPortaal(A, d) {
  groep('Beveiliging: zijdeur via het klantportaal');
  const lid = A.zonderFinancien;

  // Weigert de database dit al (een mogelijke oplossing), dan is de deur dicht
  // en hebben de stappen hierna geen zin.
  const contact = await stap('teamlid zonder Financiën zet zijn eigen adres als portaalcontact bij klant A', async () => {
    const res = await rest('client_contacts?select=id', { method: 'POST', token: lid.token, prefer: 'return=representation', body: {
      organization_id: A.orgId, client_id: A.klantA.id, name: 'Collega als klant', email: lid.email, gives_portal_access: true, is_active: true,
    } });
    if (res.status >= 400 && res.status < 500) return null;
    return gelukt(res, 'contactpersoon')[0];
  });
  if (!contact) return;

  await stap('dat teamlid leest via het portaal geen facturen, offertes of contracten van A', async () => {
    const res = await fn('client-portal', { token: lid.token, body: { action: 'getPortalData' } });
    if (res.status >= 400) return;
    const tekst = res.tekst;
    const gezien = [d.fBetaald.number, d.qGeaccepteerd.number, d.cGetekend.number].filter((n) => tekst.includes(n));
    verwacht(gezien.length === 0, `ziet via het portaal: ${gezien.join(', ')}`);
  });
  await stap('dat teamlid downloadt via het portaal geen factuur- of contract-PDF van A', () => allemaal([
    ['factuur-PDF', async () => geweigerd(await fn('client-portal', { token: lid.token, body: { action: 'getInvoicePdf', invoiceId: d.fBetaald.id } }), 'weigering', [403, 404])],
    ['contract-PDF', async () => geweigerd(await fn('client-portal', { token: lid.token, body: { action: 'getContractPdf', contractId: d.cGetekend.id } }), 'weigering', [403, 404])],
  ]));
  await stap('dat teamlid accepteert via het portaal geen offerte "als klant"', async () => {
    const res = await fn('client-portal', { token: lid.token, body: { action: 'decideQuote', quoteId: d.qZijdeur.id, kind: 'accept', note: 'Akkoord' } });
    const na = sqlRij(`select status, client_decision_by_name, client_decision_by_email from public.quotes where id = ${q(d.qZijdeur.id)}`);
    verwacht(na.status === 'sent', `de offerte staat nu op "${na.status}", beslist door ${na.client_decision_by_name} <${na.client_decision_by_email}> (${kort(res)})`);
    geweigerd(res, 'weigering', [403, 404]);
  });
}

// ── 10. Kwaadaardige invoer en dubbel klikken ───────────────────────────────

async function invoerEnGelijktijdigheid(A) {
  groep('Beveiliging: kwaadaardige invoer en gelijktijdige klikken');

  // De ondertekenpagina zet de contracttekst met innerHTML op de pagina, op het
  // domein van de app. Een script daarin draait dus bij iedereen die de link
  // opent, ook bij een ingelogd teamlid. De server moet het eruit halen,
  // ongeacht hoe de tekst in de database kwam.
  await stap('contracttekst met script en event-handlers: de ondertekenpagina krijgt alleen veilige HTML', async () => {
    const kwaad = '<p>Artikel 1</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">klik</a>'
      + '<iframe src="https://evil.example"></iframe><p style="background:url(javascript:alert(4))" onclick="alert(5)">x</p><svg onload="alert(6)"></svg>';
    const contract = await contractVerstuurd(A, { body: kwaad });
    const pagina = gelukt(await fn('contract-public', { body: { action: 'getContract', token: contract.token } }), 'openen');
    const body = String(pagina.contract.body);
    // Alleen echte tags en attributen tellen: een ge-escapete "&lt;svg onload…&gt;"
    // is tekst op de pagina en voert niets uit.
    const onveilig = [
      ['script-, iframe-, svg- of object-tag', /<\s*(script|iframe|svg|object|embed|style|link|meta)\b/i],
      ['event-handler in een tag', /<[^>]*\son[a-z]+\s*=/i],
      ['javascript:-link', /<[^>]*\s(href|src)\s*=\s*["']?\s*javascript:/i],
      ['style-attribuut', /<[^>]*\sstyle\s*=/i],
    ].filter(([, patroon]) => patroon.test(body)).map(([naam]) => naam);
    verwacht(onveilig.length === 0, `onveilige HTML op de publieke pagina (${onveilig.join(', ')}): ${body}`);
    verwacht(/artikel 1/i.test(body), 'de gewone tekst is verdwenen');
  });

  // Twee klikken tegelijk (dubbelklik, twee tabbladen): er mag maar één
  // beslissing en één handtekening ontstaan, met één bewijs.
  await stap('twee keer tegelijk accepteren: precies één akkoord', async () => {
    const offerte = await offerteVerstuurd(A);
    const akkoord = (naam) => fn('quote-public', { body: { action: 'acceptQuote', token: offerte.token, name: naam, email: A.klantA.email } });
    const [een, twee] = await Promise.all([akkoord('Eerste klik'), akkoord('Tweede klik')]);
    gelijk([een.status, twee.status].sort(), [200, 409], 'statussen');
    const rij = sqlRij(`select client_decision_by_name as naam,
      (select count(*)::int from public.quote_versions v where v.quote_id = q.id and v.snapshot_reason = 'client_accepted') as akkoordversies
      from public.quotes q where id = ${q(offerte.id)}`);
    gelijk(rij, { naam: een.status === 200 ? 'Eerste klik' : 'Tweede klik', akkoordversies: 1 }, 'beslissing');
  });

  await stap('twee keer tegelijk tekenen: precies één handtekening', async () => {
    const contract = await contractVerstuurd(A);
    const pagina = gelukt(await fn('contract-public', { body: { action: 'getContract', token: contract.token } }), 'openen');
    const teken = (naam) => fn('contract-public', { body: {
      action: 'signContract', token: contract.token, signerName: naam, signerEmail: A.klantA.email,
      signatureMethod: 'typed', consentText: AKKOORDTEKST, versionId: pagina.contract.version_id,
    } });
    const [een, twee] = await Promise.all([teken('Eerste klik'), teken('Tweede klik')]);
    gelijk([een.status, twee.status].sort(), [200, 409], 'statussen');
    gelijk(sqlRij(`select count(*)::int as n from public.contract_events where contract_id = ${q(contract.id)} and event_type = 'client_signed'`).n, 1, 'aantal ondertekeningen');
  });
}

// ── 11. Antwoorden lekken niets ─────────────────────────────────────────────

async function lekcontrole(A, B, d) {
  groep('Beveiliging: geen links, tokens of geheimen naar buiten');

  // Een gewone verzending van de aanmaning door de eigenaar; ook dat antwoord
  // gaat naar de browser.
  await stap('eigenaar verstuurt de aanmaning (gewone weg)', async () => {
    gelukt(await fn('invoice-workflow', { token: A.eigenaar.token, body: { action: 'sendDunningNotice', organizationId: A.orgId, noticeId: d.fOpen.aanmaningId } }), 'aanmaning');
  });

  // De publieke factuurlink is een sleutel naar de factuur, de klantgegevens en
  // de betaalpagina, ook voor wie later uit de organisatie verdwijnt. Bij
  // offertes staat hij daarom gemaskeerd in de verzendregel ("(verborgen)").
  // Bij facturen staat hij voluit in de verzendregel, de linktabel, de
  // betaalrij en de aanmaning. (De factuur-PDF zelf noemt de link ook, als
  // "Bekijk deze factuur online"; dat is een bewuste keuze voor de klant. Vier
  // leesbare kopieën in de database zijn dat niet.)
  await stap('Financiën-lezers (boekhouder, kijker) lezen geen publieke factuurlink met token uit de database', () => {
    const bronnen = [
      ['invoice_email_deliveries', 'metadata'],
      ['invoice_public_links', 'metadata'],
      ['invoice_payment_records', 'metadata'],
      ['invoice_dunning_notices', 'public_url'],
      ['quote_email_deliveries', 'metadata'],
    ];
    return allemaal(bronnen.flatMap(([tabel, kolom]) => [['boekhouder', A.boekhouder], ['kijker', A.kijker]].map(([n, g]) => [`${n}: ${tabel}.${kolom}`, async () => {
      const res = await rest(`${tabel}?organization_id=eq.${A.orgId}&select=${kolom}`, { token: g.token });
      if (res.status >= 400) return;
      const gevonden = JSON.stringify(res.json).match(/\/(invoice|quote|contract)\/[A-Za-z0-9_-]{20,}/g) ?? [];
      verwacht(gevonden.length === 0, `${gevonden.length} link(s) met token, bv. ${gevonden[0]}`);
    }])));
  });

  const tokens = [
    d.qGeaccepteerd, d.qVerstuurd, d.qZijdeur, d.fBetaald, d.fOpen, d.fGecrediteerd, d.cGetekend, d.cVerstuurd, d.cIntrekken, d.bOfferte, d.bFactuur, d.bContract,
  ].map((x) => x?.token).filter(Boolean);
  const geheimen = [
    ['service-sleutel', SERVICE_KEY], ['R2-secret', R2_GEHEIM], ['cron-secret', CRON_SECRET], ['webhook-secret', WEBHOOK_SECRET],
    ['Resend-sleutel', process.env.RESEND_API_KEY], ['Mollie-versleutelsleutel', process.env.MOLLIE_TOKEN_ENCRYPTION_KEY],
    ['Mollie-sleutel A', d.mollieSleutelA], ['Mollie-sleutel B', d.mollieSleutelB],
  ].filter(([, waarde]) => waarde);

  const vind = (test) => {
    const per = new Map();
    for (const a of antwoorden) {
      const treffer = test(a.tekst);
      if (treffer) per.set(a.label, `${per.has(a.label) ? `${per.get(a.label)}; ` : ''}${treffer}`);
    }
    return [...per.entries()].map(([label, treffer]) => `${label} → ${treffer}`);
  };

  // Met de link (en de token erin) opent iedereen de factuur met de klantgegevens
  // en de betaalpagina, ook wie later uit de organisatie verdwijnt. Bij offertes
  // en contracten gaat hij daarom bewust niet terug naar de verzender.
  await stap('geen publieke link of token in een antwoord aan de browser', () => {
    const lekken = vind((tekst) => tekst.match(/\/(quote|invoice|contract)\/[A-Za-z0-9_-]{20,}/)?.[0]?.slice(0, 30)
      ?? (tokens.find((t) => tekst.includes(t)) ? 'een bekende token' : null));
    verwacht(lekken.length === 0, `${lekken.length} soort(en) antwoord: ${lekken.join(' | ')}`);
  });
  await stap('geen sleutels of secrets in een antwoord', () => {
    const lekken = vind((tekst) => geheimen.find(([, waarde]) => tekst.includes(waarde))?.[0] ?? (/api_key_encrypted/.test(tekst) ? 'api_key_encrypted' : null));
    verwacht(lekken.length === 0, `antwoorden met een geheim: ${lekken.join(' | ')}`);
  });
  await stap('geen stacktraces of ruwe databasefouten in een antwoord', () => {
    const lekken = vind((tekst) => tekst.match(/\n\s+at [\w.<]+ \(|violates|duplicate key|relation "|column "|syntax error|PGRST\d|SQLSTATE|permission denied for|invalid input syntax/i)?.[0]);
    verwacht(lekken.length === 0, `antwoorden met interne fouttekst: ${lekken.join(' | ')}`);
  });
  // BEV_DEBUG=1: elk antwoord met status, om na te gaan dat een weigering om de juiste reden weigert.
  if (process.env.BEV_DEBUG) for (const a of antwoorden) console.log(`  [debug] ${a.status} ${a.label} ${a.tekst.slice(0, 140)}`);
  await stap(`geen 5xx op een aanval (${antwoorden.length} antwoorden bekeken)`, () => {
    const crashes = antwoorden.filter((a) => a.status >= 500 && !(a.status === 502 && a.label.startsWith('webhook')));
    verwacht(crashes.length === 0, `serverfouten: ${crashes.map((a) => `${a.label}: ${a.status} ${a.tekst.slice(0, 160)}`).join(' | ')}`);
  });
}

// ── Het scenario ────────────────────────────────────────────────────────────

export default async function beveiliging() {
  groep('Beveiliging: klaarzetten');
  const A = await stap('wereld A (het slachtoffer)', () => maakWereld('bev-a'));
  const B = await stap('wereld B (de aanvaller)', () => maakWereld('bev-b'));
  if (!A || !B) return;
  const d = await klaarzetten(A, B);
  const nodig = ['project', 'qGeaccepteerd', 'qVerstuurd', 'qZijdeur', 'qGoedgekeurd', 'qConcept', 'qTerGoedkeuring', 'fBetaald', 'fOpen',
    'fGecrediteerd', 'fConcept', 'cGetekend', 'cVerstuurd', 'cIntrekken', 'cConcept', 'bOfferte', 'bFactuur', 'bContract'];
  const ontbreekt = nodig.filter((sleutel) => !d[sleutel]);
  if (ontbreekt.length) {
    await stap('alle documenten klaargezet', () => { throw new Error(`ontbreekt: ${ontbreekt.join(', ')}`); });
    return;
  }

  const foto = fotoVanA(A);
  const mailsVoor = post.mails.length;
  await andereOrganisatie(A, B, d);
  await rollenBinnenA(A, d);
  await serverVelden(A, d);
  await serverRpcs(A, B, d);
  await anoniem(A, d);
  await publiekeTokens(A, B, d);
  await klantportaal(A, B, d);
  await webhookEnCron(A, d);

  groep('Beveiliging: de stand van A na alle aanvallen');
  await stap('niets van A is veranderd door de aanvallen', () => {
    const na = fotoVanA(A);
    const verschil = verschillen(foto, na);
    verwacht(verschil.length === 0, `${verschil.length} verschil(len): ${verschil.slice(0, 20).join(' | ')}`);
  });
  await stap('er is tijdens de aanvallen geen mail de deur uit gegaan', () => {
    const nieuw = post.mails.slice(mailsVoor);
    verwacht(nieuw.length === 0, `${nieuw.length} mail(s): ${nieuw.map((m) => `${m.to.join(',')} "${m.subject}"`).join('; ')}`);
  });

  await tokensNaIntrekken(A, d);
  await zijdeurPortaal(A, d);
  await invoerEnGelijktijdigheid(A);
  await lekcontrole(A, B, d);
}

