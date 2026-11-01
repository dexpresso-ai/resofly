-- ============================================================
-- ResoFly — Bankkoppeling, financiële rapporten en kleinere sloten
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md):
--
--   1. BANKREKENINGEN VAN EEN ANDER BEDRIJF. Alle organisaties delen één
--      Enable Banking-app; het account-id van de bank is de enige sleutel tot
--      de transacties. Dat id (en de bron en de koppeling) kon een teamlid zelf
--      in een rij van bank_accounts zetten, en bank-sync haalde dan de
--      transacties van die rekening op, ook van een ander bedrijf. Nu zet
--      alleen de server die velden, en controleert bank-sync dat de rekening
--      bij een koppeling van dezelfde organisatie hoort die het id kreeg.
--   2. FINANCIËLE RAPPORTEN ZONDER MODULE. Proef- en saldibalans, grootboek,
--      balans, winst-en-verlies, openstaande posten, bankaansluiting, btw, ICP
--      en boekjaren controleerden alleen het lidmaatschap. Een teamlid met
--      Financiën dicht las zo het hele grootboek. Open punt van 26 september.
--      Nu vragen ze ook leesrecht op Financiën (zoals de rapporten na
--      winstbestemming al deden).
--   3. VERGADERLINKS. calendar_events.meeting_url mocht elke tekst zijn; een
--      `javascript:`-link stond dan achter "Deelnemen". Nu alleen http(s).
--      (NOT VALID: bestaande rijen blijven staan; elke nieuwe of gewijzigde
--      rij moet kloppen.)
--   4. UITNODIGINGEN. Aannemen kan alleen met een bevestigd e-mailadres.
--   5. STREAM. stream_playback_base (de host voor afspelen, voorvertoning en
--      downloaden bij de klant) moet een Cloudflare Stream-host zijn.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Bankkoppeling: alleen de server zet de koppelvelden ─────────────────

create or replace function public.bank_accounts_link_fields_server_only()
returns trigger
language plpgsql
as $$
begin
  -- De service-role (bank-sync) en pg_cron mogen alles; de app alleen naam,
  -- IBAN, valuta, grootboekrekening en aan/uit (zie Bank.tsx).
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.source, 'import') <> 'import'
       or new.provider is not null
       or new.external_account_id is not null
       or new.bank_requisition_id is not null
       or new.last_synced_at is not null then
      raise exception 'Een bankkoppeling zet alleen de server; maak de rekening aan via "Bank koppelen".'
        using errcode = '42501';
    end if;
  elsif (new.source, new.provider, new.external_account_id, new.bank_requisition_id, new.last_synced_at)
        is distinct from (old.source, old.provider, old.external_account_id, old.bank_requisition_id, old.last_synced_at) then
    raise exception 'De koppeling van een bankrekening wijzigt alleen de server.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.bank_accounts_link_fields_server_only() from public, anon, authenticated;

drop trigger if exists bank_accounts_link_fields_server_only on public.bank_accounts;
create trigger bank_accounts_link_fields_server_only
  before insert or update on public.bank_accounts
  for each row execute function public.bank_accounts_link_fields_server_only();

-- ── 2. Financiële rapporten vragen leesrecht op Financiën ──────────────────
--
-- Ongewijzigd op de controle bovenaan na (zie de kop).

-- report_account_ledger(uuid,uuid,date,date)
create or replace function public.report_account_ledger(p_organization_id uuid, p_account_id uuid, p_from date, p_to date)
 RETURNS TABLE(entry_id uuid, entry_number text, date date, description text, debit_cents bigint, credit_cents bigint, running_balance_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_opening bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
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

-- report_trial_balance(uuid,date)
create or replace function public.report_trial_balance(p_organization_id uuid, p_as_of date)
 RETURNS TABLE(account_id uuid, code text, name text, account_type text, debit_cents bigint, credit_cents bigint, balance_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
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

-- report_balance_sheet(uuid,date)
create or replace function public.report_balance_sheet(p_organization_id uuid, p_as_of date)
 RETURNS TABLE(account_id uuid, code text, name text, section text, report_group text, group_rank integer, amount_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    -- Balansrekeningen. 0510 verschijnt vanzelf als eigen-vermogenrij zodra een
    -- jaar is afgesloten (year_close boekt daar het resultaat naartoe).
    select
      la.id, la.code, la.name, la.type::text,
      -- Zonder rubriek: activa onder de vorderingen, passiva onder de
      -- kortlopende schulden, eigen vermogen bij het eigen vermogen. Nooit
      -- buiten de balans laten vallen — dan klopt het balanstotaal niet meer.
      coalesce(la.report_group, case la.type
        when 'asset' then 'vorderingen'
        when 'equity' then 'eigen_vermogen'
        else 'kortlopende_schulden' end),
      public.ledger_report_group_rank(coalesce(la.report_group, case la.type
        when 'asset' then 'vorderingen'
        when 'equity' then 'eigen_vermogen'
        else 'kortlopende_schulden' end)),
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
    group by la.id, la.code, la.name, la.type, la.report_group
    having sum(jl.debit_cents - jl.credit_cents) <> 0

    union all

    -- Virtuele resultaatregel: alleen het resultaat van NIET-afgesloten boekjaren.
    -- Sluit 'year_close'-boekstukken uit én elke datum die binnen een 'year'-slot
    -- valt (dan zit het resultaat al bestemd in 0510) → geen dubbeltelling.
    select
      null::uuid, null::text, 'Resultaat lopend boekjaar'::text, 'result'::text,
      'eigen_vermogen'::text,
      public.ledger_report_group_rank('eigen_vermogen'),
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
      )

    -- Op rubriekvolgorde en daarbinnen op rekeningnummer, over de hele unie heen.
    -- De virtuele resultaatregel heeft geen code en sorteert daardoor (nulls last)
    -- onderaan het eigen vermogen — precies waar hij hoort.
    order by 6, 2;
end;
$$;

-- report_profit_and_loss(uuid,date,date)
create or replace function public.report_profit_and_loss(p_organization_id uuid, p_from date, p_to date)
 RETURNS TABLE(account_id uuid, code text, name text, account_type text, report_group text, group_rank integer, amount_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      la.id, la.code, la.name, la.type,
      -- Een rekening zonder rubriek belandt in een restgroep: opbrengsten bij de
      -- overige bedrijfsopbrengsten, kosten bij de overige bedrijfskosten. Zo
      -- telt élke rekening mee in het bedrijfsresultaat en kan er nooit een
      -- bedrag buiten de optelling vallen.
      coalesce(la.report_group, case when la.type = 'revenue' then 'overige_bedrijfsopbrengsten' else 'overige_bedrijfskosten' end),
      public.ledger_report_group_rank(coalesce(la.report_group, case when la.type = 'revenue' then 'overige_bedrijfsopbrengsten' else 'overige_bedrijfskosten' end)),
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
    group by la.id, la.code, la.name, la.type, la.report_group
    having sum(jl.debit_cents - jl.credit_cents) <> 0
    order by 6, la.code;
end;
$$;

-- report_open_items(uuid,date)
create or replace function public.report_open_items(p_organization_id uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_recv_rows jsonb;
  v_recv_open bigint;
  v_recv_matched bigint;
  v_recv_gl bigint;
  v_pay_rows jsonb;
  v_pay_open bigint;
  v_pay_matched bigint;
  v_pay_gl bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- ---------------- Debiteuren (1300) ----------------
  with ar_lines as (
    select je.source_type, je.source_id, jl.debit_cents, jl.credit_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.subtype = 'accounts_receivable'
  ),
  inv_booked as (
    select source_id as invoice_id, sum(debit_cents - credit_cents)::bigint as amt
    from ar_lines where source_type = 'sales_invoice' group by 1
  ),
  inv_credited as (
    select cn.invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.credit_notes cn on cn.organization_id = p_organization_id and cn.id = al.source_id
    where al.source_type = 'credit_note'
    group by 1
  ),
  inv_paid as (
    select bt.matched_invoice_id as invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.bank_transactions bt
      on bt.organization_id = p_organization_id and bt.id = al.source_id
     and bt.status = 'booked' and bt.matched_invoice_id is not null
    where al.source_type = 'payment'
    group by 1
  ),
  inv_rows as (
    select
      i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) as paid_cents,
      coalesce(cr.amt, 0) as credited_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) - coalesce(cr.amt, 0) as open_cents
    from public.invoices i
    left join inv_booked b on b.invoice_id = i.id
    left join inv_paid p on p.invoice_id = i.id
    left join inv_credited cr on cr.invoice_id = i.id
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0 or coalesce(cr.amt, 0) <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'client_id', r.client_id, 'client_name', r.client_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents,
      'credited_cents', r.credited_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0),
    coalesce(sum(r.booked_cents - r.paid_cents - r.credited_cents), 0),
    (select coalesce(sum(debit_cents - credit_cents), 0) from ar_lines)
  into v_recv_rows, v_recv_open, v_recv_matched, v_recv_gl
  from inv_rows r;

  -- ---------------- Crediteuren (1600) ----------------
  with ap_lines as (
    select je.source_type, je.source_id, jl.debit_cents, jl.credit_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.subtype = 'accounts_payable'
  ),
  pi_booked as (
    select source_id as pi_id, sum(credit_cents - debit_cents)::bigint as amt
    from ap_lines where source_type = 'purchase_invoice' group by 1
  ),
  pi_paid as (
    select bt.matched_purchase_invoice_id as pi_id, sum(al.debit_cents - al.credit_cents)::bigint as amt
    from ap_lines al
    join public.bank_transactions bt
      on bt.organization_id = p_organization_id and bt.id = al.source_id
     and bt.status = 'booked' and bt.matched_purchase_invoice_id is not null
    where al.source_type = 'payment'
    group by 1
  ),
  pi_rows as (
    select
      pi.id, coalesce(pi.supplier_invoice_number, pi.internal_number) as number,
      pi.date, pi.due_date, pi.supplier_id, s.name as supplier_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) as paid_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) as open_cents
    from public.purchase_invoices pi
    left join pi_booked b on b.pi_id = pi.id
    left join pi_paid p on p.pi_id = pi.id
    left join public.suppliers s on s.id = pi.supplier_id
    where pi.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'purchase_invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'supplier_id', r.supplier_id, 'supplier_name', r.supplier_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0),
    coalesce(sum(r.booked_cents - r.paid_cents), 0),
    (select coalesce(sum(credit_cents - debit_cents), 0) from ap_lines)
  into v_pay_rows, v_pay_open, v_pay_matched, v_pay_gl
  from pi_rows r;

  return jsonb_build_object(
    'as_of', p_as_of,
    'receivables', jsonb_build_object(
      'rows', v_recv_rows,
      'open_total_cents', v_recv_open,
      'gl_balance_cents', v_recv_gl,
      -- Beweging op 1300 die niet aan een factuur toe te rekenen is
      -- (beginbalans, vrije boekingen): het gat tussen lijst en grootboek.
      'unmatched_cents', v_recv_gl - v_recv_matched
    ),
    'payables', jsonb_build_object(
      'rows', v_pay_rows,
      'open_total_cents', v_pay_open,
      'gl_balance_cents', v_pay_gl,
      'unmatched_cents', v_pay_gl - v_pay_matched
    )
  );
end;
$$;

-- report_bank_reconciliation(uuid)
create or replace function public.report_bank_reconciliation(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_out jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(s.row_json order by s.acc_name), '[]'::jsonb) into v_out
  from (
    select
      ba.name as acc_name,
      jsonb_build_object(
        'bank_account_id', ba.id,
        'name', ba.name,
        'iban', ba.iban,
        'source', ba.source,
        'ledger_code', la.code,
        'ledger_name', la.name,
        -- Meerdere bankrekeningen op dezelfde grootboekrekening (standaard boekt
        -- alles op 1100): dan is de stand van die rekening de SOM van beide en
        -- kun je niet per rekening aansluiten. De UI waarschuwt daarvoor.
        'shares_ledger_account', shr.shared,
        'as_of', st.period_end,
        'statement_id', st.id,
        'statement_closing_cents', st.closing_balance_cents,
        'ledger_balance_cents', led.balance_cents,
        'has_opening_balance', coalesce(led.has_opening, false),
        'unbooked_count', tx.unbooked_count,
        'unbooked_sum_cents', tx.unbooked_sum,
        'ignored_count', tx.ignored_count,
        'ignored_sum_cents', tx.ignored_sum,
        'booked_count', tx.booked_count,
        'expected_cents', led.balance_cents + tx.unbooked_sum + tx.ignored_sum,
        -- Delen meerdere bankrekeningen dezelfde grootboekrekening, dan is die stand
        -- de SOM van al die rekeningen en is een verschil per rekening betekenisloos.
        -- Liever geen getal dan een fout getal: null, en de UI legt uit waarom.
        'difference_cents', case
          when st.closing_balance_cents is null or shr.shared then null
          else st.closing_balance_cents - (led.balance_cents + tx.unbooked_sum + tx.ignored_sum)
        end,
        'duplicate_suspects', dup.n,
        'statement_issues', iss.items
      ) as row_json
    from public.bank_accounts ba
    join public.ledger_accounts la on la.id = ba.ledger_account_id
    cross join lateral (
      select count(*) > 1 as shared
      from public.bank_accounts b2
      where b2.organization_id = p_organization_id
        and b2.ledger_account_id = ba.ledger_account_id
    ) shr
    -- Laatste afschrift mét eindsaldo; dat is de peildatum van de aansluiting.
    left join lateral (
      select s2.id, s2.period_end, s2.closing_balance_cents
      from public.bank_statements s2
      where s2.bank_account_id = ba.id and s2.closing_balance_cents is not null
      order by s2.period_end desc nulls last, s2.imported_at desc
      limit 1
    ) st on true
    cross join lateral (
      select
        coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as balance_cents,
        bool_or(je.source_type = 'opening_balance') as has_opening
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      where jl.organization_id = p_organization_id
        and jl.account_id = ba.ledger_account_id
        -- Tegenboekingsparen tellen niet mee. Sinds Blok A blijft het origineel
        -- 'posted' en krijgt de spiegelpost de datum van vandáág — die valt dus
        -- buiten de peildatum terwijl het origineel erbinnen valt. Zonder deze
        -- uitsluiting telt elke teruggedraaide bankboeking dubbel: één keer in het
        -- grootboek en nog eens in "nog te boeken". Een paar is netto nul, dus
        -- beide zijden weglaten is datumonafhankelijk correct.
        and je.reversed_by_entry_id is null
        and je.reverses_entry_id is null
        and (st.period_end is null or je.date <= st.period_end)
    ) led
    cross join lateral (
      select
        count(*) filter (where t.status = 'booked') as booked_count,
        count(*) filter (where t.status in ('unmatched','suggested')) as unbooked_count,
        coalesce(sum(t.amount_cents) filter (where t.status in ('unmatched','suggested')), 0) as unbooked_sum,
        count(*) filter (where t.status = 'ignored') as ignored_count,
        coalesce(sum(t.amount_cents) filter (where t.status = 'ignored'), 0) as ignored_sum
      from public.bank_transactions t
      where t.bank_account_id = ba.id
        and (st.period_end is null or t.booking_date <= st.period_end)
    ) tx
    -- Transacties die op inhoud identiek zijn (datum, bedrag, tegenrekening,
    -- omschrijving). Meestal een dubbele import; soms echt twee gelijke
    -- betalingen. Daarom melden, niet automatisch opruimen.
    cross join lateral (
      select coalesce(sum(d.c - 1), 0)::int as n
      from (
        select count(*) as c
        from public.bank_transactions t2
        where t2.bank_account_id = ba.id
        group by public.bank_canonical_key(t2.booking_date, t2.amount_cents, t2.counterparty_iban, t2.description)
        having count(*) > 1
      ) d
    ) dup
    -- Afschriften die intern niet kloppen: beginsaldo + alle mutaties in de
    -- afschriftperiode ≠ eindsaldo. Op datumbereik (niet op statement_id), zodat
    -- overlappende imports geen vals alarm geven — zie de toelichting bij de
    -- afschriftcontrole in import_bank_transactions.
    cross join lateral (
      select coalesce(jsonb_agg(q.item order by q.period_start desc nulls last), '[]'::jsonb) as items
      from (
        select s3.period_start, jsonb_build_object(
          'statement_id', s3.id,
          'file_name', s3.file_name,
          'period_start', s3.period_start,
          'period_end', s3.period_end,
          'opening_balance_cents', s3.opening_balance_cents,
          'closing_balance_cents', s3.closing_balance_cents,
          'transactions_sum_cents', sums.sum_cents,
          'difference_cents', s3.closing_balance_cents - (s3.opening_balance_cents + sums.sum_cents)
        ) as item
        from public.bank_statements s3
        cross join lateral (
          select coalesce(sum(t3.amount_cents), 0) as sum_cents
          from public.bank_transactions t3
          where t3.bank_account_id = ba.id
            and t3.booking_date between s3.period_start and s3.period_end
        ) sums
        where s3.bank_account_id = ba.id
          and s3.opening_balance_cents is not null
          and s3.closing_balance_cents is not null
          and s3.period_start is not null
          and s3.period_end is not null
          and s3.closing_balance_cents <> s3.opening_balance_cents + sums.sum_cents
        order by s3.period_start desc nulls last
        limit 5
      ) q
    ) iss
    where ba.organization_id = p_organization_id
  ) s;

  return v_out;
end;
$$;

-- compute_vat_return(uuid,date,date)
create or replace function public.compute_vat_return(p_organization_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  return public.compute_vat_boxes(p_organization_id, p_from, p_to, null);
end;
$$;

-- compute_vat_boxes(uuid,date,date,uuid[])
create or replace function public.compute_vat_boxes(p_organization_id uuid, p_from date, p_to date, p_entry_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  r record;
  v_saldo bigint;
  v_saldo_afgerond bigint;
  v_box_vat_total bigint;
  v_consistent boolean;
  v_form_1a bigint; v_form_1b bigint; v_form_1c bigint; v_form_1d bigint;
  v_form_2a bigint; v_form_4a bigint; v_form_4b bigint;
  v_form_5a bigint; v_form_5b bigint; v_form_5c bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_entry_ids is null and (p_from is null or p_to is null) then
    raise exception 'Periode (van/tot) is verplicht.' using errcode = '23514';
  end if;

  with lines as (
    select
      jl.debit_cents, jl.credit_cents, jl.vat_rate, jl.vat_base_cents, jl.vat_amount_cents,
      -- GEWIJZIGD (20260807020000): financiële baten en lasten en het resultaat
      -- uit deelnemingen zijn geen omzet voor de omzetbelasting. Zonder deze
      -- uitzondering valt rente zonder btw-code hieronder in de terugval op het
      -- tarief en belandt hij in rubriek 1e — omzet op de aangifte die er niet
      -- hoort te staan. De sentinelwaarde valt buiten élke acc_type-test
      -- ('revenue' en ('expense','asset')); de grootboektotalen hieronder lopen
      -- over acc_subtype en blijven dus ongemoeid.
      -- Alleen op de TERUGVAL-tak: een regel MÉT btw-code volgt altijd zijn code.
      -- De rubriek is een presentatiekeuze die de gebruiker vrij mag aanpassen;
      -- zonder deze voorwaarde zou zo'n keuze belaste omzet uit rubriek 1a
      -- kunnen halen terwijl de btw wel op 1510 blijft staan.
      case
        when vc.id is null
         and la.report_group in ('financiele_baten', 'financiele_lasten', 'resultaat_deelnemingen')
          then 'non_vat'
        else la.type
      end as acc_type,
      la.subtype as acc_subtype,
      (vc.id is not null) as has_code, vc.sales_box, vc.vat_box
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    left join public.vat_codes vc
      on vc.organization_id = jl.organization_id and vc.code = jl.vat_code
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        case when p_entry_ids is not null
          then je.id = any(p_entry_ids)
          else (
            je.date between p_from and p_to
            -- Het jaarafsluitboekstuk debiteert omzetrekeningen zonder vat_rate;
            -- zonder dit filter lekt dat als negatieve omzet in rubriek 1e.
            and je.source_type <> 'year_close'
            -- In een suppletie verrekende boekstukken zijn al aangegeven.
            and not exists (
              select 1 from public.vat_supplement_entries vse where vse.entry_id = je.id
            )
          )
        end
      )
  ),
  classified as (
    select
      -- Omzetkant: rubriek voor de grondslag. Mét code: sales_box (kan null
      -- zijn — vrijgesteld/KOR telt in geen enkele rubriek). Zonder code:
      -- terugval op het tarief.
      case when acc_type = 'revenue' then
        case
          when has_code then sales_box
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
          else '1e'
        end
      end as rev_box,
      case when acc_type = 'revenue' then credit_cents - debit_cents else 0 end as rev_base,
      -- Omzetkant: rubriek voor de btw (alleen 1a–1d dragen btw).
      case when acc_type = 'revenue' then
        case
          when has_code then (case when coalesce(vat_box, sales_box) in ('1a','1b','1c','1d') then coalesce(vat_box, sales_box) end)
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
        end
      end as rev_vat_box,
      case when acc_type = 'revenue' then coalesce(vat_amount_cents, 0) else 0 end as rev_vat,
      -- Inkoopkant: 2a (binnenland verlegd) / 4a (invoer) / 4b (EU-verwerving)
      -- van kosten-/activaregels met zo'n code. Richting volgt de boekzijde.
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then sales_box end as pur_box,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * coalesce(vat_base_cents, case when debit_cents > 0 then debit_cents else credit_cents end)
        else 0 end as pur_base,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * coalesce(vat_amount_cents, 0)
        else 0 end as pur_vat,
      -- Grootboek-totalen: gezaghebbend voor doorboeking en saldo.
      case when acc_subtype = 'vat_output' then credit_cents - debit_cents else 0 end as gl_output,
      case when acc_subtype = 'vat_reverse' then credit_cents - debit_cents else 0 end as gl_reverse,
      case when acc_subtype = 'vat_input' then debit_cents - credit_cents else 0 end as gl_input
    from lines
  )
  select
    coalesce(sum(rev_base) filter (where rev_box = '1a'), 0) as b1a_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1a'), 0) as b1a_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1b'), 0) as b1b_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1b'), 0) as b1b_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1c'), 0) as b1c_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1c'), 0) as b1c_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1d'), 0) as b1d_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1d'), 0) as b1d_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1e'), 0) as b1e_base,
    coalesce(sum(rev_base) filter (where rev_box = '3a'), 0) as b3a_base,
    coalesce(sum(rev_base) filter (where rev_box = '3b'), 0) as b3b_base,
    coalesce(sum(rev_base) filter (where rev_box = '3c'), 0) as b3c_base,
    coalesce(sum(pur_base) filter (where pur_box = '2a'), 0) as b2a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '2a'), 0) as b2a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4a'), 0) as b4a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4a'), 0) as b4a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4b'), 0) as b4b_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4b'), 0) as b4b_vat,
    coalesce(sum(gl_output), 0) as clear_output,
    coalesce(sum(gl_reverse), 0) as clear_reverse,
    coalesce(sum(gl_input), 0) as clear_input
  into r
  from classified;

  v_saldo := (r.clear_output + r.clear_reverse) - r.clear_input;

  -- Formulierwaarden: hele euro's PER RUBRIEK (rekenkundig, .50 weg van nul —
  -- zoals round(numeric)); 5a is de som van de afgeronde btw-rubrieken en 5c
  -- volgt uit 5a − 5b, precies zoals de Belastingdienst rekent (review 2.9).
  v_form_1a := round(r.b1a_vat::numeric / 100.0)::bigint;
  v_form_1b := round(r.b1b_vat::numeric / 100.0)::bigint;
  v_form_1c := round(r.b1c_vat::numeric / 100.0)::bigint;
  v_form_1d := round(r.b1d_vat::numeric / 100.0)::bigint;
  v_form_2a := round(r.b2a_vat::numeric / 100.0)::bigint;
  v_form_4a := round(r.b4a_vat::numeric / 100.0)::bigint;
  v_form_4b := round(r.b4b_vat::numeric / 100.0)::bigint;
  v_form_5a := v_form_1a + v_form_1b + v_form_1c + v_form_1d + v_form_2a + v_form_4a + v_form_4b;
  v_form_5b := round(r.clear_input::numeric / 100.0)::bigint;
  v_form_5c := v_form_5a - v_form_5b;

  -- Sluiten de rubrieken op het grootboek aan? De btw per rubriek komt uit
  -- regel-metadata (vat_amount_cents); het grootboek (1510+1520) is de waarheid.
  -- Bij een gaaf geboekte administratie zijn die exact gelijk. Wijken ze meer
  -- dan € 1 af (bijv. handmatig op 1510 geboekt zonder metadata), dan is de
  -- rubriekverdeling onvolledig: saldo_afgerond valt dan terug op het oude
  -- gedrag (saldo in één keer afronden) en de UI toont een waarschuwing.
  v_box_vat_total := r.b1a_vat + r.b1b_vat + r.b1c_vat + r.b1d_vat + r.b2a_vat + r.b4a_vat + r.b4b_vat;
  v_consistent := abs(v_box_vat_total - (r.clear_output + r.clear_reverse)) <= 100;

  if v_consistent then
    v_saldo_afgerond := v_form_5c * 100;
  else
    v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;
  end if;

  return jsonb_build_object(
    'boxes', jsonb_build_object(
      '1a', jsonb_build_object('base', r.b1a_base, 'vat', r.b1a_vat),
      '1b', jsonb_build_object('base', r.b1b_base, 'vat', r.b1b_vat),
      '1c', jsonb_build_object('base', r.b1c_base, 'vat', r.b1c_vat),
      '1d', jsonb_build_object('base', r.b1d_base, 'vat', r.b1d_vat),
      '1e', jsonb_build_object('base', r.b1e_base),
      '2a', jsonb_build_object('base', r.b2a_base, 'vat', r.b2a_vat),
      '3a', jsonb_build_object('base', r.b3a_base),
      '3b', jsonb_build_object('base', r.b3b_base),
      '3c', jsonb_build_object('base', r.b3c_base),
      '4a', jsonb_build_object('base', r.b4a_base, 'vat', r.b4a_vat),
      '4b', jsonb_build_object('base', r.b4b_base, 'vat', r.b4b_vat)
    ),
    'form', jsonb_build_object(
      '1a', jsonb_build_object('base', round(r.b1a_base::numeric / 100.0)::bigint, 'vat', v_form_1a),
      '1b', jsonb_build_object('base', round(r.b1b_base::numeric / 100.0)::bigint, 'vat', v_form_1b),
      '1c', jsonb_build_object('base', round(r.b1c_base::numeric / 100.0)::bigint, 'vat', v_form_1c),
      '1d', jsonb_build_object('base', round(r.b1d_base::numeric / 100.0)::bigint, 'vat', v_form_1d),
      '1e', jsonb_build_object('base', round(r.b1e_base::numeric / 100.0)::bigint),
      '2a', jsonb_build_object('base', round(r.b2a_base::numeric / 100.0)::bigint, 'vat', v_form_2a),
      '3a', jsonb_build_object('base', round(r.b3a_base::numeric / 100.0)::bigint),
      '3b', jsonb_build_object('base', round(r.b3b_base::numeric / 100.0)::bigint),
      '3c', jsonb_build_object('base', round(r.b3c_base::numeric / 100.0)::bigint),
      '4a', jsonb_build_object('base', round(r.b4a_base::numeric / 100.0)::bigint, 'vat', v_form_4a),
      '4b', jsonb_build_object('base', round(r.b4b_base::numeric / 100.0)::bigint, 'vat', v_form_4b),
      '5a', v_form_5a, '5b', v_form_5b, '5c', v_form_5c
    ),
    'boxes_consistent', v_consistent,
    'boxes_vat_diff_cents', v_box_vat_total - (r.clear_output + r.clear_reverse),
    -- Bestaande sleutels (oudere UI-versies, bevroren snapshots, bankmatching):
    'omzet_hoog_base', r.b1a_base, 'omzet_hoog_btw', r.b1a_vat,
    'omzet_laag_base', r.b1b_base, 'omzet_laag_btw', r.b1b_vat,
    'omzet_nul_base', r.b1e_base,
    'verlegd_btw', r.clear_reverse,
    'verschuldigd_total', r.clear_output + r.clear_reverse,
    'voorbelasting', r.clear_input,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_saldo - v_saldo_afgerond,
    'clear_output', r.clear_output,
    'clear_reverse', r.clear_reverse,
    'clear_input', r.clear_input
  );
end;
$$;

-- compute_icp_declaration(uuid,date,date)
create or replace function public.compute_icp_declaration(p_organization_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_rows jsonb;
  v_goods_total bigint;
  v_services_total bigint;
  v_unassigned bigint;
  v_missing integer;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  with icp_lines as (
    select
      jl.client_id,
      case when vc.kind = 'icp_goods' then jl.credit_cents - jl.debit_cents else 0 end as goods_cents,
      case when vc.kind = 'icp_services' then jl.credit_cents - jl.debit_cents else 0 end as services_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    join public.vat_codes vc
      on vc.organization_id = jl.organization_id and vc.code = jl.vat_code
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date between p_from and p_to
      and je.source_type <> 'year_close'
      and not exists (select 1 from public.vat_supplement_entries vse where vse.entry_id = je.id)
      and la.type = 'revenue'
      and vc.kind in ('icp_goods', 'icp_services')
  ),
  grouped as (
    select
      il.client_id,
      c.name as client_name,
      c.vat_number,
      c.country,
      sum(il.goods_cents)::bigint as goods_cents,
      sum(il.services_cents)::bigint as services_cents
    from icp_lines il
    left join public.clients c on c.id = il.client_id
    group by il.client_id, c.name, c.vat_number, c.country
    having sum(il.goods_cents) <> 0 or sum(il.services_cents) <> 0
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'client_id', g.client_id,
      'client_name', coalesce(g.client_name, '— geen klant op de boekingsregel —'),
      'vat_number', g.vat_number,
      'country', g.country,
      'goods_cents', g.goods_cents,
      'services_cents', g.services_cents
    ) order by coalesce(g.client_name, '')), '[]'::jsonb),
    coalesce(sum(g.goods_cents), 0),
    coalesce(sum(g.services_cents), 0),
    coalesce(sum(case when g.client_id is null then g.goods_cents + g.services_cents else 0 end), 0),
    count(*) filter (where g.client_id is not null and nullif(btrim(coalesce(g.vat_number, '')), '') is null)
  into v_rows, v_goods_total, v_services_total, v_unassigned, v_missing
  from grouped g;

  return jsonb_build_object(
    'rows', v_rows,
    'goods_total_cents', v_goods_total,
    'services_total_cents', v_services_total,
    'total_cents', v_goods_total + v_services_total,
    'unassigned_cents', v_unassigned,
    'missing_vat_numbers', v_missing
  );
end;
$$;

-- compute_vat_supplement_delta(uuid,uuid[])
create or replace function public.compute_vat_supplement_delta(p_organization_id uuid, p_entry_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_entry_ids is null or array_length(p_entry_ids, 1) is null then
    raise exception 'Kies minimaal één boekstuk voor de suppletie.' using errcode = '23514';
  end if;
  return public.compute_vat_boxes(p_organization_id, null, null, p_entry_ids);
end;
$$;

-- list_fiscal_years(uuid)
create or replace function public.list_fiscal_years(p_organization_id uuid)
 RETURNS TABLE(id uuid, label text, period_start date, period_end date, status text, result_cents bigint, close_journal_entry_id uuid, computed_result_cents bigint, has_entries boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
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

-- ── 3. Vergaderlinks alleen http(s) ────────────────────────────────────────

alter table public.calendar_events drop constraint if exists calendar_events_meeting_url_http;
alter table public.calendar_events
  add constraint calendar_events_meeting_url_http
  check (meeting_url is null or meeting_url ~* '^https?://') not valid;

-- ── 4. Een uitnodiging aannemen vraagt een bevestigd e-mailadres ───────────

create or replace function public.accept_organization_invitation(p_invitation_id uuid)
 RETURNS organization_members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_user_id    uuid := auth.uid();
  v_email      citext := public.current_user_email();
  v_invitation public.organization_invitations;
  v_member     public.organization_members;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if v_email is null then raise exception 'Geen e-mail bekend in sessie' using errcode = '23514'; end if;
  -- Een uitnodiging hoort bij een e-mailadres. Alleen wie dat adres heeft
  -- bevestigd, mag haar aannemen; anders telt alleen wat er in het token staat.
  if not exists (select 1 from auth.users u where u.id = v_user_id and u.email_confirmed_at is not null) then
    raise exception 'Bevestig eerst je e-mailadres; daarna kun je de uitnodiging aannemen.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
    and status = 'pending'
    and email = v_email
    and (expires_at is null or expires_at > now())
  for update;

  if not found then
    raise exception 'Uitnodiging niet gevonden of verlopen' using errcode = 'P0002';
  end if;

  if v_invitation.role = 'accountant' and exists (
    select 1 from public.organization_members
    where organization_id = v_invitation.organization_id
      and role = 'accountant' and status = 'active' and user_id <> v_user_id
  ) then
    raise exception 'Deze administratie heeft al een actieve boekhouder. Vraag de owner om die eerst uit te zetten.'
      using errcode = '23505';
  end if;

  perform set_config('resofly.accepting_invitation', 'on', true);

  update public.organization_invitations
  set status = 'accepted', consumes_license = false, accepted_by = v_user_id, accepted_at = now(), updated_at = now()
  where id = v_invitation.id;

  insert into public.organization_members(organization_id, user_id, email, role, module_access, status, invited_by, joined_at)
  values (
    v_invitation.organization_id, v_user_id, v_email, v_invitation.role,
    case when v_invitation.role = 'accountant' then '{}'::jsonb else coalesce(v_invitation.module_access, '{}'::jsonb) end,
    'active', v_invitation.invited_by, now()
  )
  on conflict (organization_id, user_id)
  do update set
    role = excluded.role,
    module_access = excluded.module_access,
    status = 'active',
    email = excluded.email,
    updated_at = now()
  returning * into v_member;

  perform set_config('resofly.accepting_invitation', '', true);

  return v_member;
end;
$$;

-- ── 5. Stream: alleen een Cloudflare Stream-host als afspeelbasis ──────────

create or replace function public.enforce_gallery_stream_uid_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stream_playback_base is not null
     and (tg_op = 'INSERT' or new.stream_playback_base is distinct from old.stream_playback_base)
     and new.stream_playback_base !~ '^https://(customer-[a-z0-9]+\.cloudflarestream\.com|videodelivery\.net)$' then
    raise exception 'Ongeldige afspeelhost voor deze video.' using errcode = '22023';
  end if;
  if new.stream_uid is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.stream_uid is not distinct from old.stream_uid
     and new.organization_id = old.organization_id then
    return new;
  end if;
  if exists (
    select 1 from public.gallery_items gi
    where gi.stream_uid = new.stream_uid
      and gi.organization_id <> new.organization_id
  ) then
    raise exception 'Deze video hoort bij een andere organisatie.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_gallery_stream_uid_owner() from public, anon, authenticated;

drop trigger if exists gallery_items_stream_uid_owner on public.gallery_items;
create trigger gallery_items_stream_uid_owner
  before insert or update of stream_uid, stream_playback_base, organization_id on public.gallery_items
  for each row execute function public.enforce_gallery_stream_uid_owner();

-- ── Rechten: ongewijzigd voor ingelogde gebruikers en de service-role, dicht voor anon ──

revoke all on function public.report_account_ledger(uuid, uuid, date, date) from public, anon;
grant execute on function public.report_account_ledger(uuid, uuid, date, date) to authenticated, service_role;
revoke all on function public.report_trial_balance(uuid, date) from public, anon;
grant execute on function public.report_trial_balance(uuid, date) to authenticated, service_role;
revoke all on function public.report_balance_sheet(uuid, date) from public, anon;
grant execute on function public.report_balance_sheet(uuid, date) to authenticated, service_role;
revoke all on function public.report_profit_and_loss(uuid, date, date) from public, anon;
grant execute on function public.report_profit_and_loss(uuid, date, date) to authenticated, service_role;
revoke all on function public.report_open_items(uuid, date) from public, anon;
grant execute on function public.report_open_items(uuid, date) to authenticated, service_role;
revoke all on function public.report_bank_reconciliation(uuid) from public, anon;
grant execute on function public.report_bank_reconciliation(uuid) to authenticated, service_role;
revoke all on function public.compute_vat_return(uuid, date, date) from public, anon;
grant execute on function public.compute_vat_return(uuid, date, date) to authenticated, service_role;
revoke all on function public.compute_vat_boxes(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.compute_vat_boxes(uuid, date, date, uuid[]) to authenticated, service_role;
revoke all on function public.compute_icp_declaration(uuid, date, date) from public, anon;
grant execute on function public.compute_icp_declaration(uuid, date, date) to authenticated, service_role;
revoke all on function public.compute_vat_supplement_delta(uuid, uuid[]) from public, anon;
grant execute on function public.compute_vat_supplement_delta(uuid, uuid[]) to authenticated, service_role;
revoke all on function public.list_fiscal_years(uuid) from public, anon;
grant execute on function public.list_fiscal_years(uuid) to authenticated, service_role;
revoke all on function public.accept_organization_invitation(uuid) from public, anon;
grant execute on function public.accept_organization_invitation(uuid) to authenticated, service_role;

commit;
