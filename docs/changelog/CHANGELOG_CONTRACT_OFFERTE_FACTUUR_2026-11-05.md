# Changelog — Controle contract, offerte en factuur — 2026-11-05

## Aanleiding

> Controleer de gehele contract, offerte en factuur flow. Controleer maximaal en nauwkeurig op
> fouten, functionaliteiten en security.

Zes deelcontroles (contracten, offertes, facturen, betalingen, database, Gerrie/API/portaal) vonden
67 punten. Alles staat met ernst en status in
`docs/rapporten/REVIEW_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md`. Hieronder wat er is veranderd.

## Wat je merkt in de app

### Contracten

- **"Terug naar concept"** bij een verstuurd, geweigerd of verlopen contract. De oude
  ondertekenlink werkt daarna niet meer; pas het contract aan en verstuur het opnieuw.
- Een verstuurd contract kun je niet meer verwijderen (bewaarplicht). Trek het in.
- Na het versturen liggen inhoud, klant en nummer vast, ook na ondertekenen.
- Mislukt het (opnieuw) versturen, dan werkt de link die de klant al had gewoon door.
- De contract-PDF bevat alle tekst die de klant op de pagina ziet, ook regels uit de editor
  (`<div>`), tabellen en geneste lijsten. Namen als "Łukasz Dvořák" staan er herkenbaar op.

### Offertes

- **"Intrekken"** bij een verstuurde offerte. De klant kan daarna niet meer akkoord geven; de
  pagina zegt "Ingetrokken".
- De offerte-PDF bevat geen akkoordlink meer. De link staat in de mail aan de klant.
- Akkoord en afwijzing via de link leggen IP-adres, browser en het uitgenodigde adres vast, en of
  het ingetypte adres daarmee overeenkomt.
- Een offertenummer kan maar één keer voorkomen.
- Versturen lukt ook als de opslag van de PDF in R2 even niet werkt (dan in de database).

### Facturen

- Met de **kleineondernemersregeling (KOR)** krijgen nieuwe regels 0% btw, en een factuur met btw
  gaat niet de deur uit.
- **Herinneren en aanmanen** kan niet meer voor een concept, en een aanmaning pas na de
  vervaldatum.
- **"Crediteren" en "Bewerken"** blijven beschikbaar na een verlopen betaallink.
- Een terugbetaalde of gecrediteerde factuur verandert niet meer via de status.
- Het portaal en de publieke factuurpagina tonen wat er nog openstaat, niet het factuurbedrag.

### Gerrie, de API en MCP

- Een ander **e-factuuradres** gaat altijd langs een mens, met het oude en het nieuwe adres op de
  kaart. Via de API vraagt het ook schrijfrecht in Financiën.
- **Contract ter ondertekening:** het adres staat in de titel van de kaart, met een waarschuwing
  als het niet het adres van de klant is. Een herinnering gaat naar wie de vorige link kreeg.
- **Bewerkkaarten** tonen oud → nieuw bij een ander e-mailadres (klant, contactpersoon met
  portaaltoegang) en bij een project dat naar een andere klant gaat.
- **"Betaald"** zetten kan alleen nog voor een factuur uit de beginbalans. Voor andere facturen:
  koppel de banktransactie of boek een memoriaalpost op Debiteuren.
- Een creditnota gaat naar het e-factuuradres als de klant e-facturatie heeft, net als de factuur.

## Wat er onder de motorkap is veranderd

### Database (`20261105230000_contract_offerte_factuur_controle.sql`)

- **anon heeft geen gebruiksrecht meer op schema `public`.** Op `supabase/postgres` 17.6.1.111 liet
  een geweigerde functieaanroep de hele database crashen. Een weigering op het schema crasht
  niet. Alle andere rollen kregen het recht expliciet terug (PUBLIC eraf). De rooktest bewaakt
  het en meldt de Postgres-versie.
- **Contracten:** status, interne goedkeuring, verzend- en intrekvelden zet alleen de server
  (`enforce_contract_workflow_fields_server_only`); bevriezen na versturen
  (`enforce_contract_signed_immutability`); nieuwe overgangen (verstuurd/geweigerd/verlopen →
  concept, verlopen → verstuurd); `reopen_contract`; niet verwijderen na versturen; projecten van
  een vorige klant vallen weg; één Word-bestand per contract.
- **Offertes:** `withdraw_quote`; akkoord en afwijzing met bewijs en lengtegrenzen;
  `decide_quote_portal` controleert zelf dat de offerte van de klant van de portaalgebruiker is;
  de offertelink staat gemaskeerd in verzendregels en versies; versies rekenen per tarief; datums
  in Nederland; unieke nummers.
- **Facturen:** het grootboek boekt de btw per tarief, met de regels gelezen zoals de totalen;
  regels met een aantal, prijs of tarief dat geen getal is, weigert de database; KOR; geen
  herinnering of aanmaning voor een concept; eindstatus na crediteren of terugbetalen; versies
  per tarief; nummers niet afgekapt en uniek ongeacht hoofdletters en spaties.
- **Betalingen:** de terugbetaalgrens telt het hele factuurbedrag bij gemengd betalen; geen
  creditnota voor te veel betaald geld; `refunded` loopt niet terug; de pagina na het betalen
  werkt 60 dagen; een betaling die binnenkwam toen de factuur nog niet te boeken was (een betaald
  concept), wordt geboekt zodra de factuur geboekt wordt.
- **Overig:** pushmelding "Factuur betaald" alleen voor wie Financiën ziet; herinnerings- en
  aanmaningsinstellingen alleen voor beheerders.

De migratie kan veilig opnieuw draaien. Hij heette eerst `20261105030000`; staging kreeg intussen
een andere migratie met die versie.

### Edge functions en gedeelde code

- Nieuw in `supabase/functions/_shared/`: `financeTotals.ts` (bedragen zoals `src/lib/money.ts`),
  `publicLinkExpiry.ts` (link geldig tot en met de einddatum), `portalAccess.ts` (portaal per
  klant van het document), `pdfText.ts` (tekst en HTML voor de contract-PDF),
  `mollieWebhookUrl.ts` (nooit de webhook van billing). Elk met een test.
- `contract-workflow`: geen ondertekenlink terug naar de verzender; quotum en versie vóór de mail;
  bij een fout de oude link en ondertekenaar terug.
- `contract-public`: de akkoordtekst is die van de server; lengtegrenzen.
- `quote-workflow` / `quote-public`: geen link terug; quotum vóór de opslag; terugval op de
  database; bewijs bij akkoord.
- `invoice-workflow`: KOR en quotum vóór de betaallink; webhook 503 als een betaling niet te
  controleren is; onbekende uitkomst bij een Mollie-terugbetaling houdt het bedrag gereserveerd;
  eigen databasemeldingen als zin met een 4xx; mock alleen voor de eigen organisatie.
- `client-portal` / `invoice-public`: alleen documenten van de eigen klant; het openstaande bedrag.
- `mollieSecrets.ts`: versleutelen vraagt `MOLLIE_TOKEN_ENCRYPTION_KEY`; geen ingebouwde sleutel.
- `workers/media-api`: routes voor offerte-PDF's (`/internal/quote-snapshot`).
- Gerrie-handelingen (`_shared/actions/`) en de kaarten in de app (`src/lib/gerrie-proposals.ts`)
  zoals hierboven beschreven; `apiResources.ts` kent `writeModule` voor velden waarvan alleen het
  zetten bij een andere module hoort.
- `documentLayout.ts` (app en edge functions, teken voor teken gelijk): een letter buiten WinAnsi
  wordt vertaald ("Ł" → "L") of één vraagteken, in plaats van te verdwijnen.

## Uitrol

1. Merge naar `staging`: de workflow zet de migratie en de edge functions en draait de rooktest.
2. **Postgres upgraden naar ≥ 17.6.1.178** (Project Settings → Infrastructure). Zie het rapport,
   actie 1. Test de crash niet op staging.
3. `workers/media-api` uitrollen (offerte-PDF's in R2).
4. Secrets controleren: `MOLLIE_TOKEN_ENCRYPTION_KEY` gezet; `INVOICE_MOLLIE_WEBHOOK_URL` wijst naar
   `…/functions/v1/invoice-workflow` of is leeg.
5. De oude `cloudflare-worker` uitzetten als die nog draait.

## Getest

- `npm test`: 1065 van 1065 groen.
- `npm run typecheck`: schoon.
- Edge functions met `tsc` (instellingen als `deno check`): de 34 uit de CI-lijst plus de
  offerte-, factuur-, portaal- en publieke factuurfunctie, zonder nieuwe meldingen.
- `supabase db reset`: de hele keten vanaf nul; de nieuwe migratie daarna nog een keer.
- Alle reproducties uit de controle opnieuw gedraaid op de verse database, met de verwachte
  uitkomst (weigeren of het juiste bedrag).
- `npm run test:mobile -- --theme=both`: 324 pagina's gemeten (licht en donker; telefoon, tablet en
  liggend; ook de publieke offerte-, factuur- en contractpagina en het portaal), 0 met problemen.
- `npm run test:loading`: alle controles geslaagd.
