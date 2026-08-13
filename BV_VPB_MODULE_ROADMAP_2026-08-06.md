# Zakelijke module: boekhouden voor een BV — roadmap 2026-08-06

ResoFly's boekhouding is impliciet gebouwd voor de IB-ondernemer (eenmanszaak): het
rekeningschema kent één `0500 Eigen vermogen`, het resultaat gaat rechtstreeks naar
`0510`, en de urencriterium-monitor gaat uit van een ondernemer voor de inkomstenbelasting.
Deze roadmap maakt ResoFly geschikt voor klanten met een BV, tot en met een genereerbare
jaarrekening en publicatiestukken.

**Status per 2026-08-07: fase 0 t/m 4 GEBOUWD en op staging toegepast. Fase 5 open.**

Alles staat op de branch `staging` en is toegepast op `enzghpduqwaojcxgwarr`:

| Migratie | Inhoud |
|---|---|
| `20260807000000` + `010000` | fase 0 — rechtsvorm, administratie-boom, entitlement, billing via de moeder |
| `20260807020000` + `030000` | fase 1 — `report_group`, BV-rekeningschema, ingedeelde balans + W&V, resultaatbestemming |
| `20260807040000` | vier losse eindjes uit fase 1 |
| `20260807050000` | fase 2 — vennootschapsbelasting (tarieven, correcties, verliesverrekening, reservering) |
| `20260807060000` | fase 3a — DGA-normen en signalen |
| `20260807070000` | fase 3b — rente rekening-courant DGA |
| `20260807080000` | fase 3c — loonjournaalpost |
| `20260807090000` | vier bevindingen uit de review op fase 3 |
| `20260807100000` | fase 4 — aandeelhoudersregister, uitkeringstoets, dividend en dividendbelasting |

Daarnaast: edge function `corporate-tax`, het rekenhart `_shared/vpb.ts` met 18 tests
(`npm test`), en de schermen `CorporateTax.tsx` en de uitbreidingen in `ProfitLoss.tsx`,
`FiscalYears.tsx` en `Bookkeeping.tsx`.

**Nog niet gedaan: e2e met een ingelogde gebruiker.** Alle verificatie liep via de database
en de rapport-RPC's; de schermen zijn niet klikkend doorlopen. Ook staat er nog geen
BV-administratie op staging, dus het BV-rekeningschema, de resultaatbestemming en de
Vpb-keten zijn nog niet tegen echte BV-data gedraaid.

Elke migratie is vóór toepassing tegensprekend gereviewd (drie rondes, 15 + 12 + 15
bevindingen, alle verholpen — waaronder drie blockers).

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
| 2 | **GROTENDEELS KLAAR** — Vpb: tarieventabel (2021 t/m 2026, periodegedateerd), rekenhart met 18 tests, correcties, verliesverrekening, reservering op 9900/1540, edge function. **Rest: het scherm en de specificatie-export.** | `20260807050000`, `_shared/vpb.ts`, `corporate-tax`-edge-function | scherm nog open |
| 3 | **KLAAR** — normen, signalen, rekening-courant met eigen rentepercentage en dagsaldo-berekening, DGA-scherm, loonjournaalpost-import | `20260807060000` t/m `080000`, `Dga.tsx`, `PayrollImport.tsx` | gedaan |
| 4 | **KLAAR** — aandeelhoudersregister (art. 2:194 BW) met mutaties en pand/vruchtgebruik, uitkeringstoets ook op het interim-dividend, dividendbelasting met inhoudingsvrijstelling per aandeelhouder | `20260807100000`, `Shareholders.tsx`, `Dividends.tsx` | gedaan |
| 5 | **BROK A + B + C KLAAR** — groottecriteria, vergelijkende rapportage, balans ná resultaatbestemming; jaarrekening bevriezen met de levenscyclus opmaken → tekenen → vaststellen → deponeren; PDF-laag, jaarrekening-PDF en publicatiestukken per groottecategorie. **Brok D (scherm) en E (deadlines + cron) open** | `20260812000000` + `20260812010000`, `_shared/reportPdf.ts`, `_shared/annualAccountsLayout.ts`, edge fn `annual-accounts` | A+B+C gedaan |
| 6 | Intercompany-boekingen + afstemrapport, consolidatie over de boom, fiscale eenheid | later | apart traject |

Na fase 0+1 is er al een bruikbaar product: een BV-klant boekt met een correct
rekeningschema en een correcte balans, en de accountant haalt de XAF-auditfile op.

## Fase 5, brok A — wat er staat en wat er nog niet is nagelopen

Migratie `20260812000000_company_size_and_comparative_reports.sql` is op staging toegepast
(het nummer springt naar 12 augustus omdat er al weekplanner-migraties van 10 en 11 augustus
op de remote stonden). De vier nieuwe RPC's antwoorden met `42501` op een anon-sleutel: ze
bestaan en `anon` kan er niet bij.

**De groottetoets is plakkerig, niet "de zwaarste van twee jaren".** De klasse blijft staan
tot de rechtspersoon er twee opeenvolgende balansdata niet meer in valt en springt dán naar
de rauwe klasse van dat jaar — symmetrisch, dus even goed bij groeien als bij krimpen
(art. 2:395a/396/397 **lid 1** BW; lid 2 is de groepsmeetelregel). Een eerdere ronde
implementeerde `rauw(k) = rauw(k-1)`; dat is fout en houdt een BV klein terwijl zij al twee
jaar boven de grens zit. De zes verplichte testvectoren staan als commentaar bij de functie.

Drempels: 2016-reeks (Stb. 2015, 349) en 2024-reeks (Stb. 2024, 52), beide met bron.
Balanstotaal en omzet zijn "niet meer dan" (`<=`), werknemers "minder dan" (strikt `<`).
Boekjaar 2023 kent een dubbel regime; de keuze staat per boekjaar op
`fiscal_year_size_inputs.early_adopt_new_thresholds`.

**Nog niet nagelopen — eerlijk te noemen:**
- De zes testvectoren zijn nog door niemand door de code getraceerd; de verificatieronde viel
  uit op een sessielimiet. Doe dat vóór brok D, of toets ze op een BV-administratie op staging.
- De ketenlus roept per boekjaar `report_balance_sheet` en `report_profit_and_loss` aan. Nu
  begrensd op twaalf boekjaren, maar het blijft lineair in het aantal jaren.
- `is_first_fiscal_year_of_entity` kan verouderen als er later een ouder boekjaar wordt
  ingevoerd; daar zit nog geen signaal op.

## Fase 5, brok B — de jaarrekening vastleggen

Migratie `20260812010000_annual_accounts.sql` staat op staging (commit `650feda`). Alle acht
RPC's antwoorden met `42501` op een anon-sleutel. Drie reviewrondes: 23 + 22 + 4 bevindingen,
waarvan twee blockers.

**Deponeren is een gebeurtenis, geen eindtoestand.** `annual_account_filings` houdt één rij per
deponering bij, zodat de route van art. 2:394 lid 2 BW werkt: onvastgesteld deponeren, later
alsnog vaststellen, en binnen acht dagen opnieuw deponeren. Een fout gedeponeerd stuk wordt niet
ingetrokken maar vervangen (`supersedes_annual_account_id`); het boekjaar mag daarvoor weer open,
want anders kan het opvolgende stuk alleen dezelfde cijfers herhalen.

**Wat de reviewers eruit haalden en wat het had gekost:** de vaststellingsdatum bij art. 2:210
lid 5 was vrij te kiezen terwijl de laatste handtekening hem bepaalt — dat schoof de
deponeerdeadline van acht dagen even ver mee op. De verplichte opgave van reden bij een
ontbrekende handtekening werd alleen bij vaststellen gecontroleerd, nooit bij deponeren, terwijl
juist de lid-2-route nooit langs vaststellen komt. De bevroren snapshot kon uit de pas lopen met
het grootboek zonder dat iets dat markeerde (nu `snapshot_stale`). En `attachment_module()` kende
`annual_account` niet, waardoor de modulepoort op de bijlagen openviel.

**Nog open uit brok B:** een verlenging van de opmaaktermijn die vóór het opmaken is besloten —
de gewone volgorde — is nog niet vast te leggen, omdat `extend_preparation_term` op een bestaande
jaarrekeningrij werkt. Doorgeschoven naar brok D/E.

## Fase 5, brok C — de PDF's

Drie bestanden, gedeployed als edge function `annual-accounts` (v1, boot-health 401):
`_shared/reportPdf.ts` (tabelhelper, pagina-engine, paginanummering), `_shared/annualAccountsLayout.ts`
(de stukken als data; `PUBLICATION_SETS` is één rij per groottecategorie) en `annual-accounts/index.ts`.
Commit `7964548`. `deno check` schoon, rooktest rendert alle acht varianten.

Reviewronde: 31 bevindingen, 3 blockers, 7 hoog — alle blockers en zware punten verwerkt.
Het scherpst: het Bruto-bedrijfsresultaat van art. 2:397 lid 4 BW trok een rubriek te veel samen
waardoor middelgroot te weinig publiceerde; de grondslagenparagraaf verklaarde naleving van Titel 9
(dat kan ResoFly niet weten en is nu constaterend); en de melding van art. 2:210 lid 2 bij een
ontbrekende handtekening ontbrak in het publicatiestuk. Micro, klein en middelgroot kregen bovendien
exact dezelfde balans; die verschillen nu in detailniveau.

De PDF is byte-reproduceerbaar gemaakt (pdf-lib stempelde de kloktijd in de metadata, waardoor de
sha256 van een herdruk nooit gelijk kon zijn aan die van het archiefexemplaar).

**Bewust blijven liggen — 21 midden/laag-bevindingen**, o.a.: elke her-render laat het vorige R2-object
en de vorige `attachments`-rij verweesd achter; de R2-route `/internal/annual-account-snapshot` bestaat
nog niet in `cloudflare-worker/worker.ts` (archiveren geeft dan `stored: false` mét reden, de PDF komt
wél terug); naam en woonplaats van de consoliderende moeder (art. 2:396 lid 5 BW) zitten niet in de
snapshot en vragen een migratiewijziging; de statutaire zetel wordt afgeleid uit het bezoekadres; en
"verkorte balans" is bij ons aggregatie op rubriek, niet de postenindeling van het Besluit modellen
jaarrekening — dat staat als voorbehoud in het stuk zelf.

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

Nagezocht en periodegedateerd vastgelegd bij fase 2 t/m 4: de Vpb-schijfgrenzen en -tarieven per jaar
(`corporate_tax_rates`), de verliesverrekeningsdrempel, de gebruikelijkloonnorm en de leendrempel
excessief lenen (`dga_norms`), de renteloze grens rekening-courant (`dga_current_account_limits`) en het
dividendbelastingtarief (`dividend_tax_rates`). Voor fase 5 staan de groottecriteria hierboven al klaar.

## Wat fase 4 precies geworden is

- **Het register is afgeleid, niet bijgehouden.** `shareholders` bevat namen en adressen;
  `share_transactions` bevat de gebeurtenissen (uitgifte, overdracht, inkoop, intrekking) met per
  gebeurtenis de verkrijgingsdatum, de datum van erkenning of betekening, de soort aandelen en het op
  ieder aandeel gestorte bedrag — precies wat art. 2:194 lid 1 BW opsomt. Een kolom "aantal aandelen"
  op de aandeelhouder zou die geschiedenis platslaan en het register waardeloos maken als bewijs.
  `shareholder_positions(org, peildatum)` telt het op en rekent het belang uit; door de vennootschap
  ingekochte aandelen horen bij niemand en vallen daarmee vanzelf uit de noemer, zoals art. 2:228 lid 6
  BW voor het stemrecht voorschrijft. `share_encumbrances` dekt lid 2 (pandrecht en vruchtgebruik, met
  de rechten die de houder toekomen).
- **De uitkeringstoets geldt nu ook tussentijds.** Fase 1 dekte alleen de weg via de vastgestelde
  jaarrekening, maar art. 2:216 lid 1 BW spreekt van "bestemming van de winst ... en vaststelling van
  uitkeringen". Een interim-dividend krijgt daarom dezelfde harde balanstest (met de strengere
  NV-ondergrens van art. 2:105 lid 2 BW waar van toepassing) en dezelfde verplichte bestuursgoedkeuring.
  Een wettelijke of statutaire reserve als bron wordt geweigerd: dat is nu juist het deel dat moet
  worden aangehouden.
- **Twee boekstukken, want twee momenten.** Het besluit maakt van eigen vermogen een schuld
  (0520 → 1580, bruto; bij een dividend uit de vastgestelde winst deed `appropriate_result` dat al).
  De terbeschikkingstelling is het moment van inhouden (art. 7 lid 3 Wet DB 1965): 1580 → 1560. Wat er
  daarna op 1580 staat is exact het netto bedrag voor de aandeelhouder. Uitbetalen en afdragen zijn
  gewone bankmutaties en lopen al via de bankmodule.
- **Inhoudingsvrijstelling per aandeelhouder, met verplichte onderbouwing.** Bij een holdingstructuur is
  dit meteen het normale geval: keert de werk-BV uit aan de holding, dan blijft de inhouding achterwege
  als de deelnemingsvrijstelling van toepassing is (art. 4 Wet DB 1965). Of dat zo is hangt af van
  belang, vestigingsplaats en misbruiktoets — dat leidt ResoFly niet af. De vlag wordt bij het boeken
  op de uitkeringsregel vastgeklonken, zodat een latere wijziging de geschiedenis niet herschrijft.
- **Geen BSN.** Voor de dividendnota van art. 9 Wet DB 1965 zijn naam en adres genoeg en de aangifte
  vraagt totalen. Bijzonder gevoelige gegevens opslaan zonder dat er iets mee gebeurt, doen we niet.
- **De aangifte blijft van de klant.** Het scherm toont wat er is ingehouden en tot wanneer het betaald
  moet zijn — één maand na terbeschikkingstelling (art. 7 lid 4 Wet DB 1965 jo. art. 19 lid 3 AWR) — plus
  een exporteerbare specificatie per ontvanger. Indienen doet de klant of de accountant, zoals bij de
  btw en de Vpb.
- **Nagezocht:** art. 5 Wet DB 1965 luidt "De belasting bedraagt 15% van de opbrengst"; verlaagd van 25%
  naar 15% per 1-1-2007 door de Wet werken aan winst (Stb. 2006, 631) en sindsdien ongewijzigd.
- **Getest tegen een echte BV.** Migratie plus een functionele test in één teruggedraaide transactie op
  staging: rechtsvorm, rekeningschema, register (60/40), balanstest die € 200.000 tegenhoudt bij
  € 150.000 vrij vermogen, weigering zonder bestuursgoedkeuring, weigering van 0530 als bron, het
  interim-dividend met saldocontrole op 0520/1580/1560, de vrijstelling voor de holding, de
  afdrachttermijn, los tegenboeken dat stuit, terugdraaien dat 0520 herstelt, en de hele weg via
  `close_fiscal_year` → `appropriate_result` → `declare_dividend` inclusief de guard die de bestemming
  vasthoudt zolang de uitkering staat.
