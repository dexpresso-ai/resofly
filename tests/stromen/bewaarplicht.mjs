// Bewaarplicht: wat verstuurd of geboekt is, blijft precies zo bewaard.
//
// Waarom dit scenario: de controle van 22 november 2026 (boekhouder,
// Belastingdienst en bewaarplicht) vond twee plekken waar dat niet zo was.
//   1. Het bewijsstuk van een geboekte inkoopfactuur was met de eigen sessie te
//      wissen (DELETE op attachments) en te vervangen (PATCH van storage_key).
//      Het scherm toonde de knop niet en Gerrie weigerde, de database niet.
//      Migratie 20261123131000_bewijsstukken_vast.sql.
//   2. De e-factuur (UBL) werd niet bewaard zoals hij verstuurd was: een latere
//      download was opnieuw opgebouwd met de gegevens van vandaag.
//      Migratie 20261123132000_efactuur_bewaren.sql.
//
// Alles als de eigenaar, via REST, RPC en de echte invoice-workflow met zijn
// eigen sessie (RLS geldt). De media-worker is nep (nepdiensten.mjs); wat de
// echte worker aan de database vraagt (storage_key_lock_reason) toetsen we met
// de service-role, zoals de worker hem aanroept.
import { createHash, randomUUID } from 'node:crypto';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { inkoopfactuur, klant, leverancier, maakEenmanszaak, nodig, q, rekening, verstuurdeFactuur, wf } from './eenmanszaak.mjs';
import { SERVICE_KEY } from './omgeving.mjs';
import { post } from './nepdiensten.mjs';
import { roep } from './functies.mjs';

function bijlage(w, soort, id, naam, sleutel) {
  return rest('attachments?select=*', {
    method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, entity_type: soort, entity_id: id,
      name: naam, mime_type: 'application/pdf', size_bytes: 1234, storage_key: sleutel ?? `${w.orgId}/${soort}/${id}/${randomUUID()}-${naam}`,
    },
  });
}

const bestaat = (id) => sqlRijen(`select id from public.attachments where id = ${q(id)}`).length === 1;
const vastReden = async (w, sleutel) => gelukt(await rpc('storage_key_lock_reason', { p_organization_id: w.orgId, p_storage_key: sleutel }, SERVICE_KEY), 'storage_key_lock_reason');

async function bewijsstukken() {
  groep('Bewaarplicht — het bewijsstuk van een geboekt of verstuurd document ligt vast');
  const w = await stap('een eenmanszaak met een concept-inkoopfactuur en een geboekte, elk met een bon', async () => {
    const w0 = await maakEenmanszaak('bewaar');
    const t = (w0.t = {});
    t.lev = await leverancier(w0, 'Software & Co');
    const kosten = await rekening(w0, '4300');
    t.concept = gelukt(await rest('purchase_invoices?select=*', {
      method: 'POST', token: w0.eigenaar.token, prefer: 'return=representation',
      body: {
        organization_id: w0.orgId, created_by: w0.eigenaar.id, supplier_id: t.lev.id, supplier_invoice_number: 'SC-1', date: '2026-10-05', due_date: '2026-10-19',
        subtotal_cents: 6000, vat_cents: 1260, total_cents: 7260, currency: 'EUR', status: 'draft',
        lines: [{ id: randomUUID(), description: 'Licentie', amount_cents: 6000, vat_code: 'HOOG', vat_rate: 21, account_id: kosten.id }],
      },
    }), 'concept')[0];
    t.conceptBon = gelukt(await bijlage(w0, 'purchase_invoice', t.concept.id, 'bon-concept.pdf'), 'bijlage bij het concept')[0];
    t.conceptBon2 = gelukt(await bijlage(w0, 'purchase_invoice', t.concept.id, 'verkeerde-bon.pdf'), 'tweede bijlage bij het concept')[0];
    t.geboekt = await inkoopfactuur(w0, t.lev, '2026-10-06', [{ description: 'Fotobewerking', amount_cents: 6000, vat_code: 'HOOG', vat_rate: 21, account_id: kosten.id }]);
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('aan een concept kan alles: een bijlage hernoemen, vervangen en weghalen', async () => {
    gelukt(await rest(`attachments?id=eq.${t.conceptBon.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { name: 'bon-licentie.pdf' } }), 'hernoemen');
    gelukt(await rest(`attachments?id=eq.${t.conceptBon2.id}`, { method: 'DELETE', token: w.eigenaar.token }), 'weghalen');
    gelijk(bestaat(t.conceptBon2.id), false, 'de verkeerde bon is weg');
    gelijk(await vastReden(w, t.conceptBon.storage_key), null, 'de worker mag het bestand van een concept wissen');
  });

  await stap('bij een geboekte inkoopfactuur kan er een bijlage bij, ook een tweede', async () => {
    t.bon = gelukt(await bijlage(w, 'purchase_invoice', t.geboekt.id, 'bon-fotobewerking.pdf'), 'bewijsstuk toevoegen')[0];
    t.bon2 = gelukt(await bijlage(w, 'purchase_invoice', t.geboekt.id, 'factuur-software.pdf'), 'tweede bijlage toevoegen')[0];
  });

  await stap('wissen of vervangen van dat bewijsstuk wordt geweigerd, met de eigen sessie en met de service-role', async () => {
    const weg = await rest(`attachments?id=eq.${nodig(t.bon, 'bon').id}`, { method: 'DELETE', token: w.eigenaar.token });
    geweigerd(weg, 'DELETE op het bewijsstuk');
    verwacht(/bewijsstuk van een geboekte inkoopfactuur/.test(weg.tekst), `melding: ${weg.tekst.slice(0, 200)}`);
    geweigerd(await rest(`attachments?id=eq.${t.bon.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { storage_key: `${w.orgId}/purchase_invoice/${t.geboekt.id}/${randomUUID()}-iets-anders.jpg`, name: 'iets-anders.jpg' } }), 'PATCH naar een ander bestand');
    geweigerd(await rest(`attachments?id=eq.${t.bon.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { entity_id: t.concept.id } }), 'verhangen naar een concept');
    geweigerd(await rest(`attachments?id=eq.${t.bon2.id}`, { method: 'DELETE', token: SERVICE_KEY }), 'DELETE met de service-role');
    const rij = sqlRij(`select name, storage_key, entity_id from public.attachments where id = ${q(t.bon.id)}`);
    gelijk([rij.name, rij.storage_key, rij.entity_id], ['bon-fotobewerking.pdf', t.bon.storage_key, t.geboekt.id], 'het bewijsstuk is onveranderd');
    gelijk(bestaat(t.bon2.id), true, 'de tweede bijlage staat er nog');
  });

  await stap('de media-worker krijgt van de database te horen dat het bestand vastligt', async () => {
    verwacht(/bewaarplicht/.test(await vastReden(w, t.bon.storage_key) ?? ''), 'het bestand van de bon ligt vast');
    // Een origineel uit de factuur-inbox dat als bewijsstuk aan de factuur hangt.
    const inboxSleutel = `${w.orgId}/purchase_invoice_inbox/${randomUUID()}/origineel.pdf`;
    gelukt(await bijlage(w, 'purchase_invoice', t.geboekt.id, 'origineel.pdf', inboxSleutel), 'origineel uit de inbox als bijlage');
    verwacht(/bewaarplicht/.test(await vastReden(w, inboxSleutel) ?? ''), 'ook via de bijlage-rij');
    // Geen rij, maar de sleutel zegt bij welk document het hoort.
    verwacht(/bewaarplicht/.test(await vastReden(w, `${w.orgId}/purchase_invoice/${t.geboekt.id}/${randomUUID()}-los.pdf`) ?? ''), 'ook op de sleutel alleen');
    gelijk(await vastReden(w, `${w.orgId}/folder/${randomUUID()}/notitie.pdf`), null, 'een gewoon bestand ligt niet vast');
    geweigerd(await rpc('storage_key_lock_reason', { p_organization_id: w.orgId, p_storage_key: t.bon.storage_key }, w.eigenaar.token), 'de vraag is alleen voor de worker');
  });

  await stap('een bijlage van een verstuurde factuur ligt ook vast; een bijzaak (wie hem open heeft) mag nog', async () => {
    const k = await klant(w, 'Bureau Noord', 'business');
    const factuur = await verstuurdeFactuur(w, k, '2026-10-08', [{ description: 'Fotoshoot', quantity: 1, unit_price: 200, vat: 21 }]);
    const att = gelukt(await bijlage(w, 'invoice', factuur.id, 'urenstaat.pdf'), 'bijlage bij de verstuurde factuur')[0];
    geweigerd(await rest(`attachments?id=eq.${att.id}`, { method: 'DELETE', token: w.eigenaar.token }), 'DELETE bij een verstuurde factuur');
    geweigerd(await rest(`attachments?id=eq.${att.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { name: 'anders.pdf' } }), 'hernoemen bij een verstuurde factuur');
    gelukt(await rest(`attachments?id=eq.${att.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { locked_by: w.eigenaar.id, locked_at: new Date().toISOString() } }), 'slot van de editor');
    gelijk(bestaat(att.id), true, 'de bijlage staat er nog');
  });
}

// ── 2. De e-factuur zoals hij verstuurd is ───────────────────────────────

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const vanBase64 = (b64) => Buffer.from(b64, 'base64');

async function eFactuur() {
  groep('Bewaarplicht — de e-factuur blijft bewaard zoals hij verstuurd is');
  const w = await stap('een eenmanszaak met een klant met e-facturatie, en een e-factuur die de deur uit is', async () => {
    const w0 = await maakEenmanszaak('efactuur');
    const t = (w0.t = {});
    t.gemeente = await klant(w0, 'Gemeente Voorbeeld', 'business');
    sql(`update public.clients set e_invoicing_enabled = true, e_invoice_email = 'facturen@gemeente.test', kvk_number = '12345678' where id = ${q(t.gemeente.id)}`);
    t.factuur = await verstuurdeFactuur(w0, { ...t.gemeente, email: 'facturen@gemeente.test' }, '2026-10-08', [{ description: 'Reportage', quantity: 1, unit_price: 750, vat: 21 }]);
    return w0;
  });
  if (!w) return;
  const t = w.t;

  await stap('bij het versturen is het bestand zelf bewaard: dezelfde bytes als de bijlage in de mail', async () => {
    const mail = post.mails.filter((m) => m.to.includes('facturen@gemeente.test')).at(-1);
    const xml = nodig(mail?.bijlagen.find((b) => /-ubl\.xml$/.test(b.naam)), 'de e-factuur in de mail');
    t.verstuurd = sha(xml.bytes);
    const rij = sqlRij(`select id, doc_type, document_number, recipient_email, file_name, sha256, size_bytes, storage_provider, storage_key, sent_at, delivery_id from public.sent_e_invoices where invoice_id = ${q(t.factuur.id)}`);
    gelijk([rij?.doc_type, rij?.document_number, rij?.recipient_email, rij?.sha256], ['invoice', t.factuur.number, 'facturen@gemeente.test', t.verstuurd], 'de rij van de verzending');
    verwacht(rij.sent_at !== null && rij.delivery_id !== null, 'verzendmoment en verzending zijn vastgelegd');
    verwacht(rij.storage_provider === 'r2' && rij.storage_key.startsWith(`${w.orgId}/e-invoices/${t.factuur.id}/`) && rij.storage_key.endsWith('.xml'), `opslagsleutel: ${rij.storage_key}`);
    gelijk(sha(nodig(post.r2.get(rij.storage_key), 'het bestand op R2')), t.verstuurd, 'het bestand op R2 is de verstuurde e-factuur');
    gelijk(sqlRij(`select e_invoice_sha256 from public.invoice_email_deliveries where id = ${q(rij.delivery_id)}`).e_invoice_sha256, t.verstuurd, 'dezelfde hash als bij de verzending');
    t.rij = rij;
  });

  await stap('de klant verhuist en de zzp\'er krijgt een ander IBAN: de download blijft precies het verstuurde bestand', async () => {
    sql(`update public.clients set address_line1 = 'Nieuwe Kade 99', city = 'Rotterdam', name = 'Gemeente Anders' where id = ${q(t.gemeente.id)}`);
    sql(`update public.company_settings set iban = 'NL02ABNA0123456789', company_name = 'Van Dijk Beeld' where organization_id = ${q(w.orgId)}`);
    const res = gelukt(await wf(w, 'downloadInvoiceUbl', { invoiceId: t.factuur.id }), 'e-factuur downloaden');
    gelijk([res.ubl.stored, sha(vanBase64(res.ubl.base64)), res.ubl.warnings.length], [true, t.verstuurd, 0], 'byte voor byte het verstuurde bestand');
    const tekst = vanBase64(res.ubl.base64).toString('utf8');
    verwacht(tekst.includes('Gemeente Voorbeeld') && !tekst.includes('Gemeente Anders') && !tekst.includes('NL02ABNA0123456789'), 'met de gegevens van toen');
  });

  await stap('na crediteren (factuur geannuleerd) is de e-factuur van toen er nog, en de e-creditnota is ook bewaard', async () => {
    const uit = gelukt(await wf(w, 'creditInvoice', { invoiceId: t.factuur.id, reason: 'Opdracht vervallen' }), 'crediteren');
    gelijk(sqlRij(`select status from public.invoices where id = ${q(t.factuur.id)}`).status, 'cancelled', 'de factuur is geannuleerd');
    const res = gelukt(await wf(w, 'downloadInvoiceUbl', { invoiceId: t.factuur.id }), 'e-factuur van een geannuleerde factuur');
    gelijk(sha(vanBase64(res.ubl.base64)), t.verstuurd, 'nog steeds het verstuurde bestand');
    const cn = sqlRij(`select id, number from public.credit_notes where invoice_id = ${q(t.factuur.id)}`);
    const rij = sqlRij(`select sha256, sent_at, doc_type, document_number from public.sent_e_invoices where credit_note_id = ${q(nodig(cn?.id, 'creditnota'))}`);
    const mail = post.mails.filter((m) => m.to.includes('facturen@gemeente.test')).at(-1);
    const xml = nodig(mail?.bijlagen.find((b) => /^creditfactuur-.*-ubl\.xml$/.test(b.naam)), 'de e-creditnota in de mail');
    gelijk([rij?.doc_type, rij?.document_number, rij?.sha256, rij?.sent_at !== null], ['credit_note', cn.number, sha(xml.bytes), true], 'de e-creditnota is bewaard zoals verstuurd');
    const dl = gelukt(await wf(w, 'downloadCreditNoteUbl', { creditNoteId: cn.id }), 'e-creditnota downloaden');
    gelijk([dl.ubl.stored, sha(vanBase64(dl.ubl.base64))], [true, rij.sha256], 'de download is dat bestand');
    void uit;
  });

  await stap('de bewaarde e-factuur ligt vast: niet te wijzigen of te wissen, ook niet met de service-role', async () => {
    geweigerd(await rest(`sent_e_invoices?id=eq.${t.rij.id}`, { method: 'PATCH', token: SERVICE_KEY, body: { sha256: 'x'.repeat(64) } }), 'hash wijzigen');
    geweigerd(await rest(`sent_e_invoices?id=eq.${t.rij.id}`, { method: 'PATCH', token: SERVICE_KEY, body: { sent_at: new Date().toISOString() } }), 'verzendmoment verzetten');
    geweigerd(await rest(`sent_e_invoices?id=eq.${t.rij.id}`, { method: 'DELETE', token: SERVICE_KEY }), 'wissen');
    await rest(`sent_e_invoices?id=eq.${t.rij.id}`, { method: 'DELETE', token: w.eigenaar.token });
    await rest('sent_e_invoices', { method: 'POST', token: w.eigenaar.token, body: { organization_id: w.orgId, invoice_id: t.factuur.id, doc_type: 'invoice', document_number: 'X', recipient_email: 'x@x.test', file_name: 'x.xml', size_bytes: 1, sha256: 'x', storage_provider: 'database', data_base64: 'eA==' } });
    gelijk(Number(sqlRij(`select count(*) as n from public.sent_e_invoices where invoice_id = ${q(t.factuur.id)} and doc_type = 'invoice'`).n), 1, 'er staat precies de ene rij');
    const eigen = gelukt(await rest(`sent_e_invoices?select=id&invoice_id=eq.${t.factuur.id}`, { token: w.eigenaar.token }), 'lezen als eigenaar');
    gelijk(eigen.length, 2, 'de eigenaar leest zijn e-factuur en e-creditnota');
    const vreemde = await maakEenmanszaak('efactuur-ander');
    gelijk(gelukt(await rest(`sent_e_invoices?select=id&invoice_id=eq.${t.factuur.id}`, { token: vreemde.eigenaar.token }), 'lezen als een ander').length, 0, 'een andere organisatie leest niets');
    geweigerd(await roepAls(vreemde, w.orgId, t.factuur.id), 'downloaden als een ander');
  });

  await stap('lukt het bewaren niet, dan gaat er niets weg', async () => {
    const k = await klant(w, 'Provincie Voorbeeld', 'business');
    sql(`update public.clients set e_invoicing_enabled = true, e_invoice_email = 'facturen@provincie.test', kvk_number = '23456789' where id = ${q(k.id)}`);
    const concept = gelukt(await rest('invoices?select=*', { method: 'POST', token: w.eigenaar.token, prefer: 'return=representation', body: {
      organization_id: w.orgId, created_by: w.eigenaar.id, client_id: k.id, project_id: null, number: `F2026-${randomUUID().slice(0, 6)}`, date: '2026-10-09', due_date: '2026-10-23', status: 'draft', notes: null,
      lines: [{ id: randomUUID(), description: 'Advies', quantity: 1, unit_price: 100, vat: 21 }],
    } }), 'concept')[0];
    // De eerste opslag (de PDF) lukt, de tweede (de e-factuur) niet.
    const echt = globalThis.fetch;
    let teller = 0;
    globalThis.fetch = (invoer, init) => {
      const url = typeof invoer === 'string' ? invoer : invoer.url;
      const sleutel = init?.headers?.['X-Storage-Key'] ?? '';
      if (/\/internal\/invoice-snapshot$/.test(url) && /\/e-invoices\//.test(sleutel)) { teller += 1; return Promise.resolve(new Response('storing', { status: 503 })); }
      return echt(invoer, init);
    };
    let res;
    try {
      res = await wf(w, 'sendInvoiceEmail', { invoiceId: concept.id, recipientEmail: 'facturen@provincie.test', recipientName: 'Provincie', includePaymentLink: false });
    } finally { globalThis.fetch = echt; }
    geweigerd(res, 'versturen terwijl de e-factuur niet bewaard kan worden', [502]);
    gelijk(teller, 1, 'de storing is geraakt');
    gelijk(post.mails.filter((m) => m.to.includes('facturen@provincie.test')).length, 0, 'er is geen mail verstuurd');
    gelijk(Number(sqlRij(`select count(*) as n from public.sent_e_invoices where invoice_id = ${q(concept.id)}`).n), 0, 'en er staat geen rij');
  });

  await stap('een gewone factuur (nooit als e-factuur verstuurd) wordt nog live opgebouwd, en het scherm zegt dat erbij', async () => {
    const k = await klant(w, 'Bureau Zuid', 'business');
    sql(`update public.clients set kvk_number = '34567890' where id = ${q(k.id)}`);
    const f = await verstuurdeFactuur(w, k, '2026-10-10', [{ description: 'Fotoshoot', quantity: 1, unit_price: 200, vat: 21 }]);
    const res = gelukt(await wf(w, 'downloadInvoiceUbl', { invoiceId: f.id }), 'e-factuur van een gewone factuur');
    gelijk(res.ubl.stored, false, 'niet het bewaarde bestand');
    verwacht(res.ubl.warnings.some((x) => /niet als e-factuur verstuurd/.test(x)), `aandachtspunten: ${res.ubl.warnings.join(' | ')}`);
    gelijk(Number(sqlRij(`select count(*) as n from public.sent_e_invoices where invoice_id = ${q(f.id)}`).n), 0, 'downloaden bewaart niets');
  });
}

function roepAls(ander, orgId, invoiceId) {
  return roep('invoice-workflow', { token: ander.eigenaar.token, body: { action: 'downloadInvoiceUbl', organizationId: orgId, invoiceId } });
}

export default async function bewaarplicht() {
  await bewijsstukken();
  await eFactuur();
}
