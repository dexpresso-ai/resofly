-- ============================================================
-- ResoFly — Invoice workflow, public invoice page and Mollie links
-- Date: 2026-05-26
--
-- Scope:
-- - Atomic quote -> invoice conversion through RPC
-- - Server-side invoice number allocation per organization/year
-- - Invoice email deliveries + Resend events
-- - Invoice public tokens
-- - Invoice PDF/version snapshots
-- - Separate customer invoice payment records for Mollie
-- ============================================================

create extension if not exists pgcrypto;

begin;

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft','sent','accepted','rejected','expired','paid','overdue','cancelled'));

alter table public.invoices
  add column if not exists public_token_hash text,
  add column if not exists public_token_created_at timestamptz,
  add column if not exists public_token_expires_at timestamptz,
  add column if not exists resend_last_email_id text,
  add column if not exists last_email_delivery_status text,
  add column if not exists last_email_delivery_at timestamptz,
  add column if not exists last_email_opened_at timestamptz,
  add column if not exists last_email_clicked_at timestamptz,
  add column if not exists last_email_failed_at timestamptz,
  add column if not exists latest_version_id uuid,
  add column if not exists sent_version_id uuid,
  add column if not exists paid_version_id uuid,
  add column if not exists last_pdf_file_name text,
  add column if not exists last_pdf_mime_type text,
  add column if not exists last_pdf_size_bytes integer,
  add column if not exists last_pdf_sha256 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_public_token_hash_unique'
  ) then
    alter table public.invoices
      add constraint invoices_public_token_hash_unique unique (public_token_hash);
  end if;
end $$;

create unique index if not exists idx_invoices_one_per_quote
  on public.invoices(organization_id, quote_id)
  where quote_id is not null;

create index if not exists idx_invoices_public_token_hash
  on public.invoices(public_token_hash)
  where public_token_hash is not null;

create table if not exists public.organization_invoice_number_sequences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_year integer not null,
  prefix text not null default 'FAC',
  padding integer not null default 4 check (padding between 1 and 12),
  next_number integer not null default 1 check (next_number > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, invoice_year)
);

alter table public.organization_invoice_number_sequences enable row level security;

drop policy if exists "invoice number sequences read by org admins" on public.organization_invoice_number_sequences;
create policy "invoice number sequences read by org admins"
  on public.organization_invoice_number_sequences
  for select
  using (public.can_admin_org(organization_id));

create or replace function public.extract_invoice_sequence_number(p_invoice_number text, p_prefix text default 'FAC', p_year integer default extract(year from current_date)::integer)
returns integer
language plpgsql
immutable
as $$
declare
  v_value text := upper(btrim(coalesce(p_invoice_number, '')));
  v_prefix text := regexp_replace(upper(btrim(coalesce(p_prefix, 'FAC'))), '[^A-Z0-9]+', '', 'g');
  v_match text[];
begin
  v_match := regexp_match(v_value, '^' || v_prefix || '-' || p_year::text || '-([0-9]+)$');
  if v_match is null then
    return null;
  end if;
  return v_match[1]::integer;
exception when others then
  return null;
end;
$$;

create or replace function public.format_invoice_number(p_prefix text, p_year integer, p_number integer, p_padding integer)
returns text
language sql
immutable
as $$
  select upper(btrim(coalesce(p_prefix, 'FAC'))) || '-' || coalesce(p_year, extract(year from current_date)::integer)::text || '-' || lpad(greatest(coalesce(p_number, 1), 1)::text, greatest(coalesce(p_padding, 4), 1), '0');
$$;

create or replace function public.reconcile_invoice_number_sequence(p_organization_id uuid, p_year integer default extract(year from current_date)::integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_number integer;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor factuurnummerreeks.' using errcode = '23514';
  end if;

  select greatest(coalesce(max(public.extract_invoice_sequence_number(number, 'FAC', p_year)), 0) + 1, 1)
    into v_next_number
  from public.invoices
  where organization_id = p_organization_id;

  insert into public.organization_invoice_number_sequences(organization_id, invoice_year, prefix, padding, next_number)
  values (p_organization_id, p_year, 'FAC', 4, v_next_number)
  on conflict (organization_id, invoice_year) do update
    set next_number = greatest(public.organization_invoice_number_sequences.next_number, excluded.next_number),
        updated_at = now();
end;
$$;

create or replace function public.allocate_next_invoice_number(p_organization_id uuid, p_invoice_date date default current_date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from coalesce(p_invoice_date, current_date))::integer;
  v_sequence public.organization_invoice_number_sequences;
  v_number integer;
  v_invoice_number text;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor factuurnummerreeks.' using errcode = '23514';
  end if;

  perform public.reconcile_invoice_number_sequence(p_organization_id, v_year);

  select * into v_sequence
  from public.organization_invoice_number_sequences
  where organization_id = p_organization_id and invoice_year = v_year
  for update;

  if not found then
    raise exception 'Factuurnummerreeks kon niet worden geladen.' using errcode = 'P0002';
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_invoice_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.invoices i
    where i.organization_id = p_organization_id
      and upper(btrim(i.number)) = upper(btrim(v_invoice_number))
  ) loop
    v_number := v_number + 1;
    v_invoice_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);
  end loop;

  update public.organization_invoice_number_sequences
     set next_number = v_number + 1,
         updated_at = now()
   where organization_id = p_organization_id
     and invoice_year = v_year;

  return v_invoice_number;
end;
$$;

create or replace function public.preview_next_invoice_number(p_organization_id uuid, p_invoice_date date default current_date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from coalesce(p_invoice_date, current_date))::integer;
  v_sequence public.organization_invoice_number_sequences;
  v_number integer;
  v_invoice_number text;
begin
  if not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  perform public.reconcile_invoice_number_sequence(p_organization_id, v_year);

  select * into v_sequence
  from public.organization_invoice_number_sequences
  where organization_id = p_organization_id and invoice_year = v_year;

  if not found then
    return public.format_invoice_number('FAC', v_year, 1, 4);
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_invoice_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.invoices i
    where i.organization_id = p_organization_id
      and upper(btrim(i.number)) = upper(btrim(v_invoice_number))
  ) loop
    v_number := v_number + 1;
    v_invoice_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);
  end loop;

  return v_invoice_number;
end;
$$;

create table if not exists public.invoice_workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'created_from_quote',
    'public_token_created',
    'sent_to_client',
    'email_sent',
    'email_delivered',
    'email_opened',
    'email_clicked',
    'email_bounced',
    'email_failed',
    'email_complained',
    'client_viewed',
    'payment_link_created',
    'payment_open',
    'payment_paid',
    'payment_failed',
    'payment_expired',
    'invoice_version_created',
    'invoice_pdf_attached',
    'expired',
    'cancelled'
  )),
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.invoice_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  delivery_id uuid,
  payment_record_id uuid,
  version_number integer not null,
  snapshot_reason text not null check (snapshot_reason in ('sent_to_client','payment_created','paid','manual')),
  status_at_snapshot text not null,
  invoice_number text not null,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  quote_id uuid references public.quotes(id) on delete set null,
  invoice_date date,
  due_date date,
  notes text,
  subtotal_amount numeric(12,2) not null default 0,
  vat_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  invoice_version_pdf_url text,
  pdf_file_name text,
  pdf_mime_type text,
  pdf_size_bytes integer,
  pdf_sha256 text,
  snapshot_data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, invoice_id, version_number)
);

create table if not exists public.invoice_version_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  invoice_version_id uuid not null references public.invoice_versions(id) on delete cascade,
  source_line_id text,
  line_index integer not null,
  description text not null,
  quantity numeric(12,2) not null default 0,
  unit_price numeric(12,2) not null default 0,
  vat_percentage numeric(5,2) not null default 0,
  line_subtotal numeric(12,2) not null default 0,
  line_vat numeric(12,2) not null default 0,
  line_total numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.invoice_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  provider text not null default 'resend',
  provider_email_id text,
  recipient_email text not null,
  recipient_name text,
  subject text not null,
  status text not null default 'queued' check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','complained')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  complained_at timestamptz,
  last_event_at timestamptz,
  invoice_version_id uuid references public.invoice_versions(id) on delete set null,
  attachment_file_name text,
  attachment_mime_type text,
  attachment_size_bytes integer,
  attachment_sha256 text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  delivery_id uuid references public.invoice_email_deliveries(id) on delete set null,
  provider text not null default 'resend',
  provider_event_id text not null,
  provider_email_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table if not exists public.invoice_payment_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  provider text not null default 'mollie',
  provider_payment_id text,
  provider_checkout_url text,
  idempotency_key text,
  status text not null default 'open' check (status in ('open','pending','authorized','paid','failed','expired','canceled','refunded','charged_back')),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'EUR',
  checkout_expires_at timestamptz,
  paid_at timestamptz,
  last_webhook_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.invoice_versions
  drop constraint if exists invoice_versions_delivery_fk,
  add constraint invoice_versions_delivery_fk foreign key (delivery_id) references public.invoice_email_deliveries(id) on delete set null;

alter table public.invoice_versions
  drop constraint if exists invoice_versions_payment_fk,
  add constraint invoice_versions_payment_fk foreign key (payment_record_id) references public.invoice_payment_records(id) on delete set null;

alter table public.invoices
  drop constraint if exists invoices_latest_version_fk,
  add constraint invoices_latest_version_fk foreign key (latest_version_id) references public.invoice_versions(id) on delete set null;

alter table public.invoices
  drop constraint if exists invoices_sent_version_fk,
  add constraint invoices_sent_version_fk foreign key (sent_version_id) references public.invoice_versions(id) on delete set null;

alter table public.invoices
  drop constraint if exists invoices_paid_version_fk,
  add constraint invoices_paid_version_fk foreign key (paid_version_id) references public.invoice_versions(id) on delete set null;

create index if not exists idx_invoice_workflow_events_invoice on public.invoice_workflow_events(organization_id, invoice_id, created_at desc);
create index if not exists idx_invoice_versions_invoice on public.invoice_versions(organization_id, invoice_id, version_number desc);
create index if not exists idx_invoice_version_items_version on public.invoice_version_items(invoice_version_id, line_index);
create index if not exists idx_invoice_email_deliveries_invoice on public.invoice_email_deliveries(organization_id, invoice_id, created_at desc);
create index if not exists idx_invoice_email_deliveries_provider_email on public.invoice_email_deliveries(provider, provider_email_id) where provider_email_id is not null;
create index if not exists idx_invoice_email_events_provider_email on public.invoice_email_events(provider, provider_email_id, occurred_at desc);
create index if not exists idx_invoice_payment_records_invoice on public.invoice_payment_records(organization_id, invoice_id, created_at desc);
create index if not exists idx_invoice_payment_records_provider on public.invoice_payment_records(provider, provider_payment_id) where provider_payment_id is not null;
create unique index if not exists idx_invoice_payment_idempotency
  on public.invoice_payment_records(organization_id, invoice_id, idempotency_key)
  where idempotency_key is not null;

alter table public.invoice_workflow_events enable row level security;
alter table public.invoice_versions enable row level security;
alter table public.invoice_version_items enable row level security;
alter table public.invoice_email_deliveries enable row level security;
alter table public.invoice_email_events enable row level security;
alter table public.invoice_payment_records enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_workflow_events' and policyname = 'invoice workflow events read') then
    create policy "invoice workflow events read" on public.invoice_workflow_events for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_workflow_events' and policyname = 'invoice workflow events insert') then
    create policy "invoice workflow events insert" on public.invoice_workflow_events for insert with check (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_versions' and policyname = 'invoice versions read') then
    create policy "invoice versions read" on public.invoice_versions for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_version_items' and policyname = 'invoice version items read') then
    create policy "invoice version items read" on public.invoice_version_items for select using (public.can_read_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_email_deliveries' and policyname = 'invoice email deliveries read') then
    create policy "invoice email deliveries read" on public.invoice_email_deliveries for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_email_deliveries' and policyname = 'invoice email deliveries insert') then
    create policy "invoice email deliveries insert" on public.invoice_email_deliveries for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_email_deliveries' and policyname = 'invoice email deliveries update') then
    create policy "invoice email deliveries update" on public.invoice_email_deliveries for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_email_events' and policyname = 'invoice email events read') then
    create policy "invoice email events read" on public.invoice_email_events for select using (public.can_read_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_payment_records' and policyname = 'invoice payment records read') then
    create policy "invoice payment records read" on public.invoice_payment_records for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_payment_records' and policyname = 'invoice payment records insert') then
    create policy "invoice payment records insert" on public.invoice_payment_records for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_payment_records' and policyname = 'invoice payment records update') then
    create policy "invoice payment records update" on public.invoice_payment_records for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
end $$;

create or replace function public.invoice_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.insert_invoice_workflow_event(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_event_type text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns public.invoice_workflow_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.invoice_workflow_events;
begin
  insert into public.invoice_workflow_events(
    organization_id, invoice_id, actor_user_id, event_type, title, description, metadata
  ) values (
    p_organization_id, p_invoice_id, p_actor_user_id, p_event_type, p_title, p_description, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_event;
  return v_event;
end;
$$;

create or replace function public.create_invoice_version_snapshot(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_snapshot_reason text,
  p_actor_user_id uuid default null,
  p_delivery_id uuid default null,
  p_payment_record_id uuid default null,
  p_pdf_file_name text default null,
  p_pdf_mime_type text default null,
  p_pdf_size_bytes integer default null,
  p_pdf_sha256 text default null,
  p_invoice_version_pdf_url text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_version public.invoice_versions;
  v_version_number integer;
  v_line jsonb;
  v_index integer := 0;
  v_quantity numeric := 0;
  v_unit_price numeric := 0;
  v_vat_percentage numeric := 0;
  v_line_subtotal numeric := 0;
  v_line_vat numeric := 0;
  v_line_total numeric := 0;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric := 0;
  v_pdf_mime_type text := coalesce(nullif(trim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf');
begin
  if p_snapshot_reason not in ('sent_to_client','payment_created','paid','manual') then
    raise exception 'Ongeldige factuur snapshot reason: %', p_snapshot_reason using errcode = '23514';
  end if;

  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden' using errcode = '02000'; end if;

  for v_line in select * from jsonb_array_elements(coalesce(v_invoice.lines, '[]'::jsonb)) loop
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit_price := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_percentage := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
    v_vat_total := v_vat_total + v_line_vat;
    v_total := v_total + v_line_total;
  end loop;

  select coalesce(max(version_number), 0) + 1
    into v_version_number
  from public.invoice_versions
  where organization_id = p_organization_id
    and invoice_id = p_invoice_id;

  insert into public.invoice_versions(
    organization_id, invoice_id, delivery_id, payment_record_id, version_number, snapshot_reason,
    status_at_snapshot, invoice_number, client_id, project_id, quote_id, invoice_date, due_date, notes,
    subtotal_amount, vat_amount, total_amount, invoice_version_pdf_url, pdf_file_name, pdf_mime_type,
    pdf_size_bytes, pdf_sha256, snapshot_data, created_by
  ) values (
    p_organization_id, p_invoice_id, p_delivery_id, p_payment_record_id, v_version_number, p_snapshot_reason,
    v_invoice.status, v_invoice.number, v_invoice.client_id, v_invoice.project_id, v_invoice.quote_id, v_invoice.date, v_invoice.due_date, v_invoice.notes,
    round(v_subtotal, 2), round(v_vat_total, 2), round(v_total, 2), nullif(trim(coalesce(p_invoice_version_pdf_url, '')), ''),
    nullif(trim(coalesce(p_pdf_file_name, '')), ''), v_pdf_mime_type, p_pdf_size_bytes, nullif(trim(coalesce(p_pdf_sha256, '')), ''),
    jsonb_build_object(
      'invoice', to_jsonb(v_invoice) - 'public_token_hash',
      'totals', jsonb_build_object('subtotal', round(v_subtotal, 2), 'vat', round(v_vat_total, 2), 'total', round(v_total, 2)),
      'reason', p_snapshot_reason,
      'deliveryId', p_delivery_id,
      'paymentRecordId', p_payment_record_id,
      'pdf', jsonb_build_object('fileName', nullif(trim(coalesce(p_pdf_file_name, '')), ''), 'mimeType', v_pdf_mime_type, 'sizeBytes', p_pdf_size_bytes, 'sha256', nullif(trim(coalesce(p_pdf_sha256, '')), ''), 'url', nullif(trim(coalesce(p_invoice_version_pdf_url, '')), '')),
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    ),
    p_actor_user_id
  ) returning * into v_version;

  v_index := 0;
  for v_line in select * from jsonb_array_elements(coalesce(v_invoice.lines, '[]'::jsonb)) loop
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit_price := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_percentage := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);

    insert into public.invoice_version_items(
      organization_id, invoice_id, invoice_version_id, source_line_id, line_index,
      description, quantity, unit_price, vat_percentage, line_subtotal, line_vat, line_total
    ) values (
      p_organization_id, p_invoice_id, v_version.id, nullif(v_line->>'id', ''), v_index,
      coalesce(nullif(btrim(v_line->>'description'), ''), 'Regel ' || (v_index + 1)::text),
      v_quantity, v_unit_price, v_vat_percentage, v_line_subtotal, v_line_vat, v_line_total
    );
    v_index := v_index + 1;
  end loop;

  update public.invoices
     set latest_version_id = v_version.id,
         sent_version_id = case when p_snapshot_reason = 'sent_to_client' then v_version.id else sent_version_id end,
         paid_version_id = case when p_snapshot_reason = 'paid' then v_version.id else paid_version_id end,
         last_pdf_file_name = coalesce(nullif(trim(coalesce(p_pdf_file_name, '')), ''), last_pdf_file_name),
         last_pdf_mime_type = coalesce(v_pdf_mime_type, last_pdf_mime_type),
         last_pdf_size_bytes = coalesce(p_pdf_size_bytes, last_pdf_size_bytes),
         last_pdf_sha256 = coalesce(nullif(trim(coalesce(p_pdf_sha256, '')), ''), last_pdf_sha256),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'invoice_version_created',
    'Factuurversie vastgelegd',
    'Snapshot gemaakt: ' || p_snapshot_reason,
    jsonb_build_object('version_id', v_version.id, 'version_number', v_version.version_number, 'reason', p_snapshot_reason),
    p_actor_user_id
  );

  if p_pdf_file_name is not null then
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'invoice_pdf_attached',
      'PDF-snapshot gekoppeld',
      p_pdf_file_name,
      jsonb_build_object('version_id', v_version.id, 'sha256', p_pdf_sha256, 'size_bytes', p_pdf_size_bytes),
      p_actor_user_id
    );
  end if;

  return v_version;
end;
$$;

create or replace function public.convert_accepted_quote_to_invoice(p_quote_id uuid, p_organization_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_existing public.invoices;
  v_invoice public.invoices;
  v_user_id uuid := auth.uid();
  v_invoice_number text;
  v_due_date date := current_date + 14;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('quote_to_invoice'));

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden.' using errcode = '02000';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Alleen geaccepteerde offertes kunnen worden omgezet naar een factuur.' using errcode = '23514';
  end if;

  select * into v_existing
  from public.invoices
  where organization_id = p_organization_id
    and quote_id = p_quote_id
  order by created_at asc
  limit 1
  for update;

  if found then
    return v_existing;
  end if;

  v_invoice_number := public.allocate_next_invoice_number(p_organization_id, current_date);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, quote_id, number, date, due_date, lines, status, notes
  ) values (
    p_organization_id, v_user_id, v_quote.client_id, v_quote.project_id, v_quote.id, v_invoice_number, current_date, v_due_date, v_quote.lines, 'draft', v_quote.notes
  ) returning * into v_invoice;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_invoice.id,
    'created_from_quote',
    'Factuur aangemaakt uit offerte',
    'Factuur ' || v_invoice.number || ' is server-side aangemaakt uit offerte ' || v_quote.number || '.',
    jsonb_build_object('quote_id', v_quote.id, 'quote_number', v_quote.number),
    v_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id,
    v_user_id,
    'invoice_created_from_quote',
    'invoice',
    v_invoice.id,
    v_invoice.number,
    jsonb_build_object('title', 'Factuur aangemaakt uit offerte', 'quote_id', v_quote.id, 'quote_number', v_quote.number)
  );

  return v_invoice;
end;
$$;

create or replace function public.begin_invoice_email_send(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
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
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled') then raise exception 'Betaalde of geannuleerde facturen kunnen niet opnieuw worden verstuurd.' using errcode = '23514'; end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id
   returning * into v_invoice;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url)
  ) returning * into v_delivery;

  perform public.insert_invoice_workflow_event(p_organization_id, p_invoice_id, 'public_token_created', 'Publieke factuurlink aangemaakt', 'Veilige factuurlink klaargezet voor verzending.', jsonb_build_object('expires_at', p_token_expires_at), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id);
end;
$$;

create or replace function public.complete_invoice_email_send(
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
  v_invoice public.invoices;
  v_version public.invoice_versions;
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
     set status = case when status = 'draft' then 'sent' else status end,
         sent_at = coalesce(sent_at, now()),
         resend_last_email_id = nullif(btrim(p_provider_email_id), ''),
         last_email_delivery_status = 'sent',
         last_email_delivery_at = now(),
         updated_at = now()
   where id = v_delivery.invoice_id and organization_id = p_organization_id
   returning * into v_invoice;

  v_version := public.create_invoice_version_snapshot(
    v_delivery.invoice_id,
    p_organization_id,
    'sent_to_client',
    p_actor_user_id,
    v_delivery.id,
    null,
    v_delivery.attachment_file_name,
    v_delivery.attachment_mime_type,
    v_delivery.attachment_size_bytes,
    v_delivery.attachment_sha256,
    null,
    jsonb_build_object('provider_email_id', p_provider_email_id)
  );

  update public.invoice_email_deliveries
     set invoice_version_id = v_version.id,
         updated_at = now()
   where id = v_delivery.id
   returning * into v_delivery;

  perform public.insert_invoice_workflow_event(p_organization_id, v_invoice.id, 'sent_to_client', 'Factuur verzonden naar klant', 'Factuur ' || v_invoice.number || ' is via Resend verzonden.', jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'version_id', v_version.id), p_actor_user_id);

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'invoice_sent_to_client', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'version_id', v_version.id));

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'invoice', to_jsonb(v_invoice), 'version', to_jsonb(v_version));
end;
$$;

create or replace function public.fail_invoice_email_send(
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
begin
  select * into v_delivery
  from public.invoice_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;

  if not found then return; end if;

  update public.invoice_email_deliveries
     set status = 'failed',
         failed_at = now(),
         last_event_at = now(),
         error_message = left(coalesce(p_error_message, 'Onbekende fout'), 1000),
         updated_at = now()
   where id = v_delivery.id;

  update public.invoices
     set last_email_delivery_status = 'failed',
         last_email_failed_at = now(),
         updated_at = now()
   where id = v_delivery.invoice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(p_organization_id, v_delivery.invoice_id, 'email_failed', 'Factuurmail mislukt', left(coalesce(p_error_message, 'Onbekende fout'), 1000), jsonb_build_object('delivery_id', v_delivery.id), p_actor_user_id);
end;
$$;

create or replace function public.begin_invoice_payment_checkout(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_amount_cents integer,
  p_public_token_hash text default null,
  p_public_token_expires_at timestamptz default null,
  p_currency text default 'EUR',
  p_idempotency_key text default null,
  p_checkout_expires_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing public.invoice_payment_records;
  v_payment public.invoice_payment_records;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status = 'paid' then raise exception 'Deze factuur is al betaald.' using errcode = '23514'; end if;
  if p_amount_cents <= 0 then raise exception 'Factuurbedrag moet groter zijn dan 0.' using errcode = '23514'; end if;

  if p_public_token_hash is not null and (v_invoice.public_token_hash is null or coalesce(v_invoice.public_token_expires_at, now() - interval '1 second') < now()) then
    update public.invoices
       set public_token_hash = p_public_token_hash,
           public_token_created_at = now(),
           public_token_expires_at = coalesce(p_public_token_expires_at, now() + interval '60 days'),
           updated_at = now()
     where id = v_invoice.id and organization_id = p_organization_id
     returning * into v_invoice;

    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'public_token_created',
      'Publieke factuurlink aangemaakt',
      'Veilige factuurlink klaargezet voor de betaallink.',
      jsonb_build_object('expires_at', coalesce(p_public_token_expires_at, now() + interval '60 days')),
      p_actor_user_id
    );
  end if;

  select * into v_existing
  from public.invoice_payment_records
  where organization_id = p_organization_id
    and invoice_id = p_invoice_id
    and status in ('open','pending','authorized')
    and provider_checkout_url is not null
  order by created_at desc
  limit 1;

  if found then return v_existing; end if;

  insert into public.invoice_payment_records(
    organization_id, invoice_id, created_by, amount_cents, currency, status, idempotency_key, checkout_expires_at, metadata
  ) values (
    p_organization_id, p_invoice_id, p_actor_user_id, p_amount_cents, upper(coalesce(nullif(btrim(p_currency), ''), 'EUR')), 'open', nullif(btrim(coalesce(p_idempotency_key, '')), ''), p_checkout_expires_at, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_payment;

  return v_payment;
end;
$$;

create or replace function public.complete_invoice_payment_checkout(
  p_payment_record_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_payment_id text,
  p_provider_checkout_url text,
  p_status text default 'open',
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  update public.invoice_payment_records
     set provider_payment_id = nullif(btrim(p_provider_payment_id), ''),
         provider_checkout_url = nullif(btrim(p_provider_checkout_url), ''),
         status = coalesce(nullif(btrim(p_status), ''), 'open'),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = p_payment_record_id and organization_id = p_organization_id
   returning * into v_payment;

  if not found then raise exception 'Payment record niet gevonden.' using errcode = '02000'; end if;

  perform public.insert_invoice_workflow_event(p_organization_id, v_payment.invoice_id, 'payment_link_created', 'Mollie-betaallink aangemaakt', 'Betaallink klaar voor factuurbetaling.', jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id), p_actor_user_id);

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  select p_organization_id, p_actor_user_id, 'invoice_payment_link_created', 'invoice', i.id, i.number,
         jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id)
  from public.invoices i
  where i.id = v_payment.invoice_id;

  return v_payment;
end;
$$;

create or replace function public.update_invoice_payment_status(
  p_provider_payment_id text,
  p_status text,
  p_paid_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_invoice public.invoices;
  v_event_type text;
  v_title text;
begin
  select * into v_payment
  from public.invoice_payment_records
  where provider = 'mollie'
    and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden voor provider-payment-id.' using errcode = '02000';
  end if;

  update public.invoice_payment_records
     set status = p_status,
         paid_at = case when p_status = 'paid' then coalesce(p_paid_at, now()) else paid_at end,
         last_webhook_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = v_payment.id
   returning * into v_payment;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id and organization_id = v_payment.organization_id
  for update;

  if p_status = 'paid' then
    update public.invoices
       set status = 'paid',
           paid_at = coalesce(v_payment.paid_at, now()),
           updated_at = now()
     where id = v_invoice.id
     returning * into v_invoice;

    perform public.create_invoice_version_snapshot(v_invoice.id, v_invoice.organization_id, 'paid', null, null, v_payment.id, v_invoice.last_pdf_file_name, v_invoice.last_pdf_mime_type, v_invoice.last_pdf_size_bytes, v_invoice.last_pdf_sha256, null, jsonb_build_object('provider_payment_id', p_provider_payment_id));
  end if;

  v_event_type := case
    when p_status = 'paid' then 'payment_paid'
    when p_status = 'expired' then 'payment_expired'
    when p_status in ('failed','canceled') then 'payment_failed'
    else 'payment_open'
  end;
  v_title := case
    when p_status = 'paid' then 'Factuur betaald'
    when p_status = 'expired' then 'Betaallink verlopen'
    when p_status in ('failed','canceled') then 'Betaling mislukt'
    else 'Betaalstatus bijgewerkt'
  end;

  perform public.insert_invoice_workflow_event(v_invoice.organization_id, v_invoice.id, v_event_type, v_title, 'Mollie status: ' || p_status, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id, 'status', p_status), null);

  if p_status = 'paid' then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'invoice_paid', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id));
  end if;

  return v_payment;
end;
$$;

-- Explicit audit vocabulary used by the workflow above.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_logs'::regclass
      and conname = 'audit_logs_action_check'
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
      'invoice_created_from_quote','invoice_sent_to_client','invoice_payment_link_created','invoice_paid'
    ));
end $$;

revoke execute on function public.reconcile_invoice_number_sequence(uuid, integer) from public, anon, authenticated;
revoke execute on function public.allocate_next_invoice_number(uuid, date) from public, anon, authenticated;
revoke execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) from public, anon;
revoke execute on function public.preview_next_invoice_number(uuid, date) from public, anon;

grant execute on function public.preview_next_invoice_number(uuid, date) to authenticated;
grant execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) to authenticated;

revoke execute on function public.insert_invoice_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.create_invoice_version_snapshot(uuid, uuid, text, uuid, uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
revoke execute on function public.complete_invoice_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_invoice_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamptz, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.complete_invoice_payment_checkout(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.update_invoice_payment_status(text, text, timestamptz, jsonb) from public, anon, authenticated;

grant execute on function public.insert_invoice_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) to service_role;
grant execute on function public.create_invoice_version_snapshot(uuid, uuid, text, uuid, uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
grant execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text) to service_role;
grant execute on function public.complete_invoice_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_invoice_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamptz, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.complete_invoice_payment_checkout(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.update_invoice_payment_status(text, text, timestamptz, jsonb) to service_role;

commit;
