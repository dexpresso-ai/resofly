-- ============================================================
-- ResoFly — beveiligingsronde 2026-09-26
--
-- Uitkomst van een volledige doorlichting (database, edge functions, workers,
-- frontend). Deze migratie dicht de gaten die in de database zelf zitten:
--
--   1. Billing-/licentiefuncties die alleen de service-role mag aanroepen,
--      stonden open voor anon en authenticated. Supabase zet met ALTER DEFAULT
--      PRIVILEGES een échte EXECUTE-grant op elke nieuwe functie; "revoke ...
--      from public" haalde die niet weg (zie ook 20260807020000 §7).
--   2. Anon hoort geen enkele security-definer-functie te kunnen aanroepen: de
--      publieke pagina's lopen via edge functions. Voor alle bestaande functies
--      ingetrokken; een test bewaakt dat nieuwe functies dicht beginnen.
--   3. organizations: alleen de naam is nog direct bij te werken; de
--      moederorganisatie (parent_organization_id) beheert uitsluitend de server.
--   4. Factuur-bewijstabellen (betaalrecords, verzendingen, workflow-events)
--      schrijft alleen de service-role; de oude schrijf-policies gaan weg.
--   5. Btw-aangifte: direct bijwerken mag alleen nog de status, en alleen
--      vooruit (vastgesteld → ingediend → betaald).
--   6. Contracten: een nieuw contract is altijd een concept, zonder
--      ondertekenlink of ondertekenbewijs; een link ontstaat alleen via de
--      verstuurflow.
--   7. Teamchat: deelnemersrijen en het soort gesprek liggen vast; bijlagen van
--      een chatbericht ziet alleen wie in dat gesprek zit.
--   8. Agenda-deelnemers en boekingstabellen: alleen de service-role schrijft.
--   9. Org-integriteit op koppelingen die dat nog misten.
--  10. Opslagsleutels (R2) moeten onder de map van de eigen organisatie liggen.
--  11. CalDAV: alleen actieve leden, met hun modulerecht op Agenda; app-
--      wachtwoorden vervallen zodra iemand uit het team gaat.
--  12. Oude, user-gebaseerde policy op company_settings opgeruimd.
--
-- Het patroon "current_user in ('authenticated','anon')" in de guards hieronder
-- is bewust: een security-definer-RPC draait als eigenaar (postgres) en een
-- edge function als service_role — alleen directe schrijfacties via de API met
-- een gebruikerstoken worden beperkt. De guard-functies zelf zijn daarom
-- SECURITY INVOKER.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Service-role-only functies: dicht voor anon én authenticated
-- ------------------------------------------------------------
do $$
declare
  v_sig text;
  v_proc regprocedure;
begin
  foreach v_sig in array array[
    'public.set_organization_billing_exempt(uuid, boolean)',
    'public.apply_organization_seat_change(uuid, text, integer, jsonb)',
    'public.activate_organization_subscription(uuid, text, text, text, text, text, jsonb)',
    'public.activate_organization_subscription(uuid, text, text, text, text, timestamptz, jsonb)',
    'public.record_organization_subscription_payment(uuid, text)',
    'public.record_organization_subscription_payment(uuid, text, timestamptz)',
    'public.apply_organization_storage_change(uuid, integer, jsonb)',
    'public.apply_organization_creative_change(uuid, boolean, integer, jsonb)',
    'public.apply_organization_business_change(uuid, boolean, integer, jsonb)',
    'public.apply_organization_license_purchase(uuid, integer, text, text, jsonb)',
    'public.apply_paid_organization_payment(text, text, jsonb)',
    'public.log_billing_audit(uuid, text, text, uuid, text, jsonb, uuid)',
    'public.ensure_organization_billing_profile(uuid)',
    'public.organization_used_license_count(uuid)',
    'public.pick_client_email_thread(uuid, uuid, text, timestamptz, text[])',
    'public.is_own_org_address(uuid, text)'
  ] loop
    v_proc := to_regprocedure(v_sig);
    continue when v_proc is null; -- overload bestaat (niet meer): niets te doen
    execute format('revoke all on function %s from public, anon, authenticated', v_proc);
    execute format('grant execute on function %s to service_role', v_proc);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. Anon: geen EXECUTE op security-definer-functies
--    Wie nu via authenticated of service_role mocht, blijft dat mogen — ook als
--    dat recht alleen via PUBLIC liep (de grant wordt dan expliciet gemaakt).
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_auth boolean;
  v_service boolean;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prokind = 'f'
      and p.prorettype <> 'trigger'::regtype
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    v_auth := has_function_privilege('authenticated', r.oid, 'EXECUTE');
    v_service := has_function_privilege('service_role', r.oid, 'EXECUTE');
    execute format('revoke execute on function %s from public, anon', r.sig);
    if v_auth then execute format('grant execute on function %s to authenticated', r.sig); end if;
    if v_service then execute format('grant execute on function %s to service_role', r.sig); end if;
  end loop;
end $$;

-- Nieuwe functies krijgen van Postgres nog steeds EXECUTE voor PUBLIC (een
-- globale default; die is per schema niet in te trekken, en globaal aanpassen
-- raakt ook extensies). Daarom bewaakt supabase/functions/_shared/
-- migrationGrants.test.ts dat elke security-definer-functie in een latere
-- migratie expliciet "revoke ... from public, anon" krijgt.

-- ------------------------------------------------------------
-- 3. organizations: moederorganisatie alleen via de server
-- ------------------------------------------------------------
-- De frontend werkt organizations nooit direct bij; alle wijzigingen lopen via
-- security-definer-RPC's (create_child_organization e.d.) of de service-role.
revoke update on public.organizations from anon, authenticated;
grant update (name) on public.organizations to authenticated;

create or replace function public.guard_organization_parent_client_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (tg_op = 'INSERT' and new.parent_organization_id is not null)
       or (tg_op = 'UPDATE' and new.parent_organization_id is distinct from old.parent_organization_id) then
      raise exception 'De organisatiestructuur wordt alleen door ResoFly zelf beheerd.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_parent_client_guard on public.organizations;
create trigger organizations_parent_client_guard
  before insert or update of parent_organization_id on public.organizations
  for each row execute function public.guard_organization_parent_client_write();

-- ------------------------------------------------------------
-- 4. Factuur-bewijstabellen: alleen de service-role schrijft
--    (de frontend leest ze alleen; zie selectInvoice*-functies in repository.ts)
-- ------------------------------------------------------------
drop policy if exists "invoice workflow events insert" on public.invoice_workflow_events;
drop policy if exists "invoice email deliveries insert" on public.invoice_email_deliveries;
drop policy if exists "invoice email deliveries update" on public.invoice_email_deliveries;
drop policy if exists "invoice payment records insert" on public.invoice_payment_records;
drop policy if exists "invoice payment records update" on public.invoice_payment_records;

-- Het opgeslagen Mollie-antwoord bevatte onze webhookUrl, mét het webhook-secret
-- erin, leesbaar voor elk lid met Financiën-leesrecht. De edge functions laten
-- hem voortaan weg; hier gaat hij ook uit de bestaande rijen. (Roteer daarna
-- MOLLIE_WEBHOOK_SECRET / INVOICE_MOLLIE_WEBHOOK_SECRET.)
update public.invoice_payment_records
   set metadata = metadata #- '{mollie,webhookUrl}'
 where metadata ? 'mollie'
   and jsonb_typeof(metadata -> 'mollie') = 'object'
   and (metadata -> 'mollie') ? 'webhookUrl';

-- ------------------------------------------------------------
-- 5. Btw-aangifte: direct alleen de status, en alleen vooruit
-- ------------------------------------------------------------
create or replace function public.guard_vat_return_client_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception 'Van een btw-aangifte kan alleen de status worden bijgewerkt.'
      using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not ((old.status = 'finalized' and new.status = 'filed')
           or (old.status = 'filed' and new.status = 'paid')) then
    raise exception 'Deze statuswijziging van de btw-aangifte is niet toegestaan.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists vat_returns_client_update_guard on public.vat_returns;
create trigger vat_returns_client_update_guard
  before update on public.vat_returns
  for each row execute function public.guard_vat_return_client_update();

-- ------------------------------------------------------------
-- 6. Contracten: aanmaken als concept, ondertekenlink alleen via de server
--    Aanvulling op enforce_contract_signed_immutability (die alleen UPDATE ziet).
-- ------------------------------------------------------------
create or replace function public.guard_contract_client_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'draft'
       or new.internal_approval_status is distinct from 'draft'
       or new.signed_at is not null
       or new.signed_document_sha256 is not null
       or new.signed_storage_provider is not null
       or new.signed_storage_key is not null
       or new.signed_pdf_file_name is not null
       or new.signed_pdf_size_bytes is not null
       or new.signed_pdf_data_base64 is not null
       or new.public_token_hash is not null
       or new.public_token_created_at is not null
       or new.public_token_expires_at is not null then
      raise exception 'Een nieuw contract begint altijd als concept, zonder ondertekenlink of ondertekenbewijs.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE: een link intrekken (leegmaken) mag, een nieuwe zetten niet.
  if (new.public_token_hash is distinct from old.public_token_hash and new.public_token_hash is not null)
     or (new.public_token_created_at is distinct from old.public_token_created_at and new.public_token_created_at is not null)
     or (new.public_token_expires_at is distinct from old.public_token_expires_at and new.public_token_expires_at is not null) then
    raise exception 'Een ondertekenlink wordt alleen via de verstuurflow aangemaakt.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_client_write_guard on public.contracts;
create trigger contracts_client_write_guard
  before insert or update on public.contracts
  for each row execute function public.guard_contract_client_write();

-- ------------------------------------------------------------
-- 7. Teamchat
-- ------------------------------------------------------------
-- Een eigen deelnemersrij bijwerken kon ook conversation_id en role raken (en
-- dus aanschuiven bij elk gesprek). last_read_at loopt via chat_mark_read().
drop policy if exists "chat part update own" on public.chat_participants;

create or replace function public.guard_chat_conversation_client_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.kind is distinct from old.kind
          or new.dm_key is distinct from old.dm_key
          or new.created_by is distinct from old.created_by
          or new.organization_id is distinct from old.organization_id) then
    raise exception 'Het soort gesprek en wie het begon, liggen vast.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_conversations_client_update_guard on public.chat_conversations;
create trigger chat_conversations_client_update_guard
  before update on public.chat_conversations
  for each row execute function public.guard_chat_conversation_client_update();

-- Bijlagen van een chatbericht: alleen voor deelnemers van dat gesprek (bovenop
-- de org- en modulepolicies op attachments).
drop policy if exists "attachments chat participants only" on public.attachments;
create policy "attachments chat participants only" on public.attachments
  as restrictive
  for all
  using (
    entity_type <> 'chat_message'
    or exists (
      select 1 from public.chat_messages m
      where m.id = attachments.entity_id
        and public.chat_is_participant(m.conversation_id)
    )
  )
  with check (
    entity_type <> 'chat_message'
    or exists (
      select 1 from public.chat_messages m
      where m.id = attachments.entity_id
        and public.chat_is_participant(m.conversation_id)
    )
  );

-- ------------------------------------------------------------
-- 8. Agenda-deelnemers en boekingstool: alleen de service-role schrijft
--    (alle echte toegang loopt via de edge functions; lezen blijft zoals het was)
-- ------------------------------------------------------------
drop policy if exists "calendar_event_attendees write" on public.calendar_event_attendees;
drop policy if exists "meeting_booking_links write" on public.meeting_booking_links;
drop policy if exists "meeting_booking_slots write" on public.meeting_booking_slots;
drop policy if exists "meeting_bookings write" on public.meeting_bookings;

-- ------------------------------------------------------------
-- 9. Org-integriteit op koppelingen die dat nog misten
-- ------------------------------------------------------------
create or replace function public.enforce_calendar_event_attendees_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.calendar_events', new.event_id, new.organization_id, 'calendar_event_attendees.event_id');
  return new;
end;
$$;

drop trigger if exists calendar_event_attendees_org_integrity on public.calendar_event_attendees;
create trigger calendar_event_attendees_org_integrity
  before insert or update of organization_id, event_id on public.calendar_event_attendees
  for each row execute function public.enforce_calendar_event_attendees_org_integrity();

create or replace function public.enforce_meeting_booking_links_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'meeting_booking_links.client_id');
  perform public.assert_same_org_reference('public.calendar_sources', new.source_id, new.organization_id, 'meeting_booking_links.source_id');
  return new;
end;
$$;

drop trigger if exists meeting_booking_links_org_integrity on public.meeting_booking_links;
create trigger meeting_booking_links_org_integrity
  before insert or update of organization_id, client_id, source_id on public.meeting_booking_links
  for each row execute function public.enforce_meeting_booking_links_org_integrity();

create or replace function public.enforce_meeting_recordings_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'meeting_recordings.client_id');
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'meeting_recordings.project_id');
  perform public.assert_same_org_reference('public.calendar_sources', new.source_id, new.organization_id, 'meeting_recordings.source_id');
  perform public.assert_same_org_reference('public.client_calls', new.call_id, new.organization_id, 'meeting_recordings.call_id');
  return new;
end;
$$;

drop trigger if exists meeting_recordings_org_integrity on public.meeting_recordings;
create trigger meeting_recordings_org_integrity
  before insert or update of organization_id, client_id, project_id, source_id, call_id on public.meeting_recordings
  for each row execute function public.enforce_meeting_recordings_org_integrity();

create or replace function public.enforce_client_email_threads_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'client_email_threads.client_id');
  return new;
end;
$$;

drop trigger if exists client_email_threads_org_integrity on public.client_email_threads;
create trigger client_email_threads_org_integrity
  before insert or update of organization_id, client_id on public.client_email_threads
  for each row execute function public.enforce_client_email_threads_org_integrity();

-- ------------------------------------------------------------
-- 10. Opslagsleutels horen onder de map van de eigen organisatie
--     Alle sleutels die de app aanmaakt beginnen met "<organization_id>/". Een rij
--     mag dus nooit naar het object van een andere organisatie wijzen — de
--     workers en edge functions lezen die sleutel met de service-role. Bij een
--     UPDATE toetsen we alleen een gewijzigde sleutel, zodat oude rijen gewoon
--     bewerkbaar blijven.
-- ------------------------------------------------------------
create or replace function public.enforce_storage_keys_in_org()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_col text;
  v_key text;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_prefix text := new.organization_id::text || '/';
begin
  foreach v_col in array tg_argv loop
    v_key := v_new ->> v_col;
    continue when v_key is null or v_key = '';
    continue when tg_op = 'UPDATE'
      and v_key is not distinct from (v_old ->> v_col)
      and new.organization_id is not distinct from old.organization_id;
    if left(v_key, length(v_prefix)) <> v_prefix or position('..' in v_key) > 0 then
      raise exception 'Opslagsleutel %.% hoort niet bij deze organisatie.', tg_table_name, v_col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists attachments_storage_key_in_org on public.attachments;
create trigger attachments_storage_key_in_org
  before insert or update on public.attachments
  for each row execute function public.enforce_storage_keys_in_org('storage_key');

drop trigger if exists documents_storage_key_in_org on public.documents;
create trigger documents_storage_key_in_org
  before insert or update on public.documents
  for each row execute function public.enforce_storage_keys_in_org('storage_key');

drop trigger if exists contracts_storage_key_in_org on public.contracts;
create trigger contracts_storage_key_in_org
  before insert or update on public.contracts
  for each row execute function public.enforce_storage_keys_in_org('body_storage_key', 'signed_storage_key');

drop trigger if exists gallery_items_storage_key_in_org on public.gallery_items;
create trigger gallery_items_storage_key_in_org
  before insert or update on public.gallery_items
  for each row execute function public.enforce_storage_keys_in_org('storage_key', 'preview_key', 'thumb_key');

drop trigger if exists galleries_storage_key_in_org on public.galleries;
create trigger galleries_storage_key_in_org
  before insert or update on public.galleries
  for each row execute function public.enforce_storage_keys_in_org('cover_preview_key', 'cover_thumb_key');

drop trigger if exists meeting_recordings_storage_key_in_org on public.meeting_recordings;
create trigger meeting_recordings_storage_key_in_org
  before insert or update on public.meeting_recordings
  for each row execute function public.enforce_storage_keys_in_org('storage_key');

-- ------------------------------------------------------------
-- 11. CalDAV: alleen actieve leden, met hun recht op de module Agenda
-- ------------------------------------------------------------
-- De kolom role is de rol zoals de CalDAV-Worker die gebruikt: heeft iemand op
-- Agenda alleen leesrecht, dan geeft de lookup 'viewer' terug. Zo schrijft ook
-- een nog niet bijgewerkte Worker niet meer namens een alleen-lezen lid.
-- calendar_level is het effectieve niveau (spiegel van org_module_level).
drop function if exists public.caldav_lookup_app_passwords(text);

create function public.caldav_lookup_app_passwords(p_email text)
returns table (id uuid, user_id uuid, organization_id uuid, salt text, password_hash text, role text, calendar_level text)
language sql
security definer
set search_path = public, auth
as $$
  select ap.id, ap.user_id, ap.organization_id, ap.salt, ap.password_hash,
         case when lvl.cal_level = 'write' then m.role else 'viewer' end as role,
         lvl.cal_level as calendar_level
  from public.calendar_app_passwords ap
  join auth.users u on u.id = ap.user_id
  join public.organization_members m
    on m.organization_id = ap.organization_id
    and m.user_id = ap.user_id
    and m.status = 'active'
  cross join lateral (
    select case
      when m.role in ('owner', 'admin') then 'write'
      when m.role = 'viewer' then
        case when coalesce(nullif(m.module_access ->> 'calendar', ''), 'write') = 'none' then 'none' else 'read' end
      else coalesce(nullif(m.module_access ->> 'calendar', ''), 'write')
    end as cal_level
  ) lvl
  where ap.revoked_at is null
    and lvl.cal_level <> 'none'
    and lower(u.email) = lower(trim(coalesce(p_email, '')))
    and coalesce(trim(p_email), '') <> '';
$$;

revoke all on function public.caldav_lookup_app_passwords(text) from public, anon, authenticated;
grant execute on function public.caldav_lookup_app_passwords(text) to service_role;

-- App-wachtwoorden vervallen zodra het lidmaatschap stopt (uitgeschakeld of
-- verwijderd). Weer actief worden geeft ze niet terug: dan maakt iemand een nieuw.
create or replace function public.revoke_app_passwords_on_member_exit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    update public.calendar_app_passwords
       set revoked_at = now()
     where user_id = old.user_id
       and organization_id = old.organization_id
       and revoked_at is null;
    return old;
  end if;
  if old.status = 'active' and new.status is distinct from 'active' then
    update public.calendar_app_passwords
       set revoked_at = now()
     where user_id = new.user_id
       and organization_id = new.organization_id
       and revoked_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.revoke_app_passwords_on_member_exit() from public, anon, authenticated;

drop trigger if exists organization_members_revoke_app_passwords on public.organization_members;
create trigger organization_members_revoke_app_passwords
  after update of status or delete on public.organization_members
  for each row execute function public.revoke_app_passwords_on_member_exit();

-- ------------------------------------------------------------
-- 12. Oude user-gebaseerde policy op company_settings (20260427000000)
--     De org-policies ("company settings read/insert/update/delete") dekken alles.
-- ------------------------------------------------------------
drop policy if exists "own company settings" on public.company_settings;

commit;
