-- ============================================================
-- ResoFly — Boekhouding fase 4: omzetbelasting (BTW-aangifte) per maand of kwartaal
-- Date: 2026-06-21
--
-- Context:
-- Sluitstuk van de kern: per aangifteperiode (maand óf kwartaal, instelbaar per
-- organisatie) de verschuldigde BTW, voorbelasting en het saldo berekenen, en de
-- aangifte 'doorboeken' naar 1530 Te betalen omzetbelasting. Daarna wordt de
-- periode vergrendeld zodat er niet meer in geboekt kan worden (late posten vallen
-- in de eerstvolgende open periode).
--
-- Aanpak:
--  - company_settings.vat_return_period: 'monthly' of 'quarterly' (default quarterly).
--  - closed_periods wordt gegeneraliseerd naar een datumbereik (period_start/-end),
--    zodat zowel maand- als kwartaalvergrendeling werkt. post_journal_entry weigert
--    voortaan op datumbereik i.p.v. enkel op kwartaal.
--  - vat_returns legt de aangifte per periode vast (rubrieken-snapshot + status +
--    doorboeking). supplements_return_id is voorzien voor latere suppleties.
--  - compute_vat_return berekent de rubrieken uit de geboekte journaalposten; het
--    saldo (te betalen/terug) volgt exact uit de BTW-rekeningen (subtypes
--    vat_output/vat_reverse/vat_input). finalize_vat_return boekt door + vergrendelt.
--
-- Datamodel-kanttekening: verkoopfacturen dragen alleen een btw-percentage (geen
-- vat_code), dus de rubriek-uitsplitsing voor verlegde/ICP-VERKOOP is beperkt; het
-- saldo en de voorbelasting zijn wel exact. KOR: onder KOR is er geen verschuldigde
-- BTW en geen aftrekbare voorbelasting, dus de aangifte toont vanzelf nul.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Aangiftefrequentie per organisatie
-- ------------------------------------------------------------
alter table public.company_settings
  add column if not exists vat_return_period text not null default 'quarterly';
alter table public.company_settings drop constraint if exists company_settings_vat_return_period_check;
alter table public.company_settings
  add constraint company_settings_vat_return_period_check check (vat_return_period in ('monthly', 'quarterly'));

-- ------------------------------------------------------------
-- 2. closed_periods generaliseren naar een datumbereik
-- ------------------------------------------------------------
alter table public.closed_periods
  add column if not exists period_type text not null default 'quarter',
  add column if not exists month smallint,
  add column if not exists period_start date,
  add column if not exists period_end date;
alter table public.closed_periods alter column quarter drop not null;
alter table public.closed_periods drop constraint if exists closed_periods_quarter_check;
alter table public.closed_periods
  add constraint closed_periods_quarter_check check (quarter is null or quarter between 1 and 4);
alter table public.closed_periods drop constraint if exists closed_periods_period_type_check;
alter table public.closed_periods
  add constraint closed_periods_period_type_check check (period_type in ('month', 'quarter'));
alter table public.closed_periods drop constraint if exists closed_periods_unique;
alter table public.closed_periods drop constraint if exists closed_periods_range_unique;
alter table public.closed_periods
  add constraint closed_periods_range_unique unique (organization_id, period_start, period_end);
create index if not exists idx_closed_periods_range on public.closed_periods(organization_id, period_start, period_end);

-- ------------------------------------------------------------
-- 3. post_journal_entry herzien: periodeslot op datumbereik (maand óf kwartaal)
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

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand of kwartaal).
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_start is not null and cp.period_end is not null
      and p_date between cp.period_start and cp.period_end
  ) then
    raise exception 'De aangifteperiode rond % is afgesloten; deze post valt in de eerstvolgende open periode.', p_date
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

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

  v_diff := v_total_debit - v_total_credit;
  v_count := v_idx;
  v_tolerance := greatest(2 * v_count, 2);

  if v_diff <> 0 then
    if abs(v_diff) <= v_tolerance then
      v_account := public.bookkeeping_account_id(p_organization_id, '4900');
      insert into public.journal_lines(
        organization_id, entry_id, account_id, line_index, description, debit_cents, credit_cents
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
-- 4. vat_returns: aangifte per periode
-- ------------------------------------------------------------
create table if not exists public.vat_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  period_type text not null,
  year integer not null,
  period_index integer not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft',
  rubrieken jsonb not null default '{}'::jsonb,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  supplements_return_id uuid references public.vat_returns(id) on delete set null,
  notes text,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vat_returns_period_type_check check (period_type in ('month', 'quarter')),
  constraint vat_returns_status_check check (status in ('draft', 'finalized', 'filed', 'paid')),
  constraint vat_returns_unique unique (organization_id, period_type, year, period_index)
);
create index if not exists idx_vat_returns_org on public.vat_returns(organization_id, year, period_index);

drop trigger if exists vat_returns_touch_updated_at on public.vat_returns;
create trigger vat_returns_touch_updated_at before update on public.vat_returns
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists vat_returns_prevent_org_change on public.vat_returns;
create trigger vat_returns_prevent_org_change before update of organization_id on public.vat_returns
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists vat_returns_audit on public.vat_returns;
create trigger vat_returns_audit after insert or update or delete on public.vat_returns
  for each row execute function public.audit_row_change('vat_return', 'status');

alter table public.vat_returns enable row level security;
-- Lezen: organisatieleden. Aanmaken/doorboeken: via finalize_vat_return (security
-- definer). Bijwerken van de status (bijv. ingediend/betaald): can_write_org.
drop policy if exists "vat_returns read" on public.vat_returns;
create policy "vat_returns read" on public.vat_returns for select using (public.can_read_org(organization_id));
drop policy if exists "vat_returns update" on public.vat_returns;
create policy "vat_returns update" on public.vat_returns for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));

-- ------------------------------------------------------------
-- 5. compute_vat_return: rubrieken berekenen uit geboekte journaalposten
-- ------------------------------------------------------------
create or replace function public.compute_vat_return(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_omzet_hoog_base bigint; v_omzet_hoog_btw bigint;
  v_omzet_laag_base bigint; v_omzet_laag_btw bigint;
  v_omzet_nul_base bigint;
  v_verlegd_btw bigint;
  v_verschuldigd bigint;
  v_voorbelasting bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) = 0 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_reverse' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype in ('vat_output', 'vat_reverse') then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_input' then jl.debit_cents - jl.credit_cents else 0 end), 0)
  into v_omzet_hoog_base, v_omzet_hoog_btw, v_omzet_laag_base, v_omzet_laag_btw, v_omzet_nul_base,
       v_verlegd_btw, v_verschuldigd, v_voorbelasting
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date between p_from and p_to;

  return jsonb_build_object(
    'omzet_hoog_base', v_omzet_hoog_base, 'omzet_hoog_btw', v_omzet_hoog_btw,
    'omzet_laag_base', v_omzet_laag_base, 'omzet_laag_btw', v_omzet_laag_btw,
    'omzet_nul_base', v_omzet_nul_base,
    'verlegd_btw', v_verlegd_btw,
    'verschuldigd_total', v_verschuldigd,
    'voorbelasting', v_voorbelasting,
    'saldo', v_verschuldigd - v_voorbelasting
  );
end;
$$;

-- ------------------------------------------------------------
-- 6. finalize_vat_return: doorboeken naar 1530 + periode vergrendelen
-- ------------------------------------------------------------
create or replace function public.finalize_vat_return(
  p_organization_id uuid,
  p_period_type text,
  p_year integer,
  p_period_index integer,
  p_from date,
  p_to date,
  p_created_by uuid default auth.uid()
)
returns public.vat_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.vat_returns;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_rubrieken jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.closed_periods
    where organization_id = p_organization_id and period_start = p_from and period_end = p_to
  ) then
    raise exception 'Deze aangifteperiode is al afgesloten.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Beweging op de BTW-rekeningen in de periode (vóór de doorboeking).
  select
    coalesce(sum(case when la.subtype = 'vat_output' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_reverse' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_input' then jl.debit_cents - jl.credit_cents else 0 end), 0)
  into v_clear_output, v_clear_reverse, v_clear_input
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id and je.status = 'posted'
    and je.date between p_from and p_to
    and la.subtype in ('vat_output', 'vat_reverse', 'vat_input');

  v_saldo := (v_clear_output + v_clear_reverse) - v_clear_input;
  v_rubrieken := public.compute_vat_return(p_organization_id, p_from, p_to);

  -- Doorboeking: BTW-rekeningen afsluiten naar 1530 Te betalen omzetbelasting.
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1510'), 'description', 'Afsluiten af te dragen BTW', 'debit_cents', v_clear_output, 'credit_cents', 0));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1520'), 'description', 'Afsluiten verlegde/ICP BTW', 'debit_cents', v_clear_reverse, 'credit_cents', 0));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1500'), 'description', 'Afsluiten voorbelasting', 'debit_cents', 0, 'credit_cents', v_clear_input));
  end if;
  if v_saldo <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting',
      'debit_cents', case when v_saldo < 0 then -v_saldo else 0 end,
      'credit_cents', case when v_saldo > 0 then v_saldo else 0 end
    ));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, p_to,
      'BTW-aangifte doorboeken ' || p_period_type || ' ' || p_period_index || '-' || p_year,
      'vat_return', null, v_lines, p_created_by
    );
  end if;

  insert into public.vat_returns(
    organization_id, created_by, period_type, year, period_index, period_start, period_end,
    status, rubrieken, journal_entry_id, finalized_at
  ) values (
    p_organization_id, p_created_by, p_period_type, p_year, p_period_index, p_from, p_to,
    'finalized', v_rubrieken, v_entry.id, now()
  )
  on conflict (organization_id, period_type, year, period_index) do update
    set status = 'finalized', rubrieken = excluded.rubrieken, journal_entry_id = excluded.journal_entry_id,
        period_start = excluded.period_start, period_end = excluded.period_end, finalized_at = now(), updated_at = now()
  returning * into v_ret;

  -- Periode vergrendelen (datumbereik).
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, p_period_type, p_year,
    case when p_period_type = 'quarter' then p_period_index::smallint else null end,
    case when p_period_type = 'month' then p_period_index::smallint else null end,
    p_from, p_to, p_created_by
  )
  on conflict (organization_id, period_start, period_end) do nothing;

  return v_ret;
end;
$$;

commit;
