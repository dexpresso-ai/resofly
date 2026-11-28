# De PDF van een pagina inrichten (stap 1B-5)

Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §9, en
`docs/changelog/CHANGELOG_PAGINAS_PDF_2026-11-28.md`.

De PDF van een pagina komt langs twee onderdelen:

1. **De edge function `page-export`.** Die bouwt de Word-file met de rechten van wie exporteert.
   Ze rolt mee met een merge naar staging (de workflow *Deploy Supabase (staging)*).
2. **De media-worker** (`workers/media-api`), met het pad `/internal/office/convert-page`. Die
   stuurt de Word-file naar Collabora en geeft de PDF terug. Deze worker rol je **met de hand**
   uit; dat gebeurt niet bij een merge.

Zolang de worker het pad niet kent, zegt het exportvenster: "De PDF kan nog niet: de
media-worker moet eerst worden bijgewerkt. Word downloaden kan wel."

## Uitrollen op staging

Na de merge naar staging, vanaf je eigen computer, met wrangler ingelogd bij Cloudflare:

```bash
cd workers/media-api
```

```bash
npm install
```

```bash
npm run deploy:staging
```

## Nagaan of het werkt

De rooktest van *Deploy Supabase (staging)* kijkt na de merge al of `page-export` er staat
("page-export weigert zonder inlog"). De worker kijkt hij niet na; dat doe je zo:

1. Open op staging een pagina, kies **Exporteren**, en dan **PDF downloaden**. De eerste PDF na
   een pauze kan tot een minuut duren: Collabora start dan koud.
2. Kijk naar de PDF:
   - de letters van je huisstijl;
   - de tabellen en kaders;
   - de afbeeldingen;
   - de paginanummers.

   Met de opties: het voorblad, de inhoudsopgave en de hoofdstukken.
3. Kies **Vastleggen in het dossier** bij een pagina in een map. De PDF staat dan in die map, met
   de datum in de naam.

## Geheimen en instellingen

Er is niets nieuws nodig.

- **`page-export`** gebruikt `MEDIA_WORKER_URL` en `INTERNAL_UPLOAD_SECRET`, net als het
  klantportaal en de transcriptie.
- **De media-worker** gebruikt `COLLABORA_URL` en `OFFICE_CONVERT_SECRET`, net als de PDF van een
  contract. Het secret is gelijk aan dat op de office-server.

## Productie

Er is nog geen productie. Daar gaat het later net zo, met `npm run deploy` in plaats van
`npm run deploy:staging`.
