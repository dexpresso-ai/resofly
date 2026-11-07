// Facturen versturen: per e-mail of via Mollie (Instellingen → Online betalen),
// met de echte invoice-workflow en client-portal tegen de lokale stack en
// nep-Mollie (nepdiensten.mjs).
//
// Waarom een eigen scenario: tot 7 november 2026 was de Mollie-koppeling zelf
// de keuze. Met een gekoppeld account ging er bij elke factuur, herinnering en
// aanmaning een betaallink van Mollie mee, bood het klantportaal "Betaal nu"
// aan, en kreeg een klant op "via Mollie" zijn factuur altijd van Mollie. Wie
// dat niet wilde, kon alleen ontkoppelen. Kiest de organisatie nu "per e-mail",
// dan moet dat overal stoppen: ook als de browser (een oud tabblad) toch om een
// link vraagt. Elke stap kijkt daarom naar wat er bij Mollie aankwam, welke
// betaalregels er ontstonden en wat er in de mail stond.
import { randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { mailsAan, post } from './nepdiensten.mjs';
import { rest, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';

// ── Hulpjes ─────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function vandaag(plusDagen = 0) {
  return new Date(Date.now() + plusDagen * 86_400_000).toISOString().slice(0, 10);
}

/** Een actie van invoice-workflow, zoals supabase.functions.invoke vanuit de app. */
function wf(w, gebruiker, action, extra = {}) {
  return roep('invoice-workflow', { token: gebruiker?.token, body: { action, organizationId: w.orgId, ...extra } });
}

/** Een actie van het klantportaal, als de ingelogde portaalgebruiker. */
function portaal(gebruiker, action, extra = {}) {
  return roep('client-portal', { token: gebruiker.token, body: { action, ...extra } });
}

const mollieAanroepen = (vanaf) => post.log.slice(vanaf).filter((regel) => regel.startsWith('mollie '));

/** Een concept zoals de app het opslaat (PostgREST, met RLS). */
async function nieuwConcept(w, klant = w.klantA) {
  const res = await rest('invoices?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.medewerker.id, client_id: klant.id, project_id: null,
      number: uniek('FAC-VZW'), date: vandaag(), due_date: vandaag(14), status: 'draft', notes: null,
      lines: REGELS.map((regel) => ({ id: randomUUID(), ...regel })),
    },
  });
  return gelukt(res, 'concept opslaan')[0];
}

/** Zoals Instellingen → Online betalen het opslaat (saveInvoiceSendMethod): een update met RLS. */
function kies(w, gebruiker, methode) {
  return rest(`company_settings?organization_id=eq.${w.orgId}&select=invoice_send_method`, {
    method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: { invoice_send_method: methode },
  });
}

const gekozen = (w) => sqlRij(`select invoice_send_method from public.company_settings where organization_id = ${q(w.orgId)}`)?.invoice_send_method ?? null;
const betaalregels = (factuurId) => sqlRijen(`select status, provider_payment_id from public.invoice_payment_records where invoice_id = ${q(factuurId)} order by created_at`);

// De tijd laten verstrijken (zie herinneringen.mjs): de datums van de factuur
// schuiven terug, zonder de vergrendeling, want dit is de kalender en geen gebruiker.
function tijdVerstrijkt(factuurId, dagen) {
  sql(`begin; set local session_replication_role = replica;
       update public.invoices
          set date = date - ${dagen}, due_date = due_date - ${dagen},
              sent_at = sent_at - make_interval(days => ${dagen})
        where id = ${q(factuurId)};
       commit;`);
}

/**
 * Een verzendvoorstel van Gerrie, met dezelfde code als in de chat
 * (buildProposal in _shared/gerrieCore.ts), maar zonder taalmodel ertussen:
 * de test kiest de tool en de invoer zelf. Als het lid, met schrijfrecht in
 * Financiën, zoals de chat het voor hem zou doen.
 */
let gerrieKern = null;
async function gerrieVoorstel(w, tool, input) {
  gerrieKern ??= await import(new URL('../../supabase/functions/_shared/gerrieCore.ts', import.meta.url).href);
  const ctx = await gerrieKern.buildContext(w.orgId, 'member', { id: w.medewerker.id, email: w.medewerker.email });
  return gerrieKern.buildProposal(ctx, tool, input);
}

/** Verstuurt een concept zoals de knop: met includePaymentLink zoals de app die meegeeft. */
async function verstuur(w, concept, { includePaymentLink = true, klant = w.klantA } = {}) {
  return wf(w, w.medewerker, 'sendInvoiceEmail', {
    invoiceId: concept.id, recipientEmail: klant.email, recipientName: `Contact ${klant.name}`, includePaymentLink,
  });
}

// ── Het scenario ────────────────────────────────────────────────────────

export default async function verzendwijze() {
  groep('Facturen versturen: per e-mail of via Mollie (Instellingen → Online betalen)');

  const w = await stap('wereld maken, Mollie gekoppeld door de eigenaar', async () => {
    const wereld = await maakWereld('verzendwijze');
    const sleutel = `test_verzend${randomUUID().replace(/-/g, '')}`;
    gelukt(await roep('invoice-workflow', { token: wereld.eigenaar.token, body: { action: 'saveInvoiceMollieKey', organizationId: wereld.orgId, apiKey: sleutel } }), 'Mollie koppelen');
    return wereld;
  });
  if (!w) return;

  // ── 1. Nog niets gekozen: zoals het was ─────────────────────────────────

  await stap('nog niets gekozen: een factuur gaat met een betaallink van Mollie, zoals het was', async () => {
    gelijk(gekozen(w), null, 'keuze');
    const voor = post.log.length;
    const concept = await nieuwConcept(w);
    const uit = gelukt(await verstuur(w, concept), 'versturen');
    gelijk([uit.mollieAllowed, uit.paymentLinkIncluded, uit.paymentLinkError], [true, true, null], 'antwoord');
    verwacht(mollieAanroepen(voor).includes('mollie POST /v2/payments'), `Mollie niet gebeld: ${mollieAanroepen(voor).join(', ')}`);
    gelijk(betaalregels(concept.id).map((r) => r.status), ['open'], 'betaalregels');
  });

  // ── 2. Wie mag kiezen ───────────────────────────────────────────────────

  await stap('een lid, lezer of boekhouder kan de keuze niet wijzigen', async () => {
    for (const [wie, gebruiker] of [['lid', w.medewerker], ['lezer', w.lezer], ['boekhouder', w.boekhouder], ['kijker', w.kijker]]) {
      nietsVeranderd(await kies(w, gebruiker, 'email'), `kiezen als ${wie}`);
    }
    gelijk(gekozen(w), null, 'keuze');
  });

  await stap('een onbekende waarde weigert de database', async () => {
    const res = await kies(w, w.eigenaar, 'peppol');
    verwacht(res.status >= 400 && res.status < 500, `verwacht een weigering, kreeg ${res.status} ${res.tekst?.slice(0, 200)}`);
    gelijk(gekozen(w), null, 'keuze');
  });

  await stap('de beheerder kiest "per e-mail", en het auditlog weet wie', async () => {
    const res = gelukt(await kies(w, w.beheerder, 'email'), 'kiezen als beheerder');
    gelijk(res.map((rij) => rij.invoice_send_method), ['email'], 'antwoord');
    gelijk(gekozen(w), 'email', 'keuze');
    const regel = sqlRij(`select actor_user_id, action, metadata from public.audit_logs
                           where organization_id = ${q(w.orgId)} and entity_type = 'company_settings'
                           order by created_at desc, id desc limit 1`);
    gelijk([regel?.actor_user_id, regel?.action], [w.beheerder.id, 'updated'], 'auditregel');
    verwacht((regel?.metadata?.changed_columns ?? []).includes('invoice_send_method'), `gewijzigde kolommen: ${JSON.stringify(regel?.metadata)}`);
  });

  // ── 3. Per e-mail: nergens een betaallink van Mollie ───────────────────

  let perMail = null;
  await stap('per e-mail: de factuur gaat zonder betaallink, ook als de browser erom vraagt; Mollie niet gebeld', async () => {
    const voor = post.log.length;
    const concept = await nieuwConcept(w);
    const uit = gelukt(await verstuur(w, concept, { includePaymentLink: true }), 'versturen');
    gelijk([uit.mollieAllowed, uit.paymentLinkIncluded, uit.paymentLinkError, uit.deliveryChannel], [false, false, null, 'email'], 'antwoord');
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(betaalregels(concept.id), [], 'betaalregels');
    gelijk(sqlRij(`select status from public.invoices where id = ${q(concept.id)}`)?.status, 'sent', 'factuur');
    const mail = mailsAan(w.klantA.email).at(-1);
    verwacht(mail, 'geen mail naar de klant');
    verwacht(mail.bijlagen.some((b) => b.naam.endsWith('.pdf')), 'geen PDF in de mail');
    verwacht(!/mollie\.com/i.test(`${mail.html} ${mail.text}`), 'er staat een Mollie-link in de mail');
    perMail = concept;
  });

  await stap('per e-mail: een losse betaallink wordt geweigerd, met de reden', async () => {
    const voor = post.log.length;
    const uit = geweigerd(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: perMail.id }), 'losse betaallink', [409]);
    verwacht(/per e-mail/.test(uit.error) && /Online betalen/.test(uit.error), `melding: ${uit.error}`);
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(betaalregels(perMail.id), [], 'betaalregels');
  });

  await stap('per e-mail: een herinnering gaat zonder betaallink, ook met "Betaallink meesturen" aan', async () => {
    tijdVerstrijkt(perMail.id, 14 + 5);
    const voor = post.log.length;
    const mailsVoor = mailsAan(w.klantA.email).length;
    const uit = gelukt(await wf(w, w.medewerker, 'sendInvoiceReminderEmail', { invoiceId: perMail.id, includePaymentLink: true }), 'herinnering');
    gelijk([uit.paymentLinkIncluded, uit.paymentLinkError ?? null], [false, null], 'antwoord');
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(betaalregels(perMail.id), [], 'betaalregels');
    gelijk(mailsAan(w.klantA.email).length, mailsVoor + 1, 'herinneringsmail');
  });

  await stap('per e-mail: het klantportaal toont de overschrijving, geen "Betaal nu", en maakt geen link', async () => {
    const voor = post.log.length;
    const info = gelukt(await portaal(w.portaalA, 'getInvoicePaymentInfo', { invoiceId: perMail.id }), 'betaalinfo').payment;
    gelijk([info.payable, info.mollieAvailable, info.iban], [true, false, 'NL91ABNA0417164300'], 'betaalinfo');
    const uit = geweigerd(await portaal(w.portaalA, 'createInvoicePayment', { invoiceId: perMail.id }), 'online betalen', [409]);
    verwacht(/overschrijvingsgegevens/.test(uit.error), `melding: ${uit.error}`);
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(betaalregels(perMail.id), [], 'betaalregels');
  });

  // Klant B wil e-facturen via Mollie (Peppol). Per e-mail krijgt hij ze als
  // e-factuur per mail: hij wil een e-factuur, alleen Mollie doet niet mee.
  await stap('klant B zet e-facturatie via Mollie aan (zoals het klantformulier)', async () => {
    const res = await rest(`clients?id=eq.${w.klantB.id}&select=id,e_invoicing_enabled,e_invoice_channel`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
      body: { e_invoicing_enabled: true, e_invoice_channel: 'mollie', kvk_number: '87654321' },
    });
    gelijk(gelukt(res, 'klant bijwerken').map((r) => [r.e_invoicing_enabled, r.e_invoice_channel]), [[true, 'mollie']], 'klant');
  });

  let perMailB = null;
  await stap('per e-mail: een klant op "via Mollie" krijgt de e-factuur per mail (UBL met de PDF erin); Mollie niet gebeld', async () => {
    const voor = post.log.length;
    const concept = await nieuwConcept(w, w.klantB);
    perMailB = concept;
    const uit = gelukt(await verstuur(w, concept, { klant: w.klantB, includePaymentLink: false }), 'versturen');
    gelijk([uit.deliveryChannel, uit.ubl?.attached, uit.mollieAllowed], ['e_invoice_email', true, false], 'antwoord');
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    const mail = mailsAan(w.klantB.email).at(-1);
    verwacht(mail?.bijlagen.some((b) => b.naam.endsWith('.xml')), `geen UBL in de mail: ${mail?.bijlagen.map((b) => b.naam).join(', ')}`);
    const levering = sqlRij(`select delivery_channel, status from public.invoice_email_deliveries where invoice_id = ${q(concept.id)} order by created_at desc limit 1`);
    gelijk(levering?.delivery_channel, 'e_invoice_email', 'verzending');
  });

  // Een factuur die Mollie al uitgaf (van vóór de keuze): niet nog eens per
  // mail, want dan heeft de klant twee facturen met een ander nummer. Eerder
  // hield alleen het Mollie-kanaal dat tegen; per e-mail ging hij erlangs.
  let mollieUitgegeven = null;
  await stap('per e-mail: een factuur die Mollie al uitgaf, gaat niet nog eens per mail', async () => {
    const concept = await nieuwConcept(w, w.klantB);
    mollieUitgegeven = concept;
    // Mollies id per run uniek: (provider, provider_email_id) is uniek over de
    // hele database, en een scenario moet vaker op dezelfde database kunnen draaien.
    const mollieId = `invoice_nep${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    sql(`begin; set local session_replication_role = replica;
         update public.invoices set status = 'sent', sent_at = now() where id = ${q(concept.id)};
         insert into public.invoice_email_deliveries (organization_id, invoice_id, provider, provider_email_id, recipient_email, subject, status, delivery_channel, external_invoice_number, external_status)
         values (${q(w.orgId)}, ${q(concept.id)}, 'mollie', ${q(mollieId)}, ${q(w.klantB.email)}, 'Factuur', 'sent', 'e_invoice_mollie', 'INV-0000042', 'issued');
         commit;`);
    const voor = post.log.length;
    const mailsVoor = mailsAan(w.klantB.email).length;
    const uit = geweigerd(await verstuur(w, concept, { klant: w.klantB, includePaymentLink: false }), 'opnieuw versturen', [409]);
    verwacht(/al via Mollie uitgegeven als INV-0000042/.test(uit.error), `melding: ${uit.error}`);
    gelijk(mailsAan(w.klantB.email).length, mailsVoor, 'mails naar de klant');
    gelijk(mollieAanroepen(voor).filter((regel) => regel.includes('/sales-invoices')), [], 'een tweede factuur bij Mollie');
  });

  // Gerrie zet versturen klaar; de mens keurt goed in de chat. Eerder keek hij
  // alleen naar het kanaal van de klant: per e-mail zou hij een factuur die
  // Mollie al uitgaf weer klaarzetten, en de klant kreeg een tweede factuur.
  await stap('Gerrie, per e-mail: een factuur die Mollie al uitgaf zet hij niet klaar; een verstuurde factuur van een klant op "via Mollie" wel (die gaat per mail)', async () => {
    verwacht(perMailB && mollieUitgegeven, 'de facturen van de vorige stappen ontbreken');
    const uitgegeven = await gerrieVoorstel(w, 'propose_send_invoice', { id: mollieUitgegeven.id });
    gelijk(uitgegeven.ok, false, 'voorstel voor de factuur die Mollie uitgaf');
    verwacht(/al via Mollie uitgegeven/.test(uitgegeven.error), `melding: ${uitgegeven.error}`);
    const perMail = await gerrieVoorstel(w, 'propose_send_invoice', { id: perMailB.id });
    gelijk([perMail.ok, perMail.proposal?.type, perMail.proposal?.id, perMail.proposal?.recipient_email],
      [true, 'send_invoice', perMailB.id, w.klantB.email], 'voorstel voor de per mail verstuurde factuur');
    const reeks = await gerrieVoorstel(w, 'propose_send_invoices', { ids: [perMailB.id, mollieUitgegeven.id] });
    gelijk([reeks.ok, reeks.proposal?.type], [true, 'send_invoices'], 'reeks');
    gelijk(reeks.proposal.items.map((item) => item.id), [perMailB.id], 'klaargezet');
    gelijk(reeks.proposal.skipped.map((s) => s.number), [mollieUitgegeven.number], 'overgeslagen');
    verwacht(/al via Mollie uitgegeven/.test(reeks.proposal.skipped[0].reason), `reden: ${reeks.proposal.skipped[0].reason}`);
  });

  // ── 4. Terug naar via Mollie ────────────────────────────────────────────

  await stap('de eigenaar kiest weer "via Mollie": de betaallink gaat weer mee', async () => {
    gelukt(await kies(w, w.eigenaar, 'mollie'), 'kiezen als eigenaar');
    gelijk(gekozen(w), 'mollie', 'keuze');
    const voor = post.log.length;
    const concept = await nieuwConcept(w);
    const uit = gelukt(await verstuur(w, concept), 'versturen');
    gelijk([uit.mollieAllowed, uit.paymentLinkIncluded], [true, true], 'antwoord');
    verwacht(mollieAanroepen(voor).includes('mollie POST /v2/payments'), `Mollie niet gebeld: ${mollieAanroepen(voor).join(', ')}`);
    gelijk(betaalregels(concept.id).map((r) => r.status), ['open'], 'betaalregels');
    const info = gelukt(await portaal(w.portaalA, 'getInvoicePaymentInfo', { invoiceId: concept.id }), 'betaalinfo').payment;
    gelijk(info.mollieAvailable, true, 'online betalen in het portaal');
  });

  await stap('via Mollie: een klant op "via Mollie" gaat weer naar Mollie (Sales Invoices API)', async () => {
    const voor = post.log.length;
    const concept = await nieuwConcept(w, w.klantB);
    // Nep-Mollie kent de Sales Invoices API niet: het versturen mislukt daar,
    // maar het verzoek moet er wel heen. Per e-mail kwam het er niet.
    await verstuur(w, concept, { klant: w.klantB, includePaymentLink: false });
    verwacht(mollieAanroepen(voor).some((regel) => regel.startsWith('mollie POST /v2/sales-invoices')), `niet naar Mollie: ${mollieAanroepen(voor).join(', ')}`);
  });

  // Via Mollie zou de verstuurde factuur van klant B nu naar Mollie gaan, en
  // Mollie maakt er een nieuwe factuur met een eigen nummer van: dubbel.
  await stap('Gerrie, via Mollie: beide facturen van klant B zet hij niet (opnieuw) klaar, elk met de eigen reden', async () => {
    verwacht(perMailB && mollieUitgegeven, 'de facturen van de vorige stappen ontbreken');
    const perMail = await gerrieVoorstel(w, 'propose_send_invoice', { id: perMailB.id });
    gelijk(perMail.ok, false, 'voorstel voor de per mail verstuurde factuur');
    verwacht(/Mollie zou er een nieuwe factuur met een eigen nummer van maken/.test(perMail.error), `melding: ${perMail.error}`);
    const uitgegeven = await gerrieVoorstel(w, 'propose_send_invoice', { id: mollieUitgegeven.id });
    gelijk(uitgegeven.ok, false, 'voorstel voor de factuur die Mollie uitgaf');
    verwacht(/al via Mollie uitgegeven/.test(uitgegeven.error), `melding: ${uitgegeven.error}`);
    const reeks = await gerrieVoorstel(w, 'propose_send_invoices', { ids: [perMailB.id, mollieUitgegeven.id] });
    gelijk(reeks.ok, false, 'reeks');
    verwacht(reeks.error.includes(`${perMailB.number} (al verstuurd; via Mollie zou het een tweede factuur worden)`), `reden voor ${perMailB.number}: ${reeks.error}`);
    verwacht(reeks.error.includes(`${mollieUitgegeven.number} (al via Mollie uitgegeven`), `reden voor ${mollieUitgegeven.number}: ${reeks.error}`);
  });
}
