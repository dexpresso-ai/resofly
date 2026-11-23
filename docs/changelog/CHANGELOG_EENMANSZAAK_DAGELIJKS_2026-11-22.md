# Controle eenmanszaak: werkt het ook echt, elke dag

**22 november 2026 · database, schermen, Gerrie, MCP, bank en export · staging**

Doel: nagaan of een zzp'er met een eenmanszaak zijn administratie in ResoFly
echt kan voeren. De controles van 18 november (het jaar van inrichting tot
aangifte) en 19 november (herstelwegen) speelden geld vooral na in de
database. Deze controle keek naar wat daar niet bij zat:

- de gewone weg door het scherm, als nieuwe gebruiker;
- bankafschriften van echte banken en de bankkoppeling;
- de jaarwissel naar 2027;
- wat de boekhouder en de Belastingdienst krijgen;
- van uren naar factuur, met Gerrie en MCP.

> **Status:** elf migraties (`20261123090000` t/m `20261123142000`),
> aanpassingen in de schermen van Uren, Projecten, Klanten, Facturen,
> Offertes, Inkoop, Bank, Grootboek, Omzetbelasting, Eigen vermogen,
> Inkomstenbelasting, Boekjaren en het dashboard, in Gerrie, MCP en de API,
> in `bank-sync`, `invoice-workflow` en de media-worker, en vier nieuwe
> stromenscenario's (`urenfactureren`, `factuurregels`, `bewaarplicht`,
> `boekhouder`) plus stappen in de bestaande. Uitrol: zie onderaan.

## Werkwijze

- **Vijf controleurs tegelijk** (Opus 5.5, hoge inspanning), elk op één
  terrein, als eigenaar met de eigen sessie tegen een lokale stack met alle
  migraties. Elke bevinding is nagespeeld of in de code nagelopen, met
  `bestand:regel`, en ingedeeld als eenvoudig of moeilijk.
- **De moeilijke beslissingen** (uren factureren, bewaarplicht van de
  e-factuur en de bewijsstukken, wat de boekhouder mag, een verkeerd ingelezen
  afschrift, de jaarwissel) zijn genomen en gebouwd door Fable 5.2. Een
  gebruikslimiet en twee herstarts van de werkomgeving onderbraken dat werk;
  Opus 5.5 (hoog) heeft het nagelopen, afgemaakt en getest. De regels rond
  offerte en factuur heeft Opus 5.5 (hoog) ontworpen en gebouwd.
- **De eenvoudige fixes** door Opus 5.5, elk met een test die vóór de fix
  faalde.
- **De auditfile** is getoetst tegen het officiële XSD van XAF 3.2, de
  e-facturen tegen de regels van EN 16931 en Peppol BIS 3.0.22.
- **Belastingbedragen voor 2027** nagelopen via zoekresultaten die de
  Belastingdienst en de wet citeren (belastingdienst.nl was niet bereikbaar).

## Wat goed zat

- **Door het scherm klopt alles op de cent.** Inrichting als eenmanszaak,
  klanten, uren, offerte → factuur, een ING-afschrift inlezen en afletteren,
  privé, pinbetalingen, inkoop en een bon, Q3 afsluiten en betalen: winst
  € 1.626,35, btw € 43, balans sluitend, eigen vermogen € 2.826,35. Geen
  JavaScript-fouten, geen mislukte aanroepen, op desktop en telefoon.
- **Winst en btw: Gerrie en MCP geven dezelfde cijfers als het scherm**,
  rubriek voor rubriek.
- **De jaarwissel loopt niet vast.** Op 2 januari 2027 krijgt een factuur
  FAC-2027-0001, alles boekt door, Q4 2026 staat met de deadline op het
  dashboard, en het beginvermogen van 2027 is het eindvermogen van 2026.
- **De auditfiles van 2025 en 2026 waren geldig** (bij korte namen) en sluiten
  op de cent op de proefbalans, ook na heropenen. Terug inlezen geeft dezelfde
  saldi.
- **De pdf van een verstuurde factuur blijft byte voor byte gelijk**, ook na
  een nieuw adres, IBAN of klantnaam. Financiële tabellen zijn via de database
  niet te wissen; een gestopt abonnement wist niets.
- **Het inlezen**: hetzelfde afschrift twee keer of overlappende periodes geeft
  geen dubbele mutaties; posten in behandeling komen niet binnen; CAMT v02/v08
  en de CSV van ING, Rabobank en bunq leveren de juiste bedragen.

## Bevindingen en fixes

Ernst: **hoog** (stil foute cijfers of een doodlopende weg), **midden**,
**laag**. Er was niets onherstelbaars.

### Van uren naar factuur (migratie `20261123110000_uren_factureren`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | **Geen weg van geschreven uren naar een factuur.** Geen knop, geen koppeling, uren bleven na het factureren te wijzigen; toch beloofde het scherm "geregistreerde uren vormen de factuurbasis". Dubbel factureren of vergeten viel niet op. | **"Uren factureren"** op Uren, het project en de klant: de declarabele uren van een periode worden één conceptfactuur, samengevoegd per project en tarief of één regel per registratie (dat is meteen de urenspecificatie), met afronding naar keuze. Eén databasefunctie rekent het voorbeeld, het concept en Gerries voorstel. Uren op een factuur liggen vast (`time_entry_invoices`) en komen weer vrij als het concept weg gaat of de factuur wordt geannuleerd of volledig gecrediteerd; een deelcreditnota is een prijscorrectie. Het concept weigert als het bedrag sinds het voorbeeld veranderde. Uren zonder tarief worden apart gemeld. |
| 2 | hoog | **Gerrie factureerde maar 25 urenregistraties**: 27,5 van 121 uur, € 7.947,50 te weinig, zonder het te zeggen. | Gerrie zet een urenfactuur klaar met `invoice.from_time_entries` (dezelfde functie als de knop, na goedkeuring). `list_time_entries` telt over de hele periode, met tarief en waarde per regel en `truncated`. |
| 3 | laag | Elke maand dezelfde factuur overtypen. | **"Factuur kopiëren"**: een nieuw concept met dezelfde klant en regels. Terugkerende facturen bewust niet: een verstuurde factuur ligt vast, dus een fout wordt dan elke maand een creditnota. Wie dat wil, laat een geplande agent een factuur voorstellen. |

### Gerrie en MCP: dezelfde cijfers als het scherm

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 4 | hoog | **"Welke facturen staan open?" zag alleen de 25 nieuwste.** Met 26 nieuwere facturen zei Gerrie "0 open" bij € 810 open. Hetzelfde bij offertes die op antwoord wachten. | Eerst filteren, dan afkappen, in pagina's van duizend; `count` en totalen gaan over alles, met `truncated`. |
| 5 | midden | **Urencriterium "niet gehaald" bij 1.270 uur**: de API geeft hooguit 1.000 rijen. De prognose van een starter rekende vanaf 1 januari. | Alle uren in pagina's; de prognose vanaf de eerste geregistreerde dag, zoals het scherm. Ook `project.dashboard` telt alle uren. |
| 6 | midden | **Drie bedragen "openstaand"**: dashboard € 1.210, Gerrie € 1.815 (met een concept als open én te laat), grootboek € 810. | Een concept staat nooit open. Openstaand komt uit het grootboek: een deelbetaling of deelcreditnota is eraf, ook op het dashboard, de klantpagina, de projectpagina en in de stroom (`list_open_invoice_amounts`, migratie `20261123090000`). |
| 7 | midden | **Gerries "omzet" was € 3.630, Winst & verlies € 2.500**: met btw en concepten. | Gefactureerd met en zonder btw, zonder concepten; voor omzet en winst wijst Gerrie naar `ledger.profit_and_loss`. |
| 8 | midden | `ledger.open_items` met "alleen te laat" noemde het totaal van alles. | Het totaal van wat te laat is, met het totaal van alles ernaast. |
| 9 | laag | Gerries urenfactuur hing niet aan het project; `list_projects` gaf geen tarief. | `propose_invoice` kent een project; `list_projects` geeft tarief en factuurwijze (met leesrecht op Financiën). |

### Offerte en factuur

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 10 | midden | **De vervaldatum volgde de factuurdatum niet**: een factuur van 15-09 kreeg 6-12, met "binnen 14 dagen" op dezelfde pdf. Herinneringen kwamen twee maanden te laat. | De vervaldatum schuift mee zolang hij de termijn uit de bedrijfsgegevens volgt; een zelf gekozen datum blijft staan. |
| 11 | laag | "12,95" werd 1295 in een Engelstalige browser. | De bedragvelden lezen een komma. |
| 12 | laag | De factuurpagina van de klant toonde "PDF-snapshot … sent_to_client" en een grijze "Betaal nu" zonder Mollie; de offertemail noemde de geldigheid van de link als verloopdatum; vaktaal ("via Resend", "server-side", "Mollie records"). | Gewone woorden, geen knop zonder betaallink, geen "Geldig tot" zonder verloopdatum. |

### Wat de deur uit gaat (migratie `20261123120000_factuurregels`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 13 | midden | **"Verzonden" in het statusveld (of via Gerrie `invoice.set_status`) sloeg de controles van het versturen over**: een ICP-factuur aan een Belgische klant zonder btw-nummer werd geboekt en stond in de ICP-opgaaf zonder nummer, zonder vastgelegde pdf, en zonder de vraag bij een afgesloten tijdvak. | De database weigert dat een concept rechtstreeks op verzonden, te laat of betaald gaat (trigger `invoices_issue_via_server`); het statusveld biedt het bij een concept niet meer aan. Wie zelf mailt of print, kiest **"Uitgeven zonder mail"**: dezelfde controles als versturen, de pdf wordt vastgelegd, en dan boekt en vergrendelt hij. Uitzondering: een factuur van vóór de startdatum (overstap), die niet geboekt wordt. |
| 14 | midden | **0% zonder reden aan een klant in het buitenland** ging zonder vermelding en zonder controle op het btw-nummer de deur uit, in rubriek 1e in plaats van 3b, en niet in de ICP-opgaaf. | Bij 0% kies je een reden. Versturen en uitgeven weigeren 0% zonder code, NUL aan een klant in een ander EU-land, export aan een klant in de EU en ICP aan een klant in Nederland of buiten de EU, met een zin die zegt wat je moet kiezen. Het land komt uit het klantveld, anders uit het btw-nummer. Gerrie moet bij 0% een code meegeven. |
| 15 | midden | **Een factuur uit een offerte had altijd 14 dagen**, terwijl op dezelfde pdf "binnen 30 dagen" stond. | De betaaltermijn uit de bedrijfsgegevens (`payment_term_days`, dezelfde regel als in de app). |
| 16 | laag | **Korting op het totaal bij twee btw-tarieven** gaf € 1,20 te weinig btw. | Het formulier vraagt of de korting voor het hele bedrag geldt, met de knop "Verdeel over de tarieven" (naar rato, op de cent). Pdf, e-factuur, boeking en aangifte rekenen daardoor ongewijzigd. |
| 17 | midden | Een voorschot- of termijnfactuur bij een offerte kon niet. | Niet gebouwd (zie Bewust open). De bevestiging bij "Maak factuur van offerte" legt de omweg uit. |


### Bank (migraties `20261123100000_bank_inlezen` en `20261123130000_bank_herstel_verkeerd_ingelezen`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 20 | hoog | **Een afschrift van een andere rekening ging er zonder controle in**: een CSV met de spaarrekening kwam op de zakelijke rekening. | De lezers geven per regel de eigen rekening mee. Een andere rekening vraagt eerst bevestiging; bij twee rekeningen alleen de eigen regels met het eigen saldo. |
| 21 | hoog | **Een verkeerd ingelezen regel kreeg je er niet meer af**: blijvend € 5.000 verschil in de aansluiting. | "Niet van deze rekening" en "Afschrift terugdraaien" voor regels die nooit geboekt zijn; een geboekte mutatie blijft bij zijn boekstuk en tegenboeking (bewaarplicht). Het logboek legt het vast en de aansluiting klopt daarna. |
| 22 | hoog | **Na opnieuw koppelen viel een gat stil weg**: de bank gaf maar 90 dagen terug, de sync telde als geslaagd. | De periode die de bank niet meer levert, staat bij de rekening met de datums en de knop "Gezien": lees daarvoor een afschrift in. |
| 23 | hoog | **Revolut Business**: "in behandeling" en "teruggedraaid" telden mee, kosten vielen weg (€ 308,17 verschil). | Alleen voltooide regels, met kosten, kenmerk en de Nederlandse datum. |
| 24 | midden | MT940 sloeg bij elk volgend afschrift vals alarm; ING brak namen en IBAN's van de tegenpartij af; Knab werd geweigerd; een CSV zonder kopregel (ASN/SNS/RegioBank, Triodos, ABN AMRO) werd geweigerd; één 403 zette de hele koppeling op verlopen; een storno had de zzp'er zelf als tegenpartij. | Hersteld per lezer. Zonder kopregel alleen als het zeker bij een bank past (kolommen, IBAN, en bij ABN AMRO en ASN een doorlopend saldo); anders een melding welke export wel werkt. |
| 25 | laag | De saldomelding zei altijd "er ontbreken transacties"; bunq zonder IBAN van de tegenpartij; ISO-8859-1 verminkte é en ë; de reden bij een voorstel noemde een factuurnummer dat niet in de omschrijving stond. | Hersteld. |

### Bewaarplicht en de boekhouder (migraties `20261123131000` t/m `133000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 30 | hoog | **Eén klant met een naam langer dan 50 tekens maakte elke auditfile ongeldig.** Ook: geen btw op omzetregels van 21% zonder code, een boekstuknummer van 36 tekens, en geen btw-nummer bij de KOR. | Elk veld met een maximum wordt afgekapt; een omzetregel krijgt de code zoals de aangifte hem afleidt; factuurnummer per regel en adres, KvK en IBAN bij klanten en leveranciers. De beginbalans van het eerste jaar staat als beginbalans. Getoetst tegen het XSD (de test staat in de repo). |
| 31 | midden | **De e-factuur werd niet bewaard zoals verstuurd**: een latere download had de gegevens van vandaag, en niet in de export. | `sent_e_invoices`: het verstuurde bestand blijft precies zo, terug te halen en in de volledige export. Van e-facturen van vóór vandaag is het origineel er niet; het scherm zegt dat. |
| 32 | midden | **Het bewijsstuk van een geboekte inkoopfactuur was via de API te wissen of te vervangen.** | De database en de media-worker weigeren; een extra bijlage toevoegen kan wel. |
| 33 | midden | **De boekhouder kon niets boeken of afsluiten**: geen memoriaal, geen btw-aangifte, geen heropening. | Een schakelaar per boekhouder, standaard uit: "mag boeken en afsluiten". Factureren, Mollie en het team blijven van de eigenaar; Gerrie en MCP blijven voor de boekhouder alleen lezen. |
| 34 | midden | E-factuur ongeldig bij ICP (geen leverdatum en land), bij een kortingsregel (negatieve prijs) en bij export (categorie); e-mail als elektronisch adres. | Leverblok, hoeveelheid en prijs omgedraaid, categorie G, een Peppol-ID uit het EU-btw-nummer. |
| 35 | laag | Btw-aangifte per tijdvak, kapitaalvergelijking en IB-overzicht waren niet te bewaren. | Een CSV-knop, zoals bij Winst & verlies. |

### De jaarwissel (migraties `20261123140000` t/m `142000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 40 | midden | **De IB-raming 2027 rekende met de bedragen van 2026**, ook de zelfstandigenaftrek. | 2027 rekent met de zelfstandigenaftrek van € 900 (art. 3.76 Wet IB, afbouw uit het Belastingplan 2023) en verder met de tabel van 2026, onder "Voorlopige raming". Voor starters rekent de melding uit wat de voorgestelde afbouw van de startersaftrek scheelt. |
| 41 | midden | **Aanmaningen zouden na 1 januari stil met de rente van 2026 rekenen.** | Het aanmaningsvoorstel waarschuwt als de rente van het halfjaar ontbreekt. De wettelijke rente per 1 juli 2026 (4%) is toegevoegd. `dunning.test.ts` faalt vanaf 15 januari 2027 tot de tarieven per 1 januari erin staan: zo vergeet niemand het. |
| 42 | laag | Boekjaar 2027 ontstond niet vanzelf. | Bij een IB-onderneming opent het nieuwe kalenderjaar vanzelf bij de eerste boeking erin (trigger), met een knop op Eigen vermogen. |
| 43 | laag | In januari openden Omzetbelasting en Inkomstenbelasting op het nieuwe jaar. | Omzetbelasting op het oudste tijdvak dat nog moet; Inkomstenbelasting tot 1 mei op het aangiftejaar. |
| 44 | laag | **Rond middernacht telde de database in UTC**: een Mollie-betaling om 00:30 op 1 januari kwam op 31 december; afsluiten tussen 0:00 en 1:00 werd geweigerd. | Vijf functies rekenen met de Nederlandse dag. |
| 45 | laag | Het scenario `eenmanszaak` zou vanaf 1 januari 2027 falen. | Los van het jaartal van vandaag. |

### Inkoop, inrichting en telefoon

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 50 | midden | Een nieuwe leverancier kon niet vanuit het inkoopformulier; wat je typte, was weg. | "+ Nieuwe leverancier…" in het formulier. |
| 51 | laag | Een bon stond pas na verversen op de werklijst; na de inrichting moest je de bankrekening zelf aanmaken; op de telefoon liepen de btw-aangifte en "Mutatie invoeren" uit beeld; de projectpagina had twee keer "Gefactureerd"; "Omzet deze maand" was incl. btw. | Hersteld; de tegel heet "Ontvangen deze maand". |

## Verificatie

- **De keten vanaf nul**: alle migraties op een lege database (een tweede,
  losse stack), daarna de elf nieuwe nog eens: schoon. `npm run test:database`
  op die database: alle zes bestanden geslaagd, ook `rls_een_keer_per_query`
  van staging (zie "Samenvoegen met staging").
- **Lokaal** op de samengevoegde branch: `npm run typecheck` schoon,
  `npm test` 2218/2218.
- **Stromentests**: de volledige suite op een vanaf nul opgebouwde stack:
  1439 stappen, 0 fout (alle scenario's, ook de vof-scenario's van staging en
  de vier nieuwe). Een eerdere run gaf vijf fouten in `herinneringen` omdat hij
  tussen 0:00 en 1:00 Nederlandse tijd liep (de test rekent in UTC, de code
  sinds fix 44 met de Nederlandse dag); daarna opnieuw: 66/66.
- **Schermtests**: `npm run test:mobile -- --theme=both`: 884 pagina's; vier
  gaven "eerste item op 287px > 280px" op het dashboard en de app-werkruimte
  (telefoon). Dat bleek de week: de testgegevens rekenen vanaf de maandag van
  deze week, en sinds maandag 23 november toont de omzettegel een trendlabel.
  Op staging zonder deze wijzigingen precies hetzelfde. De grens is nu 290px,
  met uitleg; daarna 0 problemen. `test:loading`, `test:inrichten` en
  `test:terugknop` geslaagd. UI-stromen in Chromium (`tests/stromen/ui.mjs`):
  factuur, bank en vooruitbetaald geslaagd; `inrichten` faalt op vier stappen,
  op staging net zo: de test kent de stap "Wil je AI gebruiken?" (15 november)
  nog niet. Dat staat los van deze controle.
- **Deno-check** (met een importmap naar npm; esm.sh is hier geblokkeerd): de
  37 functies uit de CI-lijst schoon; `invoice-workflow`, `quote-workflow`,
  `invoice-public` en `bank-sync` houden hun bekende meldingen (11, 9, 4 en 1,
  zoals vóór deze controle).
- **Naspelen**: de vragen uit de controle opnieuw tegen de lokale stack via de
  API (oktober: 121 uur / € 10.285, te laat € 810, urencriterium 1.270,5 uur
  gehaald), de auditfile van de controle-eenmanszaak opnieuw tegen het XSD
  (2025 en 2026, eigenaar en boekhouder: geldig), de e-facturen opnieuw tegen
  de regels, de bankbestanden uit de controle opnieuw ingelezen.

## Samenvoegen met staging

Staging kreeg op 22 november ook `20261122100000_vof_verdeling_per_boekjaar`,
`20261122110000_vof_bank_inkoop_prive` en `20261122200000_rls_een_keer_per_query`.
Twee van onze migraties hadden hetzelfde versienummer; `supabase db push` had ze
als al toegepast overgeslagen. Onze elf migraties heten daarom
`20261123090000` t/m `20261123142000`, in dezelfde volgorde. Verder:

- `close_fiscal_year` (fix 44) start van de vof-versie van staging, met alleen
  de Nederlandse datum erbij; de oudere basis had de verdeling per boekjaar
  weer weggehaald. Geen andere functie wordt door beide kanten vervangen.
- De leespolicies van `time_entry_invoices` en `sent_e_invoices` zoeken de
  rechten één keer per query op (regel 5 in `supabase/migrations/README.md`).
  `tests/database/rls_een_keer_per_query.sql` telde precies 290 omgezette
  leespolicies; dat is nu "minstens 290", anders breekt elke nieuwe tabel in de
  goede vorm de test.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Terugkerende facturen | Een verstuurde factuur ligt vast; zie fix 3. |
| Een voorschot- of termijnfactuur bij een offerte | Raakt de unieke index (één factuur per offerte), de omzetfunctie, de btw bij vooruitbetaling (verschuldigd bij ontvangst) en wat "gefactureerd" bij een offerte betekent. Nu: het concept aanpassen tot het eerste deel, de rest als nieuwe facturen bij hetzelfde project. |
| Bij een deelcreditnota kiezen of uren vrijkomen | Nu blijven ze gefactureerd: een deelcreditnota is een prijscorrectie. |
| Een waarschuwing bij het kopiëren van een factuur met uren | De kopie kan dezelfde uren nog eens factureren als je de regels laat staan. |
| IB-tabel 2027 en de rente per 1 januari 2027 | Nog niet vastgesteld; zie fix 40 en 41. |
| Bankformaten zonder echte voorbeeldbestanden | Revolut, Knab en de CSV zonder kopregel zijn gebouwd op gedocumenteerde formaten. Wijkt een echt bestand af, dan weigert de lezer het; bevestig met een echt bestand. |
| Het saldo uit de bankkoppeling | Zou de aansluiting ook zonder afschrift sluitend maken; welk saldotype per bank is nog niet zeker. |
| E-mail als elektronisch adres bij een particulier of een koper buiten de EU | Peppol keurt het af, weglaten ook (R010); EN 16931 en NLCIUS accepteren het. |
| De KOR met een begin- en einddatum, privégebruik auto, het factuurnummer pas bij versturen | Stonden al open sinds 18 november. |

## Uitrol

<!-- UITROL -->
