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
| De gegevens vertrokken pas na de eerste render (in een effect) | eerste verzoek ~0,8 s nadat de JavaScript binnen was |
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
  in het portaal of op een klantadres gebeurt er niets.
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

### De database (`20261122100000_rls_een_keer_per_query.sql`)

De leesrechten één keer per vraag in plaats van per rij, voor 287
leespolicies op 159 tabellen. Zie
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

## Getest

_(wordt aangevuld)_

## Nog open

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
- **De hoofdbundel verder:** de bewerkvensters in `main.tsx` (236 KB) en de
  teamchat (127 KB) kunnen los. Geschatte winst op een telefoon: 50–100 ms
  warm.
- **De CSS (1,45 MB, 232 KB gzip)** bevat alle looks en alle pagina's. De
  volgorde van de regels is bewust; splitsen vraagt de hele mobiele test.
- **`ai_decisions read`** rekent nog per rij (de module komt uit een kolom).
  Dat kan met dezelfde sleutellijst als de bijlagen.
- **De controle vooraf op staging** (`scripts/rls-een-keer-per-query-voorcontrole.sql`: verwachte 287
  policies, geen afwijkingen) kon vanuit de cloudsessie niet draaien: de
  Management API was niet bereikbaar. De migratie controleert dat zelf en
  stopt zonder iets te veranderen als staging afwijkt. De uitrol faalt dan
  vóór de edge functions; de workflow laat zien waarom.
