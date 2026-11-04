# Migraties

Deze map is de enige bron van het databaseschema. Er is geen los
installatiebestand meer: een nieuwe database bouw je door alle migraties op
volgorde af te spelen, en dat levert precies het schema van staging op.

## Een nieuwe database

**Een nieuw Supabase-project** (productie, een testomgeving):

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Daarna, eenmalig per project:

1. In het dashboard: **Database → Extensions** → `pg_cron` en `pg_net` aan.
   Die staan niet in de migraties; Supabase zet ze per project aan.
2. `supabase functions deploy --use-api`
3. De secrets uit `.env.example` (`supabase secrets set …`).
4. `scripts/supabase-setup-webhooks.sh`: de geheimen en de pg_cron-taken van
   de bezorger, de opruimtaak, de klantmeldingen en bestanden versturen.
5. Wil je jaarabonnementen aanbieden? Zet dan per plan `yearly_price_cents` en
   `extra_seat_yearly_price_cents` in `billing_plans`. Staat er 0, dan biedt de
   app geen jaar aan; zo is het ontworpen (20260626000002). Op staging staan ze
   op twaalf keer de maandprijs.

**Lokaal** (Docker nodig):

```bash
supabase db start      # lege database + alle migraties + seed.sql
supabase db reset      # opnieuw vanaf nul
```

`seed.sql` is bewust leeg: alle gegevens horen bij een organisatie, en die
ontstaat bij de eerste login.

## Een nieuwe migratie

1. Naam: `<JJJJMMDDUUMMSS>_<onderwerp>.sql`, met een versie die **later** is
   dan de laatste op staging. Een oudere versie weigert `supabase db push`
   ("Found local migration files to be inserted before the last migration on
   remote database").
2. **Nooit iets met de hand in de SQL-editor** zonder dat het ook in een
   migratie staat. Zo zijn staging en een verse database uit elkaar gelopen:
   zie hieronder.
3. Een migratie die al op staging staat, wijzig je niet meer. De CLI draait hem
   daar nooit opnieuw, dus een wijziging komt alleen op nieuwe databases terecht.
   Een fout herstel je met een nieuwe migratie. Er is één uitzondering: een
   bestaande migratie aanpassen zodat een verse database krijgt wat staging al
   heeft. Op staging verandert dan niets. Zo is de keten in november
   rechtgezet; zie hieronder.
4. Schrijf hem zo dat hij veilig nog eens kan draaien (`if not exists`,
   `create or replace`, `drop … if exists`).

De CI-job `migrations` (`.github/workflows/frontend-checks.yml`) speelt bij
elke pull request de hele keten af op een lege database met dezelfde images als
staging (Postgres 17.6.1.111, versies uit `supabase/.temp`) en controleert dat
elk bestand is toegepast.

## Hoe de keten in november 2026 is rechtgezet

Tot 4 november 2026 liep een lege database al bij de eerste migratie stuk
(`function public.set_updated_at() does not exist`). De keten begon bovenop
een schema dat ooit met de hand in de SQL-editor was gezet
(`FRESH_INSTALL_COMPLETE_SCHEMA.sql`, v2.2.1), en een aantal migraties uit mei
was in een andere volgorde gedraaid dan hun nummers. Opgelost zonder één
versienummer te veranderen, zodat staging er niets van merkt (de CLI vergelijkt
alleen versies):

| Versie | Wat |
| --- | --- |
| `20260427000000_basis_v2_2_1` | Het complete schema v2.2.1 waarmee staging begon, zoals het op 1 mei in de repo stond (commit `757eea0`). De oude inhoud van deze versie zat daar al in. |
| `20260428000000` t/m `20260430000006` | Leeg: zaten al in de basis. De oorspronkelijke inhoud staat in de kop van elk bestand (`git show 24da432:…`). |
| `20260515000001` / `…000002` | Inhoud omgewisseld: `hardening` vóór `final_recheck`. `final_recheck` trekt rechten in op een functie die `hardening` aanmaakt; de gecombineerde migratie van 16 mei noemt dezelfde volgorde. |
| `20260527000000` / `…000001` | Inhoud omgewisseld: `production_hardening` vóór `deep_review_fixes`. De review gebruikt de tabel `invoice_public_links` die de hardening aanmaakt. |
| `20261101060000` | Maakt nu zelf `rls_auto_enable()` en de event-trigger `ensure_rls`. Die kwamen uit het dashboard ("RLS automatisch aan op nieuwe tabellen") en bestonden op een verse database niet. |
| `20260526000000` | `invoice_token_hash` zoals hij op staging staat, met een vaste `search_path`. De eerste versie faalde vanuit security-definer-functies, en daarmee de publieke factuurlinks. Staging was in de SQL-editor gerepareerd. |

Dezelfde aanpak als eerder in commit `88ea8e6` (sprint 2.5 achteraan de
20260430-groep).

**Gecontroleerd op 4 november 2026:** een database vanaf nul is vergeleken met
staging op tabellen, kolommen, constraints, indexen, functies (inhoud),
triggers, policies, rechten, types, buckets en de referentiedata (plannen,
tarieven, normen). Alles is gelijk, op drie bewuste verschillen na:

- `public._migrations` staat alleen op staging: het logboek van de oude
  handmatige migratieronde van 31 mei. Geen code gebruikt het.
- `pg_cron` zet je per project aan in het dashboard (zie hierboven).
- De jaarprijzen in `billing_plans` zijn instellingen per omgeving, geen schema
  (zie stap 5 hierboven).

Opnieuw vergelijken, na `supabase db start` en `supabase link`:

```bash
SUPABASE_DB_PASSWORD='…' bash scripts/schema-vergelijken.sh
```
