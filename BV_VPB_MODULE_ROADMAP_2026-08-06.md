# Zakelijke module: boekhouden voor een BV — roadmap 2026-08-06

ResoFly's boekhouding is impliciet gebouwd voor de IB-ondernemer (eenmanszaak): het
rekeningschema kent één `0500 Eigen vermogen`, het resultaat gaat rechtstreeks naar
`0510`, en de urencriterium-monitor gaat uit van een ondernemer voor de inkomstenbelasting.
Deze roadmap maakt ResoFly geschikt voor klanten met een BV, tot en met een genereerbare
jaarrekening en publicatiestukken.

**Status: fase 0 GEBOUWD en op staging toegepast (2026-08-07). Fase 1 GEBOUWD, nog niet toegepast.
Fase 2 t/m 5 open.**

Fase 0 — migraties `20260807000000_business_module_entities.sql` +
`20260807010000_business_entity_limit_message.sql` toegepast; edge function `billing` opnieuw
gedeployed (boot-health 401, geen BOOT_ERROR). Nog niet e2e getest met een ingelogde gebruiker.

Fase 1 — migraties `20260807020000_bv_chart_and_report_groups.sql` +
`20260807030000_result_appropriation.sql` geschreven; frontend aangepast (`ProfitLoss.tsx`,
`FiscalYears.tsx`, `Bookkeeping.tsx`, `xaf.ts`, `types.ts`, `repository.ts`). `npm run build`
en `tsc --noEmit` groen. **De SQL is nog nergens uitgevoerd** — er is lokaal geen Postgres en geen
Docker, dus de migraties gaan rechtstreeks naar staging. Wel doorgelicht met een tegensprekende
review (15 bevindingen, alle verholpen; zie "Wat de review opleverde" onderaan).

## Beslissingen (PO, 2026-08-06)

| Onderwerp | Keuze |
|---|---|
| Reikwijdte v1 | Volledig zelfstandig: fase 0 t/m 5, t/m jaarrekening + publicatiestukken |
| Holding-structuren | Ja — meerdere entiteiten binnen één account |
| Verpakking | Betaalde module "Zakelijk" (entitlement-sleutel `business`), zelfde patroon als de creatieve module |

Buiten scope (bewust): elektronisch indienen van de Vpb-aangifte en deponeren bij de KvK
via SBR/XBRL over Digipoort, en een eigen salarisadministratie. Zie "Grenzen" onderaan.

## Architectuur: meerdere entiteiten

### Waarom niet `entity_id` op alle tabellen

De voor de hand liggende aanpak — een tabel `legal_entities` en een `entity_id` op elke
financiële tabel — raakt ~50 org-gescopete tabellen, elke RPC-signatuur, elke unieke
constraint (factuurnummering, rekeningcodes) en elk rapport. Voor een financieel product
is dat een groot lek-oppervlak: één vergeten `entity_id` in een `where` betekent cijfers
van de holding in de jaarrekening van de werk-BV.

### Wel: administratie-boom via child-organisaties

De hele codebase gaat er al van uit dat **één organisatie = één administratie**. Die
aanname houden we, en we zetten organisaties in een boom van één niveau diep:

```
organizations.parent_organization_id uuid null references organizations(id)
  + trigger: een moeder mag zelf geen moeder hebben (max. 1 niveau)
```

Wat dit oplevert:

- **Nul wijzigingen aan het beveiligingsmodel.** RLS loopt platformbreed via
  `can_read_org` / `can_write_org` / `can_admin_org` → `user_is_org_member`. Die functies
  blijven ongemoeid. Toegang tot een dochter-administratie is een **echte
  membership-rij** op die dochter, geen impliciete erving. Erven zou betekenen dat elk
  teamlid van de holding automatisch in de werk-BV kan kijken — precies wat je bij een
  administratie niet wilt.
- **Per entiteit eigen instellingen.** `company_settings` is al per organisatie: eigen
  KvK-nummer, rechtsvorm, boekjaar, BTW-periode, rekeningschema, factuurnummering,
  boekjaren en afgesloten perioden. Een holding en een werk-BV zijn fiscaal en juridisch
  ook echt losse administraties.
- **Rechten per entiteit zijn er al.** `organization_members.module_access` (migratie
  20260730100000) geeft per lid per module geen/lezen/volledig — dus "Jan mag in de
  holding de boekhouding lezen en in de werk-BV alles" werkt zonder nieuw mechanisme.
- **De wisselaar bestaat al.** `activeOrganizationId` + `switchOrganization` in
  `src/main.tsx`; dit wordt een gegroepeerde entiteitskiezer in plaats van een platte lijst.

Wat er wél moet veranderen, en dat is het echte werk van fase 0:

- **Billing en entitlements moeten omhoog kijken.** Abonnement, seats, opslagbundel,
  creatieve module en de nieuwe zakelijke module horen bij de **moeder**, niet per
  dochter. Er komt één helper `billing_root_organization(org)` (= `coalesce(parent, self)`)
  en elke bestaande entitlement-check gaat daar doorheen.
- **Seats niet dubbel tellen.** Een gebruiker die in de holding én de werk-BV zit is
  één licentie. `get_license_usage` moet uniek tellen op `user_id` over de hele boom.
  Zonder deze fix betaalt de klant dubbel voor dezelfde persoon.
- **Prijsmodel:** vast bedrag voor de module + een bedrag per extra administratie
  (holding + werk-BV = één extra). Vast te stellen door de PO.

## Rekeningschema voor een BV

`ensure_default_ledger_accounts` wordt rechtsvorm-bewust. Bestaande administraties
krijgen **nooit** met terugwerkende kracht BV-rekeningen erbij.

### Eigen vermogen (het grootste verschil)

| Code | Naam | Toelichting |
|---|---|---|
| `0500` | Geplaatst en gestort aandelenkapitaal | vervangt het generieke "Eigen vermogen" |
| `0505` | Agio | gestort bovenop de nominale waarde |
| `0510` | Onverdeeld resultaat | bestaat al |
| `0520` | Overige reserves | hier landt het resultaat ná vaststelling door de AvA |
| `0530` | Wettelijke reserves | verplicht bij o.a. geactiveerde ontwikkelingskosten en deelnemingen |

Privé-opnamen en -stortingen bestaan **niet** bij een BV. Geld naar de aandeelhouder is
loon, dividend of een lening in rekening-courant — nooit "privé".

### Vaste activa, voorzieningen, langlopend

| Code | Naam |
|---|---|
| `0020` / `0025` | Immateriële vaste activa / cumulatieve amortisatie |
| `0300` | Deelnemingen (financiële vaste activa) |
| `0310` | Vorderingen op groepsmaatschappijen |
| `0350` | Latente belastingvordering |
| `0600` | Voorzieningen |
| `0610` | Latente belastingverplichting |
| `0700` / `0710` | Langlopende schulden / lening o/g DGA |

### Kortlopend en fiscaal

| Code | Naam |
|---|---|
| `1400` | Rekening-courant DGA (saldo mag beide kanten op) |
| `1540` / `1545` | Te betalen Vpb / betaalde voorlopige aanslagen |
| `1550` / `1555` | Te betalen loonheffingen / pensioenpremies |
| `1560` | Te betalen dividendbelasting |
| `1570` | Nettolonen te betalen |

### Kosten

`4100` Brutolonen (incl. DGA-loon) · `4110` Sociale lasten · `4120` Pensioenlasten ·
`9900` Vennootschapsbelasting (staat in de W&V **onder** het bedrijfsresultaat).

## Rapportage: van platte lijst naar ingedeelde balans

`report_balance_sheet` levert nu losse rekeningen op en de UI zet ze in twee kolommen
(`src/features/ProfitLoss.tsx`). Een BV-balans moet ingedeeld zijn volgens Titel 9 Boek 2 BW.

- Nieuwe kolom `ledger_accounts.report_group` (vaste activa immaterieel/materieel/financieel,
  voorraden, vorderingen, liquide middelen, eigen vermogen, voorzieningen, langlopende
  schulden, kortlopende schulden) met subtotalen per groep.
- **Vergelijkende cijfers vorig boekjaar** — in een jaarrekening verplicht; de rapporten
  kennen nu alleen de huidige periode.
- W&V in secties: bedrijfsresultaat → financiële baten en lasten → **resultaat vóór
  belastingen** → belastingen → **resultaat na belastingen**.
- Dit is óók winst voor eenmanszaken: geen weggegooid werk.

### Resultaatbestemming in twee stappen

`close_fiscal_year` boekt het resultaat nu rechtstreeks naar `0510`. Bij een BV zijn dat
twee juridisch verschillende momenten:

1. **Jaarafsluiting** — resultaat ná belasting naar `0510` Onverdeeld resultaat.
2. **Vaststelling door de AvA** — nieuwe RPC `appropriate_result`: van `0510` naar
   `0520` Overige reserves en/of naar een dividenduitkering.

De bestaande instelling `company_settings.year_result_account_code` is hier al het haakje voor.

## Vennootschapsbelasting

Rekenhart als los, unit-getest bestand (`supabase/functions/_shared/vpb.ts`), in dezelfde
vorm als `dunning.ts`:

- Commercieel resultaat → fiscale correcties (niet- en beperkt aftrekbare kosten,
  afschrijvingsbeperking gebouwen, investeringsaftrek) → verliesverrekening → belastbaar
  bedrag → tarief per schijf.
- **Tarieven en drempels periodegedateerd in de database**, zoals `statutory_interest_rates`
  bij de debiteurenautomaat. Indicatief geldt 19% tot €200.000 en 25,8% daarboven, maar
  elk bedrag wordt bij het bouwen geverifieerd en per jaar vastgelegd — niet hardcoded.
- Verliesverrekening met de beperking dat boven een drempel (indicatief €1 mln) nog maar
  een deel van de winst verrekend mag worden; achterwaarts 1 jaar, voorwaarts onbeperkt.
- Boekingen: periodieke reservering (`9900` / `1540`), voorlopige aanslag (`1545`),
  afrekening bij de definitieve aanslag.
- Export: specificatie voor de accountant (PDF/XLSX) bovenop de bestaande XAF-auditfile.

Dit overlapt met de eerder bedachte "belastingpotje + cashflow-prognose": voor een BV
wordt de IB-schatting daarin een Vpb-reservering.

## DGA

- **Rekening-courant** met saldobewaking, zakelijke renteberekening en een waarschuwing
  bij overschrijding van de leendrempel uit de Wet excessief lenen bij eigen vennootschap
  (indicatief €500.000 — te verifiëren en periodegedateerd vastleggen).
- **Gebruikelijk loon**: norm per jaar in dezelfde tarieventabel, met een signaal
  "nog geen DGA-loon geboekt dit jaar".
- **Loonjournaalpost**: sjabloon en import van de journaalpost van de salarisverwerker
  (CSV). Géén eigen salarisadministratie — zie Grenzen.

## Aandeelhouders en dividend

- `shareholders` + mutaties: het aandeelhoudersregister is wettelijk verplicht (art. 2:194 BW).
- `dividend_distributions` met een **verplichte uitkeringstoets** (art. 2:216 BW): balanstest
  (is er vrij uitkeerbaar vermogen?) én uitkeringstest (kan de BV daarna haar opeisbare
  schulden nog betalen?). De RPC blokkeert het besluit als de balanstest faalt en vraagt om
  expliciete bestuurdersbevestiging voor de uitkeringstest.
- Dividendbelasting inhouden (indicatief 15%) en boeken op `1560`, met de gegevens voor de
  aangifte dividendbelasting.
- Notulen AvA als sjabloon in de bestaande contracten-/Collabora-module.

## Jaarrekening en publicatie

- `annual_accounts`: opgemaakt → vastgesteld, met een bevroren snapshot van de cijfers.
- Jaarrekening-PDF: balans ná resultaatbestemming, W&V, grondslagen, toelichting,
  ondertekening door het bestuur — via de bestaande PDF-pipeline.
- **Groottecriteria** (micro/klein/middelgroot) afgeleid uit balanstotaal, omzet en
  personeelsomvang; bepaalt hoe beperkt de publicatiestukken mogen zijn.
- Publicatiestukken als aparte, beperkte set.
- **Termijnen automatisch als taken/agenda-items** (jullie hebben taken, agenda én cron):
  opmaken binnen 5 maanden na boekjaareinde met maximaal 5 maanden uitstel, vaststellen
  door de AvA, deponeren uiterlijk 12 maanden na boekjaareinde. Dit is een goedkope,
  zichtbare waardetoevoeging.

## Wat er voor een BV juist uit moet

- **Urencriterium-monitor (1225)** — geldt alleen voor IB-ondernemers. Verbergen bij
  `fiscal_regime = 'vpb'`. Zie migratie 20260722100000 en `src/features/TimeTracking.tsx`.
- Privé-opnamen/-stortingen → vervangen door rekening-courant DGA.
- Zelfstandigenaftrek en MKB-winstvrijstelling in elke toekomstige belastingschatting.

## Fasering

| Fase | Inhoud | Migratie / bestanden | Inschatting |
|---|---|---|---|
| 0 | **KLAAR** — entiteiten-boom, `legal_form`, entitlement `business`, billing-root, seats uniek over de boom, entiteitswisselaar, 1225-monitor uit bij een BV | `20260807000000` + `20260807010000`, `Sidebar.tsx`, `main.tsx`, `SimplePages.tsx`, `TimeTracking.tsx`, `billing`-edge-function | gedaan |
| 1 | **KLAAR (nog niet toegepast)** — BV-rekeningschema, `report_group`, ingedeelde balans + W&V met vergelijkende cijfers, resultaatbestemming in twee stappen | `20260807020000` + `20260807030000`, `ProfitLoss.tsx`, `FiscalYears.tsx`, `Bookkeeping.tsx`, `xaf.ts` | gedaan |
| 2 | Vpb: tarieventabel, correcties, verliesverrekening, reservering, aanslagen, specificatie | `..._corporate_tax.sql`, `_shared/vpb.ts` | 1–1,5 week |
| 3 | DGA: rekening-courant, rente + drempelsignaal, loonjournaalpost, gebruikelijk loon | `..._dga_payroll.sql` | 4–5 dagen |
| 4 | Aandeelhoudersregister, uitkeringstoets, dividend + dividendbelasting | `..._shareholders_dividends.sql` | 3–4 dagen |
| 5 | Jaarrekening, publicatiestukken, groottecriteria, deponeer-deadlines | `..._annual_accounts.sql` | 1 week |
| 6 | Intercompany-boekingen + afstemrapport, consolidatie over de boom, fiscale eenheid | later | apart traject |

Na fase 0+1 is er al een bruikbaar product: een BV-klant boekt met een correct
rekeningschema en een correcte balans, en de accountant haalt de XAF-auditfile op.

## Openstaand uit fase 0

- **Extra administratie bijkopen is nog geen self-service.** `entity_addons` op het
  billingprofiel wordt handmatig gezet; het abonnementsscherm toont wel de prijs per
  extra administratie. Een koopknop (Mollie-bedrag patchen, zoals de opslagbundel) is
  een kleine fast-follow.
- **Prijzen bevestigen.** Startwaarden staan in de plancatalogus: module €19,00 p/m
  (€190,00 p/j), extra administratie €9,00 p/m (€90,00 p/j). Aanpassen is een UPDATE op
  `billing_plans`, geen migratie.
- **E2E met login.** De administratie-boom (trigger op twee niveaus, seats-ontdubbeling,
  aanmaken van een dochter) is nog niet met een ingelogde gebruiker doorlopen.

## Grenzen

- **Elektronisch indienen en deponeren** (Vpb-aangifte, jaarrekening bij de KvK) loopt via
  SBR/XBRL over Digipoort met een PKIoverheid-certificaat. Dat is een apart traject met
  certificaatbeheer en aansprakelijkheid. Wij berekenen, specificeren en genereren;
  indienen doet de klant of de accountant — net zoals nu bij de BTW-aangifte.
- **Geen eigen salarisadministratie.** Loonaangifte, loonheffingstabellen en
  correctieberichten zijn een eigen product en een aansprakelijkheidsrisico. Wel: de
  journaalpost verwerken.
- **Geen fiscaal advies.** Alle berekeningen zijn hulpmiddelen met een expliciete
  disclaimer, consistent met de lijn bij het belastingpotje.

## Wat fase 1 precies geworden is

- **`ledger_accounts.report_group`** — de rubriek hangt aan de rekening, niet aan het rapport. Twintig
  waarden, gedekt door een CHECK: de hoofdindeling van art. 2:364 BW voor de balans en van art. 2:377 BW
  (Model E) voor de W&V. Bestaande rekeningen zijn éénmalig gerubriceerd op hun subtype en code, dus elke
  administratie heeft meteen een ingedeelde balans. In het scherm Grootboek is de rubriek per rekening aan
  te passen, ook bij systeemrekeningen — het is presentatie, geen boeking.
- **`ledger_accounts.is_restricted_reserve`** — vinkje "wettelijke of statutaire reserve". Nodig omdat de
  balanstest anders een statutaire reserve als vrij uitkeerbaar zou meetellen; welke reserve statutair is,
  staat in de statuten van díe BV en kan alleen de gebruiker aanwijzen.
- **BV-rekeningschema** — `ensure_business_ledger_accounts`, alleen aangeroepen bij fiscaal regime `vpb` en
  afgeschermd met een bestaanscheck op 0505 (want `post_journal_entry` komt bij élke boeking langs). Geen
  backfill: een bestaande eenmanszaak krijgt nooit met terugwerkende kracht aandelenkapitaal.
- **Ingedeelde balans en W&V** — beide rapport-RPC's geven nu `report_group` + `group_rank` mee. De balans
  toont per rubriek een subtotaal met de vergelijkende cijfers van de vorige periode ernaast (art. 2:363
  lid 5 BW), met de boekwaarde per activum als uitklapbare toelichting. De W&V loopt via som der
  bedrijfsopbrengsten → som der bedrijfslasten → bedrijfsresultaat → financiële baten en lasten →
  resultaat vóór belastingen → belastingen → resultaat na belastingen. Secties zonder rekeningen blijven
  weg, dus een eenmanszaak ziet gewoon een gerubriceerde W&V.
- **Resultaatbestemming** — `appropriate_result` legt het besluit van de AvA vast en boekt van 0510 naar
  0520 en/of naar 1580 Te betalen dividend. Met de balanstest (art. 2:216 lid 1 BW; bij een NV de strengere
  van art. 2:105 lid 2 BW) als harde blokkade en de uitkeringstest (lid 2) als verplichte
  bestuursbevestiging die met naam en tijdstip wordt vastgelegd. Terugdraaien zet het boekstuk op
  `reversed`, net als bij het heropenen van een boekjaar — een spiegelpost zou in een later, mogelijk
  vergrendeld kwartaal vallen en de bestemming voorgoed onomkeerbaar maken.
- **Meegenomen tijdens de review:** financiële baten en lasten tellen niet meer als omzet in de
  BTW-aangifte (rubriek 1e), de XAF-auditfile bevat nu ook `result_appropriation` en `asset_disposal`, en de
  fase-0 hulpfuncties (`org_legal_form` en verwanten) zijn dichtgezet tot `service_role`.

## Wat de review opleverde

Vijf review-invalshoeken (SQL-parsing, boekhoudkundige juistheid, regressie, security, Nederlands recht) met
per bevinding een tegenspreker. Vijftien bevindingen overleefden en zijn alle verholpen. De vier die er het
meest toe deden:

1. `org_distributable_equity` was `security definer` zonder toegangscontrole en stond open voor elke
   ingelogde gebruiker — het eigen vermogen van elke andere organisatie was op te vragen.
2. Terugdraaien van een resultaatbestemming liep dood zodra het btw-kwartaal van de besluitdatum was
   gefinaliseerd; het boekjaar was daarna nooit meer te heropenen.
3. `result_appropriations` had geen modulepoort, dus een teamlid met financiën op "geen" kon
   dividendbesluiten inzien.
4. `revoke ... from public` haalt de grant aan `anon` niet weg die Supabase via ALTER DEFAULT PRIVILEGES op
   elke nieuwe functie zet. Dat patroon staat door de hele codebase; hier is het voor de nieuwe en de
   fase-0-functies rechtgezet.

## Te verifiëren vóór livegang

Elk tarief en elke drempel wordt bij het bouwen geverifieerd en **periodegedateerd**
opgeslagen, nooit hardcoded: Vpb-schijfgrens en -tarieven per jaar, drempel en percentage
voor verliesverrekening, gebruikelijkloonnorm, leendrempel excessief lenen,
dividendbelastingtarief, en de groottecriteria voor de publicatieplicht.

### Al nagezocht bij fase 1 (bronnen: wetten.overheid.nl, Staatsblad, KVK)

Voor fase 5 alvast vastgelegd, want deze zijn met bron geverifieerd:

| Klasse | Balanstotaal | Netto-omzet | Werknemers | Artikel |
|---|---|---|---|---|
| Micro | ≤ € 450.000 | ≤ € 900.000 | < 10 | 2:395a lid 1 BW |
| Klein | ≤ € 7.500.000 | ≤ € 15.000.000 | < 50 | 2:396 lid 1 BW |
| Middelgroot | ≤ € 25.000.000 | ≤ € 50.000.000 | < 250 | 2:397 lid 1 BW |
| Groot | restcategorie — voldoet niet aan 2:397 lid 1 | | | — |

Bedragen verhoogd bij Stb. 2024, 52 (in werking 13 maart 2024), geldend vanaf boekjaar 2024 met de
mogelijkheid ze al op boekjaar 2023 toe te passen. De aantallen werknemers zijn níet gewijzigd. Let op de
twee valkuilen: je valt in een klasse bij **minstens twee van de drie** criteria, en pas als je daar **twee
opeenvolgende balansdata** aan voldoet — een momentopname per jaar is dus fout. Het balanstotaal wordt
gemeten op verkrijgings- of vervaardigingsprijs, niet op actuele waarde. De KVK-samenvattingspagina noemt
voor groot "> € 51 mln" en wijkt daarmee af van de wet; aanhouden wat in het BW staat.

Verder nagezocht en verwerkt in fase 1:

- **Model E kent geen regel "Bedrijfsresultaat"** — alleen "Som der bedrijfsopbrengsten" en "Som der
  bedrijfslasten". Wij tonen het subtotaal wel (praktijk en RJ), maar het is geen wettelijke modelregel.
- **"Resultaat uit gewone bedrijfsuitoefening" hoort niet meer als subtotaal in een jaarrekening** vanaf
  boekjaar 2016: Stb. 2015, 350 hernoemde die regels naar "Resultaat voor belastingen" en "belastingen".
  De term staat overigens nog wél in art. 2:377 lid 1 sub a BW — alleen de buitengewone tak is geschrapt.
- **Het aandeel in het resultaat van deelnemingen staat in Model E ná de belastingregel**, tussen
  "Resultaat voor belastingen" en "Resultaat na belastingen".
- **Art. 2:216 lid 1 BW is een BEPERKTE balanstest**: de ondergrens is alleen het saldo van de wettelijke en
  statutaire reserves, niet het hele eigen vermogen. Bij een **NV** geldt art. 2:105 lid 2 BW en telt het
  gestorte en opgevraagde kapitaal wél mee in de ondergrens.
- **Art. 2:216 lid 3 BW** — bij een tekort na de uitkering zijn de bestuurders die dat wisten of behoorden
  te voorzien hoofdelijk verbonden, en moet ook de ontvanger die dat wist of behoorde te voorzien zijn
  uitkering terugbetalen, tot ten hoogste het ontvangen bedrag.
- **Vergelijkende cijfers** zijn verplicht op grond van art. 2:363 lid 5 BW, maar met de nuance "zoveel
  mogelijk", plus de plicht om ze bij een stelselwijziging te herzien en de afwijking toe te lichten. Dat
  laatste zit nog niet in het product.

Nog **niet** nagezocht en dus open voor fase 2 t/m 4: de Vpb-schijfgrens en -tarieven per jaar, de
verliesverrekeningsdrempel, de gebruikelijkloonnorm, de leendrempel excessief lenen en het
dividendbelastingtarief.
