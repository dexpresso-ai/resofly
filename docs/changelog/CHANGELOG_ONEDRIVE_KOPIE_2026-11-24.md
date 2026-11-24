# Changelog — Een kopie van Inhoud in OneDrive — 2026-11-24

Op verzoek: de bestanden van ResoFly ook in de cloudopslag van Microsoft
OneDrive, met ResoFly als leidend systeem; verwijderen in ResoFly is ook
verwijderen in OneDrive. Plan met de keuzes van 24 november:
`docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md`. Inrichten:
`docs/setup/ONEDRIVE_SETUP.md`.

## Wat er nu kan

- **Instellingen → AI & koppelingen → OneDrive** (alleen de eigenaar):
  OneDrive koppelen, de kopie aanzetten, zien hoe het ervoor staat, *Alles
  opnieuw kopiëren*, *Opnieuw proberen*, de kopie uitzetten en ontkoppelen. Bij
  het aanzetten staat erbij wat er wel en niet meegaat, dat ResoFly leidend is,
  en dat iedereen die bij de map in OneDrive kan alle klantbestanden ziet.
- **De kopie**: in de OneDrive van de eigenaar komt de map `ResoFly -
  <organisatie>`, met daarin klant / project / map / bestand, zoals in Inhoud.
  Uploaden, hernoemen, verplaatsen, bewerken in de editor en verwijderen in
  ResoFly gebeurt daar ook. Verwijderen zet het in de prullenbak van OneDrive.
- **Wat meegaat**: bestanden in de mappen van Inhoud en het klantdossier, en
  Word/Excel/PowerPoint-documenten uit Inhoud. Niet: notities, tekstdocumenten,
  financiële stukken, de galerij en zendingen.
- **In Inhoud**: een OneDrive-icoon in de commandobalk zolang de kopie aanstaat
  (klik: de map in OneDrive), en "In OneDrive gaat het naar de prullenbak" in de
  bevestiging bij verwijderen. Na elke wijziging gaat de wachtrij meteen naar
  OneDrive; de rest pakt de geplande taak (elke twee minuten).

## De keuzes van 24 november, en hoe ze erin zitten

| | Keuze | Zo gebouwd |
| --- | --- | --- |
| Optie B | Een kopie, R2 blijft de bron | Niets aan het opslaan in R2 veranderd; de kopie komt erbij |
| Plek | Eén plek, door de eigenaar gekoppeld | Eén koppeling per organisatie; alleen de rol eigenaar (app én edge function) |
| A | Bestaande bestanden niet vanzelf meekopiëren | Aanzetten kopieert niets; *Alles opnieuw kopiëren* doet het als je wilt |
| B | Geen notities en tekstdocumenten | Alleen bestanden en Office-documenten met een bestand |
| C | Eerst alleen OneDrive | Recht `Files.ReadWrite`: de eigen OneDrive, geen SharePoint |
| D | ResoFly is leidend | Een nieuwe versie in ResoFly overschrijft; een hernoemde map in OneDrive krijgt de naam uit ResoFly terug |
| E | Niet vanzelf terugzetten | Een in OneDrive verwijderd bestand komt terug bij de volgende wijziging, of met *Alles opnieuw kopiëren* |
| F | De eerste versie weg | Teruggedraaid in commit 7dc6928 |

## Hoe het in elkaar zit

| Laag | Wat |
| --- | --- |
| Database | `20261124100000_onedrive_kopie.sql`: `onedrive_mirrors` (+ `_tokens`), `onedrive_sync_items` (welk item in OneDrive bij welk item in ResoFly hoort), `onedrive_sync_jobs` (de wachtrij, één rij per item met een teller), triggers op `attachments`, `documents`, `content_folders`, `clients`, `projects` en `organization_members`, en de functies `onedrive_claim_jobs`, `onedrive_queue_full_sync` en `onedrive_cleanup` |
| Edge function | `onedrive-sync`: koppelen, aan/uit, ontkoppelen, status, alles opnieuw, opnieuw proberen, en de wachtrij afwerken (op verzoek van de app en als geplande taak, `?cron=sync`) |
| Gedeeld | `_shared/onedriveSync.ts`: rechten, terugkeeradres, namen die OneDrive accepteert, wat mag meegaan, foutcodes van Microsoft, tokens versleutelen (met `onedriveSync.test.ts`) |
| Media-worker | `/internal/onedrive/push`: een bestand uit R2 in stukken van 10 MiB naar een uploadadres van OneDrive (`onedrivePush.ts`, met test) |
| App | `features/OneDriveSettings.tsx`, `lib/onedrive.ts` (+ test), `lib/onedrive-api.ts`; aanpassingen in `ContentLibrary.tsx`, `main.tsx` (terugkeer na koppelen), `settingsMenu.ts`, `settingsMenuItems.ts`, `SimplePages.tsx` |
| Inrichten | `config.toml`, CI (deno check), `scripts/supabase-setup-webhooks.sh` (stap 7), rooktest, `.env.example`, export (`exportManifest.ts`) |

## Waarom zo

- **Een wachtrij in de database, gevuld door triggers.** Een klant verwijderen
  haalt zijn mappen en bestanden weg via een cascade; daar komt geen scherm
  langs. Hetzelfde patroon als het opruimen van de galerij (20261112170000).
- **Per item één taak, uitgerekend bij het afwerken.** De taak zegt alleen
  "dit item" en "bijwerken" of "weg". De edge function kijkt dan hoe het er
  in ResoFly nu uitziet en maakt OneDrive zo. Dan maakt de volgorde van
  wijzigingen niet uit, en loopt een dubbele taak niet twee keer.
- **Oppakken met "skip locked" en een teller.** De app en de geplande taak
  kunnen tegelijk lopen. Een taak gaat pas weg als er tijdens het afwerken
  niets nieuws bij kwam; anders loopt hij nog een keer.
- **Gewone wijzigingen vóór het verwijderen.** Een Word-document in een map
  die wordt verwijderd, schuift naar de klantmap (`folder_id` wordt leeg). Zo
  staat het al veilig voordat de map naar de prullenbak gaat. Gaat het toch
  andersom, dan uploadt ResoFly het opnieuw.
- **De bytes via de media-worker.** De edge function vraagt bij Microsoft een
  uploadadres aan; dat geldt kort en draagt de toegang zelf. De worker stuurt
  het bestand rechtstreeks uit R2, in stukken, zonder sleutel van Microsoft.
  Verandert het bestand halverwege (opslaan in de editor), dan stopt hij en
  loopt de taak opnieuw.
- **Lege mappen niet.** Een klant- of projectmap komt er pas als er een
  bestand in komt; anders stonden er honderden lege klantmappen in OneDrive.
- **Alleen de ingestelde app-adressen als terugkeeradres.** De agenda laat ook
  Cloudflare-previews toe. Uit de review van de eerste versie: wie een preview
  kan uitrollen, kon zo de code van een eigenaar ontvangen. Hier niet.
- **De worker en de edge function weigeren financiële stukken allebei**
  (`mirrorableKey`, `ONEDRIVE_PUSH_SEGMENTS`), ook als een rij ernaar zou wijzen.
- **De eigenaar vertrekt**: de kopie gaat uit en het token weg, net als bij de
  agenda. Wat er in OneDrive staat, blijft.

## Na de review (24 november)

Een tweede blik op de code vond zeven punten. Geen ervan liet een andere
organisatie bij de bestanden, of financiële stukken in OneDrive komen. Wel:

| # | Wat er mis kon gaan | Nu |
| --- | --- | --- |
| 1 | Een mislukte leesvraag aan de database (time-out) telde als "de rij is weg": een bestand dat in ResoFly gewoon bestond, ging in OneDrive naar de prullenbak | Een mislukte leesvraag is "later opnieuw" (`read()` in `onedrive-sync`) |
| 2 | Verhuisde een submap uit een map die daarna werd verwijderd, en moest die verhuizing even wachten, dan ging de submap met de map mee naar de prullenbak | Een klant, project of map gaat pas weg als er voor de organisatie geen wijziging meer wacht (`onedrive_claim_jobs`) |
| 3 | Twee rondes tegelijk (de app, het scherm, de geplande taak) maakten dubbele mappen: "Acme" en "Acme 1" | Per organisatie één ronde tegelijk (`onedrive_lock_org`, `onedrive_unlock_org`, kolom `processing_until`) |
| 4 | Een token dat niet meer te lezen was (sleutel veranderd), liet de kopie stil hangen | De koppeling gaat op "opnieuw koppelen", met uitleg voor de eigenaar |
| 5 | Verplaatsen naar een map die in OneDrive weg was, gaf een tweede kopie, met de oude op de oude plek | Eerst kijken of het bestand er nog is; zo ja, de doelmap opnieuw maken en dan verplaatsen |
| 6 | Elk teamlid met Inhoud kon het Microsoft-account van de eigenaar lezen | Kolomrechten: alleen `organization_id`, `enabled`, `status` en `root_web_url` |
| 7 | De worker volgde een doorverwijzing van het uploadadres | `redirect: 'manual'`; ook het domein voor privé-bestanden van Microsoft (`microsoftpersonalcontent.com`) staat erbij |

## Bewust niet gebouwd

- SharePoint en wat anderen delen (keuze C; fase 2).
- Notities en tekstdocumenten als PDF (keuze B).
- Google Drive als tweede bestemming (fase 2; kan gratis met `drive.file`).
- Iets terughalen uit OneDrive: ResoFly is leidend.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: alle tests geslaagd, met de nieuwe `onedriveSync.test.ts`,
  `onedrive.test.ts`, `onedrivePush.test.ts` en een test in
  `settingsMenu.test.ts` (OneDrive alleen voor de eigenaar).
- `tsc --noEmit` in `workers/media-api`: schoon.
- `deno check supabase/functions/onedrive-sync/index.ts`: schoon. Lokaal met een
  import-map, omdat esm.sh vanuit de cloudsessie niet bereikbaar was; CI checkt
  met de echte imports.
- `supabase db reset` (de keten vanaf nul, met de migraties van staging erbij)
  en `npm run test:database`: alle acht bestanden geslaagd, met de nieuwe
  `tests/database/onedrive_kopie.sql` (47 controles: wat er wel en niet in de
  wachtrij komt, per item één taak, cascades, wie wat ziet (ook: niet het
  account van de eigenaar), één ronde per organisatie, oppakken in de goede
  volgorde, een map pas weg als er niets meer wacht, aan/uit, *Alles opnieuw
  kopiëren*, vertrek van de eigenaar, opruimen). De migratie draait ook een
  tweede keer schoon.
- `npm run test:mobile -- --theme=both`: 908 pagina's gemeten, geen problemen,
  met twee nieuwe scenario's (`settings-onedrive`, `settings-onedrive-koppelen`)
  en de verkenner met het OneDrive-icoon. `npm run test:loading`: alle controles
  geslaagd. `npm run test:terugknop`: 15 van 15. Deze drie draaiden op de
  schermcode van commit 9f3256e; de correcties na de review raakten geen scherm.
- **Niet getest tegen het echte Microsoft**: daarvoor moet eerst §3 van de
  handleiding gedaan zijn, en de media-worker opnieuw uitgerold.
