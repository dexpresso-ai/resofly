# Controle financiën eenmanszaak: wat fout gaat, moet te herstellen zijn

**19 november 2026 · database, schermen, Gerrie en tests · staging**

Doel: nagaan of een zzp'er met een eenmanszaak in ResoFly kan boekhouden zonder
fouten die hij niet meer kan rechtzetten. De controle van 18 november liep het
gewone jaar door (inrichten, factureren, inkopen, bank, aangiften, afsluiten).
Deze controle zocht waar het misgaat als iets níet gewoon loopt: een verkeerde
boeking terugdraaien, iets vergeten in een afgesloten tijdvak, overstappen uit
een ander pakket, een dubbel ingelezen afschrift.

> **Status:** twee migraties (`20261119180000_financien_herstelwegen` en
> `20261119190000_facturen_herstel`), aanpassingen in de schermen van Bank,
> Activa, Boekjaren, Omzetbelasting, Grootboek, Inkoopfacturen, Facturen,
> Inkomstenbelasting en Eigen vermogen, in de handelingen van Gerrie, en twee
> nieuwe stromenscenario's (`herstelwegen` en `factuurherstel`). Uitrol: zie
> onderaan.

## Werkwijze

- **Zes reviews tegelijk**, elk op één onderdeel: verkoop en debiteuren, de
  bank, de omzetbelasting, grootboek en jaarafsluiting, de inkomstenbelasting,
  en inkoop met bonnen. Elke reviewer speelde zijn bevindingen na als eigenaar,
  met zijn eigen sessie (RLS geldt), tegen een lokale stack met alle
  migraties. Ruim vijftig bevindingen, op vier na alle nagespeeld.
- **Zelf in de browser**: een eenmanszaak met een gevuld 2025 (afgesloten) en
  2026 (lopend), en een eenmanszaak van één dag oud, op alle vijftien
  financiële pagina's. Geen JavaScript-fouten.
- **Bewaarplicht nagespeeld**: wat de eigenaar via de API kan wissen of
  wijzigen aan een verstuurde factuur, een geboekte inkoopfactuur, een
  boekstuk, een aangifte. Dat zat goed (zie "Wat goed zat").
- **Elke bevinding is daarna in de code bevestigd** en, waar het om geld gaat,
  vastgelegd in een stromentest die vóór de fix faalde.
- **Belastingbedragen** voor 2025 en 2026 nagelopen via zoekresultaten die de
  Belastingdienst en de wet citeren (belastingdienst.nl en wetten.overheid.nl
  waren niet rechtstreeks te openen), en negentien gevallen per jaar met de
  hand nagerekend.

## Wat goed zat

Nagelopen en niet veranderd:

- **De gewone stromen kloppen op de cent.** Afronding en gemengde btw op een
  factuur, deelcreditnota's per tarief, de rubrieken van een compleet kwartaal
  (1a t/m 5g), de ICP-opgaaf tegenover rubriek 3b, de betaling van de aangifte
  via 1530, de suppletie van begin tot eind.
- **Debiteuren en crediteuren sluiten aan** op de openstaande posten, in elk
  gespeeld scenario en per peildatum.
- **De jaarafsluiting over drie jaren**, met verlies en negatief vermogen,
  heropenen in omgekeerde volgorde, en de kapitaalvergelijking: begin + winst
  + stortingen − opnamen = eind = begin van het volgende jaar.
- **De balans sluit** op elke peildatum, ook vóór de eerste boeking en na
  afsluiten of heropenen.
- **Wat vastligt, ligt vast.** Een verstuurde factuur, een geboekte
  inkoopfactuur, een boekstuk, een aangifte en een gebruikte grootboekrekening
  zijn via de API niet te wissen of te wijzigen; een klant of leverancier met
  facturen ook niet.
- **De tabellen van de inkomstenbelasting** voor 2025 en 2026: schijven,
  heffingskortingen, arbeidskorting, ouderenkorting, zelfstandigenaftrek,
  startersaftrek, mkb-winstvrijstelling, Zvw en de KIA-tabel.
- **Vooruitbetaalde kosten** over de jaargrens, beëindigen, verwijderen en de
  jaarafsluiting.

## De gedeelde oorzaken

De meeste bevindingen kwamen uit vier oorzaken:

1. **Tegenboeken op de datum van vandaag.** "Tegenboeken" in het Journaal en
   "Boeking ongedaan maken" bij de bank boekten op vandaag. Wie in november
   een boeking uit september terugdraaide en opnieuw boekte, kreeg de kosten
   en de btw dubbel in Q3 en negatief in Q4. Over de jaarwissel verschoof zo
   winst tussen twee boekjaren, en de balans per 31 december toonde de bank en
   de debiteuren verkeerd.
2. **De bank schoof niet door.** Facturen, inkoopfacturen en activa boeken bij
   een afgesloten tijdvak op de eerste open dag. De bank weigerde, met "kies
   een boekdatum", terwijl een bankmutatie geen datum heeft om te kiezen.
3. **Boekingen vóór de start van de boekhouding.** De bank, een inkoopfactuur
   en een activum uit het oude pakket boekten op hun eigen datum, in een jaar
   zonder boekjaar. Het eerste boekjaar ging dan nooit meer dicht.
4. **Het btw-slot hield ook boekingen tegen die de aangifte niet raken.** Na
   het afsluiten van Q4 was omzet niet meer in het goede jaar te zetten.

## Bevindingen en fixes

Ernst: **onherstelbaar** (de zzp'er komt er zelf niet meer uit), **hoog**
(stil foute cijfers of een doodlopende weg met een omweg), **midden**, **laag**.

### Herstellen zonder dat cijfers verschuiven (migratie `20261119180000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | **Terugdraaien en opnieuw boeken zette kosten en btw in twee periodes.** Een pinbetaling van 20 december 2025 in 2026 op een andere rekening zetten: 2025 kreeg € 2.000 kosten in plaats van € 1.000 en € 420 voorbelasting in plaats van € 210, 2026 kreeg − € 1.000. Het jaar sloot zo af. Hetzelfde bij een inkoopfactuur, een afschrijving en de beginbalans. **Nagespeeld.** | De tegenboeking komt op de datum van het boekstuk zelf, of op de eerste open dag daarna als dat tijdvak of boekjaar dicht is. Het venster in het Journaal begint op die datum en zegt waarom. |
| 2 | hoog | **Een bankmutatie met btw in een aangegeven kwartaal was nooit meer te boeken**, en een boeking daar terugdraaien was eenrichtingsverkeer: de mutatie bleef voorgoed "nog te boeken" en de bank stond € 121 scheef. In een afgesloten jaar gold het voor elke bankboeking. **Nagespeeld.** | De boeking komt op de eerste open dag. De datum van de bank blijft op de mutatie staan en staat in de omschrijving; het scherm zegt op welke datum er geboekt is. De aansluiting telt het tijdsverschil mee. |
| 3 | onherstelbaar | **Een activum van vóór de start liet het eerste boekjaar nooit meer afsluiten.** Een laptop uit juli 2023 bij een start per 1 januari 2025: "Boek aanschaf" boekte op 1 juli 2023 (en zette de laptop dubbel op 0100), "Boek t/m" maakte achttien afschrijvingen in 2023 en 2024. 2025 weigerde daarna: "sluit eerst het voorgaande boekjaar af", dat niet bestond. Alles tegenboeken hielp niet. **Nagespeeld.** | Zo'n activum koppel je aan de beginbalans: geen boeking. Wat volgens het schema vóór de start is afgeschreven, telt als afgeschreven ("In beginbalans") zonder boekstuk; vanaf de start boek je gewoon af. De jaarafsluiting noemt de boekstukken die in de weg staan, en een boekstuk met zijn tegenboeking telt niet meer mee. |
| 4 | hoog | **Bankmutaties van vóór de start werden geboekt, ook vanzelf.** Bij een start per 1 oktober haalt de bankkoppeling negentig dagen terug: de incasso van 25 september werd afgeletterd tegen de factuur van oktober en de privé-opname van 10 september was te boeken. De bank stond daarna € 1.036 te laag en het eigen vermogen begon € 1.000 te laag. Wie de mutatie negeerde, hield een blijvend verschil in de aansluiting. **Nagespeeld.** | Zo'n mutatie gaat op genegeerd, met de reden erbij, is niet te boeken en telt niet in de aansluiting. |
| 5 | hoog | **Een inkoopfactuur van vóór de start (of met jaartal 2062) werd op die datum geboekt.** De kosten vielen buiten de winst en de voorbelasting kwam in geen enkele aangifte. | Vóór de start: geboekt op de startdatum, met de factuurdatum in de omschrijving. Meer dan een jaar vooruit: geweigerd. Het formulier en de bonroute waarschuwen bij een onwaarschijnlijke datum, en boeken dan niet vanzelf. |
| 6 | onherstelbaar | **Na het afsluiten van Q4 was omzet niet meer in het goede jaar te krijgen.** Een factuur met datum 20 december boekt dan op 1 januari. Terugzetten met een memoriaal op 31 december werd geweigerd: elke regel op een omzetrekening telde als "raakt de btw-aangifte", ook zonder btw. Een btw-tijdvak heropenen bestaat niet. **Nagespeeld.** | Een omzetregel zonder btw-code raakt de aangifte niet: een afgrenzing op 31 december (nog te factureren, vooruitgefactureerd) kan. Zo'n regel telt ook niet meer in rubriek 1e. Een inkoopfactuur zonder btw blijft op zijn eigen datum. Bij het versturen van een factuur met een datum in een afgesloten tijdvak vraagt het verzendvenster om bevestiging, met de boekdatum erbij (zie 22). |
| 7 | hoog | **Een teruggave op "1500 Te vorderen BTW" telde in de volgende aangifte.** € 315 teruggave daar geboekt gaf in Q4 een voorbelasting van − € 315: te betalen € 525 in plaats van € 210, zonder waarschuwing. Een kasopname op 1000 met 21% boekte € 86,78 voorbelasting. | De bank boekt niet rechtstreeks op de btw-rekeningen (de melding wijst naar 1530) en weigert btw op kas, bank, debiteuren, crediteuren en schulden. |
| 8 | midden | **"ICP diensten" op een inkoop kwam in geen enkele rubriek.** Google Ads uit Ierland: rubriek 4b bleef leeg, en met de KOR werd de verlegde btw nooit betaald. | Een verkoopcode op kosten of een bedrijfsmiddel wordt geweigerd, bij de bank en bij een inkoopfactuur; de keuzelijst toont alleen inkoopcodes. |
| 9 | midden | **Het btw-bedrag van de leverancier was niet in te voeren.** De btw was altijd grondslag × tarief; bij 21% wijkt dat bij ruim één op de zes bontotalen een cent af. De factuur stond dan voor € 24,77 open terwijl er € 24,78 was betaald. | Een btw-bedrag per regel (`vat_cents`), voorgevuld en aanpasbaar; de bonroute neemt het bedrag van de bon over. |
| 10 | midden | **De jaarafsluiting ging door met losse eindjes.** Een niet-geboekte bankmutatie van december was daarna niet meer te boeken, en concepten boekten stil op 1 januari. | Afsluiten weigert met bankmutaties van dat jaar die niet geboekt of genegeerd zijn, met het aantal. Het venster noemt de concepten. Het afsluitvenster van een btw-tijdvak telt de bankmutaties en concepten in dat tijdvak. |
| 11 | midden | **De KOR.** Na het uitzetten ging een concept met code KOR zonder btw de deur uit, buiten elke rubriek. En met de KOR ging het jaar dicht met verlegde btw nog op 1520; daarna was dat tijdvak niet meer af te sluiten. | Zonder de KOR wordt een regel met code KOR geweigerd bij het versturen. Met de KOR weigert de jaarafsluiting zolang er btw openstaat. |
| 12 | midden | **Een boekstuk dat in een suppletie zat, was nooit meer tegen te boeken.** Een dubbel ingevoerde inkoopfactuur bleef voorgoed "geboekt, onbetaald" in de crediteuren. | De blokkade is weg: de tegenboeking telt in de aangifte van zijn eigen datum, zoals het memoriaal dat de melding voorschreef. |
| 13 | midden | **Een gekoppeld activum met een tikfout zat vast.** Koppelen aan een inkoopfactuur boekt niets, maar vergrendelde wel alle velden. | "Koppeling losmaken", zolang er niets is afgeschreven. |
| 14 | laag | Een beginbalans per 2052, "Boek t/m 2062" bij een activum (zestig termijnen in één keer), een gebruikte btw-code verwijderen, de grootboekrekening van een bankrekening wijzigen terwijl er boekingen op staan, een boekjaar met een tikfout dat niet meer weg kon. | Geweigerd, respectievelijk: een leeg boekjaar kan weer weg. |
| 15 | laag | Geen rekening voor bankkosten; 4500 stelt 21% voor, terwijl bankkosten zijn vrijgesteld. "BTW-aangifte doorboeken quarter 2-2026" in het Journaal. | 4750 Bankkosten en verzekeringen (geen btw) bij IB-administraties. "Btw-aangifte Q2 2026". |

### Wat ResoFly vanzelf boekt (migratie `20261119180000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 16 | hoog | **Dezelfde betaling via twee wegen werd dubbel geboekt.** Eerst een afschrift, later de bankkoppeling (met een andere omschrijving): de bankregel boekte de tankbeurt nog eens, en de dubbele incasso werd afgeletterd tegen de factuur van de maand erna. Een dubbele mutatie kon je alleen negeren, en genegeerd telt mee in de aansluiting. **Nagespeeld.** | Staat er al een bankmutatie met dezelfde datum, hetzelfde bedrag en dezelfde tegenrekening, dan boekt ResoFly niets vanzelf en zegt het erbij. "Dubbele verwijderen" kan, alleen voor een nooit geboekte mutatie met een tweede ernaast. |
| 17 | midden | **"Zeker = meteen geboekt" was te ruim.** De incasso van 25 september werd gekoppeld aan de factuur van 5 november; "Factuur HN-2026-11" werd geboekt op HN-2026-10; € 181,50 voor een nieuwe bestelling was toevallig de twee oudste facturen samen. | Niet vanzelf als de betaling ruim vóór de factuurdatum ligt, als de omschrijving een onbekend factuurnummer noemt, of bij een verzamelbetaling op alleen bedragen. Dan is het een voorstel, met de reden. |
| 18 | midden | **Een bankregel boekte de betaling van een open factuur als nieuwe omzet.** "Jansen → 8000 met 21%" maakte van € 1.210 van Bakkerij Jansen € 1.000 omzet en € 210 btw, terwijl de factuur open bleef en de herinneringen doorliepen. Een ontvangst zonder factuurnummer kreeg ook nooit een voorstel. | Een ontvangst met de naam van de klant en precies het open bedrag van één factuur krijgt die factuur als voorstel, vóór de bankregels. |
| 19 | laag | Een betaling aan de Belastingdienst zonder aangifte met dat bedrag kreeg niets. | De reden wijst de weg: btw op 1530, inkomstenbelasting of Zvw op 0550 Privé-opnamen. |

### Facturen herstellen (migratie `20261119190000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 20 | hoog | **Een deels betaalde factuur was niet te crediteren.** Factuur € 1.210, € 400 betaald, de rest vervalt (schikking, oninbaar). Crediteren weigerde en wees naar twee wegen die niet werkten: terugbetaling ("alleen betaalde facturen") en een memoriaalpost (de factuur bleef € 810 open en herinneringen liepen door). **Nagespeeld.** | Het venster Crediteren toont wat betaald is en wat openstaat, en crediteert het restant (of een deel), per btw-tarief verdeeld. Daarna is de factuur afgehandeld. |
| 21 | hoog | **Terugbetalen gaf in beide richtingen foute cijfers.** Zonder creditfactuur stond een volledig terugbetaalde factuur op "Terugbetaald" met omzet en btw nog in de boeken, en kon er nooit meer een creditnota komen. Mét creditfactuur bij een dubbele betaling (het redenveld stelde dat zelfs voor) werd terechte omzet van € 500 weggeboekt. **Nagespeeld**, ook via Mollie. | Twee keuzes: "de verkoop gaat (deels) niet door" (creditfactuur) of "de klant betaalde te veel of dubbel" (alleen geld terug, de factuur blijft betaald). "Creditfactuur alsnog maken" voor een eerdere terugbetaling zonder. |
| 22 | midden | **Een factuurdatum in een aangegeven kwartaal zette de omzet stil in het volgende jaar.** Een decemberfactuur verstuurd na het afsluiten van Q4: geboekt op 1 januari, zonder melding. Een datum vóór de start van de boekhouding: verstuurd, nooit geboekt, en de meldingen daarna wezen naar elkaar. | Het verzendvenster vraagt vooraf om bevestiging, met de boekdatum en of dat een ander boekjaar is; bij een datum vóór de start zegt het dat de factuur niet in de boekhouding komt. De meldingen zeggen wat je dan wel doet (zie ook fix 6). |
| 23 | midden | **Oninbaar afboeken kon alleen met Crediteren, en dan kreeg de klant een creditfactuur.** | "Afboeken als oninbaar": dezelfde creditnota, zonder mail, status Afgeboekt. |
| 24 | midden | Na € 400 betaald en € 810 gecrediteerd mocht er € 1.210 worden terugbetaald. | Hoogstens wat er betaald is. |
| 25 | laag | Een factuur met een negatief totaal ging de deur uit en was daarna nergens tegen af te letteren. Btw-code en tarief waren niet aan elkaar gebonden (ICP-code met 21% via Gerrie). Twee keer tegelijk versturen gaf twee mails. De creditnotadatum was de UTC-datum. | Geweigerd met de goede weg erbij; een lopende verzending weigert de tweede; de Nederlandse dag. |
| 26 | midden | **Gerries handeling "Factuur crediteren"** zei "het hele bedrag, op geannuleerd", ook bij een deels betaalde factuur. | Dezelfde actie als het venster: het restant of een deel, eventueel zonder mail. |

### Inkoop en het Grootboek (schermen en de bonroute)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 27 | midden | **Het btw-bedrag van de bon of factuur was niet in te voeren** (zie ook 9): de bonroute maakte van een bon van € 10,00 een concept van € 9,99, zonder waarschuwing en met zekerheid "hoog". | Een veld "Btw-bedrag" per regel met 21% of 9%; de bon- en UBL-route nemen het bedrag van het document over bij hooguit twee cent verschil. |
| 28 | midden | **Verlegde btw stond in het totaal.** Een factuur van Google Ireland van € 100 toonde "Totaal € 121", en de bonroute gaf bij elke juist gelezen verlegde factuur de waarschuwing "de bedragen wijken af". Wie die volgde en de code op 0% zette, gaf rubriek 4b niet meer aan. | Verlegde, EU- en invoer-btw staan apart ("zelf aangeven en aftrekken") en tellen niet in het totaal; de totalencontrole rekent hetzelfde. Ook in Gerries inkoopconcept. |
| 29 | midden | **Een concept-inkoopfactuur kon niet weg**; een dubbele bon bleef staan met de knop Boeken ernaast. | "Concept verwijderen"; een concept van een bon gaat via Negeren op de werklijst, zodat de foto bewaard blijft. Een ooit geboekt concept en een declaratie niet, met uitleg. |
| 30 | midden | **Een bon die Gerrie niet las, raakte uit beeld** zodra er 200 nieuwere items waren; de teller telde hem nog wel. | Alles wat aandacht vraagt, wordt altijd geladen. |
| 31 | midden | **Het Journaal tegenboekte op vandaag**, en "beginbalans corrigeren" was "boek tegen en leg een nieuwe vast": de bank stond dan dubbel tussen de twee datums (zie 1). | Het venster begint op de datum van het boekstuk en zegt na afloop waar de tegenboeking kwam. "Beginbalans corrigeren" boekt tegen op de eigen datum en vult het formulier met de oude regels. |
| 32 | laag | Een bonregel zonder btw kreeg code EXPORT; de keuze van een rekening veranderde de btw-code niet; een leverancier met facturen verwijderen gaf de ruwe databasefout; het memoriaal zei niets bij een omzetregel zonder code of een regel op de bank, 0150 of 1300; op de telefoon liepen de regels van het inkoopformulier uit hun kader. | NUL; de code volgt de rekening tot je hem zelf kiest; een gewone zin; uitleg en waarschuwingen in het memoriaal; de regels krimpen mee. |

### Inkomstenbelasting

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| I1 | hoog | **De aftrekbeperking pakte te weinig.** De verhoging ging over het inkomen ná aftrek boven de grens van de hoogste schijf, in plaats van over de aftrekposten tot waar het inkomen mét die posten boven de grens uitkomt (art. 2.10 lid 2). Bij € 90.000 winst in 2026: € 0 in plaats van € 1.381,94. Elke winst tussen ongeveer € 78.000 en € 108.000 kreeg een te lage raming. | Hersteld, met de bedragen voor € 78.000 t/m € 130.000 in beide jaren als test. |
| I2 | hoog | **Overstappen in de loop van het jaar.** Bij een start per 1 juli toonde de raming "Winst 2026" over een half jaar, met de kortingen van een heel jaar. De enige waarschuwing zei het omgekeerde ("telt de boekingen van 1 januari tot en met 31 december"). | De raming zegt dat hij vanaf de startdatum telt en hoe je de eerdere winst erbij zet. Een kort eerste boekjaar is geen gebroken boekjaar meer. Dezelfde melding staat op Eigen vermogen. |
| I3 | midden | **Opslaan bevroor het urencriterium.** Wie in maart alleen zijn voorlopige aanslag invulde, legde het "nee" van die dag vast en hield in november met 1.400 uur geen zelfstandigenaftrek. | Het volgt de uren tot je zelf ja of nee kiest ("Volgens Uren"). In de prognose gaan de uren mee naar 31 december. Een opgeslagen "nee" dat de uren hebben ingehaald, staat in de notities. |
| I4 | midden | **Eigen vermogen en de raming toonden een andere belastbare winst**, onder de tekst "tot op de cent gelijk": € 39.285,00 tegenover € 36.384,02. | Eigen vermogen toont de regels van dezelfde raming. |
| I5 | midden | **Elk activum telde mee voor de KIA, ook een personenauto**: € 30.000 gaf € 8.400 aftrek. | Bij de berekening staat dat je moet nalopen wat meetelt. |
| I6 | laag | De heffingskortingen rekenden met het inkomen ná verliesverrekening in plaats van het verzamelinkomen. Een wijziging verdween zonder vraag als je van jaar wisselde. | Hersteld; van jaar wisselen vraagt om bevestiging. |

### XAF-import

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| X1 | midden | **"Lening Rabobank", "Creditcard ING" en "Spaarrekening Rabobank" werden 1100 Bank.** "Zet in de beginbalans" telde ze op tot één regel: bank € 24.290 credit in plaats van € 3.210 debet, en de leningen stonden nergens meer als schuld. | Zulke rekeningen krijgen geen voorstel. Een waarschuwing als meer rekeningen op de bank samenkomen, als de bank credit uitkomt, en als het bestand geen beginbalans heeft; de knop vraagt dan eerst bevestiging. |

### Dashboard

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| D1 | laag | "Te laat betaald € 6.855,00 · 2 facturen" op het dashboard, "Over de datum: 1" op de pagina Facturen. Het verschil: een concept, en een factuur die vandaag vervalt. | Eén regel voor dashboard, stroom en klantpagina, gelijk aan de database: verstuurd, niet betaald, en de vervaldatum is voorbij. |

## Verificatie

- **Stromentests**: twee nieuwe scenario's. `herstelwegen` (44 stappen): tegenboeken
  en opnieuw boeken in dezelfde periode, de bank in een dicht tijdvak en een dicht
  jaar, de aansluiting met een doorgeschoven boeking, btw op de verkeerde plek, het
  btw-bedrag van de leverancier, vóór de start, een activum uit de beginbalans en
  de beginbalans corrigeren, de KOR, vanzelf boeken en dubbel ingelezen
  mutaties. `factuurherstel` (22 stappen): het restant van een deels betaalde
  factuur crediteren, terugbetalen met en zonder creditfactuur (ook via
  Mollie), afboeken als oninbaar, en de waarschuwingen vóór het versturen.
  `bonnen` kreeg tien stappen, `inkomstenbelasting` één. Elke fix van ernst
  hoog of onherstelbaar faalde in deze scenario's met de oude functies.
- **De volledige stromentest** (alle scenario's) op een database die vanaf nul
  is opgebouwd: 1298 stappen, 1 fout. Die ene was "sleutels aanmaken" in
  `automatisering`: de lokale gateway gaf "an invalid response was received
  from the upstream server". Het scenario apart opnieuw: 10 stappen, 0 fout.
  Het raakt niets van deze wijziging.
- **Databasetests** (`npm run test:database`): alle vier geslaagd, op de verse
  database. De verzamelbetaling in `bank_inkoop_afletteren.sql` is nu een
  voorstel (fix 17).
- **De keten vanaf nul** (`supabase db reset`, alle migraties): schoon. Beide
  nieuwe migraties daarna nog eens: schoon.
- **Lokaal**: `npm run typecheck` schoon; `npm test` 2108/2108;
  `npm run test:mobile -- --theme=both` 812 pagina's, 0 problemen;
  `test:loading`, `test:inrichten` en `test:terugknop` geslaagd;
  `migrationGrants.test.ts`: de rechten van elke vervangen functie staan
  expliciet in de migratie.
- **In Chromium tegen de lokale stack**: de nieuwe schermdelen van Activa,
  Bank, Boekjaren en Omzetbelasting (14 controles), Inkoopfacturen en het
  Grootboek (42 controles), de vensters Crediteren en Terugbetaling, en het
  UI-scenario factuur (11 stappen). Geen JavaScript-fouten.
- **Deno-check** (met een importmap naar npm, esm.sh is hier geblokkeerd): de
  35 functies uit de CI-lijst schoon; `invoice-workflow` dezelfde 11 meldingen
  als op staging (staat buiten de CI-lijst).

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Omzet en btw op een eigen datum (`vat_date`) | Een factuur met een datum in een aangegeven tijdvak boekt in zijn geheel op de eerste open dag. Fiscaal hoort de omzet op de factuurdatum en alleen de btw in de volgende aangifte. Dat vraagt een tweede datum op elk boekstuk, en de aangifte, de suppletie en het slot moeten daarnaar kijken. Nu: een waarschuwing vóór het versturen, en de afgrenzing op 31 december kan (fix 6). |
| Een btw-tijdvak heropenen | Bestaat niet, bewust: wat aangegeven is, is aangegeven. Fouten gaan via de volgende aangifte of een suppletie; met fix 1, 2, 6 en 12 is er nu voor elke soort fout een weg. |
| Een standaardcode voor 4600 Eten, drinken en representatie | Horeca-btw is niet aftrekbaar, maar daar is geen eigen code voor; het inkoopformulier legt het uit. |
| Vreemde valuta bij de bank | Een mutatie in dollars is niet te boeken; het advies (memoriaal en negeren) laat een verschil in de aansluiting. Komt bij een zzp'er zelden voor. |
| Memoriaal op de bank, 0150 of 1300 | Het memoriaal waarschuwt nu; de bankmutaties, het activaregister en de openstaande posten volgen zo'n boeking niet. |
| De boekhouder zonder recht op Uren | Ziet bij "Volgens Uren" een raming zonder zelfstandigenaftrek, omdat hij de uren van de eigenaar niet mag lezen. Een afgeleid ja of nee zonder het urental zou dat oplossen. |
| De KOR met een begin- en einddatum, privégebruik auto, het factuurnummer pas bij versturen | Stonden al open sinds 18 november. |

## Uitrol

Twee migraties, in deze volgorde: `20261119180000_financien_herstelwegen` en
`20261119190000_facturen_herstel`. Ze zijn veilig om opnieuw te draaien.

Wat ze met bestaande gegevens doen:

- IB-administraties met een rekeningschema krijgen rekening 4750 Bankkosten en
  verzekeringen (geen btw), met de standaardcode VRIJ.
- Verder niets: de functies werken voor nieuwe boekingen, tegenboekingen en
  overzichten. Bestaande boekingen, aangiftes en jaarafsluitingen veranderen
  niet. Een bankmutatie van vóór de start die al geboekt is, blijft geboekt;
  bij "Opnieuw matchen" gaat alleen een niet-geboekte op genegeerd.

Ook de edge functions (`invoice-workflow`, de handelingen van Gerrie, MCP en
de API, en `invoice-inbox`) gaan mee.

**Staging: uitgerold op 20 november 2026** (merge `bfdfff4`):

- *Deploy Supabase (staging)* run 250: beide migraties toegepast, alle edge
  functions uitgerold, de rooktest geslaagd (ook "anon heeft geen rechten in
  public").
- *Frontend checks* run 270: alles groen (de controles, de migraties vanaf nul
  en de edge functions, met de mobiele lay-outtest in licht en donker).
- Cloudflare Pages bouwt de app bij de push naar `staging`; dat is van hieruit
  niet te zien (het netwerk blokkeert het domein).

De staging-database zelf is niet ingezien; de controle is de uitrol (de CLI
breekt af bij een fout in een migratie), de rooktest, en dezelfde migraties op
een lege en een gevulde lokale database.

Voor productie: dezelfde twee migraties, in volgorde.
