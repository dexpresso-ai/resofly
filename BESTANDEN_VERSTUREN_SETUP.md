# Bestanden versturen — uitrollen

Wat er nodig is om "Bestanden versturen" (zie `CHANGELOG_BESTANDEN_VERSTUREN_2026-10-13.md`)
op een Supabase-project + Cloudflare te zetten. Eerst staging (`enzghpduqwaojcxgwarr`),
pas daarna productie.

## Volgorde

De volgorde doet ertoe: de functies verwachten de tabellen, de worker schrijft in die
tabellen, en de opruimtaak roept een functie aan.

1. **Database** — `supabase db push`
   - `20261013100000_file_transfers.sql` (zendingen, items, ontvangers, codes, sessies,
     logboek, opruimwachtrij; `recipient_kind 'client'` voor Delen; opslagmeter telt
     zendingen mee). Maakt ook een index op `attachments(organization_id, storage_key)` en
     `documents(organization_id, storage_key)`; bij een grote tabel duurt dat even.
   - Let op: `20261013000000_teamchat_teams.sql` (teamchat, een andere wijziging) staat er
     vóór en gaat dus mee als die nog niet is toegepast.
2. **Edge functions** — `supabase functions deploy` (alles), of minimaal:
   - nieuw: `file-transfer`, `file-transfer-public`
   - gewijzigd: `client-portal`, `mail`, `file-share`, `file-share-public`, `resend-webhook`
   - via de handelingenregistry (Gerrie-acties `files.*`): `gerrie-agent`,
     `gerrie-agent-runner`, `gerrie-signals`, `mcp`, `api`
   - `verify_jwt = false` voor de twee nieuwe functies staat in `supabase/config.toml`.
3. **Media-worker** — `cd workers/media-api && npx wrangler deploy --env staging`
   (nieuwe routes `/transfer/*`, `/internal/transfer/copy`, `/internal/signed-urls`,
   `/signed/file/*`, `/signed/transfer-zip/*`). Pas ná de migratie: de worker schrijft in
   `storage_purge_queue` (kolom `purge_after`) en leest `file_transfers` /
   `file_transfer_recipients` bij elke download met een getekende link.
4. **Opruimtaak** — `bash scripts/supabase-setup-webhooks.sh` (of het vinkje
   `setup_webhooks` in de workflow "Deploy Supabase (staging)"). Stap 5 van dat script
   zet een nieuw `FILE_TRANSFER_CRON_SECRET` en de pg_cron-taak `file-transfer-purge`
   (elk kwartier → `https://<ref>.functions.supabase.co/file-transfer?cron=purge`).
   Veilig om opnieuw te draaien.
5. **Frontend** — gewone deploy. `public/_headers` zet voor `/ontvang/*`
   `X-Robots-Tag: noindex, nofollow` en `Referrer-Policy: no-referrer`.

## Secrets

| Waar | Naam | Nieuw? | Waarvoor |
|---|---|---|---|
| Supabase | `FILE_TRANSFER_CRON_SECRET` | ja (het script zet hem) | de opruimtaak; zonder dit secret weigert `?cron=purge` |
| Supabase | `MEDIA_WORKER_URL`, `INTERNAL_UPLOAD_SECRET` | nee | kopiëren, ondertekende links, verwijderen in R2 |
| Supabase | `APP_PUBLIC_URL` | nee | de link `/ontvang/<token>` in de mail |
| Supabase | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `MAIL_INBOUND_DOMAIN` | nee | de mails (melding + code), Reply-To naar het klantgesprek |
| Supabase | `FILE_TRANSFER_ALLOWED_ORIGINS` | optioneel | CORS; valt terug op `FILE_SHARE_ALLOWED_ORIGINS` / `APP_ALLOWED_ORIGINS` / `APP_PUBLIC_URL` |
| Worker | `MEDIA_SIGNING_SECRET`, `INTERNAL_UPLOAD_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | nee | tokens tekenen, interne routes, items wegschrijven |
| Worker | `MEDIA_PUBLIC_URL` (var in `wrangler.toml`) | nee | de host van de ondertekende downloadlinks |

## Controleren na het uitrollen

- `select jobname, schedule from cron.job where jobname = 'file-transfer-purge';`
- Inhoud → een bestand → ⋮ → **Versturen…** naar een testklant met een eigen adres;
  de mail komt, de link vraagt een code, de code komt, downloaden werkt.
- **Intrekken** (Gedeeld & verzonden → de zending): de items staan meteen op `purged_at`
  en de objecten zijn weg uit R2. Een vervaldatum in het verleden zetten kan niet (de
  trigger weigert dat); het verlopen zelf test je met een zending van 1 dag — de taak
  ruimt hem binnen een kwartier na de vervaldatum op.
- Instellingen → Abonnement: de opslagmeter noemt "waarvan … in verstuurde bestanden".
- Klantportaal → Bestanden: de zending staat onder **Ontvangen**.

## Terugdraaien

De functies en de worker kun je terugzetten naar de vorige versie; de nieuwe tabellen
staan dan ongebruikt. `organization_storage_status` heeft er één kolom bij
(`transfers_bytes`, achteraan) — oudere code leest die niet en merkt er niets van.
