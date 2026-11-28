# Pagina's als Word-bestand: de omzetting (stap 1B-2, eerste deel)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §9 en §18.

## Wat er nu is

- **Een module die een pagina een .docx maakt:** `supabase/functions/_shared/pageDocx.ts`.
  - `buildPageDocx(titel, body, context)` geeft het Word-bestand.
  - `pageDocxFiles(...)` geeft de losse onderdelen, voor de tests.
  - De context levert wat de pagina zelf niet weet, opgezocht met de rechten van wie
    exporteert:
    - de titels van subpagina's;
    - de namen van bestanden;
    - de bytes van afbeeldingen.
- **Er is nog geen knop in de app.** De edge function `page-export`, het exportvenster en de
  PDF komen pas met de office-server (Collabora). Die draait niet in een cloudsessie (§18).
  Volgens §9 bouwt de server de DOCX, niet de browser.
- **De zip-schrijver van "Alles exporteren" staat nu in `_shared`**
  (`supabase/functions/_shared/zipWriter.ts`):
  - de app leest hem via `src/lib/zipWriter.ts`, net als `forecast.ts`;
  - een edge function kan niet bij `src/`, en anders was er een vierde zip-schrijver
    bijgekomen;
  - de code zelf is niet veranderd;
  - de tests gingen mee naar `_shared`.

## Wat er in het bestand komt

| Blok | In Word |
| --- | --- |
| Kop 1 tot 3 | De stijlen Kop 1 tot 3 (navigatievenster, inhoudsopgave) |
| Opmaak | Vet, cursief, onderstreept, doorgehaald, code (Consolas, grijs), markeren (geel) |
| Link | Alleen http(s), mailto en tel. Een link binnen de app (`/…`, `#…`) wordt gewone tekst: buiten de app wijst hij nergens heen. |
| Opsomming, nummering | Echte Word-lijsten. Elke genummerde lijst begint weer bij 1, en geneste lijsten gaan een niveau dieper. |
| Takenlijst | ☒ en ☐; wat af is, staat in grijs |
| Tabel | Met de kopregel bovenaan, die op elke pagina terugkomt. Samengevoegde cellen blijven samengevoegd, en breedte en uitlijning gaan mee. Is de tabel te breed, dan krimpt hij tot de tekstbreedte. |
| Kader (callout) | Een gekleurde cel met een rand links, in de kleur van de soort |
| Uitklapper | Open: de kopregel vet, de inhoud ingesprongen |
| Inhoudsopgave | Een echt inhoudsopgave-veld, al gevuld met de koppen. Word zet er bij bijwerken (F9) de paginanummers bij. |
| Citaat, code, scheidingslijn | Eigen stijlen; de code houdt regels en tabs |
| Subpagina | "→ titel" (of "Pagina niet gevonden", zoals in de app) |
| Bestand | "Bijlage: naam" |
| Afbeelding | Ingesloten (png, jpeg, gif), op ware grootte en nooit breder dan de tekst. Anders "[Afbeelding: alt-tekst]". Nooit een adres van buiten. |
| Kolommen | Een tabel zonder randen (voor als de editor ze krijgt) |
| Onbekend blok | Alleen de tekst |

Verder:

- de titel bovenaan en in de eigenschappen (een PDF neemt hem over);
- A4 met 2,5 cm marge;
- "Pagina 1 van 3" onderaan;
- Nederlands als taal;
- compatibiliteitsmodus van Word 2013 en later, zodat Word niet in de oude modus opent.

## Bewust nog niet

- **De huisstijl:** letters, logo, briefpapier en merkkleur. Dat komt met het exportvenster,
  na de proef met letters en emoji (1B-1).
- **Een voorblad, en subpagina's als hoofdstukken.** Ook die horen bij het exportvenster.
- **Webp en svg:** die worden een regel "[Afbeelding: …]". Omzetten naar png hoort bij
  `page-export`.
- **De inhoudsopgave in de PDF:** LibreOffice toont de lijst met koppen, maar zonder
  paginanummers. Of Collabora het veld bijwerkt, kijkt de proef 1B-1 na.

## Getest

- **`pageDocx.test.ts`, 17 tests:**
  - elk bloktype en elke markering die de database toelaat (`src/lib/pageSchema.ts`) komt in
    het bestand terecht. Een nieuw blok zonder omzetting laat de test falen;
  - de volgorde van de opmaak volgt het schema;
  - tekens als `<`, `&` en stuurtekens worden veilig;
  - links: één relatie per adres, en geen `javascript:`;
  - lijsten, tabellen (raster, samenvoegen, breedtes, krimpen), kaders, de inhoudsopgave;
  - afbeeldingen: maat, verkleinen en één kopie per afbeelding;
  - `imageSize` voor png, gif en jpeg;
  - de zip zelf: alle onderdelen, welgevormde XML, en dezelfde inhoud als `pageDocxFiles`;
  - een lege of kapotte body.
- **`npm test`:** 2357 gelukt.
- **`npm run typecheck`:** goed, en `pageDocx.ts` apart met `tsc --strict`.
- **`vite build`:** goed, met de verhuisde zip-schrijver.
- **Met de hand, op een proefpagina met elk blok:**
  - **Tegen de XSD's van ECMA-376:** alles goed. De controle kwam van `validate.py` uit de
    docx-skill van Claude Code; in een cloudsessie staat die in
    `/mnt/skills/public/docx/scripts/office`.
  - **De controle werkt:** ter proef één element in de verkeerde volgorde gezet, en dat werd
    afgekeurd.
  - **In LibreOffice 24.2 omgezet naar PDF** (`soffice --headless --convert-to pdf`): twee
    pagina's, en alles staat erin zoals in de tabel hierboven.
- **Niet gedaan:** het bestand openen in Microsoft Word zelf. Dat kan niet in een
  cloudsessie; het staat bij de vragen voor de gebruiker.
