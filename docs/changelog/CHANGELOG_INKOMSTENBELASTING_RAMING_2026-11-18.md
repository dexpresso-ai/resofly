# Inkomstenbelasting: een raming per ondernemer en per vennoot

**18 november 2026 · database, scherm en Gerrie/API/MCP · staging**

Bij een eenmanszaak, vof, maatschap of cv betalen de ondernemer of de vennoten
zelf inkomstenbelasting over de winst. ResoFly leverde tot nu toe de bouwstenen
(winst, urencriterium, kapitaalvergelijking per vennoot), maar wat iemand
ongeveer moet betalen, moest hij zelf uitrekenen. In de controle van 4 november
stond dat bewust open. Nu staat het erin.

> **Status:** één migratie (`20261118150000_inkomstenbelasting_raming`), een
> nieuwe pagina **Financiën → Inkomstenbelasting** (alleen bij een IB-rechtsvorm)
> en een leeshandeling voor Gerrie, de API en MCP (`owners.income_tax_estimate`).
> Het rekenwerk staat op één plek, met tests, en het scherm en Gerrie gebruiken
> dezelfde code. Afgestemd op het overzicht voor de aangifte op Eigen vermogen
> uit de controle eenmanszaak van vandaag: bij een eenmanszaak tonen de twee
> schermen dezelfde belastbare winst (zie hieronder).

## Wat er nu kan

- **Per persoon een raming**, per kalenderjaar:
  - bij een eenmanszaak voor de ondernemer;
  - bij een vof, maatschap of cv voor elke actieve vennoot, over zijn
    winstaandeel. De verdeling is dezelfde als die van de jaarafsluiting, tot
    op de cent.
- **De hele som op het scherm**, regel voor regel:

  | Stap | Wat |
  |---|---|
  | Winst | het winstaandeel uit de boekhouding |
  | Gemengde kosten | het niet-aftrekbare deel van wat op 4600 Eten, drinken en representatie staat, vanzelf |
  | Fiscale correcties | bijtelling auto, boetes, desinvesteringsbijtelling, EIA/MIA, gemengde kosten op een andere rekening |
  | KIA | kleinschaligheidsinvesteringsaftrek |
  | Ondernemersaftrek | zelfstandigenaftrek, startersaftrek, overige |
  | Mkb-winstvrijstelling | 12,70% van de winst na ondernemersaftrek |
  | Box 1 | belastbaar inkomen, de schijven en de aftrekbeperking |
  | Kortingen | algemene heffingskorting, arbeidskorting en ouderenkorting |
  | Zvw | de inkomensafhankelijke bijdrage |
  | Saldo | min de voorlopige aanslagen: nog te betalen of terug |

- **Een disclaimer bovenaan, altijd in beeld:** alleen het zakelijke inkomen
  uit deze onderneming telt mee. Ander inkomen, persoonlijke aftrekposten en
  kortingen die van de persoonlijke situatie afhangen, zijn niet meegenomen.
  De heffingskortingen zijn berekend alsof dit het enige inkomen is. Hetzelfde
  staat in de specificatie (CSV) en in het antwoord van Gerrie.
- **Wat niet in de boekhouding staat, vul je per persoon per jaar in:**
  - het urencriterium;
  - starter (startersaftrek);
  - de AOW-leeftijd: niet, het hele jaar, of in de loop van het jaar met de
    maand;
  - een verlies uit eerdere jaren;
  - overige ondernemersaftrek (S&O, meewerk, staking);
  - de voorlopige aanslagen IB en Zvw.

  De raming rekent al mee terwijl je typt; opslaan legt het vast.
- **KIA uit Activa:** elk activum van minstens € 450 dat in het jaar is
  aangeschaft, telt mee. Wat niet meetelt, zoals een personenauto, zet je met
  een vinkje uit. Bij een vof telt het totaal van de vof en gaat de aftrek naar
  winstaandeel naar de vennoten (Hoge Raad 1 mei 2020).
- **Prognose:** in het lopende jaar kun je kiezen tussen de winst tot nu toe en
  een prognose. De prognose trekt de geboekte winst in hetzelfde tempo door tot
  31 december. Begon de boekhouding later in het jaar, dan telt het tempo vanaf
  die dag. In de eerste maand is er nog geen prognose.
- **Het urencriterium uit Uren:** bij een eenmanszaak zonder opgeslagen keuze
  volgt het de geregistreerde uren van de eigenaar, net als Eigen vermogen. De
  raming zegt dat erbij; kies je zelf en sla je op, dan geldt jouw keuze. Alleen
  met leesrecht op Uren. Bij een vof geldt het urencriterium per vennoot, en
  vul je het per vennoot in.
- **Gerrie, API en MCP:** `owners.income_tax_estimate` geeft dezelfde raming.
  De beschrijving draagt Gerrie op de disclaimer steeds te noemen.

## Afgestemd op Eigen vermogen

De controle eenmanszaak van vandaag (`CHANGELOG_EENMANSZAAK_CONTROLE_2026-11-18.md`)
zette op Eigen vermogen een overzicht van winst naar belastbare winst
(`src/lib/incomeTax.ts`). Die twee mogen niet uiteenlopen:

- **Gemengde kosten:** de raming rekent het niet-aftrekbare deel van 4600 nu
  zelf mee, met dezelfde som: het gunstigste van 20% of de drempel van
  € 5.700 (2025 en 2026, niet geïndexeerd). Bij een vof gaat dat deel naar
  winstaandeel. In de correcties staat het als automatische regel, zonder
  prullenbak. Het formulier waarschuwt dat je 4600 niet nog eens opgeeft.
- **Urencriterium:** standaard de uren van de eigenaar, zoals daar.
- **Bewaakt:** een test vergelijkt de bedragen (zelfstandigenaftrek,
  startersaftrek, mkb-winstvrijstelling, drempel) en de som voor gemengde
  kosten van beide rekenharten. Hij rekent ook vijf eenmanszaken door beide,
  van winst tot belastbare winst. Ze komen tot op de cent overeen.
- **Verwijzing:** het overzicht op Eigen vermogen zegt nu dat KIA,
  correcties, de AOW-leeftijd en de belasting zelf bij Inkomstenbelasting
  staan.

## Het rekenhart

`src/lib/inkomstenbelasting.ts`, met een kopie voor de edge functions in
`supabase/functions/_shared/inkomstenbelasting.ts`. De test vergelijkt die twee
teken voor teken. Het rekent in hele centen; percentages staan in duizendsten
van een procent, omdat de officiële tabellen drie decimalen hebben (6,398%).
Afronden gaat met BigInt, een halve cent van nul af.

Tarieven en bedragen voor **2025 en 2026** (Belastingdienst):

| | 2025 | 2026 |
|---|---|---|
| Schijven box 1 | 35,82% tot € 38.441 · 37,48% tot € 76.817 · 49,50% | 35,75% tot € 38.883 · 37,56% tot € 78.426 · 49,50% |
| Eerste schijf met AOW-leeftijd | 17,92% | 17,85% |
| Zelfstandigenaftrek / startersaftrek | € 2.470 / € 2.123 | € 1.200 / € 2.123 |
| Mkb-winstvrijstelling | 12,70% | 12,70% |
| Aftrekbeperking (tarief) | 37,48% | 37,56% |
| Algemene heffingskorting | max € 3.068, afbouw 6,337% vanaf € 28.406 | max € 3.115, afbouw 6,398% vanaf € 29.736 |
| Arbeidskorting | max € 5.599 | max € 5.685 |
| Ouderenkorting | max € 2.035, afbouw 15% vanaf € 45.308 | max € 2.067, afbouw 15% vanaf € 46.002 |
| KIA | 28% tot € 70.602 · € 19.769 tot € 130.744 · afbouw tot € 392.230 | 28% tot € 71.683 · € 20.072 tot € 132.746 · afbouw tot € 398.236 |
| Zvw-bijdrage | 5,26% tot € 75.864 | 4,85% tot € 79.409 |

Voor 2025 en 2026 staan ook de tabellen voor de AOW-leeftijd erin: de algemene
heffingskorting en de arbeidskorting, met hun eigen afgeronde bedragen. Een
later jaar rekent met de bedragen van 2026, en dat staat dan op het scherm. Voor
2027 zijn de bedragen nog niet vastgesteld. Vóór 2025 rekent de pagina niet.

Waar het makkelijk misgaat, en wat de tests nu vasthouden:

| Punt | Hoe het nu zit |
|---|---|
| Arbeidskorting | Rekent over de winst **vóór** ondernemersaftrek en mkb-winstvrijstelling. De algemene heffingskorting rekent over het inkomen erná. Wie beide over hetzelfde bedrag rekent, zit er bij een starter honderden euro's naast. |
| Zelfstandigenaftrek | Is hoogstens de winst. Het restant verrekent de Belastingdienst later; de raming zegt dat. Wie recht heeft op startersaftrek, trekt hem helemaal af, ook als er een verlies ontstaat. |
| Aftrekbeperking | De ondernemersaftrek en de mkb-winstvrijstelling leveren hoogstens 37,56% op (2026). Dat geldt alleen over het deel van het inkomen in de hoogste schijf. |
| Commanditaire vennoot | Is geen ondernemer. Hij krijgt geen ondernemersaftrek en geen mkb-winstvrijstelling, en zijn winstaandeel is geen arbeidsinkomen. De KIA krijgt hij wel. |
| AOW-leeftijd het hele jaar | Geen AOW-premie in de eerste schijf, de helft van de zelfstandigen- en startersaftrek, lagere kortingen en de ouderenkorting. |
| AOW-leeftijd in de loop van het jaar | AOW-premie over de maanden ervoor, de kortingen naar rato, de volle zelfstandigenaftrek en de ouderenkorting. |
| Zvw-bijdrage | Over de belastbare winst, tot het maximum. Een verlies uit een ander jaar verlaagt die grondslag niet. |
| Verlies dit jaar | Leidt niet tot een negatieve belasting. De raming zegt dat de Belastingdienst het verlies verrekent met 3 jaar terug en 9 jaar vooruit. |

De verwachte bedragen in `inkomstenbelasting.test.ts` zijn niet met deze code
uitgerekend. Ze komen uit een losse berekening met Decimal, rechtstreeks uit de
tabellen, en ik heb ze met de hand nagelopen. Een voorbeeld: € 50.000 winst in
2026 met urencriterium geeft € 7.607,83 inkomstenbelasting en € 2.066,22 Zvw.

## De database (migratie `20261118150000`)

- **`income_tax_profiles`:** per ondernemer of vennoot per kalenderjaar, één
  rij (unique nulls not distinct). Het kalenderjaar omdat de
  inkomstenbelasting per kalenderjaar rekent, ook als een boekjaar anders
  loopt; de raming telt dan de boekingen van 1 januari tot en met 31 december,
  en zegt dat erbij.
- **`income_tax_corrections`:** voor de hele onderneming (bij een vof naar
  winstaandeel verdeeld) of voor één vennoot. De richting hoort bij de soort:
  een bijtelling is positief, EIA/MIA negatief.
- **`income_tax_kia_exclusions`:** de activa die niet meetellen voor de KIA.
- **`get_income_tax_inputs`:** alles wat het rekenhart nodig heeft, in één
  aanroep. De winst komt uit dezelfde bron als Eigen vermogen: de W&V zonder de
  jaarafsluiting, maar dan over het kalenderjaar. Ook de kosten op 4600
  (subtype `mixed_costs`) en de uren van de eigenaar. Die uren alleen met
  leesrecht op Uren; Gerrie geeft met `p_owner_hours` mee of de aanroeper Uren
  mag lezen.
- **Schrijven alleen via functies:** `save_income_tax_profile`,
  `add_income_tax_correction`, `delete_income_tax_correction` en
  `set_income_tax_kia_exclusion`.
- **Geen boeking:** de inkomstenbelasting is een privéschuld van de ondernemer,
  geen kosten van de onderneming.

## Beveiliging

- **Lezen:** met leesrecht op Financiën. De tabellen hebben een leesregel plus
  de modulepoort; de functie toetst zelf de organisatie en de module.
- **Schrijven:** alleen via de functies, met schrijfrecht op de organisatie én
  op Financiën. Rechtstreeks in de tabellen schrijven kan niet: geen
  schrijfregel, en `insert`, `update`, `delete` zijn ingetrokken.
- **Nooit een vennoot of activum van een andere organisatie:**
  - de functies toetsen het;
  - de tabellen hebben samengestelde sleutels `(organization_id, partner_id)`
    en `(organization_id, asset_id)`. Daarvoor kregen `partnership_partners` en
    `fixed_assets` een unieke sleutel `(organization_id, id)`;
  - ook wie de functies omzeilt, kan zo geen rij naar een ander laten wijzen.
- **Commanditaire vennoot:** bij een commanditaire vennoot slaat de functie
  geen urencriterium, startersaftrek of ondernemersaftrek op.
- **Een stichting of vereniging:** krijgt geen raming. Een BV of NV staat bij
  Vennootschapsbelasting.
- **Logboek:** wijzigingen komen onder Financiën (`income_tax_profile`,
  `income_tax_correction`). Bedragen staan er niet met hun waarde in, alleen
  "gewijzigd".
- **Gegevens meenemen:** de drie tabellen gaan mee in de export.

## Verificatie

Alles hieronder na het samenvoegen met staging. Daar kwamen vandaag de
controle eenmanszaak, het wisselen van btw-tijdvak, bonnen en declaraties en
instellingen in groepen bij. Mijn migratie had eerst hetzelfde versienummer als
die van de eenmanszaak (`20261118090000`). Hij heet nu `20261118150000`, na de
laatste op staging.

- **Rekenhart:** `npm test`, 2013 tests groen, waarvan 42 voor de raming:
  - elke stap van de som en de randen van de tabellen (KIA, kortingen,
    schijven);
  - de verdeling, gelijk aan `partnership_result_shares`;
  - de prognose;
  - het overzicht voor eenmanszaak, vof, cv en een vof zonder vennoten;
  - de gemengde kosten en het urencriterium uit Uren;
  - de gelijkheid met `incomeTax.ts` van Eigen vermogen;
  - de spiegel, teken voor teken.
- **Database, end-to-end:** nieuw scenario `npm run test:stromen --
  inkomstenbelasting`, tegen een lokale stack met echte gebruikers, RLS en alle
  migraties. 8 stappen, 0 fouten:
  - de winst van het kalenderjaar, en de uren van de eigenaar (ook: geen uren
    voor de boekhouder, en niet zonder `p_owner_hours`);
  - opslaan en bijwerken, en een raming die tot op de cent klopt;
  - rechten voor lezer, zonder Financiën, een andere organisatie en anoniem;
  - rechtstreeks schrijven, dat geweigerd wordt;
  - de invoercontrole;
  - correcties, KIA en 4600;
  - de samengestelde sleutels;
  - vof met dezelfde verdeling als de database;
  - cv met een commanditaire vennoot, stichting en het logboek.

  Samen met de scenario's die vandaag de boekhouding raakten (`eenmanszaak`,
  `bonnen`, `vooruitbetaald`): 91 stappen, 0 fouten.
- **Migratieketen:** `supabase db reset` op een lege database, alle 283
  migraties, de mijne als laatste. De migratie draait ook een tweede keer
  schoon.
- **Typecheck en build:** typecheck ✓, build ✓, CSP ✓.
- **Deno-check:** alle 35 functies uit de CI-lijst, `documentLayout`,
  `documentPdf` en de raming zelf ✓. esm.sh en deno.land zijn vanuit de
  cloudsessie niet bereikbaar; daarom ging het met een import-map naar dezelfde
  pakketten via npm. In CI draait de gewone check.
- **Scherm:**
  - mobiele lay-outtest met beide thema's voor de raming als eenmanszaak en als
    vof: telefoon, tablet en liggend, 0 problemen. De volledige ronde over alle
    pagina's na het samenvoegen staat hieronder bij de uitrol;
  - laadtest: alle controles geslaagd; de pagina haalt geen zware groep op;
  - terugknop: 15 gelukt.
- **Zelf bekeken, en hersteld vóór het uitrollen:**
  - op de telefoon viel de bedragenkolom van de berekening buiten beeld. De
    algemene regel voor brede boekhoudtabellen (min-width 560px, zijwaarts
    schuiven) gold ook hier; een tabel met twee kolommen past nu gewoon;
  - een aftrek van nul stond er als "€ -0,00";
  - de keuzelijst "Voor" bij de correcties liep met een lange naam buiten de
    kaart;
  - het gemiddelde tarief stond er met drie decimalen.

  De bedragen op het scherm zijn met de hand nagerekend: een eenmanszaak met
  € 52.345,67 winst, en een vof met een vennoot die in augustus de
  AOW-leeftijd bereikt.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Ander inkomen, de fiscale partner, persoonlijke aftrekposten, combinatiekorting en alleenstaande-ouderenkorting | ResoFly kent ze niet. De disclaimer zegt het, op het scherm, in de CSV en bij Gerrie. |
| Geboren vóór 1946 (een ruimere eerste schijf) | Zeldzaam. De raming valt dan iets te hoog uit. |
| Bedragen voor 2027 | Nog niet vastgesteld (Belastingplan 2027). Tot dan rekent 2027 met 2026, en zegt dat. |
| S&O-, meewerk- en stakingsaftrek, verlies uit eerdere jaren | Hangen van meer af dan de boekhouding. Je vult ze zelf in. |
| Desinvesteringsbijtelling, en de KIA over investeringen van vennoten buiten de vof | Als correctie in te vullen. |
| Startersaftrek bij arbeidsongeschiktheid | Andere voorwaarden (800 uur). Niet als keuze. |
| Een arbeidsvergoeding of rente over het kapitaal vóór de winstverdeling | Zoals bij de jaarafsluiting: naar rato van het winstaandeel. |

Bronnen (Belastingdienst en Wet IB 2001):

- box 1-tarieven 2025 en 2026, ook met de AOW-leeftijd;
- tabellen algemene heffingskorting, arbeidskorting en ouderenkorting;
- ondernemersaftrek en mkb-winstvrijstelling 2026, en arbeidsinkomen;
- KIA 2025 en 2026;
- percentages bijdrage Zvw;
- art. 2.10, 2.10a, 3.41, 3.76, 3.79a en 8.11 Wet IB 2001;
- HR 1 mei 2020 (KIA bij een samenwerkingsverband).
