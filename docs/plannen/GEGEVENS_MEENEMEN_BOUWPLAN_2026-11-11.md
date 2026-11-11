# Bouwplan: gegevens meenemen, naar ResoFly toe en van ResoFly af (2026-11-11)

> **Stand op 11 november 2026: fase 1 gebouwd.** Zie
> `docs/changelog/CHANGELOG_GEGEVENS_MEENEMEN_2026-11-11.md`. Fase 2 (opzeggen,
> ophalen, wissen) moet er staan vóór de eerste betalende klant.

Vraag: *Op het moment dat bedrijven over willen stappen naar ResoFly of vanuit ResoFly naar
elders, moeten we ze de mogelijkheid geven om de data die alleen van de klant is te
exporteren.* Daarna: *data van galerijen hoeft niet mee; het gaat om de data binnen ResoFly.*

**Kort.** Gegevens meenemen wordt een vaste functie, geen klus op aanvraag:

1. **Alles exporteren**: één knop voor de eigenaar. Die maakt een zip die ook zonder ResoFly
   te lezen is, voor de accountant en voor het volgende pakket. Galerijen zitten er niet in.
2. **Een manifest in de code** legt per tabel vast of hij meegaat, en waarom niet. Een test
   faalt als een migratie een tabel toevoegt die er niet in staat.
3. **Opzeggen wordt een traject**: overstappen, dan ophalen, dan wissen. Dat ontbreekt nu
   helemaal.
4. **Overstappen naar ResoFly** begint bij een auditfile (XAF) uit het oude pakket: die levert
   de klanten, de leveranciers en de beginbalans.

## 1. Waarom het moet

- **Data Act** (EU-dataverordening 2023/2854, hoofdstuk VI). Geldt sinds 12 september 2025
  voor elke SaaS-leverancier.
  - Een klant mag overstappen met hoogstens twee maanden opzegtermijn.
  - Daarna volgt een overstapperiode van 30 dagen waarin alles blijft werken.
  - Daarna heeft de klant minstens 30 dagen om alles op te halen. Pas dan wis je.
  - Vanaf 12 januari 2027 mag overstappen niets kosten.
  - "Exporteerbaar" is invoer én uitvoer, met metadata. Vooraf beschrijf je wat meekomt, wat
    niet, en in welk formaat.

  Het voorstel voor een mkb-uitzondering (de Digital Omnibus) geldt alleen voor contracten van
  vóór 12 september 2025. ResoFly heeft nog geen productie, dus voor ons telt het niet.
- **AVG, art. 28 lid 3 sub g.** Als verwerker geef je de persoonsgegevens aan het eind terug of
  wis je ze, naar keuze van de klant.
- **Bewaarplicht, 7 jaar (art. 52 AWR).** Die blijft bij de klant, ook na vertrek. De export
  moet dus genoeg zijn voor een controle: grootboek, facturen zoals verstuurd, inkoopbonnen,
  bank.

Laat de termijnen en de teksten in de voorwaarden toetsen door een jurist.

## 2. Wat er al was (11 november 2026)

- XAF 3.2 per boekjaar (`src/lib/xaf.ts`), in de browser.
- CSV-exports bij rapporten, UBL bij e-facturen, de verstuurde PDF's als vaste kopie in R2.
- Import: klanten en leveranciers (CSV), bank (CAMT.053, MT940, CSV), salaris, beginbalans
  (met de hand).
- De API: zeven vaste adressen, bladeren tot offset 10.000. Niet geschikt voor alles.

Wat ontbrak:

- Een export van alles.
- **Een einde na opzeggen.** `cancelSubscription` (`supabase/functions/billing/index.ts`) zet
  alleen de status op `cancelled`. De gegevens blijven voor altijd staan.
- **Wissen.** `invoices_block_delete` (migratie `20260721000000`) weigert elke verstuurde
  factuur, ook als de organisatie zelf wordt verwijderd (de cascade). Offertes, contracten en
  bankrekeningen met boekingen hebben dezelfde blokkade. Een organisatie die ooit factureerde,
  kun je nu niet verwijderen.

## 3. Wat is "van de klant"?

Alle gegevens die ontstaan door het gebruik van ResoFly, invoer én uitvoer: klanten, facturen,
het journaal, uren, tickets, versies, het logboek, de PDF's zoals verstuurd, de bestanden.

**Niet in de export**, met de reden in `src/lib/exportManifest.ts`:

| Soort | Waarom niet | Voorbeelden |
| --- | --- | --- |
| `galerij` | Keuze van 11 november: het team downloadt elke galerij als zip. Wel wissen. | `galleries`, `gallery_items` |
| `geheim` | Werkt als sleutel; buiten ResoFly nutteloos en gevaarlijk. Welke koppelingen er waren, gaat wel mee (`api_keys`, `webhook_endpoints`, `calendar_connections`, zonder geheim). | `api_key_secrets`, `calendar_connection_tokens`, `organization_mollie_connections` |
| `intern` | De werking van ResoFly zelf: wachtrijen, tellers, leesstatus. | `notification_outbox`, `email_send_counters`, `ticket_reads` |
| `prive` | Van één teamlid, niet van de organisatie. Elk teamlid haalt die zelf op (fase 3). | `ai_conversations`, `notification_preferences` |
| `abonnement` | Het abonnement bij ResoFly zelf, niet de administratie van de klant. | `organization_billing_profiles` |
| `platform` | Gedeeld door alle organisaties. | `billing_plans`, belastingtarieven |

Bestanden van een zending (`file_transfer_items`) verlopen en worden opgeruimd:
het overzicht gaat mee, de bestanden zelf niet (`skipFiles` in het manifest).

Op 11 november: 146 tabellen gaan mee, 59 niet. Als eigenaar waren in een
lokale database alle 146 leesbaar met de select en sortering van de export.

Daarnaast laat het manifest **kolommen** weg die als sleutel werken: tokens van openbare
links, hashes van pincodes, wachtwoorden. Een kolom met zo'n naam gaat alleen mee als het
manifest hem uitdrukkelijk toestaat; de test bewaakt dat.

**Met de rechten van wie exporteert.** De export leest via de gewone weg (Supabase met de
sessie van de eigenaar), dus RLS beslist. Wat de eigenaar in ResoFly niet kan zien, zoals
de privé-agenda van een collega, komt er ook niet in. Er is geen service-role bij nodig:
een export kan nooit meer dan het scherm.

## 4. Het exportformaat (versie 1)

Eén zip, `resofly-export-<organisatie>-<datum>.zip`:

```
LEESMIJ.txt                  wat waar staat, en wat er niet in zit
manifest.json                formaat, schemaversie, aantallen, SHA-256 per bestand, uitsluitingen
data/<tabel>.jsonl           elke tabel: één JSON-object per regel, alle kolommen
lijsten/<naam>.csv           de belangrijkste tabellen voor Excel (; en BOM, bedragen in euro)
boekhouding/auditfile-<boekjaar>.xaf
bestanden/<soort>/…          de originele bestanden, per soort (facturen, offertes, documenten …)
```

- **id's blijven staan**, zodat de relaties heel blijven (`client_id` in `invoices` wijst naar
  `id` in `clients.jsonl`).
- **Bedragen** in `data/` zoals in de database: centen als geheel getal (`total_cents`). In
  `lijsten/` als euro met een komma.
- **Tijden** in ISO 8601 met tijdzone, datums als `JJJJ-MM-DD`.
- **Bestanden**: `manifest.json` koppelt elke opslagsleutel aan het pad in de zip, met grootte
  en SHA-256. De sleutel staat ook in de rij (`storage_key`, `pdf_storage_key` …).
- **Schemaversie**: de laatste migratie (`EXPORT_SCHEMA_VERSION`). De test faalt als die
  achterloopt.

Het formaat is ook het **importformaat** van fase 3: ResoFly moet zijn eigen export kunnen
inlezen. Dat rondje is meteen het bewijs dat de export compleet is.

## 5. Fasen

### Fase 1: nu (branch `ccr-0afbd2e1-yloobo`)

**Export**
- `src/lib/exportManifest.ts` + test: elke tabel met `organization_id` is ingedeeld, er staan
  geen verdwenen tabellen in, kolommen die als sleutel werken gaan niet mee, en de
  schemaversie loopt niet achter.
- `src/lib/zipWriter.ts`: zip zonder bibliotheek (CRC32, ZIP64), tekst gecomprimeerd waar de
  browser dat kan.
- `src/lib/dataExport.ts`: leest per tabel in pagina's, laat kolommen weg, haalt de bestanden
  via de media-worker (`/file/<sleutel>`, die per module controleert), maakt per boekjaar een
  XAF en schrijft de lijsten en het manifest.
- **Instellingen → Gegevens**: alleen voor de eigenaar. Uitleg wat erin zit en wat niet, de
  knop, de voortgang.
- **Logboek**: migratie met `log_data_export`, zodat in het logboek staat wie wanneer alles
  exporteerde. Een export is de snelste manier om met één overgenomen account alles mee te
  nemen; dan moet dat te zien zijn.

**Import**
- `src/lib/xafImport.ts` + test: leest XAF 3.x (ook windows-1252), rekent de saldi uit op de
  overstapdatum en stelt per rekening een koppeling voor.
- **Boekhouding → Beginbalans**: "Lees een auditfile in". Je ziet de saldi per rekening en de
  koppeling, en vult met één knop de beginbalans in. Vastleggen blijft de bestaande knop.
  Klanten en leveranciers uit de auditfile voeg je met een tweede knop toe; wie er al is
  (zelfde btw-nummer of naam), wordt overgeslagen.

### Fase 2: opzeggen, ophalen, wissen (vóór de eerste betalende klant)

- Levenscyclus per organisatie: actief → opgezegd → overstapperiode (30 dagen, alles werkt)
  → ophaalperiode (voorstel: 60 dagen; alleen inloggen en exporteren, niets gaat de deur uit)
  → gewist.
- Een wis-route die alleen de server mag gebruiken, alleen voor een organisatie in de laatste
  fase. Alleen daar mag hij langs de blokkades van de bewaarplicht.
- Daarnaast wissen: R2 onder `<orgId>/` (ook `gallery/`), de video's bij Stream, de
  verzenddomeinen bij Resend. Tokens intrekken bij Google, Microsoft, Mollie en Enable Banking.
  API-sleutels en webhooks.
- Een mail aan alle eigenaren bij elke export.
- In de voorwaarden en de verwerkersovereenkomst: de termijnen, het formaat, de uitsluitingen
  uit het manifest, het wissen, en binnen hoeveel dagen de back-ups volgen.

### Fase 3: overstappen naar ResoFly, vervolg

- **Openstaande posten**: onbetaalde verkoop- en inkoopfacturen overnemen met hun oude nummer,
  niet opnieuw versturen of boeken (de beginbalans heeft ze al), zodat betalingen te koppelen
  zijn.
- **Factuurnummer laten doorlopen**: prefix en volgend nummer kiezen bij Inrichten
  (`organization_invoice_number_sequences` heeft ze, maar er is geen scherm).
- **Importbatches**: elke import een batch-id en het id uit de bron. Opnieuw draaien geeft
  geen dubbelen, en een batch is terug te draaien zolang er niets geboekt of verstuurd is.
- Meer CSV-sjablonen (contactpersonen, projecten, uren) en sjablonen voor de pakketten waar
  klanten echt vandaan komen.
- Het eigen exportformaat inlezen.
- Gerrie stelt bij een onbekende CSV een kolomkoppeling voor; een mens keurt goed.
- Een persoonlijke export voor elk teamlid (Gerrie-gesprekken, privé-afspraken).

### Fase 4: groter

- De export op de server (media-worker), als een organisatie te groot wordt voor de browser.
- De API met een cursor in plaats van offset, zodat een overstappartner alles kan ophalen.

## 6. Beslissingen

| Vraag | Keuze | Wie |
| --- | --- | --- |
| Galerijen in de export? | Nee; zip per galerij. Wel wissen. | Gerjan, 11 november |
| Wie mag exporteren? | De eigenaar (te verruimen naar beheerders in `canExportAll`). | Voorstel |
| Privé van teamleden? | Niet in de export van de organisatie; elk teamlid zelf. | Voorstel |
| Hoe lang ophalen? | 60 dagen (wet: minimaal 30). | Voorstel |
| Archiefabonnement? | Open. | Gerjan |

## 7. Testen

- `npm test`: manifest, zip (ook ZIP64 en tekens buiten ASCII), export met een nep-Supabase,
  XAF-import (ook een rondje met de eigen `buildXaf`).
- `npm run test:mobile -- --theme=both`: Instellingen → Gegevens en de beginbalans met de
  import.
- `supabase db start`: de migratie op een lege database.
