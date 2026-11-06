// Werkertest: de echte media-worker (workers/media-api) voor Word-, Excel- en
// PowerPoint-documenten, tegen de lokale stack. Wie mag een document uploaden,
// downloaden en (via de editor) lezen of schrijven, en wat gebeurt er als een
// documentrij naar een bestand van een andere module wijst?
//
// Waarom apart van run.mjs: hier draait niet een edge function in dit proces,
// maar de worker zelf in workerd (wrangler dev), met een lokale R2.
//
//   npx supabase start …                               (zie README.md)
//   cd /tmp/media-dev && wrangler dev --local --port 8788   (config: zie README.md)
//   node tests/stromen/werker-documenten.mjs
//
// MEDIA_DEV_URL en MEDIA_DEV_SIGNING_SECRET/INTERNAL_SECRET moeten passen bij
// de .dev.vars van die worker.
import { createHmac, randomUUID } from 'node:crypto';
import { rest, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, samenvatting, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';
import { maakGebruiker } from './supabase.mjs';

const WERKER = process.env.MEDIA_DEV_URL || 'http://127.0.0.1:8788';
const ONDERTEKEN = process.env.MEDIA_DEV_SIGNING_SECRET || 'lokaal-media-signing-geheim-voor-de-test';
const INTERN = process.env.MEDIA_DEV_INTERNAL_SECRET || 'r2-geheim-stromen';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

async function werker(pad, { token, method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${WERKER}${pad}`, {
    method,
    headers: { origin: 'http://localhost:5173', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tekst = new TextDecoder().decode(bytes);
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* bytes */ }
  return { status: res.status, headers: res.headers, json, tekst, bytes };
}

/** Een WOPI-token zoals /office/session hem maakt (dezelfde vorm en sleutel). */
function wopiToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const handtekening = createHmac('sha256', ONDERTEKEN).update(body).digest('base64url');
  return `${body}.${handtekening}`;
}

/** Een klein .docx-achtig bestand: de worker kijkt naar het type, niet naar de inhoud. */
function nepDocx(tekst) {
  return new TextEncoder().encode(`PK\u0003\u0004 nep-docx: ${tekst}`);
}

async function uploadDocument(gebruiker, orgId, naam, inhoud) {
  return werker('/office/document-upload', {
    method: 'POST', token: gebruiker.token,
    headers: { 'x-organization-id': orgId, 'x-file-name': encodeURIComponent(naam), 'x-file-type': DOCX, 'content-type': DOCX },
    body: nepDocx(inhoud),
  });
}

async function documentRij(gebruiker, orgId, upload, titel) {
  const res = await rest('documents?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: { organization_id: orgId, created_by: gebruiker.id, title: titel, content: '', storage_key: upload.key, mime_type: upload.mime_type, size_bytes: upload.size_bytes },
  });
  return gelukt(res, 'documentrij')[0];
}

const gezond = await fetch(`${WERKER}/health`).then((r) => r.ok).catch(() => false);
if (!gezond) {
  console.error(`De media-worker draait niet op ${WERKER}. Start hem met wrangler dev (zie de kop van dit bestand).`);
  process.exit(2);
}

groep('Werker: Word-documenten uploaden en downloaden');
const w = await stap('wereld maken', () => maakWereld('werker'));
const buren = await stap('de buren', () => maakWereld('werker-b'));
const geenInhoud = await stap('een teamlid zonder Inhoud', async () => {
  const g = await maakGebruiker('werker-geen');
  sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
       values (${q(w.orgId)}, ${q(g.id)}, ${q(g.email)}, 'member', 'active', '{"content":"none"}'::jsonb)`);
  return g;
});

const upload = await stap('een medewerker uploadt een Word-document: komt onder de eigen organisatie', async () => {
  const res = await uploadDocument(w.medewerker, w.orgId, 'Offerte ontwerp.docx', 'versie 1');
  const json = gelukt(res, 'upload');
  verwacht(json.key.startsWith(`${w.orgId}/document/`), `sleutel buiten de documentenmap: ${json.key}`);
  return json;
});

await stap('uploaden als kijker, zonder Inhoud of voor de buren kan niet', async () => {
  geweigerd(await uploadDocument(w.kijker, w.orgId, 'kijker.docx', 'x'), 'kijker', [403]);
  if (geenInhoud) geweigerd(await uploadDocument(geenInhoud, w.orgId, 'geen.docx', 'x'), 'zonder Inhoud', [403]);
  if (buren) geweigerd(await uploadDocument(buren.medewerker, w.orgId, 'buren.docx', 'x'), 'buren', [403]);
  geweigerd(await uploadDocument({ token: null }, w.orgId, 'anoniem.docx', 'x'), 'zonder login', [401]);
  const html = await werker('/office/document-upload', {
    method: 'POST', token: w.medewerker.token,
    headers: { 'x-organization-id': w.orgId, 'x-file-name': 'pagina.html', 'x-file-type': 'text/html' }, body: '<script>alert(1)</script>',
  });
  geweigerd(html, 'html als document', [415]);
});

const doc = upload && await stap('(de documentrij erbij, zoals de app hem maakt)', () => documentRij(w.medewerker, w.orgId, upload, 'Offerte ontwerp'));

if (doc) {
  await stap('downloaden: medewerker en kijker wel, als bijlage en veilig', async () => {
    const res = await werker(`/office/document-file/${doc.id}`, { token: w.medewerker.token });
    gelijk(res.status, 200, 'medewerker');
    verwacht(new TextDecoder().decode(res.bytes).includes('versie 1'), 'verkeerde inhoud');
    verwacht(/attachment/i.test(res.headers.get('content-disposition') ?? ''), `geen bijlage: ${res.headers.get('content-disposition')}`);
    gelijk(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
    verwacht(/no-store/.test(res.headers.get('cache-control') ?? ''), 'cache');
    gelijk((await werker(`/office/document-file/${doc.id}`, { token: w.kijker.token })).status, 200, 'kijker leest');
  });

  await stap('downloaden zonder Inhoud, door de buren of zonder login kan niet', async () => {
    if (geenInhoud) geweigerd(await werker(`/office/document-file/${doc.id}`, { token: geenInhoud.token }), 'zonder Inhoud', [403]);
    if (buren) geweigerd(await werker(`/office/document-file/${doc.id}`, { token: buren.medewerker.token }), 'buren', [403]);
    geweigerd(await werker(`/office/document-file/${doc.id}`, {}), 'zonder login', [401]);
    geweigerd(await werker(`/file/${encodeURIComponent(upload.key)}`, { token: buren?.medewerker.token }), 'buren via de sleutel', [403]);
  });

  await stap('een documentrij die naar een factuurbijlage wijst, opent die bijlage niet', async () => {
    const factuurBijlage = await werker('/upload', {
      method: 'POST', token: w.eigenaar.token,
      headers: { 'x-organization-id': w.orgId, 'x-entity-type': 'invoice', 'x-entity-id': randomUUID(), 'x-file-name': 'factuur.pdf', 'x-file-type': 'application/pdf' },
      body: new TextEncoder().encode('%PDF-1.4 geheim'),
    });
    const sleutel = gelukt(factuurBijlage, 'factuurbijlage').key;
    const rij = await documentRij(w.medewerker, w.orgId, { key: sleutel, mime_type: DOCX, size_bytes: 10 }, 'Leen een factuur');
    const res = await werker(`/office/document-file/${rij.id}`, { token: w.medewerker.token });
    geweigerd(res, 'factuur via een document', [403]);
    verwacht(!res.tekst.includes('geheim'), 'inhoud van de factuur uitgelekt');
  });

  groep('Werker: de online editor (WOPI)');
  const verloopt = Date.now() + 60 * 60 * 1000;
  const schrijfToken = wopiToken({ fid: doc.id, org: w.orgId, uid: w.medewerker.id, w: true, exp: verloopt, nm: 'Medewerker', k: 'd' });

  await stap('met een geldig token: bestandsinfo, inhoud en opslaan', async () => {
    const info = await werker(`/wopi/files/${doc.id}?access_token=${encodeURIComponent(schrijfToken)}`);
    gelijk([info.status, info.json?.UserCanWrite], [200, true], 'bestandsinfo');
    const inhoud = await werker(`/wopi/files/${doc.id}/contents?access_token=${encodeURIComponent(schrijfToken)}`);
    gelijk(inhoud.status, 200, 'inhoud');
    const opslaan = await werker(`/wopi/files/${doc.id}/contents?access_token=${encodeURIComponent(schrijfToken)}`, { method: 'POST', body: nepDocx('versie 2') });
    gelijk(opslaan.status, 200, `opslaan: ${opslaan.tekst.slice(0, 200)}`);
    const na = await werker(`/office/document-file/${doc.id}`, { token: w.medewerker.token });
    verwacht(new TextDecoder().decode(na.bytes).includes('versie 2'), 'opgeslagen versie niet terug');
  });

  await stap('een token voor een ander document, vervalst of verlopen werkt niet', async () => {
    const ander = await documentRij(w.medewerker, w.orgId, gelukt(await uploadDocument(w.medewerker, w.orgId, 'Ander.docx', 'ander'), 'upload'), 'Ander');
    geweigerd(await werker(`/wopi/files/${ander.id}/contents?access_token=${encodeURIComponent(schrijfToken)}`), 'ander document', [403]);
    const vals = `${schrijfToken.split('.')[0]}.${'A'.repeat(43)}`;
    geweigerd(await werker(`/wopi/files/${doc.id}?access_token=${encodeURIComponent(vals)}`), 'vervalst', [401]);
    const oud = wopiToken({ fid: doc.id, org: w.orgId, uid: w.medewerker.id, w: true, exp: Date.now() - 1000, k: 'd' });
    geweigerd(await werker(`/wopi/files/${doc.id}?access_token=${encodeURIComponent(oud)}`), 'verlopen', [401]);
  });

  await stap('met een leestoken opslaan kan niet', async () => {
    const leesToken = wopiToken({ fid: doc.id, org: w.orgId, uid: w.kijker.id, w: false, exp: verloopt, k: 'd' });
    geweigerd(await werker(`/wopi/files/${doc.id}/contents?access_token=${encodeURIComponent(leesToken)}`, { method: 'POST', body: nepDocx('door kijker') }), 'kijker schrijft', [403]);
  });

  await stap('na het intrekken van Inhoud werkt een bewaard token niet meer, ook niet om te lezen', async () => {
    const lid = await maakGebruiker('werker-vertrekt');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status)
         values (${q(w.orgId)}, ${q(lid.id)}, ${q(lid.email)}, 'member', 'active')`);
    const token = wopiToken({ fid: doc.id, org: w.orgId, uid: lid.id, w: true, exp: verloopt, k: 'd' });
    gelijk((await werker(`/wopi/files/${doc.id}/contents?access_token=${encodeURIComponent(token)}`)).status, 200, 'eerst wel');
    sql(`update public.organization_members set module_access = '{"content":"none"}'::jsonb where organization_id = ${q(w.orgId)} and user_id = ${q(lid.id)}`);
    geweigerd(await werker(`/wopi/files/${doc.id}/contents?access_token=${encodeURIComponent(token)}`), 'lezen na intrekken Inhoud', [403]);
    geweigerd(await werker(`/wopi/files/${doc.id}?access_token=${encodeURIComponent(token)}`), 'bestandsinfo na intrekken Inhoud', [403]);
    sql(`update public.organization_members set module_access = null, status = 'disabled' where organization_id = ${q(w.orgId)} and user_id = ${q(lid.id)}`);
    geweigerd(await werker(`/wopi/files/${doc.id}/contents?access_token=${encodeURIComponent(token)}`), 'lezen na vertrek', [403]);
  });

  await stap('alleen lezen in Inhoud: de editor meldt "niet schrijven", ook met een oud schrijftoken', async () => {
    const lid = await maakGebruiker('werker-lezer');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
         values (${q(w.orgId)}, ${q(lid.id)}, ${q(lid.email)}, 'member', 'active', '{"content":"read"}'::jsonb)`);
    const token = wopiToken({ fid: doc.id, org: w.orgId, uid: lid.id, w: true, exp: verloopt, k: 'd' });
    const info = await werker(`/wopi/files/${doc.id}?access_token=${encodeURIComponent(token)}`);
    gelijk([info.status, info.json?.UserCanWrite], [200, false], 'bestandsinfo');
  });

  groep('Werker: de PDF-omzetting voor contracten');
  await stap('de omzetting neemt alleen contractbestanden aan', async () => {
    const res = await werker('/internal/office/convert-pdf', {
      method: 'POST', token: INTERN, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: w.orgId, storageKey: upload.key }),
    });
    geweigerd(res, 'documentsleutel omzetten', [403]);
    verwacht(/contractbestand/.test(res.json?.error ?? ''), `geweigerd om een andere reden: ${res.tekst.slice(0, 200)}`);
    // Een contractsleutel komt wél langs de controle (en loopt hier pas vast op
    // de editor, die lokaal niet draait).
    const contract = await werker('/internal/office/convert-pdf', {
      method: 'POST', token: INTERN, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: w.orgId, storageKey: `${w.orgId}/contract/${randomUUID()}/body.docx` }),
    });
    verwacht(!/contractbestand/.test(contract.json?.error ?? ''), `contractsleutel geweigerd: ${contract.tekst.slice(0, 200)}`);
  });
}

groep('Werker: rommel in het adres');
await stap('een kapotte codering in een bestandsadres geeft geen serverfout', async () => {
  const res = await werker(`/file/${w?.orgId}/document/%E0%A4%A`, { token: w?.medewerker.token });
  verwacht(res.status >= 400 && res.status < 500, `verwacht 4xx, kreeg ${res.status}`);
});

const fouten = samenvatting();
process.exit(fouten > 0 ? 1 : 0);
