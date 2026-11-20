-- Verkoopfacturen herstellen: crediteren van wat openstaat, terugbetalen met
-- een benoemde reden, en een paar kleine weigeringen met een eigen melding.
--
-- Aanleiding: de controle van de financiële module voor zzp'ers (verkoop en
-- debiteuren, bevindingen VK1, VK2, VK9 en VK10). Zie
-- docs/changelog/CHANGELOG_FINANCIEN_HERSTELWEGEN_2026-11-19.md.
--
-- Wat hier verandert:
--   1. begin_invoice_refund: een terugbetaling van te veel of dubbel betaald
--      geld (metadata.purpose = 'overpayment') is geen terugbetaling van de
--      factuur. Hij telt niet mee in de grens "hoogstens wat er betaald is" en
--      krijgt een eigen regel in de historie. De meldingen noemen euro's en
--      een weg die werkt.
--   2. recompute_invoice_refund_state: zo'n terugbetaling telt niet mee in
--      "terugbetaald" en zet de factuur niet op Terugbetaald.
--   3. issue_credit_note: de datum is de Nederlandse dag, niet de UTC-dag.
--   4. enforce_invoice_cancel_after_credit en
--      enforce_invoice_paid_needs_payment: de meldingen wijzen naar Crediteren
--      voor wat openstaat (dat kan nu ook bij een deels betaalde factuur).
--   5. enforce_invoice_lines_numeric: bij het uitgeven hoort het btw-tarief
--      van een regel bij zijn btw-code.
--   6. begin_invoice_email_send: één verzending tegelijk per factuur.
--   7. Een klant met verstuurde facturen verwijderen: een eigen melding.
--
-- Veilig om opnieuw te draaien: create or replace en drop … if exists.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Terugbetaling: te veel betaald is iets anders dan een verkoop die vervalt
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Er was één soort terugbetaling, met een vinkje "creditfactuur aanmaken".
--   - Zonder vinkje ging een volledig terugbetaalde factuur op "Terugbetaald"
--     terwijl omzet en btw bleven staan; een creditnota kon er daarna niet
--     meer bij (de grens "hoogstens wat er betaald is" was al op).
--   - Mét vinkje bij een dubbele betaling werd terechte omzet weggeboekt:
--     € 605 twee keer ontvangen, € 605 teruggestort met creditfactuur, en de
--     omzet van de opdracht stond op € 0.
-- Nu zegt de aanroeper waarom hij terugbetaalt (metadata.purpose):
--   - 'sale'         de verkoop gaat (deels) niet door: creditfactuur, en de
--                    terugbetaling telt bij de factuur (zoals het was);
--   - 'overpayment'  de klant betaalde te veel of dubbel: alleen geld terug.
--                    De factuur blijft betaald en houdt zijn omzet en btw.
create or replace function public.begin_invoice_refund(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_amount_cents integer, p_reason text default null::text, p_kind text default 'manual'::text, p_payment_record_id uuid default null::uuid, p_idempotency_key text default null::text, p_metadata jsonb default '{}'::jsonb)
 returns public.invoice_refunds
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice public.invoices;
  v_paid_cents bigint;
  v_already_cents bigint;
  v_kind text := case when p_kind in ('manual','mollie') then p_kind else 'manual' end;
  v_refund public.invoice_refunds;
  v_amount_eur text;
  -- TOEGEVOEGD (20261119190000): te veel of dubbel betaald geld terugstorten.
  v_overpayment boolean := coalesce(p_metadata->>'purpose', '') = 'overpayment';
  v_payment_cents bigint;
  v_payment_refunded_cents bigint;
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

  -- GEWIJZIGD (20261119190000): de melding zegt welke weg wel werkt. Er stond
  -- "Alleen betaalde facturen kunnen worden terugbetaald", terwijl Crediteren
  -- bij een deels betaalde factuur juist naar Terugbetaling verwees.
  if v_invoice.status not in ('paid','refunded') then
    raise exception 'Factuur % is niet betaald; terugbetalen kan pas bij een betaalde factuur. Wil je laten vervallen wat nog openstaat, kies dan "Crediteren" bij de factuur.',
      coalesce(v_invoice.number, '') using errcode = '23514';
  end if;

  -- Idempotency: dezelfde sleutel mag nooit twee terugbetalingen maken.
  if p_idempotency_key is not null then
    select * into v_refund from public.invoice_refunds
     where organization_id = p_organization_id
       and invoice_id = p_invoice_id
       and idempotency_key = p_idempotency_key;
    if found then return v_refund; end if;
  end if;

  if v_overpayment then
    -- TOEGEVOEGD (20261119190000): te veel betaald geld hangt niet aan het
    -- factuurbedrag (bij een dubbele betaling is het precies dat bedrag nog
    -- eens), dus de grens hieronder geldt niet. Via Mollie kan er wel nooit
    -- meer terug dan er op die ene Mollie-betaling binnenkwam.
    if v_kind = 'mollie' and p_payment_record_id is not null then
      select coalesce(amount_cents, 0) into v_payment_cents
        from public.invoice_payment_records
       where id = p_payment_record_id and organization_id = p_organization_id and invoice_id = p_invoice_id;
      select coalesce(sum(amount_cents), 0) into v_payment_refunded_cents
        from public.invoice_refunds
       where payment_record_id = p_payment_record_id and organization_id = p_organization_id
         and status in ('queued','pending','processing','refunded');
      if p_amount_cents::bigint + v_payment_refunded_cents > coalesce(v_payment_cents, 0) then
        raise exception 'Via Mollie kan er hoogstens € % terug: zoveel staat er nog op die Mollie-betaling.',
          replace(to_char(greatest(coalesce(v_payment_cents, 0) - v_payment_refunded_cents, 0) / 100.0, 'FM999999990.00'), '.', ',')
          using errcode = '23514';
      end if;
    end if;
  else
    -- Betaald bedrag bepalen (zelfde logica als recompute).
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

    -- TOEGEVOEGD (20261104020000): geld dat via een chargeback al terug is bij
    -- de klant, kan niet nog eens worden terugbetaald.
    v_paid_cents := v_paid_cents - coalesce((
      select sum(cb.amount_cents) from public.invoice_chargebacks cb
      where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
        and cb.status = 'charged_back'
    ), 0);

    -- TOEGEVOEGD (20261119190000): wat gecrediteerd is zonder terugbetaling
    -- (Crediteren van wat openstond), is nooit betaald en kan dus ook niet
    -- terug. Een factuur van € 1.210 met € 400 betaald en € 810 gecrediteerd
    -- staat op betaald; zonder deze regel mocht er € 1.210 terug.
    v_paid_cents := v_paid_cents - coalesce((
      select sum(round(cn.total_amount * 100)) from public.credit_notes cn
      where cn.invoice_id = p_invoice_id and cn.organization_id = p_organization_id
        and cn.status <> 'void' and cn.refund_id is null
    ), 0)::bigint;

    -- Reeds terugbetaald of in behandeling (voorkomt dubbel/over-terugbetalen).
    -- GEWIJZIGD (20261119190000): zonder het teruggestorte teveel; dat is geen
    -- terugbetaling van de factuur.
    select coalesce(sum(amount_cents), 0) into v_already_cents
    from public.invoice_refunds
    where invoice_id = p_invoice_id and organization_id = p_organization_id
      and status in ('queued','pending','processing','refunded')
      and coalesce(metadata->>'purpose', '') <> 'overpayment';

    -- GEWIJZIGD (20261119190000): in euro's en met het factuurnummer. Er stond
    -- "Terugbetaalbedrag (131900 cent) overschrijdt het resterende betaalde
    -- bedrag (119800 cent)."
    if p_amount_cents::bigint + v_already_cents > v_paid_cents then
      raise exception 'Op factuur % kun je nog hoogstens € % terugbetalen; € % is meer dan er betaald en nog niet terugbetaald is. Betaalde de klant te veel of dubbel, kies dan bij Terugbetaling "De klant betaalde te veel of dubbel".',
        coalesce(v_invoice.number, ''),
        replace(to_char(greatest(v_paid_cents - v_already_cents, 0) / 100.0, 'FM999999990.00'), '.', ','),
        replace(to_char(p_amount_cents / 100.0, 'FM999999990.00'), '.', ',')
        using errcode = '23514';
    end if;
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
    -- GEWIJZIGD (20261119190000): de historie zegt welke van de twee het was.
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'payment_refunded',
      case when v_overpayment then 'Te veel betaald teruggestort' else 'Terugbetaling geregistreerd' end,
      case when v_overpayment
        then 'Te veel of dubbel betaald: ' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur
             || ' teruggestort. De factuur blijft betaald; omzet en btw veranderen niet.'
        else 'Handmatige terugbetaling van ' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur
      end,
      jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind,
                         'purpose', case when v_overpayment then 'overpayment' else 'sale' end),
      p_actor_user_id
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, p_actor_user_id, 'invoice_refunded', 'invoice', p_invoice_id, v_invoice.number,
            jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind,
                               'purpose', case when v_overpayment then 'overpayment' else 'sale' end));
  end if;

  return v_refund;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. De stand van de factuur na een terugbetaling
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.recompute_invoice_refund_state(p_invoice_id uuid, p_organization_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
      public.first_open_booking_date_for(p_organization_id, coalesce(v_rf.refunded_at::date, current_date), false),
      'Terugbetaling factuur ' || coalesce(v_invoice.number, ''),
      'payment', p_invoice_id, v_lines, null
    );
    update public.invoice_refunds set journal_entry_id = v_entry.id where id = v_rf.id;
  end loop;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Creditnota: de datum van vandaag in Nederland
-- ═══════════════════════════════════════════════════════════════════════════
--
-- current_date is de UTC-dag. Een creditnota die tussen middernacht en 01:00
-- (winter) of 02:00 (zomer) werd gemaakt, kreeg de datum van gisteren. Op
-- 1 januari of de eerste dag van een kwartaal kwam hij daarmee in het vorige
-- jaar of tijdvak terecht, en uit de nummerreeks van het vorige jaar.
create or replace function public.issue_credit_note(p_organization_id uuid, p_invoice_id uuid, p_refund_id uuid, p_actor_user_id uuid, p_reason text, p_currency text, p_subtotal numeric, p_vat numeric, p_total numeric, p_lines jsonb, p_pdf_file_name text default null::text, p_pdf_mime_type text default null::text, p_pdf_size_bytes integer default null::integer, p_pdf_sha256 text default null::text, p_pdf_data_base64 text default null::text, p_pdf_storage_provider text default null::text, p_pdf_storage_key text default null::text)
 returns public.credit_notes
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice public.invoices;
  v_credit_note public.credit_notes;
  v_number text;
  v_credited numeric;
  -- GEWIJZIGD (20261119190000): de Nederlandse dag in plaats van current_date (UTC).
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht voor een creditfactuur.' using errcode = '23514';
  end if;

  select * into v_invoice from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id
   for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

  -- Eén creditnota per terugbetaling: een tweede webhook of herhaalde poging
  -- krijgt de bestaande terug.
  if p_refund_id is not null then
    select cn.* into v_credit_note from public.credit_notes cn
     where cn.organization_id = p_organization_id and cn.refund_id = p_refund_id and cn.status <> 'void'
     order by cn.created_at
     limit 1;
    if found then return v_credit_note; end if;
  end if;

  select coalesce(sum(cn.total_amount), 0) into v_credited
    from public.credit_notes cn
   where cn.organization_id = p_organization_id and cn.invoice_id = p_invoice_id and cn.status <> 'void';
  if v_credited + round(coalesce(p_total, 0), 2) > coalesce(v_invoice.total_amount, 0) + 0.005 then
    raise exception 'Op factuur % is al € % gecrediteerd; met deze creditfactuur van € % wordt dat meer dan het factuurbedrag van € %.',
      coalesce(v_invoice.number, ''),
      replace(to_char(v_credited, 'FM999999990.00'), '.', ','),
      replace(to_char(round(coalesce(p_total, 0), 2), 'FM999999990.00'), '.', ','),
      replace(to_char(coalesce(v_invoice.total_amount, 0), 'FM999999990.00'), '.', ',')
      using errcode = '23514';
  end if;

  v_number := public.allocate_next_credit_note_number(p_organization_id, v_today);

  insert into public.credit_notes(
    organization_id, invoice_id, refund_id, number, date, reason, currency,
    subtotal_amount, vat_amount, total_amount, lines, status,
    pdf_file_name, pdf_mime_type, pdf_size_bytes, pdf_sha256, pdf_data_base64,
    pdf_storage_provider, pdf_storage_key, issued_by
  ) values (
    p_organization_id, p_invoice_id, p_refund_id, v_number, v_today,
    nullif(btrim(coalesce(p_reason, '')), ''), coalesce(nullif(p_currency, ''), 'EUR'),
    round(coalesce(p_subtotal, 0), 2), round(coalesce(p_vat, 0), 2), round(coalesce(p_total, 0), 2),
    coalesce(p_lines, '[]'::jsonb), 'issued',
    p_pdf_file_name, coalesce(nullif(p_pdf_mime_type, ''), 'application/pdf'), p_pdf_size_bytes, p_pdf_sha256,
    p_pdf_data_base64, p_pdf_storage_provider, p_pdf_storage_key, p_actor_user_id
  ) returning * into v_credit_note;

  if p_refund_id is not null then
    update public.invoice_refunds
       set credit_note_id = v_credit_note.id, updated_at = now()
     where id = p_refund_id and organization_id = p_organization_id;
  end if;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'credit_note_issued',
    'Creditfactuur aangemaakt',
    'Creditfactuur ' || v_number || ' voor factuur ' || coalesce(v_invoice.number, ''),
    jsonb_build_object('credit_note_id', v_credit_note.id, 'refund_id', p_refund_id, 'number', v_number, 'total_amount', v_credit_note.total_amount),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'credit_note_issued', 'credit_note', v_credit_note.id, v_number,
          jsonb_build_object('invoice_id', p_invoice_id, 'refund_id', p_refund_id, 'total_amount', v_credit_note.total_amount));

  return v_credit_note;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Status met de hand: de meldingen wijzen naar een weg die werkt
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Een deels betaalde factuur liep dood: "Crediteren" weigerde ("al deels
-- betaald; verwerk het restant met een terugbetaling of een memoriaalpost"),
-- "Terugbetaling" weigerde ("alleen betaalde facturen"), en een memoriaalpost
-- liet de factuur open staan. Crediteren gaat nu over wat nog openstaat
-- (invoice-workflow, actie creditInvoice); deze meldingen zeggen dat ook.
create or replace function public.enforce_invoice_cancel_after_credit()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_open bigint;
  v_booked bigint;
  v_credited bigint;
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;
  if new.status is distinct from old.status
     and new.status in ('cancelled', 'void', 'written_off')
     and old.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_checked(old.id);
    if coalesce(v_open, 0) > 0 then
      -- GEWIJZIGD (20261119190000): met het bedrag, en met de weg voor een
      -- factuur die niet meer betaald wordt (afboeken zonder mail aan de klant).
      raise exception 'Deze factuur staat in het grootboek (omzet en btw zijn geboekt) en er staat nog € % open. Annuleren of afboeken gaat met een creditnota: kies "Crediteren" bij de factuur. Is de factuur oninbaar, kies daar dan "Afboeken als oninbaar"; dan krijgt de klant geen creditfactuur.',
        replace(to_char(v_open / 100.0, 'FM999999990.00'), '.', ',')
        using errcode = '23514';
    end if;
    -- TOEGEVOEGD (20261106130000): niets open door een betaling is iets anders
    -- dan niets open door een creditnota.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_booked
      from public.journal_entries je
      join public.journal_lines jl on jl.entry_id = je.id
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
     where je.id = old.journal_entry_id and je.status = 'posted'
       and je.reversed_by_entry_id is null and je.reverses_entry_id is null;
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_credited
      from public.credit_notes cn
      join public.journal_entries je on je.id = cn.journal_entry_id and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
      join public.journal_lines jl on jl.entry_id = je.id
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
     where cn.organization_id = old.organization_id and cn.invoice_id = old.id;
    if v_booked > 0 and v_credited < v_booked then
      -- GEWIJZIGD (20261119190000): "(deels) betaald" klopte niet meer; wie
      -- hier komt, heeft een factuur waarop niets meer openstaat.
      raise exception 'Op deze factuur staat niets meer open: wat niet is gecrediteerd, is betaald. Omzet en btw van het betaalde deel zijn geboekt en blijven staan. Gaat ook dat deel niet door, kies dan "Terugbetaling" bij de factuur; daar komt de creditfactuur vandaan.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.enforce_invoice_paid_needs_payment()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_open bigint;
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;
  if new.status = 'paid' and old.status is distinct from 'paid' and new.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_checked(new.id);
    if coalesce(v_open, 0) > 0 then
      -- GEWIJZIGD (20261119190000): ook de weg voor wie de rest niet meer krijgt.
      raise exception 'Factuur % staat in het grootboek en er staat nog € % open. Leg de ontvangst vast bij Bank (Mutatie invoeren, en verdeel hem op deze factuur); contant ontvangen gaat net zo, op een kasrekening. Dan gaat de factuur vanzelf op betaald. Komt de rest niet meer binnen, kies dan "Crediteren" bij de factuur: de creditfactuur gaat over wat nog openstaat.',
        coalesce(new.number, ''), replace(to_char(v_open / 100.0, 'FM999999990.00'), '.', ',')
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Bij het uitgeven hoort het btw-tarief van een regel bij zijn btw-code
-- ═══════════════════════════════════════════════════════════════════════════
--
-- De code bepaalt de rubriek van de aangifte, het tarief het bedrag. Via
-- Gerrie of de API kon een regel met code HOOG en 0% de deur uit (omzet in
-- rubriek 1a zonder btw), of code ICP_DIENST met 21% (btw gerekend op een
-- verlegde dienst, in rubriek 3b). Het formulier in de app zet ze altijd
-- samen; hier weigert de database wat daarbuiten ontstaat.
--
-- Alleen bij het uitgeven (nieuw, of vanuit concept): een concept mag
-- onaf zijn, en een verstuurde factuur ligt al vast. Alleen voor een code die
-- deze organisatie kent (ook een eigen code, en ook een die op inactief
-- staat); een onbekende code heeft geen tarief om mee te vergelijken. Met de
-- KOR is elke regel 0% met code KOR (enforce_invoice_kor_no_vat, die eerder
-- afgaat): dat klopt met het tarief van die code.
create or replace function public.enforce_invoice_lines_numeric()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_bad text;
  v_rate numeric;
  -- TOEGEVOEGD (20261119190000)
  v_lines_changed boolean := tg_op = 'INSERT' or new.lines is distinct from old.lines;
  v_issuing boolean := new.status not in ('draft', 'cancelled', 'void')
    and (tg_op = 'INSERT' or old.status = 'draft');
  v_code text;
  v_code_rate numeric;
begin
  -- GEWIJZIGD (20261119190000): de trigger gaat nu ook af op een statuswijziging
  -- (voor de controle bij het uitgeven); is er niets te controleren, dan klaar.
  if not v_lines_changed and not v_issuing then return new; end if;
  if new.lines is null then return new; end if;
  if jsonb_typeof(new.lines) <> 'array' then
    raise exception 'Factuurregels moeten een lijst zijn.' using errcode = '22023';
  end if;
  if v_lines_changed then
    select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)') into v_bad
      from jsonb_array_elements(new.lines) l
     where exists (
       select 1
         from (values (l->'quantity'), (l->'unit_price'), (l->'vat')) as v(x)
        where x is not null
          and jsonb_typeof(x) not in ('null', 'number')
          and not (jsonb_typeof(x) = 'string' and (x #>> '{}' = '' or x #>> '{}' ~ '^-?[0-9]+(\.[0-9]+)?$'))
     )
     limit 1;
    if v_bad is not null then
      raise exception 'Regel "%" heeft een aantal, prijs of btw-tarief dat geen getal is. Gebruik cijfers, met een punt als decimaalteken.', left(v_bad, 80)
        using errcode = '22023';
    end if;
    -- TOEGEVOEGD (20261106110000): een btw-tarief van 150% of -21% ging zo het
    -- grootboek in (1510 en de aangifte). Het hoogste tarief in de EU is 27%.
    select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)'), (l->>'vat')::numeric
      into v_bad, v_rate
      from jsonb_array_elements(new.lines) l
     where nullif(l->>'vat', '') is not null
       and ((l->>'vat')::numeric < 0 or (l->>'vat')::numeric > 30)
     limit 1;
    if v_bad is not null then
      -- Het procentteken gaat mee in de waarde: in een RAISE-tekst is %% een
      -- letterlijk procentteken en % de plek voor een waarde.
      raise exception 'Regel "%" heeft een btw-tarief van %. Een btw-tarief ligt tussen 0 en 30%% (het hoogste in de EU is 27%%).', left(v_bad, 80), trim_scale(v_rate)::text || '%'
        using errcode = '22023';
    end if;
  end if;

  -- TOEGEVOEGD (20261119190000): tarief en code horen bij elkaar. Een tarief
  -- dat geen getal is (een concept van vóór 6 november) telt als 0.
  if v_issuing then
    v_bad := null;
    select coalesce(nullif(btrim(l.line->>'description'), ''), '(zonder omschrijving)'), vc.code, vc.rate, l.rate
      into v_bad, v_code, v_code_rate, v_rate
      from (
        select x as line,
               case when coalesce(x->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (x->>'vat')::numeric else 0 end as rate
          from jsonb_array_elements(new.lines) x
      ) l
      join public.vat_codes vc
        on vc.organization_id = new.organization_id
       and vc.code = nullif(btrim(coalesce(l.line->>'vat_code', '')), '')
     where vc.rate is distinct from l.rate
     limit 1;
    if v_bad is not null then
      raise exception 'Regel "%" heeft btw-code % maar een btw-tarief van %. Bij die code hoort %. Kies de btw van die regel opnieuw, of kies een andere code.',
        left(v_bad, 80), v_code, trim_scale(v_rate)::text || '%', trim_scale(v_code_rate)::text || '%'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$function$;

-- De trigger ging alleen af bij een wijziging van de regels. Uitgeven is een
-- wijziging van de status; die hoort er nu bij.
drop trigger if exists invoices_lines_numeric on public.invoices;
create trigger invoices_lines_numeric
  before insert or update of lines, status on public.invoices
  for each row execute function public.enforce_invoice_lines_numeric();

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Eén verzending tegelijk per factuur
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Twee keer klikken op "Verstuur" (of twee tabbladen, of de knop en Gerrie
-- tegelijk) gaf de klant twee keer dezelfde factuur. De factuur zelf werd wel
-- één keer geboekt. Net als bij contracten (20261106130000) weigert de tweede
-- poging zolang de eerste loopt. Een poging die bleef hangen (de functie viel
-- om tussen klaarzetten en afronden) telt na drie minuten niet meer: langer
-- duurt een aanroep niet.
create or replace function public.begin_invoice_email_send(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text default null::text, p_attachment_mime_type text default 'application/pdf'::text, p_attachment_size_bytes integer default null::integer, p_attachment_sha256 text default null::text, p_attachment_data_base64 text default null::text, p_attachment_storage_provider text default null::text, p_attachment_storage_key text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
  v_public_token text;
  v_link public.invoice_public_links;
  v_job public.finance_provider_jobs;
  v_storage_provider text := nullif(btrim(coalesce(p_attachment_storage_provider, '')), '');
  v_storage_key text := nullif(btrim(coalesce(p_attachment_storage_key, '')), '');
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Betaalde, terugbetaalde, geannuleerde of afgeboekte facturen kunnen niet opnieuw worden verstuurd.' using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119190000): één verzending tegelijk. Het slot op de
  -- factuur hierboven zet twee gelijktijdige pogingen achter elkaar; de tweede
  -- ziet hier de verzendregel van de eerste.
  if exists (
    select 1 from public.invoice_email_deliveries d
    where d.invoice_id = p_invoice_id and d.organization_id = p_organization_id
      and d.delivery_kind = 'invoice'
      and d.status = 'queued' and d.created_at > now() - interval '3 minutes'
  ) then
    raise exception 'Factuur % wordt op dit moment al verstuurd. Wacht even en kijk bij de factuur of hij is verzonden; zo krijgt je klant hem niet twee keer.',
      coalesce(v_invoice.number, '') using errcode = '23514';
  end if;

  v_public_token := substring(coalesce(p_public_url, '') from '/invoice/([^?/#]+)');
  if v_public_token is null or public.invoice_token_hash(v_public_token) <> p_token_hash then
    raise exception 'Publieke factuurlink en token-hash komen niet overeen.' using errcode = '23514';
  end if;

  if p_attachment_file_name is null or p_attachment_size_bytes is null or p_attachment_size_bytes <= 0 or p_attachment_sha256 is null then
    raise exception 'Factuurmail vereist een echte PDF-snapshot met bestandsnaam, grootte en SHA-256 hash.' using errcode = '23514';
  end if;

  if v_storage_provider = 'r2' and v_storage_key is null then
    raise exception 'R2 PDF storage provider vereist een storage key.' using errcode = '23514';
  end if;

  if v_storage_provider is null and nullif(btrim(coalesce(p_attachment_data_base64, '')), '') is null then
    raise exception 'PDF-snapshot moet in private storage of als database-fallback worden vastgelegd.' using errcode = '23514';
  end if;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, lower(nullif(btrim(coalesce(p_attachment_sha256, '')), '')),
    jsonb_strip_nulls(jsonb_build_object(
      'publicUrl', p_public_url,
      'attachmentDataBase64', p_attachment_data_base64,
      'attachmentStorageProvider', v_storage_provider,
      'attachmentStorageKey', v_storage_key
    ))
  ) returning * into v_delivery;

  v_link := public.create_invoice_public_link(
    p_invoice_id,
    p_organization_id,
    v_public_token,
    'email',
    p_token_expires_at,
    v_delivery.id,
    null,
    p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url)
  );

  insert into public.finance_provider_jobs(organization_id, entity_type, entity_id, provider, job_type, status, idempotency_key, request_payload)
  values (p_organization_id, 'email', v_delivery.id, 'resend', 'send_invoice_email', 'queued', 'invoice-email-' || v_delivery.id::text, jsonb_build_object('invoice_id', p_invoice_id, 'recipient_email', lower(btrim(p_recipient_email)), 'public_link_id', v_link.id))
  on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
    set updated_at = now()
  returning * into v_job;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id, 'publicLinkId', v_link.id, 'providerJobId', v_job.id);
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Een klant met verstuurde facturen verwijderen: een eigen melding
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Het verwijderen werd al geweigerd, maar door de factuur: de koppeling met de
-- klant zou leeg worden, en een verstuurde factuur ligt vast. De gebruiker las
-- dan bij het wissen van een klant "Deze factuur is al naar het grootboek
-- geboekt en is onveranderbaar. Maak een creditnota om te corrigeren.": de
-- melding van een ander scherm, met een advies dat hier niets oplost. Nu
-- weigert de klant zelf, vóór de factuur aan bod komt, en zegt wat wel kan.
-- Een klant met alleen concepten kan nog steeds weg (het concept blijft, zonder
-- klant).
create or replace function public.client_block_delete_with_issued_invoices()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  -- Security definer: ook wie Financiën niet mag lezen, krijgt deze melding
  -- (en niet die van de factuur, die hij niet eens ziet).
  select count(*) into v_count
    from public.invoices i
   where i.organization_id = old.organization_id
     and i.client_id = old.id
     and (coalesce(i.status, 'draft') <> 'draft' or i.journal_entry_id is not null);
  if v_count > 0 then
    raise exception 'Klant % heeft % en kan niet weg: die vallen onder de bewaarplicht en horen bij deze klant te blijven. Zet de klant op inactief; dan staat hij niet meer tussen je actieve klanten.',
      coalesce(old.name, ''),
      case when v_count = 1 then 'een verstuurde factuur' else v_count::text || ' verstuurde facturen' end
      using errcode = '23514';
  end if;
  return old;
end;
$function$;

drop trigger if exists clients_block_delete_with_invoices on public.clients;
create trigger clients_block_delete_with_invoices
  before delete on public.clients
  for each row execute function public.client_block_delete_with_issued_invoices();

-- ═══════════════════════════════════════════════════════════════════════════
-- Rechten: zoals ze stonden (alleen de server roept deze functies aan)
-- ═══════════════════════════════════════════════════════════════════════════
revoke all on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) to service_role;
revoke all on function public.recompute_invoice_refund_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recompute_invoice_refund_state(uuid, uuid) to service_role;
revoke all on function public.issue_credit_note(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, jsonb, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.issue_credit_note(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, jsonb, text, text, integer, text, text, text, text) to service_role;
revoke all on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamp with time zone, text, text, text, text, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamp with time zone, text, text, text, text, text, text, integer, text, text, text, text) to service_role;
revoke all on function public.enforce_invoice_cancel_after_credit() from public, anon, authenticated;
revoke all on function public.enforce_invoice_paid_needs_payment() from public, anon, authenticated;
revoke all on function public.enforce_invoice_lines_numeric() from public, anon, authenticated;
revoke all on function public.client_block_delete_with_issued_invoices() from public, anon, authenticated;
