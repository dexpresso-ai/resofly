# Vier apps naast elkaar op je telefoon

**12 november 2026**

Je kunt nu ResoFly, Agenda, Financiën en Communicatie elk als eigen app op je
telefoon zetten. Eerder vandaag zei Android bij Agenda, Financiën of Communicatie
"deze app is al geïnstalleerd" als ResoFly zelf er al op stond.

## Wat er misging

Een browser herkent een app aan zijn manifest, en vooral aan de `scope`: het
adres waaronder de app woont. De ResoFly-app had scope `/`, en dat is heel
ResoFly. De losse apps wonen op `/app/agenda/` en zo verder, en dat valt daar
dus onder. Android kijkt bij Installeren of er al een app is waarvan de scope
het adres van de nieuwe app bevat. Dat was zo: de ResoFly-app. Dus zei de
telefoon dat de app er al was.

Op de computer (Chrome, Edge) speelde dit niet. Daar telt alleen het `id`.

## Wat er nu is

- **ResoFly heeft een eigen adres: `/app/werkruimte/`.** Het is dezelfde
  werkruimte als op `/`, met hetzelfde menu en dezelfde tabbladen. Het manifest
  (`public/manifest.webmanifest`) heeft daar nu zijn `scope` en `start_url`.
  Zo staan de vier apps naast elkaar en valt geen ervan binnen een ander.
- **Het `id` blijft `/`.** Zonder `id` rekende de browser het uit de
  `start_url`, en dat was `/`. Door het nu zo vast te zetten blijft een
  ResoFly-app die al op een telefoon of computer staat dezelfde app, en werkt
  hij zich bij naar het nieuwe adres.
- **Instellingen → Apps** heet nu *Apps* en toont ResoFly bovenaan, met Openen
  en Link, net als de andere drie. Onderaan staat wat je doet als je telefoon
  toch "al geïnstalleerd" zegt.
- **De installeerkaart** staat ook in ResoFly op `/app/werkruimte/`, niet op
  `/` in de browser.
- **Volledige werkruimte** (onderaan het menu van een losse app) opent in een
  geïnstalleerde app nu `/app/werkruimte/`. Op Android opent hij dan in de
  ResoFly-app, en niet in Chrome.
- **Inloggen** vanuit de ResoFly-app komt terug op `/app/werkruimte/`, net als
  een losse app terugkomt op zijn eigen adres.
- **Pushmeldingen** voor de werkruimte (`/?chat=…`, `/?agent=…`): een venster op
  `/app/werkruimte/` telt als werkruimte. De melding gaat daar naar het eigen
  adres van dat venster, want `/` valt buiten de app. Is er geen venster open,
  dan opent hij op `/app/werkruimte/`. Op Android komt hij dan in de
  ResoFly-app terecht.

## Wat je moet doen als ResoFly al op je telefoon staat

Een oude ResoFly-app werkt zich vanzelf bij naar het nieuwe adres. Android doet
dat alleen niet meteen, maar ergens in de dagen nadat je de app opent. Zolang
de oude app er nog staat, blijft de telefoon "al geïnstalleerd" zeggen. Wil je
de andere apps nu meteen:

1. Verwijder de ResoFly-app van je telefoon.
2. Ga in de browser naar **Instellingen → Apps**, kies bij **ResoFly** op
   **Openen** en installeer hem opnieuw.
3. Doe hetzelfde bij Agenda, Financiën en Communicatie.

Op de iPhone speelde dit niet: daar kun je met *Zet op beginscherm* altijd meer
apps van dezelfde site neerzetten.

## Wat er hetzelfde blijft

- `/` in de browser werkt zoals altijd. Wie ResoFly niet installeert, merkt
  niets.
- Rechten, het laden en de pagina's zijn niet veranderd.

## Gevolg

Een link naar `/` (bijvoorbeeld in een mail van ResoFly) opent op Android nu in
Chrome en niet meer in de ResoFly-app. De app woont niet meer op `/`. Zo kan het
alleen: zolang een app `/` claimt, kan er op Android geen tweede app van
ResoFly naast. Ingelogd ben je in Chrome wel, want op Android delen app en
browser hun opslag.

## Getest

- `npm run typecheck`, `npm test` (1689 tests). Nieuw in
  `src/lib/standaloneApps.test.ts`:
  - geen enkele app valt binnen de scope van een andere, en alle id's
    verschillen;
  - het manifest van de werkruimte houdt `id` `/`;
  - `/app/werkruimte/` is de hele werkruimte en geen losse app;
  - Instellingen → Apps toont ResoFly altijd;
  - de service worker kent elke losse app.

  Tegen het oude manifest (scope `/`) faalt de test voor de scopes.
- `npm run test:mobile -- --theme=both`, met twee nieuwe pagina's:
  `settings-apps` en `app-werkruimte`.
- In Chromium, na een build: op `/`, `/app/werkruimte/` en de drie losse apps
  linkt elke pagina het goede manifest met zijn eigen scope. Chrome meldt geen
  bezwaren tegen installeren, en er zijn geen fouten in de console.
  `/app/werkruimte` zonder slash wordt `/app/werkruimte/`.
- Niet getest op een echte Android-telefoon; dat kan hier niet. Dat Android
  naar de scope kijkt, volgt uit hoe Chrome op Android een geïnstalleerde app
  herkent (aan de adressen die de app afvangt), en past bij wat je zag.
