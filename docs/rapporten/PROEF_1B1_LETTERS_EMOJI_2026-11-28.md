# Proef 1B-1: huisstijlletters en emoji in een PDF via LibreOffice

28 november 2026, bouwplan pagina's §9 (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`).

> **Voorlopig.** Gedraaid met LibreOffice in een cloudsessie, niet op de Collabora-container
> van staging. Collabora rekent met dezelfde motor, dus wat over LibreOffice zelf gaat, geldt
> daar waarschijnlijk ook. Welke letters en emoji de container heeft, kan alleen de container
> zelf zeggen.

## Opzet

- **De omgeving:**
  - LibreOffice 24.2.7.2, op Ubuntu;
  - FreeType 2.13.2 en fontconfig 2.15.
- **De letters:** Poppins (normaal) en DM Sans (vet), uit `public/fonts/pdf`. Die staan niet
  op deze machine. Inter wel, dus die was geen bruikbare proef.
- **De proefbestanden:** `scripts/proef-letters-docx.py` maakt ze. Elk bestand ging door
  `soffice --headless --convert-to pdf`, met een vers profiel.
- **De controle:** in de PDF met `pdffonts` (welke letter er echt in zit), en met het oog op
  een afbeelding van de pagina.

## Uitkomst

| Proef | Wat | Letters in de PDF |
| --- | --- | --- |
| a | Poppins en DM Sans gevraagd, niet aanwezig | Inter (de vervanger op deze machine) |
| b | De .woff-bestanden geïnstalleerd in `~/.fonts` | Inter: fontconfig kent ze wel (`fc-list`), maar LibreOffice gebruikt ze niet |
| c | Dezelfde letters als TTF geïnstalleerd | Poppins en DM Sans |
| d | Als TTF ingesloten in de DOCX (niet geïnstalleerd) | Poppins en DM Sans |
| e | Emoji en tekens (😀 ✅ ❤️ 👍🏽 🇳🇱, ✓ ☐ ☒ → •) | Noto Color Emoji voor de emoji, in kleur; DejaVu Sans voor een paar tekens |

- **€ en accenten** (café, naïef) staan er goed in, in alle letters.
- **Mogen ze ingesloten worden?** Ja. Alle 17 bestanden in `public/fonts/pdf` hebben fsType 0
  ("installable") en vallen onder de SIL Open Font License (`LICENTIES.md`).
- **Een detail bij emoji:** ❤️ werd een zwart hartje in de regel in Poppins. Daar viel de tekst
  terug op Inter, en Inter heeft zelf een ❤. Een teken dat ook in de tekstletter bestaat,
  komt dus als tekst, niet als emoji. In de regel in Calibri (vervangen door Carlito, zonder ❤)
  werd het hartje rood.

## Wat dit betekent voor de export

1. **.woff is niet genoeg.** Een eigen image met de .woff-bestanden helpt niet. Die moeten dan
   TTF of OTF zijn.
2. **Insluiten in de DOCX werkt, zonder eigen image.** Het voorstel: `page-export` sluit de
   huisstijlletter als TTF in de DOCX in.
   - Word kan een ingesloten letter ook gebruiken: daar is Words eigen optie "Lettertypen
     insluiten" voor. Met Word zelf is dat hier niet getest.
   - Er komt per gewicht 30 à 60 kB bij.
   - De TTF moet uit de .woff komen. Dat kan eenmalig, of in de edge function:
     - WOFF 1 is per tabel met zlib ingepakt, en `DecompressionStream` kan dat uitpakken;
     - `pageDocx.ts` heeft voor insluiten de functie `obfuscate` uit het proefscript nodig, en
       `fontTable.xml`.
3. **Emoji hangen af van een emoji-letter in de container.** Of `collabora/code` Noto Color
   Emoji meebrengt, weten we niet. Zonder emoji-letter worden emoji waarschijnlijk lege vakjes.
   Een emoji-letter insluiten in de DOCX is niet geprobeerd. Noto Color Emoji is hier 10,8 MB,
   dus dat zou elke export zwaar maken; een eigen image met die letter ligt meer voor de hand.

## Nog na te gaan op de Collabora-container van staging

- **Proef a:** welke letter de container neemt als de huisstijlletter ontbreekt.
- **Proef d:** of Collabora's `convert-to` de ingesloten letter net zo gebruikt als LibreOffice
  hier.
- **Proef e:** of er een emoji-letter is.
- **Hoe:** draai het script, en zet de bestanden door de media-worker of rechtstreeks door
  Collabora. Kijk daarna met `pdffonts` in de PDF.
