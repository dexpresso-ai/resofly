# Changelog — Google Drive en OneDrive koppelen aan Inhoud — 2026-11-23

Op verzoek: "Ik wil koppelen met Drive en OneDrive. Verwijderen uit ResoFly is
ook verwijderen uit OneDrive of Drive."

Een teamlid koppelt zijn eigen Google Drive of OneDrive en zet bestanden daaruit
in een dossiermap. ResoFly bewaart een verwijzing; het bestand blijft in Drive of
OneDrive en opent daar. Verwijder je het in ResoFly, dan gaat het daar naar de
prullenbak. Inrichten: `docs/setup/DRIVE_ONEDRIVE_SETUP.md`.

## Wat er nu kan

- **Inhoud en klantdossier → Bestanden → een map → + Nieuw → Uit Google Drive /
  Uit OneDrive.** Het venster koppelt je account (één keer), en laat je daarna
  bestanden kiezen:
  - Google: de kiezer van Google zelf, met je eigen Drive en de gedeelde Drives.
  - OneDrive: een lijst van je OneDrive in het venster, met mappen, zoeken en
    "meer laden"; je kunt in verschillende mappen iets aanvinken.
  - Na het koppelen kom je terug in dezelfde map, met het venster open.
- **Een gekoppeld bestand** staat in de map met een wolkje bij het icoon en bij
  Type "PDF · Google Drive". Klikken (of ⋮ → *Openen in Google Drive*) opent het
  daar. Hernoemen en verplaatsen kan; delen, versturen, downloaden en bewerken
  in de editor niet (dat doe je in Drive of OneDrive zelf).
- **Verwijderen = in de prullenbak van Drive of OneDrive.** Los, via de selectie,
  via een verwijderde map en via een verwijderde klant. De bevestiging zegt het
  erbij. Lukt het niet (koppeling verlopen, geen eigenaar), dan zegt de
  verkenner dat meteen, en staat het in het venster onder "Nog niet uit …
  verwijderd", met *Opnieuw* en *Laten staan*. Koppel je opnieuw, dan gaat wat
  er wachtte alsnog.
- **Gerrie**: het voorstel "Bestand verwijderen" zegt "gaat ook in Google Drive
  naar de prullenbak". Uitvoeren gaat zoals altijd pas na goedkeuring.

## Hoe het in elkaar zit

| Laag | Wat |
| --- | --- |
| Database | `20261123150000_drive_onedrive_koppelen.sql`: `cloud_drive_connections` (+ `_tokens`), kolommen `cloud_provider`, `cloud_file_id`, `cloud_drive_id`, `cloud_connection_id`, `cloud_web_url`, `cloud_size_bytes` op `attachments`, de wachtrij `cloud_file_deletions` met een trigger op elk verwijderen, `drive_share_items` en `purge_folder_files` zonder gekoppelde bestanden |
| Edge function | `cloud-files`: koppelen (OAuth, afronden in de app), status, ontkoppelen, token voor de kiezer van Google, OneDrive bekijken, bestanden in een map zetten, de wachtrij afwerken (ook als geplande taak, `?cron=deletions`) |
| Gedeeld | `_shared/cloudFiles.ts` (regels, met `cloudFiles.test.ts`) |
| App | `components/CloudDriveDialog.tsx`, `lib/cloudDrive.ts` (+ test), `lib/cloudDrive-api.ts`, `public/drive-kiezer.html` + `.js` (de kiezer van Google in een eigen kader), aanpassingen in `ContentLibrary.tsx`, `DriveGlyphs.tsx`, `repository.ts` (`deleteAttachment`), `r2.ts`, `office.ts`, `SendFilesDialog.tsx`, `main.tsx` |
| Afgeschermd | `file-share` en de database weigeren delen; `file-transfer` slaat een gekoppeld bestand over met uitleg; de export neemt het segment `cloud` niet mee in de zip; de opslagmeter telt het niet |

## De keuzes, en waarom

- **Een verwijzing, geen opslag in Drive.** Een factuur of offerte in de Drive van
  een klant kan daar gewist worden; de bewaarplicht (harde regel 6) kan ResoFly
  dan niet meer afdwingen. Gekoppelde bestanden staan daarom alleen in een
  dossiermap (`attachments_cloud_shape`), nooit bij een factuur.
- **Google met `drive.file`.** ResoFly ziet alleen wat iemand in de kiezer van
  Google aanwijst. De bredere rechten zijn bij Google "restricted" (jaarlijkse
  betaalde beoordeling) en geven toegang tot elk bestand.
- **De kiezer van Google in een eigen kader** met een eigen CSP
  (`public/_headers`, `/drive-kiezer`). Het script van `apis.google.com` in de
  CSP van de app zelf zou een deur zijn voor elk stukje HTML dat ooit ongefilterd
  in de app terechtkomt.
- **Het token voor de kiezer** kan alleen `drive.file`; draagt het meer (de
  agenda, als Google de rechten van dezelfde client samenvoegt), dan weigert
  `cloud-files` het. Een eigen Google-client voor Drive wordt aangeraden.
- **OneDrive zonder token in de browser.** Microsoft kent geen "alleen wat je
  kiest"; de lijst komt via de server.
- **Verwijderen via een wachtrij in de database**, niet alleen vanuit het
  scherm. Een klant verwijderen haalt zijn mappen weg via een cascade; daar komt
  geen scherm langs. Net als bij de galerij (20261112170000).
- **Met de koppeling van wie het bestand koppelde, naar de prullenbak.** Een
  collega heeft meestal geen toegang tot jouw Drive. Wie in ResoFly mag
  verwijderen, beslissen de rechten op Inhoud. De prullenbak, zodat een
  vergissing nog te herstellen is.
- **De cloud-kolommen schrijft alleen de service-role** (`attachments_cloud_guard`).
  Kon een teamlid ze zetten, dan maakte hij een verwijzing naar een bestand van
  een collega en gooide hij het via ResoFly weg.
- **Geen "revoke" bij Google bij ontkoppelen**: dat trekt de hele toestemming
  voor de Google-app in, en als de agenda dezelfde app gebruikt, viel die dan om.

## Bewust niet gebouwd

- Mappen koppelen (alleen losse bestanden; een map kiezen geeft een melding).
- Gedeelde mappen en SharePoint bij Microsoft (`Files.ReadWrite.All`).
- Uploaden naar Drive of OneDrive vanuit ResoFly, en terugsynchroniseren als een
  bestand in Drive wordt hernoemd of weggegooid (de link werkt dan niet meer).
- Hernoemen in ResoFly doorzetten naar Drive.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: alle tests geslaagd, met de nieuwe `cloudFiles.test.ts` (19) en
  `cloudDrive.test.ts` (9).
- `deno check` van `cloud-files`, `file-share`, `file-transfer` en
  `gerrie-agent` (die de handelingen van Gerrie laadt): schoon. Lokaal met een
  import-map, omdat esm.sh en deno.land vanuit de cloudsessie niet bereikbaar
  waren: supabase-js via npm, en voor `serve` uit deno.land/std een kleine
  vervanger met dezelfde vorm. CI checkt met de echte imports.
- `supabase db start` (de keten vanaf nul, Postgres 17.11.0.018) en
  `npm run test:database`, met de nieuwe `tests/database/drive_onedrive_koppelen.sql`:
  teamlid kan geen gekoppeld bestand maken of de koppeling wijzigen, wel
  hernoemen en verplaatsen; verwijderen (los en via een map) komt in de
  wachtrij; wie wat ziet (wachtrij per organisatie en module, koppeling alleen
  van jezelf, tokens nooit); vertrek zet de koppeling uit. De migratie draait
  ook een tweede keer schoon.
- `npm run test:mobile -- --theme=both`, met twee nieuwe scenario's
  (`content-drive-map`, `content-onedrive`): het wolkje in de lijst, en het
  venster met een lang account, lange namen en een mislukte verwijdering.
- `node scripts/check-csp-hash.mjs`: de hash staat in alle vier CSP-regels.
- **Niet getest tegen de echte Google en Microsoft**: daarvoor zijn de
  instellingen uit de handleiding nodig. De kiezer van Google, het koppelen en
  het weggooien zijn dus nog niet echt doorlopen.
