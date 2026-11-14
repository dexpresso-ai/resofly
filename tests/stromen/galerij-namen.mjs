// Galerij: geen twee bestanden met dezelfde naam in één album (migratie
// 20261114150000). De app vraagt vóór het uploaden wat er met een dubbel
// bestand moet; hier staat wat de database daarna nog bewaakt, als echte
// gebruikers via PostgREST met RLS:
//
// - dezelfde naam, ook in andere hoofdletters of Unicode-vorm, wordt geweigerd
//   met de eigen hint die de app herkent;
// - in een ander album mag dezelfde naam gewoon;
// - een rij die zijn naam houdt (ook een oud dubbel bestand) blijft bij te werken;
// - vijf uploads tegelijk met dezelfde naam: er komt er precies één in;
// - wie niet mag schrijven of er niet bij hoort, krijgt nooit "deze naam
//   bestaat al" te zien; anders kon hij raden wat er in een album staat.
//
// Zonder worker: het gaat om de rij, niet om de bestanden in R2.
import { spawn } from 'node:child_process';
import { DB_URL } from './omgeving.mjs';
import { rest, sql, sqlRij, maakGebruiker, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

const HINT = 'gallery_items_file_name_taken';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function item(gebruiker, wereld, galleryId, naam, extra = {}) {
  return rest('gallery_items?select=id,file_name', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: { organization_id: wereld.orgId, gallery_id: galleryId, media_type: 'photo', file_name: naam, size_bytes: 10, ...extra },
  });
}

function naamBezet(res, melding) {
  gelijk(res.status, 409, `${melding}: status`);
  gelijk(res.json?.code, '23505', `${melding}: code`);
  gelijk(res.json?.hint, HINT, `${melding}: hint`);
}

function geenNaamMelding(res, melding) {
  geweigerd(res, melding);
  verwacht(res.json?.hint !== HINT, `${melding}: kreeg "naam bestaat al" te zien (${res.status} ${res.tekst})`);
}

export default async function galerijNamen() {
  groep('Galerij: dubbele bestandsnamen');
  const w = await maakWereld('galnamen');
  const vreemde = await maakGebruiker('galnamen-vreemde');

  const project = gelukt(await rest('projects?select=id', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, client_id: w.klantA.id, name: uniek('Bruiloft') },
  }), 'project')[0];
  const album = async (titel) => gelukt(await rest('galleries?select=id', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, project_id: project.id, title: titel },
  }), `album ${titel}`)[0];
  const a = await album('Ceremonie');
  const b = await album('Feest');

  const taart = await stap('een nieuwe naam mag', async () => gelukt(await item(w.medewerker, w, a.id, 'taart.jpg'), 'taart.jpg')[0]);

  await stap('dezelfde naam nog eens: geweigerd, met de hint voor de app', async () => {
    const res = await item(w.medewerker, w, a.id, 'taart.jpg');
    naamBezet(res, 'tweede taart.jpg');
    verwacht(String(res.json?.message).includes('taart.jpg'), `de melding noemt de naam niet: ${res.tekst}`);
  });

  await stap('hoofdletters tellen niet mee', async () => {
    naamBezet(await item(w.medewerker, w, a.id, 'TAART.JPG'), 'TAART.JPG');
  });

  await stap('spaties eromheen tellen niet mee', async () => {
    naamBezet(await item(w.medewerker, w, a.id, '  taart.jpg '), '" taart.jpg "');
  });

  await stap('Unicode-vorm telt niet mee (é van Windows en van een Mac)', async () => {
    gelukt(await item(w.medewerker, w, a.id, 'Café.jpg'), 'Café.jpg (NFC)');
    naamBezet(await item(w.medewerker, w, a.id, 'Café.jpg'), 'Café.jpg (NFD)');
  });

  await stap('in een ander album mag dezelfde naam', async () => {
    gelukt(await item(w.medewerker, w, b.id, 'taart.jpg'), 'taart.jpg in Feest');
  });

  await stap('de nieuwe naam die de app kiest, mag', async () => {
    gelukt(await item(w.medewerker, w, a.id, 'taart-2.jpg'), 'taart-2.jpg');
  });

  await stap('hernoemen naar een bezette naam: geweigerd; naar een vrije: mag', async () => {
    const rij = gelukt(await item(w.medewerker, w, a.id, 'dans.jpg'), 'dans.jpg')[0];
    naamBezet(await rest(`gallery_items?id=eq.${rij.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { file_name: 'Taart.jpg' },
    }), 'hernoemen naar Taart.jpg');
    const ok = gelukt(await rest(`gallery_items?id=eq.${rij.id}&select=file_name`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { file_name: 'dans-2.jpg' },
    }), 'hernoemen naar dans-2.jpg');
    gelijk(ok[0]?.file_name, 'dans-2.jpg', 'nieuwe naam');
  });

  await stap('een rij die zijn eigen naam meestuurt, blijft bij te werken', async () => {
    const ok = gelukt(await rest(`gallery_items?id=eq.${taart.id}&select=file_name,sort_order`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { file_name: 'taart.jpg', sort_order: 7 },
    }), 'bijwerken met dezelfde naam');
    gelijk(ok[0]?.sort_order, 7, 'volgorde');
  });

  await stap('ook de server (zonder RLS) krijgt geen dubbele naam', async () => {
    let fout = '';
    try {
      sql(`insert into public.gallery_items (organization_id, gallery_id, media_type, file_name)
           values (${q(w.orgId)}, ${q(a.id)}, 'photo', 'taart.jpg')`);
    } catch (e) {
      fout = String(e?.stderr || e?.message || e);
    }
    verwacht(/al een bestand met de naam/.test(fout), `geen weigering voor de server: ${fout || 'ingevoegd'}`);
  });

  await stap('een oud dubbel paar (van vóór deze regel) blijft bij te werken en te verwijderen', async () => {
    // Zo kan het op staging al staan: er was geen controle.
    sql(`alter table public.gallery_items disable trigger zzzzz_gallery_items_unique_name;
         insert into public.gallery_items (organization_id, gallery_id, media_type, file_name)
         values (${q(w.orgId)}, ${q(a.id)}, 'photo', 'Taart.JPG');
         alter table public.gallery_items enable trigger zzzzz_gallery_items_unique_name;`);
    const oud = sqlRij(`select id from public.gallery_items where gallery_id = ${q(a.id)} and file_name = 'Taart.JPG'`);
    verwacht(oud?.id, 'het oude dubbele bestand staat er niet');
    gelukt(await rest(`gallery_items?id=eq.${oud.id}&select=id`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { file_name: 'Taart.JPG', featured: true },
    }), 'oud dubbel bestand bijwerken');
    gelukt(await rest(`gallery_items?id=eq.${oud.id}`, { method: 'DELETE', token: w.medewerker.token }), 'oud dubbel bestand verwijderen');
  });

  await stap('vijf uploads tegelijk met dezelfde naam: er komt er precies één in', async () => {
    const pogingen = await Promise.all(Array.from({ length: 5 }, () => item(w.medewerker, w, a.id, 'tegelijk.jpg')));
    const gelukte = pogingen.filter((res) => res.status === 201);
    gelijk(gelukte.length, 1, 'gelukte inserts');
    for (const res of pogingen.filter((r) => r.status !== 201)) naamBezet(res, 'gelijktijdige insert');
    const telling = sqlRij(`select count(*)::int as n from public.gallery_items where gallery_id = ${q(a.id)} and lower(file_name) = 'tegelijk.jpg'`);
    gelijk(telling.n, 1, 'rijen in de database');
  });

  await stap('twee transacties tegelijk, de eerste nog open: de tweede wacht en wordt geweigerd', async () => {
    // Over PostgREST kwamen de vijf pogingen hierboven ook zonder de lock goed
    // uit; daar zat de race dus niet in. Hier wel: zonder pg_advisory_xact_lock
    // stonden er na deze stap twee rijen "race.jpg".
    const eerste = new Promise((resolve) => {
      const p = spawn('psql', [DB_URL, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
        `begin;
         insert into public.gallery_items (organization_id, gallery_id, media_type, file_name)
         values (${q(w.orgId)}, ${q(a.id)}, 'photo', 'race.jpg');
         select pg_sleep(2);
         commit;`], { stdio: 'ignore' });
      p.on('exit', resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    let fout = '';
    try {
      sql(`insert into public.gallery_items (organization_id, gallery_id, media_type, file_name)
           values (${q(w.orgId)}, ${q(a.id)}, 'photo', 'race.jpg')`);
    } catch (e) {
      fout = String(e?.stderr || e?.message || e);
    }
    gelijk(await eerste, 0, 'de eerste transactie');
    verwacht(/al een bestand met de naam/.test(fout), `de tweede kwam erdoor: ${fout || 'ingevoegd'}`);
    gelijk(sqlRij(`select count(*)::int as n from public.gallery_items where gallery_id = ${q(a.id)} and file_name = 'race.jpg'`).n, 1, 'rijen');
  });

  await stap('een kijker krijgt de gewone weigering, niet "naam bestaat al"', async () => {
    geenNaamMelding(await item(w.kijker, w, a.id, 'taart.jpg'), 'kijker');
  });

  await stap('een boekhouder ook', async () => {
    geenNaamMelding(await item(w.boekhouder, w, a.id, 'taart.jpg'), 'boekhouder');
  });

  await stap('iemand van buiten: hetzelfde antwoord voor een bestaande en een verzonnen naam', async () => {
    const bestaand = await item(vreemde, w, a.id, 'taart.jpg');
    const verzonnen = await item(vreemde, w, a.id, `bestaat-niet-${uniek('x')}.jpg`);
    geenNaamMelding(bestaand, 'vreemde, bestaande naam');
    geenNaamMelding(verzonnen, 'vreemde, verzonnen naam');
    gelijk([bestaand.status, bestaand.json?.code], [verzonnen.status, verzonnen.json?.code], 'zelfde antwoord');
  });

  await stap('de triggerfunctie is door niemand zelf aan te roepen', async () => {
    const rechten = sqlRij(`select
      has_function_privilege('anon', 'public.enforce_gallery_items_unique_name()', 'execute') as anon,
      has_function_privilege('authenticated', 'public.enforce_gallery_items_unique_name()', 'execute') as authenticated`);
    gelijk([rechten.anon, rechten.authenticated], [false, false], 'execute-rechten');
  });
}
