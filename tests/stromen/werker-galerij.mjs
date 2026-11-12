// Werkertest: de echte media-worker (workers/media-api) voor de galerij, tegen
// de lokale stack. Uploaden, kijken, wie een album of foto mag verwijderen, en
// of alles wat uit de database verdwijnt ook uit R2 verdwijnt: meteen via
// /gallery/purge, via de geplande taak, en na het verwijderen van een project.
//
// Waarom apart van run.mjs: hier draait de worker zelf in workerd (wrangler
// dev), met een lokale R2. Zie werker-documenten.mjs en README.md.
//
//   npx supabase start …                                    (zie README.md)
//   cd /tmp/media-dev && wrangler dev --local --port 8788 --test-scheduled
//   MEDIA_DEV_DIR=/tmp/media-dev node tests/stromen/werker-galerij.mjs
//
// --test-scheduled zet /__scheduled aan: daarmee start de test de geplande taak.
// MEDIA_DEV_DIR (optioneel) is de map van wrangler dev: daar zet de test een
// bestand rechtstreeks in de lokale R2, zoals een upload die te laat landt.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rest, sql, sqlRij, sqlRijen, maakGebruiker, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, samenvatting, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const WERKER = process.env.MEDIA_DEV_URL || 'http://127.0.0.1:8788';
const MEDIA_DEV_DIR = process.env.MEDIA_DEV_DIR || '';
const MEDIA_DEV_BUCKET = process.env.MEDIA_DEV_BUCKET || 'media-dev';
const WRANGLER = fileURLToPath(new URL('../../workers/media-api/node_modules/.bin/wrangler', import.meta.url));

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

function postJson(pad, token, body) {
  return werker(pad, { method: 'POST', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Een klein "jpeg": de worker kijkt naar het type, niet naar de inhoud. */
function nepJpeg(tekst) {
  return new TextEncoder().encode(`ÿØÿ nep-jpeg: ${tekst}`);
}

async function uploadVariant(gebruiker, orgId, galleryId, itemId, variant, naam) {
  return werker('/gallery/upload', {
    method: 'POST', token: gebruiker.token,
    headers: {
      'x-organization-id': orgId, 'x-gallery-id': galleryId, 'x-item-id': itemId, 'x-variant': variant,
      'x-file-name': encodeURIComponent(naam), 'x-file-type': 'image/jpeg', 'content-type': 'image/jpeg',
    },
    body: nepJpeg(`${variant} ${naam}`),
  });
}

/** Zoals uploadOne in ProjectGallery.tsx: drie varianten, dan de rij. */
async function fotoUploaden(gebruiker, wereld, galleryId, naam) {
  const itemId = randomUUID();
  const sleutels = {};
  for (const variant of ['original', 'preview', 'thumb']) {
    sleutels[variant] = gelukt(await uploadVariant(gebruiker, wereld.orgId, galleryId, itemId, variant, naam), `upload ${variant}`).key;
  }
  const rij = gelukt(await rest('gallery_items?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: {
      organization_id: wereld.orgId, gallery_id: galleryId, media_type: 'photo', file_name: naam,
      content_type: 'image/jpeg', size_bytes: 20, storage_key: sleutels.original,
      preview_key: sleutels.preview, thumb_key: sleutels.thumb,
    },
  }), 'galerij-item')[0];
  return { rij, sleutels };
}

async function albumMaken(gebruiker, wereld, projectId, titel) {
  return gelukt(await rest('galleries?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: { organization_id: wereld.orgId, project_id: projectId, title: titel },
  }), 'album')[0];
}

async function projectMaken(gebruiker, wereld, naam) {
  return gelukt(await rest('projects?select=id', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: { organization_id: wereld.orgId, client_id: wereld.klantA.id, name: uniek(naam) },
  }), 'project')[0];
}

async function kijkSessie(gebruiker, orgId, galleryId) {
  return postJson('/gallery/view-session', gebruiker.token, { organizationId: orgId, galleryId });
}

/** Staat dit bestand nog in R2? Met een geldig kijktoken: 200 = ja, 404 = weg. */
async function bestaat(sleutel, token) {
  const res = await werker(`/gallery/file/${encodeURIComponent(sleutel)}?token=${encodeURIComponent(token)}`);
  if (res.status !== 200 && res.status !== 404) throw new Error(`onverwacht ${res.status} voor ${sleutel}: ${res.tekst.slice(0, 200)}`);
  return res.status === 200;
}

function wachtrij(orgId) {
  return sqlRijen(`select kind, target, passes, attempts, gallery_id from public.gallery_purge_queue
                    where organization_id = ${q(orgId)} order by created_at, target`);
}

function creatiefAan(orgId) {
  sql(`select public.ensure_organization_billing_profile(${q(orgId)})`);
  sql(`update public.organization_billing_profiles set creative_enabled = true where organization_id = ${q(orgId)}`);
}

async function lidMet(wereld, naam, rol, modules) {
  const g = await maakGebruiker(naam);
  sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
       values (${q(wereld.orgId)}, ${q(g.id)}, ${q(g.email)}, ${q(rol)}, 'active', ${modules ? `${q(JSON.stringify(modules))}::jsonb` : 'null'})`);
  return g;
}

const gezond = await fetch(`${WERKER}/health`).then((r) => r.ok).catch(() => false);
if (!gezond) {
  console.error(`De media-worker draait niet op ${WERKER}. Start hem met wrangler dev (zie de kop van dit bestand).`);
  process.exit(2);
}

groep('Galerij: klaarzetten');
const w = await stap('wereld maken, met de creatieve module aan', async () => {
  const wereld = await maakWereld('galerij');
  creatiefAan(wereld.orgId);
  return wereld;
});
const buren = await stap('de buren, ook met de creatieve module', async () => {
  const wereld = await maakWereld('galerij-b');
  creatiefAan(wereld.orgId);
  return wereld;
});
const zonderProjecten = await stap('een teamlid zonder Projecten', () => lidMet(w, 'galerij-geenproj', 'member', { projects: 'none' }));
const leestProjecten = await stap('een teamlid dat Projecten alleen leest', () => lidMet(w, 'galerij-leest', 'member', { projects: 'read' }));
const project = await stap('een project', () => projectMaken(w.medewerker, w, 'Bruiloft'));
const album = await stap('een album, door een medewerker', () => albumMaken(w.medewerker, w, project.id, 'Trouwalbum'));

groep('Galerij: uploaden en kijken');
const foto1 = await stap('twee foto\'s uploaden zoals de app dat doet', () => fotoUploaden(w.medewerker, w, album.id, 'eerste dans.jpg'));
const foto2 = await stap('(de tweede)', () => fotoUploaden(w.medewerker, w, album.id, 'taart.jpg'));
const wees = await stap('een upload die halverwege afbrak: een bestand zonder rij', async () => {
  return gelukt(await uploadVariant(w.medewerker, w.orgId, album.id, randomUUID(), 'thumb', 'afgebroken.jpg'), 'wees').key;
});
const cover = await stap('een eigen coverbeeld', async () => {
  const coverId = randomUUID();
  const preview = gelukt(await uploadVariant(w.medewerker, w.orgId, album.id, coverId, 'preview', 'cover.jpg'), 'cover preview').key;
  const thumb = gelukt(await uploadVariant(w.medewerker, w.orgId, album.id, coverId, 'thumb', 'cover.jpg'), 'cover thumb').key;
  gelukt(await rest(`galleries?id=eq.${album.id}&select=id`, {
    method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
    body: { cover_preview_key: preview, cover_thumb_key: thumb, cover_bytes: 40 },
  }), 'cover zetten');
  return { preview, thumb };
});

await stap('uploaden in andermans album of zonder Projecten kan niet', async () => {
  geweigerd(await uploadVariant(buren.medewerker, w.orgId, album.id, randomUUID(), 'thumb', 'x.jpg'), 'buren in ons album', [403]);
  geweigerd(await uploadVariant(buren.medewerker, buren.orgId, album.id, randomUUID(), 'thumb', 'x.jpg'), 'buren met hun eigen organisatie', [404]);
  geweigerd(await uploadVariant(zonderProjecten, w.orgId, album.id, randomUUID(), 'thumb', 'x.jpg'), 'zonder Projecten', [403]);
  geweigerd(await uploadVariant(leestProjecten, w.orgId, album.id, randomUUID(), 'thumb', 'x.jpg'), 'alleen lezen', [403]);
  geweigerd(await uploadVariant(w.kijker, w.orgId, album.id, randomUUID(), 'thumb', 'x.jpg'), 'kijker', [403]);
});

const sessie = await stap('kijken: tokenbundel, en twee keer openen geeft hetzelfde token', async () => {
  const eerste = gelukt(await kijkSessie(w.medewerker, w.orgId, album.id), 'kijksessie');
  const tweede = gelukt(await kijkSessie(w.kijker, w.orgId, album.id), 'kijksessie kijker');
  gelijk(tweede.mediaToken, eerste.mediaToken, 'zelfde token binnen hetzelfde blok (dus dezelfde URL\'s, uit de cache)');
  const over = eerste.exp - Date.now();
  verwacht(over > 49 * 60 * 1000 && over <= 60 * 60 * 1000, `token leeft ${Math.round(over / 60000)} minuten`);
  return eerste;
});

await stap('kijken door de buren, zonder Projecten of zonder login kan niet', async () => {
  geweigerd(await kijkSessie(buren.medewerker, w.orgId, album.id), 'buren', [403]);
  geweigerd(await kijkSessie(buren.medewerker, buren.orgId, album.id), 'buren via hun eigen organisatie', [404]);
  geweigerd(await kijkSessie(zonderProjecten, w.orgId, album.id), 'zonder Projecten', [403]);
  geweigerd(await kijkSessie(w.boekhouder, w.orgId, album.id), 'boekhouder', [403]);
  geweigerd(await kijkSessie({ token: null }, w.orgId, album.id), 'zonder login', [401]);
});

await stap('een miniatuur: één keer ophalen, cachen zolang het token geldt', async () => {
  const res = await werker(`/gallery/file/${encodeURIComponent(foto1.sleutels.thumb)}?token=${encodeURIComponent(sessie.mediaToken)}`);
  gelijk(res.status, 200, 'miniatuur');
  verwacht(new TextDecoder().decode(res.bytes).includes('thumb eerste dans'), 'verkeerde inhoud');
  gelijk(res.headers.get('content-type'), 'image/jpeg', 'type');
  gelijk(res.headers.get('content-length'), String(res.bytes.length), 'lengte');
  const cache = res.headers.get('cache-control') ?? '';
  const maxAge = Number(cache.match(/max-age=(\d+)/)?.[1] ?? -1);
  verwacht(/private/.test(cache) && /immutable/.test(cache), `cache: ${cache}`);
  verwacht(maxAge > 0 && maxAge <= 3600 && maxAge <= (sessie.exp - Date.now()) / 1000 + 1, `max-age ${maxAge} past niet bij het token`);
  gelijk(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
});

await stap('een stuk van het origineel (spoelen) en HEAD kloppen nog', async () => {
  const deel = await werker(`/gallery/file/${encodeURIComponent(foto1.sleutels.original)}?token=${encodeURIComponent(sessie.mediaToken)}`, {
    headers: { range: 'bytes=2-5' },
  });
  gelijk(deel.status, 206, 'range');
  verwacht(/^bytes 2-5\/\d+$/.test(deel.headers.get('content-range') ?? ''), `content-range: ${deel.headers.get('content-range')}`);
  gelijk(deel.bytes.length, 4, 'lengte van het stuk');
  const kop = await werker(`/gallery/file/${encodeURIComponent(foto1.sleutels.original)}?token=${encodeURIComponent(sessie.mediaToken)}`, { method: 'HEAD' });
  gelijk(kop.status, 200, 'HEAD');
  verwacht(Number(kop.headers.get('content-length')) > 0, 'HEAD zonder lengte');
  const teVer = await werker(`/gallery/file/${encodeURIComponent(foto1.sleutels.original)}?token=${encodeURIComponent(sessie.mediaToken)}`, {
    headers: { range: 'bytes=999999-' },
  });
  gelijk(teVer.status, 416, 'range voorbij het eind');
});

await stap('een token van het ene album opent het andere niet', async () => {
  const ander = await albumMaken(buren.medewerker, buren, (await projectMaken(buren.medewerker, buren, 'Buren')).id, 'Buren-album');
  const hun = gelukt(await kijkSessie(buren.medewerker, buren.orgId, ander.id), 'kijksessie buren');
  geweigerd(await werker(`/gallery/file/${encodeURIComponent(foto1.sleutels.thumb)}?token=${encodeURIComponent(hun.mediaToken)}`), 'token van de buren', [403]);
});

await stap('de zip van het album werkt', async () => {
  const zip = await werker(`/gallery/zip/${album.id}?token=${encodeURIComponent(sessie.mediaToken)}`);
  gelijk(zip.status, 200, 'zip');
  gelijk(zip.headers.get('content-type'), 'application/zip', 'type');
  verwacht(zip.bytes[0] === 0x50 && zip.bytes[1] === 0x4b, 'geen zip');
});

groep('Galerij: een foto verwijderen');
await stap('verwijderen door de buren, een kijker of wie Projecten alleen leest: er gebeurt niets', async () => {
  for (const [wie, gebruiker] of [['buren', buren.medewerker], ['kijker', w.kijker], ['alleen lezen', leestProjecten], ['zonder Projecten', zonderProjecten]]) {
    nietsVeranderd(await rest(`gallery_items?id=eq.${foto1.rij.id}&select=id`, {
      method: 'DELETE', token: gebruiker.token, prefer: 'return=representation',
    }), wie);
  }
  gelijk(wachtrij(w.orgId).length, 0, 'wachtrij');
  verwacht(await bestaat(foto1.sleutels.original, sessie.mediaToken), 'origineel weg');
});

await stap('de wachtrij is niet te lezen of te vullen door een teamlid', async () => {
  const lezen = await rest('gallery_purge_queue?select=*', { token: w.eigenaar.token });
  verwacht(lezen.status >= 400 || (Array.isArray(lezen.json) && lezen.json.length === 0), `lezen: ${lezen.status} ${lezen.tekst.slice(0, 200)}`);
  const schrijven = await rest('gallery_purge_queue', {
    method: 'POST', token: w.eigenaar.token,
    body: { organization_id: buren.orgId, gallery_id: randomUUID(), kind: 'folder', target: `${buren.orgId}/gallery/x/` },
  });
  geweigerd(schrijven, 'zelf iets in de wachtrij zetten');
});

await stap('de medewerker verwijdert de foto: de drie bestanden staan in de wachtrij', async () => {
  gelijk(gelukt(await rest(`gallery_items?id=eq.${foto1.rij.id}&select=id`, {
    method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation',
  }), 'verwijderen').length, 1, 'rijen');
  const rijen = wachtrij(w.orgId);
  gelijk(rijen.map((r) => r.kind), ['object', 'object', 'object'], 'soorten');
  gelijk(rijen.map((r) => r.target).sort(), Object.values(foto1.sleutels).sort(), 'sleutels');
});

await stap('opruimen door de buren of een kijker kan niet', async () => {
  geweigerd(await postJson('/gallery/purge', buren.medewerker.token, { organizationId: w.orgId, galleryId: album.id }), 'buren', [403]);
  geweigerd(await postJson('/gallery/purge', w.kijker.token, { organizationId: w.orgId, galleryId: album.id }), 'kijker', [403]);
  geweigerd(await postJson('/gallery/purge', leestProjecten.token, { organizationId: w.orgId, galleryId: album.id }), 'alleen lezen', [403]);
  geweigerd(await postJson('/gallery/purge', null, { organizationId: w.orgId, galleryId: album.id }), 'zonder login', [401]);
  gelijk(wachtrij(w.orgId).length, 3, 'wachtrij onaangeroerd');
});

await stap('opruimen door de medewerker: de bestanden zijn weg, de rest staat er nog', async () => {
  const res = gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: album.id }), 'opruimen');
  gelijk([res.done, res.failed, res.objects], [3, 0, 3], 'telling');
  gelijk(wachtrij(w.orgId).length, 0, 'wachtrij leeg');
  for (const sleutel of Object.values(foto1.sleutels)) verwacht(!(await bestaat(sleutel, sessie.mediaToken)), `${sleutel} staat er nog`);
  for (const sleutel of Object.values(foto2.sleutels)) verwacht(await bestaat(sleutel, sessie.mediaToken), `${sleutel} is mee verdwenen`);
  verwacht(await bestaat(cover.preview, sessie.mediaToken), 'cover mee verdwenen');
});

await stap('een rij die naar een bestand van een ander album wijst, wist dat bestand niet', async () => {
  const ander = await albumMaken(w.medewerker, w, project.id, 'Ander album');
  // Binnen de eigen organisatie laat de database elke sleutel toe; de browser
  // schrijft hem zelf. Bij het verwijderen mag dat nooit het bestand van een
  // ander album kosten.
  const leen = gelukt(await rest('gallery_items?select=id', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, gallery_id: ander.id, media_type: 'photo', file_name: 'leen.jpg',
      storage_key: foto2.sleutels.original, preview_key: foto2.sleutels.preview, thumb_key: foto2.sleutels.thumb,
    },
  }), 'lenende rij')[0];
  gelukt(await rest(`gallery_items?id=eq.${leen.id}`, { method: 'DELETE', token: w.medewerker.token }), 'lenende rij weg');
  gelijk(wachtrij(w.orgId).length, 0, 'niets in de wachtrij');
  gelukt(await rest(`galleries?id=eq.${ander.id}`, { method: 'DELETE', token: w.medewerker.token }), 'ander album weg');
  gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: ander.id }), 'opruimen');
  for (const sleutel of Object.values(foto2.sleutels)) verwacht(await bestaat(sleutel, sessie.mediaToken), `${sleutel} is verdwenen`);
});

groep('Galerij: een ander coverbeeld');
await stap('het eigen coverbeeld weghalen: het oude beeld verdwijnt uit R2', async () => {
  gelukt(await rest(`galleries?id=eq.${album.id}&select=id`, {
    method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
    body: { cover_preview_key: null, cover_thumb_key: null, cover_bytes: 0 },
  }), 'cover weg');
  gelijk(wachtrij(w.orgId).filter((r) => r.gallery_id === album.id).map((r) => r.target).sort(), [cover.preview, cover.thumb].sort(), 'wachtrij');
  gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: album.id }), 'opruimen');
  verwacht(!(await bestaat(cover.preview, sessie.mediaToken)), 'cover preview staat er nog');
  verwacht(!(await bestaat(cover.thumb, sessie.mediaToken)), 'cover thumb staat er nog');
});

groep('Galerij: een album verwijderen');
await stap('de buren, een kijker of wie Projecten alleen leest kunnen het album niet verwijderen', async () => {
  for (const [wie, gebruiker] of [['buren', buren.medewerker], ['buren-eigenaar', buren.eigenaar], ['kijker', w.kijker], ['alleen lezen', leestProjecten], ['zonder Projecten', zonderProjecten], ['boekhouder', w.boekhouder]]) {
    nietsVeranderd(await rest(`galleries?id=eq.${album.id}&select=id`, {
      method: 'DELETE', token: gebruiker.token, prefer: 'return=representation',
    }), wie);
  }
  verwacht(sqlRij(`select id from public.galleries where id = ${q(album.id)}`), 'album verdwenen');
});

await stap('de buren kunnen de bestanden van ons album ook via de worker niet wissen', async () => {
  // Met hun eigen organisatie: de worker veegt alleen onder de map van díe
  // organisatie, en daar staat niets van ons.
  gelukt(await postJson('/gallery/purge', buren.eigenaar.token, { organizationId: buren.orgId, galleryId: album.id }), 'buren ruimen hun eigen map op');
  geweigerd(await postJson('/gallery/purge', buren.eigenaar.token, { organizationId: w.orgId, galleryId: album.id }), 'buren met onze organisatie', [403]);
  geweigerd(await werker(`/file/${encodeURIComponent(foto2.sleutels.original)}`, { method: 'DELETE', token: buren.eigenaar.token }), 'buren via /file', [403]);
  for (const sleutel of [...Object.values(foto2.sleutels), wees]) verwacht(await bestaat(sleutel, sessie.mediaToken), `${sleutel} is verdwenen`);
});

await stap('opruimen voor een album dat er nog is, wist niets', async () => {
  gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: album.id }), 'opruimen');
  for (const sleutel of [...Object.values(foto2.sleutels), wees]) verwacht(await bestaat(sleutel, sessie.mediaToken), `${sleutel} is verdwenen`);
});

await stap('de medewerker verwijdert het album: alles weg, ook de wees, met een tweede ronde', async () => {
  gelijk(gelukt(await rest(`galleries?id=eq.${album.id}&select=id`, {
    method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation',
  }), 'verwijderen').length, 1, 'rijen');
  const vanAlbum = () => wachtrij(w.orgId).filter((r) => r.gallery_id === album.id);
  gelijk(vanAlbum().map((r) => [r.kind, r.target, r.passes]), [['folder', `${w.orgId}/gallery/${album.id}/`, 0]], 'wachtrij');
  const res = gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: album.id }), 'opruimen');
  verwacht(res.swept === 4, `geveegd: ${JSON.stringify(res)}`);
  for (const sleutel of [...Object.values(foto2.sleutels), wees]) verwacht(!(await bestaat(sleutel, sessie.mediaToken)), `${sleutel} staat er nog`);
  gelijk(vanAlbum().map((r) => [r.kind, r.passes]), [['folder', 1]], 'de map staat klaar voor de tweede ronde');
});

await stap('een bestand dat binnenkomt terwijl het album wordt verwijderd, gaat in de tweede ronde', async () => {
  // Een upload die vlak vóór het verwijderen langs de controles kwam en pas
  // daarna in R2 landde. De worker neemt na het verwijderen niets meer aan
  // voor dit album, dus de test zet het bestand rechtstreeks in de lokale R2
  // (MEDIA_DEV_DIR = de map met de wrangler.toml van wrangler dev).
  const laat = `${w.orgId}/gallery/${album.id}/${randomUUID()}/thumb-${randomUUID()}-laat.jpg`;
  if (MEDIA_DEV_DIR) {
    const bestand = join(MEDIA_DEV_DIR, 'laat.jpg');
    writeFileSync(bestand, 'laat binnengekomen');
    execFileSync(WRANGLER, ['r2', 'object', 'put', `${MEDIA_DEV_BUCKET}/${laat}`, '--file', bestand, '--local'], {
      cwd: MEDIA_DEV_DIR, stdio: 'ignore',
    });
    verwacht(await bestaat(laat, sessie.mediaToken), 'het late bestand staat niet in R2');
  } else {
    console.log('        (zonder MEDIA_DEV_DIR: alleen de regel, geen laat bestand)');
  }
  sql(`update public.gallery_purge_queue set purge_after = now() where gallery_id = ${q(album.id)}`);
  gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: album.id }), 'tweede ronde');
  if (MEDIA_DEV_DIR) verwacht(!(await bestaat(laat, sessie.mediaToken)), 'het late bestand staat er nog');
  gelijk(wachtrij(w.orgId).filter((r) => r.gallery_id === album.id).length, 0, 'na de tweede ronde is de regel weg');
});

groep('Galerij: de geplande taak');
await stap('een album van een verwijderd project ruimt de geplande taak op', async () => {
  const p2 = await projectMaken(w.medewerker, w, 'Fotoshoot');
  const a2 = await albumMaken(w.medewerker, w, p2.id, 'Shoot');
  const f = await fotoUploaden(w.medewerker, w, a2.id, 'portret.jpg');
  const s2 = gelukt(await kijkSessie(w.medewerker, w.orgId, a2.id), 'kijksessie');
  verwacht(await bestaat(f.sleutels.original, s2.mediaToken), 'upload niet te zien');
  gelukt(await rest(`projects?id=eq.${p2.id}`, { method: 'DELETE', token: w.eigenaar.token }), 'project verwijderen');
  verwacht(!sqlRij(`select id from public.galleries where id = ${q(a2.id)}`), 'album niet mee verwijderd');
  verwacht(wachtrij(w.orgId).some((r) => r.kind === 'folder' && r.gallery_id === a2.id), 'map niet in de wachtrij');
  // Ook de tweede ronde van eerder verwijderde albums is nu aan de beurt.
  sql(`update public.gallery_purge_queue set purge_after = now() where organization_id = ${q(w.orgId)}`);
  const cron = await werker('/__scheduled?cron=*/15+*+*+*+*');
  gelijk(cron.status, 200, `de geplande taak (wrangler dev --test-scheduled): ${cron.tekst.slice(0, 200)}`);
  // De taak loopt door na het antwoord (waitUntil): even wachten tot hij klaar is.
  const klaar = () => wachtrij(w.orgId).every((r) => r.kind === 'stream' || (r.gallery_id === a2.id && r.passes === 1));
  for (let i = 0; i < 40 && !klaar(); i += 1) await new Promise((r) => setTimeout(r, 250));
  for (const sleutel of Object.values(f.sleutels)) verwacht(!(await bestaat(sleutel, s2.mediaToken)), `${sleutel} staat er nog`);
  gelijk(wachtrij(w.orgId).filter((r) => r.kind !== 'stream').map((r) => [r.gallery_id, r.passes]), [[a2.id, 1]],
    'over: alleen de tweede ronde van het projectalbum');
});

await stap('een kijkkopie bij Stream blijft in de wachtrij zolang Stream niet is ingericht', async () => {
  const a3 = await albumMaken(w.medewerker, w, project.id, 'Video');
  const uid = randomUUID().replace(/-/g, '');
  const rij = gelukt(await rest('gallery_items?select=id', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, gallery_id: a3.id, media_type: 'video', file_name: 'film.mp4', stream_uid: uid, stream_status: 'ready' },
  }), 'video-item')[0];
  gelukt(await rest(`gallery_items?id=eq.${rij.id}`, { method: 'DELETE', token: w.medewerker.token }), 'video weg');
  gelijk(wachtrij(w.orgId).filter((r) => r.kind === 'stream').map((r) => r.target), [uid], 'stream in de wachtrij');
  const res = gelukt(await postJson('/gallery/purge', w.medewerker.token, { organizationId: w.orgId, galleryId: a3.id }), 'opruimen');
  gelijk(res.failed, 0, 'geen mislukte pogingen');
  gelijk(wachtrij(w.orgId).filter((r) => r.kind === 'stream').map((r) => r.attempts), [0], 'wacht op Stream, telt niet als poging');
});

const fouten = samenvatting();
process.exit(fouten > 0 ? 1 : 0);
