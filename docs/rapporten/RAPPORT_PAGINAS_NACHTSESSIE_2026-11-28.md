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
8. **1C (pagina's delen) bouw ik nu, na je "Ga verder".** Het staat op de branch, en gaat pas
   naar staging als jij het zegt. Ik bouw het zoals ik §1 van het plan lees. Bevestig graag
   vóór de merge:
   - **Wie mag delen?** Iedereen met schrijfrechten op Inhoud, zoals nu, altijd als bewuste
     handeling. "Alleen owner en admin" lees ik als de regel voor openbaar publiceren (§17),
     niet voor delen met een klant.
   - **Een subpagina die je niet deelt, bestaat voor de klant niet.** Ook haar titel ziet hij
     niet.
   - **Een bestand in de pagina:** de klant ziet de naam ("Bijlage: offerte.pdf"), maar het
     bestand zelf alleen als je het ook deelt.

   - **Keuzes in het deelvenster (1C-3), graag ook bevestigen:**
     - subpagina's staan standaard uit; je vinkt ze aan, los of allemaal;
     - de ontvanger krijgt één mail, voor de pagina zelf, niet voor elke subpagina;
     - via een deellink gaat alleen de pagina zelf mee, nooit haar subpagina's;
     - "Bijwerken bij klant" stuurt geen mail;
     - deelt Gerrie een pagina, dan ziet de klant haar zoals ze was bij jouw akkoord, niet
       bij het voorstel;
     - gooi je een pagina definitief weg (na de prullenbak), dan verdwijnt ook de deling.

   Vóór 1C kon een pagina nergens bij een klant terechtkomen: gedeelde mappen en zendingen
   slaan pagina's over, en de database weigerde een deling. Sinds 1C-2 neemt de database een
   deling aan, maar alleen met een vrijgegeven versie, en het portaal en de geheime link tonen
   alleen die versie. Sinds 1C-3 kun je in de app een pagina delen en bijwerken.

   **Merge 1C-2, 1C-3 en 1C-4 samen.** In 1C-4 kwam wat de klant ziet: opmaak, afbeeldingen
   en bijlagen die nog in het dossier horen. Bekeken in de browser via een geheime link, die
   hetzelfde leesvenster gebruikt als het portaal. Het portaal zelf is niet in een browser
   bekeken: inloggen vraagt een mail. Wat de server het portaal geeft, is wel getest.

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
| 1C-1 | De omzetting van een pagina naar HTML voor de klant, op de server. Een klant ziet nog niets: delen blijft voor een pagina geweigerd tot de vrijgave er is (1C-2). | `CHANGELOG_PAGINAS_HTML_2026-11-28.md` |
| 1C-2 | Delen is vrijgeven, in de database: een deling van een pagina draagt de vrijgegeven versie, en het portaal en de geheime link tonen alleen die. In de app kun je een pagina nog niet delen (dat is 1C-3). | `CHANGELOG_PAGINAS_DELEN_VRIJGAVE_2026-11-28.md` |
| 1C-3 | Een pagina delen in de app: "Delen" in de editor en de drive, subpagina's aanvinken, en de melding "De klant ziet een oudere versie" met "Bijwerken bij klant". Gerrie deelt een pagina ook, met een vrijgave van wie goedkeurt. | `CHANGELOG_PAGINAS_BIJWERKEN_BIJ_KLANT_2026-11-28.md` |
| 1C-4 | Wat de klant ziet: de pagina met opmaak, kaders, tabellen, taken en afbeeldingen, in het portaal en bij een geheime link. Gerepareerd: samengevoegde cellen en het startnummer van een lijst gingen verloren, en een afgevinkte taak in een gedeelde notitie leek open. | `CHANGELOG_PAGINAS_PORTAAL_WEERGAVE_2026-11-28.md` |

Er komen zes migraties mee die nog niet op staging staan:
- `20261127140000_paginas_blokken`;
- `20261127150000_paginas_verwijzingen`;
- `20261128100000_paginas_prullenbak`;
- `20261128120000_paginas_delen`;
- `20261128130000_paginas_bijwerken_bij_klant`;
- `20261128140000_paginas_portaal_bijlagen`.

Ze mogen opnieuw draaien, en de databasetests lopen ze na.

## Getest

- **De CI op de branch:** runs 304 tot en met 308 zijn helemaal groen. 308 is fe9a4d7 (1C-1 en
  1C-2). Run 309 (a080604, 1C-3 en 1C-4) is gestart. Groen betekent:
  - de migraties vanaf nul met de databasetests;
  - `deno check`;
  - typecheck en de unit tests;
  - de mobiele lay-outtest (donker en licht);
  - laden per module, de inrichting en de terugknop.

  Meer per run in §18 van het bouwplan.
- **Lokaal:**
  - `npm test` en typecheck;
  - de databasetests;
  - de terugknop, en laden per module;
  - de drie UI-scenario's voor pagina's, alle stappen goed:
    - `documenten` (10 stappen);
    - `paginas` (18);
    - `paginadrive` (10).
- **De mobiele lay-outtest** duurt lokaal te lang voor een sessie; die draait in de CI.
