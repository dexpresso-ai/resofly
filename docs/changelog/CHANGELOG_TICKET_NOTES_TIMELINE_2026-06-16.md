# Changelog — Tickettijdlijn met klant- & medewerkernotities + portaal-doorklik — 2026-06-16

## Toegevoegd
- Nieuwe tabel `public.ticket_notes` (migratie `20260616000001_ticket_notes_timeline.sql`): gedeelde notitie-/conversatietijdlijn per ticket met `author_type` (`user`/`client`), `is_internal` (verborgen voor klant), `author_name`-snapshot en `body`.
  - RLS: lezen/schrijven uitsluitend voor actieve organisatieleden (zelfde patroon als `notes`/`documents`).
  - Check-constraint: klantnotities (`author_type = 'client'`) kunnen nooit als intern worden gemarkeerd; lege notities zijn niet toegestaan.
  - Triggers: `prevent_organization_id_change`, audit (`ticket_note`) en automatische `updated_at`.
- Medewerkers-app: nieuwe **Tijdlijn**-sectie in de ticket-editor (`TicketNotesTimeline` in `src/main.tsx`).
  - Plaats notities met een duidelijke zichtbaarheidsschakelaar **Zichtbaar voor klant** ↔ **Verborgen voor klant**.
  - Per notitie een badge (Klant / Intern / Zichtbaar voor klant), auteur en tijdstempel; eigen/teamnotities zijn achteraf te verbergen/zichtbaar te maken of te verwijderen.
- Klantportaal (`/portal`): doorklik-functionaliteit.
  - **Tickets** zijn aanklikbaar → detailweergave met de conversatietijdlijn (alleen klantzichtbare notities) en een invoerveld om zelf een bericht/notitie te plaatsen.
  - **Projecten** zijn aanklikbaar → "live meekijken": projectinfo, voortgangsbalk en live taakstatussen (Te doen / Bezig / Review / Klaar) met een ververs-knop.
- `client-portal` edge function: nieuwe acties `getTicketThread`, `addTicketNote` en `getProjectDetail`. Toegang wordt afgeleid uit het geverifieerde e-mailadres; interne notities worden server-side weggefilterd en verlaten de server nooit.
- Repository-helpers `createTicketNote`, `setTicketNoteInternal`, `deleteTicketNote` en `selectTicketNotes`; portaal-helpers `fetchPortalTicketThread`, `addPortalTicketNote`, `fetchPortalProjectDetail`.

## Aangepast
- `AppData` bevat nu `ticketNotes`; `loadAppData` laadt ze mee (met nette fallback als de migratie nog niet is uitgevoerd).
- De ticket-editor toont het bestaande `notes`-veld nu expliciet als **privé interne notitie** (los van de tijdlijn).
- CSS uitgebreid met tijdlijn-styling (medewerkers-app) en portaal-detail/-conversatie/-voortgangsstyling.

## Beveiliging / privacy
- Interne notities (`is_internal = true`) worden uitsluitend in de medewerkers-app getoond; de portaal-acties geven ze nooit terug.
- Klantnotities zijn altijd zichtbaar (`is_internal = false`, afgedwongen via DB-constraint).
- Het portaal blijft volledig via de service-role edge function lopen; RLS is niet versoepeld voor klanten.

## Nog te doen bij uitrol
- Migratie `20260616000001_ticket_notes_timeline.sql` op de database uitvoeren.
- De `client-portal` edge function opnieuw deployen (nieuwe acties).

## Niet gewijzigd
- Geen nieuwe npm-dependencies.
- Bestaande ticketvelden, conversie naar project en bijlagen blijven intact.
