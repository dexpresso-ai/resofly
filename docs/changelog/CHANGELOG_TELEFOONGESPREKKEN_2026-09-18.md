# Changelog — Telefoongesprekken loggen, opnemen en samenvatten — 2026-09-18

Mail en tickets staan sinds 17 september samen op Berichten. Een telefoongesprek — vaak het
belangrijkste klantcontact van de dag — stond nergens: het verdween in iemands hoofd of in een
losse notitie. Vanaf nu is een gesprek net zo goed een gesprek als een mailwisseling of een
ticket: het staat in de lijst, in het klantdossier, en het kan opgenomen en samengevat worden
met precies dezelfde keten die de agenda al voor meetings gebruikt.

## 1 · Een gesprek loggen

- **"Gesprek loggen"** staat op **Berichten** naast *Nieuw bericht*, en in het klantdossier
  onder tabblad **Communicatie**. Het venster vraagt richting (inkomend/uitgaand), nummer, met
  wie je sprak, afloop, wanneer, hoe lang, waar het over ging en een aantekening. Klant,
  contactpersoon, project en ticket zijn optioneel — een gesprek met een onbekend nummer mag
  bestaan en later alsnog gekoppeld worden.
- **Het nummer herkent zichzelf.** Tijdens het typen zoekt de app het op in klanten,
  contactpersonen en leveranciers: eerst in wat al geladen is (meteen, zonder netwerk), daarna
  bij de database, die ook kent wat de app niet geladen heeft. Eén treffer wordt vanzelf
  ingevuld. **Meerdere treffers worden een keuze, nooit een gok** — één kantoornummer hoort
  vaak bij de klant én bij drie contactpersonen.
- **De timer loopt mee** als je vanuit het venster belt, zodat de gespreksduur klopt zonder
  dat je op de klok hoeft te kijken.

## 2 · Klik-om-te-bellen, en wat dat wél en niet is

Het telefoonnummer in het klantdossier is een **belknop**. Tik erop, en de app onthoudt dat je
belde; kom je terug, dan staat er onderin: *"Gebeld met Joost Vermeer — gesprek loggen?"*, met
een voorstel voor de duur al ingevuld.

**Dat voorstel is een bovengrens, geen meting**, en het venster zegt dat er ook bij. Een webapp
kan het gesprekslog van een telefoon niet uitlezen — dat staat geen enkel besturingssysteem toe,
ook een native app niet. Wat de app wél weet: dat je op bellen tikte, en hoe lang je weg was.
Bel je vier minuten en kijk je daarna zes minuten op WhatsApp, dan staat er tien minuten. Pas
hem aan; dat is de bedoeling.

**Inkomende gesprekken ziet de browser helemaal niet.** Die log je met de hand. Automatisch
loggen vraagt een koppeling met de telefooncentrale; het datamodel ligt er al klaar voor
(`source = 'pbx'`, `provider`, `provider_call_id`, `dedup_key`), maar die koppeling is nog niet
gebouwd. Zie `TELEFOONGESPREKKEN_LOGGEN_ONDERZOEK_2026-09-18.md`.

## 3 · Opnemen en samenvatten — dezelfde keten als bij een meeting

Onder elk gesprek staat **dezelfde recorder** als in het agenda-detailpaneel. Zet het gesprek op
de luidspreker, neem op, en ResoFly maakt er een transcript (ElevenLabs Scribe) en een
samenvatting (Claude) van — met sprekerlabels, een bewerkbaar transcript, en "samenvatting
mailen" naar de contactpersoon.

Er is **niets aan die pijplijn veranderd**. `meeting_recordings` heeft er één kolom bij
(`call_id`), en de edge-functie kiest de modulepoort op basis van waar de opname bij hoort:
een gespreksopname valt onder **Klanten**, een afspraakopname onder **Agenda**. De
AVG-laag (verplichte toestemming, `consent_given`/`consent_at`, verwijderen wist ook de audio)
geldt onverkort.

## 4 · Waar gesprekken verschijnen

- **Berichten** — tussen de mail en de tickets, op laatste activiteit. Een gespreksregel is
  herkenbaar aan het label *Telefoon* met een pijl in de belrichting. Waar een ticket zijn
  status toont, toont een gesprek zijn **afloop**: *Gemist*, *Voicemail*, *In gesprek* — of, als
  er gewoon gesproken is, de **gespreksduur**, want dát is de informatie.
  Een gesprek heeft geen ongelezen-teller: je hebt het zelf gevoerd.
- **Het soortfilter** kent nu *Alleen telefoon*.
- **Eén klant gekozen** → de lijst splitst in vensters met elk hun eigen scrollgebied:
  E-mail, Tickets en **Telefoon**. De ticketkolom verschijnt alleen als die module openstaat.
- **Een gesprek openen** toont de feiten in de kop (met wie, welke kant op, hoe lang, wanneer,
  welk nummer), de aantekening, en de recorder met opname, transcript en samenvatting.
  *Terugbellen* belt met één tik terug.
- **Klantdossier → Communicatie** — een paneel **Telefoongesprekken** onder de mail, nieuwste
  bovenaan. Openen = het logvenster.
- **Sorteren op het moment van het gesprek**, niet op het moment van loggen: een gesprek van
  gisteren dat je vanochtend invult, staat op zijn eigen plek in de tijd.

## 5 · Onder de motorkap

**Migratie `20260918020000_client_calls.sql`**

- **`normalize_phone_e164(tekst, land)`** — nummerherkenning. `'06-12345678'`,
  `'+31 6 12345678'`, `'0031 6 12345678'` en `'+31 (0)6 12345678'` komen allemaal uit op
  `'+31612345678'`. Afgeschermde nummers (`anonymous`, `onbekend`, …) geven `null` en leiden
  dus nooit tot een match.
  **Het bestaande `normalize_client_phone_value()` is met opzet níét aangepast**: dat gooit alle
  niet-cijfers weg (prima voor de klant-deduplicatie waarvoor het in mei gebouwd is, onbruikbaar
  voor herkenning), en het zit in het predicaat van `idx_clients_org_phone_lookup` én in de
  dedupe-trigger op `clients`. Herschrijven zou die index stilzwijgend ongeldig maken. De nieuwe
  functie staat ernaast, met eigen indexen op `clients`, `client_contacts` en `suppliers` —
  waarin het landnummer expliciet staat, zodat de index-expressie letterlijk overeenkomt met de
  zoekopdracht en niet op een default-waarde leunt.
- **`client_calls`** — in het spoor van `client_emails`: richting, afloop, tijdstippen, duur,
  onderwerp, aantekening, koppelingen (klant, contactpersoon, leverancier, project, ticket),
  herkomst, en de kolommen die een latere centrale-koppeling nodig heeft. Een trigger leidt de
  duur af uit begin/eind (en andersom), zet de duur op nul bij een gesprek dat niet gevoerd is,
  normaliseert het nummer, en weigert een contactpersoon die niet bij de gekozen klant hoort.
  Org-integriteit op elke koppeling, RLS als bij `client_contacts`, plus de modulepoort
  **Klanten**. Realtime, zodat een gesprek dat een collega logt meteen in jouw lijst staat.
- **`find_contacts_by_phone(org, nummer)`** — `security invoker`, dus de bestaande RLS geldt:
  je krijgt alleen treffers uit je eigen organisatie, en alleen uit modules die voor jou
  openstaan (leveranciers vallen onder Financiën; staat die dicht, dan blijven ze vanzelf weg).
  Geeft **alle** treffers terug.
- **`meeting_recordings.call_id`** — zie §3.

**Frontend**

- **`lib/calls.ts`** (nieuw, puur) — nummer normaliseren en tonen (Nederlandse nummers krijgen
  hun vertrouwde vorm terug: `06 12 34 56 78`, `010 123 45 67`, `085 123 4567`), labels,
  gespreksduur, `callSubject`/`callPreview`/`callConversation`, en `matchPhoneLocally`.
  Bewust zonder runtime-imports, zodat `node --test` ze draait.
- **`lib/calls.test.ts`** — **25 tests**, zwaartepunt op de normalisatie: een fout daarin werkt
  stil door (je ziet geen foutmelding, je ziet alleen geen match). Twee echte bugs zijn er
  tijdens het schrijven mee gevonden: `+31 (0)20` liep mis op de trunk-0, en `085` werd
  verkeerd gegroepeerd.
- **`lib/callBridge.ts`** (nieuw) — onthoudt een tik op een telefoonlink en merkt de terugkeer
  op (`visibilitychange` + `focus`). Werkt zonder `localStorage` gewoon niet mee in plaats van
  om te vallen.
- **`components/CallLogDialog.tsx`** (nieuw) — het logvenster, plus de terugkeerbalk.
- **`lib/communication.ts`** — `ConversationKind` kent `'call'`, `splitConversations` geeft drie
  groepen.
- **`Communication.tsx`** — gesprekken in de lijst, het soortfilter, de derde kolom, `CallPane`.
- **`Clients.tsx`** — het paneel Telefoongesprekken en de belknop op het nummer.
- **`main.tsx`** — de terugkeerbalk hangt in de app-shell, want je komt terug op de pagina waar
  je wás, niet per se waar je op bellen tikte.
- **Mobiele lay-outtest** — de seed heeft twee gesprekken (één gevoerd en gekoppeld, één gemist
  van een onbekend nummer), zodat de gespreksregel en de afloop-pil gemeten worden.

## Verificatie

- `npm test` — **317 tests, 0 fouten**.
- `npm run typecheck` ✓ en `npm run build` ✓.
- `npm run test:mobile` — **80 pagina's, 0 met problemen**.
- Edge-functies draaien niet mee in de lokale typecheck (bekende beperking): ná deploy een
  boot-health-check doen op `meeting-transcribe`.

## Wat níét verandert

De agenda, de meeting-recorder en de notulen-pijplijn doen precies wat ze deden. Mail, tickets
en de opvangbak zijn onaangeroerd. Er is geen koppeling met een telefooncentrale: inkomende
gesprekken log je met de hand.
