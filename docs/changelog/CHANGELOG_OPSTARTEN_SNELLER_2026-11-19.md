# Opstarten sneller: korter "ResoFly is aan het laden…" — 19 november 2026

Vraag: "Elke keer zodra een gebruiker de applicatie opent staat er een aantal
seconden dat ResoFly aan het laden is. Kunnen we dit op een verantwoorde manier
versnellen?"

## Wat er was

Het laadscherm staat er zolang de sessie, de organisatie en de kern van de
werkruimte binnenkomen (`runWorkspaceRound` in `src/main.tsx`). Gemeten op
staging (`pg_stat_statements`, 19 november):

- **Vijf rondgangen achter elkaar.** Eerst `ensure_user_default_organization`,
  dan `getUser()` bij de auth-server, dan het lidmaatschap, dan acht vragen over
  de organisatie, en pas dán de 32 vragen van de kern. Elke ronde wachtte op de
  vorige, en binnen een ronde op de traagste vraag.
- **De traagste vragen zaten in die rondes:**
  - de telling van de banktransacties voor het dashboard: gemiddeld **410 ms**
    (max 1,3 s), bij maar 3.620 rijen. De RLS van `bank_transactions` roept per
    rij twee rechtenfuncties aan (`user_is_org_member` en `org_module_level`).
    Met EXPLAIN ANALYZE: 166 ms voor 1.820 rijen, tegen 1,6 ms zonder die
    controle per rij;
  - het abonnementsoverzicht (`organization_billing_overview`): gemiddeld
    **290 ms** (max 4,8 s). Het rekent het opslagverbruik uit over zes tabellen,
    terwijl alleen Instellingen het gebruikt.
- **Eén bundel van 4,4 MB JavaScript** (1,3 MB gzip), bij elke start geladen en
  geparsed. Daarin zaten ook pdf-lib met pako en de standaardletters (samen ruim
  1 MB onverkleind), het klantportaal, alle pagina's achter een deellink en de
  inrichtingsstappen. Een teamlid in zijn werkruimte heeft die bij het opstarten
  niet nodig.
- **Na 4 uur werd alles opnieuw nagevraagd.** Pages gaf de scripts
  `max-age=0`; de zone op resofly.com maakte daar 4 uur van. Na een nacht vroeg
  de browser bij elke start de hele bundel opnieuw na.

## Wat er nu is

### Code: de opstartronde (`src/main.tsx`, `src/lib/repository.ts`)

- **De kern laadt tegelijk met de organisatie.** De app kent de organisatie al
  (de onthouden of de gekozen) en begint daar meteen aan. Kiest
  `loadOrganizationContext` toch een andere, dan gaat het vooruit geladen deel
  weg en laadt de kern voor de goede. Veilig: de RLS geeft alleen gegevens van
  een organisatie waar je lid van bent. De debiteurenlijst voor de boekhouder
  laadt nu ook tegelijk met de kern, niet erachteraan.
- **Geen `getUser()` meer bij elke start.** De gebruiker komt uit de sessie die
  de app al heeft. De database controleert het token bij elke vraag zelf.
- **`ensure_user_default_organization` loopt tegelijk met het lidmaatschap.**
  Alleen wie nog geen organisatie heeft (de eerste login), wacht erop en vraagt
  daarna het lidmaatschap opnieuw op.
- **Het abonnementsoverzicht komt na de kern, op de achtergrond**
  (`loadBillingInBackground`), alleen voor owners en admins. Bij een ververs
  blijft het vorige staan tot het nieuwe er is, zodat Instellingen niet knippert.
  De inrichting haalde het al zelf op.
- **Het aantal banktransacties komt uit één RPC** (zie Supabase). Staat de app
  eerder klaar dan de migratie, dan telt hij nog even op de oude manier.

Dit geldt ook voor elke ververs na een wijziging: die loopt door dezelfde ronde.

### Code: de bundel

- **pdf-lib laadt pas bij de eerste PDF** (`lib/pdf.ts`, `lib/documentExport.ts`,
  de documentopmaak-editor).
- **Los geladen:** de pagina's achter een deellink, het klantportaal en de
  inrichting (`lazy()` in `main.tsx`, met het laadscherm als `Suspense`).
- **Na een nieuwe versie** kan een venster dat al openstond een los geladen
  bestand niet meer ophalen: Pages serveert alleen de laatste deploy. Dat gold al
  voor de lettertypen van de PDF's. `src/lib/chunkReload.ts` kijkt dan of er echt
  een nieuwe versie staat, en vraagt of je wilt herladen. Dat gebeurt niet
  vanzelf, want niet-opgeslagen invoer zou dan verdwijnen.
- Hoofdbundel: **4.409 → 3.721 KB** (gzip 1.308 → 1.060 KB), 19% minder.
- **`index.html` opent de verbinding met Supabase vooraf** (`preconnect`), terwijl
  de JavaScript nog binnenkomt.

### Cloudflare (`public/_headers`)

- `/assets/*` krijgt `Cache-Control: public, max-age=31536000, immutable`. De
  bestanden hebben een hash van hun inhoud in de naam; een nieuwe versie krijgt
  een nieuwe naam. `index.html` blijft altijd navragen, zodat een deploy meteen
  doorkomt.

### Supabase (`20261119100000_opstarten_sneller.sql`)

- `bank_transactions_to_reconcile(p_organization_id)`: controleert de rechten
  één keer, met dezelfde regels als de RLS (lezen in de organisatie én de module
  Financiën), en telt dan via de index `(organization_id, status)`. Zonder
  leesrecht geeft hij 0, zoals de telling via de RLS ook deed.
- Op staging getest in een teruggedraaide transactie, als eigenaar: **4,9 ms**
  tegen 157 ms, met dezelfde uitkomst (1.820). Voor iemand die geen lid is: 0,
  net als de oude telling.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 2.055 geslaagd. Er mislukken 12 tests, precies dezelfde 12 als
  zonder deze wijziging: tests die op `\n` matchen in een Windows-werkkopie met
  CRLF.
- `npm run test:loading`: alle controles geslaagd. De controle van het dashboard
  verwacht nu de RPC en geen HEAD op `bank_transactions`. "Twintig keer verversen
  in vijf seconden" slaagt ook met de nieuwe ronde.
- `npm run test:inrichten`: alle 157 controles geslaagd. De inrichting laadt nu
  los.
- `npm run test:mobile -- --theme=both`: 812 pagina's gemeten, 4 met een
  probleem: het dashboard en de werkruimte-app op de telefoon, met het eerste
  item op 287 px (max 280). Zonder deze wijziging precies hetzelfde; dat
  bestond al.

## Nog open

- **De RLS per rij** zit op elke tabel. De bank-telling liet zien wat dat kost
  naarmate een administratie groeit, en hetzelfde geldt voor
  `journal_lines` en `time_entries`. De structurele oplossing: policies die de
  organisaties van de gebruiker één keer per query opzoeken in plaats van per
  rij. Dat is een eigen klus, met de databasetests erbij.
- **`company_settings.invoice_template_data_url`** (het eigen briefpapier, tot
  286 KB) zit in de kern en komt bij elke start en elke ververs mee. Het hoort
  op aanvraag te laden, maar alle plekken die een PDF maken, moeten het dan
  zeker hebben.
- **De pagina's van de werkruimte** (Agenda, Weekplanner, Boekhouding, …) zitten
  nog in de hoofdbundel: ruim de helft ervan.
- **De CSS is 1,45 MB** (232 KB gzip), met alle looks tegelijk.
