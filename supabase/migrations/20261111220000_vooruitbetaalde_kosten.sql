-- ============================================================
-- ResoFly — Vooruitbetaalde kosten: één betaling over de maanden spreiden
-- Date: 2026-11-11
--
-- Vraag: "Voeg een financiële functionaliteit toe als boeking waarbij men
-- vooruit betaalde bedragen kan boeken. Stel ik heb nu 1000 euro aan
-- verzekering betaald, waarbij de dekking 3 jaar is. Die wil ik dus over 36
-- maanden verspreiden."
--
-- Tot nu toe kon dat alleen met de hand: de factuur op een kostenrekening
-- boeken (dan stond de hele € 1.000 in de maand van betalen) of 36 keer een
-- memoriaalboeking maken. Nu legt de gebruiker het bedrag één keer vast en
-- maakt ResoFly het schema en de boekingen:
--
--   1. Naar de balans: debet "Vooruitbetaalde kosten" / credit de tegenrekening
--      (bank, crediteuren, of de kostenrekening als de factuur daar al op stond).
--      Staat het bedrag al op de balansrekening (bank of inkoopfactuur direct
--      daarop geboekt), dan slaat ResoFly deze stap over.
--   2. Per maand: debet de kostenrekening / credit "Vooruitbetaalde kosten".
--      € 1.000 over 36 maanden = 28 × € 27,78 en 8 × € 27,77: cent-exact,
--      dezelfde verdeling als het afschrijvingsschema van de activa.
--   3. Stopt het eerder (polis opgezegd), dan gaat wat er nog op de balans staat
--      in één keer naar de kosten, of deels naar een terugbetaling.
--
-- Zelfde opzet als de activamodule (20260619000001 e.v.): een register, een
-- schema per maand, en boeken "tot en met" een datum. Anders dan bij de activa
-- schrijft de app hier NIETS rechtstreeks in de tabellen: alles loopt via de
-- functies hieronder. Bij de activa moesten later bewakers op de tabel komen
-- (20261104030000), omdat een geboekt activum via de API nog te wijzigen of te
-- verwijderen was; hier kan dat vanaf het begin niet.
--
-- Tegenboeken in het grootboek neemt het register mee terug (zoals bij de
-- activa sinds 20261104000000): een tegengeboekte termijn staat weer gepland,
-- een tegengeboekte beëindiging zet het schema terug.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Het register ─────────────────────────────────────────────────────────

create table if not exists public.prepaid_expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  description text not null,
  amount_cents bigint not null,
  payment_date date not null,
  start_date date not null,
  months integer not null,
  prepaid_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  expense_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  start_mode text not null default 'book',
  counter_account_id uuid references public.ledger_accounts(id) on delete restrict,
  start_journal_entry_id uuid references public.journal_entries(id) on delete set null,
  source_purchase_invoice_id uuid references public.purchase_invoices(id) on delete set null,
  status text not null default 'active',
  end_date date,
  end_amount_cents bigint,
  end_refund_cents bigint,
  end_refund_account_id uuid references public.ledger_accounts(id) on delete restrict,
  end_journal_entry_id uuid references public.journal_entries(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prepaid_expenses_description_not_blank check (length(btrim(description)) > 0),
  constraint prepaid_expenses_amount_positive check (amount_cents > 0),
  constraint prepaid_expenses_months_range check (months between 1 and 600),
  constraint prepaid_expenses_start_mode_check check (start_mode in ('book', 'existing')),
  constraint prepaid_expenses_status_check check (status in ('active', 'completed', 'ended')),
  constraint prepaid_expenses_accounts_differ check (prepaid_account_id <> expense_account_id)
);

comment on table public.prepaid_expenses is
  'Vooruitbetaalde kosten: een betaling die over meerdere maanden naar de kosten gaat. Schrijven alleen via save_prepaid_expense en de boekingsfuncties.';
comment on column public.prepaid_expenses.start_mode is
  'book = ResoFly boekt het bedrag naar de balans (debet balansrekening / credit counter_account_id); existing = het staat er al (bank of inkoopfactuur direct op de balansrekening, of de beginbalans).';

create index if not exists idx_prepaid_expenses_org on public.prepaid_expenses(organization_id, start_date desc);

-- ── 2. Het schema: één termijn per maand ────────────────────────────────────

create table if not exists public.prepaid_expense_releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  prepaid_expense_id uuid not null references public.prepaid_expenses(id) on delete cascade,
  period_index integer not null,
  date date not null,
  amount_cents bigint not null,
  remaining_after_cents bigint not null,
  status text not null default 'scheduled',
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint prepaid_expense_releases_status_check check (status in ('scheduled', 'posted')),
  constraint prepaid_expense_releases_amount_positive check (amount_cents > 0),
  constraint prepaid_expense_releases_period_positive check (period_index > 0),
  constraint prepaid_expense_releases_unique unique (prepaid_expense_id, period_index)
);

create index if not exists idx_prepaid_expense_releases_item on public.prepaid_expense_releases(prepaid_expense_id, period_index);
create index if not exists idx_prepaid_expense_releases_due on public.prepaid_expense_releases(organization_id, status, date);

-- ── 3. Triggers: bijgewerkt, organisatie vast, logboek ──────────────────────

drop trigger if exists prepaid_expenses_touch_updated_at on public.prepaid_expenses;
create trigger prepaid_expenses_touch_updated_at before update on public.prepaid_expenses
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists prepaid_expenses_prevent_org_change on public.prepaid_expenses;
create trigger prepaid_expenses_prevent_org_change before update of organization_id on public.prepaid_expenses
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists prepaid_expense_releases_prevent_org_change on public.prepaid_expense_releases;
create trigger prepaid_expense_releases_prevent_org_change before update of organization_id on public.prepaid_expense_releases
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists prepaid_expenses_audit on public.prepaid_expenses;
create trigger prepaid_expenses_audit after insert or update or delete on public.prepaid_expenses
  for each row execute function public.audit_row_change('prepaid_expense', 'description');

-- ── 4. Rechten op de tabellen ───────────────────────────────────────────────
-- Lezen: leden van de organisatie, met de modulepoort van Financiën erbovenop.
-- Schrijven: alleen de functies hieronder (security definer). Er is bewust geen
-- policy voor insert, update of delete, en de rechten daarop gaan er ook af:
-- een geboekte termijn of een vastgelegd bedrag mag niet buiten de boeking om
-- veranderen, want dan lopen register en grootboek uiteen.

alter table public.prepaid_expenses enable row level security;
alter table public.prepaid_expense_releases enable row level security;

drop policy if exists "prepaid_expenses read" on public.prepaid_expenses;
create policy "prepaid_expenses read" on public.prepaid_expenses
  for select using (public.can_read_org(organization_id));
drop policy if exists "prepaid_expense_releases read" on public.prepaid_expense_releases;
create policy "prepaid_expense_releases read" on public.prepaid_expense_releases
  for select using (public.can_read_org(organization_id));

revoke insert, update, delete, truncate on public.prepaid_expenses from anon, authenticated;
revoke insert, update, delete, truncate on public.prepaid_expense_releases from anon, authenticated;
revoke all on public.prepaid_expenses from anon;
revoke all on public.prepaid_expense_releases from anon;

select public.apply_module_gate('prepaid_expenses', 'finance');
select public.apply_module_gate('prepaid_expense_releases', 'finance');

-- ── 5. Nieuwe boekingssoorten ───────────────────────────────────────────────
-- Volledige lijst uit 20260807100000, met de drie van deze module erbij:
--   prepaid_start   het bedrag naar de balans
--   prepaid_release een maandtermijn naar de kosten
--   prepaid_end     de rest bij beëindigen
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation','corporate_tax','dga_interest','payroll','dividend',
    'prepaid_start','prepaid_release','prepaid_end'
  ));

-- ── 6. Hulpjes (alleen voor de functies hieronder) ──────────────────────────

-- Vandaag zoals de gebruiker het ziet. De database draait op UTC; rond
-- middernacht viel "het einde van deze maand" anders een uur lang in de
-- vorige maand.
create or replace function public.prepaid_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Europe/Amsterdam')::date;
$$;

-- De laatste dag van de maand waar een datum in valt. Via timestamp zonder
-- tijdzone, zodat de uitkomst niet van de sessie-instelling afhangt.
create or replace function public.prepaid_month_end(p_date date)
returns date
language sql
immutable
set search_path = public
as $$
  select (date_trunc('month', p_date::timestamp) + interval '1 month' - interval '1 day')::date;
$$;

-- De balansrekening "Vooruitbetaalde kosten". Herkenning op subsoort, niet op
-- code: 1400 is bij een BV de rekening-courant DGA, en een administratie kan
-- 1350 al voor iets anders gebruiken. Bestaat hij niet, dan komt hij erbij op
-- de eerste vrije code. Geen systeemrekening: de gebruiker mag hem hernoemen.
create or replace function public.prepaid_default_account(p_organization_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text;
begin
  select la.id into v_id
  from public.ledger_accounts la
  where la.organization_id = p_organization_id and la.subtype = 'prepaid_expenses' and la.is_active
  order by la.code
  limit 1;
  if v_id is not null then
    return v_id;
  end if;

  select c.code into v_code
  from unnest(array['1350', '1360', '1370', '1380', '1390', '1450', '1460', '1470', '1480', '1490']) with ordinality as c(code, pos)
  where not exists (
    select 1 from public.ledger_accounts la
    where la.organization_id = p_organization_id and la.code = c.code
  )
  order by c.pos
  limit 1;
  if v_code is null then
    raise exception 'Er is geen vrije rekeningcode voor "Vooruitbetaalde kosten". Maak zelf een balansrekening aan en kies die.'
      using errcode = '23514';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values (p_organization_id, v_code, 'Vooruitbetaalde kosten', 'asset', 'prepaid_expenses', null, false, 'vorderingen')
  returning id into v_id;
  return v_id;
end;
$$;

-- Een grootboekrekening van déze organisatie die actief is, met een leesbare
-- fout. p_role zegt waarvoor hij dient, zodat de controle per rol klopt:
--   prepaid  een bezittingenrekening (niet bank, debiteuren, btw of vaste activa)
--   expense  een kostenrekening
--   counter  de tegenrekening bij het naar de balans boeken, of de rekening van
--            een terugbetaling: geen omzet en geen btw-rekening
create or replace function public.prepaid_check_account(p_organization_id uuid, p_account_id uuid, p_role text)
returns public.ledger_accounts
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_account public.ledger_accounts;
  v_label text := case p_role
    when 'prepaid' then 'De balansrekening'
    when 'expense' then 'De kostenrekening'
    else 'De tegenrekening' end;
begin
  if p_account_id is null then
    raise exception '% ontbreekt.', v_label using errcode = '23514';
  end if;
  select * into v_account from public.ledger_accounts
  where id = p_account_id and organization_id = p_organization_id;
  if not found then
    raise exception '% hoort niet bij deze organisatie.', v_label using errcode = '42501';
  end if;
  if not v_account.is_active then
    raise exception 'Rekening % · % staat op inactief.', v_account.code, v_account.name using errcode = '23514';
  end if;
  if p_role = 'prepaid' then
    if v_account.type <> 'asset'
       or coalesce(v_account.subtype, '') in ('bank', 'accounts_receivable', 'vat_input', 'psp_clearing', 'fixed_asset', 'accumulated_depreciation', 'accumulated_amortization', 'intangible_asset') then
      raise exception 'Rekening % · % is geen geschikte balansrekening voor vooruitbetaalde kosten. Kies "Vooruitbetaalde kosten" of een andere overlopende post.', v_account.code, v_account.name
        using errcode = '23514';
    end if;
  elsif p_role = 'expense' then
    if v_account.type <> 'expense' then
      raise exception 'Rekening % · % is geen kostenrekening.', v_account.code, v_account.name using errcode = '23514';
    end if;
  else
    if v_account.type = 'revenue'
       or coalesce(v_account.subtype, '') in ('vat_input', 'vat_output', 'vat_reverse', 'vat_payable') then
      raise exception 'Rekening % · % kan hier niet: kies de bank, crediteuren, een kostenrekening of een andere balansrekening.', v_account.code, v_account.name
        using errcode = '23514';
    end if;
  end if;
  return v_account;
end;
$$;

-- Het schema opnieuw opbouwen: de nog geplande termijnen gaan eruit, geboekte
-- blijven staan. Per maand een termijn op de laatste dag van die maand; het
-- restant van de deling gaat met een cent per termijn naar de eerste maanden
-- (zelfde verdeling als generate_depreciation_schedule sinds 20260724110000),
-- zodat de som precies het bedrag is en geen termijn negatief of nul wordt.
create or replace function public.prepaid_build_schedule(p_prepaid_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.prepaid_expenses;
  v_monthly bigint;
  v_remainder bigint;
  v_amount bigint;
  v_accum bigint := 0;
  i integer;
begin
  select * into v_item from public.prepaid_expenses where id = p_prepaid_expense_id;
  if not found then
    return;
  end if;

  delete from public.prepaid_expense_releases
  where prepaid_expense_id = v_item.id and status = 'scheduled';

  v_monthly := v_item.amount_cents / v_item.months;
  v_remainder := v_item.amount_cents - v_monthly * v_item.months;

  for i in 1..v_item.months loop
    v_amount := v_monthly + case when i <= v_remainder then 1 else 0 end;
    v_accum := v_accum + v_amount;
    continue when v_amount <= 0;
    continue when exists (
      select 1 from public.prepaid_expense_releases r
      where r.prepaid_expense_id = v_item.id and r.period_index = i
    );
    insert into public.prepaid_expense_releases (
      organization_id, prepaid_expense_id, period_index, date, amount_cents, remaining_after_cents, status
    ) values (
      v_item.organization_id, v_item.id, i,
      public.prepaid_month_end((date_trunc('month', v_item.start_date::timestamp) + make_interval(months => i - 1))::date),
      v_amount, v_item.amount_cents - v_accum, 'scheduled'
    );
  end loop;
end;
$$;

-- De termijnen van één post t/m een datum boeken. Alleen voor de functies
-- hieronder: die controleren de rechten en hebben de post al vergrendeld.
create or replace function public.prepaid_post_item_releases(p_item public.prepaid_expenses, p_through_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_count integer := 0;
  v_total bigint := 0;
begin
  for r in
    select * from public.prepaid_expense_releases
    where prepaid_expense_id = p_item.id and status = 'scheduled' and date <= p_through_date
    order by period_index
  loop
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', p_item.expense_account_id,
        'description', p_item.description || ' — ' || to_char(r.date, 'MM-YYYY'),
        'debit_cents', r.amount_cents, 'credit_cents', 0
      ),
      jsonb_build_object(
        'account_id', p_item.prepaid_account_id,
        'description', 'Vrijval vooruitbetaald: ' || p_item.description,
        'debit_cents', 0, 'credit_cents', r.amount_cents
      )
    );
    -- Een termijn in een afgesloten boekjaar komt op de eerste open dag daarna.
    -- Hij raakt geen btw-rubriek, dus een afgesloten btw-periode houdt hem niet
    -- tegen (zoals een afschrijving, 20261104000000).
    v_book_date := public.first_open_booking_date_for(p_item.organization_id, r.date, public.journal_lines_touch_vat(p_item.organization_id, v_lines));
    v_entry := public.post_journal_entry(
      p_item.organization_id, v_book_date,
      format('Vooruitbetaalde kosten %s/%s: %s', r.period_index, p_item.months, p_item.description),
      'prepaid_release', p_item.id, v_lines, auth.uid()
    );
    update public.prepaid_expense_releases
    set status = 'posted', journal_entry_id = v_entry.id, posted_at = now()
    where id = r.id and status = 'scheduled';
    v_count := v_count + 1;
    v_total := v_total + r.amount_cents;
  end loop;

  if not exists (
    select 1 from public.prepaid_expense_releases
    where prepaid_expense_id = p_item.id and status = 'scheduled'
  ) then
    update public.prepaid_expenses set status = 'completed'
    where id = p_item.id and status = 'active';
  end if;

  return jsonb_build_object('posted_count', v_count, 'posted_cents', v_total);
end;
$$;

-- ── 7. Vastleggen en bijwerken ──────────────────────────────────────────────
-- Eén functie voor nieuw (p_prepaid_expense_id null) en bijwerken. Velden die
-- niet in p_values staan, blijven zoals ze zijn. Zodra er iets geboekt is,
-- liggen bedrag, datums, looptijd, balansrekening en de manier van boeken vast;
-- de omschrijving, de notities, de bron-inkoopfactuur en de kostenrekening
-- (voor de termijnen die nog komen) kunnen altijd.
create or replace function public.save_prepaid_expense(
  p_organization_id uuid,
  p_prepaid_expense_id uuid,
  p_values jsonb
)
returns public.prepaid_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.prepaid_expenses;
  v_is_new boolean := p_prepaid_expense_id is null;
  v_booked boolean := false;
  v_description text;
  v_amount bigint;
  v_months integer;
  v_payment_date date;
  v_start_date date;
  v_prepaid uuid;
  v_expense uuid;
  v_mode text;
  v_counter uuid;
  v_source uuid;
  v_notes text;
  v_bookkeeping_start date;
  v_financial_changed boolean;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'Geef de gegevens van de vooruitbetaling mee.' using errcode = '22023';
  end if;

  if not v_is_new then
    select * into v_item from public.prepaid_expenses
    where id = p_prepaid_expense_id and organization_id = p_organization_id
    for update;
    if not found then
      raise exception 'Vooruitbetaling niet gevonden.' using errcode = '02000';
    end if;
    v_booked := v_item.start_journal_entry_id is not null
      or v_item.end_journal_entry_id is not null
      or v_item.status <> 'active'
      or exists (
        select 1 from public.prepaid_expense_releases r
        where r.prepaid_expense_id = v_item.id and r.status = 'posted'
      );
  end if;

  -- Waarden lezen: een sleutel die ontbreekt, laat het veld zoals het is.
  begin
    v_description := case when p_values ? 'description' then btrim(coalesce(p_values->>'description', '')) else v_item.description end;
    v_amount := case when p_values ? 'amount_cents' then (p_values->>'amount_cents')::numeric::bigint else v_item.amount_cents end;
    v_months := case when p_values ? 'months' then (p_values->>'months')::numeric::integer else v_item.months end;
    v_payment_date := case when p_values ? 'payment_date' then nullif(p_values->>'payment_date', '')::date else v_item.payment_date end;
    v_start_date := case when p_values ? 'start_date' then nullif(p_values->>'start_date', '')::date else v_item.start_date end;
    v_prepaid := case when p_values ? 'prepaid_account_id' then nullif(p_values->>'prepaid_account_id', '')::uuid else v_item.prepaid_account_id end;
    v_expense := case when p_values ? 'expense_account_id' then nullif(p_values->>'expense_account_id', '')::uuid else v_item.expense_account_id end;
    v_mode := case when p_values ? 'start_mode' then nullif(p_values->>'start_mode', '') else v_item.start_mode end;
    v_counter := case when p_values ? 'counter_account_id' then nullif(p_values->>'counter_account_id', '')::uuid else v_item.counter_account_id end;
    v_source := case when p_values ? 'source_purchase_invoice_id' then nullif(p_values->>'source_purchase_invoice_id', '')::uuid else v_item.source_purchase_invoice_id end;
    v_notes := case when p_values ? 'notes' then nullif(btrim(coalesce(p_values->>'notes', '')), '') else v_item.notes end;
  exception
    when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
      raise exception 'Een bedrag, datum of rekening is niet goed ingevuld.' using errcode = '22023';
  end;

  if v_description is null or v_description = '' then
    raise exception 'Geef een omschrijving, bijvoorbeeld "Bedrijfsaansprakelijkheidsverzekering 2026–2029".' using errcode = '23514';
  end if;
  if length(v_description) > 200 then
    raise exception 'De omschrijving is te lang (hooguit 200 tekens).' using errcode = '23514';
  end if;
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'De notities zijn te lang (hooguit 2000 tekens).' using errcode = '23514';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Het bedrag moet groter zijn dan nul.' using errcode = '23514';
  end if;
  if v_amount > 100000000000 then
    raise exception 'Dat bedrag is te groot.' using errcode = '23514';
  end if;
  if v_months is null or v_months < 1 or v_months > 600 then
    raise exception 'De looptijd is 1 tot en met 600 maanden.' using errcode = '23514';
  end if;
  if v_payment_date is null then
    raise exception 'Vul in wanneer je betaalde (of de factuurdatum).' using errcode = '23514';
  end if;
  if v_start_date is null then
    raise exception 'Vul in vanaf wanneer de betaling geldt (de eerste maand).' using errcode = '23514';
  end if;
  if extract(year from v_payment_date) not between 2000 and 2100 or extract(year from v_start_date) not between 2000 and 2100 then
    raise exception 'Kies een datum tussen 2000 en 2100.' using errcode = '23514';
  end if;
  if v_mode is null then
    v_mode := 'book';
  elsif v_mode not in ('book', 'existing') then
    raise exception 'Kies hoe het bedrag op de balans komt: ResoFly boekt het (book), of het staat er al (existing).' using errcode = '22023';
  end if;

  v_financial_changed := v_is_new
    or v_amount is distinct from v_item.amount_cents
    or v_months is distinct from v_item.months
    or v_payment_date is distinct from v_item.payment_date
    or v_start_date is distinct from v_item.start_date
    or (p_values ? 'prepaid_account_id' and v_prepaid is distinct from v_item.prepaid_account_id)
    or v_mode is distinct from v_item.start_mode
    or (v_mode = 'book' and v_counter is distinct from v_item.counter_account_id);

  -- De boekhouding in ResoFly begint op een vaste dag; wat daarvoor gebeurde,
  -- zit in de beginbalans. Een termijn of een betaling van vóór die dag zou
  -- daar nog eens bovenop komen. Alleen bij nieuw of als bedrag, datums of
  -- manier veranderen: wie de startdatum later invult, moet de omschrijving
  -- van een lopende post nog kunnen aanpassen.
  select cs.bookkeeping_start_date into v_bookkeeping_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_bookkeeping_start is not null and v_financial_changed then
    if public.prepaid_month_end(v_start_date) < v_bookkeeping_start then
      raise exception 'Je boekhouding in ResoFly begint op %. Begon de periode eerder? Vul dan in wat er op die dag nog op de balans stond, met de maanden die toen nog over waren, en kies "Staat al op de balans".', to_char(v_bookkeeping_start, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
    if v_mode = 'book' and v_payment_date < v_bookkeeping_start then
      raise exception 'Je boekhouding in ResoFly begint op %, en de betaling was daarvoor: die zit in je beginbalans. Kies "Staat al op de balans".', to_char(v_bookkeeping_start, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
  end if;

  -- Is er nog geen rekeningschema, dan eerst het standaardschema (zoals elke
  -- boeking dat doet), daarna zo nodig de rekening Vooruitbetaalde kosten.
  perform public.ensure_default_ledger_accounts(p_organization_id);
  if v_prepaid is null then
    v_prepaid := public.prepaid_default_account(p_organization_id);
  end if;
  if v_expense is null then
    raise exception 'Kies de kostenrekening waar de maandbedragen op komen.' using errcode = '23514';
  end if;
  if v_prepaid = v_expense then
    raise exception 'De balansrekening en de kostenrekening moeten verschillen.' using errcode = '23514';
  end if;

  -- Alleen controleren wat nieuw is of verandert: een rekening die later op
  -- inactief ging, houdt een lopende post niet tegen bij een nieuwe notitie.
  if v_is_new or v_prepaid is distinct from v_item.prepaid_account_id then
    perform public.prepaid_check_account(p_organization_id, v_prepaid, 'prepaid');
  end if;
  if v_is_new or v_expense is distinct from v_item.expense_account_id then
    perform public.prepaid_check_account(p_organization_id, v_expense, 'expense');
  end if;
  if v_mode = 'book' and v_counter is not null then
    if v_is_new or v_counter is distinct from v_item.counter_account_id then
      perform public.prepaid_check_account(p_organization_id, v_counter, 'counter');
    end if;
    -- Ook als alleen de balansrekening verandert: anders werd het pas bij het
    -- boeken geweigerd, nadat de post al was opgeslagen.
    if v_counter = v_prepaid then
      raise exception 'De tegenrekening mag niet de balansrekening zelf zijn.' using errcode = '23514';
    end if;
  end if;
  if v_mode = 'existing' then
    v_counter := null;
  end if;
  if v_source is not null and (v_is_new or v_source is distinct from v_item.source_purchase_invoice_id) then
    perform public.assert_same_org_reference('public.purchase_invoices'::regclass, v_source, p_organization_id, 'De bron-inkoopfactuur');
  end if;

  if v_is_new then
    insert into public.prepaid_expenses (
      organization_id, created_by, description, amount_cents, payment_date, start_date, months,
      prepaid_account_id, expense_account_id, start_mode, counter_account_id, source_purchase_invoice_id, notes
    ) values (
      p_organization_id, auth.uid(), v_description, v_amount, v_payment_date, v_start_date, v_months,
      v_prepaid, v_expense, v_mode, v_counter, v_source, v_notes
    )
    returning * into v_item;
    perform public.prepaid_build_schedule(v_item.id);
    return v_item;
  end if;

  -- Na het invullen van de standaardrekening en het wissen van de
  -- tegenrekening bij "staat al op de balans" opnieuw vergelijken: dat zijn de
  -- waarden die worden opgeslagen.
  v_financial_changed := v_amount is distinct from v_item.amount_cents
    or v_months is distinct from v_item.months
    or v_payment_date is distinct from v_item.payment_date
    or v_start_date is distinct from v_item.start_date
    or v_prepaid is distinct from v_item.prepaid_account_id
    or v_mode is distinct from v_item.start_mode
    or v_counter is distinct from v_item.counter_account_id;
  if v_booked and v_financial_changed then
    raise exception 'Er is al geboekt: bedrag, datums, looptijd en rekeningen liggen vast. Corrigeren gaat met tegenboeken in het Grootboek; het schema gaat dan mee terug.'
      using errcode = '23514';
  end if;
  if v_item.status <> 'active' and v_expense is distinct from v_item.expense_account_id then
    raise exception 'Deze post is afgerond; de kostenrekening verandert niet meer.' using errcode = '23514';
  end if;

  update public.prepaid_expenses set
    description = v_description,
    amount_cents = v_amount,
    payment_date = v_payment_date,
    start_date = v_start_date,
    months = v_months,
    prepaid_account_id = v_prepaid,
    expense_account_id = v_expense,
    start_mode = v_mode,
    counter_account_id = v_counter,
    source_purchase_invoice_id = v_source,
    notes = v_notes
  where id = v_item.id
  returning * into v_item;

  if v_financial_changed then
    perform public.prepaid_build_schedule(v_item.id);
  end if;
  return v_item;
end;
$$;

-- Verwijderen kan zolang er niets in het grootboek staat. Een post waarvan de
-- boeking is tegengeboekt, staat er netto niet meer in en mag dus weg; de
-- boekstukken zelf blijven (bewaarplicht).
create or replace function public.delete_prepaid_expense(p_organization_id uuid, p_prepaid_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.prepaid_expenses;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_item from public.prepaid_expenses
  where id = p_prepaid_expense_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vooruitbetaling niet gevonden.' using errcode = '02000';
  end if;
  if v_item.start_journal_entry_id is not null or v_item.end_journal_entry_id is not null
     or exists (
       select 1 from public.prepaid_expense_releases r
       where r.prepaid_expense_id = v_item.id and r.status = 'posted'
     ) then
    raise exception 'Deze vooruitbetaling staat in het grootboek en kan niet weg. Draai eerst de termijnen en daarna de boeking naar de balans terug (Grootboek, Tegenboeken).'
      using errcode = '23514';
  end if;
  delete from public.prepaid_expenses where id = v_item.id;
end;
$$;

-- ── 8. Boeken ───────────────────────────────────────────────────────────────

-- Het bedrag naar de balans: debet de balansrekening, credit de tegenrekening.
-- Is de factuur al als kosten geboekt, dan is de kostenrekening de
-- tegenrekening: dat haalt het bedrag uit de kosten van die ene maand.
create or replace function public.book_prepaid_expense_start(
  p_organization_id uuid,
  p_prepaid_expense_id uuid,
  p_counter_account_id uuid default null,
  p_date date default null
)
returns public.prepaid_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.prepaid_expenses;
  v_counter public.ledger_accounts;
  v_date date;
  v_bookkeeping_start date;
  v_supplier uuid;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_item from public.prepaid_expenses
  where id = p_prepaid_expense_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vooruitbetaling niet gevonden.' using errcode = '02000';
  end if;
  if v_item.start_mode <> 'book' then
    raise exception 'Bij deze post staat het bedrag al op de balans; er valt niets naar de balans te boeken.' using errcode = '23514';
  end if;
  if v_item.start_journal_entry_id is not null then
    raise exception 'Het bedrag van deze post staat al op de balans.' using errcode = '23514';
  end if;
  if v_item.status <> 'active' then
    raise exception 'Deze post is afgerond of beëindigd.' using errcode = '23514';
  end if;

  v_counter := public.prepaid_check_account(p_organization_id, coalesce(p_counter_account_id, v_item.counter_account_id), 'counter');
  if v_counter.id = v_item.prepaid_account_id then
    raise exception 'De tegenrekening mag niet de balansrekening zelf zijn.' using errcode = '23514';
  end if;

  v_date := coalesce(p_date, v_item.payment_date);
  select cs.bookkeeping_start_date into v_bookkeeping_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_bookkeeping_start is not null and v_date < v_bookkeeping_start then
    raise exception 'Je boekhouding in ResoFly begint op %; kies een boekdatum vanaf die dag.', to_char(v_bookkeeping_start, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- Op crediteuren hoort de leverancier erbij, anders telt de boeking bij de
  -- openstaande posten als "niet toe te rekenen".
  if v_counter.subtype = 'accounts_payable' and v_item.source_purchase_invoice_id is not null then
    select pi.supplier_id into v_supplier from public.purchase_invoices pi
    where pi.id = v_item.source_purchase_invoice_id and pi.organization_id = p_organization_id;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_item.prepaid_account_id,
      'description', 'Vooruitbetaald: ' || v_item.description,
      'debit_cents', v_item.amount_cents, 'credit_cents', 0
    ),
    jsonb_build_object(
      'account_id', v_counter.id,
      'description', 'Vooruitbetaald: ' || v_item.description,
      'debit_cents', 0, 'credit_cents', v_item.amount_cents,
      'supplier_id', v_supplier
    )
  );
  v_book_date := public.first_open_booking_date_for(p_organization_id, v_date, public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Vooruitbetaald naar de balans: ' || v_item.description,
    'prepaid_start', v_item.id, v_lines, auth.uid()
  );

  update public.prepaid_expenses
  set start_journal_entry_id = v_entry.id, counter_account_id = v_counter.id
  where id = v_item.id
  returning * into v_item;
  return v_item;
end;
$$;

-- De termijnen t/m een datum boeken: van één post, of van alle lopende posten
-- (p_prepaid_expense_id leeg). Een post waarvan het bedrag nog niet op de
-- balans staat, slaat de bulk over; vraag je hem los, dan volgt een uitleg.
-- Niet verder dan het einde van deze maand: in één klik 36 maanden vooruit
-- boeken zet kosten in het grootboek die nog niet gemaakt zijn, en terugdraaien
-- kan dan alleen termijn voor termijn.
create or replace function public.post_prepaid_releases(
  p_organization_id uuid,
  p_through_date date,
  p_prepaid_expense_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_allowed date := public.prepaid_month_end(public.prepaid_today());
  v_item public.prepaid_expenses;
  v_result jsonb;
  v_count integer := 0;
  v_total bigint := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_through_date is null then
    raise exception 'Kies tot en met welke datum je de termijnen boekt.' using errcode = '23514';
  end if;
  if p_through_date > v_last_allowed then
    raise exception 'Je boekt termijnen tot en met het einde van deze maand (%). Latere maanden boek je als ze aan de beurt zijn.', to_char(v_last_allowed, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  if p_prepaid_expense_id is not null then
    select * into v_item from public.prepaid_expenses
    where id = p_prepaid_expense_id and organization_id = p_organization_id
    for update;
    if not found then
      raise exception 'Vooruitbetaling niet gevonden.' using errcode = '02000';
    end if;
    if v_item.status <> 'active' then
      raise exception 'Deze post is afgerond of beëindigd; er staan geen termijnen meer open.' using errcode = '23514';
    end if;
    if v_item.start_mode = 'book' and v_item.start_journal_entry_id is null then
      raise exception 'Boek eerst het bedrag naar de balans; daarna kunnen de maandtermijnen naar de kosten.' using errcode = '23514';
    end if;
  end if;

  for v_item in
    select * from public.prepaid_expenses p
    where p.organization_id = p_organization_id
      and p.status = 'active'
      and (p_prepaid_expense_id is null or p.id = p_prepaid_expense_id)
      and (p.start_mode = 'existing' or p.start_journal_entry_id is not null)
    order by p.start_date, p.created_at, p.id
    for update
  loop
    v_result := public.prepaid_post_item_releases(v_item, p_through_date);
    v_count := v_count + (v_result->>'posted_count')::integer;
    v_total := v_total + (v_result->>'posted_cents')::bigint;
  end loop;

  return jsonb_build_object('posted_count', v_count, 'posted_cents', v_total);
end;
$$;

-- Eerder stoppen (polis opgezegd, abonnement beëindigd). Eerst gaan de
-- termijnen t/m de einddatum naar de kosten, elk op zijn eigen datum. Wat er
-- daarna nog op de balans staat, gaat in één keer weg: een terugbetaling naar
-- de rekening die je kiest (bank of een vordering), de rest naar de kosten.
-- Daarna vervallen de geplande termijnen.
create or replace function public.end_prepaid_expense(
  p_organization_id uuid,
  p_prepaid_expense_id uuid,
  p_date date,
  p_refund_cents bigint default 0,
  p_refund_account_id uuid default null
)
returns public.prepaid_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.prepaid_expenses;
  v_last_allowed date := public.prepaid_month_end(public.prepaid_today());
  v_last_posted date;
  v_posted bigint;
  v_remaining bigint;
  v_refund bigint := coalesce(p_refund_cents, 0);
  v_refund_account public.ledger_accounts;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_bookkeeping_start date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_item from public.prepaid_expenses
  where id = p_prepaid_expense_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vooruitbetaling niet gevonden.' using errcode = '02000';
  end if;
  if v_item.status <> 'active' then
    raise exception 'Deze post is al afgerond of beëindigd.' using errcode = '23514';
  end if;
  if v_item.start_mode = 'book' and v_item.start_journal_entry_id is null then
    raise exception 'Het bedrag staat nog niet op de balans; er valt niets te beëindigen. Wil je de post kwijt, verwijder hem dan.' using errcode = '23514';
  end if;
  if p_date is null then
    raise exception 'Kies de datum waarop het stopt.' using errcode = '23514';
  end if;
  if p_date > v_last_allowed then
    raise exception 'Je beëindigt een post uiterlijk per het einde van deze maand (%).', to_char(v_last_allowed, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  select cs.bookkeeping_start_date into v_bookkeeping_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_bookkeeping_start is not null and p_date < v_bookkeeping_start then
    raise exception 'Je boekhouding in ResoFly begint op %; kies een einddatum vanaf die dag.', to_char(v_bookkeeping_start, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  -- Stoppen kan vanaf de maand van de laatst geboekte termijn. Die maand staat
  -- al helemaal in de kosten; wat er nog op de balans staat, is de rest. Een
  -- eerdere einddatum zou kosten laten staan van maanden die er niet meer bij
  -- horen. (Eerst moest de einddatum op of na de dag van de termijn liggen:
  -- wie op 11 november opzegde nadat november al geboekt was, kon dan pas per
  -- 30 november stoppen.)
  select max(r.date) into v_last_posted from public.prepaid_expense_releases r
  where r.prepaid_expense_id = v_item.id and r.status = 'posted';
  if v_last_posted is not null and p_date < date_trunc('month', v_last_posted::timestamp)::date then
    raise exception 'De termijn van % is al geboekt. Kies een einddatum vanaf %, of draai die termijnen eerst terug.', to_char(v_last_posted, 'MM-YYYY'), to_char(date_trunc('month', v_last_posted::timestamp)::date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  if v_refund < 0 then
    raise exception 'Een terugbetaling kan niet negatief zijn.' using errcode = '23514';
  end if;

  -- De termijnen tot de einddatum horen bij de maanden waarin de dekking liep.
  perform public.prepaid_post_item_releases(v_item, p_date);
  select * into v_item from public.prepaid_expenses where id = v_item.id;

  select coalesce(sum(r.amount_cents), 0) into v_posted
  from public.prepaid_expense_releases r
  where r.prepaid_expense_id = v_item.id and r.status = 'posted';
  v_remaining := v_item.amount_cents - v_posted;

  if v_remaining <= 0 then
    -- Alles was al naar de kosten (de laatste termijn viel voor de einddatum).
    if v_refund > 0 then
      raise exception 'Er staat niets meer op de balans; een terugbetaling boek je dan als opbrengst (memoriaal).' using errcode = '23514';
    end if;
    return v_item;
  end if;
  if v_refund > v_remaining then
    raise exception 'De terugbetaling (%) is hoger dan wat er nog op de balans staat (%).', public.bank_eur(v_refund), public.bank_eur(v_remaining)
      using errcode = '23514';
  end if;

  if v_refund > 0 then
    v_refund_account := public.prepaid_check_account(p_organization_id, p_refund_account_id, 'counter');
    if v_refund_account.id = v_item.prepaid_account_id or v_refund_account.type = 'expense' then
      raise exception 'Kies voor de terugbetaling de bank of een vordering, niet de balansrekening of een kostenrekening.' using errcode = '23514';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_refund_account.id,
      'description', 'Terugbetaling: ' || v_item.description,
      'debit_cents', v_refund, 'credit_cents', 0
    ));
  end if;
  if v_remaining - v_refund > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_item.expense_account_id,
      'description', 'Rest bij beëindigen: ' || v_item.description,
      'debit_cents', v_remaining - v_refund, 'credit_cents', 0
    ));
  end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_item.prepaid_account_id,
    'description', 'Beëindigd: ' || v_item.description,
    'debit_cents', 0, 'credit_cents', v_remaining
  ));

  v_book_date := public.first_open_booking_date_for(p_organization_id, p_date, public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Vooruitbetaalde kosten beëindigd: ' || v_item.description,
    'prepaid_end', v_item.id, v_lines, auth.uid()
  );

  delete from public.prepaid_expense_releases
  where prepaid_expense_id = v_item.id and status = 'scheduled';
  update public.prepaid_expenses set
    status = 'ended',
    end_date = p_date,
    end_amount_cents = v_remaining,
    end_refund_cents = v_refund,
    end_refund_account_id = case when v_refund > 0 then v_refund_account.id end,
    end_journal_entry_id = v_entry.id
  where id = v_item.id
  returning * into v_item;
  return v_item;
end;
$$;

-- ── 9. Tegenboeken: het register gaat mee terug ─────────────────────────────
-- GEWIJZIGD (20261111220000): de drie boekingen van vooruitbetaalde kosten.
-- Tegenboeken mag, in de omgekeerde volgorde van boeken (eerst de beëindiging,
-- dan de termijnen, dan de boeking naar de balans), en het register volgt:
-- zonder dat bleef een tegengeboekte termijn voorgoed "geboekt" staan en kwam
-- hij nooit meer terug in het schema. Verder gelijk aan 20261107110000.
CREATE OR REPLACE FUNCTION public.reverse_journal_entry(p_entry_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
  v_asset public.fixed_assets;
  v_prepaid public.prepaid_expenses;
  v_context text;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not (public.can_write_org(v_src.organization_id) and public.can_write_module(v_src.organization_id, 'finance')) then
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
  -- TOEGEVOEGD (20260807030000): een resultaatbestemming is net zo'n
  -- systeemboekstuk. Wie hem hier tegenboekt, laat de rij in
  -- result_appropriations op 'posted' staan; het boekjaar blijft dan
  -- geblokkeerd voor heropenen én de nette weg ("Bestemming terugdraaien")
  -- weigert daarna met "al tegengeboekt". Dus meteen hier afvangen.
  if v_src.source_type = 'result_appropriation' then
    raise exception 'Een resultaatbestemming boek je niet los tegen; gebruik "Bestemming terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807050000): idem voor de Vpb-reservering. Los tegenboeken
  -- laat corporate_tax_returns op 'final' staan en de verliesadministratie
  -- ongemoeid; daarna weigert "Berekening terugdraaien" met "al tegengeboekt".
  if v_src.source_type = 'corporate_tax' then
    raise exception 'Een Vpb-reservering boek je niet los tegen; gebruik "Berekening terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807070000): idem voor de renteboeking op de
  -- rekening-courant DGA. Los tegenboeken laat dga_interest_postings op
  -- 'posted' staan, waardoor de rente over dat jaar nooit opnieuw geboekt kan
  -- worden en "Rente terugdraaien" daarna weigert.
  if v_src.source_type = 'dga_interest' then
    raise exception 'Een renteboeking op de rekening-courant boek je niet los tegen; gebruik "Rente terugdraaien".'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807100000): idem voor een dividenduitkering. Die bestaat
  -- bovendien uit twee boekstukken; er één van tegenboeken laat een halve
  -- inhouding achter en zet dividend_distributions op slot.
  if v_src.source_type = 'dividend' then
    raise exception 'Een dividendboeking boek je niet los tegen; gebruik "Uitkering terugdraaien" bij het dividend.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): de doorboeking van een btw-aangifte of
  -- suppletie hoort bij een afgesloten aangifte. De spiegelpost viel in een
  -- open periode en telde daar de hele aangifte nog eens mee.
  if v_src.source_type = 'vat_return' then
    raise exception 'De doorboeking van een btw-aangifte boek je niet tegen. Een fout in een afgesloten aangifte corrigeer je met een suppletie.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261105233000): een verkoopfactuur en een creditnota zijn
  -- uitgegeven stukken. Los tegenboeken liet de factuur op 'verzonden' staan
  -- met de boeking er nog aan: opnieuw boeken kon niet meer, het openstaande
  -- bedrag werd 0, en daarmee weigerden crediteren, herinneren en de
  -- betaallink. De btw bleef verschuldigd (art. 37 Wet OB 1968), terwijl de
  -- aangifte hem kwijt was. Een betaling heeft een eigen terugweg ("Boeking
  -- ongedaan maken" bij de bank, of een terugbetaling); los tegenboeken liet de
  -- factuur op betaald staan. Die twee interne functies gebruiken deze functie
  -- zelf en mogen dus wel.
  if v_src.source_type in ('sales_invoice', 'credit_note', 'payment') then
    get diagnostics v_context = pg_context;
    if v_context !~* 'function (public\.)?(unbook_bank_transaction|recompute_invoice_chargeback_state)\(' then
      if v_src.source_type = 'sales_invoice' then
        raise exception 'Een verkoopfactuur boek je niet tegen: de factuur is uitgegeven en de btw blijft verschuldigd. Corrigeer met "Crediteren" bij de factuur; dat boekt omzet en btw netjes terug.'
          using errcode = '23514';
      elsif v_src.source_type = 'credit_note' then
        raise exception 'Een creditnota boek je niet tegen: die is uitgegeven. Maak zo nodig een nieuwe factuur.'
          using errcode = '23514';
      else
        raise exception 'Een betaling boek je hier niet tegen. Bij de bank: "Boeking ongedaan maken" bij de transactie. Een Mollie-betaling draai je terug met een terugbetaling.'
          using errcode = '23514';
      end if;
    end if;
  end if;
  -- TOEGEVOEGD (20261105233000): een geboekte inkoopfactuur ligt vast, en de
  -- bewaker verwijst voor een correctie naar tegenboeken. Daarna bleef de
  -- factuur op 'geboekt' staan, met de oude boeking eraan: corrigeren of
  -- opnieuw boeken kon nooit meer. Nu gaat hij mee terug naar concept
  -- (onderaan). Is er al op betaald, dan eerst die betaling: anders blijft de
  -- betaling op 1600 staan zonder factuur ertegenover.
  -- GEWIJZIGD (20261107110000): uit de verdeling, zodat een betaling over
  -- meerdere inkoopfacturen ook telt; de oude kolom blijft als vangnet.
  if v_src.source_type = 'purchase_invoice' and (exists (
    select 1 from public.bank_transaction_allocations a
    join public.journal_entries pje on pje.id = a.journal_entry_id and pje.status = 'posted'
      and pje.reversed_by_entry_id is null and pje.reverses_entry_id is null
    where a.organization_id = v_src.organization_id
      and a.purchase_invoice_id = v_src.source_id
  ) or exists (
    select 1 from public.bank_transactions bt
    where bt.organization_id = v_src.organization_id
      and bt.matched_purchase_invoice_id = v_src.source_id
      and bt.status = 'booked'
  )) then
    raise exception 'Op deze inkoopfactuur is al een betaling afgeletterd. Draai eerst die betaling terug (Bank: "Boeking ongedaan maken"); daarna de inkoopfactuur.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een tegenboeking tegenboeken maakt een keten
  -- die de rapporten en de beginbalanscontrole niet meer kunnen volgen.
  if v_src.reverses_entry_id is not null then
    raise exception 'Dit boekstuk is zelf een tegenboeking. Boek het oorspronkelijke boekstuk opnieuw in plaats van de tegenboeking tegen te boeken.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): boekingen van activa houden het activaregister
  -- bij. Tegenboeken mag, maar dan gaat het register mee terug (zie onderaan);
  -- eerst wel in de juiste volgorde: desinvestering, afschrijvingen, aanschaf.
  if v_src.source_type = 'asset_acquisition' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.acquisition_journal_entry_id = v_src.id then
      if v_asset.status = 'disposed'
         or exists (select 1 from public.asset_depreciations ad where ad.asset_id = v_asset.id and ad.status = 'posted') then
        raise exception 'Draai eerst de desinvestering en de geboekte afschrijvingen van "%" terug; daarna de aanschaf.', v_asset.name
          using errcode = '23514';
      end if;
    end if;
  elsif v_src.source_type = 'asset_depreciation' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.status = 'disposed' then
      raise exception 'Draai eerst de desinvestering van "%" terug; daarna de afschrijving.', v_asset.name
        using errcode = '23514';
    end if;
  elsif v_src.source_type = 'asset_disposal' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
  end if;
  -- TOEGEVOEGD (20261111220000): vooruitbetaalde kosten, zelfde volgorde:
  -- beëindiging, termijnen, boeking naar de balans.
  if v_src.source_type in ('prepaid_start', 'prepaid_release', 'prepaid_end') then
    select * into v_prepaid from public.prepaid_expenses
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found then
      if v_src.source_type = 'prepaid_start' and v_prepaid.start_journal_entry_id = v_src.id
         and (v_prepaid.status = 'ended' or exists (
           select 1 from public.prepaid_expense_releases r
           where r.prepaid_expense_id = v_prepaid.id and r.status = 'posted'
         )) then
        raise exception 'Draai eerst de beëindiging en de geboekte termijnen van "%" terug; daarna de boeking naar de balans.', v_prepaid.description
          using errcode = '23514';
      elsif v_src.source_type = 'prepaid_release' and v_prepaid.status = 'ended'
         and exists (
           select 1 from public.prepaid_expense_releases r
           where r.prepaid_expense_id = v_prepaid.id and r.journal_entry_id = v_src.id
         ) then
        raise exception 'Draai eerst de beëindiging van "%" terug; daarna de termijn.', v_prepaid.description
          using errcode = '23514';
      end if;
    end if;
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

  -- TOEGEVOEGD (20261104000000): het activaregister gaat mee terug, zodat
  -- grootboek en register gelijk blijven (anders boekte de desinvestering de
  -- verkeerde cumulatieve afschrijving af, en bleef een tegengeboekte termijn
  -- voorgoed als geboekt staan).
  if v_src.source_type = 'asset_acquisition' then
    update public.fixed_assets
    set acquisition_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and acquisition_journal_entry_id = v_src.id;
  elsif v_src.source_type = 'asset_depreciation' then
    update public.asset_depreciations
    set status = 'scheduled', journal_entry_id = null, posted_at = null
    where journal_entry_id = v_src.id and organization_id = v_src.organization_id;
    update public.fixed_assets
    set status = 'active'
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'fully_depreciated';
  elsif v_src.source_type = 'asset_disposal' then
    update public.fixed_assets
    set status = 'active', disposal_date = null, disposal_proceeds_cents = null
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'disposed';
    if found then
      perform public.generate_depreciation_schedule(v_src.organization_id, v_src.source_id);
      if not exists (
        select 1 from public.asset_depreciations ad
        where ad.asset_id = v_src.source_id and ad.status = 'scheduled'
      ) then
        update public.fixed_assets set status = 'fully_depreciated'
        where id = v_src.source_id and organization_id = v_src.organization_id and status = 'active';
      end if;
    end if;
  end if;

  -- TOEGEVOEGD (20261111220000): het register van vooruitbetaalde kosten gaat
  -- mee terug. Een termijn staat weer gepland; na de boeking naar de balans
  -- tegenboeken is de post weer te wijzigen of te verwijderen; na een
  -- beëindiging komt het schema terug vanaf de eerste niet-geboekte maand.
  if v_src.source_type = 'prepaid_start' then
    update public.prepaid_expenses
    set start_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and start_journal_entry_id = v_src.id;
  elsif v_src.source_type = 'prepaid_release' then
    update public.prepaid_expense_releases
    set status = 'scheduled', journal_entry_id = null, posted_at = null
    where journal_entry_id = v_src.id and organization_id = v_src.organization_id;
    if found then
      update public.prepaid_expenses
      set status = 'active'
      where id = v_src.source_id and organization_id = v_src.organization_id and status = 'completed';
    end if;
  elsif v_src.source_type = 'prepaid_end' then
    update public.prepaid_expenses
    set status = 'active', end_date = null, end_amount_cents = null, end_refund_cents = null,
        end_refund_account_id = null, end_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and end_journal_entry_id = v_src.id;
    if found then
      perform public.prepaid_build_schedule(v_src.source_id);
      if not exists (
        select 1 from public.prepaid_expense_releases r
        where r.prepaid_expense_id = v_src.source_id and r.status = 'scheduled'
      ) then
        update public.prepaid_expenses set status = 'completed'
        where id = v_src.source_id and organization_id = v_src.organization_id and status = 'active';
      end if;
    end if;
  end if;

  -- TOEGEVOEGD (20261105233000): de inkoopfactuur gaat terug naar concept, zodat
  -- je hem kunt corrigeren en opnieuw boeken. De inbox volgt.
  if v_src.source_type = 'purchase_invoice' then
    update public.purchase_invoices
    set status = 'draft', journal_entry_id = null, payment_status = 'unpaid', paid_at = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and journal_entry_id = v_src.id;
    update public.purchase_invoice_inbox
    set status = 'ready'
    where purchase_invoice_id = v_src.source_id and organization_id = v_src.organization_id
      and status = 'booked';
  end if;

  return v_reversal;
end;
$function$;

-- ── 10. Logboek ─────────────────────────────────────────────────────────────

-- Gelijk aan 20261108230000, met 'prepaid_expense' bij Financiën.
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'mollie_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event', 'email_template',
                           'client_subdomain', 'client_domain') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'partnership_partner', 'prepaid_expense',
                           'purchase_invoice', 'quote', 'result_appropriation', 'share_transaction', 'shareholder', 'supplier',
                           'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact', 'client_field') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee', 'gallery') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    when p_entity_type in ('email_campaign', 'email_flow') then 'marketing'
    else 'admin'
  end;
$$;

-- Gelijk aan 20261108190000, met prepaid_expenses erbij. De omschrijving en de
-- notities zijn tekst: alleen "gewijzigd". De boekstukken zelf staan als
-- journaalpost al in het logboek.
create or replace function public.audit_field_spec(p_table text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select (case p_table
    when 'tasks' then '{"title":"v","status":"v","priority":"v","tags":"v","start_date":"v","end_date":"v","planned_date":"v","planned_end_date":"v","planned_start_minute":"v","estimated_minutes":"v","project_id":"r","client_id":"r","ticket_id":"r","subtasks":"s","comments":"n","planned_order":"i"}'
    when 'projects' then '{"name":"v","client_id":"r","archived":"v","start_date":"v","end_date":"v","contract_id":"r","hourly_rate_cents":"v","billing_type":"v","budgeted_minutes":"v","color":"i"}'
    when 'clients' then '{"name":"v","client_code":"v","status":"v","client_kind":"v","follow_up":"v","value_eur":"v","tags":"v","country":"v","e_invoicing_enabled":"v","e_invoice_channel":"v","color":"i"}'
    when 'client_contacts' then '{"name":"v","role":"v","is_active":"v","gives_portal_access":"v","origin":"v","client_id":"r"}'
    when 'client_calls' then '{"subject":"v","direction":"v","outcome":"v","started_at":"v","duration_seconds":"v","client_id":"r","contact_id":"r","project_id":"r","ticket_id":"r","dedup_key":"i","provider_call_id":"i","metadata":"i"}'
    when 'tickets' then '{"title":"v","status":"v","priority":"v","client_id":"r","converted_to_project_id":"r","resolved_at":"v"}'
    when 'ticket_notes' then '{"is_internal":"v","author_type":"v","ticket_id":"r"}'
    when 'notes' then '{"title":"v","note_type":"v","tags":"v","client_id":"r","project_id":"r","folder_id":"r"}'
    when 'documents' then '{"title":"v","document_type":"v","client_id":"r","project_id":"r","folder_id":"r","mime_type":"v","size_bytes":"v","storage_key":"i","edit_version":"i","last_edited_by":"i"}'
    when 'attachments' then '{"name":"v","mime_type":"v","size_bytes":"v","parent_task_id":"r","storage_key":"i","public_url":"i","edit_version":"i","last_edited_by":"i","locked_by":"i","locked_at":"i"}'
    when 'content_folders' then '{"name":"v","parent_id":"r","client_id":"r","project_id":"r","position":"i"}'
    when 'note_handwriting' then '{"page_count":"v","stroke_count":"i","pages":"i"}'
    when 'drive_shares' then '{"item_type":"v","item_name":"v","recipient_kind":"v","can_download":"v","expires_at":"v","revoked_at":"v","notified_at":"v","client_id":"r","project_id":"r","member_user_id":"r","client_contact_id":"r","token_hash":"i","view_count":"i","last_viewed_at":"i"}'
    when 'file_transfers' then '{"subject":"v","status":"v","can_download":"v","expires_at":"v","sent_at":"v","revoked_at":"v","purged_at":"v","item_count":"v","total_bytes":"v","client_id":"r","project_id":"r","ticket_id":"r"}'
    when 'galleries' then '{"title":"v","status":"v","published_at":"v","allow_downloads":"v","download_quality":"v","share_enabled":"v","expires_at":"v","format":"v","hero_template":"v","project_id":"r","share_token":"i","share_pin_failed_count":"i","share_pin_locked_until":"i","cover_item_id":"i","cover_preview_key":"i","cover_thumb_key":"i","cover_bytes":"i","cover_focus_x":"i","cover_focus_y":"i"}'
    when 'time_entries' then '{"entry_date":"v","minutes":"v","billable":"v","entry_type":"v","indirect_category":"v","source":"v","started_at":"v","ended_at":"v","hourly_rate_cents":"v","user_id":"r","project_id":"r","client_id":"r","task_id":"r","calendar_event_link_id":"i"}'
    when 'project_members' then '{"user_id":"r","project_id":"r"}'
    when 'task_assignees' then '{"user_id":"r","task_id":"r"}'
    when 'project_templates' then '{"name":"v"}'
    when 'project_template_tasks' then '{"title":"v","status":"v","priority":"v","position":"i"}'
    when 'saved_reports' then '{"name":"v","is_pinned":"v","position":"i"}'
    when 'invoices' then '{"number":"v","status":"v","date":"v","due_date":"v","currency":"v","subtotal_amount":"v","vat_amount":"v","total_amount":"v","lines":"n","sent_at":"v","paid_at":"v","refunded_amount":"v","charged_back_amount":"v","reminder_level":"v","reminders_paused":"v","locked_at":"v","client_id":"r","project_id":"r","quote_id":"r","contract_id":"r","journal_entry_id":"r","last_email_delivery_status":"v","last_email_opened_at":"v","last_email_clicked_at":"v","last_email_failed_at":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","latest_version_id":"i","sent_version_id":"i","paid_version_id":"i","source_quote_version_id":"i","last_pdf_file_name":"i","last_pdf_mime_type":"i","last_pdf_size_bytes":"i","last_pdf_sha256":"i"}'
    when 'quotes' then '{"number":"v","status":"v","date":"v","valid_until":"v","lines":"n","sent_at":"v","accepted_at":"v","internal_approval_status":"v","internal_approved_at":"v","internal_rejected_at":"v","client_decision_at":"v","client_id":"r","project_id":"r","internal_approval_requested_by":"r","internal_approved_by":"r","internal_rejected_by":"r","last_email_delivery_status":"v","last_email_opened_at":"v","last_email_clicked_at":"v","last_email_failed_at":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","latest_version_id":"i","internal_approved_version_id":"i","sent_version_id":"i","accepted_version_id":"i","accepted_sent_version_id":"i","last_pdf_file_name":"i","last_pdf_mime_type":"i","last_pdf_size_bytes":"i","last_pdf_sha256":"i"}'
    when 'contracts' then '{"number":"v","title":"v","status":"v","date":"v","valid_until":"v","amount_cents":"v","currency":"v","sent_at":"v","signed_at":"v","voided_at":"v","internal_approval_status":"v","editor_mode":"v","client_id":"r","quote_id":"r","template_id":"r","supersedes_contract_id":"r","voided_by":"r","last_email_delivery_status":"v","public_token_hash":"i","public_token_created_at":"i","public_token_expires_at":"i","resend_last_email_id":"i","last_email_delivery_at":"i","signed_document_sha256":"i","signed_storage_provider":"i","signed_storage_key":"i","signed_pdf_file_name":"i","signed_pdf_size_bytes":"i","signed_pdf_data_base64":"i","body_storage_key":"i","body_mime_type":"i","body_size_bytes":"i","edit_version":"i","last_edited_by":"i"}'
    when 'contract_templates' then '{"name":"v","is_active":"v"}'
    when 'contract_projects' then '{"contract_id":"r","project_id":"r"}'
    when 'purchase_invoices' then '{"internal_number":"v","supplier_invoice_number":"v","date":"v","due_date":"v","subtotal_cents":"v","vat_cents":"v","total_cents":"v","currency":"v","status":"v","payment_status":"v","paid_at":"v","source":"v","lines":"n","supplier_id":"r","project_id":"r","journal_entry_id":"r","extraction_meta":"i"}'
    when 'suppliers' then '{"name":"v","supplier_code":"v","status":"v","default_vat_code":"v","inbox_unverified":"v","default_expense_account_id":"r"}'
    when 'journal_entries' then '{"entry_number":"v","date":"v","status":"v","source_type":"v","posted_at":"v","reverses_entry_id":"r","reversed_by_entry_id":"r"}'
    when 'ledger_accounts' then '{"code":"v","name":"v","type":"v","subtype":"v","default_vat_code":"v","is_active":"v","report_group":"v","is_restricted_reserve":"v"}'
    when 'bank_accounts' then '{"name":"v","currency":"v","is_active":"v","source":"v","provider":"v","ledger_account_id":"r","last_synced_at":"i","last_imported_at":"i","last_sync_attempt_at":"i","last_sync_error":"i","external_account_id":"i"}'
    when 'bank_rules' then '{"name":"v","priority":"v","is_active":"v","auto_book":"v","match_direction":"v","target_vat_code":"v","target_account_id":"r"}'
    when 'vat_returns' then '{"status":"v","period_type":"v","year":"v","period_index":"v","period_start":"v","period_end":"v","finalized_at":"v","filed_at":"v","journal_entry_id":"r","paid_bank_transaction_id":"r","supplements_return_id":"r"}'
    when 'fixed_assets' then '{"name":"v","asset_number":"v","category":"v","acquisition_date":"v","acquisition_cost_cents":"v","residual_value_cents":"v","useful_life_months":"v","method":"v","start_date":"v","status":"v","disposal_date":"v","disposal_proceeds_cents":"v"}'
    when 'prepaid_expenses' then '{"description":"c","amount_cents":"v","payment_date":"v","start_date":"v","months":"v","start_mode":"v","status":"v","end_date":"v","end_amount_cents":"v","end_refund_cents":"v","notes":"c","prepaid_account_id":"c","expense_account_id":"c","counter_account_id":"c","end_refund_account_id":"c","source_purchase_invoice_id":"c","start_journal_entry_id":"i","end_journal_entry_id":"i"}'
    when 'fiscal_years' then '{"label":"v","period_start":"v","period_end":"v","status":"v","result_cents":"v","closed_at":"v","reopened_at":"v"}'
    when 'corporate_tax_returns' then '{"year":"v","status":"v","taxable_amount_cents":"v","tax_cents":"v","balance_due_cents":"v","finalized_at":"v","computation":"i"}'
    when 'annual_accounts' then '{"status":"v","prepared_on":"v","prepare_deadline":"v","adoption_date":"v","adoption_method":"v","filing_date":"v","size_class":"v","size_class_override":"v","reversed_at":"v","snapshot":"i","snapshot_hash":"i","snapshot_version":"i","size_basis":"i"}'
    when 'organization_members' then '{"role":"v","status":"v","module_access":"v","joined_at":"v","user_id":"r","invited_by":"r"}'
    when 'organization_invitations' then '{"role":"v","status":"v","expires_at":"v","module_access":"v","consumes_license":"v","accepted_by":"r","accepted_at":"v","invited_by":"r"}'
    when 'organizations' then '{"name":"v","licensed_seats":"v","license_status":"v","onboarding_completed_at":"v","parent_organization_id":"r"}'
    when 'company_settings' then '{"legal_form":"v","kor_enabled":"v","vat_return_period":"v","bookkeeping_start_date":"v","fiscal_year_start_month":"v","invoice_send_method":"v","default_hourly_rate_cents":"v","invoice_template_kind":"v","brand_client_theme":"v","brand_hide_powered_by":"v"}'
    when 'calendar_events' then '{"etag":"i","sync_rev":"i","sequence":"i","icalendar_raw":"i","organizer_token":"i"}'
    when 'calendar_sources' then '{"change_seq":"i","feed_etag":"i","feed_content_hash":"i","feed_last_synced_at":"i","feed_last_error":"i","feed_url":"i","conference_types":"i"}'
    when 'calendar_connections' then '{"status":"v","last_error":"i"}'
    when 'email_campaigns' then '{"name":"v","subject":"v","status":"v","scheduled_at":"v","started_at":"v","sent_at":"v","accent_color":"i"}'
    when 'email_flows' then '{"name":"v","status":"v","stop_condition":"v"}'
    when 'email_templates' then '{"template_key":"v","enabled":"v"}'
    when 'client_field_definitions' then '{"label":"v","field_key":"v","field_type":"v","is_archived":"v","show_in_list":"v","position":"i"}'
    else '{}'
  end)::jsonb;
$$;

-- ── 11. Rechten op de functies ──────────────────────────────────────────────
-- Wat de app aanroept: ingelogde gebruikers (de functies controleren zelf de
-- organisatie en de modulerechten). De hulpjes: alleen de server.

revoke all on function public.save_prepaid_expense(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_prepaid_expense(uuid, uuid, jsonb) to authenticated, service_role;
revoke all on function public.delete_prepaid_expense(uuid, uuid) from public, anon;
grant execute on function public.delete_prepaid_expense(uuid, uuid) to authenticated, service_role;
revoke all on function public.book_prepaid_expense_start(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.book_prepaid_expense_start(uuid, uuid, uuid, date) to authenticated, service_role;
revoke all on function public.post_prepaid_releases(uuid, date, uuid) from public, anon;
grant execute on function public.post_prepaid_releases(uuid, date, uuid) to authenticated, service_role;
revoke all on function public.end_prepaid_expense(uuid, uuid, date, bigint, uuid) from public, anon;
grant execute on function public.end_prepaid_expense(uuid, uuid, date, bigint, uuid) to authenticated, service_role;

revoke all on function public.prepaid_today() from public, anon, authenticated;
grant execute on function public.prepaid_today() to service_role;
revoke all on function public.prepaid_month_end(date) from public, anon, authenticated;
grant execute on function public.prepaid_month_end(date) to service_role;
revoke all on function public.prepaid_default_account(uuid) from public, anon, authenticated;
grant execute on function public.prepaid_default_account(uuid) to service_role;
revoke all on function public.prepaid_check_account(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.prepaid_check_account(uuid, uuid, text) to service_role;
revoke all on function public.prepaid_build_schedule(uuid) from public, anon, authenticated;
grant execute on function public.prepaid_build_schedule(uuid) to service_role;
revoke all on function public.prepaid_post_item_releases(public.prepaid_expenses, date) from public, anon, authenticated;
grant execute on function public.prepaid_post_item_releases(public.prepaid_expenses, date) to service_role;

-- Zoals in 20261107110000.
revoke all on function public.reverse_journal_entry(uuid, date, uuid) from public, anon;
grant execute on function public.reverse_journal_entry(uuid, date, uuid) to authenticated, service_role;
-- Zoals in 20261108230000: de leesregel op audit_logs roept hem aan namens de
-- ingelogde gebruiker.
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;
-- Zoals in 20261108190000: een intern hulpje, niet aan te roepen via de API.
revoke all on function public.audit_field_spec(text) from public, anon, authenticated;
grant execute on function public.audit_field_spec(text) to service_role;

commit;
