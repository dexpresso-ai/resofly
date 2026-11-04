# BrandCore technische review v1.2

## Uitgevoerde checks

- ✅ `npm install` — alle dependencies geïnstalleerd
- ✅ `npm run typecheck` — geen errors
- ✅ `npm run build` — productie build succesvol (1947 modules, 13s)
- ✅ Statische review van Supabase tabelcontracten vs frontend payloads
- ✅ Statische review van R2 upload/download/delete flow
- ✅ Statische review van Cloudflare Worker security (CORS, auth, key prefix, size limit)

## Build output

```
dist/index.html                            0.55 kB │ gzip:   0.37 kB
dist/assets/index-*.css                   15.98 kB │ gzip:   3.50 kB
dist/assets/index-*.js                   789.94 kB │ gzip: 242.65 kB
```

De grote main bundle wordt veroorzaakt door jsPDF en html2canvas. Voor productie-optimalisatie kan `lib/pdf.ts` met dynamic import worden geladen pas wanneer een gebruiker daadwerkelijk PDF exporteert.

## Gefixte issues t.o.v. v1.1

### Veiligheid / Worker
1. CORS terugval op origin-reflection bij lege `ALLOWED_ORIGIN` is verwijderd. Empty config = geen CORS-header (browser blokkeert).
2. `ALLOWED_ORIGIN` accepteert nu een comma-separated lijst voor multi-origin setups (dev + prod parallel).
3. `isUuidLike` regex was te lek (matchte ook `--------------------`). Vervangen door echte UUID v1-5 regex.
4. Geen file size limit in de Worker — toegevoegd: 25 MB cap met stream-truncation die liegende `Content-Length` headers afvangt.

### Race conditions / consistentie
5. Auth listener dubbele `refresh()` opgelost via `loadedForUserRef` ref-tracking.
6. `convertTicketToProject` is nu atomair via Postgres RPC `convert_ticket_to_project`. Geen orphan-projecten meer bij partial failure.
7. `removeCurrent` heeft nu try/catch + loading + error handling (was eerder zonder).
8. Cascade-delete: bij verwijderen van entity worden bijhorende attachments uit R2 + DB opgeruimd. Volgorde: DB-row eerst, R2 best-effort, voorkomt UI-ghosts.

### Type safety / build
9. `saveEdit` herschreven naar een `switch` (was losse `if`-statements zonder `else`).
10. `package.json` versies van `"latest"` naar gepinde ranges. `vite` en `@vitejs/plugin-react` verhuisd naar `devDependencies`.
11. `vite.config.ts` toegevoegd met react plugin en port config.

### Functionaliteit
12. **Bijlagenbeheer UI** — `AttachmentList` toont per entity bestaande bijlagen met grootte, mime-type, download- en delete-knop. Toegevoegd aan álle modals (client/project/task/ticket/note/quote/invoice).
13. **Weekplanner** — was placeholder, nu volledig functioneel met drag-and-drop tussen dagen, "Niet ingepland" sectie, weeknavigatie en ISO weeknummer.
14. **PDF-export** — was niet aanwezig, nu beschikbaar via knop in modal én download-icoon per rij in offertes/facturen lijst. Genereert nette A4 PDF met header-band, klantblok, lijntabel, totalen en notities.
15. **Download flow** — gebruikt public URL als geconfigureerd, anders authenticated blob-download via Worker.
16. `FileUpload`: input wordt na upload gereset, zodat hetzelfde bestand opnieuw geüpload kan worden.

### Schema
17. `convert_ticket_to_project(uuid)` RPC toegevoegd. Doet RLS-check via `auth.uid()`, gooit errcodes bij niet-gevonden / al omgezet, returnt het project. Alleen `authenticated` heeft execute rechten.

## Niet getest

- End-to-end test tegen echte Supabase + Cloudflare omgeving (vereist credentials).
- PDF-rendering visueel: typecheck en build slagen, maar het uiteindelijke PDF-uiterlijk vereist handmatige inspectie.
- Drag-and-drop op touchscreens (native HTML5 DnD heeft daar bekende beperkingen).

## Aanbevelingen vervolg

- Dynamic import voor `lib/pdf.ts` om de initial bundle te halveren.
- Mailverzending van offerte/factuur (Resend / Postmark integratie).
- Touch-vriendelijke DnD library als de weekplanner mobiel intensief wordt gebruikt.
- Logo-upload in instellingen, gebruikt door PDF-header.

---

# Aanvullende testnotitie v1.5.1 — 27 april 2026

## Extra gecontroleerd

- ✅ `src/lib/repository.ts`: delete cascade ruimt nu ook subtask attachments op bij task/project delete.
- ✅ `cloudflare-worker/worker.ts`: subtask uploads vereisen parent task ownership én bestaande subtask-id in de parent task JSON.
- ✅ `supabase/schema.sql`: subtask attachment trigger valideert parent task en subtask-id.
- ✅ `supabase/migrations/20260427_debug_hardening_subtask_and_conversion.sql`: migratie toegevoegd voor bestaande omgevingen.
- ✅ `convert_ticket_to_project`: row lock, status-guard en dubbele-conversieguard toegevoegd.
- ✅ TS/TSX syntax-transpile op 22 sourcebestanden: geen fouten.

## Niet volledig uitvoerbaar in deze container

- `npm ci`, `npm run typecheck` en `npm run build` konden niet volledig worden bewezen door registry/cache/credential beperkingen in de omgeving. Voer deze checks nog uit in je eigen lokale omgeving of CI.
