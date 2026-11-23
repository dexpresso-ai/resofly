# Google Drive en OneDrive koppelen: inrichten

Een teamlid koppelt zijn eigen Google Drive of OneDrive en zet bestanden daaruit
in een dossiermap van Inhoud (*+ Nieuw → Uit Google Drive* of *Uit OneDrive*).
ResoFly bewaart alleen een verwijzing: het bestand blijft in Drive of OneDrive
en opent daar. **Verwijder je het in ResoFly, dan gaat het in Drive of OneDrive
naar de prullenbak.**

Gebouwd op 23 november 2026; zie
`docs/changelog/CHANGELOG_DRIVE_ONEDRIVE_2026-11-23.md`.

## 1. Database en functie

- Migratie `20261123150000_drive_onedrive_koppelen.sql`: de koppelingen
  (`cloud_drive_connections` en `_tokens`), de kolommen `cloud_*` op
  `attachments` en de verwijderwachtrij `cloud_file_deletions`.
- Edge function `cloud-files`. In `supabase/config.toml` staat
  `verify_jwt = false`: Google en Microsoft sturen de browser na "toestaan"
  terug naar deze functie, zonder Supabase-sessie. Elke actie van de app eist in
  code een geldige sessie, lidmaatschap en de module Inhoud.
- Een push naar `staging` zet beide klaar (workflow *Deploy Supabase (staging)*).

## 2. Secrets

Zonder eigen waarden gebruikt `cloud-files` die van de agenda
(`CALENDAR_OAUTH_STATE_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY`,
`CALENDAR_ALLOWED_RETURN_ORIGINS`, `GOOGLE_CALENDAR_*`, `MICROSOFT_CALENDAR_*`).
Wat er minstens bij moet:

```bash
supabase secrets set \
  GOOGLE_PICKER_API_KEY="…" \
  GOOGLE_CLOUD_PROJECT_NUMBER="…"
```

Aangeraden voor Google: een **eigen OAuth-client voor Drive**.

```bash
supabase secrets set \
  GOOGLE_DRIVE_CLIENT_ID="…" \
  GOOGLE_DRIVE_CLIENT_SECRET="…"
```

Waarom: het token voor de kiezer van Google komt kort in de browser. Het mag
daar niet meer kunnen dan bestanden kiezen (`drive.file`). Gebruikt Drive
dezelfde Google-client als de agenda, en voegt Google de rechten samen, dan
weigert `cloud-files` het token met de melding "Dit Google-token kan meer dan
bestanden kiezen". Met een eigen client gebeurt dat nooit.

Optioneel:

| Secret | Standaard | Wanneer |
| --- | --- | --- |
| `MICROSOFT_DRIVE_CLIENT_ID` / `_SECRET` / `_TENANT_ID` | de agendawaarden | een eigen app-registratie voor OneDrive |
| `CLOUD_FILES_REDIRECT_URL` | `https://<project>.supabase.co/functions/v1/cloud-files` | een eigen domein voor de functies |
| `CLOUD_FILES_ALLOWED_RETURN_ORIGINS` | `CALENDAR_ALLOWED_RETURN_ORIGINS` | andere app-adressen dan de agenda |
| `CLOUD_FILES_OAUTH_STATE_SECRET` / `CLOUD_FILES_TOKEN_ENCRYPTION_KEY` | de agendawaarden | eigen geheimen |

Verander je de sleutel voor de tokens, dan moet iedereen opnieuw koppelen.

## 3. Google Cloud

In hetzelfde project als de agenda (of een eigen project, dan met een eigen
client en projectnummer):

1. **APIs & Services → Library**: zet aan **Google Drive API** en **Google
   Picker API**.
2. **Credentials → Create credentials → API key**. Beperk hem:
   - *Application restrictions*: HTTP referrers, met de adressen van de app
     (`https://app.resofly.nl/*`, `https://staging.resofly.pages.dev/*`,
     `https://*.resofly.pages.dev/*`).
   - *API restrictions*: alleen **Google Picker API**.
   Dit is `GOOGLE_PICKER_API_KEY`. Hij komt in de browser; dat is de bedoeling.
3. Het **projectnummer** (Cloud-dashboard, "Project number", alleen cijfers) is
   `GOOGLE_CLOUD_PROJECT_NUMBER`. Het moet het project van de OAuth-client zijn:
   alleen dan krijgt ResoFly toegang tot de bestanden die iemand in de kiezer
   aanwijst.
4. **OAuth-client** (Web application): voeg als redirect-URI toe

   ```text
   https://<project>.supabase.co/functions/v1/cloud-files
   ```

5. **OAuth-toestemmingsscherm → Data access**: voeg de scope toe

   ```text
   https://www.googleapis.com/auth/drive.file
   ```

   Die is bij Google "non-sensitive": geen extra beoordeling. ResoFly vraagt
   bewust niet `drive` of `drive.readonly`; die zijn "restricted" en dan eist
   Google elk jaar een betaalde beveiligingsbeoordeling.
6. *Publishing status* **In production** (net als bij de agenda; in "Testing"
   verloopt een koppeling na zeven dagen).

## 4. Microsoft Entra

In de app-registratie van de agenda (of een eigen):

1. **Authentication → Web → Redirect URIs**: voeg dezelfde URL toe als bij
   Google (`…/functions/v1/cloud-files`).
2. **API permissions → Microsoft Graph → Delegated**: voeg **Files.ReadWrite**
   toe (naast `User.Read` en `offline_access`, die er al zijn). Dat is de eigen
   OneDrive van de gebruiker; gedeelde mappen en SharePoint doen (nog) niet mee.
3. Laat een organisatie gebruikers zelf geen toestemming geven, dan moet een
   beheerder "Grant admin consent" doen. De gebruiker ziet anders "Je
   organisatie laat deze koppeling alleen toe met toestemming van een beheerder".

Bij Microsoft komt geen token in de browser: de lijst van OneDrive in het
venster haalt `cloud-files` op.

## 5. De geplande taak

```bash
SUPABASE_PROJECT_ID=<ref> SUPABASE_DB_PASSWORD='…' bash scripts/supabase-setup-webhooks.sh
```

Stap 7 zet `CLOUD_FILES_CRON_SECRET` en de pg_cron-taak
`cloud-files-deletions` (elk kwartier). Meestal gooit de app een verwijderd
bestand meteen weg; de taak pakt wat bleef liggen (een storing, een verwijderde
klant zonder scherm ertussen, een koppeling die net opnieuw is gezet).

## 6. Zo werkt het voor de gebruiker

1. Open een dossiermap in Inhoud (of in het klantdossier → Bestanden).
2. *+ Nieuw → Uit Google Drive* of *Uit OneDrive*.
3. Nog niet gekoppeld: *Google Drive koppelen*. Na "toestaan" opent Inhoud weer
   in dezelfde map, met het venster erbij.
4. Google: de kiezer van Google opent; kies een of meer bestanden (ook uit
   gedeelde Drives). OneDrive: vink bestanden aan in de lijst, ook uit
   verschillende mappen. Hooguit 50 per keer.
5. De bestanden staan in de map, met een wolkje bij het icoon en bij Type
   "PDF · Google Drive". Klikken opent ze in Drive of OneDrive.
6. Hernoemen en verplaatsen gebeurt alleen in ResoFly.
7. Verwijderen in ResoFly (het bestand, de map, of de klant) zet het bestand in
   de prullenbak van Drive of OneDrive. Lukt dat niet, dan staat het onderaan in
   het venster *Uit Google Drive / OneDrive* onder "Nog niet uit … verwijderd",
   met *Opnieuw* en *Laten staan*.

Wat niet kan met een gekoppeld bestand: delen met de klant of versturen
(Bestanden versturen). Het ligt niet in de opslag van ResoFly; deel het vanuit
Drive of OneDrive zelf. Downloaden en bewerken gebeuren ook daar.

## 7. De regels

- **Wie verwijdert, met welk account**: de prullenbak gaat met de koppeling van
  wie het bestand koppelde. Die gaf daar bij het koppelen toestemming voor (het
  venster zegt het erbij). Wie in ResoFly mag verwijderen, beslissen de rechten
  op Inhoud, zoals altijd.
- **Prullenbak, niet definitief**: Google bewaart hem 30 dagen; OneDrive 30
  dagen (privé) of 93 dagen (werk of school).
- **Geen eigenaar**: in Google Drive kan alleen de eigenaar (of in een gedeelde
  Drive een beheerder) een bestand weggooien. Het venster waarschuwt al bij het
  koppelen; verwijderen in ResoFly laat het dan in Drive staan, met de reden.
- **Ontkoppelen**: de bestanden blijven in ResoFly staan, maar verwijderen gaat
  dan niet meer door naar Drive of OneDrive. Koppel je hetzelfde account
  opnieuw, dan gaat wat er wachtte alsnog.
- **Een teamlid vertrekt**: zijn koppeling gaat uit en zijn token weg (net als
  bij de agenda). Wat hij koppelde, blijft staan.
- **Hetzelfde bestand twee keer**: kan niet in één organisatie. Staat het in
  een andere organisatie van hetzelfde account ook, dan gooit ResoFly het niet
  weg zolang daar nog een verwijzing is.
- **Opslag**: een gekoppeld bestand telt niet mee in het opslagquotum
  (`size_bytes` is 0; de grootte uit Drive staat in `cloud_size_bytes`).
- **Gerrie**: een voorstel "Bestand verwijderen" zegt erbij dat het in Drive of
  OneDrive naar de prullenbak gaat. Het gebeurt pas als een mens goedkeurt.

## 8. Als het niet werkt

| Melding of klacht | Oorzaak |
| --- | --- |
| "… is op deze omgeving nog niet ingericht" | client-id/-secret, state-geheim of tokensleutel ontbreekt (§2) |
| "de sleutel voor de kiezer van Google ontbreekt" | `GOOGLE_PICKER_API_KEY` of `GOOGLE_CLOUD_PROJECT_NUMBER` ontbreekt |
| "Dit Google-token kan meer dan bestanden kiezen" | Drive gebruikt de client van de agenda; zet `GOOGLE_DRIVE_CLIENT_ID/SECRET` en koppel opnieuw |
| `redirect_uri_mismatch` bij Google of Microsoft | de URL uit §3.4 / §4.1 staat niet bij de client |
| De kiezer van Google blijft leeg | API-sleutel niet beperkt tot de juiste adressen, of de Picker API staat uit |
| Verwijderd bestand blijft in Drive | zie het venster: verlopen koppeling (opnieuw koppelen), geen eigenaar, of de geplande taak staat niet (§5) |
