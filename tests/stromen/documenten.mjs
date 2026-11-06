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
import { roep } from './functies.mjs';
import { mailsAan } from './nepdiensten.mjs';
import { maakGebruiker, rest, sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** Een teamlid met eigen modulerechten (zoals Instellingen → Team dat zet). */
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
