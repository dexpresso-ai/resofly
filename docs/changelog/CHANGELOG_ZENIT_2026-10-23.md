# Changelog — Zenit in de app, achter "Probeer Zenit" — 2026-10-23

Het designvoorstel van gisteren (`DESIGN_VOORSTEL_ZENIT_2026-10-22.md`) staat nu in de
werkruimte zelf. Niet als vervanging: wie niets doet, ziet niets veranderen. Wie in het
accountmenu op **Probeer Zenit** klikt, krijgt de nieuwe voorkant, per gebruiker en per
browser. Terug kan altijd: rail → **Weergave** → Zenit uit.

## Wat je ziet met Zenit aan

- **De nachtrail.** Zeven modules in plaats van dertien menuregels: Vandaag, Gerrie,
  Agenda, Werk, Geld, Berichten en Inzicht. Donker in Dag én Nacht: het merkanker. Een
  klik op een module brengt je naar zijn beginpagina; tellers staan op de rail (te
  beslissen, tickets, inkoopfacturen, berichten en chat).
- **Het contextpaneel.** Naast de rail staat wat je in die module kunt: bij Geld
  bijvoorbeeld Verkoop, Inkoop, Boekhouding en Rapportage in vier rijtjes in plaats van
  vijftien regels onder een uitklapper. Bovenin de organisatie (met de werk-BV's onder
  hun holding), bij Werk en Vandaag je vijf laatst bijgewerkte projecten, onderin Gerrie.
  Op de instellingenpagina toont het paneel de onderdelen van de instellingen.
- **Vastzetten of los.** Vastgezet staan rail en paneel naast het werkvlak; los staat
  alleen de rail en schuift het paneel bij hover of focus over het werkvlak. Dezelfde
  keuze als het speldje van de huidige zijbalk, en dezelfde standaard (vast vanaf
  1280px breed).
- **De vraagbalk.** Rechts in de tabrij, met <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd>.
  Hij zoekt zoals het zoekveld van nu, maar bovenaan staat **Vraag Gerrie: "…"**. Klinkt
  wat je typt als een vraag (*wat staat er open bij Bloem?*, *maak een offerte…*) of vindt
  hij niets, dan staat Gerrie voorgeselecteerd en opent Enter het gesprek met je vraag erin.
  Heet er iets precies zo, dan wint dat.
- **Het werkvlak zweeft.** De tabrij ligt op de grond, het werkvlak eronder met ronde
  hoeken. De titelbalk is weg: de werktab draagt de naam, "Ververs" staat in het
  contextpaneel en "Alleen lezen" naast de vraagbalk.
- **Vandaag.** Het donkere cockpitblok van het dashboard wordt de dag zelf:
  - de groet, met **Vraag Gerrie** en de Weekplanner ernaast;
  - de **Dagboog**: je dag als horizon, van zon op tot zon onder. Je afspraken en de taken
    die je in de weekplanner op een tijd zette, liggen als gekleurde stukken op de boog,
    eronder wat er nú is en wat er daarna komt (met *Deelnemen* als de afspraak een
    videolink heeft). Sleep de zon om vooruit of terug te kijken, of laat de dag afspelen;
    **Nu** zet hem terug. Met het toetsenbord: pijltjes per 5 minuten, Page Up/Down per uur;
  - de **Puls**: de kerncijfers in één kaart in plaats van zes losse tegels.
- **Vier themastanden** in Weergave: Nacht, Dag, **Met de zon mee** (wisselt bij zon op en
  zon onder) en **Systeem** (volgt je apparaat). Een nieuwe stand groeit als een cirkel
  vanuit de knop waarop je klikte.
- **Rustiger letter en vlakken.** Koppen in Poppins 600 in plaats van 800, kopjes in
  zinsvorm, de hoofdknop vlak goud. De kop van een project of klant is geen donker blok
  meer maar een gewoon vlak met de kleur van het project of de klant als gloed.
- **Telefoon.** Het uitschuifmenu heeft de rail links en het paneel rechts: een tik op de
  rail wisselt het paneel, een tik in het paneel navigeert. De Dagboog is kleiner en
  toont alleen Nu en Volgende. De dock onderin blijft.

## Wat (nog) niet

Uit het voorstel nog niet gebouwd: het spiekpaneel naast lijsten, de Geldstroom-grafiek,
de vraagbalk die een opdracht ontleedt tot een kant-en-klare handeling (nu geeft hij de
vraag door aan Gerrie), de sneltoetsen <kbd>G</kbd> + letter, en Ruim/Compact. De modules
zelf (klant, project, facturen, agenda) houden hun huidige opbouw in de nieuwe kleuren.
Op de telefoon is er geen vraagbalk; daar zoekt de huidige look ook niet.

## Onder de motorkap

- `src/lib/look.ts` (nieuw) — de look (`'cockpit' | 'zenit'`) in `localStorage`
  (`resofly.look`), als `data-look="zenit"` op `<html>`.
- `src/lib/theme.ts` — de stand (`'dark' | 'light' | 'sun' | 'system'`) staat nu in
  `resofly.theme`; `useThemeMode()` geeft stand én opgelost thema. Met de zon mee plant
  zelf de volgende wissel en kijkt opnieuw als je terugkomt in het tabblad; publieke
  pagina's en het portaal (eigen huisstijl) praat hij niet door. `useTheme()` blijft
  bestaan voor de zijbalk van Cockpit.
- `src/lib/sun.ts` (nieuw, met `sun.test.ts`) — zon op, zenit en zon onder (NOAA-benadering)
  voor Utrecht, het midden van het land.
- `index.html` — het opstartscript zet look en thema vóór de eerste verf, ook voor Met de zon
  mee (dezelfde formule, nagerekend over 10.918 momenten: 0 verschillen) en Systeem. Nieuwe
  hash in beide CSP-regels van `public/_headers`.
- `src/styles/zenit.css` (nieuw) — de hele look, ná `teamchat.css` geladen. Elke regel hangt
  aan `data-look="zenit"`; tokens alleen op `:root:has(.app)`, zodat portaal en publieke
  pagina's hun huisstijl houden.
- `src/components/ZenitNav.tsx` (nieuw) — rail, contextpaneel, Weergave en accountmenu.
  Dezelfde gegevens en regels als de zijbalk: modulerechten, rechtsvorm (VPB, DGA,
  aandeelhouders, jaarrekening), tellers.
- `src/features/DayArc.tsx` (nieuw) — de Dagboog.
- `src/components/Sidebar.tsx` — "Probeer Zenit" in het accountmenu; de props als
  `SidebarProps` en de instellingenfilter als `visibleSettingsTabs()` gedeeld met Zenit.
- `src/components/GlobalSearch.tsx` — `variant="ask"` en `onAsk` voor de vraagbalk.
- `src/components/GerrieChat.tsx` — `askGerrie(tekst)`: open Gerrie van buitenaf, met een
  vraag. Is hij nog bezig, dan komt de vraag in het tekstveld in plaats van te verdwijnen.
- `src/components/TabBar.tsx` — `trailing` voor de vraagbalk; de `tablist`-rol zit nu op de
  strook met tabbladen zelf, niet meer op de rij met "nieuw" ernaast.
- `src/features/Dashboard.tsx` — met Zenit de groet, de Dagboog en de Puls in plaats van de
  cockpit; de kerncijfers zijn voor beide looks dezelfde tegels.
- `src/main.tsx` — kiest de navigatie op de look, zet de vraagbalk in de tabrij en laat de
  titelbalk weg onder Zenit.
- `tests/mobile/run.mjs` — `--look=zenit` meet de nieuwe voorkant.

## Gecontroleerd

- `npm run typecheck`, `npm run build` en `npm test` (813 tests, waarvan 6 nieuw voor de zon).
- `node scripts/check-csp-hash.mjs`: de nieuwe hash staat in beide CSP-regels.
- De mobiele lay-outtest in Dag en Nacht, op telefoon, tablet en liggend: met Cockpit (de
  standaard) 288 metingen zonder problemen, dus voor wie Zenit niet aanzet verandert er
  niets; met `--look=zenit` ook 288 zonder problemen. Op Vandaag is onder Zenit de Dagboog
  het eerste item (58px van de bovenrand op de telefoon) in plaats van de eerste taak.
- Een functionele ronde in Chromium tegen de mock-backend, 44 controles, alle groen: Probeer
  Zenit aan en weer uit (en terug naar de Cockpit-grondkleur), het opstartscript zet Zenit vóór
  React, de vier themastanden (Systeem wisselt mee met het apparaat, de adresbalk volgt),
  Escape en focus in Weergave, Ctrl+K, een vraag gaat met Enter naar Gerrie en een naam opent
  de klant, rail en paneel naar Grootboek, de BV-onderdelen van Geld, het instellingenpaneel,
  Page Up en Nu op de Dagboog, inklappen en het paneel op hover, en op de telefoon het
  uitschuifmenu. Geen fouten in de console.
- Met Chromium bekeken tegen de mock-backend op 1440 × 900 (vastgezet), 1180 × 760 (los, met
  het paneel open op hover) en 390 × 844, in Nacht en Dag: Vandaag met slepen, de vraagbalk
  met een zoekterm en met een vraag, Weergave, het accountmenu, klant, project, facturen,
  grootboek, agenda, Gerrie en instellingen. Geen fouten in de console.
