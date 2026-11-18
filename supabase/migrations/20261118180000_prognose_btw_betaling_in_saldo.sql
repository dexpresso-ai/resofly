-- ============================================================
-- ResoFly — Prognose: een btw-betaling telt alleen als hij in het banksaldo zit
-- Date: 2026-11-18
--
-- WAAROM
-- De cashflow slaat de btw over van het tijdvak dat deze maand betaald moet
-- worden als er na afloop van dat tijdvak al geld naar de Belastingdienst
-- ging: dat zit in het banksaldo, en twee keer aftrekken voorspelt een tekort
-- dat er niet is (20261118171500). Maar dat saldo telt een handmatige mutatie
-- niet mee zolang de bank hem niet leverde (rekening met afschrift) of hij niet
-- geboekt is (rekening uit de boekhouding). Wie zijn btw-betaling met de hand
-- invoerde, kreeg zo een saldo zonder die betaling én een cashflow zonder die
-- btw: de betaling verdween helemaal, en het saldo kwam te hoog uit.
--
-- WAT
-- forecast_cash_position geeft per betaling aan de Belastingdienst ook
-- in_balance: zit hij in het saldo waarmee de cashflow begint. De cashflow
-- (forecast.ts) slaat de btw alleen nog over bij zo'n betaling, of als je je
-- banksaldo zelf invulde: dat saldo is van nu, met alles wat al betaald is.
-- Verder is de functie gelijk aan die van 20261118171500.
--
-- RECHTEN
-- Ongewijzigd: de service-role (die geeft de organisatie uit de geverifieerde
-- sessie mee) of lid van de organisatie met leesrecht op Financiën. Elke tabel
-- filtert zelf op de organisatie: als security definer slaat de functie RLS
-- over.
--
-- Veilig om opnieuw te draaien: create or replace.
-- ============================================================

begin;

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
  v_methods jsonb;
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
         ) order by b.name, b.id), '[]'::jsonb),
         -- Per rekening hoe het saldo er komt: de btw-betalingen hieronder
         -- kijken daarmee of een betaling er al in zit.
         coalesce(jsonb_object_agg(b.id::text, coalesce(b.method, 'onbekend')), '{}'::jsonb)
    into v_bank, v_methods
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
  -- saldo en mag de cashflow hem niet nog eens aftrekken. Maar alleen als hij
  -- echt in het saldo hierboven zit (in_balance):
  --   - rekening met afschrift: alleen een bankregel. Een handmatige mutatie
  --     staat er pas in als de bank hem levert, als samengevoegde bankregel;
  --     daarom tellen samengevoegde regels nu ook mee;
  --   - rekening uit de boekhouding: een bankregel, of een geboekte mutatie;
  --   - rekening zonder bekend saldo, of inactief: ja. Dat geld telt in het
  --     saldo niet mee, dus de betaling ook niet nog eens van het saldo af.
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', t.booking_date,
           'cents', -t.amount_cents,
           'in_balance', case v_methods ->> t.bank_account_id::text
                           when 'statement' then not t.is_manual
                           when 'ledger' then not t.is_manual or t.status = 'booked'
                           else true
                         end
         ) order by t.booking_date, t.id), '[]'::jsonb)
    into v_tax
    from public.bank_transactions t
   where t.organization_id = p_organization_id
     and t.amount_cents < 0
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
