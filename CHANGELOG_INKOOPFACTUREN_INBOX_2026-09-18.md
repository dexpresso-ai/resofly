# Changelog — Inkoopfacturen per e-mail: doorstuuradres, uitlezen en automatisch klaarzetten — 2026-09-18

Inkoopfacturen komen per mail binnen, maar tot vandaag moest je ze zelf opslaan en via
"Factuur scannen" uploaden. Nu heeft elke organisatie een eigen **factuuradres**. Wat je
daarnaartoe stuurt — of laat sturen — wordt uitgelezen, aan de juiste leverancier gehangen,
op dubbelen gecontroleerd en als concept-inkoopfactuur klaargezet, met het origineel als
bewijsstuk. Boeken blijft één klik, of gaat vanzelf als je dat aanzet.

## 1 · Instellingen → E-mail: "Inkoopfacturen per e-mail"

- **Maak mijn factuuradres aan** geeft een adres als `facturen-jansen-abcd…@inbound.resofly.com`,
  met een **Kopieer**-knop. Het is een tweede doorstuuradres naast het bestaande adres voor
  klantmail; ze staan in dezelfde tabel en delen de negeerlijst en de limiet van 120 mails per uur.
- De statusregel zegt of er al iets binnenkwam, toont de bevestigingscode van Gmail/Microsoft
  als je een doorstuurregel instelt (alleen de code, nooit de link) en waarschuwt als het al
  zes weken stil is.
- Drie schakelaars, direct opgeslagen: **PDF's en foto's met AI uitlezen** (UBL-e-facturen gaan
  altijd, exact en zonder AI), **Onbekende leverancier automatisch aanmaken** en **Direct boeken
  als alles klopt** (standaard uit).
- Vier routes met stappen erbij: zelf doorsturen, een Gmail-filter met doorsturen, een
  Outlook-regel met *Omleiden* (zodat de leverancier de afzender blijft), of het adres
  rechtstreeks aan leveranciers geven. **Nieuw adres aanmaken** laat het oude nog 30 dagen werken.

## 2 · Inkoopfacturen: "Binnengekomen per e-mail"

- Bovenaan de pagina staat de werklijst: wat wordt uitgelezen, wat aandacht vraagt en (uitklapbaar)
  wat is afgehandeld. Per regel: leverancier, factuurnummer, totaal, status, afzender, onderwerp,
  de bijlagen (downloadbaar) en op verzoek de uitgelezen regels en waarschuwingen.
- **Concept klaargezet** → *Open concept* opent het bestaande inkoopfactuurformulier, met de
  PDF/XML als bewijsstuk eronder en een kop die zegt wanneer en van wie de mail kwam.
- **Aandacht nodig** met de reden in gewone taal: leverancier niet herkend (kies er een of laat
  hem aanmaken en *Klaarzetten als concept*), geen factuurbestand, AI niet beschikbaar of tegoed
  op, niets herkend, te veel post tegelijk — en *Opnieuw verwerken* waar dat zin heeft.
- **Dubbel**: zelfde factuurnummer bij dezelfde leverancier, of precies hetzelfde bestand al
  eerder verwerkt. Er wordt niets aangemaakt; *Toch klaarzetten* maakt bewust een tweede concept.
- **Negeren** (geen factuur, niet van ons) en **Herstellen**. Niets verdwijnt stil: elke uitkomst
  is een status met een reden. De lijst ververst zichzelf zolang er wordt uitgelezen.
- In de facturentabel staat een envelopje bij facturen die via het adres binnenkwamen; het
  formulier toont bij bestaande AI-facturen voortaan ook de waarschuwingen uit de uitlezing.

## 3 · Onder de motorkap

- **Migratie `20260918010000_purchase_invoice_inbox.sql`**: `purpose` op
  `organization_inbound_aliases` (mail | invoices), generator met voorvoegsel, `ensure`/`rotate`/
  `resolve` met `p_purpose` (default `mail`, dus bestaande aanroepen werken), tabellen
  `purchase_invoice_inbox` en `purchase_invoice_inbox_settings` (RLS: module Financiën; schrijven
  alleen via service-role en RPC's), `register_purchase_invoice_inbox` (dedup + tellers + drop),
  `set_purchase_invoice_inbox_settings` (owners/admins), `next_purchase_invoice_number` (spiegel van
  de frontend), een trigger die de inbox laat meebewegen met het concept (geboekt / verwijderd /
  geannuleerd), push-type `purchase_invoice_inbox` (één melding per item, alleen aan teamleden met
  toegang tot Financiën via `push_module_member_ids`) en realtime op de inboxtabel.
- **`_shared/invoiceProposal.ts`**: de opbouw van het voorstel (UBL exact, PDF/foto met Claude,
  validatie van rekeningen en btw-codes tegen de organisatie, leveranciersmatch nu ook op
  e-mailadres) is uit `invoice-extract` gelicht, zodat de handmatige scan en de inbox nooit
  uiteenlopen. `invoice-extract` is nu een dunne schil.
- **`_shared/invoiceInbox.ts`**: de verwerking van één item — claim (nooit twee concepten voor
  dezelfde mail), uitlezen (max. vijf bijlagen; UBL leidend, PDF's dan kopie), leverancier
  (BTW-nr → IBAN → e-mail → naam; het eigen adres van de organisatie telt nooit mee),
  dubbelcontrole, concept met totalen per (rekening, btw-code, tarief) zoals `book_purchase_invoice`,
  bijlagen als `attachments` op het concept, en automatisch boeken uitsluitend bij een al bekende
  leverancier, hoge zekerheid, nul waarschuwingen en een rekening op elke regel. Meerdere facturen
  in één mail worden aparte items.
- **`mail-inbound`**: herkent het doel van het alias, past alleen de dropregels toe (geen park:
  facturen komen van no-reply-adressen), zet de bijlagen op R2 via `POST /internal/media` van de
  media-worker en verwerkt op de achtergrond (`EdgeRuntime.waitUntil`). Geen bounce, ook niet bij
  een opslagfout: dan staat het item als *Mislukt* in het scherm.
- **`invoice-inbox`** (nieuw): `process`, `prepare`, `reject`, `restore`; auth als `invoice-extract`.
- **Email Worker**: stuurt voor `facturen-`-adressen de factuurachtige bijlagen mee (per bestand
  ≤ 10 MB, per mail ≤ 14 MB; inline plaatjes en logo's niet) en beschrijft álle bijlagen in
  `attachmentMeta`. **Media-worker**: generieke interne upload `POST /internal/media`.
- **Frontend**: `lib/invoiceInbox.ts` (statussen, redenen, knoppen per status — 6 tests in
  `invoiceInbox.test.ts`), `lib/invoice-inbox-api.ts`, `loadInboundAlias(org, purpose)` met een
  terugval als de migratie nog niet gedraaid is, `downloadStoredFile` in `lib/r2.ts`.
- **CI**: Deno-typecheck op `mail-inbound`, `invoice-inbox` en `invoice-extract`.

Zie [INKOOPFACTUREN_INBOX_SETUP_2026-09-18.md](INKOOPFACTUREN_INBOX_SETUP_2026-09-18.md) voor
de deploy (migratie, functions, beide workers, secrets) en de test.

## 4 · Vervolg (zelfde dag): badge, live, mailtekst, opruimronde, Gerrie

- **Badge in de zijbalk.** Financiën → Inkoopfacturen toont hoeveel binnengekomen facturen op een
  mens wachten (aandacht nodig, dubbel, mislukt). Is het Financiën-menu dichtgeklapt, dan staat de
  teller op Financiën zelf, zodat hij niet uit beeld valt.
- **Live in plaats van pollen.** Eén realtime-abonnement op de inbox (App-niveau,
  `usePurchaseInvoiceInbox`) ververst de badge én het paneel op de pagina; de polling is nu alleen
  nog een langzame terugval (30 s tijdens het uitlezen, anders twee minuten).
- **Factuur in de mailtekst.** Zit er geen factuurbestand in de mail maar ziet de tekst er als een
  factuur uit (factuurwoorden én meerdere bedragen), dan leest de AI de mailtekst uit
  (`extractInvoiceFromText`) en wordt die tekst als `mailtekst.txt` bewijsstuk bij het concept bewaard.
  Begeleidende mails ("zie bijlage") worden bewust níét naar de AI gestuurd. De volledige tekst staat
  nu in `body_text` (max 64k).
- **Opruimronde** (`invoice-inbox?cron=sweep`, pg_cron elk kwartier): items die door een storing
  bleven liggen worden opnieuw opgepakt (nooit gestart, blijven hangen, AI tijdelijk weg, tegoed op,
  limiet van 120/uur; hooguit vier automatische pogingen, vijf per ronde) en de R2-bestanden van
  genegeerde/weggegooide (30 dagen) en dubbele (90 dagen) items gaan weg. Bewijsstukken van een
  concept nooit. De media-worker kreeg daarvoor `DELETE /internal/media/{key}`. Zelfde cron-secret
  als de herinneringen (`INVOICE_REMINDER_CRON_SECRET`), of een eigen `INVOICE_INBOX_CRON_SECRET`.
- **Gerrie en MCP.** `purchase_invoice_inbox.list` (lezen: status, reden, leverancier, nummer,
  totaal, concept) en de voorstellen `purchase_invoice_inbox.prepare` (met leverancierkeuze of
  aanmaken, en `allow_duplicate`), `.reprocess` en `.reject`. De uitvoerders in de browser roepen
  dezelfde edge function aan als de knoppen; de registry-tests bewaken dat beide kanten kloppen.
- **Regels apart en getest.** De beslissingen (welke bijlage een factuur kan zijn, wanneer twee
  bijlagen dezelfde factuur zijn, wanneer er automatisch geboekt mag worden, wat de opruimronde
  opnieuw mag proberen en wat weg mag) staan nu in `_shared/invoiceInboxRules.ts`, import-vrij,
  met 7 node-tests.

## Wat níét verandert

"Factuur scannen" op de pagina Inkoopfacturen, het inkoopfactuurformulier en `book_purchase_invoice`
doen precies wat ze deden; ze delen nu alleen de voorstel-opbouw met de inbox. Het doorstuuradres
voor klantmail en de opvangbak zijn onaangeroerd.
