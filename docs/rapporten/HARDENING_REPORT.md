# BrandCore CRM hardening report

Datum: 26 april 2026

## Aangepakt

1. PDF security dependency risico verwijderd
   - `jspdf` en `jspdf-autotable` zijn uit `package.json` gehaald.
   - `src/lib/pdf.ts` gebruikt nu een kleine dependency-free PDF exporter.
   - Dit voorkomt de eerder genoemde npm-audit findings op deze PDF-keten en verlaagt de initiële bundle.

2. Projectarchief compleet gemaakt
   - Projecten kunnen nu via de projectmodal worden gearchiveerd.
   - Gearchiveerde projecten verdwijnen uit de normale sidebar.
   - Archiefpagina toont lege staat, open-knop en herstel-knop.
   - Projectpagina toont een archiefbadge en blokkeert nieuwe taken bij gearchiveerde projecten.

3. Ticketconversie UX veiliger gemaakt
   - “Project maken” is alleen actief voor tickets met status `new`, `review` of `approved` zonder bestaande `converted_to_project_id`.
   - `converted` en `rejected` tickets tonen geen actieve conversieknop meer.
   - Backend-RPC blijft leidend voor atomaire conversie.

4. Finance statussen aangevuld
   - De formulierselectie ondersteunt nu ook `expired`, `overdue` en `cancelled` naast de bestaande statussen.

5. Worker upload-autorisatie aangescherpt
   - De Cloudflare Worker controleert vóór R2-upload of de opgegeven entity bestaat én bij de ingelogde gebruiker hoort via Supabase REST.
   - Voor `subtask` uploads moet een geldige `x-parent-task-id` worden meegegeven en wordt de parent task gecontroleerd.
   - Upload naar willekeurige of niet-eigen entity-id’s wordt nu geweigerd met 403.

## Checks uitgevoerd in deze container

- Codebase uitgepakt en testoverzicht verwerkt.
- Gerichte code-review op aangepaste modules uitgevoerd.
- Statische TypeScript syntax-check gestart op gewijzigde bestanden. Omdat dependencies niet lokaal geïnstalleerd konden worden in deze container, ontstaan verwachte module-resolutie errors op React/Supabase/lucide. Er zijn geen extra syntaxmeldingen uit de aangepaste code naar voren gekomen vóór deze dependency-errors.
- `npm install` kon in deze omgeving niet worden afgerond binnen de beschikbare runtime; daardoor is er geen volledige Vite productiebuild met node_modules bewezen.

## Nog live te testen in staging

- Supabase login en CRUD met twee testgebruikers.
- RLS-isolatie tussen user A en user B.
- R2 upload/download/delete op alle entitytypes.
- Worker entity-ownership-check met eigen en niet-eigen entity-id.
- Ticketconversie, inclusief dubbele conversiepoging.
- PDF download visueel controleren op lange regels en opmaak.

---

# Aanvullende hardening v1.5.1 — 27 april 2026

## Extra fixes

1. **Subtask attachment cleanup**
   - `deleteEntityCascade()` ruimt nu ook `entity_type = subtask` attachments op via `parent_task_id`.
   - Dit geldt voor directe task delete én project delete waarbij child tasks cascaden.

2. **Subtask attachment autorisatie**
   - De Worker valideert nu of de subtask-id daadwerkelijk voorkomt in de `subtasks` JSON van de opgegeven parent task.
   - De Supabase trigger doet dezelfde check database-side.

3. **Ticketconversie race-condition bescherming**
   - `convert_ticket_to_project()` gebruikt nu `for update` op de ticketrij.
   - Conversie wordt backendmatig alleen toegestaan voor `new`, `review` en `approved`.
   - Reeds geconverteerde tickets worden geblokkeerd op zowel status als `converted_to_project_id`.

4. **Relationele indexen aangevuld**
   - Indexen toegevoegd voor notes/quotes/invoices relaties en attachment cleanup via `parent_task_id`.

## Validatie

- TS/TSX syntax-transpile via TypeScript compiler API: geslaagd.
- SQL patroonchecks op nieuwe hardening: geslaagd.
- Volledige npm build: niet uitgevoerd in deze container wegens dependency-installatiebeperking.
