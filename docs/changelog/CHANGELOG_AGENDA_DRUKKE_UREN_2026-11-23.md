# Agenda: bij meerdere afspraken in één uur zie en open je ze allemaal (2026-11-23)

## Wat de PO meldde

> Zodra ik in een agenda-item zit, of agenda-item zie op zowel de desktop als
> telefoon, dan kan het zijn dat ik meerdere afspraken in een uur heb en dan zie
> ik ergens 2 afspraken staan, maar dan zie ik ook een +2 van de andere
> afspraken die verborgen zijn. Maar die afspraken kan ik van die agenda dus
> niet openen.

## Wat er mis was

Het tijdrooster (Dag, 3 dagen en Week) zet hooguit **twee** afspraken naast
elkaar (`MAX_OVERLAP_COLS`); meer is in een kolom van een telefoon niet te
lezen. Valt er een derde afspraak over een groep heen, dan wordt die niet
getekend, en kwam er een chipje "+2" voor in de plaats. Dat chipje was alleen
een tekst: `pointer-events: none`, en een `div` zonder klik. Wie drie, vier of
vijf afspraken rond hetzelfde uur had, kon de verborgen afspraken dus nergens
meer zien of openen. Alleen verplaatsen of een andere weergave kiezen hielp.

De maandweergave had dit al goed (het "+N meer"-kaartje), en de balk met hele-dag-
afspraken klapt open. Alleen het tijdrooster miste de weg naar de rest.

## Wat er nu staat

- **Het "+N"-chipje is een knop.** Een klik of tik opent een kaartje naast het
  chipje met **alle** afspraken van dat moment onder elkaar: tijdvak, titel,
  een videocall-teken en de kleur van de agenda. Ook de twee die wel in het
  rooster staan staan erbij, zodat je het hele moment in één lijst ziet.
- **Elke regel opent de afspraak**, precies als een tik op het blok zelf (het
  detailpaneel). Taken met een tijdstip in de weekplanner staan er ook in en
  openen de taak.
- **Sluiten** kan met het kruisje, een tik of klik ernaast, Escape, en op de
  telefoon met de terugknop. Bladeren naar een andere periode sluit het ook.
- **Op de telefoon** is het chipje groter (tikvlak van ±28px), en leesbaarder:
  een gevuld vlak met een schaduw in plaats van doorschijnend op het blok.
- In de weergave **Dag** staat bovenin het kaartje alleen de dag; in **3 dagen**
  en **Week** is die dag een knop naar de dagweergave, zoals in de maand.

## Hoe het gebouwd is

- `layoutTimedItemsForDay` onthoudt nu per groep ook welke blokken erin zitten
  (`OverflowChip.items`); eerst alleen het aantal.
- Het zwevende kaartje van de maand is losgetrokken als `FloatingDayCard`
  (scrim, plaatsing naast de knop, Escape, terugknop, kop met de dag), zodat de
  maand (`MonthDayCard`) en het rooster (`OverflowCard`) dezelfde schil gebruiken
  en niet uit elkaar lopen.
- Het kaartje wordt opnieuw uit de actuele afspraken opgebouwd, niet uit een
  momentopname: ververst de agenda terwijl het openstaat, dan staat er niets
  verouderds in. Het hangt aan `document.body`: het podium van de agenda krijgt
  tijdens een veeg een `transform`, waarin een vast kaartje met het rooster
  meeschuift.
- Raakt `src/features/CalendarPage.tsx` en `src/styles/globals.css`. Geen
  migratie, geen edge function, geen nieuwe gegevens: het laden per module
  (`dataGroups`) verandert niet.

## Getest

Tegen de nagebootste backend van `tests/mobile` (zelfde opzet als de
lay-outtest), met op maandag 10:00 vijf afspraken die over elkaar vallen (twee
verborgen), op desktop (1280×800) en telefoon (390×844, aanraking):

- het chipje toont "+2" en heeft een tikvlak (28×20 op desktop, 34×28 op de
  telefoon);
- het kaartje toont alle vijf de afspraken, inclusief de twee verborgen;
- het kaartje past binnen het scherm;
- een verborgen afspraak aanklikken opent het detailpaneel met die afspraak, en
  sluit het kaartje;
- Escape en een klik naast het kaartje sluiten het;
- geen JavaScript-fouten.

Ook op de telefoon met de terugknop: terug sluit het kaartje en je blijft op de
agenda staan, en het kruisje sluit het ook. Samen 37 van 37 controles goed. De
controle zelf is een wegwerpscript en staat niet in de repo; de bestaande
terugknoptest kent dit kaartje niet.

Daarnaast de vaste controles uit `CLAUDE.md`:

- `npm run typecheck`: schoon;
- `npm test`: 2229 van 2229 geslaagd;
- `npm run test:mobile -- --theme=both`: 884 metingen, 0 problemen;
- `npm run test:terugknop`: 15 gelukt, 0 mislukt.

Niet gedraaid: `npm run test:loading` (er is geen pagina of gegevensgroep
bijgekomen) en de databasetests (geen migratie).

## Bekend

- Het kaartje komt naast het chipje te staan en kan het groepje afspraken in het
  rooster deels bedekken. Dat is bewust: je kiest er één, en het kaartje is weg.
- Het rooster zelf zet nog steeds hooguit twee afspraken naast elkaar. Meer
  kolommen in de dagweergave, waar de kolom breed genoeg is, is een aparte
  keuze en hier niet gedaan.
