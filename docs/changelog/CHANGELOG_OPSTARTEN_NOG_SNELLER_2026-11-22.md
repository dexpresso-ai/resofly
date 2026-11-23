# Opstarten nog sneller, ook in de losse apps — 22 november 2026

Vervolg op [CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md](CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md),
[CHANGELOG_PAGINAS_LOS_LADEN_2026-11-19.md](CHANGELOG_PAGINAS_LOS_LADEN_2026-11-19.md) en
[CHANGELOG_BRIEFPAPIER_LOS_2026-11-19.md](CHANGELOG_BRIEFPAPIER_LOS_2026-11-19.md).

Vraag: "Zorg ervoor dat de app nog sneller laadt bij het opstarten. Dit geldt
ook voor de losse apps van ResoFly."

## Hoe we het lek zochten

Drie zoektochten naast elkaar, elk op een eigen spoor: de bundel en het eerste
beeld, de opstartronde met gegevens, en de losse apps. Staging en de
Supabase-API waren vanuit de cloudsessie niet bereikbaar. Daarom is er gemeten
in Chromium tegen de nagebootste backend van de mobiele test, met de gebouwde
app (niet de dev-server), een nagebootste telefoon (CPU 4× trager, Fast 4G:
9 Mbit/s, 165 ms) en vertraging per verzoek naar Supabase.

## Wat er was

| Lek | Gemeten |
| --- | --- |
| De gegevens vertrokken pas na de eerste render (in een effect) | eerste verzoek ~0,8 s nadat de JavaScript binnen was (evalueren, render, effecten, sessie) |
| De organisatie in twee rondes na elkaar | 150–250 ms per start |
| Tabellen van meer dan 1000 rijen pagina voor pagina | 3.000 taken: vier rondgangen achter elkaar |
| De RLS per rij op elke tabel (zie [CHANGELOG_RLS_EEN_KEER_PER_QUERY_2026-11-22.md](CHANGELOG_RLS_EEN_KEER_PER_QUERY_2026-11-22.md)) | 3.000 taken lezen: 142 ms, per pagina opnieuw |
| Losse apps: de beginpagina als waterval (schil → groep → bestand) | Agenda warm 2,7 s tot de pagina met gegevens |
| `scrollIntoView` (TabBar) en `scrollTop` dwongen tijdens de eerste render volledige layouts af | ~370 ms + ~130 ms op de telefoon |
| Google Fonts blokkeerde het eerste beeld; de meeste gewichten kwamen pas bij het dashboard, met een tweede layout | tot 0,7 s tot het dashboard |
| Het laadscherm verscheen pas als React draaide | eerste beeld een leeg vlak |
| Eén hoofdbundel van 1.809 KB, met het dashboard, de handelingen van Gerrie, vensters en React/Supabase | elke deploy alles opnieuw |

## Wat er nu is

### De opstartronde (`src/main.tsx`, `src/lib/repository.ts`)

- **De eerste ronde begint bij het laden van de code** (`BOOT_ROUND`). Met een
  sessie vertrekken het lidmaatschap, de kern en de groepen van de
  beginpagina al terwijl React de app nog opbouwt. `runWorkspaceRound` neemt
  die ronde over als het dezelfde gebruiker en dezelfde (onthouden)
  organisatie is; anders vervalt hij. Zonder sessie, op een publieke pagina,
  in het portaal of op een klantadres gebeurt er niets. De gemeten winst
  hiervan is klein: het evalueren van de bundel zelf blijkt de meeste tijd
  vóór het eerste verzoek te kosten (zie Gemeten en Nog open).
- **De organisatie in één ronde.** `loadOrganizationContext` vraagt team,
  uitnodigingen, logboek, licenties, statussen en het akkoord voor Gerrie
  vooruit op voor de onthouden organisatie, tegelijk met het lidmaatschap.
  Kiest het lidmaatschap een andere, dan vervalt dat en volgt de ronde voor
  de goede. Het logboek vraagt hij dan op voordat de rol bekend is; voor wie
  geen owner of admin is, telt het niet (de RLS gaf al niets).
- **Pagina's van 1000 rijen tegelijk** (`fetchAllPages`). De eerste pagina
  vraagt ook het totaal (`count=exact`); de rest komt tegelijk, zes per
  keer. Kwamen er intussen rijen bij, of is het totaal onbekend, dan gaat
  het daarna pagina voor pagina verder, zoals voorheen.
- **De beginpagina vooruit.** Het actieve tabblad van de vorige keer (of de
  beginpagina van de app) is de verwachte pagina. Zijn bestand begint bij
  het laden, zijn groepen tegelijk met de kern. Die groepen tellen alleen
  voor de organisatie die het werd, en alleen als je de pagina mag openen
  (regel 1 en 3); anders vervallen ze. `PAGE_DATA_GROUPS` blijft de bron
  (regel 5). Bij elke andere pagina komt het bestand nu tegelijk met de
  groepen, niet erna.
- **`lazyPage` heeft `preload()`** en rendert een pagina die al binnen is
  meteen, zonder eerst te wachten. Welke van de twee een pagina gebruikt,
  ligt vast zodra hij verschijnt: een wissel zou React de pagina opnieuw
  laten opbouwen, en wat je had ingetypt was dan weg.
- **Geen gedwongen layouts meer in de eerste render.** `scrollIntoView` in
  de tabbalk en het lezen van `scrollTop` voor de schaduw onder de
  bovenregel gebeuren in het volgende frame.

### De database (`20261122200000_rls_een_keer_per_query.sql`)

De leesrechten één keer per vraag in plaats van per rij, voor 289
leespolicies op 160 tabellen. Zie
[CHANGELOG_RLS_EEN_KEER_PER_QUERY_2026-11-22.md](CHANGELOG_RLS_EEN_KEER_PER_QUERY_2026-11-22.md).

### De bundel

- **Los geladen:** het dashboard (een losse app opent er nooit op; op `/`
  komt het vooruit binnen), de handelingen van Gerrie (pas bij goedkeuren),
  de document-export naar PDF en Word, het uitlezen van een mail voor een
  nieuwe klant, en de vensters voor een gesprek, Word, taken verschuiven,
  een AI-koppeling en Gerrie aanzetten. Het adres van het portaalvoorbeeld
  staat in een eigen bestandje (`lib/portalPreviewPath.ts`), zodat de
  huisstijlregels niet meer meekomen.
- **React en Supabase in een eigen bestand** (`vite.config.ts`,
  `vendor-react` en `vendor-supabase`). Ze houden hun naam tot een upgrade
  en blijven na een deploy in de cache.

| opstart-JavaScript | onverkleind | gzip |
| --- | --- | --- |
| vóór 19 november | 4.409 KB | 1.308 KB |
| na 19 november | 1.809 KB | 526 KB |
| **nu** | **1.115 + 142 + 211 KB** | **327 + 45 + 55 = 427 KB** |

### Het eerste beeld (`index.html`, `public/_headers`)

- **Eigen lettertypen.** Poppins, Geist, Geist Mono en Instrument Serif
  staan in `public/fonts/web/` (Fontsource 5.3.0, OFL; herkomst in
  `LICENTIES.md`). `src/styles/lettertypen.css` declareert ze onder dezelfde
  namen, met de indeling latin/latin-ext van Google. `index.html` laadt
  Poppins 400–800 vooruit. De link naar Google Fonts is weg: geen extra
  verbindingen en geen stylesheet die het eerste beeld tegenhoudt.
  `/fonts/web/*` staat een jaar in de cache; de versie zit in de mapnaam,
  dus een nieuwe versie komt in een nieuwe map. De huisstijlletters van een
  leverancier op de klantpagina's komen nog wel van Google (`branding.ts`).
- **Het laadscherm staat in de HTML.** "ResoFly is aan het laden…" staat er
  zodra de CSS binnen is, niet pas als de JavaScript draait. Het is gelijk
  aan `BootLoading` in `main.tsx`; React vervangt het zonder sprong. Alleen
  op `/` en `/app/…` (het thema-script zet `data-boot`); niet op publieke
  pagina's, in het portaal of op een klantadres. De CSP-hash van het
  script is bijgewerkt.
- **De losse apps brengen een open venster naar voren** (`launch_handler`
  met `focus-existing` in de drie manifesten), in plaats van een tweede
  venster dat de hele app opnieuw opbouwt.

## Gemeten

De gebouwde app van staging van 22 november 's ochtends (`500fc90`) naast
die van nu, op dezelfde machine. Chromium met een nagebootste telefoon:
CPU 4× trager, Fast 4G (9 Mbit/s, 165 ms per verzoek). De nagebootste backend
rekent geen databasetijd; de winst van de RLS (hieronder) komt in het echt
erbovenop.

**Tot de beginpagina met gegevens in beeld staat** (mediaan van 5 runs;
koud = lege cache, warm = tweede start):

| | koud vóór | koud nu | warm vóór | warm nu |
| --- | --- | --- | --- | --- |
| werkruimte `/` (dashboard) | 2,27 s | **1,92 s** | 1,57 s | **1,33 s** |
| ResoFly Agenda | 3,00 s | **1,85 s** | 1,94 s | **1,16 s** |
| ResoFly Financiën | 2,92 s | **1,69 s** | 1,94 s | **1,11 s** |
| ResoFly Communicatie | 2,91 s | **1,84 s** | 1,84 s | **1,11 s** |

In de losse apps start het bestand van de beginpagina nu op 0,44 s (warm),
tegen 1,8 s eerst, en zijn groepen gaan tegelijk met de kern.

**Met realistische aantallen** (3.000 taken, bijlagen en toewijzingen, 120 ms
per verzoek, CPU 4×, mediaan van 3; de nagebootste backend geeft het totaal
zoals PostgREST bij `count=exact`): de werkruimte staat er op **1,77 s**
tegen 2,23 s, met 64 verzoeken in plaats van 68. Pagina 2 en 3 van de taken
gaan tegelijk.

**In de database** (lokaal, de hele keten, 3.000 taken, als lid,
`EXPLAIN ANALYZE`): alle taken lezen **1,5 ms** tegen 142 ms; alle bijlagen
2,6 ms tegen ~150 ms. Op staging was de RLS per rij nog trager (~90 µs per
rij tegen ~31 µs lokaal).

Wat niet verschoof: het eerste verzoek vertrekt warm nog steeds op ~0,65 s.
De tijd daarvóór zit vooral in het evalueren van de bundel, niet in de
eerste render. Koud vertrekt het iets eerder (1,34 → 1,24 s), omdat de bundel
kleiner is.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 2.125 geslaagd (na de merge met staging), 0 mislukt.
- `npx supabase db start`: de hele keten vanaf nul (296 migraties,
  Postgres 17.11.0.018), "289 leespolicies herschreven op 160 tabellen".
- `npm run test:database`: alle vijf geslaagd, met de nieuwe
  `rls_een_keer_per_query.sql` (12 rollen × 9 tabellen: dezelfde rijen als
  met de oude functies).
- `npm run test:loading`: alle controles geslaagd. Elke pagina haalt precies
  zijn groepen op, ook als ze vooruit kwamen.
- `npm run test:inrichten`: alle controles geslaagd.
- `npm run test:terugknop`: 15/15. Eén run vóór de merge had één mislukking
  ("en omhoog"), terwijl er tegelijk zware metingen liepen; de drie runs
  daarna, ook na de merge, 15/15.
- `npm run test:mobile -- --theme=both`: zie "De mobiele test en Poppins"
  hieronder. Na de correctie: 842 pagina's gemeten, 0 met problemen
  (exitcode 0).
- `node scripts/check-csp-hash.mjs`: de hash staat in beide CSP-regels.
- Het laadscherm uit de HTML naast dat van React (JavaScript geblokkeerd
  tegen Supabase dat niet antwoordt), licht en donker: alleen de stand van
  de spinner verschilt. Niet zichtbaar op `/quote/…`, `/portal` en
  `/?chat=1`.

### De mobiele test en Poppins

Na de eerste uitrol naar staging werd *Frontend checks* (run 276) rood op de
mobiele test: 4 pagina's met een probleem. Het dashboard en de werkruimte-app
op de telefoon, licht en donker, hadden het eerste item op 287 px (max 280).
Lokaal had ik die 4 voor bekend gehouden, omdat de changelog van 19 november
dezelfde 287 px noemde. Op GitHub waren ze vóór deze wijziging wel groen
(run 275). Dat had ik eerst moeten nakijken.

De oorzaak: de test blokkeert de lettertypen van Google ("de test gaat over
lay-out, niet over Poppins") en mat dus altijd met een vervangende letter.
Daarop zijn de grenzen afgesteld. Nu Poppins uit `public/fonts/web` komt,
laadde hij in de test wél. Gemeten op het dashboard (telefoon, donker):

| | eerste item |
| --- | --- |
| staging vóór deze wijziging | 273 px |
| nu, met Poppins | 287 px |
| nu, zonder de eigen letters | 273 px |

De lay-out zelf is dus niet veranderd. `tests/mobile/mock/backend.mjs`
blokkeert nu ook `/fonts/web/**`, zodat de test meet zoals hij altijd deed.
De grens heb ik niet verruimd.

## Nog open

- **Het dashboard op de telefoon met de echte letter.** Met Poppins staat de
  eerste taak op 287 px, 7 px onder de grens van de test. Zo zagen gebruikers
  het al (zij kregen Poppins van Google). Nu de letters lokaal staan, kan de
  test met Poppins meten; dan moeten de kop of de kaarten van het dashboard
  7 px compacter, of de grens moet bewust omhoog. Dat is een keuze over het
  ontwerp, niet over het laden.

- **Starten uit de cache.** De grootste winst die overblijft voor wie de app
  elke dag opent: de vorige werkruimte meteen tonen (per gebruiker en
  organisatie in IndexedDB) en op de achtergrond verversen. Bewust niet
  gedaan, omdat het eerst een paar keuzes vraagt:
  - tot de verse ronde binnen is, mag er niets opgeslagen, verstuurd of
    geboekt worden (regel 6);
  - een ingetrokken recht blijft anders even zichtbaar (regel 3);
  - uitloggen moet de cache wissen;
  - klantgegevens staan dan op schijf. Dat is een productkeuze, en hoort
    misschien bij "onthoud dit apparaat".
- **De kern kleiner.** Bij een bureau met een paar duizend taken is de kern
  geschat 14 MB JSON (vóór gzip). De helft daarvan is niet nodig voor het
  eerste scherm: notities en documenten met hun volledige HTML, alle
  bijlagen ooit, en inkoopfacturen met `extraction_meta`. Die horen in
  eigen groepen (`dataGroups.ts`, regel 5). Daar zijn veel pagina's bij
  betrokken, dus het is een eigen klus.
- **Het eerste verzoek eerder.** Warm gaat het eerste verzoek naar Supabase
  op ~0,65 s, en de tijd daarvóór is vooral het evalueren van de bundel. Een
  klein startscript dat het lidmaatschap en de kern al opvraagt voordat de
  bundel draait, zou dat deel overlappen. Dat vraagt een tweede weg naar de
  database naast `repository.ts`, met dezelfde regels (regel 1); een eigen
  klus.
- **De hoofdbundel verder:** de bewerkvensters in `main.tsx` (236 KB) en de
  teamchat (127 KB) kunnen los. Geschatte winst op een telefoon: 50–100 ms
  warm.
- **De CSS (1,45 MB, 232 KB gzip)** bevat alle looks en alle pagina's. De
  volgorde van de regels is bewust; splitsen vraagt de hele mobiele test.
- **`ai_decisions read`** rekent nog per rij (de module komt uit een kolom).
  Dat kan met dezelfde sleutellijst als de bijlagen.
- **De controle vooraf op staging** (`scripts/rls-een-keer-per-query-voorcontrole.sql`: verwachte 289
  policies, geen afwijkingen) kon vanuit de cloudsessie niet draaien: de
  Management API was niet bereikbaar. De migratie controleert dat zelf en
  stopt zonder iets te veranderen als staging afwijkt. De uitrol faalt dan
  vóór de edge functions; de workflow laat zien waarom.
