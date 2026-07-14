-- ============================================================
-- ResoFly — Fix: attachments-integriteitstrigger kent chat_message niet
-- Date: 2026-07-14
--
-- Symptoom:
-- In de teamchat mislukt het uploaden van bijlagen. Het bericht verstuurt wél,
-- het bestand wordt wél naar R2 geschreven, maar de bijlage verschijnt niet en
-- de composer meldt "… bestand(en) kon niet worden geüpload."
--
-- Oorzaak:
-- De CHECK-constraint op attachments.entity_type is in latere migraties stap
-- voor stap uitgebreid (document → folder → supplier/purchase_invoice →
-- fixed_asset → chat_message). De BEGELEIDENDE validatietrigger
-- enforce_attachments_org_integrity() is echter NOOIT meegegroeid: die kent
-- alleen de acht oorspronkelijke types (client, project, task, subtask, ticket,
-- note, quote, invoice) en gooit voor al het andere:
--     else raise exception 'Onbekend attachments.entity_type: %'  (errcode 23514)
--
-- Daardoor faalt de INSERT van een bijlage met entity_type='chat_message' in de
-- BEFORE-INSERT-trigger — ná de R2-upload. src/lib/r2.ts vangt de fout, ruimt het
-- R2-object weer op en gooit door; src/lib/chat.ts telt dit als failedUpload.
--
-- Fix:
-- Herdefinieer de functie autoritair met een tak voor ELK entity_type dat de
-- huidige CHECK toestaat (incl. chat_message → public.chat_messages). Idempotent
-- (create or replace): dit corrigeert meteen eventuele hand-patches die eerder
-- buiten de migratiehistorie op staging/productie zijn toegepast om document/
-- folder/boekhoud-bijlagen werkend te krijgen, en trekt de trigger gelijk met de
-- CHECK. De `else raise` blijft als vangnet voor werkelijk onbekende types.
--
-- De validatie per type volgt public.assert_same_org_reference(): entity_id moet
-- bestaan in de doeltabel binnen dezelfde organisatie (null → no-op).
-- ============================================================

begin;

create or replace function public.enforce_attachments_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.tasks', new.parent_task_id, new.organization_id, 'attachments.parent_task_id');

  case new.entity_type
    when 'client' then perform public.assert_same_org_reference('public.clients', new.entity_id, new.organization_id, 'attachments.entity_id(client)');
    when 'project' then perform public.assert_same_org_reference('public.projects', new.entity_id, new.organization_id, 'attachments.entity_id(project)');
    when 'task' then perform public.assert_same_org_reference('public.tasks', new.entity_id, new.organization_id, 'attachments.entity_id(task)');
    when 'subtask' then
      if new.parent_task_id is null then
        raise exception 'attachments.parent_task_id is verplicht voor subtask attachments' using errcode = '23514';
      end if;
      perform public.assert_same_org_reference('public.tasks', new.parent_task_id, new.organization_id, 'attachments.parent_task_id');
      if not exists (
        select 1 from public.tasks t
        where t.id = new.parent_task_id
          and t.organization_id = new.organization_id
          and t.subtasks @> jsonb_build_array(jsonb_build_object('id', new.entity_id::text))
      ) then
        raise exception 'attachments.entity_id(subtask) verwijst niet naar een bestaande subtaak op parent_task_id' using errcode = '23514';
      end if;
    when 'ticket' then perform public.assert_same_org_reference('public.tickets', new.entity_id, new.organization_id, 'attachments.entity_id(ticket)');
    when 'note' then perform public.assert_same_org_reference('public.notes', new.entity_id, new.organization_id, 'attachments.entity_id(note)');
    when 'document' then perform public.assert_same_org_reference('public.documents', new.entity_id, new.organization_id, 'attachments.entity_id(document)');
    when 'quote' then perform public.assert_same_org_reference('public.quotes', new.entity_id, new.organization_id, 'attachments.entity_id(quote)');
    when 'invoice' then perform public.assert_same_org_reference('public.invoices', new.entity_id, new.organization_id, 'attachments.entity_id(invoice)');
    when 'folder' then perform public.assert_same_org_reference('public.content_folders', new.entity_id, new.organization_id, 'attachments.entity_id(folder)');
    when 'supplier' then perform public.assert_same_org_reference('public.suppliers', new.entity_id, new.organization_id, 'attachments.entity_id(supplier)');
    when 'purchase_invoice' then perform public.assert_same_org_reference('public.purchase_invoices', new.entity_id, new.organization_id, 'attachments.entity_id(purchase_invoice)');
    when 'fixed_asset' then perform public.assert_same_org_reference('public.fixed_assets', new.entity_id, new.organization_id, 'attachments.entity_id(fixed_asset)');
    when 'chat_message' then perform public.assert_same_org_reference('public.chat_messages', new.entity_id, new.organization_id, 'attachments.entity_id(chat_message)');
    else raise exception 'Onbekend attachments.entity_type: %', new.entity_type using errcode = '23514';
  end case;
  return new;
end; $$;

commit;
