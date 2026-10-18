-- ============================================================
-- ResoFly — Bank: de koppeling loopt vanzelf
-- Date: 2026-10-18
-- Bron: ENABLEBANKING_BOEKINGEN_ONDERZOEK_2026-10-18.md (§6, blok 2.2–2.4)
--
--  1  EIGEN GROOTBOEKREKENING PER BANKREKENING. Een gekoppelde bank kwam altijd
--     op 1100 terecht; met een betaal- én spaarrekening deelden ze die rekening,
--     en dan kan de saldo-aansluiting per rekening niet (het paneel weigert dan
--     terecht een getal). assign_own_bank_ledger_account() geeft een rekening
--     die zijn grootboekrekening deelt met een rekening met een ander IBAN een
--     eigen 11x0-rekening — alleen zolang er nog niets op geboekt is en er op
--     de gedeelde rekening niets anders staat dan bankboekingen (een
--     beginbalans valt niet te verdelen), want verhangen zou de historie
--     splitsen. bank-sync roept hem aan bij het koppelen; bestaande gekoppelde
--     rekeningen krijgen hem hieronder (sectie 5).
--
--  2  OVERBOEKING TUSSEN EIGEN REKENINGEN. Geld van de betaalrekening naar de
--     spaarrekening komt twee keer binnen: −X op de ene, +X op de andere. Wie
--     beide kanten op de grootboekrekening van de ándere bank boekt, telt het
--     dubbel. De matcher herkent nu dat de tegenrekening zelf een (actieve)
--     bankrekening van de organisatie is en stelt 1190 Kruisposten
--     bankrekeningen voor: beide kanten daarop geboekt valt samen weg. Dit gaat
--     vóór de factuurherkenning: een eigen IBAN is een sterker signaal dan een
--     getal in de omschrijving.
--
--  3  bank_accounts_due_for_sync(): welke gekoppelde rekeningen de geplande
--     sync nu mag ophalen — toestemming geldig, niet in een wachttijd na een
--     fout, langst niet geprobeerd eerst, en ruim binnen de PSD2-grens: zonder
--     dat de gebruiker erbij is, mag een rekening maximaal vier keer per 24 uur
--     worden opgevraagd, en een sync vraagt transacties én saldo op.
--     Standaard dus elke twaalf uur.
--
--  4  BESLISLIJST: 'bank_consent_expiring'. Een toestemming verloopt stil; daarna
--     komt er niets meer binnen en merkt niemand het tot de aansluiting niet
--     klopt. De veegronde zet twee weken vooraf een kaart klaar (en houdt hem
--     zolang de toestemming verlopen is en nog niet vervangen); de kaart vervalt
--     zodra de rekeningen aan een nieuwe toestemming hangen.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. Wat de sync per rekening bijhoudt (na review):
--    sync_through       t/m deze boekdatum staat alles vast: opgehaald, en toen
--                       al meer dan een week oud (banken boeken soms tot een week
--                       met een eerdere datum na). Een sync begint de dag erna,
--                       in stukken, en legt na elk stuk vast hoe ver hij is;
--                       wordt hij afgekapt, dan gaat de volgende daar verder.
--    sync_slice_days    hoe groot die stukken zijn (leeg: 30 dagen). Past één
--                       stuk niet in de tijd, dan de volgende keer de helft
--                       (anders begon een trage rekening steeds opnieuw aan
--                       hetzelfde stuk); lukt een hele sync, dan weer groter.
--    sync_attempted_at  de laatste poging, gelukt of niet. De geplande ronde
--                       neemt de langst niet geprobeerde rekening eerst, zodat
--                       één trage of falende rekening de rest niet verdringt.
--    sync_failures, sync_retry_after
--                       mislukt: niet elk uur opnieuw, maar met toenemende
--                       wachttijd (en na een 429 een halve dag).
--    sync_error, sync_error_kind
--                       de laatste fout, voor de gebruiker; een probleem met één
--                       rekening hoort bij die rekening, niet bij de toestemming.
-- ------------------------------------------------------------
alter table public.bank_accounts
  add column if not exists sync_through date,
  add column if not exists sync_slice_days smallint
    check (sync_slice_days is null or sync_slice_days between 1 and 30),
  add column if not exists sync_attempted_at timestamptz,
  add column if not exists sync_failures integer not null default 0,
  add column if not exists sync_retry_after timestamptz,
  add column if not exists sync_error text,
  add column if not exists sync_error_kind text;

-- ------------------------------------------------------------
-- 1. Eigen grootboekrekening per bankrekening
-- ------------------------------------------------------------
create or replace function public.assign_own_bank_ledger_account(
  p_organization_id uuid,
  p_bank_account_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ba public.bank_accounts;
  v_iban text;
  v_code text;
  v_name text;
  v_id uuid;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Eén tegelijk per organisatie: twee gelijktijdige aanroepen kozen anders
  -- dezelfde vrije code, en de tweede liep vast op de unieke sleutel.
  perform pg_advisory_xact_lock(hashtext('bank-ledger-codes:' || p_organization_id::text));

  select * into v_ba from public.bank_accounts
  where id = p_bank_account_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_iban := upper(replace(coalesce(v_ba.iban, ''), ' ', ''));

  -- Wie deelt de grootboekrekening? Een inactieve rekening waar nooit iets op
  -- is geboekt, telt niet mee: die heeft geen historie die kan verschuiven.
  -- Heeft hij hem al voor zich alleen, dan is er niets te doen.
  if not exists (
    select 1 from public.bank_accounts o
    where o.organization_id = p_organization_id and o.id <> v_ba.id and o.ledger_account_id = v_ba.ledger_account_id
      and (o.is_active or exists (select 1 from public.bank_transactions t where t.bank_account_id = o.id and t.status = 'booked'))
  ) then
    return v_ba.ledger_account_id;
  end if;
  -- Alleen splitsen als zeker is dat het om een ANDERE rekening gaat: elke
  -- rekening die meedeelt moet een bekend, ander IBAN hebben. Dezelfde IBAN is
  -- dezelfde rekening (bv. eerst afschriften ingelezen, later gekoppeld): die
  -- hoort op dezelfde grootboekrekening te blijven.
  if v_iban = '' or exists (
    select 1 from public.bank_accounts o
    where o.organization_id = p_organization_id and o.id <> v_ba.id and o.ledger_account_id = v_ba.ledger_account_id
      and (o.is_active or exists (select 1 from public.bank_transactions t where t.bank_account_id = o.id and t.status = 'booked'))
      and upper(replace(coalesce(o.iban, ''), ' ', '')) in ('', v_iban)
  ) then
    return v_ba.ledger_account_id;
  end if;
  -- Al geboekt op de gedeelde rekening: verhangen zou de historie splitsen.
  if exists (select 1 from public.bank_transactions t where t.bank_account_id = v_ba.id and t.status = 'booked') then
    return v_ba.ledger_account_id;
  end if;
  -- Staat er op de gedeelde rekening ook iets anders dan bankboekingen (een
  -- beginbalans, een memoriaal), dan valt niet te zeggen welk deel bij deze
  -- rekening hoort: na het verhangen klopte de aansluiting dan bij geen van
  -- beide. Laat dat aan de gebruiker (Bewerk → grootboekrekening).
  if exists (
    select 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where jl.account_id = v_ba.ledger_account_id and jl.organization_id = p_organization_id
      and je.status = 'posted' and je.source_type <> 'payment'
  ) then
    return v_ba.ledger_account_id;
  end if;

  -- Eerste vrije code: 1110 … 1180, daarna 1101 … 1109 (1102 is Mollie, 1190 kruisposten).
  select c into v_code
  from unnest(array['1110','1120','1130','1140','1150','1160','1170','1180',
                    '1101','1103','1104','1105','1106','1107','1108','1109']) with ordinality as t(c, n)
  where not exists (select 1 from public.ledger_accounts la where la.organization_id = p_organization_id and la.code = t.c)
  order by n
  limit 1;
  if v_code is null then
    return v_ba.ledger_account_id;  -- alles bezet: blijft gedeeld, het aansluitpaneel legt uit waarom
  end if;

  -- "Bank Zakelijke rekening 4567": de naam van de rekening plus de laatste vier
  -- cijfers, tenzij die al in de naam staan.
  v_name := left(concat_ws(' ', 'Bank', nullif(btrim(v_ba.name), ''),
            case when position(right(v_iban, 4) in coalesce(v_ba.name, '')) = 0 then right(v_iban, 4) end), 120);
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values (p_organization_id, v_code, v_name, 'asset', 'bank', null, false, 'liquide_middelen')
  returning id into v_id;

  update public.bank_accounts set ledger_account_id = v_id, updated_at = now() where id = v_ba.id;
  return v_id;
end;
$$;

-- 1190 Kruisposten bankrekeningen: bestaat hij niet, dan wordt hij aangemaakt.
-- Eigen subtype, zodat niets hem voor "de" bankrekening aanziet.
create or replace function public.bank_clearing_account_id(p_organization_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select id into v_id from public.ledger_accounts
  where organization_id = p_organization_id and subtype = 'bank_clearing'
  order by code limit 1;
  if v_id is not null then
    return v_id;
  end if;

  select c into v_code
  from unnest(array['1190','1195','1199']) with ordinality as t(c, n)
  where not exists (select 1 from public.ledger_accounts la where la.organization_id = p_organization_id and la.code = t.c)
  order by n
  limit 1;
  if v_code is null then
    return null;  -- geen vrije code: geen voorstel, de transactie blijft gewoon open
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values (p_organization_id, v_code, 'Kruisposten bankrekeningen', 'asset', 'bank_clearing', null, true, 'liquide_middelen')
  on conflict (organization_id, code) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.ledger_accounts where organization_id = p_organization_id and code = v_code;
  end if;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 2. match_bank_transactions
--    (Basis: 20261018000000, verder 1-op-1. Nieuw: overboeking tussen eigen
--    rekeningen.)
-- ------------------------------------------------------------
create or replace function public.match_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_inv_id uuid;
  v_pi_id uuid;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_haystack text;
  v_iban text;
  v_clearing uuid;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      and status = 'unmatched'
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
    order by booking_date
  loop
    -- Opnieuw lezen mét lock: de lijst hierboven is een momentopname.
    select * into v_txn from public.bank_transactions
    where id = v_txn.id and status = 'unmatched'
    for update skip locked;
    if not found then
      continue;
    end if;

    v_inv_id := null; v_pi_id := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    -- Overboeking tussen eigen rekeningen: de tegenrekening is een andere, actieve
    -- bankrekening van deze organisatie. Beide kanten komen binnen en vallen op de
    -- kruispostenrekening tegen elkaar weg. Vóór de factuurherkenning: een eigen
    -- IBAN zegt meer dan een getal in de omschrijving. Maar niet als de gebruiker
    -- zelf een regel voor die IBAN heeft: die gaat voor (ook automatisch boeken).
    if v_iban <> '' and exists (
      select 1 from public.bank_accounts ob
      where ob.organization_id = p_organization_id
        and ob.id <> v_txn.bank_account_id
        and ob.is_active
        and upper(replace(coalesce(ob.iban, ''), ' ', '')) = v_iban
    ) and not exists (
      select 1 from public.bank_rules br
      where br.organization_id = p_organization_id
        and br.is_active
        and br.match_counterparty_iban is not null
        and upper(replace(br.match_counterparty_iban, ' ', '')) = v_iban
    ) then
      v_clearing := public.bank_clearing_account_id(p_organization_id);
      if v_clearing is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_clearing,
            suggested_vat_code = null,
            match_confidence = 'own_transfer',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
        continue;
      end if;
    end if;

    if v_txn.amount_cents > 0 then
      -- Ontvangst: verkoopfactuur op factuurnummer in omschrijving/kenmerk. Alleen
      -- geboekte facturen waar dit bedrag nog in past (meer dan het openstaande
      -- saldo weigert book_bank_transaction; één overboeking voor meerdere
      -- facturen vraagt om splitsen). Het nummerfilter gaat vóór de
      -- saldoberekening, die dus alleen voor echte kandidaten draait.
      select i.id into v_inv_id
      from public.invoices i
      cross join lateral public.invoice_settlement(p_organization_id, i.id) s
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
        and s.open_cents >= abs(v_txn.amount_cents)
      order by
        (case when s.open_cents = abs(v_txn.amount_cents) then 0
              when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 1
              else 2 end),
        i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: inkoopfactuur op intern/leveranciers-nummer, alleen geboekt en open.
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      cross join lateral public.purchase_invoice_settlement(p_organization_id, pi.id) s
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        and (
          (pi.internal_number is not null and position(lower(replace(pi.internal_number,' ','')) in v_haystack) > 0)
          or (pi.supplier_invoice_number is not null and position(lower(replace(pi.supplier_invoice_number,' ','')) in v_haystack) > 0)
        )
        and s.open_cents >= abs(v_txn.amount_cents)
      order by
        (case when s.open_cents = abs(v_txn.amount_cents) then 0
              when pi.total_cents = abs(v_txn.amount_cents) then 1
              else 2 end),
        pi.date desc
      limit 1;
    end if;

    if v_inv_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_invoice_id = v_inv_id, match_confidence = 'invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;
    if v_pi_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_purchase_invoice_id = v_pi_id, match_confidence = 'purchase_invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Regels op prioriteit; eerste match wint.
    select * into v_rule
    from public.bank_rules r
    where r.organization_id = p_organization_id
      and r.is_active
      and (r.match_direction = 'both'
           or (r.match_direction = 'in' and v_txn.amount_cents > 0)
           or (r.match_direction = 'out' and v_txn.amount_cents < 0))
      and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = v_iban)
      and (r.match_counterparty_name_contains is null or coalesce(v_txn.counterparty_name,'') ilike '%' || r.match_counterparty_name_contains || '%')
      and (r.match_description_contains is null or coalesce(v_txn.description,'') ilike '%' || r.match_description_contains || '%')
      and (r.match_amount_cents is null or r.match_amount_cents = abs(v_txn.amount_cents))
    order by r.priority, r.created_at
    limit 1;

    if v_rule.id is not null then
      if v_rule.auto_book and v_rule.target_account_id is not null then
        begin
          perform public.book_bank_transaction(
            p_organization_id, v_txn.id,
            jsonb_build_array(jsonb_build_object(
              'account_id', v_rule.target_account_id,
              'amount_cents', abs(v_txn.amount_cents),
              'vat_code', v_rule.target_vat_code,
              'description', v_rule.name
            )),
            null, null, p_created_by
          );
          v_auto := v_auto + 1;
        exception when others then
          -- Automatisch boeken mislukt (bv. afgesloten periode): zet als voorstel klaar
          -- i.p.v. de hele import/match terug te draaien.
          update public.bank_transactions
          set status = 'suggested',
              suggested_account_id = v_rule.target_account_id,
              suggested_vat_code = v_rule.target_vat_code,
              matched_rule_id = v_rule.id,
              match_confidence = 'rule',
              updated_at = now()
          where id = v_txn.id;
          v_suggested := v_suggested + 1;
        end;
      else
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_rule.target_account_id,
            suggested_vat_code = v_rule.target_vat_code,
            matched_rule_id = v_rule.id,
            match_confidence = 'rule',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
      continue;
    end if;

    -- Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    -- omzetbelasting voor. NL86INGB0002445588 is de inningsrekening; teruggaven komen
    -- binnen onder tegenpartijnaam "Belastingdienst".
    if v_iban = 'NL86INGB0002445588'
       or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%' then
      update public.bank_transactions
      set status = 'suggested',
          suggested_account_id = public.bookkeeping_account_id(p_organization_id, '1530'),
          suggested_vat_code = null,
          match_confidence = 'tax_authority',
          updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Geen regel: bij een betaling de leverancier op IBAN voorstellen.
    if v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_sup.default_expense_account_id,
            suggested_vat_code = v_sup.default_vat_code,
            match_confidence = 'supplier_iban',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('suggested', v_suggested, 'auto_booked', v_auto);
end;
$$;

-- ------------------------------------------------------------
-- 3. Welke rekeningen de geplande sync nu mag ophalen
-- ------------------------------------------------------------
create or replace function public.bank_accounts_due_for_sync(
  p_min_interval interval default interval '12 hours',
  p_limit integer default 200
)
returns table (bank_account_id uuid, organization_id uuid, last_synced_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select ba.id, ba.organization_id, ba.last_synced_at
  from public.bank_accounts ba
  join public.bank_requisitions br on br.id = ba.bank_requisition_id
  where ba.source = 'enablebanking'
    and ba.is_active
    and ba.external_account_id is not null
    and br.status = 'linked'
    and (br.expires_at is null or br.expires_at > now())
    and (ba.last_synced_at is null or ba.last_synced_at < now() - p_min_interval)
    and (ba.sync_retry_after is null or ba.sync_retry_after <= now())
  -- De langst niet GEPROBEERDE eerst (niet de langst niet gelukte): een rekening
  -- die elke keer afgekapt wordt of faalt, schuift zo achteraan.
  order by ba.sync_attempted_at nulls first, ba.last_synced_at nulls first, ba.id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- ------------------------------------------------------------
-- 4. Beslislijst: 'bank_consent_expiring'
--    (Basis van de drie functies: 20260914000000; alleen het bankstuk is nieuw.)
-- ------------------------------------------------------------
create or replace function public.ai_signal_kinds()
returns text[]
language sql
immutable
as $$
  select array[
    'quote_opened_unanswered',
    'quote_expiring',
    'contract_unsigned',
    'inbound_mail',
    'mail_unmatched',
    'meeting_notes_ready',
    'meeting_notes_unsent',
    'gallery_favorites_chosen',
    'bank_consent_expiring'
  ]::text[];
$$;

create or replace function public.collect_time_signals(p_org uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.ai_signal_settings%rowtype;
  r record;
  n int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag de veegronde draaien.' using errcode = '42501';
  end if;
  select * into v_settings from public.ai_signal_settings where organization_id = p_org;
  if not found or not v_settings.enabled then return 0; end if;

  -- Offerte verloopt binnen drie dagen en de klant heeft nog niet gereageerd.
  for r in
    select q.id, q.number, q.client_id, q.valid_until
      from public.quotes q
     where q.organization_id = p_org and q.status = 'sent'
       and q.valid_until is not null
       and q.valid_until between current_date and current_date + 3
  loop
    if public.ai_signal_enqueue(p_org, 'quote_expiring', 'quote:' || r.id::text || ':expiring', 'quote', r.id, r.client_id,
         jsonb_build_object('quote_id', r.id, 'quote_number', r.number, 'valid_until', r.valid_until), now()) is not null then n := n + 1; end if;
  end loop;

  -- Notulen klaar maar na een etmaal nog niet gemaild.
  for r in
    select m.id, m.event_title_snapshot, m.client_id, m.project_id, m.updated_at
      from public.meeting_recordings m
     where m.organization_id = p_org and m.status = 'done'
       and m.summary_text is not null and m.summary_sent_at is null
       and m.updated_at < now() - interval '24 hours'
       and m.created_at > now() - interval '30 days'
  loop
    if public.ai_signal_enqueue(p_org, 'meeting_notes_unsent', 'meeting:' || r.id::text || ':unsent', 'meeting_recording', r.id, r.client_id,
         jsonb_build_object('recording_id', r.id, 'title', r.event_title_snapshot, 'project_id', r.project_id, 'done_at', r.updated_at), now()) is not null then n := n + 1; end if;
  end loop;

  -- Banktoestemming verloopt binnen twee weken, is al verlopen, of is door de
  -- bank ingetrokken (status expired terwijl de datum nog ver weg is): daarna
  -- komt er niets meer binnen. Alleen zolang er een actieve rekening aan hangt —
  -- na opnieuw koppelen hangen de rekeningen aan de nieuwe.
  for r in
    select br.id, br.institution_name, br.expires_at
      from public.bank_requisitions br
     where br.organization_id = p_org and br.status in ('linked', 'expired')
       and (br.status = 'expired' or (br.expires_at is not null and br.expires_at < now() + interval '14 days'))
       and (br.expires_at is null or br.expires_at > now() - interval '30 days')
       and exists (select 1 from public.bank_accounts ba where ba.bank_requisition_id = br.id and ba.is_active)
  loop
    if public.ai_signal_enqueue(p_org, 'bank_consent_expiring', 'bank_requisition:' || r.id::text || ':expiring', 'bank_requisition', r.id, null,
         jsonb_build_object('requisition_id', r.id, 'institution_name', r.institution_name, 'expires_at', r.expires_at), now()) is not null then n := n + 1; end if;
  end loop;

  -- Backfill: offertes die vóór het aanzetten al geopend waren.
  for r in
    select q.id, q.number, q.client_id, q.valid_until, q.last_email_opened_at
      from public.quotes q
     where q.organization_id = p_org and q.status = 'sent' and q.last_email_opened_at is not null
       and q.last_email_opened_at > now() - interval '60 days'
  loop
    if public.ai_signal_enqueue(p_org, 'quote_opened_unanswered', 'quote:' || r.id::text || ':followup', 'quote', r.id, r.client_id,
         jsonb_build_object('quote_id', r.id, 'quote_number', r.number, 'opened_at', r.last_email_opened_at, 'valid_until', r.valid_until, 'backfill', true),
         greatest(now(), r.last_email_opened_at + make_interval(days => v_settings.quote_follow_up_days))) is not null then n := n + 1; end if;
  end loop;

  -- Backfill: contracten die vóór het aanzetten al verstuurd waren.
  for r in
    select c.id, c.number, c.title, c.client_id, c.sent_at
      from public.contracts c
     where c.organization_id = p_org and c.status = 'sent' and c.sent_at is not null
       and c.sent_at > now() - interval '90 days'
  loop
    if public.ai_signal_enqueue(p_org, 'contract_unsigned', 'contract:' || r.id::text || ':unsigned', 'contract', r.id, r.client_id,
         jsonb_build_object('contract_id', r.id, 'number', r.number, 'title', r.title, 'sent_at', r.sent_at, 'backfill', true),
         greatest(now(), r.sent_at + make_interval(days => v_settings.contract_follow_up_days))) is not null then n := n + 1; end if;
  end loop;

  return n;
end;
$$;

create or replace function public.ai_decisions_expire(p_org uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
  v_gone boolean;
  v_reason text;
  n int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag kaarten laten verlopen.' using errcode = '42501';
  end if;
  for d in
    select id, kind, entity_id, audit_id, expires_at
      from public.ai_decisions
     where organization_id = p_org and status in ('open','snoozed')
  loop
    v_gone := false; v_reason := null;
    if d.expires_at is not null and d.expires_at < now() then
      v_gone := true; v_reason := 'verlopen';
    elsif d.kind in ('quote_opened_unanswered','quote_expiring') then
      if not exists (select 1 from public.quotes q where q.id = d.entity_id and q.status = 'sent') then v_gone := true; v_reason := 'offerte niet meer open'; end if;
    elsif d.kind = 'contract_unsigned' then
      if not exists (select 1 from public.contracts c where c.id = d.entity_id and c.status = 'sent') then v_gone := true; v_reason := 'contract niet meer open'; end if;
    elsif d.kind = 'inbound_mail' then
      if not exists (select 1 from public.client_emails e where e.id = d.entity_id and e.deleted_at is null) then
        v_gone := true; v_reason := 'mail verwijderd';
      elsif exists (
        select 1 from public.client_emails i
          join public.client_emails o on o.thread_id = i.thread_id and o.direction = 'outbound' and o.created_at > coalesce(i.received_at, i.created_at)
         where i.id = d.entity_id
      ) then v_gone := true; v_reason := 'al beantwoord'; end if;
    elsif d.kind = 'mail_unmatched' then
      if not exists (select 1 from public.inbound_messages m where m.id = d.entity_id and m.status = 'unmatched') then v_gone := true; v_reason := 'al afgehandeld'; end if;
    elsif d.kind in ('meeting_notes_ready','meeting_notes_unsent') then
      if not exists (select 1 from public.meeting_recordings m where m.id = d.entity_id) then
        v_gone := true; v_reason := 'opname verwijderd';
      elsif d.kind = 'meeting_notes_unsent' and exists (select 1 from public.meeting_recordings m where m.id = d.entity_id and m.summary_sent_at is not null) then
        v_gone := true; v_reason := 'notulen al gemaild';
      end if;
    elsif d.kind = 'gallery_favorites_chosen' then
      if not exists (select 1 from public.galleries g where g.id = d.entity_id) then v_gone := true; v_reason := 'galerij verwijderd'; end if;
    elsif d.kind = 'bank_consent_expiring' then
      -- Opnieuw gekoppeld (de rekeningen hangen aan een nieuwe toestemming) of
      -- de rekeningen staan uit: er valt niets meer te verlengen.
      if not exists (select 1 from public.bank_accounts ba where ba.bank_requisition_id = d.entity_id and ba.is_active) then
        v_gone := true; v_reason := 'opnieuw gekoppeld';
      end if;
    end if;
    if v_gone then
      update public.ai_decisions set status = 'expired', resolution = left('expired: ' || v_reason, 200), resolved_at = now() where id = d.id;
      if d.audit_id is not null then
        update public.ai_action_audit set status = 'cancelled' where id = d.audit_id and status = 'proposed';
      end if;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ------------------------------------------------------------
-- 5. Bestaande gekoppelde rekeningen die hun grootboekrekening delen met een
--    andere rekening, krijgen er één voor zich alleen — met dezelfde regels als
--    bij het koppelen (ander IBAN, nog niets geboekt). Nieuwste eerst, zodat de
--    oudste rekening op 1100 blijft.
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_role text := current_setting('request.jwt.claim.role', true);
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  for r in
    select ba.id, ba.organization_id from public.bank_accounts ba
    where ba.source = 'enablebanking' and ba.is_active
    order by ba.created_at desc, ba.id desc
  loop
    perform public.assign_own_bank_ledger_account(r.organization_id, r.id);
  end loop;
  perform set_config('request.jwt.claim.role', coalesce(v_role, ''), true);
end $$;

-- ------------------------------------------------------------
-- 6. Rechten. Anon hoort geen security-definer-functie te kunnen aanroepen
--    (20260926000000). De veegronde en de sync-selectie zijn alleen voor de
--    service-role; een eigen grootboekrekening aanvragen mag een gebruiker met
--    schrijfrecht ook (de functie toetst dat zelf).
-- ------------------------------------------------------------
revoke all on function public.assign_own_bank_ledger_account(uuid, uuid) from public, anon;
grant execute on function public.assign_own_bank_ledger_account(uuid, uuid) to authenticated, service_role;
revoke all on function public.bank_clearing_account_id(uuid) from public, anon, authenticated;
grant execute on function public.bank_clearing_account_id(uuid) to service_role;
revoke all on function public.match_bank_transactions(uuid, uuid, uuid) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.bank_accounts_due_for_sync(interval, integer) from public, anon, authenticated;
grant execute on function public.bank_accounts_due_for_sync(interval, integer) to service_role;
revoke all on function public.collect_time_signals(uuid) from public, anon, authenticated;
grant execute on function public.collect_time_signals(uuid) to service_role;
revoke all on function public.ai_decisions_expire(uuid) from public, anon, authenticated;
grant execute on function public.ai_decisions_expire(uuid) to service_role;

commit;
