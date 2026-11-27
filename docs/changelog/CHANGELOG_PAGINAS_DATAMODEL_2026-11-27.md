# Pagina's: het datamodel (2026-11-27)

Stap 1A-1 van het bouwplan voor pagina's (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§3 tot §6 en §18). Dit is het fundament in de database. In het scherm verandert nog niets;
dat komt vanaf stap 1A-2.

## Wat er nu kan of klopt

- **Een pagina is een rij in `documents`** met `format = 'page'`, en de inhoud als JSON in
  `body`, in het formaat van Tiptap, de editor van stap 1A-3. Er zijn nu drie soorten
  documenten: `html` (de huidige tekstdocumenten), `page` en `office` (Word, Excel,
  PowerPoint). De database zet `office` zelf zodra er een bestand aan hangt.
- **De database bewaakt wat er in een pagina staat**, langs elke weg waarlangs geschreven
  wordt (app, Gerrie, MCP, API).
  - Alleen bekende blokken en opmaak.
  - Links alleen naar `https:`, `http:`, `mailto:`, `tel:` of binnen de app.
  - Afbeeldingen en bestanden alleen als bestand in ResoFly, nooit een plaatje van
    buiten. In een klantpagina zou zo'n plaatje een volgpixel zijn.
  - Hoogstens 2 MB, 40 lagen diep en 50.000 blokken.
  - De lijst van wat mag, staat op één plek (`page_body_allowed`), met een spiegel in
    `src/lib/pageSchema.ts`. `pageSchema.test.ts` houdt de twee gelijk.
- **De platte tekst en de korte tekst houdt de database bij.**
  - Bij een pagina maakt hij `content` uit de blokken, in leesvolgorde.
  - Elk document krijgt een `excerpt` van hoogstens 200 tekens, zonder HTML, voor de
    tegels en het klantscherm.
  - Bestaande documenten kregen die korte tekst bij de migratie, zonder dat "laatst
    gewijzigd" verandert en zonder regel in het logboek.
- **Subpagina's.**
  - `parent_id` wijst naar een andere pagina, in dezelfde organisatie, zonder kring en
    hoogstens 20 diep.
  - Klant en project gelden voor de hele boom. Een subpagina erft ze, ook als de app iets
    anders opgeeft.
  - Alleen de bovenste pagina staat in een map. Anders kon een subpagina van klant A in een
    map van klant B staan, en daar via een deling meeliften.
  - Twee gelijktijdige verplaatsingen kunnen samen geen kring maken: per organisatie
    gaat er één tegelijk.
- **Eén tegelijk bewerken.**
  - `claim_page_edit` claimt een pagina, of geeft de hartslag. Een collega ziet wie er
    bewerkt, en kan het pas overnemen na twee minuten stilte.
  - `release_page_edit` laat los.
  - Wie Inhoud alleen mag lezen, claimt niet.
- **Versies** (`document_versions`).
  - `save_page_version` legt vast wat er nu staat, maar niet nog eens als er sinds de
    vorige versie niets veranderde.
  - `restore_page_version` zet een oude versie terug, en dat is zelf weer een nieuwe
    versie.
  - Zelf een versie schrijven, buiten de functies om, kan niet.
- **Zoeken** (`search_documents`).
  - Het zoekt in titel en tekst, met het begin van elk woord ("koff" vindt "Koffie"), en
    alle woorden moeten erin staan.
  - Het geeft de korte tekst terug, nooit HTML, en zoekt met de rechten van wie zoekt.
  - Wat in de prullenbak ligt, telt niet mee.
- **Het logboek** kent de nieuwe velden. `body` komt erin als "gewijzigd", zonder de tekst.

## Afwijkingen van het plan

Ze staan ook in §18 van het plan.

- **Wie bewerkt, staat in een eigen tabel** (`document_edit_claims`), niet op de documentrij.
  Een trigger zet bij elke wijziging `updated_at`, dus een hartslag op de rij zou "laatst
  gewijzigd" elke 30 seconden verzetten.
- **De zoekindex is een expressie-index**, geen kolom. Een kolom zou tot stap 1A-2 bij elke
  start meeladen (`select('*')` in `loadCoreData`).

## Om rekening mee te houden in de volgende stappen

- **Een bovenste pagina naar een andere klant of ander project verplaatsen** werkt elke
  subpagina bij. Dat verzet hun "laatst gewijzigd" en geeft per subpagina een regel in het
  logboek. Dat is bewust: het is ook echt een wijziging voor die pagina.
- **De prullenbak (1A-5) en het delen van pagina's (1C):** `drive_share_items` en
  `drive_folder_tree_items` moeten dan pagina's met `archived_at` overslaan.
- **Definitief verwijderen** neemt de versies mee (`on delete cascade`). Een versie die aan
  een klant is vrijgegeven, moet blijven bestaan. Dat regelt stap 1C, samen met
  `drive_shares.document_version_id`.
- **Een nieuw bloktype**, zoals vermeldingen in fase 2, vraagt een nieuwe migratie voor
  `page_body_allowed` en een regel in `pageSchema.ts`.

## Getest

- `supabase/migrations/20261127130000_paginas_datamodel.sql`: twee keer achter elkaar, en in
  de keten vanaf nul.
- `tests/database/paginas_datamodel.sql`, 39 controles:
  - een pagina maken, en de korte tekst bij een tekstdocument;
  - een onbekend blok, een javascript-link, een plaatje van buiten, een afbeelding zonder
    bestand, iets anders dan een document en onbekende opmaak worden geweigerd;
  - erven twee lagen diep, en de boom gaat mee naar een andere klant;
  - een kring, een tekstdocument als ouder of als subpagina, en een ouder uit een andere
    organisatie worden geweigerd;
  - claimen, de hartslag, overnemen na twee minuten, en weigeren voor wie alleen leest;
  - versies, geen dubbele, zelf schrijven kan niet, en terugzetten;
  - zoeken met en zonder rechten, vanuit een andere organisatie, met een lege vraag, en
    met de prullenbak.
- `src/lib/pageSchema.test.ts`: de lijsten gelijk aan de migratie, en de regel voor links.
- `npm test` (2317), waaronder de rechten op functies en de export.
- `npm run test:database`: alle 15 bestanden.
- `tests/stromen/documenten.mjs` (48 stappen) en `ui.mjs documenten` (9 stappen): het
  bestaande gedrag van documenten, Word-documenten en delen is ongewijzigd.
