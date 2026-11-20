# Briefpapier laadt pas bij een PDF — 19 november 2026

Vervolg op [CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md](CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md),
waar dit als open punt stond.

## Wat er was

`company_settings.invoice_template_data_url` is het eigen briefpapier als
data-URL. De kern van de werkruimte laadde `company_settings` met `select *`,
bij elke start én na elke wijziging. Op staging was de rij met briefpapier
**287 KB**, waarvan 1,8 KB de instellingen zelf. In de database kostte die ene
rij gemiddeld 92 ms. Alleen een PDF heeft het briefpapier nodig: het voorbeeld
naast een offerte of factuur, de knop "Download concept-PDF" en de
documentopmaak in Instellingen.

## Wat er nu is

- **De kern laadt de instellingen zonder het briefpapier**, via de RPC
  `company_settings_core` (migratie `20261120100000_briefpapier_los.sql`):
  `to_jsonb(rij) - 'invoice_template_data_url'`. Een kolom die later bijkomt,
  komt vanzelf mee. Een vaste kolomlijst of een view zou zo'n kolom stil
  weglaten, en het instellingenformulier zou dan bij opslaan de standaardwaarde
  terugzetten. De functie draait met de rechten van de gebruiker (security
  invoker), dus de RLS van `company_settings` geldt gewoon. Staat de app eerder
  op Cloudflare dan de migratie, dan laadt hij de hele rij zoals voorheen.
- **Het veld heeft drie standen** (`lib/letterhead.ts`): undefined = niet
  geladen, null = geen briefpapier, een string = het briefpapier.
- **Een PDF haalt het briefpapier eerst op.** `createFinancePDFBytes` in
  `lib/pdf.ts` roept `withInvoiceLetterhead` aan: één keer per organisatie en
  per versie (`invoice_template_updated_at`). Lukt dat niet, dan geen PDF maar
  een melding. Een offerte of factuur verschijnt nooit stil zonder briefpapier.
- **Instellingen haalt het briefpapier zelf op**, voor de documentopmaak en het
  PDF-voorbeeld daar. Het voorbeeld wacht tot het binnen is.
- **Opslaan wist het briefpapier niet.** Dit was het grootste risico: het
  formulier maakte van een ontbrekend briefpapier `null`, en dat betekende
  "geen briefpapier". Nu laat `upsertCompanySettings` de zes briefpapierkolommen
  ongemoeid zolang het briefpapier niet geladen is (`withoutUnloadedLetterhead`).
  Dat geldt voor elke route: het formulier, de documentopmaak, de huisstijl en
  de handelingen van Gerrie (`lib/actions/admin.ts`, `finance.ts`). Weghalen
  werkt nog steeds: dat zet het veld uitdrukkelijk op null.
- De edge functions (verstuurde PDF's, het klantportaal, de jaarrekening) lezen
  het briefpapier zelf uit de database en veranderen niet.

## Gemeten

Op staging, als eigenaar van de organisatie met het grootste briefpapier, in een
teruggedraaide transactie:

- `company_settings_core` = `select *` min het briefpapier: gelijk, 52 kolommen;
- grootte: **1,8 KB** in plaats van 287 KB;
- iemand die geen lid is: `null`.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 2.060 geslaagd (5 nieuw in `letterhead.test.ts`), 12 mislukt;
  dezelfde 12 als vóór deze wijziging (CRLF op Windows). De nieuwe test bewaakt:
  - opslaan zonder geladen briefpapier laat alle zes de kolommen staan;
  - weghalen bereikt de database;
  - `documentAssetsFromSettings` wordt alleen aangeroepen in `lib/pdf.ts` (na
    `withInvoiceLetterhead`) en in de documentopmaak;
  - Instellingen haalt het briefpapier op;
  - `upsertCompanySettings` gebruikt de bescherming.
- `npm run test:loading` (119), `npm run test:terugknop` (15) en
  `npm run test:inrichten` (157): alles geslaagd.
- `npm run test:mobile -- --theme=both`: draait in de CI ("Frontend checks")
  voordat dit naar staging gaat.

## Samengevoegd met staging (20 november)

- De migratie heet nu `20261120100000_briefpapier_los.sql` (was
  `20261119110000`). Staging had op 20 november al `20261119180000` en
  `20261119190000` toegepast. Een oudere versie weigert `supabase db push`, en
  de deploy zou daar stoppen, vóór de edge functions en de rooktest. De inhoud
  is niet veranderd. `EXPORT_SCHEMA_VERSION` gaat mee.
