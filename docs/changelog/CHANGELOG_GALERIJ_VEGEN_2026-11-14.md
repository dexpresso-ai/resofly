# Galerij: bladeren door vegen op een aanraakscherm (2026-11-14)

## Aanleiding

Een foto die je in een album groot opent (de lightbox) kon je alleen met de
pijltjes links en rechts verder bladeren. Op een telefoon of tablet zijn die
klein, ze zitten aan de rand van het scherm, en vegen is daar de beweging
die iedereen verwacht. Wie veegde, kreeg niets: de foto bleef staan.

## Wat er is veranderd

Dit geldt overal waar een album staat, want ze gebruiken allemaal dezelfde
kijker (`src/features/GalleryViewer.tsx`): de galerij in een project, de
presenteerstand, de Galerijen-tab in het klantportaal en de publieke deellink.

- **Vegen bladert.** Veeg naar links voor de volgende foto, naar rechts voor
  de vorige. Net als bij de pijltjes ga je na de laatste foto naar de eerste.
- **De foto volgt je vinger.** Tijdens het vegen schuift de foto mee en
  vervaagt ze iets. Na het loslaten komt de nieuwe foto binnen van de kant
  waar je naartoe veegde.
- **Wanneer het bladert.** Ver genoeg slepen (een vijfde van de breedte, op
  een groot scherm hooguit 120 px), of kort en snel wegvegen. Een kleine of
  aarzelende beweging veert terug. Sleep je de foto ver weg en veeg je hem op
  het laatst terug, dan blijf je bij dezelfde foto.
- **Wat hetzelfde blijft:**
  - een tik op de zwarte rand sluit de foto;
  - de pijltjes, de knoppen in de balk en de toetsen werken zoals voorheen;
  - een veeg die op een knop of op de balk onder de foto begint, doet niets;
  - op en neer vegen bladert niet, en de pagina achter de foto schuift niet
    meer mee (dat gebeurde eerst wel);
  - knijpen om in te zoomen werkt nog, ook op de iPhone. Is de foto
    ingezoomd, dan schuif je met één vinger door de foto in plaats van te
    bladeren.
- **Diavoorstelling.** Vegen kan ook terwijl hij speelt; de tijd voor de
  volgende dia begint dan opnieuw.

## Hoe het werkt

- `src/lib/swipe.ts` bepaalt of een beweging een veeg is en of die
  doorbladert. Er zit geen React in, zodat `src/lib/swipe.test.ts` het in
  node test.
  - De snelheid telt alleen over de laatste 100 ms. Wie eerst stilhoudt en
    dan wegveegt, telt dus mee.
  - Ligt de vinger langer dan 50 ms stil voor het loslaten, dan is de
    snelheid 0.
  - Het loslaten zelf telt niet als meetpunt. Eerst deed het dat wel, en toen
    bleef een vlotte veeg van 50 px liggen: het loslaten meldt de laatste plek,
    maar later, en drukte zo de snelheid.
- `useSwipeToStep` in `GalleryViewer.tsx` hangt eigen touch-listeners aan de
  lightbox, en geen React-props of `touch-action`:
  - React hangt touchmove passief op, en dan werkt `preventDefault` niet;
  - `touch-action: pinch-zoom` kent Safari op de iPhone niet;
  - met `touch-action: none` kun je daar ook niet meer knijpen.

  Tijdens het slepen gaat de verschuiving rechtstreeks op het kader. Met
  React-state zou de hele galerij bij elke pixel opnieuw tekenen.
- De animaties staan in `src/styles/globals.css` (`.galv-swipe-next`,
  `.galv-swipe-prev`). Bij `prefers-reduced-motion` zet de app ze uit, net
  als de andere overgangen.

## Getest

- `npm run typecheck`, `npm test` (met de nieuwe `swipe.test.ts`) en
  `npm run test:mobile -- --theme=both`.
- In Chromium met echte touch-events (CDP), op telefoon- en tabletformaat,
  tegen de nagebootste publieke galerij (`/gallerij/demo-token`). Gecontroleerd:
  - naar links en naar rechts vegen bladert, ook rond het begin en het eind;
  - de foto volgt de vinger;
  - een kleine veeg veert terug;
  - een korte snelle veeg bladert, ook na eerst stilhouden;
  - terugvegen blijft staan;
  - een veeg over de zwarte rand bladert en sluit niet;
  - op en neer vegen bladert niet en laat de pagina staan;
  - knijpen bladert niet, en ingezoomd schuift één vinger door de foto;
  - het pijltje geeft de gewone overgang;
  - een tik op de zwarte rand sluit de foto;
  - er komen geen JavaScript-fouten.
- Niet getest op een echte iPhone of Android-telefoon. Het gedrag van Safari
  bij `preventDefault` op touchmove is wel standaard en al jaren hetzelfde.
