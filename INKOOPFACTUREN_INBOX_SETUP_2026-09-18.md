# Inkoopfacturen per e-mail — setup (factuur-inbox)

Datum: 2026-09-18 · branch `claude/incoming-invoices-automation-u179jz`

Doel: inkoopfacturen die per mail binnenkomen automatisch uitlezen, de
leverancier herkennen (of aanmaken), dubbele facturen tegenhouden en een
concept-inkoopfactuur klaarzetten — desgewenst meteen boeken. De gebruiker
kopieert onder **Instellingen → E-mail → Inkoopfacturen per e-mail** zijn
factuuradres en koppelt dat zelf aan zijn mailadres (doorstuurregel of filter),
of geeft het rechtstreeks aan leveranciers.

## Hoe het werkt (kort)
1. Elke organisatie krijgt een tweede doorstuuradres met `purpose = 'invoices'`:
   `facturen-<slug>-<16 tekens>@inbound.resofly.com` (zelfde tabel en generator
   als het klantmail-adres, zelfde rate-limit en negeerlijst).
2. Cloudflare Email Routing → **Email Worker** (`workers/email-inbound`). Voor een
   `facturen-`-adres stuurt de Worker de factuurachtige bijlagen (PDF, XML,
   afbeelding) als base64 mee; inline plaatjes en logo's niet.
3. **`mail-inbound`** herkent het doel uit de database, legt de mail vast in
   `purchase_invoice_inbox` (`register_purchase_invoice_inbox`: dedup, tellers,
   dropregels), zet de bijlagen op R2 via de media-worker (`POST /internal/media`)
   en start de verwerking op de achtergrond (`EdgeRuntime.waitUntil`).
4. **`_shared/invoiceInbox.ts`** doet de rest: UBL exact / PDF-foto met AI
   (`_shared/invoiceProposal.ts`, dezelfde opbouw als "Factuur scannen"),
   leverancier (BTW-nr → IBAN → e-mail → naam), dubbelcontrole (factuurnummer
   bij dezelfde leverancier, of hetzelfde bestand), concept + bijlagen als
   bewijsstuk, en — alleen met `auto_book` aan en álle voorwaarden groen —
   `book_purchase_invoice`.
5. **`invoice-inbox`** (edge function) bedient de knoppen in het scherm:
   opnieuw verwerken, klaarzetten met een gekozen/nieuwe leverancier, toch
   klaarzetten bij een duplicaat, negeren, herstellen.

## Onderdelen in deze repo
- `supabase/migrations/20260918010000_purchase_invoice_inbox.sql`
- `supabase/functions/_shared/invoiceProposal.ts` (uit `invoice-extract` gelicht)
- `supabase/functions/_shared/invoiceInbox.ts`
- `supabase/functions/mail-inbound/index.ts` (factuurroute)
- `supabase/functions/invoice-inbox/index.ts` (+ `supabase/config.toml`)
- `workers/email-inbound/src/index.ts` (bijlagen meesturen)
- `workers/media-api/src/index.ts` (`POST /internal/media`)
- Frontend: `src/lib/invoiceInbox.ts`, `src/lib/invoice-inbox-api.ts`,
  instellingenkaart in `SimplePages.tsx`, inbox-paneel in `Bookkeeping.tsx`.

## Stap 1 — Migratie
Loopt mee met de staging-deploy (`supabase db push`). Handmatig:
```bash
supabase db push
```
De migratie vervangt `ensure_organization_inbound_alias`,
`rotate_organization_inbound_alias` en `resolve_inbound_alias` door varianten
met een `p_purpose`; aanroepen zonder dat argument blijven werken (default `mail`).
De frontend vangt de tussenperiode op (kolom/functie nog niet aanwezig → geen fout).

## Stap 2 — Edge functions + secrets
```bash
supabase functions deploy mail-inbound
supabase functions deploy invoice-inbox
supabase functions deploy invoice-extract   # deelt nu _shared/invoiceProposal.ts
```
Secrets die `mail-inbound` en `invoice-inbox` nodig hebben (naast wat er al is):
- `MEDIA_WORKER_URL` + `INTERNAL_UPLOAD_SECRET` — de media-worker en zijn interne
  secret. Ontbreken ze, dan vallen de functies terug op
  `INVOICE_PDF_STORAGE_WORKER_URL`/`INVOICE_PDF_STORAGE_SECRET` en daarna
  `QUOTE_PDF_STORAGE_WORKER_URL`/`QUOTE_PDF_STORAGE_SECRET` (dezelfde worker,
  hetzelfde secret), dus meestal is er niets extra's te zetten.
- `ANTHROPIC_API_KEY` (Gerrie) voor het uitlezen van PDF's/foto's. UBL werkt zonder.
- `INVOICE_ALLOWED_ORIGINS` (of `GERRIE_ALLOWED_ORIGINS`/`APP_PUBLIC_URL`) voor de
  CORS van `invoice-inbox`, zoals bij `invoice-extract`.

Zonder media-worker: de mail wordt wél vastgelegd, maar het item krijgt status
*Mislukt* met reden `storage_unavailable` — zichtbaar in het scherm, niets
verdwijnt stil. De gebruiker stuurt de mail opnieuw door nadat het is gezet.

## Stap 3 — Workers opnieuw deployen
```bash
cd workers/media-api && npm run deploy            # nieuwe route POST /internal/media
cd workers/email-inbound && npm run deploy:staging # bijlagen meesturen voor facturen-*
```
Draait de oude Email Worker nog, dan komen facturen wel binnen maar zonder
bijlagen: het item krijgt reden `attachments_missing` ("is de Email Worker
bijgewerkt?"). De catch-all-route in Cloudflare hoeft niet te veranderen: het
factuuradres past in dezelfde alias-syntaxis.

## Stap 4 — Testen
1. Instellingen → E-mail → *Inkoopfacturen per e-mail* → **Maak mijn factuuradres aan** → Kopieer.
2. Stuur vanuit je eigen postvak een mail met een factuur-PDF door naar dat adres.
3. Onder **Inkoopfacturen** verschijnt bovenaan "Binnengekomen per e-mail": eerst
   *Wordt uitgelezen…*, daarna *Concept klaargezet* (open het concept: regels,
   BTW, leverancier, bijlage als bewijsstuk) — of *Aandacht nodig* met de reden.
4. Stuur dezelfde mail nog eens: status *Dubbel* (zelfde bestand), niets aangemaakt.
5. Zet *Direct boeken als alles klopt* aan en stuur een UBL-e-factuur van een
   bekende leverancier met standaard-grootboekrekening: status *Geboekt*.
6. Bij problemen: Supabase-logs van `mail-inbound` (registratie/opslag) en de
   `invoice-inbox`-verwerking (`invoice-inbox:`-regels), Worker-logs (`wrangler tail`).

## Instellingen (per organisatie, owners/admins)
| Instelling | Standaard | Betekenis |
|---|---|---|
| PDF's en foto's met AI uitlezen | aan | Uit = alleen UBL automatisch; PDF's wachten op een mens |
| Onbekende leverancier automatisch aanmaken | aan | Alleen met naam én zekerheid ≠ laag; anders *Leverancier niet herkend* |
| Direct boeken als alles klopt | uit | Alleen bekende leverancier (BTW/IBAN/e-mail), zekerheid hoog, geen waarschuwingen, rekening op elke regel |

Het AI-verbruik telt mee op het maandplafond van wie het factuuradres aanmaakte
(`organization_inbound_aliases.created_by`), net als Gerrie.

## Aandachtspunten
- **Meerdere facturen in één mail**: elke uitgelezen factuur krijgt een eigen
  inbox-item (en dus een eigen concept). Zit er een UBL-XML bij, dan is die
  leidend en gelden PDF's in dezelfde mail als kopie (niet apart uitgelezen).
- **Niet verwerkt maar wel zichtbaar**: bounces/auto-replies (`dropped`, niet in
  het scherm), geblokkeerde afzenders, mail zonder factuurbestand, te grote mail
  (> 12 MB), meer dan 120 mails per uur op het adres (`rate_limited`).
- **Dubbel** = zelfde factuurnummer bij dezelfde leverancier (niet geannuleerd) of
  precies hetzelfde bestand al eerder tot een concept geleid. "Toch klaarzetten"
  maakt bewust een tweede concept.
- **Rechten**: lezen en knoppen volgen de module Financiën; het adres en de
  automatisering beheren alleen owners/admins.
- **Meldingen**: nieuw push-type `purchase_invoice_inbox` (Instellingen →
  Meldingen), één melding per item, alleen aan teamleden met toegang tot Financiën.
