// Marketing: een campagne versturen, volgen, pauzeren, annuleren en afmelden,
// en een follow-up-stroom. De echte functies `campaigns`, `email-unsubscribe`
// en `resend-webhook`; Resend is nep (nepdiensten.mjs).
//
// Geschreven bij de controle van 7 november 2026
// (docs/rapporten/CONTROLE_MARKETING_2026-11-07.md). Elke stap die met
// "tot november 2026" begint, faalde op de code van vóór die controle.
//
// De batch is hier vijf (omgeving.mjs), zodat twaalf klanten al over drie
// verzendrondes lopen. De verzendronde (cron) raakt alle organisaties; dit is
// het enige scenario met campagnes, en het kijkt alleen naar zijn eigen.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { roep } from './functies.mjs';
import { mailsAan, post } from './nepdiensten.mjs';
import { AFMELD_GEHEIM, CRON_SECRET, RESEND_WEBHOOK_GEHEIM } from './omgeving.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';
import { makeUnsubscribeToken } from '../../supabase/functions/_shared/unsubscribe.ts';

// ── Haken in het verkeer naar buiten ─────────────────────────────────────────
// Een stap kan iets laten gebeuren op een precies moment: midden in het
// klaarzetten van de ontvangers, of tussen twee mails van een batch in.
// De haken kijken naar een kopie; de aanroep zelf gaat ongewijzigd door.
const haken = new Set();
const vorigeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (haken.size > 0) {
    const kopie = input instanceof Request ? input.clone() : new Request(String(input), init);
    for (const haak of [...haken]) await haak(kopie);
  }
  return vorigeFetch(input, init);
};

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

async function lid(orgId, naam, rol, modules) {
  const gebruiker = await maakGebruiker(naam);
  sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
       values (${q(orgId)}, ${q(gebruiker.id)}, ${q(gebruiker.email)}, ${q(rol)}, 'active', ${modules ? `${q(JSON.stringify(modules))}::jsonb` : `'{}'::jsonb`})`);
  return gebruiker;
}

function actie(w, gebruiker, action, extra = {}) {
  return roep('campaigns', { token: gebruiker.token, body: { action, organizationId: w.orgId, ...extra } });
}

/** De verzendronde zoals pg_cron hem aanroept: POST, geen origin, het geheim in de header. */
function ronde(soort = 'dispatch') {
  return roep('campaigns', { query: `cron=${soort}`, origin: null, headers: { 'x-cron-secret': CRON_SECRET } });
}

const LABEL = 'nieuwsbrief';
const DOELGROEP = { mode: 'filter', statuses: [], tags: [LABEL], includeContacts: false, manualClientIds: [], customFilters: [] };

/** Een concept zoals repository.createCampaign het opslaat. */
async function concept(w, gebruiker, velden = {}) {
  const res = await rest('email_campaigns?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: gebruiker.id, name: uniek('Campagne'), subject: 'Nieuws voor {{klantnaam}}',
      preheader: null, body_html: '<p>Beste {{klantnaam}}, dit is ons nieuws.</p>', body_text: null, accent_color: null,
      audience: DOELGROEP, status: 'draft', ...velden,
    },
  });
  gelukt(res, 'campagne opslaan');
  return res.json[0];
}

function mailsVan(campagneId) {
  return post.mails.filter((mail) => mail.tags.some((tag) => tag.name === 'campaign_id' && tag.value === campagneId));
}

function campagne(id) {
  return sqlRij(`select status, started_at, sent_at from public.email_campaigns where id = ${q(id)}`);
}

function ontvangers(id) {
  return sqlRij(`select count(*)::int as totaal,
      count(*) filter (where status = 'pending')::int as wachtend,
      count(*) filter (where status = 'skipped')::int as overgeslagen,
      count(*) filter (where sent_at is not null)::int as verstuurd
    from public.email_campaign_recipients where campaign_id = ${q(id)}`);
}

/** Verzendrondes tot de campagne klaar is (of het maximum). */
async function rondAf(id, max = 6) {
  for (let i = 0; i < max && campagne(id).status === 'sending'; i += 1) gelukt(await ronde(), 'verzendronde');
}

function afmeldToken(mail) {
  const m = `${mail.html} ${mail.text}`.match(/email-unsubscribe\?token=([A-Za-z0-9_%.-]+)/);
  verwacht(m, 'geen afmeldlink in de mail');
  return decodeURIComponent(m[1]);
}

function afmelden(token, { methode = 'POST', oneClick = false } = {}) {
  return roep('email-unsubscribe', {
    method: methode, query: `token=${encodeURIComponent(token)}`, origin: null,
    ...(oneClick ? { body: 'List-Unsubscribe=One-Click', ruw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}),
  });
}

function blokkade(w, email) {
  return sqlRij(`select reason, source from public.email_suppressions where organization_id = ${q(w.orgId)} and email = ${q(email)}`);
}

/** Een webhook zoals Resend hem stuurt: Svix-handtekening over id.tijd.body. */
async function webhook(payload) {
  const body = JSON.stringify(payload);
  const id = `msg_${randomUUID()}`;
  const tijd = Math.floor(Date.now() / 1000).toString();
  const sleutel = Buffer.from(RESEND_WEBHOOK_GEHEIM.replace(/^whsec_/, ''), 'base64');
  const handtekening = createHmac('sha256', sleutel).update(`${id}.${tijd}.${body}`).digest('base64');
  return roep('resend-webhook', {
    body, ruw: true, origin: null,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': tijd, 'svix-signature': `v1,${handtekening}` },
  });
}

/** De kolommen waarmee het scherm de ontvangers van een campagne laadt (src/lib/repository.ts). */
function schermKolommen() {
  const bron = readFileSync(new URL('../../src/lib/repository.ts', import.meta.url), 'utf8');
  const m = bron.match(/const CAMPAIGN_RECIPIENT_COLUMNS = '([^']+)'/);
  if (!m) throw new Error('CAMPAIGN_RECIPIENT_COLUMNS niet gevonden in repository.ts');
  return m[1];
}

export default async function marketing() {
  groep('Marketing: campagne versturen en volgen');
  const w = await stap('werkruimte met twaalf klanten met het label nieuwsbrief', async () => {
    const wereld = await maakWereld('marketing');
    wereld.marketeer = await lid(wereld.orgId, 'marketing-zonder-klanten', 'member', { clients: 'none' });
    wereld.geenMarketing = await lid(wereld.orgId, 'marketing-geen', 'member', { marketing: 'none' });
    wereld.klanten = [];
    for (let i = 1; i <= 12; i += 1) {
      const email = `nieuws-${i}.${uniek('m')}@klant.test`.toLowerCase();
      const res = await rest('clients?select=id,name,email', {
        method: 'POST', token: wereld.medewerker.token, prefer: 'return=representation',
        body: { organization_id: wereld.orgId, name: `Bakkerij ${i}`, email, tags: [LABEL], client_kind: 'business' },
      });
      gelukt(res, `klant ${i}`);
      wereld.klanten.push(res.json[0]);
    }
    return wereld;
  });
  if (!w) return;
  const ander = await stap('een tweede werkruimte', () => maakWereld('marketing-ander'));

  // Een lid probeert de campagne op naam van de eigenaar te zetten.
  const c1 = await stap('een lid slaat een concept op', () => concept(w, w.medewerker, { created_by: w.eigenaar.id }));
  if (!c1) return;

  await stap('een concept staat altijd op naam van wie het maakte', async () => {
    // Tot november 2026 nam de database created_by over van de aanvrager. De
    // mail gaat uit met de persoonlijke afzender van created_by: een lid kon
    // een campagne zo op naam van de eigenaar laten uitgaan.
    gelijk(c1.created_by, w.medewerker.id, 'maker na aanmaken');
    await rest(`email_campaigns?id=eq.${c1.id}`, { method: 'PATCH', token: w.medewerker.token, body: { created_by: w.eigenaar.id } });
    gelijk(sqlRij(`select created_by from public.email_campaigns where id = ${q(c1.id)}`).created_by, w.medewerker.id, 'maker na wijzigen');
  });

  await stap('de telling: twaalf ontvangers, met adressen voor wie Klanten mag lezen', async () => {
    const res = gelukt(await actie(w, w.medewerker, 'previewAudience', { audience: DOELGROEP }), 'telling');
    gelijk(res.sendable, 12, 'te versturen');
    gelijk(res.sample.length, 12, 'voorbeeldadressen');
  });

  await stap('zonder Klanten: wel de telling, geen adressen', async () => {
    // Tot november 2026 kreeg dit lid twintig adressen met naam terug.
    const res = gelukt(await actie(w, w.marketeer, 'previewAudience', { audience: DOELGROEP }), 'telling');
    gelijk(res.sendable, 12, 'te versturen');
    gelijk(res.sample, [], 'voorbeeldadressen');
  });

  await stap('testmail: een echte klant voor wie Klanten mag lezen, voorbeeldwaarden voor wie niet', async () => {
    gelukt(await actie(w, w.medewerker, 'sendTestCampaign', { campaignId: c1.id, testEmail: w.medewerker.email }), 'testmail lid');
    const echt = mailsAan(w.medewerker.email).at(-1);
    verwacht(/Bakkerij \d+/.test(echt.html), 'de testmail van het lid noemt geen echte klant');
    gelukt(await actie(w, w.marketeer, 'sendTestCampaign', { campaignId: c1.id, testEmail: w.marketeer.email }), 'testmail zonder Klanten');
    const voorbeeld = mailsAan(w.marketeer.email).at(-1);
    // Tot november 2026 stond hier de naam van een echte klant in.
    verwacht(!/Bakkerij \d+/.test(`${voorbeeld.html} ${voorbeeld.subject}`), 'de testmail toont een klant aan wie Klanten niet mag zien');
    verwacht(voorbeeld.html.includes('[Klantnaam]'), 'geen voorbeeldwaarde in de testmail');
  });

  await stap('een testmail gaat alleen naar het eigen team', async () => {
    geweigerd(await actie(w, w.medewerker, 'sendTestCampaign', { campaignId: c1.id, testEmail: 'iemand@elders.test' }), 'extern adres', [403]);
  });

  await stap('kijker, boekhouder, lid zonder Marketing en een andere werkruimte kunnen niet versturen', async () => {
    geweigerd(await actie(w, w.kijker, 'sendCampaign', { campaignId: c1.id }), 'kijker', [403]);
    geweigerd(await actie(w, w.boekhouder, 'previewAudience', { audience: DOELGROEP }), 'boekhouder', [403]);
    geweigerd(await actie(w, w.geenMarketing, 'previewAudience', { audience: DOELGROEP }), 'lid zonder Marketing', [403]);
    if (ander) geweigerd(await actie(w, ander.eigenaar, 'sendCampaign', { campaignId: c1.id }), 'eigenaar van een andere werkruimte', [403]);
    gelijk(mailsVan(c1.id).length, 0, 'mails van de campagne');
  });

  await stap('nu versturen, terwijl de verzendronde midden in het klaarzetten valt: iedereen krijgt hem', async () => {
    // Tot november 2026 zag de ronde hier een campagne zonder ontvangers, zette
    // hem op "verzonden", en kregen alleen de eerste vijf (de eerste batch) de mail.
    let gestart = false;
    const wedloop = async (request) => {
      const url = new URL(request.url);
      if (gestart || url.pathname !== '/rest/v1/clients') return;
      if (url.searchParams.get('organization_id') !== `eq.${w.orgId}`) return;
      if (!(url.searchParams.get('select') ?? '').startsWith('id,name,contact_name')) return;
      gestart = true;
      gelukt(await ronde(), 'verzendronde tijdens het klaarzetten');
    };
    haken.add(wedloop);
    try {
      gelukt(await actie(w, w.medewerker, 'sendCampaign', { campaignId: c1.id }), 'versturen');
    } finally {
      haken.delete(wedloop);
    }
    verwacht(gestart, 'de verzendronde liep niet tijdens het klaarzetten');
    await rondAf(c1.id);
    gelijk(mailsVan(c1.id).length, 12, 'verstuurde mails');
    gelijk(campagne(c1.id).status, 'sent', 'status');
    gelijk(ontvangers(c1.id), { totaal: 12, wachtend: 0, overgeslagen: 0, verstuurd: 12 }, 'ontvangers');
  });

  await stap('de ontvangerslijst laadt zoals het scherm hem opvraagt', async () => {
    // Tot november 2026 vroeg het scherm een kolom die niet bestaat (created_by),
    // en weigerde PostgREST de hele vraag.
    const res = await rest(`email_campaign_recipients?select=${schermKolommen()}&organization_id=eq.${w.orgId}&campaign_id=eq.${c1.id}&order=created_at.asc`, { token: w.medewerker.token });
    gelukt(res, 'ontvangers laden');
    gelijk(res.json.length, 12, 'ontvangers');
  });

  await stap('elke mail heeft een afmeldlink en de headers voor afmelden met één klik', async () => {
    for (const mail of mailsVan(c1.id)) {
      afmeldToken(mail);
      verwacht(/Afmelden: http/.test(mail.text), 'geen afmeldlink in de tekstversie');
      verwacht(/email-unsubscribe\?token=/.test(mail.headers['List-Unsubscribe'] ?? ''), 'List-Unsubscribe ontbreekt');
      gelijk(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', 'List-Unsubscribe-Post');
      verwacht(!/\{\{/.test(`${mail.subject} ${mail.html}`), `een variabele bleef staan: ${mail.subject}`);
    }
  });

  await stap('een opening via de webhook komt bij de ontvanger terecht', async () => {
    const mail = mailsVan(c1.id)[0];
    gelukt(await webhook({ type: 'email.opened', created_at: new Date().toISOString(), data: { email_id: mail.id } }), 'webhook');
    const r = sqlRij(`select status, opened_at from public.email_campaign_recipients where campaign_id = ${q(c1.id)} and to_email = ${q(mail.to[0])}`);
    gelijk(r.status, 'opened', 'status');
    verwacht(r.opened_at, 'geen openingsmoment');
  });

  await stap('een spamklacht na een handmatige blokkade wordt een klacht die blijft staan', async () => {
    // Tot november 2026 bleef de reden "handmatig", en kon het team de blokkade
    // van iemand die spam meldde gewoon weer opheffen.
    const mail = mailsVan(c1.id)[1];
    const adres = mail.to[0];
    gelukt(await rest('email_suppressions?on_conflict=organization_id,email', {
      method: 'POST', token: w.medewerker.token, prefer: 'resolution=ignore-duplicates',
      body: { organization_id: w.orgId, email: adres, reason: 'manual', source: 'handmatig', created_by: w.medewerker.id },
    }), 'handmatig blokkeren');
    gelukt(await webhook({ type: 'email.complained', created_at: new Date().toISOString(), data: { email_id: mail.id } }), 'webhook');
    gelijk(blokkade(w, adres)?.reason, 'complained', 'reden');
    nietsVeranderd(await rest(`email_suppressions?organization_id=eq.${w.orgId}&email=eq.${encodeURIComponent(adres)}`, {
      method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation',
    }), 'klacht weghalen');
    gelijk(blokkade(w, adres)?.reason, 'complained', 'reden na de poging');
  });

  groep('Marketing: pauzeren en annuleren');
  await stap('pauzeren stopt ook de batch die al loopt; hervatten maakt hem af', async () => {
    // Tot november 2026 ging na "Pauzeer" de rest van de batch nog de deur uit.
    const c = await concept(w, w.medewerker);
    let geteld = 0;
    const pauze = async (request) => {
      if (request.url !== 'https://api.resend.com/emails') return;
      const body = await request.clone().json();
      if (!body.tags?.some((tag) => tag.name === 'campaign_id' && tag.value === c.id)) return;
      geteld += 1;
      if (geteld === 2) sql(`update public.email_campaigns set status = 'paused' where id = ${q(c.id)}`);
    };
    haken.add(pauze);
    try {
      gelukt(await actie(w, w.medewerker, 'sendCampaign', { campaignId: c.id }), 'versturen');
    } finally {
      haken.delete(pauze);
    }
    // Het adres met de spamklacht hierboven valt af: elf ontvangers, drie rondes.
    const { totaal } = ontvangers(c.id);
    gelijk(totaal, 11, 'ontvangers');
    gelijk(mailsVan(c.id).length, 2, 'mails tot aan de pauze');
    gelijk(ontvangers(c.id).wachtend, totaal - 2, 'wachtend na de pauze');
    gelukt(await ronde(), 'verzendronde tijdens de pauze');
    gelijk(mailsVan(c.id).length, 2, 'mails tijdens de pauze');
    gelukt(await actie(w, w.medewerker, 'resumeCampaign', { campaignId: c.id }), 'hervatten');
    await rondAf(c.id);
    gelijk(mailsVan(c.id).length, totaal, 'mails na hervatten');
    gelijk(campagne(c.id).status, 'sent', 'status');
  });

  await stap('annuleren: wat nog wacht, gaat nooit meer uit en staat ook niet meer als wachtend', async () => {
    // Tot november 2026 bleven die ontvangers op "In wachtrij" staan.
    const c = await concept(w, w.medewerker);
    gelukt(await actie(w, w.medewerker, 'sendCampaign', { campaignId: c.id }), 'versturen');
    gelijk(mailsVan(c.id).length, 5, 'eerste batch');
    gelukt(await actie(w, w.medewerker, 'cancelCampaign', { campaignId: c.id }), 'annuleren');
    gelukt(await ronde(), 'verzendronde');
    gelijk(mailsVan(c.id).length, 5, 'mails na annuleren');
    gelijk(ontvangers(c.id), { totaal: 11, wachtend: 0, overgeslagen: 6, verstuurd: 5 }, 'ontvangers');
    const stats = await rest(`email_campaign_stats?select=pending,total&campaign_id=eq.${c.id}`, { token: w.medewerker.token });
    gelijk(gelukt(stats, 'tellingen')[0].pending, 0, 'wachtend in de tellingen');
  });

  await stap('viel het klaarzetten om, dan maakt de verzendronde het na tien minuten af', async () => {
    // Een campagne op "verzenden" zonder started_at: sendCampaign viel om na
    // het claimen. Vers: de ronde laat hem met rust (hij wordt nog klaargezet).
    // Na de wachttijd zet de ronde de ontvangers zelf klaar en verstuurt hij.
    const c = await concept(w, w.medewerker);
    sql(`update public.email_campaigns set status = 'sending', started_at = null where id = ${q(c.id)}`);
    gelukt(await ronde(), 'verzendronde');
    gelijk({ status: campagne(c.id).status, ontvangers: ontvangers(c.id).totaal }, { status: 'sending', ontvangers: 0 }, 'vers omgevallen');
    // De wachttijd voorbij: updated_at terugzetten zonder de trigger die hem bijwerkt.
    sql(`begin; set local session_replication_role = replica;
         update public.email_campaigns set updated_at = now() - interval '11 minutes' where id = ${q(c.id)}; commit;`);
    const res = gelukt(await ronde(), 'verzendronde na de wachttijd');
    verwacht(res.recovered >= 1, `niet hersteld: ${JSON.stringify(res)}`);
    verwacht(campagne(c.id).started_at, 'started_at is niet gezet');
    await rondAf(c.id);
    gelijk(campagne(c.id).status, 'sent', 'status');
    gelijk(mailsVan(c.id).length, ontvangers(c.id).totaal, 'mails');
  });

  groep('Marketing: afmelden');
  const ontvanger = (i) => mailsVan(c1.id)[i];

  await stap('de afmeldlink toont eerst een bevestiging en meldt pas af na de knop', async () => {
    const mail = ontvanger(2);
    const token = afmeldToken(mail);
    const pagina = await afmelden(token, { methode: 'GET' });
    gelijk(pagina.status, 200, 'status van de pagina');
    verwacht(pagina.tekst.includes('Ja, meld mij af'), 'geen bevestigknop');
    gelijk(blokkade(w, mail.to[0]), null, 'al afgemeld na alleen openen');
    const klaar = await afmelden(token);
    gelijk(klaar.status, 200, 'status na bevestigen');
    verwacht(klaar.tekst.includes('Je bent afgemeld'), 'geen bevestiging');
    gelijk(blokkade(w, mail.to[0]), { reason: 'unsubscribed', source: 'link' }, 'blokkade');
  });

  await stap('afmelden met één klik (RFC 8058) werkt ook', async () => {
    const mail = ontvanger(3);
    const res = await afmelden(afmeldToken(mail), { oneClick: true });
    gelijk(res.status, 200, 'status');
    gelijk(blokkade(w, mail.to[0])?.reason, 'unsubscribed', 'reden');
  });

  await stap('een afmelding kan het team niet terugdraaien', async () => {
    // Tot november 2026 haalde "Weer toestaan" hem gewoon weg.
    const adres = ontvanger(2).to[0];
    nietsVeranderd(await rest(`email_suppressions?organization_id=eq.${w.orgId}&email=eq.${encodeURIComponent(adres)}`, {
      method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation',
    }), 'afmelding weghalen als lid');
    nietsVeranderd(await rest(`email_suppressions?organization_id=eq.${w.orgId}&email=eq.${encodeURIComponent(adres)}`, {
      method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation',
    }), 'afmelding weghalen als eigenaar');
    gelijk(blokkade(w, adres)?.reason, 'unsubscribed', 'reden');
  });

  await stap('een eigen, handmatige blokkade kan het team wel opheffen', async () => {
    const adres = ontvanger(4).to[0];
    gelukt(await rest('email_suppressions?on_conflict=organization_id,email', {
      method: 'POST', token: w.medewerker.token, prefer: 'resolution=ignore-duplicates',
      body: { organization_id: w.orgId, email: adres, reason: 'manual', source: 'handmatig', created_by: w.medewerker.id },
    }), 'blokkeren');
    const weg = await rest(`email_suppressions?organization_id=eq.${w.orgId}&email=eq.${encodeURIComponent(adres)}`, {
      method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation',
    });
    gelijk(gelukt(weg, 'opheffen').length, 1, 'opgeheven rijen');
    gelijk(blokkade(w, adres), null, 'blokkade na opheffen');
  });

  await stap('afmelden na een handmatige blokkade maakt er een afmelding van', async () => {
    // Tot november 2026 bleef de reden "handmatig", en kon het team de
    // blokkade (en daarmee de afmelding) weer opheffen.
    const mail = ontvanger(5);
    const adres = mail.to[0];
    gelukt(await rest('email_suppressions?on_conflict=organization_id,email', {
      method: 'POST', token: w.medewerker.token, prefer: 'resolution=ignore-duplicates',
      body: { organization_id: w.orgId, email: adres, reason: 'manual', source: 'handmatig', created_by: w.medewerker.id },
    }), 'blokkeren');
    gelijk((await afmelden(afmeldToken(mail))).status, 200, 'afmelden');
    gelijk(blokkade(w, adres)?.reason, 'unsubscribed', 'reden');
    nietsVeranderd(await rest(`email_suppressions?organization_id=eq.${w.orgId}&email=eq.${encodeURIComponent(adres)}`, {
      method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation',
    }), 'afmelding weghalen');
  });

  await stap('een afmeldlink met een vervalste handtekening werkt niet', async () => {
    const token = afmeldToken(ontvanger(6));
    const [payload] = token.split('.');
    const vals = `${payload}.${'A'.repeat(43)}`;
    const res = await afmelden(vals);
    gelijk(res.status, 400, 'status');
    verwacht(res.tekst.includes('Ongeldige afmeldlink'), 'geen melding');
    gelijk(blokkade(w, ontvanger(6).to[0]), null, 'toch afgemeld');
  });

  await stap('lukt het opslaan van een afmelding niet, dan zegt de pagina dat ook', async () => {
    // Tot november 2026 las de ontvanger "Je bent afgemeld", ook als er niets
    // was opgeslagen. Hier: een geldige link van een werkruimte die niet meer bestaat.
    const token = await makeUnsubscribeToken(AFMELD_GEHEIM, randomUUID(), 'iemand@klant.test');
    const res = await afmelden(token);
    gelijk(res.status, 500, 'status');
    verwacht(!res.tekst.includes('Je bent afgemeld'), 'de pagina meldt een afmelding die niet is opgeslagen');
  });

  await stap('wie zich afmeldde, valt uit de volgende campagne', async () => {
    const res = gelukt(await actie(w, w.medewerker, 'previewAudience', { audience: DOELGROEP }), 'telling');
    // Afgemeld: ontvanger 2, 3 en 5; geklaagd: ontvanger 1.
    gelijk({ te: res.sendable, af: res.suppressed }, { te: 8, af: 4 }, 'telling');
  });

  groep('Marketing: follow-up-stroom');
  const stroom = await stap('een stroom aanmaken (op naam van de maker) en de stappen zetten', async () => {
    const res = await rest('email_flows?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.eigenaar.id, name: uniek('Stroom'), audience: DOELGROEP, stop_condition: 'reply', status: 'draft' },
    });
    const f = gelukt(res, 'stroom opslaan')[0];
    gelijk(f.created_by, w.medewerker.id, 'maker');
    gelukt(await rpc('replace_flow_steps', {
      p_organization_id: w.orgId, p_flow_id: f.id, p_steps: [
        { step_index: 0, delay_days: 0, subject: 'Welkom {{klantnaam}}', body_html: '<p>Hallo {{klantnaam}}</p>' },
        { step_index: 1, delay_days: 3, subject: 'Nog even dit', body_html: '<p>Nog een vraag</p>' },
      ],
    }, w.medewerker.token), 'stappen zetten');
    return f;
  });

  await stap('activeren: wie niet is afgemeld, krijgt de eerste mail met een afmeldlink', async () => {
    if (!stroom) throw new Error('geen stroom');
    const res = gelukt(await actie(w, w.medewerker, 'activateFlow', { flowId: stroom.id }), 'activeren');
    gelijk(res.enrolled, 8, 'ingeschreven');
    const mails = post.mails.filter((mail) => mail.tags.some((tag) => tag.name === 'flow_id' && tag.value === stroom.id));
    gelijk(mails.length, 8, 'eerste mails');
    for (const mail of mails) {
      verwacht(/email-unsubscribe\?token=/.test(mail.headers['List-Unsubscribe'] ?? ''), 'List-Unsubscribe ontbreekt');
      verwacht(/^Welkom Bakkerij \d+$/.test(mail.subject), `onderwerp: ${mail.subject}`);
    }
  });

  await stap('afmelden via een stroommail stopt de stroom voor dat adres', async () => {
    if (!stroom) throw new Error('geen stroom');
    const mail = post.mails.find((m) => m.tags.some((tag) => tag.name === 'flow_id' && tag.value === stroom.id));
    gelijk((await afmelden(afmeldToken(mail))).status, 200, 'afmelden');
    const inschrijving = sqlRij(`select status from public.email_flow_enrollments where flow_id = ${q(stroom.id)} and to_email = ${q(mail.to[0])}`);
    gelijk(inschrijving.status, 'stopped_unsubscribed', 'inschrijving');
  });
}
