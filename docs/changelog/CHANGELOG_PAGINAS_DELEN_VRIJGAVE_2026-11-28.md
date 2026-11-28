# Pagina's delen: de klant leest de vrijgegeven versie (stap 1C-2)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7 en §18.

Delen is vrijgeven: een klant ziet van een pagina de versie die gedeeld is, nooit de pagina
zoals ze nu is. Deze stap legt dat vast in de database, en laat het portaal en de geheime
link die versie tonen.

In de app kun je een pagina nog niet delen: het deelvenster komt in stap 1C-3. Tot dan
staat "Delen…" niet in het menu van een pagina.

## Wat er nu is

- **Een deling van een pagina draagt de versie die de klant ziet**
  (`drive_shares.document_version_id`, migratie `20261128120000_paginas_delen.sql`). De
  database weigert:
  - een pagina zonder versie;
  - een tussenversie (een bewerksessie, iets voor Gerrie): alleen wat iemand bewust
    vrijgaf, de reden `vrijgave`;
  - de versie van een andere pagina of een andere organisatie;
  - een versie bij iets anders dan een pagina;
  - een pagina in de prullenbak.

  Dit vervangt de oude weigering van elke deling van een pagina (`drive_shares_no_pages_yet`).
- **Wat de klant in een deling ziet** (`drive_share_items`): bij een pagina de titel en de
  datum van de gedeelde versie, geen bestand om te downloaden. Ligt de pagina in de
  prullenbak, dan ziet de klant niets; na terugzetten weer wel.
- **Het portaal en de geheime link lezen de gedeelde versie**, via
  `supabase/functions/_shared/sharedPage.ts`.
  - De versie wordt als HTML getoond, met `renderPageHtml` (stap 1C-1).
  - Ontbreekt de versie, of hoort ze niet bij deze pagina of organisatie, dan toont het
    niets. Het valt nooit terug op de tekst van nu.
  - Een subpagina verschijnt in het portaal alleen als die ook met deze lezer gedeeld is,
    met de titel van haar eigen gedeelde versie. Bij een geheime link nooit: die is één
    deling.
  - Een bestand in de pagina toont alleen zijn naam.
- **Een losse deling zonder item verdwijnt uit het portaal.** Dat gebeurt bij een pagina in
  de prullenbak. Eerst bleef de deling dan staan met de naam van toen, zonder inhoud. Een
  geheime link geeft dan hetzelfde antwoord als een link die niet meer loopt.
- **Bijwerken bij de klant komt in het logboek, met de oude en de nieuwe versie.** Zo is na
  te gaan welke versie de klant vanaf welke dag zag. De trigger van het logboek kende die
  kolom eerst niet, en schreef dan geen regel.
- **De export ("Alles exporteren")** neemt de nieuwe kolom mee met de delingen.

## Waarom in één stap

Het portaal en de geheime link toonden bij een document zonder bestand de tekst die er nu
staat (`content`). Was de database pagina's eerder gaan aannemen dan die twee de versie
lazen, dan had een klant de pagina gezien zoals ze op dat moment was, met elke wijziging
erbij. Daarom komen de kolom, de controle en de leeswegen samen.

Al nagelopen: een pagina kon vóór deze stap nergens bij een klant komen. Een gedeelde map en
een zending slaan pagina's over (`drive_folder_tree_items`, `drive_folder_leaves`), en een
losse zending weigert ze (`file-transfer`).

## Keuzes

- **Gaat de pagina definitief weg, dan ook haar deling** (`on delete cascade` op de versie).
  Met "set null" zou de controle de verwijdering weigeren, en bleef de prullenbak hangen.
- **Een klantpagina gaat niet via een losse link.** Dat weigerde de database al voor elk
  klantbestand, en dat blijft zo.

## Getest

- **`tests/database/paginas_delen.sql` (21 controles):**
  - wat de database weigert;
  - delen met een link (eigen dossier) en met een contactpersoon (klantdossier);
  - na een nieuwe titel en tekst blijft de klant de versie van toen zien;
  - bijwerken naar een nieuwe vrijgave, en de regel in het logboek;
  - de prullenbak en terugzetten;
  - definitief verwijderen ruimt de deling op, zonder vast te lopen.
- **`tests/database/paginas_datamodel.sql`:** de weigering zonder versie, met de nieuwe
  melding.
- **De hele databasetest, op een database vanaf nul**, en de migratie twee keer gedraaid:
  alles geslaagd.
- **`_shared/sharedPage.test.ts` (7 tests):**
  - de versie, nooit de pagina van nu;
  - bestandsnamen alleen uit dezelfde organisatie;
  - subpagina's alleen als de aanroeper ze noemt;
  - bij twijfel niets (9 gevallen);
  - een fout van de database gaat door;
  - een ongeldig id vraagt niets op.
- **`npm run test:stromen -- documenten`: 54 stappen, 0 fout.** Zes nieuwe stappen gaan door
  het echte portaal en de echte geheime link (de edge functions):
  - vrijgeven en delen;
  - wijzigen zonder dat de klant het ziet;
  - bijwerken;
  - klant B ziet niets;
  - de prullenbak;
  - een geheime link bij het eigen dossier.
- **`npm test`:** 2406 gelukt. **`npm run typecheck`.**
- **Typecheck van `client-portal` en `file-share-public`** met tsc, tegen de typen van
  supabase-js. `deno check` kon hier niet: de cloudsessie bereikt deno.land en esm.sh niet.
  De CI controleert `file-share-public` met Deno; `client-portal` staat daar nog buiten.
