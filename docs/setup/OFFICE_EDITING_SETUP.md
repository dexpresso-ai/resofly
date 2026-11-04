# Online Office-bewerken (Collabora op Cloudflare Containers) — deploy-runbook

Bewerk `.docx/.xlsx/.pptx` (en ODF) rechtstreeks in de browser binnen ResoFly. De
canonieke bestanden blijven op **Cloudflare R2**; **Collabora Online (CODE)** draait als
render-engine op **Cloudflare Containers**, en de **media-api Worker** is de **WOPI-host**.

```
Browser ──POST /office/session──▶ media-api (WOPI-host)
   │                                  │  mint HMAC access_token + editor-URL (via discovery)
   ▼                                  ▼
iframe ◀───editor (POST access_token)── office-server Worker ──▶ Collabora container (:9980)
                                          Collabora ──GET/PUT /wopi/files/{id}?access_token──▶ media-api ──▶ R2
```

> **Status:** F0-PoC. De code typecheckt volledig (frontend + beide workers), maar is nog
> **niet gedeployed of end-to-end getest** — dat vereist jouw Cloudflare-account + het
> Workers Paid-plan. Werk de checklist hieronder af.

---

## 0. Vereisten

- **Workers Paid-plan** ($5/mnd) — vereist voor Containers.
- `wrangler` ingelogd op het juiste Cloudflare-account (`wrangler login`).
- **Regio/AVG:** Cloudflare Containers hebben géén regio-configuratie (platformbeperking — placement
  wordt door Cloudflare bepaald, kan afwijken van de Durable Object-locatie). Dit is acceptabel omdat
  de container alleen een tijdelijke werkkopie tijdens een actieve sessie vasthoudt, geen rustende
  data. De bestanden zelf (R2) hébben wel een harde EU-jurisdictie-optie, maar de huidige buckets zijn
  daar niet mee aangemaakt — zie het aparte, bewust uitgestelde migratieproject in het geheugen
  (`r2-eu-jurisdiction-migration-roadmap`) als dat later relevant wordt.

## 1. Config invullen (placeholders vervangen)

| Bestand | Placeholder | Waarde |
|---|---|---|
| `workers/office-server/src/index.ts` | `WOPI_HOST` | Publieke URL van de **media-api** Worker (bv. `https://resofly-media-api.<acct>.workers.dev`). **Authoritatief** (overschrijft de Dockerfile-ENV). |
| `workers/office-server/src/index.ts` | `FRAME_ANCESTORS` | App-origins die de editor mogen inbedden (staat al goed voor `app.resofly.nl` + staging). |
| `workers/media-api/wrangler.toml` | `COLLABORA_URL` (per env) | Publieke URL van de **office-server** Worker (stap 2 geeft die terug). |

## 2. Office-server (Collabora) deployen

```bash
cd workers/office-server
npm install
wrangler deploy            # productie   (voeg later --env staging toe indien gewenst)
```

Noteer de publieke URL uit de output → dat wordt `COLLABORA_URL` in `workers/media-api/wrangler.toml`.
Eerste build pusht het `collabora/code`-image (~1 GB) → duurt even.

## 3. media-api (WOPI-host) configureren + deployen

```bash
cd workers/media-api
# HMAC-secret voor de office-edit-tokens (genereer iets willekeurigs, 32+ tekens):
wrangler secret put MEDIA_SIGNING_SECRET --env production
wrangler secret put MEDIA_SIGNING_SECRET --env staging
# (optioneel) expliciete eigen publieke URL als host in de WOPISrc:
#   wrangler secret put MEDIA_PUBLIC_URL --env production   # of zet als [vars]
wrangler deploy --env production
```

> `MEDIA_SIGNING_SECRET` moet **identiek** zijn tussen deploys en mag nooit in de frontend
> belanden. Zonder deze secret weigeren alle `/office/*`- en `/wopi/*`-routes (HTTP 500).

## 4. Datamodel-migratie toepassen

```bash
supabase db push   # past 20260715010000_office_editing_attachments.sql toe
```
Voegt `edit_version`, `last_edited_by/at`, `locked_by/at` toe aan `attachments` (raakt de
`entity_type`-CHECK en integriteitstrigger **niet** — office-bestanden zijn `entity_type='folder'`).

## 5. Blanco sjablonen seeden (voor "+ Nieuw → Word/Excel/PowerPoint")

De nieuw-aanmaken-flow kopieert een leeg sjabloon uit R2. Seed die één keer per bucket.
Maak in echt Office (of LibreOffice) een leeg `blank.docx`, `blank.xlsx`, `blank.pptx` en:

```bash
# productie-bucket
wrangler r2 object put resofly-media-production/_office-templates/blank.docx --file blank.docx
wrangler r2 object put resofly-media-production/_office-templates/blank.xlsx --file blank.xlsx
wrangler r2 object put resofly-media-production/_office-templates/blank.pptx --file blank.pptx
# staging-bucket
wrangler r2 object put resofly-media-staging/_office-templates/blank.docx --file blank.docx
# …idem xlsx/pptx
```
(Zonder sjablonen werkt "bestaande bewerken" gewoon; alleen "+ Nieuw" geeft dan een nette 500.)

## 6. Frontend

Geen nieuwe env-vars — de frontend gebruikt de bestaande `VITE_R2_WORKER_URL` (media-api).
Deploy Pages zoals gebruikelijk. De code zit al in `ClientFolders` ("Openen in editor" +
"+ Nieuw").

---

## 7. Eerste-deploy-checklist — de bekende onzekerheden

Deze zijn per definitie pas op een echte deploy te bewijzen (zie ook het feasibility-verdict).
Loop ze in deze volgorde af:

1. **Collabora boot (jail/capabilities) — DE make-or-break.** CF Containers draaien zónder
   extra Linux-caps. Collabora's chroot-jail verwacht normaal `CAP_SYS_ADMIN`/`CAP_MKNOD`.
   We starten met `--o:mount_namespaces=false` (in `envVars` van `src/index.ts`), maar
   **die flag-keuze is zelf onzeker** — mogelijk selecteert hij juist de bind-mount-jail die
   óók caps vereist. Test in deze volgorde en check `wrangler tail`/container-logs:
   (a) zoals nu; (b) verwijder de `--o:mount_namespaces=false`-flag (default-modus); (c) lukt
   capability-loos booten met stock CODE niet, dan is dat het verwachte resultaat → gebruik de
   **Fly.io-terugval (§9)**, waar je wél `--cap-add SYS_ADMIN MKNOD` kunt zetten. Verwacht dat
   dit punt experimenteren vergt; de rest van de keten (WOPI-host, frontend) staat er los van.
2. **WebSocket-editing.** Het live-bewerken rijdt op een WS naar `:9980` via de Worker→DO.
   `Container.fetch()` forwardt WS automatisch, maar test dit expliciet: open een document,
   typ, en kijk of wijzigingen persistent zijn na sluiten.
3. **Discovery bereikbaar.** media-api haalt `${COLLABORA_URL}/hosting/discovery` op. Test:
   `curl https://<office-server>/hosting/discovery` moet XML met `urlsrc` geven.
4. **Host-matches.** `aliasgroup1` (office-server `envVars`) moet de media-api-host bevatten
   die in de **WOPISrc** verschijnt (`MEDIA_PUBLIC_URL` of het request-origin). Mismatch →
   Collabora weigert ("refusing WOPI host"). `frame_ancestors` moet de app-origin bevatten,
   anders blokkeert de browser het iframe (CSP).
5. **Sticky routing.** Alle sessies gaan naar één instance (`INSTANCE_ID`), dus een open
   document blijft op hetzelfde coolwsd-proces. Bij opschalen: routeren op document-id.
6. **Cold start.** Eerste open na inactiviteit kan traag zijn; `sleepAfter = '30m'` dempt dat.
7. **CODE-licentie.** De gratis CODE-build is bedoeld voor test/klein gebruik en kan
   watermerken/verbindingslimieten tonen. Voor productie-omvang: Collabora Online-abonnement.

## 8. Testscenario (na deploy)

1. Upload een `.docx` in een klantmap ("Bestanden").
2. Klik het bestand of kies "Openen in editor" → Collabora laadt in een volledig-scherm iframe.
3. Typ iets, wacht op autosave (of sluit) → PutFile schrijft naar R2.
4. Herlaad de drive → `edit_version` opgehoogd; download het bestand → wijziging zit erin.
5. Test "+ Nieuw → Word-document" → leeg document opent direct in de editor.

## 9. Terugvaloptie als CF Containers een muur blijkt

Als jail/caps of WS-proxying niet lukt, of warm-houden te duur is: verhuis **alleen de
render-engine** naar een host met persistente volumes + capabilities (**Fly.io** machine +
volume, of een kleine EU-VPS). De bestanden blijven op R2 en de media-api WOPI-host +
frontend blijven ongewijzigd — alleen `COLLABORA_URL` wijst dan naar de nieuwe host, en de
`aliasgroup`/`frame_ancestors` config verhuist mee naar de Collabora-container daar.
