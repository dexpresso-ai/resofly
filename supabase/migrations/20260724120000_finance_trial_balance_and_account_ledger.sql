-- ============================================================
-- ResoFly — Boekhouding: proef-/saldibalans + grootboekkaart
-- Date: 2026-07-24
--
-- Context:
-- Het grootboek (journal_entries + journal_lines) bevat alle geboekte mutaties,
-- maar er ontbrak nog een rapportagelaag om (a) per rekening de totale debet/
-- credit met saldo op te vragen (proef-/saldibalans) en (b) de mutaties op één
-- rekening met lopend saldo te bekijken (grootboekkaart). Deze migratie voegt twee
-- read-only aggregatie-RPC's toe; geen nieuwe tabellen.
--
-- Beide RPC's volgen exact het guard/security-patroon van report_profit_and_loss /
-- report_balance_sheet (security definer, set search_path = public, can_read_org).
--
-- Belangrijk verschil met de W&V/BTW-rapporten: de proefbalans sluit 'year_close'
-- NIET uit. Het gaat om de WERKELIJKE grootboekstand (inclusief resultaat-
-- bestemming), waarin per definitie Σdebet = Σcredit — dat is de "proef".
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Proef-/saldibalans per peildatum
-- Per grootboekrekening de som van alle geboekte debet- en credit-mutaties met
-- je.date <= p_as_of (incl. year_close), plus het saldo (debet − credit). Alleen
-- rekeningen met beweging. Omdat elke geboekte post in balans is, geldt over het
-- geheel Σdebit_cents = Σcredit_cents.
-- ------------------------------------------------------------
create or replace function public.report_trial_balance(
  p_organization_id uuid,
  p_as_of date
)
returns table(
  account_id uuid, code text, name text, account_type text,
  debit_cents bigint, credit_cents bigint, balance_cents bigint
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
      la.id, la.code, la.name, la.type::text,
      sum(jl.debit_cents)::bigint,
      sum(jl.credit_cents)::bigint,
      sum(jl.debit_cents - jl.credit_cents)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
    group by la.id, la.code, la.name, la.type
    having sum(jl.debit_cents) <> 0 or sum(jl.credit_cents) <> 0
    order by la.code;
end;
$$;

-- ------------------------------------------------------------
-- Grootboekkaart voor één rekening over [p_from, p_to]
-- Alle geboekte journaalregels op de rekening in de periode, met een lopend saldo.
-- De eerste rij is een BEGINSALDO-regel: de netto beweging (debet − credit) vóór
-- p_from (entry_id/entry_number/date = null). Sorteert op datum, dan boekstuknummer,
-- dan regelvolgorde. Toont de regelomschrijving, of anders de boekstukomschrijving.
-- ------------------------------------------------------------
create or replace function public.report_account_ledger(
  p_organization_id uuid,
  p_account_id uuid,
  p_from date,
  p_to date
)
returns table(
  entry_id uuid, entry_number text, date date, description text,
  debit_cents bigint, credit_cents bigint, running_balance_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_opening bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Beginsaldo: netto beweging (debet − credit) op deze rekening vóór p_from.
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
    into v_opening
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  where jl.organization_id = p_organization_id
    and jl.account_id = p_account_id
    and je.status = 'posted'
    and je.date < p_from;

  return query
    with period as (
      select
        je.id as entry_id, je.entry_number, je.date as d,
        coalesce(nullif(jl.description, ''), je.description) as description,
        jl.debit_cents, jl.credit_cents, jl.line_index
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and jl.account_id = p_account_id
        and je.status = 'posted'
        and je.date between p_from and p_to
    ),
    running as (
      select
        p.entry_id, p.entry_number, p.d, p.description,
        p.debit_cents, p.credit_cents,
        v_opening + sum(p.debit_cents - p.credit_cents) over (
          order by p.d, p.entry_number, p.line_index
          rows between unbounded preceding and current row
        ) as running_balance_cents,
        row_number() over (order by p.d, p.entry_number, p.line_index) as rn
      from period p
    )
    select r.entry_id, r.entry_number, r.d, r.description,
           r.debit_cents, r.credit_cents, r.running_balance_cents::bigint
    from (
      -- Beginsaldo-regel (rn = 0 → altijd bovenaan).
      select null::uuid as entry_id, null::text as entry_number, null::date as d,
             'Beginsaldo'::text as description, 0::bigint as debit_cents, 0::bigint as credit_cents,
             v_opening as running_balance_cents, 0::bigint as rn
      union all
      select entry_id, entry_number, d, description, debit_cents, credit_cents, running_balance_cents, rn
      from running
    ) r
    order by r.rn;
end;
$$;

commit;
