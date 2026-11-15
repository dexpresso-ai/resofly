# Changelog — Galerij: een rustige werkbalk, en Bewerken en Verwijderen in de lijst — 2026-11-15

## Aanleiding

> Ik vind de opties/menu rommelig bij de gallerij, hier moet echt wat mooiers en vriendelijker
> voor komen. Maak hier iets moois op, zet de branch daarna klaar op staging.

En tijdens het werk:

> Ik wil dat je in het gallerij overzicht ook een optie achter de albums toevoegd om ze of te
> bewerken of te verwijderen. Bij verwijderen dient de gebruiker altijd nog een
> bevestigingsmelding te krijgen. Uiteraard wordt er bij het verwijderen van het album ook alle
> bestanden van R2 verwijderd.

## Wat er mis was

Boven een open album stond alles los op één rij:

- elf knoppen (Eigen tabblad, Alleen de galerij, Bestanden, Indelen, Volgorde, Delen,
  Instellingen, Publiceren of Terug naar concept, Uploaden);
- een keuzelijst "Sorteren…";
- twee pillen: de opslagmeter en het hartje met favorieten.

Op een laptop liep die rij over twee regels en kneep hij de naam van de galerij weg tot
"Ankie …". De status viel er zelfs helemaal af. `.client-panel-head span` maakte bovendien van
elke span een pil, ook van de tekst en het balkje ín de opslagmeter: een pil in een pil. Op de
telefoon was het een strook om zijwaarts door te vegen.

In de lijst met albums kon je een album alleen openen. Verwijderen zat in de instellingen van
een album, met een kale melding van de browser die alleen de naam noemde.

## Wat er nu is

### De kop van een album

Twee lagen.

**Boven** staat welke galerij dit is:

- de naam groot, met "‹ Galerijen" erboven;
- daaronder de status als stip met woord (grijs *Concept*, groen *Gepubliceerd*), het formaat en
  hoeveel foto's en video's erin staan;
- of de deellink aanstaat, de vervaldatum, en "Opslag bijna vol" vanaf 90%.

Rechts staat wat je richting de klant doet:

- **Instellingen** en **Delen**;
- **Publiceren**, groen zoals de status die het oplevert, alleen zolang het album nog niet
  gepubliceerd is;
- **Uploaden**, de gouden hoofdknop;
- **⋯ Meer**.

Twee gouden knoppen naast elkaar (Publiceren en Uploaden) zeiden niet welke eerst; nu is er één.

**Onder**, vlak boven de foto's, staat wat je ziet en hoe het geordend is:

- **Alles · 9 | ♥ Favorieten · 3**: een schakelaar in plaats van een losse pil. Hij staat er
  ook als de klant nog niets koos, zodat je weet dat het bestaat.
- **Ordenen** (met een teller als er bestanden nog nergens in een categorie staan). Daarin:
  - *Volgorde slepen* en *Indelen in categorieën*, met een vinkje als die stand aan staat;
  - *Categorieën en bestanden*: het venster dat eerst achter de knop "Bestanden" zat;
  - *Sorteren* op naam (A tot Z en Z tot A) en op uploaddatum. De kop zegt erbij dat dit de
    volgorde vervangt.

Onder **Meer** staan:

- *Alleen de galerij tonen* en *In een eigen tabblad*;
- *Terug naar concept*, als het album gepubliceerd is;
- de opslagmeter. Die gaat over het hele account, niet over dit album.

In de presenteerstand staat **Verlaten** gewoon in beeld. In een menu zoekt niemand de uitgang.

Elke regel in een menu heeft een zin uitleg ("Sleep foto's naar de plek waar ze moeten staan")
in plaats van alleen een woord. De balk bij slepen en bij indelen heeft nu een knop **Klaar**.
Eerst zette je die stand uit met dezelfde knop waarmee je hem aanzette.

Op de telefoon tonen Instellingen en Delen alleen hun icoon. Het woord blijft er voor een
schermlezer: weggeknipt, niet weggehaald. Publiceren en Uploaden delen de rest van de breedte.
Smaller dan 420px wordt "Favorieten" een hartje met het aantal.

### De lijst met albums

Achter elk album staat een menu **⋯** met:

- **Bewerken**: opent het album met de instellingen erop (naam, opening, weergave, downloads);
- **Verwijderen**: opent altijd eerst de vraag *Album verwijderen?*.

Die vraag is een eigen venster, geen melding van de browser. Hij zegt wat er verdwijnt:

- hoeveel bestanden en hoe groot, "ook uit de opslag bij Cloudflare";
- dat de klant het album niet meer in het portaal ziet (als het gepubliceerd is);
- dat de deellink niet meer werkt (als die aanstaat);
- de favorieten die de klant koos.

Daaronder: "Dit kun je niet ongedaan maken. Wil je iets bewaren? Download het album dan eerst."
**Annuleren** heeft de focus, dus Enter na een dubbelklik verwijdert niets. Escape, het kruisje en
de terugknop van de telefoon zijn ook nee, behalve terwijl het verwijderen loopt. Mislukt het,
dan blijft het venster open en zegt het waarom. Verwijderen vanuit de instellingen van een album
gaat nu langs hetzelfde venster.

### R2

Het opruimen zelf is niet veranderd (zie `CHANGELOG_GALERIJ_OPRUIMEN_SNELHEID_2026-11-12.md`):

1. bij het wissen van het album zet de database de map in `gallery_purge_queue`;
2. de app vraagt de media-worker meteen om die map in R2 en de kijkkopieën bij Stream te vegen
   (`/gallery/purge`);
3. de geplande taak van de worker vangt op wat dan niet lukt, en veegt een uur later nog eens.

Wie mag verwijderen, beslist nog steeds de database: alleen een album van de eigen organisatie,
met schrijfrecht op Projecten. Zonder schrijfrecht staat het menu er niet.

## Hoe

- `src/features/GalleryMenu.tsx` (nieuw): de knop met uitklapmenu. Het gedrag volgt "+ Nieuw"
  (`CreateMenu`):
  - pijltjes, Home en End, Escape (terug naar de knop), Tab, en een klik ernaast;
  - de terugknop van de telefoon (`useBackStep`);
  - een stand die aan kan staan is `menuitemcheckbox` met `aria-checked`.
- `src/features/ProjectGallery.tsx`:
  - de kop is `.gal-head` en staat buiten `.client-panel-head`;
  - `GalleryDeleteDialog` is de vraag. Hij telt de bestanden met `selectGalleryItemNames`, dus
    zonder het album te openen;
  - `removeGallery` vraagt zelf niets meer en gooit een fout door naar het venster;
  - "Bewerken" opent het album via `openWithSettings`. Het effect dat bij openen alle vensters
    sluit, zette de instellingen anders meteen weer dicht.
- `src/styles/globals.css`:
  - de nieuwe kop, de werkbalk, het menu, de rij in de lijst en het venster;
  - de oude regels voor `.gal-detail-tools` en de veegbare strook (#37) zijn weg;
  - de kop ligt op z-index 8, boven de zwevende knoppen van het album (6). Anders lagen
    afspelen, grootbeeld en downloaden over een open menu heen.

## Getest

- `npm run typecheck` en `npm test` (1897 tests): groen.
- `npm run test:mobile -- --theme=both`. De lay-outtest meet de galerij nu ook (`gallery: true` in
  de mock: twee albums, waarvan één met negen foto's, categorieën en favorieten):
  - `project-gallery`: het album in het tabblad Galerij;
  - `gallery-tab`: het album als eigen tabblad;
  - `gallery-ordenen`: met Ordenen open;
  - `galerijen-menu`: de lijst met het menu achter een album open;
  - `galerij-verwijderen`: de vraag *Album verwijderen?*.
- `tests/stromen/ui.mjs galerij` tegen een verse lokale stack: 12 stappen groen. Twee stappen
  zijn nieuw:
  - Bewerken opent de instellingen. Verwijderen noemt "6 bestanden", Cloudflare, portaal en
    deellink. Annuleren en Escape laten het album staan, en de worker krijgt geen verzoek.
  - *Album verwijderen*: het album is weg uit de lijst en de database, de map
    `<organisatie>/gallery/<album>/` staat in `gallery_purge_queue`, en de app vroeg de worker om
    op te ruimen.

  De stap "vanuit het venster Bestanden" opent dat venster nu via Ordenen.
- `npm run test:terugknop`: groen.
