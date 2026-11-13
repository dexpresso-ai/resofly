# Herhalende afspraken blijven op hun tijd bij zomer- en wintertijd, en zoekmachines blijven uit de agenda (2026-11-13)

## Aanleiding

"Ik wil dat de app keurig automatisch switcht naar zomer- en wintertijd.
Zoekmachines hoeven niet in de agenda te kijken." Beide stonden onder *Bekend*
in `CHANGELOG_AGENDASERVER_DEELLINKS_2026-11-13.md`.

## Wat er misging

1. **Een reeks schoof een uur bij de klokwissel.** ResoFly rekende een
   herhalende afspraak uit door vanaf het eerste begin hele dagen in UTC op te
   tellen (`advanceRecurrence`). "Elke maandag 9.00 uur", gemaakt in de winter,
   stond na 29 maart om 10.00 uur; een reeks uit de zomer stond in de winter om
   8.00 uur. Dat gold voor de agenda in de app, de controle op dubbele boekingen
   bij boekingslinks, Gerrie en de koppeling met Claude (alles via
   `calendarAvailability.ts`), en ook voor de telefoon en de deellinks: de
   agendaserver gaf zo'n reeks in UTC door.
2. **Een op de telefoon weggehaalde keer bleef in de zomer staan.** De telefoon
   haalt "9.00 uur" weg (07.00 UTC); ResoFly zette die keer op 08.00 UTC en zag
   geen overeenkomst.
3. **Een oude dagelijkse reeks verdween.** De berekening hield na 800 keer op:
   een dagelijkse afspraak van meer dan twee jaar oud stond niet meer in de
   agenda.
4. **Elke maand op de 31e liep scheef.** In een maand zonder 31e schoof de
   afspraak door naar de 1e van de maand erna, en de reeks bleef daarna op de
   1e of 3e staan. Een telefoon slaat zo'n maand over.
5. **"Herhaal volgende week" bij boekingslinks** telde 7 × 24 uur op: over de
   klokwissel heen kwam een moment van 9.00 uur op 10.00 of 8.00 uur.
6. **Zoekmachines mochten kijken.** Cloudflare zet voor de hele zone
   `resofly.com` een eigen robots.txt vóór die van de agendaserver, met
   `User-agent: *` en `Allow: /`. Onze `Disallow: /` stond onder dezelfde
   `User-agent: *`, en bij gelijke regels wint de toestemming.

## Wat er nu klopt

- **Op de wandklok.** Een reeks telt op in de tijdzone van de afspraak: de
  datum en de kloktijd gaan vooruit, en pas daarna rekenen we terug naar UTC
  (`supabase/functions/_shared/wallClock.ts`, `recurrenceStarts`). De zone is
  die van de afspraak (de telefoon zet hem uit TZID, de app uit de agenda),
  anders die van de agenda, anders Amsterdam. Een afspraak van een hele dag
  herhaalt op datum.
- **Een kloktijd die niet bestaat of twee keer voorkomt**, zoals RFC 5545 het
  wil: 2.30 uur op de dag dat de klok vooruit gaat wordt 3.30 uur; 2.30 uur op
  de dag dat hij terug gaat is de eerste keer.
- **Telefoon en deellink**: een reeks uit de app staat er nu op de kloktijd met
  tijdzone (`DTSTART;TZID=Europe/Amsterdam:…`), met een VTIMEZONE erbij (de
  laatste zondag van maart en oktober). Een weggehaalde keer ook. Een losse
  afspraak blijft in UTC; daar doet de klokwissel niet toe.
- **Lange reeksen**: bij dagen en weken springt de berekening meteen naar vlak
  voor de getoonde periode, dus een reeks van jaren oud staat er gewoon.
- **Elke maand op de 31e**: maanden zonder 31e vallen weg, zoals op de telefoon.
- **"Herhaal volgende week"**: hetzelfde moment een week later op de klok van
  je apparaat, net als het rooster en het weekpatroon.
- **Zoekmachines**: de robots.txt van de agendaserver noemt de zoekmachines bij
  naam (Googlebot, Bingbot, DuckDuckBot, Applebot, YandexBot, Baiduspider en
  meer) met `Disallow: /`. Een groep met de eigen naam gaat vóór die van `*`,
  dus de `Allow` van Cloudflare telt voor hen niet. Daarnaast krijgt elk
  antwoord van de agendaserver `X-Robots-Tag: noindex, nofollow, noarchive,
  nosnippet`, ook een 401 of 404. De beheerde robots.txt van Cloudflare voor de
  rest van `resofly.com` blijft zoals hij is.

## Gevolgen voor bestaande gegevens

Een keer van een reeks die in de app was gekoppeld aan een klant of project
(`calendar_event_links`, op begintijd), en die door de oude berekening een uur
verkeerd stond, past na deze wijziging niet meer op die keer. Op staging is
dat niets: er staan nog geen herhalende ResoFly-afspraken en geen koppelingen
(gelezen op 13 november). Er is geen productie.

## Getest

- `npm run typecheck` en de Worker apart (`tsc` in `workers/caldav`): schoon.
- `npm test`: 1775 tests, 0 fout. Nieuw:
  - `_shared/wallClock.test.ts` (13): de klokwissel in maart en oktober, een
    weggehaalde keer in de zomer, 2.30 uur die niet bestaat of dubbel is, de
    31e, UNTIL, COUNT, INTERVAL, een reeks van 2022, een hele dag, New York, de
    VTIMEZONE van Amsterdam, New York en Tokio, en dat de app en de server
    dezelfde code gebruiken;
  - `src/lib/bookingLinksWeek.test.ts`: "Herhaal volgende week" over beide
    klokwissels;
  - in `workers/caldav/src/logic.test.ts`: een reeks met tijdzone op de
    telefoon en in de deellink, en de robots.txt naast die van Cloudflare.
- `deno check` op de 35 functies uit `frontend-checks.yml` en
  `_shared/wallClock.ts`: schoon.
- `npm run test:stromen -- caldav`: 30 stappen, 0 fout. Nieuw: een reeks uit de
  app (vanaf 15 maart 2027, 9.00 uur) staat in de app elke maandag om 9.00 uur,
  ook na 28 maart, en op de telefoon en in de deellink met tijdzone; een reeks
  van de telefoon met een weggehaalde keer in de zomer; X-Robots-Tag op elk
  antwoord.
- `npm run test:stromen -- agenda boekingslinks videovergadering klantdomein`:
  220 stappen, 0 fout.
- `npm run test:mobile -- --theme=both` op Instellingen → Agenda, het venster
  "Delen buiten ResoFly" en de boekingspagina: 36 metingen, 0 problemen.

## Bestanden

- `supabase/functions/_shared/wallClock.ts` (nieuw, puur, getest)
- `supabase/functions/_shared/calendarCore.ts`: `recurrenceTimeZone` in plaats
  van `advanceRecurrence`
- `supabase/functions/_shared/calendarAvailability.ts`: `expandRecurringNativeRow`
- `workers/caldav/src/logic.ts`, `index.ts`: tijdzone en VTIMEZONE, robots.txt,
  X-Robots-Tag
- `src/lib/bookingLinks.ts`, `src/features/MeetingBookingManager.tsx`:
  `sameTimeNextWeek`
- `tests/stromen/caldav.mjs`
