# Changelog — Bestanden delen met mensen — 2026-08-23

De cloud-drive ("Bestanden" in het klantdossier en de Inhoud-pagina) kende geen enkele
manier om iets met een mens buiten je eigen scherm te delen. Alles was óf zichtbaar voor
de hele organisatie, óf voor niemand. Vanaf nu zit er achter het ⋮-menu van elke map,
elk bestand, elke notitie en elk document een **Delen…**.

## De regel die alles stuurt

> Hoort het item bij een klantdossier, dan mag het **uitsluitend** worden gedeeld met de
> geregistreerde, actieve contactpersonen van diezelfde klant.

Die regel staat niet in het scherm maar in de database (trigger `drive_shares_guard`) —
een scherm is geen slot. Het deelvenster laat bij een klantgerelateerd item dan ook alleen
de contactpersonen van die klant zien; probeert iets tóch een open deellink aan te maken,
dan weigert Postgres dat met een Nederlandse melding.

Wat "klantgerelateerd" betekent wordt server-side afgeleid uit het item zelf
(`drive_item_client`), met dezelfde regel als de Inhoud-verkenner: hangt er een project
aan, dan telt de klant van dát project. De browser mag die context nooit meesturen; de
trigger overschrijft wat er staat.

## Drie soorten ontvangers

| Soort | Wie | Waar hij het opent |
|---|---|---|
| `contact` | geregistreerde contactpersoon van de klant | klantportaal → nieuw tabblad **Bestanden** |
| `member` | collega in dezelfde organisatie | de app zelf (hij had al toegang; dit is een wegwijzer) |
| `link` | los e-mailadres | `/gedeeld/<token>` — **alleen** als het item níet klantgerelateerd is |

Per deling: mag downloaden ja/nee, een optionele vervaldatum (7/30/90 dagen), een
persoonlijk bericht, en een melding per e-mail.

## Toegevoegd

- **Migratie `20260823000000_drive_shares.sql`** (+ `20260823010000_drive_shares_revoke_always_possible.sql`,
  die één ding rechtzet: intrekken moet altijd lukken, ook als de contactpersoon intussen
  inactief is of zijn portaaltoegang kwijt is — anders zit je vast aan precies de deling
  die je wilde stoppen)
  - `drive_shares` (wat, met wie, tot wanneer, mag downloaden) met RLS
    (`can_read_org`/`can_write_org`), de module-poort op `content`, org-integriteits- en
    audittriggers, en partiële unieke indexen zodat opnieuw delen bijwerkt in plaats van
    stapelt.
  - `drive_item_client()` — de enige bron van waarheid voor "is dit klantgerelateerd?".
    Fail-closed: een item waarvan de klant niet is vast te stellen kan niet worden gedeeld.
  - `enforce_drive_share_rules()` — de kernregel. Weigert een deellink op een
    klantgerelateerd item, weigert een contactpersoon van een andere klant, een inactieve
    contactpersoon en een contactpersoon zonder portaaltoegang. Een deling kan niet al
    ingetrokken worden aangemaakt (dat zou de hele controle overslaan), en weer scherp
    zetten loopt gewoon opnieuw langs alle regels.
  - `drive_share_items()` — klapt een gedeelde map uit tot wat je echt kunt openen,
    inclusief submappen, met het pad erbij. Elk blad moet bij dezelfde klant horen als de
    deling: een submap of een later verplaatste notitie van een ándere klant lift niet mee.
  - `portal_drive_shares_for_email()` en `resolve_drive_share_link()` — de leespaden.
    Allebei leiden de klant **live** opnieuw af: verhuist een item na het delen naar een
    klant, dan is de bestaande deellink op datzelfde moment dood.
  - Deellinks bewaren alleen `sha256hex(token)`, net als offertes, facturen, contracten en
    galerijen. De platte token bestaat alleen in de verstuurde e-mail en in de URL.
- **Edge function `file-share`** (ingelogd) — maakt delingen aan, munt de deellink-token en
  verstuurt de melding via Resend. Eén weigerende ontvanger sleept de rest niet mee: je
  krijgt per persoon terug of het lukte.
- **Edge function `file-share-public`** (`verify_jwt = false`) — bedient `/gedeeld/<token>`.
  Bytes komen server-side uit R2 via de interne worker-route; de bezoeker ziet nooit een
  opslag-URL.
- **`client-portal`** — acties `getSharedFiles` en `downloadSharedFile`, plus
  `sharedFileCount` per account voor het tabbladtelletje. Toegang wordt bij elke aanvraag
  opnieuw afgeleid uit het geverifieerde e-mailadres.
- **E-mailsjabloon `file.shared`** — met dezelfde per-organisatie instelbare velden als de
  andere mails (Instellingen → E-mailteksten), inclusief plaatshouders `{{sender_name}}`,
  `{{item_name}}`, `{{item_kind}}`, `{{client_name}}`.
- **Frontend**
  - `ShareDialog` — het deelvenster: ontvangers kiezen, rechten en vervaldatum, bericht,
    de lijst "Wie heeft nu toegang" met intrekken, opnieuw sturen en downloaden aan/uit.
  - `SharedOverview` — knop **Gedeeld** in de Inhoud-balk: alles wat er buiten de deur
    ligt in één lijst, met intrekken. Zonder dit kun je een deling alleen terugvinden door
    eerst het bestand terug te vinden.
  - Een personen-icoontje op elke rij die gedeeld is (lijst én tegels, beide verkenners).
  - `PublicSharePage` op `/gedeeld/<token>` en een **Bestanden**-tab in het klantportaal.
  - `src/lib/shares.ts` — de client-side spiegel van de klantregel, met tests
    (`shares.test.ts`) zodat die spiegel niet ongemerkt van de database afdrijft.

## Bewust niet

- **Geen open deellink op klantgerelateerde bestanden.** Ook niet met een extra vinkje.
- **Delen met een collega geeft geen extra rechten** — die had al toegang tot de
  werkruimte. Het is een melding met een link, en zo staat het er ook.
- **Downloaden uitzetten blokkeert lezen niet.** Een notitie of tekstdocument lees je op
  de pagina zelf; dat is kijken, geen downloaden.
- **Geen upload vanuit het portaal.** Delen gaat één kant op.

## Verificatie

- `tsc --noEmit`, `npm run build` (vite, 1904 modules) en `npm test` (87 tests) slagen.
- De migratie is toegepast op staging (`supabase db push`) — Postgres heeft elke
  statement geaccepteerd; `file-share`, `file-share-public` en `client-portal` zijn
  gedeployd.
- Rooktest op staging: `/gedeeld` met een onbekende token geeft 404 met de juiste
  Nederlandse melding, `file-share` weigert een niet-ingelogde aanroep (401), en
  `drive_item_client` is voor `anon` niet uitvoerbaar (42501).
- De hele wijziging is langs een adversarial review gegaan (5 invalshoeken, elke bevinding
  apart geverifieerd). De bevindingen die standhielden zijn verwerkt — waaronder een
  kritieke achterdeur waarbij een insert met `revoked_at` al gevuld de hele controle
  oversloeg, en het ontbreken van hercontrole op leestijd.
- De ingelogde pagina is niet live gerenderd: inloggen vereist een magic-link, dus de
  schermen zijn geverifieerd via typecheck/build en code-review, conform eerdere
  changelogs.
