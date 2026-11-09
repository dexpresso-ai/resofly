# Staging op Postgres 17.11 — 9 november 2026

Vraag: *"Migreer naar de nieuwe postgres versie."*

## Waarom

Staging draaide op Supabase Postgres 17.6.1.111. Lokaal crashte die versie (en 17.6.1.106)
telkens als een ingelogde gebruiker een functie aanriep waar hij geen recht op heeft. In plaats
van *"permission denied"* stopte het databaseproces in de uitbreiding supautils, en de hele
database herstartte even. Elke ingelogde gebruiker kon dat met één aanroep van een
serverfunctie laten gebeuren (ook een klant in het portaal). Gevonden bij de tests van het
klantportaal op een eigen domein (`CHANGELOG_PORTAAL_EIGEN_DOMEIN_2026-11-09.md`). Op staging
is de crash zelf bewust niet uitgeprobeerd.

## Wat er gebeurde

- Eerst lokaal op 17.11.0.018 (de nieuwste stabiele versie die Supabase aanbood): alle 259
  migraties vanaf nul, een geweigerde aanroep geeft weer gewoon *"permission denied"*, en
  `npm run test:stromen` 899 stappen, 0 fout.
- Staging bijgewerkt via de Management API (`POST /v1/projects/<ref>/upgrade`, Postgres 17,
  kanaal ga). Supabase meldde vooraf geen bezwaren: geen extensies die niet meer werken en
  geen objecten die verdwijnen. De upgrade duurde ruim zes minuten; zo lang was staging niet
  bereikbaar.
- Na afloop gecontroleerd: PostgreSQL 17.11, alle 259 migraties (de nieuwste
  `20261109020000`), de gegevens (organisaties en gebruikers) en de zestien geplande taken
  staan er nog.
- `supabase/.temp/postgres-version` volgt staging: nu 17.11.0.018. Daarmee draait ook de lokale
  stack op deze versie (`CLAUDE.md`, *Postgres-versie*).

## Goed om te weten

- Staging heeft geen back-ups die je zelf kunt terugzetten (het overzicht bij Supabase is
  leeg). Een eigen kopie maken vraagt het databasewachtwoord. Voor productie: zet daar
  back-ups aan voordat je zo'n upgrade doet.
- Na de upgrade draaide de rooktest opnieuw: *Deploy Supabase (staging)* met de hand gestart
  (run 201, zonder vinkjes), want een push zonder migraties of functies start die workflow
  niet. Alles in orde op 17.11, ook de controles op het klantportaal.
