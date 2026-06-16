-- ResoFly: automatische, getrapte betalingsherinneringen voor te late facturen.
--
-- Context:
-- De factuur-verzendflow (invoice-workflow Edge Function → Resend → delivery-
-- tracking → PDF-snapshot → publieke link → optionele Mollie-betaallink) bestaat
-- al, maar er volgt niets op zodra een factuur te laat is. De status 'overdue'
-- bestaat in het enum maar werd nergens gezet. Deze migratie voegt toe:
--   1. Reminder-tracking op de factuur (niveau, laatste moment, pauze).
--   2. Een delivery_kind zodat herinneringen los van de oorspronkelijke
--      verzending traceerbaar zijn in invoice_email_deliveries.
--   3. Per-organisatie instellingen (aan/uit, offset-dagen per niveau, betaallink).
--   4. RPC's: mark_invoices_overdue, find_due_invoice_reminders en de
--      reminder-varianten van begin/complete/fail_invoice_email_send.
--
-- De scheduling (pg_cron + pg_net die de Edge Function dagelijks aanroept) staat
-- bewust NIET in deze migratie: die bevat een project-URL + secret en wordt als
-- operator-stap in INVOICE_REMINDERS_SETUP_2026-06-16.md gedocumenteerd, zodat de
-- migratie deterministisch/idempotent blijft en er geen secrets in git belanden.

begin;

-- ------------------------------------------------------------
-- 1. Reminder-tracking op de factuur
-- ------------------------------------------------------------
alter table public.invoices
  add column if not exists reminder_level smallint not null default 0,
  add column if not exists last_reminder_at timestamptz,
  add column if not exists reminders_paused boolean not null default false;

alter table public.invoices
  drop constraint if exists invoices_reminder_level_check;
alter table public.invoices
  add constraint invoices_reminder_level_check check (reminder_level between 0 and 3);

-- Goedkope index voor de cron-zoekopdracht (alleen openstaande, niet-gepauzeerde
-- te-late facturen).
create index if not exists idx_invoices_reminder_due
  on public.invoices(organization_id, due_date)
  where status = 'overdue' and reminders_paused = false;

-- ------------------------------------------------------------
-- 2. Onderscheid factuur- vs. herinneringsmail in de delivery-historie
-- ------------------------------------------------------------
alter table public.invoice_email_deliveries
  add column if not exists delivery_kind text not null default 'invoice',
  add column if not exists reminder_level smallint;

alter table public.invoice_email_deliveries
  drop constraint if exists invoice_email_deliveries_delivery_kind_check;
alter table public.invoice_email_deliveries
  add constraint invoice_email_deliveries_delivery_kind_check
  check (delivery_kind in ('invoice', 'reminder'));

-- ------------------------------------------------------------
-- 3. Nieuwe workflow-event-types toestaan
-- ------------------------------------------------------------
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events
  add constraint invoice_workflow_events_event_type_check
  check (event_type in (
    'created_from_quote','public_token_created','public_link_created','sent_to_client',
    'email_sent','email_delivered','email_opened','email_clicked','email_bounced','email_failed','email_complained',
    'client_viewed','payment_link_created','payment_open','payment_paid','payment_failed','payment_expired',
    'invoice_version_created','invoice_pdf_attached','locked','expired','cancelled','void','written_off',
    'payment_refunded','credit_note_issued',
    'payment_charged_back','chargeback_reversed','credit_note_emailed',
    'marked_overdue','reminder_sent','reminder_failed'
  ));

-- ------------------------------------------------------------
-- 4. Per-organisatie herinneringsinstellingen
-- ------------------------------------------------------------
create table if not exists public.invoice_reminder_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  auto_reminders_enabled boolean not null default false,
  level1_offset_days integer not null default 3,
  level2_offset_days integer not null default 10,
  level3_offset_days integer not null default 17,
  include_payment_link boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_reminder_settings_offsets_nonneg
    check (level1_offset_days >= 0 and level2_offset_days >= 0 and level3_offset_days >= 0),
  constraint invoice_reminder_settings_offsets_ordered
    check (level1_offset_days <= level2_offset_days and level2_offset_days <= level3_offset_days)
);

alter table public.invoice_reminder_settings enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_reminder_settings' and policyname = 'invoice reminder settings read') then
    create policy "invoice reminder settings read" on public.invoice_reminder_settings for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_reminder_settings' and policyname = 'invoice reminder settings insert') then
    create policy "invoice reminder settings insert" on public.invoice_reminder_settings for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_reminder_settings' and policyname = 'invoice reminder settings update') then
    create policy "invoice reminder settings update" on public.invoice_reminder_settings for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
end $$;

-- ------------------------------------------------------------
-- 5. RPC: openstaande 'sent'-facturen na de vervaldatum op 'overdue' zetten
-- ------------------------------------------------------------
-- Bij p_organization_id = null draait de functie globaal (cron, service_role).
-- De immutability-trigger staat een statuswijziging sent -> overdue toe
-- (alleen number/client/date/lines/notes/currency zijn vergrendeld).
create or replace function public.mark_invoices_overdue(p_organization_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_rec record;
begin
  if auth.role() <> 'service_role'
     and (p_organization_id is null or not public.can_write_org(p_organization_id)) then
    raise exception 'Geen rechten om facturen als te laat te markeren.' using errcode = '42501';
  end if;

  for v_rec in
    update public.invoices i
       set status = 'overdue',
           updated_at = now()
     where i.status = 'sent'
       and i.due_date is not null
       and i.due_date < current_date
       and (p_organization_id is null or i.organization_id = p_organization_id)
    returning i.id, i.organization_id, i.number, i.due_date
  loop
    v_count := v_count + 1;
    perform public.insert_invoice_workflow_event(
      v_rec.organization_id,
      v_rec.id,
      'marked_overdue',
      'Factuur te laat',
      'Factuur ' || coalesce(v_rec.number, '') || ' is na de vervaldatum (' || to_char(v_rec.due_date, 'DD-MM-YYYY') || ') automatisch op ''te laat'' gezet.',
      jsonb_build_object('due_date', v_rec.due_date),
      null
    );
  end loop;

  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- 6. RPC: facturen vinden die nu een herinnering nodig hebben
-- ------------------------------------------------------------
-- Eén niveau per factuur per run (reminder_level + 1), nooit niveaus overslaan.
-- Het eerstvolgende niveau is pas 'due' wanneer het aantal dagen na de
-- vervaldatum de bijbehorende offset uit invoice_reminder_settings bereikt.
create or replace function public.find_due_invoice_reminders(
  p_now timestamptz default now(),
  p_limit integer default 200
)
returns table (
  organization_id uuid,
  invoice_id uuid,
  next_level smallint,
  days_overdue integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag herinneringskandidaten ophalen.' using errcode = '42501';
  end if;

  return query
  select
    i.organization_id,
    i.id as invoice_id,
    (i.reminder_level + 1)::smallint as next_level,
    (p_now::date - i.due_date)::integer as days_overdue
  from public.invoices i
  join public.invoice_reminder_settings s on s.organization_id = i.organization_id
  where s.auto_reminders_enabled = true
    and i.status = 'overdue'
    and i.reminders_paused = false
    and i.reminder_level < 3
    and i.due_date is not null
    and (p_now::date - i.due_date) >= case i.reminder_level
          when 0 then s.level1_offset_days
          when 1 then s.level2_offset_days
          when 2 then s.level3_offset_days
          else 2147483647
        end
  order by i.due_date asc
  limit greatest(1, p_limit);
end;
$$;

-- ------------------------------------------------------------
-- 7. RPC: herinneringsverzending starten (delivery + token verversen)
-- ------------------------------------------------------------
-- Spiegelt begin_invoice_email_send, maar verzet de factuurstatus NIET en maakt
-- een delivery met delivery_kind = 'reminder' + het niveau.
create or replace function public.begin_invoice_reminder_send(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_level smallint,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_recipient_email text,
  p_recipient_name text,
  p_subject text,
  p_public_url text,
  p_attachment_file_name text default null,
  p_attachment_mime_type text default 'application/pdf',
  p_attachment_size_bytes integer default null,
  p_attachment_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_level not between 1 and 3 then
    raise exception 'Ongeldig herinneringsniveau.' using errcode = '22023';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen herinnering worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind, reminder_level,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'reminder', p_level,
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'reminderLevel', p_level)
  ) returning * into v_delivery;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id);
end;
$$;

-- ------------------------------------------------------------
-- 8. RPC: herinneringsverzending afronden (delivery + factuur bijwerken)
-- ------------------------------------------------------------
create or replace function public.complete_invoice_reminder_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_email_id text,
  p_level smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.invoice_email_deliveries;
  v_invoice public.invoices;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.invoice_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuurdelivery niet gevonden.' using errcode = '02000'; end if;

  update public.invoice_email_deliveries
     set provider_email_id = nullif(btrim(p_provider_email_id), ''),
         status = 'sent',
         sent_at = now(),
         last_event_at = now(),
         updated_at = now()
   where id = v_delivery.id
   returning * into v_delivery;

  update public.invoices
     set reminder_level = greatest(reminder_level, p_level),
         last_reminder_at = now(),
         resend_last_email_id = nullif(btrim(p_provider_email_id), ''),
         last_email_delivery_status = 'sent',
         last_email_delivery_at = now(),
         updated_at = now()
   where id = v_delivery.invoice_id and organization_id = p_organization_id
   returning * into v_invoice;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_invoice.id,
    'reminder_sent',
    'Betalingsherinnering verstuurd (niveau ' || p_level || ')',
    'Herinnering niveau ' || p_level || ' voor factuur ' || v_invoice.number || ' is via Resend verstuurd naar ' || v_delivery.recipient_email || '.',
    jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'reminder_level', p_level),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'invoice_reminder_sent', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'reminder_level', p_level));

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'invoice', to_jsonb(v_invoice));
end;
$$;

-- ------------------------------------------------------------
-- 9. RPC: mislukte herinneringsverzending registreren
-- ------------------------------------------------------------
-- Bumpt reminder_level bewust NIET, zodat de volgende cron-run hetzelfde niveau
-- opnieuw probeert (de dagelijkse cadans throttelt de retries vanzelf).
create or replace function public.fail_invoice_reminder_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.invoice_email_deliveries;
  v_error text := left(coalesce(nullif(btrim(coalesce(p_error_message, '')), ''), 'Onbekende Resend-verzendfout'), 2000);
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.invoice_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;
  if not found then return; end if;

  update public.invoice_email_deliveries
     set status = 'failed',
         failed_at = coalesce(failed_at, now()),
         last_event_at = now(),
         error_message = left(v_error, 1000),
         updated_at = now()
   where id = v_delivery.id;

  update public.invoices
     set last_email_delivery_status = 'failed',
         last_email_failed_at = now(),
         updated_at = now()
   where id = v_delivery.invoice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_delivery.invoice_id,
    'reminder_failed',
    'Betalingsherinnering mislukt',
    left(v_error, 1000),
    jsonb_build_object('delivery_id', v_delivery.id, 'reminder_level', v_delivery.reminder_level),
    p_actor_user_id
  );
end;
$$;

-- ------------------------------------------------------------
-- 10. Grants — uitsluitend de service-role (de Edge Function autoriseert de user).
-- ------------------------------------------------------------
revoke execute on function public.mark_invoices_overdue(uuid) from public, anon, authenticated;
revoke execute on function public.find_due_invoice_reminders(timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.begin_invoice_reminder_send(uuid, uuid, uuid, smallint, text, timestamptz, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
revoke execute on function public.complete_invoice_reminder_send(uuid, uuid, uuid, text, smallint) from public, anon, authenticated;
revoke execute on function public.fail_invoice_reminder_send(uuid, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.mark_invoices_overdue(uuid) to service_role;
grant execute on function public.find_due_invoice_reminders(timestamptz, integer) to service_role;
grant execute on function public.begin_invoice_reminder_send(uuid, uuid, uuid, smallint, text, timestamptz, text, text, text, text, text, text, integer, text) to service_role;
grant execute on function public.complete_invoice_reminder_send(uuid, uuid, uuid, text, smallint) to service_role;
grant execute on function public.fail_invoice_reminder_send(uuid, uuid, uuid, text) to service_role;

commit;
