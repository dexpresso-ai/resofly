# Mobiele lay-outtest

`npm run test:mobile` opent elke pagina van de werkruimte in Chromium op
telefoon- (390×844), tablet- (820×1180) en liggend telefoonformaat
(740×360), tegen een nagebootste backend, en faalt op vijf dingen:

1. een JavaScript-fout bij het openen van de pagina;
2. horizontale overloop (de pagina of het werkblad scrolt zijwaarts);
3. te veel vaste chrome: titelbalk + werktabs + onderbalk boven 112px op
   de telefoon of 100px op de tablet;
4. een eerste échte item (klant, taak, ticket, factuur…) dat lager begint
   dan de grens in `FIRST_ITEM` in `run.mjs`. Dit is de meting waar de test
   om bestaat: nieuwe koppen, knoppenbalken of filters boven de inhoud
   trekken hem rood;
5. twee delen die naast elkaar horen (`apart` in `PAGES`) en ergens tijdens
   het scrollen toch over elkaar heen liggen. Een plakkend (sticky) deel
   schuift pas ergens overheen als je naar beneden scrolt, dus de test meet
   over de hele scrollhoogte.

Daarnaast meet hij een laptop (1280×800), alleen voor de pagina's die
daar een eigen stand hebben (`only` bij dat formaat). Documentopmaak heeft
daar twee kolommen; de tablet krijgt er één en desktop drie.

## Draaien

```bash
npx playwright install chromium   # eenmalig
npm run test:mobile
npm run test:mobile -- --theme=both --shots=tests/mobile/shots
npm run test:mobile -- --pages=dashboard,clients --viewports=phone
npm run test:mobile -- --look=zenit --theme=both
```

De test start zelf een Vite dev-server. Draait er al een, geef die mee met
`--url=http://localhost:5173/`.

Met `--look=zenit` meet hij de nieuwe voorkant (accountmenu → Probeer Zenit)
in plaats van Cockpit. Dezelfde grenzen, behalve waar Zenit bewust iets
anders bovenaan zet: dat staat in `FIRST_ITEM_BY_LOOK`.

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

Een pagina met een eigen backend krijgt `mock` (de opties van `installMock`)
en `shell` (het element waar de pagina op wacht). Zo meet de test de
inrichtingsstappen van een nieuwe organisatie (`inrichten-*`, sinds
2026-11-07): `installMock(context, { onboarding: true })` speelt een
organisatie na die nog moet worden ingericht, met bedrijfsgegevens, abonnement,
modules, Mollie en afronden in het geheugen. `tests/inrichten/run.mjs`
(`npm run test:inrichten`) klikt daarmee de hele weg door.
