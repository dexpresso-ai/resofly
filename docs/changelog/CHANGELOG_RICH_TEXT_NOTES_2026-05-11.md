# Changelog — Rich-text notities — 2026-05-11

## Toegevoegd
- Nieuwe lichte rich-text editor voor notities via `src/components/RichTextEditor.tsx`.
- Toolbar voor paragraaf, titel, subtitel, vet, italic, onderstrepen, bullets, genummerde lijsten, takenlijsten, quotes en links.
- Veilige opslag van notitie-inhoud als beperkte HTML in het bestaande `notes.content` veld.
- Backwards-compatible verwerking van bestaande platte tekstnotities: oude content wordt automatisch als leesbare paragrafen getoond en bewerkt.
- Rich-text preview op notitiekaarten en platte preview in zijbalk/gekoppelde notities.
- Grotere notitie-modal voor meer schrijfruimte.

## Aangepast
- Het notitieformulier gebruikt geen gewone textarea meer voor `content`, maar de nieuwe rich-text editor.
- `cleanForm('note')` sanitizet notitiecontent vóór opslag.
- De generieke `Modal` ondersteunt optioneel een extra CSS-class, zodat alleen de notitie-editor breder wordt.
- CSS uitgebreid met Poppins-gebaseerde editor-, toolbar- en viewer-styling.

## Niet gewijzigd
- Geen database-migratie nodig: het bestaande `notes.content` tekstveld blijft gebruikt worden.
- Geen nieuwe npm-dependencies toegevoegd.
- Bestaande klant-, project- en notitiekoppelingen blijven intact.
