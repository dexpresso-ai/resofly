# Pagina's delen: vrijgeven en "Bijwerken bij klant" (stap 1C-3)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7 en §18.

Sinds stap 1C-2 ziet een klant van een pagina de versie die gedeeld is. Deze stap maakt
delen en bijwerken mogelijk: eerst in de database en de server (1C-3a), daarna in de app
(1C-3b, verderop).

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

## Later die dag: het venster in de app (1C-3b)

- **"Delen" bij een pagina**: in de balk van de editor en in het menu van de drive.
  "Versturen…" blijft weg tot de export naar PDF er is.
- **Het deelvenster voor een pagina** (`src/components/ShareDialog.tsx`):
  - eerst slaat de editor op wat er nog stond, dan maakt de app een vrijgave, dan deelt ze
    met die versie;
  - een uitleg bovenaan: de ontvanger ziet de pagina zoals ze nu is, en wat je daarna
    wijzigt pas na "Bijwerken bij klant";
  - **subpagina's vink je aan**, los of allemaal. Elke wordt een eigen deling met een eigen
    vrijgave, zonder eigen mail. Een subpagina die je niet aanvinkt, ziet de ontvanger niet.
    Via een deellink gaat alleen de pagina zelf mee: een link naar een subpagina zou
    niemand krijgen;
  - geen "Downloaden toestaan": bij een pagina valt niets te downloaden;
  - bij "Wie heeft nu toegang" per ontvanger welke versie hij ziet ("Ziet versie 3 van
    28-11-2026"), het label "Oudere versie", en bovenaan de melding met de knop
    "Bijwerken bij klant".
- **In de editor de melding "De klant ziet een oudere versie van deze pagina."**, met de knop
  "Bijwerken bij klant".
  - De melding staat er bij het openen als iemand de pagina intussen wijzigde.
  - Ze verschijnt meteen als je zelf iets wijzigt in een gedeelde pagina.
  - De knop slaat eerst op, en zegt daarna hoeveel ontvangers de nieuwe versie zien.
- **Het venster ligt boven de editor.** De editor staat op z-index 2000 en een venster op 100;
  vanuit de editor viel het deelvenster er anders achter. Het laadt pas bij een klik.
- **Gerrie, de agents, de MCP en de API delen een pagina zoals de knop.**
  - De kaart in de wachtrij noemt het een pagina, en zegt wat de klant ziet.
  - Bij "Uitvoeren" maakt de app eerst de vrijgave, met de rechten van wie goedkeurt. De
    klant ziet de pagina zoals ze was bij het akkoord, niet bij het voorstel.
  - Downloaden staat bij een pagina altijd uit.
- **`subpagesOf`** in `src/lib/pageTree.ts`: de subpagina's onder een pagina, in de volgorde
  van de boom, bestand tegen kringen.

### Getest (1C-3b)

- **Een nieuw UI-scenario `paginadelen` (`tests/stromen/ui.mjs`), 6 stappen, 0 fout:**
  - delen vanuit de editor, met de klant en de subpagina. Wat je net typte zit in de
    vrijgave, en het portaal toont het, met "→ subpagina". Het venster ligt vóór de editor
    (gemeten met `elementFromPoint`). Op 390px past de balk met "Delen", en staat het
    venster in beeld;
  - na een wijziging elders staat de melding er bij openen. "Bijwerken bij klant" geeft het
    portaal de nieuwe tekst, ook wat je net typte, en dat staat in het logboek;
  - Gerrie deelt een pagina via een gekoppelde AI. Na "Uitvoeren" is er een vrijgave van de
    beheerder die goedkeurde, en de klant ziet de tekst van dat moment;
  - "Delen…" in de drive opent het venster voor een pagina; "Versturen…" staat er niet.
- **Schermafdrukken nagekeken**: het venster en de melding, licht en donker, breed en op de
  telefoon.
- **`ui.mjs paginas` (18), `paginadrive` (10) en `documenten`**: geslaagd. Eén oude stap
  verwachtte geen "Delen" bij een pagina, en zegt nu dat delen kan en versturen nog niet.
- **`npm run test:terugknop`** (18 gelukt) en **`npm run test:loading`** (alles geslaagd).
- **`actionAllTasks.test.ts`**: de kaart voor een pagina, en een gewoon document blijft zoals
  het was.
- **`pageTree.test.ts`**: `subpagesOf`, met een kring.
- **`npm test`** (2408) en **`npm run typecheck`**.
