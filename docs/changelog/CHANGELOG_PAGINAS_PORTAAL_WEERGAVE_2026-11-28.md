# Pagina's delen: wat de klant ziet, met opmaak en afbeeldingen (stap 1C-4)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7, §8 en §18.

Sinds 1C-3 kan de app een pagina delen. Deze stap maakt af wat de klant dan in het portaal
en bij een geheime link ziet. Het leesvenster (`ReadModal`) is voor beide hetzelfde.

## Wat er nu is

- **De opmaak van een gedeelde pagina** in het leesvenster (`src/styles/globals.css`, onder
  `.rich-text-viewer .rf-page`). Alles via de `rf-`klassen, want de sanitizer laat geen `id`,
  `style` of `data-*` staan:
  - koppen, citaat, code, markeren;
  - kaders in de kleur van hun soort;
  - tabellen met een kopregel, die binnen hun eigen vak schuiven als ze te breed zijn;
  - de takenlijst met vinkje en doorgehaald;
  - de uitklapper, kolommen en de inhoudsopgave;
  - "→ subpagina", "Bijlage: naam" en "[Afbeelding]".
- **Afbeeldingen.**
  - Getekend door de server, alleen voor afbeeldingen in de gedeelde versie
    (`pageImageSigner` in `_shared/fileTransferServer.ts`).
  - Alleen als de sleutel van precies die bijlage is (`storageKeyBelongsOnlyTo`).
  - Een uur geldig, het maximum van de worker: een lezer houdt een pagina langer open dan
    een download duurt, en een afbeelding laadt pas als hij erheen scrolt.
  - Met `inline=1`. Zonder dat stuurt de worker het als download (`nosniff`), en toont
    `<img>` niets.
  - Alleen png, jpeg, gif, webp en avif. Geen svg: dat kan script bevatten.
  - Lukt tekenen niet, dan staat er "[Afbeelding]" en komt de pagina er wel.
- **Bijlagen alleen als ze nú nog in het dossier van de pagina horen** (migratie
  `20261128140000_paginas_portaal_bijlagen.sql`, `shared_page_attachments`).
  - De gedeelde versie ligt vast, maar een bestand kan daarna naar de map van een andere
    klant verhuizen.
  - Dezelfde regel als bij het opslaan (`page_attachment_dossier`), zodat schrijven en tonen
    niet uit elkaar lopen.
  - Hij kijkt ook nog eens of de deling loopt.
  - Alleen voor de service-role.
  - Eerst filterde `sharedPage.ts` bestandsnamen alleen op de organisatie.

## Gevonden en gerepareerd

- **De sanitizer van het leesvenster haalde `colspan`, `rowspan`, `start`, `width`, `height`
  en `loading` weg.**
  - `sanitizeRichContentHtml` gebruikt een eigen regel voor adressen (alleen https, mailto,
    tel, cid en #). DOMPurify toetst daar elk attribuut aan dat hij niet als "URI-veilig"
    kent, en `colspan="2"` begint niet met https:.
  - Zo verloor een gedeelde pagina haar samengevoegde cellen en het startnummer van een
    lijst. Een tabel in een gedeelde notitie had hetzelfde.
  - Gevonden met de nieuwe browserstap in `ui.mjs paginadelen`, en daarna los nagebootst
    met DOMPurify 3.4.17 in Chromium, met en zonder die regel.
  - Nu staan deze zes attributen in `RICH_CONTENT_URI_SAFE_ATTRS` (`src/lib/sanitizeHtml.ts`),
    alleen voor eigen inhoud. Mail van buiten blijft zoals hij was.
  - Een afbeelding in het leesvenster wordt nooit breder dan het venster, nu `width` blijft
    staan.
- **Een afgevinkte taak in een gedeelde notitie leek open.**
  - De opmaak keek naar `li[data-checked="true"]`, en de sanitizer haalt `data-checked` weg.
  - Dat gebeurde in het portaal, bij een geheime link en bij een zending, al sinds het
    leesvenster saneert.
  - Nu kijkt de opmaak ook naar `aria-checked` op het vakje (dat blijft staan), en bij een
    pagina naar de klasse `rf-task-checked`.
  - Nagekeken: DOMPurify laat van de notitie-HTML `aria-checked` staan en `data-checked`
    niet.
- **Correctie op de changelog van 1C-1.** De test "de lijst overleeft de sanitizer van het
  portaal" keek alleen naar verboden namen, niet naar deze regel. Een nieuwe test in
  `pageHtml.test.ts` eist nu dat elk attribuut zonder adres in
  `RICH_CONTENT_URI_SAFE_ATTRS` staat.

## Getest

- **`ui.mjs paginadelen`, de nieuwe stap "de geheime link in de browser"** (8 stappen, 0 fout).
  Een pagina met kop, kader, tabel met een kopcel over twee kolommen en een gecentreerde cel,
  takenlijst, uitklapper, link en afbeelding gaat via een geheime link naar een lezer zonder
  login. Na de sanitizer is in de browser nagekeken:
  - het kader heeft kleur;
  - `colspan="2"` en de uitlijning staan er;
  - een afgevinkte taak toont "✓" en is doorgehaald, een open taak niet;
  - de uitklapper is dicht;
  - de link opent in een nieuw tabblad, met `noopener`;
  - de afbeelding laadt echt (de browser krijgt een PNG van 320 bij 120), via een getekende
    link met `inline=1`;
  - nergens `style`, `id` of `data-*`.

  Ook een gedeelde notitie met een afgevinkte taak toont nu het vinkje. Schermafdrukken
  nagekeken.
- **`tests/database/paginas_portaal_bijlagen.sql` (9 controles):**
  - de afbeelding en het bestand;
  - een bestand dat naar een andere klant verhuisde, valt weg, en komt terug;
  - niets bij een ingetrokken of verlopen deling, een pagina in de prullenbak, of een deling
    die niet bestaat;
  - een ingelogde gebruiker kan de functie niet aanroepen.
- **`sharedPage.test.ts` (8):** bijlagen alleen uit de databasefunctie; afbeeldingen getekend
  door de aanroeper; geen svg; tekenen mislukt en de pagina komt toch; nooit een http-adres.
- **`pageHtml.test.ts` (21):** elk attribuut zonder adres houdt de sanitizer heel.
- **`npm run test:stromen -- documenten`:** 55 stappen, 0 fout. De nep-media-worker tekent nu
  links (`nepdiensten.mjs`).
- **`ui.mjs documenten` en `paginas`:** 26 stappen, 0 fout.
- **`npm test`** (2410) en **`npm run typecheck`**.
- **tsc op `client-portal`, `file-share-public` en `file-share`**, tegen de typen van
  supabase-js.

## Later die dag

- **Op de pagina van een geheime link stond bij een pagina "De afzender heeft downloaden voor
  deze deling uitgezet".** Bij een pagina staat downloaden altijd uit, want je leest haar
  daar. Nu staat die zin er alleen als er iets te downloaden zou zijn. Het portaal zegt
  "alleen bekijken", en dat klopt.
- **De browserstap kijkt ook op 390px.** Het leesvenster past, en de tabel schuift binnen haar
  eigen vak.
- **De openbare deelpagina is altijd donker.** De huisstijl zet daar alleen kleur en letters.
  Het lichte thema van een klant (`brand_client_theme`) is dus alleen via de variabelen
  getoetst, niet op het scherm.

## Niet in een browser bekeken

Het klantportaal zelf. Daar vraagt inloggen een mail met een link. Het portaal gebruikt
hetzelfde leesvenster en dezelfde sanitizer als de geheime link. Wat de server het portaal
geeft, toetst `npm run test:stromen -- documenten` (de echte `client-portal`).
