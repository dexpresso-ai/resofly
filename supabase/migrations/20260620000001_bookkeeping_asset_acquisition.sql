-- ============================================================
-- ResoFly — Boekhouding: aanschaf van een activum naar de balans boeken
-- Date: 2026-06-20
--
-- Context:
-- De activamodule (fase 2) registreerde een activum en schreef het af, maar boekte
-- de AANSCHAF nooit naar het grootboek. Daardoor stond de afschrijving wel op de
-- balans (credit Cumulatieve afschrijving 0150) maar de aanschafwaarde niet (debet
-- Vaste activa 0100) — en zag je geen boekwaarde op de balans.
--
-- Deze migratie voegt de ontbrekende stap toe: book_asset_acquisition boekt
-- debet de activarekening / credit een gekozen tegenrekening (meestal Crediteuren
-- of Bank) voor de aanschafwaarde. Daarna vormt 0100 minus 0150 de boekwaarde.
--
-- Gebruik dit NIET als de aanschaf al via een inkoopfactuur op de activarekening
-- is geboekt — dan staat de aanschaf er al en zou dit dubbel tellen.
-- ============================================================

begin;

-- Sta het nieuwe boekstuk-brontype toe.
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition',
    'vat_return','payment','opening_balance','manual'
  ));

-- Onthoud het aanschaf-boekstuk op het activum.
alter table public.fixed_assets
  add column if not exists acquisition_journal_entry_id uuid references public.journal_entries(id) on delete set null;

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

  v_entry := public.post_journal_entry(
    p_organization_id, coalesce(p_date, v_asset.acquisition_date),
    'Aanschaf ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_acquisition', p_asset_id, v_lines, p_created_by
  );

  update public.fixed_assets set acquisition_journal_entry_id = v_entry.id where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$$;

commit;
