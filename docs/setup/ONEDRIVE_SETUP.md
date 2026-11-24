# De kopie van Inhoud in OneDrive: inrichten

De eigenaar van een organisatie koppelt zijn OneDrive en zet een kopie aan.
ResoFly blijft de bestanden zelf bewaren (R2). Daarnaast houdt het een kopie bij
in één map in die OneDrive: `ResoFly - <organisatie> / klant / project / map /
bestand`. Wat er in ResoFly gebeurt (uploaden, hernoemen, verplaatsen, bewerken
in de editor, verwijderen), gebeurt daar ook. ResoFly is leidend: wat iemand in
OneDrive zelf doet, neemt ResoFly niet over.

- Plan en keuzes: `docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md`.
- Wat er gebouwd is: `docs/changelog/CHANGELOG_ONEDRIVE_KOPIE_2026-11-24.md`.

## 1. Wat er moet staan

| Onderdeel | Hoe het er komt |
| --- | --- |
| Migratie `20261124100000_onedrive_kopie.sql` | een push naar `staging` (workflow *Deploy Supabase (staging)*) |
| Edge function `onedrive-sync` | idem; `supabase/config.toml` zet `verify_jwt = false`, de functie controleert zelf |
| De route `/internal/onedrive/push` in de media-worker | **met de hand**: `cd workers/media-api && npm run deploy:staging` (productie: `npm run deploy`). De worker wordt niet door een workflow uitgerold. |
| De geplande taak `onedrive-sync` | `scripts/supabase-setup-webhooks.sh`, stap 7 (§4) |
| Microsoft | §3 |

Zonder de nieuwe worker loopt koppelen en aanzetten wel, maar komt er geen
bestand in OneDrive: elke taak wacht dan met "De bestandsopslag gaf een fout".

## 2. Secrets

Er hoeft niets bij als de agenda met Microsoft al werkt. `onedrive-sync`
gebruikt dan:

- `MICROSOFT_CALENDAR_CLIENT_ID`, `_CLIENT_SECRET` en `_TENANT_ID`: dezelfde
  app-registratie bij Microsoft;
- `CALENDAR_OAUTH_STATE_SECRET` en `CALENDAR_TOKEN_ENCRYPTION_KEY`: met een
  eigen afleiding, zodat een state van de agenda hier niet geldt;
- `CALENDAR_ALLOWED_RETURN_ORIGINS`: de adressen van de app. Hier geldt
  **alleen** die lijst, geen Cloudflare-previews (zie §6);
- `MEDIA_WORKER_URL` en `INTERNAL_UPLOAD_SECRET`: de media-worker, net als bij
  Bestanden versturen.

Wil je iets eigens, dan kan dat:

| Secret | Standaard |
| --- | --- |
| `ONEDRIVE_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT_ID` | de agendawaarden |
| `ONEDRIVE_REDIRECT_URL` | `https://<project>.supabase.co/functions/v1/onedrive-sync` |
| `ONEDRIVE_ALLOWED_RETURN_ORIGINS` | `CALENDAR_ALLOWED_RETURN_ORIGINS` |
| `ONEDRIVE_OAUTH_STATE_SECRET` / `ONEDRIVE_TOKEN_ENCRYPTION_KEY` | de agendawaarden |
| `ONEDRIVE_SYNC_CRON_SECRET` | zet het script in §4 |

Verander je de sleutel voor de tokens, dan moet de eigenaar opnieuw koppelen.

## 3. Microsoft Entra

In de app-registratie van de agenda (of een eigen):

1. **Authentication → Web → Redirect URIs**: voeg toe

   ```text
   https://<project>.supabase.co/functions/v1/onedrive-sync
   ```

2. **API permissions → Microsoft Graph → Delegated**: voeg **Files.ReadWrite**
   toe (naast `User.Read` en `offline_access`, die er al staan). Dat is de
   eigen OneDrive van wie koppelt, en niets anders: geen bestanden die anderen
   delen, geen SharePoint (keuze C).
3. Laat een bedrijf gebruikers zelf geen toestemming geven, dan moet de
   beheerder van dat bedrijf *Grant admin consent* doen. De eigenaar ziet anders
   "Je organisatie laat deze koppeling alleen toe met toestemming van een
   beheerder".
4. *Supported account types* bepaalt of privéaccounts (outlook.com) en
   werkaccounts allebei kunnen. Dat moet passen bij `MICROSOFT_CALENDAR_TENANT_ID`
   (`common` = beide).

Microsoft rekent niets voor de koppeling. De opslag valt onder het abonnement
van de klant: een gratis Microsoft-account heeft 5 GB, Microsoft 365 meestal
1 TB per gebruiker.

## 4. De geplande taak

```bash
SUPABASE_PROJECT_ID=<ref> SUPABASE_DB_PASSWORD='…' bash scripts/supabase-setup-webhooks.sh
```

Stap 7 zet `ONEDRIVE_SYNC_CRON_SECRET` en de pg_cron-taak `onedrive-sync` (elke
twee minuten). Na een wijziging in Inhoud zwengelt de app de wachtrij meteen
aan; de taak pakt de rest: een klant die op de klantenpagina wordt hernoemd,
een verwijderde klant (cascade), een storing, of een taak die moest wachten.

## 5. Zo werkt het voor de eigenaar

1. Instellingen → AI & koppelingen → **OneDrive** (alleen de eigenaar ziet het).
2. *OneDrive koppelen*: inloggen bij Microsoft, toestemming geven, terug in
   ResoFly.
3. *Kopie aanzetten*: ResoFly maakt de map `ResoFly - <organisatie>` in zijn
   OneDrive. Vanaf dan gaat elke wijziging mee.
4. Wat er al stond, zet hij erin met *Alles opnieuw kopiëren* (keuze A: niet
   vanzelf). Dezelfde knop zet terug wat er in OneDrive ontbreekt of daar is
   veranderd (keuze E).
5. De kaart zegt hoe het ervoor staat: "De kopie is bij", "3 wijzigingen gaan nu
   naar OneDrive", of wat er niet lukte, met *Opnieuw proberen*.
6. *Kopie uitzetten* stopt het bijhouden; *Ontkoppelen* haalt de koppeling weg.
   In beide gevallen blijft wat er in OneDrive staat, staan.

In Inhoud ziet iedereen een OneDrive-icoon in de commandobalk zolang de kopie
aanstaat, en de bevestiging bij verwijderen zegt "In OneDrive gaat het naar de
prullenbak".

## 6. De regels

- **Wat meegaat**: bestanden in de mappen van Inhoud en het klantdossier, en
  Word/Excel/PowerPoint-documenten uit Inhoud. **Niet**: notities,
  tekstdocumenten (keuze B), financiële stukken (bewaarplicht), de galerij en
  zendingen. De worker weigert die segmenten ook zelf.
- **Lege mappen** maakt ResoFly niet aan. Een klant- of projectmap komt er pas
  als er een bestand in komt.
- **ResoFly is leidend** (keuze D). Hernoemt iemand in OneDrive een map, dan
  zet ResoFly de naam terug zodra die map in ResoFly verandert, of bij *Alles
  opnieuw kopiëren*. Een bestand dat in OneDrive is bewerkt, wordt bij de
  volgende wijziging in ResoFly overschreven (en bij *Alles opnieuw
  kopiëren*); OneDrive bewaart de vorige versie.
- **Verwijderen** in ResoFly, ook van een map of een hele klant, zet het in de
  prullenbak van OneDrive: 30 dagen terug te halen (privé), 93 dagen (werk).
  Wat iemand zelf in een gekopieerde map in OneDrive zette, gaat dan mee.
- **Modulerechten gelden in OneDrive niet** (harde regel 3). Wie bij de map
  kan, ziet alle bestanden. Het scherm zegt dat bij het aanzetten; de eigenaar
  beslist met wie hij de map deelt.
- **Wat je verwijdert terwijl de kopie uitstaat**, blijft in OneDrive staan. Uit
  is uit: ResoFly houdt dan niets bij, ook niet wat er weg moet.
- **Een klant, project of map** gaat pas naar de prullenbak als er geen andere
  wijziging meer wacht. Zo schuift een submap die er net uit verhuisde eerst
  naar zijn nieuwe plek.
- **De eigenaar vertrekt of is geen eigenaar meer**: de kopie gaat uit, het
  token gaat weg. Een andere eigenaar kan opnieuw koppelen.
- **Een ander Microsoft-account koppelen**: ResoFly begint opnieuw, met een
  nieuwe map. De oude map blijft staan.
- **Terugkeeradres**: alleen de ingestelde app-adressen. Bij de agenda telt
  ook een Cloudflare-preview; hier niet, want wie een preview kan uitrollen,
  kon zo de code van een eigenaar ontvangen (review van 24 november).

## 7. Als het niet werkt

| Melding of klacht | Oorzaak |
| --- | --- |
| "OneDrive is op deze omgeving nog niet ingericht" | client-id/-secret of de geheimen van de agenda ontbreken (§2) |
| `redirect_uri_mismatch` bij Microsoft | het adres uit §3.1 staat niet bij de app-registratie |
| "Terugkeeradres niet toegestaan" | het adres van de app staat niet in `CALENDAR_ALLOWED_RETURN_ORIGINS` (of je zit op een preview) |
| Taken blijven wachten met "De bestandsopslag gaf een fout" | de media-worker is niet opnieuw uitgerold (§1), of `MEDIA_WORKER_URL` / `INTERNAL_UPLOAD_SECRET` ontbreekt |
| "De OneDrive van de eigenaar is vol" | ruimte maken in OneDrive; de kopie gaat daarna vanzelf verder (elk uur een poging) |
| "OneDrive geeft ResoFly geen toegang meer" | wachtwoord gewijzigd of toestemming ingetrokken: *Opnieuw koppelen* |
| "De opgeslagen toegang tot OneDrive is niet meer te lezen" | de sleutel voor de tokens is veranderd (§2): *Opnieuw koppelen* |
| Niets gebeurt na een wijziging buiten Inhoud | de geplande taak staat niet (§4) |
