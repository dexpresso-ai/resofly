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
//      hangt hem aan een met de hand gemaakt concept;
//   7. de controle van 19 november 2026 (inkoop): het btw-bedrag van de bon
//      telt (€ 10,00 blijft € 10,00), verlegde btw zit niet in het totaal en
//      geeft geen valse waarschuwing, een verkoopcode komt niet op een bon, een
//      onwaarschijnlijke datum geeft een waarschuwing en wordt niet geboekt,
//      een klaargezet concept kan weg terwijl de foto blijft, en de werklijst
//      raakt niets kwijt dat aandacht vraagt.
import { randomBytes, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { ai, BON } from './nep-ai.mjs';
import { post } from './nepdiensten.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
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

  // ── 7. Controle inkoop, 19 november 2026 ─────────────────────────────
  groep('Bonnen: btw-bedrag, verlegde btw, btw-codes, datum (controle 2026-11-19)');

  /** Wat Claude de volgende keer leest, met eigen regels en totalen. */
  const leestRegels = (winkel, nummer, regels, totalen, extra = {}) => {
    ai.bon = { ...BON, supplier: { ...BON.supplier, name: winkel, ...(extra.supplier ?? {}) }, supplier_invoice_number: nummer, lines: regels, totals: totalen, ...(extra.datum ? { invoice_date: extra.datum } : {}) };
  };
  const totalenVan = (voorstel) => [voorstel.totals.subtotal_cents, voorstel.totals.vat_cents, voorstel.totals.total_cents];
  const concept = (id) => sqlRij(`select status, date, subtotal_cents, vat_cents, total_cents, lines, extraction_meta->'warnings' as waarschuwingen from public.purchase_invoices where id = ${q(id)}`);
  const boeking = (factuurId) => sqlRijen(`select la.code, jl.debit_cents, jl.credit_cents from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id join public.ledger_accounts la on la.id = jl.account_id
     where je.source_type = 'purchase_invoice' and je.source_id = ${q(factuurId)} and je.reverses_entry_id is null order by la.code`)
    .map((r) => `${r.code}:${Number(r.debit_cents) - Number(r.credit_cents)}`);

  await stap('een bon van € 10,00 blijft € 10,00: het btw-bedrag van de bon telt, ook in de boeking', async () => {
    // € 8,26 × 21% = € 1,73; de winkel rekent € 1,74. Het concept was € 9,99,
    // een cent naast de pinbetaling.
    leestRegels('Bakkerij Lopik', 'BL-10', [{ description: 'Gebak', amount_excl_vat: 8.26, vat_rate: 21, account_code: null, vat_code: 'HOOG' }],
      { subtotal_excl_vat: 8.26, vat_amount: 1.74, total_incl_vat: 10 });
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    gelijk([res.item.status, res.invoice.total_cents], ['ready', 1000], 'totaal van het concept');
    gelijk(totalenVan(res.item.proposal), [826, 174, 1000], 'totalen in het voorstel');
    verwacht(!res.item.warnings.some((r) => /wijken af/.test(r)), `waarschuwing: ${res.item.warnings.join(' | ')}`);
    const pi = concept(res.invoice.id);
    gelijk([Number(pi.subtotal_cents), Number(pi.vat_cents), Number(pi.total_cents), pi.lines[0].vat_cents], [826, 174, 1000, 174], 'kop en regel');
    gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: res.invoice.id }, w.eigenaar.token), 'boeken');
    gelijk(boeking(res.invoice.id), ['1500:174', '1600:-1000', '4500:826'], 'boeking: crediteuren is het bonbedrag');
  });

  await stap('klopt de berekende btw al, dan komt er geen btw-bedrag op de regel', async () => {
    leest('Gamma Utrecht', 'GM-3', 23.4);
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    verwacht(!('vat_cents' in concept(res.invoice.id).lines[0]), 'een btw-bedrag op de regel terwijl het berekende klopt');
  });

  await stap('verlegde btw (EU): totaal € 100, geen valse waarschuwing; de boeking geeft 4b aan', async () => {
    // Eerder: "BTW € 21,00, totaal € 121,00" en de waarschuwing dat de
    // bedragen afweken, bij elke goed gelezen verlegde factuur.
    leestRegels('Google Ireland Ltd', 'GI-2026-11', [{ description: 'Google Ads', amount_excl_vat: 100, vat_rate: 0, account_code: null, vat_code: 'EU_VERW' }],
      { subtotal_excl_vat: 100, vat_amount: 0, total_incl_vat: 100 }, { supplier: { country: 'IE', vat_number: 'IE6388047V' } });
    const res = gelukt(await bon(w, w.eigenaar), 'factuur insturen');
    gelijk(res.invoice.total_cents, 10000, 'totaal van het concept');
    gelijk(totalenVan(res.item.proposal), [10000, 0, 10000], 'totalen in het voorstel');
    gelijk(res.item.warnings, [], 'geen waarschuwing');
    gelijk(res.item.confidence, 'high', 'zekerheid blijft hoog');
    const pi = concept(res.invoice.id);
    gelijk([pi.lines[0].vat_code, pi.lines[0].vat_rate, Number(pi.vat_cents), Number(pi.total_cents)], ['EU_VERW', 21, 0, 10000], 'regel en kop');
    gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: res.invoice.id }, w.eigenaar.token), 'boeken');
    gelijk(boeking(res.invoice.id), ['1500:2100', '1520:-2100', '1600:-10000', '4500:10000'], 'boeking: € 100 op crediteuren, € 21 aangeven en aftrekken');
  });

  await stap('een verkoopcode komt niet op een bon: ICP wordt de inkoopkant, export wordt 0%', async () => {
    leestRegels('Adobe Systems Ireland', 'AD-7', [{ description: 'Creative Cloud', amount_excl_vat: 60, vat_rate: 0, account_code: null, vat_code: 'ICP_DIENST' }],
      { subtotal_excl_vat: 60, vat_amount: 0, total_incl_vat: 60 }, { supplier: { country: 'IE' } });
    const icp = gelukt(await bon(w, w.eigenaar), 'factuur met ICP-code');
    gelijk(concept(icp.invoice.id).lines[0].vat_code, 'EU_VERW', 'ICP diensten wordt Verwerving EU');
    verwacht(icp.item.warnings.some((r) => /ICP_DIENST.*verkoopcode/.test(r)), `waarschuwing: ${icp.item.warnings.join(' | ')}`);
    gelijk(icp.item.confidence, 'medium', 'zekerheid omlaag: een mens kijkt het na');

    // Zonder btw: bij gelijk tarief stond "Export buiten EU" vooraan (alfabet).
    leestRegels('Gemeente Lopik', 'LEGES-1', [{ description: 'Leges', amount_excl_vat: 35, vat_rate: 0, account_code: null, vat_code: null }],
      { subtotal_excl_vat: 35, vat_amount: 0, total_incl_vat: 35 });
    const nul = gelukt(await bon(w, w.eigenaar), 'bon zonder btw');
    gelijk([concept(nul.invoice.id).lines[0].vat_code, nul.item.warnings], ['NUL', []], 'een regel zonder btw krijgt NUL');

    leestRegels('Postkantoor Lopik', 'PK-4', [{ description: 'Postzegels', amount_excl_vat: 12, vat_rate: 0, account_code: null, vat_code: 'EXPORT' }],
      { subtotal_excl_vat: 12, vat_amount: 0, total_incl_vat: 12 });
    const exportCode = gelukt(await bon(w, w.eigenaar), 'bon met exportcode');
    gelijk(concept(exportCode.invoice.id).lines[0].vat_code, 'NUL', 'export wordt NUL');
    verwacht(exportCode.item.warnings.some((r) => /EXPORT.*verkoopcode/.test(r)), `waarschuwing: ${exportCode.item.warnings.join(' | ')}`);
  });

  await stap('een datum in 2062: waarschuwing, zekerheid omlaag, en boeken wordt geweigerd', async () => {
    leestRegels('Praxis Utrecht', 'PX-2062', [{ description: 'Verf', amount_excl_vat: 10, vat_rate: 21, account_code: null, vat_code: 'HOOG' }],
      { subtotal_excl_vat: 10, vat_amount: 2.1, total_incl_vat: 12.1 }, { datum: '2062-11-16' });
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    verwacht(res.item.warnings.some((r) => /16-11-2062 ligt in de toekomst/.test(r)), `waarschuwing: ${res.item.warnings.join(' | ')}`);
    gelijk(res.item.confidence, 'medium', 'zekerheid');
    gelijk(concept(res.invoice.id).status, 'draft', 'concept');
    const geboekt = await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: res.invoice.id }, w.eigenaar.token);
    geweigerd(geboekt, 'boeken in 2062');
    verwacht(/toekomst/.test(JSON.stringify(geboekt.json ?? geboekt.tekst ?? '')), `melding: ${JSON.stringify(geboekt.json ?? geboekt.tekst)}`);
  });

  await stap('een bon van vóór de startdatum van de boekhouding: waarschuwing op het concept', async () => {
    sql(`update public.company_settings set bookkeeping_start_date = '2026-01-01' where organization_id = ${q(w.orgId)}`);
    leestRegels('Bruna Utrecht', 'BR-2025', [{ description: 'Agenda', amount_excl_vat: 10, vat_rate: 21, account_code: null, vat_code: 'HOOG' }],
      { subtotal_excl_vat: 10, vat_amount: 2.1, total_incl_vat: 12.1 }, { datum: '2025-12-30' });
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    verwacht(res.item.warnings.some((r) => /30-12-2025 ligt vóór de startdatum van je boekhouding \(01-01-2026\)/.test(r)), `waarschuwing: ${res.item.warnings.join(' | ')}`);
    verwacht((concept(res.invoice.id).waarschuwingen ?? []).some((r) => /startdatum/.test(r)), 'de waarschuwing staat niet op het concept');
  });

  groep('Bonnen: een klaargezet concept weggooien, en de werklijst (controle 2026-11-19)');
  await stap('negeren van een klaargezette bon: het concept gaat weg, de foto blijft en is terug te halen', async () => {
    leest('Etos Lopik', 'ET-1', 6.5);
    const res = gelukt(await bon(w, w.eigenaar), 'bon insturen');
    const sleutel = inbox(res.item.id).attachments[0].storage_key;
    geweigerd(await actie(w, w.lezer, res.item.id, { action: 'reject' }), 'een lezer negeert niet', [403]);
    const weg = gelukt(await actie(w, w.eigenaar, res.item.id, { action: 'reject' }), 'negeren');
    gelijk([weg.item.status, weg.item.reason, weg.item.purchase_invoice_id], ['rejected', 'dismissed_by_user', null], 'genegeerd');
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoices where id = ${q(res.invoice.id)}`).n), 0, 'concept weg');
    gelijk(Number(sqlRij(`select count(*) as n from public.attachments where entity_type = 'purchase_invoice' and entity_id = ${q(res.invoice.id)}`).n), 0, 'geen losse bijlage-regel');
    gelijk(inbox(res.item.id).attachments[0].storage_key, sleutel, 'de foto hoort nog bij het item');
    verwacht(post.r2.has(sleutel), 'de foto is van R2 verdwenen');
    leest('Etos Lopik', 'ET-1', 6.5);
    const terug = gelukt(await actie(w, w.eigenaar, res.item.id, { action: 'restore' }), 'herstellen');
    gelijk(terug.item.status, 'ready', 'weer een concept');
    st.hersteld = { item: res.item.id, factuur: terug.item.purchase_invoice_id };
  });

  await stap('een concept dat geboekt en tegengeboekt is, blijft bewaard: negeren kan niet, de boekstukken zijn te vinden', async () => {
    const { item, factuur } = nodig(st.hersteld, 'herstelde bon');
    const journaal = gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: factuur }, w.eigenaar.token), 'boeken');
    const boekstuk = Array.isArray(journaal) ? journaal[0] : journaal;
    const tegen = gelukt(await rpc('reverse_journal_entry', { p_entry_id: boekstuk.id, p_date: null }, w.eigenaar.token), 'tegenboeken');
    const tegenboeking = Array.isArray(tegen) ? tegen[0] : tegen;
    // Zonder datum: op de datum van het boekstuk zelf, niet op vandaag (20261119180000).
    gelijk(tegenboeking.date, boekstuk.date, 'de tegenboeking staat op de datum van het boekstuk');
    gelijk(concept(factuur).status, 'draft', 'weer een concept');
    geweigerd(await actie(w, w.eigenaar, item, { action: 'reject' }), 'negeren na boeken', [409]);
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoices where id = ${q(factuur)}`).n), 1, 'het concept staat er nog');
    // Precies de vraag van loadPurchaseInvoiceRemovalFacts (src/lib/repository.ts):
    // daarop weigert het formulier "Concept verwijderen".
    const stukken = gelukt(await rest(`journal_entries?select=id,entry_number&organization_id=eq.${w.orgId}&source_type=eq.purchase_invoice&source_id=eq.${factuur}&order=date.asc`, { token: w.eigenaar.token }), 'boekstukken');
    gelijk(stukken.length, 2, 'boeking en tegenboeking');
    const bron = gelukt(await rest(`purchase_invoice_inbox?select=id,channel&organization_id=eq.${w.orgId}&purchase_invoice_id=eq.${factuur}&limit=1`, { token: w.eigenaar.token }), 'item van de werklijst');
    gelijk(bron.map((r) => [r.id, r.channel]), [[item, 'receipt']], 'het item bij het concept');
  });

  await stap('een kaal concept (zonder bon, nooit geboekt) kan de eigenaar verwijderen; een lezer niet', async () => {
    const leverancier = gelukt(await rest('suppliers?select=id', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, name: 'Tikfout BV', status: 'active' },
    }), 'leverancier')[0];
    const kaal = gelukt(await rest('purchase_invoices?select=id', {
      method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
      body: {
        organization_id: w.orgId, supplier_id: leverancier.id, date: '2026-11-18', status: 'draft', payment_status: 'unpaid', source: 'manual',
        lines: [{ id: randomUUID(), description: 'Verkeerd ingevoerd', amount_cents: 1000, vat_code: 'HOOG', vat_rate: 21, account_id: null }],
        subtotal_cents: 1000, vat_cents: 210, total_cents: 1210, currency: 'EUR',
      },
    }), 'concept')[0];
    // De leverancier heeft nu een factuur: verwijderen geeft de fout die het
    // scherm in gewone woorden zegt (describeSupplierDeleteError).
    const leverancierWeg = await rest(`suppliers?id=eq.${leverancier.id}&organization_id=eq.${w.orgId}`, { method: 'DELETE', token: w.eigenaar.token });
    geweigerd(leverancierWeg, 'leverancier met facturen verwijderen');
    gelijk(leverancierWeg.json?.code, '23503', 'de foutcode waar het scherm op let');
    await rest(`purchase_invoices?id=eq.${kaal.id}&organization_id=eq.${w.orgId}`, { method: 'DELETE', token: w.lezer.token });
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoices where id = ${q(kaal.id)}`).n), 1, 'een lezer verwijdert niets');
    gelukt(await rest(`purchase_invoices?id=eq.${kaal.id}&organization_id=eq.${w.orgId}`, { method: 'DELETE', token: w.eigenaar.token }), 'verwijderen');
    gelijk(Number(sqlRij(`select count(*) as n from public.purchase_invoices where id = ${q(kaal.id)}`).n), 0, 'concept weg');
  });

  await stap('de werklijst raakt geen bon kwijt: wat aandacht vraagt komt altijd mee, ook na 200 nieuwere items', async () => {
    // Een oude bon die niet gelezen is, en daarna 205 afgehandelde items.
    sql(`insert into public.purchase_invoice_inbox (organization_id, dedup_key, subject, received_at, status, reason, channel)
         values (${q(w.orgId)}, 'test:oud:' || gen_random_uuid(), 'Oude bon, niet gelezen', now() - interval '90 days', 'needs_review', 'nothing_extracted', 'receipt')`);
    sql(`insert into public.purchase_invoice_inbox (organization_id, dedup_key, subject, received_at, status, channel)
         select ${q(w.orgId)}, 'test:vol:' || gen_random_uuid(), 'Afgehandeld ' || n, now() - (n || ' minutes')::interval, 'booked', 'email' from generate_series(1, 205) n`);
    const basis = `purchase_invoice_inbox?select=id,subject,status&organization_id=eq.${w.orgId}&order=received_at.desc,id.desc`;
    // Zoals het was: de 200 nieuwste van alles. De oude bon zit er niet bij.
    const oud = gelukt(await rest(`${basis}&status=neq.dropped&limit=200`, { token: w.eigenaar.token }), 'oude vraag');
    verwacht(!oud.some((r) => r.subject === 'Oude bon, niet gelezen'), 'de oude vraag vond de bon wel: de test toetst niets');
    // Zoals loadPurchaseInvoiceInbox het nu vraagt: eerst alles wat open is.
    const open = gelukt(await rest(`${basis}&or=(status.in.(received,processing,needs_review,duplicate,failed),and(channel.eq.declaration,status.eq.ready))&offset=0&limit=500`, { token: w.eigenaar.token }), 'open items');
    verwacht(open.some((r) => r.subject === 'Oude bon, niet gelezen'), 'de oude bon ontbreekt in de open items');
    verwacht(open.every((r) => r.status !== 'booked' && r.status !== 'rejected'), 'een afgehandeld item bij de open items');
    const klaar = gelukt(await rest(`${basis}&status=in.(ready,booked,rejected)&limit=200`, { token: w.eigenaar.token }), 'afgehandelde items');
    gelijk(klaar.length, 200, 'de limiet geldt alleen voor wat is afgehandeld');
  });
}
