# Agenda koppelen (Google en Microsoft) — 6 november 2026

Vraag: "Zorg ervoor dat het koppelen van Google en Microsoft agenda vloeiend
gaat. Controleer deze functie op gebruik/functie en security."

## Hoe getest

1. **Code nagelopen**: de hele rondgang (starten, terugkeer, afronden), de
   tokens, het ophalen van agenda's en afspraken, delen, loskoppelen, de RLS en
   de triggers van de agendatabellen.
2. **Staging bekeken** (alleen lezen, via de Management API): de koppelingen,
   hun status en de rechten op de tabellen.
3. **Eind-tot-eind** (`npm run test:stromen -- agenda`, 36 stappen): de echte
   edge function tegen een lokale stack met alle migraties, met nep-Google en
   nep-Microsoft (`tests/stromen/nep-agenda.mjs`) die codes, tokens,
   agendalijsten over meerdere pagina's en afspraken geven en bijhouden wat er
   werd ingetrokken.
4. **In de browser** (`tests/stromen/ui.mjs agenda`, 5 stappen in Chromium):
   op "Google koppelen" klikken, terugkomen, annuleren, opnieuw koppelen,
   loskoppelen.
5. **Unittests**: `calendarOAuth.test.ts` (state, terugkeeradres, toestemmingslink,
   rechten, foutcodes) en `calendarConnection.test.ts` (terugkeer, teksten, status).

## Wat al goed zat

- De callback wisselt de code niet zelf in; de app rondt af met de sessie van
  wie er is ingelogd, en alleen voor wie het koppelen startte.
- Tokens versleuteld, tabel zonder RLS-policies; bij vertrek van een teamlid
  vervallen zijn koppelingen en tokens.
- Een collega ziet van een privé-agenda alleen "Bezet"; accountgegevens van een
  gedeelde koppeling zijn afgeschermd; contacten zoeken kan alleen in je eigen adresboek.

## Wat er misging, en wat er nu gebeurt

### Gebruik

1. **Een mislukte koppeling bleef stil.** Wie bij Google op "Annuleren" klikte,
   of geen toestemming van zijn beheerder had, kwam terug in de app zonder enige
   melding, met `?calendar_error=…` in de adresbalk. Nu opent de app
   Instellingen → Agenda met uitleg in gewone woorden, per soort fout.
2. **Verlopen of geknoeide koppellink: een JSON-pagina op het adres van Supabase.**
   Nu gaat de browser terug naar de app met "het koppelen duurde te lang" of
   "deze koppellink klopt niet (meer)". De link is nu 30 minuten geldig in plaats
   van 10: inloggen met een tweestapscode haalde dat niet altijd.
3. **"Agenda gekoppeld", en eronder "Nog geen agenda gekoppeld".** De instellingen
   laadden vóór het afronden klaar was en verversten daarna niet. Nu staat er
   "Agenda koppelen…" tijdens het afronden, en daarna de koppeling zelf, met de
   bevestiging eronder.
4. **Elke fout heette "Edge Function returned a non-2xx status code".** De functie
   gaf bij elke fout status 500, en de app las de uitleg niet uit het antwoord.
   Nu leest de app de uitleg, en de functie geeft de juiste status (401, 403,
   400, 409 bij "koppel opnieuw", 502/503 bij Google of Microsoft zelf).
5. **De status stond er in het Engels** ("error", "expired"), zonder uitleg of
   knop. Nu: Actief, Verlopen, Fout of Ingetrokken, met de reden eronder en een
   knop **Opnieuw koppelen** die het bekende account klaarzet en alle
   instellingen houdt.
6. **Geen accountkeuze.** Wie in zijn browser bij een ander Google- of
   Microsoft-account was ingelogd, koppelde ongemerkt dat account. Nu vraagt
   Google en Microsoft altijd welk account.
7. **Beginstand na het koppelen.** Alles stond aan (ook Verjaardagen en
   Feestdagen) en niets was schrijfbaar, dus "Nieuwe afspraak" had geen agenda.
   Nu: de hoofdagenda getoond en schrijfbaar; bij Google verder precies de
   agenda's die in Google Agenda zelf aanstaan; alles privé.
8. **Microsoft: alleen de eerste tien agenda's**, en geen echte kleuren. Nu alle
   agenda's (ook na de eerste pagina) met hun kleur uit Outlook. Bij Google
   werden afspraken boven de 250 in beeld stil afgekapt; nu niet meer.
9. **Loskoppelen als "even opnieuw proberen"**: de bevestiging zei niet wat er
   gebeurt. Nu staat erin dat koppelingen van afspraken aan klanten vervallen,
   dat uren blijven, en dat "Opnieuw koppelen" de betere knop is.

### Functie

10. **Staging: de enige Google-koppeling stond sinds 14 oktober op "error · Bad
    Request".** Dat is Google's `invalid_grant`: het vernieuwtoken was ingetrokken
    of verlopen (in "Testing" doet Google dat na zeven dagen, zie
    `docs/setup/CALENDAR_INTEGRATION_SETUP.md` §3). Gevolg was erger dan een
    lege agenda: met elke status behalve "active" weigerde ResoFly afspraken in
    die agenda te zetten. Nu:
    - een ingetrokken token geeft "Verlopen" met uitleg;
    - een storing bij Google laat de koppeling met rust;
    - een verkeerde instelling (bijv. een verlopen Microsoft-clientsecret) zegt dat;
    - schrijven wordt alleen nog geweigerd als de koppeling echt ingetrokken is.
11. **Eén verdwenen agenda zette de hele koppeling op "fout"**, en daarmee ook
    het schrijven in de hoofdagenda op slot, en die fout ging nooit weg. Nu gaat
    alleen die agenda uit; bij "Agenda's ophalen" verdwijnt hij uit de lijst, en
    een oude foutstatus verdwijnt zodra alles weer werkt.
12. **Een afspraak aan een klant, project of taak koppelen, en een notitie bij een
    afspraak maken, werkte sinds 1 november niet** ("permission denied for table
    calendar_sources"). Twee triggers lazen de hele agendarij, ook het geheime
    ICS-adres dat de app sinds die dag niet meer mag lezen. Daarmee kwamen er
    ook geen uren uit afspraken. Migratie `20261106141000_afspraak_koppelen_herstel`
    leest alleen de nodige kolommen.
13. **Loskoppelen wiste uren.** De keten koppeling → agenda → koppeling van een
    afspraak → urenpost viel met "on delete cascade" helemaal weg, ook uren die
    al in een rapport of op een factuur waren gebruikt. Migratie `20261106140000_agenda_uren_bewaren` maakt
    zulke uren vóór het verwijderen los van de afspraak; ze blijven als gewone
    urenpost staan.
14. **Een ingetrokken koppeling** (teamlid vertrokken) werd bij elke weergave van
    de agenda overschreven met "error: Agenda-token niet gevonden". De reden
    bleef zo niet staan; nu wel.
15. **Zonder agenda-vinkje bij Google** kwam er toch een koppeling, die daarna
    bij elk ophalen "insufficient authentication scopes" gaf. Nu weigert
    ResoFly zo'n koppeling met uitleg.

### Security

16. **Het terugkeeradres viel open.** Zonder `CALENDAR_ALLOWED_RETURN_ORIGINS`
    mocht elk adres. Iemand kon dan een koppeling starten met zijn eigen site als
    terugkeeradres, de toestemmingslink naar een ander sturen, en diens code
    vangen om andermans agenda aan zijn eigen account te koppelen. Op staging
    stond de instelling wel; nu valt het dicht (alleen `localhost`) als hij
    ontbreekt.
17. **Tekst van buiten in de app.** De callback zette de foutomschrijving van de
    provider ongefilterd in het adres, en de app toonde die. Zo kon iedereen een
    link naar ResoFly maken met een eigen "foutmelding" erin. Nu gaan er alleen
    vaste codes mee en komt de tekst uit de app.
18. **Privé in Google, zichtbaar in ResoFly.** Een afspraak die de eigenaar in
    Google of Outlook als privé markeerde, stond in een met het team gedeelde
    agenda volledig in beeld (titel, omschrijving, genodigden), ook voor Gerrie.
    Nu ziet een collega daar alleen "Bezet".
19. **Loskoppelen trok de verkeerde of geen toestemming in.** Het verlopen
    toegangstoken werd ingetrokken (dat doet na een uur niets meer) via de URL.
    Nu het vernieuwtoken, in de body. En niet als hetzelfde Google-account elders
    in ResoFly nog gekoppeld is: Google trekt dan de toestemming voor alle
    koppelingen tegelijk in.

## Wat de beheerder zelf moet nakijken

- Google Cloud Console → OAuth-toestemmingsscherm: staat de app op **In
  production**? In "Testing" verloopt elke koppeling na zeven dagen.
- Google Cloud Console: staat de **People API** aan (contacten zoeken)?
- Microsoft Entra: de vervaldatum van het client secret, en de rechten
  `Contacts.Read` en `People.Read` (stonden niet in de oude handleiding).
- De Google-koppeling op staging: opnieuw koppelen via Instellingen → Agenda →
  **Opnieuw koppelen**.

## Bestanden

- `supabase/functions/_shared/calendarOAuth.ts` (nieuw, puur, getest)
- `supabase/functions/calendar-integrations/index.ts`
- `supabase/functions/_shared/calendarCore.ts`, `calendarAvailability.ts`, `calendarEventWrite.ts`, `actions/calendar.ts`
- `supabase/migrations/20261106140000_agenda_uren_bewaren.sql`
- `supabase/migrations/20261106141000_afspraak_koppelen_herstel.sql`
- `src/lib/calendarConnection.ts` (nieuw, puur, getest), `src/lib/calendar-api.ts`
- `src/main.tsx`, `src/features/CalendarPage.tsx`, `src/styles/globals.css`
- `tests/stromen/agenda.mjs`, `tests/stromen/nep-agenda.mjs`, `tests/stromen/ui.mjs` (scenario `agenda`)
- `docs/setup/CALENDAR_INTEGRATION_SETUP.md` (herschreven)
