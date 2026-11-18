# De administratie van een vof: van begin tot eind nagelopen

**17 en 18 november 2026 · database, schermen, Gerrie/API/MCP en CI · staging**

Doel: zeker weten dat de administratie van een vof (en van een maatschap, cv of
eenmanszaak) bruikbaar is. Alles wat niet klopte of ontbrak, is meteen opgelost.
Dit bouwt voort op `CHANGELOG_EENMANSZAAK_VOF_CONTROLE_2026-11-04.md`. Het
liep tegelijk met de controle van de eenmanszaak
(`CHANGELOG_EENMANSZAAK_CONTROLE_2026-11-18.md`); hoe die twee zijn
samengevoegd, staat onder "Samen met de controle van de eenmanszaak".

> **Status:**
> - **Database:** één migratie, `20261118110000_vof_vennoten_en_prive`.
> - **Tests:** twee databasetests die in CI meedraaien (`tests/database/`).
> - **Schermen:** Vennoten, Inkoopfacturen, Bank, Grootboek → Beginbalans,
>   Boekjaren, Instellingen → Boekhouding, Uren en de inrichting.
> - **Gerrie, API en MCP:** twee nieuwe handelingen, en zeven aangepaste.

## Hoe er gecontroleerd is

- **Een heel boekjaar van een vof als test.**
  `tests/database/vof_administratie.sql` boekt een jaar met twee vennoten
  (60/40). Hij gebruikt dezelfde databasefuncties als de schermen, met echte
  rollen en RLS, en controleert 61 bedragen en weigeringen:
  - inrichten, vennoten, boekjaren, bank en een beginbalans met kapitaal per
    vennoot;
  - verkoop: twee facturen, betaald via de bank;
  - inkoop: een factuur via de bank, en een die een vennoot privé betaalde;
  - privé via de bank, en een laptop die een vennoot inbracht, met
    afschrijving;
  - vier btw-kwartalen en de betaling ervan;
  - saldibalans, winst-en-verliesrekening en balans;
  - de jaarafsluiting, de kapitaalvergelijking en het beginvermogen van het
    volgende jaar.
- **De verdeling apart.** `tests/database/vennoten_jaarafsluiting.sql` doet
  69 controles. Zie "Wat de databasetests nagaan".
- **Schermen en handelingen nagelopen.** Gezocht is naar elke plek waar een
  vof als BV of als eenmanszaak werd behandeld, of vastliep.

## Bevindingen en fixes

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | **Btw op privé.** Bij de bank hield een regel zijn btw-code als je van een kostenrekening naar een privérekening wisselde. Een privé-opname van € 1.500 werd zo € 1.239,67 opname en € 260,33 voorbelasting. Dat kon ook met een bankregel die automatisch boekt, en via Gerrie. De controle van de eenmanszaak vond het ook (punt 4 daar): die loste het op in het scherm en bij het boeken van de bank. | Daarbovenop: de bankregel (scherm en database) en de bankverdeling zelf weigeren btw op privé of kapitaal, en Gerrie weigert het al op de kaart. Het btw-veld staat uit bij een privé- of kapitaalrekening. Bestaande bankregels met btw op privé of kapitaal zijn hun btw-code kwijt. |
| 2 | hoog | **Privé betaald.** Een inkoopfactuur die een vennoot met zijn eigen pas betaalde, kon nergens als betaald worden vastgelegd. De factuur bleef open staan, ook bij Openstaand → Crediteuren en als kandidaat bij elke bankbetaling. 1600 Crediteuren bleef ook staan, en de uitgave stond niet op het privé van de vennoot. | Bij een geboekte inkoopfactuur staat de knop **Privé betaald**: je kiest de vennoot en de datum. Wat openstaat gaat naar zijn privé-stortingen (056n), of naar 0560 bij een eenmanszaak. De factuur staat daarna op betaald en de btw blijft aftrekbaar. Tegenboeken in het journaal zet hem weer open. Een inkoopfactuur met een privébetaling erop boek je pas tegen nadat die betaling is tegengeboekt. Ook via Gerrie (`purchase_invoice.pay_privately`). |
| 3 | hoog | **Gebroken boekjaar.** Een vof kon een boekjaar "2026/2027" krijgen, dat niet op de aangifte van de vennoten past. Dat kon bij Instellingen → Boekhouding, bij een nieuw boekjaar en via Gerrie en de API. | Bij een eenmanszaak, vof, maatschap of cv valt een boekjaar in één kalenderjaar. De database weigert anders, en de startmaand blijft januari: bestaande instellingen zijn rechtgezet. Een eerste of laatste boekjaar dat niet op 1 januari begint of op 31 december eindigt, blijft kunnen. Het scherm toont de keuze dan niet en Gerrie weigert vooraf. |
| 4 | hoog | **Privé van vennoten bleef open.** Na de overstap naar een eenmanszaak, of als geen vennoot meer actief was, nam de jaarafsluiting het privé van de vennoten (055n, 056n) niet mee. Het schoof ongemerkt naar het volgende jaar. | Het privé van elke vennoot gaat bij elke jaarafsluiting naar zijn eigen kapitaal. De kapitaalvergelijking telt het als opname of storting. |
| 5 | hoog | **Urencriterium per gebruiker.** Het urencriterium geldt per vennoot, maar ResoFly telde per gebruiker en nergens stonden de uren van de vennoten bij elkaar. | Een vennoot hangt aan zijn teamlid. Bij Vennoten staan per vennoot de uren van het kalenderjaar, met "gehaald", "op koers" of "onder koers, nog …". Dat ziet alleen wie Financiën én Uren mag lezen. |
| 6 | midden | **Geen test op de verdeling.** De verdeling over de vennoten had geen test in de repo, terwijl `close_fiscal_year` bij elke wijziging helemaal opnieuw wordt geschreven. | Twee databasetests, in CI na de keten vanaf nul en lokaal met `npm run test:database`. Ze falen op de jaarafsluiting van 5 november en op een versie zonder vennotendeel. |
| 7 | midden | **Gerrie kon geen vennoten vastleggen.** Gerrie, de API en MCP konden alleen lezen, terwijl de afsluitkaart verwees naar "pas de verdeling aan". | Nieuwe handeling `owners.save_partner`: vastleggen, aanpassen, uittreden en het teamlid koppelen. De kaart toont de verdeling van de actieve vennoten daarna. |
| 8 | midden | **0550 en 0560 naast de vennoten.** Ze stonden in elke keuzelijst naast de privérekeningen van de vennoten, met dezelfde naam. Wie daar boekte, boekte op geen enkele vennoot. | Zodra er een vennoot is, heten ze "Privé-opnamen (geen vennoot)" en "Privé-stortingen (geen vennoot)". |
| 9 | midden | **Beginbalans zonder vennoten.** De sluitpost van de beginbalans kwam bij een vof helemaal op 0500. Die stond daarna op geen enkele vennoot. | De beginbalans legt uit dat elke vennoot zijn kapitaal op zijn eigen kapitaalrekening krijgt, met de knop **Regel per vennoot**. Blijft er een sluitpost over, dan zeggen het scherm, de bevestiging en de kaart van Gerrie dat die op geen enkele vennoot staat. |
| 10 | midden | **Inrichten vroeg niet naar vennoten.** Een vof zonder vennoten verdeelt bij het afsluiten niets. | Na de inrichting van een vof, maatschap of cv staat **Vennoten vastleggen** vooraan bij de vervolgstappen. De afsluitdialoog bij Boekjaren waarschuwt als er geen actieve vennoot is. |
| 11 | midden | **Auditfile inlezen.** "Kapitaal vennoot B. de Vries" uit een ander pakket werd voorgesteld als 0500, en zijn privé als 0550. | De vennoot wordt herkend aan zijn naam: kapitaal naar 050n, privé naar 055n of 056n. Passen twee vennoten even goed (dezelfde achternaam), dan komt er geen voorstel. |
| 12 | laag | **Betaalstatus van inkoopfacturen.** Een inkoopfactuur stond als "Geboekt", ook als hij allang betaald was. | De lijst toont "Betaald", "Deels betaald" of "Geboekt · open". |
| 13 | laag | **Teksten.** Bij een vof zonder vennoten stond dat de winst naar 0500 gaat; een vof krijgt 0510. De kop en de afsluitdialoog van Boekjaren noemden altijd 0510, ook als de winst naar de vennoten gaat. Het privé naar 0500 stond er alleen bij een eenmanszaak. Bij het inrichten van een vof stond "Statutaire naam". | Elke tekst volgt de rechtsvorm en de instelling. Een vof krijgt "Bedrijfsnaam": hij heeft geen statuten. |
| 14 | laag | **Reservevinkje.** Het vinkje "Wettelijke of statutaire reserve" (dividend bij een BV) stond bij het kapitaal van elke vennoot. | Alleen nog bij een BV, NV of coöperatie. |
| 15 | laag | **€ -0,00.** Bij een vennoot zonder opnamen stond "€ -0,00". | "€ 0,00". |

## Wat de databasetests nagaan

**`vof_administratie.sql`** (61 controles), naast de stappen hierboven:

- het rekeningschema van een IB-onderneming, zonder rekeningen van een BV;
- de btw:
  - een privé-opname met btw wordt geweigerd, ook in een bankregel;
  - de btw-aangifte telt de voorbelasting van de privé betaalde factuur mee;
- de privébetaling:
  - geen vennoot gekozen, een datum in de toekomst, een datum vóór de start en
    een tweede keer betalen worden geweigerd;
  - tegenboeken zet de factuur weer open, en de factuur zelf boek je niet
    tegen zolang de betaling staat;
- Openstaand: niets meer open op de crediteuren;
- het boekjaar: een gebroken boekjaar wordt geweigerd en de startmaand blijft
  januari;
- de balans sluit vóór en na de jaarafsluiting.

**`vennoten_jaarafsluiting.sql`** (69 controles):

- winst 60/40 tot op de cent (€ 1.000,01 wordt € 600,01 en € 400,00), en
  verlies (€ 300,01 wordt € 180,01 en € 120,00);
- het privé van elke vennoot naar zijn eigen kapitaal, en algemeen privé naar
  0500;
- de 100%-controle, en heropenen en opnieuw afsluiten;
- zonder actieve vennoot en na de overstap naar een eenmanszaak;
- de uren per vennoot, alleen uit de eigen organisatie en het eigen jaar;
- wie wat mag: lezer, lid zonder Uren, boekhouder en buitenstaander.

## Database

Alles in `20261118110000`. De functies die al bestonden, zijn letterlijk
overgenomen; per wijziging staat een GEWIJZIGD- of TOEGEVOEGD-regel. Dat is met
een diff nagelopen.

| Wat | Waarom |
|---|---|
| `partnership_partners.user_id`, `set_partnership_partner_member`, `partnership_partner_hours` | Het teamlid van een vennoot, en de uren per vennoot. |
| `close_fiscal_year` | Het privé van de vennoten gaat altijd naar hun kapitaal. |
| `owners_equity_overview` | Het privé van vennoten telt als privé. |
| Boekingssoort `purchase_private_payment`, `pay_purchase_invoice_privately` | Privé betaald. |
| `purchase_invoice_open_payable_cents`, `refresh_purchase_invoice_payment_status`, `report_open_items` | Een privébetaling telt als betaling. |
| Trigger `journal_entries_private_payment_reverse` | Tegenboeken: de status bijwerken, en de inkoopfactuur beschermen. |
| `open_fiscal_year`, trigger `company_settings_ib_calendar_year` | Het boekjaar is het kalenderjaar. |
| Triggers `bank_transaction_allocations_no_vat_on_equity`, `bank_rules_no_vat_on_equity` | Geen btw op privé of kapitaal. |
| Trigger `partnership_partners_mark_general_private` | 0550 en 0560 heten "(geen vennoot)". |

## Samen met de controle van de eenmanszaak

Terwijl deze controle liep, kwam de controle van de eenmanszaak op staging, met
twee migraties: `20261118090000` en `20261118100000`. Die vervangen ook
`close_fiscal_year` en `owners_equity_overview`. Daarom:

- **Volgorde:** deze migratie heet `20261118110000` en komt dus daarna. Een
  oudere versie weigert `supabase db push`.
- **De twee functies:** ze zijn opnieuw opgebouwd vanaf de versie op staging,
  met alleen de wijziging van deze migratie erbovenop. Dat is met een diff
  nagelopen.
- **Het beginvermogen:** als het vorige boekjaar nog open stond, miste het
  beginvermogen de winst daarvan. Dat had de eenmanszaak al opgelost
  (`openPriorResultCents`, `openPriorYears`), en die melding staat ook bij
  Vennoten. Deze migratie voegt daar niets aan toe.
- **Btw op privé:** zie punt 1.
- **De resultaatrekening:** die volgt sinds de eenmanszaak de rechtsvorm. Na
  de overstap van een vof naar een eenmanszaak gaat het resultaat dus naar
  0500. `tests/database/vennoten_jaarafsluiting.sql` toetst dat nu.

## Gerrie, API en MCP

- **Nieuw: `owners.save_partner`.** Een vennoot vastleggen of aanpassen.
- **Nieuw: `purchase_invoice.pay_privately`.** Een inkoopfactuur als privé
  betaald vastleggen.
- **Aangepast:**
  - `owners.equity_overview` geeft het teamlid per vennoot, en de uren alleen
    als de aanroeper Uren mag lezen;
  - `fiscal_year.close` noemt het privé van (vroegere) vennoten. Bij een vof
    zonder actieve vennoot zegt hij dat er niet verdeeld wordt;
  - `fiscal_year.open` en `settings.save_bookkeeping` weigeren een gebroken
    boekjaar bij een IB-onderneming;
  - `bank_transaction.book`, `bank_rule.create` en `bank_rule.update` weigeren
    btw op privé of kapitaal;
  - `journal.opening_balance` waarschuwt als de sluitpost op geen enkele
    vennoot staat.

## Beveiliging

- **Rechten:** elke nieuwe functie staat dicht voor anon. Een schrijffunctie
  vraagt schrijfrecht op de organisatie én op Financiën.
- **De uren per vennoot:** daarvoor is leesrecht op Financiën én Uren nodig.
  Via Gerrie kijkt de handeling zelf of de aanroeper Uren mag lezen, omdat hij
  als service-role draait.
- **Een vennoot koppelen:** alleen aan een actief teamlid van dezelfde
  organisatie, niet aan de boekhouder, en één teamlid per vennoot.
- **Gegevens meenemen:** `user_id` gaat mee met de vennoten.
  `EXPORT_SCHEMA_VERSION` staat op `20261118110000`.

## Verificatie

**Lokaal, op de stand samengevoegd met staging (met de eenmanszaak):**

- **Database:**
  - `supabase db reset`: alle 282 migraties op een lege database
    (Postgres 17.11.0.018);
  - de nieuwe migratie draait ook een tweede keer;
  - `npm run test:database`: 69 en 61 controles geslaagd;
- **Code:**
  - typecheck ✓;
  - `npm test`: 1950/1950. Hiervan zijn 5 nieuw: de afsluitkaart, de uren via
    Gerrie, privé betaald en een vennoot vastleggen via Gerrie, en de vennoten
    in de auditfile-import;
  - `deno check` op de registry van de handelingen en op `reportRecords.ts` ✓.
    De volledige lijst uit CI kon hier niet, omdat esm.sh en deno.land in deze
    omgeving dicht staan;
- **Schermen:**
  - `npm run test:loading`, `npm run test:inrichten` en
    `npm run test:terugknop` (13) ✓;
  - mobiele lay-outtest, donker en licht: 716 metingen, 0 problemen, vóór én
    na het samenvoegen. Er zijn nieuwe pagina's bij: Vennoten, een vennoot
    bewerken, de beginbalans van een vof, en Inkoopfacturen van een vof met het
    venster Privé betaald.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Arbeidsvergoeding of rente over het kapitaal vóór de verdeling | Kan als memoriaal tussen de kapitaalrekeningen; de automatische verdeling is naar rato. |
| Een vennoot die halverwege het jaar in- of uittreedt | De verdeling volgt de stand bij de jaarafsluiting. |
| Een vennoot zonder eigen login | Zijn uren tellen pas mee als hij een teamlid is (een licentie). |
| Meer dan de helft van de werktijd aan de onderneming | ResoFly weet niet wat iemand verder werkt. De uitleg staat bij de teller en bij Vennoten. |
| De inkomstenbelasting zelf (ondernemersaftrek, mkb-winstvrijstelling, KIA) | Hangt af van het hele inkomen van de vennoot. ResoFly levert de bouwstenen: winstaandeel, kapitaalvergelijking en urencriterium. |
| Btw die eerder al op een privérekening is geboekt | Geboekt blijft geboekt. Corrigeer met een memoriaal of een suppletie. |
