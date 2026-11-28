# Pagina's: versies en een eigen adres (2026-11-27)

Stap 1A-3b van het bouwplan voor pagina's (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§3, §5 en §18).

## Wat er nu kan of klopt

- **Versies.** De knop "Versies" in de editor opent een paneel: rechts naast de tekst, en op
  een telefoon over het hele scherm.
  - Je ziet elke versie, met wat er gebeurde (bewerkt, teruggezet, …), wie en wanneer.
  - Klik je een versie aan, dan zie je hoe de pagina er toen uitzag, met dezelfde blokken als
    in de editor.
  - "Deze versie terugzetten" vraagt eerst of je het zeker weet. Wat er nu staat, wordt eerst
    opgeslagen en als versie bewaard; daarna komt de oude inhoud terug, en dat is zelf weer
    een versie. Er gaat dus niets verloren.
  - Terugzetten kan alleen wie de pagina op dat moment bewerkt. Wie meeleest, kan de versies
    wel bekijken.
- **Een eigen adres per pagina.**
  - Zolang een pagina open is, staat `?pagina=<id>` in de adresbalk. Sluit je hem, dan is
    het weer weg.
  - Verversen opent dezelfde pagina weer.
  - De knop "Link" kopieert het adres, voor een collega. Wie het opent, komt na het laden van
    de werkruimte op die pagina, als hij er toegang toe heeft. Anders zegt de app dat de
    pagina niet bestaat of dat hij er geen toegang toe heeft.
  - De terugknop van de telefoon blijft werken: het adres wordt toegevoegd zonder de stap
    van de terugknop (`lib/backButton.ts`) te verliezen.

## Hoe het werkt

- `src/lib/repository.ts`: `listPageVersions`, `loadPageVersion`, `restorePageVersion`. Ze
  gebruiken de functies en tabellen van stap 1A-1; RLS en de module Inhoud gelden.
- `src/features/PageEditor.tsx`: `VersionsPanel` en `VersionPreview` (een tweede editor,
  alleen lezen).
- `src/main.tsx`: `readPageDeepLink` en `setPageParam`, met twee effecten vóór de vroege
  returns. Een hook ná zo'n return liet de app eerder zwart.

## Om rekening mee te houden

- **Een link naar een pagina van een andere organisatie** opent niet vanzelf in die
  organisatie. De app zegt dat hij er niet is. Eerst van organisatie wisselen werkt wel.
- **Leesbare adressen** (`/werkwijze/oplevering`) horen bij de openbare website (§17), niet
  bij dit adres voor collega's.

## Ook hersteld: ongedaan maken direct na het openen

- **Wat er misging:** de editor zette het laden van een pagina in de geschiedenis van
  "ongedaan maken". Ctrl+Z direct na het openen maakte de pagina dan leeg, en het
  automatisch opslaan schreef die lege pagina weg. Na "Terugzetten" haalde Ctrl+Z de
  vervangen tekst terug.
- **Nu** laadt de editor buiten die geschiedenis (`addToHistory: false` in
  `src/features/PageEditor.tsx`). Direct na het openen en na het terugzetten van een versie
  staat "Ongedaan maken" uit.
- **Getest** in Chromium, op 27 november na de merge naar staging, met de stap "opnieuw
  openen toont de tekst" van `tests/stromen/ui.mjs documenten` (16 stappen, 0 fout):
  - de knop staat uit;
  - Ctrl+Z laat de tekst staan;
  - `edit_version` en "laatst gewijzigd" blijven gelijk.

## Getest

- `tests/stromen/ui.mjs documenten`, 16 stappen, waarvan 2 nieuw:
  - versies: een tweede alinea typen en sluiten, dan versie 1 bekijken (zonder die alinea)
    en terugzetten. De editor en de database hebben daarna de oude tekst. De laatste versie
    is "teruggezet", en de tekst van vóór het terugzetten staat als versie bewaard;
  - het adres staat in de adresbalk zolang de pagina open is, is na sluiten weg, en opent
    vanuit de adresbalk dezelfde pagina.
- `npm test` (2321), `npm run typecheck`, `npm run test:terugknop` (18 gelukt),
  `npm run test:loading`, en `npm run test:mobile` voor de Inhoud-pagina's in licht en donker.
