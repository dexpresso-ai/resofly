# Pagina's: de prullenbak (2026-11-28)

Tweede deel van stap 1A-5 van het bouwplan (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §4
en §18).

## Wat er nu kan of klopt

- **Een pagina weggooien gaat naar de prullenbak, met haar subpagina's.**
  - Wat misging: verwijderen was definitief. De subpagina's gingen mee, maar hun bijlagen
    bleven in de opslag en telden mee in het quotum.
  - Ook als je meerdere dingen tegelijk verwijdert, gaan de pagina's ertussen naar de
    prullenbak.
- **Een pagina in de prullenbak is nergens te zien**, ook niet voor de eigenaar: niet in de
  drive, bij zoeken, via een link, of voor Gerrie, de MCP of de API. Ze is ook niet te
  wijzigen.
- **De knop Prullenbak in de drive** toont per keer weggooien één regel: de pagina, met
  hoeveel subpagina's er meegingen, wanneer, en hoeveel dagen ze nog blijft.
  - Wie Inhoud mag lezen, ziet de prullenbak.
  - Wie mag schrijven, kan terugzetten of definitief verwijderen.
  - In een klantdossier zie je alleen de pagina's van die klant.
- **Terugzetten** zet de pagina terug met de subpagina's die er tegelijk in gingen. Ligt haar
  ouder nog in de prullenbak, dan komt ze los in het dossier, in plaats van onder iets dat
  niemand ziet.
- **Na 30 dagen is alles definitief weg**, of eerder met "Definitief verwijderen". De
  bijlagen van die pagina's gaan naar de opruimwachtrij, die ze uit de opslag haalt.
  - Bestanden uit het dossier waar een bestandsblok naar wees, horen bij hun map en blijven
    staan.

## Hoe het werkt

- Migratie `20261128100000_paginas_prullenbak.sql`:
  - de restrictive policy "documents niet uit de prullenbak": wat in de prullenbak ligt,
    lees of wijzig je niet, en `archived_at` zet je niet zelf;
  - `trash_page`, `restore_page`, `list_page_trash` en `delete_page_forever`, met de rechten
    op Inhoud;
  - `page_trash_purge_tree` zet de bijlagen in `storage_purge_queue` (reden `document`);
  - `purge_page_trash` draait dagelijks om 03:43 UTC via pg_cron.
  - `trash_page` gebruikt `clock_timestamp()`. Wat misging met `now()`: binnen één transactie
    is dat steeds hetzelfde moment, en dan liepen twee keer weggooien samen in de prullenbak
    (gevonden door de databasetest).
- `supabase/functions/_shared/actions/types.ts` (`row`, `orgQuery`) en `gerrieCore.ts`
  (`orgTable`): een pagina in de prullenbak telt niet mee.
  - Waarom: Gerrie, de MCP en de API draaien als service role, en de policy geldt alleen voor
    ingelogde gebruikers.
- `src/components/PageTrash.tsx`: de knop en het venster.
- `src/features/ContentLibrary.tsx`: verwijderen stuurt pagina's naar de prullenbak.
- `src/lib/repository.ts`: `trashPage`, `restorePage`, `listPageTrash`, `deletePageForever`.

## Om rekening mee te houden

- **pg_cron moet aan staan op staging.** Anders zegt de migratie dat met een notice, en moet
  `purge_page_trash()` op een andere manier worden ingepland. Dat geldt ook voor de taak van
  de MCP-clients.
- **De opruimwachtrij** wordt geleegd door de functie `file-transfer`. Op 6 november stond die
  op staging nog niet ingepland (`20261106160000_documenten_opslag.sql`). Tot dat gebeurt,
  blijven de bestanden in de opslag staan, maar zonder rij in de app.
- **Tekstdocumenten en notities** gaan nog steeds meteen weg. Alleen pagina's kennen een
  prullenbak.

## Getest

- **Unit tests:** `npm test` (2339 gelukt) en `npm run typecheck`.
- **Database:** de migratie twee keer achter elkaar toegepast, en `npm run test:database`
  (alle 18 bestanden geslaagd) met het nieuwe `paginas_prullenbak.sql`:
  - een pagina met twee subpagina's weggooien: onzichtbaar en niet te wijzigen, ook voor de
    eigenaar;
  - `archived_at` met de hand zetten wordt geweigerd;
  - de prullenbak voor een lezer wel, zonder Inhoud niet; een lezer zet niets terug;
  - terugzetten met de subpagina's;
  - twee keer weggooien geeft twee regels, en een subpagina terug terwijl haar ouder nog in
    de prullenbak ligt, komt los;
  - definitief verwijderen, met de bijlage in de opruimwachtrij;
  - na 31 dagen opgeruimd, wat net is weggegooid blijft;
  - een buitenstaander en een tekstdocument worden geweigerd.
- **Het nieuwe UI-scenario `paginadrive`:** 4 stappen, 0 fout.
  - De boom-stap van gisteren staat nu ook in dit scenario, los van "documenten": de stappen
    maken hun eigen pagina's, en zo draait het in een paar minuten.
  - Nieuw is de prullenbak: weggooien via het menu (pagina en subpagina), weg uit de lijst,
    één regel in de prullenbak met "met 1 subpagina", terugzetten, en definitief
    verwijderen.
- **Docker in deze sessie:** de achtergrondtaak stopte na twee uur. Daarna draaiden de
  database- en UI-tests in één begrensde opdracht die Docker zelf start en stopt.
  - Het scenario "documenten" is na het verplaatsen van de boom-stap niet opnieuw gedraaid.
  - Die stap gebruikt alleen zijn eigen pagina's.
