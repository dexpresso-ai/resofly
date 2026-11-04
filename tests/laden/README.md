# Laden per module

`npm run test:loading` controleert in Chromium hoe de werkruimte zijn gegevens
laadt (`src/lib/dataGroups.ts`): de kern bij het opstarten, vijf groepen zware
tabellen pas als een pagina ze nodig heeft. De test draait tegen dezelfde
nagebootste backend als de mobiele lay-outtest (`tests/mobile/mock`) en kijkt
naar het netwerkverkeer en naar het scherm:

1. elke pagina haalt precies de groepen op die `PAGE_DATA_GROUPS` noemt; het
   dashboard alleen de twee tellingen;
2. daarna staat de pagina er: geen laadmelding, geen foutmelding, geen
   JavaScript-fout;
3. een geladen groep wordt bewaard, en na Verversen op de achtergrond ververst;
4. het ticketvenster laadt zelf de tijdlijn;
5. een groep die niet laadt, geeft een melding met "Opnieuw proberen".

```bash
npx playwright install chromium   # eenmalig
npm run test:loading
npm run test:loading -- --url=http://localhost:5173/
```

Een pagina krijgt een nieuwe groep: zet hem in `PAGE_DATA_GROUPS`. Deze test
leest die lijst zelf en verwacht dan ook die tabellen. Een nieuwe groep: zet
zijn tabellen in `GROUP_TABLES` bovenin `run.mjs`.
