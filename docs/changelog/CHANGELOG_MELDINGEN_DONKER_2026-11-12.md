# Meldingen onderin: donker en goed leesbaar (2026-11-12)

## Aanleiding

"Op het moment dat je een notificatie krijgt om bijvoorbeeld een app te
installeren of dat de app geïnstalleerd is, dan is dat half doorzichtig zodat
het niet leesbaar is. Kun je die pop-up die onderin beeld verschijnt gewoon
donker maken zodat die duidelijk leesbaar is."

## Wat er mis was

De meldingen rechtsonder (`.email-toast`) hadden `--bg3` als achtergrond. Dat
token is een waas van 3 tot 5% wit, bedoeld als laag óp een kaart. Los boven de
pagina was de melding daardoor bijna doorzichtig: de agenda of lijst eronder
scheen erdoorheen en de tekst was niet te lezen. Dat gold in elke look, in
licht en donker.

De melding onderin het midden na het verplaatsen van mail (`.mf-notice`, met
Ongedaan maken) had dezelfde achtergrond en dus dezelfde kwaal.

## Wat er nu is

- **Eén dichte, donkere kaart** (`#1C1C21`) voor alle meldingen onderin, in
  elke look (Baken, Cockpit, Zenit, Stroom) en ook in het lichte thema:
  - Installeer ResoFly / ResoFly Agenda / Financiën / Communicatie;
  - nieuwe mail van een klant;
  - nieuwe activiteit op een ticket;
  - een nieuwe kaart op de beslislijst van Gerrie;
  - verplaatst naar een map, met Ongedaan maken.
- **Lichte tekst erop.** De titel is bijna wit, de uitleg lichtgrijs, het
  kruisje lichtgrijs. Het goud (icoon, Ongedaan maken, de knop Installeren)
  blijft goud. Een foutmelding is lichtrood in plaats van donkerrood.
- De meldingen van de teamchat hadden al een dichte achtergrond en zijn niet
  veranderd.

## Hoe

`src/styles/globals.css`, direct onder de `.email-toast`-regels: de achtergrond
en de inkt-tokens (`--text`, `--muted`, `--muted2`, `--bg4`, `--accent-ink`,
`--accent-r`, `--border2`) worden op de melding zelf opnieuw gezet. Dat moet
daar: deze tokens zijn op `:root` al tot de kleur van het thema uitgerekend,
dus op Dag zou anders donkere tekst op het donkere vlak staan.

## Getest

- Schermafdrukken van de installeermelding in `/app/agenda/` op telefoon
  (390×844) en laptop (1280×800), in alle vier de looks, licht en donker. De
  achtergrond is overal `rgb(28, 28, 33)`, de titel `rgb(244, 243, 240)`.
- `npm run typecheck`, `npm test`, `npm run test:mobile -- --theme=both`.
