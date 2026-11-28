# Pagina's delen: vrijgeven en "Bijwerken bij klant" (stap 1C-3)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7 en §18.

Sinds stap 1C-2 ziet een klant van een pagina de versie die gedeeld is. Deze stap geeft de
app wat ze nodig heeft om te delen en bij te werken. Eerst de database en de server (1C-3a);
het venster in de app volgt (1C-3b).

## Wat er nu is (1C-3a: database en server)

- **`file-share` deelt een pagina met haar vrijgave.**
  - De app maakt eerst de vrijgave, met de rechten van wie deelt (`save_page_version`, reden
    `vrijgave`), en geeft het id mee (`documentVersionId`). De database keurt het nog eens.
  - Zonder vrijgave zegt `file-share`: "Een pagina deel je met een vrijgegeven versie".
  - Een versie bij iets anders dan een pagina weigert het.
  - Bij een pagina valt er niets te downloaden (`can_download` uit), en de mail noemt het een
    "Pagina".
- **Zien of de klant de pagina van nu ziet:** `page_share_status(pagina)`.
  - Per lopende deling: welke versie de ontvanger ziet, en of die gelijk is aan de pagina van
    nu (titel en inhoud).
  - Met de rechten van wie kijkt: wie Inhoud niet mag lezen, of in een andere organisatie
    zit, krijgt niets.
- **"Bijwerken bij klant":** `release_page_to_shares(pagina)`.
  - Legt een vrijgave vast, en zet die in één keer op elke lopende deling van de pagina.
  - Een ingetrokken of verlopen deling blijft zoals ze was.
  - Elke deling komt in het logboek, met de oude en de nieuwe versie.
  - Ziet iedereen de pagina van nu al, dan gebeurt er niets, en komt er geen versie bij. Zo
    vult een dubbele klik de geschiedenis niet.
  - Alleen voor wie Inhoud mag schrijven, en niet in de prullenbak.
- **De naam in het portaal en bij de geheime link volgt de versie.** Bij een losse deling
  toont het portaal nu de naam van het item zelf: bij een pagina de titel van de gedeelde
  versie. Eerst stond er de naam van toen er gedeeld werd.
- **In de app:** `createPageRelease`, `loadPageShareStatus` en `releasePageToShares` in
  `src/lib/repository.ts`. `shareDriveItem` geeft `documentVersionId` door.

## Keuzes

- **Bijwerken verandert alleen de versie, niet de naam van de deling.**
  - Een wijziging van de naam laat de database de ontvanger opnieuw controleren
    (`drive_shares_guard`).
  - Een contactpersoon die inmiddels geen portaaltoegang meer heeft, zou dan het bijwerken
    voor iedereen tegenhouden.
  - De naam die de klant ziet, komt toch al uit de versie.
- **De app maakt de vrijgave, niet `file-share`.** Zo ontstaat de versie met de rechten van
  de mens die deelt (CLAUDE.md, regel 2), en kan de editor eerst opslaan wat er nog stond.

## Getest

- **`tests/database/paginas_bijwerken.sql` (16 controles):**
  - de status per deling, en wie hem mag zien;
  - wie mag bijwerken;
  - bijwerken van twee lopende delingen, ook als een contactpersoon zijn portaaltoegang
    verloor;
  - een ingetrokken en een verlopen deling blijven staan;
  - het logboek;
  - geen nieuwe versie zonder verschil;
  - een tekstdocument en de prullenbak.
- **De hele databasetest, op een database vanaf nul**, en de migratie twee keer gedraaid:
  20 bestanden geslaagd.
- **`npm run test:stromen -- documenten`: 55 stappen, 0 fout.** De stappen voor pagina's gaan
  nu door de echte `file-share`:
  - delen zonder vrijgave geweigerd, en met vrijgave een mail aan de klant;
  - wijzigen, en de app ziet "oudere versie";
  - bijwerken (ook geweigerd voor wie alleen mag lezen), en de klant ziet de nieuwe titel en
    tekst;
  - een subpagina: onzichtbaar tot ze zelf gedeeld is, daarna "→ Tarieven";
  - de prullenbak;
  - een geheime link bij het eigen dossier.
- **Typecheck van `file-share`, `client-portal` en `file-share-public`** met tsc, tegen de
  typen van supabase-js. Ook `npm run typecheck`.
