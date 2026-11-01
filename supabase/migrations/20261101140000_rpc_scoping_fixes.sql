-- ============================================================
-- ResoFly — Gaten uit de review van de aanroepbare databasefuncties
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt U).
-- Een review van alle 123 security-definer-functies die elke ingelogde
-- gebruiker via /rest/v1/rpc kan aanroepen. Daarin geldt geen RLS; elke functie
-- moet zelf controleren. Wat er ontbrak:
--
--   1. post_journal_entry nam de vrijgestelde boeksoorten (jaarafsluiting, Vpb,
--      dga-rente) van elke aanroeper aan. Met p_source_type => 'dga_interest'
--      boekte iedereen met schrijfrecht op Financiën in een afgesloten btw-
--      periode of boekjaar. Nu alleen met de vlag die close_fiscal_year,
--      save_corporate_tax_return en book_dga_interest vlak voor hun boeking
--      zetten, of als service-role.
--   2. journal_lines: klant, leverancier en project in een boekingsregel werden
--      niet tegen de organisatie gecontroleerd (alleen de grootboekrekening). Nu
--      een integriteitstrigger op de tabel, voor elke weg.
--   3. compute_icp_declaration haalde de klant op zonder organisatiefilter.
--   4. book_bank_transaction sloeg met beide factuur-ids het tweede id
--      ongecontroleerd op.
--   5. declare_dividend controleerde de winstbestemming alleen bij een
--      slotdividend; declare_dividend en reverse_result_appropriation zochten
--      geboekte dividenden zonder organisatiefilter. Zo kon een lid van
--      organisatie A het terugdraaien en het slotdividend van B blokkeren.
--   6. Financiën zonder module: convert_accepted_quote_to_invoice en
--      appropriate_result vragen nu schrijfrecht op Financiën,
--      opening_balance_plug_account en preview_next_invoice_number leesrecht.
--   7. create_client_with_next_code vraagt schrijfrecht op Klanten.
--   8. chat_start_dm vraagt schrijfrecht op Teamchat, en dat de ander Teamchat
--      mag zien (zoals bij een groep of kanaal).
--
-- De functies zijn verder ongewijzigd (overgenomen uit staging).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── Integriteit van boekingsregels ─────────────────────────────────────────

create or replace function public.enforce_journal_lines_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_same_org_reference('public.clients'::regclass, new.client_id, new.organization_id, 'journal_lines.client_id');
  perform public.assert_same_org_reference('public.suppliers'::regclass, new.supplier_id, new.organization_id, 'journal_lines.supplier_id');
  perform public.assert_same_org_reference('public.projects'::regclass, new.project_id, new.organization_id, 'journal_lines.project_id');
  perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.account_id, new.organization_id, 'journal_lines.account_id');
  return new;
end;
$$;

revoke all on function public.enforce_journal_lines_org_integrity() from public, anon, authenticated;

drop trigger if exists journal_lines_org_integrity on public.journal_lines;
create trigger journal_lines_org_integrity
  before insert or update of organization_id, client_id, supplier_id, project_id, account_id on public.journal_lines
  for each row execute function public.enforce_journal_lines_org_integrity();

-- ── De functies ────────────────────────────────────────────────────────────

create or replace function public.post_journal_entry(p_organization_id uuid, p_date date, p_description text, p_source_type text, p_source_id uuid, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_alien_code text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- De vrijgestelde soorten (jaarafsluiting, Vpb, dga-rente) mogen in een
  -- afgesloten periode boeken. Alleen de functies die ze maken, zetten de vlag
  -- resofly.trusted_journal_source (voor de rest van de transactie); een
  -- rechtstreekse aanroep met p_source_type => 'dga_interest' boekte anders
  -- in elke gesloten btw-periode of elk afgesloten boekjaar.
  if coalesce(p_source_type, 'manual') in ('year_close', 'corporate_tax', 'dga_interest')
     and auth.role() <> 'service_role'
     and coalesce(current_setting('resofly.trusted_journal_source', true), '') <> p_source_type then
    raise exception 'Dit soort boeking maakt alleen de jaarafsluiting, de Vpb-aangifte of de dga-renteboeking zelf.'
      using errcode = '42501';
  end if;

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand/kwartaal/jaar).
  -- Uitzondering: het jaarafsluit-boekstuk ('year_close') zelf, dat op de laatste dag
  -- van het boekjaar valt en dus vaak binnen een reeds gesloten Q4/december-slot.
  -- GEWIJZIGD (20260807050000): 'corporate_tax' krijgt dezelfde vrijstelling.
  -- De Vpb-reservering valt per definitie op de balansdatum, en die ligt altijd
  -- in de laatste btw-periode van het boekjaar. Zonder deze uitzondering zou de
  -- reservering nooit geboekt kunnen worden zodra die aangifte is gefinaliseerd —
  -- een slot dat nooit meer opengaat. De post raakt alleen 9900 en 1540 en komt
  -- in geen enkele btw-rubriek voor, dus er valt niets te beschermen.
  -- GEWIJZIGD (20260807090000): 'dga_interest' erbij. De renteboeking valt per
  -- definitie op 31 december, en die dag ligt altijd in de laatste btw-periode
  -- van het jaar — een slot dat nooit meer opengaat. Zonder deze uitzondering
  -- kon de rente nooit geboekt worden zodra die aangifte definitief was.
  -- 'payroll' juist NIET: een loonjournaalpost in een afgesloten maand hoort
  -- wél te stuiten, want die raakt de btw-aangifte wel degelijk.
  if coalesce(p_source_type, 'manual') not in ('year_close', 'corporate_tax', 'dga_interest') and exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_start is not null and cp.period_end is not null
      and p_date between cp.period_start and cp.period_end
  ) then
    raise exception 'De aangifteperiode rond % is afgesloten; kies een boekdatum in de eerstvolgende open periode.', p_date
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

  -- Org-integriteit (FIX 6): elke regel moet op een grootboekrekening van
  -- déze organisatie boeken. Een account_id van een andere org zou de balans
  -- vervuilen met andermans rekening (cross-tenant lek in de rapportages).
  select la.code into v_alien_code
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.entry_id = v_entry.id
    and la.organization_id <> p_organization_id
  limit 1;
  if v_alien_code is not null then
    raise exception 'Grootboekrekening % hoort niet bij deze organisatie.', v_alien_code
      using errcode = '42501';
  end if;

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

create or replace function public.book_dga_interest(p_organization_id uuid, p_year integer, p_created_by uuid DEFAULT auth.uid())
 RETURNS dga_interest_postings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_calc jsonb;
  v_interest bigint;
  v_date date := make_date(p_year, 12, 31);
  v_rc uuid;
  v_income uuid;
  v_expense uuid;
  v_entry public.journal_entries;
  v_row public.dga_interest_postings;
  v_closed record;
  v_fy_start smallint;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':dga'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'De rekening-courant DGA hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  -- De berekening loopt over het kalenderjaar. Bij een gebroken boekjaar zou de
  -- last daardoor in het verkeerde boekjaar vallen en doorwerken in de
  -- Vpb-grondslag. Liever weigeren met een reden dan stilzwijgend verkeerd
  -- toerekenen.
  select coalesce(cs.fiscal_year_start_month, 1) into v_fy_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if coalesce(v_fy_start, 1) <> 1 then
    raise exception 'Deze administratie heeft een gebroken boekjaar (start in maand %). De renteberekening loopt over het kalenderjaar en zou de last in het verkeerde boekjaar zetten; boek de rente voorlopig handmatig.', v_fy_start
      using errcode = '0A000';
  end if;

  if exists (
    select 1 from public.dga_interest_postings p
    where p.organization_id = p_organization_id and p.year = p_year and p.status = 'posted'
  ) then
    raise exception 'De rente over % is al geboekt.', p_year using errcode = '23505';
  end if;

  v_calc := public.compute_dga_interest(p_organization_id, p_year);
  v_interest := coalesce((v_calc->>'interestCents')::bigint, 0);

  if (v_calc->>'hasDaysWithoutRate')::boolean then
    raise exception 'Voor een deel van % is nog geen rentepercentage vastgelegd. Leg eerst vast wat je met je adviseur hebt afgesproken.', p_year
      using errcode = '23514';
  end if;
  if v_interest = 0 then
    raise exception 'Over % valt geen rente te boeken: het saldo van de rekening-courant was nul.', p_year
      using errcode = '23514';
  end if;

  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het boekjaar rond % is afgesloten. Heropen het om de rente alsnog te boeken.',
      to_char(v_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_rc := public.bookkeeping_account_id(p_organization_id, '1400');

  if v_interest > 0 then
    v_income := public.bookkeeping_account_id(p_organization_id, '9000');
    perform set_config('resofly.trusted_journal_source', 'dga_interest', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_date, 'Rente rekening-courant DGA ' || p_year,
      'dga_interest', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_rc, 'description', 'Rente bijgeschreven ' || p_year,
          'debit_cents', v_interest, 'credit_cents', 0),
        jsonb_build_object('account_id', v_income, 'description', 'Rente rekening-courant DGA ' || p_year,
          'debit_cents', 0, 'credit_cents', v_interest)
      ), p_created_by);
  else
    v_expense := public.bookkeeping_account_id(p_organization_id, '9100');
    perform set_config('resofly.trusted_journal_source', 'dga_interest', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_date, 'Rente rekening-courant DGA ' || p_year,
      'dga_interest', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_expense, 'description', 'Rente rekening-courant DGA ' || p_year,
          'debit_cents', -v_interest, 'credit_cents', 0),
        jsonb_build_object('account_id', v_rc, 'description', 'Rente bijgeschreven ' || p_year,
          'debit_cents', 0, 'credit_cents', -v_interest)
      ), p_created_by);
  end if;

  insert into public.dga_interest_postings(
    organization_id, created_by, year, interest_cents, computation, journal_entry_id, status)
  values (p_organization_id, p_created_by, p_year, v_interest, v_calc, v_entry.id, 'posted')
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.close_fiscal_year(p_organization_id uuid, p_fiscal_year_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
    perform set_config('resofly.trusted_journal_source', 'year_close', true);
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

create or replace function public.save_corporate_tax_return(p_organization_id uuid, p_fiscal_year_id uuid, p_computation jsonb, p_finalize boolean DEFAULT false, p_note text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS corporate_tax_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_fy public.fiscal_years;
  v_row public.corporate_tax_returns;
  v_year integer;
  v_tax bigint;
  v_taxable bigint;
  v_fiscal bigint;
  v_commercial bigint;
  v_corrections bigint;
  v_loss_used bigint;
  v_prepaid bigint;
  v_entry public.journal_entries;
  v_expense uuid;
  v_payable uuid;
  v_post_date date;
  v_expected_tax bigint;
  v_expected_cap bigint;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vpb'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'De vennootschapsbelasting hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Vennootschapsbelasting hoort bij een BV, NV of coöperatie; een IB-onderneming betaalt inkomstenbelasting.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  v_year := extract(year from v_fy.period_end)::int;

  v_commercial   := coalesce((p_computation->>'commercialResultCents')::bigint, 0);
  v_corrections  := coalesce((p_computation->>'totalCorrectionsCents')::bigint, 0);
  v_fiscal       := coalesce((p_computation->>'fiscalProfitCents')::bigint, 0);
  v_loss_used    := coalesce((p_computation->>'totalLossUsedCents')::bigint, 0);
  v_taxable      := coalesce((p_computation->>'taxableAmountCents')::bigint, 0);
  v_tax          := coalesce((p_computation->>'taxCents')::bigint, 0);
  v_prepaid      := coalesce((p_computation->>'prepaidCents')::bigint, 0);

  -- Onderlinge samenhang controleren. Niet om te herrekenen, maar om te
  -- voorkomen dat een aanroeper met losse bedragen iets in het grootboek zet
  -- dat nergens op slaat.
  if v_commercial + v_corrections <> v_fiscal then
    raise exception 'De berekening klopt niet: commercieel resultaat plus correcties is niet de fiscale winst.'
      using errcode = '23514';
  end if;
  if v_tax < 0 or v_taxable < 0 or v_loss_used < 0 then
    raise exception 'Een negatief belastbaar bedrag, belastingbedrag of verliesverrekening kan niet.'
      using errcode = '23514';
  end if;
  if v_taxable > greatest(v_fiscal - v_loss_used, 0) then
    raise exception 'Het belastbare bedrag is hoger dan de fiscale winst na verliesverrekening.'
      using errcode = '23514';
  end if;

  -- Het bedrag dat straks in het grootboek belandt komt van de aanroeper. Dus
  -- hier hetzelfde als bij de btw-aangifte: de database rekent het zelf na en
  -- weigert bij afwijking. De tarieftabel staat er toch al; hem niet gebruiken
  -- zou betekenen dat één fout in de client rechtstreeks een verkeerde
  -- belastinglast boekt.
  select coalesce(r.base_amount_cents, 0)
       + round(((v_taxable - coalesce(r.lower_bound_cents, 0))::numeric * r.rate_basis_points) / 10000)
  into v_expected_tax
  from public.corporate_tax_rates r
  where r.year = v_year
    and r.lower_bound_cents < greatest(v_taxable, 1)
  order by r.lower_bound_cents desc
  limit 1;

  if v_taxable = 0 then
    v_expected_tax := 0;
  end if;
  if v_expected_tax is null then
    raise exception 'Voor % zijn geen Vpb-tarieven vastgelegd; de berekening kan niet worden nagerekend.', v_year
      using errcode = '02000';
  end if;
  if v_tax <> v_expected_tax then
    raise exception 'De berekende belasting (% cent) komt niet overeen met de tarieftabel van % (% cent). Herbereken de aangifte.',
      v_tax, v_year, v_expected_tax using errcode = '23514';
  end if;

  -- En de verliesverrekening tegen de wettelijke bovengrens van art. 20 lid 2.
  select case
    when v_fiscal <= 0 then 0
    when v_fiscal <= r.loss_relief_threshold_cents then v_fiscal
    else r.loss_relief_threshold_cents
         + round(((v_fiscal - r.loss_relief_threshold_cents)::numeric * r.loss_relief_rate_basis_points) / 10000)
  end
  into v_expected_cap
  from public.corporate_tax_rates r
  where r.year = v_year
  order by r.lower_bound_cents
  limit 1;

  if v_loss_used > coalesce(v_expected_cap, 0) then
    raise exception 'Er wordt meer verlies verrekend (% cent) dan art. 20 lid 2 Wet Vpb toestaat (% cent).',
      v_loss_used, coalesce(v_expected_cap, 0) using errcode = '23514';
  end if;

  insert into public.corporate_tax_returns as t (
    organization_id, fiscal_year_id, created_by, year,
    commercial_result_cents, corrections_cents, fiscal_profit_cents,
    loss_relief_cap_cents, loss_used_cents, taxable_amount_cents,
    tax_cents, prepaid_cents, balance_due_cents, computation, status, note
  ) values (
    p_organization_id, p_fiscal_year_id, p_created_by, v_year,
    v_commercial, v_corrections, v_fiscal,
    coalesce((p_computation->>'lossReliefCapCents')::bigint, 0), v_loss_used, v_taxable,
    v_tax, v_prepaid, v_tax - v_prepaid, p_computation, 'draft', nullif(btrim(p_note), '')
  )
  on conflict (fiscal_year_id) where status <> 'reversed'
  do update set
    commercial_result_cents = excluded.commercial_result_cents,
    corrections_cents       = excluded.corrections_cents,
    fiscal_profit_cents     = excluded.fiscal_profit_cents,
    loss_relief_cap_cents   = excluded.loss_relief_cap_cents,
    loss_used_cents         = excluded.loss_used_cents,
    taxable_amount_cents    = excluded.taxable_amount_cents,
    tax_cents               = excluded.tax_cents,
    prepaid_cents           = excluded.prepaid_cents,
    balance_due_cents       = excluded.balance_due_cents,
    computation             = excluded.computation,
    note                    = coalesce(excluded.note, t.note),
    updated_at              = now()
  where t.status = 'draft'
  returning * into v_row;

  if not found then
    raise exception 'De berekening over dit boekjaar is al vastgesteld. Draai die eerst terug.'
      using errcode = '23514';
  end if;

  if not coalesce(p_finalize, false) then
    return v_row;
  end if;

  -- ---- Vaststellen: de last en de schuld in het grootboek ----------------
  -- De reservering hoort in het boekjaar zelf te vallen, want de belasting
  -- drukt op díe winst. Valt dat jaar al dicht, dan is er niets meer te boeken
  -- en moet de gebruiker eerst heropenen — stilzwijgend naar een andere datum
  -- schuiven zou het resultaat van twee jaren vervuilen.
  v_post_date := v_fy.period_end;

  -- Alleen een JAAR-slot blokkeert. Een gefinaliseerde btw-aangifte vergrendelt
  -- ook de maand of het kwartaal waarin de balansdatum valt — en die sloten gaan
  -- nóóit meer open (alleen 'year'-rijen worden ooit verwijderd). Zou dat hier
  -- blokkeren, dan kon de Vpb-reservering per definitie nooit geboekt worden:
  -- de balansdatum ligt altijd in de laatste btw-periode van het boekjaar.
  -- Dat mag ook: deze post raakt alleen 9900 en 1540, en die komen in geen enkele
  -- btw-rubriek voor — precies de reden waarom 'year_close' dezelfde vrijstelling
  -- heeft.
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type = 'year'
      and v_post_date between cp.period_start and cp.period_end
  ) then
    raise exception 'Boekjaar % is al afgesloten; de Vpb-last hoort ín dat boekjaar. Heropen het boekjaar om de reservering alsnog te boeken.',
      v_fy.label using errcode = '23514';
  end if;

  if v_tax <> 0 then
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_expense := public.bookkeeping_account_id(p_organization_id, '9900');
    v_payable := public.bookkeeping_account_id(p_organization_id, '1540');

    perform set_config('resofly.trusted_journal_source', 'corporate_tax', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_post_date,
      'Vennootschapsbelasting ' || v_fy.label,
      'corporate_tax', v_row.id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_expense,
          'description', 'Vennootschapsbelasting ' || v_fy.label,
          'debit_cents', v_tax, 'credit_cents', 0),
        jsonb_build_object('account_id', v_payable,
          'description', 'Te betalen vennootschapsbelasting ' || v_fy.label,
          'debit_cents', 0, 'credit_cents', v_tax)
      ),
      p_created_by
    );
  end if;

  -- Verliezen bijwerken: gebruikte verliezen afboeken, een verlies van dit jaar
  -- vastleggen. Beide uit de uitkomst van het rekenhart, zodat de administratie
  -- en de berekening niet uit elkaar kunnen lopen.
  update public.corporate_tax_losses l
  set remaining_cents = greatest(l.remaining_cents - u.used_cents, 0)
  from (
    select (e->>'year')::int as year, (e->>'usedCents')::bigint as used_cents
    from jsonb_array_elements(coalesce(p_computation->'lossesUsed', '[]'::jsonb)) e
  ) u
  where l.organization_id = p_organization_id and l.year = u.year;

  if v_fiscal < 0 then
    insert into public.corporate_tax_losses(organization_id, created_by, year, amount_cents, remaining_cents)
    values (p_organization_id, p_created_by, v_year, -v_fiscal, -v_fiscal)
    on conflict (organization_id, year) do update
      set amount_cents = excluded.amount_cents,
          remaining_cents = excluded.remaining_cents,
          updated_at = now();
  end if;

  update public.corporate_tax_returns
  set status = 'final', accrual_entry_id = v_entry.id,
      finalized_at = now(), finalized_by = p_created_by
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

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
    left join public.clients c on c.id = il.client_id and c.organization_id = p_organization_id
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

create or replace function public.book_bank_transaction(p_organization_id uuid, p_transaction_id uuid, p_lines jsonb DEFAULT NULL::jsonb, p_matched_invoice_id uuid DEFAULT NULL::uuid, p_matched_purchase_invoice_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_abs bigint;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_pi public.purchase_invoices;
  v_desc text;
  r record;
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
  -- FIX 2: openstaand-saldo-bewaking
  v_entry_reversed boolean;
  v_doc_total bigint;
  v_already bigint;
  v_open bigint;
  -- FIX 3: BTW-accumulatoren met richting (positief = natuurlijke kant)
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- Eén factuur per transactie: met beide ids gezet werd het tweede id
  -- ongecontroleerd opgeslagen (ook een inkoopfactuur van een andere organisatie).
  if p_matched_invoice_id is not null and p_matched_purchase_invoice_id is not null then
    raise exception 'Koppel een transactie aan één factuur: een verkoopfactuur óf een inkoopfactuur.' using errcode = '23514';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze transactie is al geboekt.' using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_abs := abs(v_txn.amount_cents);
  if v_abs = 0 then
    raise exception 'Een transactie van € 0,00 kan niet worden geboekt.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_vat_payable_id := public.bookkeeping_account_id(p_organization_id, '1530');

  v_desc := 'Bank ' || coalesce(v_ba.name, '') || ': ' ||
            coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'transactie');

  -- Bankregel (debet bij ontvangst, credit bij betaling).
  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ba.ledger_account_id,
    'description', v_desc,
    'debit_cents', case when v_txn.amount_cents > 0 then v_abs else 0 end,
    'credit_cents', case when v_txn.amount_cents < 0 then v_abs else 0 end
  ));

  if p_matched_invoice_id is not null then
    if v_txn.amount_cents <= 0 then
      raise exception 'Een verkoopfactuur afletteren kan alleen bij een ontvangst.' using errcode = '23514';
    end if;
    -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
    -- anders allebei de openstaand-check passeren.
    select * into v_inv from public.invoices
    where id = p_matched_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Verkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- FIX 2: afletteren kan alleen tegen een factuur die in het grootboek staat.
    -- Zonder debitering van 1300 zou de creditering hier Debiteuren negatief maken.
    if v_inv.journal_entry_id is null then
      raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en letter daarna af.', coalesce(v_inv.number, '')
        using errcode = '23514';
    end if;
    select je.reversed_by_entry_id is not null into v_entry_reversed
    from public.journal_entries je where je.id = v_inv.journal_entry_id;
    if coalesce(v_entry_reversed, false) then
      raise exception 'De grootboekboeking van factuur % is tegengeboekt; er valt niets meer af te letteren.', coalesce(v_inv.number, '')
        using errcode = '23514';
    end if;

    -- FIX 2: begrens op het openstaande saldo (geboekte vordering − eerdere
    -- bankboekingen op deze factuur). Deelbetalingen blijven mogelijk.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_doc_total
    from public.journal_lines jl
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = v_inv.journal_entry_id and la.subtype = 'accounts_receivable';

    -- Eerdere betalingen tellen we uit de JOURNAALREGELS (credit op 1300 van de
    -- gekoppelde boekingen), niet uit het matchveld: een vrij geboekte transactie
    -- met een achtergebleven factuur-suggestie heeft géén debiteurenregel en telt
    -- dus terecht niet mee. Direct tegengeboekte betaal-boekingen (reversed_by)
    -- tellen evenmin.
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_already
    from public.bank_transactions bt
    join public.journal_entries je2 on je2.id = bt.journal_entry_id and je2.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je2.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    where bt.organization_id = p_organization_id
      and bt.matched_invoice_id = v_inv.id
      and bt.status = 'booked'
      and bt.id <> v_txn.id;

    v_open := v_doc_total - v_already;
    if v_open <= 0 then
      raise exception 'Factuur % is al volledig afgeletterd.', coalesce(v_inv.number, '') using errcode = '23514';
    end if;
    if v_abs > v_open then
      raise exception 'Ontvangst (€ %) is hoger dan het openstaande saldo van factuur % (€ %). Koppelen aan deze factuur kan dan niet; boek de transactie via een grootboekrekening (vrije boeking).',
        to_char(v_abs / 100.0, 'FM999999990.00'), coalesce(v_inv.number, ''), to_char(v_open / 100.0, 'FM999999990.00')
        using errcode = '23514';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren — factuur ' || coalesce(v_inv.number, ''),
      'debit_cents', 0, 'credit_cents', v_abs,
      'client_id', v_inv.client_id
    ));

  elsif p_matched_purchase_invoice_id is not null then
    if v_txn.amount_cents >= 0 then
      raise exception 'Een inkoopfactuur afletteren kan alleen bij een betaling.' using errcode = '23514';
    end if;
    select * into v_pi from public.purchase_invoices
    where id = p_matched_purchase_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- FIX 2: zelfde bewaking als bij verkoopfacturen, spiegelbeeldig op 1600.
    if v_pi.journal_entry_id is null then
      raise exception 'Inkoopfactuur % staat nog niet in het grootboek. Boek de inkoopfactuur eerst en letter daarna af.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;
    select je.reversed_by_entry_id is not null into v_entry_reversed
    from public.journal_entries je where je.id = v_pi.journal_entry_id;
    if coalesce(v_entry_reversed, false) then
      raise exception 'De grootboekboeking van inkoopfactuur % is tegengeboekt; er valt niets meer af te letteren.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;

    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_doc_total
    from public.journal_lines jl
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = v_pi.journal_entry_id and la.subtype = 'accounts_payable';

    -- Spiegelbeeldig aan de verkoopkant: eerdere betalingen uit de journaalregels
    -- (debet op 1600), niet uit het matchveld.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_already
    from public.bank_transactions bt
    join public.journal_entries je2 on je2.id = bt.journal_entry_id and je2.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je2.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = v_pi.id
      and bt.status = 'booked'
      and bt.id <> v_txn.id;

    v_open := v_doc_total - v_already;
    if v_open <= 0 then
      raise exception 'Inkoopfactuur % is al volledig afgeletterd.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;
    if v_abs > v_open then
      raise exception 'Betaling (€ %) is hoger dan het openstaande saldo van inkoopfactuur % (€ %). Koppelen aan deze inkoopfactuur kan dan niet; boek de transactie via een grootboekrekening (vrije boeking).',
        to_char(v_abs / 100.0, 'FM999999990.00'),
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
        to_char(v_open / 100.0, 'FM999999990.00')
        using errcode = '23514';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
      'description', 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
      'debit_cents', v_abs, 'credit_cents', 0,
      'supplier_id', v_pi.supplier_id
    ));

  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    -- Vrije boeking: per regel bruto bedrag + BTW-code; net/BTW worden gesplitst.
    -- FIX 3: de BTW-verwerking kijkt nu naar vat_codes.kind én naar de AARD van
    -- de tegenrekening, niet naar het teken van de banktransactie:
    --   · omzetrekening       → 1510 Af te dragen BTW (kant volgt de regel)
    --   · kosten/activa       → 1500 Voorbelasting   (kant volgt de regel)
    --   · verlegd/EU-verwerving (kind) → grondslag = volle bankbedrag,
    --     BTW als 1500 + 1520 tegen elkaar in, zoals book_purchase_invoice.
    for r in
      select
        acc.account_id,
        la.type as account_type,
        coalesce((l->>'amount_cents')::bigint, 0) as gross_cents,
        nullif(l->>'vat_code','') as vat_code,
        nullif(l->>'description','') as description,
        coalesce(vc.rate, nullif(l->>'vat_rate','')::numeric, 0) as rate,
        coalesce(vc.kind, 'standard') as kind
      from jsonb_array_elements(p_lines) l
      cross join lateral (
        select coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, l->>'account_code')) as account_id
      ) acc
      left join public.ledger_accounts la
        on la.id = acc.account_id and la.organization_id = p_organization_id
      left join public.vat_codes vc
        on vc.organization_id = p_organization_id and vc.code = (l->>'vat_code')
    loop
      if r.gross_cents = 0 then continue; end if;
      -- Onthoud hoeveel er op 1530 Te betalen omzetbelasting wordt geboekt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if r.account_id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + r.gross_cents;
      end if;
      declare
        v_is_credit boolean := v_txn.amount_cents > 0; -- regelkant volgt de bank
        v_net bigint;
        v_vat bigint;
      begin
        if r.kind in ('reverse_charge_purchase', 'eu_acquisition') then
          -- Verlegd/EU-verwerving: de betaling is exclusief BTW — het volle
          -- bankbedrag is de grondslag. BTW zelf aangeven én aftrekken.
          v_net := r.gross_cents;
          v_vat := round(r.gross_cents * r.rate / 100.0);
          if v_is_credit then
            -- Terugontvangst van een verlegde leverancier: beide kanten terugdraaien.
            v_vat_1500 := v_vat_1500 - v_vat;
            v_vat_1520 := v_vat_1520 - v_vat;
          else
            v_vat_1500 := v_vat_1500 + v_vat;
            v_vat_1520 := v_vat_1520 + v_vat;
          end if;
        else
          -- Inclusief-BTW-splitsing (bruto → net + BTW), centneutraal.
          v_net := round(r.gross_cents / (1 + r.rate / 100.0));
          v_vat := r.gross_cents - v_net;
          if r.account_type = 'revenue' then
            -- Omzet: BTW hoort op 1510 — ook bij een terugbetaling aan een
            -- klant (dan als debet, zodat de af te dragen BTW dáált i.p.v.
            -- dat er voorbelasting bij wordt verzonnen).
            v_vat_1510 := v_vat_1510 + case when v_is_credit then v_vat else -v_vat end;
          elsif r.account_type in ('expense', 'asset') then
            -- Kosten/activa: BTW hoort op 1500 — ook bij een terugstorting
            -- van een leverancier (dan als credit: voorbelasting terugnemen).
            v_vat_1500 := v_vat_1500 + case when v_is_credit then -v_vat else v_vat end;
          else
            -- Balansrekening/onbekend: gedrag van vóór deze fix (geldrichting).
            if v_is_credit then
              v_vat_1510 := v_vat_1510 + v_vat;
            else
              v_vat_1500 := v_vat_1500 + v_vat;
            end if;
          end if;
        end if;

        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', r.account_id,
          'description', coalesce(r.description, case when v_is_credit then 'Ontvangst' else 'Betaling' end),
          'debit_cents', case when v_is_credit then 0 else v_net end,
          'credit_cents', case when v_is_credit then v_net else 0 end,
          'vat_code', r.vat_code, 'vat_rate', r.rate,
          -- Rubriekconsistentie: op omzetregels telt compute_vat_return
          -- vat_amount_cents op naast credit−debit; een debet-omzetregel
          -- (terugbetaling) moet dus een negatieve grondslag/BTW dragen.
          'vat_base_cents', case when r.account_type = 'revenue' and not v_is_credit then -v_net else v_net end,
          'vat_amount_cents', case when r.account_type = 'revenue' and not v_is_credit then -v_vat else v_vat end));
      end;
    end loop;

    if v_vat_1510 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
        'description', 'Af te dragen BTW',
        'debit_cents', case when v_vat_1510 < 0 then -v_vat_1510 else 0 end,
        'credit_cents', case when v_vat_1510 > 0 then v_vat_1510 else 0 end));
    end if;
    if v_vat_1500 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
        'description', 'Voorbelasting',
        'debit_cents', case when v_vat_1500 > 0 then v_vat_1500 else 0 end,
        'credit_cents', case when v_vat_1500 < 0 then -v_vat_1500 else 0 end));
    end if;
    if v_vat_1520 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
        'description', 'Verschuldigde BTW verlegd/ICP',
        'debit_cents', case when v_vat_1520 < 0 then -v_vat_1520 else 0 end,
        'credit_cents', case when v_vat_1520 > 0 then v_vat_1520 else 0 end));
    end if;

  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_txn.booking_date, v_desc, 'payment', v_txn.id, v_lines, p_created_by
  );

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed. Voorheen
  -- (coalesce) bleef een achtergebleven matcher-suggestie staan wanneer er via
  -- vrije regels werd geboekt — waardoor die rij ten onrechte als aflettering op
  -- die factuur telde. Nu: vrije boeking → beide matchvelden leeg.
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = p_matched_invoice_id,
    matched_purchase_invoice_id = p_matched_purchase_invoice_id,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- We matchen ALTIJD op het AFGERONDE saldo (hele euro's); voor aangiftes van vóór
  -- 20260710010000 (zonder saldo_afgerond in de snapshot) ronden we hun exacte saldo
  -- hier op dezelfde manier af. Alleen bij een ondubbelzinnige match markeren.
  if v_vat_payable_booked > 0 then
    v_target_saldo := case when v_txn.amount_cents < 0 then v_vat_payable_booked else -v_vat_payable_booked end;
    select count(*) into v_match_count
    from public.vat_returns
    where organization_id = p_organization_id
      and status in ('finalized', 'filed')
      and coalesce(
        (rubrieken->>'saldo_afgerond')::bigint,
        round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
      ) = v_target_saldo;
    if v_match_count = 1 then
      select id into v_match_id
      from public.vat_returns
      where organization_id = p_organization_id
        and status in ('finalized', 'filed')
        and coalesce(
          (rubrieken->>'saldo_afgerond')::bigint,
          round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
        ) = v_target_saldo
      limit 1;
      update public.vat_returns
      set status = 'paid', paid_bank_transaction_id = v_txn.id, updated_at = now()
      where id = v_match_id;
    end if;
  end if;

  return v_entry;
end;
$$;

create or replace function public.declare_dividend(p_organization_id uuid, p_kind text, p_decision_date date, p_available_date date, p_lines jsonb, p_result_appropriation_id uuid DEFAULT NULL::uuid, p_board_approved boolean DEFAULT false, p_source_account_code text DEFAULT '0520'::text, p_note text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS dividend_distributions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_row public.dividend_distributions;
  v_appropriation public.result_appropriations;
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'interim');
  v_rate integer;
  v_gross bigint := 0;
  v_tax bigint := 0;
  v_line jsonb;
  v_shareholder uuid;
  v_line_gross bigint;
  v_line_tax bigint;
  v_exempt boolean;
  v_exempt_note text;
  v_shares bigint;
  v_seen uuid[] := array[]::uuid[];
  v_distributable bigint;
  v_legal_form text;
  v_source_code text := coalesce(nullif(btrim(p_source_account_code), ''), '0520');
  v_source_account uuid;
  v_payable_account uuid;
  v_tax_account uuid;
  v_account_type text;
  v_restricted boolean;
  v_subtype text;
  -- Bewust losse uuid's en geen rowtype-variabelen: bij een dividend uit de
  -- vastgestelde winst valt boekstuk A weg en bij een volledig vrijgestelde
  -- uitkering boekstuk B, en dan moet het veld gewoon leeg blijven.
  v_declaration_entry uuid;
  v_withholding_entry uuid;
  v_board boolean := coalesce(p_board_approved, false);
  v_closed record;
  v_prepared jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- De winstbestemming moet van deze organisatie zijn, ook bij een interim-
  -- dividend: anders kon een lid van organisatie A een dividend aan B's
  -- winstbestemming hangen en daarmee B's terugdraaien en slotdividend blokkeren.
  if p_result_appropriation_id is not null and not exists (
    select 1 from public.result_appropriations ra
    where ra.id = p_result_appropriation_id and ra.organization_id = p_organization_id
  ) then
    raise exception 'Deze winstbestemming hoort niet bij deze organisatie.' using errcode = '42501';
  end if;

  -- Zelfde slot als het afsluiten en de resultaatbestemming: die verplaatsen
  -- hetzelfde eigen vermogen en dezelfde schuld op 1580.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'Dividend hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if not public.org_is_corporate(p_organization_id) then
    raise exception 'Dividend op aandelen hoort bij een BV of NV. Bij deze rechtsvorm speelt het niet.'
      using errcode = '23514';
  end if;

  if v_kind not in ('final', 'interim') then
    raise exception 'Onbekende soort uitkering: %.', v_kind using errcode = '23514';
  end if;
  if p_decision_date is null or p_available_date is null then
    raise exception 'Zowel de besluitdatum als de datum van terbeschikkingstelling is verplicht.' using errcode = '23514';
  end if;
  if p_available_date < p_decision_date then
    raise exception 'Het dividend kan niet ter beschikking zijn gesteld vóór het besluit.' using errcode = '23514';
  end if;

  v_rate := public.dividend_tax_rate_on(p_available_date);
  if v_rate is null then
    raise exception 'Voor % is geen tarief dividendbelasting vastgelegd.', to_char(p_available_date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- De verdeling over de aandeelhouders --------------------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een dividendbesluit heeft minstens één aandeelhouder nodig.' using errcode = '23514';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_shareholder := nullif(v_line->>'shareholder_id', '')::uuid;
    v_line_gross := coalesce((v_line->>'gross_cents')::bigint, 0);

    if v_shareholder is null then
      raise exception 'Elke regel moet een aandeelhouder noemen.' using errcode = '23514';
    end if;
    if v_line_gross < 0 then
      raise exception 'Een dividendbedrag kan niet negatief zijn.' using errcode = '23514';
    end if;
    if v_shareholder = any (v_seen) then
      raise exception 'Dezelfde aandeelhouder staat twee keer in het besluit.' using errcode = '23505';
    end if;
    v_seen := v_seen || v_shareholder;

    select sh.withholding_exempt, sh.withholding_exempt_note
    into v_exempt, v_exempt_note
    from public.shareholders sh
    where sh.id = v_shareholder and sh.organization_id = p_organization_id;
    if not found then
      raise exception 'Aandeelhouder niet gevonden in deze administratie.' using errcode = '02000';
    end if;

    -- Aantal aandelen op de besluitdatum, alleen als onderbouwing van de
    -- verdeling. Het bedrag komt van de aanroeper: de statuten kunnen
    -- soorten aandelen kennen die niet gelijk delen, en dan is pro rata fout.
    select coalesce(sum(p.shares), 0) into v_shares
    from public.shareholder_positions(p_organization_id, p_decision_date) p
    where p.shareholder_id = v_shareholder;

    -- Vrijgesteld = niets inhouden (art. 4 Wet DB 1965). Anders het tarief over
    -- het bruto bedrag, per aandeelhouder afgerond — zo telt de som van de
    -- regels altijd op tot het totaal van de uitkering.
    v_line_tax := case when v_exempt then 0
                       else round(v_line_gross::numeric * v_rate / 10000)::bigint end;

    v_gross := v_gross + v_line_gross;
    v_tax := v_tax + v_line_tax;

    v_prepared := v_prepared || jsonb_build_array(jsonb_build_object(
      'shareholder_id', v_shareholder,
      'shares', v_shares,
      'gross_cents', v_line_gross,
      'withholding_exempt', v_exempt,
      'exempt_note', case when v_exempt then v_exempt_note end,
      'tax_cents', v_line_tax,
      'net_cents', v_line_gross - v_line_tax
    ));
  end loop;

  if v_gross <= 0 then
    raise exception 'Er valt niets uit te keren: het totaal is nul.' using errcode = '23514';
  end if;

  -- ---- Waar komt het vandaan? ---------------------------------------------
  v_legal_form := public.org_legal_form(p_organization_id);

  if v_kind = 'final' then
    if p_result_appropriation_id is null then
      raise exception 'Een dividend uit de vastgestelde winst hoort bij een besluit van de algemene vergadering.'
        using errcode = '23514';
    end if;

    select * into v_appropriation from public.result_appropriations
    where id = p_result_appropriation_id and organization_id = p_organization_id for update;
    if not found then
      raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
    end if;
    if v_appropriation.status <> 'posted' then
      raise exception 'Die resultaatbestemming is teruggedraaid.' using errcode = '23514';
    end if;
    if v_appropriation.dividend_cents <= 0 then
      raise exception 'Dat besluit kende geen dividend toe.' using errcode = '23514';
    end if;
    if v_gross <> v_appropriation.dividend_cents then
      raise exception 'De verdeling moet precies het toegekende dividend van % cent bedragen, nu % cent.',
        v_appropriation.dividend_cents, v_gross using errcode = '23514';
    end if;
    if exists (
      select 1 from public.dividend_distributions d
      where d.result_appropriation_id = p_result_appropriation_id and d.organization_id = p_organization_id and d.status = 'posted'
    ) then
      raise exception 'Dit dividend is al uitgekeerd. Draai die uitkering eerst terug.' using errcode = '23505';
    end if;
    if p_decision_date < v_appropriation.decision_date then
      raise exception 'De uitkering kan niet vóór het besluit van % liggen.',
        to_char(v_appropriation.decision_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;

    -- De balanstest en de bestuursgoedkeuring zijn bij dát besluit al gedaan;
    -- opnieuw toetsen zou onzin opleveren, want het bruto bedrag staat al niet
    -- meer in het eigen vermogen maar op 1580.
    v_distributable := v_appropriation.distributable_cents;
    v_board := v_appropriation.board_approved;
    v_source_code := null;
  else
    -- ---- Interim: hier gelden beide toetsen van art. 2:216 BW wél ----------
    -- Lid 1 spreekt van "vaststelling van uitkeringen" en dekt daarmee ook de
    -- tussentijdse. Peildatum is de besluitdatum: dat is het moment waarop het
    -- bestuur en de vergadering naar het vermogen kijken.
    v_distributable := public.org_distributable_equity(
      p_organization_id, p_decision_date, v_legal_form = 'nv'
    );

    if v_gross > v_distributable then
      if v_legal_form = 'nv' then
        raise exception 'Balanstest (art. 2:105 lid 2 BW): vrij uitkeerbaar is op % nog % cent — het eigen vermogen boven het gestorte kapitaal en de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          to_char(p_decision_date, 'DD-MM-YYYY'), v_distributable, v_gross using errcode = '23514';
      else
        raise exception 'Balanstest (art. 2:216 lid 1 BW): vrij uitkeerbaar is op % nog % cent — het eigen vermogen boven de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          to_char(p_decision_date, 'DD-MM-YYYY'), v_distributable, v_gross using errcode = '23514';
      end if;
    end if;

    if not v_board then
      raise exception 'Uitkeringstest (art. 2:216 lid 2 BW): het bestuur moet bevestigen dat de vennootschap haar opeisbare schulden ook ná deze uitkering kan blijven betalen. Zonder die goedkeuring heeft het besluit geen gevolgen.'
        using errcode = '23514';
    end if;
  end if;

  -- ---- Periodesloten, vriendelijk gemeld ----------------------------------
  -- post_journal_entry weigert straks alsnog, maar met een generieke melding.
  -- Een dividend raakt geen btw-rubriek, dus hier is geen vrijstelling nodig
  -- zoals bij de jaarafsluiting: de datum ligt gewoon in een open periode of de
  -- gebruiker kiest een andere.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and (
      (v_kind = 'interim' and p_decision_date between cp.period_start and cp.period_end)
      or (v_tax > 0 and p_available_date between cp.period_start and cp.period_end)
    )
  limit 1;
  if found then
    raise exception 'De periode % t/m % is afgesloten; kies data in een open periode.',
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- Boeken --------------------------------------------------------------
  perform public.ensure_default_ledger_accounts(p_organization_id);

  v_payable_account := public.bookkeeping_account_id(p_organization_id, '1580');
  select la.type into v_account_type from public.ledger_accounts la where la.id = v_payable_account;
  if v_account_type <> 'liability' then
    raise exception 'Rekening 1580 is geen schuldrekening; een dividendbesluit levert een schuld aan de aandeelhouder op.'
      using errcode = '23514';
  end if;

  if v_kind = 'interim' then
    v_source_account := public.bookkeeping_account_id(p_organization_id, v_source_code);
    select la.type, la.is_restricted_reserve, la.subtype
    into v_account_type, v_restricted, v_subtype
    from public.ledger_accounts la where la.id = v_source_account;

    if v_account_type <> 'equity' then
      raise exception 'Rekening % is geen eigen-vermogensrekening; een tussentijdse uitkering gaat ten laste van de reserves.', v_source_code
        using errcode = '23514';
    end if;
    -- Een wettelijke of statutaire reserve is nu juist het deel dat NIET
    -- uitgekeerd mag worden; daar een dividend uit boeken zou de balanstest
    -- via de achterdeur omzeilen.
    if coalesce(v_restricted, false) or coalesce(v_subtype, '') in ('legal_reserve', 'statutory_reserve') then
      raise exception 'Rekening % is een wettelijke of statutaire reserve; die moet worden aangehouden en kan niet worden uitgekeerd (art. 2:216 lid 1 BW).', v_source_code
        using errcode = '23514';
    end if;

    v_declaration_entry := (public.post_journal_entry(
      p_organization_id, p_decision_date,
      'Interim-dividend ' || to_char(p_decision_date, 'DD-MM-YYYY'),
      'dividend', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_source_account,
          'description', 'Tussentijdse uitkering ten laste van de reserves',
          'debit_cents', v_gross, 'credit_cents', 0),
        jsonb_build_object('account_id', v_payable_account,
          'description', 'Te betalen dividend',
          'debit_cents', 0, 'credit_cents', v_gross)
      ), p_created_by)).id;
  end if;

  if v_tax > 0 then
    v_tax_account := public.bookkeeping_account_id(p_organization_id, '1560');
    select la.type into v_account_type from public.ledger_accounts la where la.id = v_tax_account;
    if v_account_type <> 'liability' then
      raise exception 'Rekening 1560 is geen schuldrekening; ingehouden dividendbelasting is een schuld aan de Belastingdienst.'
        using errcode = '23514';
    end if;

    -- Inhouden verplaatst een deel van de schuld aan de aandeelhouder naar een
    -- schuld aan de Belastingdienst. Het eigen vermogen verandert hier niet
    -- meer: dat gebeurde bij het besluit.
    v_withholding_entry := (public.post_journal_entry(
      p_organization_id, p_available_date,
      'Dividendbelasting ' || to_char(p_available_date, 'DD-MM-YYYY'),
      'dividend', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable_account,
          'description', 'Ingehouden dividendbelasting',
          'debit_cents', v_tax, 'credit_cents', 0),
        jsonb_build_object('account_id', v_tax_account,
          'description', 'Af te dragen dividendbelasting',
          'debit_cents', 0, 'credit_cents', v_tax)
      ), p_created_by)).id;
  end if;

  -- ---- Vastleggen ----------------------------------------------------------
  insert into public.dividend_distributions(
    organization_id, created_by, kind, result_appropriation_id,
    decision_date, available_date,
    gross_cents, tax_cents, net_cents, tax_rate_basis_points,
    source_account_code, payable_account_code, tax_account_code,
    distributable_cents, board_approved, board_approved_by, board_approved_at,
    declaration_entry_id, withholding_entry_id, status, note
  ) values (
    p_organization_id, p_created_by, v_kind, p_result_appropriation_id,
    p_decision_date, p_available_date,
    v_gross, v_tax, v_gross - v_tax, v_rate,
    v_source_code, '1580', '1560',
    v_distributable, v_board,
    case when v_board then p_created_by end,
    case when v_board then now() end,
    v_declaration_entry, v_withholding_entry,
    'posted', nullif(btrim(p_note), '')
  )
  returning * into v_row;

  insert into public.dividend_distribution_lines(
    organization_id, distribution_id, shareholder_id, shares,
    gross_cents, withholding_exempt, exempt_note, tax_cents, net_cents
  )
  select
    p_organization_id, v_row.id,
    (l->>'shareholder_id')::uuid,
    (l->>'shares')::bigint,
    (l->>'gross_cents')::bigint,
    (l->>'withholding_exempt')::boolean,
    nullif(l->>'exempt_note', ''),
    (l->>'tax_cents')::bigint,
    (l->>'net_cents')::bigint
  from jsonb_array_elements(v_prepared) l;

  return v_row;
end;
$$;

create or replace function public.reverse_result_appropriation(p_organization_id uuid, p_appropriation_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS result_appropriations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_row public.result_appropriations;
  v_closed record;
  v_aa public.annual_accounts;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een resultaatbestemming terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.result_appropriations
  where id = p_appropriation_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Deze resultaatbestemming is al teruggedraaid.' using errcode = '23514';
  end if;

  -- De uitkering die op deze bestemming steunt (20260807100000).
  if exists (
    select 1 from public.dividend_distributions d
    where d.result_appropriation_id = p_appropriation_id and d.organization_id = p_organization_id and d.status = 'posted'
  ) then
    raise exception 'Draai eerst de dividenduitkering terug; die houdt belasting in op de schuld die deze bestemming heeft geboekt.'
      using errcode = '23514';
  end if;

  -- NIEUW (20260812010000): een jaarrekening die nog IN BEHANDELING is, bevriest
  -- de balans ná déze bestemming. Die mutatie mag niet onder zo'n stuk vandaan
  -- verdwijnen zolang het met één handeling is in te trekken. Een GEDEPONEERD
  -- stuk blokkeert bewust niet: zie 13b hierboven en kernbeslissing G.
  -- for update: adopt_annual_accounts en file_annual_accounts nemen inmiddels
  -- dezelfde ':fyclose'-lock, maar een rijlock erbij kost niets en sluit de
  -- laatste kier onder READ COMMITTED.
  select * into v_aa from public.annual_accounts aa
  where aa.fiscal_year_id = v_row.fiscal_year_id
    and aa.organization_id = p_organization_id
    and aa.status in ('prepared','adopted')
  order by case when aa.status = 'adopted' then 0 else 1 end, aa.created_at
  limit 1
  for update;
  if found then
    if v_aa.status = 'adopted' then
      raise exception 'De jaarrekening van dit boekjaar is op % vastgesteld en toont de balans ná deze resultaatbestemming. Trek die jaarrekening eerst in ("Jaarrekening intrekken"). Een al GEDEPONEERDE jaarrekening zou hier overigens niet in de weg staan: die blijft staan en wordt vervangen door een opvolgend stuk.',
        to_char(v_aa.adoption_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    raise exception 'Voor dit boekjaar ligt een op % opgemaakte jaarrekening die de balans ná deze resultaatbestemming heeft bevroren. Trek die jaarrekening eerst in ("Jaarrekening intrekken") en maak haar ná de nieuwe bestemming opnieuw op. Een al GEDEPONEERDE jaarrekening zou hier niet in de weg staan: die blijft staan en wordt vervangen door een opvolgend stuk.',
      to_char(v_aa.prepared_on, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Het boekstuk uit de rapporten halen verandert de balans van het boekjaar
  -- waarin het besluit valt. Is dát boekjaar inmiddels zelf afgesloten, dan zou
  -- de vastgestelde balans ervan met terugwerkende kracht veranderen — precies
  -- wat reopen_fiscal_year ook weigert. Eerst dat jaar heropenen dus.
  --
  -- Alleen jaar-sloten tellen hier. Een gefinaliseerde btw-aangifte (maand of
  -- kwartaal) vergrendelt wél het BOEKEN, maar deze post raakt uitsluitend
  -- eigen-vermogensrekeningen en verandert geen enkele rubriek van die
  -- aangifte. Zou een btw-slot hier blokkeren, dan was de bestemming alsnog
  -- voorgoed onomkeerbaar: zo'n slot gaat nooit meer open.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_row.decision_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het besluit van % valt in boekjaar % t/m %, en dat is afgesloten. Heropen dat boekjaar eerst; anders verandert de vastgestelde balans ervan met terugwerkende kracht.',
      to_char(v_row.decision_date, 'DD-MM-YYYY'),
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  if v_row.journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_row.journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.result_appropriations
  set status = 'reversed', reversed_at = now(), reversed_by = p_created_by
  where id = p_appropriation_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.convert_accepted_quote_to_invoice(p_quote_id uuid, p_organization_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
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
$$;

create or replace function public.appropriate_result(p_organization_id uuid, p_fiscal_year_id uuid, p_decision_date date, p_reserves_cents bigint, p_dividend_cents bigint DEFAULT 0, p_board_approved boolean DEFAULT false, p_reserves_account_code text DEFAULT '0520'::text, p_dividend_account_code text DEFAULT '1580'::text, p_note text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS result_appropriations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_fy public.fiscal_years;
  v_row public.result_appropriations;
  v_entry public.journal_entries;
  v_result bigint;
  v_reserves bigint := coalesce(p_reserves_cents, 0);
  v_dividend bigint := coalesce(p_dividend_cents, 0);
  v_result_code text;
  v_reserves_code text := coalesce(nullif(btrim(p_reserves_account_code), ''), '0520');
  v_dividend_code text := coalesce(nullif(btrim(p_dividend_account_code), ''), '1580');
  v_result_account uuid;
  v_reserves_account uuid;
  v_dividend_account uuid;
  v_distributable bigint;
  v_lines jsonb := '[]'::jsonb;
  v_closed record;
  v_legal_form text;
  v_account_type text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer tegen afsluiten/heropenen: die functies verplaatsen hetzelfde
  -- saldo op 0510.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'Resultaatbestemming hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Een resultaatbestemming door de algemene vergadering hoort bij een BV, NV of coöperatie. Bij een IB-onderneming is de winst al van de ondernemer.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status <> 'closed' then
    raise exception 'Sluit het boekjaar eerst af; de algemene vergadering bestemt het resultaat van een vastgestelde jaarrekening.'
      using errcode = '23514';
  end if;

  v_result := coalesce(v_fy.result_cents, 0);
  if v_result = 0 then
    raise exception 'Dit boekjaar heeft geen resultaat om te bestemmen.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.result_appropriations ra
    where ra.fiscal_year_id = p_fiscal_year_id and ra.status = 'posted'
  ) then
    raise exception 'Het resultaat van dit boekjaar is al bestemd. Draai die bestemming eerst terug.'
      using errcode = '23505';
  end if;

  -- ---- Datum van het besluit -------------------------------------------
  if p_decision_date is null then
    raise exception 'De datum van het besluit ontbreekt.' using errcode = '23514';
  end if;
  if p_decision_date <= v_fy.period_end then
    raise exception 'De algemene vergadering besluit ná de balansdatum: kies een datum na %.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Vriendelijke melding in plaats van de generieke periodeslot-fout uit
  -- post_journal_entry.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and p_decision_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'De periode % t/m % is afgesloten; kies een besluitdatum in een open periode.',
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- Bedragen ---------------------------------------------------------
  if v_result > 0 then
    if v_reserves < 0 or v_dividend < 0 then
      raise exception 'Een winstbestemming kent geen negatieve bedragen.' using errcode = '23514';
    end if;
    if v_reserves + v_dividend <> v_result then
      raise exception 'Het besluit moet het hele resultaat bestemmen: reserves + dividend moet % cent zijn, nu % cent.',
        v_result, v_reserves + v_dividend using errcode = '23514';
    end if;
  else
    -- Een verlies wordt niet uitgekeerd; het gaat volledig ten laste van de reserves.
    if v_dividend <> 0 then
      raise exception 'Uit een verlies kan geen dividend worden uitgekeerd.' using errcode = '23514';
    end if;
    if v_reserves <> v_result then
      raise exception 'Een verlies gaat volledig ten laste van de reserves: verwacht % cent, nu % cent.',
        v_result, v_reserves using errcode = '23514';
    end if;
  end if;

  -- ---- Uitkeringstoets ---------------------------------------------------
  -- Een NV heeft een strengere ondergrens dan een BV: bij een NV telt het
  -- gestorte en opgevraagde kapitaal mee (art. 2:105 lid 2 BW), bij een BV
  -- alleen de wettelijke en statutaire reserves (art. 2:216 lid 1 BW).
  v_legal_form := public.org_legal_form(p_organization_id);
  v_distributable := public.org_distributable_equity(
    p_organization_id, v_fy.period_end, v_legal_form = 'nv'
  );

  if v_dividend > 0 then
    if not public.org_is_corporate(p_organization_id) then
      raise exception 'Dividend hoort bij een BV of NV; een coöperatie keert uit aan haar leden en dat loopt niet via deze weg.'
        using errcode = '23514';
    end if;

    if v_dividend > v_distributable then
      if v_legal_form = 'nv' then
        raise exception 'Balanstest (art. 2:105 lid 2 BW): vrij uitkeerbaar is % cent — het eigen vermogen boven het gestorte kapitaal en de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          v_distributable, v_dividend using errcode = '23514';
      else
        raise exception 'Balanstest (art. 2:216 lid 1 BW): vrij uitkeerbaar is % cent — het eigen vermogen boven de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          v_distributable, v_dividend using errcode = '23514';
      end if;
    end if;

    -- Uitkeringstest (art. 2:216 lid 2 BW): zonder bestuursgoedkeuring heeft het
    -- besluit geen gevolgen, dus boeken we het ook niet. Bij een NV bestaat deze
    -- wettelijke goedkeuring niet; daar is het een gewoon bestuursbesluit, maar
    -- we vragen de bevestiging toch — vastleggen dat het bestuur ernaar gekeken
    -- heeft is nooit verkeerd.
    if not coalesce(p_board_approved, false) then
      raise exception 'Uitkeringstest (art. 2:216 lid 2 BW): het bestuur moet bevestigen dat de vennootschap haar opeisbare schulden ook ná de uitkering kan blijven betalen. Zonder die goedkeuring heeft het besluit geen gevolgen.'
        using errcode = '23514';
    end if;
  end if;

  -- ---- Boeken ------------------------------------------------------------
  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- De rekening waar de afsluiting het resultaat naartoe boekte; per boekjaar
  -- vastgelegd, zodat een latere wijziging van de instelling deze bestemming
  -- niet op een andere rekening laat aangrijpen.
  v_result_code := coalesce(
    v_fy.result_account_code,
    (select nullif(cs.year_result_account_code, '') from public.company_settings cs where cs.organization_id = p_organization_id),
    '0510'
  );

  v_result_account := public.bookkeeping_account_id(p_organization_id, v_result_code);
  v_reserves_account := public.bookkeeping_account_id(p_organization_id, v_reserves_code);

  -- De rekeningcodes komen van de aanroeper. bookkeeping_account_id controleert
  -- alleen dát de rekening bestaat, dus hier de soort erbij: een reserve is
  -- eigen vermogen en een dividendschuld is vreemd vermogen. Zonder deze check
  -- kan een besluit op een omzet- of kostenrekening landen en verdwijnt het
  -- resultaat opnieuw in de W&V.
  select la.type into v_account_type from public.ledger_accounts la where la.id = v_reserves_account;
  if v_account_type <> 'equity' then
    raise exception 'Rekening % is geen eigen-vermogensrekening; een resultaatbestemming gaat naar de reserves.', v_reserves_code
      using errcode = '23514';
  end if;
  -- De resultaatrekening zelf is óók eigen vermogen en zou de typecheck dus
  -- passeren. Debet én credit op dezelfde rekening is een sluitende nulboeking:
  -- het besluit lijkt vastgelegd, maar het resultaat staat nog onbestemd op
  -- 0510 en het boekjaar zit wél op slot.
  if v_reserves_account = v_result_account then
    raise exception 'De reserverekening mag niet dezelfde zijn als de resultaatrekening (%).', v_result_code
      using errcode = '23514';
  end if;

  if v_result > 0 then
    -- Winst: 0510 leegboeken (debet) tegen reserves en/of dividend (credit).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', 'Bestemming resultaat ' || v_fy.label,
      'debit_cents', v_result, 'credit_cents', 0));

    if v_reserves > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_reserves_account,
        'description', 'Toevoeging aan de reserves ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_reserves));
    end if;

    if v_dividend > 0 then
      v_dividend_account := public.bookkeeping_account_id(p_organization_id, v_dividend_code);
      select la.type into v_account_type from public.ledger_accounts la where la.id = v_dividend_account;
      if v_account_type <> 'liability' then
        raise exception 'Rekening % is geen schuldrekening; een dividendbesluit levert een schuld aan de aandeelhouder op.', v_dividend_code
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_dividend_account,
        'description', 'Dividenduitkering ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_dividend));
    end if;
  else
    -- Verlies: 0510 leegboeken (credit) ten laste van de reserves (debet).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', 'Bestemming resultaat ' || v_fy.label,
      'debit_cents', 0, 'credit_cents', -v_result));
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_reserves_account,
      'description', 'Verlies ten laste van de reserves ' || v_fy.label,
      'debit_cents', -v_result, 'credit_cents', 0));
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, p_decision_date,
    'Resultaatbestemming ' || v_fy.label,
    'result_appropriation', p_fiscal_year_id, v_lines, p_created_by
  );

  insert into public.result_appropriations(
    organization_id, fiscal_year_id, created_by, decision_date,
    result_cents, reserves_cents, dividend_cents,
    reserves_account_code, dividend_account_code,
    distributable_cents, board_approved, board_approved_by, board_approved_at,
    journal_entry_id, status, note
  ) values (
    p_organization_id, p_fiscal_year_id, p_created_by, p_decision_date,
    v_result, v_reserves, v_dividend,
    v_reserves_code, case when v_dividend > 0 then v_dividend_code else null end,
    v_distributable,
    coalesce(p_board_approved, false),
    case when coalesce(p_board_approved, false) then p_created_by end,
    case when coalesce(p_board_approved, false) then now() end,
    v_entry.id, 'posted', nullif(btrim(p_note), '')
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.opening_balance_plug_account(p_organization_id uuid)
 RETURNS TABLE(code text, name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
begin
  if auth.role() <> 'service_role' and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if public.org_fiscal_regime(p_organization_id) = 'vpb' then
    return query
      select la.code, la.name
      from public.ledger_accounts la
      where la.organization_id = p_organization_id and la.code in ('0520', '0510', '0500')
      order by array_position(array['0520','0510','0500'], la.code)
      limit 1;
  else
    return query
      select la.code, la.name
      from public.ledger_accounts la
      where la.organization_id = p_organization_id and la.code = '0500'
      limit 1;
  end if;
end;
$$;

create or replace function public.preview_next_invoice_number(p_organization_id uuid, p_invoice_date date DEFAULT CURRENT_DATE)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_year integer := extract(year from coalesce(p_invoice_date, current_date))::integer;
  v_sequence public.organization_invoice_number_sequences;
  v_number integer;
  v_invoice_number text;
begin
  if not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  perform public.reconcile_invoice_number_sequence(p_organization_id, v_year);

  select * into v_sequence
  from public.organization_invoice_number_sequences
  where organization_id = p_organization_id and invoice_year = v_year;

  if not found then
    return public.format_invoice_number('FAC', v_year, 1, 4);
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_invoice_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.invoices i
    where i.organization_id = p_organization_id
      and upper(btrim(i.number)) = upper(btrim(v_invoice_number))
  ) loop
    v_number := v_number + 1;
    v_invoice_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);
  end loop;

  return v_invoice_number;
end;
$$;

create or replace function public.create_client_with_next_code(p_organization_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_client public.clients;
  v_user_id uuid := auth.uid();
  v_status text := coalesce(nullif(btrim(p_payload ->> 'status'), ''), 'active');
  v_color text := coalesce(nullif(btrim(p_payload ->> 'color'), ''), '#FFD966');
  v_client_kind text := coalesce(nullif(btrim(p_payload ->> 'client_kind'), ''), 'business');
  v_value_eur numeric(12,2) := 0;
  v_tags text[] := '{}';
  v_custom_fields jsonb := '{}'::jsonb;
  v_e_invoicing boolean := coalesce(nullif(btrim(p_payload ->> 'e_invoicing_enabled'), '')::boolean, false);
  v_e_invoice_channel text := coalesce(nullif(btrim(p_payload ->> 'e_invoice_channel'), ''), 'email');
  v_client_code text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'clients')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if v_status not in ('active','prospect','inactive') then
    raise exception 'Ongeldige klantstatus.' using errcode = '23514';
  end if;

  if v_client_kind not in ('business','consumer') then
    raise exception 'Ongeldig klanttype.' using errcode = '23514';
  end if;

  if v_e_invoice_channel not in ('email','mollie') then
    raise exception 'Ongeldige manier van e-factureren (email of mollie).' using errcode = '23514';
  end if;

  if jsonb_typeof(p_payload -> 'tags') = 'array' then
    select coalesce(array_agg(nullif(btrim(value), '')) filter (where nullif(btrim(value), '') is not null), '{}')
      into v_tags
    from jsonb_array_elements_text(p_payload -> 'tags') as tags(value);
  end if;

  if nullif(p_payload ->> 'value_eur', '') is not null then
    v_value_eur := (p_payload ->> 'value_eur')::numeric(12,2);
  end if;

  -- Vrije velden. De validatietrigger op clients normaliseert en keurt af;
  -- hier alleen doorgeven zodat ze niet stilzwijgend verdwijnen bij aanmaken.
  if jsonb_typeof(p_payload -> 'custom_fields') = 'object' then
    v_custom_fields := p_payload -> 'custom_fields';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('clients_duplicate_guard'));
  v_client_code := public.allocate_next_client_code(p_organization_id);

  perform set_config('resofly.client_code_generated', 'true', true);

  insert into public.clients(
    organization_id,
    created_by,
    name,
    client_code,
    contact_name,
    email,
    phone,
    notes,
    color,
    status,
    client_kind,
    tags,
    value_eur,
    follow_up,
    vat_number,
    kvk_number,
    address_line1,
    address_line2,
    postal_code,
    city,
    country,
    custom_fields,
    e_invoicing_enabled,
    e_invoice_email,
    e_invoice_channel
  ) values (
    p_organization_id,
    v_user_id,
    btrim(coalesce(p_payload ->> 'name', '')),
    v_client_code,
    nullif(btrim(p_payload ->> 'contact_name'), ''),
    nullif(lower(btrim(p_payload ->> 'email')), ''),
    nullif(btrim(p_payload ->> 'phone'), ''),
    nullif(btrim(p_payload ->> 'notes'), ''),
    v_color,
    v_status,
    v_client_kind,
    v_tags,
    v_value_eur,
    nullif(p_payload ->> 'follow_up', '')::date,
    nullif(btrim(p_payload ->> 'vat_number'), ''),
    nullif(btrim(p_payload ->> 'kvk_number'), ''),
    nullif(btrim(p_payload ->> 'address_line1'), ''),
    nullif(btrim(p_payload ->> 'address_line2'), ''),
    nullif(btrim(p_payload ->> 'postal_code'), ''),
    nullif(btrim(p_payload ->> 'city'), ''),
    nullif(btrim(p_payload ->> 'country'), ''),
    v_custom_fields,
    v_e_invoicing,
    nullif(lower(btrim(p_payload ->> 'e_invoice_email')), ''),
    v_e_invoice_channel
  )
  returning * into v_client;

  return v_client;
end;
$$;

create or replace function public.chat_start_dm(p_organization_id uuid, p_other_user uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_me uuid := auth.uid();
  v_key text;
  v_conv uuid;
begin
  if v_me is null then raise exception 'chat: niet ingelogd'; end if;
  if p_other_user is null or p_other_user = v_me then raise exception 'chat: ongeldige gebruiker'; end if;

  -- Beide moeten actief lid zijn van dezelfde organisatie.
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = v_me and m.status = 'active'
  ) then raise exception 'chat: geen toegang tot organisatie'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_other_user and m.status = 'active'
  ) then raise exception 'chat: ander lid niet gevonden in organisatie'; end if;
  -- Teamchat moet voor beiden openstaan, en wie begint moet mogen schrijven
  -- (zoals bij een groep of kanaal).
  if not public.can_write_module(p_organization_id, 'chat') then
    raise exception 'chat: je mag niets wijzigen in de module Teamchat' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_other_user and m.status = 'active'
      and public.member_module_level(m.role, m.module_access, 'chat') <> 'none'
  ) then raise exception 'chat: dit teamlid heeft geen toegang tot Teamchat'; end if;

  v_key := case when v_me < p_other_user
                then v_me::text || ':' || p_other_user::text
                else p_other_user::text || ':' || v_me::text end;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext(v_key));

  select id into v_conv from public.chat_conversations
    where organization_id = p_organization_id and dm_key = v_key limit 1;
  if v_conv is not null then return v_conv; end if;

  insert into public.chat_conversations (organization_id, kind, dm_key, created_by)
    values (p_organization_id, 'dm', v_key, v_me)
    returning id into v_conv;
  insert into public.chat_participants (conversation_id, organization_id, user_id, role)
    values (v_conv, p_organization_id, v_me, 'member'),
           (v_conv, p_organization_id, p_other_user, 'member')
    on conflict do nothing;
  return v_conv;
end;
$$;

-- ── Rechten: ongewijzigd voor ingelogde gebruikers en de service-role, dicht voor anon ──

revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) from public, anon;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) to authenticated, service_role;
revoke all on function public.book_dga_interest(uuid, integer, uuid) from public, anon;
grant execute on function public.book_dga_interest(uuid, integer, uuid) to authenticated, service_role;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) from public, anon;
grant execute on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) to authenticated, service_role;
revoke all on function public.compute_icp_declaration(uuid, date, date) from public, anon;
grant execute on function public.compute_icp_declaration(uuid, date, date) to authenticated, service_role;
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) from public, anon;
grant execute on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) to authenticated, service_role;
revoke all on function public.reverse_result_appropriation(uuid, uuid, uuid) from public, anon;
grant execute on function public.reverse_result_appropriation(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.convert_accepted_quote_to_invoice(uuid, uuid) from public, anon;
grant execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) to authenticated, service_role;
revoke all on function public.appropriate_result(uuid, uuid, date, bigint, bigint, boolean, text, text, text, uuid) from public, anon;
grant execute on function public.appropriate_result(uuid, uuid, date, bigint, bigint, boolean, text, text, text, uuid) to authenticated, service_role;
revoke all on function public.opening_balance_plug_account(uuid) from public, anon;
grant execute on function public.opening_balance_plug_account(uuid) to authenticated, service_role;
revoke all on function public.preview_next_invoice_number(uuid, date) from public, anon;
grant execute on function public.preview_next_invoice_number(uuid, date) to authenticated, service_role;
revoke all on function public.create_client_with_next_code(uuid, jsonb) from public, anon;
grant execute on function public.create_client_with_next_code(uuid, jsonb) to authenticated, service_role;
revoke all on function public.chat_start_dm(uuid, uuid) from public, anon;
grant execute on function public.chat_start_dm(uuid, uuid) to authenticated, service_role;

commit;
