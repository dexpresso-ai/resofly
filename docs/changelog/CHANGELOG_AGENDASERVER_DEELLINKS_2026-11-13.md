# Agendaserver aan, en een agenda delen met wie geen ResoFly heeft (2026-11-13)

## Aanleiding

"Hoe kan ik, als ik een eigen mailadres heb, daar een eigen agenda van maken
die ik in ResoFly kan zetten, maar vanuit daar die agenda ook kan delen?" En
daarna: "Kunnen we met ResoFly geen eigen server voor agenda maken?"

Die server stond er al half: `workers/caldav` draaide sinds 10 november op
staging, maar niemand kon erbij en er was geen manier om een agenda te delen
met iemand buiten ResoFly.

## Wat er misging

1. **Het adres in de app bestond niet.** Instellingen → Agenda noemde
   `caldav.resofly.com`. Dat adres had geen DNS en geen route naar de Worker;
   het kwam uit bij de klantadressen. Een iPhone zei alleen "Kan account niet
   verifiëren". Eronder stond "De CalDAV-server wordt in een volgende stap
   geactiveerd". Op staging waren nul app-wachtwoorden gemaakt.
2. **De Worker ging niet mee met de uitrol.** Hij stond er met de hand neer;
   een wijziging in de code kwam niet vanzelf online.
3. **De herinnering werd de omschrijving.** De parser las de regels van een
   herinnering (VALARM) als die van de afspraak. Een afspraak van de iPhone
   zonder omschrijving kreeg zo "Herinnering" als omschrijving in ResoFly.
4. **Een op de telefoon weggehaalde keer kwam terug.** Haalde je één keer uit
   een reeks op de iPhone, en bewerkte iemand de afspraak daarna in ResoFly,
   dan maakte de server de afspraak opnieuw zonder EXDATE. De keer stond weer
   op de telefoon.
5. **Meer dan 1000 afspraken: de rest ontbrak.** Supabase geeft per verzoek
   hooguit 1000 rijen. Een volle agenda miste de rest op de telefoon, zonder
   melding.
6. **Een multiget ging per afspraak naar de database.** Na het koppelen vraagt
   een iPhone alles tegelijk op; bij een volle agenda liep de Worker tegen zijn
   grens van verzoeken.
7. **Verwijderen zei altijd "gelukt".** Weigerde de database, dan gaf de server
   toch 204. De telefoon dacht dat de afspraak weg was; bij de volgende
   synchronisatie kwam hij terug.
8. **Kleinere dingen**: een parameter tussen aanhalingstekens
   (`ALTREP="https://…"`) knipte de regel door; lange regels werden per teken
   gevouwen in plaats van per byte (een titel met accenten of een emoji gaf te
   lange regels); een mailadres met een é kwam verminkt binnen bij het
   inloggen; elke GET gaf een ander tijdstempel, dus nooit dezelfde tekst; een
   PUT mocht elke omvang hebben.

## Wat er nu kan

**Agenda op je telefoon of computer** (Instellingen → Agenda): de server staat
op `https://caldav-staging.resofly.com`. Maak een app-wachtwoord, en volg de
stappen voor iPhone/iPad, Mac, Android (DAVx⁵) of Thunderbird. Afspraken gaan
twee kanten op. Je ziet je eigen ResoFly-agenda's en wat collega's met het team
delen.

**Delen buiten ResoFly**: bij elke eigen ResoFly-agenda een knop. Je maakt een
link voor iemand ("partner", "assistent") en kiest wat die ziet:

- **Alleen bezet**: de tijden, zonder titel;
- **Titel, tijd en plaats**: zonder omschrijving, genodigden of vergaderlink.

Die persoon zet de link in Google Agenda, Outlook of Apple Agenda en ziet de
agenda daar mee. Je ziet de link één keer; bij de agenda staat "Buiten ResoFly
via 2 links", en je trekt elke link los in.

Op de vraag zelf: een eigen agenda "van je mailadres" maak je zo in ResoFly.
Je logt op de telefoon in met het mailadres waarmee je in ResoFly inlogt; voor
wie geen ResoFly heeft, is er de deellink.

## Beveiliging

- In de database staat alleen de SHA-256 van een deellink (256 bits toeval).
  De tabel heeft RLS zonder policies en geen rechten voor de app; hij staat
  toch achter de module Agenda (`apply_module_gate`).
- `calendar_feed_lookup()` geeft niets terug zodra de link is ingetrokken, de
  maker geen actief lid meer is of de Agenda niet meer mag zien, of de agenda
  niet meer van hem is. Wie vertrekt, verliest zijn links en app-wachtwoorden
  voorgoed (een trigger, zoals bij de app-wachtwoorden).
- Alleen een eigen ResoFly-agenda, met schrijfrecht op de Agenda. Intrekken kan
  ook met alleen leesrecht. Een trigger in de database weigert een link op een
  agenda van een ander of van een andere organisatie.
- Uit een afspraak van de telefoon gaan alleen de tijden mee (en bij "titel,
  tijd en plaats" die twee). Een afspraak die op de telefoon als privé is
  gemarkeerd, blijft "Bezet".
- De Worker filtert elke afspraak-query ook zelf op `organization_id`.
- `caldav-staging` staat op de lijst met gereserveerde klantnamen.
- De deellink geeft `X-Robots-Tag: noindex`, en `/robots.txt` sluit alles uit.

## Bekend, niet in deze wijziging

De zomertijd en de robots.txt zijn later op 13 november opgelost: zie
`CHANGELOG_AGENDA_ZOMERTIJD_2026-11-13.md`.

- **Herhalende afspraken rond de zomertijd.** ResoFly rekent een reeks die in
  de app is gemaakt in UTC door (`advanceRecurrence`): "elke maandag 9.00 uur"
  uit november staat in de zomer om 10.00 uur, in de app en dus ook op de
  telefoon en in de deellink. Een reeks die op de telefoon is gemaakt, heeft de
  tijdzone wel en klopt overal behalve in de app zelf. Dat herstel hoort in de
  app, apart.
- Productie heeft nog geen agendaserver; de app zegt dat daar ook zo.
- Google Agenda haalt een deellink een paar keer per dag op, op zijn eigen
  tempo. Dat kunnen wij niet sneller maken.
- **robots.txt**: Cloudflare zet voor de hele zone `resofly.com` een eigen
  robots.txt vóór die van de Worker, met `User-agent: *` en `Allow: /`. Onze
  `Disallow: /` staat er dus onder en telt bij zoekmachines waarschijnlijk niet.
  De deellinks zelf geven `X-Robots-Tag: noindex` en hun adres is geheim; wie de
  robots.txt strenger wil, zet in Cloudflare de beheerde robots.txt voor de
  zone uit (dat raakt alle adressen op resofly.com).

## Na de uitrol

- De migratie en `calendar-integrations` gaan mee met *Deploy Supabase
  (staging)*.
- De Worker gaat mee met de nieuwe workflow *Deploy agendaserver (staging)*.
  Die heeft in GitHub `CLOUDFLARE_API_TOKEN` en `CLOUDFLARE_ACCOUNT_ID` nodig;
  zonder faalt hij met die melding. Deze keer is de Worker met de hand
  uitgerold.
- DNS: `caldav-staging AAAA 100::` (proxied) in de zone `resofly.com`.
- Geen nieuwe secrets op Supabase of Pages: `VITE_APP_ENV=staging` stond er al.
- Live gecontroleerd op 13 november, na de uitrol: `OPTIONS /` 204 met
  `DAV: 1, 2, 3, calendar-access`; `PROPFIND /.well-known/caldav` zonder inlog
  401 met `Basic realm`; een verzonnen deellink 404 met de Nederlandse melding
  (de Worker bereikt de database en `calendar_feed_lookup` bestaat). Op staging
  staan de tabel, de lookup en de gereserveerde naam (gelezen via de
  Management API).

## Getest

- `npm run typecheck`: schoon. De Worker apart (`tsc` in `workers/caldav`): schoon.
- `npm test`: alle tests geslaagd. Nieuw: `workers/caldav/src/logic.test.ts`
  (19: de herinnering, EXDATE, wat een deellink wel en niet toont, privé,
  vouwen per byte, de vorm en hash van het token gelijk aan de app) en
  `src/lib/caldavSetup.test.ts`.
- `deno check` op `calendar-integrations` en `_shared/calendarFeed.ts`: schoon
  (met een import map naar npm; deno.land en esm.sh zijn vanuit de cloudsessie
  niet bereikbaar).
- De migratie twee keer achter elkaar op de lokale database: veilig opnieuw.
  `accountant_fence_gaps()`: leeg.
- `npm run test:stromen -- caldav`: 28 stappen, 0 fout (nieuw scenario).
  `agenda boekingslinks klantdomein videovergadering`: 220 stappen, 0 fout.
- Een echte CalDAV-client (python-caldav 3.7) tegen de Worker: agenda's
  vinden, een wekelijkse afspraak maken (4 keer uitgevouwen), alleen de
  wijzigingen ophalen, wijzigen, verwijderen. De deellink leest in
  `icalendar` als geldige agenda, zonder omschrijvingen.
- `npm run test:mobile -- --theme=both`: 620 metingen, 0 problemen, met het
  nieuwe scenario `settings-agenda-delen` (het venster met een net gemaakte
  link). Op de tabletbreedte liepen de knoppen bij een ResoFly-agenda eerst over
  twee regels en door de kolom van de stip; nu staan ze samen op één regel.
- `npm run test:loading`: alle controles geslaagd.
