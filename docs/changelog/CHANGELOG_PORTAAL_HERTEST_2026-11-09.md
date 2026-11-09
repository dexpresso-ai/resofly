# Hertest: het klantportaal op een eigen domein — 9 november 2026

Vraag: *"Kun je de functionaliteit nog eens goed testen of alles omtrent de eigen domeinnaam
goed en veilig werkt."*

## Hoe er getest is

- **Een nieuwe browsertest** (`tests/stromen/ui.mjs klantdomein`, 17 stappen). Chromium doet
  wat de eigenaar en een klant doen, met de echte app, de echte functies en de echte database.
  - Een eigen domein bestaat lokaal niet. Chromium vraagt `https://portaal.<ronde>.nl/…` op,
    en de test antwoordt zoals de Worker van de klantadressen: met diens eigen beslisregels
    (`workers/client-domains/src/logic.ts`) en de echte opzoeking in `client-domains`.
  - De test kijkt ook mee in de browser: wat er in de opslag staat, welke kopregels de app
    meestuurt, en welke dossiers terugkomen.
- **Twee controles van de code, los van elkaar.**
  - De database en de functies: inloggen, bereik, sleutels.
  - De Worker, de app en de links.
- **Alles opnieuw:** unittests, de stromentests, de Worker in workerd, `deno check`, de
  lay-out op de telefoon, en de migraties vanaf nul.

## Wat goed werkte

- De schakelaar in Instellingen → Domein: de eigenaar zet hem om, een medewerker ziet alleen de
  stand, en het Logboek schrijft het op.
- Op het eigen domein:
  - de klant logt in met de code van ResoFly of met de link;
  - de browser krijgt alleen een sleutel, nooit een inlog bij Supabase, en er komt bij Supabase
    ook geen sessie bij;
  - de klant ziet alleen het dossier van die organisatie, ook als hij ook elders klant is;
  - na herladen is hij nog binnen;
  - uitloggen gooit de sleutel weg, in de browser en bij de server;
  - de link werkt niet in een andere browser.
- Zet de eigenaar het portaal uit terwijl een klant binnen is, dan is die klant meteen
  uitgelogd. Daarna stuurt het domein `/portal` door naar `<naam>.resofly.com`.
- Op `<naam>.resofly.com` legt de server de inlog vast voor alleen die organisatie, en
  uitloggen beëindigt hem bij Supabase.
- Op het algemene portaal ziet een inlog alle dossiers van de klant.

## Wat niet goed was, en is gerepareerd

1. **Een code van Supabase was via een eigen domein af te vangen (ernstig).**

   Een leverancier met een eigen domein vraagt daar, net als het portaal zelf, om "de code uit
   de mail". De aanval:
   - De leverancier vroeg vanaf zijn eigen server een inlog aan op het algemene portaal. Dat
     kan ook op het adres van een andere leverancier, want de herkomst van een verzoek is na te
     maken.
   - De klant kreeg een mail met een code van Supabase, en vulde die op de pagina van de
     leverancier in.
   - De leverancier legde de inlog vast met zijn eigen browsergeheim.

   Zo kreeg hij een inlog bij Supabase voor alles wat de klant bij iedereen heeft. Ook zonder
   dat iemand iets invulde, bestond het token al vanaf het aanvragen, een uur lang, klaar om
   te raden.

   Nu:
   - Op de naam bij ResoFly en het algemene portaal staat er **nooit meer een code** in de
     mail, alleen de link.
   - Supabase maakt het token **pas als de link opengaat in de browser die hem aanvroeg**.
   - Een inlog vastleggen kan alleen met het aanvraagnummer uit die link.
   - Het account bij Supabase komt ook pas dan. Aanvragen laat bij Supabase geen spoor na, dus
     Supabase verraadt ook niet meer of een adres ergens klant is.
   - Op een eigen domein blijft de code van ResoFly. Die geeft alleen een sleutel voor het
     portaal van die ene leverancier.

   De stromentest speelt de aanval na; hij lukt niet meer.

2. **Een haperend eigen domein bleef vertrouwd (middel).**

   Wijst het record niet meer naar ResoFly, bijvoorbeeld omdat het domein nu van een ander is,
   dan wordt het domein *Werkt niet* (`failing`). Toch deed het nog mee voor het portaal:
   - de sleutels in de browsers bleven werken, en wie daar nu de pagina's beheert, kon ze
     uitlezen;
   - en iedereen kon vanaf dat adres een inlogmail laten sturen, in de huisstijl van de
     organisatie.

   Nu telt alleen een actief domein. De ronde loopt een domein met portaal elk kwartier na, in
   plaats van elke zes uur. Dat geldt ook voor herstel: is het weer in orde, dan kunnen klanten
   daar binnen het kwartier weer inloggen.

3. **Sleutels bleven na het uitzetten bestaan.** Ze werkten wel niet meer, maar zette de
   eigenaar het portaal later weer aan, dan werkten ze weer. Nu gooit de database de sleutels
   van een domein weg zodra het portaal uitgaat of het domein niet meer actief is. Dat geldt
   langs elke weg: de schakelaar, de ronde, ontkoppelen of overnemen.

4. **Het inlogscherm van de werkruimte op een klantadres (laag).** Twee routes:
   - Een bestand dat niet bestaat (`/assets/…`) geeft Pages als de app zelf. Zonder de meta van
     de Worker draaide die als werkruimte.
   - Bij een adres met een punt aan het eind keurde de app de meta af.

   Nu geeft de Worker voor HTML onder `/assets`, `/fonts` en `/icons` een 404. Een adres met
   een punt aan het eind stuurt hij door naar het adres zonder punt.

5. **Inlogmails telden mee in het mailquotum van de organisatie (laag).** Met een nagemaakte
   herkomst en veertig bekende klantadressen kon iedereen het quotum in een uur opmaken. Dan
   gingen ook de facturen van die organisatie niet meer weg. Inlogmails hebben nu een eigen rem
   van 300 per uur per organisatie, naast de remmen per adres en per afzender.

6. **`client-portal` trok een verkeerde inlog niet in.** Een inlog bij Supabase vanaf een eigen
   domein werd alleen ingetrokken als hij bij die organisatie hoorde. Nu altijd.

7. **In de app:**
   - **Een fout in de console bij elke klant**, gevonden door de browsertest. De app
     registreerde ook op een klantadres zijn service worker (de pushmeldingen voor teamleden),
     en daar is geen `/sw.js`. Nu niet meer op een klantadres.
   - **In de sleutelmodus nooit een token van Supabase.** De app gebruikt daar nooit een token
     van Supabase, ook niet als de server er onverhoopt een gaf.
   - **Uitloggen vergeet ook de geheimen** van een inlogaanvraag die nog openstond.

## Wat blijft, bewust

- **Een code van een eigen domein invullen op de pagina van een ander.** Een klant die dat doet,
  geeft die ander toegang tot zijn dossier bij de leverancier van wie de mail is. Zo werkt elke
  inlogcode. Er zijn drie remmen:
  - de mail staat in de huisstijl van die leverancier;
  - de mail zegt op welk adres de code hoort;
  - de code geeft alleen een sleutel voor dat ene portaal.
- **Inlogmails sturen met een nagemaakte herkomst.** Wie klantadressen kent, kan zo inlogmails
  laten sturen. De remmen:
  - 5 per adres per uur;
  - 20 per afzender per 10 minuten;
  - 300 per organisatie per uur.

  Alleen de nieuwste aanvraag telt. Een klant die daar last van heeft, vraagt opnieuw een link
  aan.
- **Wie de DNS van een eigen domein beheert, kan daar de sleutels uitlezen.** Dat is zo
  ontworpen: het zijn sleutels voor het portaal van die organisatie zelf. Neemt een ander het
  domein over, dan verdwijnen de sleutels zodra Cloudflare dat meldt en de ronde het ziet
  (binnen het kwartier).
- **Supabase zelf (geen wijziging nodig).** Op staging zijn codes van Supabase acht cijfers en
  een uur geldig. Het algemene inloggen van Supabase (ook dat van teamleden) gebruikt die
  instelling.

## Gevolgen bij de uitrol

- Klanten op de naam bij ResoFly en het algemene portaal krijgen geen code meer in de mail. Wie
  de mail op een ander apparaat leest, vraagt daar een nieuwe link aan. Het inlogscherm en de
  mail zeggen dat.
- Een inlogmail van vóór de uitrol: de link werkt nog, want het token komt bij het openen. De
  code daarin werkt niet meer: er is geen veld meer om hem in te vullen.
- De migratie gooit sleutels weg van een domein dat niet actief is of geen portaal heeft. Op
  staging staat er nog geen enkel eigen domein, dus daar verandert niets.

## Techniek

- **Migratie** `20261109150000_portaal_inlog_alleen_met_link.sql`:
  - `portal_login_requests` mag zonder token en zonder code bestaan, en `token_sent_at` vult de
    database ook bij het later zetten van het token;
  - `portal_session_bind` wil een aanvraagnummer;
  - `portal_token_scope` alleen bij een actief domein;
  - een trigger op `client_domains` gooit sleutels weg;
  - `portal_sessions_cleanup` ruimt ook sleutels zonder actief domein op.
- **`portal-login`:**
  - geen `generateLink` en geen account bij het aanvragen;
  - bij het inwisselen het account en het token (`issueSupabaseToken`);
  - een eigen rem op inlogmails per organisatie;
  - de meldingen zonder "code".
- **`_shared/clientLinks.ts`:** het portaal alleen op een actief domein.
- **`client-domains`:**
  - de opzoeking voor de Worker geeft het portaal alleen bij een actief domein;
  - de ronde loopt een domein met portaal elk kwartier na.
- **`client-portal`:** een inlog bij Supabase vanaf een eigen domein eerst intrekken.
- **De Worker:** `withoutTrailingDot` en `isHtmlType` in `logic.ts`.
- **De app:**
  - het codeveld alleen in de sleutelmodus;
  - `verifyPortalLogin` alleen met het token van de link;
  - `bindPortalSession` met aanvraagnummer;
  - geen service worker op een klantadres.
- **De inlogmail:** zonder code een zin voor wie op een ander apparaat leest.

## Getest

- `npm test`: 1377 tests.
- `npm run typecheck`.
- `deno check` op de 35 functies uit `frontend-checks.yml` en op `client-portal`.
- De Worker:
  - `node --test src/logic.test.ts`;
  - `node test/worker.mjs` in workerd: 55 controles, nieuw de 404 voor een ontbrekend bestand en
    het adres met een punt.
- De stromentest `klantdomein`: 106 stappen, 0 fout. Nieuw of anders:
  - aanvragen laat geen spoor na;
  - de aanval uit de controle;
  - de nieuwste aanvraag;
  - een onderschepte inlog;
  - een teamlid;
  - uitzetten gooit de sleutel meteen weg, en weer aanzetten maakt hem niet weer geldig;
  - een haperend domein en het herstel daarvan.
- De browsertest `klantdomein`: 17 stappen, 0 fout.
- `npm run test:stromen`: 900 stappen, 0 fout.
- `npm run test:mobile -- --theme=both`: 422 pagina's, 0 met problemen.
- `npm run build` (zoals Cloudflare Pages) en `scripts/check-csp-hash.mjs`.
- Migraties vanaf nul (`supabase db reset`, Postgres 17.11): 260 van 260. De nieuwe migratie
  ook twee keer achter elkaar.
