# Galerij: de weergave van het album (2026-11-04)

## Aanleiding

Een galerij had zestien openingen, maar daaronder zag elk album er hetzelfde uit:
rijen die de breedte vullen, 6 px tussenruimte, afgeronde hoeken. Een bruiloft
vraagt om lucht en rust, een modeshoot om een strak raster, een moodboard om iets
speels. De beeldmaker kon daar niets aan kiezen.

Bij het kritisch doorlopen van de galerij-opties kwamen nog drie dingen boven:

- **De gekozen achtergrondkleur kwam op de deellink nooit aan.** De regel die de
  galerijkleur zet, stond in `globals.css` vóór de basisregel van de pagina. Bij
  gelijke specificiteit wint de latere, dus de deellink bleef in de kleuren van
  het donkere thema. In het klantportaal deed de achtergrond het wel, maar chips,
  tegels en sectietitels hielden daar óók de themakleuren. Bij een lichte galerij
  gaf dat een donkere band achter de chips en donkere titels op donker.
- **Een losse staande foto aan het eind van een album** werd over de volle breedte
  opgeblazen: bij 1200 px breed een foto van 1800 px hoog.
- **Er was geen manier om zelf te bepalen welke foto's de aandacht krijgen.**

## Wat er is veranderd

### Instellingen → Weergave (nieuw tabblad, naast Opening)

"Opening" blijft de kop van de pagina (sjabloon, coverbeeld, uitsnede). "Weergave"
gaat over alles daaronder. Links de knoppen, rechts een **levend voorbeeld** met de
eigen foto's van de galerij, in de huisstijl van de klantpagina (achtergrond,
letters, merkkleur), met de knoppen **Computer, Tablet en Telefoon**. Het voorbeeld
draait op dezelfde component en dezelfde rekenregels als de galerij bij de klant:
wat je ziet, is wat de klant krijgt. Wijzigingen zijn een concept tot *Opslaan*; het
tabblad krijgt een puntje zolang er iets niet is opgeslagen.

- **Stijl** — een complete weergave in één klik, daarna nog vrij bij te stellen:
  *Standaard* (de weergave van vóór vandaag), *Naadloos*, *Galerie* (strak raster met
  passe-partout en veel wit), *Tijdschrift*, *Moodboard*, *Lichttafel* en *Ritme*.
  Een stijl laat de video-instellingen staan. Wie verder schuift, ziet "Eigen
  combinatie".
- **Indeling van de foto's**
  - *Rijen* — elke foto heel, de rijen vullen precies de breedte (de oude weergave).
  - *Waterval* — kolommen waarin elke foto haar eigen verhouding houdt.
  - *Raster* — gelijke tegels in één vorm: vierkant, staand (4:5) of liggend (3:2).
  - *Verhaal* — één tot drie beelden per regel, gekozen op hun vorm: liggend breed en
    alleen, staand in paren, af en toe een drieluik. Ruim wit tussen de regels.
  - *Afdrukken* — foto's als afdrukken met een witte rand op een lichttafel; liggend
    en staand met dezelfde lange zijde, zoals echte 10×15-afdrukken.
- **Kolommen** — op een breed scherm 1 tot 8 of automatisch; bij Rijen is dat het
  aantal foto's per rij, bij benadering. Op een tablet naar verhouding minder, op een
  telefoon apart in te stellen (1, 2 of 3).
- **Witruimte**
  - tussen de beelden: 0 tot 64 px, met *Naadloos*, *Smal*, *Ruim* en *Royaal* als
    snelkeuze. Op een telefoon krimpt royale ruimte mee (32 px wordt 16 px); tot 8 px
    blijft hij zoals hij was.
  - breedte van het album: volle breedte, breed (1680), gemiddeld (1240) of smal
    (940). De opening blijft op volle breedte; een opening van alleen tekst lijnt uit
    met het album.
  - tussen de hoofdstukken (categorieën): compact, normaal, ruim, royaal.
- **Speelsheid** — strak, levendig, speels, uitbundig. Per indeling iets anders, en
  bij elke stand staat in één zin wat hij doet:
  - Rijen: de streefhoogte wisselt per rij, dus soms een rij met minder en grotere foto's.
  - Waterval: verspringende kolommen en af en toe een liggende foto over twee kolommen.
  - Raster: tegels van 2×2 en 2×1, alleen op plekken waar ze geen gat laten.
  - Verhaal: staande foto's wisselen van kant, paren verspringen, liggende foto's
    worden soms smaller.
  - Afdrukken: draaiing tot 4,6° en verschuiving; uitbundig met polaroidrand.
- **Afwerking** — hoeken (recht, subtiel, zacht, rond), lijst (geen, passe-partout,
  fijne lijn, zwevend), onder de muis (inzoomen, optillen, niets), hoofdstuktitels
  (klein label, grote titel, genummerd: *01 Ceremonie*) en "foto's komen zacht binnen
  tijdens het scrollen" (alleen als het apparaat niet om minder beweging vraagt).
- **Video's** — rijen of raster (of automatisch, zoals voorheen) en de tegelgrootte.

### Groot tonen

Een nieuwe knop op elke foto in de beheerweergave (het pijltjesknopje naast de
cover-ster). Een uitgelichte foto krijgt in elke indeling een grote plek: een eigen
rij, een tegel van 2×2, twee of drie kolommen breed, een volle regel in een verhaal,
een dubbele afdruk. In de beheerweergave staat er een merkje op; de klant ziet het
aan de maat. Speelsheid kiest zelf een ritme; *Groot tonen* is wat de beeldmaker
zelf aanwijst, en dat geldt ook bij een strak album.

### Onder de motorkap

- **`src/lib/galleryLayout.ts`** — de instellingen: standaardwaarden, herstel
  (`normalizeGalleryLayout`), strenge controle met foutmeldingen per veld, de stijlen
  en de woorden. Geen imports, dus hij draait in browser, node en Deno. Een kopie
  staat in `supabase/functions/_shared/galleryLayout.ts`; de test vergelijkt de twee.
- **`src/lib/galleryLayoutEngine.ts`** — de rekenregels. Per indeling één pure functie
  die bij een breedte de plek en maat van elke foto uitrekent, op hele pixels (via de
  randen, zodat er bij 0 px nooit een haarlijn tussen twee foto's valt). Speelsheid is
  deterministisch, met een hash van het item-id: iedere kijker ziet hetzelfde album en
  niets verspringt bij het opnieuw tekenen. De tegels staan in het document in de
  volgorde van de fotograaf (Tab, schermlezer), ook waar een grote tegel visueel een
  plekje opschuift.
- **Standaard = de oude weergave.** De test rekent de oude code (letterlijk
  overgenomen) en de nieuwe naast elkaar uit, op vier breedtes en zes albumgroottes,
  ook in grootbeeld: dezelfde foto's per rij, dezelfde rijhoogte op de pixel. Twee
  bewuste afwijkingen: een losse staande foto aan het eind wordt begrensd en in het
  midden gezet, en een opening van alleen tekst lijnt uit met het album.
- **Twee uitgelichte foto's vlak na elkaar** zouden in Rijen losse stukjes rij
  achterlaten die de breedte niet vullen. Een uitgelichte foto wacht dan tot de rij
  vol is en komt direct daaronder.
- **`GalleryViewer`** zet de tegels absoluut neer uit het plan van de rekenregels
  (`PhotoLayout`); hoeken, lijst, video's en de ruimte tussen hoofdstukken gaan als
  CSS-variabelen op de buitenste laag. Selecteren, slepen om te herschikken,
  grootbeeld en de diavoorstelling werken in alle indelingen.
- **Binnenkomen bij het scrollen** loopt via een data-attribuut dat buiten React om
  wordt gezet en een CSS-animatie met `backwards`: zo wordt een foto die al in beeld
  was niet weer verborgen bij een herteken, en vertraagt de animatie het optillen
  onder de muis niet.

### Database

`supabase/migrations/20261104075000_gallery_layout.sql`

- **`galleries.layout`** (jsonb, standaard `{}` = de standaardweergave). Bestaande
  galerijen veranderen dus niet.
- **Trigger `galleries_layout_guard`** — alleen bekende instellingen met geldige
  waarden, met een melding per veld ("De weergave van de galerij verwacht voor "gap"
  een heel getal van 0 tot en met 64."). De keuzelijsten staan tussen twee
  markeringen in de migratie; `galleryLayout.test.ts` leest ze en vergelijkt ze met de
  app. Plus een check dat de waarde een object is.
- **`gallery_items.featured`** (boolean, standaard uit) — groot tonen.
- Geen nieuwe rechten: beide kolommen vallen onder de bestaande RLS en modulegate.

### Klantportaal en deellink

`client-portal` en `gallery-public` geven de weergave mee, opnieuw opgebouwd uit de
vaste lijst sleutels en waarden (`normalizeGalleryLayout`), plus `featured` per item
als ja/nee. Wat er ook in de database staat: er gaat niets anders naar buiten.

### Gerrie en gekoppelde AI

- **`gallery.update_settings`** kent `layout_preset`, `layout_style`, `layout_columns`
  (0 = automatisch), `layout_gap`, `layout_playfulness` en `layout_width`. Eerst de
  stijl, dan de losse velden, bovenop de huidige weergave ("Lichttafel, maar met drie
  kolommen"). De kaart zegt het in woorden: *weergave: afdrukken · 3 kolommen · 40 px
  tussenruimte · speels*. Zonder layout_-velden wordt de kolom niet eens gelezen.
- **Nieuw: `gallery.set_featured`** — groot tonen aan of uit voor een reeks foto's;
  weigert video's en foto's uit een andere galerij.
- **`gallery.list_items`** toont per bestand `featured` en de weergave in woorden.

### De frontend loopt vóór op de migratie

Cloudflare Pages rolt de app uit vóórdat de migratie draait. In dat gaatje:

- tekent elke galerij de standaardweergave (`layout` ontbreekt → standaard);
- slaat *Opslaan* de overige instellingen gewoon op en meldt het eerlijk als de
  weergave er nog niet bij kon (`updateGallerySettings` + `isMissingColumn`). De
  weergave gaat alleen mee als hij veranderd is, dus een titel wijzigen werkt altijd;
- meldt *Groot tonen* dat het kan zodra de database is bijgewerkt, en zet de foto terug.

## Gevonden en hersteld

- **De achtergrond van de galerij** werkt nu op de deellink, en het palet dat erbij
  hoort (tekst, chips, tegels, randen, sectietitels) in portaal én deellink. Het blok
  "Achtergrond van de galerij" staat nu ná de basisregels. Elke regel heeft als
  terugval exact de waarde van de basisregel, dus in de app (zonder huisstijl)
  verandert niets; op de standaard donkere galerij is het verschil alleen de
  achtergrondtint (#0F0F11 → de gekozen #0B0B0B) en de grijstinten van de tekst.
  Gecontroleerd met een pixelvergelijking: de foto's zijn identiek.

## Getest

- `npm run typecheck`, `npm run build` en `npm test`: **915 tests**, waarvan 37 nieuw
  (`galleryLayout.test.ts`, `galleryLayoutEngine.test.ts`,
  `supabase/functions/_shared/galleryLayoutAction.test.ts`): de oude en de nieuwe
  rijen naast elkaar, geen overlap, alles binnen de breedte, de tussenruimte op de
  pixel, raster zonder gaten, uitgelichte foto's, afdrukken deterministisch, app en
  server gelijk, de databasetrigger gelijk aan de app, en 3000 foto's per indeling
  binnen 400 ms.
- De migratie tegen een lokale PostgreSQL 16: twee keer achter elkaar (herhaalbaar),
  vijftien foute invoeren geweigerd met de juiste melding, grenswaarden toegestaan,
  `null` wordt `{}`.
- De migratie tegen de staging-database zelf, vóór de uitrol, in één `DO`-blok dat
  altijd eindigt met een exceptie (dus gegarandeerd teruggedraaid, met een
  lock-timeout van 5 s): de zeven bestaande galerijen krijgen `{}`, een volledige
  weergave gaat langs alle bestaande triggers van `galleries`, zes foute invoeren
  worden geweigerd, `featured` werkt. Daarna bestonden de kolommen niet.
- `npm run test:mobile -- --theme=both`: 288 pagina's, 0 met problemen.
- Visueel, tegen de nagebootste backend uit `tests/mobile/mock` met dertig
  genummerde testbeelden in wisselende verhoudingen: dertien scenario's (alle stijlen,
  uitgelichte foto's, hybride met video's, een lichte galerij) op computer en
  telefoon. Geen horizontale overloop, geen tegel buiten het album, geen
  JavaScript-fouten.
- De beheerweergave in de app, van begin tot eind: het merkje op een uitgelichte foto,
  *Groot tonen* schrijft `featured: true`, Instellingen → Weergave → *Lichttafel* →
  voorbeeld op telefoon → 3 kolommen en 40 px → "Nog niet opgeslagen" → *Opslaan*
  stuurt één keer de volledige weergave en sluit het venster.
- Deno: `_shared/galleryLayout.ts` komt schoon door `deno check`. De volledige
  `gallery-public` kon hier niet worden gecontroleerd (deno.land en esm.sh zijn in
  deze omgeving niet bereikbaar); dat doet de CI-job *edge-functions*.

## Uitrollen

Push naar `staging`: Cloudflare Pages bouwt de app, en *Deploy Supabase (staging)*
past de migratie toe en rolt de edge functions uit (`client-portal`, `gallery-public`,
en via `_shared/actions` ook Gerrie en de MCP-connector). Geen nieuwe secrets, geen
cron-taken, geen wijziging aan de media-worker of de CSP.

**Let op het versienummer.** Deze migratie is twee keer verhuisd, en dat zegt iets
over werken naast een andere sessie die dezelfde dag migraties uitrolt:

1. Eerst `20261104050000_…`. Dat nummer had `20261104050000_vpb_carry_back.sql` al,
   en die was op staging al toegepast. De CLI kijkt alleen naar het nummer: deze
   migratie was dan als "al gedaan" overgeslagen, zonder foutmelding, en de kolommen
   hadden nooit bestaan.
2. Daarna `20261104070000_…` — en terwijl dit werk klaarstond, rolde die andere
   sessie `20261104070000_ib_prive_vennoten.sql` uit. Precies hetzelfde gat.
3. Nu `20261104075000_gallery_layout.sql`: na de laatste op staging (`…070000`), en
   níét het volgende ronde nummer van die reeks (`…080000`), zodat die gewoon kan
   doorlopen.

Vóór de push is de lijst toegepaste migraties op staging opgevraagd (Management API:
231, laatste `20261104070000`). Wie na deze uitrol een migratie maakt: kies een
nummer na `20261104076000`.

**De rooktest na de eerste uitrol (run 168) was rood.** Migratie en edge functions
waren gelukt, maar de controle op de publieke sleutel vond: *"anon heeft weer
rechten op: functie enforce_gallery_layout_guard()"*. Postgres geeft elke nieuwe
functie EXECUTE via PUBLIC; de default privileges uit `20261101000000` halen alleen
de directe grant aan anon weg. De bestaande test (`migrationGrants.test.ts`) keek
alleen naar security-definer-functies, en een triggerfunctie is dat niet.

- `20261104076000_gallery_layout_guard_grants.sql` zet de functie dicht voor
  `public, anon, authenticated`, zoals de andere triggerfuncties
  (`20261104030000`). Een trigger vuurt ongeacht EXECUTE-rechten; lokaal
  nagelopen als `authenticated`: een geldige weergave wordt bewaard, een foute
  geweigerd.
- `migrationGrants.test.ts` controleert vanaf `20261104075000` élke nieuwe functie,
  ook triggerfuncties, op die revoke (in hetzelfde bestand of later). Zonder de
  vervolgmigratie faalt die test; zo valt het voortaan vóór de uitrol op.

## Bewust niet gedaan

- **Een weergave per categorie.** Eén album, één weergave; per hoofdstuk een andere
  indeling kan later als een veld op `gallery_categories`.
- **Bijschriften onder foto's.** Er is geen veld voor een bijschrift, en
  bestandsnamen ("DSC_0412.jpg") horen niet onder een foto.
- **Video's in de indeling van de foto's.** Video's houden hun eigen rijen of raster,
  met hun eigen tegelgrootte.
