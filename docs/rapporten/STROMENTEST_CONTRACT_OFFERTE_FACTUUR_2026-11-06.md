# Stromentest contracten, offertes, facturen en herinneringen — 2026-11-06

## Vraag

> Doe nog eens een hele goede test of de contract, offerte, factuur, herinneringen allemaal goed
> werkt..check de functionaliteit, de beveiliging werking. Ik wil er na deze check zeker van zijn
> dat alles goed werkt.

## Hoe er getest is

Niet met losse unittests, maar met de **echte edge functions** tegen een **echte database**:

- een lokale Supabase-stack (Postgres 17.6.1.178, GoTrue, PostgREST met RLS) met **alle
  migraties**, ook die van staging van vandaag (klantlogin, Mollie-deelbetaling,
  financiën-zekerheidstest, factuur zonder inhoud);
- de edge functions (`quote-workflow`, `quote-public`, `invoice-workflow`, `invoice-public`,
  `contract-workflow`, `contract-public`, `client-portal`, `portal-login`, `api`, …) draaien
  ongewijzigd in Node (`tests/stromen/`), met echte gebruikers en echte rechten per rol;
- alleen wat buiten Supabase ligt is nep: **Resend** (elke mail vastgelegd, met bijlagen),
  **Mollie** (betalingen, terugbetalingen, terugboekingen en de webhook zoals Mollie hem aanroept)
  en de **media-worker** (R2-opslag, Word → PDF). Storingen zijn op bestelling na te bootsen;
- daarnaast een **UI-test in Chromium** (`tests/stromen/ui.mjs`) die de echte knoppen indrukt.

Per scenario een eigen organisatie met alle rollen (eigenaar, beheerder, medewerker, lezer van
Financiën, teamlid zonder Financiën, kijker, boekhouder), twee klanten met elk een
portaalgebruiker, en voor de aanvallen een tweede organisatie.

| Scenario | Wat |
| --- | --- |
| `offertes` | concept → goedkeuren → versturen → akkoord/afwijzen → factuur; intrekken; verlopen (ook om 00:30); nummers; PDF-opslag en storingen; portaal; rechten; KOR |
| `facturen` | versturen (mail, e-factuur, via Mollie), PDF/UBL, betalen, deelbetalen, terugbetalen, terugboeken, crediteren, storingen bij Resend/Mollie/R2, KOR |
| `herinneringen` | handmatig en automatisch (cron), zonder Mollie, instellingen, aanmaningen (WIK) handmatig en via de cron, gelijktijdig klikken, rechten |
| `contracten` | rich-text en Word, versturen, tekenen (getypt en getekend), weigeren, terug naar concept, R2-storing, deadline, rollen, portaal, gelijktijdig |
| `beveiliging` | organisatie B valt A aan, rollen met te weinig rechten, server-velden via PostgREST, server-RPC's, anoniem, tokens, portaal, webhook en cron, lekken in antwoorden |
| `rook`, `automatisering` | het harnas zelf; de cron- en webhookingangen |

## Uitkomst

| Moment | Stappen | Fout |
| --- | --- | --- |
| Eerste run, per scenario (code van 5 november) | 497 + 35 in de browser | 34 + 5 |
| Na het mergen van staging (6 november) | 497 | 35 ¹ |
| **Na de herstelronde** (twee runs na elkaar, de tweede op een database die vanaf nul is opgebouwd) | **502 + 35 in de browser** | **0 + 0** |

¹ Eén extra: staging veranderde bewust het onderwerp van de aanmaning ("betaal uiterlijk op" in
plaats van "reageer vóór"); de test is daarop bijgewerkt.

De 39 fouten zaten in het product, niet in de test. Op een paar plekken is de verwachting van de
test bijgesteld omdat de oplossing een stap eerder ingrijpt (bijvoorbeeld: de KOR weigert al bij
indienen in plaats van bij versturen; zonder Mollie wordt geen betaallink meer geprobeerd, dus er
is ook geen mislukte poging om vast te leggen). Waar het ontwerp bewust anders is dan de test
eerst verwachtte, staat onder "Bewuste keuzes".

## Gevonden en opgelost

Ernst: **hoog** = geld of toegang klopt niet; **middel** = een stroom loopt vast of de verkeerde
gegevens worden vastgelegd; **laag** = foutmelding, randgeval of tekst.

### Beveiliging

| # | Ernst | Wat er misging | Oplossing |
| --- | --- | --- | --- |
| S-A | **middel** | Een teamlid **zonder Financiën** (wel Klanten) zette zijn eigen adres — of een tweede, privé-adres — als portaalcontact bij een klant. Daarna las hij via het klantportaal alle facturen, offertes en contracten van die klant, downloadde hij de PDF's en accepteerde hij een offerte "als klant". Ook via het hoofdadres van de klant. | (1) Een actief teamlid is in zijn eigen organisatie nooit portaalklant (database: `portal_clients_for_email`; portaal: nog eens op gebruikers-id). (2) Portaaltoegang geven, of het hoofdadres van een klant met documenten wijzigen, vraagt schrijfrecht in Financiën (trigger op `client_contacts` en `clients`). |
| S-B | laag | De publieke factuurlink (met token) kwam terug in antwoorden aan de browser, ook verstopt in Mollie's antwoord (`redirectUrl`). | `invoice-workflow` stuurt geen publieke link meer naar de browser; de app gebruikte hem niet. Zie ook "Bewuste keuzes". |

### Offertes

| # | Ernst | Wat er misging | Oplossing |
| --- | --- | --- | --- |
| O-A | middel | Elke offerteversie bewaarde de **complete** klant-, project- en bedrijfsrij: notities, klantwaarde, tags, eigen velden, uurtarief, budget, en logo en briefpapier als data-URL (megabytes per versie). Elke lezer van Financiën las dat mee, ook de boekhouder. | Alleen de velden die op de offerte staan; bestaande versies opgeschoond. |
| O-G | laag–middel | Onder de **KOR** kon een offerte met btw worden ingediend, verstuurd en geaccepteerd; de factuur daaruit was daarna niet te versturen. | Indienen en goedkeuren weigeren een offerte met btw onder de KOR; versturen ook (voor een offerte die al was goedgekeurd). |
| O-C | laag | "Vandaag" in UTC in de edge functions en bij interne goedkeuring: tussen 00:00 en 01:00/02:00 kon een gisteren verlopen offerte nog verstuurd worden, en toonde de klantpagina een akkoordknop die een fout gaf. | Overal de Nederlandse kalenderdag (`_shared/nlDate.ts`, `approve_quote_internal`). |
| O-F | laag | Een offerte- of factuurnummer met een tab of harde spatie (plakken uit een PDF) telde als ander nummer: twee keer hetzelfde nummer. | Alle witruimte telt als spatie, onzichtbare tekens tellen niet, en het nummer wordt zo opgeslagen. |
| O-B | laag | Dubbelklik op Versturen: de tweede kreeg een 500 ("serverfout") in plaats van "er loopt al een verzending". | Een weigering van de database wordt een 409 met die zin (`_shared/dbError.ts`), in alle stromen. |
| O-D/E | laag | Een NUL-teken in naam, e-mail of opmerking (publieke pagina en portaal) gaf een 500. | Vooraf geweigerd met een uitleg (422). |

### Facturen en betalingen

| # | Ernst | Wat er misging | Oplossing |
| --- | --- | --- | --- |
| F-B1 | **hoog** (bij e-factuur via Mollie) | Een mislukte verzending werd niet vastgelegd: de auditactie `invoice_email_send_failed` bestond niet, dus de hele vastlegging werd teruggedraaid. De verzendregel bleef "in de wachtrij"; een e-factuur via Mollie was daarna nooit meer te versturen of te betalen. | De twee ontbrekende auditacties toegevoegd. |
| F-B2 / H-A / U-A | **hoog** | Hetzelfde voor een mislukte betaallink (`invoice_payment_checkout_failed`): de betaalrij bleef op `creating`. Een herinnering probeerde **ook zonder gekoppelde Mollie** een betaallink; daarna gaf crediteren voorgoed "er loopt een betaling" en verdween de knop Crediteren. | Auditacties toegevoegd; zonder Mollie geen betaallinkpoging; de Mollie-sleutel wordt gecontroleerd vóór er een betaalrij ontstaat; een verlopen link houdt crediteren (server en knop) niet meer tegen. |
| F-B3 | middel | Na een terugboeking betaalde de klant opnieuw; elke latere melding van Mollie over de oude betaling zette de factuur toch terug op open (en dus herinneringen). | De factuur gaat alleen terug op open als hij niet (opnieuw) is voldaan; anders blijft hij betaald. |
| F-B4 | middel | Een **betaalde, geboekte** factuur kon via de status (PostgREST of Gerrie) op geannuleerd, ongeldig of afgeboekt: omzet en btw bleven geboekt. | De database weigert dat zonder volledige creditnota; Gerrie legt uit dat het via een terugbetaling gaat. |
| F-B5 | laag | Een herinnering voor een concept maakte eerst een betaallink (concept op slot) en werd daarna geweigerd. | Concept en "nog niet vervallen" worden vóór de betaallink geweigerd. |
| F-B6 | laag | Een losse betaallink kon voor een concept, en onder de KOR voor een factuur met btw (de webhook gaf daarna bij elke poging een 500). | Losse betaallink alleen voor een uitgegeven factuur; KOR-controle. |
| Open punt 4 (5 nov.) | laag | Na een mislukte verzending **mét** betaallink zat het concept voorgoed op slot. | Een concept met alleen een ongebruikte betaallink blijft bewerkbaar; wijzigt de inhoud, dan vervalt die link en komt er bij versturen een nieuwe voor het nieuwe bedrag. |

### Herinneringen en aanmaningen

| # | Ernst | Wat er misging | Oplossing |
| --- | --- | --- | --- |
| H-B | middel | Een handmatige herinnering voor een factuur die **nog niet vervallen** was: de klant kreeg "0 dagen verstreken". | Server en database weigeren dat (Nederlandse kalenderdag). |
| H-C | middel | Een deelbetaling tussen voorstel en versturen van een aanmaning: de brief noemde het nieuwe bedrag, de vastgelegde aanmaning (en het scherm) het oude. | De hoofdsom, het soort klant en de rente worden bij versturen vastgelegd zoals in de brief. |
| H-D | laag–middel | De cron keek niet naar de laatste herinnering: een factuur die vandaag met de hand was herinnerd kreeg dezelfde dag nog één, en een tweede run stuurde opnieuw. | Hooguit één herinnering per factuur per dag, en niet terwijl er een onderweg is. |
| H-E | laag | Twee collega's tegelijk: de klant kreeg twee keer niveau 1. | Een tweede poging terwijl er een onderweg is, of vlak erna voor hetzelfde niveau, wordt geweigerd. |
| H-F | laag | Drie collega's tegelijk een aanmaning voorstellen: twee keer een 500. | Een 409 met uitleg. |

### Contracten

| # | Ernst | Wat er misging | Oplossing |
| --- | --- | --- | --- |
| C-A | middel | Twee keer tegelijk versturen en de tweede mislukte: de link in de verstuurde mail werkte niet (de tweede zette de link van vóór béíde pogingen terug; de versienummers botsten). | Eén verzending tegelijk per contract; de vorige link wordt onder het slot vastgelegd en precies die wordt teruggezet; versienummers onder slot. |
| C-C | laag–middel | Word-contract: was de vastgelegde PDF even onbereikbaar (R2), dan werd het .docx opnieuw omgezet en die omzetting getoond én als getekend exemplaar vastgelegd — niet het document dat de klant kreeg. | Nooit een nieuwe omzetting als er een vastgelegde PDF is; eerst nog twee pogingen, en bij tekenen wordt de PDF vóór de handtekening opgehaald (anders: "probeer het zo opnieuw", niets getekend). |
| C-D | laag–middel | Het tijdstip op het ondertekenbewijs en in beide bevestigingsmails stond in UTC (een uur te vroeg, 's zomers twee). | Nederlandse tijd. |
| C-B | laag | De klant tekende terwijl je opnieuw verstuurde: 500 in plaats van een weigering. | 409 "kan niet (opnieuw) worden verstuurd vanuit status getekend". |
| — | laag | Het portaal las getekende contract-PDF's met de opslaginstellingen van facturen, contract-public schrijft met die van contracten. | Het portaal gebruikt nu dezelfde keten als contract-public. |
| — | laag | De melding bij een gewijzigde versie sprak de klant aan met "u". | "je". |

### In de app (browsertest)

| # | Ernst | Wat er misging | Oplossing |
| --- | --- | --- | --- |
| U-A | **hoog** | = H-A in het scherm: de knop Crediteren verdween na een herinnering zonder Mollie. | Zie H-A; de knop telt een verlopen link niet meer. |
| U-B | laag | De herinnering vroeg geen Mollie-status op en meldde "betaallink mislukt" terwijl Mollie niet gekoppeld was. | Zoals bij versturen: eerst de Mollie-status, alleen dan een link en een melding. |
| U-C | laag | Een geaccepteerde offerte heette "Openstaand"; een ingetrokken offerte "Geannuleerd". | "Geaccepteerd" en "Ingetrokken". |
| U-D | laag | De publieke offertepagina toonde het akkoordformulier bij een ingetrokken of verlopen offerte; het portaal de knoppen bij een verlopen offerte. | Geen formulier of knoppen, wel uitleg. |
| U-E | laag | "Ververs" laadde de contractenlijst niet opnieuw. | Wel. |
| — | laag | Elke start gaf voor niet-beheerders een 403 op het abonnementsoverzicht, met een misleidende waarschuwing. | Alleen opgevraagd voor wie het mag zien. |

## Bewuste keuzes en wat niet is veranderd

- **De publieke factuurlink in de database.** Hij staat in de verzendregel, de linktabel, de
  betaalrij en de aanmaning, en is leesbaar voor wie Financiën mag lezen. Dat blijft zo: dezelfde
  link staat bewust op de factuur-PDF ("Bekijk deze factuur online"), die dezelfde lezers kunnen
  downloaden; en het herstel van een onderbroken Mollie-uitgifte gebruikt hem. Wie Financiën niet
  mag lezen en andere organisaties lezen hem niet (getoetst). Naar de browser gaat hij niet meer.
- **De betaalknop in een aanmaning** vraagt het openstaande factuurbedrag, niet de rente en
  incassokosten. Dat is een ontwerpvraag (gedeeltelijke betaling van de vordering), geen fout.
- **Het webhook-secret** van Mollie staat in de webhook-URL die elke organisatie bij Mollie
  registreert, en is dus zichtbaar in het Mollie-dashboard van die organisatie. De webhook
  controleert elke melding bij Mollie met de sleutel van de organisatie zelf; de impact is klein.
- **Boekdatums van betalingen en terugbetalingen** volgen nog de UTC-datum van het tijdstip
  (`book_invoice_payment`, `recompute_invoice_refund_state`): een betaling tussen 00:00 en
  01:00/02:00 op 1 januari kan in het vorige jaar landen. Niet gevonden door de test; laag, maar
  het verdient een eigen, kleine migratie.
- **Een verstuurde offerte na "geldig tot"** geeft op de publieke pagina nog "Deze link werkt niet
  meer" met de melding "Deze offerte is verlopen…" (de server antwoordt 410), niet de nieuwe,
  vriendelijkere uitleg. Een offerte met status verlopen of ingetrokken krijgt die uitleg wel.
  Bewust zo gelaten: de klant ziet duidelijk dat de offerte verlopen is, en de server geeft geen
  gegevens meer van een offerte waarover niet meer beslist kan worden.
- **Lokale 502's van Kong** (4 van ~110 aanroepen op de vraag-route van een contract) waren niet
  aan de productcode toe te schrijven en kwamen in de latere runs niet terug.

## Auth-instellingen van staging (gecontroleerd bij de uitrol)

Het klantportaal vertrouwt het e-mailadres van de sessie. Dat is alleen veilig als niemand zelf
een account kan aanmaken met het adres van een klant. Vanuit de testsessie was staging niet
bereikbaar; de rooktest van de uitrol (`scripts/supabase-smoke-test.sh`, deploy-run 182) leest de
instellingen wel en gaf groen: zelf registreren staat uit (`disable_signup`), een e-mailadres moet
bevestigd worden (`mailer_autoconfirm` uit), een adreswijziging wordt op beide adressen bevestigd
(`mailer_secure_email_change_enabled`) en een wachtwoord is minstens 12 tekens. Portaalaccounts
ontstaan alleen via `portal-login`, voor adressen die bij een klant horen. De rooktest controleert
dit bij elke uitrol opnieuw.

## Zelf draaien

```bash
npx supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,edge-runtime,postgres-meta,realtime,storage-api
npm install --no-save xss@1.0.15 fast-xml-parser@4.5.0
npm run test:stromen                     # alles, of: npm run test:stromen -- facturen
RESOFLY_CHROMIUM=/opt/pw-browsers/chromium node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs
```

Zie `tests/stromen/README.md`.
