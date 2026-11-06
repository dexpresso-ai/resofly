# Mollie bij een deelbetaling — 6 november 2026

Vraag: "Ga na hoe Mollie hiermee omgaat bij een deelbetaling en pas daar de code
en functie op aan." Het ging om facturen die via Mollie als e-factuur (Peppol)
zijn uitgegeven.

## Hoe Mollie het doet

Bron: de officiële, uit de API-specificatie gegenereerde SDK van Mollie
(`mollie-api-typescript` 1.12.45 op npm, van mollienl), en de pagina's
*Invoice lifecycle* en *Update sales invoice* op docs.mollie.com. Die pagina's
waren vanuit deze sessie niet direct te openen (het netwerkbeleid blokkeert
docs.mollie.com); de velden en hun omschrijving komen uit de SDK.

- **Geen deelbetalingen.** Een Mollie-factuur staat open voor het hele bedrag,
  of is betaald. `paymentDetails` "will store a payment that fully pays the
  invoice". `amountDue` is "the amount that is left to be paid": het hele
  bedrag, zolang de factuur bij Mollie open staat.
- **De betaallink van Mollie** (`_links.invoicePayment`) vraagt dus altijd het
  hele bedrag. Mollie weet niets van een betaling per bank of een creditnota in
  ResoFly.
- **Op betaald zetten kan van buitenaf**: `PATCH /v2/sales-invoices/{id}` met
  `status: paid` en `paymentDetails.source`. De bron is `manual` (buiten Mollie
  om), `payment-link` of `payment`; bij de laatste twee hoort een
  `sourceReference` (het id van de betaling).
- **Statussen**: draft, issuing, issued, pending-payment, paid, overdue,
  payment-reversed, cancelled, expired, failed. Let op: `payment-reversed` met
  een streepje. ResoFly verwachtte `payment_reversed`.

## Wat er misging

1. **Te veel betalen.** De herinnering, de aanmaning, het klantportaal en de
   publieke factuurpagina gaven bij een Mollie-factuur altijd de link van
   Mollie. Na een deelbetaling van € 400 per bank op € 1.000 stond in de mail
   "nog € 600 open", met een knop naar een link van € 1.000.
2. **Dubbel geboekt.** Elke "betaald" van Mollie werd geboekt als ontvangst op
   het Mollie-saldo (1102), ook als iemand de factuur in Mollie handmatig op
   betaald had gezet omdat de klant per bank betaalde. Dan stond de betaling er
   twee keer in, en 1102 hield geld vast dat nooit kwam.
3. **Geld kwijt.** Betaalde de klant via de link van Mollie terwijl de factuur
   in ResoFly al betaald was (per bank), dan legde ResoFly die betaling niet
   vast. Het geld stond op het Mollie-saldo en nergens in de boeken.
4. **Mollie bleef innen.** Was de factuur in ResoFly helemaal betaald of
   gecrediteerd, dan stond hij bij Mollie nog open. De link van Mollie bleef
   werken.
5. **Betaald met geld open.** Elke betaalde Mollie-betaling zette de factuur
   op 'paid', ook als die maar een deel dekte. Dan kwam er geen herinnering
   meer voor de rest.
6. **Betaling kwijt na een storing.** De statusronde zette eerst "betaald" op
   de verzending en legde daarna de betaling vast. Mislukte dat laatste, dan
   sloeg de volgende ronde de factuur over: de betaling kwam nooit binnen.
7. **Herinnering na betaling.** De statusronde draait eens per uur. Wie net
   via de link van Mollie betaalde, kon in dat uur nog een herinnering of
   aanmaning krijgen.

## Wat er nu gebeurt

**Welke betaallink** (`mollieCheckoutDecision` in
`supabase/functions/_shared/mollieSalesInvoice.ts`), in de app, de
herinnering, de aanmaning en het klantportaal. De stand wordt eerst vers bij
Mollie opgehaald.

| Bij Mollie | In ResoFly | Link |
| --- | --- | --- |
| open (issued, overdue) | staat precies het hele bedrag open | die van Mollie |
| open | er is al een deel betaald of gecrediteerd | een eigen link voor het restbedrag |
| er loopt een betaling (pending-payment) | — | geen; wacht |
| betaald via Mollie | — | geen; de betaling wordt meteen vastgelegd |
| betaald buiten Mollie om, geannuleerd, verlopen, mislukt, teruggedraaid | er staat iets open | een eigen link |
| nog niet uitgegeven, of een onbekende status | — | geen |

**Boeken** (de statusronde, `syncMollieSalesInvoice`):

- Een betaling **via Mollie** (`payment` of `payment-link`) wordt altijd
  vastgelegd, ook als de factuur in ResoFly al betaald is. De database meldt
  dan "te veel betaald" met het bedrag.
- **Buiten Mollie om** op betaald gezet (`manual`): niets boeken. Deed iemand
  dat in het Mollie-dashboard, dan staat er een melding bij de factuur.
- **Teruggedraaid** (`payment-reversed`): een terugboeking, net als bij een
  gewone Mollie-betaling (debet 1300, credit 1102; de factuur staat weer open).
  Meldt Mollie hem later weer als betaald, dan vervalt de terugboeking.
- **Eerst de betaling, dan de stand op de verzending**: mislukt het vastleggen,
  dan probeert de volgende ronde het opnieuw.

**Mollie bijwerken**: staat er in ResoFly niets meer open (betaald per bank of
met een eigen link, of gecrediteerd) terwijl Mollie de factuur nog int, dan zet
ResoFly hem bij Mollie op betaald (`manual`). Mollie int hem dan niet meer en
zijn link werkt niet meer. Dat gebeurt bij de statusronde (elk uur), bij het
openen van de factuur en met "Ververs bij Mollie". Een afgeboekte factuur blijft
bij Mollie open: betaalt de klant alsnog, dan is dat welkom.

**Deelbetaling op een Mollie-factuur**: één melding per openstaand bedrag:
"Deelbetaling: Mollie vraagt nog het hele bedrag". In het Mollie-blok bij de
factuur staat die melding, en de knop naar de link van Mollie verdwijnt zolang
die te veel vraagt.

**Herinnering en aanmaning** halen eerst de stand bij Mollie op. Is de factuur
daar betaald, dan gaan ze niet de deur uit.

**Publieke factuurpagina**: alleen nog een betaalknop voor een link die precies
vraagt wat er openstaat (de server haalt een andere link weg, de pagina
controleert het nog eens).

**Database** (`20261106100000_mollie_deelbetaling.sql`):

- `update_invoice_payment_status` kijkt na het boeken wat er volgens het
  grootboek openstaat. Meer dan nul: de factuur blijft open, met de melding
  "Deelbetaling ontvangen via Mollie". Minder dan nul: "Te veel betaald:
  € …", met `needs_review`. Weet het grootboek het niet (de betaling of de
  factuur is niet geboekt), dan zoals eerder: op betaald.
- Vier nieuwe soorten gebeurtenissen: `payment_partial`, `payment_overpaid`,
  `e_invoice_settled` en `e_invoice_partial`. De klant ziet op de publieke
  tijdlijn alleen "Deelbetaling ontvangen"; de rest blijft intern.
- `euro_label_nl(centen)` voor de bedragen in die teksten ("€ 1.234,56").

Ook: `mollieStatusLabel` kent nu `payment-reversed` ("betaling teruggedraaid");
eerder zag je de kale Engelse status.

## Wat niet kan

- **De link in de mail van Mollie** vraagt na een deelbetaling per bank nog het
  hele bedrag. Dat kan ResoFly via de API niet veranderen. Betaalt de klant via
  die link, dan legt ResoFly de betaling vast en meldt hij hoeveel er te veel
  is betaald.
- **Terugbetalen van dat teveel** kan niet met de knop "Terugbetalen" in
  ResoFly: die werkt met Mollie-betalingen (tr_…), en een betaling via de link
  van een Mollie-factuur hoort bij de factuur (invoice_…). Dat was al zo. Betaal
  het terug in het Mollie-dashboard of per bank, en boek die terugbetaling zelf
  tegen debiteuren: ResoFly krijgt hem niet vanzelf binnen.

## Getest

- `mollieSalesInvoice.test.ts`: 16 tests (5 nieuw): `amountDue` en
  `paymentDetails` lezen, wanneer een betaling via Mollie telt, welke link na
  een deelbetaling, wanneer Mollie op betaald gaat, `payment-reversed`.
- `publicTimeline.test.ts`: een deelbetaling heet bij de klant geen "Betaald".
- `src/lib/eInvoicing.test.ts`: de link alleen zolang Mollie int, en de laatste
  melding over een deelbetaling.
- Migratie op staging in een transactie die altijd wordt teruggedraaid, twee
  keer achter elkaar (veilig opnieuw te draaien), als `service_role` zoals de
  edge functions:
  - T1 € 500 van € 1.210 via een eigen link: geboekt, factuur blijft open,
    melding "Er staat nog € 710,00 open".
  - T2 daarna € 1.210 via de link van Mollie: factuur betaald, open −€ 500,
    melding "Te veel betaald: € 500,00", `needs_review`.
  - T3 dezelfde meldingen nog eens: geen nieuwe gebeurtenissen, twee boekingen.
  - T4 een gewone betaling van het hele bedrag: betaald, alleen "Factuur betaald".
  - T5 een factuur buiten het grootboek: zoals eerder op betaald, niet geboekt.
  - T6 `euro_label_nl`: € 1.234,56 · -€ 0,05 · € 0,00 · € 1.000.000,00.
  - T7 de nieuwe soorten gebeurtenissen mogen, een onbekende niet.
- `npm run typecheck`, `npm test` (1096 tests).
- `deno check` van de functielijst uit CI: schoon. `invoice-workflow`,
  `client-portal` en `invoice-public` (staan nog buiten CI): evenveel fouten
  als vóór de wijziging, op precies dezelfde plekken (de bekende
  `Uint8Array`-strengheid).

## Uitrol op staging

- Deploy-run 180 (*Deploy Supabase (staging)*) geslaagd:
  - migratie `20261106100000` doorgevoerd;
  - de edge functions uitgerold;
  - de rooktest groen.
- Live sinds 11:18 uur: `invoice-workflow` versie 130, `client-portal` 110 en
  `invoice-public` 119.
- Nacontrole op de live database:
  - `update_invoice_payment_status` kent deelbetaling en te veel betaald;
  - de vier nieuwe soorten gebeurtenissen bestaan (43 in totaal);
  - `anon` kan geen van de nieuwe of gewijzigde functies aanroepen;
  - de scenario's T1–T7 geven live precies dezelfde uitkomst als in de proef.
