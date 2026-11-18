# Prognose: vooruit kijken naar projecten, omzet, kosten en winst (2026-11-18)

Vraag: "Maak een extra submenu om een forecast te maken. Zorg ervoor dat AI
inzetbaar is om dit naar wens aan te passen. De forecast gaat uiteraard over
aantal projecten, verkoop, winst, etc."

## Wat er niet kon

ResoFly keek alleen terug: Winst & verlies, de rapportages. Een verwachting voor
de komende maanden maakte je in een eigen spreadsheet, met cijfers die je zelf
overtikte en die een maand later al achterliepen. Gerrie kon er niets mee.

## Wat er nu kan

### Financiën → Prognose

Een nieuwe pagina onder Financiën, in de groep Rapportage naast Winst & verlies. In
elke look: de rail met het paneel (Baken, Zenit, Stroom), de zijbalk (Cockpit) en de
losse app Financiën. Tabblad en kruimelpad heten "Prognose".

- **Kerncijfers** over de periode van de prognose: nieuwe projecten, omzet, kosten
  en winst (met de marge). Elk staat naast de vorige twaalf maanden, met het
  verschil in procenten.
- **Een grafiek** met omzet en kosten per maand. Doorgetrokken is wat er werkelijk
  was, gestippeld is de prognose, en "nu" staat ertussen. Met de muis, een tik of
  de pijltjestoetsen zie je per maand omzet, kosten, winst en nieuwe projecten.
- **Een tabel per maand**: projecten, omzet, kosten, winst en de winst tot en met
  die maand. Bij een maand die al voorbij is staat eronder wat er werkelijk
  gebeurde, en bij deze maand wat er tot nu toe is.
- **Aannames** die meteen doorrekenen. Je ziet het effect al voordat je bewaart;
  een balk noemt wat je wijzigde en wat het met de verwachte winst doet (de winst
  van de bewaarde versie → die van je wijziging). Bewaren legt het vast, Ongedaan
  maken zet het terug.
  - het begin: deze maand (schuift elke maand mee) of een vaste maand;
  - het aantal maanden vooruit (1 tot 36);
  - nieuwe projecten per maand en de omzet per project;
  - over hoeveel maanden de omzet van een project binnenkomt;
  - overige omzet per maand (abonnementen, losse verkoop);
  - groei per jaar, op projecten en overige omzet;
  - vaste kosten per maand en hoeveel die per jaar stijgen;
  - kosten die meegroeien met de omzet (inkoop, uitbesteed werk), als percentage.
- **Extra posten**: een nieuwe medewerker, een investering, een grote opdracht.
  Per maand, van en tot een maand die je kiest, als omzet of als kosten.
- **Maanden met een eigen aantal projecten**: de vakantie, een rustige zomer.
- **Scenario's**: meer prognoses naast elkaar ("Basis", "Voorzichtig"). Een nieuwe
  begint automatisch of als kopie van wat er op je scherm staat.
- **Geschiedenis**: elke bewaarde stand, met wie het deed en wat er veranderde. Een
  oude stand zet je terug; dat wordt een nieuwe versie, zodat ook de weggezette
  bewaard blijft.
- **Waar dit op rust**: waar "automatisch" vandaan komt, met de bedragen, en de
  offertes die openstaan of geaccepteerd zijn maar nog niet gefactureerd. Een
  knop zet die geaccepteerde offertes als extra post erbij.

### Leeg is automatisch

Een aanname die je leeg laat, komt uit je eigen cijfers en schuift elke maand mee:
het gemiddelde van de twaalf hele maanden vóór deze maand. Is je bedrijf jonger,
dan telt het vanaf de eerste maand waarin iets gebeurde; wie in juni begon, deelt
niet door twaalf. Zonder enige wijziging rekent de prognose dus precies het
gemiddelde van het afgelopen jaar door.

### Pas aan met Gerrie

Op de pagina staat een vraagveld met een paar voorbeelden ("Reken met 10% groei
per jaar", "Een extra medewerker van € 3.500 per maand vanaf volgend kwartaal",
"Maak een voorzichtig scenario met 20% minder projecten"). Je vraag opent de chat.
Gerrie leest de prognose, zet de wijziging klaar en toont op de kaart elke
wijziging en de verwachte winst ervoor en erna. Er verandert pas iets als je op
Uitvoeren klikt (CLAUDE.md, regel 2). Daarna laadt de pagina opnieuw, met de
nieuwe versie in de geschiedenis: "AI-voorstel: Groei per jaar: 5% → 10%; …".

Zo ziet een kaart eruit (uit de stromentest hieronder):

> **Prognose aanpassen: Basis**
> Groei per jaar: 5% → 10% · Post erbij: Nieuwe medewerker: kosten € 3.000 per
> maand, vanaf december 2026 · verwachte winst € 20.181 → € -12.247 over 12 maanden

Ben je op de pagina zelf iets aan het wijzigen, dan zegt het vraagveld dat Gerrie
met de bewaarde versie werkt. Keur je intussen een voorstel goed, dan blijft je
eigen werk staan en zegt een balk dat er een nieuwere versie is.

## Hoe hij rekent

Per maand, in hele centen; op het scherm en op de kaart in hele euro's.

- **Nieuwe projecten**: het aantal per maand, met de groei geleidelijk erbij (10%
  per jaar is per maand de twaalfde machtswortel van 1,10), tenzij een maand een
  eigen aantal heeft.
- **Omzet uit projecten**: elk project levert zijn omzet verdeeld over de gekozen
  maanden vanaf de start. Voor de maanden vóór de prognose telt dezelfde
  verwachting door; anders begon elke prognose met een dip.
- **Overige omzet** groeit mee; extra posten tellen in hun eigen maanden.
- **Kosten**: vast (met de stijging per jaar), meegroeiend als deel van de omzet,
  en de extra posten.
- **Winst** is omzet min kosten, per maand en opgeteld.

Waar "automatisch" op rust (de functie `forecast_history` in de database):

- **Projecten**: nieuwe projecten op hun startdatum, of de dag van aanmaken als die
  leeg is.
- **Omzet**: gefactureerd, exclusief btw, op factuurdatum, met en zonder project.
  Verstuurd, te laat, betaald of afgeschreven telt. Een concept, een geannuleerde,
  vervallen of terugbetaalde factuur telt niet. Een creditnota bij een factuur die
  nog meetelt, gaat eraf in de maand van de creditnota.
- **Kosten**: per maand het hoogste van wat er in de boekhouding als kosten geboekt
  is (de regel van Winst & verlies, zonder de afsluiting van een boekjaar) en de
  geboekte of betaalde inkoopfacturen. Zijn de inkoopfacturen geboekt, dan zitten
  ze in de boekhouding, met de lonen en afschrijvingen erbij. Boek je niet in
  ResoFly, dan zijn de inkoopfacturen het beste wat er is. Optellen zou geboekte
  inkoopfacturen dubbel tellen.
- **Omzet per project** is de omzet met project gedeeld door het aantal nieuwe
  projecten. Omzet zonder project is overige omzet. Startte er in het jaar geen
  project, dan telt alle omzet als overige omzet.
- **Offertes** tellen niet vanzelf mee: die zitten al in het gemiddelde. Ze staan
  ernaast (verstuurd en nog geldig, geaccepteerd zonder factuur, en hoeveel van de
  besliste offertes van het afgelopen jaar een opdracht werden). Wie meer verwacht
  dan gewoonlijk, zet ze als extra post erbij.

De app en Gerrie rekenen met hetzelfde bestand
(`supabase/functions/_shared/forecast.ts`) en dezelfde databasefunctie. De winst op
de kaart die je goedkeurt, is daarmee de winst die de pagina daarna toont; de
stromentest controleert dat.

## Gerrie, de agents, de MCP-koppeling en de API

Vier handelingen in de registry (module Financiën), dus voor Gerrie, de agents, een
gekoppelde AI (MCP) en de openbare API tegelijk:

| Id | Wat |
| --- | --- |
| `forecast.list` | de prognoses met aannames, uitkomst per maand, wat automatisch is, het leerjaar, de vorige twaalf maanden, de offertes en de laatste versies |
| `forecast.create` | een nieuw scenario, automatisch of als kopie, met meteen de aanpassingen |
| `forecast.update` | aanpassen: elk veld, per maand een eigen aantal, posten erbij, aanpassen of weg, of een oude versie terugzetten |
| `forecast.delete` | verwijderen, met de hele geschiedenis (`risk: 'high'`: "Definitief uitvoeren") |

- De kaart noemt elke wijziging in gewone woorden en de verwachte winst ervoor en
  erna. Geef je alleen wat verandert; `null` bij een automatisch veld zet het terug
  op automatisch.
- Onzin wordt geweigerd met een reden die het model begrijpt ("Groei per jaar moet
  tussen -90% en 300% liggen", "Er is geen post met id post-9: kijk eerst met
  forecast.list"). Een wijziging die niets wijzigt ook.
- Het voorstel hoort bij één versie van de prognose. Is hij intussen gewijzigd, dan
  weigert de uitvoerder in plaats van die wijziging te overschrijven.
- Gerrie kent de prognose ook uit zijn instructies: "wat als…", "reken met…" of "pas
  de forecast aan" leidt naar `forecast.list` en `forecast.update`.
- Agents met deze handelingen tonen op de werkbank het trend-icoon.

## Rechten en veiligheid

- **Module Financiën**: de pagina toont omzet, kosten en winst. Lezen met leesrecht
  op Financiën, ook de boekhouder; wijzigen met schrijfrecht. In de database met de
  modulepoort (`apply_module_gate`) op beide tabellen, net als de andere tabellen
  van Financiën.
- **Projecten apart**: wie Projecten niet mag lezen, krijgt geen aantallen. Een nul
  zou zeggen dat er geen projecten waren; daarom is het `null`, en telt alle omzet
  als overige omzet. De pagina zegt dat ook.
- **De geschiedenis schrijft alleen de database**: de trigger `forecasts_snapshot`
  maakt bij elke wijziging een versie, welke weg die wijziging ook nam. Er is geen
  schrijfpolicy en geen tabelrecht op `forecast_versions`; de laatste vijftig per
  prognose blijven bewaard. Het versienummer en de aanmaker komen nooit uit de app.
- **`forecast_history`** draait als security definer en controleert zelf: lid van de
  organisatie en leesrecht op Financiën, of de service-role. De handelingen geven de
  organisatie uit de sessie mee (`actionTenancy.test.ts`) en laten de aantallen
  projecten weg voor wie Projecten niet mag lezen.
- **Een naam komt per organisatie één keer voor**, zodat "pas de prognose Basis aan"
  naar één prognose wijst.
- Anon heeft op de tabellen en de functie geen rechten; elke nieuwe functie is voor
  anon dichtgezet (`migrationGrants.test.ts`).

## Techniek

- Migratie `20261118113000_prognose.sql`: `forecasts`, `forecast_versions`, de
  triggers `forecasts_guard` (naam netjes, versie tellen, wie het deed) en
  `forecasts_snapshot`, RLS met de modulepoort, en `forecast_history(org, van, tot)`.
  Veilig om opnieuw te draaien. Eerst geschreven als `20261117120000`; op 18
  november kreeg staging `20261118090000` en `20261118100000`, en een oudere versie
  dan de laatste op staging weigert `supabase db push`. Hij stond nog niet op
  staging, dus is hij hernummerd.
- Rekenregels: `supabase/functions/_shared/forecast.ts`, puur (geen imports, geen
  Deno, geen DOM, geen Intl), zodat Deno, de browserbundel en `npm test` het alle
  drie laden. `src/lib/forecast.ts` zet het door; `forecast.test.ts` bewaakt dat het
  puur blijft. Bewust één bestand en geen twee kopieën (zoals `galleryLayout.ts`):
  de kaart van Gerrie en de pagina moeten op de cent hetzelfde uitrekenen.
- App: `src/features/Forecast.tsx` (pagina, grafiek, tabel, aannames, vensters),
  `src/styles/prognose.css` (eigen klassen `fc-*`), de repository-functies
  (`selectForecasts`, `loadForecastHistory`, `createForecast`, `updateForecast` met
  de versie als controle, `deleteForecast`, `selectForecastVersions`), en de
  navigatie: `Sidebar.tsx`, `ZenitNav.tsx`, `BottomNav.tsx`, `TabBar.tsx`,
  `standaloneApps.ts`, `workspaceTabs.ts`, `breadcrumbs.ts`, `permissions.ts`.
- De pagina laadt zijn eigen cijfers (geen groep uit `dataGroups.ts`) en laadt
  opnieuw na elke ververs van de werkruimte, dus ook na een goedgekeurd voorstel.
  Rolt de app uit vóór de migratie draait, dan zegt de pagina dat rustig in plaats
  van een databasefout te tonen.
- Registry: `supabase/functions/_shared/actions/forecast.ts`, de uitvoerders in
  `src/lib/actions/forecast.ts`, zoekvragen in `actionSearch.test.ts`, en een regel
  in de instructies van Gerrie (`gerrieCore.ts`).
- Export (Instellingen → Gegevens): beide tabellen gaan mee, de prognoses ook als
  leesbare lijst `lijsten/prognoses.csv`; schemaversie 20261118113000.
- De grafiekkleuren zijn nagerekend op kleurenblindheid, lichtheid en contrast
  (licht #A36F00 en #1A5FBA, de huisstijl; donker #C08A20 en #3E8FE0, omdat het
  lichtere goud van `--viz-1` daar buiten de lichtheidsband viel). Omzet en kosten
  verschillen ook in vorm niet alleen in kleur: de legenda en de tooltip noemen ze
  bij naam, en de tabel heeft alle cijfers.

## Getest

Alles hieronder is gedraaid op de stand ná het samenvoegen met staging (met de
eenmanszaak en de instellingen in groepen erin), zoals hij uitrolt:

- `npm run typecheck`: schoon.
- `npm test`: 1961 geslaagd, 0 mislukt. Daarin de rekenregels
  (`forecast.test.ts`, ook de bewaking dat het bestand puur blijft), de
  zoekvragen in `actionSearch.test.ts`, en de bestaande wachters
  `actionTenancy.test.ts`, `migrationGrants.test.ts`, `exportManifest.test.ts`
  (de schemaversie volgt de nieuwste migratie) en `dataGroups.test.ts`.
- `deno check` van de 35 edge functions uit `frontend-checks.yml`, de twee
  bestanden van de documentopmaak en de twee nieuwe gedeelde bestanden: schoon.
  Lokaal met een import map naar `npm:`, omdat esm.sh hier niet bereikbaar is.
- De migratieketen vanaf nul (`supabase db reset`, Postgres 17.11.0.018, de versie
  van staging): `20261118090000`, `20261118100000` en daarna `20261118113000`. De
  prognose-migratie daarna nog een keer: geen fout.
- De databasecontroles van de rooktest van staging: het boekhouder-hek dekt beide
  tabellen, anon heeft op geen tabel of functie rechten, en het schema `public`
  blijft dicht voor anon.
- Stromentest `prognose`: 20 van de 20 stappen geslaagd.
- UI-test `prognose` in Chromium tegen de echte backend: 8 van de 8 stappen
  geslaagd.
- Laden per module: alle controles geslaagd; de prognose haalt geen zware groep op
  en elke tabel één keer.
- Inrichtingsstappen: alle controles geslaagd. Terugknop: 13 van de 13.
- Mobiele lay-outtest, licht en donker: loopt nog (alle 118 pagina's, in vier
  rondes); de uitslag komt hier.

## Niet in deze stap

- **Rechtstreeks uitvoeren** door een gekoppelde AI met een uitvoersleutel: een
  prognose gaat altijd langs de goedkeurwachtrij. Daarvoor moet `forecasts` in
  `action_member_write` en `apply.ts` komen.
- **Het logboek** (Instellingen → Logboek): de prognose heeft haar eigen
  geschiedenis met wie en wat. In het logboek zou ze `audit_entity_module` en
  `AUDIT_ENTITY_MODULE` nodig hebben.
- **Een seizoenspatroon uit vorige jaren**: nu zet je een rustige maand met de hand
  (of laat je Gerrie dat doen).
- **Een cashflowprognose** (wanneer er betaald wordt, de btw): dit is een prognose
  van het resultaat.
- **De prognose op het dashboard**.
