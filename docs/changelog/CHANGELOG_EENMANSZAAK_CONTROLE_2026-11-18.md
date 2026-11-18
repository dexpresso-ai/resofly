# Controle eenmanszaak: van inrichting tot aangifte

**18 november 2026 · database, schermen, Gerrie en tests · staging**

Doel: nagaan of de administratie voor een eenmanszaak echt bruikbaar is, werkt
en inhoudelijk klopt. Niet per onderdeel, maar zoals een zzp'er hem gebruikt:
inrichten, factureren, inkopen, de bank, btw-aangiften, afschrijven, het jaar
afsluiten en de cijfers voor de aangifte inkomstenbelasting. Wat niet klopte of
ontbrak, is meteen ingebouwd.

> **Status:** één migratie (`20261118090000_eenmanszaak_controle`), aanpassingen
> in tien schermen en in de handelingen van Gerrie, drie nieuwe rekenmodules
> (`vatPeriods`, `incomeTax`, `vatCodeForAccount`) en een nieuw stromenscenario
> (`tests/stromen/eenmanszaak.mjs`, 35 stappen). Uitrol: zie onderaan.

## Werkwijze

- **Een heel jaar doorlopen**, tegen een lokale stack met alle migraties:
  - eerst in de app, als nieuwe gebruiker: de inrichting als eenmanszaak en de
    financiële pagina's, met schermafdrukken;
  - daarna als stromenscenario: beginbalans, een factuur aan een bedrijf en aan
    een particulier, inkoop, een camera via een inkoopfactuur, de bank met
    privé-opnamen en -stortingen, vier btw-aangiften, afschrijving,
    jaarafsluiting en de kapitaalvergelijking. Het jaar is 2025, met 2026 als
    lopend jaar erachter.
- **Drie reviews tegelijk** op de functies zoals ze in de database draaien:
  btw en KOR, facturen en debiteuren, de IB-boekhouding. Elke bevinding is
  daarna zelf nagelopen in de code en, waar het om geld gaat, nagespeeld.
- **Bedragen** nagelopen via bronnen die de Belastingdienst citeren
  (belastingdienst.nl was vanuit de werkomgeving niet bereikbaar):
  zelfstandigenaftrek 2025 € 2.470 en 2026 € 1.200, startersaftrek € 2.123,
  mkb-winstvrijstelling 12,70%, gemengde kosten € 5.700 of 80%, KOR-grens
  € 20.000, deadline btw-aangifte de laatste dag van de maand na het tijdvak.

## Wat goed zat

Nagelopen en niet veranderd:

- **Btw-rubrieken en afronding.** Q1: 1a € 1.000 / € 210, voorbelasting
  € 12,60, 5c € 197; het verschil met het grootboek komt op 4900.
- **De balans** sluit op elke peildatum, met het lopende resultaat in het
  eigen vermogen.
- **De jaarafsluiting** zet winst en privé (0550/0560) naar 0500, en heropenen
  draait alles terug. De sluitpost van de beginbalans gaat naar 0500.
- **Afschrijving** gaat cent-exact; de restcenten komen in de eerste maanden
  (€ 2.000 over 60 maanden: 20 × € 33,34 en 40 × € 33,33).
- **De factuur-pdf** heeft de verplichte gegevens (naam, adres, KvK, btw-id,
  nummer, datum, eenheidsprijs, btw per tarief met grondslag) en de
  vermeldingen bij verlegd, ICP, export en vrijgesteld.
- **De aanmaning** rekent de WIK-staffel (minimaal € 40, maximaal € 6.775), de
  wettelijke rente voor consumenten en de handelsrente voor bedrijven over het
  openstaande bedrag, en geeft een consument eerst veertien dagen.
- **Het urencriterium** telt per kalenderjaar, direct en indirect, met de
  bedragen van 2026.

## Bevindingen en fixes

### Database (migratie `20261118090000_eenmanszaak_controle`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | **Het beginvermogen miste de winst van een vorig jaar dat nog open stond.** Heel gewoon bij een zzp'er: de aangifte over 2025 doe je in het voorjaar van 2026. Een eenmanszaak met € 2.000 beginbalans, € 887,93 winst, € 3.000 storting en € 500 opname in 2025 begon 2026 op € 4.500 in plaats van € 5.387,93, en het eindvermogen sloot niet aan op de balans. **Nagespeeld.** | Het begin telt ook omzet en kosten van vóór de begindatum; van een afgesloten jaar vallen die tegen de jaarafsluiting weg. Het overzicht zegt welke jaren nog open staan. Bij een vof staat die winst onder "nog niet aan een vennoot toegewezen". |
| 2 | hoog | **Een activum dat via een inkoopfactuur op 0100 was geboekt, kon nooit worden afgeschreven.** Afschrijven eiste een aanschafboeking; het scherm zei terecht dat die dan dubbel zou tellen. De gewone weg voor een zzp'er (camera als inkoopfactuur, met btw-aftrek) liep zo dood. **Nagespeeld.** | Staat de bron-inkoopfactuur geboekt met het bedrag op de activarekening, dan wordt dát boekstuk de aanschaf ("Koppelen aan de inkoopfactuur"). Geen tweede boeking. Meer activa op één factuur kan, samen niet meer dan er op de rekening staat. Tegenboeken van die factuur kan pas na de afschrijvingen; het register gaat mee terug. |
| 3 | hoog | **Met de KOR splitste een bankboeking toch btw af.** € 121 op 4500 (code HOOG) werd € 100 kosten en € 21 voorbelasting, die met de KOR niet bestaat. Een ontvangst op 8000 gaf af te dragen btw. Kosten, omzet en winst klopten niet. | Met de KOR geen splitsing: het hele bedrag op de rekening, code KOR. Verlegde btw (EU-dienst, invoer) geef je wel aan in 2a/4a/4b, zonder aftrek, net als bij een inkoopfactuur. |
| 4 | midden | **Btw op privé.** Wie in de bankverdeling eerst 4500 koos en daarna 0550 Privé-opnamen, hield code HOOG: een privé-uitgave van € 121 gaf € 21 voorbelasting in rubriek 5b. | De database weigert btw op eigen vermogen; het scherm haalt de code weg bij eigen vermogen en schulden. |
| 5 | hoog | **Een btw-tijdvak dat nog liep, was af te sluiten.** De pagina opent op het lopende kwartaal en de knop stond aan. Wie op 17 november Q4 afsloot, zag een factuur van 15 december op 1 januari geboekt: omzet in het verkeerde jaar, btw een kwartaal te laat. **Nagespeeld.** | Afsluiten kan vanaf de dag na het tijdvak, net als de aangifte bij de Belastingdienst. Ook voor Gerrie. |
| 6 | midden | **Een maand afsluiten bij aangifte per kwartaal maakte het jaar onafsluitbaar** (Q1 overlapte daarna, en de jaarafsluiting eist kwartalen). | Alleen in de frequentie van Instellingen, of in de soort waarin dat jaar al is aangegeven (zie 25). Anders toont het scherm de andere weergave alleen ter inzage. |
| 7 | midden | **De jaarafsluiting keek niet naar geplande afschrijvingen en termijnen.** Een laptop die t/m september was afgeschreven, kreeg oktober t/m december stil in het nieuwe jaar; de winst van beide jaren klopte niet. | Afsluiten weigert met de namen erbij; het venster zegt het vooraf. |
| 8 | laag | Een beginbalans per 31-12 vóór het eerste boekjaar liet dat jaar nooit afsluiten ("sluit eerst het voorgaande boekjaar af", dat niet bestond). | De beginbalans telt daar niet mee. |
| 9 | laag | Een desinvestering rekende met wat er toevallig al was afgeschreven, en de geplande termijnen verdwenen: € 650 boekverlies in plaats van € 250 afschrijving en € 400 verlies. | Eerst afschrijven tot de verkoopdatum. |
| 10 | midden | **Na de inrichting was de boekhouding niet klaar.** Grootboek, Omzetbelasting en Boekjaren zeiden "Boekhouding nog niet ingericht", Eigen vermogen "Maak eerst een boekjaar aan", zonder knop. | Afronden van de inrichting zet het rekeningschema en de boekjaren klaar, vanaf de startdatum tot en met het lopende jaar (`open_initial_fiscal_years`). Op elke pagina staat één knop "Boekhouding inrichten" die hetzelfde doet. |
| 11 | laag | Een eenmanszaak sloot af naar 0510 Onverdeeld resultaat als hij van vóór de inrichtingsstappen was of van rechtsvorm wisselde. Het totaal klopte, maar "Eigen vermogen" stond negatief naast een groeiend "Onverdeeld resultaat". | De resultaatrekening volgt de rechtsvorm als hij nog op de standaard stond. Bestaande eenmanszaken die nog nooit naar 0510 afsloten, staan op 0500. |
| 12 | midden | **Eén kostenrekening.** De aangifte inkomstenbelasting vraagt de kosten uitgesplitst, en eten, drinken en representatie zijn maar beperkt aftrekbaar; daar was geen plek voor. Ook geen kasrekening. | Bij een IB-onderneming: 1000 Kas, 4100 Huisvesting, 4200 Auto en vervoer, 4300 Kantoor en communicatie, 4400 Verkoop en reclame, 4600 Eten, drinken en representatie (beperkt aftrekbaar), 4700 Opleiding, 7000 Inkoopwaarde. Ook voor bestaande IB-administraties. Waar een standaard-btw-code verkeerd kan uitpakken (huur, auto, horeca) staat er bewust geen. |
| 13 | midden | **Op een KOR-factuur stond "Btw 0%" zonder reden.** De editor bood code KOR niet aan, dus ontbrak de vermelding van de kleineondernemersregeling, en viel de omzet in rubriek 1e. | Een 0%-regel zonder code krijgt de code KOR (database, editor, offerte en factuur). Op de pdf staat dan de vermelding en geen regel "Btw 0% over …". |
| 14 | hoog | **"Op betaald zetten" wees naar een memoriaalpost op Debiteuren.** Die hoort bij geen enkele factuur: de factuur bleef open, de herinneringen liepen door en er kwam een aanmaning met incassokosten voor een klant die contant had betaald. | De melding (database, scherm, Gerrie) wijst naar Bank → Mutatie invoeren, en voor contant geld naar een kasrekening. |
| 15 | midden | **De btw-herinnering op het dashboard kwam vrijwel nooit**: hij telde aangiftes met status "doorgeboekt", terwijl afsluiten ze meteen op "ingediend" zet. | Het dashboard toont afgelopen tijdvakken zonder aangifte, met de deadline, rood als die voorbij is (`list_filed_vat_periods`, `src/lib/vatPeriods.ts`). |

### Schermen

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 16 | midden | Op de btw-pagina stonden geen deadlines, de kolom "Aangifte" toonde alleen de btw, 4b heette "Verwervingen" en 5g had geen naam. | Per tijdvak "uiterlijk …", omzet én btw in hele euro's zoals je ze invult, de namen van het aangifteformulier, en een melding als de boekhouding midden in het tijdvak begint. |
| 17 | midden | De KOR-grens werd niet bewaakt: een factuur van € 2.000 bij € 19.000 omzet ging zonder waarschuwing de deur uit. | Een teller op de btw-pagina: omzet dit jaar tegen € 20.000, een waarschuwing vanaf € 17.500, en een melding als vorig jaar boven de grens zat. |
| 18 | midden | Een nieuwe klant staat op "zakelijk". Een bruidspaar kreeg zo de zakelijke aanmaning: geen veertiendagenbrief (dan zijn de incassokosten niet verschuldigd, art. 6:96 lid 6 BW) en handelsrente in plaats van wettelijke rente. | Het aanmaningsvoorstel waarschuwt bij een zakelijke klant zonder KvK- en btw-nummer. |
| 19 | midden | Een nieuwe factuur had geen vervaldatum, en werd dus nooit "te laat": geen herinnering, geen aanmaning. | De vervaldatum volgt uit de betaaltermijn van de bedrijfsgegevens ("binnen 14 dagen"). |
| 20 | laag | De factuurdatum was de UTC-datum: tussen middernacht en 1:00/2:00 gisteren. | Lokale datum. |
| 21 | laag | Een leeg nummerveld werd `FAC-2026-` plus vier cijfers van de klok, en de reeks liep daarna vanaf dat nummer door. | Het volgende nummer van de reeks. |
| 22 | laag | "€ -0,00" in de vergelijkingskolom van Winst & verlies. | € 0,00. |
| 23 | laag | Vaktaal en Engels: "Verstuur via Resend", "PDF-snapshot", "Volwassen factuurmodule …", "Controleer de Edge Function logs", "Resend provider request failed …". | Gewone woorden. |
| 24 | laag | Bij de KOR stond bij een activum "Aanschafwaarde (excl. btw)", terwijl de btw dan bij de aanschafprijs hoort. | "Incl. btw" bij de KOR; een gekozen bron-inkoopfactuur vult datum en bedrag in. |

### Na de uitrol: wisselen van aangiftetijdvak (migratie `20261118100000_btw_tijdvak_wissel`)

Bij een laatste controle bleek dat fix 6 een gewone situatie lastiger maakte.

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 25 | midden | **Wisselen van kwartaal- naar maandaangifte (of andersom) liep vast.** De Belastingdienst zet je per 1 januari om, of je vraagt het zelf aan, bijvoorbeeld om btw sneller terug te krijgen. Zette je dat bij Instellingen om, dan gebeurde het volgende. Q4 van het jaar ervoor kon je niet meer afsluiten (fix 6). Dat jaar kwam ook niet meer dicht: de jaarafsluiting vroeg twaalf maanden, en dat deed hij al vóór deze controle. En het dashboard toonde alle kwartalen van vorig jaar als twaalf niet aangegeven maanden, in het rood. Je moest de instelling dus heen en weer zetten. **Nagespeeld:** met de oude functies faalden vier van de zes nieuwe stappen. | Een tijdvak mag ook in de soort waarin dat jaar al is aangegeven. Een losse maand in een kwartaaljaar blijft geweigerd (fix 6). De jaarafsluiting vraagt dat elke maand in een afgesloten maand of kwartaal valt. De melding noemt het ontbrekende tijdvak zoals dat jaar ging. Het dashboard telt een eerder jaar in de soort waarin het is aangegeven. De pagina Omzetbelasting volgt dezelfde regel. Een tijdvak dat helemaal vóór de start in ResoFly ligt, krijgt uitleg in plaats van een rode deadline: de jaarafsluiting vraagt er wel om. |

### Nieuw: overzicht voor de aangifte inkomstenbelasting

Op **Eigen vermogen** staat bij een eenmanszaak onder de kapitaalvergelijking
het overzicht van winst naar belastbare winst uit onderneming
(`src/lib/incomeTax.ts`):

1. winst volgens de boekhouding;
2. plus het niet-aftrekbare deel van eten, drinken en representatie (4600): de
   gunstigste van 20% of de drempel van € 5.700;
3. min de zelfstandigenaftrek, als de eigenaar het urencriterium haalt (uit
   Uren), niet hoger dan de winst behalve voor een starter;
4. min de startersaftrek, met een vinkje "ik ben starter";
5. min de mkb-winstvrijstelling van 12,70%, ná de ondernemersaftrek (bij een
   verlies maakt die het verlies kleiner);
6. de belastbare winst uit onderneming.

Alleen voor 2025 en 2026: liever geen bedrag dan een verkeerd bedrag. Wat er
niet in zit (KIA, bijtelling auto, desinvesteringsbijtelling, meewerkaftrek,
de halve zelfstandigenaftrek vanaf de AOW-leeftijd) staat eronder.

## Verificatie

- **Stromentest `eenmanszaak`** (nieuw, 35 stappen, alle drie de groepen groen):
  - het jaar: inrichting met klaargezette boekhouding, beginbalans, facturen,
    inkoop, de camera koppelen en afschrijven, bank met privé, vier aangiften,
    winst € 887,87 plus afronding, balans sluitend, kapitaalvergelijking vóór en
    na afsluiten, 2026 met open en met afgesloten 2025;
  - de KOR: factuur met code KOR en geen omzet in 1a of 1e; bank zonder btw;
    Google Ads met 4b € 100 / € 21 en 5b nul;
  - vangnetten: beginbalans per 31-12, lopend kwartaal, maand bij kwartaal,
    geplande afschrijving vóór afsluiten, desinvestering, tegenboeken van een
    gekoppelde inkoopfactuur, rechtsvorm en resultaatrekening.
- **Volledige stromentest**: 1163 stappen. `rapportages` aangepast: die zette
  zelf 8000 en 1300 neer, die er nu al staan. `herinneringen` gaf vijf fouten
  omdat de run over middernacht liep (17 vs. 18 november); opnieuw 66/66.
- **Lokaal**:
  - `npm run typecheck` ✓;
  - `npm test`: 1934/1934, waarvan nieuw: btw-tijdvakken en deadlines, het
    IB-overzicht, de btw-code bij de bank, betaaltermijn en vervaldatum,
    "€ 0,00", en de KOR in de documentopmaak (app en server gelijk);
  - `npm run test:loading` ✓ (het dashboard telt de bank en haalt de
    btw-tijdvakken uit één RPC, niet uit de boekhoudtabellen);
  - `npm run test:mobile -- --theme=both`: 686 pagina's, 0 problemen;
  - UI-test in Chromium voor offerte, factuur, intrekken, rollen, bank en
    vooruitbetaald (de knop heet nu "Verstuur per e-mail"): 41 stappen, 0 fout;
  - de keten vanaf nul (`supabase db reset`), met daarna de stromen
    eenmanszaak, bank, vooruitbetaald, facturen, inrichten en herinneringen:
    252 stappen, 0 fout;
  - na het samenvoegen met staging (instellingen in groepen) opnieuw:
    typecheck, `npm test` 1941/1941, `test:loading` en `test:mobile` voor de
    financiële pagina's (48 metingen, 0 problemen);
  - de pagina's die `test:mobile` niet kent (Eigen vermogen, Omzetbelasting,
    Activa, Boekjaren) zelf op 390 × 844, donker en licht: niets scrolt
    zijwaarts. Het overzicht voor de aangifte paste eerst niet (de bedragen
    vielen achter de veegrij van 560px); nu wel.
- **Deno-check** (esm.sh is hier geblokkeerd; met een importmap naar npm):
  de 35 functies uit de CI-lijst en `_shared/documentLayout.ts` en
  `documentPdf.ts` schoon; `invoice-workflow` dezelfde 11 meldingen als vóór de
  wijziging (staat al buiten de CI-lijst).
- **De migratie** draait in één transactie, en nog eens zonder fout.
- **Wisselen van tijdvak (fix 25)**:
  - stromentest `eenmanszaak`, nieuwe groep van zes stappen. Q1 t/m Q3 2025
    per kwartaal, dan per maand ingesteld. 2025 weigert af te sluiten zonder
    Q4, met "01-10-2025 t/m 31-12-2025" in de melding. Q4 per kwartaal en
    2025 dicht. Januari 2026 per maand mag, een kwartaal in 2026 niet. Het
    dashboard krijgt de vier kwartalen en januari. Met de functies van
    `20261118090000` faalden vier van de zes stappen;
  - unit: van kwartaal naar maand en andersom per 1 januari, en een wissel
    midden in het jaar (`vatPeriods.test.ts`);
  - de keten vanaf nul (281 migraties) en de migratie twee keer achter
    elkaar; `npm test` 1944/1944; typecheck; `test:loading` ✓;
    `test:mobile` voor dashboard en Omzetbelasting, licht en donker: 12
    metingen, 0 problemen;
  - in Chromium op de pagina Omzetbelasting, met een eenmanszaak die na Q3
    op maandaangifte overging. September 2025 valt in Q3. Q4 2025 heeft de
    knop "Periode afsluiten" en sluit af. Q2 2026 per kwartaal is alleen te
    bekijken. Geen JavaScript-fouten.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| De KOR met een begin- en einddatum | Nu één vinkje, en elke boeking kijkt naar de stand van nu. Een inkoopfactuur uit de KOR-periode die je ná het uitzetten boekt, krijgt zo aftrek. Vraagt een schemawijziging en alle plekken die de KOR lezen. |
| Btw-correctie privégebruik auto (rubriek 1d) | Geen standaardcode en geen hulp; het memoriaal rekent het bedrag als grondslag × tarief. De database kan het al (een regel met grondslag 0). Een eigen handeling met cataloguswaarde × 2,7% of 1,5% hoort erbij. |
| Factuurnummer pas bij versturen toekennen | `allocate_next_invoice_number` bestaat, maar het nummer komt nog bij het concept uit de browser. Raakt de hele editor- en verzendflow. |
| "Zakelijk" als standaard bij een nieuwe klant | Een verplichte keuze raakt klant-uit-mail, CSV-import, Gerrie en de API. Nu een waarschuwing bij de aanmaning. |
| Afronden in het voordeel van de ondernemer | Mag, hoeft niet; nu rekenkundig (stond al open sinds 4 november). |
| Diensten aan een ondernemer buiten de EU | Alleen code EXPORT (rubriek 3a, tekst over uitvoer van goederen). |
| KIA, bijtelling auto, jaren vóór 2025 in het IB-overzicht | Bedragen en voorwaarden eerst zeker weten; nu als tekst eronder. |
| Het IB-overzicht per vennoot (vof) | Elke vennoot met zijn eigen uren en winstaandeel; vraagt uren per vennoot. |
| Leverdatum op de factuur (art. 35a lid 1 onder g) | Stond al open. |
| Een knop "Ontvangst registreren" bij de factuur | Contant geld gaat nu via een kasrekening bij Bank; een knop bij de factuur zelf is handiger. |

## Uitrol

**Staging: uitgerold op 18 november 2026** (merge `ae4f075`, *Deploy Supabase
(staging)* run 239):

- de migratie `20261118090000_eenmanszaak_controle` is toegepast;
- alle 40 edge functions zijn uitgerold (waaronder `invoice-workflow` met de
  nieuwe meldingen, en de handelingen van Gerrie, MCP en de API);
- de rooktest is geslaagd, ook "anon heeft geen rechten in public": de nieuwe
  functies staan dicht voor de publieke sleutel;
- Cloudflare Pages bouwt de app bij de push naar `staging`; dat is van hieruit
  niet te zien (het netwerk blokkeert het domein).

Wat de migratie op staging met bestaande gegevens doet:

- eenmanszaken die nog op 0510 stonden en nog nooit naar 0510 afsloten, staan
  nu op 0500 (er stond niets op 0510, dus de cijfers veranderen niet);
- IB-administraties met een rekeningschema kregen 1000 Kas en de nieuwe
  kostenrekeningen (geen systeemrekeningen: naam, btw-code en actief blijven
  vrij);
- verder niets: de functies werken voor nieuwe boekingen en overzichten.

De Management API van Supabase was vanuit deze sessie niet bereikbaar; de
staging-database zelf is dus niet ingezien. De controle is de uitrol (de CLI
breekt af bij een fout in de migratie), de rooktest, en dezelfde migratie op
een lege en op een gevulde lokale database.

Voor productie: dezelfde migratie. Hij is veilig om opnieuw te draaien.
