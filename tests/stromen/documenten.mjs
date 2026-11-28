// Documenten: maken, bewerken, ordenen, delen en verwijderen, door de echte
// rechten (PostgREST met RLS en de modulepoorten) en de echte functies
// (file-share, file-share-public) tegen de lokale stack.
//
// Waarom zo: een document is meer dan een rij. Het hangt aan een klant, een
// project of een map, het kan gedeeld worden met een klant, en het valt onder
// de module Inhoud. Wat mis kan gaan zit in de randen: een rol die toch kan
// schrijven, een koppeling naar iets van een andere organisatie, een deellink
// die na intrekken nog werkt, of "laatst gewijzigd" dat niet meeloopt.
//
//   npm run test:stromen -- documenten
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { roep } from './functies.mjs';
import { mailsAan, post } from './nepdiensten.mjs';
import { maakGebruiker, rest, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** Een teamlid met eigen modulerechten (zoals Instellingen → Team dat zet). */
// De namen van wat de klant in het portaal ziet bij één deling, gesorteerd.
async function portaalTitels(token, shareId) {
  const portaal = gelukt(await roep('client-portal', { token, body: { action: 'getSharedFiles' } }), 'portaal');
  const deling = (portaal.shares ?? []).find((d) => d.id === shareId);
  return (deling?.items ?? []).map((item) => item.name).sort((a, b) => a.localeCompare(b, 'nl')).join(',');
}

async function lidMet(orgId, naam, modules, rol = 'member') {
  const gebruiker = await maakGebruiker(naam);
  sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
       values (${q(orgId)}, ${q(gebruiker.id)}, ${q(gebruiker.email)}, ${q(rol)}, 'active', ${q(JSON.stringify(modules))}::jsonb)`);
  return gebruiker;
}

async function maak(tabel, token, body, select = '*') {
  const res = await rest(`${tabel}?select=${select}`, { method: 'POST', token, prefer: 'return=representation', body });
  return res;
}

async function wijzig(tabel, token, id, body) {
  return rest(`${tabel}?id=eq.${id}&select=*`, { method: 'PATCH', token, prefer: 'return=representation', body });
}

async function lees(tabel, token, id, select = '*') {
  const res = await rest(`${tabel}?id=eq.${id}&select=${select}`, { token });
  return Array.isArray(res.json) ? res.json : [];
}

/** De delen van een zip (zoals een .docx): naam → inhoud. Alleen opgeslagen of met deflate ingepakt. */
function leesZip(bytes) {
  const buffer = Buffer.from(bytes);
  const eind = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const aantal = buffer.readUInt16LE(eind + 10);
  let pos = buffer.readUInt32LE(eind + 16);
  const delen = new Map();
  for (let i = 0; i < aantal; i += 1) {
    const methode = buffer.readUInt16LE(pos + 10);
    const grootte = buffer.readUInt32LE(pos + 20);
    const naamLengte = buffer.readUInt16LE(pos + 28);
    const begin = buffer.readUInt32LE(pos + 42);
    const naam = buffer.subarray(pos + 46, pos + 46 + naamLengte).toString('utf8');
    const data = begin + 30 + buffer.readUInt16LE(begin + 26) + buffer.readUInt16LE(begin + 28);
    const ruw = buffer.subarray(data, data + grootte);
    delen.set(naam, methode === 8 ? inflateRawSync(ruw) : Buffer.from(ruw));
    pos += 46 + naamLengte + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return delen;
}

const VEILIGE_INHOUD = '<h2>Werkafspraken</h2><p>Oplevering in <strong>week 48</strong>.</p><ul><li>Concept</li><li>Definitief</li></ul>';

export default async function documentenScenario() {
  groep('Documenten: gewoon gebruik');
  const w = await stap('wereld maken', () => maakWereld('documenten'));
  if (!w) return;
  const ander = await stap('een tweede organisatie (de buren)', () => maakWereld('documenten-b'));

  const project = await stap('een project bij klant A', async () => {
    const res = await maak('projects', w.medewerker.token, { organization_id: w.orgId, client_id: w.klantA.id, name: 'Website' });
    gelukt(res, 'project');
    return res.json[0];
  });

  const doc = await stap('een medewerker maakt een document bij klant A en het project, en leest het terug', async () => {
    const res = await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, project_id: project.id,
      title: 'Werkafspraken', content: VEILIGE_INHOUD, document_type: 'procedure',
    });
    gelukt(res, 'document maken');
    const rij = res.json[0];
    gelijk([rij.organization_id, rij.created_by, rij.client_id, rij.project_id], [w.orgId, w.medewerker.id, w.klantA.id, project.id], 'koppelingen');
    gelijk((await lees('documents', w.beheerder.token, rij.id, 'title,content'))[0]?.content, VEILIGE_INHOUD, 'een collega leest dezelfde inhoud');
    return rij;
  });
  if (!doc) return;

  await stap('bewerken zonder datum mee te sturen (zoals de API, Gerrie en de Word-editor): "gewijzigd" loopt mee', async () => {
    sql(`update public.documents set created_at = now() - interval '2 days', updated_at = now() - interval '2 days' where id = ${q(doc.id)}`);
    const res = await wijzig('documents', w.medewerker.token, doc.id, { title: 'Werkafspraken v2' });
    gelukt(res, 'bewerken');
    const rij = sqlRij(`select title, (updated_at > now() - interval '1 minute') as vers from public.documents where id = ${q(doc.id)}`);
    gelijk([rij.title, rij.vers], ['Werkafspraken v2', true], 'titel en gewijzigd-datum');
  });

  await stap('een documentsoort buiten de lijst wordt geweigerd', async () => {
    geweigerd(await wijzig('documents', w.medewerker.token, doc.id, { document_type: 'virus' }), 'soort');
  });

  const map = await stap('in een map van dezelfde klant zetten', async () => {
    const res = await maak('content_folders', w.medewerker.token, { organization_id: w.orgId, client_id: w.klantA.id, name: 'Contracten' });
    gelukt(res, 'map');
    gelukt(await wijzig('documents', w.medewerker.token, doc.id, { folder_id: res.json[0].id }), 'in de map');
    return res.json[0];
  });

  await stap('de map verwijderen: het document blijft, buiten de map', async () => {
    const res = await rest(`content_folders?id=eq.${map.id}`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' });
    gelukt(res, 'map weg');
    const rij = sqlRij(`select folder_id from public.documents where id = ${q(doc.id)}`);
    gelijk(rij?.folder_id, null, 'document na map verwijderen');
  });

  groep('Documenten: rechten binnen de organisatie');
  const zonderInhoud = await stap('teamleden met Inhoud "geen" en "alleen lezen"', async () => ({
    geen: await lidMet(w.orgId, 'doc-geen', { content: 'none' }),
    lezen: await lidMet(w.orgId, 'doc-lezen', { content: 'read' }),
  }));

  await stap('de kijker leest, maar maakt, wijzigt en verwijdert niets', async () => {
    gelijk((await lees('documents', w.kijker.token, doc.id, 'id')).length, 1, 'lezen');
    geweigerd(await maak('documents', w.kijker.token, { organization_id: w.orgId, created_by: w.kijker.id, title: 'Kijker' }), 'maken');
    nietsVeranderd(await wijzig('documents', w.kijker.token, doc.id, { title: 'Door kijker' }), 'wijzigen');
    nietsVeranderd(await rest(`documents?id=eq.${doc.id}`, { method: 'DELETE', token: w.kijker.token, prefer: 'return=representation' }), 'verwijderen');
    gelijk(sqlRij(`select title from public.documents where id = ${q(doc.id)}`).title, 'Werkafspraken v2', 'titel');
  });

  await stap('de boekhouder ziet geen documenten (alleen Financiën)', async () => {
    gelijk((await lees('documents', w.boekhouder.token, doc.id, 'id')).length, 0, 'lezen');
    geweigerd(await maak('documents', w.boekhouder.token, { organization_id: w.orgId, created_by: w.boekhouder.id, title: 'Boekhouder' }), 'maken');
  });

  if (zonderInhoud) {
    await stap('Inhoud "geen": niets zien, niets maken', async () => {
      gelijk((await lees('documents', zonderInhoud.geen.token, doc.id, 'id')).length, 0, 'lezen');
      geweigerd(await maak('documents', zonderInhoud.geen.token, { organization_id: w.orgId, created_by: zonderInhoud.geen.id, title: 'Geen' }), 'maken');
    });
    await stap('Inhoud "alleen lezen": lezen ja, wijzigen en verwijderen nee', async () => {
      gelijk((await lees('documents', zonderInhoud.lezen.token, doc.id, 'id')).length, 1, 'lezen');
      geweigerd(await maak('documents', zonderInhoud.lezen.token, { organization_id: w.orgId, created_by: zonderInhoud.lezen.id, title: 'Lezer' }), 'maken');
      nietsVeranderd(await wijzig('documents', zonderInhoud.lezen.token, doc.id, { title: 'Door lezer' }), 'wijzigen');
      nietsVeranderd(await rest(`documents?id=eq.${doc.id}`, { method: 'DELETE', token: zonderInhoud.lezen.token, prefer: 'return=representation' }), 'verwijderen');
    });
    await stap('delen vraagt schrijfrechten op Inhoud', async () => {
      const res = await roep('file-share', { token: zonderInhoud.lezen.token, body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: doc.id, recipients: [{ kind: 'client' }] } });
      geweigerd(res, 'delen als lezer', [403]);
    });
  }

  await stap('een document op naam van een ander aanmaken kan niet', async () => {
    geweigerd(await maak('documents', w.medewerker.token, { organization_id: w.orgId, created_by: w.eigenaar.id, title: 'Namens de eigenaar' }), 'created_by van een ander');
  });

  await stap('de maker achteraf veranderen kan niet', async () => {
    const res = await wijzig('documents', w.medewerker.token, doc.id, { created_by: w.eigenaar.id });
    verwacht(res.status >= 400 || (Array.isArray(res.json) && res.json.length === 0), `maker gewijzigd: ${res.status} ${res.tekst.slice(0, 200)}`);
    gelijk(sqlRij(`select created_by from public.documents where id = ${q(doc.id)}`).created_by, w.medewerker.id, 'maker');
  });

  await stap('een teamlid dat Klanten niet mag zien, slaat zijn klantdocument, -map en -notitie gewoon op', async () => {
    // De integriteitscontroles draaien als eigenaar van de tabel. Met de rechten
    // van de gebruiker zag deze gebruiker de klant niet, en faalde elke opslag.
    const lid = await lidMet(w.orgId, 'doc-geenklanten', { clients: 'none', projects: 'none' });
    const eigenDoc = gelukt(await maak('documents', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, title: 'Klantdoc' }), 'document')[0];
    const map = gelukt(await maak('content_folders', w.medewerker.token, { organization_id: w.orgId, client_id: w.klantA.id, name: 'Klantmap' }), 'map')[0];
    const notitie = gelukt(await maak('notes', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, title: 'Klantnotitie' }), 'notitie')[0];
    gelukt(await wijzig('documents', lid.token, eigenDoc.id, { title: 'Nieuwe titel', client_id: w.klantA.id, project_id: null, folder_id: null }), 'document opslaan zoals het formulier');
    gelukt(await wijzig('content_folders', lid.token, map.id, { name: 'Hernoemd' }), 'klantmap hernoemen');
    gelukt(await wijzig('notes', lid.token, notitie.id, { folder_id: map.id }), 'notitie in de map');
    gelukt(await wijzig('notes', lid.token, notitie.id, { title: 'Bijgewerkt', client_id: w.klantA.id }), 'notitie opslaan zoals het formulier');
  });

  await stap('een negatieve of absurde bestandsgrootte (om het opslagquotum te omzeilen) wordt geweigerd', async () => {
    geweigerd(await wijzig('documents', w.medewerker.token, doc.id, { size_bytes: -2147483648 }), 'negatief document');
    const bijlage = await rest('attachments?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, entity_type: 'document', entity_id: doc.id, name: 'x.pdf', mime_type: 'application/pdf', size_bytes: '5000000000000000000', storage_key: `${w.orgId}/document/${doc.id}/x.pdf` },
    });
    geweigerd(bijlage, 'bijlage van 5·10^18 bytes');
    gelijk(sqlRij(`select size_bytes from public.documents where id = ${q(doc.id)}`).size_bytes, null, 'grootte');
  });

  groep('Documenten: andere organisaties');
  if (ander) {
    await stap('iemand van de buren ziet, wijzigt en verwijdert niets', async () => {
      gelijk((await lees('documents', ander.medewerker.token, doc.id, 'id')).length, 0, 'lezen');
      nietsVeranderd(await wijzig('documents', ander.medewerker.token, doc.id, { title: 'Overgenomen' }), 'wijzigen');
      nietsVeranderd(await rest(`documents?id=eq.${doc.id}`, { method: 'DELETE', token: ander.medewerker.token, prefer: 'return=representation' }), 'verwijderen');
    });

    await stap('een document in de organisatie van de buren aanmaken kan niet', async () => {
      geweigerd(await maak('documents', ander.medewerker.token, { organization_id: w.orgId, created_by: ander.medewerker.id, title: 'Binnengesmokkeld' }), 'andere organisatie');
    });

    const burenMap = await stap('(de buren hebben ook een map)', async () => {
      const res = await maak('content_folders', ander.medewerker.token, { organization_id: ander.orgId, client_id: ander.klantA.id, name: 'Buren' });
      gelukt(res, 'map buren');
      return res.json[0];
    });

    await stap('een eigen document koppelen aan een klant, project of map van de buren kan niet', async () => {
      const eigen = gelukt(await maak('documents', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, title: 'Eigen' }), 'eigen document')[0];
      geweigerd(await maak('documents', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, title: 'Klant buren', client_id: ander.klantA.id }), 'klant van de buren');
      geweigerd(await wijzig('documents', w.medewerker.token, eigen.id, { client_id: ander.klantA.id }), 'klant van de buren (wijzigen)');
      if (burenMap) geweigerd(await wijzig('documents', w.medewerker.token, eigen.id, { folder_id: burenMap.id }), 'map van de buren');
      const burenProject = gelukt(await maak('projects', ander.medewerker.token, { organization_id: ander.orgId, client_id: ander.klantA.id, name: 'Buren-project' }), 'project buren')[0];
      geweigerd(await wijzig('documents', w.medewerker.token, eigen.id, { project_id: burenProject.id }), 'project van de buren');
      const rij = sqlRij(`select client_id, project_id, folder_id from public.documents where id = ${q(eigen.id)}`);
      gelijk([rij.client_id, rij.project_id, rij.folder_id], [null, null, null], 'koppelingen na de pogingen');
    });

    await stap('een map voor een klant van de buren aanmaken kan niet', async () => {
      geweigerd(await maak('content_folders', w.medewerker.token, { organization_id: w.orgId, client_id: ander.klantA.id, name: 'Klant van de buren' }), 'map bij klant buren');
    });

    await stap('een notitie in een map van de buren zetten kan niet', async () => {
      if (!burenMap) throw new Error('geen map van de buren');
      const notitie = gelukt(await maak('notes', w.medewerker.token, { organization_id: w.orgId, title: 'Notitie' }), 'notitie')[0];
      geweigerd(await wijzig('notes', w.medewerker.token, notitie.id, { folder_id: burenMap.id }), 'map van de buren');
    });

    await stap('het document naar de organisatie van de buren verhuizen kan niet', async () => {
      const res = await wijzig('documents', w.medewerker.token, doc.id, { organization_id: ander.orgId });
      verwacht(res.status >= 400 || (Array.isArray(res.json) && res.json.length === 0), `verhuisd: ${res.status}`);
      gelijk(sqlRij(`select organization_id from public.documents where id = ${q(doc.id)}`).organization_id, w.orgId, 'organisatie');
    });

    await stap('een bestandssleutel van de buren aan een document hangen kan niet', async () => {
      const res = await wijzig('documents', w.medewerker.token, doc.id, { storage_key: `${ander.orgId}/document/${randomUUID()}/buit.docx` });
      geweigerd(res, 'sleutel van de buren');
    });
  }

  groep('Documenten: delen met de klant (portaal)');
  const klantDeling = await stap('een klantdocument delen met klant A: komt in het portaal van klant A', async () => {
    const res = await roep('file-share', {
      token: w.medewerker.token,
      body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: doc.id, recipients: [{ kind: 'client' }], canDownload: true },
    });
    const uitkomst = gelukt(res, 'delen').results?.[0];
    verwacht(uitkomst && !uitkomst.error, `delen mislukt: ${JSON.stringify(uitkomst).slice(0, 300)}`);
    gelijk(uitkomst.share.recipient_email, w.klantA.email, 'naar het adres op de klantkaart');
    verwacht(mailsAan(w.klantA.email).length >= 1, 'geen bericht aan de klant');
    const portaal = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'getSharedFiles' } }), 'portaal A');
    const deling = (portaal.shares ?? portaal.items ?? []).find?.((d) => d.id === uitkomst.share.id);
    verwacht(deling, `niet in het portaal van klant A: ${JSON.stringify(portaal).slice(0, 300)}`);
    const lezen = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: deling.id, itemType: 'document', itemId: doc.id } }), 'lezen in portaal');
    verwacht(JSON.stringify(lezen).includes('Werkafspraken v2'), `document niet te lezen: ${JSON.stringify(lezen).slice(0, 200)}`);
    return uitkomst.share;
  });

  if (klantDeling) {
    await stap('klant B ziet de deling van klant A niet, en kan hem niet openen', async () => {
      const portaal = gelukt(await roep('client-portal', { token: w.portaalB.token, body: { action: 'getSharedFiles' } }), 'portaal B');
      verwacht(!JSON.stringify(portaal).includes(klantDeling.id), 'deling van klant A bij klant B');
      geweigerd(await roep('client-portal', { token: w.portaalB.token, body: { action: 'downloadSharedFile', shareId: klantDeling.id, itemType: 'document', itemId: doc.id } }), 'openen door klant B', [403]);
    });
  }

  await stap('een klantdocument via een losse link delen kan niet', async () => {
    const res = await roep('file-share', {
      token: w.medewerker.token,
      body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: doc.id, recipients: [{ kind: 'link', email: 'iemand@elders.test' }] },
    });
    geweigerd(res, 'los adres', [403]);
  });

  groep('Documenten: delen via een geheime link');
  // ── Een gedeelde map vult zich niet meer vanzelf (20261127120000) ─────────
  // Tot dan zag de klant meteen wat een collega later in een gedeelde map zette.
  // Nu alleen wat er bij het delen in stond, plus wat iemand er met "Ook delen"
  // bij zet, of wat er in staat als iemand de map opnieuw deelt.
  const mapDeling = await stap('een klantmap delen met klant A: het portaal toont wat er toen in stond', async () => {
    const map = gelukt(await maak('content_folders', w.medewerker.token, { organization_id: w.orgId, client_id: w.klantA.id, name: 'Oplevering' }), 'map')[0];
    gelukt(await maak('notes', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, folder_id: map.id, title: 'Eerste versie', content: '<p>Opgeleverd.</p>' }), 'notitie');
    const res = await roep('file-share', {
      token: w.medewerker.token,
      body: { action: 'share', organizationId: w.orgId, itemType: 'folder', itemId: map.id, recipients: [{ kind: 'client' }] },
    });
    const uitkomst = gelukt(res, 'map delen').results?.[0];
    verwacht(uitkomst && !uitkomst.error, `delen mislukt: ${JSON.stringify(uitkomst).slice(0, 300)}`);
    gelijk(await portaalTitels(w.portaalA.token, uitkomst.share.id), 'Eerste versie', 'in het portaal');
    return { map, shareId: uitkomst.share.id };
  });

  if (mapDeling) {
    const later = await stap('later in de map gezet: de klant ziet en opent het niet, de drive meldt het', async () => {
      const nieuw = gelukt(await maak('notes', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, folder_id: mapDeling.map.id, title: 'Tweede versie', content: '<p>Concept.</p>' }), 'notitie')[0];
      gelijk(await portaalTitels(w.portaalA.token, mapDeling.shareId), 'Eerste versie', 'in het portaal');
      geweigerd(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: mapDeling.shareId, itemType: 'note', itemId: nieuw.id } }), 'het nieuwe item openen via de deling');
      const gaten = gelukt(await rest('rpc/drive_share_folder_gaps', { method: 'POST', token: w.medewerker.token, body: { p_folder_id: mapDeling.map.id } }), 'wat nog niet gedeeld is');
      gelijk(gaten.map((g) => g.item_id).join(','), nieuw.id, 'de melding in de drive');
      return nieuw;
    });

    if (later) {
      if (zonderInhoud?.lezen) await stap('wie Inhoud alleen mag lezen, vult de deling niet aan', async () => {
        geweigerd(await rest('rpc/drive_share_add_items', { method: 'POST', token: zonderInhoud.lezen.token, body: { p_share_id: mapDeling.shareId, p_items: [{ item_type: 'note', item_id: later.id }] } }), 'aanvullen als lezer');
        gelijk(await portaalTitels(w.portaalA.token, mapDeling.shareId), 'Eerste versie', 'in het portaal');
      });

      await stap('"Ook delen": daarna ziet de klant het wel', async () => {
        gelukt(await rest('rpc/drive_share_add_items', { method: 'POST', token: w.medewerker.token, body: { p_share_id: mapDeling.shareId, p_items: [{ item_type: 'note', item_id: later.id }] } }), 'ook delen');
        gelijk(await portaalTitels(w.portaalA.token, mapDeling.shareId), 'Eerste versie,Tweede versie', 'in het portaal');
      });
    }

    await stap('de map opnieuw delen neemt mee wat er nu in staat, in dezelfde deling', async () => {
      gelukt(await maak('notes', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, folder_id: mapDeling.map.id, title: 'Derde versie', content: '<p>Definitief.</p>' }), 'notitie');
      const res = await roep('file-share', {
        token: w.medewerker.token,
        body: { action: 'share', organizationId: w.orgId, itemType: 'folder', itemId: mapDeling.map.id, recipients: [{ kind: 'client' }] },
      });
      const uitkomst = gelukt(res, 'opnieuw delen').results?.[0];
      verwacht(uitkomst && !uitkomst.error, `opnieuw delen mislukt: ${JSON.stringify(uitkomst).slice(0, 300)}`);
      gelijk(uitkomst.share.id, mapDeling.shareId, 'dezelfde deling, bijgewerkt');
      gelijk(await portaalTitels(w.portaalA.token, mapDeling.shareId), 'Derde versie,Eerste versie,Tweede versie', 'in het portaal');
    });

    const notitieIn = (titel) => ({ organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, folder_id: mapDeling.map.id, title: titel, content: '<p>Tekst.</p>' });
    await stap('"Ook delen" met melding: de klant krijgt een mail met wat er nieuw is', async () => {
      const vierde = gelukt(await maak('notes', w.medewerker.token, notitieIn('Vierde versie')), 'notitie')[0];
      const voor = mailsAan(w.klantA.email).length;
      const items = [{ item_type: 'note', item_id: vierde.id }];
      gelukt(await rest('rpc/drive_share_add_items', { method: 'POST', token: w.medewerker.token, body: { p_share_id: mapDeling.shareId, p_items: items } }), 'ook delen');
      const res = gelukt(await roep('file-share', { token: w.medewerker.token, body: { action: 'notifyAdded', organizationId: w.orgId, shareId: mapDeling.shareId, items } }), 'melding');
      verwacht(res.result?.notified === true, `geen melding: ${JSON.stringify(res).slice(0, 300)}`);
      const mails = mailsAan(w.klantA.email);
      gelijk(mails.length, voor + 1, 'één nieuwe mail');
      const tekst = String(mails.at(-1)?.text ?? '');
      verwacht(tekst.includes('Nieuw in “Oplevering”') && tekst.includes('Vierde versie'), `mail: ${tekst.slice(0, 300)}`);
    });

    await stap('een melding over iets wat niet in de deling staat, gaat niet uit', async () => {
      const los = gelukt(await maak('notes', w.medewerker.token, notitieIn('Nog intern')), 'notitie')[0];
      const voor = mailsAan(w.klantA.email).length;
      const res = gelukt(await roep('file-share', { token: w.medewerker.token, body: { action: 'notifyAdded', organizationId: w.orgId, shareId: mapDeling.shareId, items: [{ item_type: 'note', item_id: los.id }] } }), 'melding');
      gelijk(res.result?.notified, false, 'geen melding');
      gelijk(mailsAan(w.klantA.email).length, voor, 'geen mail');
    });
  }

  const intern = await stap('(een intern document, zonder klant)', async () => {
    const res = await maak('documents', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, title: 'Huisregels', content: '<p>Koffie is gratis.</p>' });
    return gelukt(res, 'intern document')[0];
  });

  const ontvanger = `ontvanger.${randomUUID().slice(0, 8)}@elders.test`;
  const link = intern && await stap('delen met een los adres: de ontvanger krijgt een geheime link, de database bewaart alleen een hash', async () => {
    const res = await roep('file-share', {
      token: w.medewerker.token,
      body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: intern.id, recipients: [{ kind: 'link', email: ontvanger }] },
    });
    const uitkomst = gelukt(res, 'delen').results?.[0];
    verwacht(uitkomst && !uitkomst.error, `delen mislukt: ${JSON.stringify(uitkomst).slice(0, 300)}`);
    const mail = mailsAan(ontvanger).at(-1);
    verwacht(mail, 'geen mail aan de ontvanger');
    const token = `${mail.html} ${mail.text}`.match(/\/gedeeld\/([A-Za-z0-9_-]{20,})/)?.[1];
    verwacht(token, 'geen deellink in de mail');
    const rij = sqlRij(`select token_hash from public.drive_shares where id = ${q(uitkomst.share.id)}`);
    verwacht(rij.token_hash && !rij.token_hash.includes(token), 'de link staat leesbaar in de database');
    return { token, shareId: uitkomst.share.id };
  });

  if (link) {
    await stap('de ontvanger opent de link zonder login en leest het document', async () => {
      const lijst = gelukt(await roep('file-share-public', { body: { action: 'get', token: link.token } }), 'openen');
      const item = (lijst.items ?? []).find((i) => i.itemId === intern.id);
      verwacht(item?.readable, `document niet leesbaar in de deling: ${JSON.stringify(lijst).slice(0, 300)}`);
      const lezen = gelukt(await roep('file-share-public', { body: { action: 'download', token: link.token, itemType: 'document', itemId: intern.id } }), 'lezen');
      gelijk(lezen.text?.title, 'Huisregels', 'titel');
    });

    await stap('een ander document via deze link opvragen kan niet', async () => {
      geweigerd(await roep('file-share-public', { body: { action: 'download', token: link.token, itemType: 'document', itemId: doc.id } }), 'ander document', [403]);
    });

    await stap('een verkeerde of verzonnen link geeft niets prijs', async () => {
      const fout = `${link.token.slice(0, -4)}${link.token.endsWith('abcd') ? 'efgh' : 'abcd'}`;
      const res = await roep('file-share-public', { body: { action: 'get', token: fout } });
      geweigerd(res, 'verkeerde link', [404]);
      verwacht(!res.tekst.includes('Huisregels'), 'titel uitgelekt');
      geweigerd(await roep('file-share-public', { body: { action: 'get', token: 'x' } }), 'rommel');
    });

    await stap('ingetrokken: de link werkt niet meer', async () => {
      const res = await rest(`drive_shares?id=eq.${link.shareId}&select=id`, {
        method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
        body: { revoked_at: new Date().toISOString(), revoked_by: w.medewerker.id, token_hash: null },
      });
      gelukt(res, 'intrekken');
      geweigerd(await roep('file-share-public', { body: { action: 'get', token: link.token } }), 'na intrekken', [404]);
    });

    await stap('verlopen: de link werkt niet meer', async () => {
      const tweede = `tweede.${randomUUID().slice(0, 8)}@elders.test`;
      const uitkomst = gelukt(await roep('file-share', {
        token: w.medewerker.token,
        body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: intern.id, recipients: [{ kind: 'link', email: tweede }] },
      }), 'delen').results?.[0];
      const mail = mailsAan(tweede).at(-1);
      const token = `${mail?.html} ${mail?.text}`.match(/\/gedeeld\/([A-Za-z0-9_-]{20,})/)?.[1];
      verwacht(token, 'geen link');
      gelukt(await roep('file-share-public', { body: { action: 'get', token } }), 'werkt eerst');
      sql(`alter table public.drive_shares disable trigger user;
           update public.drive_shares set expires_at = now() - interval '1 minute' where id = ${q(uitkomst.share.id)};
           alter table public.drive_shares enable trigger user;`);
      geweigerd(await roep('file-share-public', { body: { action: 'get', token } }), 'verlopen', [404]);
    });
  }

  if (ander) {
    await stap('de naam van een klant van de buren lekt nergens uit (ook niet via een foutmelding bij delen)', async () => {
      // De buren kennen (bijv. uit een oude export) het id van klant A van deze organisatie.
      const res = await maak('documents', ander.medewerker.token, { organization_id: ander.orgId, created_by: ander.medewerker.id, title: 'Lokaas', client_id: w.klantA.id });
      const teksten = [res.tekst];
      if (res.status < 300 && res.json?.[0]?.id) {
        const share = await roep('file-share', {
          token: ander.medewerker.token,
          body: { action: 'share', organizationId: ander.orgId, itemType: 'document', itemId: res.json[0].id, recipients: [{ kind: 'link', email: 'buit@buren.test' }] },
        });
        teksten.push(share.tekst);
      }
      const lek = teksten.find((t) => t.includes(w.klantA.name));
      verwacht(!lek, `naam van klant A uitgelekt aan de buren: ${String(lek).slice(0, 300)}`);
      geweigerd(res, 'document bij een klant van een andere organisatie');
    });
  }

  // ── Pagina's: delen is vrijgeven (stap 1C, 20261128120000 en 20261128130000) ──
  // De klant ziet van een pagina de versie die gedeeld is, nooit de pagina
  // zoals ze nu is. Delen gaat zoals in de app: eerst een vrijgave
  // (save_page_version), dan file-share met die versie.
  groep('Pagina\'s: de klant leest de gedeelde versie');
  const paginaBody = (tekst) => ({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Afspraken' }] },
    { type: 'paragraph', content: [{ type: 'text', text: tekst }] },
  ] });
  const vrijgave = async (paginaId) => gelukt(await rest('rpc/save_page_version', {
    method: 'POST', token: w.medewerker.token, body: { p_document_id: paginaId, p_reason: 'vrijgave' },
  }), 'vrijgeven');
  const deelPagina = (paginaId, versieId, recipients) => roep('file-share', {
    token: w.medewerker.token,
    body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: paginaId, recipients, documentVersionId: versieId },
  });
  const status = async (paginaId) => gelukt(await rest('rpc/page_share_status', {
    method: 'POST', token: w.medewerker.token, body: { p_document_id: paginaId },
  }), 'status').map((rij) => (rij.is_current ? 'nu' : 'oud')).join(',');

  const klantpagina = await stap('een pagina bij klant A, vrijgegeven en gedeeld met de klant: het portaal toont die versie', async () => {
    const pagina = gelukt(await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Werkwijze', format: 'page',
      body: paginaBody('Wij bellen elke maandag.'), client_id: w.klantA.id,
    }), 'pagina')[0];
    // Zonder vrijgave weigert file-share, en de database ook (rechtstreeks, zoals de API).
    geweigerd(await deelPagina(pagina.id, null, [{ kind: 'client' }]), 'delen zonder vrijgave', [400]);
    geweigerd(await maak('drive_shares', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, item_type: 'document', item_id: pagina.id, item_name: 'Werkwijze', recipient_kind: 'client',
    }), 'rechtstreeks zonder vrijgave');
    const versie = await vrijgave(pagina.id);
    const voor = mailsAan(w.klantA.email).length;
    const uitkomst = gelukt(await deelPagina(pagina.id, versie.id, [{ kind: 'client' }]), 'delen').results?.[0];
    verwacht(uitkomst?.share && !uitkomst.error, `delen mislukt: ${JSON.stringify(uitkomst).slice(0, 300)}`);
    const deling = uitkomst.share;
    gelijk([deling.document_version_id, deling.can_download], [versie.id, false], 'de vrijgave, en niets om te downloaden');
    const mail = mailsAan(w.klantA.email).at(-1);
    verwacht(mailsAan(w.klantA.email).length === voor + 1 && `${mail?.subject} ${mail?.text}`.includes('Werkwijze'), 'een mail aan de klant, met de titel');
    gelijk(await portaalTitels(w.portaalA.token, deling.id), 'Werkwijze', 'in het portaal');
    const lezen = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: deling.id, itemType: 'document', itemId: pagina.id } }), 'lezen');
    gelijk(lezen.text?.title, 'Werkwijze', 'titel');
    verwacht(lezen.text?.html?.includes('<h2>Afspraken</h2>') && lezen.text.html.includes('Wij bellen elke maandag.'), `de versie als HTML: ${JSON.stringify(lezen).slice(0, 300)}`);
    gelijk(await status(pagina.id), 'nu', 'de klant ziet de pagina van nu');
    return { pagina, deling, versie };
  });

  if (klantpagina) {
    await stap('de pagina wijzigen: de klant ziet nog de gedeelde versie, ook de oude titel', async () => {
      gelukt(await wijzig('documents', w.medewerker.token, klantpagina.pagina.id, { title: 'Concept: nieuwe prijzen', body: paginaBody('Wij bellen niet meer.') }), 'wijzigen');
      gelijk(await portaalTitels(w.portaalA.token, klantpagina.deling.id), 'Werkwijze', 'in het portaal');
      const lezen = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: klantpagina.deling.id, itemType: 'document', itemId: klantpagina.pagina.id } }), 'lezen');
      const json = JSON.stringify(lezen);
      verwacht(json.includes('Wij bellen elke maandag.') && !json.includes('niet meer') && !json.includes('Concept'), `de levende pagina gelekt: ${json.slice(0, 300)}`);
      gelijk(await status(klantpagina.pagina.id), 'oud', 'de app ziet: de klant ziet een oudere versie');
    });

    await stap('bijwerken bij de klant: een nieuwe vrijgave op de deling, en de klant ziet die', async () => {
      if (zonderInhoud?.lezen) {
        geweigerd(await rest('rpc/release_page_to_shares', { method: 'POST', token: zonderInhoud.lezen.token, body: { p_document_id: klantpagina.pagina.id } }), 'bijwerken als lezer');
      }
      const aantal = gelukt(await rest('rpc/release_page_to_shares', { method: 'POST', token: w.medewerker.token, body: { p_document_id: klantpagina.pagina.id } }), 'bijwerken');
      gelijk(aantal, 1, 'één deling bijgewerkt');
      gelijk(await status(klantpagina.pagina.id), 'nu', 'de klant ziet weer de pagina van nu');
      gelijk(await portaalTitels(w.portaalA.token, klantpagina.deling.id), 'Concept: nieuwe prijzen', 'de titel van de nieuwe versie');
      const portaal = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'getSharedFiles' } }), 'portaal');
      gelijk((portaal.shares ?? []).find((d) => d.id === klantpagina.deling.id)?.itemName, 'Concept: nieuwe prijzen', 'ook de naam van de deling');
      const lezen = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: klantpagina.deling.id, itemType: 'document', itemId: klantpagina.pagina.id } }), 'lezen');
      verwacht(JSON.stringify(lezen).includes('Wij bellen niet meer.'), 'de nieuwe versie');
      gelijk(gelukt(await rest('rpc/release_page_to_shares', { method: 'POST', token: w.medewerker.token, body: { p_document_id: klantpagina.pagina.id } }), 'nog een keer'), 0, 'niets meer bij te werken');
    });

    await stap('klant B ziet de pagina niet, en kan haar niet openen', async () => {
      const portaal = gelukt(await roep('client-portal', { token: w.portaalB.token, body: { action: 'getSharedFiles' } }), 'portaal B');
      verwacht(!JSON.stringify(portaal).includes(klantpagina.deling.id), 'deling van klant A bij klant B');
      geweigerd(await roep('client-portal', { token: w.portaalB.token, body: { action: 'downloadSharedFile', shareId: klantpagina.deling.id, itemType: 'document', itemId: klantpagina.pagina.id } }), 'openen door klant B', [403]);
    });

    await stap('een subpagina: alleen zichtbaar als ze ook gedeeld is, met de titel van haar vrijgave', async () => {
      const sub = gelukt(await maak('documents', w.medewerker.token, {
        organization_id: w.orgId, created_by: w.medewerker.id, title: 'Tarieven', format: 'page', parent_id: klantpagina.pagina.id,
        body: paginaBody('Een uur kost 95 euro.'),
      }), 'subpagina')[0];
      gelukt(await wijzig('documents', w.medewerker.token, klantpagina.pagina.id, {
        body: { type: 'doc', content: [...paginaBody('Wij bellen niet meer.').content, { type: 'subpage', attrs: { pageId: sub.id } }] },
      }), 'de subpagina in de pagina');
      gelukt(await rest('rpc/release_page_to_shares', { method: 'POST', token: w.medewerker.token, body: { p_document_id: klantpagina.pagina.id } }), 'bijwerken');
      const lees = async () => JSON.stringify(gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: klantpagina.deling.id, itemType: 'document', itemId: klantpagina.pagina.id } }), 'lezen'));
      verwacht(!(await lees()).includes('Tarieven'), 'de titel van een subpagina die niet gedeeld is');
      gelijk(gelukt(await deelPagina(sub.id, (await vrijgave(sub.id)).id, [{ kind: 'client' }]), 'subpagina delen').results?.[0]?.error ?? null, null, 'subpagina gedeeld');
      verwacht((await lees()).includes('→ Tarieven'), 'de gedeelde subpagina staat in de pagina');
    });

    await stap('in de prullenbak: weg uit het portaal; teruggezet: weer zichtbaar', async () => {
      gelukt(await rest('rpc/trash_page', { method: 'POST', token: w.medewerker.token, body: { p_page_id: klantpagina.pagina.id } }), 'weggooien');
      const portaal = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'getSharedFiles' } }), 'portaal');
      verwacht(!JSON.stringify(portaal).includes(klantpagina.deling.id), 'een pagina in de prullenbak staat nog in het portaal');
      geweigerd(await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: klantpagina.deling.id, itemType: 'document', itemId: klantpagina.pagina.id } }), 'openen uit de prullenbak', [403, 404]);
      gelukt(await rest('rpc/restore_page', { method: 'POST', token: w.medewerker.token, body: { p_page_id: klantpagina.pagina.id } }), 'terugzetten');
      gelijk(await portaalTitels(w.portaalA.token, klantpagina.deling.id), 'Concept: nieuwe prijzen', 'weer in het portaal');
    });
  }

  await stap('een pagina in het eigen dossier via een geheime link: de ontvanger leest de gedeelde versie', async () => {
    const pagina = gelukt(await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Handboek', format: 'page', body: paginaBody('Koffie is gratis.'),
    }), 'pagina')[0];
    const versie = await vrijgave(pagina.id);
    const adres = `handboek.${randomUUID().slice(0, 8)}@elders.test`;
    const uitkomst = gelukt(await deelPagina(pagina.id, versie.id, [{ kind: 'link', email: adres }]), 'delen').results?.[0];
    verwacht(uitkomst?.share && !uitkomst.error, `delen mislukt: ${JSON.stringify(uitkomst).slice(0, 300)}`);
    const mail = mailsAan(adres).at(-1);
    const token = `${mail?.html} ${mail?.text}`.match(/\/gedeeld\/([A-Za-z0-9_-]{20,})/)?.[1];
    verwacht(token, 'geen deellink in de mail');
    gelukt(await wijzig('documents', w.medewerker.token, pagina.id, { title: 'Handboek (concept)', body: paginaBody('Koffie kost een euro.') }), 'wijzigen');
    const lijst = gelukt(await roep('file-share-public', { body: { action: 'get', token } }), 'openen');
    const item = (lijst.items ?? []).find((i) => i.itemId === pagina.id);
    verwacht(item?.readable && item.name === 'Handboek' && !item.downloadable && lijst.share?.itemName === 'Handboek', `de pagina in de deling: ${JSON.stringify(lijst).slice(0, 300)}`);
    const lezen = gelukt(await roep('file-share-public', { body: { action: 'download', token, itemType: 'document', itemId: pagina.id } }), 'lezen');
    gelijk(lezen.text?.title, 'Handboek', 'titel');
    verwacht(lezen.text?.html?.includes('Koffie is gratis.') && !JSON.stringify(lezen).includes('een euro'), `de gedeelde versie: ${JSON.stringify(lezen).slice(0, 300)}`);
  });

  groep('Pagina\'s: de PDF (page-export, stap 1B-5)');
  const pdfPagina = await stap('een pagina met een hoofdstuk, een afbeelding en een subpagina in de prullenbak', async () => {
    const pagina = gelukt(await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Handleiding PDF', format: 'page', client_id: w.klantA.id,
      body: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Begin' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Tekst voor de PDF.' }] }] },
    }), 'pagina')[0];
    const kind = gelukt(await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Hoofdstuk PDF', format: 'page', parent_id: pagina.id,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tekst van het hoofdstuk.' }] }] },
    }), 'subpagina')[0];
    const weg = gelukt(await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Weggegooid hoofdstuk', format: 'page', parent_id: pagina.id,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mag niet in de PDF.' }] }] },
    }), 'tweede subpagina')[0];
    sql(`update public.documents set archived_at = now() where id = ${q(weg.id)}`);
    // Een afbeelding in de pagina, zoals de editor hem opslaat: een bijlage van de pagina zelf.
    const sleutel = `${w.orgId}/document/${pagina.id}/${randomUUID()}-plaatje.png`;
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    post.r2.set(sleutel, new Uint8Array(png));
    sql(`insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key, created_by)
      values (${q(w.orgId)}, 'document', ${q(pagina.id)}, 'plaatje.png', 'image/png', ${png.length}, ${q(sleutel)}, ${q(w.medewerker.id)})`);
    const bijlage = sqlRij(`select id from public.attachments where storage_key = ${q(sleutel)}`);
    gelukt(await wijzig('documents', w.medewerker.token, pagina.id, { body: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Begin' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Tekst voor de PDF.' }] },
      { type: 'image', attrs: { attachmentId: bijlage.id, alt: 'Plaatje' } },
    ] } }), 'afbeelding in de pagina');
    return { pagina, kind, weg, png };
  });

  if (pdfPagina) {
    const exporteer = (token, body) => roep('page-export', { token, body: { pageId: pdfPagina.pagina.id, ...body } });
    await stap('de PDF: met de sessie van wie exporteert; de worker krijgt een .docx met de pagina, het hoofdstuk en de afbeelding, zonder de prullenbak', async () => {
      const voor = post.paginaPdf.verzoeken.length;
      const res = await exporteer(w.medewerker.token, { cover: true, toc: true, chapters: true });
      gelijk(res.status, 200, `status ${res.tekst.slice(0, 200)}`);
      gelijk(res.headers.get('content-type'), 'application/pdf', 'soort');
      gelijk(Buffer.from(res.bytes.slice(0, 5)).toString(), '%PDF-', 'een PDF');
      gelijk(post.paginaPdf.verzoeken.length, voor + 1, 'één keer omgezet');
      const verzoek = post.paginaPdf.verzoeken.at(-1);
      gelijk(verzoek.organizationId, w.orgId, 'de organisatie van de pagina');
      const delen = leesZip(verzoek.bytes);
      const xml = delen.get('word/document.xml')?.toString('utf8') ?? '';
      for (const tekst of ['Handleiding PDF', 'Tekst voor de PDF.', 'Hoofdstuk PDF', 'Tekst van het hoofdstuk.', `Klant: ${w.klantA.name}`]) {
        verwacht(xml.includes(tekst), `"${tekst}" staat niet in de .docx`);
      }
      verwacht(!xml.includes('Weggegooid hoofdstuk') && !xml.includes('Mag niet in de PDF.'), 'een subpagina uit de prullenbak staat in de PDF');
      verwacht(xml.includes('<w:titlePg/>') && xml.includes('TOC \\o'), 'geen voorblad of inhoudsopgave');
      const media = [...delen.keys()].filter((naam) => naam.startsWith('word/media/afbeelding'));
      verwacht(media.length === 1 && delen.get(media[0]).equals(pdfPagina.png), `de afbeelding uit R2: ${media.join(', ')}`);
      // Met LibreOffice in deze omgeving is het een echte PDF: dan staat de tekst erin.
      try {
        const tekst = execFileSync('pdftotext', ['-', '-'], { input: Buffer.from(res.bytes) }).toString('utf8');
        if (tekst.trim()) verwacht(tekst.includes('Tekst voor de PDF.') && tekst.includes('Hoofdstuk PDF'), `de PDF zelf: ${tekst.slice(0, 200)}`);
      } catch { /* geen pdftotext: de nep-PDF is genoeg */ }
    });

    await stap('wie Inhoud alleen mag lezen, krijgt een PDF; zonder Inhoud, van de buren of zonder sessie niets', async () => {
      gelijk((await exporteer(w.kijker.token, {})).status, 200, 'de kijker');
      geweigerd(await exporteer(zonderInhoud?.geen.token, {}), 'Inhoud "geen"', [403, 404]);
      if (ander) geweigerd(await exporteer(ander.medewerker.token, {}), 'de buren', [403, 404]);
      geweigerd(await exporteer(null, {}), 'zonder sessie', [401]);
      // Precies het verzoek van de rooktest na de uitrol (scripts/supabase-smoke-test.sh):
      // origin "null", zonder sessie, met een verzonnen pagina.
      const rooktest = await roep('page-export', { origin: 'null', body: { pageId: '00000000-0000-4000-8000-000000000000' } });
      gelijk(rooktest.status, 403, `het verzoek van de rooktest: ${rooktest.tekst.slice(0, 200)}`);
      verwacht(rooktest.tekst.includes('zonder herkomst'), `de rooktest zoekt "zonder herkomst": ${rooktest.tekst.slice(0, 200)}`);
      geweigerd(await roep('page-export', { token: w.medewerker.token, body: { pageId: 'geen-uuid' } }), 'geen geldige pagina', [400]);
      geweigerd(await roep('page-export', { token: w.medewerker.token, body: { pageId: pdfPagina.weg.id } }), 'een pagina in de prullenbak', [404]);
    });

    await stap('een media-worker die het pad nog niet kent: een eigen code, zodat de app het kan uitleggen', async () => {
      post.paginaPdf.ontbreekt = true;
      try {
        const res = await exporteer(w.medewerker.token, {});
        gelijk([res.status, res.json?.code], [501, 'pdf_niet_beschikbaar'], `antwoord: ${res.tekst.slice(0, 200)}`);
        verwacht(/media-worker/.test(res.json?.error ?? ''), `de melding: ${res.json?.error}`);
      } finally {
        post.paginaPdf.ontbreekt = false;
      }
    });

    await stap('briefpapier: zonder briefpapier, of met een PDF als briefpapier, een duidelijke melding en geen PDF', async () => {
      const zet = (soort) => sql(`update public.company_settings set invoice_template_kind = ${q(soort)},
        invoice_template_data_url = ${soort === 'pdf' ? q('data:application/pdf;base64,JVBERi0xLjQK') : 'null'},
        invoice_template_mime_type = ${soort === 'pdf' ? q('application/pdf') : 'null'} where organization_id = ${q(w.orgId)}`);
      const voor = post.paginaPdf.verzoeken.length;
      try {
        zet('none');
        const zonder = await exporteer(w.medewerker.token, { letterhead: true });
        gelijk(zonder.status, 422, 'zonder briefpapier');
        verwacht(/geen briefpapier ingesteld/.test(zonder.json?.error ?? ''), `de melding: ${zonder.json?.error}`);
        zet('pdf');
        const pdf = await exporteer(w.medewerker.token, { letterhead: true });
        gelijk(pdf.status, 422, 'een PDF als briefpapier');
        verwacht(/briefpapier is een PDF/.test(pdf.json?.error ?? ''), `de melding: ${pdf.json?.error}`);
        gelijk(post.paginaPdf.verzoeken.length, voor, 'niets naar de worker');
      } finally {
        zet('none');
      }
    });
  }

  groep('Documenten: wie deelde en wie introk');
  await stap('wie een deling maakte of introk, ligt vast', async () => {
    const intern2 = gelukt(await maak('documents', w.medewerker.token, { organization_id: w.orgId, created_by: w.medewerker.id, title: 'Audit' }), 'document')[0];
    const adres = `audit.${randomUUID().slice(0, 8)}@elders.test`;
    const deling = gelukt(await roep('file-share', {
      token: w.medewerker.token,
      body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: intern2.id, recipients: [{ kind: 'link', email: adres }] },
    }), 'delen').results[0].share;
    const ander = await rest(`drive_shares?id=eq.${deling.id}&select=id`, { method: 'PATCH', token: w.beheerder.token, prefer: 'return=representation', body: { created_by: w.eigenaar.id } });
    verwacht(ander.status >= 400 || (Array.isArray(ander.json) && ander.json.length === 0), `maker van de deling gewijzigd: ${ander.status}`);
    gelukt(await rest(`drive_shares?id=eq.${deling.id}&select=id`, {
      method: 'PATCH', token: w.beheerder.token, prefer: 'return=representation',
      body: { revoked_at: new Date().toISOString(), revoked_by: w.eigenaar.id, token_hash: null },
    }), 'intrekken met een andere naam');
    const rij = sqlRij(`select created_by, revoked_by from public.drive_shares where id = ${q(deling.id)}`);
    gelijk([rij.created_by, rij.revoked_by], [w.medewerker.id, w.beheerder.id], 'maker en intrekker');
  });

  groep('Documenten: opslag opruimen');
  await stap('een verwijderd Word-document gaat ook uit de opslag (na een dag, via de opruimtaak)', async () => {
    const sleutel = `${w.orgId}/document/${randomUUID()}-Plan.docx`;
    const word = gelukt(await maak('documents', w.medewerker.token, {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Plan', content: '',
      storage_key: sleutel, mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size_bytes: 12345,
    }), 'Word-document')[0];
    gelukt(await rest(`documents?id=eq.${word.id}`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' }), 'verwijderen');
    const rij = sqlRij(`select reason, (purge_after > now() + interval '23 hours') as vangnet from public.storage_purge_queue where storage_key = ${q(sleutel)}`);
    gelijk([rij?.reason, rij?.vangnet], ['document', true], 'in de opruimwachtrij, met een dag vangnet');
  });

  await stap('een klant verwijderen neemt de bestanden in zijn mappen mee', async () => {
    const klant = gelukt(await maak('clients', w.medewerker.token, { organization_id: w.orgId, name: `Weg ${randomUUID().slice(0, 6)}`, email: `weg.${randomUUID().slice(0, 6)}@klant.test` }), 'klant')[0];
    const map = gelukt(await maak('content_folders', w.medewerker.token, { organization_id: w.orgId, client_id: klant.id, name: 'Dossier' }), 'map')[0];
    const sleutel = `${w.orgId}/folder/${map.id}/${randomUUID()}-paspoort.pdf`;
    const bestand = gelukt(await rest('attachments?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, entity_type: 'folder', entity_id: map.id, name: 'paspoort.pdf', mime_type: 'application/pdf', size_bytes: 1000, storage_key: sleutel },
    }), 'bestand in de map')[0];
    gelukt(await rest(`clients?id=eq.${klant.id}`, { method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation' }), 'klant verwijderen');
    gelijk(sqlRij(`select count(*)::int as n from public.attachments where id = ${q(bestand.id)}`).n, 0, 'bestandsrij');
    gelijk(sqlRij(`select reason from public.storage_purge_queue where storage_key = ${q(sleutel)}`)?.reason, 'folder', 'bestand in de opruimwachtrij');
  });

  groep('Documenten: verwijderen');
  await stap('verwijderen: weg voor iedereen, en de deling vervalt', async () => {
    const res = await rest(`documents?id=eq.${doc.id}`, { method: 'DELETE', token: w.medewerker.token, prefer: 'return=representation' });
    gelukt(res, 'verwijderen');
    gelijk(sqlRij(`select count(*)::int as n from public.documents where id = ${q(doc.id)}`).n, 0, 'document');
    const open = sqlRij(`select count(*)::int as n from public.drive_shares where item_id = ${q(doc.id)} and revoked_at is null`);
    gelijk(open.n, 0, 'open delingen van een verwijderd document');
  });
}
