# Controle contract-, offerte- en factuurstroom — 2026-11-05

> Controleer de gehele contract, offerte en factuur flow. Controleer maximaal en nauwkeurig op
> fouten, functionaliteiten en security.

Branch `ccr-d86525e7-q7nvm5`, bijgewerkt met `staging` tot en met `e67aa69`.
Changelog: `docs/changelog/CHANGELOG_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md`.
Migratie: `supabase/migrations/20261105230000_contract_offerte_factuur_controle.sql`.

## In het kort

- Zes deelcontroles: contracten, offertes, facturen, betalingen, de databaselaag, en
  Gerrie/API/MCP/klantportaal. Samen **67 bevindingen** (drie vonden twee controles allebei; die
  staan in beide tabellen): 1 kritiek, 4 hoog, ruim 20 middel en de rest laag.
- Elke bevinding over de database is lokaal nagespeeld op een verse database (alle 239
  migraties), in transacties die werden teruggedraaid. Daarna is elke reproductie opnieuw
  gedraaid na de fix.
- **49 bevindingen zijn opgelost en 4 deels. 14 staan open**, gebundeld in tien punten onderaan:
  klein, of een ontwerpkeuze, telkens met een voorstel.
- **Eén ding moet jij doen, en snel:** de Postgres-versie van staging upgraden. Lees eerst
  *Wat jij moet doen*.

## Wat jij moet doen

| # | Wat | Waarom | Hoe |
| --- | --- | --- | --- |
| 1 | **Postgres upgraden naar ≥ 17.6.1.178** (of 17.11.0.018 en later) | Op 17.6.1.111 laat één aanroep van een SECURITY DEFINER-functie waar je geen recht op hebt de hele database crashen (signal 11 in supautils; lokaal 8 keer nagespeeld, ook via de PostgREST-route). Iedereen met een account kan dat, voor alle organisaties tegelijk, zo vaak hij wil. `supabase/.temp/postgres-version` zegt dat staging op 17.6.1.111 draait. De migratie sluit de weg voor wie niet ingelogd is (anon); voor ingelogde gebruikers helpt alleen de upgrade. | Supabase-dashboard → Project Settings → Infrastructure → *Upgrade*. De rooktest meldt na elke uitrol de versie (`info postgres: …`). **Test de crash niet op staging**: hij haalt de database onderuit. |
| 2 | Media-worker opnieuw uitrollen | De worker had geen route voor offerte-PDF's; verzenden gaf een 502. `quote-workflow` valt nu terug op de database, maar de PDF's horen in R2. | `workers/media-api` deployen (zoals de andere workerwijzigingen). |
| 3 | `MOLLIE_TOKEN_ENCRYPTION_KEY` controleren | Zonder die sleutel viel de versleuteling van de Mollie-sleutels van organisaties terug op een vaste sleutel uit de code (en op staging staat `MOLLIE_ALLOW_MOCK` aan). Nu weigert opslaan zonder sleutel. | In de secrets van de edge functions zetten, als dat nog niet zo is. |
| 4 | `INVOICE_MOLLIE_WEBHOOK_URL` controleren | De factuurbetalingen vielen terug op `MOLLIE_WEBHOOK_URL`, en die wijst volgens de handleidingen naar `billing`. Dan werd geen factuur ooit betaald. De code gebruikt die terugval nu alleen als hij naar `invoice-workflow` wijst. | Zet `INVOICE_MOLLIE_WEBHOOK_URL` op `…/functions/v1/invoice-workflow`, of laat hem leeg (dan neemt de code die zelf). |
| 5 | De oude `cloudflare-worker` uitzetten | Die laat elk lid met een JWT de bewaarplichtige PDF's (facturen, offertes, contracten) wissen. De media-worker heeft die controle wel. | In Cloudflare de oude worker verwijderen, of controleren dat hij niet meer draait. |
| 6 | Twee keuzes maken | Zie *Open punten* 1 en 2: handmatig "Betaald" in het scherm, en Mollie-testsleutels. | — |

**Let op bij de afscherming voor anon:** anon kan het schema `public` niet meer in, dus ook
`billing_plans` niet meer lezen (de tabelrechten staan er nog, de rooktest verwacht ze). In deze
repo leest alleen de abonnementspagina die tabel, en daar ben je ingelogd. Leest een site buiten
deze repo (bijvoorbeeld een prijspagina) de plannen met de publieke sleutel, dan werkt dat na deze
migratie niet meer; laat zo'n site ze dan via een edge function ophalen. Na de upgrade van actie 1
kan anon het schema weer in als dat nodig blijkt (met een nieuwe migratie, en de controle in
`scripts/supabase-smoke-test.sh` aangepast): de crash zit dan niet meer in de weg.

## Wat er mis was en hoe het nu zit

Status: **opgelost**, **deels** (de kern is opgelost, een rand niet) of **open**.

### Contracten

| Bevinding | Ernst | Status |
| --- | --- | --- |
| De verzender kreeg de ondertekenlink van de klant terug en kon "als de klant" tekenen, met bewijs dat er echt uitzag. | hoog | opgelost: de link gaat alleen nog per mail naar de klant |
| De contract-PDF liet tekst weg (`<div>`-regels uit de editor, losse tekst, h1/h5/h6, tabellen, lijstitems na een geneste lijst) en gooide tekens buiten Latin-1 weg ("Łukasz Dvořák" werd "ukasz Dvoák"). Ook in het getekende exemplaar. | hoog | opgelost (`_shared/pdfText.ts`) |
| Een getekend contract was niet helemaal bevroren: klant, nummer, offerte, sjabloon en de werkvelden bleven te wijzigen. Daarna toonde het portaal van een andere klant het getekende PDF, met naam, IP en handtekening. | middel | opgelost: na versturen liggen inhoud, klant en nummer vast, voor iedereen |
| Opnieuw versturen dat mislukte (quotum, Resend, typfout) maakte de werkende link van de klant ongeldig. | middel | opgelost: de oude link en ondertekenaar komen terug |
| Status, interne goedkeuring en verzendvelden waren vanuit de browser te zetten: een verstuurd contract via verlopen → concept wissen, of een geweigerd contract met nieuwe tekst en bedrag laten tekenen via de oude link. | middel | opgelost: alleen de server zet die velden; een verstuurd contract is niet te wissen |
| Doodlopende wegen na de deadline of een weigering: datum niet aan te passen, verlopen → opnieuw versturen gaf een 500. | middel | opgelost: "Terug naar concept" (`reopen_contract`), en verlopen → verstuurd mag |
| De ondertekenaar koos zelf de akkoordtekst die in het bewijs kwam. | laag | opgelost: de server legt de vaste tekst vast |
| De vastgelegde versie werd ná de mail gemaakt en mocht mislukken; dan sloeg tekenen de versiecontrole over. | laag | opgelost: vóór de mail, en een fout stopt het versturen |
| Na een klantwissel bleven projecten van de vorige klant gekoppeld (en hun namen in het contract). | laag | opgelost |
| Het Word-bestand van een getekend contract was via een nieuw concept te overschrijven. | laag | opgelost: één Word-bestand per contract |
| Een mislukt getekend PDF werd nooit hersteld (de klant kreeg "zie bijlage", de download gaf 404). | middel | **open** (punt 5) |
| Een door een agent klaargezet contract opent niet. | laag | **open** (punt 9) |
| `{{contractnummer}}` is leeg in een nieuw Word-contract. | laag | **open** (punt 9) |
| De naam bij een interne notitie komt uit de browser. | laag | **open** (punt 10) |
| Bezorging van de contractmail wordt niet gevolgd (bounce onzichtbaar). | laag | **open** (punt 9) |

### Offertes

| Bevinding | Ernst | Status |
| --- | --- | --- |
| De media-worker had geen route voor offerte-PDF's: versturen gaf een 502. | hoog | opgelost: route erbij, en terugval op de database (worker nog uitrollen) |
| De akkoordlink (met token) stond leesbaar in verzendregels, versies en de offerte-PDF; de boekhouder (alleen lezen) kon "namens de klant" akkoord geven. Akkoord legde geen IP of browser vast. | middel | opgelost: link gemaskeerd, niet in de PDF; akkoord legt IP, browser en het uitgenodigde adres vast |
| Een verstuurde offerte kon niet worden ingetrokken. | middel | opgelost: "Intrekken" (`withdraw_quote`) |
| Opgeslagen versies rekenden de btw per regel (€ 60,24 tegen een factuur van € 60,26). | middel | opgelost: per tarief |
| PDF en mail rekenden anders dan de app (€ 173,62 tegen € 173,63). | middel | opgelost (`financeTotals`; de nieuwe opmaakmodule van staging rekent hetzelfde) |
| Het voorbeeld in de app was niet de PDF die de klant kreeg. | laag | opgelost door de documentopmaak op staging |
| Offertenummers waren niet uniek. | laag | opgelost |
| Een mislukte verzending bleef op "queued" staan en blokkeerde elke nieuwe poging. | laag | opgelost |
| Datums in UTC: tussen 00:00 en 02:00 de verkeerde dag, op 1 januari het verkeerde nummerjaar. | laag | opgelost |
| Geen lengtegrens op naam, e-mail en notitie bij akkoord. | laag | opgelost |
| Geen melding als een klant accepteert of weigert. | laag | **open** (punt 8) |

### Facturen

| Bevinding | Ernst | Status |
| --- | --- | --- |
| KOR: de factuur rekende 21% btw, het grootboek niets, een creditnota vorderde btw terug die nooit was afgedragen. | middel | opgelost: met KOR geen factuur met btw (database en vóór het versturen), nieuwe regels op 0% |
| Het grootboek rondde de btw af per (code, tarief): € 2,46 vordering bij een factuur van € 2,47, daarna niet meer te crediteren. | middel | opgelost |
| "Crediteren" verdween zodra er ooit een betaallink was geweest. | middel | opgelost |
| Herinneringen en WIK-aanmaningen voor concepten die nooit verstuurd zijn. | middel | opgelost (database, scherm en Gerrie) |
| Factuurversies en de PDF-regels rekenden per regel. | laag | opgelost |
| Het verzendquotum werd pas na de verzendregel gecontroleerd. | laag | opgelost |
| Statuswissels in het scherm: een terugbetaalde of gecrediteerde factuur kon terug naar verzonden. | laag | opgelost |
| Statuswissels in het scherm: een geboekte factuur met geld open kan op "Betaald". | laag | **deels** (punt 1) |
| Een creditnota-PDF zonder btw per tarief. | laag | opgelost door de documentopmaak op staging |
| Mollie-route: een concept blijft wijzigbaar terwijl Mollie hem al heeft uitgegeven. | middel/laag | **open** (punt 6) |
| Deelcreditnota: de UBL wijkt een cent af van de PDF. | laag | **open** (punt 7) |
| Opnieuw versturen maakt de documenten opnieuw in plaats van het verstuurde te hergebruiken. | laag | **open** (punt 7) |
| UBL: export wordt "Z" in plaats van "G"; een uitgezette btw-code verandert de categorie. | laag | **open** (punt 7) |
| Ruwe databasetekst in de melding over de betaallink. | laag | **deels**: eigen meldingen uit de database komen nu als zin; de betaallinkmelding nog niet |

### Betalingen

| Bevinding | Ernst | Status |
| --- | --- | --- |
| De webhook antwoordde 200 als een betaling niet te controleren was; de betaalstatus ging dan voorgoed verloren (en de klant kreeg herinneringen). | middel | opgelost: 503, Mollie probeert opnieuw |
| De terugbetaalgrens telde bij gemengd betalen (bank + Mollie) alleen het Mollie-deel. | middel | opgelost |
| Een terugbetaling in het Mollie-dashboard maakte altijd een creditnota, ook voor te veel betaald geld. | middel | opgelost |
| De factuur-webhook kon stil naar `billing` wijzen. | middel | opgelost in de code (controleer de secret, actie 4) |
| Portaal en publieke pagina toonden het factuurbedrag, niet wat er openstaat. | laag | opgelost |
| Eén onderbroken checkout blokkeerde online betalen voorgoed. | laag | opgelost |
| De pagina na het betalen verliep na 30 minuten. | laag | opgelost: 60 dagen |
| Terugbetaalstatus kon teruglopen; een onbekende uitkomst bij Mollie gold als mislukt (kans op dubbel terugbetalen). | laag | opgelost |
| De Mollie-sleutels vielen terug op een vaste sleutel uit de code. | laag | opgelost (actie 3) |
| Mock-betalingen zonder controle op organisatie. | laag | opgelost |
| Een betaald concept: de betaling werd nooit geboekt, Debiteuren bleef het volle bedrag tonen. | laag | opgelost |
| Na een mislukte verzending met betaallink blijft een concept voorgoed vergrendeld. | laag | **open** (punt 4) |
| Dubbele betaling (bank én Mollie) geeft geen signaal. | laag | **open** (punt 3) |
| Een late betaling op een geannuleerde factuur is niet terug te betalen vanuit de app. | laag | **open** (punt 3) |
| Een Mollie-testsleutel laat klanten echte facturen "betalen". | laag | **open**, jouw keuze (punt 2) |

### Database

| Bevinding | Ernst | Status |
| --- | --- | --- |
| Een geweigerde aanroep van een SECURITY DEFINER-functie laat Postgres crashen. | **kritiek** | **deels**: anon kan het schema niet meer in; voor ingelogde gebruikers alleen de upgrade (actie 1) |
| De pushmelding "Factuur betaald" ging ook naar leden zonder Financiën. | middel | opgelost |
| Contractstatus vanuit de browser te zetten. | middel | opgelost (zie Contracten) |
| Getekend contract: klant en nummer te wijzigen. | middel | opgelost (zie Contracten) |
| Factuurregels anders gelezen door totalen en grootboek ("1e3", " 21", "1,5"). | laag/middel | opgelost: zulke regels weigert de database |
| Herinneringsinstellingen te wijzigen door elk lid. | laag/middel | opgelost: alleen beheerders, zoals het scherm zegt |
| Nummers afgekapt na 9999 en te "vergiftigen" tot de integergrens; bijna-dubbelen (" fac-2026-0002"). | laag | opgelost |
| `created_by`, `sent_at`, `paid_at` op facturen en offertes na versturen te wijzigen. | laag | **deels**: op contracten opgelost, op facturen en offertes open (punt 10) |

### Gerrie, API, MCP en klantportaal

| Bevinding | Ernst | Status |
| --- | --- | --- |
| Klantportaal: klant B zag, betaalde en accepteerde documenten van klant A zodra het project naar B ging. | hoog | opgelost: alleen de eigen klant van het document telt, in de edge function én in `decide_quote_portal` |
| "Betaald" op een ongeboekte factuur boekte de omzet maar niet de betaling. | middel | opgelost: alleen nog voor een factuur uit de beginbalans |
| Het e-factuuradres (waar facturen heen gaan) kon met `execute_high` zonder mens worden gewijzigd. | middel | opgelost: altijd langs een mens, met oud → nieuw op de kaart; via de API ook schrijfrecht in Financiën |
| De ondertekenlink ging naar een adres dat het model koos, en de kaart kon dat verbergen. | middel | opgelost: het adres staat in de titel, met een waarschuwing bij een ander adres; een herinnering gaat naar de vorige ondertekenaar |
| Bewerkkaarten verzwegen een ander e-mailadres (klant, contactpersoon met portaaltoegang) of een andere klant (project). | middel | opgelost: oud → nieuw op de kaart |
| Het portaal toonde het factuurbedrag in plaats van het openstaande bedrag. | laag | opgelost |
| `credit_note.send` weigerde altijd bij een klant met een e-factuuradres. | laag | opgelost |

## Bij het samenvoegen met staging

Staging kreeg op dezelfde dag een nieuwe opmaakmodule voor offertes en facturen
(`documentLayout.ts`) en een migratie met hetzelfde versienummer als de mijne. Wat ik daarbij deed:

- **Mijn migratie heet nu `20261105230000`**, na de laatste op staging (`20261105100000`). Twee
  migraties met versie `20261105030000` zouden de uitrol laten mislukken.
- **De offerte-PDF van de nieuwe opmaak zette de akkoordlink weer in de PDF.** Die is eruit, om
  dezelfde reden als hierboven (de bewaarde PDF is voor elke lezer van Financiën te downloaden).
  De factuurlink staat er nog in: die laat alleen bekijken en betalen.
- **De nieuwe opmaak gooide letters buiten WinAnsi weg** ("Łukasz" werd "ukasz"), dezelfde fout
  als in de oude contract-PDF. Nu wordt zo'n letter vertaald ("Lukasz") of een vraagteken. In beide
  kopieën van `documentLayout.ts`, teken voor teken gelijk.

## Open punten, met een voorstel

1. **Handmatig "Betaald" in het scherm** zet een geboekte factuur op betaald terwijl Debiteuren
   open blijft. Gerrie, de API en MCP weigeren dat nu. Voorstel: in het scherm "Betaald" alleen
   toestaan als er niets meer openstaat, en anders verwijzen naar de bankkoppeling of een
   memoriaalpost. *Jouw keuze*, omdat het een werkwijze verandert.
2. **Mollie-testsleutels (`test_…`)** worden geaccepteerd; in de testcheckout kiest de betaler zelf
   "Paid". Voorstel: testsleutels alleen toestaan als de organisatie in testmodus staat, of
   `payload.mode` in de webhook vergelijken met de sleutel. *Jouw keuze.*
3. **Dubbele betaling en betaling op een geannuleerde factuur.** Geen signaal bij bank én Mollie,
   en de melding "controleer of het bedrag moet worden terugbetaald" kan niet worden opgevolgd
   (terugbetalen weigert een niet-betaalde factuur). Voorstel: een "Aandacht nodig"-markering op
   de factuur, en een terugbetaling die ook bij een geannuleerde factuur kan.
4. **Vergrendeld concept na een mislukte verzending met betaallink.** Voorstel: bij een mislukte
   verzending de checkout laten verlopen en het slot eraf halen, of de betaallink pas maken na het
   uitgeven.
5. **Getekend PDF herstellen.** Lukt het maken van het getekende PDF niet, dan blijft het contract
   zonder PDF. Voorstel: een actie "Getekend PDF opnieuw maken" in `contract-workflow`, met
   hetzelfde bewijs uit `contract_signers`. Het eventtype `signed_pdf_regenerated` staat al in de
   database.
6. **Mollie-uitgifte en het concept.** Een concept blijft wijzigbaar terwijl Mollie hem al heeft
   uitgegeven. Voorstel: het concept vergrendelen zodra de uitgifte bij Mollie begint.
7. **E-factuur (UBL):** een cent verschil bij een deelcreditnota, export als "Z" in plaats van "G",
   en opnieuw versturen maakt nieuwe documenten in plaats van het verstuurde te hergebruiken.
   Voorstel: de UBL-btw uit de opgeslagen creditnota halen, `EXPORT` als "G", en de verstuurde
   XML bewaren.
8. **Geen melding bij akkoord of weigering van een offerte.** Voorstel: dezelfde pushmelding als
   bij "Factuur betaald", voor wie Financiën ziet.
9. **Kleine contractpunten:** een door een agent klaargezet contract opent niet,
   `{{contractnummer}}` is leeg in een nieuw Word-contract, en een bounce van de contractmail wordt
   niet gevolgd.
10. **Wie en wanneer:** `created_by`, `sent_at` en `paid_at` op verstuurde facturen en offertes, en
    de naam bij een interne contractnotitie, zijn vanuit de browser te wijzigen. Het grootboek
    legt de echte gebruiker wel vast. Voorstel: dezelfde server-only-regel als bij contracten.

## Wat er getest is

- `npm test`: 1065 van 1065 groen, waaronder nieuwe tests voor `financeTotals`, `publicLinkExpiry`,
  `portalAccess`, `pdfText`, `mollieWebhookUrl`, de akkoordtekst, de e-factuurvelden via de API,
  en de Gerrie-kaarten (e-factuuradres, contractontvanger, creditnota-ontvanger, "betaald").
- `npm run typecheck`: schoon.
- De edge functions met `tsc` en dezelfde instellingen als `deno check` (Deno zelf is hier niet
  beschikbaar): alle 34 uit de CI-lijst plus `quote-workflow`, `invoice-workflow`, `client-portal`
  en `invoice-public`, zonder nieuwe meldingen.
- De database: de hele keten vanaf nul (`supabase db reset`), de nieuwe migratie twee keer achter
  elkaar, en alle reproducties uit de controle opnieuw: contracten, offertes (akkoord, intrekken,
  versies), facturen (grootboek, KOR, concept, status, versies), betalingen (gemengd terugbetalen,
  externe terugbetaling, teruglopen, terugkeerlink, betaald concept) en het portaal (beslissen
  over de offerte van een ander).
- `npm run test:mobile -- --theme=both`: 324 pagina's, 0 met problemen. `npm run test:loading`:
  alle controles geslaagd.

### Wat ik niet kon controleren

- **Staging zelf.** De gekoppelde Supabase-account ziet het staging-project niet; de
  Postgres-versie komt uit `supabase/.temp/postgres-version`.
- **Echte aanroepen naar Mollie, Resend, R2 en Collabora.** De routes zijn gecontroleerd in de
  code en waar mogelijk nagespeeld (de media-worker met zijn eigen `fetch`).
