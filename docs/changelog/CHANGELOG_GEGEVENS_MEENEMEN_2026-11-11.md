# Gegevens meenemen: alles exporteren, en een auditfile inlezen (2026-11-11)

Een bedrijf kan zijn gegevens nu meenemen: weg van ResoFly met één zip, en naar
ResoFly toe met de auditfile van het oude pakket. Dit is fase 1 van
`docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md`. Daar staat ook waarom
het moet (Data Act, AVG, bewaarplicht) en wat de volgende fasen zijn.

## Wat er nu kan

### Alles exporteren (Instellingen → Gegevens)

Een nieuw tabblad, alleen voor de eigenaar. Eén knop maakt een zip die je ook
zonder ResoFly kunt openen:

| In de zip | Wat |
| --- | --- |
| `data/<tabel>.jsonl` | 146 tabellen, elke rij als JSON, alle kolommen, de id's van ResoFly |
| `lijsten/<naam>.csv` | 14 lijsten voor Excel: klanten, contactpersonen, projecten, taken, tickets, uren, offertes, facturen, creditnota's, leveranciers, inkoopfacturen, grootboekrekeningen, vaste activa, banktransacties |
| `boekhouding/auditfile-<boekjaar>.xaf` | de boekhouding per boekjaar (de bestaande `buildXaf`) |
| `bestanden/<soort>/…` | de originele bestanden, en de PDF's van offertes, facturen, creditnota's, contracten en jaarrekeningen zoals ze verstuurd zijn |
| `manifest.json` | formaat, schemaversie, aantallen, SHA-256 per bestand, en wat er niet in zit en waarom |
| `LEESMIJ.txt` | dezelfde uitleg in gewone woorden |

Niet in de zip: 59 tabellen, elk met een reden in het manifest.

- **Galerijen** (6): keuze van 11 november. Die download je per galerij als zip.
- **Sleutels en wachtwoorden** (15): tokens en versleutelde toegang tot Mollie,
  agenda's, de bank en het portaal.
- **Werking van ResoFly** (19): wachtrijen, tellers, leesstatus.
- **Van één teamlid** (5): onder meer de gesprekken met Gerrie.
- **Het abonnement bij ResoFly** (6).
- **Gedeeld door alle organisaties** (8): tarieven en normen.

Daarnaast laat de export 20 kolommen weg die als sleutel werken, zoals de
sleutel van de openbare link van een factuur.

De export leest met de rechten van wie hem maakt. Wat de eigenaar in ResoFly
niet kan zien, zoals de privé-agenda van een collega, zit er dus ook niet in.
Bovendien weigert de export een tabel waarin een rij van een andere
organisatie staat: die tabel blijft uit de zip, met een melding (regel 1).

In het logboek staat daarna "… exporteerde alle gegevens van de organisatie".
Het hele team ziet die regel.

### Een auditfile inlezen (Boekhouding → Beginbalans)

Boven de beginbalans staat nu **Overstappen van een ander pakket?**

1. Kies de auditfile (XAF 3.x) uit je oude pakket. Bestanden in windows-1252 en
   met een namespace-voorvoegsel lezen ook goed. Een auditfile van versie 2
   (CLAIR) krijgt een duidelijke melding.
2. Kies de overstapdatum, standaard de boekhoud-startdatum. ResoFly rekent per
   balansrekening het saldo uit: de beginbalans van het bestand plus alles wat
   vóór die dag geboekt is.
3. Bij elke rekening staat een voorstel welke rekening van ResoFly erbij hoort:
   - dezelfde naam;
   - anders een herkend woord: bank, IBAN, debiteuren, crediteuren, btw,
     kapitaal, inventaris;
   - anders hetzelfde nummer.

   Btw gaat naar 1530. Op 1500, 1510 of 1520 zou hij nog eens in de eerste
   aangifte tellen, en het scherm waarschuwt als je die toch kiest.
4. **Zet in de beginbalans** vult de bestaande regels eronder. Vastleggen blijft
   de bestaande knop, met dezelfde controle en sluitpost.
5. **Voeg toe** maakt de klanten en leveranciers aan, langs dezelfde weg als
   Importeren. Al bekend, en dus overgeslagen, is wie hetzelfde btw-nummer heeft
   of dezelfde naam zonder rechtsvorm ("Jansen B.V." is "Jansen"). Een relatie
   die klant én leverancier is, wordt beide. Klanten toevoegen kan alleen wie
   schrijfrechten op Klanten heeft (regel 3).

De oude boekingen zelf worden geen boekingen in ResoFly. Dan zouden ze
meetellen in btw-aangiftes die het oude pakket al deed.

## Hoe het werkt

| Bestand | Wat |
| --- | --- |
| `src/lib/exportManifest.ts` | per tabel: mee of niet (met reden), weg te laten kolommen, kolommen met bestanden, lijsten |
| `src/lib/exportManifest.test.ts` | leest de migraties; faalt op een tabel die niet in het manifest staat, op een tabel die niet meer bestaat, op een kolom die op een sleutel lijkt en niet is ingedeeld, en op een kolom met een opslagsleutel zonder keuze |
| `src/lib/zipWriter.ts` | zip zonder bibliotheek: CRC-32, ZIP64, UTF-8-namen, deflate via `CompressionStream`, een tabel in stukken (`addStream`) |
| `src/lib/dataExport.ts` | de opbouw achter `ExportSource` (`fetchExportPage` in `repository.ts`, `fetchStoredFileBlob` in `r2.ts`) |
| `src/lib/xafImport.ts` | XAF lezen, saldi op de overstapdatum, voorstellen, regels, relaties |
| `src/features/DataExport.tsx`, `src/features/XafImport.tsx` | de twee schermen |
| `supabase/migrations/20261111120000_gegevens_export_logboek.sql` | `log_data_export` (alleen de eigenaar) en `data_export` in `audit_logs_action_check` |

**Voor wie verder bouwt:**

- **Een nieuwe tabel** zet je in het manifest, anders faalt `npm test`. Dezelfde
  lijst dient later voor het wissen (fase 2).
- **Na elke nieuwe migratie** zet je `EXPORT_SCHEMA_VERSION` op de nieuwste; de
  test zegt het.
- **De mobiele test** kent nu de mock-optie `ledger: true`: alleen voor die
  pagina een organisatie met het standaard rekeningschema.

## Let op

- **De browser bouwt de zip.** Laat het venster open. Zonder galerijen blijft
  een export meestal ruim onder een paar GB, maar voor heel grote organisaties
  hoort de export op de server (fase 4).
- **Bestanden die niet meer in de opslag staan**, of die de worker weigert,
  staan in `manifest.json` en `LEESMIJ.txt`. De export gaat door.
- **Werkt de media-worker niet** (`VITE_R2_WORKER_URL`), dan staan alle
  bestanden als ontbrekend in het manifest; de gegevens zelf komen wel mee.

## Getest

- `npm run typecheck` en `npm test`: groen. Nieuw:
  - `exportManifest.test.ts`;
  - `zipWriter.test.ts`, met een eigen uitpakker die elke CRC tegen die van
    zlib legt, ook bij ZIP64;
  - `dataExport.test.ts`: de hele export met een nep-bron, met een lek van een
    andere organisatie, een ontbrekend bestand, bladeren, stoppen en een tabel
    die niet te lezen is;
  - `xafImport.test.ts`: een rondje via de eigen `buildXaf`, en een bestand van
    een ander pakket;
  - de logboekzin in `auditLog.test.ts`.
- **Zips**: met `python3 zipfile` en `unzip -t` nagelopen, gewoon en ZIP64.
- `npm run build`: slaagt.
- **Lokale database** (`supabase db start`):
  - `supabase db reset`: alle 266 migraties vanaf nul, de nieuwe als laatste;
  - de migratie twee keer achter elkaar toegepast;
  - als eigenaar geeft `log_data_export` een regel, als teamlid "Alleen de
    eigenaar …";
  - het teamlid ziet de regel in het logboek;
  - als eigenaar zijn alle 146 tabellen uit het manifest leesbaar met precies de
    select en sortering van de export (RLS, grants, kolomrechten), zonder één
    weigering.
- **Mobiel**: `npm run test:mobile -- --theme=both`: 500 pagina's, 0
  problemen. Twee standen zijn nieuw: `settings-gegevens` en
  `ledger-beginbalans`.
- **Laden**: `npm run test:loading`: alle controles geslaagd.
- **Los in de browser** (telefoon en laptop, donker en licht): een auditfile
  kiezen, een rekening koppelen, overnemen en relaties toevoegen. Na overnemen
  sloot de beginbalans (debet € 22.840, credit € 19.840, sluitpost € 3.000
  winst). Geen fouten, en niets zijwaarts uit beeld. Op de telefoon schoof de
  koppeltabel eerst zijwaarts; die is nu een kaart per rekening, net als de
  leverancierslijst.

## Nog niet (de volgende fasen)

- Opzeggen als traject (overstap, ophalen, wissen), en een wis-route langs de
  blokkades van de bewaarplicht. Een organisatie die ooit factureerde, is nu nog
  niet te verwijderen.
- Een mail aan alle eigenaren bij een export.
- Openstaande posten, het factuurnummer laten doorlopen, importbatches, en het
  eigen exportformaat weer inlezen.
- Een export per teamlid, en de export op de server voor grote organisaties.
