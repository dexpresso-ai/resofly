// Contracten (e-ondertekening) van concept tot getekend PDF in het portaal,
// met de echte edge functions (contract-workflow, contract-public,
// client-portal) tegen de lokale stack.
//
// Waarom zo uitgebreid: een getekend contract is bewijs. Wat de klant per mail
// kreeg, op de pagina zag en tekende moet aantoonbaar hetzelfde zijn, de
// handtekening moet onder de vaste akkoordtekst staan, en niemand anders dan de
// klant met de link mag tekenen: niet de verzender, geen collega zonder
// rechten, geen andere organisatie. Elk onderdeel maakt zijn eigen contract,
// zodat een fout in het ene de rest niet meetrekt.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { roep } from './functies.mjs';
import { mailsAan, post } from './nepdiensten.mjs';
import { DB_URL, PUBLIEK } from './omgeving.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

// ── Vaste gegevens ──────────────────────────────────────────────────────

/**
 * De akkoordtekst zoals de ondertekenpagina hem meestuurt. Uit de bron van de
 * pagina gelezen (niet overgetikt): zo tekent deze test precies zoals een klant,
 * en valt hij om als pagina en server ooit uit elkaar lopen.
 */
const AKKOORD = (() => {
  const bron = readFileSync(new URL('../../src/lib/contractTokens.ts', import.meta.url), 'utf8');
  const m = bron.match(/export const CONTRACT_CONSENT_TEXT\s*=\s*'([^']+)'/);
  if (!m) throw new Error('tests/stromen: CONTRACT_CONSENT_TEXT niet gevonden in src/lib/contractTokens.ts');
  return m[1];
})();

const UA = 'Mozilla/5.0 (StromenTest; contracten) AppleWebKit/605.1.15 Safari/605.1.15';
const IP = '198.51.100.23';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Alles wat de editor maakt en wat eerder uit de PDF verdween: <div>-regels
// (na Enter), losse tekst, h1/h5, een tabel, een geneste lijst met een item
// erna, en namen buiten Latin-1. Plus wat er nooit bij de klant mag komen:
// een script, een event-handler en een javascript:-link.
const RIJKE_INHOUD = [
  '<h2>Artikel 1 – Onderwerp</h2>',
  '<div>De prijs is € 1.000 per maand, te betalen vóór de eerste.</div>',
  '<div>Opdrachtgever: {{klantnaam}}, t.a.v. {{contactpersoon}}.</div>',
  '<p>Totaalbedrag: {{bedrag}}{{onbekend}}.</p>',
  'Losse tekst zonder blok.',
  '<h1>Hoofdstuk Één</h1>',
  '<h5>Kleine kop vijf</h5>',
  '<table><thead><tr><th>Dienst</th><th>Prijs</th></tr></thead>',
  '<tbody><tr><td>Hosting</td><td>€ 50</td></tr><tr><td>Onderhoud</td><td>€ 75</td></tr></tbody></table>',
  '<ul><li>Punt een<ul><li>Genest punt</li></ul></li><li>Punt na geneste lijst</li></ul>',
  '<ol><li>Eerste stap</li><li>Tweede stap</li></ol>',
  '<blockquote>Een citaat van Łukasz Dvořák.</blockquote>',
  '<p>Getekend namens Łukasz Dvořák en Zoë Brontë; boete ≤ € 500.</p>',
  '<p>Zie <a href="javascript:alert(1)">deze link</a>.<img src="x" onerror="alert(2)"></p><script>alert(3)</script>',
].join('');

/** Wat er na het omzetten (WinAnsi, € → EUR, Ł → L) in de PDF moet staan. */
function verwachtInPdf(w) {
  return [
    'Artikel 1 - Onderwerp',
    'De prijs is EUR 1.000 per maand, te betalen vóór de eerste.',
    `Opdrachtgever: ${w.klantA.name}, t.a.v. Lukasz Dvorák.`,
    'Totaalbedrag: EUR 1.250,00.',
    'Losse tekst zonder blok.',
    'Hoofdstuk Één',
    'Kleine kop vijf',
    'Dienst | Prijs',
    'Hosting | EUR 50',
    'Onderhoud | EUR 75',
    '- Punt een',
    '- Genest punt',
    '- Punt na geneste lijst',
    '1. Eerste stap',
    '2. Tweede stap',
    'Een citaat van Lukasz Dvorák.',
    'Getekend namens Lukasz Dvorák en Zoë Brontë; boete <= EUR 500.',
    'Zie deze link.',
  ];
}
const NOOIT_IN_PDF = ['alert', '{{', 'onbekend', 'javascript'];

// ── Hulpjes ─────────────────────────────────────────────────────────────

const q = (waarde) => `'${String(waarde).replace(/'/g, "''")}'`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plat = (tekst) => String(tekst).replace(/\s+/g, ' ').trim();
const uitBase64 = (b64) => new Uint8Array(Buffer.from(String(b64 || ''), 'base64'));

/** Een datum in Nederland, `dagen` vanaf vandaag (JJJJ-MM-DD). */
function datum(dagen = 0) {
  return new Date(Date.now() + dagen * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}

/** Een concept opslaan zoals ContractForm in het scherm (PostgREST, met RLS). */
async function nieuwContract(w, velden = {}, gebruiker = w.medewerker) {
  const res = await rest('contracts?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, client_id: w.klantA.id, quote_id: null,
      title: 'Onderhoudsovereenkomst', date: datum(0), valid_until: datum(30),
      amount_cents: 125000, currency: 'EUR', body: '<p>Standaard contracttekst.</p>',
      ...velden,
    },
  });
  gelukt(res, 'contract opslaan');
  return res.json[0];
}

function verstuur(w, contractId, extra = {}, gebruiker = w.medewerker) {
  return roep('contract-workflow', {
    token: gebruiker.token,
    body: { action: 'sendContractForSignature', organizationId: w.orgId, contractId, ...extra },
  });
}

function workflow(gebruiker, body) {
  return roep('contract-workflow', { token: gebruiker?.token, body });
}

/** Alle mails over één contract (de functies zetten contract_id als tag). */
function mailsVoor(contractId, templateKey) {
  return post.mails.filter((mail) =>
    mail.tags.some((t) => t.name === 'contract_id' && t.value === contractId)
    && (!templateKey || mail.tags.some((t) => t.name === 'template_key' && t.value === templateKey)));
}

function linkUit(mail) {
  const m = `${mail.html} ${mail.text}`.match(/\/contract\/([A-Za-z0-9_-]{20,})/);
  verwacht(m, 'geen ondertekenlink in de mail');
  return m[1];
}

function pdfBijlage(mail) {
  const bijlage = mail.bijlagen.find((b) => b.naam.toLowerCase().endsWith('.pdf'));
  verwacht(bijlage, `geen PDF-bijlage in "${mail.subject}"`);
  gelijk(Buffer.from(bijlage.bytes.subarray(0, 5)).toString('latin1'), '%PDF-', 'kop van de PDF-bijlage');
  return bijlage;
}

/** Verstuurt en geeft de token uit de (enige nieuwe) mail terug. */
async function verstuurEnLink(w, contractId, extra = {}, gebruiker = w.medewerker) {
  const voor = mailsVoor(contractId, 'contract_sent').length;
  const res = await verstuur(w, contractId, extra, gebruiker);
  const json = gelukt(res, 'versturen');
  const mails = mailsVoor(contractId, 'contract_sent');
  gelijk(mails.length, voor + 1, 'aantal verstuurmails');
  return { json, mail: mails.at(-1), token: linkUit(mails.at(-1)) };
}

function publiek(body, opties = {}) {
  return roep('contract-public', { body, ...opties });
}
const bekijk = (token) => publiek({ action: 'getContract', token });

/**
 * Een vraag via de publieke pagina. Op de lokale stack sloot de gateway (Kong)
 * hier af en toe de verbinding met PostgREST voordat er antwoord was (502
 * "upstream prematurely closed connection"; ± 1 op 30 via de edge function,
 * 0 op 600 rechtstreekse aanroepen). De vraag is dan niet opgeslagen en de
 * functie geeft een 500. Eén zichtbare herhaling houdt die ruis buiten de
 * uitslag; een echte fout in deze route faalt ook de tweede keer.
 */
async function vraagStellen(token, velden) {
  const body = { action: 'askQuestion', token, ...velden };
  const res = await publiek(body);
  if (res.status < 500) return res;
  console.log(`  let op  vraag opnieuw gesteld na een ${res.status} (${res.json?.error ?? res.tekst.slice(0, 80)})`);
  return publiek(body);
}

/** Tekenen zoals PublicContractPage.sign(): met UA en IP, getypt tenzij anders. */
function teken(token, velden = {}) {
  const { headers = {}, ip = IP, ...rest } = velden;
  return publiek({
    action: 'signContract', token, signerName: 'Contact Klant', signerEmail: 'contact@klant.test',
    signatureMethod: 'typed', signatureImage: '', consentText: AKKOORD, versionId: null, ...rest,
  }, { headers: { 'user-agent': UA, ...headers }, ip });
}

/** Zoals de pagina: eerst laden (dat levert de versie), dan tekenen. */
async function tekenZoalsDePagina(token, velden = {}) {
  const pagina = await bekijk(token);
  if (pagina.status !== 200) return pagina;
  return teken(token, { versionId: pagina.json?.contract?.version_id ?? null, ...velden });
}

const contractRij = (id) => sqlRij(`select * from public.contracts where id = ${q(id)}`);
const ondertekenaars = (id) => sqlRijen(`select * from public.contract_signers where contract_id = ${q(id)} order by signing_order, created_at`);
const versies = (id) => sqlRijen(`select id, version_number, snapshot_reason, title, body, pdf_storage_key, pdf_sha256, pdf_size_bytes
  from public.contract_versions where contract_id = ${q(id)} order by version_number`);
const gebeurtenissen = (id) => sqlRijen(`select event_type, title, description, metadata from public.contract_events
  where contract_id = ${q(id)} order by created_at, id`);
const verzendingen = (id) => sqlRijen(`select status, recipient_email, recipient_name, provider_email_id, error_message
  from public.contract_email_deliveries where contract_id = ${q(id)} order by created_at`);

/** Staat de (platte) token ergens in de rijen van dit contract? Alleen de hash hoort er te staan. */
function tokenInDatabase(contractId, token) {
  return sqlRij(`select count(*)::int as n from (
      select to_jsonb(t)::text as x from public.contracts t where t.id = ${q(contractId)}
      union all select to_jsonb(t)::text from public.contract_events t where t.contract_id = ${q(contractId)}
      union all select to_jsonb(t)::text from public.contract_email_deliveries t where t.contract_id = ${q(contractId)}
      union all select to_jsonb(t)::text from public.contract_versions t where t.contract_id = ${q(contractId)}
      union all select to_jsonb(t)::text from public.contract_signers t where t.contract_id = ${q(contractId)}
    ) z where position(${q(token)} in x) > 0`).n;
}

/** Een contract dat nog gewoon op de handtekening wacht (niets is veranderd). */
function wachtNogOpHandtekening(contractId, melding) {
  gelijk(contractRij(contractId).status, 'sent', `${melding}: status`);
  const [s] = ondertekenaars(contractId);
  gelijk([s?.status, s?.signed_at ?? null, s?.consent_text ?? null], ['pending', null, null], `${melding}: ondertekenaar`);
}

/**
 * De tekst per pagina, zoals pdf-lib hem schreef: Helvetica met WinAnsi, één
 * hex-string per regel (`<…> Tj`). Genoeg om te zien wat een lezer ziet.
 */
async function pdfPaginas(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const lees = (obj) => (obj instanceof PDFRef ? doc.context.lookup(obj) : obj);
  return doc.getPages().map((pagina) => {
    const inhoud = lees(pagina.node.get(PDFName.of('Contents')));
    const stromen = (inhoud instanceof PDFArray ? inhoud.asArray().map(lees) : [inhoud]).filter(Boolean);
    const ruw = stromen.map((s) => Buffer.from(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()).toString('latin1')).join('\n');
    return [...ruw.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)]
      .map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'hex').toString('latin1'))
      .join('\n');
  });
}

async function heeftAfbeelding(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.context.enumerateIndirectObjects()
    .some(([, obj]) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
}

function bevatAlles(tekst, fragmenten, melding) {
  const vlak = plat(tekst);
  const mist = fragmenten.filter((f) => !vlak.includes(plat(f)));
  verwacht(mist.length === 0, `${melding}: ontbreekt ${JSON.stringify(mist)}`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Een echte PNG met een schuine streep, zoals het tekenveld er een maakt (toDataURL). */
function pngHandtekening(breedte = 160, hoogte = 48) {
  const rijen = Buffer.alloc((breedte + 1) * hoogte, 255);
  for (let y = 0; y < hoogte; y += 1) {
    rijen[y * (breedte + 1)] = 0; // filter "none" per rij
    const x = Math.round((y / hoogte) * (breedte - 4));
    for (let d = 0; d < 4; d += 1) rijen[y * (breedte + 1) + 1 + x + d] = 0;
  }
  const stuk = (type, data) => {
    const lengte = Buffer.alloc(4); lengte.writeUInt32BE(data.length);
    const inhoud = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const controle = Buffer.alloc(4); controle.writeUInt32BE(crc32(inhoud));
    return Buffer.concat([lengte, inhoud, controle]);
  };
  const kop = Buffer.alloc(13);
  kop.writeUInt32BE(breedte, 0); kop.writeUInt32BE(hoogte, 4); kop[8] = 8; // 8 bit grijs
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    stuk('IHDR', kop), stuk('IDAT', deflateSync(rijen)), stuk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Onderschept uitgaande aanroepen van de edge functions (Resend, de
 * media-worker) zolang `fn` loopt: `bijAanroep(url)` draait vóór de aanroep
 * doorgaat. Zo kun je zien wat er op dat moment in de database staat, of op
 * precies dat moment iets anders laten gebeuren. Daarna is fetch weer zoals de
 * harnas hem zette. (Database-aanroepen van supabase-js lopen hier niet langs.)
 */
async function metOnderschepping(patroon, bijAanroep, fn) {
  const vorige = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Gooit bijAanroep, dan faalt deze aanroep zoals bij een netwerkfout.
    if (patroon.test(url)) await bijAanroep(url, new Request(input, init));
    return vorige(input, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = vorige;
  }
}

/** Wat er in de database staat op het moment dat de mail naar Resend gaat. */
async function metBlikOpResend(contractId, fn) {
  const opMoment = [];
  const res = await metOnderschepping(/^https:\/\/api\.resend\.com\//,
    () => { opMoment.push({ versies: versies(contractId), contract: contractRij(contractId) }); }, fn);
  return { res, opMoment };
}

async function wachtOp(fn, melding, ms = 10_000) {
  const tot = Date.now() + ms;
  for (;;) {
    const waarde = await fn();
    if (waarde) return waarde;
    if (Date.now() > tot) throw new Error(`${melding}: na ${ms} ms nog niet zo`);
    await new Promise((klaar) => setTimeout(klaar, 25));
  }
}

/**
 * Houdt één contractrij vast vanuit een eigen databasesessie (SELECT … FOR
 * UPDATE), tot `loslaten()`. Een verzending die de rij wil vergrendelen
 * (begin_contract_signature_send) wacht dan; zo zet de test twee verzendingen
 * in een vaste volgorde. Raakt alleen deze ene rij van een eigen organisatie.
 */
async function houdRijVast(contractId) {
  const sessie = spawn('psql', [DB_URL, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let uit = '';
  sessie.stdout.on('data', (deel) => { uit += deel; });
  sessie.stderr.on('data', (deel) => { uit += deel; });
  const gesloten = new Promise((klaar) => sessie.on('close', klaar));
  sessie.stdin.write(`begin;\nselect 'pid:' || pg_backend_pid() from public.contracts where id = ${q(contractId)} for update;\n`);
  const pid = Number(await wachtOp(() => uit.match(/pid:(\d+)/)?.[1], `rij ${contractId} vasthouden (${uit.trim()})`));
  return {
    /** Hoeveel sessies wachten (direct of achter elkaar) op deze rij. */
    wachtenden: () => Number(sql(`select count(*) from pg_stat_activity a
      where ${pid} = any(pg_blocking_pids(a.pid))
         or exists (select 1 from pg_stat_activity b where ${pid} = any(pg_blocking_pids(b.pid)) and b.pid = any(pg_blocking_pids(a.pid)))`)),
    async loslaten() {
      if (sessie.exitCode === null) sessie.stdin.end('commit;\n');
      await gesloten;
    },
  };
}

/**
 * Supabase draait edge functions in UTC. De klok van deze machine kan anders
 * staan (een laptop in Amsterdam); voor wat tijd op papier zet, draaien we de
 * functie daarom in UTC, zoals op staging.
 */
async function alsOpDeServer(fn) {
  const vorige = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    return await fn();
  } finally {
    if (vorige === undefined) delete process.env.TZ; else process.env.TZ = vorige;
  }
}

// ── Het scenario ────────────────────────────────────────────────────────

export default async function contracten() {
  groep('Contracten');
  const w = await stap('wereld maken', () => maakWereld('contracten'));
  if (!w) return;
  const w2 = await stap('tweede organisatie maken', () => maakWereld('contracten-ander'));

  const getekend = await richTextGetypt(w);
  await weigerenEnOpnieuw(w);
  const word = await wordContract(w);
  await opslagEvenWeg(w);
  await vastNaVersturen(w, getekend);
  await mislukteHerverzending(w);
  await deadline(w);
  await rollen(w);
  if (w2) await andereOrganisatie(w, w2, getekend, word);
  await publiekeRanden(w);
  await portaal(w, w2, getekend, word);
  await tegelijk(w);
}

// ── 1. Rich-text: versturen, bekijken, getypt tekenen ──────────────────

async function richTextGetypt(w) {
  groep('Contracten · rich-text versturen en getypt tekenen');

  await stap('contactpersoon van klant A heet Łukasz Dvořák (letters buiten Latin-1)', async () => {
    const res = await rest(`clients?id=eq.${w.klantA.id}&select=id,contact_name`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { contact_name: 'Łukasz Dvořák' },
    });
    gelijk(gelukt(res, 'klant bijwerken')[0]?.contact_name, 'Łukasz Dvořák', 'contactpersoon');
  });

  const c = await stap('concept opslaan als lid, zoals het scherm (PostgREST)', async () => {
    const rij = await nieuwContract(w, { title: 'Onderhoudsovereenkomst — Dvořák', body: RIJKE_INHOUD });
    gelijk([rij.status, rij.created_by, rij.editor_mode], ['draft', w.medewerker.id, 'richtext'], 'nieuw concept');
    verwacht(/\S/.test(rij.number || ''), 'geen contractnummer toegekend');
    return rij;
  });
  if (!c) return null;

  await stap('interne notitie bij het contract (mag nooit naar de klant)', async () => {
    gelukt(await rest('contract_internal_notes', {
      method: 'POST', token: w.medewerker.token,
      body: { organization_id: w.orgId, contract_id: c.id, body: 'INTERN: maximaal 10% korting', author_name: 'lid' },
    }), 'notitie opslaan');
  });

  await stap('PDF-voorbeeld van het concept: variabelen ingevuld, geen ondertekenlink (lezer mag kijken)', async () => {
    const json = gelukt(await workflow(w.lezer, { action: 'previewContractPdf', organizationId: w.orgId, contractId: c.id }), 'voorbeeld');
    const bytes = uitBase64(json.pdf.base64);
    gelijk(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-', 'PDF-kop');
    const tekst = (await pdfPaginas(bytes)).join('\n');
    bevatAlles(tekst, verwachtInPdf(w), 'voorbeeld-PDF');
    verwacht(!plat(tekst).includes('beveiligde link'), 'het voorbeeld noemt een ondertekenlink');
    gelijk(contractRij(c.id).status, 'draft', 'status na voorbeeld');
  });

  const verzonden = await stap('versturen: versie vastgelegd vóór de mail, geen link terug naar de verzender', async () => {
    const { res, opMoment } = await metBlikOpResend(c.id, () => verstuur(w, c.id, {
      recipientEmail: w.klantA.email, recipientName: 'Łukasz Dvořák', personalMessage: 'Hoi Łukasz, <b>hierbij</b> het contract.',
    }));
    const json = gelukt(res, 'versturen');
    gelijk(opMoment.length, 1, 'aantal aanroepen van Resend');
    const [moment] = opMoment;
    gelijk(moment.versies.map((v) => v.snapshot_reason), ['sent_to_client'], 'vastgelegde versies op het moment van de mail');
    verwacht(moment.versies[0].body.includes(`Opdrachtgever: ${w.klantA.name}, t.a.v. Łukasz Dvořák.`),
      'de vastgelegde versie heeft de variabelen niet ingevuld');
    const mails = mailsVoor(c.id, 'contract_sent');
    gelijk(mails.length, 1, 'aantal verstuurmails');
    const token = linkUit(mails[0]);
    const antwoord = JSON.stringify(json);
    verwacht(!antwoord.includes(token), 'de ondertekenlink ging terug naar de verzender');
    verwacht(!antwoord.includes('/contract/'), 'het antwoord aan de verzender bevat een contractlink');
    return { json, token, mail: mails[0], versie: versies(c.id)[0] };
  });
  if (!verzonden) return null;
  const { token } = verzonden;

  await stap('mail aan de klant: link naar de ondertekenpagina en het contract als PDF', async () => {
    const { mail, json } = verzonden;
    gelijk(mail.to, [w.klantA.email], 'ontvanger');
    const url = `${PUBLIEK}/contract/${token}`;
    verwacht(mail.html.includes(url) && mail.text.includes(url), 'de link staat niet in de html- en tekstversie');
    verwacht(mail.subject.includes(c.number), 'contractnummer ontbreekt in het onderwerp');
    // Het persoonlijke bericht is tekst: de <b> komt er letterlijk in, niet als opmaak.
    verwacht(mail.html.includes('Hoi Łukasz, &lt;b&gt;hierbij&lt;/b&gt; het contract.'), 'persoonlijk bericht ontbreekt of is niet als tekst opgenomen');
    const bijlage = pdfBijlage(mail);
    gelijk(bijlage.naam, `contract-${c.number}.pdf`, 'naam van de bijlage');
    gelijk(sha256(bijlage.bytes), json.attachment.sha256, 'sha256 van de bijlage');
  });

  await stap('contract-PDF bevat alle tekst: <div>-regels, tabel, lijsten, namen buiten Latin-1', async () => {
    const paginas = await pdfPaginas(pdfBijlage(verzonden.mail).bytes);
    const tekst = paginas.join('\n');
    bevatAlles(tekst, [...verwachtInPdf(w), 'CONTRACT', c.number, 'Onderhoudsovereenkomst - Dvorák', 'T.a.v. Lukasz Dvorák'], 'verstuurde PDF');
    const vlak = plat(tekst);
    for (const fout of NOOIT_IN_PDF) verwacht(!vlak.includes(fout), `"${fout}" staat in de PDF`);
  });

  await stap('na versturen: status verstuurd, alleen de hash van de link, ondertekenaar klaargezet', async () => {
    const rij = contractRij(c.id);
    gelijk(rij.status, 'sent', 'status');
    verwacht(rij.sent_at, 'sent_at ontbreekt');
    gelijk(rij.public_token_hash, sha256(token), 'hash van de link');
    gelijk(tokenInDatabase(c.id, token), 0, 'rijen met de platte link');
    // De link werkt minstens tot en met de ondertekendeadline (in Nederland).
    verwacht(new Date(rij.public_token_expires_at) > new Date(`${c.valid_until}T23:59:00+01:00`),
      `link verloopt (${rij.public_token_expires_at}) vóór de deadline ${c.valid_until}`);
    const s = ondertekenaars(c.id);
    gelijk(s.map((x) => [x.role, x.name, x.email, x.status]), [['client', 'Łukasz Dvořák', w.klantA.email, 'pending']], 'ondertekenaars');
    const d = verzendingen(c.id);
    gelijk(d.map((x) => [x.status, x.recipient_email, x.provider_email_id]), [['sent', w.klantA.email, verzonden.mail.id]], 'verzendregels');
    const typen = gebeurtenissen(c.id).map((e) => e.event_type);
    verwacht(typen.includes('public_token_created') && typen.includes('sent_to_client'), `gebeurtenissen: ${typen}`);
  });

  const pagina = await stap('ondertekenpagina: de verstuurde versie, veilig gemaakt, zonder interne gegevens', async () => {
    const p = gelukt(await bekijk(token), 'bekijken');
    gelijk([p.contract.status, p.contract.content_kind, p.contract.version_id], ['sent', 'html', verzonden.versie.id], 'contract op de pagina');
    gelijk(p.contract.title, 'Onderhoudsovereenkomst — Dvořák', 'titel');
    verwacht(p.contract.body.includes(`Opdrachtgever: ${w.klantA.name}, t.a.v. Łukasz Dvořák.`), 'ingevulde variabelen ontbreken');
    verwacht(p.contract.body.includes('<table>') && p.contract.body.includes('Punt na geneste lijst'), 'tabel of lijst ontbreekt');
    const laag = p.contract.body.toLowerCase();
    for (const gevaar of ['<script', 'onerror', 'javascript:', 'alert(']) verwacht(!laag.includes(gevaar), `onveilige HTML op de publieke pagina: ${gevaar}`);
    const klantgericht = new Set(['sent_to_client', 'email_sent', 'client_viewed', 'client_signed', 'client_declined', 'question_asked', 'reminded', 'voided', 'expired']);
    verwacht(p.events.every((e) => klantgericht.has(e.event_type) && e.description === null), `interne stappen in de tijdlijn: ${JSON.stringify(p.events)}`);
    verwacht(!JSON.stringify(p).includes('maximaal 10% korting'), 'de interne notitie staat op de publieke pagina');
    verwacht(gebeurtenissen(c.id).some((e) => e.event_type === 'client_viewed'), 'bekijken is niet vastgelegd');
    return p;
  });
  if (!pagina) return null;
  const versionId = pagina.contract.version_id;

  await stap('tekenen met een andere akkoordtekst wordt geweigerd', async () => {
    geweigerd(await teken(token, { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email, versionId, consentText: 'Ik ga niet akkoord met artikel 5.' }), 'andere akkoordtekst');
    geweigerd(await teken(token, { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email, versionId, consentText: AKKOORD.toUpperCase() }), 'akkoordtekst in hoofdletters');
    geweigerd(await teken(token, { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email, versionId, consentText: '' }), 'zonder akkoordtekst');
    wachtNogOpHandtekening(c.id, 'na een andere akkoordtekst');
  });

  await stap('te lange of ongeldige invoer: nette 4xx, er verandert niets', async () => {
    const goed = { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email, versionId };
    const gevallen = [
      ['naam van 201 tekens', { signerName: 'Ł'.repeat(201) }],
      ['e-mailadres van 255 tekens', { signerEmail: `${'a'.repeat(244)}@klant.test` }],
      ['handtekening van ruim 2 MB', { signatureMethod: 'drawn', signatureImage: `data:image/png;base64,${'A'.repeat(2_000_000)}` }],
      ['lege naam', { signerName: '   ' }],
      ['ongeldig e-mailadres', { signerEmail: 'geen-adres' }],
      ['onbekende methode', { signatureMethod: 'stempel' }],
      ['getekend zonder afbeelding', { signatureMethod: 'drawn', signatureImage: '' }],
      ['getekend als SVG', { signatureMethod: 'drawn', signatureImage: 'data:image/svg+xml;base64,PHN2Zy8+' }],
    ];
    for (const [naam, velden] of gevallen) geweigerd(await teken(token, { ...goed, ...velden }), naam);
    wachtNogOpHandtekening(c.id, 'na ongeldige invoer');
  });

  await stap('tekenen met een verouderde of ontbrekende versie wordt geweigerd', async () => {
    geweigerd(await teken(token, { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email, versionId: randomUUID() }), 'onbekende versie');
    geweigerd(await teken(token, { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email, versionId: null }), 'zonder versie');
    wachtNogOpHandtekening(c.id, 'na een verkeerde versie');
  });

  const ondertekend = await stap('getypt tekenen met precies de akkoordtekst', async () => {
    // Het adres in hoofdletters: de klant typt het zo, het blijft het uitgenodigde adres.
    const p = gelukt(await alsOpDeServer(() => teken(token, { signerName: 'Łukasz Dvořák', signerEmail: w.klantA.email.toUpperCase(), versionId })), 'tekenen');
    gelijk([p.contract.status, p.signer?.status], ['signed', 'signed'], 'na tekenen');
    return p;
  });
  if (!ondertekend) return { contract: c, token };

  await stap('bewijs in contract_signers: naam, e-mail, IP, browser, akkoordtekst', async () => {
    const [s] = ondertekenaars(c.id);
    gelijk(
      [s.status, s.name, s.email, s.signed_ip, s.signed_user_agent, s.consent_text, s.signature_method],
      ['signed', 'Łukasz Dvořák', w.klantA.email, IP, UA, AKKOORD, 'typed'],
      'ondertekenbewijs',
    );
    verwacht(s.signed_at, 'tijdstip van tekenen ontbreekt');
    verwacht(s.email_verified_at, 'het uitgenodigde adres is niet als bevestigd vastgelegd');
    const rij = contractRij(c.id);
    gelijk(rij.status, 'signed', 'status');
    verwacht(rij.signed_at, 'signed_at ontbreekt');
    gelijk(gebeurtenissen(c.id).filter((e) => e.event_type === 'client_signed').length, 1, 'aantal handtekening-gebeurtenissen');
  });

  const getekendPdf = await stap('getekend PDF in de privé-opslag, met handtekening- en bewijspagina', async () => {
    const rij = contractRij(c.id);
    gelijk(rij.signed_storage_provider, 'r2', 'opslag');
    verwacht(String(rij.signed_storage_key).startsWith(`${w.orgId}/contract-pdfs/${c.id}/`), `opslagsleutel ${rij.signed_storage_key}`);
    const bytes = post.r2.get(rij.signed_storage_key);
    verwacht(bytes, 'het getekende PDF staat niet in R2');
    gelijk(sha256(bytes), rij.signed_document_sha256, 'sha256 van het getekende PDF');
    gelijk(Number(rij.signed_pdf_size_bytes), bytes.length, 'grootte');
    gelijk(rij.signed_pdf_data_base64, null, 'ook nog als base64 in de database');
    const paginas = await pdfPaginas(bytes);
    const alles = paginas.join('\n');
    bevatAlles(alles, [...verwachtInPdf(w), 'HANDTEKENING', 'Digitaal ondertekend door Lukasz Dvorák'], 'getekend PDF');
    verwacht(!plat(alles).includes('/contract/'), 'de ondertekenlink staat in het getekende exemplaar');
    const bewijs = paginas.at(-1);
    bevatAlles(bewijs, [
      'ONDERTEKENBEWIJS', `${c.number} - Onderhoudsovereenkomst - Dvorák`, w.klantA.name, 'Lukasz Dvorák',
      w.klantA.email, 'Getypte handtekening', IP, UA, AKKOORD,
    ], 'bewijspagina');
    verwacht(!(await heeftAfbeelding(bytes)), 'een getypte handtekening staat als afbeelding in het PDF');
    return { bytes, paginas };
  });

  await stap('tijdstip op het bewijs en in de bevestiging is Nederlandse tijd (edge functions draaien in UTC)', async () => {
    verwacht(getekendPdf, 'geen getekend PDF');
    const nl = new Date(contractRij(c.id).signed_at).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
    const goed = (tekst) => tekst.includes(nl) || /\b(UTC|GMT|CET|CEST)\b/.test(tekst);
    const regels = getekendPdf.paginas.at(-1).split('\n');
    const opBewijs = regels[regels.indexOf('ONDERTEKEND OP') + 1] ?? '';
    const inMail = mailsVoor(c.id, 'contract_signed_client')[0]?.text.match(/Ondertekend op: (.+)/)?.[1] ?? '';
    const fout = [
      goed(opBewijs) ? null : `bewijspagina "Ondertekend op ${opBewijs}"`,
      goed(inMail) ? null : `bevestigingsmail "Ondertekend op: ${inMail}"`,
    ].filter(Boolean);
    verwacht(fout.length === 0, `${fout.join(' en ')}; in Nederland was het ${nl}`);
  });

  await stap('bevestigingsmails: de klant met het getekende PDF, intern naar het bedrijfsadres', async () => {
    const klant = mailsVoor(c.id, 'contract_signed_client');
    const intern = mailsVoor(c.id, 'contract_signed_internal');
    gelijk(klant.map((m) => m.to), [[w.klantA.email]], 'bevestiging aan de klant');
    gelijk(intern.map((m) => m.to), [['info@contracten.studio.test']], 'interne melding');
    const bijlage = pdfBijlage(klant[0]);
    gelijk(bijlage.naam, `contract-${c.number}-getekend.pdf`, 'naam van de bijlage');
    gelijk(sha256(bijlage.bytes), contractRij(c.id).signed_document_sha256, 'bijlage is het opgeslagen getekende PDF');
  });

  await stap('na tekenen: niet nog eens tekenen of weigeren; bekijken mag nog even', async () => {
    const voor = ondertekenaars(c.id)[0];
    geweigerd(await teken(token, { signerName: 'Iemand Anders', signerEmail: 'iemand@anders.test', versionId }), 'tweede handtekening');
    geweigerd(await tekenZoalsDePagina(token, { signerName: 'Iemand Anders', signerEmail: 'iemand@anders.test' }), 'tweede handtekening via de pagina');
    geweigerd(await publiek({ action: 'declineContract', token, name: 'Iemand Anders', reason: 'toch niet' }), 'weigeren na tekenen');
    const na = ondertekenaars(c.id)[0];
    const kern = (s) => [s.name, s.email, s.signed_at, s.signed_ip, s.consent_text, s.status];
    gelijk(kern(na), kern(voor), 'het bewijs veranderde');
    gelijk(contractRij(c.id).status, 'signed', 'status');
    gelijk(gebeurtenissen(c.id).filter((e) => e.event_type === 'client_signed').length, 1, 'aantal handtekening-gebeurtenissen');
    gelijk(mailsVoor(c.id, 'contract_signed_client').length, 1, 'aantal bevestigingen');
    const p = gelukt(await bekijk(token), 'bekijken na tekenen');
    gelijk(p.contract.status, 'signed', 'status op de pagina');
    // Daarna niet nog wekenlang de hele inhoud en klantgegevens via een bearer-link.
    const tot = new Date(contractRij(c.id).public_token_expires_at).getTime();
    verwacht(tot <= Date.now() + 7 * 86_400_000 + 60_000, 'de link blijft na tekenen langer dan 7 dagen open');
  });

  await stap('getekend PDF downloaden in de app: met leesrecht wel, zonder Financiën niet', async () => {
    const verwachteHash = contractRij(c.id).signed_document_sha256;
    for (const [naam, g] of [['lid', w.medewerker], ['lezer', w.lezer], ['boekhouder', w.boekhouder], ['kijker', w.kijker]]) {
      const json = gelukt(await workflow(g, { action: 'downloadContractPdf', organizationId: w.orgId, contractId: c.id }), `download als ${naam}`);
      gelijk(sha256(uitBase64(json.pdf.base64)), verwachteHash, `PDF voor ${naam}`);
    }
    geweigerd(await workflow(w.zonderFinancien, { action: 'downloadContractPdf', organizationId: w.orgId, contractId: c.id }), 'download zonder Financiën', [403]);
  });

  return { contract: c, token };
}

// ── 2. Weigeren, terug naar concept, opnieuw versturen ────────────────

async function weigerenEnOpnieuw(w) {
  groep('Contracten · weigeren, terug naar concept, opnieuw versturen');
  const start = await stap('contract versturen', async () => {
    const c = await nieuwContract(w, { title: 'Samenwerkingsovereenkomst', body: '<h2>Artikel 3</h2><p>OUDE TEKST: levering binnen 90 dagen.</p>' });
    return { c, ...(await verstuurEnLink(w, c.id)) };
  });
  if (!start) return;
  const { c, token: oud } = start;

  await stap('weigeren via de publieke pagina, met reden', async () => {
    const p = gelukt(await publiek({ action: 'declineContract', token: oud, name: 'Contact Klant A', email: w.klantA.email, reason: 'Artikel 3 klopt niet.' }), 'weigeren');
    gelijk(p.contract.status, 'declined', 'status op de pagina');
    gelijk(contractRij(c.id).status, 'declined', 'status');
    const [s] = ondertekenaars(c.id);
    gelijk([s.status, s.decline_reason], ['declined', 'Artikel 3 klopt niet.'], 'ondertekenaar');
    verwacht(gebeurtenissen(c.id).some((e) => e.event_type === 'client_declined'), 'weigering niet vastgelegd');
  });

  await stap('na weigeren: niet tekenen en niet zonder meer opnieuw versturen', async () => {
    geweigerd(await tekenZoalsDePagina(oud, { signerEmail: w.klantA.email }), 'tekenen na weigeren');
    geweigerd(await verstuur(w, c.id), 'opnieuw versturen zonder terug naar concept');
    gelijk(contractRij(c.id).status, 'declined', 'status');
    gelijk(mailsVoor(c.id, 'contract_sent').length, 1, 'aantal verstuurmails');
  });

  await stap('terug naar concept mag niet voor lezer, kijker, boekhouder, zonder Financiën of anoniem', async () => {
    const args = { p_contract_id: c.id, p_organization_id: w.orgId };
    for (const [naam, g] of [['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['zonder Financiën', w.zonderFinancien]]) {
      geweigerd(await rpc('reopen_contract', args, g.token), `terug naar concept als ${naam}`);
    }
    geweigerd(await rpc('reopen_contract', args), 'terug naar concept anoniem');
    gelijk(contractRij(c.id).status, 'declined', 'status');
  });

  await stap('terug naar concept als lid: weer bewerkbaar, de oude link vervalt', async () => {
    gelukt(await rpc('reopen_contract', { p_contract_id: c.id, p_organization_id: w.orgId }, w.medewerker.token), 'terug naar concept');
    const rij = contractRij(c.id);
    gelijk([rij.status, rij.public_token_hash, rij.public_token_expires_at], ['draft', null, null], 'na terug naar concept');
    geweigerd(await bekijk(oud), 'oude link bekijken');
    geweigerd(await teken(oud, { signerEmail: w.klantA.email, versionId: versies(c.id)[0]?.id }), 'oude link tekenen');
    geweigerd(await publiek({ action: 'declineContract', token: oud, name: 'X' }), 'oude link weigeren');
  });

  await stap('een eerder verstuurd concept valt onder de bewaarplicht: niet te verwijderen', async () => {
    nietsVeranderd(await rest(`contracts?id=eq.${c.id}`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'verwijderen');
    verwacht(contractRij(c.id), 'het contract is verwijderd');
  });

  const nieuw = await stap('aanpassen en opnieuw versturen: nieuwe link, nieuwe versie', async () => {
    const aanpassing = await rest(`contracts?id=eq.${c.id}&select=id,body,title`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
      body: { title: 'Samenwerkingsovereenkomst v2', body: '<h2>Artikel 3</h2><p>NIEUWE TEKST: levering binnen 30 dagen.</p>' },
    });
    gelijk(gelukt(aanpassing, 'aanpassen in concept').length, 1, 'aangepaste rijen');
    const { token } = await verstuurEnLink(w, c.id);
    verwacht(token !== oud, 'dezelfde link opnieuw');
    const v = versies(c.id);
    gelijk(v.map((x) => x.version_number), [1, 2], 'versies');
    verwacht(v[1].body.includes('NIEUWE TEKST') && v[1].title === 'Samenwerkingsovereenkomst v2', 'nieuwe versie heeft de oude tekst');
    geweigerd(await bekijk(oud), 'oude link na opnieuw versturen');
    const p = gelukt(await bekijk(token), 'nieuwe link bekijken');
    gelijk(p.contract.version_id, v[1].id, 'getoonde versie');
    verwacht(p.contract.body.includes('NIEUWE TEKST') && !p.contract.body.includes('OUDE TEKST'), 'pagina toont niet de nieuwe tekst');
    gelijk(ondertekenaars(c.id).map((s) => [s.status, s.decline_reason]), [['pending', null]], 'ondertekenaar klaar voor de nieuwe ronde');
    return { token, versies: v };
  });
  if (!nieuw) return;

  await stap('tekenen met de nieuwe link: de oude versie niet, de nieuwe wel; het PDF heeft de nieuwe tekst', async () => {
    geweigerd(await teken(nieuw.token, { signerEmail: w.klantA.email, versionId: nieuw.versies[0].id }), 'tekenen op de oude versie');
    gelukt(await tekenZoalsDePagina(nieuw.token, { signerName: 'Contact Klant A', signerEmail: w.klantA.email }), 'tekenen');
    const rij = contractRij(c.id);
    const tekst = plat((await pdfPaginas(post.r2.get(rij.signed_storage_key))).join('\n'));
    verwacht(tekst.includes('NIEUWE TEKST: levering binnen 30 dagen.') && !tekst.includes('OUDE TEKST'), 'getekend PDF heeft niet (alleen) de nieuwe tekst');
    verwacht(tekst.includes('Samenwerkingsovereenkomst v2'), 'getekend PDF heeft niet de nieuwe titel');
  });
}

// ── 3. Word-contract (office) ───────────────────────────────────────────

async function wordContract(w) {
  groep('Contracten · Word-contract (office), getekend met de hand');
  const sleutel = `${w.orgId}/contract/${randomUUID()}-huurovereenkomst.docx`;
  post.media.set(sleutel, 'Huurovereenkomst Herengracht 12 versie 1');

  const c = await stap('Word-contract opslaan als lid (editor_mode office)', () => nieuwContract(w, {
    title: 'Huurovereenkomst', body: '', editor_mode: 'office',
    body_storage_key: sleutel, body_mime_type: DOCX, body_size_bytes: 18_432,
  }));
  if (!c) return null;

  const verzonden = await stap('versturen zet het document om en legt die PDF vast vóór de mail', async () => {
    const logVoor = post.log.length;
    const { res, opMoment } = await metBlikOpResend(c.id, () => verstuur(w, c.id));
    const json = gelukt(res, 'versturen');
    verwacht(post.log.slice(logVoor).includes('media POST /internal/office/convert-pdf'), 'het Word-document is niet omgezet');
    gelijk(opMoment[0]?.versies.length, 1, 'vastgelegde versies op het moment van de mail');
    const [v] = versies(c.id);
    verwacht(String(v.pdf_storage_key).startsWith(`${w.orgId}/contract-pdfs/${c.id}/`), `opslagsleutel van de versie: ${v.pdf_storage_key}`);
    const vastgelegd = post.r2.get(v.pdf_storage_key);
    verwacht(vastgelegd, 'de verstuurde PDF staat niet in R2');
    gelijk([sha256(vastgelegd), json.attachment.sha256, Number(v.pdf_size_bytes)], [v.pdf_sha256, v.pdf_sha256, vastgelegd.length], 'vastgelegde PDF');
    const mail = mailsVoor(c.id, 'contract_sent')[0];
    const bijlage = pdfBijlage(mail);
    gelijk(sha256(bijlage.bytes), v.pdf_sha256, 'de bijlage is niet de vastgelegde PDF');
    bevatAlles((await pdfPaginas(bijlage.bytes)).join('\n'), ['Word-contract Huurovereenkomst Herengracht 12 versie 1'], 'Word-PDF');
    return { token: linkUit(mail), versie: v, vastgelegd };
  });
  if (!verzonden) return { contract: c };

  const pagina = await stap('ondertekenpagina toont de vastgelegde PDF, ook als het Word-bestand daarna verandert', async () => {
    post.media.set(sleutel, 'GEWIJZIGD NA VERSTUREN');
    const p = gelukt(await bekijk(verzonden.token), 'bekijken');
    gelijk([p.contract.content_kind, p.contract.body, p.contract.version_id], ['pdf', '', verzonden.versie.id], 'Word-contract op de pagina');
    gelijk(sha256(uitBase64(p.contract.document_pdf_base64)), verzonden.versie.pdf_sha256, 'getoonde PDF');
    return p;
  });

  await stap('met de hand tekenen: de verstuurde pagina plus handtekening- en bewijspagina', async () => {
    verwacht(pagina, 'pagina niet geladen');
    const handtekening = pngHandtekening();
    gelukt(await teken(verzonden.token, {
      signatureMethod: 'drawn', signatureImage: handtekening, signerName: 'Contact Klant A',
      signerEmail: w.klantA.email, versionId: pagina.contract.version_id,
    }), 'tekenen');
    const rij = contractRij(c.id);
    const bytes = post.r2.get(rij.signed_storage_key);
    verwacht(bytes, 'het getekende PDF staat niet in R2');
    gelijk(sha256(bytes), rij.signed_document_sha256, 'sha256 van het getekende PDF');
    const basis = await pdfPaginas(verzonden.vastgelegd);
    const paginas = await pdfPaginas(bytes);
    gelijk(paginas.length, basis.length + 2, 'aantal pagina\'s (verstuurd + handtekening + bewijs)');
    gelijk(paginas.slice(0, basis.length), basis, 'de verstuurde pagina\'s zijn veranderd');
    verwacht(!plat(paginas.join(' ')).includes('GEWIJZIGD'), 'het gewijzigde Word-bestand is getekend in plaats van het verstuurde');
    bevatAlles(paginas[basis.length], ['ONDERTEKENING', `Behorend bij contract ${c.number} - Huurovereenkomst`, 'Digitaal ondertekend door Contact Klant A'], 'handtekeningpagina');
    bevatAlles(paginas.at(-1), ['ONDERTEKENBEWIJS', 'Getekende handtekening', IP, UA, AKKOORD], 'bewijspagina');
    verwacht(await heeftAfbeelding(bytes), 'de getekende handtekening staat niet als afbeelding in het PDF');
    const [s] = ondertekenaars(c.id);
    gelijk([s.status, s.signature_method, s.signature_image, s.consent_text], ['signed', 'drawn', handtekening, AKKOORD], 'ondertekenbewijs');
  });

  return { contract: c, token: verzonden.token };
}

// ── 3b. De privé-opslag (R2) even onbereikbaar ─────────────────────────

async function opslagEvenWeg(w) {
  groep('Contracten · privé-opslag (R2) even onbereikbaar');

  await stap('rich-text: getekend PDF valt terug op de database; downloaden in app en portaal lukt', async () => {
    const c = await nieuwContract(w, { title: 'Opslag even weg' });
    const { token } = await verstuurEnLink(w, c.id);
    const p = gelukt(await bekijk(token), 'bekijken');
    post.r2Storing = { aantal: 1 };
    try {
      gelukt(await teken(token, { signerName: 'Contact Klant A', signerEmail: w.klantA.email, versionId: p.contract.version_id }), 'tekenen');
    } finally {
      post.r2Storing = { aantal: 0 };
    }
    const rij = contractRij(c.id);
    gelijk([rij.status, rij.signed_storage_provider, rij.signed_storage_key], ['signed', 'database', null], 'opslag van het getekende PDF');
    gelijk(sha256(uitBase64(rij.signed_pdf_data_base64)), rij.signed_document_sha256, 'sha256 van het PDF in de database');
    const app = gelukt(await workflow(w.medewerker, { action: 'downloadContractPdf', organizationId: w.orgId, contractId: c.id }), 'download in de app');
    const portaal = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'getContractPdf', contractId: c.id } }), 'download in het portaal');
    gelijk([sha256(uitBase64(app.pdf.base64)), sha256(uitBase64(portaal.pdf.base64))], [rij.signed_document_sha256, rij.signed_document_sha256], 'gedownloade PDF\'s');
    gelijk(mailsVoor(c.id, 'contract_signed_client').map((m) => m.bijlagen.map((b) => b.naam)), [[`contract-${c.number}-getekend.pdf`]], 'bijlage bij de bevestiging');
  });

  // Een Word-contract wordt bij het versturen één keer omgezet; die PDF is de
  // bron voor de pagina en het getekende exemplaar (contractOffice.ts). Een
  // nieuwe omzetting kan anders uitvallen (lettertypen, een nieuwere
  // documentserver). Hier staat een gewijzigd bronbestand voor die afwijking.
  const sleutel = `${w.orgId}/contract/${randomUUID()}-opslag.docx`;
  const word = await stap('Word-contract versturen; daarna wijkt een nieuwe omzetting af van de verstuurde PDF', async () => {
    post.media.set(sleutel, 'VERSTUURDE TEKST van het huurcontract');
    const c = await nieuwContract(w, { title: 'Word, opslag even weg', body: '', editor_mode: 'office', body_storage_key: sleutel, body_mime_type: DOCX, body_size_bytes: 9_000 });
    const { token, mail } = await verstuurEnLink(w, c.id);
    const [v] = versies(c.id);
    const verstuurd = await pdfPaginas(pdfBijlage(mail).bytes);
    post.media.set(sleutel, 'ANDERE TEKST uit een nieuwe omzetting');
    return { c, token, versie: v, verstuurd };
  });

  await stap('Word: de pagina toont bij een R2-storing de verstuurde PDF of niets, geen nieuwe omzetting', async () => {
    verwacht(word, 'geen Word-contract');
    post.r2Storing = { aantal: 1 };
    let p;
    try {
      p = gelukt(await bekijk(word.token), 'bekijken');
    } finally {
      post.r2Storing = { aantal: 0 };
    }
    // Geen document is goed: dan blokkeert de pagina het tekenen ("je hoort eerst
    // te kunnen lezen wat je tekent"). Een ánder document dan het verstuurde niet.
    const getoond = p.contract.document_pdf_base64;
    if (getoond && sha256(uitBase64(getoond)) !== word.versie.pdf_sha256) {
      const eerste = (await pdfPaginas(uitBase64(getoond)))[0];
      throw new Error(`de klant krijgt een nieuwe omzetting te lezen in plaats van de verstuurde PDF: "${eerste}"`);
    }
  });

  await stap('Word: tekenen tijdens een R2-storing legt nooit een ander document vast dan het verstuurde', async () => {
    verwacht(word, 'geen Word-contract');
    post.r2Storing = { aantal: 1 };
    let res;
    try {
      res = await teken(word.token, { signerName: 'Contact Klant A', signerEmail: w.klantA.email, versionId: word.versie.id });
    } finally {
      post.r2Storing = { aantal: 0 };
    }
    verwacht(res.status < 500, `5xx bij tekenen: ${res.status}`);
    const rij = contractRij(word.c.id);
    const bytes = rij.signed_storage_key ? post.r2.get(rij.signed_storage_key) : rij.signed_pdf_data_base64 ? uitBase64(rij.signed_pdf_data_base64) : null;
    if (!bytes) return; // niet getekend of (nog) geen PDF: dan is er ook niets verkeerds vastgelegd
    const getekend = await pdfPaginas(bytes);
    gelijk(getekend.slice(0, word.verstuurd.length), word.verstuurd,
      `getekend exemplaar (sha ${rij.signed_document_sha256.slice(0, 12)}) begint niet met de verstuurde PDF`);
  });
}

// ── 4. Na versturen ligt alles vast; intrekken ─────────────────────────

async function vastNaVersturen(w, getekend) {
  groep('Contracten · vast na versturen, intrekken');
  const start = await stap('contract versturen', async () => {
    const c = await nieuwContract(w, { title: 'Vaste inhoud', body: '<p>Vaste tekst.</p>' });
    return { c, ...(await verstuurEnLink(w, c.id)) };
  });
  if (!start) return;
  const { c, token } = start;
  const kern = (rij) => [rij.title, rij.body, rij.amount_cents, rij.currency, rij.date, rij.valid_until, rij.client_id, rij.number, rij.editor_mode, rij.body_storage_key, rij.status, rij.public_token_hash, rij.sent_at];
  const voor = kern(contractRij(c.id));
  const patch = (body, g = w.medewerker) => rest(`contracts?id=eq.${c.id}&select=id`, { method: 'PATCH', token: g.token, prefer: 'return=representation', body });

  await stap('inhoud, klant en nummer zijn niet meer te wijzigen (ook niet door de eigenaar)', async () => {
    const pogingen = [
      { title: 'Andere titel' }, { body: '<p>Andere tekst</p>' }, { amount_cents: 1 }, { currency: 'USD' },
      { date: datum(-10) }, { valid_until: datum(90) }, { client_id: w.klantB.id }, { number: 'CON-VALS-0001' },
      { editor_mode: 'office', body_storage_key: `${w.orgId}/contract/${randomUUID()}-ander.docx` },
    ];
    for (const body of pogingen) nietsVeranderd(await patch(body), `wijzigen ${Object.keys(body)}`);
    nietsVeranderd(await patch({ title: 'Eigenaar past aan' }, w.eigenaar), 'wijzigen door de eigenaar');
    gelijk(kern(contractRij(c.id)), voor, 'het contract veranderde');
  });

  await stap('status, link en verzendvelden zet je niet zelf', async () => {
    for (const status of ['signed', 'declined', 'draft', 'voided', 'expired']) nietsVeranderd(await patch({ status }), `status ${status}`);
    nietsVeranderd(await patch({ public_token_hash: 'a'.repeat(64) }), 'eigen link-hash');
    nietsVeranderd(await patch({ public_token_expires_at: new Date(Date.now() + 400 * 86_400_000).toISOString() }), 'link verlengen');
    nietsVeranderd(await patch({ sent_at: null }), 'sent_at wissen');
    nietsVeranderd(await patch({ signed_at: new Date().toISOString() }), 'signed_at zetten');
    nietsVeranderd(await patch({ signed_pdf_data_base64: 'JVBERi0=' }), 'eigen getekend PDF');
    gelijk(kern(contractRij(c.id)), voor, 'het contract veranderde');
  });

  await stap('een nieuw contract begint als concept, zonder link of bewijs', async () => {
    for (const extra of [{ status: 'sent' }, { status: 'signed' }, { public_token_hash: 'b'.repeat(64) }, { sent_at: new Date().toISOString() }, { signed_pdf_data_base64: 'JVBERi0=' }, { signed_at: new Date().toISOString() }]) {
      const res = await rest('contracts?select=id', {
        method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
        body: { organization_id: w.orgId, client_id: w.klantA.id, title: 'Vals', body: '<p>x</p>', ...extra },
      });
      geweigerd(res, `nieuw contract met ${Object.keys(extra)}`);
    }
  });

  await stap('versies, ondertekenaars, gebeurtenissen en verzendregels zijn niet aan te passen', async () => {
    const [v] = versies(c.id);
    nietsVeranderd(await rest(`contract_versions?id=eq.${v.id}&select=id`, { method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { body: '<p>Vervalst</p>' } }), 'versie wijzigen');
    nietsVeranderd(await rest(`contract_versions?id=eq.${v.id}&select=id`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'versie verwijderen');
    nietsVeranderd(await rest(`contract_signers?contract_id=eq.${c.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
      body: { status: 'signed', signed_at: new Date().toISOString(), consent_text: AKKOORD, signed_ip: '127.0.0.1' },
    }), 'ondertekenaar op getekend zetten');
    geweigerd(await rest('contract_events', {
      method: 'POST', token: w.medewerker.token,
      body: { organization_id: w.orgId, contract_id: c.id, event_type: 'client_signed', title: 'Klant heeft getekend' },
    }), 'nep-gebeurtenis');
    nietsVeranderd(await rest(`contract_events?contract_id=eq.${c.id}&select=id`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'gebeurtenissen wissen');
    geweigerd(await rest('contract_email_deliveries', {
      method: 'POST', token: w.medewerker.token,
      body: { organization_id: w.orgId, contract_id: c.id, recipient_email: 'x@y.nl', status: 'sent' },
    }), 'nep-verzendregel');
    gelijk(versies(c.id)[0].body, v.body, 'versie');
    wachtNogOpHandtekening(c.id, 'na vervalsingspogingen');
  });

  await stap('een verstuurd contract is niet te verwijderen', async () => {
    nietsVeranderd(await rest(`contracts?id=eq.${c.id}`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'verwijderen als lid');
    nietsVeranderd(await rest(`contracts?id=eq.${c.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'verwijderen als eigenaar');
    verwacht(contractRij(c.id), 'het contract is verwijderd');
  });

  await stap('intrekken mag niet voor lezer, kijker, boekhouder, zonder Financiën of anoniem', async () => {
    const args = { p_contract_id: c.id, p_organization_id: w.orgId, p_reason: 'poging' };
    for (const [naam, g] of [['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder], ['zonder Financiën', w.zonderFinancien]]) {
      geweigerd(await rpc('void_contract', args, g.token), `intrekken als ${naam}`);
    }
    geweigerd(await rpc('void_contract', args), 'intrekken anoniem');
    wachtNogOpHandtekening(c.id, 'na geweigerd intrekken');
  });

  await stap('intrekken als lid: de link werkt nergens meer voor (nette 4xx, geen 5xx)', async () => {
    gelukt(await rpc('void_contract', { p_contract_id: c.id, p_organization_id: w.orgId, p_reason: 'INTERN: verkeerde klant' }, w.medewerker.token), 'intrekken');
    const rij = contractRij(c.id);
    gelijk([rij.status, rij.public_token_hash, rij.voided_by], ['voided', null, w.medewerker.id], 'na intrekken');
    geweigerd(await bekijk(token), 'bekijken na intrekken');
    geweigerd(await tekenZoalsDePagina(token, { signerEmail: w.klantA.email }), 'tekenen na intrekken');
    geweigerd(await teken(token, { signerEmail: w.klantA.email, versionId: versies(c.id)[0].id }), 'tekenen met versie na intrekken');
    geweigerd(await publiek({ action: 'declineContract', token, name: 'Contact' }), 'weigeren na intrekken');
    geweigerd(await vraagStellen(token, { name: 'Contact', message: 'Hallo?' }), 'vraag na intrekken');
    gelijk(contractRij(c.id).status, 'voided', 'status');
  });

  await stap('ingetrokken blijft ingetrokken: niet versturen, niet terug naar concept, niet nog eens intrekken', async () => {
    geweigerd(await verstuur(w, c.id), 'versturen na intrekken');
    geweigerd(await rpc('reopen_contract', { p_contract_id: c.id, p_organization_id: w.orgId }, w.medewerker.token), 'terug naar concept na intrekken');
    geweigerd(await rpc('void_contract', { p_contract_id: c.id, p_organization_id: w.orgId }, w.medewerker.token), 'nog eens intrekken');
    gelijk(contractRij(c.id).status, 'voided', 'status');
    gelijk(mailsVoor(c.id, 'contract_sent').length, 1, 'aantal verstuurmails');
  });

  await stap('getekend contract: niet intrekken, niet terug naar concept, niet wijzigen of verwijderen', async () => {
    verwacht(getekend?.contract, 'geen getekend contract uit onderdeel 1');
    const id = getekend.contract.id;
    const vooraf = contractRij(id);
    geweigerd(await rpc('void_contract', { p_contract_id: id, p_organization_id: w.orgId }, w.medewerker.token), 'getekend intrekken');
    geweigerd(await rpc('reopen_contract', { p_contract_id: id, p_organization_id: w.orgId }, w.medewerker.token), 'getekend terug naar concept');
    for (const body of [{ title: 'Achteraf' }, { client_id: w.klantB.id }, { signed_document_sha256: 'c'.repeat(64) }, { signed_storage_key: `${w.orgId}/contract-pdfs/${id}/vals.pdf` }, { status: 'draft' }]) {
      nietsVeranderd(await rest(`contracts?id=eq.${id}&select=id`, { method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body }), `getekend wijzigen ${Object.keys(body)}`);
    }
    nietsVeranderd(await rest(`contracts?id=eq.${id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'getekend verwijderen');
    const na = contractRij(id);
    gelijk([na.status, na.title, na.client_id, na.signed_document_sha256, na.signed_storage_key], [vooraf.status, vooraf.title, vooraf.client_id, vooraf.signed_document_sha256, vooraf.signed_storage_key], 'getekend contract veranderde');
  });
}

// ── 5. Mislukte herverzending ──────────────────────────────────────────

async function mislukteHerverzending(w) {
  groep('Contracten · mislukte herverzending');
  const start = await stap('contract versturen naar de klant', async () => {
    const c = await nieuwContract(w, { title: 'Herverzending', body: '<p>Tekst die de klant al heeft.</p>' });
    const verzonden = await verstuurEnLink(w, c.id, { recipientName: 'Contact Klant A' });
    return { c, ...verzonden, versie: versies(c.id)[0] };
  });
  if (!start) return;
  const { c, token } = start;

  const vergelijk = (melding) => {
    const rij = contractRij(c.id);
    gelijk([rij.status, rij.public_token_hash], ['sent', sha256(token)], `${melding}: link`);
    gelijk(ondertekenaars(c.id).map((s) => [s.name, s.email, s.status]), [['Contact Klant A', w.klantA.email, 'pending']], `${melding}: ondertekenaar`);
    gelijk(versies(c.id).map((v) => v.id), [start.versie.id], `${melding}: versies`);
  };

  for (const soort of ['500', 'netwerk']) {
    await stap(`tweede verzending faalt bij Resend (${soort}): de link uit de eerste mail werkt nog`, async () => {
      post.resendStoring = { aantal: 1, soort };
      let res;
      try {
        res = await verstuur(w, c.id, { recipientEmail: 'iemand-anders@klant.test', recipientName: 'Iemand Anders' });
      } finally {
        post.resendStoring = { aantal: 0, soort: '500' };
      }
      // 502: de mailprovider faalde, niet de gebruiker. Wel netjes, zonder link.
      verwacht(res.status === 502 && res.json?.ok === false, `verwacht 502 zonder ok, kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
      vergelijk('na de mislukte verzending');
      verwacht(verzendingen(c.id).some((d) => d.status === 'failed' && d.recipient_email === 'iemand-anders@klant.test'), 'mislukte verzending niet vastgelegd');
      const p = gelukt(await bekijk(token), 'eerste link bekijken');
      gelijk([p.contract.status, p.contract.version_id], ['sent', start.versie.id], 'pagina na de mislukte verzending');
      gelijk(p.signer?.email, w.klantA.email, 'ondertekenaar op de pagina');
      verwacht(!JSON.stringify(p).includes('Nep-storing') && !JSON.stringify(p).includes('fetch failed'), 'de foutmelding van de provider staat op de publieke pagina');
    });
  }

  await stap('mailquotum op bij opnieuw versturen: 429, de link uit de eerste mail werkt nog', async () => {
    // Het quotum van deze ene organisatie op nul (een platforminstelling, geen
    // gebruikersactie). Eerder ving het quotum pas ná het vervangen van de link.
    sql(`insert into public.organization_email_limits (organization_id, hourly_limit, daily_limit, note)
         values (${q(w.orgId)}, 0, 0, 'tests/stromen: quotum vol') on conflict (organization_id) do update set hourly_limit = 0, daily_limit = 0`);
    let res;
    try {
      res = await verstuur(w, c.id, { recipientEmail: 'nog-iemand@klant.test', recipientName: 'Nog Iemand' });
    } finally {
      sql(`delete from public.organization_email_limits where organization_id = ${q(w.orgId)}`);
    }
    geweigerd(res, 'opnieuw versturen met een vol quotum', [429]);
    vergelijk('na een vol quotum');
    gelijk(mailsAan('nog-iemand@klant.test').length, 0, 'mails aan de nieuwe ontvanger');
    gelukt(await bekijk(token), 'eerste link bekijken');
  });

  await stap('met de link uit de eerste mail tekenen lukt; de bevestiging gaat naar de eerste ontvanger', async () => {
    gelukt(await tekenZoalsDePagina(token, { signerName: 'Contact Klant A', signerEmail: w.klantA.email }), 'tekenen');
    gelijk(contractRij(c.id).status, 'signed', 'status');
    gelijk(mailsVoor(c.id, 'contract_signed_client').map((m) => m.to), [[w.klantA.email]], 'bevestiging');
    gelijk(mailsAan('iemand-anders@klant.test').length, 0, 'mails aan de mislukte ontvanger');
  });
}

// ── 6. Deadline ────────────────────────────────────────────────────────

async function deadline(w) {
  groep('Contracten · ondertekendeadline');
  await stap('deadline in het verleden: versturen geweigerd, er gaat niets de deur uit', async () => {
    const c = await nieuwContract(w, { title: 'Te laat', valid_until: datum(-1) });
    geweigerd(await verstuur(w, c.id), 'versturen met verlopen deadline');
    const rij = contractRij(c.id);
    gelijk([rij.status, rij.public_token_hash, rij.sent_at], ['draft', null, null], 'contract');
    gelijk([mailsVoor(c.id).length, versies(c.id).length, ondertekenaars(c.id).length, verzendingen(c.id).length], [0, 0, 0, 0], 'mails, versies, ondertekenaars, verzendregels');
  });

  await stap('deadline verstreken na versturen: tekenen geweigerd, weigeren of een vraag kan nog', async () => {
    const c = await nieuwContract(w, { title: 'Deadline verstrijkt', valid_until: datum(3) });
    const { token } = await verstuurEnLink(w, c.id);
    // De tijd laten verstrijken. Na versturen ligt de deadline vast, ook voor
    // de database-eigenaar; alleen met de triggers uit (voor deze ene rij, in
    // deze ene transactie) is "drie dagen later" na te bootsen.
    sql(`begin; set local session_replication_role = replica;
         update public.contracts set valid_until = ${q(datum(-1))} where id = ${q(c.id)}; commit;`);
    geweigerd(await tekenZoalsDePagina(token, { signerEmail: w.klantA.email }), 'tekenen na de deadline');
    wachtNogOpHandtekening(c.id, 'na tekenen na de deadline');
    gelukt(await vraagStellen(token, { name: 'Contact', email: w.klantA.email, message: 'Kan de termijn langer?' }), 'vraag na de deadline');
  });
}

// ── 7. Rollen ──────────────────────────────────────────────────────────

async function rollen(w) {
  groep('Contracten · rollen');
  const concept = await stap('concept om mee te testen', () => nieuwContract(w, { title: 'Rollen' }));
  if (!concept) return;
  const zonderSchrijfrecht = [['kijker', w.kijker], ['boekhouder', w.boekhouder], ['lezer', w.lezer], ['zonder Financiën', w.zonderFinancien]];

  await stap('versturen: kijker, boekhouder, lezer en zonder Financiën worden geweigerd', async () => {
    for (const [naam, g] of zonderSchrijfrecht) geweigerd(await verstuur(w, concept.id, {}, g), `versturen als ${naam}`, [403]);
    const rij = contractRij(concept.id);
    gelijk([rij.status, rij.public_token_hash, mailsVoor(concept.id).length, ondertekenaars(concept.id).length], ['draft', null, 0, 0], 'na geweigerd versturen');
  });

  await stap('anoniem, met een vals token of als portaalgebruiker: geen toegang', async () => {
    const body = { action: 'sendContractForSignature', organizationId: w.orgId, contractId: concept.id };
    geweigerd(await roep('contract-workflow', { body }), 'anoniem', [401]);
    geweigerd(await roep('contract-workflow', { token: 'geen.echt.token', body }), 'vals token', [401]);
    geweigerd(await roep('contract-workflow', { token: w.portaalA.token, body }), 'portaalgebruiker', [403]);
    gelijk(contractRij(concept.id).status, 'draft', 'status');
  });

  await stap('voorbeeld en download: lezen mag met leesrecht, niet zonder Financiën', async () => {
    for (const [naam, g] of [['kijker', w.kijker], ['boekhouder', w.boekhouder], ['lezer', w.lezer]]) {
      gelukt(await workflow(g, { action: 'previewContractPdf', organizationId: w.orgId, contractId: concept.id }), `voorbeeld als ${naam}`);
    }
    geweigerd(await workflow(w.zonderFinancien, { action: 'previewContractPdf', organizationId: w.orgId, contractId: concept.id }), 'voorbeeld zonder Financiën', [403]);
  });

  await stap('in de database: lezen met leesrecht, schrijven niet; zonder Financiën niets', async () => {
    for (const [naam, g] of [['kijker', w.kijker], ['boekhouder', w.boekhouder], ['lezer', w.lezer]]) {
      gelijk((await rest(`contracts?id=eq.${concept.id}&select=id`, { token: g.token })).json?.length, 1, `${naam} ziet het contract`);
    }
    gelijk((await rest(`contracts?id=eq.${concept.id}&select=id`, { token: w.zonderFinancien.token })).json, [], 'zonder Financiën ziet het contract');
    for (const tabel of ['contract_versions', 'contract_signers', 'contract_events', 'contract_email_deliveries', 'contract_internal_notes']) {
      gelijk((await rest(`${tabel}?select=id&organization_id=eq.${w.orgId}`, { token: w.zonderFinancien.token })).json, [], `zonder Financiën leest ${tabel}`);
    }
    for (const [naam, g] of zonderSchrijfrecht) {
      geweigerd(await rest('contracts', { method: 'POST', token: g.token, body: { organization_id: w.orgId, client_id: w.klantA.id, title: `Van ${naam}`, body: '<p>x</p>' } }), `nieuw contract als ${naam}`);
      nietsVeranderd(await rest(`contracts?id=eq.${concept.id}&select=id`, { method: 'PATCH', token: g.token, prefer: 'return=representation', body: { title: `Door ${naam}` } }), `concept wijzigen als ${naam}`);
      nietsVeranderd(await rest(`contracts?id=eq.${concept.id}`, { method: 'DELETE', token: g.token, prefer: 'return=representation' }), `concept verwijderen als ${naam}`);
    }
    gelijk(contractRij(concept.id).title, 'Rollen', 'titel');
  });

  await stap('controle: een concept dat nooit verstuurd is, mag een lid wel verwijderen', async () => {
    // Zonder deze controle zou "niet te verwijderen" hierboven ook slagen als
    // verwijderen helemaal nooit werkte.
    const weg = await nieuwContract(w, { title: 'Mag weg' });
    gelijk(gelukt(await rest(`contracts?id=eq.${weg.id}&select=id`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'verwijderen').length, 1, 'verwijderde rijen');
    gelijk(contractRij(weg.id), null, 'het concept bestaat nog');
  });

  const verzonden = await stap('beheerder mag versturen', async () => verstuurEnLink(w, concept.id, {}, w.beheerder));
  if (!verzonden) return;

  await stap('intrekken en terug naar concept: niet voor kijker, boekhouder, lezer, zonder Financiën', async () => {
    for (const [naam, g] of zonderSchrijfrecht) {
      geweigerd(await rpc('void_contract', { p_contract_id: concept.id, p_organization_id: w.orgId }, g.token), `intrekken als ${naam}`);
      geweigerd(await rpc('reopen_contract', { p_contract_id: concept.id, p_organization_id: w.orgId }, g.token), `terug naar concept als ${naam}`);
    }
    wachtNogOpHandtekening(concept.id, 'na geweigerde acties');
    gelukt(await bekijk(verzonden.token), 'de link werkt nog');
  });

  await stap('terug naar concept vanuit "verstuurd" als lid: de link vervalt meteen', async () => {
    gelukt(await rpc('reopen_contract', { p_contract_id: concept.id, p_organization_id: w.orgId }, w.medewerker.token), 'terug naar concept');
    gelijk(contractRij(concept.id).status, 'draft', 'status');
    geweigerd(await bekijk(verzonden.token), 'bekijken met de oude link');
    geweigerd(await teken(verzonden.token, { signerEmail: w.klantA.email, versionId: versies(concept.id)[0]?.id }), 'tekenen met de oude link');
  });
}

// ── 8. Andere organisatie ──────────────────────────────────────────────

async function andereOrganisatie(w, w2, getekend, word) {
  groep('Contracten · andere organisatie');
  const doel = await stap('verstuurd contract in de eerste organisatie', async () => {
    const c = await nieuwContract(w, { title: 'Van organisatie 1' });
    return { c, ...(await verstuurEnLink(w, c.id)) };
  });
  if (!doel) return;
  const doelen = [doel.c.id, getekend?.contract?.id].filter(Boolean);
  const indringers = [['eigenaar', w2.eigenaar], ['lid', w2.medewerker]];

  await stap('contract-workflow met de organisatie van het contract: geen toegang', async () => {
    for (const [naam, g] of indringers) {
      for (const action of ['sendContractForSignature', 'previewContractPdf', 'downloadContractPdf']) {
        for (const id of doelen) geweigerd(await workflow(g, { action, organizationId: w.orgId, contractId: id }), `${action} als ${naam} van org 2`, [403]);
      }
    }
  });

  await stap('met de eigen organisatie en een vreemd contract-id: niet gevonden', async () => {
    for (const [naam, g] of indringers) {
      for (const action of ['sendContractForSignature', 'previewContractPdf', 'downloadContractPdf']) {
        for (const id of doelen) geweigerd(await workflow(g, { action, organizationId: w2.orgId, contractId: id }), `${action} als ${naam} met eigen org`, [404]);
      }
    }
    gelijk(mailsVoor(doel.c.id, 'contract_sent').length, 1, 'aantal verstuurmails');
    gelijk(contractRij(doel.c.id).public_token_hash, sha256(doel.token), 'de link van de klant veranderde');
  });

  await stap('database: niets lezen, wijzigen, verwijderen, intrekken of terugzetten', async () => {
    for (const [naam, g] of indringers) {
      for (const tabel of ['contracts', 'contract_versions', 'contract_signers', 'contract_events', 'contract_email_deliveries', 'contract_internal_notes']) {
        gelijk((await rest(`${tabel}?select=id&organization_id=eq.${w.orgId}`, { token: g.token })).json, [], `${naam} van org 2 leest ${tabel}`);
      }
      for (const id of doelen) {
        nietsVeranderd(await rest(`contracts?id=eq.${id}&select=id`, { method: 'PATCH', token: g.token, prefer: 'return=representation', body: { title: 'Overgenomen' } }), `wijzigen als ${naam}`);
        nietsVeranderd(await rest(`contracts?id=eq.${id}`, { method: 'DELETE', token: g.token, prefer: 'return=representation' }), `verwijderen als ${naam}`);
        for (const org of [w.orgId, w2.orgId]) {
          geweigerd(await rpc('void_contract', { p_contract_id: id, p_organization_id: org }, g.token), `intrekken als ${naam} (org ${org === w.orgId ? 1 : 2})`);
          geweigerd(await rpc('reopen_contract', { p_contract_id: id, p_organization_id: org }, g.token), `terug naar concept als ${naam} (org ${org === w.orgId ? 1 : 2})`);
        }
      }
    }
    wachtNogOpHandtekening(doel.c.id, 'na pogingen van org 2');
    gelijk(contractRij(doel.c.id).title, 'Van organisatie 1', 'titel');
    if (getekend?.contract) gelijk(contractRij(getekend.contract.id).status, 'signed', 'getekend contract');
  });

  await stap('geen contract in org 2 met een klant, contract of Word-bestand uit org 1', async () => {
    const basis = { organization_id: w2.orgId, client_id: w2.klantA.id, title: 'Org 2', body: '<p>x</p>' };
    const pogingen = [
      ['klant van org 1', { client_id: w.klantA.id }],
      ['vervangt contract van org 1', { supersedes_contract_id: doel.c.id }],
      ['Word-bestand in de map van org 1', { body: '', editor_mode: 'office', body_storage_key: `${w.orgId}/contract/${randomUUID()}-buit.docx`, body_mime_type: DOCX }],
    ];
    const wordSleutel = word?.contract?.body_storage_key;
    if (wordSleutel) pogingen.push(['het Word-bestand van een contract van org 1', { body: '', editor_mode: 'office', body_storage_key: wordSleutel, body_mime_type: DOCX }]);
    const sjabloon = gelukt(await rest('contract_templates?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, name: 'Sjabloon van org 1', body: '<p>Vertrouwelijke standaardvoorwaarden org 1</p>' },
    }), 'sjabloon in org 1')[0];
    pogingen.push(['sjabloon van org 1', { template_id: sjabloon.id }]);
    for (const [naam, extra] of pogingen) {
      geweigerd(await rest('contracts?select=id', { method: 'POST', token: w2.medewerker.token, prefer: 'return=representation', body: { ...basis, ...extra } }), naam);
    }
    gelijk((await rest(`contract_templates?select=id&id=eq.${sjabloon.id}`, { token: w2.medewerker.token })).json, [], 'org 2 leest het sjabloon van org 1');
  });
}

// ── 9. De publieke pagina aan de randen ────────────────────────────────

async function publiekeRanden(w) {
  groep('Contracten · publieke pagina: randen');
  const start = await stap('contract versturen', async () => {
    const c = await nieuwContract(w, { title: 'Publieke randen' });
    return { c, ...(await verstuurEnLink(w, c.id)) };
  });
  if (!start) return;
  const { c, token } = start;

  await stap('onbekende en te korte link: nette weigering bij elke actie', async () => {
    const onzin = randomBytes(32).toString('base64url');
    const velden = { signerName: 'X', signerEmail: 'x@klant.test', signatureMethod: 'typed', consentText: AKKOORD, name: 'X', message: 'Hallo', reason: 'Nee' };
    for (const action of ['getContract', 'signContract', 'declineContract', 'askQuestion']) {
      const doe = (link) => (action === 'askQuestion' ? vraagStellen(link, velden) : publiek({ action, token: link, ...velden }));
      geweigerd(await doe(onzin), `${action} met een onbekende link`);
      geweigerd(await doe('te-kort'), `${action} met een te korte link`, [400]);
    }
    geweigerd(await publiek({ action: 'getContract' }), 'zonder link', [400]);
  });

  await stap('herkomst: Origin "null", een vreemde site en geen Origin worden geweigerd', async () => {
    for (const [naam, origin] of [['null', 'null'], ['vreemde site', 'https://kwaadwillend.example'], ['geen', '']]) {
      geweigerd(await roep('contract-public', { origin, body: { action: 'getContract', token } }), `publiek met Origin ${naam}`, [403]);
      geweigerd(await roep('contract-workflow', { origin, token: w.medewerker.token, body: { action: 'previewContractPdf', organizationId: w.orgId, contractId: c.id } }), `workflow met Origin ${naam}`, [403]);
    }
  });

  await stap('alleen POST met JSON en een bekende actie', async () => {
    geweigerd(await roep('contract-public', { method: 'GET' }), 'GET', [405]);
    geweigerd(await roep('contract-public', { body: `token=${token}`, ruw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 'geen JSON', [400]);
    geweigerd(await publiek({ action: 'verwijderAlles', token }), 'onbekende actie', [400]);
    wachtNogOpHandtekening(c.id, 'na rare verzoeken');
  });

  await stap('weigeren met te lange naam of reden: 422, er verandert niets', async () => {
    geweigerd(await publiek({ action: 'declineContract', token, name: 'N'.repeat(201), reason: 'x' }), 'naam van 201 tekens', [422]);
    geweigerd(await publiek({ action: 'declineContract', token, name: 'Contact', reason: 'r'.repeat(4001) }), 'reden van 4001 tekens', [422]);
    geweigerd(await publiek({ action: 'declineContract', token, name: '  ' }), 'weigeren zonder naam', [422]);
    wachtNogOpHandtekening(c.id, 'na geweigerd weigeren');
  });

  await stap('een vraag stellen komt in het klantdossier; te lang of te vaak wordt geweigerd', async () => {
    const vraag = `Wat betekent artikel 2? (${randomUUID()})`;
    gelukt(await vraagStellen(token, { name: 'Contact Klant A', email: w.klantA.email, message: vraag }), 'vraag stellen');
    const mail = sqlRij(`select client_id, organization_id, direction, from_email from public.client_emails where body_text = ${q(vraag)}`);
    gelijk([mail?.client_id, mail?.organization_id, mail?.direction, mail?.from_email], [w.klantA.id, w.orgId, 'inbound', w.klantA.email], 'vraag in het klantdossier');
    geweigerd(await vraagStellen(token, { name: 'Contact', message: 'v'.repeat(4001) }), 'vraag van 4001 tekens', [422]);
    for (let i = 0; i < 4; i += 1) gelukt(await vraagStellen(token, { name: 'Contact', message: `Vraag ${i + 2}` }), `vraag ${i + 2}`);
    geweigerd(await vraagStellen(token, { name: 'Contact', message: 'Vraag 6' }), 'zesde vraag binnen het uur', [409]);
    wachtNogOpHandtekening(c.id, 'na vragen');
  });

  await stap('een klantnaam met HTML wordt als tekst ingevuld, niet als opmaak', async () => {
    const klant = gelukt(await rest('clients?select=id,name,email', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, name: 'Klant <img src=x onerror=alert(4)> & Zn', email: `html.${randomUUID().slice(0, 8)}@klant.test`, client_kind: 'business' },
    }), 'klant met HTML in de naam')[0];
    const contract = await nieuwContract(w, { client_id: klant.id, title: 'Naam met HTML', body: '<p>Voor {{klantnaam}}.</p>' });
    const { token: link } = await verstuurEnLink(w, contract.id);
    const p = gelukt(await bekijk(link), 'bekijken');
    verwacht(!/<img/i.test(p.contract.body) && !/onerror\s*=/i.test(p.contract.body.replace(/&lt;[^&]*&gt;/g, '')), `HTML uit de klantnaam werkt op de pagina: ${p.contract.body}`);
    verwacht(p.contract.body.includes('&lt;img'), `de klantnaam is niet als tekst ingevuld: ${p.contract.body}`);
  });

  await stap('een verlopen link: bekijken 410, tekenen, weigeren en vragen netjes geweigerd', async () => {
    const contract = await nieuwContract(w, { title: 'Link verloopt' });
    const { token: link } = await verstuurEnLink(w, contract.id);
    // De link laten verlopen (een datum terugzetten: dat kan geen gebruiker).
    sql(`update public.contracts set public_token_expires_at = now() - interval '1 minute' where id = ${q(contract.id)}`);
    geweigerd(await bekijk(link), 'bekijken', [410]);
    geweigerd(await tekenZoalsDePagina(link, { signerEmail: w.klantA.email }), 'tekenen');
    geweigerd(await teken(link, { signerEmail: w.klantA.email, versionId: versies(contract.id)[0].id }), 'tekenen met versie');
    geweigerd(await publiek({ action: 'declineContract', token: link, name: 'Contact' }), 'weigeren');
    geweigerd(await vraagStellen(link, { name: 'Contact', message: 'Nog geldig?' }), 'vraag');
    wachtNogOpHandtekening(contract.id, 'na een verlopen link');
  });

  await stap('een ander adres ingetypt: bewijs en getekend PDF blijven bij het uitgenodigde adres', async () => {
    const contract = await nieuwContract(w, { title: 'Ander adres' });
    const { token: link } = await verstuurEnLink(w, contract.id);
    const elders = `elders.${randomUUID().slice(0, 8)}@ander-domein.test`;
    gelukt(await tekenZoalsDePagina(link, { signerName: 'Contact Klant A', signerEmail: elders }), 'tekenen');
    const [s] = ondertekenaars(contract.id);
    gelijk([s.email, s.email_verified_at], [w.klantA.email, null], 'ondertekenaar (uitgenodigd adres, niet bevestigd)');
    const gebeurtenis = gebeurtenissen(contract.id).find((e) => e.event_type === 'client_signed');
    gelijk([gebeurtenis?.metadata?.email, gebeurtenis?.metadata?.email_matches_invitation], [elders, false], 'ingetypt adres in het logboek');
    gelijk(mailsVoor(contract.id, 'contract_signed_client').map((m) => m.to), [[w.klantA.email]], 'bevestiging met het getekende PDF');
    gelijk(mailsAan(elders).length, 0, 'mails aan het ingetypte adres');
  });

  await stap('een naam met HTML bij tekenen komt als tekst in de bevestigingsmails', async () => {
    // De naam typt wie de link heeft; hij gaat naar de klant én naar het
    // bedrijfsadres, onder de afzender van de organisatie.
    const contract = await nieuwContract(w, { title: 'Naam met HTML bij tekenen' });
    const { token: link } = await verstuurEnLink(w, contract.id);
    const naam = 'Jan <a href="https://phish.example/login">Log hier in</a>';
    gelukt(await tekenZoalsDePagina(link, { signerName: naam, signerEmail: w.klantA.email }), 'tekenen');
    const mails = [...mailsVoor(contract.id, 'contract_signed_client'), ...mailsVoor(contract.id, 'contract_signed_internal')];
    gelijk(mails.length, 2, 'aantal bevestigingen');
    for (const mail of mails) {
      verwacht(!mail.html.includes('<a href="https://phish.example'), `de naam is als HTML in "${mail.subject}" gekomen`);
      verwacht(mail.html.includes('Jan &lt;a href='), `de naam staat niet als tekst in "${mail.subject}"`);
    }
  });
}

// ── 10. Klantportaal ───────────────────────────────────────────────────

async function portaal(w, w2, getekend, word) {
  groep('Contracten · klantportaal');
  const vraag = (gebruiker, body) => roep('client-portal', { token: gebruiker.token, body });
  const getekendeIds = [getekend?.contract?.id, word?.contract?.id].filter(Boolean);

  await stap('portaal A downloadt het getekende PDF van zijn eigen contracten', async () => {
    verwacht(getekendeIds.length > 0, 'geen getekende contracten uit eerdere onderdelen');
    for (const id of getekendeIds) {
      const json = gelukt(await vraag(w.portaalA, { action: 'getContractPdf', contractId: id }), 'download');
      gelijk(sha256(uitBase64(json.pdf.base64)), contractRij(id).signed_document_sha256, 'PDF in het portaal is het getekende exemplaar');
    }
  });

  await stap('portaal B krijgt de contracten van klant A niet', async () => {
    for (const id of getekendeIds) geweigerd(await vraag(w.portaalB, { action: 'getContractPdf', contractId: id }), 'download door B');
  });

  const contractB = await stap('contract voor klant B versturen', async () => {
    const c = await nieuwContract(w, { client_id: w.klantB.id, title: 'Contract van klant B' });
    await verstuurEnLink(w, c.id);
    return c;
  });

  await stap('een nog niet getekend contract is niet te downloaden, ook niet voor de eigen klant', async () => {
    verwacht(contractB, 'geen contract voor B');
    geweigerd(await vraag(w.portaalB, { action: 'getContractPdf', contractId: contractB.id }), 'download van een verstuurd contract', [404]);
    geweigerd(await vraag(w.portaalB, { action: 'getContractPdf', contractId: 'geen-uuid' }), 'ongeldig id', [400]);
  });

  await stap('contractenlijst: elke klant ziet alleen zijn eigen contracten, zonder interne velden', async () => {
    const lijst = async (g) => gelukt(await vraag(g, { action: 'getPortalData' }), 'portaalgegevens').accounts.flatMap((a) => a.contracts);
    const vanA = await lijst(w.portaalA);
    const vanB = await lijst(w.portaalB);
    const idsA = vanA.map((x) => x.id);
    const idsB = vanB.map((x) => x.id);
    for (const id of getekendeIds) verwacht(idsA.includes(id) && !idsB.includes(id), `contract ${id} staat niet (alleen) bij klant A`);
    if (contractB) verwacht(idsB.includes(contractB.id) && !idsA.includes(contractB.id), 'het contract van B staat niet (alleen) bij B');
    const velden = new Set(['id', 'number', 'title', 'status', 'date', 'valid_until', 'signed_at']);
    const extra = [...vanA, ...vanB].flatMap((x) => Object.keys(x)).filter((k) => !velden.has(k));
    gelijk([...new Set(extra)], [], 'velden in de contractenlijst van het portaal');
    verwacht(!JSON.stringify([vanA, vanB]).includes('maximaal 10% korting'), 'interne notitie in het portaal');
  });

  await stap('portaalgebruikers lezen geen contracten rechtstreeks uit de database', async () => {
    for (const g of [w.portaalA, w.portaalB]) {
      for (const tabel of ['contracts', 'contract_signers', 'contract_versions']) {
        gelijk((await rest(`${tabel}?select=id&organization_id=eq.${w.orgId}`, { token: g.token })).json, [], `${tabel} via PostgREST`);
      }
    }
  });

  await stap('portaalgebruiker van een andere organisatie: geen toegang', async () => {
    verwacht(w2, 'geen tweede organisatie');
    for (const id of getekendeIds) geweigerd(await vraag(w2.portaalA, { action: 'getContractPdf', contractId: id }), 'download door een klant van org 2');
  });
}

// ── 11. Tegelijk ───────────────────────────────────────────────────────

async function tegelijk(w) {
  groep('Contracten · tegelijk');
  await stap('twee keer tegelijk tekenen: één handtekening, één bevestiging', async () => {
    const c = await nieuwContract(w, { title: 'Dubbelklik' });
    const { token } = await verstuurEnLink(w, c.id);
    const p = gelukt(await bekijk(token), 'bekijken');
    const velden = { signerName: 'Contact Klant A', signerEmail: w.klantA.email, versionId: p.contract.version_id };
    const uitkomsten = await Promise.all([teken(token, velden), teken(token, velden)]);
    const statussen = uitkomsten.map((r) => r.status).sort();
    verwacht(statussen[0] === 200 && statussen[1] >= 400 && statussen[1] < 500, `verwacht één 200 en één 4xx, kreeg ${statussen}`);
    gelijk(gebeurtenissen(c.id).filter((e) => e.event_type === 'client_signed').length, 1, 'aantal handtekening-gebeurtenissen');
    gelijk(mailsVoor(c.id, 'contract_signed_client').length, 1, 'aantal bevestigingen');
  });

  await stap('twee keer tegelijk versturen en de tweede mislukt: de link in de verstuurde mail werkt', async () => {
    // Twee collega's (of twee tabbladen) versturen hetzelfde contract. Beide
    // lezen eerst de huidige link en maken dan elk een nieuwe. Mislukt de
    // tweede ná zijn nieuwe link (in het echt: de versienummers botsen, of
    // Resend faalt), dan zet hij terug wat hij vóór de eerste zag. De mail van
    // de eerste is dan al weg, met een link die niet meer bestaat.
    // Met de contractrij even vast staan beide verzendingen op dat punt in de
    // rij; de mail van de tweede faalt daarna (netwerkfout naar Resend).
    const c = await nieuwContract(w, { title: 'Twee keer tegelijk versturen' });
    const verzendregels = () => sqlRijen(`select id from public.contract_email_deliveries
      where contract_id = ${q(c.id)} order by created_at, id`);
    const faalDeTweede = async (_url, verzoek) => {
      const regels = await wachtOp(() => (verzendregels().length >= 2 ? verzendregels() : null), 'twee verzendregels');
      if ((verzoek.headers.get('idempotency-key') || '').endsWith(regels[1].id)) throw new TypeError('fetch failed (tests/stromen: tweede verzending)');
    };
    const uitkomsten = await metOnderschepping(/^https:\/\/api\.resend\.com\//, faalDeTweede, async () => {
      const rij = await houdRijVast(c.id);
      try {
        const eerste = verstuur(w, c.id);
        await wachtOp(() => rij.wachtenden() >= 1, 'eerste verzending wacht op de rij');
        const tweede = verstuur(w, c.id);
        await wachtOp(() => rij.wachtenden() >= 2, 'tweede verzending wacht op de rij');
        await rij.loslaten();
        return await Promise.all([eerste, tweede]);
      } finally {
        await rij.loslaten();
      }
    });
    gelijk(uitkomsten.map((r) => r.status === 200), [true, false], 'gelukt: eerste, tweede');
    const mails = mailsVoor(c.id, 'contract_sent');
    gelijk(mails.length, 1, 'verstuurde mails');
    const rij = contractRij(c.id);
    gelijk(rij.status, 'sent', 'status');
    verwacht(rij.public_token_hash === sha256(linkUit(mails[0])),
      `de klant kreeg een link die niet werkt; de link in de database is ${rij.public_token_hash ? 'een andere' : 'leeg'}`);
    gelukt(await bekijk(linkUit(mails[0])), 'de link uit de mail openen');
  });

  await stap('de klant tekent terwijl je opnieuw verstuurt: nette weigering, geen 500', async () => {
    // Opnieuw versturen kijkt eerst naar de status en maakt dan pas de nieuwe
    // link. Tekent de klant precies daartussen (hier: terwijl het Word-document
    // wordt omgezet), dan hoort de verzender te horen dat het contract al is
    // getekend, niet "server- of providerfout".
    const sleutel = `${w.orgId}/contract/${randomUUID()}-tegelijk.docx`;
    post.media.set(sleutel, 'Contract dat tegelijk wordt getekend');
    const c = await nieuwContract(w, { title: 'Tekenen tijdens versturen', body: '', editor_mode: 'office', body_storage_key: sleutel, body_mime_type: DOCX, body_size_bytes: 9_000 });
    const { token } = await verstuurEnLink(w, c.id);
    const p = gelukt(await bekijk(token), 'bekijken');
    let getekend = null;
    const res = await metOnderschepping(/\/internal\/office\/convert-pdf$/, async () => {
      if (getekend) return;
      getekend = await teken(token, { signerName: 'Contact Klant A', signerEmail: w.klantA.email, versionId: p.contract.version_id });
    }, () => verstuur(w, c.id));
    gelukt(getekend, 'de klant tekent tijdens het opnieuw versturen');
    gelijk(contractRij(c.id).status, 'signed', 'status');
    gelijk(mailsVoor(c.id, 'contract_sent').length, 1, 'aantal verstuurmails');
    geweigerd(res, 'opnieuw versturen van een zojuist getekend contract');
  });
}
