-- ============================================================
-- ResoFly — Financiële module, Blok C + D
-- Date: 2026-07-23
-- Bron: REVIEW_FINANCIELE_MODULE_2026-07-21.md (§6, Blok C punt 11–15, Blok D punt 16)
--
-- BLOK C — maak de aangifte kloppend:
--
--  C11 (2.1)  Verkoopfacturen droegen geen btw-code naar het grootboek: de
--             omzetrekening werd puur op het TARIEF gekozen (≥21→8000, >0→8010,
--             anders 8020) en ICP/export/verlegd/vrijgesteld viel allemaal in
--             rubriek 1e. Nu: post_sales_invoice_to_ledger leest line.vat_code,
--             kiest 8030 voor buitenland/verlegd, en schrijft de code op de
--             journaalregel zodat de aangifte erop kan classificeren.
--             book_purchase_invoice bewaart de code nu ook (was hard null).
--
--  C12 (2.4)  compute_vat_return kende alleen 1a/1b/1e/2a-op-één-hoop en las
--             vat_codes.sales_box/vat_box nergens (dode data). Nieuw hart:
--             compute_vat_boxes() levert álle rubrieken (1a–1e, 2a, 3a–3c,
--             4a/4b, 5a/5b/5c) op basis van de code-mapping, met terugval op
--             het tarief voor regels zonder code. Bonus (2.9): het formulier
--             telt in HELE EURO'S PER RUBRIEK; saldo_afgerond volgt nu die
--             telling (5a−5b uit afgeronde rubrieken) zodat app, doorboeking
--             op 1530 en bankbetaling hetzelfde bedrag zien. Valt terug op
--             saldo-afronding (oud gedrag) als de rubriek-metadata niet op het
--             grootboek aansluit (± €1) — dan waarschuwt de UI.
--             Nieuwe seed-codes: EXPORT (3a) en IMPORT (4a, art. 23-verlegging).
--
--  C13 (1.2)  Creditnota's bereikten het grootboek nooit: omzet en af te dragen
--             BTW van een gecrediteerde factuur bleven gewoon staan. Nu:
--             credit_notes.journal_entry_id + post_credit_note_to_ledger
--             (debet omzet, debet 1510, credit 1300 — spiegel van de factuur),
--             cent-exact aangesloten op het creditnota-document.
--
--  C14 (2.6)  Suppletie + memoriaal. De memoriaal-RPC bestond al
--             (post_journal_entry via de app); de UI komt in dezelfde commit.
--             Voor een te late boeking op een al ingediende periode:
--             create_vat_supplement() — kiest bestaande geboekte correctie-
--             boekstukken, berekent hun rubriek-delta, boekt het saldo door
--             naar 1530 en legt een suppletie-rij vast (supplements_return_id).
--             De verrekende boekstukken worden via vat_supplement_entries
--             uitgesloten van de reguliere aangifte — anders zouden ze in de
--             eerstvolgende periode nógmaals meetellen. Geboekte facturen met
--             een datum in een afgesloten periode kunnen nu ook eindelijk het
--             grootboek in: de boekingsdatum schuift naar de eerstvolgende
--             open datum (first_open_booking_date), met een notitie in de
--             omschrijving; de documentdatum blijft ongewijzigd.
--
--  C15 (2.5)  ICP-opgaaf: compute_icp_declaration() — intracommunautaire
--             leveringen/diensten per afnemer (btw-nummer uit clients, dat er
--             sinds 20260723100000 is), ter controle naast rubriek 3b.
--
-- BLOK D — voordat er een echte klant op gaat:
--
--  D16 (3.2)  create_opening_balance krijgt een duplicaat-guard (er kan er
--             maar één actief zijn); de invoer-UI komt in dezelfde commit.
--  D16 (3.5)  report_open_items(): openstaande debiteuren/crediteuren per
--             factuur uit het GROOTBOEK (geboekt − betaald − gecrediteerd),
--             mét aansluiting op het 1300/1600-saldo en een "niet aan een
--             factuur te koppelen"-bucket, zodat desyncs zichtbaar worden.
--  (3.1 XAF en 3.10 paginering zijn client-side; zie src/lib/xaf.ts en
--   src/lib/repository.ts in dezelfde commit.)
--
-- Verder: reverse_journal_entry weigert boekstukken die in een suppletie zijn
-- verrekend (de spiegel zou anders in de reguliere aangifte lekken terwijl het
-- origineel is uitgesloten).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Brontype 'credit_note' + btw-soort 'import_non_eu'
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition',
    'vat_return','payment','opening_balance','manual','year_close','credit_note'
  ));

alter table public.vat_codes drop constraint if exists vat_codes_kind_check;
alter table public.vat_codes
  add constraint vat_codes_kind_check check (kind in (
    'standard','reduced','zero','exempt',
    'reverse_charge_sales','reverse_charge_purchase',
    'icp_goods','icp_services','eu_acquisition','kor','import_non_eu'
  ));

-- ------------------------------------------------------------
-- 2. Seed: rubriek 3a (export buiten EU) en 4a (invoer met art. 23-verlegging)
--    hadden geen btw-code, dus die rubrieken waren onbereikbaar.
--    (Basis: 20260706120000; nieuw zijn alleen EXPORT en IMPORT.)
-- ------------------------------------------------------------
create or replace function public.ensure_default_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system)
  values
    (p_organization_id, '0100', 'Vaste activa', 'asset', 'fixed_asset', null, true),
    (p_organization_id, '0150', 'Cumulatieve afschrijving', 'asset', 'accumulated_depreciation', null, true),
    (p_organization_id, '0500', 'Eigen vermogen', 'equity', 'equity', null, true),
    (p_organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', null, true),
    (p_organization_id, '1100', 'Bank', 'asset', 'bank', null, true),
    (p_organization_id, '1300', 'Debiteuren', 'asset', 'accounts_receivable', null, true),
    (p_organization_id, '1500', 'Te vorderen BTW (voorbelasting)', 'asset', 'vat_input', null, true),
    (p_organization_id, '1510', 'Af te dragen BTW (verkoop)', 'liability', 'vat_output', null, true),
    (p_organization_id, '1520', 'Af te dragen BTW verlegd/ICP', 'liability', 'vat_reverse', null, true),
    (p_organization_id, '1530', 'Te betalen omzetbelasting', 'liability', 'vat_payable', null, true),
    (p_organization_id, '1600', 'Crediteuren', 'liability', 'accounts_payable', null, true),
    (p_organization_id, '4000', 'Afschrijvingskosten', 'expense', 'depreciation', null, true),
    (p_organization_id, '4500', 'Algemene kosten', 'expense', 'general_cost', 'HOOG', false),
    (p_organization_id, '4900', 'Afrondingsverschillen', 'expense', 'rounding', null, true),
    (p_organization_id, '8000', 'Omzet hoog (21%)', 'revenue', 'sales', 'HOOG', false),
    (p_organization_id, '8010', 'Omzet laag (9%)', 'revenue', 'sales', 'LAAG', false),
    (p_organization_id, '8020', 'Omzet 0% / vrijgesteld', 'revenue', 'sales', 'NUL', false),
    (p_organization_id, '8030', 'Omzet buitenland (ICP/verlegd)', 'revenue', 'sales', 'ICP_DIENST', false)
  on conflict (organization_id, code) do nothing;

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
end;
$$;

-- Bestaande organisaties die de boekhouding al gebruiken meteen de nieuwe codes geven.
insert into public.vat_codes (organization_id, code, label, rate, kind, sales_box, vat_box, is_system)
select distinct vc.organization_id, 'EXPORT', 'Export buiten EU (0%)', 0, 'zero', '3a', null, true
from public.vat_codes vc
on conflict (organization_id, code) do nothing;

insert into public.vat_codes (organization_id, code, label, rate, kind, sales_box, vat_box, is_system)
select distinct vc.organization_id, 'IMPORT', 'Invoer buiten EU (verlegd, art. 23)', 21, 'import_non_eu', '4a', '5b', true
from public.vat_codes vc
on conflict (organization_id, code) do nothing;

-- ------------------------------------------------------------
-- 3. first_open_booking_date: eerstvolgende datum buiten elk periodeslot.
--    Voor nagekomen documenten (factuur/creditnota gedateerd in een al
--    ingediende periode): het document houdt zijn eigen datum, de
--    JOURNAALPOST schuift naar de eerste open datum.
-- ------------------------------------------------------------
create or replace function public.first_open_booking_date(p_organization_id uuid, p_date date)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_date date := p_date;
  v_end date;
  v_guard integer := 0;
begin
  loop
    select max(cp.period_end) into v_end
    from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_start is not null and cp.period_end is not null
      and v_date between cp.period_start and cp.period_end;
    exit when v_end is null;
    v_date := v_end + 1;
    v_guard := v_guard + 1;
    if v_guard > 400 then
      raise exception 'Geen open boekperiode gevonden na %.', p_date using errcode = '23514';
    end if;
  end loop;
  return v_date;
end;
$$;

-- ------------------------------------------------------------
-- 4. Suppletie-administratie: welke boekstukken zijn in welke suppletie
--    verrekend? Verrekende boekstukken tellen NIET meer mee in de reguliere
--    aangifte (anders dubbel geclaimd). unique(entry_id): een boekstuk kan
--    maar in één suppletie zitten. Schrijven uitsluitend via de RPC.
-- ------------------------------------------------------------
create table if not exists public.vat_supplement_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplement_id uuid not null references public.vat_returns(id) on delete cascade,
  entry_id uuid not null references public.journal_entries(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint vat_supplement_entries_entry_unique unique (entry_id)
);
create index if not exists idx_vat_supplement_entries_org on public.vat_supplement_entries(organization_id, supplement_id);

alter table public.vat_supplement_entries enable row level security;
drop policy if exists "vat_supplement_entries read" on public.vat_supplement_entries;
create policy "vat_supplement_entries read" on public.vat_supplement_entries
  for select using (public.can_read_org(organization_id));
-- Bewust geen insert/update/delete-policy: alleen create_vat_supplement (security definer) schrijft.

-- vat_returns: suppleties zijn extra rijen voor dezelfde periode. De harde
-- unique(periode) geldt daarom alleen nog voor de PRIMAIRE aangifte.
alter table public.vat_returns drop constraint if exists vat_returns_unique;
create unique index if not exists vat_returns_primary_period_key
  on public.vat_returns(organization_id, period_type, year, period_index)
  where supplements_return_id is null;

-- ------------------------------------------------------------
-- 5. compute_vat_boxes: het nieuwe hart van de aangifte.
--    Grondslagen per rubriek uit de code-mapping (vat_codes.sales_box, met
--    vat_box voor de btw-kant van 1a–1d), btw-totalen gezaghebbend uit het
--    grootboek (subtypes vat_output/vat_reverse/vat_input). Regels zonder
--    code vallen terug op het tarief (oud gedrag: ≥21→1a, >0→1b, 0→1e).
--    2a/4a/4b (verlegd/verwerving/invoer) komen van kosten-/activaregels
--    met zo'n code; de grondslag staat daar in vat_base_cents.
--    p_entry_ids: reken over exact déze boekstukken (voor suppleties);
--    anders over de periode, zonder year_close en zonder boekstukken die al
--    in een suppletie verrekend zijn.
-- ------------------------------------------------------------
create or replace function public.compute_vat_boxes(
  p_organization_id uuid,
  p_from date,
  p_to date,
  p_entry_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  v_saldo bigint;
  v_saldo_afgerond bigint;
  v_box_vat_total bigint;
  v_consistent boolean;
  v_form_1a bigint; v_form_1b bigint; v_form_1c bigint; v_form_1d bigint;
  v_form_2a bigint; v_form_4a bigint; v_form_4b bigint;
  v_form_5a bigint; v_form_5b bigint; v_form_5c bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_entry_ids is null and (p_from is null or p_to is null) then
    raise exception 'Periode (van/tot) is verplicht.' using errcode = '23514';
  end if;

  with lines as (
    select
      jl.debit_cents, jl.credit_cents, jl.vat_rate, jl.vat_base_cents, jl.vat_amount_cents,
      la.type as acc_type, la.subtype as acc_subtype,
      (vc.id is not null) as has_code, vc.sales_box, vc.vat_box
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    left join public.vat_codes vc
      on vc.organization_id = jl.organization_id and vc.code = jl.vat_code
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        case when p_entry_ids is not null
          then je.id = any(p_entry_ids)
          else (
            je.date between p_from and p_to
            -- Het jaarafsluitboekstuk debiteert omzetrekeningen zonder vat_rate;
            -- zonder dit filter lekt dat als negatieve omzet in rubriek 1e.
            and je.source_type <> 'year_close'
            -- In een suppletie verrekende boekstukken zijn al aangegeven.
            and not exists (
              select 1 from public.vat_supplement_entries vse where vse.entry_id = je.id
            )
          )
        end
      )
  ),
  classified as (
    select
      -- Omzetkant: rubriek voor de grondslag. Mét code: sales_box (kan null
      -- zijn — vrijgesteld/KOR telt in geen enkele rubriek). Zonder code:
      -- terugval op het tarief.
      case when acc_type = 'revenue' then
        case
          when has_code then sales_box
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
          else '1e'
        end
      end as rev_box,
      case when acc_type = 'revenue' then credit_cents - debit_cents else 0 end as rev_base,
      -- Omzetkant: rubriek voor de btw (alleen 1a–1d dragen btw).
      case when acc_type = 'revenue' then
        case
          when has_code then (case when coalesce(vat_box, sales_box) in ('1a','1b','1c','1d') then coalesce(vat_box, sales_box) end)
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
        end
      end as rev_vat_box,
      case when acc_type = 'revenue' then coalesce(vat_amount_cents, 0) else 0 end as rev_vat,
      -- Inkoopkant: 2a (binnenland verlegd) / 4a (invoer) / 4b (EU-verwerving)
      -- van kosten-/activaregels met zo'n code. Richting volgt de boekzijde.
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then sales_box end as pur_box,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * coalesce(vat_base_cents, case when debit_cents > 0 then debit_cents else credit_cents end)
        else 0 end as pur_base,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * coalesce(vat_amount_cents, 0)
        else 0 end as pur_vat,
      -- Grootboek-totalen: gezaghebbend voor doorboeking en saldo.
      case when acc_subtype = 'vat_output' then credit_cents - debit_cents else 0 end as gl_output,
      case when acc_subtype = 'vat_reverse' then credit_cents - debit_cents else 0 end as gl_reverse,
      case when acc_subtype = 'vat_input' then debit_cents - credit_cents else 0 end as gl_input
    from lines
  )
  select
    coalesce(sum(rev_base) filter (where rev_box = '1a'), 0) as b1a_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1a'), 0) as b1a_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1b'), 0) as b1b_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1b'), 0) as b1b_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1c'), 0) as b1c_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1c'), 0) as b1c_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1d'), 0) as b1d_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1d'), 0) as b1d_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1e'), 0) as b1e_base,
    coalesce(sum(rev_base) filter (where rev_box = '3a'), 0) as b3a_base,
    coalesce(sum(rev_base) filter (where rev_box = '3b'), 0) as b3b_base,
    coalesce(sum(rev_base) filter (where rev_box = '3c'), 0) as b3c_base,
    coalesce(sum(pur_base) filter (where pur_box = '2a'), 0) as b2a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '2a'), 0) as b2a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4a'), 0) as b4a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4a'), 0) as b4a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4b'), 0) as b4b_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4b'), 0) as b4b_vat,
    coalesce(sum(gl_output), 0) as clear_output,
    coalesce(sum(gl_reverse), 0) as clear_reverse,
    coalesce(sum(gl_input), 0) as clear_input
  into r
  from classified;

  v_saldo := (r.clear_output + r.clear_reverse) - r.clear_input;

  -- Formulierwaarden: hele euro's PER RUBRIEK (rekenkundig, .50 weg van nul —
  -- zoals round(numeric)); 5a is de som van de afgeronde btw-rubrieken en 5c
  -- volgt uit 5a − 5b, precies zoals de Belastingdienst rekent (review 2.9).
  v_form_1a := round(r.b1a_vat::numeric / 100.0)::bigint;
  v_form_1b := round(r.b1b_vat::numeric / 100.0)::bigint;
  v_form_1c := round(r.b1c_vat::numeric / 100.0)::bigint;
  v_form_1d := round(r.b1d_vat::numeric / 100.0)::bigint;
  v_form_2a := round(r.b2a_vat::numeric / 100.0)::bigint;
  v_form_4a := round(r.b4a_vat::numeric / 100.0)::bigint;
  v_form_4b := round(r.b4b_vat::numeric / 100.0)::bigint;
  v_form_5a := v_form_1a + v_form_1b + v_form_1c + v_form_1d + v_form_2a + v_form_4a + v_form_4b;
  v_form_5b := round(r.clear_input::numeric / 100.0)::bigint;
  v_form_5c := v_form_5a - v_form_5b;

  -- Sluiten de rubrieken op het grootboek aan? De btw per rubriek komt uit
  -- regel-metadata (vat_amount_cents); het grootboek (1510+1520) is de waarheid.
  -- Bij een gaaf geboekte administratie zijn die exact gelijk. Wijken ze meer
  -- dan € 1 af (bijv. handmatig op 1510 geboekt zonder metadata), dan is de
  -- rubriekverdeling onvolledig: saldo_afgerond valt dan terug op het oude
  -- gedrag (saldo in één keer afronden) en de UI toont een waarschuwing.
  v_box_vat_total := r.b1a_vat + r.b1b_vat + r.b1c_vat + r.b1d_vat + r.b2a_vat + r.b4a_vat + r.b4b_vat;
  v_consistent := abs(v_box_vat_total - (r.clear_output + r.clear_reverse)) <= 100;

  if v_consistent then
    v_saldo_afgerond := v_form_5c * 100;
  else
    v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;
  end if;

  return jsonb_build_object(
    'boxes', jsonb_build_object(
      '1a', jsonb_build_object('base', r.b1a_base, 'vat', r.b1a_vat),
      '1b', jsonb_build_object('base', r.b1b_base, 'vat', r.b1b_vat),
      '1c', jsonb_build_object('base', r.b1c_base, 'vat', r.b1c_vat),
      '1d', jsonb_build_object('base', r.b1d_base, 'vat', r.b1d_vat),
      '1e', jsonb_build_object('base', r.b1e_base),
      '2a', jsonb_build_object('base', r.b2a_base, 'vat', r.b2a_vat),
      '3a', jsonb_build_object('base', r.b3a_base),
      '3b', jsonb_build_object('base', r.b3b_base),
      '3c', jsonb_build_object('base', r.b3c_base),
      '4a', jsonb_build_object('base', r.b4a_base, 'vat', r.b4a_vat),
      '4b', jsonb_build_object('base', r.b4b_base, 'vat', r.b4b_vat)
    ),
    'form', jsonb_build_object(
      '1a', jsonb_build_object('base', round(r.b1a_base::numeric / 100.0)::bigint, 'vat', v_form_1a),
      '1b', jsonb_build_object('base', round(r.b1b_base::numeric / 100.0)::bigint, 'vat', v_form_1b),
      '1c', jsonb_build_object('base', round(r.b1c_base::numeric / 100.0)::bigint, 'vat', v_form_1c),
      '1d', jsonb_build_object('base', round(r.b1d_base::numeric / 100.0)::bigint, 'vat', v_form_1d),
      '1e', jsonb_build_object('base', round(r.b1e_base::numeric / 100.0)::bigint),
      '2a', jsonb_build_object('base', round(r.b2a_base::numeric / 100.0)::bigint, 'vat', v_form_2a),
      '3a', jsonb_build_object('base', round(r.b3a_base::numeric / 100.0)::bigint),
      '3b', jsonb_build_object('base', round(r.b3b_base::numeric / 100.0)::bigint),
      '3c', jsonb_build_object('base', round(r.b3c_base::numeric / 100.0)::bigint),
      '4a', jsonb_build_object('base', round(r.b4a_base::numeric / 100.0)::bigint, 'vat', v_form_4a),
      '4b', jsonb_build_object('base', round(r.b4b_base::numeric / 100.0)::bigint, 'vat', v_form_4b),
      '5a', v_form_5a, '5b', v_form_5b, '5c', v_form_5c
    ),
    'boxes_consistent', v_consistent,
    'boxes_vat_diff_cents', v_box_vat_total - (r.clear_output + r.clear_reverse),
    -- Bestaande sleutels (oudere UI-versies, bevroren snapshots, bankmatching):
    'omzet_hoog_base', r.b1a_base, 'omzet_hoog_btw', r.b1a_vat,
    'omzet_laag_base', r.b1b_base, 'omzet_laag_btw', r.b1b_vat,
    'omzet_nul_base', r.b1e_base,
    'verlegd_btw', r.clear_reverse,
    'verschuldigd_total', r.clear_output + r.clear_reverse,
    'voorbelasting', r.clear_input,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_saldo - v_saldo_afgerond,
    'clear_output', r.clear_output,
    'clear_reverse', r.clear_reverse,
    'clear_input', r.clear_input
  );
end;
$$;

-- ------------------------------------------------------------
-- 6. compute_vat_return: dunne wrapper om compute_vat_boxes
-- ------------------------------------------------------------
create or replace function public.compute_vat_return(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  return public.compute_vat_boxes(p_organization_id, p_from, p_to, null);
end;
$$;

-- ------------------------------------------------------------
-- 7. finalize_vat_return: zelfde doorboeking, maar rubrieken uit
--    compute_vat_boxes (één momentopname) en het 1530-bedrag volgens de
--    per-rubriek-afronding. Conflict-arbiter volgt de nieuwe partial index
--    (alleen primaire aangiftes zijn uniek per periode).
-- ------------------------------------------------------------
create or replace function public.finalize_vat_return(
  p_organization_id uuid,
  p_period_type text,
  p_year integer,
  p_period_index integer,
  p_from date,
  p_to date,
  p_created_by uuid default auth.uid()
)
returns public.vat_returns
language plpgsql
security definer
set search_path = public
as $$
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
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.closed_periods
    where organization_id = p_organization_id and period_start = p_from and period_end = p_to
  ) then
    raise exception 'Deze aangifteperiode is al afgesloten.' using errcode = '23514';
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
  on conflict (organization_id, period_start, period_end) do nothing;

  return v_ret;
end;
$$;

-- ------------------------------------------------------------
-- 8. Suppletie: delta-berekening (voorvertoning) + definitief maken.
-- ------------------------------------------------------------
create or replace function public.compute_vat_supplement_delta(
  p_organization_id uuid,
  p_entry_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_entry_ids is null or array_length(p_entry_ids, 1) is null then
    raise exception 'Kies minimaal één boekstuk voor de suppletie.' using errcode = '23514';
  end if;
  return public.compute_vat_boxes(p_organization_id, null, null, p_entry_ids);
end;
$$;

create or replace function public.create_vat_supplement(
  p_organization_id uuid,
  p_original_return_id uuid,
  p_entry_ids uuid[],
  p_date date default current_date,
  p_notes text default null,
  p_created_by uuid default auth.uid()
)
returns public.vat_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orig public.vat_returns;
  v_ids uuid[];
  v_cnt integer;
  v_bad text;
  v_delta jsonb;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_label text;
  v_ret public.vat_returns;
  v_id uuid;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_orig from public.vat_returns
  where id = p_original_return_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Aangifte niet gevonden.' using errcode = '02000';
  end if;
  if v_orig.supplements_return_id is not null then
    raise exception 'Maak de suppletie aan op de oorspronkelijke aangifte, niet op een eerdere suppletie.' using errcode = '23514';
  end if;
  if v_orig.status not in ('finalized', 'filed', 'paid') then
    raise exception 'Alleen een definitieve aangifte kan een suppletie krijgen; deze periode is nog een concept.' using errcode = '23514';
  end if;

  -- Ontdubbelen + valideren.
  select array_agg(distinct e) into v_ids from unnest(coalesce(p_entry_ids, '{}'::uuid[])) e;
  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'Kies minimaal één boekstuk voor de suppletie.' using errcode = '23514';
  end if;

  select count(*) into v_cnt from public.journal_entries je
  where je.id = any(v_ids) and je.organization_id = p_organization_id and je.status = 'posted';
  if v_cnt <> array_length(v_ids, 1) then
    raise exception 'Eén of meer gekozen boekstukken bestaan niet (of zijn niet geboekt) binnen deze organisatie.' using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_bad from public.journal_entries je
  where je.id = any(v_ids) and je.source_type in ('year_close', 'vat_return', 'opening_balance')
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % is een systeemboekstuk (jaarafsluiting/aangifte/beginbalans) en hoort niet in een suppletie.', v_bad using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_bad from public.journal_entries je
  where je.id = any(v_ids) and je.reversed_by_entry_id is not null
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % is al tegengeboekt (het paar telt netto nul); verreken het niet in een suppletie.', v_bad using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_bad
  from public.vat_supplement_entries vse
  join public.journal_entries je on je.id = vse.entry_id
  where vse.entry_id = any(v_ids)
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % is al in een eerdere suppletie verrekend.', v_bad using errcode = '23514';
  end if;

  -- Delta over exact deze boekstukken.
  v_delta := public.compute_vat_boxes(p_organization_id, null, null, v_ids);
  v_clear_output := (v_delta->>'clear_output')::bigint;
  v_clear_reverse := (v_delta->>'clear_reverse')::bigint;
  v_clear_input := (v_delta->>'clear_input')::bigint;
  v_saldo_afgerond := (v_delta->>'saldo_afgerond')::bigint;
  v_afronding := (v_delta->>'afronding_cents')::bigint;

  v_label := case when v_orig.period_type = 'quarter'
    then 'Q' || v_orig.period_index || ' ' || v_orig.year
    else lpad(v_orig.period_index::text, 2, '0') || '-' || v_orig.year end;

  -- Doorboeking: de btw-effecten van de correctieboekstukken van 1510/1520/1500
  -- naar 1530 (het bedrag dat de suppletie werkelijk oplevert/kost). De
  -- boekdatum valt in de eerstvolgende open periode; door de verrekening via
  -- vat_supplement_entries telt dit paar daar niet in de reguliere aangifte.
  perform public.ensure_default_ledger_accounts(p_organization_id);
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Suppletie ' || v_label || ': af te dragen BTW',
      'debit_cents', case when v_clear_output > 0 then v_clear_output else 0 end,
      'credit_cents', case when v_clear_output < 0 then -v_clear_output else 0 end));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Suppletie ' || v_label || ': verlegde/ICP BTW',
      'debit_cents', case when v_clear_reverse > 0 then v_clear_reverse else 0 end,
      'credit_cents', case when v_clear_reverse < 0 then -v_clear_reverse else 0 end));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Suppletie ' || v_label || ': voorbelasting',
      'debit_cents', case when v_clear_input < 0 then -v_clear_input else 0 end,
      'credit_cents', case when v_clear_input > 0 then v_clear_input else 0 end));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Suppletie ' || v_label || ': te betalen/terug te ontvangen',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Suppletie ' || v_label || ': afrondingsverschil',
      'debit_cents', case when v_afronding < 0 then -v_afronding else 0 end,
      'credit_cents', case when v_afronding > 0 then v_afronding else 0 end));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_book_date := public.first_open_booking_date(p_organization_id, coalesce(p_date, current_date));
    v_entry := public.post_journal_entry(
      p_organization_id, v_book_date,
      'BTW-suppletie ' || v_label,
      'vat_return', v_orig.id, v_lines, p_created_by
    );
  end if;

  insert into public.vat_returns(
    organization_id, created_by, period_type, year, period_index, period_start, period_end,
    status, rubrieken, journal_entry_id, supplements_return_id, notes, finalized_at
  ) values (
    p_organization_id, p_created_by, v_orig.period_type, v_orig.year, v_orig.period_index,
    v_orig.period_start, v_orig.period_end,
    'finalized',
    v_delta || jsonb_build_object('is_supplement', true, 'entry_ids', to_jsonb(v_ids)),
    v_entry.id, v_orig.id, nullif(btrim(coalesce(p_notes, '')), ''), now()
  )
  returning * into v_ret;

  -- Verrekende boekstukken + de doorboeking zelf uitsluiten van de reguliere aangifte.
  foreach v_id in array v_ids loop
    insert into public.vat_supplement_entries(organization_id, supplement_id, entry_id)
    values (p_organization_id, v_ret.id, v_id);
  end loop;
  if v_entry.id is not null then
    insert into public.vat_supplement_entries(organization_id, supplement_id, entry_id)
    values (p_organization_id, v_ret.id, v_entry.id);
  end if;

  return v_ret;
end;
$$;

-- ------------------------------------------------------------
-- 9. reverse_journal_entry: verrekende boekstukken niet tegenboeken.
--    (Basis: 20260721000000/FIX 1a; nieuw is alleen de suppletie-check.)
-- ------------------------------------------------------------
create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not public.can_write_org(v_src.organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if v_src.status <> 'posted' then
    raise exception 'Alleen een geboekt (posted) boekstuk kan worden tegengeboekt.' using errcode = '23514';
  end if;
  if v_src.reversed_by_entry_id is not null then
    raise exception 'Boekstuk % is al tegengeboekt.', coalesce(v_src.entry_number, v_src.id::text)
      using errcode = '23514';
  end if;
  if v_src.source_type = 'year_close' then
    raise exception 'Een jaarafsluitboekstuk boek je niet tegen; gebruik "Boekjaar heropenen".'
      using errcode = '23514';
  end if;
  -- Suppletie-integriteit: het origineel is uitgesloten van de reguliere
  -- aangifte, maar de spiegelpost zou er WEL in tellen → scheefstand. Correctie
  -- op een suppletie = nieuwe correctieboeking + desgewenst nieuwe suppletie.
  if exists (select 1 from public.vat_supplement_entries vse where vse.entry_id = v_src.id) then
    raise exception 'Boekstuk % is verrekend in een btw-suppletie en kan niet worden tegengeboekt. Maak een nieuwe correctieboeking (memoriaal) en verreken die in een nieuwe suppletie.',
      coalesce(v_src.entry_number, v_src.id::text) using errcode = '23514';
  end if;

  -- Wissel debet/credit per regel om.
  select jsonb_agg(jsonb_build_object(
    'account_id', jl.account_id,
    'description', coalesce(jl.description, '') || ' (tegenboeking)',
    'debit_cents', jl.credit_cents,
    'credit_cents', jl.debit_cents,
    'vat_code', jl.vat_code,
    'vat_rate', jl.vat_rate,
    'vat_base_cents', case when jl.vat_base_cents is null then null else -jl.vat_base_cents end,
    'vat_amount_cents', case when jl.vat_amount_cents is null then null else -jl.vat_amount_cents end,
    'client_id', jl.client_id,
    'supplier_id', jl.supplier_id,
    'project_id', jl.project_id
  ) order by jl.line_index)
  into v_lines
  from public.journal_lines jl
  where jl.entry_id = p_entry_id;

  v_reversal := public.post_journal_entry(
    v_src.organization_id,
    coalesce(p_date, current_date),
    'Tegenboeking van ' || coalesce(v_src.entry_number, v_src.id::text),
    v_src.source_type,
    v_src.source_id,
    v_lines,
    p_created_by
  );

  update public.journal_entries set reverses_entry_id = v_src.id where id = v_reversal.id;

  -- Het origineel blijft 'posted': het is echt gebeurd en blijft meetellen;
  -- de spiegelpost neutraliseert het saldo (netto 0 i.p.v. −1×). Alleen
  -- reversed_by_entry_id markeert het paar. NB: status='reversed' betekent
  -- "volledig uit de rapporten" en is gereserveerd voor reopen_fiscal_year.
  update public.journal_entries
  set reversed_by_entry_id = v_reversal.id, updated_at = now()
  where id = v_src.id;

  return v_reversal;
end;
$$;

-- ------------------------------------------------------------
-- 10. post_sales_invoice_to_ledger: btw-code bepaalt rubriek én rekening.
--     (Basis: 20260618000000; nieuw: vat_code-classificatie, 8030,
--     boekdatum-verschuiving voor nagekomen facturen.)
-- ------------------------------------------------------------
create or replace function public.post_sales_invoice_to_ledger(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
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
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', 0, 'credit_cents', r.base_cents,
        'vat_code', r.vat_code,
        'vat_rate', r.rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', 0, 'credit_cents', v_output_vat,
      'client_id', v_inv.client_id
    ));
  end if;

  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
    'description', 'Debiteuren',
    'debit_cents', v_receivable, 'credit_cents', 0,
    'client_id', v_inv.client_id
  )) || v_lines;

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
$$;

-- ------------------------------------------------------------
-- 11. book_purchase_invoice: btw-code op de journaalregels bewaren (voor
--     rubriek 2a/4a/4b) + invoer-verlegging (IMPORT) + boekdatum-verschuiving.
--     (Basis: 20260618000000; groepering nu per (rekening, code, tarief).)
-- ------------------------------------------------------------
create or replace function public.book_purchase_invoice(
  p_organization_id uuid,
  p_purchase_invoice_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_expense jsonb := '[]'::jsonb;
  v_input_vat bigint := 0;
  v_reverse_vat bigint := 0;
  v_creditors bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  r record;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000';
  end if;
  if v_pi.status <> 'draft' then
    raise exception 'Inkoopfactuur is al geboekt of geannuleerd.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  select coalesce(kor_enabled, false) into v_kor from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  -- Aggregeer per kostenrekening + btw-code + tarief; rond de BTW per groep.
  -- De code blijft op de regel staan zodat de aangifte 2a/4a/4b kan scheiden.
  for r in
    select
      coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, '4500')) as account_id,
      nullif(btrim(coalesce(l->>'vat_code', '')), '') as vat_code,
      coalesce(vc.kind, 'standard') as kind,
      coalesce(nullif(l->>'vat_rate','')::numeric, vc.rate, 0) as rate,
      sum(coalesce((l->>'amount_cents')::bigint, 0)) as base_cents
    from jsonb_array_elements(v_pi.lines) as l
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
    group by 1, 2, 3, 4
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_expense_debit bigint := r.base_cents;
    begin
      if v_kor then
        -- KOR: geen aftrek; BTW wordt onderdeel van de kosten.
        v_expense_debit := r.base_cents + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      elsif r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services','import_non_eu') then
        -- Verlegd/EU-verwerving/invoer art. 23: zelf afdragen én aftrekken;
        -- de leverancier factureert exclusief BTW.
        v_input_vat := v_input_vat + v_vat;
        v_reverse_vat := v_reverse_vat + v_vat;
        v_creditors := v_creditors + r.base_cents;
      else
        -- Normaal binnenland (21/9/0/vrijgesteld).
        v_input_vat := v_input_vat + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      end if;

      v_expense := v_expense || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id,
        'description', 'Inkoopkosten',
        'debit_cents', v_expense_debit,
        'credit_cents', 0,
        'vat_code', r.vat_code,
        'vat_rate', r.rate,
        'vat_base_cents', r.base_cents,
        'vat_amount_cents', v_vat,
        'supplier_id', v_pi.supplier_id
      ));
    end;
  end loop;

  v_lines := v_expense;

  if v_input_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Voorbelasting',
      'debit_cents', v_input_vat, 'credit_cents', 0,
      'supplier_id', v_pi.supplier_id
    ));
  end if;
  if v_reverse_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Verschuldigde BTW verlegd/ICP',
      'debit_cents', 0, 'credit_cents', v_reverse_vat,
      'supplier_id', v_pi.supplier_id
    ));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
    'description', 'Crediteuren',
    'debit_cents', 0, 'credit_cents', v_creditors,
    'supplier_id', v_pi.supplier_id
  ));

  -- Nagekomen inkoopfactuur (bv. maart-factuur ontdekt in juli terwijl Q1 al
  -- is ingediend): boek op de eerstvolgende open datum i.p.v. hard weigeren.
  v_book_date := public.first_open_booking_date(p_organization_id, v_pi.date);
  v_desc := 'Inkoopfactuur ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '');
  if v_book_date <> v_pi.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_pi.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'purchase_invoice', v_pi.id, v_lines, p_created_by
  );

  update public.purchase_invoices
  set status = 'booked', journal_entry_id = v_entry.id
  where id = v_pi.id;

  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 12. Creditnota's naar het grootboek (review 1.2): spiegel van de
--     verkoopfactuurboeking — debet omzet, debet 1510, credit 1300.
--     Cent-exact aangesloten op het creditnota-document (subtotal/vat/total);
--     een restcent uit de tariefverdeling wordt in de grootste groep
--     rechtgetrokken zodat document en grootboek exact gelijklopen.
-- ------------------------------------------------------------
alter table public.credit_notes
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;

create index if not exists idx_credit_notes_journal_entry
  on public.credit_notes(journal_entry_id) where journal_entry_id is not null;

create or replace function public.post_credit_note_to_ledger(
  p_organization_id uuid,
  p_credit_note_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cn public.credit_notes;
  v_inv public.invoices;
  v_start date;
  v_lines jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  v_doc_subtotal bigint;
  v_doc_vat bigint;
  v_doc_total bigint;
  v_sum_base bigint := 0;
  v_sum_vat bigint := 0;
  v_base_diff bigint;
  v_vat_diff bigint;
  v_n_groups integer := 0;
  v_biggest_idx integer := -1;
  v_biggest_base bigint := -1;
  v_g jsonb;
  v_i integer;
  r record;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_cn from public.credit_notes
  where id = p_credit_note_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Creditnota niet gevonden.' using errcode = '02000';
  end if;
  if v_cn.journal_entry_id is not null then
    raise exception 'Creditnota % is al naar het grootboek geboekt.', v_cn.number using errcode = '23514';
  end if;
  if v_cn.status <> 'issued' then
    raise exception 'Alleen een uitgegeven creditnota kan worden geboekt (status: %).', v_cn.status using errcode = '23514';
  end if;

  select * into v_inv from public.invoices
  where id = v_cn.invoice_id and organization_id = p_organization_id;
  if not found then
    raise exception 'De factuur bij deze creditnota is niet gevonden.' using errcode = '02000';
  end if;

  select bookkeeping_start_date into v_start
  from public.company_settings where organization_id = p_organization_id;
  if v_start is not null and v_cn.date < v_start then
    raise exception 'Creditnotadatum ligt vóór de boekhoud-startdatum (%); deze correctie zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  v_doc_subtotal := round(v_cn.subtotal_amount * 100);
  v_doc_vat := round(v_cn.vat_amount * 100);
  v_doc_total := round(v_cn.total_amount * 100);
  if v_doc_total <= 0 then
    raise exception 'Creditnota % heeft geen bedrag.', v_cn.number using errcode = '23514';
  end if;
  if v_doc_subtotal + v_doc_vat <> v_doc_total then
    raise exception 'Creditnota % is niet consistent (netto + btw ≠ totaal).', v_cn.number using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Groepen per (btw-code, tarief), zoals bij de verkoopfactuur.
  for r in
    select
      nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
      (vc.id is not null) as has_code,
      vc.kind, vc.sales_box,
      coalesce((line->>'vat')::numeric, 0) as rate,
      sum(round(coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unit_price')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(v_cn.lines) as line
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id
     and vc.code = nullif(btrim(coalesce(line->>'vat_code', '')), '')
    group by 1, 2, 3, 4, 5
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'account', v_revenue_account, 'vat_code', r.vat_code, 'rate', r.rate,
        'base', r.base_cents, 'vat', v_vat));
      v_sum_base := v_sum_base + r.base_cents;
      v_sum_vat := v_sum_vat + v_vat;
      v_n_groups := v_n_groups + 1;
      if r.base_cents > v_biggest_base then
        v_biggest_base := r.base_cents; v_biggest_idx := v_n_groups - 1;
      end if;
    end;
  end loop;

  if v_n_groups = 0 then
    -- Creditnota zonder regels (hoort niet voor te komen): boek als één groep
    -- op 8000/8010/8020 valt niet te bepalen → weiger expliciet.
    raise exception 'Creditnota % heeft geen regels en kan niet worden geboekt.', v_cn.number using errcode = '23514';
  end if;

  -- Aansluiting op het document: restcenten in de grootste groep rechttrekken.
  -- Pro-rata-creditnota's dragen een "blended" tarief dat op 2 decimalen is
  -- afgerond; bij grote bedragen wijkt de herberekende btw daardoor tot
  -- ~0,005% van de grondslag af. De tolerantie schaalt daarom mee (0,01% van
  -- het totaal, minimaal 4 cent); grotere afwijkingen betekenen een echt
  -- inconsistent document → weigeren.
  v_base_diff := v_doc_subtotal - v_sum_base;
  v_vat_diff := v_doc_vat - v_sum_vat;
  if abs(v_base_diff) > greatest(4, 2 * v_n_groups, ceil(v_doc_total * 0.0001)::bigint)
     or abs(v_vat_diff) > greatest(4, 2 * v_n_groups, ceil(v_doc_total * 0.0001)::bigint) then
    raise exception 'Creditnota % sluit niet aan op zijn regels (verschil netto % cent, btw % cent).',
      v_cn.number, v_base_diff, v_vat_diff using errcode = '23514';
  end if;
  if v_base_diff <> 0 or v_vat_diff <> 0 then
    v_g := v_groups->v_biggest_idx;
    v_groups := jsonb_set(v_groups, array[v_biggest_idx::text], v_g
      || jsonb_build_object(
        'base', (v_g->>'base')::bigint + v_base_diff,
        'vat', (v_g->>'vat')::bigint + v_vat_diff));
  end if;

  -- Journaalregels: debet omzet (negatieve rubriek-metadata zodat de aangifte
  -- de grondslag en btw netjes terugtelt), debet 1510, credit 1300.
  for v_i in 0 .. v_n_groups - 1 loop
    v_g := v_groups->v_i;
    declare
      v_base bigint := (v_g->>'base')::bigint;
    begin
      if v_base <> 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, v_g->>'account'),
          'description', 'Creditering omzet',
          'debit_cents', case when v_base > 0 then v_base else 0 end,
          'credit_cents', case when v_base < 0 then -v_base else 0 end,
          'vat_code', nullif(v_g->>'vat_code', ''),
          'vat_rate', (v_g->>'rate')::numeric,
          'vat_base_cents', -v_base,
          'vat_amount_cents', -((v_g->>'vat')::bigint),
          'client_id', v_inv.client_id, 'project_id', v_inv.project_id
        ));
      end if;
    end;
  end loop;

  if v_doc_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW (creditering)',
      'debit_cents', case when v_doc_vat > 0 then v_doc_vat else 0 end,
      'credit_cents', case when v_doc_vat < 0 then -v_doc_vat else 0 end,
      'client_id', v_inv.client_id
    ));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
    'description', 'Debiteuren — creditnota ' || v_cn.number || ' op factuur ' || coalesce(v_inv.number, ''),
    'debit_cents', case when v_doc_total < 0 then -v_doc_total else 0 end,
    'credit_cents', case when v_doc_total > 0 then v_doc_total else 0 end,
    'client_id', v_inv.client_id
  ));

  v_book_date := public.first_open_booking_date(p_organization_id, v_cn.date);
  v_desc := 'Creditnota ' || v_cn.number || ' (factuur ' || coalesce(v_inv.number, '') || ')';
  if v_book_date <> v_cn.date then
    v_desc := v_desc || ' (creditnotadatum ' || to_char(v_cn.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'credit_note', v_cn.id, v_lines, p_created_by
  );

  update public.credit_notes set journal_entry_id = v_entry.id, updated_at = now() where id = v_cn.id;
  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 13. ICP-opgaaf (review 2.5): intracommunautaire leveringen/diensten per
--     afnemer, uit de omzetregels met een ICP-code. Btw-nummer/land komen van
--     de klant (kolommen bestaan sinds 20260723100000). Zelfde uitsluitingen
--     als de aangifte, zodat 3b en de opgaaf op elkaar aansluiten.
-- ------------------------------------------------------------
create or replace function public.compute_icp_declaration(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_goods_total bigint;
  v_services_total bigint;
  v_unassigned bigint;
  v_missing integer;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
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
    left join public.clients c on c.id = il.client_id
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

-- ------------------------------------------------------------
-- 14. Openstaande-postenlijst (review 3.5): per factuur geboekt − betaald −
--     gecrediteerd uit het GROOTBOEK, plus aansluiting op het 1300/1600-saldo.
--     Tegenboekingen vallen er automatisch tegen weg doordat per bron over
--     ALLE geboekte boekstukken (origineel + spiegel) wordt gesommeerd.
-- ------------------------------------------------------------
create or replace function public.report_open_items(
  p_organization_id uuid,
  p_as_of date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
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
  inv_rows as (
    select
      i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) as paid_cents,
      coalesce(cr.amt, 0) as credited_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) - coalesce(cr.amt, 0) as open_cents
    from public.invoices i
    left join inv_booked b on b.invoice_id = i.id
    left join inv_paid p on p.invoice_id = i.id
    left join inv_credited cr on cr.invoice_id = i.id
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0 or coalesce(cr.amt, 0) <> 0)
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
$$;

-- ------------------------------------------------------------
-- 15. create_opening_balance: duplicaat-guard (review 3.2). Eén actieve
--     beginbalans per organisatie; een tegengeboekte telt niet.
-- ------------------------------------------------------------
create or replace function public.create_opening_balance(
  p_organization_id uuid,
  p_as_of_date date,
  p_lines jsonb,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines jsonb;
  v_debit bigint;
  v_credit bigint;
  v_equity bigint;
  v_existing text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Beginbalans heeft minimaal één regel nodig.' using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_existing
  from public.journal_entries je
  where je.organization_id = p_organization_id
    and je.source_type = 'opening_balance'
    and je.status = 'posted'
    and je.reversed_by_entry_id is null
  limit 1;
  if v_existing is not null then
    raise exception 'Er is al een beginbalans geboekt (boekstuk %). Boek die eerst tegen voordat je een nieuwe vastlegt.', v_existing
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluit het verschil op eigen vermogen zodat de openingsbalans in balans is.
  select coalesce(sum(coalesce((l->>'debit_cents')::bigint,0)),0),
         coalesce(sum(coalesce((l->>'credit_cents')::bigint,0)),0)
    into v_debit, v_credit
  from jsonb_array_elements(p_lines) l;

  v_lines := p_lines;
  v_equity := v_debit - v_credit;
  if v_equity <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '0500'),
      'description', 'Eigen vermogen (sluitpost beginbalans)',
      'debit_cents', case when v_equity < 0 then -v_equity else 0 end,
      'credit_cents', case when v_equity > 0 then v_equity else 0 end
    ));
  end if;

  return public.post_journal_entry(
    p_organization_id, p_as_of_date, 'Beginbalans per ' || p_as_of_date,
    'opening_balance', null, v_lines, p_created_by
  );
end;
$$;

commit;
