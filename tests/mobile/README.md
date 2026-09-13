# Mobiele lay-outtest

`npm run test:mobile` opent elke pagina van de werkruimte in Chromium op
telefoon- (390×844) en tabletformaat (820×1180), tegen een nagebootste
backend, en faalt op vier dingen:

1. een JavaScript-fout bij het openen van de pagina;
2. horizontale overloop (de pagina of het werkblad scrolt zijwaarts);
3. te veel vaste chrome: titelbalk + werktabs + onderbalk boven 112px op
   de telefoon of 100px op de tablet;
4. een eerste échte item (klant, taak, ticket, factuur…) dat lager begint
   dan de grens in `FIRST_ITEM` in `run.mjs`. Dit is de meting waar de test
   om bestaat: nieuwe koppen, knoppenbalken of filters boven de inhoud
   trekken hem rood.

## Draaien

```bash
npx playwright install chromium   # eenmalig
npm run test:mobile
npm run test:mobile -- --theme=both --shots=tests/mobile/shots
npm run test:mobile -- --pages=dashboard,clients --viewports=phone
```

De test start zelf een Vite dev-server. Draait er al een, geef die mee met
`--url=http://localhost:5173/`.

## Hoe de mock werkt

`mock/backend.mjs` vangt met Playwright alle verkeer naar
`example.supabase.co` af en beantwoordt het uit `mock/seed.mjs`: één
organisatie met klanten, projecten, taken, tickets, offertes, facturen,
uren en agenda-items, allemaal relatief aan vandaag. Voor de sessie staat
een nagebootste Supabase-token in `localStorage`, plus het tabblad dat de
pagina moet openen.

Een nieuwe pagina toevoegen: zet hem in `PAGES`, en als hij een lijst toont
ook in `FIRST_ITEM` met de selector van het eerste item en de grens die
ongeveer 20% boven de huidige meting ligt.
