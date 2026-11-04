# Galerij: de deellink blijft zichtbaar (2026-09-19)

## Aanleiding

De deellink van een galerij was maar één keer te zien. Bij het genereren stond
hij in het venster "Galerij delen"; daarna bewaarde de database alleen de
SHA-256-hash, en toonde datzelfde venster nog slechts de zin *"Om
veiligheidsredenen tonen we de link maar één keer"*.

In de praktijk was de link dus weg zodra het scherm opnieuw tekende — en dat
gebeurt bij elke wijziging aan de galerij, dus ook bij publiceren. Wie de link
op dat moment nog niet had gekopieerd, kon alleen een nieuwe genereren, waarmee
de link die hij misschien al had gemaild meteen ongeldig werd.

Dat niveau van geheimhouding hoort ook niet bij deze link. Hij is geen
wachtwoord van een gebruiker maar een capability-URL van de studio zelf: wie
hem mag zien, mag sowieso al een nieuwe maken, de galerij publiceren of hem
intrekken. De pincode blijft wél alleen als hash bestaan — die is van de
ontvanger, niet van de studio.

## Wat er is veranderd

### In het scherm (Galerij → Delen)

- **De link staat er altijd.** Zolang het delen aan staat, toont het venster de
  volledige URL met een kopieerknop — na publiceren, na het sluiten van het
  venster en na het herladen van de pagina. Hij verdwijnt alleen als je hem
  intrekt.
- **Publiceren en delen staan er nu naast elkaar uitgelegd.** Onder de link
  staat wat de publicatiestand betekent: gepubliceerd = de pagina is
  bereikbaar; concept = de pagina is dicht (de bezoeker krijgt "niet (meer)
  beschikbaar") terwijl de link blijft staan en weer werkt zodra je opnieuw
  publiceert. Publicatie ongedaan maken is dus de manier om de pagina te
  sluiten zonder de link kwijt te raken; intrekken blijft de manier om de link
  zelf ongeldig te maken.
- **De pincode blijft aan de link vastzitten.** Toevoegen, wijzigen of weghalen
  kan alleen met een nieuwe link; dat staat nu ook onder het invoerveld in
  plaats van alleen in de code.
- **De URL wordt niet meer afgekapt.** Hij breekt af over twee regels, zodat je
  hem ook met de hand kunt selecteren als het klembord dwarsligt.
- **Links van vóór vandaag.** Van een bestaande deellink is het token nergens
  meer opgeslagen en uit een SHA-256 niet terug te rekenen. Die links blijven
  gewoon werken; het venster meldt dat er wel een link actief is maar dat die
  hier niet meer op te halen is, en dat een nieuwe genereren de enige manier is
  om hem weer in beeld te krijgen.

### Database

`supabase/migrations/20260919000000_gallery_share_link_visible.sql`

- **`galleries.share_token`** — het token in leesbare vorm. Alleen leesbaar
  binnen de organisatie (de bestaande RLS op `galleries`: `can_read_org`). De
  publieke pagina blijft zoeken op `share_token_hash`; aan die kant verandert
  er niets.
- **Trigger `galleries_share_token_guard`** — wist `share_token` zodra
  `share_enabled` uit gaat of `share_token_hash` leeg raakt. Intrekken mag
  nooit half gebeuren: een token dat blijft staan terwijl de hash weg is, zou
  een link tonen die nergens meer op uitkomt. Dezelfde trigger wist het token
  ook als er een nieuwe hash binnenkomt zonder nieuw token — dat is wat een
  tabblad doet dat nog de oude app draait, en anders zou het scherm daarna een
  token tonen dat op geen enkele galerij meer uitkomt.

### De frontend loopt vóór op de migratie

Cloudflare Pages rolt de app uit voordat de migratie draait. In dat gaatje
bestaat `share_token` nog niet, en dan zou "Deellink maken" — en erger:
"Deellink intrekken" — stuklopen op een PostgREST-zin.

- `updateGalleryShare` (`src/lib/repository.ts`) probeert de opdracht mét het
  token en herhaalt hem zonder zodra de database die kolom niet kent. De link
  werkt dan gewoon; hij is alleen nog niet terug te halen, precies zoals
  gisteren.
- `isMissingColumn` (`src/lib/postgrestErrors.ts`) herkent dat geval: alleen op
  `42703` / `PGRST204` én de kolomnaam in de melding, zodat een echt kapotte
  query niet stilletjes wordt opgevangen. Met tests in
  `src/lib/postgrestErrors.test.ts`.

### Gerrie-handelingen

- `gallery.create_share_link` bewaart het token mee en meldt dat de link
  terug te vinden is bij "Delen" in de galerij, in plaats van "bewaar hem, hij
  is later niet meer op te halen".
- `gallery.revoke_share_link` wist het leesbare token mee (frontend én
  `supabase/functions/_shared/actions/apply.ts`).
- `gallery.unpublish` beschreef tot nu toe dat "de publieke deellink wél blijft
  werken". Dat klopte niet: `gallery-public` geeft 403 zolang de status niet
  `published` is. De tekst zegt nu wat er echt gebeurt — de pagina loopt dood,
  de link zelf blijft bestaan en werkt weer na opnieuw publiceren.

## Wat dit niet verandert

- Het token gaat nergens naar buiten. `gallery-public` en `client-portal`
  bouwen hun antwoord uit een vaste lijst velden (`sanitizeGallery`), en
  `list_galleries` in `gerrieCore.ts` laat token en pincode bewust uit het
  modelantwoord.
- Van de pincode bewaart de database nog steeds alleen een hash, met het token
  als zout, inclusief de teller en de kwartierlockout in
  `gallery_verify_share_pin`.
- Het klantportaal is een aparte weg naar dezelfde galerij en staat hier los
  van.

## Getest

- `npm run typecheck` en `npm test` (332 tests) — schoon.
- `npm run test:mobile -- --theme=both` — schoon.
- Handmatig doorlopen in de browser tegen de nagebootste backend uit
  `tests/mobile/mock`: deellink maken → publiceren → venster opnieuw openen →
  pagina herladen. De link is in alle vier de stappen dezelfde en blijft in
  beeld; intrekken haalt hem weg en zet `share_token` op `null`. Geen
  JavaScript-fouten op de pagina.
- Dezelfde doorloop met een backend die `share_token` níét kent (PGRST204 op
  elke update met dat veld): deellink maken en intrekken werken door, de link
  staat één keer in beeld zoals voorheen, en er verschijnt geen foutmelding.
