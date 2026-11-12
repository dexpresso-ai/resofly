# Gerrie ordent mail: mailmappen maken en gesprekken verplaatsen (2026-11-12)

## Aanleiding

"Bouw de functionaliteit dat Gerrie ook mappen kan maken en mail kan
verplaatsen."

Gisteren kwamen de mappen per klant op Berichten
(`CHANGELOG_BERICHTEN_MAPPEN_2026-11-11.md`). Toen al stond er bij "bewust nog
niet": Gerrie kan nog geen mappen maken of mail verplaatsen. Dat kan nu.

## Wat er nu kan

Vraag het Gerrie in gewone woorden, bijvoorbeeld:

- "Welke mailmappen heeft De Korenaar, en wat staat nog los?"
- "Maak bij De Korenaar een map Facturen en zet daar alle factuurmails in."
- "Zet de mail over de offerte in de map Offertes."
- "Hernoem de map Feedback naar Feedback klant" of "verwijder de map Oud".

Gerrie kijkt eerst hoe het er nu bij staat en zet dan een **voorstel** klaar.
Er gebeurt niets voordat jij op **Akkoord** (of **Uitvoeren**) klikt. Daarna
loopt het langs dezelfde weg als de knoppen op Berichten, met jouw rechten.
Staat Berichten of het klantdossier open, dan zie je de mail meteen op zijn
nieuwe plek, zonder te verversen.

**In één kaart een map maken én de mail erin zetten.** Een nieuwe map bestaat
pas nadat jij akkoord gaf; twee losse kaarten zouden dus op elkaar moeten
wachten. Daarom kan Gerrie met één voorstel de map maken en de gesprekken
erin zetten. Bestaat de map op die plek al, dan gaan ze daarin, en komt er geen
tweede "Facturen" naast de eerste.

Hetzelfde kan voor agents (ook bij "als er een klantmail binnenkomt") en voor
een gekoppelde AI. Die zetten het in de goedkeurwachtrij, onder **Jouw
akkoord**.

## De handelingen

| Handeling | Wat |
| --- | --- |
| `mail_folder.list` | lezen: de mailmappen van een klant, met pad, laag en hoeveel gesprekken erin staan, plus wat in geen map staat |
| `mail_thread.list` | lezen: de mailgesprekken van een klant met hun map; te filteren op map, "zonder map" of een woord in het onderwerp |
| `mail_folder.create` | voorstel: een mailmap maken, bovenaan of in een andere map |
| `mail_folder.rename` | voorstel: een andere naam |
| `mail_folder.move` | voorstel: een map met alles erin verplaatsen |
| `mail_folder.delete` | voorstel: een map verwijderen; de inhoud schuift één laag omhoog (knop **Definitief uitvoeren**, altijd langs een mens) |
| `mail_thread.move` | voorstel: gesprekken naar een map, naar een nieuwe map, of terug naar "Zonder map" |

Alles valt onder de module **Klanten**: wie Klanten niet mag lezen, krijgt
deze handelingen niet te zien, en schrijven kan alleen wie er mag schrijven.

## Wat Gerrie vooraf controleert

Dezelfde regels als de database, zodat er geen kaart klaarstaat die bij het
akkoord alsnog strandt; Gerrie hoort de reden en zet het zelf recht:

- een naam die er op die plek al staat (ook met andere hoofdletters): gebruik
  die map, met zijn id erbij;
- niet dieper dan vijf lagen, ook niet als je een map mét submappen verplaatst;
- een map niet in zichzelf of in een eigen submap;
- alles binnen één klant: gesprekken van twee klanten in één voorstel, of een
  map van een andere klant, wordt geweigerd;
- gesprekken die al in de doelmap staan, gaan niet nog eens mee.

Op de kaart staat bij welke klant, naar welke map, en welke gesprekken
(onderwerpen) het gaat. Bij verwijderen staat erbij waar de inhoud heen gaat
en dat er geen mail verloren gaat.

Twee keuzes:

- De kaarten heten **werk**, niet **mail**. Bij "mail" wordt de knop op de
  beslislijst "Akkoord, versturen", en hier gaat niets de deur uit.
- "Map" betekent in de app al iets anders: de mappen voor notities en
  documenten (`folder.*`). De omschrijvingen van beide soorten wijzen naar
  elkaar, en Gerrie's instructies noemen het verschil. Anders zette Gerrie een
  mailmap klaar in de verkenner van Inhoud.

## Waar het zit

- `supabase/functions/_shared/actions/mailFolders.ts`: de handelingen (wat er
  kan, en de controle).
- `src/lib/actions/mailFolders.ts`: de uitvoerders in de browser, via de
  bestaande rpc's uit `repository.ts`.
- `src/lib/mailFolderEvents.ts`: het signaal "de mailmappen zijn gewijzigd",
  waar Berichten en het klantdossier naar luisteren. Na een goedgekeurd
  voorstel ververst de app wel AppData, maar die twee schermen laden hun mail
  zelf; zonder dit signaal stond de mail tot je de pagina opnieuw opende op
  zijn oude plek.
- `gerrieCore.ts`: één zin erbij in de regel over MAIL.

Geen migratie: de rpc's van gisteren doen het werk.

## Getest

- `supabase/functions/_shared/mailFolderActions.test.ts` (nieuw, 18 tests):
  met een nep-database die echt filtert, alle regels hierboven, wat er op de
  kaart staat, en dat **elke** query van deze handelingen filtert op de
  organisatie uit de sessie.
- `actionSearch.test.ts`: zeven nieuwe vragen in gewone woorden ("mail sorteren
  in mappen", "welke mail staat nog zonder map", …) vinden hun handeling, en
  "map maken in het dossier" vindt nog steeds `folder.create`.
- `src/lib/mailFolderEvents.test.ts` (nieuw): het signaal bereikt elk scherm.
- De bestaande bewakers: elke schrijfhandeling heeft een uitvoerder, elke query
  en rpc is org-scoped, elke kolom bestaat.
- Een doorloop in de browser tegen de nagebootste backend. Het voorstel is
  gemaakt met de echte `plan()` en stond als voorstel van een agent onder
  **Jouw akkoord** ("Gesprek verplaatsen: Factuur oktober — naar nieuwe map
  "Facturen""). Na **Akkoord** stond de map er en de mail erin. Een tweede
  voorstel, uitgevoerd terwijl Berichten openstond, liet de nieuwe map
  "Archief" meteen verschijnen, zonder herladen. Geen JavaScript-fouten.
- `deno check` op de registry (alle domeinbestanden). De volledige lijst uit
  de CI kon hier niet: deno.land en esm.sh zijn vanuit deze omgeving niet
  bereikbaar. De CI draait hem wel.
- `npm run typecheck`, `npm test` (1650 groen) en
  `npm run test:mobile -- --theme=both` op Berichten, het klantdossier, het
  dashboard en Gerrie (0 problemen).

## Bewust niet

- **Rechtstreeks uitvoeren** door een gekoppelde AI met uitvoerrecht kan voor
  deze handelingen (nog) niet; die valt terug op de goedkeurwachtrij. Daarvoor
  moeten de rpc's in `action_member_call` (een migratie), en dat is een eigen
  afweging: mail die zonder mens verhuist.
- Gerrie zoekt gesprekken op onderwerp, niet in de tekst van elke mail. Voor
  "alle mail over de verbouwing" leest hij `mail_thread.list`, met het begin
  van het laatste bericht per gesprek.
