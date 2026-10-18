# Bank — de koppeling loopt vanzelf (2026-10-18)

## Wat & waarom
Na blok 1 kwam een betaling via de bank goed in de boekhouding — maar alleen als iemand
op "Synchroniseer" klikte, zolang de toestemming liep (die verliep onzichtbaar), en met
alle gekoppelde rekeningen op één grootboekrekening. Dit is stap 2 uit het bouwplan
(`ENABLEBANKING_BOEKINGEN_ONDERZOEK_2026-10-18.md` §6, blok 2.2–2.5): de koppeling laten
lopen zonder handwerk.

Migratie: `supabase/migrations/20261018010000_bank_koppeling_loopt_vanzelf.sql` (bouwt
voort op `20261018000000`; beide nog nergens uitgerold).

## 2.2 — Geplande sync
- `bank-sync` heeft een machine-ingang: `POST ?cron=sync` met de header `x-cron-secret`
  (`BANK_SYNC_CRON_SECRET`), vóór de origin-check, net als de crons van `invoice-workflow`.
- Elk uur (pg_cron): eerst gaan verlopen toestemmingen op `expired`, daarna worden de
  rekeningen opgehaald die aan de beurt zijn. Welke dat zijn, bepaalt de nieuwe RPC
  `bank_accounts_due_for_sync`: toestemming geldig, actief, langer dan **twaalf uur** niet
  opgehaald, niet in een wachttijd na een fout, langst niet geprobeerd eerst. Binnen een
  tijdsbudget van 100 seconden en hoogstens 40 per rekening; wat niet past, komt het uur
  erna.
- Twaalf uur, omdat een bank zonder de gebruiker erbij maar **vier opvragingen per 24 uur**
  hoeft toe te staan (PSD2), en een sync er twee doet (transacties en saldo).
- Klikt de gebruiker zelf op "Synchroniseer" (of koppelt hij een bank), dan gaan zijn IP en
  browser mee als **PSU-headers** (`Psu-Ip-Address`, `Psu-User-Agent`). Die opvraging telt
  dan niet mee voor die vier. Alleen met een publiek IP; een intern adres gaat niet mee.
- Nieuwe transacties lopen zoals altijd door `import_bank_transactions`, dus de matcher
  draait mee en het saldo wordt vastgelegd.

## 2.3 — Toestemming: zichtbaar, op tijd verlengen
- **Duur**: standaard 180 dagen (de PSD2-grens sinds juli 2023), begrensd door wat de bank
  toestaat (`maximum_consent_validity`, in seconden, met een uur speling). Vraagt een
  koppeling meer dan de bank toestaat, dan weigert de bank hem helemaal. Is het maximum niet
  op te halen, dan 90 dagen: dat staat elke bank toe.
- **Rekeningkaart**: "toestemming tot …"; twee weken vooraf een gele waarschuwing met
  **Opnieuw koppelen**; verlopen is rood. Verlopen telt ook als de datum voorbij is terwijl
  de status nog `linked` zegt (de cron zet die pas bij zijn volgende ronde om).
- **Opnieuw koppelen** vraagt een nieuwe toestemming bij dezelfde bank. Na terugkeer hangt
  de afronding de bestaande rekeningen (op extern id of IBAN) aan de nieuwe toestemming:
  geen nieuwe rekeningen, geen andere grootboekrekening, de boekingen blijven.
- **Beslislijst**: nieuwe regelkaart `bank_consent_expiring`. De veegronde zet hem twee
  weken vooraf klaar (en zolang de toestemming verlopen is en niet vervangen, hoogstens 30
  dagen), met een
  actiepunt voor vandaag en "Openen" naar het bankscherm. De kaart vervalt zodra de
  rekeningen aan een nieuwe toestemming hangen. Binnen drie dagen of verlopen: hoog.

## 2.4 — Eigen grootboekrekening per rekening, overboekingen tussen eigen rekeningen
- **Eigen grootboekrekening**: een nieuw gekoppelde rekening komt op 1100. Deelt hij die met
  een rekening met een **ander IBAN**, dan krijgt hij een eigen rekening: 1110, 1120, …
  1180, daarna 1101–1109 (`assign_own_bank_ledger_account`, naam "Bank ‹naam› ‹laatste 4›",
  liquide middelen). Niet bij hetzelfde IBAN (dan is het dezelfde rekening, bijvoorbeeld
  eerst afschriften ingelezen en later gekoppeld), niet zonder IBAN, niet als er al iets
  op is geboekt (verhangen zou de historie splitsen) en niet als er op de gedeelde rekening
  iets anders dan bankboekingen staat, zoals een beginbalans. Eén toekenning tegelijk per
  organisatie. Pas dan kan de saldo-aansluiting per rekening.
- Bestaande gekoppelde rekeningen krijgen er bij de migratie één volgens dezelfde regels,
  nieuwste eerst (de oudste blijft op 1100).
- **Overboeking tussen eigen rekeningen**: is de tegenrekening een andere actieve
  bankrekening van de organisatie, dan stelt de matcher **1190 Kruisposten bankrekeningen**
  voor (aangemaakt als hij er nog niet is). Beide kanten daarop geboekt vallen tegen elkaar
  weg. Dit gaat vóór de factuurherkenning: een eigen IBAN zegt meer dan een getal in de
  omschrijving. Op de transactie staat een uitleg.
- De standaard-grootboekrekening is altijd 1100 (de keuze was ongesorteerd: met 1110 erbij
  kon een nieuwe rekening op die van een andere bank belanden). Ook in het formulier voor
  een handmatige rekening.

## 2.5 — Foutafhandeling en paginering
- **Paginering**: alle pagina's, ook na een lege, tot de bank geen `continuation_key` meer
  geeft of dezelfde terugstuurt. In stukken van hoogstens 30 dagen en hoogstens 100 pagina's
  per stuk (te veel: het stuk in tweeën); na elk stuk staat vast hoe ver hij is, en afgekapt
  (tijd op) gaat de volgende sync daar verder — zie "Na de review", punt 1. Vroeger stopte
  hij stil na 25 pagina's en schoof het startpunt toch op: de rest viel buiten het venster
  en kwam nooit meer binnen. De syncmelding zegt nu "nog niet alles opgehaald".
- **Fouten**, met een tekst voor de gebruiker en de technische details in de logs:
  - 401/403 bij het ophalen: óf de toestemming is weg, óf het gaat om één rekening, óf onze
    eigen sleutel klopt niet. `GET /application` met dezelfde sleutel en daarna
    `GET /sessions/{id}` maken het onderscheid. Toestemming weg: "koppel opnieuw" en de
    koppeling op verlopen. Eén rekening: de fout staat bij die rekening. Sleutel: "dit ligt
    niet aan je bank", en de koppelingen blijven staan. Vroeger gingen bij een sleutelfout
    alle koppelingen op verlopen.
  - Een sessiefout (`EXPIRED_SESSION`, `CLOSED_SESSION`, ingetrokken): "koppel opnieuw".
  - 429: "probeer het over een uur", zonder iets op verlopen te zetten; de geplande sync
    wacht een halve dag.
  - 5xx of geen antwoord: tijdelijk, later opnieuw (met toenemende wachttijd).
- Elke opvraging heeft een timeout van 30 seconden.

## Na de review
Een tweede tegenlezer heeft deze stap aangevallen: met een eigen kopie van de database, de
echte `bank-sync` tegen een nagebootste bank, en twee gelijktijdige sessies. Dertien punten;
wat er nu anders is:

1. **Een trage rekening kwam nooit verder.** Afkappen hield het startpunt vast, maar de
   volgende ronde begon met hetzelfde venster en liep weer vast; en één trage rekening at
   elke ronde het hele budget op. Nu haalt een sync op in stukken van hoogstens 30 dagen, van
   oud naar nieuw, en na elk stuk staat vast hoe ver hij is (`sync_through`); de volgende
   sync gaat daar verder. Per rekening hoogstens 40 seconden per ronde, en de ronde neemt de
   langst niet geprobeerde rekening eerst (`sync_attempted_at`). Past al het eerste stuk niet,
   dan is het de volgende keer half zo groot (`sync_slice_days`); lukt een hele sync, dan weer
   groter. Het saldo komt pas mee als alles binnen is.
   Bij het testen bleek nog iets: de week overlap (voor transacties die de bank met een
   eerdere datum naboekt) gold ook midden in een achterstand, zodat een trage rekening elke
   ronde een week opnieuw ophaalde. `sync_through` betekent nu "t/m hier staat alles vast":
   nooit de laatste week (die komt dus steeds opnieuw), maar een achterstand gaat verder waar
   hij was.
2. **Een falende rekening stond elk uur vooraan.** Nu een wachttijd na een fout: 1, 2, 4 …
   uur, hoogstens een dag, na een 429 een halve dag (`sync_failures`, `sync_retry_after`).
   De fout staat op de rekening (`sync_error`) en op de rekeningkaart.
3. **Eén weigerende rekening zette de hele toestemming op verlopen.** Een 401/403 kan ook
   over één rekening gaan (een creditcard die niet meer gedeeld wordt). Nu beslist de sessie
   bij Enable Banking: een eindstatus, of een sessie die niet meer bestaat, betekent
   toestemming weg; anders blijft de fout bij die rekening en lopen de andere door. Is Enable
   Banking zelf even weg, dan is het tijdelijk. Lukt een sync daarna weer, dan gaat een ten
   onrechte verlopen toestemming terug naar gekoppeld. De kaart in de beslislijst komt nu ook
   bij een toestemming die zo op verlopen is gezet (de datum ligt dan nog ver weg), en niet
   meer bij een die al langer dan 30 dagen verlopen is.
4. **"Overboeking eigen rekening" ging voor een eigen regel.** Wie voor het IBAN van zijn
   spaarrekening een regel had (bijvoorbeeld automatisch op een eigen tussenrekening), zag
   die genegeerd. Een actieve regel op het IBAN gaat nu voor.
5. **Betaald, volledig gecrediteerd en dan de betaling teruggedraaid** bleef op betaald staan
   zonder dat er iets betaald was. Nu weer open (zie de changelog van blok 1).
6. **Splitsen terwijl er een beginbalans op 1100 staat** maakte de aansluiting van beide
   rekeningen kapot: niemand weet welk deel bij welke rekening hoort. Staat er op de gedeelde
   rekening iets anders dan bankboekingen, dan splitst hij niet; met de hand kan het via
   Bewerk.
7. **Een Mollie-terugboeking op een factuur die de bank sloot** schreef "bankbetaling
   teruggedraaid" in tijdlijn en audit, terwijl die er nog stond. Nu niet meer (blok 1).
8. **Gelijktijdig**: twee koppelingen tegelijk kozen dezelfde vrije code en de tweede liep
   vast op de unieke sleutel; een boeking tijdens het verhangen kon op de oude
   grootboekrekening landen. Nu één toekenning tegelijk per organisatie, en een boeking leest
   de rekening met een lock. Beide volgordes getest met twee sessies.
9. **Opnieuw koppelen met twee rijen op hetzelfde IBAN** (een ingelezen en een gekoppelde) kon
   de nieuwe toestemming aan de ingelezen rij hangen. Nu gaat de al gekoppelde rij voor.
10. **Het IP voor de PSU-header** kwam uit de eerste waarde van `x-forwarded-for`, die een
    browser zelf kan meesturen. Nu eerst `cf-connecting-ip`, dan `x-real-ip`.
11. **Een oude, inactieve rekening zonder IBAN** op 1100 hield het splitsen voor alle andere
    tegen. Een inactieve rekening waarop nooit iets is geboekt, telt niet meer mee.
12. **"Verloopt over 0 dagen"**: de dagen zijn nu kalenderdagen in Nederland ("vandaag",
    "morgen"), op de rekeningkaart en op de kaart in de beslislijst; door de bank beëindigd
    heeft een eigen tekst.
13. **De cron-aanroep** had de standaard-timeout van pg_net (5 seconden): de ronde liep door,
    maar de log zei "mislukt". In de SQL voor de cron staat nu `timeout_milliseconds := 150000`.

En de melding als de bank niet ver genoeg terug gaat, noemt nu de ontbrekende periode
(van … t/m …); hij noemde een verkeerde dag.

## Front-end
- `src/features/Bank.tsx`: toestemming op de rekeningkaart, "Opnieuw koppelen", de uitleg bij
  een eigen overboeking, de nieuwe syncmeldingen (ook de ontbrekende periode), de laatste
  fout van een rekening op zijn kaart, en een kortere uitleg bovenaan over de
  grootboekrekeningen.
- `src/lib/bankConsent.ts`: de stand van de toestemming (met tests).
- Beslislijst: de kaartsoort in `signalRules.ts`, `gerrie-signals`, `decisions-api.ts`, het
  icoon in `DecisionFeed.tsx` en "Openen" naar Bank in `main.tsx`. `signalKinds.test.ts`
  leest de soortenlijst nu uit de laatste migratie die hem definieert.
- `BankInstitution` heet het maximum nu `max_consent_days` (in dagen). Het oude veld
  `transaction_total_days` bevatte seconden en werd nergens gebruikt.

## Verificatie
- **SQL** (lokale Postgres 16 met alle migraties): de 13 scenario's van blok 1 en de 8 na de
  review slagen ook met deze migratie erbovenop. Nieuw:
  - S1: eigen grootboekrekening wel bij een ander IBAN, niet bij hetzelfde of een onbekend
    IBAN, en niet als er al iets geboekt is; andere organisatie geweigerd;
  - S2: een eigen overboeking, beide kanten herkend (ook met een factuurnummer in de
    omschrijving), samen nul op 1190; een inactieve rekening telt niet;
  - S3: de sync-selectie (geldig, actief, twaalf uur, langst geleden eerst);
  - S4: de kaart bij een verlopende toestemming, niet dubbel, en weg na opnieuw koppelen;
  - S5: rechten als echte rollen (`authenticated`/`anon`): sync-selectie, veegronde en
    kruisposten alleen voor de service-role;
  - de backfill: nieuwste eerst, en hetzelfde IBAN of inactief blijft op 1100;
  - na de review: een IBAN-regel gaat voor de eigen overboeking (T4); betaald, gecrediteerd
    en teruggedraaid is weer open (T5); een Mollie-terugboeking laat geen vals bankspoor na
    (T7); de kaart bij een door de bank beëindigde toestemming, niet bij een die lang
    verlopen is (T3); wachttijd en volgorde van pogingen (T2); een inactieve lege rekening
    houdt splitsen niet tegen, een beginbalans wel (T6, T11);
  - **twee gelijktijdige sessies**: twee keer toekennen geeft 1110 en 1120 (vroeger een fout
    op de unieke sleutel); boeken en verhangen tegelijk, in beide volgordes: de bankregel
    staat steeds op de grootboekrekening van de rekening;
  - de proefjes van de tegenlezer opnieuw gedraaid: alle zes geven nu de goede uitkomst.
- **`bank-sync` echt gedraaid** (Deno 2.1), met een nagebootste Enable Banking en database:
  - de cron: een fout secret geeft 401; verlopen toestemmingen worden gemarkeerd; drie
    pagina's (ook na een lege) leveren alleen geboekte transacties op; het saldo wordt
    vastgelegd; er gaan geen PSU-headers mee; het tijdsbudget schuift de rest door;
  - handmatig: PSU-headers op transacties en saldo, niet vanaf een privé-IP;
  - te veel pagina's voor één stuk: in tweeën tot het past (250 transacties, 1 per pagina:
    alles binnen); één dag met 150 pagina's: 100 binnen, en de sync gaat verder;
  - een trage rekening (180 seconden werk, 40 per ronde): ronde 1 halveert het stuk, daarna
    komt elke ronde verder, na 7 rondes klaar; de andere rekeningen al in ronde 1;
  - een storing bij één bank (504 na 30 seconden, vier rekeningen): wachttijd op die
    rekeningen, en de gezonde rekening komt uiterlijk de ronde erna aan de beurt;
  - één rekening die weigert (403, 404, 401 met een sessie zonder eindstatus): de fout blijft
    bij die rekening, de andere lopen door; een sessie met eindstatus of zonder sessie: de
    toestemming verlopen; lukt een andere rekening van dezelfde toestemming wel, dan blijft
    hij gekoppeld;
  - 120 dagen niets opgehaald: vanaf 89 dagen terug, met de ontbrekende periode in de melding;
  - herkoppelen met een ingelezen rij op hetzelfde IBAN: de gekoppelde rij krijgt de nieuwe
    toestemming;
  - 401 met een geweigerde app geeft de configuratiemelding, 401 terwijl Enable Banking zelf
    niet antwoordt "tijdelijk"; beide keren blijft de toestemming staan;
  - 429 en `EXPIRED_SESSION`;
  - de duur van de toestemming: 90 dagen min een uur bij een bankmaximum van 90, 180 dagen
    als de bank meer toestaat, 90 als het maximum onbekend is;
  - afronden: de rekening komt op 1100 en daarna wordt de eigen rekening aangevraagd.
- `deno check` op `bank-sync` en `gerrie-signals` met de echte typen van supabase-js ✓.
- `npm test` ✓ (nieuw: PSU-headers, toestemmingsduur, foutsoorten, paginering, de bedrading
  van `bank-sync`, de kaart en de stand van de toestemming); `npm run typecheck` ✓;
  `npm run build` ✓.
- **Scherm** (mock uit `tests/mobile`, desktop en telefoon): de uitleg bij een eigen
  overboeking; "toestemming tot …"; geel twee weken vooraf, "vandaag" als hij later vandaag
  afloopt, rood als hij verlopen is, en een eigen tekst als de bank hem beëindigde; de fout
  van één rekening op zijn eigen kaart; "Opnieuw koppelen" vraagt een toestemming bij
  dezelfde bank en stuurt door; de meldingen bij afkappen, bij een 429 en bij een
  ontbrekende periode; geen horizontale overloop en geen JS-fouten.
- **Niet getest**: de echte Enable Banking-API (niet bereikbaar vanuit de bouwomgeving).
  Bij de rooktest vooral letten op: het antwoord van `/aspsps` (`maximum_consent_validity`),
  of de bank de PSU-headers accepteert, en de foutcode bij een verlopen sessie.

## Deploy (staging)
1. `supabase db push --linked`: de migraties `20261018000000` en `20261018010000`, in die
   volgorde. Op staging krijgen per organisatie drie van de vier sandboxrekeningen een eigen
   grootboekrekening (1110, 1120, 1130); de oudste blijft op 1100. Er is nog niets op
   geboekt, dus er verschuift geen historie.
2. `supabase secrets set BANK_SYNC_CRON_SECRET=…` (zie de setup-handleiding).
3. `supabase functions deploy bank-sync gerrie-signals --project-ref enzghpduqwaojcxgwarr`.
4. De cron-job `bank-sync-hourly` aanmaken (SQL in `ENABLEBANKING_BANK_SYNC_SETUP_2026-06-25.md`
   §3b). pg_cron en pg_net staan op staging al aan.
5. Branch naar `staging`: Cloudflare Pages bouwt de front-end.
6. Rooktest: eerst de cron met een fout secret (401) en met het goede (samenvatting). Dan
   opnieuw koppelen: de sandbox-toestemming van 26-06 is verlopen. Daarna controleren dat de
   kaart de nieuwe einddatum toont en dat de volgende cronronde de rekening bijwerkt.

## Bewust buiten deze stap
- Splitsen van één overboeking over meerdere facturen, Mollie-uitbetalingen en betere
  herkenning: blok 3.
- Ontkoppelen (de sessie bij Enable Banking intrekken) en live gaan voor alle klanten
  (contract, DPA, prijsmodel): blok 4.
- Een eigen pushmelding voor een verlopende toestemming: de kaart in de beslislijst doet
  dat werk al, met de dagelijkse samenvatting als push.
