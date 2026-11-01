-- ============================================================
-- ResoFly — Wie boekte, is wie er boekte; chatleden toevoegen vraagt schrijfrecht
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt T).
--
--   1. BOEKINGEN. post_journal_entry, reverse_journal_entry,
--      import_bank_transactions en de book_*-functies nemen p_created_by van
--      de aanroeper over. Wie mocht boeken, zette zo een boeking (en de
--      gebruiker in het XAF-auditbestand) op naam van een collega. Nu zet een
--      trigger de maker: is er een ingelogde gebruiker (auth.uid(), ook binnen
--      een security-definer-functie), dan is die het. De service-role en
--      pg_cron (geen gebruiker) houden wat de functie meegaf.
--   2. TEAMCHAT. chat_add_participants vroeg alleen dat je deelnemer was, ook
--      voor een oud-teamlid of een viewer. Nu ook schrijfrecht op Teamchat (en
--      daarmee een actief lidmaatschap).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De maker van een boeking ────────────────────────────────────────────

create or replace function public.stamp_journal_entry_actor()
returns trigger
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := v_uid;
    if new.posted_by is not null then new.posted_by := v_uid; end if;
  else
    new.created_by := old.created_by;
    if new.posted_by is distinct from old.posted_by and new.posted_by is not null then
      new.posted_by := v_uid;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_journal_entry_actor() from public, anon, authenticated;

drop trigger if exists journal_entries_stamp_actor on public.journal_entries;
create trigger journal_entries_stamp_actor
  before insert or update of created_by, posted_by on public.journal_entries
  for each row execute function public.stamp_journal_entry_actor();

create or replace function public.stamp_bank_statement_actor()
returns trigger
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := v_uid;
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_bank_statement_actor() from public, anon, authenticated;

drop trigger if exists bank_statements_stamp_actor on public.bank_statements;
create trigger bank_statements_stamp_actor
  before insert or update of created_by on public.bank_statements
  for each row execute function public.stamp_bank_statement_actor();

-- ── 2. Chatleden toevoegen vraagt schrijfrecht op Teamchat ─────────────────
--
-- Ongewijzigd op de controle na het soort gesprek na.

create or replace function public.chat_add_participants(p_conversation_id uuid, p_user_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_me uuid := auth.uid();
  v_org uuid;
  v_kind text;
  v_added uuid[];
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if not public.chat_is_participant(p_conversation_id) then
    raise exception 'chat: geen deelnemer';
  end if;
  select organization_id, kind into v_org, v_kind
    from public.chat_conversations where id = p_conversation_id;
  if v_kind not in ('group', 'channel') then
    raise exception 'chat: leden toevoegen kan alleen bij een groepschat of kanaal';
  end if;
  -- Alleen een actief teamlid met schrijfrecht op Teamchat: deelnemer zijn
  -- alleen was genoeg, ook voor een oud-teamlid of een viewer.
  if not public.can_write_module(v_org, 'chat') then
    raise exception 'chat: je mag niets wijzigen in de module Teamchat' using errcode = '42501';
  end if;

  with added as (
    insert into public.chat_participants (conversation_id, organization_id, user_id, role)
    select p_conversation_id, v_org, m.user_id, 'member'
      from public.organization_members m
     where m.organization_id = v_org
       and m.status = 'active'
       and m.user_id = any(coalesce(p_user_ids, '{}'::uuid[]))
       and public.member_module_level(m.role, m.module_access, 'chat') <> 'none'
    on conflict do nothing
    returning user_id
  )
  select array_agg(user_id) into v_added from added;

  if v_added is not null and array_length(v_added, 1) > 0 then
    perform public.chat_system_message(p_conversation_id, 'members_added', jsonb_build_object('user_ids', to_jsonb(v_added)));
  end if;
end;
$$;

revoke all on function public.chat_add_participants(uuid, uuid[]) from public, anon;
grant execute on function public.chat_add_participants(uuid, uuid[]) to authenticated, service_role;

commit;
