# Gerrie noemt wat hij klaarzet bij de juiste naam (2026-11-14)

## Aanleiding

"Gerrie zegt heel vaak dat hij een conceptfactuur heeft klaargezet terwijl men
aan hem vraagt of hij een project of iets dergelijks aan wil maken."

## Wat er misging

1. **Eén terugvaltekst voor alles wat niet in de lijst stond.** Zet Gerrie in
   de chat iets klaar zonder er zelf een zin bij te schrijven, dan vult de
   server die zin in (`chatProposalText`). Dat was een keten van vergelijkingen
   met als laatste tak "Ik heb een conceptfactuur voor je klaargezet". Elf
   soorten voorstellen stonden niet in de keten en kregen die zin:
   - alles via de handelingenregistry (`propose_action`): een projectsjabloon
     maken of uitrollen, projectinstellingen, iets verwijderen, en de rest van
     de lange staart;
   - uren registreren;
   - een projectteam aanpassen of een taak toewijzen;
   - een contactpersoon toevoegen of wijzigen;
   - een agenda-item wijzigen of afzeggen;
   - een mail aan klanten;
   - een nieuwe agent.
2. **De verkeerde zin bleef in het gesprek staan.** Het antwoord wordt
   opgeslagen en bij de volgende vraag teruggelezen. Het model las dan dat het
   een factuur had klaargezet toen er om een project gevraagd werd, en ging die
   zin zelf herhalen. Bij het teruglezen kreeg alleen een klant, factuur of
   offerte een notitie over wat er klaarstond; bij de rest stond er niets.
3. **De instructie aan het model wees één kant op.** "Benoem wat je hebt
   klaargezet (factuur, offerte of klant)" noemde alleen die drie als voorbeeld.
4. **Wat er klaarstond, bleef soms onbenoemd.** Schreef Gerrie in een eerdere
   ronde "Even het project opzoeken." en zette hij daarna zonder tekst iets
   klaar, dan bleef het bij die eerste zin. De server vulde alleen iets aan als
   er nog helemaal niets stond.

## Wat er nu klopt

- **Elk soort voorstel heeft een eigen zin**, in
  `supabase/functions/_shared/gerrieProposalText.ts`. Bij een handeling uit de
  registry gebruikt Gerrie de titel die de registry schrijft ("Ik heb dit voor
  je klaargezet — Projectsjabloon aanmaken: Website."), met "Let op: dit kun je
  niet terugdraaien" bij een onomkeerbare handeling. Uren: "Wil je dat ik 1 uur
  en 30 minuten registreer op project "Website"?". Enzovoort.
- **Een nieuw soort voorstel kan niet meer stil terugvallen.** De switch is
  uitputtend: zonder zin geeft `deno check` een typefout. De test vergelijkt
  daarnaast de soorten in `type Proposal` met de zinnen. Een vorm die de code
  niet kent (een oud gesprek), krijgt een neutrale zin zonder "factuur".
- **Het gesprek onthoudt wat er klaarstond.** Bij een gelukt voorstel bewaart
  de chat de omschrijving in `tool_calls` (`summary`, bijvoorbeeld "project
  Website"). Bij het teruglezen staat die als notitie onder het antwoord. Oude
  berichten krijgen de naam van de tool ("project aanmaken").
- **Oude gesprekken worden rechtgezet bij het teruglezen.** Staat de oude
  factuurzin onder iets anders dan een factuur, dan valt hij weg en blijft
  alleen de juiste notitie over. In de database verandert niets.
- **De instructie aan het model** noemt nu project, taak, uren, agent en de
  handelingen uit de registry. Een factuur heet alleen een factuur als het er
  een is, "ook als je dat eerder in het gesprek anders zei".
- **Schrijft het model in de ronde van het voorstel geen tekst**, dan zet de
  server de juiste zin eronder, ook als er al tekst uit een eerdere ronde
  staat.

Geplande agents gebruiken deze zinnen niet. Zij sluiten af met een samenvatting
uit `describeProposal`, en die noemde elk soort al bij zijn naam.

## Getest

- `node --test supabase/functions/_shared/gerrieProposalText.test.ts`: 22
  tests. Elke soort uit `type Proposal` heeft een zin. De elf soorten die
  terugvielen, noemen hun eigen naam en nergens "factuur". Een factuur heet nog
  een factuur, met de klant erbij. Oude gesprekken worden goed teruggelezen.
- `npm test`: 1797 tests, allemaal groen. `npm run typecheck`: schoon.
- `deno check` kon in de cloudsessie de imports van esm.sh niet ophalen. De
  edge functions zijn daarom met `tsc` en een shim voor de Deno-imports
  nagelopen; de lijst met fouten is voor en na de wijziging gelijk (alleen
  fouten van de shim zelf). De echte `deno check` draait in *Frontend checks*
  na de push.
