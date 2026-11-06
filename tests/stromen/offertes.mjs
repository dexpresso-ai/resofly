// Offertes end-to-end: concept → interne goedkeuring → versturen (mail met
// PDF) → publieke pagina → akkoord of weigeren → factuur. Met de rechten
// eromheen: welke rol wat mag, een andere organisatie, de klant van een ander
// in het portaal, en de akkoordlink die alleen de klant mag hebben.
//
// Waarom zo uitgebreid: bijna elke stap hier ging ooit stil mis (zie
// docs/rapporten/REVIEW_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md). De link stond
// leesbaar voor de boekhouder, de PDF rekende een cent anders dan de factuur,
// klant B zag de offerte van A na een projectwissel, een mislukte verzending
// bleef op "queued" hangen. Deze test houdt dat vast, met de echte edge
// functions, PostgREST met RLS en de echte database.
//
// Let op: één stap roept functies aan die alleen de server mag gebruiken
// (verwacht: 42501). Op Postgres 17.6.1.111 laat zo'n geweigerde aanroep de
// hele database crashen; draai lokaal op 17.6.1.178 of nieuwer (README.md).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { roep } from './functies.mjs';
import { post } from './nepdiensten.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { gelijk, geweigerd, gelukt, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS, TOTAAL_REGELS } from './wereld.mjs';

// ── Bedragen ─────────────────────────────────────────────────────────
// REGELS: € 102,50 tegen 21% en € 45,50 tegen 9%. Btw per tarief op centen:
// 21,525 → 21,53 en 4,095 → 4,10, samen 25,63 (totaal 173,63). Wie de btw over
// het totaal afrondt, of in drijvende komma rekent, komt op 25,62 (173,62).
const SUBTOTAAL_REGELS = 148;
const BTW_REGELS = 25.63;
const BEDRAGEN_REGELS = [SUBTOTAAL_REGELS, BTW_REGELS, TOTAAL_REGELS];
const REGELS_IN_VERSIE = [['Ontwerp', 102.5, 21.53, 124.03], ['Drukwerk', 45.5, 4.1, 49.6]];

const BROWSER = 'Mozilla/5.0 (Stromen-test; offerte-akkoord)';

// Wat de publieke pagina en het portaal van een offerte mogen zien. Een
// allowlist: komt er een veld bij (bijvoorbeeld een interne notitie), dan
// faalt deze test en moet iemand bewust kiezen.
const VELDEN_PUBLIEK = ['accepted_at', 'client_decision_at', 'client_decision_by_email', 'client_decision_by_name', 'client_decision_note',
  'date', 'id', 'lines', 'notes', 'number', 'public_token_expires_at', 'status', 'valid_until'];
const VELDEN_PORTAAL = ['accepted_at', 'client_decision_at', 'client_decision_by_name', 'client_decision_note', 'date', 'id', 'lines',
  'notes', 'number', 'project_id', 'sent_at', 'status', 'valid_until'];

// ── Hulpjes ──────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** Een stap die iets van een eerdere stap nodig heeft, faalt met een duidelijke reden als die er niet is. */
function nodig(waarde, wat) {
  if (!waarde) throw new Error(`${wat} ontbreekt: een eerdere stap mislukte`);
  return waarde;
}

/**
 * Vandaag (plus `dagen`) in Nederland, als JJJJ-MM-DD. De database rekent de
 * geldigheid en de factuurdatum in Europe/Amsterdam; in UTC was het tussen
 * 00:00 en 02:00 nog gisteren.
 */
function nlDatum(dagen = 0) {
  const vandaag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  const dag = new Date(`${vandaag}T12:00:00Z`);
  dag.setUTCDate(dag.getUTCDate() + dagen);
  return dag.toISOString().slice(0, 10);
}

/** Het UTC-moment waarop het in Nederland `datum` `uur`:`minuut` is (winter- of zomertijd). */
function nlMoment(datum, uur, minuut) {
  const [jaar, maand, dag] = datum.split('-').map(Number);
  const opmaak = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const doel = `${datum}, ${String(uur).padStart(2, '0')}:${String(minuut).padStart(2, '0')}`;
  for (const verschil of [1, 2]) {
    const moment = Date.UTC(jaar, maand - 1, dag, uur - verschil, minuut);
    if (opmaak.format(new Date(moment)) === doel) return moment;
  }
  throw new Error(`geen UTC-moment gevonden voor ${doel} in Nederland`);
}

/**
 * Laat de edge functions één aanroep lang denken dat het `moment` is, in UTC
 * zoals op Supabase (Deno Deploy). De database houdt zijn eigen, echte klok:
 * zo is na te spelen wat er rond middernacht gebeurt, zonder te wachten.
 */
async function alsHetIs(moment, fn) {
  const EchteDate = globalThis.Date;
  const tijdzone = process.env.TZ;
  class NepDate extends EchteDate {
    constructor(...args) {
      if (args.length === 0) super(moment);
      else super(...args);
    }

    static now() {
      return moment;
    }
  }
  globalThis.Date = NepDate;
  process.env.TZ = 'UTC';
  try {
    return await fn();
  } finally {
    globalThis.Date = EchteDate;
    if (tijdzone === undefined) delete process.env.TZ;
    else process.env.TZ = tijdzone;
  }
}

function bedrag(waarde) {
  return Math.round(Number(waarde) * 100) / 100;
}

function bedragen(rij) {
  return [bedrag(rij.subtotal_amount), bedrag(rij.vat_amount), bedrag(rij.total_amount)];
}

/** Regels vergelijken zonder op de volgorde van de sleutels te letten (jsonb sorteert die). */
function regelVorm(regels) {
  return (regels ?? []).map((r) => [r.description, Number(r.quantity), Number(r.unit_price), Number(r.vat ?? 0)]);
}

/** Totalen zoals de database ze rekent (invoice_calculated_totals): regel op centen, btw per tarief. */
function totalen(regels) {
  const perTarief = new Map();
  for (const regel of regels ?? []) {
    const tarief = Number(regel.vat ?? 0);
    perTarief.set(tarief, (perTarief.get(tarief) ?? 0) + Math.round(Number(regel.quantity) * Number(regel.unit_price) * 100));
  }
  let sub = 0;
  let btw = 0;
  for (const [tarief, basis] of perTarief) {
    sub += basis;
    btw += Math.round((basis * tarief) / 100);
  }
  return { subtotaal: sub / 100, btw: btw / 100, totaal: (sub + btw) / 100 };
}

function kies(object, sleutels) {
  return Object.fromEntries(sleutels.map((sleutel) => [sleutel, object?.[sleutel] ?? null]));
}

function eersteRij(json) {
  return Array.isArray(json) ? json[0] : json;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Leden die Financiën niet mogen schrijven: zij mogen niets in de offertestroom veranderen. */
function zonderSchrijfrecht(w) {
  return [
    ['kijker', w.kijker],
    ['boekhouder', w.boekhouder],
    ['lezer (Financiën alleen lezen)', w.lezer],
    ['lid zonder Financiën', w.zonderFinancien],
  ];
}

/** Een concept zoals het bewerkvenster het opslaat: rechtstreeks via PostgREST, als lid. */
async function concept(w, opties = {}) {
  const {
    regels = REGELS, geldigTot = nlDatum(55), klant = w.klantA, project = null,
    notities = 'Levering binnen vier weken na akkoord.', nummer = uniek('OFF'), als = w.medewerker,
  } = opties;
  const res = await rest('quotes?select=*', {
    method: 'POST', token: als.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, client_id: klant ? klant.id : null, project_id: project ? project.id : null,
      number: nummer, date: nlDatum(0), valid_until: geldigTot, lines: regels, notes: notities, status: 'draft',
    },
  });
  gelukt(res, `concept ${nummer} opslaan`);
  return res.json[0];
}

async function indienen(w, offerte) {
  gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.medewerker.token),
    `${offerte.number} indienen`);
}

async function goedkeuren(w, offerte, als = w.beheerder) {
  gelukt(await rpc('approve_quote_internal', { p_quote_id: offerte.id, p_organization_id: w.orgId }, als.token),
    `${offerte.number} goedkeuren`);
}

async function goedgekeurd(w, opties = {}) {
  const offerte = await concept(w, opties);
  await indienen(w, offerte);
  await goedkeuren(w, offerte);
  return offerte;
}

/** Versturen zoals de knop in de app (supabase.functions.invoke('quote-workflow')). */
function versturen(w, offerte, { als = w.medewerker, organizationId = w.orgId, ...extra } = {}) {
  return roep('quote-workflow', { token: als?.token, body: { action: 'sendQuoteEmail', organizationId, quoteId: offerte.id, ...extra } });
}

function downloaden(w, offerte, { als = w.medewerker, organizationId = w.orgId } = {}) {
  return roep('quote-workflow', { token: als?.token, body: { action: 'downloadQuotePdf', organizationId, quoteId: offerte.id } });
}

/** De mails die Resend kreeg over deze offerte (Resend-tag quote_id). */
function mailsOver(offerte) {
  return post.mails.filter((mail) => mail.tags.some((tag) => tag.name === 'quote_id' && tag.value === offerte.id));
}

function linkUit(mail) {
  const m = `${mail.html} ${mail.text}`.match(/\/quote\/([A-Za-z0-9_-]{20,})/);
  verwacht(m, `geen offertelink in de mail "${mail.subject}"`);
  return m[1];
}

/**
 * Concept tot en met verstuurd; geeft de offerte, het antwoord aan de
 * verzender, de mail en de token uit de mail. `verzending` gaat mee met
 * versturen (ontvanger, naam), zoals de vragen die de app stelt.
 */
async function verstuurd(w, opties = {}) {
  const offerte = await goedgekeurd(w, opties);
  const res = await versturen(w, offerte, opties.verzending ?? {});
  const antwoord = gelukt(res, `${offerte.number} versturen`);
  const mails = mailsOver(offerte);
  gelijk(mails.length, 1, `mails over ${offerte.number}`);
  return { offerte, antwoord, res, mail: mails[0], token: linkUit(mails[0]) };
}

/** De publieke offertepagina, zoals de browser van de klant hem aanroept (zonder login). */
function publiek(actie, token, velden = {}, opties = {}) {
  return roep('quote-public', { body: { action: actie, token, ...velden }, ...opties });
}

function portaal(gebruiker, body) {
  return roep('client-portal', { token: gebruiker?.token, body });
}

function omzetten(w, offerte, als, organizationId = w.orgId) {
  return rpc('convert_accepted_quote_to_invoice', { p_quote_id: offerte.id, p_organization_id: organizationId }, als?.token);
}

function offerteRij(id) {
  return sqlRij(`select * from public.quotes where id = ${q(id)}`);
}

function versies(id) {
  return sqlRijen(`select id, version_number, snapshot_reason, subtotal_amount, vat_amount, total_amount, pdf_sha256, pdf_size_bytes,
                          pdf_storage_provider, pdf_storage_key, pdf_data_base64 is not null as pdf_in_database,
                          accepted_sent_version_id, snapshot_data -> 'metadata' as metadata
                     from public.quote_versions where quote_id = ${q(id)} order by version_number`);
}

function versie(id, reden) {
  return versies(id).find((v) => v.snapshot_reason === reden);
}

function events(id, soort) {
  return sqlRijen(`select id, event_type, description, metadata from public.quote_approval_events
                    where quote_id = ${q(id)} and event_type = ${q(soort)} order by created_at`);
}

function laatsteVerzending(id) {
  return sqlRij(`select * from public.quote_email_deliveries where quote_id = ${q(id)} order by created_at desc limit 1`);
}

function aantalFacturen(id) {
  return Number(sql(`select count(*) from public.invoices where quote_id = ${q(id)}`));
}

/**
 * "De tijd laten verstrijken": de geldigheid van een ingediende offerte
 * terugzetten. De inhoud ligt dan vast, ook voor de database-eigenaar
 * (quotes_immutable_after_submission_guard). Alleen in deze ene transactie
 * slaan we de triggers over (session_replication_role, toegestaan door
 * supautils); andere sessies merken er niets van.
 */
function zetGeldigTot(id, datum) {
  sql(`begin; set local session_replication_role = replica;
       update public.quotes set valid_until = ${q(datum)} where id = ${q(id)}; commit;`);
}

/**
 * De tekst van een PDF zoals een lezer hem ziet (pdftotext uit poppler-utils).
 * De PDF gebruikt ingesloten letters: in de ruwe bytes staat de tekst niet leesbaar.
 */
function pdfTekst(bytes) {
  const map = mkdtempSync(join(tmpdir(), 'stromen-offerte-'));
  try {
    const pad = join(map, 'offerte.pdf');
    writeFileSync(pad, bytes);
    return execFileSync('pdftotext', ['-layout', pad, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('pdftotext ontbreekt (installeer poppler-utils): nodig om te lezen wat er op de PDF staat');
    throw error;
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
}

/**
 * Alles wat in een PDF staat buiten de getekende tekst: een link-annotatie
 * (/URI) of metadata zit bij pdf-lib in een gecomprimeerde objectstroom, soms
 * als hex-string, en is in de ruwe bytes onzichtbaar. "endstream" telt niet
 * als begin van een stroom. De getekende tekst zelf staat in glyph-nummers
 * (ingesloten letters); die leest pdfTekst().
 */
function pdfInhoud(bytes) {
  const ruw = Buffer.from(bytes).toString('latin1');
  const delen = [ruw];
  const begin = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = begin.exec(ruw))) {
    const start = m.index + m[0].length;
    const eind = ruw.indexOf('endstream', start);
    if (eind < 0) break;
    try {
      delen.push(inflateSync(Buffer.from(ruw.slice(start, eind), 'latin1')).toString('latin1'));
    } catch {
      // Niet ingepakt: staat al in de ruwe bytes.
    }
  }
  const tekst = delen.join('\n');
  const hex = [...tekst.matchAll(/<([0-9A-Fa-f\s]{8,})>/g)].map((h) => Buffer.from(h[1].replace(/\s+/g, ''), 'hex').toString('latin1'));
  return [tekst, ...hex].join('\n');
}

/** Waar de offerte iets over zichzelf bewaart, als tekst doorzocht op de token. */
function plekkenMetToken(id, token) {
  const o = q(id);
  const t = q(token);
  return sqlRijen(`
    select 'quotes' as plek from public.quotes x where x.id = ${o} and strpos(x::text, ${t}) > 0
    union all select 'quote_email_deliveries' from public.quote_email_deliveries x where x.quote_id = ${o} and strpos(x::text, ${t}) > 0
    union all select 'quote_versions' from public.quote_versions x where x.quote_id = ${o} and strpos(x::text, ${t}) > 0
    union all select 'quote_version_items' from public.quote_version_items x where x.quote_id = ${o} and strpos(x::text, ${t}) > 0
    union all select 'quote_approval_events' from public.quote_approval_events x where x.quote_id = ${o} and strpos(x::text, ${t}) > 0
    union all select 'audit_logs' from public.audit_logs x where x.entity_id = ${o} and strpos(x::text, ${t}) > 0
    union all select 'webhook_events' from public.webhook_events x where x.entity_id::text = ${o} and strpos(x::text, ${t}) > 0`)
    .map((rij) => rij.plek);
}

// ── Scenario ─────────────────────────────────────────────────────────

export default async function offertes() {
  groep('Offertes');
  const werelden = await stap('werelden maken: de eigen organisatie en een andere', async () => ({
    w: await maakWereld('offertes'),
    ander: await maakWereld('offertes-ander'),
  }));
  if (!werelden) return;
  const { w, ander } = werelden;

  const k = await keten(w, ander);
  await inhoudLigtVast(w);
  await weigerenEnGrenzen(w);
  await intrekken(w, ander);
  await verlopen(w);
  await nummers(w, ander);
  await pdfEnStoringen(w, ander, k);
  await klantportaal(w);
  await andereOrganisatie(w, ander);
  await publiekeFunctie(w, k);
  await modulerechtenInVersies(w);
  await kleineondernemersregeling();
}

// ── 1. De hele keten ─────────────────────────────────────────────────

async function keten(w, ander) {
  groep('Offertes — volledige keten');
  const k = {};

  k.offerte = await stap('concept opslaan als lid via PostgREST, zoals de app', async () => {
    const offerte = await concept(w, { nummer: uniek('OFF-KETEN') });
    gelijk([offerte.status, offerte.internal_approval_status], ['draft', 'draft'], 'status van een nieuw concept');
    gelijk(regelVorm(offerte.lines), regelVorm(REGELS), 'regels');
    return offerte;
  });

  await stap('wie Financiën niet mag schrijven en anoniem: geen offerte opslaan', async () => {
    for (const [rol, gebruiker] of zonderSchrijfrecht(w)) {
      geweigerd(await rest('quotes?select=id', {
        method: 'POST', token: gebruiker.token, prefer: 'return=representation',
        body: { organization_id: w.orgId, client_id: w.klantA.id, number: uniek('OFF-ROL'), lines: REGELS },
      }), `opslaan als ${rol}`);
    }
    geweigerd(await rest('quotes?select=id', {
      method: 'POST', prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, number: uniek('OFF-ANON'), lines: REGELS },
    }), 'opslaan anoniem');
    geweigerd(await rest(`quotes?organization_id=eq.${w.orgId}&select=id`), 'lezen anoniem');
  });

  await stap('indienen: kijker, boekhouder, lezer, lid zonder Financiën en anoniem geweigerd', async () => {
    const o = nodig(k.offerte, 'het concept');
    const args = { p_quote_id: o.id, p_organization_id: w.orgId };
    for (const [rol, gebruiker] of zonderSchrijfrecht(w)) {
      geweigerd(await rpc('submit_quote_for_internal_approval', args, gebruiker.token), `indienen als ${rol}`);
    }
    geweigerd(await rpc('submit_quote_for_internal_approval', args), 'indienen anoniem');
    gelijk(offerteRij(o.id).status, 'draft', 'status na de geweigerde pogingen');
  });

  await stap('indienen door het lid', async () => {
    const o = nodig(k.offerte, 'het concept');
    const rij = eersteRij(gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: o.id, p_organization_id: w.orgId }, w.medewerker.token), 'indienen'));
    gelijk([rij.status, rij.internal_approval_status], ['pending_internal_approval', 'pending'], 'status na indienen');
  });

  await stap('goedkeuren: lid, kijker, boekhouder, lezer, lid zonder Financiën en anoniem geweigerd', async () => {
    const o = nodig(k.offerte, 'het concept');
    const args = { p_quote_id: o.id, p_organization_id: w.orgId };
    // Een lid met volledig schrijfrecht mag indienen, maar niet zijn eigen offerte goedkeuren.
    for (const [rol, gebruiker] of [['lid (geen beheerder)', w.medewerker], ...zonderSchrijfrecht(w)]) {
      geweigerd(await rpc('approve_quote_internal', args, gebruiker.token), `goedkeuren als ${rol}`);
      geweigerd(await rpc('reject_quote_internal', { ...args, p_note: 'nee' }, gebruiker.token), `intern afwijzen als ${rol}`);
    }
    geweigerd(await rpc('approve_quote_internal', args), 'goedkeuren anoniem');
    gelijk(offerteRij(o.id).status, 'pending_internal_approval', 'status na de geweigerde pogingen');
  });

  await stap('goedkeuren door de beheerder legt een versie vast: € 148,00 + € 25,63 btw = € 173,63', async () => {
    const o = nodig(k.offerte, 'het concept');
    const rij = eersteRij(gelukt(await rpc('approve_quote_internal', { p_quote_id: o.id, p_organization_id: w.orgId }, w.beheerder.token), 'goedkeuren'));
    gelijk([rij.status, rij.internal_approval_status], ['internally_approved', 'approved'], 'status na goedkeuren');
    const v = versie(o.id, 'internal_approval');
    verwacht(v, 'geen versie bij goedkeuren');
    gelijk(bedragen(v), BEDRAGEN_REGELS, 'bedragen in de goedkeuringsversie');
    const items = sqlRijen(`select description, line_subtotal, line_vat, line_total from public.quote_version_items
                             where quote_version_id = ${q(v.id)} order by line_index`);
    gelijk(items.map((i) => [i.description, bedrag(i.line_subtotal), bedrag(i.line_vat), bedrag(i.line_total)]), REGELS_IN_VERSIE, 'regels in de versie');
  });

  await stap('versturen: kijker, boekhouder, lezer, lid zonder Financiën en anoniem geweigerd', async () => {
    const o = nodig(k.offerte, 'het concept');
    for (const [rol, gebruiker] of zonderSchrijfrecht(w)) {
      geweigerd(await versturen(w, o, { als: gebruiker }), `versturen als ${rol}`, [403]);
    }
    geweigerd(await versturen(w, o, { als: null }), 'versturen anoniem', [401]);
    gelijk(mailsOver(o).length, 0, 'mails na de geweigerde pogingen');
    gelijk(offerteRij(o.id).status, 'internally_approved', 'status na de geweigerde pogingen');
  });

  k.verzending = await stap('versturen door het lid: het antwoord bevat de link niet, de verzending is vastgelegd', async () => {
    const o = nodig(k.offerte, 'het concept');
    const res = await versturen(w, o);
    const antwoord = gelukt(res, 'versturen');
    const mails = mailsOver(o);
    gelijk(mails.length, 1, 'mails aan de klant');
    const mail = mails[0];
    gelijk(mail.to, [w.klantA.email], 'ontvanger');
    const token = linkUit(mail);
    // Met de link in het antwoord kon de verzender zelf "namens de klant" akkoord geven.
    verwacht(!res.tekst.includes(token) && !res.tekst.includes('/quote/'), 'het antwoord aan de verzender bevat de akkoordlink');
    gelijk(antwoord.delivery?.status, 'sent', 'verzendstatus in het antwoord');
    const rij = offerteRij(o.id);
    gelijk(rij.status, 'sent', 'status na versturen');
    verwacht(rij.sent_at, 'sent_at is niet gezet');
    const verzending = laatsteVerzending(o.id);
    gelijk([verzending.status, verzending.recipient_email], ['sent', w.klantA.email], 'verzendregel');
    return { antwoord, mail, token };
  });

  await stap('de mail noemt het nummer, € 173,63 en de geldigheid, en bevat de link', async () => {
    const { mail, token } = nodig(k.verzending, 'de verzending');
    const o = k.offerte;
    verwacht(mail.subject.includes(o.number), `onderwerp zonder offertenummer: ${mail.subject}`);
    verwacht(mail.subject.includes(`${w.naam} Studio B.V.`), `onderwerp zonder bedrijfsnaam: ${mail.subject}`);
    const [jaar, maand, dag] = o.valid_until.split('-').map(Number);
    const geldig = `${dag}-${maand}-${jaar}`;
    for (const [soort, inhoud] of [['tekst', mail.text], ['html', mail.html]]) {
      verwacht(/€\s?173,63/.test(inhoud), `${soort}: totaal € 173,63 ontbreekt`);
      verwacht(!/173,62/.test(inhoud), `${soort}: noemt € 173,62`);
      verwacht(inhoud.includes(geldig), `${soort}: "geldig tot ${geldig}" ontbreekt`);
      verwacht(inhoud.includes(`/quote/${token}`), `${soort}: de link ontbreekt`);
    }
  });

  k.pdf = await stap('PDF-bijlage: een echte PDF met de bedragen per tarief, gelijk aan de vastgelegde versie', async () => {
    const { mail, antwoord } = nodig(k.verzending, 'de verzending');
    const o = k.offerte;
    const pdfs = mail.bijlagen.filter((b) => b.naam.toLowerCase().endsWith('.pdf'));
    gelijk(pdfs.length, 1, 'PDF-bijlagen');
    const pdf = pdfs[0];
    gelijk(pdf.naam, `offerte-${o.number}.pdf`, 'bestandsnaam');
    gelijk(pdf.bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'begin van het bestand');
    verwacht(pdf.bytes.subarray(-1024).toString('latin1').includes('%%EOF'), 'de PDF heeft geen %%EOF');
    const hash = sha256(pdf.bytes);
    gelijk(hash, antwoord.attachment?.sha256, 'hash in het antwoord aan de verzender');
    const verzonden = versie(o.id, 'sent_to_client');
    verwacht(verzonden, 'geen verzonden versie');
    gelijk([verzonden.pdf_sha256, Number(verzonden.pdf_size_bytes)], [hash, pdf.bytes.length], 'PDF in de verzonden versie');
    gelijk(laatsteVerzending(o.id).attachment_sha256, hash, 'PDF in de verzendregel');
    gelijk(bedragen(verzonden), BEDRAGEN_REGELS, 'bedragen in de verzonden versie');
    const tekst = pdfTekst(pdf.bytes);
    for (const stuk of [o.number, `${w.naam} Studio B.V.`, '12345678', w.klantA.name, 'Ontwerp', 'Drukwerk', '148,00', '21,53', '4,10', '173,63']) {
      verwacht(tekst.includes(stuk), `"${stuk}" staat niet op de PDF`);
    }
    verwacht(!tekst.includes('173,62'), 'de PDF noemt € 173,62 (btw over het totaal afgerond)');
    return pdf;
  });

  await stap('de PDF bevat geen akkoordlink en geen token', async () => {
    const pdf = nodig(k.pdf, 'de PDF');
    const { token } = k.verzending;
    // De bewaarde PDF is voor elke lezer van Financiën te downloaden (ook de
    // boekhouder) en wordt doorgestuurd; met de link kon die "namens de klant" akkoord geven.
    const inhoud = pdfInhoud(pdf.bytes);
    verwacht(!inhoud.includes(token), 'de token staat in de PDF (annotatie of metadata)');
    verwacht(!inhoud.includes('/quote/'), 'een offertelink staat in de PDF (annotatie of metadata)');
    // De opmaak breekt een lange link over regels: zoek ook zonder witruimte.
    const tekst = pdfTekst(pdf.bytes);
    verwacht(!tekst.includes('/quote/') && !tekst.replace(/\s+/g, '').includes(token), 'de link staat leesbaar op de PDF');
  });

  await stap('de link staat nergens leesbaar opgeslagen, ook niet voor de boekhouder', async () => {
    const { token } = nodig(k.verzending, 'de verzending');
    const o = k.offerte;
    gelijk(plekkenMetToken(o.id, token), [], 'tabellen met de token');
    const verzending = laatsteVerzending(o.id);
    verwacht(/\/quote\/\(verborgen\)$/.test(verzending.metadata?.publicUrl ?? ''), `link niet gemaskeerd in de verzendregel: ${verzending.metadata?.publicUrl}`);
    // Zoals de boekhouder (gast, Financiën lezen) het in de app kan opvragen.
    for (const pad of [`quote_email_deliveries?quote_id=eq.${o.id}&select=*`, `quote_versions?quote_id=eq.${o.id}&select=*`,
      `quote_approval_events?quote_id=eq.${o.id}&select=*`, `quotes?id=eq.${o.id}&select=*`]) {
      const res = await rest(pad, { token: w.boekhouder.token });
      gelukt(res, pad);
      verwacht(res.json.length > 0, `de boekhouder ziet niets in ${pad.split('?')[0]} (klopt de test nog?)`);
      verwacht(!res.tekst.includes(token), `de boekhouder leest de token in ${pad.split('?')[0]}`);
    }
  });

  await stap('een lid zonder Financiën leest de offerte niet, en ook haar versies, verzendregels en tijdlijn niet', async () => {
    const o = nodig(k.offerte, 'het concept');
    for (const pad of [`quotes?id=eq.${o.id}&select=id`, `quote_versions?quote_id=eq.${o.id}&select=id`, `quote_version_items?quote_id=eq.${o.id}&select=id`,
      `quote_email_deliveries?quote_id=eq.${o.id}&select=id`, `quote_approval_events?quote_id=eq.${o.id}&select=id`]) {
      gelijk(gelukt(await rest(pad, { token: w.zonderFinancien.token }), pad), [], `${pad.split('?')[0]} voor een lid zonder Financiën`);
    }
    // Ter controle: dezelfde vraag als lezer van Financiën geeft wél iets terug.
    verwacht(gelukt(await rest(`quote_versions?quote_id=eq.${o.id}&select=id`, { token: w.lezer.token }), 'lezer').length > 0, 'de lezer ziet geen versies (klopt de test nog?)');
  });

  await stap('de link werkt minstens tot en met de geldigheidsdatum (langer dan de vaste 30 dagen)', async () => {
    const o = nodig(k.offerte, 'het concept');
    const verloopt = new Date(offerteRij(o.id).public_token_expires_at).getTime();
    const [jaar, maand, dag] = o.valid_until.split('-').map(Number);
    // 00:00 UTC de dag erna ligt na 23:59 Nederlandse tijd op de laatste geldige dag.
    verwacht(verloopt >= Date.UTC(jaar, maand - 1, dag + 1), `de link verloopt ${new Date(verloopt).toISOString()}, vóór het einde van ${o.valid_until}`);
  });

  await stap('publieke pagina: de offerte met regels en totaal, zonder interne velden', async () => {
    const { token } = nodig(k.verzending, 'de verzending');
    const o = k.offerte;
    const res = await publiek('getQuote', token);
    const data = gelukt(res, 'bekijken');
    gelijk(Object.keys(data.quote).sort(), VELDEN_PUBLIEK, 'velden van de offerte');
    gelijk([data.quote.id, data.quote.number, data.quote.status], [o.id, o.number, 'sent'], 'offerte');
    gelijk(totalen(data.quote.lines).totaal, TOTAAL_REGELS, 'totaal uit de regels');
    gelijk(data.client?.name, w.klantA.name, 'klant');
    for (const intern of ['public_token_hash', 'internal_approval', 'internal_rejection', 'organization_id', 'pdf_data_base64', 'recipient_email']) {
      verwacht(!res.tekst.includes(intern), `de publieke pagina geeft "${intern}" mee`);
    }
    verwacht(data.events.some((e) => e.event_type === 'sent_to_client'), 'de tijdlijn mist "verstuurd"');
    verwacht(!data.events.some((e) => /internal/.test(e.event_type)), 'de tijdlijn toont interne stappen');
    gelijk(events(o.id, 'client_viewed').length, 1, '"bekeken" vastgelegd');
  });

  await stap('akkoord via de publieke pagina legt bewijs vast: IP, browser, uitgenodigd adres en of dat klopt', async () => {
    const { token } = nodig(k.verzending, 'de verzending');
    const o = k.offerte;
    // Hoofdletters en spaties: het adres moet genormaliseerd vergeleken worden.
    const res = await publiek('acceptQuote', token,
      { name: 'Anna de Klant', email: `  ${w.klantA.email.toUpperCase()} `, note: 'Akkoord, start in januari.' },
      { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '198.51.100.23, 10.0.0.7' } });
    gelijk(gelukt(res, 'akkoord').quote.status, 'accepted', 'status in het antwoord');
    const rij = offerteRij(o.id);
    gelijk([rij.status, rij.client_decision_by_name, rij.client_decision_by_email, rij.client_decision_note],
      ['accepted', 'Anna de Klant', w.klantA.email, 'Akkoord, start in januari.'], 'beslissing op de offerte');
    const bewijs = { ip: '198.51.100.23', userAgent: BROWSER, invitedEmail: w.klantA.email, emailMatchesInvitation: true };
    const ev = events(o.id, 'client_accepted');
    gelijk(ev.length, 1, 'akkoord-events');
    gelijk(kies(ev[0].metadata, Object.keys(bewijs)), bewijs, 'bewijs in het event');
    const verzonden = versie(o.id, 'sent_to_client');
    const geaccepteerd = versie(o.id, 'client_accepted');
    verwacht(geaccepteerd, 'geen versie bij akkoord');
    gelijk(kies(geaccepteerd.metadata, Object.keys(bewijs)), bewijs, 'bewijs in de versie');
    gelijk([rij.accepted_sent_version_id, geaccepteerd.accepted_sent_version_id], [verzonden.id, verzonden.id], 'akkoord hoort bij de verzonden versie');
    gelijk(bedragen(geaccepteerd), BEDRAGEN_REGELS, 'bedragen in de akkoordversie');
  });

  await stap('na akkoord geen tweede beslissing: niet via de link, niet via het portaal', async () => {
    const { token } = nodig(k.verzending, 'de verzending');
    const o = k.offerte;
    geweigerd(await publiek('acceptQuote', token, { name: 'Anna', email: w.klantA.email }), 'nog eens akkoord', [409]);
    geweigerd(await publiek('rejectQuote', token, { name: 'Anna', email: w.klantA.email }), 'alsnog weigeren', [409]);
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: o.id, kind: 'reject' }), 'weigeren via het portaal', [409]);
    gelijk(offerteRij(o.id).status, 'accepted', 'status');
  });

  await stap('omzetten: kijker, boekhouder, lezer, lid zonder Financiën, andere organisatie en anoniem geweigerd', async () => {
    const o = nodig(k.offerte, 'het concept');
    for (const [rol, gebruiker] of zonderSchrijfrecht(w)) geweigerd(await omzetten(w, o, gebruiker), `omzetten als ${rol}`);
    geweigerd(await omzetten(w, o, ander.eigenaar), 'andere organisatie, met het organisatie-id van de offerte');
    geweigerd(await omzetten(w, o, ander.eigenaar, ander.orgId), 'andere organisatie, met het eigen organisatie-id');
    geweigerd(await omzetten(w, o, null), 'anoniem');
    gelijk(aantalFacturen(o.id), 0, 'facturen na de geweigerde pogingen');
  });

  k.factuur = await stap('omzetten naar factuur: regels, btw, totaal, nummer en datum in Nederlandse tijd', async () => {
    const o = nodig(k.offerte, 'het concept');
    const f = eersteRij(gelukt(await omzetten(w, o, w.medewerker), 'omzetten'));
    const verzonden = versie(o.id, 'sent_to_client');
    // De factuur komt uit de versie die de klant kreeg en accepteerde, niet uit de (wijzigbare) offerterij.
    gelijk([f.status, f.quote_id, f.client_id, f.source_quote_version_id], ['draft', o.id, w.klantA.id, verzonden.id], 'herkomst van de factuur');
    gelijk(regelVorm(f.lines), regelVorm(REGELS), 'regels');
    gelijk(bedragen(f), BEDRAGEN_REGELS, 'bedragen');
    gelijk([f.date, f.due_date], [nlDatum(0), nlDatum(14)], 'factuurdatum en vervaldatum');
    verwacht(new RegExp(`^FAC-${nlDatum(0).slice(0, 4)}-\\d{4,}$`).test(f.number), `factuurnummer ${f.number} past niet bij het jaar ${nlDatum(0).slice(0, 4)}`);
    gelijk(f.notes, o.notes, 'toelichting');
    return f;
  });

  await stap('omzetten is idempotent: nog eens, en twee keer tegelijk, geeft één factuur', async () => {
    const o = nodig(k.offerte, 'het concept');
    const f = nodig(k.factuur, 'de factuur');
    gelijk(eersteRij(gelukt(await omzetten(w, o, w.medewerker), 'nog eens omzetten')).id, f.id, 'tweede keer: dezelfde factuur');
    gelijk(aantalFacturen(o.id), 1, 'facturen voor deze offerte');
    // Dubbelklik: twee verzoeken tegelijk voor een andere geaccepteerde offerte.
    const tweede = await verstuurd(w);
    gelukt(await publiek('acceptQuote', tweede.token, { name: 'Anna', email: w.klantA.email }), 'akkoord');
    const [a, b] = await Promise.all([omzetten(w, tweede.offerte, w.medewerker), omzetten(w, tweede.offerte, w.medewerker)]);
    gelijk(eersteRij(gelukt(a, 'eerste')).id, eersteRij(gelukt(b, 'tweede')).id, 'twee keer tegelijk: dezelfde factuur');
    gelijk(aantalFacturen(tweede.offerte.id), 1, 'facturen na twee keer tegelijk');
  });

  return k;
}

// ── 2. Inhoud en status liggen vast ──────────────────────────────────

async function inhoudLigtVast(w) {
  groep('Offertes — inhoud en status liggen vast');

  await stap('een concept blijft te wijzigen; een offerte zonder regels kan niet worden ingediend', async () => {
    const o = await concept(w);
    const gewijzigd = await rest(`quotes?id=eq.${o.id}&select=id,lines`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
      body: { lines: [...REGELS, { description: 'Extra', quantity: 2, unit_price: 10, vat: 21 }] },
    });
    gelijk(gelukt(gewijzigd, 'concept wijzigen').length, 1, 'gewijzigde rijen');
    const leeg = await concept(w, { regels: [] });
    geweigerd(await rpc('submit_quote_for_internal_approval', { p_quote_id: leeg.id, p_organization_id: w.orgId }, w.medewerker.token), 'indienen zonder regels');
  });

  const ingediend = await stap('concept indienen', async () => {
    const o = await concept(w);
    await indienen(w, o);
    return o;
  });

  await stap('na indienen: regels, datums, klant, nummer en toelichting niet te wijzigen, ook niet door de eigenaar', async () => {
    const o = nodig(ingediend, 'de ingediende offerte');
    const pogingen = {
      lines: [{ description: 'Ontwerp', quantity: 1, unit_price: 1, vat: 21 }],
      notes: 'Andere toelichting',
      number: uniek('OFF-ANDERS'),
      valid_until: nlDatum(90),
      date: nlDatum(-10),
      client_id: w.klantB.id,
    };
    for (const [veld, waarde] of Object.entries(pogingen)) {
      for (const [rol, gebruiker] of [['lid', w.medewerker], ['eigenaar', w.eigenaar]]) {
        geweigerd(await rest(`quotes?id=eq.${o.id}&select=id`, {
          method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: { [veld]: waarde },
        }), `${veld} wijzigen als ${rol}`);
      }
    }
    const rij = offerteRij(o.id);
    gelijk(regelVorm(rij.lines), regelVorm(REGELS), 'regels');
    gelijk([rij.number, rij.client_id, rij.valid_until, rij.notes, rij.date], [o.number, o.client_id, o.valid_until, o.notes, o.date], 'inhoud');
  });

  await stap('intern afwijzen opent de offerte weer; daarna opnieuw indienen en goedkeuren (eigenaar) kan', async () => {
    const o = nodig(ingediend, 'de ingediende offerte');
    const afgewezen = eersteRij(gelukt(await rpc('reject_quote_internal', { p_quote_id: o.id, p_organization_id: w.orgId, p_note: 'Prijs te laag' }, w.beheerder.token), 'intern afwijzen'));
    gelijk([afgewezen.status, afgewezen.internal_approval_status, afgewezen.internal_rejection_note], ['draft', 'rejected', 'Prijs te laag'], 'na intern afwijzen');
    const nieuweRegels = REGELS.map((r) => ({ ...r, unit_price: r.unit_price + 10 }));
    gelijk(gelukt(await rest(`quotes?id=eq.${o.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { lines: nieuweRegels },
    }), 'wijzigen na afwijzen').length, 1, 'gewijzigde rijen');
    await indienen(w, o);
    await goedkeuren(w, o, w.eigenaar);
    const rij = offerteRij(o.id);
    gelijk([rij.status, rij.internal_rejection_note], ['internally_approved', null], 'na opnieuw goedkeuren');
    gelijk(regelVorm(rij.lines), regelVorm(nieuweRegels), 'de nieuwe regels');
  });

  const vast = await stap('offerte versturen', () => verstuurd(w));

  await stap('na versturen: status en werkvelden niet zelf te zetten via PostgREST, ook niet door de eigenaar', async () => {
    const { offerte: o } = nodig(vast, 'de verstuurde offerte');
    const voor = offerteRij(o.id);
    const nu = new Date().toISOString();
    const pogingen = [
      { status: 'accepted' }, { status: 'cancelled' }, { status: 'draft' }, { status: 'internally_approved' },
      { sent_at: null }, { accepted_at: nu }, { client_decision_by_name: 'Nep-klant', client_decision_at: nu },
      { public_token_expires_at: '2099-01-01T00:00:00Z' }, { public_token_hash: 'a'.repeat(64) },
      { internal_approval_status: 'pending' }, { last_pdf_sha256: 'b'.repeat(64) }, { sent_version_id: null },
    ];
    for (const body of pogingen) {
      for (const [rol, gebruiker] of [['lid', w.medewerker], ['eigenaar', w.eigenaar]]) {
        geweigerd(await rest(`quotes?id=eq.${o.id}&select=id`, {
          method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body,
        }), `${Object.keys(body).join(' en ')} zetten als ${rol}`);
      }
    }
    const na = offerteRij(o.id);
    const velden = ['status', 'sent_at', 'accepted_at', 'client_decision_by_name', 'public_token_expires_at', 'public_token_hash', 'sent_version_id', 'last_pdf_sha256'];
    gelijk(kies(na, velden), kies(voor, velden), 'werkvelden');
  });

  await stap('na versturen: regels niet te wijzigen, en de offerte niet te verwijderen (bewaarplicht)', async () => {
    const { offerte: o } = nodig(vast, 'de verstuurde offerte');
    geweigerd(await rest(`quotes?id=eq.${o.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { lines: [{ description: 'Gratis', quantity: 1, unit_price: 0, vat: 21 }] },
    }), 'regels wijzigen');
    for (const [rol, gebruiker] of [['lid', w.medewerker], ['eigenaar', w.eigenaar]]) {
      geweigerd(await rest(`quotes?id=eq.${o.id}&select=id`, { method: 'DELETE', token: gebruiker.token, prefer: 'return=representation' }), `verwijderen als ${rol}`);
    }
    const rij = offerteRij(o.id);
    verwacht(rij, 'de verstuurde offerte is verwijderd');
    gelijk(regelVorm(rij.lines), regelVorm(REGELS), 'regels');
  });

  await stap('een nieuwe offerte kan niet meteen als verstuurd, goedgekeurd of geaccepteerd worden opgeslagen', async () => {
    const pogingen = [
      { status: 'sent' }, { status: 'accepted' }, { status: 'internally_approved', internal_approval_status: 'approved' },
      { public_token_hash: 'c'.repeat(64), public_token_expires_at: '2099-01-01T00:00:00Z' }, { sent_at: new Date().toISOString() },
    ];
    for (const extra of pogingen) {
      geweigerd(await rest('quotes?select=id', {
        method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
        body: { organization_id: w.orgId, client_id: w.klantA.id, number: uniek('OFF-DIRECT'), lines: REGELS, ...extra },
      }), `opslaan met ${Object.keys(extra).join(' en ')}`);
    }
  });

  await stap('versies, verzendregels en events zijn niet te vervalsen; de serverfuncties zijn niet aan te roepen', async () => {
    const { offerte: o } = nodig(vast, 'de verstuurde offerte');
    const verzonden = versie(o.id, 'sent_to_client');
    const aantalVersies = versies(o.id).length;
    geweigerd(await rest('quote_versions?select=id', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, quote_id: o.id, version_number: 99, snapshot_reason: 'client_accepted', quote_number: o.number, snapshot_data: {} },
    }), 'een versie bijschrijven');
    nietsVeranderd(await rest(`quote_versions?id=eq.${verzonden.id}&select=id`, {
      method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { total_amount: 1 },
    }), 'een versie wijzigen');
    nietsVeranderd(await rest(`quote_versions?id=eq.${verzonden.id}&select=id`, {
      method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation',
    }), 'een versie wissen');
    nietsVeranderd(await rest(`quote_version_items?quote_version_id=eq.${verzonden.id}&select=id`, {
      method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { unit_price: 1 },
    }), 'een versieregel wijzigen');
    geweigerd(await rest('quote_approval_events?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, quote_id: o.id, event_type: 'client_accepted', title: 'Klant heeft de offerte geaccepteerd', metadata: { ip: '192.0.2.1' } },
    }), 'een nep-akkoord in de tijdlijn');
    nietsVeranderd(await rest(`quote_email_deliveries?quote_id=eq.${o.id}&select=id`, {
      method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { recipient_email: 'iemand@anders.test' },
    }), 'de ontvanger achteraf wijzigen');
    // Wie de hash van de token kan lezen (elk lid met Financiën), mag er niet
    // zelf mee beslissen: deze functies zijn alleen voor de server.
    const hash = offerteRij(o.id).public_token_hash;
    geweigerd(await rpc('accept_quote_public', { p_token_hash: hash, p_name: 'Nep', p_email: w.klantA.email }, w.medewerker.token), 'accept_quote_public als lid');
    geweigerd(await rpc('decide_quote_portal', { p_quote_id: o.id, p_organization_id: w.orgId, p_kind: 'accept', p_name: 'Nep', p_email: w.klantA.email }, w.eigenaar.token), 'decide_quote_portal als eigenaar');
    geweigerd(await rpc('create_quote_version_snapshot', { p_quote_id: o.id, p_organization_id: w.orgId, p_snapshot_reason: 'manual' }, w.eigenaar.token), 'create_quote_version_snapshot als eigenaar');
    gelijk(offerteRij(o.id).status, 'sent', 'status');
    gelijk(versies(o.id).length, aantalVersies, 'aantal versies');
    gelijk(bedragen(versie(o.id, 'sent_to_client')), BEDRAGEN_REGELS, 'bedragen in de verzonden versie');
    gelijk(laatsteVerzending(o.id).recipient_email, w.klantA.email, 'ontvanger');
    gelijk(events(o.id, 'client_accepted').length, 0, 'akkoord-events');
  });
}

// ── 3. Weigeren, bewijs en lengtegrenzen ─────────────────────────────

async function weigerenEnGrenzen(w) {
  groep('Offertes — weigeren, bewijs en lengtegrenzen');

  const geweigerdeOfferte = await stap('offerte versturen', () => verstuurd(w));

  await stap('weigeren via de publieke pagina met een ander adres dan uitgenodigd: bewijs vastgelegd', async () => {
    const { offerte: o, token } = nodig(geweigerdeOfferte, 'de verstuurde offerte');
    // Precies op de grens: 200 tekens naam en 4000 tekens opmerking mogen nog.
    const naam = `Bram ${'B'.repeat(195)}`;
    const opmerking = 'n'.repeat(4000);
    gelukt(await publiek('rejectQuote', token, { name: naam, email: 'Inkoop@Klant-Anders.test', note: opmerking },
      { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '203.0.113.50' } }), 'weigeren');
    const rij = offerteRij(o.id);
    gelijk([rij.status, rij.client_decision_by_name, rij.client_decision_by_email, rij.client_decision_note?.length],
      ['rejected', naam, 'inkoop@klant-anders.test', 4000], 'beslissing op de offerte');
    const ev = events(o.id, 'client_rejected');
    gelijk(ev.length, 1, 'weiger-events');
    gelijk(kies(ev[0].metadata, ['ip', 'userAgent', 'invitedEmail', 'emailMatchesInvitation']),
      { ip: '203.0.113.50', userAgent: BROWSER, invitedEmail: w.klantA.email, emailMatchesInvitation: false }, 'bewijs in het event');
  });

  await stap('na weigeren: geen akkoord en geen factuur; de pagina toont "afgewezen"', async () => {
    const { offerte: o, token } = nodig(geweigerdeOfferte, 'de verstuurde offerte');
    geweigerd(await publiek('acceptQuote', token, { name: 'Anna', email: w.klantA.email }), 'akkoord na weigeren', [409]);
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: o.id, kind: 'accept' }), 'akkoord via het portaal', [409]);
    geweigerd(await omzetten(w, o, w.medewerker), 'omzetten na weigeren');
    gelijk(aantalFacturen(o.id), 0, 'facturen');
    const pagina = gelukt(await publiek('getQuote', token), 'bekijken');
    gelijk(pagina.quote.status, 'rejected', 'status op de pagina');
    verwacht(pagina.events.some((e) => e.event_type === 'client_rejected'), 'de tijdlijn mist "afgewezen"');
  });

  await stap('verstuurd naar een ander adres dan dat van de klant: het bewijs noemt dat uitgenodigde adres', async () => {
    // De app vraagt bij versturen naar welk adres de offerte gaat. Het bewijs
    // moet het adres tonen waar de link écht heen ging, niet dat van de klant.
    const inkoop = `inkoop.${uniek('adres')}@klant-a.test`.toLowerCase();
    const t = await verstuurd(w, { verzending: { recipientEmail: inkoop, recipientName: 'Afdeling inkoop' } });
    gelijk(t.mail.to, [inkoop], 'ontvanger van de mail');
    gelukt(await publiek('acceptQuote', t.token, { name: 'Anna de Klant', email: w.klantA.email }), 'akkoord');
    const ev = events(t.offerte.id, 'client_accepted');
    gelijk(kies(ev[0]?.metadata, ['invitedEmail', 'emailMatchesInvitation']), { invitedEmail: inkoop, emailMatchesInvitation: false }, 'bewijs');
  });

  const grens = await stap('nog een offerte versturen', () => verstuurd(w));

  await stap('te lange of ontbrekende naam, e-mail of opmerking: nette 422 en niets veranderd', async () => {
    const { offerte: o, token } = nodig(grens, 'de verstuurde offerte');
    const goed = { name: 'Anna de Klant', email: w.klantA.email, note: 'Prima' };
    const fout = [
      ['een naam van 201 tekens', { name: 'A'.repeat(201) }],
      ['een e-mailadres van 255 tekens', { email: `${'a'.repeat(244)}@klant.test` }],
      ['een opmerking van 4001 tekens', { note: 'x'.repeat(4001) }],
      ['geen naam', { name: '   ' }],
      ['een ongeldig e-mailadres', { email: 'geen-adres' }],
    ];
    for (const actie of ['acceptQuote', 'rejectQuote']) {
      for (const [wat, velden] of fout) {
        geweigerd(await publiek(actie, token, { ...goed, ...velden }), `${actie} met ${wat}`, [422]);
      }
    }
    gelijk(offerteRij(o.id).status, 'sent', 'status');
    gelijk(events(o.id, 'client_accepted').length + events(o.id, 'client_rejected').length, 0, 'beslissingen');
  });

  await stap('een NUL-teken in naam, e-mail of opmerking: nette weigering, geen 500', async () => {
    const { offerte: o, token } = nodig(grens, 'de verstuurde offerte');
    // Een bezoeker zonder login kan dit sturen. Postgres kan \u0000 niet in
    // tekst opslaan; dat hoort een 4xx te zijn, geen serverfout in de log.
    const uitkomsten = [];
    for (const [wat, velden] of [['naam', { name: 'Anna\u0000' }], ['opmerking', { note: 'akkoord\u0000' }], ['e-mail', { email: `a\u0000${w.klantA.email}` }]]) {
      const res = await publiek('acceptQuote', token, { name: 'Anna', email: w.klantA.email, ...velden });
      uitkomsten.push(`${wat}: ${res.status}`);
    }
    gelijk(offerteRij(o.id).status, 'sent', 'status');
    verwacht(uitkomsten.every((u) => /: 4\d\d$/.test(u)), `verwacht een 4xx, kreeg ${uitkomsten.join(', ')}`);
  });

  await stap('akkoord en weigeren tegelijk: precies één beslissing telt', async () => {
    const { offerte: o, token } = nodig(grens, 'de verstuurde offerte');
    const [akkoord, weigering] = await Promise.all([
      publiek('acceptQuote', token, { name: 'Anna', email: w.klantA.email }),
      publiek('rejectQuote', token, { name: 'Bram', email: w.klantA.email }),
    ]);
    gelijk([akkoord.status, weigering.status].sort(), [200, 409], 'antwoorden');
    gelijk(offerteRij(o.id).status, akkoord.status === 200 ? 'accepted' : 'rejected', 'status volgt de beslissing die won');
    gelijk(events(o.id, 'client_accepted').length + events(o.id, 'client_rejected').length, 1, 'beslis-events');
  });
}

// ── 4. Intrekken ─────────────────────────────────────────────────────

async function intrekken(w, ander) {
  groep('Offertes — intrekken');
  const REDEN = `Interne reden ${uniek('intrek')}: prijs klopt niet meer`;
  const ingetrokken = await stap('offerte versturen', () => verstuurd(w));

  await stap('intrekken: kijker, boekhouder, lezer, lid zonder Financiën, andere organisatie en anoniem geweigerd', async () => {
    const { offerte: o } = nodig(ingetrokken, 'de verstuurde offerte');
    const args = { p_quote_id: o.id, p_organization_id: w.orgId, p_reason: 'test' };
    for (const [rol, gebruiker] of zonderSchrijfrecht(w)) geweigerd(await rpc('withdraw_quote', args, gebruiker.token), `intrekken als ${rol}`);
    geweigerd(await rpc('withdraw_quote', args, ander.eigenaar.token), 'andere organisatie, met het organisatie-id van de offerte');
    geweigerd(await rpc('withdraw_quote', { ...args, p_organization_id: ander.orgId }, ander.eigenaar.token), 'andere organisatie, met het eigen organisatie-id');
    geweigerd(await rpc('withdraw_quote', args), 'anoniem');
    gelijk(offerteRij(o.id).status, 'sent', 'status');
  });

  await stap('intrekken door een lid met schrijfrecht; de link verloopt uiterlijk over 30 dagen', async () => {
    const { offerte: o } = nodig(ingetrokken, 'de verstuurde offerte');
    gelukt(await rpc('withdraw_quote', { p_quote_id: o.id, p_organization_id: w.orgId, p_reason: REDEN }, w.medewerker.token), 'intrekken');
    const rij = offerteRij(o.id);
    gelijk(rij.status, 'cancelled', 'status');
    verwacht(new Date(rij.public_token_expires_at).getTime() <= Date.now() + 30 * 86_400_000 + 60_000, `de link verloopt pas ${rij.public_token_expires_at}`);
    gelijk(events(o.id, 'cancelled').length, 1, 'event');
  });

  await stap('na intrekken: geen akkoord of weigering via de link of het portaal', async () => {
    const { offerte: o, token } = nodig(ingetrokken, 'de verstuurde offerte');
    geweigerd(await publiek('acceptQuote', token, { name: 'Anna', email: w.klantA.email }), 'akkoord via de link', [409]);
    geweigerd(await publiek('rejectQuote', token, { name: 'Anna', email: w.klantA.email }), 'weigeren via de link', [409]);
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: o.id, kind: 'accept' }), 'akkoord via het portaal', [409]);
    gelijk(offerteRij(o.id).status, 'cancelled', 'status');
    gelijk(events(o.id, 'client_accepted').length, 0, 'akkoord-events');
  });

  await stap('de publieke pagina toont "ingetrokken", zonder de interne reden', async () => {
    const { token } = nodig(ingetrokken, 'de verstuurde offerte');
    const res = await publiek('getQuote', token);
    const data = gelukt(res, 'bekijken');
    gelijk(data.quote.status, 'cancelled', 'status op de pagina');
    verwacht(data.events.some((e) => e.event_type === 'cancelled' && e.title === 'Offerte ingetrokken'), 'de tijdlijn mist "ingetrokken"');
    verwacht(!res.tekst.includes(REDEN), 'de interne reden staat op de publieke pagina');
  });

  await stap('een ingetrokken offerte: niet nog eens in te trekken en niet te verwijderen', async () => {
    const { offerte: o } = nodig(ingetrokken, 'de verstuurde offerte');
    geweigerd(await rpc('withdraw_quote', { p_quote_id: o.id, p_organization_id: w.orgId }, w.medewerker.token), 'nog eens intrekken');
    geweigerd(await rest(`quotes?id=eq.${o.id}&select=id`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'verwijderen');
    verwacht(offerteRij(o.id), 'de ingetrokken offerte is verwijderd');
  });

  await stap('een goedgekeurde, nog niet verstuurde offerte intrekken: daarna niet meer te versturen', async () => {
    const o = await goedgekeurd(w);
    gelukt(await rpc('withdraw_quote', { p_quote_id: o.id, p_organization_id: w.orgId }, w.medewerker.token), 'intrekken');
    geweigerd(await versturen(w, o), 'versturen na intrekken', [409]);
    gelijk(mailsOver(o).length, 0, 'mails');
  });

  await stap('een geaccepteerde offerte is niet meer in te trekken', async () => {
    const t = await verstuurd(w);
    gelukt(await publiek('acceptQuote', t.token, { name: 'Anna', email: w.klantA.email }), 'akkoord');
    geweigerd(await rpc('withdraw_quote', { p_quote_id: t.offerte.id, p_organization_id: w.orgId }, w.medewerker.token), 'intrekken na akkoord');
    gelijk(offerteRij(t.offerte.id).status, 'accepted', 'status');
  });
}

// ── 5. Verlopen ──────────────────────────────────────────────────────

async function verlopen(w) {
  groep('Offertes — verlopen');

  // Twee dagen terug, niet één: de edge functions rekenen "vandaag" nog in UTC,
  // de database in Nederlandse tijd. Zo hangt de test niet af van het uur.
  const verlopenOfferte = await stap('offerte versturen en de geldigheid laten verlopen', async () => {
    const res = await verstuurd(w);
    zetGeldigTot(res.offerte.id, nlDatum(-2));
    return res;
  });

  await stap('verlopen: de pagina meldt verlopen (410), akkoord via link en portaal geweigerd, geen factuur', async () => {
    const { offerte: o, token } = nodig(verlopenOfferte, 'de verlopen offerte');
    geweigerd(await publiek('getQuote', token), 'bekijken', [410]);
    geweigerd(await publiek('acceptQuote', token, { name: 'Anna', email: w.klantA.email }), 'akkoord via de link', [409]);
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: o.id, kind: 'accept' }), 'akkoord via het portaal', [409]);
    geweigerd(await omzetten(w, o, w.medewerker), 'omzetten');
    gelijk(offerteRij(o.id).status, 'sent', 'status');
    gelijk(aantalFacturen(o.id), 0, 'facturen');
  });

  await stap('verlopen vóór versturen of goedkeuren: versturen en goedkeuren geweigerd', async () => {
    const klaar = await goedgekeurd(w);
    zetGeldigTot(klaar.id, nlDatum(-2));
    geweigerd(await versturen(w, klaar), 'versturen', [409]);
    gelijk(mailsOver(klaar).length, 0, 'mails');
    const ingediend = await concept(w);
    await indienen(w, ingediend);
    zetGeldigTot(ingediend.id, nlDatum(-2));
    geweigerd(await rpc('approve_quote_internal', { p_quote_id: ingediend.id, p_organization_id: w.orgId }, w.beheerder.token), 'goedkeuren');
    gelijk(offerteRij(ingediend.id).status, 'pending_internal_approval', 'status');
  });

  await stap('geldig tot en met vandaag (Nederlandse tijd): akkoord lukt op de laatste dag', async () => {
    const laatsteDag = await verstuurd(w, { geldigTot: nlDatum(0) });
    gelukt(await publiek('acceptQuote', laatsteDag.token, { name: 'Anna', email: w.klantA.email }), 'akkoord op de laatste dag');
  });

  await stap('verlopen link (termijn voorbij): bekijken 410, akkoord geweigerd', async () => {
    const res = await verstuurd(w);
    sql(`update public.quotes set public_token_expires_at = now() - interval '1 minute' where id = ${q(res.offerte.id)}`);
    geweigerd(await publiek('getQuote', res.token), 'bekijken', [410]);
    geweigerd(await publiek('acceptQuote', res.token, { name: 'Anna', email: w.klantA.email }), 'akkoord', [409]);
    gelijk(offerteRij(res.offerte.id).status, 'sent', 'status');
  });

  await stap('om 00:30 Nederlandse tijd geldt een offerte die gisteren verliep overal als verlopen: geen 500, geen akkoordknop', async () => {
    // Op Supabase draaien de edge functions in UTC: om 00:30 in Nederland is
    // het daar nog gisteren. De database rekent in Nederlandse tijd. Beide
    // moeten hetzelfde zeggen, anders krijgt de verzender een serverfout en de
    // klant een akkoordknop die "verlopen" antwoordt.
    const nacht = nlMoment(nlDatum(0), 0, 30);
    const klaar = await goedgekeurd(w);
    zetGeldigTot(klaar.id, nlDatum(-1));
    const versturing = await alsHetIs(nacht, () => versturen(w, klaar));
    const open = await verstuurd(w);
    zetGeldigTot(open.offerte.id, nlDatum(-1));
    const pagina = await alsHetIs(nacht, () => publiek('getQuote', open.token));
    const akkoord = await alsHetIs(nacht, () => publiek('acceptQuote', open.token, { name: 'Anna', email: w.klantA.email }));
    gelijk(mailsOver(klaar).length, 0, 'mails');
    gelijk([akkoord.status, offerteRij(open.offerte.id).status], [409, 'sent'], 'akkoord om 00:30');
    const fouten = [];
    if (versturing.status !== 409) fouten.push(`versturen gaf ${versturing.status} (${versturing.json?.error}) in plaats van 409 "verlopen"`);
    if (pagina.status !== 410) {
      fouten.push(`de pagina gaf ${pagina.status} met status "${pagina.json?.quote?.status}" (dus een akkoordknop), terwijl akkoord ${akkoord.status} "${akkoord.json?.error}" geeft`);
    }
    verwacht(fouten.length === 0, fouten.join('; '));
  });
}

// ── 6. Nummers ───────────────────────────────────────────────────────

async function nummers(w, ander) {
  groep('Offertes — nummers');
  const opslaan = (nummer, wereld = w, als = wereld.medewerker) => rest('quotes?select=id,number', {
    method: 'POST', token: als.token, prefer: 'return=representation',
    body: { organization_id: wereld.orgId, client_id: wereld.klantA.id, number: nummer, lines: REGELS },
  });
  const basis = await stap('concept met een nieuw nummer', () => concept(w, { nummer: uniek('OFF-UNIEK') }));

  await stap('hetzelfde nummer nog eens, ook met spaties of kleine letters: geweigerd (409)', async () => {
    const o = nodig(basis, 'het concept');
    for (const variant of [o.number, ` ${o.number.toLowerCase()} `, o.number.toLowerCase()]) {
      geweigerd(await opslaan(variant), `nummer "${variant}"`, [409]);
    }
    const ander = await concept(w);
    geweigerd(await rest(`quotes?id=eq.${ander.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { number: ` ${o.number.toLowerCase()}` },
    }), 'omnummeren naar een bezet nummer', [409]);
  });

  await stap('ook met een tab of harde spatie (plakken uit een PDF of spreadsheet): geen tweede offerte met hetzelfde nummer', async () => {
    const o = nodig(basis, 'het concept');
    const uitkomsten = [];
    for (const [wat, variant] of [['tab erachter', `${o.number}\t`], ['harde spatie erachter', `${o.number} `], ['harde spatie ervoor', ` ${o.number}`]]) {
      uitkomsten.push(`${wat}: ${(await opslaan(variant)).status}`);
    }
    verwacht(uitkomsten.every((u) => u.endsWith(': 409')), `verwacht 409, kreeg ${uitkomsten.join(', ')}`);
  });

  await stap('drie keer tegelijk hetzelfde nieuwe nummer: precies één slaagt', async () => {
    const nummer = uniek('OFF-TEGELIJK');
    const pogingen = await Promise.all([1, 2, 3].map(() => opslaan(nummer)));
    gelijk(pogingen.map((p) => p.status).sort(), [201, 409, 409], 'antwoorden');
    gelijk(Number(sql(`select count(*) from public.quotes where organization_id = ${q(w.orgId)} and upper(btrim(number)) = upper(${q(nummer)})`)), 1, 'offertes met dit nummer');
  });

  await stap('hetzelfde nummer in een andere organisatie mag', async () => {
    const o = nodig(basis, 'het concept');
    gelukt(await opslaan(o.number, ander), 'hetzelfde nummer elders');
  });
}

// ── 7. PDF-opslag en storingen ───────────────────────────────────────

async function pdfEnStoringen(w, ander, k) {
  groep('Offertes — PDF-opslag en storingen');

  await stap('downloaden geeft precies de verstuurde PDF, uit de private R2-opslag', async () => {
    const o = nodig(k?.offerte, 'de offerte uit de keten');
    const pdf = nodig(k?.pdf, 'de PDF uit de keten');
    const verzonden = versie(o.id, 'sent_to_client');
    gelijk([verzonden.pdf_storage_provider, verzonden.pdf_in_database], ['r2', false], 'opslag van de verzonden PDF');
    verwacht(String(verzonden.pdf_storage_key).startsWith(`${w.orgId}/quote-pdfs/${o.id}/`), `R2-sleutel ${verzonden.pdf_storage_key}`);
    gelijk(sha256(post.r2.get(verzonden.pdf_storage_key) ?? new Uint8Array()), sha256(pdf.bytes), 'PDF in R2');
    // Lezen mag iedereen die Financiën ziet, ook de kijker en de boekhouder.
    for (const [rol, gebruiker] of [['lid', w.medewerker], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['lezer', w.lezer]]) {
      const data = gelukt(await downloaden(w, o, { als: gebruiker }), `downloaden als ${rol}`);
      gelijk(sha256(Buffer.from(data.pdf.base64, 'base64')), sha256(pdf.bytes), `PDF voor ${rol}`);
      gelijk(data.pdf.fileName, pdf.naam, 'bestandsnaam');
    }
  });

  await stap('downloaden: lid zonder Financiën, andere organisatie en anoniem geweigerd; nooit verstuurd geeft 404', async () => {
    const o = nodig(k?.offerte, 'de offerte uit de keten');
    geweigerd(await downloaden(w, o, { als: w.zonderFinancien }), 'zonder Financiën', [403]);
    geweigerd(await downloaden(w, o, { als: ander.eigenaar }), 'andere organisatie, met het organisatie-id van de offerte', [403]);
    geweigerd(await downloaden(w, o, { als: ander.eigenaar, organizationId: ander.orgId }), 'andere organisatie, met het eigen organisatie-id', [404]);
    geweigerd(await downloaden(w, o, { als: null }), 'anoniem', [401]);
    geweigerd(await downloaden(w, await goedgekeurd(w)), 'nooit verstuurd', [404]);
  });

  await stap('R2 valt uit bij versturen: de PDF gaat naar de database en de offerte gaat toch de deur uit', async () => {
    const o = await goedgekeurd(w);
    post.r2Storing.aantal = 1;
    let res;
    try {
      res = await versturen(w, o);
    } finally {
      post.r2Storing.aantal = 0;
    }
    gelukt(res, 'versturen');
    const mail = mailsOver(o)[0];
    verwacht(mail, 'geen mail');
    const bijlage = mail.bijlagen.find((b) => b.naam.endsWith('.pdf'));
    const verzonden = versie(o.id, 'sent_to_client');
    gelijk([verzonden.pdf_storage_provider, verzonden.pdf_in_database], ['database', true], 'opslag van de verzonden PDF');
    const data = gelukt(await downloaden(w, o), 'downloaden');
    gelijk(sha256(Buffer.from(data.pdf.base64, 'base64')), sha256(bijlage.bytes), 'gedownloade PDF = bijlage');
  });

  await stap('R2 valt uit bij downloaden: nette fout (502 met uitleg), daarna lukt het weer', async () => {
    const o = nodig(k?.offerte, 'de offerte uit de keten');
    post.r2Storing.aantal = 1;
    let res;
    try {
      res = await downloaden(w, o);
    } finally {
      post.r2Storing.aantal = 0;
    }
    // 502: de opslag erachter faalt, niet het verzoek. Wel netjes: JSON met een uitleg.
    gelijk([res.status, res.json?.ok], [502, false], 'antwoord bij een storing');
    verwacht(/PDF/.test(res.json?.error ?? ''), `foutmelding: ${res.json?.error}`);
    gelukt(await downloaden(w, o), 'opnieuw downloaden');
  });

  for (const [soort, wat] of [['500', 'een foutantwoord'], ['netwerk', 'geen verbinding']]) {
    await stap(`Resend-storing (${wat}): nette fout, verzending op "failed", opnieuw versturen lukt`, async () => {
      const o = await goedgekeurd(w);
      Object.assign(post.resendStoring, { aantal: 1, soort });
      let res;
      try {
        res = await versturen(w, o);
      } finally {
        post.resendStoring.aantal = 0;
      }
      // 502: de mailprovider faalt, niet het verzoek. Wel netjes: JSON met een Nederlandse uitleg, geen kale 500.
      gelijk([res.status, res.json?.ok], [502, false], 'antwoord bij een storing');
      verwacht(/Resend/.test(res.json?.error ?? ''), `foutmelding: ${res.json?.error}`);
      gelijk(mailsOver(o).length, 0, 'mails');
      const rij = offerteRij(o.id);
      gelijk([rij.status, rij.last_email_delivery_status, rij.sent_at], ['internally_approved', 'failed', null], 'offerte na de storing');
      const verzending = laatsteVerzending(o.id);
      gelijk(verzending.status, 'failed', 'verzendregel');
      verwacht(verzending.error_message, 'geen foutmelding in de verzendregel');
      gelijk(events(o.id, 'email_failed').length, 1, 'event "mislukt"');
      gelukt(await versturen(w, o), 'opnieuw versturen');
      gelijk(mailsOver(o).length, 1, 'mails na opnieuw versturen');
      gelijk(offerteRij(o.id).status, 'sent', 'status na opnieuw versturen');
      gelukt(await publiek('getQuote', linkUit(mailsOver(o)[0])), 'de link uit de mail werkt');
    });
  }

  await stap('dubbelklik op versturen: één mail, en de tweede poging netjes geweigerd (geen 500)', async () => {
    const o = await goedgekeurd(w);
    const [a, b] = await Promise.all([versturen(w, o), versturen(w, o)]);
    gelijk(mailsOver(o).length, 1, 'mails');
    gelijk(offerteRij(o.id).status, 'sent', 'status');
    gelijk(Number(sql(`select count(*) from public.quote_email_deliveries where quote_id = ${q(o.id)} and status = 'sent'`)), 1, 'verzonden verzendregels');
    const [eerste, tweede] = [a.status, b.status].sort();
    const andere = a.status === 200 ? b : a;
    verwacht(eerste === 200 && tweede >= 400 && tweede < 500, `verwacht 200 en een 4xx, kreeg ${a.status} en ${b.status}: ${andere.tekst.slice(0, 200)}`);
  });
}

// ── 8. Klantportaal ──────────────────────────────────────────────────

async function klantportaal(w) {
  groep('Offertes — klantportaal');

  const stukken = await stap('offertes versturen aan klant A en klant B, en een concept voor A', async () => ({
    voorA: await verstuurd(w), voorB: await verstuurd(w, { klant: w.klantB }), concept: await concept(w),
  }));

  await stap('A ziet in het portaal alleen eigen, verstuurde offertes, zonder interne velden', async () => {
    const { voorA, voorB, concept: c } = nodig(stukken, 'de offertes');
    const data = gelukt(await portaal(w.portaalA, { action: 'getPortalData' }), 'portaal van A');
    gelijk(data.accounts.map((account) => account.id), [w.klantA.id], 'klantdossiers van A');
    const offertesA = data.accounts[0].quotes;
    const ids = offertesA.map((x) => x.id);
    verwacht(ids.includes(voorA.offerte.id), 'de verstuurde offerte van A ontbreekt');
    verwacht(!ids.includes(voorB.offerte.id), 'A ziet de offerte van B');
    verwacht(!ids.includes(c.id), 'A ziet een concept');
    for (const offerte of offertesA) gelijk(Object.keys(offerte).sort(), VELDEN_PORTAAL, `velden van ${offerte.number}`);
    const eigen = offertesA.find((x) => x.id === voorA.offerte.id);
    gelijk([eigen.status, totalen(eigen.lines).totaal], ['sent', TOTAAL_REGELS], 'de offerte in het portaal');
  });

  await stap('B ziet de offerte van A niet en kan er niet over beslissen', async () => {
    const { voorA, voorB } = nodig(stukken, 'de offertes');
    const data = gelukt(await portaal(w.portaalB, { action: 'getPortalData' }), 'portaal van B');
    const ids = data.accounts.flatMap((account) => account.quotes.map((x) => x.id));
    verwacht(!ids.includes(voorA.offerte.id), 'B ziet de offerte van A');
    verwacht(ids.includes(voorB.offerte.id), 'B mist zijn eigen offerte (klopt de test nog?)');
    for (const kind of ['accept', 'reject']) {
      geweigerd(await portaal(w.portaalB, { action: 'decideQuote', quoteId: voorA.offerte.id, kind }), `${kind} door B`);
    }
    gelijk(offerteRij(voorA.offerte.id).status, 'sent', 'status');
  });

  await stap('A geeft akkoord in het portaal: vastgelegd met de login van A', async () => {
    const { voorA } = nodig(stukken, 'de offertes');
    const o = voorA.offerte;
    const res = gelukt(await portaal(w.portaalA, { action: 'decideQuote', quoteId: o.id, kind: 'accept', note: 'Akkoord via het portaal' }), 'akkoord');
    gelijk(res.quote.status, 'accepted', 'status in het antwoord');
    const rij = offerteRij(o.id);
    gelijk([rij.status, rij.client_decision_by_email, rij.client_decision_note], ['accepted', w.portaalA.email, 'Akkoord via het portaal'], 'beslissing');
    const ev = events(o.id, 'client_accepted');
    gelijk([ev.length, ev[0]?.metadata?.source], [1, 'client_portal'], 'akkoord-event');
    verwacht(versie(o.id, 'client_accepted'), 'geen versie bij akkoord');
  });

  await stap('portaal: een concept, een onbekende beslissing, een te lange opmerking en anoniem netjes geweigerd', async () => {
    const { voorA, concept: c } = nodig(stukken, 'de offertes');
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: c.id, kind: 'accept' }), 'beslissen over een concept', [404]);
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: voorA.offerte.id, kind: 'misschien' }), 'onbekende beslissing', [400]);
    geweigerd(await portaal(w.portaalA, { action: 'decideQuote', quoteId: voorA.offerte.id, kind: 'reject', note: 'x'.repeat(2001) }), 'opmerking van 2001 tekens', [400]);
    geweigerd(await portaal(null, { action: 'getPortalData' }), 'anoniem', [401]);
    gelijk(offerteRij(c.id).status, 'draft', 'het concept');
  });

  await stap('portaal: een NUL-teken in de opmerking geeft een nette weigering, geen 500', async () => {
    const t = await verstuurd(w);
    const res = await portaal(w.portaalA, { action: 'decideQuote', quoteId: t.offerte.id, kind: 'reject', note: 'liever niet\u0000' });
    gelijk(offerteRij(t.offerte.id).status, 'sent', 'status');
    geweigerd(res, 'NUL-teken in de opmerking');
  });

  const verhuisd = await stap('offerte van A op een project van A versturen; daarna gaat het project naar B', async () => {
    const project = gelukt(await rest('projects?select=id,client_id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, name: uniek('Project verhuis') },
    }), 'project voor A')[0];
    const t = await verstuurd(w, { project });
    // Een gewone projectwijziging, ook zonder rechten op Financiën.
    const verplaatst = gelukt(await rest(`projects?id=eq.${project.id}&select=id,client_id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { client_id: w.klantB.id },
    }), 'project naar B');
    gelijk(verplaatst[0]?.client_id, w.klantB.id, 'het project hoort nu bij B');
    return { ...t, project };
  });

  await stap('na de projectwissel: B ziet de offerte van A niet en kan niet beslissen; A wel', async () => {
    const { offerte: o, project } = nodig(verhuisd, 'de offerte op het verhuisde project');
    const dataB = gelukt(await portaal(w.portaalB, { action: 'getPortalData' }), 'portaal van B');
    const accountB = dataB.accounts.find((account) => account.id === w.klantB.id);
    verwacht(accountB?.projects.some((p) => p.id === project.id), 'het verhuisde project staat niet bij B (klopt de test nog?)');
    verwacht(!accountB.quotes.some((x) => x.id === o.id), 'B ziet de offerte van A via het project');
    for (const kind of ['accept', 'reject']) {
      geweigerd(await portaal(w.portaalB, { action: 'decideQuote', quoteId: o.id, kind }), `${kind} door B`);
    }
    gelijk(offerteRij(o.id).status, 'sent', 'status na de pogingen van B');
    const dataA = gelukt(await portaal(w.portaalA, { action: 'getPortalData' }), 'portaal van A');
    verwacht(dataA.accounts[0]?.quotes.some((x) => x.id === o.id), 'A ziet zijn eigen offerte niet meer');
    gelukt(await portaal(w.portaalA, { action: 'decideQuote', quoteId: o.id, kind: 'reject', note: 'Toch niet' }), 'weigeren door A');
    gelijk(offerteRij(o.id).status, 'rejected', 'status na de beslissing van A');
  });
}

// ── 9. Een andere organisatie ────────────────────────────────────────

async function andereOrganisatie(w, ander) {
  groep('Offertes — een andere organisatie');

  const doel = await stap('in de eigen organisatie: een goedgekeurde, een verstuurde en een geaccepteerde offerte', async () => {
    const klaar = await goedgekeurd(w);
    const weg = await verstuurd(w);
    const akkoord = await verstuurd(w);
    gelukt(await publiek('acceptQuote', akkoord.token, { name: 'Anna', email: w.klantA.email }), 'akkoord');
    return { goedgekeurd: klaar, verstuurd: weg.offerte, geaccepteerd: akkoord.offerte };
  });

  await stap('een eigenaar elders kan ze niet versturen, downloaden, intrekken, afwijzen of omzetten (met welk organisatie-id ook)', async () => {
    const d = nodig(doel, 'de offertes');
    for (const [orgId, met] of [[w.orgId, 'met het organisatie-id van de offerte'], [ander.orgId, 'met het eigen organisatie-id']]) {
      geweigerd(await versturen(w, d.goedgekeurd, { als: ander.eigenaar, organizationId: orgId }), `versturen ${met}`);
      geweigerd(await downloaden(w, d.verstuurd, { als: ander.eigenaar, organizationId: orgId }), `downloaden ${met}`);
      geweigerd(await rpc('withdraw_quote', { p_quote_id: d.verstuurd.id, p_organization_id: orgId }, ander.eigenaar.token), `intrekken ${met}`);
      geweigerd(await rpc('reject_quote_internal', { p_quote_id: d.goedgekeurd.id, p_organization_id: orgId }, ander.eigenaar.token), `intern afwijzen ${met}`);
      geweigerd(await omzetten(w, d.geaccepteerd, ander.eigenaar, orgId), `omzetten ${met}`);
    }
    gelijk([offerteRij(d.goedgekeurd.id).status, offerteRij(d.verstuurd.id).status, offerteRij(d.geaccepteerd.id).status],
      ['internally_approved', 'sent', 'accepted'], 'statussen');
    gelijk(mailsOver(d.goedgekeurd).length, 0, 'mails');
    gelijk(aantalFacturen(d.geaccepteerd.id), 0, 'facturen');
  });

  await stap('via PostgREST ziet, wijzigt en wist een andere organisatie niets, en zet er niets bij', async () => {
    const d = nodig(doel, 'de offertes');
    const lees = (pad) => rest(pad, { token: ander.eigenaar.token });
    gelijk(gelukt(await lees(`quotes?id=in.(${d.goedgekeurd.id},${d.verstuurd.id},${d.geaccepteerd.id})&select=id`), 'offertes lezen'), [], 'zichtbare offertes');
    for (const tabel of ['quote_versions', 'quote_email_deliveries', 'quote_approval_events']) {
      gelijk(gelukt(await lees(`${tabel}?quote_id=eq.${d.verstuurd.id}&select=id`), tabel), [], `zichtbare ${tabel}`);
    }
    const c = await concept(w);
    nietsVeranderd(await rest(`quotes?id=eq.${c.id}&select=id`, {
      method: 'PATCH', token: ander.eigenaar.token, prefer: 'return=representation', body: { notes: 'overgenomen' },
    }), 'een concept wijzigen');
    nietsVeranderd(await rest(`quotes?id=eq.${c.id}&select=id`, { method: 'DELETE', token: ander.eigenaar.token, prefer: 'return=representation' }), 'een concept wissen');
    gelijk(offerteRij(c.id)?.notes, c.notes, 'het concept is ongewijzigd');
    geweigerd(await rest('quotes?select=id', {
      method: 'POST', token: ander.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, number: uniek('OFF-INDRINGER'), lines: REGELS },
    }), 'een offerte in deze organisatie zetten');
    geweigerd(await rest('quotes?select=id', {
      method: 'POST', token: ander.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: ander.orgId, client_id: w.klantA.id, number: uniek('OFF-KLANT-ELDERS'), lines: REGELS },
    }), 'een eigen offerte voor de klant van deze organisatie');
  });
}

// ── 10. De publieke functie weigert netjes ───────────────────────────

async function publiekeFunctie(w, k) {
  groep('Offertes — publieke functie en workflow weigeren netjes');

  await stap('onbekende, te korte of ontbrekende token en kapotte JSON: 4xx, geen 5xx', async () => {
    const nep = randomBytes(32).toString('base64url');
    geweigerd(await publiek('getQuote', nep), 'onbekende token bekijken', [404]);
    geweigerd(await publiek('acceptQuote', nep, { name: 'X', email: 'x@klant.test' }), 'onbekende token akkoord', [409]);
    geweigerd(await publiek('rejectQuote', nep, { name: 'X', email: 'x@klant.test' }), 'onbekende token weigeren', [409]);
    geweigerd(await publiek('getQuote', 'te-kort'), 'te korte token', [400]);
    geweigerd(await publiek('getQuote', ''), 'zonder token', [400]);
    geweigerd(await roep('quote-public', { body: '{kapot', ruw: true, headers: { 'content-type': 'application/json' } }), 'kapotte JSON', [400]);
  });

  await stap('publieke functie: origin "null", een vreemde site of geen origin 403; GET 405; onbekende actie 400', async () => {
    const { token } = nodig(k?.verzending, 'de token uit de keten');
    geweigerd(await roep('quote-public', { body: { action: 'getQuote', token }, origin: 'null' }), 'origin "null"', [403]);
    geweigerd(await roep('quote-public', { body: { action: 'getQuote', token }, origin: 'https://boef.example' }), 'vreemde origin', [403]);
    geweigerd(await roep('quote-public', { body: { action: 'getQuote', token }, origin: '' }), 'zonder origin', [403]);
    geweigerd(await roep('quote-public', { method: 'GET' }), 'GET', [405]);
    geweigerd(await publiek('deleteQuote', token), 'onbekende actie', [400]);
  });

  await stap('workflow: origin "null" of vreemd 403, ongeldige sessie 401, kapotte id\'s 400, onbekende actie 400, GET 405', async () => {
    const o = nodig(k?.offerte, 'de offerte uit de keten');
    const body = { action: 'downloadQuotePdf', organizationId: w.orgId, quoteId: o.id };
    geweigerd(await roep('quote-workflow', { token: w.medewerker.token, body, origin: 'null' }), 'origin "null"', [403]);
    geweigerd(await roep('quote-workflow', { token: w.medewerker.token, body, origin: 'https://boef.example' }), 'vreemde origin', [403]);
    geweigerd(await roep('quote-workflow', { token: 'geen.echte.sessie', body }), 'ongeldige sessie', [401]);
    geweigerd(await roep('quote-workflow', { token: w.medewerker.token, body: { ...body, organizationId: 'kapot' } }), 'ongeldig organisatie-id', [400]);
    geweigerd(await roep('quote-workflow', { token: w.medewerker.token, body: { ...body, quoteId: 'kapot' } }), 'ongeldig offerte-id', [400]);
    geweigerd(await roep('quote-workflow', { token: w.medewerker.token, body: { ...body, action: 'deleteQuote' } }), 'onbekende actie', [400]);
    geweigerd(await roep('quote-workflow', { token: w.medewerker.token, method: 'GET' }), 'GET', [405]);
  });
}

// ── 11. Modulerechten in de vastgelegde versies ──────────────────────

async function modulerechtenInVersies(w) {
  groep('Offertes — modulerechten in de vastgelegde versies');
  // Harde regel 3: kan een teamlid een module niet lezen, dan geeft de database
  // niets terug. De boekhouder (gast) ziet alleen Financiën; klanten en
  // projecten zijn voor hem dicht. Een offerteversie bewaart een momentopname
  // van de klant en het project; die mag niet meer verraden dan de offerte zelf.

  const opzet = await stap('klant met een interne CRM-notitie, project met interne omschrijving en tarief, offerte goedgekeurd', async () => {
    const notitie = `INTERN-CRM ${uniek('notitie')}: wil korting, twijfelt over verlenging`;
    const omschrijving = `INTERN-PROJECT ${uniek('marge')}: marge 45%, uurtarief niet noemen`;
    gelukt(await rest(`clients?id=eq.${w.klantB.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { notes: notitie, value_eur: 25000 },
    }), 'klantnotitie');
    const project = gelukt(await rest('projects?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantB.id, name: uniek('Project marge'), description: omschrijving, hourly_rate_cents: 9500, budgeted_minutes: 6000 },
    }), 'project')[0];
    const offerte = await goedgekeurd(w, { klant: w.klantB, project });
    return { notitie, omschrijving, project, offerte };
  });

  await stap('de boekhouder kan klanten en projecten niet lezen', async () => {
    const { project } = nodig(opzet, 'de opzet');
    gelijk(gelukt(await rest(`clients?id=eq.${w.klantB.id}&select=id,notes`, { token: w.boekhouder.token }), 'klanten'), [], 'klanten voor de boekhouder');
    gelijk(gelukt(await rest(`projects?id=eq.${project.id}&select=id,description`, { token: w.boekhouder.token }), 'projecten'), [], 'projecten voor de boekhouder');
  });

  await stap('…en leest de interne klant- en projectgegevens ook niet via de offerteversie', async () => {
    const { offerte, notitie, omschrijving } = nodig(opzet, 'de opzet');
    const res = await rest(`quote_versions?quote_id=eq.${offerte.id}&select=snapshot_data`, { token: w.boekhouder.token });
    gelukt(res, 'versies lezen');
    verwacht(res.json.length > 0, 'de boekhouder ziet geen versie (klopt de test nog?)');
    const lekken = [];
    if (res.tekst.includes(notitie)) lekken.push('de interne klantnotitie (clients.notes)');
    if (/"value_eur":\s*25000/.test(res.tekst)) lekken.push('de klantwaarde (clients.value_eur)');
    if (res.tekst.includes(omschrijving)) lekken.push('de projectomschrijving (projects.description)');
    if (/"hourly_rate_cents":\s*9500/.test(res.tekst)) lekken.push('het uurtarief (projects.hourly_rate_cents)');
    verwacht(lekken.length === 0, `de boekhouder leest via quote_versions.snapshot_data: ${lekken.join(', ')}`);
  });
}

// ── 12. Kleineondernemersregeling ────────────────────────────────────

async function kleineondernemersregeling() {
  groep('Offertes — kleineondernemersregeling (KOR)');
  // Met de KOR rekent een factuur geen btw: de database en invoice-workflow
  // weigeren een factuur met btw (enforce_invoice_kor_no_vat). Een offerte
  // wordt na akkoord één op één een factuur; de keten moet dus ergens kloppen:
  // óf de offerte met btw gaat niet de deur uit, óf de factuur die eruit komt
  // is te versturen.
  const kw = await stap('wereld met de KOR aan', () => maakWereld('offertes-kor', { kor: true }));
  if (!kw) return;

  await stap('KOR: een offerte met btw loopt niet vast na akkoord (niet versturen, of een factuur die wél te versturen is)', async () => {
    const o = await goedgekeurd(kw);
    const res = await versturen(kw, o);
    if (res.status !== 200) {
      geweigerd(res, 'versturen van een offerte met btw onder de KOR');
      return;
    }
    const token = linkUit(mailsOver(o)[0]);
    gelukt(await publiek('acceptQuote', token, { name: 'Klant', email: kw.klantA.email }), 'akkoord');
    const factuur = eersteRij(gelukt(await omzetten(kw, o, kw.medewerker), 'omzetten'));
    const verzenden = await roep('invoice-workflow', {
      token: kw.medewerker.token, body: { action: 'sendInvoiceEmail', organizationId: kw.orgId, invoiceId: factuur.id },
    });
    verwacht(verzenden.status === 200 && verzenden.json?.ok === true,
      `de offerte met 21% en 9% btw ging naar de klant en werd geaccepteerd (€ ${bedrag(factuur.total_amount)}), maar de factuur `
      + `${factuur.number} daaruit is niet te versturen: ${verzenden.status} ${verzenden.json?.error ?? verzenden.tekst.slice(0, 200)}`);
  });
}
