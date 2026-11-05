# Financiën: werking en beveiliging voor eenmanszaak, vof en BV

**5 november 2026 · database, edge functions, Gerrie/API/MCP en schermen · staging**

Doel: alle financiële functies nalopen op werking en veiligheid, voor de
eenmanszaak, de vof en de BV. Wat niet klopte, is meteen opgelost.

> **Status:** twee migraties (`20261105000000_finance_werking_veiligheid` en
> `20261105010000_finance_hulpfuncties_anon`), aanpassingen in tien edge
> functions, in de handelingen voor Gerrie, API en MCP, en in vijf schermen.
> Alles is eerst droog nagespeeld op staging, in transacties die altijd
> worden teruggedraaid.

## Hoe er gecontroleerd is

- **Eind-tot-eindcyclus per rechtsvorm**, op staging en teruggedraaid. De
  cyclus: beginbalans, offerte, factuur, bank, deelbetaling, inkoop, activum,
  privé of vennoten, vier btw-kwartalen, rapportages, jaarafsluiting en
  heropenen. Bij de BV komen daar DGA-rente, Vpb, resultaatbestemming,
  dividend, groottecategorie en de jaarrekening bij.
- **Rol- en tenantmatrix.** Zes rollen tegenover 66 financiële tabellen en 75
  functies: eigenaar, viewer, boekhouder, lid zonder of met alleen leesrecht
  op Financiën, en buitenstaander. Daarnaast is geprobeerd met id's van een
  andere organisatie te werken.
- **plpgsql_check** over alle 455 PL/pgSQL-functies, en met waarschuwingen
  over de 178 financiële.
- **Twee reviews.** Eén van de edge functions (betalen, crediteren,
  herinneren, aanmanen, contracten, Vpb, jaarrekening, bank), één van de
  handelingen voor Gerrie, API en MCP. Elke bevinding is eerst zelf in de
  code of op staging nagegaan.

## Wat goed zat

- **Tabellen:** geen enkel lek tussen rollen of organisaties over de 66
  tabellen.
- **Functieaanroepen:** alle 298 aanroepen in de code passen op de
  functies in de database.
- **Organisatiegrenzen:** functies met een id van een andere organisatie
  geven "niet gevonden" of "geen rechten".
- **De cijfers per rechtsvorm:**
  - **Eenmanszaak:** 0500 komt op € 15.175 (begin € 10.000, winst € 5.575,
    storting € 100, opname € 500).
  - **Vof:** de winst wordt 60/40 verdeeld; Anna krijgt € 3.045, Bram
    € 2.280.
  - **BV:** de Vpb is € 1.159 over € 6.102,67. Het dividend van € 3.000
    geeft 15% dividendbelasting. Balans en proefbalans sluiten.
  - **Heropenen** zet bij alle drie alles terug.

## Bevindingen en fixes

### Database

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | De grootboekkaart werkte voor niemand: "column reference entry_id is ambiguous", in de app en in Gerrie/API/MCP. | Hersteld. Een rekening van een andere organisatie geeft "niet gevonden". |
| 2 | hoog | Directe uitvoering via API, MCP en Gerrie schreef als service-role, langs RLS en de bewakers heen. Een koppeling met gewone uitvoerrechten kon zonder menselijke goedkeuring de code of soort wijzigen van een rekening waarop al geboekt is; afgesloten jaren en btw-rubrieken veranderen dan mee. | `action_member_write`: voor de tabellen van Financiën wisselt de schrijfactie naar het teamlid, zoals de REST-koppeling al deed. RLS, de modulepoort en elke bewaker doen mee. |
| 3 | midden | 27 boekingsfuncties controleerden de rol, maar niet het schrijfrecht op Financiën. De module-trigger hield de schrijfactie tegen, maar de functie liep tot dat punt door. | Elke functie weigert nu zelf, vóór validatie. Dat geldt ook voor `close_vat_period`. |
| 4 | midden | Een betaallink vroeg na een deelbetaling nog het hele factuurbedrag, en een open link werd hergebruikt, ook als die om een ander bedrag vroeg. | Begrensd op wat openstaat; een oude link met een ander bedrag vervalt. Betaalt de klant toch de oude link, dan wordt die betaling gewoon geboekt. |
| 5 | midden | Een dubbelklik, een tweede tabblad of een herhaalde webhook kon twee genummerde creditnota's opleveren. | De factuur gaat op slot, er komt één creditnota per terugbetaling, en samen nooit meer dan het factuurbedrag. |
| 6 | midden | Een contract kon worden getekend op een andere tekst dan was verstuurd, ook na de uiterste datum. Het ingetypte e-mailadres verving het uitgenodigde en gold dan als geverifieerd. | De pagina toont de bevroren versie, en het tekenverzoek stuurt het id daarvan mee. Na "geldig tot" kan er niet meer getekend worden. Het uitgenodigde adres blijft staan; het ingetypte adres staat in het bewijs. |
| 7 | laag | Een late "betaald" van Mollie zette een geannuleerde of afgeboekte factuur terug op betaald. | De status blijft staan. De betaling zelf wordt geboekt, met een melding in de tijdlijn. |
| 8 | laag | Elke herinnering of aanmaning overschreef het enige token op de factuur, waardoor de link in de vorige niet meer werkte. | Elke verzending krijgt een eigen publieke link. |
| 9 | laag | Een terugbetaalde factuur kon opnieuw worden verstuurd, met betaallink. | Geweigerd. |
| 10 | laag | Negen verwijzingen in zes tabellen werden niet op dezelfde organisatie gecontroleerd: bankrekening → grootboek, bankregel → grootboek, leverancier en klant, Vpb-correctie → boekjaar, inkoopfactuur → leverancier en project, leverancier → kostenrekening, en contract → sjabloon. | Gecontroleerd. De bestaande gegevens zijn nagelopen: er waren geen overtredingen. |
| 11 | laag | Vpb-correcties konden nog wijzigen nadat de berekening was vastgesteld en geboekt. | Eerst de berekening terugdraaien. |
| 12 | laag | Aandeelhouders, aandelenmutaties, DGA-rente en Vpb-correcties konden ook bij een eenmanszaak of vof worden aangemaakt. De Vpb-invoer rekende daar ook. | Bij aanmaken geweigerd. Rijen van toen de organisatie een BV was, blijven bewerkbaar. |
| 13 | laag | Een bankregel zonder voorwaarde matcht op élke transactie. Bij aanmaken eiste de handeling een voorwaarde, maar het scherm en bijwerken niet. En % of _ in "bevat" werkte als jokerteken. | Database en scherm eisen een voorwaarde (NOT VALID: bestaande regels blokkeren niets). De tekst wordt letterlijk vergeleken. |
| 14 | laag | Een eigen rekening met een code die ResoFly later als systeemrekening aanmaakt (bijv. 9900 of 1540 bij de overstap naar een BV) verdrong die stil. De Vpb kwam dan op "Diversen" en telde mee in het commerciële resultaat (zo nagespeeld). | Die codes zijn gereserveerd. De Vpb-boeking controleert vooraf dat 9900 en 1540 echt de Vpb-rekeningen zijn. |

### Edge functions

- **Herinneringsmail:** toont het openstaande bedrag, en na een deelbetaling
  ook het factuurbedrag.
- **Betaallinks** in de app, de herinnering, de aanmaning en het
  klantportaal vragen het openstaande bedrag. Het portaal gebruikt, net als
  de app, een Mollie-idempotentiesleutel per betaling.
- **"Ververs bij Mollie"** door een lezer legt niets meer vast. Alleen een
  schrijver of de cron boekt aflevering en betaling.
- **Foutmeldingen** naar de browser bevatten geen databasetekst meer (tabel-,
  kolom- en constraintnamen). Dat geldt voor invoice-workflow, corporate-tax,
  annual-accounts en bank-sync. Eigen meldingen gaan ongewijzigd door.
- **Creditnota handmatig opnieuw mailen** gaat echt de deur uit. Resend
  ontdubbelde 24 uur op dezelfde sleutel, terwijl het logboek "verstuurd"
  zei.
- **Jaarrekening:** na vaststellen of deponeren kan het gearchiveerde
  exemplaar niet meer worden vervangen. De knop verdwijnt ook.
- **Publieke pagina's** tonen van een project alleen de naam. Een
  factuurweergave wordt hooguit één keer per tien minuten gelogd.

### Gerrie, API en MCP

| Wat | Nu |
|---|---|
| Een ander IBAN van een leverancier, of op de eigen facturen | Gaat altijd langs een mens, ook met `execute_high`. De kaart toont oud → nieuw. |
| Bankregel die automatisch boekt: aanzetten, weer actief maken, andere voorwaarden, rekening of btw-code | Hoog risico, en een regel zonder voorwaarde wordt geweigerd. |
| Banksync met regels die automatisch boeken, de grootboekkoppeling van een bankrekening, de standaardrekening van een leverancier | Hoog risico. Een bankrekening kan alleen aan een bank- of kasrekening hangen. |
| Terugdraaien van bestemming, dividend, DGA-rente, Vpb en jaarrekening, en `business.set_legal_form` | Alleen eigenaar of beheerder, zoals de database al eiste. |
| Verouderde kaart: factuurstatus of aandeelhouder | Een factuur die intussen betaald is, gaat niet terug. Bij een aandeelhouder worden alleen de gewijzigde velden geschreven. |
| "Betaald" voor een geboekte factuur waarop nog iets openstaat | Verwijst naar de bankkoppeling of een memoriaalpost. Alleen de status zetten liet 1300 openstaan. |
| Inbox "klaarzetten" (ook "toch klaarzetten" bij een dubbele) | Boekt nooit automatisch. Dat kon tot dubbele kosten en voorbelasting leiden. |
| Nieuwe aanmaning na een geannuleerde | Kan weer. De historie toont alle aanmaningen. |
| BV-handelingen bij een eenmanszaak of vof | Geweigerd vóór er een kaart komt. |
| Afsluitkaart van een vof | Noemt de vennoten, en weigert vooraf als de verdeling niet op 100% uitkomt. |
| Vpb vaststellen of terugdraaien in een afgesloten jaar, boeken vóór de startdatum | Vooraf geweigerd. "Alles boeken" telt alleen wat de database boekt. |
| Teksten over afgesloten perioden | Kloppen weer: inkoop en afschrijving gaan naar de eerste open datum, en een btw-slot houdt alleen btw-boekingen tegen. De kaart toont de echte boekdatum. |
| Invoer | `num()` maakt van leeg of een vlag geen 0 meer. `bool()` leest "false" als nee. `required` wordt afgedwongen. |

## Beveiliging

- **`action_member_write`** is alleen voor `service_role`. Het teamlid moet
  een actief lid zijn, en alleen acht tabellen van Financiën gaan via deze
  weg.
- **Rechten:** elke functie in de migratie staat expliciet dicht voor
  `anon`. Twee nieuwe SQL-hulpfuncties kregen wel de standaardrechten van
  Supabase; de rooktest viel daarover (zie hieronder), en
  `20261105010000` zet ze dicht.
- **Trigger-functies** zijn ingetrokken voor public, anon en authenticated.

## Verificatie

**Droog op staging**, in transacties die altijd worden teruggedraaid:

- **Migratietest:** elke nieuwe regel is apart gecontroleerd:
  - de betaallink na deelbetalingen: € 710, € 710 (dezelfde link), € 500
    (de oude vervalt);
  - een tweede creditnota boven het factuurbedrag wordt geweigerd;
  - een late betaling laat een geannuleerde factuur staan;
  - een herinnering krijgt een eigen link;
  - bij het contract: de verkeerde versie en een verlopen contract worden
    geweigerd, het uitgenodigde adres blijft staan;
  - de Vpb-correctie zit op slot en mag weer na terugdraaien;
  - via `action_member_write` wordt geweigerd: de code van een geboekte
    rekening, een lezer, een niet-lid, een verouderde kaart, een andere
    tabel en een gereserveerde code;
  - de IB-weigeringen, en de organisatiecontrole bij bankregel,
    leverancier, Vpb-correctie, bankrekening en inkoopfactuur.
- **Matrix:** geen enkele schrijffunctie laat nog een lid met Financiën op
  "lezen" of "geen" door, en geen tabel lekt.
- **Eind-tot-eindcyclus:** dezelfde cijfers als zonder de migratie, voor
  alle drie de rechtsvormen. De grootboekkaart werkt nu.
- **Alle eerdere scenario's** (financiën, btw, verkoop, bewakers, BV, Vpb,
  IB) zijn gelijk. De registertest (`t_m4`) draait nu als BV, omdat
  aandeelhouders bij een eenmanszaak bewust worden geweigerd.

**Lokaal, op de samengevoegde stand van staging:**

- typecheck ✓;
- `npm test` 963/963, waarvan 14 nieuw (`financeChecks.test.ts`);
- build en CSP ✓;
- `npm run test:loading` ✓;
- mobiele lay-outtest op de financiële en publieke pagina's: 60 metingen,
  0 problemen;
- `deno check`: de lijst uit CI is schoon. Bij de vier functies buiten die
  lijst zijn de foutmeldingen dezelfde als vóór de wijziging.

**Uitrol:**

- **Deploy Supabase run 171:** de migratie is toegepast en alle edge
  functions zijn uitgerold. De rooktest viel op twee hulpfuncties die
  `anon` mocht aanroepen.
- **Run 172:** `20261105010000` is toegepast en de rooktest is helemaal
  groen.
- **Frontend checks run 121:** helemaal groen. Dat zijn de keten vanaf
  nul, `deno check`, de typecheck, CSP, de unit tests, de volledige mobiele
  lay-outtest (donker en licht) en het laden per module.

**Nacontrole tegen de live code** (teruggedraaid):

- De migratietest, de eind-tot-eindcyclus per rechtsvorm en de matrix
  geven dezelfde uitkomst als de droogruns. De matrix heeft 821 rijen,
  zonder verschil.
- `anon` heeft in public niets open.
- De bankregel-matcher werkt met de letterlijke voorwaarde: "ZZ_9" matcht,
  "ZZx9" niet.
- Een gereserveerde code geeft de uitleg, niet "permission denied".
- Alle 291 `.rpc()`-aanroepen met vaste argumentnamen passen op de live
  functies, en elke functie bestaat één keer.
- Er is niets van de tests blijven staan.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Directe uitvoering buiten Financiën (klanten, projecten, tickets, uren) schrijft nog als service-role | Dit liep buiten deze controle. `action_member_write` is zo gebouwd dat er tabellen bij kunnen. |
| Een eigen rekening die een systeemcode al bezet (van vóór vandaag) | De Vpb-boeking weigert dan met uitleg. Automatisch overnemen kan pas als er niet op geboekt is, en vraagt een keuze per geval. |
| Na versturen gewijzigde contracttekst | De klant tekent de verstuurde versie. Een wijziging zonder opnieuw versturen komt niet in het getekende stuk. Opnieuw versturen maakt een nieuwe versie. |
| Betaallink bij een aanmaning | Vraagt de hoofdsom die openstaat, zonder rente en incassokosten (vroeger: het factuurbedrag). |
| Verliesadministratie (`corporate_tax_losses`) blijft bewerkbaar | Dat is bedoeld voor wat de Belastingdienst vaststelt. Op slot zetten raakt dat. |
| Mock-betalingen en `MAIL_INBOUND_REQUIRE_SIGNATURE` | Stonden al op de actielijst van 1 november. |
