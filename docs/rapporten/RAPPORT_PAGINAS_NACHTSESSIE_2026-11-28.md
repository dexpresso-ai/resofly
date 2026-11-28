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
4. **Open de twee proefbestanden in echte Word: dat is de voorwaarde om de knop "Word" te
   mergen.**
   - In de editor staat nu een knop "Word": de pagina als .docx, in de letters van je
     huisstijl.
   - Het bestand voldoet aan het schema van Word (ECMA-376) en opent goed in LibreOffice.
   - Word zelf kan ik in een cloudsessie niet openen. Vooral de ingesloten letter is daar
     nog niet gezien.
   - Er zijn twee proefbestanden met elk blok: één zonder huisstijl, en één met Playfair
     Display voor koppen en DM Sans voor tekst. Ze staan naast dit rapport:
     - `docs/rapporten/PROEF_WORD_ZONDER_HUISSTIJL_2026-11-28.docx`;
     - `docs/rapporten/PROEF_WORD_HUISSTIJL_PLAYFAIR_DMSANS_2026-11-28.docx`.
   - Wat je ziet: een inhoudsopgave, koppen, lijsten, een takenlijst, een tabel met
     samengevoegde cellen, een kader, een uitklapper, een citaat, code, een subpagina, een
     bijlage en een afbeelding (een rood blok).
   - Let op cursief: de huisstijlletters hebben geen cursieve variant, en LibreOffice nam
     daarvoor een andere letter.
5. **Akkoord met een afwijking van het plan?** §9 laat de server (`page-export`) de DOCX bouwen.
   Voor alleen Word doet de app het nu zelf, met dezelfde module en dezelfde letterkeuze. De
   server komt er pas bij met de PDF. Zie §18, "Afwijking van §9".
6. **Bij de volgende merge: ververs open tabbladen.** Een oude versie van de app kent de nieuwe
   blokken (tabel, kader, afbeelding enzovoort) niet. Ze opent zo'n pagina alleen om te lezen,
   met de knop "App verversen".
7. **De proef met letters (1B-1) graag op de Collabora-container herhalen.** Hier, met
   LibreOffice, bleek: .woff werkt niet, TTF wel, en een letter die in de DOCX is ingesloten
   ook. Op de container moet blijken welke letter hij neemt als de huisstijlletter ontbreekt,
   en of er een emoji-letter is. Zie `docs/rapporten/PROEF_1B1_LETTERS_EMOJI_2026-11-28.md`;
   het script is `scripts/proef-letters-docx.py`.
8. **1C (pagina's delen) heb ik laten liggen.** Dat raakt wat klanten zien, en jij zei: klanten
   lezen pas mee als de eigenaar deelt, en alleen een owner of admin publiceert. Dat wil ik met
   je doorlopen voor ik het bouw.

## Gevonden en gerepareerd

- **Een zwart scherm bij het openen van een pagina, als de editor traag start.**
  - De oorzaak: Tiptap maakt de editor standaard al tijdens de eerste render, en ruimt hem na
    1 ms weer op als zijn effect dan nog niet gedraaid heeft. Op een trage start (de eerste
    keer openen, een trage telefoon) kregen de effecten een editor die al weg was, en viel de
    hele app om.
  - Dat bestond al vóór vannacht, en kon ook op staging gebeuren. De boom naast de pagina
    maakte de start zwaarder, en zo vond de UI-test het.
  - De reparatie: `immediatelyRender: false`, plus een vangnet in elk effect.
  - Een nieuwe UI-stap zet de processor zes keer trager. Zonder de reparatie liep die stap
    vast met precies deze fout; met de reparatie slaagt hij.
  - Zie `docs/changelog/CHANGELOG_PAGINAS_EDITOR_ZWART_SCHERM_2026-11-28.md`.

## Wat er klaarstaat (nog niet op staging)

| Stap | Wat | Changelog |
| --- | --- | --- |
| 1A-4a | Tabel, kader (callout), uitklapper, inhoudsopgave; het blokmenu met `/` en de +-knop. Een pagina met een blok dat de app niet kent, gaat niet open om te bewerken. | `CHANGELOG_PAGINAS_BLOKKEN_2026-11-27.md` |
| 1A-4b | Subpagina's, afbeeldingen (kiezen, plakken, slepen) en bestanden uit het dossier. | `CHANGELOG_PAGINAS_SUBPAGINAS_2026-11-27.md`, `…_AFBEELDINGEN_…`, `…_BESTANDEN_2026-11-28.md` |
| 1A-5a | Subpagina's onder hun pagina in de drive, slepen, het kruimelpad. | `CHANGELOG_PAGINAS_BOOM_2026-11-28.md` |
| 1A-5b | De prullenbak: 30 dagen terugzetten, daarna weg met de bijlagen. | `CHANGELOG_PAGINAS_PRULLENBAK_2026-11-28.md` |
| 1A-5c | Het eigen dossier met mappen, bovenaan de drive, in plaats van "Geen klant"; ook in de vensters van notities en documenten. | `CHANGELOG_EIGEN_DOSSIER_2026-11-28.md` |
| 1A-5e | De boom van het dossier naast de pagina: een kolom, op de telefoon een lade. | `CHANGELOG_PAGINAS_DOSSIERBOOM_2026-11-28.md` |
| §9 | Afdrukken met Ctrl+P: alleen de pagina, over de hele lengte, zwart op wit. | `CHANGELOG_PAGINAS_AFDRUKKEN_2026-11-28.md` |
| §12 | Gerrie (of een gekoppelde AI, een agent, de API) vult een pagina aan: elke regel een alinea onderaan, na een akkoord. Vervangen kan niet. | `CHANGELOG_PAGINAS_GERRIE_AANVULLEN_2026-11-28.md` |
| 1B-2 (deel) | De knop "Word" in de editor: de pagina als .docx, in de letters van de huisstijl. PDF en het exportvenster wachten op Collabora. | `CHANGELOG_PAGINAS_WORD_2026-11-28.md` |

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
    - `paginadrive` (10).
- **De mobiele lay-outtest** duurt lokaal te lang voor een sessie; die draait in de CI.
