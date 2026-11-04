# Controle financiën en BV: de hele module doorgelicht en hersteld

**4 november 2026 · database, edge functions en schermen · staging**

Doel: de financiële module en de BV-onderdelen volledig nalopen op juistheid
(boekhouding, btw, Nederlands recht), dataintegriteit en beveiliging, en wat niet
klopt meteen herstellen.

> **Status:** 51 bevindingen hersteld in vijf migraties (`20261104000000` t/m
> `20261104040000`), twee edge functions (`invoice-workflow`, `bank-sync`), de
> handelingen van Gerrie/API/MCP en de schermen. Elke databasefix is eerst droog
> nagespeeld op staging, in een transactie die altijd werd teruggedraaid. Wat
> bewust open blijft, staat onderaan.

## Werkwijze

- **Live op staging, alleen lezen.** De definities van 184 financiële en BV-functies
  en 67 tabellen (kolommen, constraints, triggers, RLS, grants) zijn via de
  Supabase Management API opgehaald. De bron was dus wat er echt draait, niet de
  223 migraties.
- **Vier inhoudelijke reviews tegelijk:** grootboek en rapportages, verkoop en
  betalingen, btw/bank/inkoop, en de BV-module. Daarnaast een eigen
  securityronde over directe schrijfrechten, organisatiegrenzen, edge functions
  en de handelingen van Gerrie, API en MCP.
- **Elke bevinding zelf nagetrokken** in de live code. De ernstige zijn op
  staging nagespeeld vóór de fix, en daarna nog eens mét de fix.
- **Tarieven gecontroleerd** tegen openbare bronnen:
  - Vpb 2021–2026, gebruikelijk loon (2026: € 58.000), excessief lenen,
    dividendbelasting en de groottecriteria (Stb. 2015, 349 en Stb. 2024, 52)
    kloppen;
  - de handelsrente van 1-1-2026 (10,15%) en 1-7-2026 (10,40%) stond nog op
    "verifieer" en is nu geverifieerd.

## Bevindingen en fixes

### Grootboek, periodes en jaarafsluiting (migratie `20261104000000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | Viel een boekjaar precies samen met een btw-periode (eerste boekjaar 1-10 t/m 31-12 = Q4), dan sloeg de jaarafsluiting het jaarslot stil over: de sleutel van `closed_periods` kende het soort slot niet. Het resultaat telde dubbel op de balans en het volgende jaar was nooit meer af te sluiten. **Op staging nagespeeld.** | Sleutel inclusief `period_type`. Ontbrekende jaarsloten van afgesloten jaren worden aangevuld. |
| 2 | hoog | Een afgesloten btw-periode hield élke boeking tegen. Wie Q4 indiende vóór de jaarafsluiting (de aangifte moet eind januari binnen zijn), kon de afschrijving, lonen of overlopende posten van december alleen nog op 1 januari boeken, dus in het verkeerde jaar. | Een btw-slot houdt alleen boekingen tegen die de aangifte raken (omzet, btw-rekeningen, verlegd/EU/invoer). Het boekjaarslot houdt alles tegen. |
| 3 | hoog | `finalize_vat_return` nam van/tot van de aanroeper aan. Een gewoon teamlid zette zo een ingediende aangifte terug op "doorgeboekt" (saldo 0, periode 2099), of vergrendelde met één aanroep de hele administratie voorgoed. **Op staging nagespeeld.** | De periode volgt uit soort, jaar en nummer. Een afgesloten aangifte blijft staan (corrigeren gaat met een suppletie), en een periode die een ander btw-slot overlapt kan niet worden afgesloten. |
| 4 | midden-hoog | De doorboeking van een btw-aangifte was tegen te boeken. De aangifte telde dan in een open periode nog eens mee. | Geweigerd, en de knop is weg in het scherm en bij Gerrie. |
| 5 | midden | Teruggedateerd boeken vóór of in een afgesloten boekjaar kon, zolang er geen slotrij op die datum lag. Zo veranderde de balans van een afgesloten (misschien al gedeponeerd) jaar. | Alles tot en met het einde van het laatst afgesloten boekjaar ligt vast. |
| 6 | midden | Een boeking kon tussen het optellen en het vergrendelen in het jaar of de btw-periode glippen. | Eén grendel per organisatie: boekingen nemen hem gedeeld, afsluiten exclusief. |
| 7 | laag | Een boekjaar dat nog loopt, was af te sluiten. | Pas vanaf de dag na de laatste dag. |
| 8 | midden | Een beginbalans was na tegenboeken nooit te vervangen (de tegenboeking telde zelf als beginbalans), en een tegenboeking was zelf weer tegen te boeken. | Opgelost in de database, in het scherm en bij Gerrie. |
| 9 | laag | Boekstuknummers vanaf 100.000 per jaar werden afgekapt (dubbele nummers). | Volledig nummer. |

### Activa (migraties `20261104000000` en `20261104030000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 10 | midden | Op een afgestoten activum kon nog worden afgeschreven ("Herbereken schema" en "Boek t/m"). | Geweigerd, knoppen verborgen. |
| 11 | midden | Een activum tegenboeken in het grootboek liet het register staan. De desinvestering boekte dan de verkeerde cumulatieve afschrijving af, en een tegengeboekte termijn bleef voorgoed "geboekt". | Het register gaat mee terug, in de juiste volgorde: eerst desinvestering, dan afschrijvingen, dan aanschaf. |
| 12 | midden | Een geboekt activum was te verwijderen. Ook waren boeking en status terug te zetten (dubbele aanschaf of desinvestering) en kon de gebruiksduur na afschrijven nog wijzigen. | Zodra er iets geboekt is liggen de financiële velden vast. Boeking, status en desinvestering zet alleen de server. |

### Btw-aangifte (migratie `20261104010000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 13 | hoog | Rubriek 2a/4a/4b telde een tegenboeking dubbel in plaats van terug: € 1.000 EU-verwerving tegengeboekt gaf 4b € 2.000 / € 420 in plaats van nul. **Op staging nagespeeld.** | De richting komt alleen nog van de boekzijde. |
| 14 | midden | Een boekstuk dat al in een afgesloten aangifte zat, kon nog eens in een suppletie (dubbele voorbelasting). | Geweigerd. |
| 15 | laag | Met de KOR stond op de btw-pagina "de aangifte is nihil". Verlegde btw moet je ook dan aangeven. | Tekst aangepast. Bij de beginbalans staat nu een hint over 1530. |

### Bank (migratie `20261104010000`, `bank-sync`, MT940)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 16 | hoog | Een bankboeking met IMPORT (invoer of diensten van buiten de EU, rubriek 4a) werd als binnenlandse btw gesplitst: voorbelasting zonder aangifte en te lage kosten. | Verlegd geboekt, net als EU-verwerving. |
| 17 | hoog | Een factuur die volledig per bank was betaald, bleef op "verzonden" staan en werd "te laat". De klant kreeg daarna herinneringen en een aanmaning met incassokosten, terwijl hij al had betaald. **Op staging nagespeeld.** | Bij volledige betaling gaat de factuur op betaald, en na terugdraaien weer terug. |
| 18 | midden | Het openstaande saldo van een factuur telde alleen bankboekingen, dus een via Mollie betaalde of gecrediteerde factuur kon nog eens worden afgeletterd. | Eén berekening voor de hele app (`invoice_open_receivable_cents`): bank, Mollie, creditnota's, terugbetalingen en chargebacks. |
| 19 | midden | MT940: rond de jaarwisseling kreeg de boekdatum het verkeerde jaar, en de ING-tegenpartij (`/CNTP/`) werd niet gelezen. | Opgelost, met tests. |
| 20 | laag | Een bankkoppeling (PSD2) kon worden afgerond door een ander teamlid dan wie hem startte. | Alleen de starter rondt af. |

### Inkoopfacturen (migratie `20261104010000`, factuur-inbox)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 21 | midden | Een creditnota van een leverancier of een kortingsregel kon niet worden geboekt (databasefout). | Negatieve groepen komen aan de andere kant. |
| 22 | midden | Met de KOR verdween verlegde btw (EU-dienst, verlegd, invoer) uit de administratie. | Btw op 1520, zonder aftrek, bij de kosten. |
| 23 | midden | Een factuur in vreemde valuta werd 1-op-1 als euro's geboekt, ook automatisch vanuit de inbox. | Boeken weigert niet-EUR met uitleg. De inbox boekt zo'n factuur niet vanzelf. |
| 24 | laag | Een e-factuur met verlegde btw (AE) ging altijd naar rubriek 2a, ook van een Duitse of Amerikaanse leverancier. | Op het land van de leverancier: 2a, 4b of 4a. |

### Verkoopfacturen, offertes en aanmaningen (migratie `20261104020000`, `invoice-workflow`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 25 | hoog | Een geboekte factuur op geannuleerd, ongeldig of afgeboekt zetten liet omzet en btw in het grootboek en de aangifte staan. Een onbetaalde factuur crediteren kon niet. | Nieuwe actie **Crediteren**: een creditfactuur voor het hele bedrag, die het grootboek terugboekt en de factuur op geannuleerd zet. De database weigert annuleren zolang er iets openstaat. Ook via API en MCP. |
| 26 | hoog | Offerte → factuur liet de btw-code vallen (ICP, export of verlegd werd 0% binnenland, rubriek 1e) en rondde prijzen af (1000 × € 0,125 werd € 130). **Op staging nagespeeld.** | De regels komen uit de bevroren offerte zelf. |
| 27 | hoog | De factuur-pdf noemde bij 0% niet de reden ("btw verlegd", "intracommunautaire levering") en ook niet de grondslag per tarief (art. 35a Wet OB). | Verplichte vermeldingen en "BTW 21% over € …" op de factuur, de creditfactuur en de conceptpdf in de app. Zonder btw-nummer van de klant komt er bij verlegd of ICP geen factuur. |
| 28 | midden | Herinneringen en aanmaningen gingen naar al voldane facturen. De aanmaning rekende rente en incassokosten over het factuurtotaal in plaats van over het openstaande bedrag. | Ze kijken naar het openstaande saldo. Een geannuleerd voorstel blokkeert geen nieuwe aanmaning meer. |
| 29 | midden | De openstaande-postenlijst toonde elke via Mollie betaalde factuur als openstaand. | Mollie telt mee. |
| 30 | midden | De opgeslagen totalen rondden de btw per regel af, de rest van de app per tarief. Ook waren ze los te overschrijven, terwijl API, webhooks en bankmatching ze gebruiken. | Per tarief, en altijd uit de regels. |
| 31 | midden | Een factuur met een negatieve groep (korting zonder code, correctie) liep stil vast bij het boeken. | Negatieve groepen aan de debetzijde. |
| 32 | midden | Een gedeeltelijke terugbetaling werd één creditregel met een "gemengd" tarief (bijv. 15%), dat geheel in één rubriek viel. | Per btw-groep van de factuur, exact optellend (met tests). |
| 33 | midden | Via API of MCP kon een verzonden factuur terug naar concept. | Geweigerd, ook op het moment van uitvoeren. |
| 34 | laag | Welke offerteversie de klant accepteerde en wie besliste, was achteraf aan te passen. | Alleen de server. |
| 35 | laag | Mollie kreeg bij elke betaallink van dezelfde factuur dezelfde idempotentiesleutel, zodat een nieuwe checkout na verloop de oude terug kon krijgen. | Per betaalrecord. |

### Mollie: chargebacks en terugbetalingen (migratie `20261104020000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 36 | hoog | Bij een chargeback bleef de factuur op betaald, en kon hetzelfde geld nog eens worden terugbetaald. | De factuur staat weer open en het geld is niet nog eens terug te betalen. De boeking is debet 1300 / credit 1102, en gaat terug als de chargeback wordt teruggedraaid. |
| 37 | midden | Het geld van een Mollie-terugbetaling werd nooit geboekt: 1300 bleef negatief en 1102 te hoog. | Debet 1300 / credit 1102 bij afronding. Een complete cyclus (betaling, chargeback, terugdraaien, terugbetaling, creditnota) komt op staging uit op nul voor 1102, 1300, 1510 en 8000. |

### Integriteit en directe schrijfrechten (migratie `20261104030000`)

Deze tabellen schrijft de app zelf, dus teamleden met schrijfrecht kunnen ze ook
rechtstreeks (via de API) wijzigen. Wat de boekhouding raakt, lag alleen in de
schermen vast.

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 38 | midden | Grootboekrekeningen: code, soort en subsoort waren te wijzigen, ook bij systeemrekeningen en rekeningen met boekingen. De balans van een afgesloten jaar sloot dan niet meer. | Vast bij systeemrekeningen en zodra er geboekt is. Naam en rubriek blijven vrij. |
| 39 | midden | Btw-codes: een systeemcode of gebruikte code was om te zetten naar een andere rubriek of een ander tarief, waardoor elke herberekening anders telde. | Vast. Label en actief blijven vrij. |
| 40 | laag | Deellinks van facturen: teamleden konden zelf een link-rij invoegen, ook voor een factuur van een andere organisatie (die de pagina daarna weigerde). | Alleen de server maakt links, en altijd voor een factuur van dezelfde organisatie. |
| 41 | midden | Aandeelhoudersregister: overdragen of intrekken van meer aandelen dan iemand had gaf negatieve posities en een verkeerde dividendverdeling. Ingekochte aandelen intrekken ging alleen door ze nog eens van een aandeelhouder af te halen. | Het register weigert negatieve posities. "Ingekochte aandelen (de vennootschap zelf)" is te kiezen bij een intrekking, ook voor Gerrie. |

### De BV (migratie `20261104040000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 42 | hoog | De grootteklasse (art. 2:395a/396/397 lid 1 BW) sprong naar de rauwe klasse van dit jaar zodra twee jaren afweken. Zo werd middelgroot, middelgroot, groot, klein "klein" zonder controleplicht, terwijl de wet middelgroot geeft (met controleplicht). Testvector 1 klopte zelf ook niet. | Regel per klasse. Alle testvectoren zijn op staging nagerekend, plus drie nieuwe. |
| 43 | hoog | De uitkeringstoets (art. 2:216 lid 1 BW) negeerde het lopende resultaat: een interim-dividend kon een verlies van dit jaar negeren. De winstbestemming toetste op de balansdatum, en een teruggedateerd besluit zag latere uitkeringen niet. | Eigen vermogen inclusief lopend resultaat, getoetst op de besluitdatum én op vandaag. Het laagste telt. |
| 44 | hoog | Het balanstotaal voor de groottetoets ging omlaag door een creditsaldo op een activarekening (de BV is de DGA geld schuldig, roodstand). In de balans stond zo'n saldo als negatief activum. | Bruto gerekend. In het balansscherm en de jaarrekening-pdf staat het aan de schuldenkant. |
| 45 | midden | Vpb bij een gebroken boekjaar: het verlies stond onder het eindjaar en werd daardoor het volgende jaar niet aangeboden (te hoge belasting). Een tariefwissel binnen het boekjaar (2021 → 2022) werd niet herkend. | Overal het aanvangsjaar, en de hele tarieftabel wordt vergeleken. |
| 46 | midden | De opgeslagen Vpb-berekening werd aangenomen zoals de aanroeper hem gaf (commercieel resultaat, correcties, verrekend verlies). | Nagerekend tegen het grootboek, de vastgelegde correcties en de verliesadministratie. |
| 47 | midden | De vriendelijke controle bij winstbestemming en dividend keek ook naar btw-sloten en dwong zo een onjuiste besluitdatum af. | Alleen het boekjaarslot. |
| 48 | laag | Dividend aan iemand zonder aandelen op de besluitdatum was mogelijk. De verdeling naar rato rekende met afgeronde percentages (1 en 2 aandelen, € 90.000 gaf € 29.997 / € 60.003). | Geweigerd. De verdeling gaat op het exacte aantal aandelen, ook bij Gerrie. |
| 49 | laag | Jaarrekening van een NV: het gestorte kapitaal telde mee als vrij uitkeerbaar (art. 2:105 lid 2 BW). | Telt niet meer mee. |
| 50 | laag | De rente op de rekening-courant DGA was te boeken voor een jaar dat nog loopt (op het saldo van vandaag), en tegelijk met de jaarafsluiting. | Pas na afloop van het jaar, en via de grendel. |

### Schermen en exports

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 51 | laag-midden | XAF-auditfile: de keuzelijst kende alleen kalenderjaren met de startmaand, dus een gebroken of verlengd boekjaar was niet als geheel te exporteren. Ook gaf de btw op omzetregels het verkeerde debet/credit-kenmerk. | De lijst volgt de boekjarentabel, en het kenmerk volgt de kant van de btw. |
| – | laag | Standaarddatums in de boekhoudformulieren waren de UTC-datum: tussen 00:00 en 01:00/02:00 stond er gisteren, en op 1 januari het vorige boekjaar. | Lokale datum (`todayIso`). |

## Wat gebruikers merken

- **Annuleren van een verzonden factuur gaat via "Crediteren".**
  - In de factuureditor staan geannuleerd, ongeldig en afgeboekt niet meer in de
    keuzelijst zodra de factuur in het grootboek staat.
  - De creditfactuur gaat ook naar de klant.
  - De standaardmail bij een creditfactuur noemt niet meer altijd een terugbetaling.
- **Na het indienen van een btw-aangifte kun je in die periode nog boeken wat de
  aangifte niet raakt**, zoals afschrijvingen, lonen, overlopende posten,
  winstbestemming en dividend. Omzet en btw blijven dicht.
- **Een boekjaar sluit je af na de laatste dag.**
- **Geboekte activa, gebruikte grootboekrekeningen en btw-codes liggen vast.** De
  melding zegt wat je dan wél doet: tegenboeken, of een nieuwe rekening of code maken.
- **Een factuur met verlegde btw of een ICP-levering vraagt het btw-nummer van de klant.**

## Verificatie

- **Droog op staging:**
  - alle vijf migraties samen, met zeven testscripts (49 scenario's), elk in een
    transactie die altijd wordt teruggedraaid;
  - een regressietest op de echte stagingdata gaf vóór en na dezelfde cijfers:
    btw-saldo 2026, balans (sluit op 0) en openstaande posten;
  - achteraf gecontroleerd dat er niets is blijven staan.
- **Lokaal:**
  - `npm run typecheck` ✓;
  - `npm test`: 878/878 groen, waarvan 13 nieuw (creditnotasplitsing,
    btw-vermeldingen app ↔ server, MT940, inbox-valuta);
  - `npm run build` ✓ en de CSP-hash ✓;
  - mobiele lay-outtest op de financiënpagina's, donker en licht: 42 metingen, 0
    problemen.
- **Deno-typecheck:**
  - alle 34 functies uit de CI-lijst zijn schoon;
  - `invoice-workflow` en `bank-sync` (niet in CI) hebben precies dezelfde, al
    bestaande meldingen als vóór de wijziging.

## Uitrol

1. Branch naar `staging`. Cloudflare Pages bouwt de app, en de workflow *Deploy
   Supabase (staging)* draait de vijf migraties (`supabase db push`) en rolt alle
   edge functions uit.
2. Geen nieuwe secrets en geen nieuwe cron-taken.
3. **Voor productie:** dezelfde migraties. De aanvulling van ontbrekende jaarsloten
   (migratie `20261104000000`) en de bijgewerkte bronvermelding van de handelsrente
   doen niets met bestaande boekingen.

## Bewust open, of te verifiëren

| Punt | Waarom nog niet |
|---|---|
| Factuurnummers worden nog in de browser bepaald (max+1). Uniek is al afgedwongen, doorlopend nog niet. | Server-side nummeren bij uitgifte raakt de hele editor- en verzendflow. Apart oppakken. |
| Achterwaartse verliesverrekening (art. 20 Wet Vpb, één jaar terug) zit niet in het rekenhart. | Vraagt een eigen boeking (teruggaaf over het vorige jaar) en een keuze in het scherm. |
| `post_journal_entry` neemt elk boekstuktype aan van een directe aanroep. | Netjes oplossen vraagt een vlag in alle interne aanroepers. Het risico is laag: wie het kan, kan al memoriaal boeken. |
| Het gearchiveerde jaarrekening-pdf is te vervangen door opnieuw te renderen. | Vraagt het vastleggen van de pdf per deponering. |
| ICP-opgaaf voor suppleties, en afronden in het voordeel van de belastingplichtige. | Het eerste is een uitbreiding. Het tweede mag maar hoeft niet; nu wordt er rekenkundig afgerond. |
| Een wissel van kwartaal- naar maandaangifte midden in het jaar maakt dat jaar niet af te sluiten. | Zeldzaam. Vraagt een andere btw-poort bij het afsluiten. |
| Banktransacties met een datum in een afgesloten jaar zijn niet te boeken (geen doorschuiven naar de eerste open datum). | Stond al open sinds juli. Vraagt een keuze in het scherm. |
| BV-details uit de review: termijnen coöperatie (6 + 4 maanden), de art. 2:210 lid 5-route bij vaststelling door de AvA, vrijgestelde dividenden zonder aangiftetermijn, correcties na finaliseren nog wijzigbaar, en de keten van de groottetoets die na een onderbreking niet vanzelf herstart. | Laag. Staan op de lijst voor de BV-e2e-ronde. |
| De "renteloze grens" van € 17.500 bij de rekening-courant DGA. | Nalopen of daar een wettelijke basis voor is; het scherm verbindt er gevolgen aan. |
| Securityronde: het eindrapport van de losse security-review kwam niet terug. | De ronde is zelf gedaan (directe schrijfrechten, organisatiegrenzen, edge functions, handelingen). Wat daaruit kwam staat hierboven (14, 20, 33, 38–41). |
