# Changelog — Logo in elke mail, letters in de PDF, creditfactuur en aanmaning in de factuuropmaak — 2026-11-05

Tweede ronde op dezelfde dag als `CHANGELOG_DOCUMENTOPMAAK_HUISSTIJL_2026-11-05.md`. Daar stonden
deze drie punten nog onder *Niet gedaan*.

## Aanleiding

> Zorg ook voor het bedrijfslogo van de gebruikers in alle email communicatie. Voeg de template en
> logo ook toe op creditfacturen en aanmaningen. Zorg voor meerdere fontkeuzes die ook toepasbaar
> zijn via PDF.

Wat er was:

- **Geen enkele mail had een logo**, ook niet als de organisatie er een had ingesteld. Het logo staat
  als data-URL in de database, en een `<img src="data:…">` tonen Gmail en Outlook niet.
- **De creditfactuur en de aanmaning** hadden een eigen, vaste opmaak: geen logo, geen briefpapier,
  niet de opmaak die je voor je factuur had ingesteld.
- **Een PDF kende alleen Helvetica, Times en Courier.** Wie Poppins of Playfair als huisstijl had,
  kreeg op papier Helvetica of Times.

## Wat er is veranderd

### Het logo in elke mail

- **Hoe:** het logo gaat als bijlage mee met een Content-ID, en de mail verwijst ernaar met
  `<img src="cid:merklogo">` (Resend: `content_id` op een bijlage). Zo'n ingesloten afbeelding tonen
  de gangbare mailprogramma's meteen. Een link naar een afbeelding op internet houdt Outlook tegen
  tot de ontvanger op *Afbeeldingen downloaden* klikt; een data-URL tonen Gmail en Outlook nooit.
  Het logo hoeft dus niet ergens gehost te worden.
- **Waar het staat:**
  - bovenaan de donkere mailkaart (alle klantmails): de lichte versie uit Huisstijl als die er is,
    anders het gewone logo op een wit plaatje (de meeste logo's zijn donker op transparant en vallen
    weg op donker);
  - het logo komt in de plaats van de bovenregel met de bedrijfsnaam, net als op de klantpagina's.
    Een andere bovenregel ("Betalingsherinnering", "Aanmaning") blijft gewoon staan;
  - de vrije klantmail (een persoonlijk bericht, lichte kaart): onder de tekst, als een
    handtekening, in plaats van de naam;
  - de notulen van een afspraak en de agenda-uitnodigingen: bovenaan. De `.ics` blijft een gewone
    bijlage ernaast.
- **Maat:** binnen 200 × 56 px, in de verhouding van het beeld zelf. Die wordt uit de kop van de PNG
  of JPEG gelezen; Outlook negeert een maat in CSS, dus breedte en hoogte staan als attribuut.
  Alleen PNG en JPEG: Outlook toont geen WebP (de logo-upload zet WebP al om naar JPEG).
- **Welke mails:** offerte, factuur, betalingsherinneringen, aanmaning, creditfactuur, contract
  (versturen, bevestiging aan de klant, melding aan het eigen adres), bestanden delen,
  bestandszending en de toegangscode, boekingslink en boekingsbevestiging, ticketmeldingen uit het
  portaal, welkomstmail van het portaal, teamuitnodiging, de Resend-testmail, de vrije klantmail,
  campagnes en reeksen (ook hun testmail), notulen, agenda-uitnodigingen en -annuleringen.
- **E-factuur:** de factuur naar een e-factuuradres krijgt het logo ook. Boekhoudpakketten slaan
  ingesloten afbeeldingen over (zoals onze eigen inbox, `mail-inbound`); het blijft bij de PDF en de
  UBL.
- **Laden:** een eigen, kleine query per mail (`loadEmailBrand`), gefilterd op de organisatie uit de
  sessie, het token of de eigen rij. Waar de huisstijlrij al geladen is (`portal-notify`,
  `file-transfer-public`) zonder extra query; bij campagnes, reeksen, zendingen, notulen en
  uitnodigingen één keer per batch in plaats van per ontvanger.
- **Gooit nooit:** geen logo, een logo dat niet te lezen is, of een kolom die nog niet bestaat: dan
  gaat de mail zoals vroeger, met de naam als bovenregel.
- **Hoe het in elkaar zit:** de sjablonen zetten alleen een merkteken (een HTML-commentaar) waar het
  logo hoort (`EMAIL_LOGO_SLOT_DARK`, `_LIGHT`, `_SIGNATURE` in `emailTemplates/layout.ts`);
  `_shared/emailBrand.ts` vult het vlak voor het versturen in (`withEmailBrand(payload, brand)`).
  Vergeet een nieuwe route dat, dan gaat de mail zonder logo maar heel de deur uit — en faalt
  `emailBrand.test.ts`, die elke verzendroute naloopt.
- **In de app:** het voorbeeld bij Instellingen → E-mail toont het logo zoals bovenaan de mail; de
  teksten bij Huisstijl zeggen nu dat je e-mails je logo krijgen.

### Letters in de PDF

- **Twaalf letters:** Poppins, Inter, Jost, Space Grotesk, DM Sans, Playfair Display, Cormorant
  Garamond, Lora en Bebas Neue (alleen voor koppen: alles in kapitalen), plus Helvetica, Times en
  Courier.
- **Per opmaak twee keuzes** in Instellingen → Documentopmaak: *Letter voor koppen* en *Letter voor
  tekst*. *Zoals je huisstijl* volgt de letters uit Huisstijl. Een opmaak van vóór vandaag met één
  letter krijgt die voor allebei.
- **Ingesloten in de PDF**, dus de klant ziet ze ook zonder ze zelf te hebben. WOFF-bestanden met de
  Latijnse tekens (fontsource 5.3.0, SIL Open Font License; zie `public/fonts/pdf/LICENTIES.md`):
  in `public/fonts/pdf` voor de app, als base64 in `_shared/pdfFonts.ts` voor de server.
  `scripts/pdf-lettertypen.mjs` maakt beide. Een factuur met twee ingesloten letters is ~18 kB.
- In de app laadt `@pdf-lib/fontkit` pas als er een PDF gemaakt wordt, als eigen stukje van de
  bundel. De server zet elk bestand één keer per instantie om.
- **Tekens die een letter niet heeft** (Š, ž, ƒ in een letter zonder die tekens) worden vervangen
  door de gewone letter of weggelaten, in plaats van dat de PDF mislukt.
- **Lukt inladen niet** (offline, een kapot bestand), dan tekent de PDF met de standaardletter en een
  waarschuwing in het log. Nooit geen PDF.

### Creditfactuur en aanmaning in de factuuropmaak

- Beide gebruiken de opmaak, het logo, het briefpapier en de letters van je factuur.
- **Creditfactuur:** de bedragen komen uit de opgeslagen creditnota (positief opgeslagen, negatief op
  papier). De btw per tarief alleen als die precies uitkomt op de opgeslagen bedragen. Met
  *Creditfactuurnummer*, de factuur waar hij bij hoort, *Totaal credit*, de reden en wat er nu
  gebeurt ("Dit bedrag wordt aan u terugbetaald", of: de factuur vervalt en er hoeft niets meer
  betaald te worden).
- **Aanmaning:** de brief zelf ligt vast, met de wettelijke teksten letterlijk zoals ze waren (14
  dagen, incassokosten, wettelijke rente). Kop, voet, logo en stijl komen van de factuur.
- In Documentopmaak kun je beide bekijken (*Creditfactuur*, *Aanmaning*), met de melding dat ze de
  opmaak van de factuur volgen.

## Niet gedaan (bewust, of voor later)

- **De inloglinks** van het portaal en de app komen van Supabase Auth, met een sjabloon voor het hele
  platform. Een logo per organisatie kan daar alleen met een eigen *send email*-hook.
- **Twee interne berichten** blijven kaal: het rapport van een Gerrie-agent aan de eigenaar (met de
  afzender van het platform, niet van de organisatie) en de melding van een nieuwe boeking aan de
  eigenaar van de boekingslink.
- **Donkere modus in mailprogramma's:** keert een programma de kleuren om (de Gmail-app), dan kan een
  donker logo op transparant wegvallen op een licht vlak dat donker wordt. Het witte plaatje op de
  donkere kaart dekt het gewone geval.
- **Niet tegen de echte Resend getest:** resend.com is vanuit de cloudsessie niet bereikbaar. Het
  veld `content_id` komt uit de documentatie van Resend. Eerste controle op staging: Instellingen →
  E-mail → *Verstuur testmail*; die heeft nu het logo.

## Getest

- `npm run typecheck` schoon.
- `npm test`: 1002 groen. Nieuw: `supabase/functions/_shared/emailBrand.test.ts` (13 tests: maat uit
  PNG en JPEG, WebP en rommel geven geen logo, plaatje of lichte versie op de donkere kaart, de naam
  vervalt maar een andere bovenregel niet, zonder logo de mail zoals vroeger, alle klantsjablonen
  krijgen precies één logo, handtekening en lichte kaart, alleen het eerste merkteken telt,
  bijlagen achter de bestaande, elke verzendroute vult het logo in). `documentLayout.test.ts` (23
  tests) dekt de letters, de creditfactuur en de aanmaning, met de echte fontkit en de echte
  bestanden.
- `deno check`: alle aangeraakte functies uit de CI-lijst schoon (campaigns, contract-public,
  contract-workflow, file-share, file-transfer, file-transfer-public, mail, meeting-booking,
  meeting-booking-public, meeting-transcribe, portal-notify, calendar-integrations,
  gerrie-agent-runner) en de gedeelde modules. `invoice-workflow` en `quote-workflow` (buiten de
  lijst) hebben dezelfde 12 en 9 bestaande meldingen als staging. Lokaal met een import map naar
  dezelfde npm-pakketten; esm.sh is vanuit de cloudsessie niet bereikbaar.
- Mobiele lay-outtest (`--theme=both`) op Instellingen, Huisstijl, Documentopmaak en de nieuwe
  pagina `settings-email`: 24 pagina's, 0 met problemen.
- Bekeken: mails met een logo zoals de app het opslaat (canvas → PNG en JPEG), met de lichte versie,
  zonder logo, een herinnering, de vrije klantmail, en op telefoonbreedte; het voorbeeld in de app
  met en zonder logo en met de lichte versie (Playwright tegen de nagebootste backend, zonder
  fouten); PDF's van factuur, creditfactuur, aanmaning en een kop in Bebas Neue.

## Uitrol

Geen migratie in deze ronde. Samenvoegen naar `staging` en pushen rolt de app uit en zet alle edge
functions opnieuw neer (`supabase functions deploy` zonder naam). De gedeelde code zit in
`invoice-workflow`, `quote-workflow`, `contract-workflow`, `contract-public`, `file-share`,
`file-transfer`, `file-transfer-public`, `meeting-booking`, `meeting-booking-public`,
`portal-notify`, `mail`, `campaigns`, `meeting-transcribe` en `calendar-integrations`.
