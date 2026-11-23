# Notulen toevoegen aan een notitie of document (2026-11-23)

## Wat de PO vroeg

> Maak een functie om de gemaakte notulen direct als aantekening in een notitie of
> document te stoppen.

## Wat er nu kan

Bij de notulen van een opname staat de knop **Toevoegen aan notitie of document**,
naast "Kopieer notulen" en "Opslaan als notitie". De knop opent een lijst:

- zoeken op titel of klantnaam (hoofdletters en accenten maken niet uit);
- de laatst bewerkte staat bovenaan, en een regel erbij vertelt of het een notitie
  of een document is en bij welke klant het hoort;
- kies er één en druk op **Voeg notulen toe**. De notulen komen **onder** de
  bestaande tekst. Er gaat niets verloren.

Wat er in de notitie komt: een kopje "Notulen — <afspraak> (<datum>)", de
samenvatting, en per onderdeel een lijst (Besproken, Besluiten, Actiepunten,
Vervolgafspraken). Een leeg onderdeel blijft weg.

De knop staat bij:

- een afspraak in de agenda;
- het gesprek in Communicatie (de opname bij een telefoongesprek).

## Waar je op kunt rekenen

- **Alleen met schrijfrecht op Inhoud.** Wie notities en documenten niet mag
  wijzigen, krijgt de knop niet te zien. Dat staat los van het recht op de agenda
  of op Communicatie. De database houdt zich sowieso aan de rechten van de
  gebruiker zelf (`updateRow`, RLS).
- **De tekst van dát moment.** Vlak voor het opslaan wordt de actuele tekst uit de
  database gehaald, niet uit de lijst op het scherm. Een collega die intussen iets
  typte raakt het zo niet kwijt. (Hetzelfde als bij "tekst aanvullen" van Gerrie.)
- **Platte tekst van vóór de editor** wordt eerst alinea's. Zonder dat plakte de
  aanvulling aan de laatste regel vast.
- **Geen Word-documenten in de lijst.** Een document met `storage_key` is een .docx
  in Collabora en `content` is daar alleen een tekstspiegel. Tekst die we daarin
  zetten, komt niet in het bestand en verdwijnt bij de volgende keer opslaan.
- **Tekst uit de opname is gegevens.** Alles wat in de notulen staat gaat door
  `esc()` en daarna door `sanitizeRichText`. HTML in een samenvatting wordt tekst.
- Lukt het opslaan niet, dan staat de foutmelding in het paneel en blijft je
  keuze staan, zodat je het opnieuw kunt proberen.
- Na het toevoegen ververst de werkruimte, dus de notitie toont meteen de nieuwe
  tekst.

## Hoe het zit

| Bestand | Wat |
| --- | --- |
| `src/lib/notulen.ts` | de opmaak van de notulen, de keuzelijst en het zoeken (zonder DOM, getest) |
| `src/lib/contentAppend.ts` | het wegschrijven: actuele tekst ophalen, eronder zetten, opslaan |
| `src/lib/useContentAppend.ts` | de twee props voor `MeetingRecorder`, gelijk voor agenda en gesprekken |
| `src/components/NotulenToevoegen.tsx` | het paneel met zoeken, kiezen en bevestigen |
| `src/components/MeetingRecorder.tsx` | de knop, en de props `contentTargets` en `onAppendToContent` |
| `src/styles/globals.css` | `.mr-append*` |
| `src/features/CalendarPage.tsx`, `src/features/Communication.tsx`, `src/main.tsx` | aansluiting en het recht `canWriteContent` |

Notities en documenten zitten in de kern van de gegevens (niet in een van de vijf
zware groepen van `dataGroups.ts`), dus `GROUP_FILES` verandert niet.

## Getest

- `src/lib/notulen.test.ts`: opmaak, een leeg onderdeel, HTML in de opname, de
  terugval op de samenvattingstekst, volgorde, het weglaten van Word-documenten en
  zoeken met accenten.
- Echte Chromium (telefoon 390×844, donker en licht): Word-document niet in de lijst,
  zoeken op klantnaam, lege uitkomst, keuze, fout met behoud van de keuze, daarna
  precies één keer toevoegen aan het goede document, geen horizontale scroll.
- Echte `sanitizeRichText`: kopjes en lijsten blijven staan, platte tekst wordt een
  alinea en de notulen komen onder de bestaande tekst.
- `npm run typecheck`, `npm test` (2229 tests), `npm run test:mobile -- --theme=both`.

## Niet gedaan

- In het venster **Gesprek loggen** (`CallLogDialog`) staat de knop nog niet. In
  het detail van het gesprek wel. Dat venster sluit zichzelf bij het opslaan en
  heeft geen eigen verversing; daar wil ik niet naast bouwen zonder dat apart te
  bekijken.
- Er is nog geen proef op staging met een echte notitie. De knop gaat langs
  `updateRow` met de sessie van de gebruiker, net als de bestaande Gerrie-handeling
  voor "tekst aanvullen"; de volledige route (met RLS) is hier niet doorlopen.
