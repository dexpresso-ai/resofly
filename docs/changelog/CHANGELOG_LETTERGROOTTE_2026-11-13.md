# Changelog — Kleinere letters in de werkruimte, zoals in de agenda — 2026-11-13

## Aanleiding

> Lettertype overall, zeker op smartphone mag een stukje kleiner, zoals bij agenda.
> Dit voor meer overzicht.

## Wat er mis was

De stijlbladen hebben ruim 2.400 vaste lettergroottes in px, verspreid over veertien bestanden.
Er was geen knop om ze samen kleiner te zetten. Met de hand zou dat een diff van duizenden regels
zijn, en elke nieuwe regel zou weer op de oude maat beginnen.

## Wat er nu is

Elke lettergrootte schaalt mee met één variabele, `--letter`:

| Waar | `--letter` | 14px wordt | 13px wordt | 12px wordt | 11px wordt |
| --- | --- | --- | --- | --- | --- |
| Werkruimte, tablet en bureaublad | .95 | 13,3px | 12,4px | 11,4px | 10,5px |
| Werkruimte, telefoon (tot 760px) | .9 | 12,6px | 11,7px | 10,8px | 10px |
| Agenda en tijdrooster | 1 | 14px | 13px | 12px | 11px |
| Klantportaal, publieke pagina's, inloggen | 1 (geen variabele) | 14px | 13px | 12px | 11px |

- **De agenda blijft zoals hij was.** Die was het voorbeeld. Dat geldt ook voor het tijdrooster
  in de weekplanner en bij boekingslinks (`.tb-scroll`): het is hetzelfde rooster.
- **Niets gaat onder de 10px.** Tekst die al 10px of kleiner was, blijft staan. Kleiner is op
  een telefoon niet meer te lezen.
- **Invoervelden blijven 16px op de telefoon.** Onder de 16px zoomt iOS het hele scherm in zodra
  je een veld aanraakt. Een veld met een letter van 16px of meer schaalt daarom niet mee.
- **Knoppen zonder eigen maat** kregen de maat van de browser (13,33px). Die schaalde niet mee:
  de bedragen in het klantdossier bleven groot terwijl alles eromheen kromp. Die maat staat nu
  uitgeschreven in `globals.css`.

Gemeten op de telefoon (390×844), gemiddelde lettergrootte van de tekst in beeld:

| Pagina | Vóór | Na |
| --- | --- | --- |
| Agenda | 10,6px | 10,6px |
| Dashboard | 10,6px | 10,1px |
| Klanten | 11,1px | 10,3px |
| Tickets | 11,7px | 10,7px |
| Facturen | 11,4px | 10,4px |
| Klantdossier | 11,8px | 10,9px |
| Berichten | 12,6px | 11,4px |
| Instellingen | 12,0px | 10,9px |

## Hoe het werkt

Een PostCSS-plugin in `vite.config.ts` (`src/lib/letterSchaal.ts`) herschrijft bij het bouwen elke
`font-size` en de maat in `font`:

```css
font-size:12px   →   font-size:max(10px, calc(12px * var(--letter, 1)))
```

De waarden van `--letter` staan bovenin `src/styles/globals.css`, in de sectie "Lettergrootte".
Je schrijft dus gewoon `font-size:12px`. Hoe groot dat uitvalt, regel je daar.

Wat de plugin laat staan: em en %, die hun ouder al volgen; `clamp()`, `var()` en andere
functies, waar de maat bewust gekozen is; printregels.

Wat niet meeschaalt, omdat het geen CSS is: `fontSize` in een `style={…}` in de componenten
(vooral `Contracts.tsx`) en tekst in SVG-grafieken.

Het CSS-bestand wordt 3,4 kB groter na gzip (+1,6%).

## Bestanden

- `src/lib/letterSchaal.ts`: de plugin, met `letterSchaal.test.ts`.
- `vite.config.ts`: de plugin in `css.postcss`.
- `src/styles/globals.css`: de sectie "Lettergrootte" bovenaan, met `--letter` en de knoppen.

## Getest

- `npm run typecheck`, `npm test` (1738 groen, waarvan 5 nieuw voor de plugin).
- `npm run test:mobile -- --theme=both`: 614 pagina's, geen problemen. Elke pagina begint even
  hoog of hoger dan eerst.
- `npm run test:loading` en `npm run test:inrichten`: alle controles geslaagd.
- `vite build`: de plugin draait ook in de productiebouw, en de 16px-regels voor invoervelden
  staan er onveranderd in.
- Schermafbeeldingen op de telefoon, vóór en na: de agenda is gelijk, de rest is kleiner. Het
  zoekveld bij Klanten blijft 16px.
