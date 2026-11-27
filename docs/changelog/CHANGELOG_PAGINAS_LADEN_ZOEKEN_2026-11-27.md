# Pagina's: laden zonder tekst, zoeken in de database (2026-11-27)

Stap 1A-2 van het bouwplan voor pagina's (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§6 en §18). Het opstarten van de app wordt lichter, en zoeken in de tekst gaat via de
database. Dat is nodig voordat pagina's met tabellen en afbeeldingen erbij komen.

## Wat er nu kan of klopt

- **De app laadt documenten zonder hun tekst.** Bij het opstarten komt alleen mee wat de
  verkenner en de lijsten nodig hebben: titel, soort, plek, data en de korte tekst
  (`excerpt`, die de database bijhoudt). De lijst staat in `src/lib/documentColumns.ts`, en
  een test bewaakt dat `content` en `body` er niet in komen. Voorheen laadde elke start de
  volledige tekst van alle documenten.
- **Openen haalt de tekst op**, en altijd vers uit de database, ook als er nog een oude kopie
  in het geheugen staat. Dat geldt voor de editor en voor "Bewerk als Word". Opent een
  document vanuit de zoekbalk, dan gaat dat langs dezelfde weg. Een Word-document opent dan
  meteen in de Word-editor; voorheen opende het daar het verkeerde venster.
- **Een vangnet bij opslaan.** Is de tekst van een document niet geladen, dan schrijft
  opslaan hem ook niet. Anders zou opslaan hem wissen.
- **De kaarten en de lijst bij een klant of project** tonen de korte tekst, als platte
  tekst.
- **De zoekbalk** vindt documenten op de titel en de korte tekst, meteen. Een woord dat
  alleen dieper in de tekst staat, vraagt de zoekbalk na 200 milliseconden aan de database
  (`search_documents`). Die zoekt met het begin van elk woord ("koff" vindt "Koffie") en
  met de rechten van wie zoekt.
- **Lukt het laden met de nieuwe kolommen niet**, omdat de database even ouder is dan de
  app (net na een uitrol), dan laadt de app zoals vroeger alles. Er gaat dus niets stuk
  als de app eerder klaar is dan de migratie.

## Bewust zo gelaten

- **Gerrie zoekt zoals voorheen** (`content.search`, met `ilike` in titel en tekst, op de
  server). Dat hangt niet af van wat de app laadt, en geeft een stukje tekst rond de
  treffer terug. `search_documents` geeft alleen de korte tekst. Omzetten kan later, als
  dat stukje rond de treffer ook uit de database kan komen.
- **Zoeken in de verkenner** ("Zoeken in deze map") kijkt bij documenten naar de titel en
  de korte tekst. Voor de volledige tekst is de zoekbalk.

## Getest

- `src/lib/documentColumns.test.ts`: de kern laadt geen `content` en geen `body`, en elke
  kolom bestaat in de migraties.
- `tests/stromen/ui.mjs documenten`, 10 stappen, waarvan één nieuw. Die zoekt een woord dat
  alleen na de eerste 200 tekens staat, dus niet in de korte tekst: de database vindt het,
  en de editor opent met de hele tekst. De bestaande stappen (nieuw, openen, titel
  aanpassen en opslaan, verwijderen, de kijker) zijn groen.
- `tests/stromen/documenten.mjs` (48 stappen), `npm run test:loading` (alle controles),
  `npm test` (2319), `npm run typecheck`, en `npm run test:mobile -- --theme=both` voor de
  vier Inhoud-pagina's.
