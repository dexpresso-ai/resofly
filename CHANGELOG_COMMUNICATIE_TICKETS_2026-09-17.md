# Changelog — Tickets in het klantdossier en op Berichten, filteren en zoeken — 2026-09-17

Tickets leefden alleen op de ticketpagina. Wie in een klantdossier stond en wilde weten "loopt
er nog iets voor deze klant?" moest naar Tickets en daar op de klant filteren; wie op Berichten
keek of er nieuwe post was, zag de reactie van een klant op een ticket niet, want dat is geen
mail. Drie dingen zijn daarom veranderd.

## 1 · Klantdossier: tabblad Tickets

- **Nieuw tabblad "Tickets"** in de tabstrook van het klantdossier, tussen Projecten en Offertes.
  De teller is het aantal tickets van deze klant; een **stip** naast de teller zegt dat er een
  ticket tussen zit met nieuwe klant-activiteit (een reactie uit het portaal, of een ticket dat
  de klant zelf aanmaakte) die jij nog niet gezien hebt.
- **Dezelfde kaarten als op de ticketpagina** (titel, prioriteit, "Nieuw", status), laatste
  activiteit bovenaan — dat is het ticket zelf óf de laatste notitie op de tijdlijn, wat het
  meest recent is. Per kaart staat hoeveel notities er zijn en wanneer er voor het laatst iets
  gebeurde.
- **Openen** = het bewerkvenster van het ticket, met status, prioriteit, bijlagen en de
  tijdlijn; het ticket telt dan als gelezen (zoals op de ticketpagina). **+ Nieuw ticket** maakt
  een ticket aan met deze klant al ingevuld.
- Het zoekveld boven het tabblad zoekt in titel, omschrijving, interne notitie, status en
  prioriteit; de keuzelijst ernaast filtert op status (Openstaand, Nieuw, Review, …).
- **Rechten:** het tabblad staat er alleen als de module *Tickets* voor dit teamlid open is;
  "+ Nieuw ticket" en de tijdlijn volgen het schrijfrecht op die module, niet op Klanten.

## 2 · Berichten: tickets tussen de mail

- **Tickets staan nu tussen de mailgesprekken** op Alle gesprekken, op laatste activiteit
  gesorteerd — mail en tickets door elkaar, nieuwste bovenaan. Een ticketregel is herkenbaar
  aan het label *Ticket* naast de klantnaam en de status als pil; de previewregel is de
  laatste notitie ("Maria: Vooral op de pagina met afspraken…", "Jij: We kijken ernaar"),
  zonder notities de omschrijving. Een ticket zonder klant krijgt een ticket-icoon en de naam
  "Geen klant".
- **Ongelezen** telt nu ook tickets met nieuwe klant-activiteit mee (badge *Nieuw* op de regel).
  De kop zegt "x gesprekken · y tickets · z ongelezen · n niet gekoppeld".
- **Een ticket openen** toont rechts de kop (klantchip naar het dossier, status, prioriteit,
  aanmaakdatum, aantal notities), de omschrijving, een eventuele interne notitie en de
  **tijdlijn** — precies dezelfde component als in het bewerkvenster, dus je antwoordt de
  klant vanaf Berichten, zichtbaar of intern. Openen = lezen: de "Nieuw"-markering gaat weg.
  *Ticket openen* brengt je naar het volledige bewerkvenster (status wijzigen, bijlagen).
- **Meldingen** ("Nieuw ticket", "Nieuwe reactie") blijven het bewerkvenster openen, zoals ze
  deden. De badge op de menuregel *Berichten* telt zoals voorheen alleen mail en opvangbak; de
  ticketbadge staat op *Tickets*. Zo telt niets dubbel in het menu.
- **Rechten:** tickets verschijnen alleen als de module *Tickets* open is; het soortfilter en
  de ticketteksten in de kop verdwijnen dan mee.

## 3 · Filteren en zoeken op Berichten

- **Filters onder het zoekveld:** *Soort* (mail en tickets / alleen e-mail / alleen tickets),
  *Klant* (alleen klanten die daadwerkelijk een gesprek of ticket hebben, plus "Zonder klant"
  als er losse tickets zijn) en *Periode* (vandaag, deze week vanaf maandag, deze maand,
  afgelopen 30 of 90 dagen, dit jaar, of een eigen van/tot). De periode kijkt naar de laatste
  activiteit van het gesprek. "Filters wissen" in de lege staat zet alles terug.
- **Op de telefoon** zitten de filters achter de schuifjesknop naast het zoekveld (met het
  aantal actieve filters erop), zodat het eerste gesprek niet lager in beeld komt. Op een
  breed scherm staan ze er altijd.
- **Zoeken door alle tickets en berichten.** Eén zoekveld, alle woorden moeten voorkomen, in
  willekeurige volgorde, zonder hoofdletters en accenten:
  - lokaal in klant, onderwerp, afzender en preview — en bij een ticket in de titel, de
    omschrijving, de interne notitie en **élke notitie op de tijdlijn** (ook interne; de pagina
    is er voor het team);
  - **in de database door álle mail** (nieuwe functie `search_client_emails`): de lijst kent per
    gesprek alleen het laatste bericht, maar een woord uit een mail van drie weken terug vindt
    het gesprek nu ook. De aanvraag gaat pas na een korte typ-pauze en meldt "Zoeken in alle
    berichten…"; een gesprek dat buiten de eerste 400 van de lijst valt wordt erbij geladen.
  - Onder een gesprek dat alleen "dieper" raak was staat **"Gevonden: …"** met een stukje
    tekst rond de treffer, zodat je ziet waarom het in de lijst staat.
  - Bestaat de zoekfunctie in de database nog niet (migratie nog niet gedraaid), dan zoekt de
    pagina gewoon lokaal verder; er verschijnt geen fout.

## 4 · Onder de motorkap

- **Migratie `20260917060000_communication_search.sql`:** SQL-functie
  `search_client_emails(org, zoektekst, limiet)` — `security invoker`, dus de RLS van
  `client_emails` geldt (eigen organisatie, module Klanten, verwijderde berichten onzichtbaar).
  Jokertekens in de zoektekst worden ontsnapt; woorden korter dan twee tekens tellen niet mee;
  het tekstfragment wordt alleen voor de gevonden rijen berekend. Alleen `authenticated` mag
  hem uitvoeren.
- **`lib/tickets.ts`** (nieuw): statuslabels en -volgorde op één plek (de ticketpagina, het
  klantdossier en Berichten lezen ze daar; `format.ts` leent er zijn prioriteitslabel van),
  `ticketLastActivity`, `groupNotesByTicket`, `noteAuthorShort` en `ticketConversation` (hoe
  een ticket een regel in de gesprekkenlijst wordt).
- **`lib/communication.ts`:** één gesprekstype voor mail én tickets (`Conversation`),
  `filterConversations` (tabblad, soort, klant, periode, zoekwoorden, servertreffers),
  `periodRange`, `searchSnippet`, `sortConversations`. Bewust zonder runtime-imports, zodat
  `node --test` ze draait. **26 tests** in `lib/communication.test.ts` (`npm test`).
- **`components/TicketTimeline.tsx`:** de tickettijdlijn uit `main.tsx` gelicht, zonder
  gedragswijziging; het bewerkvenster en Berichten gebruiken dezelfde component.
- **`DetailTabs`** kent nu een `dot` (stip naast de teller).
- **Repository:** `searchClientEmails` (rpc, valt stil terug op `[]` als de functie ontbreekt)
  en `loadClientEmailThreadOverviewByIds`.
- **Mobiele lay-outtest:** de seed heeft nu een `ticket_unread`-rij, zodat de "Nieuw"-markering
  in Berichten en de stip op het tabblad Tickets gemeten worden.

## Wat níét verandert

De ticketpagina, het bewerkvenster van een ticket en het tabblad Communicatie in het
klantdossier doen precies wat ze deden. De opvangbak (Niet gekoppeld) is onaangeroerd.
