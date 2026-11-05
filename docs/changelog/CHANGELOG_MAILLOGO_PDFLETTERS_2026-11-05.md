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
- **E-factuur:** de factuur en de creditfactuur naar een e-factuuradres gaan zónder logo in de
  mail. Daar leest een boekhoudpakket de bijlagen in, en niet elk pakket slaat een ingesloten
  afbeelding over (onze eigen inbox `mail-inbound` doet dat wel); dan kreeg de klant bij elke
  factuur een "logo.png" als document in zijn administratie. Het logo staat ook in de PDF zelf.
  Herinneringen en aanmaningen gaan naar het gewone adres en hebben het logo wel.
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
  Zonder ligaturen ("fi" blijft f + i), zie *Controle achteraf*: dat scheelt het grootste deel van
  de rekentijd.
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

## Controle achteraf: wat er nog mis was, en is hersteld

Na de bouw is de hele branch (`origin/staging...HEAD`) nagelopen door een onafhankelijke review,
elke bevinding daarna nagebootst tegen de echte code. Wat klopte, is hersteld en heeft een test.

| Bevinding | Nagebootst | Nu |
|---|---|---|
| **Rekentijd met ingesloten letters.** fontkit rekende bij elke meting en elke regel ligaturen en kerning uit die pdf-lib weggooit. | Inter: 10 regels 0,8 s CPU, 100 regels 2,1 s, 300 regels 5,0 s. Supabase stopt een functie bij 2 s CPU: een lange factuur was niet te versturen. Ook de editor haperde bij het slepen. | Alleen de eerste stap van fontkit (tekens → glyphs): 300 regels 0,4 s in Node, 0,46 s in Deno met de letters zoals op de server. Meten en tekenen blijven gelijk; kopiëren uit de PDF werkt. Alleen ligaturen ("fi") vallen weg. |
| **Briefpapier per pagina gekopieerd.** | Groei per pagina met het hele briefpapier: bij 800 kB briefpapier was 7 pagina's 5,6 MB (boven 8 MB weigert de verzending). | Eén keer ingesloten, op elke pagina getekend. De PDF groeit nu even hard als zonder briefpapier. |
| **Briefpapier op Letter, A5 of liggend.** | De pagina kreeg die maat, de inhoud stond op A4: de voet (KvK, paginanummer) viel eraf. | Altijd een A4-pagina; het briefpapier wordt geschaald als omslag, zoals een afbeelding al werd. |
| **Een briefpapier-pagina zonder inhoud** (gevonden bij het herstellen). | pdf-lib sluit pas in bij het opslaan, buiten de foutafhandeling: de hele PDF mislukte. | Eerst op proef ingesloten; een vreemd briefpapier geeft een waarschuwing, een lege pagina niets. |
| **"Pagina 2 van 1" in de kop.** | De kop staat er voordat het aantal pagina's bekend is. | Dan een tweede ronde met het bekende aantal. |
| **Een eigen kopje met µ of ƒ.** | Hoofdletters ná het opschonen: µ wordt Griekse Μ, die Helvetica niet kent. De hele PDF mislukte. | Eerst hoofdletters, dan opschonen. |
| **"Factuur CN-… (vervolg)"** op pagina 2 van een creditfactuur. | Klopte. | "Creditfactuur … (vervolg)", "Aanmaning factuur … (vervolg)". |
| **Creditfactuur zonder verwijzing naar de factuur** bij een eigen opmaak met losse velden (Nummer, Datum). | Klopte; de controle meldde niets. | Zonder het blok Documentgegevens staat "Creditering van factuur … van …" bovenaan de inhoud. |
| **Btw-nummer van de afnemer ontbrak** bij btw verlegd of ICP en een eigen opmaak met Klantnaam + Adres klant. | Klopte. De server controleerde alleen dat het nummer bij de klant stond. | Toont de opmaak het nergens, dan bij de btw-vermeldingen ("Btw-nummer afnemer: …"); nooit dubbel. Ook in het voorbeeld in de app en op de creditfactuur. |
| **Aanmaning aan een consument: "Totaal te voldoen" mét incassokosten** in een veld Totaalbedrag. | Klopte (€ 2.397,88 boven een brief die € 2.022,88 vraagt). Incassokosten zijn bij een consument pas na veertien dagen verschuldigd. | "Nu te voldoen: € 2.022,88" bij een consument; bij een onderneming "Totaal te voldoen". |
| **Logo in de mail naar een e-factuuradres.** | Een aanname (zie hierboven). | Naar een e-factuuradres zonder logo. |

Bewust niet overgenomen:

- **De opmaak meekopiëren naar een nieuwe administratie** (`create_child_organization`). Die neemt
  de `brand_*`-kolommen over, niet het briefpapier. Een opmaak kan vrije tekstblokken hebben met
  bijvoorbeeld het IBAN of KvK-nummer van de moeder; die zouden dan op de facturen van de nieuwe
  administratie staan. Die begint met de standaardopmaak, waarin alles staat wat moet.
- **fontkit pas laden als er een PDF gemaakt wordt.** Gemeten: fontkit kost ~0,1 s bij een koude
  start (de lettermodule zelf 6 ms), niet per verzoek. Een dynamische import is hier niet tegen de
  bundelaar van Supabase te testen; neemt die hem niet mee, dan vallen alle PDF's stil terug op
  Helvetica. Geen enkele edge function gebruikt nu een dynamische import.
- ~~Dubbele code~~: opgeruimd, zie *Opruiming* hieronder.

## Opruiming: dubbele code

- **Eén kleurregel: `brandColor.ts`.** Helderheid, contrast, kleurtoon, "de merkkleur leesbaar
  maken" en "tekst op een merkkleurig vlak" stonden op drie plekken, elk net anders: de
  klantpagina's (`src/lib/branding.ts`), de PDF (`documentLayout.ts`) en de mails
  (`emailTemplates/layout.ts`). Nu één pure module, gespiegeld zoals `documentLayout.ts`
  (`src/lib/brandColor.ts` en `supabase/functions/_shared/brandColor.ts`; de test houdt ze gelijk).
  - Vooraf en achteraf vergeleken over alle 4096 kleuren van een 12-bits raster plus 20.000
    willekeurige: de mail, de merkkleur als tekst op papier en álle uitkomsten van de klantpagina's
    (beide sferen, met en zonder eigen kopkleur) zijn exact gelijk gebleven.
  - Eén bewust verschil, een fout die zo boven kwam: de tekst óp een merkkleurig vlak in de PDF
    viel niet terug op puur zwart als bijna-zwart en wit allebei onder 4,5 : 1 bleven (de mail en
    de klantpagina's deden dat wel). Op een raster van 636.000 kleuren gold dat voor 22.028
    middentinten, zoals blauw #0077DD, met soms maar 4,35 : 1. Nu overal minstens 4,5 : 1.
  - `documentLayout.ts` importeert daarvoor één bestand, `./brandColor.ts`, met hetzelfde pad in
    app en server. De app mag daarom eigen bestanden met `.ts` importeren
    (`allowImportingTsExtensions` in `tsconfig.json`): zonder die extensie vindt node (de tests)
    het bestand niet, en met de extensie weigerde TypeScript.
  - Een test zorgt dat de luminantieformule nergens anders opnieuw verschijnt.
- **De afzender: `loadSenderBrand` en `loadSenderName`** (`_shared/emailBrand.ts`). Naam
  (handelsnaam, bedrijfsnaam, anders de werkruimte), merkkleur en logo's in één query. Vervangt
  `orgBrand` (letterlijk twee keer, in de boekingsfuncties), `loadOrgBrand` (campagnes én de
  afmeldpagina) en `loadCompanyName` (notulen), en de tweede query voor het logo die er in deze
  ronde naast was gekomen.
- **`loadVatCodeInfo`** staat in `_shared/vatCodeInfo.ts` in plaats van letterlijk in
  `invoice-workflow` en `quote-workflow`; zelfde gedrag (ook codes die uit staan, gefilterd op de
  organisatie).
- Getest: typecheck schoon; `npm test` 1034 groen (nieuw: `brandColor.test.ts`,
  `vatCodeInfo.test.ts`, en tests op de afzender met een nagebootste database: één query, filter
  op de organisatie, terugval op de werkruimte); `npm run build` lukt; `deno check` op de hele
  CI-lijst en de gedeelde modules schoon, de twee workflows gelijk aan staging; de serverkant in
  Deno gedraaid (PDF's en mail met logo); mobiele test op alle schermen met de huisstijl (portaal,
  publieke pagina's, galerij, instellingen): 90 pagina's, 0 met problemen; editor 25/25.

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
  pagina `settings-email`: 24 pagina's, 0 met problemen. `npm run test:loading`: alle controles
  geslaagd.
- Na de controle achteraf: `npm test` 1016 groen (nieuw: briefpapier één keer en altijd A4,
  geen opmaakmachine van fontkit, paginanummer in de kop, vervolglabel, µ in een kopje,
  verwijzing op de creditfactuur, btw-nummer van de afnemer, totaal op de aanmaning, geen logo
  naar een e-factuuradres); `npm run build` lukt (fontkit als eigen stuk); CSP-controle in orde;
  `deno check` op de hele CI-lijst (34 functies) en de gedeelde modules schoon, de twee workflows
  gelijk aan staging. De serverkant in Deno gedraaid met de letters uit `pdfFonts.ts`: factuur
  (10/100/300 regels), offerte, creditfactuur en aanmaning bekeken; de Resend-payload met logo
  nagekeken. Interactietest van de editor 25/25, op de telefoon 5/5; mobiele test op
  Documentopmaak, E-mail, Facturen en Offertes: 24 pagina's, 0 met problemen.
- Na het samenvoegen met de nieuwste staging (tickets afhandelen en archief): typecheck schoon,
  `npm test` 1008 groen, `deno check` schoon op portal-notify, mail, campaigns, gerrie-agent en
  calendar-integrations, de twee workflows nog steeds gelijk aan staging (12 en 9). Mobiele test
  op de instellingenpagina's en de pagina's die staging raakte (ticketarchief, tickets bij een
  klant, tickets in het portaal): 42 pagina's, 0 met problemen.
- Bekeken: mails met een logo zoals de app het opslaat (canvas → PNG en JPEG), met de lichte versie,
  zonder logo, een herinnering, de vrije klantmail, en op telefoonbreedte; het voorbeeld in de app
  met en zonder logo en met de lichte versie (Playwright tegen de nagebootste backend, zonder
  fouten); PDF's van factuur, creditfactuur, aanmaning en een kop in Bebas Neue.

## Uitrol

Samengevoegd naar `staging` op 5 november (`e67aa69`), samen met de eerste ronde. Geen nieuwe
migratie in deze ronde; die van de eerste ronde, `20261105100000`, kwam na de laatste op staging
(`20261105030000`).

- *Deploy Supabase (staging)* run 175: migratie toegepast, alle 39 edge functions opnieuw neergezet
  (de 16 die deze branch raakt allemaal met een nieuwe versie), rooktest groen, ook
  `portal-notify` met het secret uit de cron-taak.
- Nagekeken op de staging-database (alleen lezen): `company_settings.document_layouts` (jsonb) en
  de CHECK op type en grootte staan erop; de twee organisaties hebben nog geen eigen opmaak en
  krijgen dus de standaardopmaak.
- *Frontend checks* run 128 viel op de stap *Deno-typecheck documentopmaak*: TS1192, "has no default
  export" bij `import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1'`. De module die esm.sh
  serveert heeft wél een default export (`export default fontkit` in de ES-build), maar de typen
  die esm.sh meestuurt noemen hem niet. Lokaal was dat niet te zien: esm.sh is vanuit de
  cloudsessie onbereikbaar, en de lokale controle gebruikte dezelfde versie uit npm, waarvan Deno
  de typen soepeler leest. Hersteld met een `@ts-ignore` op precies die import, met uitleg;
  `import * as fontkit` zou de typen tevredenstellen maar het draaien breken. Nagebootst met de
  typen uit het pakket zelf: zonder de regel dezelfde fout als in CI, met de regel schoon. Bij
  het draaien veranderde er niets: de uitgerolde functies gebruikten de default export al.
- Met het herstel (`d422ed3`): *Frontend checks* run 129 helemaal groen, ook de Deno-typecheck van
  de documentopmaak, de mobiele lay-outtest (donker en licht), het laden per module en de
  migratieketen vanaf nul. *Deploy Supabase (staging)* run 176 zette de functies opnieuw neer,
  rooktest groen. In run 128 was de rest ook al groen; alleen die ene typecheck viel om.
