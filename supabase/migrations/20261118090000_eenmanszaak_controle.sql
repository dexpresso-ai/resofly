-- Eenmanszaak: de administratie nagelopen op bruikbaarheid en juistheid.
--
-- Aanleiding: een volledig jaar als zzp'er doorlopen (beginbalans, facturen,
-- inkoop, bank met privé, btw-aangiften, afschrijving, jaarafsluiting,
-- kapitaalvergelijking), plus drie reviews: btw en KOR, facturen en
-- debiteuren, en de IB-boekhouding. Zie
-- docs/changelog/CHANGELOG_EENMANSZAAK_CONTROLE_2026-11-18.md.
--
-- Wat hier verandert:
--   1. Eigen vermogen: het beginvermogen telt de winst van een vorig jaar dat
--      nog niet is afgesloten mee, en het overzicht zegt welke jaren dat zijn.
--   2. Activa: een activum dat via een inkoopfactuur op de activarekening is
--      geboekt, kun je aan die inkoopfactuur koppelen en dus afschrijven.
--   3. Bank: met de KOR geen btw-splitsing (verlegde btw wel, zonder aftrek).
--   4. Bank: geen btw op eigen vermogen (privé-opnamen en -stortingen).
--   5. Btw-aangifte: geen tijdvak afsluiten dat nog loopt, en alleen in de
--      ingestelde frequentie.
--   6. Jaarafsluiting: eerst de geplande afschrijvingen en termijnen; een
--      beginbalans van vóór het eerste boekjaar blokkeert niet meer.
--   7. Desinvestering: eerst afschrijven tot de verkoopdatum.
--   8. Inrichting afronden zet het rekeningschema en het boekjaar klaar
--      (open_initial_fiscal_years, ook voor de knop op de pagina's).
--   9. Resultaatrekening volgt de rechtsvorm (eenmanszaak 0500), ook voor
--      bestaande eenmanszaken die nog nooit naar 0510 afsloten.
--  10. Rekeningschema van een IB-onderneming: kas en kostenrekeningen in de
--      indeling van de aangifte, met een rekening voor beperkt aftrekbare
--      kosten (subtype mixed_costs).
--  11. KOR op facturen en offertes: een 0%-regel zonder code krijgt de code
--      KOR, zodat de vermelding op de factuur staat en de omzet niet in 1e.
--  12. "Op betaald zetten": de melding wijst naar de bank in plaats van naar
--      een memoriaalpost (die telt niet als betaling van de factuur).
--
-- Veilig om opnieuw te draaien: create or replace, drop … if exists, en
-- inserts met on conflict do nothing.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Eigen vermogen: beginvermogen met de winst van een open vorig jaar
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Het beginvermogen telde alleen eigen-vermogenrekeningen. Is het vorige
-- boekjaar nog niet afgesloten (heel gewoon bij een zzp'er: de aangifte over
-- 2025 doe je in het voorjaar van 2026), dan zat de winst van dat jaar nog op
-- de omzet- en kostenrekeningen en telde hij niet mee. Een eenmanszaak met
-- € 2.000 beginbalans, € 887,93 winst, € 3.000 storting en € 500 opname in
-- 2025 begon 2026 zo op € 4.500 in plaats van € 5.387,93, en het
-- eindvermogen sloot niet aan op de balans.
--
-- Nu telt het begin alles vóór de begindatum op eigen vermogen én op omzet en
-- kosten. Van een afgesloten jaar vallen omzet en kosten tegen de
-- jaarafsluiting weg; van een open jaar blijft precies de winst over.
create or replace function public.owners_equity_overview(p_organization_id uuid, p_fiscal_year_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_fy public.fiscal_years;
  v_legal text;
  v_partnership boolean;
  v_partners_defined boolean;
  v_result bigint := 0;
  v_share_total integer := 0;
  v_owners jsonb := '[]'::jsonb;
  v_unassigned jsonb := null;
  v_partner_accounts uuid[] := '{}';
  v_begin bigint;
  v_contrib bigint;
  v_withdraw bigint;
  v_other bigint;
  v_name text;
  v_open_prior bigint := 0;
  v_open_years jsonb := '[]'::jsonb;
  r record;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'ib' then
    raise exception 'Dit overzicht hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.'
      using errcode = '23514';
  end if;

  v_legal := public.org_legal_form(p_organization_id);
  v_partners_defined := exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id);
  v_partnership := v_legal in ('vof', 'maatschap', 'cv')
    and exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id and pp.is_active);

  -- Resultaat van het boekjaar: de W&V zonder de jaarafsluiting.
  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_result
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_fy.period_start and v_fy.period_end
    and la.type in ('revenue', 'expense');

  -- TOEGEVOEGD (20261118090000): de winst van eerdere jaren die nog niet naar
  -- het eigen vermogen is gegaan (het jaar is niet afgesloten). Mét de
  -- jaarafsluitingen: daarin vallen omzet en kosten van een dicht jaar weg.
  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_open_prior
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date < v_fy.period_start
    and la.type in ('revenue', 'expense');

  select coalesce(jsonb_agg(f.label order by f.period_start), '[]'::jsonb)
  into v_open_years
  from public.fiscal_years f
  where f.organization_id = p_organization_id
    and f.status <> 'closed'
    and f.period_end < v_fy.period_start;

  if v_partnership then
    select coalesce(sum(pp.profit_share_basis_points), 0)::int into v_share_total
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active;

    for r in
      select pp.id, pp.name, pp.partner_number, pp.profit_share_basis_points, pp.kind, pp.is_active,
             pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id,
             coalesce(sh.share_cents, 0)::bigint as share_cents
      from public.partnership_partners pp
      left join public.partnership_result_shares(p_organization_id, v_result) sh on sh.partner_id = pp.id
      where pp.organization_id = p_organization_id
      order by pp.partner_number
    loop
      v_partner_accounts := v_partner_accounts || array[r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id];

      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and jl.account_id in (r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id)
        and (je.date < v_fy.period_start
             or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end));

      select
        coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where jl.account_id = r.contributions_account_id), 0)::bigint,
        coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where jl.account_id = r.withdrawals_account_id), 0)::bigint,
        coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where jl.account_id = r.capital_account_id), 0)::bigint
      into v_contrib, v_withdraw, v_other
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.source_type not in ('year_close', 'opening_balance')
        and je.date between v_fy.period_start and v_fy.period_end
        and jl.account_id in (r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id);

      v_owners := v_owners || jsonb_build_array(jsonb_build_object(
        'partnerId', r.id,
        'name', r.name,
        'partnerNumber', r.partner_number,
        'kind', r.kind,
        'isActive', r.is_active,
        'shareBasisPoints', r.profit_share_basis_points,
        'beginCents', v_begin,
        'resultShareCents', r.share_cents,
        'contributionsCents', v_contrib,
        'withdrawalsCents', v_withdraw,
        'otherMovementsCents', v_other,
        'endCents', v_begin + r.share_cents + v_contrib - v_withdraw + v_other
      ));
    end loop;

    -- Wat op geen enkele vennoot staat (0500, 0510, 0550/0560, ...).
    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where je.date < v_fy.period_start
           or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end)), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where je.source_type not in ('year_close', 'opening_balance')
          and je.date between v_fy.period_start and v_fy.period_end), 0)::bigint
    into v_begin, v_other
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and la.type = 'equity'
      and not (jl.account_id = any (v_partner_accounts));

    -- TOEGEVOEGD (20261118090000): de winst van een vorig jaar dat nog open
    -- is, is nog niet over de vennoten verdeeld; die staat hier tot dat jaar
    -- dicht is.
    v_begin := v_begin + v_open_prior;

    if v_begin <> 0 or v_other <> 0 then
      v_unassigned := jsonb_build_object(
        'beginCents', v_begin,
        'movementsCents', v_other,
        'endCents', v_begin + v_other
      );
    end if;
  else
    select coalesce(nullif(btrim(cs.company_name), ''), 'Ondernemer') into v_name
    from public.company_settings cs where cs.organization_id = p_organization_id;

    -- GEWIJZIGD (20261118090000): ook omzet en kosten van vóór de begindatum
    -- (zie de toelichting boven deze functie).
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        (je.date < v_fy.period_start and la.type in ('equity', 'revenue', 'expense'))
        or (la.type = 'equity' and je.source_type = 'opening_balance'
            and je.date between v_fy.period_start and v_fy.period_end)
      );

    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where la.subtype = 'private_contributions'), 0)::bigint,
      coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where la.subtype = 'private_withdrawals'), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where coalesce(la.subtype, '') not in ('private_contributions', 'private_withdrawals')), 0)::bigint
    into v_contrib, v_withdraw, v_other
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type not in ('year_close', 'opening_balance')
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type = 'equity';

    v_owners := jsonb_build_array(jsonb_build_object(
      'partnerId', null,
      'name', coalesce(v_name, 'Ondernemer'),
      'partnerNumber', null,
      'kind', null,
      'isActive', true,
      'shareBasisPoints', 10000,
      'beginCents', v_begin,
      'resultShareCents', v_result,
      'contributionsCents', v_contrib,
      'withdrawalsCents', v_withdraw,
      'otherMovementsCents', v_other,
      'endCents', v_begin + v_result + v_contrib - v_withdraw + v_other
    ));
  end if;

  return jsonb_build_object(
    'fiscalYear', jsonb_build_object(
      'id', v_fy.id, 'label', v_fy.label, 'periodStart', v_fy.period_start,
      'periodEnd', v_fy.period_end, 'status', v_fy.status),
    'legalForm', v_legal,
    'isPartnershipForm', v_legal in ('vof', 'maatschap', 'cv'),
    'isPartnership', v_partnership,
    'partnersDefined', v_partners_defined,
    'shareTotalBasisPoints', case when v_partnership then v_share_total else null end,
    'resultCents', v_result,
    -- TOEGEVOEGD (20261118090000): voor de melding "2025 is nog niet afgesloten".
    'openPriorResultCents', v_open_prior,
    'openPriorYears', v_open_years,
    'owners', v_owners,
    'unassigned', v_unassigned
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Activa: de aanschaf koppelen aan de inkoopfactuur
-- ═══════════════════════════════════════════════════════════════════════════
--
-- De gewone weg voor een zzp'er: de camera komt binnen als inkoopfactuur, op
-- 0100 Vaste activa, met de btw als voorbelasting. Daarna in het
-- activaregister, met die factuur als bron. Afschrijven weigerde dan ("boek
-- eerst de aanschaf"), en het scherm zei terecht: boek de aanschaf níét nog
-- eens, dan staat hij dubbel op de balans. Een doodlopende weg: zo'n activum
-- kon nooit worden afgeschreven.
--
-- Nu: staat de bron-inkoopfactuur geboekt met de aanschafwaarde op de
-- activarekening, dan wordt dát boekstuk de aanschaf. Er komt geen tweede
-- boeking, en afschrijven, desinvesteren en tegenboeken werken zoals bij een
-- losse aanschaf.
create or replace function public.book_asset_acquisition(p_organization_id uuid, p_asset_id uuid, p_credit_account_id uuid, p_date date default null::date, p_created_by uuid default auth.uid())
returns fixed_assets
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_asset public.fixed_assets;
  v_entry public.journal_entries;
  v_lines jsonb;
  v_book_date date;
  v_pi public.purchase_invoices;
  v_on_asset bigint := 0;
  v_linked bigint := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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

  -- TOEGEVOEGD (20261118090000): de aanschaf staat al op de balans via de
  -- bron-inkoopfactuur. Dan wordt dat boekstuk de aanschaf.
  if v_asset.source_purchase_invoice_id is not null then
    select * into v_pi from public.purchase_invoices
    where id = v_asset.source_purchase_invoice_id and organization_id = p_organization_id;
    if found and v_pi.journal_entry_id is not null then
      select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint into v_on_asset
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.entry_id = v_pi.journal_entry_id
        and jl.organization_id = p_organization_id
        and jl.account_id = v_asset.asset_account_id
        and je.status = 'posted'
        and je.reversed_by_entry_id is null;
      if v_on_asset > 0 then
        -- Eén inkoopfactuur kan meer activa dragen (een laptop en een scherm);
        -- samen niet meer dan er op de activarekening staat.
        select coalesce(sum(fa.acquisition_cost_cents), 0)::bigint into v_linked
        from public.fixed_assets fa
        where fa.organization_id = p_organization_id
          and fa.acquisition_journal_entry_id = v_pi.journal_entry_id
          and fa.id <> v_asset.id;
        if v_linked + v_asset.acquisition_cost_cents > v_on_asset then
          raise exception 'Inkoopfactuur % staat voor € % op de activarekening%. De aanschafwaarde van "%" (€ %) past daar niet in. Kijk de aanschafwaarde na (met de KOR: inclusief btw), of kies een andere bron-inkoopfactuur.',
            coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
            replace(to_char(v_on_asset / 100.0, 'FM999999990.00'), '.', ','),
            case when v_linked > 0 then ', en € ' || replace(to_char(v_linked / 100.0, 'FM999999990.00'), '.', ',') || ' daarvan hoort al bij andere activa' else '' end,
            v_asset.name,
            replace(to_char(v_asset.acquisition_cost_cents / 100.0, 'FM999999990.00'), '.', ',')
            using errcode = '23514';
        end if;
        update public.fixed_assets set acquisition_journal_entry_id = v_pi.journal_entry_id where id = p_asset_id;
        select * into v_asset from public.fixed_assets where id = p_asset_id;
        return v_asset;
      end if;
    end if;
  end if;

  if p_credit_account_id is null then
    raise exception 'Kies een tegenrekening voor de aanschaf (bijvoorbeeld 1600 Crediteuren of de bank).' using errcode = '23514';
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

  v_book_date := public.first_open_booking_date_for(p_organization_id, coalesce(p_date, v_asset.acquisition_date), public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Aanschaf ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_acquisition', p_asset_id, v_lines, p_created_by
  );

  update public.fixed_assets set acquisition_journal_entry_id = v_entry.id where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;

-- Tegenboeken van zo'n inkoopfactuur: het register gaat mee terug, in de
-- volgorde van de losse aanschaf (eerst desinvestering en afschrijvingen).
-- Een trigger en niet in reverse_journal_entry zelf: die functie is lang en
-- doet hier verder niets anders; de grendel hoort bij het moment dat het
-- boekstuk als tegengeboekt wordt gemarkeerd.
create or replace function public.journal_entry_reversal_releases_asset()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name text;
begin
  -- Een losse aanschaf (source_type asset_acquisition) regelt
  -- reverse_journal_entry al zelf.
  if new.source_type = 'asset_acquisition' then
    return new;
  end if;
  select fa.name into v_name
  from public.fixed_assets fa
  where fa.organization_id = new.organization_id
    and fa.acquisition_journal_entry_id = new.id
    and (fa.status = 'disposed'
         or exists (select 1 from public.asset_depreciations ad where ad.asset_id = fa.id and ad.status = 'posted'))
  limit 1;
  if v_name is not null then
    raise exception 'Dit boekstuk is de aanschaf van activum "%". Draai eerst de desinvestering en de geboekte afschrijvingen terug; daarna dit boekstuk.', v_name
      using errcode = '23514';
  end if;
  update public.fixed_assets
  set acquisition_journal_entry_id = null
  where organization_id = new.organization_id
    and acquisition_journal_entry_id = new.id;
  return new;
end;
$function$;

drop trigger if exists journal_entries_reversal_releases_asset on public.journal_entries;
create trigger journal_entries_reversal_releases_asset
  before update of reversed_by_entry_id on public.journal_entries
  for each row
  when (old.reversed_by_entry_id is null and new.reversed_by_entry_id is not null)
  execute function public.journal_entry_reversal_releases_asset();

revoke all on function public.journal_entry_reversal_releases_asset() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3 en 4. Bank: de KOR, en geen btw op privé
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.book_bank_transaction(p_organization_id uuid, p_transaction_id uuid, p_lines jsonb DEFAULT NULL::jsonb, p_matched_invoice_id uuid DEFAULT NULL::uuid, p_matched_purchase_invoice_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid(), p_allocations jsonb DEFAULT NULL::jsonb, p_description text DEFAULT NULL::text)
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_partner public.bank_transactions;
  v_abs bigint;
  v_dir integer;
  v_items jsonb;
  v_item jsonb;
  v_n integer := 0;
  v_kind text;
  v_amt bigint;        -- in de richting van de transactie (zoals de invoer)
  v_bank_amt bigint;   -- in bankrichting: + geld erbij, − geld eraf
  v_sum bigint := 0;
  v_id uuid;
  v_key text;
  v_seen text[] := '{}';
  v_line_desc text;
  v_desc text;
  v_date date;
  v_lines jsonb;
  v_alloc jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_cn public.credit_notes;
  v_pi public.purchase_invoices;
  v_acc public.ledger_accounts;
  v_vc public.vat_codes;
  v_entry_reversed boolean;
  v_open bigint;
  v_cn_total bigint;
  v_cn_refunded bigint;
  v_room bigint;
  v_used jsonb := '{}'::jsonb;   -- per factuur: tegoed dat deze boeking al terugbetaalt
  v_inv_ids uuid[] := '{}';
  v_pi_ids uuid[] := '{}';
  v_sales_invoice_ids uuid[] := '{}';
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
  v_is_credit boolean;
  v_gross bigint;
  v_net bigint;
  v_vat bigint;
  v_rate numeric;
  v_vkind text;
  v_vcode text;
  -- TOEGEVOEGD (20261118090000): de KOR, de code die "geen btw, KOR" vastlegt,
  -- en de grondslag apart van het bedrag op de rekening (verlegd met de KOR).
  v_kor boolean := false;
  v_kor_code text;
  v_base bigint;
  v_client uuid;
  v_supplier uuid;
  v_project uuid;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- TOEGEVOEGD (20261118090000): met de kleineondernemersregeling rekent deze
  -- administratie geen btw. Een bankboeking splitste toch btw af, met de code
  -- die het scherm bij de rekening voorstelt (HOOG op 4500): € 121 aan kosten
  -- werd € 100 kosten en € 21 voorbelasting, die met de KOR niet bestaat. De
  -- kosten en daarmee de winst klopten dan niet, en 1500 bleef voorgoed op de
  -- balans staan. De inkoopfactuur deed het al goed (book_purchase_invoice).
  select coalesce(cs.kor_enabled, false) into v_kor
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  if v_kor then
    select vc.code into v_kor_code from public.vat_codes vc
    where vc.organization_id = p_organization_id and vc.kind = 'kor'
    order by (vc.code = 'KOR') desc, vc.code
    limit 1;
  end if;

  if p_matched_invoice_id is not null and p_matched_purchase_invoice_id is not null then
    raise exception 'Koppel een transactie aan één factuur: een verkoopfactuur óf een inkoopfactuur. Meer stukken tegelijk gaat met een verdeling.' using errcode = '23514';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze transactie is al geboekt.' using errcode = '23514';
  end if;
  if v_txn.status = 'merged' then
    raise exception 'Deze banktransactie is samengevoegd met een handmatige mutatie; die draagt de boeking. Boek de handmatige mutatie, of maak het samenvoegen los.'
      using errcode = '23514';
  end if;
  if upper(coalesce(nullif(btrim(v_txn.currency), ''), 'EUR')) <> 'EUR' then
    raise exception 'Deze banktransactie is in %. Het grootboek boekt in euro''s: reken het bedrag om en boek het met een memoriaalpost.', upper(v_txn.currency)
      using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_abs := abs(v_txn.amount_cents);
  if v_abs = 0 then
    raise exception 'Een transactie van € 0,00 kan niet worden geboekt.' using errcode = '23514';
  end if;
  v_dir := case when v_txn.amount_cents > 0 then 1 else -1 end;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_vat_payable_id := public.bookkeeping_account_id(p_organization_id, '1530');

  -- Alles wordt één verdeling. Bedragen in de invoer staan in de richting van
  -- de transactie: positief = mee met het geld (bij een betaling: wat je
  -- betaalt), negatief = de andere kant op (bijvoorbeeld kosten die van een
  -- uitbetaling zijn afgehouden).
  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0 then
    if p_lines is not null or p_matched_invoice_id is not null or p_matched_purchase_invoice_id is not null then
      raise exception 'Geef óf een verdeling, óf een factuur, óf regels — niet door elkaar.' using errcode = '23514';
    end if;
    v_items := p_allocations;
  elsif p_matched_invoice_id is not null then
    v_items := jsonb_build_array(jsonb_build_object('kind', 'sales_invoice', 'invoice_id', p_matched_invoice_id, 'amount_cents', v_abs));
  elsif p_matched_purchase_invoice_id is not null then
    v_items := jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', p_matched_purchase_invoice_id, 'amount_cents', v_abs));
  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    select jsonb_agg(case when jsonb_typeof(l) = 'object' then l || jsonb_build_object('kind', 'ledger') else l end order by ord)
    into v_items
    from jsonb_array_elements(p_lines) with ordinality as t(l, ord);
  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;
  if jsonb_array_length(v_items) > 100 then
    raise exception 'Een boeking heeft hoogstens 100 regels.' using errcode = '23514';
  end if;

  v_desc := nullif(btrim(coalesce(p_description, '')), '');
  if v_desc is not null and length(v_desc) > 300 then
    raise exception 'De omschrijving van de boeking is te lang (hoogstens 300 tekens).' using errcode = '23514';
  end if;
  v_desc := coalesce(v_desc,
    'Bank ' || coalesce(v_ba.name, '') || ': ' ||
    coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'transactie'));

  -- Een handmatige mutatie die de bank al bevestigde, boekt op de datum van de bank.
  v_date := v_txn.booking_date;
  if v_txn.is_manual then
    select * into v_partner from public.bank_transactions where merged_into_id = v_txn.id;
    if found then
      v_date := v_partner.booking_date;
    end if;
  end if;

  -- Bankregel (debet bij ontvangst, credit bij betaling).
  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ba.ledger_account_id,
    'description', v_desc,
    'debit_cents', case when v_dir > 0 then v_abs else 0 end,
    'credit_cents', case when v_dir < 0 then v_abs else 0 end
  ));

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_n := v_n + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Regel % van de verdeling is onleesbaar.', v_n using errcode = '22023';
    end if;
    v_kind := coalesce(nullif(v_item->>'kind', ''), 'ledger');
    if v_kind not in ('sales_invoice', 'sales_credit_note', 'purchase_invoice', 'ledger') then
      raise exception 'Regel %: onbekende soort "%".', v_n, v_kind using errcode = '22023';
    end if;
    if coalesce(v_item->>'amount_cents', '') !~ '^-?[0-9]{1,15}$' then
      raise exception 'Regel %: geef een bedrag (in hele centen).', v_n using errcode = '22023';
    end if;
    v_amt := (v_item->>'amount_cents')::bigint;
    if v_amt = 0 then
      -- Een lege regel sloeg de oude boeking ook over.
      if v_kind = 'ledger' then continue; end if;
      raise exception 'Regel %: geef een bedrag.', v_n using errcode = '22023';
    end if;
    v_bank_amt := v_amt * v_dir;
    v_sum := v_sum + v_amt;
    v_line_desc := nullif(btrim(coalesce(v_item->>'description', '')), '');
    if v_line_desc is not null and length(v_line_desc) > 300 then
      raise exception 'Regel %: de omschrijving is te lang (hoogstens 300 tekens).', v_n using errcode = '23514';
    end if;

    if v_kind = 'sales_invoice' then
      v_id := public.bank_parse_uuid(v_item->>'invoice_id');
      if v_id is null then
        raise exception 'Regel %: kies een verkoopfactuur.', v_n using errcode = '22023';
      end if;
      v_key := 'i:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze factuur staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      if v_bank_amt <= 0 then
        raise exception 'Regel %: een verkoopfactuur betaalt de klant aan jou; dat gaat alleen met geld dat binnenkomt. Een terugbetaling koppel je aan de creditnota.', v_n
          using errcode = '23514';
      end if;
      -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
      -- anders allebei de openstaand-check passeren.
      select * into v_inv from public.invoices
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: verkoopfactuur niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_inv.status in ('cancelled', 'void') then
        raise exception 'Factuur % is geannuleerd; daar letter je niets meer op af.', coalesce(v_inv.number, '') using errcode = '23514';
      end if;
      -- Afletteren kan alleen tegen een factuur die in het grootboek staat. Zonder
      -- debitering van 1300 zou de creditering hier Debiteuren negatief maken.
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
      v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id);
      if v_open <= 0 then
        raise exception 'Factuur % is al volledig afgeletterd.', coalesce(v_inv.number, '') using errcode = '23514';
      end if;
      if v_bank_amt > v_open then
        raise exception 'Ontvangst (%) is hoger dan het openstaande saldo van factuur % (%). Zet op die regel hoogstens het openstaande bedrag en boek de rest op een eigen regel (bijvoorbeeld een grootboekrekening).',
          public.bank_eur(v_bank_amt), coalesce(v_inv.number, ''), public.bank_eur(v_open)
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', coalesce(v_line_desc, 'Debiteuren — factuur ' || coalesce(v_inv.number, '')),
        'debit_cents', 0, 'credit_cents', v_bank_amt,
        'client_id', v_inv.client_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'sales_invoice', 'invoice_id', v_inv.id, 'client_id', v_inv.client_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_inv_ids := v_inv_ids || v_inv.id;
      v_sales_invoice_ids := v_sales_invoice_ids || v_inv.id;

    elsif v_kind = 'sales_credit_note' then
      v_id := public.bank_parse_uuid(v_item->>'credit_note_id');
      if v_id is null then
        raise exception 'Regel %: kies een creditnota.', v_n using errcode = '22023';
      end if;
      v_key := 'c:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze creditnota staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      if v_bank_amt >= 0 then
        raise exception 'Regel %: een creditnota betaal je terug aan de klant; dat gaat alleen met geld dat van je rekening gaat.', v_n
          using errcode = '23514';
      end if;
      select * into v_cn from public.credit_notes
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: creditnota niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_cn.status <> 'issued' then
        raise exception 'Creditnota % is niet uitgegeven (status: %).', v_cn.number, v_cn.status using errcode = '23514';
      end if;
      if v_cn.journal_entry_id is null then
        raise exception 'Creditnota % staat nog niet in het grootboek. Boek hem eerst; daarna koppel je de terugbetaling.', v_cn.number
          using errcode = '23514';
      end if;
      select je.reversed_by_entry_id is not null into v_entry_reversed
      from public.journal_entries je where je.id = v_cn.journal_entry_id;
      if coalesce(v_entry_reversed, false) then
        raise exception 'De grootboekboeking van creditnota % is tegengeboekt; er valt niets terug te betalen.', v_cn.number
          using errcode = '23514';
      end if;
      select * into v_inv from public.invoices
      where id = v_cn.invoice_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'De factuur bij creditnota % is niet gevonden.', v_cn.number using errcode = '02000';
      end if;
      -- Wat de klant op deze factuur tegoed heeft: een negatief openstaand saldo
      -- (de creditnota kwam na de betaling). Min wat deze boeking op een andere
      -- regel al terugbetaalt.
      v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id)
              + coalesce((v_used->>v_inv.id::text)::bigint, 0);
      if v_open >= 0 then
        raise exception 'Op factuur % staat geen tegoed voor de klant (openstaand %): creditnota % is verrekend met wat er nog openstond. Er valt niets terug te betalen.',
          coalesce(v_inv.number, ''), public.bank_eur(greatest(v_open, 0)), v_cn.number
          using errcode = '23514';
      end if;
      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_cn_total
      from public.journal_lines jl
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
      where jl.entry_id = v_cn.journal_entry_id;
      select coalesce(sum(-a.amount_cents), 0) into v_cn_refunded
      from public.bank_transaction_allocations a
      join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
      where a.organization_id = p_organization_id and a.credit_note_id = v_cn.id
        and a.bank_transaction_id <> v_txn.id;
      v_room := least(v_cn_total - v_cn_refunded, -v_open);
      if -v_bank_amt > v_room then
        raise exception 'Terugbetaling (%) is hoger dan wat er van creditnota % nog terug te betalen is (%).',
          public.bank_eur(-v_bank_amt), v_cn.number, public.bank_eur(greatest(v_room, 0))
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', coalesce(v_line_desc, 'Terugbetaling creditnota ' || v_cn.number || ' (factuur ' || coalesce(v_inv.number, '') || ')'),
        'debit_cents', -v_bank_amt, 'credit_cents', 0,
        'client_id', v_inv.client_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'sales_credit_note', 'credit_note_id', v_cn.id, 'invoice_id', v_inv.id, 'client_id', v_inv.client_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_used := v_used || jsonb_build_object(v_inv.id::text, coalesce((v_used->>v_inv.id::text)::bigint, 0) - v_bank_amt);
      v_inv_ids := v_inv_ids || v_inv.id;

    elsif v_kind = 'purchase_invoice' then
      v_id := public.bank_parse_uuid(v_item->>'purchase_invoice_id');
      if v_id is null then
        raise exception 'Regel %: kies een inkoopfactuur.', v_n using errcode = '22023';
      end if;
      v_key := 'p:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze inkoopfactuur staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      select * into v_pi from public.purchase_invoices
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: inkoopfactuur niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_pi.status = 'cancelled' then
        raise exception 'Inkoopfactuur % is geannuleerd.', coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
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
      v_open := public.purchase_invoice_open_payable_cents(p_organization_id, v_pi.id);
      if v_open = 0 then
        raise exception 'Inkoopfactuur % is al volledig afgeletterd.',
          coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
      if v_open > 0 then
        if v_bank_amt >= 0 then
          raise exception 'Regel %: inkoopfactuur % betaal je aan de leverancier; dat gaat alleen met geld dat van je rekening gaat.',
            v_n, coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        if -v_bank_amt > v_open then
          raise exception 'Betaling (%) is hoger dan het openstaande saldo van inkoopfactuur % (%). Zet op die regel hoogstens het openstaande bedrag en boek de rest op een eigen regel.',
            public.bank_eur(-v_bank_amt), coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), public.bank_eur(v_open)
            using errcode = '23514';
        end if;
      else
        -- Een creditnota van de leverancier: hij is jou geld schuldig.
        if v_bank_amt <= 0 then
          raise exception 'Regel %: % is een creditnota van de leverancier; daar hoort geld bij dat binnenkomt.',
            v_n, coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        if v_bank_amt > -v_open then
          raise exception 'Ontvangst (%) is hoger dan wat de leverancier op % nog terug moet betalen (%).',
            public.bank_eur(v_bank_amt), coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), public.bank_eur(-v_open)
            using errcode = '23514';
        end if;
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
        'description', coalesce(v_line_desc, 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '')),
        'debit_cents', case when v_bank_amt < 0 then -v_bank_amt else 0 end,
        'credit_cents', case when v_bank_amt > 0 then v_bank_amt else 0 end,
        'supplier_id', v_pi.supplier_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'purchase_invoice', 'purchase_invoice_id', v_pi.id, 'supplier_id', v_pi.supplier_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_pi_ids := v_pi_ids || v_pi.id;

    else
      -- Rechtstreeks op een grootboekrekening, bruto bedrag met btw-code.
      v_id := public.bank_parse_uuid(v_item->>'account_id');
      if v_id is null and nullif(btrim(coalesce(v_item->>'account_code', '')), '') is not null then
        select la.id into v_id from public.ledger_accounts la
        where la.organization_id = p_organization_id and la.code = btrim(v_item->>'account_code');
      end if;
      if v_id is null then
        raise exception 'Regel %: kies een grootboekrekening.', v_n using errcode = '22023';
      end if;
      select * into v_acc from public.ledger_accounts where id = v_id and organization_id = p_organization_id;
      if not found then
        raise exception 'Regel %: grootboekrekening niet gevonden.', v_n using errcode = '02000';
      end if;
      if not v_acc.is_active then
        raise exception 'Regel %: % · % staat op inactief.', v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;
      if v_acc.id = v_ba.ledger_account_id then
        raise exception 'Regel %: % is de grootboekrekening van deze bankrekening zelf. Kies de tegenrekening.', v_n, v_acc.code
          using errcode = '23514';
      end if;

      v_vcode := nullif(btrim(coalesce(v_item->>'vat_code', '')), '');
      if v_vcode is not null then
        select * into v_vc from public.vat_codes where organization_id = p_organization_id and code = v_vcode;
        if not found then
          raise exception 'Regel %: btw-code % bestaat niet.', v_n, v_vcode using errcode = '22023';
        end if;
        v_rate := v_vc.rate;
        v_vkind := coalesce(v_vc.kind, 'standard');
      else
        -- Zonder code een los tarief, zoals de oude regels het mochten meesturen.
        if coalesce(v_item->>'vat_rate', '') !~ '^([0-9]{1,2}(\.[0-9]{1,2})?)?$' then
          raise exception 'Regel %: ongeldig btw-tarief.', v_n using errcode = '22023';
        end if;
        v_rate := coalesce(nullif(v_item->>'vat_rate', '')::numeric, 0);
        v_vkind := 'standard';
      end if;

      v_client := public.bank_parse_uuid(v_item->>'client_id');
      v_supplier := public.bank_parse_uuid(v_item->>'supplier_id');
      v_project := public.bank_parse_uuid(v_item->>'project_id');
      if (nullif(btrim(coalesce(v_item->>'client_id', '')), '') is not null and v_client is null)
         or (nullif(btrim(coalesce(v_item->>'supplier_id', '')), '') is not null and v_supplier is null)
         or (nullif(btrim(coalesce(v_item->>'project_id', '')), '') is not null and v_project is null) then
        raise exception 'Regel %: ongeldige klant, leverancier of project.', v_n using errcode = '22023';
      end if;
      if v_client is not null then
        if not (v_acc.subtype = 'accounts_receivable' or v_acc.type = 'revenue') then
          raise exception 'Regel %: een klant hoort op een debiteuren- of omzetrekening; % is dat niet.', v_n, v_acc.code using errcode = '23514';
        end if;
        if not exists (select 1 from public.clients c where c.id = v_client and c.organization_id = p_organization_id) then
          raise exception 'Regel %: klant niet gevonden.', v_n using errcode = '02000';
        end if;
      end if;
      if v_supplier is not null then
        if coalesce(v_acc.subtype, '') <> 'accounts_payable' then
          raise exception 'Regel %: een leverancier hoort op een crediteurenrekening; % is dat niet.', v_n, v_acc.code using errcode = '23514';
        end if;
        if not exists (select 1 from public.suppliers s where s.id = v_supplier and s.organization_id = p_organization_id) then
          raise exception 'Regel %: leverancier niet gevonden.', v_n using errcode = '02000';
        end if;
      end if;
      if v_project is not null
         and not exists (select 1 from public.projects p where p.id = v_project and p.organization_id = p_organization_id) then
        raise exception 'Regel %: project niet gevonden.', v_n using errcode = '02000';
      end if;

      -- Onthoud wat er op 1530 Te betalen omzetbelasting valt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if v_acc.id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + v_amt;
      end if;

      -- De kant volgt het geld van DEZE regel: geld erbij → tegenregel credit.
      -- De btw kijkt naar vat_codes.kind én naar de aard van de rekening
      -- (zoals sinds 20261104010000), per regel in plaats van per transactie.
      -- TOEGEVOEGD (20261118090000): op eigen vermogen (privé-opnamen en
      -- -stortingen) hoort geen btw. Wie in het scherm eerst 4500 koos (code
      -- HOOG) en daarna 0550 Privé-opnamen, hield de code; dan boekte een
      -- privé-uitgave van € 121 € 21 voorbelasting, die in rubriek 5b terugkwam.
      if v_acc.type = 'equity' and coalesce(v_rate, 0) <> 0 then
        raise exception 'Regel %: op % · % (eigen vermogen) hoort geen btw. Geld voor jezelf of uit eigen zak heeft geen btw, en op privé-uitgaven trek je geen voorbelasting af. Kies "Geen btw".',
          v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;

      v_is_credit := v_bank_amt > 0;
      v_gross := abs(v_amt);
      v_base := null;
      if v_kor and v_vkind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') then
        -- TOEGEVOEGD (20261118090000): ook met de KOR geef je verlegde btw aan
        -- (2a/4a/4b) en betaal je hem, maar aftrekken kan niet: de btw komt bij
        -- de kosten, zoals bij een inkoopfactuur. De grondslag blijft het
        -- bedrag dat de leverancier kreeg.
        v_vat := round(v_gross * v_rate / 100.0);
        v_net := v_gross + v_vat;
        v_base := v_gross;
        if v_is_credit then
          v_vat_1520 := v_vat_1520 - v_vat;
        else
          v_vat_1520 := v_vat_1520 + v_vat;
        end if;
      elsif v_kor and v_vkind not in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') and coalesce(v_rate, 0) <> 0 then
        -- TOEGEVOEGD (20261118090000): KOR, geen btw. Het hele bedrag gaat op
        -- de rekening en de regel krijgt de code KOR, die in geen rubriek
        -- telt. Een 0%-code (vrijgesteld, export, ICP) blijft zoals gekozen.
        v_net := v_gross;
        v_vat := 0;
        v_vcode := v_kor_code;
        v_rate := 0;
      elsif v_vkind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') then
        -- Verlegd/EU-verwerving/invoer: het volle bedrag is de grondslag; btw
        -- zelf aangeven én aftrekken.
        v_net := v_gross;
        v_vat := round(v_gross * v_rate / 100.0);
        if v_is_credit then
          v_vat_1500 := v_vat_1500 - v_vat;
          v_vat_1520 := v_vat_1520 - v_vat;
        else
          v_vat_1500 := v_vat_1500 + v_vat;
          v_vat_1520 := v_vat_1520 + v_vat;
        end if;
      else
        -- Inclusief-btw-splitsing (bruto → netto + btw), centneutraal.
        v_net := round(v_gross / (1 + v_rate / 100.0));
        v_vat := v_gross - v_net;
        if v_acc.type = 'revenue' then
          v_vat_1510 := v_vat_1510 + case when v_is_credit then v_vat else -v_vat end;
        elsif v_acc.type in ('expense', 'asset') then
          v_vat_1500 := v_vat_1500 + case when v_is_credit then -v_vat else v_vat end;
        else
          if v_is_credit then
            v_vat_1510 := v_vat_1510 + v_vat;
          else
            v_vat_1500 := v_vat_1500 + v_vat;
          end if;
        end if;
      end if;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acc.id,
        'description', coalesce(v_line_desc, nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''),
                                case when v_is_credit then 'Ontvangst' else 'Betaling' end),
        'debit_cents', case when v_is_credit then 0 else v_net end,
        'credit_cents', case when v_is_credit then v_net else 0 end,
        'vat_code', v_vcode, 'vat_rate', v_rate,
        -- Rubriekconsistentie: op omzetregels telt compute_vat_return
        -- vat_amount_cents op naast credit−debit; een debet-omzetregel
        -- (terugbetaling) moet dus een negatieve grondslag/btw dragen.
        'vat_base_cents', case when v_acc.type = 'revenue' and not v_is_credit then -coalesce(v_base, v_net) else coalesce(v_base, v_net) end,
        'vat_amount_cents', case when v_acc.type = 'revenue' and not v_is_credit then -v_vat else v_vat end,
        'client_id', v_client, 'supplier_id', v_supplier, 'project_id', v_project
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'ledger', 'account_id', v_acc.id, 'vat_code', v_vcode,
        'client_id', v_client, 'supplier_id', v_supplier, 'project_id', v_project,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
    end if;
  end loop;

  if jsonb_array_length(v_alloc) = 0 then
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;
  if v_sum <> v_abs then
    raise exception 'De regels tellen op tot %, maar de transactie is %. Verdeel precies het hele bedrag (verschil %).',
      public.bank_eur(v_sum), public.bank_eur(v_abs), public.bank_eur(abs(v_abs - v_sum))
      using errcode = '23514';
  end if;

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

  v_entry := public.post_journal_entry(
    p_organization_id, v_date, v_desc, 'payment', v_txn.id, v_lines, p_created_by
  );

  -- De verdeling eerst: de trigger op bank_transactions rekent de betaalstatus
  -- van inkoopfacturen hiermee uit.
  insert into public.bank_transaction_allocations(
    organization_id, bank_transaction_id, journal_entry_id, position, kind,
    invoice_id, credit_note_id, purchase_invoice_id, account_id, vat_code,
    client_id, supplier_id, project_id, amount_cents, description, created_by
  )
  select
    p_organization_id, v_txn.id, v_entry.id, (e.ord - 1)::integer, e.a->>'kind',
    public.bank_parse_uuid(e.a->>'invoice_id'), public.bank_parse_uuid(e.a->>'credit_note_id'),
    public.bank_parse_uuid(e.a->>'purchase_invoice_id'), public.bank_parse_uuid(e.a->>'account_id'),
    nullif(e.a->>'vat_code', ''),
    public.bank_parse_uuid(e.a->>'client_id'), public.bank_parse_uuid(e.a->>'supplier_id'), public.bank_parse_uuid(e.a->>'project_id'),
    (e.a->>'amount_cents')::bigint, nullif(e.a->>'description', ''), p_created_by
  from jsonb_array_elements(v_alloc) with ordinality as e(a, ord);

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed, en alleen
  -- als dat één factuur was (voor wie ze nog leest). Rekenen gaat via de verdeling.
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = case when cardinality(v_sales_invoice_ids) = 1 then v_sales_invoice_ids[1] end,
    matched_purchase_invoice_id = case when cardinality(v_pi_ids) = 1 then v_pi_ids[1] end,
    booking_date = v_date,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- Volledig betaald → betaald. Anders liep de factuur naar "achterstallig" en
  -- kreeg de klant herinneringen voor een al betaalde factuur.
  update public.invoices i
  set status = 'paid',
      paid_at = coalesce(i.paid_at, (v_date::timestamp + time '12:00') at time zone 'Europe/Amsterdam'),
      updated_at = now()
  where i.organization_id = p_organization_id
    and i.id = any(v_inv_ids)
    and i.status in ('sent', 'overdue')
    and public.invoice_open_receivable_cents(p_organization_id, i.id) <= 0;

  for v_id in select distinct x from unnest(v_pi_ids) as x
  loop
    perform public.refresh_purchase_invoice_payment_status(p_organization_id, v_id);
  end loop;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- Altijd op het AFGERONDE saldo (hele euro's); alleen bij één aangifte.
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
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Btw-aangifte: geen tijdvak dat nog loopt, en alleen de eigen frequentie
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_expected_to >= current_date then
    raise exception 'Dit tijdvak loopt nog tot en met %. Afsluiten kan vanaf %, net als de aangifte bij de Belastingdienst.',
      to_char(v_expected_to, 'DD-MM-YYYY'), to_char(v_expected_to + 1, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261118090000): alleen in de frequentie die bij Instellingen
  -- staat. Wie per kwartaal aangifte doet en toch januari afsloot, kon Q1 daarna
  -- niet meer afsluiten (overlap), en de jaarafsluiting eist juist kwartalen:
  -- dat jaar kwam nooit meer dicht.
  select coalesce(cs.vat_return_period, 'quarterly') into v_frequency
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_frequency := coalesce(v_frequency, 'quarterly');
  if (v_frequency = 'monthly') <> (p_period_type = 'month') then
    raise exception 'Je doet btw-aangifte per %, dus sluit je per % af. Klopt dat niet meer, pas het dan eerst aan bij Instellingen → Bedrijf.',
      case when v_frequency = 'monthly' then 'maand' else 'kwartaal' end,
      case when v_frequency = 'monthly' then 'maand' else 'kwartaal' end
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
      'BTW-aangifte doorboeken ' || p_period_type || ' ' || p_period_index || '-' || p_year,
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Jaarafsluiting: geplande afschrijvingen en termijnen eerst, en een
--    beginbalans van vóór het eerste boekjaar blokkeert niets
-- ═══════════════════════════════════════════════════════════════════════════
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
  v_partnership boolean := false;
  v_share_total integer := 0;
  v_capital uuid;
  s record;
  v_open_dep integer := 0;
  v_open_dep_names text;
  v_open_prepaid integer := 0;
  v_open_prepaid_names text;
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
  if v_fy.period_end >= current_date then
    raise exception 'Dit boekjaar loopt nog tot en met %; afsluiten kan vanaf de dag daarna.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Sequentiële volgorde: geen geboekte transacties vóór dit boekjaar die niet in
  -- een afgesloten jaar-slot vallen (dus het voorgaande boekjaar moet dicht zijn).
  if exists (
    select 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      -- GEWIJZIGD (20261118090000): een beginbalans van vóór het eerste
      -- boekjaar (per 31-12) is geen boekjaar dat nog dicht moet. Die liet het
      -- eerste jaar nooit afsluiten: "sluit eerst het voorgaande boekjaar af",
      -- terwijl er geen voorgaand boekjaar bestond.
      and je.source_type not in ('year_close', 'opening_balance')
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

    -- Het privé van elke vennoot (ook een vertrokken vennoot) gaat naar zijn
    -- eigen kapitaal.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Desinvestering: eerst afschrijven tot de verkoopdatum
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.book_asset_disposal(p_organization_id uuid, p_asset_id uuid, p_counter_account_id uuid, p_proceeds_cents bigint DEFAULT 0, p_disposal_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid(), p_vat_code text DEFAULT NULL::text)
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_vc public.vat_codes;
  v_vat bigint := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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

  -- TOEGEVOEGD (20261118090000): eerst de afschrijving tot de verkoopdatum.
  -- Zonder dat rekende de desinvestering met wat er toevallig al geboekt was,
  -- en verdwenen de geplande termijnen: een camera die op 30 juni werd
  -- verkocht en t/m december was afgeschreven, gaf € 650 boekverlies in plaats
  -- van € 250 afschrijving en € 400 verlies.
  if exists (
    select 1 from public.asset_depreciations ad
    where ad.asset_id = p_asset_id and ad.status = 'scheduled' and ad.date <= v_disposal_date
  ) then
    perform public.post_asset_depreciation(p_organization_id, p_asset_id, v_disposal_date, p_created_by);
  end if;

  -- Opgebouwde afschrijving = som van de GEBOEKTE afschrijvingen van dit activum.
  select coalesce(sum(amount_cents), 0) into v_accumulated
  from public.asset_depreciations
  where asset_id = p_asset_id and status = 'posted';

  v_book_value := v_asset.acquisition_cost_cents - v_accumulated;
  v_result := v_proceeds - v_book_value;

  -- TOEGEVOEGD (20261105233000): de verkoop van een bedrijfsmiddel is een
  -- belaste levering (art. 1 onderdeel a Wet OB 1968). De opbrengst is
  -- exclusief btw; de btw gaat naar 1510 en, met code en grondslag op die
  -- regel, naar rubriek 1a/1b. Eerder bestond er geen btw bij een verkoop: wie
  -- het brutobedrag invulde, boekte de btw als boekwinst.
  if p_vat_code is not null and btrim(p_vat_code) <> '' and v_proceeds > 0 then
    select * into v_vc from public.vat_codes
    where organization_id = p_organization_id and code = btrim(p_vat_code);
    if not found then
      raise exception 'Btw-code % bestaat niet in deze administratie.', p_vat_code using errcode = '23514';
    end if;
    if v_vc.sales_box in ('1a', '1b', '1c', '1d') then
      v_vat := round(v_proceeds * coalesce(v_vc.rate, 0) / 100.0)::bigint;
    elsif v_vc.sales_box is distinct from '1e' and v_vc.kind not in ('exempt', 'zero', 'kor') then
      raise exception 'Btw-code % is geen code voor een verkoop in Nederland; kies bijvoorbeeld HOOG, LAAG of VRIJ.', p_vat_code using errcode = '23514';
    end if;
  end if;

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

  -- c) Opbrengst (debet tegenrekening: bank/debiteuren), inclusief btw.
  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', p_counter_account_id, 'description', 'Opbrengst verkoop ' || v_asset.name,
      'debit_cents', v_proceeds + v_vat, 'credit_cents', 0));
  end if;

  -- c2) Btw over de opbrengst, met code en grondslag (zie compute_vat_boxes).
  if v_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Btw verkoop ' || v_asset.name,
      'debit_cents', 0, 'credit_cents', v_vat,
      'vat_code', v_vc.code, 'vat_rate', v_vc.rate,
      'vat_base_cents', v_proceeds, 'vat_amount_cents', v_vat));
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

  v_book_date := public.first_open_booking_date_for(p_organization_id, v_disposal_date, public.journal_lines_touch_vat(p_organization_id, v_lines));
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
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8a. De eerste boekjaren openen
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Vanaf de startdatum van de boekhouding (of het begin van het lopende
-- boekjaar) tot en met het boekjaar van vandaag, en alleen als er nog geen
-- boekjaar is. Bij een IB-onderneming is het boekjaar het kalenderjaar (de
-- winst wordt per kalenderjaar bepaald); de startmaand telt dan niet. De
-- inrichting roept dit aan, en de knop "Boekhouding inrichten" op de
-- financiële pagina's ook.
create or replace function public.open_initial_fiscal_years(p_organization_id uuid, p_created_by uuid default auth.uid())
returns setof public.fiscal_years
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start date;
  v_month integer;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_s date;
  v_e date;
  v_fy public.fiscal_years;
  v_n integer := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- Eén tegelijk, en niets als er al een boekjaar is.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':eerste-boekjaren'));
  if exists (select 1 from public.fiscal_years f where f.organization_id = p_organization_id) then
    return;
  end if;

  select cs.bookkeeping_start_date,
         case when public.org_fiscal_regime(p_organization_id) = 'ib' then 1
              else coalesce(cs.fiscal_year_start_month, 1) end
    into v_start, v_month
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_month := coalesce(v_month, 1);
  if v_start is null then
    v_start := make_date(
      case when extract(month from v_today)::int >= v_month then extract(year from v_today)::int
           else extract(year from v_today)::int - 1 end,
      v_month, 1);
  end if;

  v_s := v_start;
  loop
    -- Het einde van het boekjaar waarin v_s valt: de dag vóór de volgende
    -- startmaand. Een begindatum midden in het jaar geeft een kort eerste jaar.
    v_e := (make_date(
      case when extract(month from v_s)::int >= v_month then extract(year from v_s)::int
           else extract(year from v_s)::int - 1 end,
      v_month, 1) + interval '1 year' - interval '1 day')::date;
    v_fy := public.open_fiscal_year(p_organization_id, v_s, v_e, null, p_created_by);
    return next v_fy;
    v_n := v_n + 1;
    v_s := v_e + 1;
    -- Tot en met het lopende boekjaar; nooit meer dan tien in één keer (een
    -- startdatum met een tikfout in het jaartal).
    exit when v_s > v_today or v_n >= 10;
  end loop;
end;
$function$;

revoke all on function public.open_initial_fiscal_years(uuid, uuid) from public, anon;
grant execute on function public.open_initial_fiscal_years(uuid, uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Inrichting afronden zet de boekhouding klaar
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.complete_organization_onboarding(p_organization_id uuid, p_display_name text DEFAULT NULL::text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org public.organizations;
  v_company_name text;
  v_trade_name text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt' using errcode = '22023';
  end if;
  -- De organisatie komt uit de aanroep, de rol uit de sessie (auth.uid()).
  -- Wie geen lid is, krijgt dezelfde melding als wie de verkeerde rol heeft:
  -- zo is dit geen manier om na te gaan welke organisaties er bestaan.
  if not public.user_has_org_role(p_organization_id, array['owner', 'admin']) then
    raise exception 'Alleen de eigenaar of een beheerder kan de organisatie inrichten.'
      using errcode = '42501';
  end if;

  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found then
    raise exception 'Organisatie niet gevonden' using errcode = 'P0002';
  end if;
  -- Al afgerond, in een ander tabblad of met een dubbele klik: niets te doen.
  if v_org.onboarding_completed_at is not null then
    return v_org;
  end if;

  select nullif(btrim(cs.company_name), ''), nullif(btrim(cs.trade_name), '')
    into v_company_name, v_trade_name
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
  if v_company_name is null then
    raise exception 'Vul eerst de naam van je bedrijf in.' using errcode = '23514';
  end if;

  -- Het webadres voor de klanten (klantportaal, albums, offertes, facturen)
  -- kies je bij het inrichten, niet later: elke mail aan een klant linkt
  -- ernaar.
  if not exists (
    select 1 from public.client_subdomains s
     where s.organization_id = p_organization_id and s.status = 'active'
  ) then
    raise exception 'Kies eerst het webadres voor je klanten.' using errcode = '23514';
  end if;

  -- De naam in ResoFly: wat de app meegeeft (de handelsnaam of de
  -- bedrijfsnaam), anders die uit de bedrijfsgegevens. Op één regel en
  -- hooguit 120 tekens, net als in de organisatiekiezer.
  v_name := left(btrim(regexp_replace(
    coalesce(nullif(btrim(p_display_name), ''), v_trade_name, v_company_name),
    '[[:cntrl:]]+', ' ', 'g')), 120);

  update public.organizations
     set onboarding_completed_at = now(),
         onboarding_completed_by = v_user_id,
         name = coalesce(nullif(v_name, ''), name)
   where id = p_organization_id
  returning * into v_org;

  -- TOEGEVOEGD (20261118090000): na de stap "Btw en boekhouding" staat de
  -- boekhouding klaar: het rekeningschema en het boekjaar vanaf de startdatum.
  -- Een zzp'er die net was ingericht, kwam bij Grootboek, Omzetbelasting en
  -- Boekjaren eerst op "Boekhouding nog niet ingericht", en bij Eigen vermogen
  -- op "Maak eerst een boekjaar aan", zonder knop. Gaat dit mis, dan is de
  -- inrichting wel af: de knop op die pagina's doet daarna hetzelfde.
  begin
    perform public.ensure_default_ledger_accounts(p_organization_id);
    perform public.open_initial_fiscal_years(p_organization_id, v_user_id);
  exception when others then
    raise warning 'Boekhouding klaarzetten bij het inrichten van % lukte niet: %', p_organization_id, sqlerrm;
  end;

  return v_org;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. De resultaatrekening volgt de rechtsvorm
-- ═══════════════════════════════════════════════════════════════════════════
--
-- De kolom heeft als standaard 0510 Onverdeeld resultaat; de inrichting zet bij
-- een eenmanszaak 0500 Eigen vermogen. Een administratie van vóór de
-- inrichtingsstappen, of een wissel van rechtsvorm in Instellingen of via
-- Gerrie, hield 0510. Het totaal klopte, maar op de balans stond dan een
-- negatief "Eigen vermogen" (de opnamen) naast een groeiend "Onverdeeld
-- resultaat". Bij een eenmanszaak is alle winst van de ondernemer.
--
-- Wisselt de rechtsvorm en stond de rekening nog op de standaard van de oude
-- rechtsvorm, dan gaat hij mee naar die van de nieuwe. Een bewuste andere
-- keuze (in dezelfde wijziging, of eerder) blijft staan.
create or replace function public.company_settings_result_account_follows_legal_form()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.legal_form is distinct from old.legal_form
     and new.year_result_account_code is not distinct from old.year_result_account_code
     and old.year_result_account_code = (case when coalesce(old.legal_form, 'eenmanszaak') = 'eenmanszaak' then '0500' else '0510' end) then
    new.year_result_account_code := case when coalesce(new.legal_form, 'eenmanszaak') = 'eenmanszaak' then '0500' else '0510' end;
  end if;
  return new;
end;
$function$;

drop trigger if exists company_settings_result_account_follows_legal_form on public.company_settings;
create trigger company_settings_result_account_follows_legal_form
  before update of legal_form on public.company_settings
  for each row execute function public.company_settings_result_account_follows_legal_form();

revoke all on function public.company_settings_result_account_follows_legal_form() from public, anon, authenticated;

-- Bestaande eenmanszaken op 0510 die nog nooit een jaar naar 0510 afsloten:
-- daar staat niets op, dus 0500 verandert niets aan de cijfers.
update public.company_settings cs
set year_result_account_code = '0500'
where cs.legal_form = 'eenmanszaak'
  and cs.year_result_account_code = '0510'
  and not exists (
    select 1 from public.fiscal_years fy
    where fy.organization_id = cs.organization_id
      and fy.status = 'closed'
      and fy.result_account_code = '0510'
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Rekeningschema van een IB-onderneming
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Een eenmanszaak kreeg één kostenrekening (4500 Algemene kosten). De aangifte
-- inkomstenbelasting vraagt de kosten uitgesplitst (auto en vervoer,
-- huisvesting, verkoop, inkoopwaarde, andere kosten), en eten, drinken en
-- representatie zijn maar beperkt aftrekbaar (drempel of 80%). Zonder eigen
-- rekening is dat bedrag nergens terug te vinden. Kas erbij: een contante
-- betaling leg je vast als mutatie op een kasrekening, en verdeel je net als
-- bij de bank over je facturen.
--
-- De btw-code is alleen een voorstel. Bij huur (meestal vrijgesteld) en auto
-- (brandstof 21%, ov 9%, verzekering vrijgesteld) staat er bewust geen: een
-- verkeerde standaardcode geeft voorbelasting die er niet is. Bij eten en
-- drinken ook niet: btw op eten en drinken in de horeca trek je niet af.
create or replace function public.ensure_default_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_regime text;
  v_equity_name text;
  v_equity_subtype text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  v_regime := public.org_fiscal_regime(p_organization_id);

  if v_regime = 'vpb' then
    v_equity_name := 'Geplaatst en gestort aandelenkapitaal';
    v_equity_subtype := 'share_capital';
  else
    v_equity_name := 'Eigen vermogen';
    v_equity_subtype := 'equity';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values
    (p_organization_id, '0100', 'Vaste activa', 'asset', 'fixed_asset', null, true, 'materiele_vaste_activa'),
    (p_organization_id, '0150', 'Cumulatieve afschrijving', 'asset', 'accumulated_depreciation', null, true, 'materiele_vaste_activa'),
    (p_organization_id, '0500', v_equity_name, 'equity', v_equity_subtype, null, true, 'eigen_vermogen'),
    (p_organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', null, true, 'eigen_vermogen'),
    (p_organization_id, '1100', 'Bank', 'asset', 'bank', null, true, 'liquide_middelen'),
    (p_organization_id, '1102', 'Kruisposten Mollie/PSP', 'asset', 'psp_clearing', null, true, 'vorderingen'),
    (p_organization_id, '1300', 'Debiteuren', 'asset', 'accounts_receivable', null, true, 'vorderingen'),
    (p_organization_id, '1500', 'Te vorderen BTW (voorbelasting)', 'asset', 'vat_input', null, true, 'vorderingen'),
    (p_organization_id, '1510', 'Af te dragen BTW (verkoop)', 'liability', 'vat_output', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1520', 'Af te dragen BTW verlegd/ICP', 'liability', 'vat_reverse', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1530', 'Te betalen omzetbelasting', 'liability', 'vat_payable', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1600', 'Crediteuren', 'liability', 'accounts_payable', null, true, 'kortlopende_schulden'),
    (p_organization_id, '4000', 'Afschrijvingskosten', 'expense', 'depreciation', null, true, 'afschrijvingen'),
    (p_organization_id, '4130', 'Betaalproviderkosten', 'expense', 'payment_fees', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4500', 'Algemene kosten', 'expense', 'general_cost', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4900', 'Afrondingsverschillen', 'expense', 'rounding', null, true, 'overige_bedrijfskosten'),
    (p_organization_id, '8000', 'Omzet hoog (21%)', 'revenue', 'sales', 'HOOG', false, 'netto_omzet'),
    (p_organization_id, '8010', 'Omzet laag (9%)', 'revenue', 'sales', 'LAAG', false, 'netto_omzet'),
    (p_organization_id, '8020', 'Omzet 0% / vrijgesteld', 'revenue', 'sales', 'NUL', false, 'netto_omzet'),
    (p_organization_id, '8030', 'Omzet buitenland (ICP/verlegd)', 'revenue', 'sales', 'ICP_DIENST', false, 'netto_omzet')
  on conflict (organization_id, code) do nothing;

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen bij een
  -- IB-onderneming. Herkenning gaat op het subtype, niet op de code: heeft een
  -- administratie 0550 of 0560 al voor iets anders in gebruik, dan blijft die
  -- rekening ongemoeid en telt hij niet als privé.
  if v_regime = 'ib' then
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values
      (p_organization_id, '0550', 'Privé-opnamen', 'equity', 'private_withdrawals', null, true, 'eigen_vermogen'),
      (p_organization_id, '0560', 'Privé-stortingen', 'equity', 'private_contributions', null, true, 'eigen_vermogen')
    on conflict (organization_id, code) do nothing;

    -- TOEGEVOEGD (20261118090000): kas en de kosten in de indeling van de
    -- aangifte inkomstenbelasting (zie de toelichting boven deze functie).
    -- Geen systeemrekeningen: naam, btw-code en actief blijven vrij.
    perform public.ensure_ib_ledger_accounts(p_organization_id);
  end if;

  insert into public.vat_codes (organization_id, code, label, rate, kind, sales_box, vat_box, is_system)
  values
    (p_organization_id, 'HOOG', 'BTW 21%', 21, 'standard', '1a', '1a', true),
    (p_organization_id, 'LAAG', 'BTW 9%', 9, 'reduced', '1b', '1b', true),
    (p_organization_id, 'NUL', 'BTW 0%', 0, 'zero', '1e', null, true),
    (p_organization_id, 'VRIJ', 'Vrijgesteld', 0, 'exempt', null, null, true),
    (p_organization_id, 'VERL_VERK', 'BTW verlegd (verkoop)', 0, 'reverse_charge_sales', '1e', null, true),
    (p_organization_id, 'VERL_INK', 'BTW verlegd (inkoop)', 21, 'reverse_charge_purchase', '2a', '5b', true),
    (p_organization_id, 'ICP_GOED', 'ICP goederen', 0, 'icp_goods', '3b', null, true),
    (p_organization_id, 'ICP_DIENST', 'ICP diensten', 0, 'icp_services', '3b', null, true),
    (p_organization_id, 'EU_VERW', 'Verwerving EU (verlegd)', 21, 'eu_acquisition', '4b', '5b', true),
    (p_organization_id, 'EXPORT', 'Export buiten EU (0%)', 0, 'zero', '3a', null, true),
    (p_organization_id, 'IMPORT', 'Invoer buiten EU (verlegd, art. 23)', 21, 'import_non_eu', '4a', '5b', true),
    (p_organization_id, 'KOR', 'KOR (vrijgesteld, geen aftrek)', 0, 'kor', null, null, true)
  on conflict (organization_id, code) do nothing;

  -- Goedkope bestaanscheck eerst (unieke index op organization_id, code), en
  -- daarna pas de module-vraag: in de normale situatie kost dit één indexprobe.
  if v_regime = 'vpb'
     and not exists (
       select 1 from public.ledger_accounts
       where organization_id = p_organization_id and code = '0505'
     )
     and public.org_has_business(p_organization_id) then
    perform public.ensure_business_ledger_accounts(p_organization_id);
  end if;
end;
$function$;

-- Intern (zonder eigen rechtencontrole): alleen vanuit
-- ensure_default_ledger_accounts en hieronder, voor bestaande administraties.
create or replace function public.ensure_ib_ledger_accounts(p_organization_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values
    (p_organization_id, '1000', 'Kas', 'asset', 'cash', null, false, 'liquide_middelen'),
    (p_organization_id, '4100', 'Huisvestingskosten', 'expense', 'housing', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4200', 'Auto- en vervoerskosten', 'expense', 'car_transport', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4300', 'Kantoor- en communicatiekosten', 'expense', 'office', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4400', 'Verkoop- en reclamekosten', 'expense', 'selling', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4600', 'Eten, drinken en representatie (beperkt aftrekbaar)', 'expense', 'mixed_costs', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4700', 'Opleiding en vakliteratuur', 'expense', 'education', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '7000', 'Inkoopwaarde en uitbesteed werk', 'expense', 'cost_of_sales', 'HOOG', false, 'inkoopwaarde')
  on conflict (organization_id, code) do nothing;
$function$;

revoke all on function public.ensure_ib_ledger_accounts(uuid) from public, anon, authenticated;
grant execute on function public.ensure_ib_ledger_accounts(uuid) to service_role;

-- Bestaande IB-administraties met een rekeningschema krijgen ze nu ook.
do $$
declare
  r record;
begin
  for r in
    select distinct la.organization_id
    from public.ledger_accounts la
    where public.org_fiscal_regime(la.organization_id) = 'ib'
  loop
    perform public.ensure_ib_ledger_accounts(r.organization_id);
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. KOR op facturen en offertes: de code KOR op elke 0%-regel zonder code
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Met de KOR kreeg een nieuwe regel 0% zonder code (de editor bood KOR niet
-- aan). Gevolg: de pdf zei "Btw 0% over € 450,00 — € 0,00" zonder reden, de
-- vermelding van de kleineondernemersregeling ontbrak (die volgt uit de code),
-- en de omzet viel via de terugval op het tarief in rubriek 1e. Met de code
-- KOR staat de vermelding erop en telt de omzet in geen rubriek. Alleen
-- regels zonder code: een bewuste 0%-code (export, ICP, vrijgesteld) blijft.
create or replace function public.kor_code_on_zero_lines(p_organization_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_code text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return p_lines;
  end if;
  select vc.code into v_code from public.vat_codes vc
  where vc.organization_id = p_organization_id and vc.kind = 'kor' and coalesce(vc.is_active, true)
  order by (vc.code = 'KOR') desc, vc.code
  limit 1;
  if v_code is null then
    return p_lines;
  end if;
  return (
    select coalesce(jsonb_agg(
      case
        when jsonb_typeof(t.l) = 'object'
         and coalesce(btrim(t.l->>'vat_code'), '') = ''
         and (case when coalesce(t.l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (t.l->>'vat')::numeric else 0 end) = 0
          then t.l || jsonb_build_object('vat_code', v_code)
        else t.l
      end order by t.n), '[]'::jsonb)
    from jsonb_array_elements(p_lines) with ordinality as t(l, n)
  );
end;
$function$;

revoke all on function public.kor_code_on_zero_lines(uuid, jsonb) from public, anon;
grant execute on function public.kor_code_on_zero_lines(uuid, jsonb) to authenticated, service_role;

create or replace function public.enforce_invoice_kor_no_vat()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_kor boolean;
begin
  if new.status in ('cancelled', 'void') then return new; end if;
  -- Alleen bij uitgeven (nieuw of vanuit concept); een uitgegeven factuur ligt al vast.
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
  select coalesce(kor_enabled, false) into v_kor
    from public.company_settings where organization_id = new.organization_id;
  if not coalesce(v_kor, false) then return new; end if;
  -- TOEGEVOEGD (20261118090000): 0% zonder code wordt KOR, ook in een concept,
  -- zodat de conceptpdf in de app al de juiste vermelding toont.
  new.lines := public.kor_code_on_zero_lines(new.organization_id, new.lines);
  if new.status = 'draft' then return new; end if;
  if exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
        where case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end <> 0) then
    raise exception 'Je gebruikt de kleineondernemersregeling (KOR): een factuur rekent dan geen btw. Zet de btw van elke regel op 0%% (code KOR) en verstuur opnieuw.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function public.enforce_quote_kor_no_vat()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_kor boolean;
begin
  -- TOEGEVOEGD (20261118090000): zolang de offerte niet bij de klant is
  -- (concept of interne goedkeuring), krijgt een 0%-regel zonder code de code
  -- KOR, zodat de offerte-pdf de vermelding toont.
  if tg_op = 'INSERT' or old.status in ('draft', 'pending_internal_approval', 'internally_approved') then
    select coalesce(kor_enabled, false) into v_kor
      from public.company_settings where organization_id = new.organization_id;
    if coalesce(v_kor, false) then
      new.lines := public.kor_code_on_zero_lines(new.organization_id, new.lines);
    end if;
  end if;

  if new.status not in ('pending_internal_approval', 'internally_approved') then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  if v_kor is null then
    select coalesce(kor_enabled, false) into v_kor
      from public.company_settings where organization_id = new.organization_id;
  end if;
  if coalesce(v_kor, false) and exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
        where case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end <> 0) then
    raise exception 'Je gebruikt de kleineondernemersregeling (KOR): een offerte rekent dan geen btw. Zet de btw van elke regel op 0%% (code KOR); anders kun je de factuur die eruit komt niet versturen.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- De offerte-trigger keek alleen naar de status; nu ook naar de regels.
drop trigger if exists quotes_kor_no_vat on public.quotes;
create trigger quotes_kor_no_vat
  before insert or update of status, lines on public.quotes
  for each row execute function public.enforce_quote_kor_no_vat();

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. "Op betaald zetten": de juiste weg
-- ═══════════════════════════════════════════════════════════════════════════
--
-- De melding zei "boek de ontvangst bij de bank (of met een memoriaalpost)".
-- Een memoriaalpost op Debiteuren hoort bij geen enkele factuur
-- (invoice_open_receivable_cents telt bank, Mollie en creditnota's): de
-- factuur bleef open, de herinneringen liepen door en er kwam een aanmaning
-- met incassokosten voor een klant die contant had betaald.
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
      raise exception 'Factuur % staat in het grootboek en er staat nog € % open. Leg de ontvangst vast bij Bank (Mutatie invoeren, en verdeel hem op deze factuur); contant ontvangen gaat net zo, op een kasrekening. Dan gaat de factuur vanzelf op betaald.',
        coalesce(new.number, ''), replace(to_char(v_open / 100.0, 'FM999999990.00'), '.', ',')
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Btw-tijdvakken met een aangifte, voor de herinnering op het dashboard
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Het dashboard telde aangiftes met status "doorgeboekt", terwijl afsluiten in
-- het scherm ze meteen op "ingediend" zet: de herinnering kwam vrijwel nooit.
-- Nu rekent de app (src/lib/vatPeriods.ts) welke afgelopen tijdvakken nog geen
-- aangifte hebben. Daarvoor alleen de tijdvakken, niet de hele tabel: die hoort
-- bij de boekhouding, die het dashboard bewust niet laadt
-- (src/lib/dataGroups.ts).
create or replace function public.list_filed_vat_periods(p_organization_id uuid)
returns table(period_type text, year integer, period_index integer)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  return query
    select vr.period_type::text, vr.year::integer, vr.period_index::integer
    from public.vat_returns vr
    where vr.organization_id = p_organization_id
      and vr.supplements_return_id is null
      and vr.year >= extract(year from current_date)::integer - 2;
end;
$function$;

revoke all on function public.list_filed_vat_periods(uuid) from public, anon;
grant execute on function public.list_filed_vat_periods(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rechten
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Elke functie uit deze migratie expliciet dicht voor anon
-- (supabase/functions/_shared/migrationGrants.test.ts), met dezelfde rechten
-- als ervoor: de RPC's voor ingelogde gebruikers (die controleren zelf de
-- rechten op organisatie en module), de triggerfuncties alleen intern (een
-- trigger vuurt ook zonder EXECUTE).
revoke all on function public.owners_equity_overview(uuid, uuid) from public, anon;
grant execute on function public.owners_equity_overview(uuid, uuid) to authenticated, service_role;
revoke all on function public.book_asset_acquisition(uuid, uuid, uuid, date, uuid) from public, anon;
grant execute on function public.book_asset_acquisition(uuid, uuid, uuid, date, uuid) to authenticated, service_role;
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid, jsonb, text) to authenticated, service_role;
revoke all on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) from public, anon;
grant execute on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) to authenticated, service_role;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid, text) from public, anon;
grant execute on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid, text) to authenticated, service_role;
revoke all on function public.complete_organization_onboarding(uuid, text) from public, anon;
grant execute on function public.complete_organization_onboarding(uuid, text) to authenticated, service_role;
revoke all on function public.ensure_default_ledger_accounts(uuid) from public, anon;
grant execute on function public.ensure_default_ledger_accounts(uuid) to authenticated, service_role;
revoke all on function public.enforce_invoice_kor_no_vat() from public, anon, authenticated;
revoke all on function public.enforce_quote_kor_no_vat() from public, anon, authenticated;
revoke all on function public.enforce_invoice_paid_needs_payment() from public, anon, authenticated;
