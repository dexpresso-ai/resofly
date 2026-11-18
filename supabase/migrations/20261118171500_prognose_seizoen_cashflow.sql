-- ============================================================
-- ResoFly — Prognose: seizoenspatroon en cashflow
-- Date: 2026-11-18
--
-- WAAROM
-- Vraag: "Bouw ook een seizoenspatroon uit vorige jaren en een
-- cashflowprognose." De prognose (20261118144500) rekende per maand met een
-- gemiddelde maand: een rustige zomer of een drukke december zag je niet. En
-- ze zei wat je verdient, niet wat er op je rekening staat. Juist dat verschilt:
-- een klant betaalt pas na weken, de btw gaat per kwartaal de deur uit, een
-- afschrijving kost geen geld en een investering wel.
--
-- WAT
-- 1. forecast_history krijgt per maand de btw en de afschrijvingen erbij:
--    - vat_out_cents / vat_in_cents: de btw op je facturen (min creditnota's)
--      en op je inkoopfacturen, zoals de omzet en de inkoop zelf ook al tellen;
--    - ledger_vat_out_cents / ledger_vat_in_cents: dezelfde btw uit de
--      boekhouding (af te dragen en voorbelasting), zonder de boekingen van een
--      aangifte zelf: die zetten de btw alleen over naar "te betalen";
--    - ledger_depreciation_cents: afschrijvingen. Die staan in de kosten, maar
--      gaan niet van je rekening af.
--    Het seizoenspatroon gebruikt de omzet die er al was; daarvoor vraagt de
--    app nu vier jaar terug op in plaats van één (forecast.ts, historyRange).
-- 2. forecast_cash_position(organisatie): waar de cashflow begint.
--    - het saldo per bankrekening: het eindsaldo van het laatste afschrift plus
--      wat er daarna binnenkwam en afging. Zonder afschrift met saldo: de stand
--      in de boekhouding plus de bankregels die nog niet geboekt zijn, maar
--      alleen als er een beginbalans op die rekening staat (anders tel je alleen
--      de mutaties en mis je het begin) en de rekening zijn grootboekrekening
--      niet met een andere bankrekening deelt (dan is die stand de som van
--      allebei). Anders: onbekend, en vult de gebruiker het zelf in;
--    - de kas (grootboekrekeningen met subtype cash die geen bankrekening zijn);
--    - openstaande facturen en inkoopfacturen, per maand waarin ze vervallen;
--    - de btw-aangiftes van de laatste maanden met hun status en saldo, en de
--      betalingen aan de Belastingdienst op de bank (dezelfde herkenning als de
--      Bankpagina: de inningsrekening of "Belastingdienst" in de naam);
--    - het betaalgedrag van je klanten: na hoeveel dagen ze het afgelopen jaar
--      gemiddeld betaalden (naar bedrag gewogen), met de bankdatum als die er is;
--    - de betaaltermijn, de KOR en het btw-tijdvak uit de bedrijfsgegevens.
--
-- RECHTEN
-- Zoals forecast_history: de service-role (Gerrie, de API: die geven de
-- organisatie uit de geverifieerde sessie mee) of lid van de organisatie met
-- leesrecht op Financiën. Elke tabel hieronder filtert zelf op de organisatie:
-- als security definer slaat de functie RLS over.
--
-- Veilig om opnieuw te draaien: create or replace.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. forecast_history: met btw en afschrijvingen per maand
-- ------------------------------------------------------------
-- Ongewijzigd: projects, revenue_project_cents, revenue_other_cents,
-- purchase_cents, ledger_revenue_cents, ledger_expense_cents en pipeline
-- (zie 20261118144500). Nieuw per maand: vat_out_cents, vat_in_cents,
-- ledger_vat_out_cents, ledger_vat_in_cents en ledger_depreciation_cents.
create or replace function public.forecast_history(p_organization_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_projects boolean;
  v_from date;
  v_to date;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_months jsonb;
  v_pipeline jsonb;
begin
  if p_organization_id is null or p_from is null or p_to is null then
    raise exception 'Geef een organisatie en een periode.' using errcode = '22023';
  end if;
  -- De service-role (Gerrie, de API) controleert de organisatie zelf: die
  -- komt daar uit de geverifieerde sessie.
  if not v_service
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  v_from := date_trunc('month', p_from)::date;
  v_to := (date_trunc('month', p_to) + interval '1 month' - interval '1 day')::date;
  if v_from > v_to then
    raise exception 'Het begin ligt na het einde.' using errcode = '22023';
  end if;
  if v_to >= (v_from + interval '6 years')::date then
    raise exception 'Hooguit zes jaar tegelijk.' using errcode = '22023';
  end if;

  v_projects := v_service or public.can_read_module(p_organization_id, 'projects');

  with months as (
    select gs::date as m from generate_series(v_from, v_to, interval '1 month') gs
  ),
  proj as (
    select date_trunc('month', coalesce(p.start_date, (p.created_at at time zone 'Europe/Amsterdam')::date))::date as m,
           count(*)::integer as n
      from public.projects p
     where p.organization_id = p_organization_id
       and coalesce(p.start_date, (p.created_at at time zone 'Europe/Amsterdam')::date) between v_from and v_to
     group by 1
  ),
  inv as (
    select date_trunc('month', i.date)::date as m,
           sum(case when i.project_id is not null then round(i.subtotal_amount * 100) else 0 end)::bigint as with_project,
           sum(case when i.project_id is null then round(i.subtotal_amount * 100) else 0 end)::bigint as without_project,
           sum(round(coalesce(i.vat_amount, 0) * 100))::bigint as vat
      from public.invoices i
     where i.organization_id = p_organization_id
       and i.status in ('sent', 'overdue', 'paid', 'written_off')
       and i.date between v_from and v_to
     group by 1
  ),
  credit as (
    select date_trunc('month', c.date)::date as m,
           sum(case when i.project_id is not null then round(c.subtotal_amount * 100) else 0 end)::bigint as with_project,
           sum(case when i.project_id is null then round(c.subtotal_amount * 100) else 0 end)::bigint as without_project,
           sum(round(coalesce(c.vat_amount, 0) * 100))::bigint as vat
      from public.credit_notes c
      join public.invoices i on i.id = c.invoice_id and i.organization_id = c.organization_id
     where c.organization_id = p_organization_id
       and c.status = 'issued'
       -- Telt de factuur zelf al niet meer mee (geannuleerd, terugbetaald),
       -- dan ging de omzet er al af; de creditnota nog eens aftrekken telt dubbel.
       and i.status in ('sent', 'overdue', 'paid', 'written_off')
       and c.date between v_from and v_to
     group by 1
  ),
  purchase as (
    select date_trunc('month', pi.date)::date as m,
           sum(pi.subtotal_cents)::bigint as cents,
           sum(coalesce(pi.vat_cents, 0))::bigint as vat
      from public.purchase_invoices pi
     where pi.organization_id = p_organization_id
       and pi.status in ('booked', 'paid')
       and pi.date between v_from and v_to
     group by 1
  ),
  ledger as (
    select date_trunc('month', je.date)::date as m,
           sum(case when la.type = 'revenue' then jl.credit_cents - jl.debit_cents else 0 end)::bigint as revenue,
           sum(case when la.type = 'expense' then jl.debit_cents - jl.credit_cents else 0 end)::bigint as expense
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
     where jl.organization_id = p_organization_id
       and je.status = 'posted'
       and je.source_type <> 'year_close'
       and je.date between v_from and v_to
       and la.type in ('revenue', 'expense')
     group by 1
  ),
  -- De btw zoals de boekhouding hem kent. De boeking van een aangifte zelf
  -- (source_type vat_return) haalt de btw van 1500/1510/1520 weg naar 1530
  -- "te betalen"; die telt hier niet, anders viel de btw van een heel kwartaal
  -- weg in de maand van de aangifte.
  -- Afschrijvingen: elke kostenregel van een afschrijvingsboeking, of op een
  -- kostenrekening met subtype depreciation (ook een handmatige). Die kosten
  -- gaan niet van de rekening af: dat geld ging eruit bij de aankoop.
  ledger_cash as (
    select date_trunc('month', je.date)::date as m,
           sum(case when la.subtype in ('vat_output', 'vat_reverse') and je.source_type <> 'vat_return'
                    then jl.credit_cents - jl.debit_cents else 0 end)::bigint as vat_out,
           sum(case when la.subtype = 'vat_input' and je.source_type <> 'vat_return'
                    then jl.debit_cents - jl.credit_cents else 0 end)::bigint as vat_in,
           sum(case when la.type = 'expense' and (la.subtype = 'depreciation' or je.source_type = 'asset_depreciation')
                    then jl.debit_cents - jl.credit_cents else 0 end)::bigint as depreciation
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
     where jl.organization_id = p_organization_id
       and je.status = 'posted'
       and je.source_type <> 'year_close'
       and je.date between v_from and v_to
       and (la.subtype in ('vat_output', 'vat_reverse', 'vat_input', 'depreciation')
            or (la.type = 'expense' and je.source_type = 'asset_depreciation'))
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', to_char(months.m, 'YYYY-MM'),
           'projects', case when v_projects then coalesce(proj.n, 0) else null end,
           'revenue_project_cents', coalesce(inv.with_project, 0) - coalesce(credit.with_project, 0),
           'revenue_other_cents', coalesce(inv.without_project, 0) - coalesce(credit.without_project, 0),
           'purchase_cents', coalesce(purchase.cents, 0),
           'ledger_revenue_cents', coalesce(ledger.revenue, 0),
           'ledger_expense_cents', coalesce(ledger.expense, 0),
           'vat_out_cents', coalesce(inv.vat, 0) - coalesce(credit.vat, 0),
           'vat_in_cents', coalesce(purchase.vat, 0),
           'ledger_vat_out_cents', coalesce(ledger_cash.vat_out, 0),
           'ledger_vat_in_cents', coalesce(ledger_cash.vat_in, 0),
           'ledger_depreciation_cents', coalesce(ledger_cash.depreciation, 0)
         ) order by months.m), '[]'::jsonb)
    into v_months
    from months
    left join proj on proj.m = months.m
    left join inv on inv.m = months.m
    left join credit on credit.m = months.m
    left join purchase on purchase.m = months.m
    left join ledger on ledger.m = months.m
    left join ledger_cash on ledger_cash.m = months.m;

  -- Een offerte bewaart geen bedrag: dat staat in de regels. Een regel met
  -- iets anders dan een getal telt als nul in plaats van de hele prognose te
  -- laten struikelen.
  with q as (
    select q.status,
           q.date,
           q.valid_until,
           exists (
             select 1 from public.invoices i
              where i.organization_id = p_organization_id
                and i.quote_id = q.id
                and i.status not in ('cancelled', 'void')
           ) as invoiced,
           (select coalesce(sum(round(
                     (case when (l.value->>'quantity') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (l.value->>'quantity')::numeric else 0 end)
                   * (case when (l.value->>'unit_price') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (l.value->>'unit_price')::numeric else 0 end)
                   * 100)), 0)
              from jsonb_array_elements(case when jsonb_typeof(q.lines) = 'array' then q.lines else '[]'::jsonb end) l
           )::bigint as cents
      from public.quotes q
     where q.organization_id = p_organization_id
       and q.status in ('sent', 'accepted', 'paid', 'rejected', 'expired')
  )
  select jsonb_build_object(
           'open_count', count(*) filter (where status = 'sent' and (valid_until is null or valid_until >= v_today)),
           'open_cents', coalesce(sum(cents) filter (where status = 'sent' and (valid_until is null or valid_until >= v_today)), 0),
           'accepted_count', count(*) filter (where status = 'accepted' and not invoiced),
           'accepted_cents', coalesce(sum(cents) filter (where status = 'accepted' and not invoiced), 0),
           'won_count', count(*) filter (where status in ('accepted', 'paid') and date > v_today - 365),
           'lost_count', count(*) filter (where (status in ('rejected', 'expired')
                                                 or (status = 'sent' and valid_until < v_today))
                                                and date > v_today - 365)
         )
    into v_pipeline
    from q;

  return jsonb_build_object(
    'from', to_char(v_from, 'YYYY-MM'),
    'to', to_char(v_to, 'YYYY-MM'),
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'projects_visible', v_projects,
    'months', v_months,
    'pipeline', v_pipeline
  );
end;
$$;

revoke all on function public.forecast_history(uuid, date, date) from public, anon;
grant execute on function public.forecast_history(uuid, date, date) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. forecast_cash_position: waar de cashflow begint
-- ------------------------------------------------------------
create or replace function public.forecast_cash_position(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_terms_text text;
  v_terms integer;
  v_kor boolean;
  v_frequency text;
  v_bank jsonb;
  v_cash bigint;
  v_receivables jsonb;
  v_payables jsonb;
  v_returns jsonb;
  v_tax jsonb;
  v_paid_count integer;
  v_paid_days numeric;
begin
  if p_organization_id is null then
    raise exception 'Geef een organisatie.' using errcode = '22023';
  end if;
  if not v_service
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Zonder bedrijfsgegevens zet select into alles op null: daarom de
  -- standaarden pas daarna.
  select cs.invoice_payment_terms, cs.kor_enabled, cs.vat_return_period
    into v_terms_text, v_kor, v_frequency
    from public.company_settings cs
   where cs.organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  v_frequency := case when v_frequency = 'monthly' then 'monthly' else 'quarterly' end;
  -- Dezelfde regel als paymentTermDays (src/lib/financeRules.ts): het eerste
  -- "30 dagen" in de tekst, anders 14; altijd tussen 1 en 120.
  v_terms := least(120, greatest(1, coalesce(
    (regexp_match(lower(coalesce(v_terms_text, '')), '(\d{1,3})\s*(?:dagen|dag|days)\y'))[1]::integer, 14)));

  -- Het saldo per actieve bankrekening.
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', b.name,
           'balance_cents', b.balance_cents,
           'method', b.method,
           'as_of', b.as_of
         ) order by b.name, b.id), '[]'::jsonb)
    into v_bank
    from (
      select ba.id,
             ba.name,
             case when st.closing_balance_cents is not null then st.closing_balance_cents + after_st.sum_cents
                  when not shr.shared and led.has_opening then led.balance_cents + unbooked.sum_cents
             end as balance_cents,
             case when st.closing_balance_cents is not null then 'statement'
                  when not shr.shared and led.has_opening then 'ledger'
             end as method,
             case when st.closing_balance_cents is not null then greatest(st.period_end, after_st.last_date)
                  when not shr.shared and led.has_opening then v_today
             end as as_of
        from public.bank_accounts ba
        cross join lateral (
          select count(*) > 1 as shared
            from public.bank_accounts b2
           where b2.organization_id = p_organization_id
             and b2.is_active
             and b2.ledger_account_id = ba.ledger_account_id
        ) shr
        -- Het laatste afschrift met een eindsaldo en een einddatum: de bank zegt
        -- zelf wat er op die dag stond.
        left join lateral (
          select s.closing_balance_cents, s.period_end
            from public.bank_statements s
           where s.organization_id = p_organization_id
             and s.bank_account_id = ba.id
             and s.closing_balance_cents is not null
             and s.period_end is not null
           order by s.period_end desc, s.imported_at desc
           limit 1
        ) st on true
        -- Wat er daarna binnenkwam en afging (een latere import, de
        -- bankkoppeling). Handmatige mutaties zijn geen bankregels.
        cross join lateral (
          select coalesce(sum(t.amount_cents), 0)::bigint as sum_cents, max(t.booking_date) as last_date
            from public.bank_transactions t
           where t.organization_id = p_organization_id
             and t.bank_account_id = ba.id
             and not t.is_manual
             and st.period_end is not null
             and t.booking_date > st.period_end
             and t.booking_date <= v_today
        ) after_st
        cross join lateral (
          select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint as balance_cents,
                 coalesce(bool_or(je.source_type = 'opening_balance'), false) as has_opening
            from public.journal_lines jl
            join public.journal_entries je on je.id = jl.entry_id
                                           and je.organization_id = p_organization_id
                                           and je.status = 'posted'
           where jl.organization_id = p_organization_id
             and jl.account_id = ba.ledger_account_id
             and je.date <= v_today
        ) led
        -- Bankregels die nog niet in de boekhouding staan: niet geboekt,
        -- genegeerd, of samengevoegd met een handmatige mutatie die zelf nog
        -- niet geboekt is. Dezelfde regel als report_bank_reconciliation.
        cross join lateral (
          select coalesce(sum(t.amount_cents), 0)::bigint as sum_cents
            from public.bank_transactions t
            left join public.bank_transactions m on m.id = t.merged_into_id and m.organization_id = p_organization_id
           where t.organization_id = p_organization_id
             and t.bank_account_id = ba.id
             and not t.is_manual
             and t.booking_date <= v_today
             and (t.status in ('unmatched', 'suggested', 'ignored')
                  or (t.status = 'merged' and m.status in ('unmatched', 'suggested')))
        ) unbooked
       where ba.organization_id = p_organization_id
         and ba.is_active
    ) b;

  -- De kas: rekeningen met subtype cash die niet als bankrekening meedoen
  -- (wie contant ontvangt op 1000 Kas als bankrekening, telt daar al).
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
    into v_cash
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
                                   and je.organization_id = p_organization_id
                                   and je.status = 'posted'
    join public.ledger_accounts la on la.id = jl.account_id and la.organization_id = p_organization_id
   where jl.organization_id = p_organization_id
     and la.subtype = 'cash'
     and je.date <= v_today
     and not exists (
       select 1 from public.bank_accounts ba
        where ba.organization_id = p_organization_id
          and ba.is_active
          and ba.ledger_account_id = la.id
     );

  -- Openstaande facturen, per maand waarin ze vervallen (zonder vervaldatum:
  -- factuurdatum plus de betaaltermijn). Een geboekte factuur: wat er in de
  -- boekhouding nog openstaat (bank, Mollie en creditnota's eraf). Een
  -- ongeboekte: het totaal min de creditnota's en wat via Mollie binnenkwam.
  with open_items as (
    select coalesce(i.due_date, i.date + v_terms) as due,
           case
             when i.journal_entry_id is not null then public.invoice_open_receivable_cents(p_organization_id, i.id)
             else round(coalesce(i.total_amount, 0) * 100)::bigint
                  - coalesce((select round(sum(cn.total_amount) * 100)::bigint
                                from public.credit_notes cn
                               where cn.organization_id = p_organization_id
                                 and cn.invoice_id = i.id
                                 and cn.status = 'issued'), 0)
                  - coalesce((select sum(r.amount_cents - r.amount_refunded_cents)::bigint
                                from public.invoice_payment_records r
                               where r.organization_id = p_organization_id
                                 and r.invoice_id = i.id
                                 and r.status = 'paid'), 0)
           end as cents
      from public.invoices i
     where i.organization_id = p_organization_id
       and i.status in ('sent', 'overdue')
  )
  select coalesce(jsonb_agg(jsonb_build_object('month', x.month, 'cents', x.cents, 'count', x.n) order by x.month), '[]'::jsonb)
    into v_receivables
    from (
      select to_char(date_trunc('month', due), 'YYYY-MM') as month, sum(cents)::bigint as cents, count(*)::integer as n
        from open_items
       where cents > 0 and due is not null
       group by 1
    ) x;

  -- Openstaande inkoopfacturen (geboekt, nog niet betaald), per maand waarin
  -- ze vervallen; zonder vervaldatum 30 dagen na de factuurdatum. Een concept
  -- telt niet: dat is nog geen schuld, net als in forecast_history. Negatief is
  -- een creditnota van de leverancier: geld dat terugkomt.
  with open_items as (
    select coalesce(pi.due_date, pi.date + 30) as due,
           case
             when pi.journal_entry_id is not null then public.purchase_invoice_open_payable_cents(p_organization_id, pi.id)
             when pi.payment_status = 'unpaid' then pi.total_cents::bigint
             else 0::bigint
           end as cents
      from public.purchase_invoices pi
     where pi.organization_id = p_organization_id
       and pi.status = 'booked'
       and pi.payment_status <> 'paid'
  )
  select coalesce(jsonb_agg(jsonb_build_object('month', x.month, 'cents', x.cents, 'count', x.n) order by x.month), '[]'::jsonb)
    into v_payables
    from (
      select to_char(date_trunc('month', due), 'YYYY-MM') as month, sum(cents)::bigint as cents, count(*)::integer as n
        from open_items
       where cents <> 0 and due is not null
       group by 1
    ) x;

  -- De btw-aangiftes van de laatste negen maanden (geen suppleties): de
  -- cashflow neemt het saldo van een afgesloten of ingediende aangifte over en
  -- slaat een betaalde over. saldo_afgerond is het bedrag in hele euro's dat
  -- je werkelijk betaalt (positief) of terugkrijgt (negatief), in centen.
  select coalesce(jsonb_agg(jsonb_build_object(
           'period_type', vr.period_type,
           'year', vr.year,
           'index', vr.period_index,
           'period_end', vr.period_end,
           'status', vr.status,
           'saldo_cents', coalesce(
             case when (vr.rubrieken->>'saldo_afgerond') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                  then round((vr.rubrieken->>'saldo_afgerond')::numeric)::bigint end,
             case when (vr.rubrieken->>'saldo') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                  then round((vr.rubrieken->>'saldo')::numeric)::bigint end,
             0)
         ) order by vr.period_end, vr.created_at), '[]'::jsonb)
    into v_returns
    from public.vat_returns vr
   where vr.organization_id = p_organization_id
     and vr.supplements_return_id is null
     and vr.period_end >= (v_today - interval '9 months')::date;

  -- Betalingen aan de Belastingdienst van de laatste vier maanden. Is de btw
  -- van het vorige tijdvak deze maand al betaald, dan staat hij al in het
  -- saldo en mag de cashflow hem niet nog eens aftrekken.
  select coalesce(jsonb_agg(jsonb_build_object('date', t.booking_date, 'cents', -t.amount_cents)
           order by t.booking_date), '[]'::jsonb)
    into v_tax
    from public.bank_transactions t
   where t.organization_id = p_organization_id
     and t.amount_cents < 0
     and t.status <> 'merged'
     and t.booking_date between v_today - 120 and v_today
     and (upper(replace(coalesce(t.counterparty_iban, ''), ' ', '')) = 'NL86INGB0002445588'
          or coalesce(t.counterparty_name, '') ilike '%belastingdienst%');

  -- Betaalgedrag: na hoeveel dagen klanten het afgelopen jaar betaalden,
  -- gewogen naar het bedrag (een grote factuur die laat binnenkomt, weegt
  -- zwaarder voor je rekening). De betaaldatum is de bankdatum als de betaling
  -- op de bank is afgeletterd; paid_at is het moment van afletteren en kan
  -- dagen later zijn. Tussen 0 en 365 dagen.
  select count(*)::integer,
         round(sum(x.cents * least(365, greatest(0, x.pay_date - x.date))::numeric) / nullif(sum(x.cents), 0), 1)
    into v_paid_count, v_paid_days
    from (
      select round(coalesce(i.total_amount, 0) * 100)::bigint as cents,
             i.date,
             coalesce((
               select max(t.booking_date)
                 from public.bank_transaction_allocations a
                 join public.bank_transactions t on t.id = a.bank_transaction_id and t.organization_id = p_organization_id
                 join public.journal_entries je on je.id = a.journal_entry_id
                                                and je.organization_id = p_organization_id
                                                and je.status = 'posted'
                                                and je.reversed_by_entry_id is null
                                                and je.reverses_entry_id is null
                where a.organization_id = p_organization_id
                  and a.invoice_id = i.id
                  and a.kind = 'sales_invoice'
             ), (i.paid_at at time zone 'Europe/Amsterdam')::date) as pay_date
        from public.invoices i
       where i.organization_id = p_organization_id
         and i.status = 'paid'
         and i.paid_at is not null
    ) x
   where x.cents > 0
     and x.pay_date between v_today - 365 and v_today;

  return jsonb_build_object(
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'bank', v_bank,
    'cash_accounts_cents', coalesce(v_cash, 0),
    'receivables', v_receivables,
    'payables', v_payables,
    'vat_frequency', v_frequency,
    'kor', v_kor,
    'vat_returns', v_returns,
    'tax_payments', v_tax,
    'payment_terms_days', v_terms,
    'collection', jsonb_build_object('paid_count', coalesce(v_paid_count, 0), 'days', v_paid_days)
  );
end;
$$;

revoke all on function public.forecast_cash_position(uuid) from public, anon;
grant execute on function public.forecast_cash_position(uuid) to authenticated, service_role;

commit;
