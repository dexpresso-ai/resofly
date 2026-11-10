# Rapportages met Gerrie: je ziet hem bouwen (2026-11-10)

Een rapportage bouwen kost Gerrie soms een paar minuten. Tot nu toe stond er dan één
pulserend icoon met een regel tekst, en leek het alsof hij vastzat. Nu bouwt er een klein
dashboard zichzelf op terwijl Gerrie werkt, en zie je in welke stap hij is en hoe lang al.

## Wat er nu te zien is

- **Een nieuwe rapportage** toont een dashboard in opbouw. Het volgt wat Gerrie echt doet:
  1. *Vraag lezen*: een blauwdruk met lege vakken; het poollicht van Gerrie denkt na in het
     midden.
  2. *Gegevens ophalen*: de staven en cijfers rekenen, het licht vliegt langs de vakken.
  3. *Pagina bouwen*: de vakken vullen zich, de staven groeien, de lijn tekent zich en de
     tabelregels schuiven erin.
  4. *Controleren*: een lichtstraal loopt de pagina na.

  Eronder staan de vier stappen met een vinkje per afgeronde stap, wat Gerrie op dit moment
  doet ("Gegevens berekenen…", "Rapportage opbouwen… (8k tekens)") en een klok. Duurt het
  langer dan een minuut, dan zegt de pagina dat dat normaal is. Om de kaart loopt een komeet
  van poollicht.
- **Een bestaande rapportage aanpassen**: de pagina blijft staan, iets gedimd, met een
  lichtstraal eroverheen. Bovenaan staat een balk die meescrolt: "Gerrie past je rapportage
  aan", met de stap en de tijd. Is hij klaar, dan komt de nieuwe versie met een korte gloed
  tevoorschijn.
- **Ook als je ergens anders bent**:
  - het tabblad krijgt een draaiende ring om zijn icoon;
  - de rapportage in het menu krijgt een knipperend lichtje;
  - de kaart in het overzicht toont "Gerrie bouwt hem nu…" met dezelfde komeet.

  Verwijderen kan daar pas als Gerrie klaar is.
- **Minder beweging**: wie dat in het systeem aanzet, ziet alles stil. Het dashboard verandert
  wel per stap, dus je ziet nog steeds waar Gerrie is.

Alles volgt Dag en Nacht en de stijlen Cockpit, Baken, Zenit en Stroom. Er worden alleen
ResoFly-kleuren gebruikt, met het poollicht van Gerrie (`--ai-1..3`).

## Hoe het werkt

- **De stap komt uit de backend.** `gerrie-agent` stuurt bij elke statusmelding van een
  rapportage een vaste `step` mee: `lezen`, `gegevens`, `bouwen` of `controleren`
  (`supabase/functions/_shared/gerrieReports.ts`). Het label is schermtekst en verandert
  weleens; de animatie hangt daar niet van af. Een melding zonder stap ("Gerrie werkt
  verder…") laat de stap staan. Anders sprong de balk na elke opgehaalde dataset terug naar
  het begin. Keurt de controle een pagina af, dan gaat de stap wél terug, want dat is wat
  Gerrie dan doet. Zonder `step` (een oudere edge function) leest de app het label.
- `src/lib/reportBuild.ts`: de stappen, de klok en de geruststelling. Getest in
  `reportBuild.test.ts`.
- `src/components/ReportBuilding.tsx`: de opbouw en de balk bij aanpassen. De animatie is
  CSS (`src/styles/rapportages.css`, sectie "Gerrie bouwt").
- `src/lib/aiReports.ts`: de chatsessie houdt de stap bij. `useBuildingReports()` geeft de
  rapportages waar Gerrie nu aan werkt, voor de tabbalk, het menu en het overzicht.
- Bij de eerste opbouw krijgt het tabblad na een halve seconde het echte id, en wordt de
  pagina opnieuw gemaakt. De opbouw loopt dan door waar hij was: de klok en de animatie
  rekenen vanaf het begin van de vraag, niet vanaf het openen van de pagina.
- De lijngrafiek tekent zich met een veeg (`clip-path`), niet met `stroke-dashoffset`.
  Chrome negeert `pathLength` bij `vector-effect: non-scaling-stroke`, en toen kwam de lijn
  met gaten tevoorschijn.

## Getest

- `npm run typecheck` en `npm test`: 1492 tests, waarvan zes nieuw voor de stappen en de klok.
- `npm run test:mobile -- --theme=both`: twee nieuwe standen.
  - `report-building`: een nieuwe rapportage in opbouw.
  - `report-updating`: een bestaande rapportage die wordt aangepast; de test opent het gesprek
    op telefoon en tablet, stuurt een vraag en sluit het weer.

  De mock laat `report_chat` daarvoor openstaan. `prepare` kan nu een lijst stappen zijn
  (klikken of een veld invullen).
- Met een nagebootste stroom zijn alle vier de stappen nagelopen op laptop en telefoon, licht
  en donker, ook met minder beweging. Ook de afloop van een aanpassing: balk weg, nieuwe versie
  met gloed, gloed na 1,8 seconde weg, geen JavaScript-fouten.
- `npm run test:stromen -- rapportages` toetst nu ook dat de echte `gerrie-agent` de stappen in
  de goede volgorde meestuurt: lezen, gegevens, bouwen, controleren.
