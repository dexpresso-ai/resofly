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
  opgehaald, langst geleden eerst. Binnen een tijdsbudget van 100 seconden; wat niet past,
  komt het uur erna.
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
  weken vooraf klaar (en zolang de toestemming verlopen is en niet vervangen), met een
  actiepunt voor vandaag en "Openen" naar het bankscherm. De kaart vervalt zodra de
  rekeningen aan een nieuwe toestemming hangen. Binnen drie dagen of verlopen: hoog.

## 2.4 — Eigen grootboekrekening per rekening, overboekingen tussen eigen rekeningen
- **Eigen grootboekrekening**: een nieuw gekoppelde rekening komt op 1100. Deelt hij die met
  een rekening met een **ander IBAN**, dan krijgt hij een eigen rekening: 1110, 1120, …
  1180, daarna 1101–1109 (`assign_own_bank_ledger_account`, naam "Bank ‹naam› ‹laatste 4›",
  liquide middelen). Niet bij hetzelfde IBAN (dan is het dezelfde rekening, bijvoorbeeld
  eerst afschriften ingelezen en later gekoppeld), niet zonder IBAN en niet als er al iets
  op is geboekt: verhangen zou de historie splitsen. Pas dan kan de saldo-aansluiting per
  rekening.
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
  geeft of dezelfde terugstuurt. Hoogstens 100 per keer; afgekapt (of tijd op) betekent dat
  `last_synced_at` **niet** vooruitgaat, zodat de volgende sync verdergaat. Vroeger stopte
  hij stil na 25 pagina's en schoof het startpunt toch op: de rest viel buiten het venster
  en kwam nooit meer binnen. De syncmelding zegt nu "nog niet alles opgehaald".
- **Fouten**, met een tekst voor de gebruiker en de technische details in de logs:
  - 401/403 bij het ophalen: óf de toestemming is weg, óf onze eigen sleutel klopt niet.
    `GET /application` met dezelfde sleutel maakt het onderscheid. Toestemming: "koppel
    opnieuw" en de koppeling op verlopen. Sleutel: "dit ligt niet aan je bank", en de
    koppelingen blijven staan. Vroeger gingen bij een sleutelfout alle koppelingen op
    verlopen.
  - Een sessiefout (`EXPIRED_SESSION`, `CLOSED_SESSION`, ingetrokken): "koppel opnieuw".
  - 429: "probeer het over een uur", zonder iets op verlopen te zetten.
  - 5xx of geen antwoord: tijdelijk, later opnieuw.
- Elke opvraging heeft een timeout van 30 seconden.

## Front-end
- `src/features/Bank.tsx`: toestemming op de rekeningkaart, "Opnieuw koppelen", de uitleg bij
  een eigen overboeking, de nieuwe syncmeldingen, en een kortere uitleg bovenaan over de
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
  - de backfill: nieuwste eerst, en hetzelfde IBAN of inactief blijft op 1100.
- **`bank-sync` echt gedraaid** (Deno 2.1), met een nagebootste Enable Banking en database:
  - de cron: een fout secret geeft 401; verlopen toestemmingen worden gemarkeerd; drie
    pagina's (ook na een lege) leveren alleen geboekte transacties op; het saldo wordt
    vastgelegd; er gaan geen PSU-headers mee; het tijdsbudget schuift de rest door;
  - handmatig: PSU-headers op transacties en saldo, niet vanaf een privé-IP;
  - 150 pagina's: na 100 afgekapt, met het startpunt op zijn plek;
  - 401 met een werkende app geeft "koppel opnieuw" en de toestemming verlopen; 401 met een
    geweigerde app geeft de configuratiemelding en de toestemming blijft staan;
  - 429 en `EXPIRED_SESSION`;
  - de duur van de toestemming: 90 dagen min een uur bij een bankmaximum van 90, 180 dagen
    als de bank meer toestaat, 90 als het maximum onbekend is;
  - afronden: de rekening komt op 1100 en daarna wordt de eigen rekening aangevraagd.
- `deno check` op `bank-sync` en `gerrie-signals` met de echte typen van supabase-js ✓.
- `npm test` ✓ (nieuw: PSU-headers, toestemmingsduur, foutsoorten, paginering, de bedrading
  van `bank-sync`, de kaart en de stand van de toestemming); `npm run typecheck` ✓;
  `npm run build` ✓.
- **Scherm** (mock uit `tests/mobile`, desktop en telefoon): de uitleg bij een eigen
  overboeking; "toestemming tot …"; geel twee weken vooraf, rood als hij verlopen is;
  "Opnieuw koppelen" vraagt een toestemming bij dezelfde bank en stuurt door; de meldingen
  bij afkappen en bij een 429; geen horizontale overloop en geen JS-fouten.
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
