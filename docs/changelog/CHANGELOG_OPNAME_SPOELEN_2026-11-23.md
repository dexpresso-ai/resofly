# Opname van een meeting: je kunt er nu in spoelen (2026-11-23)

## Wat er mis was

Bij het beluisteren van een meeting-opname kon je niet naar het stuk dat je zocht.
Duurde de meeting een uur, dan moest je de opname ook een uur afluisteren.

## Oorzaak

De app neemt op met `MediaRecorder`. Die schrijft een webm-bestand **zonder duur en
zonder index**: tijdens het opnemen is nog niet bekend hoe lang het wordt. De
`<audio>` in de browser meldt dan `Infinity` als duur en heeft geen bereik om in te
spoelen, dus de tijdlijn in de speler blijft dood.

Dit is nagemaakt in echte Chromium, met een opname uit `MediaRecorder` met dezelfde
instellingen als de app:

| | Vóór | Ná |
| --- | --- | --- |
| `audio.duration` | `Infinity` | 20,4 s (een opname van 20 s) |
| spoelbaar bereik | leeg | 0 – 20,4 s |
| naar 12 s en afspelen | n.v.t. | gaat door vanaf 12 s (na 1,5 s afspelen op 13,5 s) |

## Wat er nu staat

- `src/lib/audioSeek.ts` (`makeSeekable`): zodra de speler zijn metadata heeft en de
  duur `Infinity` is, zoekt hij eenmalig naar een tijdstip ver voorbij het einde.
  Daarmee meet de browser het bestand door en wordt de duur een getal. Daarna zet
  de helper de speler terug op de plek waar hij was en hervat hij het afspelen als
  dat al liep.
- `src/components/MeetingRecorder.tsx`: de speler roept de helper aan bij
  `onLoadedMetadata`.
- Het staat **aan de afspeelkant** en niet bij het opnemen, dus ook de opnames die al
  bewaard zijn kun je nu doorspoelen. Er verandert niets aan wat naar R2 gaat.
- Lukt het meten niet (een andere browser, een kapot bestand), dan geeft de helper
  het op na 4 seconden. De speler werkt dan zoals voorheen.

## Getest

- `src/lib/audioSeek.test.ts`: oneindige duur wordt gemeten en de plek blijft waar
  hij was; een opname met duur blijft ongemoeid; wie al luistert gaat verder waar
  hij was; mislukt het meten, dan blijft hij niet hangen.
- Echte Chromium met een echte `MediaRecorder`-opname (zie de tabel hierboven).
- `npm run typecheck`, `npm test`, `npm run test:mobile -- --theme=both`.

## Niet gedaan

- Safari neemt op als mp4. Dat is hier niet in een echte Safari uitgeprobeerd. Meldt
  een opname daar toch geen duur, dan valt de speler terug op het oude gedrag.
