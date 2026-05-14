# Changelog — Interactive note checklists — 2026-05-12

## Gewijzigd

- Takenlijsten in rich-text notities zijn nu daadwerkelijk aanvinkbaar in de editor.
- Checklist-items worden opgeslagen met `data-checked="true"` of `data-checked="false"` binnen het bestaande `notes.content` HTML-veld.
- De rich-text sanitizer normaliseert checklist-items en bewaart alleen veilige HTML-attributen/classes.
- Oude cosmetische checklist-items zoals `☐ Nieuwe taak` en `☑ Afgerond` worden automatisch geconverteerd naar de nieuwe interactieve structuur zodra de notitie wordt geopend/gesanitized.
- De preview/weergave van notities toont afgevinkte items visueel als voltooid.
- Plain-text excerpts verwijderen de decoratieve checkbox uit de samenvatting, zodat notitiekaartjes netjes leesbaar blijven.

## Technisch

- `src/components/RichTextEditor.tsx`
  - checklist-sanitizing uitgebreid
  - interactieve checkbox-span toegevoegd
  - klik- en keyboardtoggle toegevoegd
  - backward compatibility voor bestaande `☐`/`☑` checklist-content toegevoegd
- `src/styles/globals.css`
  - oude pseudo-checkbox overschreven
  - nieuwe interactieve checkbox-styling toegevoegd
  - checked-state styling toegevoegd

## Migratie

Geen nieuwe Supabase-migratie nodig. De functionaliteit gebruikt het bestaande `notes.content` veld. De meest recente samengestelde migratie `20260514_calendar_event_notes_complete.sql` blijft leidend.
