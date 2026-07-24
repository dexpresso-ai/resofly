-- ============================================================
-- ResoFly — Boekhouding: vaste activa — desinvestering + hardening
-- Date: 2026-07-24
--
-- Review-bevindingen die deze migratie dicht:
--   [HOOG]  Desinvestering/verkoop ontbrak volledig → book_asset_disposal:
--           boekt de boekwaarde af (credit 0100 aanschaf, debet 0150 cumulatief),
--           verwerkt de opbrengst tegen een tegenrekening en boekt het
--           boekwinst/-verlies naar 4950 Boekresultaat vaste activa.
--   [MIDDEN] Aanschaf/afschrijving werden hard geweigerd in een afgesloten
--           periode (i.t.t. facturen). Nu schuift de JOURNAALPOST via
--           first_open_booking_date naar de eerstvolgende open datum.
--   [MIDDEN] Afschrijven kon zonder dat de aanschaf op de balans stond →
--           post_asset_depreciation eist nu een geboekte aanschaf.
--   [LAAG]  Laatste afschrijvingstermijn kon negatief worden bij een minieme
--           afschrijfbasis; nul-basis gaf 60 zinloze €0-regels. Nu een cent-
--           exacte floor+restant-verdeling zonder nul- of negatieve regels.
--
-- Alle mutatie loopt via security-definer RPC's; bedragen in centen (bigint).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. Nieuw boekstuk-brontype 'asset_disposal' (volledige lijst overnemen).
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note'
  ));

-- ------------------------------------------------------------
-- 1. Afschrijvingsschema: cent-exacte floor+restant-verdeling.
--    v_monthly = v_base / v_n (afgekapt); het restant (v_base mod v_n cent) wordt
--    over de eerste periodes verdeeld (elk +1 cent). Zo is elke termijn ≥ 0, de
--    som exact v_base, en de laatste termijn nooit negatief. Nul-basis → geen regels.
-- ------------------------------------------------------------
create or replace function public.generate_depreciation_schedule(
  p_organization_id uuid,
  p_asset_id uuid
)
returns setof public.asset_depreciations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.fixed_assets;
  v_base bigint;
  v_n integer;
  v_monthly bigint;
  v_remainder bigint;
  v_i integer;
  v_amount bigint;
  v_accum bigint := 0;
  v_period_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;

  v_n := v_asset.useful_life_months;
  if v_n <= 0 then
    raise exception 'Ongeldige gebruiksduur.' using errcode = '23514';
  end if;
  v_base := greatest(v_asset.acquisition_cost_cents - v_asset.residual_value_cents, 0);
  v_monthly := v_base / v_n;                 -- gehele centen (afkap)
  v_remainder := v_base - v_monthly * v_n;   -- 0 .. v_n-1 cent restant

  -- Verwijder alleen de nog niet geboekte regels; geboekte regels zijn onveranderbaar.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';

  for v_i in 1..v_n loop
    -- Restant over de eerste periodes verdelen (elk +1 cent) → som exact v_base.
    v_amount := v_monthly + case when v_i <= v_remainder then 1 else 0 end;
    if v_amount <= 0 then
      continue;                              -- geen nul-regels (bv. nul-basis)
    end if;
    v_accum := v_accum + v_amount;
    v_period_date := (v_asset.start_date + ((v_i - 1) || ' months')::interval)::date;

    -- Bestaat er al een geboekte regel voor deze periode, laat die staan.
    if exists (select 1 from public.asset_depreciations where asset_id = p_asset_id and period_index = v_i and status = 'posted') then
      continue;
    end if;

    insert into public.asset_depreciations(
      organization_id, asset_id, period_index, year, month, date,
      amount_cents, accumulated_after_cents, book_value_after_cents, status
    ) values (
      p_organization_id, p_asset_id, v_i,
      extract(year from v_period_date)::int, extract(month from v_period_date)::smallint, v_period_date,
      v_amount, v_accum, v_asset.acquisition_cost_cents - v_accum, 'scheduled'
    );
  end loop;

  return query select * from public.asset_depreciations where asset_id = p_asset_id order by period_index;
end;
$$;

-- ------------------------------------------------------------
-- 2. Aanschaf boeken: boekdatum naar eerstvolgende open periode schuiven.
-- ------------------------------------------------------------
create or replace function public.book_asset_acquisition(
  p_organization_id uuid,
  p_asset_id uuid,
  p_credit_account_id uuid,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.fixed_assets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.fixed_assets;
  v_entry public.journal_entries;
  v_lines jsonb;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.acquisition_journal_entry_id is not null then
    raise exception 'De aanschaf van dit activum is al geboekt.' using errcode = '23514';
  end if;
  if v_asset.acquisition_cost_cents <= 0 then
    raise exception 'De aanschafwaarde moet groter zijn dan nul.' using errcode = '23514';
  end if;
  if p_credit_account_id = v_asset.asset_account_id then
    raise exception 'De tegenrekening mag niet gelijk zijn aan de activarekening.' using errcode = '23514';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_asset.asset_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', v_asset.acquisition_cost_cents, 'credit_cents', 0
    ),
    jsonb_build_object(
      'account_id', p_credit_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents
    )
  );

  v_book_date := public.first_open_booking_date(p_organization_id, coalesce(p_date, v_asset.acquisition_date));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Aanschaf ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_acquisition', p_asset_id, v_lines, p_created_by
  );

  update public.fixed_assets set acquisition_journal_entry_id = v_entry.id where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$$;

-- ------------------------------------------------------------
-- 3. Afschrijving boeken: aanschaf-vereiste + boekdatum-verschuiving.
-- ------------------------------------------------------------
create or replace function public.post_asset_depreciation(
  p_organization_id uuid,
  p_asset_id uuid,
  p_through_date date,
  p_created_by uuid default auth.uid()
)
returns public.fixed_assets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.fixed_assets;
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_remaining integer;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
    v_book_date := public.first_open_booking_date(p_organization_id, r.date);
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
$$;

-- ------------------------------------------------------------
-- 4. book_asset_disposal: desinvestering / verkoop van een activum.
--    - Boekt de resterende boekwaarde af: credit 0100 (aanschafwaarde),
--      debet 0150 (opgebouwde afschrijving) — activum verdwijnt van de balans.
--    - Verwerkt de (optionele) opbrengst tegen een tegenrekening (bank/debiteuren).
--    - Het verschil opbrengst − boekwaarde is boekwinst (credit) of -verlies
--      (debet) op 4950 Boekresultaat vaste activa.
--    - Cancelt resterende geplande afschrijvingen en zet het activum op 'disposed'.
-- ------------------------------------------------------------
create or replace function public.book_asset_disposal(
  p_organization_id uuid,
  p_asset_id uuid,
  p_counter_account_id uuid,
  p_proceeds_cents bigint default 0,
  p_disposal_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.fixed_assets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.fixed_assets;
  v_accumulated bigint;
  v_book_value bigint;
  v_proceeds bigint := greatest(coalesce(p_proceeds_cents, 0), 0);
  v_result bigint;                 -- opbrengst − boekwaarde (winst > 0, verlies < 0)
  v_result_account uuid;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_disposal_date date;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is al afgestoten.' using errcode = '23514';
  end if;
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'De aanschaf van dit activum staat nog niet in het grootboek; boek die eerst.' using errcode = '23514';
  end if;
  if p_counter_account_id is null then
    raise exception 'Kies een tegenrekening voor de opbrengst (bank/debiteuren, of dezelfde als geen opbrengst).' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  -- Zelfvoorzienend: zorg dat het boekresultaat-rekeningnummer bestaat.
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
  values (p_organization_id, '4950', 'Boekresultaat vaste activa', 'expense', 'asset_disposal_result', true)
  on conflict (organization_id, code) do nothing;

  v_disposal_date := coalesce(p_disposal_date, current_date);

  -- Opgebouwde afschrijving = som van de GEBOEKTE afschrijvingen van dit activum.
  select coalesce(sum(amount_cents), 0) into v_accumulated
  from public.asset_depreciations
  where asset_id = p_asset_id and status = 'posted';

  v_book_value := v_asset.acquisition_cost_cents - v_accumulated;
  v_result := v_proceeds - v_book_value;

  -- a) Aanschafwaarde van de balans halen (credit activarekening).
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_asset.asset_account_id, 'description', 'Afboeken aanschaf ' || v_asset.name,
    'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents));

  -- b) Opgebouwde afschrijving terugnemen (debet cumulatieve-afschrijvingrekening).
  if v_accumulated <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_asset.accumulated_depreciation_account_id, 'description', 'Afboeken cum. afschrijving ' || v_asset.name,
      'debit_cents', v_accumulated, 'credit_cents', 0));
  end if;

  -- c) Opbrengst (debet tegenrekening: bank/debiteuren).
  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', p_counter_account_id, 'description', 'Opbrengst verkoop ' || v_asset.name,
      'debit_cents', v_proceeds, 'credit_cents', 0));
  end if;

  -- d) Boekwinst (credit) of boekverlies (debet) als sluitpost op 4950.
  if v_result <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, '4950');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', case when v_result > 0 then 'Boekwinst' else 'Boekverlies' end || ' verkoop ' || v_asset.name,
      'debit_cents', case when v_result < 0 then -v_result else 0 end,
      'credit_cents', case when v_result > 0 then v_result else 0 end));
  end if;

  v_book_date := public.first_open_booking_date(p_organization_id, v_disposal_date);
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Desinvestering ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_disposal', p_asset_id, v_lines, p_created_by);

  -- Resterende geplande afschrijvingen vervallen; activum op 'disposed'.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';
  update public.fixed_assets
  set status = 'disposed', disposal_date = v_disposal_date, disposal_proceeds_cents = v_proceeds
  where id = p_asset_id;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$$;

commit;
