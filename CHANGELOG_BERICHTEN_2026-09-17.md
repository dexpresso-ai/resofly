# Changelog — Berichten: alle klantcommunicatie op één pagina — 2026-09-17

Klantmail leefde op twee plekken die je allebei moest afgaan: per klant onder het tabblad
**Communicatie**, en de post die nog niet aan een klant hing als tabblad **Niet gekoppeld** op
de klantenlijst. Wie 's ochtends wilde weten "is er nieuwe post?" klikte dus klant voor klant
door. Er is nu één pagina die dat beantwoordt.

## 1 · Menu Communicatie → Berichten

- **Nieuwe menuregel "Berichten"** bovenaan de groep Communicatie (naast Chat en Marketing).
  Eén klik en je ziet álle klantgesprekken van de organisatie, nieuwste bovenaan.
- **De badge verhuist mee.** Het aantal ongelezen klantberichten stond op de menuregel
  *Klanten*; het staat nu op *Berichten*, opgeteld bij het aantal berichten dat nog niet
  aan een klant gekoppeld is. De tooltip houdt de twee uit elkaar. In de klantenlijst en op
  de klantkaart blijven de "x nieuw"-markeringen per klant gewoon staan.
- **Rechten:** Berichten valt onder de module *Klanten*, want het leest dezelfde tabellen
  (en dus dezelfde RLS) als het klantdossier. Wie Klanten niet mag zien, ziet Berichten ook
  niet.

## 2 · De pagina

Drie tabbladen boven een tweekoloms-weergave (gesprekken links, het gekozen gesprek rechts):

- **Alle gesprekken** — elke conversatie met een klant, met klantnaam, onderwerp, de
  laatste regel ("Joost: Dank voor de offerte…" of "Jij: Zullen we donderdag…"), het
  tijdstip zoals een postvak dat toont (vandaag de tijd, gisteren, ma, 3 sep) en een
  teller voor ongelezen post. Zoeken op klant, onderwerp, afzender of tekst; filteren op
  klant (alleen klanten die daadwerkelijk een gesprek hebben).
- **Ongelezen** — alleen de gesprekken waar nog iets nieuws in ligt. "Alles gelezen" als
  de lijst leeg is.
- **Niet gekoppeld** — de opvangbak: post die op het doorstuuradres binnenkwam maar niet
  vanzelf bij een klant te plaatsen was. Koppelen (met de voorgestelde klant al ingevuld
  als die er is), negeren, altijd negeren en "onthoud dit adres" — precies dezelfde code
  als het tabblad op de klantenlijst, dat óók blijft bestaan.

In het gesprek:

- **Openen = lezen.** Zoals in het klantdossier: de ongelezen berichten van het gesprek
  worden voor jou als gelezen gemarkeerd (per persoon; collega's houden hun eigen teller).
  De markering in beeld blijft staan tot je het gesprek verlaat, zodat je nog ziet wát er
  nieuw was.
- **Beantwoorden** opent een antwoordformulier met "Re: " voor het onderwerp (één keer,
  geen "Re: Re: Re:"). Het antwoord hangt in **hetzelfde gesprek** — de mailfunctie
  accepteert daarvoor een `threadId` en controleert server-side dat het gesprek van
  dezelfde organisatie én dezelfde klant is. Zonder `threadId` (het klantdossier) begint
  een mail zoals altijd een nieuw gesprek.
- **Nieuw bericht** aan een klant naar keuze: hetzelfde formulier als in het klantdossier,
  met de klant als extra veld. Na versturen springt de lijst naar het nieuwe gesprek.
- **Naar het klantdossier** met één klik op de klantchip in de gesprekskop.
- Een bericht dat niet aankwam (gebounced, mislukt, spam-klacht) krijgt een
  waarschuwingsdriehoek in de lijst.

## 3 · Nieuwe post die nog nergens hoort

Dit is de reden achter het verzoek: post die nog niet aan een klant gekoppeld is, hoort bij
de rest van de communicatie in beeld te komen — niet als tabblad dat je alleen ziet als je
toevallig op de klantenlijst staat.

- **Live teller.** `inbound_messages` zit nu in de realtime-publicatie. Komt er post in de
  opvangbak, dan loopt de badge op Berichten meteen op en herlaadt de gesprekkenlijst als
  hij openstaat. De server blijft de waarheid: elk event telt opnieuw, het event zelf wordt
  niet geloofd. RLS geldt per abonnee (module Klanten), net als bij `client_emails`.
- **Melding "Nieuw bericht — nog niet gekoppeld"** met afzender en onderwerp, naast de
  bestaande melding voor een antwoord in een klantdossier. Beide meldingen openen nu de
  pagina Berichten: de eerste op het tabblad Niet gekoppeld, de tweede met het gesprek
  open.
- **De beslislijst** (kaart "Mail in de opvangbak met een voorgestelde klant") opent bij
  *Openen* ook de pagina Berichten op het tabblad Niet gekoppeld, in plaats van de
  klantenlijst.
- Een mail wordt eerst onvoorwaardelijk vastgelegd (status `unmatched`) en in dezelfde
  transactie afgehandeld. Pas de UPDATE zegt of er echt iets in de opvangbak ligt; alleen
  dán (status unmatched, mét reden, niet afgehandeld, categorie persoonlijk) komt er een
  melding.

## 4 · Telefoon

Zelfde patroon als de teamchat: de gesprekkenlijst vult het scherm, je tikt een gesprek aan
en dát vult het scherm — kop en tabbladen gaan weg, de terugpijl brengt je terug. De pagina
loopt van de werktabs tot de onderbalk; alleen de lijst of het gesprek scrolt. Duimformaat
voor gespreksregels (64 px) en het zoekveld (15 px tekst, geen iOS-inzoom).

## 5 · Onder de motorkap

- **Migratie `20260917030000_communication_hub.sql`:**
  - view `client_email_thread_overview` (security_invoker): één regel per gesprek met
    klantnaam, aantal berichten, laatste bericht (afzender, preview van 200 tekens) en de
    ongelezen-teller van de huidige gebruiker. De preview wordt uit een afgekapt stuk
    tekst gehaald, zodat een gesprek met een mail van 128 KB de lijst niet vertraagt.
    `deleted_at` wordt ook in de view gefilterd, voor het geval de service-role hem ooit
    leest.
  - `inbound_messages` in `supabase_realtime`.
- **Gedeelde componenten uit `Clients.tsx` gelicht,** zonder gedragswijziging:
  `components/ClientEmailMessage.tsx` (de berichtkaart, statuslabels, herkomstlabel) en
  `components/InboundInbox.tsx` (de opvangbak). Klantdossier en Berichten gebruiken
  dezelfde code, dus een bericht ziet er overal hetzelfde uit en "Verwijderen" doet overal
  hetzelfde.
- **`lib/communication.ts`** met de pure regels (filteren, zoeken zonder accenten,
  "Re: "-onderwerp, voorletters, previewregel, lijsttijd) en **`lib/communication.test.ts`**
  (12 tests, `npm test`).
- **`useClientEmailUnread`** telt nu ook de opvangbak en geeft een `activity`-teller
  terug die bij elk live-event oploopt; de pagina Berichten laadt dan opnieuw zonder een
  tweede abonnement.
- **Mobiele lay-outtest:** pagina `communication` toegevoegd (eerste gesprek ≤ 300 px), met
  seed-data voor gesprekken, ongelezen post en twee niet-gekoppelde berichten. De mock
  geeft nu `Access-Control-Expose-Headers: content-range` mee: zonder die header zag de
  browser de teller van `count: 'exact', head: true` niet en leek de opvangbak in de test
  altijd leeg. Daardoor staat op de klantenlijst nu ook de (bestaande) tabstrook
  "Niet gekoppeld" in beeld; de grenzen van `clients` en `clients-table` zijn met de
  hoogte van die strook verhoogd (gemeten 274 en 303 px).

## 6 · Als de migratie nog niet gedraaid is

Cloudflare Pages rolt de frontend uit op een push; de migratie gaat langs de Supabase-deploy.
In dat gaatje bestaat `client_email_thread_overview` nog niet, en dan zou de pagina een rode
PostgREST-fout tonen ("Could not find the table … in the schema cache") terwijl er niets mis
is. Zelfde aanpak als bij het AI-paneel (16 september):

- `isMissingRelation()` staat nu één keer in `lib/postgrestErrors.ts`, met vier tests. De
  kopie die in `mcp-api.ts` stond is vervangen door die ene; `McpNotAvailableError` doet
  verder precies wat het deed.
- De gesprekkenlijst gooit `NotMigratedError` in plaats van de ruwe fout, en de pagina toont
  dan één rustige regel: *Nog niet beschikbaar in deze omgeving*, met de verwijzing naar het
  klantdossier. Hij verdwijnt vanzelf zodra de migratie gedraaid is.
- Het tabblad **Niet gekoppeld** blijft in dat geval gewoon werken: dat leest
  `inbound_messages`, en die tabel bestaat al sinds augustus.
- De opvangbak luistert op een **eigen realtime-kanaal**. Een kanaal met twee bindingen valt
  in zijn geheel om als er één niet deugt; door ze te splitsen kan een omgeving waar
  `inbound_messages` nog niet in de publicatie zit de bestaande melding voor klantmail niet
  meeslepen.

## Wat níét verandert

Het tabblad **Communicatie** in het klantdossier — mail opstellen, gesprekken openklappen,
lezen, verwijderen — is onaangeroerd. Het tabblad **Niet gekoppeld** op de klantenlijst
blijft ook bestaan; het toont dezelfde opvangbak.
