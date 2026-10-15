# Changelog — Huisstijl in het klantportaal, met live voorbeeld — 2026-10-15

## Aanleiding

> Via instellingen van de gebruiker kunnen we branding kleuren instellen. Deze branding kleuren
> dienen ook overeen te komen met de look en feel van de klantenpagina. De klantenpagina dient als
> voorbeeld ook in te zien zijn hoe dat dan op de klantpagina te zien is.

Eerst kwam er een voorstel (`DESIGN_VOORSTEL_HUISSTIJL_PORTAAL_2026-10-15.md`), daarna de keuzes:

| vraag | keuze |
|---|---|
| Een kopkleur als tweede kleur? | Ja, met *Automatisch* als standaard |
| De kerncijfers bovenin het portaal? | Ja, als glazen tegels |
| Een donker logo op een donkere kop? | Vanzelf een licht plaatje, plus een optioneel veld voor een lichte versie van het logo |
| De losse offerte-, factuur- en contractpagina's meteen mee? | Ja |
| Kleuren uit het logo voorstellen? | Ja |

Wat er misging: het portaal had de opbouw van de werkruimte niet (omlijnde tabknoppen en tegels,
kaarten zonder kop), het merkteken zonder logo bleef goud bij elk merk, en in Instellingen stonden
twee nagebouwde voorbeeldkaartjes die al uit de pas liepen met het echte portaal.

## Wat er is veranderd

### Twee merkkleuren: merkkleur en kopkleur

- **Merkkleur** (zoals voorheen): hoofdknoppen, het gekozen tabblad, de stip bij iets nieuws,
  links, bedragen en de focusrand. De hoofdknop heeft nu een verloop uit de merkkleur
  (`--accent-face`), net als de knoppen in de werkruimte.
- **Kopkleur** (nieuw): het vlak bovenin het klantportaal en de publieke offerte-, factuur- en
  contractpagina, en de grond achter het inlogscherm.
  - *Automatisch* (de standaard, en wat iedereen nu krijgt): diep grafiet in de tint van de
    merkkleur, zoals de werkruimte. Een grijs merk krijgt grijs grafiet.
  - *Eigen kleur*: de kleur staat er letterlijk. Alleen als er op die kleur geen tekst goed
    genoeg leest (een middengrijs bijvoorbeeld), schuift de kop in helderheid op tot dat wel zo
    is; de tint blijft die van jou. Instellingen laat dan zien welke kleur het werd.
- **Wat op de kop staat, leest altijd.** Tekst wordt vanzelf licht of donker, en de merkkleur op
  de kop (de naam in de groet, het gekozen tabblad) schuift in helderheid als hij te weinig
  afsteekt. Getest over 16 merkkleuren × 15 kopkleuren, op elk vlak van de kop: tekst, gedempte
  tekst en merkkleur halen overal minstens 4,5 : 1.
- Alles komt uit `brandThemeVars()` als `--hdr-*`-tokens (verloop, tekst, merkkleur, glas,
  gloed, ringen, tellers), dus portaal, publieke pagina's en het voorbeeld rekenen hetzelfde uit.

### Het klantportaal in de opbouw van de werkruimte

- **Een kop in de kopkleur** met het merk van de leverancier en de knoppen, de datum, een groet
  met de voornaam van de klant (*Goedemiddag, Joost*) en één zin over wat er openstaat
  (*Er staat 1 factuur open, er is 1 nieuw antwoord op je ticket en je hebt 1 nieuw bericht.*).
- **De vier kerncijfers als glazen tegels** in de kop: *Openstaand*, *Vervallen*, *Open
  tickets* en *Lopende projecten*, met de centen klein achter het bedrag. Alleen op het
  overzicht; op de andere tabbladen blijft de kop laag.
- **De tabbladen staan in de kop**, onderstreept in de merkkleur. Een geopende factuur of
  offerte staat op het werkvlak onder dezelfde kop, met het bijbehorende tabblad aan.
- **Het werkvlak** (Licht of Donker, zoals voorheen) zweeft eronder met kaarten met een kop.
- **Het merkteken zonder logo** is een tegel in de merkkleur met de initiaal, niet meer goud.
- **Inloggen** staat op de grond van de kopkleur, met het merk erboven.

### Het logo op de kop

- Het logo wordt bij het laden gemeten (gemiddelde kleur van de niet-doorzichtige pixels). Valt
  het weg op de kop — een donker logo op een donkere kop — dan staat het op een licht plaatje.
  Een wit logo op een lichte kaart krijgt een donker plaatje.
- **Logo voor op donker** (optioneel, nieuw veld): een lichte versie van het logo. Die staat op
  elk donker vlak, zonder plaatje.
- Tot het meten klaar is (een paar milliseconden) staat het logo onzichtbaar op zijn plek, zodat
  er geen plaatje bij komt springen.

### De publieke offerte-, factuur- en contractpagina

Dezelfde kop als het portaal (`PublicDocHero`): het merk, *Offerte van Studio Noord*, de titel,
de status en de kern als glazen tegels — bij een offerte het totaal, geldig tot, de datum en voor
wie; bij een factuur het bedrag, de vervaldatum (rood als hij verlopen is), de factuurdatum en
voor wie; bij een contract ondertekenen vóór, de datum en van wie. Daaronder hetzelfde werkvlak
als het portaal. Laden, een verlopen link en *niet gevonden* staan op dezelfde grond, zonder kop.
Wat de pagina's doen (akkoord geven, betalen, ondertekenen, downloaden) is niet veranderd.

### Instellingen → Huisstijl: de instellingen met het portaal ernaast

- **Links de instellingen, rechts het échte klantportaal** in een iframe, dat meekleurt terwijl
  je kiest — ook vóór *Opslaan*. Je klanten zien het pas na Opslaan; dat staat er ook bij.
  - Schermen: *Overzicht*, *Factuur* en *Inloggen*; toestel: *Desktop* (1100px breed) of
    *Telefoon* (390px, in een telefoonrand); en *Volledig scherm* (Esc sluit).
  - Het voorbeeld blijft staan terwijl je door de instellingen scrolt. Heeft de pagina minder
    dan 960px ruimte (telefoon, tablet, een smal laptopscherm met de zijbalk uitgeklapt), dan
    staat het eronder. Dat beslist de ruimte die er is, niet de schermbreedte.
- **Kopkleur**: *Automatisch* of *Eigen kleur*. Wie even terug op Automatisch zet en weer op
  Eigen kleur, krijgt zijn kleur terug; de eerste keer stellen we een donkere kleur in de tint van
  de merkkleur voor (bij koraal `#E4572E` een diep roodbruin, `#4C1E10`).
- **Uit je logo**: onder de merkkleur (en de kopkleur, als die op Eigen kleur staat) staan de
  kleuren die in het logo zitten als knopjes. Eén tik en het is je merkkleur.
- **Werkvlak** Donker of Licht, met per keuze een miniatuur van het portaal in precies de tokens
  die het krijgt.
- **Leesbaarheid**: vijf regels die meerekenen terwijl je kiest — tekst op je knoppen, je
  merkkleur als tekst, tekst op de kop, je merkkleur op de kop en het logo op de kop — met de
  contrastverhouding erbij. Een ↻ betekent dat we een kleur hebben bijgesteld, en naar welke.
- De oude nagebouwde voorbeeldkaartjes zijn weg. Het galerijvoorbeeld blijft (de galerij heeft
  een eigen achtergrond), net als de afsluiting en *Geleverd via ResoFly verbergen*; dat vinkje
  staat nu naast zijn tekst in plaats van erboven.

### Het voorbeeld zelf: `/portal/voorbeeld`

- Dezelfde componenten en CSS als het echte portaal, op een nagebootste backend
  (`demoPortalBackend`) met verzonnen gegevens: Bakkerij De Korenaar, twee facturen, een
  offerte, een contract, twee tickets en twee gesprekken. Er wordt niets opgehaald, verstuurd,
  betaald of opgeslagen; een knop die dat zou doen, zegt dat het een voorbeeld is.
- De huisstijl komt per `postMessage` van de instellingenpagina. Beide kanten controleren de
  origin én het venster (alleen de eigen app, alleen het venster eromheen), en wat binnenkomt
  wordt gekeurd alsof het van buiten komt: alleen hexkleuren, lettertypen uit de vaste lijst,
  ingesloten rasterlogo's en tekst met een maximale lengte.
- Alleen deze route mag door de eigen origin worden ingelijst (`frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN`); overal anders blijft het `'none'` en `DENY`. In
  `public/_headers` koppelt het blok `/portal/voorbeeld` de CSP en X-Frame-Options van `/*` los
  (`! …`) en zet het eigen versies. `scripts/check-csp-hash.mjs` controleert nu dat de
  scripthash in élke CSP-regel staat.
- Los geopend toont de pagina een voorbeeldleverancier met een regel erboven dat het een
  voorbeeld is. Het voorbeeld gebruikt niets van een echt portaal op hetzelfde apparaat: geen
  deeplink uit een meldingsmail, geen onthouden huisstijl en geen sessie; *Uitloggen* doet er
  niets.

### Ook opgelost

- **De gekozen chip in de galerij** gebruikte de accenttekst van de werkruimte; op de donkere
  galerij leverde dat 2,3 : 1 op. `brandStyle()` rekent nu `--gal-accent-ink` uit tegen de
  achtergrond van de galerij zelf (gekozen chip, diavoorstelling, pin-icoon en het voorbeeld in
  Instellingen).
- **De contractpagina had geen afsluiting.** `PublicBrandFooter` werd er wel geïmporteerd maar
  nooit getoond; nu staat de afsluiting (en *Geleverd via ResoFly*, tenzij uitgezet) er net als
  onder de offerte en de factuur.
- **Wat in de kop staat, staat niet ook nog in een kaart.** De kaarten *Offertegegevens*,
  *Factuurgegevens* en *In het kort* herhaalden de kern; die staat nu in de kop. *Contact* staat
  naast *Goedkeuring*, en *Gekoppelde offerte* bij de betaalgegevens van de factuur.

## Gegevens en uitrol

### Migratie `20261015000000_brand_header_color.sql`

- `company_settings.brand_header_color` — hexcode, of leeg voor *Automatisch*.
- `company_settings.brand_logo_dark_data_url` — PNG/JPEG/WebP als data-URL, net als het logo.
- Beide met een check-constraint, en beide gaan mee naar een nieuwe sub-organisatie
  (`create_child_organization`, volledig overgenomen uit 20260821000000 met deze twee kolommen
  erbij; daarna weer `revoke … from public, anon` en `grant execute … to authenticated`).

### Wat blijft werken zolang de migratie nog niet gedraaid heeft

- De edge functions (`client-portal`, `quote-public`, `contract-public`, `gallery-public`,
  `file-share-public`, `file-transfer-public` en de meldingsmails van `portal-notify`) lezen de
  huisstijl opnieuw zonder de twee nieuwe kolommen als die nog niet bestaan; de kop staat dan op
  Automatisch. `invoice-public` haalt de hele rij op en heeft geen terugval nodig.
- Opslaan in Instellingen slaat alles op behalve de twee nieuwe velden. Alleen wie die echt
  invulde, krijgt te horen dat dat in deze omgeving nog niet kan.
- Gerrie, MCP en de API (`branding.get` / `branding.save`) kennen de kopkleur ook
  (`"automatisch"` zet hem terug); `branding.get` leest zonder de nieuwe kolommen als ze er nog
  niet zijn.

### Uitrol

1. `supabase db push` (de migratie).
2. Edge functions uitrollen: alles wat `_shared/branding.ts` of `_shared/actions/admin.ts`
   gebruikt, dus in de praktijk alle functies (`supabase functions deploy`, zoals de
   staging-workflow doet).
3. De frontend met `public/_headers`.
4. Op staging kort nalopen: Instellingen → Huisstijl toont het portaal rechts (niet *Het voorbeeld
   kon niet worden geladen* na tien seconden), en
   `curl -sI https://<staging>/portal/voorbeeld` geeft één `Content-Security-Policy` met
   `frame-ancestors 'self'` en `X-Frame-Options: SAMEORIGIN`; `/portal` en `/` houden
   `frame-ancestors 'none'` en `DENY`. Lokaal is dat al nagerekend met Cloudflare's eigen
   runtime (zie Getest); dit is de laatste controle op het echte platform.

## Waar het staat

| bestand | wat |
|---|---|
| `supabase/migrations/20261015000000_brand_header_color.sql` | de twee kolommen, checks, `create_child_organization` |
| `supabase/functions/_shared/branding.ts` | `headerColor` en `logoDarkDataUrl` in de huisstijl, gekeurd; `withoutNewestBrandingColumns()` voor de terugval zonder migratie |
| `supabase/functions/client-portal/index.ts`, `file-share-public/`, `file-transfer-public/` | terugval zonder de nieuwe kolommen |
| `supabase/functions/_shared/actions/admin.ts` | kopkleur in `branding.get` en `branding.save` |
| `src/lib/branding.ts` | `headerTheme()`, de `--hdr-*`-tokens, `accentFace()`, `logoPlate()`, `contrastRatio()`, `suggestHeaderColor()`, `--gal-accent-ink` |
| `src/lib/logoColors.ts` | de kleuren en de gemiddelde kleur van een logo |
| `src/lib/portalGreeting.ts` | datum, groet, voornaam en de zin over wat er openstaat |
| `src/lib/portalPreview.ts` | het bericht naar het voorbeeld, de keuring ervan en de verzonnen klant |
| `src/lib/portalApi.ts` | alle portaalaanroepen via `portalInvoke()`; `setPortalBackend()` voor het voorbeeld |
| `src/components/PublicBrand.tsx` | `BrandMark` (logo, plaatje of initiaal), `PublicDocHero`, `PublicDocState` |
| `src/features/portal/ClientPortal.tsx` | de nieuwe kop met groet, kerncijfers en tabbladen; `PortalPreview` |
| `src/features/PublicQuotePage.tsx`, `PublicInvoicePage.tsx`, `PublicContractPage.tsx` | de kop en het werkvlak |
| `src/features/BrandStudio.tsx` | Instellingen → Huisstijl: de instellingen, de leesbaarheid en het voorbeeld |
| `src/features/SimplePages.tsx` | gebruikt `BrandStudio`; de nieuwe velden in het formulier |
| `src/styles/portal-cockpit.css` | de laag voor portaal, publieke pagina's en de studio (na `cockpit.css` geladen) |
| `src/main.tsx` | de route `/portal/voorbeeld` |
| `public/_headers`, `scripts/check-csp-hash.mjs` | inlijsten alleen voor het voorbeeld; de hash in elke CSP-regel |
| `tests/mobile/run.mjs` | `settings-huisstijl` en `portal-preview` in de standaardronde |
| `src/lib/branding.test.ts`, `src/lib/portalGreeting.test.ts` | contrast over het raster, kop, plaatje, logokleuren, groet |

## Getest

- `npm run typecheck`, `npm test` (768 tests, waarvan 12 nieuw), `npm run build` en
  `node scripts/check-csp-hash.mjs` (de hash staat in beide CSP-regels): schoon.
- `deno check` op de 34 edge functions uit de CI-lijst: schoon. In deze omgeving zijn deno.land en
  esm.sh niet bereikbaar, dus die imports zijn met een import map omgeleid naar dezelfde versies
  op npm (en een stub voor `std/http/server.ts`). `client-portal` en `invoice-public` staan niet
  in die lijst; daar geeft `deno check` precies dezelfde fouten als vóór deze wijziging (de
  bekende `Uint8Array` / `BufferSource`, en vier `string | undefined` in `invoice-public`),
  geen nieuwe.
- De migratie op een lokale Postgres 16: de kolommen komen erbij, `blue` als kopkleur en een
  SVG als lichte logoversie worden geweigerd door de checks, leeg (Automatisch) mag,
  `create_child_organization` neemt merkkleur, kopkleur en lichte logoversie mee naar de nieuwe
  administratie, en `anon` mag de functie niet uitvoeren, `authenticated` wel.
- `public/_headers` nagerekend met Cloudflare's eigen runtime (workerd via Miniflare 4) op de
  gebouwde site: `/portal/voorbeeld` krijgt één CSP met `frame-ancestors 'self'` en
  `SAMEORIGIN`, niet twee aan elkaar geplakt; `/`, `/portal` en `/quote/…` houden `'none'` en
  `DENY`.
- `npm run test:mobile -- --theme=both`, met de twee nieuwe pagina's (`settings-huisstijl` en
  `portal-preview`) in de ronde: de uitslag volgt in de volgende commit. Een eerdere ronde op
  alleen het portaal en de publieke pagina's (telefoon, tablet en liggend): 42 metingen, 0
  problemen.
- In de browser met de nagebootste backend: het portaal in vier merken (goud standaard, oranje met
  navy kop, blauw licht, groen met eigen kop) op 1440px en de telefoon, inloggen, de drie publieke
  pagina's (ook op de telefoon), en Instellingen → Huisstijl in Dag en Nacht op 1440px, in Nacht
  op 1024px en in Dag op de telefoon: het voorbeeld kleurt mee bij elke wijziging, Factuur en
  Telefoon werken, Volledig scherm sluit met Esc, geen zijwaartse overloop en geen
  JavaScript-fouten.

## Wat níét verandert

Wat het portaal en de publieke pagina's dóén: inloggen met een link, betalen, akkoord geven,
ondertekenen, tickets, berichten, bestanden en meldingen werken zoals voorheen. Zonder kopkleur
(iedereen, tot hij er een kiest) krijgt de kop het grafiet van de werkruimte in de tint van de
merkkleur. De e-mails gebruiken de kopkleur nog niet.
