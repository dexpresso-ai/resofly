# Bonnen fotograferen en declaraties (2026-11-18)

De vraag: maak het mogelijk om bij inkoopfacturen snel een foto of scan van een bon te maken,
die wordt uitgelezen en standaard als concept wordt opgeslagen.

Daarbij is gekozen:

- **Tijdens het lezen een animatie van Gerrie.** Daarna de keuze: **Verder** of **Nieuwe boeking**.
- **Ieder teamlid mag een bon insturen.** Wie Financiën niet mag bewerken, dient zo een
  **declaratie** in. Je ziet alleen je eigen declaraties, en zeker niet die van een collega of
  van een andere organisatie. Iemand met Financiën keurt goed.
- **De knop staat op Inkoopfacturen.** Een declarant heeft een eigen pagina Declaraties.
- **Betaling: geen voorkeur.** Er is dus geen nieuwe boekingslogica. Een bon is een gewone
  concept-inkoopfactuur, en de betaling (of de terugbetaling van een declaratie) koppel je
  op de pagina Bank.

## Wat er nu kan

### Bon fotograferen (Inkoopfacturen)

- Bovenaan Inkoopfacturen staan twee nieuwe knoppen:
  - **Bon fotograferen**: op de telefoon gaat meteen de achtercamera open, op een computer
    de bestandskiezer;
  - **Uit galerij**: foto's of pdf-scans, tot tien tegelijk.
- De app zet de foto rechtop en verkleint hem tot 2400 pixels aan de lange kant. Zo blijft de
  bon goed leesbaar als bewijsstuk, en gaat hij snel over 4G (meestal een halve megabyte).
- Daarna opent het bonvenster, met **Gerrie aan het werk**:
  - je foto ligt als bonnetje op een scanner, met een lichtstraal en het orbje van Gerrie;
  - een stappenbalk: Foto klaarmaken, Versturen, Gerrie leest de bon, Opslaan als concept;
  - een klok, en een regel met waar Gerrie naar kijkt.

  Met "minder beweging" staat de animatie stil.
- De uitslag, met daaronder **Nieuwe boeking** (de camera gaat weer open) en **Verder**:

  | Uitslag | Wat je ziet | Wat Verder doet |
  | --- | --- | --- |
  | Gelukt | "Opgeslagen als concept INK-2026-0042", met winkel, datum en totaal | opent het concept om na te kijken |
  | Winkel nog geen leverancier | "Gelezen, maar de winkel is nog geen leverancier": kies er een of maak hem aan, dan staat het concept er | sluit het venster |
  | Al ingestuurd | "Deze bon is al eerder ingestuurd", met **Toch opslaan als concept** | opent de bon die er al was |
  | Niet gelezen (AI uit, tegoed op, niets herkend) | de reden, met **Zelf invullen** | sluit het venster |
  | Storing | **Opnieuw proberen** of **Zelf invullen** | sluit het venster |

- Er wordt **nooit** vanzelf geboekt, ook niet met "Direct boeken als alles klopt" aan. Een bon
  is altijd eerst een concept.
- Gerrie hoort dat het een bon is, en leest hem anders dan een factuur:
  - de winkel bovenaan is de leverancier;
  - het bonnummer wordt het factuurnummer, en er is geen vervaldatum;
  - de bedragen staan inclusief btw; Gerrie gebruikt de btw-specificatie onderaan;
  - per btw-tarief komt er één regel ("Boodschappen", "Brandstof");
  - de betaalwijze (pin, contant) komt in de notities.

  Eerst werd een boodschappenbon dertig regels van een paar cent.
- Twee bonnen van dezelfde winkel, op dezelfde dag en voor hetzelfde bedrag, geven een
  waarschuwing op het concept ("Lijkt op INK-…"). Twee foto's van één bonnetje zijn elk een
  ander bestand, dus de controle op bestand ziet dat niet. Het is wel bewust geen blokkade:
  twee keer parkeren op één dag komt voor.

### Declaraties (teamleden zonder Financiën)

- Een nieuwe pagina **Declaraties**. Je vindt hem:
  - in de zijbalk onder Financiën;
  - in Baken, Zenit en Stroom onder Geld → Mijn declaraties;
  - op de telefoon in de duimbalk, op de plek van Financiën.

  De pagina is er voor wie schrijft maar Financiën niet mag bewerken: een lid met Financiën op
  "geen" of "alleen lezen". Een kijker of de boekhouder ziet hem niet. Wie Financiën wél
  beheert, fotografeert zijn bon op Inkoopfacturen. Komt hij via een oud tabblad toch op
  Declaraties, dan wijst de pagina hem de weg.
- Op de pagina staat dezelfde knop. Na de foto zie je "Je declaratie is ingediend", met winkel,
  datum en totaal, en daaronder **Nieuwe declaratie** en **Verder**.
- De lijst toont per declaratie de status: Wordt gelezen, Ingediend, Goedgekeurd, Uitbetaald of
  Afgewezen. Bij een afwijzing staat de reden erbij.
- **Alleen je eigen declaraties, en dat bewaakt de database.** De lijst komt uit één functie,
  `list_my_declarations`, die filtert op wie er is ingelogd. Ze geeft alleen de velden over je
  eigen bon terug: geen waarschuwingen, geen leverancier of concept, niets van een ander. Een
  waarschuwing kan namelijk een andere factuur noemen ("staat al als INK-2026-0012"), of het
  IBAN dat bij een leverancier bekend is. Ook het antwoord na het insturen bevat alleen je
  eigen bon. De werklijst en de inkoopfacturen blijven achter de module Financiën.

### Goedkeuren en afwijzen (Financiën)

- De werklijst op Inkoopfacturen heet nu **Binnengekomen**. Eerst heette hij "Binnengekomen per
  e-mail".
  - Er staan nu ook bonnen en declaraties op, met een camera en "Bon van …" of
    "Declaratie van …".
  - Een declaratie die op goedkeuring wacht, staat bovenaan en telt mee in de badge.
- Bij een declaratie:
  - **Goedkeuren** boekt het concept, na een bevestiging. Dat is de goedkeuring die de
    indiener ziet;
  - **Afwijzen** vraagt altijd een reden, en de indiener leest die. Het concept gaat weg, maar de
    foto blijft bij de declaratie, onder afgehandeld. Met **Herstellen** komt hij terug;
  - **Negeren** kan niet. Een declarant hoort te weten waarom zijn bon niet doorging.
- In de lijst van inkoopfacturen staat bij een declaratie **Goedkeuren** in plaats van Boeken.
  Het formulier zegt "Declaratie van …", en dat boeken goedkeuren is.
- Er is een nieuw meldingstype **Declaraties** (Instellingen → Meldingen):
  - wie Financiën mag bewerken, hoort het als een teamlid een declaratie indient;
  - de indiener hoort het als zijn declaratie is goedgekeurd of afgewezen, met de reden.

  Een bon die je zelf fotografeert, geeft geen melding: de uitslag staat al op je scherm.

### Zelf invullen

Als Gerrie een bon of factuur niet las (AI uit, tegoed op, niets herkend, een storing), staat er
op de werklijst **Zelf invullen**. Dat geldt ook voor mail. Het formulier opent met wat er wél
gelezen is, en met de foto ernaast. Na het opslaan hoort het item bij het nieuwe concept, met
het bestand als bewijsstuk.

Eerst bleef zo'n item op "aandacht nodig" staan, en moest je het negeren. Bij een declaratie
las de indiener dat als "afgewezen".

### AI: wie nee zei, blijft nee

De bon van iemand die zelf voor geen AI koos, gaat niet langs het model. Hetzelfde geldt als
een beheerder Gerrie voor hem dichtzette. Het item staat dan als "niet gelezen" op de
werklijst, met Zelf invullen. "Nog niet gekozen" telt niet als nee: wie op Bon fotograferen
drukt, vraagt Gerrie om die ene bon te lezen, zoals "Factuur scannen" dat altijd deed.

De instelling van de organisatie ("PDF's en foto's met AI uitlezen") geldt ook voor bonnen.

## Hersteld: de controle op een dubbel bestand in de factuur-inbox

De factuur-inbox controleert of precies hetzelfde bestand al eerder tot een concept leidde. Die
controle kon sinds 18 september nooit draaien. supabase-js maakt van een lijst in
`.contains()` een Postgres-array (`cs.{[object Object]}`), en de database weigerde dat op de
jsonb-kolom `attachments` met "invalid input syntax for type json".

Daardoor kwam elke per e-mail binnengekomen factuur met een bestand op **Mislukt** (onverwachte
fout), behalve als het factuurnummer al bij de leverancier bekend was. De opruimronde probeerde
het vier keer opnieuw, steeds met dezelfde uitkomst. Elke bon uit de app had hetzelfde gehad.
Nu gaat de filter als JSON-tekst mee. Gevonden met het nieuwe stromen-scenario `bonnen`, dat ook
toetst dat dezelfde foto later nog eens als dubbel wordt herkend.

## Onder de motorkap

- **Migratie `20261118120000_bonnen_en_declaraties.sql`** (veilig opnieuw te draaien):
  - op `purchase_invoice_inbox` de kolommen `channel` (email, receipt of declaration),
    `submitted_by` en `review_note`, plus een index op indiener;
  - `list_my_declarations(p_organization_id)`: security definer, alleen
    `submitted_by = auth.uid()` en alleen voor een actief lid. Dicht voor anon;
  - `inbox_text_to_date`: een kapotte datum uit een uitlezing breekt de lijst niet;
  - de sync-trigger zet bij boeken `handled_by` en `handled_at`;
  - het push-type `declaration` staat in beide CHECKs, en de push-trigger heeft een tak per kanaal.
- **`invoice-inbox`** kreeg drie nieuwe acties:
  - `upload`: mag ieder teamlid dat schrijft. Het kanaal volgt uit het recht op Financiën,
    en de indiener uit de sessie, nooit uit de invoer. Een foto (JPG, PNG, WEBP) of pdf tot 10 MB;
    de bytes moeten kloppen met het type. Hooguit 60 bonnen per uur per persoon. Een tweede
    verzoek met hetzelfde verzoek-id geeft dezelfde bon. Kan de foto niet worden opgeslagen,
    dan blijft er geen rij achter (502). De verwerking staat in `waitUntil`;
  - `decline`: alleen voor een declaratie, alleen met een reden en alleen zolang hij niet
    geboekt is;
  - `link`: "zelf invullen".

  Alle acties behalve `upload` vragen, zoals eerst, Financiën met schrijfrecht.
- **`_shared/invoiceInbox.ts`**:
  - een bon gebruikt het afzenderadres niet om de leverancier te herkennen (dat is het teamlid
    zelf), weegt de AI-keuze van de indiener, leest met de bonprompt, boekt nooit vanzelf en
    geeft de waarschuwing "lijkt op";
  - nieuw: `createUploadItem`, `declineDeclaration`, `linkInboxItem` en `attachToInvoice`;
  - het AI-tegoed is dat van de indiener;
  - `rejectInboxItem` weigert een declaratie, en `restoreInboxItem` wist de reden.
- **`_shared/invoiceInboxRules.ts`**: de regels zonder imports, met tests in
  `receiptUpload.test.ts`. Het gaat om het kanaal, de bestandstypen, de bytes, de AI-keuze, de
  status voor de indiener, wat een declarant terugkrijgt, wanneer afwijzen mag, en de
  waarschuwing "lijkt op".
- **Handelingen van Gerrie en MCP**: `purchase_invoice_inbox.list` geeft kanaal, indiener en de
  reden van een afwijzing. `purchase_invoice_inbox.reject` weigert een declaratie.
- **App**:
  - nieuw: `components/ReceiptCapture.tsx` (het venster), `features/Declarations.tsx`,
    `lib/receipts.ts` (puur, met `receipts.test.ts`), `lib/receipt-api.ts` (foto verkleinen,
    insturen met herkansing bij een haperende verbinding) en `styles/bonnen.css`;
  - de pagina `declarations` met de regel `canSubmitDeclarations` in `permissions.ts`;
  - `loadPurchaseInvoiceInbox` en de teller vallen terug op de oude kolommen zolang de migratie
    nog niet gedraaid is.
- **Gegevensexport**: `EXPORT_SCHEMA_VERSION` gaat naar `20261118120000`; de nieuwe kolommen
  gaan mee met de inbox.

## Getest

Op 18 november is staging hierin samengevoegd (eenmanszaak, btw-tijdvak wisselen, instellingen
in groepen). De migratie heette eerst `20261117120000`. Ze kreeg een nummer na de twee migraties
die staging die ochtend kreeg; anders had ze vóór de laatste op staging gestaan, en dan draait
ze daar nooit. Na het samenvoegen opnieuw gedraaid: typecheck, `npm test`, `deno check`, de
build, de keten vanaf nul, de SQL-controle en alle stromen-scenario's.

- `npm run typecheck`: schoon.
- `npm test`: 1971 tests, alle geslaagd. Nieuw zijn `receiptUpload.test.ts` (regels, edge
  function, migratie en meldingen) en `receipts.test.ts` (scherm en rechten).
- `deno check` op de lijst uit `frontend-checks.yml` (40 bestanden): schoon. esm.sh en deno.land
  zijn vanuit deze sessie niet bereikbaar, dus de imports gingen via een import map naar
  dezelfde versies op npm en JSR. In CI loopt de controle gewoon via esm.sh.
- `supabase db start`: de hele keten op een lege database, met de nieuwe migratie als laatste
  (na `20261118100000`); daarna de migratie nog eens: geen fout. De twee nieuwe migraties van
  staging raken de inbox, de meldingen en hun controles niet.
- Een SQL-controle op die database:
  - een lid zonder Financiën ziet 0 rijen van de werklijst en alleen zijn eigen declaratie;
  - een andere organisatie wordt geweigerd, en anon mag de functie niet aanroepen;
  - de melding "ingediend" gaat alleen naar wie Financiën mag bewerken (niet naar de lezer en
    niet naar de indiener), en een eigen bon geeft geen melding;
  - afwijzen en goedkeuren geven alleen de indiener een melding;
  - boeken zet de goedkeuring met wie en wanneer, en een kanaal dat niet bestaat, wordt geweigerd.
- `npm run test:stromen -- bonnen`: 22 stappen, alle geslaagd, met de echte edge function, de
  echte database, een nep-Claude en een nep-media-worker. Daarin ook de teller van de badge,
  precies zoals de app hem aan PostgREST vraagt. Zie `tests/stromen/README.md`.
- `npm run test:stromen` (alle scenario's, na het samenvoegen): 1195 stappen, 0 fout. De
  eerste keer faalden 13 stappen van `bonnen`, terwijl het scenario alleen wel slaagde.
  `rapportages` zet een eigen nep-Claude neer die de rest van de run blijft staan, en die gaf
  op een bon de notulen terug. Het bonantwoord is nu gedeeld (`bonAntwoord` in `nep-ai.mjs`,
  zoals de poortwachter), zodat de volgorde van de scenario's niet uitmaakt.
- `npm run test:mobile -- --theme=both`: 722 metingen, alle in orde. Twee haalden eerst de
  wachttijd van 20 seconden niet: `declaratie-afwijzen` en het bestaande `inrichten-facturen`,
  allebei op tablet in donker. Er draaiden toen andere tests naast. Opnieuw gemeten slaagden
  ze. Nieuw in de test:
  - de pagina's Inkoopfacturen (met de werklijst) en Declaraties, elk met een grens voor het
    eerste item (322 en 354 px gemeten, grens 386 en 425);
  - het bonvenster: terwijl Gerrie leest, na een concept en na "winkel nog geen leverancier";
  - het afwijzen van een declaratie, en een ingediende declaratie;
  - een stap die een bestand kiest, zoals de camera dat doet.

  Daarbij één nieuwe controle: een venster mag niet zijwaarts scrollen (`contained`). Een
  venster staat vast boven de pagina, dus de bestaande meting van `.content` zag het niet. Bij
  "winkel nog geen leverancier" liep de kaart op de telefoon 220 px rechts uit het venster: een
  keuzelijst met een lange naam krimpt in een flex-rij en een grid niet vanzelf. Dat is
  hersteld (`bonnen.css`), en met de oude opmaak faalt de controle.
- `npm run test:loading`: alles geslaagd, ook Inkoopfacturen (alleen de kern, geen groep).
- `npm run test:terugknop`: 14 geslaagd. Nieuw: na de foto sluit terug het bonvenster, en
  daarna gaat terug naar het dashboard. Dat geldt op Inkoopfacturen en op Declaraties.

## Wat (nog) niet

- **De betaalwijze wordt niet vastgelegd.** Een contante of privé betaalde bon blijft als
  schuld aan de leverancier staan, tot je de betaling koppelt of met een memoriaalboeking
  wegboekt. Een declaratie betaal je terug met een overboeking aan het teamlid; die koppel je
  op Bank aan de inkoopfactuur.
- **Een declarant kan zijn foto achteraf niet terugzien.** De media-worker bewaakt bestanden
  van de factuur-inbox met de module Financiën. Direct na het insturen staat de foto wel in
  beeld.
- **Gerrie en de MCP-koppeling kunnen een declaratie nog niet afwijzen.** Dat kan alleen op de
  pagina Inkoopfacturen.
- In de losse app Financiën staat Declaraties niet. Een declarant gebruikt de werkruimte.
