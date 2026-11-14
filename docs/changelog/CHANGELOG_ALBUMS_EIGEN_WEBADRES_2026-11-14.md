# Albums op je eigen webadres — 14 november 2026

Vraag: *"Zorg ervoor dat galerijen die worden gepubliceerd en gedeeld ook via het eigen domein
wordt verzonden of via het gekoppelde domein. Bouw dit zorgvuldig, goed en veilig in. Deploy
naar staging als je klaar bent."* Met een schermafbeelding van Instellingen → Domein:
`brand-new-gerrie.resofly.com`, en eronder *"Nog niet in gebruik: links in je mails gaan nu
naar staging.resofly.com"*.

## Wat er was

De deellink van een album (Galerij → Delen, en de handeling van Gerrie die een deellink maakt)
vroeg het adres al aan de server: het klantadres van de organisatie, als de klantadressen
"live" stonden (`CLIENT_DOMAINS_LIVE`, zie `CHANGELOG_KLANTDOMEINEN_2026-11-09.md`). Op staging
stond die schakelaar nooit aan. Hij gold voor alles tegelijk: albums, maar ook facturen,
offertes, contracten en het portaal. Dus ging elke deellink naar `staging.resofly.com`, ook
al stonden de DNS en de Worker voor `<naam>.resofly.com` sinds 9 november klaar.

Daarnaast toonde het venster Delen een tel het adres van de app, tot het antwoord van de server
binnen was. Wie snel op Kopiëren drukte, deelde dat adres in plaats van zijn eigen.

## Wat het nu is

### Albums vóór de rest

- `CLIENT_DOMAINS_LIVE` kent nu drie waarden: `false` (niets), **`albums`** (alleen de
  deellinks van albums) en `true` (alles). Met `albums` gaat de deellink naar het klantadres
  van de organisatie: een actief eigen domein (`albums.jansen.nl`) als dat er is, anders de naam
  bij ResoFly (`jansen.resofly.com`). Facturen, offertes, contracten, boekingen en het portaal
  blijven op het adres van de app, tot de schakelaar op `true` gaat.
- **Op staging staat hij op `albums`.** De waarde staat in
  `.github/workflows/deploy-staging.yml`, en de deploy zet hem (zie Uitrol). Alles aanzetten
  is daar één woord: `true`.
- Een andere waarde (bijvoorbeeld `facturen`) zet niets aan. De functies zeggen het in hun log,
  in plaats van stil te blijven terwijl iemand denkt dat het aan staat.

### In de app

- **Galerij → Delen**: de link staat op je webadres, met eronder *"De link staat op je eigen
  webadres. Dat stel je in bij Instellingen → Domein."* Zolang het adres onderweg is, staat er
  *"Je webadres ophalen…"* en kun je nog niet kopiëren. Lukt het niet, dan de link op het adres
  van de app; die werkt altijd.
- **Gerrie** (*"maak een deellink voor de galerij"*) geeft dezelfde link.
- **Instellingen → Domein** zegt wat er geldt: *"De deellinks van je albums gaan al naar dit
  adres. Links in je mails (offertes, facturen, contracten en het portaal) gaan nu nog naar
  staging.resofly.com. Zodra ResoFly de klantadressen helemaal aanzet, gaan ook die vanzelf naar
  dit adres."* Met een actief eigen domein noemt de zin dat domein, en de kaart Eigen domein
  zegt *"De deellinks van je albums gaan al hierheen."*

### Wat de klant ziet

De link `https://<naam>.resofly.com/gallerij/<token>` opent het album in de huisstijl van de
organisatie, met haar naam in het tabblad. Dat deed de Worker al sinds 9 november; nu krijgt de
klant die link ook echt.

## Veiligheid

- **Het adres komt uit de organisatie, nooit uit het verzoek** (harde regel 1). Het overzicht
  van `client-domains` bouwt de link uit het actieve webadres of eigen domein van díe
  organisatie, na de controle op het lidmaatschap. Gerrie gebruikt de organisatie van de
  sessie, niet iets uit het voorstel.
- **Een album van een andere organisatie bestaat niet op jouw adres.** `gallery-public` geeft
  dan dezelfde 404 als bij een onbekende link, zonder titel. Dat deed het al; nu getest (zie
  Getest).
- **Alleen een http(s)-adres telt** in de app (`src/lib/clientAddress.ts`): wat de server ook
  teruggeeft, de link begint nooit met `javascript:` of iets anders wat de browser uitvoert.
- **Pas aan als het adres antwoordt.** De deploy zet de schakelaar pas na een geslaagde
  rooktest, en die rooktest controleert nu een echt klantadres op staging: de Worker toont er
  een album (met de meta van een klantadres), en `gallery-public` neemt dat adres aan als
  herkomst, ook in CORS (de voorvlucht). Faalt dat, dan blijft de schakelaar zoals hij was.
  Liever een link naar het adres van de app dan een link die nergens heen gaat.
- **Een tikfout zet niets om**: het script kent alleen `true`, `albums` en `false`, en in een
  lijst is `true` geen "alles".

## Techniek

- `supabase/functions/_shared/clientLinks.ts`: `parseClientDomainsLive`, `liveKinds` in de
  instellingen, en `liveFor(config, 'albums')` voor `clientBaseUrl`.
- `supabase/functions/client-domains/index.ts`: het overzicht geeft `albumUrl`,
  `albumOnClientHost` en `config.liveKinds`. Een oudere app leest ze niet; een oudere functie
  geeft ze niet, en dan volgt de app `clientUrl` zoals voorheen.
- `src/lib/clientAddress.ts` (nieuw, met test): welk adres een link krijgt, uit het overzicht.
- `src/services/domainService.ts`: `useClientAddress` met `ready`, `useAlbumAddress` en
  `albumBaseUrlFor`. `useClientBaseUrl` en `clientBaseUrlFor` zijn weg; alleen de deellink
  gebruikte ze.
- `src/features/ProjectGallery.tsx` (Delen), `src/lib/actions/marketing.ts` (Gerrie),
  `src/features/ClientDomainSettings.tsx` (de teksten).
- `scripts/supabase-smoke-test.sh`: de controle van een klantadres (het oudste actieve
  webadres; alleen met `SUPABASE_DB_PASSWORD`, om een adres te vinden).
- `scripts/supabase-client-domains-live.sh` (nieuw): zet `CLIENT_DOMAINS_LIVE` alleen als de
  waarde verandert (Supabase bewaart een SHA-256 per secret; het script vergelijkt die).
- `.github/workflows/deploy-staging.yml`: `CLIENT_DOMAINS_LIVE: albums` en de stap
  *Klantadressen (CLIENT_DOMAINS_LIVE)* na de rooktest.

Geen migratie, geen nieuwe datagroep (harde regel 5): het adres is één klein verzoek dat per
organisatie wordt onthouden, zoals voorheen.

## Getest

- `npm run typecheck`, `npm test` (1869 tests, 0 fout; nieuw: de waarden van
  `CLIENT_DOMAINS_LIVE`, `liveFor`, de links met alleen albums live, en `clientAddress`).
- `npm run test:stromen -- klantdomein` op een verse database (alle 278 migraties): 109 stappen,
  0 fout. Nieuw:
  - alleen albums live: albums naar het eigen domein, facturen en het portaal naar het algemene
    adres, ook voor een teamlid zonder beheerrechten;
  - elke organisatie haar eigen adres, en niemand het overzicht van een ander (403);
  - een album op het klantadres: openen met CORS (ook de voorvlucht), en het album van een
    andere organisatie geeft daar dezelfde 404 als een onbekende link, zonder titel.
- `tests/stromen/ui.mjs galerij` in Chromium, tegen dezelfde stack: 10 stappen, 0 fout. Nieuw,
  precies wat jij doet:
  - Publiceren, Delen, *Deellink maken*: de link staat op `<naam>.resofly.com`, met de hash van
    precies dat token in de database, en de uitleg eronder;
  - een klant opent de link in een eigen browser op dat adres (via de nagebootste Worker) en
    ziet het album; `gallery-public` kreeg het webadres als herkomst.
  - Tegenproef: met de oude regel (albums volgen de schakelaar voor alles) faalt de eerste stap
    met *"de link staat niet op het webadres: http://127.0.0.1:…/gallerij/…"*.
- `scripts/supabase-client-domains-live.sh` tegen een nagebootste Management API en CLI: nieuw
  zetten, al goed (niets doen), van `false` naar `albums`, naar `true`, een onleesbare lijst
  (stoppen, niets zetten), een onbekende waarde en een lege waarde (weigeren).
- `npm run test:mobile -- --theme=both` voor Instellingen → Domein (nu met albums live, de
  langste zin), de publieke galerij en Huisstijl: 18 pagina's, 0 met problemen.
- `npm run build` (zoals Cloudflare Pages) en `scripts/check-csp-hash.mjs`.
- `deno check`: niet in deze sessie (esm.sh en deno.land zijn hier niet bereikbaar); wel in de
  job *edge-functions* van *Frontend checks* in GitHub, zie Uitrol.

## Uitrol

Zie hieronder; bijgewerkt na de deploy.

## Wat nog niet

- **De foto's zelf** komen nog van de media-worker (`*.workers.dev`). Een klant ziet dat adres
  alleen bij "afbeelding openen in nieuw tabblad" en in de downloadlijst van zijn browser.
  Media onder `/m/` op het klantadres is fase 3 van het plan
  (`docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md`); dat vraagt een nieuwe versie van de
  Worker, met de headers uit §6 van het plan, en de Worker rolt CI niet uit.
- **Het portaal en de mails** (facturen, offertes, contracten, de inlogmail) gaan op staging nog
  naar `staging.resofly.com`. Een gepubliceerde galerij zien klanten met portaaltoegang dus nog
  in het portaal op dat adres. Alles aanzetten: `CLIENT_DOMAINS_LIVE: "true"` in de workflow.
  Klanten die op `staging.resofly.com/portal` ingelogd zijn, loggen dan één keer opnieuw in op
  het webadres.
