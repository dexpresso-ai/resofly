// Eigen verzenddomein: koppelen, verifiëren, versturen vanaf het eigen adres,
// en de grenzen tussen organisaties in het gedeelde Resend-account. De echte
// `mail`- en `resend-webhook`-functie; Resend (ook de Domains-API) is nep.
import { createHmac, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { mailsAan, post, zetDomeinStatus } from './nepdiensten.mjs';
import { RESEND_WEBHOOK_GEHEIM } from './omgeving.mjs';
import { rest, sql, sqlRij, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const PLATFORM_FROM = 'ResoFly <noreply@resofly.test>';
const PLATFORM_REPLY = 'hallo@resofly.test';

function domeinNaam(prefix) {
  return `${uniek(prefix)}.nl`.toLowerCase();
}

function actie(w, gebruiker, action, extra = {}) {
  return roep('mail', { token: gebruiker.token, body: { action, organizationId: w.orgId, ...extra } });
}

function rij(id) {
  return sqlRij(`select id, organization_id, domain, status, from_email, from_name, resend_domain_id, verified_at, is_default,
    jsonb_array_length(dns_records) as records from public.organization_email_domains where id = '${id}'`);
}

function rijVoorDomein(domein) {
  return sqlRij(`select id, organization_id, status, resend_domain_id from public.organization_email_domains where domain = '${domein}'`);
}

/** Een testmail aan jezelf en de mail die bij nep-Resend binnenkwam. */
async function testmail(w) {
  const voor = mailsAan(w.eigenaar.email).length;
  gelukt(await actie(w, w.eigenaar, 'sendTestEmail', { recipientEmail: w.eigenaar.email }), 'testmail');
  const mails = mailsAan(w.eigenaar.email);
  gelijk(mails.length, voor + 1, 'aantal testmails');
  return mails[mails.length - 1];
}

/** Een webhook zoals Resend hem stuurt: Svix-handtekening over id.tijd.body. */
async function webhook(payload, { geheim = RESEND_WEBHOOK_GEHEIM } = {}) {
  const body = JSON.stringify(payload);
  const id = `msg_${randomUUID()}`;
  const tijd = Math.floor(Date.now() / 1000).toString();
  const sleutel = Buffer.from(geheim.replace(/^whsec_/, ''), 'base64');
  const handtekening = createHmac('sha256', sleutel).update(`${id}.${tijd}.${body}`).digest('base64');
  return roep('resend-webhook', {
    body, ruw: true, origin: null,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': tijd, 'svix-signature': `v1,${handtekening}` },
  });
}

function domeinEvent(type, resendId, naam) {
  return { type, created_at: new Date().toISOString(), data: { id: resendId, name: naam, status: 'verified', created_at: new Date().toISOString(), region: 'eu-west-1', records: [] } };
}

export default async function verzenddomein() {
  groep('Verzenddomein: koppelen en verifiëren');
  const a = await stap('werkruimte A maken', () => maakWereld('domeina'));
  const b = await stap('werkruimte B maken', () => maakWereld('domeinb'));
  if (!a || !b) return;
  const domein = domeinNaam('bakkerij');

  await stap('een teamlid zonder beheerrechten kan geen domein koppelen', async () => {
    geweigerd(await actie(a, a.medewerker, 'addSendingDomain', { domain: domein, fromEmail: `info@${domein}` }), 'lid', [403]);
    geweigerd(await actie(a, a.boekhouder, 'addSendingDomain', { domain: domein, fromEmail: `info@${domein}` }), 'boekhouder', [403]);
    geweigerd(await actie(b, a.eigenaar, 'addSendingDomain', { domain: domein, fromEmail: `info@${domein}` }), 'eigenaar van een andere werkruimte', [403]);
  });

  await stap('zonder afzenderadres, of met een adres op een ander domein: geweigerd, en niets bij Resend', async () => {
    const voor = post.domeinVerzoeken.length;
    const zonder = geweigerd(await actie(a, a.eigenaar, 'addSendingDomain', { domain: domein }), 'zonder adres', [422]);
    verwacht(/afzenderadres/i.test(zonder.error), `melding: ${zonder.error}`);
    geweigerd(await actie(a, a.eigenaar, 'addSendingDomain', { domain: domein, fromEmail: 'info@ander-bedrijf.nl' }), 'ander domein', [422]);
    geweigerd(await actie(a, a.eigenaar, 'addSendingDomain', { domain: domein, fromEmail: `a>,"x"@${domein}` }), 'adres met headertekens', [422]);
    geweigerd(await actie(a, a.eigenaar, 'addSendingDomain', { domain: 'mail.resofly.test', fromEmail: 'info@mail.resofly.test' }), 'domein van ResoFly zelf', [422]);
    gelijk(post.domeinVerzoeken.length, voor, 'aanvragen bij Resend');
  });

  const gekoppeld = await stap('koppelen zoals iemand het typt: domein, adres en naam worden opgeschoond', async () => {
    const res = await actie(a, a.eigenaar, 'addSendingDomain', {
      domain: `https://www.${domein.toUpperCase()}/contact`,
      fromName: 'Bakkerij "De Molen", <ceo@bank.nl>',
      fromEmail: ` Info@${domein} `,
    });
    const d = gelukt(res, 'koppelen').domain;
    gelijk(d.domain, domein, 'domein');
    gelijk(d.from_email, `info@${domein}`, 'afzenderadres');
    gelijk(d.from_name, 'Bakkerij De Molen ceo bank.nl', 'afzendernaam');
    gelijk(d.status, 'pending', 'status');
    gelijk(d.dns_records.length, 3, 'DNS-records');
    const aanvraag = post.domeinVerzoeken.findLast((v) => v.methode === 'POST' && v.pad === '/domains');
    gelijk(aanvraag.body, { name: domein, region: 'eu-west-1', capabilities: { sending: 'enabled', receiving: 'disabled' } }, 'aanvraag bij Resend');
    return d;
  });
  if (!gekoppeld) return;
  const resendId = gekoppeld.resend_domain_id;

  await stap('alle leden zien de records, niemand kan de status zelf op geverifieerd zetten', async () => {
    const lezen = await rest(`organization_email_domains?select=id,status&id=eq.${gekoppeld.id}`, { token: a.medewerker.token });
    gelijk(lezen.json?.length, 1, 'lid ziet het domein');
    const buiten = await rest(`organization_email_domains?select=id&id=eq.${gekoppeld.id}`, { token: b.eigenaar.token });
    gelijk(buiten.json?.length, 0, 'andere werkruimte ziet het domein niet');
    nietsVeranderd(await rest(`organization_email_domains?id=eq.${gekoppeld.id}`, {
      method: 'PATCH', token: a.eigenaar.token, prefer: 'return=representation', body: { status: 'verified' },
    }), 'status zelf zetten');
    gelijk(rij(gekoppeld.id).status, 'pending', 'status in de database');
  });

  await stap('nog niet geverifieerd: mail gaat via het standaardadres', async () => {
    const mail = await testmail(a);
    gelijk(mail.from, PLATFORM_FROM, 'afzender');
    gelijk(mail.replyTo, PLATFORM_REPLY, 'Reply-To');
  });

  await stap('verifiëren zonder DNS-records: blijft in afwachting', async () => {
    gelijk(gelukt(await actie(a, a.eigenaar, 'verifySendingDomain', { domainId: gekoppeld.id }), 'verifiëren').domain.status, 'pending', 'na verifiëren');
    gelijk(gelukt(await actie(a, a.eigenaar, 'refreshSendingDomain', { domainId: gekoppeld.id }), 'verversen').domain.status, 'pending', 'na verversen');
    geweigerd(await actie(a, a.medewerker, 'refreshSendingDomain', { domainId: gekoppeld.id }), 'verversen door een lid', [403]);
  });

  await stap('een andere werkruimte kan het domein nu niet koppelen (net geclaimd)', async () => {
    const res = geweigerd(await actie(b, b.eigenaar, 'addSendingDomain', { domain: domein, fromEmail: `info@${domein}` }), 'B', [409]);
    verwacht(/aan het koppelen/.test(res.error), `melding: ${res.error}`);
  });

  await stap('DNS geplaatst; Resend controleert op de achtergrond en verversen pikt het op', async () => {
    post.dns.add(domein);
    post.domeinen.get(resendId).controles = 1;
    gelijk(gelukt(await actie(a, a.eigenaar, 'verifySendingDomain', { domainId: gekoppeld.id }), 'verifiëren').domain.status, 'pending', 'direct na verifiëren');
    const d = gelukt(await actie(a, a.eigenaar, 'refreshSendingDomain', { domainId: gekoppeld.id }), 'verversen').domain;
    gelijk(d.status, 'verified', 'na verversen');
    verwacht(d.verified_at, 'verified_at ontbreekt');
    verwacht(d.dns_records.every((r) => r.status === 'verified'), 'records niet als gevonden bewaard');
  });

  await stap('mail gaat nu vanaf het eigen adres, en antwoorden komen bij de organisatie', async () => {
    const mail = await testmail(a);
    gelijk(mail.from, `"Bakkerij De Molen ceo bank.nl" <info@${domein}>`, 'afzender');
    gelijk(mail.replyTo, `info@${domein}`, 'Reply-To');
  });

  await stap('een andere werkruimte kan het domein, een subdomein of het bovenliggende domein niet koppelen', async () => {
    for (const poging of [domein, `mail.${domein}`]) {
      const res = geweigerd(await actie(b, b.eigenaar, 'addSendingDomain', { domain: poging, fromEmail: `info@${poging}` }), poging, [409]);
      verwacht(/andere werkruimte/.test(res.error), `melding: ${res.error}`);
    }
  });

  await stap('B kan een persoonlijk adres op het domein van A invullen, maar mailt er niet mee', async () => {
    const opslaan = await rest('user_sender_identities', {
      method: 'POST', token: b.medewerker.token, prefer: 'return=representation',
      body: { organization_id: b.orgId, user_id: b.medewerker.id, from_name: 'Nep', from_email: `directie@${domein}` },
    });
    gelukt(opslaan, 'persoonlijke afzender opslaan');
    const res = await roep('mail', { token: b.medewerker.token, body: {
      action: 'sendClientEmail', organizationId: b.orgId, clientId: b.klantA.id, subject: 'Hallo', bodyHtml: '<p>Test</p>',
      expectedRecipientEmail: b.klantA.email,
    } });
    gelukt(res, 'klantmail');
    const mail = mailsAan(b.klantA.email).at(-1);
    verwacht(mail.from.endsWith('<noreply@resofly.test>'), `afzender: ${mail.from}`);
    verwacht(!mail.from.includes(domein), `het domein van A staat in de afzender: ${mail.from}`);
  });

  await stap('afzender wijzigen: adres moet op het domein, naam wordt opgeschoond', async () => {
    geweigerd(await actie(a, a.eigenaar, 'updateSendingDomain', { domainId: gekoppeld.id, fromEmail: 'ceo@ander-bedrijf.nl' }), 'ander domein', [422]);
    geweigerd(await actie(a, a.eigenaar, 'updateSendingDomain', { domainId: gekoppeld.id, fromEmail: '' }), 'leeg adres', [422]);
    geweigerd(await actie(a, a.medewerker, 'updateSendingDomain', { domainId: gekoppeld.id, fromName: 'Lid' }), 'lid', [403]);
    const d = gelukt(await actie(a, a.beheerder, 'updateSendingDomain', { domainId: gekoppeld.id, fromName: 'Verkoop\r\nBcc: x@y.nl', fromEmail: `Verkoop@${domein}` }), 'wijzigen').domain;
    gelijk(d.from_email, `verkoop@${domein}`, 'adres');
    gelijk(d.from_name, 'Verkoop Bcc: x y.nl', 'naam');
    const mail = await testmail(a);
    gelijk(mail.from, `"Verkoop Bcc: x y.nl" <verkoop@${domein}>`, 'afzender');
    gelijk(mail.replyTo, `verkoop@${domein}`, 'Reply-To');
  });

  groep('Verzenddomein: Resend meldt een wijziging (webhook)');

  await stap('zonder geldige handtekening: geweigerd, niets veranderd', async () => {
    zetDomeinStatus(resendId, 'failed');
    const res = await webhook(domeinEvent('domain.updated', resendId, domein), { geheim: `whsec_${Buffer.from('verkeerd-geheim-verkeerd-geheim!').toString('base64')}` });
    gelijk(res.status, 400, 'status');
    gelijk(rij(gekoppeld.id).status, 'verified', 'status in de database');
    zetDomeinStatus(resendId, 'verified');
  });

  await stap('een DKIM-record is even weg: status hapert, mail valt terug op het standaardadres', async () => {
    const d = zetDomeinStatus(resendId, 'partially_verified', 'verified');
    d.records.find((r) => r.record === 'DKIM').status = 'temporary_failure';
    gelukt(await webhook(domeinEvent('domain.updated', resendId, domein)), 'webhook');
    gelijk(rij(gekoppeld.id).status, 'temporary_failure', 'status');
    const mail = await testmail(a);
    gelijk(mail.from, PLATFORM_FROM, 'afzender');
  });

  await stap('alles weer gevonden: de webhook zet het domein terug op geverifieerd', async () => {
    zetDomeinStatus(resendId, 'verified');
    gelukt(await webhook(domeinEvent('domain.updated', resendId, domein)), 'webhook');
    gelijk(rij(gekoppeld.id).status, 'verified', 'status');
    verwacht((await testmail(a)).from.endsWith(`<verkoop@${domein}>`), 'niet weer vanaf het eigen domein');
  });

  await stap('een event voor een onbekend domein (zoals dat van ResoFly zelf) verandert niets', async () => {
    gelukt(await webhook(domeinEvent('domain.updated', randomUUID(), 'resofly.test')), 'webhook');
    gelijk(rij(gekoppeld.id).status, 'verified', 'status');
  });

  groep('Verzenddomein: verwijderen');

  await stap('verwijderen terwijl Resend hapert: het domein blijft gekoppeld', async () => {
    post.domeinStoring = { aantal: 1, methode: 'DELETE' };
    geweigerd(await actie(a, a.eigenaar, 'removeSendingDomain', { domainId: gekoppeld.id }), 'verwijderen', [502]);
    verwacht(rij(gekoppeld.id), 'de rij is toch weg');
    verwacht(post.domeinen.has(resendId), 'het domein is bij Resend weg');
  });

  await stap('verwijderen: weg bij Resend en hier, mail weer via het standaardadres', async () => {
    geweigerd(await actie(a, a.medewerker, 'removeSendingDomain', { domainId: gekoppeld.id }), 'lid', [403]);
    gelukt(await actie(a, a.eigenaar, 'removeSendingDomain', { domainId: gekoppeld.id }), 'verwijderen');
    gelijk(rij(gekoppeld.id), null, 'rij');
    verwacht(!post.domeinen.has(resendId), 'domein staat nog bij Resend');
    gelijk((await testmail(a)).from, PLATFORM_FROM, 'afzender');
  });

  await stap('daarna kan een andere werkruimte het domein wel koppelen', async () => {
    const d = gelukt(await actie(b, b.eigenaar, 'addSendingDomain', { domain: domein, fromEmail: `info@${domein}` }), 'koppelen').domain;
    gelijk(d.organization_id, b.orgId, 'organisatie');
    gelukt(await actie(b, b.eigenaar, 'removeSendingDomain', { domainId: d.id }), 'opruimen');
  });

  groep('Verzenddomein: wie mag een domein vasthouden?');

  await stap('een nooit geverifieerde koppeling van 8 dagen oud mag een ander overnemen', async () => {
    const oud = domeinNaam('oud');
    const d = gelukt(await actie(a, a.eigenaar, 'addSendingDomain', { domain: oud, fromEmail: `info@${oud}` }), 'A koppelt').domain;
    geweigerd(await actie(b, b.eigenaar, 'addSendingDomain', { domain: oud, fromEmail: `info@${oud}` }), 'B te vroeg', [409]);
    sql(`update public.organization_email_domains set created_at = now() - interval '8 days' where id = '${d.id}'`);
    const nieuw = gelukt(await actie(b, b.eigenaar, 'addSendingDomain', { domain: oud, fromEmail: `info@${oud}` }), 'B neemt over').domain;
    gelijk(rij(d.id), null, 'rij van A');
    verwacht(!post.domeinen.has(d.resend_domain_id), 'het domein van A staat nog bij Resend');
    gelijk(rijVoorDomein(oud).organization_id, b.orgId, 'organisatie');
    verwacht(nieuw.resend_domain_id !== d.resend_domain_id, 'zelfde Resend-domein (dus dezelfde DKIM-sleutel)');
  });

  await stap('een koppeling die ooit geverifieerd was, niet: ook niet als hij nu hapert', async () => {
    const vast = domeinNaam('vast');
    const d = gelukt(await actie(a, a.eigenaar, 'addSendingDomain', { domain: vast, fromEmail: `info@${vast}` }), 'A koppelt').domain;
    post.dns.add(vast);
    gelijk(gelukt(await actie(a, a.eigenaar, 'verifySendingDomain', { domainId: d.id }), 'verifiëren').domain.status, 'verified', 'status');
    zetDomeinStatus(d.resend_domain_id, 'failed');
    gelijk(gelukt(await actie(a, a.eigenaar, 'refreshSendingDomain', { domainId: d.id }), 'verversen').domain.status, 'failed', 'status na haperen');
    sql(`update public.organization_email_domains set created_at = now() - interval '30 days' where id = '${d.id}'`);
    geweigerd(await actie(b, b.eigenaar, 'addSendingDomain', { domain: vast, fromEmail: `info@${vast}` }), 'B', [409]);
    verwacht(rij(d.id), 'de rij van A is weg');
  });

  await stap('een nooit geverifieerd bovenliggend domein blokkeert een subdomein niet', async () => {
    const boven = domeinNaam('boven');
    gelukt(await actie(a, a.eigenaar, 'addSendingDomain', { domain: boven, fromEmail: `info@${boven}` }), 'A koppelt');
    gelukt(await actie(b, b.eigenaar, 'addSendingDomain', { domain: `post.${boven}`, fromEmail: `info@post.${boven}` }), 'B koppelt subdomein');
  });

  await stap('maximaal vijf domeinen per werkruimte', async () => {
    const aantal = Number(sql(`select count(*) from public.organization_email_domains where organization_id = '${b.orgId}'`));
    for (let i = aantal; i < 5; i += 1) {
      const naam = domeinNaam('extra');
      gelukt(await actie(b, b.eigenaar, 'addSendingDomain', { domain: naam, fromEmail: `info@${naam}` }), `domein ${i + 1}`);
    }
    const teVeel = domeinNaam('teveel');
    geweigerd(await actie(b, b.eigenaar, 'addSendingDomain', { domain: teVeel, fromEmail: `info@${teVeel}` }), 'zesde', [422]);
  });

  groep('Verzenddomein: bij Resend verdwenen');

  await stap('verifiëren van een domein dat Resend niet meer kent: duidelijke melding, status mislukt', async () => {
    const weg = domeinNaam('weg');
    const d = gelukt(await actie(a, a.eigenaar, 'addSendingDomain', { domain: weg, fromEmail: `info@${weg}` }), 'koppelen').domain;
    post.domeinen.delete(d.resend_domain_id);
    const res = geweigerd(await actie(a, a.eigenaar, 'verifySendingDomain', { domainId: d.id }), 'verifiëren', [409]);
    verwacht(/bestaat niet meer bij Resend/.test(res.error), `melding: ${res.error}`);
    const na = rij(d.id);
    gelijk([na.status, na.resend_domain_id], ['failed', null], 'status en koppeling');
    gelukt(await actie(a, a.eigenaar, 'removeSendingDomain', { domainId: d.id }), 'verwijderen kan dan nog');
  });
}
