-- ============================================================================
-- Rond middernacht telt de database in Nederlandse tijd
-- ============================================================================
-- De database draait in UTC. `current_date` en `<tijdstip>::date` lopen daardoor
-- in de winter een uur en in de zomer twee uur achter op de Nederlandse dag.
-- De controle van de jaarwissel (22 november 2026) liet zien wat dat doet:
--
-- - Een Mollie-betaling van 1 januari 2027 om 00:30 werd op 31 december 2026
--   geboekt (`paid_at::date`): de balans per 31-12 toonde de debiteur als
--   betaald en het geld al op 1102. Hetzelfde bij een terugbetaling
--   (`refunded_at::date`).
-- - Het btw-tijdvak Q4 en het boekjaar afsluiten werd op 1 januari tussen 0:00
--   en 1:00 geweigerd met "Afsluiten kan vanaf 01-01-2027", terwijl het al
--   1 januari was.
-- - Afschrijven "tot en met het einde van dit jaar" rekende in dat uur nog met
--   het oude jaar.
--
-- `issue_credit_note`, `open_initial_fiscal_years` en de API rekenden al met
-- `(now() at time zone 'Europe/Amsterdam')::date`. Deze vijf functies nu ook.
-- Verder is er aan de functies niets veranderd: het zijn de laatste versies
-- (20260724100000, 20261119190000 en 20261119180000) met alleen die regels
-- anders. Zoek op "20261122140000".
--
-- Bestaande boekingen blijven staan zoals ze zijn: een geboekte betaling
-- verschuif je niet achteraf. Veilig om opnieuw te draaien.

CREATE OR REPLACE FUNCTION public.book_invoice_payment(p_organization_id uuid, p_payment_record_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pay public.invoice_payment_records;
  v_inv_je uuid;
  v_book_date date;
  v_lines jsonb;
  v_entry public.journal_entries;
begin
  select * into v_pay from public.invoice_payment_records
  where id = p_payment_record_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Betaalregistratie niet gevonden.' using errcode = '02000';
  end if;
  if v_pay.journal_entry_id is not null then
    return null;                                   -- al geboekt (idempotent)
  end if;
  if v_pay.status <> 'paid' or coalesce(v_pay.amount_cents, 0) <= 0 then
    return null;                                   -- niets te boeken
  end if;

  -- Zorg dat de bijbehorende factuur (en dus 1300) in het grootboek staat.
  v_inv_je := public.ensure_sales_invoice_booked(p_organization_id, v_pay.invoice_id, p_created_by);
  if v_inv_je is null then
    -- Factuur (nog) niet boekbaar (concept/vóór startdatum): geen debiteurenpost
    -- om tegen af te boeken. Laat de betaling ongeboekt; de UI signaleert dit.
    return null;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_book_date := public.first_open_booking_date(
    -- GEWIJZIGD (20261122140000): de Nederlandse dag van de betaling, niet de
    -- dag in UTC. Een betaling op 1 januari om 00:30 viel anders op 31 december.
    p_organization_id, coalesce((v_pay.paid_at at time zone 'Europe/Amsterdam')::date, (now() at time zone 'Europe/Amsterdam')::date));

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
      'description', 'Ontvangst via Mollie (onderweg)',
      'debit_cents', v_pay.amount_cents, 'credit_cents', 0),
    jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren afboeken (betaling)',
      'debit_cents', 0, 'credit_cents', v_pay.amount_cents)
  );

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Betaling factuur (Mollie)', 'payment', v_pay.invoice_id, v_lines, p_created_by);

  update public.invoice_payment_records set journal_entry_id = v_entry.id where id = v_pay.id;
  return v_entry;
end;
$function$;

revoke all on function public.book_invoice_payment(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.book_invoice_payment(uuid, uuid, uuid) to service_role;

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
  -- GEWIJZIGD (20261119190000): zonder teruggestort teveel (purpose
  -- 'overpayment'). Dat geld hoorde nooit bij de factuur: telde het mee, dan
  -- ging een dubbel betaalde factuur na het terugstorten op "Terugbetaald",
  -- alsof de verkoop was teruggedraaid.
  select coalesce(sum(amount_cents), 0) into v_refunded_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'refunded'
    and coalesce(metadata->>'purpose', '') <> 'overpayment';

  -- Per Mollie-betaalrecord het terugbetaalde deel bijwerken. Hier telt élke
  -- terugbetaling, ook die van een teveel: het gaat om wat er van die ene
  -- Mollie-betaling nog terug kan.
  update public.invoice_payment_records p
     set amount_refunded_cents = coalesce((
           select sum(r.amount_cents) from public.invoice_refunds r
           where r.payment_record_id = p.id and r.status = 'refunded'
         ), 0),
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id;

  -- Betaald bedrag: voorkeur voor de som van betaalde/terugbetaalde Mollie-records,
  -- val terug op het factuurtotaal (offline betaald zonder Mollie-record).
  -- GEWIJZIGD (20261105230000): een betaalde factuur is minstens het
  -- factuurbedrag betaald, ook als een deel per bank kwam. Eerder telde zodra
  -- er één Mollie-betaling was alleen het Mollie-deel: bij € 290 per bank en
  -- € 710 via Mollie weigerde een terugbetaling van € 1.000, en na € 710 stond
  -- de factuur op "terugbetaald" terwijl € 290 nooit terug was.
  select greatest(
           coalesce(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  -- TOEGEVOEGD (20261119190000): wat gecrediteerd is zonder terugbetaling, is
  -- nooit betaald (zie begin_invoice_refund). Is de rest volledig terugbetaald,
  -- dan is de factuur terugbetaald; anders bleef hij "gedeeltelijk terugbetaald"
  -- terwijl er niets meer terug kon.
  v_paid_cents := v_paid_cents - coalesce((
    select sum(round(cn.total_amount * 100)) from public.credit_notes cn
    where cn.invoice_id = p_invoice_id and cn.organization_id = p_organization_id
      and cn.status <> 'void' and cn.refund_id is null
  ), 0)::bigint;

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
  -- Ook voor een teruggestort teveel (20261119190000): het geld is van het
  -- Mollie-saldo af, en op 1300 valt het weg tegen de dubbele ontvangst.
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
      public.first_open_booking_date_for(p_organization_id,
        -- GEWIJZIGD (20261122140000): de Nederlandse dag van de terugbetaling.
        coalesce((v_rf.refunded_at at time zone 'Europe/Amsterdam')::date, (now() at time zone 'Europe/Amsterdam')::date), false),
      'Terugbetaling factuur ' || coalesce(v_invoice.number, ''),
      'payment', p_invoice_id, v_lines, null
    );
    update public.invoice_refunds set journal_entry_id = v_entry.id where id = v_rf.id;
  end loop;
end;
$function$;

revoke all on function public.recompute_invoice_refund_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recompute_invoice_refund_state(uuid, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.finalize_vat_return(p_organization_id uuid, p_period_type text, p_year integer, p_period_index integer, p_from date, p_to date, p_created_by uuid DEFAULT auth.uid())
 RETURNS vat_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ret public.vat_returns;
  v_rubrieken jsonb;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_expected_from date;
  v_expected_to date;
  v_existing_status text;
  v_frequency text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  -- GEWIJZIGD (20261104000000): de periode volgt uit soort, jaar en nummer.
  -- Andere datums gaven een tweede, willekeurig slot (tot en met de hele
  -- administratie) en overschreven de aangifte van die periode.
  if p_year is null or p_year < 2000 or p_year > 2100
     or p_period_index is null or p_period_index < 1
     or p_period_index > (case when p_period_type = 'month' then 12 else 4 end) then
    raise exception 'Ongeldige aangifteperiode.' using errcode = '23514';
  end if;
  v_expected_from := make_date(p_year, case when p_period_type = 'month' then p_period_index else (p_period_index - 1) * 3 + 1 end, 1);
  v_expected_to := (v_expected_from
    + case when p_period_type = 'month' then interval '1 month' else interval '3 months' end
    - interval '1 day')::date;
  if p_from is distinct from v_expected_from or p_to is distinct from v_expected_to then
    raise exception 'Deze aangifteperiode loopt van % t/m %; andere datums kunnen niet.',
      to_char(v_expected_from, 'DD-MM-YYYY'), to_char(v_expected_to, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261118090000): een tijdvak dat nog loopt, sluit je niet af.
  -- De pagina opent op het lopende kwartaal en de knop stond aan: wie op
  -- 17 november Q4 afsloot, zag een factuur van 15 december op 1 januari
  -- geboekt worden. Die omzet viel zo in het verkeerde jaar (de winst voor de
  -- inkomstenbelasting) en de btw een kwartaal te laat in de aangifte. De
  -- Belastingdienst neemt de aangifte ook pas na afloop van het tijdvak aan.
  -- GEWIJZIGD (20261122140000): "vandaag" is de Nederlandse dag. Op 1 januari
  -- tussen 0:00 en 1:00 stond hier anders "Afsluiten kan vanaf 01-01".
  if v_expected_to >= (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Dit tijdvak loopt nog tot en met %. Afsluiten kan vanaf %, net als de aangifte bij de Belastingdienst.',
      to_char(v_expected_to, 'DD-MM-YYYY'), to_char(v_expected_to + 1, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261118090000): alleen in de frequentie die bij Instellingen
  -- staat. Wie per kwartaal aangifte doet en toch januari afsloot, kon Q1 daarna
  -- niet meer afsluiten (overlap).
  -- GEWIJZIGD (20261118100000): of in de soort waarin dat jaar al aangifte is
  -- gedaan. Zet de Belastingdienst je per 1 januari op maandaangifte, dan zet
  -- je dat bij Instellingen om en doe je in januari nog de aangifte over Q4.
  -- Die weigerde 20261118090000: je moest de instelling heen en weer zetten.
  -- Een losse maand in een jaar dat per kwartaal gaat, blijft geweigerd.
  select coalesce(cs.vat_return_period, 'quarterly') into v_frequency
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_frequency := coalesce(v_frequency, 'quarterly');
  if (v_frequency = 'monthly') <> (p_period_type = 'month')
     and not exists (
       select 1 from public.vat_returns vr
       where vr.organization_id = p_organization_id
         and vr.supplements_return_id is null
         and vr.status <> 'draft'
         and vr.year = p_year
         and vr.period_type = p_period_type
     ) then
    raise exception 'Je doet btw-aangifte per % (Instellingen → Bedrijf), en in % deed je nog geen aangifte per %. Moet dit tijdvak toch per % (bijvoorbeeld het laatste tijdvak vóór een wissel), zet de instelling dan eerst om.',
      case when v_frequency = 'monthly' then 'maand' else 'kwartaal' end,
      p_year,
      case when p_period_type = 'month' then 'maand' else 'kwartaal' end,
      case when p_period_type = 'month' then 'maand' else 'kwartaal' end
      using errcode = '23514';
  end if;
  -- Exclusief: geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  -- Een afgesloten aangifte blijft staan; een correctie loopt via een suppletie.
  select status into v_existing_status
  from public.vat_returns
  where organization_id = p_organization_id
    and period_type = p_period_type and year = p_year and period_index = p_period_index
    and supplements_return_id is null;
  if v_existing_status is not null and v_existing_status <> 'draft' then
    raise exception 'De aangifte over deze periode is al afgesloten (%). Een correctie loopt via een suppletie.',
      case v_existing_status when 'finalized' then 'doorgeboekt' when 'filed' then 'ingediend' when 'paid' then 'betaald' else v_existing_status end
      using errcode = '23514';
  end if;

  -- Geen overlap met een ander btw-slot (bv. januari terwijl Q1 al dicht is,
  -- of na een wissel van kwartaal- naar maandaangifte).
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_start <= p_to and cp.period_end >= p_from
  ) then
    raise exception 'Deze periode valt (deels) in een al afgesloten btw-periode.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Eén aanroep = één statement = één consistente MVCC-momentopname: wat wordt
  -- doorgeboekt is exact wat in de bevroren rubrieken-snapshot komt.
  v_rubrieken := public.compute_vat_boxes(p_organization_id, p_from, p_to, null);
  v_clear_output := (v_rubrieken->>'clear_output')::bigint;
  v_clear_reverse := (v_rubrieken->>'clear_reverse')::bigint;
  v_clear_input := (v_rubrieken->>'clear_input')::bigint;
  v_saldo_afgerond := (v_rubrieken->>'saldo_afgerond')::bigint;
  v_afronding := (v_rubrieken->>'afronding_cents')::bigint;

  -- Doorboeking: BTW-rekeningen exact afsluiten naar 1530 (tekenvast — een
  -- negatief periodesaldo op een rekening wordt aan de andere kant geboekt).
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Afsluiten af te dragen BTW',
      'debit_cents', case when v_clear_output > 0 then v_clear_output else 0 end,
      'credit_cents', case when v_clear_output < 0 then -v_clear_output else 0 end));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Afsluiten verlegde/ICP BTW',
      'debit_cents', case when v_clear_reverse > 0 then v_clear_reverse else 0 end,
      'credit_cents', case when v_clear_reverse < 0 then -v_clear_reverse else 0 end));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Afsluiten voorbelasting',
      'debit_cents', case when v_clear_input < 0 then -v_clear_input else 0 end,
      'credit_cents', case when v_clear_input > 0 then v_clear_input else 0 end));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting (hele euro''s per rubriek)',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end
    ));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Afrondingsverschil BTW-aangifte (cent → hele euro''s)',
      'debit_cents', case when v_afronding < 0 then -v_afronding else 0 end,
      'credit_cents', case when v_afronding > 0 then v_afronding else 0 end
    ));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, p_to,
      -- GEWIJZIGD (20261119180000): "Btw-aangifte Q2 2026" in plaats van "BTW-aangifte
      -- doorboeken quarter 2-2026" (Engels in het Journaal).
      'Btw-aangifte ' || case when p_period_type = 'month'
                              then (array['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'])[p_period_index]
                              else 'Q' || p_period_index end || ' ' || p_year,
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
  on conflict (organization_id, period_type, year, period_index) where supplements_return_id is null do update
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
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  return v_ret;
end;
$function$;

revoke all on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) from public, anon;
grant execute on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.close_fiscal_year(p_organization_id uuid, p_fiscal_year_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_regime text;
  v_year_period text;
  v_partnership boolean := false;
  v_share_total integer := 0;
  v_capital uuid;
  s record;
  v_open_dep integer := 0;
  v_open_dep_names text;
  v_open_prepaid integer := 0;
  v_open_prepaid_names text;
  v_before text;
  v_open_bank integer := 0;
  v_start_date date;
  v_vat_left bigint := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer close/reopen per organisatie (voorkomt dubbele resultaatbestemming).
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));
  -- TOEGEVOEGD (20261104000000): exclusief op de boekingsgrendel, zodat er
  -- geen boeking meer in dit jaar valt tussen het optellen en het slot.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Dit boekjaar is al afgesloten.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een lopend boekjaar sluit je niet af; latere
  -- boekingen zouden anders naar het volgende jaar schuiven.
  -- GEWIJZIGD (20261122140000): "vandaag" is de Nederlandse dag.
  if v_fy.period_end >= (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Dit boekjaar loopt nog tot en met %; afsluiten kan vanaf de dag daarna.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Sequentiële volgorde: geen geboekte transacties vóór dit boekjaar die niet in
  -- een afgesloten jaar-slot vallen (dus het voorgaande boekjaar moet dicht zijn).
  -- GEWIJZIGD (20261119180000): een boekstuk en zijn tegenboeking die allebei vóór dit
  -- boekjaar liggen, vallen tegen elkaar weg en tellen niet. En de melding
  -- noemt wat er in de weg staat. Er stond alleen "sluit eerst het voorgaande
  -- boekjaar af", ook als dat jaar niet bestond: wie een boeking vóór zijn
  -- eerste boekjaar had (een activum van vóór de start), kwam er nooit meer
  -- uit, ook niet door alles tegen te boeken.
  select string_agg(x.label, ', ' order by x.date) into v_before
  from (
    select distinct je.id, je.date, coalesce(je.entry_number, 'boekstuk') || ' van ' || to_char(je.date, 'DD-MM-YYYY') as label
    from public.journal_entries je
    left join public.journal_entries rev on rev.id = je.reversed_by_entry_id
    left join public.journal_entries org on org.id = je.reverses_entry_id
    where je.organization_id = p_organization_id
      and je.status = 'posted'
      -- GEWIJZIGD (20261118090000): een beginbalans van vóór het eerste
      -- boekjaar (per 31-12) is geen boekjaar dat nog dicht moet.
      and je.source_type not in ('year_close', 'opening_balance')
      and je.date < v_fy.period_start
      and not (rev.id is not null and rev.status = 'posted' and rev.date < v_fy.period_start)
      and not (org.id is not null and org.status = 'posted' and org.date < v_fy.period_start)
      and exists (select 1 from public.journal_lines jl where jl.entry_id = je.id)
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
      )
    order by je.date
    limit 3
  ) x;
  if v_before is not null then
    raise exception 'Er staan boekingen vóór dit boekjaar die in geen afgesloten boekjaar vallen (%). Sluit eerst het boekjaar af waarin ze vallen. Horen ze er niet (een datum vóór de start van je boekhouding), boek ze dan tegen in het Journaal: de tegenboeking komt op dezelfde datum en dan tellen ze niet meer mee.',
      v_before using errcode = '23514';
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
    -- GEWIJZIGD (20261118100000): elke maand die het boekjaar overlapt, valt in
    -- een afgesloten aangifte: die van de maand zelf, of die van het hele
    -- kwartaal eromheen. Hier telde alleen de frequentie van nu. Wie per
    -- 1 januari per maand aangifte ging doen en dat bij Instellingen omzette,
    -- kreeg het jaar ervoor (per kwartaal aangegeven) zo nooit meer dicht.
    -- Alleen precies een kalendermaand of -kwartaal telt, zoals
    -- finalize_vat_return ze vastlegt; een maand telt niet voor zijn kwartaal.
    --
    -- De melding noemt het ontbrekende tijdvak zoals dat jaar aangegeven werd:
    -- alleen kwartalen of alleen maanden, en anders de frequentie van nu.
    select case
             when bool_or(cp.period_type = 'quarter') and not bool_or(cp.period_type = 'month') then 'quarterly'
             when bool_or(cp.period_type = 'month') and not bool_or(cp.period_type = 'quarter') then 'monthly'
           end
      into v_year_period
    from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_end >= v_fy.period_start and cp.period_start <= v_fy.period_end;
    v_year_period := coalesce(v_year_period, v_vat_period);

    v_cursor := date_trunc('month', v_fy.period_start)::date;
    while v_cursor <= v_fy.period_end loop
      if not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and (
            (cp.period_type = 'month'
              and cp.period_start = v_cursor
              and cp.period_end = (v_cursor + interval '1 month' - interval '1 day')::date)
            or (cp.period_type = 'quarter'
              and cp.period_start = date_trunc('quarter', v_cursor)::date
              and cp.period_end = (date_trunc('quarter', v_cursor) + interval '3 months' - interval '1 day')::date)
          )
      ) then
        v_p_start := date_trunc(case when v_year_period = 'monthly' then 'month' else 'quarter' end, v_cursor)::date;
        v_p_end := (v_p_start + case when v_year_period = 'monthly' then interval '1 month' else interval '3 months' end - interval '1 day')::date;
        raise exception 'Finaliseer eerst alle BTW-aangiften van dit boekjaar (ontbreekt de periode % t/m %).',
          to_char(v_p_start, 'DD-MM-YYYY'), to_char(v_p_end, 'DD-MM-YYYY')
          using errcode = '23514';
      end if;
      v_cursor := (v_cursor + interval '1 month')::date;
    end loop;
  end if;

  -- TOEGEVOEGD (20261118090000): afschrijvingen en termijnen van
  -- vooruitbetaalde kosten die in dit jaar vallen, horen erin vóór het slot.
  -- Daarna boekten ze stil op de eerste open dag van het volgende jaar: een
  -- laptop die t/m september was afgeschreven, kreeg oktober t/m december in
  -- het nieuwe jaar. De winst van beide jaren klopte dan niet.
  select count(*), string_agg(distinct fa.name, ', ')
    into v_open_dep, v_open_dep_names
  from public.asset_depreciations ad
  join public.fixed_assets fa on fa.id = ad.asset_id
  where ad.organization_id = p_organization_id
    and ad.status = 'scheduled'
    and ad.date <= v_fy.period_end
    and fa.acquisition_journal_entry_id is not null
    and fa.status <> 'disposed';
  if coalesce(v_open_dep, 0) > 0 then
    raise exception 'Er staan nog % afschrijvingstermijn(en) tot en met % klaar die niet geboekt zijn (%). Boek ze eerst bij Activa; anders komen ze in het volgende jaar en klopt de winst van beide jaren niet.',
      v_open_dep, to_char(v_fy.period_end, 'DD-MM-YYYY'), v_open_dep_names
      using errcode = '23514';
  end if;
  select count(*), string_agg(distinct pe.description, ', ')
    into v_open_prepaid, v_open_prepaid_names
  from public.prepaid_expense_releases pr
  join public.prepaid_expenses pe on pe.id = pr.prepaid_expense_id
  where pr.organization_id = p_organization_id
    and pr.status = 'scheduled'
    and pr.date <= v_fy.period_end
    and pe.start_journal_entry_id is not null;
  if coalesce(v_open_prepaid, 0) > 0 then
    raise exception 'Er staan nog % termijn(en) van vooruitbetaalde kosten tot en met % klaar die niet geboekt zijn (%). Boek ze eerst bij Vooruitbetaald; anders komen ze in het volgende jaar.',
      v_open_prepaid, to_char(v_fy.period_end, 'DD-MM-YYYY'), v_open_prepaid_names
      using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): bankmutaties uit dit jaar die nog niet geboekt zijn. Na
  -- het afsluiten komen ze op de eerste dag van het volgende jaar: de bank
  -- staat dan per 31 december anders dan op het afschrift, en kosten of omzet
  -- vallen in het verkeerde jaar. Afsluiten ging zonder één woord door.
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;
  select count(*) into v_open_bank
  from public.bank_transactions t
  where t.organization_id = p_organization_id
    and t.status in ('unmatched', 'suggested')
    and t.booking_date between greatest(v_fy.period_start, coalesce(v_start_date, v_fy.period_start)) and v_fy.period_end;
  if coalesce(v_open_bank, 0) > 0 then
    raise exception 'Er staan nog % bankmutatie(s) uit dit boekjaar bij Bank → Af te letteren die niet geboekt zijn. Boek ze eerst, of negeer wat er niet bij hoort; na het afsluiten komen ze in het volgende jaar terecht.',
      v_open_bank using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): met de KOR vraagt de jaarafsluiting geen btw-aangiften.
  -- Verlegde btw (een dienst uit het buitenland) geef je ook met de KOR aan en
  -- betaal je. Het jaar ging dicht met die schuld nog op 1520; daarna weigerde
  -- het tijdvak af te sluiten ("het boekjaar is afgesloten").
  if v_kor then
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_vat_left
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_fy.period_end
      and la.subtype in ('vat_output', 'vat_reverse');
    if v_vat_left <> 0 then
      raise exception 'Er staat nog € % btw die je moet aangeven (verlegde btw geef je ook met de KOR aan). Sluit bij Omzetbelasting eerst de tijdvakken van dit boekjaar af waarin die valt.',
        replace(to_char(v_vat_left / 100.0, 'FM999999990.00'), '.', ',') using errcode = '23514';
    end if;
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

  -- TOEGEVOEGD (20261104070000): bij een vof, maatschap of cv met vastgelegde
  -- vennoten is de winst van de vennoten. Het resultaat gaat dan naar hun
  -- kapitaalrekeningen, volgens de winstverdeling, tot op de cent sluitend.
  v_regime := public.org_fiscal_regime(p_organization_id);
  v_partnership := v_regime = 'ib'
    and public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
    and exists (
      select 1 from public.partnership_partners pp
      where pp.organization_id = p_organization_id and pp.is_active
    );

  if v_partnership then
    select coalesce(sum(pp.profit_share_basis_points), 0)::int into v_share_total
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active;
    if v_share_total <> 10000 then
      raise exception 'De winstverdeling van de vennoten telt op tot % procent; dat moet precies 100 procent zijn. Pas de verdeling aan bij Financiën → Vennoten.',
        replace(rtrim(to_char(v_share_total / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
    end if;

    if v_result_cents <> 0 then
      for s in select * from public.partnership_result_shares(p_organization_id, v_result_cents) loop
        if s.share_cents > 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', s.capital_account_id,
            'description', 'Winstaandeel ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', 0, 'credit_cents', s.share_cents));
        elsif s.share_cents < 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', s.capital_account_id,
            'description', 'Verliesaandeel ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', -s.share_cents, 'credit_cents', 0));
        end if;
      end loop;
    end if;
  elsif v_result_cents <> 0 then
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

  -- Het privé van elke vennoot (ook een vertrokken vennoot) gaat naar zijn
  -- eigen kapitaal.
  -- GEWIJZIGD (20261118130000): altijd, niet alleen bij een vof, maatschap of
  -- cv met actieve vennoten. Werd de rechtsvorm eenmanszaak, of stond elke
  -- vennoot op uitgetreden, dan bleven 055n en 056n open staan en schoven ze
  -- mee naar het volgende jaar. Het privé hoort bij de vennoot, welke
  -- rechtsvorm de administratie nu ook heeft; het resultaat volgt die wel.
  for s in
    select pp.name, pp.capital_account_id, acc.account_id, acc.label,
           (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
            from public.journal_lines jl
            join public.journal_entries je on je.id = jl.entry_id
            where jl.organization_id = p_organization_id
              and je.status = 'posted'
              and je.date <= v_fy.period_end
              and jl.account_id = acc.account_id)::bigint as bal
    from public.partnership_partners pp
    cross join lateral (values
      (pp.withdrawals_account_id, 'Privé-opnamen'),
      (pp.contributions_account_id, 'Privé-stortingen')
    ) as acc(account_id, label)
    where pp.organization_id = p_organization_id
    order by pp.partner_number, acc.label
  loop
    if s.bal <> 0 then
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', s.account_id,
          'description', s.label || ' ' || s.name || ' naar kapitaal',
          'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
        jsonb_build_object('account_id', s.capital_account_id,
          'description', s.label || ' ' || s.name || ' boekjaar ' || v_fy.label,
          'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
    end if;
  end loop;

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen van een
  -- IB-onderneming (0550/0560, herkend aan het subtype) gaan naar het eigen
  -- vermogen. Bij een vof met vennoten staat hier alleen wat niet op de
  -- privérekening van een vennoot is geboekt; dat komt op 0500 en blijft in
  -- het overzicht als "nog niet aan een vennoot toegewezen" zichtbaar.
  if v_regime = 'ib' then
    v_capital := public.bookkeeping_account_id(p_organization_id, '0500');
    for s in
      select la.id as account_id, la.name,
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from public.journal_lines jl
              join public.journal_entries je on je.id = jl.entry_id
              where jl.organization_id = p_organization_id
                and je.status = 'posted'
                and je.date <= v_fy.period_end
                and jl.account_id = la.id)::bigint as bal
      from public.ledger_accounts la
      where la.organization_id = p_organization_id
        and la.subtype in ('private_withdrawals', 'private_contributions')
      order by la.code
    loop
      if s.bal <> 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', s.account_id,
            'description', s.name || ' naar eigen vermogen',
            'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
          jsonb_build_object('account_id', v_capital,
            'description', s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
      end if;
    end loop;
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
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  update public.fiscal_years
  set status = 'closed', close_journal_entry_id = v_entry.id,
      result_account_code = case when v_partnership then 'vennoten' else v_result_code end,
      result_cents = v_result_cents,
      closed_at = now(), closed_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$function$;

revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_asset_depreciation(p_organization_id uuid, p_asset_id uuid, p_through_date date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_remaining integer;
  v_book_date date;
  v_start_date date;
  v_year_end date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  -- De aanschaf moet op de balans staan (debet 0100) voordat er wordt afgeschreven,
  -- anders zou 0150 gecrediteerd worden zonder tegenpost → negatieve netto-activa.
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'Boek eerst de aanschaf van dit activum naar het grootboek voordat je afschrijft.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een afgestoten activum staat niet meer op de
  -- balans; afschrijven zou 0150 crediteren zonder activum erachter.
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten; er valt niets meer op af te schrijven.' using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): niet jaren vooruit. "Boek t/m 31-10-2062" (een tikfout)
  -- boekte in één keer alle zestig termijnen tot in 2030 en zette het activum
  -- op volledig afgeschreven: zestig losse tegenboekingen om te herstellen.
  -- GEWIJZIGD (20261122140000): "dit jaar" is het Nederlandse jaar.
  v_year_end := make_date(extract(year from (now() at time zone 'Europe/Amsterdam')::date)::int, 12, 31);
  if p_through_date is null or p_through_date > v_year_end then
    raise exception 'Afschrijven kan tot en met het einde van dit jaar (%). Latere termijnen boek je als het zover is.',
      to_char(v_year_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): termijnen van vóór de start van de boekhouding zitten in
  -- de cumulatieve afschrijving van de beginbalans. Ze krijgen geen boeking
  -- (die viel in een jaar zonder boekjaar en hield het afsluiten tegen), maar
  -- tellen wel als afgeschreven, zodat de boekwaarde klopt.
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start_date is not null then
    update public.asset_depreciations
    set status = 'posted', posted_at = now(), journal_entry_id = null
    where asset_id = p_asset_id and status = 'scheduled' and date < v_start_date;
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
    -- Nagekomen afschrijving in een al afgesloten periode → eerstvolgende open datum.
    -- GEWIJZIGD (20261104000000): een afschrijving raakt geen btw-rubriek en
    -- schuift dus alleen over een afgesloten boekjaar heen, niet over een btw-slot.
    v_book_date := public.first_open_booking_date_for(p_organization_id, r.date, public.journal_lines_touch_vat(p_organization_id, v_lines));
    v_entry := public.post_journal_entry(
      p_organization_id, v_book_date,
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
$function$;

revoke all on function public.post_asset_depreciation(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.post_asset_depreciation(uuid, uuid, date, uuid) to authenticated, service_role;
