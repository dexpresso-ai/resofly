// Bonnen fotograferen en declaraties, van begin tot eind tegen een lokale stack.
//
// De echte edge function invoice-inbox (action upload, decline, link), de
// echte database met de migratie 20261118120000, een nep-Claude die de bon
// "leest" (nep-ai.mjs, tool extract_invoice) en de nep-media-worker die de foto
// bewaart. Wat hier wordt nagelopen (CHANGELOG_BONNEN_DECLARATIES_2026-11-18.md):
//   1. de eigenaar fotografeert een bon: Gerrie leest hem als bon, en er staat
//      een concept met de foto als bewijsstuk; er wordt niets geboekt;
//   2. een teamlid zonder Financiën dient een declaratie in: hij krijgt alleen
//      zijn eigen bon terug, en ziet alleen zijn eigen declaraties, ook niet die
//      van een collega (CLAUDE.md, regel 1 en 3);
//   3. wie wat mag: kijker en boekhouder sturen geen bon in, een vreemde
//      organisatie bestaat niet, afwijzen kan alleen met Financiën bewerken;
//   4. afwijzen met een reden (het concept gaat weg, de indiener leest het),
//      negeren kan niet, herstellen haalt hem terug, goedkeuren is boeken, en
//      wat geboekt is, wijs je niet meer af (regel 6);
//   5. dezelfde foto twee keer (de verbinding viel weg) geeft één bon; een
//      bestand dat geen foto is, wordt geweigerd; een opslagstoring laat niets
//      achter;
//   6. een nee tegen AI: de bon gaat niet langs Claude, en "zelf invullen"
//      hangt hem aan een met de hand gemaakt concept.
import { randomBytes, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { ai, BON } from './nep-ai.mjs';
import { post } from './nepdiensten.mjs';
import { rest, rpc, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld, zetGerrieUit } from './wereld.mjs';

// ── Hulpjes ─────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null) throw new Error(`overgeslagen: ${wat} ontbreekt (een eerdere stap faalde)`);
  return waarde;
}

/**
 * Een "foto": de kop van een JPEG is genoeg; de nep-Claude kijkt er niet naar.
 * Elke foto is anders (twee foto's van een bon zijn nooit bit voor bit gelijk):
 * met steeds dezelfde bytes zag de dubbelcontrole op bestand, terecht, elke
 * volgende bon als "al eerder verwerkt".
 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const foto = () => new Uint8Array([...JPEG.slice(0, -2), ...randomBytes(16), 0xff, 0xd9]);

/** Een bon insturen zoals de app dat doet (src/lib/receipt-api.ts). */
function bon(w, gebruiker, { id = randomUUID(), naam = 'bon-2026-11-17-0912.jpg', type = 'image/jpeg', bytes = foto(), org = w.orgId } = {}) {
  return roep('invoice-inbox', {
    token: gebruiker.token,
    body: { organizationId: org, action: 'upload', clientRequestId: id, file: { name: naam, mimeType: type, dataBase64: Buffer.from(bytes).toString('base64') } },
  });
}

function actie(w, gebruiker, inboxId, invoer) {
  return roep('invoice-inbox', { token: gebruiker.token, body: { organizationId: w.orgId, inboxId, ...invoer } });
}

function mijnDeclaraties(w, gebruiker, org = w.orgId) {
  return rpc('list_my_declarations', { p_organization_id: org }, gebruiker.token);
}

/** Wat Claude de volgende keer leest: een andere winkel, zodat het geen dubbele bon is. */
function leest(winkel, nummer, totaalEuro) {
  const excl = Math.round((totaalEuro / 1.21) * 100) / 100;
  ai.bon = {
    ...BON,
    supplier: { ...BON.supplier, name: winkel },
    supplier_invoice_number: nummer,
    lines: [{ description: `Bon ${winkel}`, amount_excl_vat: excl, vat_rate: 21, account_code: null, vat_code: 'HOOG' }],
    totals: { subtotal_excl_vat: excl, vat_amount: Math.round((totaalEuro - excl) * 100) / 100, total_incl_vat: totaalEuro },
  };
}

function inbox(id) {
  return sqlRij(`select id, channel, submitted_by, status, reason, review_note, purchase_invoice_id, supplier_id, attachments, handled_by
                   from public.purchase_invoice_inbox where id = ${q(id)}`);
}

const DECLARATIE_VELDEN = ['currency', 'id', 'read', 'receipt_date', 'status', 'store_name', 'total_cents'];

export default async function bonnen() {
  groep('Bonnen en declaraties: wereld');
  const w = await stap('wereld maken, met rekeningschema', async () => {
    const wereld = await maakWereld('bonnen');
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: wereld.orgId }, wereld.eigenaar.token), 'rekeningschema');
    return wereld;
  });
  if (!w) return;
  const st = {};

  // ── 1. De eigenaar fotografeert een bon ──────────────────────────────
  groep('Bon fotograferen: concept met de foto als bewijsstuk');
  await stap('Gerrie leest de bon als bon, en er staat een concept', async () => {
    const voor = ai.bonnen.length;
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    gelijk(res.channel, 'receipt', 'kanaal');
    gelijk(res.item.status, 'ready', 'status op de werklijst');
    verwacht(/^INK-\d{4}-\d{4}$/.test(res.invoice?.internal_number ?? ''), `intern nummer: ${res.invoice?.internal_number}`);
    gelijk(res.invoice.supplier_name, 'Q-Park Utrecht', 'leverancier');
    gelijk(res.invoice.total_cents, 1500, 'totaal');
    gelijk(ai.bonnen.length, voor + 1, 'één keer langs Claude');
    const vraag = ai.bonnen.at(-1);
    verwacht(vraag.tekst.includes('Dit is een bon'), 'Gerrie hoort niet dat het een bon is');
    gelijk(vraag.beelden, 1, 'de foto als beeld');
    st.bonItem = res.item.id;
    st.bonFactuur = res.invoice.id;
  });

  await stap('het concept: niet geboekt, met kanaal, indiener en de foto als bewijsstuk', async () => {
    const pi = sqlRij(`select status, payment_status, source, extraction_meta->>'channel' as kanaal, extraction_meta->>'submitted_by' as indiener,
                              total_cents, journal_entry_id from public.purchase_invoices where id = ${q(nodig(st.bonFactuur, 'concept'))}`);
    gelijk([pi.status, pi.payment_status, pi.source, pi.kanaal, pi.indiener, Number(pi.total_cents), pi.journal_entry_id],
      ['draft', 'unpaid', 'ai_scan', 'receipt', w.eigenaar.id, 1500, null], 'concept');
    const rij = inbox(st.bonItem);
    gelijk([rij.channel, rij.submitted_by], ['receipt', w.eigenaar.id], 'kanaal en indiener uit de sessie');
    const sleutel = rij.attachments?.[0]?.storage_key ?? '';
    verwacht(sleutel.startsWith(`${w.orgId}/purchase_invoice_inbox/${st.bonItem}/`), `opslagsleutel: ${sleutel}`);
    verwacht(post.r2.has(sleutel), 'de foto staat niet op R2');
    const bijlagen = sqlRijen(`select storage_key from public.attachments where entity_type = 'purchase_invoice' and entity_id = ${q(st.bonFactuur)}`);
    gelijk(bijlagen.map((b) => b.storage_key), [sleutel], 'bewijsstuk bij het concept');
  });

  await stap('ook met "direct boeken" aan: een bon blijft een concept', async () => {
    gelukt(await rpc('set_purchase_invoice_inbox_settings', { p_organization_id: w.orgId, p_patch: { auto_book: true } }, w.eigenaar.token), 'instelling');
    leest('Albert Heijn Lopik', 'AH-77', 23.4);
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    gelijk(res.item.status, 'ready', 'status');
    gelijk(res.item.auto_booked, false, 'niet vanzelf geboekt');
    verwacht(!res.item.warnings.some((r) => /automatisch geboekt/i.test(r)), 'een waarschuwing over boeken bij een bon');
    gelijk(sqlRij(`select status from public.purchase_invoices where id = ${q(res.invoice.id)}`).status, 'draft', 'concept');
    gelukt(await rpc('set_purchase_invoice_inbox_settings', { p_organization_id: w.orgId, p_patch: { auto_book: false } }, w.eigenaar.token), 'instelling terug');
  });

  // ── 2. Declaraties ───────────────────────────────────────────────────
  groep('Declaraties: alleen je eigen bon');
  await stap('een teamlid zonder Financiën dient een declaratie in, en krijgt alleen zijn eigen bon terug', async () => {
    leest('Shell Lopikerkapel', 'S-1001', 72.89);
    const res = gelukt(await bon(w, w.zonderFinancien), 'declaratie insturen');
    gelijk(res.channel, 'declaration', 'kanaal');
    gelijk(Object.keys(res.declaration).sort(), DECLARATIE_VELDEN, 'alleen de velden van de eigen bon');
    gelijk([res.declaration.status, res.declaration.store_name, res.declaration.total_cents, res.declaration.read],
      ['submitted', 'Shell Lopikerkapel', 7289, true], 'declaratie');
    verwacht(res.item === undefined && res.invoice === undefined, 'een declarant kreeg het werklijst-item of het concept terug');
    const rij = inbox(res.declaration.id);
    gelijk([rij.channel, rij.submitted_by, rij.status], ['declaration', w.zonderFinancien.id, 'ready'], 'op de werklijst');
    verwacht(rij.purchase_invoice_id, 'geen concept bij de declaratie');
    st.declaratie = res.declaration.id;
    st.declaratieFactuur = rij.purchase_invoice_id;
  });

  await stap('een lezer van Financiën declareert ook: zonder schrijfrecht geen eigen concept', async () => {
    leest('NS Utrecht Centraal', 'NS-55', 18.6);
    const res = gelukt(await bon(w, w.lezer), 'declaratie van de lezer');
    gelijk(res.channel, 'declaration', 'kanaal');
    st.declaratieLezer = res.declaration.id;
  });

  await stap('de badge telt declaraties die op goedkeuring wachten, eigen bonnen niet', async () => {
    // Precies de vraag van loadPurchaseInvoiceInboxOpenCount (src/lib/repository.ts).
    const filter = 'or=(status.in.(needs_review,duplicate,failed),and(channel.eq.declaration,status.eq.ready))';
    const rijen = gelukt(await rest(`purchase_invoice_inbox?select=id,channel,status&organization_id=eq.${w.orgId}&${filter}`, { token: w.eigenaar.token }), 'teller');
    gelijk(rijen.map((r) => `${r.channel}:${r.status}`).sort(), ['declaration:ready', 'declaration:ready'], 'de twee declaraties');
  });

  await stap('ieder ziet alleen zijn eigen declaraties', async () => {
    const eigen = gelukt(await mijnDeclaraties(w, w.zonderFinancien), 'lijst van de indiener');
    gelijk(eigen.map((d) => d.id), [nodig(st.declaratie, 'declaratie')], 'de indiener');
    gelijk([eigen[0].status, eigen[0].store_name, Number(eigen[0].total_cents)], ['submitted', 'Shell Lopikerkapel', 7289], 'zijn declaratie');
    const lezer = gelukt(await mijnDeclaraties(w, w.lezer), 'lijst van de lezer');
    gelijk(lezer.map((d) => d.id), [nodig(st.declaratieLezer, 'declaratie lezer')], 'de lezer');
    gelijk(gelukt(await mijnDeclaraties(w, w.eigenaar), 'lijst van de eigenaar').length, 0, 'de eigenaar heeft er geen');
    gelijk(gelukt(await mijnDeclaraties(w, w.medewerker), 'lijst van een collega').length, 0, 'een collega ziet er geen');
  });

  await stap('een declarant komt niet in de werklijst, de inkoopfacturen of de bijlagen', async () => {
    const t = w.zonderFinancien.token;
    gelijk((gelukt(await rest(`purchase_invoice_inbox?select=id&organization_id=eq.${w.orgId}`, { token: t }), 'inbox') ?? []).length, 0, 'werklijst');
    gelijk((gelukt(await rest(`purchase_invoices?select=id&organization_id=eq.${w.orgId}`, { token: t }), 'inkoopfacturen') ?? []).length, 0, 'inkoopfacturen');
    gelijk((gelukt(await rest(`suppliers?select=id&organization_id=eq.${w.orgId}`, { token: t }), 'leveranciers') ?? []).length, 0, 'leveranciers');
  });

  await stap('de lijst van een andere organisatie, of zonder inlog: geweigerd', async () => {
    geweigerd(await mijnDeclaraties(w, w.zonderFinancien, randomUUID()), 'andere organisatie');
    geweigerd(await rpc('list_my_declarations', { p_organization_id: w.orgId }), 'zonder inlog');
  });

  // ── 3. Wie wat mag ───────────────────────────────────────────────────
  groep('Bonnen: wie wat mag');
  await stap('kijker en boekhouder sturen geen bon in; een vreemde organisatie bestaat niet', async () => {
    const aantal = () => Number(sqlRij(`select count(*) as n from public.purchase_invoice_inbox where organization_id = ${q(w.orgId)}`).n);
    const voor = aantal();
    geweigerd(await bon(w, w.kijker), 'kijker', [403]);
    geweigerd(await bon(w, w.boekhouder), 'boekhouder', [403]);
    geweigerd(await bon(w, w.eigenaar, { org: randomUUID() }), 'andere organisatie', [403]);
    geweigerd(await roep('invoice-inbox', { body: { organizationId: w.orgId, action: 'upload', clientRequestId: randomUUID(), file: { name: 'x.jpg', mimeType: 'image/jpeg', dataBase64: Buffer.from(JPEG).toString('base64') } } }), 'zonder inlog', [401]);
    gelijk(aantal(), voor, 'er kwam niets bij');
  });

  await stap('afwijzen kan alleen met Financiën bewerken, en alleen met een reden', async () => {
    const id = nodig(st.declaratie, 'declaratie');
    geweigerd(await actie(w, w.lezer, id, { action: 'decline', note: 'Nee' }), 'lezer', [403]);
    geweigerd(await actie(w, w.zonderFinancien, id, { action: 'decline', note: 'Nee' }), 'de indiener zelf', [403]);
    geweigerd(await actie(w, w.eigenaar, id, { action: 'decline', note: '   ' }), 'zonder reden', [400]);
    geweigerd(await actie(w, w.eigenaar, id, { action: 'reject' }), 'negeren', [409]);
    gelijk(inbox(id).status, 'ready', 'niets veranderd');
  });

  // ── 4. Beslissen ─────────────────────────────────────────────────────
  groep('Declaraties: afwijzen, herstellen, goedkeuren');
  await stap('afwijzen met reden: het concept gaat weg, de indiener leest waarom', async () => {
    const id = nodig(st.declaratie, 'declaratie');
    const res = gelukt(await actie(w, w.eigenaar, id, { action: 'decline', note: 'Privé-uitgave, die declareren we niet.' }), 'afwijzen');
    gelijk([res.item.status, res.item.reason, res.item.review_note, res.item.purchase_invoice_id],
      ['rejected', 'declaration_declined', 'Privé-uitgave, die declareren we niet.', null], 'afgewezen');
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoices where id = ${q(st.declaratieFactuur)}`).n), 0, 'concept weg');
    gelijk(Number(sqlRij(`select count(*) as n from public.attachments where entity_type = 'purchase_invoice' and entity_id = ${q(st.declaratieFactuur)}`).n), 0, 'bijlage van het concept weg');
    const eigen = gelukt(await mijnDeclaraties(w, w.zonderFinancien), 'lijst');
    gelijk([eigen[0].status, eigen[0].review_note], ['rejected', 'Privé-uitgave, die declareren we niet.'], 'de indiener leest het');
    verwacht(eigen[0].decided_at, 'geen datum van de beslissing');
  });

  await stap('herstellen haalt hem terug, zonder de reden', async () => {
    leest('Shell Lopikerkapel', 'S-1001', 72.89);
    const res = gelukt(await actie(w, w.eigenaar, nodig(st.declaratie, 'declaratie'), { action: 'restore' }), 'herstellen');
    gelijk([res.item.status, res.item.review_note], ['ready', null], 'terug op de werklijst');
    st.declaratieFactuur = nodig(res.item.purchase_invoice_id, 'nieuw concept');
    gelijk(gelukt(await mijnDeclaraties(w, w.zonderFinancien), 'lijst')[0].status, 'submitted', 'weer ingediend');
  });

  await stap('goedkeuren is boeken: de indiener ziet "goedgekeurd"', async () => {
    gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: st.declaratieFactuur }, w.eigenaar.token), 'boeken');
    const rij = inbox(st.declaratie);
    gelijk([rij.status, rij.handled_by], ['booked', w.eigenaar.id], 'geboekt, door de eigenaar');
    const eigen = gelukt(await mijnDeclaraties(w, w.zonderFinancien), 'lijst');
    gelijk(eigen[0].status, 'approved', 'goedgekeurd');
    verwacht(sqlRij(`select journal_entry_id from public.purchase_invoices where id = ${q(st.declaratieFactuur)}`).journal_entry_id, 'geen journaalpost');
  });

  await stap('wat geboekt is, wijs je niet meer af', async () => {
    geweigerd(await actie(w, w.eigenaar, st.declaratie, { action: 'decline', note: 'Toch niet' }), 'afwijzen na boeken', [409]);
    gelijk(inbox(st.declaratie).status, 'booked', 'blijft geboekt');
  });

  // ── 5. Randgevallen ──────────────────────────────────────────────────
  groep('Bonnen: randgevallen');
  await stap('dezelfde foto twee keer (verbinding weg): één bon', async () => {
    const id = randomUUID();
    leest('Kruidvat Lopik', 'KV-9', 12.5);
    const voor = ai.bonnen.length;
    const eerste = gelukt(await bon(w, w.medewerker, { id }), 'eerste keer');
    const tweede = gelukt(await bon(w, w.medewerker, { id }), 'tweede keer');
    gelijk(tweede.item.id, eerste.item.id, 'zelfde bon');
    gelijk(ai.bonnen.length, voor + 1, 'één keer gelezen');
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoice_inbox where dedup_key like ${q(`upload:%:${id}`)}`).n), 1, 'één rij');
  });

  await stap('precies dezelfde foto later nog eens: dubbel, geen tweede concept', async () => {
    // De dubbelcontrole op bestand liep tot 2026-11-18 altijd vast ("invalid
    // input syntax for type json"), voor mail en voor bonnen.
    const zelfde = foto();
    leest('Hema Utrecht', 'HM-12', 9.95);
    const eerste = gelukt(await bon(w, w.eigenaar, { bytes: zelfde }), 'eerste keer');
    gelijk(eerste.item.status, 'ready', 'eerste: concept');
    const concepten = () => Number(sqlRij(`select count(*) as n from public.purchase_invoices where organization_id = ${q(w.orgId)}`).n);
    const voor = concepten();
    leest('Hema Utrecht', null, 9.95);
    const tweede = gelukt(await bon(w, w.eigenaar, { bytes: zelfde }), 'tweede keer');
    gelijk([tweede.item.status, tweede.item.reason, tweede.item.duplicate_of_purchase_invoice_id], ['duplicate', 'duplicate_file', eerste.invoice.id], 'tweede: dubbel');
    gelijk(concepten(), voor, 'geen tweede concept');
  });

  await stap('geen foto of pdf: geweigerd, en er blijft niets achter', async () => {
    const aantal = () => Number(sqlRij(`select count(*) as n from public.purchase_invoice_inbox where organization_id = ${q(w.orgId)}`).n);
    const voor = aantal();
    geweigerd(await bon(w, w.eigenaar, { bytes: new TextEncoder().encode('dit is geen foto') }), 'tekst als jpg', [400]);
    geweigerd(await bon(w, w.eigenaar, { naam: 'plaatje.gif', type: 'image/gif', bytes: new TextEncoder().encode('GIF89a') }), 'gif', [400]);
    geweigerd(await bon(w, w.eigenaar, { naam: 'factuur.xml', type: 'text/xml', bytes: new TextEncoder().encode('<Invoice/>') }), 'e-factuur', [400]);
    gelijk(aantal(), voor, 'niets vastgelegd');
  });

  await stap('opslag hapert: de app hoort het, en er blijft geen lege bon staan', async () => {
    const id = randomUUID();
    post.r2Storing.aantal = 1;
    const res = await bon(w, w.eigenaar, { id });
    post.r2Storing.aantal = 0;
    geweigerd(res, 'opslagstoring', [502]);
    verwacht(/niet worden opgeslagen/.test(res.json?.error ?? ''), `melding: ${res.json?.error}`);
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoice_inbox where dedup_key like ${q(`upload:%:${id}`)}`).n), 0, 'geen rij');
  });

  // ── 6. Een nee tegen AI, en zelf invullen ─────────────────────────────
  groep('Bonnen: geen AI, zelf invullen');
  await stap('wie nee zei tegen Gerrie: de bon gaat niet langs Claude', async () => {
    gelukt(await zetGerrieUit(w.orgId, w.medewerker), 'Gerrie uit');
    const voor = ai.bonnen.length;
    const res = gelukt(await bon(w, w.medewerker), 'bon insturen');
    gelijk(res.channel, 'receipt', 'kanaal');
    gelijk([res.item.status, res.item.reason, res.item.purchase_invoice_id], ['needs_review', 'ai_declined', null], 'niet gelezen');
    gelijk(ai.bonnen.length, voor, 'niet langs Claude');
    st.nietGelezen = res.item.id;
  });

  await stap('zelf invullen: het item hoort daarna bij het handgemaakte concept, met de foto', async () => {
    const id = nodig(st.nietGelezen, 'item');
    const leverancier = gelukt(await rest('suppliers?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, name: 'Lunchroom De Kade', status: 'active' },
    }), 'leverancier')[0];
    const concept = gelukt(await rest('purchase_invoices?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: {
        organization_id: w.orgId, supplier_id: leverancier.id, date: '2026-11-17', status: 'draft', payment_status: 'unpaid', source: 'manual',
        lines: [{ id: randomUUID(), description: 'Lunch', amount_cents: 1835, vat_code: 'LAAG', vat_rate: 9, account_id: null }],
        subtotal_cents: 1835, vat_cents: 165, total_cents: 2000, currency: 'EUR',
      },
    }), 'concept met de hand')[0];
    geweigerd(await actie(w, w.lezer, id, { action: 'link', purchaseInvoiceId: concept.id }), 'lezer koppelt niet', [403]);
    geweigerd(await actie(w, w.medewerker, id, { action: 'link', purchaseInvoiceId: randomUUID() }), 'onbekend concept', [404]);
    const res = gelukt(await actie(w, w.medewerker, id, { action: 'link', purchaseInvoiceId: concept.id }), 'koppelen');
    gelijk([res.item.status, res.item.purchase_invoice_id, res.item.supplier_id], ['ready', concept.id, leverancier.id], 'gekoppeld');
    const sleutel = inbox(id).attachments[0].storage_key;
    const bijlagen = sqlRijen(`select storage_key from public.attachments where entity_type = 'purchase_invoice' and entity_id = ${q(concept.id)}`);
    gelijk(bijlagen.map((b) => b.storage_key), [sleutel], 'de foto als bewijsstuk');
    geweigerd(await actie(w, w.medewerker, id, { action: 'link', purchaseInvoiceId: concept.id }), 'twee keer koppelen', [409]);
  });
}
