# Pagina's: een pagina die naar een andere klant verhuist, neemt haar subpagina's mee en trekt haar delingen in

28 november 2026. Gevonden bij het nalopen van stap 1C (pagina's delen), op de branch. Zie
`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7 en §11.

## Wat er misging

- **Een pagina onder een pagina van een andere klant zetten ging met alleen `parent_id`.**
  - Zo doet de app het bij slepen (`nestPageUnder`); via de zoekresultaten in de drive kan
    dat over dossiers heen. Een aanroep via de API kan het ook.
  - `documents_page_tree` geeft de pagina dan in een BEFORE-trigger de klant en het project
    van haar nieuwe ouder.
- **Maar een trigger "after update of client_id, project_id" vuurt alleen als die kolommen
  in de update zelf staan**, niet als een BEFORE-trigger ze verandert. Twee dingen bleven zo
  liggen:
  - **de subpagina's hielden de oude klant** (`documents_page_tree_down`), terwijl klant en
    project gelijk moeten zijn aan die van de bovenste pagina;
  - **de delingen van de pagina liepen door** (`documents_drive_scope_changed`, de
    deelhygiëne van 20260903000000).
- **Wat de klant daarvan merkte.** Het portaal leidt de klant bij het lezen opnieuw af: een
  contactpersoon of het hoofdadres van de oude klant zag de pagina daarom niet meer. Een
  geheime link doet dat niet. Na "Bijwerken bij klant" (stap 1C-3) kreeg zo'n link de tekst
  uit het dossier van de nieuwe klant, en een klantpagina hoort nooit via een losse link te
  gaan.

## Wat er nu is

Migratie `20261128150000_paginas_verhuizen.sql`:

- **Beide triggers vuren ook bij een wijziging van `parent_id`.** De functies kijken zelf of
  klant of project echt veranderde.
- **"Bijwerken bij klant" en de status nemen alleen delingen mee waarvan de ontvanger nog bij
  het dossier van de pagina hoort** (`page_share_fits`). Het is dezelfde regel als
  `revoke_stale_drive_shares`:
  - een collega past altijd;
  - een geheime link alleen buiten een klantdossier;
  - het hoofdadres en een contactpersoon alleen bij de klant van het dossier.

  Dit is een vangnet, voor een deling die buiten de triggers om is blijven lopen.
- **`page_share_status` is nu security definer**, met dezelfde leesgrens als eerst: de
  organisatie, de module Inhoud, en niets uit de prullenbak. Als security invoker kon hij het
  project van de pagina niet altijd lezen, en dus het dossier niet bepalen.

## Getest

- **`tests/database/paginas_verhuizen.sql` (8 controles):**
  - een klantpagina met subpagina onder een pagina van een andere klant: de subpagina gaat
    mee, en de deling met een contactpersoon van de oude klant is ingetrokken;
  - een pagina uit het eigen dossier onder een klantpagina: de geheime link is ingetrokken;
  - een deling die buiten de triggers om bleef lopen: de status laat haar weg, en bijwerken
    slaat haar over.

  Vóór de migratie faalde de test op de subpagina, die bij de oude klant bleef.
- **De hele databasetest**: 22 bestanden geslaagd, ook `paginas_bijwerken.sql` met de
  leesrechten van de status. De migratie is twee keer gedraaid.
