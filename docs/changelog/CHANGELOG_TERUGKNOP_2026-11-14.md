# De terugknop van de telefoon gaat terug in de app, in plaats van hem weg te zetten (2026-11-14)

## Aanleiding

"Een gebruiker gebruikt regelmatig de terugknop van Android (rechtsonderin het
scherm). Nu merk ik dat ResoFly dan vaak helemaal minimaliseert en verdwijnt
van het scherm."

## Wat er misging

ResoFly wisselt van pagina in React-state, niet via adressen. Voor de browser
bleef het dus altijd één en dezelfde pagina, zonder geschiedenis. De
terugknop van Android vraagt de browser om één stap terug; die was er niet,
en dan zet Android de app naar de achtergrond. Dat gebeurde overal: op een
klant, in een bewerkvenster, met het menu open, in een gesprek in Berichten.
Alleen de knoppen in beeld (het kruisje, de terugpijl van het kruimelpad)
gingen terug.

## Wat er nu klopt

De terugknop doet in deze volgorde:

1. **Een open venster, menu of paneel gaat dicht**, het laatst geopende eerst,
   precies zoals het kruisje of een tik ernaast. Ook een gesprek dat op de
   telefoon het hele scherm vult (Berichten, teamchat, Gerrie → Gesprekken)
   gaat terug naar de lijst, zoals de terugpijl in de kop.
2. **Dan de vorige pagina van het werktabblad**, zoals een tabblad in de
   browser. Elk werktabblad heeft zijn eigen geschiedenis.
3. **Is die op** (net opgestart, of na herladen), **dan een niveau omhoog**,
   naar dezelfde pagina als de terugpijl van het kruimelpad: van een project
   naar Projecten, en van daar naar het dashboard. In een losse app (Agenda,
   Financiën, Communicatie) eindigt dat bij het begin van de app.
4. **Een tabblad dat je vanuit een ander opende** (met +, of een galerij) gaat
   aan het eind terug naar dat tabblad en sluit zichzelf, zoals een tabblad in
   Chrome dat een link opende. Daarna gaat terug daar gewoon verder.
5. **Op het dashboard is er niets meer**: dan zet de terugknop de app weg,
   zoals op het beginscherm van elke app.

Wat met terug dichtgaat: alle gewone vensters (`Modal`, dus ook elk
bewerkvenster), het leesvenster, de vensters en menu's van de teamchat, het
mobiele menu, de menu's Weergave en Account, het chatpaneel van Gerrie, het
zwevende teampaneel, de Office-editor, het venster en de dagkaart in de
agenda, het detail van een afspraak, de vensters in Jaarrekening, Boekjaren,
Dividend en Aandeelhouders, de instellingen en het delen van een galerij,
de vraag over dubbele bestanden in een galerij (terug is daar Upload stoppen,
net als Escape), een vergrote foto, video of diavoorstelling in de galerij,
de presenteerstand van de galerij, handschrift (schrijven en de tabletmodus),
het tekenrooster van de boekingslinks, de menu's in Inhoud, het eiland van
Stroom en "+ Nieuw".

Wat met terug een stap terug gaat binnen een pagina: een gesprek in Berichten
en in de teamchat (op de telefoon), Gerrie → Gesprekken (telefoon en tablet),
een open agent, de bouwer en het formulier bij Agents, de editors in
Marketing, een zending (Alle zendingen), een contractsjabloon, een album in
de galerij van een project (zoals "← Galerijen"), en een map in Inhoud (één
niveau omhoog per druk, zoals Terug).

Op een computer doet de terugknop van de browser of de muis hetzelfde.
Vooruit doet niets: daar zijn de stappen al weg.

## Hoe het werkt

- `src/lib/backButton.ts`: per stap één item in de browsergeschiedenis (met
  `pushState`, zonder ander adres). Een druk op terug neemt één item weg, en
  wij doen de bovenste stap. Sluit iets met de knop in beeld, dan halen wij
  zijn item weg (`history.go`).
- **Alleen na een tik.** Chrome slaat items over die een pagina toevoegde
  zonder dat iemand tikte (tegen sites die de terugknop kapen), en na een stap
  terug telt een eerdere tik niet meer mee. Een item dat we als antwoord op een
  druk op terug zouden neerzetten (het bekende trucje), sloeg Chrome over, en
  de tweede druk zette alsnog de app weg. Daarom zet de terugknop alleen een
  item neer als er sinds de laatste stap terug getikt is, en anders bij de
  eerstvolgende tik. Een stap terug zelf zet nooit iets neer. Om dezelfde
  reden tellen in een tabblad dat uit een ander kwam, de stappen van dat andere
  tabblad mee: anders kwam er na het sluiten een item bij zonder tik.
- **Een kwart seconde wachten met weghalen.** Een menu dat sluit bij het
  indrukken van de muis en een klik die daarna een pagina opent, zijn op een
  computer twee gebeurtenissen. Zonder wachttijd haalden we het item van het
  menu weg, telde de klik daarna niet meer als tik, en kreeg de nieuwe pagina
  geen item.
- **Herladen midden in de app** laat items achter van een document dat er niet
  meer is; terug naar zo'n item laadt de app opnieuw, bij elke druk. Daarom
  gaat de app na herladen meteen terug naar het begin (één keer extra laden).
  Hetzelfde als Android de app stopte en later terughaalt.
- `src/lib/tabHistory.ts`: de geschiedenis per werktabblad, het kruimelpad als
  terugval, en het tabblad waar een tabblad uit kwam.
- `src/lib/useBackStep.ts`: een venster of scherm meldt zich aan met
  `useBackStep(open, sluiten)`. In de werktabbladen zorgt `BackScope` dat
  alleen het tabblad dat je ziet meetelt (de andere blijven gemount).

### Voor wie iets nieuws bouwt

- Een nieuw venster op basis van `Modal` doet het vanzelf. Een eigen overlay
  of een scherm met een eigen terugpijl: `useBackStep(open, sluiten)`, met
  dezelfde functie als de knop in beeld.
- Wis `history.state` niet: `history.replaceState(window.history.state, '', …)`
  in plaats van `replaceState(null, …)`. Daar staat de stap van de terugknop.
  Het menu (agenda-anker) en de bankkoppeling deden dat; dat is nu aangepast.

## Bekend

- Niet alles is aangemeld: de keuze bij het slepen in de weekplanner, de
  zoekresultaten van de zoekbalk (alleen op een breed scherm), de
  inrichtingsstappen van een nieuwe organisatie en het klantportaal. Daar gaat
  terug naar de vorige pagina.
- Opent er iets zonder tik (een melding die vanzelf een scherm opent, iets
  wat klaar is na het opslaan nadat je al op terug drukte), dan wacht zijn
  item op de volgende tik. Druk je vóór die tik op terug, dan is er één stap
  te weinig en gaat de app aan het eind één druk eerder weg.
- Na herladen is de geschiedenis van de tabbladen leeg; terug gaat dan omhoog
  langs het kruimelpad.
- Op een computer kun je via het menu van de terugknop meer stappen tegelijk
  terug; tussen tabbladen gaat dat één stap tegelijk.

## Getest

- `npm run typecheck` en `npm run build`: schoon.
- `npm test` (na het samenvoegen met staging): 1857 tests, 0 fout. (Het
  eerste commitbericht noemde 1861; dat getal was niet gemeten.) Nieuw:
  - `src/lib/backButton.test.ts` (17), met een nagebootste browser die
    bijhoudt wanneer er getikt is: een item alleen na een tik, nooit als
    antwoord op een druk op terug; dicht met het kruisje haalt het item weg;
    sluiten en openen in één klik vallen weg; een menu dat sluit bij het
    indrukken van de muis en een klik die daarna een pagina opent; vooruit;
    een gewiste `history.state`; herladen midden in de app; een browser die
    niet teruggaat;
  - `src/lib/tabHistory.test.ts` (15): vorige pagina's, omhoog langs het
    kruimelpad, losse apps, verwijderde projecten, de grens van 50, een
    tabblad uit een ander tabblad, en een rapportage die zijn id krijgt.
- `npm run test:terugknop` (nieuw): 12 scenario's in Chromium op een telefoon
  (en één op een computer), 0 fout. Met de wachttijd op 0 faalt het
  computerscenario, zoals verwacht.
- `npm run test:mobile -- --theme=both`: 620 pagina's gemeten, 0 met
  problemen (geen JavaScript-fouten, lay-out ongewijzigd).
- `npm run test:loading`: alle controles geslaagd.
- `npm run test:inrichten`: alle controles geslaagd (de inrichting laadt
  main.tsx ook, zonder terugknop).
- Niet getest op een echte telefoon: dat Chrome op Android een item zonder
  tik overslaat, bootst `backButton.test.ts` na; Playwright doet dat niet.

## Bestanden

- `src/lib/backButton.ts`, `src/lib/backButton.test.ts` (nieuw)
- `src/lib/tabHistory.ts`, `src/lib/tabHistory.test.ts` (nieuw)
- `src/lib/useBackStep.ts` (nieuw)
- `src/main.tsx`: de geschiedenis per tabblad, `BackScope` per tabblad, het
  mobiele menu, terug naar het begin na herladen
- `src/components/Modal.tsx`, `ReadModal.tsx`, `teamchat/ui.tsx`,
  `teamchat/ChatShell.tsx`, `teamchat/attachments.tsx`, `TeamChat.tsx`,
  `GerrieChat.tsx`, `GerrieConversations.tsx`, `ZenitNav.tsx`, `Sidebar.tsx`,
  `CreateMenu.tsx`, `StroomIsland.tsx`, `TransfersPanel.tsx`,
  `NoteHandwriting.tsx`, `InkCanvas.tsx`
- `src/features/Communication.tsx`, `CalendarPage.tsx`,
  `GerrieCommandCenter.tsx`, `Marketing.tsx`, `ContentLibrary.tsx`,
  `Contracts.tsx`, `OfficeEditor.tsx`, `MeetingBookingManager.tsx`,
  `AnnualAccounts.tsx`, `FiscalYears.tsx`, `Dividends.tsx`, `Shareholders.tsx`,
  `ProjectGallery.tsx`, `GalleryViewer.tsx`, `Bank.tsx`
- `tests/terugknop/run.mjs`, `tests/terugknop/README.md` (nieuw),
  `npm run test:terugknop`; ook als stap in `.github/workflows/frontend-checks.yml`
  en in het lijstje "Voor je pusht" van `CLAUDE.md`
