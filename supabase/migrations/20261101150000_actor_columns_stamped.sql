-- ============================================================
-- ResoFly — Wie iets vastlegde in de boekhouding en de registers, is wie er
-- ingelogd was
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt U).
--
-- De boekingsfuncties en de tabellen zelf namen de maker en de uitvoerder over
-- van de aanroeper: p_created_by (standaard auth.uid(), maar vrij in te vullen
-- via /rest/v1/rpc), en created_by, closed_by, filed_by enzovoort bij een
-- rechtstreekse insert of update. Wie in Financiën mocht schrijven, kon zo een
-- btw-aangifte, een jaarafsluiting, een dividendbesluit of een mutatie in het
-- aandeelhoudersregister op naam van een collega zetten.
--
-- Voor journaalposten en bankafschriften regelt een trigger dat al
-- (20261101120000). Deze migratie doet hetzelfde, met één algemene trigger,
-- voor de overige financiële tabellen en registers:
--
--   * de maker (created_by): bij aanmaken de ingelogde gebruiker, daarna vast;
--   * de uitvoerder (booked_by, closed_by, filed_by, reversed_by, ...): wie het
--     veld invult of wijzigt, is de ingelogde gebruiker.
--
-- Leegmaken mag altijd, zodat ON DELETE SET NULL blijft werken als een
-- gebruiker verdwijnt. Zonder ingelogde gebruiker (service-role, pg_cron, de
-- workers) blijft staan wat de functie meegaf: die weten zelf namens wie ze
-- werken.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- tg_argv[0] = de makerkolom, of '-' als de tabel die niet heeft.
-- tg_argv[1..] = de kolommen voor wie iets deed.
create or replace function public.stamp_actor_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_new jsonb;
  v_old jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_creator text := tg_argv[0];
  v_col text;
  i integer;
begin
  if v_uid is null then
    return new;
  end if;

  v_new := to_jsonb(new);
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
  end if;

  if v_creator <> '-' then
    if tg_op = 'INSERT' then
      v_patch := v_patch || jsonb_build_object(v_creator, v_uid);
    elsif (v_new ->> v_creator) is not null
          and (v_new -> v_creator) is distinct from (v_old -> v_creator) then
      v_patch := v_patch || jsonb_build_object(v_creator, v_old -> v_creator);
    end if;
  end if;

  for i in 1 .. tg_nargs - 1 loop
    v_col := tg_argv[i];
    if (v_new ->> v_col) is not null
       and (tg_op = 'INSERT' or (v_new -> v_col) is distinct from (v_old -> v_col)) then
      v_patch := v_patch || jsonb_build_object(v_col, v_uid);
    end if;
  end loop;

  if v_patch = '{}'::jsonb then
    return new;
  end if;
  return jsonb_populate_record(new, v_patch);
end;
$$;

revoke all on function public.stamp_actor_columns() from public, anon, authenticated;

do $$
declare
  v_spec record;
  v_cols text;
  v_args text;
begin
  for v_spec in
    select * from (values
      ('annual_accounts',          'created_by', array['prepared_by', 'adopted_by', 'filed_by', 'reversed_by']),
      ('annual_account_filings',   'created_by', array[]::text[]),
      ('bank_transactions',        '-',          array['booked_by']),
      ('closed_periods',           '-',          array['closed_by']),
      ('contract_versions',        'created_by', array[]::text[]),
      ('corporate_tax_corrections','created_by', array[]::text[]),
      ('corporate_tax_losses',     'created_by', array[]::text[]),
      ('corporate_tax_returns',    'created_by', array['finalized_by']),
      ('dga_interest_postings',    'created_by', array[]::text[]),
      ('dga_interest_rates',       'created_by', array[]::text[]),
      ('dividend_distributions',   'created_by', array['board_approved_by', 'reversed_by']),
      ('fiscal_year_size_inputs',  'created_by', array[]::text[]),
      ('fiscal_years',             'created_by', array['closed_by', 'reopened_by']),
      ('invoice_dunning_notices',  'created_by', array['confirmed_by']),
      ('invoice_payment_records',  'created_by', array[]::text[]),
      ('invoice_versions',         'created_by', array[]::text[]),
      ('quote_versions',           'created_by', array[]::text[]),
      ('result_appropriations',    'created_by', array['board_approved_by', 'reversed_by']),
      ('share_encumbrances',       'created_by', array[]::text[]),
      ('share_transactions',       'created_by', array[]::text[]),
      ('shareholders',             'created_by', array[]::text[]),
      ('vat_returns',              'created_by', array['filed_by'])
    ) as s(tbl, creator, actors)
  loop
    if to_regclass('public.' || v_spec.tbl) is null then
      continue;
    end if;

    select string_agg(quote_ident(c), ', ') into v_cols
      from unnest(case when v_spec.creator = '-' then v_spec.actors else v_spec.creator || v_spec.actors end) as c;
    select string_agg(quote_literal(a), ', ') into v_args
      from unnest(v_spec.creator || v_spec.actors) as a;

    execute format('drop trigger if exists %I on public.%I', v_spec.tbl || '_stamp_actor', v_spec.tbl);
    execute format(
      'create trigger %I before insert or update of %s on public.%I for each row execute function public.stamp_actor_columns(%s)',
      v_spec.tbl || '_stamp_actor', v_cols, v_spec.tbl, v_args
    );
  end loop;
end;
$$;

commit;
