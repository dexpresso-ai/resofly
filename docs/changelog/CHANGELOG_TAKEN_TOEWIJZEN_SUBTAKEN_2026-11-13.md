# Projecttaken toewijzen aan een teamlid of jezelf, en spaties in subtaken — 13 november 2026

Vraag: *"Zorg ervoor dat ik een taak aan een specifiek teamlid of kan toekennen aan mezelf.
Gaat om taken van een project. Daarnaast wil ik dat er spaties gezet kunnen worden bij
specifieke subtaken."*

## Taken toewijzen

### Wat er misging

In het taakvenster van een projecttaak stonden alleen de leden van het projectteam. Was dat
team leeg, dan zag je alleen *"Nog geen teamleden aan dit project gekoppeld"* en kon je
niemand kiezen, ook jezelf niet. Je moest eerst naar het projectdashboard, het team vullen en
de taak opnieuw openen. Zat je zelf niet in het projectteam, dan kon je de taak niet aan jezelf
geven.

### Wat er nu kan

Onder **Toegewezen aan** in het taakvenster:

- **Het projectteam** staat er zoals eerst als knoppen. Tik een naam aan of uit.
- **Aan mij toewijzen**: één knop om de taak zelf te pakken. Hij verdwijnt zodra je erop staat.
- **Ander teamlid…**: een keuzelijst met de rest van het team. Daarin staat iedereen die
  Projecten mag zien. De boekhouder en uitgeschakelde leden staan er niet in, net als bij de
  accountlead en tickets (`membersWhoCanHold`).
- Kies je iemand die nog niet in het projectteam zit, dan staat eronder *"Bij opslaan ook in
  het projectteam: …"*. Bij opslaan komt die persoon in het team, en daarna op de taak.

Bij een taak zonder project staat iedereen die Projecten mag zien als knop. Eerst stond daar
het hele team, ook wie de module Projecten niet mag zien. Zo kon iemand een taak krijgen die
in de eigen app nergens te zien was.

In de takenlijst van het project (overzicht en kanban) stonden de toegewezenen al als
avatars. Daar is niets aan veranderd.

### Waarom het projectteam meegroeit

Het projectteam is het overzicht van wie er aan een project werkt. De database ruimt de
toewijzingen van iemand op als die persoon uit het team gaat
(`cleanup_task_assignees_on_member_removal`). Mocht je iedereen kiezen zonder het team aan te
vullen, dan klopte het team niet meer met wie er taken heeft. Daarom loopt elke toewijzing
langs één functie, `saveTaskAssignees` in `src/main.tsx`: eerst het team aanvullen, dan de
toewijzing. Die weg nemen:

- het taakvenster;
- slepen naar een collega in de teamweergave van de weekplanner;
- een toewijzing van Gerrie (`propose_task_assign`), nadat je die goedkeurt.

Zat iemand intussen al in het team, bijvoorbeeld net toegevoegd door een collega, dan is dat
geen fout (23505 wordt overgeslagen).

Er is geen migratie nodig. De database stond al toe dat elk lid van de organisatie een taak
krijgt. Alleen het scherm hield dat tegen.

### Een klik op de veldnaam

Het veld *Toegewezen aan* was een `<label>`. Een label stuurt een klik op de veldnaam of de
uitleg door naar de eerste knop erin. Een klik op *"Toegewezen aan"* zette zo het eerste
teamlid aan of uit, en met de nieuwe knop had je de taak per ongeluk aan jezelf gegeven. Het
veld is nu een groep (`Field` met `group`), zonder die doorstuurklik.

## Spaties in subtaken

### Wat er misging

Typte je in het taakvenster een subtaak van twee woorden, dan verdween de spatie meteen. Bij
"feedback verwerken" kreeg je "feedbackverwerken". Het taakvenster zette de subtaken bij elke
toetsaanslag opnieuw in vorm (`normalizeSubtasks`), en daarbij ging `trim()` over de tekst. De
spatie die je net typte stond aan het eind en ging er dus direct af.

### Wat er nu gebeurt

- Tijdens het typen blijft de tekst precies zoals je hem typt.
- Bij opslaan gaan de spaties voor en achter de tekst eraf. Lege subtaken verdwijnen
  (`subtasksForSave`). Spaties tussen de woorden blijven staan.

Beide functies staan nu in `src/lib/subtasks.ts`. De subtaken in projectsjablonen hadden dit
probleem niet: daar werd niet tijdens het typen getrimd.

## Gerrie

De beschrijving van *Projectteam van een project bekijken* zei dat je in het taakformulier
alleen het projectteam kon kiezen. Nu staat erin dat je iedereen kunt kiezen en dat het team
meegroeit. Bij `propose_task_assign` staat erbij dat wie nog niet in het projectteam zit er na
goedkeuring bij komt.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 1733 van 1733 groen. Nieuw:
  - `src/lib/subtasks.test.ts` doet het typen letter voor letter na. Met de oude code komt er
    "feedbackverwerken" uit, met de nieuwe "feedback verwerken".
  - In `src/lib/members.test.ts` staan tests voor de keuze (`taskAssigneeChoices`) en voor wie
    er bij opslaan in het team komt (`projectTeamAdditions`).
- In de browser, tegen de nagebootste backend, op desktop en telefoon, met een projecttaak
  met een leeg projectteam:
  - geen doodlopende melding;
  - "Aan mij toewijzen" werkt;
  - een klik op de veldnaam wijst niets toe;
  - Sanne kiezen via "Ander teamlid…" werkt;
  - "feedback verwerken" laat zich typen;
  - bij opslaan gaan eerst twee rijen naar `project_members`, daarna twee naar
    `task_assignees`, en de subtaak komt in de database als "feedback verwerken";
  - niets loopt zijwaarts uit beeld en er zijn geen JavaScript-fouten.
- `npm run test:mobile -- --theme=both`: zie het commitbericht.
- `deno check` van de edge functions kon in deze sessie niet draaien: deno.land en esm.sh zijn
  hier niet bereikbaar. De wijziging daar is alleen tekst in twee beschrijvingen. De workflow
  *Frontend checks* draait de controle bij de push naar `staging`.
