// Een complete organisatie zoals in het echt: alle rollen, bedrijfsgegevens,
// twee klanten met elk een portaalgebruiker. Elke scenario maakt zijn eigen
// wereld, zodat ze elkaar niet raken (ook niet als ze tegelijk draaien).
import { maakGebruiker, rest, rpc, sql, uniek } from './supabase.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

async function lid(orgId, gebruiker, rol, modules) {
  sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
       values (${q(orgId)}, ${q(gebruiker.id)}, ${q(gebruiker.email)}, ${q(rol)}, 'active', ${modules ? `${q(JSON.stringify(modules))}::jsonb` : 'null'})
       on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active', module_access = excluded.module_access`);
  return gebruiker;
}

export async function maakWereld(naam, { kor = false } = {}) {
  const eigenaar = await maakGebruiker(`${naam}-eigenaar`);
  const orgNaam = uniek(`Org ${naam}`);
  const org = await rpc('create_organization', { p_name: orgNaam }, eigenaar.token);
  if (org.status !== 200) throw new Error(`create_organization: ${org.status} ${org.tekst}`);
  const orgId = (Array.isArray(org.json) ? org.json[0] : org.json).id;

  // Genoeg licenties voor alle rollen. In het echt zet de billing-koppeling
  // dit (met brandcore.license_sync aan); hier dezelfde weg.
  sql(`begin; set local brandcore.license_sync = 'true';
       update public.organizations set licensed_seats = 50 where id = ${q(orgId)}; commit;`);
  // Bedrijfsgegevens zoals Instellingen → Bedrijf ze opslaat (upsert op
  // organization_id). create_organization maakt deze rij niet aan: een update
  // alleen raakte niets, en dan stonden er geen naam, IBAN of KvK op de stukken.
  const bedrijf = await rest('company_settings?on_conflict=organization_id', {
    method: 'POST', token: eigenaar.token, prefer: 'resolution=merge-duplicates,return=representation',
    body: {
      organization_id: orgId, created_by: eigenaar.id,
      company_name: `${naam} Studio B.V.`, address_line1: 'Keizersgracht 1', postal_code: '1015 AA',
      city: 'Amsterdam', country: 'Nederland', email: `info@${naam}.studio.test`, phone: '020 123 4567',
      kvk_number: '12345678', vat_number: 'NL001234567B01', iban: 'NL91ABNA0417164300',
      invoice_payment_terms: 'Betaling binnen 14 dagen.', kor_enabled: kor,
    },
  });
  if (bedrijf.status !== 201 && bedrijf.status !== 200) throw new Error(`bedrijfsgegevens: ${bedrijf.status} ${bedrijf.tekst}`);
  // Een nieuwe organisatie opent eerst de inrichtingsstappen (migratie
  // 20261107190000). De bedrijfsgegevens staan er nu; de eigenaar rondt af,
  // net als met de knop "Naar mijn werkruimte". Anders bleef de UI-test in de
  // stappen staan.
  const ingericht = await rpc('complete_organization_onboarding', { p_organization_id: orgId, p_display_name: orgNaam }, eigenaar.token);
  if (ingericht.status !== 200) throw new Error(`complete_organization_onboarding: ${ingericht.status} ${ingericht.tekst}`);

  const beheerder = await lid(orgId, await maakGebruiker(`${naam}-beheerder`), 'admin');
  const medewerker = await lid(orgId, await maakGebruiker(`${naam}-lid`), 'member');
  const lezer = await lid(orgId, await maakGebruiker(`${naam}-lezer`), 'member', { finance: 'read' });
  const zonderFinancien = await lid(orgId, await maakGebruiker(`${naam}-geenfin`), 'member', { finance: 'none' });
  const kijker = await lid(orgId, await maakGebruiker(`${naam}-kijker`), 'viewer');
  const boekhouder = await lid(orgId, await maakGebruiker(`${naam}-boekhouder`), 'accountant');

  const klantAEmail = `klant-a.${uniek(naam)}@klant.test`.toLowerCase();
  const klantBEmail = `klant-b.${uniek(naam)}@klant.test`.toLowerCase();
  const nieuweKlant = async (naamKlant, email) => {
    const res = await rest('clients?select=id,name,email', {
      method: 'POST', token: medewerker.token, prefer: 'return=representation',
      body: {
        organization_id: orgId, name: naamKlant, email, contact_name: `Contact ${naamKlant}`,
        address_line1: 'Dorpsstraat 2', postal_code: '1234 AB', city: 'Utrecht', country: 'Nederland',
        client_kind: 'business', vat_number: 'NL009876543B01',
      },
    });
    if (res.status !== 201) throw new Error(`klant ${naamKlant}: ${res.status} ${res.tekst}`);
    return res.json[0];
  };
  const klantA = await nieuweKlant(`Klant A ${naam}`, klantAEmail);
  const klantB = await nieuweKlant(`Klant B ${naam}`, klantBEmail);
  // De portaalgebruikers loggen in met het adres van hun klant.
  const portaalA = await maakGebruiker('portaal-a', klantAEmail);
  const portaalB = await maakGebruiker('portaal-b', klantBEmail);

  return { naam, orgId, orgNaam, eigenaar, beheerder, medewerker, lezer, zonderFinancien, kijker, boekhouder, klantA, klantB, portaalA, portaalB };
}

/** Standaardregels: twee tarieven, met de bekende afrondingsval (€ 173,63). */
export const REGELS = [
  { description: 'Ontwerp', quantity: 1, unit_price: 102.5, vat: 21 },
  { description: 'Drukwerk', quantity: 1, unit_price: 45.5, vat: 9 },
];
export const TOTAAL_REGELS = 173.63;
