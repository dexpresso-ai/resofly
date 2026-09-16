-- ============================================================
-- ResoFly — Een melding zodra een gekoppelde AI iets klaarzet (MCP)
-- Date: 2026-09-17
--
-- Aanleiding:
-- Een klant vraagt zijn AI "stuur Jansen een herinnering". Die AI zet het
-- keurig klaar in de goedkeurwachtrij en zegt dat erbij. Maar de klant zit
-- misschien op zijn telefoon, in een andere app, en vergeet het. Dan staat
-- er een herinnering te wachten die nooit uitgaat — en de klant denkt dat hij
-- verstuurd is, want hij heeft er zelf om gevraagd.
--
-- Dus: een push naar de eigenaar van de koppeling, op het moment dat het
-- voorstel binnenkomt. Eén tik en hij staat op zijn wachtrij.
--
-- WIE KRIJGT HEM. Alleen degene wiens AI het klaarzette — niet het hele team.
-- De andere pushmeldingen (nieuw ticket, klantmail) gaan wél naar iedereen,
-- maar die gaan over iets wat van buiten komt en waar iemand op moet reageren.
-- Dit gaat over iets wat de gebruiker zelf net in gang zette, in een gesprek
-- dat hij nu voert. Zou het hele team er een melding van krijgen, dan pingt
-- iedereen bij elke vraag die iemand aan zijn AI stelt — en zet iedereen het
-- na een week uit. De wachtrij op het startscherm is en blijft van het team;
-- dit belletje is persoonlijk.
--
-- Vier plekken in één wijziging, net als bij decision_digest: beide CHECKs
-- hier, en PushEventType + PUSH_EVENTS in src/lib/push-api.ts.
-- mcpCatalog.test.ts bewaakt dat ze gelijk blijven.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Het nieuwe push-type in beide CHECKs ─────────────────────────────────
-- Dezelfde truc als in 20260914000000: de bestaande constraint opzoeken op
-- inhoud (de naam is niet gegarandeerd) en vervangen door de volledige lijst.
do $$
declare c record;
begin
  for c in
    select conname, conrelid::regclass as tbl
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.notification_outbox'::regclass, 'public.notification_preferences'::regclass)
       and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;
alter table public.notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal'));
alter table public.notification_preferences add constraint notification_preferences_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal'));

-- ── 2. De trigger op het auditlog ───────────────────────────────────────────
--
-- Op de INSERT van het voorstel, niet in de edge function. Zo maakt het niet
-- uit langs welke weg een MCP-voorstel ooit binnenkomt: de melding hangt aan
-- de rij, niet aan de code die hem schreef.
create or replace function public.push_on_mcp_proposal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_label   text;
  v_title   text;
begin
  -- Alleen een VOORSTEL van een KOPPELING. Opvragingen (executed/failed) en
  -- voorstellen van Gerrie zelf (geen mcp_grant_id) horen hier niet.
  if new.mcp_grant_id is null or new.status is distinct from 'proposed' then
    return null;
  end if;

  begin
    select g.user_id, g.label into v_user_id, v_label
      from public.mcp_grants g
     where g.id = new.mcp_grant_id;
    if v_user_id is null then return null; end if;

    v_title := coalesce(nullif(btrim(new.params->>'title'), ''), 'Een voorstel wacht op je akkoord');

    perform public.push_enqueue(
      new.organization_id, 'mcp_proposal',
      array[v_user_id],
      jsonb_build_object(
        'title', coalesce(nullif(btrim(v_label), ''), 'Je AI') || ' heeft iets klaargezet',
        'body',  v_title,
        'url',   '/',
        -- Eén tag per koppeling: drie voorstellen achter elkaar worden één
        -- melding die zichzelf bijwerkt, geen drie losse pings.
        'tag',   'mcp:' || new.mcp_grant_id::text));
  exception when others then
    -- Een melding die niet wegkomt mag het voorstel zelf nooit tegenhouden.
    raise warning 'push_on_mcp_proposal: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists push_mcp_proposal_insert on public.ai_action_audit;
create trigger push_mcp_proposal_insert after insert on public.ai_action_audit
  for each row execute function public.push_on_mcp_proposal();

commit;
