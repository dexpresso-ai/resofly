-- ============================================================
-- ResoFly — Boekhouding: boekjaren (afsluiten / openen / heropenen / bekijken)
-- Date: 2026-07-06
--
-- Context:
-- De kern-boekhouding (fase 1-4) kende nog GEEN boekjaar-concept. Het resultaat
-- werd nooit bestemd naar eigen vermogen: report_balance_sheet toonde een VIRTUELE
-- regel "Resultaat (onverdeeld)" = som van alle omzet/kosten t/m de peildatum,
-- cumulatief over de hele historie. Deze migratie voegt echte boekjaren toe met:
--   - een tabel fiscal_years (status open/closed) los van de BTW-closed_periods;
--   - close_fiscal_year: één onveranderbaar resultaatbestemmings-boekstuk
--     (source_type 'year_close') dat elke W&V-rekening op nul zet en het
--     nettoresultaat naar 0510 Onverdeeld resultaat (eigen vermogen) boekt,
--     gedateerd op de laatste dag van het boekjaar; daarna wordt het hele
--     boekjaarbereik vergrendeld via een closed_periods-rij (period_type 'year');
--   - open_fiscal_year / reopen_fiscal_year / list_fiscal_years.
--
-- Kernvalkuil + oplossing (geverifieerd met adversariële review):
-- Zonder correctie zou het resultaat DUBBEL tellen (in 0510 én in de virtuele
-- regel) en zou de W&V van een afgesloten jaar op nul komen. Daarom:
--   * report_profit_and_loss én de virtuele resultaatregel van report_balance_sheet
--     én compute_vat_return sluiten 'year_close'-boekstukken uit;
--   * de virtuele regel sluit bovendien elke datum uit die binnen een
--     'year'-slot valt, zodat een afgesloten jaar alleen nog in 0510 zit.
-- Het balansrekening-deel (asset/liability/equity) blijft ongewijzigd en telt 0510
-- als gewone eigen-vermogenrekening mee → geen dubbeltelling, balans blijft sluiten.
--
-- Heropenen doet GÉÉN tegenboeking (de rapporten tellen alleen status='posted');
-- het afsluitboekstuk wordt op 'reversed' gezet + de jaar-lock verwijderd, wat de
-- situatie exact terugbrengt naar vóór de afsluiting. Alle mutatie loopt via
-- security-definer RPC's; fiscal_years heeft alleen een SELECT-policy.
--
-- Gebroken boekjaar wordt ondersteund via company_settings.fiscal_year_start_month
-- en de period_start/period_end van elk boekjaar; rapporten en de W&V-jaarkiezer
-- werken op die grenzen, niet op het kalenderjaar.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Boekjaar-instellingen op company_settings
-- ------------------------------------------------------------
alter table public.company_settings
  add column if not exists fiscal_year_start_month smallint not null default 1;
alter table public.company_settings drop constraint if exists company_settings_fy_start_month_check;
alter table public.company_settings
  add constraint company_settings_fy_start_month_check check (fiscal_year_start_month between 1 and 12);
alter table public.company_settings
  add column if not exists year_result_account_code text not null default '0510';

-- ------------------------------------------------------------
-- 2. Tabel fiscal_years
-- ------------------------------------------------------------
create table if not exists public.fiscal_years (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  created_by             uuid references auth.users(id) on delete set null default auth.uid(),
  label                  text not null,
  period_start           date not null,
  period_end             date not null,
  status                 text not null default 'open',
  close_journal_entry_id uuid references public.journal_entries(id) on delete set null,
  result_account_code    text,
  result_cents           bigint,
  closed_at              timestamptz,
  closed_by              uuid references auth.users(id) on delete set null,
  reopened_at            timestamptz,
  reopened_by            uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint fiscal_years_status_check check (status in ('open','closed')),
  constraint fiscal_years_range_ck check (period_end > period_start),
  constraint fiscal_years_label_not_blank check (length(btrim(label)) > 0),
  constraint fiscal_years_org_start_unique unique (organization_id, period_start)
);
create index if not exists idx_fiscal_years_org on public.fiscal_years(organization_id, period_start desc);

alter table public.fiscal_years enable row level security;
-- Alleen lezen; alle mutatie via de security-definer RPC's onderaan.
drop policy if exists "fiscal_years read" on public.fiscal_years;
create policy "fiscal_years read" on public.fiscal_years for select using (public.can_read_org(organization_id));

drop trigger if exists fiscal_years_touch_updated_at on public.fiscal_years;
create trigger fiscal_years_touch_updated_at before update on public.fiscal_years
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists fiscal_years_prevent_org_change on public.fiscal_years;
create trigger fiscal_years_prevent_org_change before update of organization_id on public.fiscal_years
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists fiscal_years_audit on public.fiscal_years;
create trigger fiscal_years_audit after insert or update or delete on public.fiscal_years
  for each row execute function public.audit_row_change('fiscal_year', 'status');

-- ------------------------------------------------------------
-- 3. closed_periods: sta een jaar-slot toe
-- ------------------------------------------------------------
alter table public.closed_periods drop constraint if exists closed_periods_period_type_check;
alter table public.closed_periods
  add constraint closed_periods_period_type_check check (period_type in ('month','quarter','year'));

-- ------------------------------------------------------------
-- 4. journal_entries: nieuw brontype 'year_close' (volledige lijst overnemen)
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition',
    'vat_return','payment','opening_balance','manual','year_close'
  ));

-- ------------------------------------------------------------
-- 5. Rekeningschema: 0510 Onverdeeld resultaat toevoegen (idempotent)
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
    (p_organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', null, true),
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

-- Bestaande organisaties die de boekhouding al gebruiken meteen 0510 geven.
insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
select distinct la.organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', true
from public.ledger_accounts la
on conflict (organization_id, code) do nothing;

-- ------------------------------------------------------------
-- 6. post_journal_entry herzien: 'year_close' omzeilt het periodeslot
--    (het afsluitboekstuk valt op 31-12, vaak al in een gefinaliseerd Q4-slot;
--    alle andere boekingen blijven hard geweigerd in een afgesloten periode,
--    inclusief het jaar-slot → late/backdated boekingen worden geweigerd).
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

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand/kwartaal/jaar).
  -- Uitzondering: het jaarafsluit-boekstuk ('year_close') zelf, dat op de laatste dag
  -- van het boekjaar valt en dus vaak binnen een reeds gesloten Q4/december-slot.
  if coalesce(p_source_type, 'manual') <> 'year_close' and exists (
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
-- 7. Rapport-RPC's: 'year_close' uitsluiten (anti-dubbeltelling)
-- ------------------------------------------------------------
create or replace function public.report_profit_and_loss(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns table(account_id uuid, code text, name text, account_type text, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      la.id, la.code, la.name, la.type,
      (case when la.type = 'revenue'
            then sum(jl.credit_cents - jl.debit_cents)
            else sum(jl.debit_cents - jl.credit_cents) end)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between p_from and p_to
      and la.type in ('revenue', 'expense')
    group by la.id, la.code, la.name, la.type
    having sum(jl.debit_cents - jl.credit_cents) <> 0
    order by la.type desc, la.code;
end;
$$;

create or replace function public.report_balance_sheet(
  p_organization_id uuid,
  p_as_of date
)
returns table(account_id uuid, code text, name text, section text, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    -- Balansrekeningen: ongewijzigd. 0510 verschijnt vanzelf als eigen-vermogenrij
    -- zodra een jaar is afgesloten (year_close boekt daar het resultaat naartoe).
    select
      la.id, la.code, la.name, la.type::text,
      (case when la.type = 'asset'
            then sum(jl.debit_cents - jl.credit_cents)
            else sum(jl.credit_cents - jl.debit_cents) end)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.type in ('asset', 'liability', 'equity')
    group by la.id, la.code, la.name, la.type
    having sum(jl.debit_cents - jl.credit_cents) <> 0

    union all

    -- Virtuele resultaatregel: alleen het resultaat van NIET-afgesloten boekjaren.
    -- Sluit 'year_close'-boekstukken uit én elke datum die binnen een 'year'-slot
    -- valt (dan zit het resultaat al bestemd in 0510) → geen dubbeltelling.
    select
      null::uuid, null::text, 'Resultaat lopend boekjaar'::text, 'result'::text,
      coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date <= p_as_of
      and la.type in ('revenue', 'expense')
      -- Sluit een afgesloten jaar pas uit zodra de resultaatbestemming óók in het
      -- account-part zit (het year_close-boekstuk valt op period_end): dus alleen als
      -- p_as_of >= period_end. Anders zou het resultaat op een intra-jaars peildatum
      -- uit de virtuele regel verdwijnen terwijl 0510 het nog niet heeft overgenomen.
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
          and p_as_of >= cp.period_end
      );
end;
$$;

-- compute_vat_return: 'year_close' uitsluiten. Het afsluitboekstuk debiteert
-- omzetrekeningen zonder vat_rate; zonder deze filter lekt dat als negatieve omzet
-- in de nul-rubriek bij een herberekening/suppletie ná afsluiting.
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
    and je.source_type <> 'year_close'
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
-- 8. open_fiscal_year: nieuw boekjaar (mag altijd, ook vóór afsluiting oude)
-- ------------------------------------------------------------
create or replace function public.open_fiscal_year(
  p_organization_id uuid,
  p_period_start date,
  p_period_end date,
  p_label text default null,
  p_created_by uuid default auth.uid()
)
returns public.fiscal_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_label text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'De einddatum van het boekjaar moet na de begindatum liggen.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and daterange(f.period_start, f.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'Dit boekjaar overlapt met een bestaand boekjaar.' using errcode = '23514';
  end if;

  v_label := coalesce(nullif(btrim(p_label), ''),
    case when extract(year from p_period_start) = extract(year from p_period_end)
         then extract(year from p_period_start)::text
         else extract(year from p_period_start)::text || '/' || extract(year from p_period_end)::text end);

  insert into public.fiscal_years(organization_id, created_by, label, period_start, period_end, status)
  values (p_organization_id, p_created_by, v_label, p_period_start, p_period_end, 'open')
  returning * into v_fy;

  return v_fy;
end;
$$;

-- ------------------------------------------------------------
-- 9. close_fiscal_year: resultaatbestemming + jaar-lock
-- ------------------------------------------------------------
create or replace function public.close_fiscal_year(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.fiscal_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_kor boolean;
  v_vat_period text;
  v_result_code text;
  v_lines jsonb := '[]'::jsonb;
  v_debit_total bigint := 0;   -- som van de debiteringen tegen omzetrekeningen
  v_credit_total bigint := 0;  -- som van de crediteringen tegen kostenrekeningen
  v_result_cents bigint := 0;  -- nettoresultaat (winst > 0, verlies < 0)
  v_entry public.journal_entries;
  v_result_account uuid;
  r record;
  v_cursor date;
  v_p_start date;
  v_p_end date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer close/reopen per organisatie (voorkomt dubbele resultaatbestemming).
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Dit boekjaar is al afgesloten.' using errcode = '23514';
  end if;

  -- Sequentiële volgorde: geen geboekte transacties vóór dit boekjaar die niet in
  -- een afgesloten jaar-slot vallen (dus het voorgaande boekjaar moet dicht zijn).
  if exists (
    select 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date < v_fy.period_start
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
      )
  ) then
    raise exception 'Sluit eerst het voorgaande boekjaar af voordat je dit boekjaar afsluit.' using errcode = '23514';
  end if;

  -- BTW hard block (tenzij KOR): elke kalender-aangifteperiode die binnen het
  -- boekjaar begint, moet gefinaliseerd (afgesloten) zijn.
  select coalesce(kor_enabled, false), coalesce(vat_return_period, 'quarterly'),
         coalesce(year_result_account_code, '0510')
    into v_kor, v_vat_period, v_result_code
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  v_vat_period := coalesce(v_vat_period, 'quarterly');
  v_result_code := coalesce(v_result_code, '0510');

  if not v_kor then
    v_cursor := date_trunc(case when v_vat_period = 'monthly' then 'month' else 'quarter' end, v_fy.period_start)::date;
    while v_cursor <= v_fy.period_end loop
      if v_vat_period = 'monthly' then
        v_p_start := v_cursor;
        v_p_end := (v_cursor + interval '1 month' - interval '1 day')::date;
      else
        v_p_start := v_cursor;
        v_p_end := (v_cursor + interval '3 months' - interval '1 day')::date;
      end if;
      -- Elke kalender-aangifteperiode die het boekjaar OVERLAPT moet gefinaliseerd
      -- zijn (ook een leidende/afsluitende deelperiode bij een gebroken boekjaar dat
      -- niet op een kwartaal-/maandgrens begint). Match strikt op de ingestelde
      -- frequentie én het volledige bereik dat finalize_vat_return vastlegt, zodat een
      -- maand-finalisatie niet ten onrechte als kwartaal-finalisatie telt.
      if v_p_end >= v_fy.period_start and v_p_start <= v_fy.period_end then
        if not exists (
          select 1 from public.closed_periods cp
          where cp.organization_id = p_organization_id
            and cp.period_type = case when v_vat_period = 'monthly' then 'month' else 'quarter' end
            and cp.period_start = v_p_start
            and cp.period_end = v_p_end
        ) then
          raise exception 'Finaliseer eerst alle BTW-aangiften van dit boekjaar (ontbreekt de periode % t/m %).',
            to_char(v_p_start, 'DD-MM-YYYY'), to_char(v_p_end, 'DD-MM-YYYY')
            using errcode = '23514';
        end if;
      end if;
      v_cursor := (v_p_end + interval '1 day')::date;
    end loop;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluitregels per W&V-rekening (exclusief eerdere/teruggedraaide year_close).
  for r in
    select jl.account_id, la.type as account_type,
           sum(jl.debit_cents) as d, sum(jl.credit_cents) as c
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type in ('revenue', 'expense')
    group by jl.account_id, la.type
    having sum(jl.credit_cents - jl.debit_cents) <> 0
  loop
    if (r.c - r.d) > 0 then
      -- creditsaldo (typisch omzet): debiteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', (r.c - r.d), 'credit_cents', 0));
      v_debit_total := v_debit_total + (r.c - r.d);
    else
      -- debetsaldo (typisch kosten): crediteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', 0, 'credit_cents', (r.d - r.c)));
      v_credit_total := v_credit_total + (r.d - r.c);
    end if;
  end loop;

  -- Nettoresultaat volgt als restpost → boekstuk sluit exact (geen 4900-vangnet).
  v_result_cents := v_debit_total - v_credit_total;
  if v_result_cents <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, v_result_code);
    if v_result_cents > 0 then
      -- winst → crediteer de resultaatrekening (eigen vermogen stijgt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_result_cents));
    else
      -- verlies → debiteer de resultaatrekening (eigen vermogen daalt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', -v_result_cents, 'credit_cents', 0));
    end if;
  end if;

  -- Post het afsluitboekstuk (leeg boekjaar → geen boekstuk).
  if jsonb_array_length(v_lines) > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, v_fy.period_end,
      'Jaarafsluiting ' || v_fy.label,
      'year_close', p_fiscal_year_id, v_lines, p_created_by
    );
  end if;

  -- Vergrendel het volledige boekjaarbereik.
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, 'year', extract(year from v_fy.period_start)::int, null, null,
    v_fy.period_start, v_fy.period_end, p_created_by
  )
  on conflict (organization_id, period_start, period_end) do nothing;

  update public.fiscal_years
  set status = 'closed', close_journal_entry_id = v_entry.id,
      result_account_code = v_result_code, result_cents = v_result_cents,
      closed_at = now(), closed_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$$;

-- ------------------------------------------------------------
-- 10. reopen_fiscal_year: void de resultaatbestemming + hef de jaar-lock op
--     (alleen eigenaar/admin). Géén tegenboeking: de rapporten tellen alleen
--     status='posted', dus 'reversed' zetten haalt het boekstuk volledig uit
--     balans + 0510 en herstelt exact de situatie van vóór de afsluiting.
-- ------------------------------------------------------------
create or replace function public.reopen_fiscal_year(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.fiscal_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een boekjaar heropenen.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status <> 'closed' then
    raise exception 'Alleen een afgesloten boekjaar kan worden heropend.' using errcode = '23514';
  end if;

  -- Alleen het meest recent afgesloten jaar mag open: een later afgesloten jaar
  -- bouwt voort op het eindvermogen van dit jaar.
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and f.status = 'closed'
      and f.period_start > v_fy.period_start
  ) then
    raise exception 'Heropen eerst de latere afgesloten boekjaren (in omgekeerde volgorde).' using errcode = '23514';
  end if;

  -- Hef de jaar-lock op (anders blijft de balans van dit jaar vergrendeld).
  delete from public.closed_periods
  where organization_id = p_organization_id
    and period_type = 'year'
    and period_start = v_fy.period_start
    and period_end = v_fy.period_end;

  -- Void het afsluitboekstuk (blijft bewaard als 'reversed' voor audit).
  if v_fy.close_journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_fy.close_journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.fiscal_years
  set status = 'open', close_journal_entry_id = null,
      result_account_code = null, result_cents = null,
      reopened_at = now(), reopened_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$$;

-- ------------------------------------------------------------
-- 11. list_fiscal_years: boekjaren + (her)berekend resultaat (server-side)
-- ------------------------------------------------------------
create or replace function public.list_fiscal_years(
  p_organization_id uuid
)
returns table(
  id uuid, label text, period_start date, period_end date, status text,
  result_cents bigint, close_journal_entry_id uuid,
  computed_result_cents bigint, has_entries boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      f.id, f.label, f.period_start, f.period_end, f.status,
      f.result_cents, f.close_journal_entry_id,
      coalesce((
        select sum(jl.credit_cents - jl.debit_cents)
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.entry_id
        join public.ledger_accounts la on la.id = jl.account_id
        where jl.organization_id = p_organization_id
          and je.status = 'posted'
          and je.source_type <> 'year_close'
          and je.date between f.period_start and f.period_end
          and la.type in ('revenue', 'expense')
      ), 0)::bigint as computed_result_cents,
      exists(
        select 1
        from public.journal_lines jl2
        join public.journal_entries je2 on je2.id = jl2.entry_id
        where jl2.organization_id = p_organization_id
          and je2.status = 'posted'
          and je2.source_type <> 'year_close'
          and je2.date between f.period_start and f.period_end
      ) as has_entries
    from public.fiscal_years f
    where f.organization_id = p_organization_id
    order by f.period_start desc;
end;
$$;

commit;
