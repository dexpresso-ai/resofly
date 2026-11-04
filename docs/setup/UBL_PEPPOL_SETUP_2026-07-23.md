# UBL / Peppol e-facturatie — setup & runbook (2026-07-23)

E-facturatie volgens **UBL 2.1 / Peppol BIS Billing 3.0** (bevat de NL-regels;
`starts-with`-conform met NLCIUS), **in- én uitgaand**. Stap 1 van de roadmap
[[ubl-peppol-einvoicing-roadmap]]: XML genereren/lezen naast de PDF. **Peppol-
verzending via een access point (stap 2) zit hier nog NIET in** — dit is
download + meesturen per mail + inlezen.

## Wat is gebouwd

**Uitgaand (verkoop):**
- Nieuwe module `supabase/functions/_shared/ubl.ts` — pure UBL 2.1-builder +
  NL-validator (bouwt zowel `Invoice` type 380 als `CreditNote` type 381).
- `invoice-workflow` acties `downloadInvoiceUbl` / `downloadCreditNoteUbl`
  (read-only, viewer mag ook) → base64-XML naar de browser.
- UBL-XML gaat automatisch mee als **tweede bijlage** met de factuur- en
  creditnota-mail (naast de PDF), zodra de gegevens compleet zijn. Onvolledige
  data blokkeert de verzending nooit — dan gaat alleen de PDF mee en meldt de UI
  de reden.
- Knoppen: **E-factuur (UBL)** in de factuurdetail-acties en **UBL** bij elke
  creditnota.

**Inkomend (inkoop):**
- `invoice-extract` herkent een `.xml`-upload en parseert de UBL **deterministisch
  (zonder AI, geen tegoed)** tot hetzelfde concept-inkoopfactuurvoorstel als de
  AI-scan. EN16931-categorie → org-btw-code op **kind** (S→HOOG/LAAG, Z→NUL,
  E→VRIJ, AE→VERL_INK, K→EU_VERW). Duplicaatsignalering op leveranciers­factuur­nummer.
- Zelfde uploadknop ("Factuur scannen (AI / UBL)"), accept nu ook XML.

**Datamodel:**
- Migratie `20260723100000_ubl_client_fields.sql`: `clients` +
  `vat_number, kvk_number, address_line1/2, postal_code, city, country`; RPC
  `create_client_with_next_code` opnieuw gedefinieerd (basis: dunning-versie
  20260722000000, mét `client_kind`) zodat nieuwe klantvelden bij aanmaken
  meelopen. Klantformulier + klantdetail tonen de velden.
- `FinanceLine` krijgt optioneel `vat_code`; factuurregel-editor heeft een
  **btw-code-select** (verlegd/ICP/vrijgesteld) i.p.v. alleen een % — dit maakt
  0%-regels ondubbelzinnig voor de UBL-categorie.

## Normkeuzes (geverifieerd tegen docs.peppol.eu, 2026-07)

- `CustomizationID` = `urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`
- `ProfileID` = `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`
- Peppol-endpoint-schemes NL: **0106** (KVK), **0190** (OIN, 20 cijfers), **9944** (NL-btw).
- NL-regels afgedekt door de validator: NL-R-001 (creditnota → factuurreferentie),
  NL-R-002/004 (adres verkoper/NL-koper), NL-R-003/005 (KVK/OIN), NL-R-007
  (betaalwijze: PaymentMeansCode **58** + IBAN). BR-CO-25 (vervaldatum óf
  betaaltermijn), BT-31 (verkoper-btw ook bij Z/E/AE/K/G).
- Bedragen: btw per **tariefgroep** afgerond, round half away from zero — gelijk
  aan `calculateTotals`/`money.ts`, dus XML, PDF en betaallink tonen hetzelfde totaal.

## Deploy (2026-07-23, staging `enzghpduqwaojcxgwarr`)

Lokale CLI (staging-CI is kapot, zie [[staging-deploy-ci-broken-access-token]]):

```bash
npx supabase db push --yes
npx supabase functions deploy invoice-workflow invoice-extract
```

- Migratie `20260723100000` **TOEGEPAST**.
- Functies **gedeployed**; boot-health (POST zonder geldige origin) geeft nette
  JSON 403, geen `BOOT_ERROR` → beide booten (incl. `fast-xml-parser@4.5.0`
  esm.sh-import in `invoice-extract`).
- `deno check` op de gewijzigde fns: 0 nieuwe fouten (14 pre-existente Deno-lib-
  ruis, identiek aan HEAD). `_shared/ubl.ts` standalone: schoon.
- Round-trip-rooktest (`deno run`) op de UBL-module: 57 checks groen (bouwen →
  valideren → parsen, cent-exact, creditnota-negatie, AE-verlegging, escaping,
  landmapping, duizend-scheider, DOCTYPE-weigering).

## Adversariële review (2026-07-23) — 17 bevindingen, alle gefixt

1 critical (btw-code werd bij opslaan uit de regel gestript), 6 major, 10 minor.
Highlights van de fixes:
- **critical** `cleanForm` behoudt nu `vat_code` op factuur-/offerteregels.
- BT-31 ook vereist bij Z/E/AE/K/G (KOR → waarschuwing i.p.v. blokkade).
- BR-CO-25: vervaldatum óf betaaltermijn afgedwongen.
- Verlegd/EU-inkoopimport: totalencontrole telt geen fantoom-btw meer mee.
- Parser: duizend-scheidingsteken (`1.234,56`) niet meer stil verminkt;
  DOCTYPE geweigerd (entity-amplificatie); PartyLegalEntity-array + Item zonder
  Name defensief; document-AllowanceCharge waarschuwt.
- PDF: klantblok met volledig adres overlapt de tabelkop niet meer.
- Send-flow meldt nu of de UBL is meegestuurd + eventuele aandachtspunten.

## Nog te doen

- **E2e met login**: klant met volledig adres + KVK/btw aanmaken → factuur →
  E-factuur (UBL) downloaden + versturen (2e bijlage in de mail); UBL-inkoop­factuur
  uploaden → concept controleren → boeken.
- **Productie-rollout**: `supabase db push` + `functions deploy` op prod, plus de
  frontend (Pages bouwt bij git-push). Prod draait mogelijk nog op oudere main.
- **Stap 2 (later)**: Peppol-verzending via een access point (SMP/SML,
  los abonnement) — buiten deze scope.
