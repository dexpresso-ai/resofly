# Boekhouder-toegang: een gastaccount dat alleen de financiën inziet — 2026-10-11

Owners en admins kunnen vanaf nu per administratie een **boekhouder** uitnodigen:
een gratis gastaccount dat alleen de financiën kan **inzien**. Je vindt het onder
**Instellingen → Boekhouder**: e-mailadres invullen, uitnodigen, klaar. Daar zie
je ook of de uitnodiging nog openstaat (opnieuw versturen, intrekken) of de
boekhouder actief is (toegang intrekken).

## Wat de boekhouder ziet

| Ziet wel | Ziet niet |
|---|---|
| Offertes, contracten, facturen en creditfacturen | Klantdossiers, contactpersonen en klantmail |
| Inkoopfacturen (met de bonnetjes) en leveranciers | Projecten, taken, uren en agenda |
| Grootboek, journaalposten, bank en activa | Tickets, notities en documenten |
| Winst & verlies, btw, Vpb, DGA en aandeelhouders | Teamchat, marketing en Gerrie |
| Boekjaren en jaarrekening | Het team, de instellingen en het abonnement |
| De debiteurgegevens zoals ze op de stukken staan | |
| Downloads: PDF, e-factuur (UBL) en de XAF-auditfile | |

Wijzigen, boeken of versturen kan de boekhouder nergens. In Instellingen staan
alleen Organisatie (met een eigen uitleg), Facturatie en Boekhouding — alleen-lezen.

## Het model

- **Een eigen rol `accountant`** ("Boekhouder") naast owner, admin, member en
  viewer. Geen viewer met modulerechten: daar is één verkeerde keuze in het
  rechtenraster genoeg om Klanten open te zetten. Bij de boekhouder bepaalt de
  rol het: Financiën `read`, de rest `none`, en `module_access` telt niet.
  `set_member_module_access` weigert de boekhouder.
- **Gratis.** Een actieve boekhouder telt in geen enkele seat-teller mee, en een
  uitnodiging reserveert geen seat. Uitnodigen kan dus ook als alle licenties
  vol zijn.
- **Eén per administratie** (unieke indexen op actief en openstaand, plus een
  controle met advisory lock in de RPC). Met een holding en werk-BV's gaat de
  uitnodiging per administratie.
- **Geen rolwissel** naar of van boekhouder (trigger
  `organization_members_accountant_role_guard`). Anders werd een betaald teamlid
  met één klik een gratis gast, of andersom een teamlid zonder licentie (de
  seat-trigger kijkt naar de status, niet naar de rol). Wie wil wisselen, zet de
  toegang uit en nodigt opnieuw uit; alleen het accepteren van een uitnodiging
  mag de rol omzetten.
- **Eerste login zonder eigen werkruimte.** `ensure_user_default_organization`
  maakt bij een openstaande boekhouder-uitnodiging geen eigen organisatie meer
  aan; de eerste login landt op "Je bent uitgenodigd", met Accepteren.

## Handhaving in lagen

De UI is ook hier niet de beveiliging.

1. **Eén regel per module: `member_module_level()`.** `org_module_level` (dus alle
   module gates, de schrijf-triggers en `my_module_access`), de ontvangers van
   pushmeldingen en de CalDAV-lookup gebruiken hem. Exacte spiegels in
   `supabase/functions/_shared/roles.ts` (alle edge functions),
   `src/lib/permissions.ts` (de app) en de media-worker;
   `roles.test.ts` houdt ze gelijk. **Een rol die de regel niet kent, krijgt
   voortaan `none`** — tot nu toe viel die door naar `write`: in de database,
   `edgeAuth`, Gerrie, de MCP-functie, de media-worker en de app.
2. **Het hek.** Op elke organisatietabel zonder module gate een restrictive
   policy die de boekhouder buitensluit: 37 tabellen helemaal (uitnodigingen,
   e-mailsjablonen, verzenddomeinen, portaalinstellingen, pushabonnementen,
   Gerrie-instellingen, …) en vier met een eigen regel: `organization_members`
   (alleen de eigen rij), `company_settings` (lezen), `audit_logs` (alleen
   regels over financiën) en `attachments` (alleen bijlagen van financiële
   records). De lijst wordt niet met de hand bijgehouden: de migratie zet het hek
   op álle tabellen met een `organization_id` zonder module gate, en faalt als er
   één ontbreekt. `accountant_fence_gaps()` geeft de tabellen zonder gate én
   zonder hek; **de rooktest na elke deploy faalt** als die lijst niet leeg is.
   Het hek kost niets voor wie geen boekhouder is: de lijst met administraties
   wordt één keer per query opgezocht (InitPlan), niet per rij.
3. **Edge functions** draaien op de service-role en omzeilen RLS. Ze lezen het
   niveau nu allemaal uit `roles.ts`: `edgeAuth` (`getModuleLevel`,
   `requireOrganizationAccess` weigert een onbekende rol, `assertWriteRole` is een
   allowlist), `gerrieCore`, de MCP-functie (de rol telt nu ook mee bij de
   Gerrie-controle per aanroep) en de openbare API. De teamhandelingen van
   Gerrie/MCP/API weigeren een rolwissel of rechtenraster op de boekhouder.
4. **Workers.** De media-api controleerde schrijven met "alles behalve viewer";
   dat is nu een allowlist (owner/admin/member). Een bestand dat onder geen
   module valt (zoals een opname) is dicht voor de boekhouder. De oudere
   R2-worker geeft de boekhouder alleen bestanden van financiële records.
5. **Pushmeldingen.** De boekhouder staat nooit in een ontvangerslijst (ook niet
   bij Financiën: abonnementen worden per gebruiker opgezocht, niet per
   organisatie) en kan zich er ook niet voor aanmelden.

## De debiteuren op de stukken

Facturen, offertes en contracten verwijzen naar een klant, en de klantenkaart is
voor de boekhouder dicht. Zonder klantnaam is een facturenlijst onleesbaar en
heeft de XAF-auditfile geen debiteuren. `finance_client_directory()` geeft
precies wat er op de stukken staat — naam, klantnummer, zakelijk/particulier,
contactpersoon, adres, e-mail, telefoon, btw- en KvK-nummer en de
e-factuurinstelling — van klanten die op een factuur, offerte, contract of
boeking staan. Geen notities, tags, opvolging, waarde of eigen velden. De app
laadt deze lijst voor iedereen die Financiën wel en Klanten niet mag lezen; ook
een zo ingesteld teamlid zag tot nu toe facturen zonder naam.

## Wat er verder in de app verandert

- **Teamlijst:** de boekhouder staat erbij met een vaste rol, zonder knop
  Rechten. Uitschakelen kan (owner). De uitnodiging staat op het tabblad
  Boekhouder, niet tussen de teamuitnodigingen.
- **Gerrie, de teamchat en de live meldingen** (klantmail, tickets, beslislijst)
  verschijnen alleen nog als die module open staat. Dat geldt voor elk beperkt
  teamlid; de database gaf ze toch al niets.
- **De globale zoekfunctie** toont alleen resultaten van pagina's die je mag
  openen.
- **"+ Nieuw" bij offertes en facturen** is uitgeschakeld bij alleen-lezen, en de
  velden onder Instellingen → Facturatie zijn alleen-lezen voor wie niet mag
  opslaan.
- **Collega's kiezen** (taak toewijzen, weekplanner, uren, projectteam, chat):
  zonder de boekhouder — het is een gast, geen teamlid. Ook het dashboard telt
  de boekhouder niet mee.
- **De uitnodigingsmail** voor een boekhouder heeft een eigen tekst met wat er
  wel en niet te zien is.

## Ook gedicht

- `next_purchase_invoice_number` trok een nummer uit de reeks (schrijven) met
  alleen leesrecht; nu is schrijfrecht op Financiën nodig. Alleen de factuur-inbox
  gebruikt hem, op de service-role.

## Getest

- **Database:** lokaal op Postgres 16 met het basisschema en alle 183 latere
  migraties plus deze. 80 controles als owner, member, viewer en boekhouder:
  lezen per module, schrijven (insert/update/delete en RPC's), licenties (volle
  seats, omzetten van een openstaande uitnodiging, oud-boekhouder terug als
  teamlid), één per administratie, rolwissels, pushontvangers, de debiteurenlijst
  en de eerste login. Plus: het hek vindt een nieuwe tabel zonder bescherming.
- `npm test` (nieuw: `roles.test.ts`, `src/lib/permissions.test.ts`),
  `npm run typecheck`, `npm run build`, de CSP-controle en de mobiele lay-outtest
  (met het nieuwe tabblad `settings-boekhouder`).
- Typecheck van de media-api en de oudere R2-worker, en een tsc-controle van alle
  edge functions tegen de stand van vóór deze wijziging (geen nieuwe fouten).
  `deno check` met de externe imports kon in deze omgeving niet draaien
  (deno.land en esm.sh waren geblokkeerd); dat doet de CI.

## Bestanden

| Bestand | Wat |
|---|---|
| `supabase/migrations/20261011000000_accountant_guest_access.sql` | Rol, regel per module, licenties, uitnodigen/accepteren, rolbewaking, debiteurenlijst, het hek |
| `supabase/functions/_shared/roles.ts` | De gedeelde rolregel voor alle edge functions |
| `supabase/functions/_shared/edgeAuth.ts`, `gerrieCore.ts`, `publicApi.ts`, `mcp/index.ts` | Lezen het niveau uit `roles.ts` |
| `supabase/functions/_shared/actions/admin.ts` | Teamhandelingen: boekhouder heeft vaste rol en rechten |
| `supabase/functions/mail/index.ts` | Uitnodigingsmail voor de boekhouder |
| overige edge functions | Rol-type kent `accountant` (gedrag ongewijzigd: schrijven was al een allowlist) |
| `workers/media-api/src/index.ts`, `cloudflare-worker/worker.ts` | Schrijven als allowlist, boekhouder alleen financiële bestanden |
| `scripts/supabase-smoke-test.sh` | Controleert `accountant_fence_gaps()` |
| `src/lib/permissions.ts`, `src/types.ts` | Rol en regel in de app |
| `src/features/SimplePages.tsx` | Tabblad Boekhouder, instellingen voor de boekhouder, teamlijst |
| `src/main.tsx`, `src/components/Sidebar.tsx`, `GlobalSearch.tsx`, `src/features/Dashboard.tsx`, `Finance.tsx` | Beperkte app, debiteurenlijst laden |
| `src/lib/repository.ts` | `loadFinanceClientDirectory` |

## Nieuwe database-objecten

- Rol `accountant` in `organization_members` en `organization_invitations`
- `organization_members_one_accountant`, `organization_invitations_one_accountant` (unieke indexen)
- `public.member_module_level(text, jsonb, text)`
- `public.prevent_accountant_role_change()` + trigger `organization_members_accountant_role_guard`
- `public.finance_client_directory(uuid)`
- `public.my_accountant_organization_ids()`, `public.apply_accountant_fence(text, text)`, `public.accountant_fence_gaps()`
- Policies `accountant fence` / `accountant fence select|insert|update|delete`
- Bijgewerkt: `org_module_level`, `push_module_member_ids`, `push_org_member_ids`,
  `caldav_lookup_app_passwords`, `organization_reserved_license_count`,
  `organization_license_usage`, `organization_billing_overview`,
  `enforce_member_license_capacity`, `enforce_invitation_license_capacity` (trigger
  luistert nu ook naar `role`), `invite_organization_member`,
  `accept_organization_invitation`, `set_member_module_access`,
  `ensure_user_default_organization`, `next_purchase_invoice_number`

## Bewust buiten scope (gevonden, apart op te pakken)

- **Rapportfuncties kijken niet naar de module Financiën.** Veertien
  security-definer-functies (`report_profit_and_loss`, `report_balance_sheet`,
  `compute_vat_return`, `report_trial_balance`, `list_fiscal_years`, …) vragen
  alleen lidmaatschap. Een teamlid met Financiën **dicht** kan via een directe
  RPC-aanroep dus toch W&V, balans en btw opvragen. Voor de boekhouder maakt het
  niet uit (die mag Financiën lezen), maar het is een gat in de modulerechten.
- **Pushmeldingen over tickets en klantmail** gaan naar alle leden, ongeacht hun
  modulerechten (`push_org_member_ids`). De boekhouder is uitgesloten; voor andere
  beperkte teamleden staat het nog open.
- **Uitnodigen via Gerrie, MCP of de API** kan niet als boekhouder; dat loopt
  alleen via Instellingen.
- **Mollie-status ophalen** (`syncMollieSalesInvoice`) mag elke lezer, ook de
  boekhouder. Dat schrijft Mollies waarheid (betaald, Peppol-aflevering) weg; zo
  was het bewust ontworpen voor viewers.

## Uitrollen

1. De migratie: met de push naar `staging` (workflow *Deploy Supabase (staging)*),
   of `supabase db push` volgens `SUPABASE_STAGING_LAPTOP.md`.
2. De edge functions opnieuw deployen — vrijwel allemaal, want `edgeAuth.ts`,
   `gerrieCore.ts` en `publicApi.ts` lezen nu `roles.ts`. De staging-workflow
   deployt ze allemaal.
3. De media-api worker (`npm run deploy:staging` / `npm run deploy` in
   `workers/media-api`), en de oudere R2-worker als die nog draait.
4. De rooktest meldt daarna `ok boekhouder-hek`.

## Op staging nalopen

1. Als owner: Instellingen → Boekhouder → een tweede e-mailadres van jezelf uitnodigen.
2. Met dat adres inloggen → "Je bent uitgenodigd" → Accepteren.
3. Alleen Dashboard en Financiën in het menu; facturen met klantnaam; een PDF en
   de XAF-auditfile (Grootboek → Auditfile) downloaden; overal "Alleen lezen".
4. Een oud tabblad of deeplink naar Klanten → "Geen toegang tot Klanten".
5. Als owner: Toegang intrekken → de boekhouder ziet niets meer.
