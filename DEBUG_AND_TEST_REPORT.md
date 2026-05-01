# BrandCore v1.5.1 — debug & hardening report

Datum: 27 april 2026

## Aangepakt in deze ronde

1. **Subtask attachment cleanup volledig gemaakt**
   - `deleteEntityCascade()` ruimt nu niet alleen entity-bijlagen op, maar ook latent ondersteunde `subtask`-bijlagen via `parent_task_id`.
   - Bij verwijderen van een taak worden zowel task-attachments als subtask-attachments verwijderd.
   - Bij verwijderen van een project worden ook attachments van alle cascading child tasks én hun subtasks verwijderd.
   - Duplicaten worden veilig gededuped voordat R2/DB delete wordt uitgevoerd.

2. **Cloudflare Worker subtask-autorisatie aangescherpt**
   - Voor `entity_type = subtask` controleert de Worker nu niet alleen of de parent task van de gebruiker is.
   - De Worker controleert ook of `x-entity-id` daadwerkelijk voorkomt als subtask-id in de `subtasks` JSON van die parent task.
   - Daardoor kan een client niet zomaar een willekeurige subtask-id onder een eigen task claimen.

3. **Supabase datalaag verder verhard**
   - `enforce_attachments_tenant_integrity()` controleert voor subtask attachments nu expliciet of de subtask-id bestaat in de parent task JSON.
   - Nieuwe migratie toegevoegd: `supabase/migrations/20260427_debug_hardening_subtask_and_conversion.sql`.
   - Nieuwe indexen toegevoegd voor relationele lookup-performance op notes, quotes, invoices en subtask parent cleanup.

4. **Ticket → project conversie sterker gemaakt tegen race conditions**
   - RPC `convert_ticket_to_project()` lockt de ticketrij nu met `for update`.
   - Dubbele conversie wordt geblokkeerd op zowel `status = converted` als `converted_to_project_id is not null`.
   - Backend staat conversie alleen nog toe vanuit `new`, `review` of `approved`.
   - De update naar ticketstatus filtert nu ook expliciet op `user_id = auth.uid()`.

5. **Ticketmodal UX consistent gemaakt**
   - Bij een reeds geconverteerd ticket is het statusveld read-only.
   - De status `Omgezet` wordt dan wel zichtbaar getoond, maar blijft niet handmatig instelbaar.

## Uitgevoerde checks in deze container

- ✅ Codebase uitgepakt en volledige relevante source geïnspecteerd.
- ✅ Gerichte diff-review uitgevoerd op gewijzigde bestanden.
- ✅ TypeScript/TSX syntax-transpile uitgevoerd op 22 sourcebestanden via de TypeScript compiler API: geen syntax/transpile fouten.
- ✅ SQL-inhoudelijke checks uitgevoerd op de nieuwe schema/migratie-patronen:
  - ticket row lock aanwezig;
  - rejected/converted backend-conversie geblokkeerd;
  - subtask JSON-id validatie aanwezig;
  - parent_task index aanwezig.
- ✅ `npm ci --offline` getest: faalt verwacht doordat de npm-cache niet compleet is.
- ⚠️ Volledige `npm run typecheck` en `npm run build` konden in deze container niet bewezen worden, omdat dependencies niet geïnstalleerd konden worden. De beschikbare registry gaf een credential/cache fout. Draai deze twee commando’s nog lokaal/CI met normale npm-toegang.

## Bestanden gewijzigd

- `src/lib/repository.ts`
- `cloudflare-worker/worker.ts`
- `src/main.tsx`
- `supabase/schema.sql`
- `supabase/migrations/20260427_debug_hardening_subtask_and_conversion.sql`
- `package.json`
- `README.md`
- `DEBUG_AND_TEST_REPORT.md`

## Staging testadvies

1. Draai lokaal of in CI:
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
2. Draai in Supabase de nieuwe migratie `20260427_debug_hardening_subtask_and_conversion.sql` na de bestaande hardening migratie.
3. Test met twee gebruikers:
   - user A kan geen client/project/task/attachment van user B koppelen;
   - subtask attachment met verkeerde `parent_task_id` wordt geweigerd;
   - subtask attachment met parent task maar niet-bestaande subtask-id wordt geweigerd;
   - ticketconversie vanuit `rejected` wordt backendmatig geweigerd;
   - dubbele ticketconversie maakt geen tweede project aan.
4. Test delete-cleanup:
   - task verwijderen ruimt task- en subtask-attachments op;
   - project verwijderen ruimt project-, task- en subtask-attachments op.
