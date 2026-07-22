# Debiteurenautomaat (NL-incassorecht) — setup & runbook — 2026-07-22

De debiteurenautomaat bouwt voort op de bestaande, getrapte betalingsherinneringen. Waar
de 3 herinneringen vriendelijk en automatisch zijn, is de **aanmaning** juridisch geladen:
wettelijke (handels)rente + WIK-incassokosten, verpakt in een formele **14-dagenbrief**.
Kernprincipe: **human-in-the-loop** — de cron *stelt alleen voor*, de gebruiker *bevestigt
en verstuurt*. Er wordt nooit automatisch een aanmaning verzonden.

## 1. Migratie toepassen

`supabase/migrations/20260722000000_debtor_dunning.sql` — voegt toe:
- `clients.client_kind` ('business' | 'consumer'), default 'business';
- `statutory_interest_rates` (nationale rentetarief-tijdlijn, geseed);
- `invoice_dunning_notices` (aanmaningen met bedragen-snapshot, één per factuur);
- dunning-kolommen op `invoice_reminder_settings`;
- RPC's + uitgebreide CHECK-constraints (audit/workflow/delivery) + nieuwe audit-actie.

```bash
supabase db push   # of: pas de migratie toe op de gedeelde staging/prod-database
```

## 2. Edge Function opnieuw deployen

De dunning-flow zit in de bestaande Worker `invoice-workflow` (nieuwe acties + `?cron=dunning`
+ import van `_shared/dunning.ts`). Deploy die opnieuw:

```bash
supabase functions deploy invoice-workflow
```

Boot-rooktest (verwacht 401 = function leeft, secret-gate werkt):
```bash
curl -s -X POST "https://<project>.functions.supabase.co/invoice-workflow?cron=dunning" -H "x-cron-secret: fout" | head
```

## 3. Cron inrichten (pg_cron + pg_net)

Hergebruikt **hetzelfde** gedeelde secret als de herinneringscron: `INVOICE_REMINDER_CRON_SECRET`
(er is dus geen nieuw secret nodig). Voeg een dagelijkse job toe die de dunning-batch triggert,
naast de bestaande `?cron=reminders`-job (zie `INVOICE_REMINDERS_SETUP_2026-06-16.md` voor het
exacte patroon). Bijvoorbeeld:

```sql
select cron.schedule(
  'invoice-dunning-daily',
  '30 7 * * *',                     -- dagelijks 07:30 (na de herinneringen)
  $$
  select net.http_post(
    url    := 'https://<project>.functions.supabase.co/invoice-workflow?cron=dunning',
    headers:= jsonb_build_object('content-type','application/json','x-cron-secret','<INVOICE_REMINDER_CRON_SECRET>'),
    body   := '{}'::jsonb
  );
  $$
);
```

Zonder cron blijft alleen het handmatig opstellen van een aanmaning (knop "Stel aanmaning op"
in het factuurdetail) actief. Het secret staat nooit in de migratie/git.

## 4. Rentetarieven verifiëren (BELANGRIJK)

De tabel `statutory_interest_rates` is geseed met via web-onderzoek geverifieerde percentages
(peildatum 2026-07-22). De reeks **2015 t/m 2025 is betrouwbaar bevestigd**; de twee **2026-regels
van de handelsrente** (10,15% per 2026-01-01, 10,40% per 2026-07-01) steunen op één secundaire
bron. **Controleer die vóór productiegebruik** tegen de officiële bekendmaking (Rijksoverheid/
Staatscourant) en corrigeer zo nodig:

```sql
select kind, rate_basis_points/100.0 as pct, valid_from, source_note
from statutory_interest_rates order by kind, valid_from;

-- corrigeren/toevoegen (rate in basispunten, 1040 = 10,40%):
insert into statutory_interest_rates(kind, rate_basis_points, valid_from, source_note)
values ('commercial', 1040, '2026-07-01', 'officieel geverifieerd')
on conflict (kind, valid_from) do update set rate_basis_points = excluded.rate_basis_points, source_note = excluded.source_note;
```

De rente-engine leest deze tabel **periode-accuraat**: een factuur die over een tariefwijziging
heen loopt, wordt correct in segmenten berekend. Het instellingenscherm ("Online betalen" →
"Debiteurenautomaat") toont de actuele tarieven read-only.

## 5. Gedrag / bediening

- **Klanttype** (`client_kind`) bepaalt de route:
  - **Consument** → wettelijke rente (art. 6:119 BW) + **verplichte WIK-14-dagenbrief**. De
    incassokosten worden pas ná de 14-dagen-termijn verschuldigd; de brief vermeldt dat
    voorwaardelijk, met het exacte bedrag en de btw-status.
  - **Zakelijk (B2B)** → wettelijke handelsrente (art. 6:119a BW), van rechtswege in verzuim;
    incassokosten direct opeisbaar (sommatie-toon).
- **Instellingen** (per organisatie, tab "Online betalen"): aanmaningen automatisch voorstellen
  (default uit), offset-dagen na vervaldatum (default 30), btw over incassokosten (default uit —
  alleen aan bij schuldeisers zónder btw-aftrekrecht).
- **Cron** stelt voor → factuurdetail toont het voorstel met de bedragen → **"Bevestig & verstuur"**
  herberekent de rente op vandaag, genereert de formele brief-PDF en verstuurt via Resend; of
  **"Annuleer voorstel"**. Eén aanmaning per factuur (annuleren is terminaal in v1).
- **BUITEN SCOPE v1** (bewust): rente + incassokosten worden **niet** automatisch in het grootboek
  geboekt (voorkomt de reverse_journal_entry-landmijnen); dit is een expliciete v2-follow-up. Ook
  automatische her-escalatie naar incassobureau is v2.

## 6. Verificatie (na deploy, met ingelogde sessie op staging)

- Zet een klant op 'consument', maak een factuur met vervaldatum in het verleden, zet 'm op
  `overdue`. → "Stel aanmaning op" → controleer bedragen (rente + WIK-kosten) → "Bevestig &
  verstuur" → controleer de ontvangen brief-PDF op de exacte 14-dagen-formulering + bedrag + btw.
- Zakelijke klant → sommatie-toon, handelsrente, kosten direct in het totaal.
- Cron: `POST …?cron=dunning` met geldig/ongeldig secret (200 met samenvatting / 401).
