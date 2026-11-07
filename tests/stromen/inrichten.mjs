// De inrichting van een nieuwe organisatie (migratie 20261107190000), tegen de
// echte database: PostgREST met RLS, GoTrue voor de gebruikers.
//
// Waarom een eigen scenario: de app toont de inrichtingsstappen zolang
// organizations.onboarding_completed_at leeg is. Dat veld mag dus alleen
// veranderen via complete_organization_onboarding, en alleen door de eigenaar
// of een beheerder van díe organisatie, met een bedrijfsnaam. Hier proberen we
// het ook langs de andere wegen: als teamlid, als boekhouder, als vreemde, als
// anon en rechtstreeks met een update. En: wie is uitgenodigd, krijgt bij de
// eerste login geen eigen organisatie meer (en dus ook geen stappen).
import { maakGebruiker, rest, rpc, sql, sqlRij, uniek } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function lid(orgId, gebruiker, rol) {
  sql(`insert into public.organization_members (organization_id, user_id, email, role, status)
       values (${q(orgId)}, ${q(gebruiker.id)}, ${q(gebruiker.email)}, ${q(rol)}, 'active')
       on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active'`);
}

/** Genoeg licenties voor de testgebruikers, zoals wereld.mjs (de billing-koppeling doet dit in het echt). */
function stoelen(orgId) {
  sql(`begin; set local brandcore.license_sync = 'true';
       update public.organizations set licensed_seats = 50 where id = ${q(orgId)}; commit;`);
}

const organisatie = (orgId) => sqlRij(`select name, onboarding_completed_at, onboarding_completed_by from public.organizations where id = ${q(orgId)}`);

export default async function inrichten() {
  groep('Inrichten: een nieuwe organisatie');

  const eigenaar = await maakGebruiker('inr-eigenaar');
  const orgNaam = uniek('Org Inrichten');
  const org = await stap('create_organization maakt een organisatie die nog moet worden ingericht', async () => {
    const res = gelukt(await rpc('create_organization', { p_name: orgNaam }, eigenaar.token), 'create_organization');
    const rij = Array.isArray(res) ? res[0] : res;
    verwacht(rij?.id, 'geen organisatie terug');
    gelijk(organisatie(rij.id)?.onboarding_completed_at, null, 'onboarding_completed_at');
    return rij;
  });
  if (!org) return;
  const orgId = org.id;
  stoelen(orgId);

  await stap('de eigenaar leest de kolom via de API (de app heeft hem nodig)', async () => {
    const res = gelukt(await rest(`organizations?id=eq.${orgId}&select=id,onboarding_completed_at`, { token: eigenaar.token }), 'lezen');
    gelijk(res, [{ id: orgId, onboarding_completed_at: null }], 'organisatie');
  });

  await stap('afronden zonder bedrijfsnaam wordt geweigerd', async () => {
    const res = geweigerd(await rpc('complete_organization_onboarding', { p_organization_id: orgId }, eigenaar.token), 'zonder bedrijfsnaam');
    verwacht(/bedrijf/i.test(JSON.stringify(res)), `melding noemt de bedrijfsnaam niet: ${JSON.stringify(res)}`);
    gelijk(organisatie(orgId)?.onboarding_completed_at, null, 'nog niet afgerond');
  });

  await stap('rechtstreeks bijwerken van onboarding_completed_at kan niet, ook niet als eigenaar', async () => {
    const res = await rest(`organizations?id=eq.${orgId}`, {
      method: 'PATCH', token: eigenaar.token, prefer: 'return=representation',
      body: { onboarding_completed_at: new Date().toISOString() },
    });
    nietsVeranderd(res, 'direct bijwerken');
    gelijk(organisatie(orgId)?.onboarding_completed_at, null, 'nog niet afgerond');
  });

  await stap('de bedrijfsgegevens opslaan, zoals de stap Bedrijfsgegevens', async () => {
    gelukt(await rest('company_settings?select=id', {
      method: 'POST', token: eigenaar.token, prefer: 'return=representation',
      body: { organization_id: orgId, created_by: eigenaar.id, company_name: 'Inrichten Studio B.V.', legal_form: 'eenmanszaak' },
    }), 'bedrijfsgegevens');
  });

  await stap('een BV zonder zakelijke module wordt geweigerd', async () => {
    const res = await rest(`company_settings?organization_id=eq.${orgId}&select=legal_form`, {
      method: 'PATCH', token: eigenaar.token, prefer: 'return=representation', body: { legal_form: 'bv' },
    });
    geweigerd(res, 'BV zonder module');
    gelijk(sqlRij(`select legal_form from public.company_settings where organization_id = ${q(orgId)}`)?.legal_form, 'eenmanszaak', 'rechtsvorm');
  });

  groep('Inrichten: wie mag afronden');
  const medewerker = await maakGebruiker('inr-lid');
  const kijker = await maakGebruiker('inr-kijker');
  const boekhouder = await maakGebruiker('inr-boekhouder');
  const vreemde = await maakGebruiker('inr-vreemde');
  lid(orgId, medewerker, 'member');
  lid(orgId, kijker, 'viewer');
  lid(orgId, boekhouder, 'accountant');

  for (const [naam, gebruiker] of [['een teamlid', medewerker], ['een kijker', kijker], ['de boekhouder', boekhouder], ['iemand van buiten', vreemde]]) {
    await stap(`${naam} kan niet afronden`, async () => {
      geweigerd(await rpc('complete_organization_onboarding', { p_organization_id: orgId, p_display_name: 'Overgenomen' }, gebruiker.token), naam);
      gelijk(organisatie(orgId)?.onboarding_completed_at, null, 'nog niet afgerond');
    });
  }

  await stap('anon kan de functie niet eens aanroepen', async () => {
    geweigerd(await rpc('complete_organization_onboarding', { p_organization_id: orgId }), 'anon');
    gelijk(organisatie(orgId)?.onboarding_completed_at, null, 'nog niet afgerond');
  });

  await stap('een teamlid ziet dat de organisatie nog wordt ingericht', async () => {
    const res = gelukt(await rest(`organizations?id=eq.${orgId}&select=onboarding_completed_at`, { token: medewerker.token }), 'lezen');
    gelijk(res, [{ onboarding_completed_at: null }], 'organisatie');
  });

  await stap('iemand van buiten ziet de organisatie niet', async () => {
    const res = gelukt(await rest(`organizations?id=eq.${orgId}&select=id`, { token: vreemde.token }), 'lezen');
    gelijk(res, [], 'organisaties');
  });

  groep('Inrichten: afronden');
  await stap('de eigenaar rondt af; de organisatie krijgt de naam van het bedrijf', async () => {
    const res = gelukt(await rpc('complete_organization_onboarding', { p_organization_id: orgId, p_display_name: '  Inrichten\nStudio  ' }, eigenaar.token), 'afronden');
    const rij = Array.isArray(res) ? res[0] : res;
    verwacht(rij?.onboarding_completed_at, 'geen onboarding_completed_at terug');
    const nu = organisatie(orgId);
    verwacht(nu?.onboarding_completed_at, 'niet afgerond in de database');
    gelijk(nu?.onboarding_completed_by, eigenaar.id, 'afgerond door');
    gelijk(nu?.name, 'Inrichten Studio', 'naam (op één regel)');
  });

  await stap('nog eens afronden verandert niets', async () => {
    const voor = organisatie(orgId);
    gelukt(await rpc('complete_organization_onboarding', { p_organization_id: orgId, p_display_name: 'Andere naam' }, eigenaar.token), 'nog eens');
    gelijk(organisatie(orgId), voor, 'organisatie');
  });

  await stap('een beheerder van een andere, nieuwe organisatie mag die afronden', async () => {
    const tweede = gelukt(await rpc('create_organization', { p_name: uniek('Org Inrichten 2') }, eigenaar.token), 'tweede organisatie');
    const id = (Array.isArray(tweede) ? tweede[0] : tweede).id;
    stoelen(id);
    const beheerder = await maakGebruiker('inr-beheerder');
    lid(id, beheerder, 'admin');
    gelukt(await rest('company_settings?select=id', {
      method: 'POST', token: beheerder.token, prefer: 'return=representation',
      body: { organization_id: id, created_by: beheerder.id, company_name: 'Tweede B.V.' },
    }), 'bedrijfsgegevens als beheerder');
    // De beheerder van de tweede organisatie kan de eerste niet raken.
    geweigerd(await rpc('complete_organization_onboarding', { p_organization_id: orgId }, beheerder.token), 'andere organisatie');
    gelukt(await rpc('complete_organization_onboarding', { p_organization_id: id }, beheerder.token), 'afronden als beheerder');
    verwacht(organisatie(id)?.onboarding_completed_at, 'niet afgerond');
    gelijk(organisatie(id)?.name, 'Tweede B.V.', 'naam uit de bedrijfsgegevens');
  });

  groep('Inrichten: wie is uitgenodigd, krijgt geen eigen organisatie');
  const genodigde = await maakGebruiker('inr-genodigde');
  await stap('de eigenaar nodigt uit', async () => {
    gelukt(await rpc('invite_organization_member', { p_organization_id: orgId, p_email: genodigde.email, p_role: 'member', p_module_access: {} }, eigenaar.token), 'uitnodigen');
  });
  await stap('bij de eerste login ontstaat er geen eigen organisatie', async () => {
    gelukt(await rpc('ensure_user_default_organization', {}, genodigde.token), 'eerste login');
    gelijk(Number(sql(`select count(*) from public.organization_members where user_id = ${q(genodigde.id)}`)), 0, 'lidmaatschappen');
  });
  await stap('zonder uitnodiging wel, zoals altijd', async () => {
    const nieuw = await maakGebruiker('inr-nieuw');
    gelukt(await rpc('ensure_user_default_organization', {}, nieuw.token), 'eerste login');
    const rij = sqlRij(`select o.onboarding_completed_at, m.role from public.organization_members m join public.organizations o on o.id = m.organization_id where m.user_id = ${q(nieuw.id)}`);
    gelijk(rij?.role, 'owner', 'rol');
    gelijk(rij?.onboarding_completed_at, null, 'de nieuwe organisatie moet nog worden ingericht');
  });
}
