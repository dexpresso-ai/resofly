# Changelog — Verplaatsen naar elke map, elk project, elke klant — 2026-09-03

Sinds gisteren kon je in de verkenner selecteren en slepen, maar alleen binnen de map-scope
waar je al stond: een andere klant of een ander project was geen doel. Dat is precies wat
er ontbrak. Een verkeerd opgeborgen offerte hoort met één handeling in het juiste dossier
te belanden — en een hele map, mét submappen en inhoud, net zo goed.

## Wat je nu kunt

- **“Verplaatsen naar…” is een venster geworden**, een kleine verkenner: bedrijf → klant →
  project → map, met broodkruimels, een zoekveld en een knop “Hierheen verplaatsen”. Het
  opent op de plek waar je nú staat, dus een buurmap is één klik ver en een andere klant
  twee. Je vindt het in de selectiebalk (voor alles wat aangevinkt is) en in het ⋮-menu van
  elke rij — nu ook van mappen en geüploade bestanden, die hadden het nog niet.
- **Elke plek is een doel**: een dossiermap (van welke klant ook), de wortel van een
  projectmap, de klantwortel, en voor notities en documenten ook “Geen klant” (losmaken
  van het dossier).
- **Slepen kan nu ook naar een projectmap-rij**, naar de klant-broodkruimel vanuit een
  project, en naar “Terug” vanuit de projectwortel. Slepen tussen klanten blijft bewust
  via het venster: dat is een besluit, geen handbeweging.
- **Een map neemt zijn hele boom mee.** Submappen, de notities en documenten erin en de
  geüploade bestanden verhuizen mee naar de nieuwe klant en het nieuwe project — hoe diep
  de boom ook is.
- **Wat niet kan, zie je vooraf.** De knop staat uit en de reden staat ernaast: een
  geüpload bestand moet in een map blijven staan, een map hoort bij een klant, een map
  kan niet in zichzelf of in zijn eigen submap, en “Staat hier al” is geen fout maar ook
  geen actie. Een gemengde selectie splitst zich: wat kan gaat mee, de rest wordt gemeld.

## Deelhygiëne

Portaal- en deellinktoegang werden al live afgeleid uit het item, dus een contactpersoon
van de oude klant was de toegang op het moment van verhuizen al kwijt. Maar de deling
zélf bleef als “actief” staan — het personen-icoontje in de lijst en de ontvangerlijst in
het deelvenster logen dan. Nu trekt de database na een verhuizing de delingen in die
volgens de kernregel niet meer mogen: contactpersonen van een andere klant, en open
deellinks zodra een item klantgerelateerd wordt. Collega-delingen blijven staan.

## Database — migratie `20260903000000_content_folders_move_scope.sql` (TOEGEPAST op staging)

- `validate_content_folder()`: het verbod op het wijzigen van klant/project van een
  bestaande map vervalt. De reden voor dat slot (submappen zouden achterblijven) is
  opgelost met een cascade in plaats van een verbod. Alle andere regels blijven: ouder in
  dezelfde scope, project bij dezelfde klant, geen lus, dieptegrens.
- Nieuwe trigger `content_folders_cascade_scope` (AFTER UPDATE OF client_id, project_id):
  zet de nieuwe scope door naar de directe submappen (die op hun beurt hetzelfde doen) en
  naar de notities en documenten in de map; `updated_at` van die items blijft staan,
  verhuizen is geen inhoudswijziging. SECURITY DEFINER zodat er nooit een halve boom
  achterblijft; de module-poort (`zzz_module_write_gate`, module `content`) blijft gelden.
- `revoke_stale_drive_shares(item_type, item_id)` + triggers `notes_drive_scope_changed`,
  `documents_drive_scope_changed`, `attachments_drive_scope_changed` voor items die zelf
  verhuizen. Intrekken lukt altijd (20260823010000), dus dit kan een verplaatsing nooit
  blokkeren.
- **Productie (`vmxamdjyzquaipdcroqe`) nog niet.**

## Code

- `src/lib/driveDnd.ts` — `DriveLocation` (klant/project/map), `sameLocation`,
  `driveItemLocation` (dezelfde plaatsingsregels als de verkenner: map → ouder in eigen
  scope; bestand → zijn map; notitie/document → zijn map, anders zijn project en dus de
  klant van dat project, anders zijn klant) en `planDriveMove` op een plek in plaats van
  een map-id. Tests in `driveDnd.test.ts` (14, waarvan 7 nieuw).
- `src/lib/repository.ts` — `moveDriveItem(item, target, organizationId)`: één plek voor
  alle vier soorten; notities/documenten krijgen klant, project én map in één update.
- `src/components/MoveDialog.tsx` (nieuw) + CSS `.move-modal`/`.mv-*` in `globals.css`.
- `src/features/ContentLibrary.tsx` en `src/features/ClientFolders.tsx` — `Row.dropTarget`
  (een plek i.p.v. een map-id), projectmappen als sleepdoel, “Terug” en broodkruimels
  als plek, het oude platte verplaats-submenu en de popover in de selectiebalk vervangen
  door het venster. Beide verkenners gedragen zich gelijk.

## Bewust niet

- **Geen slepen tussen klanten.** Zie boven: via het venster, met de klant in beeld.
- **“Bestaande inhoud koppelen”** in het klantdossier is ongewijzigd: dat plaatst een
  notitie in een map zonder zijn projectkoppeling te wissen — een andere handeling dan
  verplaatsen.
- **Momentopnamen in `drive_shares` (client_id/project_id) worden niet herschreven.**
  Herschrijven loopt door de deelregels en zou een verhuizing kunnen blokkeren; wat leest
  (portaal, deellink, `drive_share_items`) leidt de klant toch al live af.

## Verificatie

- `tsc --noEmit`, `npm run build` (vite) en `npm test` (101 tests) slagen.
- Migratie via `supabase db push` op staging toegepast.
- **In een echte browser gecontroleerd** via een tijdelijke proefpagina met verzonnen data
  (daarna verwijderd), omdat de Inhoud-pagina achter een magic-link-login zit:
  - het venster opent op de huidige plek (“Staat hier al.”, knop uit), toont bij een andere
    klant “Verplaatsen naar “Zorggroep Noord”” met de knop aan, verbergt gearchiveerde
    projecten en toont “Geen klant” alleen als er notities of documenten in de selectie
    zitten;
  - een geüpload bestand: in zijn map “Staat hier al.”, op de klantwortel “moet in een map
    blijven staan” (knop uit), in een map van een andere klant wél toegestaan;
  - ⋮-menu van map én bestand bevat “Verplaatsen naar…”;
  - slepen: notitie en map op een projectmap-rij worden geaccepteerd en lichten op, een map
    op zichzelf wordt geweigerd, een document op “Terug” en op de klant-broodkruimel vanuit
    een project wordt geaccepteerd;
  - een mislukte verplaatsing (geen database in het harnas) laat het venster open en toont
    de fout in de verkenner; Escape sluit; donker én licht thema gecontroleerd.
