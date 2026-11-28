# Pagina's: de nachtsessie van 27 op 28 november 2026

Wat er op de branch `claude/affectionate-meitner-arfqck` is gebouwd sinds de laatste merge naar
staging (`416b997`, 27 november 17:07), en wat ik je wil vragen. Er is niets naar staging
gegaan: mergen gebeurt pas als jij het zegt.

Het bouwplan is `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`. In §18 staan de stappen en de
stand voor de overdracht.

## Vragen voor jou

1. **Tekstdocumenten omzetten naar pagina's (1A-5d).** Dat wacht op twee besluiten:
   - Bewaren we de oorspronkelijke HTML van een tekstdocument, en waar?
   - Wat gebeurt er met tekstdocumenten die nu gedeeld zijn?

   Omzetten kan niet terug. Tot 1C er is, neemt het een document ook dingen af: een pagina kun
   je nog niet delen of versturen, en Gerrie vult haar niet aan.
2. **Staat pg_cron aan op staging?** De prullenbak ruimt elke nacht om 03:43 UTC op wat ouder
   is dan 30 dagen (`purge_page_trash`). De migratie plant die taak alleen in als pg_cron er
   is; anders geeft ze een melding en gebeurt er niets.
3. **Wordt de opruimwachtrij op staging geleegd?** De bijlagen van definitief verwijderde
   pagina's gaan naar `storage_purge_queue`. Die wachtrij leegt de opruimtaak van
   `file-transfer` (`?cron=purge`), als die is ingepland. Zie
   `docs/setup/BESTANDEN_VERSTUREN_SETUP.md`. Staat die taak er niet, dan blijven de bestanden
   in de opslag staan.
4. **Open één keer een Word-export in echte Word.** De module die een pagina een .docx maakt,
   is gecontroleerd tegen het schema van Word (ECMA-376) en omgezet in LibreOffice. Word zelf
   kan ik in een cloudsessie niet openen. Een proefbestand met elk blok stuur ik je mee.
5. **Bij de volgende merge: ververs open tabbladen.** Een oude versie van de app kent de nieuwe
   blokken (tabel, kader, afbeelding enzovoort) niet. Ze opent zo'n pagina alleen om te lezen,
   met de knop "App verversen".
6. **De proef met letters (1B-1) graag op de Collabora-container herhalen.** Hier, met
   LibreOffice, bleek: .woff werkt niet, TTF wel, en een letter die in de DOCX is ingesloten
   ook. Op de container moet blijken welke letter hij neemt als de huisstijlletter ontbreekt,
   en of er een emoji-letter is. Zie `docs/rapporten/PROEF_1B1_LETTERS_EMOJI_2026-11-28.md`;
   het script is `scripts/proef-letters-docx.py`.
7. **1C (pagina's delen) heb ik laten liggen.** Dat raakt wat klanten zien, en jij zei: klanten
   lezen pas mee als de eigenaar deelt, en alleen een owner of admin publiceert. Dat wil ik met
   je doorlopen voor ik het bouw.

## Wat er klaarstaat (nog niet op staging)

| Stap | Wat | Changelog |
| --- | --- | --- |
| 1A-4a | Tabel, kader (callout), uitklapper, inhoudsopgave; het blokmenu met `/` en de +-knop. Een pagina met een blok dat de app niet kent, gaat niet open om te bewerken. | `CHANGELOG_PAGINAS_BLOKKEN_2026-11-27.md` |
| 1A-4b | Subpagina's, afbeeldingen (kiezen, plakken, slepen) en bestanden uit het dossier. | `CHANGELOG_PAGINAS_SUBPAGINAS_2026-11-27.md`, `…_AFBEELDINGEN_…`, `…_BESTANDEN_2026-11-28.md` |
| 1A-5a | Subpagina's onder hun pagina in de drive, slepen, het kruimelpad. | `CHANGELOG_PAGINAS_BOOM_2026-11-28.md` |
| 1A-5b | De prullenbak: 30 dagen terugzetten, daarna weg met de bijlagen. | `CHANGELOG_PAGINAS_PRULLENBAK_2026-11-28.md` |
| 1A-5c | Het eigen dossier met mappen, bovenaan de drive, in plaats van "Geen klant"; ook in de vensters van notities en documenten. | `CHANGELOG_EIGEN_DOSSIER_2026-11-28.md` |
| 1A-5e | De boom van het dossier naast de pagina: een kolom, op de telefoon een lade. | `CHANGELOG_PAGINAS_DOSSIERBOOM_2026-11-28.md` |
| 1B-2 (deel) | De omzetting van een pagina naar Word, als module met tests. Nog zonder knop: de export loopt straks via de server en Collabora. | `CHANGELOG_PAGINAS_WORD_2026-11-28.md` |

Er komen drie migraties mee die nog niet op staging staan:
- `20261127140000_paginas_blokken`;
- `20261127150000_paginas_verwijzingen`;
- `20261128100000_paginas_prullenbak`.

Ze mogen opnieuw draaien, en de databasetests lopen ze na.

## Getest

- **De CI op de branch:** run 304 (commit ba3ee84) is helemaal groen. Latere runs staan in
  §18 van het bouwplan.
- **Lokaal:**
  - `npm test` en typecheck;
  - de databasetests;
  - de terugknop, en laden per module;
  - de drie UI-scenario's voor pagina's, alle stappen goed:
    - `documenten` (10 stappen);
    - `paginas` (18);
    - `paginadrive` (6).
- **De mobiele lay-outtest** duurt lokaal te lang voor een sessie; die draait in de CI.
