# Pagina's: de nachtsessie van 27 op 28 november 2026

Wat er op de branch `claude/affectionate-meitner-arfqck` is gebouwd sinds de merge naar staging
van 27 november 17:07 (`416b997`), en wat ik je wil vragen.

**Op 28 november om 09:34 UTC naar staging gezet, op jouw verzoek** (`59fab7e`).
- De uitrol is geslaagd: de zeven migraties, de edge functions en de rooktest.
- Overgeslagen: de Word-proef in echte Word (vraag 4) en de bevestiging van de keuzes van 1C
  (vraag 8). Die vragen blijven staan.
- Ververs open tabbladen: een oude versie van de app opent een pagina met nieuwe blokken alleen
  om te lezen.

Het bouwplan is `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`. In §18 staan de stappen en de
stand voor de overdracht.

**Om 16:48 UTC fase 2 tot en met 2-2a naar staging gezet, op jouw verzoek** (`7250aff`).
- Wat erin zit:
  - kolommen (2-0);
  - @-vermeldingen met de kiezer (2-1a, 2-1b);
  - "Genoemd in" bij een klant en een project (2-1c);
  - actiepunten worden taken (2-2a);
  - geen namen meer in een kopie voor het dossier (vraag 12).
- De uitrol is geslaagd (run 269).
  - Beide migraties zijn toegepast; het deploylog noemt `20261128160000_paginas_vermeldingen.sql`
    en `20261128170000_paginas_taken.sql`.
  - De edge functions staan er.
  - De rooktest is geslaagd, ook "elke organisatietabel is afgeschermd" (met `page_mentions`).
- De CI op staging (run 321) loopt nog.
- Ververs open tabbladen. Een oude versie van de app kent kolommen en vermeldingen niet, en
  opent zo'n pagina alleen om te lezen.

**Om 14:39 UTC ook de PDF (1B-5) naar staging gezet, op jouw verzoek** (`abe8b06`).
- De uitrol is geslaagd. `page-export` staat er; de rooktest heeft dat nagekeken.
- De CI op staging (run 317) is helemaal groen.
- Rol nu de media-worker uit: `docs/setup/PAGINA_PDF_SETUP.md`. Tot dan zegt het exportvenster
  dat de PDF er nog niet is; Word downloaden kan wel.

**Om 11:46 UTC ook de export naar staging gezet, op jouw verzoek** (`3be4452`): 1B-3 tot en
met 1B-4c.
- Wat erin zit: het exportvenster, de Word-kopie, het voorblad, de inhoudsopgave, de
  hoofdstukken, het briefpapier, en de kop en voet in de huisstijl.
- De uitrol is geslaagd, met de rooktest. Er zijn geen migraties.
- Daarna ga ik verder met de PDF (1B-5), zoals §9 het zegt: de server bouwt de Word-file, en
  Collabora maakt er via de media-worker een PDF van. Die worker rol jij uit. Dat staat op de
  branch tot je weer zegt dat het naar staging mag.

**Na de merge van 14:39: fase 2 begonnen, op de branch** (na je "houw verder"). Fase 1 is af,
op 1A-5d na. Fase 2 staat nu in stappen in §18 van het bouwplan.
- **2-0, kolommen**: twee of drie naast elkaar, op de telefoon onder elkaar. Geen migratie.
- **2-1a, @-vermeldingen, de basis**: een klant, project, taak, factuur of collega in de tekst,
  als chip.
  - In de pagina staan alleen de soort en het id, geen naam. De naam komt met de rechten van
    wie kijkt, en anders staat de soort er.
  - Een migratie: `20261128160000_paginas_vermeldingen.sql`.
  - "Genoemd in" kwam in 2-1c, zie hieronder.
- **2-1b, de @-kiezer**: typ @ en een stuk van een naam, en kies. Een chip opent wat hij noemt;
  bij bewerken via "Openen" in de balk, zodat een klik om de cursor te zetten niets opent.
  - Een kopie voor het dossier (de Word-kopie, de vastgelegde PDF) krijgt geen namen meer,
    ook niet op het voorblad (vraag 12).
  - De CI (run 319) is helemaal groen, ook de migratie vanaf een lege database en `deno
    check` op de nieuwe code.
- **2-1c, "Genoemd in"**: bij een klant en een project een paneel met de pagina's die hen
  noemen, en waar die staan. Een tik opent de pagina.
  - Alleen wat je mag lezen. Zonder Inhoud geen paneel. Een plek die je niet mag zien heet
    "Ander dossier".
  - Geen migratie; het leest de tabel van 2-1a.
- **2-2a, actiepunten worden taken**: zet de cursor in een regel van een takenlijst en kies "Maak
  er een taak van". De taak komt in het project van de pagina; achter de regel staat dan "Taak ·
  Te doen", en het taakvenster zegt uit welke pagina ze komt.
  - De link staat bij de taak, niet in de pagina. Wie Projecten niet mag lezen, de klant en de
    export zien een gewone takenlijst.
  - Een migratie: `20261128170000_paginas_taken.sql`.
  - Het vinkje en de taak samen komen in 2-2b.
- Om 16:48 op staging gezet (`7250aff`), met beide migraties. Daarvoor gold: de migratie moest uiterlijk
  samen met de @-kiezer naar staging. Komt de app eerder live dan de migratie, dan weigert de
  database de vermeldingen die de kiezer maakt.

## Wat ik van je nodig heb, op volgorde

1. **De PDF (1B-5) staat op staging** (vraag 10). Na je "ga door met het plan" heb ik hem
   gebouwd zoals §9 zegt: de server maakt de Word-file.
   - Een briefpapier dat een PDF is, komt onder elke bladzijde van de PDF. In Word komt het
     niet; dat zegt het venster.
   - Rol de media-worker uit; hoe dat gaat, staat in `docs/setup/PAGINA_PDF_SETUP.md`.
   - Tot de worker is uitgerold, zegt het exportvenster dat de PDF er nog niet is.
2. **Open de vier proefbestanden in echte Word** (vragen 4 en 11):
   - zonder huisstijl;
   - met huisstijl;
   - met alle opties;
   - met briefpapier.

   Zeg wat er niet klopt.
3. **Bevestig de keuzes van 1C** (vraag 8).
4. **De export staat op staging** (`3be4452`). Loop daar na:
   - één Word-kopie bewerken en bewaren in Collabora (vraag 11);
   - één gedeelde pagina met een afbeelding in het portaal bekijken (vraag 9);
   - open tabbladen verversen (vraag 6).
5. **Tekstdocumenten omzetten (1A-5d): twee besluiten** (vraag 1). Omzetten kan niet terug.
6. **Mag de klant de naam zien bij een @-vermelding in een gedeelde pagina?** (vraag 12). Nu
   ziet hij alleen de soort.
7. **Staging nakijken:**
   - staat pg_cron aan (vraag 2)?
   - wordt de opruimwachtrij geleegd (vraag 3)?
   - de letterproef op de Collabora-container (vraag 7).

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
4. **Open de proefbestanden in echte Word: dat is de voorwaarde om de knop "Word" te
   mergen.** (Sinds 1B-4c zijn het er vier; ze komen uit `scripts/proef-word-export.mjs`.)
   - In de editor staat nu een knop "Word": de pagina als .docx, in de letters van je
     huisstijl. Sinds 1B-3 heet die knop "Exporteren", met daarin "Word downloaden".
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
   - Sinds 1B-4c staan er nog twee naast: met alle opties, en met briefpapier. In de
     proefbestanden is de huisstijl verzonnen; dat is geen fout:
     - het logo ("Studio Noord", een blauw vlak met een lichte balk);
     - de lijn in de kop;
     - de voettekst "Studio Noord · Havenstraat 1, Noorddorp";
     - het briefpapier met de blauwe en lichte band.

     In de app komen het logo, de merkkleur en de voettekst uit jouw Huisstijl, en het
     briefpapier uit Documentopmaak.
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
8. **1C (pagina's delen) is gebouwd, na je "Ga verder".** Het staat op de branch, en gaat pas
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
     - gooi je een pagina definitief weg (na de prullenbak), dan verdwijnt ook de deling;
     - trek je de deling van een pagina in, dan blijven de delingen van haar subpagina's
       staan: elke subpagina is een eigen deling, die je apart intrekt.

   Vóór 1C kon een pagina nergens bij een klant terechtkomen: gedeelde mappen en zendingen
   slaan pagina's over, en de database weigerde een deling. Sinds 1C-2 neemt de database een
   deling aan, maar alleen met een vrijgegeven versie, en het portaal en de geheime link tonen
   alleen die versie. Sinds 1C-3 kun je in de app een pagina delen en bijwerken.

   **1C-2, 1C-3 en 1C-4 zijn samen naar staging gegaan** (28 november). In 1C-4 kwam wat de
   klant ziet: opmaak, afbeeldingen en bijlagen die nog in het dossier horen. Bekeken in de browser via een geheime link, die
   hetzelfde leesvenster gebruikt als het portaal. Het portaal zelf is niet in een browser
   bekeken: inloggen vraagt een mail. Wat de server het portaal geeft, is wel getest.

9. **Kijk na de merge één gedeelde pagina met een afbeelding na in het portaal op staging.**
   - De afbeelding komt via een getekende link van de media-worker. Hier is dat alleen met
     een nagebootste worker getest.
   - Bij het lezen van de code klopt het: een upload krijgt de sleutel `org/document/…`, die
     mag naar buiten, en het beeldtype dat de worker voor `inline=1` nodig heeft, wordt bij
     het uploaden opgeslagen.
   - Staat er alleen "[Afbeelding]", dan ligt het aan de koppeling met de worker.
10. **De PDF (1B-5): twee antwoorden nodig.** Die stap bouw ik pas als je ze gegeven hebt.
    - **Rol jij de media-worker uit?** De PDF komt via Collabora, met een nieuw intern pad in de
      media-worker. Die rol je uit met wrangler; vanuit een cloudsessie kan dat niet.
    - **Moet de server de Word-file bouwen, of mag dat in de app blijven?**
      - Op de server kunnen Gerrie en de API ook zonder browser exporteren.
      - In de app (zoals nu) is het eenvoudiger; dan bouwt de server alleen de PDF.

    Tot dan kun je afdrukken via Exporteren, en in het afdrukvenster "Opslaan als PDF" kiezen.

    Na de merge van 11:46 zei je "ga door met het plan". Ik lees dat als de weg van §9: de
    server bouwt de Word-file (`page-export`). De eerste vraag, wie de worker uitrolt, blijft
    staan.
11. **Na de volgende merge: maak één Word-document van een pagina op staging, bewerk het en
    bewaar het.** Dat is "Maak er een Word-document van" (1B-3). Open ook
    `docs/rapporten/PROEF_WORD_OPTIES_2026-11-28.docx` in echte Word: een voorblad met logo,
    een inhoudsopgave en drie hoofdstukken (1B-4a). Werk in Word de inhoudsopgave bij (F9);
    dan komen de paginanummers erbij. En `docs/rapporten/PROEF_WORD_BRIEFPAPIER_2026-11-28.docx`:
    een briefpapier met een blauwe kopband en een voetband achter elke bladzijde (1B-4b).
    - De test hier bootst de worker en Collabora na. Een proef met LibreOffice, de motor van
      Collabora, ging goed: het bestand overleeft opnieuw opslaan.
    - Let op de grootte. Na de eerste keer bewaren in Collabora werd het bestand in de proef
      veel groter (107 kB werd 2 MB): LibreOffice sluit dan alle letters in hun geheel in.

12. **@-vermeldingen in een gedeelde pagina (2-1a): mag de klant de naam zien?** Een pagina kan
    een klant, project, taak, factuur of collega noemen. Deel je die pagina, dan ziet de klant
    nu alleen de soort ("project", "factuur"), geen naam. Dat is de strenge standaard, zoals bij
    een subpagina die niet gedeeld is.
    - Wel de naam: de klant ziet bijvoorbeeld "Verbouwing 2026" of "F-2026-014". Dat lekt
      niets als het over hemzelf gaat, maar wel als de pagina een andere klant noemt.
    - Een middenweg: alleen namen van de klant zelf en zijn eigen projecten.
    - Hetzelfde geldt voor een kopie in het dossier: de Word-kopie en de vastgelegde PDF. Die
      kan iedereen met Inhoud openen, ook wie de klant niet mag zien. Daar staat nu ook de
      soort, en op het voorblad geen klant of project meer. Dat laatste deden ze sinds 1B-4a,
      en het staat op staging. Een download houdt de namen. Wil je de namen ook in een kopie,
      zeg het dan.
13. **Een ticket wissen waar een taak aan hangt, mislukt voor wie Projecten niet mag
    schrijven** (gevonden bij 2-2a, nog niet gerepareerd). `tasks.ticket_id` wijst met een
    foreign key naar het ticket (`on delete set null`, migratie `20260822020000`). Wissen
    verandert dan ook de taak, en de schrijfpoort van Projecten houdt dat tegen: "Geen toegang
    tot de module projects in deze organisatie". Lokaal nagespeeld in een teruggedraaide
    transactie, met iemand die Tickets mag schrijven en Projecten niet. Voor pagina's heb ik dat in 2-2a vermeden: daar
    is de link zonder foreign key. Wil je dat ik het voor tickets ook zo oplos, zeg het dan.
    Dat raakt de tickets, niet de pagina's.
14. **De titel van een taak uit een pagina noemt de klant bij naam** (2-2a). Staat er in de
    regel een vermelding, dan komt de naam die jij ziet in de titel, zoals wanneer je de taak
    zelf typt. Wie Projecten mag lezen maar Klanten niet, ziet die naam dan in de taak, en in
    het logboek. Dat is het omgekeerde van de kopieën in het dossier (vraag 12), waar ik de
    namen juist weglaat. Liever de soort ("klant") in de titel? Zeg het dan.

## Gevonden en gerepareerd

- **Een pagina die naar een andere klant verhuisde, liet haar subpagina's en delingen
  achter.**
  - Een pagina onder een pagina van een andere klant zetten (slepen in de drive, of via de
    API) gaf haar de nieuwe klant, maar haar subpagina's bleven bij de oude.
  - Haar delingen liepen door. Na "Bijwerken bij klant" kon een geheime link zo de tekst uit
    het dossier van de nieuwe klant tonen.
  - De oorzaak: een databasetrigger die alleen keek naar een wijziging van de klant zelf,
    niet naar een nieuwe ouder.
  - Gerepareerd met migratie `20261128150000`, en getest met `paginas_verhuizen.sql`. Zie
    `docs/changelog/CHANGELOG_PAGINAS_VERHUIZEN_2026-11-28.md`.
- **De sanitizer van het leesvenster haalde samengevoegde cellen en het startnummer van een
  lijst weg**, en **een afgevinkte taak in een gedeelde notitie leek open.** Beide gevonden
  met de nieuwe browsertest, en gerepareerd. Zie
  `docs/changelog/CHANGELOG_PAGINAS_PORTAAL_WEERGAVE_2026-11-28.md`.

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

## Na de merge van 09:34 gebouwd

1B-3 tot en met 1B-4c staan sinds 11:46 UTC op staging (`3be4452`), en 1B-5 sinds 14:39 UTC
(`abe8b06`).

| Stap | Wat | Changelog |
| --- | --- | --- |
| 1B-3 | "Exporteren" in de editor: Word downloaden, "Maak er een Word-document van" (een Word-document naast de pagina, dat meteen opent in Word) en afdrukken. | `CHANGELOG_PAGINAS_EXPORTEREN_2026-11-28.md` |
| 1B-4a | De opties voor Word: een voorblad (logo, titel, klant, project, datum), een inhoudsopgave vooraan, en de subpagina's als hoofdstukken. | `CHANGELOG_PAGINAS_EXPORTEREN_2026-11-28.md` |
| 1B-4b | Het briefpapier achter elke bladzijde, als het een afbeelding is (een PDF kan niet in Word), met de marges uit Documentopmaak. Gerepareerd: het voorblad overleefde opnieuw opslaan in Collabora niet goed. | `CHANGELOG_PAGINAS_EXPORTEREN_2026-11-28.md` |
| 1B-4c | De kop en voet in de huisstijl: het logo en een lijn in de merkkleur, de voettekst en het paginanummer. De controle met LibreOffice is nu een script (`scripts/proef-word-rondgang.sh`). | `CHANGELOG_PAGINAS_EXPORTEREN_2026-11-28.md` |
| 1B-5 | Na de merge van 11:46 gebouwd, op staging sinds 14:39 (`abe8b06`): "PDF downloaden" en "Vastleggen in het dossier". De server maakt de Word-file (`page-export`) en de media-worker de PDF (`/internal/office/convert-page`). Een briefpapier dat een PDF is, komt onder elke bladzijde van de PDF (niet in Word). De worker rol jij uit. | `CHANGELOG_PAGINAS_PDF_2026-11-28.md` |

Geen migraties. 1B-5 brengt een nieuwe edge function mee (`page-export`), en een nieuw pad in
de media-worker, die je zelf uitrolt.

Na de merge van 14:39 gebouwd, en om 16:48 naar staging gezet (`7250aff`, fase 2):

| Stap | Wat | Changelog |
| --- | --- | --- |
| 2-0 | Kolommen: twee of drie naast elkaar, op de telefoon onder elkaar. | `CHANGELOG_PAGINAS_KOLOMMEN_2026-11-28.md` |
| 2-1a | @-vermeldingen, de basis: de database, de chip in de editor, Word, de PDF en de klant. Alleen de soort en het id in de pagina. Migratie `20261128160000`. | `CHANGELOG_PAGINAS_VERMELDINGEN_2026-11-28.md` |
| 2-1b | De @-kiezer, en een chip openen. Moet samen met de migratie van 2-1a naar staging. | `CHANGELOG_PAGINAS_VERMELDINGEN_2026-11-28.md` |
| 2-1c | "Genoemd in" bij een klant en een project. Leest de tabel van 2-1a; ook samen met of na die migratie. | `CHANGELOG_PAGINAS_VERMELDINGEN_2026-11-28.md` |
| 2-2a | Een regel in een takenlijst wordt een taak, met een label in de pagina en "Uit pagina" in het taakvenster. Migratie `20261128170000`. | `CHANGELOG_PAGINAS_TAKEN_2026-11-28.md` |

## Wat er op 28 november om 09:34 naar staging ging

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

Er gingen zeven migraties mee:
- `20261127140000_paginas_blokken`;
- `20261127150000_paginas_verwijzingen`;
- `20261128100000_paginas_prullenbak`;
- `20261128120000_paginas_delen`;
- `20261128130000_paginas_bijwerken_bij_klant`;
- `20261128140000_paginas_portaal_bijlagen`;
- `20261128150000_paginas_verhuizen`.

Ze mogen opnieuw draaien, en de databasetests lopen ze na.

## Getest

- **De CI op de branch:** runs 304 tot en met 310, 312, 313, 315 en 316 zijn helemaal groen:
  - 308 is fe9a4d7 (1C-1 en 1C-2);
  - 309 is a080604 (1C-3 en 1C-4);
  - 310 is 983b12d, met de verhuisreparatie (migratie `20261128150000`);
  - 312 is 9b92cc4: na de merge, 1B-3 en 1B-4a;
  - 313 is 0d3ccbe: 1B-4b en 1B-4c;
  - 315 is 504a3f9: 1B-5 deel 1 tot en met 3, de PDF;
  - 316 is 6de3b5d: 1B-5 deel 4, het briefpapier als PDF.

  Runs 311 en 314 op staging (59fab7e en 3be4452, dezelfde code na elke merge) zijn ook
  helemaal groen. Groen betekent:
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
  - de UI-scenario's voor pagina's, alle stappen goed:
    - `documenten` (10 stappen);
    - `paginas` (18);
    - `paginadrive` (10);
    - `paginaexport` (8, na de merge: het exportvenster, de Word-kopie, de opties en het
      briefpapier);
  - na de merge: `scripts/proef-word-rondgang.sh`. De vier proefbestanden zijn geldig vóór en
    na opnieuw opslaan in LibreOffice;
  - de productiebuild (`npm run build`, met nep-waarden voor Supabase). De Word-export blijft
    een eigen stuk bundel, dat pas bij een klik laadt.
- **De mobiele lay-outtest** duurt lokaal te lang voor een sessie; die draait in de CI.
