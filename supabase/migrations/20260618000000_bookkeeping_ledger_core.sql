-- ============================================================
-- ResoFly — Boekhouding fase 1: grootboek + inkoopfacturen
-- Date: 2026-06-18
--
-- Context:
-- ResoFly heeft een sterke verkoopkant (offertes -> facturen -> Mollie ->
-- creditnota's) maar nog geen echte boekhouding. Deze migratie legt het
-- dubbel-boekhoudfundament: een rekeningschema (ledger_accounts), BTW-codes met
-- aangifte-mapping (vat_codes), journaalposten met debet/credit (journal_entries
-- + journal_lines) en de inkoopzijde (suppliers + purchase_invoices).
--
-- Kernbeslissingen (vastgelegd met de gebruiker):
--  1. Afronding BTW: post_journal_entry dwingt Sigma-debet = Sigma-credit af; een
--     klein restant (binnen tolerantie 2 cent x aantal regels) wordt geboekt op
--     de systeemrekening "Afrondingsverschillen", daarbuiten faalt de post.
--  2. Beginbalans: company_settings.bookkeeping_start_date is de knipdatum;
--     create_opening_balance zet de beginstanden in 1 onveranderbaar boekstuk.
--  3. Afgesloten perioden: closed_periods registreert gefinaliseerde kwartalen;
--     post_journal_entry weigert boekstukken met een datum in een afgesloten
--     periode (de finalisatie zelf komt in fase 4).
--
-- Bedragen staan in hele centen (bigint), consistent met de bestaande
-- betaal-/refund-tabellen. Posted boekstukken zijn onveranderbaar: journal_*-
-- tabellen hebben geen schrijf-policies, alle boekingen lopen via security
-- definer RPC's; corrigeren gaat via reverse_journal_entry (tegenboeking).
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- ------------------------------------------------------------
-- 0. Boekhoud-velden op company_settings
-- ------------------------------------------------------------
alter table public.company_settings
  add column if not exists bookkeeping_start_date date,
  add column if not exists kor_enabled boolean not null default false;

-- Gedeelde updated_at-trigger voor de nieuwe boekhoudtabellen.
create or replace function public.bookkeeping_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

-- ------------------------------------------------------------
-- 1. Rekeningschema (grootboekrekeningen)
-- ------------------------------------------------------------
create table if not exists public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  code text not null,
  name text not null,
  type text not null,
  subtype text,
  default_vat_code text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ledger_accounts_type_check check (type in ('asset','liability','equity','revenue','expense')),
  constraint ledger_accounts_code_not_blank check (length(btrim(code)) > 0),
  constraint ledger_accounts_name_not_blank check (length(btrim(name)) > 0),
  constraint ledger_accounts_code_unique unique (organization_id, code)
);
create index if not exists idx_ledger_accounts_org on public.ledger_accounts(organization_id, code);

-- ------------------------------------------------------------
-- 2. BTW-codes met aangifte-mapping
-- ------------------------------------------------------------
create table if not exists public.vat_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  code text not null,
  label text not null,
  rate numeric(5,2) not null default 0,
  kind text not null,
  -- Rubriek (vak) op de Nederlandse BTW-aangifte. sales_box voor de omzet/
  -- grondslag, vat_box voor de BTW zelf. Gebruikt door compute_vat_return (fase 4).
  sales_box text,
  vat_box text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vat_codes_kind_check check (kind in (
    'standard','reduced','zero','exempt',
    'reverse_charge_sales','reverse_charge_purchase',
    'icp_goods','icp_services','eu_acquisition','kor'
  )),
  constraint vat_codes_code_unique unique (organization_id, code)
);
create index if not exists idx_vat_codes_org on public.vat_codes(organization_id, code);

-- ------------------------------------------------------------
-- 3. Journaalposten (boekstukken)
-- ------------------------------------------------------------
create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  entry_number text,
  date date not null default current_date,
  year integer not null,
  quarter smallint not null,
  month smallint not null,
  description text,
  source_type text not null default 'manual',
  source_id uuid,
  status text not null default 'draft',
  reverses_entry_id uuid references public.journal_entries(id) on delete set null,
  reversed_by_entry_id uuid references public.journal_entries(id) on delete set null,
  posted_at timestamptz,
  posted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_entries_status_check check (status in ('draft','posted','reversed')),
  constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation',
    'vat_return','payment','opening_balance','manual'
  )),
  constraint journal_entries_quarter_check check (quarter between 1 and 4),
  constraint journal_entries_month_check check (month between 1 and 12)
);
create index if not exists idx_journal_entries_org on public.journal_entries(organization_id, date desc);
create index if not exists idx_journal_entries_period on public.journal_entries(organization_id, year, quarter);
create index if not exists idx_journal_entries_source on public.journal_entries(organization_id, source_type, source_id);

-- ------------------------------------------------------------
-- 4. Boekingsregels
-- ------------------------------------------------------------
create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  line_index integer not null default 0,
  description text,
  debit_cents bigint not null default 0,
  credit_cents bigint not null default 0,
  vat_code text,
  vat_rate numeric(5,2),
  vat_base_cents bigint,
  vat_amount_cents bigint,
  client_id uuid references public.clients(id) on delete set null,
  supplier_id uuid,
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint journal_lines_debit_nonneg check (debit_cents >= 0),
  constraint journal_lines_credit_nonneg check (credit_cents >= 0),
  constraint journal_lines_single_side check (not (debit_cents > 0 and credit_cents > 0))
);
create index if not exists idx_journal_lines_entry on public.journal_lines(entry_id, line_index);
create index if not exists idx_journal_lines_account on public.journal_lines(organization_id, account_id);

-- ------------------------------------------------------------
-- 5. Afgesloten perioden (gevuld door finalize_vat_return in fase 4)
-- ------------------------------------------------------------
create table if not exists public.closed_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  year integer not null,
  quarter smallint not null,
  closed_at timestamptz not null default now(),
  closed_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint closed_periods_quarter_check check (quarter between 1 and 4),
  constraint closed_periods_unique unique (organization_id, year, quarter)
);

-- ------------------------------------------------------------
-- 6. Leveranciers (crediteuren) — spiegel van clients
-- ------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  supplier_code text,
  contact_name text,
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  city text,
  country text,
  vat_number text,
  kvk_number text,
  iban text,
  default_expense_account_id uuid references public.ledger_accounts(id) on delete set null,
  default_vat_code text,
  notes text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_name_not_blank check (length(btrim(name)) > 0),
  constraint suppliers_status_check check (status in ('active','inactive'))
);
create index if not exists idx_suppliers_org on public.suppliers(organization_id, name);

-- Nu suppliers bestaat: koppel journal_lines.supplier_id.
alter table public.journal_lines
  drop constraint if exists journal_lines_supplier_fk;
alter table public.journal_lines
  add constraint journal_lines_supplier_fk
  foreign key (supplier_id) references public.suppliers(id) on delete set null;

-- ------------------------------------------------------------
-- 7. Inkoopfacturen
-- ------------------------------------------------------------
create table if not exists public.purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  supplier_id uuid references public.suppliers(id) on delete restrict,
  supplier_invoice_number text,
  internal_number text,
  date date not null default current_date,
  due_date date,
  -- lines (jsonb array): { id, description, amount_cents (excl btw), vat_code, vat_rate, account_id }
  lines jsonb not null default '[]'::jsonb,
  subtotal_cents bigint not null default 0,
  vat_cents bigint not null default 0,
  total_cents bigint not null default 0,
  currency text not null default 'EUR',
  status text not null default 'draft',
  payment_status text not null default 'unpaid',
  paid_at timestamptz,
  project_id uuid references public.projects(id) on delete set null,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_invoices_status_check check (status in ('draft','booked','paid','cancelled')),
  constraint purchase_invoices_payment_status_check check (payment_status in ('unpaid','partially_paid','paid'))
);
create index if not exists idx_purchase_invoices_org on public.purchase_invoices(organization_id, date desc);
create index if not exists idx_purchase_invoices_supplier on public.purchase_invoices(organization_id, supplier_id);

-- ------------------------------------------------------------
-- 8. Triggers (updated_at, org-lock, audit)
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['ledger_accounts','vat_codes','journal_entries','suppliers','purchase_invoices']
  loop
    execute format('drop trigger if exists %1$s_touch_updated_at on public.%1$s', t);
    execute format('create trigger %1$s_touch_updated_at before update on public.%1$s for each row execute function public.bookkeeping_touch_updated_at()', t);
    execute format('drop trigger if exists %1$s_prevent_org_change on public.%1$s', t);
    execute format('create trigger %1$s_prevent_org_change before update of organization_id on public.%1$s for each row execute function public.prevent_organization_id_change()', t);
  end loop;
end $$;

drop trigger if exists ledger_accounts_audit on public.ledger_accounts;
create trigger ledger_accounts_audit after insert or update or delete on public.ledger_accounts
  for each row execute function public.audit_row_change('ledger_account', 'name');

drop trigger if exists suppliers_audit on public.suppliers;
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function public.audit_row_change('supplier', 'name');

drop trigger if exists purchase_invoices_audit on public.purchase_invoices;
create trigger purchase_invoices_audit after insert or update or delete on public.purchase_invoices
  for each row execute function public.audit_row_change('purchase_invoice', 'internal_number');

drop trigger if exists journal_entries_audit on public.journal_entries;
create trigger journal_entries_audit after insert or update or delete on public.journal_entries
  for each row execute function public.audit_row_change('journal_entry', 'description');

-- ------------------------------------------------------------
-- 9. Row level security
-- Lezen: actieve organisatieleden. Schrijven op de stamdata (rekeningschema,
-- BTW-codes, leveranciers, inkoopfacturen): can_write_org. De journaal-tabellen
-- en closed_periods krijgen bewust GEEN schrijf-policy: posten loopt uitsluitend
-- via de security definer RPC's, waardoor posted boekstukken onveranderbaar zijn.
-- ------------------------------------------------------------
alter table public.ledger_accounts enable row level security;
alter table public.vat_codes enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;
alter table public.closed_periods enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchase_invoices enable row level security;

-- Alleen-lezen tabellen (schrijven via RPC).
do $$
declare
  t text;
begin
  foreach t in array array['journal_entries','journal_lines','closed_periods']
  loop
    execute format('drop policy if exists "%1$s read" on public.%1$s', t);
    execute format('create policy "%1$s read" on public.%1$s for select using (public.can_read_org(organization_id))', t);
  end loop;
end $$;

-- Volledige CRUD-tabellen (rekeningschema, btw-codes, leveranciers, inkoop).
do $$
declare
  t text;
begin
  foreach t in array array['ledger_accounts','vat_codes','suppliers','purchase_invoices']
  loop
    execute format('drop policy if exists "%1$s read" on public.%1$s', t);
    execute format('create policy "%1$s read" on public.%1$s for select using (public.can_read_org(organization_id))', t);
    execute format('drop policy if exists "%1$s insert" on public.%1$s', t);
    execute format('create policy "%1$s insert" on public.%1$s for insert with check (public.can_write_org(organization_id) and created_by = auth.uid())', t);
    execute format('drop policy if exists "%1$s update" on public.%1$s', t);
    execute format('create policy "%1$s update" on public.%1$s for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id))', t);
  end loop;
end $$;

-- Verwijderen: leveranciers en inkoopfacturen vrij; systeem-grootboekrekeningen
-- en -btw-codes mogen niet weg.
drop policy if exists "suppliers delete" on public.suppliers;
create policy "suppliers delete" on public.suppliers for delete using (public.can_write_org(organization_id));
drop policy if exists "purchase_invoices delete" on public.purchase_invoices;
create policy "purchase_invoices delete" on public.purchase_invoices for delete using (public.can_write_org(organization_id) and status = 'draft');
drop policy if exists "ledger_accounts delete" on public.ledger_accounts;
create policy "ledger_accounts delete" on public.ledger_accounts for delete using (public.can_write_org(organization_id) and is_system = false);
drop policy if exists "vat_codes delete" on public.vat_codes;
create policy "vat_codes delete" on public.vat_codes for delete using (public.can_write_org(organization_id) and is_system = false);

-- ------------------------------------------------------------
-- 10. Seed: standaard rekeningschema + BTW-codes per organisatie
-- ------------------------------------------------------------
create or replace function public.ensure_default_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system)
  values
    (p_organization_id, '0100', 'Vaste activa', 'asset', 'fixed_asset', null, true),
    (p_organization_id, '0150', 'Cumulatieve afschrijving', 'asset', 'accumulated_depreciation', null, true),
    (p_organization_id, '0500', 'Eigen vermogen', 'equity', 'equity', null, true),
    (p_organization_id, '1100', 'Bank', 'asset', 'bank', null, true),
    (p_organization_id, '1300', 'Debiteuren', 'asset', 'accounts_receivable', null, true),
    (p_organization_id, '1500', 'Te vorderen BTW (voorbelasting)', 'asset', 'vat_input', null, true),
    (p_organization_id, '1510', 'Af te dragen BTW (verkoop)', 'liability', 'vat_output', null, true),
    (p_organization_id, '1520', 'Af te dragen BTW verlegd/ICP', 'liability', 'vat_reverse', null, true),
    (p_organization_id, '1530', 'Te betalen omzetbelasting', 'liability', 'vat_payable', null, true),
    (p_organization_id, '1600', 'Crediteuren', 'liability', 'accounts_payable', null, true),
    (p_organization_id, '4000', 'Afschrijvingskosten', 'expense', 'depreciation', null, true),
    (p_organization_id, '4500', 'Algemene kosten', 'expense', 'general_cost', 'HOOG', false),
    (p_organization_id, '4900', 'Afrondingsverschillen', 'expense', 'rounding', null, true),
    (p_organization_id, '8000', 'Omzet hoog (21%)', 'revenue', 'sales', 'HOOG', false),
    (p_organization_id, '8010', 'Omzet laag (9%)', 'revenue', 'sales', 'LAAG', false),
    (p_organization_id, '8020', 'Omzet 0% / vrijgesteld', 'revenue', 'sales', 'NUL', false),
    (p_organization_id, '8030', 'Omzet buitenland (ICP/verlegd)', 'revenue', 'sales', 'ICP_DIENST', false)
  on conflict (organization_id, code) do nothing;

  insert into public.vat_codes (organization_id, code, label, rate, kind, sales_box, vat_box, is_system)
  values
    (p_organization_id, 'HOOG', 'BTW 21%', 21, 'standard', '1a', '1a', true),
    (p_organization_id, 'LAAG', 'BTW 9%', 9, 'reduced', '1b', '1b', true),
    (p_organization_id, 'NUL', 'BTW 0%', 0, 'zero', '1e', null, true),
    (p_organization_id, 'VRIJ', 'Vrijgesteld', 0, 'exempt', null, null, true),
    (p_organization_id, 'VERL_VERK', 'BTW verlegd (verkoop)', 0, 'reverse_charge_sales', '1e', null, true),
    (p_organization_id, 'VERL_INK', 'BTW verlegd (inkoop)', 21, 'reverse_charge_purchase', '2a', '5b', true),
    (p_organization_id, 'ICP_GOED', 'ICP goederen', 0, 'icp_goods', '3b', null, true),
    (p_organization_id, 'ICP_DIENST', 'ICP diensten', 0, 'icp_services', '3b', null, true),
    (p_organization_id, 'EU_VERW', 'Verwerving EU (verlegd)', 21, 'eu_acquisition', '4b', '5b', true),
    (p_organization_id, 'KOR', 'KOR (vrijgesteld, geen aftrek)', 0, 'kor', null, null, true)
  on conflict (organization_id, code) do nothing;
end;
$$;

-- Rekening-id opzoeken op code (na seed). Faalt expliciet als de rekening ontbreekt.
create or replace function public.bookkeeping_account_id(p_organization_id uuid, p_code text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.ledger_accounts
  where organization_id = p_organization_id and code = p_code;
  if v_id is null then
    raise exception 'Grootboekrekening % ontbreekt. Voer eerst ensure_default_ledger_accounts uit.', p_code using errcode = '02000';
  end if;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 11. Kernfunctie: journaalpost boeken (balans + afronding + periodeslot)
-- ------------------------------------------------------------
create or replace function public.post_journal_entry(
  p_organization_id uuid,
  p_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.journal_entries;
  v_year integer := extract(year from p_date)::int;
  v_quarter smallint := extract(quarter from p_date)::smallint;
  v_month smallint := extract(month from p_date)::smallint;
  v_seq bigint;
  v_number text;
  v_line jsonb;
  v_idx integer := 0;
  v_account uuid;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_diff bigint;
  v_count integer;
  v_tolerance bigint;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- Periodeslot: weiger boeken in een afgesloten kwartaal.
  if exists (
    select 1 from public.closed_periods
    where organization_id = p_organization_id and year = v_year and quarter = v_quarter
  ) then
    raise exception 'Kwartaal Q%-% is afgesloten; deze post valt in de eerstvolgende open aangifteperiode.', v_quarter, v_year
      using errcode = '23514';
  end if;

  -- Zorg dat het rekeningschema (incl. Afrondingsverschillen) bestaat.
  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Boekstuknummer (per organisatie per jaar), serieel onder advisory lock.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_year::text));
  select count(*) + 1 into v_seq from public.journal_entries
  where organization_id = p_organization_id and year = v_year;
  v_number := 'JP-' || v_year || '-' || lpad(v_seq::text, 5, '0');

  insert into public.journal_entries(
    organization_id, created_by, entry_number, date, year, quarter, month,
    description, source_type, source_id, status
  ) values (
    p_organization_id, p_created_by, v_number, p_date, v_year, v_quarter, v_month,
    p_description, coalesce(p_source_type, 'manual'), p_source_id, 'draft'
  ) returning * into v_entry;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if (v_line ? 'account_id') and nullif(v_line->>'account_id','') is not null then
      v_account := (v_line->>'account_id')::uuid;
    else
      v_account := public.bookkeeping_account_id(p_organization_id, v_line->>'account_code');
    end if;

    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;

    insert into public.journal_lines(
      organization_id, entry_id, account_id, line_index, description,
      debit_cents, credit_cents, vat_code, vat_rate, vat_base_cents, vat_amount_cents,
      client_id, supplier_id, project_id
    ) values (
      p_organization_id, v_entry.id, v_account, v_idx, nullif(v_line->>'description',''),
      v_debit, v_credit,
      nullif(v_line->>'vat_code',''),
      nullif(v_line->>'vat_rate','')::numeric,
      nullif(v_line->>'vat_base_cents','')::bigint,
      nullif(v_line->>'vat_amount_cents','')::bigint,
      nullif(v_line->>'client_id','')::uuid,
      nullif(v_line->>'supplier_id','')::uuid,
      nullif(v_line->>'project_id','')::uuid
    );
    v_idx := v_idx + 1;
  end loop;

  -- Balanscontrole met afrondingsvangnet (beslissing 1).
  v_diff := v_total_debit - v_total_credit;
  v_count := v_idx;
  v_tolerance := greatest(2 * v_count, 2);

  if v_diff <> 0 then
    if abs(v_diff) <= v_tolerance then
      -- Sluitregel op Afrondingsverschillen.
      v_account := public.bookkeeping_account_id(p_organization_id, '4900');
      insert into public.journal_lines(
        organization_id, entry_id, account_id, line_index, description,
        debit_cents, credit_cents
      ) values (
        p_organization_id, v_entry.id, v_account, v_idx, 'Afrondingsverschil',
        case when v_diff < 0 then -v_diff else 0 end,
        case when v_diff > 0 then v_diff else 0 end
      );
    else
      raise exception 'Journaalpost niet in balans: debet % ≠ credit % (verschil % cent).',
        v_total_debit, v_total_credit, v_diff using errcode = '23514';
    end if;
  end if;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = p_created_by
  where id = v_entry.id
  returning * into v_entry;

  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 12. Tegenboeking (correctie van een posted boekstuk)
-- ------------------------------------------------------------
create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
begin
  select * into v_src from public.journal_entries where id = p_entry_id;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not public.can_write_org(v_src.organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if v_src.status <> 'posted' then
    raise exception 'Alleen een geboekt (posted) boekstuk kan worden tegengeboekt.' using errcode = '23514';
  end if;

  -- Wissel debet/credit per regel om.
  select jsonb_agg(jsonb_build_object(
    'account_id', jl.account_id,
    'description', coalesce(jl.description, '') || ' (tegenboeking)',
    'debit_cents', jl.credit_cents,
    'credit_cents', jl.debit_cents,
    'vat_code', jl.vat_code,
    'vat_rate', jl.vat_rate,
    'vat_base_cents', case when jl.vat_base_cents is null then null else -jl.vat_base_cents end,
    'vat_amount_cents', case when jl.vat_amount_cents is null then null else -jl.vat_amount_cents end,
    'client_id', jl.client_id,
    'supplier_id', jl.supplier_id,
    'project_id', jl.project_id
  ) order by jl.line_index)
  into v_lines
  from public.journal_lines jl
  where jl.entry_id = p_entry_id;

  v_reversal := public.post_journal_entry(
    v_src.organization_id,
    coalesce(p_date, current_date),
    'Tegenboeking van ' || coalesce(v_src.entry_number, v_src.id::text),
    v_src.source_type,
    v_src.source_id,
    v_lines,
    p_created_by
  );

  update public.journal_entries set reverses_entry_id = v_src.id where id = v_reversal.id;
  update public.journal_entries set status = 'reversed', reversed_by_entry_id = v_reversal.id where id = v_src.id;

  return v_reversal;
end;
$$;

-- ------------------------------------------------------------
-- 13. Inkoopfactuur boeken naar het grootboek
-- ------------------------------------------------------------
create or replace function public.book_purchase_invoice(
  p_organization_id uuid,
  p_purchase_invoice_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_expense jsonb := '[]'::jsonb;
  v_input_vat bigint := 0;
  v_reverse_vat bigint := 0;
  v_creditors bigint := 0;
  v_entry public.journal_entries;
  r record;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000';
  end if;
  if v_pi.status <> 'draft' then
    raise exception 'Inkoopfactuur is al geboekt of geannuleerd.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  select coalesce(kor_enabled, false) into v_kor from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  -- Aggregeer per kostenrekening + tariefgroep; rond de BTW per groep (beslissing 1).
  for r in
    select
      coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, '4500')) as account_id,
      coalesce(vc.kind, 'standard') as kind,
      coalesce(nullif(l->>'vat_rate','')::numeric, vc.rate, 0) as rate,
      sum(coalesce((l->>'amount_cents')::bigint, 0)) as base_cents
    from jsonb_array_elements(v_pi.lines) as l
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id and vc.code = (l->>'vat_code')
    group by 1, 2, 3
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_expense_debit bigint := r.base_cents;
    begin
      if v_kor then
        -- KOR: geen aftrek; BTW wordt onderdeel van de kosten.
        v_expense_debit := r.base_cents + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      elsif r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services') then
        -- Verlegd/ICP: zelf afdragen én aftrekken; leverancier factureert excl. BTW.
        v_input_vat := v_input_vat + v_vat;
        v_reverse_vat := v_reverse_vat + v_vat;
        v_creditors := v_creditors + r.base_cents;
      else
        -- Normaal binnenland (21/9/0/vrijgesteld).
        v_input_vat := v_input_vat + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      end if;

      v_expense := v_expense || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id,
        'description', 'Inkoopkosten',
        'debit_cents', v_expense_debit,
        'credit_cents', 0,
        'vat_code', null,
        'vat_rate', r.rate,
        'vat_base_cents', r.base_cents,
        'vat_amount_cents', v_vat,
        'supplier_id', v_pi.supplier_id
      ));
    end;
  end loop;

  v_lines := v_expense;

  if v_input_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Voorbelasting',
      'debit_cents', v_input_vat, 'credit_cents', 0,
      'supplier_id', v_pi.supplier_id
    ));
  end if;
  if v_reverse_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Verschuldigde BTW verlegd/ICP',
      'debit_cents', 0, 'credit_cents', v_reverse_vat,
      'supplier_id', v_pi.supplier_id
    ));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
    'description', 'Crediteuren',
    'debit_cents', 0, 'credit_cents', v_creditors,
    'supplier_id', v_pi.supplier_id
  ));

  v_entry := public.post_journal_entry(
    p_organization_id, v_pi.date,
    'Inkoopfactuur ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
    'purchase_invoice', v_pi.id, v_lines, p_created_by
  );

  update public.purchase_invoices
  set status = 'booked', journal_entry_id = v_entry.id
  where id = v_pi.id;

  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 14. Verkoopfactuur naar het grootboek boeken (brug AR -> grootboek)
-- ------------------------------------------------------------
create or replace function public.post_sales_invoice_to_ledger(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_start date;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_output_vat bigint := 0;
  v_receivable bigint := 0;
  v_entry public.journal_entries;
  r record;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = '02000';
  end if;
  if v_inv.journal_entry_id is not null then
    raise exception 'Deze factuur is al naar het grootboek geboekt.' using errcode = '23514';
  end if;

  select bookkeeping_start_date, coalesce(kor_enabled, false)
    into v_start, v_kor
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  if v_start is not null and v_inv.date < v_start then
    raise exception 'Factuurdatum ligt vóór de boekhoud-startdatum (%); deze omzet zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Omzet per tariefgroep; BTW per groep afgerond (beslissing 1).
  for r in
    select
      coalesce((line->>'vat')::numeric, 0) as rate,
      sum(round(coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unit_price')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(v_inv.lines) as line
    group by 1
  loop
    declare
      v_rate numeric := r.rate;
      v_vat bigint := case when v_kor then 0 else round(r.base_cents * r.rate / 100.0) end;
      v_revenue_account text := case
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', 0, 'credit_cents', r.base_cents,
        'vat_rate', v_rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', 0, 'credit_cents', v_output_vat,
      'client_id', v_inv.client_id
    ));
  end if;

  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
    'description', 'Debiteuren',
    'debit_cents', v_receivable, 'credit_cents', 0,
    'client_id', v_inv.client_id
  )) || v_lines;

  v_entry := public.post_journal_entry(
    p_organization_id, v_inv.date,
    'Verkoopfactuur ' || coalesce(v_inv.number, ''),
    'sales_invoice', v_inv.id, v_lines, p_created_by
  );

  update public.invoices set journal_entry_id = v_entry.id where id = v_inv.id;
  return v_entry;
end;
$$;

-- Koppelkolom op verkoopfacturen.
alter table public.invoices
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;

-- ------------------------------------------------------------
-- 15. Beginbalans (beslissing 2)
-- ------------------------------------------------------------
create or replace function public.create_opening_balance(
  p_organization_id uuid,
  p_as_of_date date,
  p_lines jsonb,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines jsonb;
  v_debit bigint;
  v_credit bigint;
  v_equity bigint;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Beginbalans heeft minimaal één regel nodig.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluit het verschil op eigen vermogen zodat de openingsbalans in balans is.
  select coalesce(sum(coalesce((l->>'debit_cents')::bigint,0)),0),
         coalesce(sum(coalesce((l->>'credit_cents')::bigint,0)),0)
    into v_debit, v_credit
  from jsonb_array_elements(p_lines) l;

  v_lines := p_lines;
  v_equity := v_debit - v_credit;
  if v_equity <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '0500'),
      'description', 'Eigen vermogen (sluitpost beginbalans)',
      'debit_cents', case when v_equity < 0 then -v_equity else 0 end,
      'credit_cents', case when v_equity > 0 then v_equity else 0 end
    ));
  end if;

  return public.post_journal_entry(
    p_organization_id, p_as_of_date, 'Beginbalans per ' || p_as_of_date,
    'opening_balance', null, v_lines, p_created_by
  );
end;
$$;

commit;

-- ------------------------------------------------------------
-- 16. Attachments mogen aan leveranciers en inkoopfacturen hangen.
-- ------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.attachments'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%entity_type%'
  loop
    execute format('alter table public.attachments drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.attachments
  add constraint attachments_entity_type_check
  check (entity_type in ('client','project','task','subtask','ticket','note','document','quote','invoice','folder','supplier','purchase_invoice'));
