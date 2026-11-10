# Controle van de API-laag — 10 november 2026

Vraag: *"Controleer de API-laag van de gehele app en beoordeel of deze functioneel en veilig is.
Niemand mag zomaar inbreken en de API-eindpunten moeten gewoon werken. Geef daarna een korte maar
krachtige lijst van wat we in de toekomst nodig hebben om externe applicaties met ResoFly te laten
praten."*

## Oordeel in het kort

- **Veilig:** ja. Er is niets gevonden waarmee iemand van buiten binnenkomt, of waarmee een
  organisatie bij de gegevens van een andere kan. Geen enkele bevinding was kritiek of hoog.
  - Wel acht punten van gemiddeld belang en een reeks lage, vooral binnen één organisatie: een
    teamlid dat meer kon dan zijn rechten zeiden, een AVG-lek in het portaal, een bewijsstuk dat
    te wissen was en een plafond dat ontbrak.
  - Op één na zijn ze in deze ronde hersteld, getest en uitgerold. Wat openstaat, staat
    onderaan, met stappen.
- **Functioneel:** ja. Gecontroleerd met de echte edge functions tegen een echte database:
  - de openbare API, de MCP-koppeling en de webhooks;
  - de volledige stromentest, 1037 stappen en 0 fout;
  - de unittests, 1486 en 0 fout;
  - de typecontrole van alle edge functions.

  Vier werkingsfouten zijn hersteld:
  - jaarrekening-PDF's werden nooit bewaard;
  - een teruggezette agenda-afspraak gaf een 500;
  - kapotte invoer gaf een 500 in plaats van een 400;
  - de afmeldlink in marketingmail toonde HTML-code in plaats van een knop. De uitgebreide
    rooktest stelde dat op staging vast.

  Eén configuratiepunt op staging staat open: de PDF-opslag loopt nog via de oude media-worker
  (punt O1).

## Wat er gecontroleerd is

| Onderdeel | Omvang |
|---|---|
| Openbare API (`api`, `api-admin`, webhooks) | sleutels, rechten, vaste adressen, handelingen, voorstellen, idempotentie, webhooks |
| MCP-koppeling (`mcp`, `mcp-oauth`) | registratie, OAuth met PKCE, tokens, rechten per aanroep |
| Alle 40 edge functions | aanmelden, organisatie, modulerechten, rol, invoer, foutmeldingen |
| Workers | `media-api`, `caldav`, `email-inbound`, `client-domains`, `office-server` en de oude `cloudflare-worker` |
| Database | RLS op alle tabellen, alle views en de 139 SECURITY DEFINER-functies die elke ingelogde gebruiker via `/rpc` kan aanroepen |
| Staging zelf | uitgerolde functies en `verify_jwt`, inloginstellingen, namen van secrets, uitgerolde workers |

**Hoe:**
- **Vijf reviews, los van elkaar:**
  - openbare pagina's en portaal;
  - webhooks, cron en OAuth;
  - de functies van de app;
  - de workers;
  - de databasefuncties.

  Elke bevinding is daarna opnieuw nagelopen in de code en, waar het kon, in de database.
- **Staging, alleen lezen**, via de Management API van Supabase en de API van Cloudflare.
- **Een nieuwe stromentest `api`** (`tests/stromen/api.mjs`, 57 stappen). De echte functies
  draaien tegen een lokale Supabase met alle migraties. Daarna draaiden alle stromentests
  samen.

### Wat op staging klopt

- **Rijbeveiliging en views:** elke tabel in `public` heeft RLS, en alle views zijn
  `security_invoker`.
- **Bevoorrechte functies:** geen enkele SECURITY DEFINER-functie is zonder inloggen (`anon`)
  aan te roepen. Ze hebben allemaal een vast `search_path`.
- **Edge functions:** alle 40 zijn uitgerold, met dezelfde `verify_jwt` als in
  `supabase/config.toml`. Er ontbreekt geen verplicht secret.
- **Inloggen:** aanmelden staat uit, wachtwoorden zijn minimaal 12 tekens met
  hoofdletter, kleine letter en cijfer, en refresh tokens roteren.
  - Captcha, gelekte-wachtwoordcontrole en sessieduur staan nog open (actiepunten 11 en 12 van 1
    november).

## Bevindingen en herstel

Ernst: **middel** = misbruik binnen een organisatie of een lek naar buiten met beperkte
reikwijdte; **laag** = klein, of moeilijk uit te buiten.

| # | Ernst | Wat | Status |
|---|---|---|---|
| 1 | middel | Opruimwachtrij wiste een bewijsstuk | hersteld (database, functie, worker) |
| 2 | middel | Portaal: contactpersoon las antwoord aan het hoofdadres | hersteld |
| 3 | middel | Een losse "systeemboeking" draaide een verkocht activum terug | hersteld |
| 4 | middel | Golf inkomende mail verstopte gedeelde wachtrijen | hersteld (rem), deels open (O5) |
| 5 | middel | Abonnement: één keer duur betalen, goedkoop blijven betalen | hersteld |
| 6 | middel | Oude media-worker nog bereikbaar en in gebruik | open, stappen in O1 |
| 7 | laag-middel | Delen van een bijlage uit een gesloten module | hersteld |
| 8 | laag-middel | MCP: registreren zonder plafond | hersteld |
| 9 | laag | Webhook-geheim van Mollie leesbaar voor organisaties | hersteld; geheim vernieuwen (O2) |
| 10 | laag | Agenda-antwoord namens een collega | hersteld |
| 11 | laag | Webhook van de organisatie bleef lopen na degradatie maker | hersteld |
| 12 | laag | Notulen op het tegoed van een collega | hersteld |
| 13 | laag | Drie databasefuncties gaven te veel prijs | hersteld |
| 14 | laag | Media-worker: één-bestandstoken opende de hele galerij als zip | hersteld en uitgerold |
| 15 | laag | CalDAV: collega hernoemt een gedeelde agenda | hersteld en uitgerold |
| 16 | laag (werking) | Jaarrekening-PDF's werden nooit bewaard | route hersteld; werkt na O1 |
| 17 | laag (werking) | CalDAV: teruggezette afspraak gaf een 500 | hersteld en uitgerold |
| 18 | laag (werking) | Openbare functies: kapotte invoer gaf een 500 | hersteld |
| 19 | middel (werking) | Afmeldlink in marketingmail toonde HTML-code in plaats van een knop | hersteld (O4) |

### 1. De opruimwachtrij wiste een bewijsstuk (middel)

**Wat kon er:** een teamlid met schrijfrecht op Inhoud kon een verstuurde factuur-PDF laten
wissen.
1. Hij maakt een document met als opslagsleutel `…/invoice-pdfs/…`.
2. Hij verwijdert dat document.
3. De nachtelijke opruimronde wist daarna het bestand.

De interne DELETE van de media-worker deed geen controle op bewijsstukken.

**Waarom dat telt:** het breekt de bewaarplicht (regel 6), en R2 heeft geen prullenbak.

**Herstel:**
- Een bewaker op `storage_purge_queue` laat alleen de soort sleutel toe die bij de bron past,
  en nooit een bewijsstuk.
- De opruimtaak (`deleteStorageObject`) weigert ze ook.
- De media-worker weigert ze ook (uitgerold).
- Op staging stond niets in de wachtrij: er is niets misgegaan.

### 2. Portaal: een contactpersoon las het antwoord aan het hoofdadres (middel)

**Hoe het lekte:** `client-portal` laat een contactpersoon een antwoord aan het hoofdadres zien
als het laatste inkomende bericht ervóór van hem was. De databasefunctie gaf alleen de
berichten van portaalgebruikers zelf door. Daardoor telde doorgestuurde mail of post van een
derde niet mee.
- Voorbeeld: een vertrouwelijke mail van de directeur, door een teamlid doorgestuurd naar het
  dossier.
- De contactpersoon zag dan het antwoord van het team aan de directeur, met het citaat eronder.

**Herstel:**
- `portal_client_message_overview` geeft elk inkomend bericht mee.
- Van berichten die niet van een portaalgebruiker zelf zijn, alleen tijd en gesprek: afzender,
  onderwerp en tekst blijven leeg.
- Een unittest legt het vast.

### 3. Een losse "systeemboeking" draaide een verkocht activum terug (middel)

**Wat kon er:** een teamlid met schrijfrecht op Financiën boekt via `/rpc/post_journal_entry`
een post van de soort `asset_disposal`, met het id van een verkocht activum. Daarna draait hij
die post terug.
- `reverse_journal_entry` zette het activum dan weer op actief, terwijl de echte
  desinvestering geboekt bleef, ook in een afgesloten jaar.
- Met `asset_depreciation` ging een volledig afgeschreven activum terug naar actief.

**Herstel:** een andere soort dan `manual` maakt alleen nog de bijbehorende functie, nooit een
rechtstreekse aanroep. De app boekt rechtstreeks alleen `manual`.

### 4. Een golf inkomende mail verstopte gedeelde wachtrijen (middel)

**Wat kon er:** wie ooit één mail van een klant kreeg (`reply+<token>@…`), kon duizenden mails
"van" die klant sturen. Er is geen DMARC-controle, punt G. Elk gekoppeld bericht gaf:
- een pushmelding aan elk teamlid;
- een signaal voor Gerrie, met een model-run op het tegoed van de owner.

Die wachtrijen delen alle organisaties. Het doorstuuradres had al een rem, het antwoordadres
niet.

**Herstel:**
- Per gesprek gaan 30 en per organisatie 300 berichten per uur gewoon door. Daarboven wordt
  een bericht geparkeerd in de opvangbak: bewaard en zichtbaar, maar zonder melding en zonder
  signaal.
- De signalen tellen nu ook het AI-tegoed van de organisatie.
- Open blijft O5.

### 5. Abonnement: één keer duur betalen, goedkoop blijven betalen (middel)

**Wat kon er:** een owner op een actief starterabonnement startte rechtstreeks een
`startSubscriptionCheckout` voor een duurder plan.
- Na die ene betaling stond de organisatie op het dure plan.
- Mollie bleef het oude bedrag afschrijven: het lopende abonnement werd hergebruikt.
- Na een opzegging werd het dode abonnement hergebruikt, en schreef Mollie niets meer af.

**Herstel:**
- Er start geen nieuw abonnement naast een lopend abonnement, en niet op een inactief plan.
- Opzeggen vergeet het abonnement.
- Bij de eerste betaling geldt:
  - het opgeslagen abonnement wordt alleen hergebruikt als het bij Mollie nog loopt, en dan
    met het nieuwe bedrag;
  - in alle andere gevallen komt er een nieuw abonnement;
  - een storing bij Mollie telt niet als "bestaat niet", zodat er nooit twee abonnementen
    naast elkaar lopen.

Niet te testen zonder Mollie: zie O3.

### 6. De oude media-worker draait nog, en staging gebruikt hem (middel)

**De vondst:** `resofly-media-staging` (de map `cloudflare-worker/`) staat aan op workers.dev en
gebruikt dezelfde bucket als de nieuwe media-worker.
- Binnen een organisatie kan elk lid er elk bestand mee lezen en wissen, ook een factuur-PDF,
  zonder modulerechten.
- Uitzetten kon niet zomaar. Het secret `QUOTE_PDF_STORAGE_WORKER_URL` op staging wijst naar
  deze oude worker (vastgesteld via de hash van het secret).
- Via de terugvalketen bewaren offertes, facturen en jaarrekeningen hun PDF dus nog via de oude
  worker. Contracten hebben op staging helemaal geen opslagadres en vallen terug op de database.

De app zelf (Cloudflare Pages) gebruikt al de nieuwe worker. Stappen: O1.

### 7. Delen van een bijlage uit een gesloten module (laag-middel)

**Wat kon er:** `file-share`, en een rechtstreekse insert in `drive_shares`, vroeg alleen
schrijfrecht op Inhoud. Een lid zonder Tickets of Projecten kon zo een bijlage van een intern
ticket via een deellink naar zichzelf sturen.

**Herstel:** delen kan alleen nog met bestanden in een map, net als in het scherm en bij
Gerrie. De database dwingt dat af, en `file-share` zegt het vooraf. Op staging bestond geen
enkele andere deling.

### 8. MCP: registreren zonder plafond (laag-middel)

`mcp-oauth /register` staat open, zo werkt het koppelen van Claude en ChatGPT. De grootte van
een registratie was begrensd, het aantal niet. Een lus vulde zo twee dagen lang de gedeelde
database.

**Herstel:**
- Per afzender 60 en voor iedereen samen 1000 registraties per uur. Daarboven volgt een 429
  met `Retry-After`. Dat gaat via de nieuwe databasefunctie `edge_note_attempt`.
- Een 500 geeft geen databasetekst meer naar buiten.

### 9 tot en met 18 (laag), en 19

- **9. Webhook-geheim van Mollie.**
  - **Wat:** `billing` bewaarde het Mollie-antwoord, met onze webhookUrl en het geheim erin,
    in tabellen die elke beheerder van een organisatie kan lezen. Op staging ging het om 2
    betaalregels en 7 gebeurtenissen.
  - **Herstel:** het wordt niet meer bewaard, en de migratie haalt het uit de bestaande rijen.
    Daarna moet het geheim zelf nog vernieuwd worden (O2).
- **10. Agenda-antwoord namens een collega.**
  - **Wat:** het antwoord gold voor het `ATTENDEE`-adres uit de mail, ook als dat niet de
    afzender was. Een joker in het adres (`%`) matchte bovendien de eerste de beste genodigde.
  - **Herstel:** alleen de afzender zelf, zonder jokers.
- **11. Webhooks van de organisatie** gaan nu uit als hun maker geen owner of admin meer is.
  Eerder liepen facturen met bedragen door naar zijn server.
- **12. Notulen:**
  - Met de hand nieuwe notulen gaan nu op het tegoed van wie erom vraagt; eerder liep zo
    andermans maandtegoed leeg.
  - Er loopt er één tegelijk.
- **13. Drie databasefuncties gaven te veel prijs:**
  - `organization_reserved_license_count`: het aantal leden van elke organisatie, ook aan een
    portaalklant;
  - `org_has_creative`: of een organisatie de creatieve module heeft;
  - `preview_next_client_code`: het volgende klantnummer aan een boekhouder of kijker.
- **14. Galerij-zip:** een token voor één bestand (de kopie voor Stream) opende de hele galerij
  als zip.
- **15. CalDAV:** een collega kon een gedeelde agenda hernoemen.
- **16. Jaarrekening-PDF's:** de route `/internal/annual-account-snapshot` ontbrak in de
  media-worker, dus er werd nooit een PDF bewaard. Hij is toegevoegd en uitgerold. Op staging
  werkt hij pas na O1, omdat staging nog naar de oude worker wijst.
- **17. CalDAV:** een afspraak die verwijderd was en terugkwam (ongedaan maken op de iPhone) gaf
  bij elke poging een 500.
- **18. Openbare functies:** een body `null` of een lijst gaf een 500 met de tekst van een
  TypeError. Nu een 400. `gallery-public` noemde ook de namen van secrets aan bezoekers.
- **19. De afmeldlink in marketingmail.**
  - **Wat:** Supabase serveert een GET met `text/html` op `*.supabase.co` als platte tekst. Wie
    in een campagnemail op "Afmelden" klikte, zag HTML-code in plaats van een knop. Afmelden
    met één klik vanuit het mailprogramma werkte wel. De uitgebreide rooktest stelde het op
    staging vast.
  - **Herstel:**
    - `email-unsubscribe` stuurt een browser door naar de nieuwe pagina `/afmelden` in de app;
    - die pagina vraagt eerst wie het is, en meldt pas af na de knop. Mailprogramma's en
      scanners openen links vooraf, en mogen niemand per ongeluk afmelden;
    - op een klantadres serveert de worker dezelfde pagina, in de huisstijl van de organisatie;
    - de one-click POST is ongewijzigd.

## Uitgerold

- **Database:** migratie `20261110140000_api_laag_controle.sql`, veilig om nog eens te draaien.
- **Edge functions:**
  - `email-unsubscribe`
  - `mcp-oauth`
  - `file-share`
  - `mail-inbound`
  - `billing`
  - `meeting-transcribe`
  - `gerrie-signals`
  - de openbare functies uit punt 18
  - `_shared/fileTransferServer.ts` en `_shared/meetingPipeline.ts`
- **App (Cloudflare Pages):** de nieuwe pagina `/afmelden`.
- **Workers op staging (10 november):**
  - `resofly-media-api-staging`, versie `9896b7a9`;
  - `resofly-caldav-staging`, versie `bf5ff3e8`;
  - `resofly-client-domains-staging`, versie `ef5b3841`.

  Bindings en secrets zijn ongewijzigd.
- **Rooktest na de uitrol:** groen, met de nieuwe controles op de API-laag. Een browser die de
  afmeldlink opent, gaat op staging nu door naar `/afmelden`.

## Open punten

### O1. De oude media-worker weg, en alle PDF-opslag naar de nieuwe (eigenaar)

Dit sluit bevinding 6 en laat bevinding 16 werken.

1. Zet in Supabase (staging) → Edge Functions → Secrets:
   - `QUOTE_PDF_STORAGE_WORKER_URL`, `INVOICE_PDF_STORAGE_WORKER_URL` en
     `CONTRACT_PDF_STORAGE_WORKER_URL` op `https://resofly-media-api-staging.gerjan.workers.dev`;
   - `INTERNAL_UPLOAD_SECRET` op dezelfde waarde als het secret `INTERNAL_UPLOAD_SECRET` van de
     worker `resofly-media-api-staging`.

     Weet je die niet meer, maak dan een nieuwe en zet hem op beide plekken:
     `npx wrangler secret put INTERNAL_UPLOAD_SECRET --env staging` in `workers/media-api`.

     Zet dezelfde waarde ook als `QUOTE_PDF_STORAGE_SECRET`, `INVOICE_PDF_STORAGE_SECRET` en
     `CONTRACT_PDF_STORAGE_SECRET`.
2. Proef:
   - verstuur een testofferte en een testfactuur. In de app moet bij de verstuurde versie de
     PDF te openen zijn;
   - laat een contract tekenen;
   - stel een jaarrekening vast.
3. Klopt alles: Cloudflare → Workers → `resofly-media-staging` → Settings → Domains & Routes →
   workers.dev uit. Na een week zonder klachten: Delete, en laat de map `cloudflare-worker/` uit
   de repo halen.

Ik heb dit niet zelf omgezet. Vanuit deze sessie zijn de functies en workers op staging niet
aan te roepen, en een verkeerd geheim breekt het bewaren van PDF's zonder dat iemand het
merkt.

### O2. Het webhook-geheim van Mollie vernieuwen (eigenaar)

Het geheim stond leesbaar voor de beheerders van elke organisatie (bevinding 9). Wat al gelezen
is, haal je niet terug.

**Waarom het geen spoed heeft:** met het geheim kan iemand alleen de webhook aanroepen. De
webhook haalt elke betaling opnieuw bij Mollie op en verandert niets op eigen gezag.

**Stappen:**
1. Supabase (staging) → Edge Functions → Secrets: zet `MOLLIE_WEBHOOK_SECRET` op een nieuwe
   waarde.
2. Zet ook `INVOICE_MOLLIE_WEBHOOK_SECRET` op een nieuwe, eigen waarde. Die bestaat op staging
   al.
3. Lopende betalingen houden hun oude webhookUrl. Doe dit dus op een rustig moment, of accepteer
   dat een openstaande betaallink zijn bericht mist. De status komt dan via "Vernieuwen" alsnog
   binnen.

### O3. Facturering testen met Mollie (code, met testsleutel)

Bevinding 5 is gelezen en hersteld, maar niet tegen Mollie getest. Het harnas van de
stromentest kent Mollie voor facturen, niet voor abonnementen. Proef op staging met de
testsleutel van Mollie:
1. een abonnement afsluiten;
2. het plan wijzigen;
3. opzeggen;
4. opnieuw afsluiten.

Kijk daarna in Mollie dat er steeds precies één lopend abonnement is, met het bedrag van het
plan.

### O4. De afmeldpagina van marketingmail (hersteld, één klik ter controle)

De rooktest zag op staging dat de pagina als `text/plain` aankwam (bevinding 19). Dat is
hersteld; zie hierboven.

**Wat nog moet:**
1. Verstuur een testcampagne naar jezelf.
2. Klik in de mail op "Afmelden": je komt op `/afmelden` in de app, met een knop.
3. Klik op de knop en controleer de afmelding onder Marketing.

De rooktest controleert na elke uitrol dat een browser wordt doorgestuurd naar `/afmelden`.

### O5. Wat er nog over is (code, later)

- **Inkomende mail:**
  - De gedeelde wachtrijen (`claim_push_outbox`, `claim_due_signals`, `claim_due_agents`, de
    webhook-bezorger) verdelen nog niet eerlijk per organisatie.
  - Een melding per gesprek in plaats van per bericht is een tweede rem.
  - De handtekening van de email-worker gebruikt hetzelfde geheim als de header; een eigen
    sleutel maakt actiepunt 3 van 1 november pas echt dicht.
- **`ai_decision_mute` met bereik "klant":** werkt over modules heen. Wie Financiën niet mag,
  kan zo de kaarten van Financiën voor die klant wegzetten.
- **Galerij met pincode:**
  - **Wat:** een goede pincode zet de teller voor de hele galerij op nul. Een bezoeker die
    meekijkt, laat zo een gokker steeds opnieuw beginnen.
  - **Oplossing:** een schuivend venster, dat bij succes niet terug naar nul gaat.
- **`contract-public`:** de rem op vragen (5 per uur) is met parallelle verzoeken te omzeilen.
- **Portaal:** een klant met honderden projecten krijgt een 414 (te lange URL) en een leeg
  portaal.
- **Databasetekst naar ingelogde gebruikers:** in `meeting-booking`, `meeting-transcribe`,
  `file-share` en `file-transfer` kan nog databasetekst doorkomen. Gebruik `dbErrorAnswer`, net
  als elders.
- **MCP:**
  - geeft bij een 401 soms een databasetekst mee;
  - telt mislukte tokens niet, zoals `api` wel doet. Een token is niet te raden, dus dit is
    alleen een rem op belasting.

## Lijst voor de toekomst: externe applicaties met ResoFly laten praten

ResoFly heeft al:
- een openbare REST-API met OpenAPI 3.1;
- API-sleutels met vier niveaus en modulebeperking;
- idempotentie en ondertekende webhooks;
- een goedkeurwachtrij;
- een MCP-koppeling met OAuth.

Wat er nog nodig is, op volgorde van belang:

1. **Een vast adres en een versiebeleid.**
   - **Wat:** `api.resofly.com` in plaats van het adres van het Supabase-project, plus een
     belofte hoe lang `v1` blijft (de headers `Deprecation` en `Sunset`, en een changelog).
   - **Waarom:** een koppeling overleeft dan een verhuizing naar productie.
2. **"Koppel met ResoFly" (OAuth) voor apps van anderen.**
   - **Wat:** dezelfde OAuth-server als de MCP-koppeling, ook voor de REST-API. Met een
     registratie per app (naam, logo, redirect, een secret voor serverapps), toestemming door de
     klant en intrekken per app.
   - **Waarom:** nu moet een klant een sleutel kopiëren en plakken. Een partner wil een knop.
3. **Fijnere rechten.**
   - Scopes per onderwerp (`clients:read`, `invoices:write`), een IP-allowlist per sleutel, en
     sleutelrotatie met een overlapperiode.
   - Registratie van de voorvoegsels `rsfapi.` en `rsfmcp.` bij GitHub secret scanning, zodat
     een gelekte sleutel vanzelf gemeld wordt.
4. **De hele administratie als vaste adressen.**
   - **Wat erbij moet:**
     - facturen, creditnota's, offertes, betalingen, producten en prijzen, en
       inkoopfacturen;
     - documenten en bestanden, met upload- en downloadlinks;
     - agenda en afspraken.
   - **Waarom:** nu kan dat alleen via handelingen. Een webshop of een boekhoudkoppeling
     verwacht vaste adressen.
5. **Synchroniseren op schaal.**
   - **Wat:**
     - bladeren met een cursor in plaats van een offset (nu stopt bladeren bij 10.000);
     - bulkadressen;
     - een gebeurtenissenlog (`GET /v1/events?since=`), zodat een koppeling die even plat lag
       kan bijlezen;
     - een webhook opnieuw laten bezorgen.
6. **Inkomende koppelingen.**
   - Een eigen, ondertekend webhookadres per organisatie, zodat bijvoorbeeld een webshop bij
     een bestelling meteen een klant en een factuur kan laten maken.
   - Een importadres voor CSV en UBL.
7. **Een ontwikkelaarsportaal met sandbox.**
   - **Wat:** documentatie online (`API_DOCS_URL`) en een testorganisatie met testsleutels die
     nooit mailen of betalen. Daarnaast een Postman-collectie en SDK's (TypeScript, Python,
     PHP), gegenereerd uit het OpenAPI-document.
   - **Waarom:** zo bouwt een partner zonder hulp.
8. **Standaardkoppelingen.** Een officiële app voor Zapier, Make en n8n. Een synchronisatie met
   Exact Online, Moneybird, Twinfield en e-Boekhouden. Peppol rechtstreeks, niet alleen via
   Mollie.
9. **Toezicht.** Per sleutel een gebruiksoverzicht en meldingen bij pieken in 401, 429 en 5xx.
   Ook nodig: een instelbare limiet per organisatie en een statuspagina.
10. **Afspraken.**
    - API-voorwaarden;
    - een verwerkersovereenkomst die koppelingen dekt;
    - bewaartermijnen voor het verzoeklog;
    - een vast proces voor het melden van een lek.
11. **Over naar de nieuwe API-sleutels van Supabase.**
    - **Wat:** de publishable en secret keys vervangen de oude JWT-sleutels `anon` en
      `service_role`.
    - **Wat er dan breekt:** functies met `verify_jwt = true` (`invoice-public`,
      `quote-public`, `mail`, `quote-workflow`, `contract-workflow`, `annual-accounts`,
      `corporate-tax`) houden dan op te werken.
    - **Wat ervoor nodig is:** die functies moeten eerst zelf hun aanmelding doen, net als de
      rest.
