-- ============================================================
-- ResoFly — Controle financiën en BV (4 november 2026), deel 4:
-- bewaking van activa, grootboekrekeningen, btw-codes, deellinks en het
-- aandeelhoudersregister
--
-- Uit de controle van 4 november (CHANGELOG_FINANCIEN_BV_CONTROLE_2026-11-04.md).
-- Deze tabellen zijn voor teamleden met schrijfrecht direct te wijzigen (de app
-- schrijft er zelf in). Wat de boekhouding raakt, lag alleen in de schermen
-- vast; via de API of een directe aanroep kon het toch.
--
--   1. Activa: een geboekt activum was te verwijderen (de aanschaf bleef op 0100
--      staan), boeking en status waren terug te zetten (dubbele aanschaf of
--      desinvestering) en de gebruiksduur was na afschrijven te wijzigen (meer
--      afschrijving dan de aanschafwaarde). Nu liggen die velden vast zodra er
--      iets geboekt is; boeking, status en desinvestering zet alleen de server.
--   2. Grootboekrekeningen: code, soort en subsoort waren te wijzigen, ook bij
--      systeemrekeningen en rekeningen met boekingen. Een rekening van activa
--      naar kosten zetten liet de balans van een afgesloten jaar niet meer sluiten.
--   3. Btw-codes: een gebruikte code (of een systeemcode) was om te zetten naar
--      een andere rubriek of een ander tarief. Elke latere herberekening (ook
--      suppleties over oude periodes) telde dan anders.
--   4. Deellinks van facturen: teamleden konden zelf een link-rij invoegen, ook
--      voor een factuur van een andere organisatie (die de pagina daarna wel
--      weigerde). Alleen de server maakt links; de factuur moet van dezelfde
--      organisatie zijn.
--   5. Aandeelhoudersregister: een overdracht van meer aandelen dan iemand had,
--      of een intrekking van meer ingekochte aandelen dan de vennootschap had,
--      gaf negatieve posities (en daarmee een verkeerde dividendverdeling).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Activa ────────────────────────────────────────────────────────────────

create or replace function public.enforce_fixed_asset_booked_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_booked boolean;
begin
  -- Serverfuncties (boeken, afschrijven, desinvesteren, tegenboeken) draaien
  -- als eigenaar en mogen alles; deze controle geldt voor de app en de API.
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.acquisition_journal_entry_id is not null or new.status <> 'active'
       or new.disposal_date is not null or new.disposal_proceeds_cents is not null then
      raise exception 'Boeking, status en desinvestering van een activum zet alleen de server.' using errcode = '42501';
    end if;
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.asset_account_id, new.organization_id, 'fixed_assets.asset_account_id');
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.depreciation_account_id, new.organization_id, 'fixed_assets.depreciation_account_id');
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.accumulated_depreciation_account_id, new.organization_id, 'fixed_assets.accumulated_depreciation_account_id');
    perform public.assert_same_org_reference('public.purchase_invoices'::regclass, new.source_purchase_invoice_id, new.organization_id, 'fixed_assets.source_purchase_invoice_id');
    return new;
  end if;

  v_booked := old.acquisition_journal_entry_id is not null
    or exists (select 1 from public.asset_depreciations ad where ad.asset_id = old.id and ad.status = 'posted');

  if tg_op = 'DELETE' then
    if v_booked or old.status = 'disposed' then
      raise exception 'Dit activum staat in het grootboek en kan niet worden verwijderd. Draai eerst de afschrijvingen en daarna de aanschaf terug.'
        using errcode = '23514';
    end if;
    return old;
  end if;

  if new.acquisition_journal_entry_id is distinct from old.acquisition_journal_entry_id
     or new.status is distinct from old.status
     or new.disposal_date is distinct from old.disposal_date
     or new.disposal_proceeds_cents is distinct from old.disposal_proceeds_cents then
    raise exception 'Boeking, status en desinvestering van een activum zet alleen de server.' using errcode = '42501';
  end if;

  if v_booked and (
       new.acquisition_cost_cents is distinct from old.acquisition_cost_cents
    or new.residual_value_cents is distinct from old.residual_value_cents
    or new.useful_life_months is distinct from old.useful_life_months
    or new.method is distinct from old.method
    or new.start_date is distinct from old.start_date
    or new.acquisition_date is distinct from old.acquisition_date
    or new.asset_account_id is distinct from old.asset_account_id
    or new.depreciation_account_id is distinct from old.depreciation_account_id
    or new.accumulated_depreciation_account_id is distinct from old.accumulated_depreciation_account_id) then
    raise exception 'De financiële gegevens van dit activum liggen vast: de aanschaf of een afschrijving staat in het grootboek. Draai die eerst terug om ze te wijzigen.'
      using errcode = '23514';
  end if;

  if new.asset_account_id is distinct from old.asset_account_id then
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.asset_account_id, new.organization_id, 'fixed_assets.asset_account_id');
  end if;
  if new.depreciation_account_id is distinct from old.depreciation_account_id then
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.depreciation_account_id, new.organization_id, 'fixed_assets.depreciation_account_id');
  end if;
  if new.accumulated_depreciation_account_id is distinct from old.accumulated_depreciation_account_id then
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.accumulated_depreciation_account_id, new.organization_id, 'fixed_assets.accumulated_depreciation_account_id');
  end if;
  if new.source_purchase_invoice_id is distinct from old.source_purchase_invoice_id then
    perform public.assert_same_org_reference('public.purchase_invoices'::regclass, new.source_purchase_invoice_id, new.organization_id, 'fixed_assets.source_purchase_invoice_id');
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_fixed_asset_booked_fields() from public, anon, authenticated;

drop trigger if exists fixed_assets_booked_guard on public.fixed_assets;
create trigger fixed_assets_booked_guard
  before insert or update or delete on public.fixed_assets
  for each row execute function public.enforce_fixed_asset_booked_fields();

-- ── 2. Grootboekrekeningen ───────────────────────────────────────────────────

create or replace function public.enforce_ledger_account_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.is_system then
      raise exception 'Systeemrekeningen maakt alleen de server aan.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.is_system is distinct from old.is_system then
    raise exception 'Of een rekening een systeemrekening is, bepaalt alleen de server.' using errcode = '42501';
  end if;
  if old.is_system and (
       new.code is distinct from old.code
    or new.type is distinct from old.type
    or new.subtype is distinct from old.subtype) then
    raise exception 'Bij systeemrekening % liggen code, soort en subsoort vast; de automatische boekingen zoeken hem daarop op. Naam, rubriek en standaard-btw kun je wel aanpassen.', old.code
      using errcode = '23514';
  end if;
  if (new.code is distinct from old.code
      or new.type is distinct from old.type
      or new.subtype is distinct from old.subtype)
     and exists (select 1 from public.journal_lines jl where jl.account_id = old.id) then
    raise exception 'Op rekening % is al geboekt; code en soort liggen vast (anders veranderen afgesloten jaren mee). Maak een nieuwe rekening en boek het saldo over met een memoriaalpost.', old.code
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_ledger_account_integrity() from public, anon, authenticated;

drop trigger if exists ledger_accounts_integrity_guard on public.ledger_accounts;
create trigger ledger_accounts_integrity_guard
  before insert or update on public.ledger_accounts
  for each row execute function public.enforce_ledger_account_integrity();

-- ── 3. Btw-codes ─────────────────────────────────────────────────────────────

create or replace function public.enforce_vat_code_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.is_system then
      raise exception 'Systeem-btw-codes maakt alleen de server aan.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.is_system is distinct from old.is_system then
    raise exception 'Of een btw-code een systeemcode is, bepaalt alleen de server.' using errcode = '42501';
  end if;
  if (new.code is distinct from old.code
      or new.kind is distinct from old.kind
      or new.rate is distinct from old.rate
      or new.sales_box is distinct from old.sales_box
      or new.vat_box is distinct from old.vat_box)
     and (old.is_system
          or exists (
            select 1 from public.journal_lines jl
            where jl.organization_id = old.organization_id and jl.vat_code = old.code
          )) then
    raise exception 'Btw-code % is een systeemcode of al gebruikt; code, soort, tarief en rubriek liggen vast (anders telt elke herberekening van een oude aangifte anders). Maak een nieuwe code.', old.code
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_vat_code_integrity() from public, anon, authenticated;

drop trigger if exists vat_codes_integrity_guard on public.vat_codes;
create trigger vat_codes_integrity_guard
  before insert or update on public.vat_codes
  for each row execute function public.enforce_vat_code_integrity();

-- ── 4. Deellinks van facturen ────────────────────────────────────────────────

drop policy if exists "invoice public links write by org" on public.invoice_public_links;

create or replace function public.enforce_invoice_public_links_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_same_org_reference('public.invoices'::regclass, new.invoice_id, new.organization_id, 'invoice_public_links.invoice_id');
  return new;
end;
$$;

revoke all on function public.enforce_invoice_public_links_org_integrity() from public, anon, authenticated;

drop trigger if exists invoice_public_links_org_integrity on public.invoice_public_links;
create trigger invoice_public_links_org_integrity
  before insert or update of invoice_id, organization_id on public.invoice_public_links
  for each row execute function public.enforce_invoice_public_links_org_integrity();

-- ── 5. Aandeelhoudersregister: geen negatieve posities ───────────────────────
-- Per soort aandelen moet elke houder op elke datum minstens nul aandelen
-- hebben, en de vennootschap kan niet meer ingekochte aandelen intrekken dan
-- ze heeft ingekocht. Mutaties op dezelfde dag tellen samen (de volgorde binnen
-- een dag staat niet vast).

create or replace function public.share_transactions_check_positions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_cls text;
  v_bad record;
  c_treasury constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  for v_cls in
    select distinct x.cls
    from (values
      (case when tg_op <> 'INSERT' then old.share_class end),
      (case when tg_op <> 'DELETE' then new.share_class end)
    ) as x(cls)
    where x.cls is not null
  loop
    with moves as (
      select st.to_shareholder_id as sh, st.quantity::bigint as q, st.event_date as d
      from public.share_transactions st
      where st.organization_id = v_org and st.share_class = v_cls and st.to_shareholder_id is not null
      union all
      select st.from_shareholder_id, -st.quantity::bigint, st.event_date
      from public.share_transactions st
      where st.organization_id = v_org and st.share_class = v_cls and st.from_shareholder_id is not null
      union all
      -- Ingekochte aandelen houdt de vennootschap zelf.
      select c_treasury, st.quantity::bigint, st.event_date
      from public.share_transactions st
      where st.organization_id = v_org and st.share_class = v_cls and st.kind = 'repurchase'
      union all
      select c_treasury, -st.quantity::bigint, st.event_date
      from public.share_transactions st
      where st.organization_id = v_org and st.share_class = v_cls and st.kind = 'cancellation' and st.from_shareholder_id is null
    ),
    per_day as (
      select sh, d, sum(q) as q from moves group by sh, d
    ),
    running as (
      select sh, d, sum(q) over (partition by sh order by d) as pos from per_day
    )
    select r.sh, r.d, r.pos into v_bad
    from running r
    where r.pos < 0
    order by r.d
    limit 1;

    if found then
      if v_bad.sh = c_treasury then
        raise exception 'Aandelenregister (%): op % zouden er meer ingekochte aandelen worden ingetrokken dan de vennootschap heeft.',
          v_cls, to_char(v_bad.d, 'DD-MM-YYYY') using errcode = '23514';
      end if;
      raise exception 'Aandelenregister (%): % heeft op % % aandelen; een overdracht, inkoop of intrekking kan niet meer aandelen afnemen dan iemand heeft.',
        v_cls,
        coalesce((select name from public.shareholders where id = v_bad.sh), 'deze aandeelhouder'),
        to_char(v_bad.d, 'DD-MM-YYYY'), v_bad.pos
        using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.share_transactions_check_positions() from public, anon, authenticated;

drop trigger if exists share_transactions_positions_guard on public.share_transactions;
create trigger share_transactions_positions_guard
  after insert or update or delete on public.share_transactions
  for each row execute function public.share_transactions_check_positions();

commit;
