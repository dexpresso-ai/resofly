-- ============================================================
-- ResoFly — Boekhouding fase 3: winst- en verliesrekening + balans
-- Date: 2026-06-20
--
-- Context:
-- Fase 1 + 2 vullen het grootboek met geboekte journaalposten. Deze migratie voegt
-- twee read-only aggregatie-RPC's toe die daaruit de financiële overzichten afleiden:
--   - report_profit_and_loss(org, from, to): opbrengsten en kosten per
--     grootboekrekening over een periode (alleen 'posted' boekstukken).
--   - report_balance_sheet(org, as_of): activa/passiva/eigen vermogen per datum,
--     met het cumulatieve resultaat als (onverdeelde) eigen-vermogenscomponent.
--
-- Waarom server-side en niet in de browser: de frontend leest journal_lines via
-- PostgREST, dat standaard op ~1000 rijen capt. Aggregeren in de database geeft
-- altijd het volledige, sluitende totaal, ongeacht hoe groot het grootboek wordt.
--
-- Omdat elke geboekte post in balans is (Σdebet=Σcredit), sluit de balans per
-- constructie: Activa = Vreemd vermogen + Eigen vermogen (incl. resultaat).
-- Geen nieuwe tabellen; puur afgeleide overzichten.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Winst- en verliesrekening over [p_from, p_to]
-- amount_cents is al georiënteerd: opbrengsten = credit-debet, kosten = debet-credit
-- (dus beide positief voor een normaal resultaat).
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
      and je.date between p_from and p_to
      and la.type in ('revenue', 'expense')
    group by la.id, la.code, la.name, la.type
    having sum(jl.debit_cents - jl.credit_cents) <> 0
    order by la.type desc, la.code;
end;
$$;

-- ------------------------------------------------------------
-- Balans per p_as_of
-- section: 'asset' | 'liability' | 'equity' | 'result'. De resultaatregel is het
-- cumulatieve W&V-saldo t/m de peildatum (onverdeeld resultaat onder eigen vermogen).
-- ------------------------------------------------------------
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

    select
      null::uuid, null::text, 'Resultaat (onverdeeld)'::text, 'result'::text,
      coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.type in ('revenue', 'expense');
end;
$$;

commit;
