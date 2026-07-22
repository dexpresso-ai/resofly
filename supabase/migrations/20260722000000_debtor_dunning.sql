-- ResoFly: debiteurenautomaat met Nederlands incassorecht.
--
-- Bouwt VOORT op de bestaande, getrapte betalingsherinneringen (migratie
-- 20260617000000): die sturen 3 oplopende, vriendelijke herinneringen. Deze
-- migratie voegt de JURIDISCHE escalatie toe: een formele aanmaning /
-- WIK-14-dagenbrief met wettelijke (handels)rente + buitengerechtelijke
-- incassokosten volgens het "Besluit vergoeding voor buitengerechtelijke
-- incassokosten" (WIK-staffel).
--
-- Kernprincipe (human-in-the-loop, zoals in de feature gevraagd): de cron
-- DETECTEERT te-late facturen en maakt een 'proposed' aanmaning met de berekende
-- bedragen; er wordt NIETS automatisch verstuurd. De gebruiker beoordeelt het
-- voorstel (bedragen + briefpreview) en bevestigt; pas dan gaat de brief eruit.
--
-- De rekenlogica (WIK-staffel + rente) zit in de Edge Function (_shared/dunning.ts,
-- unit-getest), niet in SQL: de Edge Function berekent de bedragen en levert ze via
-- begin_dunning_notice aan. Zo is er één getoetste bron van waarheid.
--
-- De scheduling (pg_cron + pg_net) staat bewust NIET hier maar in de setup-doc,
-- zodat de migratie deterministisch/idempotent blijft en er geen secrets in git komen.

begin;

-- ------------------------------------------------------------
-- 1. Klanttype: bepaalt rentesoort én of de WIK-14-dagenbrief verplicht is.
-- ------------------------------------------------------------
-- 'business'  → wettelijke handelsrente (art. 6:119a BW); incassokosten mogen in
--               beginsel direct (afhankelijk van de voorwaarden).
-- 'consumer'  → wettelijke rente (art. 6:119 BW); incassokosten pas ná een correcte
--               14-dagenbrief (WIK). Default 'business': dat is de gebruikelijke
--               factuurrelatie, en bij twijfel is de handelsrente-route zonder
--               verplichte 14-dagenbrief de veiligere aanname voor B2B.
alter table public.clients
  add column if not exists client_kind text not null default 'business';
alter table public.clients
  drop constraint if exists clients_client_kind_check;
alter table public.clients
  add constraint clients_client_kind_check check (client_kind in ('business', 'consumer'));

-- ------------------------------------------------------------
-- 2. Wettelijke rentetarieven — nationale referentietabel, periode-accuraat.
-- ------------------------------------------------------------
-- De wettelijke rente en handelsrente wijzigen periodiek (handelsrente elk half
-- jaar op basis van de ECB-rente). We bewaren een tijdlijn van tarieven zodat een
-- factuur die over een tariefwijziging heen loopt correct wordt berekend.
--
-- De geseede tarieven zijn geverifieerd via web-onderzoek (peildatum 2026-07-22):
-- wettelijke rente (art. 6:119 BW) en wettelijke handelsrente (art. 6:119a BW =
-- ECB-refi + 8pp, halfjaarlijks). De reeks 2015 t/m 2025 is betrouwbaar bevestigd;
-- de twee 2026-regels van de handelsrente (10,15% en 10,40%) steunen op één
-- secundaire bron en moeten vóór productie tegen de officiële bekendmaking
-- (Rijksoverheid/Staatscourant) worden gecontroleerd. Org-overschrijving is v2;
-- nu is deze tabel de autoritatieve bron voor de rente-engine.
create table if not exists public.statutory_interest_rates (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('consumer', 'commercial')),
  rate_basis_points integer not null check (rate_basis_points >= 0 and rate_basis_points <= 100000),
  valid_from date not null,
  source_note text,
  created_at timestamptz not null default now(),
  unique (kind, valid_from)
);

alter table public.statutory_interest_rates enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'statutory_interest_rates' and policyname = 'statutory interest rates read') then
    -- Nationale wetgeving, geen org-data: leesbaar voor elke ingelogde gebruiker.
    -- Schrijven kan alleen via migraties/service_role (die RLS omzeilt).
    create policy "statutory interest rates read" on public.statutory_interest_rates
      for select using (auth.role() = 'authenticated');
  end if;
end $$;

insert into public.statutory_interest_rates (kind, rate_basis_points, valid_from, source_note) values
  ('consumer',   200, '2015-01-01', 'Wettelijke rente 2% (2015 t/m 2022) — geverifieerd 2026-07-22'),
  ('consumer',   400, '2023-01-01', 'Wettelijke rente 4% — geverifieerd 2026-07-22'),
  ('consumer',   600, '2023-07-01', 'Wettelijke rente 6% — geverifieerd 2026-07-22'),
  ('consumer',   700, '2024-01-01', 'Wettelijke rente 7% — geverifieerd 2026-07-22'),
  ('consumer',   600, '2025-01-01', 'Wettelijke rente 6% — geverifieerd 2026-07-22'),
  ('consumer',   400, '2026-01-01', 'Wettelijke rente 4% — geverifieerd 2026-07-22'),
  ('commercial', 805, '2016-01-01', 'Handelsrente 8,05% — geverifieerd 2026-07-22'),
  ('commercial', 800, '2016-07-01', 'Handelsrente 8,00% (2016-07 t/m 2022) — geverifieerd 2026-07-22'),
  ('commercial', 1050, '2023-01-01', 'Handelsrente 10,50% — geverifieerd 2026-07-22'),
  ('commercial', 1200, '2023-07-01', 'Handelsrente 12,00% — geverifieerd 2026-07-22'),
  ('commercial', 1250, '2024-01-01', 'Handelsrente 12,50% — geverifieerd 2026-07-22'),
  ('commercial', 1225, '2024-07-01', 'Handelsrente 12,25% — geverifieerd 2026-07-22'),
  ('commercial', 1115, '2025-01-01', 'Handelsrente 11,15% — geverifieerd 2026-07-22'),
  ('commercial', 1015, '2025-07-01', 'Handelsrente 10,15% — geverifieerd 2026-07-22'),
  ('commercial', 1015, '2026-01-01', 'Handelsrente 10,15% — VERIFIEER bij officiële bekendmaking'),
  ('commercial', 1040, '2026-07-01', 'Handelsrente 10,40% — VERIFIEER bij officiële bekendmaking')
on conflict (kind, valid_from) do nothing;

-- ------------------------------------------------------------
-- 3. Dunning-instellingen — uitbreiding van de bestaande reminder-settings.
-- ------------------------------------------------------------
alter table public.invoice_reminder_settings
  add column if not exists dunning_enabled boolean not null default false,
  add column if not exists dunning_offset_days integer not null default 30,
  add column if not exists dunning_collection_costs_vat boolean not null default false;

alter table public.invoice_reminder_settings
  drop constraint if exists invoice_reminder_settings_dunning_offset_nonneg;
alter table public.invoice_reminder_settings
  add constraint invoice_reminder_settings_dunning_offset_nonneg
  check (dunning_offset_days >= 0);

-- ------------------------------------------------------------
-- 4. Delivery- en workflow-event-types uitbreiden (bestaande lijsten + nieuwe).
-- ------------------------------------------------------------
alter table public.invoice_email_deliveries
  drop constraint if exists invoice_email_deliveries_delivery_kind_check;
alter table public.invoice_email_deliveries
  add constraint invoice_email_deliveries_delivery_kind_check
  check (delivery_kind in ('invoice', 'reminder', 'dunning'));

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
    'marked_overdue','reminder_sent','reminder_failed',
    'dunning_proposed','dunning_sent','dunning_failed','dunning_cancelled'
  ));

-- audit_logs: nieuwe actie voor de verstuurde aanmaning (zelfde valkuil als bij de
-- herinnering — ontbrak de actie in de check, dan faalt de audit-insert met 23514).
-- Volledige lijst overgenomen uit 20260617000001 + 'dunning_notice_sent'.
do $$
begin
  if exists (
    select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check'
  ) then
    alter table public.audit_logs drop constraint audit_logs_action_check;
  end if;
  alter table public.audit_logs
    add constraint audit_logs_action_check
    check (action in (
      'created','updated','deleted','invited','accepted','revoked','role_changed','disabled','expired',
      'mollie_connected','plan_changed','seat_purchased','seat_downgrade_requested',
      'payment_succeeded','payment_failed','payment_expired','subscription_cancelled',
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced',
      'quote_submitted_for_approval','quote_internal_approved','quote_internal_rejected',
      'quote_sent_to_client','quote_client_accepted','quote_client_rejected',
      'quote_email_delivered','quote_email_failed','quote_version_created','quote_pdf_attached',
      'invoice_created_from_quote','invoice_sent_to_client','invoice_payment_link_created','invoice_paid',
      'invoice_refunded','credit_note_issued',
      'invoice_charged_back','chargeback_reversed','credit_note_emailed',
      'invoice_reminder_sent',
      'dunning_notice_sent'
    ));
end $$;

-- ------------------------------------------------------------
-- 5. Aanmaningen (dunning notices) — één per factuur, met bedragen-snapshot.
-- ------------------------------------------------------------
create table if not exists public.invoice_dunning_notices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  stage text not null default 'wik_14day' check (stage in ('wik_14day')),
  client_kind text not null check (client_kind in ('business', 'consumer')),
  interest_kind text not null check (interest_kind in ('consumer', 'commercial')),
  principal_cents bigint not null check (principal_cents >= 0),
  interest_cents bigint not null default 0 check (interest_cents >= 0),
  interest_days integer not null default 0 check (interest_days >= 0),
  daily_interest_cents bigint not null default 0 check (daily_interest_cents >= 0),
  collection_costs_cents bigint not null default 0 check (collection_costs_cents >= 0),
  collection_costs_vat_cents bigint not null default 0 check (collection_costs_vat_cents >= 0),
  total_claim_cents bigint not null check (total_claim_cents >= 0),
  calculation_date date not null,
  due_date date,
  deadline_date date,
  rate_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'sent', 'failed', 'cancelled')),
  delivery_id uuid references public.invoice_email_deliveries(id) on delete set null,
  public_url text,
  error_message text,
  proposed_at timestamptz not null default now(),
  confirmed_at timestamptz,
  sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Eén aanmaning per factuur in v1 (geen automatische her-escalatie): voorkomt dat
-- de cron elke dag een nieuw voorstel maakt. Een mislukte verzending wordt op de
-- bestaande rij opnieuw geprobeerd vanuit de UI.
create unique index if not exists uidx_invoice_dunning_notice_per_invoice
  on public.invoice_dunning_notices(invoice_id);

create index if not exists idx_invoice_dunning_notices_org_status
  on public.invoice_dunning_notices(organization_id, status);

alter table public.invoice_dunning_notices enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_dunning_notices' and policyname = 'invoice dunning notices read') then
    -- Lezen door orgleden; schrijven uitsluitend via de service_role-RPC's hieronder
    -- (de Edge Function autoriseert de gebruiker en berekent de bedragen).
    create policy "invoice dunning notices read" on public.invoice_dunning_notices
      for select using (public.can_read_org(organization_id));
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. RPC: kandidaten voor een aanmaning vinden.
-- ------------------------------------------------------------
-- Te-late facturen waarvoor dunning aanstaat, die de offset voorbij zijn en waarvoor
-- nog GEEN aanmaning bestaat. De bedragen worden niet hier maar in de Edge Function
-- berekend (die _shared/dunning.ts + de rentetarieven heeft).
create or replace function public.find_due_dunning_candidates(
  p_now timestamptz default now(),
  p_limit integer default 200
)
returns table (
  organization_id uuid,
  invoice_id uuid,
  client_id uuid,
  days_overdue integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag aanmaningskandidaten ophalen.' using errcode = '42501';
  end if;

  return query
  select
    i.organization_id,
    i.id as invoice_id,
    i.client_id,
    (p_now::date - i.due_date)::integer as days_overdue
  from public.invoices i
  join public.invoice_reminder_settings s on s.organization_id = i.organization_id
  where s.dunning_enabled = true
    and i.status = 'overdue'
    and i.reminders_paused = false
    and i.client_id is not null
    and i.due_date is not null
    and (p_now::date - i.due_date) >= s.dunning_offset_days
    and not exists (
      select 1 from public.invoice_dunning_notices n where n.invoice_id = i.id
    )
  order by i.due_date asc
  limit greatest(1, p_limit);
end;
$$;

-- ------------------------------------------------------------
-- 7. RPC: aanmaning-voorstel aanmaken (door de cron, met berekende bedragen).
-- ------------------------------------------------------------
create or replace function public.begin_dunning_notice(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_actor_user_id uuid,
  p_client_kind text,
  p_interest_kind text,
  p_principal_cents bigint,
  p_interest_cents bigint,
  p_interest_days integer,
  p_daily_interest_cents bigint,
  p_collection_costs_cents bigint,
  p_collection_costs_vat_cents bigint,
  p_total_claim_cents bigint,
  p_calculation_date date,
  p_due_date date,
  p_rate_snapshot jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_notice public.invoice_dunning_notices;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen aanmaning worden gemaakt.' using errcode = '23514';
  end if;

  insert into public.invoice_dunning_notices(
    organization_id, invoice_id, client_kind, interest_kind,
    principal_cents, interest_cents, interest_days, daily_interest_cents,
    collection_costs_cents, collection_costs_vat_cents, total_claim_cents,
    calculation_date, due_date, rate_snapshot, status, created_by
  ) values (
    p_organization_id, p_invoice_id, p_client_kind, p_interest_kind,
    p_principal_cents, p_interest_cents, coalesce(p_interest_days, 0), coalesce(p_daily_interest_cents, 0),
    p_collection_costs_cents, p_collection_costs_vat_cents, p_total_claim_cents,
    p_calculation_date, p_due_date, coalesce(p_rate_snapshot, '{}'::jsonb), 'proposed', p_actor_user_id
  )
  returning * into v_notice;

  perform public.insert_invoice_workflow_event(
    p_organization_id, p_invoice_id, 'dunning_proposed',
    'Aanmaning voorgesteld',
    'Er is een aanmaning (WIK-14-dagenbrief) voorgesteld voor factuur ' || coalesce(v_invoice.number, '') ||
      ': hoofdsom + rente + incassokosten = ' || to_char((p_total_claim_cents::numeric / 100), 'FM999G999G990D00') || ' EUR. Wacht op bevestiging.',
    jsonb_build_object('notice_id', v_notice.id, 'total_claim_cents', p_total_claim_cents),
    p_actor_user_id
  );

  return jsonb_build_object('noticeId', v_notice.id);
end;
$$;

-- ------------------------------------------------------------
-- 8. RPC: aanmaning annuleren (gebruiker wijst het voorstel af).
-- ------------------------------------------------------------
create or replace function public.cancel_dunning_notice(
  p_notice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notice public.invoice_dunning_notices;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_notice
  from public.invoice_dunning_notices
  where id = p_notice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Aanmaning niet gevonden.' using errcode = '02000'; end if;
  if v_notice.status = 'sent' then
    raise exception 'Een verstuurde aanmaning kan niet meer worden geannuleerd.' using errcode = '23514';
  end if;

  update public.invoice_dunning_notices
     set status = 'cancelled', updated_at = now()
   where id = v_notice.id
   returning * into v_notice;

  perform public.insert_invoice_workflow_event(
    p_organization_id, v_notice.invoice_id, 'dunning_cancelled',
    'Aanmaning geannuleerd', 'Het aanmaningsvoorstel is geannuleerd.',
    jsonb_build_object('notice_id', v_notice.id), p_actor_user_id
  );

  return jsonb_build_object('notice', to_jsonb(v_notice));
end;
$$;

-- ------------------------------------------------------------
-- 9. RPC: aanmaning-verzending starten (bedragen actualiseren + delivery + token).
-- ------------------------------------------------------------
-- Spiegelt begin_invoice_reminder_send: ververst de publieke factuurtoken en maakt
-- een delivery met delivery_kind = 'dunning'. Actualiseert de bedragen op de notice
-- naar de op verzenddatum herberekende waarden en zet de betaaltermijn (deadline).
create or replace function public.begin_dunning_send(
  p_notice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_interest_cents bigint,
  p_interest_days integer,
  p_daily_interest_cents bigint,
  p_collection_costs_cents bigint,
  p_collection_costs_vat_cents bigint,
  p_total_claim_cents bigint,
  p_calculation_date date,
  p_deadline_date date,
  p_rate_snapshot jsonb,
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
  v_notice public.invoice_dunning_notices;
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_notice
  from public.invoice_dunning_notices
  where id = p_notice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Aanmaning niet gevonden.' using errcode = '02000'; end if;
  if v_notice.status = 'sent' then
    raise exception 'Deze aanmaning is al verstuurd.' using errcode = '23514';
  end if;
  if v_notice.status = 'cancelled' then
    raise exception 'Deze aanmaning is geannuleerd.' using errcode = '23514';
  end if;
  -- Alleen een voorgestelde of eerder mislukte aanmaning mag (opnieuw) verstuurd worden.
  -- Weiger o.a. de tussenstatus 'confirmed' (verzending al in gang), zodat een dubbelklik
  -- of retry niet een TWEEDE formele aanmaning verstuurt (de FOR UPDATE-lock serialiseert
  -- de twee verzoeken, maar zonder deze guard zou de tweede alsnog doorgaan).
  if v_notice.status not in ('proposed', 'failed') then
    raise exception 'Deze aanmaning wordt al verstuurd.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_notice.invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen aanmaning worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, v_notice.invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'dunning',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'dunningNoticeId', v_notice.id)
  ) returning * into v_delivery;

  update public.invoice_dunning_notices
     set status = 'confirmed',
         interest_cents = p_interest_cents,
         interest_days = coalesce(p_interest_days, 0),
         daily_interest_cents = coalesce(p_daily_interest_cents, 0),
         collection_costs_cents = p_collection_costs_cents,
         collection_costs_vat_cents = p_collection_costs_vat_cents,
         total_claim_cents = p_total_claim_cents,
         calculation_date = p_calculation_date,
         deadline_date = p_deadline_date,
         rate_snapshot = coalesce(p_rate_snapshot, rate_snapshot),
         public_url = p_public_url,
         delivery_id = v_delivery.id,
         confirmed_by = p_actor_user_id,
         confirmed_at = now(),
         updated_at = now()
   where id = v_notice.id;

  return jsonb_build_object('deliveryId', v_delivery.id, 'noticeId', v_notice.id);
end;
$$;

-- ------------------------------------------------------------
-- 10. RPC: aanmaning-verzending afronden (delivery + notice op 'sent').
-- ------------------------------------------------------------
create or replace function public.complete_dunning_send(
  p_notice_id uuid,
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_email_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.invoice_email_deliveries;
  v_notice public.invoice_dunning_notices;
  v_invoice public.invoices;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  update public.invoice_email_deliveries
     set provider_email_id = nullif(btrim(p_provider_email_id), ''),
         status = 'sent', sent_at = now(), last_event_at = now(), updated_at = now()
   where id = p_delivery_id and organization_id = p_organization_id
   returning * into v_delivery;
  if not found then raise exception 'Aanmaningdelivery niet gevonden.' using errcode = '02000'; end if;

  update public.invoice_dunning_notices
     set status = 'sent', sent_at = now(), updated_at = now()
   where id = p_notice_id and organization_id = p_organization_id
   returning * into v_notice;
  if not found then raise exception 'Aanmaning niet gevonden.' using errcode = '02000'; end if;

  select * into v_invoice from public.invoices where id = v_notice.invoice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(
    p_organization_id, v_notice.invoice_id, 'dunning_sent',
    'Aanmaning verstuurd',
    'De aanmaning (WIK-14-dagenbrief) voor factuur ' || coalesce(v_invoice.number, '') || ' is via Resend verstuurd naar ' || v_delivery.recipient_email ||
      '. Betaaltermijn tot ' || coalesce(to_char(v_notice.deadline_date, 'DD-MM-YYYY'), 'onbekend') || '.',
    jsonb_build_object('notice_id', v_notice.id, 'delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'total_claim_cents', v_notice.total_claim_cents),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'dunning_notice_sent', 'invoice', v_notice.invoice_id, coalesce(v_invoice.number, ''), jsonb_build_object('notice_id', v_notice.id, 'delivery_id', v_delivery.id, 'total_claim_cents', v_notice.total_claim_cents));

  return jsonb_build_object('notice', to_jsonb(v_notice), 'delivery', to_jsonb(v_delivery));
end;
$$;

-- ------------------------------------------------------------
-- 11. RPC: mislukte aanmaning-verzending registreren.
-- ------------------------------------------------------------
create or replace function public.fail_dunning_send(
  p_notice_id uuid,
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
  v_error text := left(coalesce(nullif(btrim(coalesce(p_error_message, '')), ''), 'Onbekende Resend-verzendfout'), 2000);
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  update public.invoice_email_deliveries
     set status = 'failed', failed_at = coalesce(failed_at, now()), last_event_at = now(),
         error_message = left(v_error, 1000), updated_at = now()
   where id = p_delivery_id and organization_id = p_organization_id;

  update public.invoice_dunning_notices
     set status = 'failed', error_message = left(v_error, 1000), updated_at = now()
   where id = p_notice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    (select invoice_id from public.invoice_dunning_notices where id = p_notice_id and organization_id = p_organization_id),
    'dunning_failed', 'Aanmaning mislukt', left(v_error, 1000),
    jsonb_build_object('notice_id', p_notice_id, 'delivery_id', p_delivery_id), p_actor_user_id
  );
end;
$$;

-- ------------------------------------------------------------
-- 12. Grants — uitsluitend de service-role (de Edge Function autoriseert de user).
-- ------------------------------------------------------------
revoke execute on function public.find_due_dunning_candidates(timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.begin_dunning_notice(uuid, uuid, uuid, text, text, bigint, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb) from public, anon, authenticated;
revoke execute on function public.cancel_dunning_notice(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
revoke execute on function public.complete_dunning_send(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_dunning_send(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.find_due_dunning_candidates(timestamptz, integer) to service_role;
grant execute on function public.begin_dunning_notice(uuid, uuid, uuid, text, text, bigint, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb) to service_role;
grant execute on function public.cancel_dunning_notice(uuid, uuid, uuid) to service_role;
grant execute on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text) to service_role;
grant execute on function public.complete_dunning_send(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_dunning_send(uuid, uuid, uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 13. create_client_with_next_code uitbreiden met client_kind.
-- ------------------------------------------------------------
-- De bestaande RPC (20260520000000) nam client_kind niet mee, waardoor een NIEUW als
-- 'consument' aangemaakte klant terugviel op de default 'business' → verkeerde
-- rentesoort + gemiste WIK-14-behandeling bij een aanmaning. We recreëren 'm mét
-- client_kind; de rest is identiek aan het origineel (grants blijven behouden bij
-- create or replace). client_kind bestaat hier al (sectie 1).
create or replace function public.create_client_with_next_code(p_organization_id uuid, p_payload jsonb default '{}'::jsonb)
returns public.clients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_user_id uuid := auth.uid();
  v_status text := coalesce(nullif(btrim(p_payload ->> 'status'), ''), 'active');
  v_color text := coalesce(nullif(btrim(p_payload ->> 'color'), ''), '#FFD966');
  v_client_kind text := coalesce(nullif(btrim(p_payload ->> 'client_kind'), ''), 'business');
  v_value_eur numeric(12,2) := 0;
  v_tags text[] := '{}';
  v_client_code text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if v_status not in ('active','prospect','inactive') then
    raise exception 'Ongeldige klantstatus.' using errcode = '23514';
  end if;

  if v_client_kind not in ('business','consumer') then
    raise exception 'Ongeldig klanttype.' using errcode = '23514';
  end if;

  if jsonb_typeof(p_payload -> 'tags') = 'array' then
    select coalesce(array_agg(nullif(btrim(value), '')) filter (where nullif(btrim(value), '') is not null), '{}')
      into v_tags
    from jsonb_array_elements_text(p_payload -> 'tags') as tags(value);
  end if;

  if nullif(p_payload ->> 'value_eur', '') is not null then
    v_value_eur := (p_payload ->> 'value_eur')::numeric(12,2);
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('clients_duplicate_guard'));
  v_client_code := public.allocate_next_client_code(p_organization_id);

  perform set_config('resofly.client_code_generated', 'true', true);

  insert into public.clients(
    organization_id,
    created_by,
    name,
    client_code,
    contact_name,
    email,
    phone,
    notes,
    color,
    status,
    client_kind,
    tags,
    value_eur,
    follow_up
  ) values (
    p_organization_id,
    v_user_id,
    btrim(coalesce(p_payload ->> 'name', '')),
    v_client_code,
    nullif(btrim(p_payload ->> 'contact_name'), ''),
    nullif(lower(btrim(p_payload ->> 'email')), ''),
    nullif(btrim(p_payload ->> 'phone'), ''),
    nullif(btrim(p_payload ->> 'notes'), ''),
    v_color,
    v_status,
    v_client_kind,
    v_tags,
    v_value_eur,
    nullif(p_payload ->> 'follow_up', '')::date
  )
  returning * into v_client;

  return v_client;
end;
$$;

commit;
