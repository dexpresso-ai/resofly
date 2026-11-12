# Klantportaal: het logo van de gebruiker, en onderaan ResoFly — 12 november 2026

Vraag: *"Zorg ervoor dat het klantportaal van de klanten van de Resofly gebruikers, wordt
uitgebreid met het logo van de gebruiker. Onderaan de pagina staat wel dat het platform
beschikbaar wordt gesteld door Resofly."*

## Hoe het was

Het logo uit *Instellingen → Huisstijl* stond al in het portaal, maar:

- **klein**: 38 pixels hoog in de kop, op de telefoon 30. In een breed woordmerk was de naam
  amper te lezen.
- **vaak onzichtbaar**: een logo met donkere letters naast een gekleurd beeldmerk viel weg op de
  donkere kop. De regel voor een licht plaatje achter het logo keek alleen naar de gemiddelde
  kleur. Zo'n logo is gemiddeld middelgrijs en haalde daarmee net het contrast. Er kwam dus geen
  plaatje, en op de kop stond alleen nog het beeldmerk.
- **op de telefoon gedrongen**: naast het logo stond de naam en het e-mailadres van de klant,
  afgekapt tot "Joo…". Die regel drukte het logo nog kleiner.

Onderaan stond *Geleverd via ResoFly*. Wie in de huisstijl "Geleverd via ResoFly verbergen"
aanzette, haalde die regel ook uit het portaal. De klant zag dan nergens op wiens platform hij
inlogde.

## Wat de klant nu ziet

- **Het logo groot in de kop van het portaal**: 48 pixels hoog (tot 280 breed), op de telefoon
  36 (tot 180 breed). Op de telefoon valt de regel met naam en e-mailadres weg als er een logo
  is. Komt er een dossierkeuze in de kopbalk, dan wordt het logo kleiner in plaats van de balk
  uit beeld te duwen.
- **Het logo groot op de inlogkaart**: 48 pixels, op de telefoon 42.
- **Het logo blijft leesbaar.** Valt meer dan 30% van het logo weg op de kop (contrast onder
  1,6 : 1), dan krijgt het een plaatje. Het plaatje is licht of donker, afhankelijk van waarop
  het minst wegvalt. Helpt geen enkel plaatje, dan blijft het weg. Een voorbeeld: een witte naam
  naast een donkerblauw beeldmerk. Op de kop valt het beeldmerk weg, op een wit plaatje de naam.
  De oude regel (gemiddelde kleur onder 2,6 : 1) blijft gelden.
- **Onderaan elk portaalscherm** (overzicht, alle tabbladen, het inlogscherm, de pagina van de
  inloglink, het voorbeeld bij Huisstijl) staat nu altijd:

  > *R* Dit platform wordt beschikbaar gesteld door **ResoFly**

  Met het R-merk van ResoFly ervoor. De eigen afsluitzin van de gebruiker staat er nog boven. Ook
  het algemene `/portal` zonder huisstijl heeft de regel.

## Wat de gebruiker ziet

- In *Instellingen → Huisstijl* heet de schakelaar nu *"Geleverd via ResoFly" verbergen onder je
  offertes, facturen, contracten, boekingen en galerijen*. Daaronder staat: in het klantportaal
  blijft altijd staan dat het platform beschikbaar wordt gesteld door ResoFly.
- De schakelaar doet buiten het portaal wat hij deed. Er verandert niets aan de database.
- De beschrijving voor Gerrie, MCP en de API (`branding.save`) zegt hetzelfde.
- Het voorbeeld van de kop en de inlogkaart bij Huisstijl gebruikt de nieuwe regel voor het
  plaatje. Wat je daar ziet, krijgt de klant.

## Techniek

- `src/lib/logoColors.ts`: `summarizeLogoPixels` geeft naast de gemiddelde kleur nu ook
  `luminance`. Dat is de helderheid van het zichtbare logo in twintig gelijke delen, van donker
  naar licht.
- `src/lib/branding.ts`:
  - nieuw: `logoLostShare(luminance, achtergrond)`, het deel dat wegvalt;
  - `logoNeedsPlate` en `logoPlate` nemen de telling mee. Zonder telling werken ze zoals eerst.
- `src/components/PublicBrand.tsx`: `useLogoInk` meet en onthoudt de telling per logo. Daardoor
  geldt de nieuwe regel ook op de kop van de publieke offerte-, factuur- en contractpagina en in
  de galerij.
- `src/features/portal/ClientPortal.tsx`: `PortalFooter` toont de regel over ResoFly altijd. De
  kop krijgt `has-logo` als er een logo is.
- CSS: `src/styles/portal-cockpit.css` (maten van het logo), `src/styles/globals.css` (de
  voetregel; onder elkaar, met het merk in de zin, zodat hij op de smalle inlogkaart netjes
  afbreekt).

## Getest

- `npm run typecheck` en `npm test`: 1694 tests groen. Nieuw in `src/lib/branding.test.ts`:
  - de telling in twintig delen;
  - donkere letters met een fel beeldmerk krijgen een licht plaatje (en kregen dat op de
    gemiddelde kleur alleen niet);
  - een logo dat overal leest, krijgt niets;
  - een plaatje dat niet helpt, komt er niet;
  - zonder telling werkt de oude regel.
- `npm run test:mobile -- --theme=both` op alle portaalpagina's, Huisstijl, de inrichting, de
  offerte en de galerij: geen problemen. Nieuw in `tests/mobile/run.mjs`:
  - pagina `portal-logo` en `portal-login-logo`: het portaal en de inlogkaart met een testlogo
    (Bakkerij Bloem, donkere letters naast een groen beeldmerk);
  - `mustShow`: wat er op een pagina moet staan. Het portaal faalt nu als de regel over ResoFly
    onderaan ontbreekt, of als het testlogo niet op een licht plaatje staat.

  Tegen de oude code faalden die controles alle drie, zoals bedoeld.
- `deno check` kon hier niet draaien (esm.sh is vanuit de cloudsessie niet bereikbaar). In de
  edge functions is alleen een beschrijvingstekst veranderd. De workflow controleert het na de
  push.
