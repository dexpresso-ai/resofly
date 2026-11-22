# Controle vof: de winst van een jaar hoort bij de vennoten van dat jaar

**22 november 2026 · database, schermen, Gerrie en tests · staging**

Doel: nagaan of een vof, maatschap of cv in ResoFly kan boekhouden zonder
fouten die de vennoten zelf niet meer kunnen rechtzetten, en of de cijfers per
vennoot kloppen. De controle van 18 november
(`CHANGELOG_VOF_ADMINISTRATIE_2026-11-18.md`) liep het gewone jaar door. Deze
controle doet voor de vof wat die van 19 november
(`CHANGELOG_FINANCIEN_HERSTELWEGEN_2026-11-19.md`) voor de eenmanszaak deed:
zoeken waar het misgaat als iets níet gewoon loopt. Een vennoot treedt uit of
toe, de verdeling verandert, de rechtsvorm wisselt, een vorig jaar staat nog
open, je stapt over uit een ander pakket.

> **Status:**
> - **Database:** twee migraties, `20261122100000_vof_verdeling_per_boekjaar`
>   en `20261122110000_vof_bank_inkoop_prive`.
> - **Schermen:** Boekjaren, Vennoten, Inkoopfacturen, Inkomstenbelasting,
>   de auditfile-import en Instellingen.
> - **Gerrie, API en MCP:** één nieuwe handeling en vijf aangepaste.
> - **Tests:** twee nieuwe stromenscenario's (`vof` en `vof-bank-inkoop`).
>
> Uitrol: zie onderaan.

## Werkwijze

- **Vijf reviews tegelijk**, elk op één onderdeel:
  - de vennoten en de winstverdeling over de jaren;
  - privé per vennoot en het herstellen daarvan;
  - de beginbalans, overstappen uit een ander pakket en meerdere jaren;
  - de inkomstenbelasting per vennoot en het urencriterium;
  - de schermen in Chromium, op desktop en op 390 × 844.

  Elke reviewer speelde zijn bevindingen na als eigenaar, met zijn eigen sessie
  (RLS geldt), tegen een lokale stack met alle migraties.
- **De fiscale vragen apart nagelopen.** Het ging om:
  - een voorafgaande winstverdeling;
  - toe- en uittreden;
  - de overgang van eenmanszaak naar vof;
  - het gebroken boekjaar;
  - de commanditaire vennoot;
  - verlies en negatief kapitaal;
  - privé betaald;
  - een rekening-courant met een vennoot.

  Gebruikt zijn zoekresultaten die de wet of de Belastingdienst citeren:
  belastingdienst.nl en wetten.overheid.nl waren vanuit de werkomgeving niet
  te openen. Wat niet na te lezen was, staat hieronder als onzeker.
- **Elke bevinding is in de code bevestigd** en, waar het om geld gaat,
  vastgelegd in een stromentest die met de oude functies faalt.

## Wat goed zat

Nagelopen en niet veranderd:

- **Per vennoot op de cent in een open jaar.**
  - De raming, de jaarafsluiting en de kapitaalvergelijking geven hetzelfde
    winstaandeel, ook bij verlies en met een restcent.
  - Met dezelfde vennoten sluit de kapitaalvergelijking over drie jaren: het
    eind van elk jaar is het begin van het volgende.
- **Privé per vennoot.**
  - Een opname of storting op de verkeerde vennoot ongedaan maken en opnieuw
    boeken komt op de eigen datum, ook in een aangegeven kwartaal. In een dicht
    jaar komt het op de eerste open dag.
  - Een privébetaling tegenboeken zet de inkoopfactuur weer open.
  - Deels via de bank en de rest privé geeft de goede status.
- **Een laptop die een vennoot inbrengt** (via 056n) wordt goed afgeschreven.
- **De beginbalans per vennoot**, met een sluitpost en een open privé.
  Beginbalans corrigeren houdt de regels per vennoot.
- **Btw op privé** wordt geweigerd door de bank, een bankregel en Gerrie.
- **Wie wat mag:**
  - de uren per vennoot ziet alleen wie Uren mag lezen, ook via Gerrie;
  - een vreemde organisatie of de boekhouder koppel je niet aan een vennoot.
- **De commanditaire vennoot** krijgt in de raming geen ondernemersaftrek en
  geen mkb-winstvrijstelling. Fiscaal klopt dat: hij is geen ondernemer
  (art. 3.4 Wet IB 2001).

## De gedeelde oorzaak

Bijna alle zware bevindingen kwamen uit één oorzaak. De jaarafsluiting, de
kapitaalvergelijking (Vennoten) en de raming inkomstenbelasting lazen de
vennoten, hun percentages en de rechtsvorm **van vandaag**, ook voor een jaar
dat al voorbij of afgesloten was. Vijf reviewers vonden het elk langs een
andere weg.

Nu horen de verdeling en de rechtsvorm bij een boekjaar:

- **De rechtsvorm per boekjaar** (`fiscal_years.legal_form`).
  - Wisselt de rechtsvorm bij Instellingen, dan volgen alleen de open
    boekjaren die nog niet voorbij zijn. Een vorig jaar dat nog open staat
    (de aangifte doe je in het voorjaar), houdt zijn rechtsvorm.
  - Was de oude instelling gewoon fout, dan zet je dat jaar zelf om in het
    afsluitvenster.
- **De verdeling per boekjaar** (`fiscal_year_partner_shares`).
  - Per vennoot een percentage, en eventueel een bedrag vooraf
    (arbeidsbeloning of rente over het kapitaal). Het restant gaat naar rato.
  - Ook een uitgetreden vennoot kan in de verdeling van een jaar staan.
  - Zonder vastgelegde verdeling geldt die van de actieve vennoten, zoals
    altijd. Bij het afsluiten wordt hij vastgelegd, met wat er per vennoot is
    geboekt.
- **Afsluiten weigert** zolang de vennoten of hun verdeling ná het einde van
  het boekjaar zijn gewijzigd en er voor dat jaar nog niets is vastgelegd. De
  melding noemt de vennoten en de weg.
- **Het overzicht en de raming lezen voor een afgesloten jaar** wat er is
  geboekt. Heropenen en opnieuw afsluiten gebruikt dezelfde verdeling.

## Bevindingen en fixes

Ernst: **onherstelbaar** (de vennoten komen er zelf niet meer uit), **hoog**
(stil foute cijfers of een doodlopende weg), **midden**, **laag**.

### De verdeling en de rechtsvorm per boekjaar (migratie `20261122100000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | **Een vennoot die uittrad vóór de jaarafsluiting, kreeg niets.** Anna en Bram 50/50 in 2025, Bram treedt in februari 2026 uit, 2025 gaat in april dicht. Afsluiten weigerde ("telt op tot 50 procent … pas de verdeling aan bij Vennoten"); wie dat deed, gaf Anna € 8.000 en Bram € 0. De raming van 2025 liet Bram weg. **Nagespeeld.** | Afsluiten weigert en noemt Bram. Je legt de verdeling van 2025 vast, met Bram erin. Afsluiten boekt dan € 4.000 en € 4.000, en Vennoten en de raming van 2025 tonen Bram. |
| 2 | hoog | **Een nieuwe vennoot kreeg winst over een jaar waarin hij er niet was.** Chris treedt in januari 2026 toe (40/30/30); 2025 sluit af met Chris erin, zonder enige waarschuwing. **Nagespeeld.** | Zelfde weigering, met Chris in de melding; de verdeling van 2025 laat hem eruit. |
| 3 | hoog | **Een afgesloten jaar volgde de percentages van nu.** 2025 afgesloten op 60/40; per 2026 50/50. Vennoten 2025 toonde daarna € 5.000 / € 5.000 terwijl € 6.000 / € 4.000 geboekt was, het eind van 2025 was niet meer het begin van 2026, de raming 2025 rekende 50/50, en heropenen en opnieuw afsluiten boekte 50/50. Na een uitbetaling stond Bram zo op −€ 4.000. **Nagespeeld.** | Het overzicht en de raming lezen het geboekte bedrag per vennoot; opnieuw afsluiten gebruikt de vastgelegde verdeling. Een afgesloten jaar krijgt geen andere verdeling: eerst heropenen. |
| 4 | hoog | **De overstap van vof naar eenmanszaak werkte terug op het jaar ervoor.** Na de wissel sloot 2025 (een vof) af als eenmanszaak: alles naar 0500, Bram € 0, en de raming van 2025 rekende met één ondernemer (€ 9.709,74 in plaats van € 1.501,22 voor Anna). Andersom kreeg Bram bij eenmanszaak → vof de helft van Anna's eenmanszaakwinst. **Nagespeeld.** | 2025 blijft een vof en sluit af naar de vennoten; 2026 is de eenmanszaak. Het afsluitvenster en de kaart van Gerrie zeggen het. |
| 5 | hoog | **Een arbeidsbeloning vóór de verdeling kon alleen als memoriaal.** Bram krijgt eerst € 6.000, de rest 60/40. Het memoriaal (het advies van het scherm) zette de kapitaalrekeningen goed, maar Vennoten toonde het onder "Overig", niet in het winstaandeel, en de raming rekende met € 5.700 / € 3.800 in plaats van € 2.100 / € 7.400. Fiscaal is een arbeidsbeloning winstverdeling, geen kosten. **Nagespeeld.** | Een bedrag vooraf per vennoot in de verdeling van het boekjaar. De jaarafsluiting, Vennoten en de raming rekenen ermee, tot op de cent gelijk. Het advies op Vennoten wijst ernaar. |
| 6 | hoog | **Een creditnota die op de pas van een vennoot terugkwam, bleef voorgoed open.** Inkoop € 363 privé betaald door Bram; de leverancier crediteert en stort terug op Brams eigen rekening. Privé betaald weigerde ("niets meer open"), het memoriaal liet de creditnota open, Openstaand → Crediteuren hield € 363 zonder factuur, en de creditnota bleef kandidaat bij elke bankmutatie. **Nagespeeld.** | **Privé ontvangen**: het bedrag komt op de privé-opnamen van de vennoot (055n, of 0550), de creditnota staat op betaald en de crediteuren sluiten aan. Ook via Gerrie. |
| 7 | midden | **"Nog niet toegewezen" bevatte de winst van een vorig jaar dat nog open stond**, en het scherm raadde aan dat bedrag met een memoriaal te verdelen. Wie dat deed en daarna het jaar afsloot, gaf de vennoten de winst twee keer (€ 15.000 in plaats van € 12.500 per vennoot). **Nagespeeld.** | Die winst staat apart ("wordt verdeeld zodra 2025 dicht is"). Het advies hangt van de situatie af: de beginbalans corrigeren met Regel per vennoot, of eerst heropenen. |
| 8 | midden | **Een vof waarvan iedere vennoot was uitgetreden, toonde één "Ondernemer"** met de bedrijfsnaam, het kapitaal van alle vennoten en de teksten van een eenmanszaak. De raming zei "Er zijn nog geen vennoten vastgelegd". | De vennoten blijven in beeld; het resultaat staat apart als niet verdeeld. De raming zegt dat er in dat jaar geen vennoot meedoet. |
| 9 | midden | **Privé zonder vennoot (0550/0560) verdween stil.** Een voorlopige aanslag van Anna, op 0550 geboekt, ging bij het afsluiten naar 0500 en stond bij geen enkele vennoot op de aangifte. Het afsluitvenster en de kaart van Gerrie zwegen erover. | Het afsluitvenster en de kaart noemen het bedrag, met de weg (omboeken naar de privérekening van de vennoot). |
| 10 | midden | **De prognose van het urencriterium in de raming rekende anders dan de teller op Vennoten**: vanaf 1 januari in plaats van vanaf de eerste uren. Carla, toegetreden op 1 juni, met 1.050 uur op 22 november: op Vennoten "op koers", in de raming niet, en daarmee € 1.074,92 te veel belasting. | De raming krijgt de eerste dag met uren per vennoot en rekent zoals de teller (`projectMinutesFromFirstEntry`, getoetst tegen `projectHourCriterion`). |
| 11 | midden | **Na een overstap van cv naar vof bleef een commanditaire vennoot commanditair.** Hem via Gerrie laten uittreden gaf een 422 ("bestaat alleen bij een cv"). | Buiten een cv wordt hij beherend, zoals het scherm al deed. |
| 12 | laag | **Een vennoot verwijderen kon nergens.** Een per ongeluk aangemaakte tweede "Anna" bleef in elke kapitaalvergelijking en keuzelijst staan, en telde mee voor het maximum van negen. | **Verwijderen** bij Vennoten, alleen zonder boekingen; zijn rekeningen gaan mee. Met boekingen: uittreden. |
| 13 | laag | **Gerrie, Privé betaald:** de kaart noemde het factuurtotaal terwijl er minder openstond, en als datum de factuurdatum, ook in een afgesloten jaar (dan faalde het pas bij goedkeuren). | Het open bedrag op de kaart; zonder gekozen datum de eerste dag na het afgesloten jaar. |
| 14 | laag | **De melding bij een gebroken boekjaar zei dat het alleen bij een BV kan.** De wet laat het bij een IB-onderneming wel toe (art. 3.66 Wet IB 2001: de winst telt in het kalenderjaar waarin het boekjaar eindigt). | De melding zegt dat ResoFly het bij deze rechtsvormen niet ondersteunt, en dat een korter eerste of laatste boekjaar wel kan. |

### Privé via de bank en de inkoop (migratie `20261122110000`)

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 15 | midden | **Btw op privé via de inkoop.** Een inkoopregel "Privédeel Bram", € 50 op 0552 met 21%, werd geboekt met € 10,50 voorbelasting in rubriek 5b. Ook via Gerrie (`purchase_invoice.update`), en via een leverancier met 0552 en 21% als standaard, waarna de inbox zo boekte. **Nagespeeld.** | Opslaan, boeken, de leverancier en de twee handelingen weigeren btw op een rekening van het eigen vermogen. Een bestaande leverancier met die combinatie verliest zijn btw-code, zoals eerder de bankregels. |
| 16 | midden | **Een privé betaalde factuur werd via de bank nog eens als kosten geboekt.** Anna betaalde € 968 met haar eigen pas; de incasso van dezelfde leverancier werd daarna door een bankregel vanzelf op 4500 geboekt: oktober € 1.600 kosten en € 336 voorbelasting in plaats van € 800 en € 168. **Nagespeeld.** | Staat er bij die leverancier een privé betaalde factuur van precies dit bedrag, dan boekt ResoFly niets vanzelf. Er komt dan ook geen bankregel, en de reden zegt hoe je het rechtzet. Dat geldt binnen een redelijke termijn: van 60 dagen vóór de factuurdatum tot 90 dagen na de vervaldag of de privébetaling. Zo krijgt een maandelijkse incasso van hetzelfde bedrag gewoon zijn bankregel. |
| 17 | midden | **Een betaling aan de Belastingdienst wees bij een vof naar 0550**, dat bij een vof op geen enkele vennoot staat. | De reden noemt de privé-opnamen van de vennoten (0551 Anna, 0552 Bram, …). |

### De auditfile-import

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 18 | hoog | **Het kapitaal van de ene vennoot kwam bij een andere.** "Kapitaal vennoot L. van Leeuwen" werd 0502 Kapitaal Jan van Dam: tussenvoegsels als "van" telden als naam. Jan stond daarna op € 10.000 in plaats van € 6.000. Bij twee Jansens kwam er toch een voorstel (0500/0550), terwijl de changelog van 18 november "geen voorstel" belooft. **Nagespeeld.** | De achternaam beslist; tussenvoegsels, voorletters en woorden als "vennoot" tellen niet mee. Past een naam niet of bij twee vennoten, dan komt er geen voorstel, met de reden. Een waarschuwing als meer oude rekeningen op één eigen-vermogensrekening samenkomen. |
| 19 | midden | **De cumulatieve afschrijving kwam op 0100 Vaste activa**, zodat een activum van vóór de start niet meer aan de beginbalans te koppelen was. **Een rekening-courant vennoot** met oud nummer 0560 kwam op 0560 "(geen vennoot)". | "Afschr." en "afschrijving" gaan naar 0150 Cumulatieve afschrijving. Een rekening-courant gaat nooit naar privé of eigen vermogen. |
| 20 | midden | **Bij een overstap halverwege het jaar kwam de winst tot de overstap als sluitpost op 0500**, en werd nooit over de vennoten verdeeld. | Bij een vof met vennoten wordt de sluitpost per vennoot op zijn kapitaal voorgesteld, naar winstaandeel, tot op de cent. Het scherm zegt dat het de winst van vóór de overstap is. |

### Schermen

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 21 | midden | **Het afsluitvenster liet de verdeling niet zien.** Het noemde geen bedrag per vennoot, en een verdeling van 90% bleek pas na "Definitief afsluiten". "Te bestemmen resultaat" is de taal van een BV. | Het venster toont de verdeling van dat jaar: per vennoot het aandeel, het bedrag vooraf en wat op het kapitaal komt. Met **Verdeling aanpassen** (ook voor uitgetreden vennoten) en **Terug naar de vennoten van nu**. Het noemt wie er na het jaareinde veranderde, de rechtsvorm van dat jaar (met een knop om het jaar om te zetten), en privé zonder vennoot. Afsluiten staat uit tot de verdeling klopt. "Te verdelen resultaat" bij een vof. Het onderdeel staat in `src/features/PartnerSplit.tsx` en is gedeeld met Vennoten. |
| 22 | midden | **Een wissel van rechtsvorm ging zonder vraag**, ook met vennoten met kapitaal. | Bij een wissel tussen eenmanszaak en vof vraagt Instellingen per open jaar dat al gelopen is: "Geldt dit al voor 2026?" en "Gold dit ook al voor 2025?". |
| 23 | midden | **De boekhouder zag bij elke vennoot "Teamlid (niet meer in de organisatie)"**: hij mag de ledenlijst niet lezen. | "Gekoppeld aan een teamlid". |
| 24 | laag | **Privé betaald bij een vof zonder vennoten** toonde de tekst van een eenmanszaak. Een privé betaalde factuur zei nergens door wie. | Een verwijzing naar Vennoten. In de lijst staat "privé betaald door …" of "privé ontvangen door …". |
| 25 | laag | **Op de telefoon** stonden het potlood en de status bij Vennoten en de knop Privé betaald buiten beeld, en de tip boven de inkooplijst viel uiteen in kolommen. De uren van een net gekoppelde vennoot verschenen pas na herladen. Verder stonden er teksten als "nog 325u", "Het verschil van € 0,00 wordt … gezet", "Het urencriterium volgt je uren" op de kaart van een andere vennoot, en een verwijzing naar een tabblad dat niet bestaat. | Rechtgezet. |

Op **Vennoten** staat bovenaan de verdeling van het boekjaar ("vastgelegd voor dit jaar", "vastgelegd bij het afsluiten" of "die van de vennoten nu"), met Verdeling aanpassen. Per vennoot staat er "waarvan vooraf", en de winst van een vorig jaar dat nog open staat heeft een eigen regel. Een vennoot zonder boekingen kun je verwijderen. Het advies over een arbeidsbeloning wijst naar het bedrag vooraf, en de melding over een start in de loop van het jaar staat er nu ook bij een vof.

## Gerrie, API en MCP

- **Nieuw: `fiscal_year.set_partner_shares`.** De verdeling van een open
  boekjaar vastleggen: per vennoot een percentage en eventueel een bedrag
  vooraf; een lege lijst gaat terug naar de vennoten van nu. De uitvoerder
  roept dezelfde functie aan als het afsluitvenster.
- **Aangepast:**
  - `fiscal_year.close` toont de verdeling van dat boekjaar met het bedrag per
    vennoot, de rechtsvorm van dat jaar en privé zonder vennoot, en weigert
    vooraf als de vennoten na het jaareinde zijn gewijzigd;
  - `owners.equity_overview` beschrijft de nieuwe velden;
  - `owners.save_partner` zegt het als er nog een voorbij jaar open staat (de
    wijziging geldt vanaf nu), en maakt een commanditaire vennoot buiten een cv
    beherend;
  - `purchase_invoice.pay_privately` noemt het open bedrag en kent privé
    ontvangen;
  - `purchase_invoice.update` en `supplier.update` weigeren btw op privé.
- **De raming per vennoot** (`owners.income_tax_estimate`) rekent met dezelfde
  code als het scherm, dus ook met de verdeling van het boekjaar en het bedrag
  vooraf.

## Beveiliging

- **De tabel `fiscal_year_partner_shares`:**
  - lezen met leesrecht op Financiën, met het modulehek en het boekhouder-hek
    (`apply_module_gate`);
  - schrijven alleen via `set_fiscal_year_partner_shares` (schrijfrecht op de
    organisatie én op Financiën) en via de jaarafsluiting. Rechtstreeks
    schrijven wordt geweigerd; de stromentest toetst dat.
- **Tenancy:**
  - de verdeling verwijst met een samengestelde sleutel naar een boekjaar en
    een vennoot van dezelfde organisatie;
  - Gerrie neemt alleen vennoten van de eigen organisatie, en filtert zelf op
    `organization_id`.
- **Elke nieuwe functie staat dicht voor anon.**
- **`share_changed_at` loopt alleen mee met een echte wijziging** van
  percentage, actief of soort. Een directe update zet hem niet terug.
- **Gegevens meenemen:** de verdeling, de rechtsvorm per boekjaar en
  `share_changed_at` gaan mee. `EXPORT_SCHEMA_VERSION` staat op
  `20261122110000`.
- **Het auditlog** zet wijzigingen aan de verdeling onder Financiën
  ("verdeling over de vennoten").

## Verificatie

- **De nieuwe scenario's falen met de oude functies.** Op een database zonder
  de twee nieuwe migraties:
  - `vof`: 33 stappen, 24 fout, op de cijfers zelf ("verwacht € 6.000 /
    € 4.000, kreeg € 5.000 / € 3.000");
  - `vof-bank-inkoop`: 15 stappen, 10 fout.

  Met de migraties: 33/0 en 15/0.
- **De keten vanaf nul** (`supabase db reset`, Postgres 17.11.0.018): alle
  295 migraties zijn toegepast, en beide nieuwe draaien een tweede keer zonder
  fout. `accountant_fence_gaps()` is leeg, en geen security-definer-functie in
  `public` is uit te voeren door anon.
- **De volledige stromentest** op die verse database: STROMEN.
- **Databasetests** (`npm run test:database`): alle vier geslaagd.
  `vennoten_jaarafsluiting.sql` toetst nu het nieuwe gedrag:
  - opnieuw afsluiten gebruikt de vastgelegde verdeling, ook na uittreden;
  - een vorig jaar blijft een vof na de overstap naar een eenmanszaak;
  - zonder vennoot in de verdeling blijven de vennoten in beeld.
- **Lokaal:**
  - `npm run typecheck`: schoon;
  - `npm test`: 2125/2125. Nieuw zijn onder meer de verdeling met een bedrag
    vooraf (`splitWithPrior`, ook bij verlies en een restcent), de
    urenprognose tegenover `projectHourCriterion`, het geboekte bedrag van een
    afgesloten jaar, de kaarten van Gerrie en de auditfile;
  - `npm run test:mobile -- --theme=both`: MOBIEL;
  - `test:loading`, `test:inrichten` en `test:terugknop` (15/15): geslaagd.
- **Deno-check** van de 37 bestanden uit de CI-lijst: schoon. Dat ging met
  een importmap naar npm, omdat esm.sh hier dicht staat.
- **In Chromium** tegen de lokale stack, op desktop en 390 × 844, zonder
  JavaScript-fouten:
  - het afsluitvenster met een wijziging na het jaareinde, de verdeling
    aanpassen (Anna 50% met € 12.000 vooraf, Bram uitgetreden 50%:
    € 41.100 / € 29.100) en afsluiten;
  - de rechtsvorm per jaar, en Privé ontvangen;
  - Vennoten van 2025 en 2026, en wat een lezer en de boekhouder zien.
- **Een onafhankelijke review van de verdeling per boekjaar** vond zes
  punten, die zijn verwerkt:
  - de backfill van `share_changed_at`;
  - iedereen uitgetreden;
  - een latere wijziging na de overstap;
  - € 0 resultaat met een bedrag vooraf;
  - een wissel van rechtsvorm met een vastgelegde verdeling;
  - het geboekte bedrag in de raming.

  1.500 willekeurige verdelingen gaven in SQL en TypeScript dezelfde centen,
  en de som klopte steeds.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Een tussentijdse resultaatbepaling bij in- of uittreden of een rechtsvormwissel halverwege het jaar | Nu leg je de verdeling van dat jaar vast, met een bedrag vooraf voor wat iemand tot de wisseldatum toekomt (bijvoorbeeld de eenmanszaakwinst tot 1 juli). Automatisch splitsen op een datum vraagt een tussenbalans; de afspraak tussen de vennoten beslist. |
| Uittreden: het kapitaal als schuld aan de ex-vennoot, stakingswinst, goodwill | Na het uittreden is zijn kapitaal een schuld van de vof aan hem. Dat boek je nu met een memoriaal. De waardering en de stakingswinst horen bij de adviseur. |
| Een commanditaire vennoot met verlies boven zijn inbreng | Dat verlies hoort bij de beherende vennoten (art. 20 lid 3 WvK, uit het hoofd; de fiscale kant niet nagelezen). Nu kan het in de verdeling met een negatief bedrag vooraf; een automatische grens is er niet. |
| Een rekening-courant met een vennoot als aparte schuld of vordering | Geen standaardrekening. De auditfile zet hem niet meer op privé; maak er zelf een schuldrekening voor. |
| Btw bij Privé betaald op een bon die niet op naam van de vof staat | Aftrek vraagt een factuur op naam van de vof; een kassabon zonder naam alleen tot een klein bedrag (de grens heb ik niet kunnen nalezen). Nu geen waarschuwing. |
| Het urencriterium met uren buiten deze administratie, en opnieuw koppelen aan een vertrokken teamlid | De raming telt alleen de uren in ResoFly. Een teamlid dat is vertrokken en daarna is ontkoppeld, koppel je niet opnieuw zonder hem opnieuw uit te nodigen. |
| Een gebroken boekjaar bij een IB-onderneming | Wettelijk mag het, maar ResoFly ondersteunt het niet. Het komt weinig voor, en de raming per kalenderjaar zou moeten meeverhuizen. |

## Uitrol

UITROL
