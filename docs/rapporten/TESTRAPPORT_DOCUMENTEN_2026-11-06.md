# Testrapport documenten — 6 november 2026

Vraag: "Daarna wil ik dat je uitgebreid en nauwkeurig de functionaliteit van de
documenten test op gebruik, functionaliteit en security."

## Wat valt onder "documenten"

- **Tekstdocumenten** in Inhoud: titel, categorie, rich text, gekoppeld aan een
  klant, project en/of map (`documents`).
- **Word, Excel en PowerPoint** (Office-modus): het bestand staat in R2 (via de
  media-worker), bewerken gaat in de online editor (Collabora via WOPI).
- **Mappen** in een klantdossier, en de bestanden die erin staan.
- **Delen**: met de klant via het klantportaal, of met een los adres via een
  geheime link (`file-share`, `file-share-public`, `client-portal`).
- **Rechten**: de module Inhoud (`content`), de rollen, en elke organisatie
  als eigen wereld.

## Hoe getest

| Wat | Waar | Uitkomst |
| --- | --- | --- |
| Eind-tot-eind tegen een lokale stack (echte RLS, triggers en functies) | `tests/stromen/documenten.mjs` | 41 stappen, alle groen na herstel |
| In de browser (Chromium, echte knoppen) | `tests/stromen/ui.mjs documenten` | 6 stappen groen |
| De media-worker zelf, in workerd met lokale R2 | `tests/stromen/werker-documenten.mjs` | 16 stappen groen; tegen de oude worker falen er 4 |
| Twee onafhankelijke code-reviews (worker; database en functies) | — | elke bevinding nagelopen, waar mogelijk nagespeeld |
| Unittests, typecheck, `deno check`, mobiele test, volledige stromentest | `npm test` e.a. | groen |

Eerst de fout laten zien, dan herstellen: elke test hieronder faalde vóór het
herstel. Dat is vastgesteld door hem tegen de oude code of de oude database te
draaien.

## Wat goed zat

- **Rechten.** De kijker leest wel, maar maakt, wijzigt en verwijdert niets. De
  boekhouder ziet geen documenten. Bij Inhoud "geen" zie je niets, bij
  "alleen lezen" lees je wel maar schrijf je niet. Delen vraagt
  schrijfrechten op Inhoud.
- **Andere organisaties.** Die zien, wijzigen en verwijderen niets. Een
  document aanmaken in een andere organisatie kan niet, een document naar een
  andere organisatie verhuizen ook niet, en een bestandssleutel van een andere
  organisatie aan een document hangen evenmin.
- **Delen.**
  - Klantdocumenten gaan alleen naar het portaal van die klant: klant B ziet de
    deling van klant A niet en opent hem ook niet. Een klantdocument kan niet
    via een losse link.
  - Een geheime link is 32 willekeurige bytes. In de database staat alleen de
    hash.
  - Met een link haal je geen ander document op.
  - Ingetrokken of verlopen: de link werkt niet meer. Een verkeerde link geeft
    niets prijs.
- **Kwaadaardige inhoud.** `<script>`, `onerror`, `javascript:`-links, `<svg>` en
  `<iframe>` in een document worden niet uitgevoerd, niet in de app en niet op
  de openbare deelpagina. Gecontroleerd in de browser.
- **Worker.**
  - Andere organisaties zijn afgeschermd.
  - Een document dat naar een factuurbijlage wijst, opent die bijlage niet.
  - Alleen-lezen kan niet schrijven.
  - Een token werkt alleen voor zijn eigen bestand.
  - Downloads gaan als bijlage, met `nosniff`, `CSP: sandbox` en `no-store`.
  - Een HTML-bestand wordt niet als document aangenomen.

## Wat er mis was, en wat er nu gebeurt

| # | Ernst | Wat | Herstel |
| --- | --- | --- | --- |
| 1 | middel | Een document kon aan een klant, project of map van een **andere organisatie** hangen; mappen en notities hadden hetzelfde gat. Wie het id van andermans klant kende, las bij delen diens naam terug in de foutmelding ("Dit hoort bij klantdossier “…”"). | migratie `20261106150000_inhoud_binnen_organisatie` |
| 2 | middel | **Opslagquotum te omzeilen**: de app schrijft de bestandsgrootte zelf, en `-2147483648` werd geaccepteerd (2 GB minder verbruik per rij). Bij twee absurd grote waarden kreeg de teller een fout, en de worker laat dan alles door. | migratie `20261106160000_documenten_opslag` (grenzen 0 tot 1 TB) |
| 3 | middel | Een **verwijderd Word-document** (of conceptcontract in Word) bleef voorgoed in R2: buiten het quotum, en op te halen met de sleutel. | `20261106160000`: de sleutel gaat in de opruimwachtrij |
| 4 | middel | Bij het verwijderen van een **klant of project** gingen de mappen mee, maar de bestanden erin bleven staan (AVG). | `20261106160000`: bestanden gaan mee met hun map |
| 5 | laag | De **maker** van een document, notitie, map of deling was achteraf te wijzigen. Een notitie kon op naam van een collega worden aangemaakt, en "ingetrokken door" was vrij in te vullen. | `20261106150000` |
| 6 | laag | **"Laatst gewijzigd"** liep niet mee na een bewerking via Gerrie, de API of de Word-editor. | `20261106150000` |
| 7 | laag | Een notitie bij een klant opslaan faalde voor een teamlid dat Klanten niet mag zien. Mijn eerste versie van herstel 1 had dat ook voor documenten en klantmappen gedaan; de review ving het. | `20261106150000`: de controles draaien als eigenaar, en alleen bij een wijziging |
| 8 | laag | Gedeelde Word-documenten downloadden **zonder extensie** ("Offerte" in plaats van "Offerte.docx"). | `officeDownloadName` in `file-share-public` en `client-portal` |
| 9 | laag | Na **"Bewerk als Word"** bleef de oude tekst in de rij staan. Lijst, zoeken en Gerrie toonden die ook nadat het document in Word was herschreven. | `src/main.tsx` |
| 10 | laag–middel | Een **WOPI-token** gaf na het intrekken van Inhoud of na vertrek uit het team nog tot 10 uur leesrechten. De editor bleef ook "schrijven" melden. | worker: lidmaatschap en modulerecht opnieuw gecontroleerd bij het lezen |
| 11 | laag | De **PDF-omzetting** nam elke sleutel van de organisatie aan. Via een conceptcontract kon iemand met Financiën een document of chatbijlage als PDF lezen. | worker: alleen contractbestanden |
| 12 | laag | Een kapotte `%`-codering in een bestandsadres gaf een serverfout (500). | worker |

## Wat nog openstaat

**Moet nog gebeuren:**

1. **De media-worker uitrollen.** Herstel 10, 11 en 12 zitten in
   `workers/media-api`. Die gaat niet mee met een push naar staging:
   `cd workers/media-api && npm run deploy:staging`. Daarvoor zijn
   Cloudflare-rechten nodig, die deze sessie niet heeft.
2. **De opruimtaak inplannen.** `file-transfer-purge` stond op staging niet in
   `cron.job`, en `FILE_TRANSFER_CRON_SECRET` ontbrak. Zonder die taak:
   - worden verlopen zendingen van "Bestanden versturen" niet opgeruimd;
   - blijft de opruimwachtrij van herstel 3 en 4 staan.

   Eenmalig regelen: Actions → "Deploy Supabase (staging)" → Run workflow, met
   het vinkje "Eenmalig: … inplannen". Dat zet alleen wat ontbreekt.

**Bekend, niet aangepast (laag, of vraagt een keuze):**

- **Modulerecht bij verwijderen.** Bij het verwijderen van een klant controleert
  de database ook het modulerecht op de documenten en mappen van die klant. Wie
  Klanten mag schrijven maar Inhoud niet, kan zo'n klant daardoor niet
  verwijderen. Dat is bestaand gedrag; wat de bedoeling is, moet je kiezen.
- **Projectmap hernoemen.** `validate_content_folder` draait met de rechten van
  de gebruiker. Wie Projecten niet mag lezen, kan een projectmap niet
  hernoemen. Dat is bestaand gedrag.
- **Worker: `/file/<sleutel>`.**
  - Chatbijlagen: de deelnemersregel wordt hier niet gecontroleerd.
  - Opnames (`meeting_recording`): er wordt geen module gecontroleerd.

  In beide gevallen is een bekende sleutel nodig.
- **Worker: overige punten.**
  - `/office/health` wekt Collabora zonder login. Dat kost alleen geld.
  - Office-uploads worden alleen op mimetype gecontroleerd, niet op de inhoud
    van het bestand.
  - Het WOPI-token staat in de query, dus in logs. Er zijn geen proof keys.
- **Delen.**
  - Via de API kan een deling zonder vervaldatum worden gemaakt; de app zet
    standaard 30 dagen.
  - `/gedeeld` heeft geen tweede factor (`/ontvang` wel).
  - `file-share` eist geen Klanten-recht om met een klant of contactpersoon te
    delen; `file-transfer` wel.
  - Een deling die `file-share` maakt, staat in het auditlog zonder actor.
    Downloads via een publieke link worden niet geteld.
- **Grootte en type.** Bestandsgrootte, type en sleutel schrijft de app nog
  zelf. Er gelden nu grenzen, maar beter is dat alleen de server ze zet.

## Herhalen

```bash
npm run test:stromen -- documenten
node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs documenten
node tests/stromen/werker-documenten.mjs     # met de worker in wrangler dev, zie tests/stromen/README.md
```
