# Facturen versturen: per e-mail of via Mollie — 7 november 2026

Vraag: "Bouw een functionaliteit in dat men niet verplicht via Mollie hoeft te
factureren, maar dat Resofly dit ook per mail kan doen." En daarna: "Ik bedoelde
dat je via instellingen kunt kiezen of je via Mollie of per mail de facturen
verzendt."

## Wat er was

De Mollie-koppeling was zelf de keuze. Was Mollie gekoppeld, dan:

- ging er bij elke factuur een betaallink van Mollie mee (de app vroeg er
  vanzelf om, zonder vraag per factuur);
- ook bij elke herinnering en aanmaning, als "Betaallink meesturen" aan stond;
- bood het klantportaal "Betaal nu" aan;
- kreeg een klant met e-facturatie op "via Mollie" zijn factuur altijd van
  Mollie. Kon dat niet (een consument, verlegde btw, een kortingsregel), dan
  zei de melding "verstuur per e-mail", maar dat kon alleen door de klant om
  te zetten.

Wie dat niet wilde, kon alleen Mollie ontkoppelen. Dan keek ResoFly ook de
betalingen via eerder verstuurde links niet meer na.

Op staging (7 november, alleen geteld): één organisatie met Mollie gekoppeld,
nul klanten op e-facturatie via Mollie. Voor die organisatie ging dus bij elke
factuur een betaallink van Mollie mee.

## Wat het nu is

**Instellingen → Online betalen → Facturen versturen**, met twee keuzes:

| | Per e-mail | Via Mollie |
| --- | --- | --- |
| Factuur | ResoFly mailt de PDF, zonder betaallink | met een betaallink van Mollie |
| Klant met e-facturatie per mail | e-factuur (UBL met de PDF erin) per mail | idem |
| Klant met e-facturatie via Mollie | e-factuur per mail; Mollie doet niet mee | Mollie geeft hem uit, over Peppol |
| Herinnering en aanmaning | zonder betaallink, ook met "Betaallink meesturen" aan | met link, als dat aan staat |
| Losse betaallink (`createInvoicePaymentCheckout`) | geweigerd, met de reden | zoals het was |
| Klantportaal | alleen de overschrijvingsgegevens, geen "Betaal nu" | "Betaal nu" |
| Gerrie: al verstuurde factuur opnieuw klaarzetten | mag (gaat per mail) | niet voor een klant op "via Mollie" (zou een tweede factuur bij Mollie worden) |

- **Nog niets gekozen** is zoals het was: via Mollie zodra Mollie gekoppeld is,
  en anders per e-mail. Voor bestaande organisaties verandert er dus niets tot
  iemand kiest.
- **Wie kiest**: de eigenaar en een beheerder (de policies op
  `company_settings`). Een lid ziet de keuze, zonder knoppen. Het auditlog legt
  vast wie de keuze wijzigde (`company_settings`, kolom `invoice_send_method`).
- **Mollie blijft gekoppeld** bij "per e-mail". Een betaling via een eerder
  verstuurde link of via een factuur die Mollie uitgaf, legt ResoFly gewoon
  vast (webhook en statusronde). Terugbetalen via Mollie blijft ook kunnen.
- **De server beslist**, niet de browser. Vraagt een oud tabblad of een
  andere route toch om een betaallink, dan komt die er niet; het antwoord zegt
  `mollieAllowed: false`.

Verder in beeld:

- **Factuurdetail**: "Verzendwijze" en het label in de factuurlijst volgen de
  keuze (een klant op "via Mollie" toont per e-mail "E-factuur"). Zonder
  betaallink staat er "Betaling per overboeking" in plaats van "Nog geen
  betaallink".
- **Klantformulier**: staat de klant op Mollie maar verstuur je per e-mail, dan
  zegt de uitleg dat de e-factuur per mail gaat. De controle op ontbrekende
  gegevens volgt wat er bij het versturen echt gebeurt.
- **Klantdossier**: "Aan — per mail, naar … (Mollie staat uit)".
- **Publieke factuurpagina**: zonder betaallink stond er "Er is nog geen actieve
  betaallink beschikbaar. Neem contact op". Met een IBAN staat er nu hoe je
  overmaakt: naar welk IBAN, op welke naam en met welk factuurnummer.
- **Instellingen**: na het koppelen van Mollie beloofde de melding een
  betaallink; verstuur je per e-mail, dan zegt hij dat je daarvoor eerst "Via
  Mollie" kiest. Kies je "per e-mail" zonder IBAN, dan wijst de kaart je erop.
- Een melding noemde "Instellingen → Facturatie" voor het koppelen van Mollie;
  dat tabblad heet Online betalen.

## Database — `20261107100000_facturen_versturen.sql`

- `company_settings.invoice_send_method`: `email`, `mollie` of null, met een
  check. Null = nog niet gekozen.
- Veilig om opnieuw te draaien (`if not exists`, `drop constraint if exists`).

## Code

- `supabase/functions/_shared/eInvoicing.ts`: de regels (`mollieInvoicingAllowed`,
  `effectiveInvoiceSendMethod`, en `invoiceDeliveryChannel` met
  `{ mollieAllowed }`). De browser spiegelt ze in `src/lib/eInvoicing.ts`; een
  test vergelijkt de twee.
- `supabase/functions/_shared/invoiceSendMethod.ts`: leest de keuze, altijd per
  organisatie. Een database zonder de kolom gedraagt zich zoals vroeger; een
  andere fout wordt niet stil "via Mollie".
- `invoice-workflow`: het kanaal bij versturen, de betaallink bij versturen, de
  losse betaallink, en `paymentLinkPossible` (herinnering en aanmaning).
- `_shared/invoiceCheckout.ts` (klantportaal): "Betaal nu" en de checkout.
- `_shared/gerrieCore.ts`: het klaarzetten van (een reeks) facturen.
- App: `saveInvoiceSendMethod` in `src/lib/repository.ts` (los van het
  formulier met bedrijfsgegevens, zoals de Jitsi-server), de kaart in
  `src/features/SimplePages.tsx`, en de verzendknoppen, Gerrie-kaarten en
  herinneringen in `src/main.tsx` en `src/lib/actions/finance.ts`.

## Wat niet in deze wijziging zit

- **"Via Mollie" is wat het al was**: een betaallink van Mollie, en de
  e-factuur via Mollie bij klanten die daarop staan. Dat Mollie álle facturen
  uitgeeft (ook gewone facturen, met een eigen Mollie-nummer) kan de Sales
  Invoices API wel, maar zit hier niet in. Mollie stelt dan andere eisen
  (consumenten met voor- en achternaam, landen, btw-soorten, vaste termijnen).
  *Jouw keuze of dat er moet komen.*
- **De tekst van de factuurmail** noemt het IBAN niet; dat staat op de PDF en
  op de publieke factuurpagina.

## Gevonden onderweg: een factuur van Mollie niet nog eens per mail

Een factuur die Mollie al uitgaf (met Mollies nummer, en bij e-facturatie over
Peppol), kon per e-mail opnieuw weg zodra de klant op "per e-mail" stond: via
Gerrie of rechtstreeks via de functie. Het scherm verborg de knop wel. De klant
had dan twee facturen met een ander nummer, en een boekhoudpakket boekte hem
dubbel. Met de keuze in Instellingen zou dat voor alle klanten tegelijk kunnen.

Nu weigert `invoice-workflow` dat (409, met Mollies nummer in de melding), en
zet Gerrie zo'n factuur niet klaar, ook niet in een reeks (daar staat hij bij
"overgeslagen", met de reden). Wie hem nog eens wil sturen, downloadt de PDF van
Mollie bij de factuur.

## Getest

- `npm test`: 1187 van 1187. Nieuw: de regels in `_shared/eInvoicing.test.ts`
  (per e-mail gaat een klant op "via Mollie" als e-factuur per mail; nog niets
  gekozen is zoals het was), `_shared/invoiceSendMethod.test.ts` (altijd per
  organisatie; een database zonder de kolom gedraagt zich als vroeger; een
  andere fout wordt niet stil "via Mollie"), en in `src/lib/eInvoicing.test.ts`
  dat de browser precies hetzelfde zegt als de server.
- `npm run typecheck`: schoon.
- `deno check` (met een importmap naar npm en jsr, want deno.land en esm.sh zijn
  vanuit deze sessie niet bereikbaar): `gerrie-agent`, `gerrie-agent-runner`,
  `mcp`, `api` en `client-portal` schoon. `invoice-workflow` heeft vóór en na
  dezelfde elf oude meldingen (de bekende strengheid rond `Uint8Array` en
  `string | undefined`), op dezelfde plekken; geen nieuwe.
- Migratieketen vanaf nul (`supabase start`, Postgres 17.6.1.111 zoals
  staging): 251 van 251 migraties. De nieuwe migratie draait daarna nog eens
  zonder fout.
- Stromentest, nieuw scenario `verzendwijze` (`tests/stromen/verzendwijze.mjs`),
  met de echte functies tegen de lokale stack en nep-Mollie: 14 van 14.
  - nog niets gekozen: met betaallink, zoals het was;
  - lid, lezer, boekhouder en kijker kunnen niet kiezen; een onbekende waarde
    weigert de database; de beheerder kiest, het auditlog weet wie;
  - per e-mail: versturen zonder link (ook als de browser erom vraagt), een
    losse link geweigerd, een herinnering zonder link, het klantportaal zonder
    "Betaal nu" en zonder link, een klant op "via Mollie" krijgt de UBL per mail,
    en een factuur die Mollie al uitgaf gaat niet nog eens. Mollie wordt in al
    die stappen niet gebeld;
  - terug naar via Mollie: de link gaat weer mee, en een klant op "via Mollie"
    gaat weer naar de Sales Invoices API.
- Stromentest `rook`, `facturen`, `mollie`, `herinneringen` en `beveiliging`:
  334 stappen, 0 fout (Postgres 17.6.1.178, zoals de README van de test
  aanraadt: op 17.6.1.111 crasht de database bij een expres geweigerde
  functieaanroep in `herinneringen`; daar viel op .111 die ene, bekende stap om).
- `npm run test:loading`: alles geslaagd.
- `npm run test:mobile -- --theme=both`: 344 pagina's, 0 met problemen, met
  Instellingen → Online betalen (telefoon, tablet, liggend en desktop, licht en
  donker). Op de telefoon staan de twee keuzes onder elkaar.
- UI-test in Chromium (`tests/stromen/ui.mjs`, de echte app tegen de echte
  functies), keten `offerte factuur intrekken rollen mollie`: 40 van 40. Nieuw
  in `mollie`:
  - nog niets gekozen en Mollie gekoppeld: "Via Mollie" staat aan;
  - de eigenaar kiest "Per e-mail": opgeslagen, Mollie blijft gekoppeld, en na
    herladen staat het er nog;
  - een lid ziet de keuze zonder knoppen;
  - terug naar "Via Mollie".

  Draai je `factuur` zonder `offerte` erna of ervoor, dan vindt de stap
  "Verstuur via Resend" het concept niet: het werkblad van het lid laadde vóór
  het concept in de database kwam. Dat lag er al; het hoort niet bij deze
  wijziging.
