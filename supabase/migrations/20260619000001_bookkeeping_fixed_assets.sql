-- ============================================================
-- ResoFly — Boekhouding fase 2: activamodule (vaste activa + afschrijving)
-- Date: 2026-06-19
--
-- Context:
-- Fase 1 legde het grootboek + inkoop. Deze migratie voegt de activamodule toe:
-- vaste activa registreren en lineair afschrijven, waarbij elke periode een
-- journaalpost maakt (debet afschrijvingskosten / credit cumulatieve afschrijving).
-- Zo lopen investeringen via de balans en belanden de afschrijvingskosten in de
-- W&V (fase 3).
--
-- Aanpak:
--  - fixed_assets: het activum met aanschafwaarde, restwaarde, gebruiksduur en de
--    drie grootboekrekeningen (activa op balans, afschrijvingskosten, cumulatieve
--    afschrijving). De rekeningen defaulten in de UI naar 0100/4000/0150.
--  - asset_depreciations: het lineaire afschrijvingsschema, één regel per maand.
--    Schrijven gebeurt uitsluitend via de RPC's (geen directe schrijf-policy), zodat
--    bedragen sluitend en geboekte (posted) regels onveranderbaar blijven.
--  - generate_depreciation_schedule: (her)berekent de nog niet geboekte regels;
--    laatste periode vangt het afrondingsrestant zodat de som exact de af te
--    schrijven basis is.
--  - post_asset_depreciation: boekt alle openstaande regels t/m een datum via
--    post_journal_entry (erft dus de balans- en periodeslot-controles uit fase 1).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Vaste activa
-- ------------------------------------------------------------
create table if not exists public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  asset_number text,
  category text,
  acquisition_date date not null default current_date,
  acquisition_cost_cents bigint not null default 0,
  residual_value_cents bigint not null default 0,
  useful_life_months integer not null default 60,
  method text not null default 'straight_line',
  start_date date not null default current_date,
  asset_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  depreciation_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  accumulated_depreciation_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  source_purchase_invoice_id uuid references public.purchase_invoices(id) on delete set null,
  status text not null default 'active',
  disposal_date date,
  disposal_proceeds_cents bigint,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fixed_assets_name_not_blank check (length(btrim(name)) > 0),
  constraint fixed_assets_cost_nonneg check (acquisition_cost_cents >= 0),
  constraint fixed_assets_residual_nonneg check (residual_value_cents >= 0),
  constraint fixed_assets_residual_le_cost check (residual_value_cents <= acquisition_cost_cents),
  constraint fixed_assets_life_positive check (useful_life_months > 0),
  constraint fixed_assets_method_check check (method in ('straight_line')),
  constraint fixed_assets_status_check check (status in ('active', 'fully_depreciated', 'disposed'))
);
create index if not exists idx_fixed_assets_org on public.fixed_assets(organization_id, acquisition_date desc);

-- ------------------------------------------------------------
-- 2. Afschrijvingsschema (één regel per maand)
-- ------------------------------------------------------------
create table if not exists public.asset_depreciations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  asset_id uuid not null references public.fixed_assets(id) on delete cascade,
  period_index integer not null,
  year integer not null,
  month smallint not null,
  date date not null,
  amount_cents bigint not null default 0,
  accumulated_after_cents bigint not null default 0,
  book_value_after_cents bigint not null default 0,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  status text not null default 'scheduled',
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint asset_depreciations_status_check check (status in ('scheduled', 'posted')),
  constraint asset_depreciations_month_check check (month between 1 and 12),
  constraint asset_depreciations_unique unique (asset_id, period_index)
);
create index if not exists idx_asset_depreciations_asset on public.asset_depreciations(asset_id, period_index);
create index if not exists idx_asset_depreciations_due on public.asset_depreciations(organization_id, status, date);

-- ------------------------------------------------------------
-- 3. Triggers (updated_at, org-lock, audit)
-- ------------------------------------------------------------
drop trigger if exists fixed_assets_touch_updated_at on public.fixed_assets;
create trigger fixed_assets_touch_updated_at before update on public.fixed_assets
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists fixed_assets_prevent_org_change on public.fixed_assets;
create trigger fixed_assets_prevent_org_change before update of organization_id on public.fixed_assets
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists fixed_assets_audit on public.fixed_assets;
create trigger fixed_assets_audit after insert or update or delete on public.fixed_assets
  for each row execute function public.audit_row_change('fixed_asset', 'name');

-- ------------------------------------------------------------
-- 4. Row level security
-- fixed_assets: volledige CRUD voor organisatieleden. asset_depreciations: alleen
-- lezen — het schema en de boekingen lopen via de security definer RPC's.
-- ------------------------------------------------------------
alter table public.fixed_assets enable row level security;
alter table public.asset_depreciations enable row level security;

drop policy if exists "fixed_assets read" on public.fixed_assets;
create policy "fixed_assets read" on public.fixed_assets for select using (public.can_read_org(organization_id));
drop policy if exists "fixed_assets insert" on public.fixed_assets;
create policy "fixed_assets insert" on public.fixed_assets for insert with check (public.can_write_org(organization_id) and created_by = auth.uid());
drop policy if exists "fixed_assets update" on public.fixed_assets;
create policy "fixed_assets update" on public.fixed_assets for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
drop policy if exists "fixed_assets delete" on public.fixed_assets;
create policy "fixed_assets delete" on public.fixed_assets for delete using (public.can_write_org(organization_id) and status = 'active');

drop policy if exists "asset_depreciations read" on public.asset_depreciations;
create policy "asset_depreciations read" on public.asset_depreciations for select using (public.can_read_org(organization_id));

-- ------------------------------------------------------------
-- 5. Afschrijvingsschema (her)berekenen — lineair
-- ------------------------------------------------------------
create or replace function public.generate_depreciation_schedule(
  p_organization_id uuid,
  p_asset_id uuid
)
returns setof public.asset_depreciations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.fixed_assets;
  v_base bigint;
  v_n integer;
  v_monthly bigint;
  v_i integer;
  v_amount bigint;
  v_accum bigint := 0;
  v_period_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;

  v_n := v_asset.useful_life_months;
  if v_n <= 0 then
    raise exception 'Ongeldige gebruiksduur.' using errcode = '23514';
  end if;
  v_base := greatest(v_asset.acquisition_cost_cents - v_asset.residual_value_cents, 0);
  v_monthly := round(v_base::numeric / v_n);

  -- Verwijder alleen de nog niet geboekte regels; geboekte regels zijn onveranderbaar.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';

  for v_i in 1..v_n loop
    -- Laatste periode vangt het afrondingsrestant op zodat de som exact v_base is.
    if v_i < v_n then v_amount := v_monthly; else v_amount := v_base - v_monthly * (v_n - 1); end if;
    v_accum := v_accum + v_amount;
    v_period_date := (v_asset.start_date + ((v_i - 1) || ' months')::interval)::date;

    -- Bestaat er al een geboekte regel voor deze periode, laat die staan.
    if exists (select 1 from public.asset_depreciations where asset_id = p_asset_id and period_index = v_i and status = 'posted') then
      continue;
    end if;

    insert into public.asset_depreciations(
      organization_id, asset_id, period_index, year, month, date,
      amount_cents, accumulated_after_cents, book_value_after_cents, status
    ) values (
      p_organization_id, p_asset_id, v_i,
      extract(year from v_period_date)::int, extract(month from v_period_date)::smallint, v_period_date,
      v_amount, v_accum, v_asset.acquisition_cost_cents - v_accum, 'scheduled'
    );
  end loop;

  return query select * from public.asset_depreciations where asset_id = p_asset_id order by period_index;
end;
$$;

-- ------------------------------------------------------------
-- 6. Afschrijving boeken t/m een datum
-- ------------------------------------------------------------
create or replace function public.post_asset_depreciation(
  p_organization_id uuid,
  p_asset_id uuid,
  p_through_date date,
  p_created_by uuid default auth.uid()
)
returns public.fixed_assets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.fixed_assets;
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_remaining integer;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;

  for r in
    select * from public.asset_depreciations
    where asset_id = p_asset_id and status = 'scheduled' and date <= p_through_date
    order by period_index
  loop
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_asset.depreciation_account_id,
        'description', 'Afschrijving ' || v_asset.name,
        'debit_cents', r.amount_cents, 'credit_cents', 0
      ),
      jsonb_build_object(
        'account_id', v_asset.accumulated_depreciation_account_id,
        'description', 'Cumulatieve afschrijving ' || v_asset.name,
        'debit_cents', 0, 'credit_cents', r.amount_cents
      )
    );
    v_entry := public.post_journal_entry(
      p_organization_id, r.date,
      'Afschrijving ' || coalesce(v_asset.asset_number, v_asset.name),
      'asset_depreciation', p_asset_id, v_lines, p_created_by
    );
    update public.asset_depreciations
    set status = 'posted', journal_entry_id = v_entry.id, posted_at = now()
    where id = r.id;
  end loop;

  select count(*) into v_remaining from public.asset_depreciations
  where asset_id = p_asset_id and status = 'scheduled';
  if v_remaining = 0 then
    update public.fixed_assets set status = 'fully_depreciated' where id = p_asset_id and status = 'active';
  end if;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$$;

commit;

-- ------------------------------------------------------------
-- 7. Attachments mogen aan een activum hangen (bonnen/contracten).
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
  check (entity_type in ('client','project','task','subtask','ticket','note','document','quote','invoice','folder','supplier','purchase_invoice','fixed_asset'));
