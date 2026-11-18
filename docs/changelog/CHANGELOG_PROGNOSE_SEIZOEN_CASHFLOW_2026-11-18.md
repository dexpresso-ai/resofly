# Prognose: seizoenspatroon uit vorige jaren en een cashflowprognose (2026-11-18)

Vraag: "Bouw de volgende functionaliteit ook voor me: seizoenspatroon uit vorige
jaren, een cashflowprognose. Doe dit zorgvuldig, correct, foutloos en functioneel
werkend."

## Wat er niet kon

De prognose (`CHANGELOG_PROGNOSE_2026-11-18.md`) rekende met een gemiddelde maand.
Een rustige zomer of een drukke december zag je alleen als je die maanden zelf
invulde. En ze zei wat je verdient, niet wat er op je rekening staat. Juist dat
verschilt: een klant betaalt pas na weken, de btw gaat per kwartaal in één keer
de deur uit, een afschrijving kost geen geld en een investering wel.

## Wat er nu kan

### Seizoenspatroon

Bij de aannames staat een blok **Seizoen**: hoe druk elke maand in de vorige jaren
was tegen een gemiddelde maand, als twaalf staafjes met het percentage eronder
("jan 135%", "mei 57%"), met een streep op 100%. Met **Seizoenspatroon** (0 tot
100%) kies je hoe sterk de prognose dat patroon volgt: 0% is elke maand gelijk,
100% is zoals de vorige jaren, 50% half zo sterk.

- Het werkt op de nieuwe projecten en de overige omzet. Een maand met een eigen
  aantal projecten houdt dat aantal: wie zegt "in juli 1 project", bedoelt 1.
- Over een heel jaar verdeelt het de omzet alleen; de jaaromzet blijft gelijk.
- Er zijn minstens twee hele jaren omzet nodig. Daarvoor zegt het blok waarom het
  er nog niet is ("er zijn nu 20 maanden, vanaf maart 2025"), en rekent de prognose
  gewoon zonder seizoen.

### Cashflow

Boven de kerncijfers kies je **Resultaat** of **Cashflow**. De cashflow rekent van
vandaag tot het eind van de prognose, per maand:

- **Kerncijfers**: saldo nu, het laagste saldo (nu meegerekend), het saldo aan het
  eind, en de btw naar de Belastingdienst met de eerstvolgende betaling.
- **Een grafiek** van het saldo vanaf nu, met de ondergrens gestippeld en een rode
  stip bij elke maand die eronder (of onder nul) eindigt. In de tooltip per maand
  wat er binnenkomt, uitgaat, naar de btw gaat en erbij of eraf komt.
- **Een tabel per maand**: binnen, uit, btw, geld erbij of eraf, en het saldo. Op de
  telefoon vier kolommen, met de btw en het geld onder de maand.
- **Notities** bij wat niet bekend is of al te laat is: een rekening zonder bekend
  saldo, facturen die al te laat zijn, een aangifte die nog niet als betaald staat.
- **Aannames, blok Geld** (alleen in de cashflow), elk leeg = automatisch:
  - *Banksaldo nu*: uit je bankrekeningen in ResoFly (zie hieronder);
  - *Klanten betalen na*: hoe snel je klanten het afgelopen jaar betaalden, naar
    bedrag gewogen (vanaf vijf betaalde facturen), anders je betaaltermijn;
  - *Btw op je omzet* en *Btw op je kosten*: uit je facturen, inkoop en boekhouding
    van het afgelopen jaar; met de KOR 0%;
  - *Afschrijvingen per maand*: die staan in je kosten maar gaan niet van je
    rekening;
  - *Ondergrens saldo*: daaronder waarschuwt de cashflow (0 = alleen bij rood).
- **Extra posten "geld erbij" en "geld eraf"**: een lening, een investering (een
  bus, een computer), een privé-opname of -storting, een belastingaanslag. Die
  tellen niet in omzet, kosten of winst, alleen in de cashflow.
- **Waar dit op rust**: het saldo per rekening en waar het vandaan komt, de
  openstaande posten, het betaalgedrag en elke btw-betaling (in de schermtest: "Q4
  2026: € 6.647 in januari 2027, uitgerekend").

De balk "Nog niet bewaard" noemt naast de winst ook het laagste saldo ervoor en
erna.

## Hoe hij rekent

### Seizoen

Per maand: de omzet gedeeld door het gecentreerde gemiddelde van de twaalf maanden
eromheen; per kalendermaand het gemiddelde over de jaren; daarna zo geschaald dat
de twaalf samen precies twaalf maanden zijn.

- Groei telt zo niet als seizoen. Wie 30% per jaar groeit, heeft in december niet
  "30% meer seizoen" dan in januari. Getest: het patroon komt er dan op hooguit
  anderhalve procentpunt na uit. De simpele manier (per kalenderjaar delen door het
  gemiddelde van dat jaar) zat er acht naast.
- Eén grote opdracht trekt ook het gemiddelde van de maanden eromheen omhoog. Met
  één maand van twintig keer gewoon in twee jaar kwam die maand uit op bijna vijf
  keer gewoon, en de rest op 62%. Daarom eerst elke maand begrenzen op drie keer de
  mediaan van de maanden met omzet. Wie twee keer per jaar factureert, merkt daar
  niets van en krijgt precies dat patroon.
- Het begint bij de eerste maand met omzet en kijkt hooguit vier jaar terug; de
  pagina en Gerrie vragen daarom nu vier jaar historie op in plaats van één.

### Cashflow

- **Begin**: het banksaldo. Per actieve bankrekening het eindsaldo van het laatste
  afschrift plus de bankregels daarna. Zonder afschrift met eindsaldo: de stand in
  de boekhouding plus de bankregels die nog niet geboekt zijn, maar alleen als er een
  beginbalans op die rekening staat (anders tel je alleen de mutaties en mis je het
  begin) en de rekening zijn grootboekrekening niet met een andere bankrekening deelt
  (dan is die stand van allebei). Anders onbekend: de cashflow noemt de rekening, en
  je vult je banksaldo zelf in. De kas (grootboekrekening met subtype cash) telt mee.
- **Klanten**: openstaande facturen op hun vervaldatum (te laat: deze maand). Nieuwe
  omzet uit de prognose met btw, betaald na de betaaltermijn: bij 15 dagen komt de
  helft in de maand van de factuur en de helft een maand later.
- **Kosten**: zonder afschrijvingen, met btw, betaald in hun maand; openstaande
  inkoopfacturen op hun vervaldatum.
- **De lopende maand** telt alleen wat er nog bij komt: wat al gefactureerd of
  geboekt is, staat al bij de openstaande posten of op de bank.
- **Btw**: per tijdvak uit de bedrijfsgegevens (maand of kwartaal), betaald in de
  maand na het tijdvak. Een afgesloten of ingediende aangifte telt met haar saldo,
  een betaalde niet. Voor de rest de btw van de facturen en inkoop die er al zijn,
  plus die van de prognose. Een tijdvak waarvan de betaalmaand voorbij is, geldt als
  betaald. Ging er na afloop van het tijdvak al geld naar de Belastingdienst
  (herkend zoals op de Bankpagina: de inningsrekening of "Belastingdienst" in de
  naam), dan ook: dat zit al in het banksaldo, en twee keer aftrekken zou een tekort
  voorspellen dat er niet is. Met de KOR geen btw.
- **Geld erbij en eraf** in hun maanden.

De btw per maand komt uit je facturen, inkoopfacturen en boekhouding, het hoogste
van de twee, net als de kosten. Optellen zou geboekte facturen dubbel tellen. De
boeking van een aangifte zelf telt niet: die zet de btw alleen over naar "te
betalen".

## Gerrie, de agents, de MCP-koppeling en de API

Dezelfde vier handelingen, uitgebreid:

- `forecast.list` geeft per prognose ook het seizoenspatroon (per maand een
  percentage, en of het aanstaat) en de cashflow: saldo nu, per maand wat er
  binnenkomt en uitgaat, de btw-betalingen, het laagste saldo, het saldo aan het
  eind en de notities.
- `forecast.update` en `forecast.create` nemen `seasonality_pct`, `cash_start`,
  `collection_days`, `vat_sales_pct`, `vat_costs_pct`, `noncash_costs` en
  `cash_buffer`, en posten met `kind` `cash_in` en `cash_out`.
- De kaart noemt naast de winst ook het laagste saldo ervoor en erna, in de vorm
  "laagste saldo € … → € … (maand)". Een investering verandert de winst niet maar wel
  het saldo; zonder die zin zei de kaart dan alleen dat de winst gelijk blijft.
- Gerrie weet uit zijn instructies dat "kom ik rood te staan" of "kan ik in maart
  een bus kopen" in de cashflow staat.
- Gaat de cashpositie mis (de app of de functies rollen uit vóór de migratie), dan
  geen cashflow in plaats van geen prognose.

## Rechten en veiligheid

- `forecast_cash_position` draait als security definer en controleert zelf: lid van
  de organisatie met leesrecht op Financiën, of de service-role. Elke tabel erin
  filtert zelf op de organisatie. De handelingen geven de organisatie uit de sessie
  mee (CLAUDE.md, regel 1).
- Anon kan de functie niet aanroepen (`migrationGrants.test.ts` en de databasetest).
- De cashflow verandert niets: hij leest alleen. Een geldpost is een verwachting,
  geen boeking.

## Techniek

- Migratie `20261118171500_prognose_seizoen_cashflow.sql`: `forecast_history`
  opnieuw, met per maand `vat_out_cents`, `vat_in_cents`, `ledger_vat_out_cents`,
  `ledger_vat_in_cents` en `ledger_depreciation_cents`; en de nieuwe functie
  `forecast_cash_position(organisatie)`. Geen tabellen of kolommen: de nieuwe
  aannames staan in `forecasts.assumptions`. Veilig om opnieuw te draaien.
  Exportschema 20261118171500.
- Rekenregels in `supabase/functions/_shared/forecast.ts` (puur, voor de app en
  Gerrie): `computeSeasonality`, `seasonFactor`, `parseCashPosition`,
  `cashflowEffective`, `computeCashflow`, `summarizeCashflow`; nieuwe velden met een
  groep (resultaat, seizoen, geld) in `FORECAST_FIELDS`.
- De app laadt de cashpositie los van de prognose (`loadForecastCashPosition`):
  bestaat de functie nog niet, dan staat de prognose er gewoon.
- Pagina: `src/features/Forecast.tsx` (weergaveknop, kerncijfers, `CashChart`,
  `CashTable`, `SeasonBars`, `CashBasis`), stijlen in `src/styles/prognose.css`.

## Getest

De volledige controle loopt nog; de uitslag komt hier.

## Niet in deze stap

- **Inkomsten- en vennootschapsbelasting in de cashflow**: die zet je nu als geld eraf.
  ResoFly heeft sinds vandaag een raming van de inkomstenbelasting; die zou de
  cashflow later kunnen gebruiken.
- **Een eigen seizoenspatroon met de hand**: het patroon komt uit je omzet; per maand
  een eigen aantal projecten kan wel.
- **Hoe snel jij betaalt**: de kosten gaan in hun eigen maand van je rekening, de
  openstaande inkoopfacturen op hun vervaldatum.
- **Rechtstreeks uitvoeren door een gekoppelde AI** blijft, net als bij de prognose
  zelf, via de goedkeurwachtrij.
