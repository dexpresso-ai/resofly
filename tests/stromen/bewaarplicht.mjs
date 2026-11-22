// Bewaarplicht: wat verstuurd of geboekt is, blijft precies zo bewaard.
//
// Waarom dit scenario: de controle van 22 november 2026 (boekhouder,
// Belastingdienst en bewaarplicht) vond twee plekken waar dat niet zo was.
//   1. Het bewijsstuk van een geboekte inkoopfactuur was met de eigen sessie te
//      wissen (DELETE op attachments) en te vervangen (PATCH van storage_key).
//      Het scherm toonde de knop niet en Gerrie weigerde, de database niet.
//      Migratie 20261122131000_bewijsstukken_vast.sql.
//   2. De e-factuur (UBL) werd niet bewaard zoals hij verstuurd was: een latere
//      download was opnieuw opgebouwd met de gegevens van vandaag.
//      Migratie 20261122132000_efactuur_bewaren.sql.
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
    const factuur = await verstuurdeFactuur(w, k, '2026-10-08', [{ description: 'Fotoshoot', quantity: 1, unit_price: 200, vat_rate: 21 }]);
    const att = gelukt(await bijlage(w, 'invoice', factuur.id, 'urenstaat.pdf'), 'bijlage bij de verstuurde factuur')[0];
    geweigerd(await rest(`attachments?id=eq.${att.id}`, { method: 'DELETE', token: w.eigenaar.token }), 'DELETE bij een verstuurde factuur');
    geweigerd(await rest(`attachments?id=eq.${att.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { name: 'anders.pdf' } }), 'hernoemen bij een verstuurde factuur');
    gelukt(await rest(`attachments?id=eq.${att.id}`, { method: 'PATCH', token: w.eigenaar.token, body: { locked_by: w.eigenaar.id, locked_at: new Date().toISOString() } }), 'slot van de editor');
    gelijk(bestaat(att.id), true, 'de bijlage staat er nog');
  });
}

export default async function bewaarplicht() {
  await bewijsstukken();
}
