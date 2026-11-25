# Taakvenster: tekst over de volle breedte, de rest compact (2026-11-25)

## Wat de PO vroeg

> Bij het aanmaken van een nieuwe taak dient de beschrijving, subtaken en
> comments de volledige breedte van de popup te krijgen. Verdeel de rest zo
> optimaal mogelijk.

## Wat er mis was

- Het venster **Nieuwe taak** (en **Taak bewerken**) had een raster van twee
  gelijke kolommen. De beschrijving stond daarin als één veld, dus in een
  halve kolom, naast **Toegewezen aan**.
- **Subtaken** en **Comments** stonden naast elkaar, elk op de helft. Te krap
  voor een subtaak of een update, terwijl je daar juist het meest typt.
- Korte velden (status, prioriteit) namen net zoveel ruimte als klant en
  project. Het venster werd daardoor lang: veertien velden in zeven rijen.
- In het blok **Agenda** (alleen bij bewerken) stonden de knoppen **Tijd
  reserveren** en **Koppel bestaande afspraak** onder elkaar. Een regel voor de
  kop van het blok (titel en teller onder elkaar) trof ook de knoppenrij.

## Wat er nu is

Een raster van zes kolommen, op een laptop of groter:

| Rij | Velden |
| --- | --- |
| 1 | Taaktitel (4) · Status (1) · Prioriteit (1) |
| 2 | **Beschrijving**, volle breedte |
| 3 | Klant (3) · Project (3) |
| 4 | Toegewezen aan (4) · Tags (2) |
| 5 | Startdatum · Deadline · Geschatte duur (2 elk) |
| 6 | Plandatum · Loopt door tot · Tijd in het rooster (2 elk) |
| 7 | **Subtaken**, volle breedte |
| 8 | **Comments**, volle breedte |
| | Agenda, upload en bijlagen: volle breedte, zoals al |

- De beschrijving staat direct onder de titel. Die schrijf je na de titel,
  niet pas na de planning. Hij is iets hoger (120px).
- Klant en project staan samen: het project bepaalt de klant.
- Rij 6 is alles wat de plek in de weekplanner bepaalt.
- Velden in één rij staan bovenaan uitgelijnd. Zonder dat rekte een veld zich
  uit tot de hoogte van een buur met meer uitleg, en zakte het invoervak uit de
  rij.
- De agendaknoppen staan naast elkaar, rechts in de kop.

### Kleinere schermen

- **Tablet (tot 900px):** dezelfde indeling, maar de titel krijgt een eigen rij
  en status en prioriteit delen de volgende. Een zesde van de breedte is daar
  te smal voor een keuzelijst ("Normaal" viel er net af).
- **Telefoon (tot 760px):** één kolom. Alleen status en prioriteit staan naast
  elkaar: kort, en zonder uitleg eronder.

Het ticket- en projectvenster zijn niet veranderd.

## Hoe het gebouwd is

- `src/main.tsx`: het taakformulier krijgt `FormGrid className="task-form-grid"`
  en per veld een breedteklasse (`tf-title`, `tf-narrow`, `tf-half`, `tf-wide`,
  `tf-third`, `tf-description`). `Field` kan daarvoor een `className` krijgen.
  Een veld zonder klasse is volle breedte.
- `src/styles/globals.css`: de regels bij `.task-form-grid`, en
  `.task-detail-editor` in één kolom. De oude regel die subtaken en comments
  pas onder de 900px onder elkaar zette, is weg.

## Getest

- Schermafdrukken tegen de nagebootste backend (`tests/mobile/mock`) van
  **Nieuwe taak** op desktop (1440), tablet (820) en telefoon (390), licht en
  donker, en van **Taak bewerken** op laptop (1280) en telefoon. Nergens loopt
  het venster zijwaarts over.
- `npm run typecheck`: schoon.
- `npm run test:mobile -- --theme=both`: 950 pagina's gemeten, 0 met problemen.
- `npm test`: 2285 geslaagd, 12 mislukt. Dat zijn de bekende fouten op Windows:
  tests die in een bronbestand zoeken naar `\n` terwijl daar `\r\n` staat. Ze
  lezen geen van de gewijzigde bestanden.
