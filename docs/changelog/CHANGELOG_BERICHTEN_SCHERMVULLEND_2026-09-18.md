# Changelog — Berichten: zoeken en filteren bovenaan, twee vensters per klant — 2026-09-18

Op Berichten stond er van alles bóven het gesprek: de werkbalk van de app met "Berichten" en
Ververs, dan de eigen kop met "Berichten" er nóg een keer, dan de tabbladen, en dan pas — in de
kop van de lijst — het zoekveld met de filters. Vier stroken chrome, en het venster waarin je
werkelijk een bericht leest begon ergens op een derde van het scherm. Twee dingen zijn daarom
veranderd.

## 1 · Eén balk bovenaan, de rest is scherm

- **Zoeken, filteren en de tabbladen staan nu in één balk helemaal bovenaan**, boven de vensters
  in plaats van erin. Het zoekveld is de bovenste regel, met de tellers ("3 gesprekken · 5 tickets
  · 1 ongelezen · 2 niet gekoppeld") en *Nieuw bericht* ernaast; de tabbladen en de keuzelijsten
  *Soort*, *Klant* en *Periode* staan op de regel eronder.
- **De app-shell laat zijn eigen werkbalk hier weg**, net als op de agenda, de weekplanner en
  Gerrie. Die toonde alleen de paginatitel nog een keer. Het "Alleen lezen"-plaatje verhuist
  daarom mee naar de balk van de pagina, zodat je nog steeds ziet dat je niets mag versturen.
  *Ververs* vervalt: de lijst laadt zichzelf opnieuw bij elk live-event en bij het wisselen van
  tabblad.
- **De hoogte is niet langer een som.** `100vh` min een optelsom van balken klopt niet meer zodra
  er boven de pagina iets verandert — en dat is nu net gebeurd. De pagina vult wat er over is
  (flex), op elk formaat.
- Op de telefoon is de volgorde: titel met de knop, dan het zoekveld over de volle breedte, dan
  de tabbladen. De filters zitten daar nog steeds achter de schuifjesknop. Het eerste gesprek
  begint daardoor op **206px** in plaats van ~250px; de grens in de mobiele lay-outtest is
  meegeschoven naar 250, anders meet die test niets meer.

## 2 · Een klant gekozen? Twee vensters

- **Kies je in het filter één klant, dan splitst de lijst in twee vensters**: links de
  mailgesprekken van die klant, rechts zijn tickets, elk met een eigen kopje, teller en
  **eigen scrollbalk**. Door de tickets bladeren verschuift de mail niet, en andersom.
- Onder 1250px staan de twee vensters **onder elkaar** (en op de telefoon dus ook): naast elkaar
  is daar geen kolom meer breed genoeg om een onderwerp in te lezen. Het gesprek zelf staat
  rechts, zoals altijd.
- In die twee vensters vervallen het klantrondje en de klantnaam per regel — het is per slot van
  rekening één klant. Die ruimte gaat naar het onderwerp.
- Staat het soortfilter op *alleen e-mail* of *alleen tickets*, dan is er maar één venster te
  vullen en blijft de lijst één kolom. "Zonder klant" splitst niet: daar is geen mail.
- Heeft de klant geen mail (of geen tickets), dan blijft dat venster staan met "Geen
  mailgesprekken van …" — het andere venster verspringt niet.

## 3 · En de mail van die klant is compleet

De gesprekkenlijst is begrensd op de eerste 400 gesprekken van de organisatie: Berichten is een
postvak, geen archief. Voor één klant is dat te weinig — bij een klant met jaren post zou het
mailvenster stilletjes ergens ophouden. Daarom:

- **`loadClientEmailThreadOverviewForClient`** haalt álle gesprekken van de gekozen klant erbij
  (dezelfde view, op `client_id`; de index `idx_client_email_threads_client` bestond al).
- **Zoeken gaat gericht over die ene klant.** `search_client_emails` gaf de nieuwste 200 treffers
  van de hele organisatie terug en de app filterde daar de klant uit. Bij veel post kunnen die
  200 allemaal van ándere klanten zijn — en dan vindt het mailvenster niets terwijl de mail er
  gewoon is. Achteraf filteren op een afgekapte lijst is geen filteren.

## 4 · Onder de motorkap

- **Migratie `20260918000000_communication_client_search.sql`** — *staat klaar, is niet gedraaid.*
  `search_client_emails` krijgt een vierde parameter `p_client_id` (standaard `null` = het oude
  gedrag). `security invoker` blijft: de RLS van `client_emails` geldt onveranderd, en
  `p_client_id` snoeit alleen binnen wat de aanroeper toch al mocht zien. De oude functie wordt
  eerst gedropt: een parameter erbij is een andere signatuur, en met allebei erin is een aanroep
  met drie argumenten dubbelzinnig (*"function … is not unique"*, nagespeeld op Postgres 16).
  PostgREST zoekt op argumentnaam, dus de bestaande aanroep blijft werken.
- **De pagina werkt ook zonder die migratie.** Kent de database `p_client_id` nog niet, dan
  probeert `searchClientEmails` het één keer opnieuw met de oude, driearmige functie: breder dan
  bedoeld, maar geen fout en geen lege lijst. Ontbreekt de functie helemaal, dan zoekt de pagina
  gewoon lokaal verder — zoals voorheen.
- **`lib/communication.ts`:** `splitConversations` (mail links, tickets rechts, allebei in de
  volgorde die de lijst al had). Bewust puur en zonder runtime-imports, dus `node --test` draait
  hem mee: **29 tests** in `lib/communication.test.ts` (`npm test`).
- **`Communication.tsx`:** `comm-topbar` met de zoek-, filter- en tabstrook; `ConversationColumn`
  voor een venster; `ConversationRow` kent een `compact`-variant voor die vensters. De meldingen
  (laden, fout, "nog niet gemigreerd", leeg) staan bij twee vensters één keer bovenaan in plaats
  van in elke kolom.
- **Valkuil die hier is afgevangen:** de tabstrook krijgt op de telefoon van een algemene regel
  `max-width:none` mee. Als flex-item in de nieuwe balk duwde ze de hele pagina 134px zijwaarts.
  `.comm-topbar-sub .comm-tabs` zet `min-width:0;max-width:100%` terug — de strook schuift zelf
  al opzij als ze niet past.

## Wat níét verandert

De opvangbak (Niet gekoppeld), het bewerkvenster van een ticket, het tabblad Communicatie in het
klantdossier en de ticketpagina doen precies wat ze deden. Zoeken en filteren werken op dezelfde
manier en met dezelfde regels; ze staan alleen ergens anders.
