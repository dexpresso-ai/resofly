-- ============================================================
-- ResoFly — Controle financiën en BV (4 november 2026), deel 3:
-- verkoopfacturen, offertes, betalingen en aanmaningen
--
-- Uit de controle van 4 november (CHANGELOG_FINANCIEN_BV_CONTROLE_2026-11-04.md).
--
--   1. Herinneringen en aanmaningen gingen naar klanten die al betaald hadden
--      (per bank, Mollie of via een creditnota): ze keken alleen naar de status.
--      Nu telt het openstaande saldo uit het grootboek mee, en een
--      geannuleerd aanmaningsvoorstel blokkeert een nieuwe aanmaning niet meer.
--   2. De openstaande-postenlijst toonde elke via Mollie betaalde factuur als
--      openstaand.
--   3. Een geboekte factuur op geannuleerd/ongeldig/afgeboekt zetten liet omzet
--      en btw in het grootboek staan (en in de aangifte). Nu kan dat alleen als
--      hij eerst met een creditnota is weggeboekt ("Crediteren").
--   4. Offerte → factuur: de btw-code viel weg (ICP/export/verlegd kwam als 0%
--      binnenland in rubriek 1e) en prijzen werden op centen afgerond (1000 ×
--      € 0,125 werd € 130 in plaats van € 125). Nu komen de regels uit de
--      bevroren offerte zelf.
--   5. Factuurtotalen: de database rondde de btw per regel af, de pdf, Mollie,
--      UBL en het grootboek per tarief. Nu overal per tarief, en de opgeslagen
--      totalen volgen altijd uit de regels (niet meer los te overschrijven).
--   6. Een factuur met een negatieve groep (korting zonder code, correctie)
--      liep vast bij het boeken en kwam stil niet in het grootboek.
--   7. Wie welke offerteversie accepteerde, was na acceptatie nog aan te passen.
--   8. Mollie: een chargeback liet de factuur op betaald staan en gaf het geld
--      nog eens vrij voor een terugbetaling; een Mollie-terugbetaling boekte het
--      geld nooit (1300 bleef negatief, 1102 te hoog). Nu boeken beide 1300/1102.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 3. Annuleren van een geboekte factuur alleen na creditering ──────────────

create or replace function public.invoice_open_receivable_checked(p_invoice_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.invoices where id = p_invoice_id;
  if v_org is null then
    return null;
  end if;
  if auth.role() <> 'service_role'
     and not (public.can_read_org(v_org) and public.can_read_module(v_org, 'finance')) then
    return null;
  end if;
  return public.invoice_open_receivable_cents(v_org, p_invoice_id);
end;
$$;

revoke all on function public.invoice_open_receivable_checked(uuid) from public, anon;
grant execute on function public.invoice_open_receivable_checked(uuid) to authenticated, service_role;

-- Bewust security invoker: current_user is 'authenticated' bij een wijziging
-- uit de app en de eigenaar bij een wijziging vanuit een serverfunctie.
create or replace function public.enforce_invoice_cancel_after_credit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_open bigint;
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;
  if new.status is distinct from old.status
     and new.status in ('cancelled', 'void', 'written_off')
     and old.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_checked(old.id);
    if coalesce(v_open, 0) > 0 then
      raise exception 'Deze factuur staat in het grootboek: omzet en btw zijn geboekt. Annuleren of afboeken gaat met een creditnota; kies "Crediteren" bij de factuur.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_invoice_cancel_after_credit() from public, anon, authenticated;

drop trigger if exists invoices_cancel_after_credit on public.invoices;
create trigger invoices_cancel_after_credit
  before update of status on public.invoices
  for each row execute function public.enforce_invoice_cancel_after_credit();

-- ── 5. Totalen per tarief, en altijd uit de regels ───────────────────────────

create or replace function public.invoice_calculated_totals(p_lines jsonb)
returns table(subtotal numeric, vat numeric, total numeric)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sub_cents numeric := 0;
  v_vat_cents numeric := 0;
  r record;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return query select 0::numeric, 0::numeric, 0::numeric;
    return;
  end if;

  -- GEWIJZIGD (20261104020000): btw per tarief afronden, net als de pdf,
  -- Mollie, de e-factuur, invoice_total_cents en het grootboek. Per regel
  -- afronden gaf bij 2 × € 1,02 tegen 21% € 2,46 in plaats van € 2,47.
  -- Een onleesbare waarde telt als 0 (zoals in create_quote_version_snapshot),
  -- zodat een oude regel geen enkele latere wijziging van de factuur blokkeert.
  for r in
    select case when coalesce(elem->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (elem->>'vat')::numeric else 0 end as rate,
           sum(round(
             (case when coalesce(elem->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (elem->>'quantity')::numeric else 0 end)
             * (case when coalesce(elem->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (elem->>'unit_price')::numeric else 0 end)
             * 100)) as base_cents
    from jsonb_array_elements(p_lines) as t(elem)
    group by 1
  loop
    v_sub_cents := v_sub_cents + r.base_cents;
    v_vat_cents := v_vat_cents + round(r.base_cents * r.rate / 100);
  end loop;

  return query select round(v_sub_cents / 100, 2), round(v_vat_cents / 100, 2), round((v_sub_cents + v_vat_cents) / 100, 2);
end;
$$;

-- De opgeslagen totalen volgen altijd uit de regels: de trigger loopt nu bij
-- elke wijziging, zodat een los gezet total_amount (dat de API, webhooks en
-- bankmatching gebruiken) wordt teruggezet.
drop trigger if exists invoices_normalize_totals on public.invoices;
create trigger invoices_normalize_totals
  before insert or update on public.invoices
  for each row execute function public.normalize_invoice_totals();

-- ── 1. Aanmaningen: een geannuleerd voorstel blokkeert niet meer ─────────────

drop index if exists public.uidx_invoice_dunning_notice_per_invoice;
create unique index if not exists uidx_invoice_dunning_notice_per_invoice
  on public.invoice_dunning_notices (invoice_id)
  where status <> 'cancelled';

-- ── 8. Mollie: chargebacks en terugbetalingen in het grootboek ───────────────

alter table public.invoice_refunds
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;
alter table public.invoice_chargebacks
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;

-- ── 1. Herinneringen, aanmaningen en 'te laat' kijken naar het openstaande saldo ─
CREATE OR REPLACE FUNCTION public.find_due_invoice_reminders(p_now timestamp with time zone DEFAULT now(), p_limit integer DEFAULT 200)
 RETURNS TABLE(organization_id uuid, invoice_id uuid, next_level smallint, days_overdue integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag herinneringskandidaten ophalen.' using errcode = '42501';
  end if;

  return query
  select
    i.organization_id,
    i.id as invoice_id,
    (i.reminder_level + 1)::smallint as next_level,
    (p_now::date - i.due_date)::integer as days_overdue
  from public.invoices i
  join public.invoice_reminder_settings s on s.organization_id = i.organization_id
  where s.auto_reminders_enabled = true
    and i.status = 'overdue'
    and i.reminders_paused = false
    and i.reminder_level < 3
    and i.due_date is not null
    -- TOEGEVOEGD (20261104020000): niet voor een factuur die (per bank, Mollie
    -- of creditnota) al is voldaan maar nog op achterstallig staat.
    and (i.journal_entry_id is null or public.invoice_open_receivable_cents(i.organization_id, i.id) > 0)
    and (p_now::date - i.due_date) >= case i.reminder_level
          when 0 then s.level1_offset_days
          when 1 then s.level2_offset_days
          when 2 then s.level3_offset_days
          else 2147483647
        end
  order by i.due_date asc
  limit greatest(1, p_limit);
end;
$function$;
revoke all on function public.find_due_invoice_reminders(timestamp with time zone, integer) from public, anon, authenticated;
grant execute on function public.find_due_invoice_reminders(timestamp with time zone, integer) to service_role;
CREATE OR REPLACE FUNCTION public.find_due_dunning_candidates(p_now timestamp with time zone DEFAULT now(), p_limit integer DEFAULT 200)
 RETURNS TABLE(organization_id uuid, invoice_id uuid, client_id uuid, days_overdue integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag aanmaningskandidaten ophalen.' using errcode = '42501';
  end if;

  return query
  select
    i.organization_id,
    i.id as invoice_id,
    i.client_id,
    (p_now::date - i.due_date)::integer as days_overdue
  from public.invoices i
  join public.invoice_reminder_settings s on s.organization_id = i.organization_id
  where s.dunning_enabled = true
    and i.status = 'overdue'
    and i.reminders_paused = false
    and i.client_id is not null
    and i.due_date is not null
    and (p_now::date - i.due_date) >= s.dunning_offset_days
    -- TOEGEVOEGD (20261104020000): alleen als er nog echt iets openstaat.
    and (i.journal_entry_id is null or public.invoice_open_receivable_cents(i.organization_id, i.id) > 0)
    -- GEWIJZIGD (20261104020000): een geannuleerd voorstel telt niet mee.
    and not exists (
      select 1 from public.invoice_dunning_notices n where n.invoice_id = i.id and n.status <> 'cancelled'
    )
  order by i.due_date asc
  limit greatest(1, p_limit);
end;
$function$;
revoke all on function public.find_due_dunning_candidates(timestamp with time zone, integer) from public, anon, authenticated;
grant execute on function public.find_due_dunning_candidates(timestamp with time zone, integer) to service_role;
CREATE OR REPLACE FUNCTION public.mark_invoices_overdue(p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
  v_rec record;
begin
  if auth.role() <> 'service_role'
     and (p_organization_id is null or not public.can_write_org(p_organization_id)) then
    raise exception 'Geen rechten om facturen als te laat te markeren.' using errcode = '42501';
  end if;

  for v_rec in
    update public.invoices i
       set status = 'overdue',
           updated_at = now()
     where i.status = 'sent'
       and i.due_date is not null
       and i.due_date < current_date
       and (p_organization_id is null or i.organization_id = p_organization_id)
       -- TOEGEVOEGD (20261104020000): al voldaan (bank, Mollie, creditnota) is niet te laat.
       and (i.journal_entry_id is null or public.invoice_open_receivable_cents(i.organization_id, i.id) > 0)
    returning i.id, i.organization_id, i.number, i.due_date
  loop
    v_count := v_count + 1;
    perform public.insert_invoice_workflow_event(
      v_rec.organization_id,
      v_rec.id,
      'marked_overdue',
      'Factuur te laat',
      'Factuur ' || coalesce(v_rec.number, '') || ' is na de vervaldatum (' || to_char(v_rec.due_date, 'DD-MM-YYYY') || ') automatisch op ''te laat'' gezet.',
      jsonb_build_object('due_date', v_rec.due_date),
      null
    );
  end loop;

  return v_count;
end;
$function$;
revoke all on function public.mark_invoices_overdue(uuid) from public, anon, authenticated;
grant execute on function public.mark_invoices_overdue(uuid) to service_role;

-- ── 2. Openstaande posten: Mollie telt mee ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.report_open_items(p_organization_id uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- TOEGEVOEGD (20261104020000): Mollie-betalingen, -terugbetalingen en
  -- -chargebacks boeken met de factuur zelf als bron. Zonder deze tak stond
  -- elke via Mollie betaalde factuur voorgoed als openstaand in de lijst.
  inv_psp as (
    select i.id as invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.invoices i on i.organization_id = p_organization_id and i.id = al.source_id
    where al.source_type = 'payment'
    group by 1
  ),
  inv_rows as (
    select
      i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) + coalesce(pp.amt, 0) as paid_cents,
      coalesce(cr.amt, 0) as credited_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) - coalesce(pp.amt, 0) - coalesce(cr.amt, 0) as open_cents
    from public.invoices i
    left join inv_booked b on b.invoice_id = i.id
    left join inv_paid p on p.invoice_id = i.id
    left join inv_psp pp on pp.invoice_id = i.id
    left join inv_credited cr on cr.invoice_id = i.id
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0 or coalesce(pp.amt, 0) <> 0 or coalesce(cr.amt, 0) <> 0)
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
$function$;
revoke all on function public.report_open_items(uuid, date) from public, anon;
grant execute on function public.report_open_items(uuid, date) to authenticated, service_role;

-- ── 6. Verkoopfactuur boeken: negatieve groepen aan de debetzijde ───────────
CREATE OR REPLACE FUNCTION public.post_sales_invoice_to_ledger(p_organization_id uuid, p_invoice_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv public.invoices;
  v_start date;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_output_vat bigint := 0;
  v_receivable bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
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
  -- Statusguard: alleen een uitgegeven factuur boekt omzet. Concept/geannuleerd niet.
  if v_inv.status in ('draft', 'cancelled') then
    raise exception 'Een % factuur kan niet naar het grootboek worden geboekt.', v_inv.status using errcode = '23514';
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

  -- Omzet per (btw-code, tarief); btw per groep afgerond. Het TARIEF komt van
  -- de factuurregel (dat is wat gefactureerd is); de CODE bepaalt de rubriek
  -- (via vat_codes.sales_box in de aangifte) en de omzetrekening: buitenland/
  -- verlegd (3a/3b/3c of verlegd-verkoop) → 8030, anders op tarief.
  for r in
    select
      nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
      (vc.id is not null) as has_code,
      vc.kind, vc.sales_box,
      coalesce((line->>'vat')::numeric, 0) as rate,
      sum(round(coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unit_price')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(v_inv.lines) as line
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id
     and vc.code = nullif(btrim(coalesce(line->>'vat_code', '')), '')
    group by 1, 2, 3, 4, 5
  loop
    declare
      v_vat bigint := case when v_kor then 0 else round(r.base_cents * r.rate / 100.0) end;
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      -- GEWIJZIGD (20261104020000): een negatieve groep (korting, correctie)
      -- komt aan de debetzijde; een negatieve credit bestaat niet en liet het
      -- boeken stil mislukken. Grondslag en btw houden hun teken.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', greatest(-r.base_cents, 0), 'credit_cents', greatest(r.base_cents, 0),
        'vat_code', r.vat_code,
        'vat_rate', r.rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', greatest(-v_output_vat, 0), 'credit_cents', greatest(v_output_vat, 0),
      'client_id', v_inv.client_id
    ));
  end if;

  if v_receivable <> 0 then
    v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren',
      'debit_cents', greatest(v_receivable, 0), 'credit_cents', greatest(-v_receivable, 0),
      'client_id', v_inv.client_id
    )) || v_lines;
  end if;

  -- Nagekomen factuur in een al ingediende periode: boek op de eerstvolgende
  -- open datum (documentdatum blijft leidend op de factuur zelf). De btw komt
  -- dan in de eerstvolgende aangifte (kleine correctie) of via een suppletie.
  v_book_date := public.first_open_booking_date(p_organization_id, v_inv.date);
  v_desc := 'Verkoopfactuur ' || coalesce(v_inv.number, '');
  if v_book_date <> v_inv.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_inv.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'sales_invoice', v_inv.id, v_lines, p_created_by
  );

  update public.invoices set journal_entry_id = v_entry.id where id = v_inv.id;
  return v_entry;
end;
$function$;
revoke all on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) to authenticated, service_role;

-- ── 4. Offerte → factuur: regels uit de bevroren offerte ───────────────────
CREATE OR REPLACE FUNCTION public.convert_accepted_quote_to_invoice(p_quote_id uuid, p_organization_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_quote_version public.quote_versions;
  v_existing public.invoices;
  v_invoice public.invoices;
  v_user_id uuid := auth.uid();
  v_invoice_number text;
  v_due_date date := current_date + 14;
  v_lines jsonb;
  v_notes text;
  v_quote_date date;
  v_valid_until date;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('quote_to_invoice'));

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden.' using errcode = '02000';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Alleen geaccepteerde offertes kunnen worden omgezet naar een factuur.' using errcode = '23514';
  end if;

  select * into v_existing
  from public.invoices
  where organization_id = p_organization_id
    and quote_id = p_quote_id
  order by created_at asc
  limit 1
  for update;

  if found then
    return v_existing;
  end if;

  select * into v_quote_version
  from public.quote_versions qv
  where qv.organization_id = p_organization_id
    and qv.quote_id = p_quote_id
    and qv.id = coalesce(v_quote.accepted_sent_version_id, v_quote.accepted_version_id, v_quote.sent_version_id)
  limit 1;

  if not found then
    select * into v_quote_version
    from public.quote_versions qv
    where qv.organization_id = p_organization_id
      and qv.quote_id = p_quote_id
      and qv.snapshot_reason in ('client_accepted','sent_to_client')
    order by case qv.snapshot_reason when 'client_accepted' then 0 else 1 end, qv.created_at desc
    limit 1;
  end if;

  if not found or v_quote_version.id is null then
    raise exception 'Deze offerte heeft geen geaccepteerde/verzonden versie-snapshot. Maak of herstel eerst een offerteversie voordat je factureert.' using errcode = '23514';
  end if;

  -- GEWIJZIGD (20261104020000): de regels komen uit de bevroren offerte zelf
  -- (snapshot_data), mét btw-code en ongeronde prijs. quote_version_items kent
  -- geen btw-code en rondt aantal en prijs af op twee decimalen; daardoor kwam
  -- een ICP-, export- of verlegde regel als 0% binnenland op de factuur en werd
  -- 1000 × € 0,125 gefactureerd als € 130.
  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', coalesce(nullif(l->>'id', ''), gen_random_uuid()::text),
      'description', coalesce(l->>'description', ''),
      'quantity', case when coalesce(l->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'quantity')::numeric else 0 end,
      'unit_price', case when coalesce(l->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'unit_price')::numeric else 0 end,
      'vat', case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end,
      'vat_code', nullif(btrim(coalesce(l->>'vat_code', '')), '')
    )) order by t.ord
  ) into v_lines
  from jsonb_array_elements(
    case when jsonb_typeof(v_quote_version.snapshot_data #> '{quote,lines}') = 'array'
      then v_quote_version.snapshot_data #> '{quote,lines}' else '[]'::jsonb end
  ) with ordinality as t(l, ord);

  if v_lines is null then
    select jsonb_agg(
      jsonb_build_object(
        'id', coalesce(qvi.source_line_id, qvi.id::text),
        'description', qvi.description,
        'quantity', qvi.quantity,
        'unit_price', qvi.unit_price,
        'vat', qvi.vat_percentage
      ) order by qvi.line_index
    ) into v_lines
    from public.quote_version_items qvi
    where qvi.quote_version_id = v_quote_version.id
      and qvi.organization_id = p_organization_id
      and qvi.quote_id = p_quote_id;
  end if;

  v_lines := coalesce(v_lines, v_quote_version.snapshot_data #> '{quote,lines}');
  v_notes := v_quote_version.notes;
  v_quote_date := v_quote_version.quote_date;
  v_valid_until := v_quote_version.valid_until;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'De geaccepteerde offerteversie bevat geen geldige regels.' using errcode = '23514';
  end if;

  v_invoice_number := public.allocate_next_invoice_number(p_organization_id, current_date);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, quote_id, source_quote_version_id,
    number, date, due_date, lines, status, notes
  ) values (
    p_organization_id, v_user_id, v_quote_version.client_id, v_quote_version.project_id, v_quote.id, v_quote_version.id,
    v_invoice_number, current_date, v_due_date, v_lines, 'draft', v_notes
  ) returning * into v_invoice;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_invoice.id,
    'created_from_quote',
    'Factuur aangemaakt uit offerte',
    'Factuur ' || v_invoice.number || ' is server-side aangemaakt uit de geaccepteerde offerteversie van ' || v_quote.number || '.',
    jsonb_build_object('quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id, 'quote_date', v_quote_date, 'quote_valid_until', v_valid_until),
    v_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id,
    v_user_id,
    'invoice_created_from_quote',
    'invoice',
    v_invoice.id,
    v_invoice.number,
    jsonb_build_object('title', 'Factuur aangemaakt uit offerte', 'quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id)
  );

  return v_invoice;
end;
$function$;
revoke all on function public.convert_accepted_quote_to_invoice(uuid, uuid) from public, anon;
grant execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) to authenticated, service_role;

-- ── 7. Acceptatiebewijs van een offerte alleen via de server ─────────────────

create or replace function public.enforce_quote_acceptance_fields_server_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.accepted_sent_version_id is not null or new.client_decision_by_contact_id is not null then
      raise exception 'Welke offerteversie de klant accepteerde en wie besliste, legt alleen de server vast.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.accepted_sent_version_id is distinct from old.accepted_sent_version_id
     or new.client_decision_by_contact_id is distinct from old.client_decision_by_contact_id then
    raise exception 'Welke offerteversie de klant accepteerde en wie besliste, legt alleen de server vast.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_quote_acceptance_fields_server_only() from public, anon, authenticated;

drop trigger if exists quotes_acceptance_fields_server_only on public.quotes;
create trigger quotes_acceptance_fields_server_only
  before insert or update of accepted_sent_version_id, client_decision_by_contact_id on public.quotes
  for each row execute function public.enforce_quote_acceptance_fields_server_only();

-- ── 8. Mollie-terugbetaling en chargeback in het grootboek ──────────────────
CREATE OR REPLACE FUNCTION public.recompute_invoice_refund_state(p_invoice_id uuid, p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_refunded_cents bigint;
  v_paid_cents bigint;
  v_rf record;
  v_lines jsonb;
  v_entry public.journal_entries;
begin
  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then return; end if;

  -- Totaal daadwerkelijk terugbetaald (alleen settled refunds).
  select coalesce(sum(amount_cents), 0) into v_refunded_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'refunded';

  -- Per Mollie-betaalrecord het terugbetaalde deel bijwerken.
  update public.invoice_payment_records p
     set amount_refunded_cents = coalesce((
           select sum(r.amount_cents) from public.invoice_refunds r
           where r.payment_record_id = p.id and r.status = 'refunded'
         ), 0),
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id;

  -- Betaald bedrag: voorkeur voor de som van betaalde/terugbetaalde Mollie-records,
  -- val terug op het factuurtotaal (offline betaald zonder Mollie-record).
  select coalesce(
           nullif(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  update public.invoices
     set refunded_amount = round(v_refunded_cents::numeric / 100, 2),
         refunded_at = case when v_refunded_cents > 0 then coalesce(refunded_at, now()) else null end,
         status = case
                    when v_refunded_cents > 0 and v_refunded_cents >= v_paid_cents then 'refunded'
                    when status = 'refunded' and v_refunded_cents < v_paid_cents then 'paid'
                    else status
                  end,
         locked_at = case when v_refunded_cents > 0 then coalesce(locked_at, now()) else locked_at end,
         locked_reason = case when v_refunded_cents > 0 then coalesce(locked_reason, 'refunded') else locked_reason end,
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  -- Een volledig terugbetaald Mollie-record naar 'refunded' tillen.
  update public.invoice_payment_records p
     set status = 'refunded',
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status = 'paid'
     and p.amount_refunded_cents >= p.amount_cents
     and p.amount_cents > 0;

  -- TOEGEVOEGD (20261104020000): het geld van een Mollie-terugbetaling gaat van
  -- het Mollie-saldo (1102) af, en de vordering die de creditnota wegboekte komt
  -- terug: debet 1300, credit 1102. Zonder deze boeking bleef 1300 negatief en
  -- 1102 te hoog. Alleen als de Mollie-betaling zelf geboekt is; een handmatige
  -- terugbetaling loopt via de bank en boek je daar.
  for v_rf in
    select rf.id, rf.amount_cents, rf.refunded_at
    from public.invoice_refunds rf
    join public.invoice_payment_records pr
      on pr.id = rf.payment_record_id and pr.organization_id = rf.organization_id and pr.journal_entry_id is not null
    where rf.invoice_id = p_invoice_id and rf.organization_id = p_organization_id
      and rf.kind = 'mollie' and rf.status = 'refunded'
      and rf.journal_entry_id is null and rf.amount_cents > 0
    order by rf.created_at
  loop
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', 'Terugbetaling via Mollie', 'debit_cents', v_rf.amount_cents, 'credit_cents', 0,
        'client_id', v_invoice.client_id),
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
        'description', 'Terugbetaling via Mollie (van het Mollie-saldo)', 'debit_cents', 0, 'credit_cents', v_rf.amount_cents)
    );
    v_entry := public.post_journal_entry(
      p_organization_id,
      public.first_open_booking_date_for(p_organization_id, coalesce(v_rf.refunded_at::date, current_date), false),
      'Terugbetaling factuur ' || coalesce(v_invoice.number, ''),
      'payment', p_invoice_id, v_lines, null
    );
    update public.invoice_refunds set journal_entry_id = v_entry.id where id = v_rf.id;
  end loop;
end;
$function$;
revoke all on function public.recompute_invoice_refund_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recompute_invoice_refund_state(uuid, uuid) to service_role;
CREATE OR REPLACE FUNCTION public.recompute_invoice_chargeback_state(p_invoice_id uuid, p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_charged_back_cents bigint;
  v_invoice public.invoices;
  v_cb record;
  v_lines jsonb;
  v_entry public.journal_entries;
begin
  select * into v_invoice from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then return; end if;

  -- Alleen actieve (niet-teruggedraaide) chargebacks tellen mee.
  select coalesce(sum(amount_cents), 0) into v_charged_back_cents
  from public.invoice_chargebacks
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'charged_back';

  -- Betaalrecord met een actieve chargeback → status 'charged_back'.
  update public.invoice_payment_records p
     set status = 'charged_back', updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status in ('paid','refunded')
     and exists (
       select 1 from public.invoice_chargebacks c
       where c.payment_record_id = p.id and c.status = 'charged_back'
     );

  -- Teruggedraaide chargeback en geen andere actieve chargeback → terug naar 'paid'.
  update public.invoice_payment_records p
     set status = 'paid', updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status = 'charged_back'
     and not exists (
       select 1 from public.invoice_chargebacks c
       where c.payment_record_id = p.id and c.status = 'charged_back'
     );

  update public.invoices
     set charged_back_amount = round(v_charged_back_cents::numeric / 100, 2),
         charged_back_at = case when v_charged_back_cents > 0 then coalesce(charged_back_at, now()) else null end,
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  -- TOEGEVOEGD (20261104020000): bij een chargeback gaat het geld van het
  -- Mollie-saldo terug naar de klant en staat de factuur weer open: debet 1300,
  -- credit 1102. Wordt de chargeback teruggedraaid, dan deze boeking ook.
  for v_cb in
    select cb.id, cb.amount_cents
    from public.invoice_chargebacks cb
    join public.invoice_payment_records pr
      on pr.id = cb.payment_record_id and pr.organization_id = cb.organization_id and pr.journal_entry_id is not null
    where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
      and cb.status = 'charged_back' and cb.journal_entry_id is null and cb.amount_cents > 0
    order by cb.created_at
  loop
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', 'Chargeback via Mollie: factuur weer open', 'debit_cents', v_cb.amount_cents, 'credit_cents', 0,
        'client_id', v_invoice.client_id),
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
        'description', 'Chargeback via Mollie (van het Mollie-saldo)', 'debit_cents', 0, 'credit_cents', v_cb.amount_cents)
    );
    v_entry := public.post_journal_entry(
      p_organization_id,
      public.first_open_booking_date_for(p_organization_id, current_date, false),
      'Chargeback factuur ' || coalesce(v_invoice.number, ''),
      'payment', p_invoice_id, v_lines, null
    );
    update public.invoice_chargebacks set journal_entry_id = v_entry.id where id = v_cb.id;
  end loop;

  for v_cb in
    select cb.id, cb.journal_entry_id
    from public.invoice_chargebacks cb
    join public.journal_entries je on je.id = cb.journal_entry_id and je.reversed_by_entry_id is null
    where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
      and cb.status <> 'charged_back'
  loop
    perform public.reverse_journal_entry(v_cb.journal_entry_id, null, null);
  end loop;

  -- De factuur volgt: open bij een actieve chargeback, weer betaald als die
  -- is teruggedraaid en de betaling weer op betaald staat.
  if v_charged_back_cents > 0 then
    update public.invoices
       set status = case when due_date is not null and due_date < current_date then 'overdue' else 'sent' end,
           paid_at = null,
           updated_at = now()
     where id = p_invoice_id and organization_id = p_organization_id and status = 'paid';
  elsif v_invoice.status in ('sent', 'overdue')
        and v_invoice.charged_back_at is not null
        and exists (
          select 1 from public.invoice_payment_records p
          where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id and p.status = 'paid'
        ) then
    update public.invoices
       set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now()
     where id = p_invoice_id and organization_id = p_organization_id;
  end if;
end;
$function$;
revoke all on function public.recompute_invoice_chargeback_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recompute_invoice_chargeback_state(uuid, uuid) to service_role;
CREATE OR REPLACE FUNCTION public.begin_invoice_refund(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_amount_cents integer, p_reason text DEFAULT NULL::text, p_kind text DEFAULT 'manual'::text, p_payment_record_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_refunds
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_paid_cents bigint;
  v_already_cents bigint;
  v_kind text := case when p_kind in ('manual','mollie') then p_kind else 'manual' end;
  v_refund public.invoice_refunds;
  v_amount_eur text;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'Het terugbetaalbedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

  if v_invoice.status not in ('paid','refunded') then
    raise exception 'Alleen betaalde facturen kunnen worden terugbetaald.' using errcode = '23514';
  end if;

  -- Idempotency: dezelfde sleutel mag nooit twee terugbetalingen maken.
  if p_idempotency_key is not null then
    select * into v_refund from public.invoice_refunds
     where organization_id = p_organization_id
       and invoice_id = p_invoice_id
       and idempotency_key = p_idempotency_key;
    if found then return v_refund; end if;
  end if;

  -- Betaald bedrag bepalen (zelfde logica als recompute).
  select coalesce(
           nullif(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  -- TOEGEVOEGD (20261104020000): geld dat via een chargeback al terug is bij
  -- de klant, kan niet nog eens worden terugbetaald.
  v_paid_cents := v_paid_cents - coalesce((
    select sum(cb.amount_cents) from public.invoice_chargebacks cb
    where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
      and cb.status = 'charged_back'
  ), 0);

  -- Reeds terugbetaald of in behandeling (voorkomt dubbel/over-terugbetalen).
  select coalesce(sum(amount_cents), 0) into v_already_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status in ('queued','pending','processing','refunded');

  if p_amount_cents::bigint + v_already_cents > v_paid_cents then
    raise exception 'Terugbetaalbedrag (% cent) overschrijdt het resterende betaalde bedrag (% cent).',
      p_amount_cents, greatest(v_paid_cents - v_already_cents, 0)
      using errcode = '23514';
  end if;

  insert into public.invoice_refunds(
    organization_id, invoice_id, payment_record_id, kind, provider, status,
    amount_cents, currency, reason, idempotency_key, initiated_by, metadata, refunded_at
  ) values (
    p_organization_id, p_invoice_id, p_payment_record_id, v_kind, 'mollie',
    case when v_kind = 'manual' then 'refunded' else 'queued' end,
    p_amount_cents, coalesce(nullif(v_invoice.currency, ''), 'EUR'),
    nullif(btrim(coalesce(p_reason, '')), ''), p_idempotency_key, p_actor_user_id,
    coalesce(p_metadata, '{}'::jsonb),
    case when v_kind = 'manual' then now() else null end
  ) returning * into v_refund;

  -- Voor een handmatige terugbetaling is het geld direct verwerkt.
  if v_kind = 'manual' then
    perform public.recompute_invoice_refund_state(p_invoice_id, p_organization_id);

    v_amount_eur := to_char(p_amount_cents::numeric / 100, 'FM999999990.00');
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'payment_refunded',
      'Terugbetaling geregistreerd',
      'Handmatige terugbetaling van ' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur,
      jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind),
      p_actor_user_id
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, p_actor_user_id, 'invoice_refunded', 'invoice', p_invoice_id, v_invoice.number,
            jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind));
  end if;

  return v_refund;
end;
$function$;
revoke all on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) to service_role;

-- ── Handelsrente 2026 geverifieerd ───────────────────────────────────────────
-- De twee waarden met "VERIFIEER" zijn op 4 november 2026 nagelopen
-- (Rijksoverheid, KCBR-informatieblad januari en juli 2026): 10,15% per
-- 1-1-2026 en 10,40% per 1-7-2026. Alleen de bronvermelding verandert.
update public.statutory_interest_rates
   set source_note = 'Handelsrente 10,15% — geverifieerd 2026-11-04 (Rijksoverheid, KCBR-informatieblad januari 2026)'
 where kind = 'commercial' and valid_from = date '2026-01-01' and rate_basis_points = 1015;
update public.statutory_interest_rates
   set source_note = 'Handelsrente 10,40% — geverifieerd 2026-11-04 (Rijksoverheid, KCBR-informatieblad juli 2026)'
 where kind = 'commercial' and valid_from = date '2026-07-01' and rate_basis_points = 1040;

commit;
