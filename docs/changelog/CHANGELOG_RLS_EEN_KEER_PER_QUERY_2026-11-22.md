# Leesrechten één keer per query, niet per rij — 22 november 2026

Vervolg op [CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md](CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md).
Daar kreeg één telling (de banktransacties op het dashboard) een eigen functie
om de RLS per rij te ontlopen. Nu zit het in de policies zelf, voor elke tabel.

Migratie: `supabase/migrations/20261122100000_rls_een_keer_per_query.sql`.
Test: `tests/database/rls_een_keer_per_query.sql`.

## Wat er was

Elke leespolicy riep per rij `can_read_org(organization_id)` aan, en elke
module gate daarbovenop `can_read_module(organization_id, '<module>')`. Allebei
komen ze uit bij een security definer-functie met een eigen query op
`organization_members`. Postgres kan die niet inlinen en roept ze voor elke rij
opnieuw aan. Op staging (19 november, `bank_transactions`): 166 ms voor
1.820 rijen, tegen 1,6 ms zonder de controle; zo'n 90 µs per rij. De kern van
de werkruimte leest bij elke start alle taken, bijlagen, facturen en notities,
per pagina van 1000.

## Wat er nu is

- **Drie lijsten, één keer per query.** `my_organization_ids()`,
  `my_module_organization_ids(module)` en, voor de bijlagen,
  `my_readable_module_keys()` (sleutels `<organisatie>:<module>`). In een
  policy als `organization_id = any ((select public.my_organization_ids())::uuid[])`
  worden ze een InitPlan, net als het boekhouder-hek. De planner gebruikt ze
  ook als indexvoorwaarde.
- **287 leespolicies op 159 tabellen herschreven**, plus de leespoort op
  `attachments`. Alleen `for select`, alleen de letterlijke aanroepen op de
  eigen `organization_id`. Schrijfpolicies, `for all`-policies en triggers zijn
  niet aangeraakt: schrijven raakt één rij per keer.
- **`apply_module_gate`** maakt de leespoort van een nieuwe tabel meteen in de
  snelle vorm. Schrijven blijft `can_write_module`.
- **Zelfde uitkomst voor elke rol.** Dezelfde regel als `user_is_org_member`
  en `org_module_level` (`member_module_level`), op het ene actieve
  lidmaatschap. Alle herschreven tabellen hebben `organization_id NOT NULL`,
  dus `= any` geeft precies true of false, net als de oude functie.

### Hoe de migratie zichzelf controleert

- De herschrijving vervangt twee vaste teksten in de uitvoer van
  `pg_get_expr` (met een lege `search_path`, zoals `pg_dump`). Welke policies
  het raakt, staat letterlijk in de migratie. Wijkt de database daarvan af,
  dan stopt hij en verandert er niets. Zo is de uitkomst op staging gelijk aan
  die op een verse database, of faalt de uitrol.
- Per policy: lees hem na het herschrijven terug, zet de oude aanroep terug en
  vergelijk met de oude tekst. Alleen als die letterlijk gelijk is, gaat hij
  verder.
- `attachment_module` mag alleen modules uit `module_keys()` teruggeven. Anders
  kent `my_readable_module_keys()` de module niet. De bijlage valt dan dicht
  voor iedereen; open valt hij nooit.
- `lock_timeout` van tien seconden: `alter policy` neemt per tabel een
  AccessExclusiveLock. Liever falen dan de app laten wachten.
- Tweede keer draaien: niets te vervangen, niets veranderd.

### Bewust gebleven (per rij)

- `organizations` "organizations read by members": `can_read_org(id)`. Niet op
  `organization_id`; een gebruiker leest er een handvol van.
- `ai_decisions` "ai_decisions read": `can_read_module(organization_id, module)`,
  met de module uit een kolom. De rest van die policy gaat wel mee.
- `for all`-policies die bij lezen meetellen, maar niet herschreven zijn:
  - `attachments` "attachments chat participants only" (restrictive): per rij
    alleen voor bijlagen aan een chatbericht (`chat_is_participant`);
  - `shareholders`, `share_transactions`, `share_encumbrances`,
    `dga_interest_rates`, `corporate_tax_corrections`, `corporate_tax_losses`:
    "… write" met `can_write_org` als `for all`. Kleine tabellen; de leespolicy
    staat ervoor en beslist bij een lid al.
  - het boekhouder-hek was al in de snelle vorm.

De test houdt de lijst bij: een nieuwe leespolicy met de oude vorm laat hem
falen.

## Gemeten

Lokaal, `supabase db start` (Postgres 17.11), twee organisaties met elk 3.000
taken en 3.000 bijlagen, gelezen als gewoon teamlid. `EXPLAIN ANALYZE`, twee
keer gedraaid:

| Vraag | vóór | na |
| --- | --- | --- |
| alle 3.000 taken van de eigen organisatie | 142–144 ms | 1,2–1,6 ms |
| taken, pagina 1 (`order by created_at desc, id limit 1000`) | 136 ms | 2,3 ms |
| alle 3.000 bijlagen | 142–167 ms | 2,5–2,7 ms |

Het plan vóór: `Filter: (... org_module_level(...) ... AND user_is_org_member(organization_id))`
per rij. Na: twee InitPlans en `Index Cond: ((organization_id = ANY ((InitPlan 1).col1)) AND ...)`.
De herschrijving zelf duurt lokaal 150 ms.

## Getest

- `supabase db start` vanaf nul (294 migraties) en de migratie op een
  bestaande database (zoals `db push` op staging): de 1.134 policies zijn
  daarna letterlijk gelijk. Een tweede keer draaien verandert niets.
- `npm run test:database`: alle vijf geslaagd (85, 41, 44, 69 en 61
  controles). `rls_een_keer_per_query.sql`:
  - 12 gebruikers (owner, admin, lid, lid zonder Financiën, lid met alleen
    lezen, viewer, boekhouder, uitgeschakeld lid, lid van twee organisaties,
    owner B, buitenstaander, geen JWT) × 9 tabellen (`tasks`, `clients`,
    `notes`, `invoices`, `journal_lines`, `bank_transactions`,
    `time_entries`, `organization_members` en `attachments` aan klant, taak,
    notitie, factuur en chatbericht): de rijen via de RLS zijn gelijk aan die
    van de oude functies;
  - daarna de oude policies terug (alleen in de testtransactie): oud en nieuw
    laten precies dezelfde rijen zien;
  - het plan van `tasks` heeft een InitPlan en geen rechtenfunctie per rij;
  - anon komt er niet in, de nieuwe functies zijn dicht voor anon;
  - `apply_module_gate` op een nieuwe tabel.
- De test faalt zoals hij moet: als de modulelijst het niveau negeert (11
  verschillen), als een uitgeschakeld lid meetelt (1), en bij een nieuwe
  leespolicy in de oude vorm.
- De migratie faalt zoals hij moet: een policy buiten de lijst,
  `organization_id` nullable, en een module buiten `module_keys()` in
  `attachment_module`. Er verandert dan niets.
- `npm test`: 2.113 geslaagd.
