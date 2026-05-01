-- BrandCore migration: bedrijfsinstellingen + uploadbare factuurtemplate
-- Voor bestaande databases. Voor nieuwe databases zit dit al in BRANDCORE_DATABASE_SETUP.sql.

create table if not exists public.company_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  company_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.company_settings
  add column if not exists trade_name text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists postal_code text,
  add column if not exists city text,
  add column if not exists country text not null default 'Nederland',
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists website text,
  add column if not exists kvk_number text,
  add column if not exists vat_number text,
  add column if not exists iban text,
  add column if not exists invoice_payment_terms text,
  add column if not exists invoice_footer text,
  add column if not exists invoice_template_kind text not null default 'none',
  add column if not exists invoice_template_file_name text,
  add column if not exists invoice_template_mime_type text,
  add column if not exists invoice_template_file_size bigint not null default 0,
  add column if not exists invoice_template_data_url text,
  add column if not exists invoice_template_text_color text not null default '#1a1a1a',
  add column if not exists invoice_accent_color text not null default '#FFD966',
  add column if not exists invoice_template_updated_at timestamptz;

alter table public.company_settings
  drop constraint if exists company_settings_invoice_template_kind_check;

alter table public.company_settings
  add constraint company_settings_invoice_template_kind_check
  check (invoice_template_kind in ('none','pdf','image'));

drop trigger if exists company_settings_updated on public.company_settings;
create trigger company_settings_updated
before update on public.company_settings
for each row execute function public.set_updated_at();

alter table public.company_settings enable row level security;

drop policy if exists "own company settings" on public.company_settings;
create policy "own company settings" on public.company_settings
for all using (auth.uid() = user_id)
with check (auth.uid() = user_id);
