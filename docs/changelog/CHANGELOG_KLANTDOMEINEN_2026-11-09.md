# Klantadressen: een eigen webadres per organisatie, en een eigen domein — 9 november 2026

Vraag (8 november): *"Gebruikers (klanten van ResoFly) moeten gebruik kunnen maken van een
eigen subdomein om te communiceren naar klanten, opleveren albums, mails, klantportalen, etc."*
Daarna: *"Bouw het plan. Doe dit foutloos en zorgvuldig. (…) Zorg ervoor dat gebruikers bij het
instellen van de organisatie hier meteen een keuze voor in moeten dienen. De app dient ook aan
te geven of er al een naam bestaat. (…) Doe dan nog een check of alles goed en veilig is
gebouwd en deploy daarna naar staging."*

Het plan: `docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md`. Inrichten:
`docs/setup/KLANTDOMEINEN_SETUP.md`.

## Wat er was

Elke link aan een klant (factuur, offerte, contract, album, deellink, zending, boeking,
portaal) ging naar één adres uit de instellingen (`APP_PUBLIC_URL` en zes varianten), voor
alle organisaties hetzelfde. De inlogmail van het klantportaal was de Engelse standaardmail van
Supabase ("Your Magic Link"), die alleen op het adres van ResoFly werkte. De publieke functies
kenden alleen vaste origins, en het filter dat betaallinks uit een factuurtekst haalt keek naar
één voorvoegsel: een link op een ander adres glipte erdoor.

## Wat het nu is

### Kiezen bij het inrichten (verplicht)

- Een nieuwe stap **Je webadres**, direct na de bedrijfsgegevens: `<naam>.resofly.com`. Met een
  voorstel uit de handelsnaam ("Studio Lopik B.V." → `studio-lopik`).
- Terwijl je typt, zegt het veld meteen of de vorm klopt (kleine letters, cijfers, streepjes;
  3 tot 40 tekens; geen `--`, dus geen punycode-namen die op een andere naam lijken). Na een
  korte pauze vraagt het de database of de naam **al bestaat**: *"jansen.resofly.com is
  beschikbaar"*, *"Dit adres bestaat al. Kies een andere naam."* of *"Deze naam is niet
  beschikbaar"* (gereserveerd: namen van ResoFly zelf, banken, betaaldiensten, de overheid).
  Zonder vrije naam kun je niet verder.
- De database rondt de inrichting niet af zonder webadres (`complete_organization_onboarding`).
- Wie halverwege de inrichting zat, gaat verder bij de eerste stap die nog open staat (dus bij
  *Je webadres*), niet weer bij Welkom.
- Organisaties van vóór deze wijziging kiezen hun adres bij Instellingen → Domein. Tot dan gaan
  hun links naar het adres van de app, zoals altijd.

### Instellingen → Domein (nieuw tabblad)

- **Je webadres**: het adres, kopiëren, wijzigen. Een oude naam stuurt twaalf maanden door
  (links in verstuurde mails blijven werken) en blijft zo lang van jou: terugnemen kan. Hooguit
  vijf oude namen per jaar.
- **Eigen domein** (met een betaald abonnement, of vrijgesteld): een subdomein van je eigen
  domein, zoals `albums.jansen.nl`, voor de documenten met een link. Twee records (CNAME en
  TXT) met kopieerknoppen, de stappen per domeinbeheerder (TransIP, Versio, Mijndomein,
  Hostnet, Strato, one.com, Cloudflare, overig), een scherm dat zelf meekijkt, en de voortgang
  *Record gevonden → Certificaat klaar → Actief*. Je krijgt een mail als het actief wordt of
  later hapert. Ontkoppelen stuurt nog twaalf maanden door.
- De kaart **Eigen verzenddomein** staat nu ook hier; het tabblad E-mail verwijst ernaar.
- Een teamlid ziet alles, maar alleen de eigenaar of een beheerder wijzigt (de database en de
  functie controleren dat zelf). De boekhouder ziet het tabblad niet.

### Links en adressen

- Elke link bouwt de server uit de organisatie, nooit uit het adres waar een verzoek vandaan
  komt: `_shared/clientLinks.ts`, in `invoice-workflow`, `quote-workflow`, `contract-workflow`,
  `contract-public`, `meeting-booking`, `file-share`, `_shared/fileTransferServer.ts`, `mail`,
  `portal-notify`, `client-portal`, `campaigns` (de afmeldlink) en `portal-login`.
- Pas met `CLIENT_DOMAINS_LIVE=true` gaan links naar het klantadres. Tot de DNS en de Worker er
  staan, verandert er voor klanten niets.
- Documenten met een token mogen op het eigen domein. **Het klantportaal (inloggen en de
  sessie) woont altijd op de naam bij ResoFly**; zie Veiligheid, punt 2.
- Het filter op betaallinks (`withoutPublicLinks`) en de terugkeer na betalen
  (`isAllowedReturnUrl`) werken op elk adres.

### De klantadressen zelf

- De Worker `workers/client-domains` zet de app op `<naam>.resofly.com` en op eigen domeinen:
  de titel, het icoon en de naam van de organisatie, geen manifest en geen service worker,
  nooit in een zoekmachine, geen Referer op een pagina met een token, en de CSP uit de build.
  Alleen klantpaden; de rest geeft 404. Een oude naam stuurt met 301 door. Onbekend, wachtend
  of uitgezet: een neutrale pagina.
- In de app: op een klantadres nooit de werkruimte of het inlogscherm van een teamlid.
- De publieke functies accepteren een actief klantadres als origin, maar een token van een
  andere organisatie bestaat op dat adres niet (dezelfde 404 als een onbekende link).

### Inloggen op het portaal

- De inlogmail komt van ResoFly zelf (`portal-login`): in het Nederlands, met de naam en de
  afzender van de organisatie, een link naar haar adres en een code voor een ander apparaat.
- De link werkt alleen in de browser die hem aanvroeg (een geheim dat de browser bewaart),
  één keer, een kwartier, en na vijf verkeerde browsers is hij op. De browser logt daarna in
  met het token uit de aanvraag (`verifyOtp`); een redirect-URL in Supabase Auth is niet nodig.
- Een oude app zonder geheim krijgt het oude gedrag.

### Logboek

Een gekozen of gewijzigd webadres en elke stap van een eigen domein (gekoppeld, actief, hapert,
ontkoppeld, weggehaald, overgenomen) komen in het Logboek, bij Beheer.

## Veiligheid

Gecontroleerd en getest: `anon` heeft nergens rechten (ook niet op de nieuwe functies), het
boekhouder-hek staat op de drie nieuwe tabellen, schrijven gaat alleen via de RPC's en de
functie, elke schrijfactie filtert op `organization_id`, de geheimen van de Worker en de cron
worden tijdsvast vergeleken, CORS alleen voor een actief klantadres via https zonder poort, en
links komen nooit uit de `Host`- of `Origin`-kop.

Bij de controle gevonden en gerepareerd:

1. **Een vergeten record overnemen.** Het CNAME-record is voor iedereen hetzelfde. Liet een
   organisatie het staan na het weghalen van haar domein, dan kon een andere organisatie de
   hostnaam koppelen en keurde Cloudflare dat goed. Ook wie een hostnaam als eerste aanmeldde,
   won zodra de echte eigenaar zijn CNAME zette. Nu wordt een eigen domein pas actief met het
   TXT-record van díe koppeling (een waarde per aanmelding), ook als Cloudflare al akkoord is.
2. **Het portaal op een eigen domein.** De sessie van een klant staat in de browser, bij het
   adres waar hij inlogde, en geldt bij al zijn leveranciers. De DNS van een eigen domein
   beheert de organisatie zelf: met een andere server erachter kon ze die sessie uitlezen, en
   zien wat de klant bij een andere organisatie heeft. Nu woont het portaal altijd op de naam
   bij ResoFly (`clientPortalBaseUrl`); de Worker en de app sturen `/portal` op een eigen
   domein daarheen, en `portal-login` en `client-portal` geven een eigen domein geen CORS.
3. **Een open redirect** in de Worker: een hernoemd adres stuurde `//evil.example/x` door naar
   een ander domein (`new URL(pad, adres)`). Nu blijft het domein vast.
4. De onthouden klantadressen in de edge functions groeiden onbeperkt bij steeds andere
   `Origin`-koppen; nu hooguit 500.
5. Een bekend e-mailadres kreeg het antwoord op een inlogaanvraag merkbaar later dan een
   onbekend; de inlogmail gaat nu na het antwoord (`EdgeRuntime.waitUntil`).
6. Een organisatie die ResoFly uitzette, kon onder een andere naam verder; nu niet.
7. "Te vaak gewijzigd" gaf een HTTP 500 (`54000`); nu een 400.
8. De logboekregels van een eigen domein haalden het niet (de lijst toegestane handelingen);
   nu met de gebeurtenis in de metadata.

Advies voor de eigenaar: zet in Supabase → Authentication → Email de *Email OTP Expiration* op
900 seconden. Dan geldt de code in de inlogmail even lang als de link (een kwartier).

## Getest

- `npm test`: 1329 tests (nieuw: namen, hostnamen, de stand bij Cloudflare, het TXT-bewijs,
  `clientBaseUrl` en `clientPortalBaseUrl`, de origin-controle, het filter op links, de
  inlogmail, de inlogstroom in de browser, de Worker-logica, het Logboek, het hervatten van de
  inrichting).
- `npm run typecheck`; `deno check` op de lijst uit `frontend-checks.yml` zonder fouten. In
  `invoice-workflow`, `quote-workflow` en `invoice-public` (niet in die lijst) dezelfde fouten
  als vóór deze wijziging, geen nieuwe.
- `npm run test:stromen`: alle scenario's tegen een lokale stack die vanaf nul is opgebouwd
  (`supabase db reset`), met het nieuwe scenario `klantdomein` (79 stappen: kiezen, wijzigen,
  rechten, een eigen domein bij een nagebootste Cloudflare en DNS, de overname van een vergeten
  record, de Worker-opzoeking, links in mails, CORS en tokens per adres, inloggen met de link en
  de code tegen GoTrue, de nachtelijke ronde, een uitgezet adres).
- `npm run test:inrichten` (de nieuwe stap: voorstel, bestaat al, gereserveerd, te kort,
  vastleggen; niet afronden zonder; verder gaan na een update) en `npm run test:loading`.
- `npm run test:mobile -- --theme=both`, met de nieuwe pagina's *settings-domein* en
  *inrichten-webadres*. Daarbij gevonden: op de telefoon rekte de kop van een korte stap op.
- De Worker in workerd (Miniflare, `workers/client-domains/test/worker.mjs`), zonder netwerk.

## Wat er nog moet

Zie `docs/setup/KLANTDOMEINEN_SETUP.md`: de wildcard in de DNS, de Worker met zijn geheim en
routes, Cloudflare for SaaS met een eigen token, de secrets in Supabase, de nachtelijke ronde
(vinkje *setup_webhooks*), en daarna `CLIENT_DOMAINS_LIVE=true`. Niet gebouwd uit fase 3 van het
plan: media onder `/m/` op het klantadres en een voorbeeld met albumcover in WhatsApp.
