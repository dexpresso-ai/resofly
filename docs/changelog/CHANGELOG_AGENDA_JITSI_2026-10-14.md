# Agenda — videovergaderen met Jitsi Meet, zonder Google of Microsoft (2026-10-14)

## Aanleiding

"Kan ik Jitsi-videosessies ook aan mijn agenda toevoegen? Dat ik niet
afhankelijk ben van Google Meet, maar zelf mijn videocalls kan beheren."

Tot nu toe kon een afspraak alleen automatisch een videovergadering krijgen via
de provider van de agenda: Google Meet op een Google-agenda, Teams op een
Microsoft-agenda, en op de eigen ResoFly-agenda niets — daar kon je alleen een
link plakken. De teamchat had sinds gisteren wel een Jitsi-knop, de agenda niet.

Jitsi Meet is open source en een vergadering is gewoon een link naar een eigen
kamer: geen API, geen koppeling, geen account voor de gasten. Daarom werkt het
op élke agenda, en kun je het op je eigen server draaien.

## Wat er is veranderd

### Bij een afspraak (nieuw en bewerken)
- Het blok **Videovergadering** heeft nu vier keuzes: **Geen · Jitsi Meet ·
  Google Meet/Teams · Eigen link**. Google Meet/Teams staat er alleen bij een
  Google- of Microsoft-agenda.
- **Jitsi Meet** maakt meteen een onraadbare kamer (`ResoFly-` + 14 tekens, ruim
  80 bits; geen titel of klantnaam in de link). Je ziet de link, kunt hem
  kopiëren of openen, of met ↻ een nieuwe kamer maken. Wie even iets anders
  kiest en terugschakelt, houdt dezelfde kamer — genodigden hebben die
  misschien al.
- Opgeslagen gaat de Jitsi-link als gewone videocall-link: op de ResoFly-agenda
  in `calendar_events.meeting_url` (en in de uitnodigingsmail + `.ics`), op
  Google/Microsoft als regel `🎥 Videocall: …` in de omschrijving.
- De knop **Deelnemen · Jitsi Meet** in het afspraakpaneel herkent Jitsi-links
  (meet.jit.si, 8x8.vc, de eigen server, en elke kamer die ResoFly maakte).

### Boekingslinks
- Nieuwe keuze **Videovergadering bij een boeking**: *Jitsi Meet — per boeking
  een eigen vergaderruimte*, *Google Meet/Teams van je agenda*, of *Geen*. Op de
  boekingenpagina én bij "Doorsturen naar klant" in de agenda.
- Met Jitsi krijgt elke geboekte afspraak zijn eigen kamer, op elke agenda —
  ook de eigen ResoFly-agenda, waar een boeking tot nu toe nooit een videolink
  kreeg. De klant ziet de link in de bevestiging en de uitnodiging.
- Standaard voor een nieuwe link: Meet/Teams op een Google-/Microsoft-agenda
  (zoals het was), Jitsi op een ResoFly-agenda. Bestaande links veranderen niet.
- Een vaste videocall-link gaat nog steeds vóór.

### Eigen Jitsi-server (Instellingen → Agenda)
- Nieuwe kaart **Videovergaderen met Jitsi Meet**. Leeg = de gratis openbare
  server meet.jit.si. Wie zelf een Jitsi-server draait, vult hier het adres in;
  alle nieuwe links gaan dan daarheen: agenda, boekingslinks, Gerrie en de
  teamchat. Met een knop om meteen een testvergadering te openen.
- De server moet gasten met alleen de link binnenlaten. **JaaS van 8x8 werkt
  daarom niet**: die vraagt per deelnemer een ondertekend token (JWT), en dat
  maakt ResoFly niet. (Links naar 8x8.vc worden wel herkend als Jitsi.)
- Alleen owners en admins kunnen het wijzigen (de bestaande policy op
  `company_settings`); teamleden zien welke server er gebruikt wordt.
- Alleen https, geen query/#/inloggegevens, hooguit één padstuk (een tenant of
  submap). De app normaliseert (`meet.example.nl` → `https://meet.example.nl`),
  de database controleert hetzelfde.

### Gerrie en gekoppelde AI (MCP / API)
- `propose_calendar_event` kreeg `video_call`: "plan morgen een videocall met
  Jan" geeft een voorstel mét Jitsi-link (de link staat al op de kaart).
- `calendar_event.set_meeting_url` kreeg `jitsi: true` (nieuwe Jitsi-kamer op
  een ResoFly-afspraak); een afspraak die al een Jitsi-link heeft, krijgt geen
  nieuwe — de genodigden hebben de oude.
- `booking_link.create` / `booking_link.update` kregen `conference_provider`
  (`jitsi` of `calendar`). Bij `update` zet een videodienst kiezen de
  automatische videovergadering ook aan, tenzij `auto_conference` er zelf bij
  staat.

### Teamchat
- "Nu vergaderen / Nu bellen" gebruikt de eigen Jitsi-server als die is
  ingesteld. De zin over even inloggen staat er alleen nog bij meet.jit.si.

## Ook verbeterd onderweg

- **Microsoft-agenda: de videocall-regel staat nu bovenaan de omschrijving.**
  Graph geeft bij het ophalen alleen de eerste 255 tekens (`bodyPreview`);
  onderaan viel een geplakte link bij een langere omschrijving weg, of half
  (een afgekapte, kapotte link). Oudere items met de regel onderaan worden nog
  gewoon gelezen. Google houdt de regel onderaan: daar komt de hele
  omschrijving terug.
- **Omzetten van Meet/Teams naar Jitsi toont de Jitsi-knop.** Tot nu toe won de
  native conferentie altijd van de eigen regel. Nu wint de eigen regel als hij
  naar een andere dienst wijst; wijst hij naar dezelfde (de Meet/Teams-link die
  bij bewerken in ResoFly wordt meegeschreven, bij Teams soms afgekapt), dan
  geldt de conferentie zoals voorheen.
- De link-hulpjes van de server staan in een eigen, pure module
  (`_shared/meetingLinks.ts`) met tests; `calendarCore.ts` exporteert ze door,
  dus bestaande imports werken.

## Bestanden

- `supabase/migrations/20261014000000_jitsi_video_meetings.sql` —
  `company_settings.jitsi_base_url` (+ check) en
  `meeting_booking_links.conference_provider` (`calendar`/`jitsi`, standaard
  `calendar`).
- `supabase/functions/_shared/jitsi.ts` (+ test) — serveradres normaliseren,
  kamernaam, link, Jitsi herkennen. Zelfde regels als `src/lib/meeting.ts`; de
  test vergelijkt de twee én speelt de databasecontrole na.
- `supabase/functions/_shared/meetingLinks.ts` (+ test) — de videocall-regel in
  de omschrijving (boven/onder), welke link geldt, Google conferenceData.
- `supabase/functions/_shared/calendarCore.ts`, `calendarEventWrite.ts` —
  doorexporteren, regel bovenaan bij Microsoft, meet.jit.si/8x8.vc als bekende
  host.
- `supabase/functions/meeting-booking{,-public}/index.ts` — `conferenceProvider`
  opslaan; per geboekt blok een Jitsi-link maken.
- `supabase/functions/_shared/actions/calendar.ts`, `_shared/gerrieCore.ts` —
  zie Gerrie hierboven.
- `src/lib/meeting.ts` (+ test) — Jitsi herkennen, links maken, de videokeuze
  van een boekingslink.
- `src/features/CalendarPage.tsx` — `MeetingFields` (vier keuzes),
  `VideoMeetingCard` (Instellingen → Agenda), boekingsdialoog.
- `src/components/BookingVideoSelect.tsx`, `src/features/MeetingBookingManager.tsx`
  — de keuzelijst bij boekingslinks.
- `src/lib/repository.ts` — `saveJitsiServer` (alleen dit veld; los van het
  formulier met bedrijfsgegevens).
- `src/components/teamchat/*`, `src/main.tsx` — teamchat op de eigen server.
- `src/lib/gerrie-api.ts`, `gerrie-proposals.ts`, `GerrieChat.tsx`,
  `src/lib/actions/calendar.ts`, `meetingBookingApi.ts`, `types.ts`,
  `styles/globals.css`.

## Getest

- `npm run typecheck` en `npm test` (756 tests, waarvan 19 nieuw) — schoon.
- `deno check` op alle 34 edge functions uit de CI-lijst — schoon. (Lokaal via
  een import map naar npm, omdat de proxy hier esm.sh en deno.land niet doorlaat.)
- De migratie gedraaid op een lege Postgres 16: twee keer achter elkaar
  (idempotent), bestaande boekingslinks krijgen `calendar`, geldige adressen
  (`https://meet.example.nl`, met poort, met één padstuk, punycode) gaan erin, en
  `http://…`, een slash of tweede padstuk, `?x`, hoofdletters en
  `javascript:` worden geweigerd.
- Met Playwright tegen de nagebootste backend (`tests/mobile/mock`), desktop en
  telefoon: Jitsi kiezen maakt een link, "Eigen link" herkent Zoom, "Geen" wist;
  een bestaande Jitsi-afspraak toont "Deelnemen · Jitsi Meet", Opslaan blijft
  uit tot er iets verandert, en terugschakelen geeft dezelfde kamer; bij een
  Google-agenda staan er vier keuzes; Instellingen → Agenda weigert `http://` en
  laat een geldig adres opslaan; de boekingslink toont de nieuwe keuzelijst.
  Geen JavaScript-fouten, geen horizontale overloop op de telefoon.
- `npm run test:mobile -- --theme=both` — 276 pagina's gemeten, 0 met
  problemen; na de laatste wijziging nog eens agenda, afspraak, taak,
  instellingen, boekingen, teamchat en publieke boekingspagina (42, 0).
- `npm run build` en `scripts/check-csp-hash.mjs` — schoon.

## Uitrollen

- Migratie + edge functions: gaan mee met de push naar `staging` (workflow
  *Deploy Supabase (staging)*, of `SUPABASE_STAGING_LAPTOP.md`): eerst de
  migratie, dan de functies. Die volgorde is nodig — de nieuwe functies schrijven
  en lezen `conference_provider`.
- De app zelf mag vóórlopen (Cloudflare Pages is sneller): met de oude functies
  en database werkt de Jitsi-keuze bij een afspraak al gewoon (de link gaat mee
  als geplakte link), negeert de oude boekingsfunctie de nieuwe keuze, en meldt
  de kaart in Instellingen bij opslaan rustig dat de database-update nog moet
  draaien.
- Geen nieuwe secrets of OAuth-scopes.

## Goed om te weten

- **meet.jit.si vraagt sinds 2023 dat wie een vergadering start één keer
  inlogt** (Google, GitHub of Facebook); gasten doen zonder account mee. Wil je
  dat niet, of wil je echt alles in eigen hand: draai een eigen Jitsi-server en
  vul het adres in bij Instellingen → Agenda.
- Op Google/Microsoft staat de Jitsi-link in de omschrijving, niet als
  "Deelnemen met …"-knop van Google/Outlook zelf: die knoppen zijn alleen voor
  hun eigen diensten (of voor geregistreerde add-ons).
- Een bestaande afspraak met Google Meet omzetten naar Jitsi: ResoFly toont
  daarna de Jitsi-knop, maar de Meet-vergadering blijft in Google Agenda zelf
  bestaan (Teams kan via de API nooit van een afspraak af). Haal die daar
  eventueel weg.
- Vergaderen ín ResoFly (Jitsi ingebed in een venster) zit hier bewust niet in:
  meet.jit.si staat inbedden niet toe voor echt gebruik; met een eigen server
  kan het wel. Een mogelijke volgende stap.
