# Changelog — Projectoverzicht: albums, recent bewerkte notities en documenten, en het logboek — 2026-11-15

## Aanleiding

> In het project overzicht wil ik ook het volgende overzicht:
>
> * Welke albums er zijn
> * 5 meest recente aangepaste notities en documenten
> * Meest recente logboekactiviteit.

## Wat er mis was

Het tabblad **Overzicht** van een project toonde de eerstvolgende taken, offertes en facturen,
de projectgegevens, de taken per status en het team. Voor de rest moest je een tabblad openen:

- welke albums er zijn, stond alleen in **Galerij**;
- notities en documenten stonden elk in hun eigen tabblad, op aanmaakdatum. Wat het laatst was
  bewerkt, zag je nergens;
- wat er aan het project was veranderd, stond alleen in Instellingen → Logboek, en daar eerst
  na het kiezen van het project in het filter.

## Wat er nu is

Drie nieuwe blokken op het overzicht.

### Notities & documenten

- De vijf die het laatst zijn bewerkt, notities en documenten door elkaar. Het laatst bewerkte
  staat bovenaan.
- Per regel:
  - een icoontje: paars voor een notitie, en voor een document de kleur van het bestandstype
    (Word blauw, Excel groen, PowerPoint oranje);
  - de titel en het soort, zoals "Notitie · Meeting", "Document · Contract" of "Word-document";
  - wanneer het is bewerkt ("4 min geleden", "gisteren 14:05", "12 nov. 2026").
- Een tik opent de notitie of het document.
- Rechtsboven brengen **Notities (n) →** en **Documenten (n) →** je naar het tabblad.
- Bij een leeg project staan er de knoppen **+ Notitie** en **+ Document**.
- Wat telt als bewerkt:
  - Handschrift (pen op tablet) staat in een eigen tabel, en het opslaan daarvan raakt
    `notes.updated_at` niet. Op alleen die kolom zou een notitie waarin je net met de pen
    schreef onder ouder typwerk zakken. Daarom telt de tijd van het handschrift mee.
  - Bij een Office-document telt `last_edited_at` van de editor mee.
- Alleen voor wie de module **Inhoud** mag lezen. Anders stond er "Nog geen notities", terwijl
  je ze alleen niet mag zien.

### Albums

- Alle albums van het project, nieuwste eerst, zoals in het tabblad Galerij. Na zes staat er
  "+n meer albums".
- Per album: het formaat (icoon en woord), wanneer het is gepubliceerd of aangemaakt, of de
  deellink aanstaat, en de status (Concept, Gepubliceerd, Gearchiveerd).
- Een tik opent het album in het tabblad Galerij. Terug (de knop "‹ Galerijen" of de terugknop
  van de telefoon) gaat daar naar de lijst met albums.
- Het blok staat er als het tabblad Galerij er ook staat: met de creatieve module, of als het
  project al albums heeft.

### Logboek

- De zes laatste regels uit het logboek van dit project: taken, notities, documenten, offertes,
  facturen, albums en het project zelf. Wie, wat en wanneer, in dezelfde zinnen als het blok op
  het dashboard.
- Een tik op een regel opent waar hij over gaat, zoals op het dashboard.
- **Alles bekijken →** opent Instellingen → Logboek, al gefilterd op dit project en op de hele
  periode. Met de standaard van 30 dagen bleef die lijst leeg voor een project waarvan de laatste
  wijziging ouder was, terwijl het overzicht hem wél toonde.
- Na elke wijziging en elke Ververs haalt het blok de regels opnieuw op.
- Alleen voor owners en admins, net als het logboek zelf. Teamleden, kijkers en de boekhouder
  zien het blok niet, en de database geeft hun ook geen regel (RLS sinds 20261111140000).

## Hoe

- `src/features/Projects.tsx`: de drie blokken. De albums en de notities en documenten staan
  in de hoofdkolom onder Offertes & facturen. Het logboek staat in de zijkolom onder Taken per
  status. Op de telefoon staan ze in die volgorde onder elkaar.
- `src/lib/projectOverview.ts` (nieuw): welke notities en documenten bovenaan staan.
  `projectOverview.test.ts` test dat, met handschrift en Office-documenten.
- `src/features/AuditLog.tsx`:
  - de regels van het dashboardblok zijn een eigen component (`AuditFeedList`);
  - `ProjectAuditFeed` gebruikt die regels, en haalt zelf de regels van één project op.
    `organizationContext.auditLogs` is de laatste veertig van de hele organisatie; daar zat voor
    een rustig project vaak niets van dat project tussen.
- `src/lib/repository.ts`: `loadProjectAuditLog`. Eén vraag op `project_id`, met de index die
  er sinds 20261108100000 voor is. De database zet het project bij elke regel
  (`audit_context`), dus ook bij taken, notities en albums.
- `src/features/ProjectGallery.tsx`: `GalleryTab` kreeg `startGalleryId`. Dat opent een album
  mét de lijst erachter. `initialGalleryId` (het eigen tabblad) bestond al, maar daar gaat terug
  meteen het project uit.
- Instellingen → Logboek: `settingsNav` kan een project meegeven (`auditProjectId`).
  `openSettings('logboek', { auditProjectId })` opent het logboek op dat project. Elke
  navigatie daarheen begint met verse filters.
- Geen migratie, geen edge function.

## Getest

- `npm run typecheck` en `npm test` (1911 tests, waarvan 5 nieuw in `projectOverview.test.ts`):
  groen.
- `npm run test:mobile -- --theme=both`. De nieuwe pagina `project-overzicht` (project met twee
  albums uit `gallery: true`) controleert dat de drie blokken er staan met een regel erin, en dat
  niets zijwaarts uitloopt. Op de telefoon brak de regel onder een gedeeld album eerst af op een
  los "·", met de deellink alleen eronder; dat is verholpen.
- Met de mock-backend in de browser nagelopen, licht en donker, op 1440px en op de telefoon:
  - een album aantikken opent het in Galerij, met "‹ Galerijen" terug naar de lijst;
  - **Alles bekijken** opent Instellingen → Logboek met "Nieuwe huisstijl De Korenaar" en
    "Alles" in de filters.
- `npm run test:loading` en `npm run test:terugknop`: groen.
