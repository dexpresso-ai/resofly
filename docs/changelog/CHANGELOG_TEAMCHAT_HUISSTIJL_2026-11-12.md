# Teamchat: de eigen look & feel van ResoFly — 2026-11-12

Sinds 13 oktober had de teamchat de opbouw én het uiterlijk van Microsoft Teams
(zie `CHANGELOG_TEAMCHAT_TEAMS_2026-10-13.md`). De functies werkten goed, maar de
chat las als een ingebouwd ander programma: een tweede rail naast het zijmenu,
Teams-paars, lavendel bellen, de statusbadges van Teams en een onderdeel dat
letterlijk "Teams" heette. Nu spreekt de chat dezelfde taal als de rest van
ResoFly (de standaardlook Baken). **Alle functies zijn gebleven**; alleen de
vorm en een paar woorden zijn veranderd.

## Wat je ziet

**De opbouw**
- **Geen app-rail meer.** Activiteit, Chat, Kanalen, Bestanden en Opgeslagen
  staan bovenaan in een **keuzestrook**, zoals elke keuzestrook in ResoFly
  (Mijn/Team, Kaarten/Tabel). Wat op je wacht staat erin als een gouden pil.
- Rechtsboven **je status in woorden**: avatar, voornaam en "Beschikbaar" (of je
  statusbericht). Een klik opent het statusmenu, zoals voorheen de avatar
  onderaan de rail.
- Lijst en gesprek zijn **twee kaarten** op het werkvlak, met ronde hoeken en
  zachte schaduw, net als de pagina Gesprekken van Gerrie.
- Op de telefoon en in het zwevende paneel dezelfde strook, alleen iconen; het
  gekozen onderdeel staat er met zijn naam bij. Zo past hij naast je avatar.
- Een smal venster (tablet, of de browser naast iets anders): eerst verdwijnt
  je status in woorden, daarna de namen van de niet-gekozen onderdelen.

**De kleuren: zongoud en nachtgrafiet**
- **Goud** staat waar het in heel ResoFly staat: op de hoofdactie (versturen,
  een nieuw bericht in een kanaal, Deelnemen), op de plek waar je bent (het
  gekozen gesprek krijgt een gouden streep die gloeit, zoals in het zijmenu) en
  op wat op je wacht (ongelezen-tellers, de regel **Nieuwe berichten**, wie jou
  noemt).
- **Jouw berichten** zijn nachtgrafiet met één gouden lamp linksboven: het
  commandovlak van ResoFly in het klein. Die van anderen liggen als witte
  kaarten (op Nacht grafiet) op het werkvlak. Zo zie je in beide thema's in één
  oog wat van jou is. Citaten, bijlagen en vergaderkaarten in je eigen bericht
  krijgen vanzelf de lichte inkt van dat vlak.
- **Rood** is alleen nog voor wat dringend of belangrijk is, en voor verwijderen.

**De berichten**
- Bellen met ronde hoeken (18px) en een spreekhoekje aan de kant van de
  afzender.
- De dag staat als label op een haarlijn; **Nieuwe berichten** is een gouden
  pil in plaats van een rode streep.
- **Wie jou noemt**: een gouden ring om het bericht en een gouden @. Je eigen
  naam in de tekst is gemarkeerd.
- **Dringend** en **Belangrijk** als een rood label in gewone zinsvorm
  (was: "DRINGEND!"), met een rode ring om het bericht. Is iets dringend én voor
  jou, dan wint het rood.
- De **zweefbalk** staat bij andermans bericht rechtsboven en bij dat van jou
  linksboven, zodat hij naar het midden van het gesprek wijst.
- **Zes eigen snelle reacties**: 👍 Akkoord, ✅ Gedaan, 👀 Ik kijk ernaar,
  ❤️ Hart, 😄 Lach, 🎉 Feest. Eerst stond hier het rijtje van Teams (duim, hart,
  lach, verbaasd, verdrietig, boos); daarmee kon je wel iets voelen, maar niet
  afvinken. Alle andere emoji staan nog in de kiezer, en bestaande reacties
  blijven staan.

**Kanalen**
- Het onderdeel heet nu **Kanalen** (was: "Teams"), met een #-icoon.
- In een post hangen de antwoorden aan een **haarlijn met een bolletje per
  antwoord**, zoals de tijdlijn van een ticket. Een antwoord dat jou noemt heeft
  een gouden bolletje.
- **Nieuw bericht** is de gouden hoofdknop.
- **Vastgemaakt** staat als gouden strook onder de kop.

**De rest**
- **Statuslampjes** in de kleuren van de app (groen, rood, oranje, een open ring
  voor offline). Alleen "Niet storen" houdt zijn streepje. De vinkjes, klokjes
  en kruisjes van Teams waren op 10px niet te lezen.
- **Chat · Gedeeld** in de kop is een keuzestrook in plaats van tabbladen met
  een streep. Op de telefoon staat hij op een eigen regel, over de hele breedte.
- **Vergaderen** is een ronde knop met een gouden camera.
- De **opsteller** is een afgeronde kaart; versturen is een rond, gouden baken
  zodra er iets te sturen is. Bij focus een zachte gouden ring (zachter dan bij
  een gewoon veld: de opsteller heeft bijna altijd de focus).
- Kopjes in lijsten en menu's (Vastgemaakt, Recent, Bezorgopties) in kleine
  kapitalen, zoals de bovenregels elders in ResoFly.
- Velden, menu's, dialogen en meldingen hebben de vormen van de app:
  bediening 10–12px, kaarten 18px, vensters 22px, en overal de gouden focusring.
- Een melding bij een nieuw bericht (rechtsonder) heeft een gouden streep, rood
  als het dringend of belangrijk is. De teller op de chatknop rechtsonder is een
  gouden pil.

## Wat er in de code veranderd is

- `src/styles/teamchat.css` is herschreven. Alles hangt aan de app-tokens
  (`--accent`, `--surface`, `--ink`, `--line` …), dus Dag, Nacht en elke look
  kloppen vanzelf. De chat-tokens (`--tc-*`) verwijzen daarnaar.
- `Panes.tsx`: `Rail` is vervangen door `ViewSwitch` (de keuzestrook, met
  `compact` voor telefoon en paneel). `StatusButton` kan zijn status in woorden
  tonen (`withLabel`) en opent waar je hem neerzet (`placement`). Het label van
  het onderdeel `teams` is "Kanalen"; de sleutel `teams` blijft, want die staat
  in de sessieopslag.
- `ChatShell.tsx`: de volledige pagina is nu een kolom met de keuzestrook
  (`.tmc-topbar`) en daaronder de twee kaarten (`.tmc-stage`).
- `ui.tsx`: `PresenceBadge` tekent een lampje in plaats van de Teams-badges.
- `emoji.ts`: de zes snelle reacties.
- `Message.tsx`, `Composer.tsx`, `ChatShell.tsx`: "Dringend" en "Belangrijk" in
  zinsvorm.

## Getest

- `npm run typecheck`: geen fouten.
- `npm test`: 1723 tests, alle groen.
- `npm run test:mobile -- --theme=both --pages=chat`: telefoon, tablet en
  liggend in Dag en Nacht groen (eerste gesprek op de telefoon op 235px,
  grens 260px).
- Met de nagebootste backend van de mobiele test bekeken op 1440×900 (Dag en
  Nacht): chat, groepschat, kanaal, activiteit en het zwevende paneel, en op de
  telefoon de lijst en een gesprek.
