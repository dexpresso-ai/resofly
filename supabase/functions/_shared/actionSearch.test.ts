import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchActions } from './actions/registry.ts';

/**
 * Bewaakt of `find_actions` een handeling ook echt VINDT.
 *
 * De registry is de enige weg naar de lange staart van wat de app kan. Staat er een
 * handeling in die je met de woorden van een gebruiker niet terugvindt, dan bestaat
 * hij voor Gerrie niet — en het enige wat de gebruiker merkt is dat hij "dat kan ik
 * niet" te horen krijgt. Dat is een stille fout, en die groeit mee met elk domein
 * dat erbij komt.
 *
 * De vragen hieronder zijn geformuleerd zoals iemand ze stelt, niet zoals de code
 * heet. Faalt er een, voeg dan een trefwoord toe aan die handeling; verlaag de lat
 * hier niet.
 */

/** Vraag → de handeling die daarbij hoort. */
const CASES: Array<[string, string]> = [
  ['btw-nummer van de klant invullen', 'client.update_details'],
  ['adres wijzigen', 'client.update_details'],
  ['klant toegang geven tot het portaal', 'client_contact.set_portal_access'],
  ['welkomstmail sturen', 'client.send_portal_welcome'],
  ['nieuw eigen veld op de klantkaart', 'client_field.create'],
  ['veld archiveren', 'client_field.archive'],
  ['post die nergens bij hoort', 'inbox.list'],
  ['bericht aan een klant koppelen', 'inbox.link'],
  ['map maken in het dossier', 'folder.create'],
  ['notitie verplaatsen naar een andere map', 'content.move'],
  ['ticket omzetten naar een project', 'ticket.convert_to_project'],
  ['reactie zichtbaar maken voor de klant', 'ticket_note.set_visibility'],
  ['winst en verlies bekijken', 'ledger.profit_and_loss'],
  ['balans opvragen', 'ledger.balance_sheet'],
  ['openstaande facturen van klanten', 'ledger.open_items'],
  ['rapportage op het startscherm zetten', 'saved_report.set_pinned'],
  ['grootboekkaart van een rekening', 'ledger.account_card'],
];

test('elke vraag vindt zijn handeling binnen de eerste zes treffers', () => {
  const missed: string[] = [];
  for (const [query, expected] of CASES) {
    const found = searchActions(query, { limit: 6 }).map((a) => a.id);
    if (!found.includes(expected)) missed.push(`"${query}" → verwacht ${expected}, kreeg ${found.slice(0, 3).join(', ') || '(niets)'}`);
  }
  assert.deepEqual(missed, [], `deze vragen vinden hun handeling niet:\n  ${missed.join('\n  ')}`);
});

test('zoeken zonder treffer levert een lege lijst, geen willekeurige handelingen', () => {
  assert.deepEqual(searchActions('zzzqqq onbekendwoord', { limit: 6 }), []);
});

test('de modulefilter houdt handelingen weg waar dit teamlid niet bij mag', () => {
  const zonderKlanten = searchActions('adres wijzigen', { modules: (module) => module !== 'clients' });
  assert.deepEqual(zonderKlanten.filter((a) => a.module === 'clients'), []);
});

test('de allowlist van een agent beperkt wat hij kan vinden', () => {
  const alleen = new Set(['client.update_details']);
  const found = searchActions('klant', { allowedIds: alleen, limit: 10 }).map((a) => a.id);
  assert.deepEqual(found, ['client.update_details']);
});
