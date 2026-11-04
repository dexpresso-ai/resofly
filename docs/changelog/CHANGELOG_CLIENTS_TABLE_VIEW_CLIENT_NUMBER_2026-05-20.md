# Changelog — Klanten kaart/tabelweergave + automatisch klantnummer

Datum: 2026-05-20

## Toegevoegd

- Klantenpagina uitgebreid met een weergave-toggle: **Kaarten** of **Tabel**.
- De gekozen klantweergave wordt lokaal onthouden via `localStorage`, zodat de gebruiker bij terugkomst dezelfde weergave ziet.
- Nieuwe compacte tabelweergave toegevoegd met:
  - klantnummer
  - klantnaam
  - contactpersoon/e-mail fallback
  - status
  - aantal offertes
  - aantal facturen
  - openstaand bedrag
  - klantwaarde
  - laatst bijgewerkt
- Tabelrijen zijn klikbaar en ook via toetsenbord te openen met Enter of spatie.
- Nieuwe lege-status toegevoegd voor wanneer er nog geen klanten bestaan.

## Verbeterd

- Klantkaarten blijven bestaan als bestaande standaardweergave.
- Klantenoverzicht heeft nu een duidelijke header met aantallen en actieknoppen.
- Het formulier voor nieuwe/bestaande klanten heeft op desktop een bredere modal gekregen.
- Klantformulier is beter gestructureerd met veldlabels, hints en een visuele klantnummer-intro.
- Velden in het klantformulier respecteren nu de bestaande read-only/permission-state consistenter.

## Automatisch klantnummer

- Bij het aanmaken van een nieuwe klant wordt `client_code` automatisch ingevuld.
- De reeks gebruikt standaard het formaat `KL-001`, `KL-002`, enzovoort.
- Bestaande klantcodes worden gescand op het hoogste eindnummer, zodat de volgende code logisch wordt voorgesteld.
- Geen database-migratie nodig: `client_code` bestond al in schema, types en Supabase-tabellen.

## Bestanden aangepast

- `src/features/Clients.tsx`
- `src/main.tsx`
- `src/styles/globals.css`

## Database

Geen nieuwe Supabase-migratie nodig.
