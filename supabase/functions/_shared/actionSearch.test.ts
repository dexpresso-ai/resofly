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
  ['wat hebben klanten deze week gemaild', 'client_email.recent_inbound'],
  ['wat is er besproken in het gesprek van gisteren', 'meeting_recording.recent'],
  ['map maken in het dossier', 'folder.create'],
  ['notitie verplaatsen naar een andere map', 'content.move'],
  ['bestanden veilig naar de klant sturen', 'files.send'],
  ['verstuurde bestanden intrekken', 'files.revoke_transfer'],
  ['zijn de bestanden al gedownload', 'files.list_transfers'],
  ['ticket omzetten naar een project', 'ticket.convert_to_project'],
  ['reactie zichtbaar maken voor de klant', 'ticket_note.set_visibility'],
  ['winst en verlies bekijken', 'ledger.profit_and_loss'],
  ['balans opvragen', 'ledger.balance_sheet'],
  ['openstaande facturen van klanten', 'ledger.open_items'],
  ['rapportage op het startscherm zetten', 'saved_report.set_pinned'],
  ['grootboekkaart van een rekening', 'ledger.account_card'],
  ['offerte intern laten goedkeuren', 'quote.submit_internal_approval'],
  ['aanmaning sturen', 'dunning.send'],
  ['factuur op betaald zetten', 'invoice.set_status'],
  ['factuur naar het grootboek boeken', 'invoice.post_to_ledger'],
  ['betaalherinnering pauzeren voor deze factuur', 'invoice.set_reminders_paused'],
  ['memoriaalboeking maken', 'journal.post_manual'],
  ['boekstuk tegenboeken', 'journal.reverse'],
  ['banktransactie afletteren tegen een inkoopfactuur', 'bank_transaction.book'],
  ['bankmutatie handmatig invoeren', 'bank_transaction.create_manual'],
  ['contante storting invoeren', 'bank_transaction.create_manual'],
  ['banktransactie verdelen over meerdere facturen', 'bank_transaction.book'],
  ['terugbetaling aan de klant koppelen aan de creditnota', 'bank_transaction.book'],
  ['waartegen kan ik deze bankmutatie afletteren', 'bank_transaction.candidates'],
  ['bankregel samenvoegen met mijn handmatige mutatie', 'bank_transaction.merge'],
  ['samenvoegen ongedaan maken', 'bank_transaction.unmerge'],
  ['handmatige mutatie verwijderen', 'bank_transaction.delete_manual'],
  ['btw-periode afsluiten', 'vat_return.close_period'],
  ['boekjaar afsluiten', 'fiscal_year.close'],
  ['nieuwe grootboekrekening', 'ledger_account.create'],
  ['afschrijving boeken', 'asset.post_depreciation'],
  ['dividend uitkeren', 'dividend.declare'],
  ['aandeelhouder toevoegen', 'shareholder.create'],
  ['jaarrekening opmaken', 'annual_accounts.prepare'],
  ['loonjournaalpost boeken', 'payroll.post_journal'],
  ['projectsjabloon toepassen op een project', 'project_template.apply'],
  ['contract aan een project koppelen', 'contract.link_project'],
  ['boekingslink maken', 'booking_link.create'],
  ['notulen mailen naar de genodigden', 'meeting_recording.send_summary'],
  ['eigen agenda aanmaken', 'calendar_source.create_native'],
  ['campagne versturen', 'campaign.send_now'],
  ['galerij publiceren', 'gallery.publish'],
  ['deellink voor de galerij maken', 'gallery.create_share_link'],
  ['contract ter ondertekening versturen', 'contract.send_for_signature'],
  ['teamlid uitnodigen', 'team.invite'],
  ['modulerechten van een teamlid aanpassen', 'team.set_module_access'],
  ['huisstijl aanpassen', 'branding.save'],
  ['kor aanzetten', 'settings.save_bookkeeping'],
  // Inhoud: zoeken in de tekst, lezen, bijwerken en delen (november 2026).
  ['zoek het document over de prijsafspraak', 'content.search'],
  ['in welke notitie stond de afspraak over de levertijd', 'content.search'],
  ['notitie helemaal lezen', 'content.get'],
  ['document bijwerken', 'document.update'],
  ['notulen aanvullen in de notitie', 'note.update'],
  ['bestand hernoemen', 'attachment.rename'],
  ['bestand naar een andere map verplaatsen', 'attachment.move'],
  ['document delen met de klant via het portaal', 'drive.share'],
  ['deling intrekken', 'drive.revoke_share'],
  ['wat heb ik allemaal gedeeld', 'drive.list_shares'],
  // De rest van de knoppen.
  ['telefoongesprek vastleggen', 'client_call.log'],
  ['wie heeft er gebeld', 'client_call.list'],
  ['offerte intrekken', 'quote.withdraw'],
  ['factuur crediteren', 'invoice.credit'],
  ['afzender blokkeren', 'inbox.block_sender'],
  ['collega een bericht sturen in de teamchat', 'teamchat.send_dm'],
  ['planning van het project een week opschuiven', 'project.shift_planning'],
  ['klantmail als gelezen markeren', 'client_email.mark_read'],
  // Verwijderen.
  ['taak verwijderen', 'task.delete'],
  ['conceptfactuur verwijderen', 'invoice.delete_draft'],
  ['conceptofferte weggooien', 'quote.delete_draft'],
  ['notitie verwijderen', 'note.delete'],
  ['map verwijderen', 'folder.delete'],
  ['urenregistratie verwijderen', 'time_entry.delete'],
  ['ticket verwijderen', 'ticket.delete'],
  ['contactpersoon verwijderen', 'client_contact.delete'],
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
