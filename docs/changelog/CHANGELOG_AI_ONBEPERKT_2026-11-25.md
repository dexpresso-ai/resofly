# Onbeperkt AI-tegoed per organisatie (2026-11-25)

De organisatie **Brand New Gerrie** heeft nu onbeperkt AI-tegoed. Daarvoor is een
vlag per organisatie gebouwd: het AI-tegoed kende tot nu toe alleen twee plafonds
voor iedereen (€25 per gebruiker, €250 per organisatie, per kalendermaand).

## Wat er nu kan of klopt

- **`organization_billing_profiles.ai_unlimited`.** Staat de vlag aan, dan geldt voor
  die organisatie geen enkel AI-plafond, ook niet dat per gebruiker. Anders hield het
  eigen tegoed van €25 een teamlid alsnog tegen. Dit geldt voor alles wat onder het
  tegoed valt: Gerrie, de agents, de beslislijst, rapportages, notulen, transcriptie,
  het uitlezen van facturen en de factuur-inbox. Al die routes lopen via
  `checkAiBudget` (`_shared/aiBudget.ts`).
- **Geen tegoed-meter.** De app verbergt de balk "AI-tegoed" al als er geen plafond is
  (`remainingFraction` geeft dan `null`). In een onbeperkte organisatie zie je hem dus
  niet meer.
- **Elders telt het niet mee.** Wat iemand in een onbeperkte organisatie verbruikt,
  telt niet mee voor zijn eigen tegoed in andere organisaties. Anders zou werken in
  Brand New Gerrie je tegoed in een andere werkruimte opmaken.
- **Alleen de service-role zet de vlag**, met `set_organization_ai_unlimited(org, aan)`,
  net als `billing_exempt`. Op het billingprofiel bestaat geen schrijfpolicy en de
  functie is ingetrokken voor `anon` en `authenticated`. Een organisatie kan zichzelf
  dus niet vrijstellen. Elke wijziging komt in het logboek (`audit_logs`, actie
  `billing_synced`, `metadata.source = set_organization_ai_unlimited`).
- **Brand New Gerrie** krijgt de vlag in de migratie. Die zoekt op naam, zonder op
  hoofdletters of spaties eromheen te letten, want het id verschilt per database. Op
  een verse database bestaat die organisatie niet, en gebeurt er niets.
- Het verbruik wordt gewoon geregistreerd in `ai_usage`; Instellingen → AI-gebruik
  blijft het tonen.

Een andere organisatie onbeperkt maken (of het terugdraaien) gaat met een nieuwe
migratie:

```sql
select public.set_organization_ai_unlimited('<organization_id>', true);   -- of false
```

## Bestanden

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261125120000_ai_onbeperkt_per_organisatie.sql` | kolom, `ai_usage_month_totals` met `org_unlimited`, de setter, Brand New Gerrie aan |
| `supabase/functions/_shared/aiBudget.ts` | `aiBudgetVerdict` met `orgUnlimited`; `checkAiBudget` leest de vlag |
| `supabase/functions/_shared/aiBudget.test.ts` | twee tests: onbeperkt laat alles door, zonder vlag blijven de plafonds |
| `tests/database/ai_onbeperkt.sql` | rechten, logboek en de optelling in de database |
| `src/lib/exportManifest.ts` | `EXPORT_SCHEMA_VERSION` mee (de tabel gaat niet mee in de export) |

## Getest

- `npm run typecheck`, `npm test`: 2308 tests, alle groen.
- `deno check` op alle 35 functies uit de CI-lijst. esm.sh is in de cloudsessie niet
  bereikbaar, dus met een import map naar dezelfde npm-versies.
- De keten vanaf nul (`supabase db start`): 315 migraties, 315 toegepast.
- `npm run test:database`: alle 13 bestanden groen. Nieuw is `ai_onbeperkt.sql`, dat
  controleert:
  - een nieuwe organisatie is niet onbeperkt;
  - de owner kan de vlag niet zetten, niet via de functie en niet via de tabel;
  - de service-role kan het wel, en dat staat in het logboek;
  - `ai_usage_month_totals` geeft de vlag mee;
  - verbruik in de onbeperkte organisatie telt niet mee voor het eigen tegoed elders;
  - zet je de vlag uit, dan telt alles weer mee.
- De naamstap los geprobeerd op de lokale database. "  brand new GERRIE " kreeg de vlag,
  "Brand New Gerrie 2" niet. De migratie twee keer achter elkaar gedraaid: de tweede
  keer verandert er niets en komt er geen extra logregel bij.
- Staging kon vanuit de cloudsessie niet gelezen worden (de Management API is daar niet
  bereikbaar). Hoeveel organisaties de vlag kregen, meldt de migratie zelf in de
  uitvoer van de deploy: `Onbeperkt AI-tegoed gezet voor N organisatie(s)`.
