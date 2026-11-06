# Google- en Microsoft-agenda koppelen: inrichten

Elke gebruiker koppelt zijn eigen Google- of Microsoft-agenda, per organisatie.
De koppeling loopt via de edge function `calendar-integrations`; tokens staan
versleuteld in de database en komen nooit in de browser.

Bijgewerkt op 6 november 2026 (zie `docs/changelog/CHANGELOG_AGENDA_KOPPELEN_2026-11-06.md`).

## 1. Database en functie

De tabellen en regels staan in de migraties (`supabase/migrations`); een push
naar `staging` zet ze klaar, net als de edge function. Zie
`supabase/migrations/README.md` voor een nieuwe omgeving.

`supabase/config.toml` zet `verify_jwt = false` voor `calendar-integrations`:
Google en Microsoft sturen de browser na het toestaan terug naar deze functie,
zonder Supabase-sessie. Alle acties van de app (POST) eisen wel een geldige
sessie; de terugkeer zelf wisselt niets in (zie §6).

## 2. Secrets

```bash
supabase secrets set \
  CALENDAR_REDIRECT_URL="https://<project>.supabase.co/functions/v1/calendar-integrations" \
  CALENDAR_ALLOWED_RETURN_ORIGINS="https://app.resofly.nl,https://staging.resofly.pages.dev" \
  CALENDAR_OAUTH_STATE_SECRET="<lange willekeurige tekst, minstens 32 tekens>" \
  CALENDAR_TOKEN_ENCRYPTION_KEY="<lange willekeurige tekst, minstens 32 tekens>" \
  GOOGLE_CALENDAR_CLIENT_ID="…" \
  GOOGLE_CALENDAR_CLIENT_SECRET="…" \
  MICROSOFT_CALENDAR_CLIENT_ID="…" \
  MICROSOFT_CALENDAR_CLIENT_SECRET="…" \
  MICROSOFT_CALENDAR_TENANT_ID="common"
```

- `CALENDAR_ALLOWED_RETURN_ORIGINS`: de adressen van de app, gescheiden door
  komma's. De browser komt na het koppelen alleen op zo'n adres terug (plus de
  Cloudflare-previews `*.resofly.pages.dev`). **Verplicht**: zonder deze
  instelling mag alleen `localhost` (eerst mocht dan elk adres).
- Gebruik per omgeving een eigen `CALENDAR_OAUTH_STATE_SECRET` en
  `CALENDAR_TOKEN_ENCRYPTION_KEY`. Verander je de encryptiesleutel, dan moet
  iedereen opnieuw koppelen.
- `MICROSOFT_CALENDAR_TENANT_ID`: `common` (werk- én privé-accounts),
  `organizations` (alleen werk/school) of één tenant-id. Dit moet passen bij
  "Supported account types" van de app-registratie (§4).

## 3. Google Cloud

1. Kies of maak een project in de Google Cloud Console.
2. Zet aan: **Google Calendar API** en **People API** (de People API zoekt
   contacten bij het uitnodigen van genodigden).
3. OAuth-toestemmingsscherm:
   - **Publishing status: In production.** In "Testing" laat Google een
     vernieuwtoken na **zeven dagen** verlopen. Elke koppeling springt dan na een
     week op "Verlopen" (in de logs: `invalid_grant`, "Bad Request"). Zo stond de
     koppeling op staging vanaf 14 oktober 2026.
   - De agenda- en contactscopes zijn "sensitive". Boven de honderd gebruikers
     wil Google een verificatie; daarvoor zie je bij het koppelen het scherm
     "Google heeft deze app niet geverifieerd" (doorgaan kan via "Geavanceerd").
4. OAuth-client van het type **Web application**, met als redirect-URI exact:

   ```text
   https://<project>.supabase.co/functions/v1/calendar-integrations
   ```

5. Scopes die de app vraagt:

   ```text
   openid email profile
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/contacts.readonly
   https://www.googleapis.com/auth/contacts.other.readonly
   ```

   Google laat de gebruiker losse vinkjes uitzetten. Zonder de twee agendascopes
   weigert ResoFly de koppeling met uitleg; zonder de contactscopes werkt alles
   behalve contacten zoeken bij genodigden.

## 4. Microsoft Entra

1. Microsoft Entra admin center → App registrations → New registration.
2. Supported account types: passend bij `MICROSOFT_CALENDAR_TENANT_ID` (§2).
3. Redirect URI van het type **Web**: dezelfde URL als bij Google.
4. Certificates & secrets → New client secret. **Let op de vervaldatum** (hooguit
   24 maanden). Is hij verlopen, dan zien gebruikers "De koppeling met Microsoft
   is niet goed ingesteld (invalid_client)". Zet dan een nieuwe in
   `MICROSOFT_CALENDAR_CLIENT_SECRET`; koppelingen hoeven niet opnieuw.
5. API permissions → Microsoft Graph → Delegated:

   ```text
   openid profile email offline_access
   User.Read
   Calendars.ReadWrite
   Contacts.Read
   People.Read
   ```

6. In organisaties die gebruikers geen toestemming laten geven, moet een
   beheerder "Grant admin consent" doen. Zonder dat ziet de gebruiker in ResoFly:
   "Je organisatie laat deze koppeling alleen toe met toestemming van een beheerder".

## 5. Zo werkt het voor de gebruiker

Instellingen → Agenda → **Google koppelen** of **Microsoft koppelen**.

1. Google/Microsoft vraagt welk account (accountkeuze staat altijd aan) en om
   toestemming.
2. De browser komt terug in ResoFly, op Instellingen → Agenda. Er staat
   "Agenda koppelen…" en na een paar seconden de koppeling in de lijst.
3. Beginstand: de hoofdagenda wordt getoond en is schrijfbaar; bij Google
   worden de agenda's getoond die in Google Agenda zelf aangevinkt staan. Alles
   is privé tot je "Delen" aanzet.

Statussen onder **Gekoppelde accounts**:

| Status | Betekenis | Wat te doen |
| --- | --- | --- |
| Actief | werkt | — |
| Verlopen | Google/Microsoft geeft geen toegang meer (ingetrokken, wachtwoord gewijzigd, of §3 "Testing") | **Opnieuw koppelen**: het juiste account staat klaar, alles blijft staan |
| Fout | het ophalen lukte de laatste keer niet; de uitleg staat eronder | herstelt zich zodra het weer lukt; anders opnieuw koppelen |
| Ingetrokken | het teamlid was uit de organisatie | opnieuw koppelen |

**Loskoppelen** trekt bij Google de toestemming in (behalve als hetzelfde
Google-account elders in ResoFly nog gekoppeld is) en haalt de agenda's weg.
Koppelingen van afspraken aan klanten en projecten vervallen; geregistreerde
uren blijven staan als gewone urenposten. Voor een haperende koppeling is
"Opnieuw koppelen" de juiste knop, niet los- en weer aankoppelen.

## 6. Beveiliging

- Tokens staan AES-GCM-versleuteld in `calendar_connection_tokens`; die tabel
  heeft RLS zonder policies: alleen de edge functions (service role) lezen hem.
- De `state` is met HMAC ondertekend, bevat gebruiker, organisatie,
  terugkeeradres en een nonce, en is 30 minuten geldig.
- De terugkeer van Google/Microsoft wisselt de code **niet** in. De app rondt af
  (`oauthComplete`) met de sessie van wie er is ingelogd, en dat moet degene
  zijn die het koppelen startte. Een doorgestuurde toestemmingslink koppelt zo
  nooit andermans agenda aan jouw account.
- Het terugkeeradres is altijd een adres van de app (`CALENDAR_ALLOWED_RETURN_ORIGINS`).
- Bij een fout gaat er alleen een vaste code naar de app (`geweigerd`,
  `beheerder`, `verlopen`, `ongeldig`, `storing`, `mislukt`); de tekst die de
  gebruiker leest komt uit de app, nooit uit het adres.
- Een collega ziet van een privé-agenda alleen "Bezet", en van een gedeelde
  agenda niet wat de eigenaar bij Google of Outlook zelf als privé markeerde.
- Vertrekt een teamlid, dan worden zijn koppelingen ingetrokken en zijn tokens
  gewist (migratie `20261101020000`).

## 7. Testen

```bash
npm test                                   # o.a. calendarOAuth.test.ts, calendarConnection.test.ts
npm run test:stromen -- agenda             # de hele rondgang tegen een lokale stack, met nep-Google/-Microsoft
node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs agenda   # de knoppen in Chromium
```

Zie `tests/stromen/README.md` voor het starten van de lokale stack.

## 8. Bestanden

```text
supabase/functions/calendar-integrations/index.ts   de edge function (koppelen, agenda's, afspraken)
supabase/functions/_shared/calendarOAuth.ts         regels van de rondgang (puur, getest)
supabase/functions/_shared/calendarCore.ts          tokens, versleuteling, vernieuwen
supabase/functions/_shared/calendarAvailability.ts  afspraken ophalen en afschermen
src/lib/calendar-api.ts                             de aanroepen vanuit de app
src/lib/calendarConnection.ts                       terugkeer, foutteksten, statussen (puur, getest)
src/features/CalendarPage.tsx                       Instellingen → Agenda
tests/stromen/agenda.mjs, nep-agenda.mjs            de end-to-end test met nep-Google/-Microsoft
```
