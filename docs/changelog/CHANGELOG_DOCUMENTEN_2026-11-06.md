# Documenten — 6 november 2026

Na een uitgebreide test van de documenten (gebruik, werking en beveiliging).
Het volledige verslag staat in `docs/rapporten/TESTRAPPORT_DOCUMENTEN_2026-11-06.md`.

## Wat er verandert

**Voor de gebruiker**

- "Laatst gewijzigd" van een document klopt ook na bewerken via Gerrie, de API
  of de Word-editor. Daardoor staat een document weer op de juiste plek in de
  lijst.
- Een gedeeld Word-, Excel- of PowerPoint-document downloadt met zijn extensie
  ("Offerte.docx"), via de deellink en in het klantportaal.
- Na "Bewerk als Word" tonen lijst, zoeken en Gerrie niet langer de oude tekst.
  De tekst staat vanaf dat moment in het Word-bestand.
- Een teamlid dat Klanten niet mag zien, kan een notitie bij een klant weer
  opslaan. Dat geldt ook voor een document of klantmap.

**Opslag**

- Verwijder je een Word-document, een conceptcontract in Word of een klant of
  project met mappen, dan gaan de bestanden ook uit de opslag. Er zit één dag
  vangnet tussen, via de opruimwachtrij. Voorheen bleven ze voorgoed staan.
- Het opslagquotum is niet meer te omzeilen met een negatieve of absurde
  bestandsgrootte.

**Beveiliging**

- Een document, notitie of map kan alleen nog hangen aan een klant, project of
  map van de eigen organisatie.
- Bij delen lekt de naam van een klant van een andere organisatie niet meer
  via de foutmelding.
- De maker van een document, notitie, map of deling ligt vast. "Ingetrokken
  door" is altijd wie intrekt.
- Media-worker:
  - een bewaard editor-token werkt niet meer na het intrekken van rechten;
  - de PDF-omzetting neemt alleen contractbestanden aan;
  - een kapotte codering in een adres geeft geen serverfout meer.

## Uitrol

- **Database** (via staging): `20261106150000_inhoud_binnen_organisatie.sql` en
  `20261106160000_documenten_opslag.sql`. Op staging braken 0 rijen deze regels.
- **Edge functions** (via staging): `file-share-public`, `client-portal`,
  `file-transfer` (`officeDownloadName`).
- **App** (via Cloudflare Pages): `src/main.tsx`.
- **Media-worker: apart uitrollen.** `cd workers/media-api && npm run deploy:staging`.
  Daarvoor zijn Cloudflare-rechten nodig. Uitgerold op 6 november, versie `bf775db3`
  (zie `CHANGELOG_WORKERS_UITROL_2026-11-06.md`).
- **Opruimtaak.** `file-transfer-purge` stond niet ingepland op staging. Plan hem
  eenmalig in: workflow "Deploy Supabase (staging)" met het vinkje voor de
  webhooks. Zonder die taak:
  - blijft de opruimwachtrij staan;
  - worden verlopen zendingen niet opgeruimd.

## Getest

- `npm run test:stromen -- documenten`: maken, rechten per rol en module,
  andere organisaties, delen, opruimen. Vóór het herstel faalden de stappen
  voor koppelingen, maker, gewijzigd-datum en naamlek.
- `tests/stromen/ui.mjs documenten` in Chromium:
  - maken, bewerken en verwijderen;
  - kwaadaardige inhoud in de app en op de deelpagina;
  - de kijker.
- `tests/stromen/werker-documenten.mjs` tegen de worker in workerd: 16 stappen.
  Tegen de oude worker faalden er 4.
- De volledige stromentest (alle scenario's), `npm run typecheck`, `npm test`,
  `deno check` (CI-lijst) en `supabase db reset` (de keten vanaf nul).
